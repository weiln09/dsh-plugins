// The command surface: a table of slash commands, their argument grammar, and
// the short-lived "pick a number" state that a menu leaves behind.
//
// WeChat has no inline buttons, so every choice is a numbered reply. The state
// is per chat, expires quickly, and is cleared by `0`, by a timeout, or by any
// non-numeric message.

import { helpText, menu } from './render.js'

/** How long a numbered menu stays answerable. */
export const PENDING_TTL_MS = 120_000

/**
 * Command aliases → canonical name.
 *
 * Every command answers to Chinese, full English, and a short English form.
 * The short form matters on a phone keyboard: `/permission` and `/granularity`
 * are long enough that people stop using them, so `/perm` and `/rep` exist and
 * the help text advertises them.
 */
const ALIAS_TABLE = [
  ['help', ['帮助', '帮', 'help', 'h', '?']],
  ['status', ['状态', 'status', 'st']],
  ['new', ['新建', '新', 'new', 'n', 'clear', '清空', 'reset']],
  ['workspace', ['项目', '工作区', 'workspace', 'project', 'proj', 'ws']],
  ['model', ['模型', 'model', 'models', 'mdl', 'm']],
  ['reasoning', ['思考', '思考级别', '推理', 'reasoning', 'reason', 'think', 'effort', 'eff', 'th']],
  ['permission', ['模式', '权限', 'permission', 'perm', 'mode', 'pm']],
  ['plan', ['计划', 'plan', 'pl']],
  ['reply', ['回复', '粒度', 'reply', 'rep', 're', 'granularity', 'gran', 'gr']],
  ['sessions', ['会话', '列表', 'sessions', 'session', 'sess', 'ss']],
  ['stop', ['停止', '中断', 'stop', 'cancel', 'sp']],
  ['approve', ['审批', '批准', 'approve', 'apv', 'ap']],
  // The question card has always told the user to send `/回答 <id> <选项>`, and
  // QuestionBridge.respond has always existed to receive it — but the command
  // was missing from this table, so the reply fell through to "未知命令" and
  // every ask_user_question could only time out into "skipped".
  ['answer', ['回答', '答复', 'answer', 'ans', 'aw']],
  ['retry', ['重试', 'retry', 'rt']],
  ['log', ['日志', 'log', 'lg']],
  ['mute', ['静音', 'mute', 'mu']],
  ['unmute', ['恢复', '取消静音', 'unmute', 'un']],
  ['preset', ['预设', 'preset', 'presets', 'pre', 'ps']],
  ['trust', ['信任', 'trust', 'tr']],
  ['revoke', ['撤销', 'revoke', 'rv']],
  ['diag', ['诊断', 'diag', 'doctor', 'dg']],
  ['unbind', ['解绑', 'unbind', 'ub']],
]

const ALIASES = new Map(ALIAS_TABLE.flatMap(([name, aliases]) => aliases.map((alias) => [alias, name])))

/** The canonical name behind one alias, or undefined. */
export function canonicalCommand(token) {
  return ALIASES.get(String(token ?? '').toLowerCase()) ?? ALIASES.get(String(token ?? ''))
}

/** Commands only an admin may run. */
export const ADMIN_COMMANDS = new Set(['trust', 'revoke'])

/**
 * Parse one command line.
 * @returns {null | { name: string, raw: string, args: string[] }}
 */
export function parseCommand(text) {
  if (typeof text !== 'string') return null
  const trimmed = text.trim()
  if (!trimmed.startsWith('/')) return null
  const match = trimmed.match(/^\/([^\s]+)\s*([\s\S]*)$/)
  if (!match) return null
  const name = canonicalCommand(match[1])
  if (!name) return null
  const rest = (match[2] ?? '').trim()
  return { name, raw: trimmed, args: rest ? rest.split(/\s+/) : [] }
}

/**
 * Per-chat pending menus. One menu at a time; issuing a new one replaces it.
 */
export class PendingSelections {
  constructor(ttlMs = PENDING_TTL_MS) {
    this.ttlMs = ttlMs
    this.map = new Map()
  }

  /** Register the options a bare number will select. */
  set(chatId, kind, options, extra = {}) {
    this.map.set(String(chatId), {
      kind,
      options,
      extra,
      expiresAt: Date.now() + this.ttlMs,
    })
  }

  /** Read the live pending menu, dropping it when expired. */
  get(chatId) {
    const key = String(chatId)
    const pending = this.map.get(key)
    if (!pending) return null
    if (pending.expiresAt <= Date.now()) {
      this.map.delete(key)
      return null
    }
    return pending
  }

  clear(chatId) {
    this.map.delete(String(chatId))
  }

  /** Drop every expired menu. */
  sweep() {
    const now = Date.now()
    for (const [key, pending] of this.map) {
      if (pending.expiresAt <= now) this.map.delete(key)
    }
  }
}

/**
 * Interpret a bare numeric reply against a pending menu.
 * @returns {null | { index: number, value: any, cancelled: boolean }}
 */
export function interpretNumber(pending, text) {
  const trimmed = String(text ?? '').trim()
  if (!/^\d+$/.test(trimmed)) return null
  const index = Number(trimmed)
  if (index === 0) return { index: 0, value: null, cancelled: true }
  if (index < 1 || index > pending.options.length) return { index, value: null, cancelled: false }
  return { index, value: pending.options[index - 1], cancelled: false }
}

/** Build the numbered menu text for one pending kind. */
export function menuFor(kind, title, items, footer) {
  return menu(title, items, { footer })
}

export { helpText }
