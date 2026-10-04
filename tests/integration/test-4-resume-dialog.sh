#!/usr/bin/env bash
# Test 4: NON-dry-run fresh and resumed launches held at the dev-channels
# dialog, each cleared by CSCB's dialog approver through agent-director on the
# launch's `pending` row.
#
# Tests 1-3 all run under SLACK_DRY_RUN=1, so nothing there spawns a real bot,
# meets the real --dangerously-load-development-channels dialog, or resumes.
#
# This test exercises the REAL agent-director + REAL tmux spawn/resume path (no
# SLACK_DRY_RUN) via a small driver that calls the shipped spawnForPersona
# directly (the full daemon needs each persona's Slack credentials file, which
# CI lacks). spawnForPersona returns once the launch call returns, with the
# persona's dialog approver still running; the approver reads the `pending`
# row and its pane through agent-director and presses Enter with `send-keys`.
# The driver follows the approver through the package's own seams: it must be
# running when the launch returns, stop because the row went live, and have
# kept the launch's start, which on the resumed row equals the row's
# `launch_started_at`. The driver deletes no row; its cleanup kill leaves the
# row ended and kept. The driver builds a one-persona config (DRIVER_PERSONA,
# one channel DRIVER_PERSONA_CHANNEL, working directory
# DRIVER_WORKING_DIRECTORY) through the installed package's persona resolver;
# its instance is cscb_<persona key>.
# A stub `claude` on PATH stands in for the model: it prints the exact
# dev-channels dialog and fires agent-director's SessionStart hooks on Enter,
# so the test is deterministic and does not burn the Anthropic API.
#
# Requires tmux in the image (docker/Dockerfile.test.base).
#
# Depends on Test 1 having installed the package tarball into /test-repo.
set -euo pipefail

TEST_NAME="test-4-resume-dialog"
PKG_DIR="/test-repo/node_modules/claude-slack-channel-bots"
FIXTURES="/tests/integration/fixtures"
DRIVER_LOG="/tmp/test-4-driver.log"
DRIVER_PERSONA="resume_test"
DRIVER_PERSONA_CHANNEL="C0RESUME1"
DRIVER_WORKING_DIRECTORY="/tmp/test-repo-resume"

fail() {
    echo "FAIL: ${TEST_NAME}: $1" >&2
    exit 1
}

# --- Prerequisites --------------------------------------------------------
command -v tmux >/dev/null 2>&1 \
    || fail "tmux not on PATH (image must include tmux — see docker/Dockerfile.test.base)"

command -v agent-director >/dev/null 2>&1 \
    || fail "agent-director not on PATH (Test 1 prerequisite / base image)"

test -d "${PKG_DIR}" \
    || fail "installed package not found at ${PKG_DIR} (Test 1 prerequisite)"

test -f "${FIXTURES}/stub-claude.sh" \
    || fail "stub-claude fixture missing at ${FIXTURES}/stub-claude.sh"

test -f "${FIXTURES}/driver.ts" \
    || fail "driver fixture missing at ${FIXTURES}/driver.ts"

# --- Stub `claude` on PATH (ahead of any real claude) ---------------------
STUB_BIN_DIR="/tmp/test-4-bin"
mkdir -p "${STUB_BIN_DIR}"
cp "${FIXTURES}/stub-claude.sh" "${STUB_BIN_DIR}/claude"
chmod +x "${STUB_BIN_DIR}/claude"
export PATH="${STUB_BIN_DIR}:${PATH}"

command -v claude >/dev/null 2>&1 \
    || fail "stub claude not resolvable on PATH after install"
[ "$(command -v claude)" = "${STUB_BIN_DIR}/claude" ] \
    || fail "PATH resolves claude to $(command -v claude), expected ${STUB_BIN_DIR}/claude"

# The stub-claude dialog text must stay byte-identical to the needle the
# approver matches; assert the needle is present in the stub.
grep -q "I am using this for local development" "${STUB_BIN_DIR}/claude" \
    || fail "stub claude does not emit the dev-channels needle"

# --- Persona working directory ---------------------------------------------
mkdir -p "${DRIVER_WORKING_DIRECTORY}"
git -C "${DRIVER_WORKING_DIRECTORY}" init -q 2>/dev/null || true

# --- Run the driver (NON-dry-run: SLACK_DRY_RUN deliberately unset) --------
# Write stderr (CSCB console.error, the approver's lines included) to a log
# shown on failure; keep stdout (DRIVER: markers) for the phase asserts.
set +e
CSCB_PKG_DIR="${PKG_DIR}" \
DRIVER_PERSONA="${DRIVER_PERSONA}" \
DRIVER_PERSONA_CHANNEL="${DRIVER_PERSONA_CHANNEL}" \
DRIVER_WORKING_DIRECTORY="${DRIVER_WORKING_DIRECTORY}" \
    bun "${FIXTURES}/driver.ts" > /tmp/test-4-driver.out 2> "${DRIVER_LOG}"
DRIVER_RC=$?
set -e

DRIVER_OUT="$(cat /tmp/test-4-driver.out 2>/dev/null || true)"

# Surface driver output for debugging on failure.
if [ "${DRIVER_RC}" -ne 0 ]; then
    echo "--- driver stdout ---" >&2
    printf '%s\n' "${DRIVER_OUT}" >&2
    echo "--- driver stderr (tail) ---" >&2
    tail -n 40 "${DRIVER_LOG}" >&2 || true
    first_driver_fail="$(printf '%s\n' "${DRIVER_OUT}" | grep -m1 '^DRIVER_FAIL:' || true)"
    if [ -n "${first_driver_fail}" ]; then
        fail "driver reported ${first_driver_fail}"
    fi
    fail "driver exited ${DRIVER_RC} without an explicit DRIVER_FAIL line"
fi

# --- Assertions -----------------------------------------------------------

# 1. Fresh launch: the approver cleared the dialog on the `pending` row
#    through agent-director, and the row went live.
printf '%s\n' "${DRIVER_OUT}" | grep -q '^DRIVER: PHASE1_OK' \
    || fail "phase 1: the approver did not clear the dev-channels dialog on the fresh launch's pending row"

# 2. Precondition held: the row went ended/missing with a session_id (resumable).
printf '%s\n' "${DRIVER_OUT}" | grep -q '^DRIVER: PRECONDITION_OK' \
    || fail "precondition: row did not reach missing/ended with a recorded session_id"

# 3. Resumed launch: the approver cleared the dialog again on the resumed
#    `pending` row, kept that row's launch start, and the row went live.
printf '%s\n' "${DRIVER_OUT}" | grep -q '^DRIVER: PHASE2_OK' \
    || fail "phase 2: the approver did not clear the dev-channels dialog on the resumed launch's pending row"

echo "PASS: ${TEST_NAME}"
