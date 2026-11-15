# shellcheck shell=bash
# Shared setup, production-path bootstrap, observations and exact closure for
# tests 46 and 65-67. Source only from a recovery entrypoint, inside /ci.
# Every entrypoint gets scenario.sh's private state, port and persona tag;
# these remain shared-mode scenarios with only test-1 as prerequisite.
# Globals are consumed by the entrypoints. scenario_ts deliberately uses its
# own clock, without forwarding the calling helper's unrelated arguments.
# shellcheck disable=SC2034,SC2119
# The entrypoint sources scenario.sh first, before this helper does any work.

FIXTURES="$(realpath "$(dirname "$0")")/fixtures"
PRINTER="${FIXTURES}/fmk-texts.ts"
RECORD_WAIT_S=15
EVENT_WAIT_S=30
START_WAIT_S=150
DELIVERY_IDLE_WAIT_S=180
DELIVERY_MAX_WAIT_S=1800
CONFIG="${SLACK_STATE_DIR}/config.json"
LAST="${CONFIG}.last-applied"
LOG="${SLACK_STATE_DIR}/server.log"
EVIDENCE="${SCENARIO_ROOT}/evidence"
mkdir -p "${EVIDENCE}"
EXPECTED="${EVIDENCE}/expected.jsonl"
ACKS="${EVIDENCE}/acks"
NO_ACKS="${EVIDENCE}/no-acks"
: > "${EXPECTED}"
: > "${ACKS}"
: > "${NO_ACKS}"

printed() { bun "${PRINTER}" "$@" || fail "printer entry $1 failed"; }
# src/server.ts handleInitialized: an MCP session registered for a persona.
session_connected() {
    matcher "[slack] Session connected: persona $1"
}
declare -A NAME KEY WORK CREDS LABEL SNAP MANUAL INPUTS INJECTED RESTART_RELEASED=()
for who in p q; do
    NAME[${who}]="${SCENARIO_TAG}_${who}"
    KEY[${who}]="$(persona_key "${NAME[${who}]}")"
    WORK[${who}]="$(make_workdir "${who}")"
    CREDS[${who}]="${SCENARIO_ROOT}/${who}-credentials.json"
    LABEL[${who}]="${SCENARIO_TAG}-${who}"
    SNAP[${who}]="${EVIDENCE}/${who}-queue.jsonl"
    MANUAL[${who}]=true
done
A="$(scenario_id C all)"
B="$(scenario_id C hybrid)"
JOIN="$(scenario_id C live-join)"
PRIVATE="$(scenario_id G private)"
INVISIBLE="$(scenario_id G invisible)"
EXTERNAL="$(scenario_id C external)"
UNKNOWN="$(scenario_id C unknown)"
NOTICE="$(scenario_id C notice)"
HUMAN="$(scenario_id U human)"
CONTACT="$(scenario_id U contact)"
DM="$(scenario_id D direct)"

STUB_BIN="${SCENARIO_ROOT}/bin"
mkdir -p "${STUB_BIN}"
cp "${FIXTURES}/stub-claude.sh" "${STUB_BIN}/claude"
cp "${FIXTURES}/stub-mcp-session.ts" "${STUB_BIN}/stub-mcp-session.ts"
chmod +x "${STUB_BIN}/claude"
export PATH="${STUB_BIN}:${PATH}"
SCENARIO_STUB_DIR="${STUB_BIN}"
[[ "$(command -v claude)" == "${STUB_BIN}/claude" ]] || fail 'scratch stub not selected'
MCP_CONFIG="${SCENARIO_ROOT}/slack-mcp.json"
jq -n --arg name "${SCENARIO_MCP_SERVER_NAME}" --arg url "http://127.0.0.1:${SCENARIO_PORT}/mcp" \
    '{mcpServers:{($name):{type:"http",url:$url}}}' | write_file "${MCP_CONFIG}"
for who in p q; do
    bot="$(fake_token bot "${SCENARIO_TAG}${who}")"
    app="$(fake_token app "${SCENARIO_TAG}${who}")"
    printf '{"bot_token":"%s","app_token":"%s"}\n' "${bot}" "${app}" | write_file "${CREDS[${who}]}" 600
    shared_stub_permission_setup "${WORK[${who}]}" > /dev/null
done
unset bot app
STUB_CONTROL="${SCENARIO_ROOT}/slack-control.json"
SCENARIO_SLACK_RECORD="${EVIDENCE}/slack.jsonl"
slack_stub_control_seed "${STUB_CONTROL}" "${LABEL[p]}" "${SCENARIO_TAG}p" "${LABEL[q]}" "${SCENARIO_TAG}q"
bun "${FIXTURES}/slack-stub-server.ts" --record "${SCENARIO_SLACK_RECORD}" --control "${STUB_CONTROL}" \
    --ready-file "${SCENARIO_ROOT}/slack-ready.json" > "${EVIDENCE}/stub.log" 2>&1 &
STUB_PID=$!
track_pid "${STUB_PID}"
wait_for_file "${SCENARIO_ROOT}/slack-ready.json" 20 'Slack stub readiness'
[[ "$(jq -r .pid "${SCENARIO_ROOT}/slack-ready.json")" == "${STUB_PID}" ]] || fail 'wrong stub PID'
STUB_API_URL="$(jq -r .api_url "${SCENARIO_ROOT}/slack-ready.json")"
[[ "${STUB_API_URL}" =~ ^http://127\.0\.0\.1:[0-9]+/api/$ ]] || fail 'non-loopback Slack stub'
SCENARIO_SLACK_STUB_URL="${STUB_API_URL%/api/}"
export CSCB_SLACK_API_URL="${STUB_API_URL}"
slack_stub_controls "${STUB_CONTROL}"
for who in p q; do
    slack_stub_inventory_page "${LABEL[${who}]}" '' '' "${A}" "${B}" "${NOTICE}"
done
slack_stub_history 2

write_config <<EOF
{
  "channel_mode":"open",
  "personas":[
    {"name":"${NAME[p]}","credentials_file":"${CREDS[p]}","working_directory":"${WORK[p]}",
     "channels":[{"id":"${A}","delivery":"all"},{"id":"${B}","delivery":"thread_hybrid"},{"id":"${NOTICE}","delivery":"mentions"}],
     "dm":{"enabled":true,"contact":"${CONTACT}"},"permission_prompts":"${NOTICE}"},
    {"name":"${NAME[q]}","credentials_file":"${CREDS[q]}","working_directory":"${WORK[q]}",
     "channels":[{"id":"${A}","delivery":"all"},{"id":"${B}","delivery":"thread_hybrid"},{"id":"${NOTICE}","delivery":"mentions"}],
     "dm":{"enabled":true,"contact":"${CONTACT}"},"permission_prompts":"${NOTICE}"}
  ],
  "bind":"127.0.0.1","port":${SCENARIO_PORT},"health_check_interval":0,
  "session_restart_delay":0,"exit_timeout":5,"mcp_config_path":"${MCP_CONFIG}"
}
EOF

# These helpers compose public scenario interfaces; none rebuilds a journal,
# an event shape, an attempt schema or the delivery policy.
snapshot() {
    local who="$1"
    if [[ -f "${SNAP[${who}]}" ]]; then
        shared_queue_snapshot "${SNAP[${who}]}" "${KEY[${who}]}" "${SNAP[${who}]}"
    else shared_queue_snapshot "${SNAP[${who}]}" "${KEY[${who}]}"; fi
}
drain() {
    snapshot "$1"
    shared_wait_queue_drained "${KEY[$1]}" "${SNAP[$1]}" "${SNAP[$1]}" > /dev/null
    snapshot "$1"
}
# A live queue can retain full unfinished acceptances beside completed keys.
# Read it alone: merging an archive here could conceal lost live work.
retained_queue_keys() {
    local who="$1" before="$2" current="$3"
    shared_queue_snapshot "${current}" "${KEY[${who}]}"
    jq -se --slurpfile before "${before}" '
      def facts: [.[]|select(.kind=="accepted" and has("key"))|{seq,key,received_at}]|sort_by(.seq);
      ($before|map(select(has("compact")|not))|facts) as $expected |
      ($expected|length)>0 and facts==$expected
    ' "${current}" > /dev/null || fail 'live queue lost or changed retained dedupe facts'
}
# Call only after a restart following completed receipt evidence. The strict
# reader itself requires the live compacted records, never just an empty head.
compacted_queue() {
    local who="$1" before="$2" current="$3"
    wait_until 30 'completed queue did not compact after restart' shared_dedupe_preserved "${KEY[${who}]}" "${before}" > /dev/null
    shared_queue_snapshot "${current}" "${KEY[${who}]}"
    printed sharedDedupePreserved "${before}" "${current}" > /dev/null
}
ack() {
    slack_wait_one_ack "$1"
    printf '%s\n' "$1" >> "${ACKS}"
}
no_ack() {
    slack_expect_no_ack "$1" 1
    printf '%s\n' "$1" >> "${NO_ACKS}"
}
queued() { [[ "$(shared_queued_count "${KEY[$1]}" "$2" "$3" "$4")" == 1 ]]; }
queued_total() {
    local who="$1" channel="$2" ts="$3" via="${4:-}"
    snapshot "${who}"
    jq -s --arg c "${channel}" --arg ts "${ts}" --arg via "${via}" \
        '[.[]|select(.kind=="accepted" and (has("compact")|not) and .channel==$c and .ts==$ts and ($via=="" or .via==$via))]|length' "${SNAP[${who}]}"
}
# accept_observe <who> <channel> <ts> <via>: at a timed-out acceptance wait,
# the queue journal's counts and whitelisted record fields, never text,
# files or tokens. Output only; it decides nothing.
accept_observe() {
    local who="$1" channel="$2" ts="$3" via="$4" journal
    journal="${SLACK_STATE_DIR}/queue/${KEY[${who}]}.jsonl"
    printf 'accept-observe: persona=%s channel=%s ts=%s via=%s failed\n' "${KEY[${who}]}" "${channel}" "${ts}" "${via:-any}"
    if [[ ! -f "${journal}" || -L "${journal}" ]]; then printf 'accept-observe: journal=absent\n'; return 0; fi
    jq -n -r -R --arg c "${channel}" --arg ts "${ts}" --arg via "${via}" '
        def safe: if . == null then "absent" else tostring | if test("^[A-Za-z0-9_.:+-]{1,64}$") and (test("^xox") | not) then . else "invalid" end end;
        [inputs] as $lines | [$lines[] | fromjson? | select(type == "object")] as $all |
        [$all[] | select(.kind == "accepted" and (has("compact") | not) and .channel == $c and .ts == $ts)] as $match |
        "accept-observe: journal lines=\($lines | length) records=\($all | length) compact=\([$all[] | select(.kind == "accepted" and has("compact"))] | length) max_seq=\([$all[].seq] | max | safe)",
        "accept-observe: matching accepted=\($match | length) with_via=\([$match[] | select($via == "" or .via == $via)] | length)",
        ($match[] | "accept-observe: accepted seq=\(.seq | safe) source=\(.source | safe) via=\(.via | safe) thread_ts=\(.thread_ts | safe) received_at=\(.received_at | safe) released_at=\(.released_at | safe) hold=\(.hold.on | safe) hold_root_unknown=\(.hold.root_unknown | safe) hold_operations=\(.hold.operations | if . == null then null else length end | safe) hold_arrived_at=\(.hold.arrived_at | safe)"),
        ($all[] | select(.kind != "accepted" and (.seq as $s | any($match[]; .seq == $s))) |
            "accept-observe: record kind=\(.kind | safe) seq=\(.seq | safe) attempt=\(.attempt | safe) part=\(.part | safe) send_kind=\(.send_kind | safe) at=\(.at | safe) unknown_outcome=\(.unknown_outcome | safe)"),
        ($all[-20:][] | "accept-observe: tail kind=\(.kind | safe) seq=\(.seq | safe) compact=\(.compact | safe) channel=\(.channel | safe) ts=\(.ts | safe) via=\(.via | safe) hold=\(.hold.on | safe)")
    ' "${journal}" 2> /dev/null || printf 'accept-observe: journal=unreadable\n'
}
accepted() {
    local who="$1" channel="$2" ts="$3" via="$4" text="$5" root="${6:--}"
    # wait_until's own check, poll and failure text, with the journal
    # printed at the timeout.
    _scenario_check_timeout "${EVENT_WAIT_S}" 'expected one acceptance'
    if ! _scenario_poll_until "${EVENT_WAIT_S}" queued "${who}" "${channel}" "${ts}" "${via}"; then
        accept_observe "${who}" "${channel}" "${ts}" "${via}" || true
        fail "expected one acceptance (not within ${EVENT_WAIT_S}s)"
    fi
    shared_delivery_expectation "${KEY[${who}]}" "${NAME[${who}]}" slack "${channel}" "${ts}" "${HUMAN}" "${via}" | cat >> "${EXPECTED}" || fail 'expected Slack delivery reader failed'
    INPUTS["${who}|${channel}|${ts}|${via}"]="$(jq -cn --arg text "${text}" --arg root "${root}" '{text:$text,root:$root}')"
}
injected_ready() {
    shared_queue_items "${KEY[$1]}" | jq -se --arg source "$2" --arg sender "$3" --arg text "$4" \
        '[.[]|select(.source==$source and .sender==$sender and .text==$text and (has("reminder_for")|not))]|length==1' > /dev/null
}
injected() {
    local who="$1" source="$2" sender="$3" text="$4" original ts
    wait_until 80 'real injected original was not stored exactly once' injected_ready "${who}" "${source}" "${sender}" "${text}"
    original="$(shared_queue_items "${KEY[${who}]}" | jq -cs --arg source "${source}" --arg sender "${sender}" --arg text "${text}" \
        '[.[]|select(.source==$source and .sender==$sender and .text==$text and (has("reminder_for")|not))]|if length==1 then .[0] else error("ambiguous original") end')"
    ts="$(jq -er .ts <<< "${original}")"
    jq -e 'has("hold")|not' <<< "${original}" > /dev/null || fail 'injected work acquired a Post Hold'
    shared_delivery_expectation "${KEY[${who}]}" "${NAME[${who}]}" "${source}" "${sender}" "${ts}" "${sender}" - | cat >> "${EXPECTED}" || fail 'expected injected delivery reader failed'
    INJECTED["${who}|${source}|${sender}|${ts}"]="${text}"
    snapshot "${who}"
}
receipt() {
    if [[ "${MANUAL[$1]}" == true ]]; then shared_stub_permission receipt "${WORK[$1]}" "${KEY[$1]}" > /dev/null; fi
    drain "$1"
}
delivered_original() {
    local who="$1" ts="$2"
    snapshot "${who}"
    jq -se --arg ts "${ts}" '
      . as $rows | [.[]|select(.kind=="accepted" and (has("compact")|not) and .ts==$ts)] as $original |
      ($original|length)==1 and any($rows[]; .kind=="delivered" and .seq==$original[0].seq)
    ' "${SNAP[${who}]}" > /dev/null
}
# The controlled-error seam hands a builder the string CONTROLLED_ERROR. A
# builder that describes its error renders that as `string message="..."`,
# while the real fault is an Error (`Error code=... message="..."`), so the
# whole rendering is the variable part. Verbatim failure texts keep the token.
controlled_marker() {
    if [[ "$1" == *'string message="CONTROLLED_ERROR"'* ]]; then printf '%s' 'string message="CONTROLLED_ERROR"'
    else printf '%s' CONTROLLED_ERROR; fi
}
report_post() {
    local who="$1" mark="$2" artifact="$3" entry="$4" expected post prefix suffix marker; shift 4
    expected="$(printed formatPersonaNotice "${NAME[${who}]}" "${entry}" "$@")"
    marker="$(controlled_marker "${expected}")"
    prefix="${expected%"${marker}"*}"; suffix="${expected#*"${marker}"}"
    if [[ "${expected}" == *CONTROLLED_ERROR* ]]; then
        post="$(slack_wait_successful_post "${LABEL[${who}]}" "${NOTICE}" "${mark}" "${prefix}" "${suffix}")"
    else
        post="$(slack_wait_successful_post "${LABEL[${who}]}" "${NOTICE}" "${mark}" "${expected}")"
    fi
    printf '%s\n' "${post}" > "${EVIDENCE}/${artifact}.json"
    # Match the complete production-formatted text, not just a heading. The
    # controlled error seam permits only the platform's failure description.
    # One matching post across every destination proves the notice route too.
    record_after "${mark}" api method=chat.postMessage answer=ok | jq -e \
        --arg expected "${expected}" --arg pre "${prefix}" --arg suf "${suffix}" \
        --arg actor_label "${LABEL[${who}]}" --arg channel "${NOTICE}" --argjson seq "$(jq -r .seq <<< "${post}")" '
      [.[]|select(if ($expected|contains("CONTROLLED_ERROR")) then
        (.text|startswith($pre)) and (.text|endswith($suf)) else .text==$expected end)] |
      length==1 and .[0].label==$actor_label and .[0].channel==$channel and .[0].seq==$seq
    ' > /dev/null || fail 'report text, multiplicity or destination differed'
}
push() {
    local who="$1" channel="$2" ts="$3" text="$4" root="${5:--}"
    if [[ "${root}" == - ]]; then slack_push_message "${LABEL[${who}]}" "${channel}" "${text}" "${ts}" "${HUMAN}"
    else slack_push_reply "${LABEL[${who}]}" "${channel}" "${root}" "${text}" "${ts}" "${HUMAN}"; fi
}
# Readers are read into a variable first: `[[ "$(reader)" == 0 ]]` ignores a
# failed reader's status, and jq -s still prints 0 or [] on empty input.
choice_is() {
    local saved
    saved="$(shared_channel_saved "${KEY[$1]}" "$2")" || fail 'channel choice reader failed'
    [[ "${saved}" == "$3" ]]
}
stamp() { printed sharedThreadStamp "${CONFIG}" "${LAST}" "${KEY[$1]}" "$2"; }
current_joins() {
    local current
    current="$(stamp "$1" "$2")" || fail 'stamp reader failed'
    shared_thread_joins "${KEY[$1]}" "$2" "${current}"
}
root_saved() {
    current_joins "$1" "$2" | jq -se --arg root "$3" '[.[]|select(.root==$root)]|length==1' > /dev/null
}
review() {
    local id="$1"; shift
    configuration_request "${id}" request "$@" > /dev/null
    cp "${CONFIG}.pending" "${EVIDENCE}/${id}.pending"
    mv "${CONFIG}.pending" "${CONFIG}.apply"
    wait_until "${START_WAIT_S}" 'review not durably consumed' bun "${PRINTER}" sharedReviewConsumed \
        "${CONFIG}" "${LAST}" "${EVIDENCE}/${id}.pending" > /dev/null
}
# A reviewed change of a persona's name, credentials location or working
# directory, or its re-add, replaces its life: copied channel entries reset
# and discovered channels take the mode default (t1.tad.5i AC-W13, SR-4.2).
# retain <name> sets RETAIN to every channel the current input lists for that
# persona, as written, declared for replacement retention in its review.
retain() {
    mapfile -t RETAIN < <(jq -r --arg who "$1" '.personas[]|select(.name==$who)|.channels[]|"\($who)/\(.id)/\(.delivery)"' "${CONFIG}")
    (( ${#RETAIN[@]} > 0 )) || fail "no configured channel to retain for $1"
}
set_choice() {
    local who="$1" channel="$2" value="$3" id="$4"
    expect_attempt "${id}" "${WORK[${who}]}" "$(attempt_args "$(scenario_attempt_id "${id}")" "${channel}" "${value}")" "${KEY[${who}]}" "${value}"
}
same_channel_facts() { shared_persona_facts "${KEY[$1]}" "$2" | jq -cS 'del(.mode,.historicalMembership)'; }
assert_stamps() {
    local who
    for who in p q; do
        shared_persona_facts "${KEY[${who}]}" | jq -e \
            'all(.assignments[]; (.delivery=="thread_hybrid") == (has("threadHybridSince")))' > /dev/null \
            || fail 'delivery and Thread Hybrid Since disagree'
    done
}
start() {
    local who
    start_server --live
    for who in p q; do wait_membership_complete "${KEY[${who}]}"; done
    assert_stamps
}
crash() {
    local pid
    snapshot p
    snapshot q
    pid="$(server_pid)"
    [[ "${pid}" == "${SERVER_PID}" ]] || fail 'server identity changed before crash'
    _scenario_pid_ours "${pid}" || fail 'crash target does not belong to scenario'
    kill -KILL "${pid}"
    wait_until 15 'killed server still alive' _scenario_pid_gone "${pid}"
    printf 'killed-server %s\n' "${pid}" >> "${EVIDENCE}/crashes"
    assert_stamps
}
file_fault() {
    local path="$1"
    [[ "${path}" == "${SLACK_STATE_DIR}"/* && -f "${path}" && ! -L "${path}" ]] || fail 'unsafe fault path'
    chmod 400 "${path}"
    python3 - "${path}" <<'PY'
import os,sys
try:
    fd=os.open(sys.argv[1],os.O_WRONLY|os.O_APPEND)
except PermissionError:
    print('probe-write-refused')
else:
    os.close(fd)
    sys.exit('fault ineffective: scenario user can open the journal for writing')
PY
}
directory_fault() {
    chmod 500 "${SLACK_STATE_DIR}"
    python3 - "${SLACK_STATE_DIR}/fault-probe" <<'PY'
import os,sys
try:
    fd=os.open(sys.argv[1],os.O_WRONLY|os.O_CREAT|os.O_EXCL,0o600)
except PermissionError:
    print('probe-write-refused')
else:
    os.close(fd)
    os.unlink(sys.argv[1])
    sys.exit('fault ineffective: scenario user can create state files')
PY
}
repair_modes() {
    chmod 700 "${SLACK_STATE_DIR}"
    local who path
    for who in p q; do
        for path in "${SLACK_STATE_DIR}/queue/${KEY[${who}]}.jsonl" "${SLACK_STATE_DIR}/threads/${KEY[${who}]}.jsonl"; do
            if [[ -f "${path}" && ! -L "${path}" ]]; then chmod 600 "${path}"; fi
        done
    done
}
on_exit repair_modes

record_after() {
    local mark="$1" event="$2"; shift 2
    slack_stub_records "${event}" "$@" | jq -sc --argjson mark "${mark}" '[.[]|select(.seq>$mark)]'
}
has_record_after() { [[ "$(record_after "$@" | jq length)" -gt 0 ]]; }
recovery_membership_budgets() {
    membership_request_ms="$(printed MEMBERSHIP_REQUEST_TIMEOUT_MS)"
    membership_attempt_ms="$(printed MEMBERSHIP_ATTEMPT_TIMEOUT_MS)"
    membership_retry_ms="$(printed MEMBERSHIP_RETRY_MAX_MS)"
    recovery_bound_s="$(( (membership_attempt_ms + membership_retry_ms + 999) / 1000 + 30 ))"
    incomplete="$(printed MEMBERSHIP_INVENTORY_INCOMPLETE)"
}

declare -a EXTRA_CHANNELS=()

recovery_lookup_budgets() {
    lookup_deadline_ms="$(printed THREAD_MEMORY_LOOKUP_DEADLINE_MS)"
    lookup_min_ms="$(printed THREAD_MEMORY_RETRY_MIN_MS)"
    lookup_max_ms="$(printed THREAD_MEMORY_RETRY_MAX_MS)"
    lookup_bound_s="$(( (lookup_deadline_ms + lookup_max_ms + 999) / 1000 + 30 ))"
    EXTRA_CHANNELS=()
}

# The persona's Web client gives each attempt 30 s
# (PERSONA_WEB_API_REQUEST_TIMEOUT_MS) and its library retries a timed-out
# attempt as a new chat.postMessage. Phase 13 holds its post past that, so
# every later attempt is lost too, never performed: only the first attempt's
# answer (a delayed one must come inside its 30 s) can settle the post.
lose_post() {
    local performed="$1" delay="${2:-}"
    if [[ -n "${delay}" ]]; then slack_stub_post_lost "${LABEL[p]}" "${OP_CHANNEL}" "${performed}" "delay_ms=${delay}"
    else slack_stub_post_lost "${LABEL[p]}" "${OP_CHANNEL}" "${performed}"; fi
    slack_stub_post_lost "${LABEL[p]}" "${OP_CHANNEL}" false after=1 times=100000
}
pending_post() {
    local case_name="$1" performed="$2" delay="${3:-}" before rows facts
    OP_CHANNEL="$(scenario_id C "post-${case_name}")"
    EXTRA_CHANNELS+=("${OP_CHANNEL}")
    slack_stub_inventory_page "${LABEL[p]}" '' '' "${A}" "${B}" "${NOTICE}" "${EXTRA_CHANNELS[@]}"
    ack "$(slack_push_member_joined "${LABEL[p]}" "${OP_CHANNEL}" "$(scenario_ts)")"
    wait_membership_complete "${KEY[p]}"
    set_choice p "${OP_CHANNEL}" thread_hybrid "post-choice-${case_name}"
    OP_STAMP="$(stamp p "${OP_CHANNEL}")"
    before="$(shared_own_post_records "${KEY[p]}" | jq -sc '[.[]|select(.kind=="post-intent")|.operationId]')"
    slack_stub_faults_clear "${LABEL[p]}"
    lose_post "${performed}" "${delay}"
    slack_stub_history_fault "${LABEL[p]}" history hang "channel=${OP_CHANNEL}" times=100000
    OP_MARK="$(slack_post_mark)"
    OP_TEXT="$(scenario_text "post-${case_name}")"
    OP_CALL="$(stub_session_submit "${WORK[p]}" reply "$(jq -cn --arg c "${OP_CHANNEL}" --arg t "${OP_TEXT}" '{chat_id:$c,text:$t}')")"
    wait_until 30 'lost post fault not reached' has_record_after "${OP_MARK}" fault "label=${LABEL[p]}" method=chat.postMessage outcome=lost
    rows="$(record_after "${OP_MARK}" fault "label=${LABEL[p]}" method=chat.postMessage outcome=lost)"
    jq -e --argjson performed "${performed}" 'length==1 and .[0].performed==$performed' <<< "${rows}" > /dev/null || fail 'ambiguous lost post evidence'
    printf '%s\n' "${rows}" > "${EVIDENCE}/post-${case_name}-fault.json"
    if [[ "${performed}" == true ]]; then OP_ROOT="$(jq -er '.[0].response_ts' <<< "${rows}")"
    else OP_ROOT="$(scenario_ts)"; fi
    rows="$(shared_own_post_records "${KEY[p]}")"
    OP_ID="$(jq -ser --argjson before "${before}" --arg c "${OP_CHANNEL}" --argjson stamp "${OP_STAMP}" '
      [.[]|select(.kind=="post-intent")|select(.operationId as $id|$before|index($id)|not)] |
      if length==1 and .[0].channel==$c and .[0].stamp==$stamp then .[0].operationId
      else error("expected one new operation under the independently retained stamp") end' <<< "${rows}")"
    facts="$(shared_persona_facts "${KEY[p]}" "${OP_CHANNEL}")"
    jq -e --argjson stamp "${OP_STAMP}" --arg channel "${OP_CHANNEL}" '
      .incarnation==$stamp.incarnation and .assignments[$channel].threadHybridSince==$stamp.threadHybridSince
    ' <<< "${facts}" > /dev/null || fail 'own post stamp no longer current'
    wait_membership_complete "${KEY[p]}"
    shared_wait_own_post_state "${KEY[p]}" "${OP_ID}" "${OP_CHANNEL}" "${OP_STAMP}" unresolved \
        > "${EVIDENCE}/post-${case_name}-unresolved.json"
}
post_hold() {
    local case_name="$1" hold facts
    OP_REPLY_TS="$(scenario_ts)"; OP_REPLY_TEXT="$(scenario_text "post-hold-${case_name}")"
    OP_ENVELOPE="$(push p "${OP_CHANNEL}" "${OP_REPLY_TS}" "${OP_REPLY_TEXT}" "${OP_ROOT}")"
    ack "${OP_ENVELOPE}"
    accepted p "${OP_CHANNEL}" "${OP_REPLY_TS}" thread "${OP_REPLY_TEXT}" "${OP_ROOT}"
    hold="$(shared_queue_items "${KEY[p]}" | jq -cse --arg c "${OP_CHANNEL}" --arg ts "${OP_REPLY_TS}" '
      [.[]|select(.channel==$c and .ts==$ts and .hold.on=="post")]|if length==1 then .[0].hold else error("missing exact Post Hold") end')"
    jq -e --arg operation "${OP_ID}" --argjson stamp "${OP_STAMP}" \
        '.operations==[$operation] and .stamp==$stamp' <<< "${hold}" > /dev/null || fail 'Post Hold bound a different operation or stamp'
    printf '%s\n' "${hold}" > "${EVIDENCE}/post-${case_name}-hold.json"
    snapshot p
    facts="$(shared_persona_facts "${KEY[p]}" "${OP_CHANNEL}")"
    jq -e --argjson stamp "${OP_STAMP}" --arg channel "${OP_CHANNEL}" \
        '.incarnation==$stamp.incarnation and .assignments[$channel].threadHybridSince==$stamp.threadHybridSince' \
        <<< "${facts}" > /dev/null || fail 'Post Hold authority changed'
    shared_wait_own_post_state "${KEY[p]}" "${OP_ID}" "${OP_CHANNEL}" "${OP_STAMP}" unresolved \
        > "${EVIDENCE}/post-${case_name}-held-unresolved.json"
}
# The next start releases this Post Hold's reply before p's client serves
# (src/server.ts recoverQueueKeyAtStart), so its tag keeps the documented ID
# fallback for user and channel names (docs/bots.md; MI answers47 Q1).
released_at_start() { RESTART_RELEASED["p|${OP_CHANNEL}|${OP_REPLY_TS}|thread"]=1; }
ordinary_receipts() {
    for who in p q; do
        drain "${who}"
        shared_stub_notice end "${WORK[${who}]}" "${KEY[${who}]}" "${EVIDENCE}/${who}-end.json" > /dev/null
        shared_stub_notice resume "${WORK[${who}]}" "${KEY[${who}]}" "${EVIDENCE}/${who}-end.json" > /dev/null
        MANUAL[${who}]=false
    done
}

recovery_start_ordinary() {
    # Create each real registered worker and its queue through a receipted input.
    # Then use the same graceful end/resume transition as old phase 3.
    start
    for who in p q; do
        ts="$(scenario_ts)"; text="$(scenario_text "${who}-seed")"
        env_id="$(push "${who}" "${A}" "${ts}" "${text}")"
        ack "${env_id}"
        accepted "${who}" "${A}" "${ts}" receive_all_shared "${text}"
        receipt "${who}"
    done
    ordinary_receipts
}

recovery_seed_memory() {
    # A qualifying real mention creates the journal and root before any file
    # fault. No authority, queue, Thread Memory or AD records are synthesized.
    memory_path="${SLACK_STATE_DIR}/threads/${KEY[p]}.jsonl"
    changed="$(printed THREAD_MEMORY_CHANGED_WHILE_STOPPED)"
    local seed_root seed_text
    seed_root="$(scenario_ts)"
    seed_text="$(scenario_mention_text "$(slack_stub_identity "${LABEL[p]}" user_id)" "$(scenario_text bootstrap-memory-root)")"
    ack "$(push p "${B}" "${seed_root}" "${seed_text}")"
    accepted p "${B}" "${seed_root}" mention "${seed_text}"
    receipt p
    wait_until 30 'bootstrap Thread Memory root not saved' root_saved p "${B}" "${seed_root}"
    [[ -f "${memory_path}" && ! -L "${memory_path}" ]] || fail 'bootstrap did not create a real Thread Memory journal'
}

expected_names() {
    local identity="$1" channel="$2" via="$3" user channel_name
    if [[ -n "${RESTART_RELEASED[${identity}]:-}" ]]; then printf '%s\t%s\n' "${HUMAN}" "${channel}"; return 0; fi
    user="$(scenario_stub_name user "${HUMAN}")"; channel_name="$(scenario_stub_name channel "${channel}")"
    # src/delivery-intake.ts channelName uses the fixed DM display name.
    [[ "${via}" != dm ]] || channel_name=dm
    printf '%s\t%s\n' "${user}" "${channel_name}"
}
recovery_finish() {
    local expected_restart_released="$1"
    # Exact closure: every accepted original has its independently retained
    # content/via and own-session receipt, including evidence before compaction.
    for who in p q; do drain "${who}"; done
    stop_server --stop-bots
    for who in p q; do snapshot "${who}"; done
    # The multipart group checks its sentinel after every worker has stopped,
    # preserving the original closure's final no-repost observation boundary.
    if (( $# > 1 )); then "$2"; fi
    # message-received is a per-server-run diagnostic: an item still queued at a
    # stop is logged again when the next start recovers it (MI answers46).
    shared_assert_accounting --per-server-run "${EXPECTED}" "${LOG}" "${KEY[p]}" "${SNAP[p]}" "${KEY[q]}" "${SNAP[q]}" > /dev/null
    [[ "${#RESTART_RELEASED[@]}" == "${expected_restart_released}" ]] || fail 'unexpected count of replies released from a Post Hold at a restart'
    for identity in "${!RESTART_RELEASED[@]}"; do [[ -n "${INPUTS[${identity}]:-}" ]] || fail 'restart-released reply is not an accepted input'; done
    for identity in "${!INPUTS[@]}"; do
        IFS='|' read -r who channel ts via <<< "${identity}"
        input="${INPUTS[${identity}]}"
        text="$(jq -r .text <<< "${input}")"; root="$(jq -r .root <<< "${input}")"
        names="$(expected_names "${identity}" "${channel}" "${via}")"
        IFS=$'\t' read -r user_name channel_name <<< "${names}"
        parts="$(shared_expected_parts "${text}" "${ts}" "${HUMAN}" "${user_name}" \
            "${channel}" "${channel_name}" "${via}" "${root}" -)"
        shared_assert_content "${KEY[${who}]}" "${LOG}" "${SNAP[${who}]}" "${channel}" "${ts}" "${text}" "${parts}" - > /dev/null
    done
    for identity in "${!INJECTED[@]}"; do
        IFS='|' read -r who source sender ts <<< "${identity}"
        text="${INJECTED[${identity}]}"
        parts="$(shared_injected_expected_parts "${text}" "${ts}" "${sender}")"
        shared_assert_injected_content "${KEY[${who}]}" "${LOG}" "${SNAP[${who}]}" "${source}" "${sender}" "${ts}" "${text}" "${parts}" > /dev/null
    done
    while IFS= read -r envelope; do [[ "$(slack_ack_count "${envelope}")" == 1 ]] || fail 'handled envelope ACK count changed'; done < "${ACKS}"
    while IFS= read -r envelope; do
        acks_n="$(slack_ack_count "${envelope}")" || fail 'ACK reader failed'
        [[ "${acks_n}" == 0 ]] || fail 'withheld envelope was acknowledged'
    done < "${NO_ACKS}"
    pushes_n="$(slack_stub_record_count push)" || fail 'stub record reader failed'
    [[ "${pushes_n}" == "$(( $(wc -l < "${ACKS}") + $(wc -l < "${NO_ACKS}") ))" ]] || fail 'unaccounted push'
    stop_tracked_pid "${STUB_PID}"
    leak_files=("${SLACK_STATE_DIR}"/server.log* "${LAST}" "${EVIDENCE}"/* "${STUB_BIN}"/stub-mcp-results.*.jsonl)
    leaks_n="$(count_token_like "${leak_files[@]}")" || fail 'token scan failed'
    [[ "${leaks_n}" == 0 ]] || fail 'token-like data in recovery evidence'
    echo "PASS: ${TEST_NAME}"
}

