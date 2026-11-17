#!/usr/bin/env bash
# 把主仓同步到公开仓（dsh-manuscript-open）并跑两侧测试。
# 用法： bash scripts/sync-open.sh [--no-test]
# 背景：两个仓库长期靠手工复制，容易漂移；这里固定成一条命令。
set -euo pipefail

MAIN="$(cd "$(dirname "$0")/.." && pwd)"
OPEN="${OPEN_REPO:-/home/tank543/src/dsh-manuscript-open}"
[ -d "$OPEN" ] || { echo "找不到公开仓：$OPEN（用 OPEN_REPO 指定）" >&2; exit 1; }

echo "== 同步 lib/ scripts/ systemd/ docs/"
rsync -a --delete --exclude node_modules "$MAIN/lib/" "$OPEN/lib/"
rsync -a "$MAIN/scripts/" "$OPEN/scripts/"
mkdir -p "$OPEN/systemd" && rsync -a "$MAIN/systemd/" "$OPEN/systemd/"
mkdir -p "$OPEN/docs" && for f in ADR-001-markdown-library-root.md 图书馆使用.md; do
  [ -f "$MAIN/docs/$f" ] && cp "$MAIN/docs/$f" "$OPEN/docs/$f"
done
[ -f "$MAIN/.gitignore" ] && cp "$MAIN/.gitignore" "$OPEN/.gitignore"

echo "== 同步版本号与 CHANGELOG"
python3 - "$MAIN" "$OPEN" <<'PY'
import json, re, sys
main, openrepo = sys.argv[1], sys.argv[2]
mv = json.load(open(f"{main}/package.json"))["version"]
p = json.load(open(f"{openrepo}/package.json"))
p["version"] = mv
json.dump(p, open(f"{openrepo}/package.json", "w"), ensure_ascii=False, indent=2)
cur = open(f"{openrepo}/CHANGELOG.md", encoding="utf-8").read()
priv = open(f"{main}/CHANGELOG.md", encoding="utf-8").read()
# 把主仓里公开仓还没有的 ## 段整体补到顶部（按版本号从新到旧）。
secs = re.findall(r"## (v[0-9][^\n]*)\n.*?(?=\n## |\Z)", priv, re.S)
for sec in secs:
    ver = sec.split()[0]
    if f"## {sec.splitlines()[0]}" in cur:
        continue
    block = f"## {sec.strip()}\n\n"
    cur = cur.replace("# 变更记录\n", "# 变更记录\n\n" + block, 1)
open(f"{openrepo}/CHANGELOG.md", "w", encoding="utf-8").write(cur)
print(f"version -> {mv}")
PY

if [ "${1:-}" != "--no-test" ]; then
  echo "== 主仓测试"
  (cd "$MAIN" && node scripts/test-all.mjs | tail -3)
  echo "== 公开仓测试"
  (cd "$OPEN" && node scripts/test-all.mjs | tail -3)
fi

echo "== 完成。两个仓库当前改动："
git -C "$MAIN" status --short | head -10
git -C "$OPEN" status --short | head -10
