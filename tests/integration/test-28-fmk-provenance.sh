#!/usr/bin/env bash
# Test 28 (HO §7 scenario 26; b.jg5 SRJ-1428; AC 1, AC 19, AC 86): session
# provenance stays agent-director's. A renamed session and another
# TMUX_TMPDIR still reach the workers, a re-bound socket gives SRJ-1021's
# onset with nothing killed, deleted or launched, and no CSCB process runs
# tmux, so none reads or writes @ad_owner or @ad_pane.
#
# Set-up (fmk mode, b.jg5 SRJ-1306, SRJ-1401): TEST_NAME carries `-fmk-`, so
# sourcing lib/scenario.sh gives the script its own HOME, agent-director
# install (the release, through its install.sh, behind the agent-director
# shim; agent-director-admin behind the same shim), store and tmux server, all
# under SCENARIO_ROOT, with agent-director's default settings (no `[tmux]`
# table). The tmux shim stays in `log` mode, first on every CSCB process's
# PATH. Two personas, A (PERSONA_A) and B (PERSONA_B), each with its own
# working directory in the stub's `at-once` mode (STUB_MODE_AT_ONCE: the stub
# reports in at once and opens its MCP session; it answers `/mcp reconnect`
# with a new session and ignores every other line but its sentinel, so a
# teardown's pause, whose `/exit` it never answers, escalates to the kill,
# b.jg5 SRJ-903). Not `dev-channels`: that dialog's text stays on the stub's
# pane once answered, and the waiting-row check's full pane read
# (src/session-manager.ts checkWaitingRowPane) then finds a prompt
# (blocked-on-prompt) and never types the reconnect that ends leg 4's outage.
# A live start against the Slack stub
# (fixtures/slack-stub-server.ts, both token pairs answered ok), with
# `health_check_interval` 0 (ruling S3: these legs need no health tick) and
# `agent_director_poll_interval_ms` at its largest allowed value
# (MAX_AGENT_DIRECTOR_POLL_INTERVAL_MS, src/config.ts: one hour, longer than
# the script), so the permission poller makes no store-wide `list` during the
# run.
#
# Every notice text, phrase, label, interval and line head compared below is
# printed from the installed package by fixtures/fmk-texts.ts (src/ exports
# named beside each value); posts are read from the Slack stub's record
# (`slack_posts`), CSCB's agent-director calls only from the agent-director
# shim's lines whose parent is a CSCB process (`cscb_ad_calls`,
# `cscb_ad_calls_between`, `cscb_ad_count_between`), and CSCB's tmux calls
# only from the tmux shim's lines whose parent is a CSCB process
# (`cscb_tmux_calls`): the harness's own calls, the stub's status reads and
# its stop line never count. The `version` calls the bot server makes on its
# own timer are left out of every window's call list.
#
# The working default (ruling S4, pending the orchestrator; the SRD names "a
# health check's pane read"): a bot-server restart without teardown, a plain
# `stop`, then `start`, provokes the tmux-touching call of the renamed-session
# leg and of the re-bound socket leg. For a live `waiting` row that call is
# the start pass's reconnect, a `send-keys` of `/mcp reconnect` (the stub's
# MCP session ended with the old bot server), not a pane read: the restart
# makes `get`, `spawn`, `get`, `send-keys` for the persona. So in leg 2 the
# SRD's health-check pane read is stood in for by the restart's `send-keys`
# reaching the renamed pane, fmk-driver.ts's pane read (the package's
# readPersonaOwnPane) and the teardown's precheck `read-pane`, and the restart
# path's waiting-row pane read is the one leg 4's retries make, with the
# socket re-bound. A restart's bring-up of a live persona
# makes one plain `spawn` first, which agent-director refuses with
# ErrInstanceIdCollision, before its own-row decision; so a "no spawn" window
# below allows that one spawn per persona and checks that it launched
# nothing: the worker's process and pane process, and the row's launch token,
# are the ones from before the restart.
#
# E11's notes, carried by the re-bound socket leg: CSCB makes no tmux-touching
# call for a healthy, connected persona, so the harness provokes one (the
# restart above: the start pass's reconnect of a disconnected stub); and while
# a worker stays connected a retry or a check may find the row live,
# connected and with its stream and post the all-clear with the socket still
# re-bound (SRJ-311's clear rule), so the posts may run onset, then any number
# of all-clear and new-onset pairs, and no kill, delete or launch is allowed
# throughout.
#
# Legs (each harness step is a human's, made from the scenario's own shell
# with the real tmux, so none reaches the tmux shim's log):
#   1. Start. The server's start pass launches both personas and both rows
#      read `waiting` (harness `status` reads).
#   2. Renamed session (SRJ-1428 bullet 2; SRJ-612; SRJ-901, SRJ-903,
#      SRJ-904). The harness renames A's session (`rename_session`) and
#      restarts the bot server without teardown. A bot-server-parented
#      `send-keys` of A's instance id follows the rename and reaches the
#      renamed session's pane: A's stub opens a new MCP session (a new child
#      of its pane process); server.log holds no waiting-row GONE, reconnect
#      GONE or escalate-dead line for A since the restart; no CSCB process
#      made a `resume`, `kill` or `delete` of A, nor a `spawn` that launched
#      (above);
#      A's worker runs and its row reads `waiting`. fmk-driver.ts's
#      `read-pane-other-tmux-tmpdir` for A (as in leg 3) answers
#      `outcome=<PANE_READ_PANE>`: a CSCB pane read returns the renamed
#      session's pane. Then `stop --stop-bots` (`stop_server --stop-bots`, a
#      CSCB process): its precheck's one-line `read-pane`
#      (PROBE_PANE_READ_LINES) and its teardown's `kill` of A both have that
#      `stop` run as their parent, the
#      kill is a plain `kill` (no --include-finished), and A's worker and the
#      renamed session are gone. The server is started again and both rows
#      read `waiting`.
#   3. Another TMUX_TMPDIR (SRJ-1428 bullet 3; SRJ-612). For each persona,
#      fixtures/fmk-driver.ts's `read-pane-other-tmux-tmpdir` through
#      `cscb_run` (the persona's own-pane read through the package's
#      readPersonaOwnPane, with TMUX_TMPDIR set, for that one call, to an
#      empty directory under SCENARIO_ROOT): one `DRIVER:` line with
#      `restored=true outcome=<PANE_READ_PANE>`, and the run's `read-pane` of
#      that persona's id has the driver as its parent. Both rows still read
#      `waiting`, both workers run as before, and no CSCB process made a
#      `spawn`, `resume`, `kill` or `delete`.
#   4. Re-bound socket (SRJ-1428 bullet 4; SRJ-311, SRJ-312, SRJ-1021,
#      SRJ-302). The harness re-binds the scenario's socket path while the
#      recorded server runs (`rebind_tmux_socket`) and restarts the bot
#      server without teardown. Each persona's first post is exactly
#      formatPersonaNotice of tmuxServerChangedOnset; the harness holds until
#      the retry timer's third retry after it is due (RETRY_THIRD_S) and
#      RETRY_ALLOWANCE_S more. Then, per persona, the posts since the re-bind
#      run onset, then any number of all-clear and onset pairs, each exactly
#      the persona's tmuxServerChangedOnset or ALL_CLEAR_TEMPLATE notice, so
#      never the generic ONSET_TEMPLATES `tmux-unavailable` one; server.log
#      holds DIFFERENT_TMUX_SERVER_PHRASE since the restart (the refused
#      calls' ErrTmuxNotAvailable, quoted in the waiting-row check's lines);
#      the bot server made at least three `read-pane` calls of each row (each
#      retry's waiting-row check, after its `status` reads); no CSCB process
#      made a `kill`, `delete` or `resume`, nor a `spawn` that launched; both
#      workers run as before and both rows read `waiting` (read-only store
#      reads). The harness restores the socket (`restore_tmux_socket`); each
#      persona's last post is then its all-clear (waited for until the
#      fourth retry, RETRY_FOURTH_S after the onset, and RETRY_ALLOWANCE_S
#      more), the sequence still fits, each stub opens a new MCP session (the
#      retry's reconnect reached it), and both rows read `waiting` (harness
#      `status` reads) with the same workers.
#   (E49 T3 adds its legs here: a restarted tmux server with health ticks,
#   remain-on-exit, and a pending row with no launch start.)
#   5. Close (SRJ-1428 bullet 1; SRJ-612; SRJ-1418). The server is stopped
#      with --stop-bots. The tmux shim's log holds no line whose parent is a
#      CSCB process (`cscb_tmux_count`: every bot server, `start` and `stop`
#      run and fmk-driver.ts run), so no CSCB-parented line carries
#      SCENARIO_AD_OWNER_OPTION or SCENARIO_AD_PANE_OPTION. The filter's own
#      control: over a copy of the log with lines added whose parents are the
#      last bot server, `stop` run and driver run (each at the start of its
#      recorded window), the scenario's shell and an unrecorded process, it
#      counts exactly the first three. The positive control: the log holds
#      lines carrying each of the two options, whose parent is an
#      agent-director process. The script ends with `assert_no_server_tmux`,
#      `assert_no_cscb_include_finished` and `assert_no_cscb_delete`. SRJ-716's
#      static half (no `ad_owner` or `ad_pane` in src/) is
#      tests/fmk-source-audit.test.ts.
#
# Waits and their derivation:
#   - RETRY_THIRD_S and RETRY_FOURTH_S, from UNAVAILABLE_RETRY_BASE_S
#     (src/unavailable-retry.ts, 30): the retries fall at 1, 3, 7 and 15
#     times it after the first refusal (each wait doubles the one before,
#     SRJ-302), so 210 s and 450 s.
#   - START_WAIT_S, REPORT_WAIT_S, POST_WAIT_S, KILL_END_WAIT_S and SETTLE_S
#     bound a start pass, a stub reporting in or opening its MCP session, a
#     post reaching the stub, a killed session ending and the calls that
#     follow a step.
#
# Matched fragments with no builder of their own (ruling S7), each quoted
# where it is matched with a comment naming its source: none beyond the
# printed heads of waitingRowPaneGoneLine, reconnectGoneLine and
# escalateDeadSweepLine (src/session-manager.ts), whose tails carry
# agent-director's answer or a verdict; the reconnect line's head stops
# before the persona's reference, so it is matched with the persona's key
# after it.
set -euo pipefail

TEST_NAME="test-28-fmk-provenance"
# shellcheck source=lib/scenario.sh
source "$(dirname "$0")/lib/scenario.sh"

# ---------------------------------------------------------------------------
# Values, from src/ through the printer
# ---------------------------------------------------------------------------

STEP_VALUES="values"
PERSONA_A="${SCENARIO_TAG}_alpha"
PERSONA_B="${SCENARIO_TAG}_beta"
SUFFIX_A="t28alpha"
SUFFIX_B="t28beta"
CHANNEL_A="C0T28ALP1"
CHANNEL_B="C0T28BET1"
KEY_A="$(persona_key "${PERSONA_A}")"
KEY_B="$(persona_key "${PERSONA_B}")"

# src/persona-identity.ts personaInstanceId, personaTmuxSessionName.
ID_A="$(_scenario_printed "${STEP_VALUES}" personaInstanceId "${KEY_A}")"
ID_B="$(_scenario_printed "${STEP_VALUES}" personaInstanceId "${KEY_B}")"
SESSION_A="$(_scenario_printed "${STEP_VALUES}" personaTmuxSessionName "${KEY_A}")"
# src/pane-read.ts.
PROBE_LINES="$(_scenario_printed "${STEP_VALUES}" PROBE_PANE_READ_LINES)"
READ_PANE="$(_scenario_printed "${STEP_VALUES}" PANE_READ_PANE)"
# src/config.ts.
POLL_INTERVAL_MS="$(_scenario_printed "${STEP_VALUES}" MAX_AGENT_DIRECTOR_POLL_INTERVAL_MS)"
# src/unavailable-retry.ts.
RETRY_BASE_S="$(_scenario_printed "${STEP_VALUES}" UNAVAILABLE_RETRY_BASE_S)"
# src/ad-description-phrases.ts.
DIFFERENT_SERVER_PHRASE="$(_scenario_printed "${STEP_VALUES}" DIFFERENT_TMUX_SERVER_PHRASE)"
# src/outage-state.ts, as each persona's notice (src/persona-notifier.ts formatPersonaNotice).
CHANGED_ONSET_A="$(_scenario_printed "${STEP_VALUES}" formatPersonaNotice "${PERSONA_A}" tmuxServerChangedOnset)"
CHANGED_ONSET_B="$(_scenario_printed "${STEP_VALUES}" formatPersonaNotice "${PERSONA_B}" tmuxServerChangedOnset)"
GENERIC_ONSET_A="$(_scenario_printed "${STEP_VALUES}" formatPersonaNotice "${PERSONA_A}" ONSET_TEMPLATES tmux-unavailable)"
GENERIC_ONSET_B="$(_scenario_printed "${STEP_VALUES}" formatPersonaNotice "${PERSONA_B}" ONSET_TEMPLATES tmux-unavailable)"
ALL_CLEAR_A="$(_scenario_printed "${STEP_VALUES}" formatPersonaNotice "${PERSONA_A}" ALL_CLEAR_TEMPLATE tmux-unavailable)"
ALL_CLEAR_B="$(_scenario_printed "${STEP_VALUES}" formatPersonaNotice "${PERSONA_B}" ALL_CLEAR_TEMPLATE tmux-unavailable)"
# src/session-manager.ts: the heads of the lines a GONE answer or an
# escalate-dead verdict writes (waitingRowPaneGoneLine, escalateDeadSweepLine,
# reconnectGoneLine).
WAITING_GONE_HEAD_A="$(_scenario_printed "${STEP_VALUES}" waitingRowPaneGoneLineHead "${KEY_A}")"
ESCALATE_HEAD_A="$(_scenario_printed "${STEP_VALUES}" escalateDeadSweepLineHead "${KEY_A}")"
RECONNECT_GONE_HEAD="$(_scenario_printed "${STEP_VALUES}" reconnectGoneLineHead)"

[[ "${PROBE_LINES}" =~ ^[1-9][0-9]*$ && "${POLL_INTERVAL_MS}" =~ ^[1-9][0-9]*$ && "${RETRY_BASE_S}" =~ ^[1-9][0-9]*$ ]] \
    || fail "${STEP_VALUES}: the probe's line count '${PROBE_LINES}', the poll interval '${POLL_INTERVAL_MS}' or the retry base '${RETRY_BASE_S}' is not a whole number"
[[ "${CHANGED_ONSET_A}" != "${GENERIC_ONSET_A}" && "${CHANGED_ONSET_B}" != "${GENERIC_ONSET_B}" ]] \
    || fail "${STEP_VALUES}: the tmux-server-changed onset is the generic tmux-unavailable onset"
# The retry timer's waits double from the base (SRJ-302): its third retry is
# due 1 + 2 + 4 bases after the first refusal, its fourth 1 + 2 + 4 + 8.
RETRY_THIRD_S=$(( RETRY_BASE_S * 7 ))
RETRY_FOURTH_S=$(( RETRY_BASE_S * 15 ))

# Waits, in seconds (see the header).
STUB_WAIT_S=20
START_WAIT_S=120
REPORT_WAIT_S=60
POST_WAIT_S=60
KILL_END_WAIT_S=15
SETTLE_S=3
RETRY_ALLOWANCE_S=30

# Set by the legs.
SLACK_STUB_PID=""
RECORD=""
START_COUNT=0
declare -A WORKER_PID=() PANE_PID=() LAUNCH_TOKEN=() MCP_PID=()

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

# start_slack_stub <dir> <suffix>...: start the Slack stub in a new <dir>,
# answering ok for each token pair ending in a <suffix> (labelled <suffix>)
# and refusing any other; wait for its ready file; export CSCB_SLACK_API_URL;
# set SLACK_STUB_PID and RECORD.
start_slack_stub() {
    local dir="$1" step="slack stub" api_url
    shift
    mkdir "${dir}" || fail "${step}: could not create ${dir}"
    python3 - "$@" << 'EOF' | write_file "${dir}/control.json"
import json, sys
print(json.dumps({
    "tokens": [{"suffix": s, "label": s, "auth": "ok", "connections": "ok"} for s in sys.argv[1:]],
    "default": {"auth": "invalid_auth", "connections": "invalid_auth"},
}))
EOF
    (cd "${dir}" && exec bun "${SCENARIO_FIXTURES}/slack-stub-server.ts" --record "${dir}/record.jsonl" \
        --control "${dir}/control.json" --ready-file "${dir}/ready.json") > "${dir}/stub.out" 2>&1 &
    SLACK_STUB_PID=$!
    track_pid "${SLACK_STUB_PID}"
    wait_for_file "${dir}/ready.json" "${STUB_WAIT_S}" "${step}: the Slack stub never wrote its ready file"
    api_url="$(jq -r '.api_url' "${dir}/ready.json")"
    [[ "${api_url}" =~ ^http://127\.0\.0\.1:[0-9]+/api/$ ]] || fail "${step}: the stub's api_url '${api_url}' is not loopback"
    export CSCB_SLACK_API_URL="${api_url}"
    RECORD="${dir}/record.jsonl"
}

# row_json <step> <id>: print the row (one JSON object) from a read-only
# store read.
row_json() {
    local out
    out="$(_scenario_row_json "$1" "$2")" || exit 1
    jq -c '.[0]' <<< "${out}"
}

# True when row <id> reads <state> (a read-only store read, which adds no
# line to the shim's log).
row_reads() {
    [[ "$(_scenario_store_read "row state" "SELECT state FROM spawns WHERE claude_instance_id = '$1'")" == "$2" ]]
}

both_rows_read() {
    row_reads "${ID_A}" "$1" && row_reads "${ID_B}" "$1"
}

# expect_status <step> <id> <state>: a harness `status` read of row <id>
# reads <state>.
expect_status() {
    local step="$1" id="$2" want="$3" got
    ad_capture status --claude-instance-id "${id}"
    (( AD_RC == 0 )) || fail "${step}: the harness status read of ${id} exited ${AD_RC}: $(tr '\n' ' ' < "${AD_ERR}")"
    got="$(jq -r '.state // empty' "${AD_OUT}")"
    [[ "${got}" == "${want}" ]] || fail "${step}: row ${id} reads '${got}', not ${want}"
}

# note_worker <step> <id>: record row <id>'s worker pid, pane pid and launch
# token; fail unless both processes run and the pane's process is the stub.
note_worker() {
    local step="$1" id="$2" row
    row="$(row_json "${step}" "${id}")"
    WORKER_PID[${id}]="$(jq -r '.pid // empty' <<< "${row}")"
    PANE_PID[${id}]="$(jq -r '.pane_pid // empty' <<< "${row}")"
    LAUNCH_TOKEN[${id}]="$(jq -r '.launch_token // empty' <<< "${row}")"
    [[ "${WORKER_PID[${id}]}" =~ ^[0-9]+$ && "${PANE_PID[${id}]}" =~ ^[0-9]+$ && -n "${LAUNCH_TOKEN[${id}]}" ]] \
        || fail "${step}: row ${id} records worker pid '${WORKER_PID[${id}]}', pane pid '${PANE_PID[${id}]}' and launch token '${LAUNCH_TOKEN[${id}]}'"
    expect_worker_runs "${step}" "${id}"
    grep -qzxF -- "${SCENARIO_BIN}/claude" "/proc/${PANE_PID[${id}]}/cmdline" 2> /dev/null \
        || fail "${step}: row ${id}'s pane process ${PANE_PID[${id}]} is not the stub ${SCENARIO_BIN}/claude"
}

# expect_worker_runs <step> <id>: row <id>'s noted worker and pane process run.
expect_worker_runs() {
    if ! pid_alive "${WORKER_PID[$2]}" || ! pid_alive "${PANE_PID[$2]}"; then
        fail "$1: row $2's worker (pid ${WORKER_PID[$2]}, pane pid ${PANE_PID[$2]}) no longer runs"
    fi
}

# expect_same_launch <step> <id>: nothing launched for row <id>: its noted
# worker and pane process run, and the row records them and its launch token.
expect_same_launch() {
    local step="$1" id="$2" row
    expect_worker_runs "${step}" "${id}"
    row="$(row_json "${step}" "${id}")"
    [[ "$(jq -r '.pid // empty' <<< "${row}")" == "${WORKER_PID[${id}]}" \
        && "$(jq -r '.pane_pid // empty' <<< "${row}")" == "${PANE_PID[${id}]}" \
        && "$(jq -r '.launch_token // empty' <<< "${row}")" == "${LAUNCH_TOKEN[${id}]}" ]] \
        || fail "${step}: row ${id} now records another launch: $(jq -c '{state, pid, pane_pid, launch_token}' <<< "${row}")"
}

# mcp_session_pid <id>: print the PID of the MCP session client
# (fixtures/stub-mcp-session.ts) row <id>'s stub runs as its child; empty
# when none runs.
mcp_session_pid() {
    pgrep -P "${PANE_PID[$1]}" -f stub-mcp-session.ts | head -n 1 || true
}

# True when row <id>'s stub runs an MCP session client other than the one
# noted in MCP_PID before the restart (the stub opens one on `/mcp reconnect`
# typed into its pane when none runs).
new_mcp_session() {
    local pid
    pid="$(mcp_session_pid "$1")"
    [[ -n "${pid}" && "${pid}" != "${MCP_PID[$1]:-}" ]]
}

# True when neither of row <id>'s noted processes runs.
worker_gone() {
    ! pid_alive "${WORKER_PID[$1]}" && ! pid_alive "${PANE_PID[$1]}"
}

# True when the scenario's tmux server holds a session named exactly <name>.
has_session() {
    "${SCENARIO_REAL_TMUX}" has-session -t "=$1" 2> /dev/null
}

no_session() {
    ! has_session "$1"
}

# start_and_settle <step>: start the server live, wait for its start pass to
# complete for both personas and both rows to read `waiting`, then note both
# workers.
start_and_settle() {
    local step="$1"
    start_server --live
    START_COUNT=$(( START_COUNT + 1 ))
    wait_for_count "$(completion_match 2)" "${START_COUNT}" "${START_WAIT_S}" "${step}: start pass ${START_COUNT} never completed"
    wait_until "${REPORT_WAIT_S}" "${step}: the rows never both read waiting" both_rows_read waiting
}

# log_slice <from-line>: print the path of a copy of server.log's lines after
# <from-line>.
log_slice() {
    local file
    file="$(mktemp "${SCENARIO_ROOT}/log-slice.XXXXXX")" || fail "log_slice: could not create a file"
    tail -n "+$(( $1 + 1 ))" "${SLACK_STATE_DIR}/server.log" > "${file}" || fail "log_slice: could not copy server.log"
    printf '%s\n' "${file}"
}

# window_calls <step> <from-mark> <to-mark|-> <id>: set WIN_VERBS, WIN_ARGS
# (the arguments joined by single spaces) and WIN_PPIDS to each CSCB-parented
# agent-director call in the shim log's window that names
# `--claude-instance-id <id>`, in log order.
window_calls() {
    local step="$1" out line a
    WIN_VERBS=()
    WIN_ARGS=()
    WIN_PPIDS=()
    out="$(cscb_ad_calls_between "$2" "$3" "" "--claude-instance-id $4")" || exit 1
    [[ -n "${out}" ]] || return 0
    while IFS= read -r line; do
        if ! _scenario_split_line "${line}" || ! _scenario_decode_words; then
            fail "${step}: a shim log line does not parse: ${line}"
        fi
        _scenario_ad_verb
        WIN_VERBS+=("${_L_VERB}")
        printf -v a '%s ' ${_L_ARGS[@]+"${_L_ARGS[@]}"}
        WIN_ARGS+=("${a% }")
        WIN_PPIDS+=("${_L_PPID}")
    done <<< "${out}"
}

# window_has <verb> <ppid> [<fragment>]: true when the last window_calls holds
# a <verb> by <ppid> whose arguments hold <fragment>.
window_has() {
    local i
    for i in "${!WIN_VERBS[@]}"; do
        [[ "${WIN_VERBS[i]}" == "$1" && "${WIN_PPIDS[i]}" == "$2" && " ${WIN_ARGS[i]} " == *"${3:-}"* ]] && return 0
    done
    return 1
}

# window_count <verb>: print how many calls of the last window_calls are <verb>.
window_count() {
    local v n=0
    for v in ${WIN_VERBS[@]+"${WIN_VERBS[@]}"}; do
        [[ "${v}" == "$1" ]] && n=$(( n + 1 ))
    done
    echo "${n}"
}

# expect_nothing_launched <step> <from-mark> <id>: since <from-mark> no CSCB
# process made a `resume`, `kill` or `delete` of row <id>, and at most the
# restart's one plain `spawn`, which launched nothing (expect_same_launch).
expect_nothing_launched() {
    local step="$1" id="$3" verb n
    window_calls "${step}" "$2" - "${id}"
    for verb in resume kill delete; do
        n="$(window_count "${verb}")"
        [[ "${n}" == 0 ]] || fail "${step}: a CSCB process made ${n} ${verb} call(s) of ${id}"
    done
    n="$(window_count spawn)"
    (( n <= 1 )) || fail "${step}: CSCB processes made ${n} spawn calls of ${id}, more than the restart's one refused plain spawn"
    expect_same_launch "${step}" "${id}"
}

# last_record_pid <role> [<word-fragment>]: print the PID of the last CSCB
# process record entry of <role> whose words hold <word-fragment>.
last_record_pid() {
    awk -F'\t' -v r="$1" -v w="${2:-}" '$1 == "proc" && $2 == r && index($6, w) { p = $3 } END { print p }' "${SCENARIO_CSCB_RECORD}"
}

# posts_of <label> <after-seq>: set POSTS to the text of each post the Slack
# record holds for <label> after <after-seq>, in order.
posts_of() {
    local out raw=() line text
    POSTS=()
    out="$(slack_posts "${RECORD}" "$1" "$2")" || exit 1
    [[ -n "${out}" ]] || return 0
    mapfile -t raw <<< "${out}"
    for line in "${raw[@]}"; do
        text="$(jq -j '.' <<< "${line}" && printf x)" || fail "posts_of $1: a post's text does not decode: ${line}"
        POSTS+=("${text%x}")
    done
}

posts_at_least() {
    posts_of "$1" "$2"
    (( ${#POSTS[@]} >= $3 ))
}

# True when the last post for <label> after <after-seq> is <text>.
last_post_is() {
    posts_of "$1" "$2"
    (( ${#POSTS[@]} > 0 )) && [[ "${POSTS[${#POSTS[@]}-1]}" == "$3" ]]
}

# expect_outage_posts <step> <label> <after-seq> <onset> <all-clear> <generic>:
# the posts for <label> after <after-seq> run <onset>, then any number of
# <all-clear> and <onset> pairs, and an <all-clear> last only when the
# sequence ends there; none is <generic>. Prints the sequence's length.
expect_outage_posts() {
    local step="$1" label="$2" onset="$4" clear="$5" generic="$6" i want
    posts_of "${label}" "$3"
    (( ${#POSTS[@]} >= 1 )) || fail "${step}: no post for ${label}"
    for i in "${!POSTS[@]}"; do
        [[ "${POSTS[i]}" != "${generic}" ]] || fail "${step}: post $(( i + 1 )) for ${label} is the generic tmux-unavailable onset"
        if (( i % 2 == 0 )); then
            want="${onset}"
        else
            want="${clear}"
        fi
        [[ "${POSTS[i]}" == "${want}" ]] \
            || fail "${step}: post $(( i + 1 )) for ${label} reads '${POSTS[i]}', not '${want}' (onset, then all-clear and onset pairs)"
    done
    echo "${#POSTS[@]}"
}

# run_driver <step> <persona> <channel> <workdir> <other-tmpdir>:
# fixtures/fmk-driver.ts's read-pane-other-tmux-tmpdir for <persona>, through
# `cscb_run`. Fails unless it exits 0 with exactly one outcome line
# `DRIVER: FORCED read-pane-other-tmux-tmpdir …` (DRIVER_LINE). Sets
# DRIVER_PID, the run's recorded PID.
run_driver() {
    local step="$1" call=read-pane-other-tmux-tmpdir out err rc=0 outcome=()
    out="${SCENARIO_ROOT}/fmk-driver-$2.out"
    err="${SCENARIO_ROOT}/fmk-driver-$2.err"
    cscb_run env "CSCB_PKG_DIR=${SCENARIO_REPO}/node_modules/claude-slack-channel-bots" \
        "DRIVER_PERSONA=$2" "DRIVER_PERSONA_CHANNEL=$3" "DRIVER_WORKING_DIRECTORY=$4" "DRIVER_OTHER_TMUX_TMPDIR=$5" \
        bun --no-install "${SCENARIO_FIXTURES}/fmk-driver.ts" "${call}" < /dev/null > "${out}" 2> "${err}" || rc=$?
    mapfile -t outcome < <(grep -E '^DRIVER(_FAIL)?:' "${out}" || true)
    if (( rc != 0 || ${#outcome[@]} != 1 )) || [[ "${outcome[0]}" != "DRIVER: FORCED ${call} "* ]]; then
        sed 's/^/  | /' "${out}" >&2
        tail -n 20 "${err}" | sed 's/^/  | /' >&2
        fail "${step}: the driver exited ${rc} with ${#outcome[@]} outcome line(s) (first: ${outcome[0]:-none}), not one 'DRIVER: FORCED ${call} …' line"
    fi
    DRIVER_LINE="${outcome[0]}"
    DRIVER_PID="$(last_record_pid run "fmk-driver.ts ${call}")"
    [[ "${DRIVER_PID}" =~ ^[0-9]+$ ]] || fail "${step}: the record holds no run entry for the driver"
    echo "${TEST_NAME}: ${step}: ${DRIVER_LINE:0:300}"
}

# ad_parented_tmux_count <fragment>: print how many tmux shim `call` lines
# hold <fragment> in their words and have an agent-director process as their
# parent (its argv[0] agent-director, or the binary behind the shim).
ad_parented_tmux_count() {
    local lines=() line parent=() n=0 w rest
    [[ -f "${SCENARIO_TMUX_SHIM_LOG}" ]] || { echo 0; return 0; }
    mapfile -t lines < "${SCENARIO_TMUX_SHIM_LOG}"
    for line in ${lines[@]+"${lines[@]}"}; do
        _scenario_split_line "${line}" && [[ "${_L_KIND}" == call && "${_L_PARENT}" != '?' ]] || continue
        _scenario_decode_words || continue
        printf -v rest '%s ' ${_L_WORDS[@]+"${_L_WORDS[@]}"}
        [[ "${rest}" == *"$1"* ]] || continue
        _scenario_eval_words parent "${_L_PARENT}" || continue
        w="${parent[0]:-}"
        [[ "${w##*/}" == agent-director || "${w##*/}" == agent-director.real ]] && n=$(( n + 1 ))
    done
    echo "${n}"
}

# ---------------------------------------------------------------------------
# Leg 1: set-up and start
# ---------------------------------------------------------------------------

STEP="set-up"
CREDS="${SCENARIO_ROOT}/credentials"
mkdir -m 700 "${CREDS}" || fail "${STEP}: could not create ${CREDS}"
mkdir -p "${SCENARIO_ROOT}/claude-config-a" "${SCENARIO_ROOT}/claude-config-b" \
    || fail "${STEP}: could not create the personas' config dirs"
WORK_A="$(make_workdir alpha)"
WORK_B="$(make_workdir beta)"
stub_mode "${WORK_A}" "${STUB_MODE_AT_ONCE}"
stub_mode "${WORK_B}" "${STUB_MODE_AT_ONCE}"
# The other TMUX_TMPDIR of the driver's pane reads: empty, under SCENARIO_ROOT.
EMPTY_TMPDIR="${SCENARIO_ROOT}/tmux-empty"
mkdir -m 700 "${EMPTY_TMPDIR}" || fail "${STEP}: could not create ${EMPTY_TMPDIR}"

start_slack_stub "${SCENARIO_ROOT}/slack-stub" "${SUFFIX_A}" "${SUFFIX_B}"
printf '{"bot_token": "%s", "app_token": "%s"}\n' "$(fake_token bot "${SUFFIX_A}")" "$(fake_token app "${SUFFIX_A}")" \
    | write_file "${CREDS}/alpha.json" 600
printf '{"bot_token": "%s", "app_token": "%s"}\n' "$(fake_token bot "${SUFFIX_B}")" "$(fake_token app "${SUFFIX_B}")" \
    | write_file "${CREDS}/beta.json" 600
write_config << EOF
{
  "personas": [
    {
      "name": "${PERSONA_A}",
      "credentials_file": "${CREDS}/alpha.json",
      "working_directory": "${WORK_A}",
      "claude_config_dir": "${SCENARIO_ROOT}/claude-config-a",
      "channels": [{ "id": "${CHANNEL_A}", "delivery": "all" }],
      "permission_prompts": "${CHANNEL_A}"
    },
    {
      "name": "${PERSONA_B}",
      "credentials_file": "${CREDS}/beta.json",
      "working_directory": "${WORK_B}",
      "claude_config_dir": "${SCENARIO_ROOT}/claude-config-b",
      "channels": [{ "id": "${CHANNEL_B}", "delivery": "all" }],
      "permission_prompts": "${CHANNEL_B}"
    }
  ],
  "bind": "127.0.0.1",
  "port": ${SCENARIO_PORT},
  "health_check_interval": 0,
  "agent_director_poll_interval_ms": ${POLL_INTERVAL_MS},
  "exit_timeout": 5
}
EOF

STEP="leg 1 (start)"
start_and_settle "${STEP}"
expect_completion 2 "${STEP}" "0 not brought up"
for id in "${ID_A}" "${ID_B}"; do
    expect_status "${STEP}" "${id}" waiting
    note_worker "${STEP}" "${id}"
done

# ---------------------------------------------------------------------------
# Leg 2: a renamed session; the restart's reconnect, a pane read and the
# teardown's kill
# ---------------------------------------------------------------------------

STEP="leg 2 (renamed session)"
RENAMED_A="${SCENARIO_TAG}_renamed_alpha"
SID_A="$(rename_session "${SESSION_A}" "${RENAMED_A}")"
no_session "${SESSION_A}" || fail "${STEP}: a session named ${SESSION_A} still exists after the rename"
echo "${TEST_NAME}: ${STEP}: session ${SID_A} renamed ${SESSION_A} -> ${RENAMED_A}"

# The bot server restarted without teardown (ruling S4's working default).
MARK_R="$(ad_shim_mark)"
LOG_R="$(wc -l < "${SLACK_STATE_DIR}/server.log")"
OLD_SERVER_PID="${SERVER_PID}"
MCP_PID[${ID_A}]="$(mcp_session_pid "${ID_A}")"
[[ -n "${MCP_PID[${ID_A}]}" ]] || fail "${STEP}: A's stub runs no MCP session client before the restart"
stop_server
expect_worker_runs "${STEP}: after the plain stop" "${ID_A}"
start_and_settle "${STEP}"
[[ "${SERVER_PID}" != "${OLD_SERVER_PID}" ]] || fail "${STEP}: the restart kept bot server ${SERVER_PID}"

# The start pass's reconnect of A's live `waiting` row: a send-keys that
# reaches the renamed session's pane, where the stub opens a new MCP session.
window_calls "${STEP}" "${MARK_R}" - "${ID_A}"
window_has send-keys "${SERVER_PID}" \
    || fail "${STEP}: the new bot server ${SERVER_PID} made no send-keys of ${ID_A} after the rename (its calls: ${WIN_VERBS[*]-none})"
wait_until "${REPORT_WAIT_S}" "${STEP}: A's stub opened no new MCP session after the restart's reconnect" \
    new_mcp_session "${ID_A}"
sleep "${SETTLE_S}"
window_calls "${STEP}" "${MARK_R}" - "${ID_A}"
echo "${TEST_NAME}: ${STEP}: CSCB calls of ${ID_A} since the restart: ${WIN_VERBS[*]-none}; A's stub reconnected"
SLICE="$(log_slice "${LOG_R}")"
# src/session-manager.ts reconnectGoneLine: the head, then the persona's
# reference (renderPersonaRef's or the bare key's form), which holds the key.
for m in "${WAITING_GONE_HEAD_A}" "${ESCALATE_HEAD_A}" "$(matcher "${RECONNECT_GONE_HEAD}" "${KEY_A}")"; do
    n="$(count_in "${SLICE}" "${m}")"
    [[ "${n}" == 0 ]] || fail "${STEP}: server.log holds ${n} line(s) '$(matcher_text "${m}")' since the restart"
done
expect_nothing_launched "${STEP}" "${MARK_R}" "${ID_A}"
expect_status "${STEP}" "${ID_A}" waiting

# A CSCB pane read of the renamed session (the package's readPersonaOwnPane,
# through fmk-driver.ts) returns A's pane.
mark="$(ad_shim_mark)"
run_driver "${STEP}" "${PERSONA_A}" "${CHANNEL_A}" "${WORK_A}" "${EMPTY_TMPDIR}"
[[ "${DRIVER_LINE}" == *" restored=true outcome=${READ_PANE} "* ]] \
    || fail "${STEP}: the driver's pane read of the renamed session did not answer a pane: ${DRIVER_LINE}"
window_calls "${STEP}" "${mark}" - "${ID_A}"
window_has read-pane "${DRIVER_PID}" || fail "${STEP}: no read-pane of ${ID_A} has the driver ${DRIVER_PID} as its parent"
expect_nothing_launched "${STEP}" "${MARK_R}" "${ID_A}"

# The teardown: its precheck's pane read and its kill, both by the CLI.
STEP="leg 2 (teardown)"
MARK_T="$(ad_shim_mark)"
stop_server --stop-bots
STOP_PID="$(last_record_pid stop)"
[[ "${STOP_PID}" =~ ^[0-9]+$ ]] || fail "${STEP}: the record holds no stop run"
window_calls "${STEP}" "${MARK_T}" - "${ID_A}"
echo "${TEST_NAME}: ${STEP}: CSCB calls of ${ID_A} by the teardown: ${WIN_VERBS[*]-none}"
window_has read-pane "${STOP_PID}" "--n-lines ${PROBE_LINES} " \
    || fail "${STEP}: the stop run ${STOP_PID} made no one-line (${PROBE_LINES}) read-pane of ${ID_A}"
window_has kill "${STOP_PID}" \
    || fail "${STEP}: the stop run ${STOP_PID} made no kill of ${ID_A}"
for i in "${!WIN_VERBS[@]}"; do
    if [[ "${WIN_VERBS[i]}" == read-pane || "${WIN_VERBS[i]}" == kill ]]; then
        [[ "${WIN_PPIDS[i]}" == "${STOP_PID}" ]] \
            || fail "${STEP}: a ${WIN_VERBS[i]} of ${ID_A} has parent ${WIN_PPIDS[i]}, not the stop run ${STOP_PID}"
    fi
    if [[ "${WIN_VERBS[i]}" == kill && " ${WIN_ARGS[i]} " == *include-finished* ]]; then
        fail "${STEP}: the teardown's kill of ${ID_A} carries --include-finished: ${WIN_ARGS[i]}"
    fi
done
wait_until "${KILL_END_WAIT_S}" "${STEP}: the renamed session ${RENAMED_A} outlived the teardown" no_session "${RENAMED_A}"
wait_until "${KILL_END_WAIT_S}" "${STEP}: A's worker outlived the teardown" worker_gone "${ID_A}"

STEP="leg 2 (start again)"
start_and_settle "${STEP}"
for id in "${ID_A}" "${ID_B}"; do
    expect_status "${STEP}" "${id}" waiting
    note_worker "${STEP}" "${id}"
done

# ---------------------------------------------------------------------------
# Leg 3: a CSCB call made with another TMUX_TMPDIR
# ---------------------------------------------------------------------------

STEP="leg 3 (another TMUX_TMPDIR)"
MARK_D="$(ad_shim_mark)"
for persona in "${PERSONA_A}" "${PERSONA_B}"; do
    if [[ "${persona}" == "${PERSONA_A}" ]]; then
        id="${ID_A}" channel="${CHANNEL_A}" work="${WORK_A}"
    else
        id="${ID_B}" channel="${CHANNEL_B}" work="${WORK_B}"
    fi
    mark="$(ad_shim_mark)"
    run_driver "${STEP}: ${persona}" "${persona}" "${channel}" "${work}" "${EMPTY_TMPDIR}"
    [[ "${DRIVER_LINE}" == *" tmux_tmpdir=\"${EMPTY_TMPDIR}\" restored=true outcome=${READ_PANE} "* ]] \
        || fail "${STEP}: ${persona}: the driver's pane read did not answer a pane under TMUX_TMPDIR ${EMPTY_TMPDIR}: ${DRIVER_LINE}"
    window_calls "${STEP}: ${persona}" "${mark}" - "${id}"
    window_has read-pane "${DRIVER_PID}" || fail "${STEP}: ${persona}: no read-pane of ${id} has the driver ${DRIVER_PID} as its parent"
    [[ "${TMUX_TMPDIR}" == "${SCENARIO_ROOT}/tmux" ]] || fail "${STEP}: TMUX_TMPDIR changed in the scenario's shell: ${TMUX_TMPDIR}"
done
for id in "${ID_A}" "${ID_B}"; do
    expect_status "${STEP}" "${id}" waiting
    expect_nothing_launched "${STEP}" "${MARK_D}" "${id}"
    n="$(window_count spawn)"
    [[ "${n}" == 0 ]] || fail "${STEP}: a CSCB process made ${n} spawn call(s) of ${id}"
done

# ---------------------------------------------------------------------------
# Leg 4: a re-bound socket; SRJ-1021's onset, nothing killed, deleted or launched
# ---------------------------------------------------------------------------

STEP="leg 4 (re-bound socket)"
POSTS_S="$(slack_record_mark "${RECORD}")"
MARK_S="$(ad_shim_mark)"
rebind_tmux_socket > "${SCENARIO_ROOT}/rebind.out"
MOVED_SOCKET="${REBOUND_SOCKET}"
echo "${TEST_NAME}: ${STEP}: re-bound: $(cat "${SCENARIO_ROOT}/rebind.out")"

LOG_S="$(wc -l < "${SLACK_STATE_DIR}/server.log")"
for id in "${ID_A}" "${ID_B}"; do
    MCP_PID[${id}]="$(mcp_session_pid "${id}")"
done
stop_server
start_server --live
START_COUNT=$(( START_COUNT + 1 ))
wait_for_count "$(completion_match 2)" "${START_COUNT}" "${START_WAIT_S}" "${STEP}: start pass ${START_COUNT} never completed"
wait_until "${POST_WAIT_S}" "${STEP}: no post for ${PERSONA_A} after the restart" posts_at_least "${SUFFIX_A}" "${POSTS_S}" 1
wait_until "${POST_WAIT_S}" "${STEP}: no post for ${PERSONA_B} after the restart" posts_at_least "${SUFFIX_B}" "${POSTS_S}" 1
ONSET_AT="$(date +%s)"
for label in "${SUFFIX_A}" "${SUFFIX_B}"; do
    posts_of "${label}" "${POSTS_S}"
    want="${CHANGED_ONSET_A}"
    [[ "${label}" == "${SUFFIX_B}" ]] && want="${CHANGED_ONSET_B}"
    [[ "${POSTS[0]}" == "${want}" ]] || fail "${STEP}: the first post for ${label} reads '${POSTS[0]}', not '${want}'"
done

hold_s=$(( ONSET_AT + RETRY_THIRD_S + RETRY_ALLOWANCE_S - $(date +%s) ))
echo "${TEST_NAME}: ${STEP}: onsets posted; holding ${hold_s}s, past the third retry (${RETRY_THIRD_S}s) and ${RETRY_ALLOWANCE_S}s more"
(( hold_s <= 0 )) || sleep "${hold_s}"

n_a="$(expect_outage_posts "${STEP}" "${SUFFIX_A}" "${POSTS_S}" "${CHANGED_ONSET_A}" "${ALL_CLEAR_A}" "${GENERIC_ONSET_A}")"
n_b="$(expect_outage_posts "${STEP}" "${SUFFIX_B}" "${POSTS_S}" "${CHANGED_ONSET_B}" "${ALL_CLEAR_B}" "${GENERIC_ONSET_B}")"
echo "${TEST_NAME}: ${STEP}: posts during the hold: ${n_a} for ${PERSONA_A}, ${n_b} for ${PERSONA_B}"
SLICE="$(log_slice "${LOG_S}")"
n="$(count_in "${SLICE}" "${DIFFERENT_SERVER_PHRASE}")"
(( n >= 1 )) || fail "${STEP}: server.log holds no line carrying '${DIFFERENT_SERVER_PHRASE}' since the restart"
for id in "${ID_A}" "${ID_B}"; do
    expect_nothing_launched "${STEP}" "${MARK_S}" "${id}"
    echo "${TEST_NAME}: ${STEP}: CSCB calls of ${id} since the re-bind: ${WIN_VERBS[*]-none}"
    # Each retry's waiting-row check reads the pane (refused): three retries.
    n=0
    for i in "${!WIN_VERBS[@]}"; do
        [[ "${WIN_VERBS[i]}" == read-pane && "${WIN_PPIDS[i]}" == "${SERVER_PID}" ]] && n=$(( n + 1 ))
    done
    (( n >= 3 )) || fail "${STEP}: the bot server made ${n} read-pane call(s) of ${id} during the hold, not one per retry for three retries"
    row_reads "${id}" waiting || fail "${STEP}: row ${id} no longer reads waiting"
done

STEP="leg 4 (restore)"
restore_tmux_socket "${MOVED_SOCKET}" > /dev/null
clear_s=$(( ONSET_AT + RETRY_FOURTH_S + RETRY_ALLOWANCE_S - $(date +%s) ))
(( clear_s > POST_WAIT_S )) || clear_s="${POST_WAIT_S}"
wait_until "${clear_s}" "${STEP}: no all-clear for ${PERSONA_A} after the restore" last_post_is "${SUFFIX_A}" "${POSTS_S}" "${ALL_CLEAR_A}"
wait_until "${clear_s}" "${STEP}: no all-clear for ${PERSONA_B} after the restore" last_post_is "${SUFFIX_B}" "${POSTS_S}" "${ALL_CLEAR_B}"
sleep "${SETTLE_S}"
n_a="$(expect_outage_posts "${STEP}" "${SUFFIX_A}" "${POSTS_S}" "${CHANGED_ONSET_A}" "${ALL_CLEAR_A}" "${GENERIC_ONSET_A}")"
n_b="$(expect_outage_posts "${STEP}" "${SUFFIX_B}" "${POSTS_S}" "${CHANGED_ONSET_B}" "${ALL_CLEAR_B}" "${GENERIC_ONSET_B}")"
echo "${TEST_NAME}: ${STEP}: all-clear $(( $(date +%s) - ONSET_AT ))s after the onsets; posts since the re-bind: ${n_a} for ${PERSONA_A}, ${n_b} for ${PERSONA_B}"
last_post_is "${SUFFIX_A}" "${POSTS_S}" "${ALL_CLEAR_A}" || fail "${STEP}: ${PERSONA_A}'s last post is not its all-clear"
last_post_is "${SUFFIX_B}" "${POSTS_S}" "${ALL_CLEAR_B}" || fail "${STEP}: ${PERSONA_B}'s last post is not its all-clear"
for id in "${ID_A}" "${ID_B}"; do
    # The retry that cleared the outage reconnected the persona: its stub
    # runs a new MCP session.
    wait_until "${REPORT_WAIT_S}" "${STEP}: ${id}'s stub opened no new MCP session after the all-clear" new_mcp_session "${id}"
    expect_status "${STEP}" "${id}" waiting
    expect_nothing_launched "${STEP}" "${MARK_S}" "${id}"
done

# ---------------------------------------------------------------------------
# E49 T3's legs go here, before the closing section.
# ---------------------------------------------------------------------------

# ---------------------------------------------------------------------------
# Leg 5: close
# ---------------------------------------------------------------------------

STEP="leg 5 (close)"
stop_server --stop-bots
stop_tracked_pid "${SLACK_STUB_PID}" 10 "${STEP}: the Slack stub did not exit on SIGTERM"

# No fragment: every line whose parent is a CSCB process.
# shellcheck disable=SC2119
n="$(cscb_tmux_count)"
if [[ "${n}" != 0 ]]; then
    # shellcheck disable=SC2119
    cscb_tmux_calls | sed 's/^/  | /' >&2
    fail "${STEP}: the tmux shim's log holds ${n} line(s) whose parent is a CSCB process"
fi
# The filter's own control, over a copy of the log with five lines added, each
# carrying SCENARIO_AD_OWNER_OPTION at the start of a recorded process's
# window: it counts the lines whose parent is the last bot server, the last
# `stop` run and the last fmk-driver.ts run, and not the ones whose parent is
# the scenario's shell or a process the record does not hold.
ctl="${SCENARIO_ROOT}/tmux-filter-control.log"
cp -- "${SCENARIO_TMUX_SHIM_LOG}" "${ctl}" || fail "${STEP}: could not copy the tmux shim's log"
for role in server stop run; do
    entry="$(awk -F'\t' -v r="${role}" '$1 == "proc" && $2 == r { e = $3 "\t" $5 } END { print e }' "${SCENARIO_CSCB_RECORD}")"
    [[ "${entry}" =~ ^[0-9]+$'\t'[0-9]+\.[0-9]{6}$ ]] || fail "${STEP}: the record holds no ${role} entry for the filter's control"
    printf 'call\t%s\t1\t%s\t?\tshow-options -v %s\n' "${entry#*$'\t'}" "${entry%%$'\t'*}" "${SCENARIO_AD_OWNER_OPTION}" >> "${ctl}"
done
printf 'call\t%s\t1\t%s\t?\tshow-options -v %s\n' "${EPOCHREALTIME/,/.}" "$$" "${SCENARIO_AD_OWNER_OPTION}" >> "${ctl}"
printf 'call\t%s\t1\t1\t?\tshow-options -v %s\n' "${EPOCHREALTIME/,/.}" "${SCENARIO_AD_OWNER_OPTION}" >> "${ctl}"
n="$(SCENARIO_TMUX_SHIM_LOG="${ctl}" cscb_tmux_count "${SCENARIO_AD_OWNER_OPTION}")"
[[ "${n}" == 3 ]] || fail "${STEP}: the filter's control: cscb_tmux_count counted ${n} of the added lines, not the bot server's, the stop run's and the driver's 3"
for option in "${SCENARIO_AD_OWNER_OPTION}" "${SCENARIO_AD_PANE_OPTION}"; do
    n="$(ad_parented_tmux_count "${option}")"
    (( n >= 1 )) || fail "${STEP}: positive control: no tmux shim line carrying ${option} has an agent-director parent"
    echo "${TEST_NAME}: ${STEP}: ${n} agent-director tmux call(s) carry ${option}; none by a CSCB process"
done

assert_no_server_tmux
assert_no_cscb_include_finished
assert_no_cscb_delete
echo "PASS: ${TEST_NAME}"
