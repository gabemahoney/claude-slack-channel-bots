#!/usr/bin/env bash
# Test 29 (b.deo SRI-1401 to SRI-1410): declarative and fungible channel
# modes, end to end against the loopback Slack stub, outside dry run.
#
# A shared-mode scenario (no `-fmk-` in its name; lib/scenario.sh "Two
# modes"), as Tests 10 and 12: its own state directory, port and persona
# names (`<tag>_alpha`, `<tag>_bravo`, built from SCENARIO_TAG), the
# container's HOME, agent-director store and tmux server, no shim and no
# closing assertions. It makes no agent-director call of its own, seeds no
# session and swaps no binary. A live start (`start_server --live`) points the
# server at fixtures/slack-stub-server.ts, started with --record and --control,
# through CSCB_SLACK_API_URL; fixtures/stub-claude.sh is first on PATH as
# `claude`, with a regular-file copy of fixtures/stub-mcp-session.ts beside it
# (SCENARIO_STUB_DIR), and config.json's `mcp_config_path` names an MCP config
# under the scratch root, so each persona's stub opens an MCP session to this
# server. The stub's push control (`slack_stub_push`) sends each event; the
# session's delivery record (`stub_session_deliveries`) shows what reached
# the persona; its tool calls (`stub_session_call`) call set_channel_delivery.
# `health_check_interval` is 0 (no restart chases anything) and `exit_timeout`
# is 5 (stub-claude ignores the `/exit` that `stop --stop-bots` sends).
#
# Phases:
# - Start (SRI-1404): both personas up, each launched `claude` the stub, both
#   MCP sessions registered; a push to an unknown label is refused
#   (`no-open-socket`) with its `push-refused` record line.
# - A, a 0.11.x configuration (SRI-1405, the upgrade path): neither key of this
#   work; config.json equals its copy and the last-applied record; no
#   stored-choice file; no server.log line names the switch's key, fungible
#   mode or a class this work adds. alpha A1 plain is delivered `receive_all`
#   (the first-delivery control); U1, unlisted, one mention as both its
#   events, logs exactly one 0.11.1 `unclaimed-channel` line; A2 plain is a
#   `not-mentioned` drop; A2 and B1 mentions are delivered `mention`; the
#   tool is refused with the declarative text (the first-tool-result control),
#   and nothing is written.
# - Switch on (SRI-1406): the switch and alpha's `invited.permission_prompts`;
#   the pending file carries the switch's line; its confirmation applies it
#   with both sessions kept (no registration or launch line, read after a
#   delivery on each persona's connection, in phase B).
# - B, fungible mode (SRI-1407 steps 1 to 11): the fungible path, both orders
#   of a mention's two events, a broadcast, a private channel, the externally
#   shared, missing and non-boolean flags, a group DM, alpha's own fungible
#   destination, then set_channel_delivery: stored, refused, held by the loop
#   guard, and shared delivery, exactly once to each persona.
# - Restart (SRI-1408): a plain stop (the bots keep running) and a live start;
#   the stored-choice file keeps its bytes; the reconnect's new MCP clients
#   repeat no call (SRI-1403); the stored choice applies again.
# - Switch off (SRI-1409): declarative mode again, sessions kept (read after
#   a delivery on each persona's connection), the stored choice inert and the
#   file unchanged.
# - Closing (SRI-1410): `stop --stop-bots`; the port closed; the Slack stub
#   stopped; no token-like text anywhere; the elapsed time on the PASS line.
#
# Runtime rules (SRI-1401). Every wait polls and returns once its condition
# holds. Nothing waits on a health tick (off), a restart delay, a dedupe
# retention window, a grace period or a launch bound; the only timing the
# server sets on its own is the reload tick (5 s after the previous pass,
# src/reload-timer.ts), and each wait for it is bounded at TICK_WAIT_S or
# APPLY_WAIT_S (20 s). The start and launch waits are bounded generously
# because they wait on processes, not on a timing. Every "no …" or "exactly
# one" check is read after the decision's own line (a drop line, an
# `unclaimed-channel` line, a tool result) or after a later positive control
# on the same connection, never after a quiet period. Every push has its own
# `ts`, but the two events of one mention and the one message pushed to both
# personas.
# Measured runtime: 87 s on the cscb-ci image (the PASS line's elapsed time);
# the target is under about 4 minutes.
#
# Texts. Every text src/ exports comes from fixtures/fmk-texts.ts (the one
# value printer), run in this shell. Texts src/ does not export are fragments,
# each quoted from src/ in the "Expected text" block.
#
# An exit hook (on pass and on failure) kills the personas' tmux sessions and
# removes stub-claude's transcripts, as Test 10's does; the helper's EXIT trap
# stops the server (with --stop-bots) and the stub and removes the scratch
# root.
set -euo pipefail

TEST_NAME="test-29-invited-channels"
# shellcheck source=lib/scenario.sh
source "$(dirname "$0")/lib/scenario.sh"

FIXTURES="$(realpath "$(dirname "$0")")/fixtures"
PRINTER="${FIXTURES}/fmk-texts.ts"

# --- Bounds (seconds) ------------------------------------------------------
STUB_WAIT_S=20      # the Slack stub writing its ready file
START_WAIT_S=150    # a start pass: two bring-ups and two launches (processes, not a timing)
SESSION_WAIT_S=90   # after a start pass: a persona's dialog approval, report-in and MCP session
TICK_WAIT_S=20      # an edit showing up in config.json.pending (the 5 s reload tick)
APPLY_WAIT_S=20     # a confirmation applied (the 5 s reload tick)
EVENT_WAIT_S=15     # a pushed event's decision line or delivery
RECORD_WAIT_S=10    # a line reaching the stub's record

# --- Prerequisites ---------------------------------------------------------
for tool in bun tmux agent-director jq sha256sum realpath python3 cmp; do
    command -v "${tool}" > /dev/null 2>&1 || fail "${tool} not on PATH (base image prerequisite)"
done
for fixture in slack-stub-server.ts stub-claude.sh stub-mcp-session.ts fmk-texts.ts; do
    [[ -f "${FIXTURES}/${fixture}" ]] || fail "fixture ${FIXTURES}/${fixture} missing"
done

# --- Stub `claude` first on PATH, its MCP session client beside it ---------
# SCENARIO_STUB_DIR holds regular-file copies (Bun runs a symlinked client
# from its target's directory, and the client keeps its records beside it).
STUB_BIN="${SCENARIO_ROOT}/bin"
mkdir -p "${STUB_BIN}"
cp "${FIXTURES}/stub-claude.sh" "${STUB_BIN}/claude"
chmod +x "${STUB_BIN}/claude"
cp "${FIXTURES}/stub-mcp-session.ts" "${STUB_BIN}/stub-mcp-session.ts"
[[ -f "${STUB_BIN}/stub-mcp-session.ts" && ! -L "${STUB_BIN}/stub-mcp-session.ts" ]] \
    || fail "the MCP session client copy ${STUB_BIN}/stub-mcp-session.ts is not a regular file"
export PATH="${STUB_BIN}:${PATH}"
[[ "$(command -v claude)" == "${STUB_BIN}/claude" ]] \
    || fail "PATH does not resolve claude to the stub ${STUB_BIN}/claude"
SCENARIO_STUB_DIR="${STUB_BIN}"

# --- Names and IDs ---------------------------------------------------------
CONFIG="${SLACK_STATE_DIR}/config.json"
PENDING="${CONFIG}.pending"
APPLY="${CONFIG}.apply"
LAST="${CONFIG}.last-applied"

ALPHA="${SCENARIO_TAG}_alpha"
BRAVO="${SCENARIO_TAG}_bravo"
ALPHA_KEY="$(persona_key "${ALPHA}")"
BRAVO_KEY="$(persona_key "${BRAVO}")"
ALPHA_REF="$(persona_ref "${ALPHA}")"
BRAVO_REF="$(persona_ref "${BRAVO}")"
# Each persona's index in config.json's `personas` (every configuration here
# keeps the order).
ALPHA_INDEX=0
BRAVO_INDEX=1

# Channel and user IDs: each a valid Slack ID of 1 to 24 characters from
# A-Z0-9 (src/registry.ts ECHOABLE_CHANNEL_RE, SRI-503's echo rule), each
# channel matching src/config.ts CHANNEL_ID_RE.
CH_TAG="${SCENARIO_TAG^^}"
A1="C0${CH_TAG}A1"          # alpha: listed `all`; alpha's fungible destination in fungible mode
A2="C0${CH_TAG}A2"          # alpha: listed `mentions`
B1="C0${CH_TAG}B1"          # bravo: listed `mentions`
F1="C0${CH_TAG}F1"          # public, listed by no persona
F2="G0${CH_TAG}F2"          # private (`group`), listed by no persona
U1="C0${CH_TAG}U1"          # public, listed by no persona (phase A)
X1="C0${CH_TAG}X1"          # externally shared (flag true)
X2="C0${CH_TAG}X2"          # no flag
X3="C0${CH_TAG}X3"          # a flag that is not a boolean
GDM="G0${CH_TAG}GD"         # a group DM (`mpim`)
ALPHA_BOT_USER="U0${CH_TAG}ALPHA"
ALPHA_BOT_ID="B0${CH_TAG}ALPHA"
BRAVO_BOT_USER="U0${CH_TAG}BRAVO"
BRAVO_BOT_ID="B0${CH_TAG}BRAVO"
HUMAN="U0${CH_TAG}HUMAN"    # every event's author
CONTACT="U0${CH_TAG}CONTACT" # bravo's dm.contact
for id in "${A1}" "${A2}" "${B1}" "${F1}" "${F2}" "${U1}" "${X1}" "${X2}" "${X3}" "${GDM}" \
    "${ALPHA_BOT_USER}" "${BRAVO_BOT_USER}" "${HUMAN}" "${CONTACT}"; do
    [[ "${id}" =~ ^[A-Z0-9]{1,24}$ ]] || fail "ID ${id} is not 1 to 24 characters from A-Z0-9"
done

ALPHA_DIR="$(make_workdir alpha)"
BRAVO_DIR="$(make_workdir bravo)"

CREDS_DIR="${SCENARIO_ROOT}/credentials"
mkdir -m 700 "${CREDS_DIR}"
ALPHA_CREDS="${CREDS_DIR}/alpha.json"
BRAVO_CREDS="${CREDS_DIR}/bravo.json"

# The stub's token labels, one per persona, and one no persona's token carries.
ALPHA_LABEL=alpha
BRAVO_LABEL=bravo
UNKNOWN_LABEL="${SCENARIO_TAG}-unknown"

STUB_DIR="${SCENARIO_ROOT}/stub"
mkdir -p "${STUB_DIR}"
STUB_RECORD="${STUB_DIR}/record.jsonl"
STUB_CONTROL="${STUB_DIR}/control.json"
STUB_READY="${STUB_DIR}/ready.json"
STUB_OUT="${STUB_DIR}/stub.out"

MCP_DIR="${SCENARIO_ROOT}/mcp"
mkdir -p "${MCP_DIR}"
MCP_CONFIG="${MCP_DIR}/slack-mcp.json"

# stub-claude's transcripts: ~/.claude/projects/<real working dir with / . _
# as -> (fixtures/stub-claude.sh). Both working dirs are under the scratch
# root, so the names are this run's own.
transcript_dir() {
    printf '%s/.claude/projects/%s\n' "${HOME:?}" "$(realpath "$1" | sed 's#[/._]#-#g')"
}
ROOT_KEY="$(realpath "${SCENARIO_ROOT}" | sed 's#[/._]#-#g')"
ALPHA_TRANSCRIPTS="$(transcript_dir "${ALPHA_DIR}")"
BRAVO_TRANSCRIPTS="$(transcript_dir "${BRAVO_DIR}")"
for dir in "${ALPHA_TRANSCRIPTS}" "${BRAVO_TRANSCRIPTS}"; do
    [[ -n "${ROOT_KEY}" && "$(basename "${dir}")" == "${ROOT_KEY}"-work-* ]] \
        || fail "transcript directory name ${dir} is not under the scratch root's"
done
# The summary line stub-claude writes into every transcript it creates
# (fixtures/stub-claude.sh ensure_transcript).
STUB_SESSION_MARKER='"summary":"stub-claude session"'

# --- Expected text (fragments quoted from src/ and the fixtures) ----------
# A persona line (src/persona-diagnostics.ts formatPersonaDiagnostic) comes
# whole from the printer (persona_line, below). Its head, as a fragment: a
# line of any persona of a class starts `[slack] <class>:`.
# src/persona-routing.ts logDrop, its plain line (no export): a `not-mentioned`
# or `group-dm` drop (src/delivery-decision.ts DeliveryDropReason, a type only).
plain_drop() {
    matcher "[slack] persona $1 dropped message from channel=$2 " ": $3"
}
DROP_NOT_MENTIONED='not-mentioned'
DROP_GROUP_DM='group-dm'
# src/delivery-decision.ts Via (a type only): how a delivered message reached
# its persona, the delivery record's `meta.via`.
VIA_MENTION='mention'
VIA_BROADCAST='broadcast'
VIA_RECEIVE_ALL='receive_all'
VIA_RECEIVE_ALL_SHARED='receive_all_shared'
# src/server.ts handleInitialized: an MCP session registered for a persona.
session_connected() {
    matcher "[slack] Session connected: persona $1"
}
# A launch: src/session-manager.ts spawnForPersona's lines (inline, no export)
# name the persona's ref. The restart work's relaunch line comes from the
# printer (relaunch_head, below).
spawn_lines() {
    matcher "[slack] spawnForPersona: " "$1"
}
# src/session-manager.ts startupSessionManager
STARTUP_COMPLETE="$(completion_match 2)"
ALPHA_START="$(persona_start_match "${ALPHA_INDEX}" "${ALPHA}")"
BRAVO_START="$(persona_start_match "${BRAVO_INDEX}" "${BRAVO}")"
# src/reload-apply.ts renderAppliedLogLine: `[slack] <RELOAD_APPLIED>:`.
# fixtures/slack-stub-server.ts: the refusal of a push to a label with no open
# WebSocket.
NO_OPEN_SOCKET='no-open-socket'
# src/delivery-decision.ts FUNGIBLE_REFUSALS ids, passed to the printer, which
# checks each against the export.
REFUSAL_EXTERNALLY_SHARED='externally-shared'
REFUSAL_FLAG_MISSING='flag-missing'
REFUSAL_FLAG_NOT_BOOLEAN='flag-not-boolean'

# --- Script-local helpers --------------------------------------------------

# printed <entry> [<arg>…]: the printer's value (fixtures/fmk-texts.ts).
# Call it only in a stand-alone assignment: `V="$(printed …)"`.
printed() {
    bun "${PRINTER}" "$@" || fail "fmk-texts: $*"
}

# persona_line <class> <alpha|bravo> <cause>: the persona's line of <class>
# with <cause> (src/persona-diagnostics.ts formatPersonaDiagnostic, from the
# printer), keyed by persona_key. Call it as `printed` is called.
persona_line() {
    case "$2" in
        alpha) printed formatPersonaDiagnostic "$1" "${ALPHA_INDEX}" "${ALPHA}" "${ALPHA_KEY}" "$3" ;;
        bravo) printed formatPersonaDiagnostic "$1" "${BRAVO_INDEX}" "${BRAVO}" "${BRAVO_KEY}" "$3" ;;
        *) fail "persona_line: '$2' is neither alpha nor bravo" ;;
    esac
}

# The server log's mark: its line count now (0 when there is none).
log_mark() {
    if [[ -f "${SLACK_STATE_DIR}/server.log" ]]; then
        wc -l < "${SLACK_STATE_DIR}/server.log"
    else
        echo 0
    fi
}

# count_since <mark> <matcher>: server.log lines after <mark> matching.
count_since() {
    local since="${SCENARIO_ROOT}/server-log-since"
    tail -n "+$(( $1 + 1 ))" "${SLACK_STATE_DIR}/server.log" > "${since}"
    count_in "${since}" "$2"
}

count_since_at_least() {
    (( $(count_since "$1" "$2") >= $3 ))
}

# wait_since <mark> <matcher> <timeout-s> <step>: a matching line after <mark>.
wait_since() {
    wait_until "$3" "$4" count_since_at_least "$1" "$2" 1
}

# expect_since <mark> <matcher> <want> <step>
expect_since() {
    local got
    got="$(count_since "$1" "$2")"
    [[ "${got}" == "$3" ]] \
        || fail "$4: expected $3 server.log line(s) after line $1 matching '$(matcher_text "$2")', found ${got}"
}

# How many lines of server.log and its rotations hold <fixed-string>.
count_server_log() {
    local log total=0 n
    for log in "${SLACK_STATE_DIR}"/server.log*; do
        [[ -f "${log}" ]] || continue
        n="$(count_in "${log}" "$1")"
        total=$(( total + n ))
    done
    echo "${total}"
}

# The stub's record lines whose fields match every <field>=<value> (string
# compare; a JSON true/false reads True/False).
RECORD_QUERY="${SCENARIO_ROOT}/record-query.py"
cat > "${RECORD_QUERY}" << 'EOF'
import json, sys
path, *specs = sys.argv[1:]
checks = [spec.split("=", 1) for spec in specs]
count = 0
try:
    with open(path) as f:
        for line in f:
            try:
                rec = json.loads(line)
            except ValueError:
                continue
            if all(rec.get(k) is not None and str(rec.get(k)) == v for k, v in checks):
                count += 1
except FileNotFoundError:
    pass
print(count)
EOF
rec_count() {
    python3 "${RECORD_QUERY}" "${STUB_RECORD}" "$@"
}
rec_at_least() {
    local min="$1"; shift
    (( $(rec_count "$@") >= min ))
}

# The delivery-record query: lines of a stub MCP session's delivery record
# whose `meta.chat_id` and `meta.ts` are given, and `meta.via` when given.
DELIVERY_QUERY="${SCENARIO_ROOT}/delivery-query.py"
cat > "${DELIVERY_QUERY}" << 'EOF'
import json, sys
path, chat, ts, via = sys.argv[1:5]
count = 0
with open(path) as f:
    for line in f:
        try:
            rec = json.loads(line)
        except ValueError:
            continue
        meta = rec.get("meta") if isinstance(rec, dict) else None
        if not isinstance(meta, dict):
            continue
        if meta.get("chat_id") == chat and meta.get("ts") == ts and (via == "" or meta.get("via") == via):
            count += 1
print(count)
EOF

# The stub MCP session's request and results records, for SRI-1403's checks
# (fixtures/stub-mcp-session.ts, its line formats), each file a path resolved
# once below (REQUESTS_FILE, RESULTS_FILE):
#   ids <requests-file>...               every request ID, one per line
#   skipped <log> <ids-file>             exit 0 once the log holds a skip line for
#                                        every ID of <ids-file>
#   once (<requests-file> <results-file>)...
#                                        exit 0 when every request ID has exactly
#                                        one result line
STUB_RECORDS="${SCENARIO_ROOT}/stub-records.py"
cat > "${STUB_RECORDS}" << 'EOF'
import json, sys

def lines(path):
    try:
        with open(path) as f:
            return [json.loads(line) for line in f if line.strip()]
    except FileNotFoundError:
        return []

cmd, *args = sys.argv[1:]
if cmd == "ids":
    for path in args:
        for req in lines(path):
            print(req["id"])
elif cmd == "skipped":
    log, ids_file = args
    with open(ids_file) as f:
        ids = [line.strip() for line in f if line.strip()]
    try:
        with open(log, errors="replace") as f:
            text = f.read()
    except FileNotFoundError:
        sys.exit(1)
    sys.exit(0 if ids and all(f"request {i} has a result line; not run" in text for i in ids) else 1)
elif cmd == "once":
    if not args or len(args) % 2:
        sys.exit(64)
    bad = 0
    for requests, results in zip(args[0::2], args[1::2]):
        ids = [req["id"] for req in lines(requests)]
        counts = {}
        for res in lines(results):
            counts[res["id"]] = counts.get(res["id"], 0) + 1
        for i in ids:
            if counts.get(i, 0) != 1:
                print(f"  | request {i} of {requests}: {counts.get(i, 0)} result line(s)", file=sys.stderr)
                bad += 1
    sys.exit(1 if bad else 0)
else:
    sys.exit(64)
EOF

# deliveries <dir> <chat-id> <ts> [<via>]: how many deliveries the persona
# working in <dir> received for that message (with that `via`, when given).
deliveries() {
    local snapshot="${SCENARIO_ROOT}/deliveries-snapshot"
    stub_session_deliveries "$1" > "${snapshot}"
    python3 "${DELIVERY_QUERY}" "${snapshot}" "$2" "$3" "${4:-}"
}

delivered() {
    (( $(deliveries "$@") >= 1 ))
}

# wait_delivered <step> <dir> <chat-id> <ts> <via>: the delivery reaches the
# delivery record, with that `via`.
wait_delivered() {
    local step="$1"; shift
    wait_until "${EVENT_WAIT_S}" "${step}: no delivery with via $4 in the delivery record of $1" delivered "$@"
}

# expect_deliveries <step> <want> <dir> <chat-id> <ts> [<via>]
expect_deliveries() {
    local step="$1" want="$2" got; shift 2
    got="$(deliveries "$@")"
    [[ "${got}" == "${want}" ]] || fail "${step}: ${got} deliveries of $2 ts $3${4:+ via $4} in the delivery record of $1, expected ${want}"
}

# The stub MCP session's records of each persona's working directory
# (fixtures/stub-mcp-session.ts "The key"), each path resolved once here, by
# working directory: the harness's own key (lib/scenario.sh
# _scenario_stub_key, the rule stub_session_deliveries and stub_session_call
# use) under the real path of SCENARIO_STUB_DIR (_scenario_stub_dir). Either
# helper prints its FAIL line when it cannot resolve or hash a path. Every
# later read of a record takes these paths.
declare -A DELIVERIES_FILE=() REQUESTS_FILE=() RESULTS_FILE=()
STUB_REAL_DIR="$(_scenario_stub_dir "the stub MCP session's records")" || exit 1
for dir in "${ALPHA_DIR}" "${BRAVO_DIR}"; do
    record_key="$(_scenario_stub_key "the stub MCP session's records of ${dir}" "${dir}")" || exit 1
    DELIVERIES_FILE["${dir}"]="${STUB_REAL_DIR}/${SCENARIO_STUB_DELIVERIES_PREFIX}${record_key}${SCENARIO_STUB_RECORD_SUFFIX}"
    REQUESTS_FILE["${dir}"]="${STUB_REAL_DIR}/${SCENARIO_STUB_REQUESTS_PREFIX}${record_key}${SCENARIO_STUB_RECORD_SUFFIX}"
    RESULTS_FILE["${dir}"]="${STUB_REAL_DIR}/${SCENARIO_STUB_RESULTS_PREFIX}${record_key}${SCENARIO_STUB_RECORD_SUFFIX}"
done

# The push wrapper. Each push gets its own `ts` (new_ts, a counter on the
# script's start time), but the two events of one mention and the one message
# pushed to both personas, which share theirs. PUSH_TS is the push's ts.
TS_BASE="$(date +%s)"
TS_SEQ=0
declare -A PUSHED_TS=()
new_ts() {
    TS_SEQ=$(( TS_SEQ + 1 ))
    printf -v PUSH_TS '%s.%06d' "${TS_BASE}" "${TS_SEQ}"
}

# message_event <channel> <channel_type|""> <text> <ts>
message_event() {
    jq -c -n --arg c "$1" --arg ct "$2" --arg t "$3" --arg ts "$4" --arg u "${HUMAN}" \
        '{type: "message", channel: $c, user: $u, text: $t, ts: $ts} + (if $ct == "" then {} else {channel_type: $ct} end)'
}

# app_mention_event <channel> <text> <ts>: Slack's app_mention, with no channel_type.
app_mention_event() {
    jq -c -n --arg c "$1" --arg t "$2" --arg ts "$3" --arg u "${HUMAN}" \
        '{type: "app_mention", channel: $c, user: $u, text: $t, ts: $ts}'
}

# push_event <label> <event-json> [<flag>]: one push; fails on a refusal.
push_event() {
    local label="$1" ts
    ts="$(jq -r '.ts' <<< "$2")"
    PUSHED_TS["${label} ${ts} $(jq -r '.type' <<< "$2")"]=1
    slack_stub_push "${label}" "$2" "${3:-}" > /dev/null
}

# push_message <label> <channel> <channel_type|""> <text> [<flag>]: a message
# with a ts of its own.
push_message() {
    new_ts
    [[ -z "${PUSHED_TS["$1 ${PUSH_TS} message"]:-}" ]] || fail "push_message: ts ${PUSH_TS} already pushed to $1"
    push_event "$1" "$(message_event "$2" "$3" "$4" "${PUSH_TS}")" "${5:-}"
}

# push_mention <label> <channel> <channel_type|""> <text> <app-first|message-first> [<flag>]:
# one mention as its two events, sharing one ts.
push_mention() {
    local label="$1" channel="$2" type="$3" text="$4" order="$5" flag="${6:-}"
    new_ts
    case "${order}" in
        app-first)
            push_event "${label}" "$(app_mention_event "${channel}" "${text}" "${PUSH_TS}")" "${flag}"
            push_event "${label}" "$(message_event "${channel}" "${type}" "${text}" "${PUSH_TS}")" "${flag}"
            ;;
        message-first)
            push_event "${label}" "$(message_event "${channel}" "${type}" "${text}" "${PUSH_TS}")" "${flag}"
            push_event "${label}" "$(app_mention_event "${channel}" "${text}" "${PUSH_TS}")" "${flag}"
            ;;
        *) fail "push_mention: order '${order}' is neither app-first nor message-first" ;;
    esac
}

# push_both <channel> <channel_type> <text>: one message, one ts, pushed to both personas.
push_both() {
    new_ts
    push_event "${ALPHA_LABEL}" "$(message_event "$1" "$2" "$3" "${PUSH_TS}")"
    push_event "${BRAVO_LABEL}" "$(message_event "$1" "$2" "$3" "${PUSH_TS}")"
}

plain_text() {
    printf '%s plain message %s\n' "${TEST_NAME}" "${TS_SEQ}"
}
mention_text() {
    printf '<@%s> %s mention\n' "$1" "${TEST_NAME}"
}

# The results reader: call_tool <dir> <json-args> calls set_channel_delivery
# over the session of the stub working in <dir> (stub_session_call, bounded
# at 30 s) and reads its result line: CALL_ID, CALL_IS_ERROR (`true` or
# `false`) and CALL_TEXT. A call that ended without a tool result fails.
call_tool() {
    local line
    line="$(stub_session_call "$1" "${SET_TOOL}" "$2")"
    CALL_ID="$(jq -r '.id' <<< "${line}")"
    CALL_IS_ERROR="$(jq -r '.isError' <<< "${line}")"
    CALL_TEXT="$(jq -r '.text' <<< "${line}")"
    if jq -e 'has("error")' <<< "${line}" > /dev/null; then
        fail "call_tool: request ${CALL_ID} in $1 ended without a tool result: $(jq -r '.error' <<< "${line}")"
    fi
}

# expect_tool <step> <dir> <json-args> <want-isError> <want-text>
expect_tool() {
    local step="$1"
    call_tool "$2" "$3"
    [[ "${CALL_IS_ERROR}" == "$4" ]] || fail "${step}: the result's isError is ${CALL_IS_ERROR}, expected $4 (text: ${CALL_TEXT})"
    [[ "${CALL_TEXT}" == "$5" ]] || fail "${step}: the result reads '${CALL_TEXT}', expected '$5'"
}

# A persona's registration and launch lines, as one comparable word: Session
# connected, persona-start, spawnForPersona and relaunch lines.
# launch_counts <ref> <persona-start matcher> <relaunch head>
launch_counts() {
    local ref="$1" start="$2" relaunch="$3"
    printf '%s/%s/%s/%s\n' "$(count_log "$(session_connected "${ref}")")" "$(count_log "${start}")" \
        "$(count_log "$(spawn_lines "${ref}")")" "$(count_log "${relaunch}")"
}

# True when <dir> holds a non-empty transcript.
has_transcript() {
    local f
    for f in "$1"/*.jsonl; do
        [[ -s "${f}" ]] && return 0
    done
    return 1
}

# True when <dir> holds at least one transcript and every one carries
# stub-claude's session marker.
stub_transcripts_only() {
    local dir="$1" f n=0
    for f in "${dir}"/*.jsonl; do
        [[ -f "${f}" ]] || continue
        n=$(( n + 1 ))
        grep -qF -- "${STUB_SESSION_MARKER}" "${f}" || return 1
    done
    (( n > 0 ))
}

# Each persona's tmux session name (src/persona-identity.ts
# personaTmuxSessionName, from the printer).
ALPHA_TMUX="$(printed personaTmuxSessionName "${ALPHA_KEY}")"
BRAVO_TMUX="$(printed personaTmuxSessionName "${BRAVO_KEY}")"

# Exit hook (on pass and on failure, after the trap's stop --stop-bots), as
# Test 10's: kill each persona's tmux session by name, and remove the
# stub-claude transcript dirs. A dir holding anything but stub-claude's
# transcripts is left in place and fails the hook. No agent-director row is
# touched.
cleanup_launches() {
    local session dir rc=0
    for session in "${ALPHA_TMUX}" "${BRAVO_TMUX}"; do
        tmux kill-session -t "=${session}" > /dev/null 2>&1 || true
        if tmux has-session -t "=${session}" > /dev/null 2>&1; then
            echo "  | cleanup: tmux session ${session} is still running" >&2
            rc=1
        fi
    done
    for dir in "${ALPHA_TRANSCRIPTS}" "${BRAVO_TRANSCRIPTS}"; do
        [[ -e "${dir}" ]] || continue
        if stub_transcripts_only "${dir}"; then
            rm -rf -- "${dir}"
        else
            echo "  | cleanup: ${dir} holds no stub-claude transcript or another one; left in place" >&2
            rc=1
        fi
    done
    return "${rc}"
}
on_exit cleanup_launches

# --- Credentials, stub control and MCP config ------------------------------
# write_credentials <path> <suffix>: a fresh fake bot/app pair ending in
# <suffix> (the stub's control maps it to a label), mode 0600. Never printed.
write_credentials() {
    local bot app
    bot="$(fake_token bot "$2")"
    app="$(fake_token app "$2")"
    printf '{"bot_token": "%s", "app_token": "%s"}\n' "${bot}" "${app}" | write_file "$1" 600
    [[ "$(stat -c '%a' "$1")" == "600" ]] || fail "credentials file $1 is not mode 0600"
}
ALPHA_SUFFIX="${SCENARIO_TAG}alpha"
BRAVO_SUFFIX="${SCENARIO_TAG}bravo"
write_credentials "${ALPHA_CREDS}" "${ALPHA_SUFFIX}"
write_credentials "${BRAVO_CREDS}" "${BRAVO_SUFFIX}"

# One label per persona, with the bot identity auth.test answers (so a
# mention names it); any other token is refused.
jq -n --arg asuf "${ALPHA_SUFFIX}" --arg al "${ALPHA_LABEL}" --arg au "${ALPHA_BOT_USER}" --arg ab "${ALPHA_BOT_ID}" \
    --arg bsuf "${BRAVO_SUFFIX}" --arg bl "${BRAVO_LABEL}" --arg bu "${BRAVO_BOT_USER}" --arg bb "${BRAVO_BOT_ID}" \
    '{tokens: [
        {suffix: $asuf, label: $al, auth: "ok", connections: "ok", user_id: $au, bot_id: $ab},
        {suffix: $bsuf, label: $bl, auth: "ok", connections: "ok", user_id: $bu, bot_id: $bb}],
      default: {auth: "invalid_auth", connections: "invalid_auth"}}' | write_file "${STUB_CONTROL}" \
    || fail "could not write the stub's control file ${STUB_CONTROL}"

# The MCP config each persona's stub reads (config.json's mcp_config_path),
# naming this scenario's port, as the package's install writes slack-mcp.json.
jq -n --arg name "${SCENARIO_MCP_SERVER_NAME}" --arg url "http://127.0.0.1:${SCENARIO_PORT}/mcp" \
    '{mcpServers: {($name): {type: "http", url: $url}}}' | write_file "${MCP_CONFIG}"

# --- The Slack stub --------------------------------------------------------
(cd "${STUB_DIR}" && exec bun "${FIXTURES}/slack-stub-server.ts" \
    --record "${STUB_RECORD}" --control "${STUB_CONTROL}" --ready-file "${STUB_READY}") \
    > "${STUB_OUT}" 2>&1 &
STUB_PID=$!
track_pid "${STUB_PID}"

wait_for_file "${STUB_READY}" "${STUB_WAIT_S}" "the Slack stub never wrote its ready file"
STUB_API_URL="$(jq -r '.api_url' "${STUB_READY}")"
[[ "$(jq -r '.pid' "${STUB_READY}")" == "${STUB_PID}" ]] || fail "the stub's ready file names another PID"
[[ "${STUB_API_URL}" =~ ^http://127\.0\.0\.1:[0-9]+/api/$ ]] \
    || fail "the stub's api_url '${STUB_API_URL}' is not http://127.0.0.1:<port>/api/"
# The push control's base URL: the api_url without its /api/ (lib/scenario.sh).
SCENARIO_SLACK_STUB_URL="${STUB_API_URL%/api/}"
export CSCB_SLACK_API_URL="${STUB_API_URL}"
wait_until "${RECORD_WAIT_S}" "the stub never loaded the control file's labels" \
    rec_at_least 1 event=control source=file

# --- Configurations --------------------------------------------------------
# write_persona_config <declarative|fungible|switch-off>:
# - declarative: the 0.11.x shape of SRI-1405 (neither key of this work);
# - fungible: that plus the switch, and alpha's invited.permission_prompts A1
#   (bravo has no `invited`, so its default "dm" applies) (SRI-1406);
# - switch-off: fungible without the switch (SRI-1409).
write_persona_config() {
    local switch='' invited=''
    case "$1" in
        declarative) ;;
        fungible)
            [[ "${SWITCH_KEY:-}" =~ ^[a-z_]+$ ]] \
                || fail "write_persona_config: the switch's key '${SWITCH_KEY:-}' is not printed yet, or not a plain key"
            switch=$'\n  "'"${SWITCH_KEY}"$'": true,'
            invited=$',\n      "invited": { "permission_prompts": "'"${A1}"'" }'
            ;;
        switch-off)
            invited=$',\n      "invited": { "permission_prompts": "'"${A1}"'" }'
            ;;
        *) fail "write_persona_config: unknown shape '$1'" ;;
    esac
    write_config << EOF
{${switch}
  "personas": [
    {
      "name": "${ALPHA}",
      "credentials_file": "${ALPHA_CREDS}",
      "working_directory": "${ALPHA_DIR}",
      "channels": [
        { "id": "${A1}", "delivery": "all" },
        { "id": "${A2}", "delivery": "mentions" }
      ],
      "dm": { "enabled": false },
      "permission_prompts": "${A1}"${invited}
    },
    {
      "name": "${BRAVO}",
      "credentials_file": "${BRAVO_CREDS}",
      "working_directory": "${BRAVO_DIR}",
      "channels": [{ "id": "${B1}", "delivery": "mentions" }],
      "dm": { "enabled": true, "contact": "${CONTACT}" },
      "permission_prompts": "dm"
    }
  ],
  "bind": "127.0.0.1",
  "port": ${SCENARIO_PORT},
  "health_check_interval": 0,
  "exit_timeout": 5,
  "mcp_config_path": "${MCP_CONFIG}"
}
EOF
}

# --- Start (SRI-1401, SRI-1404) --------------------------------------------
write_persona_config declarative
CONFIG_A_COPY="${SCENARIO_ROOT}/config-phase-a.json"
cp -- "${CONFIG}" "${CONFIG_A_COPY}"

start_server --live

# The texts, printed while the start pass brings the personas up.
UNCLAIMED_CHANNEL="$(printed UNCLAIMED_CHANNEL)"
PERSONA_INVITED_CHANNEL="$(printed PERSONA_INVITED_CHANNEL)"
PERSONA_CHANNEL_DELIVERY_SET="$(printed PERSONA_CHANNEL_DELIVERY_SET)"
STORE_CLASSES_TEXT="$(printed CHANNEL_DELIVERY_DIAGNOSTIC_CLASSES)"
mapfile -t STORE_CLASSES <<< "${STORE_CLASSES_TEXT}"
STORE_LOG_PREFIX="$(printed CHANNEL_DELIVERY_LOG_PREFIX)"
SWITCH_KEY="$(printed MODE_SWITCH_SETTING)"
FUNGIBLE="$(printed channelModeOf true)"
DECLARATIVE="$(printed channelModeOf false)"
STORE_FILE="${SLACK_STATE_DIR}/$(printed CHANNEL_DELIVERY_FILE_NAME)"
SET_TOOL="$(printed SET_CHANNEL_DELIVERY_TOOL)"
APPLIED_CLASS="[slack] $(printed RELOAD_APPLIED):"
NO_CHOICE="$(printed NO_STORED_CHOICE)"
SWITCH_ON_LINE="$(printed modeSwitchLine "${FUNGIBLE}" "${ALPHA}" "${BRAVO}")"
SWITCH_OFF_LINE="$(printed modeSwitchLine "${DECLARATIVE}" "${ALPHA}" "${BRAVO}")"
REASON_EXTERNALLY_SHARED="$(printed UNCLAIMED_REASON_EXTERNALLY_SHARED)"
REASON_FLAG_MISSING="$(printed UNCLAIMED_REASON_FLAG_MISSING)"
REASON_FLAG_NOT_BOOLEAN="$(printed UNCLAIMED_REASON_FLAG_NOT_BOOLEAN)"
U1_CAUSE="$(printed unclaimedChannelCause "${U1}")"
F1_CAUSE="$(printed unclaimedChannelCause "${F1}")"
X1_CAUSE="$(printed fungibleUnclaimedChannelCause "${X1}" "${REFUSAL_EXTERNALLY_SHARED}")"
X2_CAUSE="$(printed fungibleUnclaimedChannelCause "${X2}" "${REFUSAL_FLAG_MISSING}")"
X3_CAUSE="$(printed fungibleUnclaimedChannelCause "${X3}" "${REFUSAL_FLAG_NOT_BOOLEAN}")"
for pair in "${X1_CAUSE}|${REASON_EXTERNALLY_SHARED}" "${X2_CAUSE}|${REASON_FLAG_MISSING}" "${X3_CAUSE}|${REASON_FLAG_NOT_BOOLEAN}"; do
    [[ "${pair%%|*}" == *"${pair#*|}"* ]] || fail "fmk-texts: the cause '${pair%%|*}' lacks its reason '${pair#*|}'"
done
F1_HEARD_CAUSE="$(printed invitedChannelCause "${F1}" public mentions)"
F1_HEARD_ALL_CAUSE="$(printed invitedChannelCause "${F1}" public all)"
A1_HEARD_CAUSE="$(printed invitedChannelCause "${A1}" public mentions)"
F2_HEARD_CAUSE="$(printed invitedChannelCause "${F2}" private mentions)"
F1_SET_CAUSE="$(printed channelDeliverySetCause "${F1}" "${NO_CHOICE}" all all)"
F1_SET_AGAIN_CAUSE="$(printed channelDeliverySetCause "${F1}" all all all)"
A1_SET_HELD_CAUSE="$(printed channelDeliverySetCause "${A1}" "${NO_CHOICE}" all mentions)"
U1_UNCLAIMED="$(persona_line "${UNCLAIMED_CHANNEL}" alpha "${U1_CAUSE}")"
F1_UNCLAIMED="$(persona_line "${UNCLAIMED_CHANNEL}" alpha "${F1_CAUSE}")"
X1_UNCLAIMED="$(persona_line "${UNCLAIMED_CHANNEL}" alpha "${X1_CAUSE}")"
X2_UNCLAIMED="$(persona_line "${UNCLAIMED_CHANNEL}" alpha "${X2_CAUSE}")"
X3_UNCLAIMED="$(persona_line "${UNCLAIMED_CHANNEL}" alpha "${X3_CAUSE}")"
ALPHA_HEARS_F1="$(persona_line "${PERSONA_INVITED_CHANNEL}" alpha "${F1_HEARD_CAUSE}")"
ALPHA_HEARS_F1_ALL="$(persona_line "${PERSONA_INVITED_CHANNEL}" alpha "${F1_HEARD_ALL_CAUSE}")"
ALPHA_HEARS_A1="$(persona_line "${PERSONA_INVITED_CHANNEL}" alpha "${A1_HEARD_CAUSE}")"
BRAVO_HEARS_F2="$(persona_line "${PERSONA_INVITED_CHANNEL}" bravo "${F2_HEARD_CAUSE}")"
BRAVO_HEARS_A1="$(persona_line "${PERSONA_INVITED_CHANNEL}" bravo "${A1_HEARD_CAUSE}")"
ALPHA_SET_F1="$(persona_line "${PERSONA_CHANNEL_DELIVERY_SET}" alpha "${F1_SET_CAUSE}")"
ALPHA_SET_F1_AGAIN="$(persona_line "${PERSONA_CHANNEL_DELIVERY_SET}" alpha "${F1_SET_AGAIN_CAUSE}")"
BRAVO_SET_A1="$(persona_line "${PERSONA_CHANNEL_DELIVERY_SET}" bravo "${A1_SET_HELD_CAUSE}")"
BRAVO_SET_F1="$(persona_line "${PERSONA_CHANNEL_DELIVERY_SET}" bravo "${F1_SET_CAUSE}")"
# alpha's persona-invited-channel head, whatever the cause: its line printed
# with a marker cause and cut there.
INVITED_MARKER="${TEST_NAME}-cause-marker"
ALPHA_INVITED_LINE="$(persona_line "${PERSONA_INVITED_CHANNEL}" alpha "${INVITED_MARKER}")"
[[ "${ALPHA_INVITED_LINE}" == *"${INVITED_MARKER}" && -n "${ALPHA_INVITED_LINE%"${INVITED_MARKER}"}" ]] \
    || fail "fmk-texts: formatPersonaDiagnostic does not end in its cause after a head"
ALPHA_INVITED_HEAD="${ALPHA_INVITED_LINE%"${INVITED_MARKER}"}"
ALPHA_DECLARATIVE_REFUSAL="$(printed channelDeliveryDeclarativeRefusal "${ALPHA}" "${ALPHA_KEY}")"
ALPHA_X1_REFUSAL="$(printed channelDeliveryChannelRefusal "${ALPHA}" "${ALPHA_KEY}" "${X1}")"
BAD_DELIVERY='everything'
ALPHA_VALUE_REFUSAL="$(printed channelDeliveryValueRefusal "${ALPHA}" "${ALPHA_KEY}" "${BAD_DELIVERY}")"
[[ "${ALPHA_X1_REFUSAL}" == *"\"${X1}\""* ]] || fail "fmk-texts: the channel refusal does not name ${X1}"
[[ "${ALPHA_VALUE_REFUSAL}" == *"\"${BAD_DELIVERY}\""* ]] || fail "fmk-texts: the value refusal does not name ${BAD_DELIVERY}"
# src/restart.ts relaunchAfterKillLine: the restart work's line before a
# relaunch, whatever its kill. Its fixed head is the text before the cwd:
# printed with a marker cwd and split there.
relaunch_head() {
    local marker="${TEST_NAME}-cwd-marker" line
    line="$(printed relaunchAfterKillLine "$1" "${marker}" RELAUNCH_KILL_NONE)"
    [[ "${line}" == *"${marker}"* && -n "${line%%"${marker}"*}" ]] \
        || fail "fmk-texts: relaunchAfterKillLine for $1 does not hold its cwd after a head"
    printf '%s\n' "${line%%"${marker}"*}"
}
ALPHA_RELAUNCH="$(relaunch_head "${ALPHA_KEY}")"
BRAVO_RELAUNCH="$(relaunch_head "${BRAVO_KEY}")"
RESULT_F1_ALL="$(printed channelDeliverySetResultText "${F1}" all all not-held)"
RESULT_A1_HELD="$(printed channelDeliverySetResultText "${A1}" all mentions held)"
F1_ALL_ARGS="$(jq -c -n --arg c "${F1}" '{channel: $c, delivery: "all"}')"

wait_for_log "${STARTUP_COMPLETE}" "${START_WAIT_S}" "start: the start pass never completed"
expect_completion 2 "start" "0 not brought up"
expect_count "${ALPHA_START}" 1 "start: persona-start lines for ${ALPHA}"
expect_count "${BRAVO_START}" 1 "start: persona-start lines for ${BRAVO}"
for who in "${ALPHA_LABEL}" "${BRAVO_LABEL}"; do
    wait_until "${RECORD_WAIT_S}" "start: no WebSocket opened for ${who}" rec_at_least 1 event=ws-open label="${who}"
done
for ref in "${ALPHA_REF}" "${BRAVO_REF}"; do
    wait_for_log "$(session_connected "${ref}")" "${SESSION_WAIT_S}" "start: persona ${ref}'s MCP session never registered"
done
# The launched `claude` was the stub: each working dir holds stub-claude's
# transcripts only.
for dir in "${ALPHA_TRANSCRIPTS}" "${BRAVO_TRANSCRIPTS}"; do
    wait_until "${SESSION_WAIT_S}" "start: no transcript in ${dir}: the launched claude did not write one" \
        has_transcript "${dir}"
    stub_transcripts_only "${dir}" \
        || fail "start: ${dir} holds no transcript with stub-claude's session marker: the launched claude was not the stub"
done

# Positive control (SRI-1404): a push to a label no persona's token carries is
# refused, and the stub records the refusal.
unknown_event="$(message_event "${A1}" channel "$(plain_text)" "${TS_BASE}.000000")"
reason="$(slack_stub_push --expect-refused "${UNKNOWN_LABEL}" "${unknown_event}")"
[[ "${reason}" == "${NO_OPEN_SOCKET}" ]] \
    || fail "start: the push to unknown label ${UNKNOWN_LABEL} was refused as '${reason}', not ${NO_OPEN_SOCKET}"
wait_until "${RECORD_WAIT_S}" "start: the stub's record holds no push-refused line for ${UNKNOWN_LABEL}" \
    rec_at_least 1 event=push-refused label="${UNKNOWN_LABEL}" reason="${NO_OPEN_SOCKET}"
[[ "$(rec_count event=push label="${UNKNOWN_LABEL}")" == 0 ]] || fail "start: the stub sent a push to ${UNKNOWN_LABEL}"

# --- Phase A: a 0.11.x configuration (SRI-1405) ----------------------------
# check_upgrade_log <step>: no server.log line names the switch's key,
# fungible mode, or a class or line this work adds.
check_upgrade_log() {
    local term
    for term in "${SWITCH_KEY}" "${FUNGIBLE}" "${PERSONA_INVITED_CHANNEL}" "${PERSONA_CHANNEL_DELIVERY_SET}" \
        "${STORE_CLASSES[@]}" "${STORE_LOG_PREFIX}"; do
        [[ -n "${term}" ]] || fail "$1: an empty term from the printer"
        [[ "$(count_server_log "${term}")" == 0 ]] || fail "$1: server.log names '${term}' in declarative mode"
    done
}

cmp -s -- "${CONFIG}" "${CONFIG_A_COPY}" || fail "phase A: config.json is not its copy, byte for byte"
[[ -f "${LAST}" ]] || fail "phase A: config.json.last-applied was not written"
cmp -s -- "${CONFIG}" "${LAST}" || fail "phase A: config.json.last-applied does not hold config.json's bytes"
[[ ! -e "${STORE_FILE}" ]] || fail "phase A: ${STORE_FILE} exists in declarative mode"
check_upgrade_log "phase A after the start"

# alpha A1 plain: delivered `receive_all`, found in the delivery record (the
# first-delivery control, SRI-1404).
push_message "${ALPHA_LABEL}" "${A1}" channel "$(plain_text)"
A_A1_TS="${PUSH_TS}"
wait_delivered "phase A: alpha A1 plain" "${ALPHA_DIR}" "${A1}" "${A_A1_TS}" "${VIA_RECEIVE_ALL}"

# alpha U1, unlisted: one mention as both its events: exactly one 0.11.1
# `unclaimed-channel` line, no delivery.
A_U1_MARK="$(log_mark)"
push_mention "${ALPHA_LABEL}" "${U1}" channel "$(mention_text "${ALPHA_BOT_USER}")" app-first
A_U1_TS="${PUSH_TS}"
wait_since "${A_U1_MARK}" "${U1_UNCLAIMED}" "${EVENT_WAIT_S}" "phase A: alpha U1: no 0.11.1 unclaimed-channel line"
expect_deliveries "phase A: alpha U1" 0 "${ALPHA_DIR}" "${U1}" "${A_U1_TS}"

# alpha A2 plain: a `not-mentioned` drop, no delivery.
A_A2_MARK="$(log_mark)"
push_message "${ALPHA_LABEL}" "${A2}" channel "$(plain_text)"
A_A2_TS="${PUSH_TS}"
wait_since "${A_A2_MARK}" "$(plain_drop "${ALPHA_REF}" "${A2}" "${DROP_NOT_MENTIONED}")" "${EVENT_WAIT_S}" \
    "phase A: alpha A2 plain: no not-mentioned line"
expect_deliveries "phase A: alpha A2 plain" 0 "${ALPHA_DIR}" "${A2}" "${A_A2_TS}"

# alpha A2 mention: delivered `mention`; a later positive control on alpha's
# connection, after which U1's and A1's counts are final.
push_message "${ALPHA_LABEL}" "${A2}" channel "$(mention_text "${ALPHA_BOT_USER}")"
wait_delivered "phase A: alpha A2 mention" "${ALPHA_DIR}" "${A2}" "${PUSH_TS}" "${VIA_MENTION}"
expect_since "${A_U1_MARK}" "${U1_UNCLAIMED}" 1 "phase A: alpha U1's unclaimed-channel lines"
expect_deliveries "phase A: alpha U1, after a later delivery" 0 "${ALPHA_DIR}" "${U1}" "${A_U1_TS}"
expect_deliveries "phase A: alpha A1 plain" 1 "${ALPHA_DIR}" "${A1}" "${A_A1_TS}"

# bravo B1 mention: delivered `mention`.
push_message "${BRAVO_LABEL}" "${B1}" channel "$(mention_text "${BRAVO_BOT_USER}")"
wait_delivered "phase A: bravo B1 mention" "${BRAVO_DIR}" "${B1}" "${PUSH_TS}" "${VIA_MENTION}"

# alpha calls the tool for A1 with `all`: refused with the declarative text,
# found in the results record with isError set (the first-tool-result
# control, SRI-1404); nothing written.
expect_tool "phase A: alpha's set_channel_delivery A1 all" "${ALPHA_DIR}" \
    "$(jq -c -n --arg c "${A1}" '{channel: $c, delivery: "all"}')" true "${ALPHA_DECLARATIVE_REFUSAL}"
[[ ! -e "${STORE_FILE}" ]] || fail "phase A: the refused call created ${STORE_FILE}"
cmp -s -- "${CONFIG}" "${CONFIG_A_COPY}" || fail "phase A: config.json changed after the refused call"
check_upgrade_log "phase A after its last control"

# --- The mode switch (SRI-1406, SRI-1409) -----------------------------------
# confirm_switch <fungible|switch-off> <switch-line> <step>: note each
# persona's registration and launch lines (launch_counts), write the
# configuration of that shape, wait for the pending file to carry the
# switch's line, confirm it and wait for its applied line; config.json's
# last-applied record then holds its bytes.
confirm_switch() {
    local shape="$1" line="$2" step="$3" applied_before
    ALPHA_LAUNCHES="$(launch_counts "${ALPHA_REF}" "${ALPHA_START}" "${ALPHA_RELAUNCH}")"
    BRAVO_LAUNCHES="$(launch_counts "${BRAVO_REF}" "${BRAVO_START}" "${BRAVO_RELAUNCH}")"
    applied_before="$(count_log "${APPLIED_CLASS}")"
    write_persona_config "${shape}"
    wait_for_file "${PENDING}" "${TICK_WAIT_S}" "${step}: config.json.pending never appeared"
    wait_until 10 "${step}: the pending file never carried the switch's line" pending_has_line "${line}"
    check_pending_layout "${step}"
    mv -f -- "${PENDING}" "${APPLY}"
    wait_for_count "${APPLIED_CLASS}" $(( applied_before + 1 )) "${APPLY_WAIT_S}" "${step}: the confirmation was never applied"
    cmp -s -- "${CONFIG}" "${LAST}" || fail "${step}: config.json.last-applied does not hold config.json's bytes"
}

# expect_sessions_kept <step> <alpha-channel> <alpha-ts> <bravo-channel> <bravo-ts>:
# the switch kept both sessions: no registration and no launch line for
# either persona since confirm_switch noted them. Read after a delivery on
# each persona's connection made since the confirmation (the message given
# for each), which this checks is in that persona's delivery record.
expect_sessions_kept() {
    local step="$1"
    delivered "${ALPHA_DIR}" "$2" "$3" || fail "${step}: no delivery of $2 ts $3 to ${ALPHA}, the positive control"
    delivered "${BRAVO_DIR}" "$4" "$5" || fail "${step}: no delivery of $4 ts $5 to ${BRAVO}, the positive control"
    [[ "$(launch_counts "${ALPHA_REF}" "${ALPHA_START}" "${ALPHA_RELAUNCH}")" == "${ALPHA_LAUNCHES}" ]] \
        || fail "${step}: a session registration or launch line for ${ALPHA} after the confirmation"
    [[ "$(launch_counts "${BRAVO_REF}" "${BRAVO_START}" "${BRAVO_RELAUNCH}")" == "${BRAVO_LAUNCHES}" ]] \
        || fail "${step}: a session registration or launch line for ${BRAVO} after the confirmation"
}

# --- Switch on (SRI-1406) ---------------------------------------------------
confirm_switch fungible "${SWITCH_ON_LINE}" "switch on"

# --- Phase B: fungible mode (SRI-1407) --------------------------------------
# 1. alpha, public F1 (flag false), plain: no delivery, a not-mentioned line,
#    one persona-invited-channel line (alpha, F1, public, mentions).
B1_MARK="$(log_mark)"
push_message "${ALPHA_LABEL}" "${F1}" channel "$(plain_text)" false
B1_TS="${PUSH_TS}"
wait_since "${B1_MARK}" "$(plain_drop "${ALPHA_REF}" "${F1}" "${DROP_NOT_MENTIONED}")" "${EVENT_WAIT_S}" \
    "step 1: no not-mentioned line for alpha F1"
expect_deliveries "step 1: alpha F1 plain" 0 "${ALPHA_DIR}" "${F1}" "${B1_TS}"
expect_since "${B1_MARK}" "${ALPHA_HEARS_F1}" 1 "step 1: alpha's persona-invited-channel lines for F1"

# 2. alpha, F1, a mention as app_mention then message: one delivery with
#    `mention`, no unclaimed-channel line.
B2_MARK="$(log_mark)"
push_mention "${ALPHA_LABEL}" "${F1}" channel "$(mention_text "${ALPHA_BOT_USER}")" app-first
B2_TS="${PUSH_TS}"
wait_delivered "step 2: alpha F1 mention (app_mention first)" "${ALPHA_DIR}" "${F1}" "${B2_TS}" "${VIA_MENTION}"
expect_since "${B2_MARK}" "[slack] ${UNCLAIMED_CHANNEL}:" 0 "step 2: unclaimed-channel lines"

# 3. alpha, F1, a mention as message then app_mention: one delivery with
#    `mention`; then <!here> as a message alone: one delivery with `broadcast`.
B3_MARK="$(log_mark)"
push_mention "${ALPHA_LABEL}" "${F1}" channel "$(mention_text "${ALPHA_BOT_USER}")" message-first
B3_TS="${PUSH_TS}"
wait_delivered "step 3: alpha F1 mention (message first)" "${ALPHA_DIR}" "${F1}" "${B3_TS}" "${VIA_MENTION}"
push_message "${ALPHA_LABEL}" "${F1}" channel "<!here> ${TEST_NAME} broadcast"
B3_HERE_TS="${PUSH_TS}"
wait_delivered "step 3: alpha F1 <!here>" "${ALPHA_DIR}" "${F1}" "${B3_HERE_TS}" "${VIA_BROADCAST}"
# Read after a later delivery on alpha's connection.
expect_deliveries "step 2: alpha F1 mention (app_mention first)" 1 "${ALPHA_DIR}" "${F1}" "${B2_TS}"
expect_deliveries "step 3: alpha F1 mention (message first)" 1 "${ALPHA_DIR}" "${F1}" "${B3_TS}"
expect_since "${B3_MARK}" "[slack] ${UNCLAIMED_CHANNEL}:" 0 "step 3: unclaimed-channel lines"

# 4. bravo, private F2 (`group`, a G… ID), a mention: one delivery with
#    `mention`, one persona-invited-channel line (bravo, F2, private, mentions).
B4_MARK="$(log_mark)"
push_message "${BRAVO_LABEL}" "${F2}" group "$(mention_text "${BRAVO_BOT_USER}")"
B4_TS="${PUSH_TS}"
wait_delivered "step 4: bravo F2 mention" "${BRAVO_DIR}" "${F2}" "${B4_TS}" "${VIA_MENTION}"
expect_since "${B4_MARK}" "${BRAVO_HEARS_F2}" 1 "step 4: bravo's persona-invited-channel lines for F2"
# The switch kept both sessions (SRI-1406), read after alpha's step 3
# broadcast and bravo's step 4 mention, each delivered since the confirmation.
expect_sessions_kept "switch on" "${F1}" "${B3_HERE_TS}" "${F2}" "${B4_TS}"

# 5. alpha, X1 (flag true), X2 (no flag) and X3 (a flag that is not a
#    boolean, beyond SRI-1407's two: SRI-1402's non-boolean form), each
#    a mention: no delivery, one unclaimed-channel line with its reason, no
#    audit line.
b5_refused() {
    local step="$1" channel="$2" flag="$3" line="$4" mark ts
    mark="$(log_mark)"
    push_message "${ALPHA_LABEL}" "${channel}" channel "$(mention_text "${ALPHA_BOT_USER}")" "${flag}"
    ts="${PUSH_TS}"
    wait_since "${mark}" "${line}" "${EVENT_WAIT_S}" "${step}: no unclaimed-channel line with its reason"
    expect_since "${mark}" "${line}" 1 "${step}: unclaimed-channel lines"
    expect_since "${mark}" "[slack] ${UNCLAIMED_CHANNEL}:" 1 "${step}: unclaimed-channel lines of any cause"
    expect_deliveries "${step}" 0 "${ALPHA_DIR}" "${channel}" "${ts}"
    expect_since "${mark}" "[slack] ${PERSONA_INVITED_CHANNEL}:" 0 "${step}: persona-invited-channel lines"
}
b5_refused "step 5: alpha X1, flag true" "${X1}" true "${X1_UNCLAIMED}"
# The broadcast's count is final after a later decision on alpha's connection.
expect_deliveries "step 3: alpha F1 <!here>" 1 "${ALPHA_DIR}" "${F1}" "${B3_HERE_TS}"
b5_refused "step 5: alpha X2, no flag" "${X2}" omit "${X2_UNCLAIMED}"
b5_refused "step 5: alpha X3, a non-boolean flag" "${X3}" '"yes"' "${X3_UNCLAIMED}"

# 6. alpha, a group DM: an app_mention (no channel_type, a G… ID), then its
#    mpim message: no delivery, one group-dm line, no unclaimed-channel line.
B6_MARK="$(log_mark)"
new_ts
B6_TS="${PUSH_TS}"
push_event "${ALPHA_LABEL}" "$(app_mention_event "${GDM}" "$(mention_text "${ALPHA_BOT_USER}")" "${B6_TS}")"
push_event "${ALPHA_LABEL}" "$(message_event "${GDM}" mpim "$(mention_text "${ALPHA_BOT_USER}")" "${B6_TS}")"
wait_since "${B6_MARK}" "$(plain_drop "${ALPHA_REF}" "${GDM}" "${DROP_GROUP_DM}")" "${EVENT_WAIT_S}" \
    "step 6: no group-dm line for alpha's group DM"
expect_since "${B6_MARK}" "$(plain_drop "${ALPHA_REF}" "${GDM}" "${DROP_GROUP_DM}")" 1 "step 6: group-dm lines"
expect_deliveries "step 6: alpha's group DM" 0 "${ALPHA_DIR}" "${GDM}" "${B6_TS}"
expect_since "${B6_MARK}" "[slack] ${UNCLAIMED_CHANNEL}:" 0 "step 6: unclaimed-channel lines"

# 7. alpha, A1 (listed `all`, alpha's own fungible destination, no stored
#    choice), plain: no delivery, a not-mentioned line, one
#    persona-invited-channel line (alpha, A1, public, mentions).
B7_MARK="$(log_mark)"
push_message "${ALPHA_LABEL}" "${A1}" channel "$(plain_text)"
B7_TS="${PUSH_TS}"
wait_since "${B7_MARK}" "$(plain_drop "${ALPHA_REF}" "${A1}" "${DROP_NOT_MENTIONED}")" "${EVENT_WAIT_S}" \
    "step 7: no not-mentioned line for alpha A1"
expect_deliveries "step 7: alpha A1 plain" 0 "${ALPHA_DIR}" "${A1}" "${B7_TS}"
expect_since "${B7_MARK}" "${ALPHA_HEARS_A1}" 1 "step 7: alpha's persona-invited-channel lines for A1"

# 8. alpha stores `all` for F1: accepted, naming F1, the stored `all` and the
#    delivery `all`; one persona-channel-delivery-set line; then alpha, F1,
#    plain: delivered `receive_all`.
B8_MARK="$(log_mark)"
expect_tool "step 8: alpha's set_channel_delivery F1 all" "${ALPHA_DIR}" "${F1_ALL_ARGS}" false "${RESULT_F1_ALL}"
expect_since "${B8_MARK}" "${ALPHA_SET_F1}" 1 "step 8: alpha's persona-channel-delivery-set lines"
[[ -f "${STORE_FILE}" ]] || fail "step 8: the accepted call wrote no ${STORE_FILE}"
push_message "${ALPHA_LABEL}" "${F1}" channel "$(plain_text)"
wait_delivered "step 8: alpha F1 plain" "${ALPHA_DIR}" "${F1}" "${PUSH_TS}" "${VIA_RECEIVE_ALL}"

# 9. alpha's refused calls: X1 with `all` (naming X1), F1 with "everything"
#    (naming the value); neither stores anything.
B9_MARK="$(log_mark)"
expect_tool "step 9: alpha's set_channel_delivery X1 all" "${ALPHA_DIR}" \
    "$(jq -c -n --arg c "${X1}" '{channel: $c, delivery: "all"}')" true "${ALPHA_X1_REFUSAL}"
expect_tool "step 9: alpha's set_channel_delivery F1 ${BAD_DELIVERY}" "${ALPHA_DIR}" \
    "$(jq -c -n --arg c "${F1}" --arg d "${BAD_DELIVERY}" '{channel: $c, delivery: $d}')" true "${ALPHA_VALUE_REFUSAL}"
expect_since "${B9_MARK}" "[slack] ${PERSONA_CHANNEL_DELIVERY_SET}:" 0 "step 9: persona-channel-delivery-set lines"

# 10. bravo and A1, alpha's fungible destination: a mention is delivered (A1
#     joins bravo's heard set); bravo's call for A1 with `all` is accepted but
#     held at `mentions`; bravo, A1, plain: no delivery.
B10_MARK="$(log_mark)"
push_message "${BRAVO_LABEL}" "${A1}" channel "$(mention_text "${BRAVO_BOT_USER}")"
wait_delivered "step 10: bravo A1 mention" "${BRAVO_DIR}" "${A1}" "${PUSH_TS}" "${VIA_MENTION}"
expect_since "${B10_MARK}" "${BRAVO_HEARS_A1}" 1 "step 10: bravo's persona-invited-channel lines for A1"
expect_tool "step 10: bravo's set_channel_delivery A1 all" "${BRAVO_DIR}" \
    "$(jq -c -n --arg c "${A1}" '{channel: $c, delivery: "all"}')" false "${RESULT_A1_HELD}"
expect_since "${B10_MARK}" "${BRAVO_SET_A1}" 1 "step 10: bravo's persona-channel-delivery-set lines for A1"
B10_PLAIN_MARK="$(log_mark)"
push_message "${BRAVO_LABEL}" "${A1}" channel "$(plain_text)"
B10_TS="${PUSH_TS}"
wait_since "${B10_PLAIN_MARK}" "$(plain_drop "${BRAVO_REF}" "${A1}" "${DROP_NOT_MENTIONED}")" "${EVENT_WAIT_S}" \
    "step 10: no not-mentioned line for bravo A1"
expect_deliveries "step 10: bravo A1 plain" 0 "${BRAVO_DIR}" "${A1}" "${B10_TS}"

# 11. bravo and F1, shared delivery: a mention is delivered, bravo stores
#     `all` for F1, then one plain F1 message pushed to both personas is
#     delivered to each with `receive_all_shared`.
B11_MARK="$(log_mark)"
push_message "${BRAVO_LABEL}" "${F1}" channel "$(mention_text "${BRAVO_BOT_USER}")"
wait_delivered "step 11: bravo F1 mention" "${BRAVO_DIR}" "${F1}" "${PUSH_TS}" "${VIA_MENTION}"
expect_tool "step 11: bravo's set_channel_delivery F1 all" "${BRAVO_DIR}" "${F1_ALL_ARGS}" false "${RESULT_F1_ALL}"
expect_since "${B11_MARK}" "${BRAVO_SET_F1}" 1 "step 11: bravo's persona-channel-delivery-set lines for F1"
push_both "${F1}" channel "$(plain_text)"
B11_TS="${PUSH_TS}"
wait_delivered "step 11: alpha F1 plain (shared)" "${ALPHA_DIR}" "${F1}" "${B11_TS}" "${VIA_RECEIVE_ALL_SHARED}"
wait_delivered "step 11: bravo F1 plain (shared)" "${BRAVO_DIR}" "${F1}" "${B11_TS}" "${VIA_RECEIVE_ALL_SHARED}"
# A later delivery on each persona's connection (an F1 mention, `mention`),
# after which the shared message's counts are final: exactly one each.
push_message "${ALPHA_LABEL}" "${F1}" channel "$(mention_text "${ALPHA_BOT_USER}")"
wait_delivered "step 11: alpha F1 mention, after the shared message" "${ALPHA_DIR}" "${F1}" "${PUSH_TS}" "${VIA_MENTION}"
push_message "${BRAVO_LABEL}" "${F1}" channel "$(mention_text "${BRAVO_BOT_USER}")"
wait_delivered "step 11: bravo F1 mention, after the shared message" "${BRAVO_DIR}" "${F1}" "${PUSH_TS}" "${VIA_MENTION}"
expect_deliveries "step 11: alpha F1 plain (shared)" 1 "${ALPHA_DIR}" "${F1}" "${B11_TS}"
expect_deliveries "step 11: bravo F1 plain (shared)" 1 "${BRAVO_DIR}" "${F1}" "${B11_TS}"

# --- Persistence across a restart (SRI-1408, SRI-1403) ----------------------
STORE_BEFORE_RESTART="${SCENARIO_ROOT}/store-before-restart.json"
cp -- "${STORE_FILE}" "${STORE_BEFORE_RESTART}"
declare -A DELIVERIES_BEFORE=()
for dir in "${ALPHA_DIR}" "${BRAVO_DIR}"; do
    DELIVERIES_BEFORE["${dir}"]="${SCENARIO_ROOT}/deliveries-before-restart.$(basename "${dir}")"
    cp -- "${DELIVERIES_FILE[${dir}]}" "${DELIVERIES_BEFORE[${dir}]}"
done
completions_before="$(count_log "${STARTUP_COMPLETE}")"
alpha_connected_before="$(count_log "$(session_connected "${ALPHA_REF}")")"
bravo_connected_before="$(count_log "$(session_connected "${BRAVO_REF}")")"
alpha_sockets_before="$(rec_count event=ws-open label="${ALPHA_LABEL}")"
bravo_sockets_before="$(rec_count event=ws-open label="${BRAVO_LABEL}")"
RESTART_MARK="$(log_mark)"
IDS_BEFORE_RESTART="${SCENARIO_ROOT}/request-ids-before-restart"
python3 "${STUB_RECORDS}" ids "${REQUESTS_FILE[${ALPHA_DIR}]}" "${REQUESTS_FILE[${BRAVO_DIR}]}" \
    > "${IDS_BEFORE_RESTART}" || fail "restart: could not read the request files"
[[ -s "${IDS_BEFORE_RESTART}" ]] || fail "restart: no request was made before the restart"

stop_server
for session in "${ALPHA_TMUX}" "${BRAVO_TMUX}"; do
    tmux has-session -t "=${session}" > /dev/null 2>&1 \
        || fail "restart: the plain stop ended the tmux session ${session}"
done
start_server --live
wait_for_count "${STARTUP_COMPLETE}" $(( completions_before + 1 )) "${START_WAIT_S}" \
    "restart: the restarted server's start pass never completed"
# Both bots kept running: the start pass reconnects each, launching none.
expect_completion 2 "restart" "2 reconnected" "0 not brought up"
wait_for_count "$(session_connected "${ALPHA_REF}")" $(( alpha_connected_before + 1 )) "${SESSION_WAIT_S}" \
    "restart: ${ALPHA}'s MCP session never registered again"
wait_for_count "$(session_connected "${BRAVO_REF}")" $(( bravo_connected_before + 1 )) "${SESSION_WAIT_S}" \
    "restart: ${BRAVO}'s MCP session never registered again"
wait_until "${RECORD_WAIT_S}" "restart: no new WebSocket for ${ALPHA_LABEL}" \
    rec_at_least $(( alpha_sockets_before + 1 )) event=ws-open label="${ALPHA_LABEL}"
wait_until "${RECORD_WAIT_S}" "restart: no new WebSocket for ${BRAVO_LABEL}" \
    rec_at_least $(( bravo_sockets_before + 1 )) event=ws-open label="${BRAVO_LABEL}"
cmp -s -- "${STORE_FILE}" "${STORE_BEFORE_RESTART}" || fail "restart: ${STORE_FILE} changed across the restart"
for dir in "${ALPHA_DIR}" "${BRAVO_DIR}"; do
    cmp -s -n "$(stat -c '%s' "${DELIVERIES_BEFORE[${dir}]}")" -- "${DELIVERIES_BEFORE[${dir}]}" \
        "${DELIVERIES_FILE[${dir}]}" || fail "restart: the delivery record of ${dir} no longer holds its earlier lines"
done

# alpha calls the tool for F1 with `all` before any F1 event: accepted as a
# stored channel, `all` before and after. Its result also shows the new
# client polled the request file.
expect_tool "restart: alpha's set_channel_delivery F1 all" "${ALPHA_DIR}" "${F1_ALL_ARGS}" false "${RESULT_F1_ALL}"
expect_since "${RESTART_MARK}" "${ALPHA_SET_F1_AGAIN}" 1 "restart: alpha's persona-channel-delivery-set lines (all to all)"

# SRI-1403: the reconnect's new clients read each request file from its
# start and skip every request ID already answered, each with its own stderr
# line in stub-mcp-session.log beside the stub (fixtures/stub-mcp-session.ts:
# `request <id> has a result line; not run`), and no request ID made so far
# has more than one result line.
wait_until "${EVENT_WAIT_S}" "restart: the reconnect's new clients did not skip every request made before the restart" \
    python3 "${STUB_RECORDS}" skipped "${STUB_BIN}/stub-mcp-session.log" "${IDS_BEFORE_RESTART}"
python3 "${STUB_RECORDS}" once "${REQUESTS_FILE[${ALPHA_DIR}]}" "${RESULTS_FILE[${ALPHA_DIR}]}" \
    "${REQUESTS_FILE[${BRAVO_DIR}]}" "${RESULTS_FILE[${BRAVO_DIR}]}" \
    || fail "restart: a request ID has no result line, or more than one"

# alpha, F1, plain: delivered `receive_all_shared`; exactly one
# persona-invited-channel line for alpha and F1 in this server run.
push_message "${ALPHA_LABEL}" "${F1}" channel "$(plain_text)"
wait_delivered "restart: alpha F1 plain" "${ALPHA_DIR}" "${F1}" "${PUSH_TS}" "${VIA_RECEIVE_ALL_SHARED}"
expect_since "${RESTART_MARK}" "${ALPHA_HEARS_F1_ALL}" 1 "restart: alpha's persona-invited-channel lines for F1 in this run"
expect_since "${RESTART_MARK}" "$(matcher "${ALPHA_INVITED_HEAD}" " ${F1} ")" 1 \
    "restart: alpha's persona-invited-channel lines naming F1 in this run"

# --- Switch off (SRI-1409) --------------------------------------------------
STORE_BEFORE_OFF="${SCENARIO_ROOT}/store-before-off.json"
cp -- "${STORE_FILE}" "${STORE_BEFORE_OFF}"
confirm_switch switch-off "${SWITCH_OFF_LINE}" "switch off"

# alpha, F1, plain: no delivery, one 0.11.1 unclaimed-channel line.
OFF_MARK="$(log_mark)"
push_message "${ALPHA_LABEL}" "${F1}" channel "$(plain_text)"
OFF_F1_TS="${PUSH_TS}"
wait_since "${OFF_MARK}" "${F1_UNCLAIMED}" "${EVENT_WAIT_S}" "switch off: no 0.11.1 unclaimed-channel line for alpha F1"
expect_since "${OFF_MARK}" "${F1_UNCLAIMED}" 1 "switch off: alpha F1's unclaimed-channel lines"
expect_deliveries "switch off: alpha F1 plain" 0 "${ALPHA_DIR}" "${F1}" "${OFF_F1_TS}"

# alpha, A1, plain: delivered `receive_all`, by its listed entry.
push_message "${ALPHA_LABEL}" "${A1}" channel "$(plain_text)"
OFF_A1_TS="${PUSH_TS}"
wait_delivered "switch off: alpha A1 plain" "${ALPHA_DIR}" "${A1}" "${OFF_A1_TS}" "${VIA_RECEIVE_ALL}"

# bravo, B1, a mention: delivered `mention`, by its listed entry.
push_message "${BRAVO_LABEL}" "${B1}" channel "$(mention_text "${BRAVO_BOT_USER}")"
OFF_B1_TS="${PUSH_TS}"
wait_delivered "switch off: bravo B1 mention" "${BRAVO_DIR}" "${B1}" "${OFF_B1_TS}" "${VIA_MENTION}"
# Both sessions kept, read after the two deliveries above.
expect_sessions_kept "switch off" "${A1}" "${OFF_A1_TS}" "${B1}" "${OFF_B1_TS}"

# alpha's call for F1: refused with the declarative text; the file unchanged.
expect_tool "switch off: alpha's set_channel_delivery F1 all" "${ALPHA_DIR}" "${F1_ALL_ARGS}" true "${ALPHA_DECLARATIVE_REFUSAL}"
cmp -s -- "${STORE_FILE}" "${STORE_BEFORE_OFF}" || fail "switch off: ${STORE_FILE} changed"

# --- Closing (SRI-1410) -----------------------------------------------------
stop_server --stop-bots
port_closed "${SCENARIO_PORT}" || fail "closing: something still answers on 127.0.0.1:${SCENARIO_PORT}"
stop_tracked_pid "${STUB_PID}" 10 "the Slack stub did not exit on SIGTERM"

# The token scan, read once every writer has stopped (the files stay until
# the EXIT trap removes the scratch root). SRI-1410's files: server.log and
# its rotations, the stub's record, the delivery and results records and the
# stored-choice file; and, beside them, the request files, the client's log
# and the stub's output.
leak_files=("${SLACK_STATE_DIR}"/server.log* "${STUB_RECORD}" "${STORE_FILE}")
for dir in "${ALPHA_DIR}" "${BRAVO_DIR}"; do
    leak_files+=("${DELIVERIES_FILE[${dir}]}" "${RESULTS_FILE[${dir}]}" "${REQUESTS_FILE[${dir}]}")
done
for file in "${leak_files[@]}"; do
    [[ -f "${file}" ]] || fail "closing: ${file} is missing"
done
leak_files+=("${STUB_BIN}/stub-mcp-session.log" "${STUB_OUT}")
n="$(count_token_like "${leak_files[@]}")"
[[ "${n}" == 0 ]] || fail "closing: ${n} token-like match(es) in server.log, the stub's record, the stub MCP session's records or ${STORE_FILE}"

# The tmux sessions and stub-claude's transcripts go in the exit hook
# (cleanup_launches), which runs on a failure too.
echo "PASS: ${TEST_NAME} (${SECONDS} s elapsed)"
