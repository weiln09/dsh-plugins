// QR binding and the small account/cursor files.
//
// Binding has two independent halves:
//   1. the bot account — scan a QR with WeChat, which yields `bot_token` etc.;
//   2. the chat — the first message from an allowed user, or an entry added
//      under 授权 in the panel / `/信任` from an admin chat.
//
// The QR state machine is polled by the browser; the poll call itself drives
// the login loop one step at a time so no timer outlives the panel.

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'

import { normalizeBaseUrl } from './ilink.js'

const require = createRequire(import.meta.url)

const ACCOUNT_FILE = 'account.json'
const CURSOR_FILE = 'cursor.json'

/**
 * Render a QR URL as a PNG data URL for the settings tab.
 * A missing `qrcode` dependency degrades to `''`, and the tab then shows the
 * raw URL instead of failing the whole binding flow.
 */
function qrDataUrl(url) {
  try {
    const QRCode = require('qrcode')
    return QRCode.toDataURL(url, { errorCorrectionLevel: 'M', margin: 1, width: 260, type: 'image/png' })
  } catch {
    return Promise.resolve('')
  }
}

function readJson(file, fallback) {
  try {
    return JSON.parse(readFileSync(file, 'utf8'))
  } catch {
    return fallback
  }
}

function writeJson(file, value) {
  mkdirSync(path.dirname(file), { recursive: true })
  writeFileSync(file, JSON.stringify(value, null, 2), { mode: 0o600 })
}

/**
 * Owns the account credential file, the long-poll cursor, and the QR state
 * machine. Chat authorization lives in bindings.json, not here.
 */
export function createBindSession({ api, stateDir, onBound }) {
  const accountFile = path.join(stateDir, ACCOUNT_FILE)
  const cursorFile = path.join(stateDir, CURSOR_FILE)

  let state = { phase: 'idle' }
  let qrcode = ''
  let baseUrl = ''
  let verifyCode = ''
  let pollTimer = null

  function setState(next) {
    state = next
    return state
  }

  function stopPolling() {
    if (pollTimer) {
      clearInterval(pollTimer)
      pollTimer = null
    }
  }

  function persistAccount(payload) {
    writeJson(accountFile, {
      version: 1,
      botId: payload.ilink_bot_id ?? payload.bot_id ?? '',
      accountId: payload.account_id ?? payload.ilink_bot_id ?? '',
      ownerUserId: payload.ilink_user_id ?? '',
      baseUrl: baseUrl || 'https://ilinkai.weixin.qq.com/',
      token: payload.bot_token ?? '',
      boundAt: Date.now(),
    })
  }

  return {
    getState() {
      return { ...state }
    },

    /** Read the stored bot account (token included; never sent to a browser). */
    readAccount() {
      const stored = readJson(accountFile, null)
      if (!stored?.token) return null
      return stored
    },

    /** Read the persisted long-poll cursor. */
    readCursor() {
      const stored = readJson(cursorFile, null)
      return typeof stored?.buf === 'string' ? stored.buf : ''
    },

    /** Persist the long-poll cursor. */
    writeCursor(buf) {
      try {
        writeJson(cursorFile, { buf, savedAt: Date.now() })
      } catch {
        // A read-only state directory must not break message handling.
      }
    },

    /** Start a QR login: fetch the code, then poll until confirmed or expired. */
    async begin() {
      stopPolling()
      setState({ phase: 'starting' })
      try {
        const localTokens = [this.readAccount()?.token].filter(Boolean)
        const started = await api.beginLogin({ localTokens })
        qrcode = started.qrcode
        baseUrl = ''
        verifyCode = ''
        const image = await qrDataUrl(started.qrUrl)
        setState({ phase: 'qr', qrDataUrl: image, qrUrl: image ? '' : started.qrUrl, message: '请用手机微信扫码' })
        pollTimer = setInterval(() => { void this.pollOnce() }, 1500)
        if (typeof pollTimer?.unref === 'function') pollTimer.unref()
        void this.pollOnce()
        return this.getState()
      } catch (error) {
        return setState({ phase: 'error', message: String(error?.message ?? error) })
      }
    },

    /** One poll step; the browser calls `bind.poll` to read the result. */
    async pollOnce() {
      if (!qrcode) return this.getState()
      try {
        const result = await api.pollLogin({ qrcode, baseUrl: baseUrl || undefined, verifyCode })
        const status = result?.status
        if (status === 'scaned') return setState({ phase: 'scanned', qrDataUrl: state.qrDataUrl, qrUrl: state.qrUrl, message: '已扫码，请在手机上确认' })
        if (status === 'need_verifycode') {
          return setState({ phase: 'need_verifycode', qrDataUrl: state.qrDataUrl, qrUrl: state.qrUrl, message: '请输入手机显示的配对数字' })
        }
        if (status === 'confirmed') {
          stopPolling()
          if (result.baseurl) {
            try {
              baseUrl = normalizeBaseUrl(result.baseurl)
            } catch {
              baseUrl = ''
            }
          }
          persistAccount(result)
          const done = setState({
            phase: 'succeeded',
            message: '绑定成功',
            accountId: result.account_id ?? result.ilink_bot_id ?? '',
            botId: result.ilink_bot_id ?? '',
          })
          // The account file changed, so the running channel must start
          // polling it NOW. This used to hang off the panel's `bind.poll`
          // call, which the browser never made: scanning produced a working
          // token and a channel that received nothing until a restart.
          if (typeof onBound === 'function') {
            try {
              onBound(done)
            } catch {
              // A failed reconnect is reported by the channel's own status.
            }
          }
          return done
        }
        if (status === 'expired' || status === 'verify_code_blocked') {
          stopPolling()
          return setState({ phase: 'expired', message: '二维码已过期，请重新生成' })
        }
        return state
      } catch (error) {
        return setState({ ...state, message: String(error?.message ?? error) })
      }
    },

    /** Feed the pairing digits shown on the phone. */
    submitVerifyCode(code) {
      verifyCode = String(code ?? '').trim()
      void this.pollOnce()
      return { ok: true }
    },

    /** Abandon the current login attempt. */
    cancel() {
      stopPolling()
      qrcode = ''
      return setState({ phase: 'cancelled', message: '已取消' })
    },
  }
}
