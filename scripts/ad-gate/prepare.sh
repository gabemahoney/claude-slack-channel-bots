#!/usr/bin/env bash
# prepare.sh — fetch every input of one ad-gate job context into its inputs
# directory, so the job's container needs no network and no secret.
# scripts/ad-gate/ad-gate.ts runs it once per AD role (candidate, reference).
#
# The job: the currently shipped claude-slack-channel-bots (CSCB) npm package
# against a candidate agent-director (AD) build, running CSCB's no-model
# integration scripts (stub `claude`, loopback Slack stub, the REAL candidate
# AD binary and admin tool, CSCB's own pinned AD npm client).
#
# Usage (from anywhere):
#   prepare.sh --inputs DIR [--cscb-version VERSION] --ad-tag vX.Y.Z
#   prepare.sh --inputs DIR [--cscb-version VERSION] --ad-dist DIR
#              (--ad-install-sh FILE | --ad-commit SHA) [--ad-client-tgz FILE]
#
#   --inputs DIR     the context's inputs directory, which must be named
#                    `inputs`; it is emptied first.
#   --cscb-version   the published CSCB version to test; default: npm's latest.
#                    Its tests come from the CSCB checkout's tag v<VERSION>.
#   --ad-tag         a published AD release: agent-director-linux-amd64,
#                    agent-director-admin-linux-amd64 and the client tgz from
#                    the release's public download URLs, checked against its
#                    SHA256SUMS; install.sh from the AD checkout at the tag.
#   --ad-dist        an unpublished AD build: a directory holding either
#                    agent-director-linux-amd64 + agent-director-admin-linux-amd64
#                    (`make release-binaries`) or agent-director + agent-director-admin
#                    (`make build`, bin/). When it holds a SHA256SUMS, every
#                    file taken from it must match it.
#   --ad-install-sh  that build's skills/install-agent-director/install.sh.
#   --ad-commit      that build's commit: recorded, and install.sh comes from
#                    the AD checkout at it when --ad-install-sh is not given.
#   --ad-client-tgz  that build's npm client tarball (`npm pack` of
#                    pkg/ts-bun-client). Optional; recorded and smoke-checked
#                    only: shipped CSCB pins its own client version exactly.
#   --ad-expected-version
#                    the version the AD binary must report (the image build checks it).
#   --ad-role cand|ref
#                    recorded as the manifest's ad_role.
#   --cscb-repo DIR  CSCB checkout (read only); default: the checkout holding this script.
#   --ad-repo DIR    AD checkout (read only); default: the main checkout.
#
# Downloads are public only (registry.npmjs.org, github.com release
# downloads); no token is read or passed. Repos are read with git archive /
# git cat-file only.
set -euo pipefail

INPUTS=''
CSCB_REPO="$(git -C "$(dirname "$0")" rev-parse --show-toplevel 2> /dev/null || true)"
AD_REPO="${HOME}/projects/agent-director-project/agent-director-main"
AD_GH="https://github.com/gabemahoney/agent-director/releases/download"
AD_010_VERSION=0.10.0
CSCB_010_VERSION=0.10.0

CSCB_VERSION=''
AD_TAG=''
AD_DIST=''
AD_INSTALL_SH=''
AD_COMMIT=''
AD_CLIENT_TGZ=''
AD_EXPECTED_VERSION=''
AD_ROLE=''

die() { echo "prepare.sh: $*" >&2; exit 2; }

while (( $# )); do
    case "$1" in
        --inputs) INPUTS="${2:?}"; shift 2 ;;
        --cscb-version) CSCB_VERSION="${2:?}"; shift 2 ;;
        --ad-tag) AD_TAG="${2:?}"; shift 2 ;;
        --ad-dist) AD_DIST="${2:?}"; shift 2 ;;
        --ad-install-sh) AD_INSTALL_SH="${2:?}"; shift 2 ;;
        --ad-commit) AD_COMMIT="${2:?}"; shift 2 ;;
        --ad-client-tgz) AD_CLIENT_TGZ="${2:?}"; shift 2 ;;
        --ad-expected-version) AD_EXPECTED_VERSION="${2:?}"; shift 2 ;;  # ad-gate-0172: checked by the image build
        --ad-role) AD_ROLE="${2:?}"; shift 2 ;;
        --cscb-repo) CSCB_REPO="${2:?}"; shift 2 ;;
        --ad-repo) AD_REPO="${2:?}"; shift 2 ;;
        *) die "unknown argument $1" ;;
    esac
done
[[ -n "${INPUTS}" ]] || die "--inputs DIR is required"
[[ "${INPUTS%/}" == */inputs || "${INPUTS%/}" == inputs ]] || die "--inputs '${INPUTS}' is not a directory named inputs"
if [[ -n "${AD_TAG}" && -n "${AD_DIST}" ]] || [[ -z "${AD_TAG}" && -z "${AD_DIST}" ]]; then
    die "give exactly one of --ad-tag and --ad-dist"
fi
if [[ -n "${AD_DIST}" && -z "${AD_INSTALL_SH}" && -z "${AD_COMMIT}" ]]; then
    die "--ad-dist needs --ad-install-sh or --ad-commit"
fi
[[ -z "${AD_COMMIT}" || "${AD_COMMIT}" =~ ^[0-9a-f]{7,40}$ ]] || die "--ad-commit '${AD_COMMIT}' is not a commit hash"
[[ -z "${AD_ROLE}" || "${AD_ROLE}" == cand || "${AD_ROLE}" == ref ]] || die "--ad-role '${AD_ROLE}' is not cand or ref"

rm -rf "${INPUTS}"
mkdir -p "${INPUTS}/cscb" "${INPUTS}/cscb-src" "${INPUTS}/ad" "${INPUTS}/fixtures"

# --- CSCB: the shipped package and its tests at the same tag ---------------
[[ -n "${CSCB_VERSION}" ]] || CSCB_VERSION="$(npm view claude-slack-channel-bots@latest version)"
[[ "${CSCB_VERSION}" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || die "CSCB version '${CSCB_VERSION}' is not x.y.z"
npm pack --ignore-scripts --silent --pack-destination "${INPUTS}/cscb" "claude-slack-channel-bots@${CSCB_VERSION}" >/dev/null
CSCB_TGZ="${INPUTS}/cscb/claude-slack-channel-bots-${CSCB_VERSION}.tgz"
[[ -s "${CSCB_TGZ}" ]] || die "npm pack wrote no ${CSCB_TGZ}"
git -C "${CSCB_REPO}" rev-parse -q --verify "refs/tags/v${CSCB_VERSION}" >/dev/null \
    || die "the CSCB checkout ${CSCB_REPO} has no tag v${CSCB_VERSION}"
git -C "${CSCB_REPO}" archive --format=tar "v${CSCB_VERSION}" \
    tests testplans docker/entrypoint.sh docker/ad-client-check.sh | tar -x -C "${INPUTS}/cscb-src"
CSCB_COMMIT="$(git -C "${CSCB_REPO}" rev-parse "v${CSCB_VERSION}^{commit}")"
PKG_VERSION="$(tar -xOzf "${CSCB_TGZ}" package/package.json | jq -r .version)"
[[ "${PKG_VERSION}" == "${CSCB_VERSION}" ]] || die "the packed CSCB is ${PKG_VERSION}, not ${CSCB_VERSION}"
AD_PIN="$(tar -xOzf "${CSCB_TGZ}" package/package.json | jq -r '.dependencies["agent-director"]')"
[[ "${AD_PIN}" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || die "CSCB ${CSCB_VERSION} pins agent-director '${AD_PIN}', not an exact version"

# The client CSCB resolves (its exact pin), as the client check's tarball.
npm pack --ignore-scripts --silent --pack-destination "${INPUTS}/fixtures" "agent-director@${AD_PIN}" >/dev/null
[[ -s "${INPUTS}/fixtures/agent-director-${AD_PIN}.tgz" ]] || die "npm pack agent-director@${AD_PIN} wrote nothing"

# --- The candidate AD --------------------------------------------------------
fetch_release_asset() { # tag name dest
    curl -fsSL --retry 3 -o "$3" "${AD_GH}/$1/$2" || die "could not download $2 from release $1"
}
if [[ -n "${AD_TAG}" ]]; then
    [[ "${AD_TAG}" =~ ^v[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.]+)?$ ]] || die "--ad-tag '${AD_TAG}' is not vX.Y.Z"
    AD_CAND_VERSION="${AD_TAG#v}"
    fetch_release_asset "${AD_TAG}" SHA256SUMS "${INPUTS}/ad/SHA256SUMS"
    fetch_release_asset "${AD_TAG}" agent-director-linux-amd64 "${INPUTS}/ad/agent-director"
    fetch_release_asset "${AD_TAG}" agent-director-admin-linux-amd64 "${INPUTS}/ad/agent-director-admin"
    fetch_release_asset "${AD_TAG}" "agent-director-${AD_CAND_VERSION}.tgz" "${INPUTS}/ad/client.tgz"
    for pair in agent-director:agent-director-linux-amd64 agent-director-admin:agent-director-admin-linux-amd64 \
        "client.tgz:agent-director-${AD_CAND_VERSION}.tgz"; do
        local_name="${pair%%:*}"; asset="${pair#*:}"
        want="$(awk -v a="${asset}" '$2 == a || $2 == "*"a {print $1}' "${INPUTS}/ad/SHA256SUMS")"
        [[ -n "${want}" ]] || die "SHA256SUMS of ${AD_TAG} lists no ${asset}"
        got="$(sha256sum "${INPUTS}/ad/${local_name}" | cut -d' ' -f1)"
        [[ "${got}" == "${want}" ]] || die "${asset} has SHA-256 ${got}, SHA256SUMS says ${want}"
    done
    git -C "${AD_REPO}" cat-file -p "${AD_TAG}:skills/install-agent-director/install.sh" > "${INPUTS}/ad/install.sh" \
        || die "the AD checkout ${AD_REPO} has no ${AD_TAG}:skills/install-agent-director/install.sh"
    [[ -n "${AD_COMMIT}" ]] || AD_COMMIT="$(git -C "${AD_REPO}" rev-parse "${AD_TAG}^{commit}")"
    AD_SOURCE="release ${AD_TAG}"
else
    # dist_sum <file name>: the SHA-256 the build's SHA256SUMS lists for it, empty without one.
    dist_sum() {
        [[ -f "${AD_DIST}/SHA256SUMS" ]] || return 0
        awk -v a="$1" '$2 == a || $2 == "*"a {print $1}' "${AD_DIST}/SHA256SUMS"
    }
    # check_dist <local file> <name in the build>: matches SHA256SUMS when the build has one.
    check_dist() {
        [[ -f "${AD_DIST}/SHA256SUMS" ]] || return 0
        local want got
        want="$(dist_sum "$2")"
        [[ -n "${want}" ]] || die "${AD_DIST}/SHA256SUMS lists no $2"
        got="$(sha256sum "$1" | cut -d' ' -f1)"
        [[ "${got}" == "${want}" ]] || die "$2 has SHA-256 ${got}, ${AD_DIST}/SHA256SUMS says ${want}"
    }
    for b in agent-director agent-director-admin; do
        if [[ -f "${AD_DIST}/${b}-linux-amd64" ]]; then cp "${AD_DIST}/${b}-linux-amd64" "${INPUTS}/ad/${b}"
            check_dist "${INPUTS}/ad/${b}" "${b}-linux-amd64"
        elif [[ -f "${AD_DIST}/${b}" ]]; then cp "${AD_DIST}/${b}" "${INPUTS}/ad/${b}"
            check_dist "${INPUTS}/ad/${b}" "${b}"
        else die "${AD_DIST} holds neither ${b}-linux-amd64 nor ${b}"
        fi
    done
    if [[ -n "${AD_INSTALL_SH}" ]]; then
        cp "${AD_INSTALL_SH}" "${INPUTS}/ad/install.sh"
    else
        git -C "${AD_REPO}" cat-file -p "${AD_COMMIT}:skills/install-agent-director/install.sh" > "${INPUTS}/ad/install.sh" \
            || die "the AD checkout ${AD_REPO} has no ${AD_COMMIT}:skills/install-agent-director/install.sh"
    fi
    if [[ -n "${AD_CLIENT_TGZ}" ]]; then
        cp "${AD_CLIENT_TGZ}" "${INPUTS}/ad/client.tgz"
        check_dist "${INPUTS}/ad/client.tgz" "${AD_CLIENT_TGZ##*/}"
    fi
    AD_CAND_VERSION="${AD_EXPECTED_VERSION}"
    AD_SOURCE="local build ${AD_DIST}"
fi
chmod 0755 "${INPUTS}/ad/agent-director" "${INPUTS}/ad/agent-director-admin" "${INPUTS}/ad/install.sh"
# ad-gate-0172: this host has no `file`; read the ELF header instead (ELF64, little-endian, EM_X86_64).
python3 -I -c 'import sys; h = open(sys.argv[1], "rb").read(20); sys.exit(0 if h[:4] == b"\x7fELF" and h[4] == 2 and h[5] == 1 and int.from_bytes(h[18:20], "little") == 62 else 1)' \
    "${INPUTS}/ad/agent-director" || die "the candidate agent-director is not a linux-amd64 ELF"

# --- Fixtures the harness expects from the CSCB CI base image ---------------
fetch_release_asset "v${AD_010_VERSION}" agent-director-linux-amd64 "${INPUTS}/fixtures/agent-director-${AD_010_VERSION}"
chmod 0755 "${INPUTS}/fixtures/agent-director-${AD_010_VERSION}"
npm pack --ignore-scripts --silent --pack-destination "${INPUTS}/fixtures" "agent-director@${AD_010_VERSION}" >/dev/null
npm pack --ignore-scripts --silent --pack-destination "${INPUTS}/fixtures" "claude-slack-channel-bots@${CSCB_010_VERSION}" >/dev/null

# ad-gate-0172: CSCB v0.18.2's image adds the legacy displayed-state fixture
# (test-43): release v0.17.0's binary and admin tool, checked against that
# release's SHA256SUMS here and against CSCB's own pins in the image build,
# plus install.sh from the AD checkout at v0.17.0.
LEGACY_TAG=v0.17.0
mkdir -p "${INPUTS}/fixtures/legacy"
fetch_release_asset "${LEGACY_TAG}" SHA256SUMS "${INPUTS}/fixtures/legacy/SHA256SUMS"
fetch_release_asset "${LEGACY_TAG}" agent-director-linux-amd64 "${INPUTS}/fixtures/legacy/agent-director"
fetch_release_asset "${LEGACY_TAG}" agent-director-admin-linux-amd64 "${INPUTS}/fixtures/legacy/agent-director-admin"
for pair in agent-director:agent-director-linux-amd64 agent-director-admin:agent-director-admin-linux-amd64; do
    local_name="${pair%%:*}"; asset="${pair#*:}"
    want="$(awk -v a="${asset}" '$2 == a || $2 == "*"a {print $1}' "${INPUTS}/fixtures/legacy/SHA256SUMS")"
    [[ -n "${want}" ]] || die "SHA256SUMS of ${LEGACY_TAG} lists no ${asset}"
    got="$(sha256sum "${INPUTS}/fixtures/legacy/${local_name}" | cut -d' ' -f1)"
    [[ "${got}" == "${want}" ]] || die "${LEGACY_TAG} ${asset} has SHA-256 ${got}, SHA256SUMS says ${want}"
done
git -C "${AD_REPO}" cat-file -p "${LEGACY_TAG}:skills/install-agent-director/install.sh" > "${INPUTS}/fixtures/legacy/install.sh" \
    || die "the AD checkout ${AD_REPO} has no ${LEGACY_TAG}:skills/install-agent-director/install.sh"
chmod 0755 "${INPUTS}/fixtures/legacy/agent-director" "${INPUTS}/fixtures/legacy/agent-director-admin" "${INPUTS}/fixtures/legacy/install.sh"

# --- The manifest: names, versions and hashes only --------------------------
sha() { sha256sum "$1" | cut -d' ' -f1; }
jq -n \
    --arg cscb_version "${CSCB_VERSION}" --arg cscb_commit "${CSCB_COMMIT}" --arg cscb_sha "$(sha "${CSCB_TGZ}")" \
    --arg ad_pin "${AD_PIN}" --arg ad_source "${AD_SOURCE}" --arg ad_version "${AD_CAND_VERSION}" \
    --arg ad_sha "$(sha "${INPUTS}/ad/agent-director")" --arg ad_admin_sha "$(sha "${INPUTS}/ad/agent-director-admin")" \
    --arg ad_install_sha "$(sha "${INPUTS}/ad/install.sh")" \
    --arg ad_client_sha "$( [[ -f "${INPUTS}/ad/client.tgz" ]] && sha "${INPUTS}/ad/client.tgz" || true)" \
    --arg ad_commit "${AD_COMMIT}" --arg ad_role "${AD_ROLE}" \
    '{cscb: {version: $cscb_version, tests_commit: $cscb_commit, tarball_sha256: $cscb_sha, ad_client_pin: $ad_pin},
      candidate: ({source: $ad_source, expected_version: $ad_version}
                  + (if $ad_commit == "" then {} else {commit: $ad_commit} end)
                  + {binary_sha256: $ad_sha, admin_sha256: $ad_admin_sha, installer_sha256: $ad_install_sha,
                     client_tgz_sha256: $ad_client_sha})}
     + (if $ad_role == "" then {} else {ad_role: $ad_role} end)' > "${INPUTS}/manifest.json"
cp "${CSCB_TGZ}" "${INPUTS}/cscb/package.tgz"
rm -f "${CSCB_TGZ}"
cat "${INPUTS}/manifest.json"
echo "prepare.sh: inputs ready in ${INPUTS} ($(du -sh "${INPUTS}" | cut -f1))"
