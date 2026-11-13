// Atomic JSON state store for the Weixin channel.
//
// Everything the plugin must survive a restart lives here: accounts, chat
// bindings, long-poll cursors, and defaults. Files are written atomically
// (tmp + rename) with 0600 permissions, because the same directory holds the
// bot token when the operator prefers a file over an `env:` reference.

import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import path from 'node:path'

/** Resolve the state directory: explicit config, then `$DSH_HOME`, then `~/.dsh`. */
export function resolveStateDir(configured) {
  if (configured && String(configured).trim()) return path.resolve(String(configured).trim())
  const home = process.env.DSH_HOME?.trim()
  const base = home || path.join(homedir(), '.dsh')
  return path.join(base, 'integrations', 'dsh-weixin-channel')
}

/** Read one JSON file, returning `fallback` for a missing or unparsable file. */
export function readJson(file, fallback) {
  try {
    return JSON.parse(readFileSync(file, 'utf8'))
  } catch {
    return fallback
  }
}

/** Write one JSON file atomically and restrict it to the owner. */
export function writeJson(file, value) {
  mkdirSync(path.dirname(file), { recursive: true })
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`
  writeFileSync(tmp, JSON.stringify(value, null, 2), { mode: 0o600 })
  renameSync(tmp, file)
  try {
    chmodSync(file, 0o600)
  } catch {
    // A filesystem without POSIX modes (e.g. some network shares) is not fatal.
  }
}

/**
 * A small serialized store: every `save()` waits for the previous write, so
 * two concurrent turns cannot interleave a read-modify-write cycle.
 */
export class JsonStore {
  constructor(file, fallback) {
    this.file = file
    this.fallback = fallback
    this.value = readJson(file, fallback)
    this._chain = Promise.resolve()
  }

  get() {
    return this.value
  }

  /** Replace the in-memory value and persist it after any queued write. */
  save(next) {
    if (next !== undefined) this.value = next
    const snapshot = this.value
    this._chain = this._chain.then(() => writeJson(this.file, snapshot)).catch(() => {})
    return this._chain
  }

  /** Mutate in place and persist. */
  update(mutator) {
    mutator(this.value)
    return this.save()
  }
}

/** Replace characters unsafe in a session id, keeping the id readable. */
export function safeId(value) {
  return String(value ?? '').replace(/[^A-Za-z0-9._-]/g, '-').replace(/^-+|-+$/g, '')
}

/** Mask an account or chat id for logs and API responses. */
export function maskId(value, keep = 6) {
  const text = String(value ?? '')
  if (text.length <= keep * 2) return text
  return `${text.slice(0, keep)}…${text.slice(-4)}`
}
