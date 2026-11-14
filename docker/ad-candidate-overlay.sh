#!/usr/bin/env bash
# Runs only while building the disposable candidate test image. The dist is
# trusted executable input, supplied explicitly by the caller, mounted read-only.
set -euo pipefail
[[ -f /etc/cscb-ci-image && $# == 1 ]] || exit 70
dist=$1
root=/opt/agent-director
installer_version=$(jq -er '.installer_version // .version' "${root}/client/release.json")
[[ -f "${dist}/agent-director" && -f "${dist}/client.tgz" ]] || {
    echo 'ERROR: candidate dist requires agent-director and client.tgz' >&2; exit 1;
}
install -m 0755 "${dist}/agent-director" "${root}/bin/agent-director"
# Optional matching operator/installer artifacts; otherwise keep the base's
# versions and their recorded digests. Scenario installs still run the real
# installer and all migrations, rather than fabricating a store schema.
if [[ -f "${dist}/agent-director-admin" ]]; then
    install -m 0755 "${dist}/agent-director-admin" "${root}/admin/agent-director-admin"
fi
if [[ -f "${dist}/install.sh" ]]; then
    install -m 0755 "${dist}/install.sh" "${root}/install/install.sh"
fi
install -m 0644 "${dist}/client.tgz" "${root}/client/candidate.tgz"
scratch=$(mktemp -d)
trap 'rm -rf "${scratch}"' EXIT
tar -xzf "${root}/client/candidate.tgz" -C "${scratch}" --no-same-owner
[[ "$(jq -r .name "${scratch}/package/package.json")" == agent-director ]] || exit 1
client_version=$(jq -er '.version | strings' "${scratch}/package/package.json")
version_json=$("${root}/bin/agent-director" version)
version=$(jq -er '.version | strings' <<< "${version_json}")
[[ ! -f "${dist}/install.sh" ]] || installer_version="${version}"
commit=$(jq -er '.commit | strings | select(length > 0)' <<< "${version_json}")
release_re='^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?(\+[0-9A-Za-z.-]+)?$'
[[ "${version}" =~ ${release_re} && "${version}" != 0.0.0* && "${client_version}" =~ ${release_re} ]] || {
    echo 'ERROR: candidate binary/client must have real version stamps' >&2; exit 1;
}
# Preserve exact bytes and record identities for every runtime/client check.
jq --arg version "${version}" --arg commit "${commit}" --arg client_version "${client_version}" \
    --arg installer_version "${installer_version}" \
    --arg binary_sha256 "$(sha256sum "${root}/bin/agent-director" | cut -d' ' -f1)" \
    --arg admin_sha256 "$(sha256sum "${root}/admin/agent-director-admin" | cut -d' ' -f1)" \
    --arg installer_sha256 "$(sha256sum "${root}/install/install.sh" | cut -d' ' -f1)" \
    --arg client_tarball "${root}/client/candidate.tgz" \
    --arg client_tarball_sha256 "$(sha256sum "${root}/client/candidate.tgz" | cut -d' ' -f1)" \
    '. + {candidate_overlay:true, version:$version, commit:$commit, client_version:$client_version, installer_version:$installer_version,
      binary_sha256:$binary_sha256, admin_sha256:$admin_sha256, installer_sha256:$installer_sha256,
      client_tarball:$client_tarball, client_tarball_sha256:$client_tarball_sha256}' \
    "${root}/client/release.json" > "${scratch}/release.json"
install -m 0644 "${scratch}/release.json" "${root}/client/release.json"
echo "candidate AD overlay: runtime=${version} commit=${commit} client=${client_version} (local dist)"
