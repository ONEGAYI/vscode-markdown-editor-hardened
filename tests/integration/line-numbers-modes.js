#!/usr/bin/env node
/**
 * Integration test — line-number gutter across vditor editor MODES
 *
 * Regression test for the "toggle line numbers never shows anything"
 * bug. vditor 3.11 keeps ALL THREE mode containers (.vditor-wysiwyg,
 * .vditor-sv, .vditor-ir) in the DOM simultaneously; only the active
 * one is displayed and only it holds rendered block children. The
 * lineNumberScript from out/extension.js must therefore resolve the
 * ACTIVE mode's container — a bare document.querySelector(...) returns
 * the first container in document order (.vditor-wysiwyg) regardless
 * of the active mode, which left the gutter empty (or never created)
 * whenever the user's saved mode is 'ir' (the pre-0.1.14 upstream
 * default, persisted in globalState) or 'sv'.
 *
 * Drives the REAL stack in JSDOM — no hand-built DOM:
 *   media/dist/main.js (webview bundle), vditor dist/index.js,
 *   lute.min.js + ant icons preloaded past vditor's loader,
 *   lineNumberScript extracted from out/extension.js,
 *   acquireVsCodeApi stub replaying the host's init.
 *
 * Layout semantics emulated as in a real browser: elements inside a
 * non-active mode container report offsetHeight 0 / empty rects
 * (display:none subtrees don't lay out).
 *
 * SV mode is out of scope for the gutter (source-split mode has no
 * block-element editing surface); the test only asserts it initializes
 * without breaking the toggle button.
 */

const path = require('path');
const fs = require('fs');
const { JSDOM } = require('jsdom');

const ROOT = path.join(__dirname, '..', '..');
const VDITOR = path.join(ROOT, 'media-src', 'node_modules', '.pnpm', 'vditor@3.11.2', 'node_modules', 'vditor', 'dist');
const MAIN_BUNDLE = path.join(ROOT, 'media', 'dist', 'main.js');
const OUT_EXT = path.join(ROOT, 'out', 'extension.js');

const MD = [
  '---', 'title: t', '---', '', '# H1', '', 'para line1', 'para line2', '',
  '- a', '- b', '', '```js', 'code', '```', '', '| A | B |', '|---|---|',
  '| 1 | 2 |', '', '> quote',
].join('\n');
// source line where each rendered block starts (1-based)
const EXPECTED_STARTS = [1, 5, 7, 10, 13, 17, 21];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function extractLineNumberScript() {
  const src = fs.readFileSync(OUT_EXT, 'utf8');
  const startMarker = 'static lineNumberScript(nonce) {';
  const start = src.indexOf(startMarker);
  if (start === -1) throw new Error('lineNumberScript not found in out/extension.js — did you compile? (npx tsc)');
  const endMarker = '</script>`;';
  const end = src.indexOf(endMarker, start);
  if (end === -1) throw new Error('lineNumberScript end marker not found');
  const body = src.slice(start, end + endMarker.length);
  const fnSrc = body.replace(startMarker, 'function lineNumberScript(nonce) {') + '\n}';
  const mod = { exports: {} };
  new Function('module', 'exports', fnSrc + '\nmodule.exports.lineNumberScript = lineNumberScript;')(mod, mod.exports);
  return mod.exports.lineNumberScript;
}

/**
 * Boot the real webview stack for one editor mode, wait for init +
 * one 500ms gutter sync cycle, and return the observed state.
 */
async function bootMode(mode) {
  const dom = new JSDOM('<!DOCTYPE html><html><head></head><body><div id="app"></div></body></html>', {
    runScripts: 'dangerously',
    resources: 'usable',
    url: 'file://' + ROOT.replace(/\\/g, '/') + '/__modes-test__.html',
    pretendToBeVisual: true,
  });
  const { window } = dom;
  const { document } = window;

  // polyfills lute/the bundle need beyond jsdom's defaults
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

  // real-browser layout semantics: non-active mode subtrees don't lay out
  const MODE_SELECTORS = { wysiwyg: '.vditor-wysiwyg', ir: '.vditor-ir', sv: '.vditor-sv' };
  let activeMode = null; // set once the bundle initialized vditor
  const inActiveSubtree = (el) => {
    for (const m of Object.keys(MODE_SELECTORS)) {
      if (el.closest && el.closest(MODE_SELECTORS[m])) return activeMode === null || m === activeMode;
    }
    return true;
  };
  const seq = new WeakMap();
  let counter = 0;
  Object.defineProperty(window.HTMLElement.prototype, 'offsetHeight', {
    configurable: true,
    get() { return inActiveSubtree(this) ? 40 : 0; },
  });
  window.HTMLElement.prototype.getBoundingClientRect = function () {
    if (!inActiveSubtree(this)) return { x: 0, y: 0, width: 0, height: 0, left: 0, right: 0, top: 0, bottom: 0 };
    if (this.closest && this.closest('.vditor-wysiwyg, .vditor-ir, .vditor-sv') === this) {
      return { x: 0, y: 0, width: 900, height: 100000, left: 0, right: 900, top: 0, bottom: 100000 };
    }
    if (!seq.has(this)) seq.set(this, counter++);
    const top = 100 + seq.get(this) * 50;
    return { x: 0, y: top, width: 900, height: 40, left: 0, right: 900, top, bottom: top + 40 };
  };

  // preload lute + icons past vditor's XHR loader (same trick the
  // extension uses with the vditorIconScript element-id short-circuit)
  window.eval(fs.readFileSync(path.join(ROOT, 'media', 'vditor', 'dist', 'js', 'lute', 'lute.min.js'), 'utf8'));
  if (typeof window.Lute === 'undefined') throw new Error('Lute did not load');
  const stubEl = (id) => { const s = document.createElement('script'); s.id = id; document.head.appendChild(s); };
  stubEl('vditorLuteScript');
  window.eval(fs.readFileSync(path.join(VDITOR, 'js', 'icons', 'ant.js'), 'utf8'));
  stubEl('vditorIconScript');

  window.eval(fs.readFileSync(path.join(VDITOR, 'index.js'), 'utf8'));
  if (typeof window.Vditor === 'undefined') throw new Error('Vditor did not load');

  // host stub: the bundle derives window.vscode from acquireVsCodeApi()
  window.acquireVsCodeApi = () => ({
    postMessage(msg) {
      if (msg.command === 'ready') {
        setTimeout(() => {
          window.dispatchEvent(new window.MessageEvent('message', {
            data: {
              command: 'update', type: 'init', content: MD,
              options: { useVscodeThemeColor: true, showLineNumbers: true, mode },
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
  // the bundle logs init traffic; keep test output clean
  window.console = Object.fromEntries(['log', 'info', 'warn', 'error'].map((k) => [k, () => {}]));
  window.eval(fs.readFileSync(MAIN_BUNDLE, 'utf8'));

  // inject the line-number script exactly as the host would
  const html = extractLineNumberScript()('modes-test-nonce');
  window.eval(html.replace(/^[\s\S]*?<script[^>]*>/, '').replace(/<\/script>$/, ''));
  // (no __setOrigContent post — the gutter reads vditor.getValue()
  //  directly since upstream 9b4f158; the real vditor instance was
  //  initialized with value: MD, so getValue() returns MD)

  // wait for vditor init, then expose the active mode to the layout stub
  for (let i = 0; i < 40; i++) {
    await sleep(250);
    if (window.vditor && window.vditor.getCurrentMode) {
      const m = window.vditor.getCurrentMode();
      if (m) { activeMode = m; break; }
    }
  }
  await sleep(1200); // >= 2 sync() polling cycles

  const gutter = document.getElementById('ln-gutter');
  const numbers = gutter ? Array.from(gutter.querySelectorAll('.ln')).map((n) => n.textContent.trim()) : [];
  return {
    mode: activeMode,
    toggleBtn: !!document.getElementById('ln-toggle'),
    gutter: !!gutter,
    numbers,
    lnEnabled: window.__lnEnabled,
    lnOrigDefined: typeof window.__lnOrig !== 'undefined',
    window, document,
  };
}

async function main() {
  const checks = [];
  const add = (name, pass) => checks.push({ name, pass });

  for (const mode of ['wysiwyg', 'ir', 'sv']) {
    let st;
    try {
      st = await bootMode(mode);
    } catch (e) {
      add(`[${mode}] real-stack boot succeeds`, false);
      console.error(`[${mode}] boot crashed:`, e.message);
      continue;
    }
    add(`[${mode}] vditor initialized (current mode=${st.mode})`, st.mode === mode);
    add(`[${mode}] #ln-toggle button injected`, st.toggleBtn);
    add(`[${mode}] snapshot plumbing removed (__lnOrig undefined)`, !st.lnOrigDefined);
    if (mode === 'sv') {
      // SV (source-split) mode has no block editing surface; gutter is
      // documented unsupported there. Only require the toggle to exist.
      console.log(`  [sv] gutter present: ${st.gutter} (documented unsupported) numbers: [${st.numbers}]`);
      continue;
    }
    add(`[${mode}] #ln-gutter created`, st.gutter);
    add(`[${mode}] one .ln per block (got ${st.numbers.length}, want ${EXPECTED_STARTS.length})`, st.numbers.length === EXPECTED_STARTS.length);
    // Exact block-start mapping + drift are pinned by line-numbers.js on
    // a controlled stack. Here the numbers come from the REAL
    // vditor.getValue(), whose blank-line normalization differs per mode
    // (wysiwyg collapses the blank after frontmatter, ir doesn't, etc.)
    // — the gutter is faithful to each mode's live value, so assert the
    // structural contract instead of mode-specific exact values.
    const nums = st.numbers.map(Number);
    add(`[${mode}] numbers strictly increasing from 1 (got [${st.numbers}])`,
      nums.length === EXPECTED_STARTS.length && nums[0] === 1 && nums.every((n, i) => i === 0 || n > nums[i - 1]));
    // toggle behavior on the REAL stack: hide, then restore
    const btn = st.document.getElementById('ln-toggle');
    const gutterEl = st.document.getElementById('ln-gutter');
    let toggleOk = false;
    if (btn && gutterEl) {
      btn.click();
      const hidden = st.window.__lnEnabled === false && gutterEl.style.display === 'none';
      btn.click();
      await sleep(650); // let the 500ms sync() cycle repaint
      const restored = st.window.__lnEnabled === true
        && gutterEl.style.display !== 'none'
        && gutterEl.querySelectorAll('.ln').length === EXPECTED_STARTS.length;
      toggleOk = hidden && restored;
    }
    add(`[${mode}] # toggle hides and restores the gutter`, toggleOk);
  }

  let failures = 0;
  console.log('[line-numbers-modes] checks:');
  for (const c of checks) {
    console.log(`  ${c.pass ? '✓' : '✗'} ${c.name}`);
    if (!c.pass) failures++;
  }
  if (failures > 0) {
    console.log(`\n[line-numbers-modes] FAIL — ${failures}/${checks.length} check(s) failed`);
    process.exit(1);
  }
  console.log(`\n[line-numbers-modes] PASS — all ${checks.length} checks succeeded`);
  process.exit(0);
}

main().catch((e) => { console.error('[line-numbers-modes] crashed:', e); process.exit(2); });
