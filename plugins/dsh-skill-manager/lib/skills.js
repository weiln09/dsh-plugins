// dsh-skill-manager — skill layer
//
// Owns the managed library on disk plus the unified catalog view:
//   <dshHome>/skills-manager/<name>/SKILL.md
//   <dshHome>/skills-manager/state.json  → per-skill source, scope, enabled
//
// The catalog merges three sources so the panel shows every skill dsh can see:
//   1. `ctx.skills.list()` — bundled / runtime providers
//   2. a direct scan of the standard skill roots on disk
//   3. this plugin's managed library (the only writable part)

import { promises as fsp } from 'node:fs'
import { existsSync } from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { spawn } from 'node:child_process'

const NAME_RE = /^[a-z0-9][a-z0-9-]{0,62}$/

export function dshHome() {
  if (process.env.DSH_HOME) return process.env.DSH_HOME
  return path.join(os.homedir(), '.dsh')
}

export function libraryRoot() {
  return path.join(dshHome(), 'skills-manager')
}

function statePath() {
  return path.join(libraryRoot(), 'state.json')
}

export function nowIso() {
  return new Date().toISOString()
}

export function isValidName(name) {
  return typeof name === 'string' && NAME_RE.test(name)
}

function slugify(input) {
  return String(input || '').trim().toLowerCase()
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 63)
}

async function ensureDir(p) {
  await fsp.mkdir(p, { recursive: true })
}

async function readJson(file, fallback) {
  try {
    return JSON.parse(await fsp.readFile(file, 'utf8'))
  } catch {
    return fallback
  }
}

async function writeJsonAtomic(file, value) {
  await ensureDir(path.dirname(file))
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`
  await fsp.writeFile(tmp, JSON.stringify(value, null, 2), 'utf8')
  await fsp.rename(tmp, file)
}

// Parse the `--- key: value ---` frontmatter dsh uses for SKILL.md.
export function parseFrontmatter(text) {
  const normalized = String(text).replace(/\r\n?/g, '\n')
  if (!normalized.startsWith('---')) return { meta: {}, body: normalized }
  const end = normalized.indexOf('\n---', 3)
  if (end < 0) return { meta: {}, body: normalized }
  const head = normalized.slice(3, end).replace(/^\n/, '')
  const body = normalized.slice(end + 4).replace(/^\n/, '')
  const meta = {}
  let lastKey = null
  for (const line of head.split('\n')) {
    if (!line.trim()) continue
    const m = line.match(/^([A-Za-z0-9_-]+)\s*:\s*(.*)$/)
    if (m) {
      lastKey = m[1]
      let val = m[2].trim()
      if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
        val = val.slice(1, -1)
      }
      meta[lastKey] = val
    } else if (lastKey && /^\s+/.test(line)) {
      meta[lastKey] = `${meta[lastKey]} ${line.trim()}`.trim()
    }
  }
  return { meta, body }
}

export function buildSkillMarkdown({ name, description, body }) {
  const clean = String(body || '').replace(/\r\n?/g, '\n')
  const trimmed = clean.startsWith('#') ? clean : `# ${name}\n\n${clean}`.trimEnd()
  return `---\nname: ${name}\ndescription: ${String(description || '').replace(/\n/g, ' ').trim()}\n---\n\n${trimmed}\n`
}

function runCommand(cmd, args, opts = {}) {
  return new Promise((resolve) => {
    let child
    try {
      child = spawn(cmd, args, {
        cwd: opts.cwd, shell: false, windowsHide: true,
        env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
      })
    } catch (error) {
      resolve({ code: -1, stdout: '', stderr: String(error?.message || error) })
      return
    }
    let out = ''
    let err = ''
    child.stdout?.on('data', (d) => { out += d; if (out.length > 4e6) out = out.slice(-2e6) })
    child.stderr?.on('data', (d) => { err += d; if (err.length > 4e5) err = err.slice(-2e5) })
    const timer = setTimeout(() => { try { child.kill('SIGKILL') } catch {} }, opts.timeoutMs ?? 120_000)
    child.on('error', (error) => { clearTimeout(timer); resolve({ code: -1, stdout: out, stderr: String(error?.message || error) }) })
    child.on('close', (code) => { clearTimeout(timer); resolve({ code: code ?? -1, stdout: out, stderr: err }) })
  })
}

async function copyTree(src, dst) {
  await ensureDir(dst)
  for (const entry of await fsp.readdir(src, { withFileTypes: true })) {
    if (entry.name === '.git' || entry.name === 'node_modules') continue
    const s = path.join(src, entry.name)
    const d = path.join(dst, entry.name)
    if (entry.isDirectory()) await copyTree(s, d)
    else if (entry.isSymbolicLink()) continue
    else await fsp.copyFile(s, d)
  }
}

// Find the directory holding SKILL.md: the root itself or one level down.
async function locateSkillDir(dir) {
  if (existsSync(path.join(dir, 'SKILL.md'))) return dir
  for (const entry of await fsp.readdir(dir, { withFileTypes: true }).catch(() => [])) {
    if (entry.isDirectory()) {
      const nested = path.join(dir, entry.name)
      if (existsSync(path.join(nested, 'SKILL.md'))) return nested
    }
  }
  return null
}

async function extractZip(zipPath, destDir) {
  await ensureDir(destDir)
  const candidates = process.platform === 'win32'
    ? [['tar', ['-xf', zipPath, '-C', destDir]],
       ['powershell', ['-NoProfile', '-Command',
         `Expand-Archive -LiteralPath '${zipPath.replace(/'/g, "''")}' -DestinationPath '${destDir.replace(/'/g, "''")}' -Force`]]]
    : [['unzip', ['-o', zipPath, '-d', destDir]], ['tar', ['-xf', zipPath, '-C', destDir]]]
  let lastErr = 'no extraction tool available'
  for (const [cmd, args] of candidates) {
    const res = await runCommand(cmd, args, { timeoutMs: 60_000 })
    if (res.code === 0) return
    lastErr = `${cmd}: ${res.stderr || res.code}`
  }
  throw new Error(`Could not extract zip: ${lastErr}`)
}

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

// { version: 2, skills: { [name]: { name, source, description, enabled,
//   scope: { mode: 'global'|'workspaces', workspaces: string[] },
//   github?: { repo, ref, subdir }, createdAt, updatedAt } } }

export async function loadState() {
  const raw = await readJson(statePath(), { version: 2, skills: {} })
  if (!raw || typeof raw !== 'object') return { version: 2, skills: {} }
  if (!raw.skills || typeof raw.skills !== 'object') raw.skills = {}
  // Normalize rows written by earlier versions: every skill has an explicit
  // enabled flag and a scope, so callers never deal with a missing field.
  // A row whose folder is gone (removed outside the panel, or a failed delete)
  // is dropped here rather than shown as a ghost entry.
  for (const [name, entry] of Object.entries(raw.skills)) {
    if (!entry || typeof entry !== 'object') { delete raw.skills[name]; continue }
    if (!existsSync(path.join(skillDir(name), 'SKILL.md'))) { delete raw.skills[name]; continue }
    if (typeof entry.enabled !== 'boolean') entry.enabled = true
    if (!entry.scope || typeof entry.scope !== 'object') entry.scope = { mode: 'global', workspaces: [] }
  }
  raw.version = 2
  return raw
}

export async function saveState(state) {
  await writeJsonAtomic(statePath(), state)
}

export function skillDir(name) {
  return path.join(libraryRoot(), name)
}

/**
 * Parsed-SKILL.md cache keyed by `<path>` → { mtimeMs, size, text }.
 *
 * The catalog is rebuilt on every panel refresh and every agent step that
 * lists skills, and each rebuild used to read and parse every SKILL.md from
 * disk again. A `stat` is enough to know whether the cached text is still the
 * current one, so a refresh with nothing changed costs one stat per skill
 * instead of a read + parse.
 */
const skillFileCache = new Map()

export async function readSkillFile(name) {
  const file = path.join(skillDir(name), 'SKILL.md')
  try {
    const stat = await fsp.stat(file)
    const cached = skillFileCache.get(file)
    if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) return cached.text
    const text = await fsp.readFile(file, 'utf8')
    skillFileCache.set(file, { mtimeMs: stat.mtimeMs, size: stat.size, text })
    return text
  } catch {
    skillFileCache.delete(file)
    return null
  }
}

/** Forget one cached SKILL.md (after this plugin wrote it). */
export function invalidateSkillFile(name) {
  skillFileCache.delete(path.join(skillDir(name), 'SKILL.md'))
}

export function normalizeScope(scope) {
  if (!scope || scope.mode !== 'workspaces') return { mode: 'global', workspaces: [] }
  const ws = Array.isArray(scope.workspaces)
    ? scope.workspaces.filter((x) => typeof x === 'string' && x.trim())
    : []
  return ws.length === 0 ? { mode: 'global', workspaces: [] } : { mode: 'workspaces', workspaces: ws }
}

function normPath(p) {
  if (!p) return ''
  const v = path.resolve(p)
  return process.platform === 'win32' ? v.toLowerCase() : v
}

// Global skills are visible everywhere; workspace-scoped ones only when the
// viewing session's cwd lies inside one of their workspaces.
export function scopeAllowsEntry(scope, cwd) {
  const s = scope || { mode: 'global', workspaces: [] }
  if (s.mode !== 'workspaces') return true
  const list = Array.isArray(s.workspaces) ? s.workspaces : []
  if (list.length === 0 || !cwd) return false
  const target = normPath(cwd)
  return list.some((w) => {
    if (!w) return false
    const wn = normPath(w)
    return target === wn || target.startsWith(wn + path.sep) || wn.startsWith(target + path.sep)
  })
}

// ---------------------------------------------------------------------------
// Catalog
// ---------------------------------------------------------------------------

// Only the skills in this plugin's own library are writable.
export async function listManagedSkills() {
  const state = await loadState()
  const result = []
  for (const [name, entry] of Object.entries(state.skills)) {
    const md = await readSkillFile(name)
    if (md == null) continue
    const { meta } = parseFrontmatter(md)
    result.push({
      name,
      description: meta.description || entry.description || '',
      source: entry.source || 'manual',
      enabled: entry.enabled !== false,
      scope: entry.scope || { mode: 'global', workspaces: [] },
      github: entry.github || null,
      adoptedFrom: entry.adoptedFrom || null,
      createdAt: entry.createdAt || null,
      updatedAt: entry.updatedAt || null,
      path: skillDir(name),
      managed: true,
    })
  }
  return result.sort((a, b) => a.name.localeCompare(b.name))
}

function sourceGroup(source) {
  switch (source) {
    case 'user-dsh':
    case 'user-agents': return 'user'
    case 'project-dsh':
    case 'project-agents': return 'project'
    case 'bundled': return 'bundled'
    case 'runtime': return 'runtime'
    default: return 'other'
  }
}

// Skill roots dsh reads, in precedence order. The `skills` service does not
// always surface the user roots, so the catalog scans them directly.
export function skillRoots(cwd) {
  const roots = [
    { dir: path.join(dshHome(), 'skills'), source: 'user-dsh', group: 'user' },
    { dir: path.join(os.homedir(), '.agents', 'skills'), source: 'user-agents', group: 'user' },
  ]
  if (cwd) {
    roots.push({ dir: path.join(cwd, '.dsh', 'skills'), source: 'project-dsh', group: 'project' })
    roots.push({ dir: path.join(cwd, '.agents', 'skills'), source: 'project-agents', group: 'project' })
  }
  return roots
}

// Scan one root. Do not trust Dirent.isDirectory(): on Windows these roots are
// commonly symlinks (Dirent then reports a link, not a directory), so probe
// SKILL.md with stat(), which follows the link.
export async function scanSkillRoot(dir) {
  const found = []
  let entries
  try {
    entries = await fsp.readdir(dir, { withFileTypes: true })
  } catch {
    return found
  }
  for (const entry of entries) {
    const dirPath = path.join(dir, entry.name)
    const file = path.join(dirPath, 'SKILL.md')
    let raw
    try {
      const st = await fsp.stat(file)
      if (!st.isFile()) continue
      raw = await fsp.readFile(file, 'utf8')
    } catch {
      continue
    }
    const { meta } = parseFrontmatter(raw)
    const name = meta.name && isValidName(meta.name) ? meta.name : entry.name
    found.push({ name, description: meta.description || '', path: file, dir: dirPath })
  }
  return found
}

export async function listUnifiedSkills(ctx, cwd) {
  const managed = await listManagedSkills()
  const merged = new Map()

  const skillsSvc = ctx.get ? ctx.get('skills') : undefined
  if (skillsSvc && typeof skillsSvc.list === 'function') {
    try {
      for (const s of (await skillsSvc.list(cwd ? { cwd } : {})) || []) {
        merged.set(s.name, {
          name: s.name,
          description: s.description || '',
          whenToUse: s.whenToUse || '',
          provider: s.provider || '',
          dshSource: s.source || 'other',
          group: sourceGroup(s.source),
          path: s.path || (s.resourceBase && s.resourceBase.kind === 'directory' ? s.resourceBase.path : ''),
          managed: false,
          editable: false,
          adoptable: sourceGroup(s.source) === 'user' || sourceGroup(s.source) === 'project',
        })
      }
    } catch {
      // A provider failure must not take the panel down.
    }
  }

  for (const root of skillRoots(cwd)) {
    for (const found of await scanSkillRoot(root.dir)) {
      if (merged.has(found.name)) continue
      merged.set(found.name, {
        name: found.name,
        description: found.description,
        whenToUse: '',
        provider: `filesystem:${root.source}`,
        dshSource: root.source,
        group: root.group,
        path: found.path,
        managed: false,
        editable: false,
        // A folder on disk can be copied into the library, so it can be taken
        // over. Bundled skills come from inside dsh and have nothing to copy.
        adoptable: true,
      })
    }
  }

  for (const m of managed) {
    const base = merged.get(m.name) || {}
    // A managed skill supersedes any on-disk row of the same name, so it must
    // not inherit that row's adoptable flag.
    delete base.adoptable
    merged.set(m.name, {
      ...base,
      name: m.name,
      description: m.description || base.description || '',
      whenToUse: base.whenToUse || '',
      provider: base.provider || 'dsh-skill-manager',
      dshSource: base.dshSource || 'custom',
      group: 'managed',
      path: m.path,
      managed: true,
      editable: true,
      enabled: m.enabled,
      source: m.source,
      scope: m.scope,
      github: m.github,
      adoptedFrom: m.adoptedFrom || null,
      createdAt: m.createdAt,
      updatedAt: m.updatedAt,
    })
  }

  return [...merged.values()].sort((a, b) => a.name.localeCompare(b.name))
}

// ---------------------------------------------------------------------------
// Read / write one skill
// ---------------------------------------------------------------------------

export async function getSkill(name, ctx, cwd) {
  if (!isValidName(name)) throw new Error('Invalid skill name')
  const md = await readSkillFile(name)
  const state = await loadState()
  const entry = state.skills[name] || {}

  if (md != null) {
    const { meta, body } = parseFrontmatter(md)
    return {
      name,
      description: meta.description || entry.description || '',
      body, raw: md,
      source: entry.source || 'manual',
      enabled: entry.enabled !== false,
      scope: entry.scope || { mode: 'global', workspaces: [] },
      github: entry.github || null,
      adoptedFrom: entry.adoptedFrom || null,
      path: skillDir(name),
      managed: true, editable: true,
    }
  }

  const skillsSvc = ctx && ctx.get ? ctx.get('skills') : undefined
  if (skillsSvc && typeof skillsSvc.get === 'function') {
    try {
      const def = await skillsSvc.get(name, cwd ? { cwd } : {})
      if (def) {
        return {
          name, description: def.description || '',
          body: def.content || '', raw: def.content || '',
          source: def.source || 'other',
          enabled: true,
          scope: { mode: 'global', workspaces: [] },
          github: null,
          path: def.path || (def.resourceBase && def.resourceBase.kind === 'directory' ? def.resourceBase.path : ''),
          managed: false, editable: false, readOnly: true,
        }
      }
    } catch {
      // fall through to the disk scan
    }
  }

  for (const root of skillRoots(cwd)) {
    for (const found of await scanSkillRoot(root.dir)) {
      if (found.name !== name) continue
      const raw = await fsp.readFile(found.path, 'utf8').catch(() => null)
      if (raw == null) continue
      const { body } = parseFrontmatter(raw)
      return {
        name, description: found.description, body, raw,
        source: root.source,
        enabled: true,
        scope: { mode: 'global', workspaces: [] },
        github: null,
        path: found.path,
        managed: false, editable: false, readOnly: true,
      }
    }
  }
  throw new Error(`Skill "${name}" not found`)
}

async function writeSkillFiles(name, { description, body }) {
  const dir = skillDir(name)
  await ensureDir(dir)
  await fsp.writeFile(path.join(dir, 'SKILL.md'), buildSkillMarkdown({ name, description, body }), 'utf8')
  // The cache is keyed by mtime+size; rewriting within the same clock tick
  // could keep an equal stat, so the entry is dropped explicitly.
  invalidateSkillFile(name)
}

// Bring an existing on-disk skill under management.
//
// The source folder is left exactly as it is: user roots are commonly symlinks
// into a shared library (or a checkout the person still edits), so moving it
// would break that. We only copy it here, then record where it came from so the
// panel can say so and the person knows the original is untouched.
export async function adoptSkill({ name, from, scope, enabled }) {
  if (!isValidName(name)) throw new Error('Invalid skill name')
  const state = await loadState()
  if (state.skills[name]) throw new Error(`"${name}" is already managed here`)

  // Resolve the source: an explicit path, else the first root that has it.
  let sourceDir = ''
  if (from && String(from).trim()) {
    const wanted = String(from).trim()
    const asDir = wanted.endsWith('SKILL.md') ? path.dirname(wanted) : wanted
    if (existsSync(path.join(asDir, 'SKILL.md'))) sourceDir = asDir
  }
  if (!sourceDir) {
    for (const root of skillRoots()) {
      for (const found of await scanSkillRoot(root.dir)) {
        if (found.name === name) { sourceDir = found.dir; break }
      }
      if (sourceDir) break
    }
  }
  if (!sourceDir) throw new Error(`"${name}" was not found in a dsh skill folder`)

  const raw = await fsp.readFile(path.join(sourceDir, 'SKILL.md'), 'utf8')
  const { meta, body } = parseFrontmatter(raw)
  const description = meta.description || firstMeaningfulLine(body) || `Skill ${name}`

  // stat follows a symlink, which is what we want: copy its contents.
  const realSource = await fsp.realpath(sourceDir).catch(() => sourceDir)

  const dest = skillDir(name)
  await fsp.rm(dest, { recursive: true, force: true })
  await ensureDir(dest)
  await copyTree(sourceDir, dest)
  if (!meta.description) await writeSkillFiles(name, { description, body })

  const prev = state.skills[name] || {}
  state.skills[name] = {
    name,
    source: 'adopted',
    description,
    enabled: enabled !== undefined ? enabled !== false : prev.enabled !== false,
    scope: normalizeScope(scope),
    github: null,
    adoptedFrom: realSource,
    createdAt: prev.createdAt || nowIso(),
    updatedAt: nowIso(),
  }
  await saveState(state)
  return getSkill(name)
}

export async function createOrUpdateSkill({ name, description, body, scope, enabled, source, github = null, overwrite = true }) {
  if (!isValidName(name)) throw new Error('Name must be kebab-case (lowercase letters, digits, hyphens).')
  if (!description || !String(description).trim()) throw new Error('A description is required.')
  const state = await loadState()
  if (state.skills[name] && !overwrite) throw new Error(`Skill "${name}" already exists`)
  const prev = state.skills[name] || {}
  // Editing is not importing. A row's provenance (manual / github / zip /
  // adopted), its GitHub coordinates and where it was copied from all describe
  // where the skill CAME from, and an edit cannot change that. Overwriting
  // `source` with the caller's default silently turned every GitHub skill into
  // a manual one, which disabled "update from GitHub" for good, and dropped
  // `adoptedFrom` so the panel lost the pointer back to the original folder.
  const nextSource = source || prev.source || 'manual'
  // A caller that omits `scope` keeps the current one. `normalizeScope(undefined)`
  // answers "global", which would quietly widen a workspace-scoped skill to
  // every workspace as a side effect of editing its body.
  const nextScope = scope === undefined ? (prev.scope || normalizeScope(undefined)) : normalizeScope(scope)
  await writeSkillFiles(name, { description, body })
  state.skills[name] = {
    name,
    source: nextSource,
    description: String(description).trim(),
    enabled: enabled !== undefined ? enabled !== false : prev.enabled !== false,
    scope: nextScope,
    github: github || prev.github || null,
    ...(prev.adoptedFrom ? { adoptedFrom: prev.adoptedFrom } : {}),
    createdAt: prev.createdAt || nowIso(),
    updatedAt: nowIso(),
  }
  await saveState(state)
  return getSkill(name)
}

function requireManaged(state, name, action) {
  if (!state.skills[name]) {
    throw new Error(`"${name}" is a dsh-provided skill; ${action} is only available for skills managed here`)
  }
}

// Scope applies to managed skills (see the panel copy for the exact wording).
export async function setSkillScope(name, scope) {
  if (!isValidName(name)) throw new Error('Invalid skill name')
  const state = await loadState()
  requireManaged(state, name, 'changing scope')
  state.skills[name].scope = normalizeScope(scope)
  state.skills[name].updatedAt = nowIso()
  await saveState(state)
  return getSkill(name)
}

export async function setSkillEnabled(name, enabled) {
  if (!isValidName(name)) throw new Error('Invalid skill name')
  const state = await loadState()
  requireManaged(state, name, 'enabling or disabling')
  state.skills[name].enabled = enabled !== false
  state.skills[name].updatedAt = nowIso()
  await saveState(state)
  return getSkill(name)
}

export async function deleteSkill(name) {
  if (!isValidName(name)) throw new Error('Invalid skill name')
  const state = await loadState()
  requireManaged(state, name, 'deleting')
  delete state.skills[name]
  await saveState(state)
  const dir = skillDir(name)
  if (existsSync(dir)) await fsp.rm(dir, { recursive: true, force: true })
  invalidateSkillFile(name)
  return { deleted: name }
}

// ---------------------------------------------------------------------------
// Imports
// ---------------------------------------------------------------------------

async function adoptDirectory(skillDirFound, { name, description, body, source, scope, enabled, github }) {
  const dir = skillDir(name)
  await fsp.rm(dir, { recursive: true, force: true })
  await ensureDir(dir)
  await copyTree(skillDirFound, dir)
  invalidateSkillFile(name)
  if (!description) await writeSkillFiles(name, { description: `Skill ${name}`, body })
  const state = await loadState()
  const prev = state.skills[name] || {}
  state.skills[name] = {
    name, source, description,
    enabled: enabled !== undefined ? enabled !== false : prev.enabled !== false,
    scope: normalizeScope(scope),
    github: github || null,
    createdAt: prev.createdAt || nowIso(),
    updatedAt: nowIso(),
  }
  await saveState(state)
  return getSkill(name)
}

function firstMeaningfulLine(body) {
  return String(body).split('\n').map((l) => l.trim()).find((l) => l && !l.startsWith('#')) || ''
}

export async function importFromZip({ zipPath, scope, enabled }) {
  if (!zipPath || !existsSync(zipPath)) throw new Error('Zip file not found')
  const tmp = path.join(libraryRoot(), '.tmp', `zip-${Date.now()}`)
  await extractZip(zipPath, tmp)
  const found = await locateSkillDir(tmp)
  if (!found) throw new Error('No SKILL.md found in the zip')
  const { meta, body } = parseFrontmatter(await fsp.readFile(path.join(found, 'SKILL.md'), 'utf8'))
  const rawName = meta.name || path.basename(found)
  const name = isValidName(rawName) ? rawName : slugify(rawName)
  if (!isValidName(name)) throw new Error('Could not derive a valid skill name from the zip')
  try {
    return await adoptDirectory(found, {
      name,
      description: meta.description || firstMeaningfulLine(body) || `Imported skill ${name}`,
      body, source: 'zip', scope, enabled, github: null,
    })
  } finally {
    await fsp.rm(tmp, { recursive: true, force: true }).catch(() => {})
  }
}

// Accept anything a person is likely to paste:
//   owner/repo
//   https://github.com/owner/repo
//   https://github.com/owner/repo/tree/<branch>/<sub/dir>
//   https://github.com/owner/repo/blob/<branch>/<sub/dir>/SKILL.md
// A link that points at a folder carries its branch and subdirectory, which is
// exactly what the importer needs — dropping them was why a valid link failed.
function parseRepo(input) {
  const value = String(input || '').trim()
  if (!value) throw new Error('Repository is required')

  // Pull out a branch + path from a /tree/ or /blob/ URL before reducing to owner/repo.
  let ref = ''
  let subdir = ''

  const url = value.match(/^https?:\/\/(?:www\.)?github\.com\/([^/\s]+)\/([^/\s#?]+)(.*)$/i)
  if (url) {
    const owner = url[1]
    const name = url[2].replace(/\.git$/i, '')
    const rest = url[3] || ''
    const tree = rest.match(/^\/(?:tree|blob)\/([^/]+)\/?([^#?]*)/i)
    if (tree) {
      ref = decodeURIComponent(tree[1])
      const rawPath = decodeURIComponent(tree[2] || '').replace(/^\/+|\/+$/g, '')
      // A /blob/ link points at SKILL.md itself; everything above it is the skill.
      subdir = rawPath.replace(/\/?SKILL\.md$/i, '')
    }
    return { repo: `${owner}/${name}`, ref, subdir }
  }

  if (value.startsWith('git@')) {
    const ssh = value.match(/^git@github\.com:([^/\s]+)\/([^/\s]+?)(?:\.git)?$/i)
    if (!ssh) throw new Error('Repository must be owner/repo or a GitHub URL')
    return { repo: `${ssh[1]}/${ssh[2]}`, ref: '', subdir: '' }
  }

  const plain = value.replace(/\.git$/i, '').replace(/^\/+|\/+$/g, '')
  if (!/^[^/\s]+\/[^/\s]+$/.test(plain)) {
    throw new Error('Repository must be owner/repo or a GitHub URL')
  }
  return { repo: plain, ref: '', subdir: '' }
}

// `source` may be a URL carrying its own branch and subdirectory; a ref passed
// explicitly wins, because the field is the user's later, more specific answer.
async function cloneGithub(source, ref) {
  const parsed = parseRepo(source)
  const wantedRef = String(ref || '').trim() || parsed.ref
  const tmp = path.join(libraryRoot(), '.tmp', `git-${Date.now()}`)
  await ensureDir(path.dirname(tmp))
  const args = ['clone', '--depth', '1']
  if (wantedRef) args.push('--branch', wantedRef)
  args.push(`https://github.com/${parsed.repo}.git`, tmp)
  const res = await runCommand('git', args, { timeoutMs: 180_000 })
  if (res.code !== 0) {
    await fsp.rm(tmp, { recursive: true, force: true }).catch(() => {})
    const detail = (res.stderr || res.stdout || '').trim().slice(-400) || String(res.code)
    // Translate git's wording into the thing the person actually needs to fix.
    if (/Could not resolve host|Failed to connect|Connection (refused|timed out)|unable to access/i.test(detail)) {
      throw new Error('GitHub could not be reached. Check the network or proxy, then try again.')
    }
    if (wantedRef && /not found|Remote branch|unknown revision|couldn't find remote ref/i.test(detail)) {
      throw new Error(`Branch or tag "${wantedRef}" was not found. Use the branch name shown in the link.`)
    }
    if (/Repository not found|does not exist|not a git repository/i.test(detail)) {
      throw new Error(`Repository "${parsed.repo}" was not found, or it is private.`)
    }
    throw new Error(`git clone failed: ${detail}`)
  }
  return { tmp, repo: parsed.repo, ref: wantedRef, subdir: parsed.subdir }
}

export async function importFromGithub({ repo, ref, subdir, scope, enabled }) {
  const explicitSubdir = String(subdir || '').trim()
  const clone = await cloneGithub(repo, ref)
  const { tmp, repo: normalized } = clone
  // An explicit subdirectory beats the one carried by the link.
  const usedSubdir = explicitSubdir || clone.subdir
  try {
    let searchRoot = tmp
    if (usedSubdir) {
      searchRoot = path.join(tmp, usedSubdir)
      if (!existsSync(searchRoot)) {
        throw new Error(`Subdirectory "${usedSubdir}" was not found at ${clone.ref || 'the default branch'}`)
      }
    }
    const found = await locateSkillDir(searchRoot)
    if (!found) {
      throw new Error(usedSubdir
        ? `No SKILL.md in "${usedSubdir}". Point at the folder that holds SKILL.md.`
        : 'No SKILL.md found in the repository. Paste the link to the skill folder, or fill in its subdirectory.')
    }
    const { meta, body } = parseFrontmatter(await fsp.readFile(path.join(found, 'SKILL.md'), 'utf8'))
    const rawName = meta.name || path.basename(found)
    const name = isValidName(rawName) ? rawName : slugify(rawName)
    if (!isValidName(name)) throw new Error('Could not derive a valid skill name from the repository')
    return await adoptDirectory(found, {
      name,
      description: meta.description || firstMeaningfulLine(body) || `Imported skill ${name}`,
      body, source: 'github', scope, enabled,
      github: { repo: normalized, ref: clone.ref || 'HEAD', subdir: usedSubdir },
    })
  } finally {
    await fsp.rm(tmp, { recursive: true, force: true }).catch(() => {})
  }
}

export async function updateFromGithub(name) {
  if (!isValidName(name)) throw new Error('Invalid skill name')
  const state = await loadState()
  const entry = state.skills[name]
  if (!entry) throw new Error(`Skill "${name}" not found`)
  if (entry.source !== 'github' || !entry.github?.repo) {
    throw new Error('Only skills imported from GitHub can be updated this way')
  }
  const keepRef = entry.github.ref && entry.github.ref !== 'HEAD' ? entry.github.ref : ''
  const { tmp, repo: normalized } = await cloneGithub(entry.github.repo, keepRef)
  try {
    let searchRoot = tmp
    if (entry.github.subdir) {
      searchRoot = path.join(tmp, entry.github.subdir)
      if (!existsSync(searchRoot)) throw new Error(`Subdirectory "${entry.github.subdir}" not found`)
    }
    const found = await locateSkillDir(searchRoot)
    if (!found) throw new Error('No SKILL.md found at the source anymore')
    const { meta, body } = parseFrontmatter(await fsp.readFile(path.join(found, 'SKILL.md'), 'utf8'))
    const dir = skillDir(name)
    await fsp.rm(dir, { recursive: true, force: true })
    await ensureDir(dir)
    await copyTree(found, dir)
    if (!meta.description) await writeSkillFiles(name, { description: entry.description, body })
    entry.description = meta.description || entry.description
    entry.github = { repo: normalized, ref: keepRef || 'HEAD', subdir: entry.github.subdir || '' }
    entry.updatedAt = nowIso()
    await saveState(state)
    return getSkill(name)
  } finally {
    await fsp.rm(tmp, { recursive: true, force: true }).catch(() => {})
  }
}

export async function listRegisteredWorkspaces(ctx) {
  try {
    const svc = ctx.get ? ctx.get('workspaceRegistry') : undefined
    if (!svc || typeof svc.list !== 'function') return []
    return (await svc.list() || []).map((w) => ({
      id: w.id ?? '',
      title: w.title || w.path || '',
      path: w.path || '',
    }))
  } catch {
    return []
  }
}
