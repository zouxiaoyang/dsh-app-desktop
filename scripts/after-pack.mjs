#!/usr/bin/env node
/**
 * after-pack.mjs — electron-builder 打包钩子：构建完成后自动做 ad-hoc 签名
 * （Apple Silicon 必须；Intel 顺手做。个人自用无需 Developer ID/公证）
 *
 * package.json: "build": { "afterPack": "scripts/after-pack.mjs" }
 */
import { execSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

export default async function afterPack(context) {
  const { appOutDir, packager } = context
  const productName = packager.appInfo.productName
  const appPath = path.join(appOutDir, `${productName}.app`)
  if (!fs.existsSync(appPath)) {
    console.warn('[afterPack] 未找到', appPath, '跳过签名')
    return
  }
  console.log('[afterPack] ad-hoc 签名:', appPath)
  execSync(`codesign --force --deep --sign - "${appPath}"`, { stdio: 'inherit' })
  execSync(`codesign --verify -v "${appPath}"`, { stdio: 'inherit' })
  console.log('[afterPack] 签名完成 ✅')
}
