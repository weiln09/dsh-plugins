// Tencent iLink bot protocol client (personal WeChat robot channel).
//
// The request shapes follow the MIT project Tencent/openclaw-weixin (2.4.6).
// Only `fetch` is used, so the module stays testable with an injected fetch
// implementation and pulls in no runtime dependency.
//
// Two hard rules keep the bot token from leaking:
//   - every endpoint must stay on `weixin.qq.com` (or a subdomain) over https;
//   - the token travels only as `Authorization: Bearer`, never in a URL.

import { randomBytes, randomUUID } from 'node:crypto'

export const DEFAULT_BASE_URL = 'https://ilinkai.weixin.qq.com/'
export const PROTOCOL_VERSION = '2.4.6'
export const DEFAULT_BOT_TYPE = '3'
export const LONG_POLL_TIMEOUT_MS = 35_000
export const REQUEST_TIMEOUT_MS = 15_000
/**
 * Conservative per-message text budget.
 *
 * iLink does not publish a maximum length; the community implementations all
 * settle on 2000 characters as the safe limit. A chunk over it can be rejected
 * outright, which looks exactly like lost text — so long answers are split at
 * this size rather than gambled on.
 */
export const MAX_TEXT_CHARS = 2_000

const ILINK_APP_ID = 'bot'
const ILINK_CLIENT_VERSION = (2 << 16) | (4 << 8) | 6
const BOT_AGENT = 'dsh-weixin-channel/1.x'

const LOGIN_PHASES = new Set([
  'wait', 'scaned', 'confirmed', 'expired', 'scaned_but_redirect',
  'need_verifycode', 'verify_code_blocked', 'binded_redirect',
])

export class ILinKError extends Error {
  constructor(code, message, options = {}) {
    super(message, options)
    this.name = 'ILinKError'
    this.code = code
    this.status = options.status
  }
}

function text(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : null
}

function isWeixinHost(hostname) {
  const host = String(hostname).toLowerCase().replace(/\.$/, '')
  return host === 'weixin.qq.com' || host.endsWith('.weixin.qq.com')
}

/**
 * Validate an API base URL: https, a `weixin.qq.com` host, and the default
 * port. Anything else is refused before a token can be attached.
 */
export function normalizeBaseUrl(value) {
  let url
  try {
    url = new URL(value)
  } catch {
    throw new ILinKError('invalid-base-url', '微信服务返回了无效的连接地址。')
  }
  if (url.protocol !== 'https:' || !isWeixinHost(url.hostname)
    || (url.port !== '' && url.port !== '443')) {
    throw new ILinKError('untrusted-base-url', '微信服务返回了不受信任的连接地址。')
  }
  url.username = ''
  url.password = ''
  url.search = ''
  url.hash = ''
  if (!url.pathname.endsWith('/')) url.pathname += '/'
  return url.toString()
}

/** Validate a QR image URL against the same host allowlist. */
export function normalizeQrUrl(value) {
  const raw = text(value)
  if (!raw) throw new ILinKError('invalid-qr', '微信服务没有返回扫码地址。')
  let url
  try {
    url = new URL(raw)
  } catch {
    throw new ILinKError('invalid-qr', '微信服务返回了无效的扫码地址。')
  }
  if (url.protocol !== 'https:' || !isWeixinHost(url.hostname)) {
    throw new ILinKError('untrusted-qr', '微信服务返回了不受信任的扫码地址。')
  }
  return url.toString()
}

function commonHeaders() {
  return {
    'iLink-App-Id': ILINK_APP_ID,
    'iLink-App-ClientVersion': String(ILINK_CLIENT_VERSION),
  }
}

function authenticatedHeaders(token) {
  const headers = {
    ...commonHeaders(),
    'content-type': 'application/json',
    AuthorizationType: 'ilink_bot_token',
    'X-WECHAT-UIN': Buffer.from(String(randomBytes(4).readUInt32BE(0)), 'utf8').toString('base64'),
  }
  const trimmed = text(token)
  if (trimmed) headers.Authorization = `Bearer ${trimmed}`
  return headers
}

function baseInfo() {
  return { channel_version: PROTOCOL_VERSION, bot_agent: BOT_AGENT }
}

async function requestJson(fetchImpl, {
  method, baseUrl, endpoint, body, token,
  timeoutMs = REQUEST_TIMEOUT_MS, signal, authenticated = true,
}) {
  const trusted = normalizeBaseUrl(baseUrl)
  const url = new URL(endpoint, trusted)
  if (!isWeixinHost(url.hostname)) {
    throw new ILinKError('untrusted-endpoint', '拒绝访问不受信任的微信服务地址。')
  }

  const controller = new AbortController()
  let timedOut = false
  const onAbort = () => controller.abort(signal?.reason)
  if (signal?.aborted) throw signal.reason ?? new DOMException('aborted', 'AbortError')
  signal?.addEventListener('abort', onAbort, { once: true })
  const timer = setTimeout(() => {
    timedOut = true
    controller.abort()
  }, timeoutMs)

  try {
    const response = await fetchImpl(url, {
      method,
      headers: authenticated ? authenticatedHeaders(token) : commonHeaders(),
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: controller.signal,
    })
    if (!response.ok) {
      throw new ILinKError('http-error', `微信服务请求失败（HTTP ${response.status}）。`, { status: response.status })
    }
    try {
      return await response.json()
    } catch (error) {
      throw new ILinKError('invalid-response', '微信服务返回了无法解析的响应。', { cause: error })
    }
  } catch (error) {
    if (signal?.aborted) throw signal.reason ?? error
    if (timedOut) throw new ILinKError('timeout', '微信服务请求超时。', { cause: error })
    if (error instanceof ILinKError) throw error
    throw new ILinKError('network-error', '暂时无法访问微信服务。', { cause: error })
  } finally {
    clearTimeout(timer)
    signal?.removeEventListener('abort', onAbort)
  }
}

/** Build the iLink client. `fetchImpl` is injectable for tests. */
export function createILinkApi({ fetchImpl = fetch } = {}) {
  if (typeof fetchImpl !== 'function') throw new TypeError('fetchImpl must be a function')

  return Object.freeze({
    /** Ask for a login QR code. */
    async beginLogin({ baseUrl = DEFAULT_BASE_URL, localTokens = [], botType = DEFAULT_BOT_TYPE, signal } = {}) {
      const tokens = [...new Set(localTokens.map(text).filter(Boolean))].slice(-10)
      const response = await requestJson(fetchImpl, {
        method: 'POST',
        baseUrl,
        endpoint: `ilink/bot/get_bot_qrcode?bot_type=${encodeURIComponent(botType)}`,
        body: { local_token_list: tokens },
        timeoutMs: 10_000,
        signal,
      })
      const qrcode = text(response?.qrcode)
      if (!qrcode) throw new ILinKError('invalid-qr', '微信服务没有返回二维码令牌。')
      return { qrcode, qrUrl: normalizeQrUrl(response.qrcode_img_content) }
    },

    /** Long-poll the login state; `confirmed` carries the bot credentials. */
    async pollLogin({ qrcode, baseUrl = DEFAULT_BASE_URL, verifyCode, signal }) {
      const code = text(qrcode)
      if (!code) throw new TypeError('qrcode is required')
      let endpoint = `ilink/bot/get_qrcode_status?qrcode=${encodeURIComponent(code)}`
      if (text(verifyCode)) endpoint += `&verify_code=${encodeURIComponent(String(verifyCode).trim())}`
      const response = await requestJson(fetchImpl, {
        method: 'GET',
        baseUrl,
        endpoint,
        timeoutMs: LONG_POLL_TIMEOUT_MS,
        signal,
        authenticated: false,
      })
      if (!response || typeof response !== 'object' || !LOGIN_PHASES.has(response.status)) {
        throw new ILinKError('invalid-login-status', '微信服务返回了无法识别的扫码状态。')
      }
      return response
    },

    /** Long-poll messages. A poll timeout is an empty batch, not an error. */
    async getUpdates({ baseUrl, token, buf = '', timeoutMs, signal }) {
      try {
        return await requestJson(fetchImpl, {
          method: 'POST',
          baseUrl,
          endpoint: 'ilink/bot/getupdates',
          body: { get_updates_buf: buf, base_info: baseInfo() },
          token,
          timeoutMs: timeoutMs ?? LONG_POLL_TIMEOUT_MS,
          signal,
        })
      } catch (error) {
        if (error instanceof ILinKError && error.code === 'timeout') {
          return { ret: 0, msgs: [], get_updates_buf: buf }
        }
        throw error
      }
    },

    /** Send one text message, optionally threading the inbound context token. */
    async sendText({ baseUrl, token, toUserId, text: body, contextToken, signal }) {
      const content = text(body)
      if (!content) throw new TypeError('toUserId and text are required')
      return this.sendItems({
        baseUrl,
        token,
        toUserId,
        itemList: [{ type: 1, text_item: { text: content } }],
        contextToken,
        signal,
      })
    },

    /**
     * Send one message built from an explicit `item_list`.
     *
     * Text is the common case and `sendText` covers it, but a media message is
     * exactly the same request with a different item — an image/file/video item
     * carrying a CDN reference instead of a `text_item`.
     */
    async sendItems({ baseUrl, token, toUserId, itemList, contextToken, signal }) {
      const recipient = text(toUserId)
      if (!recipient) throw new TypeError('toUserId is required')
      if (!Array.isArray(itemList) || !itemList.length) throw new TypeError('itemList is required')
      const response = await requestJson(fetchImpl, {
        method: 'POST',
        baseUrl,
        endpoint: 'ilink/bot/sendmessage',
        token,
        signal,
        body: {
          msg: {
            from_user_id: '',
            to_user_id: recipient,
            client_id: `dsh-weixin-channel-${randomUUID()}`,
            message_type: 2,
            message_state: 2,
            item_list: itemList,
            ...(text(contextToken) ? { context_token: String(contextToken).trim() } : {}),
          },
          base_info: baseInfo(),
        },
      })
      if (response?.ret !== undefined && response.ret !== 0) {
        throw new ILinKError('send-rejected', `微信服务拒绝了回复消息（ret=${response.ret}）。`)
      }
      return true
    },

    /**
     * Ask where to upload one media payload.
     *
     * The four numbers are not optional bookkeeping: the CDN verifies the
     * ciphertext against `filesize` (plaintext length rounded up to the next
     * AES block) and the plaintext against `rawfilemd5`. A mismatch comes back
     * as `400 -5104001` with no explanation.
     */
    async getUploadUrl({
      baseUrl, token, toUserId, filekey, mediaType, rawsize, rawfilemd5, filesize, aeskey, signal,
    }) {
      const recipient = text(toUserId)
      if (!recipient) throw new TypeError('toUserId is required')
      return requestJson(fetchImpl, {
        method: 'POST',
        baseUrl,
        endpoint: 'ilink/bot/getuploadurl',
        token,
        signal,
        body: {
          filekey,
          media_type: mediaType,
          to_user_id: recipient,
          rawsize,
          rawfilemd5,
          filesize,
          no_need_thumb: true,
          aeskey,
          base_info: baseInfo(),
        },
      })
    },

    /** Read the per-user typing ticket. */
    async getConfig({ baseUrl, token, ilinkUserId, contextToken, signal }) {
      return requestJson(fetchImpl, {
        method: 'POST',
        baseUrl,
        endpoint: 'ilink/bot/getconfig',
        token,
        signal,
        body: {
          ilink_user_id: ilinkUserId,
          ...(text(contextToken) ? { context_token: String(contextToken).trim() } : {}),
          base_info: baseInfo(),
        },
      })
    },

    /**
     * Show or clear the "typing" indicator. `status`: 1 start, 2 stop.
     *
     * The wire field is `ilink_user_id`, not `to_user_id`, and the flag is
     * `status`, not `typing_status`. Sending the wrong names is accepted by the
     * HTTP layer and silently does nothing, which is exactly how "微信端看不到
     * 正在输入" looked: the request went out and the indicator never appeared.
     */
    async sendTyping({ baseUrl, token, to, typingTicket, status, signal }) {
      const response = await requestJson(fetchImpl, {
        method: 'POST',
        baseUrl,
        endpoint: 'ilink/bot/sendtyping',
        token,
        signal,
        body: {
          ilink_user_id: to,
          status,
          ...(text(typingTicket) ? { typing_ticket: typingTicket } : {}),
          base_info: baseInfo(),
        },
      })
      if (response?.ret !== undefined && response.ret !== 0) {
        throw new ILinKError('typing-rejected', `微信服务拒绝了输入状态（ret=${response.ret}）。`)
      }
      return response
    },

    /** Announce that this bot starts pushing; required before polling. */
    async notifyStart({ baseUrl, token, signal }) {
      const response = await requestJson(fetchImpl, {
        method: 'POST',
        baseUrl,
        endpoint: 'ilink/bot/msg/notifystart',
        token,
        timeoutMs: 10_000,
        signal,
        body: { base_info: baseInfo() },
      })
      if (response?.ret !== undefined && response.ret !== 0) {
        throw new ILinKError('start-rejected', `微信账号连接启动失败（ret=${response.ret}）。`)
      }
      return response
    },

    /** Announce shutdown; best effort. */
    async notifyStop({ baseUrl, token, signal }) {
      return requestJson(fetchImpl, {
        method: 'POST',
        baseUrl,
        endpoint: 'ilink/bot/msg/notifystop',
        token,
        timeoutMs: 10_000,
        signal,
        body: { base_info: baseInfo() },
      })
    },
  })
}

/** Extract plain text (or the server-side voice transcription) from one message. */
export function extractText(message) {
  for (const item of message?.item_list ?? []) {
    if (item?.type === 1 && typeof item.text_item?.text === 'string') {
      const value = item.text_item.text.trim()
      if (value) return value
    }
    if (item?.type === 3 && typeof item.voice_item?.text === 'string') {
      const value = item.voice_item.text.trim()
      if (value) return value
    }
  }
  return ''
}

/** Stable dedupe key for one inbound message. */
export function messageId(message) {
  if (message?.message_id !== undefined && message?.message_id !== null) return String(message.message_id)
  return text(message?.client_id)
}

/** The sender is a real person, not the platform or this bot itself. */
export function isHumanSender(message) {
  const from = text(message?.from_user_id)
  return Boolean(from) && from !== 'wxid_ilinkbot'
}

/**
 * Split long text into WeChat-sized chunks. Breaks prefer a newline, then a
 * code-fence boundary, and never split a UTF-16 surrogate pair.
 */
export function splitText(input, maxChars = MAX_TEXT_CHARS) {
  const limit = Math.max(1, Math.floor(maxChars || MAX_TEXT_CHARS))
  const out = []
  let rest = String(input ?? '')
  while (rest.length > limit) {
    let cut = rest.lastIndexOf('\n', limit)
    if (cut < Math.floor(limit * 0.5)) cut = rest.lastIndexOf('```', limit) > 0 ? rest.lastIndexOf('```', limit) : limit
    if (cut <= 0) cut = limit
    if (cut > 0 && cut < rest.length) {
      const before = rest.charCodeAt(cut - 1)
      const after = rest.charCodeAt(cut)
      if (before >= 0xd800 && before <= 0xdbff && after >= 0xdc00 && after <= 0xdfff) {
        cut = cut - 1 > 0 ? cut - 1 : cut + 1
      }
    }
    out.push(rest.slice(0, cut))
    rest = rest.slice(cut).replace(/^\n+/, '')
  }
  if (rest) out.push(rest)
  return out
}
