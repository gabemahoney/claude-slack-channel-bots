#!/usr/bin/env bash
# b.omv SR-14.1/14.2: real native Claude; all state belongs to this container.
set -euo pipefail
TEST_NAME="test-32-fmk-real-order"
source "$(dirname "$0")/lib/scenario.sh"
source "$(dirname "$0")/lib/real-scenario.sh"
CASE_ASSERT="${SCENARIO_FIXTURES}/real-case-assertions.ts"
case_assert() { bun "${CASE_ASSERT}" "$1" "${SLACK_STATE_DIR}" "${REAL_KEY}" "${SCENARIO_AD_SHIM_LOG}" "${HOME}/.claude/projects" "${@:2}"; }
real_prepare
real_persona order
real_write_config '{"session_restart_delay":0}'
real_start_stub
start_server --live
real_wait_launch "${REAL_KEY}"
real_ad pause --instance-id "$(real_instance "${REAL_KEY}")" >/dev/null
# Ten DMs interleaved with interject and a real minute fire while down.
printf 'order cron fire\n' > "${SCENARIO_ROOT}/order.prompt"
printf '* * * * * %s %s\n' "${SCENARIO_ROOT}/order.prompt" "${REAL_NAME}" > "${SLACK_STATE_DIR}/crontab"
for n in {1..10}; do
    real_dm "${REAL_LABEL}" "order DM ${n}"
    if [[ "${n}" == 3 || "${n}" == 7 ]]; then expect_interject "${REAL_NAME}" 200 "queued interject ${n}"; fi
done
wait_until 180 'scheduled item not durably accepted while down' case_assert accepted 13
printf '' > "${SLACK_STATE_DIR}/crontab"
stop_server
start_server --live
real_wait_launch "${REAL_KEY}"
real_wait_delivery "${REAL_KEY}" 13
# Twenty queued items: actual faults plus bot restart during the blocked head.
real_wait_idle "${REAL_KEY}"
real_fault send-keys key=Enter swallow 1
real_fault send-keys no_enter swallow 1
for n in {1..20}; do real_dm "${REAL_LABEL}" "fault order ${n}"; done
wait_until 180 'first send fault never applied' case_assert fault swallow 1
real_ad kill --instance-id "$(real_instance "${REAL_KEY}")" >/dev/null
stop_server
start_server --live
real_wait_launch "${REAL_KEY}"
real_wait_delivery "${REAL_KEY}" 33
# Ready-state latency is sequential, with observable idle between samples.
for n in {1..20}; do
    real_wait_idle "${REAL_KEY}"
    real_dm "${REAL_LABEL}" "latency ${n}"
    real_wait_delivery "${REAL_KEY}" "$((33+n))"
done
real_assert_latency "${REAL_KEY}" 20

case_assert launches
real_finish "${REAL_KEY}"
echo "PASS: ${TEST_NAME}"
