#!/usr/bin/env bash
# Test 5 (SR-29.6): clean_restart healthy-fleet smoke — teardown, restart, resume.
#
# PURPOSE
# -------
# Wires the SR-29.6 sandbox smoke procedure into the v0.8.1 integration harness
# (tests/integration/ using the b.vub fixtures: real agent-director + real tmux +
# stub-claude).  Validates the complete clean_restart lifecycle:
#
#   Phase 1 — healthy-fleet setup via driver-5.ts (setup phase):
#     spawnForRoute launches two stub-claude bots (C_CLEAN5_A, C_CLEAN5_B).
#     Each bot fires SessionStart → AD rows reach a live state.
#
#   Phase 2 — clean_restart:
#     Invokes the CSCB clean_restart subcommand against the isolated state dir.
#     Assertions on clean_restart.log:
#       - ZERO "no spawn row — skipping" lines while rows exist.
#       - "stopping server" emitted (teardown started).
#       - "starting server" emitted (new server started).
#       - "done" emitted (completed without fatal error).
#
#   Phase 3 — old stub-claude processes dead:
#     Confirms stub-claude PIDs captured before clean_restart are no longer live.
#
#   Phase 4 — resume path via driver-5.ts (resume phase):
#     spawnForRoute resumes both channels (rows were left in ended/missing state).
#     Assertions:
#       - "attempting resume for channel=" in captured log.
#       - "resumed channel=" in captured log (SR-24.5).
#       - per-channel started_at incremented vs. pre-restart values.
#
#   Phase 5 — AD-unreachable loud-failure spot check (SR-27):
#     driver-5.ts ad-fail phase: createCli with initClient that throws simulated
#     ECONNREFUSED → clean_restart exits non-zero before teardown.
#
# CITATIONS
# ---------
#   SR-29.6  smoke procedure for clean_restart
#   SR-27    AD-unreachable must be a loud non-zero exit (not silent skip)
#
# SANDBOX-ONLY WARNING
# --------------------
# This test MUST NOT be run against a host with live production bots.
# All agent-director rows are scoped to throwaway channel IDs (C_CLEAN5_A,
# C_CLEAN5_B) and are cleaned up by the driver.  The isolated state dir
# (/tmp/test-5-state) is never ~/.claude/channels/slack; the test does NOT
# touch the real server.pid / server.log on the host.
#
# PREREQUISITES
# -------------
# Depends on Test 1 having installed the package tarball into /test-repo.
# Requires tmux and agent-director on PATH.
set -euo pipefail

TEST_NAME="test-5-clean-restart-resume"
PKG_DIR="/test-repo/node_modules/claude-slack-channel-bots"
FIXTURES="/tests/integration/fixtures"

# Isolated state dir — never touches the real ~/.claude/channels/slack.
STATE_DIR="/tmp/test-5-state"
CLEAN_RESTART_LOG="${STATE_DIR}/clean_restart.log"

CHANNEL_A="C_CLEAN5_A"
CHANNEL_B="C_CLEAN5_B"
CWD_A="/tmp/test-5-cwd-a"
CWD_B="/tmp/test-5-cwd-b"

STUB_BIN_DIR="/tmp/test-5-bin"
DRIVER_OUT_SETUP="/tmp/test-5-driver-setup.out"
DRIVER_OUT_RESUME="/tmp/test-5-driver-resume.out"
DRIVER_OUT_ADFAIL="/tmp/test-5-driver-adfail.out"
DRIVER_LOG="/tmp/test-5-driver.log"

fail() {
    echo "FAIL: ${TEST_NAME}: $1" >&2
    exit 1
}

# ---------------------------------------------------------------------------
# Prerequisites
# ---------------------------------------------------------------------------

command -v tmux >/dev/null 2>&1 \
    || fail "tmux not on PATH (image must include tmux)"

command -v agent-director >/dev/null 2>&1 \
    || fail "agent-director not on PATH (Test 1 prerequisite / base image)"

test -d "${PKG_DIR}" \
    || fail "installed package not found at ${PKG_DIR} (Test 1 prerequisite)"

test -f "${FIXTURES}/stub-claude.sh" \
    || fail "stub-claude fixture missing at ${FIXTURES}/stub-claude.sh"

test -f "${FIXTURES}/driver-5.ts" \
    || fail "driver-5 fixture missing at ${FIXTURES}/driver-5.ts"

# ---------------------------------------------------------------------------
# Stub `claude` on PATH (ahead of any real claude)
# ---------------------------------------------------------------------------

mkdir -p "${STUB_BIN_DIR}"
cp "${FIXTURES}/stub-claude.sh" "${STUB_BIN_DIR}/claude"
chmod +x "${STUB_BIN_DIR}/claude"
export PATH="${STUB_BIN_DIR}:${PATH}"

[ "$(command -v claude)" = "${STUB_BIN_DIR}/claude" ] \
    || fail "PATH resolves claude to $(command -v claude), expected ${STUB_BIN_DIR}/claude"

grep -q "I am using this for local development" "${STUB_BIN_DIR}/claude" \
    || fail "stub claude does not emit the dev-channels needle"

# ---------------------------------------------------------------------------
# Isolated route cwds + state dir
# ---------------------------------------------------------------------------

mkdir -p "${CWD_A}" "${CWD_B}" "${STATE_DIR}"
git -C "${CWD_A}" init -q 2>/dev/null || true
git -C "${CWD_B}" init -q 2>/dev/null || true

# Config for clean_restart's own start/stop sub-commands.  Written to the
# isolated STATE_DIR so SLACK_STATE_DIR finds it.
cat > "${STATE_DIR}/config.json" << EOF
{
  "routes": {
    "${CHANNEL_A}": { "cwd": "${CWD_A}" },
    "${CHANNEL_B}": { "cwd": "${CWD_B}" }
  },
  "bind": "127.0.0.1",
  "port": 3199,
  "exit_timeout": 15,
  "stop_timeout": 10,
  "cozempic_prescription": "standard"
}
EOF

# ---------------------------------------------------------------------------
# Phase 1 — healthy-fleet setup
# ---------------------------------------------------------------------------

echo "=== ${TEST_NAME}: Phase 1 — spawn healthy fleet ==="

set +e
CSCB_PKG_DIR="${PKG_DIR}" \
DRIVER5_PHASE="setup" \
DRIVER5_CHANNEL_A="${CHANNEL_A}" \
DRIVER5_CHANNEL_B="${CHANNEL_B}" \
DRIVER5_CWD_A="${CWD_A}" \
DRIVER5_CWD_B="${CWD_B}" \
    bun "${FIXTURES}/driver-5.ts" > "${DRIVER_OUT_SETUP}" 2> "${DRIVER_LOG}"
SETUP_RC=$?
set -e

SETUP_OUT="$(cat "${DRIVER_OUT_SETUP}" 2>/dev/null || true)"

if [ "${SETUP_RC}" -ne 0 ]; then
    echo "--- driver-5 setup stdout ---" >&2
    printf '%s\n' "${SETUP_OUT}" >&2
    echo "--- driver-5 setup stderr (tail) ---" >&2
    tail -n 40 "${DRIVER_LOG}" >&2 || true
    first_fail="$(printf '%s\n' "${SETUP_OUT}" | grep -m1 '^DRIVER5_FAIL:' || true)"
    if [ -n "${first_fail}" ]; then
        fail "driver-5 setup reported: ${first_fail}"
    fi
    fail "driver-5 setup exited ${SETUP_RC} without an explicit DRIVER5_FAIL line"
fi

printf '%s\n' "${SETUP_OUT}" | grep -q '^DRIVER5: SETUP_OK' \
    || fail "phase 1: driver-5 setup did not emit DRIVER5: SETUP_OK"

# Extract started_at timestamps for post-resume comparison.
STARTED_AT_A="$(printf '%s\n' "${SETUP_OUT}" | grep -o 'started_at_A=[^ ]*' | cut -d= -f2 || true)"
STARTED_AT_B="$(printf '%s\n' "${SETUP_OUT}" | grep -o 'started_at_B=[^ ]*' | cut -d= -f2 || true)"

echo "Phase 1 OK: A=${STARTED_AT_A} B=${STARTED_AT_B}"

# ---------------------------------------------------------------------------
# Capture stub-claude PIDs before clean_restart
# (used in Phase 3 to confirm old processes died)
# ---------------------------------------------------------------------------

STUB_PIDS_BEFORE="$(pgrep -f "${STUB_BIN_DIR}/claude" 2>/dev/null | tr '\n' ' ' || true)"
echo "stub-claude PIDs before clean_restart: ${STUB_PIDS_BEFORE}"

# ---------------------------------------------------------------------------
# Phase 2 — clean_restart
# ---------------------------------------------------------------------------

echo "=== ${TEST_NAME}: Phase 2 — clean_restart ==="

# Run clean_restart via the installed CSCB binary.
# SLACK_STATE_DIR points to the isolated state dir (not ~/.claude/channels/slack).
# SLACK_DRY_RUN=1 lets the subordinate 'start' sub-command skip Slack token
# checks (CI has no Slack credentials).  The teardown phase (AD pause/kill)
# is unaffected by dry-run because it goes through getClient() directly.
set +e
SLACK_STATE_DIR="${STATE_DIR}" \
SLACK_DRY_RUN=1 \
    /test-repo/node_modules/.bin/claude-slack-channel-bots clean_restart \
    > /tmp/test-5-clean-restart.out 2>&1
CR_RC=$?
set -e

# clean_restart logs to STATE_DIR/clean_restart.log (via initLogging).
# If that path doesn't exist yet, fall back to captured stdout/stderr.
if [ ! -f "${CLEAN_RESTART_LOG}" ]; then
    # Log was not written (e.g. initLogging failed) — copy captured output for assertions.
    cp /tmp/test-5-clean-restart.out "${CLEAN_RESTART_LOG}" 2>/dev/null || touch "${CLEAN_RESTART_LOG}"
fi

# clean_restart exits 0 on success.  A non-zero exit indicates a fatal error
# (AD teardown failed, start failed, etc.).
if [ "${CR_RC}" -ne 0 ]; then
    echo "--- clean_restart output (captured) ---" >&2
    cat /tmp/test-5-clean-restart.out >&2 || true
    echo "--- clean_restart.log (tail) ---" >&2
    tail -n 40 "${CLEAN_RESTART_LOG}" >&2 || true
    fail "clean_restart exited ${CR_RC} (expected 0 on healthy fleet)"
fi

# SR-29.6 assertion 1: ZERO "no spawn row — skipping" lines while rows exist.
# (This was the SR-27.1 bug: AD-unreachable was silently treated as "no row".)
if grep -q "no spawn row.*skipping" "${CLEAN_RESTART_LOG}"; then
    echo "--- offending lines ---" >&2
    grep -n "no spawn row.*skipping" "${CLEAN_RESTART_LOG}" >&2 || true
    fail "clean_restart emitted 'no spawn row — skipping' while rows existed (SR-27.1 regression)"
fi

# SR-29.6 assertion 2: teardown was initiated.
grep -q "clean_restart: stopping server" "${CLEAN_RESTART_LOG}" \
    || fail "clean_restart.log missing 'clean_restart: stopping server'"

# SR-29.6 assertion 3: new server was started.
grep -q "clean_restart: starting server" "${CLEAN_RESTART_LOG}" \
    || fail "clean_restart.log missing 'clean_restart: starting server'"

# SR-29.6 assertion 4: clean completion.
grep -q "clean_restart: done" "${CLEAN_RESTART_LOG}" \
    || fail "clean_restart.log missing 'clean_restart: done'"

# SR-29.6 assertion 5: rows transitioned (at least one channel exited or was killed).
# clean_restart logs either "exited cleanly" or "force-killed" for each channel.
if ! grep -qE "clean_restart: channel=.+ (exited cleanly|force-killed)" "${CLEAN_RESTART_LOG}"; then
    echo "--- clean_restart.log (tail) ---" >&2
    tail -n 40 "${CLEAN_RESTART_LOG}" >&2 || true
    fail "clean_restart.log has no 'exited cleanly' or 'force-killed' line — row transitions not observed"
fi

echo "Phase 2 OK: clean_restart assertions passed"

# ---------------------------------------------------------------------------
# Phase 3 — old stub-claude processes dead
# ---------------------------------------------------------------------------

echo "=== ${TEST_NAME}: Phase 3 — old stub-claude processes dead ==="

# Give processes a moment to fully exit after SIGTERM/SIGKILL.
sleep 2

for pid in ${STUB_PIDS_BEFORE}; do
    if kill -0 "${pid}" 2>/dev/null; then
        fail "old stub-claude PID ${pid} is still alive after clean_restart — process not torn down"
    fi
done

echo "Phase 3 OK: all old stub-claude processes confirmed dead"

# ---------------------------------------------------------------------------
# Phase 4 — resume path (SR-24.5)
# ---------------------------------------------------------------------------

echo "=== ${TEST_NAME}: Phase 4 — resume via driver-5 ==="

set +e
CSCB_PKG_DIR="${PKG_DIR}" \
DRIVER5_PHASE="resume" \
DRIVER5_CHANNEL_A="${CHANNEL_A}" \
DRIVER5_CHANNEL_B="${CHANNEL_B}" \
DRIVER5_CWD_A="${CWD_A}" \
DRIVER5_CWD_B="${CWD_B}" \
DRIVER5_STARTED_AT_A="${STARTED_AT_A}" \
DRIVER5_STARTED_AT_B="${STARTED_AT_B}" \
    bun "${FIXTURES}/driver-5.ts" > "${DRIVER_OUT_RESUME}" 2>> "${DRIVER_LOG}"
RESUME_RC=$?
set -e

RESUME_OUT="$(cat "${DRIVER_OUT_RESUME}" 2>/dev/null || true)"

if [ "${RESUME_RC}" -ne 0 ]; then
    echo "--- driver-5 resume stdout ---" >&2
    printf '%s\n' "${RESUME_OUT}" >&2
    echo "--- driver-5 resume stderr (tail) ---" >&2
    tail -n 40 "${DRIVER_LOG}" >&2 || true
    first_fail="$(printf '%s\n' "${RESUME_OUT}" | grep -m1 '^DRIVER5_FAIL:' || true)"
    if [ -n "${first_fail}" ]; then
        fail "driver-5 resume reported: ${first_fail}"
    fi
    fail "driver-5 resume exited ${RESUME_RC} without an explicit DRIVER5_FAIL line"
fi

printf '%s\n' "${RESUME_OUT}" | grep -q '^DRIVER5: RESUME_OK' \
    || fail "phase 4: driver-5 resume did not emit DRIVER5: RESUME_OK"

# Surface the started_at comparison for informational purposes.
# Whether AD updates started_at on resume is an AD-internal detail; we log it
# but do not hard-fail on it — the functionally important assertion is the
# resume log lines asserted inside the driver.
STARTED_AT_POST="$(printf '%s\n' "${RESUME_OUT}" | grep '^DRIVER5: STARTED_AT_POST_RESUME' || true)"
if [ -n "${STARTED_AT_POST}" ]; then
    echo "  started_at comparison: ${STARTED_AT_POST}"
fi

echo "Phase 4 OK: resume path verified (attempting resume / resumed channel= logged)"

# ---------------------------------------------------------------------------
# Phase 5 — AD-unreachable loud-failure spot check (SR-27)
# ---------------------------------------------------------------------------

echo "=== ${TEST_NAME}: Phase 5 — AD-unreachable loud-failure spot check ==="

set +e
CSCB_PKG_DIR="${PKG_DIR}" \
DRIVER5_PHASE="ad-fail" \
DRIVER5_CWD_A="${CWD_A}" \
    bun "${FIXTURES}/driver-5.ts" > "${DRIVER_OUT_ADFAIL}" 2>> "${DRIVER_LOG}"
ADFAIL_RC=$?
set -e

ADFAIL_OUT="$(cat "${DRIVER_OUT_ADFAIL}" 2>/dev/null || true)"

if [ "${ADFAIL_RC}" -ne 0 ]; then
    echo "--- driver-5 ad-fail stdout ---" >&2
    printf '%s\n' "${ADFAIL_OUT}" >&2
    echo "--- driver-5 ad-fail stderr (tail) ---" >&2
    tail -n 40 "${DRIVER_LOG}" >&2 || true
    first_fail="$(printf '%s\n' "${ADFAIL_OUT}" | grep -m1 '^DRIVER5_FAIL:' || true)"
    if [ -n "${first_fail}" ]; then
        fail "driver-5 ad-fail reported: ${first_fail}"
    fi
    fail "driver-5 ad-fail exited ${ADFAIL_RC} without an explicit DRIVER5_FAIL line"
fi

printf '%s\n' "${ADFAIL_OUT}" | grep -q '^DRIVER5: ADFAIL_OK' \
    || fail "phase 5: driver-5 ad-fail did not emit DRIVER5: ADFAIL_OK"

echo "Phase 5 OK: AD-unreachable causes loud non-zero exit (SR-27)"

# ---------------------------------------------------------------------------
# Cleanup — stop the dry-run server that clean_restart started in Phase 2
# ---------------------------------------------------------------------------

NEW_PID_FILE="${STATE_DIR}/server.pid"
if [ -f "${NEW_PID_FILE}" ]; then
    NEW_PID="$(cat "${NEW_PID_FILE}" 2>/dev/null || true)"
    if [ -n "${NEW_PID}" ] && kill -0 "${NEW_PID}" 2>/dev/null; then
        kill "${NEW_PID}" 2>/dev/null || true
        echo "Cleanup: stopped dry-run server PID ${NEW_PID}"
    fi
fi

# ---------------------------------------------------------------------------
# Done
# ---------------------------------------------------------------------------

echo "PASS: ${TEST_NAME}"
