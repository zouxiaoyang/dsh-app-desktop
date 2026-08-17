#!/usr/bin/env node
/**
 * fix-closure.mjs — 按真实启动错误修补 pnpm deploy 闭包
 *
 * pnpm deploy --prod 不装 peerDependencies，运行时才会暴露缺失。
 * 本脚本循环：启动闭包内服务器 → 解析日志里所有 "Cannot find package 'X'"
 * → 从仓库拷贝 X 及其 @deepseek-ai 依赖到闭包 → 再启动，直到 URL 行出现。
 * Client 侧包（浏览器 bundle 提供）永远不会进入这份 node 闭包需求。
 *
 * 用法: node scripts/fix-closure.mjs <closureDir> [maxRounds]
 */
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'

const REPO = process.env.DSH_REPO || '/Users/xiaotuc/.zcode/workspace/default/deepseek-harness'
const CLOSURE = process.argv[2]
const MAX_ROUNDS = Number(process.argv[3] || 8)
if (!CLOSURE) { console.error('用法: node scripts/fix-closure.mjs <closureDir> [maxRounds]'); process.exit(1) }

const closureNM = path.join(CLOSURE, 'node_modules')
const copied = new Set()

/**
 * 运行必需但启动探测不到的包：它们只在 agent-preset 挂载路径（创建/恢复会话、
 * 工具插件加载）才被 import，fix-closure 的 bootOnce 只验证 web 服务启动，
 * 探测不到这些缺失。每次构建无条件补齐（copyPkg 会递归带上其依赖）。
 */
const ALWAYS_COPY = [
  '@deepseek-ai/dsh-sandbox',
  '@deepseek-ai/dsh-fs',
  '@deepseek-ai/dsh-output-retention',
  '@deepseek-ai/dsh-workflow',
  '@deepseek-ai/dsh-shell',
  '@deepseek-ai/dsh-compaction',
  '@deepseek-ai/dsh-agent-presets',
]

function existsInClosure(name) {
  return fs.existsSync(path.join(closureNM, ...name.split('/')))
}

function repoRequire() {
  return createRequire(path.join(REPO, 'apps/cli/package.json'))
}

/** 从仓库解析包的真实目录（含 package.json）：先依赖解析，再全仓库搜索包名 */
function resolvePkgRoot(name) {
  try {
    const pj = repoRequire().resolve(`${name}/package.json`)
    return path.dirname(pj)
  } catch {
    for (const root of [path.join(REPO, 'packages'), path.join(REPO, 'vendor')]) {
      if (!fs.existsSync(root)) continue
      for (const d1 of fs.readdirSync(root)) {
        const p1 = path.join(root, d1)
        if (!fs.statSync(p1).isDirectory()) continue
        // vendor/<name>/package.json 和 packages/<domain>/<name>/package.json
        const candidates = root.endsWith('vendor')
          ? [p1]
          : fs.readdirSync(p1).map((d2) => path.join(p1, d2)).filter((p2) => fs.statSync(p2).isDirectory())
        for (const pkgDir of candidates) {
          const pjPath = path.join(pkgDir, 'package.json')
          if (!fs.existsSync(pjPath)) continue
          const pj = JSON.parse(fs.readFileSync(pjPath, 'utf8'))
          if (pj.name === name) return pkgDir
        }
      }
    }
    throw new Error(`仓库中找不到包 ${name}`)
  }
}

/** 拷贝一个包进闭包：package.json + files 字段列出的内容（跳过 node_modules） */
function copyPkg(name, pkgRoot, force = false) {
  const dest = path.join(closureNM, ...name.split('/'))
  if (!force && fs.existsSync(dest)) return
  const pj = JSON.parse(fs.readFileSync(path.join(pkgRoot, 'package.json'), 'utf8'))
  fs.mkdirSync(dest, { recursive: true })
  fs.copyFileSync(path.join(pkgRoot, 'package.json'), path.join(dest, 'package.json'))
  const hasFiles = Array.isArray(pj.files) && pj.files.length > 0
  const hasGlob = hasFiles && pj.files.some((f) => f.includes('*') || f.includes('?'))
  if (hasFiles && !hasGlob) {
    for (const f of pj.files) {
      const src = path.join(pkgRoot, f)
      if (!fs.existsSync(src)) continue
      fs.cpSync(src, path.join(dest, f), {
        recursive: true,
        // 只排除包目录内部的嵌套 node_modules（pnpm 链接），store 源路径本身含 node_modules 不算
        filter: (p) => !path.relative(pkgRoot, p).split(path.sep).includes('node_modules'),
      })
    }
  } else {
    // 无 files 字段（如 zod）：整包拷贝，排除 node_modules
    for (const ent of fs.readdirSync(pkgRoot)) {
      if (ent === 'node_modules' || ent === 'package.json') continue
      fs.cpSync(path.join(pkgRoot, ent), path.join(dest, ent), {
        recursive: true,
        filter: (p) => !path.relative(pkgRoot, p).split(path.sep).includes('node_modules'),
      })
    }
  }
  copied.add(name)
  console.log(`  + ${name}  <- ${path.relative(REPO, pkgRoot) || pkgRoot}`)

  // 递归补依赖（workspace 包从仓库搜，外部包从仓库 store 解析）
  for (const dep of Object.keys({ ...(pj.dependencies || {}), ...(pj.peerDependencies || {}) })) {
    if (existsInClosure(dep)) continue
    if (dep.startsWith('@deepseek-ai/')) {
      try { copyPkg(dep, resolvePkgRoot(dep)) } catch (err) { console.error(`  ✗ ${dep}: ${err.message}`) }
    } else {
      try { copyPkg(dep, resolveExternalRoot(dep)) } catch (err) { console.error(`  ✗ ${dep}: ${err.message}`) }
    }
  }
}

/** 外部包：从仓库 node_modules/.pnpm store 定位真实目录 */
function resolveExternalRoot(name) {
  const storeDir = path.join(REPO, 'node_modules', '.pnpm')
  const prefix = name.startsWith('@')
    ? name.replace('/', '+')
    : name
  if (!fs.existsSync(storeDir)) throw new Error(`仓库 store 不存在: ${storeDir}`)
  const entries = fs.readdirSync(storeDir).filter((e) => e.startsWith(`${prefix}@`))
  if (entries.length === 0) throw new Error(`store 中找不到 ${name}`)
  // 取版本最高者
  entries.sort((a, b) => {
    const va = a.slice(prefix.length + 1).split('_')[0]
    const vb = b.slice(prefix.length + 1).split('_')[0]
    return vb.localeCompare(va, undefined, { numeric: true })
  })
  const pkgDir = path.join(storeDir, entries[0], 'node_modules', ...name.split('/'))
  if (!fs.existsSync(pkgDir)) throw new Error(`store 条目缺少包目录: ${entries[0]}`)
  return fs.realpathSync(pkgDir)
}

/** 启动闭包内服务器一次，返回 { url, missing[] } */
function bootOnce() {
  return new Promise((resolve) => {
    const env = {
      HOME: os.homedir(),
      LANG: 'en_US.UTF-8', LC_ALL: 'en_US.UTF-8', LC_CTYPE: 'en_US.UTF-8',
      TERM: 'xterm-256color', TMPDIR: '/tmp',
      PATH: process.env.PATH,
    }
    const node = process.env.CLOSURE_NODE || 'node'
    const child = spawn(node, ['lib/bin.js', 'web', '--port', '0'], {
      cwd: CLOSURE, env, stdio: ['ignore', 'pipe', 'pipe'],
    })
    let out = ''
    const timer = setTimeout(() => { child.kill('SIGKILL') }, 60000)
    child.stdout.on('data', (d) => { out += d.toString() })
    child.stderr.on('data', (d) => { out += d.toString() })
    child.on('exit', () => { clearTimeout(timer); resolve(parse(out)) })
    child.on('error', (err) => { clearTimeout(timer); resolve({ url: null, missing: [], fatal: err.message }) })
  })
}

function parse(out) {
  const urlMatch = out.match(/dsh web: (http:\/\/[0-9.:]+)/)
  const missing = new Set()
  const closureReal = fs.realpathSync(CLOSURE) // /tmp → /private/tmp 归一化
  const closureNMReal = fs.realpathSync(closureNM)
  for (const m of out.matchAll(/Cannot find package '([^']+)'/g)) missing.add(m[1])
  for (const m of out.matchAll(/Cannot find module '([^']+)'/g)) {
    const p = m[1]
    if (p.startsWith(closureReal)) {
      const rel = path.relative(closureNMReal, p)
      const seg = rel.split(path.sep)
      if (seg[0].startsWith('@')) missing.add(seg.slice(0, 2).join('/'))
      else if (seg.length >= 1) missing.add(seg[0])
    }
  }
  return { url: urlMatch ? urlMatch[1] : null, missing: [...missing] }
}

// ---- 主循环 ----
for (const name of ALWAYS_COPY) {
  if (existsInClosure(name)) continue
  try { copyPkg(name, resolvePkgRoot(name)) } catch (err) { console.error(`  ✗ ${name}: ${err.message}`) }
}
for (let round = 1; round <= MAX_ROUNDS; round++) {
  process.stdout.write(`[round ${round}] 启动闭包服务器…`)
  const { url, missing, fatal } = await bootOnce()
  if (url) {
    console.log(` ✅ 启动成功: ${url}`)
    console.log('闭包补齐完成，新增:', [...copied].join(', ') || '(无需补齐)')
    process.exit(0)
  }
  if (fatal) { console.error(` ❌ spawn 失败: ${fatal}`); process.exit(1) }
  if (missing.length === 0) {
    console.log(' ❌ 启动失败但无缺失包错误，看日志排障')
    process.exit(1)
  }
  console.log(` ❌ 缺 ${missing.length} 个包:`, missing.join(', '))
  for (const name of missing) {
    const already = existsInClosure(name)
    if (already) console.log(`    ${name} 已在闭包但解析失败 → 强制重拷`)
    try {
      const root = name.startsWith('@deepseek-ai/') ? resolvePkgRoot(name) : resolveExternalRoot(name)
      copyPkg(name, root, already)
    } catch (err) { console.error(`  ✗ ${name}: ${err.message}`) }
  }
}

console.error(`✗ ${MAX_ROUNDS} 轮未收敛`)
process.exit(1)
