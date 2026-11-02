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
# Count original Slack/cron/interject inputs separately from legitimate no-reply reminders.
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
case_assert reply-permission-resume "${REAL_KILLED_ROW}" "${SCENARIO_ROOT}/relaunch-${REAL_KEY}.json"
real_wait_delivery "${REAL_KEY}" 33
# Admit each sample only after prior reply candidates and accepted work drain.
for n in {1..20}; do
    real_wait_latency_admission "${REAL_KEY}" "$((33+n-1))"
    real_dm "${REAL_LABEL}" "latency ${n}"
    real_wait_delivery "${REAL_KEY}" "$((33+n))"
done
real_assert_latency "${REAL_KEY}" 20

case_assert launches
stop_server --stop-bots
for thread_mode in strict open; do
    # SR-8: a fresh server state, seeded BEFORE its first start. Alpha takes the
    # real samples; beta's separate session supplies concurrent shared-state writes.
    real_thread_personas "${thread_mode}"
    real_seed_threads
    start_server --live
    expect_one_overrides_line thread-first-start 0 30
    bun "${REAL_SR8}" seal first "${REAL_THREAD_CONTEXT[@]}" "${SLACK_STATE_DIR}/server.log" 0 "${SLACK_STATE_DIR}/config.json"
    real_wait_launch "${REAL_KEY}"
    real_wait_launch "${REAL_WRITER_KEY}"
    stop_server --stop-bots
    THREAD_LOG_MARK="$(wc -c < "${SLACK_STATE_DIR}/server.log")"
    REAL_CONNECTION_LINE_BASE="$(wc -l < "${SLACK_STATE_DIR}/server.log")"
    THREAD_START_MS="$(real_thread_now_ms)"
    start_server --live
    THREAD_READY_MS="$(real_thread_now_ms)"
    expect_one_overrides_line thread-measured-start 1 30
    bun "${REAL_SR8}" startup-load "${REAL_THREAD_CONTEXT[@]}" "${THREAD_START_MS}" "${THREAD_READY_MS}"
    bun "${REAL_SR8}" seal measured "${REAL_THREAD_CONTEXT[@]}" "${SLACK_STATE_DIR}/server.log" "${THREAD_LOG_MARK}" "${SLACK_STATE_DIR}/config.json"
    real_wait_launch "${REAL_KEY}" '' "${REAL_CONNECTION_LINE_BASE}"
    real_wait_launch "${REAL_WRITER_KEY}" '' "${REAL_CONNECTION_LINE_BASE}"
    real_ad get --instance-id "$(real_instance "${REAL_KEY}")" > "${SCENARIO_ROOT}/relaunch-${REAL_KEY}.json"
    real_thread_writer_start
    real_thread_workload
    THREAD_ROOT_ENVELOPE="$(real_thread_root)"
    slack_wait_one_ack "${THREAD_ROOT_ENVELOPE}"
    real_wait_delivery "${REAL_KEY}" 1
    slack_stub_fault "${REAL_LABEL}" users.info delay "user=${REAL_THREAD_DELAYED_USER}" "delay_ms=${REAL_THREAD_LOOKUP_DELAY_MS}" times=1
    slack_stub_fault "${REAL_LABEL}" users.info hang "user=${REAL_THREAD_HUNG_USER}" times=1
    : > "${REAL_THREAD_EVIDENCE}/times.jsonl"
    : > "${REAL_THREAD_EVIDENCE}/operations.tsv"
    shared_queue_snapshot "${REAL_THREAD_EVIDENCE}/queue.jsonl" "${REAL_KEY}" "${SLACK_STATE_DIR}/receipt-history/${REAL_KEY}.jsonl"
    THREAD_INSTANCE="$(real_instance "${REAL_KEY}")"
    THREAD_ACTIVE_START="$(date +%s.%6N)"
    THREAD_AD_MARK="$(ad_shim_mark)"
    for ((sample=1; sample<=20; sample++)); do
        real_wait_latency_admission "${REAL_KEY}" "${sample}"
        THREAD_ENVELOPE="$(real_thread_reply "${sample}")"
        slack_wait_one_ack "${THREAD_ENVELOPE}"
        # The ACK follows the sample's durable admission and precedes delivery
        # preparation, so the work's recorded starts can fall inside the sample.
        real_thread_concurrent_work "${sample}" &
        THREAD_WORK_PID="$!"
        track_pid "${THREAD_WORK_PID}"
        slack_envelope_times "${THREAD_ENVELOPE}" >> "${REAL_THREAD_EVIDENCE}/times.jsonl"
        real_wait_delivery "${REAL_KEY}" "$((sample+1))"
        shared_queue_snapshot "${REAL_THREAD_EVIDENCE}/queue.jsonl" "${REAL_KEY}" \
            "${REAL_THREAD_EVIDENCE}/queue.jsonl" "${SLACK_STATE_DIR}/receipt-history/${REAL_KEY}.jsonl"
        wait "${THREAD_WORK_PID}" || fail 'concurrent membership/write work failed'
    done
    # Admission proves every reply candidate and accepted item has drained. Both
    # endpoint checks are harness AD reads, excluded by ad_cscb_calls.
    real_wait_latency_admission "${REAL_KEY}" 21
    THREAD_EMPTY_START="$(date +%s.%6N)"
    sleep 10
    real_wait_latency_admission "${REAL_KEY}" 21
    THREAD_AD_END_MARK="$(ad_shim_mark)"
    THREAD_EMPTY_END="$(date +%s.%6N)"
    printf '%s\t%s\t%s\n' "${THREAD_INSTANCE}" "${THREAD_EMPTY_START}" "${THREAD_EMPTY_END}" > "${REAL_THREAD_EVIDENCE}/empty.tsv"
    printf '%s\t%s\t%s\n' "${THREAD_INSTANCE}" "${THREAD_ACTIVE_START}" "${THREAD_EMPTY_START}" > "${REAL_THREAD_EVIDENCE}/active.tsv"
    ad_cscb_calls "${THREAD_INSTANCE}" "${THREAD_AD_MARK}" "${THREAD_AD_END_MARK}" > "${REAL_THREAD_EVIDENCE}/ad.tsv"
    bun "${REAL_SR8}" conditions "${SLACK_STATE_DIR}" "${SERVER_PID}"
    shared_queue_snapshot "${REAL_THREAD_EVIDENCE}/queue.jsonl" "${REAL_KEY}" \
        "${REAL_THREAD_EVIDENCE}/queue.jsonl" "${SLACK_STATE_DIR}/receipt-history/${REAL_KEY}.jsonl"
    # Clean shutdown awaits and drains the measurement recorder before n4 reads it.
    stop_server --stop-bots
    THREAD_N2_STATUS=0
    real_assert_thread_latency > "${REAL_THREAD_EVIDENCE}/n2.txt" || THREAD_N2_STATUS="$?"
    cat "${REAL_THREAD_EVIDENCE}/n2.txt"
    THREAD_N4_STATUS=0
    bun "${REAL_SR8}" n4 "${REAL_THREAD_CONTEXT[@]}" \
        "${SLACK_STATE_DIR}/$(bun "${SCENARIO_FIXTURES}/fmk-texts.ts" TEST_MEASUREMENTS_FILE_NAME)" 0 \
        "${REAL_KEY}" "${REAL_THREAD_EVIDENCE}/queue.jsonl" "${REAL_THREAD_EVIDENCE}/times.jsonl" "${SCENARIO_SLACK_RECORD}" "${REAL_THREAD_EVIDENCE}/n2.txt" \
        "${REAL_THREAD_HUNG_TS}" "${REAL_THREAD_HUNG_USER}" "${REAL_THREAD_DELAYED_TS}" "${REAL_THREAD_DELAYED_USER}" || THREAD_N4_STATUS="$?"
    THREAD_N3_STATUS=0
    bun "${REAL_SR8}" windows "${REAL_THREAD_CONTEXT[@]}" "${REAL_THREAD_EVIDENCE}/ad.tsv" "${REAL_THREAD_EVIDENCE}/empty.tsv" "${REAL_THREAD_EVIDENCE}/active.tsv" || THREAD_N3_STATUS="$?"
    THREAD_OVERLAP_STATUS=0
    bun "${REAL_RECEIPTS}" thread-intervals "${REAL_KEY}" "${REAL_CHANNEL}" \
        "${REAL_THREAD_EVIDENCE}/queue.jsonl" "${REAL_THREAD_SAMPLES[@]}" > "${REAL_THREAD_EVIDENCE}/sample-intervals.tsv" || THREAD_OVERLAP_STATUS=1
    bun "${REAL_SR8}" concurrent-overlap "${REAL_THREAD_CONTEXT[@]}" \
        "${REAL_THREAD_EVIDENCE}/operations.tsv" "${REAL_THREAD_EVIDENCE}/sample-intervals.tsv" "${REAL_THREAD_EVIDENCE}/n2.txt" || THREAD_OVERLAP_STATUS=1
    (( THREAD_N2_STATUS == 0 && THREAD_N4_STATUS == 0 && THREAD_N3_STATUS == 0 && THREAD_OVERLAP_STATUS == 0 )) || fail 'SR-8 real-thread evidence failed'
done
real_finish "${REAL_KEY}"
echo "PASS: ${TEST_NAME}"
