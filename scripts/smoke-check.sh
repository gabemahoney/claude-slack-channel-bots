#!/usr/bin/env bash
#
# /publish SR-4.2 + SR-4.3 — scratch-install the packed tarball into a
# throwaway BUN_INSTALL prefix, verify the installed version matches the
# expected version, and run the bin's no-args smoke check (expect non-zero
# exit + 'Usage:' on stderr).
#
# The scratch BUN_INSTALL directory is created via mktemp and removed on
# every exit path via a trap. The caller's working tree is NOT touched —
# rollback on smoke failure is the caller's responsibility (publish-prepare.sh
# runs `git checkout -- package.json bun.lock` after a non-zero exit here).
#
# Inputs (env vars):
#   TARBALL_ABS    absolute path to the packed *.tgz tarball
#   NEXT_VERSION   expected version inside the tarball / installed package
#   BUMP_KIND      passed through for error messages ("rerun '/publish X'")
#
# Exit codes:
#   0   smoke test passed
#   22  SR-4.2  scratch install failed OR installed version mismatch
#   23  SR-4.3  bin missing/not executable, or smoke contract not met

set -euo pipefail

TARBALL_ABS="${TARBALL_ABS:?TARBALL_ABS must be set}"
NEXT_VERSION="${NEXT_VERSION:?NEXT_VERSION must be set}"
BUMP_KIND="${BUMP_KIND:?BUMP_KIND must be set}"

SCRATCH_DIR=""
cleanup() {
  if [ -n "${SCRATCH_DIR}" ] && [ -d "${SCRATCH_DIR}" ]; then
    rm -rf "${SCRATCH_DIR}"
  fi
}
trap cleanup EXIT

SCRATCH_DIR="$(mktemp -d)"

if ! BUN_INSTALL="${SCRATCH_DIR}" bun install -g "${TARBALL_ABS}" > /dev/null 2>&1; then
  echo "SR-4.2 (scratch install): 'bun install -g ${TARBALL_ABS}' into scratch BUN_INSTALL did not succeed. Working tree has been rolled back. Rerun the failing command manually to inspect the bun output, then rerun '/publish ${BUMP_KIND}'." >&2
  exit 22
fi

INSTALLED_PKG="${SCRATCH_DIR}/install/global/node_modules/claude-slack-channel-bots/package.json"
if [ ! -f "${INSTALLED_PKG}" ]; then
  echo "SR-4.2 (scratch install): installed package.json not found at ${INSTALLED_PKG}. Working tree has been rolled back. The tarball layout may be malformed — inspect the tarball with 'tar -tzf ${TARBALL_ABS}', then rerun '/publish ${BUMP_KIND}'." >&2
  exit 22
fi

INSTALLED_VERSION="$(jq -r .version "${INSTALLED_PKG}")"
if [ "${INSTALLED_VERSION}" != "${NEXT_VERSION}" ]; then
  echo "SR-4.2 (scratch install): installed version '${INSTALLED_VERSION}' != bumped ${NEXT_VERSION}. Working tree has been rolled back. This indicates a tarball/install inconsistency — investigate, then rerun '/publish ${BUMP_KIND}'." >&2
  exit 22
fi

INSTALLED_BIN="${SCRATCH_DIR}/bin/claude-slack-channel-bots"
if [ ! -x "${INSTALLED_BIN}" ]; then
  echo "SR-4.3 (smoke check): installed bin not found or not executable at ${INSTALLED_BIN}. Working tree has been rolled back. Inspect package.json's 'bin' field and the tarball contents, then rerun '/publish ${BUMP_KIND}'." >&2
  exit 23
fi

SMOKE_EXIT=0
SMOKE_STDERR="$("${INSTALLED_BIN}" 2>&1 >/dev/null)" || SMOKE_EXIT=$?

if [ "${SMOKE_EXIT}" = "0" ]; then
  echo "SR-4.3 (smoke check): bin exited zero with no arguments (expected non-zero). Working tree has been rolled back. The CLI's no-args behavior has changed — update src/cli.ts to exit non-zero on missing arguments (the smoke check assumes this contract; see the SRD), then rerun '/publish ${BUMP_KIND}'." >&2
  exit 23
fi

if ! grep -q "Usage:" <<< "${SMOKE_STDERR}"; then
  echo "SR-4.3 (smoke check): bin stderr did not contain 'Usage:' (the smoke contract). Working tree has been rolled back. Update src/cli.ts to emit a 'Usage:' line on no-args (or update this skill to match the new CLI contract — see the SRD), then rerun '/publish ${BUMP_KIND}'." >&2
  exit 23
fi
