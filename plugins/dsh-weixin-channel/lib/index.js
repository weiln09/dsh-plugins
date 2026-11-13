// @weiln09/dsh-weixin-channel — Host half.
//
// A WeChat (Tencent iLink) bot channel that fixes what a single-workspace,
// single-model bridge cannot do: each chat keeps its own workspace, model,
// permission preset and reply granularity, and can switch any of them with a
// numbered menu.
//
// Layout:
//   ilink.js      protocol client (fetch injectable)
//   store.js      atomic JSON state
//   bindings.js   per-chat binding + authorization + dedupe
//   session.js    one agent per (chat, workspace), in-place model switching
//   commands.js   command table and numbered-menu state
//   render.js     Markdown → WeChat text, cards, help
//   notify.js     throttled progress + turn-end card
//   bridges.js    approval / question waterfalls
//   routes.js     panel JSON route + connection RPC

import { randomUUID } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import z from '@deepseek-ai/schemastery'

import {
  createILinkApi, extractText as extractInboundText, isHumanSender, messageId, splitText,
} from './ilink.js'
import {
  MAX_MEDIA_BYTES, downloadMedia, encryptEcb, extractMedia, kindForFileName, mediaItemFor,
  mediaTypes, newAesKeyHex, newFilekey, quotedFromMessage, sanitizeFileName, uploadFingerprint,
  uploadToCdn,
} from './media.js'
import { maskId, readJson, resolveStateDir, safeId, writeJson } from './store.js'

/**
 * Strip credentials from a URL-ish string before it is shown or logged.
 *
 * A proxy environment variable is a URL with an optional `user:password@`
 * authority, and the diagnostics panel renders these verbatim in the browser.
 * A value that does not parse is masked wholesale rather than echoed.
 */
export function redactUrl(value) {
  const text = String(value ?? '')
  try {
    const url = new URL(text)
    if (url.username || url.password) {
      url.username = url.username ? '***' : ''
      url.password = url.password ? '***' : ''
    }
    return url.toString()
  } catch {
    // Not a URL: keep only the shape, never the credential segment.
    const at = text.lastIndexOf('@')
    const scheme = text.indexOf('//')
    if (at > 0 && scheme >= 0) return `${text.slice(0, scheme + 2)}***${text.slice(at)}`
    return text
  }
}

/**
 * Split a `provider/model` key at its FIRST slash.
 *
 * A model id may itself contain slashes (`magpie/trae-cn/deepseek-v4.1-flash-max`
 * is provider `magpie` plus model `trae-cn/deepseek-v4.1-flash-max`), so a
 * destructuring split silently produced provider=magpie, model=trae-cn — a
 * model that does not exist, which made the saved default unusable.
 */
export function parseModelKey(value) {
  const text = String(value ?? '').trim()
  const at = text.indexOf('/')
  if (at <= 0 || at === text.length - 1) return null
  return { provider: text.slice(0, at), model: text.slice(at + 1) }
}

/** How long a `getconfig` typing ticket stays usable before it is re-fetched. */
const TYPING_TICKET_TTL_MS = 12 * 60 * 60 * 1_000
import { BindingStore } from './bindings.js'
import { SessionRouter, agentSelection } from './session.js'
import { ADMIN_COMMANDS, PendingSelections, interpretNumber, menuFor, parseCommand } from './commands.js'
import { helpText, markdownToText, modelLabel, statusCard } from './render.js'
import { NotifyBus } from './notify.js'
import { ApprovalBridge, QuestionBridge } from './bridges.js'
import { installRoutes, publicBinding, redactBind } from './routes.js'
import { createBindSession } from './bind.js'

export const name = 'weixin-channel'

export const inject = ['agents', 'tools']

export const Config = z.object({
  enabled: z.boolean().default(true),
  stateDir: z.string().default(''),

  account: z.object({
    botId: z.string().default(''),
    accountId: z.string().default(''),
    tokenRef: z.string().default('env:WEIXIN_BOT_TOKEN'),
    ownerUserId: z.string().default(''),
    baseUrl: z.string().default('https://ilinkai.weixin.qq.com/'),
  }),

  defaults: z.object({
    workspace: z.string().default(''),
    model: z.object({
      provider: z.string().default(''),
      model: z.string().default(''),
      reasoningEffort: z.string().default(''),
    }),
    permissionPreset: z.string().default(''),
    agentPreset: z.string().default(''),
  }),

  allowedWorkspaces: z.array(z.string()).default([]),
  allowedModels: z.array(z.string()).default([]),

  reply: z.object({
    granularity: z.union([z.const('summary'), z.const('standard'), z.const('full')]).default('standard'),
    progressIntervalMs: z.number().default(4000),
    maxChunkChars: z.number().default(2000),
    toolProgress: z.boolean().default(false),
    typingIntervalMs: z.number().default(4000),
  }),

  security: z.object({
    allowlist: z.array(z.string()).default([]),
    admins: z.array(z.string()).default([]),
    trustFirstContact: z.boolean().default(false),
  }),

  approvals: z.object({
    enabled: z.boolean().default(true),
    timeoutSec: z.number().default(300),
  }),

  questions: z.object({
    enabled: z.boolean().default(true),
    timeoutSec: z.number().default(300),
  }),

  turn: z.object({
    timeoutMs: z.number().default(900000),
    sendIntervalMs: z.number().default(2000),
    queueMax: z.number().default(5),
  }),

  media: z.object({
    /** Refuse an inbound attachment larger than this (also caps outbound sends). */
    maxBytes: z.number().default(20 * 1024 * 1024),
  }),

  features: z.object({
    // Media is transfer-only: an inbound photo is downloaded and handed to the
    // agent as a local path, never decoded by the channel itself.
    planMode: z.boolean().default(true),
    agentPreset: z.boolean().default(true),
  }),

  debug: z.boolean().default(false),
})

/** Human-sized byte count for the attachment note. */
function formatBytes(bytes) {
  const value = Number(bytes) || 0
  if (value < 1024) return `${value} B`
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`
  return `${(value / (1024 * 1024)).toFixed(1)} MB`
}

const KIND_LABEL = { image: '图片', video: '视频', file: '文件', voice: '语音' }

/**
 * The prompt fragment that tells the agent where an inbound attachment landed.
 *
 * The agent has file tools, not a media decoder, so the useful thing to hand it
 * is a real path plus enough metadata to decide what to do with it. Saying
 * "the user sent a photo" without the path made the model answer from the
 * caption alone and ignore the attachment entirely.
 */
export function attachmentPrompt(media, saved) {
  const label = KIND_LABEL[media?.kind] ?? '附件'
  const lines = [
    `【微信${label}】${saved.fileName}`,
    `大小：${formatBytes(saved.bytes)}`,
    `本地路径：${saved.filePath}`,
  ]
  if (media?.kind === 'voice') lines.push('（SILK 语音文件，若无法解析请向用户说明。）')
  if (media?.quoted) lines.push(`引用的消息：${media.quoted}`)
  lines.push('如需查看内容，请直接用文件工具读取上面的本地路径。')
  return lines.join('\n')
}

export class WeixinChannel {
  constructor(ctx, config) {
    this.ctx = ctx
    this.cfg = config
    this.logger = ctx.logger?.('weixin-channel') ?? console
    this.stateDir = resolveStateDir(config.stateDir)
    // Panel-saved defaults live beside the bindings. They are layered OVER the
    // config, because the panel is the later, more specific answer — and they
    // have to be read back at startup, or "保存" silently meant "until restart".
    this.defaultsFile = path.join(this.stateDir, 'defaults.json')
    const storedDefaults = readJson(this.defaultsFile, null)
    if (storedDefaults && typeof storedDefaults === 'object') {
      if (typeof storedDefaults.workspace === 'string' && storedDefaults.workspace) {
        config.defaults.workspace = storedDefaults.workspace
      }
      if (storedDefaults.model?.provider && storedDefaults.model?.model) {
        config.defaults.model = {
          provider: String(storedDefaults.model.provider),
          model: String(storedDefaults.model.model),
          reasoningEffort: String(storedDefaults.model.reasoningEffort ?? ''),
        }
      }
      if (typeof storedDefaults.permissionPreset === 'string') {
        config.defaults.permissionPreset = storedDefaults.permissionPreset
      }
      if (typeof storedDefaults.agentPreset === 'string') {
        config.defaults.agentPreset = storedDefaults.agentPreset
      }
    }
    this.bindings = new BindingStore(this.stateDir, {
      workspace: config.defaults.workspace || process.cwd(),
      model: config.defaults.model?.provider && config.defaults.model?.model
        ? {
          provider: config.defaults.model.provider,
          model: config.defaults.model.model,
          ...(config.defaults.model.reasoningEffort ? { reasoningEffort: config.defaults.model.reasoningEffort } : {}),
        }
        : null,
      permissionPreset: config.defaults.permissionPreset,
      agentPreset: config.defaults.agentPreset,
    })

    // Config allowlists are authoritative and merged with runtime additions.
    for (const userId of config.security.allowlist ?? []) this.bindings.allow(userId)
    for (const userId of config.security.admins ?? []) this.bindings.addAdmin(userId)

    this.pending = new PendingSelections()
    this.api = createILinkApi({ fetchImpl: this.fetchImpl ?? fetch })
    this.disposed = false
    this.controller = null
    this.cursor = ''
    this.status = {
      connected: false,
      detail: '未启动',
      lastEventAt: null,
      lastError: null,
    }
    // Both maps are keyed by Session id and were never pruned: a long-lived
    // Host kept the last prompt and the last full answer of every conversation
    // it had ever mirrored. They only serve /重试 and /日志 for the chat's
    // CURRENT session, so a small bounded window is enough.
    this.lastUserText = new Map()
    this.lastOutput = new Map()
    // chatId → { chain, size }. One chat runs one turn at a time; different
    // chats run in parallel. size counts accepted-but-unfinished tasks (the
    // running one included) and is what turn.queueMax limits.
    this.queues = new Map()
    // Promises of inbound messages the poller handed off but that have not
    // finished yet. The poll loop does NOT await them: a ten-minute turn used
    // to stop the bot from receiving anything at all, so /停止 and /审批 could
    // not even be delivered while the turn they were meant to interrupt ran.
    this.inflight = new Set()
    // chatId → number of overlapping "typing" owners (a turn plus a command
    // that arrived during it). The indicator is cleared when the last ends.
    this.typingRefs = new Map()
    this.sendChain = Promise.resolve()
    this.lastSendAt = 0
    // chatId → { ticket, expiresAt }; `typingState` explains the last attempt.
    this.typingTickets = new Map()
    this.typingTimers = new Map()
    this.typingState = { ok: null, detail: '尚未尝试', at: null }
    // chatId → the inbound context_token, kept so a mid-turn ticket refetch
    // still has the conversation anchor getconfig expects.
    this.typingContexts = new Map()
    this.timers = []
    this.disposers = []
    this.polling = false

    this.router = new SessionRouter({
      ctx,
      bindings: this.bindings,
      defaultSelection: () => this.defaultSelection(),
      log: (line) => this.debug(line),
      audit: (line) => this.audit(line),
    })

    this.notify = new NotifyBus({
      ctx,
      bindings: this.bindings,
      send: (chatId, text) => this.sendText(chatId, text),
      log: (line) => this.debug(line),
    })

    this.approvals = new ApprovalBridge({
      ctx,
      bindings: this.bindings,
      send: (chatId, text) => this.sendText(chatId, text),
      log: (line) => this.debug(line),
      audit: (line) => this.audit(line),
      config: { enabled: config.approvals.enabled, timeoutSec: config.approvals.timeoutSec },
    })

    this.questions = new QuestionBridge({
      ctx,
      bindings: this.bindings,
      send: (chatId, text) => this.sendText(chatId, text),
      log: (line) => this.debug(line),
      audit: (line) => this.audit(line),
      config: { enabled: config.questions.enabled, timeoutSec: config.questions.timeoutSec },
    })

    this.bind = createBindSession({
      api: this.api,
      stateDir: this.stateDir,
      // Scanning succeeds inside the QR poller, so this is the only place the
      // Host learns that a token now exists. Without it the panel said
      // "绑定成功" while the channel kept its old (missing) credentials.
      onBound: () => {
        // The token on disk just changed; the cached copy is now stale.
        this.invalidateAccount()
        this.restartPolling()
      },
    })
  }

  // ── lifecycle ────────────────────────────────────────────────────────────

  async start() {
    this.notify.configure({
      granularity: this.cfg.reply.granularity,
      progressIntervalMs: this.cfg.reply.progressIntervalMs,
      toolProgress: this.cfg.reply.toolProgress,
    })
    this.notify.mount()
    this.approvals.mount()
    this.questions.mount()

    // Keep the last assistant text per bound session so `/日志` can replay it
    // even when the chat asked for the summary granularity.
    this.disposers.push(this.ctx.on('session/event', (session, event) => {
      if (event.type !== 'assistant/message') return
      if (!this.bindings.bySessionId(session?.id)) return
      const text = (event.data?.message?.content ?? [])
        .filter((block) => block?.type === 'text' && typeof block.text === 'string')
        .map((block) => block.text)
        .join('\n')
        .trim()
      if (text) this.remember(this.lastOutput, session.id, text)
    }))

    // Sessions created before this plugin attached its sessions sit in 未分组
    // forever: the sidebar groups by registry membership, so nothing repairs
    // them on its own. Attach every recorded (chat, workspace) session once.
    void this.repairWorkspaceMembership()

    // Housekeeping must not keep the process alive on its own.
    const sweep = setInterval(() => this.pending.sweep(), 30_000)
    if (typeof sweep?.unref === 'function') sweep.unref()
    this.timers.push(sweep)

    const account = this.account()
    if (!account.token) {
      this.status = { connected: false, detail: '缺少 bot token（请在设置页扫码绑定）', lastEventAt: null, lastError: null }
      this.logger.warn('weixin-channel: 缺少 bot token，通道保持断开；在 DSH 设置 → 插件 → 微信 扫码绑定')
      return
    }
    this.restartPolling()
  }

  /**
   * Attach every recorded chat session to the Workspace at its directory.
   *
   * Runs once at load. It is idempotent (attachSession is a no-op for a member)
   * and best-effort: a failure is logged, never thrown into startup.
   */
  async repairWorkspaceMembership(attempt = 1) {
    try {
      // The registry is a peer service; at plugin start it may not be mounted
      // yet, so a single failed read would silently skip the repair forever.
      if (!this.ctx.get?.('workspaceRegistry')) {
        if (attempt < 5) {
          const retry = setTimeout(() => { void this.repairWorkspaceMembership(attempt + 1) }, 2_000)
          if (typeof retry?.unref === 'function') retry.unref()
          this.timers.push(retry)
        }
        return
      }
      let repaired = 0
      for (const binding of this.bindings.list()) {
        for (const [workspace, sessionId] of Object.entries(binding.sessions ?? {})) {
          if (!sessionId) continue
          if (await this.router.joinWorkspace(sessionId, workspace)) repaired += 1
        }
      }
      if (repaired) this.logger.info('weixin-channel: 已把 %s 个会话挂回工作区', repaired)
    } catch (error) {
      this.debug('挂回工作区失败：' + String(error?.message ?? error))
    }
  }

  account() {
    // Called on every outbound message, every typing refresh (every 4s per
    // chat) and every status render. `readAccount()` is a SYNCHRONOUS
    // readFileSync, so uncached it blocked the event loop on the same hot path
    // that has to keep the long poll responsive. The file only changes when a
    // QR bind completes, which invalidates the cache explicitly.
    if (this.accountCache) return this.accountCache
    const account = this.readAccountFromDisk()
    this.accountCache = account
    return account
  }

  /** Drop the cached credentials so the next read observes the new token. */
  invalidateAccount() {
    this.accountCache = null
  }

  readAccountFromDisk() {
    const configured = this.cfg.account
    const stored = this.bind.readAccount()
    const tokenRef = configured.tokenRef || 'env:WEIXIN_BOT_TOKEN'
    const envName = tokenRef.startsWith('env:') ? tokenRef.slice(4) : ''
    const token = (envName && process.env[envName]) || stored?.token || ''
    return {
      botId: configured.botId || stored?.botId || '',
      accountId: configured.accountId || stored?.accountId || '',
      ownerUserId: configured.ownerUserId || stored?.ownerUserId || '',
      baseUrl: configured.baseUrl || stored?.baseUrl || 'https://ilinkai.weixin.qq.com/',
      token,
      tokenRef,
    }
  }

  /**
   * Probe the iLink endpoint from inside the Host process.
   *
   * A timeout that only happens here — while the same token works from a
   * terminal — points at the process environment (proxy, DNS, or an injected
   * fetch) rather than at the credentials.
   */
  async diagnoseNetwork() {
    const account = this.account()
    const report = {
      token: account.token ? `已配置(${account.token.length}字符)` : '缺失',
      baseUrl: account.baseUrl,
      polling: this.polling,
      // Credentials never leave the process: a proxy URL commonly carries
      // `user:password@`, and this report is rendered in a browser tab.
      envProxy: ['HTTPS_PROXY', 'HTTP_PROXY', 'ALL_PROXY', 'NO_PROXY']
        .filter((key) => process.env[key])
        .map((key) => `${key}=${redactUrl(process.env[key])}`),
      fetchSource: fetch === globalThis.fetch ? 'global' : 'replaced',
    }
    if (!account.token) return report

    const started = Date.now()
    try {
      const response = await this.api.notifyStart({
        baseUrl: account.baseUrl,
        token: account.token,
        signal: AbortSignal.timeout(15_000),
      })
      report.notifyStart = { ok: true, ms: Date.now() - started, body: JSON.stringify(response).slice(0, 120) }
    } catch (error) {
      report.notifyStart = {
        ok: false,
        ms: Date.now() - started,
        code: error?.code ?? error?.name ?? '',
        message: String(error?.message ?? error),
        cause: String(error?.cause?.code ?? error?.cause?.message ?? ''),
      }
    }
    return report
  }

  /**
   * Long-poll loop with exponential backoff.
   *
   * `notifystart` is retried rather than treated as fatal: a single network
   * timeout must not disable the channel until the next restart. The whole
   * sequence also lives behind `restartPolling()`, because a token obtained by
   * scanning *after* load has no poller yet.
   */
  startPolling(account) {
    this.stopPolling()
    const controller = new AbortController()
    this.controller = controller
    const baseUrl = account.baseUrl
    const token = account.token
    let buffer = this.bind.readCursor()

    const loop = async () => {
      // Phase 1: announce push, retrying with backoff.
      let startBackoff = 2_000
      while (!this.disposed && !controller.signal.aborted) {
        try {
          await this.api.notifyStart({ baseUrl, token, signal: controller.signal })
          break
        } catch (error) {
          if (this.disposed || controller.signal.aborted) return
          this.status = {
            connected: false,
            detail: `启动推送失败，${Math.round(startBackoff / 1000)}s 后重试：${error?.message ?? error}`,
            lastEventAt: this.status.lastEventAt,
            lastError: String(error?.message ?? error),
          }
          this.logger.warn('weixin-channel: notifystart 失败，%sms 后重试：%s', startBackoff, error?.message ?? error)
          await new Promise((resolve) => setTimeout(resolve, startBackoff))
          startBackoff = Math.min(startBackoff * 2, 60_000)
        }
      }
      if (this.disposed || controller.signal.aborted) return

      // Phase 2: the long poll itself.
      let backoff = 1_000
      while (!this.disposed && !controller.signal.aborted) {
        try {
          const response = await this.api.getUpdates({
            baseUrl, token, buf: buffer, signal: controller.signal,
          })
          if (typeof response?.get_updates_buf === 'string' && response.get_updates_buf) {
            buffer = response.get_updates_buf
            this.bind.writeCursor(buffer)
          }
          this.status = { ...this.status, connected: true, detail: '长轮询运行中', lastError: null }
          backoff = 1_000
          for (const message of response?.msgs ?? []) {
            if (this.disposed || controller.signal.aborted) break
            // Fire and forget, deliberately. Awaiting here serialized the
            // whole channel behind one turn: while an agent worked, the bot
            // did not poll, so /停止, /审批 and any second chat's message sat
            // undelivered until that turn ended. Per-chat serialization is
            // already enforced by the queue in dispatchTask; the poller only
            // has to keep receiving.
            this.acceptInbound(message)
          }
        } catch (error) {
          if (this.disposed || controller.signal.aborted) return
          this.status = {
            ...this.status,
            connected: false,
            detail: `拉取失败：${error?.message ?? error}`,
            lastError: String(error?.message ?? error),
          }
          this.debug(`getupdates 失败（${backoff}ms 后重试）：${error?.message ?? error}`)
          await new Promise((resolve) => setTimeout(resolve, backoff))
          backoff = Math.min(backoff * 2, 30_000)
        }
      }
    }
    void loop()
  }

  /** Abort the current poller (if any) without touching the rest of the plugin. */
  stopPolling() {
    this.polling = false
    if (this.controller) {
      try {
        this.controller.abort()
      } catch {
        // Already aborted.
      }
      this.controller = null
    }
  }

  /**
   * (Re)start polling with whatever credentials are on disk now.
   *
   * Called after a successful QR bind, from the panel's reconnect action, and
   * at load. Without this, a token obtained by scanning after startup would
   * never be polled at all.
   */
  restartPolling() {
    if (this.disposed) return { ok: false, reason: '插件已卸载' }
    const account = this.account()
    if (!account.token) {
      this.status = { connected: false, detail: '缺少 bot token（请在设置页扫码绑定）', lastEventAt: null, lastError: null }
      return { ok: false, reason: '缺少 bot token' }
    }
    this.startPolling(account)
    this.polling = true
    this.status = { connected: false, detail: '正在连接微信服务…', lastEventAt: null, lastError: null }
    this.logger.info('weixin-channel: 开始长轮询（%s）', account.accountId ? maskId(account.accountId) : '未知账号')
    return { ok: true, accountId: maskId(account.accountId) }
  }

  async dispose() {
    if (this.disposed) return
    this.disposed = true
    for (const timer of this.timers) clearInterval(timer)
    this.timers = []
    for (const timer of this.typingTimers.values()) clearInterval(timer)
    this.typingTimers.clear()
    this.typingContexts.clear()
    for (const dispose of this.disposers) dispose()
    this.disposers = []
    this.controller?.abort()
    // Wait for handed-off messages instead of tearing down under them: since
    // the poller no longer awaits a turn, dispose() can now land mid-turn.
    if (this.inflight.size) {
      await Promise.race([
        Promise.allSettled([...this.inflight]),
        new Promise((resolve) => setTimeout(resolve, 5_000)),
      ])
    }
    this.inflight.clear()
    this.notify.dispose()
    this.approvals.dispose()
    this.questions.dispose()
    this.bind.cancel()
    const account = this.account()
    if (account.token) {
      void this.api.notifyStop({ baseUrl: account.baseUrl, token: account.token }).catch(() => {})
    }
    await this.bindings.flush()
  }

  // ── inbound ──────────────────────────────────────────────────────────────

  /**
   * Take one polled message and run it without blocking the poller.
   *
   * The long poll used to await every message in turn, which meant a single
   * long turn stopped the bot from receiving *anything*: /停止 could not reach
   * a turn it was supposed to interrupt, an approval card could be sent but
   * never answered, and a second chat's message waited for the first. The
   * poller now only hands messages off; ordering per chat is still guaranteed
   * by the queue in `dispatchTask`.
   *
   * The promise is tracked so `dispose()` can wait for work in flight instead
   * of tearing down a half-written state file.
   */
  acceptInbound(message) {
    const chatId = String(message?.from_user_id ?? '')
    const task = this.handleInbound(message)
    const tracked = Promise.resolve(task)
      .catch((error) => {
        this.logger.error('weixin-channel: 处理入站消息失败 %o', error)
        return this.sendText(chatId, `😵 处理失败：${error?.message ?? error}`).catch(() => {})
      })
      .finally(() => { this.inflight.delete(tracked) })
    this.inflight.add(tracked)
    return tracked
  }

  async handleInbound(message) {
    if (!isHumanSender(message)) return
    const chatId = String(message.from_user_id)
    const msgId = messageId(message)
    if (!this.bindings.dedupe(msgId)) return

    let text = extractInboundText(message)
    const media = extractMedia(message)
    if (!text && !media) {
      await this.sendText(chatId, '这个格式暂不支持（目前支持文字、语音转写和图片/文件）🙏')
      return
    }
    this.status = { ...this.status, lastEventAt: Date.now() }
    this.ctx.emit?.('weixin/inbound', { chatId, msgId, length: text.length, kind: media?.kind ?? 'text' })

    // Authorization comes BEFORE the download: a stranger must not be able to
    // make the Host fetch a 20 MB payload just by sending a photo.
    if (!this.bindings.isAllowed(chatId)) {
      await this.trustGate(chatId, message)
      return
    }
    this.bindings.touch(chatId)

    // A media message is a task, never a command: "send a photo with /帮助"
    // is not a way to ask for help, and the photo must not be dropped.
    let prompt = text
    if (media) {
      if (media.kind === 'voice' && !text) {
        await this.sendText(chatId, '这条语音没有转写文本，暂时无法理解。请改用文字，或重新发送。')
        return
      }
      await this.showTyping(chatId, message.context_token)
      let saved
      try {
        saved = await this.saveInboundMedia(chatId, message, media)
      } catch (error) {
        this.logger.error('weixin-channel: 保存入站媒体失败 %o', error)
        this.hideTyping(chatId)
        await this.sendText(chatId, `😵 附件保存失败：${error?.message ?? error}`)
        return
      }
      this.hideTyping(chatId)
      this.audit({ kind: 'media/inbound', chatId, media: media.kind, bytes: saved.bytes })
      prompt = [text, attachmentPrompt(media, saved)].filter(Boolean).join('\n\n')
      // Media always runs a task, so the command/menu branch below is skipped.
      await this.dispatchTask(chatId, message, prompt)
      return
    }
    // A plain-text message that quotes another one carries that quote on the
    // item, not in the text, so without this the agent saw a question with no
    // subject ("这个多少钱？" about a photo it never received).
    const quoted = quotedFromMessage(message)
    if (quoted) text = [`【引用】${quoted}`, text].join('\n\n')

    // Commands answer immediately; a task keeps the indicator up until its turn
    // ends, which `runTurn` is responsible for clearing.
    let dispatched = false
    await this.showTyping(chatId, message.context_token)
    try {
      const parsed = parseCommand(text)
      if (parsed) {
        if (ADMIN_COMMANDS.has(parsed.name) && !this.bindings.isAdmin(chatId)) {
          await this.sendText(chatId, `⛔ /${parsed.raw.slice(1)} 需要管理员权限。`)
          return
        }
        // A command failure is a reply, not a broken poller: without this the
        // error escaped into the long-poll catch and the user saw nothing while
        // the channel reported "拉取失败".
        try {
          await this.runCommand(chatId, parsed)
        } catch (error) {
          this.logger.error('weixin-channel: 命令失败 %o', error)
          await this.sendText(chatId, `😵 处理失败：${error?.message ?? error}`).catch(() => {})
        }
        return
      }
      // A slash-prefixed line that names no known command is a typo, not a task.
      if (text.trim().startsWith('/')) {
        const name = text.trim().slice(1).split(/\s+/)[0] || ''
        await this.sendText(chatId, `未知命令 /${name}。发送 /帮助 查看可用命令。`)
        return
      }

      // A bare number answers the menu this chat last opened.
      const pending = this.pending.get(chatId)
      if (pending && /^\d+$/.test(text.trim())) {
        const choice = interpretNumber(pending, text)
        if (choice?.cancelled) {
          this.pending.clear(chatId)
          await this.sendText(chatId, '已取消。')
          return
        }
        if (choice?.value) {
          this.pending.clear(chatId)
          await this.applyChoice(chatId, pending, choice.value)
          return
        }
        await this.sendText(chatId, `请输入 1-${pending.options.length}，或 0 取消。`)
        return
      }
      if (pending) this.pending.clear(chatId)

      dispatched = true
      await this.dispatchTask(chatId, message, text)
    } finally {
      if (!dispatched) this.hideTyping(chatId)
    }
  }

  /**
   * Download, decrypt and file one inbound attachment inside the workspace.
   *
   * It lands in `<workspace>/inbox/` rather than the state directory on
   * purpose: the agent's file tools are rooted at the workspace, so a path
   * outside it is one it may refuse to read. The name is prefixed with the
   * chat's tail and a timestamp so two people sending "photo.jpg" cannot
   * overwrite each other.
   */
  async saveInboundMedia(chatId, message, media) {
    const binding = this.bindings.ensure(chatId)
    const workspace = this.router.workspaceFor(binding, this.cfg.defaults.workspace || process.cwd())
    const plaintext = await downloadMedia({
      fetchImpl: this.fetchImpl ?? fetch,
      media: media.media,
      aeskey: media.aeskey,
      maxBytes: Math.min(MAX_MEDIA_BYTES, Math.max(1, Number(this.cfg.media?.maxBytes) || MAX_MEDIA_BYTES)),
    })
    const inbox = path.join(workspace, 'inbox')
    await mkdir(inbox, { recursive: true })
    const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
    const base = `${stamp}-${safeId(chatId).slice(-6)}-${sanitizeFileName(media.fileName, 'file.bin')}`
    const filePath = path.join(inbox, base)
    await writeFile(filePath, plaintext)
    return { filePath, fileName: base, bytes: plaintext.length, workspace }
  }

  /** Refuse an unknown sender, or trust them when configured to. */
  async trustGate(chatId, message) {
    // The account owner who scanned the QR is authorized by that act: the
    // `ilink_user_id` recorded at bind time is the person holding the phone.
    // Requiring a second manual allowlist entry here was the reason a freshly
    // bound bot appeared to ignore every message.
    const owner = this.account().ownerUserId
    if (owner && String(chatId) === String(owner)) {
      this.bindings.allow(chatId)
      this.audit({ kind: 'trust/owner', chatId })
      await this.sendText(chatId, [
        '👋 已识别为绑定账号本人，已自动授权。',
        '发送 /帮助 查看命令，或直接描述你要做的事。',
      ].join('\n'))
      return
    }

    if (this.cfg.security.trustFirstContact) {
      this.bindings.allow(chatId)
      this.audit({ kind: 'trust/first-contact', chatId })
      await this.sendText(chatId, '👋 首次接触，已自动信任。发送 /帮助 查看命令。')
      return
    }
    this.bindings.notePending(chatId, message.from_user_name ?? '')
    const admins = [...new Set([...(this.cfg.security.admins ?? [])])]
    for (const admin of admins) {
      if (admin === chatId) continue
      await this.sendText(admin, [
        '🔐 信任确认',
        `用户 ${message.from_user_name ?? ''}（${maskId(chatId)}）想与 agent 对话。`,
        `回复 /信任 ${chatId} 放行，或忽略。`,
      ].join('\n')).catch(() => {})
    }
    await this.sendText(chatId, [
      `⛔ 当前未授权（${maskId(chatId)}）。`,
      admins.length ? '已向管理员发送信任请求，请稍候。' : '请管理员在插件配置 security.admins 中加入你的 id。',
    ].join('\n'))
  }

  /**
   * Route one ordinary message to the chat's agent for its current workspace.
   *
   * One chat runs one turn at a time; different chats run in parallel. `size`
   * counts accepted-but-unfinished tasks (the running one included), which is
   * what `turn.queueMax` actually limits — it used to be dead configuration
   * because the poller awaited every turn and a chat could never hold more than
   * one task.
   */
  async dispatchTask(chatId, message, text) {
    const binding = this.bindings.ensure(chatId)
    const workspace = this.router.workspaceFor(binding, this.cfg.defaults.workspace || process.cwd())
    const entry = this.queues.get(chatId) ?? { chain: Promise.resolve(), size: 0 }
    if (entry.size >= this.cfg.turn.queueMax) {
      await this.sendText(chatId, `⏳ 当前排队的任务已达上限（${this.cfg.turn.queueMax}），请等前面的任务结束，或发送 /停止。`)
      // The caller claimed the typing indicator for a turn that will never
      // start, so it has to release that claim here or the indicator stays on.
      this.hideTyping(chatId)
      return
    }

    entry.size += 1
    this.queues.set(chatId, entry)
    const task = entry.chain.then(() => this.runTurn(chatId, message, text, workspace)).catch((error) => {
      this.logger.error('weixin-channel: 回合失败 %o', error)
      return this.sendText(chatId, `😵 处理失败：${error?.message ?? error}`).catch(() => {})
    })
    // The chain must survive a rejected turn, or every later message in this
    // chat would be rejected by the same stored promise.
    entry.chain = task.then(() => {}, () => {})
    void task.finally(() => {
      entry.size -= 1
      if (entry.size <= 0 && this.queues.get(chatId) === entry) this.queues.delete(chatId)
    })
    await task
  }

  /** Tasks accepted but not finished for one chat (the running one included). */
  queueDepth(chatId) {
    return this.queues.get(chatId)?.size ?? 0
  }

  /**
   * Remember one value in a bounded per-session map.
   *
   * Map insertion order is the age order, so the first key is the oldest.
   * Without this cap both replay maps grew with the number of conversations
   * the channel had ever seen, holding full assistant answers in memory.
   */
  remember(map, key, value, limit = 32) {
    if (!key) return
    map.delete(key)
    map.set(key, value)
    while (map.size > limit) {
      const oldest = map.keys().next().value
      if (oldest === undefined) break
      map.delete(oldest)
    }
  }

  async runTurn(chatId, message, text, workspace) {
    const { agent, sessionId } = await this.router.ensureAgent(chatId, {
      setup: this.composeSetup(),
      fallbackWorkspace: workspace,
    })
    this.remember(this.lastUserText, sessionId, text)

    // Session format v4 refuses the retired `{ kind: 'plugin', plugin }`
    // wrapper: a durable message must carry a *producer-owned* source kind, and
    // encoding the event throws "format v4 message requires a producer-owned
    // source kind" — which surfaced in WeChat as a failed turn. This is a real
    // human prompt arriving over an IM transport, so it is attributed as `user`;
    // that also keeps the Web UI treating it as a prompt (queue placement,
    // lastPromptAt) instead of anonymous context.
    const userMessage = {
      id: `msg-${randomUUID()}`,
      role: 'user',
      content: [{ type: 'text', text }],
      source: { kind: 'user' },
    }

    // Arm the wait before the followup: a turn can start and finish between
    // the followup call and a listener registered afterwards.
    const timeout = Math.max(30_000, Number(this.cfg.turn.timeoutMs) || 900_000)
    const finished = this.awaitTurnEnd(sessionId, agent, timeout)
    try {
      try {
        agent.followup(userMessage)
      } catch (error) {
        // A disposed agent cannot accept work; report it and stop waiting.
        this.debug(`提交任务失败：${error?.message ?? error}`)
        await this.sendText(chatId, `😵 任务提交失败：${error?.message ?? error}`)
        return
      }
      this.ctx.emit?.('weixin/dispatch', { chatId, sessionId, workspace })

      const outcome = await finished
      if (outcome === 'timeout') {
        await this.sendText(chatId, `⏰ 任务超过 ${Math.round(timeout / 60_000)} 分钟仍未结束，已放弃等待（任务可能仍在运行，可发送 /状态 查看）。`)
      }
    } finally {
      this.hideTyping(chatId)
    }
  }

  /**
   * Resolve when one session's turn ends, the agent errors, or the wait times
   * out. Listening on events rather than `whenIdle()` avoids a race where the
   * agent looks idle for an instant before the queued prompt is admitted.
   */
  awaitTurnEnd(sessionId, agent, timeoutMs) {
    return new Promise((resolve) => {
      let settled = false
      const disposers = []
      let timer = null
      const finish = (outcome) => {
        if (settled) return
        settled = true
        if (timer) clearTimeout(timer)
        for (const dispose of disposers) {
          try {
            dispose()
          } catch {
            // A disposed scope may already have dropped the listener.
          }
        }
        resolve(outcome)
      }

      disposers.push(this.ctx.on('session/event', (session, event) => {
        if (session?.id !== sessionId) return
        if (event.type === 'turn/end') finish('idle')
      }))
      disposers.push(this.ctx.on('agent/error', ({ agent: failing }) => {
        if (failing?.id === sessionId) finish('error')
      }))

      timer = setTimeout(() => finish('timeout'), timeoutMs)
      if (typeof timer?.unref === 'function') timer.unref()

      // A resumed agent may already be idle with nothing queued; the followup
      // that follows this call is what starts work, so no early resolve here.
      void agent
    })
  }

  /**
   * Per-agent setup. Runs inside the agent's own scope, which is the only place
   * a listener can see that agent's scoped events such as
   * `agent/assistant-stream`.
   */
  composeSetup() {
    return (agentCtx, agent) => {
      try {
        const prompt = agentCtx.get?.('systemPrompt')
        prompt?.section?.({
          name: 'weixin:channel-instruction',
          order: 50,
          text: [
            '你正在通过微信消息通道与用户交流，交流是异步、回合式的对话，对方在手机上看。',
            '不要使用 ask_user_question——它会在网页端阻塞等待回答；需要用户决策时，把选项写进正文一次问清。',
            '不要输出 HTML、GenUI 围栏、Mermaid 图或图表代码。',
            '回复请精简：单次回答必须少于 2000 字（含标点）。超出时先给结论和要点，',
            '再用一句话说明还有哪些细节可按需展开，不要一次倾倒全部内容。',
            '内容较多时用分点、短段落和小标题组织，避免长墙式段落。',
            '禁止输出 Markdown 语法标记：微信是纯文本，**加粗**、## 标题、`反引号`、| 表格、',
            '三反引号代码围栏都不会被渲染，只会显示成多余的符号。',
            '需要强调就写「重点」，需要小标题就单独一行写【标题】，',
            '代码/字段名直接写名字，列表用 - 或 1.，禁止 HTML 标签和下划线强调。',
            '信息不足时采用合理默认值并说明你的假设。',
          ].join(''),
        })
      } catch (error) {
        this.debug(`注入通道指令失败：${error?.message ?? error}`)
      }
      try {
        this.notify.attachAgent(agentCtx, agent)
      } catch (error) {
        this.debug(`挂接流式监听失败：${error?.message ?? error}`)
      }
    }
  }

  // ── outbound ─────────────────────────────────────────────────────────────

  /** Send text to one chat, chunked and paced. */
  async sendText(chatId, body) {
    if (!body) return true
    const account = this.account()
    if (!account.token) return false
    const chunks = splitText(markdownToText(body), this.cfg.reply.maxChunkChars)
    for (const chunk of chunks) {
      await this.pace()
      try {
        await this.api.sendText({
          baseUrl: account.baseUrl,
          token: account.token,
          toUserId: String(chatId),
          text: chunk,
        })
      } catch (error) {
        this.debug(`发送失败（${maskId(chatId)}）：${error?.message ?? error}`)
        this.audit({ kind: 'send-failed', chatId, error: String(error?.message ?? error) })
        return false
      }
    }
    return true
  }

  /**
   * Send one local file to a chat.
   *
   * The order is the protocol's, not a choice: `getuploadurl` must be told the
   * plaintext size, the plaintext MD5 and the *ciphertext* size before the
   * ciphertext exists, so the payload is encrypted first and the numbers are
   * derived from it. The CDN then answers with a reference that goes into the
   * message item, not the bytes.
   *
   * An optional caption is sent as its own text message first, so the file
   * arrives with the explanation already on screen.
   */
  async sendMedia(chatId, filePath, caption = '') {
    const account = this.account()
    if (!account.token) return false
    let plaintext
    try {
      plaintext = await readFile(filePath)
    } catch (error) {
      this.audit({ kind: 'send-media-failed', chatId, error: String(error?.message ?? error) })
      return false
    }
    const limit = Math.min(MAX_MEDIA_BYTES, Math.max(1, Number(this.cfg.media?.maxBytes) || MAX_MEDIA_BYTES))
    if (plaintext.length > limit) {
      this.audit({ kind: 'send-media-failed', chatId, error: `文件过大（${plaintext.length} 字节）` })
      return false
    }
    const fileName = path.basename(String(filePath))
    const kind = kindForFileName(fileName)
    const { uploadType } = mediaTypes(kind)
    const aesKeyHex = newAesKeyHex()
    const filekey = newFilekey()
    const fingerprint = uploadFingerprint(plaintext)
    try {
      const target = await this.api.getUploadUrl({
        baseUrl: account.baseUrl,
        token: account.token,
        toUserId: String(chatId),
        filekey,
        mediaType: uploadType,
        rawsize: fingerprint.rawsize,
        rawfilemd5: fingerprint.rawfilemd5,
        filesize: fingerprint.filesize,
        aeskey: aesKeyHex,
      })
      const reference = await uploadToCdn({
        fetchImpl: this.fetchImpl ?? fetch,
        uploadFullUrl: target?.upload_full_url,
        uploadParam: target?.upload_param,
        filekey,
        ciphertext: encryptEcb(plaintext, Buffer.from(aesKeyHex, 'hex')),
      })
      if (caption) await this.sendText(chatId, caption)
      await this.pace()
      await this.api.sendItems({
        baseUrl: account.baseUrl,
        token: account.token,
        toUserId: String(chatId),
        itemList: [mediaItemFor({
          kind,
          uploadParam: reference,
          aesKeyHex,
          size: plaintext.length,
          fileName,
        })],
      })
      return true
    } catch (error) {
      this.debug(`发送附件失败（${maskId(chatId)}）：${error?.message ?? error}`)
      this.audit({ kind: 'send-media-failed', chatId, error: String(error?.message ?? error) })
      return false
    }
  }

  /** Serialize sends so two messages never arrive closer than `sendIntervalMs`. */
  async pace() {
    const slot = this.sendChain.then(async () => {
      const wait = this.lastSendAt + this.cfg.turn.sendIntervalMs - Date.now()
      if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait))
      this.lastSendAt = Date.now()
    })
    this.sendChain = slot.catch(() => {})
    return slot
  }

  /**
   * Resolve (and cache) one chat's typing ticket.
   *
   * The ticket comes from `getconfig` and is per user. It is cached with an
   * expiry because the platform rotates it: a ticket cached forever made the
   * indicator work for a day and then silently stop, with the failure swallowed
   * by `.catch(() => {})`. The reason for a failed fetch is recorded in
   * `typingState` and shown by `/诊断`, so "看不到正在输入" is diagnosable from
   * inside WeChat instead of requiring a log dive.
   */
  async typingTicket(chatId, contextToken) {
    const cached = this.typingTickets.get(chatId)
    if (cached && cached.expiresAt > Date.now()) return cached.ticket
    const account = this.account()
    if (!account.token) return ''
    try {
      const config = await this.api.getConfig({
        baseUrl: account.baseUrl, token: account.token,
        ilinkUserId: chatId, contextToken,
      })
      const ticket = String(config?.typing_ticket ?? '')
      if (!ticket) {
        this.typingState = { ok: false, detail: 'getconfig 没有返回 typing_ticket', at: Date.now() }
        return ''
      }
      this.typingTickets.set(chatId, { ticket, expiresAt: Date.now() + TYPING_TICKET_TTL_MS })
      this.typingState = { ok: true, detail: '已取得输入状态票据', at: Date.now() }
      return ticket
    } catch (error) {
      this.typingState = { ok: false, detail: `getconfig 失败：${error?.message ?? error}`, at: Date.now() }
      this.debug(`读取输入状态票据失败：${error?.message ?? error}`)
      return ''
    }
  }

  /** Send one typing status, recording why it failed instead of swallowing it. */
  async sendTypingStatus(chatId, ticket, status) {
    const account = this.account()
    if (!account.token) return false
    try {
      await this.api.sendTyping({
        baseUrl: account.baseUrl, token: account.token,
        to: chatId, typingTicket: ticket, status,
      })
      this.typingState = { ok: true, detail: status === 1 ? '已显示正在输入' : '已清除正在输入', at: Date.now() }
      return true
    } catch (error) {
      // A rejected status (ret != 0) usually means the ticket went stale; drop
      // it so the next message fetches a fresh one.
      if (status === 1) this.typingTickets.delete(chatId)
      this.typingState = { ok: false, detail: `sendtyping 失败：${error?.message ?? error}`, at: Date.now() }
      this.debug(`发送输入状态失败：${error?.message ?? error}`)
      return false
    }
  }

  /**
   * Turn the "对方正在输入…" indicator on and KEEP it on.
   *
   * iLink expires a typing status a few seconds after it is sent, so a single
   * `status: 1` before a multi-minute turn produced an indicator that blinked
   * once and vanished. Two things were wrong: the refresh (now here) and the
   * request itself — `sendtyping` takes `ilink_user_id` + `status`, and sending
   * `to_user_id` + `typing_status` was accepted by HTTP and did nothing at all.
   */
  async showTyping(chatId, contextToken) {
    // Refcounted: since the poller no longer waits for a turn, a /状态 or
    // /停止 can arrive while a turn is still running. Both take the indicator,
    // and the command finishing first must not switch it off under the turn.
    this.typingRefs.set(chatId, (this.typingRefs.get(chatId) ?? 0) + 1)
    const account = this.account()
    if (!account.token) return
    if (contextToken) this.typingContexts.set(chatId, String(contextToken))
    const ticket = await this.typingTicket(chatId, contextToken)
    if (!ticket) return

    await this.sendTypingStatus(chatId, ticket, 1)
    // Re-arm only once per chat; repeated messages must not stack timers.
    if (this.typingTimers.has(chatId)) return
    const period = Math.max(1_000, Number(this.cfg.reply.typingIntervalMs) || 4_000)
    const timer = setInterval(() => {
      const current = this.typingTickets.get(chatId)
      if (current) {
        void this.sendTypingStatus(chatId, current.ticket, 1)
        return
      }
      // A rejected status drops the ticket; without a refetch here a long turn
      // would lose the indicator halfway through and never get it back.
      void this.typingTicket(chatId, this.typingContexts.get(chatId)).then((ticket) => {
        if (ticket) void this.sendTypingStatus(chatId, ticket, 1)
      })
    }, period)
    if (typeof timer?.unref === 'function') timer.unref()
    this.typingTimers.set(chatId, timer)
  }

  /**
   * Release one claim on the indicator; the last one clears it.
   *
   * A command answered during a running turn releases only its own claim, so
   * the turn keeps its "正在输入…" until the turn itself ends.
   */
  hideTyping(chatId) {
    const held = this.typingRefs.get(chatId) ?? 0
    // Nothing claimed it (e.g. /重试 re-enters runTurn from a command that
    // already released its claim): do not send a second stop.
    if (held <= 0) return
    if (held > 1) {
      this.typingRefs.set(chatId, held - 1)
      return
    }
    this.typingRefs.delete(chatId)
    const timer = this.typingTimers.get(chatId)
    if (timer) {
      clearInterval(timer)
      this.typingTimers.delete(chatId)
    }
    const account = this.account()
    const ticket = this.typingTickets.get(chatId)?.ticket
    if (!account.token || !ticket) return
    void this.sendTypingStatus(chatId, ticket, 2)
  }

  // ── commands ─────────────────────────────────────────────────────────────

  async runCommand(chatId, parsed) {
    switch (parsed.name) {
      case 'help': return this.sendText(chatId, helpText())
      case 'status': return this.commandStatus(chatId)
      case 'new': return this.commandNew(chatId)
      case 'workspace': return this.commandWorkspace(chatId, parsed.args)
      case 'model': return this.commandModel(chatId, parsed.args)
      case 'reasoning': return this.commandReasoning(chatId, parsed.args)
      case 'permission': return this.commandPermission(chatId, parsed.args)
      case 'plan': return this.commandPlan(chatId, parsed.args)
      case 'reply': return this.commandReply(chatId, parsed.args)
      case 'sessions': return this.commandSessions(chatId)
      case 'stop': return this.commandStop(chatId)
      case 'retry': return this.commandRetry(chatId)
      case 'log': return this.commandLog(chatId)
      case 'mute': return this.commandMute(chatId, true)
      case 'unmute': return this.commandMute(chatId, false)
      case 'approve': return this.commandApprove(chatId, parsed.args)
      case 'answer': return this.commandAnswer(chatId, parsed.args)
      case 'trust': return this.commandTrust(chatId, parsed.args)
      case 'revoke': return this.commandRevoke(chatId, parsed.args)
      case 'diag': return this.commandDiag(chatId)
      case 'unbind': return this.commandUnbind(chatId)
      case 'preset': return this.commandPreset(chatId, parsed.args)
      default: return this.sendText(chatId, '未知命令，发送 /帮助 查看可用命令。')
    }
  }

  async commandStatus(chatId) {
    const binding = this.bindings.ensure(chatId)
    const workspace = this.router.workspaceFor(binding, this.cfg.defaults.workspace || process.cwd())
    const sessionId = this.bindings.sessionFor(binding, workspace) ?? ''
    const agent = sessionId ? this.agents().get(sessionId) : null
    const selection = agentSelection(agent) ?? binding.model ?? await this.defaultSelection()
    const workspaces = await this.availableWorkspaces()
    const agentPreset = binding.agentPreset || (await this.router.resolvePreset(binding)).id || ''
    await this.sendText(chatId, statusCard({
      workspace,
      model: modelLabel(selection),
      sessionId,
      agentPreset,
      permissionPreset: binding.permissionPreset || this.cfg.defaults.permissionPreset || '',
      planMode: Boolean(binding.planMode),
      running: agent ? this.router.isBusy(agent) : false,
      queued: this.queueDepth(chatId),
      connected: this.status.connected,
      lastEventAt: this.status.lastEventAt,
      workspaceCount: workspaces.length,
      muted: binding.muted,
      granularity: binding.replyGranularity,
    }))
  }

  async commandNew(chatId) {
    // `composeSetup()` returns the callback itself; wrapping it in another arrow
    // function silently dropped the channel instruction and the stream listener.
    const result = await this.router.reset(chatId, this.composeSetup())
    if (!result.ok) return this.sendText(chatId, '⏳ 当前会话仍在运行，先发送 /停止 再新建。')
    const selection = result.agent?.model?.current?.() ?? await this.defaultSelection()
    return this.sendText(chatId, [
      '✅ 已开始新的任务草稿。',
      `工作区：${result.workspace}`,
      `模型：${modelLabel(selection)}`,
      `预设：${result.agentPreset || '（部署默认）'}`,
      '',
      '直接发送任务即可，例如：帮我部署。',
    ].join('\n'))
  }

  async availableWorkspaces() {
    const allowed = this.cfg.allowedWorkspaces ?? []
    try {
      const registered = this.service('workspaceRegistry')?.list?.() ?? []
      const paths = registered.map((workspace) => workspace.path).filter(Boolean)
      const filtered = allowed.length ? paths.filter((path) => allowed.includes(path)) : paths
      if (filtered.length) return [...new Set(filtered)]
    } catch (error) {
      this.debug(`读取工作区失败：${error?.message ?? error}`)
    }
    return allowed.length ? [...allowed] : [this.cfg.defaults.workspace || process.cwd()]
  }

  /**
   * The Agent presets a default can be set to, for the panel's picker.
   *
   * Returns an empty list rather than throwing when the deployment has no
   * registry: the panel then renders a free-text input instead of breaking.
   */
  async availablePresets() {
    if (!this.cfg.features.agentPreset) return []
    const presets = this.service('agentPresets')
    if (!presets?.list) return []
    try {
      const rows = await presets.list()
      return (rows ?? []).filter((row) => row?.id).map((row) => ({
        id: row.id,
        name: row.name ?? row.id,
        broken: Boolean(row.broken),
      }))
    } catch (error) {
      this.debug(`读取预设失败：${error?.message ?? error}`)
      return []
    }
  }

  async commandWorkspace(chatId, args) {
    const binding = this.bindings.ensure(chatId)
    const current = this.router.workspaceFor(binding, this.cfg.defaults.workspace || process.cwd())
    const workspaces = await this.availableWorkspaces()

    if (args.length) {
      const selector = args.join(' ')
      const target = /^\d+$/.test(selector)
        ? workspaces[Number(selector) - 1]
        : workspaces.find((path) => path === selector)
          ?? workspaces.find((path) => path.toLowerCase().endsWith(selector.toLowerCase()))
      if (!target) return this.sendText(chatId, `未找到工作区：${selector}\n发送 /项目 查看可选项。`)
      return this.switchWorkspace(chatId, target)
    }

    const items = workspaces.map((path) => `${path}${path === current ? '（当前）' : ''}`)
    this.pending.set(chatId, 'workspace', workspaces)
    return this.sendText(chatId, menuFor(
      'workspace',
      `当前工作区：${current}\n选择工作区（回复数字，0 取消）：`,
      items,
      '切换后会使用该工作区自己的会话；原工作区的会话保留，切回去即可继续。',
    ))
  }

  async switchWorkspace(chatId, workspace) {
    const result = await this.router.switchWorkspace(chatId, workspace)
    if (!result.ok) return this.sendText(chatId, '⏳ 当前会话仍在运行，先发送 /停止 再切换工作区。')
    const binding = this.bindings.get(chatId)
    const existing = this.bindings.sessionFor(binding, workspace)
    return this.sendText(chatId, [
      `✅ 已切换到工作区：${workspace}`,
      existing ? `沿用已有会话 ${existing}。` : '该工作区还没有会话，下一条消息会新建。',
    ].join('\n'))
  }

  /** Flatten the model catalog into stable, numbered entries. */
  async modelCatalog() {
    const entries = []
    const llm = this.service('llm')
    if (!llm?.listProviders) return entries
    const allowed = this.cfg.allowedModels ?? []
    for (const provider of llm.listProviders()) {
      const providerId = provider?.id ?? provider?.provider ?? ''
      if (!providerId) continue
      let models = []
      try {
        models = await llm.listModels(providerId)
      } catch (error) {
        this.debug(`列出 ${providerId} 模型失败：${error?.message ?? error}`)
        continue
      }
      for (const model of models ?? []) {
        const key = `${providerId}/${model.id}`
        if (allowed.length && !allowed.includes(key)) continue
        entries.push({ provider: providerId, model: model.id, name: model.name ?? model.id })
      }
    }
    return entries
  }

  async commandModel(chatId, args) {
    const catalog = await this.modelCatalog()
    if (!catalog.length) return this.sendText(chatId, '⚠️ 当前没有可用模型（检查 provider 配置）。')

    if (args.length) {
      const selector = args.join(' ')
      const target = /^\d+$/.test(selector)
        ? catalog[Number(selector) - 1]
        : catalog.find((entry) => `${entry.provider}/${entry.model}` === selector)
          ?? catalog.find((entry) => entry.model === selector)
      if (!target) return this.sendText(chatId, `未找到模型：${selector}\n发送 /模型 查看可选项。`)
      return this.applyModelChoice(chatId, target)
    }

    const binding = this.bindings.ensure(chatId)
    const current = binding.model ? `${binding.model.provider}/${binding.model.model}` : ''
    const items = catalog.map((entry) => {
      const key = `${entry.provider}/${entry.model}`
      return `${key}${key === current ? '（当前）' : ''}`
    })
    this.pending.set(chatId, 'model', catalog)
    return this.sendText(chatId, menuFor(
      'model',
      `当前模型：${current || '（跟随默认）'}\n选择模型（回复数字，0 取消）：`,
      items,
      '切换在当前会话立即生效，历史保留；回合运行中会在下一回合生效。',
    ))
  }

  async applyModelChoice(chatId, entry) {
    const result = await this.router.selectModel(chatId, { provider: entry.provider, model: entry.model })
    const label = `${entry.provider}/${entry.model}`
    if (result === 'unchanged') return this.sendText(chatId, `ℹ️ 已经是 ${label}。`)
    if (result === 'deferred') return this.sendText(chatId, `🕓 已记录 ${label}，当前回合结束后生效。`)
    return this.sendText(chatId, `✅ 已切换到 ${label}，下一条消息即生效。`)
  }

  async commandReasoning(chatId, args) {
    const binding = this.bindings.ensure(chatId)
    const selection = binding.model ?? await this.defaultSelection()
    if (!selection?.provider || !selection?.model) {
      return this.sendText(chatId, '⚠️ 还没有选定模型，先发送 /模型。')
    }
    let info = null
    try {
      info = await this.service('llm')?.resolveModelInfo?.(selection.provider, selection.model)
    } catch (error) {
      this.debug(`读取模型信息失败：${error?.message ?? error}`)
    }
    const efforts = info?.reasoning?.efforts ?? []
    if (!efforts.length) return this.sendText(chatId, `ℹ️ ${selection.provider}/${selection.model} 不支持思考档位。`)

    const ids = efforts.map((effort) => effort.id ?? effort)
    if (args.length) {
      const selector = args[0]
      const target = /^\d+$/.test(selector) ? ids[Number(selector) - 1] : ids.find((id) => id === selector)
      if (!target) return this.sendText(chatId, `未找到档位：${selector}\n可选：${ids.join(' / ')}`)
      await this.router.selectModel(chatId, { ...selection, reasoningEffort: target })
      return this.sendText(chatId, `✅ 思考档位已切换为 ${target}。`)
    }

    this.pending.set(chatId, 'reasoning', ids)
    return this.sendText(chatId, menuFor(
      'reasoning',
      `当前思考档位：${selection.reasoningEffort || '默认'}\n选择档位（回复数字，0 取消）：`,
      ids.map((id) => `${id}${id === selection.reasoningEffort ? '（当前）' : ''}`),
    ))
  }

  async commandPermission(chatId, args) {
    const binding = this.bindings.ensure(chatId)
    let catalog = null
    try {
      catalog = this.service('permissionPresets')?.catalog?.() ?? null
    } catch (error) {
      this.debug(`读取权限预设失败：${error?.message ?? error}`)
    }
    const names = (catalog?.options ?? []).map((option) => option.name ?? option.id ?? option).filter(Boolean)
    if (!names.length) return this.sendText(chatId, '⚠️ 当前部署没有配置权限预设。')

    if (args.length) {
      const selector = args[0]
      const target = /^\d+$/.test(selector) ? names[Number(selector) - 1] : names.find((entry) => entry === selector)
      if (!target) return this.sendText(chatId, `未找到权限模式：${selector}\n可选：${names.join(' / ')}`)
      return this.applyPermission(chatId, target)
    }

    const current = binding.permissionPreset || ''
    this.pending.set(chatId, 'permission', names)
    return this.sendText(chatId, menuFor(
      'permission',
      `当前权限模式：${current || '（跟随默认）'}\n选择模式（回复数字，0 取消）：`,
      names.map((entry) => `${entry}${entry === current ? '（当前）' : ''}`),
      'danger-full-access 会让微信消息可写整盘，请只在完全可信的账号上使用。',
    ))
  }

  async applyPermission(chatId, preset) {
    const binding = this.bindings.ensure(chatId)
    const workspace = this.router.workspaceFor(binding, this.cfg.defaults.workspace || process.cwd())
    const sessionId = this.bindings.sessionFor(binding, workspace)
    binding.permissionPreset = preset
    await this.bindings.store.save()
    if (sessionId) {
      const session = this.agents().get(sessionId)?.session
      try {
        if (session) this.service('permissionPresets')?.set?.(session, preset)
      } catch (error) {
        this.debug(`应用权限预设失败：${error?.message ?? error}`)
      }
    }
    return this.sendText(chatId, `✅ 权限模式已切换为 ${preset}。`)
  }

  async commandPlan(chatId, args) {
    if (!this.cfg.features.planMode) return this.sendText(chatId, 'ℹ️ 本部署未启用计划模式。')
    const binding = this.bindings.ensure(chatId)
    const workspace = this.router.workspaceFor(binding, this.cfg.defaults.workspace || process.cwd())
    const sessionId = this.bindings.sessionFor(binding, workspace)
    const agent = sessionId ? this.agents().get(sessionId) : null
    if (!agent) return this.sendText(chatId, 'ℹ️ 还没有会话，先发一条消息或 /新建。')
    const next = args.length ? !/^(off|关|关闭|false|0)$/i.test(args[0]) : !this.service('planMode')?.get?.(agent)?.active
    try {
      this.service('planMode')?.set?.(agent, next)
      binding.planMode = next
      await this.bindings.store.save()
      return this.sendText(chatId, next ? '🧭 计划模式已开启。' : '▶️ 计划模式已关闭。')
    } catch (error) {
      return this.sendText(chatId, `⚠️ 切换计划模式失败：${error?.message ?? error}`)
    }
  }

  async commandReply(chatId, args) {
    const binding = this.bindings.ensure(chatId)
    const levels = ['summary', 'standard', 'full']
    const labels = { summary: '摘要', standard: '标准', full: '完整' }
    if (args.length) {
      const selector = args[0]
      const target = /^\d+$/.test(selector) ? levels[Number(selector) - 1] : levels.find((level) => level === selector)
      if (!target) return this.sendText(chatId, `可选：${levels.map((level, index) => `${index + 1}) ${labels[level]}`).join('  ')}`)
      binding.replyGranularity = target
      await this.bindings.store.save()
      return this.sendText(chatId, `✅ 回复详细程度：${labels[target]}。`)
    }
    this.pending.set(chatId, 'granularity', levels)
    return this.sendText(chatId, menuFor(
      'reply',
      `当前回复详细程度：${labels[binding.replyGranularity] ?? '标准'}\n选择（回复数字，0 取消）：`,
      levels.map((level) => `${labels[level]}${level === binding.replyGranularity ? '（当前）' : ''}`),
    ))
  }

  /**
   * `/预设` — list the Agent presets this deployment declares and pick one.
   *
   * The preset is what decides which tools an Agent gets at all: on the Web /
   * Desktop bundle the local file, shell, skill and compaction rows live inside
   * a preset, not on the host plane. A chat bound to a preset therefore keeps
   * its file/shell tools; one without a preset only sees host-plane plugins
   * (remote SSH, MCP) and reads as "nothing works".
   *
   * A preset is fixed when a Session is created, so switching stores the choice
   * on the binding and starts a fresh session — the old one stays openable.
   */
  async commandPreset(chatId, args) {
    if (!this.cfg.features.agentPreset) {
      return this.sendText(chatId, 'ℹ️ 本部署未启用 Agent 预设切换（features.agentPreset）。')
    }
    const presets = this.service('agentPresets')
    if (!presets?.list) return this.sendText(chatId, 'ℹ️ 当前组合没有 Agent 预设注册表，会话按部署默认能力运行。')

    let rows = []
    try {
      rows = (await presets.list()).filter((row) => row?.id)
    } catch (error) {
      return this.sendText(chatId, `⚠️ 读取预设失败：${error?.message ?? error}`)
    }
    if (!rows.length) return this.sendText(chatId, 'ℹ️ 没有声明任何 Agent 预设。')

    const binding = this.bindings.ensure(chatId)
    const current = binding.agentPreset || (await this.router.resolvePreset(binding)).id || ''

    if (args.length) {
      const selector = args.join(' ')
      const target = /^\d+$/.test(selector)
        ? rows[Number(selector) - 1]
        : rows.find((row) => row.id === selector)
      if (!target) return this.sendText(chatId, `未找到预设：${selector}\n发送 /预设 查看可选项。`)
      return this.applyPreset(chatId, target.id)
    }

    this.pending.set(chatId, 'preset', rows.map((row) => row.id))
    return this.sendText(chatId, menuFor(
      'preset',
      `当前预设：${current || '（部署默认）'}\n选择预设（回复数字，0 取消）：`,
      rows.map((row) => {
        const broken = row.broken ? ' · ⚠️ 不可用' : ''
        return `${row.id}${row.name ? ' · ' + row.name : ''}${row.id === current ? '（当前）' : ''}${broken}`
      }),
      '预设决定这个会话能用哪些工具（文件、终端、技能等）。切换会新开一个会话，旧会话保留。',
    ))
  }

  async applyPreset(chatId, presetId) {
    const binding = this.bindings.ensure(chatId)
    binding.agentPreset = presetId
    await this.bindings.store.save()
    this.audit({ kind: 'preset/select', chatId, agentPreset: presetId })
    return this.sendText(chatId, [
      `✅ 预设已设为 ${presetId}。`,
      '下一条消息会新开会话并按该预设挂载工具；旧会话在网页端仍可打开。',
    ].join('\n'))
  }

  async commandSessions(chatId) {
    const binding = this.bindings.ensure(chatId)
    const workspace = this.router.workspaceFor(binding, this.cfg.defaults.workspace || process.cwd())
    let rows = []
    try {
      const all = await this.service('sessionQuery')?.listSessions?.() ?? []
      rows = all.filter((row) => row?.header?.cwd === workspace).slice(0, 12)
    } catch (error) {
      this.debug(`列出会话失败：${error?.message ?? error}`)
    }
    if (!rows.length) return this.sendText(chatId, `该工作区（${workspace}）还没有会话。`)
    const ids = rows.map((row) => row.header.id)
    this.pending.set(chatId, 'sessions', ids)
    return this.sendText(chatId, menuFor(
      'sessions',
      `工作区 ${workspace} 的会话（回复数字绑定，0 取消）：`,
      rows.map((row) => `${row.header.id}${row.live ? ' · 运行中' : ''}`),
    ))
  }

  async commandStop(chatId) {
    const stopped = await this.router.cancel(chatId)
    return this.sendText(chatId, stopped ? '⏹️ 已请求中断当前任务。' : 'ℹ️ 当前没有运行中的任务。')
  }

  async commandRetry(chatId) {
    const binding = this.bindings.ensure(chatId)
    const workspace = this.router.workspaceFor(binding, this.cfg.defaults.workspace || process.cwd())
    const sessionId = this.bindings.sessionFor(binding, workspace)
    const text = sessionId ? this.lastUserText.get(sessionId) : ''
    if (!text) return this.sendText(chatId, 'ℹ️ 没有可重试的任务。')
    // /重试 starts a turn from inside a command, and handleInbound already
    // released the claim it took for that command — so the retried turn claims
    // the indicator itself, and runTurn's finally releases it.
    await this.showTyping(chatId)
    return this.dispatchTask(chatId, { from_user_id: chatId }, text)
  }

  async commandLog(chatId) {
    const binding = this.bindings.ensure(chatId)
    const workspace = this.router.workspaceFor(binding, this.cfg.defaults.workspace || process.cwd())
    const sessionId = this.bindings.sessionFor(binding, workspace)
    const output = sessionId ? this.lastOutput.get(sessionId) : ''
    if (!output) return this.sendText(chatId, 'ℹ️ 暂无完整输出。')
    // No clip here: `sendText` already splits at `reply.maxChunkChars`, so the
    // command that promises "完整输出" must not itself truncate.
    return this.sendText(chatId, markdownToText(output))
  }

  async commandMute(chatId, muted) {
    this.bindings.touch(chatId, { muted })
    return this.sendText(chatId, muted ? '🔕 本聊天通知已关闭（审批仍会推送）。' : '🔔 本聊天通知已开启。')
  }

  async commandApprove(chatId, args) {
    const [id, verdict] = args
    if (!id || !verdict) return this.sendText(chatId, '用法：/审批 <编号> 允许|拒绝')
    const allow = /^(yes|y|允许|同意|通过|ok)$/i.test(verdict)
    const result = this.approvals.respond(id, allow)
    const texts = {
      accepted: `✅ 已允许 #${id}。`,
      rejected: `❌ 已拒绝 #${id}。`,
      already: `ℹ️ #${id} 已经处理过了。`,
      unknown: `ℹ️ #${id} 不存在或已超时。`,
    }
    return this.sendText(chatId, texts[result] ?? `ℹ️ ${result}`)
  }

  /**
   * `/回答 <id> <选项>` — deliver an answer to a pending question card.
   *
   * The bridge has always sent "回复 /回答 <id> <编号>" and always had
   * `respond()` ready, but the command itself was missing from the table: the
   * reply parsed as an unknown slash command, so every question could only
   * time out into "skipped" and the model was told the user declined.
   */
  async commandAnswer(chatId, args) {
    const [id, ...rest] = args
    const raw = rest.join(' ').trim()
    if (!id || !raw) {
      const open = this.questions.list()
      return this.sendText(chatId, open.length
        ? [`用法：/回答 <编号> <选项>，多选用逗号（如 1,3），多个问题用分号（如 1; 2）。`, '', '待回答：',
          ...open.map((entry) => `#${entry.id} · ${entry.questions} 个问题 · ${entry.ageSec}s 前`)].join('\n')
        : '用法：/回答 <编号> <选项>\n当前没有待回答的提问。')
    }
    const result = this.questions.respond(id, raw)
    const texts = {
      answered: `✅ 已回答 #${id}。`,
      unknown: `ℹ️ #${id} 不存在或已超时。发送 /回答 查看待回答列表。`,
    }
    return this.sendText(chatId, texts[result] ?? `ℹ️ ${result}`)
  }

  async commandTrust(chatId, args) {
    const target = args[0]
    if (!target) return this.sendText(chatId, '用法：/信任 <用户id>')
    this.bindings.allow(target)
    this.audit({ kind: 'trust/add', by: chatId, target })
    return this.sendText(chatId, `✅ 已信任 ${maskId(target)}。`)
  }

  async commandRevoke(chatId, args) {
    const target = args[0]
    if (!target) return this.sendText(chatId, '用法：/撤销 <用户id>')
    this.bindings.revoke(target)
    this.audit({ kind: 'trust/revoke', by: chatId, target })
    return this.sendText(chatId, `✅ 已撤销 ${maskId(target)}。`)
  }

  async commandDiag(chatId) {
    const account = this.account()
    const lines = [
      '🩺 诊断',
      `通道：${this.status.connected ? '已连接' : '未连接'} · ${this.status.detail}`,
      `账号：${account.accountId ? maskId(account.accountId) : '（未绑定）'}`,
      `Token：${account.token ? '已配置' : '缺失'}`,
      `游标：${this.bind.readCursor() ? '已保存' : '空'}`,
      `绑定聊天：${this.bindings.list().length}`,
      `待审批：${this.approvals.list().length}`,
      `待回答：${this.questions.list().length}`,
      `正在输入：${this.typingState.ok === null ? '尚未尝试' : this.typingState.ok ? this.typingState.detail : `未生效 · ${this.typingState.detail}`}`,
      `票据缓存：${this.typingTickets.size} 个聊天`,
      `最近错误：${this.status.lastError ?? '无'}`,
    ]
    return this.sendText(chatId, lines.join('\n'))
  }

  async commandUnbind(chatId) {
    this.bindings.remove(chatId)
    return this.sendText(chatId, '✅ 已解除本聊天的绑定（DSH 会话本身保留）。')
  }

  /** Apply one numbered-menu choice. */
  async applyChoice(chatId, pending, value) {
    switch (pending.kind) {
      case 'workspace': return this.switchWorkspace(chatId, String(value))
      case 'model': return this.applyModelChoice(chatId, value)
      case 'reasoning': {
        const binding = this.bindings.ensure(chatId)
        const selection = binding.model ?? await this.defaultSelection()
        await this.router.selectModel(chatId, { ...selection, reasoningEffort: String(value) })
        return this.sendText(chatId, `✅ 思考档位已切换为 ${value}。`)
      }
      case 'permission': return this.applyPermission(chatId, String(value))
      case 'preset': return this.applyPreset(chatId, String(value))
      case 'granularity': {
        this.bindings.touch(chatId, { replyGranularity: String(value) })
        return this.sendText(chatId, `✅ 回复详细程度已切换为 ${value}。`)
      }
      case 'sessions': {
        const binding = this.bindings.ensure(chatId)
        const workspace = this.router.workspaceFor(binding, this.cfg.defaults.workspace || process.cwd())
        this.bindings.setSession(chatId, workspace, String(value))
        return this.sendText(chatId, `✅ 已绑定会话 ${value}。`)
      }
      default:
        return this.sendText(chatId, 'ℹ️ 该选项暂不支持。')
    }
  }

  // ── model / workspace defaults ───────────────────────────────────────────

  async defaultSelection() {
    const configured = this.cfg.defaults.model
    if (configured?.provider && configured?.model) {
      return {
        provider: configured.provider,
        model: configured.model,
        ...(configured.reasoningEffort ? { reasoningEffort: configured.reasoningEffort } : {}),
      }
    }
    try {
      const selection = this.service('agentDefaultModel')?.currentSelection?.()
      if (selection?.provider && selection?.model) return selection
    } catch {
      // Fall through to the first advertised model.
    }
    const catalog = await this.modelCatalog()
    if (catalog.length) return { provider: catalog[0].provider, model: catalog[0].model }
    throw new Error('没有可用的模型：请在 DSH 中配置至少一个 provider')
  }

  // ── panel API ────────────────────────────────────────────────────────────

  async panelAction(action, payload) {
    switch (action) {
      case 'status':
        return {
          connected: this.status.connected,
          detail: this.status.detail,
          lastEventAt: this.status.lastEventAt,
          lastError: this.status.lastError,
          accountId: this.account().accountId ? maskId(this.account().accountId) : '',
          bindings: this.bindings.list().map(publicBinding),
          pendingTrust: this.bindings.pendingTrust(),
          allowlist: [...new Set([...(this.cfg.security.allowlist ?? []), ...this.bindings.list().map((b) => b.chatId)])],
          workspaces: await this.availableWorkspaces(),
          models: (await this.modelCatalog()).map((entry) => `${entry.provider}/${entry.model}`),
          // The saved defaults, so the panel shows what is actually in force
          // instead of guessing from the first binding's workspace.
          defaults: {
            workspace: this.cfg.defaults.workspace ?? '',
            model: this.cfg.defaults.model?.provider && this.cfg.defaults.model?.model
              ? `${this.cfg.defaults.model.provider}/${this.cfg.defaults.model.model}`
              : '',
            permissionPreset: this.cfg.defaults.permissionPreset ?? '',
            // Editable here because the panel is the only place a default can
            // be set without hand-editing defaults.json.
            agentPreset: this.cfg.defaults.agentPreset ?? '',
          },
          presets: await this.availablePresets(),
          bind: redactBind(this.bind.getState()),
        }
      case 'bind.begin':
        await this.bind.begin()
        return redactBind(this.bind.getState())
      case 'bind.poll': {
        // Kept for older panels. The QR poller itself now reports success
        // through `onBound`, so the browser no longer has to ask — which is
        // why scanning used to bind a token that nothing ever polled.
        const state = this.bind.getState()
        if (state.phase === 'succeeded' && !this.polling) {
          this.restartPolling()
        }
        return redactBind(state)
      }
      case 'bind.verify':
        this.bind.submitVerifyCode(payload.code)
        return redactBind(this.bind.getState())
      case 'bind.cancel':
        this.bind.cancel()
        return redactBind(this.bind.getState())
      case 'connection.reconnect':
        return this.restartPolling()
      case 'sessions.wechat': {
        // The sidebar row mark has no access to the channel service, so it asks
        // this loopback route which of the listed ids this channel owns.
        const ids = Array.isArray(payload.sessionIds)
          ? payload.sessionIds
          : String(payload.sessionIds ?? '').split(',')
        return { sessionIds: this.wechatSessions(ids) }
      }
      case 'workspace.repair':
        // Manual repair: the sidebar groups by registry membership, so a chat
        // created before the attach fix needs an explicit re-attach.
        await this.repairWorkspaceMembership()
        return { ok: true }
      case 'diag.net':
        return this.diagnoseNetwork()
      case 'trust.add':
        this.bindings.allow(payload.userId)
        return { ok: true }
      case 'trust.revoke':
        this.bindings.revoke(payload.userId)
        return { ok: true }
      case 'chats.unbind':
        this.bindings.remove(payload.chatId)
        return { ok: true }
      case 'chats.mute': {
        // Muting is the panel's twin of /静音: same field, so a chat muted
        // either way behaves identically in notify.js.
        const chatId = String(payload.chatId ?? '')
        if (!chatId) throw new Error('缺少 chatId。')
        this.bindings.touch(chatId, { muted: Boolean(payload.muted) })
        this.audit({ kind: 'chat/mute', chatId, muted: Boolean(payload.muted), by: 'panel' })
        return { ok: true, muted: Boolean(payload.muted) }
      }
      case 'defaults.set': {
        // Validate before writing: a rejected value must leave the previous
        // default in place rather than half-applying a broken one.
        let model = null
        if (payload.model) {
          model = parseModelKey(payload.model)
          if (!model) throw new Error(`无效的模型标识：${payload.model}`)
        }
        if (payload.workspace) this.cfg.defaults.workspace = String(payload.workspace)
        if (model) this.cfg.defaults.model = model
        if (payload.permissionPreset) this.cfg.defaults.permissionPreset = String(payload.permissionPreset)
        // An empty string is a real value here: it means "follow the
        // deployment default", which is what a cleared input should do.
        if (payload.agentPreset !== undefined) this.cfg.defaults.agentPreset = String(payload.agentPreset)
        writeJson(this.defaultsFile, {
          version: 1,
          workspace: this.cfg.defaults.workspace ?? '',
          model: this.cfg.defaults.model?.provider && this.cfg.defaults.model?.model
            ? {
              provider: this.cfg.defaults.model.provider,
              model: this.cfg.defaults.model.model,
              reasoningEffort: this.cfg.defaults.model.reasoningEffort ?? '',
            }
            : null,
          permissionPreset: this.cfg.defaults.permissionPreset ?? '',
          agentPreset: this.cfg.defaults.agentPreset ?? '',
          savedAt: Date.now(),
        })
        return { ok: true }
      }
      default:
        throw new Error(`未知 action：${action}`)
    }
  }

  // ── utilities ────────────────────────────────────────────────────────────

  /**
   * Read an optional Host service. These are peers of this plugin, not hard
   * dependencies: a headless composition may lack any of them, and a missing
   * one must degrade a single command instead of breaking the channel.
   */
  service(key) {
    try {
      return this.ctx.get?.(key) ?? this.ctx[key]
    } catch {
      return undefined
    }
  }

  /** The Agent registry; a hard dependency, so a missing one is a real error. */
  agents() {
    const registry = this.service('agents')
    if (!registry) throw new Error('weixin-channel: the agents service is not mounted')
    return registry
  }

  debug(line) {
    if (this.cfg.debug) this.logger.info(line)
  }

  audit(entry) {
    this.logger.info(`[audit] ${JSON.stringify({ ts: new Date().toISOString(), ...entry })}`)
  }

  statusView() {
    return {
      connected: this.status.connected,
      detail: this.status.detail,
      lastEventAt: this.status.lastEventAt,
      bindings: this.bindings.list().length,
    }
  }

  /**
   * Answer "was this session started from WeChat?"
   *
   * The sidebar row mark needs this per Session id. A binding records one
   * session per workspace, so the lookup is the union of every chat's session
   * map — cheap, and it never has to activate a Session.
   * @param {string[]} sessionIds - ids to test.
   * @returns {string[]} the subset that this channel owns.
   */
  wechatSessions(sessionIds) {
    const owned = new Set()
    for (const binding of this.bindings.list()) {
      for (const id of Object.values(binding.sessions ?? {})) {
        if (id) owned.add(id)
      }
    }
    const asked = Array.isArray(sessionIds) ? sessionIds : []
    return [...new Set(asked.map(String).filter((id) => owned.has(id)))]
  }

  /** Push a message to one chat, or to every bound chat with `all`. */
  async push(to, text) {
    if (!text) return { sent: 0, failed: 0 }
    const targets = to === 'all' ? this.bindings.list().map((binding) => binding.chatId) : [to]
    let sent = 0
    let failed = 0
    for (const chatId of targets) {
      if (await this.sendText(chatId, text)) sent += 1
      else failed += 1
    }
    return { sent, failed }
  }
}

// ── plugin entry ───────────────────────────────────────────────────────────

export function apply(ctx, config = {}) {
  // The Loader hands over only the patch's own keys, so the schema has to be
  // applied here before anything reads `config.defaults` and friends.
  const channel = new WeixinChannel(ctx, Config(config ?? {}))

  ctx.effect(() => () => { void channel.dispose() })

  // Service: other plugins can push through `ctx.weixinChannel`.
  ctx.provide('weixinChannel', {
    push: (to, text) => channel.push(to, text),
    sendAll: (text) => channel.push('all', text),
    status: () => channel.statusView(),
    bindings: () => channel.bindings.list().map(publicBinding),
    // Which listed Sessions came from WeChat — the sidebar row mark reads this.
    sessions: (ids) => channel.wechatSessions(ids),
  })

  // Tools: a direct push, usable from schedules and goals.
  const toolsService = ctx.get('tools')
  if (toolsService?.register) {
    ctx.effect(() => toolsService.register({
      name: 'weixin_send',
      description: '发送一条文本消息或一个本地文件到微信。to 为微信用户 id；"all" 广播给所有已绑定聊天；省略 = 触发本工具的会话所属聊天。给 file 时 text 作为文件说明。',
      parameters: {
        type: 'object',
        properties: {
          to: { type: 'string', description: '微信用户 id，或 "all"' },
          text: { type: 'string', description: '要发送的文本；与 file 同用时作为文件说明' },
          file: { type: 'string', description: '要发送的本地文件绝对路径（图片/视频/其他文件）' },
        },
        required: [],
      },
      output: {
        schema: {
          type: 'object',
          properties: { sent: { type: 'number' }, failed: { type: 'number' } },
          required: ['sent', 'failed'],
        },
        render: (_args, value) => [{
          type: 'text',
          text: `微信推送：成功 ${value?.sent ?? 0}，失败 ${value?.failed ?? 0}`,
        }],
      },
      async execute(args, exec) {
        const explicit = args.to && String(args.to).trim()
        let target = explicit || 'all'
        if (!explicit && exec?.agent?.id) {
          const owner = channel.bindings.bySessionId(exec.agent.id)
          if (owner) target = owner.chatId
        }
        const body = String(args.text ?? '')
        const file = args.file && String(args.file).trim()
        if (!file) {
          if (!body) throw new TypeError('text 和 file 至少需要一个。')
          return channel.push(target, body)
        }
        // A file goes to one chat, not a broadcast: a "all" send would upload
        // the same bytes once per chat and each upload is a separate CDN call.
        const targets = target === 'all' ? channel.bindings.list().map((binding) => binding.chatId) : [target]
        let sent = 0
        let failed = 0
        for (const chatId of targets) {
          if (await channel.sendMedia(chatId, file, body)) sent += 1
          else failed += 1
        }
        return { sent, failed }
      },
    }), 'weixin-channel.tool')
  }

  // The panel talks to the Host over one loopback JSON route. It does NOT use
  // `connection.rpc.handle`: in this DSH version that method registers its route
  // through the connection plugin's OWN context (`get rpc() { const owner =
  // this.ctx }`), so a third-party plugin cannot satisfy its `webServer` need
  // from any consumer scope and the channel silently never appears.
  ctx.inject(['webServer'], (scope) => {
    scope.effect(() => installRoutes(scope, {
      handle: (action, payload) => channel.panelAction(action, payload),
    }), 'weixin-channel.route')
  })

  void channel.start()
  return channel
}

export default apply
export { WeixinChannel as Channel }
