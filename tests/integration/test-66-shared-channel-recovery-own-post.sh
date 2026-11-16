#!/usr/bin/env bash
# Shared-channel recovery on the packed server. Run only through /ci.
# Independent shared-mode scheduling unit; requires only test-1.
# Original phase numbers are retained for the coverage manifest.
# scenario_ts intentionally takes no arguments, including at nested call sites.
# shellcheck disable=SC2119
set -euo pipefail
TEST_NAME="test-66-shared-channel-recovery-own-post"
# shellcheck source=lib/scenario.sh
source "$(dirname "$0")/lib/scenario.sh"
# shellcheck source=lib/shared-channel-recovery.sh
source "$(dirname "$0")/lib/shared-channel-recovery.sh"

# Phases 12-18: own-post recovery, all-source FIFO and lookup lifecycle.
recovery_start_ordinary
recovery_lookup_budgets

# Phase 12: lost Slack answers and durable own-post recovery. Each operation
# has a new channel, preventing earlier posts from becoming lookup candidates.
# The API fault proves the injection; only the exact observer proves the
# durable unresolved intent. The held HTTP answer and hung history controls
# keep resolution blocked until the verified kill.
for performed in true false; do
    pending_post "recovered-${performed}" "${performed}"
    post_hold "recovered-${performed}"
    released_at_start
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
hold_ts="${OP_REPLY_TS}"
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
for _receipt_number in 1 2 3 4 5 6 7; do
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
    released_at_start
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

recovery_finish 4
