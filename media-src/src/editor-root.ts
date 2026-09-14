/**
 * Resolve the element that currently hosts the editable/rendered content.
 *
 * vditor 3.11 keeps all three mode containers (.vditor-ir / .vditor-wysiwyg /
 * .vditor-sv) in the DOM simultaneously; only the active one is the editing
 * surface. Anything that walks rendered content — the find bar's text scan and
 * the line-number gutter's block list — must target the ACTIVE container, and
 * the in-page-anchor scroll must too: a container that was active earlier keeps
 * its rendered children while hidden, so a global `document.querySelector(...)`
 * can silently resolve a detached-from-view heading.
 *
 * Two cases need care:
 *   - SV paints its source into a single element carrying BOTH classes
 *     (`element.className = "vditor-sv vditor-reset"`, vditor dist/index.js),
 *     so the descendant selector `.vditor-sv .vditor-reset` matches nothing.
 *   - Upstream's fixed IR-first query order assumes upstream's IR default; this
 *     fork defaults to WYSIWYG, where it returns the inactive, empty IR
 *     container and every search reports 0 matches.
 */
export function getActiveEditorRoot(): Element | null {
  try {
    const mode = (window as any).vditor?.getCurrentMode?.()
    if (mode === 'sv') {
      const sv = document.querySelector('.vditor-sv')
      if (sv) return sv
    } else if (mode) {
      const el = document.querySelector(`.vditor-${mode} .vditor-reset`)
      if (el) return el
    }
  } catch (_) {
    // window.vditor not ready — fall through to the content probe
  }
  // Best-effort fallback for callers that run before vditor has mounted.
  // It cannot tell a stale container from the live one (an inactive container
  // keeps its children), so prefer the first with rendered content and accept
  // that this only holds while nothing has been switched yet.
  const resets = Array.from(document.querySelectorAll('.vditor-reset'))
  return resets.find((el) => el.children.length > 0) || resets[0] || null
}
