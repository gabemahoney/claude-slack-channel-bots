#!/usr/bin/env bash
# Test 2 (b.3hy): verify the persona config loaded, startupSessionManager ran
# and dry-run skipped the spawn of both personas (the zero-channel one
# included), then check /interject's status codes on the daemon's port.
# Depends on Test 1 having left the daemon running with its two-persona config.
# Runs only in a cscb-ci image: without its marker, refuse before any other step.
if [[ ! -e /etc/cscb-ci-image ]]; then
    echo "FAIL: test-2-dryrun-spawn-skip: refused: /etc/cscb-ci-image is absent; this test runs only in a cscb-ci image (/ci)" >&2
    exit 1
fi

set -euo pipefail

TEST_NAME="test-2-dryrun-spawn-skip"
LOG="${HOME}/.claude/channels/slack/server.log"
PID_FILE="${HOME}/.claude/channels/slack/server.pid"
INTERJECT_URL="http://127.0.0.1:3100/interject"

fail() {
    echo "FAIL: ${TEST_NAME}: $1" >&2
    exit 1
}

test -f "${PID_FILE}" || fail "daemon PID file ${PID_FILE} not present (Test 1 prerequisite)"
kill -0 "$(cat "${PID_FILE}")" 2>/dev/null \
    || fail "daemon not running (Test 1 prerequisite)"

test -f "${LOG}" || fail "server log ${LOG} not present"

expect_log() {
    grep -qF "$1" "${LOG}" || fail "server.log missing '$1'"
}

expect_log '[slack] Loaded persona config: 2 persona(s)'
expect_log '[slack] startupSessionManager: 2 persona(s)'
expect_log '[slack] dry-run: skipping spawn for "alpha" (key=alpha) cwd=/tmp/test-repo-a'
expect_log '[slack] dry-run: skipping spawn for "bravo" (key=bravo) cwd=/tmp/test-repo-b'

# The completion line, checked in parts so a count added to it later does not
# break the test: both personas are no-ops, none failed, all were brought up.
COMPLETE_PREFIX='[slack] startupSessionManager: complete — 2 persona(s):'
complete_line="$(grep -F "${COMPLETE_PREFIX}" "${LOG}" | tail -n 1 || true)"
[ -n "${complete_line}" ] || fail "server.log missing '${COMPLETE_PREFIX}'"
for part in '2 no-op' '0 failed' '0 not brought up'; do
    case "${complete_line}" in
        *[:,]" ${part},"* | *[:,]" ${part}") ;;
        *) fail "startupSessionManager completion line lacks '${part}': ${complete_line}" ;;
    esac
done

# --- /interject (b.av2 SR-9.1) ----------------------------------------------
# POST a body naming `$1`; print the HTTP status code. A call that gets no
# HTTP response (refused, timed out) prints 000 and returns 0, so the status
# check below fails with a FAIL: line instead of `set -e` ending the script.
interject_status() {
    curl -s --max-time 10 -o /dev/null -w '%{http_code}' -X POST \
        -H 'Content-Type: application/json' \
        -d "{\"persona\": \"$1\", \"message\": \"test-2 interject\"}" \
        "${INTERJECT_URL}" || true
}

status="$(interject_status "no_such_persona")"
[ "${status}" = "404" ] \
    || fail "/interject for an unknown persona returned ${status}, expected 404"

# A known persona with no connected session (dry run never launches one).
status="$(interject_status "alpha")"
[ "${status}" = "503" ] \
    || fail "/interject for persona alpha (no connected session) returned ${status}, expected 503"

echo "PASS: ${TEST_NAME}"
