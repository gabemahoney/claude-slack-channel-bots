#!/usr/bin/env bash
# Test 3 (b.set): probe cozempic, stop + restart daemon, verify clean restart.
# Depends on Tests 1 and 2 having passed (daemon must be running going in).
#
# `stop --stop-bots` reads the persona config from the path the server loads
# and tears down each persona's instance cscb_<key> (b.av2 SR-8.7). Dry run
# never spawned one, so it reports no spawn row for each persona. The restart
# runs with SLACK_BOT_TOKEN and SLACK_APP_TOKEN unset (AC 47).
# Runs only in a cscb-ci image: without its marker, refuse before any other step.
if [[ ! -e /etc/cscb-ci-image ]]; then
    echo "FAIL: test-3-cozempic-restart: refused: /etc/cscb-ci-image is absent; this test runs only in a cscb-ci image (/ci)" >&2
    exit 1
fi

set -euo pipefail

TEST_NAME="test-3-cozempic-restart"
LOG="${HOME}/.claude/channels/slack/server.log"
STOP_OUT="/tmp/test-3-stop.out"
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

# The log is appended across boots: count the spawn-skip lines before the
# restart so the restart's own lines can be told apart.
count_log() {
    grep -cF "$1" "${LOG}" || true
}
SKIP_ALPHA='[slack] dry-run: skipping spawn for "alpha" (key=alpha) cwd=/tmp/test-repo-a'
SKIP_BRAVO='[slack] dry-run: skipping spawn for "bravo" (key=bravo) cwd=/tmp/test-repo-b'
ALPHA_BEFORE="$(count_log "${SKIP_ALPHA}")"
BRAVO_BEFORE="$(count_log "${SKIP_BRAVO}")"

./node_modules/.bin/claude-slack-channel-bots stop --stop-bots > "${STOP_OUT}" 2>&1 \
    || { cat "${STOP_OUT}" >&2; fail "claude-slack-channel-bots stop --stop-bots exited non-zero"; }

for persona in alpha bravo; do
    grep -qF "[slack] teardownBots: no spawn row for persona \"${persona}\" (key=${persona}) — skipping" "${STOP_OUT}" \
        || { cat "${STOP_OUT}" >&2; fail "stop --stop-bots output does not name persona ${persona} (key=${persona})"; }
done

sleep 3

env -u SLACK_BOT_TOKEN -u SLACK_APP_TOKEN SLACK_DRY_RUN=1 ./node_modules/.bin/claude-slack-channel-bots start \
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

# The restart skipped the spawn of each persona again.
[ "$(count_log "${SKIP_ALPHA}")" -gt "${ALPHA_BEFORE}" ] \
    || fail "server.log missing a new '${SKIP_ALPHA}' after restart"
[ "$(count_log "${SKIP_BRAVO}")" -gt "${BRAVO_BEFORE}" ] \
    || fail "server.log missing a new '${SKIP_BRAVO}' after restart"

echo "PASS: ${TEST_NAME}"
