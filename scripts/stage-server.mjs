#!/usr/bin/env node
/**
 * stage-server.mjs — 构建并暂存 DSH 服务器产物到 staging/，供 electron-builder 打包
 *
 * 流水线（全部经实测验证）：
 *   1. 仓库构建：npm run build（tsc + tsdown + vite）
 *   2. pnpm deploy --prod --legacy：生成运行闭包 staging/server
 *   3. 补前端：apps/web(dist+package.json) → staging/server/node_modules/@deepseek-ai/dsh-web-frontend
 *   4. fix-closure.mjs：按真实启动错误补齐缺失 peer 包（vendor/workspace/外部）
 *   5. 内嵌 node 二进制 → staging/node/bin/node（可选，--no-node 跳过）
 *
 * 用法：
 *   node scripts/stage-server.mjs              # 完整暂存（含仓库构建、内嵌 node）
 *   node scripts/stage-server.mjs --skip-build # 跳过仓库构建
 *   node scripts/stage-server.mjs --no-node    # 不下载内嵌 node（运行时用系统 node）
 */
import { execSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const APP_DIR = path.resolve(__dirname, '..')
const REPO = process.env.DSH_REPO || '/Users/xiaotuc/.zcode/workspace/default/deepseek-harness'
const STAGING = path.join(APP_DIR, 'staging')
const SERVER = path.join(STAGING, 'server')

const args = process.argv.slice(2)
const withNode = !args.includes('--no-node')
const skipBuild = args.includes('--skip-build')

function run(cmd, cwd = REPO) {
  console.log(`\n$ ${cmd}  (cwd=${cwd})`)
  execSync(cmd, {
    cwd,
    stdio: 'inherit',
    // 继承调用方 PATH（本机终端 / GitHub Actions runner 都自带 node/npm），
    // 不硬编码任何机器特定路径
    env: { ...process.env, PATH: process.env.PATH },
  })
}

function checkRepo() {
  if (!fs.existsSync(path.join(REPO, 'package.json'))) {
    console.error(`仓库不存在: ${REPO}\n用环境变量 DSH_REPO 指定正确路径。`)
    process.exit(1)
  }
}

function wipe(dir) {
  fs.rmSync(dir, { recursive: true, force: true })
  fs.mkdirSync(dir, { recursive: true })
}

// ---------------------------------------------------------------------------

checkRepo()

if (!skipBuild) {
  console.log('\n[1/5] 构建仓库产物…')
  // build:lib = tsc + tsdown（无 pnpm，安全）；build:web 直接调 vite
  // （不用 npm run build：其 build:web 经 pnpm --filter，触发依赖校验需 TTY，
  //   且可能重装运行中部署仓库的 node_modules）
  run('npm run build:lib')
  console.log('  vite build (apps/web) …')
  run('node ' + path.join(REPO, 'apps/web/node_modules/vite/bin/vite.js build'), path.join(REPO, 'apps/web'))
}

console.log('\n[2/5] pnpm deploy 生成运行闭包…')
wipe(SERVER)
run('pnpm --filter @deepseek-ai/dsh deploy --prod --legacy ' + SERVER, REPO)

console.log('\n[3/5] 补前端 dist 进闭包…')
const feDir = path.join(SERVER, 'node_modules', '@deepseek-ai', 'dsh-web-frontend')
fs.mkdirSync(feDir, { recursive: true })
fs.copyFileSync(path.join(REPO, 'apps/web/package.json'), path.join(feDir, 'package.json'))
fs.cpSync(path.join(REPO, 'apps/web/dist'), path.join(feDir, 'dist'), { recursive: true })
console.log('  ✓ dsh-web-frontend (dist)')

console.log('\n[4/5] fix-closure 按启动错误补齐 peer 依赖…')
run('node scripts/fix-closure.mjs ' + SERVER + ' 10', APP_DIR)

console.log('\n[4b/5] 清理悬空符号链接（pnpm deploy 的 peer 死链；会挂 codesign --deep）…')
const pruned = pruneBrokenSymlinks(SERVER)
console.log(`  清理 ${pruned} 个悬空链接`)

console.log('\n[4c/5] 修复顶层 @deepseek-ai 链接（pnpm deploy --legacy 不建顶层链接）…')
run('node scripts/fix-toplinks.mjs ' + SERVER, APP_DIR)

console.log('\n[4d/5] fix-closure 第二轮（顶层链接修复后暴露的深层运行时缺包）…')
run('node scripts/fix-closure.mjs ' + SERVER + ' 10', APP_DIR)

function pruneBrokenSymlinks(dir) {
  let count = 0
  const walk = (d) => {
    let entries
    try { entries = fs.readdirSync(d, { withFileTypes: true }) } catch { return }
    for (const ent of entries) {
      const p = path.join(d, ent.name)
      if (ent.isSymbolicLink()) {
        if (!fs.existsSync(p)) { fs.unlinkSync(p); count++ }
      } else if (ent.isDirectory()) {
        walk(p)
      }
    }
  }
  walk(dir)
  return count
}

console.log('\n[5/5] 内嵌 node 运行时…')
if (withNode) {
  const arch = os.arch() === 'arm64' ? 'arm64' : 'x64'
  const ver = 'v22.23.1'
  const nodeDst = path.join(STAGING, 'node', 'bin', 'node')
  if (fs.existsSync(nodeDst)) {
    console.log('  已有内嵌 node，跳过下载')
  } else {
    const url = `https://npmmirror.com/mirrors/node/${ver}/node-${ver}-darwin-${arch}.tar.gz`
    const tar = path.join(STAGING, 'node-download.tar.gz')
    const outDir = path.join(STAGING, 'node-extract')
    console.log(`  下载 ${url}`)
    run(`curl -fsSL -o ${tar} ${url}`)
    wipe(outDir)
    run(`tar -xzf ${tar} -C ${outDir}`)
    const extracted = path.join(outDir, `node-${ver}-darwin-${arch}`, 'bin', 'node')
    fs.mkdirSync(path.dirname(nodeDst), { recursive: true })
    fs.copyFileSync(extracted, nodeDst)
    fs.chmodSync(nodeDst, 0o755)
    fs.rmSync(outDir, { recursive: true, force: true })
    fs.rmSync(tar, { force: true })
    console.log('  ✓ node 已就位:', nodeDst)
  }
} else {
  console.log('  跳过内嵌 node（--no-node）')
}

console.log('\n完成。暂存体积:')
for (const d of ['server', 'node']) {
  const p = path.join(STAGING, d)
  if (fs.existsSync(p)) {
    const size = execSync(`du -sh ${p}`).toString().trim()
    console.log(`  ${size}`)
  }
}
