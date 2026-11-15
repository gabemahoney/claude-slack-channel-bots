#!/usr/bin/env bash
# real native Claude; all state belongs to this container.
set -euo pipefail
TEST_NAME="test-32-fmk-real-order"
source "$(dirname "$0")/lib/scenario.sh"
source "$(dirname "$0")/lib/real-scenario.sh"
source "$(dirname "$0")/lib/real-recovery.sh"
CASE_ASSERT="${SCENARIO_FIXTURES}/real-case-assertions.ts"
case_assert() { bun "${CASE_ASSERT}" "$1" "${SLACK_STATE_DIR}" "${REAL_KEY}" "${SCENARIO_AD_SHIM_LOG}" "${HOME}/.claude/projects" "${@:2}"; }
real_prepare
# Real reply calls resolve candidates before the next measured DM. This
# replaces real_persona's default no-tool acknowledgement instruction.
real_persona order 'For every relayed Slack message, call the Slack reply tool with text exactly OK and copy chat_id and message_id from the message; include thread_ts only when present.'
real_write_config '{"session_restart_delay":0}'
real_start_stub
start_server --live
real_wait_launch "${REAL_KEY}"
# A prompt-free Claude launch may have no transcript to resume. Complete one
# real turn through the ordinary receipt/FIFO audit on either AD runtime.
real_dm "${REAL_LABEL}" 'order before-pause turn'
real_wait_delivery "${REAL_KEY}" 1
real_wait_idle "${REAL_KEY}"
# A pause alone permits message-triggered relaunch during intake. Refuse
# launches before pausing; these faults never invoke the real launch binary.
real_fault spawn '*' unknown-untyped 999999
real_fault resume '*' unknown-untyped 999999
DOWN_ROW="${SCENARIO_ROOT}/order-down-row.json"
real_ad get --instance-id "$(real_instance "${REAL_KEY}")" > "${DOWN_ROW}.before-pause"
case_assert before-pause-transcript "${DOWN_ROW}.before-pause"
real_ad pause --instance-id "$(real_instance "${REAL_KEY}")" >/dev/null
# set -e prevents this proof from being written if our own pause failed.
printf '%s\n' "$(real_instance "${REAL_KEY}")" > "${DOWN_ROW}.pause-succeeded"
real_ad get --instance-id "$(real_instance "${REAL_KEY}")" > "${DOWN_ROW}"
case_assert down-start "${DOWN_ROW}"
DOWN_MARK="$(ad_shim_mark)"
# Ten DMs interleaved with interject and a real minute fire while down.
printf 'order cron fire\n' > "${SCENARIO_ROOT}/order.prompt"
printf '* * * * * %s %s\n' "${SCENARIO_ROOT}/order.prompt" "${REAL_NAME}" > "${SLACK_STATE_DIR}/crontab"
for n in {1..10}; do
    real_dm "${REAL_LABEL}" "order DM ${n}"
    if [[ "${n}" == 3 || "${n}" == 7 ]]; then expect_interject "${REAL_NAME}" 200 "queued interject ${n}"; fi
done
wait_until 180 'scheduled item not durably accepted while down' case_assert accepted 14
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
# AD resume retains session_id: prove conversation continuity before auditing
# the queued work, using the row captured before our own successful pause.
real_ad get --instance-id "$(real_instance "${REAL_KEY}")" > "${DOWN_ROW}.resumed"
case_assert same-conversation-resume "${DOWN_ROW}.before-pause" "${DOWN_ROW}.resumed"
# Count original Slack/cron/interject inputs separately from legitimate no-reply reminders.
real_wait_delivery "${REAL_KEY}" 14
# Twenty queued items: actual faults plus bot restart during the blocked head.
real_wait_idle "${REAL_KEY}"
ORDER_ROW="${SCENARIO_ROOT}/order-fault-row.json"
real_ad get --instance-id "$(real_instance "${REAL_KEY}")" > "${ORDER_ROW}"
ORDER_COVERAGE="$(jq -r '.busy_send // "not_covered"' "${ORDER_ROW}")"
FAULT_MARK="$(ad_shim_mark)"
case "${ORDER_COVERAGE}" in
    covered)
        # Run the real confirmed send, lose only its reply, then recover the
        # durable caller/request pair through get-delivery (AD's contract).
        real_fault send-keys send_mode=wait_turn unknown-typed 1 ;;
    not_covered)
        real_fault send-keys key=Enter swallow 1
        real_fault send-keys no_enter swallow 1 ;;
    *) fail 'unknown AD coverage for order fault leg' ;;
esac
for n in {1..20}; do real_dm "${REAL_LABEL}" "fault order ${n}"; done
if [[ "${ORDER_COVERAGE}" == covered ]]; then
    wait_until 180 'covered send reply fault never applied' case_assert covered-send-fault "${FAULT_MARK}"
else
    wait_until 180 'first send fault never applied' case_assert fault swallow 1
fi
real_kill_and_reconcile "${REAL_KEY}"
start_server --live
real_wait_relaunch "${REAL_KEY}"
case_assert reply-permission-resume "${REAL_KILLED_ROW}" "${SCENARIO_ROOT}/relaunch-${REAL_KEY}.json"
if [[ "${ORDER_COVERAGE}" == covered ]]; then
    real_wait_delivery "${REAL_KEY}" 34 -- case_assert covered-lost-reply-proof 34 "${FAULT_MARK}"
else
    real_wait_delivery "${REAL_KEY}" 34
fi
# Admit each sample only after prior reply candidates and accepted work drain.
for n in {1..20}; do
    real_wait_latency_admission "${REAL_KEY}" "$((34+n-1))"
    real_dm "${REAL_LABEL}" "latency ${n}"
    real_wait_delivery "${REAL_KEY}" "$((34+n))"
done
real_assert_latency "${REAL_KEY}" 20

case_assert launches
real_finish "${REAL_KEY}"
echo "PASS: ${TEST_NAME}"
