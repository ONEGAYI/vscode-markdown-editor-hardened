#!/usr/bin/env node
/**
 * Integration test — external-edit sync through the REAL extension host code
 * (bug 1 feedback loop: "edits by an external writer (e.g. an agent) don't
 * re-render in the already-open editor view").
 *
 * Boots out/extension.js (the compiled extension) against a mocked `vscode`
 * API whose observable behaviours were MEASURED against a real VS Code
 * 1.137.0 instance (tests/vscode-probe/probe-external-edit.js):
 *
 *   - external write to disk while the doc is CLEAN:
 *       onDidChangeTextDocument fires ONCE with { contentChanges: [>0], isDirty: false }
 *       and the document model reloads to the new text.
 *   - external write while the doc is DIRTY:
 *       NO event at all (VS Code refuses to clobber unsaved edits).
 *   - workspace.applyEdit() (any extension, incl. our own webview sync):
 *       fires { contentChanges: [>0], isDirty: false } BEFORE the dirty flag
 *       flips, then { contentChanges: [], isDirty: true } — i.e. the first
 *       event of an applyEdit is INDISTINGUISHABLE from an external reload.
 *
 * Scenarios asserted (each maps to a real user situation):
 *
 *   R1  agent writes the file on disk, doc clean            → webview must get `update`
 *   R2  agent writes the file on disk, doc DIRTY            → some refresh path must exist
 *   R3  another extension applyEdits the doc (VS Code agent)→ webview must get `update`
 *   R4  the webview's OWN edit echo (edit → applyEdit →
 *       change event with the same content)                 → must NOT be pushed back (echo)
 *
 * The mock's postMessage log is the assertion surface: what the extension
 * host actually tells the webview.
 */

const path = require('path');
const Module = require('module');

const EXTENSION_JS = path.join(__dirname, '..', '..', 'out', 'extension.js');

// ---------------------------------------------------------------------------
// vscode API mock — shaped by the probe measurements above.
// ---------------------------------------------------------------------------

function createVscodeMock() {
  const listeners = { changeTextDoc: [], closeTextDoc: [], colorTheme: [] };
  const docs = new Map(); // lower-cased fsPath -> doc
  const watchers = []; // { onDidChangeCbs, ... }
  const state = { provider: undefined, panels: [], watcherGlobPatterns: [], infoMessages: [], nextInfoChoice: undefined };

  const fire = (arr, e) => { for (const cb of [...arr]) cb(e); };

  const UriFile = (p) => ({
    scheme: 'file',
    fsPath: p,
    path: '/' + String(p).replace(/\\/g, '/').replace(/^[A-Za-z]:/, ''),
    toString: () => 'file:///' + String(p).replace(/\\/g, '/'),
  });

  class Range {
    constructor(sl, sc, el, ec) { this.sl = sl; this.sc = sc; this.el = el; this.ec = ec; }
  }
  class WorkspaceEdit {
    constructor() { this.edits = []; }
    replace(uri, range, newText) { this.edits.push({ uri, range, newText }); }
  }
  class RelativePattern {
    constructor(base, pattern) { this.base = base; this.pattern = pattern; }
  }

  function makeDoc(fsPath, text) {
    const doc = {
      uri: UriFile(fsPath),
      fileName: fsPath,
      _text: text,
      _dirty: false,
      version: 1,
      get isDirty() { return this._dirty; },
      get lineCount() { return this._text.split('\n').length; },
      getText() { return this._text; },
      save() { this._dirty = false; },
    };
    docs.set(fsPath.toLowerCase(), doc);
    return doc;
  }

  function makePanel() {
    const panel = {
      active: true,
      title: '',
      disposed: false,
      reveal() {},
      dispose() { this.disposed = true; },
      onDidDispose(cb) { panel._onDispose = cb; return { dispose() {} }; },
      webview: {
        html: '',
        options: undefined,
        cspSource: 'https://mock.vscode-cdn.test',
        asWebviewUri: (u) => ({ toString: () => 'https://mock.vscode-cdn.test' + String(u.fsPath).replace(/\\/g, '/') }),
        _posted: [],
        _receive: undefined,
        postMessage(m) { this._posted.push(m); return Promise.resolve(true); },
        onDidReceiveMessage(cb) { this._receive = cb; return { dispose() {} }; },
      },
    };
    state.panels.push(panel);
    return panel;
  }

  const vscodeMock = {
    window: {
      registerCustomEditorProvider(vt, provider) { state.provider = provider; return { dispose() {} }; },
      createWebviewPanel() { return makePanel(); },
      onDidChangeActiveColorTheme(cb) { listeners.colorTheme.push(cb); return { dispose() {} }; },
      activeColorTheme: { kind: 2 },
      activeTextEditor: undefined,
      showErrorMessage() {},
      showInformationMessage(msg, ...items) {
        state.infoMessages.push({ msg, items });
        return Promise.resolve(state.nextInfoChoice);
      },
    },
    commands: {
      registerCommand() { return { dispose() {} }; },
      async executeCommand() {},
    },
    workspace: {
      onDidChangeTextDocument(cb) { listeners.changeTextDoc.push(cb); return { dispose() {} }; },
      onDidCloseTextDocument(cb) { listeners.closeTextDoc.push(cb); return { dispose() {} }; },
      get textDocuments() { return [...docs.values()]; },
      async openTextDocument(uriOrPath) {
        const fsPath = typeof uriOrPath === 'string' ? uriOrPath : uriOrPath.fsPath;
        return docs.get(fsPath.toLowerCase()) || makeDoc(fsPath, '');
      },
      /**
       * Host emulation of workspace.applyEdit, following the measured event
       * order: content-change event while the dirty flag is STILL unchanged,
       * then (if this edit made the doc dirty) a pure dirty-flip event with
       * empty contentChanges.
       */
      async applyEdit(edit) {
        for (const { uri, newText } of edit.edits) {
          const doc = docs.get(uri.fsPath.toLowerCase());
          if (!doc) continue;
          doc._text = newText;
          const wasDirty = doc._dirty;
          fire(listeners.changeTextDoc, {
            document: doc,
            contentChanges: [{ text: newText }],
          });
          if (!wasDirty) {
            doc._dirty = true;
            fire(listeners.changeTextDoc, { document: doc, contentChanges: [] });
          }
        }
        return true;
      },
      getConfiguration() { return { get: () => undefined }; },
      getWorkspaceFolder() { return undefined; },
      fs: {
        async readFile(uri) {
          const doc = docs.get(uri.fsPath.toLowerCase());
          if (!doc || doc._disk === undefined) return Buffer.from(doc ? doc._text : '', 'utf8');
          return Buffer.from(doc._disk, 'utf8');
        },
        async writeFile() {},
        async createDirectory() {},
        async stat() { return { type: 1, mtime: 0, ctime: 0, size: 0 }; },
      },
      createFileSystemWatcher(globOrPattern) {
        const glob = typeof globOrPattern === 'string' ? globOrPattern : globOrPattern.pattern;
        state.watcherGlobPatterns.push(glob);
        const w = {
          glob,
          onDidChangeCbs: [],
          onDidChange(cb) { this.onDidChangeCbs.push(cb); return { dispose() {} }; },
          onDidCreate() { return { dispose() {} }; },
          onDidDelete() { return { dispose() {} }; },
          dispose() {},
          /** test-side: the OS just wrote the file behind this watcher's back */
          fireDiskWrite() { fire(this.onDidChangeCbs, UriFile(this.glob)); },
        };
        watchers.push(w);
        return w;
      },
    },
    Uri: {
      file: UriFile,
      joinPath: (base, ...segs) => UriFile(base.fsPath.replace(/\\/g, '/') + '/' + segs.join('/')),
      parse: UriFile,
    },
    Range,
    WorkspaceEdit,
    RelativePattern,
    ColorThemeKind: { Light: 1, Dark: 2, HighContrast: 3, HighContrastLight: 4 },
    FileType: { Unknown: 0, File: 1, Directory: 2, SymbolicLink: 64 },
  };

  return {
    vscodeMock,
    helpers: {
      state, listeners, docs, watchers, makeDoc, makePanel,
      /** disk write while doc CLEAN — the measured S1 shape */
      externalWriteClean(doc, newText) {
        doc._text = newText;
        doc._dirty = false;
        doc._disk = newText;
        fire(listeners.changeTextDoc, {
          document: doc,
          contentChanges: [{ text: newText }],
        });
      },
      /** disk write while doc DIRTY — the measured S2 shape: NO event at all */
      externalWriteDirtySilent(doc, newText) {
        doc._disk = newText; // disk now differs; VS Code fires nothing
      },
      postFromWebview(panel, message) {
        return panel.webview._receive(message);
      },
      updatesPosted(panel) {
        return panel.webview._posted.filter((m) => m.command === 'update');
      },
    },
  };
}

// ---------------------------------------------------------------------------
// harness: load the real compiled extension against the mock
// ---------------------------------------------------------------------------

function loadExtension(vscodeMock) {
  const orig = Module._resolveFilename;
  Module._resolveFilename = function (request, ...rest) {
    if (request === 'vscode') return 'vscode-mock';
    return orig.call(this, request, ...rest);
  };
  require.cache['vscode-mock'] = { id: 'vscode-mock', filename: 'vscode-mock', loaded: true, exports: vscodeMock };
  try {
    const ext = require(EXTENSION_JS);
    const context = {
      extensionUri: vscodeMock.Uri.file('D:/mock/ext'),
      globalState: {
        _s: {},
        get(k) { return this._s[k]; },
        update(k, v) { this._s[k] = v; return Promise.resolve(); },
        setKeysForSync() {},
      },
      subscriptions: [],
    };
    ext.activate(context);
    return ext;
  } finally {
    Module._resolveFilename = orig;
    delete require.cache['vscode-mock'];
    delete require.cache[EXTENSION_JS];
    delete require.cache[path.join(path.dirname(EXTENSION_JS), 'webview', 'message-dispatcher.js')];
    delete require.cache[path.join(path.dirname(EXTENSION_JS), 'security', 'path-validation.js')];
    delete require.cache[path.join(path.dirname(EXTENSION_JS), 'scroll-positions.js')];
    delete require.cache[path.join(path.dirname(EXTENSION_JS), 'upload-validation.js')];
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** boot one custom-editor session and drive it through `ready` */
async function bootSession(h, fsPath, initialText) {
  const doc = h.makeDoc(fsPath, initialText);
  const panel = h.makePanel();
  await h.state.provider.resolveCustomTextEditor(doc, panel, {});
  // webview signals readiness — host answers with the init update
  await h.postFromWebview(panel, { command: 'ready' });
  panel.webview._posted.length = 0; // drop the init message
  return { doc, panel };
}

// ---------------------------------------------------------------------------

async function main() {
  const { vscodeMock, helpers: h } = createVscodeMock();
  loadExtension(vscodeMock);
  if (!h.state.provider) throw new Error('custom editor provider was not registered');

  const results = [];
  const check = (name, pass, detail) => {
    results.push({ name, pass, detail });
    console.log(`  ${pass ? '✓' : '✗'} ${name}${detail ? ' — ' + detail : ''}`);
  };

  // --- R1: external disk write, doc clean (agent edits file, user only watches)
  {
    console.log('\n[external-sync] R1 — agent disk write, doc CLEAN');
    const { doc, panel } = await bootSession(h, 'D:/ws/agent-doc.md', '# v1\n');
    h.externalWriteClean(doc, '# v2 (agent edit)\n');
    const updates = h.updatesPosted(panel);
    check(
      'webview receives update with the new content',
      updates.some((u) => u.content === '# v2 (agent edit)\n'),
      updates.length ? `update posted (${updates[0].content.slice(0, 30).trim()}…)` : 'no update posted'
    );
  }

  // --- R3: another extension applyEdits the visible doc (in-VS-Code agent)
  {
    console.log('\n[external-sync] R3 — in-VS-Code agent applies a WorkspaceEdit');
    const { doc, panel } = await bootSession(h, 'D:/ws/applyedit-doc.md', '# v1\n');
    const edit = new vscodeMock.WorkspaceEdit();
    edit.replace(doc.uri, new vscodeMock.Range(0, 0, doc.lineCount, 0), '# v2 (applyEdit agent)\n');
    await vscodeMock.workspace.applyEdit(edit);
    const updates = h.updatesPosted(panel);
    check(
      'webview receives update with the new content',
      updates.some((u) => u.content === '# v2 (applyEdit agent)\n'),
      updates.length ? 'update posted' : 'no update posted'
    );
  }

  // --- R4: the webview's own edit echo must not be pushed back
  {
    console.log('\n[external-sync] R4 — webview own edit echo is NOT re-pushed');
    const { doc, panel } = await bootSession(h, 'D:/ws/echo-doc.md', '# v1\n');
    panel.webview._posted.length = 0;
    // user types in the webview → 'edit' message → host applyEdits (measured shape)
    await h.postFromWebview(panel, { command: 'edit', content: '# v1 (user typed)\n' });
    const updates = h.updatesPosted(panel);
    const echo = updates.some((u) => u.content === '# v1 (user typed)\n');
    check(
      'no update echo for the webview’s own applyEdit',
      !echo,
      echo
        ? 'REGRESSION: host pushed the edit back (would reset cursor on every keystroke)'
        : 'echo suppressed'
    );
    check(
      'document actually received the webview edit',
      doc.getText() === '# v1 (user typed)\n',
      `doc = ${JSON.stringify(doc.getText().slice(0, 30))}`
    );
  }

  // --- R2: agent disk write while doc DIRTY (the reported dead case)
  {
    console.log('\n[external-sync] R2 — agent disk write, doc DIRTY (no host event fires)');
    const { doc, panel } = await bootSession(h, 'D:/ws/dirty-doc.md', '# v1\n');
    // user has an unsaved webview edit → doc is dirty
    await h.postFromWebview(panel, { command: 'edit', content: '# v1 (user typed)\n' });
    panel.webview._posted.length = 0;

    // agent writes the file behind VS Code's back: measured S2 = silence
    h.externalWriteDirtySilent(doc, '# v2 (agent edit while dirty)\n');

    const watcher = h.watchers.find((w) => /dirty-doc\.md$/i.test(String(w.glob)));
    check(
      'a FileSystemWatcher is installed for the open file',
      !!watcher,
      watcher ? `watcher glob = ${watcher.glob}` : 'no watcher installed'
    );
    if (!watcher) {
      check('agent edit while dirty eventually reaches the webview', false, 'no watcher — silently lost');
    } else {
      // the OS watcher fires; the user chooses to load the disk version
      h.state.nextInfoChoice = 'Load disk version';
      watcher.fireDiskWrite();
      await sleep(1200); // 500ms debounce + async chain

      const asked = h.state.infoMessages.some((m) => /dirty-doc\.md/i.test(m.msg));
      check('user is asked how to resolve the conflict', asked);

      const updates = h.updatesPosted(panel);
      check(
        'choosing "Load disk version" pushes the agent content to the webview',
        updates.some((u) => u.content === '# v2 (agent edit while dirty)\n'),
        updates.length ? 'update posted' : 'no update posted'
      );
      check(
        'document buffer ends clean (saved) after adopting the disk version',
        !doc.isDirty && doc.getText() === '# v2 (agent edit while dirty)\n'
      );
    }
  }

  // --- R2b: "Keep my edits" must NOT clobber the user's unsaved buffer
  {
    console.log('\n[external-sync] R2b — user keeps their edits');
    const { doc, panel } = await bootSession(h, 'D:/ws/keep-doc.md', '# v1\n');
    await h.postFromWebview(panel, { command: 'edit', content: '# v1 (user typed)\n' });
    panel.webview._posted.length = 0;
    h.externalWriteDirtySilent(doc, '# v2 (agent)\n');
    const watcher = h.watchers.find((w) => /keep-doc\.md$/i.test(String(w.glob)));
    h.state.nextInfoChoice = 'Keep my edits';
    if (watcher) watcher.fireDiskWrite();
    await sleep(1200);
    check(
      'buffer keeps the user content and nothing is pushed',
      doc.getText() === '# v1 (user typed)\n' && doc.isDirty && h.updatesPosted(panel).length === 0
    );
  }

  // summary
  const failed = results.filter((r) => !r.pass).length;
  console.log(`\n[external-sync] ${failed === 0 ? 'PASS' : 'FAIL'} — ${results.length - failed}/${results.length} checks passed`);
  if (failed > 0) process.exit(1);
}

main().catch((e) => {
  console.error('[external-sync] harness crash:', e);
  process.exit(2);
});
