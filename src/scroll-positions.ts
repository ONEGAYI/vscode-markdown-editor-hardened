/**
 * Cross-entry-point scroll-position memory (upstream 9c8e962, adapted).
 *
 * The markdown editor webview is fully disposed and recreated whenever a
 * different .md file is opened (single shared panel in the command flow,
 * re-resolved custom editor in the "Open With" flow), which would reset
 * the reading position to the top on every file switch. The webview
 * reports its scrollTop on every scroll event; both entry points look
 * the saved position up by fsPath on the next init and send it along
 * with the init message for main.ts to restore.
 *
 * Kept in its own module (rather than an EditorPanel static like
 * upstream) because the message dispatcher also needs to write to it,
 * and importing extension.ts from the dispatcher would be circular.
 */

export const scrollPositions = new Map<string, number>()

/**
 * FOUC gate for #app (upstream 9c8e962, CSP-adapted): the visibility
 * rule is inlined LITERALLY into both webview templates' <head> — no
 * interpolation — so the "no <style>${…}</style> interpolation"
 * invariant checked by poc-h3 stays intact. The rule hides #app until
 * BOTH of these are true:
 *
 *   (a) the external main.css has actually finished loading — the
 *       CSP-safe wiring script placed after the <link> tags sets
 *       html[data-vmd-css-loaded="1"] (upstream used inline onload=
 *       attributes, which our CSP script-src 'nonce-…' blocks);
 *   (b) main.ts confirms Vditor finished building its UI and applied
 *       the saved scroll position — sets html[data-vmd-ready="1"].
 *
 * Both matter: a script's execution is not guaranteed to wait for an
 * earlier stylesheet to finish loading, so Vditor can finish building
 * (and fire its ready signal) *before* its own real CSS sizing has
 * loaded, which would flash an intermediate, oddly-scaled paint
 * (toolbar buttons at native SVG size) — most noticeable right after a
 * file switch recreates the webview. Attributes live on <html>
 * (documentElement — always exists, even while the parser is still
 * inside <head>, unlike <body>).
 */
