#!/usr/bin/env node
/**
 * Integration test — in-editor find bar (upstream dd933af, fork-adapted)
 *
 * Boots the REAL stack in JSDOM (same harness as line-numbers-modes.js:
 * media/dist/main.js + vditor + lute) for EACH editor mode, waits for
 * vditor's after() hook — which lazily builds the search bar — then:
 *
 *   1. #vmd-search-bar exists (hidden) and __vmdSearch is initialized
 *   2. Ctrl+F opens the bar (aria-hidden=false, --open class)
 *   3. typing a query updates the match counter
 *   4. Esc closes the bar and clears the counter
 *
 * All three modes are covered because the fork's getEditorRoot() adaptation
 * has to resolve the ACTIVE container: with the WYSIWYG default, upstream's
 * fixed IR-first order finds nothing, and SV needs its own branch (vditor
 * puts both `vditor-sv` and `vditor-reset` on ONE element, so the descendant
 * selector misses it) — that mode silently reported 0/0 before the fix.
 *
 * Plus a package.json/settings drift guard for defaultOpenOutline (db2062c).
 */

const path = require('path');
const fs = require('fs');
const { JSDOM, VirtualConsole } = require('jsdom');

const ROOT = path.join(__dirname, '..', '..');
const VDITOR = path.join(ROOT, 'media-src', 'node_modules', '.pnpm', 'vditor@3.11.2', 'node_modules', 'vditor', 'dist');
const MAIN_BUNDLE = path.join(ROOT, 'media', 'dist', 'main.js');

const MD = [
  '# Title', '', 'para line1', 'para line2', '',
  '- item alpha', '- item beta', '',
  '> a quote line', '',
].join('\n');

// 'para' appears twice in the document, so every mode must report 1/2.
const EXPECTED_COUNT = '1/2';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function boot(mode) {
  const virtualConsole = new VirtualConsole();
  const pageErrors = [];
  virtualConsole.on('jsdomError', (err) => pageErrors.push(err));

  const dom = new JSDOM('<!DOCTYPE html><html><head></head><body><div id="app"></div></body></html>', {
    runScripts: 'dangerously',
    resources: 'usable',
    url: 'file://' + ROOT.replace(/\\/g, '/') + '/__find-bar-test__.html',
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
  return { window, document, pageErrors, booted };
}

async function testMode(mode, checks) {
  const add = (name, pass) => checks.push({ name: `[${mode}] ${name}`, pass });
  const { window, document, pageErrors, booted } = await boot(mode);
  add('real stack boots in this mode', booted);
  if (!booted) return;

  // Let initSearch()'s one-shot 1000ms observeRoot() timer fire FIRST, so it
  // binds the container that is current now. Otherwise it lands after the
  // rebuild below and binds the new container, hiding whether the explicit
  // re-binding paths work at all.
  await sleep(1600);

  const bar = document.getElementById('vmd-search-bar');
  const input = document.getElementById('vmd-search-input');
  const count = document.getElementById('vmd-search-count');

  add('bar hidden initially (aria-hidden=true)', bar.getAttribute('aria-hidden') === 'true');

  document.dispatchEvent(new window.KeyboardEvent('keydown', {
    key: 'f', ctrlKey: true, bubbles: true, cancelable: true,
  }));
  await sleep(30);
  add(
    'Ctrl+F opens the bar',
    bar.classList.contains('vmd-search-bar--open') && bar.getAttribute('aria-hidden') === 'false'
  );

  // CapsLock-held Ctrl+F: the key is reported as 'F'
  document.dispatchEvent(new window.KeyboardEvent('keydown', {
    key: 'Escape', bubbles: true, cancelable: true,
  }));
  input.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
  await sleep(20);
  document.dispatchEvent(new window.KeyboardEvent('keydown', {
    key: 'F', ctrlKey: true, bubbles: true, cancelable: true,
  }));
  await sleep(30);
  add('uppercase Ctrl+F (CapsLock) also opens the bar', bar.classList.contains('vmd-search-bar--open'));

  input.value = 'para';
  input.dispatchEvent(new window.Event('input', { bubbles: true }));
  await sleep(30);
  add(
    `counter shows matches in this mode (got "${count.textContent}", want "${EXPECTED_COUNT}")`,
    count.textContent === EXPECTED_COUNT
  );

  input.value = 'zzzz-no-such-text';
  input.dispatchEvent(new window.Event('input', { bubbles: true }));
  await sleep(30);
  add(`no-match shows 0/0 (got "${count.textContent}")`, count.textContent === '0/0');

  // Observer re-binding across a vditor rebuild (theme change). Run while the
  // bar is still OPEN, and deliberately WITHOUT a query set during the rebuild:
  // the observer's refresh condition requires input.value, so an empty query
  // keeps the rebuild's DOM churn from firing runSearch() — which would rebind
  // as a side effect and mask whether after()'s reobserve() ran. The query is
  // then set WITHOUT dispatching an input event, so only the observer can
  // change the counter.
  if (mode === 'wysiwyg') {
    input.value = '';
    window.dispatchEvent(new window.MessageEvent('message', {
      data: {
        command: 'update', type: 'init', content: MD.replace('para line2', 'para line2\n\npara line3'),
        options: { useVscodeThemeColor: true, mode },
        theme: 'light',
      },
    }));
    await sleep(3000); // let vditor destroy + rebuild
    input.value = 'para'; // 3 occurrences in the rebuilt doc, 4 after the mutation
    // Mutate the NEW active container: only an observer re-bound to it sees this.
    const freshRoot = document.querySelector('.vditor-wysiwyg .vditor-reset');
    if (freshRoot) {
      const p = document.createElement('p');
      p.textContent = 'para line4';
      freshRoot.appendChild(p);
    }
    await sleep(700); // observer debounce is 300ms
    add(
      `observer re-binds after a vditor rebuild (counter got "${count.textContent}", want "1/4")`,
      count.textContent === '1/4'
    );
  }

  input.dispatchEvent(new window.KeyboardEvent('keydown', {
    key: 'Escape', bubbles: true, cancelable: true,
  }));
  await sleep(30);
  add(
    'Esc closes the bar and clears the counter',
    !bar.classList.contains('vmd-search-bar--open') && count.textContent === ''
  );

  add(`no page errors during search (${pageErrors.map((e) => e.message).join(' | ') || 'none'})`, pageErrors.length === 0);

  // Toolbar buttons must be verified against the REAL rendered toolbar, not the
  // source text: media/dist/main.js is committed, so a source edit that was
  // never rebuilt would slip past a grep-based check.
  if (mode === 'wysiwyg') {
    const types = Array.from(document.querySelectorAll('.vditor-toolbar [data-type]'))
      .map((b) => b.getAttribute('data-type'));
    add(`real toolbar exposes the find button (got [${types.join(',')}])`, types.includes('find'));
    add('real toolbar exposes the table-wrap button', types.includes('table-wrap'));
  }

  window.close();
}

async function main() {
  const checks = [];
  const add = (name, pass) => checks.push({ name, pass });

  for (const mode of ['wysiwyg', 'ir', 'sv']) {
    try {
      await testMode(mode, checks);
    } catch (e) {
      add(`[${mode}] test crashed: ${e.message}`, false);
    }
  }

  // ---- toolbar buttons: source-level drift guard (the DOM assertion runs
  //      inside testMode against the real rendered toolbar) ----
  const src = fs.readFileSync(path.join(ROOT, 'media-src', 'src', 'toolbar.ts'), 'utf8');
  add('[toolbar] find button declared in source', src.includes("name: 'find'"));
  add('[toolbar] table-wrap button declared in source', src.includes("name: 'table-wrap'"));

  // ---- drift guards (db2062c) ----
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  add(
    'package.json declares defaultOpenOutline',
    !!pkg.contributes.configuration.properties['markdown-editor-hardened.defaultOpenOutline']
  );
  const dispatcherSrc = fs.readFileSync(path.join(ROOT, 'src', 'webview', 'message-dispatcher.ts'), 'utf8');
  add('dispatcher wires outline.enable from setting', dispatcherSrc.includes('defaultOpenOutline'));

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
