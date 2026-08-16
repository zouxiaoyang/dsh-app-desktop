// 修复闭包顶层 @deepseek-ai 链接：删除坏链接，从 .pnpm 补齐正确链接
import fs from 'node:fs'
import path from 'node:path'

const ROOT = process.argv[2] || '.'
const NM = path.join(ROOT, 'node_modules', '@deepseek-ai')
const PNPM = path.join(ROOT, 'node_modules', '.pnpm')

// 1. 删除坏链接
let removed = 0
for (const ent of fs.readdirSync(NM)) {
  const p = path.join(NM, ent)
  let st
  try { st = fs.lstatSync(p) } catch { continue }
  if (st.isSymbolicLink() && !fs.existsSync(p)) {
    fs.unlinkSync(p)
    removed++
  }
}
console.log('removed broken:', removed)

// 2. 收集 .pnpm 里每个 @deepseek-ai 包名 → 优先选版本最高的 pnpm 目录
const seen = new Map()
for (const pnpmDir of fs.readdirSync(PNPM)) {
  if (!pnpmDir.startsWith('@deepseek-ai+')) continue
  const base = path.join(PNPM, pnpmDir, 'node_modules', '@deepseek-ai')
  if (!fs.existsSync(base)) continue
  for (const ent of fs.readdirSync(base)) {
    const key = ent
    if (!seen.has(key)) seen.set(key, pnpmDir)
  }
}
console.log('packages in .pnpm:', seen.size)

// 3. 补链接
let created = 0
for (const [name, pnpmDir] of seen) {
  const target = path.join(NM, name)
  if (fs.existsSync(target)) continue
  const rel = path.join('..', '.pnpm', pnpmDir, 'node_modules', '@deepseek-ai', name)
  fs.symlinkSync(rel, target)
  created++
}
console.log('created links:', created)

// 4. 校验：全部顶层链接可达
let bad = 0
for (const ent of fs.readdirSync(NM)) {
  const p = path.join(NM, ent)
  let st
  try { st = fs.lstatSync(p) } catch { continue }
  if (st.isSymbolicLink() && !fs.existsSync(p)) {
    console.log('STILL BROKEN:', ent)
    bad++
  }
}
console.log('remaining broken:', bad)
