// Media (image / file / video) transfer for the Weixin channel.
//
// iLink never carries the bytes inside the JSON message: a media item is a CDN
// reference plus an AES-128-ECB key, and the payload lives on
// `novac2c.cdn.weixin.qq.com`. Receiving therefore means "download the
// ciphertext, decrypt it locally, hand the agent a real file path"; sending is
// the same three steps in reverse (getuploadurl → encrypt → POST to the CDN).
//
// Two details are easy to get wrong and both are handled here:
//   - the AES key has two encodings in the wild (base64 of the raw 16 bytes,
//     and base64 of the 32-character hex string), see `decodeAesKey`;
//   - the CDN host is NOT the API host, so the trust check has to accept
//     `*.cdn.weixin.qq.com` while still refusing everything else.

import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto'

export const CDN_BASE_URL = 'https://novac2c.cdn.weixin.qq.com/c2c'
/** Refuse to buffer a bigger download than this; a phone video is not a task. */
export const MAX_MEDIA_BYTES = 20 * 1024 * 1024

/** `MessageItem.type` → our kind. (1 = TEXT, which is not media.) */
const KIND_BY_ITEM_TYPE = { 2: 'image', 3: 'voice', 4: 'file', 5: 'video' }
/** `getuploadurl.media_type` for each kind. */
const UPLOAD_TYPE_BY_KIND = { image: 1, video: 2, file: 3, voice: 4 }
/** `MessageItem.type` used when sending each kind. */
const ITEM_TYPE_BY_KIND = { image: 2, video: 5, file: 4, voice: 3 }

const EXTENSION_BY_KIND = { image: '.jpg', video: '.mp4', file: '.bin', voice: '.silk' }

/** Only the WeChat CDN may receive a download or an upload. */
export function isWeixinCdnHost(hostname) {
  const host = String(hostname ?? '').toLowerCase().replace(/\.$/, '')
  return host === 'weixin.qq.com' || host.endsWith('.weixin.qq.com')
}

/**
 * Decode a media AES key.
 *
 * Two encodings are in circulation for the same 16 bytes:
 *   A. base64(raw 16 bytes)        → decodes to 16 bytes, use as-is
 *   B. base64(32 hex characters)   → decodes to 32 ASCII bytes, hex-decode again
 * `image_item.aeskey` may also arrive as a bare 32-character hex string. The
 * official sender always uses B for outbound media, so a receiver that only
 * understands A decrypts to garbage instead of failing loudly.
 */
export function decodeAesKey(media, itemAeskey) {
  const candidates = []
  if (typeof itemAeskey === 'string' && itemAeskey.trim()) candidates.push(itemAeskey.trim())
  if (typeof media?.aes_key === 'string' && media.aes_key.trim()) candidates.push(media.aes_key.trim())
  for (const candidate of candidates) {
    const raw = Buffer.from(candidate, 'base64')
    if (raw.length === 16) return raw
    if (raw.length === 32 && /^[0-9a-fA-F]{32}$/.test(raw.toString('utf8'))) {
      return Buffer.from(raw.toString('utf8'), 'hex')
    }
    if (/^[0-9a-fA-F]{32}$/.test(candidate)) return Buffer.from(candidate, 'hex')
  }
  return null
}

/** AES-128-ECB + PKCS7, the only cipher iLink media uses. */
export function decryptEcb(ciphertext, key) {
  if (!Buffer.isBuffer(key) || key.length !== 16) throw new Error('AES key must be 16 bytes')
  const decipher = createDecipheriv('aes-128-ecb', key, null)
  try {
    return Buffer.concat([decipher.update(ciphertext), decipher.final()])
  } catch {
    // Some payloads arrive already aligned with no padding block; retrying
    // without auto-padding recovers them instead of losing the file.
    const raw = createDecipheriv('aes-128-ecb', key, null)
    raw.setAutoPadding(false)
    return Buffer.concat([raw.update(ciphertext), raw.final()])
  }
}

export function encryptEcb(plaintext, key) {
  if (!Buffer.isBuffer(key) || key.length !== 16) throw new Error('AES key must be 16 bytes')
  const cipher = createCipheriv('aes-128-ecb', key, null)
  return Buffer.concat([cipher.update(plaintext), cipher.final()])
}

/** Ciphertext size for a plaintext of `size` bytes (PKCS7 always pads). */
export function encryptedSize(size) {
  return Math.ceil((Number(size) + 1) / 16) * 16
}

/** Make an inbound filename safe to join onto a directory. */
export function sanitizeFileName(name, fallback = 'file') {
  const base = String(name ?? '').split(/[\\/]/).pop() ?? ''
  const cleaned = base
    .replace(/[\u0000-\u001f<>:"|?*]/g, '_')
    .replace(/^\.+/, '')
    .trim()
  const safe = cleaned || fallback
  return safe.length > 120 ? safe.slice(safe.length - 120) : safe
}

/**
 * Describe the media in one inbound message, or null when there is none.
 *
 * Voice is reported too, because a voice message with no server transcription
 * is still worth telling the user about — but its payload is SILK, which is
 * not something an agent can read, so the caller may refuse it.
 */
export function extractMedia(message) {
  for (const item of message?.item_list ?? []) {
    const kind = KIND_BY_ITEM_TYPE[item?.type]
    if (!kind) continue
    const body = item[`${kind}_item`]
    if (!body) continue
    const media = body.media ?? null
    const aeskey = body.aeskey ?? ''
    const fileName = kind === 'file'
      ? sanitizeFileName(body.file_name, 'file.bin')
      : `${kind}-${Date.now()}${EXTENSION_BY_KIND[kind] ?? '.bin'}`
    return {
      kind,
      itemType: item.type,
      media,
      aeskey,
      fileName,
      // `len` is a string on file items; the others report ciphertext sizes.
      size: Number(body.len ?? body.video_size ?? body.mid_size ?? 0) || 0,
      url: typeof body.url === 'string' ? body.url : '',
      quoted: quotedTitle(item),
    }
  }
  return null
}

/** The quoted message's summary, when this item replies to one. */
export function quotedTitle(item) {
  const title = item?.ref_msg?.title
  return typeof title === 'string' && title.trim() ? title.trim() : ''
}

/**
 * The quoted message's summary for a whole message, whatever kind it is.
 *
 * "Reply to a message, then ask about it" is how people use WeChat, and the
 * quote lives on the item rather than in the text — so a plain-text question
 * that quotes a photo arrived with no trace of the photo at all.
 */
export function quotedFromMessage(message) {
  for (const item of message?.item_list ?? []) {
    const title = quotedTitle(item)
    if (title) return title
  }
  return ''
}

/**
 * Download and decrypt one media item.
 *
 * Returns the plaintext buffer. A missing AES key is not fatal: the spec
 * allows a plaintext download in that case, and a plaintext payload that
 * happens to decrypt is caught by the padding retry in `decryptEcb`.
 */
export async function downloadMedia({
  fetchImpl = fetch, media, aeskey, maxBytes = MAX_MEDIA_BYTES, signal,
} = {}) {
  const param = typeof media?.encrypt_query_param === 'string' ? media.encrypt_query_param.trim() : ''
  if (!param) throw new Error('这条消息没有可下载的媒体引用。')
  const url = new URL(`${CDN_BASE_URL}/download`)
  if (!isWeixinCdnHost(url.hostname)) throw new Error('拒绝访问不受信任的媒体地址。')
  url.searchParams.set('encrypted_query_param', param)

  const response = await fetchImpl(url, { method: 'GET', signal })
  if (!response.ok) throw new Error(`媒体下载失败（HTTP ${response.status}）。`)
  const declared = Number(response.headers?.get?.('content-length') ?? 0)
  if (declared > maxBytes) throw new Error(`媒体文件过大（${declared} 字节，上限 ${maxBytes}）。`)
  const ciphertext = Buffer.from(await response.arrayBuffer())
  if (ciphertext.length > maxBytes) throw new Error(`媒体文件过大（${ciphertext.length} 字节，上限 ${maxBytes}）。`)

  const key = decodeAesKey(media, aeskey)
  if (!key) return ciphertext
  return decryptEcb(ciphertext, key)
}

/**
 * POST the ciphertext to the CDN and return the reference the message carries.
 *
 * `getuploadurl` answers either with a complete `upload_full_url` (preferred —
 * it already carries every query parameter the CDN wants) or with a bare
 * `upload_param` that has to be turned into one. The answer is not JSON: the
 * reference comes back in the `x-encrypted-param` header, and a 200 without it
 * is a silent failure that would send an empty media reference.
 */
export async function uploadToCdn({
  fetchImpl = fetch, uploadFullUrl, uploadParam, filekey, ciphertext, signal,
} = {}) {
  if (!Buffer.isBuffer(ciphertext) || !ciphertext.length) {
    throw new Error('没有可上传的内容。')
  }
  const direct = typeof uploadFullUrl === 'string' ? uploadFullUrl.trim() : ''
  let url
  if (direct) {
    url = new URL(direct)
  } else {
    const param = typeof uploadParam === 'string' ? uploadParam.trim() : ''
    if (!param) throw new Error('微信服务没有返回上传地址。')
    url = new URL(`${CDN_BASE_URL}/upload`)
    url.searchParams.set('encrypted_query_param', param)
    if (filekey) url.searchParams.set('filekey', String(filekey))
  }
  if (!isWeixinCdnHost(url.hostname)) throw new Error('拒绝上传到不受信任的媒体地址。')

  const response = await fetchImpl(url, {
    method: 'POST',
    headers: { 'content-type': 'application/octet-stream' },
    body: ciphertext,
    signal,
  })
  if (!response.ok) throw new Error(`媒体上传失败（HTTP ${response.status}）。`)
  const reference = response.headers?.get?.('x-encrypted-param')
  if (!reference) throw new Error('媒体上传没有返回引用参数（x-encrypted-param）。')
  return reference
}

/** MD5 + ciphertext size, the two numbers `getuploadurl` wants. */
export function uploadFingerprint(plaintext) {
  return {
    rawsize: plaintext.length,
    rawfilemd5: createHash('md5').update(plaintext).digest('hex'),
    filesize: encryptedSize(plaintext.length),
  }
}

/** A random 16-byte filekey, hex encoded (the spec's own convention). */
export function newFilekey() {
  return randomBytes(16).toString('hex')
}

/** A fresh AES-128 key for one outbound upload, as 32 hex characters. */
export function newAesKeyHex() {
  return randomBytes(16).toString('hex')
}

/** Upload type and message item type for a kind. */
export function mediaTypes(kind) {
  return { uploadType: UPLOAD_TYPE_BY_KIND[kind], itemType: ITEM_TYPE_BY_KIND[kind] }
}

/**
 * Build the `item_list` entry that carries an uploaded media reference.
 *
 * `aes_key` is written as base64 of the hex string, which is what the official
 * sender does; a receiver following the compatibility rule in `decodeAesKey`
 * accepts it, and so does WeChat.
 */
export function mediaItemFor({ kind, uploadParam, aesKeyHex, size, fileName }) {
  const { itemType } = mediaTypes(kind)
  const media = {
    encrypt_query_param: uploadParam,
    aes_key: Buffer.from(aesKeyHex, 'utf8').toString('base64'),
    encrypt_type: 1,
  }
  const body = { media }
  if (kind === 'image') body.mid_size = size
  if (kind === 'video') body.video_size = size
  if (kind === 'file') {
    body.file_name = sanitizeFileName(fileName, 'file.bin')
    body.len = String(size)
  }
  return { type: itemType, [`${kind}_item`]: body }
}

/** Guess the media kind from a file extension; everything else is a file. */
export function kindForFileName(name) {
  const ext = String(name ?? '').toLowerCase().match(/\.[a-z0-9]+$/)?.[0] ?? ''
  if (['.jpg', '.jpeg', '.png', '.gif', '.webp', '.bmp'].includes(ext)) return 'image'
  if (['.mp4', '.mov', '.m4v', '.avi', '.mkv'].includes(ext)) return 'video'
  return 'file'
}
