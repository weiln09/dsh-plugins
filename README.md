# dsh-plugins

给 [DeepSeek Harness](https://github.com/deepseek-ai)（DSH）写的插件集合。每个插件是一个可以单独安装的包，自带 `cordis.patch.yml` 与 Web 面板。

**v1** · Node `>=22` · DSH `>=0.2.2-0 <0.3.0`

---

## 插件

| 插件 | 版本 | 状态 | 一句话 |
|---|---|---|---|
| [`dsh-weixin-channel`](plugins/dsh-weixin-channel) | `0.1.1` | 已发布 npm | 把 DSH 接进微信：**每个聊天**独立工作区、模型、会话，全部用中文命令在微信里操作。 |
| [`dsh-skill-manager`](plugins/dsh-skill-manager) | `1.0.1` | 已发布 npm | 在 Web 面板里统一管理所有技能：新建/导入/编辑/启停，并把**每个技能的作用范围**设为全局或指定工作区。 |

### dsh-weixin-channel

扫码绑定一个微信 Bot 账号后，你在微信里私聊它，它就是一个跑在你自己机器上的编码 agent：
能读文件、跑命令、用技能、连远程机器，结果以纯文本气泡回到微信。

和「把网页聊天转发到微信」的桥不同，它的偏好挂在**聊天**上而不是插件配置上：

- `/项目` 切工作区 —— 每个（聊天 × 工作区）一份独立会话，切回来接着聊；
- `/模型` 切模型 —— 当前会话就地生效，历史保留；
- `/思考`、`/模式`、`/预设`、`/计划`、`/回复` 都是聊天级；
- 22 条命令，每条有中文 / 英文 / 短写三种写法（`/模型` = `/model` = `/m`）；
- 审批与提问推到微信，用 `/审批`、`/回答` 处理，超时 fail-closed；
- 图片/文件双向：入站落到工作区 `inbox/`，出站走 `weixin_send` 工具。

完整文档（安装、命令表、配置项、状态目录、安全模型、故障排查、已知限制）见
[**plugins/dsh-weixin-channel/README.md**](plugins/dsh-weixin-channel/README.md)；
设计决策与踩坑记录见 [docs/design.md](plugins/dsh-weixin-channel/docs/design.md)。

### dsh-skill-manager

把来自所有来源的技能（内置 provider、标准磁盘技能目录、项目 `.dsh/skills`、插件托管库）
合并成一份统一目录，每张卡片带来源徽章。支持从 zip / GitHub 导入并再次更新，
编辑不会丢失来源（GitHub 导入的技能仍可更新）。

技能落盘在 `<DSH_HOME>/skills-manager/<name>/SKILL.md`，来源/范围/启用状态在 `state.json`。

文档：[English](plugins/dsh-skill-manager/README.md) · [中文](plugins/dsh-skill-manager/README.zh-CN.md)

## 环境要求

| 项 | 要求 | 说明 |
|---|---|---|
| Node | `>=22` | 两个插件都用原生 `node --test`，没有构建步骤 |
| DSH | `>=0.2.2-0 <0.3.0` | 两个插件都在 `engines.dsh` 里声明 |
| 预设 | Web 或 Desktop | 两个插件的面板都是 Web UI slot |

## 安装

`dsh plugin` 只是把参数原样转发给 profile 目录里的 pnpm：

```sh
# 已发布到 npm 的插件
dsh plugin --profile desktop add @weiln09/dsh-skill-manager

# dsh-weixin-channel
dsh plugin --profile desktop add @weiln09/dsh-weixin-channel

# 改代码时用本地 checkout（link 安装，改动即时生效）
dsh plugin --profile desktop add link:D:/path/to/dsh-plugins/plugins/dsh-weixin-channel
```

装完确认 `$DSH_HOME/profiles/<profile>/package.json` 的 `dependencies` 里有这个包，
**并且** `dsh.profile.bundles` 数组里也有它 —— 只在 dependencies 里不会加载。然后重启 DSH。

## 仓库布局

```
plugins/
  dsh-weixin-channel/      微信（iLink）通道插件
    lib/                   host 侧：入口、iLink 协议、会话路由、渲染、媒体、存储
    client/client.js       Web 面板（手写 ModuleLoader，无构建步骤）
    docs/design.md         设计决策、状态模型、踩坑记录
    test/                  11 个测试文件
  dsh-skill-manager/       技能管理插件
    lib/                   host 侧：入口、路由、技能库
    lib/client.js          Web 面板
    test/                  2 个测试文件
submission/                提交到插件市场的 PR 正文与条目
docs/                      调研笔记（不进版本库）
```

每个插件自带 `cordis.patch.yml`，安装后由 DSH 的 bundle 机制插进插件树；
根 `package.json` 是 private 的 workspace 根，不发布。

## 开发与测试

```sh
npm install          # 根目录，装 workspace 依赖
npm test             # 两个插件一起跑
```

当前 **213 项全过**（weixin-channel 193 + skill-manager 20）。只跑一个插件：

```sh
cd plugins/dsh-weixin-channel && node --test
```

| 包 | 测试数 | 覆盖重点 |
|---|---|---|
| `dsh-weixin-channel` | 193 | 命令解析与别名、Markdown 降级与切块、原子存储与去重窗口、iLink 假服务器、扫码状态机、跨工作区/预设的会话路由、审批与提问桥、媒体双向（AES/CDN）、面板路由护栏、客户端字典与主题 token |
| `dsh-skill-manager` | 20 | 托管库增删改与启停/范围、编辑保留来源、名称校验、工作区范围匹配、`SKILL.md` 缓存、路由安全护栏 |

两个插件的面板路由都遵循同一套约定：默认 loopback-only，GET 只做只读 action，
所有写操作必须 `POST` + `application/json`，`Origin` 与 `Host` 不一致一律拒绝。

## 版本与兼容

| 插件 | 版本 | npm | 文档 |
|---|---|---|---|
| `dsh-weixin-channel` | `0.1.1`（v1） | [`@weiln09/dsh-weixin-channel`](https://www.npmjs.com/package/@weiln09/dsh-weixin-channel) | [README](plugins/dsh-weixin-channel/README.md) |
| `dsh-skill-manager` | `1.0.1` | [`@weiln09/dsh-skill-manager`](https://www.npmjs.com/package/@weiln09/dsh-skill-manager) | [EN](plugins/dsh-skill-manager/README.md) · [中文](plugins/dsh-skill-manager/README.zh-CN.md) |

插件与 DSH 是紧耦合的（用到 `agents`、`tools`、`webServer`、`workspaceRegistry`、
`sessionPersistence`、`agentPresets` 等服务），所以 `engines.dsh` 锁在 `0.2.x`；
DSH 升到 0.3 时需要跟着适配。

## 许可证

MIT © weiln09

