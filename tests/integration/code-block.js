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
  virtualConsole.on('jsdomError', (err) => pageErrors.push(err));

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

  // mermaid is rendered by vditor's own diagram pipeline — its <code> may be
  // replaced entirely, so search ALL preview pres (not just code-bearing ones).
  const mermaidPre = previewPres(document).find((pre) => !!pre.querySelector('code.language-mermaid'));
  const mermaidAny = mermaidPre || document.querySelector('code.language-mermaid')?.closest('pre');
  if (mode !== 'sv') {
    // SV's preview side handles diagram blocks through a different pipeline
    // (no code.language-mermaid element survives there), so only wysiwyg/ir
    // can assert on the block's presence.
    add('mermaid block exists in DOM', !!mermaidAny);
  }
  add('mermaid block gets NO header (when present)', !mermaidAny || !headerOf(mermaidAny));

  // ── wrap toggle ──
  const pre = jsoncPre.parentElement;
  const wrapBtn = pre.querySelector('.vmd-cb-wrap');
  if (!wrapBtn) {
    add('wrap/copy buttons present — skipping interaction checks (decorator not run?)', false);
    return;
  }
  add('wrap off by default', !pre.classList.contains('vmd-cb--wrap'));
  wrapBtn.click();
  add('wrap button enables wrap class', pre.classList.contains('vmd-cb--wrap'));
  wrapBtn.click();
  add('wrap button toggles wrap off again', !pre.classList.contains('vmd-cb--wrap'));

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
