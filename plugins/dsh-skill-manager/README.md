# dsh-skill-manager

English | [中文](README.zh-CN.md)

A DSH plugin that manages every skill dsh can see, from one Web sidebar panel.

It merges the skills from all sources into a single catalog — bundled/runtime providers, the standard on-disk skill roots (including a project's `.dsh/skills`), and its own writable managed library — and lets you create, import, edit, delete, enable/disable, and **scope each skill to global or to specific workspaces**.

## Highlights

### 🎯 Control each skill's scope — the core feature

Every managed skill carries its own **scope**, so the right skills show up for the right work and nowhere else:

- **Global** (default) — the skill is offered to **every** workspace/session.
- **Workspaces** — the skill is offered **only** when the current session's working directory lies **inside one of the workspace paths you pick** (a workspace and everything under it). Anywhere else, it is hidden from agents.

Switch a skill between the two at any time from the panel (or via the `skill_manager` tool's `setScope`). A `workspaces` scope with no path selected falls back to global. This keeps a project-specific workflow from polluting unrelated projects, while shared utilities stay available everywhere.

### Other features

- **One catalog** — the panel lists every skill from bundled providers, the standard skill roots, and the managed library, with a source badge on each card.
- **Create & edit** — author a skill's `SKILL.md` (front matter + body) directly in the panel.
- **Import** — from a **.zip** (file picker, uploaded and unpacked) or from **GitHub** (`owner/repo`, optional branch/tag/commit and subdirectory).
- **Update from GitHub** — re-pull a skill that was imported from a GitHub source.
- **Enable / disable** — a disabled skill simply stops being offered to agents.
- **Adopt** — take over an existing on-disk skill so it becomes managed.
- **Agent tool** — the same operations are exposed to the agent as the `skill_manager` tool.

Skills managed by this plugin live under `<DSH_HOME>/skills-manager/<name>/SKILL.md`, with per-skill source, scope and enabled state in `state.json`. Skills governed to be read-only (bundled or provided at runtime) can still be browsed and adopted.

## Install

Pick whichever fits your setup:

- **From the Web UI** — open the sidebar **Plugins** page and install the bundle.
- **With the agent / CLI**:

  ```sh
  dsh plugin --profile <profile> add @weiln09/dsh-skill-manager
  ```

  or use the `plugin_manager` tool with `action: install_bundle` and this package as the target.

After installation, the Skill Manager appears in the Web sidebar and its `skill_manager` tool becomes available to agents.

## Requirements

- DSH `>=0.2.2 <0.3.0` (declared in `engines.dsh`).
- The Web preset (the panel is a Web UI slot; the Host side works in any profile with the `skills`, `webServer`, and `tools` services).

## License

MIT © weiln09
