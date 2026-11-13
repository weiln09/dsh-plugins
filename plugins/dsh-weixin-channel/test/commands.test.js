import assert from 'node:assert/strict'
import test from 'node:test'

import {
  ADMIN_COMMANDS, PendingSelections, PENDING_TTL_MS, interpretNumber, menuFor, parseCommand,
} from '../lib/commands.js'

test('parses a Chinese command with arguments', () => {
  assert.deepEqual(parseCommand('/项目 2'), { name: 'workspace', raw: '/项目 2', args: ['2'] })
})

test('parses aliases and is case-insensitive', () => {
  assert.equal(parseCommand('/WS').name, 'workspace')
  assert.equal(parseCommand('/Help').name, 'help')
  assert.equal(parseCommand('/clear').name, 'new')
  assert.equal(parseCommand('/model').name, 'model')
})

test('every command answers to Chinese, English and a short form', () => {
  // Phones make long English commands unusable, so each one has a short alias.
  const cases = [
    ['/帮助', '/help', '/h'],
    ['/状态', '/status', '/st'],
    ['/新建', '/new', '/n'],
    ['/项目', '/project', '/ws'],
    ['/模型', '/model', '/m'],
    ['/思考', '/think', '/th'],
    ['/模式', '/permission', '/pm'],
    ['/回复', '/reply', '/rep'],
    ['/预设', '/preset', '/ps'],
    ['/计划', '/plan', '/pl'],
    ['/会话', '/sessions', '/ss'],
    ['/停止', '/stop', '/sp'],
    ['/重试', '/retry', '/rt'],
    ['/日志', '/log', '/lg'],
    ['/诊断', '/diag', '/dg'],
    ['/静音', '/mute', '/mu'],
    ['/解绑', '/unbind', '/ub'],
    // The question card tells the user to reply `/回答 <id> <选项>`; without
    // this alias the reply parsed as an unknown command and every question
    // could only time out into "skipped".
    ['/回答', '/answer', '/ans'],
    ['/审批', '/approve', '/ap'],
  ]
  for (const [zh, en, short] of cases) {
    const expected = parseCommand(zh).name
    assert.equal(parseCommand(en).name, expected, `${en} should mean ${expected}`)
    assert.equal(parseCommand(short).name, expected, `${short} should mean ${expected}`)
    assert.equal(parseCommand(short.toUpperCase()).name, expected, `${short} is case-insensitive`)
  }
})

test('a long alias is not a prefix trap', () => {
  // '/mo' must not silently mean model; only the listed aliases resolve.
  assert.equal(parseCommand('/mo'), null)
  assert.equal(parseCommand('/permissions'), null)
})

test('keeps an argument that itself contains spaces', () => {
  const parsed = parseCommand('/项目 D:\\github\\my project')
  assert.equal(parsed.name, 'workspace')
  assert.deepEqual(parsed.args, ['D:\\github\\my', 'project'])
})

test('rejects non-commands and unknown names', () => {
  assert.equal(parseCommand('帮我部署'), null)
  assert.equal(parseCommand('/nope'), null)
  assert.equal(parseCommand(''), null)
  assert.equal(parseCommand('/'), null)
})

test('tolerates surrounding whitespace, which phones add when pasting', () => {
  assert.equal(parseCommand('  /项目  ').name, 'workspace')
})

test('admin commands are exactly the authorization pair', () => {
  assert.deepEqual([...ADMIN_COMMANDS].sort(), ['revoke', 'trust'])
})

test('a menu always ends with the cancel line', () => {
  const text = menuFor('workspace', 'title', ['a', 'b'])
  assert.match(text, /1\. a/)
  assert.match(text, /2\. b/)
  assert.match(text, /0\. 取消/)
})

test('numbered selection maps to the option and 0 cancels', () => {
  const pending = { options: ['a', 'b'] }
  assert.deepEqual(interpretNumber(pending, '2'), { index: 2, value: 'b', cancelled: false })
  assert.deepEqual(interpretNumber(pending, '0'), { index: 0, value: null, cancelled: true })
  assert.deepEqual(interpretNumber(pending, '9'), { index: 9, value: null, cancelled: false })
  assert.equal(interpretNumber(pending, 'abc'), null)
})

test('a pending menu expires and disappears', async () => {
  const selections = new PendingSelections(20)
  selections.set('chat-1', 'model', ['a'])
  assert.ok(selections.get('chat-1'))
  await new Promise((resolve) => setTimeout(resolve, 40))
  assert.equal(selections.get('chat-1'), null)
})

test('a new menu replaces the previous one for the same chat', () => {
  const selections = new PendingSelections(PENDING_TTL_MS)
  selections.set('chat-1', 'model', ['a'])
  selections.set('chat-1', 'workspace', ['b'])
  assert.equal(selections.get('chat-1').kind, 'workspace')
})

test('sweep drops only expired menus', async () => {
  const selections = new PendingSelections(10)
  selections.set('old', 'model', ['a'])
  await new Promise((resolve) => setTimeout(resolve, 25))
  selections.set('fresh', 'model', ['b'])
  selections.sweep()
  assert.equal(selections.get('old'), null)
  assert.ok(selections.get('fresh'))
})
