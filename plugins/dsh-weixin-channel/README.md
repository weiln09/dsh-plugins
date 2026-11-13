# dsh-weixin-channel

> 把 DeepSeek Harness 接进微信：每个聊天一个独立工作区、独立模型、独立会话，全部操作在微信里用命令完成。

**版本：v1（包版本 0.1.1）** · 适用于 DSH `>=0.2.2-0 <0.3.0` · Node `>=22`

这是这个插件的第一版正式文档。它按"你要做什么"组织，而不是按"改过哪些 bug"组织；
每一条能力都在 `lib/` 里有对应实现，测试见文末。
设计决策、与旧实现的差异、踩坑记录见 [docs/design.md](docs/design.md)。

---

## 1. 这是什么

一个 DSH 通道插件：在 DSH 里扫码绑定一个微信 Bot 账号，之后你在微信里私聊它，
它就是一个跑在你自己机器上的编码 agent —— 能读文件、跑命令、用技能、连远程机器，
结果以纯文本气泡回到微信。

和"把网页聊天窗口转发到微信"的桥不一样，这个插件把**偏好放在聊天上，而不是放在插件配置上**：

| | 常见做法（一个通道一个配置） | 本插件 |
|---|---|---|
| 工作区 | 部署级单值，改一次所有聊天跟着变 | **聊天级**，每个聊天各选各的 |
| 模型 | 部署级单值，只影响新会话 | **聊天级**，当前会话就地生效，历史保留 |
| 会话 | 一个聊天固定一个会话 | **每个（聊天 × 工作区）一个会话**，切回来接着聊 |
| 权限/预设 | 全局 | **聊天级**，可单独收紧 |
| 回复粒度 | 全量推送 | **三档**，可单独调 |

所以同一个 Bot 账号可以同时服务"帮我改这个仓库"和"帮我看那个项目"，互不干扰。

## 2. 能力一览

- **扫码绑定**：设置面板生成二维码，手机微信扫码 + 配对数字，token 落盘 0600。
- **命令**：22 条，每条支持中文 / 英文 / 短写三种写法（`/模型` = `/model` = `/m`）。
- **菜单**：无参命令给编号菜单，回数字即选，`0` 取消，120 秒过期。
- **工作区 / 模型 / 思考档位 / 权限模式 / Agent 预设 / 计划模式** 全部可在微信里切换。
- **审批与提问**：agent 的审批请求、`ask_user_question` 卡片推到微信，用 `/审批`、`/回答` 处理，超时 fail-closed。
- **媒体双向**：发图/文件给 agent（落到工作区 `inbox/`，提示词给真实路径）；agent 也能通过 `weixin_send` 工具回图/文件。
- **正在输入**：整轮持续显示，不是一闪而过。
- **侧栏标记**：网页端会话列表里，来自微信的会话带绿色微信图标。
- **审计**：每次绑定/信任/切预设/切工作区都打一行 `[audit]` JSON 到 DSH 日志。

## 3. 快速开始

### 3.1 前置要求

| 项 | 要求 |
|---|---|
| DSH | `>=0.2.2-0 <0.3.0`，Web 或 Desktop 预设（设置面板由 `dsh-client-ui-slots` 提供） |
| Node | `>=22` |
| 微信 | 手机微信里有「我 → 设置 → 插件」入口（腾讯灰度，没有入口就绑不了 Bot） |
| 网络 | 能直连 `https://ilinkai.weixin.qq.com`（或给 DSH 进程配好 `HTTPS_PROXY`） |

### 3.2 安装

`dsh plugin` 只是把参数原样转发给 profile 目录里的 pnpm：

```sh
dsh plugin --profile desktop add @weiln09/dsh-weixin-channel
```

装的是 registry 上的 [`@weiln09/dsh-weixin-channel@0.1.1`](https://www.npmjs.com/package/@weiln09/dsh-weixin-channel)。

改代码时用本地路径（pnpm 的 `link:` 协议，改动即时生效，不用重新发布）：

```sh
dsh plugin --profile desktop add link:D:/path/to/dsh-plugins/plugins/dsh-weixin-channel
```

也可以装 tarball（在插件目录里 `npm pack` 会生成 `weiln09-dsh-weixin-channel-0.1.1.tgz`）：

```sh
dsh plugin --profile desktop add D:/path/to/weiln09-dsh-weixin-channel-0.1.1.tgz
```

安装后确认两件事：

1. `$DSH_HOME/profiles/<profile>/package.json` 的 `dependencies` 里有这个包，且
   `dsh.profile.bundles` 数组里也有它（bundle 里没有就不会被加载）。
2. 重启 DSH。

### 3.3 绑定微信 Bot 账号

1. 打开 DSH **设置 → 微信 Bot 通道**（排在「Agent 预设」下面）。
2. 点「生成二维码」，用手机微信扫码。
3. 手机弹出配对数字时，把它填进卡片的输入框并提交。
4. 绑定成功后卡片显示「已连接」，token 写入 `$DSH_HOME/integrations/dsh-weixin-channel/account.json`（权限 `0600`）。

也可以用环境变量提供 token，不落盘：

```yaml
- id: weixin-channel
  name: '@weiln09/dsh-weixin-channel'
  config:
    account:
      tokenRef: env:WEIXIN_BOT_TOKEN
```

> 扫码人（`ownerUserId`）会被自动信任，不需要额外授权。

### 3.4 授权要说话的聊天

默认 **deny-all**：陌生人发消息只会进「待信任」，永远到不了 agent。三种授权方式，任选其一：

- **面板**：设置 → 微信 Bot 通道 → 授权 → 粘贴用户 id → 添加。
- **命令**：在 `security.admins` 里的账号发 `/信任 <用户id>`（`/撤销 <用户id>` 反向操作）。
- **自动**：`security.trustFirstContact: true`，第一个来的人直接放行（只建议单人使用）。

### 3.5 验证

在微信里发 `/状态`，应该看到工作区、模型、会话、权限、连接状态。
再发 `/帮助`，应该看到 20 条常用命令按「通用 / 环境 / 回复 / 会话 / 任务」分组
（`/信任`、`/撤销` 是管理员命令，不列在帮助里；命令表共 22 条）。
然后直接说一句"看下这个仓库的结构"，就应该开始干活了。

### 3.6 发第一条任务

```
/项目            → 选工作区（回数字）
/模型            → 选模型（回数字）
/预设            → 选 Agent 预设（决定这个会话能用哪些工具）
看下这个仓库的结构，列一下主要模块
```

## 4. 命令参考

每条命令三种写法等价，大小写不敏感，**不做前缀匹配**（`/st` 是 `/status`，`/sta` 不是）。

| 命令 | 英文 / 短写（全部别名） | 作用 |
|---|---|---|
| `/帮助` | `帮助` `帮` `help` `h` `?` | 命令说明 |
| `/状态` | `状态` `status` `st` | 工作区、模型、会话、任务、连接状态 |
| `/新建` | `新建` `新` `new` `n` `clear` `清空` `reset` | 开一个新的任务草稿（新会话） |
| `/诊断` | `诊断` `diag` `dg` `doctor` | 连接、游标、待审批、正在输入、最近错误 |
| `/项目` | `项目` `工作区` `workspace` `project` `proj` `ws` | 切换工作区 |
| `/模型` | `模型` `model` `models` `mdl` `m` | 切换模型 |
| `/思考` | `思考` `思考级别` `推理` `reasoning` `reason` `think` `effort` `eff` `th` | 切换思考档位 |
| `/模式` | `模式` `权限` `permission` `perm` `mode` `pm` | 切换权限模式 |
| `/预设` | `预设` `preset` `presets` `pre` `ps` | 切换 Agent 预设（决定工具集） |
| `/计划` | `计划` `plan` `pl` | 计划模式开关 |
| `/回复` | `回复` `粒度` `reply` `rep` `re` `granularity` `gran` `gr` | 调整回复详细程度 |
| `/静音` | `静音` `mute` `mu` | 关闭本聊天通知 |
| `/恢复` | `恢复` `取消静音` `unmute` `un` | 重新开启通知 |
| `/会话` | `会话` `列表` `sessions` `session` `sess` `ss` | 列出并绑定当前工作区的已有会话 |
| `/解绑` | `解绑` `unbind` `ub` | 解除本聊天绑定 |
| `/停止` | `停止` `中断` `stop` `cancel` `sp` | 中断当前任务 |
| `/重试` | `重试` `retry` `rt` | 重发上一条任务 |
| `/日志` | `日志` `log` `lg` | 取回上一轮完整输出（不截断） |
| `/审批` | `审批` `批准` `approve` `apv` `ap` | `/审批 <编号> 允许\|拒绝` |
| `/回答` | `回答` `答复` `answer` `ans` `aw` | `/回答 <编号> <选项>`，多选用逗号，多问题用分号 |
| `/信任` | `信任` `trust` `tr` | `/信任 <用户id>`（管理员命令） |
| `/撤销` | `撤销` `revoke` `rv` | `/撤销 <用户id>`（管理员命令） |

上表与 `lib/commands.js` 的 `ALIAS_TABLE` 一一对应（22 条），中文别名也接受。

### 4.1 菜单与编号

不带参数时，`/项目`、`/模型`、`/思考`、`/模式`、`/预设`、`/回复`、`/会话` 会发一张编号菜单：

```
当前模型：（跟随默认）
选择模型（回复数字，0 取消）：
1. magpie/trae-cn/deepseek-v4.1-flash-max
2. magpie/workbuddy/glm-5.3（当前）
0. 取消

切换在当前会话立即生效，历史保留；回合运行中会在下一回合生效。
```

- 直接回数字即可；`0` 取消；菜单 **120 秒**后过期（过期后回数字会被当成普通消息）。
- 也可以跳过菜单直接带参数：`/模型 2`、`/模型 magpie/glm-5.3`、`/项目 D:/repo`、`/项目 repo`（路径后缀匹配）。

### 4.2 管理命令

`/信任`、`/撤销` 只在 `security.admins` 里的账号可用，其他人发会被拒绝。

## 5. 在微信里能做什么

- **切工作区**：`/项目`。切过去用该工作区自己的会话；原工作区的会话保留，切回来接着聊。
  回合运行中切会被拒绝（`⏳ 当前会话仍在运行`），先 `/停止`。
- **切模型**：`/模型`。空闲时立即生效；回合运行中会记下来，下一回合生效（回执会说明是哪种）。
- **切思考档位**：`/思考`。档位来自模型自身的 `reasoningEfforts`，模型不支持会明确告诉你。
- **切权限模式**：`/模式`。同时写绑定和当前会话。`danger-full-access` 会让微信消息能写整盘，只在完全可信的账号上用。
- **切 Agent 预设**：`/预设`。预设决定这个会话能用哪些工具（文件、终端、技能）。
  **预设是会话创建时固定的**，所以切换会新开一个会话，旧会话在网页端仍可打开。
- **计划模式**：`/计划`，或 `/计划 off` 关闭。
- **停止 / 重试 / 取回完整输出**：`/停止`、`/重试`、`/日志`。
- **审批**：agent 要执行敏感操作时，微信收到一张卡片：
  `🔐 需要授权 #a1b2` / `工具：pwsh` / `原因：…`，回 `/审批 a1b2 允许` 或 `/审批 a1b2 拒绝`。
  编号是 4 位十六进制，卡片上原样给出。超时（默认 300 秒）按拒绝处理，agent 会被告知被拒。
- **提问**：agent 调 `ask_user_question` 时，微信收到 `❓ 需要你的回答 #c3d4` 卡片，
  每题给编号选项（多选会标「可多选：回复 1,3」）。回 `/回答 c3d4 1`，多选写 `1,3`，
  多个问题用 `;` 分隔（`/回答 c3d4 1; 2`）。超时按「跳过」处理。
  同时通道在系统提示里要求模型**尽量不要用它**（它在网页端会阻塞等回答），
  需要决策时把选项写进正文一次问清；真调了也有卡片兜底。

## 6. 回复怎么呈现

微信不能编辑已发出的消息，所以这里不做"流式打字"，而是**少量节流的进度消息 + 一张最终结果卡**。

### 6.1 回复粒度

`/回复` 或 `reply.granularity` 三档：

| 档位 | 行为 |
|---|---|
| `summary` 摘要 | 只发结果卡，摘要截断到 1200 字 |
| `standard` 标准（默认） | 只发结果卡，摘要不截断；工具调用默认静默 |
| `full` 完整 | 先按 `progressIntervalMs` 推节流文本增量，再发结果卡（只补未发出的尾巴，不重复） |

结果卡形如：

```
✅ 完成

<摘要>

⏱ 12.4s · 🔢 12034 in / 3210 out · 🧠 magpie/trae-cn/deepseek-v4.1-flash-max
```

状态词与图标：✅ 完成 · ❌ 失败 · ⏹️ 已取消 · ⚠️ 输出达到上限 / 被中断 · ⏳ 被阻塞。

### 6.2 Markdown 降级

微信气泡不渲染 Markdown，所以发送前统一降级（`lib/render.js`）：

| Markdown | 微信里 |
|---|---|
| `# 标题` / `## 标题` | `【标题】` |
| `### 标题` | `『标题』` |
| `#### 及更深` | `〔标题〕` |
| `**粗体**` | `「粗体」` |
| `*斜体*` | `/斜体/` |
| `~~删除线~~` | 去掉标记，保留文字 |
| `\`行内代码\`` | 内容原样（去掉反引号） |
| `[文字](url)` | `文字 (url)` |
| 表格行 | `a \| b \| c` |
| 代码围栏 | 原样保留（字节不动） |
| 单个换行 | 变成空行分段（微信把单换行画成空格） |

**下划线不当强调**：`prd_code`、`model_flag` 这类标识符会原样保留，不会被吃成 `prdcode`。

### 6.3 长回答

- 结果卡不截断：摘要原样发出（只有 `summary` 档才截到 1200 字）。
- 超过 `reply.maxChunkChars`（默认 2000 字）时按行、其次按代码围栏切成多条发送，不切代理对（emoji 不会碎）。
- `/日志` 取回完整输出，不做任何裁剪。
- 微信本身没有消息编辑能力，所以"完整"仍然是多条消息，不是一条被不断刷新的消息。

### 6.4 正在输入

整轮显示"正在输入…"，实现上有三个坑（都在 v1 里处理了）：

1. 线上字段是 `{ ilink_user_id, status, typing_ticket }`，不是 `to_user_id` / `typing_status`。
   写错字段 HTTP 照样 200，但指示器永不出现，且没有错误日志。
2. `status: 1` 几秒后自动过期，需要按 `typingIntervalMs`（默认 4000ms）续期。
3. `typing_ticket` 约 12 小时轮换一次；被拒就立刻丢弃并重取，不能永久缓存。

`/诊断` 里有一行「正在输入」专门显示这套机制当前的状态。

## 7. 媒体双向

### 7.1 入站（微信 → agent）

- 图片/文件落到 `<工作区>/inbox/<ISO时间戳>-<chat尾6>-<净化后文件名>`，
  提示词里给 agent 真实绝对路径，agent 用自己的文件工具读。
- 三条硬规则：
  1. **授权在下载之前** —— 未授权的聊天不会触发任何下载。
  2. **带附件的一律当任务**，不是命令（`/状态` + 一张图 = 任务）。
  3. **引用标题会带进提示词**（`【引用】...`），因为标题在 `MessageItem` 层级而不是在附件项里。
- 语音：没有转写文本的语音直接拒绝并说明原因（SILK 格式无法解码），不下载。
- 大小上限 `media.maxBytes`（默认 20MB），在解密之前校验。

### 7.2 出站（agent → 微信）

agent 可以用 `weixin_send` 工具发图/文件：

```jsonc
{ "to": "wxid_xxx 或 all", "text": "说明文字", "file": "D:/tmp/report.png" }
```

- `to` 省略时优先发给**触发本次会话所属的聊天**；找不到归属（例如在网页端直接调用）就退化为广播给所有已绑定聊天。
  显式写 `all` 也是广播 —— 文本只发一次，**文件会按聊天逐个上传**（每次上传都是一次独立的 CDN 调用）。
- `text` 在有 `file` 时作为说明文字（先发文本，再发文件）。
- 上传流程四步：算 `rawsize/rawfilemd5/filesize` → `getuploadurl`（`media_type` 1图/2视频/3文件/4语音，
  `no_need_thumb`）→ CDN POST **原始密文**（`application/octet-stream`，否则 400 `-5104001`）→
  读响应头 `x-encrypted-param` 作为发送参数。加密是 AES-128-ECB，`aes_key` 用 `base64(32位hex)`。

## 8. 会话模型

```
微信聊天 (chatId)
  └─ binding
       ├─ activeWorkspace          ← 当前工作区
       ├─ model / permissionPreset / agentPreset / planMode / replyGranularity
       └─ sessions { 工作区路径 → sessionId }
            ├─ D:/repo/a  → session-<chat尾24>-<path尾24>
            └─ D:/repo/b  → session-<chat尾24>-<path尾24>
```

- **每个（聊天 × 工作区）一个会话**。会话 header 里的 `cwd` 不可变，所以切工作区不能"重指"同一个会话，
  只能换一个；换回来时按映射接回原来的会话。
- 会话 id 是确定性的：`session-<chatId尾24>-<工作区路径尾24>`。确定性 id 可能已经被占用
  （会话日志比 `bindings.json` 活得久），所以创建前会先 `sessionPersistence.stat` 探测，能 resume 就接回，
  真撞车才换 `session-<uuid>`。
- **归档门**：会话被归档后，回合路径上的 `agent/pre-step` 会拒绝执行。通道在派活前 `liftArchive` 自动解档，
  否则微信端整轮只会回「⏳ 被阻塞」。
- **侧栏标记**：网页端会话列表里，微信会话前面有绿色微信图标。客户端只拿到 `sessionId`，
  所以按帧合批问一次 loopback 接口 `?action=sessions.wechat`，答案按 id 合并缓存；失败就静默不显示。

## 9. 设置面板

设置 → **微信 Bot 通道**（`order: 25`，在「Agent 预设」和「宠物」之间）。五张卡片：

| 卡片 | 内容 |
|---|---|
| **连接** | 状态徽标 + 账号（打码）、重新连接、生成二维码 / 取消、配对数字输入 |
| **授权** | 允许列表（加 id / 移除）、待信任列表（一键信任）、用户 id 打码显示（前 6 … 后 4） |
| **默认值** | 默认工作区、默认模型、默认权限模式、默认 Agent 预设；有目录时给选择器，没有就给自由文本；留空 = 跟随部署默认 |
| **聊天** | 每个聊天的当前工作区、模型、会话、状态标签（已静音 · 计划模式 · 会话 N · 回复档位）、最后活跃时间、静音开关、解绑；顶部有「挂回工作区」批量修复 |
| **诊断** | 网络诊断按钮、最近错误、工作区/模型数量、`notifystart` 往返毫秒、`baseUrl`、fetch 来源、代理变量（凭据已打码） |

样式全部走主题变量（`--dsw-alias-bg-layer-1`、`--dsw-alias-border-l2`、`--dsw-alias-label-*`、
`--dsw-alias-button-primary-fill` + `--dsw-alias-label-primary-inverted`），深色/浅色都跟主题走。
唯一的字面色是二维码的白底 —— 二维码需要静默区，跟主题无关。

## 10. 配置参考

全部有默认值，只需要写要改的项。挂在 profile 的 `cordis.patch.yml`（或 `--patch` 覆盖层）里：

```yaml
- id: weixin-channel
  name: '@weiln09/dsh-weixin-channel'
  config:
    defaults:
      workspace: D:/repo/my-project
      model: { provider: magpie, model: trae-cn/deepseek-v4.1-flash-max }
      permissionPreset: workspace-write
      agentPreset: standard
    allowedWorkspaces: [D:/repo/my-project, D:/repo/other]
    allowedModels: [magpie/trae-cn/deepseek-v4.1-flash-max]
    security:
      admins: [wxid_yourself]
      trustFirstContact: false
    reply:
      granularity: standard
      maxChunkChars: 2000
```

| 键 | 默认 | 说明 |
|---|---|---|
| `enabled` | `true` | 关掉后通道不启动（面板仍在） |
| `stateDir` | `''` | 状态目录；空 = `$DSH_HOME/integrations/dsh-weixin-channel` |
| `account.botId` | `''` | Bot id（扫码后自动写入） |
| `account.accountId` | `''` | 账号 id（扫码后自动写入） |
| `account.tokenRef` | `env:WEIXIN_BOT_TOKEN` | token 来源；`env:NAME` 读环境变量，否则用 `account.json` 里的 token |
| `account.ownerUserId` | `''` | 扫码人；自动信任 |
| `account.baseUrl` | `https://ilinkai.weixin.qq.com/` | 必须 `https` + `*.weixin.qq.com` |
| `defaults.workspace` | `''` | 新聊天默认工作区；空 = 进程 cwd |
| `defaults.model` | `{provider,model,reasoningEffort}` 全空 | 新聊天默认模型 |
| `defaults.permissionPreset` | `''` | 新聊天默认权限模式 |
| `defaults.agentPreset` | `''` | 新聊天默认 Agent 预设 |
| `allowedWorkspaces` | `[]` | 只允许这些工作区（空 = 不限制） |
| `allowedModels` | `[]` | 只允许这些模型，格式 `provider/model`（空 = 不限制） |
| `reply.granularity` | `standard` | `summary` / `standard` / `full` |
| `reply.progressIntervalMs` | `4000` | `full` 档进度消息的最小间隔 |
| `reply.maxChunkChars` | `2000` | 单条消息上限，超出拆多条 |
| `reply.toolProgress` | `false` | 是否把工具调用行推到微信 |
| `reply.typingIntervalMs` | `4000` | "正在输入"续期间隔 |
| `security.allowlist` | `[]` | 预置允许的聊天/用户 id |
| `security.admins` | `[]` | 可用 `/信任`、`/撤销` 的账号 |
| `security.trustFirstContact` | `false` | 第一个联系人自动信任 |
| `approvals.enabled` | `true` | 审批请求是否推微信 |
| `approvals.timeoutSec` | `300` | 审批超时（按拒绝处理） |
| `questions.enabled` | `true` | 提问卡片是否推微信 |
| `questions.timeoutSec` | `300` | 提问超时（按跳过处理） |
| `turn.timeoutMs` | `900000` | 单轮上限（15 分钟） |
| `turn.sendIntervalMs` | `2000` | 出站消息最小间隔（限速） |
| `turn.queueMax` | `5` | 每个聊天的排队上限，超出直接回"忙" |
| `media.maxBytes` | `20971520` | 双向媒体上限（20MB） |
| `features.planMode` | `true` | 是否允许 `/计划` |
| `features.agentPreset` | `true` | 是否允许 `/预设` |
| `debug` | `false` | 打调试日志 |

> 面板「默认值」保存的值写进 `defaults.json`，**优先于** `config.defaults`。想用配置文件统一管理，
> 就别在面板里点保存。

## 11. 状态目录

默认 `$DSH_HOME/integrations/dsh-weixin-channel/`（`stateDir` 可改）：

| 文件 | 内容 | 权限 |
|---|---|---|
| `account.json` | token、botId、accountId、ownerUserId、baseUrl | `0600` |
| `bindings.json` | 每个聊天的绑定（工作区、模型、会话映射、偏好）+ 允许列表 + 待信任 | `0600` |
| `cursor.json` | 长轮询游标 | `0600` |
| `seen.json` | 消息去重窗口（1000 条，1 秒 debounce 落盘） | `0600` |
| `defaults.json` | 面板保存的默认值 | `0600` |

所有写入都是 `tmp + rename` 原子替换，进程内串行化，读侧永远看到完整文件。
去重窗口单独成文件，是为了不把高频写的消息 id 混进低频的绑定数据；如果发现早期构建把窗口留在 `bindings.json` 里，启动时会自动接过来。

## 12. 安全模型

| 面 | 处理 |
|---|---|
| 谁能用 | 默认 deny-all；允许列表 + 待信任；扫码人自动信任 |
| token | 只在进程内使用，只以 `Authorization: Bearer` 发给 `*.weixin.qq.com`；不进浏览器、不进日志、不进 URL |
| 端点 | 每次请求前都校验 `baseUrl`：必须 `https`、主机名是 `weixin.qq.com` 或其子域、端口 443，否则直接抛 `untrusted-base-url`，token 不会被附上 |
| 面板路由 | 挂在 DSH 的 `webServer` 上（默认只监听 loopback）；返回字段白名单，token 永远不返回；`GET` 只允许 `status`/`sessions.wechat` 两个只读 action；写操作必须 `POST` + `application/json`（强制 CORS 预检，而本服务从不响应预检）；`Origin` 与 `Host` 不一致直接 403 |
| 权限 | `danger-full-access` 需显式配置；默认跟随部署预设 |
| 去重 | 消息 id LRU 1000，防重放 |
| 回合 | 单轮 15 分钟上限，每聊天排队上限 5 |
| 会话 | 只接管本通道绑定的会话，不会应答网页端会话的审批/提问 |
| 审计 | `[audit]` JSON 行见下 |

审计事件（`kind`）：`media/inbound`、`trust/owner`、`trust/first-contact`、`trust/add`、`trust/revoke`、
`send-failed`、`send-media-failed`、`preset/select`、`preset/fallback`、`preset/mount`、`preset/mount-failed`、
`preset/switch`、`session/resume-failed`、`session/adopt`、`session/adopt-failed`、`session/unarchive`、
`session/unarchive-failed`、`session/id-collision`、`session/create`、`workspace/attach`、
`workspace/attach-failed`、`workspace/switch`、`chat/mute`、`approval`、`question`。

## 13. 给其它插件和 agent 的接口

**服务** `ctx.weixinChannel`（`ctx.provide('weixinChannel', …)`）：

| 成员 | 签名 | 说明 |
|---|---|---|
| `push` | `(to, text) => Promise<{sent, failed}>` | `to` 是聊天 id；`'all'` 广播给所有已绑定聊天 |
| `sendAll` | `(text) => Promise<{sent, failed}>` | 等价于 `push('all', text)` |
| `status` | `() => object` | 面板 `status` action 的同一份快照（不含 token） |
| `bindings` | `() => object[]` | 每个聊天的脱敏视图（`publicBinding`） |
| `sessions` | `(ids: string[]) => string[]` | 从给定 id 里挑出属于本通道的会话（侧栏标记用） |

**工具** `weixin_send`：见 §7.2，agent 自己就能往微信推文本、图片和文件。
因为它是注册在 `tools` 上的普通工具，定时任务和目标（goal）里也能直接调用。

**事件** `weixin/turn-end`：`{ chatId, sessionId, status }`，每个回合结束由 `notify.finish()` 发出。

## 14. 故障排查

| 症状 | 多半是 | 怎么办 |
|---|---|---|
| 设置里找不到「微信 Bot 通道」 | 插件没进 `dsh.profile.bundles`，或没重启 | 检查 profile 的 `package.json`，重启 DSH |
| 二维码不出现 | `bind.begin` 失败（网络/代理/端点不合法） | 看面板「最近错误」；确认 `baseUrl` 是 `https://*.weixin.qq.com` |
| 扫码后手机显示数字，但没连上 | 需要把配对数字填回卡片（`need_verifycode`） | 在二维码卡片里输入数字并提交 |
| 发消息完全没反应 | token 缺失 / 未授权 / `notifystart` 失败 | 发 `/诊断` 看 Token、通道状态、最近错误 |
| 陌生人能发进来但 agent 没反应 | 正常，进的是「待信任」 | 面板授权，或 `/信任 <id>` |
| "正在输入…" 不显示 | `sendtyping` 字段写错 / ticket 过期 | `/诊断` 的「正在输入」行会说明是哪一层 |
| 整轮只回「⏳ 被阻塞」 | 会话被归档，回合路径被 `agent/pre-step` 拒绝 | `/新建`；或看 `[audit]` 的 `session/unarchive` |
| 回「处理失败：session already exists」 | 确定性会话 id 被占用 | 通道会先探测再 resume，真撞车会换 uuid；连续出现说明状态目录被手动改过 |
| 网页端显示「未分组」 | 会话没挂到 `workspaceRegistry` | 面板「挂回工作区」，或重启通道（启动时自检） |
| agent 什么工具都用不了 | 预设没挂载 | `/预设` 选一个；预设失效会回退默认并打 `preset/fallback` |
| 长回答被截断 | 档位是 `summary`，或 `maxChunkChars` 太小 | `/回复` 改成标准/完整；调大 `reply.maxChunkChars` |
| 发图 400 `-5104001` | CDN 上传体不是原始密文 | 上传必须 `application/octet-stream`，不能带 multipart |
| 提问卡片只能超时 | 没在 300 秒内回 `/回答` | 回 `/回答 <编号> <选项>`；发 `/回答` 不带参数可看待回答列表 |

诊断信息永远从 `/诊断` 开始：它一次给出通道状态、账号（打码）、token、游标、绑定数、待审批、待回答、
正在输入状态、票据缓存、最近错误。

## 15. 已知限制（v1）

- **仅私聊**，不支持群聊。
- **一个 Bot 账号**，同一个账号不要在两台机器上同时跑。
- **语音出站未实现**；没有转写文本的语音也读不了（SILK）。
- **无缩略图**：上传用 `no_need_thumb: true`，视频在聊天列表里没有封面。
- **切预设要新开会话**（预设是会话创建时固定的）。
- **"完整"仍是多条消息**（微信没有编辑已发消息的能力）。
- **群聊 / 多账号 / 语音** 留给 v2。

## 16. 开发与测试

```sh
npm test          # 仓库根，两个插件一起跑
node --test       # 只跑本插件（在 plugins/dsh-weixin-channel 下）
```

当前：仓库根 **213 项全过**，本插件 **193 项全过**。

| 测试文件 | 项数 | 覆盖 |
|---|---|---|
| `commands.test.js` | 13 | 解析、别名、编号选择、TTL、`0` 取消、管理员命令集 |
| `render.test.js` | 28 | Markdown 降级、切块、代理对、结果卡、状态卡 |
| `store.test.js` | 14 | 原子写、`0600`、损坏回退、绑定模型、去重窗口、重启保持 |
| `ilink.test.js` | 11 | 假 iLink 服务器：QR、token 只走 header、超时即空批、拒发 |
| `bind.test.js` | 6 | 扫码状态机、`onBound` 交接、游标 |
| `session.test.js` | 33 | 跨工作区/预设的会话路由、确定性 id 被占、绑定丢失、归档门 |
| `bridges.test.js` | 21 | 审批与提问桥、超时 fail-closed、只接管本通道会话 |
| `media.test.js` | 16 | AES 三种编码、四步 CDN 上传、`x-encrypted-param`、文件名净化 |
| `entry.test.js` | 35 | 入站交接、每聊队列上限、有界回放缓存、代理凭据脱敏、面板路由护栏 |
| `routes.test.js` | 10 | GET 只读、POST 必须 JSON、跨站拒绝、字段白名单 |
| `client.test.js` | 6 | 双语字典键集一致、面板 API 调用形状 |

真机验证过的路径：bundle 装成 `applied`；面板路由返回 `200` 和完整工作区/模型目录；
`bind.begin` 返回可扫码 PNG；设置页注册进 Settings 导航（`order: 25`）。

## 17. 版本与兼容

| 项 | 值 |
|---|---|
| 插件版本 | `0.1.1`（= v1） |
| npm | [`@weiln09/dsh-weixin-channel`](https://www.npmjs.com/package/@weiln09/dsh-weixin-channel) |
| DSH | `>=0.2.2-0 <0.3.0` |
| Node | `>=22` |
| peer | `@deepseek-ai/cordis`（optional）、`@deepseek-ai/schemastery` |
| 依赖 | `qrcode`（生成二维码） |
| 需要 | Web/Desktop 预设（设置面板依赖 `dsh-client-ui-slots`） |

## 18. License

MIT © weiln09
