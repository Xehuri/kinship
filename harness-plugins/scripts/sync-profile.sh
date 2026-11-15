#!/usr/bin/env bash
# Copy the built Kinship plugin packages into a dsh profile's node_modules.
#
# The six packages ship as local workspace packages (the bundle's dependencies
# are workspace versions, not registry versions), so `dsh plugin add` cannot
# install them from this checkout. This script is the supported update path for
# a profile that already selects `kinship-harness-plugins` in its
# `dsh.profile.bundles`.
#
# Usage:
#   scripts/sync-profile.sh [profile-name]        # default profile: web
#   DSH_HOME=/path/to/dsh-home scripts/sync-profile.sh
#   scripts/sync-profile.sh --print-profile-dir   # resolve only, change nothing
#
# It never edits the profile's package.json or config: selecting the bundle is a
# deliberate step, documented in docs/ops/dsh-production-rollout.md.
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(cd "$HERE/.." && pwd)"

PROFILE_NAME="${1:-web}"
if [ "${PROFILE_NAME}" = "--print-profile-dir" ]; then
  NAME="${2:-web}"
  printf '%s\n' "${DSH_HOME:-$HOME/.dsh}/profiles/$NAME"
  exit 0
fi

DSH_HOME_DIR="${DSH_HOME:-$HOME/.dsh}"
PROFILE="$DSH_HOME_DIR/profiles/$PROFILE_NAME"
MODULES="$PROFILE/node_modules"

if [ ! -d "$PROFILE" ]; then
  echo "[sync] no such profile: $PROFILE" >&2
  exit 1
fi
for pkg in kinship-bridge kinship-plan kinship-task-compat kinship-plan-scheduler kinship-compact; do
  if [ ! -f "$REPO/packages/$pkg/dist/index.js" ]; then
    echo "[sync] missing $REPO/packages/$pkg/dist/index.js; run: npm run build" >&2
    exit 1
  fi
done
for file in client.js index.js package.json; do
  if [ ! -f "$REPO/packages/kinship-ui/$file" ]; then
    echo "[sync] missing $REPO/packages/kinship-ui/$file" >&2
    exit 1
  fi
done

copy_pkg() {
  local name="$1" source="$REPO/packages/$1" target="$MODULES/$1"
  shift
  mkdir -p "$target"
  for entry in "$@"; do
    rm -rf "${target:?}/$entry"
    cp -a "$source/$entry" "$target/$entry"
  done
  echo "[sync] $name"
}

copy_pkg kinship-bridge dist package.json locale docs icon.svg
copy_pkg kinship-ui package.json index.js client.js locale docs icon.svg
copy_pkg kinship-plan dist package.json
copy_pkg kinship-task-compat dist package.json
copy_pkg kinship-plan-scheduler dist package.json
copy_pkg kinship-compact dist package.json

BUNDLE="$MODULES/kinship-harness-plugins"
mkdir -p "$BUNDLE/presets"
for entry in package.json cordis.patch.yml locale docs icon.svg; do
  rm -rf "${BUNDLE:?}/$entry"
  cp -a "$REPO/$entry" "$BUNDLE/$entry"
done
rm -f "$BUNDLE/presets/kinship.patch.yml"
cp -a "$REPO/presets/kinship.patch.yml" "$BUNDLE/presets/kinship.patch.yml"
rm -f "$BUNDLE/index.js"
echo "[sync] kinship-harness-plugins"

echo "[sync] profile: $PROFILE"
echo "[sync] restart the dsh service for the profile to load the new modules (or let HMR pick it up)"
