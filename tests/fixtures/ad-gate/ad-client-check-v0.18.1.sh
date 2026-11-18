#!/usr/bin/env bash
# docker/ad-client-check.sh — the client-under-test check of the cscb-ci
# images: checks that an installed package resolves agent-director's released
# client, as published on npm at the pinned version, and that the client pairs
# with the image's agent-director binary. It only reads: it replaces no file.
#
# In the image: /opt/agent-director/check/ad-client-check.sh, off PATH
# (docker/Dockerfile.test.base copies it there; ci-live/lib/ad-client-check.ts
# exports the path as AD_CLIENT_CHECK). It runs an agent-director binary
# (Client.create()'s version probe), so it runs only in a cscb-ci image: the
# first thing it does is refuse when /etc/cscb-ci-image is absent.
#
# Usage:
#   ad-client-check.sh --package <dir>
#       <dir> is an installed package. Check the agent-director client it
#       resolves (a bun install may hoist it out of <dir>/node_modules), and
#       that the package pins that client's version exactly.
#   ad-client-check.sh --client <dir>
#       <dir> is an agent-director client. Check it as it is.
#
# The release record /opt/agent-director/client/release.json, written by the
# base image's build from its pins, names the release's version and commit,
# the npm client tarball the build fetched and that tarball's pinned SHA-256.
# The check, in order, stopping at the first failure:
#   1 tarball        the client tarball has the record's pinned SHA-256;
#   2 version        the client's package version is the record's version, a
#                    plain major.minor.patch (no pre-release); with
#                    --package, the package's dependency on agent-director
#                    is exactly that version, and so is the package's
#                    PHASE1_FLOOR_VERSION (src/ad-version-gate.ts);
#   3 content        the client's files equal that tarball's;
#   4 exports        the client exports ErrTmuxKillFailed,
#                    ErrTmuxUnresponsive and ErrTmuxSessionConflict, each an
#                    AgentDirectorError class;
#   5 binary         the first agent-director on PATH reports the record's
#                    version and commit, so its version is the client's;
#   6 floor          that version (major.minor.patch) is at or above the
#                    client's dist/version-floor.json min_binary_version;
#   7 client-create  Client.create(), imported from the client's entry point,
#                    reports a binaryVersion equal to that version.
#
# Exit codes:
#   0  passed: one line on stdout,
#        ad-client check passed: <client dir> is agent-director <version> from npm (tarball sha256 <sha>); agent-director <version> (<commit>) at <binary>; client floor <floor>
#   1  a check failed: one line on stderr,
#        ERROR: ad-client check <step>: <what differs>
#   2  usage error: one ERROR: line on stderr
#   3  refused (no /etc/cscb-ci-image): one ERROR: line on stderr
set -euo pipefail

MARKER=/etc/cscb-ci-image
RELEASE_RECORD=/opt/agent-director/client/release.json
PHASE1_CLASSES='ErrTmuxKillFailed ErrTmuxUnresponsive ErrTmuxSessionConflict'
# The installed package's module that exports CSCB's Phase 1 floor.
PHASE1_MODULE=src/ad-version-gate.ts
PLAIN_RELEASE_RE='^[0-9]+\.[0-9]+\.[0-9]+$'

if [ ! -e "${MARKER}" ]; then
    echo "ERROR: ad-client-check.sh: ${MARKER} is absent: this check runs only in a cscb-ci image (it runs agent-director); refusing to run" >&2
    exit 3
fi

usage_error() {
    echo "ERROR: ad-client-check.sh: $1 (usage: ad-client-check.sh --package <dir> | --client <dir>)" >&2
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
if [ "${MODE}" = --package ]; then
    [ -f "${TARGET}/package.json" ] || usage_error "${TARGET} holds no package.json"
fi

# fail STEP TEXT: the one ERROR line, then exit 1.
fail() {
    echo "ERROR: ad-client check $1: $2" >&2
    exit 1
}

SCRATCH=$(mktemp -d)
trap 'rm -rf "${SCRATCH}"' EXIT

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
AD_VERSION=$(record_field version)
AD_COMMIT=$(record_field commit)
AD_TGZ=$(record_field client_tarball)
AD_TGZ_SHA256=$(record_field client_tarball_sha256)

# --- Which client --------------------------------------------------------
if [ "${MODE}" = --package ]; then
    # The file the specifier "agent-director" resolves to from the package,
    # as the package's own imports resolve it (bun's resolver).
    if ! (cd / && RESOLVE_FROM="${TARGET}" bun --no-install -e \
        'process.stdout.write(Bun.resolveSync("agent-director", process.env.RESOLVE_FROM))') \
        > "${SCRATCH}/resolve.out" 2> "${SCRATCH}/resolve.err"; then
        fail resolve "the package at ${TARGET} resolves no agent-director client: $(first_line "${SCRATCH}/resolve.err")"
    fi
    ENTRY=$(cat "${SCRATCH}/resolve.out")
    case "${ENTRY}" in
        /*) ;;
        *) fail resolve "the resolved entry point '${ENTRY}' is not an absolute path" ;;
    esac
    # The client's root: the nearest directory above the entry point holding
    # the agent-director package.json.
    CLIENT_DIR=''
    d=$(dirname "${ENTRY}")
    while [ "${d}" != / ]; do
        if [ -f "${d}/package.json" ] && [ "$(jq -r '.name' "${d}/package.json" 2>/dev/null)" = agent-director ]; then
            CLIENT_DIR=$(realpath "${d}")
            break
        fi
        d=$(dirname "${d}")
    done
    [ -n "${CLIENT_DIR}" ] || fail resolve "no agent-director package.json above ${ENTRY}"
else
    CLIENT_DIR="${TARGET}"
    [ -f "${CLIENT_DIR}/package.json" ] || fail resolve "${CLIENT_DIR} holds no package.json"
    ENTRY_REL=$(jq -er '(.exports["."] | if type == "object" then (.import // .default) else . end) // .main | strings' "${CLIENT_DIR}/package.json") \
        || fail resolve "${CLIENT_DIR}/package.json names no entry point"
    ENTRY=$(realpath -m "${CLIENT_DIR}/${ENTRY_REL}")
    [ -f "${ENTRY}" ] || fail resolve "the entry point ${ENTRY} is missing"
fi

# --- 1 tarball -----------------------------------------------------------
[ -f "${AD_TGZ}" ] || fail '1 (tarball)' "the npm client tarball ${AD_TGZ} is missing"
TGZ_SHA256=$(sha256sum "${AD_TGZ}" | cut -d' ' -f1)
[ "${TGZ_SHA256}" = "${AD_TGZ_SHA256}" ] \
    || fail '1 (tarball)' "${AD_TGZ} has SHA-256 ${TGZ_SHA256}, not the pinned ${AD_TGZ_SHA256}"

# --- 2 version -----------------------------------------------------------
[[ "${AD_VERSION}" =~ ${PLAIN_RELEASE_RE} ]] \
    || fail '2 (version)' "the release record's version ${AD_VERSION} is not a plain major.minor.patch release"
CLIENT_VERSION=$(jq -er '.version | strings' "${CLIENT_DIR}/package.json" 2>/dev/null) \
    || fail '2 (version)' "${CLIENT_DIR}/package.json has no string version"
[ "${CLIENT_VERSION}" = "${AD_VERSION}" ] \
    || fail '2 (version)' "the client at ${CLIENT_DIR} is agent-director ${CLIENT_VERSION}, not the release's ${AD_VERSION}"
if [ "${MODE}" = --package ]; then
    PIN=$(jq -r '.dependencies["agent-director"] // "(none)"' "${TARGET}/package.json")
    [ "${PIN}" = "${CLIENT_VERSION}" ] \
        || fail '2 (version)' "${TARGET}/package.json pins agent-director ${PIN}, not exactly the client's ${CLIENT_VERSION}"
    if ! (cd / && GATE="${TARGET}/${PHASE1_MODULE}" bun --no-install -e '
const m = await import(process.env.GATE)
if (typeof m.PHASE1_FLOOR_VERSION !== "string") throw new Error("no string export PHASE1_FLOOR_VERSION")
process.stdout.write(m.PHASE1_FLOOR_VERSION)
') > "${SCRATCH}/p1.out" 2> "${SCRATCH}/p1.err"; then
        fail '2 (version)' "cannot read PHASE1_FLOOR_VERSION from ${TARGET}/${PHASE1_MODULE}: $(first_line "${SCRATCH}/p1.err")"
    fi
    P1=$(cat "${SCRATCH}/p1.out")
    [ "${P1}" = "${CLIENT_VERSION}" ] \
        || fail '2 (version)' "the client's version ${CLIENT_VERSION} is not the package's Phase 1 floor PHASE1_FLOOR_VERSION ${P1}"
fi

# --- 3 content -----------------------------------------------------------
mkdir "${SCRATCH}/tarball"
tar -xzf "${AD_TGZ}" -C "${SCRATCH}/tarball" --strip-components=1 --no-same-owner \
    || fail '3 (content)' "cannot unpack ${AD_TGZ}"
DIFFS=$(diff -rq --no-dereference "${SCRATCH}/tarball" "${CLIENT_DIR}" || true)
if [ -n "${DIFFS}" ]; then
    FIRST=$(printf '%s\n' "${DIFFS}" | head -n 1)
    FIRST=${FIRST//"${SCRATCH}/tarball"/<tarball>}
    fail '3 (content)' "the client at ${CLIENT_DIR} is not the npm client tarball's contents: $(printf '%s\n' "${DIFFS}" | wc -l) difference(s) from ${AD_TGZ}, first: ${FIRST}"
fi

# --- 4 exports -----------------------------------------------------------
if ! (cd / && CLIENT_ENTRY="${ENTRY}" PHASE1_CLASSES="${PHASE1_CLASSES}" bun --no-install -e '
const m = await import(process.env.CLIENT_ENTRY)
const base = m.AgentDirectorError
const missing = process.env.PHASE1_CLASSES.split(" ").filter(
  (n) => typeof m[n] !== "function" || typeof base !== "function" || !(m[n].prototype instanceof base),
)
process.stdout.write(missing.join(" "))
') > "${SCRATCH}/exports.out" 2> "${SCRATCH}/exports.err"; then
    fail '4 (exports)' "cannot import the client entry point ${ENTRY}: $(first_line "${SCRATCH}/exports.err")"
fi
MISSING=$(cat "${SCRATCH}/exports.out")
[ -z "${MISSING}" ] \
    || fail '4 (exports)' "the client at ${CLIENT_DIR} does not export ${MISSING} as AgentDirectorError classes"

# --- 5 binary ------------------------------------------------------------
BIN=$(command -v agent-director) || fail '5 (binary)' "no agent-director binary on PATH"
"${BIN}" version > "${SCRATCH}/version.out" 2> "${SCRATCH}/version.err" \
    || fail '5 (binary)' "the agent-director binary ${BIN}: version failed: $(first_line "${SCRATCH}/version.err")"
BIN_VERSION=$(jq -ner 'input | .version | strings' "${SCRATCH}/version.out") \
    || fail '5 (binary)' "the agent-director binary ${BIN}: version printed no JSON object with a string version field"
BIN_COMMIT=$(jq -ner 'input | .commit | strings' "${SCRATCH}/version.out") \
    || fail '5 (binary)' "the agent-director binary ${BIN}: version printed no JSON object with a string commit field"
if [ "${BIN_VERSION}" != "${AD_VERSION}" ] || [ "${BIN_COMMIT}" != "${AD_COMMIT}" ]; then
    fail '5 (binary)' "the first agent-director binary on PATH, ${BIN}, reports version ${BIN_VERSION} (${BIN_COMMIT}), not the release's ${AD_VERSION} (${AD_COMMIT}) that the client ${CLIENT_VERSION} pairs with"
fi

# --- 6 floor -------------------------------------------------------------
FLOOR_FILE="${CLIENT_DIR}/dist/version-floor.json"
FLOOR=$(jq -er '.min_binary_version | strings' "${FLOOR_FILE}" 2>/dev/null) \
    || fail '6 (floor)' "${FLOOR_FILE} has no string min_binary_version"
CORE_RE='^([0-9]+)\.([0-9]+)\.([0-9]+)([-+].*)?$'
[[ "${FLOOR}" =~ ${CORE_RE} ]] || fail '6 (floor)' "the client's floor ${FLOOR} is not major.minor.patch"
FLOOR_PARTS=("${BASH_REMATCH[1]}" "${BASH_REMATCH[2]}" "${BASH_REMATCH[3]}")
[[ "${BIN_VERSION}" =~ ${CORE_RE} ]] || fail '6 (floor)' "the agent-director binary's version ${BIN_VERSION} is not major.minor.patch"
BIN_PARTS=("${BASH_REMATCH[1]}" "${BASH_REMATCH[2]}" "${BASH_REMATCH[3]}")
BELOW=0
for i in 0 1 2; do
    if ((10#${BIN_PARTS[i]} > 10#${FLOOR_PARTS[i]})); then break; fi
    if ((10#${BIN_PARTS[i]} < 10#${FLOOR_PARTS[i]})); then BELOW=1; break; fi
done
[ "${BELOW}" -eq 0 ] \
    || fail '6 (floor)' "the agent-director binary's version ${BIN_VERSION} is below the client's floor ${FLOOR} (${FLOOR_FILE})"

# --- 7 client-create -----------------------------------------------------
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
    fail '7 (client-create)' "Client.create() from ${ENTRY} failed: $(first_line "${SCRATCH}/create.err")"
fi
CREATE_VERSION=$(cat "${SCRATCH}/create.out")
[ "${CREATE_VERSION}" = "${BIN_VERSION}" ] \
    || fail '7 (client-create)' "Client.create() from ${ENTRY} reports agent-director version ${CREATE_VERSION}, not ${BIN_VERSION} (the first agent-director binary on PATH, ${BIN})"

echo "ad-client check passed: ${CLIENT_DIR} is agent-director ${CLIENT_VERSION} from npm (tarball sha256 ${TGZ_SHA256}); agent-director ${BIN_VERSION} (${BIN_COMMIT}) at ${BIN}; client floor ${FLOOR}"
