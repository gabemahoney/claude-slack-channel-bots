#!/usr/bin/env bash
# Shared-channel recovery on the packed server. Run only through /ci.
# Each persona has its own authenticated Socket Mode envelope and ACK.
# Aggregate P/Q ACK composition lives in persona-routing.test.ts (MI decision4).
# File faults must refuse a probe by this same user; root bypass is a failure.
# Every restart reopens the same state, and snapshots retain pre-compaction
# acceptance and receipt evidence. Static checks do not establish runtime PASS.
set -euo pipefail
TEST_NAME="test-46-shared-channel-recovery"
# shellcheck source=lib/scenario.sh
source "$(dirname "$0")/lib/scenario.sh"

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
declare -A NAME KEY WORK CREDS LABEL SNAP MANUAL INPUTS INJECTED
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

# Phase 1: a delayed head across process death. The second acceptance must
# remain unsent, despite the first having been typed into the real stub.
start
for who in p q; do
    ts="$(scenario_ts)"; text="$(scenario_text "${who}-seed")"
    env_id="$(push "${who}" "${A}" "${ts}" "${text}")"
    ack "${env_id}"
    accepted "${who}" "${A}" "${ts}" receive_all_shared "${text}"
    receipt "${who}"
done
head_ts="$(scenario_ts)"; head_text="$(scenario_text delayed-head)"
tail_ts="$(scenario_ts)"; tail_text="$(scenario_text delayed-tail)"
ack "$(push p "${A}" "${head_ts}" "${head_text}")"
accepted p "${A}" "${head_ts}" receive_all_shared "${head_text}"
ack "$(push p "${A}" "${tail_ts}" "${tail_text}")"
accepted p "${A}" "${tail_ts}" receive_all_shared "${tail_text}"
head_only() {
    snapshot p
    jq -se --arg head "${head_ts}" --arg tail "${tail_ts}" '
      . as $rows | (map(select(.kind=="accepted" and .ts==$head))[0].seq) as $h |
      (map(select(.kind=="accepted" and .ts==$tail))[0].seq) as $t |
      $h != null and $t != null and
      any($rows[]; .kind=="sent" and .seq==$h) and
      all($rows[]; ((.kind=="sent" or .kind=="delivered") and .seq==$t)|not)' "${SNAP[p]}" > /dev/null
}
wait_until 30 'head not in flight or tail overtook it' head_only
crash
start
head_only || fail 'restart let tail overtake unreceipted head'
shared_stub_permission receipt "${WORK[p]}" "${KEY[p]}" > /dev/null
shared_stub_permission receipt "${WORK[p]}" "${KEY[p]}" > /dev/null
drain p

# Phase 2: independent authenticated P/Q envelope failure/replay. Each row
# faults one recipient's real queue and proves the sibling continues. The
# mention/Broadcast joins are checked before stale-stamp replay on restart.
for failed in p q; do
    other=p; [[ "${failed}" == p ]] && other=q
    root="$(scenario_ts)"
    for kind in mention broadcast thread; do
        ts="$(scenario_ts)"; parent=-
        case "${kind}" in
            mention) ts="${root}"; text="$(scenario_mention_text "$(slack_stub_identity "${LABEL[${failed}]}" user_id)" "$(scenario_text "${failed}-mention")")" ;;
            broadcast) text="$(scenario_broadcast_text here "$(scenario_text "${failed}-broadcast")")" ;;
            thread) text="$(scenario_text "${failed}-followed")"; parent="${root}" ;;
        esac
        file_fault "${SLACK_STATE_DIR}/queue/${KEY[${failed}]}.jsonl" >> "${EVIDENCE}/faults"
        first="$(push "${failed}" "${B}" "${ts}" "${text}" "${parent}")"
        no_ack "${first}"
        duplicate="$(slack_stub_redeliver "${LABEL[${failed}]}" "${first}")"
        slack_stub_control_fired redelivery "envelope_id=${duplicate}" > /dev/null
        no_ack "${duplicate}"
        queued_n="$(shared_queued_count "${KEY[${failed}]}" "${B}" "${ts}")" || fail 'queue reader failed'
        [[ "${queued_n}" == 0 ]] || fail 'failed queue retained input'
        control_ts="$(scenario_ts)"; control_text="$(scenario_text "${other}-independent-${kind}")"
        ack "$(push "${other}" "${A}" "${control_ts}" "${control_text}")"
        accepted "${other}" "${A}" "${control_ts}" receive_all_shared "${control_text}"
        receipt "${other}"
        chmod 600 "${SLACK_STATE_DIR}/queue/${KEY[${failed}]}.jsonl"
        replay="$(slack_stub_redeliver "${LABEL[${failed}]}" "${first}")"
        ack "${replay}"
        accepted "${failed}" "${B}" "${ts}" "${kind}" "${text}" "${parent}"
        receipt "${failed}"
        ack "$(slack_stub_redeliver "${LABEL[${failed}]}" "${first}")"
        [[ "$(queued_total "${failed}" "${B}" "${ts}" "${kind}")" == 1 ]] || fail 'replay duplicated acceptance'
        if [[ "${kind}" != thread ]]; then wait_until 30 'join not saved' root_saved "${failed}" "${B}" "${ts}"; fi
        printf '%s\t%s\t%s\t%s\n' "${failed}" "${first}" "${ts}" "${kind}" >> "${EVIDENCE}/replays"
    done
done
connected="$(count_log "$(session_connected "$(persona_ref "${NAME[p]}")")")"
connected_q="$(count_log "$(session_connected "$(persona_ref "${NAME[q]}")")")"
crash
start
wait_for_count "$(session_connected "$(persona_ref "${NAME[p]}")")" "$((connected + 1))" "${START_WAIT_S}" 'restarted worker did not reconnect'
wait_for_count "$(session_connected "$(persona_ref "${NAME[q]}")")" "$((connected_q + 1))" "${START_WAIT_S}" 'restarted q worker did not reconnect'
for who in p q; do
    before="$(stamp "${who}" "${B}")"
    # A live join or leave forces a fresh authenticated scan, so the page
    # changes before each event and that scan settles before the next change.
    slack_stub_inventory_page "${LABEL[${who}]}" '' '' "${A}" "${NOTICE}"
    leave="$(slack_push_channel_left "${LABEL[${who}]}" "${B}" "$(scenario_ts)")"
    ack "${leave}"
    wait_until 30 'leave did not remove choice' choice_is "${who}" "${B}" ''
    wait_membership_complete "${KEY[${who}]}"
    slack_stub_inventory_page "${LABEL[${who}]}" '' '' "${A}" "${B}" "${NOTICE}"
    ack "$(slack_push_member_joined "${LABEL[${who}]}" "${B}" "$(scenario_ts)")"
    wait_until 30 'rejoin did not use open default' choice_is "${who}" "${B}" mentions
    wait_membership_complete "${KEY[${who}]}"
    set_choice "${who}" "${B}" thread_hybrid "${who}-after-leave"
    stamp_now="$(stamp "${who}" "${B}")" || fail 'stamp reader failed'
    [[ "${stamp_now}" != "${before}" ]] || fail 'leave reused stamp'
done
while IFS=$'\t' read -r who envelope ts kind; do
    ack "$(slack_stub_redeliver "${LABEL[${who}]}" "${envelope}")"
    joins_now="$(current_joins "${who}" "${B}")" || fail 'Thread Memory reader failed'
    [[ -z "${joins_now}" ]] || fail 'old replay joined under new stamp'
done < "${EVIDENCE}/replays"

# Phase 3: after the manual-receipt boundary use ordinary receipt mode. Each
# transition is the actual registered worker's graceful end/resume, never a
# fabricated AD state. The server-notice helper preserves session identity.
for who in p q; do
    drain "${who}"
    shared_stub_notice end "${WORK[${who}]}" "${KEY[${who}]}" "${EVIDENCE}/${who}-end.json" > /dev/null
    shared_stub_notice resume "${WORK[${who}]}" "${KEY[${who}]}" "${EVIDENCE}/${who}-end.json" > /dev/null
    MANUAL[${who}]=false
done

# Phase 4: live membership faults, duplicate envelopes, durable replay and
# future intent. Pending same-channel/unrelated operator edits are retained
# across bot writes, live membership changes and a kill of the owning server.
configuration_request pending-edits request "${NAME[p]}/${B}/off" "${NAME[p]}/${A}/mentions" > /dev/null
cp "${CONFIG}.pending" "${EVIDENCE}/old-intent.pending"
set_choice p "${B}" thread_hybrid bot-during-pending
for action in join leave; do
    before="$(same_channel_facts p "${JOIN}")"
    directory_fault >> "${EVIDENCE}/faults"
    # Scans fail on storage until the repair; any later scan then agrees with
    # the pending event, whichever lands first.
    event_ts="$(scenario_ts)"
    if [[ "${action}" == join ]]; then
        slack_stub_inventory_page "${LABEL[p]}" '' '' "${A}" "${B}" "${NOTICE}" "${JOIN}"
        first="$(slack_push_member_joined "${LABEL[p]}" "${JOIN}" "${event_ts}")"
    else
        slack_stub_inventory_page "${LABEL[p]}" '' '' "${A}" "${B}" "${NOTICE}"
        first="$(slack_push_channel_left "${LABEL[p]}" "${JOIN}" "${event_ts}")"
    fi
    no_ack "${first}"
    duplicate="$(slack_stub_redeliver "${LABEL[p]}" "${first}")"
    no_ack "${duplicate}"
    facts_now="$(same_channel_facts p "${JOIN}")" || fail 'persona facts reader failed'
    [[ "${facts_now}" == "${before}" ]] || fail 'failed membership changed durable choice'
    held_ts="$(scenario_ts)"; held_text="$(scenario_mention_text "$(slack_stub_identity "${LABEL[p]}" user_id)" "$(scenario_text held-membership)")"
    held="$(push p "${JOIN}" "${held_ts}" "${held_text}")"
    no_ack "${held}"
    result="$(scenario_attempt_call "${WORK[p]}" "$(attempt_args "$(scenario_attempt_id "held-${action}")" "${JOIN}" all)")"
    jq -e '.isError==true and (has("error")|not)' <<< "${result}" > /dev/null || fail 'faulted membership allowed tool success'
    control_ts="$(scenario_ts)"; control_text="$(scenario_text "q-during-${action}-fault")"
    ack "$(push q "${A}" "${control_ts}" "${control_text}")"
    accepted q "${A}" "${control_ts}" receive_all_shared "${control_text}"
    receipt q
    chmod 700 "${SLACK_STATE_DIR}"
    ack "$(slack_stub_redeliver "${LABEL[p]}" "${first}")"
    if [[ "${action}" == join ]]; then
        wait_until 30 'repaired live join missing' choice_is p "${JOIN}" mentions
        wait_membership_complete "${KEY[p]}"
        ack "$(slack_stub_redeliver "${LABEL[p]}" "${held}")"
        accepted p "${JOIN}" "${held_ts}" mention "${held_text}"
        receipt p
    else
        wait_until 30 'repaired leave did not remove entry' choice_is p "${JOIN}" ''
    fi
    durable="$(same_channel_facts p "${JOIN}")"
    connected="$(count_log "$(session_connected "$(persona_ref "${NAME[p]}")")")"
    crash
    start
    wait_for_count "$(session_connected "$(persona_ref "${NAME[p]}")")" "$((connected + 1))" "${START_WAIT_S}" 'restarted worker did not reconnect'
    ack "$(slack_stub_redeliver "${LABEL[p]}" "${first}")"
    facts_now="$(same_channel_facts p "${JOIN}")" || fail 'persona facts reader failed'
    [[ "${facts_now}" == "${durable}" ]] || fail 'durable membership replay applied twice'
    # The pending request is refreshed separately; membership did not consume
    # it or overwrite the newer bot choice.
    choice_is p "${B}" thread_hybrid || fail 'pending edit silently applied'
done
configuration_request pending-refresh refresh > /dev/null
cp "${CONFIG}.pending" "${EVIDENCE}/refreshed-intent.pending"
# Stale confirmation is checked by its production refusal and unchanged
# applied projection, never inferred from a quiet interval. Later review
# generations (membership changes, restarts, the refresh) durably superseded
# the old review, so production's outcome line refuses that exact copied
# gesture and spends it.
cp "${LAST}" "${EVIDENCE}/before-stale"
superseded_line="$(printed reviewOutcomeLine superseded)"
superseded_count="$(count_log "${superseded_line}")"
cp "${EVIDENCE}/old-intent.pending" "${CONFIG}.apply"
wait_for_count "${superseded_line}" "$((superseded_count + 1))" 30 'old intent confirmation not refused'
[[ ! -e "${CONFIG}.apply" ]] || fail 'refused old intent confirmation was not spent'
configuration_application_preserved "${CONFIG}" "${EVIDENCE}/before-stale" "${LAST}" > /dev/null
# A fresh confirmation applies both retained edits, proving their survival
# independently of the preview's existence after the bot/membership changes.
configuration_request pending-after-stale refresh > /dev/null
cp "${CONFIG}.pending" "${EVIDENCE}/retained-edits-reviewed.pending"
mv "${CONFIG}.pending" "${CONFIG}.apply"
wait_until "${START_WAIT_S}" 'retained edits did not consume a fresh review' bun "${PRINTER}" sharedReviewConsumed \
    "${CONFIG}" "${LAST}" "${EVIDENCE}/retained-edits-reviewed.pending" > /dev/null
choice_is p "${A}" mentions || fail 'unrelated pending edit was lost'
choice_is p "${B}" off || fail 'same-channel pending edit was lost'
set_choice p "${A}" all after-pending-all
set_choice p "${B}" thread_hybrid after-pending-hybrid
review future-preference "${NAME[p]}/${JOIN}/all"
future="$(same_channel_facts p "${JOIN}")"
ack "$(slack_stub_redeliver "${LABEL[p]}" "${first}")"
facts_now="$(same_channel_facts p "${JOIN}")" || fail 'persona facts reader failed'
[[ "${facts_now}" == "${future}" ]] || fail 'old leave removed fresh future preference'

# Phase 5: caller-retained attempts across deliberately lost answers, MCP
# reconnect and server death. Historical answers never reapply over a newer
# operator choice, and unknown/foreign identifiers reveal no saved outcome.
for value in thread_hybrid all; do
    id="$(scenario_attempt_id "lost-${value}")"
    args="$(attempt_args "${id}" "${B}" "${value}")"
    before="$(shared_attempt_applications "${KEY[p]}" "${B}")"
    lost="$(scenario_attempt_call "${WORK[p]}" "${args}" lose)"
    printf '%s\n' "${lost}" > "${EVIDENCE}/lost-${value}.json"
    [[ "$(shared_attempt_applications "${KEY[p]}" "${B}")" == "$((before + 1))" ]] || fail 'lost response lacks one durable application'
    old_session="$(jq -er .session_id <<< "${lost}")"
    retry="$(attempt_args "${id}" "${B}" "${value}" retry)"
    expect_attempt reconnect-history "${WORK[p]}" "${retry}" "${KEY[p]}" "${value}" history
    stub_session_sessions "${WORK[p]}" | jq -se --arg old "${old_session}" \
        'any(.[]; .event=="connected" and .reason=="lost_response" and .session_id!=$old)' > /dev/null \
        || fail 'lost answer did not use a fresh MCP session'
    review "newer-${value}" "${NAME[p]}/${B}/mentions"
    order="$(shared_attempt_order "${KEY[p]}" "${B}")"
    connected="$(count_log "$(session_connected "$(persona_ref "${NAME[p]}")")")"
    connected_q="$(count_log "$(session_connected "$(persona_ref "${NAME[q]}")")")"
    crash
    start
    wait_for_count "$(session_connected "$(persona_ref "${NAME[p]}")")" "$((connected + 1))" "${START_WAIT_S}" 'restarted worker did not reconnect'
    wait_for_count "$(session_connected "$(persona_ref "${NAME[q]}")")" "$((connected_q + 1))" "${START_WAIT_S}" 'restarted q worker did not reconnect'
    expect_attempt restart-history "${WORK[p]}" "${retry}" "${KEY[p]}" mentions history
    order_now="$(shared_attempt_order "${KEY[p]}" "${B}")" || fail 'attempt reader failed'
    [[ "${order_now}" == "${order}" ]] || fail 'historical retry wrote another order position'
    choice_is p "${B}" mentions || fail 'retry overwrote newer operator choice'
    foreign="$(scenario_attempt_call "${WORK[q]}" "${retry}")"
    expected="$(printed channelDeliveryAttemptStatusText "${NAME[q]}" "${KEY[q]}" "${B}" unresolved)"
    # Current-state suffix is allowed; the original persona's history is not.
    [[ "$(jq -r .isError <<< "${foreign}")" == true && "$(jq -r .text <<< "${foreign}")" == "${expected}"* ]] \
        || fail 'foreign attempt disclosed another persona history'
done
before="$(shared_attempt_applications "${KEY[p]}")"
unknown="$(scenario_attempt_call "${WORK[p]}" "$(attempt_args "$(scenario_attempt_id never-issued)" "${B}" all retry)")"
expected="$(printed channelDeliveryAttemptStatusText "${NAME[p]}" "${KEY[p]}" "${B}" unresolved)"
[[ "$(jq -r .isError <<< "${unknown}")" == true && "$(jq -r .text <<< "${unknown}")" == "${expected}"* ]] || fail 'unknown retry not unresolved'
apps_now="$(shared_attempt_applications "${KEY[p]}")" || fail 'attempt reader failed'
[[ "${apps_now}" == "${before}" ]] || fail 'unknown retry wrote choice'

# A membership refusal is durably known not-applied even if its answer is
# lost. Repairing eligibility never turns that retained identifier into a write.
id="$(scenario_attempt_id rejected-before-apply)"
args="$(attempt_args "${id}" "${UNKNOWN}" all)"
scenario_attempt_call "${WORK[p]}" "${args}" lose > "${EVIDENCE}/lost-rejected.json"
slack_stub_inventory_page "${LABEL[p]}" '' '' "${A}" "${B}" "${NOTICE}" "${UNKNOWN}"
ack "$(slack_push_member_joined "${LABEL[p]}" "${UNKNOWN}" "$(scenario_ts)")"
wait_until 30 'unknown channel did not become eligible' choice_is p "${UNKNOWN}" mentions
wait_membership_complete "${KEY[p]}"
expect_attempt retained-rejection "${WORK[p]}" "$(attempt_args "${id}" "${UNKNOWN}" all retry)" "${KEY[p]}" mentions history true
choice_is p "${UNKNOWN}" mentions || fail 'rejected attempt applied after repair'

# Same-session concurrent copies and sequential reconnect copies are separate
# from the real two-transport overlap below.
id="$(scenario_attempt_id simultaneous)"
args="$(attempt_args "${id}" "${B}" thread_hybrid)"
before="$(shared_attempt_applications "${KEY[p]}" "${B}")"
ids="$(scenario_attempt_group "${WORK[p]}" "${args}" "${args}" "$(attempt_args "${id}" "${B}" thread_hybrid retry)")"
while IFS= read -r call; do
    result="$(stub_session_result "${WORK[p]}" "${call}")"
    jq -e '(has("error")|not) and .isError==false' <<< "${result}" > /dev/null || fail 'simultaneous call did not settle applied'
done <<< "${ids}"
[[ "$(shared_attempt_applications "${KEY[p]}" "${B}")" == "$((before + 1))" ]] || fail 'simultaneous calls applied more than once'
group_order="$(shared_attempt_order "${KEY[p]}" "${B}")"
retry="$(attempt_args "${id}" "${B}" thread_hybrid retry)"
lost="$(scenario_attempt_call "${WORK[p]}" "${retry}" lose)"
old_session="$(jq -er .session_id <<< "${lost}")"
ids="$(scenario_attempt_group "${WORK[p]}" "${retry}" "${retry}")"
while IFS= read -r call; do
    result="$(stub_session_result "${WORK[p]}" "${call}")"
    jq -e '.isError==false and (has("error")|not)' <<< "${result}" > /dev/null || fail 'second-session duplicate did not retain historical result'
done <<< "${ids}"
stub_session_sessions "${WORK[p]}" | jq -se --arg old "${old_session}" \
    'any(.[]; .event=="connected" and .reason=="lost_response" and .session_id!=$old)' > /dev/null || fail 'duplicate retry did not use another real session'
order_now="$(shared_attempt_order "${KEY[p]}" "${B}")" || fail 'attempt reader failed'
[[ "${order_now}" == "${group_order}" ]] || fail 'second-session copies acquired another order position'
[[ "$(shared_attempt_applications "${KEY[p]}" "${B}")" == "$((before + 1))" ]] || fail 'second-session copies reapplied'

# Two real transports submit identical payloads through one HTTP barrier.
# registerSession invalidates the former entry (registry.ts); only the current
# session can apply. resolveTransportForRequest and SDK session validation
# refuse the stale transport before tool history. Require the observed HTTP
# refusal, not a simulated probe's status or two authorized registry entries.
overlap_pair() {
    local artifact="$1" retained="$2" effective="$3" history="$4" prior stale current ids old replacement group expected
    prior="$(stub_session_sessions "${WORK[p]}" | jq -cse '[.[]|select(.event=="connected")]|last')"
    old="$(jq -er .session_id <<< "${prior}")"
    stale="$(jq -c '. + {_stub_session:"stale"}' <<< "${retained}")"
    current="$(jq -c '. + {_stub_session:"replacement"}' <<< "${retained}")"
    printf '%s\n%s\n' "${stale}" "${current}" > "${EVIDENCE}/${artifact}-arguments.jsonl"
    ids="$(scenario_attempt_group "${WORK[p]}" "${stale}" "${current}")"
    local calls=()
    mapfile -t calls <<< "${ids}"
    [[ "${#calls[@]}" == 2 && "${calls[0]}" != "${calls[1]}" ]] || fail 'overlap needs two unique requests'
    stale="$(stub_session_result "${WORK[p]}" "${calls[0]}")"
    current="$(stub_session_result "${WORK[p]}" "${calls[1]}")"
    printf '%s\n%s\n' "${stale}" "${current}" > "${EVIDENCE}/${artifact}-results.jsonl"
    group="$(jq -er '.group|select(type=="string" and length>0)' <<< "${current}")"
    replacement="$(jq -er '.session_id|select(type=="string" and length>0)' <<< "${current}")"
    [[ "${old}" != "${replacement}" ]] || fail 'overlap reused the old MCP session'
    expected="$(printed channelDeliveryAttemptResultText "${CONFIG}" "${LAST}" "${KEY[p]}" \
        "$(jq -r .channel <<< "${retained}")" "$(jq -r .delivery <<< "${retained}")" \
        "$(jq -r .attempt_id <<< "${retained}")" "${history}" "${effective}")"
    jq -se --arg stale_id "${calls[0]}" --arg current_id "${calls[1]}" --arg old "${old}" \
        --arg replacement "${replacement}" --arg group "${group}" --arg expected "${expected}" '
      length==2 and .[0].id==$stale_id and .[0].session_id==$old and .[0].session_role=="stale" and
      .[0].group==$group and .[0].isError==true and .[0].text=="" and
      (.[0].error|type=="string" and length>0) and (.[0]|has("status")|not) and
      .[1].id==$current_id and .[1].session_id==$replacement and .[1].session_role=="replacement" and
      .[1].group==$group and .[1].isError==false and (.[1]|has("error")|not) and .[1].text==$expected
    ' "${EVIDENCE}/${artifact}-results.jsonl" > /dev/null || fail 'overlap result/history or request identity differed'
    stub_session_sessions "${WORK[p]}" > "${EVIDENCE}/${artifact}-sessions.jsonl"
    # Observation order proves both SDK submissions reached the common barrier
    # before either fetch; in_flight independently proves client HTTP overlap.
    jq -se --arg stale_id "${calls[0]}" --arg current_id "${calls[1]}" --arg old "${old}" \
        --arg replacement "${replacement}" --arg group "${group}" --argjson pid "$(jq -er .pid <<< "${prior}")" '
      def binding: {id,session_id,session_role,group};
      [{id:$stale_id,session_id:$old,session_role:"stale",group:$group},
       {id:$current_id,session_id:$replacement,session_role:"replacement",group:$group}] as $want |
      . as $all | [.[]|select(.group==$group)] as $rows |
      [$all[]|select(.event=="connected" and .reason=="replacement" and .session_id==$replacement)] as $connected |
      (all($rows[]; .pid==$pid)) and ($connected|length)==1 and $connected[0].pid==$pid and
      ([$all|to_entries[]|select(.value.event=="connected" and .value.session_id==$replacement)|.key]|first) <
        ([$all|to_entries[]|select(.value.event=="request" and .value.group==$group)|.key]|min) and
      ([$rows[]|select(.event=="request")|binding]|sort_by(.id))==($want|sort_by(.id)) and
      ([$rows[]|select(.event=="submission_ready")|binding]|sort_by(.id))==($want|sort_by(.id)) and
      ([$rows[]|select(.event=="http_start")|binding]|sort_by(.id))==($want|sort_by(.id)) and
      ([$rows[]|select(.event=="http_headers")|binding]|sort_by(.id))==($want|sort_by(.id)) and
      ([$rows[]|select(.event=="submission_barrier")]|length)==1 and
      ([$rows[]|select(.event=="submission_barrier")|.requests[]]|sort_by(.id))==($want|sort_by(.id)) and
      ([$rows[]|select(.event=="submission_aborted" or .event=="http_error")]|length)==0 and
      ([$rows|to_entries[]|select(.value.event=="submission_ready")|.key]|max) <
        ([$rows|to_entries[]|select(.value.event=="submission_barrier")|.key]|first) and
      ([$rows|to_entries[]|select(.value.event=="submission_barrier")|.key]|first) <
        ([$rows|to_entries[]|select(.value.event=="http_start")|.key]|min) and
      any($rows[]; .event=="http_start" and (.in_flight|sort)==([$stale_id,$current_id]|sort)) and
      all($rows[]|select(.event=="http_headers");
        if .session_role=="stale" then .http_status>=400 and .http_status<500
        else .http_status>=200 and .http_status<300 end)
    ' "${EVIDENCE}/${artifact}-sessions.jsonl" > /dev/null || fail 'missing real two-session barrier, overlap or HTTP refusal'
}
id="$(scenario_attempt_id two-session-overlap)"
args="$(attempt_args "${id}" "${B}" all)"
before="$(shared_attempt_applications "${KEY[p]}" "${B}")"
overlap_incarnation="$(shared_persona_facts "${KEY[p]}" | jq -er .incarnation)"
shared_attempt_order "${KEY[p]}" "${B}" > "${EVIDENCE}/overlap-before-order.jsonl"
overlap_pair two-session-assignment "${args}" all new
choice_is p "${B}" all || fail 'replacement session did not apply'
shared_attempt_order "${KEY[p]}" "${B}" > "${EVIDENCE}/overlap-applied-order.jsonl"
jq -se --slurpfile prior "${EVIDENCE}/overlap-before-order.jsonl" --arg key "${KEY[p]}" --arg channel "${B}" \
    --arg life "${overlap_incarnation}" '
  length==($prior|length)+1 and .[0:($prior|length)]==$prior and
  .[-1].key==$key and .[-1].channel==$channel and .[-1].delivery=="all" and .[-1].incarnation==$life and
  .[-1].resolvedOrder>.[-1].startedOrder
' "${EVIDENCE}/overlap-applied-order.jsonl" > /dev/null || fail 'overlap did not retain exactly one new application/order'
review newer-than-overlap "${NAME[p]}/${B}/mentions"
retry="$(attempt_args "${id}" "${B}" all retry)"
overlap_pair two-session-retry "${retry}" mentions history
order_now="$(shared_attempt_order "${KEY[p]}" "${B}")" || fail 'attempt reader failed'
[[ "${order_now}" == "$(cat "${EVIDENCE}/overlap-applied-order.jsonl")" ]] \
    || fail 'overlapping retries added an order position'
[[ "$(shared_attempt_applications "${KEY[p]}" "${B}")" == "$((before + 1))" ]] || fail 'overlapping retries reapplied'
choice_is p "${B}" mentions || fail 'overlapping retry overwrote the newer operator choice'
connected="$(count_log "$(session_connected "$(persona_ref "${NAME[p]}")")")"
crash
start
wait_for_count "$(session_connected "$(persona_ref "${NAME[p]}")")" "$((connected + 1))" "${START_WAIT_S}" 'restarted worker did not reconnect'
expect_attempt two-session-restart-history "${WORK[p]}" "${retry}" "${KEY[p]}" mentions history
order_now="$(shared_attempt_order "${KEY[p]}" "${B}")" || fail 'attempt reader failed'
[[ "${order_now}" == "$(cat "${EVIDENCE}/overlap-applied-order.jsonl")" ]] \
    || fail 'overlap history changed across process restart'
set_choice p "${B}" thread_hybrid after-overlap-hybrid
# The synchronous admission turn's pending-only observation is the existing
# set-channel-delivery.test.ts case "session authority is rechecked after
# pending binding and before assignment; duplicate observes pending only".

# Phase 6: catch-up consumes short and empty cursor pages, with no is_member
# fields. Private/invisible channels are facts of the bot's own inventory.
connected="$(count_log "$(session_connected "$(persona_ref "${NAME[p]}")")")"
stop_server
slack_stub_inventory_clear "${LABEL[p]}"
slack_stub_inventory_page "${LABEL[p]}" '' second "${A}/public/local/omit"
slack_stub_inventory_page "${LABEL[p]}" second third
slack_stub_inventory_page "${LABEL[p]}" third fourth "${PRIVATE}/private/local/omit"
slack_stub_inventory_page "${LABEL[p]}" fourth '' "${INVISIBLE}/private/local/omit" "${EXTERNAL}/public/external/omit" "${B}" "${NOTICE}" "${UNKNOWN}"
mark="$(slack_post_mark)"
start
for cursor in '' second third fourth; do
    slack_stub_records api "label=${LABEL[p]}" method=users.conversations "cursor=${cursor}" | \
        jq -se --argjson mark "${mark}" 'any(.[]; .seq>$mark and .answer=="ok")' > /dev/null || fail 'inventory omitted cursor page'
done
for channel in "${PRIVATE}" "${INVISIBLE}" "${EXTERNAL}"; do
    choice_is p "${channel}" mentions || fail 'catch-up omitted or duplicated membership default'
done
choice_is p "${B}" thread_hybrid || fail 'catch-up overwrote explicit choice'
choice_is p "${JOIN}" all || fail 'absence removed future preference'
wait_for_count "$(session_connected "$(persona_ref "${NAME[p]}")")" "$((connected + 1))" "${START_WAIT_S}" 'restarted worker did not reconnect'
external="$(scenario_attempt_call "${WORK[p]}" "$(attempt_args "$(scenario_attempt_id external)" "${EXTERNAL}" all)")"
jq -e '.isError==true and (has("error")|not)' <<< "${external}" > /dev/null || fail 'external membership authorized open write'
choice_is p "${EXTERNAL}" mentions || fail 'external refusal changed choice'

# Phase 7: incomplete scans never establish absence. All fault observations
# are scoped to a new record sequence so an earlier fired control cannot pass.
record_after() {
    local mark="$1" event="$2"; shift 2
    slack_stub_records "${event}" "$@" | jq -sc --argjson mark "${mark}" '[.[]|select(.seq>$mark)]'
}
has_record_after() { [[ "$(record_after "$@" | jq length)" -gt 0 ]]; }
memberships() {
    slack_stub_inventory_clear "${LABEL[p]}"
    slack_stub_inventory_page "${LABEL[p]}" '' later "${A}"
    slack_stub_inventory_page "${LABEL[p]}" later '' "${B}" "${NOTICE}" "${UNKNOWN}" "${PRIVATE}/private" "${INVISIBLE}/private" "${EXTERNAL}/public/external"
}
membership_request_ms="$(printed MEMBERSHIP_REQUEST_TIMEOUT_MS)"
membership_attempt_ms="$(printed MEMBERSHIP_ATTEMPT_TIMEOUT_MS)"
membership_retry_ms="$(printed MEMBERSHIP_RETRY_MAX_MS)"
recovery_bound_s="$(( (membership_attempt_ms + membership_retry_ms + 999) / 1000 + 30 ))"
incomplete="$(printed MEMBERSHIP_INVENTORY_INCOMPLETE)"
# A credentials refusal revokes p's whole connection, so its held push is
# either refused (no open socket, or the send failed, with its push-refused
# record after <mark>) or sent and never acknowledged. Both are accepted, as
# in sr8-evidence's denied case. A refused push is neither ACKed nor withheld.
held_push() {
    local ts="$1" text="$2" mark="$3" err="${SCENARIO_ROOT}/held-push.err" reason
    if held="$(push p "${B}" "${ts}" "${text}" 2> "${err}")"; then
        HELD_REFUSED=false
        no_ack "${held}"
        return 0
    fi
    reason="$(record_after "${mark}" push-refused "label=${LABEL[p]}" | jq -r 'if length==1 then .[0].reason else "records=\(length)" end')" \
        || fail 'push-refused reader failed'
    case "${reason}" in
        no-open-socket|send-failed) HELD_REFUSED=true; held='' ;;
        *) sed 's/^/  | /' "${err}" >&2; fail "authorization held push was neither sent nor refused for the revoked connection (${reason})" ;;
    esac
}
# Phase 7 observation, printed only when a page case fails. Diagnostic only:
# p's lifecycle line counts and timestamps since the case's log mark, and the
# stub's socket and refusal records since its record mark, never message
# text, tickets or tokens.
PHASE7_CASE='' PHASE7_MARK=0 PHASE7_LOG_MARK=0
phase7_observe() {
    local ref key slice label a b line stamps count event
    [[ -n "${PHASE7_CASE}" ]] || return 0
    ref="$(persona_ref "${NAME[p]}")" && key="${KEY[p]}" || return 0
    printf 'phase7-observe: case=%s failed\n' "${PHASE7_CASE}"
    slice="${SCENARIO_ROOT}/phase7-observe.log"
    tail -c "+$((PHASE7_LOG_MARK + 1))" "${SLACK_STATE_DIR}/server.log" > "${slice}" 2> /dev/null || : > "${slice}"
    while IFS='|' read -r label a b; do
        stamps='' count=0
        while IFS= read -r line; do
            [[ "${line}" == *"${b}"* ]] || continue
            count=$((count + 1))
            if [[ "${line}" =~ ^\[([0-9T:.Z+-]{10,40})\] ]]; then stamps+="${stamps:+,}${BASH_REMATCH[1]}"; fi
        done < <(grep -F -- "${a}" "${slice}" 2> /dev/null)
        printf 'phase7-observe: lifecycle=%s count=%s at=%s\n' "${label}" "${count}" "${stamps:-none}"
    done <<EOF
credentials-refused|[slack] persona-credentials-refused: personas[|${ref}
connection-lost|[slack] persona-connection-lost: personas[|${ref}
connection-restored|[slack] persona-connection-restored: personas[|${ref}
connected|[slack] Session connected: persona ${ref}|
disconnected|[slack] Session disconnected|persona ${ref}
dropped|[slack] persona ${ref}: MCP session dropped|
inventory-incomplete|[slack] ${incomplete} persona=${key}:|
inventory-complete|[slack] channel-membership-inventory-complete persona=${key}:|
EOF
    for event in ws-open ws-close push-refused; do
        jq -r -R --argjson mark "${PHASE7_MARK}" --arg e "${event}" --arg l "${LABEL[p]}" '
            def safe: if . == null then "absent" else tostring | if test("^[A-Za-z0-9_.:+-]{1,64}$") and (test("^xox") | not) then . else "invalid" end end;
            fromjson? | select(type == "object" and .seq > $mark and .event == $e and .label == $l) |
            "phase7-observe: stub \(.event) seq=\(.seq|safe) ts=\(.ts|safe) code=\(.code|safe) reason=\(.reason|safe) hello=\(.hello|safe)"' \
            "${SCENARIO_SLACK_RECORD}" 2> /dev/null || printf 'phase7-observe: stub %s=unreadable\n' "${event}"
    done
}
on_failure phase7_observe
for page in first later; do
    for problem in transient rate scope authorization hang; do
        PHASE7_CASE="${page}-${problem}"
        memberships
        slack_stub_faults_clear "${LABEL[p]}"
        cursor=''; [[ "${page}" == later ]] && cursor=later
        case "${problem}" in
            transient) outcome=error; extra=(error=internal_error) ;;
            rate) outcome=rate_limit; extra=(retry_after=7) ;;
            scope) outcome=error; extra=(error=missing_scope) ;;
            authorization) outcome=error; extra=(error=invalid_auth) ;;
            hang) outcome=hang; extra=() ;;
        esac
        slack_stub_inventory_fault "${LABEL[p]}" "${cursor}" "${outcome}" times=100000 "${extra[@]}"
        before="$(same_channel_facts p "${B}")"
        mark="$(slack_post_mark)"; count="$(count_log "${incomplete}")"
        PHASE7_MARK="${mark}" PHASE7_LOG_MARK="$(wc -c < "${SLACK_STATE_DIR}/server.log")"
        [[ "${problem}" != authorization ]] || session_barrier_mark --position "${NAME[p]}"
        slack_stub_close_socket "${LABEL[p]}"
        wait_until 30 'socket close did not fire' has_record_after "${mark}" socket-close "label=${LABEL[p]}"
        wait_until 60 'page fault did not fire' has_record_after "${mark}" fault "label=${LABEL[p]}" method=users.conversations "outcome=${outcome}"
        wait_for_count "${incomplete}" "$((count + 1))" "$((membership_request_ms / 1000 + 30))" 'scan did not become incomplete at its deadline'
        facts_now="$(same_channel_facts p "${B}")" || fail 'persona facts reader failed'
        [[ "${facts_now}" == "${before}" ]] || fail 'incomplete scan removed omitted channel'
        held_ts="$(scenario_ts)"; held_text="$(scenario_mention_text "$(slack_stub_identity "${LABEL[p]}" user_id)" "$(scenario_text "${page}-${problem}-held")")"
        if [[ "${problem}" == authorization ]]; then
            held_push "${held_ts}" "${held_text}" "${mark}"
        else
            held="$(push p "${B}" "${held_ts}" "${held_text}")"
            no_ack "${held}"
        fi
        # Only the hung later-page case promises that positive A remains
        # eligible. A credentials refusal can revoke the whole connection.
        if [[ "${page}" == later && "${problem}" == hang ]]; then
            control_ts="$(scenario_ts)"; control_text="$(scenario_text "positive-A-${problem}")"
            ack "$(push p "${A}" "${control_ts}" "${control_text}")"
            accepted p "${A}" "${control_ts}" receive_all_shared "${control_text}"
            receipt p
            set_choice p "${A}" all "positive-page-write-${problem}"
        fi
        # Observe a second real attempt before repair. Timestamp precision is
        # the stub's millisecond ISO wall clock; exact clocks live in unit tests.
        two_faults() { [[ "$(record_after "${mark}" fault "label=${LABEL[p]}" method=users.conversations "outcome=${outcome}" | jq length)" -ge 2 ]]; }
        wait_until "${recovery_bound_s}" 'no bounded membership retry' two_faults
        min_ms="$(printed MEMBERSHIP_RETRY_MIN_MS)"
        [[ "${problem}" != rate ]] || min_ms="$(printed membershipRetryDelay 0 7)"
        record_after "${mark}" fault "label=${LABEL[p]}" method=users.conversations "outcome=${outcome}" > "${EVIDENCE}/page-${page}-${problem}.json"
        python3 - "${EVIDENCE}/page-${page}-${problem}.json" "${min_ms}" <<'PY'
import datetime,json,sys
rows=json.load(open(sys.argv[1]))
times=[datetime.datetime.fromisoformat(row['ts'].replace('Z','+00:00')).timestamp()*1000 for row in rows]
if len(times)<2 or any(b-a+2 < int(sys.argv[2]) for a,b in zip(times,times[1:])):
    sys.exit('retry started before minimum spacing/Retry-After')
PY
        # No message or tool triggers recovery after clearing the fault.
        repaired_at="${SECONDS}"
        slack_stub_faults_clear "${LABEL[p]}"
        wait_until "${recovery_bound_s}" 'idle reconciliation exceeded published recovery bound' \
            _scenario_membership_complete "${KEY[p]}" "$(printed MEMBERSHIP_READINESS_ROUTE)"
        (( SECONDS - repaired_at <= recovery_bound_s )) || fail 'idle recovery late'
        if [[ "${problem}" == authorization && "${HELD_REFUSED}" == true ]]; then
            # The refused push never reached CSCB: send a fresh copy.
            held_ts="$(scenario_ts)"
            ack "$(push p "${B}" "${held_ts}" "${held_text}")"
        else
            ack "$(slack_stub_redeliver "${LABEL[p]}" "${held}")"
        fi
        accepted p "${B}" "${held_ts}" mention "${held_text}"
        receipt p
        facts_now="$(same_channel_facts p "${B}")" || fail 'persona facts reader failed'
        [[ "${facts_now}" == "${before}" ]] || fail 'repaired scan changed chosen value/stamp'
        # The refusal dropped p's MCP session: no tool call before it returns.
        [[ "${problem}" != authorization ]] \
            || session_barrier_wait "${START_WAIT_S}" 'authorization recovery: p did not open a new MCP session'
    done
done
PHASE7_CASE=''

# Phase 8: a real connection gap misses A's leave and a new channel's join.
# A delayed first page revokes previous eligibility. Late empty response is
# superseded by the next successful scan and cannot undo its positive facts.
GAP="$(scenario_id C gap-join)"
slack_stub_inventory_clear "${LABEL[p]}"
slack_stub_inventory_page "${LABEL[p]}" '' '' "${B}" "${NOTICE}" "${GAP}"
slack_stub_inventory_fault "${LABEL[p]}" '' delay "delay_ms=$((membership_request_ms + 20000))" \
    "body=$(slack_stub_inventory_body '')"
mark="$(slack_post_mark)"
slack_stub_close_socket "${LABEL[p]}"
wait_until 60 'gap scan did not delay' has_record_after "${mark}" fault "label=${LABEL[p]}" method=users.conversations outcome=delay
request_id="$(record_after "${mark}" fault "label=${LABEL[p]}" method=users.conversations outcome=delay | jq -er 'last.request_id')"
gap_ts="$(scenario_ts)"; gap_text="$(scenario_text unresolved-gap)"
gap_env="$(push p "${A}" "${gap_ts}" "${gap_text}")"
no_ack "${gap_env}"
result="$(scenario_attempt_call "${WORK[p]}" "$(attempt_args "$(scenario_attempt_id gap-write)" "${A}" all)")"
jq -e '.isError==true' <<< "${result}" > /dev/null || fail 'gap reused old membership for write'
wait_until "${recovery_bound_s}" 'gap reconciliation did not complete' _scenario_membership_complete "${KEY[p]}" "$(printed MEMBERSHIP_READINESS_ROUTE)"
choice_is p "${A}" '' || fail 'missed leave not reconciled'
choice_is p "${GAP}" mentions || fail 'missed join not reconciled'
gap_facts="$(same_channel_facts p "${GAP}")"
wait_until "$((membership_request_ms / 1000 + 40))" 'old inventory request never settled/aborted' \
    has_record_after "${mark}" fault-settled "request_id=${request_id}"
facts_now="$(same_channel_facts p "${GAP}")" || fail 'persona facts reader failed'
[[ "${facts_now}" == "${gap_facts}" ]] || fail 'late contradictory page changed new membership'
ack "$(slack_stub_redeliver "${LABEL[p]}" "${gap_env}")"
queued_n="$(shared_queued_count "${KEY[p]}" "${A}" "${gap_ts}")" || fail 'queue reader failed'
[[ "${queued_n}" == 0 ]] || fail 'old work admitted after proved absence'
slack_stub_faults_clear "${LABEL[p]}"
memberships
ack "$(slack_push_member_joined "${LABEL[p]}" "${A}" "$(scenario_ts)")"
wait_membership_complete "${KEY[p]}"
set_choice p "${A}" all restore-all

# Phase 9: Thread Memory append failure keeps accepted work flowing and
# retries the join without a second Slack post or incoming queue acceptance.
set_choice p "${B}" thread_hybrid memory-outage-hybrid
memory_path="${SLACK_STATE_DIR}/threads/${KEY[p]}.jsonl"
memory_mark="$(slack_post_mark)"
file_fault "${memory_path}" >> "${EVIDENCE}/faults"
not_saved="$(printed THREAD_MEMORY_NOT_SAVED)"
before="$(count_log "$(matcher "${not_saved}" "${KEY[p]}")")"
root="$(scenario_ts)"
text="$(scenario_mention_text "$(slack_stub_identity "${LABEL[p]}" user_id)" "$(scenario_text unsaved-join)")"
ack "$(push p "${B}" "${root}" "${text}")"
accepted p "${B}" "${root}" mention "${text}"
receipt p


wait_for_count "$(matcher "${not_saved}" "${KEY[p]}")" "$((before + 1))" 30 'missing Thread Memory not saved report'
report_post p "${memory_mark}" memory-not-saved-notice buildThreadMemoryNotSavedNotice \
    "$(persona_ref "${NAME[p]}")" "${B}" "${memory_path}" journal-append CONTROLLED_ERROR
for who in p q; do
    ts="$(scenario_ts)"; text="$(scenario_text "${who}-during-memory-outage")"
    ack "$(push "${who}" "${A}" "${ts}" "${text}")"
    accepted "${who}" "${A}" "${ts}" receive_all_shared "${text}"
    receipt "${who}"
done
ts="$(scenario_ts)"; text="$(scenario_text kept-in-memory-reply)"
ack "$(push p "${B}" "${ts}" "${text}" "${root}")"
accepted p "${B}" "${ts}" thread "${text}" "${root}"
receipt p
expect_count "$(matcher "${not_saved}" "${KEY[p]}")" "$((before + 1))" 'outage reported repeatedly'
chmod 600 "${memory_path}"
thread_retry_ms="$(printed THREAD_MEMORY_RETRY_MAX_MS)"
wait_until "$((thread_retry_ms / 1000 + 30))" 'kept join was not retried' root_saved p "${B}" "${root}"
recovered="$(printed buildThreadMemoryRecoveredLine "${KEY[p]}" "${B}")"
wait_for_log "${recovered}" 30 'Thread Memory recovery missing'
report_post p "${memory_mark}" memory-saved-notice buildThreadMemoryRecoveredNotice "$(persona_ref "${NAME[p]}")" "${B}"

# Phase 10: unreadable Thread Memory stores dependent replies as Memory
# Holds. Both their admission and final receipt are real queue evidence.
stop_server
chmod 000 "${memory_path}"
python3 - "${memory_path}" <<'PY'
import os,sys
try:
    fd=os.open(sys.argv[1],os.O_RDONLY)
except PermissionError:
    print('probe-read-refused')
else:
    os.close(fd)
    sys.exit('fault ineffective: scenario user can read Thread Memory')
PY
unreadable="$(printed THREAD_MEMORY_UNREADABLE)"
before="$(count_log "$(matcher "${unreadable}" "${KEY[p]}")")"
post_mark="$(slack_post_mark)"
start
wait_for_count "$(matcher "${unreadable}" "${KEY[p]}")" "$((before + 1))" 30 'unreadable report missing'
notice="$(printed buildThreadMemoryUnreadableNotice "$(persona_ref "${NAME[p]}")" "${B}" "${memory_path}")"
report_post p "${post_mark}" memory-unreadable-notice buildThreadMemoryUnreadableNotice "$(persona_ref "${NAME[p]}")" "${B}" "${memory_path}"
held_ts="$(scenario_ts)"; held_text="$(scenario_text memory-held-reply)"
ack "$(push p "${B}" "${held_ts}" "${held_text}" "${root}")"
accepted p "${B}" "${held_ts}" thread "${held_text}" "${root}"
shared_queue_items "${KEY[p]}" | jq -se --arg ts "${held_ts}" --arg root "${root}" \
    'any(.[]; .ts==$ts and .via=="thread" and .hold.on=="memory" and .hold.thread_ts==$root)' > /dev/null \
    || fail 'unreadable reply lacks durable Memory Hold'
for route in mention broadcast dm other-channel other-persona; do
    ts="$(scenario_ts)"; who=p; channel="${B}"; parent=-
    case "${route}" in
        mention) via=mention; text="$(scenario_mention_text "$(slack_stub_identity "${LABEL[p]}" user_id)" "$(scenario_text memory-independent-mention)")" ;;
        broadcast) via=broadcast; text="$(scenario_broadcast_text here "$(scenario_text memory-independent-broadcast)")" ;;
        dm) via=dm; channel="${DM}"; text="$(scenario_text memory-independent-dm)" ;;
        other-channel) channel="${A}"; via=receive_all_shared; text="$(scenario_text memory-independent-channel)" ;;
        other-persona) who=q; channel="${A}"; via=receive_all_shared; text="$(scenario_text memory-independent-persona)" ;;
    esac
    if [[ "${route}" == dm ]]; then envelope="$(slack_push_dm "${LABEL[p]}" "${channel}" "${text}" "${ts}")"
    else envelope="$(push "${who}" "${channel}" "${ts}" "${text}")"; fi
    ack "${envelope}"
    accepted "${who}" "${channel}" "${ts}" "${via}" "${text}"
    # The pending Memory Hold is not open work and cannot block these inputs.
    wait_until 90 'independent input did not finish while Thread Memory remained unreadable' delivered_original "${who}" "${ts}"
done
expect_count "$(matcher "${unreadable}" "${KEY[p]}")" "$((before + 1))" 'unreadable episode reported twice'
chmod 600 "${memory_path}"
for who in p q; do drain "${who}"; done
root_saved p "${B}" "${root}" || fail 'read repair lost the original joined thread'
report_post p "${post_mark}" memory-readable-notice buildThreadMemoryRecoveredNotice "$(persona_ref "${NAME[p]}")" "${B}"

# Known c9 limit: a byte-identical copy restore changes inode identity and
# reports possible loss. It must still use the actual restored membership.
stop_server
cp "${memory_path}" "${EVIDENCE}/memory-before-copy"
cp "${SLACK_STATE_DIR}/queue/${KEY[p]}.jsonl" "${EVIDENCE}/queue-before-copy"
cp "${EVIDENCE}/memory-before-copy" "${memory_path}.restored"
mv "${memory_path}.restored" "${memory_path}"
cp "${EVIDENCE}/queue-before-copy" "${SLACK_STATE_DIR}/queue/${KEY[p]}.jsonl.restored"
mv "${SLACK_STATE_DIR}/queue/${KEY[p]}.jsonl.restored" "${SLACK_STATE_DIR}/queue/${KEY[p]}.jsonl"
changed="$(printed THREAD_MEMORY_CHANGED_WHILE_STOPPED)"
before="$(count_log "$(matcher "${changed}" "${KEY[p]}")")"
copy_mark="$(slack_post_mark)"
session_barrier_mark "${NAME[p]}" "${NAME[q]}"
start
wait_for_count "$(matcher "${changed}" "${KEY[p]}")" "$((before + 1))" 30 'copy-restore limit was not reported'
report_post p "${copy_mark}" memory-copy-restored-notice buildThreadMemoryChangedWhileStoppedNotice "$(persona_ref "${NAME[p]}")" "${B}" changed
ts="$(scenario_ts)"; text="$(scenario_text restored-thread-reply)"
ack "$(push p "${B}" "${ts}" "${text}" "${root}")"
accepted p "${B}" "${ts}" thread "${text}" "${root}"
receipt p
session_barrier_wait "${START_WAIT_S}" 'copy-restore restart: no new MCP session'

# Phase 11: stopped, then left. Accepted all/hybrid work survives unresolved
# startup membership; delayed new input receives no ACK until absence is
# proved. The old accepted items retain their original reason and content.
for startup_fault in delay partial failed; do
    drain p
    shared_stub_notice end "${WORK[p]}" "${KEY[p]}" "${EVIDENCE}/stopped-${startup_fault}.json" > /dev/null
    saved_stamp="$(stamp p "${B}")"
    all_ts="$(scenario_ts)"; all_text="$(scenario_text "old-all-${startup_fault}")"
    thread_ts="$(scenario_ts)"; thread_text="$(scenario_text "old-thread-${startup_fault}")"
    # A fresh joining mention is independent of any preceding phase's root.
    old_root="$(scenario_ts)"; root_text="$(scenario_mention_text "$(slack_stub_identity "${LABEL[p]}" user_id)" "$(scenario_text "old-root-${startup_fault}")")"
    ack "$(push p "${A}" "${all_ts}" "${all_text}")"
    accepted p "${A}" "${all_ts}" receive_all_shared "${all_text}"
    ack "$(push p "${B}" "${old_root}" "${root_text}")"
    accepted p "${B}" "${old_root}" mention "${root_text}"
    wait_until 30 'old queued root not saved' root_saved p "${B}" "${old_root}"
    ack "$(push p "${B}" "${thread_ts}" "${thread_text}" "${old_root}")"
    accepted p "${B}" "${thread_ts}" thread "${thread_text}" "${old_root}"
    snapshot p
    cp "${SNAP[p]}" "${EVIDENCE}/stopped-${startup_fault}-before.jsonl"
    connected="$(count_log "$(session_connected "$(persona_ref "${NAME[p]}")")")"
    connected_q="$(count_log "$(session_connected "$(persona_ref "${NAME[q]}")")")"
    stop_server
    slack_stub_inventory_clear "${LABEL[p]}"
    slack_stub_faults_clear "${LABEL[p]}"
    case "${startup_fault}" in
        delay)
            slack_stub_inventory_page "${LABEL[p]}" '' ''
            slack_stub_inventory_fault "${LABEL[p]}" '' delay "delay_ms=$((membership_request_ms + 20000))" times=100000
            ;;
        partial)
            slack_stub_inventory_page "${LABEL[p]}" '' waiting "${NOTICE}"
            slack_stub_inventory_page "${LABEL[p]}" waiting ''
            slack_stub_inventory_fault "${LABEL[p]}" waiting hang times=100000
            ;;
        failed)
            slack_stub_inventory_page "${LABEL[p]}" '' ''
            slack_stub_inventory_fault "${LABEL[p]}" '' error error=missing_scope times=100000
            ;;
    esac
    mark="$(slack_post_mark)"
    start_server --live
    wait_membership_complete "${KEY[q]}"
    wait_until 60 'startup fault not reached' has_record_after "${mark}" fault "label=${LABEL[p]}" method=users.conversations
    choice_is p "${A}" all || fail 'incomplete startup removed all choice'
    stamp_now="$(stamp p "${B}")" || fail 'stamp reader failed'
    [[ "${stamp_now}" == "${saved_stamp}" ]] || fail 'incomplete startup forgot joins'
    new_ts="$(scenario_ts)"; new_text="$(scenario_text "new-while-absent-${startup_fault}")"
    unresolved="$(push p "${A}" "${new_ts}" "${new_text}")"
    no_ack "${unresolved}"
    wait_for_count "$(session_connected "$(persona_ref "${NAME[q]}")")" "$((connected_q + 1))" "${START_WAIT_S}" 'restarted q worker did not reconnect'
    result="$(scenario_attempt_call "${WORK[q]}" "$(attempt_args "$(scenario_attempt_id "q-progress-${startup_fault}")" "${A}" all)")"
    jq -e '.isError==false' <<< "${result}" > /dev/null || fail 'unrelated persona tool blocked by startup scan'
    shared_stub_notice resume "${WORK[p]}" "${KEY[p]}" "${EVIDENCE}/stopped-${startup_fault}.json" > /dev/null
    drain p
    wait_for_count "$(session_connected "$(persona_ref "${NAME[p]}")")" "$((connected + 1))" "${START_WAIT_S}" 'resumed worker did not reconnect'
    result="$(scenario_attempt_call "${WORK[p]}" "$(attempt_args "$(scenario_attempt_id "absent-${startup_fault}")" "${A}" all)")"
    jq -e '.isError==true and (has("error")|not)' <<< "${result}" > /dev/null || fail 'delayed startup membership authorized new write'
    queued_n="$(shared_queued_count "${KEY[p]}" "${A}" "${new_ts}")" || fail 'queue reader failed'
    [[ "${queued_n}" == 0 ]] || fail 'unresolved message accepted'
    slack_stub_faults_clear "${LABEL[p]}"
    slack_stub_inventory_clear "${LABEL[p]}"
    slack_stub_inventory_page "${LABEL[p]}" '' ''
    wait_until "${recovery_bound_s}" 'successful empty inventory did not complete' _scenario_membership_complete "${KEY[p]}" "$(printed MEMBERSHIP_READINESS_ROUTE)"
    choice_is p "${A}" '' || fail 'complete absence retained all entry'
    choice_is p "${B}" '' || fail 'complete absence retained hybrid entry'
    since_now="$(shared_thread_since "${KEY[p]}" "${B}")" || fail 'persona facts reader failed'
    [[ -z "${since_now}" ]] || fail 'complete absence retained joined-thread stamp'
    ack "$(slack_stub_redeliver "${LABEL[p]}" "${unresolved}")"
    queued_n="$(shared_queued_count "${KEY[p]}" "${A}" "${new_ts}")" || fail 'queue reader failed'
    [[ "${queued_n}" == 0 ]] || fail 'absence replay admitted old message'
    memberships
    for channel in "${A}" "${B}"; do ack "$(slack_push_member_joined "${LABEL[p]}" "${channel}" "$(scenario_ts)")"; done
    wait_membership_complete "${KEY[p]}"
    set_choice p "${A}" all "restored-all-${startup_fault}"
    set_choice p "${B}" thread_hybrid "restored-hybrid-${startup_fault}"
    stamp_now="$(stamp p "${B}")" || fail 'stamp reader failed'
    joins_now="$(current_joins p "${B}")" || fail 'Thread Memory reader failed'
    [[ "${stamp_now}" != "${saved_stamp}" && -z "${joins_now}" ]] || fail 'rejoin resurrected old Joined Threads'
done

# Phase 12: lost Slack answers and durable own-post recovery. Each operation
# has a new channel, preventing earlier posts from becoming lookup candidates.
# The API fault proves the injection; only the exact observer proves the
# durable unresolved intent. The held HTTP answer and hung history controls
# keep resolution blocked until the verified kill.
lookup_deadline_ms="$(printed THREAD_MEMORY_LOOKUP_DEADLINE_MS)"
lookup_min_ms="$(printed THREAD_MEMORY_RETRY_MIN_MS)"
lookup_max_ms="$(printed THREAD_MEMORY_RETRY_MAX_MS)"
lookup_bound_s="$(( (lookup_deadline_ms + lookup_max_ms + 999) / 1000 + 30 ))"
declare -a EXTRA_CHANNELS=()
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
for performed in true false; do
    pending_post "recovered-${performed}" "${performed}"
    post_hold "recovered-${performed}"
    connected="$(count_log "$(session_connected "$(persona_ref "${NAME[p]}")")")"
    crash
    start
    wait_for_count "$(session_connected "$(persona_ref "${NAME[p]}")")" "$((connected + 1))" "${START_WAIT_S}" 'restarted worker did not reconnect'
    wait_until 30 'restart did not attempt the saved own-post lookup' has_record_after \
        "${OP_MARK}" fault "label=${LABEL[p]}" method=conversations.history outcome=hang
    # First successful queue load releases the durable Post Hold as recovered
    # work (5o Decision 9), even while its post lookup remains unresolved.
    drain p
    ack "$(slack_stub_redeliver "${LABEL[p]}" "${OP_ENVELOPE}")"
    [[ "$(queued_total p "${OP_CHANNEL}" "${OP_REPLY_TS}" thread)" == 1 ]] || fail 'recovered hold duplicated acceptance'
    slack_stub_faults_clear "${LABEL[p]}"
    outcome=none; [[ "${performed}" == false ]] || outcome=joined
    RECORD_WAIT_S="${lookup_bound_s}" shared_wait_own_post_state "${KEY[p]}" "${OP_ID}" "${OP_CHANNEL}" "${OP_STAMP}" "${outcome}" \
        > "${EVIDENCE}/post-recovered-${performed}-outcome.json"
    if [[ "${performed}" == true ]]; then root_saved p "${OP_CHANNEL}" "${OP_ROOT}" || fail 'found post did not join'
    else
        joins_now="$(current_joins p "${OP_CHANNEL}")" || fail 'Thread Memory reader failed'
        [[ -z "${joins_now}" ]] || fail 'not-posted outcome joined'
    fi
    [[ "$(record_after "${OP_MARK}" fault "label=${LABEL[p]}" method=chat.postMessage outcome=lost | jq length)" == 1 ]] || fail 'lost post was reposted'
    records_n="$(record_after "${OP_MARK}" api "label=${LABEL[p]}" method=chat.postMessage "channel=${OP_CHANNEL}" answer=ok | jq length)" \
        || fail 'stub record reader failed'
    [[ "${records_n}" == 0 ]] || fail 'recovery issued another post'
    ts="$(scenario_ts)"; text="$(scenario_text "after-lookup-${performed}")"
    ack "$(push p "${OP_CHANNEL}" "${ts}" "${text}" "${OP_ROOT}")"
    if [[ "${performed}" == true ]]; then accepted p "${OP_CHANNEL}" "${ts}" thread "${text}" "${OP_ROOT}"; receipt p
    else
        queued_n="$(shared_queued_count "${KEY[p]}" "${OP_CHANNEL}" "${ts}")" || fail 'queue reader failed'
        [[ "${queued_n}" == 0 ]] || fail 'not-posted thread selected reply'
    fi
done

# Phase 13: a live unanswered post cannot hold the reply indefinitely. Use a
# newly configured real manual-receipt worker so every later source, including
# a real minute cron fire, is demonstrably behind this unreceipted head. This
# is a reviewed working-directory boundary, not a fabricated AD/session state.
drain p
fifo_work="${WORK[p]}"
cp "${CONFIG}" "${EVIDENCE}/fifo-original-config.json"
WORK[p]="$(make_workdir fifo-manual)"
shared_stub_permission_setup "${WORK[p]}" > /dev/null
jq --arg work "${WORK[p]}" '.personas[0].working_directory=$work' "${CONFIG}" > "${CONFIG}.tmp"
mv "${CONFIG}.tmp" "${CONFIG}"
connected="$(count_log "$(session_connected "$(persona_ref "${NAME[p]}")")")"
retain "${NAME[p]}"
review fifo-manual-worker "${RETAIN[@]}"
wait_for_count "$(session_connected "$(persona_ref "${NAME[p]}")")" "$((connected + 1))" "${START_WAIT_S}" 'manual FIFO worker did not connect'
wait_membership_complete "${KEY[p]}"
MANUAL[p]=true
pending_post live-hold true
post_hold live-hold
hold_ts="${OP_REPLY_TS}"; hold_channel="${OP_CHANNEL}"
for route in all dm mention broadcast; do
    ts="$(scenario_ts)"; channel="${A}"; parent=-; via=receive_all_shared
    text="$(scenario_text "behind-post-${route}")"
    case "${route}" in
        dm) channel="${DM}"; via=dm ;;
        mention) channel="${OP_CHANNEL}"; parent="${OP_ROOT}"; via=mention; text="$(scenario_mention_text "$(slack_stub_identity "${LABEL[p]}" user_id)" "${text}")" ;;
        broadcast) channel="${OP_CHANNEL}"; parent="${OP_ROOT}"; via=broadcast; text="$(scenario_broadcast_text here "${text}")" ;;
    esac
    if [[ "${route}" == dm ]]; then envelope="$(slack_push_dm "${LABEL[p]}" "${channel}" "${text}" "${ts}")"
    else envelope="$(push p "${channel}" "${ts}" "${text}" "${parent}")"; fi
    ack "${envelope}"
    accepted p "${channel}" "${ts}" "${via}" "${text}" "${parent}"
    shared_queue_items "${KEY[p]}" | jq -se --arg ts "${ts}" 'any(.[]; .ts==$ts and (has("hold")|not))' > /dev/null \
        || fail 'independent input acquired a Post Hold'
done
inject_sender="${SCENARIO_TAG}-fifo-interject"
inject_text="$(scenario_text behind-post-interject)"
jq -cn --arg persona "${NAME[p]}" --arg sender "${inject_sender}" --arg message "${inject_text}" \
    '{persona:$persona,sender:$sender,message:$message}' > "${EVIDENCE}/fifo-interject-input.json"
code="$(curl -sS --max-time 15 -o "${EVIDENCE}/fifo-interject-response.json" -w '%{http_code}' \
    -H 'Content-Type: application/json' --data-binary "@${EVIDENCE}/fifo-interject-input.json" "http://127.0.0.1:${SCENARIO_PORT}/interject")"
[[ "${code}" == 200 ]] || fail 'real interject did not durably accept'
injected p interject "${inject_sender}" "${inject_text}"
cron_prompt="${EVIDENCE}/fifo-cron.prompt"
cron_text="$(scenario_text behind-post-cron)"
printf '%s' "${cron_text}" > "${cron_prompt}"
printf '* * * * * %s %s\n' "${cron_prompt}" "${NAME[p]}" > "${SLACK_STATE_DIR}/crontab"
cp "${SLACK_STATE_DIR}/crontab" "${EVIDENCE}/fifo-crontab"
cron_sender="$(shared_cron_identity "${EVIDENCE}/fifo-crontab" "${cron_prompt}")"
injected p cron "${cron_sender}" "${cron_text}"
: > "${SLACK_STATE_DIR}/crontab"
snapshot p
jq -se --arg ts "${hold_ts}" '
  . as $rows | (map(select(.kind=="accepted" and .ts==$ts))[0].seq) as $head |
  $head!=null and any($rows[]; .kind=="sent" and .seq==$head) and
  ([.[]|select(.kind=="accepted" and (has("compact")|not) and .seq>=$head and (has("reminder_for")|not))]|length)==7 and
  all($rows[]; ((.kind=="sent" or .kind=="delivered") and .seq>$head)|not)
' "${SNAP[p]}" > /dev/null || fail 'later source overtook the unanswered-post head before its receipt'
for receipt_number in 1 2 3 4 5 6 7; do
    shared_stub_permission receipt "${WORK[p]}" "${KEY[p]}" > /dev/null
done
drain p
shared_wait_own_post_state "${KEY[p]}" "${OP_ID}" "${OP_CHANNEL}" "${OP_STAMP}" unresolved \
    > "${EVIDENCE}/post-live-hold-after-receipts.json"
# The successful receipts above precede any Slack answer, independently of
# tu's precise 3-second measurement. Snapshots sort by seq, so array order is
# not execution evidence. Compare each predecessor's last durable receipt time
# with the next original's first send time; the common receipt audit verifies
# those receipts against the actual session transcript.
jq -se --arg ts "${hold_ts}" '
  . as $rows | (map(select(.kind=="accepted" and .ts==$ts))[0].seq) as $head |
  [ .[]|select(.kind=="accepted" and (has("compact")|not) and .seq >= $head and (has("reminder_for")|not))|.seq ] as $seqs |
  ($seqs|length)==7 and all(range(1; $seqs|length); . as $i |
    ([$rows[]|select(.kind=="delivered" and .seq==$seqs[$i-1])|.at]|max) as $done |
    ([$rows[]|select(.kind=="sent" and .seq==$seqs[$i])|.at]|min) as $sent |
    $done!=null and $sent!=null and $done<=$sent)
' "${SNAP[p]}" > /dev/null || fail 'all-source FIFO receipt/send order violated'
connected="$(count_log "$(session_connected "$(persona_ref "${NAME[p]}")")")"
crash
start
wait_for_count "$(session_connected "$(persona_ref "${NAME[p]}")")" "$((connected + 1))" "${START_WAIT_S}" 'restarted manual FIFO worker did not reconnect'
slack_stub_faults_clear "${LABEL[p]}"
# The behind-post mention and broadcast joined the post's own thread
# (SR-3.1), so the lookup leaves that root out of its range and, with no own
# message left in it, records none (SR-3.4.2). The thread stays joined.
RECORD_WAIT_S="${lookup_bound_s}" shared_wait_own_post_state "${KEY[p]}" "${OP_ID}" "${OP_CHANNEL}" "${OP_STAMP}" none \
    > "${EVIDENCE}/post-live-hold-outcome.json"
root_saved p "${OP_CHANNEL}" "${OP_ROOT}" || fail 'live-hold thread lost its mention join'
connected="$(count_log "$(session_connected "$(persona_ref "${NAME[p]}")")")"
cp "${EVIDENCE}/fifo-original-config.json" "${CONFIG}"
retain "${NAME[p]}"
review fifo-original-worker "${RETAIN[@]}"
WORK[p]="${fifo_work}"
MANUAL[p]=false
wait_for_count "$(session_connected "$(persona_ref "${NAME[p]}")")" "$((connected + 1))" "${START_WAIT_S}" 'ordinary FIFO worker did not reconnect'
wait_membership_complete "${KEY[p]}"

# Phase 14: real lookup deadlines, retry spacing and Retry-After. Shutdown
# with a hung lookup must finish within stop_server's bound and start no more
# requests while stopped. A dry run over the same intent performs no lookup.
for problem in hang rate; do
    pending_post "lookup-${problem}" true
    crash
    slack_stub_faults_clear "${LABEL[p]}"
    if [[ "${problem}" == hang ]]; then slack_stub_history_fault "${LABEL[p]}" history hang "channel=${OP_CHANNEL}" times=100000
    else slack_stub_history_fault "${LABEL[p]}" history rate_limit "channel=${OP_CHANNEL}" retry_after=7 times=100000; fi
    mark="$(slack_post_mark)"
    start
    two_lookups() { [[ "$(record_after "${mark}" fault "label=${LABEL[p]}" method=conversations.history | jq length)" -ge 2 ]]; }
    wait_until "$((lookup_bound_s * 2))" 'lookup did not retry after its deadline/failure' two_lookups
    record_after "${mark}" fault "label=${LABEL[p]}" method=conversations.history > "${EVIDENCE}/lookup-${problem}-times.json"
    min_ms="${lookup_min_ms}"
    if [[ "${problem}" == rate && "${min_ms}" -lt 7000 ]]; then min_ms=7000; fi
    python3 - "${EVIDENCE}/lookup-${problem}-times.json" "${min_ms}" <<'PY'
import datetime,json,sys
rows=json.load(open(sys.argv[1]))
times=[datetime.datetime.fromisoformat(row['ts'].replace('Z','+00:00')).timestamp()*1000 for row in rows]
if len(times)<2 or any(b-a+2 < int(sys.argv[2]) for a,b in zip(times,times[1:])):
    sys.exit('lookup retry started before minimum spacing/Retry-After')
PY
    stop_server
    stopped_mark="$(slack_post_mark)"
    sleep "$(( (lookup_max_ms + lookup_deadline_ms + 999) / 1000 + 1 ))"
    records_n="$(record_after "${stopped_mark}" fault "label=${LABEL[p]}" method=conversations.history | jq length)" \
        || fail 'stub record reader failed'
    [[ "${records_n}" == 0 ]] || fail 'shutdown left an obsolete lookup retry'
    start_server
    sleep "$(( (lookup_deadline_ms + 999) / 1000 + 1 ))"
    records_n="$(record_after "${stopped_mark}" api "label=${LABEL[p]}" method=conversations.history | jq length)" \
        || fail 'stub record reader failed'
    [[ "${records_n}" == 0 ]] || fail 'dry run made lookup'
    records_n="$(record_after "${stopped_mark}" fault "label=${LABEL[p]}" method=conversations.history | jq length)" \
        || fail 'stub record reader failed'
    [[ "${records_n}" == 0 ]] || fail 'dry run entered lookup fault'
    connected="$(count_log "$(session_connected "$(persona_ref "${NAME[p]}")")")"
    stop_server
    slack_stub_faults_clear "${LABEL[p]}"
    session_barrier_mark "${NAME[p]}"
    start
    wait_for_count "$(session_connected "$(persona_ref "${NAME[p]}")")" "$((connected + 1))" "${START_WAIT_S}" 'restarted worker did not reconnect'
    session_barrier_wait "${START_WAIT_S}" "lookup-${problem} restart: no new MCP session"
    RECORD_WAIT_S="${lookup_bound_s}" shared_wait_own_post_state "${KEY[p]}" "${OP_ID}" "${OP_CHANNEL}" "${OP_STAMP}" joined \
        > "${EVIDENCE}/lookup-${problem}-outcome.json"
done

# Phase 15: AC-C08, routed leave on either side of durable application. The
# accepted hold is kept unresolved on disk by its independently probed queue
# fault. Before-application kills retain a current, exact unresolved intent;
# after-application kills retain that historical intent alongside the durable
# absence. Its held Slack answer is still controlled; a pending live operation
# need not acquire an outcome until the next start recovers it as unknown.
for boundary in before after; do
    pending_post "leave-${boundary}" true
    post_hold "leave-${boundary}"
    old_channel="${OP_CHANNEL}"; old_stamp="${OP_STAMP}"; old_root="${OP_ROOT}"; old_envelope="${OP_ENVELOPE}"
    file_fault "${SLACK_STATE_DIR}/queue/${KEY[p]}.jsonl" >> "${EVIDENCE}/faults"
    before="$(same_channel_facts p "${old_channel}")"
    remaining=()
    for channel in "${EXTRA_CHANNELS[@]}"; do [[ "${channel}" == "${old_channel}" ]] || remaining+=("${channel}"); done
    # The applied leave forces a rescan, which must not see the old channel.
    if [[ "${boundary}" == before ]]; then directory_fault >> "${EVIDENCE}/faults"
    else slack_stub_inventory_page "${LABEL[p]}" '' '' "${A}" "${B}" "${NOTICE}" "${remaining[@]}"; fi
    leave="$(slack_push_channel_left "${LABEL[p]}" "${old_channel}" "$(scenario_ts)")"
    if [[ "${boundary}" == before ]]; then
        no_ack "${leave}"
        no_ack "$(slack_stub_redeliver "${LABEL[p]}" "${leave}")"
        facts_now="$(same_channel_facts p "${old_channel}")" || fail 'persona facts reader failed'
        [[ "${facts_now}" == "${before}" ]] || fail 'failed leave changed authority'
        shared_wait_own_post_state "${KEY[p]}" "${OP_ID}" "${old_channel}" "${old_stamp}" unresolved \
            > "${EVIDENCE}/leave-before-kill-intent.json"
    else
        ack "${leave}"
        wait_until 30 'durable leave not applied' choice_is p "${old_channel}" ''
        shared_wait_own_post_state "${KEY[p]}" "${OP_ID}" "${old_channel}" "${old_stamp}" unresolved \
            > "${EVIDENCE}/leave-after-kill-historical-intent.json"
    fi
    crash
    repair_modes
    slack_stub_faults_clear "${LABEL[p]}"
    # Complete absence on the first recovery establishes the leave before
    # replay. The subsequent offline rejoin must use the fresh open default.
    slack_stub_inventory_page "${LABEL[p]}" '' '' "${A}" "${B}" "${NOTICE}" "${remaining[@]}"
    start
    choice_is p "${old_channel}" '' || fail 'restart failed to honor leave'
    ack "$(slack_stub_redeliver "${LABEL[p]}" "${leave}")"
    drain p
    connected="$(count_log "$(session_connected "$(persona_ref "${NAME[p]}")")")"
    stop_server
    slack_stub_inventory_page "${LABEL[p]}" '' '' "${A}" "${B}" "${NOTICE}" "${EXTRA_CHANNELS[@]}"
    session_barrier_mark "${NAME[p]}"
    start
    wait_for_count "$(session_connected "$(persona_ref "${NAME[p]}")")" "$((connected + 1))" "${START_WAIT_S}" 'restarted worker did not reconnect'
    session_barrier_wait "${START_WAIT_S}" "leave-${boundary} restart: no new MCP session"
    choice_is p "${old_channel}" mentions || fail 'offline rejoin inherited old choice'
    set_choice p "${old_channel}" thread_hybrid "fresh-after-leave-${boundary}"
    stamp_now="$(stamp p "${old_channel}")" || fail 'stamp reader failed'
    [[ "${stamp_now}" != "${old_stamp}" ]] || fail 'offline rejoin reused old stamp'
    ack "$(slack_stub_redeliver "${LABEL[p]}" "${leave}")"
    choice_is p "${old_channel}" thread_hybrid || fail 'old leave removed newer assignment'
    ack "$(slack_stub_redeliver "${LABEL[p]}" "${old_envelope}")"
    joins_now="$(current_joins p "${old_channel}")" || fail 'Thread Memory reader failed'
    [[ -z "${joins_now}" ]] || fail 'old accepted work revived old join'
    ts="$(scenario_ts)"; text="$(scenario_text "outside-new-stamp-${boundary}")"
    ack "$(push p "${old_channel}" "${ts}" "${text}" "${old_root}")"
    queued_n="$(shared_queued_count "${KEY[p]}" "${old_channel}" "${ts}")" || fail 'queue reader failed'
    [[ "${queued_n}" == 0 ]] || fail 'old lookup/root selected under new stamp'
    root="$(scenario_ts)"; text="$(scenario_mention_text "$(slack_stub_identity "${LABEL[p]}" user_id)" "$(scenario_text "new-join-${boundary}")")"
    ack "$(push p "${old_channel}" "${root}" "${text}")"
    accepted p "${old_channel}" "${root}" mention "${text}"
    receipt p
    wait_until 30 'fresh qualifying join missing' root_saved p "${old_channel}" "${root}"
done

# Phase 16: a stale lookup cannot join after a value transition. Its old
# HTTP request is delayed beyond the real lookup deadline; the fresh stamp
# is established before that request settles or any retry can succeed.
pending_post stale-value true
connected="$(count_log "$(session_connected "$(persona_ref "${NAME[p]}")")")"
crash
slack_stub_faults_clear "${LABEL[p]}"
slack_stub_history_fault "${LABEL[p]}" history delay "channel=${OP_CHANNEL}" "delay_ms=$((lookup_deadline_ms + 20000))"
mark="$(slack_post_mark)"
start
wait_until 30 'delayed lookup not reached' has_record_after "${mark}" fault "label=${LABEL[p]}" method=conversations.history outcome=delay
lookup_request="$(record_after "${mark}" fault "label=${LABEL[p]}" method=conversations.history outcome=delay | jq -er 'if length==1 then .[0].request_id else error("ambiguous lookup") end')"
wait_for_count "$(session_connected "$(persona_ref "${NAME[p]}")")" "$((connected + 1))" "${START_WAIT_S}" 'restarted worker did not reconnect'
set_choice p "${OP_CHANNEL}" mentions stale-value-away
set_choice p "${OP_CHANNEL}" thread_hybrid stale-value-back
new_stamp="$(stamp p "${OP_CHANNEL}")"
[[ "${new_stamp}" != "${OP_STAMP}" ]] || fail 'value cycle retained old stamp'
wait_until "${lookup_bound_s}" 'stale lookup did not settle or abort' has_record_after "${mark}" fault-settled "request_id=${lookup_request}"
joins_now="$(current_joins p "${OP_CHANNEL}")" || fail 'Thread Memory reader failed'
[[ -z "${joins_now}" ]] || fail 'late lookup joined under fresh value'
slack_stub_faults_clear "${LABEL[p]}"
ts="$(scenario_ts)"; text="$(scenario_text late-result-no-join)"
ack "$(push p "${OP_CHANNEL}" "${ts}" "${text}" "${OP_ROOT}")"
queued_n="$(shared_queued_count "${KEY[p]}" "${OP_CHANNEL}" "${ts}")" || fail 'queue reader failed'
[[ "${queued_n}" == 0 ]] || fail 'stale lookup selected reply'

# Phase 17: fault a bot choice before its durable application. Existing
# assignments survive, no new application/order position can be reported,
# and sibling traffic remains independently deliverable.
before="$(same_channel_facts p "${B}")"
applications="$(shared_attempt_applications "${KEY[p]}" "${B}")"
directory_fault >> "${EVIDENCE}/faults"
result="$(scenario_attempt_call "${WORK[p]}" "$(attempt_args "$(scenario_attempt_id choice-storage-fault)" "${B}" off)")"
jq -e '.isError==true and (has("error")|not)' <<< "${result}" > /dev/null || fail 'unwritable choice falsely succeeded'
facts_now="$(same_channel_facts p "${B}")" || fail 'persona facts reader failed'
[[ "${facts_now}" == "${before}" ]] || fail 'unwritable choice changed prior value/stamp'
apps_now="$(shared_attempt_applications "${KEY[p]}" "${B}")" || fail 'attempt reader failed'
[[ "${apps_now}" == "${applications}" ]] || fail 'failed choice acquired an application'
ts="$(scenario_ts)"; text="$(scenario_text sibling-during-choice-fault)"
ack "$(push q "${A}" "${ts}" "${text}")"
accepted q "${A}" "${ts}" receive_all_shared "${text}"
receipt q
repair_modes
set_choice p "${B}" thread_hybrid choice-storage-repaired

# Phase 18: several actual matching candidates lose the join, with one
# production-built report at the Notice Destination. The unrelated reply
# remains outside the thread, including after another restart.
# The lookup names a lost join's threads in the order Slack's history lists
# them, newest first (src/own-post-lookup.ts), so expected loss texts list
# the roots by ts, newest first.
newest_first() {
    jq -rn '$ARGS.positional | sort_by(tonumber) | reverse | join(",")' --args "$@"
}
pending_post ambiguous true
second_root="$(scenario_ts)"
slack_stub_history_seed "${OP_CHANNEL}" "$(slack_message_event "${OP_CHANNEL}" "${OP_TEXT}" "${second_root}" "$(slack_stub_identity "${LABEL[p]}" user_id)")"
lost_roots="$(newest_first "${OP_ROOT}" "${second_root}")"
loss_line="$(printed buildThreadMemoryOwnPostLostLine "${NAME[p]}" "${KEY[p]}" "${OP_CHANNEL}" "${lost_roots}" several)"
loss_notice="$(printed buildThreadMemoryOwnPostLostNotice "${NAME[p]}" "${KEY[p]}" "${OP_CHANNEL}" "${lost_roots}" several)"
loss_count="$(count_log "${loss_line}")"
crash
slack_stub_faults_clear "${LABEL[p]}"
mark="$(slack_post_mark)"
start
RECORD_WAIT_S="${lookup_bound_s}" shared_wait_own_post_state "${KEY[p]}" "${OP_ID}" "${OP_CHANNEL}" "${OP_STAMP}" none \
    > "${EVIDENCE}/ambiguous-outcome.json"
wait_for_count "${loss_line}" "$((loss_count + 1))" 30 'ambiguous lookup did not report lost joins'
slack_wait_successful_post "${LABEL[p]}" "${NOTICE}" "${mark}" "${loss_notice}" > "${EVIDENCE}/ambiguous-notice.json"
report_post p "${mark}" ambiguous-exact-notice buildThreadMemoryOwnPostLostNotice \
    "${NAME[p]}" "${KEY[p]}" "${OP_CHANNEL}" "${lost_roots}" several
for root in "${OP_ROOT}" "${second_root}"; do
    ts="$(scenario_ts)"; text="$(scenario_text after-ambiguous-loss)"
    ack "$(push p "${OP_CHANNEL}" "${ts}" "${text}" "${root}")"
    queued_n="$(shared_queued_count "${KEY[p]}" "${OP_CHANNEL}" "${ts}")" || fail 'queue reader failed'
    [[ "${queued_n}" == 0 ]] || fail 'reported lost join selected reply'
done
connected="$(count_log "$(session_connected "$(persona_ref "${NAME[p]}")")")"
stop_server
session_barrier_mark "${NAME[p]}"
start
wait_for_count "$(session_connected "$(persona_ref "${NAME[p]}")")" "$((connected + 1))" "${START_WAIT_S}" 'restarted worker did not reconnect'
session_barrier_wait "${START_WAIT_S}" 'ambiguous-loss restart: no new MCP session'
expect_count "${loss_line}" "$((loss_count + 1))" 'saved lost outcome reported again on restart'
joins_now="$(current_joins p "${OP_CHANNEL}")" || fail 'Thread Memory reader failed'
[[ -z "${joins_now}" ]] || fail 'lost outcome became joined after restart'

# Phase 19: a later chunk's definitive failure cannot undo or repost the
# earlier confirmed chunk. No inbound echo is needed for its join; two own
# echoes subsequently remain non-deliveries.
edit_input() {
    jq "$@" "${CONFIG}" > "${CONFIG}.candidate"
    mv "${CONFIG}.candidate" "${CONFIG}"
}
chunk_channel="$(scenario_id C chunk-failure)"
EXTRA_CHANNELS+=("${chunk_channel}")
slack_stub_inventory_page "${LABEL[p]}" '' '' "${A}" "${B}" "${NOTICE}" "${EXTRA_CHANNELS[@]}"
ack "$(slack_push_member_joined "${LABEL[p]}" "${chunk_channel}" "$(scenario_ts)")"
wait_membership_complete "${KEY[p]}"
set_choice p "${chunk_channel}" thread_hybrid chunk-hybrid
chunk_stamp="$(stamp p "${chunk_channel}")"
# Keep the configuration's startup reply defaults unchanged. These two
# independent parts exceed its limit together; newline mode splits at the
# retained newline. A copied production-loader/chunkText control checks this
# exact config and payload; reply_chunk_limit is not a live persona setting.
first_chunk="$(python3 -c 'print("abcdefgh" * 375, end="")')"$'\n'
second_chunk="$(python3 -c 'print("ijklmnop" * 375, end="")')"
chunk_text="${first_chunk}${second_chunk}"
slack_stub_post_fail "${LABEL[p]}" "${chunk_channel}" error error=channel_not_found after=1
chunk_mark="$(slack_post_mark)"
result="$(stub_session_call "${WORK[p]}" reply "$(jq -cn --arg c "${chunk_channel}" --arg t "${chunk_text}" '{chat_id:$c,text:$t}')")"
printf '%s\n' "${result}" > "${EVIDENCE}/chunk-result.json"
jq -e '.isError==true and (has("error")|not)' <<< "${result}" > /dev/null || fail 'later failed chunk falsely succeeded'
wait_until 30 'later chunk fault not reached' has_record_after "${chunk_mark}" fault "label=${LABEL[p]}" method=chat.postMessage outcome=error
record_after "${chunk_mark}" fault "label=${LABEL[p]}" method=chat.postMessage outcome=error \
    | jq -e 'if length==1 and .[0].matching_call==2 then .[0] else error("wrong chunk fault") end' \
    > "${EVIDENCE}/chunk-fault.json"
post="$(slack_wait_successful_post "${LABEL[p]}" "${chunk_channel}" "${chunk_mark}" "${first_chunk}")"
printf '%s\n' "${post}" > "${EVIDENCE}/chunk-success.json"
chunk_root="$(jq -er .ts <<< "${post}")"; chunk_post_seq="$(jq -er .seq <<< "${post}")"
assert_chunk_posts() {
    record_after "${chunk_mark}" api "label=${LABEL[p]}" method=chat.postMessage "channel=${chunk_channel}" \
        > "${EVIDENCE}/chunk-posts.json"
    jq -e --arg first "${first_chunk}" --arg second "${second_chunk}" --arg root "${chunk_root}" \
        --argjson seq "${chunk_post_seq}" --slurpfile fault "${EVIDENCE}/chunk-fault.json" '
      length==2 and .[0].answer=="ok" and .[0].text==$first and .[0].response_ts==$root and .[0].seq==$seq and
      .[1].answer=="channel_not_found" and .[1].text==$second and (.[1]|has("response_ts")|not) and
      all(.[]; (has("thread_ts")|not)) and
      ($fault[0].request_id|type=="string" and length>0) and .[1].request_id==$fault[0].request_id and
      $seq<$fault[0].seq and $fault[0].seq<.[1].seq
    ' "${EVIDENCE}/chunk-posts.json" > /dev/null || fail 'chunk success/failure binding changed or a chunk was reposted'
}
assert_chunk_posts
wait_until 30 'earlier chunk failed to join without echo' root_saved p "${chunk_channel}" "${chunk_root}"
assert_chunk_join() {
    local current
    current="$(stamp p "${chunk_channel}")" || fail 'stamp reader failed'
    [[ "${current}" == "${chunk_stamp}" ]] || fail 'chunk Channel Stamp changed'
    shared_thread_joins "${KEY[p]}" "${chunk_channel}" "${chunk_stamp}" > "${EVIDENCE}/chunk-joins.jsonl"
    jq -se --arg root "${chunk_root}" 'length==1 and .[0].root==$root' "${EVIDENCE}/chunk-joins.jsonl" \
        > /dev/null || fail 'confirmed chunk did not retain its sole exact join'
}
assert_chunk_join
post_seq="${chunk_post_seq}"
for copy in first duplicate; do ack "$(slack_push_observed_post "${LABEL[p]}" "${LABEL[p]}" "${chunk_channel}" "${post_seq}")"; done
queued_n="$(shared_queued_count "${KEY[p]}" "${chunk_channel}" "${chunk_root}")" || fail 'queue reader failed'
[[ "${queued_n}" == 0 ]] || fail 'own echo accepted as user work'
assert_chunk_join
assert_chunk_posts
slack_stub_faults_clear "${LABEL[p]}"

# Phase 20: accepted mention/Broadcast joins survive a process death after a
# refused Thread Memory append. Durable queue joins are the recovery source;
# no message is reposted or accepted twice. Known c9 limit: an episode whose
# onset belonged to the dead process has no closing recovery notice.
file_fault "${memory_path}" >> "${EVIDENCE}/faults"
declare -a crash_roots=() crash_inputs=()
for kind in mention broadcast; do
    root="$(scenario_ts)"; text="$(scenario_text "crash-join-${kind}")"
    if [[ "${kind}" == mention ]]; then text="$(scenario_mention_text "$(slack_stub_identity "${LABEL[p]}" user_id)" "${text}")"
    else text="$(scenario_broadcast_text here "${text}")"; fi
    envelope="$(push p "${B}" "${root}" "${text}")"
    ack "${envelope}"
    accepted p "${B}" "${root}" "${kind}" "${text}"
    receipt p
    crash_roots+=("${root}"); crash_inputs+=("${envelope}")
done
recovered_class="$(printed THREAD_MEMORY_RECOVERED)"
recovered_before="$(count_log "$(matcher "${recovered_class}" "${KEY[p]}")")"
crash
chmod 600 "${memory_path}"
session_barrier_mark "${NAME[p]}"
start
session_barrier_wait "${START_WAIT_S}" 'crash-join restart: no new MCP session'
for root in "${crash_roots[@]}"; do root_saved p "${B}" "${root}" || fail 'queue recovery silently lost accepted join'; done
for envelope in "${crash_inputs[@]}"; do ack "$(slack_stub_redeliver "${LABEL[p]}" "${envelope}")"; done
expect_count "$(matcher "${recovered_class}" "${KEY[p]}")" "${recovered_before}" 'restart invented an old episode closing report'

# Phase 21: deletion/replacement while stopped is an operator action on the
# actual scratch journal, never a fabricated record. Known c9 limit: the
# created marker with neither journal nor seal is reported on every start.
seal_path="${SLACK_STATE_DIR}/$(printed THREAD_MEMORY_SEAL_FILE)"
for iteration in first repeated; do
    drain p
    deleted_channels="$(shared_persona_facts "${KEY[p]}" | jq -r '.assignments|to_entries|map(select(.value.delivery=="thread_hybrid")|.key)|sort|join(",")')"
    connected="$(count_log "$(session_connected "$(persona_ref "${NAME[p]}")")")"
    stop_server
    [[ "$(shared_thread_created "${KEY[p]}")" == true ]] || fail 'missing real Thread Memory created marker'
    if [[ -f "${memory_path}" ]]; then mv "${memory_path}" "${EVIDENCE}/deleted-memory-${iteration}"; fi
    if [[ -f "${seal_path}" ]]; then mv "${seal_path}" "${EVIDENCE}/deleted-seal-${iteration}"; fi
    before="$(count_log "$(matcher "${changed}" "${KEY[p]}")")"
    mark="$(slack_post_mark)"
    start
    wait_for_count "$(session_connected "$(persona_ref "${NAME[p]}")")" "$((connected + 1))" "${START_WAIT_S}" 'restarted worker did not reconnect'
    wait_for_count "$(matcher "${changed}" "${KEY[p]}")" "$((before + 1))" 30 'marker without journal/seal was silently forgotten'
    report_post p "${mark}" "memory-deleted-${iteration}-notice" buildThreadMemoryChangedWhileStoppedNotice \
        "$(persona_ref "${NAME[p]}")" "${deleted_channels}" changed
    # Old compacted joins have no selecting fact after deletion. Any retained
    # queue join may be recovered; use the own-post chunk, never a queue root.
    ts="$(scenario_ts)"; text="$(scenario_text "deleted-own-root-${iteration}")"
    ack "$(push p "${chunk_channel}" "${ts}" "${text}" "$(jq -er .ts <<< "${post}")")"
    queued_n="$(shared_queued_count "${KEY[p]}" "${chunk_channel}" "${ts}")" || fail 'queue reader failed'
    [[ "${queued_n}" == 0 ]] || fail 'deleted own-post join still selected'
done

# Phase 22: each destructive identity boundary with accepted old-key work,
# delayed membership evidence and a hung own-post lookup. Configuration uses
# the real reviewed input path. Only the input's choices, declared for
# replacement retention, survive; every current Thread Hybrid Since belongs
# to the new incarnation.
cp "${CONFIG}" "${EVIDENCE}/identity-original-config.json"
identity_compaction_before=''
for reset in remove rename credentials working-directory; do
    drain p
    pending_post "identity-${reset}" true
    connected="$(count_log "$(session_connected "$(persona_ref "${NAME[p]}")")")"
    crash
    start
    wait_for_count "$(session_connected "$(persona_ref "${NAME[p]}")")" "$((connected + 1))" "${START_WAIT_S}" 'restarted worker did not reconnect'
    if [[ -n "${identity_compaction_before}" ]]; then
        compacted_queue p "${identity_compaction_before}" "${EVIDENCE}/identity-before-${reset}-compacted.jsonl"
    fi
    wait_until 30 'identity case has no hung old lookup' has_record_after "${OP_MARK}" fault "label=${LABEL[p]}" method=conversations.history outcome=hang
    set_choice p "${A}" off "identity-old-preference-${reset}"
    old_facts="$(shared_persona_facts "${KEY[p]}")"
    old_incarnation="$(jq -er .incarnation <<< "${old_facts}")"
    old_stamp="$(stamp p "${B}")"
    shared_stub_notice end "${WORK[p]}" "${KEY[p]}" "${EVIDENCE}/identity-${reset}-ended.json" > /dev/null
    root="$(scenario_ts)"; text="$(scenario_mention_text "$(slack_stub_identity "${LABEL[p]}" user_id)" "$(scenario_text "identity-${reset}-accepted")")"
    original="$(push p "${B}" "${root}" "${text}")"
    ack "${original}"
    accepted p "${B}" "${root}" mention "${text}"
    wait_until 30 'identity case root not saved before reset' root_saved p "${B}" "${root}"
    snapshot p
    cp "${SNAP[p]}" "${EVIDENCE}/identity-${reset}-old-queue.jsonl"
    # A one-shot delayed scan holds an empty contradictory result. Its next
    # call is ordinary, while the independent persistent history fault keeps
    # the old own-post lookup hung through the identity application.
    slack_stub_inventory_fault "${LABEL[p]}" '' delay "delay_ms=$((membership_request_ms + 20000))" "body=$(slack_stub_inventory_body '')"
    scan_mark="$(slack_post_mark)"
    slack_stub_close_socket "${LABEL[p]}"
    wait_until 60 'identity case scan did not hang' has_record_after "${scan_mark}" fault "label=${LABEL[p]}" method=users.conversations outcome=delay
    scan_request="$(record_after "${scan_mark}" fault "label=${LABEL[p]}" method=users.conversations outcome=delay | jq -er 'if length==1 then .[0].request_id else error("ambiguous scan") end')"
    new_name="${NAME[p]}"; new_key="${KEY[p]}"
    case "${reset}" in
        remove) edit_input --arg who "${NAME[p]}" '.personas |= map(select(.name!=$who))' ;;
        rename)
            new_name="${NAME[p]}_renamed"; new_key="$(persona_key "${new_name}")"
            edit_input --arg who "${NAME[p]}" --arg name "${new_name}" '(.personas[]|select(.name==$who)|.name)=$name'
            ;;
        credentials)
            cp "${CREDS[p]}" "${SCENARIO_ROOT}/replacement-credentials.json"
            chmod 600 "${SCENARIO_ROOT}/replacement-credentials.json"
            edit_input --arg who "${NAME[p]}" --arg path "${SCENARIO_ROOT}/replacement-credentials.json" '(.personas[]|select(.name==$who)|.credentials_file)=$path'
            ;;
        working-directory)
            replacement_work="$(make_workdir identity-replacement)"
            edit_input --arg who "${NAME[p]}" --arg path "${replacement_work}" '(.personas[]|select(.name==$who)|.working_directory)=$path'
            ;;
    esac
    connected="$(count_log "$(session_connected "$(persona_ref "${new_name}")")")"
    # Removal leaves no persona to declare; its re-add below declares them.
    RETAIN=(); [[ "${reset}" == remove ]] || retain "${new_name}"
    review "identity-${reset}" ${RETAIN[@]+"${RETAIN[@]}"}
    reset_mark="$(slack_post_mark)"
    if [[ "${reset}" == remove ]]; then
        # Applied removal is observable in the reviewed durable projection;
        # the old queue remains, before re-add reactivates its original key.
        [[ -f "${SLACK_STATE_DIR}/queue/${KEY[p]}.jsonl" ]] || fail 'removal deleted accepted queue'
        cp "${EVIDENCE}/identity-original-config.json" "${CONFIG}"
        retain "${NAME[p]}"
        review identity-readd "${RETAIN[@]}"
    fi
    wait_for_count "$(session_connected "$(persona_ref "${new_name}")")" "$((connected + 1))" "${START_WAIT_S}" 'new identity worker did not connect'
    wait_membership_complete "${new_key}"
    new_facts="$(shared_persona_facts "${new_key}")"
    new_incarnation="$(jq -er .incarnation <<< "${new_facts}")" || fail 'new identity facts lack an incarnation'
    [[ "${new_incarnation}" != "${old_incarnation}" ]] || fail 'identity boundary retained incarnation'
    [[ "$(shared_channel_saved "${new_key}" "${A}")" == all ]] || fail 'identity inherited old bot preference'
    new_stamp="$(printed sharedThreadStamp "${CONFIG}" "${LAST}" "${new_key}" "${B}")"
    [[ "${new_stamp}" != "${old_stamp}" ]] || fail 'identity boundary reused thread stamp'
    joins_now="$(shared_thread_joins "${new_key}" "${B}" "${new_stamp}")" || fail 'Thread Memory reader failed'
    [[ -z "${joins_now}" ]] || fail 'identity inherited Joined Threads'
    jq -e --arg b "${B}" 'all(.assignments|to_entries[]; .key==$b or .value.delivery!="thread_hybrid")' <<< "${new_facts}" > /dev/null \
        || fail 'identity inherited an unlisted hybrid assignment'
    ts="$(scenario_ts)"; text="$(scenario_text "identity-${reset}-delayed-reply")"
    ack "$(push p "${B}" "${ts}" "${text}" "${root}")"
    queued_n="$(shared_queued_count "${new_key}" "${B}" "${ts}")" || fail 'queue reader failed'
    [[ "${queued_n}" == 0 ]] || fail 'delayed reply revived old join'
    wait_until "$((membership_request_ms / 1000 + 40))" 'old scan did not cancel or settle across reset' \
        has_record_after "${scan_mark}" fault-settled "request_id=${scan_request}"
    [[ "$(shared_channel_saved "${new_key}" "${A}")" == all ]] || fail 'late old scan removed new baseline'
    sleep "$(( (lookup_max_ms + lookup_deadline_ms + 999) / 1000 + 1 ))"
    records_n="$(record_after "${reset_mark}" fault "label=${LABEL[p]}" method=conversations.history | jq length)" \
        || fail 'stub record reader failed'
    [[ "${records_n}" == 0 ]] || fail 'identity reset retained an obsolete own-post lookup retry'
    if [[ "${reset}" == rename ]]; then
        if [[ -f "${SLACK_STATE_DIR}/queue/${new_key}.jsonl" ]]; then
            shared_queue_items "${new_key}" | jq -se --arg root "${root}" 'all(.[]; .ts!=$root)' > /dev/null || fail 'rename moved an old-key queue item'
        fi
    fi
    if [[ "${reset}" != remove ]]; then
        connected="$(count_log "$(session_connected "$(persona_ref "${NAME[p]}")")")"
        cp "${EVIDENCE}/identity-original-config.json" "${CONFIG}"
        retain "${NAME[p]}"
        review "identity-${reset}-restore" "${RETAIN[@]}"
        wait_for_count "$(session_connected "$(persona_ref "${NAME[p]}")")" "$((connected + 1))" "${START_WAIT_S}" 'restored original worker did not connect'
    fi
    wait_membership_complete "${KEY[p]}"
    drain p
    retained_queue_keys p "${EVIDENCE}/identity-${reset}-old-queue.jsonl" "${EVIDENCE}/identity-${reset}-drained-live.jsonl"
    # Delivery does not trigger compaction. Retain its receipt archive and
    # check compacted keys at the next existing process restart instead.
    identity_compaction_before="${EVIDENCE}/identity-${reset}-completed-queue.jsonl"
    cp "${SNAP[p]}" "${identity_compaction_before}"
    ack "$(slack_stub_redeliver "${LABEL[p]}" "${original}")"
    [[ "$(queued_total p "${B}" "${root}" mention)" == 1 ]] || fail 'reset replay duplicated old-key work'
    joins_now="$(current_joins p "${B}")" || fail 'Thread Memory reader failed'
    [[ -z "${joins_now}" ]] || fail 'old queue replay joined under restored identity'
    assert_stamps
done

# Phase 23: confirmation after the durable intent but with the outcome/join
# append refused. A successful Slack API record binds the actual root; the
# exact unresolved intent plus the effective file fault gate the kill. The
# held answer comes 5 s inside the client's 30 s attempt (lose_post).
pending_post confirmed-unsaved true 25000
file_fault "${memory_path}" >> "${EVIDENCE}/faults"
post="$(RECORD_WAIT_S=45 slack_wait_successful_post "${LABEL[p]}" "${OP_CHANNEL}" "${OP_MARK}" "${OP_TEXT}")"
[[ "$(jq -er .ts <<< "${post}")" == "${OP_ROOT}" ]] || fail 'confirmed root differs from controlled Slack post'
result="$(stub_session_result "${WORK[p]}" "${OP_CALL}")"
jq -e '.isError==false and (has("error")|not)' <<< "${result}" > /dev/null || fail 'confirmed post did not return success'
joins_now="$(current_joins p "${OP_CHANNEL}")" || fail 'Thread Memory reader failed'
[[ -z "${joins_now}" ]] || fail 'file fault did not prevent durable own-post join'
facts="$(shared_persona_facts "${KEY[p]}" "${OP_CHANNEL}")"
jq -e --argjson stamp "${OP_STAMP}" --arg c "${OP_CHANNEL}" '.incarnation==$stamp.incarnation and .assignments[$c].threadHybridSince==$stamp.threadHybridSince' \
    <<< "${facts}" > /dev/null || fail 'confirmed unsaved post has stale authority'
shared_wait_own_post_state "${KEY[p]}" "${OP_ID}" "${OP_CHANNEL}" "${OP_STAMP}" unresolved > "${EVIDENCE}/confirmed-unsaved-before-kill.json"
connected="$(count_log "$(session_connected "$(persona_ref "${NAME[p]}")")")"
crash
repair_modes
start
wait_for_count "$(session_connected "$(persona_ref "${NAME[p]}")")" "$((connected + 1))" "${START_WAIT_S}" 'restarted worker did not reconnect'
compacted_queue p "${identity_compaction_before}" "${EVIDENCE}/identity-final-compacted.jsonl"
slack_stub_faults_clear "${LABEL[p]}"
RECORD_WAIT_S="${lookup_bound_s}" shared_wait_own_post_state "${KEY[p]}" "${OP_ID}" "${OP_CHANNEL}" "${OP_STAMP}" joined \
    > "${EVIDENCE}/confirmed-unsaved-recovered.json"
root_saved p "${OP_CHANNEL}" "${OP_ROOT}" || fail 'confirmed post join silently lost'
[[ "$(record_after "${OP_MARK}" api "label=${LABEL[p]}" method=chat.postMessage "channel=${OP_CHANNEL}" answer=ok | jq length)" == 1 ]] || fail 'confirmed recovery reposted'

# Phase 24: known 5c/kq Decision 1 limit. The real messages-waiting notice
# posts successfully while its own join cannot be saved. That notice-only
# outage leaves a log line, without a recursive notice. A crash can lose that
# unsaved intent, so the later reply is outside the notice's thread.
set_choice p "${NOTICE}" thread_hybrid notice-loss-hybrid
drain p
channels="$(shared_persona_facts "${KEY[p]}" | jq -r '[.assignments|to_entries[]|select(.value.delivery=="thread_hybrid")|.key]|sort|join(",")')"
notice_line="$(printed buildThreadMemoryNotSavedLine "${KEY[p]}" "${channels}" "${memory_path}" journal-append CONTROLLED_ERROR true)"
marker="$(controlled_marker "${notice_line}")"
notice_match="$(matcher "${notice_line%"${marker}"*}" "${notice_line#*"${marker}"}")"
before="$(count_log "${notice_match}")"
mark="$(slack_post_mark)"
shared_stub_notice end "${WORK[p]}" "${KEY[p]}" "${EVIDENCE}/notice-loss-ended.json" > /dev/null
file_fault "${memory_path}" >> "${EVIDENCE}/faults"
ts="$(scenario_ts)"; text="$(scenario_text notice-loss-queued)"
ack "$(push p "${A}" "${ts}" "${text}")"
accepted p "${A}" "${ts}" receive_all_shared "${text}"
notice_post="$(slack_wait_messages_waiting "${LABEL[p]}" "${NOTICE}" "${mark}" "${NAME[p]}" "${KEY[p]}" 1)"
notice_root="$(jq -er .ts <<< "${notice_post}")"
wait_for_count "${notice_match}" "$((before + 1))" 30 'notice-only failure did not leave its log line'
[[ "$(record_after "${mark}" api "label=${LABEL[p]}" method=chat.postMessage "channel=${NOTICE}" answer=ok | jq length)" == 1 ]] || fail 'notice-only failure recursively posted an outage notice'
connected="$(count_log "$(session_connected "$(persona_ref "${NAME[p]}")")")"
crash
repair_modes
start
shared_stub_notice resume "${WORK[p]}" "${KEY[p]}" "${EVIDENCE}/notice-loss-ended.json" > /dev/null
wait_for_count "$(session_connected "$(persona_ref "${NAME[p]}")")" "$((connected + 1))" "${START_WAIT_S}" 'resumed worker did not reconnect'
drain p
ts="$(scenario_ts)"; text="$(scenario_text lost-notice-join-reply)"
ack "$(push p "${NOTICE}" "${ts}" "${text}" "${notice_root}")"
queued_n="$(shared_queued_count "${KEY[p]}" "${NOTICE}" "${ts}")" || fail 'queue reader failed'
[[ "${queued_n}" == 0 ]] || fail 'unsaved notice-only join survived without a fact'

# Phase 25: a confirmation copied into place while stopped remains stale
# against a later durable bot preference, even with startup membership held.
configuration_request stopped-confirmation request "${NAME[p]}/${B}/off" "${NAME[p]}/${A}/mentions" > /dev/null
cp "${CONFIG}.pending" "${EVIDENCE}/stopped-confirmation.pending"
set_choice p "${B}" thread_hybrid newer-before-stopped-confirmation
preserved="$(same_channel_facts p "${B}")"
stop_server
cp "${EVIDENCE}/stopped-confirmation.pending" "${CONFIG}.apply"
slack_stub_inventory_fault "${LABEL[p]}" '' hang times=100000
mark="$(slack_post_mark)"; before="$(count_log "${superseded_line}")"
start_server --live
wait_membership_complete "${KEY[q]}"
wait_until 30 'stopped confirmation case did not enter startup scan fault' has_record_after "${mark}" fault "label=${LABEL[p]}" method=users.conversations outcome=hang
wait_for_count "${superseded_line}" "$((before + 1))" 30 'stopped stale confirmation was not refused'
[[ ! -e "${CONFIG}.apply" ]] || fail 'refused stopped confirmation was not spent'
facts_now="$(same_channel_facts p "${B}")" || fail 'persona facts reader failed'
[[ "${facts_now}" == "${preserved}" ]] || fail 'stopped confirmation overwrote newer durable preference'
ts="$(scenario_ts)"; text="$(scenario_text stopped-confirmation-held)"
envelope="$(push p "${B}" "${ts}" "${text}")"
no_ack "${envelope}"
slack_stub_faults_clear "${LABEL[p]}"
wait_until "${recovery_bound_s}" 'membership did not recover after stale confirmation' _scenario_membership_complete "${KEY[p]}" "$(printed MEMBERSHIP_READINESS_ROUTE)"
configuration_request stopped-confirmation-cancel cancel > /dev/null
ack "$(slack_stub_redeliver "${LABEL[p]}" "${envelope}")"
queued_n="$(shared_queued_count "${KEY[p]}" "${B}" "${ts}")" || fail 'queue reader failed'
[[ "${queued_n}" == 0 ]] || fail 'stale confirmation unexpectedly selected plain input'

# Phase 26: shutdown cancels both an in-flight membership scan and its
# scheduled retry. After the old response settles there are no new requests
# during the entire published retry window; a new start creates new evidence.
for stage in hung retry-scheduled; do
    slack_stub_faults_clear "${LABEL[p]}"
    if [[ "${stage}" == hung ]]; then
        slack_stub_inventory_fault "${LABEL[p]}" '' delay "delay_ms=$((membership_request_ms + 20000))" times=100000
    else slack_stub_inventory_fault "${LABEL[p]}" '' rate_limit retry_after=60 times=100000; fi
    mark="$(slack_post_mark)"
    before="$(count_log "${incomplete}")"
    slack_stub_close_socket "${LABEL[p]}"
    wait_until 60 'shutdown case did not reach inventory control' has_record_after "${mark}" fault "label=${LABEL[p]}" method=users.conversations
    if [[ "${stage}" == retry-scheduled ]]; then
        wait_for_count "${incomplete}" "$((before + 1))" 30 'retry-scheduled inventory did not become incomplete'
    fi
    stop_server
    session_barrier_mark "${NAME[p]}"
    stopped_mark="$(slack_post_mark)"
    sleep "$(( (membership_retry_ms + membership_request_ms + 999) / 1000 + 1 ))"
    records_n="$(record_after "${stopped_mark}" fault "label=${LABEL[p]}" method=users.conversations | jq length)" \
        || fail 'stub record reader failed'
    [[ "${records_n}" == 0 ]] || fail 'stopped server started an obsolete scan/retry'
    slack_stub_faults_clear "${LABEL[p]}"
    start
    session_barrier_wait "${START_WAIT_S}" "shutdown-${stage} restart: no new MCP session"
    assert_stamps
done

# Phase 27: the confirmed operator baseline cannot claim application when
# its atomic authority write is refused. Pre-create the apply inode so the
# gesture itself can be written after the directory fault is established.
configuration_request baseline-fault request "${NAME[p]}/${A}/mentions" > /dev/null
cp "${CONFIG}.pending" "${EVIDENCE}/baseline-fault.pending"
cp "${LAST}" "${EVIDENCE}/baseline-fault-before"
write_class="$(printed RELOAD_RECORD_WRITE_FAILED)"
before="$(count_log "${write_class}")"
mark="$(slack_post_mark)"
: > "${CONFIG}.apply"
directory_fault >> "${EVIDENCE}/faults"
[[ -f "${CONFIG}.apply" ]] || fail 'baseline fault setup lost its pre-created confirmation inode'
cat "${EVIDENCE}/baseline-fault.pending" > "${CONFIG}.apply"
wait_for_count "${write_class}" "$((before + 1))" 30 'operator baseline write fault was not reached'
configuration_application_preserved "${CONFIG}" "${EVIDENCE}/baseline-fault-before" "${LAST}" > /dev/null
failed_notice="$(printed buildReloadApplyFailedNotice "$(persona_ref "${NAME[p]}")" authority "${LAST}" CONTROLLED_ERROR)"
slack_wait_successful_post "${LABEL[p]}" "${NOTICE}" "${mark}" \
    "${failed_notice%CONTROLLED_ERROR*}" "${failed_notice#*CONTROLLED_ERROR}" > "${EVIDENCE}/baseline-fault-notice.json"
report_post p "${mark}" baseline-fault-exact-notice buildReloadApplyFailedNotice "$(persona_ref "${NAME[p]}")" authority "${LAST}" CONTROLLED_ERROR
ts="$(scenario_ts)"; text="$(scenario_text q-during-baseline-fault)"
ack "$(push q "${A}" "${ts}" "${text}")"
accepted q "${A}" "${ts}" receive_all_shared "${text}"
receipt q
repair_modes
# A failure before even the durable review-attempt write has no spent gesture
# on disk. Withdraw that physical confirmation before killing the process;
# the separately retained operator intent is what the restart must preserve.
mv "${CONFIG}.apply" "${EVIDENCE}/baseline-fault-withdrawn.apply"
connected="$(count_log "$(session_connected "$(persona_ref "${NAME[p]}")")")"
crash
start
wait_for_count "$(session_connected "$(persona_ref "${NAME[p]}")")" "$((connected + 1))" "${START_WAIT_S}" 'restarted worker did not reconnect'
configuration_application_preserved "${CONFIG}" "${EVIDENCE}/baseline-fault-before" "${LAST}" > /dev/null
configuration_request baseline-fault-refresh refresh > /dev/null
cp "${CONFIG}.pending" "${EVIDENCE}/baseline-fault-refreshed.pending"
mv "${CONFIG}.pending" "${CONFIG}.apply"
wait_until "${START_WAIT_S}" 'repaired baseline did not consume a fresh review' bun "${PRINTER}" sharedReviewConsumed \
    "${CONFIG}" "${LAST}" "${EVIDENCE}/baseline-fault-refreshed.pending" > /dev/null
choice_is p "${A}" mentions || fail 'fresh operator baseline did not apply'
set_choice p "${A}" all baseline-fault-restore-all

# Phase 28: the running owner stages restoration from its actual validated
# anchor. Staging freezes Channel Stamps but preserves unchanged intake.
# The exact single-channel installed-unsynced projection remains the existing
# shared-channel-recovery.test.ts case; no filesystem chmod simulates fsync.
for who in p q; do drain "${who}"; wait_membership_complete "${KEY[${who}]}"; done
# Give P a reviewed fresh working-directory life and an independently fixed
# three-channel inventory. This excludes historical absence-order disputes
# from this repair's scope; the earlier phases retain their evidence.
WORK[p]="$(make_workdir reviewed-repair)"
shared_stub_notice_setup "${WORK[p]}" > /dev/null
slack_stub_inventory_page "${LABEL[p]}" '' '' "${A}" "${B}" "${NOTICE}"
edit_input --arg work "${WORK[p]}" '.personas[0].working_directory=$work'
connected="$(count_log "$(session_connected "$(persona_ref "${NAME[p]}")")")"
retain "${NAME[p]}"
review reviewed-repair-worker "${RETAIN[@]}"
wait_for_count "$(session_connected "$(persona_ref "${NAME[p]}")")" "$((connected + 1))" "${START_WAIT_S}" 'reviewed repair worker did not connect'
wait_membership_complete "${KEY[p]}"
restore_root="$(scenario_ts)"
restore_text="$(scenario_mention_text "$(slack_stub_identity "${LABEL[p]}" user_id)" "$(scenario_text before-owned-restoration)")"
restore_envelope="$(push p "${B}" "${restore_root}" "${restore_text}")"
ack "${restore_envelope}"
accepted p "${B}" "${restore_root}" mention "${restore_text}"
receipt p
wait_until 30 'restoration seed join absent' root_saved p "${B}" "${restore_root}"
restore_stamp="$(stamp p "${B}")"
restore_facts="$(shared_persona_facts "${KEY[p]}")"
restore_channels="$(jq -cn --arg a "${A}" --arg b "${B}" --arg notice "${NOTICE}" '[$a,$b,$notice]|sort')"
jq -e --argjson channels "${restore_channels}" '(.assignments|keys|sort)==$channels and (.historicalMembership|keys|sort)==$channels and (.leaves|length)==0' \
    <<< "${restore_facts}" > /dev/null || fail 'repair scope differs from independently fixed inventory'
restore_scope="$(jq -cn --argjson channels "${restore_channels}" '{channels:$channels,all:true,dm:false}')"
staged_scope="$(jq -c '.+{repairPending:{usable:.channels,held:[]}}' <<< "${restore_scope}")"
configuration_request restoration-separate-intent request "${NAME[p]}/${A}/mentions" > /dev/null
cp "${CONFIG}.pending" "${EVIDENCE}/restoration-separate-intent.pending"
cp "${CONFIG}" "${EVIDENCE}/restoration-prepared-input.json"
cp "${LAST}" "${EVIDENCE}/restoration-anchor"
stage_line="$(printed sharedRecoveryLine 'restoration staged')"
stage_count="$(count_log "${stage_line}")"
staged_notice="$(printed buildSharedStateUnresolvedNotice "$(persona_ref "${NAME[p]}")" "${staged_scope}" restoration-staged "${LAST}")"
staged_diagnostic="$(printed buildSharedStateUnresolvedLine "${KEY[p]}" "${staged_scope}" restoration-staged "${LAST}")"
staged_count="$(count_log "${staged_diagnostic}")"
mark="$(slack_post_mark)"
printf '%s\n' 'controlled damaged authority while the live owner retains its anchor' > "${LAST}"
cp "${LAST}" "${EVIDENCE}/restoration-damaged"
configuration_recovery_request "$(scenario_attempt_id owned-restoration)" "${EVIDENCE}/restoration-damaged" "${EVIDENCE}/restoration-request.json"
wait_for_count "${stage_line}" "$((stage_count + 1))" 30 'owner did not stage restoration'
configuration_application_preserved "${CONFIG}" "${EVIDENCE}/restoration-anchor" "${LAST}" > /dev/null
wait_for_count "${staged_diagnostic}" "$((staged_count + 1))" 30 'staged repair diagnostic missing'
slack_wait_successful_post "${LABEL[p]}" "${NOTICE}" "${mark}" "${staged_notice}" > "${EVIDENCE}/restoration-staged-notice.json"
report_post p "${mark}" restoration-staged-exact-notice buildSharedStateUnresolvedNotice \
    "$(persona_ref "${NAME[p]}")" "${staged_scope}" restoration-staged "${LAST}"
shared_thread_joins "${KEY[p]}" "${B}" "${restore_stamp}" | jq -se --arg root "${restore_root}" \
    'any(.[]; .root==$root)' > /dev/null || fail 'undecided stamp discarded retained Joined Threads'
restore_held_ts="$(scenario_ts)"; restore_held_text="$(scenario_text staged-thread-held)"
restore_held="$(push p "${B}" "${restore_held_ts}" "${restore_held_text}" "${restore_root}")"
no_ack "${restore_held}"
queued_n="$(shared_queued_count "${KEY[p]}" "${B}" "${restore_held_ts}")" || fail 'queue reader failed'
[[ "${queued_n}" == 0 ]] || fail 'undecided stamp selected a dependent reply'
for who in p q; do
    ts="$(scenario_ts)"; text="$(scenario_text "${who}-during-staged-repair")"
    ack "$(push "${who}" "${A}" "${ts}" "${text}")"
    accepted "${who}" "${A}" "${ts}" receive_all_shared "${text}"
    receipt "${who}"
done

# Known 5c/ko limit: no stamp means this confirmed own post's intent exists
# only in memory. Prove the actual Slack success and unchanged durable intent
# records, then kill while the live staged authority still holds the reply.
shared_own_post_records "${KEY[p]}" > "${EVIDENCE}/undecided-post-before.jsonl"
undecided_text="$(scenario_text undecided-stamp-confirmed-post)"
undecided_mark="$(slack_post_mark)"
result="$(stub_session_call "${WORK[p]}" reply "$(jq -cn --arg c "${B}" --arg text "${undecided_text}" '{chat_id:$c,text:$text}')")"
jq -e '.isError==false and (has("error")|not)' <<< "${result}" > /dev/null || fail 'unchanged post scope was unavailable during staged repair'
undecided_post="$(slack_wait_successful_post "${LABEL[p]}" "${B}" "${undecided_mark}" "${undecided_text}")"
undecided_root="$(jq -er .ts <<< "${undecided_post}")"
shared_own_post_records "${KEY[p]}" > "${EVIDENCE}/undecided-post-after.jsonl"
cmp -s "${EVIDENCE}/undecided-post-before.jsonl" "${EVIDENCE}/undecided-post-after.jsonl" || fail 'undecided post unexpectedly obtained a durable intent'
expect_count "${staged_diagnostic}" "$((staged_count + 1))" 'staged repair notice repeated during one episode'
slack_successful_post "${LABEL[p]}" "${NOTICE}" "${mark}" "${staged_notice}" > /dev/null
shared_stub_notice end "${WORK[p]}" "${KEY[p]}" "${EVIDENCE}/restoration-ended.json" > /dev/null
snapshot p
cp "${SNAP[p]}" "${EVIDENCE}/restoration-completed-before.jsonl"
shared_queue_receipts "${KEY[p]}" "${SNAP[p]}" "${SNAP[p]}" > "${EVIDENCE}/restoration-completed-receipts.json"
jq -e '.complete' "${EVIDENCE}/restoration-completed-receipts.json" > /dev/null || fail 'repair started with earlier unfinished work'
restore_queue_ts="$(scenario_ts)"; restore_queue_text="$(scenario_text accepted-before-restoration-kill)"
ack "$(push p "${A}" "${restore_queue_ts}" "${restore_queue_text}")"
accepted p "${A}" "${restore_queue_ts}" receive_all_shared "${restore_queue_text}"
snapshot p
cp "${SNAP[p]}" "${EVIDENCE}/restoration-queue-before.jsonl"
restoration_pending_preserved() {
    local current="${EVIDENCE}/restoration-${1}-live.jsonl" receipts="${EVIDENCE}/restoration-${1}-receipts.json"
    retained_queue_keys p "${EVIDENCE}/restoration-queue-before.jsonl" "${current}"
    jq -se --slurpfile before "${EVIDENCE}/restoration-queue-before.jsonl" \
        --slurpfile completed "${EVIDENCE}/restoration-completed-before.jsonl" \
        --arg channel "${A}" --arg ts "${restore_queue_ts}" --arg text "${restore_queue_text}" --arg user "${HUMAN}" '
      def full: [.[]|select(.kind=="accepted" and (has("compact")|not))];
      ($before|full|map(select(.channel==$channel and .ts==$ts))) as $pending |
      ($pending|length)==1 and
      ($pending[0]|.source=="slack" and .key=={chat_id:$channel,ts:$ts} and .user==$user and
        .text==$text and .via=="receive_all_shared" and (has("thread_ts")|not) and (has("hold")|not)) and
      ($completed|all(.[]; .kind!="accepted" or .seq!=$pending[0].seq)) and
      (full|map(select(.seq==$pending[0].seq)))==$pending and
      all(.[]; .kind!="delivered" or .seq!=$pending[0].seq)
    ' "${current}" > /dev/null || fail 'repair changed or lost exact pending acceptance'
    shared_queue_receipts "${KEY[p]}" "${EVIDENCE}/restoration-queue-before.jsonl" "${EVIDENCE}/restoration-queue-before.jsonl" > "${receipts}"
    jq -e --slurpfile current "${current}" --arg ts "${restore_queue_ts}" '
      ($current|map(select(.kind=="accepted" and (has("compact")|not) and .ts==$ts))|.[0].seq) as $seq |
      .complete==false and .incomplete==1 and (.first_incomplete|length)==1 and
      .first_incomplete[0].seq==$seq and .first_incomplete[0].receipted_parts==0
    ' "${receipts}" > /dev/null || fail 'repair changed pending workload or earlier completion evidence'
}
restoration_pending_preserved before-kill
crash

refused_recovery_start() {
    run_start --live
    [[ "${START_RC}" -ne 0 ]] || fail 'unconfirmed recovery unexpectedly started'
    ! _scenario_pid_file_live || fail 'unconfirmed recovery left a running daemon'
}
refused_recovery_start
restoration_pending_preserved first-refusal
shared_recovery_pending "${EVIDENCE}/restoration-request.json" "${CONFIG}.pending" > "${EVIDENCE}/restoration-review.json"
cp "${CONFIG}.pending" "${EVIDENCE}/restoration-reviewed.pending"
shared_recovery_pending "${EVIDENCE}/restoration-request.json" "${EVIDENCE}/restoration-reviewed.pending" > /dev/null
for clause in RECOVERY_RESTORE RECOVERY_CURRENT_MEMBERSHIP RECOVERY_PRESERVATION RECOVERY_THREADS_FORGOTTEN; do
    grep -F -- "$(printed "${clause}")" "${EVIDENCE}/restoration-reviewed.pending" > /dev/null || fail 'restoration preview omitted a required clause'
done
# A second refused start is the process interruption during repair. It must
# preserve this exact reviewed gesture, prepared input and original-key queue.
refused_recovery_start
shared_recovery_pending "${EVIDENCE}/restoration-request.json" "${EVIDENCE}/restoration-reviewed.pending" > /dev/null
cmp -s "${CONFIG}" "${EVIDENCE}/restoration-prepared-input.json" || fail 'repair replaced separately prepared input'
restoration_pending_preserved second-refusal
cp "${EVIDENCE}/restoration-reviewed.pending" "${CONFIG}.apply"
slack_stub_inventory_fault "${LABEL[p]}" '' hang times=100000
recovery_mark="$(slack_post_mark)"
recovered_class="$(printed SHARED_STATE_RECOVERED)"
recovered_match="$(matcher "${recovered_class}" "${KEY[p]}" 'cause=repair')"
recovered_count="$(count_log "${recovered_match}")"
early_recovery_text="$(printed formatPersonaNotice "${NAME[p]}" buildSharedStateRecoveredNotice "$(persona_ref "${NAME[p]}")" "${restore_scope}" repair)"
start_server --live
wait_membership_complete "${KEY[q]}"
wait_until 30 'repair activation did not reach controlled membership gap' has_record_after "${recovery_mark}" fault "label=${LABEL[p]}" method=users.conversations outcome=hang
expect_count "${recovered_match}" "${recovered_count}" 'repair reported recovery before current membership was trustworthy'
record_after "${recovery_mark}" api method=chat.postMessage answer=ok | jq -e --arg expected "${early_recovery_text}" \
    'all(.[]; .text!=$expected)' > /dev/null || fail 'repair posted recovery before current membership'
stamp_now="$(stamp p "${B}")" || fail 'stamp reader failed'
[[ "${stamp_now}" != "${restore_stamp}" ]] || fail 'restoration reused the old Thread Hybrid Since'
incarnation_now="$(shared_persona_facts "${KEY[p]}" | jq -er .incarnation)" || fail 'persona facts reader failed'
[[ "${incarnation_now}" == "$(jq -r .incarnation <<< "${restore_facts}")" ]] || fail 'restoration lost the retained incarnation'
choice_is p "${A}" all || fail 'restoration applied the separate pending preference'
# Normal detection can already have reopened the preserved ordinary review.
# Prove that exact pre-repair request is still separately reviewable, retain
# its preview, then explicitly cancel it. The recovery-consumed observer
# requires no active review, so it runs after this deliberate cleanup.
wait_until 30 'restoration lost separately pending operator intent' bun "${PRINTER}" operatorReviewPending \
    "${CONFIG}" "${LAST}" "${CONFIG}.pending" restoration-separate-intent > /dev/null
cp "${CONFIG}.pending" "${EVIDENCE}/restoration-preserved-ordinary.pending"
configuration_request restoration-intent-cancel cancel > /dev/null
shared_recovery_consumed "${EVIDENCE}/restoration-request.json" "${EVIDENCE}/restoration-reviewed.pending" > "${EVIDENCE}/restoration-consumed.json"
slack_stub_faults_clear "${LABEL[p]}"
wait_until "${recovery_bound_s}" 'restoration membership did not become trustworthy' _scenario_membership_complete "${KEY[p]}" "$(printed MEMBERSHIP_READINESS_ROUTE)"
recovered_line="$(printed buildSharedStateRecoveredLine "${KEY[p]}" "${restore_scope}" repair "${LAST}")"
recovered_notice="$(printed buildSharedStateRecoveredNotice "$(persona_ref "${NAME[p]}")" "${restore_scope}" repair)"
wait_for_count "${recovered_line}" 1 30 'restoration closing report missing'
slack_wait_successful_post "${LABEL[p]}" "${NOTICE}" "${recovery_mark}" "${recovered_notice}" > "${EVIDENCE}/restoration-recovered-notice.json"
report_post p "${recovery_mark}" restoration-recovered-exact-notice buildSharedStateRecoveredNotice "$(persona_ref "${NAME[p]}")" "${restore_scope}" repair
shared_stub_notice resume "${WORK[p]}" "${KEY[p]}" "${EVIDENCE}/restoration-ended.json" > /dev/null
drain p
restore_queue_parts="$(shared_expected_parts "${restore_queue_text}" "${restore_queue_ts}" "${HUMAN}" "$(scenario_stub_name user "${HUMAN}")" \
    "${A}" "$(scenario_stub_name channel "${A}")" receive_all_shared - -)"
shared_assert_content "${KEY[p]}" "${LOG}" "${SNAP[p]}" "${A}" "${restore_queue_ts}" "${restore_queue_text}" "${restore_queue_parts}" - \
    > "${EVIDENCE}/restoration-resumed-content-receipts.json"
cp "${SNAP[p]}" "${EVIDENCE}/restoration-completed-after-resume.jsonl"
ack "$(slack_stub_redeliver "${LABEL[p]}" "${restore_envelope}")"
ack "$(slack_stub_redeliver "${LABEL[p]}" "${restore_held}")"
queued_n="$(shared_queued_count "${KEY[p]}" "${B}" "${restore_held_ts}")" || fail 'queue reader failed'
[[ "${queued_n}" == 0 ]] || fail 'old joined thread was reused after reviewed repair'
ts="$(scenario_ts)"; text="$(scenario_text after-undecided-intent-crash)"
ack "$(push p "${B}" "${ts}" "${text}" "${undecided_root}")"
queued_n="$(shared_queued_count "${KEY[p]}" "${B}" "${ts}")" || fail 'queue reader failed'
[[ "${queued_n}" == 0 ]] || fail 'unsaved undecided-stamp intent survived the documented crash limit'
[[ "$(record_after "${undecided_mark}" api "label=${LABEL[p]}" method=chat.postMessage "channel=${B}" answer=ok | jq --arg text "${undecided_text}" '[.[]|select(.text==$text)]|length')" == 1 ]] || fail 'undecided-post recovery reposted'
choice_is p "${A}" all || fail 'preserved ordinary intent silently applied'
stop_server
start
compacted_queue p "${EVIDENCE}/restoration-completed-after-resume.jsonl" "${EVIDENCE}/restoration-compacted-after-resume.jsonl"
expect_count "${recovered_line}" 1 'restoration closing report repeated on ordinary restart'

# Phase 29: cold irrecoverable authority needs an explicit replacement. Its
# independently prepared input remains separate. A changed/reverted input
# spends the old confirmation; a later fresh review activates exactly once.
for who in p q; do drain "${who}"; done
cp "${CONFIG}" "${EVIDENCE}/replacement-source.json"
replacement_scope="${restore_scope}"
edit_input '.personas[0].stop_hook_bootstrap=false'
cp "${CONFIG}" "${EVIDENCE}/replacement-prepared.json"
replacement_incarnation="$(shared_persona_facts "${KEY[p]}" | jq -r .incarnation)"
replacement_stamp="$(stamp p "${B}")"
ts="$(scenario_ts)"; text="$(scenario_text before-cold-replacement)"
replacement_envelope="$(push p "${A}" "${ts}" "${text}")"
ack "${replacement_envelope}"
accepted p "${A}" "${ts}" receive_all_shared "${text}"
receipt p
snapshot p
cp "${SNAP[p]}" "${EVIDENCE}/replacement-queue-before.jsonl"
crash
printf '%s\n' 'controlled irrecoverable authority without a running owner' > "${LAST}"
cp "${LAST}" "${EVIDENCE}/replacement-damaged"
configuration_recovery_request "$(scenario_attempt_id cold-replacement)" "${EVIDENCE}/replacement-damaged" \
    "${EVIDENCE}/replacement-request.json" "${EVIDENCE}/replacement-source.json"
refused_recovery_start
shared_recovery_pending "${EVIDENCE}/replacement-request.json" "${CONFIG}.pending" > "${EVIDENCE}/replacement-review.json"
cp "${CONFIG}.pending" "${EVIDENCE}/replacement-stale.pending"
for clause in RECOVERY_LOSS RECOVERY_CURRENT_MEMBERSHIP RECOVERY_PRESERVATION RECOVERY_THREADS_FORGOTTEN; do
    grep -F -- "$(printed "${clause}")" "${EVIDENCE}/replacement-stale.pending" > /dev/null || fail 'replacement preview omitted required lost/new-fact warning'
done
printf '\n' >> "${CONFIG}"
cp "${EVIDENCE}/replacement-stale.pending" "${CONFIG}.apply"
refused_recovery_start
cp "${EVIDENCE}/replacement-prepared.json" "${CONFIG}"
refused_recovery_start
pending_now="$(cat "${CONFIG}.pending")" || fail 'replacement preview missing'
stale_now="$(cat "${EVIDENCE}/replacement-stale.pending")" || fail 'retained stale preview missing'
[[ "${pending_now}" != "${stale_now}" ]] || fail 'replacement ABA reused stale confirmation'
shared_recovery_pending "${EVIDENCE}/replacement-request.json" "${CONFIG}.pending" > /dev/null
cp "${CONFIG}.pending" "${EVIDENCE}/replacement-reviewed.pending"
shared_recovery_pending "${EVIDENCE}/replacement-request.json" "${EVIDENCE}/replacement-reviewed.pending" > /dev/null
refused_recovery_start
shared_recovery_pending "${EVIDENCE}/replacement-request.json" "${EVIDENCE}/replacement-reviewed.pending" > /dev/null
cp "${EVIDENCE}/replacement-reviewed.pending" "${CONFIG}.apply"
slack_stub_inventory_fault "${LABEL[p]}" '' hang times=100000
recovery_mark="$(slack_post_mark)"; recovered_count="$(count_log "${recovered_match}")"
early_recovery_text="$(printed formatPersonaNotice "${NAME[p]}" buildSharedStateRecoveredNotice "$(persona_ref "${NAME[p]}")" "${replacement_scope}" repair)"
start_server --live
wait_membership_complete "${KEY[q]}"
wait_until 30 'replacement did not reach controlled membership gap' has_record_after "${recovery_mark}" fault "label=${LABEL[p]}" method=users.conversations outcome=hang
expect_count "${recovered_match}" "${recovered_count}" 'replacement reported recovery before membership'
record_after "${recovery_mark}" api method=chat.postMessage answer=ok | jq -e --arg expected "${early_recovery_text}" \
    'all(.[]; .text!=$expected)' > /dev/null || fail 'replacement posted recovery before current membership'
cmp -s "${CONFIG}" "${EVIDENCE}/replacement-prepared.json" || fail 'replacement consumed separate prepared edits'
incarnation_now="$(shared_persona_facts "${KEY[p]}" | jq -er .incarnation)" || fail 'persona facts reader failed'
[[ "${incarnation_now}" != "${replacement_incarnation}" ]] || fail 'replacement retained an unrestorable incarnation'
stamp_now="$(stamp p "${B}")" || fail 'stamp reader failed'
[[ "${stamp_now}" != "${replacement_stamp}" ]] || fail 'replacement retained an old Channel Stamp'
joins_now="$(current_joins p "${B}")" || fail 'Thread Memory reader failed'
[[ -z "${joins_now}" ]] || fail 'replacement inherited Joined Threads'
slack_stub_faults_clear "${LABEL[p]}"
wait_until "${recovery_bound_s}" 'replacement membership did not become trustworthy' _scenario_membership_complete "${KEY[p]}" "$(printed MEMBERSHIP_READINESS_ROUTE)"
replacement_facts="$(shared_persona_facts "${KEY[p]}")"
replacement_channels="$(jq -c --arg notice "${NOTICE}" '((.assignments|keys)+(.historicalMembership|keys)+(.leaves|keys)+[$notice])|unique|sort' <<< "${replacement_facts}")"
[[ "${replacement_channels}" == "${restore_channels}" ]] || fail 'replacement scope differs from the retained source/inventory'
recovered_line="$(printed buildSharedStateRecoveredLine "${KEY[p]}" "${replacement_scope}" repair "${LAST}")"
recovered_notice="$(printed buildSharedStateRecoveredNotice "$(persona_ref "${NAME[p]}")" "${replacement_scope}" repair)"
wait_for_count "${recovered_match}" "$((recovered_count + 1))" 30 'replacement closing diagnostic missing'
wait_for_log "${recovered_line}" 30 'replacement closing scope differs from independent facts'
slack_wait_successful_post "${LABEL[p]}" "${NOTICE}" "${recovery_mark}" "${recovered_notice}" > "${EVIDENCE}/replacement-recovered-notice.json"
report_post p "${recovery_mark}" replacement-recovered-exact-notice buildSharedStateRecoveredNotice "$(persona_ref "${NAME[p]}")" "${replacement_scope}" repair
shared_dedupe_preserved "${KEY[p]}" "${EVIDENCE}/replacement-queue-before.jsonl" > /dev/null
ack "$(slack_stub_redeliver "${LABEL[p]}" "${replacement_envelope}")"
configuration_request replacement-prepared-review request > /dev/null
cp "${CONFIG}.pending" "${EVIDENCE}/replacement-preserved-ordinary.pending"
cmp -s "${CONFIG}" "${EVIDENCE}/replacement-prepared.json" || fail 'ordinary review lost the replacement prepared input'
# Retained evidence above proves the pending input survived. Withdraw that
# separate edit explicitly before the no-active-review consumption observer.
cp "${EVIDENCE}/replacement-source.json" "${CONFIG}"
configuration_request replacement-prepared-cancel cancel > /dev/null
shared_recovery_consumed "${EVIDENCE}/replacement-request.json" "${EVIDENCE}/replacement-reviewed.pending" > "${EVIDENCE}/replacement-consumed.json"
stop_server
start
expect_count "${recovered_match}" "$((recovered_count + 1))" 'replacement closing report repeated on restart'

# Exact closure: every accepted original has its independently retained
# content/via and own-session receipt, including evidence before compaction.
for who in p q; do drain "${who}"; done
stop_server --stop-bots
for who in p q; do snapshot "${who}"; done
assert_chunk_posts # No later restart or recovery reposted either chunk.
shared_assert_accounting "${EXPECTED}" "${LOG}" "${KEY[p]}" "${SNAP[p]}" "${KEY[q]}" "${SNAP[q]}" > /dev/null
for identity in "${!INPUTS[@]}"; do
    IFS='|' read -r who channel ts via <<< "${identity}"
    input="${INPUTS[${identity}]}"
    text="$(jq -r .text <<< "${input}")"; root="$(jq -r .root <<< "${input}")"
    channel_name="$(scenario_stub_name channel "${channel}")"
    # src/delivery-intake.ts channelName uses the fixed DM display name.
    [[ "${via}" != dm ]] || channel_name=dm
    parts="$(shared_expected_parts "${text}" "${ts}" "${HUMAN}" "$(scenario_stub_name user "${HUMAN}")" \
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
