#!/usr/bin/env bash
# Test 4 (b.vub): NON-dry-run resume → dev-channels-dialog → approver → self-heal.
#
# Tests 1-3 all run under SLACK_DRY_RUN=1, so nothing ever spawns a real bot,
# hits the real --dangerously-load-development-channels dialog, or resumes. That
# blind spot is exactly why b.vub shipped: the resume-success path never ran the
# dialog approver, so a resumed bot hung at the dialog forever and the launcher
# fell into an ErrTmuxSessionCreate respawn loop.
#
# This test exercises the REAL agent-director + REAL tmux spawn/resume path (no
# SLACK_DRY_RUN) via a small driver that calls the shipped spawnForRoute /
# approvePreSessionDialogs directly (the full daemon needs Slack creds CI lacks).
# A stub `claude` on PATH stands in for the model: it prints the exact
# dev-channels dialog and fires SessionStart on Enter, so the test is
# deterministic and does not burn the Anthropic API.
#
# Requires tmux in the image (added to docker/Dockerfile.test.base; base tag
# bumped v2 -> v3).
#
# Depends on Test 1 having installed the package tarball into /test-repo.
set -euo pipefail

TEST_NAME="test-4-resume-dialog"
PKG_DIR="/test-repo/node_modules/claude-slack-channel-bots"
FIXTURES="/tests/integration/fixtures"
DRIVER_LOG="/tmp/test-4-driver.log"
DRIVER_CHANNEL="C_RESUME"
DRIVER_CWD="/tmp/test-repo-resume"

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

# --- Route cwd ------------------------------------------------------------
mkdir -p "${DRIVER_CWD}"
git -C "${DRIVER_CWD}" init -q 2>/dev/null || true

# --- Run the driver (NON-dry-run: SLACK_DRY_RUN deliberately unset) --------
# Tee stderr (CSCB console.error, incl. any ErrTmuxSessionCreate) to a log for
# the no-loop assertion; keep stdout (DRIVER: markers) for the phase asserts.
set +e
CSCB_PKG_DIR="${PKG_DIR}" \
DRIVER_CHANNEL="${DRIVER_CHANNEL}" \
DRIVER_CWD="${DRIVER_CWD}" \
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

# 1. Fresh spawn reached a live AD state (got PAST the dialog).
printf '%s\n' "${DRIVER_OUT}" | grep -q '^DRIVER: PHASE1_OK' \
    || fail "phase 1: fresh spawn never reached a live state past the dev-channels dialog"

# 2. Precondition held: row went missing/ended with a session_id (resume-able).
printf '%s\n' "${DRIVER_OUT}" | grep -q '^DRIVER: PRECONDITION_OK' \
    || fail "precondition: row did not reach missing/ended with a recorded session_id"

# 3. THE REGRESSION: after missing+session_id, resume drove PAST the dialog
#    AGAIN and reached a live state (pre-fix this hung forever).
printf '%s\n' "${DRIVER_OUT}" | grep -q '^DRIVER: PHASE2_OK' \
    || fail "phase 2 (b.vub regression): resume did not re-approve the dialog / reach a live state"

# 4. No ErrTmuxSessionCreate respawn loop for this channel.
if grep -q 'ErrTmuxSessionCreate' "${DRIVER_LOG}"; then
    echo "--- ErrTmuxSessionCreate occurrences ---" >&2
    grep -n 'ErrTmuxSessionCreate' "${DRIVER_LOG}" >&2 || true
    fail "ErrTmuxSessionCreate appeared during spawn/resume (b.vub self-heal did not hold)"
fi

echo "PASS: ${TEST_NAME}"
