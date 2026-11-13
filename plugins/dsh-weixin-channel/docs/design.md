# 微信 Bot 通道：调研与设计

> 本文是该插件的设计底稿，记录调研结论、关键决策与取舍。实现见
> [`plugins/dsh-weixin-channel`](../)。

## 1. 调研：dsh-im 怎么做的，为什么只能一个工作区一个模型

`dsh-im@1.0.5` 是「核心 + 渠道适配器」两层：

```
微信 iLink 长轮询 → dsh-im-weixin → ctx.im.dispatchInbound(ImMessage)
                                        │
                    命令解析 ───────────┴─────────── 派活
                    /new /status /help /log              chatKey → sessionId
                    /mute /approve /trust /revoke        agent.followup()
                                        │
                    NotifyBus(session/event) → channel.send()
```

根因（读源码得到）：

| 事实 | 位置 |
|---|---|
| 工作区是插件 Config 的单值 `agent.workspace` | `lib/index.js#workspace()` |
| 模型是插件 Config 的单值 `agent.provider/model` | `lib/index.js#agentOptions()` |
| 会话 id 由 chatId 确定性生成 `im-{platform}-{chatId}` | `lib/message.js#sessionIdFor` |
| 命令表 10 条，没有 `/workspace`、`/model` | `lib/commands.js` |

所以「一个工作区一个模型」不是 bug，是**状态放错了层**：部署级 Config 承担了
本应属于聊天绑定的状态，而会话 id 与 chatId 一一对应，天然装不下「一聊天多工作区」。

## 2. 设计决策

| # | 决策 | 理由 |
|---|---|---|
| D1 | 偏好挂在**聊天绑定**上 | 直接解决问题；Config 只做默认值 |
| D2 | **每个（聊天 × 工作区）一份会话** | session header 的 `cwd` 不可变，且工作区侧栏按它分组；换目录只能换会话 |
| D3 | 模型**就地切换**（`agent.model.select`） | 历史不丢，优于 dsh-im 的「只影响新会话」 |
| D4 | **编号菜单 + 短时待选状态**（TTL 120s，`0` 取消） | 微信无按钮 |
| D5 | 进度**节流多条** + 三档粒度 | 微信不能编辑消息，只能少发 |
| D6 | 审批/提问用 **waterfall 拦截，只接管 IM 绑定会话** | 不双弹窗，不影响网页端 |
| D7 | 状态用**自有原子 JSON**（tmp+rename，0600） | 轻量、可排障 |
| D8 | 客户端页签**手写 ModuleLoader，无构建步骤** | 与仓库内 `dsh-skill-manager` 一致 |
| D9 | 凭证 `tokenRef` 或 0600 文件，**绝不落日志** | 沿用 dsh-im-weixin 的约束 |

## 3. 架构

```
手机微信 ── iLink getupdates（长轮询）──▶ ilink.js
                                            │ ImMessage
                                            ▼
                                     bindings.js（去重 → 白名单 → 绑定）
                                            │
                     ┌──────────────────────┴───────────────────┐
                     ▼                                          ▼
              commands.js（/项目 /模型 …）                 session.js（派活）
              + pending 编号状态                    per-(chat, workspace) agent
                     │                                          │ followup
                     ▼                                          ▼
              render.js → ilink.sendText               session/event
                     ▲                                          │
                     └──── notify.js（进度节流 / 结果卡）◀───────┘

审批：approval/request ──(绑定会话才接管)──▶ 微信「/审批 <id> 允许」
提问：user-questions/request ──▶ 编号选项 ──▶ 解析为 {answers:[{id,selected}]}
网页：webServer prefix /weixin-channel/api（单一路由，不用 connection.rpc）
```

状态目录 `$DSH_HOME/integrations/dsh-weixin-channel/`：

```
account.json     bot token、botId、accountId、ownerUserId、baseUrl（0600）
bindings.json    chats{ chatKey: ChatBinding }、allowlist、admins、seenMessageIds、pendingTrust
cursor.json      getupdates 游标
```

## 4. 数据模型

```js
ChatBinding = {
  platform: 'weixin', chatId, chatType: 'private',
  activeWorkspace: 'D:\\…\\ifm30',
  sessions: { 'D:\\…\\ifm30': 'session-…', 'D:\\…\\cf-pan': 'session-…' },
  model: { provider, model, reasoningEffort? } | null,   // null = 跟随默认
  permissionPreset: 'workspace-write',
  planMode: false,
  replyGranularity: 'standard',
  muted: false,
  createdAt, lastActivityAt
}
```

`model: null` 表示「跟随部署默认」，这样改了 Config 默认值后未显式选择过的聊天会自动跟随。

## 5. 命令与交互

命令表见 [README](../README.md#what-you-get)。

**待选状态机**：`/项目`、`/模型`、`/思考`、`/模式`、`/回复`、`/会话` 发出编号菜单后登记
`{ chatId, kind, options[], expiresAt }`；下一条纯数字消息命中即执行，`0` 取消，
超时或其它消息则丢弃。同时支持 `kind 参数` 单条直达，不依赖状态。

## 6. 会话 / 工作区 / 模型语义

```
ensureAgent(chatId):
  workspace = binding.activeWorkspace || defaults.workspace
  sessionId = binding.sessions[workspace]
  live = agents.get(sessionId)                       → 复用
  否则 resume(sessionId)                             → 成功即用
  绑定丢失时：sessionPersistence.stat(idFor(chat, ws)) 命中 → resume 接回原会话
  仍无 → create(idFor(chat, ws))                      → 记入 binding.sessions[workspace]
          该 id 已被占用（SessionAlreadyExistsError）→ 换随机 id 重建，不失败整个回合
  无论哪条路径，最后都 joinWorkspace(sessionId, workspace)
```

- **id 冲突（本次修复）**：会话 id 由 (chat, workspace) 确定性生成，而会话日志比
  `bindings.json` 活得久。绑定被清掉/换绑后，第二次 `/新建` 会让持久层去创建
  一个「日志已存在」的 id，微信端整轮只回一句
  `处理失败：session "…" already exists`。现在分三层处理：先 `stat` 命中就接回
  原会话；确实没有才 create；create 仍报冲突就换 `session-<uuid>` 重建并写审计
  `session/id-collision`。`/新建` 本身用 `{ fresh: true }` 直接生成随机 id，
  不再瞄准上一个会话占着的确定性 id。

- **切工作区**：改 `activeWorkspace`，不销毁旧会话；旧会话仍可在网页端打开。
- **挂回工作区**：侧栏按**注册表成员关系**分组，不看会话 header 的 `cwd`。
  `agents.create()` 绕过了会顺手 attach 的 `session/create` 命令，所以每次
  新建/恢复都要显式 `workspaceRegistry.resolveByPath(ws).attachSession(id)`；
  启动时再补扫一遍已记录的绑定，把历史会话从「未分组」挂回去。
- **切模型**：空闲 → `agent.model.select()` 立即生效；运行中 → 记录到
  `deferredModels`，`turn/end` 后应用并回执「下一回合生效」。
- **切权限**：写绑定 + `permissionPresets.set(session, preset)`。
- **切预设**：预设的工具在 Agent 创建时挂进作用域，会话 header 记死后不可改，
  所以「resume 一个旧会话」永远用旧预设。现在把绑定里的选择解析成 `preset.id`
  （无效则回退默认），再和会话**实际运行的**预设比对（live header 或
  `sessionPersistence.stat`）：不同才新开会话并记 `preset/switch`。两道护栏：
  只有显式选过才切（没选过的聊天继续 resume）；失效选择回退后写回绑定，
  否则每条消息都会新开一个会话。
- **并发**：每聊天串行（队列 + `whenIdle()` 等待 + 超时兜底），不同聊天并行；
  长轮询本身不再等待回合，收到消息就交接。

## 7. 安全

| 风险 | 处理 |
|---|---|
| 陌生人驱动 agent | 默认 deny-all；白名单 + 待信任队列 + 管理员 `/信任` |
| token 泄露 | 只走 `Authorization: Bearer`；URL 白名单 `*.weixin.qq.com`；日志与接口回包脱敏 |
| 面板越权 | 路由挂在 `webServer`（默认 loopback）；回包白名单字段；GET 只读（只有 `status`/`sessions.wechat`），其余动作必须 POST + `application/json`；`Origin` 与 `Host` 不一致即拒 |
| 危险权限 | `danger-full-access` 需显式配置，README 明确警告 |
| 重复消费 | msgId LRU（1000）+ 游标持久化，去抖落盘 |
| 回合卡死 | `turn.timeoutMs` 到点放弃等待并提示 |
| 双弹窗 | 只接管 IM 绑定会话，其余 `next()` |
| 双长轮询抢消息 | README 明确：同一账号不要同时跑两个微信 bot |

## 8. 与 dsh-im 的差异

| 维度 | dsh-im | 本插件 |
|---|---|---|
| 工作区切换 | 部署级单一工作区，改配置要重启 | 切到该工作区**自己的**会话，切回可续聊 |
| 模型切换 | 部署级单一模型，只影响新会话 | **当前会话就地生效**，历史保留 |
| 偏好粒度 | 部署级 Config | **聊天级**，Config 只做默认值 |
| 审批/提问 | 命令式 `/approve` | 编号文本，超时 fail-closed |
| 回复粒度 | 全量推送 | 三档；微信无编辑能力，改用节流多条 |
| Agent 预设 | — | 每会话显式挂载，决定本地工具是否可见 |

## 9. 测试覆盖

`node --test`（本插件 193 项；仓库根 `npm test` 213 项 = 本插件 193 + skill-manager 20）：

| 文件 | 覆盖 |
|---|---|
| `commands.test.js` | 解析、别名、编号选择、TTL、`0` 取消、管理员命令集 |
| `render.test.js` | Markdown 降级、切块、代理对、结果卡、状态卡 |
| `store.test.js` | 原子写、0600、损坏回退、绑定模型、去重窗口、重启保持 |
| `ilink.test.js` | 假 iLink 服务器：QR、token 只走 header、超时即空批、拒发、上下文 token |
| `bind.test.js` | 扫码状态机、游标、绑定码功能已移除 |
| `session.test.js` | 每工作区独立会话、切回续聊、模型就地/挂起、resume 失败回退、会话挂回工作区 |
| `bridges.test.js` | 审批接管与超时拒绝、提问编号映射、非绑定会话委托、静音、流式帧 |
| `routes.test.js` | 绑定脱敏、bind 状态白名单、路由信封、GET 只读、跨站拒绝、POST 必须 JSON、方法白名单 |
| `client.test.js` | 浏览器半边的样式源：主按钮用 fill + inverted 成对 token、无硬编码白字、二维码白底保留；中英 COPY 键集一致、没有渲染不到的孤儿键 |
| `media.test.js` | AES key 三种编码、ECB 加解密往返（含无 padding 块）、CDN 域名白名单、文件名净化、`extractMedia`/`quotedFromMessage`、下载解密与体积上限、上传四步（`x-encrypted-param`、`upload_param` 回退、非 CDN 拒绝）、指纹、`mediaItemFor` 的 type/len/aes_key |
| `entry.test.js` | 插件入口、Config 默认值、模型键切分、默认值落盘与重启保持（含 `agentPreset`）、白名单、去重、编号菜单、管理员拦截、`/回答` 投递、轮询交接不阻塞、`queueMax` 可达、回合中命令不清指示器、回放缓存上限、代理串脱敏、入站图片落盘成路径、陌生人图片不触发下载、无转写语音拒绝、引用标题进提示词、面板静音、`weixin_send` 带 file |

真机验证（本机 desktop profile）：

- `plugin_manager install_bundle` → `application: applied`
- `GET /weixin-channel/api?action=status` → `200`，返回 9 个工作区、全量模型目录
- `POST {"action":"bind.begin"}` → `phase: qr`，返回可用的 260×260 PNG 二维码
- 客户端设置页已注册到 `settings.section`（`id: weixin-channel`, `order: 25`）——
  侧边栏「Agent 预设」(20) 与「桌宠配置」(30) 之间；第三方插件不能用
  `settings.plugins.tab`，那是内置插件分区的页签，渲染它的 ui-settings-plugins
  并非所有构建都挂载

## 9.1 微信端「正在输入」与工具回执

两个体感问题，一个在协议字段名，一个在推送节奏：

**看不到「正在输入」**——两层原因，第二层才是根因：

1. **续期**：`sendtyping` 的 `status: 1` 只维持几秒，原实现只在收到消息时发一次，
   于是一个跑几分钟的回合里指示器闪一下就消失。`showTyping` 现在立刻发一次并起
   一个 `typingIntervalMs`（默认 4s，下限 1s）的定时器持续续期，`hideTyping` 在
   回合结束、命令答完、等待超时三种出口统一发 `status: 2`。
2. **字段名**（真正的 bug）：`sendtyping` 的线上字段是
   `{ ilink_user_id, status, typing_ticket }`，而原实现发的是
   `{ to_user_id, typing_status }`。HTTP 层对多余字段照收，于是请求「成功」、
   指示器永不出现，日志里也查不到任何错误。已改为协议字段名，并对 `ret != 0`
   抛 `typing-rejected` 而不是静默吞掉。
3. **票据有效期**：`typing_ticket` 会轮换。缓存原来永不过期，用了一天之后就悄悄
   失效；现在缓存 12 小时，并且 `status: 1` 被拒时立刻丢弃票据，下条消息重取。
   `/诊断` 新增「正在输入」一行，直接显示上次尝试的成败与原因。

**工具调用刷屏**：`standard` 粒度原本是「一次工具调用一条微信消息」，一个二十步
的回合就是二十条推送，把答案埋了。现在工具行**默认不推**（`reply.toolProgress:
false`），轨迹留在网页端；需要旧行为显式打开。

## 9.2 微信端字段名的下划线被吃掉

桌面端显示 `prd_code`，微信端显示 `prdcode`；`model_comment` 变成 `modelcommen`。

根因是 `render.js` 的 Markdown 降级规则把**下划线当强调**处理：
`/(^|[^_])_([^_\n]+)_/` 会把「`prd_code` 与 `model_flag` 之间」的下划线配成一对，
一次删掉两个标识符的下划线。中文技术对话里 `snake_case` 标识符遍地都是，
这条规则几乎必然误伤。

修法：

- 下划线**不再**当强调；星号强调保留（没有标识符用星号）。
- 行内代码 `\`...\`` 先切成字面片段，片段内部不做任何替换，只去掉反引号。

回归测试：`render.test.js` 三条（裸标识符、行内代码、句内 snake_case）。

## 9.2.1 回答被截断成「…（已截断，回复 /日志 获取完整输出）」

微信端一条长回答在「关于你之前的三件事，现在的状态」处戛然而止，桌面端却是完整的。
三层原因叠在一起：

1. **结果卡片硬截断 1200 字**（根因）：`resultCard` 无条件
   `clip(summary, 1200)`，任何超过 1200 字的回答都会在句中切断。实测那条回答
   原文 1725 字。现在卡片默认**不截断**，交给 `sendText` 按
   `reply.maxChunkChars` 分条发；只有显式选择 `summary` 粒度才要摘要
   （`summaryLimit: 1200`）。
2. **流式 flush 也截断 1500 字**：`full` 粒度下每个 flush 都
   `clip(..., 1500)`，一段 4000 字的增量只发出前 1500 字，中间凭空消失，而
   `deliveredRaw` 却按全量计数，卡片再按这个数切片 → 两头都丢。现在 flush 不再
   截断，只按发送上限分条。
3. **重复发送**：`full` 已经把正文流式发出去了，卡片又把同一段发一遍。现在卡片
   只补发「流式没覆盖到的尾巴」（按 `deliveredRaw` 在原文里切片）。

顺带把 `reply.maxChunkChars` 默认值从 3500 降到 **2000**：iLink 没有公开上限，
社区实现普遍以 2000 作为安全值，超长消息可能被直接拒绝——那看起来就像「文字丢了」。
`/日志` 也去掉了自己的 `clip`，它承诺的是「完整输出」。

回归测试：`bridges.test.js` 三条（长回答不被截断、summary 粒度仍要摘要、
full 流式不重复）。

## 9.3 命令支持中英双语 + 短别名

手机键盘上 `/granularity`、`/permission` 太长，等于不可用。现在每个命令都有
「中文 / 英文全称 / 英文短别名」三种写法，`/帮助` 里一行一条、三种都给出：

    /模型（model，m）: 切换模型

即「中文命令（英文全称，短别名）: 中文描述」：描述只用中文，英文只出现在括号里，
避免中英并排把每行拉长到手机上要折行、整份说明超过一屏。

| 中文 | 英文 | 短别名 |
|---|---|---|
| /帮助 | /help | /h |
| /状态 | /status | /st |
| /新建 | /new | /n |
| /项目 | /project | /ws |
| /模型 | /model | /m |
| /思考 | /think | /th |
| /模式 | /permission | /pm |
| /回复 | /reply | /rep |
| /预设 | /preset | /ps |
| /计划 | /plan | /pl |
| /会话 | /sessions | /ss |
| /停止 | /stop | /sp |
| /重试 | /retry | /rt |
| /日志 | /log | /lg |
| /诊断 | /diag | /dg |
| /静音 | /mute | /mu |
| /解绑 | /unbind | /ub |

别名表由 `ALIAS_TABLE` 一处生成，`canonicalCommand()` 是唯一解析入口；
不做前缀匹配（`/mo` 不会命中 `/model`），避免手滑触发意外操作。

## 9.4.1 微信气泡里的 Markdown 语法（渲染兜底）

微信不渲染任何 Markdown：没有加粗、没有标题、没有表格。上一版把 Markdown 直接
"拍平"，结果语法符号全留在气泡里——截图里 `## tbproduct.control_flag 概览`
显示成 `▍▍ tbproduct.control_flag 概览`（两根竖线，看着像乱码），正文里还有
零散的 `**` 和反引号。

根因是 `markdownToText` 的两条旧规则：

1. 标题 → `'▍'.repeat(level) + ' '`。一个 `##` 变成 `▍▍ `，手机上看就是两根
   竖线，不会读成"标题"。
2. 加粗 → 直接删掉 `**`。微信无法显示加粗，删掉标记等于**丢失了模型刻意写的强调**，
   而「字段」「结构」这种小标签正是靠它区分的。

现在改为「渲染成纯文本里可读的形态」：

| Markdown | 微信气泡 |
|---|---|
| `## 标题` | `【标题】`（`###` → `『标题』`，更深 → `〔标题〕`） |
| `**重点**` | `「重点」` —— 强调保留 |
| `*斜体*` | `/斜体/` |
| `\`field_name\`` | `field_name`（只去反引号） |
| 表格 | 每行格子用 ` \| ` 连接，分隔行丢弃 |
| 围栏代码 | 三反引号之间原样保留 |
| 单个换行 | **空行**（见下） |

### 换行必须写成空行

微信气泡按 Markdown 子集渲染，单个 `\n` 是**软换行（soft break）**，客户端把它显示
成空格——这正是 `/帮助` 曾经被压成两大段的根因：文案里每个命令各占一行，气泡里
【通用】之后的命令全粘成一行、命令之间的换行变成了空格。协议侧（iLink）的
`sendmessage` 只带纯文本 `text_item.text`，没有任何换行控制位，所以只能靠文本本身
的**空行**分段。

现在 `markdownToText` 对每一行输出后补一个空行（`push()` 里的
`out.push('')`），两类例外：表格行必须相邻（否则客户端把表格拆成碎片），围栏代码
内部原样保留（补空行会改动代码本身）。渲染是幂等的——已渲染文本再跑一次结果不变，
因为 notify 的流式收尾会二次渲染。

双层保险：`helpText()` 自己就用 `\n\n` 连接每一行（`helpText()` 里的
`.join('\n\n')`），而不是依赖渲染器补空行。原因是一次改版只改了渲染器，正在运行
的 DSH 进程里仍是旧模块，微信端继续显示粘连效果；文案自己带空行后，任何只去
Markdown 标记、保留空行的实现都能正确分行。回归测试
`the help text separates commands with blank lines itself` 断言 `helpText()` 的原始
输出里命令之间已有空行。

同时把通道指令从「用标准 Markdown」改成「禁止 Markdown 语法标记」，要求模型直接
写纯文本（「重点」、单独一行【标题】）。两层都在：模型按约定写，渲染器兜底任何漏网
的语法。回归测试 `render.test.js` 断言气泡里不出现 `**`、`^#`、反引号、`| ---`。

## 9.5 精简回复 + 微信会话行标识 + 回复格式约定

**回复规则**（`lib/index.js#composeSetup` 注入的 `weixin:channel-instruction`）：
微信是纯文本，**禁止输出 Markdown 语法标记**（`**` / `##` / 反引号 / 表格 / 围栏）——
强调写「重点」、小标题单独一行写【标题】、列表用 `-` 或 `1.`。渲染器作为兜底
（见 9.4.1）。单次回答必须 **少于 2000 字**，超出先给结论和要点、再说明可按需展开；
禁止 HTML / GenUI / Mermaid，也**不要用下划线做强调**（下划线留给 `snake_case`
标识符，见 9.2）。

> 早期版本这段曾自相矛盾：一边要求「禁止 Markdown」，一边又要求「用标准 Markdown
> （## 小标题、**加粗**）」。现在只有一种说法，与 9.4.1 的渲染兜底一致。

**侧栏行标识**：`ui-workspace` 为每个 Session 行声明了 `sidebar.session.row.leading`
（list、root 作用域，只传 `sessionId`，仅在该行主状态 idle 时渲染）。客户端注册
id=`weixin-channel-mark` 的占用方，绿色微信字形；由于 seat 拿不到会话元数据，
它向 Host 的 loopback 路由 `?action=sessions.wechat&sessionIds=a,b` 询问归属，
答案在客户端缓存并广播给所有行，查询失败就静默不显示（标记只是装饰）。
缓存必须**按 id 合并**而不是整体替换：每行各自挂载、各自问自己那个 id，
整体替换会让最后挂载的行把前面刚查到的标记全清掉（曾经的表现是「基本不显示」）。
同时把同一帧内的询问合并成一次请求，40 行的侧栏不再打 40 个 loopback 请求。
Host 侧对应 `WeixinChannel#wechatSessions()`，同时通过 `ctx.weixinChannel.sessions()`
暴露给其他插件。

## 9.6 提问无法回答 + 长回合堵死通道（本轮修复）

**提问卡片无法回答**：`QuestionBridge` 一直在发「回复 `/回答 <id> <编号>`」，
`respond()` 也一直在，但 `commands.js` 的 `ALIAS_TABLE` 里**没有** `回答/answer`，
`runCommand` 也没有对应 case。于是用户照提示发 `/回答 a1b2 1`，被当成未知命令
回一句「未知命令 /回答」，唯一结局是 300 秒超时 fail-closed 成「跳过」，模型收到
`selected: []`，以为用户主动放弃了。修法：补 `['answer', ['回答','答复','answer','ans','aw']]`
与 `commandAnswer()`（无参数时列出待回答清单），并在 `/帮助` 里公示。

**长回合堵死整个通道**：长轮询里是 `for (msg of msgs) await this.handleInbound(msg)`，
而 `handleInbound → dispatchTask → await task` 会等整轮结束。于是一个跑十分钟的回合
期间，这个 bot **不再拉任何新消息**：`/停止` 发不进来、审批卡片发出去没人能回、
另一个聊天的消息也只能干等。设计文档 D6 写的「不同聊天并行」根本不成立——per-chat
队列在轮询层就已经串死了。修法：

- 轮询改为 `this.acceptInbound(message)`（fire-and-forget），在途 promise 记入
  `this.inflight`，`dispose()` 最多等 5 秒再拆。
- 每聊天串行、跨聊天并行由 `dispatchTask` 的 `{ chain, size }` 保证；`size` 计入
  「已接受未完成」（含正在跑的），`turn.queueMax` 这才真正生效——之前 `queueDepth()`
  恒返回 0/1，上限和那句「⏳ 排队已达上限」永远触发不到。
- 「正在输入」改为**引用计数**（`typingRefs`）：轮询不再等回合后，`/状态` 可能在回合
  运行中插进来答完，如果它直接 `hideTyping` 会把回合的指示器一起关掉。现在最后一个
  持有者才发 `status: 2`。`/重试` 从命令里起回合，自己补一次 `showTyping`。

回归测试：`entry.test.js` 新增 5 条（`/回答` 投递、`/回答` 无参列清单、轮询交接不
阻塞、`queueMax` 可达、回合中命令不清指示器），`commands.test.js` 补 `/回答`、`/审批`
三写法。

## 10. 已知限制与后续

- 仅私聊、单 bot 账号。
- 图片/文件/视频**收发已实现**（见 §12）；语音发送仍缺（协议无稳定 helper），
  无转写的语音无法理解（SILK 编码）。
- 上传一律 `no_need_thumb: true`，因此视频在聊天列表里没有封面帧。
- 群聊、多账号在 v2。
- Agent 预设切换需要新会话；`/预设` 已实现（写绑定 + 新会话挂载），旧会话保留。
- 微信没有消息编辑能力，所以「完整」粒度仍是多条独立消息，不是原地流式。

## 11. 踩坑记录

### 11.1 微信里「什么工具都用不了」，只剩远程 SSH 和 MCP

现象：从微信派活，模型能对话，但读写文件、跑命令全都不可用；工具清单里只有
`rw_*`（远程 SSH）和 MCP，看起来「远程控制桌面端毫无意义」。

根因在**预设挂载**，不在权限：Web/Desktop bundle 把本地能力全部挪进了 Agent 预设
（`dsh-web-app/cordis.patch.yml` 把 `tool-fs` / `tool-pwsh` / `tool-skill` /
`agent-instructions` / `compaction` 全部 `disabled: true`，改由
`presets/*.patch.yml` 里的 `@deepseek-ai/dsh-agent-preset` 行提供）。预设是
**会话级**的：只有 `agentPresets.mount(agentCtx, id)` 把 Agent scope 绑到某个预设
generation 上，那些工具才对它可见。

本插件直接调 `agents.create()` / `agents.resume()`，既没传 `meta.agentPreset`，
也没在 `setup` 里挂载预设，于是会话跑在「预设之外」——主机平面的插件（dsh-remote
的 `rw_*`、MCP server）照常可见，预设内的本地工具一个都没有。

修法（`lib/session.js`）：

1. `resolvePreset(binding)`：绑定上的 `agentPreset` → 否则 `agentPresets.resolve()`
   的部署默认；不存在的预设回退默认并记 `preset/fallback` 审计，不让聊天卡死。
2. `composePresetSetup(setup, presetId)`：先 `await presets.mount(agentCtx, id)`，
   再跑本插件自己的 setup（通道指令 + 流式监听）。挂载失败只记
   `preset/mount-failed`，不抛——坏预设应降级为「工具少」，不是「聊不了」。
3. `createAgent` 把 `agentPreset` 写进 `meta`，会话 header 记住它，之后
   resume 会按 header 的预设重建同一套组合。

`/预设` 因此是**功能开关**，不是装饰：它决定这个会话到底有没有文件、终端、技能。

### 11.2 微信会话一直显示在「未分组」

切了工作区、会话 header 的 `cwd` 也确实对了，侧栏却仍把它放在「未分组」。

原因：侧栏分组用的是 **Workspace 注册表的成员关系**，不是会话 header 里的 `cwd`。
`workspaceRegistry` 只在 `session/create` 这条 Web 命令里 `attachSession()`；本插件
直接调 `agents.create()` 建会话，绕过了那一步，于是会话既不在任何 Workspace 的
`sessionIds` 里，也就只能落进「未分组」。`attachSession()` 本身会校验 header 的
`cwd` 与工作区路径一致（`realpath` 归一后比较），所以显式挂载是安全且必要的。

修法（`lib/session.js#joinWorkspace`）：

```js
const registry = ctx.get('workspaceRegistry')
const entity = await registry.resolveByPath(workspace)
await entity.attachSession(sessionId)      // 幂等：已是成员时直接返回
```

调用点覆盖三条路径：新建会话、恢复会话、复用活跃会话；另外 `start()` 里补一次
`repairWorkspaceMembership()`，把修复前创建的会话也挂回工作区。失败只记日志不抛错——
对话照常可用，只是留在「未分组」。

回归测试：`session.test.js` 的三条（新建即挂载、恢复不重复挂载、挂载失败不影响对话）。

### 11.3 会话格式 v4 拒绝 `{ kind: 'plugin' }` 消息来源

微信里发任意一句话，回「处理失败：format v4 message requires a producer-owned source kind」。

原因：本插件派活时构造的用户消息写的是**已退役**的来源包装

```js
source: { kind: 'plugin', plugin: 'dsh-weixin-channel' }   // ❌ v4 拒绝
```

`dsh-session-format-v3-to-v4` 的 `message-sources.ts#source()` 在**写盘前**就拒绝它
（`kind === 'plugin'` 直接抛错）。v3 的 `plugin` 包装只允许出现在**历史迁移**路径，
由 `rewritePluginSource()` 改写为生产者自己的 kind（`plugin:<包名>` 或内建名），
新代码不能再用。正确写法是给消息一个**生产者自有**的 kind：

```js
source: { kind: 'user' }   // ✅ 这就是人在微信里说的一句话
```

`kind: 'user'` 同时让网页端把它当作真实提问（进入排队区、刷新 `lastPromptAt`、
在对话流里显示为右侧气泡），而自定义 kind 会被当成匿名上下文。

回归测试：`entry.test.js` 的「a dispatched prompt carries a producer-owned source kind」。

### 11.4 微信里每条消息都只回「⏳ 被阻塞 / ⏱ 1.2s」

现象：12:29 发了一张图、又问了一句「这个是什么图片」，两条回复都是同一张卡：只有
状态行和时间，没有正文、没有错误。换成文字、重启宿主都一样。1.2 秒这个时长是关键
线索——**没有请求发生**。

原因：宿主有一个 `archived-session-gate` 插件，挂在 `agent/pre-step` 上：

```js
ctx.on('agent/pre-step', (payload, next) =>
  underArchivedSession(ctx, payload.agent) ? Promise.resolve({ kind: 'reject' }) : next())
```

`underArchivedSession` 沿 header 的 `parentSession` 链上溯（子代理会话受父会话牵连），
命中 `workspaceRegistry.archivedSessionIds` 就 reject。agent loop 收到 reject 时：

```js
const decision = await this.preStep(target, { turn, step })
if (decision.kind === 'reject') { turnEnds = { kind: 'blocked' }; return false }
```

于是**不追加 step/start、不发起请求**，日志里只剩 `turn/start` + `turn/end
{kind:'blocked'}`，这正是「1.2 秒、没有模型调用、也没有报错」的形状。

为什么会命中：那个会话在侧栏被归档过（`workspace.json` 的
`global.archivedSessionIds`）。归档**不动** `workspace.sessionIds` 槽位，所以会话在
侧栏里照样看得见；而本插件只认 `bindings.json` 里的映射，resume 一个已归档的会话
并不会解除闸门——用户每发一条消息就 blocked 一次，永远不会自愈。

修法分两层：

1. **真修复**（`lib/session.js#liftArchive`）：在 `ensureAgent` 拿到 recorded 会话后、
   以及 `adoptRecorded` 接回确定性 id 后，检查
   `registry.archivedSessionIds.includes(sessionId)`，命中就
   `await registry.unarchiveSession(sessionId)` 并写 audit
   `session/unarchive`。只在**派活路径**上解除，不在 `start()` 里做——启动时解除等于
   把用户主动归档的会话悄悄翻出来。`unarchiveSession` 幂等且不校验存在性，所以没有
   registry 的部署是无害的空操作；失败只记日志 + audit `session/unarchive-failed`，
   对话照常可用。
2. **兜底文案**（`lib/notify.js#fallbackSummary`）：`blocked` 以前返回空串，卡片就只剩
   状态行。现在给出一句人话，点明「最常见的原因是它在侧栏里被归档了」，并给出两条
   出路（Web UI 取消归档 / `/新建`）。`interrupted` 同样补了一句。

回归测试：`session.test.js` 五条（归档后下一条消息解除并复用同一会话、活跃但已归档
的 agent 也解除、未归档时不调用 unarchive、接回路径同样解除、解除失败不影响回合），
`bridges.test.js` 两条（blocked 卡片说明原因与出路、interrupted 卡片有正文）。

### 11.5 深色模式下设置面板的按钮变成空白白框

现象：深色主题下，「生成二维码」「添加用户 id」「保存」三个按钮只剩一个白色圆角
矩形，文字完全看不见；输入框、下拉框、卡片背景都正常。

原因是一个**成对 token 只写了一半**：

```js
background: 'var(--dsw-alias-brand-primary, #4f6ef7)', color: '#fff'   // ❌
```

`--dsw-alias-brand-primary` 不是品牌蓝，而是**前景对比色**：浅色主题取
`neutral-bluish-1000`（#0f1115，近黑），深色主题取 `neutral-bluish-50`
（#f9fafb，近白）。文字写死 `#fff` 时，浅色下是黑底白字（看着对），深色下就
成了白底白字。它的配对文字 token 是 `--dsw-alias-label-primary-inverted`
（浅色 #fff、深色 `neutral-bluish-800` #353638）。

修法：填充和文字**都走 token**，且用成对的语义别名——

```js
background: 'var(--dsw-alias-button-primary-fill, var(--dsw-alias-brand-primary, #4f6ef7))',
color: 'var(--dsw-alias-label-primary-inverted, #fff)',
```

这也是 DSH 官方客户端插件的写法（`dsh-memory-evolve` 的 `advisor-styles.css`
就是 `button-primary-fill` + `label-primary-inverted` 这一对）。

排查方法：DSH 的主题变量全在
`@deepseek-ai/dsh-client-ui-theme/lib/client.js` 的 `design_platform_css_default`
字符串里（在 `app.asar` 内，按 asar 头可直接抽取）。深色不是
`prefers-color-scheme`，而是 `body[data-ds-dark-theme]` 属性块；对照浅/深两块
同名变量的值，就能看出哪些会翻转。

唯一**故意**写死颜色的地方是 `S.qr` 的 `background: '#fff'`：二维码需要白色静默
区才能扫出来，跟着主题变深就扫不动了。

回归测试：`client.test.js` 三条（主按钮必须成对用 token、按钮样式不得硬编码白
字、二维码白底保留）。客户端代码没有构建步骤也不在 Node 里跑，所以测试是**读源
码断言**。



### 11.6 设置入口从「设置 → 插件」的页签搬到左侧导航栏

原来的注册点是 `settings.plugins.tab`——它是**内置插件分区**里的一个页签，宿主
是 `@deepseek-ai/dsh-client-ui-settings-plugins`。这条路对第三方插件有两个坑：

1. 该分区只在内置插件页存在时才有意义，而它的页签列表来自同一个 slot 账本；
   入口藏在「设置 → 插件 → 微信」两级之下，用户要找一个插件的配置得先知道
   「插件」这一栏里有页签。
2. 更早的写法 `plugins.item` / `settings.plugin.item` 是内置插件配置分组，渲染
   它的 `dsh-client-ui-plugin-manager` 在桌面构建里根本不挂载（dsh-boot-animation
   的注释里记着这个 issue #8），第三方卡片于是**注册成功但永远不显示**。

正确座位是 `settings.section`：一个 section 就是设置左侧导航的一行，宿主是
`dsh-client-ui-settings-general`，它把账本投影成导航行（`:1151-1156`）：

```js
ctx.slots.entries('settings.section')
  .map((e) => ({ id: e.options.id, order: e.options.order, label: resolveSlotLabel(e.options.label) }))
  .sort((a, b) => a.order - b.order)
```

要点：

- **order 决定位置**：`general` 0、`models` 10、`plugins` 15、`agent-presets` 20、
  `pet-config` 30、`dsh-remote`/`market` 40、`boot-animation` 60、`bili`/
  `better-sidebar` 100。本插件取 25，正好在「Agent 预设」与「桌宠配置」之间。
- **label 是 thunk**：外壳在 locale revision 变化时重新解析，注册方不必自己重注册。
  导航栏会截断长标签（「远程工作区（ds…」），所以导航用短名 `微信通道`，完整名
  `微信 Bot 通道` 留在页面第一张卡片的标题里。
- **图标由外壳按 id 硬编码**（`navIcon(id)` 只认 account/models/agent-presets/
  plugins/archived-sessions），未登记的 id 一律齿轮图标，插件无法自定义。
- **只渲染当前选中的 section**：`renderSlot('settings.section', { close }, { only: active })`，
  所以面板里那个 5 秒轮询只在用户停在这一页时跑。

回归测试：`client.test.js` 断言源码里注册的是 `settings.section`、不再出现
`settings.plugins.tab`，且 order 落在 21–29。

## 12. 图片 / 文件 / 视频收发

v1 只做文本时，用户在微信里发一张图，机器人回「这个格式暂不支持」——这是体验上
最硬的断点。§12 记录补齐这一块时的取舍。

### 12.1 入站只做「搬运」，不做「解码」

通道不解析图片、不抽帧、不 OCR。它把密文下载下来、AES-128-ECB 解密、写进
`<workspace>/inbox/`，然后把**真实路径**写进提示词交给 agent：

```
【微信图片】2026-01-13T09-12-40-abc123-photo.jpg
大小：2.1 MB
本地路径：D:\proj\inbox\2026-01-13T09-12-40-abc123-photo.jpg
如需查看内容，请直接用文件工具读取上面的本地路径。
```

理由有三条：

1. agent 有的是**文件工具**，不是媒体解码器。给它路径，它能自己决定读、转、
   抽取；给它「用户发了一张图」这句话，它只能凭 caption 猜——这正是旧行为。
2. 一个 20 MB 的视频在进程里解码是纯浪费，而 agent 可能根本不需要它。
3. 通道不需要知道任何格式细节，新增格式（视频、文档）零成本。

路径落在**工作区内**而不是 stateDir：agent 的文件工具以工作区为根，工作区外的
路径可能被它拒绝读取。

文件名是 `<ISO 时间戳>-<chatId 尾 6 位>-<净化后的原名>`。前缀解决两个人同时发
`photo.jpg` 互相覆盖；`sanitizeFileName` 解决路径穿越（`../`、盘符、路径分隔
符、非法字符、超长截断）。

### 12.2 授权必须在下载之前

原实现的 `isAllowed` 检查在文本提取之后，而下载就挂在文本提取那一支。这意味着
**任何人**给 bot 发一张图，Host 就会去拉一个最大 20 MB 的负载——未授权用户成了
免费的下载触发器。

现在顺序是：`isHumanSender` → 去重 → 判定有没有内容 → **allowlist/trustGate** →
下载。注释写死了这条约束（`Authorization comes BEFORE the download`）。

### 12.3 带附件的一定是任务，永远不进命令分支

用户可能给一张图配文 `/帮助`。如果照旧走命令解析，图片会被丢掉；如果走任务，
命令又不会执行。选择是：**附件优先，一律当任务**，图片绝不丢。

例外是**没有转写文本的语音**：负载是 SILK 音频，agent 读不了，下载下来也只是
占地方。这种情况直接回「这条语音没有转写文本，暂时无法理解。请改用文字，或重新
发送。」并且**不下载**。

### 12.4 引用消息要显式拼进提示词

微信的「回复某条消息」把被引用内容的摘要放在 `item.ref_msg.title`，**不在正文
里**。所以「这个多少钱？」单独发给 agent 时，它完全不知道「这个」指什么。

现在纯文本消息也会检查 `quotedFromMessage(message)`，有引用就在正文前加
`【引用】<title>`。附件消息则通过 `attachmentPrompt` 的「引用的消息：…」行带上。

注意 `ref_msg` 挂在 **MessageItem 层级**，不在 `image_item` / `file_item` 里——
写错层级读出来永远是空串。

### 12.5 出站四步上传

`weixin_send` 增加 `file` 参数，走官方四步：

1. 算明文 `rawsize` / `rawfilemd5`，以及 AES-128-ECB 加密后的 `filesize`
2. `POST /ilink/bot/getuploadurl`，带 `media_type`（1 图 / 2 视频 / 3 文件 /
   4 语音）、`no_need_thumb: true`、32 位 hex 的 `aeskey`
3. **优先用响应里的 `upload_full_url`**，没有才用 `upload_param` 拼
   `${CDN_BASE_URL}/upload?encrypted_query_param=…&filekey=…`；把**密文原始二进
   制**以 `Content-Type: application/octet-stream` POST 过去
4. 从响应头读 `x-encrypted-param`，它就是 `CDNMedia.encrypt_query_param`；连同
   `aes_key: base64(hex字符串)` 一起塞进 `sendmessage` 的 item

第 3 步是最容易踩的坑：直接 POST 会返回 `400 -5104001`，必须是
`application/octet-stream` 的**原始密文**，且 URL 参数要带全。第 4 步漏读
`x-encrypted-param` 则消息发出去但对方永远下载失败。

`media.maxBytes`（默认 20 MB）双向生效，两个方向都在解密/加密**之前**校验，
避免为一个注定失败的文件做完整加解密。

### 12.6 为什么 aes_key 写成「先 hex 再编码」的形状

协议里 `CDNMedia.aes_key` 有两种历史编码：`base64(16 字节原始 key)` 和
`base64(32 个 hex 字符)`。接收侧两种都要认（`decodeAesKey` 都试一遍，还兜底
裸 hex），发送侧统一写后者——这是官方实现实际发的形状。

回归测试：`media.test.js` 16 项 + `entry.test.js` 9 项（入站落盘成路径、陌生人
不触发下载、无转写语音拒绝、引用标题进提示词、面板静音、`weixin_send` 带 file）。
