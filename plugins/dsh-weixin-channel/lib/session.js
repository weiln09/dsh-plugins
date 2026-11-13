// Session routing: one DSH agent per (chat, workspace).
//
// Why per workspace: a Session's `cwd` is written into its immutable header, and
// the Workspace sidebar groups sessions by that header. Re-pointing one session
// at another directory is therefore impossible — the honest model is "one
// session per workspace", resumed on demand. Switching back to a previous
// workspace resumes its own session with all of its history intact.
//
// Model switching is different: `agent.model.select()` changes the route for
// the next step of the *same* session, so `/模型` never costs history.

import { randomUUID } from 'node:crypto'

import { sessionIdFor } from './bindings.js'

/**
 * True when an error means "this durable session id is taken".
 *
 * The persistence layer reports it as `SessionAlreadyExistsError` with the
 * message `session "<id>" already exists`; a backend that wraps the failure
 * keeps the message, so both signals are accepted.
 */
export function isDuplicateSessionId(error) {
  if (error?.name === 'SessionAlreadyExistsError') return true
  return /already exists/i.test(String(error?.message ?? error))
}

/** True when an error means "there is no stored session with that id". */
export function isMissingSession(error) {
  if (error?.name === 'SessionPersistenceNotFoundError') return true
  return /session "[^"]*" not found|session\/not-found/i.test(String(error?.message ?? error))
}

/** Read the effective model selection of a live agent, if it has one. */
export function agentSelection(agent) {
  try {
    const current = agent?.model?.current?.()
    if (current?.provider && current?.model) return current
  } catch {
    // A disposed agent throws; the caller falls back to the binding.
  }
  return null
}

/**
 * Owns agent creation, resumption, and the model/workspace switches for every
 * bound chat. It never stores an Agent handle: `ctx.agents.get()` is the single
 * source of liveness, so a host restart needs no cleanup.
 */
export class SessionRouter {
  /**
   * @param {Object} deps
   * @param {import('@deepseek-ai/cordis').Context} deps.ctx
   * @param {import('./bindings.js').BindingStore} deps.bindings
   * @param {() => Promise<{provider:string, model:string, reasoningEffort?:string}>} deps.defaultSelection
   * @param {(line: string) => void} deps.log
   * @param {(line: Object) => void} deps.audit
   */
  constructor({ ctx, bindings, defaultSelection, log, audit }) {
    this.ctx = ctx
    this.bindings = bindings
    this.defaultSelection = defaultSelection
    this.log = log
    this.audit = audit
    /** sessionId → 待应用的模型选择（回合运行中排队） */
    this.deferredModels = new Map()
  }

  /**
   * The Agent registry. Read through `ctx.get` so this module never touches a
   * Context property outside the plugin's declared injections.
   */
  agents() {
    const registry = this.ctx.get?.('agents')
    if (!registry) throw new Error('weixin-channel: the agents service is not mounted')
    return registry
  }

  /** The workspace a chat currently works in, falling back to the deployment default. */
  workspaceFor(binding, fallbackWorkspace) {
    return binding?.activeWorkspace || fallbackWorkspace
  }

  /** Resolve the model a chat should use: its own choice, then the deployment default. */
  async selectionFor(binding) {
    if (binding?.model?.provider && binding?.model?.model) return { ...binding.model }
    return this.defaultSelection()
  }

  /** The Agent preset registry. Optional: a headless composition may lack it. */
  presetService() {
    try {
      return this.ctx.get?.('agentPresets')
    } catch {
      return undefined
    }
  }

  /**
   * Resolve the Agent preset a chat's next session should run.
   *
   * This is not cosmetic. Creating an Agent through `agents.create()` bypasses
   * the preset registry, and on the Web/Desktop bundle every LOCAL capability
   * (tool-fs, tool-pwsh, tool-skill, agent-instructions, compaction) lives
   * behind a preset row rather than on the host plane. A channel session made
   * that way therefore had no file or shell tools at all — only host-plane
   * plugins such as the remote SSH tools and MCP servers stayed visible, which
   * read as "remote control is pointless".
   *
   * A preset stored on the binding that no longer exists must not wedge the
   * chat: it falls back to the deployment default and says so in the audit log.
   *
   * @returns {Promise<{ id: string, broken?: string }>} the preset to mount, or '' when this deployment has no registry.
   */
  async resolvePreset(binding) {
    const presets = this.presetService()
    if (!presets?.resolve) return { id: '' }
    const wanted = binding?.agentPreset || ''
    try {
      const resolved = await presets.resolve(wanted || undefined)
      return resolved?.id ? { id: resolved.id, ...(resolved.broken ? { broken: resolved.broken } : {}) } : { id: '' }
    } catch (error) {
      if (!wanted) {
        this.log(`读取 Agent 预设失败：${error?.message ?? error}`)
        return { id: '' }
      }
      this.log(`预设 ${wanted} 不可用，回退到默认预设：${error?.message ?? error}`)
      this.audit({ kind: 'preset/fallback', agentPreset: wanted, error: String(error?.message ?? error) })
      try {
        const fallback = await presets.resolve(undefined)
        return fallback?.id ? { id: fallback.id } : { id: '' }
      } catch {
        return { id: '' }
      }
    }
  }

  /**
   * Wrap a channel setup callback so the Agent joins its preset composition
   * first.
   *
   * `mount()` binds the Agent scope under the preset generation, which is what
   * makes the preset's tools visible to this Agent. A resumed session keeps the
   * preset recorded in its header; a new one runs the preset resolved above.
   *
   * A mount failure is logged and audited rather than thrown: a broken preset
   * must degrade to "this chat has fewer tools", never to "this chat cannot
   * answer at all".
   */
  composePresetSetup(setup, presetId) {
    return async (agentCtx, agent) => {
      const presets = this.presetService()
      const wanted = agent?.session?.header?.agentPreset || presetId || ''
      if (presets?.mount && wanted) {
        try {
          await presets.mount(agentCtx, wanted)
          this.audit({ kind: 'preset/mount', sessionId: agent?.id ?? '', agentPreset: wanted })
        } catch (error) {
          this.log(`挂载 Agent 预设 ${wanted} 失败：${error?.message ?? error}`)
          this.audit({
            kind: 'preset/mount-failed',
            sessionId: agent?.id ?? '',
            agentPreset: wanted,
            error: String(error?.message ?? error),
          })
        }
      }
      if (typeof setup === 'function') await setup(agentCtx, agent)
    }
  }

  /**
   * The preset a stored or live session was created under.
   *
   * A preset is fixed for the life of a Session: its tools are mounted into the
   * Agent scope at creation and the choice is recorded in the immutable header.
   * Reading it back is therefore the only honest way to answer "would resuming
   * this conversation honour the preset the chat now asks for?".
   * @returns the recorded preset id, or undefined when the session predates presets.
   */
  async recordedPreset(sessionId, live) {
    const header = live?.session?.header
    if (header && typeof header.agentPreset === 'string' && header.agentPreset) return header.agentPreset
    try {
      const persistence = this.ctx.get?.('sessionPersistence') ?? this.ctx.sessionPersistence
      if (typeof persistence?.stat === 'function') {
        const snapshot = await persistence.stat(sessionId)
        const stored = snapshot?.header?.agentPreset
        if (typeof stored === 'string' && stored) return stored
        if (snapshot !== undefined) return ''
      }
    } catch {
      // A backend that cannot answer tells us nothing; resume decides instead.
    }
    return undefined
  }

  /**
   * Resolve the live agent for one chat, creating or resuming as needed.
   * @returns {Promise<{ agent: object, sessionId: string, workspace: string, created: boolean }>}
   */
  async ensureAgent(chatId, { setup, fallbackWorkspace } = {}) {
    const binding = this.bindings.ensure(chatId)
    const workspace = this.workspaceFor(binding, fallbackWorkspace)
    const selection = await this.selectionFor(binding)
    const preset = await this.resolvePreset(binding)
    const mounted = this.composePresetSetup(setup, preset.id)
    const recorded = this.bindings.sessionFor(binding, workspace)

    // A conversation the sidebar archived is gated at the Host's pre-step hook:
    // every turn is rejected before a request, which reaches the chat as
    // "⏳ 被阻塞 / ⏱ 1.2s" with no explanation and no way out. Lift it here —
    // on the turn path only — because this chat is about to append to that
    // conversation and archiving is filing, not revocation.
    if (recorded) await this.liftArchive(recorded)

    // `/预设` stores the choice on the binding, and a preset cannot be swapped
    // under an existing Session: its tools were mounted when the Agent was
    // created. Resuming would therefore keep the OLD preset forever, which is
    // what made `/预设` look like a no-op until `/新建`.
    //
    // Two guards keep this from becoming a session-per-message loop:
    //   - only an EXPLICIT choice switches; a chat that never picked one keeps
    //     resuming whatever it had, including a session created under another
    //     deployment default;
    //   - the comparison is against the RESOLVED preset (`preset.id`), not the
    //     raw binding value, and an unusable stored choice is rewritten to the
    //     one actually mounted. Otherwise `/预设 gone` would fall back to
    //     `standard` every turn, never match the stored `gone`, and mint a new
    //     session on every single message.
    if (recorded && binding.agentPreset && preset.id) {
      const current = await this.recordedPreset(recorded, this.agents().get(recorded))
      if (current !== undefined && current !== preset.id) {
        if (binding.agentPreset !== preset.id) {
          binding.agentPreset = preset.id
          await this.bindings.store.save()
        }
        this.audit({ kind: 'preset/switch', chatId, from: current, to: preset.id })
        return this.createAgent(chatId, workspace, selection, mounted, preset.id, { fresh: true })
      }
      if (binding.agentPreset !== preset.id) {
        // Already running the fallback: remember it so the next turn is a resume.
        binding.agentPreset = preset.id
        await this.bindings.store.save()
      }
    }

    if (recorded) {
      const live = this.agents().get(recorded)
      if (live) {
        await this.applyPendingModel(recorded, live)
        // Repair a session created before this plugin attached its sessions:
        // an existing conversation should not stay in 未分组 forever.
        await this.joinWorkspace(recorded, workspace)
        return { agent: live, sessionId: recorded, workspace, created: false, agentPreset: preset.id }
      }
      try {
        const handle = await this.agents().resume({
          resumeSessionId: recorded,
          agentOptions: selection,
          setup: mounted,
        })
        this.log(`恢复会话 ${recorded}（${chatId}）`)
        await this.applyPendingModel(recorded, handle.agent)
        await this.joinWorkspace(recorded, workspace)
        return { agent: handle.agent, sessionId: recorded, workspace, created: false, agentPreset: preset.id }
      } catch (error) {
        this.log(`恢复会话 ${recorded} 失败，将新建：${error?.message ?? error}`)
        this.audit({ kind: 'session/resume-failed', sessionId: recorded, chatId, error: String(error?.message ?? error) })
      }
    }

    // The binding is only a hint: it is a JSON file a rebind, a restart, or a
    // workspace switch can leave behind the durable log. The id is deterministic
    // per (chat, workspace), so when the mapping is gone the honest move is to
    // adopt that conversation again instead of minting a new one — creating over
    // it is exactly what failed with 'session "<id>" already exists'.
    const deterministic = sessionIdFor(chatId, workspace)
    if (deterministic && deterministic !== recorded) {
      const adopted = await this.adoptRecorded(chatId, workspace, selection, mounted, preset.id)
      if (adopted) return adopted
    }

    return this.createAgent(chatId, workspace, selection, mounted, preset.id)
  }

  /**
   * Whether a durable session log with this id exists.
   *
   * `sessionPersistence.stat()` observes one stored session without reading its
   * log or taking write ownership, which is exactly what is needed to decide
   * "adopt or create" before touching either.
   * @returns true/false, or null when this deployment cannot tell.
   */
  async durableSessionExists(sessionId) {
    try {
      // `ctx.get` reaches every registered service; the property is the
      // fallback for a composition that exposes it directly.
      const persistence = this.ctx.get?.('sessionPersistence') ?? this.ctx.sessionPersistence
      if (typeof persistence?.stat === 'function') {
        return (await persistence.stat(sessionId)) !== undefined
      }
    } catch {
      // A backend that refuses the probe tells us nothing; the caller probes
      // with a resume instead, whose "not found" is the same answer.
    }
    return null
  }

  /**
   * Resume the deterministic session id for (chat, workspace) when the binding
   * no longer remembers it.
   * @returns the same shape as {@link ensureAgent}, or null when nothing is stored.
   */
  async adoptRecorded(chatId, workspace, selection, setup, agentPreset) {
    const id = sessionIdFor(chatId, workspace)
    if (!id) return null
    // Only a definite "nothing stored" skips the attempt; a deployment that
    // cannot answer still probes with a resume, whose "not found" is the same
    // answer one step later.
    if (await this.durableSessionExists(id) === false) return null
    // Adoption is the same "this chat is about to talk in that conversation"
    // case as a recorded binding, so the archive gate has to come down here too.
    await this.liftArchive(id)
    const live = this.agents().get(id)
    if (live) {
      this.bindings.setSession(chatId, workspace, id)
      await this.applyPendingModel(id, live)
      await this.joinWorkspace(id, workspace)
      return { agent: live, sessionId: id, workspace, created: false, agentPreset }
    }
    try {
      const handle = await this.agents().resume({
        resumeSessionId: id,
        agentOptions: selection,
        setup,
      })
      this.bindings.setSession(chatId, workspace, id)
      this.log(`接回既有会话 ${id}（${chatId} · ${workspace}）`)
      this.audit({ kind: 'session/adopt', sessionId: id, chatId, workspace })
      await this.applyPendingModel(id, handle.agent)
      await this.joinWorkspace(id, workspace)
      return { agent: handle.agent, sessionId: id, workspace, created: false, agentPreset }
    } catch (error) {
      if (!isMissingSession(error)) {
        this.log(`接回会话 ${id} 失败：${error?.message ?? error}`)
        this.audit({ kind: 'session/adopt-failed', sessionId: id, chatId, error: String(error?.message ?? error) })
      }
      return null
    }
  }

  /**
   * Un-archive a conversation this chat is about to append to.
   *
   * The Host mounts an `archived-session-gate` that rejects the pre-step of any
   * archived session (or of a session whose subagent ancestry reaches one) with
   * `{ kind: 'reject' }`; the agent loop then ends the turn as `blocked` before
   * a request is made. Nothing in the channel was wrong — the transcript simply
   * stopped at "⏳ 被阻塞 / ⏱ 1.2s" for every message, forever, because resuming
   * an archived session does not lift the gate.
   *
   * Archiving in the sidebar is filing, not revocation: the user filed a
   * conversation they had finished with, and a message arriving in that chat is
   * new work for it. So the channel lifts the flag on the turn path — never at
   * startup, where it would quietly un-archive conversations nobody is talking
   * to. `unarchiveSession` is idempotent and does not validate existence, so a
   * deployment without the registry (or without the method) is a no-op.
   *
   * @returns true when this call actually lifted an archive.
   */
  async liftArchive(sessionId) {
    if (!sessionId) return false
    try {
      const registry = this.ctx.get?.('workspaceRegistry') ?? this.ctx.workspaceRegistry
      if (typeof registry?.unarchiveSession !== 'function') return false
      const archived = registry.archivedSessionIds
      if (!Array.isArray(archived) || !archived.includes(sessionId)) return false
      await registry.unarchiveSession(sessionId)
      this.log(`会话 ${sessionId} 已归档，收到新消息，自动解除`)
      this.audit({ kind: 'session/unarchive', sessionId })
      return true
    } catch (error) {
      // A gate that stays up costs a blocked turn, not a broken chat: the card
      // now explains it (see notify.js), so the user can unarchive by hand.
      this.log('会话 ' + sessionId + ' 解除归档失败：' + String(error?.message ?? error))
      this.audit({ kind: 'session/unarchive-failed', sessionId, error: String(error?.message ?? error) })
      return false
    }
  }

  /**
   * Attach one session to the Workspace registered at its directory.
   *
   * The sidebar groups sessions by **registry membership**, not by the `cwd` in
   * the session header: a session no Workspace lists renders under "未分组" no
   * matter what its cwd says. Sessions created here go through `agents.create()`,
   * which bypasses the Workspace command that normally attaches, so without this
   * every WeChat conversation landed in 未分组.
   *
   * A failure is logged and swallowed: the conversation still works, it just
   * stays ungrouped.
   */
  async joinWorkspace(sessionId, workspace) {
    if (!workspace) return false
    try {
      const registry = this.ctx.get?.('workspaceRegistry') ?? this.ctx.workspaceRegistry
      if (!registry?.resolveByPath) return false
      const entity = await registry.resolveByPath(workspace)
      if (!entity) return false
      if (entity.sessionIds?.includes(sessionId)) return true
      await entity.attachSession(sessionId)
      this.audit({ kind: 'workspace/attach', sessionId, workspace, workspaceId: entity.id })
      return true
    } catch (error) {
      this.log('会话 ' + sessionId + ' 未能加入工作区 ' + workspace + '：' + String(error?.message ?? error))
      this.audit({ kind: 'workspace/attach-failed', sessionId, workspace, error: String(error?.message ?? error) })
      return false
    }
  }

  /**
   * Create a fresh session in one workspace and remember it for that chat.
   *
   * @param options.fresh - skip the deterministic id entirely. `/新建` asks for a
   *   conversation that is *not* the previous one, so it must not aim at the id
   *   the previous one already occupies.
   */
  async createAgent(chatId, workspace, selection, setup, agentPreset = '', options = {}) {
    const preferred = options.fresh ? `session-${randomUUID()}` : sessionIdFor(chatId, workspace)
    let id = preferred
    if (this.agents().get(id)) {
      // A live agent already owns that id (two chats, same tail of the path).
      id = `session-${randomUUID()}`
    }

    let handle
    try {
      handle = await this.createWith(id, workspace, selection, setup, agentPreset)
    } catch (error) {
      // The deterministic id names *every* session this chat has had in this
      // workspace, and the durable log outlives the binding. So the second
      // `/新建` — and any fallback after a failed resume — asked the persistence
      // layer to create an id whose log already exists, and the turn died with
      // 'session "<id>" already exists'. That old log is a different
      // conversation and must never be appended to, so mint a fresh identity.
      if (id !== preferred || !isDuplicateSessionId(error)) throw error
      const fallback = `session-${randomUUID()}`
      this.log(`会话 id ${id} 已被占用，改用 ${fallback}：${error?.message ?? error}`)
      this.audit({ kind: 'session/id-collision', sessionId: id, chatId, workspace, fallback })
      id = fallback
      handle = await this.createWith(id, workspace, selection, setup, agentPreset)
    }

    this.bindings.setSession(chatId, workspace, id)
    await this.joinWorkspace(id, workspace)
    this.log(`新建会话 ${id}（${chatId} · ${workspace}${agentPreset ? ' · 预设 ' + agentPreset : ''}）`)
    this.audit({ kind: 'session/create', sessionId: id, chatId, workspace, agentPreset })
    return { agent: handle.agent, sessionId: id, workspace, created: true, agentPreset }
  }

  /** One `agents.create()` call: the header records the preset so a later resume
   * reconstructs the same composition instead of falling back to "no tools". */
  async createWith(id, workspace, selection, setup, agentPreset) {
    return this.agents().create({
      sessionId: id,
      agentOptions: selection,
      meta: { cwd: workspace, ...(agentPreset ? { agentPreset } : {}) },
      setup,
    })
  }

  /**
   * Switch one chat's model. Applies in place when the agent is idle; a running
   * turn keeps its route and the change lands after `turn/end`.
   * @returns {Promise<'applied'|'deferred'|'unchanged'>}
   */
  async selectModel(chatId, selection) {
    const binding = this.bindings.ensure(chatId)
    const previous = binding.model
    const same = previous?.provider === selection.provider
      && previous?.model === selection.model
      && (previous?.reasoningEffort ?? '') === (selection.reasoningEffort ?? '')
    if (same) return 'unchanged'

    binding.model = {
      provider: selection.provider,
      model: selection.model,
      ...(selection.reasoningEffort ? { reasoningEffort: selection.reasoningEffort } : {}),
    }
    await this.bindings.store.save()

    const workspace = this.workspaceFor(binding, '')
    const sessionId = this.bindings.sessionFor(binding, workspace)
    const agent = sessionId ? this.agents().get(sessionId) : null
    if (!agent) return 'applied'

    if (this.isBusy(agent)) {
      this.deferredModels.set(sessionId, { ...binding.model })
      return 'deferred'
    }
    this.applyModel(agent, binding.model)
    return 'applied'
  }

  /** Push one selection into a live agent. */
  applyModel(agent, selection) {
    if (!selection?.provider || !selection?.model) return false
    try {
      agent.model?.select?.({
        provider: selection.provider,
        model: selection.model,
        ...(selection.reasoningEffort ? { reasoningEffort: selection.reasoningEffort } : {}),
      })
      return true
    } catch (error) {
      this.log(`切换模型失败：${error?.message ?? error}`)
      return false
    }
  }

  /** Apply a deferred model change once the agent goes idle. */
  async applyPendingModel(sessionId, agent) {
    const pending = this.deferredModels.get(sessionId)
    if (!pending || !agent) return
    if (this.isBusy(agent)) return
    this.deferredModels.delete(sessionId)
    this.applyModel(agent, pending)
  }

  /** True when the agent has work in flight. */
  isBusy(agent) {
    try {
      const status = agent?.status
      if (typeof status === 'string') return status === 'running'
      if (status && typeof status === 'object' && 'phase' in status) return status.phase === 'running'
      return Boolean(agent?.session?.turnOpen)
    } catch {
      return false
    }
  }

  /** Cancel the current turn of one chat, if any. */
  async cancel(chatId, reason = 'wechat /停止') {
    const binding = this.bindings.get(chatId)
    if (!binding) return false
    const workspace = this.workspaceFor(binding, '')
    const sessionId = this.bindings.sessionFor(binding, workspace)
    const agent = sessionId ? this.agents().get(sessionId) : null
    if (!agent) return false
    try {
      agent.cancel?.({ kind: 'user', reason })
      return true
    } catch (error) {
      this.log(`取消任务失败：${error?.message ?? error}`)
      return false
    }
  }

  /** Start a fresh session in the chat's current workspace, dropping the mapping. */
  async reset(chatId, setup) {
    const binding = this.bindings.ensure(chatId)
    const workspace = this.workspaceFor(binding, '')
    const previous = this.bindings.sessionFor(binding, workspace)
    if (previous) {
      const agent = this.agents().get(previous)
      if (agent && this.isBusy(agent)) {
        return { ok: false, reason: 'busy' }
      }
    }
    // The mapping is *replaced* by `createAgent`, never cleared first: a create
    // that fails must leave the chat pointed at the conversation it already had
    // instead of at nothing.
    const selection = await this.selectionFor(binding)
    const preset = await this.resolvePreset(binding)
    const created = await this.createAgent(
      chatId, workspace, selection, this.composePresetSetup(setup, preset.id), preset.id,
      // A fresh draft must not reuse the id the previous conversation owns.
      { fresh: true },
    )
    return { ok: true, ...created }
  }

  /** Move a chat to another workspace without touching the old session. */
  async switchWorkspace(chatId, workspace) {
    const binding = this.bindings.ensure(chatId)
    const current = this.workspaceFor(binding, '')
    const previousSession = this.bindings.sessionFor(binding, current)
    if (previousSession) {
      const agent = this.agents().get(previousSession)
      if (agent && this.isBusy(agent)) return { ok: false, reason: 'busy' }
    }
    binding.activeWorkspace = workspace
    binding.lastActivityAt = Date.now()
    await this.bindings.store.save()
    this.audit({ kind: 'workspace/switch', chatId, from: current, to: workspace })
    return { ok: true, workspace, previousSession }
  }

}
