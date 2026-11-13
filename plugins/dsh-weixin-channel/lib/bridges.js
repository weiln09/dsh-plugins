// Approval and question bridges.
//
// Both are waterfall seams owned by other packages. Each bridge answers only for
// sessions a WeChat chat is bound to and calls `next()` for everything else, so
// the Web UI keeps its own prompting and a session is never asked twice.
//
// Both fail closed: an unanswered prompt denies the tool, and an unanswered
// question settles as "skipped" instead of holding the turn open forever.

import { randomBytes } from 'node:crypto'

/** Short, sayable ids: four hex characters are enough for a chat. */
function shortId() {
  return randomBytes(2).toString('hex')
}

/** A promise that settles on `resolve()` or on the timeout, whichever is first. */
function withTimeout(ms, onTimeout) {
  let timer = null
  let settle = null
  const promise = new Promise((resolve) => {
    settle = resolve
    timer = setTimeout(() => resolve(onTimeout()), ms)
    if (typeof timer?.unref === 'function') timer.unref()
  })
  return {
    promise,
    resolve(value) {
      if (timer) clearTimeout(timer)
      settle(value)
    },
  }
}

/**
 * Routes `approval/request` to the chat that owns the agent.
 *
 * The approval service requires an open turn, so the request is always
 * answered or timed out inside that turn — never left dangling.
 */
export class ApprovalBridge {
  constructor({ ctx, bindings, send, log, audit, config }) {
    this.ctx = ctx
    this.bindings = bindings
    this.send = send
    this.log = log
    this.audit = audit
    this.config = config
    /** id → { record } */
    this.pending = new Map()
    this.recent = new Map()
    this.disposers = []
  }

  mount() {
    this.disposers.push(this.ctx.on('approval/request', (request, next) => {
      const binding = this.bindings.bySessionId(request?.agent?.session?.id ?? request?.agent?.id)
      if (!binding || !this.config.enabled) return next()
      return this.prompt(request, binding)
    }))
  }

  dispose() {
    for (const dispose of this.disposers) dispose()
    this.disposers = []
    for (const entry of this.pending.values()) entry.settle('cancelled')
    this.pending.clear()
  }

  async prompt(request, binding) {
    const id = shortId()
    const timeoutMs = Math.max(1_000, Number(this.config.timeoutSec ?? 300) * 1000)
    const gate = withTimeout(timeoutMs, () => 'rejected')

    const record = {
      id,
      toolName: request.toolName ?? 'tool',
      reason: request.reason ?? '',
      callId: request.callId ?? '',
      chatId: binding.chatId,
      sessionId: request.agent?.session?.id ?? '',
      createdAt: Date.now(),
    }
    this.pending.set(id, { record, settle: gate.resolve })

    const lines = [
      `🔐 需要授权 #${id}`,
      `工具：${record.toolName}`,
    ]
    if (record.reason) lines.push(`原因：${String(record.reason).slice(0, 400)}`)
    lines.push('', `回复 /审批 ${id} 允许   或   /审批 ${id} 拒绝`, `（${Math.round(timeoutMs / 1000)} 秒内未回复按拒绝处理）`)

    try {
      await this.send(binding.chatId, lines.join('\n'))
    } catch (error) {
      this.pending.delete(id)
      gate.resolve('unavailable')
      this.log(`审批卡片发送失败：${error?.message ?? error}`)
      return 'unavailable'
    }

    request.signal?.addEventListener('abort', () => gate.resolve('cancelled'), { once: true })

    const outcome = await gate.promise
    this.pending.delete(id)
    this.recent.set(id, { outcome, at: Date.now() })
    if (this.recent.size > 50) this.recent.delete(this.recent.keys().next().value)
    this.audit({ kind: 'approval', id, tool: record.toolName, outcome, chatId: binding.chatId })

    if (outcome === 'rejected') {
      void this.send(binding.chatId, `⛔ 已拒绝 #${id}（${record.toolName}）。`).catch(() => {})
    }
    return outcome
  }

  /**
   * Answer a pending approval from `/审批`.
   * @returns {'accepted'|'rejected'|'unknown'|'already'}
   */
  respond(id, allow) {
    const entry = this.pending.get(String(id))
    if (!entry) return this.recent.has(String(id)) ? 'already' : 'unknown'
    entry.settle(allow ? 'allowed-once' : 'rejected')
    return allow ? 'accepted' : 'rejected'
  }

  /** Pending approvals for `/状态`. */
  list() {
    return [...this.pending.values()].map(({ record }) => ({
      id: record.id,
      tool: record.toolName,
      ageSec: Math.round((Date.now() - record.createdAt) / 1000),
    }))
  }
}

/**
 * Routes `user-questions/request` to the chat, presenting each question as a
 * numbered list. A multi-select question accepts `1,3`.
 *
 * The answer is delivered through the request's own resolution rather than
 * `ctx.userQuestions.answer`, because the waterfall listener owns the promise
 * the tool is waiting on — resolving it is what actually unblocks the tool.
 */
export class QuestionBridge {
  constructor({ ctx, bindings, send, log, audit, config }) {
    this.ctx = ctx
    this.bindings = bindings
    this.send = send
    this.log = log
    this.audit = audit
    this.config = config
    this.pending = new Map()
    this.disposers = []
  }

  mount() {
    this.disposers.push(this.ctx.on('user-questions/request', (request, next) => {
      const agent = request?.agent
      const sessionId = agent?.session?.id ?? agent?.id
      const binding = this.bindings.bySessionId(sessionId)
      if (!binding || !this.config.enabled) return next()
      return this.prompt(request, binding)
    }))
  }

  dispose() {
    for (const dispose of this.disposers) dispose()
    this.disposers = []
    this.pending.clear()
  }

  async prompt(request, binding) {
    const questions = Array.isArray(request?.questions) ? request.questions : []
    if (!questions.length) return { answers: [] }

    const id = shortId()
    const timeoutMs = Math.max(1_000, Number(this.config.timeoutSec ?? 300) * 1000)
    const gate = withTimeout(timeoutMs, () => null)
    this.pending.set(id, { request, binding, settle: gate.resolve, questions, createdAt: Date.now() })

    const lines = [`❓ 需要你的回答 #${id}`]
    questions.forEach((question, index) => {
      lines.push('', `${index + 1}. ${question?.question ?? question?.header ?? '请选择'}`)
      const options = Array.isArray(question?.options) ? question.options : []
      options.forEach((option, optionIndex) => {
        lines.push(`   ${optionIndex + 1}) ${option?.label ?? option}`)
      })
      if (question?.multiSelect) lines.push('   （可多选：回复 1,3）')
    })
    lines.push('', `回复 /回答 ${id} <编号>${questions.length > 1 ? '，多个问题用 ; 分隔' : ''}`)
    lines.push(`（${Math.round(timeoutMs / 1000)} 秒内未回复按跳过处理）`)

    try {
      await this.send(binding.chatId, lines.join('\n'))
    } catch (error) {
      this.pending.delete(id)
      this.log(`提问卡片发送失败：${error?.message ?? error}`)
      return this.skipped(questions)
    }

    request.signal?.addEventListener('abort', () => gate.resolve(null), { once: true })

    const picked = await gate.promise
    this.pending.delete(id)
    this.audit({ kind: 'question', id, answered: Boolean(picked), chatId: binding.chatId })

    if (!picked) {
      void this.send(binding.chatId, `⏭ 提问 #${id} 已跳过。`).catch(() => {})
      return this.skipped(questions)
    }
    return this.buildAnswer(questions, picked)
  }

  /** Build the skip answer: every question selected nothing. */
  skipped(questions) {
    return {
      answers: questions.map((question) => ({ id: question?.id ?? '', selected: [] })),
    }
  }

  /**
   * Turn a raw reply such as `1,3; 2` into the answer vocabulary.
   * `selected` carries option labels, per the question service contract.
   */
  buildAnswer(questions, raw) {
    const groups = String(raw).split(/[;；]/).map((part) => part.trim()).filter(Boolean)
    const answers = questions.map((question, index) => {
      const options = Array.isArray(question?.options) ? question.options : []
      const group = groups[index] ?? groups[0] ?? ''
      const labels = group
        .split(/[,，\s]+/)
        .map((token) => Number(token))
        .filter((number) => Number.isInteger(number) && number >= 1 && number <= options.length)
        .map((number) => String(options[number - 1]?.label ?? options[number - 1]))
      return {
        id: question?.id ?? '',
        selected: question?.multiSelect ? labels : labels.slice(0, 1),
      }
    })
    return { answers }
  }

  /** Answer one pending question from `/回答`. */
  respond(id, raw) {
    const entry = this.pending.get(String(id))
    if (!entry) return 'unknown'
    entry.settle(String(raw))
    return 'answered'
  }

  list() {
    return [...this.pending.values()].map((entry) => ({
      id: [...this.pending.keys()].find((key) => this.pending.get(key) === entry) ?? '',
      questions: entry.questions.length,
      ageSec: Math.round((Date.now() - entry.createdAt) / 1000),
    }))
  }
}
