/**
 * Content-sync state shared between the extension host and the webview
 * editor, replacing the old `isExternalReload` heuristic.
 *
 * Why content comparison instead of event shape:
 *   `isExternalReload` treated "contentChanges > 0 && !isDirty" as a disk
 *   reload, because the webview's own edits (applyEdit) were believed to
 *   arrive with the document already dirty. Measured against a real
 *   VS Code 1.137.0 instance (tests/vscode-probe), that belief no longer
 *   holds: workspace.applyEdit fires the content-change event BEFORE the
 *   dirty flag flips, then a second empty event flips it. An applyEdit event
 *   is therefore byte-identical in shape to a disk-reload event, and the
 *   heuristic misfires in BOTH directions:
 *     - the webview's own edit echo was classified as external and pushed
 *       back into the editor (full setValue on every keystroke, cursor jump)
 *     - any future dirty-flag ordering would silently drop real edits.
 *
 * The exact alternative: remember the last content known to be in sync
 * (sent to the webview, or received from it). A document change whose
 * resulting text equals that content is our own echo; anything else is new
 * and must be pushed. Equal-content external writes are a no-op either way.
 */
export class SyncTracker {
  private lastSynced: string | undefined

  /** Content the webview just reported (its current editor value). */
  noteWebviewContent(content: string): void {
    this.lastSynced = content
  }

  /** Content the host just pushed to the webview (init or update). */
  notePostedToWebview(content: string): void {
    this.lastSynced = content
  }

  /**
   * True when `text` is exactly the content already in sync — i.e. a change
   * event that merely echoes what the webview/host exchanged. Before the
   * first sync nothing is an echo, so pre-ready external changes still push.
   */
  isEcho(text: string): boolean {
    return this.lastSynced !== undefined && text === this.lastSynced
  }
}
