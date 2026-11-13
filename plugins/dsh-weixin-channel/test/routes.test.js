import assert from 'node:assert/strict'
import test from 'node:test'

import { installRoutes, publicBinding, redactBind } from '../lib/routes.js'

test('a binding is projected without its session map', () => {
  const view = publicBinding({
    chatId: 'chat-1',
    chatType: 'private',
    activeWorkspace: 'D:\\a',
    sessions: { 'D:\\a': 'session-a', 'D:\\b': 'session-b' },
    model: { provider: 'p', model: 'm' },
    permissionPreset: 'workspace-write',
    planMode: true,
    replyGranularity: 'standard',
    muted: false,
    createdAt: 1,
    lastActivityAt: 2,
  })
  assert.equal(view.sessionId, 'session-a')
  assert.equal(view.sessionCount, 2)
  assert.equal(view.model, 'p/m')
  assert.equal('sessions' in view, false, 'the raw map must not leak')
})

test('the bind state is whitelisted, never echoed wholesale', () => {
  const view = redactBind({
    phase: 'qr',
    qrDataUrl: 'data:image/png;base64,AAA',
    token: 'secret',
    internal: { nested: true },
  })
  assert.equal(view.phase, 'qr')
  assert.equal(view.qrDataUrl, 'data:image/png;base64,AAA')
  assert.equal('token' in view, false)
  assert.equal('internal' in view, false)
})

test('an idle bind state is minimal', () => {
  assert.deepEqual(redactBind(undefined), { phase: 'idle' })
})

test('the sidebar mark can ask which sessions this channel owns', async () => {
  // The row seat receives only a sessionId, so the client asks the Host which
  // listed ids are WeChat-created. Unrelated ids must be filtered out, and an
  // unknown or empty id must never be reported as ours.
  const { WeixinChannel } = await import('../lib/index.js').catch(() => ({}))
  if (!WeixinChannel) return // peer dependency (schemastery) absent in a bare checkout

  const channel = Object.create(WeixinChannel.prototype)
  channel.bindings = {
    list: () => [
      { chatId: 'chat-1', sessions: { 'D:/a': 'session-a', 'D:/b': 'session-b' } },
      { chatId: 'chat-2', sessions: { 'D:/c': 'session-c' } },
      { chatId: 'chat-3', sessions: {} },
    ],
  }

  assert.deepEqual(
    channel.wechatSessions(['session-a', 'session-z', 'session-c', '']),
    ['session-a', 'session-c'],
  )
  assert.deepEqual(channel.wechatSessions([]), [], 'an empty ask is an empty answer')
  assert.deepEqual(channel.wechatSessions(undefined), [], 'a missing ask must not throw')
})

test('routes install nothing without a web server', () => {
  const dispose = installRoutes({}, { handle: async () => ({}) })
  assert.equal(typeof dispose, 'function')
  dispose()
})

function install(handle = async (action) => ({ echoed: action })) {
  let registered = null
  installRoutes({
    webServer: { register(route) { registered = route; return () => {} } },
  }, { handle })
  return registered
}

test('the route answers a JSON envelope and rejects a missing action', async () => {
  const registered = install()
  assert.equal(registered.kind, 'prefix')
  assert.equal(registered.path, '/weixin-channel/api')

  const response = makeResponse()
  await registered.handler({ method: 'GET', url: '/weixin-channel/api?action=status' }, response)
  assert.equal(response.statusCode, 200)
  assert.deepEqual(JSON.parse(response.body), { ok: true, value: { echoed: 'status' } })

  const bad = makeResponse()
  await registered.handler({ method: 'GET', url: '/weixin-channel/api' }, bad)
  assert.equal(bad.statusCode, 400)
})

test('a GET cannot change state', async () => {
  // Trusting a user, unbinding a chat, rewriting a default and starting a QR
  // login are writes. Answering them from a query string let any local process
  // — or any page able to load a URL — drive the channel with no credentials.
  const seen = []
  const registered = install(async (action) => { seen.push(action); return { ok: true } })

  const response = makeResponse()
  await registered.handler({ method: 'GET', url: '/weixin-channel/api?action=trust.add&userId=x' }, response)
  assert.equal(response.statusCode, 405)
  assert.match(JSON.parse(response.body).error, /需要 POST/)
  assert.deepEqual(seen, [], 'the action never ran')

  // The read-only ones still answer a GET, because the sidebar mark uses it.
  const mark = makeResponse()
  await registered.handler({ method: 'GET', url: '/weixin-channel/api?action=sessions.wechat' }, mark)
  assert.equal(mark.statusCode, 200)
})

test('a cross-origin request is refused', async () => {
  const registered = install()
  const response = makeResponse()
  await registered.handler({
    method: 'POST',
    url: '/weixin-channel/api',
    headers: { origin: 'https://evil.example', host: '127.0.0.1:1', 'content-type': 'application/json' },
  }, response)
  assert.equal(response.statusCode, 403)

  // Same-origin and non-browser clients (no Origin) are still served.
  const same = makeResponse()
  await registered.handler({
    method: 'POST',
    url: '/weixin-channel/api',
    headers: { origin: 'http://127.0.0.1:1', host: '127.0.0.1:1', 'content-type': 'application/json' },
    async *[Symbol.asyncIterator]() { yield Buffer.from(JSON.stringify({ action: 'status' })) },
  }, same)
  assert.equal(same.statusCode, 200)
})

test('a POST must declare JSON so a cross-origin form cannot reach it', async () => {
  // A form can only send urlencoded, multipart, or text/plain; demanding JSON
  // forces a preflight this server never answers.
  const registered = install()
  const response = makeResponse()
  await registered.handler({
    method: 'POST',
    url: '/weixin-channel/api',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    async *[Symbol.asyncIterator]() { yield Buffer.from('action=trust.add&userId=x') },
  }, response)
  assert.equal(response.statusCode, 415)
})

test('an unsupported method is rejected', async () => {
  const registered = install()
  const response = makeResponse()
  await registered.handler({ method: 'DELETE', url: '/weixin-channel/api?action=status' }, response)
  assert.equal(response.statusCode, 405)
})

function makeResponse() {
  return {
    statusCode: 200,
    headers: {},
    body: '',
    setHeader(name, value) { this.headers[name] = value },
    end(chunk) { this.body = chunk ?? '' },
  }
}
