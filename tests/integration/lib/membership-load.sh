#!/usr/bin/env bash
# Shared AC-C06 workload for the strict/open membership-load group scripts.
# Each entrypoint sources scenario.sh first and keeps its own EXIT evidence.
# Verdicts, workloads and limits are owned by sr8-evidence.ts.

printed() { bun "${PRINTER}" "$@"; }
# A verdict command prints all its lines first; a non-pass exit then fails here.
verdict() { bun "${E}" "$@" || fail "sr8 $1 verdict did not pass"; }
mono_ms() { python3 -c 'import time; print(time.monotonic_ns() / 1000000)'; }
epoch_ms() { python3 -c 'import time; print(time.time_ns() // 1000000)'; }
byte_mark() { stat -c %s "$1"; }
log_slice() { tail -c "+$(($2 + 1))" "$1" > "$3"; }
read_jsonl() {
    local output="$1"
    shift
    "$@" > "${output}" || fail 'evidence reader failed'
    # Several printer-backed readers intentionally add no trailing newline.
    [[ ! -s "${output}" ]] || printf '\n' >> "${output}"
}

# A slice retains original seq/timestamps, and ignores only an incomplete tail,
# just as the stub readers do. Malformed complete records are never swallowed.
stub_slice() {
    python3 - "${SCENARIO_SLACK_RECORD}" "$1" "$2" <<'PY'
import json,sys
source,mark,out=sys.argv[1:]
data=open(source,'rb').read()
with open(out,'w') as target:
    for line in data.split(b'\n')[:-1]:
        row=json.loads(line)
        if row['seq'] > int(mark):
            target.write(line.decode()+'\n')
PY
}
record_since() {
    local mark="$1" event="$2" rows
    shift 2
    rows="$(slack_stub_records "${event}" "$@")" || fail 'stub record reader failed'
    jq -sc --argjson mark "${mark}" '[.[] | select(.seq > $mark)]' <<< "${rows}"
}
has_record_since() {
    local rows
    rows="$(record_since "$@")" || fail 'scoped stub reader failed'
    [[ "$(jq length <<< "${rows}")" -gt 0 ]]
}
capture_times() {
    # Freeze separate before-clear/final observations; the owner-provided bulk
    # reader preserves every original/replay identity, zero ACK and duplicate ACK.
    _scenario_complete_jsonl "${SCENARIO_SLACK_RECORD}" > "$2.stub.jsonl"
    bun "${E}" envelope-times "$1" "$2.stub.jsonl" > "$2"
}
snapshot() {
    local key="$1" destination="$2" prior=()
    [[ ! -f "${OUT}/${key}.held-admission.jsonl" ]] || prior+=("${OUT}/${key}.held-admission.jsonl")
    [[ ! -f "${OUT}/during/${key}.queue.jsonl" ]] || prior+=("${OUT}/during/${key}.queue.jsonl")
    shared_queue_snapshot "${destination}" "${key}" "${prior[@]}" || fail 'queue snapshot failed'
}
regular_measurements() { [[ -f "${MEASUREMENTS}" && ! -L "${MEASUREMENTS}" ]]; }
# The recorder creates its file only when it first flushes a record, and
# startup writes none; a stream not yet written is the zero baseline. Any
# other entry at the path is refused, never taken as an empty stream.
measurement_mark() {
    if [[ ! -e "${MEASUREMENTS}" && ! -L "${MEASUREMENTS}" ]]; then
        printf '0\n'
        return
    fi
    regular_measurements || fail 'test-only measurement path is not a regular file'
    byte_mark "${MEASUREMENTS}"
}
# A read-only state directory refuses the recorder's first create, not its
# appends. Before that window only, place the empty stream it appends to: it
# holds no record, an existing file keeps its bytes, any other entry fails.
prepare_measurements() {
    python3 - "${MEASUREMENTS}" <<'PY' || fail 'test-only measurement file could not be prepared'
import os,stat,sys
try:
    fd=os.open(sys.argv[1],os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW,0o600)
except FileExistsError:
    sys.exit(0 if stat.S_ISREG(os.lstat(sys.argv[1]).st_mode) else 1)
else:
    os.fchmod(fd,0o600)
    os.close(fd)
PY
    regular_measurements || fail 'test-only measurement path is not a regular file'
}
repair_modes() {
    [[ ! -d "${SLACK_STATE_DIR}" ]] || chmod 700 "${SLACK_STATE_DIR}"
}
start_ready() {
    local completions overrides recordings recording_line key
    completions="$(count_log "$(completion_match 2)")"
    overrides="$(count_log "${OVERRIDES_STEM}")"
    recording_line="$(matcher "$(printed buildTestMeasurementsStartLine "${MEASUREMENTS}")")"
    recordings="$(count_log "${recording_line}")"
    session_barrier_mark "${KEYS[@]}"
    if [[ "${1:-}" == measured ]]; then START_MS="$(mono_ms)"; fi
    if [[ "${1:-}" == measured && -n "${MEMBERSHIP_PROFILE_DIR:-}" ]]; then
        BUN_OPTIONS="--preload ${SCENARIO_FIXTURES}/cpu-profile-preload.ts" CSCB_TEST_CPU_PROFILE_DIR="${MEMBERSHIP_PROFILE_DIR}" start_server --live
    else
        start_server --live
    fi
    wait_for_count "$(completion_match 2)" "$((completions + 1))" 150 'two-persona startup incomplete'
    expect_one_overrides_line 'SR-8 compaction override' "${overrides}" 30
    wait_for_count "${recording_line}" "$((recordings + 1))" 30 'measurement recorder not enabled'
    # No tools/list may reach a session the previous server held.
    session_barrier_wait 150 'persona MCP sessions did not reconnect to the new server'
    for key in "${KEYS[@]}"; do
        wait_membership_complete "${key}"
        stub_session_list_tools "${ROOT}/${key}" > "${ROOT}/${key}.tools.json"
    done
    if [[ "${1:-}" == measured ]]; then READY_MS="$(mono_ms)"; fi
}

build_batches() {
    local phase channel ts root _mentions body text sender key index=0
    local mention_text=''
    for key in "${KEYS[@]}"; do
        mention_text+="$(scenario_mention_text "$(slack_stub_identity "${key}" user_id)") "
    done
    for phase in roots replies dropped; do : > "${BATCH}/${phase}.events.jsonl"; done
    # Only these two root senders have lookup faults, in a fresh server lifetime.
    LOOKUP_HANG_USER="$(scenario_id U "${CASE}-lookup-hang")"
    LOOKUP_LATE_USER="$(scenario_id U "${CASE}-lookup-late")"
    HUMAN="$(scenario_id U "${CASE}-ordinary")"
    while IFS=$'\t' read -r phase channel ts root _mentions; do
        sender="${HUMAN}"
        if [[ "${phase}" == roots ]]; then
            index=$((index + 1))
            if [[ "${index}" == 2 ]]; then sender="${LOOKUP_HANG_USER}"; LOOKUP_HANG_TS="${ts}"; fi
            if [[ "${index}" == 3 ]]; then sender="${LOOKUP_LATE_USER}"; LOOKUP_LATE_TS="${ts}"; fi
            if [[ "${index}" == 4 ]]; then CHANNEL_HANG_TS="${ts}"; LOOKUP_HANG_CHANNEL="${channel}"; fi
            if [[ "${index}" == 5 ]]; then CHANNEL_LATE_TS="${ts}"; LOOKUP_LATE_CHANNEL="${channel}"; fi
        fi
        text="$(scenario_text "${CASE}-${phase}-${ts}")"
        case "${phase}" in
            # Open intake uses the paired message; app_mention is ignored.
            roots)
                if [[ "${MODE}" == open ]]; then
                    body="$(slack_message_event "${channel}" "${mention_text}${text}" "${ts}" "${sender}")"
                else
                    body="$(slack_mention_event "${channel}" "${mention_text}${text}" "${ts}" "${sender}")"
                fi
                ;;
            replies) body="$(slack_reply_event "${channel}" "${root}" "${text}" "${ts}" "${sender}" "${HUMAN}")" ;;
            dropped) body="$(slack_message_event "${channel}" "${text}" "${ts}" "${sender}")" ;;
            *) fail 'unknown plan phase' ;;
        esac
        printf '%s\n' "${body}" >> "${BATCH}/${phase}.events.jsonl"
    done < "${PLAN}"
    for phase in roots replies dropped; do
        for key in "${KEYS[@]}"; do
            bun "${E}" bodies "${key}" "${BATCH}/${phase}.events.jsonl"
        done > "${BATCH}/${phase}.batch.jsonl"
    done
    for key in "${HOLD_KEYS[@]}"; do
        # scenario_ts explicitly accepts zero arguments.
        # shellcheck disable=SC2119
        root="$(scenario_ts)"
        # shellcheck disable=SC2119
        ts="$(scenario_ts)"
        slack_reply_event "${HOLD_CHANNEL}" "${root}" "$(scenario_text "${CASE}-${key}-held")" \
            "${ts}" "${HUMAN}" "$(slack_stub_identity "${key}" user_id)" > "${BATCH}/${key}.held.jsonl"
        bun "${E}" bodies "${key}" "${BATCH}/${key}.held.jsonl" >> "${BATCH}/held.batch.jsonl"
    done
}

pending_posts() {
    local key before mark args operation rows stamp request
    for key in "${HOLD_KEYS[@]}"; do
        before="$(shared_own_post_records "${key}")" || fail 'own-post reader failed'
        printf '%s\n' "${before}" > "${ROOT}/${key}.posts-before.jsonl"
        stamp="$(printed sharedThreadStamp "${CONFIG}" "${CONFIG}.last-applied" "${key}" "${HOLD_CHANNEL}")"
        slack_stub_post_lost "${key}" "${HOLD_CHANNEL}" false times=100000
        slack_stub_history_fault "${key}" history hang "channel=${HOLD_CHANNEL}" times=100000
        mark="$(slack_post_mark)"
        # MCP tool arguments are distinct from Slack event/control/config JSON.
        args="$(jq -cn --arg c "${HOLD_CHANNEL}" --arg t "$(scenario_text "${CASE}-${key}-pending")" '{chat_id:$c,text:$t}')"
        request="$(stub_session_submit "${ROOT}/${key}" reply "${args}")"
        printf '%s\n' "${request}" > "${ROOT}/${key}.post-request"
        wait_until 30 'pending own post was not attempted' has_record_since "${mark}" fault \
            "label=${key}" method=chat.postMessage outcome=lost
        rows="$(shared_own_post_records "${key}")" || fail 'own-post reader failed'
        operation="$(jq -ser --slurpfile before "${ROOT}/${key}.posts-before.jsonl" --arg c "${HOLD_CHANNEL}" \
            '[.[] | select(.kind=="post-intent" and .channel==$c) | select(.operationId as $id | all($before[]; .operationId!=$id))] |
             if length==1 then .[0].operationId else error("missing unique pending operation") end' <<< "${rows}")"
        shared_wait_own_post_state "${key}" "${operation}" "${HOLD_CHANNEL}" "${stamp}" unresolved \
            > "${ROOT}/${key}.pending.json"
        printf '%s\n' "${operation}" > "${ROOT}/${key}.pending-operation"
    done
}

pending_results() {
    local key request operation stamp
    for key in "${HOLD_KEYS[@]}"; do
        request="$(cat "${ROOT}/${key}.post-request")"
        operation="$(cat "${ROOT}/${key}.pending-operation")"
        stamp="$(printed sharedThreadStamp "${CONFIG}" "${CONFIG}.last-applied" "${key}" "${HOLD_CHANNEL}")"
        # The MCP fixture polls ungrouped calls serially. Its timed-out/lost
        # reply must have a result before Q can execute the burst's ordered
        # writes. The durable own-post outcome must still be unresolved.
        stub_session_result "${ROOT}/${key}" "${request}" "${WAIT_S}" > "${ROOT}/${key}.post-result.json"
        shared_wait_own_post_state "${key}" "${operation}" "${HOLD_CHANNEL}" "${stamp}" unresolved \
            > "${ROOT}/${key}.pending-after-result.json"
    done
}

write_states() {
    read_jsonl "$1" shared_persona_facts "${Q}"
    shared_persona_facts "${P}" | cat >> "$1" || fail 'write-state reader failed'
    printf '\n' >> "$1"
}
applied_events() {
    local kind event
    while IFS=$'\t' read -r kind _ event _; do
        jq -cn --arg kind "${kind}" --arg event "${event}" --argjson applied "$(shared_membership_event "${Q}" "${event}")" \
            '{kind:$kind,event_id:$event,applied:$applied}' || fail 'membership event reader failed'
    done < "${WRITES}/membership.tsv" > "$1"
}
# Strict refuses every bot assignment (t1.tad.5i SR-2.3), so Q's two ordered
# writes there are the production membership route strict allows (SR-3.3):
# a live leave of the write channel, then a qualifying rejoin. Each event is
# acknowledged only once durable, and requests a fresh scan. Q's inventory is
# staged to agree before each event, without a control replacement that would
# reset P's fault counters inside the burst, and that scan settles before the
# state is read or the inventory changes again.
membership_writes() {
    local kind type ids envelope event mark channel
    local -a absent=()
    for channel in "${CHANNELS[@]}"; do [[ "${channel}" == "${WRITE_CHANNEL}" ]] || absent+=("${channel}"); done
    write_states "${WRITES}/before.jsonl"
    wait_until "${WAIT_S}" 'burst has no observed push' has_record_since "${CASE_MARK}" push "label=${Q}"
    WRITE_SUBMIT="$(slack_post_mark)"
    for kind in leave join; do
        if [[ "${kind}" == leave ]]; then
            type=channel_left
            mark="$(slack_stub_inventory_stage "${Q}" "${PAGE_LIMIT}" "${absent[@]}")"
        else
            type=member_joined_channel
            mark="$(slack_stub_inventory_stage "${Q}" "${PAGE_LIMIT}" "${CHANNELS[@]}")"
        fi
        # scenario_ts explicitly accepts zero arguments.
        # shellcheck disable=SC2119
        ids="$(slack_push_membership_ids "${type}" "${Q}" "${WRITE_CHANNEL}" "$(scenario_ts)")"
        IFS=$'\t' read -r envelope event <<< "${ids}"
        printf '%s\t%s\t%s\t%s\n' "${kind}" "${envelope}" "${event}" "${mark}" >> "${WRITES}/membership.tsv"
        slack_wait_one_ack "${envelope}" "${WAIT_S}"
        [[ "${kind}" == leave ]] || WRITE_RESULT="$(slack_post_mark)"
        wait_membership_rescan "${Q}" "${Q}" "$(slack_stub_record_field seq push "envelope_id=${envelope}")"
        [[ "${kind}" == join ]] || read_jsonl "${WRITES}/leave.jsonl" shared_persona_facts "${Q}"
    done
    write_states "${WRITES}/join.jsonl"
    applied_events "${WRITES}/events.jsonl"
}
# fault-check accounts exactly the planned burst; membership-writes judges
# Q's two write envelopes from the unfiltered case slice.
burst_slice() {
    python3 - "$1" "$2" "$3" <<'PY'
import json,sys
source,writes,out=sys.argv[1:]
skip={line.split('\t')[1] for line in open(writes).read().splitlines()}
if len(skip) != 2: sys.exit('expected two membership write envelopes')
with open(source) as rows, open(out,'w') as target:
    for line in rows:
        if json.loads(line).get('envelope_id') not in skip: target.write(line)
PY
}

# Open mode's fault-burst holds Q's last replies until the release file exists;
# created after WRITE_RESULT, Q's burst ACKs continue past both write marks.
ordered_writes() {
    local delivery attempt args id result expected
    if [[ "${MODE}" == strict ]]; then membership_writes; return; fi
    read_jsonl "${WRITES}/before.jsonl" shared_attempt_order "${Q}"
    wait_until "${WAIT_S}" 'burst has no observed push' has_record_since "${CASE_MARK}" push "label=${Q}"
    WRITE_SUBMIT="$(slack_post_mark)"
    for delivery in all mentions; do
        attempt="$(scenario_attempt_id "${CASE}-ordered-${delivery}")"
        args="$(attempt_args "${attempt}" "${WRITE_CHANNEL}" "${delivery}")"
        id="$(stub_session_submit "${ROOT}/${Q}" "${WRITE_TOOL}" "${args}")"
        result="$(stub_session_result "${ROOT}/${Q}" "${id}")"
        printf '%s\n' "${result}" >> "${WRITES}/results.jsonl"
        expected="$(printed channelDeliveryAttemptResultText "${CONFIG}" "${CONFIG}.last-applied" \
            "${Q}" "${WRITE_CHANNEL}" "${delivery}" "${attempt}" new "${delivery}")"
        jq -e --arg expected "${expected}" '.isError==false and (has("error")|not) and .text==$expected' \
            <<< "${result}" > /dev/null || fail 'ordered write result differs from production text'
        printf '%s\t%s\n' "${WRITE_CHANNEL}" "${delivery}" >> "${WRITES}/expected.tsv"
    done
    WRITE_RESULT="$(slack_post_mark)"
    : > "${OUT}/tail-release"
    read_jsonl "${WRITES}/after.jsonl" shared_attempt_order "${Q}"
}

membership_settled_twice() {
    local faults answers id rows
    faults="$(record_since "${CASE_MARK}" fault "label=${P}" method=users.conversations "outcome=${OUTCOME}")"
    [[ "$(jq length <<< "${faults}")" -ge 2 ]] || return 1
    # These are collection barriers, not verdicts. The fixture correlates each
    # diagnostic, arrival, request deadline, retry and settlement independently.
    for id in $(jq -r '.[].request_id' <<< "${faults}"); do
        if [[ "${KIND}" == hang ]]; then
            rows="$(slack_stub_records fault-settled "request_id=${id}")" || fail 'settlement reader failed'
        else
            rows="$(slack_stub_records api "request_id=${id}")" || fail 'API reader failed'
        fi
        [[ -n "${rows}" ]] || return 1
    done
    answers="$(count_log "$(matcher "${INCOMPLETE}" "persona=${P}:")")"
    (( answers >= INCOMPLETE_BEFORE + 2 ))
}

late_state() {
    # Bun.write(stdout) must not receive an append-open file. Keep each
    # reader separate; read_jsonl also omits a separator for an empty reader.
    read_jsonl "$1.facts" shared_persona_facts "${P}"
    read_jsonl "$1.order" shared_attempt_order "${P}"
    read_jsonl "$1.joins" shared_thread_joins "${P}"
    cat "$1.facts" "$1.order" "$1.joins" > "$1" || fail 'late-state concatenation failed'
}

# Reopen observation, printed only when the case fails between the reopen stop
# and its measured seal. Diagnostic only: it reads, never fails, and prints
# whitelisted fields, never message text, hook commands, tokens or log lines.
REOPEN_SAFE='def safe: if . == null then "absent" else tostring | if test("^[A-Za-z0-9_.:+-]{1,64}$") and (test("^xox") | not) then . else "invalid" end end;
    def word: if . == null then "absent" else tostring | if test("^[A-Za-z][A-Za-z_-]{0,39}$") and (test("^xox") | not) then . else "invalid" end end;'
reopen_ad_rows() {
    local phase="$1" name key id
    for name in "${KEYS[@]}"; do
        if ! key="$(persona_key "${name}")" || ! id="$(printed personaInstanceId "${key}")"; then
            printf 'reopen-observe: phase=%s persona=%s ad=unavailable\n' "${phase}" "${name}"
            continue
        fi
        ad_capture get --instance-id "${id}"
        if (( AD_RC != 0 )); then
            printf 'reopen-observe: phase=%s persona=%s ad_rc=%s\n' "${phase}" "${name}" "${AD_RC}"
            continue
        fi
        jq -r --arg phase "${phase}" --arg name "${name}" "${REOPEN_SAFE}"'
            "reopen-observe: phase=\($phase) persona=\($name) ad_state=\(.state|word) session_id=\(.session_id|safe) launch_started_at=\(.launch_started_at|safe) last_seen_at=\(.last_seen_at|safe) ended_at=\(.ended_at|safe)"' \
            "${AD_OUT}" 2> /dev/null || printf 'reopen-observe: phase=%s persona=%s ad=unreadable\n' "${phase}" "${name}"
    done
}
reopen_lifecycle() {
    local name="$1" slice="$2" ref key label a b line stamps count
    ref="$(persona_ref "${name}")" && key="$(persona_key "${name}")" || return 0
    while IFS='|' read -r label a b; do
        stamps='' count=0
        while IFS= read -r line; do
            [[ "${line}" == *"${b}"* ]] || continue
            count=$((count + 1))
            if [[ "${line}" =~ ^\[([0-9T:.Z+-]{10,40})\] ]]; then stamps+="${stamps:+,}${BASH_REMATCH[1]}"; fi
        done < <(grep -F -- "${a}" "${slice}" 2> /dev/null)
        printf 'reopen-observe: persona=%s lifecycle=%s count=%s at=%s\n' "${name}" "${label}" "${count}" "${stamps:-none}"
    done <<EOF
connected|[slack] Session connected: persona ${ref}|
disconnected|[slack] Session disconnected|persona ${ref}
dropped|[slack] persona ${ref}: MCP session dropped|
persona-start|[slack] persona-start: personas[|${ref}
restart-scheduled|[slack] Scheduling restart for persona=${key} |
EOF
}
reopen_stub_records() {
    local name="$1" key id stub file
    key="$(persona_key "${name}")" && id="$(printed personaInstanceId "${key}")" || return 0
    stub="$(_scenario_stub_dir reopen-observe 2> /dev/null)" || stub="${SCENARIO_BIN}"
    for file in "${stub}"/stub-claude-hooks.*.jsonl; do
        [[ -f "${file}" ]] || continue
        jq -r --arg id "${id}" --arg name "${name}" "${REOPEN_SAFE}"'
            select(.instance_id == $id) |
            "reopen-observe: persona=\($name) stub_hook event=\(.event|word) session_id=\(.session_id|safe) pid=\(.pid|safe) at=\(.at|safe)"' \
            "${file}" 2> /dev/null || printf 'reopen-observe: persona=%s stub_hook=unreadable\n' "${name}"
    done
    file="$(_scenario_session_file "${ROOT}/${name}" sessions 2> /dev/null)" \
        || { printf 'reopen-observe: persona=%s mcp_sessions=unavailable\n' "${name}"; return 0; }
    [[ -f "${file}" ]] || { printf 'reopen-observe: persona=%s mcp_sessions=absent\n' "${name}"; return 0; }
    jq -r --arg name "${name}" "${REOPEN_SAFE}"'
        "reopen-observe: persona=\($name) mcp_session event=\(.event|word) session_id=\(.session_id|safe) reason=\(.reason|word) pid=\(.pid|safe)"' \
        "${file}" 2> /dev/null || printf 'reopen-observe: persona=%s mcp_sessions=unreadable\n' "${name}"
}
reopen_observe() {
    local name slice
    [[ -n "${REOPEN_OBSERVE:-}" ]] || return 0
    printf 'reopen-observe: case=%s failed between the reopen stop and its measured seal\n' "${CASE}"
    cat -- "${ROOT}/reopen-observe.rows" 2> /dev/null
    reopen_ad_rows at-failure
    slice="${ROOT}/reopen-observe.log"
    log_slice "${SLACK_STATE_DIR}/server.log" "${REOPEN_OBSERVE_LOG:-0}" "${slice}" 2> /dev/null || : > "${slice}"
    for name in "${KEYS[@]}"; do
        reopen_lifecycle "${name}" "${slice}"
        reopen_stub_records "${name}"
    done
}

# Test-only CPU profile of one case's measured server over its fault burst
# and ordered writes (tests/integration/fixtures/cpu-profile.ts): only the
# case `--cpu-profile` names opts in when CSCB_TEST_DIAGNOSTICS=1, and only
# test-45 passes it (strict first-hang). The profile
# stays in the case's scratch; only its content-free summary reaches the log,
# once: right after the burst and ordered writes, or from the cleanup hook,
# which first stops the profile (bounded) while the server still runs, so the
# wave in progress is saved too. No profile step changes the script's status.
MEMBERSHIP_PROFILE_CASE=''
MEMBERSHIP_PROFILE_DIR=''
MEMBERSHIP_PROFILE_SUMMARIZED=0
MEMBERSHIP_PROFILE_CLEANUP_STOP_S=10
membership_profile_open() {
    MEMBERSHIP_PROFILE_DIR=''
    MEMBERSHIP_PROFILE_SUMMARIZED=0
    [[ -n "${MEMBERSHIP_PROFILE_CASE}" && "${CASE_KIND}" == "${MEMBERSHIP_PROFILE_CASE}" ]] || return 0
    if mkdir -p "${ROOT}/cpu-profile" 2> /dev/null; then
        MEMBERSHIP_PROFILE_DIR="${ROOT}/cpu-profile"
    else
        printf 'recorded: cpu-profile unavailable reason=profile-directory\n'
    fi
}
# Waits up to $1 s for the profile to finish, marking `end` if no `end` is
# marked yet, then prints its summary; once per case.
membership_profile_collect() {
    [[ -n "${MEMBERSHIP_PROFILE_DIR}" && "${MEMBERSHIP_PROFILE_SUMMARIZED}" == 0 ]] || return 0
    MEMBERSHIP_PROFILE_SUMMARIZED=1
    if [[ -s "${MEMBERSHIP_PROFILE_DIR}/waves" ]]; then
        bun "${SCENARIO_FIXTURES}/cpu-profile.ts" stop "${MEMBERSHIP_PROFILE_DIR}" "$1" || printf 'recorded: cpu-profile stop unavailable\n'
    fi
    bun "${SCENARIO_FIXTURES}/cpu-profile.ts" summary "${MEMBERSHIP_PROFILE_DIR}" "${C[@]}" || printf 'recorded: cpu-profile summary unavailable\n'
}
membership_profile_cleanup() { membership_profile_collect "${MEMBERSHIP_PROFILE_CLEANUP_STOP_S}"; }

run_membership_load() {
    local group="${2:-}" case_kinds=()
    require_ci_image "membership load"
    require_scenario_home "membership load"
    [[ ( "$#" == 2 || ( "$#" == 4 && "$3" == --cpu-profile && "$4" == first-hang && "$1" == strict && "${group}" == hang ) ) && ( "$1" == strict || "$1" == open ) ]] \
        || fail 'membership load requires a channel mode and fault group, optionally --cpu-profile first-hang for strict hang'
    MODE="$1"
    case "${group}" in
        hang|transient|rate|scope|denied) case_kinds=("first-${group}" "later-${group}") ;;
        late) case_kinds=(late later-late) ;;
        lookup|undurable) case_kinds=("${group}") ;;
        *) fail 'unknown membership load fault group' ;;
    esac
    MEMBERSHIP_PROFILE_CASE=''
    if [[ "${CSCB_TEST_DIAGNOSTICS:-}" == 1 ]]; then MEMBERSHIP_PROFILE_CASE="${4:-}"; fi
    E="${SCENARIO_FIXTURES}/sr8-evidence.ts"
    source "${SCENARIO_FIXTURES}/../lib/sr8-attribution.sh"
    PRINTER="${SCENARIO_FIXTURES}/fmk-texts.ts"
    # Every burst driver runs off the server's CPU quota; driver-cpu judges that.
    BURST_DRIVER="${SCENARIO_FIXTURES}/burst-driver.sh"
    on_exit repair_modes
    on_before_cleanup reopen_observe
    if [[ -n "${MEMBERSHIP_PROFILE_CASE}" ]]; then on_before_cleanup membership_profile_cleanup; fi

    REQUEST_MS="$(printed MEMBERSHIP_REQUEST_TIMEOUT_MS)"
    ATTEMPT_MS="$(printed MEMBERSHIP_ATTEMPT_TIMEOUT_MS)"
    RETRY_MAX_MS="$(printed MEMBERSHIP_RETRY_MAX_MS)"
    NAME_MS="$(printed NAME_LOOKUP_TIMEOUT_MS)"
    # Inventories page as CSCB asks Slack to, never as one oversized page.
    PAGE_LIMIT="$(printed MEMBERSHIP_PAGE_LIMIT)"
    MEASUREMENT_NAME="$(printed TEST_MEASUREMENTS_FILE_NAME)"
    INCOMPLETE="$(printed MEMBERSHIP_INVENTORY_INCOMPLETE)"
    READINESS_ROUTE="$(printed MEMBERSHIP_READINESS_ROUTE)"
    WRITE_TOOL="$(printed SET_CHANNEL_DELIVERY_TOOL)"
    # Observation watchdogs only: none changes the fixture's strict verdict bounds.
    WAIT_MS="$((ATTEMPT_MS + RETRY_MAX_MS + REQUEST_MS))"
    WAIT_S="$(((WAIT_MS + 999) / 1000))"
    COMPACT_MS="$(printed effectiveTestTimer queue_compact_interval_ms queue_compact_interval_ms=250)"
    OVERRIDES_LINE="$(printed buildTestTimerOverridesLine "queue_compact_interval_ms=${COMPACT_MS}")"
    OVERRIDES_STEM="$(overrides_stem "${OVERRIDES_LINE}")"

    # Keep a fresh seed per case: the fixture's joins verdict requires the before
    # set to equal the seeded population exactly. Sharing a prior burst's lifetime
    # would carry its extra joins into that set. No snapshot copy or join reset.
    # Each scheduler entrypoint selects exactly one group; every selected case
    # still performs this entire fresh seed/start/burst/recovery/reopen lifetime.
    for CASE_KIND in "${case_kinds[@]}"; do
        CASE="${TEST_NAME}-${MODE}-${CASE_KIND}"
        KIND="${CASE_KIND#*-}"
        PAGE="${CASE_KIND%%-*}"
        C=("${CASE}" "${MODE}" 100000 2)
        ROOT="${SCENARIO_ROOT}/${MODE}-${CASE_KIND}"
        BATCH="${ROOT}/batch"
        OUT="${ROOT}/evidence"
        WRITES="${ROOT}/writes"
        PLAN="${ROOT}/plan.tsv"
        mkdir -p "${BATCH}" "${WRITES}"
        membership_profile_open
        bun "${E}" cpu-mark "${ROOT}/cpu.before" || :
        new_state_dir "${MODE}-${CASE_KIND}"
        CONFIG="${SLACK_STATE_DIR}/config.json"
        # Diagnostic observers add buffered ACK/append/save rows, never verdicts.
        bun "${E}" config "${MODE}" 100000 2 "${ROOT}" "${SCENARIO_PORT}" "${COMPACT_MS}" timings | write_config
        mapfile -t KEYS < <(jq -er '.personas[].name' "${CONFIG}")
        [[ "${#KEYS[@]}" == 2 ]] || fail 'population config lacks two personas'
        P="${KEYS[0]}"
        Q="${KEYS[1]}"
        # Q always demonstrates hold/ordinary overlap. P also does so where
        # its first channel has current positive evidence.
        HOLD_KEYS=("${Q}")
        if [[ "${KIND}" == lookup || "${KIND}" == undurable || ( "${PAGE}" == later && "${KIND}" != denied ) ]]; then HOLD_KEYS+=("${P}"); fi
        mapfile -t CHANNELS < <(jq -er '.personas[0].channels[].id' "${CONFIG}")
        HOLD_CHANNEL="${CHANNELS[0]}"
        # The last config channel is outside the burst's 100 population channels.
        WRITE_CHANNEL="${CHANNELS[${#CHANNELS[@]}-1]}"
        for key in "${KEYS[@]}"; do
            mkdir "${ROOT}/${key}"
            git -C "${ROOT}/${key}" init -q
            stub_mode "${ROOT}/${key}" "${STUB_MODE_DISPLAYED_STATES}"
            # Fake credentials are an input file, never an argv or output artifact.
            FIXTURE_BOT="$(fake_token bot "${key}")" FIXTURE_APP="$(fake_token app "${key}")" \
                python3 -c 'import json,os; print(json.dumps(dict(bot_token=os.environ["FIXTURE_BOT"],app_token=os.environ["FIXTURE_APP"])))' \
                | write_file "${ROOT}/${key}.env" 600
        done
        CONTROL="${ROOT}/slack-control.json"
        slack_stub_control_seed "${CONTROL}" "${P}" "${P}" "${Q}" "${Q}"
        SCENARIO_SLACK_RECORD="${ROOT}/slack.jsonl"
        bun "${SCENARIO_FIXTURES}/slack-stub-server.ts" --record "${SCENARIO_SLACK_RECORD}" --control "${CONTROL}" \
            --ready-file "${ROOT}/slack-ready.json" > "${ROOT}/stub.log" 2>&1 &
        STUB_PID=$!
        track_pid "${STUB_PID}"
        wait_for_file "${ROOT}/slack-ready.json" 20 'Slack stub readiness'
        [[ "$(jq -er .pid "${ROOT}/slack-ready.json")" == "${STUB_PID}" ]] || fail 'wrong Slack stub PID'
        CSCB_SLACK_API_URL="$(jq -er .api_url "${ROOT}/slack-ready.json")"
        export CSCB_SLACK_API_URL
        [[ "${CSCB_SLACK_API_URL}" =~ ^http://127\.0\.0\.1:[0-9]+/api/$ ]] || fail 'non-loopback Slack stub'
        SCENARIO_SLACK_STUB_URL="${CSCB_SLACK_API_URL%/api/}"
        slack_stub_controls "${CONTROL}"
        for key in "${KEYS[@]}"; do slack_stub_inventory_pages "${key}" '' '' "${PAGE_LIMIT}" "${CHANNELS[@]}"; done

        # Decision 24: seed before ANY server start, then seal exactly once.
        MEASUREMENTS="${SLACK_STATE_DIR}/${MEASUREMENT_NAME}"
        bun "${E}" seed "${CONFIG}" "${SLACK_STATE_DIR}" 100000
        start_ready
        verdict seal first "${C[@]}" "${SLACK_STATE_DIR}/server.log" 0 "${CONFIG}"
        stop_server --stop-bots
        START_LOG="$(byte_mark "${SLACK_STATE_DIR}/server.log")"
        start_ready measured
        verdict seal measured "${C[@]}" "${SLACK_STATE_DIR}/server.log" "${START_LOG}" "${CONFIG}"
        pending_posts
        # Prebuild outside both measured windows, after pending posts exist.
        # A held root must not predate its new-channel post's issue time: slow
        # seeding/startup must not consume the production clock-skew window.
        bun "${E}" plan "${MODE}" 100000 2 "$(date +%s)" > "${PLAN}"
        build_batches
        # Independent P/Q pending calls run concurrently while pure payloads are
        # built. Wait for both session results before ordered-write submission.
        pending_results
        SCOPE=all
        if [[ "${PAGE}" == later && "${KIND}" != denied ]]; then
            # First-seen plan ordinals, excluding the one current positive page.
            SCOPE="$(awk -F '\t' '!seen[$2]++ { n++; if(n>1) {printf "%s%d",sep,n; sep=","}} END {print ""}' "${PLAN}")"
        elif [[ "${KIND}" == lookup ]]; then SCOPE=none; fi
        if [[ "${KIND}" != undurable ]]; then
            bun "${E}" fault-plan "${C[@]}" "${BATCH}" "${PLAN}" "${KIND}" 1 "${SCOPE}" "${OUT}"
        else mkdir "${OUT}"; fi
        mkdir "${OUT}/during"
        for key in "${KEYS[@]}"; do read_jsonl "${OUT}/${key}.before.jsonl" shared_thread_joins "${key}"; done
        shared_persona_facts "${P}" "${CHANNELS[99]}" > "${OUT}/membership-before.jsonl"
        CASE_LOG="$(byte_mark "${SLACK_STATE_DIR}/server.log")"
        MEASURE_MARK="$(measurement_mark)" || exit 1
        CASE_MARK="$(slack_post_mark)"
        INCOMPLETE_BEFORE="$(count_log "$(matcher "${INCOMPLETE}" "persona=${P}:")")"
        RETRY_AFTER=0
        cursor=''
        if [[ "${PAGE}" == later ]]; then
            cursor=later
            # Deliberately one current positive on the first page; the rest page normally.
            slack_stub_inventory_page "${P}" '' later "${HOLD_CHANNEL}"
            slack_stub_inventory_pages "${P}" later '' "${PAGE_LIMIT}" "${CHANNELS[@]:1}"
        fi

        case "${KIND}" in
            hang|transient|rate|scope|denied)
                extra=(times=100000)
                case "${KIND}" in
                    hang) OUTCOME=hang ;;
                    transient) OUTCOME=error; extra+=(error=internal_error) ;;
                    scope) OUTCOME=error; extra+=(error=missing_scope) ;;
                    denied) OUTCOME=error; extra+=(error=invalid_auth) ;;
                    rate) OUTCOME=rate_limit; RETRY_AFTER="$((RETRY_MAX_MS / 1000 + 1))"; extra+=("retry_after=${RETRY_AFTER}") ;;
                esac
                slack_stub_inventory_fault "${P}" "${cursor}" "${OUTCOME}" "${extra[@]}"
                slack_stub_close_socket "${P}"
                wait_until "${WAIT_S}" 'membership fault did not fire' has_record_since "${CASE_MARK}" fault \
                    "label=${P}" method=users.conversations "outcome=${OUTCOME}"
                ;;
            late)
                # Leave separate burst/repair observation windows before the
                # late settlement. Bulk timing reads no longer need six windows.
                # This injection delay does not change any production bound.
                # later-late delays the later page; the first page still answers.
                slack_stub_inventory_fault "${P}" "${cursor}" late "delay_ms=$((WAIT_MS * 2))" \
                    "body=$(slack_stub_inventory_body '')"
                # Keep replacement attempts incomplete until the explicit clear;
                # otherwise a one-shot late fault repairs before during evidence.
                slack_stub_inventory_fault "${P}" "${cursor}" hang after=1 times=100000
                slack_stub_close_socket "${P}"
                wait_until "${WAIT_S}" 'late membership request did not fire' has_record_since "${CASE_MARK}" fault \
                    "label=${P}" method=users.conversations outcome=late
                LATE_REQUEST="$(slack_stub_record_field request_id fault "label=${P}" method=users.conversations outcome=late)"
                ;;
            lookup)
                slack_stub_fault "${P}" users.info hang "user=${LOOKUP_HANG_USER}"
                slack_stub_fault "${P}" users.info late "user=${LOOKUP_LATE_USER}" "delay_ms=$((NAME_MS + 1000))"
                slack_stub_fault "${P}" conversations.info hang "channel=${LOOKUP_HANG_CHANNEL}"
                slack_stub_fault "${P}" conversations.info late "channel=${LOOKUP_LATE_CHANNEL}" "delay_ms=$((NAME_MS + 1000))"
                ;;
            undurable)
                FAILED_CHANNEL="$(scenario_id C "${CASE}-undurable-join")"
                # The held replies' post-hold records must still reach the file.
                prepare_measurements
                chmod 500 "${SLACK_STATE_DIR}"
                PROBE_RC=0
                python3 - "${SLACK_STATE_DIR}/write-probe" <<'PY' || PROBE_RC=$?
import os,sys
try:
    fd=os.open(sys.argv[1],os.O_WRONLY|os.O_CREAT|os.O_EXCL,0o600)
except PermissionError:
    sys.exit(77)
else:
    os.close(fd)
    os.unlink(sys.argv[1])
PY
                [[ "${PROBE_RC}" == 77 ]] || fail 'permission probe did not prove a refused write'
                # scenario_ts explicitly accepts zero arguments.
                # shellcheck disable=SC2119
                FAILED_ENV="$(slack_push_member_joined "${P}" "${FAILED_CHANNEL}" "$(scenario_ts)")"
                ZERO_START="$(mono_ms)"
                ;;
        esac

        if [[ "${KIND}" == undurable ]]; then
            bash "${BURST_DRIVER}" "${OUT}/driver-cgroup" bun "${E}" burst "${C[@]}" "${BATCH}" "${SCENARIO_SLACK_STUB_URL}" "${SCENARIO_SLACK_RECORD}" \
                "${SLACK_STATE_DIR}" "${OUT}" "${WAIT_MS}" "${MEASUREMENTS}" "${MEASURE_MARK}" &
        else
            # Strict keeps its whole second wave concurrent: no tail release.
            TAIL_RELEASE=()
            if [[ "${MODE}" == open ]]; then TAIL_RELEASE=("${OUT}/tail-release"); fi
            SR8_PROFILE_DIR="${MEMBERSHIP_PROFILE_DIR}" bash "${BURST_DRIVER}" "${OUT}/driver-cgroup" \
                bun "${E}" fault-burst "${C[@]}" "${OUT}" "${SCENARIO_SLACK_STUB_URL}" "${SCENARIO_SLACK_RECORD}" \
                "${SLACK_STATE_DIR}" "${MEASUREMENTS}" "${MEASURE_MARK}" "${WAIT_MS}" ${TAIL_RELEASE[@]+"${TAIL_RELEASE[@]}"} &
        fi
        BURST_PID=$!
        track_pid "${BURST_PID}"
        # A failed global shared-record write cannot itself admit a bot write.
        # Every network-fault case overlaps these ordered Q writes instead.
        if [[ "${KIND}" != undurable ]]; then ordered_writes; fi
        wait "${BURST_PID}" || fail 'full original burst did not complete'
        # The profile ends with the burst and the ordered writes, and its
        # summary prints at once, so a later failing verdict keeps it.
        membership_profile_collect 30

        if [[ "${KIND}" =~ ^(hang|transient|rate|scope|denied)$ ]]; then
            wait_until "$((WAIT_S * 2))" 'two membership failures did not settle' membership_settled_twice
            stub_slice "${CASE_MARK}" "${OUT}/membership-stub.jsonl"
            log_slice "${SLACK_STATE_DIR}/server.log" "${CASE_LOG}" "${OUT}/membership.log"
            shared_persona_facts "${P}" "${CHANNELS[99]}" > "${OUT}/membership-after.jsonl"
            verdict membership-fault "${C[@]}" "${KIND}" "${PAGE}" "${P}" "${OUT}/membership-stub.jsonl" \
                "${OUT}/membership.log" "${OUT}/membership-before.jsonl" "${OUT}/membership-after.jsonl" "${RETRY_AFTER}" 0
        fi

        if [[ "${KIND}" == undurable ]]; then
            jq -er .envelope_id "${OUT}/burst.jsonl" > "${OUT}/during-ids.txt"
        else bun "${E}" fault-ids "${C[@]}" "${OUT}" > "${OUT}/during-ids.txt"; fi
        capture_times "${OUT}/during-ids.txt" "${OUT}/during-times.jsonl"
        for key in "${KEYS[@]}"; do snapshot "${key}" "${OUT}/during/${key}.queue.jsonl"; done
        if [[ "${KIND}" == undurable ]]; then
            ZERO_END="$(mono_ms)"
            slack_envelope_times "${FAILED_ENV}" > "${OUT}/zero-times.jsonl"
            log_slice "${SLACK_STATE_DIR}/server.log" "${CASE_LOG}" "${OUT}/zero.log"
            verdict zero-ack "${C[@]}" "${P}" "${FAILED_ENV}" "${OUT}/zero-times.jsonl" \
                "${ZERO_START}" "${ZERO_END}" "${PROBE_RC}" "${OUT}/zero.log"
            repair_modes
            slack_wait_one_ack "$(slack_stub_redeliver "${P}" "${FAILED_ENV}")"
            # Include the new positive in subsequent reconciliation, preserving it.
            slack_stub_inventory_pages "${P}" '' '' "${PAGE_LIMIT}" "${CHANNELS[@]}" "${FAILED_CHANNEL}"
        fi
        CLEAR_MARK="$(slack_post_mark)"
        CLEAR_EPOCH="$(epoch_ms)"
        slack_stub_faults_clear "${P}"
        if [[ "${KIND}" =~ ^(hang|transient|rate|scope|denied|late)$ ]]; then
            # No traffic, tool, reconnect or restart may trigger this repair.
            wait_until "${WAIT_S}" 'idle membership repair did not complete' \
                _scenario_membership_complete "${P}" "${READINESS_ROUTE}"
            log_slice "${SLACK_STATE_DIR}/server.log" "${CASE_LOG}" "${OUT}/repair.log"
            verdict membership-repair "${C[@]}" "${P}" "${CLEAR_EPOCH}" "${OUT}/repair.log"
        fi
        if [[ "${KIND}" == late ]]; then
            COMPLETE_MARK="$(slack_post_mark)"
            late_state "${OUT}/late-before.jsonl"
            wait_until "$((WAIT_S * 2))" 'abandoned late request never settled' has_record_since "${CASE_MARK}" \
                fault-settled "request_id=${LATE_REQUEST}"
            wait_until 30 'late membership answer was not for the staged page' has_record_since "${CASE_MARK}" \
                api "request_id=${LATE_REQUEST}" method=users.conversations "cursor=${cursor}"
            late_state "${OUT}/late-after.jsonl"
            stub_slice "${CASE_MARK}" "${OUT}/late-stub.jsonl"
            log_slice "${SLACK_STATE_DIR}/server.log" "${CASE_LOG}" "${OUT}/late.log"
            verdict membership-late "${C[@]}" "${P}" "${LATE_REQUEST}" "${OUT}/late-stub.jsonl" \
                "${COMPLETE_MARK}" "${OUT}/late.log" "${OUT}/late-before.jsonl" "${OUT}/late-after.jsonl"
        fi
        if [[ "${KIND}" != undurable ]]; then
            # One bounded driver retains every attempt and waits for each root's
            # own ACK before dependent replies. Numeric verdicts remain unchanged.
            bash "${BURST_DRIVER}" "${OUT}/driver-cgroup" bun "${E}" fault-recover "${C[@]}" "${OUT}" "${SCENARIO_SLACK_STUB_URL}" \
                "${SCENARIO_SLACK_RECORD}" "${WAIT_MS}" 64
            bun "${E}" fault-ids "${C[@]}" "${OUT}" > "${OUT}/all-ids.txt"
        else cp "${OUT}/during-ids.txt" "${OUT}/all-ids.txt"; fi
        capture_times "${OUT}/all-ids.txt" "${OUT}/times.jsonl"
        if [[ "${MODE}" == strict && "${KIND}" != undurable ]]; then
            stub_slice "${CASE_MARK}" "${WRITES}/case-stub.jsonl"
            burst_slice "${WRITES}/case-stub.jsonl" "${WRITES}/membership.tsv" "${OUT}/stub.jsonl" \
                || fail 'burst slice could not separate the membership writes'
            while IFS=$'\t' read -r _ envelope _; do slack_envelope_times "${envelope}"; done \
                < "${WRITES}/membership.tsv" > "${WRITES}/membership-times.jsonl"
        else stub_slice "${CASE_MARK}" "${OUT}/stub.jsonl"; fi
        # Stop drains the measurement recorder. Queue contents remain retained
        # by the manual-receipt stub; capture before the required clean restart.
        bun "${E}" conditions "${SLACK_STATE_DIR}" "${SERVER_PID}" "${ROOT}/cpu.before"
        verdict driver-cpu "${C[@]}" "${SERVER_PID}" "${OUT}/driver-cgroup"
        REOPEN_OBSERVE_LOG="$(byte_mark "${SLACK_STATE_DIR}/server.log")"
        reopen_ad_rows before-stop > "${ROOT}/reopen-observe.rows"
        REOPEN_OBSERVE=1
        stop_server --stop-bots
        reopen_ad_rows after-stop >> "${ROOT}/reopen-observe.rows"
        for key in "${KEYS[@]}"; do snapshot "${key}" "${OUT}/${key}.queue.jsonl"; done
        # Real traffic has stored and been drained by now: absence is a failure.
        regular_measurements || fail 'test-only measurement file missing after measured traffic'
        cp "${MEASUREMENTS}" "${OUT}/measurements.jsonl"
        # The recorder is drained and both clocks are frozen. Print before any
        # later verdict can stop the case; diagnostic failure only adds output.
        bun "${E}" diag-ack "${C[@]}" "${OUT}" "${OUT}/measurements.jsonl" "${MEASURE_MARK}" \
            || printf 'recorded: sr8 diag diagnostic=ack-unavailable\n'
        REOPEN_LOG="$(byte_mark "${SLACK_STATE_DIR}/server.log")"
        start_ready
        verdict seal measured "${C[@]}" "${SLACK_STATE_DIR}/server.log" "${REOPEN_LOG}" "${CONFIG}"
        REOPEN_OBSERVE=''
        for key in "${KEYS[@]}"; do read_jsonl "${OUT}/${key}.after.jsonl" shared_thread_joins "${key}"; done
        if [[ "${KIND}" != undurable && "${MODE}" == strict ]]; then
            write_states "${WRITES}/reopened.jsonl"
            applied_events "${WRITES}/events.reopened.jsonl"
            verdict membership-writes "${C[@]}" "${WRITES}" "${Q}" "${WRITE_CHANNEL}" "${WRITES}/case-stub.jsonl" \
                "${WRITE_SUBMIT}" "${WRITE_RESULT}" "${OUT}/times.jsonl"
        elif [[ "${KIND}" != undurable ]]; then
            read_jsonl "${WRITES}/reopened.jsonl" shared_attempt_order "${Q}"
            # Ordered-write N1 covers Q's concurrent traffic. Fault-check also
            # judges P's independent originals and all dependent replay ACKs.
            jq -c --arg key "${Q}" 'select(.label==$key)' "${OUT}/stub.jsonl" > "${WRITES}/stub.jsonl"
            verdict ordered-writes "${C[@]}" "${WRITES}" "${WRITES}/stub.jsonl" \
                "${WRITE_SUBMIT}" "${WRITE_RESULT}" "${OUT}/times.jsonl"
        fi
        if [[ "${KIND}" == lookup ]]; then
            for probe in user-hang user-late channel-hang channel-late; do
                outcome="${probe#*-}"
                case "${probe}" in
                    user-hang) ts="${LOOKUP_HANG_TS}"; match="${LOOKUP_HANG_USER}"; method=users.info ;;
                    user-late) ts="${LOOKUP_LATE_TS}"; match="${LOOKUP_LATE_USER}"; method=users.info ;;
                    channel-hang) ts="${CHANNEL_HANG_TS}"; match="${LOOKUP_HANG_CHANNEL}"; method=conversations.info ;;
                    channel-late) ts="${CHANNEL_LATE_TS}"; match="${LOOKUP_LATE_CHANNEL}"; method=conversations.info ;;
                esac
                ordinal="$(jq -er --arg key "${P}" --arg ts "${ts}" '.plan.items[] | select(.key==$key and .ts==$ts and .phase=="roots") | .ordinal' "${OUT}/fault-plan.json")"
                envelope="$(jq -ser --argjson ordinal "${ordinal}" '[.[] | select(.ordinal==$ordinal and .stage=="original")] | if length==1 then .[0].envelope_id else error("missing lookup envelope") end' "${OUT}/fault-ledger.jsonl")"
                printf '%s\t%s\t%s\t%s\t%s\n' "${P}" "${method}" "${outcome}" "${match}" "${envelope}"
            done > "${OUT}/lookups.tsv"
            verdict lookup-faults "${C[@]}" "${OUT}/lookups.tsv" "${OUT}/stub.jsonl" "${OUT}/times.jsonl"
        fi
        if [[ "${KIND}" == undurable ]]; then
            verdict check "${C[@]}" "${OUT}" "${OUT}/measurements.jsonl" "${MEASURE_MARK}" "${START_MS}" "${READY_MS}"
            verdict stores "${C[@]}" "${OUT}" "${OUT}/measurements.jsonl" "${MEASURE_MARK}"
        else
            verdict fault-check "${C[@]}" "${OUT}" "${OUT}/stub.jsonl" "${CLEAR_MARK}" "${CLEAR_EPOCH}" \
                "${OUT}/measurements.jsonl" "${MEASURE_MARK}" "${START_MS}" "${READY_MS}"
        fi
        stop_server --stop-bots
        stop_tracked_pid "${STUB_PID}" 10 'Slack stub did not stop'
        [[ "$(count_token_like "${SLACK_STATE_DIR}"/server.log* "${OUT}"/*.jsonl "${ROOT}/stub.log" "${SCENARIO_SLACK_RECORD}")" == 0 ]] \
            || fail 'credential-like output in evidence'
        # Bounded disk use: successful case verdicts are already in CI stdout.
        # The harness still owns process/log enforcement and final cleanup.
        rm -r -- "${ROOT}" "${SLACK_STATE_DIR}"
    done
}
