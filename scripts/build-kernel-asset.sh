#!/usr/bin/env bash
# 构建内核发行包：build_dist -> 校验产物 -> tar.gz + sha256 -> release manifest assets.kernel。
#
# 用法:
#   scripts/build-kernel-asset.sh [version] [output-dir] [release-manifest.json]
#   scripts/build-kernel-asset.sh --self-check
#
# 环境变量:
#   PROTECTION=pyc            保护方案（auto|pyarmor|pyc，默认 pyc）
#   PYTHON=python3            构建解释器
#   KERNEL_VERSION=<ver>      版本（等同第一个参数）
#   API_VERSION=<ver>         清单 api_version 覆盖值
#   RELEASE_MANIFEST=<path>   清单路径（等同第三个参数）
#
# version 缺省读取 kernel/dist/axeuh-kernel/BUILD_INFO.json，其次
# kernel/pyproject.toml。output-dir 缺省 dist-release/。清单缺省
# <output-dir>/release-manifest.json；不存在时创建最小 schema 1 文档，
# 存在时只更新 assets.kernel，其余字段原样保留。
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DIST="$ROOT/kernel/dist/axeuh-kernel"
BUILD_INFO="$DIST/BUILD_INFO.json"
KERNEL_PYPROJECT="$ROOT/kernel/pyproject.toml"
KERNEL_INIT="$ROOT/kernel/axeuh_kernel/__init__.py"
PYTHON="${PYTHON:-python3}"

usage() {
  cat <<'USAGE'
构建内核发行包（预构建保护产物，不含源码）。

用法:
  scripts/build-kernel-asset.sh [version] [output-dir] [release-manifest.json]
  scripts/build-kernel-asset.sh --self-check

参数:
  version               内核包版本；缺省读 BUILD_INFO.json / pyproject.toml
  output-dir            输出目录；缺省 dist-release/
  release-manifest.json 清单路径；缺省 <output-dir>/release-manifest.json

环境变量:
  PROTECTION=pyc        build_dist 保护方案（auto|pyarmor|pyc）
  PYTHON=python3        构建解释器
  KERNEL_VERSION=<ver>  版本（等同第一个参数）
  API_VERSION=<ver>     清单 api_version 覆盖值
  RELEASE_MANIFEST=...  清单路径（等同第三个参数）
USAGE
}

require_cmd() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "[kernel-asset] missing required command: $1" >&2
    exit 1
  fi
}

sha256_of() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | awk '{print $1}'
  else
    shasum -a 256 "$1" | awk '{print $1}'
  fi
}

json_version() {
  local path="$1"
  [[ -f "$path" ]] || return 0
  node -e '
    const fs = require("fs")
    let doc = {}
    try { doc = JSON.parse(fs.readFileSync(process.argv[1], "utf8")) } catch (exc) { process.exit(0) }
    if (!doc || typeof doc !== "object" || Array.isArray(doc)) process.exit(0)
    for (const key of ["package_version", "version", "api_version"]) {
      const value = doc[key]
      if (typeof value === "string" && value.trim()) { console.log(value.trim()); break }
    }
  ' "$path" 2>/dev/null || true
}

json_api_version() {
  local path="$1"
  [[ -f "$path" ]] || return 0
  node -e '
    const fs = require("fs")
    let doc = {}
    try { doc = JSON.parse(fs.readFileSync(process.argv[1], "utf8")) } catch (exc) { process.exit(0) }
    if (!doc || typeof doc !== "object" || Array.isArray(doc)) process.exit(0)
    const value = doc.api_version
    if (typeof value === "string" && value.trim()) console.log(value.trim())
  ' "$path" 2>/dev/null || true
}

toml_version() {
  local path="$1"
  [[ -f "$path" ]] || return 0
  sed -n 's/^version[[:space:]]*=[[:space:]]*"\([^"]*\)".*/\1/p' "$path" | head -n1
}

source_api_version() {
  [[ -f "$KERNEL_INIT" ]] || return 0
  sed -n -E "s/^(API_VERSION|__version__)[[:space:]]*=[[:space:]]*['\"]([^'\"]+)['\"].*/\2/p" "$KERNEL_INIT" | head -n1
}

update_manifest() {
  local manifest_path="$1" file="$2" sha256="$3" size="$4" version="$5" api_version="$6"
  node - "$manifest_path" "$file" "$sha256" "$size" "$version" "$api_version" <<'NODE'
const fs = require('fs')
const [manifestPath, file, sha256, sizeText, version, apiVersion] = process.argv.slice(2)
let doc = null
if (fs.existsSync(manifestPath)) {
  let raw
  try {
    raw = fs.readFileSync(manifestPath, 'utf8')
  } catch (exc) {
    console.error('[kernel-asset] cannot read manifest: ' + manifestPath)
    process.exit(1)
  }
  try {
    doc = JSON.parse(raw)
  } catch (exc) {
    console.error('[kernel-asset] manifest is not valid JSON: ' + manifestPath)
    process.exit(1)
  }
}
if (doc === null) {
  doc = { schema: 1, product: 'kinship', version, assets: {} }
}
if (typeof doc !== 'object' || Array.isArray(doc)) {
  console.error('[kernel-asset] manifest root must be an object')
  process.exit(1)
}
if (!doc.assets || typeof doc.assets !== 'object' || Array.isArray(doc.assets)) {
  doc.assets = {}
}
const existing =
  doc.assets.kernel && typeof doc.assets.kernel === 'object' && !Array.isArray(doc.assets.kernel)
    ? doc.assets.kernel
    : {}
existing.file = file
existing.sha256 = sha256
existing.size = Number(sizeText)
existing.api_version = apiVersion
doc.assets.kernel = existing
if (!doc.version) doc.version = version
fs.writeFileSync(manifestPath, JSON.stringify(doc, null, 2) + '\n')
NODE
}

self_check() {
  require_cmd "$PYTHON"
  require_cmd node
  require_cmd tar
  local tmp
  tmp="$(mktemp -d "${TMPDIR:-/tmp}/axeuh-kernel-asset-check.XXXXXX")"
  trap "rm -rf '$tmp'" EXIT
  cat > "$tmp/BUILD_INFO.json" <<'JSON'
{"product": "axeuh-kernel", "protection": "pyc", "package_version": "9.9.9"}
JSON
  local version
  version="$(json_version "$tmp/BUILD_INFO.json")"
  if [[ "$version" != "9.9.9" ]]; then
    echo "[kernel-asset] self-check failed: BUILD_INFO version=$version" >&2
    exit 1
  fi
  cat > "$tmp/pyproject.toml" <<'TOML'
[project]
name = "axeuh-kernel"
version = "8.8.8"
TOML
  version="$(toml_version "$tmp/pyproject.toml")"
  if [[ "$version" != "8.8.8" ]]; then
    echo "[kernel-asset] self-check failed: pyproject version=$version" >&2
    exit 1
  fi
  cat > "$tmp/release-manifest.json" <<'JSON'
{
  "schema": 1,
  "product": "kinship",
  "version": "2026.10.26",
  "extra": {"keep": true},
  "assets": {
    "frontend": {"file": "dist.tar.gz", "sha256": "aa", "size": 1}
  }
}
JSON
  local digest
  digest="$(printf 'b%.0s' {1..64})"
  update_manifest "$tmp/release-manifest.json" axeuh-kernel-9.9.9.tar.gz "$digest" 12345 9.9.9 1.0.0
  node - "$tmp/release-manifest.json" "$digest" <<'NODE'
const fs = require('fs')
const [manifestPath, digest] = process.argv.slice(2)
const doc = JSON.parse(fs.readFileSync(manifestPath, 'utf8'))
const asset = doc.assets && doc.assets.kernel
const ok =
  doc.extra && doc.extra.keep === true &&
  doc.assets.frontend && doc.assets.frontend.file === 'dist.tar.gz' &&
  asset && asset.file === 'axeuh-kernel-9.9.9.tar.gz' &&
  asset.sha256 === digest && asset.size === 12345 && asset.api_version === '1.0.0'
if (!ok) {
  console.error('[kernel-asset] self-check failed: manifest merge mismatch')
  process.exit(1)
}
NODE
  echo "[kernel-asset] self-check ok"
}

if [[ "${1:-}" == "-h" || "${1:-}" == "--help" ]]; then
  usage
  exit 0
fi
if [[ "${1:-}" == "--self-check" ]]; then
  self_check
  exit 0
fi

VERSION_ARG="${1:-}"
OUT_DIR="${2:-${RELEASE_ASSETS_OUT:-$ROOT/dist-release}}"
MANIFEST="${3:-${RELEASE_MANIFEST:-$OUT_DIR/release-manifest.json}}"
PROTECTION="${PROTECTION:-pyc}"

if [[ -n "$VERSION_ARG" && ! "$VERSION_ARG" =~ ^[A-Za-z0-9][A-Za-z0-9._+-]*$ ]]; then
  echo "[kernel-asset] invalid version: $VERSION_ARG" >&2
  exit 2
fi
if [[ ! "$PROTECTION" =~ ^(auto|pyarmor|pyc)$ ]]; then
  echo "[kernel-asset] invalid PROTECTION: $PROTECTION" >&2
  exit 2
fi

require_cmd "$PYTHON"
require_cmd node
require_cmd tar

echo "[kernel-asset] build: $PYTHON kernel/build_dist.py --protection $PROTECTION"
(
  cd "$ROOT"
  "$PYTHON" kernel/build_dist.py --protection "$PROTECTION"
)

if [[ ! -d "$DIST/axeuh_kernel" ]]; then
  echo "[kernel-asset] dist missing axeuh_kernel/: $DIST" >&2
  exit 1
fi
if [[ -f "$DIST/axeuh_kernel/__main__.pyc" ]]; then
  ENTRY_KIND="pyc"
elif [[ -f "$DIST/axeuh_kernel/__main__.py" ]]; then
  ENTRY_KIND="py"
else
  echo "[kernel-asset] dist missing axeuh_kernel/__main__.pyc (or .py): $DIST" >&2
  exit 1
fi
if [[ "$ENTRY_KIND" == "pyc" ]]; then
  if find "$DIST/axeuh_kernel" -name '*.py' -print -quit | grep -q .; then
    echo "[kernel-asset] pyc dist still contains plaintext .py files" >&2
    exit 1
  fi
fi
if [[ ! -f "$DIST/EULA.md" ]]; then
  echo "[kernel-asset] dist missing EULA.md: $DIST" >&2
  exit 1
fi
if [[ ! -s "$DIST/requirements.txt" ]]; then
  echo "[kernel-asset] dist missing requirements.txt: $DIST" >&2
  exit 1
fi
if grep -Eiq '^[[:space:]]*(torch|torchaudio|torchvision|torchtext)([[:space:]]*[<>=!~].*)?$' "$DIST/requirements.txt"; then
  echo "[kernel-asset] requirements.txt must not pin torch (installed separately): $DIST" >&2
  exit 1
fi
if grep -Eq '^[[:space:]]*-e([[:space:]]|$)' "$DIST/requirements.txt"; then
  echo "[kernel-asset] requirements.txt must not contain editable installs: $DIST" >&2
  exit 1
fi

VERSION="${VERSION_ARG:-${KERNEL_VERSION:-}}"
if [[ -z "$VERSION" ]]; then
  VERSION="$(json_version "$BUILD_INFO")"
fi
if [[ -z "$VERSION" ]]; then
  VERSION="$(toml_version "$KERNEL_PYPROJECT")"
fi
if [[ -z "$VERSION" ]]; then
  echo "[kernel-asset] cannot determine kernel version; pass one as the first argument" >&2
  exit 1
fi
if [[ ! "$VERSION" =~ ^[A-Za-z0-9][A-Za-z0-9._+-]*$ ]]; then
  echo "[kernel-asset] invalid version: $VERSION" >&2
  exit 2
fi

API_VERSION_VALUE="${API_VERSION:-}"
if [[ -z "$API_VERSION_VALUE" ]]; then
  API_VERSION_VALUE="$(json_api_version "$BUILD_INFO")"
fi
if [[ -z "$API_VERSION_VALUE" ]]; then
  API_VERSION_VALUE="$(source_api_version)"
fi

mkdir -p "$OUT_DIR"
TARBALL="$OUT_DIR/axeuh-kernel-$VERSION.tar.gz"
rm -f "$TARBALL" "$TARBALL.sha256"
tar -czf "$TARBALL" -C "$DIST" .

SHA256="$(sha256_of "$TARBALL")"
SIZE="$(wc -c < "$TARBALL" | tr -d '[:space:]')"
printf '%s  %s\n' "$SHA256" "$(basename "$TARBALL")" > "$TARBALL.sha256"

update_manifest "$MANIFEST" "$(basename "$TARBALL")" "$SHA256" "$SIZE" "$VERSION" "$API_VERSION_VALUE"

echo "[kernel-asset] protection: $ENTRY_KIND"
echo "[kernel-asset] tarball: $TARBALL ($SIZE bytes)"
echo "[kernel-asset] sha256: $SHA256"
echo "[kernel-asset] manifest: $MANIFEST"
echo "[kernel-asset] checksum: $TARBALL.sha256"
