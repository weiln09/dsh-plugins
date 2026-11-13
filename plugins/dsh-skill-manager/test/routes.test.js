import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'

// `skills.js` resolves its library root from DSH_HOME at call time, so each
// test can point it at a throwaway directory before importing.
const home = mkdtempSync(path.join(tmpdir(), 'skill-manager-'))
process.env.DSH_HOME = home

const { libraryRoot, listUnifiedSkills } = await import('../lib/skills.js')
const { apply } = await import('../lib/index.js')

test.after(() => { rmSync(home, { recursive: true, force: true }) })

/** A Host context stub with just enough surface for `apply`. */
function fakeCtx() {
  const registered = []
  const provided = new Map()
  const tools = []
  const ctx = {
    logger: { info() {}, warn() {}, error() {} },
    get: (key) => (key === 'webServer' ? ctx.webServer : key === 'tools' ? ctx.tools : key === 'skills' ? ctx.skills : undefined),
    webServer: {
      register(route) { registered.push(route); return () => {} },
    },
    skills: { registerProvider: () => () => {} },
    tools: { register: (definition) => { tools.push(definition); return () => {} } },
    inject(_services, callback) { callback(ctx) },
    effect(factory) { const dispose = factory(); return () => { try { dispose?.() } catch {} } },
    on() { return () => {} },
    emit() {},
    provide(key, value) { provided.set(key, value) },
  }
  return { ctx, registered, provided, tools }
}

/** Drive one request through the registered route handler. */
async function request(route, { method = 'GET', url = '/skill-manager/api', headers = {}, body } = {}) {
  const response = {
    statusCode: 200,
    headers: {},
    body: '',
    setHeader(name, value) { this.headers[name] = value },
    end(chunk) { this.body = chunk ?? '' },
  }
  const req = {
    method,
    url,
    headers,
    on(event, handler) {
      if (event === 'data' && body !== undefined) handler(Buffer.from(body))
      if (event === 'end') handler()
      return req
    },
  }
  await route.handler(req, response)
  return { status: response.statusCode, json: response.body ? JSON.parse(response.body) : null }
}

function installRoute() {
  const { ctx, registered, tools } = fakeCtx()
  apply(ctx)
  const route = registered.find((entry) => entry.path === '/skill-manager/api')
  assert.ok(route, 'the panel route is registered')
  return { route, tools }
}

test('the panel route registers with the documented shape', () => {
  const { route, tools } = installRoute()
  assert.equal(route.kind, 'prefix')
  assert.equal(tools.length, 1)
  assert.equal(tools[0].name, 'skill_manager')
})

test('a read-only action answers a GET', async () => {
  const { route } = installRoute()
  const response = await request(route, { method: 'GET', url: '/skill-manager/api?action=list' })
  assert.equal(response.status, 200)
  assert.equal(response.json.ok, true)
  assert.ok(Array.isArray(response.json.skills))
})

test('a GET cannot delete or create a skill', async () => {
  // Deleting a folder or running `git clone` from a query string let a link,
  // a prefetcher, or a cross-site image tag drive the plugin.
  const { route } = installRoute()
  const deleted = await request(route, { method: 'GET', url: '/skill-manager/api?action=delete&name=demo' })
  assert.equal(deleted.status, 405)
  assert.match(deleted.json.error, /requires POST/)

  const created = await request(route, { method: 'GET', url: '/skill-manager/api?action=create&name=demo' })
  assert.equal(created.status, 405)
  assert.equal(existsSync(path.join(libraryRoot(), 'demo')), false, 'nothing was written')
})

test('a cross-origin request is refused', async () => {
  const { route } = installRoute()
  const response = await request(route, {
    method: 'POST',
    headers: { origin: 'https://evil.example', host: '127.0.0.1:1', 'content-type': 'application/json' },
    body: JSON.stringify({ action: 'list' }),
  })
  assert.equal(response.status, 403)
})

test('a POST must declare JSON', async () => {
  const { route } = installRoute()
  const response = await request(route, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: 'action=list',
  })
  assert.equal(response.status, 415)
})

test('a same-origin POST reaches the action', async () => {
  const { route } = installRoute()
  const response = await request(route, {
    method: 'POST',
    headers: { origin: 'http://127.0.0.1:1', host: '127.0.0.1:1', 'content-type': 'application/json' },
    body: JSON.stringify({ action: 'list' }),
  })
  assert.equal(response.status, 200)
  assert.equal(response.json.ok, true)
})

test('an unknown action is a 404, not a crash', async () => {
  const { route } = installRoute()
  const response = await request(route, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ action: 'nope' }),
  })
  assert.equal(response.status, 404)
  assert.match(response.json.error, /Unknown action/)
})
