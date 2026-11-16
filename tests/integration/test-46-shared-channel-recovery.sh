#!/usr/bin/env bash
# Shared-channel recovery on the packed server. Run only through /ci.
# Independent shared-mode scheduling unit; requires only test-1.
# Original phase numbers are retained for the coverage manifest.
# scenario_ts intentionally takes no arguments, including at nested call sites.
# shellcheck disable=SC2119
set -euo pipefail
TEST_NAME="test-46-shared-channel-recovery"
# shellcheck source=lib/scenario.sh
source "$(dirname "$0")/lib/scenario.sh"
# shellcheck source=lib/shared-channel-recovery.sh
source "$(dirname "$0")/lib/shared-channel-recovery.sh"

# Phases 1-5: delayed delivery, durable replay, pending intent and bot attempts.
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
ordinary_receipts

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
# applied projection, never inferred from a quiet interval. The bot write
# superseded the old review, then each restart and the refresh superseded a
# later one, so the review history no longer keeps the old review's outcome:
# that exact copied gesture matches no current review, and production's
# stale-confirmation line refuses and spends it.
cp "${LAST}" "${EVIDENCE}/before-stale"
superseded_line="$(printed reviewOutcomeLine superseded)"
stale_class="$(printed RELOAD_STALE_CONFIRMATION)"
stale_line="$(matcher "[slack] ${stale_class}:" "\"${CONFIG}.apply\"")"
superseded_count="$(count_log "${superseded_line}")"
stale_count="$(count_log "${stale_line}")"
cp "${EVIDENCE}/old-intent.pending" "${CONFIG}.apply"
wait_for_count "${stale_line}" "$((stale_count + 1))" 30 'old intent confirmation not refused as stale'
expect_count "${superseded_line}" "${superseded_count}" 'old intent confirmation still had an outcome'
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
call_ids="$(scenario_attempt_group "${WORK[p]}" "${args}" "${args}" "$(attempt_args "${id}" "${B}" thread_hybrid retry)")"
while IFS= read -r call; do
    result="$(stub_session_result "${WORK[p]}" "${call}")"
    jq -e '(has("error")|not) and .isError==false' <<< "${result}" > /dev/null || fail 'simultaneous call did not settle applied'
done <<< "${call_ids}"
[[ "$(shared_attempt_applications "${KEY[p]}" "${B}")" == "$((before + 1))" ]] || fail 'simultaneous calls applied more than once'
group_order="$(shared_attempt_order "${KEY[p]}" "${B}")"
retry="$(attempt_args "${id}" "${B}" thread_hybrid retry)"
lost="$(scenario_attempt_call "${WORK[p]}" "${retry}" lose)"
old_session="$(jq -er .session_id <<< "${lost}")"
call_ids="$(scenario_attempt_group "${WORK[p]}" "${retry}" "${retry}")"
while IFS= read -r call; do
    result="$(stub_session_result "${WORK[p]}" "${call}")"
    jq -e '.isError==false and (has("error")|not)' <<< "${result}" > /dev/null || fail 'second-session duplicate did not retain historical result'
done <<< "${call_ids}"
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
    local artifact="$1" retained="$2" effective="$3" history="$4" prior stale current call_ids old replacement group expected
    prior="$(stub_session_sessions "${WORK[p]}" | jq -cse '[.[]|select(.event=="connected")]|last')"
    old="$(jq -er .session_id <<< "${prior}")"
    stale="$(jq -c '. + {_stub_session:"stale"}' <<< "${retained}")"
    current="$(jq -c '. + {_stub_session:"replacement"}' <<< "${retained}")"
    printf '%s\n%s\n' "${stale}" "${current}" > "${EVIDENCE}/${artifact}-arguments.jsonl"
    call_ids="$(scenario_attempt_group "${WORK[p]}" "${stale}" "${current}")"
    local calls=()
    mapfile -t calls <<< "${call_ids}"
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

recovery_finish 0
