#!/usr/bin/env bash
# SR-8 populations, actual Socket Mode ACKs, Post Holds and AC-U10.
# Run only through /ci. Each child invocation gets a fresh scenario HOME.
# Silent AD workers retain all accepted work; separate fixture MCP clients
# submit the bot's own posts without making those workers ready for delivery.
set -euo pipefail
TEST_NAME="test-44-fmk-thread-burst"
# shellcheck source=lib/scenario.sh
source "$(dirname "$0")/lib/scenario.sh"

PRINTER="${SCENARIO_FIXTURES}/fmk-texts.ts"
SR8="${SCENARIO_FIXTURES}/sr8-evidence.ts"
BURST_DRIVER="${SCENARIO_FIXTURES}/burst-driver.sh"
EVIDENCE="${SCENARIO_ROOT}/evidence"
mkdir -p "${EVIDENCE}"
RECORD_WAIT_S=30
CONFIG="${SLACK_STATE_DIR}/config.json"
LAST="${CONFIG}.last-applied"
LOG="${SLACK_STATE_DIR}/server.log"
printed() { bun "${PRINTER}" "$@" || fail "printer entry $1 failed"; }
mono_ms() { python3 -c 'import time; print(time.monotonic_ns() / 1000000)'; }
byte_mark() { if [[ -e "$1" ]]; then stat -c %s "$1"; else printf '0\n'; fi; }
# Runs one sr8-evidence verdict command and prints all its rows; a failing
# exit then prints a FAIL line in fail's form naming each fail/missing verdict (with its
# persona, if any), so the runner's FAIL line says which measures failed, and
# exits with the command's own status (64 for a usage error, 137 when killed).
sr8_verdicts() {
    local rows="${EVIDENCE}/verdicts.txt" status=0 line name failed=()
    local verdict_re='^recorded: sr8 ([^ ]+) .* verdict=(fail|missing)$' persona_re=' persona=([^ ]+) '
    bun "${SR8}" "$@" > "${rows}" || status=$?
    cat "${rows}"
    (( status == 0 )) && return 0
    while IFS= read -r line; do
        [[ "${line}" =~ ${verdict_re} ]] || continue
        name="${BASH_REMATCH[1]}=${BASH_REMATCH[2]}"
        if [[ "${line}" =~ ${persona_re} ]]; then name="${name%=*}[${BASH_REMATCH[1]}]=${name##*=}"; fi
        failed+=("${name}")
    done < "${rows}"
    echo "FAIL: ${TEST_NAME}: ${failed[*]:-sr8 $1 exited ${status} with no verdict} (${mode}/${population}/${recipients})" >&2
    exit "${status}"
}

# These are serial child invocations of this same script, not additional CI
# scripts. sr8Combinations owns their order and populations. Do not split or
# reduce the workload without the Task's measured shard-limit evidence.
case "${1:-all}" in
    all)
        bun "${SR8}" combinations > "${EVIDENCE}/combinations.tsv"
        while IFS=$'\t' read -r population mode recipients; do
            bash "$0" burst "${mode}" "${population}" "${recipients}"
        done < "${EVIDENCE}/combinations.tsv"
        # Decision 29 ruling: each pending post stays unresolved through a full
        # SR-8.2 burst, and maintenance cannot compact between its two reads.
        for mode in strict open; do bash "$0" pending "${mode}" 100000 2; done
        # This invocation also needs its own server-backed closing evidence.
        CASE=shared-list; mode=open; population=0; recipients=2
        ;;
    burst|pending|shared-list) CASE="$1"; mode="$2"; population="$3"; recipients="$4" ;;
    *) fail 'unknown SR-8 case' ;;
esac
CONTEXT=("${TEST_NAME}" "${mode}" "${population}" "${recipients}")
CASE_ROOT="${SCENARIO_ROOT}/people"
mkdir -p "${CASE_ROOT}"
compact_ms="$(printed QUEUE_COMPACT_INTERVAL_MS)"
if [[ "${CASE}" == burst && "${population}" == 100000 ]]; then
    compact_ms="$(printed effectiveTestTimer queue_compact_interval_ms queue_compact_interval_ms=250)"
elif [[ "${CASE}" == pending ]]; then
    # No override: the production interval must outlast this whole case, which
    # pending-post checks against the measured window.
    compact_ms="$(printed effectiveTestTimer queue_compact_interval_ms)"
fi
config_args=("${mode}" "${population}" "${recipients}" "${CASE_ROOT}" "${SCENARIO_PORT}" "${compact_ms}")
if [[ "${CASE}" == burst ]]; then
    # The server's diagnostic ack/append/save rows, read only by observe below.
    config_args+=(timings)
fi
bun "${SR8}" config "${config_args[@]}" | write_config
# Test-only CPU profile of the measured server over the burst waves: only
# this burst case opts in. The profile stays in scenario scratch; only its
# content-free summary reaches this log, once: right after the profile stops,
# or from the cleanup hook when the script ends before that. No profile step
# changes this script's status.
PROFILER="${SCENARIO_FIXTURES}/cpu-profile.ts"
PROFILE_DIR=""
PROFILE_SUMMARIZED=0
profile_stop() {
    [[ -n "${PROFILE_DIR}" ]] || return 0
    bun "${PROFILER}" stop "${PROFILE_DIR}" 30 || printf 'recorded: cpu-profile stop unavailable\n'
}
profile_summary() {
    [[ -n "${PROFILE_DIR}" && "${PROFILE_SUMMARIZED}" == 0 ]] || return 0
    PROFILE_SUMMARIZED=1
    bun "${PROFILER}" summary "${PROFILE_DIR}" "${CONTEXT[@]}" || printf 'recorded: cpu-profile summary unavailable\n'
}
if [[ "${CASE}" == burst ]]; then
    if mkdir -p "${EVIDENCE}/cpu-profile" 2> /dev/null; then
        PROFILE_DIR="${EVIDENCE}/cpu-profile"
        on_before_cleanup profile_summary
    else
        printf 'recorded: cpu-profile unavailable reason=profile-directory\n'
    fi
fi
OVERRIDES_LINE="$(printed buildTestTimerOverridesLine "queue_compact_interval_ms=${compact_ms}")"
OVERRIDES_STEM="$(overrides_stem "${OVERRIDES_LINE}")" || exit 1
MEASUREMENTS="${SLACK_STATE_DIR}/$(printed TEST_MEASUREMENTS_FILE_NAME)"

jq -er '.personas[].name' "${CONFIG}" > "${EVIDENCE}/keys"
mapfile -t KEYS < "${EVIDENCE}/keys"
jq -er '.personas[0].channels[].id' "${CONFIG}" > "${EVIDENCE}/channels"
mapfile -t CHANNELS < "${EVIDENCE}/channels"
HOLD_CHANNEL="$(jq -er '.personas[0].channels[0].id' "${CONFIG}")"
HUMAN="$(scenario_id U burst-sender)"
OTHER="$(scenario_id U other-parent)"
declare -A WORK BOT OPERATION STAMP CLIENT
control_args=()
for key in "${KEYS[@]}"; do
    WORK[${key}]="${CASE_ROOT}/${key}"
    mkdir -p "${WORK[${key}]}"
    stub_mode "${WORK[${key}]}" "${STUB_MODE_SILENT}"
    # Credentials use the production JSON format even though config's
    # builder names the file .env. Only generated fake tokens enter it.
    printf '{"bot_token":"%s","app_token":"%s"}\n' \
        "$(fake_token bot "${SCENARIO_TAG}${key}")" "$(fake_token app "${SCENARIO_TAG}${key}")" \
        | write_file "${CASE_ROOT}/${key}.env" 600
    control_args+=("${key}" "${SCENARIO_TAG}${key}")
done
CONTROL="${EVIDENCE}/slack-control.json"
SCENARIO_SLACK_RECORD="${EVIDENCE}/slack.jsonl"
slack_stub_control_seed "${CONTROL}" "${control_args[@]}"
bun "${SCENARIO_FIXTURES}/slack-stub-server.ts" --record "${SCENARIO_SLACK_RECORD}" --control "${CONTROL}" \
    --ready-file "${EVIDENCE}/slack-ready.json" > "${EVIDENCE}/stub.log" 2>&1 &
SLACK_PID=$!
track_pid "${SLACK_PID}"
wait_for_file "${EVIDENCE}/slack-ready.json" 20 'Slack stub readiness'
CSCB_SLACK_API_URL="$(jq -er .api_url "${EVIDENCE}/slack-ready.json")"
export CSCB_SLACK_API_URL
[[ "${CSCB_SLACK_API_URL}" =~ ^http://127\.0\.0\.1:[0-9]+/api/$ ]] || fail 'Slack stub URL is not loopback'
SCENARIO_SLACK_STUB_URL="${CSCB_SLACK_API_URL%/api/}"
slack_stub_controls "${CONTROL}"
# Inventories page as CSCB asks Slack to, never as one oversized page.
PAGE_LIMIT="$(printed MEMBERSHIP_PAGE_LIMIT)"
for key in "${KEYS[@]}"; do
    BOT[${key}]="$(slack_stub_identity "${key}" user_id)"
    slack_stub_inventory_pages "${key}" '' '' "${PAGE_LIMIT}" "${CHANNELS[@]}"
done

start_ready() {
    local overrides_before completion measurements_started completion_before measurements_before
    completion="$(completion_match "${recipients}")"
    measurements_started="$(matcher "$(printed buildTestMeasurementsStartLine "${MEASUREMENTS}")")"
    overrides_before="$(count_log "${OVERRIDES_STEM}")"
    completion_before="$(count_log "${completion}")"
    measurements_before="$(count_log "${measurements_started}")"
    if [[ "${1:-}" == measured ]]; then start_ms="$(mono_ms)"; fi
    if [[ "${1:-}" == measured && -n "${PROFILE_DIR}" ]]; then
        BUN_OPTIONS="--preload ${SCENARIO_FIXTURES}/cpu-profile-preload.ts" CSCB_TEST_CPU_PROFILE_DIR="${PROFILE_DIR}" start_server --live
    else
        start_server --live
    fi
    # Every restart must publish its own observations; old log lines do not
    # establish this start's readiness or recorder activation.
    wait_for_count "${completion}" "$((completion_before + 1))" 150 'silent persona startup incomplete'
    expect_one_overrides_line 'SR-8 maintenance setting' "${overrides_before}" 30
    wait_for_count "${measurements_started}" "$((measurements_before + 1))" 30 'measurement recorder not enabled'
    for key in "${KEYS[@]}"; do wait_membership_complete "${key}"; done
    if [[ "${1:-}" == measured ]]; then ready_ms="$(mono_ms)"; fi
}
stop_clients() {
    local key
    for key in "${KEYS[@]}"; do
        if [[ -n "${CLIENT[${key}]:-}" ]]; then
            stop_tracked_pid "${CLIENT[${key}]}" 10 'fixture MCP client did not stop'
            unset "CLIENT[${key}]"
        fi
    done
}
clean_stop() {
    stop_clients
    stop_server --stop-bots
    port_closed "${SCENARIO_PORT}" || fail 'server still listening after stop'
}
closing_assertions() {
    assert_no_server_tmux
    assert_no_cscb_include_finished
    assert_no_cscb_delete
}
snapshot() {
    local key="$1" output="$2"
    shift 2
    local prior=("$@")
    if [[ -f "${output}" ]]; then prior+=("${output}"); fi
    shared_queue_snapshot "${output}" "${key}" "${prior[@]}"
}
capture_posts() {
    shared_own_post_records "$1" > "$2" || fail 'cannot read own-post evidence'
    # The value printer adds no newline; the evidence fixture requires JSONL.
    printf '\n' >> "$2"
}
post_fault_seen() {
    slack_stub_records fault "label=$1" method=chat.postMessage outcome=lost > "${EVIDENCE}/$1.post-fault.jsonl" \
        || fail 'cannot read own-post fault evidence'
    [[ -s "${EVIDENCE}/$1.post-fault.jsonl" ]]
}

# Prebuild ordinary payloads before the measured start and every burst push.
# Each root mentions both recipients, and each recipient gets the same event.
BATCH="${EVIDENCE}/batch"
mkdir -p "${BATCH}"
if [[ "${CASE}" == burst || "${CASE}" == pending ]]; then
    bun "${SR8}" plan "${mode}" "${population}" "${recipients}" "$(date +%s)" > "${BATCH}/plan.tsv"
    message="$(scenario_text burst)"
    mention="${message}"
    for key in "${KEYS[@]}"; do mention="$(scenario_mention_text "${BOT[${key}]}" "${mention}")"; done
    for phase in roots replies dropped; do : > "${BATCH}/${phase}.events.jsonl"; : > "${BATCH}/${phase}.batch.jsonl"; done
    while IFS=$'\t' read -r phase channel ts root _mentioned; do
        case "${phase}" in
            roots)
                # Open intake uses the paired message; app_mention is ignored.
                if [[ "${mode}" == open ]]; then
                    slack_message_event "${channel}" "${mention}" "${ts}" "${HUMAN}"
                else
                    slack_mention_event "${channel}" "${mention}" "${ts}" "${HUMAN}"
                fi
                ;;
            replies) slack_reply_event "${channel}" "${root}" "${message}" "${ts}" "${HUMAN}" "${OTHER}" ;;
            dropped) slack_message_event "${channel}" "${message}" "${ts}" "${HUMAN}" ;;
            *) fail 'unknown burst phase' ;;
        esac >> "${BATCH}/${phase}.events.jsonl"
    done < "${BATCH}/plan.tsv"
    for key in "${KEYS[@]}"; do
        for phase in roots replies dropped; do
            bun "${SR8}" bodies "${key}" "${BATCH}/${phase}.events.jsonl" >> "${BATCH}/${phase}.batch.jsonl"
        done
    done
fi

# Decision 24: the seed writes the production shared record before ANY
# server start. Zero skips both seeding and the first seal start.
if [[ "${population}" != 0 ]]; then
    bun "${SR8}" seed "${CONFIG}" "${SLACK_STATE_DIR}" "${population}"
    first_mark="$(byte_mark "${LOG}")"
    start_ready
    sr8_verdicts seal first "${CONTEXT[@]}" "${LOG}" "${first_mark}" "${CONFIG}"
    clean_stop
fi
measured_log_mark="$(byte_mark "${LOG}")"
measurement_mark="$(byte_mark "${MEASUREMENTS}")"
start_ready measured
sr8_verdicts seal measured "${CONTEXT[@]}" "${LOG}" "${measured_log_mark}" "${CONFIG}"

start_pending_post() {
    local key="$1" request facts
    # Startup notices can already have their own intents in the destination
    # channel. Bind this tool call to a newly observed operation only.
    capture_posts "${key}" "${EVIDENCE}/${key}.prior-posts.jsonl"
    # A fresh separate MCP fixture uses roots/list for this exact configured
    # directory. The silent AD row stays pending, so no delivery is enabled.
    bun "${SCENARIO_BIN}/stub-mcp-session.ts" "${HOME}/.claude/slack-mcp.json" "${WORK[${key}]}" \
        > "${EVIDENCE}/${key}.mcp.log" 2>&1 &
    CLIENT[${key}]=$!
    track_pid "${CLIENT[${key}]}"
    slack_stub_post_lost "${key}" "${HOLD_CHANNEL}" false times=100000
    slack_stub_history_fault "${key}" history hang "channel=${HOLD_CHANNEL}" times=100000
    request="$(stub_session_submit "${WORK[${key}]}" reply \
        "$(jq -cn --arg channel "${HOLD_CHANNEL}" --arg message "$(scenario_text pending-post)" '{chat_id:$channel,text:$message}')")"
    printf '%s\n' "${request}" > "${EVIDENCE}/${key}.post-request"
    wait_until 30 'own post did not reach the held answer' post_fault_seen "${key}"
    capture_posts "${key}" "${EVIDENCE}/${key}.posts.jsonl"
    OPERATION[${key}]="$(jq -ser --arg c "${HOLD_CHANNEL}" \
        --slurpfile before "${EVIDENCE}/${key}.prior-posts.jsonl" '
        [$before[] | select(.kind=="post-intent") | .operationId] as $old |
        [.[] | select(.kind=="post-intent" and .channel==$c and .root==null) |
          select(.operationId as $id | $old | index($id) | not)] |
        if length==1 then .[0].operationId else error("expected one new own-post intent") end' \
        "${EVIDENCE}/${key}.posts.jsonl")"
    facts="$(shared_persona_facts "${key}" "${HOLD_CHANNEL}")"
    STAMP[${key}]="$(jq -ce --arg c "${HOLD_CHANNEL}" '{incarnation,threadHybridSince:.assignments[$c].threadHybridSince}' <<< "${facts}")"
    shared_wait_own_post_state "${key}" "${OPERATION[${key}]}" "${HOLD_CHANNEL}" "${STAMP[${key}]}" unresolved \
        > "${EVIDENCE}/${key}.unresolved.json"
}

case "${CASE}" in
    burst)
        RESULTS="${EVIDENCE}/burst"
        mkdir -p "${RESULTS}"
        for key in "${KEYS[@]}"; do
            shared_thread_joins "${key}" > "${RESULTS}/${key}.before.jsonl"
            start_pending_post "${key}"
        done
        # Build held probes after every pending post exists, before the burst.
        # Slow seeding/startup must not age the root before its post's issue time.
        # shellcheck disable=SC2119 # scenario_ts explicitly rejects every argument.
        HOLD_ROOT="$(scenario_ts)"
        : > "${BATCH}/held.batch.jsonl"
        for key in "${KEYS[@]}"; do
            # shellcheck disable=SC2119 # scenario_ts explicitly rejects every argument.
            slack_reply_event "${HOLD_CHANNEL}" "${HOLD_ROOT}" "$(scenario_text held)" "$(scenario_ts)" "${HUMAN}" "${BOT[${key}]}" \
                > "${BATCH}/${key}.held.events.jsonl"
            bun "${SR8}" bodies "${key}" "${BATCH}/${key}.held.events.jsonl" >> "${BATCH}/held.batch.jsonl"
        done
        burst_status=0
        # Observer-only CPU readings at each wave boundary, for observe below.
        # The driver runs off the server's CPU quota; driver-cpu judges that.
        SR8_PHASE_CPU_FILE="${RESULTS}/phase-cpu.jsonl" SR8_PHASE_CPU_PIDS="server=${SERVER_PID},stub=${SLACK_PID}" \
            SR8_PROFILE_DIR="${PROFILE_DIR}" bash "${BURST_DRIVER}" "${RESULTS}/driver-cgroup" \
            bun "${SR8}" burst "${CONTEXT[@]}" "${BATCH}" "${SCENARIO_SLACK_STUB_URL}" \
            "${SCENARIO_SLACK_RECORD}" "${SLACK_STATE_DIR}" "${RESULTS}" 30000 \
            "${MEASUREMENTS}" "${measurement_mark}" || burst_status=$?
        # The profile ends with the waves, before the observation wait below,
        # and its summary prints at once, so a later failing step keeps it.
        profile_stop
        profile_summary
        # Observe zero as well as positive ACKs; check judges the exact set.
        jq -ser 'if all(.[]; (.envelope_id | type)=="string") then .[].envelope_id else error("burst push has no string envelope_id") end' "${RESULTS}/burst.jsonl" > "${RESULTS}/envelopes" || fail 'burst push has no string envelope_id'
        _scenario_complete_jsonl "${SCENARIO_SLACK_RECORD}" > "${RESULTS}/final-stub.jsonl"
        bun "${SR8}" envelope-times "${RESULTS}/envelopes" "${RESULTS}/final-stub.jsonl" > "${RESULTS}/times.jsonl"
        # An observation wait, not an allowance: check uses each hold's actual
        # receipt/resolution/append times and the sole 100 ms dispatch allowance.
        sleep 5
        for key in "${KEYS[@]}"; do
            prior=()
            if [[ -f "${RESULTS}/${key}.held-admission.jsonl" ]]; then
                prior+=("${RESULTS}/${key}.held-admission.jsonl")
            fi
            snapshot "${key}" "${RESULTS}/${key}.queue.jsonl" "${prior[@]}"
        done
        if [[ "${mode}/${population}/${recipients}" == open/100000/2 ]]; then
            bun "${SR8}" conditions "${SLACK_STATE_DIR}" "${SERVER_PID}"
        fi
        sr8_verdicts driver-cpu "${CONTEXT[@]}" "${SERVER_PID}" "${RESULTS}/driver-cgroup"
        clean_stop
        cp "${MEASUREMENTS}" "${RESULTS}/measurements.jsonl"
        for key in "${KEYS[@]}"; do snapshot "${key}" "${RESULTS}/${key}.queue.jsonl"; done
        reopen_mark="$(byte_mark "${LOG}")"
        start_ready
        sr8_verdicts seal measured "${CONTEXT[@]}" "${LOG}" "${reopen_mark}" "${CONFIG}"
        for key in "${KEYS[@]}"; do shared_thread_joins "${key}" > "${RESULTS}/${key}.after.jsonl"; done
        clean_stop
        closing_assertions
        # Latency decomposition only: no verdict, and never this script's status.
        # It prints before check, whose failure ends the script.
        bun "${SR8}" observe "${CONTEXT[@]}" "${RESULTS}" "${RESULTS}/measurements.jsonl" "${measurement_mark}" \
            "${RESULTS}/phase-cpu.jsonl" || printf 'recorded: sr8 observe unavailable\n'
        sr8_verdicts check "${CONTEXT[@]}" "${RESULTS}" "${RESULTS}/measurements.jsonl" "${measurement_mark}" "${start_ms}" "${ready_ms}"
        [[ "${burst_status}" == 0 ]] || fail 'burst submission or ACK observation failed'
        ;;
    pending)
        RESULTS="${EVIDENCE}/burst"
        mkdir -p "${RESULTS}"
        key="${KEYS[0]}"
        start_pending_post "${key}"
        # Keep the long-window probes' root newer than the pending post too.
        # shellcheck disable=SC2119 # scenario_ts explicitly rejects every argument.
        HOLD_ROOT="$(scenario_ts)"
        : > "${BATCH}/probes.batch.jsonl"
        : > "${EVIDENCE}/probe-plan.tsv"
        for parent in other bot none; do
            parent_user=''
            case "${parent}" in other) parent_user="${OTHER}" ;; bot) parent_user="${BOT[${key}]}" ;; esac
            # shellcheck disable=SC2119 # scenario_ts explicitly rejects every argument.
            ts="$(scenario_ts)"
            slack_reply_event "${HOLD_CHANNEL}" "${HOLD_ROOT}" "$(scenario_text "pending-${parent}")" "${ts}" "${HUMAN}" "${parent_user}" \
                > "${BATCH}/${parent}.probe.events.jsonl"
            bun "${SR8}" bodies "${key}" "${BATCH}/${parent}.probe.events.jsonl" >> "${BATCH}/probes.batch.jsonl"
            printf '%s\t%s\t%s\n' "${parent}" "${HOLD_CHANNEL}" "${ts}" >> "${EVIDENCE}/probe-plan.tsv"
        done
        # Journal identity before the first read and after the second: a
        # compaction between the reads would replace this file.
        journal="${SLACK_STATE_DIR}/threads/${key}.jsonl"
        stat -c '%d:%i' -- "${journal}" > "${RESULTS}/before.journal"
        capture_posts "${key}" "${EVIDENCE}/before.posts.jsonl"
        pending_start="$(mono_ms)"
        pending_mark="$(byte_mark "${MEASUREMENTS}")"
        pending_seq="$(slack_post_mark)"
        # The probes lead the burst's second wave, while the post stays pending.
        burst_status=0
        bash "${BURST_DRIVER}" "${RESULTS}/driver-cgroup" bun "${SR8}" burst "${CONTEXT[@]}" "${BATCH}" "${SCENARIO_SLACK_STUB_URL}" \
            "${SCENARIO_SLACK_RECORD}" "${SLACK_STATE_DIR}" "${RESULTS}" 30000 || burst_status=$?
        # The actual measured interval includes the burst and these 120 seconds.
        # Repeated lost-post and hung-history controls retain the same unresolved intent.
        sleep 120
        settled_seq="$(slack_post_mark)"
        pending_end="$(mono_ms)"
        capture_posts "${key}" "${EVIDENCE}/after.posts.jsonl"
        stat -c '%d:%i' -- "${journal}" > "${RESULTS}/after.journal"
        shared_wait_own_post_state "${key}" "${OPERATION[${key}]}" "${HOLD_CHANNEL}" "${STAMP[${key}]}" unresolved \
            > "${EVIDENCE}/after.unresolved.json"
        window_end="$(mono_ms)"
        jq -ser 'if all(.[]; (.envelope_id | type)=="string") then .[].envelope_id else error("burst push has no string envelope_id") end' "${RESULTS}/burst.jsonl" > "${RESULTS}/envelopes" || fail 'burst push has no string envelope_id'
        _scenario_complete_jsonl "${SCENARIO_SLACK_RECORD}" > "${RESULTS}/final-stub.jsonl"
        bun "${SR8}" envelope-times "${RESULTS}/envelopes" "${RESULTS}/final-stub.jsonl" > "${RESULTS}/times.jsonl"
        : > "${EVIDENCE}/probes.tsv"
        while IFS=$'\t' read -r parent channel ts; do
            # Slurp: jq 1.6's -e reports only the last JSONL line, which is rarely the probe.
            envelope="$(jq -ser --arg ts "${ts}" '[.[] | select(.phase=="probes" and .ts==$ts) | .envelope_id]
                | if length==1 and (.[0]|type)=="string" and (.[0]|length)>0 then .[0] else error("missing or ambiguous") end' \
                "${RESULTS}/burst.jsonl")" || fail "pending ${parent} probe ${ts} has no unique burst envelope"
            printf '%s\t%s\t%s\t%s\n' "${parent}" "${channel}" "${ts}" "${envelope}" >> "${EVIDENCE}/probes.tsv"
        done < "${EVIDENCE}/probe-plan.tsv"
        for persona in "${KEYS[@]}"; do snapshot "${persona}" "${RESULTS}/${persona}.queue.jsonl"; done
        sr8_verdicts driver-cpu "${CONTEXT[@]}" "${SERVER_PID}" "${RESULTS}/driver-cgroup"
        clean_stop
        closing_assertions
        sr8_verdicts pending-post "${CONTEXT[@]}" "${key}" "${OPERATION[${key}]}" "${pending_start}" "${pending_end}" \
            "${EVIDENCE}/before.posts.jsonl" "${EVIDENCE}/after.posts.jsonl" "${EVIDENCE}/probes.tsv" "${RESULTS}/${key}.queue.jsonl" \
            "${RESULTS}/times.jsonl" "${MEASUREMENTS}" "${pending_mark}" "${HOLD_CHANNEL}" \
            "${RESULTS}" "${pending_seq}" "${settled_seq}" "${compact_ms}" "${start_ms}" "${window_end}"
        [[ "${burst_status}" == 0 ]] || fail 'burst submission or ACK observation failed'
        ;;
    shared-list)
        cp "${CONFIG}" "${EVIDENCE}/prepared.input"
        jq -r '.personas[]|.name as $key|.channels[]|[$key,.id,.delivery]|join("/")' "${CONFIG}" > "${EVIDENCE}/assignments"
        mapfile -t assignments < "${EVIDENCE}/assignments"
        configuration_request sr8-large-list request "${assignments[@]}" > /dev/null
        cp "${CONFIG}.pending" "${EVIDENCE}/ordinary.preview"
        mv "${CONFIG}.pending" "${CONFIG}.apply"
        wait_until 30 'large ordinary preview was not applied' bun "${PRINTER}" sharedReviewConsumed \
            "${CONFIG}" "${LAST}" "${EVIDENCE}/ordinary.preview" > /dev/null
        list_snapshot() {
            local phase="$1" key
            cp "${CONFIG}" "${EVIDENCE}/${phase}.input"
            : > "${EVIDENCE}/${phase}.facts.jsonl"
            for key in "${KEYS[@]}"; do
                shared_persona_facts "${key}" | cat >> "${EVIDENCE}/${phase}.facts.jsonl" || fail 'cannot read shared-list facts'
                printf '\n' >> "${EVIDENCE}/${phase}.facts.jsonl"
            done
        }
        list_snapshot applied
        clean_stop
        start_ready
        list_snapshot restarted
        : > "${EVIDENCE}/growth.tsv"
        growth="$(scenario_id C list-growth)"
        # Read the printer's saved mentions value from an independently
        # configured channel; the new membership must acquire that choice.
        mentions_channel="$(jq -er '[.personas[0].channels[]|select(.delivery=="mentions")][0].id' "${CONFIG}")"
        delivery="$(shared_channel_saved "${KEYS[0]}" "${mentions_channel}")"
        for key in "${KEYS[@]}"; do
            slack_stub_inventory_pages "${key}" '' '' "${PAGE_LIMIT}" "${CHANNELS[@]}" "${growth}"
            # shellcheck disable=SC2119 # scenario_ts explicitly rejects every argument.
            envelope="$(slack_push_member_joined "${key}" "${growth}" "$(scenario_ts)")"
            slack_wait_one_ack "${envelope}"
            printf '%s\t%s\t%s\n' "${key}" "${growth}" "${delivery}" >> "${EVIDENCE}/growth.tsv"
        done
        list_snapshot grown
        clean_stop
        start_ready
        list_snapshot reopened
        failed_channel="$(scenario_id C list-failed-growth)"
        key="${KEYS[0]}"
        cp "${LAST}" "${EVIDENCE}/failure-before.state"
        failure_mark="$(byte_mark "${LOG}")"
        printed membershipDiagnostic "${key}" "${failed_channel}" event-not-durable > "${EVIDENCE}/failure.expected"
        restore_permissions() { chmod 700 "${SLACK_STATE_DIR}"; }
        on_exit restore_permissions
        chmod 500 "${SLACK_STATE_DIR}"
        probe_exit=0
        python3 - "${SLACK_STATE_DIR}/sr8-write-probe" <<'PY' || probe_exit=$?
import sys
try:
    with open(sys.argv[1], 'xb') as stream:
        stream.write(b'probe')
except OSError:
    sys.exit(1)
PY
        [[ "${probe_exit}" != 0 ]] || fail 'state-directory write probe unexpectedly succeeded'
        # shellcheck disable=SC2119 # scenario_ts explicitly rejects every argument.
        envelope="$(slack_push_member_joined "${key}" "${failed_channel}" "$(scenario_ts)")"
        slack_expect_no_ack "${envelope}" 1
        wait_for_log "$(matcher "$(cat "${EVIDENCE}/failure.expected")")" 30 'failed growth has no actionable diagnostic'
        cp "${LAST}" "${EVIDENCE}/failure-after.state"
        tail -c "+$((failure_mark + 1))" "${LOG}" > "${EVIDENCE}/failure.log"
        # Read while the write fault is still active, so no background repair
        # can replace the previous state before its readability is proved.
        # Mode 500 has retained read permission throughout this case.
        list_snapshot failed
        restore_permissions
        clean_stop
        closing_assertions
        sr8_verdicts shared-list "${CONTEXT[@]}" "${EVIDENCE}" "${probe_exit}"
        ;;
esac
