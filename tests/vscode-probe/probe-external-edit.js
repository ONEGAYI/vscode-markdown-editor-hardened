// VS Code extension-host probe — runs inside a real VS Code instance via:
//   code --extensionDevelopmentPath=<repo> --extensionTestsPath=<this file> <tmp workspace>
//
// Answers the HOST-behaviour question behind bug 1 ("external edits by an
// agent don't re-render the open editor view"):
//
//   S1  custom editor open, document CLEAN, external program writes the file
//       -> does onDidChangeTextDocument fire? with what shape
//          (contentChanges length, isDirty, new text visible)?
//   S2  same, but the document is DIRTY (unsaved applyEdit from another
//       extension — simulating an in-editor agent) when the external write
//       happens. Does any onDidChangeTextDocument reach us?
//   S3  another extension applies a WorkspaceEdit while the custom editor
//       is focused and visible (simulating an in-VS-Code agent that edits
//       via the API). Event shape?
//
// Writes findings to probe-results.json next to this file and mirrors to
// stdout. Exits non-zero only on harness failure (findings are data).

const vscode = require('vscode');
const fs = require('fs');
const path = require('path');
const os = require('os');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function log(...args) {
  console.log('[probe]', ...args);
}

async function run() {
  const outPath = path.join(__dirname, 'probe-results.json');
  const results = { vscodeVersion: vscode.version, scenarios: [] };

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vmd-probe-'));
  // Git Bash exports TMP in MSYS form ("/tmp"); resolve() pins the path to a
  // real Windows drive root so it compares equal against doc.uri.fsPath.
  const mdPath = path.resolve(path.join(tmpDir, 'probe.md'));

  const recordEvents = () => {
    const events = [];
    const sub = vscode.workspace.onDidChangeTextDocument((e) => {
      if (e.document.uri.fsPath.toLowerCase() !== mdPath.toLowerCase()) return;
      events.push({
        contentChanges: e.contentChanges.length,
        firstChangeLen: e.contentChanges[0]
          ? e.contentChanges[0].text.length
          : 0,
        isDirty: e.document.isDirty,
        reason: e.reason,
        textHead: e.document.getText().slice(0, 80),
      });
    });
    return { events, dispose: () => sub.dispose() };
  };

  // ---------- S1: clean document + external write ----------
  try {
    fs.writeFileSync(mdPath, '# hello\n\nworld\n');
    const uri = vscode.Uri.file(mdPath);
    await vscode.commands.executeCommand(
      'vscode.openWith',
      uri,
      'markdown-editor-hardened.customEditor'
    );
    await sleep(4000); // let the custom editor webview come up

    const diag = {
      mdPath,
      textDocumentsCount: vscode.workspace.textDocuments.length,
      allDocs: vscode.workspace.textDocuments.map((d) => d.fileName),
      tabKinds: vscode.window.tabGroups.all.map((t) =>
        t.input && t.input.viewType ? t.input.viewType : String(t.label)
      ),
    };
    log('S1 diag', JSON.stringify(diag, null, 2));

    const { events, dispose } = recordEvents();
    fs.writeFileSync(mdPath, '# hello\n\nEXTERNAL EDIT S1\n');
    await sleep(5000); // file watcher latency margin
    dispose();

    // what does the document model look like now?
    const doc = vscode.workspace.textDocuments.find(
      (d) => d.uri.fsPath.toLowerCase() === mdPath.toLowerCase()
    );
    results.scenarios.push({
      name: 'S1-clean-doc-external-write',
      diag,
      docFound: !!doc,
      docText: doc ? doc.getText().slice(0, 120) : null,
      docIsDirty: doc ? doc.isDirty : null,
      events,
    });
    log('S1 done', JSON.stringify(results.scenarios[0], null, 2));
  } catch (e) {
    results.scenarios.push({ name: 'S1-clean-doc-external-write', error: String(e) });
    log('S1 ERROR', e);
  }

  // ---------- S3: in-VS-Code agent edit (applyEdit) while editor visible ----------
  try {
    const doc = vscode.workspace.textDocuments.find(
      (d) => d.uri.fsPath.toLowerCase() === mdPath.toLowerCase()
    );
    if (!doc) {
      results.scenarios.push({ name: 'S3-agent-applyEdit-visible', skipped: 'doc not found' });
      log('S3 skipped — doc not found');
    } else {
      const { events, dispose } = recordEvents();
      const edit = new vscode.WorkspaceEdit();
      edit.replace(
        doc.uri,
        new vscode.Range(0, 0, doc.lineCount, 0),
        '# hello\n\nAGENT APPLYEDIT S3\n'
      );
      await vscode.workspace.applyEdit(edit);
      await sleep(1500);
      dispose();
      results.scenarios.push({
        name: 'S3-agent-applyEdit-visible',
        docIsDirtyAfter: doc.isDirty,
        events,
      });
      log('S3 done', JSON.stringify(results.scenarios.at(-1), null, 2));
    }
  } catch (e) {
    results.scenarios.push({ name: 'S3-agent-applyEdit-visible', error: String(e) });
    log('S3 ERROR', e);
  }

  // ---------- S2: DIRTY document + external write ----------
  try {
    // doc is dirty from S3 (applyEdit, unsaved)
    const doc = vscode.workspace.textDocuments.find(
      (d) => d.uri.fsPath.toLowerCase() === mdPath.toLowerCase()
    );
    if (!doc) {
      results.scenarios.push({ name: 'S2-dirty-doc-external-write', skipped: 'doc not found' });
      log('S2 skipped — doc not found');
    } else {
      const dirtyBefore = doc.isDirty;
      const { events, dispose } = recordEvents();
      fs.writeFileSync(mdPath, '# hello\n\nEXTERNAL EDIT S2 OVERWRITES\n');
      await sleep(5000);
      dispose();
      results.scenarios.push({
        name: 'S2-dirty-doc-external-write',
        dirtyBefore,
        docIsDirtyAfter: doc.isDirty,
        docTextAfter: doc.getText().slice(0, 120),
        events,
      });
      log('S2 done', JSON.stringify(results.scenarios.at(-1), null, 2));
    }
  } catch (e) {
    results.scenarios.push({ name: 'S2-dirty-doc-external-write', error: String(e) });
    log('S2 ERROR', e);
  }

  // ---------- S4: DIRTY document + external write — does the OS-level
  // FileSystemWatcher see it? (substrate for the extension's
  // attachExternalChangeWatcher; the host fires no text-doc event here)
  try {
    const doc = vscode.workspace.textDocuments.find(
      (d) => d.uri.fsPath.toLowerCase() === mdPath.toLowerCase()
    );
    if (!doc || !doc.isDirty) {
      results.scenarios.push({ name: 'S4-dirty-doc-watcher', skipped: 'doc missing or not dirty' });
      log('S4 skipped — doc not dirty');
    } else {
      const watcherEvents = [];
      const watcher = vscode.workspace.createFileSystemWatcher(
        new vscode.RelativePattern(path.dirname(mdPath), path.basename(mdPath))
      );
      const sub = watcher.onDidChange((u) => watcherEvents.push(u.fsPath));
      fs.writeFileSync(mdPath, '# hello\n\nEXTERNAL EDIT S4 WATCHER\n');
      await sleep(4000);
      sub.dispose();
      watcher.dispose();
      results.scenarios.push({
        name: 'S4-dirty-doc-watcher',
        watcherFired: watcherEvents.length > 0,
        watcherEvents,
      });
      log('S4 done', JSON.stringify(results.scenarios.at(-1), null, 2));
    }
  } catch (e) {
    results.scenarios.push({ name: 'S4-dirty-doc-watcher', error: String(e) });
    log('S4 ERROR', e);
  }

  fs.writeFileSync(outPath, JSON.stringify(results, null, 2));
  log('results written to', outPath);

  // close the editor we opened so the VS Code instance can exit cleanly
  try {
    await vscode.commands.executeCommand('workbench.action.closeAllEditors');
  } catch {}
}

module.exports = { run };
