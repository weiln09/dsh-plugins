import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, existsSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'

// `skills.js` resolves its library root from DSH_HOME at call time, so each
// test can point it at a throwaway directory before importing.
const home = mkdtempSync(path.join(tmpdir(), 'skill-manager-'))
process.env.DSH_HOME = home

const {
  createOrUpdateSkill, getSkill, loadState, saveState, setSkillScope, setSkillEnabled,
  deleteSkill, skillDir, normalizeScope, scopeAllowsEntry, isValidName,
} = await import('../lib/skills.js')

function reset() {
  rmSync(path.join(home, 'skills-manager'), { recursive: true, force: true })
}

test('a created skill is written to the library and recorded in state', async () => {
  reset()
  const skill = await createOrUpdateSkill({
    name: 'demo-skill', description: 'A demo', body: 'Do the thing.', overwrite: false,
  })
  assert.equal(skill.name, 'demo-skill')
  assert.equal(skill.description, 'A demo')
  assert.ok(existsSync(path.join(skillDir('demo-skill'), 'SKILL.md')))
  const state = await loadState()
  assert.equal(state.skills['demo-skill'].source, 'manual')
  assert.equal(state.skills['demo-skill'].enabled, true)
})

test('editing keeps a GitHub skill updatable', async () => {
  // Saving used to write source:'manual', which silently disabled
  // `updateFromGithub` for every skill imported from GitHub.
  reset()
  await createOrUpdateSkill({
    name: 'gh-skill', description: 'From GitHub', body: 'body', source: 'github',
    github: { repo: 'owner/repo', ref: 'main', subdir: '' }, overwrite: true,
  })
  const edited = await createOrUpdateSkill({
    name: 'gh-skill', description: 'Edited copy', body: 'new body', overwrite: true,
  })
  assert.equal(edited.source, 'github', 'the provenance survives an edit')
  assert.deepEqual(edited.github, { repo: 'owner/repo', ref: 'main', subdir: '' })
})

test('editing keeps an adopted skill pointing at its origin', async () => {
  reset()
  await createOrUpdateSkill({
    name: 'adopted-skill', description: 'Adopted', body: 'body', source: 'adopted', overwrite: true,
  })
  const state = await loadState()
  state.skills['adopted-skill'].adoptedFrom = 'D:\\origin\\adopted-skill'
  await saveState(state)

  const edited = await createOrUpdateSkill({
    name: 'adopted-skill', description: 'Adopted', body: 'changed', overwrite: true,
  })
  assert.equal(edited.adoptedFrom, 'D:\\origin\\adopted-skill')
  assert.equal(edited.source, 'adopted')
})

test('editing without a scope does not widen a workspace-scoped skill', async () => {
  reset()
  await createOrUpdateSkill({
    name: 'scoped-skill', description: 'Scoped', body: 'body', overwrite: false,
    scope: { mode: 'workspaces', workspaces: ['D:\\proj'] },
  })
  const edited = await createOrUpdateSkill({
    name: 'scoped-skill', description: 'Scoped', body: 'body changed', overwrite: true,
  })
  assert.deepEqual(edited.scope, { mode: 'workspaces', workspaces: ['D:\\proj'] })
})

test('a duplicate create is refused while an explicit save overwrites', async () => {
  reset()
  await createOrUpdateSkill({ name: 'dup', description: 'One', body: 'a', overwrite: false })
  await assert.rejects(
    () => createOrUpdateSkill({ name: 'dup', description: 'Two', body: 'b', overwrite: false }),
    /already exists/,
  )
  const updated = await createOrUpdateSkill({ name: 'dup', description: 'Two', body: 'b', overwrite: true })
  assert.equal(updated.description, 'Two')
})

test('a name that is not kebab-case is refused before anything is written', async () => {
  reset()
  await assert.rejects(
    () => createOrUpdateSkill({ name: 'Bad Name', description: 'x', body: 'y' }),
    /kebab-case/,
  )
  assert.equal(existsSync(skillDir('Bad Name')), false)
  assert.equal(isValidName('ok-name'), true)
  assert.equal(isValidName('-bad'), false)
})

test('a missing description is refused', async () => {
  reset()
  await assert.rejects(() => createOrUpdateSkill({ name: 'nodesc', description: '  ', body: 'x' }), /description/)
})

test('scope gating keeps a skill inside the workspaces it names', () => {
  const scope = { mode: 'workspaces', workspaces: ['D:\\proj'] }
  assert.equal(scopeAllowsEntry(scope, 'D:\\proj'), true)
  assert.equal(scopeAllowsEntry(scope, 'D:\\proj\\sub'), true)
  assert.equal(scopeAllowsEntry(scope, 'D:\\other'), false)
  assert.equal(scopeAllowsEntry({ mode: 'global', workspaces: [] }, 'D:\\other'), true)
  assert.equal(scopeAllowsEntry(scope, undefined), false, 'no cwd cannot prove membership')
})

test('an empty workspace list normalizes back to global', () => {
  assert.deepEqual(normalizeScope({ mode: 'workspaces', workspaces: [] }), { mode: 'global', workspaces: [] })
  assert.deepEqual(normalizeScope(null), { mode: 'global', workspaces: [] })
})

test('enable, scope and delete go through the managed row', async () => {
  reset()
  await createOrUpdateSkill({ name: 'lifecycle', description: 'Lifecycle', body: 'x', overwrite: false })
  const off = await setSkillEnabled('lifecycle', false)
  assert.equal(off.enabled, false)
  const scoped = await setSkillScope('lifecycle', { mode: 'workspaces', workspaces: ['D:\\proj'] })
  assert.deepEqual(scoped.scope, { mode: 'workspaces', workspaces: ['D:\\proj'] })

  await deleteSkill('lifecycle')
  assert.equal(existsSync(skillDir('lifecycle')), false)
  assert.equal((await loadState()).skills.lifecycle, undefined)
  await assert.rejects(() => getSkill('lifecycle', { get: () => undefined }), /not found/)
})

test('the SKILL.md cache follows a rewrite instead of serving stale text', async () => {
  reset()
  await createOrUpdateSkill({ name: 'cached', description: 'Cached', body: 'first', overwrite: false })
  const first = await getSkill('cached', { get: () => undefined })
  assert.match(first.body, /first/)

  // A rewrite inside the same clock tick could keep an identical mtime+size,
  // so the write path invalidates explicitly rather than trusting stat alone.
  await createOrUpdateSkill({ name: 'cached', description: 'Cached', body: 'second', overwrite: true })
  const second = await getSkill('cached', { get: () => undefined })
  assert.match(second.body, /second/)
  assert.doesNotMatch(second.body, /first/)
})

test('the catalog sees an edit made outside the panel', async () => {
  reset()
  await createOrUpdateSkill({ name: 'outside', description: 'Outside', body: 'original', overwrite: false })
  await getSkill('outside', { get: () => undefined })
  // Another tool rewrote the file: the cache must notice through stat.
  writeFileSync(path.join(skillDir('outside'), 'SKILL.md'),
    '---\nname: outside\ndescription: Edited outside\n---\n\n# outside\n\nchanged body\n')
  const fresh = await getSkill('outside', { get: () => undefined })
  assert.equal(fresh.description, 'Edited outside')
  assert.match(fresh.body, /changed body/)
})

test('a row whose folder disappeared is dropped from state', async () => {
  reset()
  await createOrUpdateSkill({ name: 'ghost', description: 'Ghost', body: 'x', overwrite: false })
  rmSync(skillDir('ghost'), { recursive: true, force: true })
  const state = await loadState()
  assert.equal(state.skills.ghost, undefined)
})

test.after(() => { rmSync(home, { recursive: true, force: true }) })
