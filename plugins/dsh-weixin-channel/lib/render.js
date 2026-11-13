// Rendering for WeChat: Markdown down to phone-friendly plain text, plus the
// small cards the channel sends (status, menus, results, approvals).
//
// WeChat renders no Markdown at all — not bold, not headings, not tables. The
// renderer therefore produces text that is READABLE AS-IS and never looks like
// leftover syntax: headings become 【标题】, bold becomes 「重点」, inline code
// loses only its backticks. It is also the safety net for a model that writes
// Markdown anyway, whatever the channel instruction says.

import { MAX_TEXT_CHARS } from './ilink.js'

/**
 * Strip emphasis from one run of Markdown prose.
 *
 * Underscores are deliberately **not** treated as emphasis. A coding chat is
 * full of `prd_code`, `model_flag`, `__init__` and `USER_ID`; pairing the
 * underscores of two adjacent identifiers (`prd_code … model_flag`) deleted
 * both of them, so WeChat showed `prdcode` while the desktop chat showed the
 * real names. Asterisk emphasis stays, because no identifier uses it.
 */
function stripEmphasis(line) {
  return line
    .replace(/\*\*([^*]+)\*\*/g, `${EMPHASIS_OPEN}$1${EMPHASIS_CLOSE}`)
    .replace(/(^|[^*])\*([^*\n]+)\*/g, '$1/$2/')
    .replace(/~~([^~]+)~~/g, '$1')
    // Only real HTML tags are dropped. `<[^>]+>` also ate the placeholders the
    // help text uses for arguments (`/审批 <编号>` rendered as `/审批`), which
    // silently removed the one thing the user needed to know.
    .replace(/<\/?[a-zA-Z][a-zA-Z0-9-]*(\s[^<>]*)?\/?>/g, '')
}

/**
 * Whether a line belongs to the table block that is already open.
 *
 * Table rows are the one construct that must stay adjacent: WeChat renders the
 * table itself, and a blank line between rows would break it into fragments.
 */
function isTableRow(line) {
  return /^\s*\|.*\|\s*$/.test(line)
}

/** Reduce Markdown to plain text that still reads well in a chat bubble. */
export function markdownToText(md) {
  if (typeof md !== 'string') return ''
  const out = []
  let inFence = false
  let prev = ''
  // A lone \n is a Markdown **soft break**, which WeChat shows as a space: two
  // authored lines arrive glued into one. Every block of text therefore gets a
  // blank line after it, except inside a table (rows must stay adjacent) and
  // inside fenced code (byte for byte).
  const push = (line, kind) => {
    if (!line.trim()) return
    if (prev && out.length && out[out.length - 1] !== '' && !(kind === 'table' && prev === 'table')) {
      out.push('')
    }
    out.push(line)
    prev = kind
  }
  for (const raw of md.split(/\r?\n/)) {
    if (/^\s*```/.test(raw)) {
      inFence = !inFence
      if (inFence) {
        // The opening fence needs a paragraph break around it; the code inside
        // must stay byte for byte, blank lines included, so it bypasses push().
        push('```', 'fence')
      } else {
        out.push('```')
        prev = 'fence'
      }
      continue
    }
    if (inFence) {
      out.push(raw)
      continue
    }
    let line = raw
    if (isTableRow(line)) {
      const cells = line.trim().replace(/^\||\|$/g, '').split('|').map((c) => c.trim())
      if (cells.every((c) => /^:?-{2,}:?$/.test(c) || c === '')) continue
      push(cells.join(' | '), 'table')
      continue
    }
    // Headings become 【标题】. The old marker (one '▍' per level) read as a
    // pair of stray vertical bars on a phone — 「▍▍ 概览」 looked like a typo,
    // not a heading. Levels deeper than h3 share the 〔 〕 form.
    let headingClose = ''
    line = line.replace(/^(#{1,6})[ \t]*/, (_, hashes) => {
      const level = hashes.length
      headingClose = level <= 2 ? '】' : level === 3 ? '』' : '〕'
      return level <= 2 ? '【' : level === 3 ? '『' : '〔'
    })
    // Inline code is a literal region: its backticks go, its contents stay
    // byte for byte, so `a_b` and `**x**` never get rewritten.
    const pieces = line.split(/(`[^`]*`)/)
    line = pieces.map((piece) => {
      if (piece.startsWith('`') && piece.endsWith('`') && piece.length >= 2) {
        return piece.slice(1, -1)
      }
      return stripEmphasis(
        piece
          .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
          .replace(/\[([^\]]*)\]\(([^)]*)\)/g, '$1 ($2)'),
      )
    }).join('')
    push(headingClose ? `${line}${headingClose}` : line, 'text')
  }
  return out.join('\n').replace(/\n{3,}/g, '\n\n').trim()
}

/**
 * Trim to `max` characters on a line boundary.
 * @returns the trimmed text plus how many source characters it kept, so a
 *   caller that already delivered a prefix can send only the remainder.
 */
export function clipInfo(text, max = 800) {
  const value = String(text ?? '')
  if (value.length <= max) return { text: value, kept: value.length, truncated: false }
  const cut = value.lastIndexOf('\n', max)
  const kept = cut > max * 0.5 ? cut : max
  return {
    text: `${value.slice(0, kept).trimEnd()}\n…（已截断，回复 /日志 获取完整输出）`,
    kept,
    truncated: true,
  }
}

/** Trim to `max` characters on a line boundary, appending an ellipsis marker. */
export function clip(text, max = 800) {
  return clipInfo(text, max).text
}

/** One-line tool-call summary for the progress feed. */
export function toolLine(name, args) {
  let hint = ''
  if (args && typeof args === 'object') {
    const candidate = args.command ?? args.path ?? args.pattern ?? args.query ?? args.file_path
    if (typeof candidate === 'string' && candidate.trim()) hint = candidate.trim().replace(/\s+/g, ' ').slice(0, 60)
  }
  return hint ? `🔧 ${name} · ${hint}` : `🔧 ${name}`
}

/**
 * Emphasis markers for a plain-text bubble.
 *
 * WeChat has no bold or italic, and dropping the markers loses the emphasis the
 * model used deliberately. Wrapping instead — 「重点」 for bold, /斜体/ for
 * italic — keeps the emphasis readable without any renderer support.
 */
const EMPHASIS_OPEN = '「'
const EMPHASIS_CLOSE = '」'

const STATUS_ICON = {
  completed: '✅',
  error: '❌',
  aborted: '⏹️',
  'max-tokens': '⚠️',
  blocked: '⏳',
  interrupted: '⚠️',
}

const STATUS_LABEL = {
  completed: '完成',
  error: '失败',
  aborted: '已取消',
  'max-tokens': '输出达到上限',
  blocked: '被阻塞',
  interrupted: '被中断',
}

/**
 * The turn-end card: status, the answer, and a compact metric line.
 *
 * `summaryLimit` is 0 by default, which means **do not clip**: the card carries
 * the answer the model actually produced, and the transport splits it into
 * as many WeChat messages as it needs. A hard 1200-character cap used to cut
 * every long answer off mid-sentence — the chat showed
 * "关于你之前的三件事，现在的状态 …（已截断）" and the rest existed only in the
 * Web UI. Only the explicit `summary` granularity asks for a digest.
 */
export function resultCard({ status = 'completed', summary = '', summaryLimit = 0, durationMs, usage, modelLabel }) {
  const lines = [`${STATUS_ICON[status] ?? '✅'} ${STATUS_LABEL[status] ?? '结束'}`]
  if (summary) lines.push('', summaryLimit > 0 ? clip(summary, summaryLimit) : summary)
  const meta = []
  if (durationMs != null && durationMs > 0) meta.push(`⏱ ${(durationMs / 1000).toFixed(1)}s`)
  if (usage && (usage.inputTokens || usage.outputTokens)) {
    meta.push(`🔢 ${usage.inputTokens ?? 0} in / ${usage.outputTokens ?? 0} out`)
  }
  if (modelLabel) meta.push(`🧠 ${modelLabel}`)
  if (meta.length) lines.push('', meta.join(' · '))
  return lines.join('\n')
}

/** A numbered menu. `0` is always cancel. */
export function menu(title, items, { footer = '', start = 1 } = {}) {
  const lines = [title]
  items.forEach((item, index) => {
    lines.push(`${start + index}. ${item}`)
  })
  lines.push('0. 取消')
  if (footer) lines.push('', footer)
  return lines.join('\n')
}

/** `/状态` — one screen with everything a remote operator needs. */
export function statusCard({
  workspace, model, sessionId, agentPreset, permissionPreset, planMode, running, queued,
  connected, lastEventAt, workspaceCount, muted, granularity,
}) {
  const lines = [
    '📊 当前状态',
    '',
    `工作区：${workspace || '（未设置）'}`,
    `模型：${model || '（跟随默认）'}`,
    `会话：${sessionId || '（尚未创建）'}`,
    `预设：${agentPreset || '（部署默认）'}`,
    `权限：${permissionPreset || '（跟随默认）'}${planMode ? ' · 计划模式' : ''}`,
    `任务：${running ? '运行中' : '空闲'}${queued ? ` · 排队 ${queued}` : ''}`,
    `通知：${muted ? '已静音' : '开启'} · 回复 ${granularity}`,
    `工作区可选：${workspaceCount} 个`,
    `微信：${connected ? '已连接' : '未连接'}${lastEventAt ? ` · 最近消息 ${ago(lastEventAt)}` : ''}`,
  ]
  return lines.join('\n')
}

/** Human-readable elapsed time for a past timestamp. */
export function ago(timestamp) {
  const delta = Date.now() - Number(timestamp || 0)
  if (!Number.isFinite(delta) || delta < 0) return '刚刚'
  const minutes = Math.floor(delta / 60_000)
  if (minutes < 1) return '刚刚'
  if (minutes < 60) return `${minutes} 分钟前`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours} 小时前`
  return `${Math.floor(hours / 24)} 天前`
}

/** Compact "provider/model" label, dropping a provider equal to the prefix. */
export function modelLabel(selection) {
  if (!selection?.provider || !selection?.model) return ''
  const effort = selection.reasoningEffort ? ` · ${selection.reasoningEffort}` : ''
  return `${selection.provider}/${selection.model}${effort}`
}

/**
 * The full help text; the source of truth for what the channel supports.
 *
 * One command per line: the Chinese spelling first, then the English name and
 * the short form in full-width parentheses, then a Chinese-only description.
 * Mixing two languages into the description doubled every line's length and
 * pushed the list far past one phone screen, so the descriptions stay Chinese
 * and the English spellings live in the brackets — `/模型（model，m）: 切换模型`.
 * On a phone keyboard the long English words are unusable (`/granularity`,
 * `/permission`), so the abbreviations are what people actually type.
 */
export function helpText() {
  // Joined with a blank line, not a single \n: WeChat treats a lone newline as
  // a soft break and paints it as a space, which glued every command into one
  // paragraph. A blank line is a real paragraph break, so the lines stay apart
  // even for a renderer that only strips Markdown and keeps blank lines.
  return [
    '微信 Bot 已激活。发送 /帮助 查看命令，或直接描述你要做的事。',
    '命令支持中文、英文和括号里的短写，任选一种。',
    '【通用】',
    '/帮助（help，h）: 查看这份说明',
    '/状态（status，st）: 查看工作区、模型与任务状态',
    '/新建（new，n）: 开始新的任务草稿',
    '/诊断（diag，dg）: 连接与队列诊断',
    '【环境】',
    '/项目（project，ws）: 切换工作区',
    '/模型（model，m）: 切换模型',
    '/思考（think，th）: 切换思考级别',
    '/模式（permission，pm）: 切换权限模式',
    '/预设（preset，ps）: 切换预设，决定本次会话能用哪些工具',
    '/计划（plan，pl）: 计划模式开关',
    '【回复】',
    '/回复（reply，rep）: 调整回复详细程度',
    '/静音（mute，mu）: 关闭通知',
    '/恢复（unmute，un）: 重新开启通知',
    '【会话】',
    '/会话（sessions，ss）: 列出并绑定已有会话',
    '/解绑（unbind，ub）: 解除本聊天绑定',
    '【任务】',
    '/停止（stop，sp）: 中断当前任务',
    '/重试（retry，rt）: 重发上一条任务',
    '/日志（log，lg）: 取回上一轮完整输出',
    '/审批（approve，ap）<编号> 允许|拒绝: 处理待审批',
    '/回答（answer，ans）<编号> <选项>: 回答提问卡片',
    '也可以直接发消息派活，例如：帮我部署。',
  ].join('\n\n')
}

export { MAX_TEXT_CHARS }
