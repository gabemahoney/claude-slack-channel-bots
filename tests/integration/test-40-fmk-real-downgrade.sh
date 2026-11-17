#!/usr/bin/env bash
# / R55, exact safe downgrade order, with Thread Memory (t1.k49.39 SR-9.7,
# SR-10.5, SR-4.4.6): the first phase changes every thread_hybrid channel,
# waits for Thread Memory recovery and restarts once to tidy the queue; the
# earlier release (published 0.18.0) sets aside hold decisions with a log
# line and no alert; upgrading again reports Thread Memory changed while stopped.
set -euo pipefail
TEST_NAME="test-40-fmk-real-downgrade"
source "$(dirname "$0")/lib/scenario.sh"
source "$(dirname "$0")/lib/real-scenario.sh"
PRINTER="${SCENARIO_FIXTURES}/fmk-texts.ts"
EVIDENCE="${SCENARIO_ROOT}/downgrade-evidence"
mkdir -p "${EVIDENCE}"
RECORD_WAIT_S=30
DELIVERY_IDLE_WAIT_S=180
DELIVERY_MAX_WAIT_S=1800
printed() { bun "${PRINTER}" "$@" || fail "printer entry $1 failed"; }
# Explicit stopped fixture transition: retain the current-format authority
# and reviewed inputs separately, and restore those exact bytes after the
# previous-release exercise. This scenario does not claim automatic downgrade.
prepare_stopped_downgrade() {
    [[ -z "$(server_pid)" ]] || fail 'manual downgrade requires a stopped server'
    queue_all_delivered || fail 'manual downgrade requires every received item delivered'
    DOWNGRADE_SNAPSHOT="${SCENARIO_ROOT}/current-format-before-downgrade"
    mkdir "${DOWNGRADE_SNAPSHOT}"
    local name
    for name in config.json config.json.last-applied config.json.request config.json.pending config.json.apply; do
        if [[ -e "${SLACK_STATE_DIR}/${name}" ]]; then
            cp -p -- "${SLACK_STATE_DIR}/${name}" "${DOWNGRADE_SNAPSHOT}/${name}"
            cmp -s -- "${SLACK_STATE_DIR}/${name}" "${DOWNGRADE_SNAPSHOT}/${name}" || fail 'manual downgrade snapshot differs'
        fi
    done
    # The old loader, not an emulated compatibility schema, must accept the
    # preserved 0.18.0 reference before either active file is replaced.
    bun -e 'const m = await import(process.argv[1]); const c = m.loadPersonaConfig(process.argv[2], process.argv[3]); if (c.resume_enabled !== false) process.exit(1)' \
        "${EARLIER_PKG}/src/config.ts" "${OLD_REFERENCE}/config.json" "${HOME}" \
        || fail 'preserved reference is not a valid resume=false baseline for the previous release'
    cmp -s -- "${OLD_REFERENCE}/config.json" "${OLD_REFERENCE}/config.json.last-applied" \
        || fail 'preserved reference applied baseline differs from its config'
    for name in config.json config.json.last-applied; do
        cp -- "${OLD_REFERENCE}/${name}" "${SLACK_STATE_DIR}/${name}"
        cmp -s -- "${OLD_REFERENCE}/${name}" "${SLACK_STATE_DIR}/${name}" || fail 'manual downgrade reference differs'
    done
    for name in config.json.request config.json.pending config.json.apply; do
        if [[ -e "${SLACK_STATE_DIR}/${name}" ]]; then mv -- "${SLACK_STATE_DIR}/${name}" "${DOWNGRADE_SNAPSHOT}/${name}.withheld"; fi
    done
}
restore_stopped_downgrade() {
    [[ -z "$(server_pid)" ]] || fail 'manual restoration requires a stopped server'
    local name
    mkdir "${DOWNGRADE_SNAPSHOT}/old-run"
    for name in config.json config.json.last-applied config.json.request config.json.pending config.json.apply; do
        if [[ -e "${SLACK_STATE_DIR}/${name}" ]]; then mv -- "${SLACK_STATE_DIR}/${name}" "${DOWNGRADE_SNAPSHOT}/old-run/${name}"; fi
        if [[ -e "${DOWNGRADE_SNAPSHOT}/${name}" ]]; then
            cp -p -- "${DOWNGRADE_SNAPSHOT}/${name}" "${SLACK_STATE_DIR}/${name}"
            cmp -s -- "${DOWNGRADE_SNAPSHOT}/${name}" "${SLACK_STATE_DIR}/${name}" || fail 'current-format restoration differs'
        else
            [[ ! -e "${SLACK_STATE_DIR}/${name}" ]] || fail 'restoration invented an input'
        fi
    done
    configuration_applied_is "${SLACK_STATE_DIR}/config.json" "${SLACK_STATE_DIR}/config.json.last-applied" resume_enabled false \
        || fail 'restored current authority lost applied resume=false'
}
# The set-aside source is the persona's own queue journal from before the
# tidying restart: no second real-agent persona, so no extra launches. It
# models an operator who downgrades without the first phase's actions, while
# a reply still waits for its thread decision (Thread Memory unreadable) and a
# hold decision has been made since the queue was last tidied. The real run
# keeps the documented first phase; only the earlier release reads this copy.
# The earlier release continues the copy's sequence numbers, which the tidied
# journal also used after the copy. So the receipt evidence real-scenario.sh
# captures (receipt-history/) keeps only records up to the copy's last
# sequence number; the rest belongs to the set-aside journal and is kept here.
restore_pre_tidy_queue() {
    [[ -z "$(server_pid)" ]] || fail 'pre-tidy queue restoration requires a stopped server'
    mv -- "${QUEUE_JOURNAL}" "${DOWNGRADE_SNAPSHOT}/queue-tidied.jsonl"
    local history="${SLACK_STATE_DIR}/receipt-history/${REAL_KEY}.jsonl"
    if [[ -e "${history}" ]]; then
        mv -- "${history}" "${DOWNGRADE_SNAPSHOT}/receipt-history-tidied.jsonl"
        python3 - "${PRE_TIDY}" "${DOWNGRADE_SNAPSHOT}/receipt-history-tidied.jsonl" > "${history}" <<'PY' \
            || fail 'cannot keep the receipt evidence of the pre-tidy journal'
import json, sys
last = max(json.loads(line)['seq'] for line in open(sys.argv[1]) if line.strip())
for line in open(sys.argv[2]):
    if line.strip() and json.loads(line)['seq'] <= last: print(line, end='')
PY
    fi
    cp -- "${PRE_TIDY}" "${QUEUE_JOURNAL}"
    chmod 600 "${QUEUE_JOURNAL}"
    cmp -s -- "${PRE_TIDY}" "${QUEUE_JOURNAL}" || fail 'pre-tidy queue restoration differs'
}

real_prepare 2.1.280
real_persona downgrade
HUMAN="$(scenario_id U human)"
QUEUE_JOURNAL="${SLACK_STATE_DIR}/queue/${REAL_KEY}.jsonl"
THREAD_JOURNAL="${SLACK_STATE_DIR}/threads/${REAL_KEY}.jsonl"
NOT_SAVED="$(printed THREAD_MEMORY_NOT_SAVED)"
UNREADABLE="$(printed THREAD_MEMORY_UNREADABLE)"
RECOVERED="$(printed THREAD_MEMORY_RECOVERED)"
CHANGED="$(printed THREAD_MEMORY_CHANGED_WHILE_STOPPED)"
REF="$(persona_ref "${REAL_NAME}")"
# Production-format readers over the live journal; none rebuilds a record.
# They follow real_prepare, so tests/reload-fixtures.test.ts can run the
# stopped-transition functions above on their own.
accepted_as() {
    # <ts> <via> <post|memory|-> : one acceptance with that reason and hold.
    shared_queue_items "${REAL_KEY}" | jq -se --arg c "${REAL_CHANNEL}" --arg ts "$1" --arg via "$2" --arg hold "$3" \
        '[.[] | select(.channel == $c and .ts == $ts)] | length == 1 and .[0].via == $via and ((.[0].hold.on // "-") == $hold)' > /dev/null
}
resolution_recorded() {
    # <ts> <released|hold-withdrawn>
    local seq
    seq="$(shared_queue_items "${REAL_KEY}" | jq -se --arg c "${REAL_CHANNEL}" --arg ts "$1" \
        '[.[] | select(.channel == $c and .ts == $ts)] | if length == 1 then .[0].seq else error("no single acceptance") end')" || return 1
    shared_queue_snapshot "${EVIDENCE}/resolution.jsonl" "${REAL_KEY}"
    jq -se --argjson seq "${seq}" --arg kind "$2" 'any(.[]; .kind == $kind and .seq == $seq)' "${EVIDENCE}/resolution.jsonl" > /dev/null
}
delivered_content() {
    # <ts> <text> <via> <root-or-dash>: exact fixed parts and own-session transcript receipt.
    local parts
    shared_queue_snapshot "${EVIDENCE}/content.jsonl" "${REAL_KEY}"
    parts="$(shared_expected_parts "$2" "$1" "${HUMAN}" "$(scenario_stub_name user "${HUMAN}")" \
        "${REAL_CHANNEL}" "$(scenario_stub_name channel "${REAL_CHANNEL}")" "$3" "$4" -)" || return 1
    shared_assert_content "${REAL_KEY}" "${SLACK_STATE_DIR}/server.log" "${EVIDENCE}/content.jsonl" \
        "${REAL_CHANNEL}" "$1" "$2" "${parts}" - > /dev/null 2>&1
}
root_joined() {
    [[ "$(shared_thread_joins "${REAL_KEY}" | jq -s --arg root "$1" '[.[] | select(.root == $root)] | length')" -ge 1 ]]
}
post_fault_fired() {
    [[ "$(slack_stub_records fault "label=${REAL_LABEL}" method=chat.postMessage outcome=lost \
        | jq -s --argjson mark "$1" '[.[] | select(.seq > $mark)] | length')" -ge 1 ]]
}
post_fault() {
    slack_stub_records fault "label=${REAL_LABEL}" method=chat.postMessage outcome=lost \
        | jq -sce --argjson mark "$1" '[.[] | select(.seq > $mark)] | if length == 1 then .[0] else error("ambiguous held post") end'
}
post_fault_settled() { [[ "$(slack_stub_record_count fault-settled "request_id=$1")" -ge 1 ]]; }
no_thread_hybrid_applied() {
    shared_persona_facts "${REAL_KEY}" | jq -e --arg c "${REAL_CHANNEL}" \
        '.assignments[$c].delivery == "all" and ([.assignments[] | select(.delivery == "thread_hybrid")] | length == 0)' > /dev/null
}
# SR-10.5: every not-saved or unreadable report is followed by recovered.
# The episodes are reported once each, so the last of either precedes the last recovery.
memory_match() { matcher "$1: " "persona=${REAL_KEY} "; }
thread_memory_recovered() {
    local unsaved unreadable recovered
    unsaved="$(last_log_line "$(memory_match "${NOT_SAVED}")")"
    unreadable="$(last_log_line "$(memory_match "${UNREADABLE}")")"
    recovered="$(last_log_line "$(memory_match "${RECOVERED}")")"
    [[ -n "${unsaved}${unreadable}" && -n "${recovered}" ]] || return 1
    (( ${unsaved:-0} < recovered && ${unreadable:-0} < recovered ))
}
# <snapshot> [waiting]: every received item delivered (a withdrawn reply is
# not open work); any other full acceptance without every part delivered is
# open work. With `waiting`, a reply still waiting for its thread decision is
# not counted either.
all_delivered_in() {
    python3 - "$@" <<'PY'
import json, sys
rows = [json.loads(line) for line in open(sys.argv[1]) if line.strip()]
decided = {r['seq']: r['kind'] for r in rows if r['kind'] in ('released', 'hold-withdrawn', 'parked')}
for item in rows:
    if item['kind'] != 'accepted' or 'compact' in item or decided.get(item['seq']) == 'hold-withdrawn':
        continue
    if len(sys.argv) > 2 and 'hold' in item and item['seq'] not in decided:
        continue
    fixed = [r for r in rows if r['kind'] == 'fixed' and r['seq'] == item['seq']]
    parts = len(fixed[0]['parts']) if fixed else 0
    done = {r['part'] for r in rows if r['kind'] == 'delivered' and r['seq'] == item['seq']}
    if not parts or not set(range(1, parts + 1)) <= done:
        sys.exit(1)
PY
}
queue_all_delivered() {
    [[ -e "${QUEUE_JOURNAL}" ]] || return 0
    shared_queue_snapshot "${EVIDENCE}/delivered-check.jsonl" "${REAL_KEY}"
    all_delivered_in "${EVIDENCE}/delivered-check.jsonl"
}
# SR-4.4.6 after the start's compaction: resolved holds rewritten as key
# records, their resolution records dropped, no hold/thread_join. The earlier
# release's own parser over the tidied journal checks the record forms.
queue_tidied() {
    shared_queue_snapshot "${EVIDENCE}/queue-tidied.jsonl" "${REAL_KEY}"
    python3 - "${EVIDENCE}/queue-before-tidy.jsonl" "${EVIDENCE}/queue-tidied.jsonl" <<'PY'
import json, sys
before = [json.loads(line) for line in open(sys.argv[1]) if line.strip()]
after = [json.loads(line) for line in open(sys.argv[2]) if line.strip()]
accepted = {r['seq']: r for r in before if r['kind'] == 'accepted' and 'compact' not in r}
withdrawn = {r['seq']: r['at'] for r in before if r['kind'] == 'hold-withdrawn'}
released = {r['seq'] for r in before if r['kind'] == 'released'}
keys = {r['seq']: r for r in after if r['kind'] == 'accepted' and r.get('compact') == 'key'}
if any(r['kind'] in ('released', 'hold-withdrawn', 'parked') for r in after): sys.exit(1)
if any('hold' in r or 'thread_join' in r for r in after): sys.exit(1)
for seq, at in withdrawn.items():
    marker, item = keys.get(seq), accepted[seq]
    if not marker or marker['delivered_at'] != at or marker['key'] != item['key'] or marker['received_at'] != item['received_at']:
        sys.exit(1)
for seq in released:
    marker = keys.get(seq)
    delivered = [r['at'] for r in before if r['kind'] == 'delivered' and r['seq'] == seq]
    if not marker or not delivered or marker['delivered_at'] != max(delivered): sys.exit(1)
PY
}
# Only the waiting reply is open, so neither release delivers an item twice.
copy_pre_tidy() {
    cp -- "${QUEUE_JOURNAL}" "${PRE_TIDY}"
    shared_queue_snapshot "${PRE_TIDY_SNAPSHOT}" "${REAL_KEY}"
    cmp -s -- "${QUEUE_JOURNAL}" "${PRE_TIDY}" && all_delivered_in "${PRE_TIDY_SNAPSHOT}" waiting
}
quarantined() { compgen -G "${QUARANTINE_GLOB}" > /dev/null; }
earlier_rejected_lines() {
    bun -e 'const fs = await import("node:fs"); const m = await import(process.argv[1]); const lines = fs.readFileSync(process.argv[2], "utf8").split("\n"); if (lines.pop() !== "") process.exit(2); lines.forEach((line, i) => { if (!m.parseQueueRecord(line)) console.log(i + 1) })' \
        "${EARLIER_PKG}/src/delivery-queue.ts" "$1"
}
# <out> [--setting <key>=<value>]: the persona's preserved 0.18.0 reference.
write_old_reference() {
    bun --no-install "${SCENARIO_FIXTURES}/shared-channel-upgrade-case.ts" reference-0.18.0 --out "$1" \
        --mode declarative --name "${REAL_NAME}" --credentials-file "${SCENARIO_ROOT}/${REAL_KEY}.credentials.json" \
        --working-directory "${REAL_WORK}" --channel "${REAL_CHANNEL}=all" --dm-enabled --dm-contact "${REAL_USER}" \
        --permission-prompts dm --setting bind=127.0.0.1 --setting "port=${SCENARIO_PORT}" --setting health_check_interval=0 \
        --setting exit_timeout=5 --setting stop_timeout=15 --setting test_mcp_drop_endpoint=true "${@:2}" \
        > "$1.out"
}
# At the stopped transition the reference carries the resume_enabled value
# phase 2 confirmed, read from the current applied record; it differs from
# the kept reference in nothing else. The 0.18.0 loader check then requires
# false, so a run whose phase 2 did not confirm it fails there.
old_reference_with_phase_two() {
    [[ -z "$(server_pid)" ]] || fail 'the downgrade reference is written while stopped'
    local resume
    resume="$(configuration_applied_value "${SLACK_STATE_DIR}/config.json" "${SLACK_STATE_DIR}/config.json.last-applied" resume_enabled)" \
        || fail 'cannot read the applied resume_enabled'
    write_old_reference "${OLD_REFERENCE}" --setting "resume_enabled=${resume}" \
        || fail 'cannot write the downgrade 0.18.0 reference'
    jq -ne --slurpfile kept "${KEPT_REFERENCE}/config.json" --slurpfile old "${OLD_REFERENCE}/config.json" --argjson resume "${resume}" \
        '$old[0].resume_enabled == $resume and ($old[0] | del(.resume_enabled)) == $kept[0]' > /dev/null \
        || fail 'downgrade reference differs from the kept reference beyond resume_enabled'
}
# As the upgrade to this release kept it: no resume_enabled setting.
KEPT_REFERENCE="${SCENARIO_ROOT}/reference-0.18.0-kept"
OLD_REFERENCE="${SCENARIO_ROOT}/reference-0.18.0"
write_old_reference "${KEPT_REFERENCE}" || fail 'cannot write the preserved 0.18.0 reference'
jq -e 'has("resume_enabled") | not' "${KEPT_REFERENCE}/config.json" > /dev/null || fail 'kept 0.18.0 reference sets resume_enabled'
# Its channel is thread_hybrid and its Notice Destination, so the server's
# own notices are own posts there, which give the Post Holds below.
jq -c --arg c "${REAL_CHANNEL}" '.channels = [{id: $c, delivery: "thread_hybrid"}] | .permission_prompts = $c' \
    "${REAL_PERSONAS}" > "${SCENARIO_ROOT}/real-personas.next"
mv "${SCENARIO_ROOT}/real-personas.next" "${REAL_PERSONAS}"
real_write_config
real_start_stub
# The shared stub wrappers (faults, identities) post to the same stub.
slack_stub_controls "${SCENARIO_ROOT}/real-slack-stub/control.json"
start_server --live
real_wait_launch "${REAL_KEY}"
wait_membership_complete "${REAL_KEY}"
[[ "$(shared_channel_saved "${REAL_KEY}" "${REAL_CHANNEL}")" == thread_hybrid ]] || fail 'thread_hybrid channel not applied'

# A Joined Thread: an accepted @mention, delivered to the real agent.
R1="$(scenario_ts)"
R1_TEXT="$(scenario_mention_text "${REAL_BOT_USER_ID}" "$(scenario_text joined-root)")"
slack_wait_one_ack "$(slack_push_message "${REAL_LABEL}" "${REAL_CHANNEL}" "${R1_TEXT}" "${R1}" "${HUMAN}")"
wait_until 30 'mention was not accepted' accepted_as "${R1}" mention -
wait_until 300 'mention was not delivered' delivered_content "${R1}" "${R1_TEXT}" mention -
wait_until 30 'mention did not join its thread' root_joined "${R1}"

# Thread Memory unreadable at start: replies that depend on it are Memory
# Holds. The unreadable report is an own post whose answer the stub holds,
# so a reply under it is a Post Hold, released after THREAD_REPLY_HOLD_MS.
real_wait_idle "${REAL_KEY}"
stop_server
chmod 000 "${THREAD_JOURNAL}"
python3 - "${THREAD_JOURNAL}" <<'PY'
import os,sys
try:
    fd=os.open(sys.argv[1],os.O_RDONLY)
except PermissionError:
    print('probe-read-refused')
else:
    os.close(fd)
    sys.exit('fault ineffective: scenario user can read Thread Memory')
PY
UNREADABLE_MARK="$(slack_post_mark)"
slack_stub_post_lost "${REAL_LABEL}" "${REAL_CHANNEL}" true delay_ms=25000
start_server --live
wait_membership_complete "${REAL_KEY}"
wait_for_count "$(memory_match "${UNREADABLE}")" 1 60 'Thread Memory unreadable was not reported'
wait_until 60 'the unreadable report was not posted' post_fault_fired "${UNREADABLE_MARK}"
FAULT="$(post_fault "${UNREADABLE_MARK}")" || fail 'held own post evidence missing'
NOTICE_ROOT="$(jq -er .response_ts <<< "${FAULT}")"
NOTICE_REQUEST="$(jq -er .request_id <<< "${FAULT}")"
! post_fault_settled "${NOTICE_REQUEST}" || fail 'own post answered before its reply could be held'
Y1="$(scenario_ts)"; Y1_TEXT="$(scenario_text post-hold-released)"
slack_wait_one_ack "$(slack_push_own_reply "${REAL_LABEL}" "${REAL_CHANNEL}" "${NOTICE_ROOT}" "${Y1_TEXT}" "${Y1}")"
wait_until 30 'reply under the unconfirmed own post has no Post Hold' accepted_as "${Y1}" thread post
wait_until 30 'Post Hold was not released' resolution_recorded "${Y1}" released
R2="$(scenario_ts)"; X2="$(scenario_ts)"; X2_TEXT="$(scenario_text memory-hold-withdrawn)"
slack_wait_one_ack "$(slack_push_reply "${REAL_LABEL}" "${REAL_CHANNEL}" "${R2}" "${X2_TEXT}" "${X2}" "${HUMAN}" "${HUMAN}")"
wait_until 30 'reply in an unknown thread has no Memory Hold' accepted_as "${X2}" thread memory
wait_until 300 'released Post Hold was not delivered' delivered_content "${Y1}" "${Y1_TEXT}" thread "${NOTICE_ROOT}"
wait_until 60 'held own post was never answered' post_fault_settled "${NOTICE_REQUEST}"
UNREADABLE_NOTICE="$(printed formatPersonaNotice "${REAL_NAME}" buildThreadMemoryUnreadableNotice "${REF}" "${REAL_CHANNEL}" "${THREAD_JOURNAL}")"
slack_wait_successful_post "${REAL_LABEL}" "${REAL_CHANNEL}" "${UNREADABLE_MARK}" "${UNREADABLE_NOTICE}" > "${EVIDENCE}/unreadable-notice.json"
[[ "$(slack_stub_records api "request_id=${NOTICE_REQUEST}" | jq -sr 'last.text')" == "${UNREADABLE_NOTICE}" ]] \
    || fail 'the held own post was not the unreadable report'
real_wait_idle "${REAL_KEY}"
PRE_TIDY="${EVIDENCE}/queue-pre-tidy.jsonl"
PRE_TIDY_SNAPSHOT="${EVIDENCE}/queue-pre-tidy-snapshot.jsonl"
# A reply reminder may still append; retake the copy until the journal holds still.
wait_until 180 'queue never held still for its pre-tidy copy' copy_pre_tidy
python3 - "${PRE_TIDY}" <<'PY' || fail 'pre-tidy journal lacks a waiting reply or a hold decision'
import json, sys
rows = [json.loads(line) for line in open(sys.argv[1]) if line.strip()]
decided = {r['seq'] for r in rows if r['kind'] in ('released', 'hold-withdrawn', 'parked')}
waiting = [r for r in rows if r['kind'] == 'accepted' and 'hold' in r and r['seq'] not in decided]
sys.exit(0 if decided and waiting else 1)
PY
echo 'recorded: pre-tidy journal holds a waiting reply and a hold decision'
X1="$(scenario_ts)"; X1_TEXT="$(scenario_text memory-hold-released)"
slack_wait_one_ack "$(slack_push_reply "${REAL_LABEL}" "${REAL_CHANNEL}" "${R1}" "${X1_TEXT}" "${X1}" "${HUMAN}" "${HUMAN}")"
wait_until 30 'reply in the Joined Thread has no Memory Hold' accepted_as "${X1}" thread memory
# The first own post once Thread Memory reads (Joins lost or recovered) is
# answered 2.9 s after its request: under THREAD_REPLY_HOLD_MS from any
# later reply, so the reply under another root is withdrawn, not released.
slack_stub_faults_clear "${REAL_LABEL}"
RECOVERY_MARK="$(slack_post_mark)"
slack_stub_post_lost "${REAL_LABEL}" "${REAL_CHANNEL}" true delay_ms=2900
chmod 600 "${THREAD_JOURNAL}"
retry_max_ms="$(printed THREAD_MEMORY_RETRY_MAX_MS)"
wait_until "$(( retry_max_ms / 1000 + 30 ))" 'no own post once Thread Memory was readable' post_fault_fired "${RECOVERY_MARK}"
FAULT="$(post_fault "${RECOVERY_MARK}")" || fail 'held own post evidence missing'
RECOVERY_REQUEST="$(jq -er .request_id <<< "${FAULT}")"
R3="$(scenario_ts)"; Y2="$(scenario_ts)"; Y2_TEXT="$(scenario_text post-hold-withdrawn)"
Y2_ENVELOPE="$(slack_push_reply "${REAL_LABEL}" "${REAL_CHANNEL}" "${R3}" "${Y2_TEXT}" "${Y2}" "${HUMAN}")"
! post_fault_settled "${RECOVERY_REQUEST}" || fail 'own post answered before its reply could be held'
slack_wait_one_ack "${Y2_ENVELOPE}"
wait_until 30 'reply under a pending own channel message has no Post Hold' accepted_as "${Y2}" thread post
wait_until 30 'Post Hold was not withdrawn' resolution_recorded "${Y2}" hold-withdrawn
wait_until 30 'Memory Hold in an unjoined thread was not withdrawn' resolution_recorded "${X2}" hold-withdrawn
wait_until 30 'Memory Hold in the Joined Thread was not released' resolution_recorded "${X1}" released
wait_until 300 'released Memory Hold was not delivered' delivered_content "${X1}" "${X1_TEXT}" thread "${R1}"
RECOVERED_LINE="$(printed buildThreadMemoryRecoveredLine "${REAL_KEY}" "${REAL_CHANNEL}")"
RECOVERED_NOTICE="$(printed formatPersonaNotice "${REAL_NAME}" buildThreadMemoryRecoveredNotice "${REF}" "${REAL_CHANNEL}")"
wait_for_log "${RECOVERED_LINE}" 60 'Thread Memory recovery was not logged'
slack_wait_successful_post "${REAL_LABEL}" "${REAL_CHANNEL}" "${RECOVERY_MARK}" "${RECOVERED_NOTICE}" > "${EVIDENCE}/recovered-notice.json"
expect_count "$(memory_match "${UNREADABLE}")" 1 'unreadable episode reported more than once'
slack_stub_faults_clear "${REAL_LABEL}"
echo 'recorded: Joined Thread, Post Holds and Memory Holds released and withdrawn'

# SR-10.5 first phase, on the current release: every thread_hybrid channel
# changes to another value and is confirmed; every Thread Memory outage report
# is followed by recovered; one restart tidies the queue at start.
jq -c '.channels |= map(if .delivery == "thread_hybrid" then .delivery = "all" else . end)' "${REAL_PERSONAS}" > "${SCENARIO_ROOT}/real-personas.next"
mv "${SCENARIO_ROOT}/real-personas.next" "${REAL_PERSONAS}"
real_write_config
wait_for_file "${SLACK_STATE_DIR}/config.json.pending" 30 'thread_hybrid change preview absent'
mv "${SLACK_STATE_DIR}/config.json.pending" "${SLACK_STATE_DIR}/config.json.apply"
wait_until 30 'thread_hybrid change was not applied' no_thread_hybrid_applied
echo 'recorded: R55 step 1 every thread_hybrid channel changed and confirmed'
wait_until 120 'a Thread Memory outage report was not followed by recovered' thread_memory_recovered
echo 'recorded: R55 step 1 every Thread Memory outage report followed by recovered'
real_wait_idle "${REAL_KEY}"
shared_queue_snapshot "${EVIDENCE}/queue-before-tidy.jsonl" "${REAL_KEY}"
jq -se 'any(.[]; .kind == "released") and any(.[]; .kind == "hold-withdrawn")' "${EVIDENCE}/queue-before-tidy.jsonl" > /dev/null \
    || fail 'no resolved holds for the restart to tidy'
stop_server
start_server --live
wait_membership_complete "${REAL_KEY}"
wait_until 30 'restart did not tidy the queue' queue_tidied
echo 'recorded: R55 step 1 restart tidied the queue at start'
wait_until 180 'received items were not all delivered' queue_all_delivered
queue_all_delivered || fail 'downgrade requires every received item delivered'
echo 'recorded: R55 step 1 every received item delivered'
real_write_config '{"resume_enabled":false}'
jq 'del(.test_mcp_drop_endpoint)' "${SLACK_STATE_DIR}/config.json" | write_config
wait_for_file "${SLACK_STATE_DIR}/config.json.pending" 30 'resume=false preview absent'
mv "${SLACK_STATE_DIR}/config.json.pending" "${SLACK_STATE_DIR}/config.json.apply"
wait_until 30 'resume=false was not confirmed' configuration_applied_is "${SLACK_STATE_DIR}/config.json" "${SLACK_STATE_DIR}/config.json.last-applied" resume_enabled false
configuration_record_matches "${SLACK_STATE_DIR}/config.json" "${SLACK_STATE_DIR}/config.json.last-applied" applied \
    || fail 'disable-resume confirmation did not preserve reviewed bytes and applied configuration'
echo 'recorded: R55 step 2 resume_enabled=false confirmed'
stop_server --stop-bots
PREVIOUS="/opt/claude-slack-channel-bots-0.18.0/claude-slack-channel-bots-0.18.0.tgz"
[[ -f "${PREVIOUS}" ]] || fail 'previous release tarball missing'
INSTALL="${SCENARIO_ROOT}/downgrade-install"
mkdir -p "${INSTALL}"
printf '{"private":true,"dependencies":{"claude-slack-channel-bots":"file:%s"}}\n' "${PREVIOUS}" > "${INSTALL}/package.json"
(cd "${INSTALL}" && bun install --ignore-scripts > "${SCENARIO_ROOT}/downgrade-install.log" 2>&1)
EARLIER_PKG="${INSTALL}/node_modules/claude-slack-channel-bots"
old_reference_with_phase_two
prepare_stopped_downgrade
# The earlier release's own parser, standing in for main's, takes every tidied record.
earlier_rejected_lines "${QUEUE_JOURNAL}" > "${EVIDENCE}/tidied-rejected-lines" || fail 'earlier queue reader failed'
[[ ! -s "${EVIDENCE}/tidied-rejected-lines" ]] || fail 'earlier release cannot read a tidied queue record'
restore_pre_tidy_queue
earlier_rejected_lines "${PRE_TIDY}" > "${EVIDENCE}/set-aside-lines" || fail 'earlier queue reader failed'
python3 - "${PRE_TIDY}" > "${EVIDENCE}/decision-lines" <<'PY'
import json, sys
for number, line in enumerate(open(sys.argv[1], 'rb').read().split(b'\n')[:-1], 1):
    if json.loads(line)['kind'] in ('released', 'hold-withdrawn', 'parked'): print(number)
PY
[[ -s "${EVIDENCE}/set-aside-lines" ]] || fail 'earlier release would set no record aside'
cmp -s "${EVIDENCE}/set-aside-lines" "${EVIDENCE}/decision-lines" || fail 'earlier release would set aside other than the hold decisions'
mapfile -t SET_ASIDE < "${EVIDENCE}/set-aside-lines"
SEAL="${SLACK_STATE_DIR}/$(printed THREAD_MEMORY_SEAL_FILE)"
sha256sum "${THREAD_JOURNAL}" "${SEAL}" > "${EVIDENCE}/thread-memory.sha256"
ls -A "${SLACK_STATE_DIR}/threads" > "${EVIDENCE}/thread-memory-files"
CURRENT_CLI="${SCENARIO_CLI}"
SCENARIO_CLI="${INSTALL}/node_modules/.bin/claude-slack-channel-bots"
OLD_MARK="$(ad_shim_mark)"
EARLIER_MARK="$(slack_post_mark)"
echo 'recorded: R55 step 3 server and bot stopped; prior release installed; native 2.1.280 pin restored'
start_server --live
real_wait_launch "${REAL_KEY}"
# Its actual recorded templates must be its own launch contract (its router
# route), never 0.16.1's development-channels flag; resume=false means no resume.
[[ "$(cscb_ad_count_between "${OLD_MARK}" - resume)" == 0 ]] || fail 'previous release resumed instead of starting fresh'
# Every make-template call since OLD_MARK carries 0.18.0's own buildTemplateParams
# name, relay mode and exact --agent-args words, and no development-channels word.
# Its router route: the first agent args name an MCP config whose servers include
# 0.18.0's own MCP_SERVER_NAME (the name its registry serves and its allow rule uses).
SLACK_STATE_DIR="${SLACK_STATE_DIR}" bun -e '
const fs = await import("node:fs")
const [, log, mark, receipts, configTs, templateTs, config, home] = process.argv
const { readShimLog, shimWords } = await import(receipts)
const { loadPersonaConfig, MCP_SERVER_NAME } = await import(configTs)
const { buildTemplateParams } = await import(templateTs)
const params = buildTemplateParams(loadPersonaConfig(config, home))
const routed = params.agent_args[0] === "--mcp-config" && typeof MCP_SERVER_NAME === "string" && MCP_SERVER_NAME !== ""
  && Object.hasOwn(JSON.parse(fs.readFileSync(params.agent_args[1], "utf8")).mcpServers ?? {}, MCP_SERVER_NAME)
const calls = readShimLog(log).split("\n").slice(Number(mark)).filter(l => l.startsWith("call\t"))
  .map(l => shimWords(l.split("\t").slice(5).join("\t"))).filter(w => w.includes("make-template"))
const only = (w, flag) => w.indexOf(flag) >= 0 && w.indexOf(flag) === w.lastIndexOf(flag) ? w[w.indexOf(flag) + 1] : undefined
const agentArgs = w => w.flatMap((word, i) => word === "--agent-args" ? [w[i + 1]] : [])
const ok = routed && params.name === "slack-channel-bot" && params.relay_mode === "on" && calls.length > 0 && calls.every(w =>
  only(w, "--name") === params.name && only(w, "--relay-mode") === params.relay_mode
  && JSON.stringify(agentArgs(w)) === JSON.stringify(params.agent_args)
  && !w.includes("--dangerously-load-development-channels") && !w.includes("server:slack-channel-router"))
process.exit(ok ? 0 : 1)' \
    "${SCENARIO_AD_SHIM_LOG}" "${OLD_MARK}" "${SCENARIO_FIXTURES}/transcript-receipts.ts" \
    "${EARLIER_PKG}/src/config.ts" "${EARLIER_PKG}/src/agent-director-template.ts" "${SLACK_STATE_DIR}/config.json" "${HOME}" \
    || fail 'prior release template is not its own launch contract'
! grep -Ei 'failed to load config|invalid persona config|load error' "${START_OUT}" || fail 'previous release load error'
echo 'recorded: R55 step 4 prior release started fresh with its router route'
# The earlier release logs each set-aside record and keeps its exact bytes.
QUARANTINE_GLOB="${SLACK_STATE_DIR}/queue/${REAL_KEY}.unreadable-*"
wait_until 30 'earlier release set no record aside' quarantined
mapfile -t QUARANTINES < <(compgen -G "${QUARANTINE_GLOB}")
[[ "${#QUARANTINES[@]}" == 1 && -f "${QUARANTINES[0]}" ]] || fail 'expected one quarantine file'
python3 - "${PRE_TIDY}" "${QUARANTINES[0]}" "${SET_ASIDE[@]}" <<'PY' || fail 'quarantine file differs from the set-aside records'
import sys
lines = open(sys.argv[1], 'rb').read().split(b'\n')
expected = b''.join(lines[int(n) - 1] + b'\n' for n in sys.argv[3:])
sys.exit(0 if open(sys.argv[2], 'rb').read() == expected else 1)
PY
for number in "${SET_ASIDE[@]}"; do
    line="$(printed earlierQueueRecordUnreadableLine "${EARLIER_PKG}" "${REAL_NAME}" "${REAL_KEY}" "${number}" "${QUARANTINES[0]}")"
    wait_for_log "${line}" 30 'earlier release did not log a set-aside record'
    expect_count "${line}" 1 'earlier release logged a set-aside record more than once'
done
# The waiting reply and the decided ones arrive as ordinary messages.
shared_wait_queue_drained "${REAL_KEY}" "${PRE_TIDY_SNAPSHOT}" "${PRE_TIDY_SNAPSHOT}" > /dev/null
real_wait_idle "${REAL_KEY}"
shared_wait_queue_drained "${REAL_KEY}" "${PRE_TIDY_SNAPSHOT}" "${PRE_TIDY_SNAPSHOT}" > /dev/null
EARLIER_NOTICE="$(printed earlierQueueRecordUnreadableNotice "${EARLIER_PKG}" "${REAL_NAME}" "${REAL_KEY}" "${#SET_ASIDE[@]}" "${QUARANTINES[0]}")"
slack_stub_records api "label=${REAL_LABEL}" method=chat.postMessage | jq -se --argjson mark "${EARLIER_MARK}" --arg notice "${EARLIER_NOTICE}" \
    '[.[] | select(.seq > $mark and ((.text // "") | contains(":warning:") or contains($notice)))] | length == 0' > /dev/null \
    || fail 'earlier release posted an alert'
echo 'recorded: earlier release delivered waiting replies, logged each set-aside record and posted no alert'
jq '.resume_enabled = true' "${SLACK_STATE_DIR}/config.json" | write_config
wait_for_file "${SLACK_STATE_DIR}/config.json.pending" 30 'resume=true preview absent'
mv "${SLACK_STATE_DIR}/config.json.pending" "${SLACK_STATE_DIR}/config.json.apply"
# This assertion runs against the installed previous release's raw baseline.
wait_until 30 'resume=true was not confirmed' jq -e '.resume_enabled == true' "${SLACK_STATE_DIR}/config.json.last-applied"
echo 'recorded: R55 resume_enabled=true confirmed'
stop_server --stop-bots
sha256sum -c --quiet "${EVIDENCE}/thread-memory.sha256" || fail 'earlier release changed Thread Memory'
ls -A "${SLACK_STATE_DIR}/threads" | cmp -s - "${EVIDENCE}/thread-memory-files" || fail 'earlier release changed the Thread Memory directory'
restore_stopped_downgrade
# Upgrading again runs the current build: the earlier loader rejects the
# restored current-format authority.
SCENARIO_CLI="${CURRENT_CLI}"
echo 'recorded: exact current-format authority and pending inputs restored while stopped'
# Upgrading again. The first phase changed every thread_hybrid channel, so no
# Joined Thread is kept through the downgrade and the restored authority has
# no thread_hybrid channel. That is why no reply is checked via thread here;
# a kept thread_hybrid channel fails rather than skipping that check.
[[ "$(count_log "$(memory_match "${CHANGED}")")" == 0 ]] || fail 'Thread Memory changed while stopped reported before the upgrade'
UPGRADE_CHANNELS="$(shared_persona_facts "${REAL_KEY}" | jq -r '[.assignments | to_entries[] | select(.value.delivery == "thread_hybrid") | .key] | sort | if length == 0 then "-" else join(",") end')"
[[ "${UPGRADE_CHANNELS}" == - ]] || fail 'a thread_hybrid channel was kept through the downgrade without a via-thread check'
CHANGED_LINE="$(printed buildThreadMemoryChangedWhileStoppedLine "${REAL_KEY}" "${UPGRADE_CHANNELS}" queue-changed changed)"
CHANGED_NOTICE="$(printed formatPersonaNotice "${REAL_NAME}" buildThreadMemoryChangedWhileStoppedNotice "${REF}" "${UPGRADE_CHANNELS}" changed)"
UPGRADE_MARK="$(slack_post_mark)"
start_server --live
real_wait_launch "${REAL_KEY}"
wait_for_log "${CHANGED_LINE}" 60 'Thread Memory changed while stopped was not logged on upgrading again'
RECORD_WAIT_S=60 slack_wait_successful_post "${REAL_LABEL}" "${REAL_CHANNEL}" "${UPGRADE_MARK}" "${CHANGED_NOTICE}" \
    > "${EVIDENCE}/changed-while-stopped-notice.json"
expect_count "$(memory_match "${CHANGED}")" 1 'Thread Memory changed while stopped was not logged once'
echo 'recorded: upgrading again reported Thread Memory changed while stopped once'
# The shared EXIT hook reports launch usage once, after bot teardown.
real_finish "${REAL_KEY}"
echo "PASS: ${TEST_NAME}"
