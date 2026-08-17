# DSH Desktop（DSH 桌面壳）

把 DeepSeek Harness 的 Web GUI 包成一个 macOS 原生 App（Electron）：原生窗口、托盘常驻、开机自启、服务生命周期管理。**复用 `~/.dsh` 的全部配置/会话/自定义插件，不新建数据目录。**

## 架构：App 与 Web 服务完全独立

```
┌─ DSH Desktop App（本仓库）──────────────────┐
│  启动 → 自 spawn 内嵌 DSH 服务 → http://127.0.0.1:3081
│  退出 → 服务随 App 结束
└─────────────────────────────────────────────┘

┌─ DSH Web（可选，独立部署）──────────────────┐
│  launchd 守护 → http://127.0.0.1:3080
│  与 App 无任何关系（不附加、不接管、不干扰）
└─────────────────────────────────────────────┘
```

- **App 自建服务固定端口 `3081`**（可配置），每次启动端口不变，浏览器可直接访问
- 默认关闭附加模式（`~/.dsh/dsh-app.json` → `attach.enabled: false`）；打开后改为附加 3080
- **健康自愈**（附加模式下）：连续探测 2 次失败才判定失联（防单次慢响应误报），失联后先尝试重附加，未恢复则接管 spawn 自己的服务
- macOS 关窗=隐藏（进程驻留托盘），点击 Dock 图标可唤回窗口（`activate` 处理）

## 功能

- 托盘菜单：显示/隐藏窗口、浏览器打开、重启服务、开机自启、退出
- 窗口/托盘图标（`assets/icon.icns`、`icon.png`）
- 服务崩溃自动重启（3s/10s/30s 退避）
- 内嵌 Node 运行时（`staging/node`），App 不依赖系统 Node
- 服务器与壳是两个进程：服务器崩溃自动重启，Electron 自身崩溃不影响服务器

## 目录

```
dsh-app/
├── main.js                  # 主进程全部逻辑（纯 JS，无构建）
├── assets/icon.png|icns     # App 图标
├── scripts/
│   ├── stage-server.mjs     # 暂存服务器产物（lib + dist + node_modules [+内嵌 node]）
│   ├── fix-closure.mjs      # 按启动错误 + 必需包清单补齐缺包
│   ├── fix-toplinks.mjs     # 修复 pnpm deploy --legacy 缺失的顶层链接
│   ├── check-closure.sh     # 闭包完整性检查（逐个 import 所有包）
│   └── after-pack.mjs       # afterPack 钩子（ad-hoc 签名）
└── staging/                 # 打包输入（build 时生成，可随时重建，不入库）
```

## 支持的平台

- **当前发布包：Intel (x86_64) macOS 专用**（Mach-O x86_64）
- Apple Silicon 用户：可用 Rosetta 2 转译运行（非原生）
- 构建脚本按构建机器架构自动适配：在 Apple Silicon 上跑 `npm run build` 会产出
  arm64 版；GitHub Actions 自动构建 arm64 的规划见 `.github/workflows/build.yml`

## 构建

```bash
# 需要 DeepSeek Harness 仓库（MIT），默认路径可用 DSH_REPO 环境变量覆盖
export DSH_REPO=/path/to/deepseek-harness
npm install
npm run build                          # 产出 dist/mac/DSH.app（含修复后的 server 闭包）
npx electron-builder --mac dmg         # 产出安装镜像 dist/DSH-<ver>.dmg
```

构建流水线（`scripts/stage-server.mjs`）自动修复 pnpm deploy 产物的问题：

1. `fix-closure.mjs` — 按启动错误补齐缺包 + 必需包清单（`dsh-sandbox`、`dsh-fs`、
   `dsh-output-retention`、`dsh-workflow`、`dsh-shell`、`dsh-compaction`、
   `dsh-agent-presets`）
2. `fix-toplinks.mjs` — 重建缺失的顶层 `@deepseek-ai` 符号链接
3. 第二轮 `fix-closure` — 顶层链接修复后暴露的深层运行时缺包自动补齐

> 缺失这些修复的闭包会出现 `Cannot find package '@deepseek-ai/dsh-sandbox'`、
> `preset "cordis" failed to mount`、`refusing to compose an unscoped context`
> 等运行时错误。

## 配置

首次运行生成 `~/.dsh/dsh-app.json`：

```jsonc
{
  "server": { "mode": "auto", "repoPath": "/path/to/deepseek-harness", ... },
  "attach": { "enabled": false, "port": 3080 },
  "port": 3081,          // App 自建服务的固定端口
  "window": { "width": 1440, "height": 900, ... }
}
```

## 许可

- 本仓库：MIT（见 LICENSE）
- 内嵌 DeepSeek Harness：MIT（见 NOTICE）
