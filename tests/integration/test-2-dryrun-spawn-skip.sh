#!/usr/bin/env bash
# Test 2 (b.3hy): verify startupSessionManager ran and dry-run skipped spawn.
# Depends on Test 1 having left the daemon running.
set -euo pipefail

TEST_NAME="test-2-dryrun-spawn-skip"
LOG="${HOME}/.claude/channels/slack/server.log"
PID_FILE="${HOME}/.claude/channels/slack/server.pid"

fail() {
    echo "FAIL: ${TEST_NAME}: $1" >&2
    exit 1
}

test -f "${PID_FILE}" || fail "daemon PID file ${PID_FILE} not present (Test 1 prerequisite)"
kill -0 "$(cat "${PID_FILE}")" 2>/dev/null \
    || fail "daemon not running (Test 1 prerequisite)"

test -f "${LOG}" || fail "server log ${LOG} not present"

grep -q "startupSessionManager: 1 route" "${LOG}" \
    || fail "server.log missing 'startupSessionManager: 1 route(s)'"

grep -q "dry-run: skipping spawn for channel=C_TEST1" "${LOG}" \
    || fail "server.log missing '[slack] dry-run: skipping spawn for channel=C_TEST1'"

grep -q "startupSessionManager: complete" "${LOG}" \
    || fail "server.log missing 'startupSessionManager: complete'"

echo "PASS: ${TEST_NAME}"
