/**
 * Code block enhancements: per-block header bar + language alias mapping.
 *
 * Header bar (matches the design reference screenshot):
 *
 *   ┌──────────────────────────────────────────────┐
 *   │ </> jsonc                 [wrap] [copy]      │  ← .vmd-cb-header
 *   │ { "a": 1 }                                    │  ← <code> as before
 *   └──────────────────────────────────────────────┘
 *
 * - Shows the RAW info string (e.g. "jsonc"), "text" when the fence has no
 *   language. A generic `</>` wire icon precedes it — not per-language logos.
 * - The wrap button toggles soft-wrap for THAT block only (default off, not
 *   persisted across renders/rebuilds). The copy button writes the code text
 *   to the clipboard via navigator.clipboard.
 * - Diagram languages handled by vditor's own renderers (mermaid, echarts, …)
 *   are skipped — they have their own tooling and their <code> may be
 *   replaced by the rendered figure.
 * - Decorations live only in the editor DOM. getValue()/getHTML() go through
 *   Lute, so exported/copied markdown and HTML stay pristine.
 *
 * Wiring contract is asserted by tests/integration/code-block.js.
 */

import { t } from './lang'

// vditor renders these through dedicated diagram pipelines (VD codeRender's
// own skip list) — no header bar for them.
const DIAGRAM_LANGS = new Set([
  'mermaid', 'flowchart', 'echarts', 'mindmap', 'markmap',
  'plantuml', 'abc', 'graphviz', 'math', 'smiles',
])

// VS Code language identifiers (as commonly written on fences) that
// highlight.js does not know. vditor falls back to plaintext for them, which
// is why e.g. ```jsonc blocks showed NO highlighting at all. The aliases are
// registered onto hljs as soon as it loads (see installHljsAliases).
// Verified against the bundled hljs 11.7 build (192 core languages in
// highlight.min.js + 5 more from third-languages.js).
export const LANG_ALIAS: Record<string, string> = {
  // exact-language identifiers hljs names differently
  jsonc: 'json',
  json5: 'json',
  // NOT 'shell' — that id resolves to the Shell Session grammar, which
  // highlights $ prompts instead of script syntax
  shellscript: 'bash',
  batch: 'dos',
  'objective-c': 'objectivec',
  'objective-cpp': 'objectivec',
  commonlisp: 'lisp',
  systemverilog: 'verilog',
  mysql: 'sql',
  plsql: 'sql',
  tsql: 'sql',
  rest: 'http',
  asm: 'x86asm',
  nasm: 'x86asm',
  'cpp-objdump': 'x86asm',
  vba: 'vbnet',
  apex: 'java',
  chef: 'ruby',
  ansible: 'yaml',
  'cmake-cache': 'properties',
  // close-enough grammars (better than plaintext)
  vue: 'xml',
  svelte: 'xml',
}

// Preview-side fenced code blocks across all three editor modes. `data-render`
// cannot be used: processCodeRender rewrites it to "1" once done. WYSIWYG and
// IR render into their own preview <pre> classes; SV mode renders its preview
// side into a bare <pre> under `.vditor-preview`.
const PRE_SELECTOR =
  'pre.vditor-wysiwyg__preview, pre.vditor-ir__preview, .vditor-preview pre'

const CODE_ICON_SVG =
  '<svg viewBox="0 0 16 10" fill="none" stroke="currentColor" stroke-width="1.5" ' +
  'stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
  '<path d="M5 1 1.5 5 5 9"/><path d="M11 1l3.5 4L11 9"/></svg>'

const WRAP_ICON_SVG =
  '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" ' +
  'stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
  '<path d="M2 4h12"/><path d="M2 8h8.5a2.5 2.5 0 0 1 0 5H8"/><path d="M10 11l-2 2 2 2"/></svg>'

const COPY_ICON_SVG =
  '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" ' +
  'stroke-linejoin="round" aria-hidden="true">' +
  '<rect x="5.5" y="5.5" width="8" height="8" rx="1.5"/>' +
  '<path d="M3.5 10.5h-1a1 1 0 0 1-1-1v-7a1 1 0 0 1 1-1h7a1 1 0 0 1 1 1v1"/></svg>'

const CHECK_ICON_SVG =
  '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8" ' +
  'stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
  '<path d="M3 8.5 6.5 12 13 4"/></svg>'

const CHEVRON_ICON_SVG =
  '<svg viewBox="0 0 10 10" fill="none" stroke="currentColor" stroke-width="1.5" ' +
  'stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
  '<path d="M2 3.5 5 6.5 8 3.5"/></svg>'

/** Extract the fence language from a <code> element's `language-*` class. */
export function langOf(code: Element): string {
  const m = /(?:^|\s)language-([^\s]+)/.exec(code.className)
  return m ? m[1] : ''
}

/** Sync a header bar's label + aria-expanded with the block's collapse
 *  state. Shared by the click/keydown handlers and the in-place-overwrite
 *  recovery path in decorate() (the <pre> keeps its class through an
 *  innerHTML rewrite, but the fresh header starts expanded — it must be
 *  re-synced). */
function setCollapseState(header: HTMLElement, collapsed: boolean) {
  const label = t(collapsed ? 'expandCode' : 'collapseCode')
  header.title = label
  header.setAttribute('aria-label', label)
  header.setAttribute('aria-expanded', collapsed ? 'false' : 'true')
}

/** Build the header bar for one code block. Language name is set via
 *  textContent so user-provided info strings can never inject markup.
 *  The WHOLE bar is the toggle control (full-width pill, per the user's
 *  design): hover tints it and clicking anywhere on it — except the two
 *  action buttons — collapses/expands the code area. The chevron points
 *  down while expanded and rotates right when collapsed. The bar is a
 *  div with role=button (a real <button> cannot nest the wrap/copy
 *  buttons inside it); keyboard activation is handled by the delegated
 *  keydown listener. */
export function buildHeader(lang: string): HTMLElement {
  const header = document.createElement('div')
  header.className = 'vmd-cb-header'
  header.setAttribute('role', 'button')
  header.tabIndex = 0
  const wrapLabel = t('enableWrap')
  const copyLabel = t('copyCode')
  const collapseLabel = t('collapseCode')
  header.title = collapseLabel
  header.setAttribute('aria-label', collapseLabel)
  header.setAttribute('aria-expanded', 'true')
  header.innerHTML =
    '<span class="vmd-cb-lang">' +
    `<span class="vmd-cb-lang-icon">${CODE_ICON_SVG}</span>` +
    '<span class="vmd-cb-lang-name"></span>' +
    `<span class="vmd-cb-chevron">${CHEVRON_ICON_SVG}</span>` +
    '</span>' +
    '<span class="vmd-cb-actions">' +
    `<button type="button" class="vmd-cb-btn vmd-cb-wrap" title="${wrapLabel}" aria-label="${wrapLabel}">${WRAP_ICON_SVG}</button>` +
    `<button type="button" class="vmd-cb-btn vmd-cb-copy" title="${copyLabel}" aria-label="${copyLabel}">` +
    `<span class="vmd-cb-icon vmd-cb-icon-copy">${COPY_ICON_SVG}</span>` +
    `<span class="vmd-cb-icon vmd-cb-icon-check">${CHECK_ICON_SVG}</span>` +
    '</button>' +
    '</span>'
  header.querySelector<HTMLElement>('.vmd-cb-lang-name').textContent = lang || 'text'
  return header
}

/** Insert a header bar into a preview <pre> if it should have one.
 *  Returns true when a header was added. Idempotent. */
export function decorate(pre: HTMLPreElement): boolean {
  if (pre.querySelector(':scope > .vmd-cb-header')) return false
  const code = pre.querySelector(':scope > code')
  if (!code) return false
  const lang = langOf(code)
  if (DIAGRAM_LANGS.has(lang.toLowerCase())) return false
  const header = buildHeader(lang)
  pre.insertBefore(header, pre.firstChild)
  // In-place overwrite recovery: the <pre> survives with its collapsed class
  // while the header was just rebuilt — re-sync the fresh bar's state.
  if (pre.classList.contains('vmd-cb--collapsed')) {
    setCollapseState(header, true)
  }
  return true
}

export function decorateAll(root: ParentNode): number {
  let added = 0
  root.querySelectorAll<HTMLPreElement>(PRE_SELECTOR).forEach((pre) => {
    if (decorate(pre)) added++
  })
  return added
}

/** Code text for the clipboard. When vditor's line numbers are enabled
 *  (preview.hljs.lineNumber), it keeps hidden helper copies of every line
 *  (.vditor-linenumber__temp / __rows) INSIDE <code> — strip those so the
 *  copied text is the code alone, then drop Lute's single trailing \n. */
function codeTextOf(code: Element): string {
  let source: Element = code
  if (code.querySelector('.vditor-linenumber__temp, .vditor-linenumber__rows')) {
    source = code.cloneNode(true) as Element
    source.querySelectorAll('.vditor-linenumber__temp, .vditor-linenumber__rows')
      .forEach((el) => el.remove())
  }
  return (source.textContent || '').replace(/\n$/, '')
}

/** Show a transient state (success check / error tint) on a copy button.
 *  A generation token guards the restore timer: retrying a copy inside the
 *  1.5s window must not let the PREVIOUS flash's timer reset the title or
 *  clear the new state early. */
function flashCopyState(btn: HTMLElement, cls: string, label: string) {
  const gen = (Number(btn.dataset.vmdCbFlash) || 0) + 1
  btn.dataset.vmdCbFlash = String(gen)
  btn.classList.remove('vmd-cb-btn--ok', 'vmd-cb-btn--err')
  btn.classList.add(cls)
  btn.title = label
  btn.setAttribute('aria-label', label)
  setTimeout(() => {
    if (btn.dataset.vmdCbFlash !== String(gen)) return // superseded
    btn.classList.remove(cls)
    btn.title = t('copyCode')
    btn.setAttribute('aria-label', t('copyCode'))
  }, 1500)
}

/** Register VS Code-style fence languages as highlight.js aliases.
 *
 *  vditor loads hljs asynchronously via a dynamically injected <script> that
 *  assigns `window.hljs`. vditor passes the fence language straight into
 *  hljs.highlight, which silently degrades to plaintext for unknown names —
 *  so the aliases must exist BEFORE any highlight call. Interception is done
 *  by replacing the window property with an accessor: the first assignment
 *  (UMD factory) passes through the setter, which registers our aliases on
 *  the instance before storing it. Must run before vditor init (main.ts
 *  module load time), which is always before the hljs script loads. */
export function installHljsAliases() {
  const w = window as any
  if (w.__vmdHljsAliasInstalled) return
  w.__vmdHljsAliasInstalled = true
  let value: unknown
  try {
    Object.defineProperty(w, 'hljs', {
      configurable: true,
      get() {
        return value
      },
      set(next: unknown) {
        value = next
        const hljs = next as { registerAliases?: Function }
        if (hljs && typeof hljs.registerAliases === 'function') {
          // registerAliases writes a pure name mapping: it neither requires
          // the target language to be registered yet (third-languages.js
          // loads after highlight.min.js) nor throws on duplicates; it only
          // throws on a malformed call (missing second argument), hence the
          // per-entry guard.
          for (const [alias, target] of Object.entries(LANG_ALIAS)) {
            try {
              hljs.registerAliases!(alias, { languageName: target })
            } catch (_) {
              /* malformed entry — skip */
            }
          }
        }
        // hljs just became available: any mirror mounted while it was still
        // loading is plain-text only. Schedule one highlight pass for the
        // live editing blocks so they upgrade without waiting for a key.
        for (const p of Array.from(document.querySelectorAll('pre.vditor-wysiwyg__pre'))) {
          if (isEditingPre(p)) scheduleMirrorRender(p as HTMLPreElement)
        }
      },
    })
  } catch (err) {
    // window.hljs could not be redefined (already a non-configurable property
    // in some environments). Highlighting then stays as it was — warn so the
    // degradation is diagnosable instead of silently missing aliases.
    console.warn('[markdown-editor-hardened] failed to install hljs aliases:', err)
  }
}

/** Toggle a block's collapse state and re-sync its header bar. */
function toggleCollapse(pre: HTMLPreElement, header: HTMLElement) {
  setCollapseState(header, pre.classList.toggle('vmd-cb--collapsed'))
}

/* ── Edit-mode syntax highlighting mirror (wysiwyg) ──────────────────────
 * vditor's wysiwyg edits fenced blocks in a PLAIN text pre — all syntax
 * colors are lost the moment the block enters edit mode. To keep the block
 * highlighted while editing (user spec: "edit in the same block, keep the
 * highlighting, no extra preview"), the editing pre's own text is turned
 * transparent (caret + selection stay visible) and an aligned highlight
 * MIRROR is layered behind it, re-rendered from hljs on every input. Same
 * trick VS Code / CodeMirror use: the editable DOM stays plain text, so
 * vditor's data extraction, IME and undo stack are untouched. */

const overlayTimers = new WeakMap<HTMLElement, number>()

/** Fence language for the mirror: prefer the editing pre's own code class,
 *  fall back to the (possibly hidden) preview sibling's. */
function editLangOf(editPre: HTMLPreElement): string {
  const block = editPre.parentElement
  const candidates = [
    editPre.querySelector(':scope > code'),
    block ? block.querySelector('.vditor-wysiwyg__preview > code') : null,
  ]
  for (const c of candidates) {
    const m = c ? /(?:^|\s)language-([^\s]+)/.exec(c.className) : null
    if (m) return m[1]
  }
  return ''
}

function renderEditOverlay(editPre: HTMLPreElement, overlay: HTMLElement) {
  const code = editPre.querySelector(':scope > code') || editPre
  const text = (code.textContent || '').replace(/\n$/, '')
  const hljs = (window as any).hljs
  const lang = editLangOf(editPre)
  if (hljs && lang && hljs.getLanguage && hljs.getLanguage(lang)) {
    try {
      overlay.innerHTML = hljs.highlight(text, { language: lang }).value
      positionEditOverlay(editPre, overlay)
      return
    } catch (_) { /* fall through to plain */ }
  }
  overlay.textContent = text // plain mirror: ink still visible through transparency
  positionEditOverlay(editPre, overlay)
}

/** Pin the body-level fixed overlay onto the editing code's box. The layer
 *  cannot live inside the editing container: vditor's own input handling
 *  scans that subtree and a foreign node there flips the block out of edit
 *  mode on the first keystroke (verified against vanilla vditor). */
function positionEditOverlay(editPre: HTMLPreElement, overlay: HTMLElement) {
  const code = (editPre.querySelector(':scope > code') as HTMLElement) || editPre
  const r = code.getBoundingClientRect()
  overlay.style.left = r.left + 'px'
  overlay.style.top = r.top + 'px'
  overlay.style.width = r.width + 'px'
  // Re-rendering the overlay's content (innerHTML/textContent) clamps its
  // scrollLeft back to 0 — while editing a horizontally-scrolled long line,
  // the mirror would jump to the line start on every render. The scrolling
  // ELEMENT is the <code> (vditor styles `pre > code` with overflow:auto;
  // the <pre> itself stays overflow:visible and always reads 0).
  overlay.scrollLeft = code.scrollLeft
}

/** The editing state of one block: the class drives the shell-preserving
 *  layout, the mirror renders the highlight behind the transparent text.
 *  Block and mirror are cross-linked via expandos. */
function isEditingPre(p: Element): boolean {
  // vditor hides an INACTIVE editing pre via inline `display: none`, and
  // while a block is being edited it either writes `display: block` or —
  // for the caret block Lute re-renders on every keystroke — omits the
  // style attribute entirely. Judge ONLY the display property: substring
  // matching on the raw attribute would misfire on unrelated declarations
  // (e.g. `user-select: none`), and CSSOM parsing leaves '' for a missing
  // attribute, which per the caret convention above still means editing.
  return p instanceof HTMLElement && p.style.display !== 'none'
}

/** Cheap immediate mirror: plain text + pin, no highlighting. The editing
 *  text is transparent, so a fresh mount (or an IME composition frame)
 *  needs ink NOW; the expensive highlight pass follows on the debounce. */
function renderPlainMirror(editPre: HTMLPreElement, overlay: HTMLElement) {
  const code = editPre.querySelector(':scope > code') || editPre
  const text = (code.textContent || '').replace(/\n$/, '')
  overlay.textContent = text
  positionEditOverlay(editPre, overlay)
}

/** Debounced full highlight pass for one editing pre. The timer's captured
 *  nodes are re-validated on fire: vditor replaces the editing block on
 *  every keystroke, so a stale timer must neither paint an orphan mirror
 *  nor one that now belongs to a different block. */
function scheduleMirrorRender(editPre: HTMLPreElement) {
  const ov = (editPre.parentElement as any)?.__vmdOverlay as HTMLElement | undefined
  if (!ov || !ov.isConnected) return
  const prev = overlayTimers.get(editPre)
  if (prev) clearTimeout(prev)
  overlayTimers.set(editPre, window.setTimeout(() => {
    if (!editPre.isConnected || !ov.isConnected) return
    if ((ov as any).__vmdBlock !== editPre.parentElement) return
    renderEditOverlay(editPre, ov)
  }, 60))
}

/** Recompute EVERY editing block's mirror from current DOM truth. Called at
 *  mutation-batch end so the outcome never depends on mutation order —
 *  which matters because vditor switches editing between two blocks by
 *  activating the NEW block first and retiring the OLD one only ~200ms
 *  later (verified with a frame probe on the live editor). During that
 *  window BOTH blocks are in edit mode and each transparent text needs its
 *  own mirror; a single shared layer would be stolen by the new block and
 *  the old block's text would visibly flash away.
 *
 *  Retirement runs BEFORE re-pinning: removing a retired block's editing
 *  class restores its preview code, which shifts the layout of every block
 *  below it. Measuring the survivors' rects before that shift pins their
 *  mirrors to transient collapsed geometry — observed live as the mirror
 *  floating ~155px above its block after a two-block switch. */
function refreshEditOverlays() {
  const editing = new Set<HTMLElement>()
  const editPres: HTMLPreElement[] = []
  for (const p of Array.from(document.querySelectorAll('pre.vditor-wysiwyg__pre'))) {
    if (!isEditingPre(p)) continue
    const block = p.parentElement
    // Guard the block type: the editing class flexes the block's layout,
    // which must only ever apply to a real fenced-block container (Lute
    // always wraps one; this is future-proofing against vditor variants).
    if (!(block instanceof HTMLElement)) continue
    if (!block.classList.contains('vditor-wysiwyg__block')) continue
    editing.add(block)
    editPres.push(p as HTMLPreElement)
  }
  // Phase 1 — retire: mirrors whose block left edit mode (or was removed
  // wholesale) go away, together with the editing class. This changes the
  // document layout; survivors are pinned only after it settles.
  for (const ov of Array.from(document.querySelectorAll('body > .vmd-cb-edit-hl'))) {
    const block = (ov as any).__vmdBlock as HTMLElement | undefined
    if (block && editing.has(block)) continue
    ov.remove()
    if (block) block.classList.remove('vmd-cb--editing')
  }
  // Defensive sweep: an editing class whose pre is no longer visible (block
  // replaced without the old one being retired) must not linger either.
  for (const b of Array.from(document.querySelectorAll('.vmd-cb--editing'))) {
    if (!editing.has(b as HTMLElement)) (b as HTMLElement).classList.remove('vmd-cb--editing')
  }
  // Phase 2 — pin survivors against the post-retirement layout.
  for (const p of editPres) {
    const block = p.parentElement as HTMLElement
    block.classList.add('vmd-cb--editing')
    const w = block as any
    let ov = w.__vmdOverlay as HTMLElement | undefined
    if (!ov || !ov.isConnected) {
      ov = document.createElement('div')
      ov.className = 'vmd-cb-edit-hl'
      ov.setAttribute('aria-hidden', 'true')
      ;(ov as any).__vmdBlock = block
      w.__vmdOverlay = ov
      document.body.appendChild(ov)
      // Mirror the editing code's typography exactly so the colored layer
      // sits pixel-perfect behind the transparent foreground text. Copy
      // font LONGHAND by longhand: Chromium's computed `font` shorthand
      // serializes to "" for many perfectly ordinary combinations, and an
      // empty assignment silently drops the whole declaration (the mirror
      // then renders at the body default — 16px vs the code's 13.6px, text
      // visibly offset). (jsdom computes these as empty strings — the plain
      // fallback still works.)
      const cs = getComputedStyle(codeOf(p))
      ov.style.fontStyle = cs.fontStyle
      ov.style.fontVariant = cs.fontVariant
      ov.style.fontWeight = cs.fontWeight
      ov.style.fontStretch = cs.fontStretch
      ov.style.fontSize = cs.fontSize
      ov.style.fontFamily = cs.fontFamily
      ov.style.letterSpacing = cs.letterSpacing
      ov.style.whiteSpace = cs.whiteSpace
      ov.style.lineHeight = cs.lineHeight
      ov.style.padding = cs.padding
      ov.style.tabSize = cs.tabSize
      // Fresh mount: plain ink immediately (the foreground is transparent),
      // full highlight on the shared debounce — vditor rebuilds the editing
      // block on EVERY keystroke, so a synchronous hljs pass here would run
      // the full-text highlight once per key.
      renderPlainMirror(p, ov)
      scheduleMirrorRender(p)
    } else {
      positionEditOverlay(p, ov) // existing: re-pin only
    }
  }
  // Phase 3 — the layout may still drift after this batch (the retirement
  // above only takes effect on the next style/layout pass, and vditor keeps
  // re-rendering around a switch). Re-pin once on a settled frame.
  scheduleOverlaySettle()
}

/** One double-rAF re-pin of every live mirror. Cheap insurance against any
 *  geometry that was measured mid-transition; idempotent, self-deduping. */
let overlaySettlePending = false
function scheduleOverlaySettle() {
  if (overlaySettlePending) return
  overlaySettlePending = true
  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      overlaySettlePending = false
      for (const p of Array.from(document.querySelectorAll('pre.vditor-wysiwyg__pre'))) {
        if (!isEditingPre(p)) continue
        const ov = (p.parentElement as any)?.__vmdOverlay as HTMLElement | undefined
        if (ov && ov.isConnected) positionEditOverlay(p as HTMLPreElement, ov)
      }
    })
  })
}

function codeOf(editPre: HTMLPreElement): HTMLElement {
  return (editPre.querySelector(':scope > code') as HTMLElement) || editPre
}

/** Keyboard activation for the header bar (role=button): Enter/Space when
 *  the bar ITSELF is focused. Registered at MODULE LOAD (before vditor
 *  init) on the WINDOW CAPTURE phase — the earliest possible interception:
 *  wysiwyg/ir preview blocks live INSIDE the contenteditable containers,
 *  and vditor's own keydown handling treats Space as editor input (it can
 *  flip the block into its plain-text editing mode and even detach the
 *  preview pre). preventDefault + stopPropagation keep the keystroke ours;
 *  buttons inside the bar are skipped — they natively activate and would
 *  otherwise double-fire. */
export function installHeaderKeyActivation() {
  const w = window as any
  if (w.__vmdCbKeyActivation) return
  w.__vmdCbKeyActivation = true
  window.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' && e.key !== ' ') return
    const target = e.target as HTMLElement | null
    if (!(target instanceof HTMLElement) || !target.classList.contains('vmd-cb-header')) return
    e.preventDefault()
    e.stopPropagation()
    const pre = target.closest('pre')
    if (pre) toggleCollapse(pre, target)
  }, true)
}

/** Install the MutationObserver + delegated click handler and sweep existing
 *  blocks. Idempotent: safe to call from every vditor after() rebuild. */
export function installCodeBlockEnhancer() {
  const w = window as any
  if (!w.__vmdCodeBlockEnhancer) {
    w.__vmdCodeBlockEnhancer = true

    // Delegated at DOCUMENT CAPTURE level so it (a) survives vditor
    // destroy/rebuild cycles (theme switches) without re-binding and
    // (b) runs BEFORE vditor's own container-level click handlers: clicking
    // the header bar or its buttons must not flip the block into vditor's
    // plain-text editing mode, so those clicks are consumed with
    // stopPropagation. Clicks elsewhere (code area, editing pre) fall
    // through untouched.
    document.addEventListener('click', (e) => {
      const target = e.target as HTMLElement | null

      // Action buttons keep their own behavior and must NOT fold the block.
      const btn = target?.closest?.('.vmd-cb-btn')
      if (btn instanceof HTMLElement) {
        e.stopPropagation()
        const pre = btn.closest('pre')
        if (!pre) return

        if (btn.classList.contains('vmd-cb-wrap')) {
          const on = pre.classList.toggle('vmd-cb--wrap')
          btn.classList.toggle('vmd-cb-btn--on', on)
          btn.title = t(on ? 'disableWrap' : 'enableWrap')
          btn.setAttribute('aria-label', btn.title)
          return
        }

        if (btn.classList.contains('vmd-cb-copy')) {
          const code = pre.querySelector(':scope > code')
          const text = code ? codeTextOf(code) : ''
          const clip = (navigator as any).clipboard
          if (clip && typeof clip.writeText === 'function') {
            clip.writeText(text).then(
              () => flashCopyState(btn, 'vmd-cb-btn--ok', t('copied')),
              () => flashCopyState(btn, 'vmd-cb-btn--err', t('copyFailed'))
            )
          } else {
            flashCopyState(btn, 'vmd-cb-btn--err', t('copyFailed'))
          }
        }
        return
      }

      // Anywhere else on the header bar toggles collapse/expand. The click
      // is consumed (see the capture note above) so vditor never sees it.
      const header = target?.closest?.('.vmd-cb-header')
      if (header instanceof HTMLElement) {
        e.stopPropagation()
        const pre = header.closest('pre')
        if (!pre) return
        toggleCollapse(pre, header)
      }
    }, true)

    // Keyboard activation lives in installHeaderKeyActivation() — see the
    // registration-order note there.

    // Edit-mode mirror: typing in a plain editing pre re-renders its
    // highlight overlay (debounced). vditor REPLACES the editing block in
    // place on every keystroke, so each input first re-syncs (idempotent):
    // the fresh block must regain the editing class and its own mirror,
    // otherwise a stale fixed layer would double the text. Scrolling (page,
    // editor container, the editing pre itself) re-pins every live mirror.
    document.addEventListener('input', (e) => {
      const editPre = (e.target as HTMLElement | null)?.closest?.('pre.vditor-wysiwyg__pre')
      if (!(editPre instanceof HTMLPreElement)) return
      refreshEditOverlays()
      // IME composition frames need ink IMMEDIATELY: during composition
      // vditor takes its light path (no block replacement), so the only
      // mirror update is ours — and the foreground is transparent, meaning
      // trailing-edge debounce alone would hide the composed characters
      // for as long as the user keeps typing. Regular keystrokes just
      // schedule the debounced highlight.
      if ((e as InputEvent).isComposing) {
        const ov = (editPre.parentElement as any)?.__vmdOverlay as HTMLElement | undefined
        if (ov && ov.isConnected) renderPlainMirror(editPre, ov)
        return
      }
      scheduleMirrorRender(editPre)
    }, true)
    document.addEventListener('scroll', () => {
      // Cheap early-out: nothing to re-pin when no mirror is live.
      if (!document.querySelector('body > .vmd-cb-edit-hl')) return
      for (const p of Array.from(document.querySelectorAll('pre.vditor-wysiwyg__pre'))) {
        if (!isEditingPre(p)) continue
        const ov = (p.parentElement as any)?.__vmdOverlay as HTMLElement | undefined
        if (!ov || !ov.isConnected) continue
        // positionEditOverlay also re-syncs the horizontal scroll from the
        // <code> (the actual scrolling element) — covers both the page-wide
        // re-pin and horizontal scrolling inside the editing block itself.
        positionEditOverlay(p as HTMLPreElement, ov)
      }
    }, true)

    // Observe the whole body: vditor re-renders code blocks by replacing the
    // preview <pre> nodes (headers are lost with the old nodes), and rebuilds
    // the entire editor on theme changes. Style mutations matter too: vditor
    // flips a plain editing pre visible/hidden via inline style when a code
    // block enters/leaves edit mode. Our own insertions don't match
    // PRE_SELECTOR, so there is no observer feedback loop.
    // ANY change to a block's pre pair (added, removed, restyled — editing
    // or preview) marks the batch: vditor retires an editing block through
    // at least two paths (inline style flip vs wholesale node replacement,
    // the latter observed live when SWITCHING editing between two blocks),
    // and the layout shift a retirement causes must re-pin every live
    // mirror, or one stays pinned to the transient collapsed geometry.
    const touchesEditDom = (node: HTMLElement): boolean =>
      node.matches('pre.vditor-wysiwyg__pre, pre.vditor-wysiwyg__preview') ||
      node.querySelector('pre.vditor-wysiwyg__pre, pre.vditor-wysiwyg__preview') !== null
    const observer = new MutationObserver((mutations) => {
      let editDomTouched = false
      for (const m of mutations) {
        if (m.type === 'attributes') {
          if (
            m.target instanceof HTMLPreElement &&
            (m.target.classList.contains('vditor-wysiwyg__pre') ||
              m.target.classList.contains('vditor-wysiwyg__preview'))
          ) {
            editDomTouched = true
          }
          continue
        }
        // vditor's language-edit path (wysiwyg language input / ir hint,
        // VD:7684 / VD:11690) rewrites a preview pre's innerHTML IN PLACE:
        // the <pre> node itself survives while its children (including our
        // header) are replaced. The mutation target — not any added node —
        // is the only signal, so re-check it too. decorate() is idempotent.
        if (
          m.type === 'childList' &&
          m.target instanceof HTMLPreElement &&
          m.target.matches(PRE_SELECTOR)
        ) {
          decorate(m.target)
          continue
        }
        // NodeList is not TS-iterable under this tsconfig's lib set
        // (no DOM.Iterable); Array.from keeps the check green.
        for (const node of Array.from(m.addedNodes)) {
          if (!(node instanceof HTMLElement)) continue
          if (touchesEditDom(node)) editDomTouched = true
          if (node.matches(PRE_SELECTOR)) decorate(node as HTMLPreElement)
          else if (node.querySelectorAll(PRE_SELECTOR).length > 0) {
            decorateAll(node)
          }
        }
        for (const node of Array.from(m.removedNodes)) {
          if (node instanceof HTMLElement && touchesEditDom(node)) {
            editDomTouched = true
          }
        }
      }
      // One recompute per batch, AFTER all mutations: mirror ownership must
      // reflect the batch's final DOM state, never the mutation order (see
      // the two-block-switch note on refreshEditOverlays).
      if (editDomTouched) refreshEditOverlays()
    })
    observer.observe(document.body, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['style'],
    })
  }

  // Sweep blocks that exist right now (initial render / rebuild).
  decorateAll(document)
}
