import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { BindingStore, sessionIdFor } from '../lib/bindings.js'
import { JsonStore, maskId, readJson, resolveStateDir, safeId, writeJson } from '../lib/store.js'

function tempDir() {
  return mkdtempSync(path.join(tmpdir(), 'weixin-channel-'))
}

test('writes a JSON file atomically with owner-only permissions', () => {
  const dir = tempDir()
  const file = path.join(dir, 'nested', 'state.json')
  writeJson(file, { a: 1 })
  assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')), { a: 1 })
  if (process.platform !== 'win32') {
    assert.equal(statSync(file).mode & 0o777, 0o600)
  }
  rmSync(dir, { recursive: true, force: true })
})

test('a corrupt file falls back instead of throwing', () => {
  const dir = tempDir()
  const file = path.join(dir, 'bad.json')
  writeFileSync(file, '{ not json')
  assert.deepEqual(readJson(file, { ok: true }), { ok: true })
  rmSync(dir, { recursive: true, force: true })
})

test('serialized saves keep the last value', async () => {
  const dir = tempDir()
  const store = new JsonStore(path.join(dir, 's.json'), { n: 0 })
  store.save({ n: 1 })
  store.save({ n: 2 })
  store.save({ n: 3 })
  await store.save()
  assert.equal(readJson(path.join(dir, 's.json'), null).n, 3)
  rmSync(dir, { recursive: true, force: true })
})

test('the state directory honors config, then DSH_HOME, then the home default', () => {
  assert.equal(resolveStateDir('D:\\custom'), path.resolve('D:\\custom'))
  const previous = process.env.DSH_HOME
  process.env.DSH_HOME = path.join(tmpdir(), 'dsh-home-test')
  try {
    assert.equal(resolveStateDir(''), path.join(process.env.DSH_HOME, 'integrations', 'dsh-weixin-channel'))
  } finally {
    if (previous === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previous
  }
})

test('ids are sanitized and masked for display', () => {
  assert.equal(safeId('a b/c:d'), 'a-b-c-d')
  assert.equal(maskId('o9cq803Gx7QjKIL7LCIjZpEY7nYc@im.wechat'), 'o9cq80…chat')
})

test('a chat gets one binding with the deployment defaults', async () => {
  const dir = tempDir()
  const bindings = new BindingStore(dir, { workspace: 'D:\\w', model: { provider: 'p', model: 'm' } })
  const binding = bindings.ensure('chat-1')
  assert.equal(binding.activeWorkspace, 'D:\\w')
  assert.deepEqual(binding.model, { provider: 'p', model: 'm' })
  assert.equal(bindings.ensure('chat-1'), binding)
  await bindings.flush()
  rmSync(dir, { recursive: true, force: true })
})

test('each workspace keeps its own session id', async () => {
  const dir = tempDir()
  const bindings = new BindingStore(dir, { workspace: 'D:\\a' })
  bindings.setSession('chat-1', 'D:\\a', 'session-a')
  bindings.setSession('chat-1', 'D:\\b', 'session-b')
  const binding = bindings.get('chat-1')
  assert.equal(bindings.sessionFor(binding, 'D:\\a'), 'session-a')
  assert.equal(bindings.sessionFor(binding, 'D:\\b'), 'session-b')
  assert.equal(bindings.bySessionId('session-b').chatId, 'chat-1')
  bindings.clearSession('chat-1', 'D:\\a')
  assert.equal(bindings.sessionFor(bindings.get('chat-1'), 'D:\\a'), null)
  await bindings.flush()
  rmSync(dir, { recursive: true, force: true })
})

test('allow, revoke and admin imply access', async () => {
  const dir = tempDir()
  const bindings = new BindingStore(dir, {})
  assert.equal(bindings.isAllowed('u1'), false)
  bindings.addAdmin('u1')
  assert.equal(bindings.isAllowed('u1'), true)
  assert.equal(bindings.isAdmin('u1'), true)
  bindings.allow('u2')
  assert.equal(bindings.isAllowed('u2'), true)
  assert.equal(bindings.isAdmin('u2'), false)
  bindings.revoke('u1')
  assert.equal(bindings.isAllowed('u1'), false)
  await bindings.flush()
  rmSync(dir, { recursive: true, force: true })
})

test('a stranger is queued once and leaves the queue when trusted', async () => {
  const dir = tempDir()
  const bindings = new BindingStore(dir, {})
  bindings.notePending('u3', '昵称')
  bindings.notePending('u3', '昵称')
  assert.equal(bindings.pendingTrust().length, 1)
  bindings.allow('u3')
  assert.equal(bindings.pendingTrust().length, 0)
  await bindings.flush()
  rmSync(dir, { recursive: true, force: true })
})

test('dedupe accepts a message once and survives a reload', async () => {
  const dir = tempDir()
  const bindings = new BindingStore(dir, {})
  assert.equal(bindings.dedupe('m1'), true)
  assert.equal(bindings.dedupe('m1'), false)
  assert.equal(bindings.dedupe(''), true)
  await bindings.flush()

  const reloaded = new BindingStore(dir, {})
  assert.equal(reloaded.dedupe('m1'), false, 'a restart must not re-consume the same message')
  assert.equal(reloaded.dedupe('m2'), true)
  await reloaded.flush()
  rmSync(dir, { recursive: true, force: true })
})

test('the dedupe window stays bounded', async () => {
  const dir = tempDir()
  const bindings = new BindingStore(dir, {})
  for (let index = 0; index < 1_050; index += 1) bindings.dedupe(`m${index}`)
  assert.ok(bindings.seen.get().ids.length <= 1_000)
  await bindings.flush()
  rmSync(dir, { recursive: true, force: true })
})

test('the dedupe window is stored apart from the chat bindings', async () => {
  // It changes on every message and is the largest part of the state, so
  // keeping it in bindings.json meant every touch() rewrote ~30 KB of
  // unrelated data and every message rewrote the window again.
  const dir = tempDir()
  const bindings = new BindingStore(dir, {})
  bindings.ensure('chat-1')
  bindings.dedupe('m1')
  await bindings.flush()

  assert.deepEqual(bindings.store.get().seenMessageIds, [], 'the chat file no longer carries the window')
  const seenFile = JSON.parse(readFileSync(path.join(dir, 'seen.json'), 'utf8'))
  assert.deepEqual(seenFile.ids, ['m1'])
  rmSync(dir, { recursive: true, force: true })
})

test('a window left in bindings.json by an older build is adopted', async () => {
  const dir = tempDir()
  writeFileSync(path.join(dir, 'bindings.json'), JSON.stringify({
    version: 2, chats: {}, allowlist: [], admins: [], pendingTrust: [], seenMessageIds: ['old-1', 'old-2'],
  }))
  const bindings = new BindingStore(dir, {})
  assert.equal(bindings.dedupe('old-1'), false, 'a restart must not re-consume the same message')
  assert.equal(bindings.dedupe('old-2'), false)
  assert.equal(bindings.dedupe('new-1'), true)
  await bindings.flush()
  const seenFile = JSON.parse(readFileSync(path.join(dir, 'seen.json'), 'utf8'))
  assert.deepEqual(seenFile.ids, ['old-1', 'old-2', 'new-1'])
  rmSync(dir, { recursive: true, force: true })
})

test('session ids are stable and path-shaped', () => {
  const first = sessionIdFor('chat@im.wechat', 'D:\\github\\ifm30')
  assert.equal(first, sessionIdFor('chat@im.wechat', 'D:\\github\\ifm30'))
  assert.notEqual(first, sessionIdFor('chat@im.wechat', 'D:\\github\\cf-pan'))
  assert.match(first, /^session-[A-Za-z0-9._-]+$/)
})
