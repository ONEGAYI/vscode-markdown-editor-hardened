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

    // Observe the whole body: vditor re-renders code blocks by replacing the
    // preview <pre> nodes (headers are lost with the old nodes), and rebuilds
    // the entire editor on theme changes. Our own insertions don't match
    // PRE_SELECTOR, so there is no observer feedback loop.
    const observer = new MutationObserver((mutations) => {
      for (const m of mutations) {
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
          if (node.matches(PRE_SELECTOR)) decorate(node as HTMLPreElement)
          else if (node.querySelectorAll(PRE_SELECTOR).length > 0) {
            decorateAll(node)
          }
        }
      }
    })
    observer.observe(document.body, { childList: true, subtree: true })
  }

  // Sweep blocks that exist right now (initial render / rebuild).
  decorateAll(document)
}
