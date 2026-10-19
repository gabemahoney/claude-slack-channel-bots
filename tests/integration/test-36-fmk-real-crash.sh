#!/usr/bin/env bash
# b.omv SR-14.1/14.2: real native Claude; all state belongs to this container.
set -euo pipefail
TEST_NAME="test-36-fmk-real-crash"
source "$(dirname "$0")/lib/scenario.sh"
source "$(dirname "$0")/lib/real-scenario.sh"
CASE_ASSERT="${SCENARIO_FIXTURES}/real-case-assertions.ts"
case_assert() { bun "${CASE_ASSERT}" "$1" "${SLACK_STATE_DIR}" "${REAL_KEY}" "${SCENARIO_AD_SHIM_LOG}" "${HOME}/.claude/projects" "${@:2}"; }
real_prepare
real_persona crash
real_write_config
real_start_stub
start_server --live
real_wait_launch "${REAL_KEY}"
real_fault send-keys key=Enter delay=10000 1
real_dm "${REAL_LABEL}" 'crash between text and Enter'
wait_until 180 'delayed Enter never reached' case_assert fault delay=10000
# Real SIGKILL of the server, not graceful stop or a simulated exit.
CRASH_PID="$(server_pid)"
kill -KILL "${CRASH_PID}"
wait_until 30 'killed server remains live' _scenario_pid_gone "${CRASH_PID}"
start_server --live
real_wait_launch "${REAL_KEY}"
real_dm "${REAL_LABEL}" 'after crash queued item'
real_wait_delivery "${REAL_KEY}" 2

case_assert launches
real_finish "${REAL_KEY}"
echo "PASS: ${TEST_NAME}"
