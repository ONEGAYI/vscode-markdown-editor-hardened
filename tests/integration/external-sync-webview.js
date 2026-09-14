#!/usr/bin/env node
/**
 * Integration test — webview side of external-edit sync (layer 3 of the
 * bug-1 feedback loop).
 *
 * Layer 2 (external-sync.js) proved the extension host posts `update` when
 * the document changes externally. This test proves the receiving end works:
 * the REAL webview bundle (media/dist/main.js + vditor + lute) applies a
 * non-init `update` message via vditor.setValue and the rendered document
 * changes accordingly — i.e. once the host-side paths are fixed, the edit
 * becomes visible to the user.
 *
 *   W1  boot (wysiwyg)
 *   W2  non-init update with new content → vditor.getValue() reflects it
 *   W3  the rendered DOM contains the new block (user-visible rendering)
 */

const path = require('path');
const fs = require('fs');
const { JSDOM, VirtualConsole } = require('jsdom');

const ROOT = path.join(__dirname, '..', '..');
const VDITOR = path.join(ROOT, 'media-src', 'node_modules', '.pnpm', 'vditor@3.11.2', 'node_modules', 'vditor', 'dist');
const MAIN_BUNDLE = path.join(ROOT, 'media', 'dist', 'main.js');

const MD_V1 = '# Title v1\n\nold paragraph\n';
const MD_V2 = '# Title v2\n\nparagraph edited by AGENT\n';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function boot() {
  const virtualConsole = new VirtualConsole();
  const pageErrors = [];
  virtualConsole.on('jsdomError', (err) => pageErrors.push(err));

  const dom = new JSDOM('<!DOCTYPE html><html><head></head><body><div id="app"></div></body></html>', {
    runScripts: 'dangerously',
    resources: 'usable',
    url: 'file://' + ROOT.replace(/\\/g, '/') + '/__ext-sync-webview-test__.html',
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
  window.HTMLElement.prototype.scrollIntoView = function () {};

  window.eval(fs.readFileSync(path.join(ROOT, 'media', 'vditor', 'dist', 'js', 'lute', 'lute.min.js'), 'utf8'));
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
              command: 'update', type: 'init', content: MD_V1,
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

  let booted = false;
  for (let i = 0; i < 40; i++) {
    await sleep(250);
    if (window.vditor && window.vditor.getCurrentMode && window.vditor.getCurrentMode() === 'wysiwyg'
        && document.querySelector('.vditor-wysiwyg .vditor-reset')) {
      booted = true;
      break;
    }
  }
  return { window, document, pageErrors, booted };
}

async function main() {
  const checks = [];
  const add = (name, pass, detail) => {
    checks.push({ name, pass });
    console.log(`  ${pass ? '✓' : '✗'} ${name}${detail ? ' — ' + detail : ''}`);
  };

  console.log('[external-sync-webview] booting real webview bundle (wysiwyg)…');
  const { window, document, booted } = await boot();
  add('W1: bundle boots in wysiwyg', booted);
  if (!booted) {
    console.log('[external-sync-webview] FAIL — could not boot');
    process.exit(1);
  }

  add('W1b: initial content applied', (window.vditor.getValue() || '') === MD_V1);

  // non-init update — what the host sends for an external change
  window.dispatchEvent(new window.MessageEvent('message', {
    data: { command: 'update', content: MD_V2 },
  }));
  await sleep(700); // vditor re-render settle

  add('W2: vditor value reflects the pushed update', (window.vditor.getValue() || '') === MD_V2,
      JSON.stringify((window.vditor.getValue() || '').slice(0, 40)));

  const bodyText = (document.querySelector('.vditor-wysiwyg .vditor-reset') || {}).textContent || '';
  add('W3: rendered DOM contains the new content', bodyText.includes('paragraph edited by AGENT'));

  const failed = checks.filter((c) => !c.pass).length;
  console.log(`\n[external-sync-webview] ${failed === 0 ? 'PASS' : 'FAIL'} — ${checks.length - failed}/${checks.length} checks passed`);
  if (failed > 0) process.exit(1);
}

main().catch((e) => {
  console.error('[external-sync-webview] harness crash:', e);
  process.exit(2);
});
