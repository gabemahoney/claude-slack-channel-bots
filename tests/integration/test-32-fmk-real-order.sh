#!/usr/bin/env bash
# b.omv SR-14.1/14.2: real native Claude; all state belongs to this container.
set -euo pipefail
TEST_NAME="test-32-fmk-real-order"
source "$(dirname "$0")/lib/scenario.sh"
source "$(dirname "$0")/lib/real-scenario.sh"
source "$(dirname "$0")/lib/real-recovery.sh"
CASE_ASSERT="${SCENARIO_FIXTURES}/real-case-assertions.ts"
case_assert() { bun "${CASE_ASSERT}" "$1" "${SLACK_STATE_DIR}" "${REAL_KEY}" "${SCENARIO_AD_SHIM_LOG}" "${HOME}/.claude/projects" "${@:2}"; }
real_prepare
real_persona order
real_write_config '{"session_restart_delay":0}'
real_start_stub
start_server --live
real_wait_launch "${REAL_KEY}"
# A pause alone permits message-triggered relaunch during intake. Refuse
# launches before pausing; these faults never invoke the real launch binary.
real_fault spawn '*' unknown-untyped 999999
real_fault resume '*' unknown-untyped 999999
real_ad pause --instance-id "$(real_instance "${REAL_KEY}")" >/dev/null
DOWN_ROW="${SCENARIO_ROOT}/order-down-row.json"
real_ad get --instance-id "$(real_instance "${REAL_KEY}")" > "${DOWN_ROW}"
DOWN_MARK="$(ad_shim_mark)"
# Ten DMs interleaved with interject and a real minute fire while down.
printf 'order cron fire\n' > "${SCENARIO_ROOT}/order.prompt"
printf '* * * * * %s %s\n' "${SCENARIO_ROOT}/order.prompt" "${REAL_NAME}" > "${SLACK_STATE_DIR}/crontab"
for n in {1..10}; do
    real_dm "${REAL_LABEL}" "order DM ${n}"
    if [[ "${n}" == 3 || "${n}" == 7 ]]; then expect_interject "${REAL_NAME}" 200 "queued interject ${n}"; fi
done
wait_until 180 'scheduled item not durably accepted while down' case_assert accepted 13
printf '' > "${SLACK_STATE_DIR}/crontab"
# The first minute fire can precede the production retry's first attempt.
# Keep the bot down until that attempt has exercised the counted refusal.
wait_until 180 'message-triggered relaunch was not refused while down' case_assert fault unknown-untyped 1
stop_server
real_ad get --instance-id "$(real_instance "${REAL_KEY}")" > "${DOWN_ROW}.end"
case_assert down "${DOWN_ROW}" "${DOWN_MARK}" 13
# The server is stopped, so no new launch can race the verified interval's
# release. Only this phase's two launch rules exist in this fault file.
{ flock -x 8; printf '' > "${SCENARIO_AD_SHIM_LOG%.log}.faults"; } 8> "${SCENARIO_AD_SHIM_LOG%.log}.faults.lock"
start_server --live
real_wait_launch "${REAL_KEY}"
real_wait_delivery "${REAL_KEY}" 13
# Twenty queued items: actual faults plus bot restart during the blocked head.
real_wait_idle "${REAL_KEY}"
real_fault send-keys key=Enter swallow 1
real_fault send-keys no_enter swallow 1
for n in {1..20}; do real_dm "${REAL_LABEL}" "fault order ${n}"; done
wait_until 180 'first send fault never applied' case_assert fault swallow 1
real_kill_and_reconcile "${REAL_KEY}"
start_server --live
real_wait_relaunch "${REAL_KEY}"
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
