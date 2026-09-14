/**
 * Shared webview-message handling for both the command-mode panel
 * (`EditorPanel`) and the custom-text-editor path (`MarkdownEditorProvider`).
 *
 * Background (DC12 / T3 refactor):
 *   Upstream's `MarkdownEditorProvider` was added in 0.1.14 by largely
 *   copy-pasting `EditorPanel`'s message-handler code. The two paths
 *   diverge only in WHICH BINDINGS they use (panel handle, text document,
 *   uri, ExtensionContext field name) — the dispatch table and the
 *   per-command logic are identical. Across T1 we patched both copies in
 *   parallel for every security fix; that worked but was inherently
 *   error-prone (a fix could land in one path and not the other).
 *
 *   This module consolidates the dispatch into a single function that
 *   takes a `WebviewSession` deps object. Both callers now plug in their
 *   own bindings without duplicating the switch body.
 *
 *   What's still SEPARATE in each caller:
 *     - panel-lifecycle code (createOrShow / resolveCustomTextEditor)
 *     - the HTML-template builder (still per-class, until a future
 *       refactor extracts it)
 *     - VS Code disposable wiring (each path has its own disposables
 *       array)
 *
 *   What IS NOW SHARED:
 *     - the switch over message.command (9 cases + an unknown-command
 *       silent drop)
 *     - syncToEditor (writes webview content back to the underlying
 *       document or file)
 *     - upload validation + write loop (DC5 / H4)
 *     - open-link validation + dispatch (DC6 / H5)
 *     - scroll-position persistence (upstream 9c8e962)
 *
 * INV3 (no NEW vulns from the refactor):
 *   The extracted code is byte-equivalent in behavior to the two prior
 *   copies — the test suite (7 PoCs + integration smoke) covers each
 *   security-relevant case. A regression in this refactor would surface
 *   as a failing PoC.
 */

import * as vscode from 'vscode'
import * as NodePath from 'path'
import { validateUploadEntries } from '../upload-validation'
import { validateOpenLinkUrl } from '../security/path-validation'
import { scrollPositions } from '../scroll-positions'

const KeyVditorOptions = 'vditor.options'

function debug(...args: any[]): void {
  console.log(...args)
}

function showError(msg: string): void {
  vscode.window.showErrorMessage(`[markdown-editor-hardened] ${msg}`)
}

/**
 * Per-session bindings supplied by the caller.
 *
 * The handler reads from these (never mutates them) and may invoke the
 * callbacks (postUpdateMessage, onEditApplied) at any point during a
 * message's processing.
 */
export interface WebviewSession {
  /** The webview's panel.webview (where messages come from, where postMessage targets). */
  webview: vscode.Webview

  /** Is the webview currently focused? Mirrors `panel.active`. */
  isActive: () => boolean

  /**
   * The markdown file's vscode.Uri. ALWAYS present (both paths know
   * this). Used for:
   *   - assets folder resolution (`getAssetsFolder`)
   *   - upload relative-path computation
   *   - open-link relative-path resolution
   *   - workspace-folder lookup (e.g. for `customStylesheet` validation)
   */
  fileUri: vscode.Uri

  /**
   * The text document, IF the caller has one (the CustomTextEditor path
   * always does; the command-mode panel may not, when opened directly
   * from a URI without an active text editor).
   */
  document?: vscode.TextDocument

  /** Extension context — for globalState reads/writes. */
  context: vscode.ExtensionContext

  /**
   * Post an `update` message to the webview. The two paths differ on
   * whether this also re-reads file content from disk (EditorPanel does)
   * or just sends the document's text (CustomEditor does), so the
   * caller owns this.
   */
  postUpdate: (props?: { type?: 'init' | 'update'; options?: any; theme?: 'dark' | 'light' }) => void | Promise<void>

  /**
   * Called AFTER any handler that may have modified the document
   * (edit, save). Both paths use this to refresh the panel title with
   * the `[edit]` prefix.
   */
  onEditApplied?: () => void
}

/**
 * Dispatch a single message from the webview. Returns a Promise that
 * resolves when the message has been fully processed (may include
 * file I/O for upload).
 */
export async function handleWebviewMessage(message: any, session: WebviewSession): Promise<void> {
  debug('msg from webview', message, session.isActive())

  const syncToEditor = async (): Promise<void> => {
    debug('sync to editor', session.document, session.fileUri)
    if (session.document) {
      const edit = new vscode.WorkspaceEdit()
      edit.replace(
        session.document.uri,
        new vscode.Range(0, 0, session.document.lineCount, 0),
        message.content
      )
      await vscode.workspace.applyEdit(edit)
    } else if (session.fileUri) {
      await vscode.workspace.fs.writeFile(session.fileUri, message.content)
    } else {
      showError(`Cannot find original file to save!`)
    }
  }

  switch (message.command) {
    case 'ready': {
      // PR #157 line numbers (asalcedo29): the gutter used to need a
      // one-off `__setOrigContent` snapshot of the document here; it now
      // reads the live `vditor.getValue()` directly (upstream 9b4f158 —
      // a startup-only snapshot drifted out of sync with the rendered
      // blocks as soon as the document was edited).
      await session.postUpdate({
        type: 'init',
        options: {
          useVscodeThemeColor: configGet<boolean>('useVscodeThemeColor'),
          showLineNumbers: configGet<boolean>('showLineNumbers'),
          // Upstream db2062c: open vditor's outline panel by default
          // when the user opted in via the defaultOpenOutline setting.
          outline: {
            enable: configGet<boolean>('defaultOpenOutline') === true,
          },
          ...session.context.globalState.get(KeyVditorOptions),
        },
        theme:
          vscode.window.activeColorTheme.kind === vscode.ColorThemeKind.Dark
            ? 'dark'
            : 'light',
      })
      break
    }
    case 'save-options':
      session.context.globalState.update(KeyVditorOptions, message.options)
      break
    case 'scroll': {
      // Upstream 9c8e962: the webview reports its scroll position on
      // every scroll (synchronously — the panel can be disposed before
      // a debounced timer would fire), so switching files and back
      // restores the reading position. The map lives in
      // src/scroll-positions.ts and is shared by both entry points.
      // Validate the number: a NaN/negative/non-numeric value would make
      // every restore land at the top of the document.
      const top = Number(message.top)
      scrollPositions.set(
        session.fileUri.fsPath,
        Number.isFinite(top) ? Math.max(0, top) : 0
      )
      break
    }
    case 'info':
      vscode.window.showInformationMessage(message.content)
      break
    case 'error':
      showError(message.content)
      break
    case 'edit': {
      // Only sync to VS Code editor when webview is in edit mode to
      // avoid repeated refresh from the host-side write.
      if (session.isActive()) {
        await syncToEditor()
        session.onEditApplied?.()
      }
      break
    }
    case 'reset-config': {
      await session.context.globalState.update(KeyVditorOptions, {})
      break
    }
    case 'save': {
      await syncToEditor()
      if (session.document) {
        await session.document.save()
      }
      session.onEditApplied?.()
      break
    }
    case 'upload': {
      // SECURITY (DC5 / H4): validate filenames BEFORE any fs write.
      const { valid, rejected } = validateUploadEntries(message.files)
      if (rejected.length > 0) {
        debug('upload: rejected entries', rejected)
        showError(
          `Rejected ${rejected.length} upload entr${rejected.length === 1 ? 'y' : 'ies'} ` +
          `(invalid filename or shape). Reasons: ${rejected.map(r => r.reason).join(', ')}`
        )
      }
      if (valid.length === 0) break
      const assetsFolder = getAssetsFolder(session.fileUri)
      try {
        await vscode.workspace.fs.createDirectory(vscode.Uri.file(assetsFolder))
      } catch (error) {
        console.error(error)
        showError(`Invalid image folder: ${assetsFolder}`)
      }
      await Promise.all(
        valid.map(async (f) => {
          const content = Buffer.from(f.base64, 'base64')
          return vscode.workspace.fs.writeFile(
            vscode.Uri.file(NodePath.join(assetsFolder, f.name)),
            content
          )
        })
      )
      const files = valid.map((f) =>
        NodePath.relative(
          NodePath.dirname(session.fileUri.fsPath),
          NodePath.join(assetsFolder, f.name)
        ).replace(/\\/g, '/')
      )
      session.webview.postMessage({
        command: 'uploaded',
        files,
      })
      break
    }
    case 'open-link': {
      // SECURITY (DC6 / H5): validate scheme + workspace containment.
      const wsRoots = (vscode.workspace.workspaceFolders ?? []).map(w => w.uri.fsPath)
      const result = validateOpenLinkUrl(message.href, session.fileUri.fsPath, wsRoots)
      if (!result.ok) {
        debug('open-link: rejected', { href: message.href, reason: result.reason })
        break
      }
      if (result.kind === 'file') {
        // Upstream 9b6f3f8: stat the resolved target first — a directory
        // opens in the OS file explorer (revealInExplorer), a missing
        // target is dropped silently (vscode.open would surface a modal
        // error for what is usually a typo'd relative link).
        let fileStat: vscode.FileStat | undefined
        try {
          fileStat = await vscode.workspace.fs.stat(vscode.Uri.file(result.resolvedFsPath))
        } catch {
          debug('open-link: target missing', { href: message.href, path: result.resolvedFsPath })
          break
        }
        if (fileStat.type === vscode.FileType.Directory) {
          await vscode.commands.executeCommand(
            'revealInExplorer',
            vscode.Uri.file(result.resolvedFsPath)
          )
          break
        }
        vscode.commands.executeCommand('vscode.open', vscode.Uri.file(result.resolvedFsPath))
      } else {
        // http, https, mailto — pass the validated URL string through.
        vscode.commands.executeCommand('vscode.open', vscode.Uri.parse(result.url))
      }
      break
    }
    default:
      // Unknown command from the webview. Silently drop — could log,
      // but a flood of debug messages from a future feature would be
      // worse than silent.
      break
  }
}

function configGet<T>(key: string): T | undefined {
  return vscode.workspace.getConfiguration('markdown-editor-hardened').get<T>(key)
}

function getAssetsFolder(uri: vscode.Uri): string {
  const imageSaveFolder = (
    configGet<string>('imageSaveFolder') || 'assets'
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
  return NodePath.resolve(NodePath.dirname(uri.fsPath), imageSaveFolder)
}
