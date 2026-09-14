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
 * may simply not fire — degrading to the pre-fixer behaviour, never worse:
 * check() always reads the document's own uri and never acts on any other
 * file the pattern might accidentally match).
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

  let disposed = false
  let lastNotifiedDiskText: string | undefined
  let checkTimer: NodeJS.Timeout | undefined
  // True while a notification is waiting for the user's decision: no second
  // notification may stack on top of it (external writers often keep
  // writing); the disk is re-examined once the decision lands.
  let pendingChoice = false

  disposables.push(watcher)
  disposables.push({
    dispose() {
      disposed = true
      if (checkTimer) clearTimeout(checkTimer)
    },
  })

  function showError(msg: string) {
    vscode.window.showErrorMessage(`[markdown-editor-hardened] ${msg}`)
  }

  /**
   * Read the disk copy aligned with the TextModel's decode semantics.
   * Returns undefined when the read failed (atomic write mid-swap — a later
   * watcher event retries) or the bytes are not valid UTF-8 (decoded with
   * U+FFFD; pushing mojibake through applyEdit would corrupt the buffer).
   * KNOWN LIMIT: a file whose text legitimately contains U+FFFD also takes
   * this branch, so its watcher backstop silently stays inactive (fail-safe
   * direction: no notification, no write). The UTF-8 BOM is stripped
   * because document.getText() does not include it — keeping it would make
   * every comparison of an identical rewrite look like a divergence.
   */
  async function readDisk(): Promise<string | undefined> {
    try {
      const text = Buffer.from(await vscode.workspace.fs.readFile(uri)).toString()
      if (text.includes('\uFFFD')) return undefined
      return text.replace(/^\uFEFF/, '')
    } catch {
      return undefined
    }
  }

  const check = async () => {
    checkTimer = undefined
    if (disposed) return
    if (pendingChoice) {
      // A decision is still outstanding; re-examine after it lands so a
      // further disk write during the prompt is picked up (asked about as a
      // new round, never silently dropped).
      checkTimer = setTimeout(check, 1000)
      return
    }
    const diskText = await readDisk()
    if (diskText === undefined || disposed) return
    if (diskText === document.getText()) {
      // Disk and buffer agree: whatever round the last question belonged to
      // has converged. Reset so a future divergence (even byte-identical to
      // an old disk write) is asked about as a fresh round.
      lastNotifiedDiskText = undefined
      return // touch / rewrite with same bytes
    }
    if (!document.isDirty) {
      // Clean buffer: the host auto-reload path fires the change event. The
      // buffer has also advanced past whatever the user was last asked
      // about (saved or adopted), so a repeat of that old disk content is a
      // fresh round, not a repeat of the question.
      lastNotifiedDiskText = undefined
      return
    }
    if (diskText === lastNotifiedDiskText) return // already asked about this exact content

    lastNotifiedDiskText = diskText
    pendingChoice = true
    let choice: string | undefined
    try {
      choice = await vscode.window.showInformationMessage(
        `[markdown-editor-hardened] ${NodePath.basename(
          uri.fsPath
        )} was changed on disk while it has unsaved edits here.`,
        'Load disk version',
        'Keep my edits'
      )
    } finally {
      pendingChoice = false
    }
    if (disposed || choice !== 'Load disk version') return

    // The world may have moved since the snapshot was approved: the agent
    // may have written again, or the user's own Ctrl+S may have rewritten
    // the disk. Only adopt the exact content the user approved — anything
    // else is left for the next watcher round to re-ask about.
    const now = await readDisk()
    if (disposed || now !== diskText) return

    const edit = new vscode.WorkspaceEdit()
    edit.replace(uri, new vscode.Range(0, 0, document.lineCount, 0), diskText)
    const applied = await vscode.workspace.applyEdit(edit)
    if (!disposed && !applied) {
      showError(`Could not apply the disk version of ${NodePath.basename(uri.fsPath)}.`)
      return
    }
    const saved = await document.save()
    if (!disposed && !saved) {
      // Buffer now holds the disk content but was not persisted; say so
      // instead of leaving a silent three-way divergence.
      showError(`Loaded the disk version of ${NodePath.basename(uri.fsPath)} but saving it failed.`)
    }
  }

  // Debounce: external writers (agents, build tools) often write several
  // times in quick succession; react once things settle.
  const onDiskChange = () => {
    if (disposed) return
    if (checkTimer) clearTimeout(checkTimer)
    checkTimer = setTimeout(check, 500)
  }

  watcher.onDidChange(onDiskChange, null, disposables)
  // Atomic writes (temp file + rename) surface as delete+create on some
  // platforms instead of change — subscribe to create as well so the
  // backstop does not silently miss that write style.
  watcher.onDidCreate(onDiskChange, null, disposables)
}
