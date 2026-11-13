import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { createBindSession } from '../lib/bind.js'
import { createILinkApi } from '../lib/ilink.js'

/** A scripted iLink server that walks the QR state machine. */
function scriptedApi(states) {
  let index = 0
  return createILinkApi({
    fetchImpl: async (url, init = {}) => {
      const parsed = new URL(String(url))
      const key = `${init.method ?? 'GET'} ${parsed.pathname}`
      if (key === 'POST /ilink/bot/get_bot_qrcode') {
        return new Response(JSON.stringify({
          qrcode: 'qr-1',
          qrcode_img_content: 'https://weixin.qq.com/qr/1',
        }), { status: 200 })
      }
      if (key === 'GET /ilink/bot/get_qrcode_status') {
        const state = states[Math.min(index, states.length - 1)]
        index += 1
        return new Response(JSON.stringify(state), { status: 200 })
      }
      return new Response('not found', { status: 404 })
    },
  })
}

function tempDir() {
  return mkdtempSync(path.join(tmpdir(), 'weixin-bind-'))
}

test('a confirmed login persists the account file', async () => {
  const dir = tempDir()
  const api = scriptedApi([{
    status: 'confirmed',
    bot_token: 'token-1',
    ilink_bot_id: 'wx_abc',
    account_id: 'acc@im.bot',
    ilink_user_id: 'owner@im.wechat',
    baseurl: 'https://ilinkai.weixin.qq.com/',
  }])
  const session = createBindSession({ api, stateDir: dir })
  await session.begin()
  await new Promise((resolve) => setTimeout(resolve, 50))
  const state = session.getState()
  assert.equal(state.phase, 'succeeded')
  assert.equal(session.readAccount().token, 'token-1')
  assert.equal(session.readAccount().botId, 'wx_abc')
  session.cancel()
  rmSync(dir, { recursive: true, force: true })
})

test('a confirmed login tells the Host to start polling', async () => {
  // The QR poller is the only place the Host learns a token now exists. It used
  // to depend on the panel calling `bind.poll`, which the browser never did, so
  // a freshly scanned account sat idle until DSH restarted.
  const dir = tempDir()
  const api = scriptedApi([{
    status: 'confirmed',
    bot_token: 'token-2',
    ilink_bot_id: 'wx_def',
    account_id: 'acc2@im.bot',
    ilink_user_id: 'owner@im.wechat',
  }])
  const bound = []
  const session = createBindSession({ api, stateDir: dir, onBound: (state) => bound.push(state.phase) })
  await session.begin()
  await new Promise((resolve) => setTimeout(resolve, 50))
  assert.equal(session.getState().phase, 'succeeded')
  assert.deepEqual(bound, ['succeeded'])
  session.cancel()
  rmSync(dir, { recursive: true, force: true })
})

test('an expired QR stops polling and reports it', async () => {
  const dir = tempDir()
  const api = scriptedApi([{ status: 'expired' }])
  const session = createBindSession({ api, stateDir: dir })
  await session.begin()
  await new Promise((resolve) => setTimeout(resolve, 50))
  assert.equal(session.getState().phase, 'expired')
  session.cancel()
  rmSync(dir, { recursive: true, force: true })
})

test('the pairing-code phase is surfaced before success', async () => {
  const dir = tempDir()
  const api = scriptedApi([
    { status: 'need_verifycode' },
    { status: 'confirmed', bot_token: 't', ilink_bot_id: 'wx_1', account_id: 'a', ilink_user_id: 'u' },
  ])
  const session = createBindSession({ api, stateDir: dir })
  await session.begin()
  await new Promise((resolve) => setTimeout(resolve, 40))
  assert.equal(session.getState().phase, 'need_verifycode')
  session.submitVerifyCode('1234')
  await new Promise((resolve) => setTimeout(resolve, 60))
  assert.equal(session.getState().phase, 'succeeded')
  session.cancel()
  rmSync(dir, { recursive: true, force: true })
})

test('the cursor round-trips through the state directory', () => {
  const dir = tempDir()
  const session = createBindSession({ api: scriptedApi([]), stateDir: dir })
  assert.equal(session.readCursor(), '')
  session.writeCursor('buf-1')
  assert.equal(session.readCursor(), 'buf-1')
  rmSync(dir, { recursive: true, force: true })
})

test('the bind session no longer mints codes', () => {
  // Authorization is the allowlist plus the pending-trust queue; a one-time
  // code was a second, parallel door into the same allowlist and is gone.
  const session = createBindSession({ api: scriptedApi([]), stateDir: tempDir() })
  assert.equal(session.issueCode, undefined)
  assert.equal(session.consume, undefined)
})
