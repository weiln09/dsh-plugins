// @local/dsh-skill-manager — Host half
//
// Registers a `skills` provider for the managed library, an HTTP API for the
// panel, and an agent tool sharing the same operations. All skill logic lives
// in ./skills.js.

import { promises as fsp } from 'node:fs'
import path from 'node:path'

import {
  libraryRoot, listUnifiedSkills, listRegisteredWorkspaces,
  getSkill, createOrUpdateSkill, setSkillScope, setSkillEnabled, deleteSkill, adoptSkill,
  importFromZip, importFromGithub, updateFromGithub,
  loadState, readSkillFile, scopeAllowsEntry, skillDir, parseFrontmatter,
} from './skills.js'

// ---------------------------------------------------------------------------
// HTTP API
// ---------------------------------------------------------------------------

// A zip travels base64-encoded, so the ceiling is generous but still bounded.
const MAX_BODY = 64 * 1024 * 1024

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    let failed = false
    req.on('data', (chunk) => {
      if (failed) return
      size += chunk.length
      if (size > MAX_BODY) {
        failed = true
        reject(new Error('Upload is larger than 64 MB'))
        try { req.destroy() } catch {}
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => { if (!failed) resolve(Buffer.concat(chunks).toString('utf8')) })
    req.on('error', (e) => { if (!failed) { failed = true; reject(e) } })
  })
}

// A handler route owns the full request/response cycle. (A `resource` route
// only answers GET/HEAD, so POST would come back 405.)
function makeApiHandler(ctx, invalidateProvider) {
  return async (req, res) => {
    res.setHeader('content-type', 'application/json; charset=utf-8')
    res.setHeader('cache-control', 'no-store')
    const send = (status, obj) => { res.statusCode = status; res.end(JSON.stringify(obj)) }

    let payload = {}
    try {
      if (req.method === 'POST') {
        const text = await readBody(req)
        payload = text ? JSON.parse(text) : {}
      } else {
        payload = Object.fromEntries(new URL(req.url, 'http://localhost').searchParams.entries())
      }
    } catch (error) {
      send(400, { ok: false, error: `Bad request: ${error?.message || error}` }); return
    }

    const action = payload.action
    const cwd = payload.cwd || undefined

    try {
      switch (action) {
        case 'list':
        case 'rescan': {
          if (action === 'rescan') {
            try { invalidateProvider() } catch {}
          }
          send(200, {
            ok: true,
            skills: await listUnifiedSkills(ctx, cwd),
            workspaces: await listRegisteredWorkspaces(ctx),
            library: libraryRoot(),
          })
          return
        }
        case 'get':
          send(200, { ok: true, skill: await getSkill(payload.name, ctx, cwd) }); return
        case 'create':
          send(200, { ok: true, skill: await createOrUpdateSkill({
            name: payload.name, description: payload.description, body: payload.body,
            scope: payload.scope, enabled: payload.enabled, source: 'manual', overwrite: false,
          }) }); return
        case 'save':
          send(200, { ok: true, skill: await createOrUpdateSkill({
            name: payload.name, description: payload.description, body: payload.body,
            scope: payload.scope, enabled: payload.enabled, source: payload.source || 'manual', overwrite: true,
          }) }); return
        case 'delete':
          send(200, { ok: true, ...(await deleteSkill(payload.name)) }); return
        case 'setScope':
          send(200, { ok: true, skill: await setSkillScope(payload.name, payload.scope) }); return
        case 'setEnabled':
          send(200, { ok: true, skill: await setSkillEnabled(payload.name, payload.enabled) }); return
        case 'adopt':
          send(200, { ok: true, skill: await adoptSkill({
            name: payload.name, from: payload.from, scope: payload.scope, enabled: payload.enabled,
          }) }); return
        case 'importZip':
          send(200, { ok: true, skill: await importFromZip({
            zipPath: payload.zipPath, scope: payload.scope, enabled: payload.enabled,
          }) }); return
        case 'importZipUpload': {
          // The browser can pick a file but cannot read its absolute path, so
          // the bytes come here and land in a temp file the importer accepts.
          const { data, filename } = payload
          if (typeof data !== 'string' || data === '') throw new Error('No file data was uploaded')
          const bytes = Buffer.from(data, 'base64')
          if (bytes.length === 0) throw new Error('The chosen file is empty')
          if (bytes.length > 48 * 1024 * 1024) throw new Error('The zip is larger than 48 MB')
          const tmpDir = path.join(libraryRoot(), '.tmp')
          await fsp.mkdir(tmpDir, { recursive: true })
          const safeName = String(filename || 'skill.zip').replace(/[^\w.-]+/g, '_').slice(-80) || 'skill.zip'
          const tmpZip = path.join(tmpDir, `upload-${Date.now()}-${safeName}`)
          await fsp.writeFile(tmpZip, bytes)
          try {
            send(200, { ok: true, skill: await importFromZip({
              zipPath: tmpZip, scope: payload.scope, enabled: payload.enabled,
            }) })
          } finally {
            await fsp.rm(tmpZip, { force: true }).catch(() => {})
          }
          return
        }
        case 'importGithub':
          send(200, { ok: true, skill: await importFromGithub({
            repo: payload.repo, ref: payload.ref, subdir: payload.subdir,
            scope: payload.scope, enabled: payload.enabled,
          }) }); return
        case 'update':
          send(200, { ok: true, skill: await updateFromGithub(payload.name) }); return
        default:
          send(404, { ok: false, error: `Unknown action: ${action}` }); return
      }
    } catch (error) {
      send(400, { ok: false, error: String(error?.message || error) })
    }
  }
}

// ---------------------------------------------------------------------------
// Plugin
// ---------------------------------------------------------------------------

export const name = 'dsh-skill-manager'

export const inject = {
  optional: ['skills', 'webServer', 'workspaceRegistry', 'tools'],
}

export function apply(ctx) {
  fsp.mkdir(libraryRoot(), { recursive: true }).catch(() => {})

  let invalidateProvider = null

  // 1) Serve the managed library through the skills registry. Disabled skills
  //    are simply not returned, which is what the toggle means.
  const skillsService = ctx.get?.('skills')
  if (skillsService && typeof skillsService.registerProvider === 'function') {
    ctx.effect(() => skillsService.registerProvider((control) => {
      invalidateProvider = () => { try { control.invalidate() } catch {} }
      return {
        name: 'dsh-skill-manager',
        async list(options) {
          const state = await loadState()
          const cwd = options?.cwd
          const candidates = []
          for (const [skillName, entry] of Object.entries(state.skills)) {
            if (entry.enabled === false) continue
            if (!scopeAllowsEntry(entry.scope, cwd)) continue
            const md = await readSkillFile(skillName)
            if (md == null) continue
            const { meta } = parseFrontmatter(md)
            candidates.push({
              name: skillName,
              description: meta.description || entry.description || '',
              invocation: { modelInvocable: true, userInvocable: true },
              source: 'custom',
              provider: 'dsh-skill-manager',
              rank: 100,
              locator: { name: skillName },
              path: path.join(skillDir(skillName), 'SKILL.md'),
              resourceBase: { kind: 'directory', path: skillDir(skillName) },
            })
          }
          return candidates
        },
        async get(candidate) {
          const skillName = candidate?.locator?.name || candidate?.name
          const md = await readSkillFile(skillName)
          if (md == null) return undefined
          const { meta, body } = parseFrontmatter(md)
          return {
            name: skillName,
            description: meta.description || '',
            content: body,
            invocation: { modelInvocable: true, userInvocable: true },
            source: 'custom',
            provider: 'dsh-skill-manager',
            path: path.join(skillDir(skillName), 'SKILL.md'),
            resourceBase: { kind: 'directory', path: skillDir(skillName) },
          }
        },
      }
    }), 'dsh-skill-manager.skills-provider')
  }

  // 2) HTTP API for the panel.
  const webServer = ctx.get?.('webServer')
  if (webServer && typeof webServer.register === 'function') {
    const handler = makeApiHandler(ctx, () => { if (typeof invalidateProvider === 'function') invalidateProvider() })
    ctx.effect(() => webServer.register({
      kind: 'prefix',
      path: '/skill-manager/api',
      handler,
    }), 'dsh-skill-manager.api-route')
  }

  // 3) The same operations for the agent.
  const tools = ctx.get?.('tools')
  if (tools && typeof tools.register === 'function') {
    ctx.effect(() => tools.register({
      name: 'skill_manager',
      description:
        'Manage the skills installed in Skill Manager: list every skill dsh can see, read one, create or edit a managed skill, delete it, import from zip or GitHub, update a GitHub-sourced skill, and change a managed skill\'s workspace scope or enabled state.',
      parameters: {
        type: 'object',
        properties: {
          action: {
            type: 'string',
            enum: ['list', 'get', 'create', 'save', 'delete', 'setScope', 'setEnabled', 'adopt', 'importZip', 'importGithub', 'update'],
            description: 'Operation to perform.',
          },
          name: { type: 'string', description: 'Skill name (kebab-case).' },
          description: { type: 'string', description: 'One-line description (create/save).' },
          body: { type: 'string', description: 'SKILL.md markdown body (create/save).' },
          enabled: { type: 'boolean', description: 'Whether the skill is offered to agents.' },
          scope: {
            type: 'object',
            description: 'Workspace scope; omit or set mode "global" to allow every workspace.',
            properties: {
              mode: { type: 'string', enum: ['global', 'workspaces'] },
              workspaces: { type: 'array', items: { type: 'string' } },
            },
          },
          from: { type: 'string', description: 'Folder or SKILL.md path of an on-disk skill to take over (adopt). Omit to look it up in the dsh skill folders.' },
          zipPath: { type: 'string', description: 'Absolute path to a .zip (importZip).' },
          repo: { type: 'string', description: 'GitHub owner/repo or URL (importGithub).' },
          ref: { type: 'string', description: 'Branch, tag, or commit (importGithub).' },
          subdir: { type: 'string', description: 'Subdirectory inside the repo (importGithub).' },
        },
        required: ['action'],
      },
      output: {
        schema: { type: 'object', additionalProperties: true },
        render(_args, value) {
          return [{ type: 'text', text: JSON.stringify(value, null, 2) }]
        },
      },
      async execute(args) {
        switch (args.action) {
          case 'list': return { ok: true, skills: await listUnifiedSkills(ctx) }
          case 'get': return { ok: true, skill: await getSkill(args.name, ctx) }
          case 'create': return { ok: true, skill: await createOrUpdateSkill({
            name: args.name, description: args.description, body: args.body,
            scope: args.scope, enabled: args.enabled, overwrite: false,
          }) }
          case 'save': return { ok: true, skill: await createOrUpdateSkill({
            name: args.name, description: args.description, body: args.body,
            scope: args.scope, enabled: args.enabled, overwrite: true,
          }) }
          case 'delete': return { ok: true, ...(await deleteSkill(args.name)) }
          case 'setScope': return { ok: true, skill: await setSkillScope(args.name, args.scope) }
          case 'setEnabled': return { ok: true, skill: await setSkillEnabled(args.name, args.enabled) }
          case 'adopt': return { ok: true, skill: await adoptSkill({
            name: args.name, from: args.from, scope: args.scope, enabled: args.enabled,
          }) }
          case 'importZip': return { ok: true, skill: await importFromZip({
            zipPath: args.zipPath, scope: args.scope, enabled: args.enabled,
          }) }
          case 'importGithub': return { ok: true, skill: await importFromGithub({
            repo: args.repo, ref: args.ref, subdir: args.subdir, scope: args.scope, enabled: args.enabled,
          }) }
          case 'update': return { ok: true, skill: await updateFromGithub(args.name) }
          default: throw new Error(`Unknown action: ${args.action}`)
        }
      },
    }), 'dsh-skill-manager.tool')
  }
}

export default apply
