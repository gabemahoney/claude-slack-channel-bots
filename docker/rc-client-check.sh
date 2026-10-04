#!/usr/bin/env bash
# docker/rc-client-check.sh — the client-under-test check of the cscb-ci
# images: swaps agent-director's release-candidate client into an installed
# package and checks that the package resolves it and that it pairs with the
# image's agent-director binary.
#
# In the image: /opt/agent-director-rc/check/rc-client-check.sh, off PATH
# (docker/Dockerfile.test.base copies it there; ci-live/lib/rc-client.ts
# exports the path as RC_CLIENT_CHECK). It runs an agent-director binary
# (Client.create()'s version probe), so it runs only in a cscb-ci image: the
# first thing it does is refuse when /etc/cscb-ci-image is absent.
#
# Usage:
#   rc-client-check.sh --package <dir>
#       <dir> is an installed package. Find the agent-director client it
#       resolves (a bun install may hoist it out of <dir>/node_modules),
#       replace that directory with the release candidate's unpacked client,
#       then check it.
#   rc-client-check.sh --client <dir>
#       <dir> is an agent-director client. Check it only; nothing changes.
#
# The release record /opt/agent-director-rc/client/release.json names the
# release candidate's version, commit, client tarball and its SHA-256. The
# check, in order, stopping at the first failure:
#   1 content        the client tarball has the record's SHA-256, and the
#                    client's files equal that tarball's;
#   2 exports        the client exports ErrTmuxKillFailed,
#                    ErrTmuxUnresponsive and ErrTmuxSessionConflict, each an
#                    AgentDirectorError class;
#   3 binary         the first agent-director on PATH reports the record's
#                    version and commit;
#   4 floor          that version (major.minor.patch) is at or above the
#                    client's dist/version-floor.json min_binary_version;
#   5 client-create  Client.create(), imported from the client's entry point,
#                    reports a binaryVersion equal to that version.
# The release-candidate client and the published 0.10.0 client both carry
# package version 0.10.0, so no package-version comparison is made.
#
# Exit codes:
#   0  passed: one line on stdout,
#        rc-client check passed: <client dir> is the release-candidate client (tarball sha256 <sha>); agent-director <version> (<commit>) at <binary>; client floor <floor>
#   1  a check or the swap failed: one line on stderr,
#        ERROR: rc-client check <step>: <what differs>
#   2  usage error: one ERROR: line on stderr; nothing changes
#   3  refused (no /etc/cscb-ci-image): one ERROR: line on stderr; nothing
#      changes
set -euo pipefail

MARKER=/etc/cscb-ci-image
RELEASE_RECORD=/opt/agent-director-rc/client/release.json
RC_CLIENT_COPY=/opt/agent-director-rc/client/agent-director
PHASE1_CLASSES='ErrTmuxKillFailed ErrTmuxUnresponsive ErrTmuxSessionConflict'

if [ ! -e "${MARKER}" ]; then
    echo "ERROR: rc-client-check.sh: ${MARKER} is absent: this check runs only in a cscb-ci image (it runs agent-director); refusing to run" >&2
    exit 3
fi

usage_error() {
    echo "ERROR: rc-client-check.sh: $1 (usage: rc-client-check.sh --package <dir> | --client <dir>)" >&2
    exit 2
}

[ "$#" -eq 2 ] || usage_error "expected two arguments, got $#"
MODE="$1"
TARGET="$2"
case "${MODE}" in
    --package | --client) ;;
    *) usage_error "unknown mode ${MODE}" ;;
esac
[ -d "${TARGET}" ] || usage_error "${TARGET} is not a directory"
TARGET=$(realpath "${TARGET}")

# fail STEP TEXT: the one ERROR line, then exit 1.
fail() {
    echo "ERROR: rc-client check $1: $2" >&2
    exit 1
}

SCRATCH=$(mktemp -d)
SWAP_DIR=''
cleanup() {
    rm -rf "${SCRATCH}"
    if [ -n "${SWAP_DIR}" ]; then rm -rf "${SWAP_DIR}"; fi
}
trap cleanup EXIT

# first_line FILE: the file's first non-empty line, or "(no output)".
first_line() {
    local line
    line=$(grep -m 1 -v '^[[:space:]]*$' "$1" || true)
    printf '%s' "${line:-(no output)}"
}

# --- The release record ---------------------------------------------------
[ -f "${RELEASE_RECORD}" ] || fail 'release record' "${RELEASE_RECORD} is missing"
record_field() {
    jq -er --arg k "$1" '.[$k] | strings | select(. != "")' "${RELEASE_RECORD}" \
        || fail 'release record' "${RELEASE_RECORD} has no string $1 field"
}
RC_VERSION=$(record_field version)
RC_COMMIT=$(record_field commit)
RC_TGZ=$(record_field client_tarball)
RC_TGZ_SHA256=$(record_field client_tarball_sha256)

# resolve_from DIR: the file the specifier "agent-director" resolves to from
# DIR, as the package's own imports resolve it (bun's resolver).
resolve_from() {
    if ! (cd / && RESOLVE_FROM="$1" bun --no-install -e \
        'process.stdout.write(Bun.resolveSync("agent-director", process.env.RESOLVE_FROM))') \
        > "${SCRATCH}/resolve.out" 2> "${SCRATCH}/resolve.err"; then
        fail resolve "the package at $1 resolves no agent-director client: $(first_line "${SCRATCH}/resolve.err")"
    fi
    cat "${SCRATCH}/resolve.out"
}

# client_root FILE: the nearest directory above FILE holding the
# agent-director package.json.
client_root() {
    local d
    case "$1" in
        /*) ;;
        *) fail resolve "the resolved entry point '$1' is not an absolute path" ;;
    esac
    d=$(dirname "$1")
    while [ "${d}" != / ]; do
        if [ -f "${d}/package.json" ] && [ "$(jq -r '.name' "${d}/package.json" 2>/dev/null)" = agent-director ]; then
            realpath "${d}"
            return 0
        fi
        d=$(dirname "${d}")
    done
    fail resolve "no agent-director package.json above $1"
}

# --- Which client --------------------------------------------------------
if [ "${MODE}" = --package ]; then
    [ -f "${TARGET}/package.json" ] || usage_error "${TARGET} holds no package.json"
    ENTRY=$(resolve_from "${TARGET}")
    CLIENT_DIR=$(client_root "${ENTRY}")

    # The swap: the release candidate's unpacked client replaces the resolved
    # directory whole (a copy beside it, then a rename), so no file of the
    # previous client is written through (bun's install may hard-link them to
    # its cache).
    [ -f "${RC_CLIENT_COPY}/package.json" ] || fail swap "the release candidate's unpacked client ${RC_CLIENT_COPY} is missing"
    SWAP_DIR=$(mktemp -d "$(dirname "${CLIENT_DIR}")/.agent-director-rc-swap.XXXXXX") \
        || fail swap "cannot write beside ${CLIENT_DIR}"
    cp -R "${RC_CLIENT_COPY}/." "${SWAP_DIR}/" || fail swap "cannot copy ${RC_CLIENT_COPY} beside ${CLIENT_DIR}"
    chmod 0755 "${SWAP_DIR}"
    rm -rf "${CLIENT_DIR}" || fail swap "cannot remove ${CLIENT_DIR}"
    mv "${SWAP_DIR}" "${CLIENT_DIR}" || fail swap "cannot move the release candidate's client into ${CLIENT_DIR}"
    SWAP_DIR=''

    ENTRY=$(resolve_from "${TARGET}")
    RESOLVED_DIR=$(client_root "${ENTRY}")
    [ "${RESOLVED_DIR}" = "${CLIENT_DIR}" ] \
        || fail resolve "after the swap the package at ${TARGET} resolves the client at ${RESOLVED_DIR}, not ${CLIENT_DIR}"
else
    CLIENT_DIR="${TARGET}"
    [ -f "${CLIENT_DIR}/package.json" ] || fail resolve "${CLIENT_DIR} holds no package.json"
    ENTRY_REL=$(jq -er '(.exports["."] | if type == "object" then (.import // .default) else . end) // .main | strings' "${CLIENT_DIR}/package.json") \
        || fail resolve "${CLIENT_DIR}/package.json names no entry point"
    ENTRY=$(realpath -m "${CLIENT_DIR}/${ENTRY_REL}")
    [ -f "${ENTRY}" ] || fail resolve "the entry point ${ENTRY} is missing"
fi

# --- 1 content -----------------------------------------------------------
[ -f "${RC_TGZ}" ] || fail '1 (content)' "the release candidate's client tarball ${RC_TGZ} is missing"
TGZ_SHA256=$(sha256sum "${RC_TGZ}" | cut -d' ' -f1)
[ "${TGZ_SHA256}" = "${RC_TGZ_SHA256}" ] \
    || fail '1 (content)' "${RC_TGZ} has SHA-256 ${TGZ_SHA256}, not the release record's ${RC_TGZ_SHA256}"
mkdir "${SCRATCH}/tarball"
tar -xzf "${RC_TGZ}" -C "${SCRATCH}/tarball" --strip-components=1 --no-same-owner \
    || fail '1 (content)' "cannot unpack ${RC_TGZ}"
DIFFS=$(diff -rq --no-dereference "${SCRATCH}/tarball" "${CLIENT_DIR}" || true)
if [ -n "${DIFFS}" ]; then
    FIRST=$(printf '%s\n' "${DIFFS}" | head -n 1)
    FIRST=${FIRST//"${SCRATCH}/tarball"/<tarball>}
    fail '1 (content)' "the client at ${CLIENT_DIR} is not the release candidate's client: $(printf '%s\n' "${DIFFS}" | wc -l) difference(s) from ${RC_TGZ}, first: ${FIRST}"
fi

# --- 2 exports -----------------------------------------------------------
if ! (cd / && CLIENT_ENTRY="${ENTRY}" PHASE1_CLASSES="${PHASE1_CLASSES}" bun --no-install -e '
const m = await import(process.env.CLIENT_ENTRY)
const base = m.AgentDirectorError
const missing = process.env.PHASE1_CLASSES.split(" ").filter(
  (n) => typeof m[n] !== "function" || typeof base !== "function" || !(m[n].prototype instanceof base),
)
process.stdout.write(missing.join(" "))
') > "${SCRATCH}/exports.out" 2> "${SCRATCH}/exports.err"; then
    fail '2 (exports)' "cannot import the client entry point ${ENTRY}: $(first_line "${SCRATCH}/exports.err")"
fi
MISSING=$(cat "${SCRATCH}/exports.out")
[ -z "${MISSING}" ] \
    || fail '2 (exports)' "the client at ${CLIENT_DIR} does not export ${MISSING} as AgentDirectorError classes"

# --- 3 binary ------------------------------------------------------------
BIN=$(command -v agent-director) || fail '3 (binary)' "no agent-director binary on PATH"
"${BIN}" version > "${SCRATCH}/version.out" 2> "${SCRATCH}/version.err" \
    || fail '3 (binary)' "the agent-director binary ${BIN}: version failed: $(first_line "${SCRATCH}/version.err")"
BIN_VERSION=$(jq -ner 'input | .version | strings' "${SCRATCH}/version.out") \
    || fail '3 (binary)' "the agent-director binary ${BIN}: version printed no JSON object with a string version field"
BIN_COMMIT=$(jq -ner 'input | .commit | strings' "${SCRATCH}/version.out") \
    || fail '3 (binary)' "the agent-director binary ${BIN}: version printed no JSON object with a string commit field"
if [ "${BIN_VERSION}" != "${RC_VERSION}" ] || [ "${BIN_COMMIT}" != "${RC_COMMIT}" ]; then
    fail '3 (binary)' "the first agent-director binary on PATH, ${BIN}, reports version ${BIN_VERSION} (${BIN_COMMIT}), not the release candidate's ${RC_VERSION} (${RC_COMMIT})"
fi

# --- 4 floor -------------------------------------------------------------
FLOOR_FILE="${CLIENT_DIR}/dist/version-floor.json"
FLOOR=$(jq -er '.min_binary_version | strings' "${FLOOR_FILE}" 2>/dev/null) \
    || fail '4 (floor)' "${FLOOR_FILE} has no string min_binary_version"
CORE_RE='^([0-9]+)\.([0-9]+)\.([0-9]+)([-+].*)?$'
[[ "${FLOOR}" =~ ${CORE_RE} ]] || fail '4 (floor)' "the client's floor ${FLOOR} is not major.minor.patch"
FLOOR_PARTS=("${BASH_REMATCH[1]}" "${BASH_REMATCH[2]}" "${BASH_REMATCH[3]}")
[[ "${BIN_VERSION}" =~ ${CORE_RE} ]] || fail '4 (floor)' "the agent-director binary's version ${BIN_VERSION} is not major.minor.patch"
BIN_PARTS=("${BASH_REMATCH[1]}" "${BASH_REMATCH[2]}" "${BASH_REMATCH[3]}")
BELOW=0
for i in 0 1 2; do
    if ((10#${BIN_PARTS[i]} > 10#${FLOOR_PARTS[i]})); then break; fi
    if ((10#${BIN_PARTS[i]} < 10#${FLOOR_PARTS[i]})); then BELOW=1; break; fi
done
[ "${BELOW}" -eq 0 ] \
    || fail '4 (floor)' "the agent-director binary's version ${BIN_VERSION} is below the client's floor ${FLOOR} (${FLOOR_FILE})"

# --- 5 client-create -----------------------------------------------------
if ! (cd / && CLIENT_ENTRY="${ENTRY}" bun --no-install -e '
const { Client } = await import(process.env.CLIENT_ENTRY)
try {
  const client = await Client.create()
  try {
    process.stdout.write(String(client.binaryVersion))
  } finally {
    client.close()
  }
} catch (e) {
  process.stderr.write(`${e?.name ?? "Error"}: ${String(e?.message ?? e).split("\n")[0]}\n`)
  process.exit(1)
}
') > "${SCRATCH}/create.out" 2> "${SCRATCH}/create.err"; then
    fail '5 (client-create)' "Client.create() from ${ENTRY} failed: $(first_line "${SCRATCH}/create.err")"
fi
CREATE_VERSION=$(cat "${SCRATCH}/create.out")
[ "${CREATE_VERSION}" = "${BIN_VERSION}" ] \
    || fail '5 (client-create)' "Client.create() from ${ENTRY} reports agent-director version ${CREATE_VERSION}, not ${BIN_VERSION} (the first agent-director binary on PATH, ${BIN})"

echo "rc-client check passed: ${CLIENT_DIR} is the release-candidate client (tarball sha256 ${TGZ_SHA256}); agent-director ${BIN_VERSION} (${BIN_COMMIT}) at ${BIN}; client floor ${FLOOR}"
