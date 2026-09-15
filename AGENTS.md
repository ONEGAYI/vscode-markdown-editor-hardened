# AGENTS.md

本仓库的跨会话稳定约定。通用行为规范以各 agent 自己的全局配置为准，
这里只记本仓库特有的事实与流程。

## 构建与测试

- 本机 pnpm 已损坏，`pnpm build` 不可用。在 `media-src/` 下用 esbuild
  单条命令构建：
  `npx esbuild@0.28.2 src/main.ts --bundle --minify --outfile=../media/dist/main.js --format=iife`
  一条命令同时产出 js 与 css；不要对 css 单独再跑 esbuild（会把 bundle
  产出的完整 css 覆盖成未展开 @import 的坏产物），构建后删除遗留的
  `../media/dist/main.css.map`。
- 完整 `pnpm build` 还含 `node check-vditor-compat.js`（vditor 版本锁
  检查）与 `node copy-vditor-assets.js`（资产已在 git 中，通常无需重跑）；
  单命令构建后至少补跑 compat 检查。
- 集成测试：`node tests/integration/code-block.js`（jsdom 真实栈）；
  全量：`cd tests && node run-all.js`。

## 发布

- 版本发布走 GitHub 单源：feature 分支 PR 合入 master → master 上
  `chore(release)` 提交（package.json 版本号 + CHANGELOG 段 + 对比链接）
  → tag `vX.Y.Z` → `gh release create --notes-file`（notes 为该版本
  完整 CHANGELOG 段）。
- **每个 Release 附带 vsix**（v0.2.0 起惯例）：`npx @vscode/vsce package`
  打出 `markdown-editor-hardened-X.Y.Z.vsix`，再
  `gh release upload <tag> <文件名>`。完成判据：Release 资产列表包含
  与版本号同名的 vsix。市场发布另需 PAT，与 GitHub 单源流程独立。
