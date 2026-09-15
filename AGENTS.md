# AGENTS.md

本仓库的跨会话稳定约定。通用行为规范以各 agent 自己的全局配置为准，
这里只记本仓库特有的事实与流程。

## 构建与测试

- 在 `media-src/` 下 `pnpm build`（compat 检查 + esbuild 0.28.2 打包，
  一条命令同时产出 js 与 css）。历史坑（已修复）：旧 build 脚本用
  Unix 分号与 `rm -rf`，Windows 下 `--bundle` 被并进 rm 参数而失败，
  曾被误诊为"pnpm 损坏"；且本地 esbuild 0.11 安装残缺。二者均已修。
- `copy-vditor-assets` 是**独立**脚本，仅升级 vditor 版本时手动跑：
  它会用 node_modules 的原版覆盖 `media/vditor/dist`，**fork 修改过的
  `js/lute/lute.min.js` 会被抹掉**，跑完必须 `git checkout -- media/vditor/dist`
  或重打 Lute 补丁。日常构建不要执行它。
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
