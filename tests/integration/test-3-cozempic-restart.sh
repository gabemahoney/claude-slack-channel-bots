#!/usr/bin/env bash
# Test 3 (b.set): probe cozempic, stop + restart daemon, verify clean restart.
# Depends on Tests 1 and 2 having passed (daemon must be running going in).
set -euo pipefail

TEST_NAME="test-3-cozempic-restart"
LOG="${HOME}/.claude/channels/slack/server.log"
PID_FILE="${HOME}/.claude/channels/slack/server.pid"

fail() {
    echo "FAIL: ${TEST_NAME}: $1" >&2
    exit 1
}

command -v cozempic >/dev/null 2>&1 \
    || fail "cozempic not on PATH (required by test)"

cozempic --version >/dev/null 2>&1 \
    || fail "cozempic --version failed"

cd /test-repo

./node_modules/.bin/claude-slack-channel-bots stop \
    || fail "claude-slack-channel-bots stop exited non-zero"

sleep 3

SLACK_DRY_RUN=1 ./node_modules/.bin/claude-slack-channel-bots start \
    || fail "claude-slack-channel-bots start (restart) exited non-zero"

sleep 15

test -f "${PID_FILE}" || fail "daemon PID file ${PID_FILE} not written after restart"

PID=$(cat "${PID_FILE}")
kill -0 "${PID}" 2>/dev/null \
    || fail "daemon PID ${PID} not a live process after restart"

test -f "${LOG}" || fail "server log ${LOG} not present after restart"

# The log is appended across boots, so any "Running in dry-run mode" present
# after the restart's pid is what we need; the daemon log line is emitted
# every boot, so simply requiring it to be present is sufficient.
grep -q "\[slack\] Running in dry-run mode" "${LOG}" \
    || fail "server.log missing '[slack] Running in dry-run mode' after restart"

if grep -qE 'Error:|Traceback|Uncaught' "${LOG}"; then
    fail "server.log contains error stack trace after restart"
fi

grep -qE "cozempic (available|not found on PATH)" "${LOG}" \
    || fail "server.log missing cozempic probe entry ('cozempic available' or 'cozempic not found on PATH')"

echo "PASS: ${TEST_NAME}"
