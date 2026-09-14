#!/usr/bin/env node
/**
 * Integration test — raw-markdown link dispatch + in-page anchors
 * (upstream 9b6f3f8 + c5ccb4d, with this fork's adaptations)
 *
 * REAL STACK on purpose. An earlier version of this test loaded the bundle
 * into a bare JSDOM with hand-built anchors, which passed while the real
 * behaviour was broken: vditor's own click handler (options.link.isOpen,
 * default true) also calls window.open() and does NOT stopPropagation after
 * preventDefault, so a single click dispatched TWO open-link messages and
 * in-page anchors were forwarded to the host as well. Only booting real
 * vditor exercises that path.
 *
 * Per mode (wysiwyg / ir):
 *   1. a link click dispatches EXACTLY one open-link (was two)
 *   2. the value dispatched is the RAW href attribute
 *   3. an in-page "#anchor" is resolved locally: zero messages + local scroll
 *   4. an "#anchor" with a bare '%' does not throw (was an uncaught URIError)
 *   5. a non-link click dispatches nothing
 *
 * Plus source-level guards for the host-side pieces of the same batch.
 */

const path = require('path');
const fs = require('fs');
const { JSDOM, VirtualConsole } = require('jsdom');

const ROOT = path.join(__dirname, '..', '..');
const VDITOR = path.join(ROOT, 'media-src', 'node_modules', '.pnpm', 'vditor@3.11.2', 'node_modules', 'vditor', 'dist');
const MAIN_BUNDLE = path.join(ROOT, 'media', 'dist', 'main.js');
const OUT_EXT = fs.readFileSync(path.join(ROOT, 'out', 'extension.js'), 'utf8');
const OUT_DISPATCHER = fs.readFileSync(path.join(ROOT, 'out', 'webview', 'message-dispatcher.js'), 'utf8');
const MAIN_CSS = fs.readFileSync(path.join(ROOT, 'media-src', 'src', 'main.css'), 'utf8');

const MD = [
  '# Foo & Bar', '',
  'para text', '',
  '[rel link](./foo.md)', '',
  '[http link](https://x.example/a)', '',
  '[toc](#foo--bar)', '',
  '[percent](#100%)',
].join('\n');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Boot the real webview stack in the given editor mode and return handles.
 */
async function boot(mode) {
  const virtualConsole = new VirtualConsole();
  const pageErrors = [];
  virtualConsole.on('jsdomError', (err) => pageErrors.push(err));

  const dom = new JSDOM('<!DOCTYPE html><html><head></head><body><div id="app"></div></body></html>', {
    runScripts: 'dangerously',
    resources: 'usable',
    url: 'file://' + ROOT.replace(/\\/g, '/') + '/__link-click-test__.html',
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

  const posted = [];
  window.acquireVsCodeApi = () => ({
    postMessage(msg) {
      posted.push(msg);
      // Host stub: answer the bundle's 'ready' with the init message, exactly
      // as message-dispatcher.ts does. Without this the bundle waits forever
      // and vditor never mounts.
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

  // wait for vditor to mount in the requested mode
  let booted = false;
  for (let i = 0; i < 40; i++) {
    await sleep(250);
    if (window.vditor && window.vditor.getCurrentMode && window.vditor.getCurrentMode() === mode) {
      booted = true;
      break;
    }
  }
  if (!booted && process.env.LINK_CLICK_DEBUG) {
    const app = document.getElementById('app');
    console.error('[debug] vditor=', !!window.vditor,
      'mode=', window.vditor && window.vditor.getCurrentMode && window.vditor.getCurrentMode(),
      'want=', mode,
      'appChildren=', app ? app.children.length : '-',
      'ready=', document.documentElement.getAttribute('data-vmd-ready'),
      'errors=', pageErrors.map((e) => e.message));
  }
  posted.length = 0;
  pageErrors.length = 0;
  return { window, document, posted, pageErrors, booted };
}

/** Find the clickable element that carries the given href fragment. */
function findLinkTarget(document, fragment) {
  const anchors = Array.from(document.querySelectorAll('a'));
  const a = anchors.find((el) => (el.getAttribute('href') || '').includes(fragment));
  if (a) return a;
  // IR mode: the target lives in a marker span inside a [data-type="a"] wrapper
  const markers = Array.from(
    document.querySelectorAll('[data-type="a"] .vditor-ir__marker--link')
  );
  return markers.find((el) => (el.textContent || '').includes(fragment)) || null;
}

function click(window, el) {
  el.dispatchEvent(new window.MouseEvent('click', { bubbles: true, cancelable: true }));
}

async function testMode(mode, checks) {
  const add = (name, pass) => checks.push({ name: `[${mode}] ${name}`, pass });
  const { window, document, posted, pageErrors, booted } = await boot(mode);
  add('real stack boots in this mode', booted);
  if (!booted) return;
  // selector for the container that is active in THIS mode (SV carries both
  // classes on one element, the others nest a .vditor-reset)
  const rootSel = mode === 'sv' ? '.vditor-sv' : `.vditor-${mode} .vditor-reset`;

  // 1 + 2: a single click on a relative link → exactly one message, raw href
  const rel = findLinkTarget(document, './foo.md');
  if (!rel) {
    add('relative link present in the rendered document', false);
  } else {
    click(window, rel);
    await sleep(20);
    add(
      `link click dispatches exactly ONE message (got ${posted.length}: ${JSON.stringify(posted.map((m) => m.href))})`,
      posted.length === 1 && posted[0].command === 'open-link'
    );
    add(
      `dispatched value is the RAW href (got ${JSON.stringify(posted[0] && posted[0].href)})`,
      !!posted[0] && posted[0].href === './foo.md'
    );
  }

  // 1b: http link also exactly one
  posted.length = 0;
  const http = findLinkTarget(document, 'https://x.example/a');
  if (http) {
    click(window, http);
    await sleep(20);
    add(`http link click dispatches exactly ONE message (got ${posted.length})`, posted.length === 1);
  } else {
    add('http link present in the rendered document', false);
  }

  // 3: in-page anchor resolved locally, never forwarded
  posted.length = 0;
  let scrolled = false;
  const heading = document.querySelector(`${rootSel} h1`);
  if (heading) heading.scrollIntoView = () => { scrolled = true; };
  const toc = findLinkTarget(document, '#foo--bar');
  if (!toc) {
    add('in-page anchor link present in the rendered document', false);
  } else {
    click(window, toc);
    await sleep(30);
    add(
      `in-page "#anchor" is NOT forwarded to the host (got ${posted.length} message(s))`,
      posted.length === 0
    );
    add('in-page "#anchor" scrolls the matching heading locally', scrolled);
  }

  // 3b: after a mode switch, a container that was active earlier keeps its
  // rendered children while hidden. The anchor scroll must resolve the ACTIVE
  // container, or it calls scrollIntoView on a display:none heading (a no-op)
  // and the link looks dead. Inject such a stale container AHEAD of the real
  // one so a global query would hit it first.
  {
    const stale = document.createElement('div');
    stale.className = 'vditor-ir';
    stale.style.display = 'none';
    const staleReset = document.createElement('div');
    staleReset.className = 'vditor-reset';
    const staleH1 = document.createElement('h1');
    staleH1.textContent = 'Foo & Bar'; // same slug as the real heading
    staleReset.appendChild(staleH1);
    stale.appendChild(staleReset);
    document.body.insertBefore(stale, document.body.firstChild);

    let staleScrolled = false;
    staleH1.scrollIntoView = () => { staleScrolled = true; };
    let realScrolled = false;
    const realH1 = document.querySelector(`${rootSel} h1`);
    if (realH1) realH1.scrollIntoView = () => { realScrolled = true; };

    posted.length = 0;
    click(window, toc);
    await sleep(30);
    add(
      `anchor ignores a stale hidden container's heading (stale=${staleScrolled}, real=${realScrolled})`,
      realScrolled && !staleScrolled
    );
    stale.remove();
  }

  // 4: malformed percent escape must not throw
  posted.length = 0;
  pageErrors.length = 0;
  const bad = findLinkTarget(document, '#100%');
  if (bad) {
    click(window, bad);
    await sleep(30);
    add(
      `"#100%" anchor does not throw (page errors: ${pageErrors.map((e) => e.message).join(' | ') || 'none'})`,
      pageErrors.length === 0
    );
  } else {
    add('malformed-percent anchor present in the rendered document', false);
  }

  // 5: non-link click dispatches nothing
  posted.length = 0;
  const reset = document.querySelector('.vditor-reset');
  if (reset) {
    click(window, reset);
    await sleep(20);
  }
  add(`non-link click dispatches nothing (got ${posted.length})`, posted.length === 0);

  window.close();
}

async function main() {
  const checks = [];
  const add = (name, pass) => checks.push({ name, pass });

  for (const mode of ['wysiwyg', 'ir']) {
    try {
      await testMode(mode, checks);
    } catch (e) {
      add(`[${mode}] test crashed: ${e.message}`, false);
    }
  }

  // ---- source-level guards for the host-side pieces of the same batch ----
  add('[host] dispatcher handles scroll message', OUT_DISPATCHER.includes("case 'scroll'"));
  add('[host] dispatcher validates scroll top as number', OUT_DISPATCHER.includes('Number.isFinite'));
  add('[host] dispatcher reveals directories (revealInExplorer)', OUT_DISPATCHER.includes('revealInExplorer'));
  add(
    '[host] __setOrigContent snapshot plumbing removed',
    !OUT_EXT.includes("'__setOrigContent'") && !OUT_DISPATCHER.includes("'__setOrigContent'") && !OUT_EXT.includes('__lnOrig')
  );
  add('[host] gutter reads live vditor.getValue()', OUT_EXT.includes('vditor.getValue'));
  add(
    '[host] external-reload discriminates by contentChanges+dirty',
    OUT_EXT.includes('contentChanges.length > 0') && OUT_EXT.includes('isExternalReload')
  );
  add(
    '[host] empty contentChanges short-circuits the sync path',
    OUT_EXT.includes('contentChanges.length === 0')
  );
  add(
    '[host] FOUC gate wired (data-vmd-css-loaded + data-vmd-ready)',
    OUT_EXT.includes('data-vmd-css-loaded') && OUT_EXT.includes('data-vmd-ready')
  );
  add(
    '[host] FOUC gate has a reveal fallback (no permanent blank page)',
    OUT_EXT.includes('hasAttribute(\'data-vmd-ready\')')
  );
  // <link … onload=…> inline handlers are blocked by our CSP — the load
  // handlers must be wired from the nonce'd script instead. (\s so the
  // loop variable `links`/`l.onload=` doesn't false-positive.)
  add('[host] FOUC gate uses nonce script, not inline onload=', !/<link\s[^>]*onload=/.test(OUT_EXT));
  add('[link] link.isOpen disabled so vditor does not double-dispatch', fs.readFileSync(path.join(ROOT, 'media-src', 'src', 'main.ts'), 'utf8').includes('isOpen: false'));
  add('[css] overflow-anchor disabled for scroll restore', MAIN_CSS.includes('overflow-anchor: none'));
  add('[css] right padding mirrors left (full-width fix)', /padding-right:\s*35px\s*!important/.test(MAIN_CSS));
  add(
    '[css] table-wrap active state keyed off the body class (survives rebuild)',
    /body\.vmd-table-nowrap\s+\.vditor-toolbar/.test(MAIN_CSS)
  );

  let failures = 0;
  console.log('[link-click] checks:');
  for (const c of checks) {
    console.log(`  ${c.pass ? '✓' : '✗'} ${c.name}`);
    if (!c.pass) failures++;
  }
  if (failures > 0) {
    console.log(`\n[link-click] FAIL — ${failures}/${checks.length} check(s) failed`);
    process.exit(1);
  }
  console.log(`\n[link-click] PASS — all ${checks.length} checks succeeded`);
  process.exit(0);
}

main().catch((e) => {
  console.error('[link-click] crashed:', e);
  process.exit(2);
});
