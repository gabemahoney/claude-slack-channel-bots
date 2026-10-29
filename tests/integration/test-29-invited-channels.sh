#!/usr/bin/env bash
# Test 29: declarative and fungible channel
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
# session's accepted queue record (`stub_session_deliveries`) shows what reached
# the persona; its tool calls (`stub_session_call`) call set_channel_delivery.
# `health_check_interval` is 0 (no restart chases anything) and `exit_timeout`
# is 5 (stub-claude ignores the `/exit` that `stop --stop-bots` sends).
#
# Phases:
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
# - Switch on : open mode and explicit F1/F2/U1 choices;
#   the pending file carries the switch's line; its confirmation applies it
#   with both sessions kept (no registration or launch line, read after a
#   delivery on each persona's connection, in phase B).
# - B, fungible mode (steps 1 to 11): the fungible path, both orders
#   of a mention's two events, a broadcast, a private channel, the externally
#   shared, missing and non-boolean flags, a group DM, alpha's own fungible
#   destination, then set_channel_delivery: stored, refused, held by the loop
#   guard, and shared delivery, exactly once to each persona.
# - R, thread evidence on alpha's thread_hybrid T1 (fungible mode): an
#   incoming mention's thread (R0); alpha's own root post, no root lookup
#   (R1); an upload's root from files.info for its actual file ID, then
#   recovered (R2); a held reply released by a root lookup through a refused
#   method (the capability line; tried again only after its re-check window)
#   and an HTTP 429, acked once and only after
#   the lookup's answer (R3); a deleted root, a gap line and no delivery or
#   ack (R4); a foreign root's reply dropped, acked after its lookup (R5);
#   no post or upload repeated. The stub's control switches alpha's file
#   shares and metadata faults per step; alpha's auth.test reports its
#   history scopes.
# - Restart: a plain stop (the bots keep running) and a live start;
#   shared choices, identities and reviewed bytes survive fresh discovery;
#   the reconnect's new MCP clients
# repeat no call; the stored choice applies again.
# - Switch off: declarative mode again, sessions kept (read after
#   a delivery on each persona's connection), shared choices still applied
#   and new tool assignments refused.
# - Closing: `stop --stop-bots`; the port closed; the Slack stub
#   stopped; no token-like text anywhere; the elapsed time on the PASS line.
#
# Runtime rules. Every wait polls and returns once its condition
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
# Runtime: about 5 min (284 s in the passing /ci run after Phase R),
# dominated by R3's Retry-After window and the 60 s backoff after R4. It is
# re-measured at the Epic /ci gate after Task 8k, and this header and
# tests/ci-durations.tsv are refreshed from that run's duration-table block.
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
RECOVERY_WAIT_S=120 # participation recovery's retries: 5 to 60 s apart (src/thread-memory.ts metadataRetryDelay); R3 derives its own (R3_WAIT_S)
# R4's share-less upload keeps every later pass failed, so R5-R7 and the
# restart lookups wait at the 60 s cap, which is why RECOVERY_WAIT_S keeps its
# margin over one repair bound (2 x DEADLINE + RETRY_MAX, checked in phase R).

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
CH_TAG="${SCENARIO_TAG^^}"
A1="C0${CH_TAG}A1"          # alpha: listed `all`; alpha's fungible destination in fungible mode
A2="C0${CH_TAG}A2"          # alpha: listed `mentions`
B1="C0${CH_TAG}B1"          # bravo: listed `mentions`
F1="C0${CH_TAG}F1"          # public, discovered off in strict; explicitly mentions in open
F2="G0${CH_TAG}F2"          # private (`group`), discovered off; bravo explicitly mentions in open
U1="C0${CH_TAG}U1"          # public, discovered off; explicitly shared all after phase A
T1="C0${CH_TAG}T1"          # alpha: public, discovered off; explicitly thread_hybrid in open (phase R)
U0="C0${CH_TAG}U0"          # genuinely unlisted: neither inventory nor configuration
X1="C0${CH_TAG}X1"          # externally shared (flag true)
X2="C0${CH_TAG}X2"          # no flag
X3="C0${CH_TAG}X3"          # a flag that is not a boolean
GDM="G0${CH_TAG}GD"         # a group DM (`mpim`)
DM="D0${CH_TAG}DM"          # bravo's direct DM for the E5 delivery evidence
ALPHA_BOT_USER="U0${CH_TAG}ALPHA"
ALPHA_BOT_ID="B0${CH_TAG}ALPHA"
BRAVO_BOT_USER="U0${CH_TAG}BRAVO"
BRAVO_BOT_ID="B0${CH_TAG}BRAVO"
HUMAN="U0${CH_TAG}HUMAN"    # every event's author
CONTACT="U0${CH_TAG}CONTACT" # bravo's dm.contact
for id in "${A1}" "${A2}" "${B1}" "${F1}" "${F2}" "${U1}" "${T1}" "${U0}" "${X1}" "${X2}" "${X3}" "${GDM}" "${DM}" \
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
# src/registry.ts ListTools: the MCP tool a persona posts with.
REPLY_TOOL='reply'
# Phase R's thread-evidence lines come whole from the printer
# (src/delivery-notices.ts builders, below). The recovery causes and
# capability kinds passed to it are src/participation-recovery.ts
# PARTICIPATION_RECOVERY_CAUSES and src/participation-channel-evidence.ts
# RootLookupCapabilityGap words; the printer fails a cause it names no action for.
CAUSE_ROOT_DELETED='root-deleted'
CAUSE_METADATA='metadata'
GAP_METHOD_REFUSED='method-refused'
# src/thread-memory.ts MetadataFailure kind: an attempt's expired deadline.
FAILURE_DEADLINE='deadline'
# fixtures/slack-stub-server.ts: the method a root lookup calls, the Slack
# error its `capability` fault answers and the one its `transient` fault answers.
ROOT_LOOKUP_METHOD='conversations.replies'
STUB_CAPABILITY_ERROR='missing_scope'
STUB_TRANSIENT_ERROR='internal_error'
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
# compare; a JSON true/false reads True/False) and every <field>><number>
# (a numeric field greater than it, such as `seq>` a mark).
RECORD_SPECS="${SCENARIO_ROOT}/record_specs.py"
cat > "${RECORD_SPECS}" << 'EOF'
def parse(specs):
    return [(*spec.split("=", 1), "=") if "=" in spec else (*spec.split(">", 1), ">") for spec in specs]

def matches(rec, checks):
    for k, v, op in checks:
        got = rec.get(k)
        if got is None:
            return False
        if op == "=" and str(got) != v:
            return False
        if op == ">" and not (isinstance(got, (int, float)) and not isinstance(got, bool) and got > float(v)):
            return False
    return True
EOF
RECORD_QUERY="${SCENARIO_ROOT}/record-query.py"
cat > "${RECORD_QUERY}" << 'EOF'
import json, sys
from record_specs import parse, matches
path, *specs = sys.argv[1:]
checks = parse(specs)
count = 0
try:
    with open(path) as f:
        for line in f:
            try:
                rec = json.loads(line)
            except ValueError:
                continue
            if matches(rec, checks):
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
# rec_field <field> <first|last|all> <field>=<value>...: that field of the
# first or last matching record line, or of every one in order (space-joined);
# empty when none matches.
RECORD_FIELD="${SCENARIO_ROOT}/record-field.py"
cat > "${RECORD_FIELD}" << 'EOF'
import json, sys
from record_specs import parse, matches
path, field, which, *specs = sys.argv[1:]
checks = parse(specs)
found = []
try:
    with open(path) as f:
        for line in f:
            try:
                rec = json.loads(line)
            except ValueError:
                continue
            if matches(rec, checks) and rec.get(field) is not None:
                found.append(str(rec[field]))
except FileNotFoundError:
    pass
if found:
    print(found[0] if which == "first" else found[-1] if which == "last" else " ".join(found))
EOF
rec_field() {
    python3 "${RECORD_FIELD}" "${STUB_RECORD}" "$@"
}

# The delivery-record query: lines of a stub MCP session's accepted queue record
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
        meta = rec if isinstance(rec, dict) and rec.get("kind") == "accepted" and rec.get("compact") is None else None
        if not isinstance(meta, dict):
            continue
        if meta.get("channel") == chat and meta.get("ts") == ts and (via == "" or meta.get("via") == via):
            count += 1
print(count)
EOF

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

# deliveries <dir> <chat-id> <ts> [<via>]: how many deliveries the persona
# working in <dir> received for that message (with that `via`, when given).
queued_count() {
    local snapshot="${SCENARIO_ROOT}/deliveries-snapshot"
    local key
    case "$1" in
        "${ALPHA_DIR}") key="${ALPHA_KEY}" ;;
        "${BRAVO_DIR}") key="${BRAVO_KEY}" ;;
        *) fail "queued_count: unknown persona working directory" ;;
    esac
    queue_accepted "${key}" > "${snapshot}"
    python3 "${DELIVERY_QUERY}" "${snapshot}" "$2" "$3" "${4:-}"
}

queued() {
    (( $(queued_count "$@") == 1 ))
}

declare -A EXPECTED_QUEUE_ROWS=()

# Receipt completion, rather than acceptance, makes the restart's idle-bot
# precondition true. Every fixed part of every accepted item has a receipt.
queue_drained() {
    local file="${DELIVERIES_FILE[$1]}"
    jq -se '
      . as $records
      | [$records[] | select(.kind == "accepted" and .compact == null)] as $accepted
      | ($accepted | length) > 0
        and all($accepted[];
          .seq as $seq
          | ([$records[] | select(.seq == $seq and .kind == "fixed")][-1].parts // null) as $parts
          | ($parts | type) == "array"
            and ($parts | length) > 0
            and all(range(1; ($parts | length) + 1);
              . as $part
              | any($records[]; .seq == $seq and .kind == "delivered" and .part == $part)))
    ' "${file}" > /dev/null 2>&1
}

# wait_queued <step> <dir> <chat-id> <ts> <via>: the delivery reaches the
# accepted queue record, with that `via`.
wait_queued() {
    local step="$1"; shift
    wait_until "${EVENT_WAIT_S}" "${step}: no delivery with via $4 in the accepted queue record of $1" queued "$@"
    EXPECTED_QUEUE_ROWS["${QUEUE_KEY[$1]}|$2|$3|$4"]="$(jq -cn --arg c "$2" --arg t "$3" --arg v "$4" '[$c,$t,$v]')"
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
# PUSH_ENVELOPE is its envelope ID, the one its socket ack (the stub's
# `ws-message` line) carries.
push_event() {
    local label="$1" ts
    ts="$(jq -r '.ts' <<< "$2")"
    PUSHED_TS["${label} ${ts} $(jq -r '.type' <<< "$2")"]=1
    PUSH_ENVELOPE="$(slack_stub_push "${label}" "$2" "${3:-}")"
    [[ -n "${PUSH_ENVELOPE}" ]] || fail "push_event: no envelope ID for the push to ${label}"
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

# push_reply <label> <channel> <root-ts> <text>: a plain thread reply under
# <root-ts>, with a ts of its own.
push_reply() {
    new_ts
    push_event "$1" "$(message_event "$2" channel "$4" "${PUSH_TS}" | jq -c --arg r "$3" '. + {thread_ts: $r}')" false
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

# Every deliberate request is retained explicitly before submission. The
# request JSONL written by stub_session_call preserves this binding as well.
attempt_args() {
    jq -cn --arg id "$1" --arg c "$2" --arg d "$3" --arg intent "${4:-assignment}" \
        '{channel:$c,delivery:$d,attempt_id:$id,intent:$intent}'
}

# Read the production-validated durable outcome AFTER the call. Expected current
# effectiveness is supplied by this scenario's independent guard/eligibility setup.
expect_attempt() {
    local step="$1" dir="$2" args="$3" key="$4" effective="$5" history="${6:-new}" want_error="${7:-false}" expected
    call_tool "${dir}" "${args}"
    expected="$(printed channelDeliveryAttemptResultText "${CONFIG}" "${CONFIG}.last-applied" "${key}" \
        "$(jq -r .channel <<< "${args}")" "$(jq -r .delivery <<< "${args}")" "$(jq -r .attempt_id <<< "${args}")" "${history}" "${effective}")"
    [[ "${CALL_IS_ERROR}" == "${want_error}" ]] || fail "${step}: unexpected error flag"
    [[ "${CALL_TEXT}" == "${expected}" ]] || fail "${step}: result differs from retained outcome/current facts"
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
# mention names it); any other token is refused. alpha's auth.test reports
# the history scopes its root lookups need (DMs off), so its capability is
# `scopes-present` and logs nothing; bravo's reports none (unknown, no line).
# T1's channel metadata is explicit, as conversations.info's parser requires.
# Phase R derives each later control from this one (set_alpha_evidence).
jq -n --arg asuf "${ALPHA_SUFFIX}" --arg al "${ALPHA_LABEL}" --arg au "${ALPHA_BOT_USER}" --arg ab "${ALPHA_BOT_ID}" \
    --arg bsuf "${BRAVO_SUFFIX}" --arg bl "${BRAVO_LABEL}" --arg bu "${BRAVO_BOT_USER}" --arg bb "${BRAVO_BOT_ID}" \
    --arg a1 "${A1}" --arg a2 "${A2}" --arg b1 "${B1}" --arg f1 "${F1}" --arg f2 "${F2}" --arg u1 "${U1}" --arg t1 "${T1}" \
    '{tokens: [
        {suffix: $asuf, label: $al, auth: "ok", connections: "ok", user_id: $au, bot_id: $ab, memberships: [$a1,$a2,$f1,$f2,$u1,$t1],
         scopes: ["channels:history", "groups:history", "channels:read", "groups:read", "chat:write", "files:read", "files:write"]},
        {suffix: $bsuf, label: $bl, auth: "ok", connections: "ok", user_id: $bu, bot_id: $bb, memberships: [$b1,$a1,$f1,$f2,$u1]}],
      default: {auth: "invalid_auth", connections: "invalid_auth"},
      channels: {($t1): {is_channel: true, is_group: false, is_im: false, is_mpim: false, is_private: false, is_ext_shared: false}}}' \
    | write_file "${STUB_CONTROL}" || fail "could not write the stub's control file ${STUB_CONTROL}"

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
# - declarative: the 0.11.x shape of the contract (neither key of this work);
# - fungible: open mode plus explicit mentions/all choices for discovered
# channels; alpha's permission destination remains A1 ;
# - switch-off: the same reviewed choices with strict mode.
write_persona_config() {
    local switch='' extra_alpha='' extra_bravo=''
    case "$1" in
        declarative) ;;
        fungible|switch-off)
            local mode='open'
            [[ "$1" == 'switch-off' ]] && mode='strict'
            switch=$'\n  "'"${SWITCH_KEY}"'": "'"${mode}"'",'
            extra_alpha=', { "id": "'"${F1}"'", "delivery": "mentions" }, { "id": "'"${U1}"'", "delivery": "all" }, { "id": "'"${T1}"'", "delivery": "thread_hybrid" }'
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
      "channels": [
        { "id": "${A1}", "delivery": "all" },
        { "id": "${A2}", "delivery": "mentions" }${extra_alpha}
      ],
      "dm": { "enabled": false },
      "permission_prompts": "${A1}"
    },
    {
      "name": "${BRAVO}",
      "credentials_file": "${BRAVO_CREDS}",
      "working_directory": "${BRAVO_DIR}",
      "channels": [{ "id": "${B1}", "delivery": "mentions" }${extra_bravo}],
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

# --- Start --------------------------------------------
write_persona_config declarative
CONFIG_A_COPY="${SCENARIO_ROOT}/config-phase-a.json"
cp -- "${CONFIG}" "${CONFIG_A_COPY}"

start_server --live
wait_membership_complete "${ALPHA}"
wait_membership_complete "${BRAVO}"

# The texts, printed while the start pass brings the personas up.
UNCLAIMED_CHANNEL="$(printed UNCLAIMED_CHANNEL)"
PERSONA_INVITED_CHANNEL="$(printed PERSONA_INVITED_CHANNEL)"
PERSONA_CHANNEL_DELIVERY_SET="$(printed PERSONA_CHANNEL_DELIVERY_SET)"
ROOT_LOOKUP_CAPABILITY_MISSING="$(printed ROOT_LOOKUP_CAPABILITY_MISSING)"
PARTICIPATION_RECOVERY="$(printed PARTICIPATION_RECOVERY)"
SWITCH_KEY="$(printed MODE_SWITCH_SETTING)"
FUNGIBLE="$(printed channelModeOf open)"
DECLARATIVE="$(printed channelModeOf strict)"
STORE_FILE="${SLACK_STATE_DIR}/$(printed CHANNEL_DELIVERY_FILE_NAME)"
SET_TOOL="$(printed SET_CHANNEL_DELIVERY_TOOL)"
APPLIED_CLASS="[slack] $(printed RELOAD_APPLIED):"
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
A1_SET_HELD_CAUSE="$(printed channelDeliverySetCause "${A1}" mentions all mentions)"
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

# Positive control: a push to a label no persona's token carries is
# refused, and the stub records the refusal.
unknown_event="$(message_event "${A1}" channel "$(plain_text)" "${TS_BASE}.000000")"
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
        "[slack] ${ROOT_LOOKUP_CAPABILITY_MISSING}:" "[slack] ${PARTICIPATION_RECOVERY}:"; do
        [[ -n "${term}" ]] || fail "$1: an empty term from the printer"
        [[ "$(count_server_log "${term}")" == 0 ]] || fail "$1: server.log names '${term}' in declarative mode"
    done
}

cmp -s -- "${CONFIG}" "${CONFIG_A_COPY}" || fail "phase A: config.json is not its copy, byte for byte"
[[ -f "${LAST}" ]] || fail "phase A: config.json.last-applied was not written"
configuration_record_matches "${CONFIG}" "${LAST}" reviewed || fail "phase A: reviewed input differs from config.json"
# Compare the entire applied configuration, allowing exactly the entries
# discovered as off in strict mode. U0 must remain genuinely unlisted.
check_phase_a_inventory() {
    jq -ne --slurpfile input "${CONFIG}" --slurpfile record "${LAST}" \
        --arg alpha "${ALPHA}" --arg bravo "${BRAVO}" --arg a1 "${A1}" \
        --arg f1 "${F1}" --arg f2 "${F2}" --arg u1 "${U1}" --arg t1 "${T1}" '
        ($input[0] | .personas |= map(.channels = ((.channels +
          (if .name == $alpha then [$f1,$f2,$u1,$t1]
           elif .name == $bravo then [$a1,$f1,$f2,$u1]
           else error("unexpected persona") end | map({id: ., delivery: "off"}))) | sort_by(.id)))) as $expected |
        ($record[0].applied | .personas |= map(.channels |= sort_by(.id))) == $expected' > /dev/null
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
confirm_switch() {
    local shape="$1" line="$2" step="$3" applied_before
    ALPHA_LAUNCHES="$(launch_counts "${ALPHA_REF}" "${ALPHA_START}" "${ALPHA_RELAUNCH}")"
    BRAVO_LAUNCHES="$(launch_counts "${BRAVO_REF}" "${BRAVO_START}" "${BRAVO_RELAUNCH}")"
    applied_before="$(count_log "${APPLIED_CLASS}")"
    local authority_before="${SCENARIO_ROOT}/authority-before-${shape}.json"
    cp -- "${LAST}" "${authority_before}"
    write_persona_config "${shape}"
    if [[ "${shape}" == fungible ]]; then
        configuration_request "mode-${shape}" request "${ALPHA}/${F1}/mentions" "${ALPHA}/${U1}/all" "${ALPHA}/${T1}/thread_hybrid" \
            "${BRAVO}/${F1}/mentions" "${BRAVO}/${F2}/mentions" "${BRAVO}/${A1}/mentions" "${BRAVO}/${U1}/all"
    else
        configuration_request "mode-${shape}" request
    fi
    wait_for_file "${PENDING}" "${TICK_WAIT_S}" "${step}: config.json.pending never appeared"
    wait_until 10 "${step}: the pending file never carried the switch's line" pending_has_line "${line}"
    check_pending_layout "${step}"
    configuration_application_preserved "${CONFIG}" "${authority_before}" "${LAST}" || fail "${step}: authority envelope changed before confirmation"
    mv -f -- "${PENDING}" "${APPLY}"
    wait_for_count "${APPLIED_CLASS}" $(( applied_before + 1 )) "${APPLY_WAIT_S}" "${step}: the confirmation was never applied"
    configuration_record_matches "${CONFIG}" "${LAST}" reviewed || fail "${step}: authority does not preserve the reviewed config.json bytes"
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

# --- Switch on ---------------------------------------------------
confirm_switch fungible "${SWITCH_ON_LINE}" "switch on"

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
push_message "${ALPHA_LABEL}" "${F1}" channel "<!here> ${TEST_NAME} broadcast"
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

# 10. bravo and A1, alpha's fungible destination: a mention is delivered (A1
#     joins bravo's heard set); bravo's call for A1 with `all` is accepted but
#     held at `mentions`; bravo, A1, plain: no delivery.
B10_MARK="$(log_mark)"
push_message "${BRAVO_LABEL}" "${A1}" channel "$(mention_text "${BRAVO_BOT_USER}")"
wait_queued "step 10: bravo A1 mention" "${BRAVO_DIR}" "${A1}" "${PUSH_TS}" "${VIA_MENTION}"
expect_since "${B10_MARK}" "${BRAVO_HEARS_A1}" 1 "step 10: bravo's persona-invited-channel lines for A1"
expect_attempt "step 10: bravo's set_channel_delivery A1 all" "${BRAVO_DIR}" "${BRAVO_A1_ALL_ARGS}" "${BRAVO_KEY}" mentions
expect_since "${B10_MARK}" "${BRAVO_SET_A1}" 1 "step 10: bravo's persona-channel-delivery-set lines for A1"
B10_PLAIN_MARK="$(log_mark)"
push_message "${BRAVO_LABEL}" "${A1}" channel "$(plain_text)"
B10_TS="${PUSH_TS}"
wait_since "${B10_PLAIN_MARK}" "$(plain_drop "${BRAVO_REF}" "${A1}" "${DROP_NOT_MENTIONED}")" "${EVENT_WAIT_S}" \
    "step 10: no not-mentioned line for bravo A1"
expect_queued "step 10: bravo A1 plain" 0 "${BRAVO_DIR}" "${A1}" "${B10_TS}"

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

# --- Phase R: thread evidence on alpha's thread_hybrid T1 ------------------
# Each reply below is a plain thread reply (no mention), so only thread
# participation can deliver it (`thread`). Its socket ack is read by its
# envelope ID, apart from its delivery.
# expect_acked <step> <envelope-id>: exactly one ack of that envelope.
expect_acked() {
    wait_until "${RECORD_WAIT_S}" "$1: no socket ack of envelope $2" rec_at_least 1 event=ws-message envelope_id="$2"
    [[ "$(rec_count event=ws-message envelope_id="$2")" == 1 ]] || fail "$1: envelope $2 was acked more than once"
}
# wait_queued_within <seconds> <step> <dir> <chat-id> <ts> <via>: wait_queued
# with its own bound, for a delivery only recovery releases.
wait_queued_within() {
    local bound="$1" step="$2"; shift 2
    wait_until "${bound}" "${step}: no delivery with via $4 in the accepted queue record of $1" queued "$@"
    wait_queued "${step}" "$@"
}
# reply_tool <step> <dir> <json-args>: alpha's reply tool call, which must succeed.
reply_tool() {
    local line
    line="$(stub_session_call "$2" "${REPLY_TOOL}" "$3")"
    jq -e '(has("error") | not) and .isError == false' <<< "${line}" > /dev/null \
        || fail "$1: the reply tool did not succeed: $(jq -r '.error // .text' <<< "${line}")"
}
# stub_control_loaded <n>: the stub re-read its control file at least <n>
# times (a request makes it look; /_health is one).
stub_control_loaded() {
    curl -s --max-time 5 -o /dev/null "${SCENARIO_SLACK_STUB_URL}/_health" || true
    rec_at_least "$1" event=control source=file
}
# set_alpha_evidence <step> <alpha-extra-json>: the start's control with
# alpha's thread-evidence fields (file_shares, faults) merged in, once the
# stub has loaded it.
STUB_CONTROL_BASE="${STUB_DIR}/control-start.json"
set_alpha_evidence() {
    local loaded
    loaded="$(rec_count event=control source=file)"
    [[ -f "${STUB_CONTROL_BASE}" ]] || cp -- "${STUB_CONTROL}" "${STUB_CONTROL_BASE}"
    jq --arg al "${ALPHA_LABEL}" --argjson extra "$2" '.tokens |= map(if .label == $al then . + $extra else . end)' \
        "${STUB_CONTROL_BASE}" | write_file "${STUB_CONTROL}" || fail "$1: could not write the stub's control file"
    wait_until "${RECORD_WAIT_S}" "$1: the stub never loaded the new control" stub_control_loaded $(( loaded + 1 ))
}
# upload_reply <step> <file-name>: alpha replies at T1's root with one file;
# R_FILE and R_SHARE are its upload's file ID and the share the stub posted.
upload_reply() {
    local step="$1" path="${ALPHA_DIR}/$2" shares
    printf '%s %s upload\n' "${TEST_NAME}" "$2" | write_file "${path}"
    shares="$(rec_count event=file-share label="${ALPHA_LABEL}" channel="${T1}")"
    reply_tool "${step}" "${ALPHA_DIR}" "$(jq -cn --arg c "${T1}" --arg t "${TEST_NAME} ${step}" --arg f "${path}" '{chat_id: $c, text: $t, files: [$f]}')"
    wait_until "${RECORD_WAIT_S}" "${step}: the upload made no share" \
        rec_at_least $(( shares + 1 )) event=file-share label="${ALPHA_LABEL}" channel="${T1}"
    R_FILE="$(rec_field file_id last event=file-share label="${ALPHA_LABEL}" channel="${T1}")"
    R_SHARE="$(rec_field share_ts last event=file-share label="${ALPHA_LABEL}" channel="${T1}")"
    [[ -n "${R_FILE}" && -n "${R_SHARE}" ]] || fail "${step}: the share line names no file or ts"
    [[ "$(rec_count event=api method=files.completeUploadExternal label="${ALPHA_LABEL}" channel="${T1}" answer=ok)" -ge 1 ]] \
        || fail "${step}: no successful completion of the upload"
}
# reply_tool_result <dir> <json-args>: the reply tool's result line, as
# REPLY_IS_ERROR (`true` or `false`) and REPLY_TEXT; a call that ended
# without a tool result fails.
reply_tool_result() {
    local line
    line="$(stub_session_call "$1" "${REPLY_TOOL}" "$2")"
    jq -e 'has("error") | not' <<< "${line}" > /dev/null \
        || fail "reply_tool_result: the reply tool ended without a result: $(jq -r '.error' <<< "${line}")"
    REPLY_IS_ERROR="$(jq -r '.isError' <<< "${line}")"
    REPLY_TEXT="$(jq -r '.text' <<< "${line}")"
}
RECOVERED_TEXT="$(printed participationRecoveredLine "${ALPHA}" "${ALPHA_KEY}")"
RECOVERED_LINE="$(matcher "${RECOVERED_TEXT}")"
CAPABILITY_REFUSED_TEXT="$(printed rootLookupCapabilityLine "${ALPHA}" "${ALPHA_KEY}" "${GAP_METHOD_REFUSED}" "${ROOT_LOOKUP_METHOD}" "${STUB_CAPABILITY_ERROR}")"
DEADLINE_MS="$(printed THREAD_MEMORY_LOOKUP_DEADLINE_MS)"
RETRY_MIN_MS="$(printed THREAD_MEMORY_RETRY_MIN_MS)"
RETRY_MAX_MS="$(printed THREAD_MEMORY_RETRY_MAX_MS)"
QUEUED_REACTION="$(printed DEFAULT_QUEUED_ACK_REACTION)"
# Every recovery release but R3's: one in-flight deadline, the longest local
# retry wait, then one answered attempt (src/delivery-constants.ts
# enrollmentRepairBoundMs).
(( RECOVERY_WAIT_S * 1000 >= 2 * DEADLINE_MS + RETRY_MAX_MS )) \
    || fail "phase R: RECOVERY_WAIT_S (${RECOVERY_WAIT_S}s) cannot cover one repair bound"
# R3's Retry-After: longer than any local retry spacing and than the refused
# method's re-check window (both THREAD_MEMORY_RETRY_MAX_MS at most), so only
# Slack's header, carried through the real SDK's rate-limit error, explains
# the wait.
R3_RETRY_AFTER_S=$(( RETRY_MAX_MS / 1000 + 5 ))
# R3's release: the re-check window after the refusal, which one local retry
# wait may overrun (R3's upload never shows a share, so its passes fail),
# then the Retry-After, then one answered attempt.
R3_WAIT_S=$(( 2 * RETRY_MAX_MS / 1000 + R3_RETRY_AFTER_S + DEADLINE_MS / 1000 ))

# R0. Incoming enrollment: a mention at T1's root is delivered `mention`,
#     and a reply in its thread `thread`.
push_message "${ALPHA_LABEL}" "${T1}" channel "$(mention_text "${ALPHA_BOT_USER}")" false
R0_TS="${PUSH_TS}"
wait_queued "phase R0: alpha T1 mention" "${ALPHA_DIR}" "${T1}" "${R0_TS}" "${VIA_MENTION}"
push_reply "${ALPHA_LABEL}" "${T1}" "${R0_TS}" "$(plain_text)"
wait_queued "phase R0: a reply in the mentioned thread" "${ALPHA_DIR}" "${T1}" "${PUSH_TS}" "${VIA_THREAD}"
expect_acked "phase R0: the reply" "${PUSH_ENVELOPE}"

# R1. An own root post: alpha's reply tool posts at T1's root, and a reply
#     in that thread is delivered `thread` with no root lookup: the post's
#     own ts enrolled it.
reply_tool "phase R1" "${ALPHA_DIR}" "$(jq -cn --arg c "${T1}" --arg t "${TEST_NAME} phase R1 root" '{chat_id: $c, text: $t}')"
R1_ROOT="$(rec_field response_ts last event=api method=chat.postMessage label="${ALPHA_LABEL}" channel="${T1}" answer=ok)"
[[ -n "${R1_ROOT}" ]] || fail "phase R1: the stub recorded no root ts for alpha's post"
push_reply "${ALPHA_LABEL}" "${T1}" "${R1_ROOT}" "$(plain_text)"
wait_queued "phase R1: a reply in alpha's own thread" "${ALPHA_DIR}" "${T1}" "${PUSH_TS}" "${VIA_THREAD}"
expect_acked "phase R1: the reply" "${PUSH_ENVELOPE}"
[[ "$(rec_count event=api method=conversations.replies ts="${R1_ROOT}")" == 0 ]] \
    || fail "phase R1: a root lookup for alpha's own post"

# R2. A file upload's root from its share: the completion names no share,
#     so recovery reads files.info for the actual upload ID, enrolls the
#     share's ts and reports recovered; a reply there is then delivered
#     `thread` with no root lookup.
R2_MARK="$(log_mark)"
upload_reply "phase R2" phase-r2.txt
R2_SHARE="${R_SHARE}"
wait_until "${RECOVERY_WAIT_S}" "phase R2: no successful files.info for upload ${R_FILE}" \
    rec_at_least 1 event=api method=files.info label="${ALPHA_LABEL}" file="${R_FILE}" answer=ok
wait_since "${R2_MARK}" "${RECOVERED_LINE}" "${RECOVERY_WAIT_S}" "phase R2: alpha's recovery never reported recovered"
push_reply "${ALPHA_LABEL}" "${T1}" "${R2_SHARE}" "$(plain_text)"
wait_queued "phase R2: a reply in the upload's thread" "${ALPHA_DIR}" "${T1}" "${PUSH_TS}" "${VIA_THREAD}"
expect_acked "phase R2: the reply" "${PUSH_ENVELOPE}"
[[ "$(rec_count event=api method=conversations.replies ts="${R2_SHARE}")" == 0 ]] \
    || fail "phase R2: a root lookup for the upload's share"

# R3. A root lookup through a refused method and a rate limit: no share
#     anywhere, so a reply in the upload's thread is held (no ack) until
#     conversations.replies for that root answers. Slack refuses it
#     (missing_scope: the capability line); the refused method is tried
#     again only once its re-check window (THREAD_MEMORY_RETRY_MAX_MS) has
#     passed, and Slack rate-limits that attempt (429, Retry-After
#     R3_RETRY_AFTER_S, waited out in full), then answers with alpha's own
#     root naming the upload: the reply is delivered `thread`, acked once,
#     after that answer.
set_alpha_evidence "phase R3" "$(jq -cn --arg c "${T1}" --argjson ra "${R3_RETRY_AFTER_S}" '{file_shares: "none", faults: [
    {method: "conversations.replies", outcome: "capability", channel: $c, times: 1},
    {method: "conversations.replies", outcome: "ratelimited", channel: $c, retry_after_s: $ra, times: 1}]}')"
R3_MARK="$(log_mark)"
upload_reply "phase R3" phase-r3.txt
R3_SHARE="${R_SHARE}"
push_reply "${ALPHA_LABEL}" "${T1}" "${R3_SHARE}" "$(plain_text)"
R3_TS="${PUSH_TS}"
R3_ENVELOPE="${PUSH_ENVELOPE}"
wait_since "${R3_MARK}" "$(matcher "${CAPABILITY_REFUSED_TEXT}")" \
    "${RECOVERY_WAIT_S}" "phase R3: no root-lookup capability line for the refused method"
wait_queued_within "${R3_WAIT_S}" "phase R3: the held reply" "${ALPHA_DIR}" "${T1}" "${R3_TS}" "${VIA_THREAD}"
expect_acked "phase R3: the held reply" "${R3_ENVELOPE}"
R3_ANSWERS="$(rec_field answer all event=api method=conversations.replies channel="${T1}" ts="${R3_SHARE}")"
[[ "${R3_ANSWERS}" == "missing_scope ratelimited ok"* ]] \
    || fail "phase R3: conversations.replies for root ${R3_SHARE} answered '${R3_ANSWERS}', expected missing_scope, ratelimited, then ok"
[[ "$(rec_count event=api method=conversations.replies channel="${T1}" ts="${R3_SHARE}" status=429)" == 1 ]] \
    || fail "phase R3: the rate-limited lookup was not one HTTP 429"
R3_OK_SEQ="$(rec_field seq first event=api method=conversations.replies channel="${T1}" ts="${R3_SHARE}" answer=ok)"
R3_ACK_SEQ="$(rec_field seq first event=ws-message envelope_id="${R3_ENVELOPE}")"
(( R3_ACK_SEQ > R3_OK_SEQ )) || fail "phase R3: the held reply was acked (record ${R3_ACK_SEQ}) before its root lookup answered (record ${R3_OK_SEQ})"
R3_REFUSED_AT="$(rec_field arrived_mono_ms first event=api method=conversations.replies channel="${T1}" ts="${R3_SHARE}" fault=capability)"
R3_LIMITED_AT="$(rec_field arrived_mono_ms first event=api method=conversations.replies channel="${T1}" ts="${R3_SHARE}" status=429)"
R3_RETRIED_AT="$(rec_field arrived_mono_ms first event=api method=conversations.replies channel="${T1}" ts="${R3_SHARE}" answer=ok)"
[[ -n "${R3_REFUSED_AT}" && -n "${R3_LIMITED_AT}" && -n "${R3_RETRIED_AT}" ]] \
    || fail "phase R3: the stub recorded no arrival time for the refused lookup, the rate-limited one or its retry"
(( R3_LIMITED_AT - R3_REFUSED_AT >= RETRY_MAX_MS )) \
    || fail "phase R3: the refused method was tried again $(( R3_LIMITED_AT - R3_REFUSED_AT )) ms after the refusal, within its ${RETRY_MAX_MS} ms re-check window"
(( R3_RETRIED_AT - R3_LIMITED_AT >= R3_RETRY_AFTER_S * 1000 )) \
    || fail "phase R3: the lookup was retried $(( R3_RETRIED_AT - R3_LIMITED_AT )) ms after the 429, before its Retry-After of ${R3_RETRY_AFTER_S}s"
expect_since "${R3_MARK}" "$(matcher "[slack] ${ROOT_LOOKUP_CAPABILITY_MISSING}: persona=${ALPHA_REF} ")" 1 \
    "phase R3: root-lookup capability lines (a repeat refusal reports nothing)"
wait_since "${R3_MARK}" "${RECOVERED_LINE}" "${RECOVERY_WAIT_S}" "phase R3: alpha's recovery never reported recovered"

# R4. A deleted root is a gap, reported and not delivered (no restoration or
#     replacement is exercised): no share, and conversations.replies shows a
#     tombstone root. The reply is never acked; read after the gap line and
#     a later delivery on alpha's connection (a T1 mention).
set_alpha_evidence "phase R4" '{"file_shares": "none"}'
R4_MARK="$(log_mark)"
upload_reply "phase R4" phase-r4.txt
R4_SHARE="${R_SHARE}"
R4_FILE="${R_FILE}"
# R4's tombstone stays in every later control, so the gap stands through the restart.
R4_FAULTS="$(jq -cn --arg c "${T1}" --arg r "${R4_SHARE}" '[{method: "conversations.replies", outcome: "deleted", channel: $c, ts: $r, times: 0}]')"
set_alpha_evidence "phase R4" "$(jq -cn --argjson f "${R4_FAULTS}" '{file_shares: "none", faults: $f}')"
R4_TEXT="$(plain_text)"
push_reply "${ALPHA_LABEL}" "${T1}" "${R4_SHARE}" "${R4_TEXT}"
R4_TS="${PUSH_TS}"
R4_ENVELOPE="${PUSH_ENVELOPE}"
R4_GAP_TEXT="$(printed participationRecoveryLine "${ALPHA}" "${ALPHA_KEY}" "${CAUSE_ROOT_DELETED}" "${T1}" "${R4_SHARE}" - -)"
wait_since "${R4_MARK}" "$(matcher "${R4_GAP_TEXT}")" "${RECOVERY_WAIT_S}" "phase R4: no root-deleted gap line"
push_message "${ALPHA_LABEL}" "${T1}" channel "$(mention_text "${ALPHA_BOT_USER}")" false
wait_queued "phase R4: alpha T1 mention, after the gap" "${ALPHA_DIR}" "${T1}" "${PUSH_TS}" "${VIA_MENTION}"
expect_queued "phase R4: the reply under a deleted root" 0 "${ALPHA_DIR}" "${T1}" "${R4_TS}"
[[ "$(rec_count event=ws-message envelope_id="${R4_ENVELOPE}")" == 0 ]] || fail "phase R4: the reply under a deleted root was acked"
expect_since "${R4_MARK}" "${RECOVERED_LINE}" 0 "phase R4: recovered lines while the gap stands"

# R5. A foreign root decides nothing for alpha: a human's plain T1 root (a
#     not-mentioned drop), then a reply under it, held while R4's upload root
#     is unknown. Its lookup shows the human's root: the reply is dropped
#     not-mentioned, never delivered, and acked once after that answer.
R5_ROOT_MARK="$(log_mark)"
push_message "${ALPHA_LABEL}" "${T1}" channel "$(plain_text)" false
R5_ROOT="${PUSH_TS}"
wait_since "${R5_ROOT_MARK}" "$(plain_drop "${ALPHA_REF}" "${T1}" "${DROP_NOT_MENTIONED}")" "${EVENT_WAIT_S}" \
    "phase R5: the foreign root did not drop as not-mentioned"
R5_MARK="$(log_mark)"
push_reply "${ALPHA_LABEL}" "${T1}" "${R5_ROOT}" "$(plain_text)"
R5_TS="${PUSH_TS}"
R5_ENVELOPE="${PUSH_ENVELOPE}"
wait_since "${R5_MARK}" "$(plain_drop "${ALPHA_REF}" "${T1}" "${DROP_NOT_MENTIONED}")" "${RECOVERY_WAIT_S}" \
    "phase R5: the reply under a foreign root was never decided"
expect_acked "phase R5: the reply under a foreign root" "${R5_ENVELOPE}"
R5_OK_SEQ="$(rec_field seq first event=api method=conversations.replies channel="${T1}" ts="${R5_ROOT}" answer=ok)"
R5_ACK_SEQ="$(rec_field seq first event=ws-message envelope_id="${R5_ENVELOPE}")"
[[ -n "${R5_OK_SEQ}" ]] || fail "phase R5: no answered root lookup for the foreign root ${R5_ROOT}"
(( R5_ACK_SEQ > R5_OK_SEQ )) || fail "phase R5: the reply was acked (record ${R5_ACK_SEQ}) before its root lookup answered (record ${R5_OK_SEQ})"
push_message "${ALPHA_LABEL}" "${T1}" channel "$(mention_text "${ALPHA_BOT_USER}")" false
wait_queued "phase R5: alpha T1 mention, after the foreign root" "${ALPHA_DIR}" "${T1}" "${PUSH_TS}" "${VIA_MENTION}"
expect_queued "phase R5: the reply under a foreign root" 0 "${ALPHA_DIR}" "${T1}" "${R5_TS}"
expect_queued "phase R5: the foreign root" 0 "${ALPHA_DIR}" "${T1}" "${R5_ROOT}"

# R6. A later part's upload fails after an earlier one succeeded, through
#     the real SDK upload path: alpha replies at T1's root to a delivered
#     mention, with its text and two files, one upload each; Slack completes
#     the first and refuses the second's completion (transient). The tool
#     reports the partial post; the queued reaction on the mention is removed
#     once; the first file's share is alpha's own root, which a held reply
#     under it shows by file ID; nothing is posted or completed again.
push_message "${ALPHA_LABEL}" "${T1}" channel "$(mention_text "${ALPHA_BOT_USER}")" false
R6_MESSAGE="${PUSH_TS}"
wait_queued "phase R6: alpha T1 mention, the message replied to" "${ALPHA_DIR}" "${T1}" "${R6_MESSAGE}" "${VIA_MENTION}"
wait_until "${RECORD_WAIT_S}" "phase R6: no queued reaction on the mention" \
    rec_at_least 1 event=api method=reactions.add label="${ALPHA_LABEL}" timestamp="${R6_MESSAGE}" name="${QUEUED_REACTION}" answer=ok
set_alpha_evidence "phase R6" "$(jq -cn --arg c "${T1}" --argjson f "${R4_FAULTS}" '{file_shares: "none", faults: ($f + [
    {method: "files.completeUploadExternal", outcome: "transient", channel: $c, skip: 1, times: 1}])}')"
R6_SHARES_BEFORE="$(rec_count event=file-share label="${ALPHA_LABEL}" channel="${T1}")"
R6_FILES=()
for part in a b; do
    printf '%s phase-r6-%s upload\n' "${TEST_NAME}" "${part}" | write_file "${ALPHA_DIR}/phase-r6-${part}.txt"
    R6_FILES+=("${ALPHA_DIR}/phase-r6-${part}.txt")
done
reply_tool_result "${ALPHA_DIR}" "$(jq -cn --arg c "${T1}" --arg t "${TEST_NAME} phase R6" --arg m "${R6_MESSAGE}" \
    --arg a "${R6_FILES[0]}" --arg b "${R6_FILES[1]}" '{chat_id: $c, text: $t, message_id: $m, files: [$a, $b]}')"
R6_POST="$(rec_field response_ts last event=api method=chat.postMessage label="${ALPHA_LABEL}" channel="${T1}" answer=ok)"
[[ -n "${R6_POST}" ]] || fail "phase R6: the stub recorded no ts for the reply's text"
R6_PARTIAL_TEXT="$(printed replyPartialFailureText "${T1}" 1 1 "${R6_POST}" 1 2 "${STUB_TRANSIENT_ERROR}")"
[[ "${REPLY_IS_ERROR}" == true && "${REPLY_TEXT}" == "${R6_PARTIAL_TEXT}" ]] \
    || fail "phase R6: the reply tool answered (isError ${REPLY_IS_ERROR}) '${REPLY_TEXT}', expected the partial-post error '${R6_PARTIAL_TEXT}'"
[[ "$(rec_count event=api method=files.completeUploadExternal label="${ALPHA_LABEL}" channel="${T1}" fault=transient)" == 1 ]] \
    || fail "phase R6: the second file's completion was not refused exactly once"
[[ "$(rec_count event=file-share label="${ALPHA_LABEL}" channel="${T1}")" == $(( R6_SHARES_BEFORE + 1 )) ]] \
    || fail "phase R6: the upload made other than exactly one share"
R6_FILE="$(rec_field file_id last event=file-share label="${ALPHA_LABEL}" channel="${T1}")"
R6_SHARE="$(rec_field share_ts last event=file-share label="${ALPHA_LABEL}" channel="${T1}")"
[[ -n "${R6_FILE}" && -n "${R6_SHARE}" ]] || fail "phase R6: the share line names no file or ts"
wait_until "${RECORD_WAIT_S}" "phase R6: the queued reaction on the mention was never removed" \
    rec_at_least 1 event=api method=reactions.remove label="${ALPHA_LABEL}" timestamp="${R6_MESSAGE}" name="${QUEUED_REACTION}"
push_reply "${ALPHA_LABEL}" "${T1}" "${R6_SHARE}" "$(plain_text)"
R6_TS="${PUSH_TS}"
R6_ENVELOPE="${PUSH_ENVELOPE}"
wait_queued_within "${RECOVERY_WAIT_S}" "phase R6: the reply under the first file's share" "${ALPHA_DIR}" "${T1}" "${R6_TS}" "${VIA_THREAD}"
expect_acked "phase R6: the reply under the first file's share" "${R6_ENVELOPE}"
R6_OK_SEQ="$(rec_field seq first event=api method=conversations.replies channel="${T1}" ts="${R6_SHARE}" answer=ok)"
R6_ACK_SEQ="$(rec_field seq first event=ws-message envelope_id="${R6_ENVELOPE}")"
[[ -n "${R6_OK_SEQ}" ]] || fail "phase R6: no answered root lookup for the first file's share ${R6_SHARE}"
(( R6_ACK_SEQ > R6_OK_SEQ )) || fail "phase R6: the reply was acked (record ${R6_ACK_SEQ}) before its root lookup answered (record ${R6_OK_SEQ})"
[[ "$(rec_count event=api method=reactions.remove label="${ALPHA_LABEL}" timestamp="${R6_MESSAGE}")" == 1 ]] \
    || fail "phase R6: the queued reaction on the mention was removed other than once"

# R7. A hung root lookup ends at its deadline: no share, and alpha's own root
#     lookup for an upload's share hangs once. The client aborts it at
#     THREAD_MEMORY_LOOKUP_DEADLINE_MS (the stub sees the abort, long before
#     it would give up), recovery reports the deadline, and the next attempt,
#     after the retry spacing, is answered: the held reply is delivered
#     `thread` and acked once, after that answer. A late answer to an
#     abandoned attempt is not exercised here (a recorded gap).
R7_MARK="$(log_mark)"
upload_reply "phase R7" phase-r7.txt
R7_SHARE="${R_SHARE}"
set_alpha_evidence "phase R7" "$(jq -cn --arg c "${T1}" --arg r "${R7_SHARE}" --argjson f "${R4_FAULTS}" '{file_shares: "none", faults: ($f + [
    {method: "conversations.replies", outcome: "hung", channel: $c, ts: $r, times: 1}])}')"
push_reply "${ALPHA_LABEL}" "${T1}" "${R7_SHARE}" "$(plain_text)"
R7_TS="${PUSH_TS}"
R7_ENVELOPE="${PUSH_ENVELOPE}"
wait_until $(( RECOVERY_WAIT_S + DEADLINE_MS / 1000 )) "phase R7: the hung root lookup never ended" \
    rec_at_least 1 event=api method=conversations.replies channel="${T1}" ts="${R7_SHARE}" fault=hung
[[ "$(rec_field aborted first event=api method=conversations.replies ts="${R7_SHARE}" fault=hung)" == True ]] \
    || fail "phase R7: the hung root lookup ended without the client aborting it"
R7_HELD_MS="$(rec_field held_ms first event=api method=conversations.replies ts="${R7_SHARE}" fault=hung)"
(( R7_HELD_MS >= DEADLINE_MS - 3000 && R7_HELD_MS <= DEADLINE_MS + 5000 )) \
    || fail "phase R7: the hung root lookup was aborted after ${R7_HELD_MS} ms, not at its ${DEADLINE_MS} ms deadline"
R7_DEADLINE_TEXT="$(printed participationRecoveryLine "${ALPHA}" "${ALPHA_KEY}" "${CAUSE_METADATA}" "${T1}" "${R7_SHARE}" - "${FAILURE_DEADLINE}")"
wait_since "${R7_MARK}" "$(matcher "${R7_DEADLINE_TEXT}")" "${RECORD_WAIT_S}" "phase R7: no deadline line for the hung root lookup"
wait_queued_within "${RECOVERY_WAIT_S}" "phase R7: the held reply" "${ALPHA_DIR}" "${T1}" "${R7_TS}" "${VIA_THREAD}"
expect_acked "phase R7: the held reply" "${R7_ENVELOPE}"
R7_ANSWERS="$(rec_field answer all event=api method=conversations.replies channel="${T1}" ts="${R7_SHARE}")"
[[ "${R7_ANSWERS}" == "hung ok"* ]] \
    || fail "phase R7: conversations.replies for root ${R7_SHARE} answered '${R7_ANSWERS}', expected hung, then ok"
R7_HUNG_AT="$(rec_field arrived_mono_ms first event=api method=conversations.replies ts="${R7_SHARE}" fault=hung)"
R7_RETRIED_AT="$(rec_field arrived_mono_ms first event=api method=conversations.replies ts="${R7_SHARE}" answer=ok)"
# The abort's own trip to the stub may land a few milliseconds after the
# client set its next permitted attempt: 1 s of slack.
(( R7_RETRIED_AT - R7_HUNG_AT >= R7_HELD_MS + RETRY_MIN_MS - 1000 )) \
    || fail "phase R7: the lookup was retried $(( R7_RETRIED_AT - R7_HUNG_AT - R7_HELD_MS )) ms after the hung attempt was aborted, within the ${RETRY_MIN_MS} ms retry spacing"
R7_OK_SEQ="$(rec_field seq first event=api method=conversations.replies ts="${R7_SHARE}" answer=ok)"
R7_ACK_SEQ="$(rec_field seq first event=ws-message envelope_id="${R7_ENVELOPE}")"
(( R7_ACK_SEQ > R7_OK_SEQ )) || fail "phase R7: the held reply was acked (record ${R7_ACK_SEQ}) before its root lookup answered (record ${R7_OK_SEQ})"

# Metadata repair repeats no post: alpha's T1 posts are its six reply
# texts (R1 to R4, R6, R7) and its uploads one completion each (R2 to R4,
# R6's first file, R7), with R6's second completion refused once and never
# tried again. R4's gap still stands, so no recovery is reported after it.
[[ "$(rec_count event=api method=chat.postMessage label="${ALPHA_LABEL}" channel="${T1}" answer=ok)" == 6 ]] \
    || fail "phase R: alpha's T1 posts were repeated or lost"
[[ "$(rec_count event=api method=files.completeUploadExternal label="${ALPHA_LABEL}" channel="${T1}" answer=ok)" == 5 ]] \
    || fail "phase R: alpha's T1 uploads were repeated or lost"
[[ "$(rec_count event=api method=files.completeUploadExternal label="${ALPHA_LABEL}" channel="${T1}")" == 6 ]] \
    || fail "phase R: alpha's refused T1 completion was tried again"
expect_since "${R4_MARK}" "${RECOVERED_LINE}" 0 "phase R: recovered lines while R4's gap stands"

# --- Persistence across a restart ----------------------
# Queue acceptance above can precede typing and its receipt. Settle both
# personas before checking an immediate idle-session reconnect on restart.
for dir in "${ALPHA_DIR}" "${BRAVO_DIR}"; do
    wait_until "${SESSION_WAIT_S}" "restart: accepted deliveries of ${dir} never received all their receipts" queue_drained "${dir}"
done
STORE_BEFORE_RESTART="${SCENARIO_ROOT}/store-before-restart.json"
cp -- "${STORE_FILE}" "${STORE_BEFORE_RESTART}"
declare -A DELIVERIES_BEFORE=()
for dir in "${ALPHA_DIR}" "${BRAVO_DIR}"; do
    DELIVERIES_BEFORE["${dir}"]="${SCENARIO_ROOT}/deliveries-before-restart.$(basename "${dir}")"
    queue_accepted "${QUEUE_KEY[${dir}]}" > "${DELIVERIES_BEFORE[${dir}]}"
done
completions_before="$(count_log "${STARTUP_COMPLETE}")"
alpha_connected_before="$(count_log "$(session_connected "${ALPHA_REF}")")"
bravo_connected_before="$(count_log "$(session_connected "${BRAVO_REF}")")"
alpha_sockets_before="$(rec_count event=ws-open label="${ALPHA_LABEL}")"
bravo_sockets_before="$(rec_count event=ws-open label="${BRAVO_LABEL}")"
RESTART_MARK="$(log_mark)"
STUB_RESTART_SEQ="$(rec_field seq last)"
[[ -n "${STUB_RESTART_SEQ}" ]] || fail "restart: the stub's record has no line"
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
bun "${SCENARIO_FIXTURES}/fmk-texts.ts" sharedAuthorityPreserved "${CONFIG}" "${STORE_BEFORE_RESTART}" "${STORE_FILE}" \
    || fail "restart: shared choices, identities or reviewed input changed"
for dir in "${ALPHA_DIR}" "${BRAVO_DIR}"; do
    # Delivered content is compacted at startup; its exact dedupe facts
    # survive, while this scenario retains its own acceptance evidence.
    jq -sS 'map({seq,key,received_at}) | sort_by(.seq)' "${DELIVERIES_BEFORE[${dir}]}" \
        > "${SCENARIO_ROOT}/expected-dedupe-after-restart"
    jq -sS 'map(select(.kind == "accepted" and .compact != "allocation") | {seq,key,received_at}) | sort_by(.seq)' \
        "${DELIVERIES_FILE[${dir}]}" > "${SCENARIO_ROOT}/actual-dedupe-after-restart"
    cmp -s -- "${SCENARIO_ROOT}/expected-dedupe-after-restart" "${SCENARIO_ROOT}/actual-dedupe-after-restart" \
        || fail "restart: dedupe facts of ${dir} changed"
    queue_accepted "${QUEUE_KEY[${dir}]}" > "${SCENARIO_ROOT}/accepted-after-restart"
    [[ ! -s "${SCENARIO_ROOT}/accepted-after-restart" ]] \
        || fail "restart: receipted message content of ${dir} survived startup compaction"
done

# Phase R's unresolved evidence survives the restart: R4's upload is still
# pending its root (files.info is asked again for its file), R4's root
# lookup is asked again and is still a tombstone (its gap line again, in
# this server run), Slack's redelivery of R4's held reply is neither acked
# nor queued, and no recovery is reported.
wait_until "${RECOVERY_WAIT_S}" "restart: R4's pending upload ${R4_FILE} was not looked up again" \
    rec_at_least 1 event=api method=files.info label="${ALPHA_LABEL}" file="${R4_FILE}" "seq>${STUB_RESTART_SEQ}"
wait_until "${RECOVERY_WAIT_S}" "restart: R4's root lookup was not asked again" \
    rec_at_least 1 event=api method=conversations.replies label="${ALPHA_LABEL}" channel="${T1}" ts="${R4_SHARE}" fault=deleted "seq>${STUB_RESTART_SEQ}"
wait_since "${RESTART_MARK}" "$(matcher "${R4_GAP_TEXT}")" "${RECOVERY_WAIT_S}" "restart: no root-deleted gap line for R4 in this run"
push_event "${ALPHA_LABEL}" "$(message_event "${T1}" channel "${R4_TEXT}" "${R4_TS}" | jq -c --arg r "${R4_SHARE}" '. + {thread_ts: $r}')" false
R4_REDELIVERY="${PUSH_ENVELOPE}"
push_message "${ALPHA_LABEL}" "${T1}" channel "$(mention_text "${ALPHA_BOT_USER}")" false
wait_queued "restart: alpha T1 mention, after R4's redelivery" "${ALPHA_DIR}" "${T1}" "${PUSH_TS}" "${VIA_MENTION}"
[[ "$(rec_count event=ws-message envelope_id="${R4_REDELIVERY}")" == 0 ]] || fail "restart: Slack's redelivery of R4's held reply was acked"
expect_queued "restart: R4's held reply" 0 "${ALPHA_DIR}" "${T1}" "${R4_TS}"
expect_since "${RESTART_MARK}" "${RECOVERED_LINE}" 0 "restart: recovered lines while R4's gap stands"

# alpha calls the tool for F1 with `all` before any F1 event: accepted as a
# stored channel, `all` before and after. Its result also shows the new
# client polled the request file.
expect_attempt "restart: alpha retries its retained ID" "${ALPHA_DIR}" "${F1_RETRY_ARGS}" "${ALPHA_KEY}" all history
expect_since "${RESTART_MARK}" "${ALPHA_SET_F1_AGAIN}" 0 "restart: history creates no assignment diagnostic"
expect_attempt "restart: alpha deliberately writes all again" "${ALPHA_DIR}" "${F1_FRESH_ARGS}" "${ALPHA_KEY}" all
expect_since "${RESTART_MARK}" "${ALPHA_SET_F1_AGAIN}" 1 "restart: alpha's persona-channel-delivery-set lines (all to all)"

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

# --- Switch off --------------------------------------------------
STORE_BEFORE_OFF="${SCENARIO_ROOT}/store-before-off.json"
cp -- "${STORE_FILE}" "${STORE_BEFORE_OFF}"
confirm_switch switch-off "${SWITCH_OFF_LINE}" "switch off"

# alpha, F1, plain: strict mode retains its shared applied all choice.
OFF_MARK="$(log_mark)"
push_message "${ALPHA_LABEL}" "${F1}" channel "$(plain_text)"
OFF_F1_TS="${PUSH_TS}"
wait_queued "switch off: alpha F1 keeps its shared applied choice" "${ALPHA_DIR}" "${F1}" "${OFF_F1_TS}" "${VIA_RECEIVE_ALL_SHARED}"
expect_since "${OFF_MARK}" "${F1_UNCLAIMED}" 0 "switch off: an applied channel is still configured"

# alpha and bravo both hold A1 at all; strict mode has no open destination guard.
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
expect_attempt "switch off: retained history remains readable" "${ALPHA_DIR}" "${F1_RETRY_ARGS}" "${ALPHA_KEY}" all history
expect_tool "switch off: alpha's set_channel_delivery F1 all" "${ALPHA_DIR}" "${STRICT_FRESH_ARGS}" true "${ALPHA_DECLARATIVE_REFUSAL}"
jq -ne --slurpfile before "${STORE_BEFORE_OFF}" --slurpfile after "${STORE_FILE}" '$before[0].personas == $after[0].personas' > /dev/null \
    || fail "switch off: applied persona choices changed"

# demo: retain one real stub DM's log and transcript
# metadata before the successful scenario's EXIT trap deletes both. The
# existing queue checks establish acceptance and receipt completion; this
# export prints the observed evidence; exact log assertion follows below.
push_message "${BRAVO_LABEL}" "${DM}" im "$(plain_text)"
DM_TS="${PUSH_TS}"
wait_queued "E5: bravo direct DM" "${BRAVO_DIR}" "${DM}" "${DM_TS}" dm
wait_until "${SESSION_WAIT_S}" "E5: bravo's direct DM never received its receipt" queue_drained "${BRAVO_DIR}"
RECEIVED_LABEL="$(printed MESSAGE_RECEIVED)"
DELIVERED_LABEL="$(printed MESSAGE_DELIVERED)"
python3 - "${SLACK_STATE_DIR}/server.log" "${DELIVERIES_FILE[${BRAVO_DIR}]}" "${DM}" "${DM_TS}" \
    "${RECEIVED_LABEL}" "${DELIVERED_LABEL}" << 'EOF'
import json, re, sys
log, journal, channel, ts, *labels = sys.argv[1:]
print("E5 stub DM evidence (metadata only):")
with open(log) as f:
    for line in f:
        if any(f"[slack] {label}:" in line for label in labels) and f'chat_id="{channel}"' in line and f'ts="{ts}"' in line:
            print(line.rstrip())
with open(journal) as f:
    records = [json.loads(line) for line in f if line.strip()]
accepted = next(r for r in records if r["kind"] == "accepted" and r.get("channel") == channel and r.get("ts") == ts)
print("queue acceptance: " + json.dumps({k: accepted[k] for k in ("seq", "channel", "ts", "via", "received_at")}))
for delivered in records:
    if delivered["kind"] != "delivered" or delivered["seq"] != accepted["seq"]:
        continue
    receipt = delivered["receipt"]
    print("queue receipt: " + json.dumps({k: delivered[k] for k in ("seq", "part", "at", "receipt")}))
    with open(receipt["path"]) as f:
        for line in f:
            record = json.loads(line)
            if record.get("uuid") != receipt.get("uuid"):
                continue
            content = record.get("message", {}).get("content", "")
            tag = re.search(r"<channel\b([^>]*)>", content)
            metadata = {k: record[k] for k in ("type", "uuid", "timestamp", "sessionId")}
            metadata["tag"] = dict(re.findall(r'([a-z_]+)="([^"]*)"', tag[1])) if tag else None
            print("transcript receipt: " + json.dumps(metadata))
EOF

# Every persona's complete accepted set, including absence of all other inputs.
# Multiple journal records per item never count as additional acceptances.
for dir in "${ALPHA_DIR}" "${BRAVO_DIR}"; do
    key="${QUEUE_KEY[${dir}]}"
    expected_rows="${SCENARIO_ROOT}/expected-queue-${key}.jsonl"
    : > "${expected_rows}"
    for fact in "${!EXPECTED_QUEUE_ROWS[@]}"; do
        [[ "${fact}" == "${key}|"* ]] || continue
        printf '%s\n' "${EXPECTED_QUEUE_ROWS[${fact}]}" >> "${expected_rows}"
    done
    jq -sS 'sort' "${expected_rows}" > "${expected_rows}.sorted"
    queue_accepted "${key}" > "${SCENARIO_ROOT}/current-queue-${key}"
    jq -sS 'map([.channel,.ts,.via]) | sort' "${DELIVERIES_BEFORE[${dir}]}" "${SCENARIO_ROOT}/current-queue-${key}" \
        > "${SCENARIO_ROOT}/actual-queue-${key}"
    cmp -s -- "${expected_rows}.sorted" "${SCENARIO_ROOT}/actual-queue-${key}" \
        || fail "closing: persona ${key} has an unexpected accepted queue set"
done

# --- Closing -----------------------------------------------------
stop_server --stop-bots
port_closed "${SCENARIO_PORT}" || fail "closing: something still answers on 127.0.0.1:${SCENARIO_PORT}"
stop_tracked_pid "${STUB_PID}" 10 "the Slack stub did not exit on SIGTERM"

# the complete accepted sets also pin exactly one received
# diagnostic per persona/source/conversation/ts/sender. This includes paired
# event dedupe, both shared recipients and the DM, and excludes every refused
# input and nonrecipient. DELIVERIES_BEFORE preserves pre-compaction evidence;
# via remains a queue assertion, not a diagnostic field. Read every rotation
# after stopping the writers, following the positive decisions above.
python3 - "${SLACK_STATE_DIR}" "${SCENARIO_ROOT}" "${RECEIVED_LABEL}" "${HUMAN}" "${ALPHA_KEY}" "${BRAVO_KEY}" "${ALPHA}" "${BRAVO}" << 'EOF' \
    || fail "closing: received diagnostics differ from the exact accepted set"
import collections, glob, json, os, re, sys
state, root, label, sender, alpha_key, bravo_key, alpha, bravo = sys.argv[1:]
names = {alpha_key: alpha, bravo_key: bravo}
keys = list(names)
expected = collections.Counter()
for key in keys:
    with open(os.path.join(root, f"expected-queue-{key}.jsonl")) as f:
        for line in f:
            channel, ts, via = json.loads(line)
            expected[(key, "slack", channel, ts, sender)] += 1
assert expected and all(n == 1 for n in expected.values()), "invalid expected acceptance set"
quoted = r'("(?:\\.|[^"\\])*")'
pattern = re.compile(r'persona=' + quoted + r' \(key=(\S+)\) source=(slack) chat_id=' + quoted + r' ts=' + quoted + r' sender_id=' + quoted)
actual = collections.Counter()
for path in glob.glob(os.path.join(state, "server.log*")):
    with open(path) as f:
        for line in f:
            marker = f"[slack] {label}: "
            if marker not in line:
                continue
            match = pattern.fullmatch(line.split(marker, 1)[1].rstrip("\n"))
            assert match, "malformed received diagnostic"
            name, key, source, channel, ts, user = match.groups()
            assert key in names and json.loads(name) == names[key], "wrong received persona identity"
            actual[(key, source, json.loads(channel), json.loads(ts), json.loads(user))] += 1
assert actual == expected, f"received mismatch: missing={expected - actual}, extra={actual - expected}"
print(f"received evidence: {sum(actual.values())} exact acceptances, paired events deduped")
EOF

# The token scan, read once every writer has stopped (the files stay until
# the EXIT trap removes the scratch root). files: server.log and
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
