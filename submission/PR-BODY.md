# Add plugin: weiln09/dsh-plugins#dsh-skill-manager

Adds one entry: **dsh-skill-manager** — a skill manager for DSH.

- **Entry file:** `data/plugins/weiln09__dsh-plugins--plugins-dsh-skill-manager.yml`
- **Category:** `skill`
- **Repo:** https://github.com/weiln09/dsh-plugins/tree/main/plugins/dsh-skill-manager (monorepo subpackage)
- **Installable bundle:** the subpackage `package.json` declares `dsh.bundle` (`./cordis.patch.yml`) and `dsh.client` (web platform).
- **npm:** `@weiln09/dsh-skill-manager@1.0.1`

What the plugin does: merges skills from bundled providers, the standard on-disk skill roots, and its own managed library into one catalog, and lets you create / import (zip or GitHub) / edit / delete / enable-disable skills, and **scope each skill to global or to specific workspaces** (a skill is only offered when the session's working directory is inside a chosen workspace path).
