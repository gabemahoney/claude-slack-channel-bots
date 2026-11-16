#!/usr/bin/env bash
# Shared-channel recovery on the packed server. Run only through /ci.
# Independent shared-mode scheduling unit; requires only test-1.
# Original phase numbers are retained for the coverage manifest.
# edit_input receives literal jq programs; jq expands their bound variables.
# shellcheck disable=SC2016
# scenario_ts intentionally takes no arguments, including at nested call sites.
# shellcheck disable=SC2119
set -euo pipefail
TEST_NAME="test-67-shared-channel-recovery-identity-repair"
# shellcheck source=lib/scenario.sh
source "$(dirname "$0")/lib/scenario.sh"
# shellcheck source=lib/shared-channel-recovery.sh
source "$(dirname "$0")/lib/shared-channel-recovery.sh"

# Phases 19-29: multipart posts, identity resets, restoration and replacement.
recovery_start_ordinary
recovery_seed_memory
recovery_membership_budgets
recovery_lookup_budgets
superseded_line="$(printed reviewOutcomeLine superseded)"

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
# The two parts exceed one request line, so the reply's arguments go in a file.
result="$(stub_session_call "${WORK[p]}" reply "$(jq -cn --arg c "${chunk_channel}" --arg t "${chunk_text}" '{chat_id:$c,text:$t}')" arguments-file)"
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
for _copy in first duplicate; do ack "$(slack_push_observed_post "${LABEL[p]}" "${LABEL[p]}" "${chunk_channel}" "${post_seq}")"; done
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
# Recovery request IDs are review IDs (REVIEW_ID_RE): no colon, unlike an attempt ID.
configuration_recovery_request "${TEST_NAME}-owned-restoration" "${EVIDENCE}/restoration-damaged" "${EVIDENCE}/restoration-request.json"
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
configuration_recovery_request "${TEST_NAME}-cold-replacement" "${EVIDENCE}/replacement-damaged" \
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

recovery_finish 0 assert_chunk_posts
