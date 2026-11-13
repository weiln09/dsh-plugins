// Turn progress and result delivery.
//
// WeChat cannot edit a sent message, so "streaming" here means a small number of
// throttled progress messages plus one final card. Granularity decides how much
// of that a chat wants:
//
//   summary  — only the result card
//   standard — the result card only; tool calls stay silent (see toolProgress)
//   full     — throttled text deltas, then the result card
//
// Tool calls are NOT mirrored by default. A turn with twenty tool calls used
// to arrive as twenty separate WeChat messages, which buries the answer and
// makes the phone buzz continuously; the transcript belongs in the Web UI.
// Set `reply.toolProgress: true` to get the old behaviour back.
//
// The bus listens on `session/event` and only ever acts for sessions a chat is
// bound to, so a session opened in the Web UI is never mirrored into WeChat.

import { markdownToText, resultCard, toolLine } from './render.js'

const MAX_PROGRESS_MESSAGES = 8
const MAX_RESERVOIR = 4_000
/**
 * How many per-session states to keep.
 *
 * One entry is created per Session the channel ever mirrors, and it was never
 * removed: a long-lived Host accumulated one idle state (plus its buffered
 * reservoir string) per conversation forever. The cap keeps the live ones —
 * every state is dropped once its turn ends and the map overflows.
 */
const MAX_STATES = 64

/** Throttled per-session progress state. */
function initialState() {
  return {
    turnStartAt: 0,
    running: false,
    reservoir: '',
    timer: null,
    sent: 0,
    lastTool: '',
    lastAssistantText: '',
    lastUsage: null,
    turn: null,
    step: 0,
    // Raw characters actually DELIVERED to the chat this turn. The result card
    // sends only the remainder, so nothing is repeated and nothing is skipped.
    deliveredRaw: 0,
  }
}

export class NotifyBus {
  /**
   * @param {Object} deps
   * @param {import('@deepseek-ai/cordis').Context} deps.ctx
   * @param {import('./bindings.js').BindingStore} deps.bindings
   * @param {(chatId: string, text: string) => Promise<unknown>} deps.send
   * @param {(line: string) => void} deps.log
   */
  constructor({ ctx, bindings, send, log }) {
    this.ctx = ctx
    this.bindings = bindings
    this.send = send
    this.log = log
    this.states = new Map()
    this.disposers = []
    this.config = {
      granularity: 'standard',
      progressIntervalMs: 4_000,
      progressMaxMessages: MAX_PROGRESS_MESSAGES,
      toolProgress: false,
    }
  }

  configure(config = {}) {
    Object.assign(this.config, config)
  }

  mount() {
    this.disposers.push(this.ctx.on('session/event', (session, event) => {
      try {
        this.onSessionEvent(session, event)
      } catch (error) {
        this.log(`通知处理失败：${error?.message ?? error}`)
      }
    }))
  }

  /**
   * Subscribe to one agent's live stream.
   *
   * `agent/assistant-stream` is an agent-scoped event: it is dispatched through
   * the agent's own scope, so only a listener registered in that scope receives
   * it. The channel therefore wires this from the per-agent `setup` callback
   * rather than from the root context.
   *
   * @param {object} agentCtx - the scoped context handed to `setup`.
   * @param {object} agent - the agent whose frames to mirror.
   * @returns {void}
   */
  attachAgent(agentCtx, agent) {
    if (typeof agentCtx?.on !== 'function') return
    agentCtx.on('agent/assistant-stream', ({ frame } = {}) => {
      try {
        this.onStreamFrame(agent, frame)
      } catch (error) {
        this.log(`流式处理失败：${error?.message ?? error}`)
      }
    })
  }

  dispose() {
    for (const dispose of this.disposers) dispose()
    this.disposers = []
    for (const state of this.states.values()) {
      if (state.timer) clearTimeout(state.timer)
    }
    this.states.clear()
  }

  state(sessionId) {
    let state = this.states.get(sessionId)
    if (state) return state
    if (this.states.size >= MAX_STATES) this.evictIdle()
    state = initialState()
    this.states.set(sessionId, state)
    return state
  }

  /** Drop finished states until the map is under its cap again. */
  evictIdle() {
    for (const [key, entry] of this.states) {
      if (this.states.size < MAX_STATES) return
      if (entry.running) continue
      if (entry.timer) clearTimeout(entry.timer)
      this.states.delete(key)
    }
  }

  /** The chat a session belongs to, or null when it is not an IM session. */
  chatOf(session) {
    const binding = this.bindings.bySessionId(session?.id)
    return binding ? binding : null
  }

  onSessionEvent(session, event) {
    const binding = this.chatOf(session)
    if (!binding) return
    const state = this.state(session.id)

    switch (event.type) {
      case 'turn/start': {
        state.running = true
        state.turnStartAt = Date.now()
        state.sent = 0
        state.reservoir = ''
        state.lastTool = ''
        state.lastAssistantText = ''
        state.deliveredRaw = 0
        state.turn = event.data?.turn ?? null
        return
      }
      case 'tool/call': {
        // Off by default: a chat wants the answer, not the transcript.
        if (!this.config.toolProgress) return
        if (this.granularityOf(binding) === 'summary') return
        const name = event.data?.name ?? event.data?.toolName ?? 'tool'
        const args = event.data?.arguments ?? event.data?.args
        const line = toolLine(name, args)
        if (line === state.lastTool) return
        state.lastTool = line
        this.push(binding, state, line)
        return
      }
      case 'assistant/chunk': {
        // Kept for compositions that mirror the legacy session event; the
        // shipped loop reports live text through `agent/assistant-stream`.
        if (this.granularityOf(binding) !== 'full') return
        const chunk = event.data?.chunk
        if (chunk?.type !== 'text-delta' || !chunk.text) return
        this.appendStream(binding, state, chunk.text)
        return
      }
      case 'assistant/message': {
        const text = extractText(event.data?.message)
        if (text) state.lastAssistantText = text
        if (event.data?.usage) state.lastUsage = event.data.usage
        return
      }
      case 'turn/end': {
        void this.finish(binding, state, event.data)
        return
      }
      default:
        return
    }
  }

  granularityOf(binding) {
    return binding?.replyGranularity || this.config.granularity
  }

  /**
   * Handle one live assistant frame.
   *
   * Frames are `{ type: 'start' | 'chunk' | 'end', attemptId, revision, ... }`
   * and a `chunk` frame carries the adapter chunk (`text-delta` etc.). Only the
   * bound chat's agent is mirrored, and only in the `full` granularity.
   */
  onStreamFrame(agent, frame) {
    const sessionId = agent?.session?.id ?? agent?.id
    const binding = this.bindings.bySessionId(sessionId)
    if (!binding) return
    if (this.granularityOf(binding) !== 'full') return
    if (frame?.type !== 'chunk') return
    const chunk = frame.chunk
    if (chunk?.kind !== 'text-delta' && chunk?.type !== 'text-delta') return
    const text = chunk.text ?? chunk.delta ?? ''
    if (!text) return
    this.appendStream(binding, this.state(sessionId), text)
  }

  /** Buffer a delta and schedule a throttled flush. */
  appendStream(binding, state, text) {
    state.reservoir += text
    if (state.reservoir.length >= MAX_RESERVOIR) {
      void this.flush(binding, state)
      return
    }
    if (!state.timer) {
      state.timer = setTimeout(() => {
        state.timer = null
        void this.flush(binding, state)
      }, this.config.progressIntervalMs)
      if (typeof state.timer?.unref === 'function') state.timer.unref()
    }
  }

  /** Send one progress line, respecting the mute switch and the message cap. */
  push(binding, state, text) {
    if (binding.muted) return
    if (state.sent >= this.config.progressMaxMessages) return
    state.sent += 1
    void this.send(binding.chatId, text).catch((error) => {
      this.log(`进度发送失败：${error?.message ?? error}`)
    })
  }

  /**
   * Flush the buffered text delta as one progress message.
   *
   * A `full` stream is sent as it arrives, so what went out is recorded: the
   * result card then sends only the part the stream did not cover, and a long
   * answer is neither cut off nor repeated.
   */
  async flush(binding, state) {
    if (state.timer) {
      clearTimeout(state.timer)
      state.timer = null
    }
    if (!state.reservoir.trim()) {
      state.reservoir = ''
      return
    }
    if (binding.muted) {
      state.reservoir = ''
      return
    }
    // Over the progress cap: KEEP the buffer. Consuming it here would discard
    // text that was never sent, and the turn-end card — which slices the raw
    // answer by what was actually delivered — would then skip it.
    if (state.sent >= this.config.progressMaxMessages) return
    const buffered = state.reservoir
    state.reservoir = ''
    state.sent += 1
    // Count the raw characters this message represents, not the rendered ones:
    // markdownToText is not length-preserving, so the remainder is sliced out
    // of the raw text. Nothing is clipped here — `sendText` already splits at
    // `reply.maxChunkChars`, and clipping a 4000-character flush down to 1500
    // silently dropped the middle of a streamed answer while still counting it
    // as delivered.
    state.deliveredRaw += buffered.length
    await this.send(binding.chatId, markdownToText(buffered)).catch(() => {})
  }

  /** Send the turn-end card and reset the per-turn state. */
  async finish(binding, state, data) {
    if (state.timer) {
      clearTimeout(state.timer)
      state.timer = null
    }
    const buffered = state.reservoir
    state.reservoir = ''
    const durationMs = state.running && state.turnStartAt ? Date.now() - state.turnStartAt : 0
    state.running = false
    state.turnStartAt = Date.now()

    if (!binding.muted) {
      if (buffered.trim()) {
        state.deliveredRaw += buffered.length
        await this.send(binding.chatId, markdownToText(buffered)).catch(() => {})
      }
      const reason = data?.reason ?? {}
      const status = normalizeStatus(reason)
      // `full` already delivered the answer as it streamed, so the card carries
      // only what the stream did not reach — the remainder of the raw text,
      // rendered on its own. Nothing is repeated and nothing is dropped.
      const raw = state.lastAssistantText || ''
      const rest = state.deliveredRaw > 0 ? raw.slice(state.deliveredRaw).replace(/^\s+/, '') : raw
      const summary = rest ? markdownToText(rest) : ''
      const text = resultCard({
        status,
        summary: summary || (state.deliveredRaw > 0 ? '' : fallbackSummary(status, reason)),
        summaryLimit: this.granularityOf(binding) === 'summary' ? 1200 : 0,
        durationMs,
        usage: state.lastUsage,
        modelLabel: binding.model ? `${binding.model.provider}/${binding.model.model}` : '',
      })
      await this.send(binding.chatId, text).catch((error) => {
        this.log(`结果卡片发送失败：${error?.message ?? error}`)
      })
    }

    state.lastAssistantText = ''
    state.lastUsage = null
    state.sent = 0
    state.lastTool = ''
    this.ctx.emit?.('weixin/turn-end', {
      chatId: binding.chatId,
      sessionId: binding.sessions?.[binding.activeWorkspace] ?? '',
      status: normalizeStatus(data?.reason ?? {}),
    })
  }
}

/** Map the loop's turn-end reason to a card status. */
export function normalizeStatus(reason) {
  switch (reason?.kind) {
    case 'completed': return 'completed'
    case 'error': return 'error'
    case 'aborted': return 'aborted'
    case 'max-tokens': return 'max-tokens'
    case 'blocked': return 'blocked'
    case 'interrupted': return 'interrupted'
    default: return 'completed'
  }
}

/** A result card still needs words when the model produced no text. */
function fallbackSummary(status, reason) {
  if (status === 'error') {
    const message = reason?.error?.message ?? reason?.message ?? '未知错误'
    return `处理失败：${String(message).slice(0, 400)}`
  }
  if (status === 'aborted') return '任务已取消。'
  // A blocked turn is rejected by a pre-step gate before any request, so there
  // is no error object to print and the card used to carry the bare status line
  // "⏳ 被阻塞 / ⏱ 1.2s" — true, and useless. The gate that does this is the
  // archived-session one; the channel lifts that flag itself (session.js), so
  // reaching this text means the lift failed or another gate rejected the step.
  if (status === 'blocked') {
    return '这条消息没有进入模型：会话被宿主的前置检查拦下了。最常见的原因是它在侧栏里被归档了——在 Web UI 里取消归档，或发送 /新建 开一个新会话。'
  }
  if (status === 'interrupted') return '回合被中断，没有产生回答。可以重新发送。'
  return ''
}

/** Extract the text blocks of one assistant message. */
export function extractText(message) {
  const blocks = message?.content
  if (!Array.isArray(blocks)) return ''
  return blocks
    .filter((block) => block?.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text)
    .join('\n')
    .trim()
}
