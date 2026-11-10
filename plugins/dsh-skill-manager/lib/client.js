// @local/dsh-skill-manager — Client half (browser)
//
// Left-rail entry + main panel. The panel shows every skill dsh can see:
// a card grid in the shape of a tool drawer, with an enable switch and a scope
// control on the skills this plugin manages.
//
// Language follows the application: the copy comes from this file's
// dictionaries keyed by the locale snapshot's `active` id, and the panel
// re-renders on every locale change.

window.__ModuleLoader__.load({
  id: '@local/dsh-skill-manager',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const { useState, useEffect, useCallback, useMemo } = React

    const API = '/skill-manager/api'
    const PANEL_ID = 'skill-manager'

    // ---------------------------------------------------------------------
    // Copy. One dictionary per language; `active` from the locale snapshot
    // selects the entry. Unknown keys fall back to English rather than showing
    // the raw key, so a missing translation never breaks the interface.
    // ---------------------------------------------------------------------
    const COPY = {
      en: {
        title: 'Skill manager',
        subtitle: 'Every skill dsh can see, in one place',
        rescan: 'Scan again', scanning: 'Scanning…',
        newSkill: 'New skill', importZip: 'Import zip', importFrom: 'Import from GitHub',
        search: 'Search by name, description, or provider',
        filterAll: 'All', filterEnabled: 'On', filterDisabled: 'Off',
        groupAll: 'All', groupManaged: 'Managed here', groupUser: 'Yours',
        groupProject: 'This project', groupBundled: 'Built in', groupRuntime: 'Runtime',
        groupOther: 'Other',
        countOne: '1 skill', countMany: '{count} skills',
        loading: 'Reading the skill library…',
        errorTitle: 'The skill library could not be read',
        retry: 'Try again',
        emptyTitle: 'Nothing matches',
        emptyBody: 'Clear the search or pick another group.',
        emptyNone: 'No skills are installed yet.',
        emptyNoneBody: 'Create one, import a zip, or pull one from GitHub.',
        enabled: 'On', disabled: 'Off',
        managedHere: 'Managed here', readOnly: 'Read only',
        scopeGlobal: 'Every workspace', scopeSingle: '1 workspace', scopeCountMany: '{count} workspaces',
        view: 'Open', edit: 'Edit', scope: 'Scope', remove: 'Remove', update: 'Update',
        scopeHint: 'Choose which workspaces can use this skill',
        more: 'More actions',
        adopt: 'Manage here',
        adoptAdopting: 'Taking over…',
        adoptHint: 'Copies the folder into this library, so its scope and switch work. The original stays where it is.',
        adoptAll: 'Manage all of mine',
        adoptAllBusy: 'Taking over {done}/{total}…',
        adoptToasted: 'Now managed here',
        adoptAllToasted: '{count} skills now managed here',
        adoptNone: 'Nothing left to take over in this group.',
        adoptSomeFailed: '{ok} taken over, {failed} failed.',
        sourceAdopted: 'Taken over',
        adoptOrigin: 'Copied from',
        confirmRemove: 'Remove "{name}" from Skill Manager? The skill folder is deleted and cannot be restored.',
        save: 'Save changes', cancel: 'Cancel', close: 'Close',
        dialogEdit: 'Edit skill', dialogNew: 'New skill', dialogView: 'Skill contents',
        fieldName: 'Name', fieldNameHint: 'Lowercase letters, digits, and hyphens. Cannot be changed later.',
        fieldDescription: 'Description',
        fieldDescriptionHint: 'What it does and when to use it. Agents read this line first.',
        fieldBody: 'SKILL.md',
        fieldScope: 'Usable in',
        scopeGlobalOption: 'Every workspace',
        scopeOption: 'Only the workspaces I pick',
        fieldWorkspaces: 'Workspaces',
        noWorkspaces: 'No workspaces are registered yet.',
        dialogZip: 'Import a skill from a zip',
        zipFile: 'Zip file',
        zipChoose: 'Choose a zip file',
        zipReplace: 'Choose another zip file',
        zipDropHint: 'or drop it here',
        zipClear: 'Remove the chosen file',
        zipPickFirst: 'Choose a zip file first.',
        zipWrongType: 'That is not a zip file. Pick a .zip archive.',
        zipPathHint: 'The archive needs a SKILL.md, at its root or one folder down.',
        dialogGithub: 'Import a skill from GitHub',
        repo: 'Repository',
        repoHint: 'owner/repo, a repository link, or the link to the skill folder. A folder link fills in the branch and subfolder for you.',
        ref: 'Branch, tag, or commit', refHint: 'Leave empty for the default branch.',
        subdir: 'Subfolder inside the repository', subdirHint: 'Optional, when the skill is not at the top level.',
        actionImport: 'Import', importing: 'Importing…', saving: 'Saving…',
        toastCreated: 'Skill created',
        toastSaved: 'Changes saved',
        toastRemoved: 'Skill removed',
        toastImported: 'Skill imported',
        toastUpdated: 'Updated from GitHub',
        toastScanned: 'Library scanned again',
        toastEnabled: 'Skill turned on',
        toastDisabled: 'Skill turned off',
        toastScope: 'Scope updated',
        errName: 'Give the skill a name.',
        errNameShape: 'Use lowercase letters, digits, and hyphens only.',
        errDescription: 'Add a one-line description.',
        readOnlyNote: 'dsh provides this skill. Open it to read, but its scope and switch are managed elsewhere.',
      },
      zh: {
        title: '技能管理',
        subtitle: 'dsh 能看到的技能，都在这里',
        rescan: '重新扫描', scanning: '扫描中…',
        newSkill: '新建技能', importZip: '导入 zip', importFrom: '从 GitHub 导入',
        search: '按名称、描述或来源搜索',
        filterAll: '全部', filterEnabled: '已开启', filterDisabled: '已关闭',
        groupAll: '全部', groupManaged: '此处管理', groupUser: '我的',
        groupProject: '本项目', groupBundled: '内置', groupRuntime: '运行时',
        groupOther: '其他',
        countOne: '1 个技能', countMany: '{count} 个技能',
        loading: '正在读取技能库…',
        errorTitle: '技能库读取失败',
        retry: '重试',
        emptyTitle: '没有匹配的技能',
        emptyBody: '换个关键词，或选择其他分组。',
        emptyNone: '还没有安装任何技能。',
        emptyNoneBody: '新建一个，导入 zip，或从 GitHub 拉取。',
        enabled: '已开启', disabled: '已关闭',
        managedHere: '此处管理', readOnly: '只读',
        scopeGlobal: '所有工作区', scopeSingle: '1 个工作区', scopeCountMany: '{count} 个工作区',
        view: '打开', edit: '编辑', scope: '范围', remove: '移除', update: '更新',
        scopeHint: '选择哪些工作区可以使用该技能',
        more: '更多操作',
        adopt: '纳入管理',
        adoptAdopting: '正在接管…',
        adoptHint: '把该文件夹复制到技能库里，之后范围与开关才会生效。原目录保持不动。',
        adoptAll: '全部纳入管理',
        adoptAllBusy: '正在接管 {done}/{total}…',
        adoptToasted: '已纳入管理',
        adoptAllToasted: '已将 {count} 个技能纳入管理',
        adoptNone: '该分组下没有可纳入的技能了。',
        adoptSomeFailed: '成功 {ok} 个，失败 {failed} 个。',
        sourceAdopted: '已接管',
        adoptOrigin: '复制自',
        confirmRemove: '确定从技能管理中移除“{name}”？技能目录会被删除且无法恢复。',
        save: '保存', cancel: '取消', close: '关闭',
        dialogEdit: '编辑技能', dialogNew: '新建技能', dialogView: '技能内容',
        fieldName: '名称', fieldNameHint: '仅小写字母、数字和连字符，创建后不可修改。',
        fieldDescription: '描述',
        fieldDescriptionHint: '说明它做什么、什么时候使用。Agent 最先读这一行。',
        fieldBody: 'SKILL.md',
        fieldScope: '可用范围',
        scopeGlobalOption: '所有工作区',
        scopeOption: '仅我选择的工作区',
        fieldWorkspaces: '工作区',
        noWorkspaces: '还没有注册工作区。',
        dialogZip: '从 zip 导入技能',
        zipFile: 'Zip 文件',
        zipChoose: '选择 zip 文件',
        zipReplace: '重新选择 zip 文件',
        zipDropHint: '或拖拽到这里',
        zipClear: '移除已选文件',
        zipPickFirst: '请先选择一个 zip 文件。',
        zipWrongType: '这不是 zip 文件，请选择 .zip 压缩包。',
        zipPathHint: '压缩包内需要有 SKILL.md，在根目录或下一级目录中。',
        dialogGithub: '从 GitHub 导入技能',
        repo: '仓库',
        repoHint: 'owner/repo、仓库链接，或技能所在文件夹的链接。粘贴文件夹链接会自动填好分支和子目录。',
        ref: '分支、标签或提交', refHint: '留空则使用默认分支。',
        subdir: '仓库内的子目录', subdirHint: '可选，技能不在顶层时填写。',
        actionImport: '导入', importing: '正在导入…', saving: '正在保存…',
        toastCreated: '技能已创建',
        toastSaved: '已保存',
        toastRemoved: '技能已移除',
        toastImported: '技能已导入',
        toastUpdated: '已从 GitHub 更新',
        toastScanned: '技能库已重新扫描',
        toastEnabled: '技能已开启',
        toastDisabled: '技能已关闭',
        toastScope: '范围已更新',
        errName: '请填写技能名称。',
        errNameShape: '名称只能包含小写字母、数字和连字符。',
        errDescription: '请填写一行描述。',
        readOnlyNote: '该技能由 dsh 提供。可以打开查看，但范围与开关不在此处管理。',
      },
    }

    function makeT(active) {
      const key = String(active || '').toLowerCase()
      const dict = key.startsWith('zh') ? COPY.zh : COPY.en
      return (name, vars) => {
        let out = dict[name] != null ? dict[name] : (COPY.en[name] != null ? COPY.en[name] : name)
        if (vars) for (const k of Object.keys(vars)) out = out.replace(`{${k}}`, String(vars[k]))
        return out
      }
    }

    // ---------------------------------------------------------------------
    // API
    // ---------------------------------------------------------------------
    async function api(action, payload = {}) {
      const res = await fetch(API, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ action, ...payload }),
      })
      let data
      try { data = await res.json() } catch { data = { ok: false, error: `HTTP ${res.status}` } }
      if (!data || data.ok !== true) throw new Error((data && data.error) || `HTTP ${res.status}`)
      return data
    }

    // ---------------------------------------------------------------------
    // Styles. Tokens are the theme's own aliases so the panel follows light and
    // dark; the few fixed colors are the skill-state signal, kept muted.
    // ---------------------------------------------------------------------
    const CSS = `
.sm2{--sm-ink:var(--dsw-alias-label-primary);--sm-quiet:var(--dsw-alias-label-secondary);--sm-line:var(--dsw-alias-border-l1);--sm-line-strong:var(--dsw-alias-border-l2);--sm-surface:var(--dsw-alias-bg-layer-1);--sm-sunken:var(--dsw-alias-bg-layer-2);/* The accent is pinned rather than borrowed from the theme, because the
   theme's brand color differs in lightness between modes and a shared white
   label would lose contrast in one of them. Light mode takes a deeper teal
   so a white label still clears 4.5:1; dark mode takes the brighter teal
   and flips the label to ink, which is the readable pairing there. */
--sm-accent:#00897a;
--sm-accent-hover:#00776a;
--sm-accent-tint:rgba(0,137,122,.12);
--sm-accent-ink:#ffffff;
--sm-on:var(--dsw-alias-state-success-primary);--sm-off:var(--dsw-alias-state-warn-primary);--sm-danger:var(--dsw-alias-state-error-primary);display:flex;flex-direction:column;height:100%;min-height:0;background:var(--dsw-alias-bg-base);color:var(--sm-ink);font:13px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif;box-sizing:border-box}
@media (prefers-color-scheme:dark){
  .sm2{--sm-accent:#00bba7;--sm-accent-hover:#00a894;--sm-accent-tint:rgba(0,187,167,.16);--sm-accent-ink:#04211e}
}
/* The app can pin light or dark independently of the OS preference. */
[data-theme="dark"] .sm2{--sm-accent:#00bba7;--sm-accent-hover:#00a894;--sm-accent-tint:rgba(0,187,167,.16);--sm-accent-ink:#04211e}
[data-theme="light"] .sm2{--sm-accent:#00897a;--sm-accent-hover:#00776a;--sm-accent-tint:rgba(0,137,122,.12);--sm-accent-ink:#ffffff}
.sm2 *,.sm2 *::before,.sm2 *::after{box-sizing:border-box}
/* Buttons carry their own color; a blanket color:inherit here would out-rank
   the variant classes below and paint dark text on a dark fill. */
.sm2 button{font:inherit;border:0;background:none;cursor:pointer;color:var(--sm-ink)}

.sm2-head{display:flex;align-items:center;gap:12px;padding:16px 22px 12px;flex-wrap:wrap}
.sm2-headtext{min-width:0}
.sm2-title{margin:0;font-size:17px;font-weight:650;letter-spacing:-.01em}
.sm2-sub{margin:3px 0 0;font-size:12.5px;color:var(--sm-quiet)}
.sm2-grow{flex:1}

.sm2 .sm2-btn{display:inline-flex;align-items:center;justify-content:center;gap:6px;height:31px;padding:0 12px;border:1px solid var(--sm-line-strong);border-radius:8px;background:var(--sm-surface);color:var(--sm-ink);font-size:12.5px;line-height:1;white-space:nowrap;transition:border-color .12s ease,background .12s ease}
.sm2 .sm2-btn:hover{border-color:var(--sm-accent)}
.sm2 .sm2-btn:disabled{opacity:.45;cursor:default}
.sm2 .sm2-btn:disabled:hover{border-color:var(--sm-line-strong)}
.sm2 .sm2-btn--primary{background:var(--sm-accent);border-color:var(--sm-accent);color:var(--sm-accent-ink);font-weight:550}
.sm2 .sm2-btn--primary:hover{background:var(--sm-accent-hover);border-color:var(--sm-accent-hover);color:var(--sm-accent-ink)}
.sm2 .sm2-btn--primary:disabled{background:var(--sm-accent);border-color:var(--sm-accent);color:var(--sm-accent-ink);opacity:.45}
.sm2 .sm2-btn--quiet{border-color:transparent;background:transparent;color:var(--sm-quiet)}
.sm2 .sm2-btn--quiet:hover{background:var(--sm-sunken);color:var(--sm-ink);border-color:transparent}
/* Taking a skill over is the one affirmative action on a read-only card, so it
   is tinted rather than quiet. */
.sm2 .sm2-btn--adopt{border-color:color-mix(in srgb,var(--sm-accent) 45%,transparent);background:var(--sm-accent-tint);color:var(--sm-accent);font-weight:550}
.sm2 .sm2-btn--adopt:hover{background:var(--sm-accent);border-color:var(--sm-accent);color:var(--sm-accent-ink)}
.sm2 .sm2-btn--danger{border-color:transparent;background:transparent;color:var(--sm-danger)}
.sm2 .sm2-btn--danger:hover{background:var(--sm-sunken);border-color:var(--sm-danger)}
.sm2 .sm2-btn--sm{height:26px;padding:0 8px;font-size:12px;border-radius:7px}
/* Inside a card the label drops on narrow columns instead of wrapping the row. */
.sm2-cardfoot .sm2-btn--sm{gap:5px}
.sm2-cardfoot .sm2-btn--sm svg{flex:none}

/* The overflow menu. It is a small floating surface, so it gets the same
   border, layer and shadow as every other overlay in the panel, plus a
   hairline above the destructive row so Remove never reads as one of a list. */
.sm2-more{position:relative;display:inline-flex}
.sm2-menu{position:absolute;right:0;bottom:calc(100% + 6px);z-index:20;display:flex;flex-direction:column;min-width:168px;padding:5px;border:1px solid var(--sm-line);border-radius:10px;background:var(--dsw-alias-bg-overlay);box-shadow:0 12px 32px rgba(0,0,0,.22),0 2px 6px rgba(0,0,0,.10)}
.sm2-menuitem{display:flex;align-items:center;gap:9px;width:100%;padding:7px 10px;border-radius:6px;font-size:12.5px;line-height:1.4;text-align:left;color:var(--sm-ink);white-space:nowrap;transition:background .1s ease,color .1s ease}
.sm2-menuitem:hover{background:var(--sm-sunken)}
.sm2-menuitem svg{flex:none;opacity:.75}
.sm2-menuitem:hover svg{opacity:1}
/* The destructive row is separated rather than merely tinted. */
.sm2-menuitem--danger{margin-top:4px;padding-top:8px;border-top:1px solid var(--sm-line);border-radius:0 0 6px 6px;color:var(--sm-danger)}
.sm2-menuitem--danger svg{opacity:.9}
.sm2-menuitem--danger:hover{background:color-mix(in srgb,var(--sm-danger) 12%,transparent)}
.sm2-menu-sep{height:1px;margin:4px 2px;background:var(--sm-line)}
.sm2 :focus-visible{outline:2px solid var(--sm-accent);outline-offset:2px}

.sm2-searchrow{display:flex;align-items:center;gap:10px;padding:0 22px 12px}
.sm2-search{flex:0 1 380px;min-width:160px;height:33px;padding:0 12px;border:1px solid var(--sm-line-strong);border-radius:8px;background:var(--sm-surface);color:var(--sm-ink);font-size:13px}
.sm2-search::placeholder{color:var(--sm-quiet)}
.sm2-search:focus{border-color:var(--sm-accent);outline:none}
.sm2-count{font-size:12px;color:var(--sm-quiet);font-variant-numeric:tabular-nums;white-space:nowrap}

.sm2-groups{display:flex;align-items:center;gap:2px;padding:0 22px;border-bottom:1px solid var(--sm-line);overflow-x:auto;flex-wrap:nowrap}
.sm2-group{position:relative;border:0;background:none;padding:9px 11px 10px;font-size:12.5px;color:var(--sm-quiet);cursor:pointer;white-space:nowrap;border-radius:6px 6px 0 0}
.sm2-group:hover{color:var(--sm-ink);background:var(--sm-sunken)}
.sm2-group[aria-selected="true"]{color:var(--sm-ink);font-weight:600}
.sm2-group[aria-selected="true"]::after{content:"";position:absolute;left:8px;right:8px;bottom:-1px;height:2px;background:var(--sm-accent);border-radius:2px}
.sm2-group-n{margin-left:5px;font-size:11px;color:var(--sm-quiet);font-variant-numeric:tabular-nums}
.sm2-group--action{display:inline-flex;align-items:center;gap:5px;margin:0 0 4px;padding:5px 9px;border-radius:6px;color:var(--sm-accent);font-weight:550}
.sm2-group--action:hover{background:var(--sm-accent-tint);color:var(--sm-accent)}
.sm2-group--action:disabled{opacity:.6;cursor:default}
.sm2-group--action::after{display:none}
.sm2-group[aria-selected="true"] .sm2-group-n{color:var(--sm-accent)}

.sm2-body{flex:1;min-height:0;overflow:auto;padding:16px 22px 28px}
.sm2-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(320px,1fr));gap:10px;align-items:stretch}

.sm2-card{position:relative;display:flex;flex-direction:column;gap:8px;padding:13px 14px 9px 16px;border:1px solid var(--sm-line);border-radius:10px;background:var(--sm-surface);transition:border-color .12s ease}
.sm2-card:hover{border-color:var(--sm-line-strong)}
.sm2-card:not([data-state="on"]):not([data-state="off"]) .sm2-cardfoot{border-top-color:transparent;padding-top:2px;margin-top:0}
.sm2-card:not([data-state="on"]):not([data-state="off"]) .sm2-meta{margin-top:auto}
.sm2-card::before{content:"";position:absolute;left:0;top:12px;bottom:12px;width:3px;border-radius:0 3px 3px 0;background:transparent}
.sm2-card[data-state="on"]::before{background:var(--sm-on)}
.sm2-card[data-state="off"]::before{background:var(--sm-off)}
.sm2-card[data-state="off"] .sm2-name,.sm2-card[data-state="off"] .sm2-desc{opacity:.55}

.sm2-cardtop{display:flex;align-items:center;gap:8px;min-width:0}
.sm2-name{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:13px;font-weight:600;letter-spacing:-.01em;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.sm2-desc{margin:0;font-size:12.5px;line-height:1.5;color:var(--sm-quiet);display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;height:3em;flex:none}
.sm2-meta{display:flex;align-items:center;gap:6px;flex-wrap:wrap;font-size:11px}
.sm2-tag{display:inline-flex;align-items:center;gap:4px;height:20px;padding:0 7px;border-radius:5px;background:var(--sm-sunken);color:var(--sm-quiet);white-space:nowrap}
.sm2-tag--scope{background:transparent;border:1px solid var(--sm-line);}
.sm2-tag--here{background:transparent;border:1px solid var(--sm-accent);color:var(--sm-accent)}
.sm2-tag--off{color:var(--sm-off);border:1px solid var(--sm-off);background:transparent}

.sm2-cardfoot{display:flex;align-items:center;gap:1px;margin-top:auto;padding-top:7px;border-top:1px solid var(--sm-line)}
@media (max-width:560px){.sm2-cardfoot{flex-wrap:wrap;gap:3px}}
.sm2-cardfoot .sm2-grow{flex:1}

.sm2-switch{display:inline-flex;align-items:center;gap:7px;border:0;background:none;padding:2px 4px 2px 2px;cursor:pointer;border-radius:6px;font-size:11.5px;color:var(--sm-quiet)}
.sm2-switch:hover{background:var(--sm-sunken)}
.sm2-switch:disabled{cursor:default;opacity:.45}
.sm2-switch:disabled:hover{background:none}
.sm2-track{position:relative;width:26px;height:15px;border-radius:9px;background:var(--sm-line-strong);transition:background .14s ease;flex:none}
.sm2-track::after{content:"";position:absolute;top:2px;left:2px;width:11px;height:11px;border-radius:50%;background:#fff;transition:transform .14s ease}
.sm2-switch[aria-checked="true"] .sm2-track{background:var(--sm-on)}
.sm2-switch[aria-checked="true"] .sm2-track::after{transform:translateX(11px)}
.sm2-switch[aria-checked="true"]{color:var(--sm-on)}

.sm2-state{padding:64px 20px;text-align:center;color:var(--sm-quiet)}
.sm2-state h4{margin:0 0 6px;font-size:14px;font-weight:600;color:var(--sm-ink)}
.sm2-state p{margin:0;font-size:12.5px}
.sm2-banner{display:flex;align-items:center;gap:10px;margin:0 22px 14px;padding:10px 12px;border:1px solid var(--sm-danger);border-radius:8px;color:var(--sm-danger);font-size:12.5px}
.sm2-banner .sm2-grow{flex:1}

/* The sheet: a drawer pulled out of the library, with its own header rail. */
.sm2-scrim{position:fixed;inset:0;z-index:1000;display:flex;flex-direction:row;align-items:center;justify-content:center;height:auto;padding:22px;background:rgba(16,18,24,.5);backdrop-filter:blur(2px)}
.sm2-sheet{display:flex;flex-direction:column;width:min(660px,100%);max-height:88vh;border:1px solid var(--sm-line);border-radius:12px;background:var(--dsw-alias-bg-base);color:var(--sm-ink);box-shadow:0 24px 64px rgba(0,0,0,.34),0 2px 8px rgba(0,0,0,.12);overflow:hidden}

.sm2-sheethead{display:flex;align-items:center;gap:12px;padding:15px 18px 14px 20px;border-bottom:1px solid var(--sm-line);background:var(--dsw-alias-bg-base)}
.sm2-sheethead h3{margin:0;font-size:14.5px;font-weight:650;letter-spacing:-.01em}
.sm2-sheethead .sm2-grow{flex:1}
.sm2-x{display:inline-flex;align-items:center;justify-content:center;width:26px;height:26px;border-radius:7px;color:var(--sm-quiet)}
.sm2-x:hover{background:var(--sm-sunken);color:var(--sm-ink)}

.sm2-sheetbody{display:flex;flex-direction:column;gap:15px;padding:18px 20px 20px;overflow:auto;background:var(--dsw-alias-bg-base)}

/* A field is label → control → hint. The label sits tight to its control; the
   hint is the looser second voice. */
.sm2-field{display:flex;flex-direction:column;gap:6px}
.sm2-field>label{font-size:12px;font-weight:600;color:var(--sm-ink)}
.sm2-hint{margin:0;font-size:11.5px;line-height:1.55;color:var(--sm-quiet)}

.sm2-input,.sm2-textarea{width:100%;padding:8px 11px;border:1px solid var(--sm-line);border-radius:8px;background:var(--dsw-alias-bg-layer-1);color:var(--sm-ink);font-size:13px;font-family:inherit;transition:border-color .12s ease,box-shadow .12s ease}
.sm2-input::placeholder,.sm2-textarea::placeholder{color:var(--sm-quiet);opacity:.7}
.sm2-input:hover,.sm2-textarea:hover{border-color:var(--sm-line-strong)}
.sm2-input:focus,.sm2-textarea:focus{border-color:var(--sm-accent);outline:none;box-shadow:0 0 0 3px color-mix(in srgb,var(--sm-accent) 18%,transparent)}
.sm2-input:disabled{background:var(--sm-sunken);color:var(--sm-quiet);cursor:default}
.sm2-textarea{min-height:200px;resize:vertical;font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:12.5px;line-height:1.65;tab-size:2}
.sm2-textarea--read{background:var(--sm-sunken);cursor:default;color:var(--sm-quiet)}
.sm2-textarea--read:hover{border-color:var(--sm-line-strong)}

/* The two scope choices read as a small segmented pick rather than a form list. */
.sm2-radios{display:flex;flex-direction:column;gap:2px;padding:4px;border:1px solid var(--sm-line);border-radius:9px;background:var(--dsw-alias-bg-layer-2)}
.sm2-radio{display:flex;align-items:center;gap:8px;padding:7px 9px;border-radius:6px;font-size:12.5px;cursor:pointer;transition:background .12s ease}
.sm2-radio:has(input:checked){background:var(--sm-accent-tint);color:var(--sm-ink);font-weight:550}
.sm2-radio:hover{background:var(--dsw-alias-bg-layer-1)}
.sm2-radio input{accent-color:var(--sm-accent);margin:0;flex:none}

/* The zip picker: a drop target that also opens the file dialog. */
.sm2-picker{display:flex;align-items:center;gap:9px;padding:14px 13px;border:1px dashed var(--sm-line-strong);border-radius:9px;background:var(--dsw-alias-bg-layer-1);cursor:pointer;transition:border-color .12s ease,background .12s ease}
.sm2-picker:hover{border-color:var(--sm-accent);background:var(--sm-accent-tint)}
.sm2-picker--over{border-color:var(--sm-accent);background:var(--sm-accent-tint);border-style:solid}
.sm2-picker--filled{border-style:solid;cursor:default}
.sm2-picker--filled:hover{border-color:var(--sm-line-strong);background:var(--dsw-alias-bg-layer-1)}
.sm2-picker-ico{display:inline-flex;align-items:center;justify-content:center;width:30px;height:30px;flex:none;border-radius:7px;background:var(--sm-accent-tint);color:var(--sm-accent)}
.sm2-picker-cta{font-size:12.5px;font-weight:550;color:var(--sm-ink)}
.sm2-picker-sub{font-size:12px;color:var(--sm-quiet)}
.sm2-picker-name{flex:1;min-width:0;font-size:12.5px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--sm-ink)}
.sm2-picker-size{font-size:11.5px;color:var(--sm-quiet);font-variant-numeric:tabular-nums;flex:none}
.sm2-picker-clear{display:inline-flex;align-items:center;justify-content:center;width:22px;height:22px;flex:none;border-radius:6px;color:var(--sm-quiet)}
.sm2-picker-clear:hover{background:var(--sm-sunken);color:var(--sm-ink)}

.sm2-wslist{display:flex;flex-direction:column;gap:1px;max-height:184px;overflow:auto;padding:4px;border:1px solid var(--sm-line);border-radius:9px}
.sm2-ws{display:flex;align-items:baseline;gap:8px;padding:6px 8px;border-radius:6px;font-size:12.5px;cursor:pointer}
.sm2-ws:hover{background:var(--sm-sunken)}
.sm2-ws input{accent-color:var(--sm-accent);margin:0;flex:none;align-self:center}
.sm2-ws-path{margin-left:auto;font-size:11px;color:var(--sm-quiet);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:58%}

/* Footer: the primary action sits last, where the eye finishes. */
.sm2-sheetfoot{display:flex;align-items:center;justify-content:flex-end;gap:8px;padding:13px 20px;border-top:1px solid var(--sm-line);background:var(--dsw-alias-bg-layer-2)}

.sm2-error{margin:0;padding:9px 11px;border:1px solid var(--sm-danger);border-left-width:3px;border-radius:7px;color:var(--sm-danger);font-size:12px;line-height:1.5}
.sm2-toast{position:fixed;left:50%;bottom:22px;transform:translateX(-50%);z-index:1200;padding:9px 14px;border:1px solid var(--sm-line-strong);border-radius:9px;background:var(--dsw-alias-bg-overlay);box-shadow:0 10px 28px rgba(0,0,0,.3);font-size:12.5px}
.sm2-mono{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:11.5px;color:var(--sm-quiet);word-break:break-all}
@media (max-width:720px){
  .sm2-head,.sm2-searchrow,.sm2-groups{padding-left:14px;padding-right:14px}
  .sm2-body{padding:14px}
  .sm2-grid{grid-template-columns:1fr}
}
@media (prefers-reduced-motion:reduce){
  .sm2 *{transition:none!important}
}
`

    function useStyles() {
      useEffect(() => {
        let el = document.querySelector('style[data-dsh-skill-manager]')
        const created = !el
        if (!el) {
          el = document.createElement('style')
          el.setAttribute('data-dsh-skill-manager', '')
          document.head.appendChild(el)
        }
        el.textContent = CSS
        return () => { if (created && el && el.parentNode) { try { el.parentNode.removeChild(el) } catch {} } }
      }, [])
    }

    // ---------------------------------------------------------------------
    // Icons — 16px, 1.6 stroke, inherit currentColor.
    // ---------------------------------------------------------------------
    function Glyph({ d, size = 15, fill }) {
      return h('svg', {
        width: size, height: size, viewBox: '0 0 24 24', fill: fill || 'none',
        stroke: 'currentColor', strokeWidth: 1.6, strokeLinecap: 'round', strokeLinejoin: 'round',
        'aria-hidden': true,
      }, ...(Array.isArray(d) ? d : [d]).map((p, i) => h('path', { key: i, d: p })))
    }

    const ICON = {
      plus: 'M12 5v14M5 12h14',
      refresh: ['M20 11a8 8 0 10-2.3 5.7', 'M20 5v6h-6'],
      zip: ['M4 7h16v13H4z', 'M4 7l2-3h12l2 3', 'M12 8v3M12 13v2'],
      upload: ['M12 16V4', 'M7 9l5-5 5 5', 'M4 17v2a1 1 0 001 1h14a1 1 0 001-1v-2'],
      take: ['M12 4v10', 'M8 10l4 4 4-4', 'M4 18h16'],
      github: ['M9 19c-4 1.5-4-2.5-6-3m12 5v-3.5c0-1 .1-1.5-.5-2 2.8-.3 4.5-1.4 4.5-5a3.9 3.9 0 00-1-2.7 3.6 3.6 0 00-.1-2.7s-1.1-.3-3.5 1.3a12 12 0 00-6 0C6.9 3.6 5.8 3.9 5.8 3.9a3.6 3.6 0 00-.1 2.7A3.9 3.9 0 004.7 9.3c0 3.6 1.7 4.7 4.5 5-.6.6-.6 1.2-.5 2V19'],
      globe: ['M12 21a9 9 0 100-18 9 9 0 000 18z', 'M3.6 9h16.8M3.6 15h16.8', 'M12 3a15 15 0 010 18 15 15 0 010-18'],
      folder: ['M3 7a2 2 0 012-2h4l2 2h8a2 2 0 012 2v8a2 2 0 01-2 2H5a2 2 0 01-2-2z'],
      trash: ['M4 7h16', 'M9 7V5h6v2', 'M6 7l1 13h10l1-13'],
      pencil: ['M4 20h4L20 8l-4-4L4 16z', 'M14 6l4 4'],
      sight: ['M2 12s3.6-6 10-6 10 6 10 6-3.6 6-10 6-10-6-10-6z', 'M12 15a3 3 0 100-6 3 3 0 000 6z'],
      sync: ['M20 12a8 8 0 01-13.7 5.6', 'M4 12a8 8 0 0113.7-5.6', 'M18 3v4h-4', 'M6 21v-4h4'],
      stack: ['M12 3l8 4-8 4-8-4z', 'M4 12l8 4 8-4', 'M4 17l8 4 8-4'],
      close: 'M6 6l12 12M18 6L6 18',
    }

    // Three dots, drawn as circles so they stay round at any size.
    function MoreDots({ size = 13 }) {
      return h('svg', { width: size, height: size, viewBox: '0 0 24 24', fill: 'currentColor', 'aria-hidden': true },
        h('circle', { cx: 12, cy: 5.5, r: 1.7 }),
        h('circle', { cx: 12, cy: 12, r: 1.7 }),
        h('circle', { cx: 12, cy: 18.5, r: 1.7 }))
    }

    // ---------------------------------------------------------------------
    // Switch
    // ---------------------------------------------------------------------
    function Switch({ t, checked, disabled, busy, onToggle }) {
      return h('button', {
        type: 'button',
        className: 'sm2-switch',
        role: 'switch',
        'aria-checked': checked ? 'true' : 'false',
        disabled: disabled || busy,
        title: checked ? t('enabled') : t('disabled'),
        onClick: onToggle,
      },
        h('span', { className: 'sm2-track', 'aria-hidden': 'true' }),
        h('span', null, checked ? t('enabled') : t('disabled')))
    }

    // ---------------------------------------------------------------------
    // Sheets (dialogs)
    // ---------------------------------------------------------------------
    function Sheet({ t, title, children, footer, onClose }) {
      useEffect(() => {
        const onKey = (e) => { if (e.key === 'Escape') onClose() }
        window.addEventListener('keydown', onKey)
        return () => window.removeEventListener('keydown', onKey)
      }, [onClose])
      // The scrim carries `sm2` too: dialogs render outside the panel subtree,
      // so this is what gives them the palette variables and base rules.
      return h('div', { className: 'sm2 sm2-scrim', onMouseDown: (e) => { if (e.target === e.currentTarget) onClose() } },
        h('div', { className: 'sm2-sheet', role: 'dialog', 'aria-modal': 'true', 'aria-label': title },
          h('div', { className: 'sm2-sheethead' },
            h('h3', null, title),
            h('span', { className: 'sm2-grow' }),
            h('button', {
              type: 'button', className: 'sm2-x', 'aria-label': t('close'), title: t('close'),
              onClick: onClose,
            }, h(Glyph, { d: ICON.close, size: 14 }))),
          h('div', { className: 'sm2-sheetbody' }, children),
          footer ? h('div', { className: 'sm2-sheetfoot' }, footer) : null))
    }

    function ScopeFields({ t, workspaces, mode, setMode, picked, toggle }) {
      return h(React.Fragment, null,
        h('div', { className: 'sm2-field' },
          h('label', null, t('fieldScope')),
          h('div', { className: 'sm2-radios' },
            h('label', { className: 'sm2-radio' },
              h('input', { type: 'radio', name: 'sm2-scope', checked: mode === 'global', onChange: () => setMode('global') }),
              t('scopeGlobalOption')),
            h('label', { className: 'sm2-radio' },
              h('input', { type: 'radio', name: 'sm2-scope', checked: mode === 'workspaces', onChange: () => setMode('workspaces') }),
              t('scopeOption')))),
        mode === 'workspaces'
          ? h('div', { className: 'sm2-field' },
              h('label', null, t('fieldWorkspaces')),
              workspaces.length === 0
                ? h('p', { className: 'sm2-hint' }, t('noWorkspaces'))
                : h('div', { className: 'sm2-wslist' }, workspaces.map((w) =>
                    h('label', { key: w.path || w.id, className: 'sm2-ws' },
                      h('input', { type: 'checkbox', checked: picked.includes(w.path), onChange: () => toggle(w.path) }),
                      h('span', null, w.title || w.path),
                      h('span', { className: 'sm2-ws-path' }, w.path)))))
          : null)
    }

    function EditSheet({ t, mode, skill, workspaces, onClose, onSaved, say }) {
      const editing = mode === 'edit'
      const [name, setName] = useState(skill ? skill.name : '')
      const [description, setDescription] = useState(skill ? skill.description : '')
      const [body, setBody] = useState(skill ? skill.body : '')
      const [scopeMode, setScopeMode] = useState(skill && skill.scope ? skill.scope.mode : 'global')
      const [picked, setPicked] = useState(skill && skill.scope && skill.scope.workspaces ? skill.scope.workspaces.slice() : [])
      const [busy, setBusy] = useState(false)
      const [err, setErr] = useState('')
      const toggle = (p) => setPicked((cur) => cur.includes(p) ? cur.filter((x) => x !== p) : [...cur, p])

      const submit = async () => {
        if (!name.trim()) { setErr(t('errName')); return }
        if (!/^[a-z0-9][a-z0-9-]{0,62}$/.test(name.trim())) { setErr(t('errNameShape')); return }
        if (!description.trim()) { setErr(t('errDescription')); return }
        setErr(''); setBusy(true)
        try {
          const scope = scopeMode === 'workspaces' ? { mode: 'workspaces', workspaces: picked } : { mode: 'global', workspaces: [] }
          await api(editing ? 'save' : 'create', { name: name.trim(), description: description.trim(), body, scope })
          say(editing ? t('toastSaved') : t('toastCreated'))
          onSaved(); onClose()
        } catch (e) { setErr(String(e.message || e)) } finally { setBusy(false) }
      }

      return h(Sheet, {
        t,
        title: editing ? t('dialogEdit') : t('dialogNew'), onClose,
        footer: h(React.Fragment, null,
          h('button', { className: 'sm2-btn sm2-btn--quiet', onClick: onClose, disabled: busy }, t('cancel')),
          h('button', { className: 'sm2-btn sm2-btn--primary', onClick: submit, disabled: busy }, busy ? t('saving') : t('save'))),
      },
        err ? h('p', { className: 'sm2-error' }, err) : null,
        h('div', { className: 'sm2-field' },
          h('label', { htmlFor: 'sm2-name' }, t('fieldName')),
          h('input', { id: 'sm2-name', className: 'sm2-input', value: name, disabled: editing,
            placeholder: 'my-new-skill', onChange: (e) => setName(e.target.value) }),
          h('p', { className: 'sm2-hint' }, t('fieldNameHint'))),
        h('div', { className: 'sm2-field' },
          h('label', { htmlFor: 'sm2-desc' }, t('fieldDescription')),
          h('input', { id: 'sm2-desc', className: 'sm2-input', value: description,
            onChange: (e) => setDescription(e.target.value) }),
          h('p', { className: 'sm2-hint' }, t('fieldDescriptionHint'))),
        h('div', { className: 'sm2-field' },
          h('label', { htmlFor: 'sm2-body' }, t('fieldBody')),
          h('textarea', { id: 'sm2-body', className: 'sm2-textarea', value: body,
            onChange: (e) => setBody(e.target.value) })),
        h(ScopeFields, { t, workspaces, mode: scopeMode, setMode: setScopeMode, picked, toggle }))
    }

    function ViewSheet({ t, skill, onClose }) {
      return h(Sheet, {
        t,
        title: `${t('dialogView')} · ${skill.name}`, onClose,
        footer: h('button', { className: 'sm2-btn', onClick: onClose }, t('close')),
      },
        skill.description ? h('p', { className: 'sm2-hint', style: { fontSize: 12.5 } }, skill.description) : null,
        skill.path ? h('div', { className: 'sm2-mono' }, skill.path) : null,
        skill.adoptedFrom
          ? h('p', { className: 'sm2-hint' }, `${t('adoptOrigin')}: ${skill.adoptedFrom}`)
          : null,
        skill.readOnly ? h('p', { className: 'sm2-hint' }, t('readOnlyNote')) : null,
        h('textarea', { className: 'sm2-textarea sm2-textarea--read', value: skill.body || skill.raw || '', readOnly: true }))
    }

    function ScopeSheet({ t, skill, workspaces, onClose, onSaved, say }) {
      const [mode, setMode] = useState(skill.scope ? skill.scope.mode : 'global')
      const [picked, setPicked] = useState(skill.scope && skill.scope.workspaces ? skill.scope.workspaces.slice() : [])
      const [busy, setBusy] = useState(false)
      const [err, setErr] = useState('')
      const toggle = (p) => setPicked((cur) => cur.includes(p) ? cur.filter((x) => x !== p) : [...cur, p])

      const submit = async () => {
        setErr(''); setBusy(true)
        try {
          const scope = mode === 'workspaces' ? { mode: 'workspaces', workspaces: picked } : { mode: 'global', workspaces: [] }
          await api('setScope', { name: skill.name, scope })
          say(t('toastScope')); onSaved(); onClose()
        } catch (e) { setErr(String(e.message || e)) } finally { setBusy(false) }
      }

      return h(Sheet, {
        t,
        title: `${t('scope')} · ${skill.name}`, onClose,
        footer: h(React.Fragment, null,
          h('button', { className: 'sm2-btn sm2-btn--quiet', onClick: onClose, disabled: busy }, t('cancel')),
          h('button', { className: 'sm2-btn sm2-btn--primary', onClick: submit, disabled: busy }, busy ? t('saving') : t('save'))),
      },
        err ? h('p', { className: 'sm2-error' }, err) : null,
        h(ScopeFields, { t, workspaces, mode, setMode, picked, toggle }))
    }

    function GithubSheet({ t, workspaces, onClose, onSaved, say }) {
      const [repo, setRepo] = useState('')
      // Mirrors the host's URL parsing so a pasted /tree/<branch>/<path> link
      // shows the branch and folder it implies, instead of importing blind.
      const onRepoChange = (raw, setRefValue, setSubdirValue) => {
        setRepo(raw)
        const m = String(raw).match(/github\.com\/([^/\s]+)\/([^/\s#?]+)(?:\/(?:tree|blob)\/([^/]+)\/?([^#?]*))?/i)
        if (!m) return
        if (m[3] && !ref.trim()) setRefValue(decodeURIComponent(m[3]))
        const p = decodeURIComponent(m[4] || '').replace(/^\/+|\/+$/g, '').replace(/\/?SKILL\.md$/i, '')
        if (p && !subdir.trim()) setSubdirValue(p)
      }
      const [ref, setRef] = useState('')
      const [subdir, setSubdir] = useState('')
      const [scopeMode, setScopeMode] = useState('global')
      const [picked, setPicked] = useState([])
      const [busy, setBusy] = useState(false)
      const [err, setErr] = useState('')
      const toggle = (p) => setPicked((cur) => cur.includes(p) ? cur.filter((x) => x !== p) : [...cur, p])

      const submit = async () => {
        if (!repo.trim()) { setErr(t('repo')); return }
        setErr(''); setBusy(true)
        try {
          const scope = scopeMode === 'workspaces' ? { mode: 'workspaces', workspaces: picked } : { mode: 'global', workspaces: [] }
          await api('importGithub', { repo: repo.trim(), ref: ref.trim(), subdir: subdir.trim(), scope })
          say(t('toastImported')); onSaved(); onClose()
        } catch (e) { setErr(String(e.message || e)) } finally { setBusy(false) }
      }

      return h(Sheet, {
        t,
        title: t('dialogGithub'), onClose,
        footer: h(React.Fragment, null,
          h('button', { className: 'sm2-btn sm2-btn--quiet', onClick: onClose, disabled: busy }, t('cancel')),
          h('button', { className: 'sm2-btn sm2-btn--primary', onClick: submit, disabled: busy }, busy ? t('importing') : t('actionImport'))),
      },
        err ? h('p', { className: 'sm2-error' }, err) : null,
        h('div', { className: 'sm2-field' }, h('label', { htmlFor: 'sm2-repo' }, t('repo')),
          h('input', { id: 'sm2-repo', className: 'sm2-input', value: repo, placeholder: 'https://github.com/owner/repo/tree/main/skills/my-skill',
            onChange: (e) => onRepoChange(e.target.value, setRef, setSubdir) }),
          h('p', { className: 'sm2-hint' }, t('repoHint'))),
        h('div', { className: 'sm2-field' }, h('label', { htmlFor: 'sm2-ref' }, t('ref')),
          h('input', { id: 'sm2-ref', className: 'sm2-input', value: ref, placeholder: 'main', onChange: (e) => setRef(e.target.value) }),
          h('p', { className: 'sm2-hint' }, t('refHint'))),
        h('div', { className: 'sm2-field' }, h('label', { htmlFor: 'sm2-subdir' }, t('subdir')),
          h('input', { id: 'sm2-subdir', className: 'sm2-input', value: subdir, placeholder: 'skills/my-skill', onChange: (e) => setSubdir(e.target.value) }),
          h('p', { className: 'sm2-hint' }, t('subdirHint'))),
        h(ScopeFields, { t, workspaces, mode: scopeMode, setMode: setScopeMode, picked, toggle }))
    }

    function ZipSheet({ t, workspaces, onClose, onSaved, say }) {
      const [file, setFile] = useState(null)
      const [scopeMode, setScopeMode] = useState('global')
      const [picked, setPicked] = useState([])
      const [busy, setBusy] = useState(false)
      const [err, setErr] = useState('')
      const [dragging, setDragging] = useState(false)
      const fileRef = React.useRef(null)
      const toggle = (p) => setPicked((cur) => cur.includes(p) ? cur.filter((x) => x !== p) : [...cur, p])

      const accept = (f) => {
        if (!f) return
        if (!/\.zip$/i.test(f.name)) { setErr(t('zipWrongType')); return }
        setErr('')
        setFile(f)
      }

      const readAsBase64 = (f) => new Promise((resolve, reject) => {
        const reader = new FileReader()
        reader.onload = () => {
          const out = String(reader.result || '')
          const comma = out.indexOf(',')
          resolve(comma >= 0 ? out.slice(comma + 1) : out)
        }
        reader.onerror = () => reject(reader.error || new Error('The file could not be read'))
        reader.readAsDataURL(f)
      })

      const submit = async () => {
        if (!file) { setErr(t('zipPickFirst')); return }
        setErr(''); setBusy(true)
        try {
          const data = await readAsBase64(file)
          const scope = scopeMode === 'workspaces' ? { mode: 'workspaces', workspaces: picked } : { mode: 'global', workspaces: [] }
          await api('importZipUpload', { data, filename: file.name, scope })
          say(t('toastImported')); onSaved(); onClose()
        } catch (e) { setErr(String(e.message || e)) } finally { setBusy(false) }
      }

      const sizeText = useMemo(() => {
        if (!file) return ''
        const kb = file.size / 1024
        return kb < 1024 ? `${kb.toFixed(0)} KB` : `${(kb / 1024).toFixed(1)} MB`
      }, [file])

      return h(Sheet, {
        t,
        title: t('dialogZip'), onClose,
        footer: h(React.Fragment, null,
          h('button', { className: 'sm2-btn sm2-btn--quiet', onClick: onClose, disabled: busy }, t('cancel')),
          h('button', { className: 'sm2-btn sm2-btn--primary', onClick: submit, disabled: busy || !file },
            busy ? t('importing') : t('actionImport'))),
      },
        err ? h('p', { className: 'sm2-error' }, err) : null,
        h('div', { className: 'sm2-field' },
          h('label', null, t('zipFile')),
          h('div', {
            className: `sm2-picker${dragging ? ' sm2-picker--over' : ''}${file ? ' sm2-picker--filled' : ''}`,
            role: 'button', tabIndex: 0,
            'aria-label': file ? t('zipReplace') : t('zipChoose'),
            onClick: () => fileRef.current && fileRef.current.click(),
            onKeyDown: (e) => {
              if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); fileRef.current && fileRef.current.click() }
            },
            onDragOver: (e) => { e.preventDefault(); setDragging(true) },
            onDragLeave: () => setDragging(false),
            onDrop: (e) => {
              e.preventDefault(); setDragging(false)
              const f = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0]
              accept(f)
            },
          },
            h('input', {
              ref: fileRef, type: 'file', accept: '.zip,application/zip', hidden: true,
              onChange: (e) => { accept(e.target.files && e.target.files[0]); e.target.value = '' },
            }),
            file
              ? h(React.Fragment, null,
                  h('span', { className: 'sm2-picker-ico' }, h(Glyph, { d: ICON.zip, size: 16 })),
                  h('span', { className: 'sm2-picker-name', title: file.name }, file.name),
                  h('span', { className: 'sm2-picker-size' }, sizeText),
                  h('button', {
                    type: 'button', className: 'sm2-picker-clear', 'aria-label': t('zipClear'), title: t('zipClear'),
                    onClick: (e) => { e.stopPropagation(); setFile(null) },
                  }, h(Glyph, { d: ICON.close, size: 12 })))
              : h(React.Fragment, null,
                  h('span', { className: 'sm2-picker-ico' }, h(Glyph, { d: ICON.upload, size: 18 })),
                  h('span', { className: 'sm2-picker-cta' }, t('zipChoose')),
                  h('span', { className: 'sm2-picker-sub' }, t('zipDropHint')))),
          h('p', { className: 'sm2-hint' }, t('zipPathHint'))),
        h(ScopeFields, { t, workspaces, mode: scopeMode, setMode: setScopeMode, picked, toggle }))
    }

    // ---------------------------------------------------------------------
    // Panel
    // ---------------------------------------------------------------------
    const GROUPS = ['all', 'managed', 'user', 'project', 'bundled', 'runtime', 'other']

    function SkillManagerPanel({ locale }) {
      useStyles()
      const t = useMemo(() => makeT(locale), [locale])

      const [skills, setSkills] = useState([])
      const [workspaces, setWorkspaces] = useState([])
      const [loading, setLoading] = useState(true)
      const [error, setError] = useState('')
      const [query, setQuery] = useState('')
      const [group, setGroup] = useState('all')
      const [stateFilter, setStateFilter] = useState('all')
      const [sheet, setSheet] = useState(null)
      const [note, setNote] = useState('')
      const [busyName, setBusyName] = useState('')
      const [scanning, setScanning] = useState(false)
      const [openMenu, setOpenMenu] = useState(null)
      const [adopting, setAdopting] = useState(false)
      const [adoptProgress, setAdoptProgress] = useState(null)

      // One dismisser for every open card menu.
      useEffect(() => {
        if (!openMenu) return undefined
        // Only a press outside the menu dismisses it. Closing on any press
        // would unmount the item before its click fires, so the action would
        // silently do nothing.
        const onDown = (e) => {
          const target = e.target
          if (target instanceof Element && target.closest('.sm2-more')) return
          setOpenMenu(null)
        }
        const onKey = (e) => { if (e.key === 'Escape') setOpenMenu(null) }
        window.addEventListener('mousedown', onDown)
        window.addEventListener('keydown', onKey)
        return () => {
          window.removeEventListener('mousedown', onDown)
          window.removeEventListener('keydown', onKey)
        }
      }, [openMenu])

      const say = useCallback((msg) => setNote(msg), [])
      useEffect(() => {
        if (!note) return undefined
        const id = setTimeout(() => setNote(''), 2400)
        return () => clearTimeout(id)
      }, [note])

      const load = useCallback(async (action = 'list') => {
        if (action === 'rescan') setScanning(true)
        else setLoading(true)
        setError('')
        try {
          const data = await api(action)
          setSkills(data.skills || [])
          setWorkspaces(data.workspaces || [])
          if (action === 'rescan') say(t('toastScanned'))
        } catch (e) {
          setError(String(e.message || e))
        } finally {
          setLoading(false); setScanning(false)
        }
      }, [say, t])

      useEffect(() => { load('list') }, [load])

      const counts = useMemo(() => {
        const c = { all: skills.length }
        for (const s of skills) {
          c[s.group || 'other'] = (c[s.group || 'other'] || 0) + 1
          if (s.managed) c[s.enabled === false ? 'off' : 'on'] = (c[s.enabled === false ? 'off' : 'on'] || 0) + 1
        }
        return c
      }, [skills])

      const visible = useMemo(() => {
        const q = query.trim().toLowerCase()
        return skills.filter((s) => {
          if (group !== 'all' && (s.group || 'other') !== group) return false
          if (stateFilter !== 'all') {
            if (!s.managed) return false
            if (stateFilter === 'on' && s.enabled === false) return false
            if (stateFilter === 'off' && s.enabled !== false) return false
          }
          if (!q) return true
          return s.name.toLowerCase().includes(q)
            || (s.description || '').toLowerCase().includes(q)
            || (s.provider || '').toLowerCase().includes(q)
        })
      }, [skills, query, group, stateFilter])

      // Skills in view that can still be taken over.
      const adoptableVisible = useMemo(
        () => visible.filter((s) => !s.managed && s.adoptable),
        [visible],
      )

      const groupName = (g) => ({
        all: t('groupAll'), managed: t('groupManaged'), user: t('groupUser'),
        project: t('groupProject'), bundled: t('groupBundled'), runtime: t('groupRuntime'),
        other: t('groupOther'),
      })[g] || g

      const countText = useCallback((n) => (n === 1 ? t('countOne') : t('countMany', { count: n })), [t])

      const toggleSkill = async (skill) => {
        const next = skill.enabled === false
        setBusyName(skill.name)
        try {
          await api('setEnabled', { name: skill.name, enabled: next })
          setSkills((cur) => cur.map((s) => s.name === skill.name ? { ...s, enabled: next } : s))
          say(next ? t('toastEnabled') : t('toastDisabled'))
        } catch (e) { say(String(e.message || e)) } finally { setBusyName('') }
      }

      const removeSkill = async (skill) => {
        if (!window.confirm(t('confirmRemove', { name: skill.name }))) return
        setBusyName(skill.name)
        try {
          await api('delete', { name: skill.name })
          say(t('toastRemoved')); load()
        } catch (e) { say(String(e.message || e)) } finally { setBusyName('') }
      }

      const updateSkill = async (skill) => {
        setBusyName(skill.name)
        try {
          await api('update', { name: skill.name })
          say(t('toastUpdated')); load()
        } catch (e) { say(String(e.message || e)) } finally { setBusyName('') }
      }

      // Take over one on-disk skill: the host copies its folder into the library.
      const adoptSkill = async (skill) => {
        setBusyName(skill.name)
        try {
          await api('adopt', { name: skill.name, from: skill.path })
          say(t('adoptToasted')); await load()
        } catch (e) { say(String(e.message || e)) } finally { setBusyName('') }
      }

      // Take over every remaining adoptable skill in the current group.
      const adoptGroup = async () => {
        const targets = visible.filter((s) => !s.managed && s.adoptable)
        if (targets.length === 0) { say(t('adoptNone')); return }
        setAdopting(true)
        let ok = 0
        let failed = 0
        for (let i = 0; i < targets.length; i++) {
          setAdoptProgress({ done: i, total: targets.length })
          try {
            await api('adopt', { name: targets[i].name, from: targets[i].path })
            ok++
          } catch { failed++ }
        }
        setAdoptProgress(null)
        setAdopting(false)
        await load()
        say(failed === 0 ? t('adoptAllToasted', { count: ok }) : t('adoptSomeFailed', { ok, failed }))
      }

      const openView = async (skill) => {
        try {
          const d = await api('get', { name: skill.name })
          setSheet({ kind: 'view', skill: d.skill })
        } catch (e) { say(String(e.message || e)) }
      }

      const card = (skill) => {
        const off = skill.managed && skill.enabled === false
        const scope = skill.scope || { mode: 'global', workspaces: [] }
        return h('article', {
          key: skill.name,
          className: 'sm2-card',
          'data-state': skill.managed ? (off ? 'off' : 'on') : 'plain',
        },
          h('div', { className: 'sm2-cardtop' },
            h('span', { className: 'sm2-name', title: skill.name }, skill.name),
            h('span', { className: 'sm2-grow' }),
            skill.managed
              ? h('span', { className: 'sm2-tag sm2-tag--here' }, t('managedHere'))
              : h('span', { className: 'sm2-tag' }, t('readOnly'))),
          h('p', { className: 'sm2-desc' }, skill.description || '—'),
          h('div', { className: 'sm2-meta' },
            skill.managed
              ? h('span', { className: 'sm2-tag sm2-tag--scope' },
                  h(Glyph, { d: scope.mode === 'workspaces' ? ICON.folder : ICON.globe, size: 11 }),
                  scope.mode === 'workspaces'
                    ? (scope.workspaces.length === 1
                        ? t('scopeSingle')
                        : t('scopeCountMany', { count: scope.workspaces.length }))
                    : t('scopeGlobal'))
              : h('span', { className: 'sm2-tag sm2-tag--scope' }, groupName(skill.group || 'other')),
            skill.managed && skill.source === 'github'
              ? h('span', { className: 'sm2-tag' }, h(Glyph, { d: ICON.github, size: 11 }), 'GitHub')
              : null,
            // A taken-over skill keeps a pointer to where it came from, since
            // the original folder is still there and still editable.
            skill.managed && skill.source === 'adopted'
              ? h('span', { className: 'sm2-tag', title: skill.adoptedFrom || '' },
                  h(Glyph, { d: ICON.take, size: 11 }), t('sourceAdopted'))
              : null,
            off ? h('span', { className: 'sm2-tag sm2-tag--off' }, t('disabled')) : null),
          h('div', { className: 'sm2-cardfoot' },
            skill.managed
              ? h(Switch, {
                  t, checked: !off, busy: busyName === skill.name,
                  onToggle: () => toggleSkill(skill),
                })
              : h('span', { className: 'sm2-tag sm2-tag--scope' }, groupName(skill.group || 'other')),
            h('span', { className: 'sm2-grow' }),
            // The way in for a skill that dsh already provides: taking it over
            // is what gives it a switch and a scope.
            !skill.managed && skill.adoptable
              ? h('button', {
                  className: 'sm2-btn sm2-btn--sm sm2-btn--adopt',
                  disabled: busyName === skill.name || adopting,
                  title: t('adoptHint'),
                  onClick: () => adoptSkill(skill),
                },
                  h(Glyph, { d: ICON.take, size: 12 }),
                  busyName === skill.name ? t('adoptAdopting') : t('adopt'))
              : null,
            // Scope sits on the card itself: with the switch it is one of the
            // two things a person changes about a skill's availability, so it
            // should not be buried in a menu.
            skill.managed
              ? h('button', {
                  className: 'sm2-btn sm2-btn--sm sm2-btn--quiet',
                  title: t('scopeHint'),
                  onClick: () => setSheet({ kind: 'scope', skill }),
                }, h(Glyph, { d: ICON.stack, size: 12 }), t('scope'))
              : null,
            h('button', { className: 'sm2-btn sm2-btn--sm sm2-btn--quiet', onClick: () => openView(skill) },
              h(Glyph, { d: ICON.sight, size: 12 }), t('view')),
            // Everything else lives behind one menu so the row never overflows.
            skill.managed
              ? h('div', { className: 'sm2-more' },
                  h('button', {
                    className: 'sm2-btn sm2-btn--sm sm2-btn--quiet',
                    'aria-haspopup': 'menu',
                    'aria-expanded': openMenu === skill.name ? 'true' : 'false',
                    'aria-label': t('more'),
                    title: t('more'),
                    onClick: (e) => {
                      e.stopPropagation()
                      setOpenMenu(openMenu === skill.name ? null : skill.name)
                    },
                  }, h(MoreDots, { size: 13 })),
                  openMenu === skill.name
                    ? h('div', { className: 'sm2-menu', role: 'menu', onMouseLeave: () => {} },
                        h('button', {
                          className: 'sm2-menuitem', role: 'menuitem',
                          onClick: async () => {
                            setOpenMenu(null)
                            try {
                              const d = await api('get', { name: skill.name })
                              setSheet({ kind: 'edit', skill: d.skill })
                            } catch (err) { say(String(err.message || err)) }
                          },
                        }, h(Glyph, { d: ICON.pencil, size: 13 }), t('edit')),
                        skill.source === 'github'
                          ? h('button', {
                              className: 'sm2-menuitem', role: 'menuitem',
                              onClick: () => { setOpenMenu(null); updateSkill(skill) },
                            }, h(Glyph, { d: ICON.sync, size: 13 }), t('update'))
                          : null,
                        h('button', {
                          className: 'sm2-menuitem sm2-menuitem--danger', role: 'menuitem',
                          onClick: () => { setOpenMenu(null); removeSkill(skill) },
                        }, h(Glyph, { d: ICON.trash, size: 13 }), t('remove')))
                    : null)
              : null))
      }

      const body = () => {
        if (loading && skills.length === 0) {
          return h('div', { className: 'sm2-state' }, h('p', null, t('loading')))
        }
        if (visible.length === 0) {
          const none = skills.length === 0
          return h('div', { className: 'sm2-state' },
            h('h4', null, none ? t('emptyNone') : t('emptyTitle')),
            h('p', null, none ? t('emptyNoneBody') : t('emptyBody')))
        }
        return h('div', { className: 'sm2-grid' }, visible.map(card))
      }

      return h('div', { className: 'sm2' },
        h('header', { className: 'sm2-head' },
          h('div', { className: 'sm2-headtext' },
            h('h2', { className: 'sm2-title' }, t('title')),
            h('p', { className: 'sm2-sub' }, t('subtitle'))),
          h('span', { className: 'sm2-grow' }),
          h('button', { className: 'sm2-btn', onClick: () => load('rescan'), disabled: scanning },
            h(Glyph, { d: ICON.refresh, size: 13 }), scanning ? t('scanning') : t('rescan')),
          h('button', { className: 'sm2-btn', onClick: () => setSheet({ kind: 'zip' }) },
            h(Glyph, { d: ICON.zip, size: 13 }), t('importZip')),
          h('button', { className: 'sm2-btn', onClick: () => setSheet({ kind: 'github' }) },
            h(Glyph, { d: ICON.github, size: 13 }), t('importFrom')),
          h('button', { className: 'sm2-btn sm2-btn--primary', onClick: () => setSheet({ kind: 'create' }) },
            h(Glyph, { d: ICON.plus, size: 13 }), t('newSkill'))),

        h('div', { className: 'sm2-searchrow' },
          h('input', {
            className: 'sm2-search', type: 'search', value: query,
            placeholder: t('search'), 'aria-label': t('search'),
            onChange: (e) => setQuery(e.target.value),
          }),
          h('span', { className: 'sm2-count' }, countText(visible.length))),

        h('nav', { className: 'sm2-groups', role: 'tablist', 'aria-label': t('title') },
          GROUPS.filter((g) => g === 'all' || counts[g] > 0).map((g) =>
            h('button', {
              key: g, role: 'tab', className: 'sm2-group',
              'aria-selected': group === g ? 'true' : 'false',
              onClick: () => setGroup(g),
            }, groupName(g), h('span', { className: 'sm2-group-n' }, counts[g] || 0))),
          h('span', { className: 'sm2-grow' }),
          // One shot at the whole group, for when the user skills were all
          // installed before this plugin existed.
          adoptableVisible.length > 0
            ? h('button', {
                className: 'sm2-group sm2-group--action',
                onClick: adoptGroup,
                disabled: adopting,
                title: t('adoptHint'),
              },
                h(Glyph, { d: ICON.take, size: 12 }),
                adoptProgress
                  ? t('adoptAllBusy', adoptProgress)
                  : t('adoptAll'))
            : null,
          counts.on != null
            ? h(React.Fragment, null,
                h('button', {
                  className: 'sm2-group', role: 'tab',
                  'aria-selected': stateFilter === 'on' ? 'true' : 'false',
                  onClick: () => setStateFilter(stateFilter === 'on' ? 'all' : 'on'),
                }, t('filterEnabled'), h('span', { className: 'sm2-group-n' }, counts.on || 0)),
                h('button', {
                  className: 'sm2-group', role: 'tab',
                  'aria-selected': stateFilter === 'off' ? 'true' : 'false',
                  onClick: () => setStateFilter(stateFilter === 'off' ? 'all' : 'off'),
                }, t('filterDisabled'), h('span', { className: 'sm2-group-n' }, counts.off || 0)))
            : null),

        error
          ? h('div', { className: 'sm2-banner' },
              h('span', { className: 'sm2-grow' }, `${t('errorTitle')}: ${error}`),
              h('button', { className: 'sm2-btn sm2-btn--sm', onClick: () => load('list') }, t('retry')))
          : null,

        h('div', { className: 'sm2-body' }, body()),

        sheet && sheet.kind === 'create'
          ? h(EditSheet, { t, mode: 'create', workspaces, onClose: () => setSheet(null), onSaved: () => load(), say })
          : null,
        sheet && sheet.kind === 'edit'
          ? h(EditSheet, { t, mode: 'edit', skill: sheet.skill, workspaces, onClose: () => setSheet(null), onSaved: () => load(), say })
          : null,
        sheet && sheet.kind === 'view'
          ? h(ViewSheet, { t, skill: sheet.skill, onClose: () => setSheet(null) })
          : null,
        sheet && sheet.kind === 'scope'
          ? h(ScopeSheet, { t, skill: sheet.skill, workspaces, onClose: () => setSheet(null), onSaved: () => load(), say })
          : null,
        sheet && sheet.kind === 'zip'
          ? h(ZipSheet, { t, workspaces, onClose: () => setSheet(null), onSaved: () => load(), say })
          : null,
        sheet && sheet.kind === 'github'
          ? h(GithubSheet, { t, workspaces, onClose: () => setSheet(null), onSaved: () => load(), say })
          : null,

        note ? h('div', { className: 'sm2-toast', role: 'status' }, note) : null)
    }

    // ---------------------------------------------------------------------
    // Registration
    // ---------------------------------------------------------------------
    return {
      inject: ['slots'],
      apply(ctx) {
        const localeSvc = ctx.get ? ctx.get('locale') : undefined

        // The snapshot's field is `active`. Read it defensively so a shape
        // change degrades to English instead of throwing.
        function activeLocale() {
          try {
            const snap = localeSvc && typeof localeSvc.getLocale === 'function' ? localeSvc.getLocale() : null
            if (!snap) return ''
            return snap.active || snap.locale || snap.id || ''
          } catch { return '' }
        }

        // Re-render on every locale switch or dictionary registration.
        function useActiveLocale() {
          const [id, setId] = useState(activeLocale)
          useEffect(() => {
            if (!localeSvc) return undefined
            if (typeof localeSvc.subscribe === 'function') {
              return localeSvc.subscribe(() => setId(activeLocale()))
            }
            // No subscribe face: at least track the documented event.
            return ctx.on ? ctx.on('locale/change', () => setId(activeLocale())) : undefined
          }, [])
          return id
        }

        function LocalizedPanel() {
          const locale = useActiveLocale()
          return h(SkillManagerPanel, { locale })
        }

        ctx.slots.inject('main', () => ctx.slots.register({ name: 'main', key: PANEL_ID }, LocalizedPanel))
        ctx.slots.inject('sidebar.panellist', () => ctx.slots.register(
          { name: 'sidebar.panellist', id: PANEL_ID, order: 15, label: () => makeT(activeLocale())('title') },
          (props) => h(Glyph, { d: ICON.stack, size: props && typeof props.size === 'number' ? props.size : 18 })))
      },
    }
  },
})
