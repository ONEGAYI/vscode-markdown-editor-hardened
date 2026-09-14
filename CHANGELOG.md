# Changelog

All notable changes to `markdown-editor-hardened` are documented here.

Format follows [Keep a Changelog 1.1.0](https://keepachangelog.com/en/1.1.0/).
The fork's versioning: upstream's version + `-hardened.<N>` suffix, where N is
the fork's own counter. We bump `<N>` on each meaningful release; when upstream
publishes a new version we re-base and bump the upstream prefix.

## [0.1.14-hardened.1] — unreleased

T1 (security hardening) + T2 (polish, CI, docs) complete. First fork release
candidate. All seven findings from the upstream audit are closed.

### Security

- **H1 — over-broad `localResourceRoots`** (low/DiD). Scoped to
  `[extensionUri, ...workspace folders, current file dir]`. Replaces upstream's
  `[Uri.file("/"), Uri.file("A:/")..Uri.file("Z:/")]`. (C1.6, DC3)
- **H2 — RCE via crafted markdown `command:` URI** (high). Removed
  `enableCommandUris: true` from `EditorPanel.getWebviewOptions`. Verified
  programmatically: vditor's Lute markdown sanitizer does NOT strip `command:`
  schemes from rendered `<a href>` attributes in 3.8.4 OR 3.11.2 — meaning the
  vector was reachable in upstream and remains reachable in upstream 0.1.13.
  Our fix makes `command:` clicks inert via the webview-default behavior.
  (C1.2, DC1)
- **H3 — `customCss` raw HTML injection / XSS** (high). Setting removed.
  Replaced with `customStylesheet` (workspace-relative `.css` PATH, NOT a
  string-of-CSS). Path validation rejects URL schemes, absolute paths, NUL
  bytes, traversal, wrong extension; emitted as `<link rel="stylesheet">`,
  not a content-interpolated `<style>` block. (T0 stub at C0.2; full redesign
  C1.4, DC2)
- **H4 — write-anywhere primitive in `upload` handler** (medium → high given
  webview compromise). Host-side `validateUploadFilename` rejects path
  separators, dot-prefix, `.`/`..`, Windows drive letters, NUL bytes,
  >255-byte names; verifies `path.basename(name) === name`. (C1.7, DC5)
- **H5 — OS-handler pivot via `open-link`** (medium). Scheme allowlist: http,
  https, mailto. `file:` allowed only when the resolved path is inside a
  workspace folder. Relative paths resolved against the current document, then
  workspace-containment-checked. data:, javascript:, command:, vscode:, ftp:,
  custom protocols are silently dropped. (C1.9, DC6)
- **H6 — no Content-Security-Policy on webview HTML** (medium/DiD). Added
  strict CSP: `default-src 'none'`, `script-src 'nonce-<per-render>' cspSource`,
  `style-src cspSource 'unsafe-inline'`, `connect-src cspSource`,
  `frame-src 'none'`, `object-src 'none'`, `base-uri 'none'`. Per-render
  cryptographic nonce gates every `<script>` tag. (C1.10, DC4)
- **H9 — jsdelivr CDN dependency at runtime** (medium / supply-chain). New
  build step (`media-src/copy-vditor-assets.js`) copies vditor's `dist/`
  into `media/vditor/dist/`. Host emits `window.__vditorCdn` pointing at the
  local URL; webview uses it as the Vditor `cdn` option. CSP no longer
  allowlists jsdelivr. **Production now has zero outbound network calls at
  editor-open time.** (C1.14, DC7)

### Dependencies / supply chain

- **vditor 3.8.4 → 3.11.2** (4.5 years of bug-fixes + security work). API
  breakages handled per upstream PR #142: `i18n` module export removed
  (now reads `window.VditorI18n`); upload handler returns null on success;
  filename-sanitization regex needs the `g` flag. Credit hackarada for the
  original API-change findings. (C1.12, DC8)
- **Locked everything to npm** (was `registry.npmmirror.com` per upstream's
  `yarn.lock`). Lockfile transitions: media-src `yarn.lock` →
  `pnpm-lock.yaml`. Root + media-src + tests all use pnpm. (C1.12)
- **Removed `@testing-library/dom` + `@testing-library/user-event`** from
  `media-src/dependencies` (was used at runtime for one vditor table-hotkey
  call — should never have been a runtime dep). Replaced with in-tree
  `media-src/src/keyboard.ts` (synthetic-keyboard-event helper). Bundle
  size: **796KB → 522KB (-274KB / -34%)**. (C2.1, DC10)

### Features merged from upstream PRs

- **CI workflow fix** — actions/checkout v2→v4, setup-node v1→v4, node 14→20,
  HaaLeo/publish v0→v2, OpenVSX-before-Marketplace step ordering. Adopts
  upstream PR #151 verbatim. Credit mrsekut. (C1.1)
- **Auto-focus on editor open + re-reveal** — `vditor.focus()` in the
  `after` callback + new `focus` message handler. Adopts upstream PR #154.
  Credit LeonardoRick. (C1.16)
- **Find widget in webview panel** — `enableFindWidget: true`. Adopts upstream
  PR #153. Credit LeonardoRick. (C1.17)
- **Source-accurate line numbers in left gutter** — `markdown-editor-hardened.
  showLineNumbers` setting (default true); gutter mapped to source-file lines
  (handles frontmatter, code fences, tables, lists, blockquotes). Adapted
  for CSP (the inline `<script>` is nonce-gated per-render). Adopts upstream
  PR #157. Credit asalcedo29. (C1.18)

### Synced from upstream (fork base e78e49c → upstream 0.1.21)

All genuinely-missing upstream changes between the fork base and
upstream `main@033c624` were ported in two batches, adapted to this
fork's CSP, security validators, and MessageDispatcher structure.
Upstream version bumps / CI / publish chores were not taken; the merge
base is reconciled separately (merge -s ours).

Batch 1 — fixes:

- **Local & relative links** (upstream 9b6f3f8): the webview now sends
  the RAW `href` attribute (the old `el.href` was resolved against the
  webview's internal origin, mangling relative links) and detects
  clicks on nested elements via `closest('a')`. The host stats the
  validated target: directories open in the OS file explorer,
  missing files are dropped silently. Scheme allowlist +
  workspace containment kept (stricter than upstream, by design).
- **TOC / in-page anchors** (upstream c5ccb4d): IR-mode pseudo-links
  (`[data-type="a"]` marker spans) dispatch too; `#anchor` links
  resolve locally against a GitHub-style heading slug and scroll —
  never forwarded to the host.
- **Line-number drift** (upstream 9b4f158): the gutter reads the live
  `vditor.getValue()` instead of a startup-only `__setOrigContent`
  snapshot; the snapshot plumbing is gone.
- **Scroll position + FOUC** (upstream 9c8e962): reading position
  survives file switches (shared `fsPath -> scrollTop` map, restore
  polls through async resizes and backs off on real user input,
  `overflow-anchor` disabled). `#app` stays hidden until main.css has
  loaded AND vditor is ready + scroll applied — CSP-adapted: load
  handlers wired from a nonce'd script instead of inline `onload=`
  attributes, reveal attributes on `<html>`, visibility rule inlined
  literally (keeps poc-h3's no-style-interpolation invariant).
- **Full editor width** (upstream c32c0e0): `.vditor-reset` gains
  `padding-right: 35px` mirroring the left override, so wide viewports
  no longer keep vditor's computed centering gap.
- **External file changes** (upstream 10870ac + 651b300): document
  changes are discriminated by origin (`contentChanges > 0 && !dirty`
  = disk reload) instead of panel focus — external edits sync while
  the tab is focused; saves/autosave no longer misread as reloads.

Batch 2 — features:

- **In-editor find bar** (upstream dd933af): Ctrl+F floating bar,
  CSS Custom Highlight API (no DOM mutation), match counter,
  case toggle, prev/next, Esc to close; toolbar Find button.
  FORK ADAPTATION: `getEditorRoot()` resolves the ACTIVE mode's
  container first — upstream's IR-first order returns the inactive
  (empty) IR container under our WYSIWYG default, finding nothing.
- **Table cell wrapping** (upstream 40a47a9, PR #172): cells wrap like
  VS Code's preview instead of forcing nowrap/horizontal scroll;
  toolbar button toggles the original behavior for the session.
- **Open outline by default** (upstream db2062c): new setting
  `markdown-editor-hardened.defaultOpenOutline` (default false).
- Custom-editor path now also sets `enableFindWidget` +
  `retainContextWhenHidden` (command-mode panel already had them).

Tests added for both batches: `tests/integration/link-click.js`
(16 checks) and `tests/integration/find-bar.js` (10 checks, real-stack
boot). `line-numbers*.js` re-targeted to the live-value contract with
a drift regression. Suite: 12/12 PASS.

### Fixed

- **Line-number gutter dead outside WYSIWYG mode (the `#` toggle did
  nothing)**. vditor 3.11 keeps all three mode containers
  (`.vditor-wysiwyg`, `.vditor-sv`, `.vditor-ir`) in the DOM at once;
  only the active one renders block children. The gutter script's bare
  `document.querySelector(...)` always resolved the FIRST container in
  document order (`.vditor-wysiwyg`), so with a saved mode of `ir` (the
  pre-fork upstream default, persisted in globalState) or `sv` it
  measured a hidden empty container, never created `#ln-gutter`, and
  the toggle button had nothing to show/hide. The script now resolves
  the ACTIVE mode's container via `vditor.getCurrentMode()` (with a
  "container that has block children" fallback) and re-arms its
  scroll/observer hooks when the mode switches. SV (source-split) mode
  remains without a gutter — it has no block editing surface. Found via
  a real-stack JSDOM harness (webview bundle + real vditor init);
  regression-tested in `tests/integration/line-numbers-modes.js`.

### Renamed / changed

- Extension ID: `zaaack.markdown-editor` → `ocean1.markdown-editor-hardened`
- Display name: `Markdown Editor` → `Markdown Editor (Hardened)`
- Command name: `markdown-editor.openEditor` → `markdown-editor-hardened.openEditor`
- CustomEditor viewType: `markdown-editor.customEditor` → `markdown-editor-hardened.customEditor`
- Settings keys: `markdown-editor.*` → `markdown-editor-hardened.*`
- Removed setting: `markdown-editor.customCss` (security vector; see H3)
- New settings: `markdown-editor-hardened.customStylesheet` (workspace-relative
  CSS path), `markdown-editor-hardened.showLineNumbers` (boolean),
  `markdown-editor-hardened.defaultOpenOutline` (boolean)
- Keybinding unchanged: `cmd+shift+alt+m` (Mac) / `ctrl+shift+alt+m` (other)

### Tests

- 7 security PoCs in `tests/pocs/poc-h{1,2,3,4,5,6,9}-*.js`. Each PoC has
  two parts: (a) substrate-behavior demonstration (when applicable),
  (b) fork fix-property assertion. PoCs run in plain node + jsdom; no
  VS Code install required.
- 1 integration smoke test in `tests/integration/vditor-render.js`.
  Drives the bundled Lute markdown engine with a representative sample;
  asserts 17 render properties (headings, lists, code blocks, tables,
  inline formatting, links, images).
- 2 integration tests for the line-number gutter:
  `tests/integration/line-numbers.js` (drives the compiled
  `lineNumberScript` against a hand-built vditor-shaped DOM; toggle +
  mapping assertions) and `tests/integration/line-numbers-modes.js`
  (boots the REAL webview stack — `media/dist/main.js`, real vditor
  init, `acquireVsCodeApi` stub — in JSDOM and asserts the gutter works
  in `wysiwyg` AND `ir` modes; SV is documented unsupported).
- Test runner: `tests/run-all.js` aggregates results, exits non-zero on
  any failure. Invoked via `pnpm test` from the project root.

### CI

- **NEW** `.github/workflows/ci.yml` — runs on every push + every PR
  against master. Installs deps, runs `tsc --noEmit`, builds the webview
  bundle, verifies artifacts exist, runs `pnpm test`.
- `.github/workflows/main.yml` (deploy on tag) now ALSO runs the install
  + build + test sequence as a publish gate. A tagged release that fails
  any PoC will NOT publish.

### Docs

- Full SECURITY.md with the H1-H9 table, per-finding severity, regression
  PoC paths, the H2 reachability exploit walk-through, and the upstream-PR
  status table.
- README rewritten with the upstream-vs-fork comparison table, full
  install instructions, and per-PR credits.
- This CHANGELOG.

### T0 foundation (pre-T1)

- Forked from upstream `e78e49c` (0.1.14). (C0.1)
- Renamed everything to `markdown-editor-hardened` + defensive stub
  closing the H3 customCss vector before the full DC2 redesign in T1.
  (C0.2)
- Initial SECURITY.md, project-local `.scratchpad.md`, README. (C0.3)

## [0.1.14] — upstream, 2026-02-09

zaaack/vscode-markdown-editor's most recent tagged commit. Not published
to the Marketplace (the CI workflow has been broken since this tag —
see C1.1 / upstream PR #151). Contains the new `MarkdownEditorProvider`
(CustomTextEditor) path landed in PRs #136 and #144 + auto-sync-on-theme-
change.

## [0.1.13] — upstream, 2025-01-06

The currently-published Marketplace version of
[`zaaack.markdown-editor`](https://marketplace.visualstudio.com/items?itemName=zaaack.markdown-editor).
Still vulnerable to all seven audit findings (H1, H2, H3, H4, H5, H6, H9).
