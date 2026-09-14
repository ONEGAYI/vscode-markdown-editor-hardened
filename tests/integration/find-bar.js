#!/usr/bin/env node
/**
 * Integration test — in-editor find bar (upstream dd933af, verbatim port)
 *
 * Boots the REAL stack in JSDOM (same harness pattern as
 * line-numbers-modes.js: media/dist/main.js + vditor + lute), waits for
 * vditor's after() hook — which lazily builds the search bar — then:
 *
 *   1. #vmd-search-bar exists (hidden) and __vmdSearch is initialized
 *   2. Ctrl+F opens the bar (aria-hidden=false, --open class, focused)
 *   3. typing a query updates the match counter (JSDOM has no CSS
 *      Custom Highlight API — applyHighlights early-returns there, but
 *      the range-scan + counter path is fully exercised)
 *   4. Esc closes the bar and clears the counter
 *   5. toolbar carries the find and table-wrap buttons (40a47a9 / dd933af)
 *
 * Plus a package.json/settings drift guard for defaultOpenOutline (db2062c).
 */

const path = require('path');
const fs = require('fs');
const { JSDOM } = require('jsdom');

const ROOT = path.join(__dirname, '..', '..');
const VDITOR = path.join(ROOT, 'media-src', 'node_modules', '.pnpm', 'vditor@3.11.2', 'node_modules', 'vditor', 'dist');
const MAIN_BUNDLE = path.join(ROOT, 'media', 'dist', 'main.js');

const MD = [
  '# Title', '', 'para line1', 'para line2', '',
  '- item alpha', '- item beta', '',
  '> a quote line', '',
].join('\n');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const checks = [];
  const add = (name, pass) => checks.push({ name, pass });

  const dom = new JSDOM('<!DOCTYPE html><html><head></head><body><div id="app"></div></body></html>', {
    runScripts: 'dangerously',
    resources: 'usable',
    url: 'file://' + ROOT.replace(/\\/g, '/') + '/__find-bar-test__.html',
    pretendToBeVisual: true,
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
  // jsdom: scrollIntoView is not implemented — search.ts wraps the call in
  // try/catch, but stub it anyway so nothing depends on the throw path.
  window.HTMLElement.prototype.scrollIntoView = function () {};

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
              options: { useVscodeThemeColor: true, mode: 'wysiwyg' },
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

  // wait for vditor init + after() (search bar is built there)
  let booted = false;
  for (let i = 0; i < 40; i++) {
    await sleep(250);
    if (window.__vmdSearch && document.getElementById('vmd-search-bar')) { booted = true; break; }
  }
  add('real stack booted (vditor + search bar built)', booted);
  if (!booted) {
    finish(checks);
    return;
  }

  const bar = document.getElementById('vmd-search-bar');
  const input = document.getElementById('vmd-search-input');
  const count = document.getElementById('vmd-search-count');

  add('bar hidden initially (aria-hidden=true)', bar.getAttribute('aria-hidden') === 'true');

  // Ctrl+F opens
  document.dispatchEvent(new window.KeyboardEvent('keydown', {
    key: 'f', ctrlKey: true, bubbles: true, cancelable: true,
  }));
  await sleep(30);
  add(
    'Ctrl+F opens the bar',
    bar.classList.contains('vmd-search-bar--open') && bar.getAttribute('aria-hidden') === 'false'
  );

  // typing a query updates the counter — 'para' matches para line1+line2 = 2
  input.value = 'para';
  input.dispatchEvent(new window.Event('input', { bubbles: true }));
  await sleep(30);
  add(`counter shows matches (got "${count.textContent}", want "1/2")`, count.textContent === '1/2');

  // no-match count
  input.value = 'zzzz-no-such-text';
  input.dispatchEvent(new window.Event('input', { bubbles: true }));
  await sleep(30);
  add(`no-match shows 0/0 (got "${count.textContent}")`, count.textContent === '0/0');

  // Esc closes and clears
  input.dispatchEvent(new window.KeyboardEvent('keydown', {
    key: 'Escape', bubbles: true, cancelable: true,
  }));
  await sleep(30);
  add(
    'Esc closes the bar and clears the counter',
    !bar.classList.contains('vmd-search-bar--open') && count.textContent === ''
  );

  // toolbar buttons (dd933af find + 40a47a9 table-wrap)
  const toolbarBtns = Array.from(document.querySelectorAll('.vditor-toolbar button'));
  add('toolbar has find button', toolbarBtns.some((b) => b.getAttribute('data-type') === 'find'));
  add('toolbar has table-wrap button', toolbarBtns.some((b) => b.getAttribute('data-type') === 'table-wrap'));

  // drift guards (db2062c)
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  add(
    'package.json declares defaultOpenOutline',
    !!pkg.contributes.configuration.properties['markdown-editor-hardened.defaultOpenOutline']
  );
  const dispatcherSrc = fs.readFileSync(path.join(ROOT, 'src', 'webview', 'message-dispatcher.ts'), 'utf8');
  add('dispatcher wires outline.enable from setting', dispatcherSrc.includes('defaultOpenOutline'));

  finish(checks);
}

function finish(checks) {
  let failures = 0;
  console.log('[find-bar] checks:');
  for (const c of checks) {
    console.log(`  ${c.pass ? '✓' : '✗'} ${c.name}`);
    if (!c.pass) failures++;
  }
  if (failures > 0) {
    console.log(`\n[find-bar] FAIL — ${failures}/${checks.length} check(s) failed`);
    process.exit(1);
  }
  console.log(`\n[find-bar] PASS — all ${checks.length} checks succeeded`);
  process.exit(0);
}

main().catch((e) => {
  console.error('[find-bar] crashed:', e);
  process.exit(2);
});
