import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { BindingStore, sessionIdFor } from '../lib/bindings.js'
import { SessionRouter, agentSelection } from '../lib/session.js'

/** A minimal stand-in for the Host's `ctx.agents` and an Agent handle. */
function fakeCtx() {
  const live = new Map()
  const created = []
  const resumed = []
  const mounted = []
  // The durable log: `create` writes it, and a resume of an id that was never
  // stored is a not-found — exactly what the Host's persistence layer answers.
  const stored = new Set()
  const ctx = {
    get: (key) => (key === 'agents' ? ctx.agents : key === 'agentPresets' ? ctx.agentPresets : undefined),
    // The Web/Desktop bundle keeps every LOCAL tool inside a preset, so a
    // channel session that never mounts one has no file or shell tools at all.
    agentPresets: {
      resolve: async (id) => ({ id: id || 'standard' }),
      mount: async (_agentCtx, id) => { mounted.push(id); return { id } },
    },
    agents: {
      get: (id) => live.get(id) ?? undefined,
      create: async ({ sessionId, agentOptions, meta, setup }) => {
        const agent = makeAgent(sessionId, agentOptions, meta)
        live.set(sessionId, agent)
        stored.add(sessionId)
        created.push({ sessionId, agentOptions, meta, setup })
        return { agent }
      },
      resume: async ({ resumeSessionId, agentOptions }) => {
        if (resumeCtx.failResume) throw new Error('session is corrupt')
        if (!stored.has(resumeSessionId)) {
          const error = new Error(`session "${resumeSessionId}" not found`)
          error.name = 'SessionPersistenceNotFoundError'
          throw error
        }
        const agent = makeAgent(resumeSessionId, agentOptions, {})
        live.set(resumeSessionId, agent)
        resumed.push({ resumeSessionId, agentOptions })
        return { agent }
      },
    },
  }
  const resumeCtx = { failResume: false }
  return { ctx, live, created, resumed, resumeCtx, mounted, stored }
}

/** A Workspace registry stub: membership is what the sidebar groups by. */
function makeRegistry() {
  const entities = new Map()
  const entity = (workspacePath) => {
    if (!entities.has(workspacePath)) {
      const record = { id: 'ws-' + workspacePath, path: workspacePath, sessionIds: [], attached: [], failed: null }
      record.attachSession = async (sessionId) => {
        if (record.failed) throw new Error(record.failed)
        if (!record.sessionIds.includes(sessionId)) {
          record.sessionIds.push(sessionId)
          record.attached.push(sessionId)
        }
      }
      entities.set(workspacePath, record)
    }
    return entities.get(workspacePath)
  }
  // Archiving lives on the registry too, and it is what the Host's
  // archived-session gate reads: a session in this set has every turn rejected
  // before a request. `unarchiveSession` mirrors the Host's: idempotent, and it
  // does not validate that the id exists.
  const archived = new Set()
  return {
    entity,
    archived,
    get archivedSessionIds() { return [...archived] },
    unarchived: [],
    async unarchiveSession(sessionId) {
      if (!archived.has(sessionId)) return
      archived.delete(sessionId)
      this.unarchived.push(sessionId)
    },
    async resolveByPath(candidate) { return entities.has(candidate) ? entities.get(candidate) : entity(candidate) },
  }
}

function makeAgent(sessionId, agentOptions, meta) {
  const agent = {
    id: sessionId,
    session: { id: sessionId, header: { cwd: meta?.cwd ?? '' }, turnOpen: false },
    options: { ...agentOptions },
    selections: [],
    status: 'inactive',
    model: {
      current: () => agent.options,
      select: (selection) => {
        agent.selections.push(selection)
        agent.options = { ...agent.options, ...selection }
      },
    },
    followup: () => {},
    whenIdle: async () => {},
    cancel: () => { agent.cancelled = true },
  }
  return agent
}

function setup() {
  const dir = mkdtempSync(path.join(tmpdir(), 'weixin-router-'))
  const bindings = new BindingStore(dir, { workspace: 'D:\\a' })
  const { ctx, live, created, resumed, resumeCtx, mounted, stored } = fakeCtx()
  ctx.workspaceRegistry = makeRegistry()
  ctx.get = (key) => (key === 'agents' ? ctx.agents
    : key === 'workspaceRegistry' ? ctx.workspaceRegistry
      : key === 'agentPresets' ? ctx.agentPresets
        : undefined)
  const audit = []
  const router = new SessionRouter({
    ctx,
    bindings,
    defaultSelection: async () => ({ provider: 'p', model: 'm1' }),
    log: () => {},
    audit: (line) => audit.push(line),
  })
  return { dir, bindings, router, live, created, resumed, resumeCtx, audit, ctx, mounted, stored, registry: ctx.workspaceRegistry }
}

test('the first message creates one session in the chat workspace', async () => {
  const { dir, bindings, router, created } = setup()
  const result = await router.ensureAgent('chat-1', { fallbackWorkspace: 'D:\\a' })
  assert.equal(result.created, true)
  assert.equal(result.workspace, 'D:\\a')
  assert.equal(created.length, 1)
  assert.equal(created[0].meta.cwd, 'D:\\a')
  assert.equal(bindings.sessionFor(bindings.get('chat-1'), 'D:\\a'), result.sessionId)
  await bindings.flush()
  rmSync(dir, { recursive: true, force: true })
})

test('a new session mounts the deployment default preset and records it', async () => {
  // Without this the channel session ran outside every preset, and on the
  // Web/Desktop bundle that means no file, shell, skill or compaction tools —
  // only host-plane plugins such as the remote SSH tools stayed visible.
  const { dir, bindings, router, created, mounted } = setup()
  const result = await router.ensureAgent('chat-1', { fallbackWorkspace: 'D:\a' })

  assert.equal(result.agentPreset, 'standard')
  assert.equal(created[0].meta.agentPreset, 'standard', 'the header records the preset for a later resume')

  // The mount happens inside the agent's own setup, before the agent publishes.
  const agentCtx = { get: () => undefined }
  await created[0].setup(agentCtx, { id: result.sessionId, session: { header: { agentPreset: 'standard' } } })
  assert.deepEqual(mounted, ['standard'])

  await bindings.flush()
  rmSync(dir, { recursive: true, force: true })
})

test('a preset chosen on the binding wins over the deployment default', async () => {
  const { dir, bindings, router, created, mounted } = setup()
  bindings.touch('chat-1', { agentPreset: 'ptc' })
  const result = await router.ensureAgent('chat-1', { fallbackWorkspace: 'D:\a' })

  assert.equal(result.agentPreset, 'ptc')
  assert.equal(created[0].meta.agentPreset, 'ptc')
  await created[0].setup({ get: () => undefined }, { id: result.sessionId, session: { header: {} } })
  assert.deepEqual(mounted, ['ptc'])
  await bindings.flush()
  rmSync(dir, { recursive: true, force: true })
})

test('choosing a new preset starts a session under it instead of resuming the old one', async () => {
  // A preset's tools are mounted into the Agent scope at creation and the
  // choice is frozen in the session header, so resuming can never honour a
  // later `/预设`. Resuming anyway is what made `/预设` look like a no-op
  // until `/新建`.
  const { dir, bindings, router, ctx, created, resumed, stored } = setup()
  // 'D:\\a' is the literal the BindingStore defaults use, so the mapping and
  // the chat's active workspace name the same directory.
  stored.add('session-old')
  bindings.setSession('chat-1', 'D:\\a', 'session-old')
  ctx.sessionPersistence = { stat: async () => ({ header: { id: 'session-old', agentPreset: 'standard' } }) }
  bindings.touch('chat-1', { agentPreset: 'ptc' })

  const result = await router.ensureAgent('chat-1', { fallbackWorkspace: 'D:\\a' })

  assert.equal(resumed.length, 0, 'the old session is not resumed under the wrong preset')
  assert.equal(created.length, 1)
  assert.notEqual(result.sessionId, 'session-old')
  assert.equal(created[0].meta.agentPreset, 'ptc')
  assert.equal(bindings.sessionFor(bindings.get('chat-1'), 'D:\\a'), result.sessionId)
  await bindings.flush()
  rmSync(dir, { recursive: true, force: true })
})

test('a stale preset choice settles on the fallback instead of looping', async () => {
  // `/预设 gone` resolves to the default. Comparing the raw binding value
  // against the header would never match, so every message would create a new
  // session forever. The binding is rewritten to the preset actually mounted.
  const { dir, bindings, router, ctx, created, resumed, stored, audit } = setup()
  ctx.agentPresets.resolve = async (id) => {
    if (!id || id === 'gone') {
      if (id) throw new Error('Unknown agent preset: gone')
      return { id: 'standard' }
    }
    return { id }
  }
  stored.add('session-stale')
  bindings.setSession('chat-1', 'D:\\a', 'session-stale')
  ctx.sessionPersistence = { stat: async () => ({ header: { id: 'session-stale', agentPreset: 'standard' } }) }
  bindings.touch('chat-1', { agentPreset: 'gone' })

  const first = await router.ensureAgent('chat-1', { fallbackWorkspace: 'D:\\a' })
  assert.equal(first.sessionId, 'session-stale', 'a session already on the fallback is resumed')
  assert.equal(created.length, 0)
  assert.equal(bindings.get('chat-1').agentPreset, 'standard', 'the binding records the preset in force')

  // The next turn must reuse the same conversation, not mint another one.
  const second = await router.ensureAgent('chat-1', { fallbackWorkspace: 'D:\\a' })
  assert.equal(second.sessionId, 'session-stale')
  assert.equal(created.length, 0)
  assert.equal(resumed.length, 1, 'the second turn reuses the live agent')
  assert.ok(audit.some((line) => line.kind === 'preset/fallback'))
  await bindings.flush()
  rmSync(dir, { recursive: true, force: true })
})

test('a deployment without presets never mints a session per message', async () => {
  // `/预设` can leave a preset id on the binding while a headless composition
  // has no registry to mount it. Switching there would create a session that
  // cannot record the preset, so every later message would create another one.
  const { dir, bindings, router, ctx, created, resumed, stored } = setup()
  delete ctx.agentPresets
  stored.add('session-plain')
  bindings.setSession('chat-1', 'D:\\a', 'session-plain')
  bindings.touch('chat-1', { agentPreset: 'ptc' })

  const result = await router.ensureAgent('chat-1', { fallbackWorkspace: 'D:\\a' })

  assert.equal(result.sessionId, 'session-plain')
  assert.equal(created.length, 0)
  assert.equal(resumed.length, 1)
  await bindings.flush()
  rmSync(dir, { recursive: true, force: true })
})

test('a chat that never chose a preset keeps resuming its session', async () => {
  const { dir, bindings, router, ctx, created, resumed, stored } = setup()
  stored.add('session-keep')
  bindings.setSession('chat-1', 'D:\\a', 'session-keep')
  ctx.sessionPersistence = { stat: async () => ({ header: { id: 'session-keep', agentPreset: 'standard' } }) }

  const result = await router.ensureAgent('chat-1', { fallbackWorkspace: 'D:\\a' })

  assert.equal(result.sessionId, 'session-keep')
  assert.equal(created.length, 0)
  assert.equal(resumed.length, 1)
  await bindings.flush()
  rmSync(dir, { recursive: true, force: true })
})

test('an unknown preset falls back to the default instead of wedging the chat', async () => {
  const { dir, bindings, router, ctx, audit } = setup()
  ctx.agentPresets.resolve = async (id) => {
    if (!id) return { id: 'standard' }
    throw new Error(`Unknown agent preset: ${id}`)
  }
  bindings.touch('chat-1', { agentPreset: 'gone' })

  const result = await router.ensureAgent('chat-1', { fallbackWorkspace: 'D:\a' })
  assert.equal(result.agentPreset, 'standard')
  assert.ok(audit.some((line) => line.kind === 'preset/fallback'), 'the fallback is audited')
  await bindings.flush()
  rmSync(dir, { recursive: true, force: true })
})

test('a preset mount failure is audited and never blocks the turn', async () => {
  const { dir, bindings, router, created, ctx, audit } = setup()
  ctx.agentPresets.mount = async () => { throw new Error('preset activation failed') }
  const result = await router.ensureAgent('chat-1', { fallbackWorkspace: 'D:\a' })

  // The mount fails, but the channel's own setup must still run: a broken
  // preset degrades the tool set, it never blocks the conversation.
  await created[0].setup({ get: () => undefined }, { id: result.sessionId, session: { header: {} } })
  assert.ok(audit.some((line) => line.kind === 'preset/mount-failed'))
  await bindings.flush()
  rmSync(dir, { recursive: true, force: true })
})

test('a deployment without a preset registry still creates sessions', async () => {
  const { dir, bindings, router, ctx, created } = setup()
  delete ctx.agentPresets
  const result = await router.ensureAgent('chat-1', { fallbackWorkspace: 'D:\a' })

  assert.equal(result.created, true)
  assert.equal(result.agentPreset, '')
  assert.equal('agentPreset' in created[0].meta, false, 'no preset is recorded when there is none')
  await bindings.flush()
  rmSync(dir, { recursive: true, force: true })
})

test('a new session joins the Workspace registered at its cwd', async () => {
  // The sidebar groups by registry membership, not by the header cwd: without
  // attachSession the conversation renders under 未分组 however correct cwd is.
  const { dir, bindings, router, ctx, audit } = setup()
  const result = await router.ensureAgent('chat-1', { fallbackWorkspace: 'D:\\a' })
  assert.deepEqual(ctx.workspaceRegistry.entity('D:\\a').attached, [result.sessionId])
  assert.ok(audit.some((line) => line.kind === 'workspace/attach' && line.sessionId === result.sessionId))
  await bindings.flush()
  rmSync(dir, { recursive: true, force: true })
})

test('resuming an already attached session does not attach it twice', async () => {
  const { dir, bindings, router, ctx } = setup()
  const first = await router.ensureAgent('chat-1', { fallbackWorkspace: 'D:\\a' })
  // Drop the live agent so the next call goes through resume.
  ctx.agents.get = () => undefined
  const second = await router.ensureAgent('chat-1', { fallbackWorkspace: 'D:\\a' })
  assert.equal(second.sessionId, first.sessionId)
  assert.equal(ctx.workspaceRegistry.entity('D:\\a').attached.length, 1)
  await bindings.flush()
  rmSync(dir, { recursive: true, force: true })
})

test('an attach failure leaves the conversation usable', async () => {
  const { dir, bindings, router, ctx, audit } = setup()
  ctx.workspaceRegistry.entity('D:\\a').failed = 'cwd does not resolve'
  const result = await router.ensureAgent('chat-1', { fallbackWorkspace: 'D:\\a' })
  assert.equal(result.created, true)
  assert.ok(audit.some((line) => line.kind === 'workspace/attach-failed'))
  await bindings.flush()
  rmSync(dir, { recursive: true, force: true })
})

test('a second message reuses the live agent', async () => {
  const { dir, bindings, router, created } = setup()
  const first = await router.ensureAgent('chat-1', { fallbackWorkspace: 'D:\\a' })
  const second = await router.ensureAgent('chat-1', { fallbackWorkspace: 'D:\\a' })
  assert.equal(second.sessionId, first.sessionId)
  assert.equal(second.created, false)
  assert.equal(created.length, 1)
  await bindings.flush()
  rmSync(dir, { recursive: true, force: true })
})

test('switching workspace starts a different session and keeps the old one', async () => {
  const { dir, bindings, router, created } = setup()
  const a = await router.ensureAgent('chat-1', { fallbackWorkspace: 'D:\\a' })
  const switched = await router.switchWorkspace('chat-1', 'D:\\b')
  assert.equal(switched.ok, true)
  const b = await router.ensureAgent('chat-1', { fallbackWorkspace: 'D:\\a' })
  assert.equal(b.workspace, 'D:\\b')
  assert.notEqual(b.sessionId, a.sessionId)
  assert.equal(created.length, 2)

  // Switching back resumes the original mapping rather than creating a third.
  await router.switchWorkspace('chat-1', 'D:\\a')
  const back = await router.ensureAgent('chat-1', { fallbackWorkspace: 'D:\\a' })
  assert.equal(back.sessionId, a.sessionId)
  assert.equal(created.length, 2)
  await bindings.flush()
  rmSync(dir, { recursive: true, force: true })
})

test('a workspace switch is refused while the current session runs', async () => {
  const { dir, bindings, router, live } = setup()
  const a = await router.ensureAgent('chat-1', { fallbackWorkspace: 'D:\\a' })
  live.get(a.sessionId).status = 'running'
  const result = await router.switchWorkspace('chat-1', 'D:\\b')
  assert.equal(result.ok, false)
  assert.equal(result.reason, 'busy')
  await bindings.flush()
  rmSync(dir, { recursive: true, force: true })
})

test('an idle session takes a model switch immediately', async () => {
  const { dir, bindings, router, live } = setup()
  const a = await router.ensureAgent('chat-1', { fallbackWorkspace: 'D:\\a' })
  const outcome = await router.selectModel('chat-1', { provider: 'p', model: 'm2' })
  assert.equal(outcome, 'applied')
  assert.deepEqual(agentSelection(live.get(a.sessionId)), { provider: 'p', model: 'm2' })
  assert.deepEqual(bindings.get('chat-1').model, { provider: 'p', model: 'm2' })
  await bindings.flush()
  rmSync(dir, { recursive: true, force: true })
})

test('a running session defers the model switch to the next turn', async () => {
  const { dir, bindings, router, live } = setup()
  const a = await router.ensureAgent('chat-1', { fallbackWorkspace: 'D:\\a' })
  const agent = live.get(a.sessionId)
  agent.status = 'running'

  const outcome = await router.selectModel('chat-1', { provider: 'p', model: 'm2' })
  assert.equal(outcome, 'deferred')
  assert.deepEqual(agentSelection(agent), { provider: 'p', model: 'm1' })

  agent.status = 'inactive'
  await router.applyPendingModel(a.sessionId, agent)
  assert.deepEqual(agentSelection(agent), { provider: 'p', model: 'm2' })
  await bindings.flush()
  rmSync(dir, { recursive: true, force: true })
})

test('selecting the same model twice is a no-op', async () => {
  const { dir, bindings, router } = setup()
  await router.ensureAgent('chat-1', { fallbackWorkspace: 'D:\\a' })
  await router.selectModel('chat-1', { provider: 'p', model: 'm2' })
  assert.equal(await router.selectModel('chat-1', { provider: 'p', model: 'm2' }), 'unchanged')
  await bindings.flush()
  rmSync(dir, { recursive: true, force: true })
})

test('a model choice survives a restart because it lives on the binding', async () => {
  const { dir, bindings, router } = setup()
  await router.ensureAgent('chat-1', { fallbackWorkspace: 'D:\\a' })
  await router.selectModel('chat-1', { provider: 'p', model: 'm9' })
  await bindings.flush()

  const reloaded = new BindingStore(dir, { workspace: 'D:\\a' })
  assert.deepEqual(reloaded.get('chat-1').model, { provider: 'p', model: 'm9' })
  await reloaded.flush()
  rmSync(dir, { recursive: true, force: true })
})

test('a failed resume falls back to a fresh session and audits it', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'weixin-router-'))
  const bindings = new BindingStore(dir, { workspace: 'D:\\a' })
  await bindings.setSession('chat-1', 'D:\\a', 'session-broken')

  const audit = []
  const created = []
  const ctx = {
    get: (key) => (key === 'agents' ? ctx.agents : undefined),
    agents: {
      get: () => undefined,
      create: async ({ sessionId, agentOptions, meta }) => {
        const agent = makeAgent(sessionId, agentOptions, meta)
        created.push({ sessionId, agentOptions, meta })
        return { agent }
      },
      resume: async () => {
        throw new Error('session is corrupt')
      },
    },
  }
  const restarted = new SessionRouter({
    ctx,
    bindings,
    defaultSelection: async () => ({ provider: 'p', model: 'm1' }),
    log: () => {},
    audit: (line) => audit.push(line),
  })

  const result = await restarted.ensureAgent('chat-1', { fallbackWorkspace: 'D:\\a' })
  assert.equal(result.created, true)
  assert.ok(audit.some((line) => line.kind === 'session/resume-failed'))
  assert.equal(created.length, 1, 'the fallback created exactly one session')
  assert.notEqual(result.sessionId, 'session-broken')
  assert.equal(bindings.sessionFor(bindings.get('chat-1'), 'D:\\a'), result.sessionId)
  await bindings.flush()
  rmSync(dir, { recursive: true, force: true })
})

test('a taken deterministic id is retried with a fresh one instead of failing the turn', async () => {
  // Reproduces the WeChat failure 'session "<id>" already exists': the binding
  // was dropped, the durable log for the deterministic id is still on disk, and
  // `/新建` therefore asked persistence to create an id that already exists.
  const dir = mkdtempSync(path.join(tmpdir(), 'weixin-router-'))
  const bindings = new BindingStore(dir, { workspace: 'D:\a' })
  const attempts = []
  const audit = []
  const ctx = {
    get: (key) => (key === 'agents' ? ctx.agents : undefined),
    agents: {
      get: () => undefined,
      create: async ({ sessionId, agentOptions, meta }) => {
        attempts.push(sessionId)
        if (attempts.length === 1) {
          const error = new Error(`session "${sessionId}" already exists`)
          error.name = 'SessionAlreadyExistsError'
          throw error
        }
        return { agent: makeAgent(sessionId, agentOptions, meta) }
      },
      resume: async () => { throw new Error('session "x" not found') },
    },
  }
  const router = new SessionRouter({
    ctx,
    bindings,
    defaultSelection: async () => ({ provider: 'p', model: 'm1' }),
    log: () => {},
    audit: (line) => audit.push(line),
  })

  const result = await router.ensureAgent('chat-1', { fallbackWorkspace: 'D:\a' })

  assert.equal(result.created, true, 'the turn survives the collision')
  assert.equal(attempts.length, 2)
  assert.notEqual(result.sessionId, attempts[0], 'the occupied id is never reused')
  assert.ok(audit.some((line) => line.kind === 'session/id-collision'), 'the retry is audited')
  assert.equal(bindings.sessionFor(bindings.get('chat-1'), 'D:\a'), result.sessionId)
  await bindings.flush()
  rmSync(dir, { recursive: true, force: true })
})

test('a lost binding adopts the stored conversation instead of creating over it', async () => {
  // The deterministic id is the chat's conversation in that workspace. When
  // bindings.json no longer names it but the log is still stored, the honest
  // move is to resume it — creating over it is what produced the failure.
  const dir = mkdtempSync(path.join(tmpdir(), 'weixin-router-'))
  const ws = 'D:/a'
  const bindings = new BindingStore(dir, { workspace: ws })
  const created = []
  const resumed = []
  const audit = []
  const stored = new Set([sessionIdFor('chat-1', ws)])
  const ctx = {
    get: (key) => (key === 'agents' ? ctx.agents : key === 'sessionPersistence' ? ctx.persistence : undefined),
    persistence: { stat: async (id) => (stored.has(id) ? { id } : undefined) },
    agents: {
      get: () => undefined,
      create: async ({ sessionId, agentOptions, meta }) => {
        created.push(sessionId)
        return { agent: makeAgent(sessionId, agentOptions, meta) }
      },
      resume: async ({ resumeSessionId, agentOptions }) => {
        resumed.push(resumeSessionId)
        return { agent: makeAgent(resumeSessionId, agentOptions, {}) }
      },
    },
  }
  const router = new SessionRouter({
    ctx,
    bindings,
    defaultSelection: async () => ({ provider: 'p', model: 'm1' }),
    log: () => {},
    audit: (line) => audit.push(line),
  })

  const result = await router.ensureAgent('chat-1', { fallbackWorkspace: ws })

  assert.equal(result.created, false, 'the stored conversation is resumed, not replaced')
  assert.deepEqual(created, [], 'nothing is created over an existing log')
  assert.deepEqual(resumed, [result.sessionId])
  assert.ok(audit.some((line) => line.kind === 'session/adopt'))
  assert.equal(bindings.sessionFor(bindings.get('chat-1'), ws), result.sessionId)
  await bindings.flush()
  rmSync(dir, { recursive: true, force: true })
})

test('adoption still works on a deployment that cannot stat sessions', async () => {
  // A headless composition may not expose sessionPersistence; the resume probe
  // itself answers "not found" for a session that was never stored.
  const dir = mkdtempSync(path.join(tmpdir(), 'weixin-router-'))
  const ws = 'D:/b'
  const bindings = new BindingStore(dir, { workspace: ws })
  const resumed = []
  const ctx = {
    get: (key) => (key === 'agents' ? ctx.agents : undefined),
    agents: {
      get: () => undefined,
      create: async ({ sessionId, agentOptions, meta }) => ({ agent: makeAgent(sessionId, agentOptions, meta) }),
      resume: async ({ resumeSessionId, agentOptions }) => {
        resumed.push(resumeSessionId)
        return { agent: makeAgent(resumeSessionId, agentOptions, {}) }
      },
    },
  }
  const router = new SessionRouter({
    ctx,
    bindings,
    defaultSelection: async () => ({ provider: 'p', model: 'm1' }),
    log: () => {},
    audit: () => {},
  })

  const result = await router.ensureAgent('chat-1', { fallbackWorkspace: ws })

  assert.equal(result.created, false)
  assert.deepEqual(resumed, [sessionIdFor('chat-1', ws)])
  await bindings.flush()
  rmSync(dir, { recursive: true, force: true })
})

test('/新建 never aims at the id the previous conversation owns', async () => {
  const { dir, bindings, router, live } = setup()
  const ws = 'D:/a'
  bindings.touch('chat-1', { activeWorkspace: ws })
  const first = await router.ensureAgent('chat-1', { fallbackWorkspace: ws })
  live.get(first.sessionId).status = 'inactive'

  const reset = await router.reset('chat-1', () => {})

  assert.equal(reset.ok, true)
  assert.notEqual(reset.sessionId, first.sessionId)
  assert.notEqual(reset.sessionId, sessionIdFor('chat-1', ws), 'a fresh draft mints a new identity')
  assert.equal(bindings.sessionFor(bindings.get('chat-1'), ws), reset.sessionId)
  await bindings.flush()
  rmSync(dir, { recursive: true, force: true })
})

test('cancel reaches the live agent and reports whether there was one', async () => {
  const { dir, bindings, router, live } = setup()
  assert.equal(await router.cancel('chat-1'), false)
  const a = await router.ensureAgent('chat-1', { fallbackWorkspace: 'D:\\a' })
  assert.equal(await router.cancel('chat-1'), true)
  assert.equal(live.get(a.sessionId).cancelled, true)
  await bindings.flush()
  rmSync(dir, { recursive: true, force: true })
})

test('reset refuses while busy and otherwise mints a new session id', async () => {
  const { dir, bindings, router, live } = setup()
  const a = await router.ensureAgent('chat-1', { fallbackWorkspace: 'D:\\a' })
  live.get(a.sessionId).status = 'running'
  assert.deepEqual(await router.reset('chat-1', () => {}), { ok: false, reason: 'busy' })

  live.get(a.sessionId).status = 'inactive'
  const reset = await router.reset('chat-1', () => {})
  assert.equal(reset.ok, true)
  assert.notEqual(reset.sessionId, a.sessionId)
  await bindings.flush()
  rmSync(dir, { recursive: true, force: true })
})

test('two chats never share a session', async () => {
  const { dir, bindings, router } = setup()
  const one = await router.ensureAgent('chat-1', { fallbackWorkspace: 'D:\\a' })
  const two = await router.ensureAgent('chat-2', { fallbackWorkspace: 'D:\\a' })
  assert.notEqual(one.sessionId, two.sessionId)
  assert.equal(bindings.bySessionId(one.sessionId).chatId, 'chat-1')
  assert.equal(bindings.bySessionId(two.sessionId).chatId, 'chat-2')
  await bindings.flush()
  rmSync(dir, { recursive: true, force: true })
})

test('an archived conversation is un-archived by the next message instead of blocking', async () => {
  // The Host rejects the pre-step of an archived session, so every message in
  // this chat ended as a turn with reason { kind: 'blocked' } and the WeChat card
  // read "⏳ 被阻塞 / ⏱ 1.2s" forever. Archiving is filing, not revocation.
  const { dir, bindings, router, registry } = setup()
  const first = await router.ensureAgent('chat-1', { fallbackWorkspace: 'D:\\a' })
  registry.archived.add(first.sessionId)

  const second = await router.ensureAgent('chat-1', { fallbackWorkspace: 'D:\\a' })

  assert.equal(second.sessionId, first.sessionId, 'the same conversation is reused')
  assert.equal(second.created, false)
  assert.deepEqual(registry.unarchived, [first.sessionId])
  assert.equal(registry.archived.has(first.sessionId), false)
  await bindings.flush()
  rmSync(dir, { recursive: true, force: true })
})

test('a live but archived agent is un-archived too', async () => {
  const { dir, bindings, router, registry, live } = setup()
  const first = await router.ensureAgent('chat-1', { fallbackWorkspace: 'D:\\a' })
  live.get(first.sessionId).status = 'inactive'
  registry.archived.add(first.sessionId)

  const second = await router.ensureAgent('chat-1', { fallbackWorkspace: 'D:\\a' })

  assert.equal(second.created, false)
  assert.deepEqual(registry.unarchived, [first.sessionId])
  await bindings.flush()
  rmSync(dir, { recursive: true, force: true })
})

test('an un-archived conversation is left alone', async () => {
  const { dir, bindings, router, registry } = setup()
  await router.ensureAgent('chat-1', { fallbackWorkspace: 'D:\\a' })
  await router.ensureAgent('chat-1', { fallbackWorkspace: 'D:\\a' })
  assert.deepEqual(registry.unarchived, [], 'unarchiveSession is not called for a normal turn')
  await bindings.flush()
  rmSync(dir, { recursive: true, force: true })
})

test('adoption lifts the archive as well, because it is the same conversation', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'weixin-router-'))
  const ws = 'D:/a'
  const bindings = new BindingStore(dir, { workspace: ws })
  const archived = new Set([sessionIdFor('chat-1', ws)])
  const unarchived = []
  const ctx = {
    get: (key) => (key === 'agents' ? ctx.agents
      : key === 'sessionPersistence' ? ctx.persistence
        : key === 'workspaceRegistry' ? ctx.workspaceRegistry
          : undefined),
    persistence: { stat: async (id) => (archived.has(id) || id === sessionIdFor('chat-1', ws) ? { id } : undefined) },
    workspaceRegistry: {
      get archivedSessionIds() { return [...archived] },
      async unarchiveSession(id) { archived.delete(id); unarchived.push(id) },
      async resolveByPath() { return { id: 'ws', sessionIds: [], attachSession: async () => {} } },
    },
    agents: {
      get: () => undefined,
      create: async ({ sessionId, agentOptions, meta }) => ({ agent: makeAgent(sessionId, agentOptions, meta) }),
      resume: async ({ resumeSessionId, agentOptions }) => ({ agent: makeAgent(resumeSessionId, agentOptions, {}) }),
    },
  }
  const router = new SessionRouter({
    ctx,
    bindings,
    defaultSelection: async () => ({ provider: 'p', model: 'm1' }),
    log: () => {},
    audit: () => {},
  })

  const result = await router.ensureAgent('chat-1', { fallbackWorkspace: ws })

  assert.equal(result.created, false)
  assert.deepEqual(unarchived, [sessionIdFor('chat-1', ws)])
  await bindings.flush()
  rmSync(dir, { recursive: true, force: true })
})

test('a registry that refuses to un-archive leaves the turn usable', async () => {
  const { dir, bindings, router, registry, audit } = setup()
  const first = await router.ensureAgent('chat-1', { fallbackWorkspace: 'D:\\a' })
  registry.archived.add(first.sessionId)
  registry.unarchiveSession = async () => { throw new Error('storage is locked') }

  const second = await router.ensureAgent('chat-1', { fallbackWorkspace: 'D:\\a' })

  assert.equal(second.sessionId, first.sessionId, 'the failure never breaks the conversation')
  assert.ok(audit.some((line) => line.kind === 'session/unarchive-failed'))
  await bindings.flush()
  rmSync(dir, { recursive: true, force: true })
})
