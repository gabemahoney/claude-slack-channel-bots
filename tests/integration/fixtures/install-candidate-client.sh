#!/usr/bin/env bash
# Called after test-1 installs the CSCB tarball; affects this container only.
# A private nested dependency wins over bun's hoisted published client.
set -euo pipefail
[[ -f /etc/cscb-ci-image && $# == 1 ]] || exit 70
record=/opt/agent-director/client/release.json
[[ "$(jq -r '.candidate_overlay // false' "${record}")" == true ]] || exit 0
target=$1/node_modules/agent-director
[[ "$1" == /test-repo/node_modules/claude-slack-channel-bots ]] || exit 70
[[ ! -e "${target}" && ! -L "${target}" ]] || rm -rf "${target}"
mkdir -p "${target}"
tar -xzf /opt/agent-director/client/candidate.tgz -C "${target}" --strip-components=1 --no-same-owner
echo 'candidate AD client installed privately for CSCB; shipped dependency pin unchanged'
