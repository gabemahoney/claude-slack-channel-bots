#!/bin/bash
# Native programs only; never put these directories on PATH (b.omv SR-14.3).
set -euo pipefail
[[ -e /etc/cscb-ci-image ]] || { echo 'ERROR: native agent install requires the CI image' >&2; exit 2; }
release_root=https://storage.googleapis.com/claude-code-dist-86c565f3-f756-42ad-8dfa-d59b1c096819/claude-code-releases
if (( $# == 0 )); then set -- 2.1.280 2.1.296; fi
for version in "$@"; do
    # Default versions are supplied as separate arguments by the Dockerfile.
    [[ "$version" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || exit 64
    dir="/opt/claude-code/${version}"
    mkdir -p "$dir"
    curl -fsSL "$release_root/$version/manifest.json" -o "$dir/manifest.json"
    checksum=$(jq -er '.platforms["linux-x64"].checksum' "$dir/manifest.json")
    curl -fsSL "$release_root/$version/linux-x64/claude" -o "$dir/claude"
    printf '%s  %s\n' "$checksum" "$dir/claude" | sha256sum --check --status
    chmod 0755 "$dir/claude"
    actual=$(DISABLE_AUTOUPDATER=1 "$dir/claude" --version)
    [[ "${actual%% *}" == "$version" ]] || { echo "ERROR: Claude version mismatch: $version" >&2; exit 1; }
    printf 'Claude native %s\n' "$actual"
done
