#!/usr/bin/env bash
# Test 29: declarative and fungible channel
# modes, end to end against the loopback Slack stub, outside dry run.
#
# A shared-mode scenario (no `-fmk-` in its name; lib/scenario.sh "Two
# modes"), as Tests 10 and 12: its own state directory, port and persona
# names (`<tag>_alpha`, `<tag>_bravo`, built from SCENARIO_TAG), the
# container's HOME, agent-director store and tmux server, no shim and no
# fmk closing assertions. Registered shared permission/notice helpers bind
# real AD hooks and sessions; no synthetic state or pane parsing is used.
# A live start (`start_server --live`) points the
# server at fixtures/slack-stub-server.ts, started with --record and --control,
# through CSCB_SLACK_API_URL; fixtures/stub-claude.sh is first on PATH as
# `claude`, with a regular-file copy of fixtures/stub-mcp-session.ts beside it
# (SCENARIO_STUB_DIR), and config.json's `mcp_config_path` names an MCP config
# under the scratch root, so each persona's stub opens an MCP session to this
# server. The stub's push control (`slack_stub_push`) sends each event; the
# session's accepted queue record (`stub_session_deliveries`) shows what reached
# the persona; its tool calls (`stub_session_call`) call set_channel_delivery.
# Both health checks and automatic session restarts are disabled. `exit_timeout`
# is 5 (stub-claude ignores the `/exit` that `stop --stop-bots` sends).
#
# Phases:
# - Cold start: alpha's missing working directory prevents its Slack
#   connection and worker launch. A refused push is not accepted ingress.
#   Creating the directory lets the existing retry bring it up automatically;
#   phase A proves subsequent intake and receipt-backed delivery.
# - Start: both personas up, each launched `claude` the stub, both
#   MCP sessions registered; a push to an unknown label is refused
#   (`no-open-socket`) with its `push-refused` record line.
# - A, a 0.11.x configuration (the upgrade path): neither key of this
#   work; config.json equals its copy and the authority's reviewed input;
#   discovery adds strict `off` entries to the applied view, never a legacy
#   store; no server.log line names the switch's key, fungible
#   mode or a class this work adds. alpha A1 plain is delivered `receive_all`
#   (the first-delivery control); U1 is discovered and drops as `off`;
#   U0, absent from both inventories and configurations, one mention as both its
#   events, logs exactly two `channel-ineligible` drops after completed
#   inventories establish absence (drops store no dedupe fact); A2 plain is a
#   `not-mentioned` drop; A2 and B1 mentions are delivered `mention`; the
#   tool is refused with the declarative text (the first-tool-result control),
#   and nothing is written.
# - Threads in strict mode: off/mentions/all leave no Thread Memory; a
#   reviewed configuration enables alpha's T1 and the three value controls.
#   Mentions and Broadcasts join before a following reply; unrelated replies
#   and plain messages stay out. Earlier roots need a fresh mention.
# - Switch on : open mode and explicit F1/F2/U1 choices;
#   the pending file carries the switch's line; its confirmation applies it
#   with both sessions kept (no registration or launch line, read after a
#   delivery on each persona's connection, in phase B).
# - B, fungible mode (steps 1 to 11): the fungible path, both orders
#   of a mention's two events, a broadcast, a private channel, the externally
#   shared, missing and non-boolean flags, a group DM, alpha's own fungible
#   destination, then set_channel_delivery: stored, refused, applied as written
#   in another persona's destination, and shared delivery, exactly once to each persona.
# - Threads in open mode: alpha's strict join and stamp survive the switch;
#   bravo's ordinary channels have no stamp or joins. Tool assignments
#   enable bravo's threads; both mentioned personas join on their connections.
# - In each mode: four-value selection/reason matrix, overlapping rules,
#   duplicate/ignored/live membership and leaves; reply/upload joins, actual
#   permission prompts at off/hybrid and another persona's destination matrix.
#   All registered permission and explicit receipt phases precede notice recovery.
# - Writes: all tool values, same-value order, operator/bot direction changes,
#   omission, explicit off, cancelled/revised intent and stale confirmations.
# - Restart: a plain stop (the bots keep running) and a live start;
#   shared choices, identities and reviewed bytes survive fresh discovery;
#   the reconnect's new MCP clients
# repeat no call; the stored choice applies again.
#   Both personas' joined threads and Channel Stamps survive too.
#   Pending intent stays unapplied until refreshed and confirmed afterward;
#   the complete inventory retains every member and excludes observed leaves.
# - Switch off: declarative mode again, sessions kept (read after
#   a delivery on each persona's connection), shared choices still applied
#   and new tool assignments refused.
#   Joined replies still arrive; a fresh two-persona mention joins in strict.
# - Actual ended-worker Messages waiting notices and same-conversation resume,
#   in strict then open, completing both directed mode cycles. Actual posts
#   independently supply own-join roots and the sibling's echoed input.
# - Refusals and recovery: unknown, externally shared and temporarily unverified
#   MCP targets; a successful inventory response delayed 20 s proves the latter.
#   Ineligible own posts do not join; prior joins work after eligibility returns.
# - Observed leave/restart/mode/rejoin gives fresh defaults and requires fresh
#   joins. A fresh future preference survives old-leave replay and another
#   absence reconciliation, while a never-joined preference also survives.
# - Identity replacement resets copied choices, explicitly retains a reviewed
#   hybrid choice with a fresh stamp, and retires every previous join.
# - Closing: exact accepted/received sets and own-session receipts across
#   compaction, original content/fixed parts for every item, one ACK per handled
#   envelope; `stop --stop-bots`; the port
#   closed; the Slack stub stopped; no token-like text anywhere; elapsed time.
#
# Runtime rules. Every wait polls and returns once its condition
# holds. Nothing waits on a health tick (off), a restart delay, a dedupe
# retention window, a grace period or a launch bound. The server timers it
# waits for are the cold-start directory retry and reload tick (5 s after
# the previous pass, src/reload-timer.ts). Reload waits use TICK_WAIT_S or
# APPLY_WAIT_S (20 s). The start and launch waits are bounded generously
# because they wait on processes, not on a timing. Every "no …" or "exactly
# one" check is read after the decision's own line (a drop line, an
# `unclaimed-channel` line, a tool result) or after a later positive control
# on the same connection, never after a quiet period. Every push has its own
# `ts`, but the two events of one mention and the one message pushed to both
# personas.
# Earlier complete coverage was about 284 s. This expanded scenario's duration
# is unmeasured until parent /ci; its many confirmed reviews add reload ticks.
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
# Functional receipt completion follows the testing guide, not a launch SLA.
DELIVERY_IDLE_WAIT_S=180
DELIVERY_MAX_WAIT_S=1800

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
# A-Z0-9 (src/registry.ts ECHOABLE_CHANNEL_REecho rule), each
# channel matching src/config.ts CHANNEL_ID_RE.
A1="$(scenario_id C a1)"
A2="$(scenario_id C a2)"
B1="$(scenario_id C b1)"
F1="$(scenario_id C f1)"
F2="$(scenario_id G f2)"
U1="$(scenario_id C u1)"
U0="$(scenario_id C u0)"
X1="$(scenario_id C x1)"
X2="$(scenario_id C x2)"
X3="$(scenario_id C x3)"
GDM="$(scenario_id G group-dm)"
DM="$(scenario_id D direct-dm)"
T1="$(scenario_id C threads)"
N1="$(scenario_id C initially-off)"
N2="$(scenario_id C initially-mentions)"
N3="$(scenario_id C initially-all)"
# Separate stable controls keep all four choices present through both cycles.
M_OFF="$(scenario_id C matrix-off)"
M_MENTIONS="$(scenario_id C matrix-mentions)"
M_ALL="$(scenario_id C matrix-all)"
M_HYBRID="$(scenario_id C matrix-hybrid)"
WRITE_CHANNEL="$(scenario_id C write-order)"
FUTURE="$(scenario_id C never-joined)"
EXTERNAL="$(scenario_id C verified-external)"
DEST="$(scenario_id C composed-destination)"
ALPHA_BOT_USER="$(scenario_id U alpha-bot)"
ALPHA_BOT_ID="$(scenario_id B alpha-bot)"
BRAVO_BOT_USER="$(scenario_id U bravo-bot)"
BRAVO_BOT_ID="$(scenario_id B bravo-bot)"
HUMAN="$(scenario_id U human)"
CONTACT="$(scenario_id U contact)"
for id in "${A1}" "${A2}" "${B1}" "${F1}" "${F2}" "${U1}" "${U0}" "${X1}" "${X2}" "${X3}" "${GDM}" "${DM}" \
    "${T1}" "${N1}" "${N2}" "${N3}" \
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
DROP_CHANNEL_OFF='channel-off'
DROP_CHANNEL_INELIGIBLE='channel-ineligible'
DROP_GROUP_DM='group-dm'
# src/delivery-decision.ts Via (a type only): how a delivered message reached
# its persona, the accepted queue record's `meta.via`.
VIA_MENTION='mention'
VIA_BROADCAST='broadcast'
VIA_RECEIVE_ALL='receive_all'
VIA_RECEIVE_ALL_SHARED='receive_all_shared'
VIA_THREAD='thread'
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
# src/reload-apply.ts renderNoopLogLine: `[slack] <RELOAD_NOOP>:`, which the
# printer has no entry for; ci-timing-regressions.test.ts pins it to the export.
NOOP_CLASS='[slack] reload-noop:'
# fixtures/slack-stub-server.ts: the refusal of a push to a label with no open
# WebSocket.
NO_OPEN_SOCKET='no-open-socket'
# src/persona-bringup.ts checkPersonaWorkingDirectory: inline failure cause.
DIRECTORY_MISSING_CAUSE='working directory does not exist'
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

# Keep the existing call sites while the shared reader owns JSONL validation.
rec_count() {
    local event="${1#event=}"; shift
    slack_stub_record_count "${event}" "$@"
}
rec_at_least() {
    local min="$1"; shift
    (( $(rec_count "$@") >= min ))
}

# The stub MCP session's request and results records, for checks
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

# queued_count <dir> <chat-id> <ts> [<via>]: durable acceptance count.
queued_count() {
    shared_queued_count "${QUEUE_KEY[$1]}" "$2" "$3" "${4:-}"
}

queued() {
    (( $(queued_count "$@") == 1 ))
}

declare -A EXPECTED_QUEUE_ROWS=()
declare -A QUEUE_ARCHIVES=()
declare -A RECEIPT_MODE=() EXPECTED_INPUTS=()
ACKS="${SCENARIO_ROOT}/expected-envelopes"
: > "${ACKS}"

# Freeze exact content and receipt evidence before each compaction boundary.
snapshot_queue() {
    local key="${QUEUE_KEY[$1]}" out="${SCENARIO_ROOT}/queue-evidence-${QUEUE_KEY[$1]}.jsonl"
    if [[ -f "${out}" ]]; then shared_queue_snapshot "${out}" "${key}" "${out}"
    else shared_queue_snapshot "${out}" "${key}"; fi
    QUEUE_ARCHIVES["$1"]="${out}"
}
wait_queue_drained() {
    snapshot_queue "$1"
    # The archive fixes the original workload and retains observed receipts
    # removed from the live journal by compaction; supply it in both roles.
    shared_wait_queue_drained "${QUEUE_KEY[$1]}" "${QUEUE_ARCHIVES[$1]}" "${QUEUE_ARCHIVES[$1]}"
    snapshot_queue "$1"
}
queue_drain_snapshot() {
    local dir
    for dir in "${ALPHA_DIR}" "${BRAVO_DIR}"; do
        snapshot_queue "${dir}"
        shared_queue_receipts "${QUEUE_KEY[${dir}]}" "${QUEUE_ARCHIVES[${dir}]}" "${QUEUE_ARCHIVES[${dir}]}"
    done
}

# wait_queued <step> <dir> <chat-id> <ts> <via>: the delivery reaches the
# accepted queue record, with that `via`.
wait_queued() {
    local step="$1" name sender="${6:-${HUMAN}}" identity; shift
    wait_until "${EVENT_WAIT_S}" "${step}: missing acceptance" queued "$1" "$2" "$3" "$4"
    case "$1" in "${ALPHA_DIR}") name="${ALPHA}" ;; "${BRAVO_DIR}") name="${BRAVO}" ;; esac
    identity="${QUEUE_KEY[$1]}|$2|$3|$4"
    if [[ -z "${EXPECTED_QUEUE_ROWS[${identity}]:-}" ]]; then
        EXPECTED_QUEUE_ROWS["${identity}"]="$(shared_delivery_expectation "${QUEUE_KEY[$1]}" "${name}" slack "$2" "$3" "${sender}" "$4")"
        [[ -n "${PUSHED_EVENTS[$2|$3]:-}" ]] || fail "${step}: no independently retained input"
        EXPECTED_INPUTS["${identity}"]="${PUSHED_EVENTS[$2|$3]}"
        if [[ "${RECEIPT_MODE[${QUEUE_KEY[$1]}]:-ordinary}" == manual ]]; then
            shared_stub_permission receipt "$1" "${QUEUE_KEY[$1]}" > /dev/null
        fi
    fi
    # Check carried joins while their stamp is still current, before any
    # intentional leave/value/identity reset can retire this participation.
    if [[ "$4" == mention || "$4" == broadcast ]]; then
        wait_until "${EVENT_WAIT_S}" "${step}: carried join was not saved" accepted_join_saved "${QUEUE_KEY[$1]}" "$2" "$3"
    fi
}

# expect_queued <step> <want> <dir> <chat-id> <ts> [<via>]
expect_queued() {
    local step="$1" want="$2" got; shift 2
    got="$(queued_count "$@")"
    [[ "${got}" == "${want}" ]] || fail "${step}: ${got} deliveries of $2 ts $3${4:+ via $4} in the accepted queue record of $1, expected ${want}"
}

# The stub MCP session's records of each persona's working directory
# (fixtures/stub-mcp-session.ts "The key"), each path resolved once here, by
# working directory: the harness's own key (lib/scenario.sh
# _scenario_stub_key, the rule stub_session_deliveries and stub_session_call
# use) under the real path of SCENARIO_STUB_DIR (_scenario_stub_dir). Either
# helper prints its FAIL line when it cannot resolve or hash a path. Every
# later read of a record takes these paths.
declare -A DELIVERIES_FILE=() QUEUE_KEY=() REQUESTS_FILE=() RESULTS_FILE=()
STUB_REAL_DIR="$(_scenario_stub_dir "the stub MCP session's records")" || exit 1
for dir in "${ALPHA_DIR}" "${BRAVO_DIR}"; do
    record_key="$(_scenario_stub_key "the stub MCP session's records of ${dir}" "${dir}")" || exit 1
    case "${dir}" in
        "${ALPHA_DIR}") QUEUE_KEY["${dir}"]="${ALPHA_KEY}" ;;
        "${BRAVO_DIR}") QUEUE_KEY["${dir}"]="${BRAVO_KEY}" ;;
    esac
    DELIVERIES_FILE["${dir}"]="${SLACK_STATE_DIR}/queue/${QUEUE_KEY[${dir}]}.jsonl"
    REQUESTS_FILE["${dir}"]="${STUB_REAL_DIR}/${SCENARIO_STUB_REQUESTS_PREFIX}${record_key}${SCENARIO_STUB_RECORD_SUFFIX}"
    RESULTS_FILE["${dir}"]="${STUB_REAL_DIR}/${SCENARIO_STUB_RESULTS_PREFIX}${record_key}${SCENARIO_STUB_RECORD_SUFFIX}"
done

# The push wrapper. Each push gets its own `ts` from the shared builder,
# except the two events of one mention and the one message
# pushed to both personas, which share theirs. PUSH_TS is the push's ts.
TS_SEQ=0
declare -A PUSHED_TS=() PUSHED_EVENTS=()
new_ts() {
    TS_SEQ=$(( TS_SEQ + 1 ))
    PUSH_TS="$(scenario_ts)"
}

# message_event <channel> <channel_type|""> <text> <ts>
message_event() {
    slack_message_event "$1" "$3" "$4" "${HUMAN}" "$2"
}

# app_mention_event <channel> <text> <ts>: Slack's app_mention, with no channel_type.
app_mention_event() {
    slack_mention_event "$1" "$2" "$3" "${HUMAN}"
}

# push_event <label> <event-json> [<flag>]: one push; fails on a refusal.
push_event() {
    local label="$1" ts
    ts="$(jq -r '.ts' <<< "$2")"
    PUSHED_EVENTS["$(jq -r '.channel' <<< "$2")|${ts}"]="$2"
    PUSHED_TS["${label} ${ts} $(jq -r '.type' <<< "$2")"]=1
    local envelope
    envelope="$(slack_stub_push "${label}" "$2" "${3:-}")"
    printf '%s\n' "${envelope}" >> "${ACKS}"
    slack_wait_one_ack "${envelope}"
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

plain_text() { scenario_text "plain-${TS_SEQ}"; }
mention_text() { scenario_mention_text "$1" "${TEST_NAME} mention"; }

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

# Thread phases use real Slack events and the same acceptance/receipt ledger
# as the earlier phases. The stub never answers these messages with reply.
declare -A OLD_THREAD_ROOTS=() THREAD_STAMPS=() JOINED_ROOTS=()
thread_persona() {
    case "$1" in
        alpha) THREAD_DIR="${ALPHA_DIR}" THREAD_KEY="${ALPHA_KEY}" THREAD_BOT="${ALPHA_BOT_USER}" THREAD_REF="${ALPHA_REF}" ;;
        bravo) THREAD_DIR="${BRAVO_DIR}" THREAD_KEY="${BRAVO_KEY}" THREAD_BOT="${BRAVO_BOT_USER}" THREAD_REF="${BRAVO_REF}" ;;
        *) fail "thread_persona: unknown label $1" ;;
    esac
}

# push_thread_reply <label> <channel> <root> <text>
push_thread_reply() {
    new_ts
    push_event "$1" "$(slack_reply_event "$2" "$3" "$4" "${PUSH_TS}" "${HUMAN}")"
}

# A fresh drop line is a decision witness, not a quiet-period assertion.
expect_unjoined_reply() {
    local step="$1" who="$2" channel="$3" root="$4" mark ts
    thread_persona "${who}"
    mark="$(log_mark)"
    push_thread_reply "${who}" "${channel}" "${root}" "$(plain_text)"
    ts="${PUSH_TS}"
    wait_since "${mark}" "$(plain_drop "${THREAD_REF}" "${channel}" "${DROP_NOT_MENTIONED}")" "${EVENT_WAIT_S}" "${step}: no unjoined-thread decision"
    expect_queued "${step}" 0 "${THREAD_DIR}" "${channel}" "${ts}"
}

# other_value_threads <step> <label> <all-via> [require-no-memory]: per-channel
# negatives, plus the early persona-wide no-file/no-marker proof when true.
other_value_threads() {
    local step="$1" who="$2" all_via="$3" channel root reply mark
    thread_persona "${who}"
    for channel in "${N1}" "${N2}" "${N3}"; do
        mark="$(log_mark)"
        push_message "${who}" "${channel}" channel "$(mention_text "${THREAD_BOT}")"
        root="${PUSH_TS}"
        OLD_THREAD_ROOTS["${who}|${channel}"]="${root}"
        push_thread_reply "${who}" "${channel}" "${root}" "$(plain_text)"
        reply="${PUSH_TS}"
        if [[ "${channel}" == "${N1}" ]]; then
            wait_until "${EVENT_WAIT_S}" "${step}: off did not drop both events" count_since_at_least \
                "${mark}" "$(plain_drop "${THREAD_REF}" "${channel}" "${DROP_CHANNEL_OFF}")" 2
            expect_queued "${step}: off mention" 0 "${THREAD_DIR}" "${channel}" "${root}"
            expect_queued "${step}: off reply" 0 "${THREAD_DIR}" "${channel}" "${reply}"
        else
            wait_queued "${step}: mention" "${THREAD_DIR}" "${channel}" "${root}" "${VIA_MENTION}"
            if [[ "${channel}" == "${N2}" ]]; then
                wait_since "${mark}" "$(plain_drop "${THREAD_REF}" "${channel}" "${DROP_NOT_MENTIONED}")" "${EVENT_WAIT_S}" "${step}: mentions selected an unmentioned reply"
                expect_queued "${step}: mentions reply" 0 "${THREAD_DIR}" "${channel}" "${reply}"
            else
                wait_queued "${step}: all reply" "${THREAD_DIR}" "${channel}" "${reply}" "${all_via}"
            fi
        fi
        [[ -z "$(shared_thread_since "${THREAD_KEY}" "${channel}")" ]] || fail "${step}: ordinary value acquired a stamp"
        if [[ "$(shared_thread_file "${THREAD_KEY}")" == true ]]; then
            [[ -z "$(shared_thread_joins "${THREAD_KEY}" | jq -c --arg c "${channel}" 'select(.channel==$c)')" ]] || fail "${step}: ordinary value acquired a join"
        fi
        if [[ "${4:-false}" == true ]]; then
            [[ ! -e "${SLACK_STATE_DIR}/threads/${THREAD_KEY}.jsonl" ]] || fail "${step}: persona with no hybrid entry acquired Thread Memory"
            [[ "$(shared_thread_created "${THREAD_KEY}")" == false ]] || fail "${step}: ordinary values set the Thread Memory marker"
        fi
    done
}

# After the value changes, each earlier root stays unjoined until a new
# mention in that same thread; no earlier event is replayed by the join.
check_new_hybrid_choices() {
    local step="$1" who="$2" channel root mention reply
    thread_persona "${who}"
    for channel in "${N1}" "${N2}" "${N3}"; do
        root="${OLD_THREAD_ROOTS[${who}|${channel}]}"
        expect_unjoined_reply "${step}: earlier root" "${who}" "${channel}" "${root}"
        push_thread_reply "${who}" "${channel}" "${root}" "$(mention_text "${THREAD_BOT}")"
        mention="${PUSH_TS}"
        push_thread_reply "${who}" "${channel}" "${root}" "$(plain_text)"
        reply="${PUSH_TS}"
        wait_queued "${step}: fresh mention" "${THREAD_DIR}" "${channel}" "${mention}" "${VIA_MENTION}"
        wait_queued "${step}: reply after fresh mention" "${THREAD_DIR}" "${channel}" "${reply}" "${VIA_THREAD}"
    done
}

# Run in each mode. There is deliberately no wait between the joining root
# and its reply: neither receipt completion nor a bot answer gates selection.
join_thread_phase() {
    local mode="$1" root reply broadcast broadcast_reply unrelated mark plain
    push_message "${ALPHA_LABEL}" "${T1}" channel "$(mention_text "${ALPHA_BOT_USER}")"
    root="${PUSH_TS}"
    JOINED_ROOTS["${mode}"]="${root}"
    push_thread_reply "${ALPHA_LABEL}" "${T1}" "${root}" "$(plain_text)"
    reply="${PUSH_TS}"
    wait_queued "${mode}: joining mention" "${ALPHA_DIR}" "${T1}" "${root}" "${VIA_MENTION}"
    wait_queued "${mode}: immediate reply" "${ALPHA_DIR}" "${T1}" "${reply}" "${VIA_THREAD}"
    new_ts
    unrelated="${PUSH_TS}"
    expect_unjoined_reply "${mode}: unrelated root" "${ALPHA_LABEL}" "${T1}" "${unrelated}"
    mark="$(log_mark)"
    push_message "${ALPHA_LABEL}" "${T1}" channel "$(plain_text)"
    plain="${PUSH_TS}"
    wait_since "${mark}" "$(plain_drop "${ALPHA_REF}" "${T1}" "${DROP_NOT_MENTIONED}")" "${EVENT_WAIT_S}" "${mode}: plain channel message did not drop"
    expect_queued "${mode}: plain channel message" 0 "${ALPHA_DIR}" "${T1}" "${plain}"
    push_message "${ALPHA_LABEL}" "${T1}" channel "$(scenario_broadcast_text here "${mode} thread broadcast")"
    broadcast="${PUSH_TS}"
    push_thread_reply "${ALPHA_LABEL}" "${T1}" "${broadcast}" "$(plain_text)"
    broadcast_reply="${PUSH_TS}"
    wait_queued "${mode}: joining Broadcast" "${ALPHA_DIR}" "${T1}" "${broadcast}" "${VIA_BROADCAST}"
    wait_queued "${mode}: Broadcast's reply" "${ALPHA_DIR}" "${T1}" "${broadcast_reply}" "${VIA_THREAD}"
}

two_persona_threads() {
    local mode="$1" root reply event dir
    push_both "${T1}" channel "$(scenario_mention_text "${ALPHA_BOT_USER}" "$(scenario_mention_text "${BRAVO_BOT_USER}" "${mode} shared thread")")"
    root="${PUSH_TS}"
    JOINED_ROOTS["${mode}-both"]="${root}"
    new_ts
    reply="${PUSH_TS}"
    event="$(slack_reply_event "${T1}" "${root}" "$(plain_text)" "${reply}" "${HUMAN}")"
    push_event "${ALPHA_LABEL}" "${event}"
    push_event "${BRAVO_LABEL}" "${event}"
    for dir in "${ALPHA_DIR}" "${BRAVO_DIR}"; do
        wait_queued "${mode}: both mentioned" "${dir}" "${T1}" "${root}" "${VIA_MENTION}"
        wait_queued "${mode}: both joined" "${dir}" "${T1}" "${reply}" "${VIA_THREAD}"
    done
}

check_thread_persistence() {
    local step="$1" who="$2" root="$3" stamp
    thread_persona "${who}"
    stamp="$(printed sharedThreadStamp "${CONFIG}" "${LAST}" "${THREAD_KEY}" "${T1}")"
    [[ "${stamp}" == "${THREAD_STAMPS[${who}]}" ]] || fail "${step}: ${who}'s Channel Stamp changed"
    push_thread_reply "${who}" "${T1}" "${root}" "$(plain_text)"
    wait_queued "${step}: persisted join" "${THREAD_DIR}" "${T1}" "${PUSH_TS}" "${VIA_THREAD}"
}

# Compositions use only the shared evidence projections. These functions
# describe operator inputs and expected decisions, never a second store format.
declare -A MATRIX_ROOTS=() LEAVE_CHANNELS=() LEAVE_ROOTS=() LEAVE_ENVELOPES=()
CAPTURED="${SCENARIO_ROOT}/captured-results"
mkdir -p "${CAPTURED}"

ack_control() {
    [[ -n "$1" ]] || fail 'control returned no envelope'
    printf '%s\n' "$1" >> "${ACKS}"
    slack_wait_one_ack "$1"
}

edit_input() {
    jq "$@" "${CONFIG}" > "${CONFIG}.candidate"
    mv -- "${CONFIG}.candidate" "${CONFIG}"
}
input_has() { jq -e "$@" "${CONFIG}" > /dev/null; }
input_choice() {
    edit_input --arg who "$1" --arg c "$2" --arg d "$3" \
        '(.personas[] | select(.name==$who) | .channels) |= (map(select(.id!=$c)) + [{id:$c,delivery:$d}])'
}
choice_is() { [[ "$(shared_channel_saved "$1" "$2")" == "$3" ]]; }
channel_facts() { shared_persona_facts "$1" "$2" | jq -cS 'del(.mode,.historicalMembership)'; }
assignment_order() { shared_persona_facts "$1" "$2" | jq -er --arg c "$2" '.assignments[$c].order'; }

capture_review() {
    cp -- "${PENDING}" "${CAPTURED}/$1.pending"
    check_pending_layout "$1"
}
# review_replaced <copy>: the pending file now holds a review other than the
# captured copy's (line 2, its fingerprint): the server durably superseded it.
review_replaced() {
    local now
    now="$(sed -n '2p' "${PENDING}" 2> /dev/null)" || return 1
    [[ -n "${now}" && "${now}" != "$(sed -n '2p' "$1")" ]]
}
# confirm_review <step> [wait-s] [noop]: given noop, the review has no
# effective change, so production consumes it and logs reload-noop, never
# reload-applied (src/reload-plan.ts noEffectiveChange). Callers therefore
# confirm an unchanged input only as noop.
confirm_review() {
    local step="$1" before noops wait_s="${2:-${APPLY_WAIT_S}}" noop="${3:-}"
    before="$(count_log "${APPLIED_CLASS}")"
    noops="$(count_log "${NOOP_CLASS}")"
    capture_review "${step}"
    mv -f -- "${PENDING}" "${APPLY}"
    if [[ "${noop}" == noop ]]; then
        wait_for_count "${NOOP_CLASS}" $(( noops + 1 )) "${wait_s}" "${step}: confirmation was not a no-op"
        [[ "$(count_log "${APPLIED_CLASS}")" == "${before}" ]] || fail "${step}: a no-op confirmation applied a change"
    else
        wait_for_count "${APPLIED_CLASS}" $(( before + 1 )) "${wait_s}" "${step}: confirmation did not apply"
    fi
    wait_until "${wait_s}" "${step}: review not durably consumed" \
        bun "${PRINTER}" sharedReviewConsumed "${CONFIG}" "${LAST}" "${CAPTURED}/${step}.pending" > /dev/null
    configuration_record_matches "${CONFIG}" "${LAST}" reviewed > /dev/null
}
review_assign() {
    local step="$1"; shift
    configuration_request "${step}" request "$@" > /dev/null
    confirm_review "${step}"
}
# A retained review that a later cancel, revision or dependency change replaced
# is durably superseded. While that supersession is the outcome recorded last,
# production's outcome line refuses that exact copied gesture; given dropped,
# a later review's outcome has replaced it, so the gesture matches no current
# review and gets the stale-confirmation line. Either way it is spent and no
# applied fact changes.
expect_stale_review() {
    local step="$1" old="$2" dropped="${3:-}" mark before refusal="${SUPERSEDED_OUTCOME}" other="${STALE_CONFIRMATION}"
    if [[ "${dropped}" == dropped ]]; then refusal="${STALE_CONFIRMATION}"; other="${SUPERSEDED_OUTCOME}"; fi
    mark="$(log_mark)"; before="${SCENARIO_ROOT}/${step}-authority"
    cp -- "${LAST}" "${before}"
    cp -- "${old}" "${APPLY}"
    wait_since "${mark}" "${refusal}" "${APPLY_WAIT_S}" "${step}: stale preview was not refused"
    expect_since "${mark}" "${other}" 0 "${step}: stale preview refused by the other review state"
    [[ ! -e "${APPLY}" ]] || fail "${step}: refused confirmation was not spent"
    configuration_application_preserved "${CONFIG}" "${before}" "${LAST}" > /dev/null \
        || fail "${step}: stale confirmation changed applied facts"
}
expect_preview_choice() {
    local key="$1" channel="$2" kind="$3" saved="$4" reviewed="$5" member="$6" now="$7" next="$8" order="$9" expected
    shift 9
    expected="$(printed reviewedChannelLine "${key}" "${channel}" "${kind}" "${saved}" "${reviewed}" \
        "${member}" "${now}" "${next}" "previousOrder=${order}" "$@")"
    pending_has_line "${expected}" || fail 'preview did not distinguish saved choice, membership, intent and effective outcome'
}

# A negative decision has its own log witness. Positives enter the global
# exact ledger; a later receipt audit covers content and final completion.
matrix_message() {
    local step="$1" who="$2" channel="$3" kind="$4" root="$5" want="$6" text ts mark
    thread_persona "${who}"
    mark="$(log_mark)"; new_ts; ts="${PUSH_TS}"
    case "${kind}" in
        mention) text="$(mention_text "${THREAD_BOT}")" ;;
        broadcast) text="$(scenario_broadcast_text here "${step}")" ;;
        overlap) text="$(scenario_mention_text "${THREAD_BOT}" "$(scenario_broadcast_text channel "${step}")")" ;;
        *) text="$(scenario_text "${step}")" ;;
    esac
    if [[ "${root}" == - ]]; then
        push_event "${who}" "$(slack_message_event "${channel}" "${text}" "${ts}" "${HUMAN}")"
    else
        push_event "${who}" "$(slack_reply_event "${channel}" "${root}" "${text}" "${ts}" "${HUMAN}")"
    fi
    if [[ "${want}" == channel-off || "${want}" == not-mentioned || "${want}" == channel-ineligible ]]; then
        wait_since "${mark}" "$(plain_drop "${THREAD_REF}" "${channel}" "${want}")" "${EVENT_WAIT_S}" "${step}: missing drop witness"
        expect_queued "${step}" 0 "${THREAD_DIR}" "${channel}" "${ts}"
    else
        wait_queued "${step}" "${THREAD_DIR}" "${channel}" "${ts}" "${want}"
        expect_queued "${step}: exactly one reason" 1 "${THREAD_DIR}" "${channel}" "${ts}"
    fi
    MATRIX_TS="${ts}"
}
selection_matrix() {
    local mode="$1" channel value mention broadcast plain followed root outside stamp
    for value in off mentions all thread_hybrid; do
        case "${value}" in
            off) channel="${M_OFF}"; mention=channel-off; broadcast=channel-off; plain=channel-off; followed=channel-off ;;
            mentions) channel="${M_MENTIONS}"; mention=mention; broadcast=broadcast; plain=not-mentioned; followed=not-mentioned ;;
            all) channel="${M_ALL}"; mention=mention; broadcast=broadcast; plain=receive_all; followed=receive_all ;;
            thread_hybrid) channel="${M_HYBRID}"; mention=mention; broadcast=broadcast; plain=not-mentioned; followed=thread ;;
        esac
        choice_is "${ALPHA_KEY}" "${channel}" "${value}" || fail "${mode}: matrix value changed"
        [[ "$(shared_channel_effective "${ALPHA_KEY}" "${channel}" eligible)" == "${value}" ]] || fail "${mode}: effective value changed"
        matrix_message "${mode}-${value}-mention" alpha "${channel}" mention - "${mention}"
        root="${MATRIX_TS}"; MATRIX_ROOTS["${mode}|${value}"]="${root}"
        matrix_message "${mode}-${value}-followed" alpha "${channel}" plain "${root}" "${followed}"
        matrix_message "${mode}-${value}-broadcast" alpha "${channel}" broadcast - "${broadcast}"
        matrix_message "${mode}-${value}-root" alpha "${channel}" plain - "${plain}"
        outside="$(scenario_ts)"
        matrix_message "${mode}-${value}-unfollowed" alpha "${channel}" plain "${outside}" "${plain}"
        matrix_message "${mode}-${value}-overlap" alpha "${channel}" overlap "${root}" "${mention}"
        if [[ "${value}" != thread_hybrid ]]; then
            [[ -z "$(shared_thread_since "${ALPHA_KEY}" "${channel}")" ]] || fail 'ordinary value acquired Thread Hybrid Since'
            [[ -z "$(shared_thread_joins "${ALPHA_KEY}" | jq -c --arg c "${channel}" 'select(.channel==$c)')" ]] \
                || fail 'ordinary value acquired a Thread Memory join'
        fi
    done
}

# Slack's users.conversations lists the channels a persona is in. Each live
# join or leave makes production rescan (completeObservation in
# src/channel-membership.ts), and a complete inventory without a channel is
# its absence. So a page changes before its event is pushed, and callers wait
# for that rescan before the channel's next message or write.
publish_members() {
    case "$1" in
        alpha) slack_stub_inventory_page alpha '' '' "${ALPHA_MEMBERS[@]}" ;;
        bravo) slack_stub_inventory_page bravo '' '' "${BRAVO_MEMBERS[@]}" ;;
        *) fail "publish_members: unknown label '$1'" ;;
    esac
}
# member_list <alpha|bravo> <channel> [public|private[/local|external]]
member_list() {
    local who="$1" channel="$2" entry kept=()
    local -n members="${who^^}_MEMBERS"
    for entry in "${members[@]}"; do [[ "${entry%%/*}" == "${channel}" ]] || kept+=("${entry}"); done
    members=("${kept[@]}" "${channel}${3:+/$3}")
    publish_members "${who}"
}
member_unlist() {
    local who="$1" channel="$2" entry kept=()
    local -n members="${who^^}_MEMBERS"
    for entry in "${members[@]}"; do [[ "${entry%%/*}" == "${channel}" ]] || kept+=("${entry}"); done
    (( ${#kept[@]} < ${#members[@]} )) || fail "member_unlist: ${channel} is not listed for ${who}"
    members=("${kept[@]}")
    publish_members "${who}"
}

start_matrix() {
    local channel
    for channel in "${M_OFF}" "${M_MENTIONS}" "${M_ALL}" "${M_HYBRID}" "${WRITE_CHANNEL}"; do
        member_list alpha "${channel}"
        ack_control "$(slack_push_member_joined alpha "${channel}" "$(scenario_ts)")"
        wait_until "${EVENT_WAIT_S}" 'matrix member did not receive strict default' choice_is "${ALPHA_KEY}" "${channel}" off
        wait_membership_complete "${ALPHA}"
    done
    MATRIX_READY=true
    input_choice "${ALPHA}" "${M_OFF}" off
    input_choice "${ALPHA}" "${M_MENTIONS}" mentions
    input_choice "${ALPHA}" "${M_ALL}" all
    input_choice "${ALPHA}" "${M_HYBRID}" thread_hybrid
    input_choice "${ALPHA}" "${WRITE_CHANNEL}" off
    input_choice "${ALPHA}" "${FUTURE}" all
    review_assign matrix-setup "${ALPHA}/${M_OFF}/off" "${ALPHA}/${M_MENTIONS}/mentions" \
        "${ALPHA}/${M_ALL}/all" "${ALPHA}/${M_HYBRID}/thread_hybrid" "${ALPHA}/${FUTURE}/all"
    selection_matrix strict
    local before="${SCENARIO_ROOT}/strict-tool-authority" value
    cp -- "${LAST}" "${before}"
    for value in off mentions all thread_hybrid; do
        expect_tool "strict refuses ${value}" "${ALPHA_DIR}" "$(attempt_args "strict-${value}" "${WRITE_CHANNEL}" "${value}")" true "${ALPHA_DECLARATIVE_REFUSAL}"
    done
    configuration_application_preserved "${CONFIG}" "${before}" "${LAST}" > /dev/null
}

# Whole current value/stamp/assignment facts and active joins, compared after
# modes, destinations and ordinary worker relaunch. Disk membership is never
# substituted for the live inventory/decision witnesses.
preserved_four_values() {
    local step="$1" channel value stamp
    for value in off mentions all thread_hybrid; do
        case "${value}" in off) channel="${M_OFF}" ;; mentions) channel="${M_MENTIONS}" ;; all) channel="${M_ALL}" ;; thread_hybrid) channel="${M_HYBRID}" ;; esac
        choice_is "${ALPHA_KEY}" "${channel}" "${value}" || fail "${step}: ${value} was not preserved"
        [[ "$(channel_facts "${ALPHA_KEY}" "${channel}")" == "${FOUR_FACTS[${value}]}" ]] || fail "${step}: choice/order/stamp changed"
    done
    stamp="$(printed sharedThreadStamp "${CONFIG}" "${LAST}" "${ALPHA_KEY}" "${M_HYBRID}")"
    [[ "$(shared_thread_joins "${ALPHA_KEY}" "${M_HYBRID}" "${stamp}" | jq -scS 'sort_by(.root)')" == "${FOUR_JOINS}" ]] \
        || fail "${step}: Joined Threads changed"
}
freeze_four_values() {
    local value channel stamp
    declare -gA FOUR_FACTS=()
    for value in off mentions all thread_hybrid; do
        case "${value}" in off) channel="${M_OFF}" ;; mentions) channel="${M_MENTIONS}" ;; all) channel="${M_ALL}" ;; thread_hybrid) channel="${M_HYBRID}" ;; esac
        FOUR_FACTS["${value}"]="$(channel_facts "${ALPHA_KEY}" "${channel}")"
    done
    wait_until "${EVENT_WAIT_S}" 'matrix joins not durably saved' thread_joins_saved "${ALPHA_DIR}"
    stamp="$(printed sharedThreadStamp "${CONFIG}" "${LAST}" "${ALPHA_KEY}" "${M_HYBRID}")"
    FOUR_JOINS="$(shared_thread_joins "${ALPHA_KEY}" "${M_HYBRID}" "${stamp}" | jq -scS 'sort_by(.root)')"
    [[ "${FOUR_JOINS}" != '[]' ]] || fail 'four-value control has no saved hybrid joins'
}

live_membership_phase() {
    local mode="$1" default=off value channel event first facts sibling before root
    [[ "${mode}" != open ]] || default=mentions
    for value in off mentions all thread_hybrid; do
        channel="$(scenario_id C "live-${mode}-${value}")"; LEAVE_CHANNELS["${mode}|${value}"]="${channel}"
        event="$(slack_membership_event member_joined_channel alpha "${channel}" "$(scenario_ts)")"
        member_list alpha "${channel}"
        ack_control "$(slack_stub_push alpha "${event}")"
        wait_until "${EVENT_WAIT_S}" 'self join has no mode default' choice_is "${ALPHA_KEY}" "${channel}" "${default}"
        facts="$(channel_facts "${ALPHA_KEY}" "${channel}")"
        ack_control "$(slack_stub_push alpha "${event}")"
        [[ "$(channel_facts "${ALPHA_KEY}" "${channel}")" == "${facts}" ]] || fail 'duplicate join made a second assignment'
        wait_membership_complete "${ALPHA}"
        if [[ "${mode}" == strict ]]; then
            matrix_message "${mode}-default-${value}" alpha "${channel}" mention - channel-off
        else
            matrix_message "${mode}-default-${value}" alpha "${channel}" mention - mention
        fi
        # The sibling shares each channel; P's leave must not remove Q's choice.
        member_list bravo "${channel}"
        ack_control "$(slack_push_member_joined bravo "${channel}" "$(scenario_ts)")"
        wait_until "${EVENT_WAIT_S}" 'sibling join missing' choice_is "${BRAVO_KEY}" "${channel}" "${default}"
        wait_membership_complete "${BRAVO}"
        if [[ "${mode}" == strict ]]; then
            input_choice "${ALPHA}" "${channel}" "${value}"
            review_assign "live-${mode}-${value}" "${ALPHA}/${channel}/${value}"
        else expect_attempt "live ${value}" "${ALPHA_DIR}" "$(attempt_args "live-${mode}-${value}" "${channel}" "${value}")" "${ALPHA_KEY}" "${value}"; fi
        if [[ "${value}" == thread_hybrid ]]; then
            matrix_message "live-${mode}-join" alpha "${channel}" mention - mention
            LEAVE_ROOTS["${mode}"]="${MATRIX_TS}"
            wait_until "${EVENT_WAIT_S}" 'pre-leave join not saved' thread_joins_saved "${ALPHA_DIR}"
        fi
        sibling="$(channel_facts "${BRAVO_KEY}" "${channel}")"
        before="$(channel_facts "${ALPHA_KEY}" "${M_HYBRID}")"
        # Capture a real dependency before removing this member. Each stale
        # confirmation must be rejected after the corresponding durable leave.
        configuration_request "leave-preview-${mode}-${value}" request "${ALPHA}/${channel}/${value}" > /dev/null
        capture_review "leave-preview-${mode}-${value}"
        member_unlist alpha "${channel}"
        first="$(slack_push_channel_left alpha "${channel}" "$(scenario_ts)")"
        LEAVE_ENVELOPES["${mode}|${value}"]="${first}"
        ack_control "${first}"
        wait_until "${EVENT_WAIT_S}" 'leave did not remove saved entry' choice_is "${ALPHA_KEY}" "${channel}" ''
        # The applied leave staged an inventory rescan. Let it land before the
        # stale check's snapshot, so that check's window holds only the refused
        # confirmation.
        wait_membership_rescan "${ALPHA}" "${ALPHA_LABEL}" "$(slack_stub_record_field seq push "envelope_id=${first}")"
        [[ -z "$(shared_thread_since "${ALPHA_KEY}" "${channel}")" ]] || fail 'leave retained Thread Hybrid Since'
        [[ "$(channel_facts "${BRAVO_KEY}" "${channel}")" == "${sibling}" ]] || fail 'leave changed sibling choice'
        [[ "$(channel_facts "${ALPHA_KEY}" "${M_HYBRID}")" == "${before}" ]] || fail 'leave changed another channel'
        # Nothing else changed since the capture, so the leave superseded it.
        # Its rescan may supersede once more, depending on when checks fall;
        # the cancel then supersedes the current review, so the captured
        # outcome is no longer kept and the refusal is the stale line.
        wait_until "${APPLY_WAIT_S}" 'leave did not supersede the captured review' \
            review_replaced "${CAPTURED}/leave-preview-${mode}-${value}.pending"
        configuration_request "leave-cancel-${mode}-${value}" cancel > /dev/null
        expect_stale_review "leave-stale-${mode}-${value}" "${CAPTURED}/leave-preview-${mode}-${value}.pending" dropped
        if [[ "${mode}" == open ]]; then
            expect_attempt 'removed channel refuses bot write' "${ALPHA_DIR}" "$(attempt_args "removed-${value}" "${channel}" all)" "${ALPHA_KEY}" channel-removed new true
        fi
    done
    # Definitively irrelevant envelopes are ACKed, with no assignment added.
    channel="$(scenario_id C "ignored-${mode}")"
    before="$(shared_persona_facts "${ALPHA_KEY}" | jq -cS 'del(.historicalMembership)')"
    ack_control "$(slack_push_member_joined alpha "${channel}" "$(scenario_ts)" other)"
    event="$(slack_membership_event member_joined_channel alpha "${channel}" "$(scenario_ts)")"
    first="$(slack_stub_push_installation alpha "${event}" bravo)"; ack_control "${first}"
    slack_stub_control_fired push-installation "envelope_id=${first}" > /dev/null
    matrix_message "ignored-${mode}-barrier" alpha "${M_MENTIONS}" mention - mention
    [[ "$(shared_persona_facts "${ALPHA_KEY}" | jq -cS 'del(.historicalMembership)')" == "${before}" ]] || fail 'ignored membership changed authority'
}

write_order_phase() {
    local value want before order after stamp original config_copy
    # Every open value changes the next event, with one independent sibling.
    before="$(shared_persona_facts "${BRAVO_KEY}" | jq -cS 'del(.historicalMembership)')"
    for value in off mentions all thread_hybrid; do
        expect_attempt "open writes ${value}" "${ALPHA_DIR}" "$(attempt_args "open-write-${value}" "${WRITE_CHANNEL}" "${value}")" "${ALPHA_KEY}" "${value}"
        [[ "$(shared_persona_facts "${BRAVO_KEY}" | jq -cS 'del(.historicalMembership)')" == "${before}" ]] || fail 'P assignment changed Q'
        want=mention; [[ "${value}" != off ]] || want=channel-off
        matrix_message "open-next-${value}" alpha "${WRITE_CHANNEL}" mention - "${want}"
    done
    original="${MATRIX_TS}"; stamp="$(shared_thread_since "${ALPHA_KEY}" "${WRITE_CHANNEL}")"
    order="$(assignment_order "${ALPHA_KEY}" "${WRITE_CHANNEL}")"
    expect_attempt 'same-value bot order' "${ALPHA_DIR}" "$(attempt_args same-bot "${WRITE_CHANNEL}" thread_hybrid)" "${ALPHA_KEY}" thread_hybrid
    after="$(assignment_order "${ALPHA_KEY}" "${WRITE_CHANNEL}")"
    (( after > order )) || fail 'same-value bot assignment took no later order'
    [[ "$(shared_thread_since "${ALPHA_KEY}" "${WRITE_CHANNEL}")" == "${stamp}" ]] || fail 'same bot assignment reset stamp'
    input_choice "${ALPHA}" "${WRITE_CHANNEL}" thread_hybrid
    configuration_request same-operator request "${ALPHA}/${WRITE_CHANNEL}/thread_hybrid" > /dev/null
    expect_preview_choice "${ALPHA_KEY}" "${WRITE_CHANNEL}" declared thread_hybrid thread_hybrid eligible thread_hybrid thread_hybrid "${after}"
    confirm_review same-operator
    order="$(assignment_order "${ALPHA_KEY}" "${WRITE_CHANNEL}")"
    (( order > after )) || fail 'same-value operator assignment took no later order'
    [[ "$(shared_thread_since "${ALPHA_KEY}" "${WRITE_CHANNEL}")" == "${stamp}" ]] || fail 'same operator assignment reset stamp'
    matrix_message same-hybrid-join-kept alpha "${WRITE_CHANNEL}" plain "${original}" thread
    # Bot -> operator -> bot: each successful later assignment controls intake.
    input_choice "${ALPHA}" "${WRITE_CHANNEL}" off
    review_assign operator-last "${ALPHA}/${WRITE_CHANNEL}/off"
    matrix_message operator-last-off alpha "${WRITE_CHANNEL}" mention - channel-off
    expect_attempt bot-last "${ALPHA_DIR}" "$(attempt_args bot-last "${WRITE_CHANNEL}" thread_hybrid)" "${ALPHA_KEY}" thread_hybrid
    [[ "$(shared_thread_since "${ALPHA_KEY}" "${WRITE_CHANNEL}")" != "${stamp}" ]] || fail 'away/back reused old stamp'
    matrix_message away-back-forgets alpha "${WRITE_CHANNEL}" plain "${original}" not-mentioned
    matrix_message away-back-fresh-join alpha "${WRITE_CHANNEL}" mention "${original}" mention
    matrix_message away-back-next-reply alpha "${WRITE_CHANNEL}" plain "${original}" thread
    # Omitting a member differs from declaring off. The omission retains the
    # entry, so its confirmation changes nothing.
    edit_input --arg c "${WRITE_CHANNEL}" '.personas[0].channels |= map(select(.id!=$c))'
    configuration_request omit-member request > /dev/null
    pending_has_line "$(printed REVIEW_OMISSION_CLAUSE)" || fail 'omission preview lacks retention clause'
    confirm_review omit-member "${APPLY_WAIT_S}" noop
    matrix_message omission-keeps alpha "${WRITE_CHANNEL}" plain "${original}" thread
    # Cancel and revise invalidate their retained original previews.
    configuration_request cancel-intent request "${ALPHA}/${WRITE_CHANNEL}/off" > /dev/null
    capture_review cancelled-intent
    configuration_request cancelled cancel > /dev/null
    expect_stale_review cancelled-preview "${CAPTURED}/cancelled-intent.pending"
    matrix_message cancellation-keeps alpha "${WRITE_CHANNEL}" plain "${original}" thread
    configuration_request revise-intent request "${ALPHA}/${WRITE_CHANNEL}/off" > /dev/null
    capture_review superseded-intent
    configuration_request revised revise "${ALPHA}/${WRITE_CHANNEL}/mentions" > /dev/null
    expect_stale_review revised-preview "${CAPTURED}/superseded-intent.pending"
    configuration_request revised-fresh refresh > /dev/null
    confirm_review revised-fresh
    matrix_message revision-controls alpha "${WRITE_CHANNEL}" plain "${original}" not-mentioned
    # Pending intent survives a bot write and the one existing server restart.
    input_choice "${ALPHA}" "${WRITE_CHANNEL}" off
    configuration_request restart-intent request "${ALPHA}/${WRITE_CHANNEL}/off" > /dev/null
    capture_review before-bot-pending
    config_copy="${SCENARIO_ROOT}/pending-input-before-bot"; cp -- "${CONFIG}" "${config_copy}"
    expect_attempt pending-bot "${ALPHA_DIR}" "$(attempt_args pending-bot "${WRITE_CHANNEL}" all)" "${ALPHA_KEY}" all
    cmp -s "${CONFIG}" "${config_copy}" || fail 'bot write changed pending operator input'
    expect_stale_review pending-stale "${CAPTURED}/before-bot-pending.pending"
    configuration_request restart-refreshed refresh > /dev/null
    expect_preview_choice "${ALPHA_KEY}" "${WRITE_CHANNEL}" declared all off eligible all off "$(assignment_order "${ALPHA_KEY}" "${WRITE_CHANNEL}")"
    capture_review pending-across-restart
    matrix_message pending-not-applied alpha "${WRITE_CHANNEL}" plain - receive_all
}

# A channel the persona's input lists is changed by review in either mode,
# so the input keeps naming its saved value; open mode's bot tool sets only
# an unlisted one.
set_composed_choice() {
    local mode="$1" who="$2" channel="$3" value="$4" step="$5" name
    thread_persona "${who}"
    if [[ "${who}" == alpha ]]; then name="${ALPHA}"; else name="${BRAVO}"; fi
    if [[ "${mode}" == strict ]] || input_has --arg who "${name}" --arg c "${channel}" '.personas[]|select(.name==$who)|any(.channels[]; .id==$c)'; then
        input_choice "${name}" "${channel}" "${value}"
        review_assign "${step}" "${name}/${channel}/${value}"
    else expect_attempt "${step}" "${THREAD_DIR}" "$(attempt_args "${step}" "${channel}" "${value}")" "${THREAD_KEY}" "${value}"; fi
}
# edit_destination <name> <key> <step> [dm]: one input edit points the
# persona's permission_prompts at DEST (and enables DMs with CONTACT, given
# dm) and lists DEST at its saved value, reviewed only when the input
# changes. The production parser refuses a permission_prompts channel the
# input does not list (src/config.ts checkPersonaCrossSettings). Listing a
# channel is an operator assignment at the review's order in either mode
# (src/shared-channels.ts prepareReviewed), so it carries its gesture; at
# the saved value it keeps the value and its Thread Hybrid Since.
edit_destination() {
    local name="$1" key="$2" step="$3" dm="${4:-}" saved filter gesture=()
    saved="$(shared_channel_saved "${key}" "${DEST}")"
    [[ -n "${saved}" ]] || fail "${step}: ${DEST} has no saved choice to list"
    local args=(--arg who "${name}" --arg c "${DEST}" --arg d "${saved}" --arg contact "${CONTACT}")
    filter='(.personas[]|select(.name==$who)) |= (.permission_prompts=$c'
    [[ "${dm}" != dm ]] || filter+=' | .dm={enabled:true,contact:$contact}'
    filter+=' | .channels |= (if any(.[]; .id==$c) then map(if .id==$c then .delivery=$d else . end) else . + [{id:$c,delivery:$d}] end))'
    ! input_has "${args[@]}" "(${filter}) == ." || return 0
    input_has "${args[@]}" '.personas[]|select(.name==$who)|any(.channels[]; .id==$c and .delivery==$d)' \
        || gesture=("${name}/${DEST}/${saved}")
    edit_input "${args[@]}" "${filter}"
    review_assign "${step}" "${gesture[@]}"
}
join_count() {
    local stamp
    stamp="$(printed sharedThreadStamp "${CONFIG}" "${LAST}" "$1" "$2")" || return 1
    shared_thread_joins "$1" "$2" "${stamp}" | jq -s --arg root "$3" '[.[]|select(.root==$root)]|length'
}
joined_once() { [[ "$(join_count "$1" "$2" "$3")" == 1 ]]; }

successful_tool() {
    local result
    result="$(stub_session_call "$2" "$3" "$4")"
    jq -e '.isError==false and (has("error")|not)' <<< "${result}" > /dev/null || fail "$1: tool did not succeed"
    printf '%s\n' "${result}" > "${CAPTURED}/$1.result"
}

own_posts_phase() {
    local mode="$1" q="$2" dir key bot root text mark result post_ts stamp before file method envelope outside name
    thread_persona "${q}"; dir="${THREAD_DIR}"; key="${THREAD_KEY}"; bot="${THREAD_BOT}"
    set_composed_choice "${mode}" "${q}" "${DEST}" thread_hybrid "${mode}-own-hybrid"
    # No inbound mention supplied either own-post join. The root's original
    # plain message is excluded, then the confirmed tool post joins it.
    matrix_message "${mode}-reply-root-unjoined" "${q}" "${DEST}" plain - not-mentioned
    root="${MATRIX_TS}"; text="$(scenario_text "${mode}-own-reply")"
    successful_tool "${mode}-own-reply" "${dir}" reply "$(jq -cn --arg c "${DEST}" --arg r "${root}" --arg t "${text}" '{chat_id:$c,thread_ts:$r,text:$t}')"
    wait_until "${EVENT_WAIT_S}" 'confirmed reply did not join once' joined_once "${key}" "${DEST}" "${root}"
    matrix_message "${mode}-reply-follow" "${q}" "${DEST}" plain "${root}" thread
    successful_tool "${mode}-own-reply-again" "${dir}" reply "$(jq -cn --arg c "${DEST}" --arg r "${root}" --arg t "${text}" '{chat_id:$c,thread_ts:$r,text:$t}')"
    [[ "$(join_count "${key}" "${DEST}" "${root}")" == 1 ]] || fail 'repeat own reply duplicated its join'
    matrix_message "${mode}-upload-root-unjoined" "${q}" "${DEST}" plain - not-mentioned
    root="${MATRIX_TS}"; file="${SCENARIO_ROOT}/${mode}-upload.txt"
    scenario_text "${mode}-uploaded-body" > "${file}"
    mark="$(slack_post_mark)"
    successful_tool "${mode}-upload" "${dir}" reply "$(jq -cn --arg c "${DEST}" --arg r "${root}" --arg f "${file}" '{chat_id:$c,thread_ts:$r,text:"",files:[$f]}')"
    [[ "$(slack_stub_records api "label=${q}" method=files.completeUploadExternal answer=ok | jq -s --argjson mark "${mark}" '[.[]|select(.seq>$mark)]|length')" == 1 ]] || fail 'upload has no successful completion'
    wait_until "${EVENT_WAIT_S}" 'confirmed upload did not join' joined_once "${key}" "${DEST}" "${root}"
    matrix_message "${mode}-upload-follow" "${q}" "${DEST}" plain "${root}" thread
    # None of these events represents a CSCB post operation. An edit that
    # adds a mention must neither select nor create participation.
    outside="$(scenario_ts)"; stamp="$(printed sharedThreadStamp "${CONFIG}" "${LAST}" "${key}" "${DEST}")"
    before="$(shared_thread_joins "${key}" "${DEST}" "${stamp}" | jq -scS 'sort_by(.root)')"
    # The app subscribes to no reaction event and CSCB forwards none, so
    # nothing acknowledges this envelope.
    envelope="$(slack_push_reaction "${q}" "${DEST}" "${outside}" thumbsup "$(scenario_ts)")"
    [[ -n "${envelope}" ]] || fail 'reaction push returned no envelope'
    ack_control "$(slack_push_edit "${q}" "${DEST}" "${outside}" "$(mention_text "${bot}")" "$(scenario_ts)")"
    ack_control "$(slack_push_delete "${q}" "${DEST}" "${outside}" "$(scenario_ts)")"
    push_event "${q}" "$(slack_message_event "${DEST}" "$(scenario_text outside-CSCB)" "${outside}" "${bot}")"
    matrix_message "${mode}-outside-post-follow" "${q}" "${DEST}" plain "${outside}" not-mentioned
    successful_tool "${mode}-edit-only" "${dir}" edit_message "$(jq -cn --arg c "${DEST}" --arg id "${outside}" --arg t "$(mention_text "${bot}")" '{chat_id:$c,message_id:$id,text:$t}')"
    successful_tool "${mode}-react-only" "${dir}" react "$(jq -cn --arg c "${DEST}" --arg id "${outside}" '{chat_id:$c,message_id:$id,emoji:"thumbsup"}')"
    [[ "$(shared_thread_joins "${key}" "${DEST}" "${stamp}" | jq -scS 'sort_by(.root)')" == "${before}" ]] || fail 'reaction/edit/delete/outside post joined a thread'
    # DM tools may post, but do not create channel participation. Group DM
    # ingress remains excluded, even with a direct mention. Bravo's input
    # already enables DMs, and an unchanged input confirms as reload-noop.
    name="$(if [[ "${q}" == alpha ]]; then echo "${ALPHA}"; else echo "${BRAVO}"; fi)"
    if ! input_has --arg who "${name}" --arg contact "${CONTACT}" '.personas[]|select(.name==$who)|.dm=={enabled:true,contact:$contact}'; then
        edit_input --arg who "${name}" --arg contact "${CONTACT}" '(.personas[]|select(.name==$who)|.dm)={enabled:true,contact:$contact}'
        review_assign "${mode}-enable-dm"
    fi
    successful_tool "${mode}-own-dm" "${dir}" reply "$(jq -cn --arg c "${DM}" --arg t "$(scenario_text own-dm)" '{chat_id:$c,text:$t}')"
    mark="$(log_mark)"
    push_message "${q}" "${GDM}" mpim "$(mention_text "${bot}")"
    wait_since "${mark}" "$(plain_drop "${THREAD_REF}" "${GDM}" group-dm)" "${EVENT_WAIT_S}" 'group DM did not drop'
    expect_queued 'group DM' 0 "${dir}" "${GDM}" "${PUSH_TS}"
    [[ -z "$(shared_thread_joins "${key}" | jq -c --arg dm "${DM}" --arg group "${GDM}" 'select(.channel==$dm or .channel==$group)')" ]] || fail 'DM acquired Thread Memory'
}

permission_outcome_allowed() {
    local outcome
    outcome="$(shared_stub_permission outcome "$1" "$2" "$3")" || return 1
    jq -e '.decision=="allow" and .delivery=="delivered"' <<< "${outcome}" > /dev/null
}
permission_post() {
    local mode="$1" q="$2" number="$3" value="$4" dir key name mark request token button
    thread_persona "${q}"; dir="${THREAD_DIR}"; key="${THREAD_KEY}"
    if [[ "${q}" == alpha ]]; then name="${ALPHA}"; else name="${BRAVO}"; fi
    set_composed_choice "${mode}" "${q}" "${DEST}" "${value}" "${mode}-prompt-${number}-${value}"
    edit_destination "${name}" "${key}" "${mode}-prompt-destination-${number}"
    wait_queue_drained "${dir}"
    mark="$(slack_post_mark)"
    request="$(shared_stub_permission "permission-${number}" "${dir}" "${key}")"
    token="$(jq -er '.request_token' <<< "${request}")"
    # Bash is the registered fixture request's tool, not a copied prompt text.
    PROMPT_POST="$(slack_wait_successful_post "${q}" "${DEST}" "${mark}" Bash)"
    PROMPT_TS="$(jq -er '.ts' <<< "${PROMPT_POST}")"
    if [[ "${value}" == thread_hybrid ]]; then
        wait_until "${EVENT_WAIT_S}" 'confirmed permission prompt did not join' joined_once "${key}" "${DEST}" "${PROMPT_TS}"
    else
        [[ -z "$(shared_thread_joins "${key}" | jq -c --arg c "${DEST}" --arg r "${PROMPT_TS}" 'select(.channel==$c and .root==$r)')" ]] || fail 'off prompt joined'
    fi
    # src/permission-click-handler.ts accepts this nonpersistent Allow prefix.
    button="$(slack_recorded_button "${q}" "${DEST}" "${PROMPT_TS}" perm_allow_)"
    [[ -n "${button}" ]] || fail 'actual permission has no Allow button'
    ack_control "$(slack_push_button "${q}" "${DEST}" "${PROMPT_TS}" perm_allow_ "${HUMAN}")"
    wait_until "${EVENT_WAIT_S}" 'valid prompt response not delivered to registered hook' permission_outcome_allowed "${dir}" "${key}" "${token}"
    # The allowed turn ends through the registered Stop hook; AD reads waiting
    # before any later delivery to this worker.
    shared_stub_permission "complete-${number}" "${dir}" "${key}" "${token}" > /dev/null
}

observe_other_post() {
    local p="$1" q="$2" post="$3" seq ts event
    seq="$(jq -er '.seq' <<< "${post}")"; ts="$(jq -er '.ts' <<< "${post}")"
    event="$(printed sharedObservedPostEvent "${STUB_RECORD}" "${q}" "${DEST}" "${seq}" \
        "$(slack_stub_identity "${q}" user_id)" "$(slack_stub_identity "${q}" bot_id)")"
    PUSHED_EVENTS["${DEST}|${ts}"]="${event}"
    ack_control "$(slack_push_observed_post "${p}" "${q}" "${DEST}" "${seq}")"
}
destination_post_matrix() {
    local mode="$1" p="$2" q="$3" post="$4" kind="$5" value name qname qkey ts dir key ref mark before stamp joins
    ts="$(jq -er '.ts' <<< "${post}")"
    thread_persona "${p}"; dir="${THREAD_DIR}"; key="${THREAD_KEY}"; ref="${THREAD_REF}"
    if [[ "${q}" == alpha ]]; then qname="${ALPHA}"; qkey="${ALPHA_KEY}"; else qname="${BRAVO}"; qkey="${BRAVO_KEY}"; fi
    # The same real post is redelivered after successive choices. Dropped
    # events store no dedupe key; exactly one acceptance occurs at all.
    for value in off mentions thread_hybrid all; do
        set_composed_choice "${mode}" "${p}" "${DEST}" "${value}" "${mode}-${kind}-recipient-${value}"
        mark="$(log_mark)"; observe_other_post "${p}" "${q}" "${post}"
        if [[ "${value}" == all ]]; then
            wait_queued "${mode}-${kind}-other-post" "${dir}" "${DEST}" "${ts}" receive_all "$(slack_stub_identity "${q}" user_id)"
        else
            local reason=not-mentioned; [[ "${value}" != off ]] || reason=channel-off
            wait_since "${mark}" "$(plain_drop "${ref}" "${DEST}" "${reason}")" "${EVENT_WAIT_S}" 'other post has no selection decision'
            expect_queued "${mode}-${kind}-${value}" 0 "${dir}" "${DEST}" "${ts}"
        fi
        if [[ "${value}" == thread_hybrid ]]; then
            matrix_message "${mode}-${kind}-recipient-join" "${p}" "${DEST}" mention "${ts}" mention
            matrix_message "${mode}-${kind}-recipient-follow" "${p}" "${DEST}" plain "${ts}" thread
            before="$(channel_facts "${key}" "${DEST}")"
            stamp="$(printed sharedThreadStamp "${CONFIG}" "${LAST}" "${key}" "${DEST}")"
            joins="$(shared_thread_joins "${key}" "${DEST}" "${stamp}" | jq -scS 'sort_by(.root)')"
            # Q's DM/back edits preserve P's complete choice and joins.
            edit_input --arg who "${qname}" '(.personas[]|select(.name==$who)|.permission_prompts)="dm"'
            review_assign "${mode}-${kind}-destination-dm"
            [[ "$(channel_facts "${key}" "${DEST}")" == "${before}" ]] || fail 'Q destination DM changed P'
            matrix_message "${mode}-${kind}-follow-in-dm" "${p}" "${DEST}" plain "${ts}" thread
            edit_destination "${qname}" "${qkey}" "${mode}-${kind}-destination-back"
            [[ "$(channel_facts "${key}" "${DEST}")" == "${before}" ]] || fail 'Q destination back changed P'
            [[ "$(shared_thread_joins "${key}" "${DEST}" "${stamp}" | jq -scS 'sort_by(.root)')" == "${joins}" ]] || fail 'destination edits changed P joins'
        fi
    done
}

permission_phase() {
    local mode="$1" q="$2" p=alpha qname original
    [[ "${q}" != alpha ]] || p=bravo
    if [[ "${q}" == alpha ]]; then qname="${ALPHA}"; original="${A1}"; else qname="${BRAVO}"; original=dm; fi
    own_posts_phase "${mode}" "${q}"
    permission_post "${mode}" "${q}" 1 off
    permission_post "${mode}" "${q}" 2 thread_hybrid
    destination_post_matrix "${mode}" "${p}" "${q}" "${PROMPT_POST}" prompt
    matrix_message "${mode}-prompt-own-follow" "${q}" "${DEST}" plain "${PROMPT_TS}" thread
    edit_input --arg who "${qname}" --arg dest "${original}" '(.personas[]|select(.name==$who)|.permission_prompts)=$dest'
    review_assign "${mode}-restore-destination"
}

notice_phase() {
    local mode="$1" q="$2" value="${3:-thread_hybrid}" p=alpha dir key name input evidence mark post ts connected phase
    phase="${mode}-notice-${value}"
    [[ "${q}" != alpha ]] || p=bravo
    thread_persona "${q}"; dir="${THREAD_DIR}"; key="${THREAD_KEY}"
    if [[ "${q}" == alpha ]]; then name="${ALPHA}"; input="${A2}"; else name="${BRAVO}"; input="${B1}"; fi
    set_composed_choice "${mode}" "${q}" "${DEST}" "${value}" "${phase}-own-value"
    edit_destination "${name}" "${key}" "${phase}-destination" dm
    wait_queue_drained "${ALPHA_DIR}"; wait_queue_drained "${BRAVO_DIR}"
    evidence="${SCENARIO_ROOT}/${phase}-worker.jsonl"; mark="$(slack_post_mark)"
    connected="$(count_log "$(session_connected "${THREAD_REF}")")"
    shared_stub_notice end "${dir}" "${key}" "${evidence}" > /dev/null
    shared_stub_notice ended "${dir}" "${key}" "${evidence}" > /dev/null
    RECEIPT_MODE["${key}"]=ordinary
    matrix_message "${phase}-trigger" "${q}" "${input}" mention - mention
    post="$(slack_wait_messages_waiting "${q}" "${DEST}" "${mark}" "${name}" "${key}" 1)"
    ts="$(jq -er '.ts' <<< "${post}")"
    shared_stub_notice ended "${dir}" "${key}" "${evidence}" > /dev/null
    if [[ "${value}" == thread_hybrid ]]; then
        wait_until "${EVENT_WAIT_S}" 'actual server notice did not join its own root' joined_once "${key}" "${DEST}" "${ts}"
        destination_post_matrix "${mode}" "${p}" "${q}" "${post}" notice
    else
        [[ -z "$(shared_thread_joins "${key}" | jq -c --arg c "${DEST}" --arg r "${ts}" 'select(.channel==$c and .root==$r)')" ]] || fail 'off notice joined'
    fi
    snapshot_queue "${dir}"
    shared_stub_notice resume "${dir}" "${key}" "${evidence}" > /dev/null
    wait_for_count "$(session_connected "$(persona_ref "${name}")")" $(( connected + 1 )) "${SESSION_WAIT_S}" 'resumed worker did not reopen MCP'
    wait_queue_drained "${dir}"
    preserved_four_values "${mode}-worker-relaunch"
    local want=thread; [[ "${value}" != off ]] || want=channel-off
    matrix_message "${phase}-own-follow" "${q}" "${DEST}" plain "${ts}" "${want}"
}

mode_only() {
    local mode="$1" before_alpha before_bravo alpha_launch bravo_launch alpha_joins bravo_joins
    before_alpha="$(shared_persona_facts "${ALPHA_KEY}" | jq -cS 'del(.mode,.historicalMembership)')"
    before_bravo="$(shared_persona_facts "${BRAVO_KEY}" | jq -cS 'del(.mode,.historicalMembership)')"
    alpha_joins="$(shared_thread_joins "${ALPHA_KEY}" | jq -scS 'sort_by(.channel,.root,.at)')"
    bravo_joins="$(shared_thread_joins "${BRAVO_KEY}" | jq -scS 'sort_by(.channel,.root,.at)')"
    alpha_launch="$(launch_counts "${ALPHA_REF}" "${ALPHA_START}" "${ALPHA_RELAUNCH}")"
    bravo_launch="$(launch_counts "${BRAVO_REF}" "${BRAVO_START}" "${BRAVO_RELAUNCH}")"
    edit_input --arg mode "${mode}" '.channel_mode=$mode'
    review_assign "cycle-two-${mode}"
    [[ "$(shared_persona_facts "${ALPHA_KEY}" | jq -cS 'del(.mode,.historicalMembership)')" == "${before_alpha}" ]] || fail 'cycle two changed alpha choices'
    [[ "$(shared_persona_facts "${BRAVO_KEY}" | jq -cS 'del(.mode,.historicalMembership)')" == "${before_bravo}" ]] || fail 'cycle two changed bravo choices'
    [[ "$(shared_thread_joins "${ALPHA_KEY}" | jq -scS 'sort_by(.channel,.root,.at)')" == "${alpha_joins}" ]] || fail 'mode-only change altered alpha joins'
    [[ "$(shared_thread_joins "${BRAVO_KEY}" | jq -scS 'sort_by(.channel,.root,.at)')" == "${bravo_joins}" ]] || fail 'mode-only change altered bravo joins'
    preserved_four_values "cycle-two-${mode}"
    matrix_message cycle-two-alpha alpha "${A2}" mention - mention
    matrix_message cycle-two-bravo bravo "${B1}" mention - mention
    [[ "$(launch_counts "${ALPHA_REF}" "${ALPHA_START}" "${ALPHA_RELAUNCH}")" == "${alpha_launch}" ]] || fail 'mode-only confirmation launched alpha'
    [[ "$(launch_counts "${BRAVO_REF}" "${BRAVO_START}" "${BRAVO_RELAUNCH}")" == "${bravo_launch}" ]] || fail 'mode-only confirmation launched bravo'
}

# The old leave has already survived the ordinary restart and both modes.
# A new future preference is explicit; replaying that leave cannot remove it.
future_after_leave() {
    local channel="${LEAVE_CHANNELS[strict|all]}" before envelope
    input_choice "${ALPHA}" "${channel}" all
    configuration_request removed-future request "${ALPHA}/${channel}/all" > /dev/null
    pending_has_line "$(printed REVIEW_FUTURE_CLAUSE)" || fail 'future review omits inactive future-choice clause'
    confirm_review removed-future
    choice_is "${ALPHA_KEY}" "${channel}" all || fail 'fresh future value missing'
    before="$(channel_facts "${ALPHA_KEY}" "${channel}")"
    envelope="$(slack_stub_redeliver alpha "${LEAVE_ENVELOPES[strict|all]}")"
    ack_control "${envelope}"
    slack_stub_control_fired redelivery "envelope_id=${envelope}" > /dev/null
    matrix_message future-replay-barrier alpha "${A2}" mention - mention
    [[ "$(channel_facts "${ALPHA_KEY}" "${channel}")" == "${before}" ]] || fail 'old leave removed fresh future preference'
    FUTURE_AFTER_LEAVE_FACTS="${before}"
    NEVER_JOINED_FACTS="$(channel_facts "${ALPHA_KEY}" "${FUTURE}")"
}

# control_fired <event> [field=value...]: a fired control record exists, as a
# wait predicate. slack_stub_control_fired requires one and fails the script
# on the first poll that finds none (lib/scenario.sh).
control_fired() { [[ "$(slack_stub_record_count "$@")" -ge 1 ]]; }

ineligible_and_unverified() {
    local root outside before stamp event mark fault request_id sockets request_ms unclaimed
    # Known, authenticated channel: all writes are refused in open while
    # external sharing makes it ineligible. Its previous joins remain saved.
    member_list alpha "${EXTERNAL}"
    ack_control "$(slack_push_member_joined alpha "${EXTERNAL}" "$(scenario_ts)")"
    wait_until "${EVENT_WAIT_S}" 'external control lacks initial default' choice_is "${ALPHA_KEY}" "${EXTERNAL}" mentions
    wait_membership_complete "${ALPHA}"
    expect_attempt external-hybrid "${ALPHA_DIR}" "$(attempt_args external-hybrid "${EXTERNAL}" thread_hybrid)" "${ALPHA_KEY}" thread_hybrid
    matrix_message external-original-join alpha "${EXTERNAL}" mention - mention
    root="${MATRIX_TS}"; stamp="$(printed sharedThreadStamp "${CONFIG}" "${LAST}" "${ALPHA_KEY}" "${EXTERNAL}")"
    before="$(channel_facts "${ALPHA_KEY}" "${EXTERNAL}")"
    event="$(slack_membership_event member_joined_channel alpha "${EXTERNAL}" "$(scenario_ts)")"
    member_list alpha "${EXTERNAL}" public/external
    ack_control "$(slack_stub_push alpha "${event}" true)"
    wait_membership_complete "${ALPHA}"
    expect_attempt external-refusal "${ALPHA_DIR}" "$(attempt_args external-refusal "${EXTERNAL}" all)" "${ALPHA_KEY}" external-sharing new true
    # The reply carries Slack's external-sharing flag, as the channel now does.
    # Open mode refuses that flag before membership (src/delivery-decision.ts
    # decideFungibleChannel), with X1's unclaimed-channel line.
    unclaimed="$(persona_line "${UNCLAIMED_CHANNEL}" alpha "$(printed fungibleUnclaimedChannelCause "${EXTERNAL}" "${REFUSAL_EXTERNALLY_SHARED}")")"
    mark="$(log_mark)"; new_ts
    push_event alpha "$(slack_reply_event "${EXTERNAL}" "${root}" "$(plain_text)" "${PUSH_TS}" "${HUMAN}")" true
    wait_since "${mark}" "${unclaimed}" "${EVENT_WAIT_S}" 'external joined reply was not excluded'
    expect_queued external-joined-reply 0 "${ALPHA_DIR}" "${EXTERNAL}" "${PUSH_TS}"
    outside="$(scenario_ts)"
    successful_tool external-own-post "${ALPHA_DIR}" reply "$(jq -cn --arg c "${EXTERNAL}" --arg r "${outside}" --arg t "$(scenario_text ineligible-post)" '{chat_id:$c,thread_ts:$r,text:$t}')"
    [[ "$(join_count "${ALPHA_KEY}" "${EXTERNAL}" "${outside}")" == 0 ]] || fail 'ineligible own post joined'
    [[ "$(channel_facts "${ALPHA_KEY}" "${EXTERNAL}")" == "${before}" ]] || fail 'ineligibility changed the saved choice/stamp'
    member_list alpha "${EXTERNAL}"
    ack_control "$(slack_push_member_joined alpha "${EXTERNAL}" "$(scenario_ts)")"
    wait_membership_complete "${ALPHA}"
    matrix_message external-restored-follow alpha "${EXTERNAL}" plain "${root}" thread
    matrix_message external-post-stays-unjoined alpha "${EXTERNAL}" plain "${outside}" not-mentioned
    [[ "$(printed sharedThreadStamp "${CONFIG}" "${LAST}" "${ALPHA_KEY}" "${EXTERNAL}")" == "${stamp}" ]] || fail 'eligibility recovery reset participation'
    # No known membership or saved entry: the actual MCP refusal is distinct
    # from the following saved-but-unverified channel.
    expect_attempt unknown-refusal "${ALPHA_DIR}" "$(attempt_args unknown-refusal "${U0}" all)" "${ALPHA_KEY}" channel-removed new true
    choice_is "${ALPHA_KEY}" "${U0}" '' || fail 'unknown target acquired a choice'
    before="$(channel_facts "${ALPHA_KEY}" "${M_MENTIONS}")"
    sockets="$(slack_stub_record_count ws-open label=alpha)"
    # This is a successful inventory answer with a bounded transport delay,
    # below the production per-request deadline, not a lost answer or failed
    # scan. A delay past that deadline would be recorded as an abort.
    request_ms="$(printed MEMBERSHIP_REQUEST_TIMEOUT_MS)"
    slack_stub_inventory_fault alpha '' delay "delay_ms=$(( request_ms * 4 / 5 ))"
    slack_stub_close_socket alpha 0
    wait_until "${RECORD_WAIT_S}" 'socket close control did not fire' control_fired socket-close label=alpha > /dev/null
    wait_until "${RECORD_WAIT_S}" 'new socket did not open' rec_at_least $(( sockets + 1 )) event=ws-open label=alpha
    wait_until "${RECORD_WAIT_S}" 'inventory delay did not fire' control_fired fault label=alpha method=users.conversations outcome=delay > /dev/null
    fault="$(slack_stub_control_fired fault label=alpha method=users.conversations outcome=delay)"
    request_id="$(jq -er '.request_id' <<< "${fault}")"
    [[ "$(slack_stub_record_count fault-settled "request_id=${request_id}")" == 0 ]] || fail 'inventory resolved before unverified case'
    expect_attempt unverified-refusal "${ALPHA_DIR}" "$(attempt_args unverified-refusal "${M_MENTIONS}" all)" "${ALPHA_KEY}" current-membership-missing new true
    [[ "$(slack_stub_record_count fault-settled "request_id=${request_id}")" == 0 ]] || fail 'unverified result was observed after inventory resolved'
    [[ "$(channel_facts "${ALPHA_KEY}" "${M_MENTIONS}")" == "${before}" ]] || fail 'unverified bot write changed saved facts'
    wait_until 30 'successful delayed inventory did not settle' control_fired fault-settled "request_id=${request_id}" resolution=delay > /dev/null
    # Every later control post re-arms faults still in the control file.
    slack_stub_faults_clear alpha
    wait_membership_complete "${ALPHA}"
    matrix_message reverified-mention alpha "${M_MENTIONS}" mention - mention
    [[ "$(channel_facts "${ALPHA_KEY}" "${FUTURE}")" == "${NEVER_JOINED_FACTS}" ]] || fail 'repeat empty reconciliation removed never-joined preference'
    [[ "$(channel_facts "${ALPHA_KEY}" "${LEAVE_CHANNELS[strict|all]}")" == "${FUTURE_AFTER_LEAVE_FACTS}" ]] || fail 'repeat absence removed fresh future preference'
}

rejoin_after_absence() {
    local mode value channel want root
    for mode in strict open; do
        for value in off mentions all thread_hybrid; do
            channel="${LEAVE_CHANNELS[${mode}|${value}]}"; want=mentions
            [[ "${mode}|${value}" != 'strict|all' ]] || want=all
            member_list alpha "${channel}"
            ack_control "$(slack_push_member_joined alpha "${channel}" "$(scenario_ts)")"
            wait_until "${EVENT_WAIT_S}" 'rejoin inherited an old preference' choice_is "${ALPHA_KEY}" "${channel}" "${want}"
            wait_membership_complete "${ALPHA}"
            [[ -z "$(shared_thread_since "${ALPHA_KEY}" "${channel}")" ]] || fail 'rejoin inherited old Thread Hybrid Since'
            matrix_message "rejoin-${mode}-${value}" alpha "${channel}" mention - mention
            if [[ "${want}" == all ]]; then
                matrix_message fresh-future-all alpha "${channel}" plain - receive_all
            fi
            if [[ "${value}" == thread_hybrid ]]; then
                root="${LEAVE_ROOTS[${mode}]}"
                matrix_message "rejoin-${mode}-old-default" alpha "${channel}" plain "${root}" not-mentioned
                expect_attempt "rejoin-${mode}-hybrid" "${ALPHA_DIR}" "$(attempt_args "rejoin-${mode}-hybrid" "${channel}" thread_hybrid)" "${ALPHA_KEY}" thread_hybrid
                matrix_message "rejoin-${mode}-old-hybrid" alpha "${channel}" plain "${root}" not-mentioned
                matrix_message "rejoin-${mode}-fresh-join" alpha "${channel}" mention "${root}" mention
                matrix_message "rejoin-${mode}-fresh-follow" alpha "${channel}" plain "${root}" thread
            fi
        done
    done
}

identity_replacement() {
    local incarnation sibling stamp root copied_order connected replacement expected
    wait_queue_drained "${ALPHA_DIR}"; wait_queue_drained "${BRAVO_DIR}"
    incarnation="$(shared_persona_facts "${ALPHA_KEY}" | jq -er .incarnation)"
    sibling="$(shared_persona_facts "${BRAVO_KEY}" | jq -cS 'del(.historicalMembership)')"
    root="${MATRIX_ROOTS[open|thread_hybrid]}"
    # Both source values were reviewed before replacement: only the explicit
    # retention listed in this review survives into the new incarnation.
    input_choice "${ALPHA}" "${WRITE_CHANNEL}" thread_hybrid
    review_assign identity-before "${ALPHA}/${WRITE_CHANNEL}/thread_hybrid"
    matrix_message identity-retained-root alpha "${WRITE_CHANNEL}" mention - mention
    IDENTITY_RETAINED_ROOT="${MATRIX_TS}"
    stamp="$(shared_thread_since "${ALPHA_KEY}" "${WRITE_CHANNEL}")"
    copied_order="$(assignment_order "${ALPHA_KEY}" "${M_HYBRID}")"
    wait_queue_drained "${ALPHA_DIR}"
    replacement="${CREDS_DIR}/alpha-replacement.json"
    cp -- "${ALPHA_CREDS}" "${replacement}"; chmod 600 "${replacement}"
    edit_input --arg who "${ALPHA}" --arg path "${replacement}" '(.personas[]|select(.name==$who)|.credentials_file)=$path'
    configuration_request identity-replacement request "${ALPHA}/${WRITE_CHANNEL}/thread_hybrid" > /dev/null
    pending_has_line "$(printed REVIEW_RESET_CLAUSE)" || fail 'identity review omitted reset loss'
    pending_has_line "$(printed REVIEW_RETENTION_CLAUSE)" || fail 'identity review omitted explicit retention'
    pending_has_line "${replacement}" || fail 'identity review hid the configured credentials path'
    expect_preview_choice "${ALPHA_KEY}" "${M_HYBRID}" reset thread_hybrid - unresolved thread_hybrid unlisted "${copied_order}" replacement=true
    expected="$(printed reviewedChannelLine "${ALPHA_KEY}" "${WRITE_CHANNEL}" declared - thread_hybrid unresolved unlisted 'unverified (current-membership-missing)' replacement=true inherited=thread_hybrid)"
    pending_has_line "${expected}" || fail 'identity review did not distinguish explicit same-value retention'
    connected="$(count_log "$(session_connected "${ALPHA_REF}")")"
    # This confirmation tears down and launches a real worker, unlike an
    # in-place value/destination review; use the existing startup bound.
    confirm_review identity-replacement "${START_WAIT_S}"
    wait_for_count "$(session_connected "${ALPHA_REF}")" $(( connected + 1 )) "${SESSION_WAIT_S}" 'replacement worker did not connect'
    wait_membership_complete "${ALPHA}"
    [[ "$(shared_persona_facts "${ALPHA_KEY}" | jq -er .incarnation)" != "${incarnation}" ]] || fail 'identity did not change incarnation'
    [[ "$(shared_persona_facts "${BRAVO_KEY}" | jq -cS 'del(.historicalMembership)')" == "${sibling}" ]] || fail 'identity replacement changed sibling'
    choice_is "${ALPHA_KEY}" "${M_HYBRID}" mentions || fail 'copied hybrid preference survived identity reset'
    [[ -z "$(shared_thread_since "${ALPHA_KEY}" "${M_HYBRID}")" ]] || fail 'copied hybrid stamp survived identity reset'
    choice_is "${ALPHA_KEY}" "${WRITE_CHANNEL}" thread_hybrid || fail 'explicit retained choice lost'
    [[ "$(shared_thread_since "${ALPHA_KEY}" "${WRITE_CHANNEL}")" != "${stamp}" ]] || fail 'identity reset retained old hybrid stamp'
    matrix_message identity-copied-old-reply alpha "${M_HYBRID}" plain "${root}" not-mentioned
    matrix_message identity-retained-old-reply alpha "${WRITE_CHANNEL}" plain "${IDENTITY_RETAINED_ROOT}" not-mentioned
    matrix_message identity-new-join alpha "${WRITE_CHANNEL}" mention "${IDENTITY_RETAINED_ROOT}" mention
    matrix_message identity-new-follow alpha "${WRITE_CHANNEL}" plain "${IDENTITY_RETAINED_ROOT}" thread
}

# Read only metadata from the actual journal. Waiting for every queued join
# to be saved makes startup's removal of delivered content deterministic.
# No fixture writes a Thread Memory journal or invents a Channel Stamp.
thread_joins_saved() {
    local key="${QUEUE_KEY[$1]}" fact channel root stamp current items
    items="$(shared_queue_items "${key}" | jq -c 'select(.thread_join)')" || return 1
    while IFS= read -r fact; do
        [[ -n "${fact}" ]] || continue
        channel="$(jq -r '.channel' <<< "${fact}")"
        root="$(jq -r '.thread_join.thread_ts' <<< "${fact}")"
        stamp="$(jq -cS '.thread_join.stamp' <<< "${fact}")"
        [[ "$(shared_channel_saved "${key}" "${channel}")" == thread_hybrid ]] || continue
        current="$(printed sharedThreadStamp "${CONFIG}" "${LAST}" "${key}" "${channel}" | jq -cS .)"
        [[ "${stamp}" == "${current}" ]] || continue
        [[ "$(shared_thread_joins "${key}" "${channel}" "${current}" | jq -s --arg root "${root}" '[.[]|select(.root==$root)]|length')" == 1 ]] || return 1
    done <<< "${items}"
}
accepted_join_saved() {
    local item stamp root
    item="$(shared_queue_items "$1" | jq -c --arg c "$2" --arg ts "$3" 'select(.channel==$c and .ts==$ts)')" || return 1
    [[ -n "${item}" ]] || return 1
    [[ "$(jq -r 'has("thread_join")' <<< "${item}")" == true ]] || return 0
    stamp="$(jq -c '.thread_join.stamp' <<< "${item}")"
    root="$(jq -r '.thread_join.thread_ts' <<< "${item}")"
    [[ "$(shared_thread_joins "$1" "$2" "${stamp}" | jq -s --arg root "${root}" '[.[]|select(.root==$root)]|length')" == 1 ]]
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

# Failure observation, before the trap stops anything, unless the script
# reached its PASS line. Diagnostic only: each persona's last queue rows,
# its stub hook records and control commands, and its agent-director row,
# as whitelisted fields, never message text, hook payloads or tokens. Its
# setup reads cannot fail the script, and its agent-director read is bounded.
ALPHA_ID="$(printed personaInstanceId "${ALPHA_KEY}" 2> /dev/null)" || ALPHA_ID=''
BRAVO_ID="$(printed personaInstanceId "${BRAVO_KEY}" 2> /dev/null)" || BRAVO_ID=''
OBSERVE_SAFE='def safe: if . == null then "absent" else tostring | if test("^[A-Za-z0-9_.:+-]{1,64}$") and (test("^xox") | not) then . else "invalid" end end;
    def word: if . == null then "absent" else tostring | if test("^[A-Za-z][A-Za-z0-9_-]{0,39}$") and (test("^xox") | not) then . else "invalid" end end;'
OBSERVE_ON_EXIT=1
OBSERVE_ROWS=5
exit_observe() {
    local name dir id file session line hooks
    [[ "${OBSERVE_ON_EXIT}" == 1 ]] || return 0
    for name in alpha bravo; do
        case "${name}" in
            alpha) dir="${ALPHA_DIR}" id="${ALPHA_ID}" ;;
            bravo) dir="${BRAVO_DIR}" id="${BRAVO_ID}" ;;
        esac
        if [[ -f "${DELIVERIES_FILE[${dir}]}" ]]; then
            jq -r -R -n --arg name "${name}" --argjson n "${OBSERVE_ROWS}" "${OBSERVE_SAFE}"'
                [inputs | fromjson? | select(type == "object")] | .[-$n:][] |
                "exit-observe: persona=\($name) queue kind=\(.kind|word) seq=\(.seq|safe) send_kind=\(.send_kind|word) at=\(.at|safe)"' \
                "${DELIVERIES_FILE[${dir}]}" 2> /dev/null || printf 'exit-observe: persona=%s queue=unreadable\n' "${name}"
        else
            printf 'exit-observe: persona=%s queue=absent\n' "${name}"
        fi
        if [[ -z "${id}" ]]; then
            printf 'exit-observe: persona=%s instance=unavailable\n' "${name}"
            continue
        fi
        hooks=()
        for file in "${STUB_BIN}"/stub-claude-hooks.*.jsonl; do
            [[ ! -f "${file}" ]] || hooks+=("${file}")
        done
        if (( ${#hooks[@]} > 0 )); then
            jq -r -R -n --arg id "${id}" --arg name "${name}" --argjson n "${OBSERVE_ROWS}" "${OBSERVE_SAFE}"'
                [inputs | fromjson? | select(type == "object" and .instance_id == $id)] |
                sort_by(.at | tonumber? // 0) | .[-$n:][] |
                "exit-observe: persona=\($name) stub_hook command=\(.command|word) event=\(.event|word) session_id=\(.session_id|safe) pid=\(.pid|safe) at=\(.at|safe)"' \
                "${hooks[@]}" 2> /dev/null || printf 'exit-observe: persona=%s stub_hook=unreadable\n' "${name}"
        fi
        if timeout 10 agent-director get --instance-id "${id}" > "${SCENARIO_ROOT}/exit-observe.${name}.ad" 2> /dev/null; then
            session="$(jq -r --arg name "${name}" "${OBSERVE_SAFE}"'
                "exit-observe: persona=\($name) ad_state=\(.state|word) session_id=\(.session_id|safe) launch_started_at=\(.launch_started_at|safe) last_seen_at=\(.last_seen_at|safe) ended_at=\(.ended_at|safe)",
                (.session_id|safe)' "${SCENARIO_ROOT}/exit-observe.${name}.ad" 2> /dev/null)" \
                || { printf 'exit-observe: persona=%s ad=unreadable\n' "${name}"; continue; }
            printf '%s\n' "${session%$'\n'*}"
            session="${session##*$'\n'}"
            file="${STUB_BIN}/stub-claude-hooks.${session}"
            if [[ "${session}" =~ ^[a-f0-9-]{36}$ && -f "${file}" ]]; then
                while IFS= read -r line; do
                    [[ "${line}" =~ ^[a-z0-9-]{1,32}$ ]] || line=invalid
                    printf 'exit-observe: persona=%s control=%s\n' "${name}" "${line}"
                done < "${file}"
            else
                printf 'exit-observe: persona=%s control=absent\n' "${name}"
            fi
        else
            printf 'exit-observe: persona=%s ad=unavailable\n' "${name}"
        fi
    done
}
# A failure inside a call whose stdout is discarded (`> /dev/null`) runs the
# hooks with that stdout, so the dump goes to stderr.
exit_observe_stderr() { exit_observe >&2; }
on_before_cleanup exit_observe_stderr

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

# Shared builders own identities and installation envelopes.
slack_stub_control_seed "${STUB_CONTROL}" "${ALPHA_LABEL}" "${ALPHA_SUFFIX}" "${BRAVO_LABEL}" "${BRAVO_SUFFIX}"
SCENARIO_SLACK_RECORD="${STUB_RECORD}"

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
slack_stub_controls "${STUB_CONTROL}"
ALPHA_MEMBERS=("${A1}" "${A2}" "${F1}" "${F2}/private" "${U1}" "${T1}" "${N1}" "${N2}" "${N3}")
BRAVO_MEMBERS=("${B1}" "${A1}" "${F1}" "${F2}/private" "${U1}" "${T1}" "${N1}" "${N2}" "${N3}")
slack_stub_inventory_page "${ALPHA_LABEL}" '' '' "${ALPHA_MEMBERS[@]}"
slack_stub_inventory_page "${BRAVO_LABEL}" '' '' "${BRAVO_MEMBERS[@]}"

# --- Configurations --------------------------------------------------------
# write_persona_config <declarative|fungible|switch-off>:
# - declarative: the 0.11.x shape of the contract (neither key of this work);
# - fungible: open mode plus explicit mentions/all choices for discovered
# channels; alpha's permission destination remains A1 ;
# - switch-off: the same reviewed choices with strict mode.
# Every shape turns Slack reply reminders off for both personas
# (stop_hook_bootstrap): a reminder nudge is a delivery, and in manual
# receipt mode it would take a receipt release meant for a real item.
write_persona_config() {
    local switch='' extra_alpha='' extra_bravo=''
    local at=off an1=off an2=mentions an3=all bt=off bn1=off bn2=mentions bn3=all
    if [[ "${ALPHA_THREADS:-false}" == true ]]; then
        at=thread_hybrid an1=thread_hybrid an2=thread_hybrid an3=thread_hybrid
    fi
    case "$1" in
        declarative) ;;
        fungible|switch-off)
            local mode='open'
            [[ "$1" == 'switch-off' ]] && mode='strict'
            switch=$'\n  "'"${SWITCH_KEY}"'": "'"${mode}"'",'
            extra_alpha=', { "id": "'"${F1}"'", "delivery": "mentions" }, { "id": "'"${U1}"'", "delivery": "all" }'
            extra_bravo=', { "id": "'"${F1}"'", "delivery": "mentions" }, { "id": "'"${F2}"'", "delivery": "mentions" }, { "id": "'"${A1}"'", "delivery": "mentions" }, { "id": "'"${U1}"'", "delivery": "all" }'
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
      "stop_hook_bootstrap": false,
      "channels": [
        { "id": "${A1}", "delivery": "all" },
        { "id": "${A2}", "delivery": "mentions" },
        { "id": "${T1}", "delivery": "${at}" },
        { "id": "${N1}", "delivery": "${an1}" },
        { "id": "${N2}", "delivery": "${an2}" },
        { "id": "${N3}", "delivery": "${an3}" }${extra_alpha}
      ],
      "dm": { "enabled": false },
      "permission_prompts": "${A1}"
    },
    {
      "name": "${BRAVO}",
      "credentials_file": "${BRAVO_CREDS}",
      "working_directory": "${BRAVO_DIR}",
      "stop_hook_bootstrap": false,
      "channels": [{ "id": "${B1}", "delivery": "mentions" },
        { "id": "${T1}", "delivery": "${bt}" },
        { "id": "${N1}", "delivery": "${bn1}" },
        { "id": "${N2}", "delivery": "${bn2}" },
        { "id": "${N3}", "delivery": "${bn3}" }${extra_bravo}],
      "dm": { "enabled": true, "contact": "${CONTACT}" },
      "permission_prompts": "dm"
    }
  ],
  "bind": "127.0.0.1",
  "port": ${SCENARIO_PORT},
  "health_check_interval": 0,
  "session_restart_delay": 0,
  "exit_timeout": 5,
  "mcp_config_path": "${MCP_CONFIG}"
}
EOF
    if [[ "${MATRIX_READY:-false}" == true ]]; then
        input_choice "${ALPHA}" "${M_OFF}" off
        input_choice "${ALPHA}" "${M_MENTIONS}" mentions
        input_choice "${ALPHA}" "${M_ALL}" all
        input_choice "${ALPHA}" "${M_HYBRID}" thread_hybrid
        input_choice "${ALPHA}" "${WRITE_CHANNEL}" off
        input_choice "${ALPHA}" "${FUTURE}" all
    fi
}

# --- Start --------------------------------------------
ALPHA_THREADS=false
write_persona_config declarative
shared_stub_permission_setup "${ALPHA_DIR}" > /dev/null
shared_stub_permission_setup "${BRAVO_DIR}" > /dev/null
RECEIPT_MODE["${ALPHA_KEY}"]=manual
RECEIPT_MODE["${BRAVO_KEY}"]=manual
CONFIG_A_COPY="${SCENARIO_ROOT}/config-phase-a.json"
cp -- "${CONFIG}" "${CONFIG_A_COPY}"

# Reachable packed-server variant: no authenticated connection during the
# directory hold. A failed push is evidence of refusal, never accepted ingress.
ALPHA_COLD_SAVED="${SCENARIO_ROOT}/cold-start-alpha"
mv -- "${ALPHA_DIR}" "${ALPHA_COLD_SAVED}"
start_server --live
# Fragments in the line's own order: ref, then path, then the cause.
wait_for_log "$(matcher "${ALPHA_REF}" "path=\"${ALPHA_DIR}\"" "${DIRECTORY_MISSING_CAUSE}")" "${START_WAIT_S}" "cold start: no directory failure"
wait_membership_complete "${BRAVO}"
wait_for_log "${STARTUP_COMPLETE}" "${START_WAIT_S}" 'cold start: initial start pass did not finish'
expect_completion 2 'cold start' '1 not brought up'
[[ "$(rec_count event=ws-open label="${ALPHA_LABEL}")" == 0 ]] || fail 'cold start: held persona opened Slack'
[[ -z "$(shared_queue_items "${ALPHA_KEY}")" ]] || fail 'cold start: held persona accepted work'
[[ ! -d "${ALPHA_TRANSCRIPTS}" ]] || fail 'cold start: held persona launched a worker'
reason="$(slack_stub_push --expect-refused "${ALPHA_LABEL}" "$(slack_message_event "${A1}" "$(scenario_text cold-start-refused)" "$(scenario_ts)" "${HUMAN}")")"
[[ "${reason}" == "${NO_OPEN_SOCKET}" ]] || fail 'cold start: expected no connection'
wait_until "${RECORD_WAIT_S}" 'cold start: no recorded refused push' \
    rec_at_least 1 event=push-refused label="${ALPHA_LABEL}" reason="${NO_OPEN_SOCKET}"
mkdir -- "${ALPHA_DIR}"
mv -- "${ALPHA_COLD_SAVED}/.git" "${ALPHA_DIR}/.git"
rmdir -- "${ALPHA_COLD_SAVED}"
wait_for_log "$(matcher "persona ${ALPHA_REF}: up after its bring-up retry (directory)")" "${START_WAIT_S}" "cold start: automatic retry did not recover"
wait_membership_complete "${ALPHA}"

# The texts, printed while the start pass brings the personas up.
UNCLAIMED_CHANNEL="$(printed UNCLAIMED_CHANNEL)"
PERSONA_INVITED_CHANNEL="$(printed PERSONA_INVITED_CHANNEL)"
PERSONA_CHANNEL_DELIVERY_SET="$(printed PERSONA_CHANNEL_DELIVERY_SET)"
SWITCH_KEY="$(printed MODE_SWITCH_SETTING)"
FUNGIBLE="$(printed channelModeOf open)"
DECLARATIVE="$(printed channelModeOf strict)"
STORE_FILE="${SLACK_STATE_DIR}/$(printed CHANNEL_DELIVERY_FILE_NAME)"
SET_TOOL="$(printed SET_CHANNEL_DELIVERY_TOOL)"
APPLIED_CLASS="[slack] $(printed RELOAD_APPLIED):"
SUPERSEDED_OUTCOME="$(printed reviewOutcomeLine superseded)"
STALE_CONFIRMATION_CLASS="$(printed RELOAD_STALE_CONFIRMATION)"
STALE_CONFIRMATION="$(matcher "[slack] ${STALE_CONFIRMATION_CLASS}:" "\"${APPLY}\"")"
NO_CHOICE="$(printed NO_STORED_CHOICE)"
SWITCH_ON_LINE="$(printed modeSwitchLine "${FUNGIBLE}" "${ALPHA}" "${BRAVO}")"
SWITCH_OFF_LINE="$(printed modeSwitchLine "${DECLARATIVE}" "${ALPHA}" "${BRAVO}")"
REASON_EXTERNALLY_SHARED="$(printed UNCLAIMED_REASON_EXTERNALLY_SHARED)"
REASON_FLAG_MISSING="$(printed UNCLAIMED_REASON_FLAG_MISSING)"
REASON_FLAG_NOT_BOOLEAN="$(printed UNCLAIMED_REASON_FLAG_NOT_BOOLEAN)"
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
F1_SET_CAUSE="$(printed channelDeliverySetCause "${F1}" mentions all all)"
F1_SET_AGAIN_CAUSE="$(printed channelDeliverySetCause "${F1}" all all all)"
A1_SET_ALL_CAUSE="$(printed channelDeliverySetCause "${A1}" mentions all all)"
F1_UNCLAIMED="$(persona_line "${UNCLAIMED_CHANNEL}" alpha "${F1_CAUSE}")"
X1_UNCLAIMED="$(persona_line "${UNCLAIMED_CHANNEL}" alpha "${X1_CAUSE}")"
X2_UNCLAIMED="$(persona_line "${UNCLAIMED_CHANNEL}" alpha "${X2_CAUSE}")"
X3_UNCLAIMED="$(persona_line "${UNCLAIMED_CHANNEL}" alpha "${X3_CAUSE}")"
ALPHA_HEARS_F1="$(persona_line "${PERSONA_INVITED_CHANNEL}" alpha "${F1_HEARD_CAUSE}")"
ALPHA_HEARS_F1_ALL="$(persona_line "${PERSONA_INVITED_CHANNEL}" alpha "${F1_HEARD_ALL_CAUSE}")"
ALPHA_HEARS_A1="$(persona_line "${PERSONA_INVITED_CHANNEL}" alpha "$(printed invitedChannelCause "${A1}" public all)")"
BRAVO_HEARS_F2="$(persona_line "${PERSONA_INVITED_CHANNEL}" bravo "${F2_HEARD_CAUSE}")"
BRAVO_HEARS_A1="$(persona_line "${PERSONA_INVITED_CHANNEL}" bravo "${A1_HEARD_CAUSE}")"
ALPHA_SET_F1="$(persona_line "${PERSONA_CHANNEL_DELIVERY_SET}" alpha "${F1_SET_CAUSE}")"
ALPHA_SET_F1_AGAIN="$(persona_line "${PERSONA_CHANNEL_DELIVERY_SET}" alpha "${F1_SET_AGAIN_CAUSE}")"
BRAVO_SET_A1="$(persona_line "${PERSONA_CHANNEL_DELIVERY_SET}" bravo "${A1_SET_ALL_CAUSE}")"
BRAVO_SET_F1="$(persona_line "${PERSONA_CHANNEL_DELIVERY_SET}" bravo "${F1_SET_CAUSE}")"
# alpha's persona-invited-channel head, whatever the cause: its line printed
# with a marker cause and cut there.
INVITED_MARKER="${TEST_NAME}-cause-marker"
ALPHA_INVITED_LINE="$(persona_line "${PERSONA_INVITED_CHANNEL}" alpha "${INVITED_MARKER}")"
[[ "${ALPHA_INVITED_LINE}" == *"${INVITED_MARKER}" && -n "${ALPHA_INVITED_LINE%"${INVITED_MARKER}"}" ]] \
    || fail "fmk-texts: formatPersonaDiagnostic does not end in its cause after a head"
ALPHA_INVITED_HEAD="${ALPHA_INVITED_LINE%"${INVITED_MARKER}"}"
ALPHA_DECLARATIVE_REFUSAL="$(printed channelDeliveryDeclarativeRefusal "${ALPHA}" "${ALPHA_KEY}")"
BAD_DELIVERY='everything'
ALPHA_VALUE_REFUSAL="$(printed channelDeliveryValueRefusal "${ALPHA}" "${ALPHA_KEY}" "${BAD_DELIVERY}")"
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
F1_ALL_ARGS="$(attempt_args "${TEST_NAME}-alpha-f1-initial" "${F1}" all)"
BRAVO_F1_ALL_ARGS="$(attempt_args "${TEST_NAME}-bravo-f1-initial" "${F1}" all)"
BRAVO_A1_ALL_ARGS="$(attempt_args "${TEST_NAME}-bravo-a1-initial" "${A1}" all)"
F1_RETRY_ARGS="$(attempt_args "${TEST_NAME}-alpha-f1-initial" "${F1}" all retry)"
F1_FRESH_ARGS="$(attempt_args "${TEST_NAME}-alpha-f1-after-restart" "${F1}" all)"
STRICT_FRESH_ARGS="$(attempt_args "${TEST_NAME}-strict-fresh" "${F1}" all)"
X1_ARGS="$(attempt_args "${TEST_NAME}-unverified-x1" "${X1}" all)"

wait_for_log "${STARTUP_COMPLETE}" "${START_WAIT_S}" "start: the start pass never completed"
expect_completion 2 "start" "1 not brought up"
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

# Positive control: a push to a label no persona's token carries is
# refused, and the stub records the refusal.
unknown_event="$(message_event "${A1}" channel "$(plain_text)" "$(scenario_ts)")"
reason="$(slack_stub_push --expect-refused "${UNKNOWN_LABEL}" "${unknown_event}")"
[[ "${reason}" == "${NO_OPEN_SOCKET}" ]] \
    || fail "start: the push to unknown label ${UNKNOWN_LABEL} was refused as '${reason}', not ${NO_OPEN_SOCKET}"
wait_until "${RECORD_WAIT_S}" "start: the stub's record holds no push-refused line for ${UNKNOWN_LABEL}" \
    rec_at_least 1 event=push-refused label="${UNKNOWN_LABEL}" reason="${NO_OPEN_SOCKET}"
[[ "$(rec_count event=push label="${UNKNOWN_LABEL}")" == 0 ]] || fail "start: the stub sent a push to ${UNKNOWN_LABEL}"

# --- Phase A: a 0.11.x configuration ----------------------------
# check_upgrade_log <step>: no server.log line names the switch's key,
# fungible mode, or a class or line this work adds.
check_upgrade_log() {
    local term
    for term in "${SWITCH_KEY}" "${FUNGIBLE}" "${PERSONA_INVITED_CHANNEL}" "${PERSONA_CHANNEL_DELIVERY_SET}" \
        ; do
        [[ -n "${term}" ]] || fail "$1: an empty term from the printer"
        [[ "$(count_server_log "${term}")" == 0 ]] || fail "$1: server.log names '${term}' in declarative mode"
    done
}

cmp -s -- "${CONFIG}" "${CONFIG_A_COPY}" || fail "phase A: config.json is not its copy, byte for byte"
[[ -f "${LAST}" ]] || fail "phase A: config.json.last-applied was not written"
configuration_record_matches "${CONFIG}" "${LAST}" reviewed > /dev/null || fail "phase A: reviewed input differs from config.json"
# Compare the complete set of saved assignments, including the configured
# values and strict discovery defaults. U0 must remain genuinely unlisted.
check_phase_a_inventory() {
    local key channel expected actual
    for key in "${ALPHA_KEY}" "${BRAVO_KEY}"; do
        if [[ "${key}" == "${ALPHA_KEY}" ]]; then
            expected="$(printf '%s\n' "${A1}" "${A2}" "${F1}" "${F2}" "${U1}" "${T1}" "${N1}" "${N2}" "${N3}" | sort)"
        else
            expected="$(printf '%s\n' "${B1}" "${A1}" "${F1}" "${F2}" "${U1}" "${T1}" "${N1}" "${N2}" "${N3}" | sort)"
        fi
        actual="$(shared_persona_facts "${key}" | jq -r '.assignments | keys[]' | sort)"
        [[ "${actual}" == "${expected}" ]] || return 1
        for channel in "${F1}" "${F2}" "${U1}"; do
            [[ "$(shared_channel_saved "${key}" "${channel}")" == off ]] || return 1
        done
        [[ "$(shared_channel_saved "${key}" "${T1}")" == off ]] || return 1
        [[ "$(shared_channel_saved "${key}" "${N1}")" == off ]] || return 1
        [[ "$(shared_channel_saved "${key}" "${N2}")" == mentions ]] || return 1
        [[ "$(shared_channel_saved "${key}" "${N3}")" == all ]] || return 1
        if [[ "${key}" == "${ALPHA_KEY}" ]]; then
            [[ "$(shared_channel_saved "${key}" "${A1}")" == all ]] || return 1
            [[ "$(shared_channel_saved "${key}" "${A2}")" == mentions ]] || return 1
        else
            [[ "$(shared_channel_saved "${key}" "${A1}")" == off ]] || return 1
            [[ "$(shared_channel_saved "${key}" "${B1}")" == mentions ]] || return 1
        fi
        [[ -z "$(shared_channel_saved "${key}" "${U0}")" ]] || return 1
    done
}

check_phase_a_inventory || fail "phase A: applied configuration differs from the exact discovered strict choices"
[[ ! -e "${SLACK_STATE_DIR}/channel-delivery.json" ]] || fail "phase A: a legacy store was created"
check_upgrade_log "phase A after the start"

# alpha A1 plain: delivered `receive_all`, found in the accepted queue record (the
# first-delivery control).
push_message "${ALPHA_LABEL}" "${A1}" channel "$(plain_text)"
A_A1_TS="${PUSH_TS}"
wait_queued "phase A: alpha A1 plain" "${ALPHA_DIR}" "${A1}" "${A_A1_TS}" "${VIA_RECEIVE_ALL}"

# alpha U1 is discovered off: a message cannot select it or turn it on.
A_OFF_MARK="$(log_mark)"
push_message "${ALPHA_LABEL}" "${U1}" channel "$(mention_text "${ALPHA_BOT_USER}")"
A_OFF_TS="${PUSH_TS}"
wait_since "${A_OFF_MARK}" "$(plain_drop "${ALPHA_REF}" "${U1}" "${DROP_CHANNEL_OFF}")" "${EVENT_WAIT_S}" "phase A: discovered U1 did not drop as off"
expect_queued "phase A: discovered alpha U1" 0 "${ALPHA_DIR}" "${U1}" "${A_OFF_TS}"

# alpha U0, absent from the completed inventory: one mention as both its
# events, exactly two `channel-ineligible` drops and no delivery. Established
# absence is a drop, not an unresolved hold; drops store no durable dedupe fact.
A_U0_MARK="$(log_mark)"
push_mention "${ALPHA_LABEL}" "${U0}" channel "$(mention_text "${ALPHA_BOT_USER}")" app-first
A_U0_TS="${PUSH_TS}"
wait_since "${A_U0_MARK}" "$(plain_drop "${ALPHA_REF}" "${U0}" "${DROP_CHANNEL_INELIGIBLE}")" "${EVENT_WAIT_S}" "phase A: alpha U0: no channel-ineligible line"
expect_queued "phase A: alpha U0" 0 "${ALPHA_DIR}" "${U0}" "${A_U0_TS}"

# alpha A2 plain: a `not-mentioned` drop, no delivery.
A_A2_MARK="$(log_mark)"
push_message "${ALPHA_LABEL}" "${A2}" channel "$(plain_text)"
A_A2_TS="${PUSH_TS}"
wait_since "${A_A2_MARK}" "$(plain_drop "${ALPHA_REF}" "${A2}" "${DROP_NOT_MENTIONED}")" "${EVENT_WAIT_S}" \
    "phase A: alpha A2 plain: no not-mentioned line"
expect_queued "phase A: alpha A2 plain" 0 "${ALPHA_DIR}" "${A2}" "${A_A2_TS}"

# alpha A2 mention: delivered `mention`; a later positive control on alpha's
# connection, after which U0's, U1's and A1's counts are final.
push_message "${ALPHA_LABEL}" "${A2}" channel "$(mention_text "${ALPHA_BOT_USER}")"
wait_queued "phase A: alpha A2 mention" "${ALPHA_DIR}" "${A2}" "${PUSH_TS}" "${VIA_MENTION}"
expect_since "${A_U0_MARK}" "$(plain_drop "${ALPHA_REF}" "${U0}" "${DROP_CHANNEL_INELIGIBLE}")" 2 "phase A: alpha U0's channel-ineligible lines"
expect_queued "phase A: alpha U0, after a later delivery" 0 "${ALPHA_DIR}" "${U0}" "${A_U0_TS}"
expect_queued "phase A: discovered alpha U1, after a later delivery" 0 "${ALPHA_DIR}" "${U1}" "${A_OFF_TS}"
expect_queued "phase A: alpha A1 plain" 1 "${ALPHA_DIR}" "${A1}" "${A_A1_TS}"

# bravo B1 mention: delivered `mention`.
push_message "${BRAVO_LABEL}" "${B1}" channel "$(mention_text "${BRAVO_BOT_USER}")"
wait_queued "phase A: bravo B1 mention" "${BRAVO_DIR}" "${B1}" "${PUSH_TS}" "${VIA_MENTION}"

# alpha calls the tool for A1 with `all`: refused with the declarative text,
# found in the results record with isError set (the first-tool-result
# control); nothing written.
SCHEMA_RESULT="$(stub_session_list_tools "${ALPHA_DIR}")"
jq -e '.isError == false and (.text | fromjson | map(select(.name == "set_channel_delivery")) | length == 1)' <<< "${SCHEMA_RESULT}" > /dev/null || fail "missing negotiated tool"
jq -e '.text | fromjson | .[] | select(.name == "set_channel_delivery") | .inputSchema |
    .required == ["channel","delivery","attempt_id","intent"] and .additionalProperties == false and
    .properties.intent.enum == ["assignment","retry"] and .properties.delivery.enum == ["off","mentions","all","thread_hybrid"]' <<< "${SCHEMA_RESULT}" > /dev/null || fail "negotiated attempt schema differs"
expect_tool "phase A: alpha's set_channel_delivery A1 all" "${ALPHA_DIR}" \
    "$(attempt_args "${TEST_NAME}-strict-initial" "${A1}" all)" true "${ALPHA_DECLARATIVE_REFUSAL}"
[[ ! -e "${SLACK_STATE_DIR}/channel-delivery.json" ]] || fail "phase A: the refused call created a legacy store"
cmp -s -- "${CONFIG}" "${CONFIG_A_COPY}" || fail "phase A: config.json changed after the refused call"
check_upgrade_log "phase A after its last control"

# --- The mode switch -----------------------------------
# confirm_switch <fungible|switch-off> <switch-line> <step>: note each
# persona's registration and launch lines (launch_counts), write the
# configuration of that shape, wait for the pending file to carry the
# switch's line, confirm it and wait for its applied line; config.json's
# authority then preserves its reviewed bytes; automatic channel choices may
# differ in the applied view, independently validated by the production parser.
# Discard assertion-printer stdout: an empty Bun.write to the runner's regular
# append-open log truncates earlier diagnostics. Keep stderr and failure status.
confirm_switch() {
    local shape="$1" line="$2" step="$3" applied_before alpha_joins bravo_joins
    alpha_joins="$(shared_thread_joins "${ALPHA_KEY}" | jq -scS 'sort_by(.channel,.root,.at)')"
    bravo_joins="$(shared_thread_joins "${BRAVO_KEY}" | jq -scS 'sort_by(.channel,.root,.at)')"
    ALPHA_LAUNCHES="$(launch_counts "${ALPHA_REF}" "${ALPHA_START}" "${ALPHA_RELAUNCH}")"
    BRAVO_LAUNCHES="$(launch_counts "${BRAVO_REF}" "${BRAVO_START}" "${BRAVO_RELAUNCH}")"
    applied_before="$(count_log "${APPLIED_CLASS}")"
    local authority_before="${SCENARIO_ROOT}/authority-before-${shape}.json"
    cp -- "${LAST}" "${authority_before}"
    write_persona_config "${shape}"
    if [[ "${shape}" == fungible ]]; then
        configuration_request "mode-${shape}" request "${ALPHA}/${F1}/mentions" "${ALPHA}/${U1}/all" \
            "${BRAVO}/${F1}/mentions" "${BRAVO}/${F2}/mentions" "${BRAVO}/${A1}/mentions" "${BRAVO}/${U1}/all" > /dev/null
    else
        configuration_request "mode-${shape}" request > /dev/null
    fi
    wait_for_file "${PENDING}" "${TICK_WAIT_S}" "${step}: config.json.pending never appeared"
    wait_until 10 "${step}: the pending file never carried the switch's line" pending_has_line "${line}"
    check_pending_layout "${step}"
    configuration_application_preserved "${CONFIG}" "${authority_before}" "${LAST}" > /dev/null || fail "${step}: authority envelope changed before confirmation"
    mv -f -- "${PENDING}" "${APPLY}"
    wait_for_count "${APPLIED_CLASS}" $(( applied_before + 1 )) "${APPLY_WAIT_S}" "${step}: the confirmation was never applied"
    configuration_record_matches "${CONFIG}" "${LAST}" reviewed > /dev/null || fail "${step}: authority does not preserve the reviewed config.json bytes"
    [[ "$(shared_thread_joins "${ALPHA_KEY}" | jq -scS 'sort_by(.channel,.root,.at)')" == "${alpha_joins}" ]] || fail "${step}: mode change altered alpha joins"
    [[ "$(shared_thread_joins "${BRAVO_KEY}" | jq -scS 'sort_by(.channel,.root,.at)')" == "${bravo_joins}" ]] || fail "${step}: mode change altered bravo joins"
}

# expect_sessions_kept <step> <alpha-channel> <alpha-ts> <bravo-channel> <bravo-ts>:
# the switch kept both sessions: no registration and no launch line for
# either persona since confirm_switch noted them. Read after a delivery on
# each persona's connection made since the confirmation (the message given
# for each), which this checks is in that persona's accepted queue record.
expect_sessions_kept() {
    local step="$1"
    queued "${ALPHA_DIR}" "$2" "$3" || fail "${step}: no delivery of $2 ts $3 to ${ALPHA}, the positive control"
    queued "${BRAVO_DIR}" "$4" "$5" || fail "${step}: no delivery of $4 ts $5 to ${BRAVO}, the positive control"
    [[ "$(launch_counts "${ALPHA_REF}" "${ALPHA_START}" "${ALPHA_RELAUNCH}")" == "${ALPHA_LAUNCHES}" ]] \
        || fail "${step}: a session registration or launch line for ${ALPHA} after the confirmation"
    [[ "$(launch_counts "${BRAVO_REF}" "${BRAVO_START}" "${BRAVO_RELAUNCH}")" == "${BRAVO_LAUNCHES}" ]] \
        || fail "${step}: a session registration or launch line for ${BRAVO} after the confirmation"
}

# --- Thread phases: strict ---------------------------------------
other_value_threads "strict: other values" "${ALPHA_LABEL}" "${VIA_RECEIVE_ALL_SHARED}" true
[[ ! -e "${SLACK_STATE_DIR}/threads/${BRAVO_KEY}.jsonl" ]] || fail "strict: bravo acquired Thread Memory without a hybrid entry"

# Explicitly review alpha's four new hybrid choices. The persona-wide
# no-file/no-marker proof above runs before either persona has a hybrid entry.
ALPHA_THREADS=true
threads_applied_before="$(count_log "${APPLIED_CLASS}")"
write_persona_config declarative
configuration_request threads-strict request "${ALPHA}/${T1}/thread_hybrid" \
    "${ALPHA}/${N1}/thread_hybrid" "${ALPHA}/${N2}/thread_hybrid" "${ALPHA}/${N3}/thread_hybrid" > /dev/null
wait_for_file "${PENDING}" "${TICK_WAIT_S}" "strict threads: no pending review"
check_pending_layout "strict threads"
mv -f -- "${PENDING}" "${APPLY}"
wait_for_count "${APPLIED_CLASS}" $(( threads_applied_before + 1 )) "${APPLY_WAIT_S}" "strict threads: confirmation was not applied"
configuration_record_matches "${CONFIG}" "${LAST}" reviewed > /dev/null || fail "strict threads: reviewed configuration differs"
THREAD_STAMPS[alpha]="$(printed sharedThreadStamp "${CONFIG}" "${LAST}" "${ALPHA_KEY}" "${T1}")"
check_new_hybrid_choices "strict: changed value" "${ALPHA_LABEL}"
join_thread_phase strict
start_matrix
live_membership_phase strict
member_list alpha "${DEST}"
member_list bravo "${DEST}"
ack_control "$(slack_push_member_joined alpha "${DEST}" "$(scenario_ts)")"
ack_control "$(slack_push_member_joined bravo "${DEST}" "$(scenario_ts)")"
wait_membership_complete "${ALPHA}"
wait_membership_complete "${BRAVO}"
permission_phase strict alpha
freeze_four_values

# --- Switch on ---------------------------------------------------
confirm_switch fungible "${SWITCH_ON_LINE}" "switch on"
preserved_four_values strict-to-open
check_thread_persistence "strict to open" "${ALPHA_LABEL}" "${JOINED_ROOTS[strict]}"

# --- Phase B: fungible mode --------------------------------------
# 1. alpha, public F1 (flag false), plain: no delivery, a not-mentioned line,
#    one persona-invited-channel line (alpha, F1, public, mentions).
B1_MARK="$(log_mark)"
push_message "${ALPHA_LABEL}" "${F1}" channel "$(plain_text)" false
B1_TS="${PUSH_TS}"
wait_since "${B1_MARK}" "$(plain_drop "${ALPHA_REF}" "${F1}" "${DROP_NOT_MENTIONED}")" "${EVENT_WAIT_S}" \
    "step 1: no not-mentioned line for alpha F1"
expect_queued "step 1: alpha F1 plain" 0 "${ALPHA_DIR}" "${F1}" "${B1_TS}"
expect_since "${B1_MARK}" "${ALPHA_HEARS_F1}" 1 "step 1: alpha's persona-invited-channel lines for F1"

# 2. alpha, F1, a mention as app_mention then message: one delivery with
#    `mention`, no unclaimed-channel line.
B2_MARK="$(log_mark)"
push_mention "${ALPHA_LABEL}" "${F1}" channel "$(mention_text "${ALPHA_BOT_USER}")" app-first
B2_TS="${PUSH_TS}"
wait_queued "step 2: alpha F1 mention (app_mention first)" "${ALPHA_DIR}" "${F1}" "${B2_TS}" "${VIA_MENTION}"
expect_since "${B2_MARK}" "[slack] ${UNCLAIMED_CHANNEL}:" 0 "step 2: unclaimed-channel lines"

# 3. alpha, F1, a mention as message then app_mention: one delivery with
#    `mention`; then <!here> as a message alone: one delivery with `broadcast`.
B3_MARK="$(log_mark)"
push_mention "${ALPHA_LABEL}" "${F1}" channel "$(mention_text "${ALPHA_BOT_USER}")" message-first
B3_TS="${PUSH_TS}"
wait_queued "step 3: alpha F1 mention (message first)" "${ALPHA_DIR}" "${F1}" "${B3_TS}" "${VIA_MENTION}"
push_message "${ALPHA_LABEL}" "${F1}" channel "$(scenario_broadcast_text here "${TEST_NAME} broadcast")"
B3_HERE_TS="${PUSH_TS}"
wait_queued "step 3: alpha F1 <!here>" "${ALPHA_DIR}" "${F1}" "${B3_HERE_TS}" "${VIA_BROADCAST}"
# Read after a later delivery on alpha's connection.
expect_queued "step 2: alpha F1 mention (app_mention first)" 1 "${ALPHA_DIR}" "${F1}" "${B2_TS}"
expect_queued "step 3: alpha F1 mention (message first)" 1 "${ALPHA_DIR}" "${F1}" "${B3_TS}"
expect_since "${B3_MARK}" "[slack] ${UNCLAIMED_CHANNEL}:" 0 "step 3: unclaimed-channel lines"

# 4. bravo, private F2 (`group`, a G… ID), a mention: one delivery with
#    `mention`, one persona-invited-channel line (bravo, F2, private, mentions).
B4_MARK="$(log_mark)"
push_message "${BRAVO_LABEL}" "${F2}" group "$(mention_text "${BRAVO_BOT_USER}")"
B4_TS="${PUSH_TS}"
wait_queued "step 4: bravo F2 mention" "${BRAVO_DIR}" "${F2}" "${B4_TS}" "${VIA_MENTION}"
expect_since "${B4_MARK}" "${BRAVO_HEARS_F2}" 1 "step 4: bravo's persona-invited-channel lines for F2"
# The switch kept both sessions, read after alpha's step 3
# broadcast and bravo's step 4 mention, each delivered since the confirmation.
expect_sessions_kept "switch on" "${F1}" "${B3_HERE_TS}" "${F2}" "${B4_TS}"

# 5. alpha, X1 (flag true), X2 (no flag) and X3 (a flag that is not a
# boolean, beyond two: non-boolean form), each
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
    expect_queued "${step}" 0 "${ALPHA_DIR}" "${channel}" "${ts}"
    expect_since "${mark}" "[slack] ${PERSONA_INVITED_CHANNEL}:" 0 "${step}: persona-invited-channel lines"
}
b5_refused "step 5: alpha X1, flag true" "${X1}" true "${X1_UNCLAIMED}"
# The broadcast's count is final after a later decision on alpha's connection.
expect_queued "step 3: alpha F1 <!here>" 1 "${ALPHA_DIR}" "${F1}" "${B3_HERE_TS}"
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
expect_queued "step 6: alpha's group DM" 0 "${ALPHA_DIR}" "${GDM}" "${B6_TS}"
expect_since "${B6_MARK}" "[slack] ${UNCLAIMED_CHANNEL}:" 0 "step 6: unclaimed-channel lines"

# 7. alpha, A1 (explicit `all`, alpha's own permission destination), plain:
#    delivery remains receive_all with one diagnostic naming all.
B7_MARK="$(log_mark)"
push_message "${ALPHA_LABEL}" "${A1}" channel "$(plain_text)"
B7_TS="${PUSH_TS}"
wait_queued "step 7: alpha A1 retains its applied all preference" "${ALPHA_DIR}" "${A1}" "${B7_TS}" "${VIA_RECEIVE_ALL}"
expect_since "${B7_MARK}" "${ALPHA_HEARS_A1}" 1 "step 7: alpha's persona-invited-channel lines for A1"

# 8. alpha stores `all` for F1: accepted, naming F1, the stored `all` and the
#    delivery `all`; one persona-channel-delivery-set line; then alpha, F1,
#    plain: delivered `receive_all`.
B8_MARK="$(log_mark)"
expect_attempt "step 8: alpha's set_channel_delivery F1 all" "${ALPHA_DIR}" "${F1_ALL_ARGS}" "${ALPHA_KEY}" all
expect_since "${B8_MARK}" "${ALPHA_SET_F1}" 1 "step 8: alpha's persona-channel-delivery-set lines"
[[ -f "${STORE_FILE}" ]] || fail "step 8: the accepted call wrote no ${STORE_FILE}"
push_message "${ALPHA_LABEL}" "${F1}" channel "$(plain_text)"
wait_queued "step 8: alpha F1 plain" "${ALPHA_DIR}" "${F1}" "${PUSH_TS}" "${VIA_RECEIVE_ALL}"

# 9. alpha's refused calls: X1 with `all` (naming X1), F1 with "everything"
#    (naming the value); neither stores anything.
B9_MARK="$(log_mark)"
expect_attempt "step 9: alpha's set_channel_delivery X1 all" "${ALPHA_DIR}" "${X1_ARGS}" "${ALPHA_KEY}" channel-removed new true
expect_tool "step 9: alpha's set_channel_delivery F1 ${BAD_DELIVERY}" "${ALPHA_DIR}" \
    "$(attempt_args "${TEST_NAME}-invalid-value" "${F1}" "${BAD_DELIVERY}")" true "${ALPHA_VALUE_REFUSAL}"
expect_since "${B9_MARK}" "[slack] ${PERSONA_CHANNEL_DELIVERY_SET}:" 0 "step 9: persona-channel-delivery-set lines"

# 10. bravo and A1, alpha's notice destination: a mention is delivered (A1
#     joins bravo's heard set); bravo's call for A1 with `all` applies as
#     written; bravo, A1, plain: delivered `receive_all_shared`, since alpha
#     also has A1 at `all`.
B10_MARK="$(log_mark)"
push_message "${BRAVO_LABEL}" "${A1}" channel "$(mention_text "${BRAVO_BOT_USER}")"
wait_queued "step 10: bravo A1 mention" "${BRAVO_DIR}" "${A1}" "${PUSH_TS}" "${VIA_MENTION}"
expect_since "${B10_MARK}" "${BRAVO_HEARS_A1}" 1 "step 10: bravo's persona-invited-channel lines for A1"
expect_attempt "step 10: bravo's set_channel_delivery A1 all" "${BRAVO_DIR}" "${BRAVO_A1_ALL_ARGS}" "${BRAVO_KEY}" all
expect_since "${B10_MARK}" "${BRAVO_SET_A1}" 1 "step 10: bravo's persona-channel-delivery-set lines for A1"
push_message "${BRAVO_LABEL}" "${A1}" channel "$(plain_text)"
B10_TS="${PUSH_TS}"
wait_queued "step 10: bravo A1 plain (shared)" "${BRAVO_DIR}" "${A1}" "${B10_TS}" "${VIA_RECEIVE_ALL_SHARED}"

# 11. bravo and F1, shared delivery: a mention is delivered, bravo stores
#     `all` for F1, then one plain F1 message pushed to both personas is
#     delivered to each with `receive_all_shared`.
B11_MARK="$(log_mark)"
push_message "${BRAVO_LABEL}" "${F1}" channel "$(mention_text "${BRAVO_BOT_USER}")"
wait_queued "step 11: bravo F1 mention" "${BRAVO_DIR}" "${F1}" "${PUSH_TS}" "${VIA_MENTION}"
expect_attempt "step 11: bravo's set_channel_delivery F1 all" "${BRAVO_DIR}" "${BRAVO_F1_ALL_ARGS}" "${BRAVO_KEY}" all
expect_since "${B11_MARK}" "${BRAVO_SET_F1}" 1 "step 11: bravo's persona-channel-delivery-set lines for F1"
push_both "${F1}" channel "$(plain_text)"
B11_TS="${PUSH_TS}"
wait_queued "step 11: alpha F1 plain (shared)" "${ALPHA_DIR}" "${F1}" "${B11_TS}" "${VIA_RECEIVE_ALL_SHARED}"
wait_queued "step 11: bravo F1 plain (shared)" "${BRAVO_DIR}" "${F1}" "${B11_TS}" "${VIA_RECEIVE_ALL_SHARED}"
# A later delivery on each persona's connection (an F1 mention, `mention`),
# after which the shared message's counts are final: exactly one each.
push_message "${ALPHA_LABEL}" "${F1}" channel "$(mention_text "${ALPHA_BOT_USER}")"
wait_queued "step 11: alpha F1 mention, after the shared message" "${ALPHA_DIR}" "${F1}" "${PUSH_TS}" "${VIA_MENTION}"
push_message "${BRAVO_LABEL}" "${F1}" channel "$(mention_text "${BRAVO_BOT_USER}")"
wait_queued "step 11: bravo F1 mention, after the shared message" "${BRAVO_DIR}" "${F1}" "${PUSH_TS}" "${VIA_MENTION}"
expect_queued "step 11: alpha F1 plain (shared)" 1 "${ALPHA_DIR}" "${F1}" "${B11_TS}"
expect_queued "step 11: bravo F1 plain (shared)" 1 "${BRAVO_DIR}" "${F1}" "${B11_TS}"

# --- Thread phases: open -----------------------------------------
other_value_threads "open: other values" "${BRAVO_LABEL}" "${VIA_RECEIVE_ALL}"
for channel in "${T1}" "${N1}" "${N2}" "${N3}"; do
    expect_attempt "open: enable bravo thread channel" "${BRAVO_DIR}" \
        "$(attempt_args "${TEST_NAME}-bravo-thread-${channel}" "${channel}" thread_hybrid)" "${BRAVO_KEY}" thread_hybrid
done
THREAD_STAMPS[bravo]="$(printed sharedThreadStamp "${CONFIG}" "${LAST}" "${BRAVO_KEY}" "${T1}")"
check_new_hybrid_choices "open: changed value" "${BRAVO_LABEL}"
join_thread_phase open
# A thread joined only by alpha stays outside bravo's own Thread Memory.
expect_unjoined_reply "open: independent persona joins" "${BRAVO_LABEL}" "${T1}" "${JOINED_ROOTS[open]}"
two_persona_threads open
selection_matrix open
# all beside hybrid retains receive_all; only two effective all choices
# produce receive_all_shared. Each assignment leaves the sibling unchanged.
member_list bravo "${M_ALL}"
ack_control "$(slack_push_member_joined bravo "${M_ALL}" "$(scenario_ts)")"
wait_membership_complete "${BRAVO}"
expect_attempt all-beside-hybrid "${BRAVO_DIR}" "$(attempt_args bravo-matrix-hybrid "${M_ALL}" thread_hybrid)" "${BRAVO_KEY}" thread_hybrid
matrix_message cohabitation-alpha-all alpha "${M_ALL}" plain - receive_all
matrix_message cohabitation-bravo-unjoined bravo "${M_ALL}" plain - not-mentioned
matrix_message cohabitation-bravo-join bravo "${M_ALL}" mention - mention
COHAB_ROOT="${MATRIX_TS}"
matrix_message cohabitation-bravo-follow bravo "${M_ALL}" plain "${COHAB_ROOT}" thread
COHAB_BEFORE="$(channel_facts "${BRAVO_KEY}" "${M_ALL}")"
expect_attempt independent-alpha-off "${ALPHA_DIR}" "$(attempt_args cohab-alpha-off "${M_ALL}" off)" "${ALPHA_KEY}" off
[[ "$(channel_facts "${BRAVO_KEY}" "${M_ALL}")" == "${COHAB_BEFORE}" ]] || fail 'alpha write changed bravo stamp/order'
matrix_message independent-bravo-kept bravo "${M_ALL}" plain "${COHAB_ROOT}" thread
expect_attempt restore-alpha-all "${ALPHA_DIR}" "$(attempt_args cohab-alpha-all "${M_ALL}" all)" "${ALPHA_KEY}" all
live_membership_phase open
permission_phase open bravo
write_order_phase
freeze_four_values
# The complete restart inventory includes every retained member, excludes
# the observed leaves, and has no entry for the never-joined future preference.
BRAVO_LIVE_MEMBERS=()
for mode in strict open; do
    for value in off mentions all thread_hybrid; do BRAVO_LIVE_MEMBERS+=("${LEAVE_CHANNELS[${mode}|${value}]}"); done
done
ALPHA_MEMBERS=("${A1}" "${A2}" "${F1}" "${F2}/private" "${U1}" "${T1}" "${N1}" "${N2}" "${N3}"
    "${M_OFF}" "${M_MENTIONS}" "${M_ALL}" "${M_HYBRID}" "${WRITE_CHANNEL}" "${DEST}")
BRAVO_MEMBERS=("${B1}" "${A1}" "${F1}" "${F2}/private" "${U1}" "${T1}" "${N1}" "${N2}" "${N3}"
    "${M_ALL}" "${BRAVO_LIVE_MEMBERS[@]}" "${DEST}")
slack_stub_inventory_page alpha '' '' "${ALPHA_MEMBERS[@]}"
slack_stub_inventory_page bravo '' '' "${BRAVO_MEMBERS[@]}"

# --- Persistence across a restart ----------------------
# Queue acceptance above can precede typing and its receipt. Settle both
# personas before checking an immediate idle-session reconnect on restart.
queue_drain_snapshot before-restart
for dir in "${ALPHA_DIR}" "${BRAVO_DIR}"; do
    wait_queue_drained "${dir}" "restart: ${dir}"
    wait_until "${EVENT_WAIT_S}" "restart: queued joins of ${dir} were not saved" thread_joins_saved "${dir}"
done
queue_drain_snapshot restart-drained
STORE_BEFORE_RESTART="${SCENARIO_ROOT}/store-before-restart.json"
cp -- "${STORE_FILE}" "${STORE_BEFORE_RESTART}"
declare -A DELIVERIES_BEFORE=()
for dir in "${ALPHA_DIR}" "${BRAVO_DIR}"; do
    DELIVERIES_BEFORE["${dir}"]="${SCENARIO_ROOT}/deliveries-before-restart.$(basename "${dir}")"
    shared_queue_snapshot "${DELIVERIES_BEFORE[${dir}]}" "${QUEUE_KEY[${dir}]}" "${QUEUE_ARCHIVES[${dir}]}"
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
wait_membership_complete "${ALPHA}"
wait_membership_complete "${BRAVO}"
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
# The assertion printer returns empty stdout via Bun.write, which truncates a
# regular-file stdout even when opened for append. Keep the runner log intact.
bun "${SCENARIO_FIXTURES}/fmk-texts.ts" sharedAuthorityPreserved "${CONFIG}" "${STORE_BEFORE_RESTART}" "${STORE_FILE}" > /dev/null \
    || fail "restart: shared choices, identities or reviewed input changed"
preserved_four_values AC-J14-complete-inventory
choice_is "${ALPHA_KEY}" "${FUTURE}" all || fail 'empty membership evidence removed never-joined preference'
choice_is "${ALPHA_KEY}" "${WRITE_CHANNEL}" all || fail 'restart promoted pending off intent'
for mode in strict open; do
    for value in off mentions all thread_hybrid; do
        choice_is "${ALPHA_KEY}" "${LEAVE_CHANNELS[${mode}|${value}]}" '' || fail 'restart restored an observed leave'
    done
done
for dir in "${ALPHA_DIR}" "${BRAVO_DIR}"; do
    shared_dedupe_preserved "${QUEUE_KEY[${dir}]}" "${DELIVERIES_BEFORE[${dir}]}" > /dev/null
    [[ -z "$(shared_queue_items "${QUEUE_KEY[${dir}]}")" ]] || fail 'restart: delivered content survived compaction'
done


# alpha calls the tool for F1 with `all` before any F1 event: accepted as a
# stored channel, `all` before and after. Its result also shows the new
# client polled the request file.
expect_attempt "restart: alpha retries its retained ID" "${ALPHA_DIR}" "${F1_RETRY_ARGS}" "${ALPHA_KEY}" all history
expect_since "${RESTART_MARK}" "${ALPHA_SET_F1_AGAIN}" 0 "restart: history creates no assignment diagnostic"
expect_attempt "restart: alpha deliberately writes all again" "${ALPHA_DIR}" "${F1_FRESH_ARGS}" "${ALPHA_KEY}" all
expect_since "${RESTART_MARK}" "${ALPHA_SET_F1_AGAIN}" 1 "restart: alpha's persona-channel-delivery-set lines (all to all)"
check_thread_persistence "restart: strict join" "${ALPHA_LABEL}" "${JOINED_ROOTS[strict]}"
check_thread_persistence "restart: open join" "${ALPHA_LABEL}" "${JOINED_ROOTS[open]}"
for who in "${ALPHA_LABEL}" "${BRAVO_LABEL}"; do
    check_thread_persistence "restart: shared join" "${who}" "${JOINED_ROOTS[open-both]}"
done

# the reconnect's new clients read each request file from its
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
wait_queued "restart: alpha F1 plain" "${ALPHA_DIR}" "${F1}" "${PUSH_TS}" "${VIA_RECEIVE_ALL_SHARED}"
expect_since "${RESTART_MARK}" "${ALPHA_HEARS_F1_ALL}" 1 "restart: alpha's persona-invited-channel lines for F1 in this run"
expect_since "${RESTART_MARK}" "$(matcher "${ALPHA_INVITED_HEAD}" " ${F1} ")" 1 \
    "restart: alpha's persona-invited-channel lines naming F1 in this run"
configuration_request after-restart-intent refresh > /dev/null
expect_preview_choice "${ALPHA_KEY}" "${WRITE_CHANNEL}" declared all off eligible all off "$(assignment_order "${ALPHA_KEY}" "${WRITE_CHANNEL}")"
confirm_review after-restart-intent
matrix_message after-restart-confirmed-off alpha "${WRITE_CHANNEL}" mention - channel-off

# --- Switch off --------------------------------------------------
STORE_BEFORE_OFF="${SCENARIO_ROOT}/store-before-off.json"
declare -A CHOICES_BEFORE_OFF=()
for key in "${ALPHA_KEY}" "${BRAVO_KEY}"; do
    CHOICES_BEFORE_OFF["${key}"]="$(shared_persona_facts "${key}" | jq -cS 'del(.mode,.historicalMembership)')"
done
confirm_switch switch-off "${SWITCH_OFF_LINE}" "switch off"
preserved_four_values open-to-strict
for key in "${ALPHA_KEY}" "${BRAVO_KEY}"; do
    [[ "$(shared_persona_facts "${key}" | jq -cS 'del(.mode,.historicalMembership)')" == "${CHOICES_BEFORE_OFF[${key}]}" ]] \
        || fail 'switch off: applied persona choices changed'
done

# alpha, F1, plain: strict mode retains its shared applied all choice.
OFF_MARK="$(log_mark)"
push_message "${ALPHA_LABEL}" "${F1}" channel "$(plain_text)"
OFF_F1_TS="${PUSH_TS}"
wait_queued "switch off: alpha F1 keeps its shared applied choice" "${ALPHA_DIR}" "${F1}" "${OFF_F1_TS}" "${VIA_RECEIVE_ALL_SHARED}"
expect_since "${OFF_MARK}" "${F1_UNCLAIMED}" 0 "switch off: an applied channel is still configured"

# alpha and bravo keep A1 at all after the switch, including alpha's notice destination.
push_message "${ALPHA_LABEL}" "${A1}" channel "$(plain_text)"
OFF_A1_TS="${PUSH_TS}"
wait_queued "switch off: alpha A1 plain" "${ALPHA_DIR}" "${A1}" "${OFF_A1_TS}" "${VIA_RECEIVE_ALL_SHARED}"

# bravo, B1, a mention: delivered `mention`, by its listed entry.
push_message "${BRAVO_LABEL}" "${B1}" channel "$(mention_text "${BRAVO_BOT_USER}")"
OFF_B1_TS="${PUSH_TS}"
wait_queued "switch off: bravo B1 mention" "${BRAVO_DIR}" "${B1}" "${OFF_B1_TS}" "${VIA_MENTION}"
# Both sessions kept, read after the two deliveries above.
expect_sessions_kept "switch off" "${A1}" "${OFF_A1_TS}" "${B1}" "${OFF_B1_TS}"

# alpha's call for F1: refused with the declarative text; the file unchanged.
cp -- "${STORE_FILE}" "${STORE_BEFORE_OFF}"
expect_attempt "switch off: retained history remains readable" "${ALPHA_DIR}" "${F1_RETRY_ARGS}" "${ALPHA_KEY}" all history
expect_tool "switch off: alpha's set_channel_delivery F1 all" "${ALPHA_DIR}" "${STRICT_FRESH_ARGS}" true "${ALPHA_DECLARATIVE_REFUSAL}"
configuration_application_preserved "${CONFIG}" "${STORE_BEFORE_OFF}" "${STORE_FILE}" > /dev/null \
    || fail 'switch off: refused calls changed the applied authority'
check_thread_persistence "open to strict: original strict join" "${ALPHA_LABEL}" "${JOINED_ROOTS[strict]}"
for who in "${ALPHA_LABEL}" "${BRAVO_LABEL}"; do
    check_thread_persistence "open to strict: shared join" "${who}" "${JOINED_ROOTS[open-both]}"
done
two_persona_threads strict
notice_phase strict alpha off
notice_phase strict alpha
# S -> O -> S -> O contains both required directed cycles. The ordinary
# worker end/resume above is inside the latter cycle and preserves its choices.
mode_only open
notice_phase open bravo off
notice_phase open bravo
future_after_leave
ineligible_and_unverified
rejoin_after_absence
identity_replacement

# E5: retain a real DM's exact receipt metadata through the shared adapter.
DM_TEXT="$(plain_text)"
push_message "${BRAVO_LABEL}" "${DM}" im "${DM_TEXT}"
DM_TS="${PUSH_TS}"
wait_queued "E5: bravo direct DM" "${BRAVO_DIR}" "${DM}" "${DM_TS}" dm
wait_queue_drained "${BRAVO_DIR}" "E5: bravo direct DM"
DM_PARTS="$(shared_expected_parts "${DM_TEXT}" "${DM_TS}" "${HUMAN}" "$(scenario_stub_name user "${HUMAN}")" "${DM}" dm dm - -)"
shared_assert_content "${BRAVO_KEY}" "${SLACK_STATE_DIR}/server.log" "${QUEUE_ARCHIVES[${BRAVO_DIR}]}" "${DM}" "${DM_TS}" "${DM_TEXT}" "${DM_PARTS}" -

# --- Closing -----------------------------------------------------
for dir in "${ALPHA_DIR}" "${BRAVO_DIR}"; do
    wait_queue_drained "${dir}" "closing: ${dir}"
    wait_until "${EVENT_WAIT_S}" "closing: unsaved joins" thread_joins_saved "${dir}"
done
stop_server --stop-bots
port_closed "${SCENARIO_PORT}" || fail 'closing: server port remains open'
stop_tracked_pid "${STUB_PID}" 10 'Slack stub did not stop'
EXPECTED_ALL="${SCENARIO_ROOT}/expected-acceptances.jsonl"
: > "${EXPECTED_ALL}"
for fact in "${!EXPECTED_QUEUE_ROWS[@]}"; do printf '%s\n' "${EXPECTED_QUEUE_ROWS[${fact}]}" >> "${EXPECTED_ALL}"; done
shared_assert_accounting "${EXPECTED_ALL}" "${SLACK_STATE_DIR}/server.log" \
    "${ALPHA_KEY}" "${QUEUE_ARCHIVES[${ALPHA_DIR}]}" "${BRAVO_KEY}" "${QUEUE_ARCHIVES[${BRAVO_DIR}]}"
# Compare every original input (including Q's actual captured post) to its
# accepted content, fixed parts and exact own-session transcript receipts.
# Expected text is never reconstructed from the queue being checked.
HUMAN_INPUTS="${SCENARIO_ROOT}/human-input-texts.jsonl"
: > "${HUMAN_INPUTS}"
for identity in "${!EXPECTED_INPUTS[@]}"; do
    IFS='|' read -r key channel ts via <<< "${identity}"
    input="${EXPECTED_INPUTS[${identity}]}"
    text="$(jq -er '.text' <<< "${input}")"
    sender="$(jq -er '.user' <<< "${input}")"
    if [[ "${sender}" == "${HUMAN}" ]]; then jq -c '.text' <<< "${input}" >> "${HUMAN_INPUTS}"; fi
    root="$(jq -r '.thread_ts // "-"' <<< "${input}")"
    channel_name="$(scenario_stub_name channel "${channel}")"
    [[ "${via}" != dm ]] || channel_name=dm
    parts="$(shared_expected_parts "${text}" "${ts}" "${sender}" "$(scenario_stub_name user "${sender}")" "${channel}" "${channel_name}" "${via}" "${root}" -)"
    if [[ "${key}" == "${ALPHA_KEY}" ]]; then dir="${ALPHA_DIR}"; else dir="${BRAVO_DIR}"; fi
    shared_assert_content "${key}" "${SLACK_STATE_DIR}/server.log" "${QUEUE_ARCHIVES[${dir}]}" "${channel}" "${ts}" "${text}" "${parts}" - > /dev/null
done
# The bodies belong in delivery evidence, never in server diagnostics or
# captured reviews/tool results. Q's own notice wording is excluded from this
# sentinel check because the server legitimately prints its own notice text.
# Two server.log line kinds carry a body excerpt by design, and no SR forbids
# it: the event router's RAW line (src/persona-event-router.ts routeInbound,
# for message and app_mention) and the dispatch line (src/delivery-notices.ts
# buildDeliveryDispatchLine). Only a timestamped line whose text starts with
# one of these heads is skipped; an unstamped continuation line of a
# multi-line log entry is always checked. ci-timing-regressions.test.ts pins
# the heads to the lines those functions build.
BODY_LINE_HEADS=('[slack] RAW message event persona=' '[slack] RAW app_mention event persona=' '[slack] dispatch: persona=')
# body_sentinels_absent <human-inputs> <server-log> <captured-dir>
body_sentinels_absent() {
    python3 - "$1" "$2" "$3" "${BODY_LINE_HEADS[@]}" <<'PY'
import json, pathlib, re, sys
texts = {json.loads(line) for line in pathlib.Path(sys.argv[1]).read_text().splitlines()}
assert texts and all(texts), 'missing independent message-body sentinels'
heads, stamp = tuple(sys.argv[4:]), re.compile(r'\[\d{4}-\d{2}-\d{2}T[0-9:.]+Z\] ')
def diagnostic(line):
    at = stamp.match(line)
    return not (at and line[at.end():].startswith(heads))
log = '\n'.join(filter(diagnostic, pathlib.Path(sys.argv[2]).read_text().splitlines()))
for content in [log, *(path.read_text() for path in pathlib.Path(sys.argv[3]).iterdir())]:
    if any(text in content for text in texts):
        raise SystemExit('message body leaked into diagnostics or a captured result')
PY
}
body_sentinels_absent "${HUMAN_INPUTS}" "${SLACK_STATE_DIR}/server.log" "${CAPTURED}"
while IFS= read -r envelope; do
    [[ "$(slack_ack_count "${envelope}")" == 1 ]] || fail 'closing: missing or repeated ACK'
done < "${ACKS}"

# The token scan, read once every writer has stopped (the files stay until
# the EXIT trap removes the scratch root). files: server.log and
# its rotations, the stub's record, the delivery and results records and the
# stored-choice file; and, beside them, the request files, the client's log
# and the stub's output.
leak_files=("${SLACK_STATE_DIR}"/server.log* "${STUB_RECORD}" "${STORE_FILE}")
for dir in "${ALPHA_DIR}" "${BRAVO_DIR}"; do
    leak_files+=("${DELIVERIES_FILE[${dir}]}" "${RESULTS_FILE[${dir}]}" "${REQUESTS_FILE[${dir}]}")
    leak_files+=("${SLACK_STATE_DIR}/threads/${QUEUE_KEY[${dir}]}.jsonl")
done
for file in "${leak_files[@]}"; do
    [[ -f "${file}" ]] || fail "closing: ${file} is missing"
done
leak_files+=("${STUB_BIN}/stub-mcp-session.log" "${STUB_OUT}")
leak_files+=("${CAPTURED}"/*)
n="$(count_token_like "${leak_files[@]}")"
[[ "${n}" == 0 ]] || fail "closing: ${n} token-like match(es) in server.log, the stub's record, the stub MCP session's records or ${STORE_FILE}"

# The tmux sessions and stub-claude's transcripts go in the exit hook
# (cleanup_launches), which runs on a failure too.
OBSERVE_ON_EXIT=0
echo "PASS: ${TEST_NAME} (${SECONDS} s elapsed)"
