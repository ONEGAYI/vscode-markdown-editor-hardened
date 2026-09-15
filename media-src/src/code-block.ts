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
// Verified against the bundled hljs 11.7 build (197 languages).
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

/** Extract the fence language from a <code> element's `language-*` class. */
export function langOf(code: Element): string {
  const m = /(?:^|\s)language-([^\s]+)/.exec(code.className)
  return m ? m[1] : ''
}

/** Build the header bar for one code block. Language name is set via
 *  textContent so user-provided info strings can never inject markup. */
export function buildHeader(lang: string): HTMLElement {
  const header = document.createElement('div')
  header.className = 'vmd-cb-header'
  header.innerHTML =
    '<span class="vmd-cb-lang">' +
    `<span class="vmd-cb-lang-icon">${CODE_ICON_SVG}</span>` +
    '<span class="vmd-cb-lang-name"></span>' +
    '</span>' +
    '<span class="vmd-cb-actions">' +
    `<button type="button" class="vmd-cb-btn vmd-cb-wrap" title="启用自动换行" aria-label="启用自动换行">${WRAP_ICON_SVG}</button>` +
    `<button type="button" class="vmd-cb-btn vmd-cb-copy" title="复制代码" aria-label="复制代码">` +
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
  pre.insertBefore(buildHeader(lang), pre.firstChild)
  return true
}

export function decorateAll(root: ParentNode): number {
  let added = 0
  root.querySelectorAll<HTMLPreElement>(PRE_SELECTOR).forEach((pre) => {
    if (decorate(pre)) added++
  })
  return added
}

function flashCopied(btn: HTMLElement) {
  btn.classList.add('vmd-cb-btn--ok')
  btn.title = '已复制'
  setTimeout(() => {
    btn.classList.remove('vmd-cb-btn--ok')
    btn.title = '复制代码'
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
          // registerAliases writes a pure name mapping and does NOT require
          // the target language to be registered yet (third-languages.js
          // loads after highlight.min.js), so all entries can go in directly.
          for (const [alias, target] of Object.entries(LANG_ALIAS)) {
            // registerAliases throws when an alias is already present; one
            // bad entry must not break the rest.
            try {
              hljs.registerAliases!(alias, { languageName: target })
            } catch (_) {
              /* already registered — skip */
            }
          }
        }
      },
    })
  } catch (_) {
    // window.hljs could not be redefined (already a non-configurable property
    // in some environments) — highlighting then simply stays as-is.
  }
}

/** Install the MutationObserver + delegated click handler and sweep existing
 *  blocks. Idempotent: safe to call from every vditor after() rebuild. */
export function installCodeBlockEnhancer() {
  const w = window as any
  if (!w.__vmdCodeBlockEnhancer) {
    w.__vmdCodeBlockEnhancer = true

    // Delegated at document level so it survives vditor destroy/rebuild
    // cycles (theme switches) without re-binding.
    document.addEventListener('click', (e) => {
      const btn = (e.target as HTMLElement | null)?.closest?.('.vmd-cb-btn')
      if (!(btn instanceof HTMLElement)) return
      const pre = btn.closest('pre')
      if (!pre) return

      if (btn.classList.contains('vmd-cb-wrap')) {
        const on = pre.classList.toggle('vmd-cb--wrap')
        btn.classList.toggle('vmd-cb-btn--on', on)
        btn.title = on ? '关闭自动换行' : '启用自动换行'
        btn.setAttribute('aria-label', btn.title)
        return
      }

      if (btn.classList.contains('vmd-cb-copy')) {
        const code = pre.querySelector(':scope > code')
        const text = (code?.textContent || '').replace(/\n$/, '')
        const clip = (navigator as any).clipboard
        if (clip && typeof clip.writeText === 'function') {
          clip.writeText(text).then(
            () => flashCopied(btn),
            () => {
              btn.title = '复制失败'
            }
          )
        } else {
          btn.title = '复制失败'
        }
      }
    })

    // Observe the whole body: vditor re-renders code blocks by replacing the
    // preview <pre> nodes (headers are lost with the old nodes), and rebuilds
    // the entire editor on theme changes. Our own insertions don't match
    // PRE_SELECTOR, so there is no observer feedback loop.
    const observer = new MutationObserver((mutations) => {
      for (const m of mutations) {
        for (const node of m.addedNodes) {
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
