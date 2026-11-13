// @weiln09/dsh-weixin-channel — Client half (browser).
//
// Its own page in the Settings nav rail (`settings.section`). It binds a WeChat
// bot account by QR, manages who may drive the agent, sets deployment defaults,
// and lists the per-chat bindings this channel keeps (each with its own
// workspace and model).
//
// Everything the page shows comes from the Host half over one loopback-only
// JSON route (`/weixin-channel/api`). The page never receives a bot token.
//
// It deliberately does not use `connection.rpc`: that registry registers its
// route through the connection plugin's own context, so a third-party plugin
// cannot satisfy its `webServer` dependency and the channel never appears.

window.__ModuleLoader__.load({
  id: '@weiln09/dsh-weixin-channel',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const { useCallback, useEffect, useMemo, useState } = React

    const API = '/weixin-channel/api'
    const SECTION_ID = 'weixin-channel'
    /** Nav position: right below "Agent presets" (20), above "桌宠配置" (30). */
    const SECTION_ORDER = 25

    // ---------------------------------------------------------------------
    // Copy. One dictionary per language; an unknown locale falls back to
    // Chinese because the WeChat side of this plugin is Chinese-first.
    // ---------------------------------------------------------------------
    const COPY = {
      zh: {
        title: '微信 Bot 通道',
        subtitle: '每个聊天独立工作区与模型，命令在微信里完成',
        connected: '已连接',
        disconnected: '未连接',
        reconnect: '重新连接',
        reconnected: '正在重新连接…',
        scanTitle: '扫码绑定',
        scanHint: '手机微信先开通「机器人」入口（我 → 设置 → 插件），再扫码。',
        scan: '生成二维码',
        rescan: '重新生成',
        cancel: '取消',
        waiting: '等待二维码…',
        scanned: '已扫码，请在手机上确认',
        needCode: '请输入手机显示的配对数字',
        codePlaceholder: '配对数字',
        submitCode: '提交',
        bindSucceeded: '绑定成功。重启 DSH 后生效。',
        bindFailed: '绑定失败',
        authTitle: '授权',
        allowlist: '允许的微信用户',
        addUser: '添加用户 id',
        remove: '移除',
        pendingTitle: '待信任',
        pendingEmpty: '没有待信任的用户。',
        trust: '信任',
        defaultsTitle: '默认值',
        defaultWorkspace: '默认工作区',
        defaultModel: '默认模型',
        defaultPreset: '默认权限模式',
        defaultAgentPreset: '默认 Agent 预设',
        presetHint: '决定会话能用哪些工具（文件、终端、技能）；留空跟随部署默认。',
        save: '保存',
        saved: '已保存',
        chatsTitle: '聊天绑定',
        repairWorkspaces: '挂回工作区',
        repairedWorkspaces: '已把会话挂回工作区',
        chatsEmpty: '还没有聊天绑定。在微信里发一条消息即可创建。',
        colChat: '聊天',
        colWorkspace: '工作区',
        colModel: '模型',
        colSession: '会话',
        colActive: '最后活跃',
        colState: '状态',
        unbind: '解绑',
        mute: '静音',
        unmute: '恢复通知',
        mutedTag: '已静音',
        planTag: '计划模式',
        sessionsTag: '会话',
        replyTag: '回复',
        diagTitle: '诊断',
        diagRun: '网络诊断',
        diagRunning: '诊断中…',
        diagOk: '连接正常',
        diagFail: '连接失败',
        lastError: '最近错误',
        none: '无',
        loading: '读取中…',
        errorTitle: '读取失败',
        retry: '重试',
      },
      en: {
        title: 'Weixin bot channel',
        subtitle: 'Per-chat workspace and model, driven entirely from WeChat',
        connected: 'Connected',
        disconnected: 'Disconnected',
        reconnect: 'Reconnect',
        reconnected: 'Reconnecting…',
        scanTitle: 'Bind by QR',
        scanHint: 'Enable the bot entry in WeChat (Me → Settings → Plugins) before scanning.',
        scan: 'Show QR code',
        rescan: 'New QR code',
        cancel: 'Cancel',
        waiting: 'Requesting a QR code…',
        scanned: 'Scanned — confirm on your phone',
        needCode: 'Enter the pairing digits shown on your phone',
        codePlaceholder: 'Pairing digits',
        submitCode: 'Submit',
        bindSucceeded: 'Bound. Restart DSH to apply.',
        bindFailed: 'Binding failed',
        authTitle: 'Authorization',
        allowlist: 'Allowed WeChat users',
        addUser: 'Add a user id',
        remove: 'Remove',
        pendingTitle: 'Pending trust',
        pendingEmpty: 'Nobody is waiting for trust.',
        trust: 'Trust',
        defaultsTitle: 'Defaults',
        defaultWorkspace: 'Default workspace',
        defaultModel: 'Default model',
        defaultPreset: 'Default permission mode',
        defaultAgentPreset: 'Default agent preset',
        presetHint: 'Decides which tools a session gets (files, shell, skills). Empty follows the deployment default.',
        save: 'Save',
        saved: 'Saved',
        chatsTitle: 'Chat bindings',
        repairWorkspaces: 'Attach to workspaces',
        repairedWorkspaces: 'Sessions attached to their workspaces',
        chatsEmpty: 'No chat is bound yet. Send a message in WeChat to create one.',
        colChat: 'Chat',
        colWorkspace: 'Workspace',
        colModel: 'Model',
        colSession: 'Session',
        colActive: 'Last active',
        colState: 'State',
        unbind: 'Unbind',
        mute: 'Mute',
        unmute: 'Unmute',
        mutedTag: 'Muted',
        planTag: 'Plan mode',
        sessionsTag: 'Sessions',
        replyTag: 'Replies',
        diagTitle: 'Diagnostics',
        diagRun: 'Network check',
        diagRunning: 'Checking…',
        diagOk: 'Connection OK',
        diagFail: 'Connection failed',
        lastError: 'Last error',
        none: 'None',
        loading: 'Loading…',
        errorTitle: 'Could not read the channel',
        retry: 'Try again',
      },
    }

    function pickLang(localeId) {
      return String(localeId ?? '').toLowerCase().startsWith('zh') ? 'zh' : 'en'
    }

    function pickCopy(localeId) {
      return COPY[pickLang(localeId)]
    }

    /**
     * The Settings nav-rail label, deliberately shorter than the panel title:
     * the rail truncates long labels ("远程工作区（ds…"), and the panel repeats
     * the full name in its first card heading.
     */
    const NAV_LABEL = { zh: '微信通道', en: 'Weixin' }

    // ---------------------------------------------------------------------
    // Styles. Every colour is a theme token so light and dark both work.
    // ---------------------------------------------------------------------
    const S = {
      wrap: { display: 'flex', flexDirection: 'column', gap: 14, padding: '4px 2px', maxWidth: 860 },
      card: {
        background: 'var(--dsw-alias-bg-layer-1, #fff)',
        border: '1px solid var(--dsw-alias-border-l2, #e5e7eb)',
        borderRadius: 12,
        padding: '14px 16px',
      },
      head: { display: 'flex', alignItems: 'center', gap: 10, marginBottom: 10, flexWrap: 'wrap' },
      title: { fontSize: 15, fontWeight: 700, color: 'var(--dsw-alias-label-primary, #111827)' },
      muted: { fontSize: 12, color: 'var(--dsw-alias-label-tertiary, #8b93a1)' },
      row: { display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', marginTop: 8 },
      pill: { padding: '2px 10px', borderRadius: 99, fontSize: 12, fontWeight: 600 },
      button: {
        font: 'inherit', cursor: 'pointer', borderRadius: 8, padding: '5px 12px', fontSize: 13,
        border: '1px solid var(--dsw-alias-border-l2, #e5e7eb)',
        background: 'var(--dsw-alias-bg-layer-1, #fff)',
        color: 'var(--dsw-alias-label-primary, #111827)',
      },
      primary: {
        font: 'inherit', cursor: 'pointer', borderRadius: 8, padding: '5px 12px', fontSize: 13,
        border: 'none',
        background: 'var(--dsw-alias-button-primary-fill, var(--dsw-alias-brand-primary, #4f6ef7))',
        color: 'var(--dsw-alias-label-primary-inverted, #fff)',
      },
      danger: {
        font: 'inherit', cursor: 'pointer', borderRadius: 8, padding: '4px 10px', fontSize: 12,
        border: '1px solid var(--dsw-alias-state-error-primary, #dc2626)',
        background: 'transparent', color: 'var(--dsw-alias-state-error-primary, #dc2626)',
      },
      input: {
        font: 'inherit', fontSize: 13, padding: '5px 9px', borderRadius: 8,
        border: '1px solid var(--dsw-alias-border-l2, #e5e7eb)',
        background: 'var(--dsw-alias-bg-layer-1, #fff)',
        color: 'var(--dsw-alias-label-primary, #111827)',
        minWidth: 220,
      },
      qr: {
        width: 240, height: 240, borderRadius: 8, marginTop: 10,
        border: '1px solid var(--dsw-alias-border-l2, #e5e7eb)',
        background: '#fff',
      },
      table: { width: '100%', borderCollapse: 'collapse', fontSize: 12.5 },
      th: {
        textAlign: 'left', padding: '6px 8px', fontWeight: 600,
        color: 'var(--dsw-alias-label-secondary, #6b7280)',
        borderBottom: '1px solid var(--dsw-alias-border-l2, #e5e7eb)',
      },
      td: {
        padding: '7px 8px',
        borderBottom: '1px solid var(--dsw-alias-border-l2, #e5e7eb)',
        color: 'var(--dsw-alias-label-primary, #111827)',
        verticalAlign: 'top',
      },
      code: {
        fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
        fontSize: 11.5, color: 'var(--dsw-alias-label-secondary, #6b7280)',
      },
      err: { color: 'var(--dsw-alias-state-error-primary, #dc2626)', fontSize: 12.5 },
      ok: { color: 'var(--dsw-alias-state-success-primary, #16a34a)', fontSize: 12.5, fontWeight: 600 },
      tag: {
        display: 'inline-block', padding: '1px 7px', borderRadius: 6, fontSize: 11,
        background: 'var(--dsw-alias-bg-layer-2, #f3f4f6)',
        color: 'var(--dsw-alias-label-secondary, #6b7280)',
      },
    }

    function Card({ children }) {
      return h('section', { style: S.card }, children)
    }

    function SectionHead({ text, extra }) {
      return h('div', { style: S.head }, h('div', { style: S.title }, text), extra)
    }

    function timeAgo(timestamp) {
      const delta = Date.now() - Number(timestamp || 0)
      if (!Number.isFinite(delta) || delta <= 0) return '—'
      const minutes = Math.floor(delta / 60_000)
      if (minutes < 1) return 'just now'
      if (minutes < 60) return `${minutes}m`
      const hours = Math.floor(minutes / 60)
      if (hours < 24) return `${hours}h`
      return `${Math.floor(hours / 24)}d`
    }

    function mask(value, keep = 6) {
      const text = String(value ?? '')
      if (text.length <= keep * 2) return text
      return `${text.slice(0, keep)}…${text.slice(-4)}`
    }

    // ---------------------------------------------------------------------
    // Panel
    // ---------------------------------------------------------------------

    function WeixinChannelPanel({ locale }) {
      const t = useMemo(() => pickCopy(locale), [locale])
      const [snapshot, setSnapshot] = useState(null)
      const [error, setError] = useState('')
      const [busy, setBusy] = useState(false)
      const [notice, setNotice] = useState('')
      const [verifyCode, setVerifyCode] = useState('')
      const [newUser, setNewUser] = useState('')
      const [draft, setDraft] = useState({ workspace: '', model: '', permissionPreset: '', agentPreset: '' })
      const [diag, setDiag] = useState(null)

      const call = useCallback(async (action, payload) => {
        const response = await fetch(API, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ action, ...(payload ?? {}) }),
        })
        const body = await response.json().catch(() => ({}))
        if (!body?.ok) throw new Error(body?.error ?? 'request failed')
        return body.value
      }, [])
      const load = useCallback(async () => {
        try {
          const value = await call('status')
          setSnapshot(value)
          setError('')
          // Seed the form from the defaults the Host actually has in force.
          // Guessing from the first binding's workspace showed a value that was
          // not the default, so pressing Save silently changed it.
          setDraft((current) => ({
            workspace: current.workspace || value.defaults?.workspace || '',
            model: current.model || value.defaults?.model || value.models?.[0] || '',
            permissionPreset: current.permissionPreset || value.defaults?.permissionPreset || '',
            agentPreset: current.agentPreset || value.defaults?.agentPreset || '',
          }))
        } catch (cause) {
          setError(String(cause?.message ?? cause))
        }
      }, [call])

      useEffect(() => {
        void load()
        const timer = setInterval(() => { void load() }, 5_000)
        return () => clearInterval(timer)
      }, [load])

      const flash = (text) => {
        setNotice(text)
        setTimeout(() => setNotice(''), 4_000)
      }

      const run = async (action, payload, message) => {
        setBusy(true)
        try {
          const value = await call(action, payload)
          if (message) flash(message)
          await load()
          return value
        } catch (cause) {
          flash(String(cause?.message ?? cause))
          return null
        } finally {
          setBusy(false)
        }
      }

      const beginBind = async () => {
        setBusy(true)
        try {
          await call('bind.begin')
          await load()
        } catch (cause) {
          flash(String(cause?.message ?? cause))
        } finally {
          setBusy(false)
        }
      }

      const cancelBind = async () => {
        setBusy(true)
        try {
          await call('bind.cancel')
          await load()
        } catch (cause) {
          flash(String(cause?.message ?? cause))
        } finally {
          setBusy(false)
        }
      }

      const submitVerifyCode = async () => {
        if (!verifyCode.trim()) return
        setBusy(true)
        try {
          await call('bind.verify', { code: verifyCode.trim() })
          setVerifyCode('')
          await load()
        } catch (cause) {
          flash(String(cause?.message ?? cause))
        } finally {
          setBusy(false)
        }
      }

      const addUser = async () => {
        if (!newUser.trim()) return
        await run('trust.add', { userId: newUser.trim() }, t.saved)
        setNewUser('')
      }

      const saveDefaults = async () => {
        await run('defaults.set', {
          workspace: draft.workspace.trim() || undefined,
          model: draft.model || undefined,
          permissionPreset: draft.permissionPreset || undefined,
          // Sent even when empty: clearing the box must mean "follow the
          // deployment default", not "leave the old value in place".
          agentPreset: draft.agentPreset.trim(),
        }, t.saved)
      }

      const runDiag = async () => {
        setBusy(true)
        setDiag({ pending: true })
        try {
          const value = await call('diag.net')
          setDiag(value ?? {})
        } catch (cause) {
          setDiag({ error: String(cause?.message ?? cause) })
        } finally {
          setBusy(false)
        }
      }

      const toggleMute = async (binding) => {
        await run('chats.mute', { chatId: binding.chatId, muted: !binding.muted }, t.saved)
      }

      if (!snapshot) {
        return h('div', { style: S.wrap },
          h(Card, null,
            h(SectionHead, { text: t.title }),
            error
              ? h('div', null,
                h('div', { style: S.err }, `${t.errorTitle}：${error}`),
                h('div', { style: S.row }, h('button', { style: S.button, onClick: () => { void load() } }, t.retry)))
              : h('div', { style: S.muted }, t.loading)))
      }

      const bind = snapshot.bind ?? { phase: 'idle' }
      const connected = snapshot.connected === true
      const bindActive = ['starting', 'qr', 'scanned', 'need_verifycode'].includes(bind.phase)

      return h('div', { style: S.wrap },

        // ── connection ───────────────────────────────────────────────────
        h(Card, null,
          h(SectionHead, {
            text: t.title,
            extra: h('span', {
              style: {
                ...S.pill,
                color: connected ? 'var(--dsw-alias-state-success-primary, #16a34a)' : 'var(--dsw-alias-label-secondary, #6b7280)',
                background: 'var(--dsw-alias-bg-layer-2, #f3f4f6)',
              },
            }, connected ? t.connected : t.disconnected),
          }),
          h('div', { style: S.muted }, t.subtitle),
          h('div', { style: { ...S.muted, marginTop: 6 } },
            `${snapshot.detail ?? ''}${snapshot.accountId ? ` · ${snapshot.accountId}` : ''}`),
          connected
            ? null
            : h('div', { style: S.row },
              h('button', {
                style: S.button, disabled: busy,
                onClick: () => { void run('connection.reconnect', {}, t.reconnected) },
              }, t.reconnect)),
          notice ? h('div', { style: { ...S.ok, marginTop: 8 } }, notice) : null,

          h('div', { style: { ...S.row, marginTop: 12 } },
            h('div', { style: S.title }, t.scanTitle),
            h('button', {
              style: S.primary, disabled: busy || bindActive,
              onClick: () => { void beginBind() },
            }, bindActive ? t.waiting : (bind.phase === 'idle' ? t.scan : t.rescan)),
            bindActive
              ? h('button', { style: S.button, disabled: busy, onClick: () => { void cancelBind() } }, t.cancel)
              : null),

          h('div', { style: { ...S.muted, marginTop: 4 } }, t.scanHint),

          bind.phase === 'qr' || bind.phase === 'scanned' || bind.phase === 'need_verifycode'
            ? h('div', null,
              bind.qrDataUrl
                ? h('img', { src: bind.qrDataUrl, alt: 'QR', style: S.qr })
                : bind.qrUrl
                  ? h('div', { style: { ...S.muted, marginTop: 8 } },
                    h('a', { href: bind.qrUrl, target: '_blank', rel: 'noreferrer', style: S.code }, bind.qrUrl))
                  : h('div', { style: { ...S.muted, marginTop: 8 } }, t.waiting),
              h('div', { style: { ...S.muted, marginTop: 6 } },
                bind.phase === 'scanned' ? t.scanned
                  : bind.phase === 'need_verifycode' ? t.needCode
                    : (bind.message ?? t.waiting)),
              bind.phase === 'need_verifycode'
                ? h('div', { style: S.row },
                  h('input', {
                    style: S.input, value: verifyCode, placeholder: t.codePlaceholder,
                    onChange: (event) => setVerifyCode(event.target.value),
                  }),
                  h('button', { style: S.primary, disabled: busy, onClick: () => { void submitVerifyCode() } }, t.submitCode))
                : null)
            : null,

          bind.phase === 'succeeded'
            ? h('div', { style: { ...S.ok, marginTop: 8 } }, t.bindSucceeded)
            : bind.phase === 'error' || bind.phase === 'expired'
              ? h('div', { style: { ...S.err, marginTop: 8 } }, `${t.bindFailed}：${bind.message ?? ''}`)
              : null),

        // ── authorization ────────────────────────────────────────────────
        h(Card, null,
          h(SectionHead, { text: t.authTitle }),
          h('div', { style: S.muted }, t.allowlist),
          h('div', { style: { ...S.row, marginTop: 6 } },
            h('input', {
              style: S.input, value: newUser, placeholder: 'o9cq80…@im.wechat',
              onChange: (event) => setNewUser(event.target.value),
            }),
            h('button', { style: S.primary, disabled: busy, onClick: () => { void addUser() } }, t.addUser)),
          (snapshot.allowlist ?? []).length
            ? h('div', { style: { marginTop: 10, display: 'flex', flexDirection: 'column', gap: 6 } },
              (snapshot.allowlist ?? []).map((userId) => h('div', {
                key: userId, style: { ...S.row, marginTop: 0, justifyContent: 'space-between' },
              },
              h('span', { style: S.code }, mask(userId)),
              h('button', {
                style: S.danger, disabled: busy,
                onClick: () => { void run('trust.revoke', { userId }, t.saved) },
              }, t.remove))))
            : null,

          h('div', { style: { ...S.muted, marginTop: 14 } }, t.pendingTitle),
          (snapshot.pendingTrust ?? []).length
            ? h('div', { style: { marginTop: 6, display: 'flex', flexDirection: 'column', gap: 6 } },
              (snapshot.pendingTrust ?? []).map((entry) => h('div', {
                key: entry.userId, style: { ...S.row, marginTop: 0, justifyContent: 'space-between' },
              },
              h('span', null,
                h('span', { style: S.code }, mask(entry.userId)),
                entry.name ? h('span', { style: { ...S.muted, marginLeft: 8 } }, entry.name) : null),
              h('button', {
                style: S.primary, disabled: busy,
                onClick: () => { void run('trust.add', { userId: entry.userId }, t.saved) },
              }, t.trust))))
            : h('div', { style: { ...S.muted, marginTop: 4 } }, t.pendingEmpty)),

        // ── defaults ─────────────────────────────────────────────────────
        h(Card, null,
          h(SectionHead, { text: t.defaultsTitle }),
          h('div', { style: S.row },
            h('span', { style: { ...S.muted, minWidth: 110 } }, t.defaultWorkspace),
            h('input', {
              style: S.input, value: draft.workspace,
              onChange: (event) => setDraft({ ...draft, workspace: event.target.value }),
            })),
          h('div', { style: S.row },
            h('span', { style: { ...S.muted, minWidth: 110 } }, t.defaultModel),
            h('select', {
              style: S.input, value: draft.model,
              onChange: (event) => setDraft({ ...draft, model: event.target.value }),
            },
            h('option', { value: '' }, '—'),
            (snapshot.models ?? []).map((id) => h('option', { key: id, value: id }, id)))),
          h('div', { style: S.row },
            h('span', { style: { ...S.muted, minWidth: 110 } }, t.defaultPreset),
            h('input', {
              style: S.input, value: draft.permissionPreset,
              onChange: (event) => setDraft({ ...draft, permissionPreset: event.target.value }),
            })),
          h('div', { style: S.row },
            h('span', { style: { ...S.muted, minWidth: 110 } }, t.defaultAgentPreset),
            // A picker when the deployment declares presets, free text when it
            // does not — an unknown id has to stay enterable either way.
            (snapshot.presets ?? []).length
              ? h('select', {
                style: S.input, value: draft.agentPreset,
                onChange: (event) => setDraft({ ...draft, agentPreset: event.target.value }),
              },
              h('option', { value: '' }, '—'),
              (snapshot.presets ?? []).map((preset) => h('option', {
                key: preset.id, value: preset.id,
              }, `${preset.id}${preset.name && preset.name !== preset.id ? ` · ${preset.name}` : ''}${preset.broken ? ' · ⚠️' : ''}`)))
              : h('input', {
                style: S.input, value: draft.agentPreset,
                placeholder: 'preset-id',
                onChange: (event) => setDraft({ ...draft, agentPreset: event.target.value }),
              })),
          h('div', { style: { ...S.muted, marginTop: 2, fontSize: 12 } }, t.presetHint),
          h('div', { style: S.row },
            h('button', { style: S.primary, disabled: busy, onClick: () => { void saveDefaults() } }, t.save))),

        // ── chat bindings ────────────────────────────────────────────────
        h(Card, null,
          h(SectionHead, {
            text: t.chatsTitle,
            // The sidebar groups by Workspace registry membership; a chat
            // created before the attach fix otherwise stays in 未分组.
            extra: h('button', {
              style: S.button, disabled: busy,
              onClick: () => { void run('workspace.repair', {}, t.repairedWorkspaces) },
            }, t.repairWorkspaces),
          }),
          (snapshot.bindings ?? []).length
            ? h('table', { style: S.table },
              h('thead', null, h('tr', null,
                h('th', { style: S.th }, t.colChat),
                h('th', { style: S.th }, t.colWorkspace),
                h('th', { style: S.th }, t.colModel),
                h('th', { style: S.th }, t.colSession),
                h('th', { style: S.th }, t.colState),
                h('th', { style: S.th }, t.colActive),
                h('th', { style: S.th }, ''))),
              h('tbody', null, (snapshot.bindings ?? []).map((binding) => h('tr', { key: binding.chatId },
                h('td', { style: S.td }, h('span', { style: S.code }, mask(binding.chatId))),
                h('td', { style: S.td }, binding.activeWorkspace || '—'),
                h('td', { style: S.td }, binding.model || '—'),
                h('td', { style: S.td }, h('span', { style: S.code }, binding.sessionId || '—')),
                // What the chat is currently doing, which the panel used to
                // hide: a muted chat or one in plan mode looked identical to a
                // normal one, and neither could be changed from here.
                h('td', { style: S.td }, h('div', { style: { display: 'flex', gap: 4, flexWrap: 'wrap' } },
                  binding.muted ? h('span', { style: S.tag }, t.mutedTag) : null,
                  binding.planMode ? h('span', { style: S.tag }, t.planTag) : null,
                  h('span', { style: S.tag }, `${t.sessionsTag} ${binding.sessionCount ?? 0}`),
                  h('span', { style: S.tag }, `${t.replyTag} ${binding.replyGranularity || '—'}`))),
                h('td', { style: S.td }, timeAgo(binding.lastActivityAt)),
                h('td', { style: S.td }, h('div', { style: { display: 'flex', gap: 6 } },
                  h('button', {
                    style: S.button, disabled: busy,
                    onClick: () => { void toggleMute(binding) },
                  }, binding.muted ? t.unmute : t.mute),
                  h('button', {
                    style: S.danger, disabled: busy,
                    onClick: () => { void run('chats.unbind', { chatId: binding.chatId }, t.saved) },
                  }, t.unbind)))))))
            : h('div', { style: S.muted }, t.chatsEmpty)),

        // ── diagnostics ──────────────────────────────────────────────────
        h(Card, null,
          h(SectionHead, {
            text: t.diagTitle,
            // The Host has always had a live network probe (`diag.net`); it was
            // unreachable from the panel, so "连接失败" could only be diagnosed
            // from inside WeChat with /诊断.
            extra: h('button', {
              style: S.button, disabled: busy,
              onClick: () => { void runDiag() },
            }, diag?.pending ? t.diagRunning : t.diagRun),
          }),
          h('div', { style: { ...S.muted, marginTop: 4 } },
            `${t.lastError}：${snapshot.lastError || t.none}`),
          h('div', { style: { ...S.muted, marginTop: 4 } },
            `workspaces ${(snapshot.workspaces ?? []).length} · models ${(snapshot.models ?? []).length}`),
          diag && !diag.pending ? h('div', { style: { marginTop: 10, display: 'flex', flexDirection: 'column', gap: 4 } },
            diag.error
              ? h('div', { style: S.err }, t.diagFail + '：' + diag.error)
              : h('div', { style: diag.notifyStart?.ok ? S.ok : S.err },
                (diag.notifyStart?.ok ? t.diagOk : t.diagFail)
                + (diag.notifyStart?.ms !== undefined ? ' · ' + diag.notifyStart.ms + 'ms' : '')),
            diag.baseUrl ? h('div', { style: S.code }, diag.baseUrl) : null,
            diag.fetchSource ? h('div', { style: S.muted }, 'fetch: ' + diag.fetchSource) : null,
            diag.envProxy ? h('div', { style: S.muted }, 'proxy: ' + diag.envProxy) : null,
            diag.notifyStart?.message ? h('div', { style: S.muted }, String(diag.notifyStart.message)) : null,
            diag.notifyStart?.code ? h('div', { style: S.muted }, 'code: ' + diag.notifyStart.code) : null)
            : null),
      )
    }

    // ---------------------------------------------------------------------
    // Registration
    // ---------------------------------------------------------------------

    const name = 'dsh-weixin-channel'
    // `slots` declares both seats; `locale` drives the settings tab copy.
    const inject = ['slots', 'locale']

    /**
     * The row mark: a WeChat glyph in the Session row's leading seat.
     *
     * The seat only renders while the row's primary status is idle, which is
     * exactly when the glyph is needed (a running row already shows its own
     * dot). Labels are not available here — a row seat receives only a
     * `sessionId` — so the mark carries an aria-label and a tooltip instead.
     */
    function WechatRowMark({ sessionId, isWechat }) {
      if (!isWechat) return null
      return h('span', {
        'data-weixin-row-mark': sessionId,
        title: '微信会话 / WeChat session',
        'aria-label': '微信会话 / WeChat session',
        role: 'img',
        style: {
          display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
          // Match the seat's own box (16×20) so the glyph does not stretch the
          // row; WeChat green is the one colour that reads as "this is WeChat".
          width: 16, height: 20, flex: 'none', lineHeight: 0,
          color: 'var(--dsw-alias-state-success-primary, #07c160)',
        },
      },
      h('svg', {
        width: 14, height: 14, viewBox: '0 0 24 24', fill: 'currentColor', 'aria-hidden': 'true',
      }, h('path', {
        d: 'M9.2 3C5.2 3 2 5.7 2 9c0 1.9 1.1 3.6 2.8 4.7l-.7 2.1 2.4-1.2c.8.2 1.6.3 2.5.3h.4a5.6 5.6 0 0 1-.2-1.5c0-3.2 3-5.8 6.8-5.8h.5C15.9 4.9 12.9 3 9.2 3Zm-2.6 3.4a.9.9 0 1 1 0 1.8.9.9 0 0 1 0-1.8Zm5.2 0a.9.9 0 1 1 0 1.8.9.9 0 0 1 0-1.8Z',
      }), h('path', {
        d: 'M22 13.4c0-2.8-2.7-5-6.1-5s-6.1 2.2-6.1 5 2.7 5 6.1 5c.7 0 1.4-.1 2-.3l2 1-.6-1.7c1.7-.9 2.7-2.4 2.7-4Zm-8.1-1.2a.8.8 0 1 1 0-1.6.8.8 0 0 1 0 1.6Zm4 0a.8.8 0 1 1 0-1.6.8.8 0 0 1 0 1.6Z',
      })))
    }

    /**
     * Which of the listed Sessions this channel owns.
     *
     * The seat is per-row but the answer is not, so every row asks into one
     * shared cache. Two things are load-bearing:
     *   - answers are MERGED, never replaced. Each row mounts separately and
     *     asks for its own id; replacing the set made the last row to mount
     *     erase every mark the earlier rows had just established.
     *   - asks are batched into one request per frame burst. A sidebar with
     *     forty WeChat-visible rows used to issue forty loopback requests on
     *     every mount.
     */
    const WECHAT_MARK_STATE = { ids: new Set(), listeners: new Set(), queued: new Set(), timer: null }

    function publishMarks() {
      for (const listener of WECHAT_MARK_STATE.listeners) {
        try { listener() } catch { /* a dead row must not stop the others */ }
      }
    }

    async function flushWechatMarks() {
      WECHAT_MARK_STATE.timer = null
      const wanted = [...WECHAT_MARK_STATE.queued]
      WECHAT_MARK_STATE.queued.clear()
      if (!wanted.length) return
      try {
        const response = await fetch(API + '?action=sessions.wechat&sessionIds=' + encodeURIComponent(wanted.join(',')))
        if (!response.ok) return
        const body = await response.json()
        const ids = body?.value?.sessionIds
        if (!Array.isArray(ids)) return
        const owned = new Set(ids.map(String))
        for (const id of wanted) {
          if (owned.has(String(id))) WECHAT_MARK_STATE.ids.add(id)
          else WECHAT_MARK_STATE.ids.delete(id)
        }
        publishMarks()
      } catch {
        // The mark is decoration: a failed lookup simply shows no glyph.
      }
    }

    /** Ask once for a set of ids; rows mounting together share one request. */
    function refreshWechatMarks(sessionIds) {
      for (const id of sessionIds) {
        if (typeof id === 'string' && id) WECHAT_MARK_STATE.queued.add(id)
      }
      if (!WECHAT_MARK_STATE.queued.size || WECHAT_MARK_STATE.timer) return
      WECHAT_MARK_STATE.timer = setTimeout(() => { void flushWechatMarks() }, 16)
    }

    function useWechatMark(sessionId) {
      const [owned, setOwned] = useState(() => WECHAT_MARK_STATE.ids.has(sessionId))
      useEffect(() => {
        const sync = () => setOwned(WECHAT_MARK_STATE.ids.has(sessionId))
        WECHAT_MARK_STATE.listeners.add(sync)
        sync()
        refreshWechatMarks([sessionId])
        return () => { WECHAT_MARK_STATE.listeners.delete(sync) }
      }, [sessionId])
      return owned
    }

    /** One row seat: show the mark only for a Session this channel created. */
    function WechatRowSeat({ sessionId }) {
      const owned = useWechatMark(sessionId)
      return h(WechatRowMark, { sessionId, isWechat: owned })
    }

    function apply(ctx) {
      function useLocaleId() {
        const [id, setId] = useState(() => ctx.locale?.getSnapshot?.()?.active ?? 'zh')
        useEffect(() => {
          const service = ctx.locale
          if (typeof service?.subscribe === 'function') {
            return service.subscribe(() => setId(service.getSnapshot?.()?.active ?? 'zh'))
          }
          return ctx.on ? ctx.on('locale/change', () => setId(ctx.locale?.getSnapshot?.()?.active ?? 'zh')) : undefined
        }, [])
        return id
      }

      function LocalizedPanel() {
        const locale = useLocaleId()
        return h(WeixinChannelPanel, { locale })
      }

      // Settings nav entry. A third-party plugin must use `settings.section`:
      // `settings.plugins.tab` renders inside the built-in Plugins section, whose
      // owner (ui-settings-plugins) is not mounted in every build, and the older
      // `plugins.item` grouping is only for built-in plugin configuration.
      // The nav label is a thunk the shell re-resolves on a locale change, so the
      // entry follows the language without re-registering.
      ctx.slots.inject('settings.section', () => ctx.slots.register(
        {
          name: 'settings.section',
          id: SECTION_ID,
          order: SECTION_ORDER,
          label: () => NAV_LABEL[pickLang(ctx.locale?.getSnapshot?.()?.active)],
        },
        LocalizedPanel,
      ))

      // Sidebar row mark: ui-workspace declares this list seat on every Session
      // row and passes only a sessionId, so the occupant asks the Host's
      // loopback route which ids this channel owns. A WeChat-created session
      // gets a green glyph in the row's leading cell.
      ctx.slots.inject('sidebar.session.row.leading', () => ctx.slots.register(
        {
          name: 'sidebar.session.row.leading',
          id: 'weixin-channel-mark',
          order: 20,
        },
        WechatRowSeat,
      ))
    }

    return { name, inject, apply }
  },
})
