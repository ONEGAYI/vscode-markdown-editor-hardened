# Markdown Editor (Hardened)

A security-hardened fork of [`zaaack/vscode-markdown-editor`](https://github.com/zaaack/vscode-markdown-editor) — a WYSIWYG markdown editor for VS Code powered by [vditor](https://github.com/Vanessa219/vditor).

[![CI](https://github.com/ocean1/vscode-markdown-editor-hardened/actions/workflows/ci.yml/badge.svg)](https://github.com/ocean1/vscode-markdown-editor-hardened/actions/workflows/ci.yml)

## What's different from upstream

Seven security findings from a code audit of upstream `0.1.13` / `0.1.14`, all closed. Plus a vditor bump, local Lute bundle, and four merged upstream feature PRs. All substantive upstream fixes and features through upstream `0.1.21` are also synced (scroll persistence, find bar, table wrapping, external-change sync, link/anchor fixes — see [CHANGELOG](CHANGELOG.md)):

| Area | Upstream 0.1.13 | This fork |
|------|-----------------|-----------|
| RCE via crafted markdown `command:` URI (H2) | `enableCommandUris: true`; vditor's Lute does NOT strip `command:` from rendered links → click = RCE | `enableCommandUris` removed; default-false makes `command:` clicks inert |
| `customCss` XSS (H3) | Raw value interpolated into `<style>` block; `</style><script>...` breakout from hostile `.vscode/settings.json` | Setting removed. Replaced with `customStylesheet` — a workspace-relative `.css` path (rejects URLs/absolute/traversal/wrong-extension), emitted as `<link>`, not `<style>` |
| Webview filesystem access (H1) | `localResourceRoots: [Uri.file("/"), Uri.file("A:/")..Uri.file("Z:/")]` | Scoped to `[extensionUri, workspace folders, current file dir]` |
| Upload write-anywhere (H4) | `path.join(assetsFolder, f.name)` — accepts `..`, absolute paths, NUL bytes | Host-side `validateUploadFilename` (rejects path separators, dot-prefix, drives, NUL, >255 bytes) |
| Open-link OS-handler pivot (H5) | `vscode.open(any URL)` — `file:///Applications/X.app` launches the app | Scheme allowlist: http/https/mailto. `file:` only inside workspace |
| No Content-Security-Policy (H6) | None | Strict CSP: `default-src 'none'`; per-render nonce-gated scripts; same-origin only |
| jsdelivr CDN dependency (H9) | Fetches Lute + per-feature renderers on every editor open | Local bundle. CSP forbids jsdelivr. Zero outbound network at editor-open time |
| vditor version | 3.8.4 (March 2021) | 3.11.2 (Sep 2025) — includes a `javascript:` URI strip absent in 3.8.4 |
| `@testing-library` in webview bundle | ~300KB shipped at runtime | Removed; native `KeyboardEvent` dispatch helper (`media-src/src/keyboard.ts`) |
| CI status | Broken since 0.1.14 tag (Feb 2026) | Tested + linted on every push and PR; deploy gated on test suite |

Each fix has a regression PoC in [`tests/pocs/`](tests/pocs/). The full suite (7 security PoCs + 1 integration smoke) runs in `pnpm test`.

See [`SECURITY.md`](SECURITY.md) for per-issue details, severity ratings, and exploit walk-throughs.

For the version-by-version history, see [`CHANGELOG.md`](CHANGELOG.md).

## Install

This fork is not yet on the VS Code Marketplace. To install locally:

```bash
git clone https://github.com/ocean1/vscode-markdown-editor-hardened.git
cd vscode-markdown-editor-hardened

# Install all deps
pnpm install
cd media-src && pnpm install && cd ..
cd tests && pnpm install && cd ..

# Build the webview bundle + copy vditor assets
cd media-src && pnpm build && cd ..

# Compile the extension host
pnpm exec tsc -p ./

# Package + install
pnpm exec vsce package
code --install-extension markdown-editor-hardened-*.vsix
```

If you don't have `vsce` globally, `pnpm exec` finds it via the bundled tooling once you've run `pnpm install`.

## Migration from upstream

If you were using `zaaack.markdown-editor`:

- **Different extension ID**: `ocean1.markdown-editor-hardened` vs upstream's `zaaack.markdown-editor`. Both can be installed side-by-side; uninstall upstream once you've confirmed the fork works for you.
- **Settings reset**: keys changed from `markdown-editor.*` to `markdown-editor-hardened.*`. The settings you have are:
  - `markdown-editor-hardened.imageSaveFolder` (same semantics as upstream)
  - `markdown-editor-hardened.useVscodeThemeColor` (same)
  - `markdown-editor-hardened.customStylesheet` — **NEW**: workspace-relative path to a `.css` file. Replaces upstream's `customCss` (which was an XSS vector).
  - `markdown-editor-hardened.showLineNumbers` — **NEW**: line numbers in the gutter (default true; from upstream PR #157).
- **Keybinding preserved**: `cmd+shift+alt+m` (Mac) / `ctrl+shift+alt+m` (others).
- **Command name changed**: `markdown-editor.openEditor` → `markdown-editor-hardened.openEditor`. The keybinding works the same; the command-palette name is now "Markdown Editor (Hardened): Open with markdown editor (hardened)".

## Upstream contribution

Each independent fix is being sent back to upstream as a separate PR. The fork is **not intended to permanently replace upstream** — only to ship the fixes immediately while upstream considers them. See the upstream-PR-status table in [`SECURITY.md`](SECURITY.md#upstream-pr-status).

## Acknowledgements

- [zaaack](https://github.com/zaaack) — original author of `vscode-markdown-editor`
- [Vanessa219](https://github.com/Vanessa219) — author of [vditor](https://github.com/Vanessa219/vditor)
- Upstream PR authors we credit + merge from:
  - [mrsekut](https://github.com/mrsekut) — #151 (CI workflow fix)
  - [LeonardoRick](https://github.com/LeonardoRick) — #153 (find widget), #154 (auto-focus)
  - [asalcedo29](https://github.com/asalcedo29) — #157 (source-accurate line numbers, adapted for CSP in C1.18)
  - [hackarada](https://github.com/hackarada) — #142 (vditor 3.11.1 bump; we shipped 3.11.2 based on the same API-change findings)

## License

MIT — same as upstream.
