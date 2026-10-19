#!/bin/bash
# npm's platform package holds the native ELF, unlike its JS CLI launcher.
set -euo pipefail
[[ -e /etc/cscb-ci-image ]] || exit 2
version=0.159.2
dir="/opt/codex/$version"
stage=$(mktemp -d)
trap 'rm -rf "$stage"' EXIT
npm pack --ignore-scripts --pack-destination "$stage" "@openai/codex@$version-linux-x64" > /dev/null
tar -xzf "$stage/openai-codex-$version-linux-x64.tgz" -C "$stage"
mkdir -p "$dir"
native="$stage/package/vendor/x86_64-unknown-linux-musl/bin/codex"
if [[ ! -f "$native" ]]; then
    native="$stage/package/vendor/x86_64-unknown-linux-musl/codex/codex"
fi
file "$native" | grep -q ELF
install -m 0755 "$native" "$dir/codex"
actual=$("$dir/codex" --version)
[[ "$actual" == "codex-cli $version" ]] || { echo 'ERROR: Codex native version mismatch' >&2; exit 1; }
printf 'Codex native %s\n' "$actual"
