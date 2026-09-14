import * as vscode from 'vscode'
import * as NodePath from 'path'

/**
 * File-watcher backstop for external changes while the document is DIRTY.
 *
 * Why this exists (measured against a real VS Code 1.137.0 instance,
 * tests/vscode-probe):
 *   - doc CLEAN  + external disk write → VS Code auto-reloads the model and
 *     onDidChangeTextDocument fires; the tracker-based listener in
 *     extension.ts picks that up. No watcher needed.
 *   - doc DIRTY  + external disk write → VS Code silently refuses to reload
 *     (it must not clobber unsaved edits) and fires NOTHING. An external
 *     writer (an agent editing files on disk) then disappears completely:
 *     the open editor view keeps rendering stale content forever. This
 *     extension's own sync model makes the document dirty on every keystroke
 *     (webview 'edit' → applyEdit, unsaved until Ctrl+S), so in practice the
 *     document is dirty most of the time — this dead case is the norm, and
 *     the reported "agent edits don't re-render" bug.
 *
 * The backstop watches the file directly. When the disk copy diverges from
 * the dirty buffer, it asks the user once per distinct disk content:
 * "Load disk version" adopts the disk content (applyEdit + save, then the
 * normal change-event path pushes it to the webview); "Keep my edits" leaves
 * the buffer untouched. Nothing is ever overwritten silently.
 */

/**
 * Escape glob metacharacters in a file name so the watcher matches the
 * literal name (best-effort: on names the escape does not cover, the watcher
 * may simply not fire — degrading to the pre-fixer behaviour, never worse).
 */
function escapeGlob(s: string): string {
  return s.replace(/[[\]*?{}!]/g, (c) => '\\' + c)
}

export function attachExternalChangeWatcher(
  document: vscode.TextDocument,
  disposables: vscode.Disposable[]
): void {
  const uri = document.uri
  const watcher = vscode.workspace.createFileSystemWatcher(
    new vscode.RelativePattern(
      NodePath.dirname(uri.fsPath),
      escapeGlob(NodePath.basename(uri.fsPath))
    )
  )
  disposables.push(watcher)

  let lastNotifiedDiskText: string | undefined
  let checkTimer: NodeJS.Timeout | undefined

  const check = async () => {
    checkTimer = undefined
    let diskText: string
    try {
      diskText = Buffer.from(await vscode.workspace.fs.readFile(uri)).toString()
    } catch {
      // Transient read failure (atomic write mid-swap, file briefly gone).
      // A later watcher event retries; never act on a partial read.
      return
    }
    if (diskText === document.getText()) return // touch / rewrite with same bytes
    if (!document.isDirty) return // clean: host auto-reload fires the event path
    if (diskText === lastNotifiedDiskText) return // already asked about this exact content

    lastNotifiedDiskText = diskText
    const choice = await vscode.window.showInformationMessage(
      `[markdown-editor-hardened] ${NodePath.basename(
        uri.fsPath
      )} was changed on disk while it has unsaved edits here.`,
      'Load disk version',
      'Keep my edits'
    )
    if (choice !== 'Load disk version') return
    // Adopt the disk version into the buffer. The resulting change event
    // (content differs from the last synced one, so not an echo) pushes it
    // to the webview through the normal listener path; saving afterwards
    // stores exactly the bytes just read — no data change on disk.
    const edit = new vscode.WorkspaceEdit()
    edit.replace(uri, new vscode.Range(0, 0, document.lineCount, 0), diskText)
    await vscode.workspace.applyEdit(edit)
    await document.save()
  }

  // Debounce: external writers (agents, build tools) often write several
  // times in quick succession; react once things settle.
  const onDiskChange = () => {
    if (checkTimer) clearTimeout(checkTimer)
    checkTimer = setTimeout(check, 500)
  }

  watcher.onDidChange(onDiskChange, null, disposables)
}
