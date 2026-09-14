import * as vscode from 'vscode'
import * as NodePath from 'path'
import { validateWorkspaceRelativePath } from './security/path-validation'
import { handleWebviewMessage, WebviewSession } from './webview/message-dispatcher'
import { scrollPositions } from './scroll-positions'
import { SyncTracker } from './sync-tracker'
import { attachExternalChangeWatcher } from './external-change-watcher'
const KeyVditorOptions = 'vditor.options'

function debug(...args: any[]) {
  console.log(...args)
}

function showError(msg: string) {
  vscode.window.showErrorMessage(`[markdown-editor-hardened] ${msg}`)
}

/**
 * Resolve the user's `customStylesheet` setting to a webview-safe URI string,
 * or null if the setting is unset/invalid.
 *
 * SECURITY (DC2 — closes H3, "customCss raw HTML injection"):
 *   Upstream's `customCss` setting interpolated arbitrary HTML into a
 *   <style> block in the webview, allowing a hostile `.vscode/settings.json`
 *   to break out with `</style><script>...`. This redesign replaces that
 *   string-of-CSS with a path-to-CSS:
 *     - VALUE IS A PATH (filename), not HTML/CSS content;
 *     - path must be workspace-relative (rejects absolute, traversal, URLs);
 *     - file must end in `.css` (rejects `.html`, `.js`, etc.);
 *     - emitted via <link rel="stylesheet">, not a content-interpolated
 *       <style> block;
 *     - the webview resolves the URL through `webview.asWebviewUri` so a
 *       cross-origin URL is unreachable.
 *   Combined with localResourceRoots scoping (DC3, C1.6) and CSP (DC4,
 *   C1.10), this fully closes the H3 chain even if the stylesheet path
 *   itself comes from a hostile workspace's settings.json.
 *
 *   If the input fails ANY validation step, returns null silently — the
 *   webview just renders without the custom stylesheet (fail-closed).
 */
/**
 * Generate a cryptographically-strong base64 nonce for CSP script-tag
 * gating. Each call returns a fresh ~32-byte random value, URL-safe
 * base64-encoded (no padding).
 */
function generateNonce(): string {
  const crypto = require('crypto') as typeof import('crypto')
  return crypto.randomBytes(24).toString('base64')
}

/**
 * Build the Content-Security-Policy meta tag content for the webview.
 *
 * SECURITY (DC4 — closes H6, "no CSP on webview HTML"):
 *   Upstream emitted webview HTML with no CSP meta tag, so the only
 *   webview-protection mechanism was VS Code's default sandbox. This
 *   left several defense-in-depth gaps:
 *     - any future XSS bug (via the H3 customCss chain, a vditor parse
 *       bug, etc.) would have unfettered access to fetch+exfil
 *     - inline-script injection via the H3 chain would have run
 *       (closed by C1.4, but CSP would have stopped it pre-fix)
 *     - data:/javascript: URI navigations via H5's open-link (closed
 *       by C1.9, but CSP frame-src/navigate-to provides defense in depth)
 *   With this CSP (and after C1.14's local vditor bundle):
 *     - default-src 'none' — DENY everything not explicitly allowlisted
 *     - script-src 'nonce-X' cspSource — nonce-gates our own script tags;
 *       cspSource for vditor's internally-loaded scripts (now served from
 *       the local media/vditor/ directory, not jsdelivr)
 *     - style-src cspSource 'unsafe-inline' — vditor heavily injects
 *       inline styles via DOM API; 'unsafe-inline' is the accepted
 *       trade-off here (scratchpad I3 tracks the long-term plan to
 *       tighten this)
 *     - img-src cspSource https: data: — markdown image refs (https
 *       remote, cspSource for workspace files, data: for vditor's
 *       inline-SVG icons)
 *     - font-src cspSource data: — vditor sometimes embeds fonts as
 *       data: URIs
 *     - media-src cspSource — <audio> tags emitted by media-src/main.ts
 *       when a .wav is uploaded
 *     - connect-src cspSource — strict same-origin (no jsdelivr after
 *       C1.14's local bundle)
 *
 *   What we INITIALLY set but had to REMOVE (the in-VS-Code smoke test
 *   of C3.1 surfaced these):
 *     - frame-src 'none'      — blocked VS Code's outer-iframe wrapper.
 *       The webview content is hosted inside a `vscode-webview://`
 *       iframe that VS Code creates; `frame-src 'none'` on our inner
 *       CSP applies to that iframe relationship and blocks the entire
 *       webview from loading ("blocked because of CSP" before any of
 *       our script runs).
 *     - object-src 'none'     — defensive against <object>/<embed>
 *       injection, but isn't a reachable threat inside the VS Code
 *       webview sandbox + had ambiguous interactions with VS Code's
 *       wrapper. Dropped alongside frame-src for safety.
 *     - base-uri 'none'/'self' — blocked our own <base href> tag.
 *       Dropped because VS Code's wrapper sets a base URI of its own
 *       which our CSP couldn't allow without naming the exact host.
 *
 *   The threats those three were guarding against are still mostly
 *   covered: default-src 'none' blocks any tag not explicitly
 *   allowlisted; script-src 'nonce-X' blocks unauthorized scripts.
 *   The residual loss is defense-in-depth (<object>/<embed>/<base>
 *   injection); none of these are reachable via markdown content
 *   (Lute strips them) and our same-origin connect-src + nonce-gated
 *   script-src already block exfil even if injection were possible.
 *
 * @param webview to read `webview.cspSource` (the webview's own origin)
 * @param nonce   a fresh base64 nonce — same value must be used in the
 *                `<script nonce="...">` attributes on our script tags
 */
function buildCspMeta(webview: vscode.Webview, nonce: string): string {
  const cspSource = webview.cspSource
  // After C1.14 (vditor bundled locally), the CSP is strictly same-origin
  // (cspSource only). The previous allowlist for https://cdn.jsdelivr.net
  // is GONE — vditor's runtime asset loader now reads from the local
  // `media/vditor/` directory via the host-set `__vditorCdn` window
  // global; no jsdelivr fetch fires at runtime.
  const csp = [
    `default-src 'none'`,
    `script-src 'nonce-${nonce}' ${cspSource}`,
    `style-src ${cspSource} 'unsafe-inline'`,
    `img-src ${cspSource} https: data:`,
    `font-src ${cspSource} data:`,
    `media-src ${cspSource}`,
    `connect-src ${cspSource}`,
    // frame-src / object-src / base-uri intentionally OMITTED — see
    // the JSDoc above for why. They blocked VS Code's webview wrapper.
  ].join('; ')
  return `<meta http-equiv="Content-Security-Policy" content="${csp}">`
}

/**
 * Build the scoped `localResourceRoots` array for the webview.
 *
 * SECURITY (DC3 — closes H1, "over-broad localResourceRoots"):
 *   Upstream set `localResourceRoots: [Uri.file("/"), Uri.file("A:/"), ...,
 *   Uri.file("Z:/")]` — granting the webview read access to every file on
 *   the system (or every drive on Windows). This was a defense-in-depth
 *   weakness: if the webview JS were ever compromised (via a XSS chain,
 *   compromised CDN, etc.), it could read arbitrary local files via the
 *   webview's URI-mapping facility.
 *
 *   The redesign scopes the roots to what the extension actually needs:
 *     - extensionUri      — to load the bundled webview JS/CSS
 *     - workspace folders — to load images by workspace-relative path
 *     - current file dir  — to load images by file-relative path
 *
 *   Images outside the workspace (e.g., a user dragging in an image from
 *   /tmp) used to work via the `/` root. With this scope, they fail to
 *   load — the user gets a broken-image icon. This is a small UX cost
 *   for a meaningful defense-in-depth win. The full local-bundle of
 *   vditor (DC7 / C1.14) keeps the extensionUri root sufficient for the
 *   editor itself.
 */
function scopedLocalResourceRoots(
  extensionUri: vscode.Uri,
  fileUri?: vscode.Uri
): vscode.Uri[] {
  const roots: vscode.Uri[] = [extensionUri]
  if (vscode.workspace.workspaceFolders) {
    for (const wsFolder of vscode.workspace.workspaceFolders) {
      roots.push(wsFolder.uri)
    }
  }
  if (fileUri) {
    // The file's containing directory. Useful when the file is not under
    // any workspace folder (e.g. opened directly via Finder/Explorer).
    const fileDir = vscode.Uri.file(NodePath.dirname(fileUri.fsPath))
    roots.push(fileDir)
  }
  return roots
}

function resolveCustomStylesheet(
  webview: vscode.Webview,
  fileUri: vscode.Uri,
  configRaw: string | undefined
): string | null {
  const wsFolder = vscode.workspace.getWorkspaceFolder(fileUri)
  if (!wsFolder) return null

  const result = validateWorkspaceRelativePath(
    configRaw,
    wsFolder.uri.fsPath,
    '.css'
  )
  if (!result.ok) return null

  return webview.asWebviewUri(vscode.Uri.file(result.resolved)).toString()
}

export function activate(context: vscode.ExtensionContext) {
  // Register original command (used by context menu/shortcuts)
  context.subscriptions.push(
    vscode.commands.registerCommand(
      'markdown-editor-hardened.openEditor',
      (uri?: vscode.Uri, ...args) => {
        debug('command', uri, args)
        EditorPanel.createOrShow(context, uri)
      }
    )
  )

  // Register CustomTextEditorProvider (for "Open With" and default editor)
  context.subscriptions.push(
    vscode.window.registerCustomEditorProvider(
      MarkdownEditorProvider.viewType,
      new MarkdownEditorProvider(context),
      {
        webviewOptions: {
          retainContextWhenHidden: true,
        },
        supportsMultipleEditorsPerDocument: false,
      }
    )
  )

  context.globalState.setKeysForSync([KeyVditorOptions])
}

/**
 * Manages cat coding webview panels
 */
class EditorPanel {
  /**
   * Track the currently panel. Only allow a single panel to exist at a time.
   */
  public static currentPanel: EditorPanel | undefined

  public static readonly viewType = 'markdown-editor-hardened'

  private _disposables: vscode.Disposable[] = []

  public static async createOrShow(
    context: vscode.ExtensionContext,
    uri?: vscode.Uri
  ) {
    const { extensionUri } = context
    const column = vscode.window.activeTextEditor
      ? vscode.window.activeTextEditor.viewColumn
      : undefined
    if (EditorPanel.currentPanel && uri !== EditorPanel.currentPanel?._uri) {
      EditorPanel.currentPanel.dispose()
    }
    // If we already have a panel, show it.
    if (EditorPanel.currentPanel) {
      EditorPanel.currentPanel._panel.reveal(column)
      // Per upstream PR #154 — credit LeonardoRick. Tell the webview to
      // refocus on re-reveal so users don't have to click into the
      // editor before typing.
      EditorPanel.currentPanel._panel.webview.postMessage({ command: 'focus' })
      return
    }
    if (!vscode.window.activeTextEditor && !uri) {
      showError(`Did not open markdown file!`)
      return
    }
    let doc: undefined | vscode.TextDocument
    // From context menu: Find if there is a markdown editor for the current active TextEditor, if so bind the document
    if (uri) {
      // Open file from context menu: Open document first then enable auto-sync, otherwise cannot save file or sync to opened document
      doc = await vscode.workspace.openTextDocument(uri)
    } else {
      doc = vscode.window.activeTextEditor?.document
      // from command mode
      if (doc && doc.languageId !== 'markdown') {
        showError(
          `Current file language is not markdown, got ${doc.languageId}`
        )
        return
      }
    }

    if (!doc) {
      showError(`Cannot find markdown file!`)
      return
    }

    // Otherwise, create a new panel.
    const panel = vscode.window.createWebviewPanel(
      EditorPanel.viewType,
      'markdown-editor-hardened',
      column || vscode.ViewColumn.One,
      EditorPanel.getWebviewOptions(extensionUri, uri ?? doc?.uri)
    )

    EditorPanel.currentPanel = new EditorPanel(
      context,
      panel,
      extensionUri,
      doc,
      uri
    )
  }

  static getWebviewOptions(
    extensionUri: vscode.Uri,
    fileUri?: vscode.Uri
  ): vscode.WebviewOptions & vscode.WebviewPanelOptions {
    return {
      // Enable javascript in the webview
      enableScripts: true,

      // SECURITY (DC3, closes H1 — over-broad localResourceRoots):
      //   Scoped to extension dir + workspace folders + current file dir,
      //   replacing upstream's `[Uri.file("/"), Uri.file("A:/")..Uri.file("Z:/")]`
      //   which granted webview read access to the entire filesystem. See
      //   `scopedLocalResourceRoots` doc for the full rationale.
      localResourceRoots: scopedLocalResourceRoots(extensionUri, fileUri),
      retainContextWhenHidden: true,
      // Enables Cmd+F / Ctrl+F find widget in the webview panel (upstream
      // PR #153 — credit LeonardoRick). VS Code's built-in find UI; no
      // additional code needed beyond this flag.
      enableFindWidget: true,
      // SECURITY (DC1, closes H2 — RCE via crafted markdown command: URI):
      //   `enableCommandUris: true` was set in upstream; it allows any rendered
      //   <a href="command:..."> in the webview to dispatch arbitrary VS Code
      //   commands when clicked. Combined with the fact that vditor's markdown
      //   sanitizer (Lute) does NOT strip `command:` URIs from rendered links
      //   (verified by programmatic test in vditor 3.8.4 AND 3.11.2), opening a
      //   crafted markdown file via this command-mode panel and clicking the
      //   link executed arbitrary commands (e.g.,
      //   workbench.action.terminal.sendSequence with shell text).
      //   Default (option omitted) is `false` — clicks on command: URIs become
      //   inert. The link still renders in the DOM but cannot fire commands.
    }
  }
  private get _fsPath() {
    return this._uri.fsPath
  }

  static get config() {
    return vscode.workspace.getConfiguration('markdown-editor-hardened')
  }

  /**
   * The line-number gutter feature from upstream PR #157 (asalcedo29),
   * adapted for our CSP: the inline <script> is nonce-gated with the
   * per-render nonce, and the surrounding <style> stays uncompromised
   * (we rely on `style-src 'unsafe-inline'` — same trade-off as the
   * rest of vditor's dynamic style injection).
   *
   * The script reads the LIVE editor value (`vditor.getValue()`) to map
   * rendered blocks back to source line numbers (upstream 9b4f158 — a
   * startup-only `__setOrigContent` snapshot drifted out of sync with
   * the rendered blocks as soon as the document was edited). It
   * observes vditor's DOM mutations and keeps the gutter in sync;
   * toggles via a `#` toolbar button.
   *
   * MODE FIX (toggle-line-numbers-dead bug): vditor 3.11 keeps ALL
   * THREE mode containers (.vditor-wysiwyg, .vditor-sv, .vditor-ir) in
   * the DOM at once; only the active one is displayed and holds
   * rendered block children. A bare document.querySelector returns the
   * first container in document order (.vditor-wysiwyg) regardless of
   * the active mode, so for users whose saved mode is 'ir' (the old
   * default, persisted in globalState) or 'sv' the script measured a
   * hidden empty container, the gutter was never created, and the `#`
   * toggle button did nothing (its handler only flips display on an
   * #ln-gutter that never exists). `pick()` below resolves the ACTIVE
   * mode's container via vditor.getCurrentMode(), with a "container
   * that actually has block children" fallback. SV (source-split) mode
   * has no block editing surface and remains unsupported — the script
   * simply no-ops there.
   *
   * Long term (DC12 / T3): move this script into media-src/main.ts so
   * the bundle owns the logic and no inline script is needed. For now,
   * we ship #157's logic verbatim with the nonce.
   */
  static lineNumberScript(nonce: string): string {
    return `<style>
.vditor-ir .vditor-reset,.vditor-wysiwyg .vditor-reset,.vditor-sv .vditor-reset{padding-left:60px!important}
.vditor-toolbar.vditor-toolbar--pin{padding-left:60px!important}
#ln-gutter{position:fixed;width:32px;pointer-events:none;user-select:none;z-index:10;overflow:hidden;border-right:1px solid rgba(128,128,128,0.12)}
#ln-gutter .ln{position:absolute;width:26px;text-align:right;font-size:11px;font-family:'Cascadia Code','Consolas',monospace;color:rgba(150,150,150,0.5);line-height:1}
</style>
<script nonce="${nonce}">
(function(){
  window.__lnEnabled=true;
  var listening=false;
  var listenedIr=null,obs=null,observedReset=null;
  function pick(){
    var mode=null;
    try{if(window.vditor&&window.vditor.getCurrentMode)mode=window.vditor.getCurrentMode()}catch(e){}
    var ir=null,reset=null;
    if(mode==='ir'||mode==='wysiwyg'||mode==='sv'){
      ir=document.querySelector('.vditor-'+mode);
      if(ir)reset=ir.querySelector('.vditor-reset');
    }
    if(!reset||!ir||reset.children.length===0){
      var list=document.querySelectorAll('.vditor-ir,.vditor-wysiwyg,.vditor-sv');
      for(var k=0;k<list.length;k++){
        var r=list[k].querySelector('.vditor-reset');
        if(r&&r.children.length>0){ir=list[k];reset=r;break}
      }
    }
    return {ir:ir,reset:reset};
  }
  function addToggle(){
    if(document.getElementById('ln-toggle'))return;
    var tb=document.querySelector('.vditor-toolbar');
    if(!tb)return;
    var btn=document.createElement('button');
    btn.id='ln-toggle';
    btn.type='button';
    btn.className='vditor-tooltipped vditor-tooltipped__s';
    btn.setAttribute('aria-label','Toggle line numbers');
    btn.style.cssText='background:none;border:none;cursor:pointer;padding:4px 3px;color:inherit;font:11px monospace;opacity:0.7;margin-left:2px';
    btn.textContent='#';
    btn.onclick=function(){
      window.__lnEnabled=!window.__lnEnabled;
      btn.style.opacity=window.__lnEnabled?'0.7':'0.3';
      var g=document.getElementById('ln-gutter');
      if(g)g.style.display=window.__lnEnabled?'':'none';
      var pk=pick();
      if(pk.reset)pk.reset.style.setProperty('padding-left',window.__lnEnabled?'60px':'35px','important');
      if(tb)tb.style.setProperty('padding-left',window.__lnEnabled?'60px':'35px','important');
    };
    tb.appendChild(btn);
  }
  function sync(){
    addToggle();
    if(!window.__lnEnabled)return;
    var pk=pick();
    var reset=pk.reset;
    var ir=pk.ir;
    if(!reset||!ir||reset.children.length===0) return;
    var g=document.getElementById('ln-gutter');
    if(!g){g=document.createElement('div');g.id='ln-gutter';document.body.appendChild(g)}
    var irRect=ir.getBoundingClientRect();
    g.style.left=irRect.left+'px';
    g.style.top=irRect.top+'px';
    g.style.height=irRect.height+'px';
    var kids=[];
    for(var j=0;j<reset.children.length;j++){
      var c=reset.children[j];
      if(c.offsetHeight>0&&c.id!=='fix-table-ir-wrapper') kids.push(c);
    }
    var srcLines=[];
    try{
      // Always read the live editor value instead of a snapshot received once at
      // startup: a stale snapshot drifts out of sync with the rendered blocks as
      // soon as the document is edited, producing wrong line numbers.
      var src=(window.vditor&&window.vditor.getValue)?(window.vditor.getValue()||''):'';
      var NL=String.fromCharCode(10);
      var L=src.split(NL);
      var starts=[];
      var i=0;var fence=String.fromCharCode(96,96,96);
      if(L.length>0&&L[0].trim()==='---'){
        starts.push(1);i=1;
        while(i<L.length&&L[i].trim()!=='---')i++;
        if(i<L.length)i++;
      }
      while(i<L.length){
        if(L[i].trim()===''){i++;continue}
        starts.push(i+1);
        var tr=L[i].trim();
        var rH=/^#{1,6} /;var rHR=/^(---|[*]{3}|___)$/;var rLI=/^[-*+] /;var rOL=/^[0-9]+[.)] /;var rIND=/^ +[^ ]/;
        function isBlock(s){return rH.test(s)||rLI.test(s)||rOL.test(s)||s.indexOf(fence)===0||s.charAt(0)==='|'||s.charAt(0)==='>'||rHR.test(s)}
        if(rH.test(tr)||rHR.test(tr)){i++}
        else if(tr.indexOf(fence)===0){
          i++;while(i<L.length&&L[i].trim().indexOf(fence)!==0)i++;
          if(i<L.length)i++;
        }else if(tr.charAt(0)==='|'){
          while(i<L.length&&L[i].trim().charAt(0)==='|')i++;
        }else if(tr.charAt(0)==='>'){
          while(i<L.length&&L[i].trim()!==''&&L[i].trimStart().charAt(0)==='>')i++;
        }else if(rLI.test(tr)||rOL.test(tr)){
          while(i<L.length){
            if(L[i].trim()===''){
              var nx=i+1;while(nx<L.length&&L[nx].trim()==='')nx++;
              if(nx<L.length&&(rLI.test(L[nx].trim())||rOL.test(L[nx].trim())||rIND.test(L[nx]))){i=nx}else break;
            }else{i++}
          }
        }else{
          i++;while(i<L.length&&L[i].trim()!==''){if(isBlock(L[i].trim()))break;i++}
        }
      }
      for(var j=0;j<kids.length;j++) srcLines.push(j<starts.length?starts[j]:j+1);
    }catch(e){for(var j=0;j<kids.length;j++) srcLines.push(j+1)}
    var html='';
    for(var j=0;j<kids.length;j++){
      var el=kids[j];
      var rect=el.getBoundingClientRect();
      var t=rect.top-irRect.top;
      if(t+rect.height<0||t>irRect.height) continue;
      var style=window.getComputedStyle(el);
      var fs=parseFloat(style.fontSize)||16;
      var lh=parseFloat(style.lineHeight);
      if(isNaN(lh)) lh=fs*1.6;
      var numTop=t+(lh/2)-5;
      html+='<div class="ln" style="top:'+numTop+'px">'+srcLines[j]+'</div>';
    }
    g.innerHTML=html;
    if(!listening){
      listening=true;
      document.addEventListener('scroll',sync,true);
    }
    if(listenedIr!==ir){
      ir.addEventListener('scroll',sync);
      listenedIr=ir;
    }
    if(observedReset!==reset){
      if(obs)obs.disconnect();
      obs=new MutationObserver(function(){requestAnimationFrame(sync)});
      obs.observe(reset,{childList:true,subtree:true,characterData:true});
      observedReset=reset;
    }
  }
  setInterval(sync,500);
})();
</script>`
  }

  private constructor(
    private readonly _context: vscode.ExtensionContext,
    private readonly _panel: vscode.WebviewPanel,
    private readonly _extensionUri: vscode.Uri,
    public _document: vscode.TextDocument,
    public _uri = _document.uri // Opened from explorer, only uri exists, no _document
  ) {
    // Set the webview's initial html content

    this._init()

    // Listen for when the panel is disposed
    // This happens when the user closes the panel or when the panel is closed programmatically
    this._panel.onDidDispose(() => this.dispose(), null, this._disposables)
    let textEditTimer: NodeJS.Timeout | void
    // close EditorPanel when vsc editor is close
    vscode.workspace.onDidCloseTextDocument((e) => {
      if (e.fileName === this._fsPath) {
        this.dispose()
      }
    }, this._disposables)
    // External-change backstop: while the document is DIRTY, VS Code refuses
    // to reload it on disk writes (measured — see
    // src/external-change-watcher.ts), so agent edits would vanish silently.
    attachExternalChangeWatcher(this._document, this._disposables)
    // re-init webview when VS Code theme changes
    vscode.window.onDidChangeActiveColorTheme((theme) => {
      this._update({
        type: 'init',
        options: {
          useVscodeThemeColor: EditorPanel.config.get<boolean>(
            'useVscodeThemeColor'
          ),
          showLineNumbers: EditorPanel.config.get<boolean>(
            'showLineNumbers'
          ),
          // Upstream db2062c: defaultOpenOutline — keep in sync with the
          // option assembly in message-dispatcher.ts ('ready').
          outline: {
            enable:
              EditorPanel.config.get<boolean>('defaultOpenOutline') === true,
          },
          ...this._context.globalState.get(KeyVditorOptions),
        },
        theme: theme.kind === vscode.ColorThemeKind.Dark ? 'dark' : 'light',
      })
    }, null, this._disposables)
    // update EditorPanel when vsc editor changes
    vscode.workspace.onDidChangeTextDocument((e) => {
      if (e.document.fileName !== this._document.fileName) {
        return
      }
      // A pure dirty-state transition (empty contentChanges — every save,
      // including autosave) carries no new text. Refresh the title from it,
      // but never push the document back into the webview: that would reset
      // the reading position and cursor.
      this._updateEditTitle()
      if (e.contentChanges.length === 0) {
        return
      }
      // Echo test by content, not by event shape: VS Code ≥1.137 emits an
      // applyEdit's content-change event BEFORE the dirty flag flips, so
      // the webview's own sync is indistinguishable from a disk reload by
      // shape (measured in tests/vscode-probe). Text equal to the last
      // synced content is our own echo — skip it; anything else (disk
      // reload, another extension's applyEdit) is new — push it.
      if (this._tracker.isEcho(e.document.getText())) {
        return
      }
      textEditTimer && clearTimeout(textEditTimer)
      textEditTimer = setTimeout(() => {
        this._update()
      }, 300)
    }, this._disposables)
    // Handle messages from the webview — dispatched through the shared
    // `handleWebviewMessage` (DC12). This class only provides the
    // per-session bindings (panel, document, fileUri, context, callbacks);
    // the command switch + per-message logic lives in
    // src/webview/message-dispatcher.ts.
    const session: WebviewSession = {
      webview: this._panel.webview,
      isActive: () => this._panel.active,
      fileUri: this._uri,
      document: this._document,
      context: this._context,
      tracker: this._tracker,
      postUpdate: (props) => this._update(props),
      onEditApplied: () => this._updateEditTitle(),
    }
    this._panel.webview.onDidReceiveMessage(
      async (message) => {
        await handleWebviewMessage(message, session)
      },
      null,
      this._disposables
    )
  }

  static getAssetsFolder(uri: vscode.Uri) {
    const imageSaveFolder = (
      EditorPanel.config.get<string>('imageSaveFolder') || 'assets'
    )
      .replace(
        '${projectRoot}',
        vscode.workspace.getWorkspaceFolder(uri)?.uri.fsPath || ''
      )
      .replace('${file}', uri.fsPath)
      .replace(
        '${fileBasenameNoExtension}',
        NodePath.basename(uri.fsPath, NodePath.extname(uri.fsPath))
      )
      .replace('${dir}', NodePath.dirname(uri.fsPath))
    const assetsFolder = NodePath.resolve(
      NodePath.dirname(uri.fsPath),
      imageSaveFolder
    )
    return assetsFolder
  }

  public dispose() {
    EditorPanel.currentPanel = undefined

    // Clean up our resources
    this._panel.dispose()

    while (this._disposables.length) {
      const x = this._disposables.pop()
      if (x) {
        x.dispose()
      }
    }
  }

  private _init() {
    const webview = this._panel.webview

    this._panel.webview.html = this._getHtmlForWebview(webview)
    this._panel.title = NodePath.basename(this._fsPath)
  }
  private _isEdit = false
  /** Content-sync state shared with the document-change listener (DC-sync). */
  private readonly _tracker = new SyncTracker()
  private _updateEditTitle() {
    const isEdit = this._document.isDirty
    if (isEdit !== this._isEdit) {
      this._isEdit = isEdit
      this._panel.title = `${isEdit ? `[edit]` : ''}${NodePath.basename(
        this._fsPath
      )}`
    }
  }

  // private fileToWebviewUri = (f: string) => {
  //   return this._panel.webview.asWebviewUri(vscode.Uri.file(f)).toString()
  // }

  private async _update(
    props: {
      type?: 'init' | 'update'
      options?: any
      theme?: 'dark' | 'light'
    } = { options: void 0 }
  ) {
    const md = this._document
      ? this._document.getText()
      : (await vscode.workspace.fs.readFile(this._uri)).toString()
    // What we push is, by construction, the content the webview will hold
    // next — the document listener needs it as the new echo baseline.
    this._tracker.notePostedToWebview(md)
    // const dir = NodePath.dirname(this._document.fileName)
    this._panel.webview.postMessage({
      command: 'update',
      content: md,
      // Upstream 9c8e962: restore the remembered reading position on
      // (re)init — the webview is disposed/recreated per file switch.
      ...(props.type === 'init'
        ? { scrollTop: scrollPositions.get(this._fsPath) || 0 }
        : {}),
      ...props,
    })
  }

  private _getHtmlForWebview(webview: vscode.Webview) {
    const toUri = (f: string) =>
      webview.asWebviewUri(vscode.Uri.joinPath(this._extensionUri, f))
    const baseHref =
      NodePath.dirname(
        webview.asWebviewUri(vscode.Uri.file(this._fsPath)).toString()
      ) + '/'
    const toMediaPath = (f: string) => `media/dist/${f}`
    const JsFiles = ['main.js'].map(toMediaPath).map(toUri)
    const CssFiles = ['main.css'].map(toMediaPath).map(toUri)

    // DC7 / C1.14: locally-bundled vditor assets URL. vditor's runtime
    // loader builds asset URLs as `${cdn}/dist/js/lute/lute.min.js`,
    // etc. — it appends `/dist/...` to whatever cdn value it's given.
    // Our copy script (media-src/copy-vditor-assets.js) places the
    // files at `media/vditor/dist/js/...` so vditor's pattern resolves
    // cleanly with cdn set to the URL of `media/vditor`. The webview's
    // entry script (main.ts) reads `window.__vditorCdn` (set by the
    // nonced inline script below) and passes it as the Vditor
    // constructor's `cdn` option.
    const vditorCdnUri = toUri('media/vditor').toString()

    // DC2 redesign of the upstream `customCss` setting — see
    // `resolveCustomStylesheet` for the security rationale. Returns a
    // webview-safe URI string OR null. null = no extra stylesheet.
    const customStylesheetUri = resolveCustomStylesheet(
      webview,
      this._uri,
      EditorPanel.config.get<string>('customStylesheet')
    )
    const customStylesheetLink = customStylesheetUri
      ? `<link href="${customStylesheetUri}" rel="stylesheet" data-vmd-css="1">`
      : ''

    // DC4: per-render CSP nonce. Each render gets a fresh nonce; only
    // script tags carrying this exact value are allowed to execute.
    const nonce = generateNonce()

    return (
      `<!DOCTYPE html>
			<html lang="en">
			<head>
				<meta charset="UTF-8">
				${buildCspMeta(webview, nonce)}

				<meta name="viewport" content="width=device-width, initial-scale=1.0">
				<base href="${baseHref}" />


				<style>#app{opacity:0}html[data-vmd-ready="1"][data-vmd-css-loaded="1"] #app{opacity:1}</style>
				${CssFiles.map((f) => `<link href="${f}" rel="stylesheet" data-vmd-css="1">`).join('\n')}
				${customStylesheetLink}
				<script nonce="${nonce}">
					// CSP adaptation of upstream 9c8e962's onload= attributes:
					// inline event handlers are blocked by script-src 'nonce-…',
					// so wire the load handlers from this nonce-gated script.
					// Sets html[data-vmd-css-loaded] which, together with
					// html[data-vmd-ready] (set from main.ts once Vditor is up
					// and the saved scroll position applied), reveals #app.
					(function(){
						var links=document.querySelectorAll('link[data-vmd-css="1"]');
						var finish=function(){document.documentElement.setAttribute('data-vmd-css-loaded','1')};
						if(!links.length){finish()}else{
							// Dedupe: a stylesheet that is ALREADY loaded fires no
							// load event, so link.sheet is counted instead — the
							// same link must not be counted twice.
							var pending=[];
							var fin=function(l){
								if(pending.indexOf(l)!==-1){pending.splice(pending.indexOf(l),1)}
								if(!pending.length)finish()
							};
							for(var i=0;i<links.length;i++){pending.push(links[i])}
							for(var i=0;i<links.length;i++){
								var l=links[i];
								if(l.sheet){fin(l);continue}
								l.onload=function(){fin(this)};
								l.onerror=function(){fin(this)};
							}
							if(!pending.length)finish()
						}
						// Safety net for THIS page load: vditor runs its after()
						// callback inside the promise chain of its asset loader, so a
						// failure there can never reach main.ts's try/catch and
						// data-vmd-ready would never be set — leaving #app invisible
						// with no way for the user to recover. Reveal anyway after a
						// grace period: a half-built editor beats a blank page.
						// main.ts re-arms its own watchdog on every (re)init, so this
						// one only has to cover a bundle that never started at all.
						setTimeout(function(){
							if(!document.documentElement.hasAttribute('data-vmd-ready')){
								document.documentElement.setAttribute('data-vmd-ready','1');
							}
						},4000);
					})();
				</script>

				<title>markdown editor</title>
			</head>
			<body>
				<div id="app"></div>

				<script nonce="${nonce}">window.__vditorCdn=${JSON.stringify(vditorCdnUri)};</script>
				<!-- Pre-load vditor's icon set via a normal <script> tag so vditor's
				     internal loader (which uses XHR — broken in VS Code webviews due
				     to the webview-resource scheme not resolving via DNS) finds the
				     existing element-id="vditorIconScript" and short-circuits.
				     Without this, vditor's init aborts on ERR_NAME_NOT_RESOLVED. -->
				<script nonce="${nonce}" id="vditorIconScript" src="${vditorCdnUri}/dist/js/icons/ant.js"></script>
				${JsFiles.map((f) => `<script nonce="${nonce}" src="${f}"></script>`).join('\n')}
				${EditorPanel.config.get<boolean>('showLineNumbers') !== false ? EditorPanel.lineNumberScript(nonce) : ''}
			</body>
			</html>`
    )
  }
}

/**
 * MarkdownEditorProvider implements CustomTextEditorProvider interface
 * Supports opening markdown files via "Open With"
 */
class MarkdownEditorProvider implements vscode.CustomTextEditorProvider {
  public static readonly viewType = 'markdown-editor-hardened.customEditor'

  constructor(private readonly context: vscode.ExtensionContext) { }

  /**
   * Called when user selects Markdown Editor via "Open With"
   */
  public async resolveCustomTextEditor(
    document: vscode.TextDocument,
    webviewPanel: vscode.WebviewPanel,
    _token: vscode.CancellationToken
  ): Promise<void> {
    // Set webview options
    webviewPanel.webview.options = this.getWebviewOptions(document.uri)

    // Init webview content
    const uri = document.uri
    webviewPanel.webview.html = this.getHtmlForWebview(webviewPanel.webview, uri)
    webviewPanel.title = NodePath.basename(uri.fsPath)

    const disposables: vscode.Disposable[] = []
    let isEditing = false
    // Content-sync state shared between this listener and the webview
    // message handlers (see src/sync-tracker.ts).
    const tracker = new SyncTracker()

    // Update title to show edit status
    const updateEditTitle = () => {
      const isDirty = document.isDirty
      if (isDirty !== isEditing) {
        isEditing = isDirty
        webviewPanel.title = `${isDirty ? '[edit]' : ''}${NodePath.basename(uri.fsPath)}`
      }
    }

    // Send update to webview
    const updateWebview = (props: { type?: 'init' | 'update'; options?: any; theme?: 'dark' | 'light' } = {}) => {
      const content = document.getText()
      // What we push is the content the webview will hold next — the
      // document listener needs it as the new echo baseline.
      tracker.notePostedToWebview(content)
      webviewPanel.webview.postMessage({
        command: 'update',
        content,
        // Upstream 9c8e962: restore the remembered reading position on
        // (re)init — the webview is disposed/recreated per file switch.
        ...(props.type === 'init'
          ? { scrollTop: scrollPositions.get(uri.fsPath) || 0 }
          : {}),
        ...props,
      })
    }

    // Listen for document close
    vscode.workspace.onDidCloseTextDocument((e) => {
      if (e.fileName === uri.fsPath) {
        webviewPanel.dispose()
      }
    }, null, disposables)

    // External-change backstop: while the document is DIRTY, VS Code refuses
    // to reload it on disk writes (measured — see
    // src/external-change-watcher.ts), so agent edits would vanish silently.
    attachExternalChangeWatcher(document, disposables)

    // Listen for document changes (sync from external editor to webview)
    vscode.workspace.onDidChangeTextDocument((e) => {
      if (e.document.fileName !== document.fileName) {
        return
      }
      // Empty contentChanges = pure dirty-state transition (a save). Update the
      // title from it, but do not re-send the document — see the matching guard
      // in EditorPanel's listener for the full rationale.
      updateEditTitle()
      if (e.contentChanges.length === 0) {
        return
      }
      // Echo test by content, not by event shape — VS Code ≥1.137 fires an
      // applyEdit's content-change event BEFORE the dirty flag flips, so the
      // webview's own sync and a disk reload are indistinguishable by shape
      // (measured in tests/vscode-probe). Equal-to-last-synced content is our
      // own echo; anything else is an external edit (disk reload, another
      // extension's applyEdit) and must reach the webview.
      if (tracker.isEcho(e.document.getText())) {
        return
      }
      updateWebview()
    }, null, disposables)

    // Handle messages from webview — shared dispatcher (DC12). See
    // src/webview/message-dispatcher.ts for the command switch.
    const session: WebviewSession = {
      webview: webviewPanel.webview,
      isActive: () => webviewPanel.active,
      fileUri: uri,
      document,
      context: this.context,
      tracker,
      postUpdate: (props) => updateWebview(props ?? {}),
      onEditApplied: updateEditTitle,
    }
    webviewPanel.webview.onDidReceiveMessage(
      async (message) => {
        await handleWebviewMessage(message, session)
      },
      null,
      disposables
    )

    // Clean up resources
    webviewPanel.onDidDispose(() => {
      disposables.forEach((d) => d.dispose())
    })
  }

  private getWebviewOptions(fileUri?: vscode.Uri): vscode.WebviewOptions & vscode.WebviewPanelOptions {
    return {
      enableScripts: true,
      // SECURITY (DC3, closes H1 — over-broad localResourceRoots):
      //   See `scopedLocalResourceRoots` doc + EditorPanel.getWebviewOptions
      //   for the rationale. Same scope policy as the command-mode panel.
      localResourceRoots: scopedLocalResourceRoots(this.context.extensionUri, fileUri),
      // Upstream dd933af: keep webview state when the tab is hidden
      // (scroll position, find bar), and offer VS Code's native find
      // widget alongside the in-editor find bar (media-src/src/search.ts).
      retainContextWhenHidden: true,
      enableFindWidget: true,
    }
  }

  private getHtmlForWebview(webview: vscode.Webview, uri: vscode.Uri): string {
    const toUri = (f: string) => webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, f))
    const baseHref = NodePath.dirname(webview.asWebviewUri(vscode.Uri.file(uri.fsPath)).toString()) + '/'
    const toMediaPath = (f: string) => `media/dist/${f}`
    const JsFiles = ['main.js'].map(toMediaPath).map(toUri)
    const CssFiles = ['main.css'].map(toMediaPath).map(toUri)

    // DC7 / C1.14: locally-bundled vditor assets URL. vditor's runtime
    // loader builds asset URLs as `${cdn}/dist/js/lute/lute.min.js`,
    // etc. — it appends `/dist/...` to whatever cdn value it's given.
    // Our copy script (media-src/copy-vditor-assets.js) places the
    // files at `media/vditor/dist/js/...` so vditor's pattern resolves
    // cleanly with cdn set to the URL of `media/vditor`. The webview's
    // entry script (main.ts) reads `window.__vditorCdn` (set by the
    // nonced inline script below) and passes it as the Vditor
    // constructor's `cdn` option.
    const vditorCdnUri = toUri('media/vditor').toString()

    // DC2 redesign of the upstream `customCss` setting — see
    // `resolveCustomStylesheet` for the security rationale.
    const customStylesheetUri = resolveCustomStylesheet(
      webview,
      uri,
      EditorPanel.config.get<string>('customStylesheet')
    )
    const customStylesheetLink = customStylesheetUri
      ? `<link href="${customStylesheetUri}" rel="stylesheet" data-vmd-css="1">`
      : ''

    // DC4: per-render CSP nonce. Same shape as EditorPanel._getHtmlForWebview.
    const nonce = generateNonce()

    return (
      `<!DOCTYPE html>
			<html lang="en">
			<head>
				<meta charset="UTF-8">
				${buildCspMeta(webview, nonce)}

				<meta name="viewport" content="width=device-width, initial-scale=1.0">
				<base href="${baseHref}" />


				<style>#app{opacity:0}html[data-vmd-ready="1"][data-vmd-css-loaded="1"] #app{opacity:1}</style>
				${CssFiles.map((f) => `<link href="${f}" rel="stylesheet" data-vmd-css="1">`).join('\n')}
				${customStylesheetLink}
				<script nonce="${nonce}">
					// CSP adaptation of upstream 9c8e962's onload= attributes:
					// inline event handlers are blocked by script-src 'nonce-…',
					// so wire the load handlers from this nonce-gated script.
					// Sets html[data-vmd-css-loaded] which, together with
					// html[data-vmd-ready] (set from main.ts once Vditor is up
					// and the saved scroll position applied), reveals #app.
					(function(){
						var links=document.querySelectorAll('link[data-vmd-css="1"]');
						var finish=function(){document.documentElement.setAttribute('data-vmd-css-loaded','1')};
						if(!links.length){finish()}else{
							// Dedupe: a stylesheet that is ALREADY loaded fires no
							// load event, so link.sheet is counted instead — the
							// same link must not be counted twice.
							var pending=[];
							var fin=function(l){
								if(pending.indexOf(l)!==-1){pending.splice(pending.indexOf(l),1)}
								if(!pending.length)finish()
							};
							for(var i=0;i<links.length;i++){pending.push(links[i])}
							for(var i=0;i<links.length;i++){
								var l=links[i];
								if(l.sheet){fin(l);continue}
								l.onload=function(){fin(this)};
								l.onerror=function(){fin(this)};
							}
							if(!pending.length)finish()
						}
						// Safety net for THIS page load: vditor runs its after()
						// callback inside the promise chain of its asset loader, so a
						// failure there can never reach main.ts's try/catch and
						// data-vmd-ready would never be set — leaving #app invisible
						// with no way for the user to recover. Reveal anyway after a
						// grace period: a half-built editor beats a blank page.
						// main.ts re-arms its own watchdog on every (re)init, so this
						// one only has to cover a bundle that never started at all.
						setTimeout(function(){
							if(!document.documentElement.hasAttribute('data-vmd-ready')){
								document.documentElement.setAttribute('data-vmd-ready','1');
							}
						},4000);
					})();
				</script>

				<title>markdown editor</title>
			</head>
			<body>
				<div id="app"></div>

				<script nonce="${nonce}">window.__vditorCdn=${JSON.stringify(vditorCdnUri)};</script>
				<!-- Pre-load vditor's icon set via a normal <script> tag so vditor's
				     internal loader (which uses XHR — broken in VS Code webviews due
				     to the webview-resource scheme not resolving via DNS) finds the
				     existing element-id="vditorIconScript" and short-circuits.
				     Without this, vditor's init aborts on ERR_NAME_NOT_RESOLVED. -->
				<script nonce="${nonce}" id="vditorIconScript" src="${vditorCdnUri}/dist/js/icons/ant.js"></script>
				${JsFiles.map((f) => `<script nonce="${nonce}" src="${f}"></script>`).join('\n')}
				${EditorPanel.config.get<boolean>('showLineNumbers') !== false ? EditorPanel.lineNumberScript(nonce) : ''}
			</body>
			</html>`
    )
  }
}
