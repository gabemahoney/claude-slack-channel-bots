#!/usr/bin/env bash
# heavy scenario, outside /ci gate discovery.
set -euo pipefail
TEST_NAME="test-103-fmk-real-latency100"
source "$(dirname "$0")/../integration/lib/scenario.sh"
source "$(dirname "$0")/../integration/lib/real-scenario.sh"
CASE_ASSERT="${SCENARIO_FIXTURES}/real-case-assertions.ts"
case_assert() { bun "${CASE_ASSERT}" "$1" "${SLACK_STATE_DIR}" "${REAL_KEY}" "${SCENARIO_AD_SHIM_LOG}" "${HOME}/.claude/projects" "${@:2}"; }
real_prepare
# Real reply calls resolve candidates before the next measured DM. This
# replaces real_persona's default no-tool acknowledgement instruction.
real_persona latency100 'For every relayed Slack message, call the Slack reply tool with text exactly OK and copy chat_id and message_id from the message; include thread_ts only when present.'
real_write_config
real_start_stub
# Admission requires this launch's own connection after this cursor.
REAL_CONNECTION_LINE_BASE=0
if [[ -f "${SLACK_STATE_DIR}/server.log" ]]; then REAL_CONNECTION_LINE_BASE="$(wc -l < "${SLACK_STATE_DIR}/server.log")"; fi
start_server --live
real_wait_launch "${REAL_KEY}"
real_ad get --instance-id "$(real_instance "${REAL_KEY}")" > "${SCENARIO_ROOT}/relaunch-${REAL_KEY}.json"
# Admission needs a delivered input to audit. This warm-up is not a sample:
# the latency audit measures only the last 100 inputs.
real_dm "${REAL_LABEL}" 'heavy ready-state warm-up'
real_wait_delivery "${REAL_KEY}" 1
# Admit each sample only after prior reply candidates and accepted work drain.
for n in {1..100}; do
    real_wait_latency_admission "${REAL_KEY}" "${n}"
    real_dm "${REAL_LABEL}" "heavy ready-state latency ${n}"
    real_wait_delivery "${REAL_KEY}" "$((n+1))"
done
real_assert_latency "${REAL_KEY}" 100

case_assert launches
real_finish "${REAL_KEY}"
echo "PASS: ${TEST_NAME}"
