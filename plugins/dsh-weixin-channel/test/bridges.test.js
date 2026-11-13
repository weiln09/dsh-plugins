import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { BindingStore } from '../lib/bindings.js'
import { ApprovalBridge, QuestionBridge } from '../lib/bridges.js'
import { NotifyBus, extractText, normalizeStatus } from '../lib/notify.js'

/** A Context stub whose listeners can be fired by hand. */
function fakeCtx() {
  const listeners = new Map()
  const ctx = {
    on(type, handler) {
      const bucket = listeners.get(type) ?? []
      bucket.push(handler)
      listeners.set(type, bucket)
      return () => {
        listeners.set(type, (listeners.get(type) ?? []).filter((entry) => entry !== handler))
      }
    },
    emit() {},
    async fire(type, payload) {
      let index = 0
      const args = Array.isArray(payload) ? payload : [payload]
      const run = async () => {
        const bucket = listeners.get(type) ?? []
        const handler = bucket[index]
        index += 1
        if (!handler) return 'unhandled'
        return handler(...args, async () => run())
      }
      return run()
    },
  }
  return { ctx, listeners }
}

function setup() {
  const dir = mkdtempSync(path.join(tmpdir(), 'weixin-bridges-'))
  const bindings = new BindingStore(dir, {})
  bindings.setSession('chat-1', 'D:\\a', 'session-1')
  const sent = []
  const send = async (chatId, text) => { sent.push({ chatId, text }) }
  const { ctx } = fakeCtx()
  return { dir, bindings, sent, send, ctx }
}

function agentOf(sessionId) {
  return { id: sessionId, session: { id: sessionId }, options: {} }
}

test('approval is answered by the bound chat', async () => {
  const { dir, bindings, sent, send, ctx } = setup()
  const bridge = new ApprovalBridge({
    ctx, bindings, send, log: () => {}, audit: () => {},
    config: { enabled: true, timeoutSec: 60 },
  })
  bridge.mount()

  const promise = ctx.fire('approval/request', {
    agent: agentOf('session-1'),
    toolName: 'pwsh',
    reason: 'writes outside the workspace',
    signal: new AbortController().signal,
  })

  await new Promise((resolve) => setTimeout(resolve, 10))
  assert.equal(sent.length, 1)
  assert.match(sent[0].text, /需要授权/)
  assert.match(sent[0].text, /pwsh/)

  const id = sent[0].text.match(/#([0-9a-f]{4})/)[1]
  assert.equal(bridge.respond(id, true), 'accepted')
  assert.equal(await promise, 'allowed-once')
  await bindings.flush()
  rmSync(dir, { recursive: true, force: true })
})

test('an approval for an unbound session is delegated', async () => {
  const { dir, bindings, ctx } = setup()
  const bridge = new ApprovalBridge({
    ctx, bindings, send: async () => {}, log: () => {}, audit: () => {},
    config: { enabled: true, timeoutSec: 60 },
  })
  bridge.mount()
  const outcome = await ctx.fire('approval/request', { agent: agentOf('session-web'), toolName: 'pwsh' })
  assert.equal(outcome, 'unhandled', 'the next() chain ran instead of the bridge')
  await bindings.flush()
  rmSync(dir, { recursive: true, force: true })
})

test('an unanswered approval times out as rejected', async () => {
  const { dir, bindings, sent, ctx } = setup()
  const bridge = new ApprovalBridge({
    ctx, bindings, send: async (chatId, text) => { sent.push({ chatId, text }) },
    log: () => {}, audit: () => {},
    config: { enabled: true, timeoutSec: 1 },
  })
  bridge.mount()
  const outcome = await ctx.fire('approval/request', {
    agent: agentOf('session-1'), toolName: 'pwsh', signal: new AbortController().signal,
  })
  assert.equal(outcome, 'rejected')
  assert.ok(sent.some((entry) => /已拒绝/.test(entry.text)))
  await bindings.flush()
  rmSync(dir, { recursive: true, force: true })
})

test('an unknown approval id is reported, not silently accepted', async () => {
  const { dir, bindings, ctx } = setup()
  const bridge = new ApprovalBridge({
    ctx, bindings, send: async () => {}, log: () => {}, audit: () => {},
    config: { enabled: true, timeoutSec: 60 },
  })
  assert.equal(bridge.respond('nope', true), 'unknown')
  await bindings.flush()
  rmSync(dir, { recursive: true, force: true })
})

test('a question renders options and maps a numeric reply to labels', async () => {
  const { dir, bindings, sent, send, ctx } = setup()
  const bridge = new QuestionBridge({
    ctx, bindings, send, log: () => {}, audit: () => {},
    config: { enabled: true, timeoutSec: 60 },
  })
  bridge.mount()

  const promise = ctx.fire('user-questions/request', {
    agent: agentOf('session-1'),
    questions: [{
      id: 'q1',
      question: '用哪个数据库？',
      options: [{ label: 'Postgres' }, { label: 'SQLite' }],
    }],
    signal: new AbortController().signal,
  })

  await new Promise((resolve) => setTimeout(resolve, 10))
  assert.match(sent[0].text, /Postgres/)
  const id = sent[0].text.match(/#([0-9a-f]{4})/)[1]
  bridge.respond(id, '2')
  assert.deepEqual(await promise, { answers: [{ id: 'q1', selected: ['SQLite'] }] })
  await bindings.flush()
  rmSync(dir, { recursive: true, force: true })
})

test('a multi-select question keeps every chosen label', async () => {
  const { dir, bindings, ctx } = setup()
  const bridge = new QuestionBridge({
    ctx, bindings, send: async () => {}, log: () => {}, audit: () => {},
    config: { enabled: true, timeoutSec: 60 },
  })
  assert.deepEqual(
    bridge.buildAnswer([{ id: 'q', multiSelect: true, options: [{ label: 'a' }, { label: 'b' }, { label: 'c' }] }], '1,3'),
    { answers: [{ id: 'q', selected: ['a', 'c'] }] },
  )
  await bindings.flush()
  rmSync(dir, { recursive: true, force: true })
})

test('a single-select question keeps only the first label', async () => {
  const { dir, bindings, ctx } = setup()
  const bridge = new QuestionBridge({
    ctx, bindings, send: async () => {}, log: () => {}, audit: () => {},
    config: { enabled: true, timeoutSec: 60 },
  })
  assert.deepEqual(
    bridge.buildAnswer([{ id: 'q', options: [{ label: 'a' }, { label: 'b' }] }], '1,2'),
    { answers: [{ id: 'q', selected: ['a'] }] },
  )
  await bindings.flush()
  rmSync(dir, { recursive: true, force: true })
})

test('an unanswered question settles as skipped rather than hanging', async () => {
  const { dir, bindings, sent, ctx } = setup()
  const bridge = new QuestionBridge({
    ctx, bindings, send: async (chatId, text) => { sent.push({ chatId, text }) },
    log: () => {}, audit: () => {},
    config: { enabled: true, timeoutSec: 1 },
  })
  bridge.mount()
  const answer = await ctx.fire('user-questions/request', {
    agent: agentOf('session-1'),
    questions: [{ id: 'q1', question: '继续吗？', options: [{ label: '是' }] }],
    signal: new AbortController().signal,
  })
  assert.deepEqual(answer, { answers: [{ id: 'q1', selected: [] }] })
  await bindings.flush()
  rmSync(dir, { recursive: true, force: true })
})

test('turn-end reasons normalize to card statuses', () => {
  assert.equal(normalizeStatus({ kind: 'completed' }), 'completed')
  assert.equal(normalizeStatus({ kind: 'error' }), 'error')
  assert.equal(normalizeStatus({ kind: 'aborted' }), 'aborted')
  assert.equal(normalizeStatus({ kind: 'max-tokens' }), 'max-tokens')
  assert.equal(normalizeStatus({}), 'completed')
})

test('assistant text extraction ignores non-text blocks', () => {
  assert.equal(extractText({ content: [{ type: 'text', text: 'a' }, { type: 'image' }] }), 'a')
  assert.equal(extractText({ content: [] }), '')
  assert.equal(extractText(null), '')
})

test('a bound session produces a result card without mirroring tool calls', async () => {
  // Tool calls stay in the Web UI transcript: a turn with twenty of them used
  // to arrive as twenty WeChat messages and bury the actual answer.
  const { dir, bindings, sent, send, ctx } = setup()
  const bus = new NotifyBus({ ctx, bindings, send, log: () => {} })
  bus.configure({ granularity: 'standard', progressIntervalMs: 10 })
  bus.mount()

  const session = { id: 'session-1' }
  await ctx.fire('session/event', [session, { type: 'turn/start', data: { turn: 1 } }])
  await ctx.fire('session/event', [session, { type: 'tool/call', data: { name: 'pwsh', arguments: { command: 'npm test' } } }])
  await ctx.fire('session/event', [session, {
    type: 'assistant/message',
    data: { message: { content: [{ type: 'text', text: '已完成' }] }, usage: { inputTokens: 3, outputTokens: 4 } },
  }])
  await ctx.fire('session/event', [session, { type: 'turn/end', data: { reason: { kind: 'completed' } } }])

  assert.equal(sent.some((entry) => /pwsh/.test(entry.text)), false, 'tool calls are not mirrored')
  assert.ok(sent.some((entry) => /完成/.test(entry.text) && /已完成/.test(entry.text)), 'result card was sent')
  bus.dispose()
  await bindings.flush()
  rmSync(dir, { recursive: true, force: true })
})

test('tool progress is opt-in through reply.toolProgress', async () => {
  const { dir, bindings, sent, send, ctx } = setup()
  const bus = new NotifyBus({ ctx, bindings, send, log: () => {} })
  bus.configure({ granularity: 'standard', progressIntervalMs: 10, toolProgress: true })
  bus.mount()

  const session = { id: 'session-1' }
  await ctx.fire('session/event', [session, { type: 'turn/start', data: { turn: 1 } }])
  await ctx.fire('session/event', [session, { type: 'tool/call', data: { name: 'pwsh', arguments: { command: 'npm test' } } }])

  assert.ok(sent.some((entry) => /pwsh/.test(entry.text)), 'opt-in restores the tool line')
  bus.dispose()
  await bindings.flush()
  rmSync(dir, { recursive: true, force: true })
})

test('a long answer is delivered whole, not clipped to 1200 characters', async () => {
  // The WeChat card used to run the answer through clip(summary, 1200), so any
  // real report ended mid-sentence with "…（已截断，回复 /日志 获取完整输出）"
  // while the desktop chat showed the full text.
  const { dir, bindings, sent, send, ctx } = setup()
  const bus = new NotifyBus({ ctx, bindings, send, log: () => {} })
  bus.configure({ granularity: 'standard', progressIntervalMs: 10 })
  bus.mount()

  const long = Array.from({ length: 120 }, (_, index) => `第 ${index} 行的正文内容，用来撑长回答。`).join('\n')
  assert.ok(long.length > 1_500, 'the fixture is longer than the old cap')

  const session = { id: 'session-1' }
  await ctx.fire('session/event', [session, { type: 'turn/start', data: { turn: 1 } }])
  await ctx.fire('session/event', [session, { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: long }] } } }])
  await ctx.fire('session/event', [session, { type: 'turn/end', data: { reason: { kind: 'completed' } } }])

  const card = sent.map((entry) => entry.text).join('\n')
  assert.doesNotMatch(card, /已截断/, 'the card must not truncate the answer')
  assert.match(card, /第 119 行/, 'the tail of the answer is present')
  bus.dispose()
  await bindings.flush()
  rmSync(dir, { recursive: true, force: true })
})

test('the summary granularity still asks for a digest', async () => {
  const { dir, bindings, sent, send, ctx } = setup()
  bindings.touch('chat-1', { replyGranularity: 'summary' })
  const bus = new NotifyBus({ ctx, bindings, send, log: () => {} })
  bus.mount()

  const long = 'A'.repeat(4_000)
  const session = { id: 'session-1' }
  await ctx.fire('session/event', [session, { type: 'turn/start', data: { turn: 1 } }])
  await ctx.fire('session/event', [session, { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: long }] } } }])
  await ctx.fire('session/event', [session, { type: 'turn/end', data: { reason: { kind: 'completed' } } }])

  const card = sent.map((entry) => entry.text).join('\n')
  assert.match(card, /已截断/, 'summary explicitly wants a shortened digest')
  bus.dispose()
  await bindings.flush()
  rmSync(dir, { recursive: true, force: true })
})

test('a full stream is not repeated by the result card', async () => {
  // `full` already sends the text as it arrives; the card then carried the same
  // answer again, so every reply appeared twice in WeChat.
  const { dir, bindings, sent, ctx } = setup()
  bindings.touch('chat-1', { replyGranularity: 'full' })
  const bus = new NotifyBus({ ctx, bindings, send: async (chatId, text) => { sent.push({ chatId, text }) }, log: () => {} })
  bus.configure({ granularity: 'full', progressIntervalMs: 5 })
  bus.mount()

  const agent = agentOf('session-1')
  const scoped = fakeCtx()
  bus.attachAgent(scoped.ctx, agent)
  const answer = '这是完整回答的第一段。\n\n这是第二段。'
  await scoped.ctx.fire('agent/assistant-stream', {
    frame: { type: 'chunk', chunk: { kind: 'text-delta', text: answer } },
  })
  await new Promise((resolve) => setTimeout(resolve, 30))
  await ctx.fire('session/event', [{ id: 'session-1' }, { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: answer }] } } }])
  await ctx.fire('session/event', [{ id: 'session-1' }, { type: 'turn/end', data: { reason: { kind: 'completed' } } }])

  const occurrences = sent.map((entry) => entry.text).join('\n').split('这是完整回答的第一段').length - 1
  assert.equal(occurrences, 1, 'the streamed text is not repeated in the card')
  bus.dispose()
  await bindings.flush()
  rmSync(dir, { recursive: true, force: true })
})

test('a session with no chat binding is never mirrored', async () => {
  const { dir, bindings, sent, ctx } = setup()
  const bus = new NotifyBus({ ctx, bindings, send: async (chatId, text) => { sent.push({ chatId, text }) }, log: () => {} })
  bus.mount()
  await ctx.fire('session/event', [{ id: 'session-web' }, { type: 'turn/start', data: { turn: 1 } }])
  await ctx.fire('session/event', [{ id: 'session-web' }, { type: 'turn/end', data: { reason: { kind: 'completed' } } }])
  assert.equal(sent.length, 0)
  bus.dispose()
  await bindings.flush()
  rmSync(dir, { recursive: true, force: true })
})

test('a muted chat receives no progress or card', async () => {
  const { dir, bindings, sent, ctx } = setup()
  bindings.touch('chat-1', { muted: true })
  const bus = new NotifyBus({ ctx, bindings, send: async (chatId, text) => { sent.push({ chatId, text }) }, log: () => {} })
  bus.mount()
  const session = { id: 'session-1' }
  await ctx.fire('session/event', [session, { type: 'turn/start', data: { turn: 1 } }])
  await ctx.fire('session/event', [session, { type: 'tool/call', data: { name: 'pwsh' } }])
  await ctx.fire('session/event', [session, { type: 'turn/end', data: { reason: { kind: 'completed' } } }])
  assert.equal(sent.length, 0)
  bus.dispose()
  await bindings.flush()
  rmSync(dir, { recursive: true, force: true })
})

test('live agent stream frames reach a full-granularity chat', async () => {
  const { dir, bindings, sent, ctx } = setup()
  bindings.touch('chat-1', { replyGranularity: 'full' })
  const bus = new NotifyBus({ ctx, bindings, send: async (chatId, text) => { sent.push({ chatId, text }) }, log: () => {} })
  bus.configure({ granularity: 'full', progressIntervalMs: 5 })
  bus.mount()

  const agent = agentOf('session-1')
  // Stream frames are agent-scoped, so they are wired from the agent's setup.
  const scoped = fakeCtx()
  bus.attachAgent(scoped.ctx, agent)

  await scoped.ctx.fire('agent/assistant-stream', { frame: { type: 'start' } })
  await scoped.ctx.fire('agent/assistant-stream', {
    frame: { type: 'chunk', chunk: { kind: 'text-delta', text: '正在处理' } },
  })
  await new Promise((resolve) => setTimeout(resolve, 30))
  assert.ok(sent.some((entry) => /正在处理/.test(entry.text)), 'the delta was flushed')
  bus.dispose()
  await bindings.flush()
  rmSync(dir, { recursive: true, force: true })
})

test('stream frames for a standard-granularity chat are ignored', async () => {
  const { dir, bindings, sent, ctx } = setup()
  const bus = new NotifyBus({ ctx, bindings, send: async (chatId, text) => { sent.push({ chatId, text }) }, log: () => {} })
  bus.configure({ granularity: 'standard', progressIntervalMs: 5 })
  bus.mount()

  const agent = agentOf('session-1')
  const scoped = fakeCtx()
  bus.attachAgent(scoped.ctx, agent)
  await scoped.ctx.fire('agent/assistant-stream', {
    frame: { type: 'chunk', chunk: { kind: 'text-delta', text: '不应出现' } },
  })
  await new Promise((resolve) => setTimeout(resolve, 30))
  assert.equal(sent.length, 0)
  bus.dispose()
  await bindings.flush()
  rmSync(dir, { recursive: true, force: true })
})

test('a blocked turn explains itself instead of sending a bare status line', async () => {
  // "⏳ 被阻塞 / ⏱ 1.2s" was literally all the chat got: a pre-step gate rejects
  // the turn before any request, so there is no error object to print and the
  // fallback summary was empty. The user had no way to know what happened.
  const { dir, bindings, sent, ctx } = setup()
  const bus = new NotifyBus({ ctx, bindings, send: async (chatId, text) => { sent.push({ chatId, text }) }, log: () => {} })
  bus.mount()

  const session = { id: 'session-1' }
  await ctx.fire('session/event', [session, { type: 'turn/start', data: { turn: 1 } }])
  await ctx.fire('session/event', [session, { type: 'turn/end', data: { reason: { kind: 'blocked' } } }])

  const card = sent.map((entry) => entry.text).join('\n')
  assert.match(card, /被阻塞/)
  assert.match(card, /归档/, 'the card names the usual cause')
  assert.match(card, /\/新建/, 'the card names a way out')
  bus.dispose()
  await bindings.flush()
  rmSync(dir, { recursive: true, force: true })
})

test('an interrupted turn also says something', async () => {
  const { dir, bindings, sent, ctx } = setup()
  const bus = new NotifyBus({ ctx, bindings, send: async (chatId, text) => { sent.push({ chatId, text }) }, log: () => {} })
  bus.mount()
  const session = { id: 'session-1' }
  await ctx.fire('session/event', [session, { type: 'turn/start', data: { turn: 1 } }])
  await ctx.fire('session/event', [session, { type: 'turn/end', data: { reason: { kind: 'interrupted' } } }])
  assert.match(sent.map((entry) => entry.text).join('\n'), /中断/)
  bus.dispose()
  await bindings.flush()
  rmSync(dir, { recursive: true, force: true })
})
