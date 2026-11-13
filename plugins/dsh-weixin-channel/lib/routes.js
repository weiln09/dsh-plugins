// HTTP and RPC surface for the settings panel.
//
// Two transports, both loopback-only:
//   - a `prefix` route for plain JSON reads/writes (`/weixin-channel/api`)
//   - the connection RPC channel for the QR-bind state machine
//
// Neither returns a token: every response passes through `redact()`, which is a
// whitelist of the fields a browser is allowed to see.

/** Browser-visible view of one binding. */
export function publicBinding(binding) {
  return {
    chatId: binding.chatId,
    chatType: binding.chatType,
    activeWorkspace: binding.activeWorkspace,
    sessionId: binding.sessions?.[binding.activeWorkspace] ?? '',
    sessionCount: Object.keys(binding.sessions ?? {}).length,
    model: binding.model ? `${binding.model.provider}/${binding.model.model}` : '',
    permissionPreset: binding.permissionPreset,
    planMode: Boolean(binding.planMode),
    replyGranularity: binding.replyGranularity,
    muted: Boolean(binding.muted),
    createdAt: binding.createdAt ?? 0,
    lastActivityAt: binding.lastActivityAt ?? 0,
  }
}

/** Whitelist the QR-bind state a browser may see. */
export function redactBind(state) {
  const base = { phase: state?.phase ?? 'idle' }
  if (typeof state?.qrDataUrl === 'string' && state.qrDataUrl) base.qrDataUrl = state.qrDataUrl
  if (typeof state?.qrUrl === 'string' && state.qrUrl) base.qrUrl = state.qrUrl
  if (typeof state?.message === 'string') base.message = state.message
  if (typeof state?.accountId === 'string') base.accountId = state.accountId
  if (typeof state?.botId === 'string') base.botId = state.botId
  return base
}

/**
 * Actions that only read state, and are therefore safe to answer for a GET.
 *
 * Everything else CHANGES something — trusting a user, unbinding a chat,
 * rewriting a default, starting a QR login. Answering those from a query string
 * meant any local process, or any web page able to load a URL (an `img` tag is
 * enough), could drive the channel with no credentials at all.
 */
const READ_ONLY_ACTIONS = new Set(['status', 'sessions.wechat'])

/**
 * Whether a request came from the page this server serves.
 *
 * The DSH UI is same-origin, so a browser always sends `Origin` on a
 * cross-origin request and the two hosts differ when it does. A request with no
 * `Origin` is a non-browser client (curl, a test) and cannot be a
 * drive-by from another page, so it is allowed to continue.
 */
function sameOrigin(req) {
  const origin = req.headers?.origin
  if (!origin) return true
  const host = req.headers?.host
  if (!host) return false
  try {
    return new URL(origin).host === host
  } catch {
    return false
  }
}

/**
 * Whether a POST declares a JSON body.
 *
 * This is the load-bearing half of the CSRF guard: a cross-origin `<form>` can
 * only send urlencoded, multipart, or text/plain, so demanding
 * `application/json` forces a CORS preflight — which this server never answers.
 */
function isJsonRequest(req) {
  return String(req.headers?.['content-type'] ?? '').toLowerCase().startsWith('application/json')
}

function json(res, status, value) {
  res.statusCode = status
  res.setHeader('content-type', 'application/json; charset=utf-8')
  res.setHeader('cache-control', 'no-store')
  res.end(JSON.stringify(value))
}

async function readBody(req, limit = 1024 * 1024) {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > limit) throw new Error('请求体过大')
    chunks.push(chunk)
  }
  if (!chunks.length) return {}
  return JSON.parse(Buffer.concat(chunks).toString('utf8'))
}

/**
 * Register the panel's JSON route.
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {{ handle: (action: string, payload: object) => Promise<any> }} api
 * @returns {() => void}
 */
export function installRoutes(ctx, api) {
  if (!ctx.webServer?.register) return () => {}
  return ctx.webServer.register({
    kind: 'prefix',
    path: '/weixin-channel/api',
    handler: async (req, res) => {
      try {
        if (!sameOrigin(req)) {
          return json(res, 403, { ok: false, error: '跨站请求被拒绝' })
        }
        const url = new URL(req.url, 'http://localhost')
        let payload = {}
        if (req.method === 'POST') {
          if (!isJsonRequest(req)) {
            return json(res, 415, { ok: false, error: '请使用 application/json 提交' })
          }
          payload = await readBody(req)
        } else if (req.method === 'GET' || req.method === 'HEAD') {
          payload = Object.fromEntries(url.searchParams.entries())
        } else {
          return json(res, 405, { ok: false, error: '只支持 GET 和 POST' })
        }
        const action = payload.action
        if (!action) return json(res, 400, { ok: false, error: '缺少 action' })
        // A GET must stay a read. State-changing actions are POST-only, so a
        // stray link, a prefetcher, or a cross-site image tag cannot act.
        if (req.method !== 'POST' && !READ_ONLY_ACTIONS.has(String(action))) {
          return json(res, 405, { ok: false, error: `${action} 需要 POST` })
        }
        const value = await api.handle(action, payload)
        return json(res, 200, { ok: true, value })
      } catch (error) {
        return json(res, 400, { ok: false, error: String(error?.message ?? error) })
      }
    },
  })
}
