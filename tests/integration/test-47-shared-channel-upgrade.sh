#!/usr/bin/env bash
# Shared-channel manual upgrade on the packed server (t1.tad.5i SR-8.3,
# SR-8.7 AC-U01 to U09 and U11 to U13; t1.k49.39 SR-2.4.4). Run only through
# /ci. Each case is materialized from tests/fixtures/shared-channel-upgrade/
# by the fixture entry, with its own state directory, home and personas
# (`${SCENARIO_TAG}_<letter>_<name>`); restarts reopen that same state.
# The new release reads only the prepared baseline: the preserved 0.18.0
# references stay manual reference, checked first with 0.18.0's own loader
# and parsers (the published tarball in the image, installed as test-40 does).
# Stub workers, shared mode: HOME, agent-director store and tmux stay the
# container's. Exact zero-read proof of the old store, the key-by-location
# refusal matrix, reload-time refusals, dry run and identity rows stay with
# the cited unit suites. Static checks do not establish runtime PASS.
set -euo pipefail
TEST_NAME="test-47-shared-channel-upgrade"
# shellcheck source=lib/scenario.sh
source "$(dirname "$0")/lib/scenario.sh"

FIXTURES="$(realpath "$(dirname "$0")")/fixtures"
PRINTER="${FIXTURES}/fmk-texts.ts"
CASE_ENTRY="${FIXTURES}/shared-channel-upgrade-case.ts"
MANIFEST="$(realpath "$(dirname "$0")/../fixtures/shared-channel-upgrade/manifest.json")"
EARLIER_TGZ="/opt/claude-slack-channel-bots-0.18.0/claude-slack-channel-bots-0.18.0.tgz"
RECORD_WAIT_S=15
EVENT_WAIT_S=30
HOLD_S=7
DELIVERY_IDLE_WAIT_S=180
DELIVERY_MAX_WAIT_S=1800
EVIDENCE="${SCENARIO_ROOT}/evidence"
mkdir -p "${EVIDENCE}"
ACKS="${EVIDENCE}/acks"
NO_ACKS="${EVIDENCE}/no-acks"
: > "${ACKS}"
: > "${NO_ACKS}"
[[ -f "${MANIFEST}" && -f "${CASE_ENTRY}" ]] || fail 'upgrade fixtures or their entry missing'
[[ -f "${EARLIER_TGZ}" ]] || fail '0.18.0 release tarball missing'

printed() { bun "${PRINTER}" "$@" || fail "printer entry $1 failed"; }
HUMAN="$(scenario_id U human)"

# Stub `claude` first on PATH, its MCP session client beside it.
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

# The earlier release, for its own loader and parsers only; it never runs.
EARLIER_INSTALL="${SCENARIO_ROOT}/earlier-install"
mkdir -p "${EARLIER_INSTALL}"
jq -n --arg tgz "file:${EARLIER_TGZ}" '{private:true,dependencies:{"claude-slack-channel-bots":$tgz}}' \
    | write_file "${EARLIER_INSTALL}/package.json"
(cd "${EARLIER_INSTALL}" && bun install --ignore-scripts > "${EVIDENCE}/earlier-install.log" 2>&1) \
    || fail 'cannot install the 0.18.0 package'
EARLIER_PKG="${EARLIER_INSTALL}/node_modules/claude-slack-channel-bots"
earlier_version="$(jq -er .version "${EARLIER_PKG}/package.json")" || fail 'cannot read the installed earlier version'
old_release="$(jq -er .old_release "${MANIFEST}")" || fail 'cannot read the manifest release'
[[ "${earlier_version}" == "${old_release}" ]] || fail 'installed earlier package is not the manifest release'
# 0.18.0's own readers: exit 0 accepted, 3 refused; any other status is a
# broken probe (the modules load outside the refusal branch).
EARLIER_READ='
const [pkg, kind, file, home, config] = process.argv.slice(1)
const fs = await import("node:fs")
const load = await import(pkg + "/src/config.ts"), store = await import(pkg + "/src/channel-delivery.ts")
const queue = await import(pkg + "/src/delivery-queue.ts"), print = await import(pkg + "/src/reload-fingerprint.ts")
let ok = false
try {
  if (kind === "config") { load.loadPersonaConfig(file, home); ok = true }
  else if (kind === "store") ok = store.parseChannelDelivery(fs.readFileSync(file)).ok === true
  else if (kind === "queue") {
    const lines = fs.readFileSync(file, "utf8").split("\n")
    ok = lines.pop() === "" && lines.length > 0 && lines.every(line => queue.parseQueueRecord(line) !== undefined)
  } else if (kind === "pending") {
    const [head, line] = fs.readFileSync(file, "utf8").split("\n")
    ok = head === print.PENDING_FILE_HEADER && line === print.PENDING_FINGERPRINT_PREFIX + print.reloadFingerprint(fs.readFileSync(config), [])
  } else process.exit(64)
} catch { ok = false }
process.exit(ok ? 0 : 3)'

# One Slack stub for the script: one label per case persona.
declare -a LABELS=(d-alpha d-bravo f-alpha f-bravo i-alpha r-alpha z-alpha)
declare -A SUFFIX
seed=()
for label in "${LABELS[@]}"; do
    SUFFIX[${label}]="${SCENARIO_TAG}${label//-/}"
    seed+=("${label}" "${SUFFIX[${label}]}")
done
STUB_CONTROL="${SCENARIO_ROOT}/slack-control.json"
SCENARIO_SLACK_RECORD="${EVIDENCE}/slack.jsonl"
slack_stub_control_seed "${STUB_CONTROL}" "${seed[@]}"
bun "${FIXTURES}/slack-stub-server.ts" --record "${SCENARIO_SLACK_RECORD}" --control "${STUB_CONTROL}" \
    --ready-file "${SCENARIO_ROOT}/slack-ready.json" > "${EVIDENCE}/stub.log" 2>&1 &
STUB_PID=$!
track_pid "${STUB_PID}"
wait_for_file "${SCENARIO_ROOT}/slack-ready.json" 20 'Slack stub readiness'
ready_pid="$(jq -er .pid "${SCENARIO_ROOT}/slack-ready.json")" || fail 'cannot read the stub readiness file'
[[ "${ready_pid}" == "${STUB_PID}" ]] || fail 'wrong stub PID'
STUB_API_URL="$(jq -r .api_url "${SCENARIO_ROOT}/slack-ready.json")"
[[ "${STUB_API_URL}" =~ ^http://127\.0\.0\.1:[0-9]+/api/$ ]] || fail 'non-loopback Slack stub'
SCENARIO_SLACK_STUB_URL="${STUB_API_URL%/api/}"
export CSCB_SLACK_API_URL="${STUB_API_URL}"
slack_stub_controls "${STUB_CONTROL}"

membership_request_ms="$(printed MEMBERSHIP_REQUEST_TIMEOUT_MS)"
membership_attempt_ms="$(printed MEMBERSHIP_ATTEMPT_TIMEOUT_MS)"
membership_retry_ms="$(printed MEMBERSHIP_RETRY_MAX_MS)"
recovery_bound_s="$(( (membership_attempt_ms + membership_retry_ms + 999) / 1000 + 30 ))"
readiness_route="$(printed MEMBERSHIP_READINESS_ROUTE)"
changed_class="$(printed THREAD_MEMORY_CHANGED_WHILE_STOPPED)"
superseded_line="$(printed reviewOutcomeLine superseded)"
seal_name="$(printed THREAD_MEMORY_SEAL_FILE)"

# --- Case preparation -------------------------------------------------------
# Per case: P maps a manifest persona name to its prefixed name (also its
# key); LABEL, WORK, MANUAL and SNAP are keyed by that key.
declare -A P LABEL WORK MANUAL SNAP INVENTORY
declare -a ALL_KEYS=() USED_STATE_DIRS=()
case_json() { jq -cr --arg c "${CASE}" ".cases[]|select(.name==\$c)|$1" "${MANIFEST}"; }
# Every absence, zero count or equality below reads its value into a
# variable first and fails on a reader error (pipefail keeps a failed
# reader's status through `| jq`), so a broken reader never looks empty.
# rows_of <filter>: ROWS holds this case's manifest rows, read first.
rows_of() {
    local listing
    listing="$(case_json "$1")" || fail "${CASE}: cannot read the manifest"
    ROWS=()
    [[ -z "${listing}" ]] || mapfile -t ROWS <<< "${listing}"
}
no_session() {
    local name
    name="$(printed personaTmuxSessionName "$1")" && [[ -n "${name}" ]] || fail "cannot name $1's session"
    ! tmux has-session -t "=${name}" > /dev/null 2>&1
}
# The old service and its bots are stopped: no server process in any state
# directory this script used, and no tmux session for any persona so far.
assert_stopped() {
    local dir key pid
    for dir in ${USED_STATE_DIRS[@]+"${USED_STATE_DIRS[@]}"}; do
        pid="$(SLACK_STATE_DIR="${dir}" server_pid)" || fail "$1: cannot read a server PID"
        [[ -z "${pid}" ]] || ! pid_alive "${pid}" || fail "$1: a server is still running before preparation"
    done
    for key in ${ALL_KEYS[@]+"${ALL_KEYS[@]}"}; do
        wait_until 30 "$1: a bot session is still running before preparation" no_session "${key}"
    done
}
# prepare_case <case> <letter> <dir>: materialize into a fresh state dir and
# home, write each credentials file with a fake token, check every 0.18.0
# reference with 0.18.0's own code and record the references' bytes and dates.
prepare_case() {
    local kind first rest out key want
    CASE="$1"; LETTER="$2"
    assert_stopped "${CASE}"
    CASE_DIR="${SCENARIO_ROOT}/$3"
    mkdir -p "${CASE_DIR}/state"
    export SLACK_STATE_DIR="${CASE_DIR}/state"
    USED_STATE_DIRS+=("${SLACK_STATE_DIR}")
    CONFIG="${SLACK_STATE_DIR}/config.json"
    LAST="${CONFIG}.last-applied"
    LOG="${SLACK_STATE_DIR}/server.log"
    CASE_HOME="${CASE_DIR}/home"
    out="${EVIDENCE}/$3-materialize.out"
    bun --no-install "${CASE_ENTRY}" materialize --case "${CASE}" --root "${CASE_DIR}" \
        --state-dir "${SLACK_STATE_DIR}" --home "${CASE_HOME}" --persona-prefix "${SCENARIO_TAG}_${LETTER}_" \
        --setting bind=127.0.0.1 --setting "port=${SCENARIO_PORT}" --setting health_check_interval=0 \
        --setting session_restart_delay=0 --setting exit_timeout=5 --setting "mcp_config_path=${MCP_CONFIG}" \
        > "${out}" || fail "${CASE}: materialize refused"
    P=(); REFERENCE_DIR=''
    while read -r kind first rest; do
        case "${kind}" in
            reference_dir) REFERENCE_DIR="${first}" ;;
            baselines_dir) BASELINES_DIR="${first}" ;;
            pending_dir) PENDING_DIR="${first}" ;;
            persona)
                P[${first}]="${rest}"
                LABEL[${rest}]="${LETTER}-${first}"
                MANUAL[${rest}]=false
                SNAP[${rest}]="${EVIDENCE}/${rest}-queue.jsonl"
                ALL_KEYS+=("${rest}")
                key="$(persona_key "${rest}")" || fail 'cannot key a prefixed name'
                [[ -n "${rest}" && "${key}" == "${rest}" ]] || fail 'prefixed name is not its own key'
                ;;
            workdir) WORK[${first}]="${rest}" ;;
            credentials)
                jq -n --arg b "$(fake_token bot "${SUFFIX[${LABEL[${first}]}]}")" --arg a "$(fake_token app "${SUFFIX[${LABEL[${first}]}]}")" \
                    '{bot_token:$b,app_token:$a}' | write_file "${rest}" 600
                ;;
        esac
    done < "${out}"
    want="$(case_json '.personas|length')" || fail "${CASE}: cannot read the manifest"
    [[ "${want}" == "${#P[@]}" ]] || fail "${CASE}: persona lines differ from manifest"
    check_references
    reference_digest > "${EVIDENCE}/${CASE}-references" || fail "${CASE}: cannot digest the references"
}
# Each manifest reference: valid ones load or parse in 0.18.0, damaged ones
# are refused by 0.18.0, and the reference directory holds nothing else.
check_references() {
    local path condition file kind rc count=0 found row
    rows_of '.files[]|.condition as $c|.targets[]|select(.to=="reference")|[.path,$c]|@tsv'
    for row in ${ROWS[@]+"${ROWS[@]}"}; do
        IFS=$'\t' read -r path condition <<< "${row}"
        if [[ "${path}" =~ ^queue/([a-z0-9_]+)\.jsonl$ ]]; then path="queue/${P[${BASH_REMATCH[1]}]}.jsonl"; fi
        file="${REFERENCE_DIR}/${path}"
        case "${path}" in
            *channel-delivery*) kind=store ;;
            queue/*) kind=queue ;;
            *.pending) kind=pending ;;
            *) kind=config ;;
        esac
        rc=0; bun -e "${EARLIER_READ}" "${EARLIER_PKG}" "${kind}" "${file}" "${CASE_HOME}" "${REFERENCE_DIR}/config.json" || rc=$?
        if [[ "${condition}" == valid ]]; then
            (( rc == 0 )) || fail "${CASE}: 0.18.0 does not accept reference ${path}"
        else
            (( rc == 3 )) || fail "${CASE}: 0.18.0 does not refuse ${condition} reference ${path}"
        fi
        printf '%s\t%s\t%s\n' "${CASE}" "${path}" "${condition}" >> "${EVIDENCE}/references-checked"
        count=$((count + 1))
    done
    if [[ -n "${REFERENCE_DIR}" && -d "${REFERENCE_DIR}" ]]; then
        found="$(find "${REFERENCE_DIR}" -type f | wc -l)" || fail "${CASE}: cannot list the reference dir"
        [[ "${found}" == "${count}" ]] || fail "${CASE}: reference dir differs from manifest"
    else
        (( count == 0 )) || fail "${CASE}: manifest references missing"
    fi
}
# Bytes, mode and date of every preserved reference, the old state files and
# the preserved pending edits (an unreadable file keeps its mode and date).
reference_digest() {
    python3 - "${REFERENCE_DIR:-}" "${PENDING_DIR:-}" "${SLACK_STATE_DIR}/channel-delivery.json" <<'PY'
import hashlib, os, sys
paths = []
for root in sys.argv[1:3]:
    if root and os.path.isdir(root):
        for base, _, names in os.walk(root):
            paths += [os.path.join(base, name) for name in names]
if os.path.lexists(sys.argv[3]): paths.append(sys.argv[3])
for path in sorted(paths):
    st = os.lstat(path)
    try: digest = hashlib.sha256(open(path, 'rb').read()).hexdigest()
    except PermissionError: digest = 'unreadable'
    print(f'{path}\t{st.st_mode:o}\t{st.st_mtime_ns}\t{st.st_size}\t{digest}')
PY
}
references_unchanged() {
    reference_digest > "${EVIDENCE}/${CASE}-references.now" || fail "$1: cannot digest the references"
    cmp -s "${EVIDENCE}/${CASE}-references" "${EVIDENCE}/${CASE}-references.now" || fail "$1: a preserved reference changed"
}
# Every state file but the server's logs, for refused starts.
state_digest() {
    python3 - "${SLACK_STATE_DIR}" <<'PY'
import hashlib, os, re, sys
root = sys.argv[1]
for base, _, names in sorted(os.walk(root)):
    for name in sorted(names):
        path = os.path.join(base, name); rel = os.path.relpath(path, root)
        if re.fullmatch(r'(server\.log|startup-errors\.log).*', rel): continue
        st = os.lstat(path)
        try: digest = hashlib.sha256(open(path, 'rb').read()).hexdigest()
        except PermissionError: digest = 'unreadable'
        print(f'{rel}\t{st.st_mode:o}\t{st.st_mtime_ns}\t{digest}')
PY
}
# switch_baseline <variant>: the operator's next preparation, as the fixture
# entry says: the variant's files, keeping their applied dates.
switch_baseline() {
    assert_stopped "$1"
    cp -p "${BASELINES_DIR}/$1/config.json" "${CONFIG}"
    if [[ -f "${BASELINES_DIR}/$1/config.json.last-applied" ]]; then
        cp -p "${BASELINES_DIR}/$1/config.json.last-applied" "${LAST}"
    else rm -f -- "${LAST}"; fi
}

# --- Shared observations ----------------------------------------------------
record_after() {
    local mark="$1" event="$2"; shift 2
    slack_stub_records "${event}" "$@" | jq -sc --argjson mark "${mark}" '[.[]|select(.seq>$mark)]'
}
has_record_after() { [[ "$(record_after "$@" | jq length)" -gt 0 ]]; }
# none_after <failure> <mark> <event> [field=value...]: no such record.
none_after() {
    local step="$1" n; shift
    n="$(record_after "$@" | jq length)" || fail "${step}: cannot read the Slack stub record"
    [[ "${n}" == 0 ]] || fail "${step}"
}
ack() { slack_wait_one_ack "$1"; printf '%s\n' "$1" >> "${ACKS}"; }
no_ack() { slack_expect_no_ack "$1" "${2:-1}"; printf '%s\n' "$1" >> "${NO_ACKS}"; }
push() {
    local key="$1" channel="$2" ts="$3" text="$4" root="${5:--}"
    if [[ "${root}" == - ]]; then slack_push_message "${LABEL[${key}]}" "${channel}" "${text}" "${ts}" "${HUMAN}"
    else slack_push_reply "${LABEL[${key}]}" "${channel}" "${root}" "${text}" "${ts}" "${HUMAN}"; fi
}
mention() { scenario_mention_text "$(slack_stub_identity "${LABEL[$1]}" user_id)" "$(scenario_text "$2")"; }
# read_queued <key> <channel> <ts> [via]: QUEUED is the accepted count.
read_queued() {
    QUEUED="$(shared_queued_count "$@")" || fail "cannot read $1's queue"
    [[ "${QUEUED}" =~ ^[0-9]+$ ]] || fail "unreadable queue count for $1"
}
queued() { read_queued "$1" "$2" "$3" "$4"; [[ "${QUEUED}" == 1 ]]; }
snapshot() {
    if [[ -f "${SNAP[$1]}" ]]; then shared_queue_snapshot "${SNAP[$1]}" "$1" "${SNAP[$1]}"
    else shared_queue_snapshot "${SNAP[$1]}" "$1"; fi
}
drain() {
    snapshot "$1"
    shared_wait_queue_drained "$1" "${SNAP[$1]}" "${SNAP[$1]}" > /dev/null
    snapshot "$1"
}
receipt() {
    if [[ "${MANUAL[$1]}" == true ]]; then shared_stub_permission receipt "${WORK[$1]}" "$1" > /dev/null; fi
    drain "$1"
}
# selected <key> <channel> <via> <text> [root]: one acceptance with that via.
selected() {
    local ts env; ts="$(scenario_ts)"
    env="$(push "$1" "$2" "${ts}" "$4" "${5:--}")"
    ack "${env}"
    wait_until "${EVENT_WAIT_S}" "$2 did not select as $3" queued "$1" "$2" "${ts}" "$3"
    receipt "$1"
    LAST_TS="${ts}"
}
# not_selected <key> <channel> <text> [root]: acknowledged, never accepted.
not_selected() {
    local ts env; ts="$(scenario_ts)"
    env="$(push "$1" "$2" "${ts}" "$3" "${4:--}")"
    ack "${env}"
    read_queued "$1" "$2" "${ts}"
    [[ "${QUEUED}" == 0 ]] || fail "$2 selected input it must drop"
    LAST_TS="${ts}"
}
choice_is() {
    local saved
    saved="$(shared_channel_saved "$1" "$2")" || fail "cannot read the saved choice of $1 in $2"
    [[ "${saved}" == "$3" ]]
}
facts() { shared_persona_facts "$1" | jq -cS '.assignments'; }
# same_facts <key> <before> <failure> [channel]: the key's assignments, read
# first (without <channel>), are exactly <before>.
same_facts() {
    local now
    now="$(facts "$1" | jq -cS --arg drop "${4:-}" 'if $drop == "" then . else del(.[$drop]) end')" \
        || fail "$3: cannot read $1's choices"
    [[ -n "${now}" && "${now}" == "$2" ]] || fail "$3"
}
stamp() { printed sharedThreadStamp "${CONFIG}" "${LAST}" "$1" "$2"; }
root_saved() { shared_thread_joins "$1" "$2" "$(stamp "$1" "$2")" | jq -se --arg r "$3" '[.[]|select(.root==$r)]|length==1' > /dev/null; }
set_choice() {
    expect_attempt "$4" "${WORK[$1]}" "$(attempt_args "$(scenario_attempt_id "$4")" "$2" "$3")" "$1" "$3"
}
bot_refused() {
    local before after result
    before="$(shared_attempt_applications "$1" "$2")" || fail "$3: cannot read applied attempts"
    result="$(scenario_attempt_call "${WORK[$1]}" "$(attempt_args "$(scenario_attempt_id "$3")" "$2" all)")"
    jq -e '.isError==true and (has("error")|not)' <<< "${result}" > /dev/null || fail "$3: unauthorized bot write was not refused"
    after="$(shared_attempt_applications "$1" "$2")" || fail "$3: cannot read applied attempts"
    [[ -n "${before}" && "${after}" == "${before}" ]] || fail "$3: refused bot write was applied"
}
mode_is() {
    local mode
    mode="$(shared_persona_facts "$1" | jq -r .mode)" || fail "cannot read $1's mode"
    [[ "${mode}" == "$2" ]]
}
memory_created() {
    local created
    created="$(shared_persona_facts "$1" | jq -r .threadMemoryCreated)" || fail "cannot read $1's Thread Memory marker"
    [[ "${created}" == true ]]
}
start() {
    local key
    start_server --live
    for key in "$@"; do wait_membership_complete "${key}"; done
}
inventory() {
    local key="$1"; shift
    INVENTORY[${key}]="$*"
    slack_stub_inventory_clear "${LABEL[${key}]}"
    slack_stub_inventory_page "${LABEL[${key}]}" '' '' "$@"
}
in_inventory() { [[ " ${INVENTORY[$1]} " == *" $2 "* || " ${INVENTORY[$1]} " == *" $2/"* ]]; }
# Each manifest choice selects as written; a retired choice is only what
# membership catch-up gives it (the mode's default, or nothing when absent).
check_chosen_choices() {
    local persona channel action delivery key default="$1" count=0 row
    rows_of '.channels[]|[.persona,.channel,.choice.action,(.choice.delivery//"")]|@tsv'
    for row in ${ROWS[@]+"${ROWS[@]}"}; do
        IFS=$'\t' read -r persona channel action delivery <<< "${row}"
        key="${P[${persona}]}"
        if [[ "${action}" == retire ]]; then
            if in_inventory "${key}" "${channel}"; then delivery="${default}"; else delivery=''; fi
        fi
        choice_is "${key}" "${channel}" "${delivery}" || fail "${CASE}: ${persona}/${channel} is not the chosen ${action}"
        count=$((count + 1))
    done
    [[ "${count}" == "$(case_json '.channels|length')" ]] || fail "${CASE}: not every manifest choice was checked"
}
# One shared list per persona: the prepared channels plus current memberships.
one_list() {
    local key="$1" entry prepared expected actual
    prepared="$(jq -r --arg n "${key}" '[.personas[]|select(.name==$n)] |
        if length==1 then (.[0].channels // [])[].id else error("persona not configured once") end' "${CONFIG}")" \
        || fail "${CASE}: cannot read ${key}'s prepared channels"
    expected="$( { [[ -z "${prepared}" ]] || printf '%s\n' "${prepared}"
        for entry in ${INVENTORY[${key}]}; do printf '%s\n' "${entry%%/*}"; done; } | LC_ALL=C sort -u | jq -Rsc 'split("\n")|map(select(length>0))')" \
        || fail "${CASE}: cannot list ${key}'s expected channels"
    actual="$(facts "${key}" | jq -c 'keys')" || fail "${CASE}: cannot read ${key}'s choices"
    [[ "${actual}" == "${expected}" ]] || fail "${CASE}: ${key} has not exactly one list of prepared and current channels"
}
# config.json is the authority's reviewed input, and each persona's one
# destination in it is the one the operator chose. A `dm` destination is
# checked here only: the stub records neither conversations.open's contact
# nor the D… ID it returns, so a DM post can't be tied to it (trace limit;
# tests/permission-poller.test.ts "poller tick — `dm` destination" proves it).
check_destinations() {
    local persona chosen configured count=0 want row
    configuration_record_matches "${CONFIG}" "${LAST}" reviewed > /dev/null || fail "$1: reviewed input differs from config.json"
    want="$(case_json '.destinations|length')" || fail "$1: cannot read the manifest"
    rows_of '.destinations[]|[.persona,.chosen]|@tsv'
    for row in ${ROWS[@]+"${ROWS[@]}"}; do
        IFS=$'\t' read -r persona chosen <<< "${row}"
        configured="$(jq -r --arg n "${P[${persona}]}" '.personas[]|select(.name==$n)|.permission_prompts' "${CONFIG}")" \
            || fail "$1: cannot read ${persona}'s destination"
        [[ -n "${chosen}" && "${configured}" == "${chosen}" ]] || fail "$1: ${persona} lost its one chosen destination"
        count=$((count + 1))
    done
    [[ "${count}" == "${want}" ]] || fail "$1: not every manifest destination was checked"
}
no_changed_report() {
    local key="$1" mark="$2" form notice ref
    # count_log reads a missing log as 0: the started server's log must exist.
    [[ -f "${LOG}" ]] || fail "$3: server.log missing"
    expect_count "$(matcher "${changed_class}" "${key}")" 0 "$3: Thread Memory reported as changed while stopped"
    ref="$(persona_ref "${key}")" || fail "$3: cannot name ${key}"
    for form in unclean changed; do
        notice="$(printed formatPersonaNotice "${key}" buildThreadMemoryChangedWhileStoppedNotice "${ref}" "$4" "${form}")" \
            || fail "$3: cannot print the changed-while-stopped notice"
        [[ -n "${notice}" ]] || fail "$3: empty changed-while-stopped notice"
        none_after "$3: changed-while-stopped notice posted" "${mark}" api method=chat.postMessage "text=${notice}"
    done
}
# review <id>: the operator requests a preview of config.json as it is now,
# keeps it, confirms it, and the exact review is durably consumed.
review() {
    configuration_request "$1" request > /dev/null
    check_pending_layout "$1"
    cp "${CONFIG}.pending" "${EVIDENCE}/${CASE}-$1.pending"
    mv "${CONFIG}.pending" "${CONFIG}.apply"
    wait_until 60 "$1: review not durably consumed" bun "${PRINTER}" sharedReviewConsumed \
        "${CONFIG}" "${LAST}" "${EVIDENCE}/${CASE}-$1.pending" > /dev/null
}
request_assignment() {
    local id="$1"; shift
    configuration_request "${id}" request "$@" > /dev/null
    cp "${CONFIG}.pending" "${EVIDENCE}/${CASE}-${id}.pending"
    mv "${CONFIG}.pending" "${CONFIG}.apply"
    wait_until 60 "${id}: assignment not durably consumed" bun "${PRINTER}" sharedReviewConsumed \
        "${CONFIG}" "${LAST}" "${EVIDENCE}/${CASE}-${id}.pending" > /dev/null
}
set_input_mode() {
    jq --arg mode "$1" '.channel_mode=$mode' "${CONFIG}" > "${CONFIG}.candidate"
    mv "${CONFIG}.candidate" "${CONFIG}"
}
pending_gone() { [[ ! -e "${CONFIG}.pending" ]]; }
permission_allowed() {
    shared_stub_permission outcome "${WORK[$1]}" "$1" "$2" | jq -e '.decision=="allow" and .delivery=="delivered"' > /dev/null
}
# prompt <key> <1|2> <destination>: the registered hook's prompt posts to the
# one destination and its Allow response reaches the hook. The allowed turn
# then ends through the registered Stop hook, and AD reads waiting before any
# later delivery to that worker.
prompt() {
    local key="$1" mark request token post ts
    mark="$(slack_post_mark)"
    request="$(shared_stub_permission "permission-$2" "${WORK[${key}]}" "${key}")"
    token="$(jq -er .request_token <<< "${request}")"
    # Bash is the registered fixture request's tool, not a copied prompt text.
    post="$(slack_wait_successful_post "${LABEL[${key}]}" "$3" "${mark}" Bash)"
    printf '%s\n' "${post}" > "${EVIDENCE}/${key}-prompt-$2.json"
    ts="$(jq -er .ts <<< "${post}")"
    [[ -n "$(slack_recorded_button "${LABEL[${key}]}" "$3" "${ts}" perm_allow_)" ]] || fail 'prompt has no Allow button'
    ack "$(slack_push_button "${LABEL[${key}]}" "$3" "${ts}" perm_allow_ "${HUMAN}")"
    wait_until "${EVENT_WAIT_S}" 'prompt response not delivered to the registered hook' permission_allowed "${key}" "${token}"
    shared_stub_permission "complete-$2" "${WORK[${key}]}" "${key}" "${token}" > /dev/null
}
# messages_waiting <key> <channel-with-all> <destination>: an ended worker's
# queued work posts the production notice to the one destination.
messages_waiting() {
    local key="$1" mark ts text evidence="${EVIDENCE}/${1}-notice-end.json"
    drain "${key}"
    shared_stub_notice end "${WORK[${key}]}" "${key}" "${evidence}" > /dev/null
    mark="$(slack_post_mark)"
    ts="$(scenario_ts)"; text="$(scenario_text "${key}-while-ended")"
    ack "$(push "${key}" "$2" "${ts}" "${text}")"
    wait_until "${EVENT_WAIT_S}" 'queued work while ended not accepted' queued "${key}" "$2" "${ts}" ''
    slack_wait_messages_waiting "${LABEL[${key}]}" "$3" "${mark}" "${key}" "${key}" 1 > "${EVIDENCE}/${key}-messages-waiting.json"
    shared_stub_notice resume "${WORK[${key}]}" "${key}" "${evidence}" > /dev/null
    MANUAL[${key}]=false
    drain "${key}"
}
# old_queue_delivered <key> <reference-journal>: every item 0.18.0 left open
# is delivered in acceptance order, with its original record (text, via,
# queued emoji, reminder link), its fixed content and its queued emoji removed.
old_queue_delivered() {
    local key="$1" ref="$2" seq source channel ts text user via emoji parts listing rows=() row
    drain "${key}"
    jq -se --slurpfile ref "${ref}" '
      def facts: {seq,source,sender,text,channel,channel_type,user,key,ts,via,queued_ack_reaction,reminder_for};
      . as $rows |
      ([$ref[]|select(.kind=="accepted")|.seq] - [$ref[]|select(.kind=="delivered")|.seq]|sort) as $open |
      ($open|length)>0 and
      ([$rows[]|select(.kind=="accepted" and (has("compact")|not) and (.seq as $s|$open|index($s)!=null))|facts]|sort_by(.seq)) ==
        ([$ref[]|select(.kind=="accepted" and (.seq as $s|$open|index($s)!=null))|facts]|sort_by(.seq)) and
      all($open[]; . as $s|any($rows[]; .kind=="delivered" and .seq==$s)) and
      all(range(1; $open|length); . as $i |
        ([$rows[]|select(.kind=="delivered" and .seq==$open[$i-1])|.at]|max) <=
        ([$rows[]|select(.kind=="sent" and .seq==$open[$i])|.at]|min))
    ' "${SNAP[${key}]}" > /dev/null || fail "${CASE}: 0.18.0 queue not delivered intact and in order"
    listing="$(jq -sr '[.[]|select(.kind=="delivered")|.seq] as $done | .[] |
        select(.kind=="accepted" and (.seq as $s|$done|index($s)==null)) |
        [.seq,.source,(.channel//"-"),.ts,(.user//"-"),(.via//"-"),(.queued_ack_reaction//"-")]|@tsv' "${ref}")" \
        || fail "${CASE}: cannot read the 0.18.0 queue reference"
    [[ -z "${listing}" ]] || mapfile -t rows <<< "${listing}"
    (( ${#rows[@]} > 0 )) || fail "${CASE}: the 0.18.0 queue reference has no open item"
    for row in "${rows[@]}"; do
        IFS=$'\t' read -r seq source channel ts user via emoji <<< "${row}"
        [[ "${source}" == slack ]] || continue
        text="$(jq -r --argjson s "${seq}" 'select(.kind=="accepted" and .seq==$s)|.text' "${ref}")"
        parts="$(shared_expected_parts "${text}" "${ts}" "${user}" "$(scenario_stub_name user "${user}")" \
            "${channel}" "$(scenario_stub_name channel "${channel}")" "${via}" - -)"
        shared_assert_content "${key}" "${LOG}" "${SNAP[${key}]}" "${channel}" "${ts}" "${text}" "${parts}" - \
            >> "${EVIDENCE}/${key}-old-content.jsonl"
        wait_until "${RECORD_WAIT_S}" "queued emoji of item ${seq} not removed" has_record_after 0 api \
            "label=${LABEL[${key}]}" method=reactions.remove "channel=${channel}" "timestamp=${ts}" "name=${emoji}"
    done
}
# refused_start <variant>: the prepared input is refused with the printer's
# exact line, which carries every name the manifest expects and, for a
# removed key, the loader's sentence naming its replacement. Nothing
# launches, no Slack connection opens and no state file changes.
# With KEYS_ONLY=true (case R, whose variants name only configuration keys)
# the manifest's two-name variants (a removed key, then its replacement)
# must print that sentence, and a one-name variant names a current setting,
# which the printer refuses as usage (64); any other status fails.
REMOVED_SEEN=0
KEYS_ONLY=false
refused_start() {
    local variant="$1" source expected name names=() count sentence rc mark before
    source="$(case_json ".baselines[]|select(.name==\"${variant}\")|.expect.fails_in")" || fail "${variant}: cannot read the manifest"
    case "${source}" in config.json) source=config ;; config.json.last-applied) source=record ;; *) fail "${variant}: no refusal expected" ;; esac
    expected="$(printed reloadStartRefusalLine "${source}" "${CONFIG}")" || fail "${variant}: cannot print the refusal"
    [[ -n "${expected}" ]] || fail "${variant}: empty refusal line"
    printf '%s\t%s\n' "${variant}" "${expected}" >> "${EVIDENCE}/refusals"
    rows_of ".baselines[]|select(.name==\"${variant}\")|.expect.names[]"
    names=(${ROWS[@]+"${ROWS[@]}"})
    (( ${#names[@]} > 0 )) || fail "${variant}: the manifest names nothing"
    for name in "${names[@]}"; do
        [[ -n "${name}" && "${expected}" == *"${name}"* ]] || fail "${variant}: refusal does not name ${name}"
    done
    name="${names[0]}"; count="${#names[@]}"
    rc=0; sentence="$(bun "${PRINTER}" removedKeyRefusal "${name}" 2> /dev/null)" || rc=$?
    if [[ "${KEYS_ONLY}" == true ]]; then
        if (( count == 2 )); then
            (( rc == 0 )) || fail "${variant}: no removed-key sentence for ${name}, exit ${rc}"
        else
            (( count == 1 && rc == 64 )) || fail "${variant}: ${name} is neither removed nor current, exit ${rc}"
        fi
    else
        (( rc == 0 || rc == 64 || rc == 1 )) || fail "${variant}: removed-key printer failed"
    fi
    if (( rc == 0 )); then
        [[ -n "${sentence}" && "${expected}" == *"${sentence}"* ]] || fail "${variant}: removed-key refusal does not name the replacement"
        REMOVED_SEEN=$((REMOVED_SEEN + 1))
    fi
    state_digest > "${EVIDENCE}/${variant}.before" || fail "${variant}: cannot digest the state"
    mark="$(slack_post_mark)"
    before="$(count_log "${expected}")" || fail "${variant}: cannot read server.log"
    run_start --live
    [[ "${START_RC}" -ne 0 ]] || fail "${variant}: refused preparation started"
    ! _scenario_pid_file_live || fail "${variant}: refused start left a daemon"
    (( $(count_in "${START_OUT}" "${expected}") >= 1 )) || fail "${variant}: start output lacks the exact refusal"
    expect_count "${expected}" "$((before + 1))" "${variant}: server.log lacks the exact refusal once"
    none_after "${variant}: refused start opened Slack" "${mark}" api method=apps.connections.open
    for name in "${P[@]}"; do no_session "${name}" || fail "${variant}: refused start launched a bot"; done
    state_digest > "${EVIDENCE}/${variant}.after" || fail "${variant}: cannot digest the state"
    cmp -s "${EVIDENCE}/${variant}.before" "${EVIDENCE}/${variant}.after" || fail "${variant}: refused start changed state"
    references_unchanged "${variant}"
}
# refuse_all: every refused variant, in manifest order, from the default.
refuse_all() {
    local variant default count=0 want variants
    default="$(case_json '.baselines[]|select(.default)|.name')" || fail "${CASE}: cannot read the manifest"
    [[ -n "${default}" ]] || fail "${CASE}: no default variant"
    want="$(case_json '[.baselines[]|select(.expect.loads==false)]|length')" || fail "${CASE}: cannot read the manifest"
    rows_of '.baselines[]|select(.expect.loads==false)|.name'
    variants=(${ROWS[@]+"${ROWS[@]}"})
    for variant in ${variants[@]+"${variants[@]}"}; do
        [[ "${variant}" == "${default}" ]] || switch_baseline "${variant}"
        refused_start "${variant}"
        "$@"
        count=$((count + 1))
    done
    [[ "${count}" == "${want}" ]] || fail "${CASE}: not every refused variant was started"
}

# ===========================================================================
# Case D: 0.18.0 declarative to strict (AC-U01, U02, U03, U06, U07, U08,
# U09, U11). alpha holds 0.18.0's queue; bravo has the conflicts, the new
# thread_hybrid, an explicit off and the prompt/notice destination.
# ===========================================================================
prepare_case declarative-choices-and-queues d case-d
DA="${P[alpha]}"; DB="${P[bravo]}"
CATCHUP="$(scenario_id C caught-up)"
STOPPED_JOIN="$(scenario_id C joined-while-stopped)"
added="$(jq -r --arg a "${DA}" --slurpfile base "${BASELINES_DIR}/prepared/config.json" '
  ($base[0].personas[]|select(.name==$a)|[.channels[].id]) as $old |
  [.personas[]|select(.name==$a)|.channels[]|select(.id as $id|$old|index($id)|not)] |
  if length==1 then [.[0].id,.[0].delivery]|@tsv else error("expected one added channel") end' "${PENDING_DIR}/channel-edit/config.json")" \
    || fail 'cannot read the restored channel edit'
IFS=$'\t' read -r ADDED ADDED_VALUE <<< "${added}"
RETIRED="$(case_json '.channels[]|select(.choice.action=="retire")|.channel')"
OFF_CHANNEL="$(case_json '.channels[]|select(.persona=="bravo" and .choice.delivery=="off")|.channel')"
HYBRID="$(case_json '.channels[]|select(.persona=="bravo" and .choice.delivery=="thread_hybrid")|.channel')"
DEST_B="$(case_json '.destinations[]|select(.persona=="bravo")|.chosen')"
DEST_A="$(case_json '.destinations[]|select(.persona=="alpha")|.chosen')"
for value in "${ADDED}" "${ADDED_VALUE}" "${RETIRED}" "${OFF_CHANNEL}" "${HYBRID}" "${DEST_B}" "${DEST_A}"; do
    [[ -n "${value}" && "${value}" != *$'\n'* ]] || fail 'D manifest value missing or not unique'
done
# 0.18.0 has no Thread Memory: the prepared state has no journal or seal.
[[ ! -e "${SLACK_STATE_DIR}/threads" && ! -e "${SLACK_STATE_DIR}/${seal_name}" ]] || fail 'prepared state carries Thread Memory'
inventory "${DA}" C0TEST001 C0TEST002 G0TEST003/private C0UPGCONFA "${RETIRED}" "${ADDED}" "${CATCHUP}"
inventory "${DB}" C0UPGCONFB C0TEST001 C0TEST002 "${OFF_CHANNEL}"
for key in "${DA}" "${DB}"; do
    chosen="$(jq -r --arg n "${key}" '.personas[]|select(.name==$n)|.channels[].id' "${CONFIG}")" || fail 'cannot read D chosen channels'
    [[ -n "${chosen}" ]] || fail 'D persona has no chosen channel'
    for channel in ${chosen}; do
        in_inventory "${key}" "${channel}" || fail 'D inventory misses a chosen channel'
    done
done
shared_stub_permission_setup "${WORK[${DB}]}" > /dev/null
MANUAL[${DB}]=true
start_mark="$(slack_post_mark)"
start "${DA}" "${DB}"
check_chosen_choices off
for key in "${DA}" "${DB}"; do one_list "${key}"; done
choice_is "${DA}" "${CATCHUP}" off || fail 'strict catch-up of a membership absent from both old sources is not off'
for key in "${DA}" "${DB}"; do mode_is "${key}" strict || fail 'D did not start strict'; done
check_destinations d-first-start
references_unchanged d-first-start
# Newly chosen thread_hybrid starts with no Joined Threads: its Thread Memory
# is created at activation (journal header, then the created marker) and
# holds no join under the channel's stamp.
wait_until "${RECORD_WAIT_S}" 'Thread Memory not created for the newly chosen thread_hybrid' memory_created "${DB}"
hybrid_stamp="$(stamp "${DB}" "${HYBRID}")" || fail 'cannot read the new thread_hybrid stamp'
joins="$(shared_thread_joins "${DB}" "${HYBRID}" "${hybrid_stamp}")" || fail 'cannot read the new Thread Memory'
[[ -z "${joins}" ]] || fail 'upgrade carried Joined Threads'

# One destination, strict, a transferred all: the prompt posts there.
prompt "${DB}" 1 "${DEST_B}"
# Selections as written. bravo's transferred all also selects in alpha's
# destination, where alpha's prompts and notices post.
shared_ts="$(scenario_ts)"; shared_text="$(scenario_text shared-destination)"
for key in "${DA}" "${DB}"; do
    ack "$(push "${key}" "${DEST_A}" "${shared_ts}" "${shared_text}")"
    wait_until "${EVENT_WAIT_S}" 'transferred all did not select in another persona destination' queued "${key}" "${DEST_A}" "${shared_ts}" receive_all_shared
    receipt "${key}"
done
not_selected "${DA}" C0TEST002 "$(scenario_text alpha-config-only-plain)"
selected "${DA}" C0TEST002 mention "$(mention "${DA}" alpha-config-only-mention)"
selected "${DA}" G0TEST003 receive_all "$(scenario_text alpha-store-only)"
selected "${DA}" C0UPGCONFA receive_all "$(scenario_text alpha-chosen-older-store)"
selected "${DB}" C0UPGCONFB receive_all "$(scenario_text bravo-chosen-older-config)"
not_selected "${DA}" "${RETIRED}" "$(mention "${DA}" retired)"
not_selected "${DA}" "${CATCHUP}" "$(mention "${DA}" caught-up-off)"
not_selected "${DB}" "${OFF_CHANNEL}" "$(mention "${DB}" explicit-off)"
old_root="$(scenario_ts)"
not_selected "${DB}" "${HYBRID}" "$(scenario_text reply-under-old-root)" "${old_root}"
selected "${DB}" "${HYBRID}" mention "$(mention "${DB}" new-hybrid-root)"
hybrid_root="${LAST_TS}"
wait_until "${EVENT_WAIT_S}" 'new mention did not join its thread' root_saved "${DB}" "${HYBRID}" "${hybrid_root}"
selected "${DB}" "${HYBRID}" thread "$(scenario_text reply-in-new-thread)" "${hybrid_root}"
no_changed_report "${DB}" "${start_mark}" d-first-start "${HYBRID}"
# 0.18.0's open items reach the worker with their original facts.
old_queue_delivered "${DA}" "${REFERENCE_DIR}/queue/${DA}.jsonl"

# Pending edits kept separately (AC-U07, U08): each put back as the operator
# would gets an ordinary preview and applies only on confirmation.
# The other edits are withdrawn unconfirmed; the mode edit, last, is confirmed.
mode_edits="$(case_json '[.pending_edits[]|select(.changes==["channel_mode"])]|length')" || fail 'cannot read the manifest'
[[ "${mode_edits}" == 1 ]] || fail 'expected one mode edit'
before_a="$(facts "${DA}")" || fail 'cannot read alpha choices'
before_b="$(facts "${DB}")" || fail 'cannot read bravo choices'
rows_of '.pending_edits|sort_by(.changes==["channel_mode"])[]|[.name,(.changes==["channel_mode"])]|@tsv'
edits=(${ROWS[@]+"${ROWS[@]}"})
[[ "${#edits[@]}" == "$(case_json '.pending_edits|length')" ]] || fail 'pending edits not listed'
for row in "${edits[@]}"; do
    IFS=$'\t' read -r edit confirm <<< "${row}"
    cp "${PENDING_DIR}/${edit}/config.json" "${CONFIG}"
    configuration_request "put-back-${edit}" request > /dev/null
    check_pending_layout "put-back-${edit}"
    cp "${CONFIG}.pending" "${EVIDENCE}/d-${edit}.pending"
    hold_not_applied "${HOLD_S}" "put-back-${edit}"
    if [[ "${confirm}" == true ]]; then
        mv "${CONFIG}.pending" "${CONFIG}.apply"
        wait_until 60 'mode edit not durably consumed' bun "${PRINTER}" sharedReviewConsumed \
            "${CONFIG}" "${LAST}" "${EVIDENCE}/d-${edit}.pending" > /dev/null
    else
        cp -p "${BASELINES_DIR}/prepared/config.json" "${CONFIG}"
        configuration_request "put-back-${edit}-cancel" cancel > /dev/null
        wait_until 30 "${edit}: withdrawn edit left a preview" pending_gone
        mode_is "${DA}" strict || fail "${edit}: unconfirmed edit applied"
    fi
    same_facts "${DA}" "${before_a}" "${edit}: put-back changed a choice"
    same_facts "${DB}" "${before_b}" "${edit}: put-back changed a choice"
done
for key in "${DA}" "${DB}"; do mode_is "${key}" open || fail 'confirmed mode edit not applied'; done
references_unchanged d-pending-edits

# Open after the strict baseline (AC-U11): operator and bot assignments.
# An off destination still posts prompts and notices (AC-U06).
request_assignment d-destination-off "${DB}/${DEST_B}/off"
choice_is "${DB}" "${DEST_B}" off || fail 'operator off not applied'
prompt "${DB}" 2 "${DEST_B}"
set_choice "${DA}" "${CATCHUP}" all d-bot-before-strict
# A bot write overlapping the restored channel edit changes its review's
# dependency, so the review is durably superseded: production's outcome line
# refuses that exact copied gesture and spends it, and no applied fact changes.
configuration_request d-restored-channel-edit request "${DA}/${ADDED}/${ADDED_VALUE}" > /dev/null
cp "${CONFIG}.pending" "${EVIDENCE}/d-restored-channel-edit.pending"
set_choice "${DA}" "${ADDED}" all d-bot-overlaps-edit
cp "${LAST}" "${EVIDENCE}/d-before-stale"
superseded_count="$(count_log "${superseded_line}")"
cp "${EVIDENCE}/d-restored-channel-edit.pending" "${CONFIG}.apply"
wait_for_count "${superseded_line}" "$((superseded_count + 1))" 30 'overlapped edit confirmation not refused'
[[ ! -e "${CONFIG}.apply" ]] || fail 'refused overlapped edit confirmation was not spent'
configuration_application_preserved "${CONFIG}" "${EVIDENCE}/d-before-stale" "${LAST}" > /dev/null \
    || fail 'stale confirmation changed applied facts'
choice_is "${DA}" "${ADDED}" all || fail 'stale confirmation overwrote the bot write'
configuration_request d-restored-channel-edit-refresh refresh > /dev/null
cp "${CONFIG}.pending" "${EVIDENCE}/d-refreshed-channel-edit.pending"
mv "${CONFIG}.pending" "${CONFIG}.apply"
wait_until 60 'refreshed edit not durably consumed' bun "${PRINTER}" sharedReviewConsumed \
    "${CONFIG}" "${LAST}" "${EVIDENCE}/d-refreshed-channel-edit.pending" > /dev/null
choice_is "${DA}" "${ADDED}" "${ADDED_VALUE}" || fail 'later operator confirmation lost its order'
messages_waiting "${DB}" "${DEST_A}" "${DEST_B}"
# And back to strict: the later durable order holds, bot writes are refused.
set_input_mode strict
review d-back-to-strict
for key in "${DA}" "${DB}"; do mode_is "${key}" strict || fail 'strict switch not applied'; done
choice_is "${DA}" "${CATCHUP}" all || fail 'bot assignment before strict was lost'
choice_is "${DB}" "${DEST_B}" off || fail 'operator assignment lost across modes'
bot_refused "${DA}" "${ADDED}" d-strict-bot-write
check_destinations d-after-modes

# Restart with membership changed while stopped (AC-U08): the retired
# channel was left and a new one joined; catch-up finds both.
for key in "${DA}" "${DB}"; do drain "${key}"; done
before_a="$(facts "${DA}" | jq -cS --arg r "${RETIRED}" 'del(.[$r])')" || fail 'cannot read alpha choices'
before_b="$(facts "${DB}")" || fail 'cannot read bravo choices'
stop_server
inventory "${DA}" C0TEST001 C0TEST002 G0TEST003/private C0UPGCONFA "${ADDED}" "${CATCHUP}"
inventory "${DB}" C0UPGCONFB C0TEST001 C0TEST002 "${OFF_CHANNEL}" "${STOPPED_JOIN}"
restart_mark="$(slack_post_mark)"
start "${DA}" "${DB}"
same_facts "${DA}" "${before_a}" 'restart changed alpha beyond the evidenced leave'
same_facts "${DB}" "${before_b}" 'restart changed bravo beyond the evidenced join' "${STOPPED_JOIN}"
choice_is "${DB}" "${STOPPED_JOIN}" off || fail 'join while stopped not caught up as off'
choice_is "${DA}" "${RETIRED}" '' || fail 'leave while stopped not caught up'
root_saved "${DB}" "${HYBRID}" "${hybrid_root}" || fail 'restart lost the new Joined Thread'
no_changed_report "${DB}" "${restart_mark}" d-restart "${HYBRID}"
check_destinations d-restart
references_unchanged d-restart
stop_server --stop-bots

# ===========================================================================
# Case F: 0.18.0 fungible to open (AC-U01, U02, U03, U04, U06, U11).
# ===========================================================================
prepare_case fungible-choices-and-destinations f case-f
FA="${P[alpha]}"; FB="${P[bravo]}"
CATCHUP="$(scenario_id C caught-up-open)"
ABSENT="$(case_json '.channels[]|select(.kind=="unknown-target")|.channel')"
EXTERNAL="$(case_json '.channels[]|select(.kind=="externally-shared")|.channel')"
DEST_A="$(case_json '.destinations[]|select(.persona=="alpha")|.chosen')"
for value in "${ABSENT}" "${EXTERNAL}" "${DEST_A}"; do
    [[ -n "${value}" && "${value}" != *$'\n'* ]] || fail 'F manifest value missing or not unique'
done
alpha_page=(C0TEST001 C0TEST002 G0TEST003/private "${EXTERNAL}/public/external" "${CATCHUP}")
inventory "${FA}" "${alpha_page[@]}"
inventory "${FB}"
shared_stub_notice_setup "${WORK[${FA}]}" > /dev/null
# Startup delays membership: no intake or tool authorization before current
# evidence, then exactly one acceptance on redelivery.
slack_stub_inventory_fault "${LABEL[${FA}]}" '' delay "delay_ms=$((membership_request_ms + 20000))" \
    "body=$(slack_stub_inventory_body '' "${alpha_page[@]}")"
mark="$(slack_post_mark)"
start_mark="${mark}"
start_server --live
wait_membership_complete "${FB}"
wait_until 60 'startup scan was not delayed' has_record_after "${mark}" fault "label=${LABEL[${FA}]}" method=users.conversations outcome=delay
slack_stub_control_fired fault "label=${LABEL[${FA}]}" method=users.conversations outcome=delay > /dev/null
session_up() { stub_session_sessions "${WORK[$1]}" | jq -se 'any(.[]; .event=="connected")' > /dev/null; }
# alpha's scan is still pending, read beside bravo's completed one: the same
# route answering for bravo shows the reader works, so not-complete is real.
scan_held() {
    _scenario_membership_complete "${FB}" "${readiness_route}" || fail "$1: the readiness route did not answer for bravo"
    ! _scenario_membership_complete "${FA}" "${readiness_route}" || fail "$1"
}
wait_until 60 'alpha socket did not open during the delayed scan' has_record_after "${mark}" ws-open "label=${LABEL[${FA}]}"
wait_until 90 'alpha MCP session did not connect during the delayed scan' session_up "${FA}"
scan_held 'delayed scan completed before the held checks'
held_ts="$(scenario_ts)"; held_text="$(scenario_text before-current-evidence)"
held="$(push "${FA}" "${DEST_A}" "${held_ts}" "${held_text}")"
no_ack "${held}" 2
result="$(scenario_attempt_call "${WORK[${FA}]}" "$(attempt_args "$(scenario_attempt_id f-before-evidence)" "${DEST_A}" all)")"
jq -e '.isError==true and (has("error")|not)' <<< "${result}" > /dev/null || fail 'unverified membership authorized a tool write'
scan_held 'held checks ran after current evidence'
slack_stub_faults_clear "${LABEL[${FA}]}"
wait_until "${recovery_bound_s}" 'delayed startup membership did not complete' _scenario_membership_complete "${FA}" "${readiness_route}"
ack "$(slack_stub_redeliver "${LABEL[${FA}]}" "${held}")"
wait_until "${EVENT_WAIT_S}" 'held input not accepted after evidence' queued "${FA}" "${DEST_A}" "${held_ts}" receive_all
read_queued "${FA}" "${DEST_A}" "${held_ts}"
[[ "${QUEUED}" == 1 ]] || fail 'held input accepted twice'
receipt "${FA}"
check_chosen_choices mentions
for key in "${FA}" "${FB}"; do mode_is "${key}" open || fail 'F did not start open'; one_list "${key}"; done
choice_is "${FA}" "${CATCHUP}" mentions || fail 'open catch-up is not mentions'
check_destinations f-first-start
references_unchanged f-first-start
# Retired identities: nothing inherited from a mismatched or inactive one.
rows_of '.identities[]|select(.disposition=="retire")|.name'
retired=(${ROWS[@]+"${ROWS[@]}"})
want="$(case_json '[.identities[]|select(.disposition=="retire")]|length')" || fail 'cannot read the manifest'
[[ "${#retired[@]}" == "${want}" && "${want}" -gt 0 ]] || fail 'retired identities not listed'
for name in "${retired[@]}"; do
    # Each retired identity had old choices in the preserved 0.18.0 store.
    old_key="${P[${name}]:-${SCENARIO_TAG}_${LETTER}_${name}}"
    old_channels="$(jq -r --arg n "${old_key}" '.personas[$n].channels|keys[]' "${REFERENCE_DIR}/channel-delivery.json")" \
        || fail "cannot read ${name}'s old stored choices"
    [[ -n "${old_channels}" ]] || fail "retired identity ${name} has no old stored choice"
    if [[ -n "${P[${name}]:-}" ]]; then
        for channel in ${old_channels}; do
            choice_is "${P[${name}]}" "${channel}" '' || fail "mismatched identity ${name} inherited ${channel}"
        done
    else
        # Inactive: not configured, and the authority has no such persona.
        # Its facts read fails exactly as a never-configured key's does, while
        # the same reader answers for alpha, so the failure is the absence.
        jq -e --arg n "${old_key}" 'all(.personas[]; .name != $n)' "${CONFIG}" > /dev/null \
            || fail "inactive identity ${name} is configured"
        shared_persona_facts "${FA}" > /dev/null || fail 'persona facts reader failed for alpha'
        absent_rc=0; absent_err="$(shared_persona_facts "${old_key}" 2>&1 > /dev/null)" || absent_rc=$?
        never_rc=0; never_err="$(shared_persona_facts "${SCENARIO_TAG}_${LETTER}_never_configured" 2>&1 > /dev/null)" || never_rc=$?
        (( never_rc == 1 )) && [[ -n "${never_err}" ]] || fail 'never-configured persona control did not fail as absent'
        (( absent_rc == never_rc )) && [[ "${absent_err}" == "${never_err}" ]] || fail "inactive identity ${name} inherited state"
    fi
done
not_selected "${FB}" C0TEST001 "$(mention "${FB}" mismatched-identity)"
not_selected "${FA}" C0TEST002 "$(scenario_text chosen-section-over-store)"
selected "${FA}" C0TEST002 mention "$(mention "${FA}" chosen-mentions)"
not_selected "${FA}" G0TEST003 "$(scenario_text private-mentions-plain)"
selected "${FA}" "${CATCHUP}" mention "$(mention "${FA}" open-default)"
# Current evidence first (AC-U04): externally shared and absent targets keep
# their transferred all but authorize neither intake nor tools in open.
for channel in "${EXTERNAL}" "${ABSENT}"; do
    not_selected "${FA}" "${channel}" "$(scenario_text "transferred-all-${channel}")"
    bot_refused "${FA}" "${channel}" "f-no-evidence-${channel}"
    choice_is "${FA}" "${channel}" all || fail 'transferred preference lost without evidence'
done
ack "$(slack_push_member_joined "${LABEL[${FA}]}" "${ABSENT}" "$(scenario_ts)")"
wait_until "${EVENT_WAIT_S}" 'live join changed the chosen value' choice_is "${FA}" "${ABSENT}" all
selected "${FA}" "${ABSENT}" receive_all "$(scenario_text absent-now-joined)"
messages_waiting "${FA}" "${DEST_A}" "${DEST_A}"
no_changed_report "${FA}" "${start_mark}" f-first-start -

# Strict after the open baseline, and back (AC-U11).
set_input_mode strict
review f-to-strict
for key in "${FA}" "${FB}"; do mode_is "${key}" strict || fail 'strict switch not applied'; done
bot_refused "${FA}" C0TEST002 f-strict-bot-write
request_assignment f-strict-operator "${FA}/C0TEST002/thread_hybrid"
ack "$(slack_push_member_joined "${LABEL[${FB}]}" C0TEST001 "$(scenario_ts)")"
wait_until "${EVENT_WAIT_S}" 'strict join of the mismatched identity channel is not off' choice_is "${FB}" C0TEST001 off
set_input_mode open
review f-back-to-open
for key in "${FA}" "${FB}"; do mode_is "${key}" open || fail 'open switch not applied'; done
set_choice "${FA}" G0TEST003 all f-open-bot-write
for key in "${FA}" "${FB}"; do drain "${key}"; done
before_a="$(facts "${FA}")" || fail 'cannot read alpha choices'
before_b="$(facts "${FB}")" || fail 'cannot read bravo choices'
stop_server
start "${FA}" "${FB}"
same_facts "${FA}" "${before_a}" 'restart changed the durable order'
same_facts "${FB}" "${before_b}" 'restart changed the durable order'
choice_is "${FA}" C0TEST002 thread_hybrid || fail 'operator assignment lost'
choice_is "${FB}" C0TEST001 off || fail 'old mismatched choice came back'
not_selected "${FA}" "${EXTERNAL}" "$(scenario_text external-after-restart)"
check_destinations f-restart
references_unchanged f-restart
stop_server --stop-bots

# ===========================================================================
# Case I: interrupted and invalid preparation (AC-U05, U06, U07, U09).
# ===========================================================================
prepare_case interrupted-and-invalid-preparation i case-i
IA="${P[alpha]}"
inventory "${IA}" C0TEST001 C0TEST002 G0TEST003/private
cp -p "${SLACK_STATE_DIR}/queue/${IA}.jsonl" "${EVIDENCE}/i-queue-prepared.jsonl"
queue_kept() { cmp -s "${SLACK_STATE_DIR}/queue/${IA}.jsonl" "${EVIDENCE}/i-queue-prepared.jsonl" || fail 'refused start changed the queue'; }
refuse_all queue_kept
switch_baseline "$(case_json '.baselines[]|select(.chosen)|.name')"
start "${IA}"
mode_is "${IA}" "$(case_json '.baselines[]|select(.chosen)|.expect.channel_mode')" || fail 'corrected mode not applied'
check_chosen_choices off
one_list "${IA}"
check_destinations i-corrected
references_unchanged i-corrected
old_queue_delivered "${IA}" "${REFERENCE_DIR}/queue/${IA}.jsonl"
# A newer write, then an old store put back while stopped: no load failure
# and no choice changes (the malformed store stayed in place throughout).
request_assignment i-newer-write "${IA}/G0TEST003/all"
before_a="$(facts "${IA}")" || fail 'cannot read alpha choices'
stop_server
cp -p "${REFERENCE_DIR}/damaged/channel-delivery.version-2.json" "${SLACK_STATE_DIR}/channel-delivery.json"
reference_digest > "${EVIDENCE}/${CASE}-references" || fail 'cannot digest the references'
start "${IA}"
same_facts "${IA}" "${before_a}" 'put-back old store changed a choice'
selected "${IA}" G0TEST003 receive_all "$(scenario_text newer-write-kept)"
references_unchanged i-put-back
stop_server --stop-bots

# ===========================================================================
# Case R: removed keys and channel_mode (AC-U05, U07, U12, U13).
# ===========================================================================
prepare_case removed-key-rejection r case-r
RA="${P[alpha]}"
inventory "${RA}" C0TEST001
# Every removed-key variant (two names: the key, then its replacement) prints
# the loader's sentence: an exact count from the manifest.
removed_variants="$(case_json '[.baselines[]|select(.expect.loads==false and (.expect.names|length)==2)]|length')" \
    || fail 'cannot read the manifest'
(( removed_variants > 0 )) || fail 'case R lists no removed-key variant'
REMOVED_SEEN=0; KEYS_ONLY=true
refuse_all true
KEYS_ONLY=false
(( REMOVED_SEEN == removed_variants )) || fail "removed-key sentences printer-checked for ${REMOVED_SEEN} of ${removed_variants} variants"
switch_baseline "$(case_json '.baselines[]|select(.chosen)|.name')"
names_mode="$(jq 'has("channel_mode")' "${CONFIG}")" || fail 'cannot read the chosen variant'
[[ "${names_mode}" == false ]] || fail 'chosen variant names channel_mode'
start "${RA}"
mode_is "${RA}" "$(case_json '.baselines[]|select(.chosen)|.expect.channel_mode')" || fail 'omitted channel_mode is not strict'
one_list "${RA}"
selected "${RA}" C0TEST001 receive_all "$(scenario_text omitted-mode)"
stop_server --stop-bots

# ===========================================================================
# Case Z: fresh starts with no old files (AC-U12).
# ===========================================================================
prepare_case fresh-start z case-z
mark="$(slack_post_mark)"
start_server --live
configuration_record_matches "${CONFIG}" "${LAST}" applied > /dev/null || fail 'zero-persona baseline not applied as prepared'
personas="$(jq '.personas|length' "${CONFIG}")" || fail 'cannot read the zero-persona variant'
[[ "${personas}" == 0 ]] || fail 'zero-persona variant names a persona'
none_after 'zero personas opened Slack' "${mark}" api method=apps.connections.open
stop_server --stop-bots
prepare_case fresh-start z case-z2
switch_baseline "$(case_json '.baselines[]|select(.chosen)|.name')"
ZA="${P[alpha]}"
inventory "${ZA}"
start "${ZA}"
same_facts "${ZA}" '{}' 'empty inventory invented a choice'
FRESH="$(scenario_id C fresh-join)"
ack "$(slack_push_member_joined "${LABEL[${ZA}]}" "${FRESH}" "$(scenario_ts)")"
wait_until "${EVENT_WAIT_S}" 'fresh join did not use the strict default' choice_is "${ZA}" "${FRESH}" off
check_destinations z-empty-inventory
stop_server --stop-bots

# Closing: every handled envelope once, every withheld one never.
acks_of() { ACK_N="$(slack_ack_count "$1")" || fail 'cannot read the ACK record'; }
while IFS= read -r envelope; do acks_of "${envelope}"; [[ "${ACK_N}" == 1 ]] || fail 'handled envelope ACK count changed'; done < "${ACKS}"
while IFS= read -r envelope; do acks_of "${envelope}"; [[ "${ACK_N}" == 0 ]] || fail 'withheld envelope was acknowledged'; done < "${NO_ACKS}"
pushes="$(slack_stub_record_count push)" || fail 'cannot read the push record'
[[ "${pushes}" == "$(( $(wc -l < "${ACKS}") + $(wc -l < "${NO_ACKS}") ))" ]] || fail 'unaccounted push'
stop_tracked_pid "${STUB_PID}"
leak_files=("${EVIDENCE}"/* "${SCENARIO_ROOT}"/case-*/state/server.log*)
leaks="$(count_token_like "${leak_files[@]}")" || fail 'cannot scan upgrade evidence'
[[ "${leaks}" == 0 ]] || fail 'token-like data in upgrade evidence'
echo "PASS: ${TEST_NAME}"
