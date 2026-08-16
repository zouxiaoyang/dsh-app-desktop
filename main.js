/**
 * DSH 桌面壳主进程（Electron）
 *
 * 职责：
 *  - 内嵌 dsh web 服务（spawn 子进程，env 白名单净化——复刻 ~/bin/dsh-web.sh 的 env -i 策略，
 *    XPC_* 等 GUI 会话变量会导致启动死循环）
 *  - 生产启动路径：apps/cli/lib/bin.js web --port 0（Phase 0 已验证），stdout URL 行解析实际端口
 *  - 附加模式：3080 已有 DSH 服务（如 launchd 守护）时直接连接，不重复 spawn
 *  - 窗口 / 托盘 / 开机自启 / 崩溃重启 / 退出清理
 *
 * 配置：~/.dsh/dsh-app.json（首次运行自动生成默认值）
 * 日志：~/.dsh/logs/dsh-app.log
 */
'use strict'

const { app, BrowserWindow, Tray, Menu, shell, dialog, nativeImage } = require('electron')
const { spawn } = require('node:child_process')
const fs = require('node:fs')
const http = require('node:http')
const os = require('node:os')
const path = require('node:path')

// ---------------------------------------------------------------------------
// 配置
// ---------------------------------------------------------------------------

const HOME = os.homedir()
const DSH_HOME = process.env.DSH_HOME || path.join(HOME, '.dsh')
const CONFIG_PATH = path.join(DSH_HOME, 'dsh-app.json')
const LOG_PATH = path.join(DSH_HOME, 'logs', 'dsh-app.log')
const DEFAULT_REPO = '/Users/xiaotuc/.zcode/workspace/default/deepseek-harness'

const DEFAULT_CONFIG = {
  server: {
    // "repo" = 直接跑仓库（开发/第一版）；"staged" = 跑打包进 resources/server 的产物；"auto" = 打包走 staged，否则 repo
    mode: 'auto',
    repoPath: process.env.DSH_REPO || DEFAULT_REPO,
    nodePath: '', // 留空 = 自动：staged 模式用 resources/node，否则用 /usr/local/bin/node
    entry: 'apps/cli/lib/bin.js',
    stagedEntry: 'lib/bin.js', // deploy 闭包中 CLI 在根目录
    extraArgs: [],
    startTimeoutMs: 90000,
  },
  attach: { enabled: true, port: 3080 },
  port: 0, // 0 = 由 OS 分配，从 stdout URL 行解析
  window: { width: 1440, height: 900, minWidth: 1024, minHeight: 700 },
}

function loadConfig() {
  let cfg
  try {
    cfg = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'))
  } catch {
    cfg = {}
  }
  const merged = deepMerge(structuredClone(DEFAULT_CONFIG), cfg)
  try {
    fs.mkdirSync(path.dirname(CONFIG_PATH), { recursive: true })
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(merged, null, 2) + '\n')
  } catch (err) {
    log('写配置失败:', err.message)
  }
  return merged
}

function deepMerge(base, over) {
  for (const [k, v] of Object.entries(over || {})) {
    if (v !== null && typeof v === 'object' && !Array.isArray(v)) {
      base[k] = deepMerge(base[k] || {}, v)
    } else if (v !== undefined) {
      base[k] = v
    }
  }
  return base
}

function log(...parts) {
  const line = `[${new Date().toISOString()}] ${parts.join(' ')}\n`
  try {
    fs.mkdirSync(path.dirname(LOG_PATH), { recursive: true })
    fs.appendFileSync(LOG_PATH, line)
  } catch { /* 日志失败不致命 */ }
  process.stdout.write(line)
}

// ---------------------------------------------------------------------------
// 状态
// ---------------------------------------------------------------------------

const config = loadConfig()
if (process.env.DSH_APP_NO_ATTACH === '1') config.attach.enabled = false // 测试钩子：强制 spawn 自己的服务
let serverProc = null
let serverUrl = null // 实际连接地址（http://127.0.0.1:PORT）
let serverOwned = false // 服务是否由本 App spawn（false = 附加到外部服务，退出时不能杀）
let win = null
let tray = null
let quitting = false
let quitHandled = false
let restartAttempts = 0
let readyCheckTimer = null

// ---------------------------------------------------------------------------
// 单实例锁
// ---------------------------------------------------------------------------

// 测试钩子：DSH_APP_TEST_INSTANCE=1 用独立 userData（绕开单实例锁，供健康自愈联调）
if (process.env.DSH_APP_TEST_INSTANCE === '1') {
  app.setPath('userData', path.join(os.tmpdir(), 'dsh-test-instance'))
}

if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  app.on('second-instance', () => showWindow())
  // macOS：点击 Dock 图标 / open 唤起时重新显示隐藏窗口（关窗=隐藏，需可唤回）
  app.on('activate', () => showWindow())
}

// ---------------------------------------------------------------------------
// 服务器解析与启动
// ---------------------------------------------------------------------------

function resolveServerSpec() {
  const mode = config.server.mode === 'auto'
    ? (app.isPackaged ? 'staged' : 'repo')
    : config.server.mode

  let cwd, entry, nodePath

  if (mode === 'staged') {
    cwd = path.join(process.resourcesPath, 'server')
    // deploy 闭包结构：dsh 包在根（lib/bin.js），apps/cli/lib 只在 repo 模式
    entry = path.join(cwd, config.server.stagedEntry || 'lib/bin.js')
    const bundledNode = path.join(process.resourcesPath, 'node', 'bin', 'node')
    nodePath = fs.existsSync(bundledNode) ? bundledNode : null
  } else {
    cwd = config.server.repoPath
    entry = path.join(cwd, config.server.entry)
    nodePath = null
  }

  if (!fs.existsSync(entry)) {
    throw new Error(`服务器入口不存在: ${entry}\n请检查 ~/.dsh/dsh-app.json 的 server.repoPath，或先运行 npm run stage`)
  }

  const args = ['web', '--port', String(config.port)]
  if (config.server.extraArgs.length) args.push(...config.server.extraArgs)

  const env = serverEnv()
  return { mode, cwd, entry, nodePath, args, env }
}

/** env 白名单净化：只传最小必要变量，清掉 XPC_* 等会引发启动死循环的 GUI 会话变量 */
function serverEnv() {
  const env = {
    HOME,
    LANG: 'en_US.UTF-8',
    LC_ALL: 'en_US.UTF-8',
    LC_CTYPE: 'en_US.UTF-8',
    TERM: 'xterm-256color',
    TMPDIR: '/tmp',
    PATH: '/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin',
  }
  if (process.env.DSH_HOME) env.DSH_HOME = process.env.DSH_HOME
  if (process.env.DSH_SNAPSHOT) env.DSH_SNAPSHOT = process.env.DSH_SNAPSHOT
  return env
}

function pickNode() {
  const spec = resolveServerSpec()
  if (spec.nodePath) return spec.nodePath
  const candidates = [config.server.nodePath, '/usr/local/bin/node', '/opt/homebrew/bin/node', '/usr/bin/node']
  for (const c of candidates) {
    if (c && fs.existsSync(c)) return c
  }
  throw new Error('未找到 node 可执行文件（尝试过 /usr/local/bin/node、/opt/homebrew/bin/node、/usr/bin/node）')
}

function startServer() {
  if (quitting) return
  if (serverProc) { log('startServer: 已有服务进程，忽略'); return }
  if (readyCheckTimer) { clearInterval(readyCheckTimer); readyCheckTimer = null }
  if (attachHealthTimer) { clearInterval(attachHealthTimer); attachHealthTimer = null } // 接管后不再做附加健康检查

  let spec
  let nodePath
  try {
    spec = resolveServerSpec()
    nodePath = pickNode()
  } catch (err) {
    log('服务器解析失败:', err.message)
    showFatal(err.message)
    return
  }

  log(`spawn: ${nodePath} ${spec.entry} ${spec.args.join(' ')}  (cwd=${spec.cwd})`)
  serverOwned = true
  serverUrl = null

  serverProc = spawn(nodePath, [spec.entry, ...spec.args], {
    cwd: spec.cwd,
    env: spec.env,
    stdio: ['ignore', 'pipe', 'pipe'],
  })

  serverProc.stdout.on('data', (d) => {
    const text = d.toString()
    log('[server]', text.trimEnd())
    const m = text.match(/dsh web: (http:\/\/[0-9.:]+)/)
    if (m && !serverUrl) serverUrl = m[1]
  })
  serverProc.stderr.on('data', (d) => log('[server:err]', d.toString().trimEnd()))
  serverProc.on('error', (err) => {
    log('spawn 错误:', err.message)
    serverProc = null
    if (!quitting) scheduleRestart()
  })
  serverProc.on('exit', (code, signal) => {
    const wasOwned = serverOwned
    serverProc = null
    serverOwned = false
    serverUrl = null
    log(`服务器进程退出 code=${code} signal=${signal}`)
    if (!quitting && wasOwned) scheduleRestart()
  })

  waitForReady(spec.startTimeoutMs || 90000)
}

function waitForReady(timeoutMs) {
  const deadline = Date.now() + timeoutMs
  readyCheckTimer = setInterval(() => {
    if (serverUrl) {
      probeHttp(serverUrl, (ok) => {
        if (ok) {
          clearInterval(readyCheckTimer); readyCheckTimer = null
          restartAttempts = 0
          log('服务就绪:', serverUrl)
          onServerReady()
        } else if (Date.now() > deadline) {
          clearInterval(readyCheckTimer); readyCheckTimer = null
          log('服务启动超时')
          showFatal('DSH 服务启动超时（' + timeoutMs + 'ms）。请查看 ~/.dsh/logs/dsh-app.log')
        }
      })
    } else if (Date.now() > deadline) {
      clearInterval(readyCheckTimer); readyCheckTimer = null
      log('未捕获到 URL 行，启动超时')
      showFatal('DSH 服务未在时限内输出地址。请查看 ~/.dsh/logs/dsh-app.log')
    }
  }, 500)
}

function probeHttp(url, cb) {
  const req = http.get(url, { timeout: 2000 }, (res) => {
    res.resume()
    cb(res.statusCode === 200)
  })
  req.on('error', () => cb(false))
  req.on('timeout', () => { req.destroy(); cb(false) })
}

function scheduleRestart() {
  const delays = [3000, 10000, 30000]
  const d = delays[Math.min(restartAttempts, delays.length - 1)]
  restartAttempts++
  log(`服务异常退出，${d / 1000}s 后重启（第 ${restartAttempts} 次）`)
  setTimeout(() => { if (!quitting && !serverProc) startServer() }, d)
}

/** 附加模式：检查 3080 是否已有 DSH 服务在跑（launchd 守护等） */
function tryAttach(cb) {
  if (!config.attach.enabled) return cb(null)
  const port = config.attach.port
  http.get({ host: '127.0.0.1', port, path: '/', timeout: 1500 }, (res) => {
    let body = ''
    res.on('data', (c) => { body += c })
    res.on('end', () => {
      cb(res.statusCode === 200 && body.includes('__DSH_BOOT__') ? `http://127.0.0.1:${port}` : null)
    })
  }).on('error', () => cb(null)).on('timeout', function () { this.destroy(); cb(null) })
}

// ---------------------------------------------------------------------------
// 附加模式健康自愈：外部服务（launchd 3080）失联后自动恢复或接管
// 场景：App 附加 3080 → 用户关闭 web 服务 → 窗口停在死连接。
// 本逻辑每 5s 探测；失联 → 先探测 3080 是否恢复 → 恢复则重附加，
// 未恢复则 App 自己 spawn 服务接管，窗口自动切换。无需重启 App。
// ---------------------------------------------------------------------------

let attachHealthTimer = null
let healthInFlight = false // 入口同步置位，防 did-fail-load 与周期检查并发重入

/** 连续探测 2 次均失败才判定失联（防一次慢响应误判） */
function checkAttachedHealth() {
  if (quitting || serverOwned || !serverUrl || healthInFlight) return
  healthInFlight = true
  probeHttp(serverUrl, (ok) => {
    if (ok || quitting) { healthInFlight = false; return }
    probeHttp(serverUrl, (ok2) => {
      if (ok2 || quitting) { healthInFlight = false; return }
      log('附加的服务失联(连续探测失败):', serverUrl, '→ 尝试恢复…')
      tryAttach((url) => {
        healthInFlight = false
        if (quitting) return
        if (url) {
          if (url !== serverUrl) {
            log('外部服务已恢复，重新附加:', url)
            serverUrl = url
          }
          log('重新加载窗口')
          loadServer()
        } else {
          log('外部服务未恢复，App 接管 spawn 自己的服务')
          serverUrl = null
          startServer()
        }
      })
    })
  })
}

function startAttachHealthCheck() {
  if (attachHealthTimer) clearInterval(attachHealthTimer)
  attachHealthTimer = setInterval(checkAttachedHealth, 5000)
}

function stopServer(cb) {
  const p = serverProc
  serverProc = null
  serverUrl = null
  if (!p || !serverOwned) { cb(); return } // 附加模式的外部服务不归我们管
  serverOwned = false
  let done = false
  const finish = () => { if (!done) { done = true; cb() } }
  p.on('exit', () => finish())
  log('发送 SIGTERM 停止服务器')
  p.kill('SIGTERM')
  setTimeout(() => {
    if (!done) {
      log('5s 未退出，发送 SIGKILL')
      try { p.kill('SIGKILL') } catch { /* 已退出 */ }
      setTimeout(finish, 500)
    }
  }, 5000)
}

// ---------------------------------------------------------------------------
// 窗口
// ---------------------------------------------------------------------------

const LOADING_HTML = `data:text/html;charset=utf-8,${encodeURIComponent(`<!doctype html>
<html><body style="margin:0;background:#111418;color:#9aa4b2;font-family:-apple-system,sans-serif;
display:flex;align-items:center;justify-content:center;height:100vh">
<div style="text-align:center">
  <div style="font-size:20px;font-weight:600;color:#e8eaed">DSH</div>
  <div style="margin-top:12px;font-size:13px">正在启动 DSH 服务…</div>
</div></body></html>`)}`

function createWindow() {
  win = new BrowserWindow({
    width: config.window.width,
    height: config.window.height,
    minWidth: config.window.minWidth,
    minHeight: config.window.minHeight,
    show: false,
    title: 'DSH',
    backgroundColor: '#111418',
    icon: windowIcon(),
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  })

  win.once('ready-to-show', () => win.show())
  win.on('close', (e) => {
    if (!quitting) { e.preventDefault(); win.hide() } // macOS 惯例：关窗=隐藏，Cmd+Q 才退出
  })
  win.on('closed', () => { win = null })

  // 外部链接走系统浏览器；阻止窗口内导航离开服务源
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/.test(url)) shell.openExternal(url)
    return { action: 'deny' }
  })
  win.webContents.on('will-navigate', (e, url) => {
    if (serverUrl && !url.startsWith(serverUrl) && !url.startsWith('data:')) e.preventDefault()
  })
  // 加载失败兜底：附加模式立即触发健康检查（服务可能已死，自动恢复/接管）
  win.webContents.on('did-fail-load', (_e, code, desc, url) => {
    if (!url.startsWith('http://127.0.0.1')) return
    if (code === -3) return // ERR_ABORTED：导航被新导航打断，非真实失败
    log('窗口加载失败:', code, desc, url)
    if (!serverOwned) checkAttachedHealth()
  })

  win.loadURL(LOADING_HTML)
  if (serverUrl) loadServer()
}

function loadServer() {
  if (!win || !serverUrl) return
  win.loadURL(serverUrl).catch((err) => log('加载 GUI 失败:', err.message))
  win.setTitle('DSH')
  if (tray) tray.setToolTip(`DSH · ${serverUrl}`)
}

function onServerReady() {
  if (win) loadServer()
}

function showWindow() {
  if (!win) return
  if (win.isMinimized()) win.restore()
  win.show()
  win.focus()
}

function toggleWindow() {
  if (!win) return
  if (win.isVisible() && !win.isMinimized()) win.hide()
  else showWindow()
}

function showFatal(msg) {
  log('FATAL:', msg)
  if (win) {
    win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(
      `<!doctype html><html><body style="margin:40px;background:#111418;color:#e8eaed;font-family:-apple-system,sans-serif">
      <h2 style="font-size:16px">DSH 服务启动失败</h2>
      <pre style="white-space:pre-wrap;font-size:13px;color:#9aa4b2">${msg}</pre>
      <button onclick="location.reload()" style="margin-top:16px;padding:6px 16px">重试</button>
      </body></html>`)}`)
  } else {
    dialog.showErrorBox('DSH 启动失败', msg)
  }
}

// ---------------------------------------------------------------------------
// 托盘 / 菜单 / 自启
// ---------------------------------------------------------------------------

/** 窗口/Dock 图标：官方图标（icns 白底蓝鲸；nativeImage 不能加载 icns 时退回 png） */
function windowIcon() {
  for (const c of [path.join(process.resourcesPath, 'icon.icns'), path.join(__dirname, 'assets', 'icon.icns')]) {
    if (fs.existsSync(c)) {
      const img = nativeImage.createFromPath(c)
      if (!img.isEmpty()) return img
    }
  }
  return null
}

/** 托盘图标：template PNG（黑+alpha，菜单栏自动适配明暗） */
function trayIcon() {
  const candidates = [
    path.join(process.resourcesPath, 'icon.png'),
    path.join(__dirname, 'assets', 'icon.png'),
    path.join(process.resourcesPath, 'app.asar', 'assets', 'icon.png'),
  ]
  for (const c of candidates) {
    if (!fs.existsSync(c)) continue
    const img = nativeImage.createFromPath(c)
    if (img.isEmpty()) { log('托盘 icon 加载失败(空):', c); continue }
    img.setTemplateImage(true)
    return img.resize({ width: 18, height: 18 })
  }
  log('托盘 icon 候选全部不可用')
  return null
}

function createTray() {
  const img = trayIcon()
  if (!img) { log('无托盘图标，跳过托盘'); return }
  tray = new Tray(img)
  tray.setToolTip('DSH')
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: '显示 / 隐藏窗口', click: toggleWindow },
    { label: '在浏览器中打开', click: () => { if (serverUrl) shell.openExternal(serverUrl) } },
    { type: 'separator' },
    { label: '重启服务', click: restartServer },
    {
      label: '开机自启',
      type: 'checkbox',
      checked: app.getLoginItemSettings().openAtLogin,
      click: (item) => {
        app.setLoginItemSettings({ openAtLogin: item.checked, openAsHidden: true })
        log('开机自启:', item.checked)
      },
    },
    { type: 'separator' },
    { label: '退出 DSH', click: () => { quitting = true; app.quit() } },
  ]))
}

function setupMenu() {
  const template = [
    {
      role: 'appMenu',
      submenu: [
        { role: 'about', label: '关于 DSH' },
        { type: 'separator' },
        { role: 'quit', label: '退出 DSH' },
      ],
    },
    { role: 'editMenu' },
    { role: 'windowMenu' },
  ]
  Menu.setApplicationMenu(Menu.buildFromTemplate(template))
}

function restartServer() {
  log('手动重启服务')
  if (serverOwned && serverProc) {
    stopServer(() => startServer())
  } else {
    // 附加模式：外部服务不归我们管，重新加载窗口即可
    if (win) { win.loadURL(LOADING_HTML); setTimeout(() => { if (serverUrl) loadServer() }, 1000) }
  }
}

// ---------------------------------------------------------------------------
// 应用生命周期
// ---------------------------------------------------------------------------

app.on('before-quit', (e) => {
  if (quitHandled) return
  e.preventDefault()
  quitHandled = true
  stopServer(() => app.exit(0))
})

app.on('window-all-closed', () => { /* macOS：保持常驻托盘 */ })

app.whenReady().then(() => {
  setupMenu()
  createWindow()
  createTray()

  // 开机自启测试钩子：DSH_APP_AUTOSTART_TEST=1 时注册登录项并记录状态
  if (process.env.DSH_APP_AUTOSTART_TEST === '1') {
    app.setLoginItemSettings({ openAtLogin: true, openAsHidden: true })
    log('AUTOSTART TEST: openAtLogin=', app.getLoginItemSettings().openAtLogin)
  } else if (process.env.DSH_APP_AUTOSTART_TEST === '0') {
    app.setLoginItemSettings({ openAtLogin: false })
    log('AUTOSTART TEST: disabled, openAtLogin=', app.getLoginItemSettings().openAtLogin)
  }

  // 附加优先：3080 已有 DSH 服务则直接连；否则 spawn 自己的服务
  tryAttach((url) => {
    if (url) {
      log('附加到已有服务:', url)
      serverUrl = url
      serverOwned = false
      loadServer()
      startAttachHealthCheck()
    } else {
      startServer()
    }
  })
})

// 冒烟测试钩子：DSH_APP_SMOKE=1 时，窗口加载成功后自动退出
app.on('web-contents-created', (_e, contents) => {
  if (process.env.DSH_APP_SMOKE) {
    contents.on('did-finish-load', () => {
      const url = contents.getURL()
      if (url.startsWith('http://127.0.0.1')) {
        log('SMOKE OK:', url)
        // 走正常退出路径（before-quit → stopServer → exit），避免遗留孤儿进程
        setTimeout(() => { quitting = true; app.quit() }, 1000)
      }
    })
  }
})
