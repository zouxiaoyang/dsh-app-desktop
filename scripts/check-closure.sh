#!/bin/bash
# 闭包完整性检查：逐个 import 所有 @deepseek-ai 包的主入口，报告缺包
SERVER="$1"
NODE="$2"
cd "$SERVER" || exit 1
FAIL=0
for pkgdir in node_modules/@deepseek-ai/*/; do
  name="@deepseek-ai/$(basename "$pkgdir")"
  # 包必须有 package.json 且非空目录
  [ -f "$pkgdir/package.json" ] || { echo "⚠ $name 无 package.json"; continue; }
  out=$("$NODE" -e "import('$name').then(()=>process.exit(0)).catch(e=>{console.error(e.message.slice(0,200));process.exit(1)})" 2>&1)
  if [ $? -ne 0 ]; then
    echo "❌ $name"
    echo "   $out" | head -2
    FAIL=1
  else
    echo "✅ $name"
  fi
done
exit $FAIL
