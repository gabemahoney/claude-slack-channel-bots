#!/usr/bin/env bash
# Shared-channel recovery on the packed server. Run only through /ci.
# Independent shared-mode scheduling unit; requires only test-1.
# Original phase numbers are retained for the coverage manifest.
# scenario_ts intentionally takes no arguments, including at nested call sites.
# shellcheck disable=SC2119
set -euo pipefail
TEST_NAME="test-65-shared-channel-recovery-membership-memory"
# shellcheck source=lib/scenario.sh
source "$(dirname "$0")/lib/scenario.sh"
# shellcheck source=lib/shared-channel-recovery.sh
source "$(dirname "$0")/lib/shared-channel-recovery.sh"

# Phases 6-11: cursor catch-up, scan faults, connection gaps and Memory Holds.
recovery_start_ordinary
# Old phase 4 supplied this reviewed preference for an absent channel.
review future-preference "${NAME[p]}/${JOIN}/all"
recovery_seed_memory
recovery_membership_budgets

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
memberships() {
    slack_stub_inventory_clear "${LABEL[p]}"
    slack_stub_inventory_page "${LABEL[p]}" '' later "${A}"
    slack_stub_inventory_page "${LABEL[p]}" later '' "${B}" "${NOTICE}" "${UNKNOWN}" "${PRIVATE}/private" "${INVISIBLE}/private" "${EXTERNAL}/public/external"
}
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
report_post p "${post_mark}" memory-unreadable-notice buildThreadMemoryUnreadableNotice "$(persona_ref "${NAME[p]}")" "${B}" "${memory_path}"
held_ts="$(scenario_ts)"; held_text="$(scenario_text memory-held-reply)"
ack "$(push p "${B}" "${held_ts}" "${held_text}" "${root}")"
accepted p "${B}" "${held_ts}" thread "${held_text}" "${root}"
shared_queue_items "${KEY[p]}" | jq -se --arg ts "${held_ts}" --arg root "${root}" \
    'any(.[]; .ts==$ts and .via=="thread" and .hold.on=="memory" and .hold.thread_ts==$root)' > /dev/null \
    || fail 'unreadable reply lacks durable Memory Hold'
for route in mention broadcast dm other-channel other-persona; do
    ts="$(scenario_ts)"; who=p; channel="${B}"
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

recovery_finish 0
