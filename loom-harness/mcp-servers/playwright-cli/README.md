# Playwright CLI（Loom 浏览器后端的固定安装）

`ai/skills/playwright` 通过本目录的固定版本 `@playwright/cli` 驱动无头 Chromium。
不在运行时使用 `npx ...@latest`，避免联网与版本漂移。

## 版本

- `@playwright/cli`：0.1.22（见 `package.json` 与 `package-lock.json`）
- 浏览器：Chromium 1247（由包内 playwright-core 的 `browsers.json` 决定）

## 安装 / 重装

```bash
cd /opt/kinship/loom-harness/mcp-servers/playwright-cli
npm ci
PLAYWRIGHT_BROWSERS_PATH=/opt/kinship/loom-harness/mcp-servers/.playwright-browsers \
  node node_modules/playwright/cli.js install chromium
```

`node_modules/` 与 `.playwright-browsers/` 不入库（仓库 `.gitignore` 已覆盖 `node_modules/` 与浏览器缓存目录）。

## 运行时路径

- 包装脚本：`ai/skills/playwright/bin/pw`
- CLI ini：`ai/skills/playwright/cli.config.json`
- 持久化 profile：`ai/.loom/playwright-profile`（保留登录态，实例私有）
- 产物：`ai/data/browser/`（截图与快照日志，不入库）

## 升级

1. 改 `package.json` 里的版本并 `npm install`。
2. 用同一 `PLAYWRIGHT_BROWSERS_PATH` 重新执行 `install chromium`。
3. 用 `ai/skills/playwright/bin/pw open <url>` + `pw snapshot` + `pw screenshot` 冒烟，确认 `bash -n` 与真机 QA 均通过后再提交。
