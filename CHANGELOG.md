# Changelog

All notable changes to `markdown-editor-hardened` are documented here.

Format follows [Keep a Changelog 1.1.0](https://keepachangelog.com/en/1.1.0/).
Versioning: from the next release on, this fork uses its own independent
incrementing version line starting at `0.2.0` — plain Marketplace-compatible
semver, no pre-release suffix. The upstream base of each release is recorded
in that release's changelog entry (基点对账; the repo already tracks this).
Earlier releases used `upstream + -hardened.<N>` tags; that suffix collides
with semver pre-release semantics (the VS Marketplace rejects it) and was
dropped.

## [Unreleased]

## [0.2.3] — 2026-09-15

代码块工具栏升级为整条折叠开关，并修复编辑代码块时"一分为二"
（素码编辑区与高亮预览并存）的问题。基点对账：上游基点仍为
upstream main@033c624，无上游变更。

### 新功能

- **工具栏整条可折叠代码块**（PR #4）：整个工具栏条是全宽"药丸"
  ——悬停轻微变色（约 7.5% 加深）提示可点、高度即折叠态窄条高
  度；点击任意处（右侧换行/复制按钮除外）折叠/展开代码区，语言
  名右侧 chevron 随状态旋转；键盘 Enter/Space 同样激活。

### 修复

- **编辑代码块"一分为二"**（PR #4）：vditor 的 wysiwyg 模式原生
  在编辑时同时保留素码编辑区与下方高亮预览（经无增强对照页实测
  确认为原生行为）。现编辑时只显示单个素码编辑块，失焦后预览自
  动恢复并重新高亮；编辑块与后续内容的间距同步补回正常量级。
- **折叠交互与 vditor 编辑态串扰**（PR #4）：此前点击工具栏或按
  键盘会同时把代码块切进 vditor 的素码编辑模式（折叠时下方冒出
  素码区）；空格键在所见即所得/即时渲染模式下会被 vditor 当作编
  辑器输入拦截导致折叠开关收不到。现两类事件均在捕获阶段最先拦
  截并隔离，折叠归折叠、编辑归编辑。

## [0.2.2] — 2026-09-15

修复长代码块内部出现的多余竖直滚动条，并按参考设计图重做代码块
工具栏视觉。基点对账：上游基点仍为 upstream main@033c624，无上游
变更。

### 修复

- **长代码块内部竖直滚动条**（PR #3）：vditor 的 codeRender 按窗口
  高度给每个代码块的 `<code>` 设置 inline
  `max-height: window.outerHeight - 40px`，超过该高度的代码块被封
  顶，在块内生成第二个竖直滚动条，页面滚动与块内滚动并存。现以
  `max-height: none !important` 覆盖，代码块恢复自然高度，仅保留页
  面级滚动；导出/复制 HTML 走 Lute 从 markdown 源再生成，不受影响。
- **工具栏视觉重做为纯间距分区**（PR #3）：0.2.1 的微降明度层与下
  缘投影方案废弃。工具栏与代码区完全同底色、无边框无阴影，仅以间
  距分区——块顶→工具栏约 24px、工具栏墨迹底→代码首行墨迹顶 29px
  （像素级对齐参考图）；代码块外边框移除、圆角 12px。

## [0.2.1] — 2026-09-15

修复浅色主题下长代码块滚动时工具栏与代码"都看不清"的问题：工具栏
背景与代码区色差原本仅约 3.5% 且无任何边框阴影，滚动代码的顶缘紧贴
工具栏下缘硬切，两者糊成一片。现工具栏改为完全实底（视觉色与代码区
同源）、微降一档明度并以下缘柔和投影分界；同时移除从未生效的无效
吸顶定位（vditor 的滚动容器是 `code` 元素而非工具栏所在的 `pre`）。
基点对账：上游基点仍为 upstream main@033c624，无上游变更。

### 修复

- **代码块工具栏与滚动代码的层次分界**（PR #2）：实底多层背景
  （半透明主题变量叠不透明编辑器背景，任何主题下代码不会透出）、
  4.5% 微降明度层、下缘投影缓冲滚动切割、按钮避让滚动条轨道。

## [0.2.0] — 2026-09-15

本版聚焦代码块体验：每个代码块新增常驻工具栏（语言名 + 按块自动换行
+ 复制）、修复 ```jsonc 等 VS Code 风格语言标识完全无语法高亮的问
题、去除 vditor 原生棋盘格背景纹理；同时兜底修复 vditor 3.11.2 悬
浮工具条必然抛错的上游缺陷。首个独立版本号发布（此前为
`0.1.21-hardened.N` 序列）。

基点对账：上游基点仍为 upstream main@033c624，本版未引入上游新提
交，全部变更来自本仓库。

### 新功能

- **代码块头部栏与按块自动换行**：每个代码块顶部新增一行常驻工具栏——
  左侧 `</>` 图标与加粗的围栏语言名（无语言时显示 `text`），右侧为
  "启用自动换行"与"复制"两个图标按钮，深浅主题自动适配。自动换行按块
  独立切换、默认关闭、不跨编辑会话记忆；复制改用 Clipboard API 并带
  成功反馈（vditor 内置复制按钮的内联事件处理器在扩展 CSP 下本就无法
  执行，现一并隐藏）。mermaid 等图表块保持原有渲染不受影响；导出与
  复制的 Markdown/HTML 不包含工具栏。

- **语言别名高亮修复**：```jsonc、```shellscript、```mysql 等 VS Code
  风格的语言标识此前完全不显示语法高亮（highlight.js 不认识的标识会被
  回退为纯文本）。现已在加载时注册 22 个别名映射（jsonc→json、
  shellscript→bash、systemverilog→verilog、vue/svelte→xml 近似等），
  配色继续跟随 VS Code 主题（亮色 vs / 暗色 vs2015）。

### 其他改进

- **去除代码块棋盘格背景**：vditor 原生在代码块背景平铺一张内嵌 PNG
  形成纵横交错的棋盘纹理，现以纯色主题背景
  （`--vscode-textCodeBlock-background`）取代。

- **修复 vditor 3.11.2 悬浮工具条必然抛错的上游缺陷**：
  `customWysiwygToolbar` 是可选回调，但 vditor 在引用块/列表/表格等
  悬浮工具条路径上无空值守卫地调用它——此前每次打开悬浮工具条都会
  抛出未捕获 TypeError 并跳过定位逻辑。现以空回调兜底，内置按钮与
  定位恢复正常。

- **版本序列切换为独立递增**：下个发布起使用 `0.2.0` 起的独立版本号
  （Marketplace 兼容的纯 semver，无预发布后缀），上游基点对应关系由
  各版本段的"基点对账"说明承担。此前 `0.1.21-hardened.N` 式后缀与
  semver 预发布语义冲突，VS Code 市场拒收（`v0.1.21-hardened.2` 发布
  时实测），故弃用；已发布的历史 tag 保持原样不变。

## [0.1.21-hardened.2] — 2026-09-14

修复两个核心缺陷：外部编辑者的改动现在能实时进入已打开的编辑器视
图；编辑器快捷键不再同时触发 VS Code 自身的键绑定。同时收录上一版
"跟进上游移植"代码的审查修复（链接双发、SV 查找、页内锚点、白屏
等，见下方前半部分条目）。

### 修复

- **外部编辑实时同步**（`0ffa618` + `9306c9d`）：此前两个缺陷叠加
  导致 Agent 等外部编辑者的改动无法出现在已打开的编辑器里——
  (a) 本扩展的同步模型使文档几乎总处于"有未保存编辑"状态，而
  VS Code 在这种状态下对外部写盘完全静默（不重载、不通知），外部
  修改从此消失；(b) VS Code ≥1.137 中 `applyEdit` 的内容事件与磁
  盘重载形态完全一致，旧的 isDirty 启发式失效，既漏同步外部修改、
  又把编辑器自身的编辑误当外部修改回灌（每键一次全文重置）。
  现改为内容基线比较识别回声，并新增文件监视器兜底：磁盘分叉时提
  供「Load disk version / Keep my edits」二选一，绝不静默覆盖未保
  存编辑。该同步链经独立审查加固：批准加载前重读磁盘防止应用陈旧
  快照、BOM/不可解码内容不误报不污染正文、temp+rename 原子写不漏
  检、通知不因连续写盘而轰炸、面板关闭后不再出现幽灵通知，并修复
  EditorPanel 两个 workspace 监听器因传参错误导致的订阅泄漏。
- **编辑器快捷键不再穿透 VS Code 键绑定**（`0ffa618`）：VS Code 的
  webview 包装层把每个按键无条件转发给键绑定服务（不区分页面是否
  已消费），Ctrl+B 加粗的同时会打开侧栏。现对编辑器已消费的修饰组
  合在转发前截断；普通按键与未消费组合（如 Ctrl+Q）仍透传给
  VS Code，Ctrl+S 的保存链路不受影响。
- **点击链接只派发一次**（上游原样）：vditor 的 `link.isOpen` 默认为
  true，其点击处理器调用 `window.open(href)`，且在 `preventDefault()`
  之后不做 `stopPropagation` —— 事件继续冒泡到 document 上的
  `fixLinkClick`，同一个链接被派发两条 `open-link`（http 链接会打开两
  个浏览器标签页），页内锚点也被额外转发给宿主去当相对路径解析。现显
  式关闭 vditor 的链接打开（`link: { isOpen: false }`），交由
  `fixLinkClick` 统一处理——它已覆盖正文 `<a>`、IR 标记 span 与预览区
  三种形态。
- **SV 模式查找恒为 `0/0`**：vditor 把 `vditor-sv` 与 `vditor-reset`
  两个类放在**同一个元素**上，后代选择器 `.vditor-sv .vditor-reset`
  匹配不到；而上游固定的 IR 优先查询顺序在本 fork 的 WYSIWYG 默认模式
  下会命中非活动的空容器。活动容器的解析现抽为共享模块
  `media-src/src/editor-root.ts`，供查找条与锚点滚动共用。
- **切换模式后页内锚点失效**：`scrollToHeadingAnchor` 原用全局选择器，
  模式切换后第一个命中的是隐藏容器里的标题，`scrollIntoView` 作用在
  `display:none` 元素上等于没有反应（TOC 点了不动）。
- **含裸 `%` 的锚点抛未捕获异常**：`[见 100%](#100%)` 这类锚点会让
  `decodeURIComponent` 抛 `URIError` 并从点击处理器冒出；现回退为按原
  始片段匹配。
- **vditor 初始化失败导致永久白屏**：vditor 的 `after()` 回调在其资源
  加载 Promise 链内异步执行，失败无法被 webview 的 `try/catch` 捕获，
  `data-vmd-ready` 永不设置 → `#app` 永久不可见且用户无从恢复。现增加
  兜底：宿主脚本在 4 秒后强制揭示，webview 每次重建时重新武装该看门狗。
- **非活动面板被空脏态事件整篇回灌**：保存与自动保存产生的
  `contentChanges` 为空的事件，在面板非活动时会走完整回灌路径，重置阅读
  位置与光标。现于守卫之前短路（同时保留标题刷新）。
- **table-wrap 按钮激活态无视觉反馈**：vditor 的 `.vditor-icon--current`
  被更高特异度的规则压过；现按 body 类自有规则着色，且在 vditor 因主题
  变化重建后仍正确。
- 其余：滚动位置的记录做数值校验；FOUC 门禁纳入用户自定义样式表并对计
  数去重；`pollTimer` 的 TDZ 防御；多处注释的理由修正；`showLineNumbers`
  的描述如实说明其与磁盘文件的偏差（vditor 重排空行所致）。

### 测试

- `link-click.js` 重写为**真实栈**：此前用裸 JSDOM 加手造 DOM，与真实行
  为相反却通过（vditor 的 `link.isOpen` 路径完全不在其作用域内）。新增
  "恰好一条消息""锚点不转发""`#100%` 不抛错""忽略隐藏容器的标题"等行
  为断言。
- `find-bar.js` 覆盖 wysiwyg/ir/sv 三种模式，新增 CapsLock 用例、observer
  在 vditor 重建后重绑的用例，以及真实工具栏的 DOM 断言（此前的源码
  grep 检不出"改了源码却未重建 bundle"）。
- `line-numbers-modes.js` 把放宽的结构性断言改为固定真实值；
  `line-numbers.js` 注明其 `getValue` 桩的语义边界，避免被当作"行号等于
  源文件行号"的证据。
- 关键修复经变异测试验证确实可被捕获（回退修复即测试失败）。
- 新增外部同步与键盘转发的回归测试（`external-sync.js` 25 项：真实
  编译产物 + 按实测宿主事件形态重放的两条打开路径、回声抑制、
  watcher 兜底全链含 BOM/原子写/挂起通知/陈旧快照；`keyboard-
  forwarding.js` 7 项：window 级转发层复现与不过度拦截；`external-
  sync-webview.js`：webview 接收渲染链路）；另附真实 VS Code 事件形
  态探针（`tests/vscode-probe/`）。

## [0.1.21-hardened.1] — 2026-09-14

首个正式发布的加固版：关闭上游安全审计全部七项发现，并已同步
上游 0.1.21 的全部实质修复与功能（合并基点对账至
upstream main@033c624）。

T1 (security hardening) + T2 (polish, CI, docs) complete. First fork release.
All seven findings from the upstream audit are closed. All substantive
upstream fixes and features through upstream 0.1.21 are synced (merge
base reconciled to upstream main@033c624 via merge -s ours).

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

- Extension ID: `zaaack.markdown-editor` → `ONEGAYI.markdown-editor-hardened`
  （加固线始于 ocean1 仓库，随发布身份迁移到 ONEGAYI，扩展 ID 随之变更）
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

<!-- 变更链接 -->
[Unreleased]: https://github.com/ONEGAYI/vscode-markdown-editor-hardened/compare/v0.2.3...HEAD
[0.2.3]: https://github.com/ONEGAYI/vscode-markdown-editor-hardened/compare/v0.2.2...v0.2.3
[0.2.2]: https://github.com/ONEGAYI/vscode-markdown-editor-hardened/compare/v0.2.1...v0.2.2
[0.2.1]: https://github.com/ONEGAYI/vscode-markdown-editor-hardened/compare/v0.2.0...v0.2.1
[0.2.0]: https://github.com/ONEGAYI/vscode-markdown-editor-hardened/compare/v0.1.21-hardened.2...v0.2.0
[0.1.21-hardened.2]: https://github.com/ONEGAYI/vscode-markdown-editor-hardened/compare/v0.1.21-hardened.1...v0.1.21-hardened.2
[0.1.21-hardened.1]: https://github.com/ONEGAYI/vscode-markdown-editor-hardened/commits/v0.1.21-hardened.1
