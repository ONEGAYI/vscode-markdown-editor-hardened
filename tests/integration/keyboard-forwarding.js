#!/usr/bin/env node
/**
 * Integration test — editor shortcuts must not leak into VS Code keybindings
 * (bug 2: "Ctrl+B bolds the text AND opens the sidebar").
 *
 * Mechanism (verified against microsoft/vscode source, webview runtime):
 *   The webview wrapper (pre/index.html) attaches `handleInnerKeydown` to the
 *   INNER iframe's contentWindow. It serialises every keydown and posts it to
 *   the host unconditionally — the payload has NO `defaultPrevented` field,
 *   so the host cannot know the page already consumed the key. The host
 *   (webviewElement.ts handleKeyEvent) re-dispatches a synthetic
 *   KeyboardEvent on the workbench window, where the keybinding service runs
 *   it — hence a consumed Ctrl+B ALSO runs workbench.action.toggleSidebarVisibility.
 *
 *   The only interception point inside the webview is stopPropagation BEFORE
 *   the event reaches the window-level forwarder. vditor consumes its
 *   shortcuts at the EDITOR ELEMENT level (hotkeyEvent → editorElement), and
 *   its hotkey path unconditionally calls preventDefault() — so a
 *   document-level bubble listener can see `defaultPrevented === true` for
 *   exactly the shortcuts vditor consumed, and stopPropagation those.
 *
 * This test boots the REAL webview bundle (media/dist/main.js + vditor +
 * lute, same harness as find-bar.js), installs a window-level keydown
 * recorder that mimics the VS Code forwarder, then asserts:
 *
 *   K1  Ctrl+B dispatched in the editor area IS consumed by vditor
 *       (defaultPrevented) — the premise of the interception.
 *   K2  the keydown does NOT reach the window-level forwarder
 *       (would have run the VS Code sidebar toggle) — RED before the fix.
 *   K3  vditor still receives the event at element level (the interception
 *       must not break editing).
 *   K4  unmodified plain keys still reach the forwarder (no over-blocking).
 *   K5  modifier combos vditor does NOT consume (e.g. Ctrl+Q) still reach
 *       the forwarder (VS Code keeps working for unclaimed shortcuts).
 */

const path = require('path');
const fs = require('fs');
const { JSDOM, VirtualConsole } = require('jsdom');

const ROOT = path.join(__dirname, '..', '..');
const VDITOR = path.join(ROOT, 'media-src', 'node_modules', '.pnpm', 'vditor@3.11.2', 'node_modules', 'vditor', 'dist');
const MAIN_BUNDLE = path.join(ROOT, 'media', 'dist', 'main.js');

const MD = ['# Title', '', 'some paragraph text', ''].join('\n');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function boot() {
  const virtualConsole = new VirtualConsole();
  const pageErrors = [];
  virtualConsole.on('jsdomError', (err) => pageErrors.push(err));

  const dom = new JSDOM('<!DOCTYPE html><html><head></head><body><div id="app"></div></body></html>', {
    runScripts: 'dangerously',
    resources: 'usable',
    url: 'file://' + ROOT.replace(/\\/g, '/') + '/__keyboard-test__.html',
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

  const hostMessages = [];
  window.acquireVsCodeApi = () => ({
    postMessage(msg) {
      hostMessages.push(msg);
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

  let booted = false;
  for (let i = 0; i < 40; i++) {
    await sleep(250);
    if (window.vditor && window.vditor.getCurrentMode && window.vditor.getCurrentMode() === 'wysiwyg'
        && document.querySelector('.vditor-wysiwyg .vditor-reset')) {
      booted = true;
      break;
    }
  }
  return { window, document, pageErrors, booted, hostMessages };
}

async function main() {
  const checks = [];
  const add = (name, pass, detail) => {
    checks.push({ name, pass });
    console.log(`  ${pass ? '✓' : '✗'} ${name}${detail ? ' — ' + detail : ''}`);
  };

  console.log('[keyboard-forwarding] booting real webview bundle (wysiwyg)…');
  const { window, document, booted, hostMessages } = await boot();
  add('bundle boots in wysiwyg', booted);
  if (!booted) {
    console.log('[keyboard-forwarding] FAIL — could not boot');
    process.exit(1);
  }

  const editor = document.querySelector('.vditor-wysiwyg .vditor-reset');
  if (!editor) {
    console.log('[keyboard-forwarding] FAIL — editor element not found');
    process.exit(1);
  }

  // --- window-level forwarder stand-in: this is where pre/index.html's
  // handleInnerKeydown sits. Anything that reaches the WINDOW gets forwarded
  // to VS Code's keybinding service and runs VS Code commands.
  const forwardedToWindow = [];
  window.addEventListener('keydown', (e) => {
    forwardedToWindow.push({ key: e.key, ctrlKey: e.ctrlKey });
  });

  // --- element-level recorder: proves vditor (whose listener is ON the
  // editor element) still sees the event even after the fix.
  let elementSaw = 0;
  editor.addEventListener('keydown', () => { elementSaw++; });

  const press = (opts) => {
    forwardedToWindow.length = 0;
    elementSaw = 0;
    const ev = new window.KeyboardEvent('keydown', {
      bubbles: true, cancelable: true, ...opts,
    });
    const notCancelled = editor.dispatchEvent(ev);
    return { notCancelled, defaultPrevented: !notCancelled };
  };

  // K1 + K2 + K3: Ctrl+B — consumed by vditor (bold), must not be forwarded
  {
    const { defaultPrevented } = press({ key: 'b', code: 'KeyB', ctrlKey: true });
    add('K1: vditor consumes Ctrl+B (defaultPrevented)', defaultPrevented,
        defaultPrevented ? undefined : 'vditor hotkey path did not preventDefault — premise broken');
    add('K3: element level still sees Ctrl+B (editing intact)', elementSaw > 0);
    const leaked = forwardedToWindow.some((f) => f.key === 'b' && f.ctrlKey);
    add('K2: consumed Ctrl+B does NOT reach the window forwarder', !leaked,
        leaked ? 'LEAK: VS Code would also run its Ctrl+B binding (sidebar toggle)' : undefined);
  }

  // K4: plain unmodified key must pass through to the forwarder
  {
    press({ key: 'x', code: 'KeyX' });
    add('K4: plain key still reaches the window forwarder',
        forwardedToWindow.some((f) => f.key === 'x' && !f.ctrlKey));
  }

  // K5: modifier combo vditor does NOT bind (Ctrl+Q) must pass through
  {
    const { defaultPrevented } = press({ key: 'q', code: 'KeyQ', ctrlKey: true });
    const leaked = forwardedToWindow.some((f) => f.key === 'q' && f.ctrlKey);
    add('K5: unconsumed Ctrl+Q still reaches the window forwarder', !defaultPrevented && leaked);
  }

  // K6: Ctrl+S (vditor toolbar ⌘s hotkey → webview 'save' message) — the
  // guard stops the FORWARD, but the webview save path itself must survive.
  {
    hostMessages.length = 0;
    const { defaultPrevented } = press({ key: 's', code: 'KeyS', ctrlKey: true });
    const leaked = forwardedToWindow.some((f) => f.key === 's' && f.ctrlKey);
    add('K6: Ctrl+S consumed, not forwarded, and the save message still fires',
        defaultPrevented && !leaked && hostMessages.some((m) => m.command === 'save'),
        `prevented=${defaultPrevented} leaked=${leaked} saveMsg=${hostMessages.some((m) => m.command === 'save')}`);
  }

  const failed = checks.filter((c) => !c.pass).length;
  console.log(`\n[keyboard-forwarding] ${failed === 0 ? 'PASS' : 'FAIL'} — ${checks.length - failed}/${checks.length} checks passed`);
  if (failed > 0) process.exit(1);
}

main().catch((e) => {
  console.error('[keyboard-forwarding] harness crash:', e);
  process.exit(2);
});
