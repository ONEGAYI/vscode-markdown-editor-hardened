#!/usr/bin/env node
/**
 * Integration test — raw-markdown link dispatch + in-page anchors
 * (upstream 9b6f3f8 "fix opening local link or local file Uri" +
 *  c5ccb4d "fix: TOC / in-page anchor links do nothing", adapted)
 *
 * Part A — webview behavior, real bundle:
 *   Loads media/dist/main.js in JSDOM (its top level runs
 *   fixLinkClick()) and asserts the click contract:
 *     1. a plain <a> dispatches the RAW href attribute (the old code
 *        sent el.href, which the browser had resolved against the
 *        webview's internal origin — mangling relative links into
 *        unusable vscode-webview:// absolute URLs)
 *     2. clicks on NESTED elements inside the anchor still dispatch
 *        (old code checked target.tagName === 'A' only)
 *     3. IR-mode pseudo-links ([data-type="a"] with the target in a
 *        .vditor-ir__marker--link span — vditor's IR mode never
 *        renders a real <a>) dispatch the marker's text
 *     4. in-page "#anchor" links scroll the matching heading locally
 *        (GitHub-style slug match) and are NOT forwarded to the host
 *     5. non-link clicks dispatch nothing; window.open is captured
 *
 * Part B — host-side drift guard (source-level on out/ + media-src):
 *   smoke-checks that the adapted host pieces of the upstream fix
 *   batch stay wired: scroll-position message case, FOUC gate, live
 *   gutter source, external-reload discrimination, revealInExplorer.
 */

const path = require('path');
const fs = require('fs');
const { JSDOM } = require('jsdom');

const ROOT = path.join(__dirname, '..', '..');
const MAIN_BUNDLE = path.join(ROOT, 'media', 'dist', 'main.js');
const OUT_EXT = fs.readFileSync(path.join(ROOT, 'out', 'extension.js'), 'utf8');
const OUT_DISPATCHER = fs.readFileSync(path.join(ROOT, 'out', 'webview', 'message-dispatcher.js'), 'utf8');
const MAIN_CSS = fs.readFileSync(path.join(ROOT, 'media-src', 'src', 'main.css'), 'utf8');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const checks = [];
  const add = (name, pass) => checks.push({ name, pass });

  // ---------- Part A: real webview bundle ----------
  const dom = new JSDOM('<!DOCTYPE html><html><head></head><body><div id="app"></div></body></html>', {
    runScripts: 'dangerously',
    url: 'https://webview-host.example/webview/index.html',
    pretendToBeVisual: true,
  });
  const { window } = dom;
  const { document } = window;

  const posted = [];
  window.acquireVsCodeApi = () => ({
    postMessage(msg) { posted.push(msg); },
    getState: () => ({}),
    setState: () => {},
  });
  // polyfills the bundle needs beyond jsdom's defaults (same set as
  // line-numbers-modes.js: fixCut binds document.execCommand, vditor's
  // modules reference TextDecoder/innerTex/crypto)
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
  window.console = Object.fromEntries(['log', 'info', 'warn', 'error'].map((k) => [k, () => {}]));

  window.eval(fs.readFileSync(MAIN_BUNDLE, 'utf8'));
  await sleep(50); // let the bundle's top level settle (posts 'ready')

  add('[webview] bundle posted ready', posted.some((m) => m.command === 'ready'));
  posted.length = 0;

  // click helper: dispatch a real click event on el
  const click = (el) =>
    el.dispatchEvent(new window.MouseEvent('click', { bubbles: true, cancelable: true }));

  // 1. raw href dispatch (relative path must stay relative)
  const a = document.createElement('a');
  a.setAttribute('href', './foo.md');
  a.textContent = 'foo';
  document.body.appendChild(a);
  click(a);
  add(
    '[webview] plain <a> dispatches RAW href (got ' + JSON.stringify(posted[posted.length - 1]) + ')',
    posted.length === 1 && posted[0].command === 'open-link' && posted[0].href === './foo.md'
  );
  posted.length = 0;

  // 2. nested click inside the anchor
  const b = document.createElement('a');
  b.setAttribute('href', 'https://x.example/a');
  const inner = document.createElement('span');
  inner.textContent = 'nested';
  b.appendChild(inner);
  document.body.appendChild(b);
  click(inner);
  add(
    '[webview] click on nested element still dispatches',
    posted.length === 1 && posted[0].href === 'https://x.example/a'
  );
  posted.length = 0;

  // 3. IR-mode pseudo-link: [data-type="a"] > .vditor-ir__marker--link
  const irWrap = document.createElement('p');
  irWrap.setAttribute('data-type', 'a');
  const marker = document.createElement('span');
  marker.className = 'vditor-ir__marker--link';
  marker.textContent = './bar.md';
  irWrap.appendChild(marker);
  document.body.appendChild(irWrap);
  click(marker);
  add(
    '[webview] IR-mode marker link dispatches marker text (got ' + JSON.stringify(posted[posted.length - 1]) + ')',
    posted.length === 1 && posted[0].command === 'open-link' && posted[0].href === './bar.md'
  );
  posted.length = 0;

  // 4. in-page anchor: resolved locally, never sent to the host.
  //    (headings must live under .vditor-reset — that's the container
  //    scrollToHeadingAnchor queries)
  const reset = document.createElement('div');
  reset.className = 'vditor-reset';
  document.body.appendChild(reset);
  const h2 = document.createElement('h2');
  h2.textContent = 'Foo & Bar'; // slug: foo--bar (space-per-space rule)
  reset.appendChild(h2);
  let scrolledInto = null;
  h2.scrollIntoView = () => { scrolledInto = h2; };
  const toc = document.createElement('a');
  toc.setAttribute('href', '#foo--bar');
  toc.textContent = 'toc';
  document.body.appendChild(toc);
  click(toc);
  await sleep(50);
  add(
    '[webview] "#anchor" scrolls matching heading locally (scrolled=' + (scrolledInto === h2) + ', posted=' + posted.length + ')',
    scrolledInto === h2 && posted.length === 0
  );

  // 5. non-link click + window.open capture
  click(document.body);
  add('[webview] non-link click dispatches nothing', posted.length === 0);
  window.open('https://x.example/win');
  add(
    '[webview] window.open routed to open-link',
    posted.length === 1 && posted[0].href === 'https://x.example/win'
  );
  posted.length = 0;

  // ---------- Part B: host-side drift guard ----------
  add('[host] dispatcher handles scroll message', OUT_DISPATCHER.includes("case 'scroll'"));
  add('[host] dispatcher reveals directories (revealInExplorer)', OUT_DISPATCHER.includes('revealInExplorer'));
  // runtime plumbing strings (comments may legitimately name the old
  // mechanism, so grep for the quoted message constant + the global)
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
    '[host] FOUC gate wired (data-vmd-css-loaded + data-vmd-ready)',
    OUT_EXT.includes('data-vmd-css-loaded') && OUT_EXT.includes('data-vmd-ready')
  );
  // <link … onload=…> inline handlers are blocked by our CSP — the load
  // handlers must be wired from the nonce'd script instead. (\s so the
  // loop variable `links`/`l.onload=` doesn't false-positive.)
  add(
    '[host] FOUC gate uses nonce script, not inline onload=',
    !/<link\s[^>]*onload=/.test(OUT_EXT)
  );
  add('[css] overflow-anchor disabled for scroll restore', MAIN_CSS.includes('overflow-anchor: none'));
  add('[css] right padding mirrors left (full-width fix)', /padding-right:\s*35px\s*!important/.test(MAIN_CSS));

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
