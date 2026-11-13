import assert from 'node:assert/strict'
import test from 'node:test'

import { MAX_TEXT_CHARS, extractText, messageId, splitText } from '../lib/ilink.js'
import { clip, helpText, markdownToText, menu, modelLabel, resultCard, statusCard } from '../lib/render.js'

test('markdown headings become bracketed titles and links keep their URL', () => {
  // The old marker (one '▍' per level) arrived on a phone as 「▍▍ 概览」, which
  // reads as a stray pair of bars rather than a heading.
  const text = markdownToText('# 标题\n\n## 二级\n\n### 三级\n\n见 [文档](https://example.com)')
  assert.match(text, /【标题】/)
  assert.match(text, /【二级】/)
  assert.match(text, /『三级』/)
  assert.doesNotMatch(text, /▍/)
  assert.match(text, /文档 \(https:\/\/example\.com\)/)
})

test('bold and italic keep a visible marker instead of vanishing', () => {
  // WeChat has no bold/italic; dropping the markers lost the emphasis the model
  // wrote on purpose, so it is wrapped instead.
  const text = markdownToText('**字段**：`control_flag` 控制标志')
  assert.match(text, /「字段」/)
  assert.match(text, /control_flag/)
  assert.match(markdownToText('这是 *重点* 内容'), /\/重点\//)
})

test('fenced code is preserved verbatim', () => {
  const text = markdownToText('前\n```js\nconst a = 1 ** 2\n```\n后')
  assert.match(text, /const a = 1 \*\* 2/)
})

test('identifiers keep their underscores', () => {
  // The desktop chat showed prd_code / model_flag; WeChat showed prdcode and
  // modelcommen because the emphasis rule paired the underscores of two
  // adjacent identifiers and deleted both.
  const text = markdownToText('基本标识（1-7） prd_code 产品代码（PK）、model_flag 产品归属类别、model_comment 模板说明')
  assert.match(text, /prd_code/)
  assert.match(text, /model_flag/)
  assert.match(text, /model_comment/)
})

test('inline code is preserved literally, emphasis inside it untouched', () => {
  const text = markdownToText('用 `user_id` 和 `a_b_c`，强调 **加粗** 与 *斜体*')
  assert.match(text, /user_id/)
  assert.match(text, /a_b_c/)
  assert.match(text, /加粗/)
  assert.match(text, /斜体/)
  assert.doesNotMatch(text, /\*\*/)
})

test('snake_case inside a sentence survives without backticks', () => {
  const text = markdownToText('字段 user_id 与 order_no 都在这张表里')
  assert.match(text, /user_id/)
  assert.match(text, /order_no/)
})

test('no Markdown syntax survives into the bubble', () => {
  // WeChat renders none of it, so a bubble must not contain **, ##, ` or | --- .
  const text = markdownToText([
    '## 概览',
    '',
    '**字段**：`control_flag` 控制标志',
    '',
    '| 位号 | 含义 |',
    '| --- | --- |',
    '| 1 | 开关 |',
  ].join('\n'))
  assert.doesNotMatch(text, /\*\*/)
  assert.doesNotMatch(text, /^#/m)
  assert.doesNotMatch(text, /`/)
  assert.doesNotMatch(text, /\|\s*-{3,}/)
  assert.match(text, /【概览】/)
  assert.match(text, /「字段」/)
  assert.match(text, /control_flag/)
})

test('table separator rows are dropped', () => {
  const text = markdownToText('| a | b |\n| --- | --- |\n| 1 | 2 |')
  assert.equal(text, 'a | b\n1 | 2')
})

test('every authored line becomes its own paragraph', () => {
  // A single \n is a Markdown soft break: the client shows it as a space, so
  // the whole /帮助 text arrived as two long glued lines. Only a blank line
  // really breaks a paragraph, so the renderer has to insert one.
  const text = markdownToText('第一行\n第二行\n第三行')
  assert.equal(text, '第一行\n\n第二行\n\n第三行')
})

test('the help text puts every command on a line of its own', () => {
  const rendered = markdownToText(helpText())
  const commands = rendered.split('\n').filter((line) => line.startsWith('/'))
  assert.ok(commands.length >= 18, `expected all commands, saw ${commands.length}`)
  // No line may carry two commands, which is what the glued bubble looked like.
  for (const line of commands) assert.equal(line.split('/').length - 1, 1, `two commands on one line: ${line}`)
  // Each command line is separated from its neighbours by a blank line.
  const lines = rendered.split('\n')
  for (let i = 0; i < lines.length; i += 1) {
    if (!lines[i].startsWith('/')) continue
    if (i > 0 && lines[i - 1].trim() && !lines[i - 1].startsWith('【')) assert.fail(`no blank line before: ${lines[i]}`)
    if (i + 1 < lines.length && lines[i + 1].trim()) assert.fail(`no blank line after: ${lines[i]}`)
  }
})

test('code fences keep their own line breaks', () => {
  // Blank lines injected inside a fence would change the code itself.
  const text = markdownToText('前\n```\na\n\nb\n```\n后')
  assert.equal(text, '前\n\n```\na\n\nb\n```\n\n后')
})

test('rendering twice changes nothing', () => {
  // Notify code re-renders buffered text; the paragraph rule must be a fixpoint.
  const once = markdownToText(helpText())
  assert.equal(markdownToText(once), once)
})

test('short text is a single chunk', () => {
  assert.deepEqual(splitText('hello'), ['hello'])
})

test('long text splits under the limit without losing characters', () => {
  const body = Array.from({ length: 400 }, (_, index) => `第 ${index} 行内容`).join('\n')
  const chunks = splitText(body, 500)
  assert.ok(chunks.length > 1)
  for (const chunk of chunks) assert.ok(chunk.length <= 500, `chunk too long: ${chunk.length}`)
  assert.equal(chunks.join('\n').replace(/\s+/g, ''), body.replace(/\s+/g, ''))
})

test('splitting never produces a lone surrogate', () => {
  const body = '😀'.repeat(3000)
  const chunks = splitText(body, 100)
  for (const chunk of chunks) {
    const last = chunk.charCodeAt(chunk.length - 1)
    assert.ok(!(last >= 0xd800 && last <= 0xdbff), 'chunk ends with a high surrogate')
  }
})

test('the default limit is the conservative WeChat message budget', () => {
  // 2000 is what every community implementation settles on; a longer message
  // can be rejected, which looks like lost text rather than a failed send.
  assert.equal(MAX_TEXT_CHARS, 2_000)
})

test('inbound text prefers text items and falls back to voice transcription', () => {
  assert.equal(extractText({ item_list: [{ type: 1, text_item: { text: ' hi ' } }] }), 'hi')
  assert.equal(extractText({ item_list: [{ type: 3, voice_item: { text: '转写' } }] }), '转写')
  assert.equal(extractText({ item_list: [{ type: 2 }] }), '')
})

test('message id prefers the platform id and falls back to client id', () => {
  assert.equal(messageId({ message_id: 42 }), '42')
  assert.equal(messageId({ client_id: 'abc' }), 'abc')
  assert.equal(messageId({}), null)
})

test('clip trims on a line boundary and points at /日志', () => {
  const body = `${'a'.repeat(50)}\n${'b'.repeat(50)}`
  const clipped = clip(body, 60)
  assert.ok(clipped.length < body.length + 40)
  assert.match(clipped, /\/日志/)
})

test('result card carries status, duration and usage', () => {
  const card = resultCard({
    status: 'completed', summary: 'done', durationMs: 1500,
    usage: { inputTokens: 10, outputTokens: 20 }, modelLabel: 'p/m',
  })
  assert.match(card, /✅ 完成/)
  assert.match(card, /1\.5s/)
  assert.match(card, /10 in \/ 20 out/)
  assert.match(card, /p\/m/)
})

test('error status falls back to a readable label', () => {
  assert.match(resultCard({ status: 'error' }), /❌ 失败/)
})

test('menu numbers options and ends with cancel', () => {
  assert.equal(menu('t', ['a', 'b']), 't\n1. a\n2. b\n0. 取消')
})

test('status card shows the per-chat switches', () => {
  const card = statusCard({
    workspace: 'D:\\w', model: 'p/m', sessionId: 's-1', agentPreset: 'standard',
    permissionPreset: 'workspace-write',
    planMode: true, running: false, queued: 0, connected: true, lastEventAt: Date.now(),
    workspaceCount: 3, muted: false, granularity: 'standard',
  })
  assert.match(card, /工作区：D:\\w/)
  assert.match(card, /预设：standard/)
  assert.match(card, /计划模式/)
  assert.match(card, /回复 standard/)
})

test('the help text no longer names another product', () => {
  // The command surface is described on its own terms, never by naming another product.
  assert.doesNotMatch(helpText(), /ZCode/)
  assert.match(helpText(), /\/预设/)
})

test('argument placeholders survive the HTML strip', () => {
  // `<[^>]+>` also ate `<code>` / `<id>`, so the help line told users to send
  // "/审批" with no argument at all.
  const text = markdownToText('用法：/审批 <编号> 允许|拒绝')
  assert.match(text, /<编号>/)
  assert.match(text, /<编号>/)
  // A real tag is still dropped.
  assert.doesNotMatch(markdownToText('前 <b>粗</b> 后'), /<\/?b>/)
})

test('the help text separates commands with blank lines itself', () => {
  // The source already carries the paragraph breaks: WeChat folds a lone
  // newline into a space, so a renderer that only strips Markdown (an older
  // build, or any other channel) must still get one command per paragraph.
  const help = helpText()
  for (const line of help.split('\n')) {
    assert.ok(!line.includes('/帮助') || !line.includes('/状态'), `two commands on one line: ${line}`)
  }
  assert.match(help, /\n\n\/模型（model，m）: 切换模型\n\n/)
  assert.doesNotMatch(help, /[^\n]\n\/状态（status，st）/)
})

test('the help text puts one command per line, English in brackets', () => {
  const help = helpText()
  // 中文命令（英文全称，短写）: 中文描述 —— 一行一条。
  assert.match(help, /^\/模型（model，m）: 切换模型$/m)
  assert.match(help, /^\/回复（reply，rep）: 调整回复详细程度$/m)
  assert.match(help, /^\/项目（project，ws）: 切换工作区$/m)
  assert.match(help, /^\/状态（status，st）: /m)
  // 一行里不再塞两个命令：静音和恢复各自成行。
  assert.match(help, /^\/静音（mute，mu）: /m)
  assert.match(help, /^\/恢复（unmute，un）: /m)
  assert.doesNotMatch(help, /· \/恢复/)
  // 描述只有中文：行尾不再出现 " / english"。
  const descriptionLines = help.split('\n').filter((line) => line.startsWith('/'))
  assert.ok(descriptionLines.length >= 20)
  for (const line of descriptionLines) {
    const description = line.slice(line.indexOf(':') + 1)
    assert.doesNotMatch(description, /[A-Za-z]/, `英文混进了描述：${line}`)
  }
  // 太长的英文写法不作为主写法出现。
  assert.doesNotMatch(help, /\/granularity/)
  assert.doesNotMatch(help, /\/permission /)
})

test('a model label omits an absent effort', () => {
  assert.equal(modelLabel({ provider: 'p', model: 'm' }), 'p/m')
  assert.equal(modelLabel({ provider: 'p', model: 'm', reasoningEffort: 'high' }), 'p/m · high')
  assert.equal(modelLabel(null), '')
})
