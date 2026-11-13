// Chat bindings: which workspace and model a WeChat chat uses, plus the
// authorization state that decides who may drive the agent at all.
//
// The binding is the unit that fixes dsh-im's limitation: workspace and model
// live here, per chat, not in the plugin Config. Config only supplies defaults
// for a chat that has never chosen.

import { JsonStore, safeId } from './store.js'

const STORE_VERSION = 2
const SEEN_LIMIT = 1_000

/** The binding shape written to disk. */
function emptyBinding(chatId, defaults) {
  return {
    platform: 'weixin',
    chatId,
    chatType: 'private',
    activeWorkspace: defaults.workspace || '',
    sessions: {},
    model: defaults.model ? { ...defaults.model } : null,
    permissionPreset: defaults.permissionPreset || '',
    agentPreset: defaults.agentPreset || '',
    planMode: false,
    replyGranularity: 'standard',
    muted: false,
    createdAt: Date.now(),
    lastActivityAt: 0,
  }
}

/**
 * Owns `bindings.json`: chat bindings, the allowlist, admins, and the dedupe
 * window. All mutations persist immediately through an atomic write.
 */
export class BindingStore {
  constructor(stateDir, defaults = {}) {
    this.defaults = defaults
    this.store = new JsonStore(`${stateDir}/bindings.json`, {
      version: STORE_VERSION,
      chats: {},
      allowlist: [],
      admins: [],
      seenMessageIds: [],
      pendingTrust: [],
    })
    const data = this.store.get()
    if (!data.chats) data.chats = {}
    if (!Array.isArray(data.allowlist)) data.allowlist = []
    if (!Array.isArray(data.admins)) data.admins = []
    if (!Array.isArray(data.pendingTrust)) data.pendingTrust = []

    // The dedupe window lives in its OWN file. It is the only part of this
    // state that changes on every single message, and it is also the largest
    // (a thousand ids, pretty-printed). Keeping it here meant every `touch()`
    // rewrote ~30 KB of unrelated chat state, and every message rewrote the
    // window again. Two small writes beat one big one, and a corrupt window
    // can no longer take the chat bindings down with it.
    this.seen = new JsonStore(`${stateDir}/seen.json`, {
      version: 1,
      ids: Array.isArray(data.seenMessageIds) ? data.seenMessageIds : [],
    })
    const seen = this.seen.get()
    if (!Array.isArray(seen.ids)) seen.ids = []
    // Rows written by an older build kept the window inside bindings.json;
    // adopt them once so a restart does not re-deliver recent messages.
    if (Array.isArray(data.seenMessageIds) && data.seenMessageIds.length) {
      const merged = new Set([...seen.ids, ...data.seenMessageIds])
      seen.ids = [...merged].slice(-SEEN_LIMIT)
      data.seenMessageIds = []
      void this.store.save()
    }
    this._seen = new Set(seen.ids)
    this._seenOrder = [...seen.ids]
    // Dedupe is written on a debounce: a burst of messages must not rewrite the
    // whole file per message, and a crash only re-delivers the last few seconds.
    this._seenDirty = false
    this._seenTimer = null
  }

  // ── bindings ─────────────────────────────────────────────────────────────

  /** Read one chat's binding without creating it. */
  get(chatId) {
    return this.store.get().chats[String(chatId)] ?? null
  }

  /** Read or create the binding for a chat. */
  ensure(chatId) {
    const key = String(chatId)
    const chats = this.store.get().chats
    if (!chats[key]) {
      chats[key] = emptyBinding(key, this.defaults)
      void this.store.save()
    }
    return chats[key]
  }

  /** Persist a binding after an in-place mutation. */
  touch(chatId, patch) {
    const binding = this.ensure(chatId)
    if (patch) Object.assign(binding, patch)
    binding.lastActivityAt = Date.now()
    void this.store.save()
    return binding
  }

  /** Remove one chat's binding (its sessions stay in DSH untouched). */
  remove(chatId) {
    const chats = this.store.get().chats
    delete chats[String(chatId)]
    void this.store.save()
  }

  /** Every binding, newest activity first. */
  list() {
    return Object.values(this.store.get().chats)
      .sort((a, b) => (b.lastActivityAt ?? 0) - (a.lastActivityAt ?? 0))
  }

  /** The binding that owns one DSH session id, or null. */
  bySessionId(sessionId) {
    if (!sessionId) return null
    for (const binding of Object.values(this.store.get().chats)) {
      for (const value of Object.values(binding.sessions ?? {})) {
        if (value === sessionId) return binding
      }
    }
    return null
  }

  // ── sessions per workspace ───────────────────────────────────────────────

  /** The session this chat uses for one workspace, or null. */
  sessionFor(binding, workspace) {
    if (!binding || !workspace) return null
    return binding.sessions?.[workspace] ?? null
  }

  /** Remember a newly created session for one workspace. */
  setSession(chatId, workspace, sessionId) {
    const binding = this.ensure(chatId)
    binding.sessions[workspace] = sessionId
    void this.store.save()
    return binding
  }

  /** Drop one workspace's session mapping (a fresh `/新建` in that workspace). */
  clearSession(chatId, workspace) {
    const binding = this.get(chatId)
    if (!binding) return
    delete binding.sessions[workspace]
    void this.store.save()
  }

  // ── authorization ────────────────────────────────────────────────────────

  isAllowed(userId) {
    const key = String(userId)
    const data = this.store.get()
    return data.allowlist.includes(key) || data.admins.includes(key)
  }

  isAdmin(userId) {
    return this.store.get().admins.includes(String(userId))
  }

  allow(userId) {
    const data = this.store.get()
    const key = String(userId)
    if (!data.allowlist.includes(key)) data.allowlist.push(key)
    data.pendingTrust = data.pendingTrust.filter((entry) => (entry?.userId ?? entry) !== key)
    void this.store.save()
  }

  revoke(userId) {
    const data = this.store.get()
    const key = String(userId)
    data.allowlist = data.allowlist.filter((entry) => entry !== key)
    data.admins = data.admins.filter((entry) => entry !== key)
    void this.store.save()
  }

  addAdmin(userId) {
    const data = this.store.get()
    const key = String(userId)
    if (!data.admins.includes(key)) data.admins.push(key)
    if (!data.allowlist.includes(key)) data.allowlist.push(key)
    void this.store.save()
  }

  /** Record a stranger who tried to talk to the bot. */
  notePending(userId, name) {
    const data = this.store.get()
    const key = String(userId)
    if (data.allowlist.includes(key) || data.admins.includes(key)) return
    if (data.pendingTrust.some((entry) => entry.userId === key)) return
    data.pendingTrust.push({ userId: key, name: name ?? '', at: Date.now() })
    if (data.pendingTrust.length > 50) data.pendingTrust.splice(0, data.pendingTrust.length - 50)
    void this.store.save()
  }

  pendingTrust() {
    return [...this.store.get().pendingTrust]
  }

  // ── dedupe ───────────────────────────────────────────────────────────────

  /** True when this platform message has not been handled before. */
  dedupe(msgId) {
    if (!msgId) return true
    const key = String(msgId)
    if (this._seen.has(key)) return false
    this._seen.add(key)
    this._seenOrder.push(key)
    if (this._seenOrder.length > SEEN_LIMIT) {
      const dropped = this._seenOrder.splice(0, this._seenOrder.length - SEEN_LIMIT)
      for (const old of dropped) this._seen.delete(old)
    }
    this.seen.get().ids = this._seenOrder
    this._scheduleSeenFlush()
    return true
  }

  /** Persist the dedupe window soon, coalescing a burst into one write. */
  _scheduleSeenFlush() {
    this._seenDirty = true
    if (this._seenTimer) return
    this._seenTimer = setTimeout(() => {
      this._seenTimer = null
      void this._flushSeen()
    }, 1_000)
    if (typeof this._seenTimer?.unref === 'function') this._seenTimer.unref()
  }

  async _flushSeen() {
    if (!this._seenDirty) return
    this._seenDirty = false
    // Snapshot through a copy so a concurrent dedupe() cannot mutate the array
    // that is being serialized.
    this.seen.get().ids = [...this._seenOrder]
    await this.seen.save()
  }

  /** Flush any pending write (called on dispose). */
  async flush() {
    if (this._seenTimer) {
      clearTimeout(this._seenTimer)
      this._seenTimer = null
    }
    await this._flushSeen()
    await this.seen.save()
    await this.store.save()
  }
}

/** The stable, readable session id for one chat and workspace. */
export function sessionIdFor(chatId, workspace) {
  return `session-${safeId(chatId).slice(-24)}-${safeId(workspace).slice(-24)}`
}
