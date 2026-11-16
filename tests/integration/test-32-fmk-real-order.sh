#!/usr/bin/env bash
# real native Claude; all state belongs to this container.
set -euo pipefail
TEST_NAME="test-32-fmk-real-order"
source "$(dirname "$0")/lib/scenario.sh"
source "$(dirname "$0")/lib/real-scenario.sh"
source "$(dirname "$0")/lib/real-recovery.sh"
CASE_ASSERT="${SCENARIO_FIXTURES}/real-case-assertions.ts"
case_assert() { bun "${CASE_ASSERT}" "$1" "${SLACK_STATE_DIR}" "${REAL_KEY}" "${SCENARIO_AD_SHIM_LOG}" "${HOME}/.claude/projects" "${@:2}"; }
# Test-only CPU profile of each thread phase's measured server over its 20
# samples, enabled only by CSCB_TEST_DIAGNOSTICS=1 (fixtures/cpu-profile.ts):
# one continuous `thread-samples` wave,
# started before the active window and ended after the last sample, so no
# profiler checkpoint falls inside a sample and nothing waits between samples.
# It samples every 100 ms, and the server stops sampling for good
# PROFILE_MAX_S after the start (once, even inside a sample; `outcome=capped`)
# if the phase runs that long, which caps the profile's memory (see the
# budget row in tests/cpu-profile.test.ts). Each sample's push-to-delivery
# interval goes to samples.tsv (`delayed-lookup` and `hung-lookup` for the N4
# lookup samples, `sample` otherwise), and the summary delimits the samples
# by those intervals. The profile stays in scenario scratch; only its
# content-free summary reaches this log, once: after the empty window, or from
# the cleanup hook, which first stops the profile (bounded) while the server
# still runs. No profile step changes this script's status or moves an
# observation boundary.
PROFILER="${SCENARIO_FIXTURES}/cpu-profile.ts"
PROFILE_DIR=""
PROFILE_SUMMARIZED=0
PROFILE_INTERVAL_US=100000
PROFILE_MAX_S=300
PROFILE_START_WAIT_S=5
PROFILE_CLEANUP_STOP_S=10
profile_open() {
    PROFILE_DIR=""
    PROFILE_SUMMARIZED=0
    [[ "${CSCB_TEST_DIAGNOSTICS:-}" == 1 ]] || return 0
    if mkdir -p "${REAL_THREAD_EVIDENCE}/cpu-profile" 2> /dev/null \
        && { printf '%s\n' "${PROFILE_INTERVAL_US}" > "${REAL_THREAD_EVIDENCE}/cpu-profile/interval-us" \
            && printf '%s\n' "${PROFILE_MAX_S}" > "${REAL_THREAD_EVIDENCE}/cpu-profile/max-seconds"; } 2> /dev/null; then
        PROFILE_DIR="${REAL_THREAD_EVIDENCE}/cpu-profile"
    else
        printf 'recorded: cpu-profile unavailable reason=profile-directory\n'
    fi
}
profile_started() {
    [[ -f "${PROFILE_DIR}/observer.jsonl" && "$(< "${PROFILE_DIR}/observer.jsonl")" == *'"phase":"started"'* ]]
}
# Waits up to PROFILE_START_WAIT_S for the start, not once the profiler failed.
profile_begin() {
    [[ -n "${PROFILE_DIR}" ]] || return 0
    local tries
    if ! { printf 'thread-samples\n' >> "${PROFILE_DIR}/waves"; } 2> /dev/null; then return 0; fi
    for ((tries = PROFILE_START_WAIT_S * 10; tries > 0; tries--)); do
        if profile_started; then return 0; fi
        if [[ -e "${PROFILE_DIR}/error.txt" ]]; then break; fi
        sleep 0.1
    done
    printf 'recorded: cpu-profile start unacknowledged wait_s=%s\n' "${PROFILE_START_WAIT_S}"
}
profile_epoch_ms() {
    local us="${EPOCHREALTIME//[!0-9]/}"
    printf -v "$1" '%d' "$(( 10#${us} / 1000 ))"
}
profile_sample_begin() {
    if [[ -n "${PROFILE_DIR}" ]]; then profile_epoch_ms PROFILE_SAMPLE_START_MS; fi
}
profile_sample_end() {
    [[ -n "${PROFILE_DIR}" ]] || return 0
    local wave=sample end_ms
    profile_epoch_ms end_ms
    if [[ "$1" == "${REAL_THREAD_DELAYED_TS}" ]]; then wave=delayed-lookup; elif [[ "$1" == "${REAL_THREAD_HUNG_TS}" ]]; then wave=hung-lookup; fi
    { printf '%s\t%s\t%s\n' "${wave}" "${PROFILE_SAMPLE_START_MS}" "${end_ms}" >> "${PROFILE_DIR}/samples.tsv"; } 2> /dev/null || :
}
profile_end() {
    [[ -n "${PROFILE_DIR}" ]] || return 0
    { printf 'end\n' >> "${PROFILE_DIR}/waves"; } 2> /dev/null || :
}
# Waits up to $1 s for the profile to finish, marking `end` if no `end` is
# marked yet, then prints its summary; once per phase.
profile_collect() {
    [[ -n "${PROFILE_DIR}" && "${PROFILE_SUMMARIZED}" == 0 ]] || return 0
    PROFILE_SUMMARIZED=1
    if [[ -s "${PROFILE_DIR}/waves" ]]; then
        bun "${PROFILER}" stop "${PROFILE_DIR}" "$1" || printf 'recorded: cpu-profile stop unavailable\n'
    fi
    bun "${PROFILER}" summary "${PROFILE_DIR}" "${REAL_THREAD_CONTEXT[@]}" || printf 'recorded: cpu-profile summary unavailable\n'
}
profile_cleanup() { profile_collect "${PROFILE_CLEANUP_STOP_S}"; }
if [[ "${CSCB_TEST_DIAGNOSTICS:-}" == 1 ]]; then on_before_cleanup profile_cleanup; fi
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
stop_server --stop-bots
for thread_mode in strict open; do
    # SR-8: a fresh server state, seeded BEFORE its first start. Alpha takes the
    # real samples; beta's channel takes concurrent shared-state writes (bot
    # calls in open, beta's own live leave and rejoin events in strict).
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
    profile_open
    THREAD_START_MS="$(real_thread_now_ms)"
    if [[ -n "${PROFILE_DIR}" ]]; then
        BUN_OPTIONS="--preload ${SCENARIO_FIXTURES}/cpu-profile-preload.ts" CSCB_TEST_CPU_PROFILE_DIR="${PROFILE_DIR}" start_server --live
    else
        start_server --live
    fi
    THREAD_READY_MS="$(real_thread_now_ms)"
    expect_one_overrides_line thread-measured-start 1 30
    bun "${REAL_SR8}" startup-load "${REAL_THREAD_CONTEXT[@]}" "${THREAD_START_MS}" "${THREAD_READY_MS}"
    bun "${REAL_SR8}" seal measured "${REAL_THREAD_CONTEXT[@]}" "${SLACK_STATE_DIR}/server.log" "${THREAD_LOG_MARK}" "${SLACK_STATE_DIR}/config.json"
    real_wait_launch "${REAL_KEY}" '' "${REAL_CONNECTION_LINE_BASE}"
    real_wait_launch "${REAL_WRITER_KEY}" '' "${REAL_CONNECTION_LINE_BASE}"
    # After the measured window: a channel stays held, and its events
    # unacknowledged, until the authenticated inventory completes.
    wait_membership_complete "${REAL_KEY}"
    wait_membership_complete "${REAL_WRITER_KEY}"
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
    # The profile's start is acknowledged (or given up on) before the active
    # window and the first sample.
    profile_begin
    THREAD_ACTIVE_START="$(date +%s.%6N)"
    THREAD_AD_MARK="$(ad_shim_mark)"
    for ((sample=1; sample<=20; sample++)); do
        real_wait_latency_admission "${REAL_KEY}" "${sample}"
        profile_sample_begin
        THREAD_ENVELOPE="$(real_thread_reply "${sample}")"
        slack_wait_one_ack "${THREAD_ENVELOPE}"
        # The ACK follows the sample's durable admission and precedes delivery
        # preparation, so the work's recorded starts can fall inside the sample.
        real_thread_concurrent_work "${sample}" &
        THREAD_WORK_PID="$!"
        track_pid "${THREAD_WORK_PID}"
        slack_envelope_times "${THREAD_ENVELOPE}" >> "${REAL_THREAD_EVIDENCE}/times.jsonl"
        real_wait_delivery "${REAL_KEY}" "$((sample+1))"
        profile_sample_end "${REAL_THREAD_SAMPLES[sample-1]}"
        shared_queue_snapshot "${REAL_THREAD_EVIDENCE}/queue.jsonl" "${REAL_KEY}" \
            "${REAL_THREAD_EVIDENCE}/queue.jsonl" "${SLACK_STATE_DIR}/receipt-history/${REAL_KEY}.jsonl"
        wait "${THREAD_WORK_PID}" || fail 'concurrent membership/write work failed'
    done
    # Only a mark: the server finishes the profile while the script observes,
    # and nothing waits for it before the empty window.
    profile_end
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
    # After every observation window and before any verdict, so a failing
    # gate keeps the summary.
    profile_collect 30
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
