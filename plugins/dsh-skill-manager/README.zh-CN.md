# dsh-skill-manager（中文）

[English](README.md) | 中文

一个 DSH 插件：在 Web 侧栏的一个面板里，管理 dsh 能看到的全部技能。

它把来自所有来源的技能合并成一份统一目录 —— 内置/运行时 provider、标准磁盘技能目录（包括项目的 `.dsh/skills`）、以及它自己可写的托管库 —— 并支持新建、导入、编辑、删除、启用/停用，以及**把每个技能的生效范围设为「全局」或「指定工作区」**。

## 亮点

### 🎯 为每个技能单独调整作用范围 —— 核心功能

每个托管技能都带自己的**作用范围（scope）**，让合适的技能只出现在合适的工作里，别处一概不出现：

- **全局（默认）** —— 该技能对**所有**工作区/会话可见。
- **指定工作区** —— 仅当当前会话的工作目录**位于你所选工作区路径之内**（该工作区及其所有子目录）时才提供该技能；在别处则对 agent 隐藏。

可随时在面板里（或通过 `skill_manager` 工具的 `setScope`）切换两种范围。若选了「指定工作区」但没选任何路径，会回退为全局。这样项目专属的工作流不会污染无关项目，而公用技能则处处可用。

### 其他功能

- **统一目录** —— 面板列出内置 provider、标准技能目录和托管库里的全部技能，每张卡片带来源标识。
- **新建与编辑** —— 直接在面板里编写技能的 `SKILL.md`（front matter + 正文）。
- **导入** —— 从 **.zip**（文件选择器，上传后解包）或从 **GitHub**（`owner/repo`，可选分支/tag/commit 与子目录）导入。
- **从 GitHub 更新** —— 重新拉取从 GitHub 来源导入的技能。
- **启用/停用** —— 停用的技能就不再提供给 agent。
- **接管（Adopt）** —— 把磁盘上已有的技能纳入本插件管理。
- **Agent 工具** —— 同样的操作也以 `skill_manager` 工具的形式提供给 agent。

本插件管理的技能存放于 `<DSH_HOME>/skills-manager/<name>/SKILL.md`，每个技能的来源、作用范围和启用状态记录在 `state.json`。只读的技能（内置或运行时提供）仍可浏览与接管。

## 安装

任选一种：

- **在 Web UI 中** —— 打开侧栏 **Plugins** 页安装该 bundle。
- **用 agent / 命令行**：

  ```sh
  dsh plugin --profile <profile> add @weiln09/dsh-skill-manager
  ```

  或用 `plugin_manager` 工具，`action: install_bundle`，target 填本包名。

安装后，技能管理会出现在 Web 侧栏，其 `skill_manager` 工具也对 agent 可用。

## 要求

- DSH `>=0.2.2 <0.3.0`（在 `engines.dsh` 中声明）。
- Web 预设（面板是一个 Web UI slot；Host 侧在任何具备 `skills`、`webServer`、`tools` 服务的 profile 下都能工作）。

## 许可证

MIT © weiln09
