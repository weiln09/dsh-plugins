import assert from 'node:assert/strict'
import test from 'node:test'

import { ILinKError, createILinkApi, extractText, splitText } from '../lib/ilink.js'

/** A fake iLink server: records requests, replies from a scripted table. */
function fakeFetch(routes) {
  const calls = []
  const impl = async (url, init = {}) => {
    const parsed = new URL(String(url))
    const key = `${init.method ?? 'GET'} ${parsed.pathname}`
    calls.push({ key, url: parsed, init })
    const handler = routes[key]
    if (!handler) return new Response('not found', { status: 404 })
    const body = init.body ? JSON.parse(init.body) : undefined
    return handler({ url: parsed, body, init })
  }
  return { impl, calls }
}

function json(value, status = 200) {
  return new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } })
}

test('login returns a validated QR url', async () => {
  const { impl } = fakeFetch({
    'POST /ilink/bot/get_bot_qrcode': () => json({
      qrcode: 'qr-token',
      qrcode_img_content: 'https://weixin.qq.com/x/y?z=1',
    }),
  })
  const api = createILinkApi({ fetchImpl: impl })
  const started = await api.beginLogin()
  assert.equal(started.qrcode, 'qr-token')
  assert.match(started.qrUrl, /^https:\/\/weixin\.qq\.com\//)
})

test('an untrusted QR host is refused', async () => {
  const { impl } = fakeFetch({
    'POST /ilink/bot/get_bot_qrcode': () => json({
      qrcode: 'qr-token',
      qrcode_img_content: 'https://evil.example.com/qr',
    }),
  })
  const api = createILinkApi({ fetchImpl: impl })
  await assert.rejects(api.beginLogin(), (error) => error instanceof ILinKError && error.code === 'untrusted-qr')
})

test('the token travels only as a bearer header, never in the URL', async () => {
  const { impl, calls } = fakeFetch({
    'POST /ilink/bot/getupdates': () => json({ ret: 0, msgs: [], get_updates_buf: 'next' }),
  })
  const api = createILinkApi({ fetchImpl: impl })
  await api.getUpdates({ baseUrl: 'https://ilinkai.weixin.qq.com/', token: 'secret-token', buf: '' })
  const call = calls[0]
  assert.equal(call.init.headers.Authorization, 'Bearer secret-token')
  assert.ok(!call.url.toString().includes('secret-token'))
})

test('a poll timeout becomes an empty batch, not an error', async () => {
  const { impl } = fakeFetch({
    // Hang until the client's own timeout aborts the request, which is what a
    // real long poll looks like when the server has nothing to deliver.
    'POST /ilink/bot/getupdates': ({ init }) => new Promise((_resolve, reject) => {
      init.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), { once: true })
    }),
  })
  const api = createILinkApi({ fetchImpl: impl })
  const result = await api.getUpdates({
    baseUrl: 'https://ilinkai.weixin.qq.com/', token: 't', buf: 'buf', timeoutMs: 10,
  })
  assert.deepEqual(result.msgs, [])
  assert.equal(result.get_updates_buf, 'buf')
})

test('a rejected send surfaces the platform return code', async () => {
  const { impl } = fakeFetch({
    'POST /ilink/bot/sendmessage': () => json({ ret: -2 }),
  })
  const api = createILinkApi({ fetchImpl: impl })
  await assert.rejects(
    api.sendText({ baseUrl: 'https://ilinkai.weixin.qq.com/', token: 't', toUserId: 'u', text: 'hi' }),
    (error) => error.code === 'send-rejected',
  )
})

test('an outbound message carries the inbound context token', async () => {
  let captured = null
  const { impl } = fakeFetch({
    'POST /ilink/bot/sendmessage': ({ body }) => {
      captured = body
      return json({ ret: 0 })
    },
  })
  const api = createILinkApi({ fetchImpl: impl })
  await api.sendText({
    baseUrl: 'https://ilinkai.weixin.qq.com/', token: 't',
    toUserId: 'u', text: 'hello', contextToken: 'ctx-1',
  })
  assert.equal(captured.msg.context_token, 'ctx-1')
  assert.equal(captured.msg.item_list[0].text_item.text, 'hello')
  assert.match(captured.msg.client_id, /^dsh-weixin-channel-/)
})

test('a non-zero notifystart return code is an error', async () => {
  const { impl } = fakeFetch({
    'POST /ilink/bot/msg/notifystart': () => json({ ret: 7 }),
  })
  const api = createILinkApi({ fetchImpl: impl })
  await assert.rejects(api.notifyStart({ baseUrl: 'https://ilinkai.weixin.qq.com/', token: 't' }), (error) => error.code === 'start-rejected')
})

test('an unrecognized login status is rejected', async () => {
  const { impl } = fakeFetch({
    'GET /ilink/bot/get_qrcode_status': () => json({ status: 'weird' }),
  })
  const api = createILinkApi({ fetchImpl: impl })
  await assert.rejects(api.pollLogin({ qrcode: 'q' }), (error) => error.code === 'invalid-login-status')
})

test('a base url outside weixin.qq.com is refused before any request', async () => {
  const { impl, calls } = fakeFetch({})
  const api = createILinkApi({ fetchImpl: impl })
  await assert.rejects(
    api.getUpdates({ baseUrl: 'https://evil.example.com/', token: 't' }),
    (error) => error.code === 'untrusted-base-url',
  )
  assert.equal(calls.length, 0)
})

test('text extraction covers text, voice and neither', () => {
  assert.equal(extractText({ item_list: [{ type: 1, text_item: { text: '你好' } }] }), '你好')
  assert.equal(extractText({ item_list: [{ type: 3, voice_item: { text: '语音转写' } }] }), '语音转写')
  assert.equal(extractText({ item_list: [{ type: 2, image_item: {} }] }), '')
})

test('splitting keeps every character exactly once', () => {
  const body = 'a'.repeat(9_000)
  const chunks = splitText(body, 2_000)
  assert.equal(chunks.join(''), body)
  for (const chunk of chunks) assert.ok(chunk.length <= 2_000)
})
