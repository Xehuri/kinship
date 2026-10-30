#!/usr/bin/env bash
# 构建前端发行包：原子构建（含外部 CircuitJS 插件）-> tar.gz + sha256 + manifest 片段。
#
# 用法:
#   scripts/build-release-assets.sh [version] [output-dir] [release-manifest.json]
#
# version 缺省读取 frontend/mobile/package.json。output-dir 缺省
# dist-release/（已被 .gitignore 的 dist-*/ 覆盖）。第三个参数存在时，
# 就地更新该 release-manifest.json 的 assets.frontend（file/sha256/size），
# 其余字段与 schema 原样保留。
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
MOBILE="$ROOT/frontend/mobile"
PACKAGE_JSON="$MOBILE/package.json"

usage() {
  sed -n '2,10p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
}

if [[ "${1:-}" == "-h" || "${1:-}" == "--help" ]]; then
  usage
  exit 0
fi

VERSION="${1:-}"
if [[ -z "$VERSION" ]]; then
  VERSION="$(node -p "JSON.parse(require('fs').readFileSync(process.argv[1], 'utf8')).version" "$PACKAGE_JSON")"
fi
if [[ ! "$VERSION" =~ ^[A-Za-z0-9][A-Za-z0-9._+-]*$ ]]; then
  echo "[release-assets] invalid version: $VERSION" >&2
  exit 2
fi

OUT_DIR="${2:-${RELEASE_ASSETS_OUT:-$ROOT/dist-release}}"
MANIFEST="${3:-${RELEASE_MANIFEST:-}}"

TARBALL="axeuh-mobile-dist-$VERSION.tar.gz"
BUILD_NAME="dist-release-$VERSION"
BUILD_DIR="$MOBILE/$BUILD_NAME"
STAGING=""

cleanup() {
  if [[ -n "$STAGING" && -d "$STAGING" ]]; then
    rm -rf "$STAGING"
  fi
  if [[ -d "$BUILD_DIR" ]]; then
    rm -rf "$BUILD_DIR"
  fi
}
trap cleanup EXIT

if [[ ! -f "$PACKAGE_JSON" ]]; then
  echo "[release-assets] missing $PACKAGE_JSON" >&2
  exit 1
fi

mkdir -p "$OUT_DIR"
rm -rf "$BUILD_DIR"
STAGING="$(mktemp -d "${TMPDIR:-/tmp}/axeuh-mobile-dist.XXXXXX")"

echo "[release-assets] version=$VERSION"
echo "[release-assets] build: npm run build:atomic -- --out-dir $BUILD_NAME"
(
  cd "$MOBILE"
  npm run build:atomic -- --out-dir "$BUILD_NAME"
)

if [[ ! -f "$BUILD_DIR/index.html" ]]; then
  echo "[release-assets] build output missing index.html: $BUILD_DIR" >&2
  exit 1
fi

# CircuitJS 已在构建前由 fetch-circuitjs.mjs 从独立 GPL-2.0 仓抓取；
# 发行包保留该静态插件及随附许可文本。
mkdir -p "$STAGING/dist"
cp -a "$BUILD_DIR/." "$STAGING/dist/"

if [[ ! -f "$STAGING/dist/index.html" ]]; then
  echo "[release-assets] staged package missing dist/index.html" >&2
  exit 1
fi
if [[ ! -f "$STAGING/dist/circuitjs1/circuitjs.html" ]]; then
  echo "[release-assets] staged package missing circuitjs1 plugin" >&2
  exit 1
fi
if [[ ! -f "$STAGING/dist/circuitjs1/LICENSE" ]]; then
  echo "[release-assets] staged package missing circuitjs1 LICENSE" >&2
  exit 1
fi

tar -czf "$OUT_DIR/$TARBALL" -C "$STAGING" dist
(
  cd "$OUT_DIR"
  sha256sum "$TARBALL" > "$TARBALL.sha256"
)

SHA256="$(awk '{print $1}' "$OUT_DIR/$TARBALL.sha256")"
SIZE="$(wc -c < "$OUT_DIR/$TARBALL" | tr -d '[:space:]')"
FRAGMENT="$OUT_DIR/axeuh-mobile-dist-$VERSION.manifest.json"

cat > "$FRAGMENT" <<EOF
{
  "name": "frontend",
  "version": "$VERSION",
  "sha256": "$SHA256",
  "size": $SIZE
}
EOF

if [[ -n "$MANIFEST" ]]; then
  if [[ ! -f "$MANIFEST" ]]; then
    echo "[release-assets] manifest not found: $MANIFEST" >&2
    exit 1
  fi
  node - "$MANIFEST" "$TARBALL" "$SHA256" "$SIZE" <<'NODE'
const fs = require('fs')
const [manifestPath, file, sha256, size] = process.argv.slice(2)
const doc = JSON.parse(fs.readFileSync(manifestPath, 'utf8'))
if (!doc.assets || typeof doc.assets !== 'object' || Array.isArray(doc.assets)) {
  console.error('[release-assets] manifest has no assets object')
  process.exit(1)
}
if (!doc.assets.frontend || typeof doc.assets.frontend !== 'object') {
  console.error('[release-assets] manifest has no assets.frontend object')
  process.exit(1)
}
doc.assets.frontend.file = file
doc.assets.frontend.sha256 = sha256
doc.assets.frontend.size = Number(size)
const releaseVersion = (process.env.RELEASE_MANIFEST_VERSION || '').trim()
if (releaseVersion) {
  doc.version = releaseVersion
}
fs.writeFileSync(manifestPath, JSON.stringify(doc, null, 2) + '\n')
NODE
  echo "[release-assets] updated manifest: $MANIFEST"
fi

echo "[release-assets] tarball: $OUT_DIR/$TARBALL ($SIZE bytes)"
echo "[release-assets] sha256: $SHA256"
echo "[release-assets] checksum: $OUT_DIR/$TARBALL.sha256"
echo "[release-assets] fragment: $FRAGMENT"
