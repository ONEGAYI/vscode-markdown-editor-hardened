#!/usr/bin/env node
/**
 * Integration test — code block header bar (language + wrap + copy)
 *
 * Boots the REAL stack in JSDOM (same harness as find-bar.js:
 * media/dist/main.js + vditor + lute), waits for vditor's after() hook —
 * which installs the code block enhancer — then asserts the DOM contract:
 *
 *   1. every fenced code block rendered in preview mode gets ONE header
 *      (.vmd-cb-header) with the raw info-string language name
 *   2. blocks without a language show "text"
 *   3. diagram languages (mermaid & co, handled by vditor's own renderers)
 *      get NO header
 *   4. the copy button writes the block's code text to the clipboard
 *   5. the wrap button toggles the wrap class on the block (off by default)
 *   6. decorations survive a vditor rebuild (theme change destroy + re-init)
 *
 * Covered modes: wysiwyg (fork default) and ir — both render code blocks
 * into `pre[data-render="2"]` preview elements that the enhancer targets.
 */

const path = require('path');
const fs = require('fs');
const { JSDOM, VirtualConsole } = require('jsdom');

const ROOT = path.join(__dirname, '..', '..');
const VDITOR = path.join(ROOT, 'media-src', 'node_modules', '.pnpm', 'vditor@3.11.2', 'node_modules', 'vditor', 'dist');
const MAIN_BUNDLE = path.join(ROOT, 'media', 'dist', 'main.js');

const MD = [
  '# Title', '',
  '```jsonc',
  '{ "a": 1 }',
  '```',
  '',
  '```JSON',
  '{ "upper": true }',
  '```',
  '',
  '```python',
  'def hello():',
  '    print("world")',
  '```',
  '',
  '```',
  'plain fenced block',
  '```',
  '',
  '```mermaid',
  'graph TD',
  '  A-->B',
  '```',
  '',
].join('\n');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function boot(mode) {
  const virtualConsole = new VirtualConsole();
  const pageErrors = [];
  virtualConsole.on('jsdomError', (err) => {
    pageErrors.push(err);
    if (process.env.VMD_PROBE_STACK) console.log('[stack]', err && err.stack ? err.stack.split('\n').slice(0, 8).join('\n') : err);
  });

  const dom = new JSDOM('<!DOCTYPE html><html><head></head><body><div id="app"></div></body></html>', {
    runScripts: 'dangerously',
    resources: 'usable',
    url: 'file://' + ROOT.replace(/\\/g, '/') + '/__code-block-test__.html',
    pretendToBeVisual: true,
    virtualConsole,
  });
  const { window } = dom;
  const { document } = window;

  window.TextDecoder = TextDecoder;
  window.TextEncoder = TextEncoder;
  window.crypto = require('crypto').webcrypto;
  if (typeof window.fetch === 'undefined') window.fetch = () => Promise.reject(new Error('fetch stub'));
  if (typeof document.execCommand !== 'function') document.execCommand = function () { return true; };
  if (!('innerText' in window.HTMLElement.prototype)) {
    Object.defineProperty(window.HTMLElement.prototype, 'innerText', {
      configurable: true, get() { return this.textContent; }, set(v) { this.textContent = v; },
    });
  }
  window.HTMLElement.prototype.scrollIntoView = function () {};

  // Clipboard mock — recorded here so the copy-button checks can read it.
  const copied = [];
  try {
    Object.defineProperty(window.navigator, 'clipboard', {
      configurable: true,
      value: { writeText: (t) => { copied.push(t); return Promise.resolve(); } },
    });
  } catch (e) { /* jsdom may seal navigator; the copy checks then fail loudly */ }

  window.eval(fs.readFileSync(path.join(ROOT, 'media', 'vditor', 'dist', 'js', 'lute', 'lute.min.js'), 'utf8'));
  if (typeof window.Lute === 'undefined') throw new Error('Lute did not load');
  const stubEl = (id) => { const s = document.createElement('script'); s.id = id; document.head.appendChild(s); };
  stubEl('vditorLuteScript');
  window.eval(fs.readFileSync(path.join(VDITOR, 'js', 'icons', 'ant.js'), 'utf8'));
  stubEl('vditorIconScript');
  window.eval(fs.readFileSync(path.join(VDITOR, 'index.js'), 'utf8'));
  if (typeof window.Vditor === 'undefined') throw new Error('Vditor did not load');

  window.acquireVsCodeApi = () => ({
    postMessage(msg) {
      if (msg.command === 'ready') {
        setTimeout(() => {
          window.dispatchEvent(new window.MessageEvent('message', {
            data: {
              command: 'update', type: 'init', content: MD,
              options: { useVscodeThemeColor: true, mode },
              theme: 'dark',
            },
          }));
        }, 0);
      }
    },
    getState: () => ({}),
    setState: () => {},
  });

  window.__vditorCdn = 'file://' + path.join(ROOT, 'media', 'vditor').replace(/\\/g, '/');
  window.console = Object.fromEntries(['log', 'info', 'warn', 'error'].map((k) => [k, () => {}]));
  window.eval(fs.readFileSync(MAIN_BUNDLE, 'utf8'));

  let booted = false;
  for (let i = 0; i < 40; i++) {
    await sleep(250);
    if (window.__vmdSearch && document.getElementById('vmd-search-bar')) {
      const current = window.vditor && window.vditor.getCurrentMode && window.vditor.getCurrentMode();
      if (current === mode) { booted = true; break; }
    }
  }
  return { window, document, pageErrors, booted, copied };
}

function headerOf(pre) {
  return pre ? pre.querySelector(':scope > .vmd-cb-header') : null;
}

// Preview-side fenced code blocks across all three editor modes. NOTE: the
// `data-render` attribute cannot be used — it stays "1" in some environments
// — so we key on the per-mode container class names instead. SV mode renders
// its preview into a bare <pre> under `.vditor-preview`.
function previewPres(document) {
  return Array.from(document.querySelectorAll(
    'pre.vditor-wysiwyg__preview, pre.vditor-ir__preview, .vditor-preview pre'
  ));
}

async function testMode(mode, checks) {
  const add = (name, pass) => checks.push({ name: `[${mode}] ${name}`, pass });
  const { window, document, pageErrors, booted, copied } = await boot(mode);
  add('real stack boots in this mode', booted);
  if (!booted) return;

  // Wait for the enhancer's MutationObserver / initial sweep to decorate the
  // rendered preview blocks (vditor renders asynchronously inside after()).
  let jsoncPre = null;
  for (let i = 0; i < 40; i++) {
    await sleep(250);
    jsoncPre = document.querySelector([
      'pre.vditor-wysiwyg__preview code.language-jsonc',
      'pre.vditor-ir__preview code.language-jsonc',
      '.vditor-preview pre code.language-jsonc',
    ].join(', '));
    if (jsoncPre && headerOf(jsoncPre.parentElement)) break;
  }

  const previewPresList = previewPres(document).filter((pre) => pre.querySelector(':scope > code'));

  add('jsonc preview block exists', !!jsoncPre);
  if (!jsoncPre) return;

  const jsoncHeader = headerOf(jsoncPre.parentElement);
  add('jsonc block has a header', !!jsoncHeader);
  if (jsoncHeader) {
    const name = jsoncHeader.querySelector('.vmd-cb-lang-name');
    add(`header shows raw info string "jsonc" (got "${name && name.textContent}")`,
      !!name && name.textContent === 'jsonc');
    add('header has wrap + copy buttons, wrap left of copy', (() => {
      const btns = jsoncHeader.querySelectorAll('.vmd-cb-actions .vmd-cb-btn');
      if (btns.length !== 2) return false;
      return btns[0].classList.contains('vmd-cb-wrap') && btns[1].classList.contains('vmd-cb-copy');
    })());
    add('exactly one header per block', jsoncPre.parentElement.querySelectorAll('.vmd-cb-header').length === 1);
  }

  // Highlighting: the alias mapping must make hljs parse ```jsonc as JSON.
  // vditor loads highlight.js asynchronously, so poll briefly for the first
  // token span to appear (plain-text fallback produces none).
  let highlighted = false;
  for (let i = 0; i < 40; i++) {
    await sleep(250);
    if (/<span class="hljs-/.test(jsoncPre.innerHTML)) { highlighted = true; break; }
  }
  add(`jsonc highlights as JSON via alias (html starts: ${jsoncPre.innerHTML.slice(0, 60)})`, highlighted);

  const plainPre = previewPresList.find((pre) => {
    const code = pre.querySelector(':scope > code');
    return code && !/language-/.test(code.className);
  });
  add('no-language block has a header', !!plainPre && !!headerOf(plainPre));
  if (plainPre && headerOf(plainPre)) {
    const name = headerOf(plainPre).querySelector('.vmd-cb-lang-name');
    add(`no-language header falls back to "text" (got "${name && name.textContent}")`,
      !!name && name.textContent === 'text');
  }

  // Uppercase fence language: header shows the raw info string as written;
  // hljs itself resolves names case-insensitively.
  const upperPre = previewPresList.find((pre) => !!pre.querySelector(':scope > code.language-JSON'));
  add('uppercase language block has a header', !!upperPre && !!headerOf(upperPre));
  if (upperPre && headerOf(upperPre)) {
    const name = headerOf(upperPre).querySelector('.vmd-cb-lang-name');
    add(`uppercase language shown verbatim "JSON" (got "${name && name.textContent}")`,
      !!name && name.textContent === 'JSON');
  }

  // mermaid is rendered by vditor's own diagram pipeline — the preview side
  // carries a <div class="language-mermaid"> (not a <code>), so search ALL
  // preview pres for EITHER shape.
  const mermaidPre = previewPres(document).find((pre) =>
    !!pre.querySelector('code.language-mermaid, div.language-mermaid'));
  const mermaidAny = mermaidPre ||
    document.querySelector('code.language-mermaid, div.language-mermaid')?.closest('pre');
  if (mode !== 'sv') {
    // SV's preview side handles diagram blocks through a different pipeline
    // (no code.language-mermaid element survives there), so only wysiwyg/ir
    // can assert on the block's presence.
    add('mermaid block exists in DOM', !!mermaidAny);
  }
  if (mode !== 'wysiwyg') {
    // Outside wysiwyg the diagram skip list still applies: no decorations.
    add('mermaid block gets NO header (when present)', !mermaidAny || !headerOf(mermaidAny));
  }

  // ── diagram interaction contract (wysiwyg only) ─────────────────────────
  // A rendered figure is a VIEWING surface, not a click-to-edit one: the raw
  // click on the figure must be swallowed (selecting/copying rendered text
  // used to flip the block into edit mode), and the ONLY entry is a </> pill
  // that appears on hover. Once editing, the block behaves like any other
  // code block: header bar + plain-source mirror.
  if (mode === 'wysiwyg' && mermaidPre) {
    const mBlock = mermaidPre.closest('.vditor-wysiwyg__block');
    const mEditPre = mBlock.querySelector('pre.vditor-wysiwyg__pre');
    add('diagram preview carries the diagram modifier class',
      mermaidPre.classList.contains('vmd-cb--diagram'));
    add('diagram block gets a header (edit-mode toolbar)', !!headerOf(mermaidPre));
    const mEditBtn = mermaidPre.querySelector(':scope > .vmd-cb-edit-btn');
    add('diagram block has a hover </> edit pill', !!mEditBtn);
    add('edit pill lives outside the header',
      !!mEditBtn && !!headerOf(mermaidPre) && !headerOf(mermaidPre).contains(mEditBtn));
    add('diagram edit pre starts hidden (precondition)',
      mEditPre.style.display === 'none');

    // Raw click on the rendered figure: stays in preview. The figure lives
    // in a <div class="language-mermaid"> (mermaid swaps its text for an SVG).
    mermaidPre.querySelector('div.language-mermaid, code.language-mermaid').click();
    await sleep(300);
    add(`clicking the rendered figure stays in preview (edit pre display "${mEditPre.style.display}")`,
      mEditPre.style.display === 'none');

    // Clicking the </> pill enters edit mode, exactly like any other block.
    mEditBtn.click();
    let diagramEditing = false;
    let diagramMirror = false;
    for (let i = 0; i < 20; i++) {
      await sleep(100);
      diagramEditing = mBlock.classList.contains('vmd-cb--editing');
      const ov = document.querySelector('body > .vmd-cb-edit-hl');
      if (diagramEditing && ov && ov.textContent.includes('graph TD')) {
        diagramMirror = true; break;
      }
    }
    add('</> pill enters edit mode (editing class + own mirror)', diagramEditing && diagramMirror);

    // Copy on a diagram block must read the SOURCE from the editing pre —
    // the preview side holds the figure (SVG once rendered), whose text is
    // the drawn labels, not the fence source.
    const mFigure = mermaidPre.querySelector('div.language-mermaid, code.language-mermaid');
    const mSource = mEditPre.querySelector('code').textContent.replace(/\n$/, '');
    mFigure.textContent = 'SVG figure label noise';
    copied.length = 0;
    headerOf(mermaidPre).querySelector('.vmd-cb-copy').click();
    await sleep(30);
    add(`diagram copy writes the source, not figure text (got ${JSON.stringify(copied)})`,
      copied.length === 1 && copied[0] === mSource);

    // Leaving edit mode retires the mirror (shared retirement path). The
    // entry was a REAL click, so the selection sits inside the diagram's
    // code — move it to the document start first (a real click elsewhere
    // always leaves exactly one range; an empty/document-anchored selection
    // never occurs in a live browser and vditor's input path mis-handles
    // both shapes in jsdom).
    const strayAnchor = document.querySelector('.vditor-wysiwyg p') || document.body;
    const strayRange = document.createRange();
    strayRange.selectNodeContents(strayAnchor);
    strayRange.collapse(true);
    window.getSelection().removeAllRanges();
    window.getSelection().addRange(strayRange);
    mEditPre.setAttribute('style', 'display: none;');
    let diagramRetired = false;
    for (let i = 0; i < 20; i++) {
      await sleep(100);
      if (!document.querySelector('body > .vmd-cb-edit-hl') && !mBlock.classList.contains('vmd-cb--editing')) {
        diagramRetired = true; break;
      }
    }
    add('leaving diagram edit mode removes the mirror', diagramRetired);
  }

  // ── wrap toggle ──
  const pre = jsoncPre.parentElement;
  // In wysiwyg the wrap class rides the BLOCK container so it also governs
  // the editing pre's code (which is a SIBLING of the preview pre); in ir/sv
  // there is no block wrapper and the class stays on the preview pre itself.
  const wrapHost = mode === 'wysiwyg' ? pre.closest('.vditor-wysiwyg__block') : pre;
  const wrapBtn = pre.querySelector('.vmd-cb-wrap');
  if (!wrapBtn) {
    add('wrap/copy buttons present — skipping interaction checks (decorator not run?)', false);
    return;
  }
  add('wrap off by default', !wrapHost.classList.contains('vmd-cb--wrap'));
  wrapBtn.click();
  add('wrap button enables wrap class', wrapHost.classList.contains('vmd-cb--wrap'));
  wrapBtn.click();
  add('wrap button toggles wrap off again', !wrapHost.classList.contains('vmd-cb--wrap'));

  // ── copy ──
  const copyBtn = pre.querySelector('.vmd-cb-copy');
  copied.length = 0;
  copyBtn.click();
  await sleep(30);
  add(`copy button writes code text to clipboard (got ${JSON.stringify(copied)})`,
    copied.length === 1 && copied[0] === '{ "a": 1 }');

  // Copy must exclude vditor's hidden line-number helper text (present when
  // the user enables preview.hljs.lineNumber; VD:3199 keeps a
  // .vditor-linenumber__temp copy of every line INSIDE <code>).
  const tempSpan = document.createElement('span');
  tempSpan.className = 'vditor-linenumber__temp';
  tempSpan.textContent = 'PHANTOM-LINE\n';
  jsoncPre.appendChild(tempSpan);
  copied.length = 0;
  copyBtn.click();
  await sleep(30);
  add(`copy excludes line-number temp text (got ${JSON.stringify(copied)})`,
    copied.length === 1 && copied[0] === '{ "a": 1 }');
  tempSpan.remove();

  // Copy failure must surface on the button (error tint + title), not just
  // a hover-only tooltip swap.
  const realClip = window.navigator.clipboard;
  Object.defineProperty(window.navigator, 'clipboard', {
    configurable: true,
    value: { writeText: () => Promise.reject(new Error('denied')) },
  });
  copyBtn.click();
  await sleep(30);
  add('copy failure adds error state to button', copyBtn.classList.contains('vmd-cb-btn--err'));
  Object.defineProperty(window.navigator, 'clipboard', { configurable: true, value: realClip });

  // Retry INSIDE the 1.5s window: the earlier flash's restore timer must not
  // truncate the new feedback (title/class must stay consistent until the
  // LATEST timer expires, then fully reset).
  if (mode === 'wysiwyg') {
    copied.length = 0;
    copyBtn.click(); // success -> ok state (gen 1)
    await sleep(30);
    Object.defineProperty(window.navigator, 'clipboard', {
      configurable: true,
      value: { writeText: () => Promise.reject(new Error('denied')) },
    });
    await sleep(800); // still inside gen-1's window
    copyBtn.click(); // failure -> err state (gen 2)
    await sleep(30);
    add('retry inside window: state switches to err with matching title',
      copyBtn.classList.contains('vmd-cb-btn--err') &&
      !copyBtn.classList.contains('vmd-cb-btn--ok') &&
      copyBtn.title === 'Copy failed');
    await sleep(2200); // let every pending timer fire
    add('state fully resets after final window', (() => {
      const w = window; // jsdom default en-US => t() resolves to en_US
      return !copyBtn.classList.contains('vmd-cb-btn--err') &&
        !copyBtn.classList.contains('vmd-cb-btn--ok') &&
        copyBtn.title === 'Copy code';
    })());
    Object.defineProperty(window.navigator, 'clipboard', { configurable: true, value: realClip });
  }

  // ── header-bar toggle (collapse / expand the whole block) ──
  // The ENTIRE header bar is the toggle control (full-width pill): hover
  // tints it and clicking anywhere on it — except the two action buttons —
  // collapses/expands the code area. Copy must keep working while collapsed
  // (display:none does not change textContent).
  const bar = pre.querySelector('.vmd-cb-header');
  add('header bar is the toggle control (role=button, focusable)',
    !!bar && bar.getAttribute('role') === 'button' && bar.tabIndex === 0);
  add('header bar carries a chevron indicator', !!bar && !!bar.querySelector('.vmd-cb-chevron'));
  add('header starts expanded (aria-expanded="true")',
    !!bar && bar.getAttribute('aria-expanded') === 'true');
  add('block not collapsed by default', !pre.classList.contains('vmd-cb--collapsed'));
  // Clicking the language-name area (deepest bubble path) toggles collapse.
  bar.querySelector('.vmd-cb-lang-name').click();
  add('click on the bar collapses the block', pre.classList.contains('vmd-cb--collapsed'));
  add('collapsed bar sets aria-expanded="false"',
    bar.getAttribute('aria-expanded') === 'false');
  copied.length = 0;
  copyBtn.click();
  await sleep(30);
  add(`copy still works while collapsed (got ${JSON.stringify(copied)})`,
    copied.length === 1 && copied[0] === '{ "a": 1 }');
  bar.click();
  add('click on the bar expands the block again', !pre.classList.contains('vmd-cb--collapsed'));
  add('expanded bar sets aria-expanded="true"', bar.getAttribute('aria-expanded') === 'true');
  add('bar clicks never touch the wrap state', !wrapHost.classList.contains('vmd-cb--wrap'));
  // Keyboard activation (role=button): Enter and Space both toggle.
  bar.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
  add('Enter on the bar collapses the block', pre.classList.contains('vmd-cb--collapsed'));
  bar.dispatchEvent(new window.KeyboardEvent('keydown', { key: ' ', bubbles: true, cancelable: true }));
  add('Space on the bar expands the block', !pre.classList.contains('vmd-cb--collapsed'));
  // Action buttons keep their own behavior — clicking them must NOT fold.
  wrapBtn.click();
  add('action-button clicks do not collapse the block', !pre.classList.contains('vmd-cb--collapsed'));
  wrapBtn.click();

  // ── edit-mode syntax highlighting overlay (wysiwyg only) ──
  // Clicking the code area flips vditor's plain editing pre visible (inline
  // display:block). The enhancer must mount a highlight MIRROR behind the
  // transparent editing text so the block stays highlighted WHILE editing,
  // re-render it on every input, and remove it when editing ends.
  if (mode === 'wysiwyg') {
    // Entering edit mode is OUR delegated takeover now: a raw click on the
    // preview text must flip the editing pre visible (jsdom has no
    // caretRangeFromPoint, so the caret lands via the first-char fallback)
    // AND place the caret inside the editing code — never a no-op.
    const tBlock = pre.closest('.vditor-wysiwyg__block');
    const tEditPre = tBlock.querySelector('pre.vditor-wysiwyg__pre');
    pre.click(); // raw click on the preview text area (not the header)
    const sel = window.getSelection();
    add('clicking the preview enters edit mode (takeover flips the editing pre)',
      tEditPre.style.display === 'block');
    add('takeover places the caret inside the editing code',
      sel && sel.rangeCount === 1 && tEditPre.querySelector('code').contains(sel.getRangeAt(0).startContainer));
    // A REAL click also lands the selection inside the block, so vditor's
    // selectionchange handler re-renders the document and REPLACES the block
    // nodes. Wait for that to settle, then re-bind fresh references — every
    // assertion below must run against the post-render DOM.
    await sleep(300);
    let block = document.querySelector('pre.vditor-wysiwyg__preview code.language-jsonc')
      .closest('.vditor-wysiwyg__block');
    let editPre = block.querySelector('pre.vditor-wysiwyg__pre');
    editPre.setAttribute('style', 'display: block;'); // idempotent: stay in edit mode
    let overlay = null;
    for (let i = 0; i < 30; i++) { await sleep(100); overlay = document.querySelector('body > .vmd-cb-edit-hl'); if (overlay) break; }
    add('editing pre visible mounts the highlight overlay (body-level, outside the editor DOM)', !!overlay);
    add('block marked vmd-cb--editing (transparent foreground)', block.classList.contains('vmd-cb--editing'));
    add(`overlay mirrors the editing text (got ${JSON.stringify(overlay && overlay.textContent.trim())})`, !!overlay && overlay.textContent.trim() === '{ "a": 1 }');
    const hljsSpans = overlay ? overlay.querySelectorAll('[class^="hljs-"]').length : 0;
    add(`overlay renders hljs tokens (got ${hljsSpans} spans)`, hljsSpans > 0);
    // typing syncs the mirror (debounced). NOTE: with the takeover the
    // selection really lives inside the block, so each input dispatch now
    // triggers vditor's per-keystroke block REPLACEMENT (exactly what the
    // live editor does) — re-bind node references after every dispatch.
    const rebind = () => {
      block = document.querySelector('pre.vditor-wysiwyg__preview code.language-jsonc')
        .closest('.vditor-wysiwyg__block');
      editPre = block.querySelector('pre.vditor-wysiwyg__pre');
    };
    editPre.querySelector('code').textContent = '{ "edited": true }\n';
    editPre.dispatchEvent(new window.Event('input', { bubbles: true }));
    let synced = false;
    // poll the LIVE mirror: the block replacement below retires the mount-time
    // overlay element, so the captured reference would never see the update
    for (let i = 0; i < 20; i++) { await sleep(100); const ov = document.querySelector('body > .vmd-cb-edit-hl'); if (ov && ov.textContent.includes('edited')) { synced = true; break; } }
    add('overlay content follows edits', synced);
    rebind();
    editPre.setAttribute('style', 'display: block;'); // the caret block carries no style — stay explicit
    // Editing-state detection must key on the DISPLAY property alone: vditor
    // hides an inactive editing pre via display:none, and Lute's caret-block
    // re-render omits the style attribute entirely — but the raw attribute
    // can legitimately carry other declarations. A substring match on
    // "none" would misjudge `user-select: none` as retired and drop the
    // mirror mid-edit (transparent text left with no ink).
    editPre.setAttribute('style', 'display: block; user-select: none;');
    let staysEditing = false;
    for (let i = 0; i < 10; i++) {
      await sleep(100);
      if (document.querySelector('body > .vmd-cb-edit-hl') && block.classList.contains('vmd-cb--editing')) { staysEditing = true; break; }
    }
    add('unrelated "none" declarations do not retire the mirror', staysEditing);
    rebind();
    editPre.setAttribute('style', 'display: block;'); // restore the plain form
    await sleep(150);
    // IME composition frames must paint ink IMMEDIATELY (not on the 60ms
    // trailing debounce): during composition vditor takes its light path
    // and never rebuilds the block, while the editing text is transparent —
    // trailing-edge-only updates would hide the composed characters.
    editPre.querySelector('code').textContent = '{ "组词": true }\n';
    editPre.dispatchEvent(new window.InputEvent('input', { bubbles: true, isComposing: true }));
    let composedVisible = false;
    // 40ms window — deliberately shorter than the 60ms debounce so only the
    // immediate path can satisfy this check.
    for (let i = 0; i < 2; i++) { await sleep(20);
      const ov = document.querySelector('body > .vmd-cb-edit-hl');
      if (ov && ov.textContent.includes('组词')) { composedVisible = true; break; } }
    add('IME composition frames mirror text immediately', composedVisible);
    rebind();
    editPre.querySelector('code').textContent = '{ "edited": true }\n'; // restore for the scenarios below
    // vditor REPLACES the editing block in place on every keystroke — the
    // input handler must re-sync the fresh block (editing class + mirror).
    const fresh = block.cloneNode(true);
    // Lute re-renders the caret block WITHOUT the style attribute entirely
    // (only non-caret blocks carry style="display: none"); clone the same
    // shape or the test would lock a contract vditor never emits.
    fresh.querySelector('pre.vditor-wysiwyg__pre').removeAttribute('style');
    block.parentNode.replaceChild(fresh, block);
    fresh.querySelector('pre.vditor-wysiwyg__pre').dispatchEvent(new window.Event('input', { bubbles: true }));
    let reattached = false;
    for (let i = 0; i < 20; i++) {
      await sleep(100);
      if (fresh.classList.contains('vmd-cb--editing') && document.querySelector('body > .vmd-cb-edit-hl')) { reattached = true; break; }
    }
    add('editing overlay re-attaches after vditor rebuilds the block', reattached);
    // leaving edit mode tears the overlay down
    const freshEdit = fresh.querySelector('pre.vditor-wysiwyg__pre');
    freshEdit.setAttribute('style', 'display: none;');
    let gone = false;
    for (let i = 0; i < 20; i++) { await sleep(100); if (!document.querySelector('body > .vmd-cb-edit-hl') && !fresh.classList.contains('vmd-cb--editing')) { gone = true; break; } }
    add('leaving edit mode removes the overlay', gone);

    // ── two-block switch: vditor activates the NEW block first and retires
    // the OLD one only ~200ms later (verified against the live editor with a
    // frame probe). During that window BOTH blocks are in edit mode, so each
    // needs its OWN mirror — a single shared layer gets stolen by the new
    // block and the old block's transparent text is left unmirrored, which
    // the user sees as the block's text "flashing" away.
    const overlays = () => Array.from(document.querySelectorAll('body > .vmd-cb-edit-hl'));
    freshEdit.setAttribute('style', 'display: block;'); // A (jsonc) edits again
    let aMirrored = false;
    for (let i = 0; i < 20; i++) { await sleep(100); if (overlays().some((o) => o.textContent.includes('edited'))) { aMirrored = true; break; } }
    add('re-entering edit mode re-mounts the mirror', aMirrored);
    const pyBlock = Array.from(document.querySelectorAll('.vditor-wysiwyg__block'))
      .find((b) => b.querySelector('pre.vditor-wysiwyg__preview code.language-python'));
    const pyEdit = pyBlock && pyBlock.querySelector('pre.vditor-wysiwyg__pre');
    pyEdit.setAttribute('style', 'display: block;'); // B enters BEFORE A retires
    await sleep(300); // both blocks edit-mode at once — vditor's real order
    add(`old block keeps its own mirror while the new block edits (got ${overlays().length})`,
      overlays().some((o) => o.textContent.includes('edited')));
    add('new block gets its own mirror',
      overlays().some((o) => o.textContent.includes('def hello')));
    add('both blocks carry the editing class',
      fresh.classList.contains('vmd-cb--editing') && !!pyBlock && pyBlock.classList.contains('vmd-cb--editing'));
    // Scroll re-pins mirrors via the capture-phase delegate; it must never
    // tear them down or error while blocks are live.
    window.dispatchEvent(new window.Event('scroll'));
    document.querySelector('.vditor').dispatchEvent(new window.Event('scroll', { bubbles: false }));
    await sleep(100);
    add(`scroll events keep live mirrors mounted (got ${overlays().length})`, overlays().length === 2);
    // A retires while B keeps editing — only A's mirror goes away.
    freshEdit.setAttribute('style', 'display: none;');
    await sleep(300);
    add(`retiring the old block removes only its mirror (got ${overlays().length})`,
      overlays().length === 1 && overlays()[0].textContent.includes('def hello'));
    add('retired block loses the editing class', !fresh.classList.contains('vmd-cb--editing'));
    // B retires too — everything is cleaned up.
    pyEdit.setAttribute('style', 'display: none;');
    await sleep(300);
    add(`last block leaving edit mode clears all overlays (got ${overlays().length})`, overlays().length === 0);

    // ── block-retirement via NODE REPLACEMENT must also resync mirrors ──
    // vditor has a second retirement path: instead of flipping the editing
    // pre's inline style, it rebuilds the old block wholesale (no style
    // mutation at all). If that batch doesn't trigger the recompute, the
    // retired block's mirror ORPHANS on the body (a fixed layer painted over
    // unrelated content) and other live mirrors never re-pin after the
    // layout shift — both seen live as "text escaping the block".
    freshEdit.setAttribute('style', 'display: block;'); // A edits again
    pyEdit.setAttribute('style', 'display: block;');    // B edits too
    await sleep(300);
    add('two mirrors mounted before the replacement path', overlays().length === 2);
    // Replace block A with a rebuilt NORMAL-state clone — childList only,
    // no editing-pre style mutation on the old block.
    const rebuiltA = fresh.cloneNode(true);
    rebuiltA.classList.remove('vmd-cb--editing');
    rebuiltA.querySelector('pre.vditor-wysiwyg__pre').setAttribute('style', 'display: none;');
    fresh.parentNode.replaceChild(rebuiltA, fresh);
    let orphanGone = false;
    for (let i = 0; i < 20; i++) {
      await sleep(100);
      const live = overlays();
      // A's mirror must be gone; B's mirror must survive the resync.
      if (live.length === 1 && live[0].textContent.includes('def hello') && !rebuiltA.classList.contains('vmd-cb--editing')) { orphanGone = true; break; }
    }
    add(`node-replacement retirement cleans the orphan mirror and keeps B's (got ${overlays().length})`, orphanGone);
    pyEdit.setAttribute('style', 'display: none;');
    await sleep(300);
    add(`cleanup after the replacement scenario (got ${overlays().length})`, overlays().length === 0);
  }

  // ── rebuild survival (theme change destroys + recreates vditor) ──
  window.dispatchEvent(new window.MessageEvent('message', {
    data: {
      command: 'update', type: 'init', content: MD,
      options: { useVscodeThemeColor: true, mode },
      theme: 'light',
    },
  }));
  let rebuiltHeader = null;
  for (let i = 0; i < 40; i++) {
    await sleep(250);
    const code = document.querySelector([
      'pre.vditor-wysiwyg__preview code.language-jsonc',
      'pre.vditor-ir__preview code.language-jsonc',
      '.vditor-preview pre code.language-jsonc',
    ].join(', '));
    if (code && headerOf(code.parentElement)) { rebuiltHeader = headerOf(code.parentElement); break; }
  }
  add('header re-decorates after vditor rebuild (theme switch)', !!rebuiltHeader);

  // ── in-place innerHTML overwrite (vditor's language-edit path), LAST ──
  // Changing the fence language in wysiwyg/ir rewrites the preview pre's
  // CONTENT in place (VD:7684): the <pre> node survives, its old children
  // (including our header) are replaced by fresh ones. The observer must
  // re-decorate the mutation TARGET too, not only newly-added pre nodes.
  // SV mode has no language-edit path, so only wysiwyg/ir assert recovery.
  if (mode !== 'sv') {
    const editPre = document.querySelector([
      'pre.vditor-wysiwyg__preview code.language-jsonc',
      'pre.vditor-ir__preview code.language-jsonc',
    ].join(', ')).parentElement;
    // Collapse FIRST: the overwrite keeps the <pre> (and its collapsed
    // class) but replaces the header — the fresh bar must be re-synced.
    editPre.querySelector('.vmd-cb-header').click();
    editPre.innerHTML = '<code class="language-go">package main\n</code>';
    let healedHeader = null;
    for (let i = 0; i < 20; i++) {
      await sleep(100);
      healedHeader = headerOf(editPre);
      if (healedHeader) break;
    }
    add('header re-decorates after in-place innerHTML overwrite (language edit)', (() => {
      if (!healedHeader) return false;
      const name = healedHeader.querySelector('.vmd-cb-lang-name');
      return !!name && name.textContent === 'go';
    })());
    add('collapse state survives the overwrite (fresh bar re-synced)', (() => {
      if (!healedHeader) return false;
      return editPre.classList.contains('vmd-cb--collapsed') &&
        healedHeader.getAttribute('aria-expanded') === 'false';
    })());
  }

  // No jsdom page-level errors (script crashes) may have slipped through.
  if (pageErrors.length > 0) {
    console.error('[code-block] pageErrors detail:');
    for (const e of pageErrors) console.error('  -', e && e.message ? `${e.message}` : String(e).slice(0, 200));
  }
  add(`no page errors (got ${pageErrors.length})`, pageErrors.length === 0);
}

async function main() {
  if (!fs.existsSync(MAIN_BUNDLE)) {
    console.error(`[code-block] bundle not found at ${MAIN_BUNDLE} — run \`cd media-src && pnpm build\``);
    process.exit(2);
  }
  const checks = [];
  for (const mode of ['wysiwyg', 'ir', 'sv']) {
    await testMode(mode, checks);
  }

  // CSS contract checks against the built bundle + theme bridge copy.
  const mainCss = fs.readFileSync(path.join(ROOT, 'media', 'dist', 'main.css'), 'utf8');
  checks.push({ name: 'built CSS kills the checkerboard background-image on pre code', pass: /pre[^{]*code[^{]*\{[^}]*background-image:\s*none/i.test(mainCss) });
  checks.push({ name: 'built CSS styles the header bar (.vmd-cb-header)', pass: /\.vmd-cb-header/.test(mainCss) });
  checks.push({ name: 'built CSS has wrap state (pre.vmd-cb--wrap)', pass: /vmd-cb--wrap/.test(mainCss) });
  // Design contract (per the user's reference mock): the header bar has NO
  // background of its own — the pre's flat surface is its background, zero
  // color difference, no border/shadow. Separation from the code area is
  // by SPACING only (padding 0.75em top / 1.25em bottom ≈ 29px raw ink gap).
  checks.push({ name: 'header has no background tint (flat, same color as code area)', pass: !/\.vmd-cb-header\{[^}]*background:/.test(mainCss) && /\.vmd-cb-header\{[^}]*padding:\.75em 1em 1\.25em/.test(mainCss) });
  checks.push({ name: 'header has no drop shadow or border (flat design)', pass: !/\.vmd-cb-header\{[^}]*box-shadow/.test(mainCss) });
  checks.push({ name: 'code block has no outer border (flat design)', pass: /\.vditor-reset pre\{[^}]*border:none!important/.test(mainCss) });
  // vditor's codeRender caps each block at `window.outerHeight - 40px` via an
  // INLINE style, so taller-than-window blocks used to grow an inner vertical
  // scrollbar (block scroll + page scroll at once). The bridge must override
  // the inline style with !important so blocks keep their natural height.
  checks.push({ name: 'built CSS unsets vditor\'s inline max-height cap on pre code (no inner v-scrollbar)', pass: /\.vditor-reset pre code\{[^}]*max-height:none!important/.test(mainCss) });
  // Header-bar affordance: the WHOLE bar is the full-width toggle pill —
  // hover tints it across the block, negative margins bleed it to the pre
  // edges, collapse hides the code area, chevron indicates the state.
  checks.push({ name: 'whole header bar tints on hover (clickability signal)', pass: /\.vmd-cb-header:hover\{[^}]*background/.test(mainCss) });
  checks.push({ name: 'header bar bleeds to the pre edges (full-width pill)', pass: /\.vmd-cb-header\{[^}]*margin:-\.75em -1em 0/.test(mainCss) });
  checks.push({ name: 'header bar tracks the pointer (cursor)', pass: /\.vmd-cb-header\{[^}]*cursor:pointer/.test(mainCss) });
  checks.push({ name: 'collapsed block hides its code area', pass: /pre\.vmd-cb--collapsed>code\{[^}]*display:none!important/.test(mainCss) });
  checks.push({ name: 'collapsed block drops the pre bottom padding (bar IS the strip)', pass: /pre\.vmd-cb--collapsed\{[^}]*padding-bottom:0!important/.test(mainCss) });
  checks.push({ name: 'collapsed bar rounds all corners', pass: /pre\.vmd-cb--collapsed>\.vmd-cb-header\{[^}]*border-radius:12px/.test(mainCss) });
  checks.push({ name: 'chevron rotates to point at the collapsed state', pass: /\.vmd-cb--collapsed[^{]*\.vmd-cb-chevron[^{]*\{[^}]*rotate\(-90deg\)/.test(mainCss) });
  // Editing a fenced block must stay IN PLACE: same block shell, toolbar
  // kept. The preview SHELL (header bar) stays on top with everything but
  // the header hidden; the editing pre sits seamlessly below — one
  // continuous rounded block, height matching the preview state.
  checks.push({ name: 'editing keeps the preview shell on top (order swap)', pass: /\.vmd-cb--editing>pre\.vditor-wysiwyg__preview\{order:-1/.test(mainCss) });
  checks.push({ name: 'editing kills the flex-hostile block marker pseudo-element', pass: /\.vmd-cb--editing:{1,2}before\{content:none!important/.test(mainCss) });
  checks.push({ name: 'editing hides the shell content except the header (incl. ZWSP placeholder)', pass: /\.vmd-cb--editing>pre\.vditor-wysiwyg__preview>:not\(\.vmd-cb-header\)\{display:none!important/.test(mainCss) });
  checks.push({ name: 'editing pre completes the block shell (no margins, lower rounding, zero top padding)', pass: /\.vmd-cb--editing>pre\.vditor-wysiwyg__pre\{[^}]*margin:0!important/.test(mainCss) && /padding:0 1em \.75em!important/.test(mainCss) && /border-radius:0 0 12px 12px!important/.test(mainCss) });
  // vditor's pre is content-box: width:100% plus the editing padding would
  // spill ~2em past the shell's right edge. The padding must count INSIDE.
  checks.push({ name: 'editing pre keeps its surface inside the shell (border-box)', pass: /\.vmd-cb--editing>pre\.vditor-wysiwyg__pre\{[^}]*box-sizing:border-box/.test(mainCss) });
  // Edit-mode highlight mirror: the editing text turns transparent (caret
  // stays visible) while an aligned, non-interactive colored layer behind
  // it carries the syntax colors — the block stays highlighted WHILE
  // editing, with the editable DOM left as plain text.
  checks.push({ name: 'editing text turns transparent for the highlight mirror', pass: /\.vditor-wysiwyg \.vmd-cb--editing>pre\.vditor-wysiwyg__pre(?:,|>|\{)[^{}]*\{[^}]*color:transparent!important/.test(mainCss) });
  checks.push({ name: 'editing caret stays visible (caret-color)', pass: /\.vditor-wysiwyg \.vmd-cb--editing>pre\.vditor-wysiwyg__pre(?:,|>|\{)[^{}]*\{[^}]*caret-color/.test(mainCss) });
  checks.push({ name: 'highlight mirror is non-interactive (pointer-events none)', pass: /\.vmd-cb-edit-hl\{[^}]*pointer-events:none/.test(mainCss) });
  // Diagram blocks (mermaid & co): the rendered figure is NOT a click-to-edit
  // surface — the only edit entry is a </> pill that appears on hover, and
  // the header bar shows only while EDITING (the preview stays a clean
  // figure). The pill must be inert while hidden, or it would intercept
  // figure-text selection clicks.
  checks.push({ name: 'diagram edit pill is hidden until hover', pass: /\.vmd-cb-edit-btn\{[^}]*opacity:0/.test(mainCss) && /\.vditor-wysiwyg__block:hover [^{]*\.vmd-cb-edit-btn[^{]*\{[^}]*opacity:1/.test(mainCss) });
  checks.push({ name: 'diagram edit pill is inert while hidden (pointer-events none)', pass: /\.vmd-cb-edit-btn\{[^}]*pointer-events:none/.test(mainCss) });
  checks.push({ name: 'diagram preview hides the header (clean figure)', pass: /vmd-cb--diagram>\.vmd-cb-header\{display:none/.test(mainCss) });
  checks.push({ name: 'diagram editing state shows the header', pass: /\.vmd-cb--editing>pre\.vditor-wysiwyg__preview\.vmd-cb--diagram>\.vmd-cb-header\{[^}]*display:flex!important/.test(mainCss) });
  // Word wrap must also govern the code being EDITED (the editing pre is a
  // sibling of the preview pre, so the class rides the block container).
  checks.push({ name: 'wrap also applies while editing (class rides the block)', pass: /\.vditor-wysiwyg__block\.vmd-cb--wrap pre code\{[^}]*white-space:pre-wrap!important/.test(mainCss) });
  // vditor ships `.vditor-wysiwyg__preview { cursor: pointer }` — the whole
  // preview (INCLUDING the code text) shows the hand. Text areas show the
  // text caret; the header bar keeps its own pointer affordance.
  checks.push({ name: 'preview text area shows the text cursor (not the hand)', pass: /pre\.vditor-wysiwyg__preview\{[^}]*cursor:text/.test(mainCss) });
  // Font-metric continuity across the edit-mode toggle: vditor pins its own
  // "Consolas, ..." stack on the plain editing pre while the preview code
  // renders with the VS Code editor font — on machines where the first
  // family resolves, the text jumps ~1.4px on every toggle and the mirror
  // (which copies the editing font) is offset from the caret. The editing
  // pre must carry the SAME editor font stack.
  checks.push({ name: 'editing pre uses the same editor font stack as the preview code', pass: /\.vditor-wysiwyg pre\.vditor-wysiwyg__pre(?:,|>|\s)code?[^{]*\{[^}]*font-family:var\(--vscode-editor-font-family[^}]*!important/.test(mainCss) || /pre\.vditor-wysiwyg__pre[^{]*\{[^}]*font-family:var\(--vscode-editor-font-family[^}]*!important/.test(mainCss) });
  // Preview code must carry the SAME editor variable: vditor's hardcoded
  // "mononoki, ..." stack is a direct rule that beats the inherited
  // .vditor-reset font, so on machines where mononoki resolves the two
  // modes render different faces and the text jumps on every toggle.
  checks.push({ name: 'preview pre code overrides vditor\'s hardcoded font with the editor variable', pass: /\.vditor-reset pre code\{[^}]*font-family:var\(--vscode-editor-font-family[^}]*!important/.test(mainCss) });

  let failures = 0;
  console.log('[code-block] checks:');
  for (const c of checks) {
    const tag = c.pass ? '✓' : '✗';
    console.log(`  ${tag} ${c.name}`);
    if (!c.pass) failures++;
  }
  if (failures > 0) {
    console.log(`\n[code-block] FAIL — ${failures}/${checks.length} check(s) failed`);
    process.exit(1);
  }
  console.log(`\n[code-block] PASS — all ${checks.length} check(s) succeeded`);
  process.exit(0);
}

main();
