#!/usr/bin/env node
/**
 * Integration test — line-number gutter (PR #157 / C1.18) end-to-end
 *
 * Drives the ACTUAL lineNumberScript shipped in out/extension.js (the
 * code the webview receives at runtime) inside a JSDOM page whose DOM
 * mirrors vditor 3.11.2's real WYSIWYG structure:
 *
 *   div.vditor
 *     div.vditor-toolbar.vditor-toolbar--pin
 *     div.vditor-content
 *       div.vditor-wysiwyg
 *         pre.vditor-reset[contenteditable]   <- block children live here
 *
 * (structure verified against vditor dist/index.js:14958-14959,
 *  contentElement.className = "vditor-content" at 6335)
 *
 * Asserts the full feature chain the user sees:
 *   1. the `#` toggle button is injected into the toolbar
 *   2. the `#ln-gutter` element is created on <body>
 *   3. one `.ln` element per rendered block
 *   4. the numbers map to SOURCE line numbers (frontmatter=1, h1=5, ...)
 *   5. clicking the toggle hides the gutter; clicking again restores it
 *
 * Layout APIs (offsetHeight / getBoundingClientRect) are stubbed via a
 * per-element rect map — jsdom has no layout engine, and the script's
 * visibility filter (offsetHeight>0) would drop every block otherwise.
 */

const path = require('path');
const fs = require('fs');
const { JSDOM } = require('jsdom');

const OUT_EXT = path.join(__dirname, '..', '..', 'out', 'extension.js');

/**
 * Extract `static lineNumberScript(nonce)` from the compiled output and
 * return it as a callable. Uses the compiled artifact (not src/) so the
 * test exercises exactly what the webview receives.
 */
function extractLineNumberScript() {
  const src = fs.readFileSync(OUT_EXT, 'utf8');
  const startMarker = 'static lineNumberScript(nonce) {';
  const start = src.indexOf(startMarker);
  if (start === -1) throw new Error('lineNumberScript not found in out/extension.js');
  const endMarker = '</script>`;';
  const end = src.indexOf(endMarker, start);
  if (end === -1) throw new Error('lineNumberScript end marker not found');
  const methodBody = src.slice(start, end + endMarker.length);
  const fnSrc = methodBody.replace(startMarker, 'function lineNumberScript(nonce) {') + '\n}';
  const mod = { exports: {} };
  // eslint-disable-next-line no-new-func
  new Function('module', 'exports', fnSrc + '\nmodule.exports.lineNumberScript = lineNumberScript;')(
    mod,
    mod.exports
  );
  return mod.exports.lineNumberScript;
}

/**
 * Source markdown and the corresponding rendered blocks. Line starts
 * (1-based) of each block in MD:
 *   frontmatter -> 1, h1 -> 5, paragraph -> 7, ul -> 10,
 *   fenced code -> 13, table -> 17, blockquote -> 21
 */
const MD = [
  '---',            // 1
  'title: t',       // 2
  '---',            // 3
  '',               // 4
  '# H1',           // 5
  '',               // 6
  'para line1',     // 7
  'para line2',     // 8
  '',               // 9
  '- a',            // 10
  '- b',            // 11
  '',               // 12
  '```js',          // 13
  'code',           // 14
  '```',            // 15
  '',               // 16
  '| A | B |',      // 17
  '|---|---|',      // 18
  '| 1 | 2 |',      // 19
  '',               // 20
  '> quote',        // 21
].join('\n');

const BLOCK_TAGS = [
  ['pre', 'frontmatter'],  // vditor renders frontmatter as a code block
  ['h1', 'H1'],
  ['p', 'para'],
  ['ul', 'list'],
  ['pre', 'code fence'],
  ['table', 'table'],
  ['blockquote', 'quote'],
];
const EXPECTED_STARTS = [1, 5, 7, 10, 13, 17, 21];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  console.log('[line-numbers] extracting lineNumberScript from out/extension.js');
  const lineNumberScript = extractLineNumberScript();
  const html = lineNumberScript('test-nonce');

  // --- sanity: the injected HTML carries the gutter machinery ---
  const preChecks = [
    { name: 'script carries ln-gutter style', pass: html.includes('#ln-gutter') },
    { name: 'script listens for __setOrigContent', pass: html.includes('__setOrigContent') },
  ];

  // --- build the vditor-like DOM ---
  const dom = new JSDOM('<!DOCTYPE html><html><body><div id="app"></div></body></html>', {
    runScripts: 'dangerously',
  });
  const { window } = dom;
  const { document } = window;

  const app = document.getElementById('app');
  app.innerHTML = `
    <div class="vditor vditor--wysiwyg">
      <div class="vditor-toolbar vditor-toolbar--pin"></div>
      <div class="vditor-content">
        <div class="vditor-wysiwyg">
          <pre class="vditor-reset" contenteditable="true" spellcheck="false"></pre>
        </div>
      </div>
    </div>`;
  const reset = document.querySelector('pre.vditor-reset');
  const rectMap = new WeakMap();
  const addRect = (el, x, y, w, h) => rectMap.set(el, { x, y, width: w, height: h, left: x, right: x + w, top: y, bottom: y + h });
  for (let i = 0; i < BLOCK_TAGS.length; i++) {
    const [tag] = BLOCK_TAGS[i];
    const el = document.createElement(tag);
    el.textContent = `block ${i}`;
    reset.appendChild(el);
    addRect(el, 60, 100 + i * 100, 800, 80);
  }
  const ir = document.querySelector('.vditor-wysiwyg');
  addRect(ir, 40, 60, 900, 2000);
  addRect(reset, 60, 100, 860, 1900);

  // jsdom has no layout engine: stub the geometry APIs the script reads.
  Object.defineProperty(window.HTMLElement.prototype, 'offsetHeight', {
    configurable: true,
    get() { const r = rectMap.get(this); return r ? r.height : 30; },
  });
  window.HTMLElement.prototype.getBoundingClientRect = function () {
    return rectMap.get(this) || { x: 0, y: 0, width: 0, height: 0, left: 0, right: 0, top: 0, bottom: 0 };
  };

  // --- run the injected script (minus the <script> wrapper) ---
  const scriptBody = html.replace(/^[\s\S]*?<script[^>]*>/, '').replace(/<\/script>$/, '');
  window.eval(scriptBody);

  // --- host posts the original source, as message-dispatcher does on 'ready' ---
  window.dispatchEvent(
    new window.MessageEvent('message', { data: { command: '__setOrigContent', content: MD } })
  );

  // --- let the 500ms polling interval run at least once ---
  await sleep(700);

  const gutter = document.getElementById('ln-gutter');
  const lns = gutter ? Array.from(gutter.querySelectorAll('.ln')) : [];
  const numbers = lns.map((n) => n.textContent.trim());
  const toggleBtn = document.getElementById('ln-toggle');

  const checks = [...preChecks];
  checks.push({ name: 'toggle button (#ln-toggle) injected into toolbar', pass: !!toggleBtn && !!document.querySelector('.vditor-toolbar #ln-toggle') });
  checks.push({ name: 'gutter (#ln-gutter) created on body', pass: !!gutter && gutter.ownerDocument.body.contains(gutter) });
  checks.push({
    name: `one .ln per block (got ${lns.length}, want ${BLOCK_TAGS.length})`,
    pass: lns.length === BLOCK_TAGS.length,
  });
  checks.push({
    name: `numbers map to source lines (got [${numbers}], want [${EXPECTED_STARTS}])`,
    pass: numbers.length === EXPECTED_STARTS.length && numbers.every((n, i) => Number(n) === EXPECTED_STARTS[i]),
  });

  // --- toggle behavior: hide, then restore ---
  if (toggleBtn) {
    toggleBtn.click();
    const hiddenAfterFirstClick = window.__lnEnabled === false && gutter && gutter.style.display === 'none';
    // interval keeps running while disabled; re-enable and wait a cycle
    toggleBtn.click();
    await sleep(650);
    const restored = window.__lnEnabled === true && gutter && gutter.style.display !== 'none' && gutter.querySelectorAll('.ln').length === BLOCK_TAGS.length;
    checks.push({ name: 'toggle hides gutter on first click', pass: !!hiddenAfterFirstClick });
    checks.push({ name: 'toggle restores gutter on second click', pass: !!restored });
  } else {
    checks.push({ name: 'toggle hides gutter on first click', pass: false });
    checks.push({ name: 'toggle restores gutter on second click', pass: false });
  }

  let failures = 0;
  console.log('[line-numbers] checks:');
  for (const c of checks) {
    const tag = c.pass ? '✓' : '✗';
    console.log(`  ${tag} ${c.name}`);
    if (!c.pass) failures++;
  }
  if (failures > 0) {
    console.log(`\n[line-numbers] FAIL — ${failures}/${checks.length} check(s) failed`);
    process.exit(1);
  }
  console.log(`\n[line-numbers] PASS — all ${checks.length} checks succeeded`);
  process.exit(0);
}

main().catch((e) => {
  console.error('[line-numbers] crashed:', e);
  process.exit(2);
});
