import assert from 'node:assert/strict'
import { createCipheriv, createHash, randomBytes } from 'node:crypto'
import test from 'node:test'

import {
  CDN_BASE_URL, MAX_MEDIA_BYTES, decodeAesKey, decryptEcb, downloadMedia, encryptEcb,
  encryptedSize, extractMedia, isWeixinCdnHost, kindForFileName, mediaItemFor, mediaTypes,
  newAesKeyHex, newFilekey, quotedFromMessage, sanitizeFileName, uploadFingerprint, uploadToCdn,
} from '../lib/media.js'

test('the AES key decodes from both encodings in the wild', () => {
  // A. base64 of the raw 16 bytes — what a Python/Go sender writes.
  const raw = randomBytes(16)
  assert.deepEqual(decodeAesKey(null, raw.toString('base64')), raw)

  // B. base64 of the 32-character hex string — what the official sender writes.
  const hex = raw.toString('hex')
  assert.deepEqual(decodeAesKey(null, Buffer.from(hex, 'utf8').toString('base64')), raw)

  // C. a bare hex string, which appears in the docs and in some fixtures.
  assert.deepEqual(decodeAesKey(null, hex), raw)

  // The item's own aeskey is the fallback when the media block has none.
  assert.deepEqual(decodeAesKey({ aes_key: Buffer.from(hex).toString('base64') }, ''), raw)
  assert.equal(decodeAesKey(null, 'not-a-key'), null)
})

test('encrypt and decrypt round-trip through AES-128-ECB', () => {
  const key = Buffer.from(newAesKeyHex(), 'hex')
  const plaintext = Buffer.from('微信附件内容 · binary \u0000\u0001 tail', 'utf8')
  const ciphertext = encryptEcb(plaintext, key)
  assert.equal(ciphertext.length, encryptedSize(plaintext.length))
  assert.deepEqual(decryptEcb(ciphertext, key), plaintext)
})

test('a payload with no padding block still decrypts', () => {
  // Some senders strip the PKCS7 block; a strict decipher throws on those and
  // the file is lost. The retry without auto-padding is what recovers them.
  // The plaintext ends in 0x00, which can never be a valid padding length, so
  // the first decipher.final() is guaranteed to fail.
  const key = Buffer.from(newAesKeyHex(), 'hex')
  const plaintext = Buffer.alloc(32, 0)
  const cipher = createCipheriv('aes-128-ecb', key, null)
  cipher.setAutoPadding(false)
  const unpadded = Buffer.concat([cipher.update(plaintext), cipher.final()])
  assert.deepEqual(decryptEcb(unpadded, key), plaintext)
})

test('only the WeChat CDN host is trusted', () => {
  assert.equal(isWeixinCdnHost('novac2c.cdn.weixin.qq.com'), true)
  assert.equal(isWeixinCdnHost('weixin.qq.com'), true)
  assert.equal(isWeixinCdnHost('WEIXIN.QQ.COM.'), true)
  assert.equal(isWeixinCdnHost('evil.example.com'), false)
  assert.equal(isWeixinCdnHost('weixin.qq.com.evil.example'), false)
  assert.equal(isWeixinCdnHost(undefined), false)
})

test('an inbound file name cannot escape the inbox directory', () => {
  assert.equal(sanitizeFileName('../../etc/passwd'), 'passwd')
  assert.equal(sanitizeFileName('C:\\Users\\x\\报告.pdf'), '报告.pdf')
  assert.equal(sanitizeFileName('a<b>c:d|e?f*g.txt'), 'a_b_c_d_e_f_g.txt')
  assert.equal(sanitizeFileName(''), 'file')
  assert.equal(sanitizeFileName('...'), 'file')
  assert.equal(sanitizeFileName('x'.repeat(300)).length, 120)
})

test('extractMedia reports the kind, name and quoted title', () => {
  const image = extractMedia({
    item_list: [{ type: 2, image_item: { media: { encrypt_query_param: 'p' }, aeskey: 'k', mid_size: 42 } }],
  })
  assert.equal(image.kind, 'image')
  assert.equal(image.itemType, 2)
  assert.equal(image.size, 42)
  assert.match(image.fileName, /\.jpg$/)

  const file = extractMedia({
    item_list: [{
      type: 4,
      // ref_msg hangs off the MessageItem, next to the kind-specific body —
      // reading it from inside file_item silently lost every quote.
      ref_msg: { title: '上一份报告' },
      file_item: {
        media: { encrypt_query_param: 'p' }, file_name: '../报告 2026.pdf', len: '2048',
      },
    }],
  })
  assert.equal(file.kind, 'file')
  assert.equal(file.fileName, '报告 2026.pdf')
  assert.equal(file.size, 2048, 'len is a string on the wire')
  assert.equal(file.quoted, '上一份报告')

  // Text-only, empty, and unknown item types carry no media.
  assert.equal(extractMedia({ item_list: [{ type: 1, text_item: { text: 'hi' } }] }), null)
  assert.equal(extractMedia({ item_list: [{ type: 2 }] }), null)
  assert.equal(extractMedia(undefined), null)
})

test('a quoted title is found whatever kind the message is', () => {
  assert.equal(quotedFromMessage({
    item_list: [
      { type: 1, text_item: { text: 'hi' } },
      { type: 1, text_item: { text: 'again' }, ref_msg: { title: '  被引用的消息  ' } },
    ],
  }), '被引用的消息')
  assert.equal(quotedFromMessage({ item_list: [{ type: 1, text_item: { text: 'x' } }] }), '')
  assert.equal(quotedFromMessage(undefined), '')
})

test('a download is decrypted and the size limit is enforced', async () => {
  const key = Buffer.from(newAesKeyHex(), 'hex')
  const plaintext = Buffer.from('hello 微信', 'utf8')
  const ciphertext = encryptEcb(plaintext, key)
  const seen = []
  const fetchImpl = async (url, init) => {
    seen.push({ url: String(url), method: init?.method })
    return new Response(ciphertext, { status: 200 })
  }
  const result = await downloadMedia({
    fetchImpl,
    media: { encrypt_query_param: 'enc-param' },
    aeskey: key.toString('hex'),
  })
  assert.deepEqual(result, plaintext)
  assert.match(seen[0].url, /^https:\/\/novac2c\.cdn\.weixin\.qq\.com\/c2c\/download\?encrypted_query_param=enc-param/)
})

test('a download without a reference or over the limit fails loudly', async () => {
  await assert.rejects(
    downloadMedia({ fetchImpl: async () => new Response(''), media: {} }),
    /没有可下载的媒体引用/,
  )
  await assert.rejects(
    downloadMedia({
      fetchImpl: async () => new Response(Buffer.alloc(64), { status: 200 }),
      media: { encrypt_query_param: 'p' },
      maxBytes: 16,
    }),
    /媒体文件过大/,
  )
  await assert.rejects(
    downloadMedia({
      fetchImpl: async () => new Response('no', { status: 500 }),
      media: { encrypt_query_param: 'p' },
    }),
    /HTTP 500/,
  )
  assert.equal(MAX_MEDIA_BYTES, 20 * 1024 * 1024)
})

test('an upload posts the ciphertext and reads x-encrypted-param', async () => {
  const seen = []
  const fetchImpl = async (url, init) => {
    seen.push({ url: String(url), method: init.method, type: init.headers['content-type'] })
    return new Response('', { status: 200, headers: { 'x-encrypted-param': 'ref-1' } })
  }
  const reference = await uploadToCdn({
    fetchImpl, uploadFullUrl: `${CDN_BASE_URL}/upload?x=1`, ciphertext: Buffer.from('abc'),
  })
  assert.equal(reference, 'ref-1')
  assert.equal(seen[0].method, 'POST')
  assert.equal(seen[0].type, 'application/octet-stream', 'the CDN wants raw binary, not a form')
})

test('an upload prefers upload_full_url and falls back to upload_param', async () => {
  const urls = []
  const fetchImpl = async (url) => {
    urls.push(String(url))
    return new Response('', { status: 200, headers: { 'x-encrypted-param': 'ref' } })
  }
  await uploadToCdn({ fetchImpl, uploadParam: 'enc', filekey: 'fk', ciphertext: Buffer.from('a') })
  assert.match(urls[0], /\/c2c\/upload\?encrypted_query_param=enc&filekey=fk$/)

  // A host that is not the WeChat CDN is refused before any bytes are sent.
  await assert.rejects(
    uploadToCdn({ fetchImpl, uploadFullUrl: 'https://evil.example.com/upload', ciphertext: Buffer.from('a') }),
    /不受信任的媒体地址/,
  )
  await assert.rejects(uploadToCdn({ fetchImpl, ciphertext: Buffer.alloc(0) }), /没有可上传的内容/)
  await assert.rejects(uploadToCdn({ fetchImpl, ciphertext: Buffer.from('a') }), /没有返回上传地址/)
})

test('an upload with no reference header is a failure, not an empty message', async () => {
  await assert.rejects(
    uploadToCdn({
      fetchImpl: async () => new Response('', { status: 200 }),
      uploadFullUrl: `${CDN_BASE_URL}/upload`,
      ciphertext: Buffer.from('a'),
    }),
    /x-encrypted-param/,
  )
})

test('the upload fingerprint is what the CDN verifies', () => {
  const plaintext = Buffer.from('1234567890')
  const fingerprint = uploadFingerprint(plaintext)
  assert.equal(fingerprint.rawsize, 10)
  assert.equal(fingerprint.rawfilemd5, createHash('md5').update(plaintext).digest('hex'))
  assert.equal(fingerprint.filesize, 16, 'one PKCS7 block for a 10-byte payload')
  assert.equal(encryptedSize(16), 32, 'an aligned payload still gains a full block')
})

test('a media item carries a base64-of-hex aes key and the right type', () => {
  const aesKeyHex = newAesKeyHex()
  const item = mediaItemFor({ kind: 'file', uploadParam: 'ref', aesKeyHex, size: 12, fileName: 'a b.pdf' })
  assert.equal(item.type, 4)
  assert.equal(item.file_item.file_name, 'a b.pdf')
  assert.equal(item.file_item.len, '12', 'len is a string in the protocol')
  assert.equal(item.file_item.media.encrypt_query_param, 'ref')
  assert.equal(item.file_item.media.aes_key, Buffer.from(aesKeyHex, 'utf8').toString('base64'))
  assert.deepEqual(decodeAesKey(item.file_item.media, ''), Buffer.from(aesKeyHex, 'hex'))

  assert.equal(mediaItemFor({ kind: 'image', uploadParam: 'r', aesKeyHex, size: 5 }).type, 2)
  assert.equal(mediaItemFor({ kind: 'video', uploadParam: 'r', aesKeyHex, size: 5 }).type, 5)
})

test('kind, upload type and item type agree with the protocol table', () => {
  assert.deepEqual(mediaTypes('image'), { uploadType: 1, itemType: 2 })
  assert.deepEqual(mediaTypes('video'), { uploadType: 2, itemType: 5 })
  assert.deepEqual(mediaTypes('file'), { uploadType: 3, itemType: 4 })
  assert.deepEqual(mediaTypes('voice'), { uploadType: 4, itemType: 3 })

  assert.equal(kindForFileName('a.JPG'), 'image')
  assert.equal(kindForFileName('a.webp'), 'image')
  assert.equal(kindForFileName('a.mp4'), 'video')
  assert.equal(kindForFileName('a.pdf'), 'file')
  assert.equal(kindForFileName('noext'), 'file')
})

test('a filekey and an AES key are fresh random material', () => {
  const keys = new Set(Array.from({ length: 32 }, () => newAesKeyHex()))
  assert.equal(keys.size, 32, 'keys must not repeat')
  assert.match([...keys][0], /^[0-9a-f]{32}$/)
  assert.match(newFilekey(), /^[0-9a-f]{32}$/)
})
