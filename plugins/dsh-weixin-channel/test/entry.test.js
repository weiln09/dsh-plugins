import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'

// The entry module imports `@deepseek-ai/schemastery`, a peer dependency the
// Host supplies. A checkout without an install cannot resolve it, so these
// tests skip instead of failing: the behaviour they cover is also exercised by
// the pure modules (commands, session, bridges) that need no peer.
const entry = await import('../lib/index.js').catch(() => null)
const skip = entry === null
  ? 'peer dependency @deepseek-ai/schemastery is not installed'
  : false

/** A Context stub with just enough surface for `apply`. */
function fakeCtx() {
  const effects = []
  const tools = []
  const provided = new Map()
  const ctx = {
    logger: () => ({ info() {}, warn() {}, error() {}, debug() {} }),
    agents: { get: () => undefined },
    get(key) {
      if (key === 'agents') return this.agents
      if (key === 'tools') return this.tools
      return undefined
    },
    tools: {
      register(definition) {
        tools.push(definition)
        return () => {}
      },
    },
    // Cordis runs the effect factory immediately and keeps its disposer.
    effect(factory) {
      const disposer = factory()
      effects.push(disposer)
      return () => {}
    },
    on() {
      return () => {}
    },
    emit() {},
    provide(key, value) {
      provided.set(key, value)
    },
    inject() {},
  }
  return { ctx, tools, provided, effects }
}

function config(overrides = {}) {
  const stateDir = mkdtempSync(path.join(tmpdir(), 'weixin-entry-'))
  return { stateDir, ...overrides }
}

test('the plugin declares its name and required services', { skip }, () => {
  assert.equal(entry.name, 'weixin-channel')
  assert.deepEqual(entry.inject, ['agents', 'tools'])
})

test('the config schema fills the documented defaults', { skip }, () => {
  const parsed = entry.Config({})
  assert.equal(parsed.enabled, true)
  assert.equal(parsed.account.tokenRef, 'env:WEIXIN_BOT_TOKEN')
  assert.equal(parsed.account.baseUrl, 'https://ilinkai.weixin.qq.com/')
  assert.equal(parsed.reply.granularity, 'standard')
  assert.equal(parsed.reply.maxChunkChars, 2000)
  assert.equal(parsed.approvals.timeoutSec, 300)
  assert.equal(parsed.turn.queueMax, 5)
  assert.equal(parsed.security.trustFirstContact, false)
  assert.equal(parsed.media.maxBytes, 20 * 1024 * 1024)
  assert.deepEqual(parsed.allowedWorkspaces, [])
  assert.deepEqual(parsed.allowedModels, [])
})

test('a provider/model key splits at the first slash only', { skip }, () => {
  // Model ids carry slashes of their own (`trae-cn/deepseek-v4.1-flash-max`),
  // so a destructuring split produced a model that does not exist.
  assert.deepEqual(entry.parseModelKey('magpie/trae-cn/deepseek-v4.1-flash-max'), {
    provider: 'magpie', model: 'trae-cn/deepseek-v4.1-flash-max',
  })
  assert.deepEqual(entry.parseModelKey('a/b'), { provider: 'a', model: 'b' })
  assert.equal(entry.parseModelKey('noslash'), null)
  assert.equal(entry.parseModelKey('/model'), null)
  assert.equal(entry.parseModelKey('provider/'), null)
  assert.equal(entry.parseModelKey(''), null)
})

test('panel defaults survive a restart and keep a slashed model id intact', { skip }, async () => {
  const cfg = config()
  const { ctx: first } = fakeCtx()
  const channel = entry.apply(first, entry.Config(cfg))
  await channel.panelAction('defaults.set', {
    workspace: 'D:\\proj',
    model: 'magpie/trae-cn/deepseek-v4.1-flash-max',
    permissionPreset: 'workspace-write',
  })
  await channel.dispose()

  // A fresh Host process reads the same state directory.
  const { ctx: second } = fakeCtx()
  const restarted = entry.apply(second, entry.Config(cfg))
  assert.equal(restarted.cfg.defaults.workspace, 'D:\\proj')
  assert.equal(restarted.cfg.defaults.model.provider, 'magpie')
  assert.equal(restarted.cfg.defaults.model.model, 'trae-cn/deepseek-v4.1-flash-max')
  assert.equal(restarted.cfg.defaults.permissionPreset, 'workspace-write')
  await restarted.dispose()
  rmSync(cfg.stateDir, { recursive: true, force: true })
})

test('an unusable model key is rejected instead of half-applied', { skip }, async () => {
  const { ctx } = fakeCtx()
  const cfg = config()
  const channel = entry.apply(ctx, entry.Config(cfg))
  await assert.rejects(
    () => channel.panelAction('defaults.set', { model: 'magpie' }),
    /无效的模型标识/,
  )
  assert.equal(channel.cfg.defaults.model?.model ?? '', '')
  await channel.dispose()
  rmSync(cfg.stateDir, { recursive: true, force: true })
})

test('apply registers the service and the push tool without a token', { skip }, async () => {
  const { ctx, tools, provided } = fakeCtx()
  const cfg = config()
  const channel = entry.apply(ctx, entry.Config(cfg))

  assert.ok(channel instanceof entry.WeixinChannel)
  assert.ok(provided.has('weixinChannel'))
  assert.equal(tools.length, 1)
  assert.equal(tools[0].name, 'weixin_send')

  await new Promise((resolve) => setTimeout(resolve, 20))
  assert.equal(channel.statusView().connected, false)
  assert.match(channel.statusView().detail, /token/)

  await channel.dispose()
  rmSync(cfg.stateDir, { recursive: true, force: true })
})

test('the replay maps stay bounded as conversations accumulate', { skip }, async () => {
  // /重试 and /日志 only ever read the chat's CURRENT session, so keeping one
  // full answer per conversation ever seen was pure leak.
  const { ctx } = fakeCtx()
  const cfg = config()
  const channel = entry.apply(ctx, entry.Config(cfg))
  for (let index = 0; index < 100; index += 1) {
    channel.remember(channel.lastOutput, `session-${index}`, 'x'.repeat(50))
    channel.remember(channel.lastUserText, `session-${index}`, 'prompt')
  }
  assert.ok(channel.lastOutput.size <= 32, 'the answer cache is capped')
  assert.ok(channel.lastUserText.size <= 32, 'the prompt cache is capped')
  assert.equal(channel.lastOutput.has('session-99'), true, 'the newest entry survives')
  assert.equal(channel.lastOutput.has('session-0'), false, 'the oldest entry is dropped')
  await channel.dispose()
  rmSync(cfg.stateDir, { recursive: true, force: true })
})

test('diagnostics never echo proxy credentials', { skip }, async () => {
  // A proxy URL commonly carries user:password@, and the report is rendered in
  // a browser tab.
  const { ctx } = fakeCtx()
  const cfg = config()
  const channel = entry.apply(ctx, entry.Config(cfg))
  assert.equal(entry.redactUrl('http://user:s3cret@proxy.local:8080'), 'http://***:***@proxy.local:8080/')
  assert.equal(entry.redactUrl('socks5://token@proxy.local:1080'), 'socks5://***@proxy.local:1080')
  assert.equal(entry.redactUrl('http://proxy.local:8080'), 'http://proxy.local:8080/')
  assert.equal(entry.redactUrl('not a url'), 'not a url')
  assert.equal(entry.redactUrl(''), '')
  await channel.dispose()
  rmSync(cfg.stateDir, { recursive: true, force: true })
})

test('the push tool reports failures rather than throwing without a token', { skip }, async () => {
  const { ctx, tools } = fakeCtx()
  const cfg = config()
  const channel = entry.apply(ctx, entry.Config(cfg))
  const result = await tools[0].execute({ to: 'chat-1', text: 'hello' })
  assert.deepEqual(result, { sent: 0, failed: 1 })
  await channel.dispose()
  rmSync(cfg.stateDir, { recursive: true, force: true })
})

test('an unknown sender is refused and never reaches an agent', { skip }, async () => {
  const { ctx } = fakeCtx()
  const cfg = config()
  const channel = entry.apply(ctx, entry.Config(cfg))

  const sent = []
  channel.sendText = async (chatId, text) => { sent.push({ chatId, text }); return true }

  await channel.handleInbound({
    from_user_id: 'stranger@im.wechat',
    message_id: 1,
    item_list: [{ type: 1, text_item: { text: '/帮助' } }],
  })

  assert.equal(sent.length, 1)
  assert.match(sent[0].text, /未授权/)
  assert.equal(channel.bindings.isAllowed('stranger@im.wechat'), false)
  await channel.dispose()
  rmSync(cfg.stateDir, { recursive: true, force: true })
})

test('a duplicate message id is handled once', { skip }, async () => {
  const { ctx } = fakeCtx()
  const cfg = config()
  const channel = entry.apply(ctx, entry.Config(cfg))
  const seen = []
  channel.runCommand = async (_chatId, parsed) => { seen.push(parsed.name) }

  const message = {
    from_user_id: 'owner@im.wechat',
    message_id: 7,
    item_list: [{ type: 1, text_item: { text: '/帮助' } }],
  }
  channel.bindings.allow('owner@im.wechat')
  await channel.handleInbound(message)
  await channel.handleInbound(message)
  assert.deepEqual(seen, ['help'])
  await channel.dispose()
  rmSync(cfg.stateDir, { recursive: true, force: true })
})

test('a bare number answers the open menu and 0 cancels', { skip }, async () => {
  const { ctx } = fakeCtx()
  const cfg = config()
  const channel = entry.apply(ctx, entry.Config(cfg))
  const sent = []
  channel.sendText = async (chatId, text) => { sent.push(text); return true }
  channel.bindings.allow('owner@im.wechat')
  channel.switchWorkspace = async (_chatId, workspace) => { sent.push(`switched:${workspace}`) }

  channel.pending.set('owner@im.wechat', 'workspace', ['D:\\a', 'D:\\b'])
  await channel.handleInbound({
    from_user_id: 'owner@im.wechat',
    message_id: 11,
    item_list: [{ type: 1, text_item: { text: '2' } }],
  })
  assert.ok(sent.includes('switched:D:\\b'))

  channel.pending.set('owner@im.wechat', 'workspace', ['D:\\a'])
  await channel.handleInbound({
    from_user_id: 'owner@im.wechat',
    message_id: 12,
    item_list: [{ type: 1, text_item: { text: '0' } }],
  })
  assert.ok(sent.some((line) => /已取消/.test(line)))
  await channel.dispose()
  rmSync(cfg.stateDir, { recursive: true, force: true })
})

test('an admin-only command is refused for a normal user', { skip }, async () => {
  const { ctx } = fakeCtx()
  const cfg = config()
  const channel = entry.apply(ctx, entry.Config(cfg))
  const sent = []
  channel.sendText = async (chatId, text) => { sent.push(text); return true }
  channel.bindings.allow('user@im.wechat')

  await channel.handleInbound({
    from_user_id: 'user@im.wechat',
    message_id: 21,
    item_list: [{ type: 1, text_item: { text: '/信任 someone' } }],
  })
  assert.ok(sent.some((line) => /管理员/.test(line)))
  assert.equal(channel.bindings.isAllowed('someone'), false)
  await channel.dispose()
  rmSync(cfg.stateDir, { recursive: true, force: true })
})

test('the first contact can be auto-trusted when configured', { skip }, async () => {
  const { ctx } = fakeCtx()
  const cfg = config({ security: { trustFirstContact: true, allowlist: [], admins: [] } })
  const channel = entry.apply(ctx, entry.Config(cfg))
  const sent = []
  channel.sendText = async (chatId, text) => { sent.push(text); return true }

  await channel.handleInbound({
    from_user_id: 'newbie@im.wechat',
    message_id: 41,
    item_list: [{ type: 1, text_item: { text: '你好' } }],
  })
  assert.equal(channel.bindings.isAllowed('newbie@im.wechat'), true)
  assert.ok(sent.some((line) => /首次接触/.test(line)))
  await channel.dispose()
  rmSync(cfg.stateDir, { recursive: true, force: true })
})

test('a dispatched prompt carries a producer-owned source kind', { skip }, async () => {
  // Session format v4 refuses the retired `{ kind: 'plugin', plugin }` wrapper
  // with "format v4 message requires a producer-owned source kind"; encoding the
  // prompt is what failed the whole turn inside WeChat.
  const { ctx } = fakeCtx()
  const cfg = config()
  const channel = entry.apply(ctx, entry.Config(cfg))
  channel.sendText = async () => true
  channel.bindings.allow('owner@im.wechat')

  // The catalog lookup needs a live Host; the test supplies the route instead.
  channel.defaultSelection = async () => ({ provider: 'p', model: 'm' })

  const captured = []
  const agent = {
    id: 'session-source',
    session: { id: 'session-source', header: { cwd: cfg.stateDir }, turnOpen: false },
    options: { provider: 'p', model: 'm' },
    status: 'idle',
    model: { current: () => ({ provider: 'p', model: 'm' }), select() {} },
    followup: (message) => { captured.push(message) },
    whenIdle: async () => {},
    cancel() {},
  }
  channel.router.agents = () => ({
    get: () => undefined,
    create: async () => ({ agent }),
    resume: async () => ({ agent }),
  })
  // The turn end is irrelevant here; only the submitted message matters.
  channel.awaitTurnEnd = async () => 'idle'

  await channel.runTurn('owner@im.wechat', { from_user_id: 'owner@im.wechat' }, '你是什么', cfg.stateDir)

  assert.equal(captured.length, 1)
  assert.equal(captured[0].role, 'user')
  assert.equal(captured[0].source.kind, 'user')
  assert.equal(Object.hasOwn(captured[0].source, 'plugin'), false, 'v4 refuses the plugin wrapper')
  await channel.dispose()
  rmSync(cfg.stateDir, { recursive: true, force: true })
})

test('the typing indicator is refreshed for the whole turn', { skip }, async () => {
  // iLink expires a typing status a few seconds after it is sent: one status:1
  // before a multi-minute turn blinked once and vanished, which is exactly what
  // "微信端看不到正在输入" looked like.
  const { ctx } = fakeCtx()
  const cfg = config({ reply: { granularity: 'standard', progressIntervalMs: 4000, maxChunkChars: 2000, toolProgress: false, typingIntervalMs: 40 } })
  const channel = entry.apply(ctx, entry.Config(cfg))

  const calls = []
  channel.account = () => ({ token: 'tk', baseUrl: 'https://ilinkai.weixin.qq.com/' })
  channel.api = {
    getConfig: async () => ({ typing_ticket: 'ticket-1' }),
    sendTyping: async (args) => { calls.push(args.status) },
    notifyStop: async () => {},
  }

  await channel.showTyping('owner@im.wechat', 'ctx-token')
  assert.equal(calls[0], 1, 'the indicator starts immediately')
  assert.equal(channel.typingTickets.get('owner@im.wechat').ticket, 'ticket-1', 'the ticket is cached')

  // The refresh period has a 1s floor so a chat cannot hammer sendtyping.
  await new Promise((resolve) => setTimeout(resolve, 1_150))
  assert.ok(calls.filter((status) => status === 1).length >= 2, 'the indicator is re-armed on a timer')

  channel.hideTyping('owner@im.wechat')
  assert.equal(calls[calls.length - 1], 2, 'the turn end clears the indicator')
  assert.equal(channel.typingTimers.size, 0, 'no timer outlives the turn')

  await channel.dispose()
  rmSync(cfg.stateDir, { recursive: true, force: true })
})

test('the typing request uses the protocol field names', { skip }, async () => {
  // The real bug behind "微信端还是看不到正在输入": sendtyping was posted as
  // { to_user_id, typing_status }. The HTTP layer accepts unknown fields, so the
  // request looked successful and the indicator never appeared. The wire fields
  // are { ilink_user_id, status }.
  const sent = []
  const ilink = await import('../lib/ilink.js')
  const api = ilink.createILinkApi({
    fetchImpl: async (url, init = {}) => {
      sent.push({ path: new URL(String(url)).pathname, body: JSON.parse(init.body) })
      return new Response(JSON.stringify({ ret: 0 }), { headers: { 'content-type': 'application/json' } })
    },
  })
  await api.sendTyping({
    baseUrl: 'https://ilinkai.weixin.qq.com/', token: 't',
    to: 'owner@im.wechat', typingTicket: 'ticket-1', status: 1,
  })
  const body = sent[0].body
  assert.equal(body.ilink_user_id, 'owner@im.wechat')
  assert.equal(body.status, 1)
  assert.equal(body.typing_ticket, 'ticket-1')
  assert.equal('to_user_id' in body, false, 'to_user_id is not the typing target field')
  assert.equal('typing_status' in body, false, 'typing_status is not the flag field')
})

test('a rejected typing status is surfaced, not swallowed', { skip }, async () => {
  const ilink = await import('../lib/ilink.js')
  const api = ilink.createILinkApi({
    fetchImpl: async () => new Response(JSON.stringify({ ret: -2 }), { headers: { 'content-type': 'application/json' } }),
  })
  await assert.rejects(
    api.sendTyping({ baseUrl: 'https://ilinkai.weixin.qq.com/', token: 't', to: 'u', typingTicket: 'x', status: 1 }),
    (error) => error.code === 'typing-rejected',
  )
})

test('a stale typing ticket is dropped so the next message refetches it', { skip }, async () => {
  const { ctx } = fakeCtx()
  const cfg = config()
  const channel = entry.apply(ctx, entry.Config(cfg))
  channel.account = () => ({ token: 'tk', baseUrl: 'https://ilinkai.weixin.qq.com/' })
  let fetches = 0
  channel.api = {
    getConfig: async () => { fetches += 1; return { typing_ticket: `ticket-${fetches}` } },
    sendTyping: async () => { throw new Error('typing-rejected') },
    notifyStop: async () => {},
  }

  await channel.showTyping('owner@im.wechat', 'ctx')
  assert.equal(channel.typingTickets.has('owner@im.wechat'), false, 'a rejected status drops the ticket')
  assert.equal(channel.typingState.ok, false, 'the failure is recorded for /诊断')
  channel.hideTyping('owner@im.wechat')

  channel.api.sendTyping = async () => ({ ret: 0 })
  await channel.showTyping('owner@im.wechat', 'ctx')
  assert.equal(fetches, 2, 'the ticket is fetched again instead of being reused forever')
  assert.equal(channel.typingState.ok, true)
  channel.hideTyping('owner@im.wechat')
  await channel.dispose()
  rmSync(cfg.stateDir, { recursive: true, force: true })
})

test('a command clears the typing indicator instead of leaving it on', { skip }, async () => {
  const { ctx } = fakeCtx()
  const cfg = config()
  const channel = entry.apply(ctx, entry.Config(cfg))
  const statuses = []
  channel.account = () => ({ token: 'tk', baseUrl: 'https://ilinkai.weixin.qq.com/' })
  channel.api = {
    getConfig: async () => ({ typing_ticket: 'ticket-1' }),
    sendTyping: async (args) => { statuses.push(args.status) },
    notifyStop: async () => {},
  }
  channel.sendText = async () => true
  channel.bindings.allow('owner@im.wechat')

  await channel.handleInbound({
    from_user_id: 'owner@im.wechat',
    message_id: 51,
    item_list: [{ type: 1, text_item: { text: '/帮助' } }],
  })

  assert.ok(statuses.includes(1), 'the indicator appeared while the command ran')
  assert.equal(channel.typingContexts.get('owner@im.wechat'), undefined, 'no context token was supplied, none is invented')
  assert.equal(statuses[statuses.length - 1], 2, 'and was cleared once the command answered')
  await channel.dispose()
  rmSync(cfg.stateDir, { recursive: true, force: true })
})

test('an unknown slash command is answered instead of becoming a task', { skip }, async () => {
  const { ctx } = fakeCtx()
  const cfg = config()
  const channel = entry.apply(ctx, entry.Config(cfg))
  const sent = []
  let dispatched = 0
  channel.sendText = async (chatId, text) => { sent.push(text); return true }
  channel.dispatchTask = async () => { dispatched += 1 }
  channel.bindings.allow('owner@im.wechat')

  await channel.handleInbound({
    from_user_id: 'owner@im.wechat',
    message_id: 31,
    item_list: [{ type: 1, text_item: { text: '/nonsense' } }],
  })
  assert.equal(dispatched, 0, 'a typo must not become a task')
  assert.ok(sent.some((line) => /未知命令/.test(line)))
  await channel.dispose()
  rmSync(cfg.stateDir, { recursive: true, force: true })
})
test('/回答 delivers a pending question answer instead of timing out', { skip }, async () => {
  // The question card has always said "回复 /回答 <id> <编号>" and the bridge has
  // always had respond(); the command was simply missing from the alias table,
  // so the reply parsed as an unknown slash command and the only possible
  // outcome was a 300s timeout that the model read as "the user skipped".
  const { ctx } = fakeCtx()
  const cfg = config()
  const channel = entry.apply(ctx, entry.Config(cfg))
  const sent = []
  channel.sendText = async (chatId, text) => { sent.push(text); return true }
  channel.bindings.allow('owner@im.wechat')

  const asked = []
  channel.questions.respond = (id, raw) => { asked.push({ id, raw }); return 'answered' }

  await channel.handleInbound({
    from_user_id: 'owner@im.wechat',
    message_id: 61,
    item_list: [{ type: 1, text_item: { text: '/回答 a1b2 1,3' } }],
  })
  assert.deepEqual(asked, [{ id: 'a1b2', raw: '1,3' }])
  assert.ok(sent.some((line) => /已回答 #a1b2/.test(line)))
  await channel.dispose()
  rmSync(cfg.stateDir, { recursive: true, force: true })
})

test('/回答 without an id lists what is waiting', { skip }, async () => {
  const { ctx } = fakeCtx()
  const cfg = config()
  const channel = entry.apply(ctx, entry.Config(cfg))
  const sent = []
  channel.sendText = async (chatId, text) => { sent.push(text); return true }
  channel.bindings.allow('owner@im.wechat')

  await channel.handleInbound({
    from_user_id: 'owner@im.wechat',
    message_id: 62,
    item_list: [{ type: 1, text_item: { text: '/回答' } }],
  })
  assert.ok(sent.some((line) => /用法：\/回答/.test(line)))
  await channel.dispose()
  rmSync(cfg.stateDir, { recursive: true, force: true })
})

test('the poller hands messages off instead of waiting for the turn', { skip }, async () => {
  // The long poll used to await handleInbound, so one long turn stopped the bot
  // from receiving anything at all: /停止 could not reach the turn it was meant
  // to interrupt, and a second chat's message waited behind the first.
  const { ctx } = fakeCtx()
  const cfg = config()
  const channel = entry.apply(ctx, entry.Config(cfg))

  const started = []
  const gates = []
  channel.handleInbound = (message) => {
    started.push(String(message.from_user_id))
    return new Promise((resolve) => { gates.push(resolve) })
  }

  const first = channel.acceptInbound({ from_user_id: 'a@im.wechat' })
  const second = channel.acceptInbound({ from_user_id: 'b@im.wechat' })

  assert.deepEqual(started, ['a@im.wechat', 'b@im.wechat'], 'both are admitted without waiting for either')
  assert.equal(channel.inflight.size, 2, 'work in flight is tracked for dispose')

  for (const gate of gates) gate('done')
  await Promise.all([first, second])
  assert.equal(channel.inflight.size, 0, 'finished work leaves the in-flight set')
  await channel.dispose()
  rmSync(cfg.stateDir, { recursive: true, force: true })
})

test('queueMax counts queued turns instead of always seeing one', { skip }, async () => {
  // queueDepth used to be "is there a queue at all", so turn.queueMax could
  // never be reached: the poller's own await guaranteed a single task per chat.
  const { ctx } = fakeCtx()
  const cfg = config({ turn: { timeoutMs: 900000, sendIntervalMs: 2000, queueMax: 1 } })
  const channel = entry.apply(ctx, entry.Config(cfg))
  const sent = []
  channel.sendText = async (chatId, text) => { sent.push(text); return true }
  channel.bindings.allow('owner@im.wechat')

  let release = null
  channel.runTurn = () => new Promise((resolve) => { release = resolve })

  const running = channel.dispatchTask('owner@im.wechat', { from_user_id: 'owner@im.wechat' }, '任务一')
  await new Promise((resolve) => setTimeout(resolve, 10))
  assert.equal(channel.queueDepth('owner@im.wechat'), 1, 'the running turn is counted')

  await channel.dispatchTask('owner@im.wechat', { from_user_id: 'owner@im.wechat' }, '任务二')
  assert.ok(sent.some((line) => /排队的任务已达上限/.test(line)), 'the cap is reachable now')

  release()
  await running
  await new Promise((resolve) => setTimeout(resolve, 10))
  assert.equal(channel.queueDepth('owner@im.wechat'), 0, 'the counter drops back to zero')
  await channel.dispose()
  rmSync(cfg.stateDir, { recursive: true, force: true })
})

test('a command answered mid-turn does not clear the running turn\'s indicator', { skip }, async () => {
  // Since the poller no longer waits for a turn, a /状态 can be answered while a
  // turn is still running. The command finishing must release only its own claim.
  const { ctx } = fakeCtx()
  const cfg = config()
  const channel = entry.apply(ctx, entry.Config(cfg))
  const statuses = []
  channel.account = () => ({ token: 'tk', baseUrl: 'https://ilinkai.weixin.qq.com/' })
  channel.api = {
    getConfig: async () => ({ typing_ticket: 'ticket-1' }),
    sendTyping: async (args) => { statuses.push(args.status) },
    notifyStop: async () => {},
  }

  await channel.showTyping('owner@im.wechat', 'ctx')
  await channel.showTyping('owner@im.wechat', 'ctx')
  assert.equal(channel.typingRefs.get('owner@im.wechat'), 2)

  channel.hideTyping('owner@im.wechat')
  assert.equal(statuses.filter((status) => status === 2).length, 0, 'the turn still holds the indicator')

  channel.hideTyping('owner@im.wechat')
  assert.equal(statuses.filter((status) => status === 2).length, 1, 'the last claim clears it')
  assert.equal(channel.typingRefs.has('owner@im.wechat'), false)
  await channel.dispose()
  rmSync(cfg.stateDir, { recursive: true, force: true })
})



test('an inbound photo is filed in the workspace and handed to the agent as a path', { skip }, async () => {
  // The channel cannot decode an image, and pretending otherwise produced a
  // model that answered from the caption alone. The prompt must therefore name
  // the real local path the file tools can open.
  const { ctx } = fakeCtx()
  const cfg = config()
  const channel = entry.apply(ctx, entry.Config(cfg))
  channel.bindings.allow('owner@im.wechat')
  channel.showTyping = async () => {}
  channel.hideTyping = () => {}

  const saved = []
  channel.saveInboundMedia = async (chatId, message, media) => {
    saved.push({ chatId, kind: media.kind, quoted: media.quoted })
    return {
      filePath: 'D:\\proj\\inbox\\2026-01-01-photo.jpg',
      fileName: '2026-01-01-photo.jpg',
      bytes: 2048,
      workspace: 'D:\\proj',
    }
  }
  const prompts = []
  channel.dispatchTask = async (chatId, message, text) => { prompts.push(text) }

  await channel.handleInbound({
    from_user_id: 'owner@im.wechat',
    message_id: 61,
    item_list: [{
      type: 2,
      image_item: { media: { encrypt_query_param: 'enc' }, aeskey: 'a2V5' },
      ref_msg: { title: '报价单' },
    }],
  })

  assert.deepEqual(saved, [{ chatId: 'owner@im.wechat', kind: 'image', quoted: '报价单' }])
  assert.equal(prompts.length, 1)
  assert.match(prompts[0], /D:\\proj\\inbox\\2026-01-01-photo\.jpg/)
  assert.match(prompts[0], /2\.0 KB/)
  assert.match(prompts[0], /引用的消息：报价单/)
  await channel.dispose()
  rmSync(cfg.stateDir, { recursive: true, force: true })
})

test('a stranger cannot make the Host download an attachment', { skip }, async () => {
  // The allowlist check used to run after the text extraction, which is also
  // where the download lives: anyone could trigger a 20 MB fetch.
  const { ctx } = fakeCtx()
  const cfg = config()
  const channel = entry.apply(ctx, entry.Config(cfg))
  const sent = []
  channel.sendText = async (chatId, text) => { sent.push(text); return true }
  let downloads = 0
  channel.saveInboundMedia = async () => { downloads += 1; return {} }

  await channel.handleInbound({
    from_user_id: 'stranger@im.wechat',
    message_id: 62,
    item_list: [{ type: 2, image_item: { media: { encrypt_query_param: 'enc' } } }],
  })

  assert.equal(downloads, 0, 'nothing is fetched before authorization')
  assert.ok(sent.some((line) => /未授权/.test(line)))
  await channel.dispose()
  rmSync(cfg.stateDir, { recursive: true, force: true })
})

test('a voice message without a transcript is refused, not downloaded', { skip }, async () => {
  const { ctx } = fakeCtx()
  const cfg = config()
  const channel = entry.apply(ctx, entry.Config(cfg))
  channel.bindings.allow('owner@im.wechat')
  const sent = []
  channel.sendText = async (chatId, text) => { sent.push(text); return true }
  channel.showTyping = async () => {}
  channel.hideTyping = () => {}
  let downloads = 0
  channel.saveInboundMedia = async () => { downloads += 1; return {} }

  await channel.handleInbound({
    from_user_id: 'owner@im.wechat',
    message_id: 63,
    item_list: [{ type: 3, voice_item: { media: { encrypt_query_param: 'enc' } } }],
  })

  assert.equal(downloads, 0, 'SILK audio is not something the agent can read')
  assert.ok(sent.some((line) => /没有转写文本/.test(line)))
  await channel.dispose()
  rmSync(cfg.stateDir, { recursive: true, force: true })
})

test('a plain-text reply keeps the quoted title in the prompt', { skip }, async () => {
  const { ctx } = fakeCtx()
  const cfg = config()
  const channel = entry.apply(ctx, entry.Config(cfg))
  channel.bindings.allow('owner@im.wechat')
  channel.showTyping = async () => {}
  channel.hideTyping = () => {}
  const prompts = []
  channel.dispatchTask = async (chatId, message, text) => { prompts.push(text) }

  await channel.handleInbound({
    from_user_id: 'owner@im.wechat',
    message_id: 64,
    item_list: [{
      type: 1,
      text_item: { text: '这个多少钱？' },
      ref_msg: { title: '价目表.pdf' },
    }],
  })

  assert.equal(prompts.length, 1)
  assert.match(prompts[0], /【引用】价目表\.pdf/)
  assert.match(prompts[0], /这个多少钱？/)
  await channel.dispose()
  rmSync(cfg.stateDir, { recursive: true, force: true })
})

test('the panel mutes and unmutes a chat through the same field as /静音', { skip }, async () => {
  const { ctx } = fakeCtx()
  const cfg = config()
  const channel = entry.apply(ctx, entry.Config(cfg))
  channel.bindings.ensure('owner@im.wechat')

  await channel.panelAction('chats.mute', { chatId: 'owner@im.wechat', muted: true })
  assert.equal(channel.bindings.ensure('owner@im.wechat').muted, true)
  await channel.panelAction('chats.mute', { chatId: 'owner@im.wechat', muted: false })
  assert.equal(channel.bindings.ensure('owner@im.wechat').muted, false)
  await assert.rejects(() => channel.panelAction('chats.mute', {}), /缺少 chatId/)
  await channel.dispose()
  rmSync(cfg.stateDir, { recursive: true, force: true })
})

test('a panel-saved agent preset is reported back and survives a restart', { skip }, async () => {
  const cfg = config()
  const { ctx: first } = fakeCtx()
  const channel = entry.apply(first, entry.Config(cfg))
  await channel.panelAction('defaults.set', { agentPreset: 'coding' })

  const view = await channel.panelAction('status', {})
  assert.equal(view.defaults.agentPreset, 'coding')
  assert.ok(Array.isArray(view.presets), 'the panel needs the catalog to render a picker')
  await channel.dispose()

  const { ctx: second } = fakeCtx()
  const restarted = entry.apply(second, entry.Config(cfg))
  assert.equal(restarted.cfg.defaults.agentPreset, 'coding')
  await restarted.dispose()
  rmSync(cfg.stateDir, { recursive: true, force: true })
})

test('an empty agent preset means "follow the deployment default"', { skip }, async () => {
  const { ctx } = fakeCtx()
  const cfg = config({ defaults: { agentPreset: 'coding' } })
  const channel = entry.apply(ctx, entry.Config(cfg))
  await channel.panelAction('defaults.set', { agentPreset: '' })
  assert.equal(channel.cfg.defaults.agentPreset, '')
  await channel.dispose()
  rmSync(cfg.stateDir, { recursive: true, force: true })
})

test('the push tool sends a file through the media path', { skip }, async () => {
  const { ctx, tools } = fakeCtx()
  const cfg = config()
  const channel = entry.apply(ctx, entry.Config(cfg))
  const calls = []
  channel.sendMedia = async (chatId, file, caption) => { calls.push({ chatId, file, caption }); return true }

  const result = await tools[0].execute({ to: 'chat-1', file: 'C:\\tmp\\a.png', text: '看这个' })
  assert.deepEqual(result, { sent: 1, failed: 0 })
  assert.deepEqual(calls, [{ chatId: 'chat-1', file: 'C:\\tmp\\a.png', caption: '看这个' }])
  await channel.dispose()
  rmSync(cfg.stateDir, { recursive: true, force: true })
})

test('the push tool refuses a call with neither text nor file', { skip }, async () => {
  const { ctx, tools } = fakeCtx()
  const cfg = config()
  const channel = entry.apply(ctx, entry.Config(cfg))
  await assert.rejects(() => tools[0].execute({ to: 'chat-1' }), /至少需要一个/)
  await channel.dispose()
  rmSync(cfg.stateDir, { recursive: true, force: true })
})
