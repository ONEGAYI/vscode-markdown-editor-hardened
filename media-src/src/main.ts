import './preload'

import {
  fileToBase64,
  fixCut,
  fixDarkTheme,
  fixLinkClick,
  fixPanelHover,
  handleToolbarClick,
  saveVditorOptions,
} from './utils'

import { merge } from 'lodash'
import Vditor from 'vditor'
import { format } from 'date-fns'
import 'vditor/dist/index.css'
import { t, lang } from './lang'
import { toolbar } from './toolbar'
import { fixTableIr } from './fix-table-ir'
import { initSearch } from './search'
import './main.css'
// C3.5/C3.6/C3.7: vscode-theme-bridge.css maps vditor's selectors to
// VS Code's --vscode-* CSS variables so the editor aligns with the
// user's active theme. Imported AFTER main.css so its rules win on
// tied specificity (the !important flags inside also force it over
// vditor's dynamically-loaded content-theme).
import './vscode-theme-bridge.css'

// Set to true only for local debugging of scroll-position persistence; verbose and
// not meant to ship enabled (this would spam the console for every scroll event).
const VMD_SCROLL_DEBUG = false
function scrollLog(...args: any[]) {
  if (!VMD_SCROLL_DEBUG) return
  console.log('[vmd-scroll]', ...args)
}

/**
 * Timing over which an editor build may take to reach after(). If it never does,
 * the reveal watchdog in initVditor() forces #app visible rather than leaving a
 * blank page (vditor's after() runs inside an async promise chain, so a failure
 * there cannot reach main.ts's try/catch).
 */
let revealWatchdog: ReturnType<typeof setTimeout> | undefined

function getScrollEl(): HTMLElement | null {
  // The actual scrollable container isn't always the same node (depends on mode /
  // toolbar pin state / layout), so pick whichever candidate is really overflowing
  // instead of hardcoding one selector. Wysywyg variants first — this fork defaults
  // to WYSIWYG (upstream 9c8e962 listed only the IR ones because upstream defaults
  // to IR); `.vditor-content` / bare `.vditor-reset` catch the remaining layouts.
  const candidates = [
    '.vditor-wysiwyg .vditor-reset',
    '.vditor-wysiwyg',
    '.vditor-ir .vditor-reset',
    '.vditor-ir',
    '.vditor-content',
    '.vditor-reset',
  ]
    .map((sel) => document.querySelector<HTMLElement>(sel))
    .filter(Boolean) as HTMLElement[]
  const overflowing = candidates.find((el) => el.scrollHeight - el.clientHeight > 10)
  return overflowing || candidates[0] || null
}

// Reports the current scroll position to the extension host so it can be restored
// later. This matters because the extension host disposes and recreates the whole
// webview whenever a different file is opened (single shared panel / re-resolved
// custom editor), which would otherwise reset the reading position back to the top
// every time you switch files.
//
// Coordinates with restoreScrollPosition() below via a small shared record (rather
// than a simple boolean "restoring" flag): a scroll event whose resulting position
// exactly matches what the restore just programmatically applied is our own echo and
// is ignored; any OTHER position is genuine external input (user or otherwise) and
// must always be reported immediately, even while a restore is still in flight - and
// it also cancels that in-flight restore so the two stop fighting each other.
const vmdRestoreState: { activeCancel: (() => void) | null; lastApplied: number | null } = {
  activeCancel: null,
  lastApplied: null,
}

function trackScrollPosition() {
  if ((window as any).__vmdScrollTracked) return
  ;(window as any).__vmdScrollTracked = true

  document.addEventListener(
    'scroll',
    () => {
      const el = getScrollEl()
      if (!el) return
      if (vmdRestoreState.activeCancel) {
        if (el.scrollTop === vmdRestoreState.lastApplied) {
          // Our own restore just set this value; not a real user scroll.
          return
        }
        scrollLog('scroll during restore diverged to', el.scrollTop, '- treating as user input, cancelling restore')
        vmdRestoreState.activeCancel()
      }
      // Send synchronously on every scroll event, with no debounce/rAF buffering:
      // switching to a different file disposes this webview entirely (it is not
      // merely hidden), so any deferred reporting risks losing the very last
      // position if the switch happens before the timer/frame callback fires.
      scrollLog('reporting scroll', el.scrollTop, 'on', el.className)
      vscode.postMessage({ command: 'scroll', top: el.scrollTop })
    },
    true
  )
}

function restoreScrollPosition(scrollTop: number) {
  scrollLog('restoreScrollPosition called with', scrollTop)
  if (!scrollTop) return
  const el = getScrollEl()
  if (!el) {
    scrollLog('no scroll element found, aborting restore')
    return
  }
  let userScrolled = false
  let done = false

  const apply = () => {
    if (userScrolled || done) return
    el.scrollTop = scrollTop
    vmdRestoreState.lastApplied = scrollTop
  }

  // Large documents keep resizing well past a few hundred milliseconds: mermaid
  // diagrams, tables, and images all finish laying out asynchronously, each shift
  // above the fold moves scrollTop (via Chrome's scroll-anchoring) away from the
  // restored position. Instead of giving up after a short fixed window, keep polling
  // scrollHeight and reapplying until it has been stable for a while, capped at a
  // generous hard timeout so this can't run forever.
  const POLL_MS = 150
  const SETTLE_AFTER_MS = 1200
  const HARD_CAP_MS = 20000
  const startedAt = Date.now()
  let lastHeight = el.scrollHeight
  let lastChangedAt = startedAt
  // Declared before finish() uses it so finish() can safely run before the
  // interval exists: cancel() may execute during the synchronous apply() below,
  // and a `const pollTimer` declared after finish() would then throw a TDZ
  // ReferenceError, skipping the activeCancel/lastApplied cleanup. This guards
  // that error, not the timer: on that (in practice unreachable — scroll events
  // are dispatched asynchronously) path the interval is still created afterwards
  // and then exits immediately on the `done` flag.
  let pollTimer: ReturnType<typeof setInterval> | undefined

  const cancel = () => {
    if (userScrolled) return
    userScrolled = true
    finish('cancelled - user input')
  }

  const finish = (reason: string) => {
    if (done) return
    done = true
    if (pollTimer !== undefined) clearInterval(pollTimer)
    if (vmdRestoreState.activeCancel === cancel) {
      vmdRestoreState.activeCancel = null
      vmdRestoreState.lastApplied = null
    }
    scrollLog('restore finished:', reason, 'elapsed', Date.now() - startedAt, 'ms')
  }

  // Register with the coordinator BEFORE the first apply(), so trackScrollPosition
  // never observes a scroll position we just set without also seeing activeCancel.
  vmdRestoreState.activeCancel = cancel
  apply()

  pollTimer = setInterval(() => {
    if (userScrolled) {
      finish('user scrolled')
      return
    }
    const now = Date.now()
    const h = el.scrollHeight
    if (h !== lastHeight) {
      lastHeight = h
      lastChangedAt = now
      apply()
      scrollLog('height changed to', h, 're-applied scrollTop', scrollTop, '-> actual', el.scrollTop)
    }
    if (now - lastChangedAt >= SETTLE_AFTER_MS) {
      finish('settled')
    } else if (now - startedAt >= HARD_CAP_MS) {
      finish('hard cap reached')
    }
  }, POLL_MS)
}

function initVditor(msg) {
  console.log('msg', msg)
  // Hide the editor again for the duration of this (re)build — see the
  // appVisibilityCss rule (inlined into the webview <head> by extension.ts)
  // and the matching reveal at the end of after() below. Needed on every
  // call, not just the first: a re-init can also happen without a full page
  // reload (e.g. a VS Code theme change reuses the same webview), which
  // would otherwise skip re-hiding and show the intermediate rebuild state.
  // Attributes live on <html> (not <body> like upstream) to match the
  // CSP-safe css-load wiring script, which runs while the parser may still
  // be inside <head> where <body> doesn't exist yet.
  document.documentElement.removeAttribute('data-vmd-ready')
  // Re-arm the reveal watchdog for this build. The host's page-level fallback
  // is one-shot (it fires 4s after page load), so without this a re-init that
  // fails after that window would hide #app permanently. Cleared in after().
  if (revealWatchdog !== undefined) clearTimeout(revealWatchdog)
  revealWatchdog = setTimeout(() => {
    document.documentElement.setAttribute('data-vmd-ready', '1')
  }, 4000)
  let inputTimer
  let defaultOptions: any = {}
  defaultOptions = merge(defaultOptions, msg.options, {
    preview: {
      math: {
        inlineDigit: true,
      }
    }
  })
  // DC7 / C1.14: read the locally-bundled vditor assets URL set by the
  // host in the inline init script (`window.__vditorCdn`). Falls back to
  // the empty string if unset — vditor would then default to jsdelivr,
  // which is what we explicitly do NOT want. CSP also blocks jsdelivr
  // post-C1.14, so a fallback to jsdelivr would just produce a load
  // error, not a security regression. Logging the empty-string case so
  // it surfaces during development.
  const cdn = (window as any).__vditorCdn || ''
  if (!cdn) {
    console.warn('[markdown-editor-hardened] window.__vditorCdn unset; vditor will fail to load assets')
  }
  // vditor 3.11's content-theme (the rendered-markdown styling — headings,
  // code blocks, tables, blockquotes) is loaded dynamically from
  // `${preview.theme.path}/<current>.css`. Upstream set
  // `preview.theme.current` without `path`, so vditor's loader fell back
  // to its hardcoded default CDN path. With our local-bundle, that default
  // doesn't resolve — the content-theme never loads, and the editor
  // renders with vditor's fallback styles. Set `path` explicitly so it
  // points at the local css/content-theme directory.
  const contentThemePath = cdn ? `${cdn}/dist/css/content-theme` : ''

  // Apply theme from VS Code AFTER merge so it takes precedence over stored options
  //
  // hljs.style picks the syntax-highlighting palette for fenced code blocks.
  // Default upstream is "github" (light) which clashes with dark VS Code
  // themes. We pin to vs2015 (dark) / vs (light) — the closest matches to
  // VS Code's actual syntax token colors.
  if (msg.theme === 'dark') {
    defaultOptions.theme = 'dark'
    defaultOptions.preview = defaultOptions.preview || {}
    defaultOptions.preview.theme = { current: 'dark', path: contentThemePath }
    defaultOptions.preview.hljs = defaultOptions.preview.hljs || {}
    defaultOptions.preview.hljs.style = 'vs2015'
  } else if (msg.theme === 'light') {
    defaultOptions.theme = 'classic'
    defaultOptions.preview = defaultOptions.preview || {}
    defaultOptions.preview.theme = { current: 'light', path: contentThemePath }
    defaultOptions.preview.hljs = defaultOptions.preview.hljs || {}
    defaultOptions.preview.hljs.style = 'vs'
  }
  if (window.vditor) {
    vditor.destroy()
    window.vditor = null
  }
  window.vditor = new Vditor('app', {
    width: '100%',
    height: '100%',
    minHeight: '100%',
    lang,
    cdn,
    value: msg.content,
    cache: { enable: false },
    toolbar,
    toolbarConfig: { pin: true },
    // The spread happens BEFORE the explicit mode default below so
    // the user's saved mode preference (in defaultOptions.mode, came
    // from msg.options.mode via the merge at line ~32) takes
    // priority. If they HAVE no saved preference, the `||` below
    // falls through to our 'wysiwyg' default.
    ...defaultOptions,
    // Turn OFF vditor's own link opening. vditor's `link.isOpen` defaults to true,
    // and its click handlers call `window.open(href)` before `preventDefault()` —
    // but they never stopPropagation, so the event still bubbles to the document
    // listener in fixLinkClick, and a single click dispatches TWO open-link
    // messages (an http link opens two browser tabs; an in-page `#anchor` also gets
    // forwarded to the host, which cannot resolve it). fixLinkClick already covers
    // every link shape — real <a> in WYSIWYG/preview and the IR `[data-type="a"]`
    // marker span — so vditor does not need to handle clicks at all.
    link: { isOpen: false },
    // C3.8/C3.9: default to WYSIWYG mode when the user has no saved
    // preference. (Previously 'ir' — Instant Rendering — which is a
    // dual-pane source+preview while editing; visually noisy.) Users
    // can still toggle to 'ir' or 'sv' via the toolbar's mode menu
    // ("More" → "Edit Mode"); that choice gets saved via saveVditorOptions
    // and rehydrated on the next open through `...defaultOptions` above.
    mode: defaultOptions.mode || 'wysiwyg',
    after() {
      fixDarkTheme()
      handleToolbarClick()
      fixTableIr()
      fixPanelHover()
      trackScrollPosition()
      restoreScrollPosition(msg.scrollTop)
      // Initialize search bar once (idempotent across vditor re-inits)
      if (!(window as any).__vmdSearch) {
        ;(window as any).__vmdSearch = initSearch()
      }
      // Re-bind the find bar's MutationObserver: a vditor rebuild (theme change
      // reaches here too) replaced the DOM its observer was attached to.
      ;(window as any).__vmdSearch?.reobserve?.()
      // Auto-focus on initial open (per upstream PR #154 — credit LeonardoRick).
      vditor.focus()
      // Reveal the editor (see appVisibilityCss) only once Vditor's own
      // DOM/CSS has fully settled and the saved scroll position has already
      // been applied, so the very first thing the user ever sees is the
      // final state — never an intermediate, oddly-scaled toolbar or a
      // visible jump from the top to the restored position.
      if (revealWatchdog !== undefined) clearTimeout(revealWatchdog)
      requestAnimationFrame(() => {
        document.documentElement.setAttribute('data-vmd-ready', '1')
      })
    },
    input() {
      inputTimer && clearTimeout(inputTimer)
      inputTimer = setTimeout(() => {
        vscode.postMessage({ command: 'edit', content: vditor.getValue() })
      }, 100)
    },
    upload: {
      url: '/fuzzy', // 没有 url 参数粘贴图片无法上传 see: https://github.com/Vanessa219/vditor/blob/d7628a0a7cfe5d28b055469bf06fb0ba5cfaa1b2/src/ts/util/fixBrowserBehavior.ts#L1409
      async handler(files) {
        // console.log('files', files)
        let fileInfos = await Promise.all(
          files.map(async (f) => {
            const d = new Date()
            return {
              base64: await fileToBase64(f),
              name: `${format(new Date(), 'yyyyMMdd_HHmmss')}_${f.name}`.replace(
                /[^\w-_.]+/g,
                '_'
              ),
            }
          })
        )
        vscode.postMessage({
          command: 'upload',
          files: fileInfos,
        })
        // vditor 3.11+ upload.handler must return null on success (was
        // implicit-undefined in 3.8.x). See PR #142 for the API change.
        return null
      },
    },
  })
}

window.addEventListener('message', (e) => {
  const msg = e.data
  // console.log('msg from vscode', msg)
  switch (msg.command) {
    case 'update': {
      if (msg.type === 'init') {
        if (msg.options && msg.options.useVscodeThemeColor) {
          document.body.setAttribute('data-use-vscode-theme-color', '1')
        } else {
          document.body.setAttribute('data-use-vscode-theme-color', '0')
        }
        try {
          initVditor(msg)
        } catch (error) {
          // reset options when error
          console.error(error)
          initVditor({ content: msg.content })
          saveVditorOptions()
        }
        console.log('initVditor')
      } else {
        vditor.setValue(msg.content)
        console.log('setValue')
      }
      break
    }
    case 'focus': {
      // Re-reveal focus (per upstream PR #154 — credit LeonardoRick).
      vditor.focus()
      break
    }
    case 'uploaded': {
      msg.files.forEach((f) => {
        if (f.endsWith('.wav')) {
          vditor.insertValue(
            `\n\n<audio controls="controls" src="${f}"></audio>\n\n`
          )
        } else {
          const i = new Image()
          i.src = f
          i.onload = () => {
            vditor.insertValue(`\n\n![](${f})\n\n`)
          }
          i.onerror = () => {
            vditor.insertValue(`\n\n[${f.split('/').slice(-1)[0]}](${f})\n\n`)
          }
        }
      })
      break
    }
    default:
      break
  }
})

fixLinkClick()
fixCut()

vscode.postMessage({ command: 'ready' })
