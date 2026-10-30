#!/usr/bin/env bash
# Fail when a live client/doc reference still points at the retired 8769 port.
# Historical mentions must be annotated with 已废弃 / 历史 / "was 8769" on the same line.
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT" || exit 1

targets=()
for path in app/src/main/java desktop/src docs README.md README.zh-CN.md; do
    [ -e "$path" ] && targets+=("$path")
done

if [ "${#targets[@]}" -eq 0 ]; then
    echo "ERROR: none of the expected port-check targets exist under $ROOT" >&2
    exit 1
fi

violations="$(grep -rn \
    --binary-files=without-match \
    --exclude-dir=.git \
    --exclude-dir=node_modules \
    --exclude-dir=dist \
    --exclude-dir=build \
    '8769' "${targets[@]}" 2>/dev/null | grep -Ev '已废弃|历史|was 8769' || true)"

if [ -n "$violations" ]; then
    echo "ERROR: unannotated 8769 port references found (use 8768 or annotate as 已废弃/历史):" >&2
    echo "$violations" >&2
    exit 1
fi

echo "OK: no unannotated 8769 references in ${targets[*]}"
exit 0
