#!/bin/bash
# ad-hoc-sign.sh — 对打包产物做 ad-hoc 签名（Apple Silicon 必须，Intel 顺手做）
# 用法: bash scripts/ad-hoc-sign.sh [dist/DSH.app]
set -euo pipefail

APP="${1:-dist/DSH.app}"
if [ ! -d "$APP" ]; then
  echo "未找到 $APP，请先运行 npm run build"
  exit 1
fi

echo "==> ad-hoc 签名: $APP"
codesign --force --deep --sign - "$APP"

echo "==> 验证:"
codesign -dv "$APP" 2>&1 | grep -E "Identifier|Signature|TeamIdentifier" || true
codesign --verify --deep --strict "$APP" && echo "✅ 签名校验通过"
echo "==> 若需 Gatekeeper 放行本机运行: xattr -dr com.apple.quarantine \"$APP\""
