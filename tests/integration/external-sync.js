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
  const state = { provider: undefined, panels: [], watcherGlobPatterns: [], infoMessages: [], errorMessages: [], nextInfoChoice: undefined, commands: {}, holdInfo: false, heldInfoResolvers: [] };

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
      /** Mirrors the real save(): returns success AND persists to the mock disk. */
      save() { this._dirty = false; this._disk = this._text; return true; },
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
      showErrorMessage(msg) { state.errorMessages.push(msg); },
      showInformationMessage(msg, ...items) {
        state.infoMessages.push({ msg, items });
        if (state.holdInfo) {
          // hold the decision so tests can exercise the pending-notification
          // window (further writes, disk changing before the click lands)
          return new Promise((resolve) => {
            state.heldInfoResolvers.push((choice) => resolve(choice));
          });
        }
        return Promise.resolve(state.nextInfoChoice);
      },
    },
    commands: {
      registerCommand(id, cb) { state.commands[id] = cb; return { dispose() {} }; },
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
          onDidCreateCbs: [],
          onDidChange(cb) { this.onDidChangeCbs.push(cb); return { dispose() {} }; },
          onDidCreate(cb) { this.onDidCreateCbs.push(cb); return { dispose() {} }; },
          onDidDelete() { return { dispose() {} }; },
          dispose() {},
          /** test-side: the OS just wrote the file behind this watcher's back */
          fireDiskWrite() { fire(this.onDidChangeCbs, UriFile(this.glob)); },
          /** test-side: atomic temp+rename write surfaced as a create event */
          fireDiskCreate() { fire(this.onDidCreateCbs, UriFile(this.glob)); },
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
    ViewColumn: { Active: -1, Beside: -2, One: 1, Two: 2, Three: 3 },
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
      check(
        'adopting the disk version reports no error (applyEdit+save both succeeded)',
        h.state.errorMessages.length === 0,
        h.state.errorMessages.length ? `errors: ${JSON.stringify(h.state.errorMessages)}` : undefined
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
    if (!watcher) {
      check('keep-doc watcher installed', false, 'no watcher for keep-doc.md');
    } else {
      watcher.fireDiskWrite();
      await sleep(1200);
      check(
        'buffer keeps the user content and nothing is pushed',
        doc.getText() === '# v1 (user typed)\n' && doc.isDirty && h.updatesPosted(panel).length === 0
      );
    }
  }

  // --- RS: explicit save from the webview ('save' message) — content lands,
  //     document becomes clean, and no update echo is pushed back
  {
    console.log('\n[external-sync] RS — webview save message');
    const { doc, panel } = await bootSession(h, 'D:/ws/save-doc.md', '# v1\n');
    panel.webview._posted.length = 0;
    await h.postFromWebview(panel, { command: 'save', content: '# v1 (saved from webview)\n' });
    await sleep(100);
    const updates = h.updatesPosted(panel);
    check(
      'document saved with the webview content and stays clean, no echo push',
      doc.getText() === '# v1 (saved from webview)\n' && !doc.isDirty && updates.length === 0,
      `doc=${JSON.stringify(doc.getText().slice(0, 30))} clean=${!doc.isDirty} pushes=${updates.length}`
    );
  }

  // --- EP1/EP4: the COMMAND-MODE EditorPanel path (openEditor command) — the
  //     acceptance requires BOTH open paths to sync; these mirror R1/R4.
  {
    console.log('\n[external-sync] EP — command-mode EditorPanel path');
    const doc = h.makeDoc('D:/ws/panel-doc.md', '# v1\n');
    await h.state.commands['markdown-editor-hardened.openEditor'](
      vscodeMock.Uri.file('D:/ws/panel-doc.md')
    );
    const panel = h.state.panels.at(-1);
    check('EditorPanel created a webview panel', !!panel);
    if (panel) {
      await h.postFromWebview(panel, { command: 'ready' });
      panel.webview._posted.length = 0;

      // EP4: webview's own edit must not echo back (300ms debounce window)
      await h.postFromWebview(panel, { command: 'edit', content: '# v1 (user typed)\n' });
      await sleep(450);
      check(
        'EP4: no update echo on the EditorPanel path',
        h.updatesPosted(panel).length === 0,
        `pushes=${h.updatesPosted(panel).length}`
      );

      // EP1: clean-doc external write must push (300ms debounce)
      h.externalWriteClean(doc, '# v2 (agent edit)\n');
      await sleep(450);
      const updates = h.updatesPosted(panel);
      check(
        'EP1: external edit reaches the webview on the EditorPanel path',
        updates.some((u) => u.content === '# v2 (agent edit)\n'),
        updates.length ? 'update posted' : 'no update posted'
      );
    }
  }

  // --- RW1: BOM-only rewrite of identical content must NOT look like a
  //     divergence (readDisk strips the BOM the TextModel also strips)
  {
    console.log('\n[external-sync] RW1 — BOM rewrite is not a divergence');
    const { doc, panel } = await bootSession(h, 'D:/ws/bom-doc.md', '# v1\n');
    await h.postFromWebview(panel, { command: 'edit', content: '# v1 (user typed)\n' });
    panel.webview._posted.length = 0;
    h.state.infoMessages.length = 0;
    // disk holds the SAME bytes as the buffer, but written with a UTF-8 BOM
    // (PowerShell-style rewrite); the TextModel strips the BOM, readDisk must too
    h.externalWriteDirtySilent(doc, '\uFEFF# v1 (user typed)\n');
    const watcher = h.watchers.find((w) => /bom-doc\.md$/i.test(String(w.glob)));
    if (!watcher) {
      check('bom-doc watcher installed', false);
    } else {
      watcher.fireDiskWrite();
      await sleep(1200);
      check('identical rewrite asks nothing', h.state.infoMessages.length === 0);
    }
  }

  // --- RW2: while a notification is pending, further writes must not stack
  //     a second notification; after the decision, the newest disk content
  //     is re-examined (asked about as a new round)
  {
    console.log('\n[external-sync] RW2 — pending decision suppresses stacked notifications');
    const { doc, panel } = await bootSession(h, 'D:/ws/pending-doc.md', '# v1\n');
    await h.postFromWebview(panel, { command: 'edit', content: '# v1 (user typed)\n' });
    panel.webview._posted.length = 0;
    h.state.infoMessages.length = 0;
    h.state.holdInfo = true;

    h.externalWriteDirtySilent(doc, '# v2\n');
    const watcher = h.watchers.find((w) => /pending-doc\.md$/i.test(String(w.glob)));
    if (!watcher) {
      check('pending-doc watcher installed', false);
    } else {
      watcher.fireDiskWrite();
      await sleep(1200); // first notification now pending
      check('first conflict notification shown', h.state.infoMessages.length === 1);

      // agent writes again while the user has not decided
      h.externalWriteDirtySilent(doc, '# v3\n');
      watcher.fireDiskWrite();
      await sleep(1600);
      check('no second notification stacks on the pending one', h.state.infoMessages.length === 1,
        `messages=${h.state.infoMessages.length}`);

      // user finally keeps their edits → the v3 round is re-asked
      h.state.heldInfoResolvers[0]('Keep my edits');
      await sleep(2200); // 1s re-examine poll + debounce margin
      check('after the decision, the newer disk content is asked about',
        h.state.infoMessages.length === 2,
        `messages=${h.state.infoMessages.length}`);
      h.state.heldInfoResolvers[1] && h.state.heldInfoResolvers[1]('Keep my edits');
    }
    h.state.holdInfo = false;
    h.state.heldInfoResolvers = [];
  }

  // --- RW3: approving "Load disk version" must not apply a snapshot that no
  //     longer matches the disk at click time
  {
    console.log('\n[external-sync] RW3 — stale snapshot is not applied');
    const { doc, panel } = await bootSession(h, 'D:/ws/stale-doc.md', '# v1\n');
    await h.postFromWebview(panel, { command: 'edit', content: '# v1 (user typed)\n' });
    panel.webview._posted.length = 0;
    h.state.infoMessages.length = 0;
    h.state.holdInfo = true;

    h.externalWriteDirtySilent(doc, '# v2 approved\n');
    const watcher = h.watchers.find((w) => /stale-doc\.md$/i.test(String(w.glob)));
    if (!watcher) {
      check('stale-doc watcher installed', false);
    } else {
      watcher.fireDiskWrite();
      await sleep(1200); // notification for v2 pending
      // the agent overwrites again BEFORE the user clicks Load
      h.externalWriteDirtySilent(doc, '# v3 newer\n');
      h.state.heldInfoResolvers[0]('Load disk version');
      await sleep(800);
      check(
        'stale v2 is NOT applied to the document',
        doc.getText() === '# v1 (user typed)\n',
        `doc=${JSON.stringify(doc.getText().slice(0, 30))}`
      );
      check('stale v2 is NOT pushed to the webview', h.updatesPosted(panel).length === 0);

      // after the stale load is dropped, the next watcher event re-asks
      // about the newer disk content as a fresh round
      h.state.heldInfoResolvers = [];
      watcher.fireDiskWrite();
      await sleep(1500);
      check('the newer disk content is asked about after the dropped load',
        h.state.infoMessages.length === 2,
        `messages=${h.state.infoMessages.length}`);
      h.state.heldInfoResolvers[0] && h.state.heldInfoResolvers[0]('Keep my edits');
    }
    h.state.holdInfo = false;
    h.state.heldInfoResolvers = [];
  }

  // --- RW5: atomic temp+rename writes surface as create events — the
  //     onDidCreate subscription must drive the same check pipeline
  {
    console.log('\n[external-sync] RW5 — atomic write (create event) path');
    const { doc, panel } = await bootSession(h, 'D:/ws/atomic-doc.md', '# v1\n');
    await h.postFromWebview(panel, { command: 'edit', content: '# v1 (user typed)\n' });
    panel.webview._posted.length = 0;
    h.state.infoMessages.length = 0;
    h.state.nextInfoChoice = 'Load disk version';
    h.externalWriteDirtySilent(doc, '# v2 (atomic rename write)\n');
    const watcher = h.watchers.find((w) => /atomic-doc\.md$/i.test(String(w.glob)));
    if (!watcher) {
      check('atomic-doc watcher installed', false);
    } else {
      check('onDidCreate is subscribed', watcher.onDidCreateCbs.length === 1);
      watcher.fireDiskCreate();
      await sleep(1200);
      const updates = h.updatesPosted(panel);
      check(
        'create-event write reaches the webview after Load',
        updates.some((u) => u.content === '# v2 (atomic rename write)\n'),
        updates.length ? 'update posted' : 'no update posted'
      );
    }
  }

  // --- RW4: undecodable bytes (non-UTF-8 rewrite) never reach applyEdit
  {
    console.log('\n[external-sync] RW4 — non-UTF-8 disk content is ignored');
    const { doc, panel } = await bootSession(h, 'D:/ws/gbk-doc.md', '# v1\n');
    await h.postFromWebview(panel, { command: 'edit', content: '# v1 (user typed)\n' });
    panel.webview._posted.length = 0;
    h.state.infoMessages.length = 0;
    h.state.nextInfoChoice = 'Load disk version';
    h.externalWriteDirtySilent(doc, '# v1 \uFFFD\uFFFD gbk bytes\n');
    const watcher = h.watchers.find((w) => /gbk-doc\.md$/i.test(String(w.glob)));
    if (!watcher) {
      check('gbk-doc watcher installed', false);
    } else {
      watcher.fireDiskWrite();
      await sleep(1200);
      check('no notification for undecodable content', h.state.infoMessages.length === 0);
      check('document untouched by undecodable content',
        doc.getText() === '# v1 (user typed)\n');
    }
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
