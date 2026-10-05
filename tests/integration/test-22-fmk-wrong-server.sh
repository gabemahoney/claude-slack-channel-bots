#!/usr/bin/env bash
# Test 22 (HO §7 scenario 10; b.jg5 SRJ-1412; AC 1, AC 5): a find-missing from
# another tmux environment marks nothing (part A), and the own-id conflict
# latches, holds on its one-line probe and clears after a human's finished-row
# kill (part B).
#
# Set-up (fmk mode, b.jg5 SRJ-1306, SRJ-1401): TEST_NAME carries `-fmk-`, so
# sourcing lib/scenario.sh gives the script its own HOME, agent-director
# install (the release, through its install.sh, behind the agent-director
# shim; agent-director-admin behind the same shim), store and tmux server, all
# under SCENARIO_ROOT. The tmux shim stays in `log` mode, first on every CSCB
# process's PATH. One persona, PERSONA_NAME, whose working directory selects
# the stub's `dev-channels` mode (STUB_MODE_DEV_CHANNELS: the stub holds at
# the dev-channels dialog until the dialog approver's Enter, then reports in).
# A live start against the Slack stub (fixtures/slack-stub-server.ts, one
# token pair answered ok), with `health_check_interval` 0 (ruling S3: no leg
# needs a health tick; the latch re-check runs on its own timer whatever the
# interval, b.jg5 SRJ-505), and `agent_director_poll_interval_ms` at its
# largest allowed value (MAX_AGENT_DIRECTOR_POLL_INTERVAL_MS, src/config.ts:
# one hour, longer than the script), so the permission poller, whose first
# tick comes one interval after the start, makes no store-wide `list` during
# the run: the held latch's windows then hold the re-check's calls and nothing
# else but `version`, as SRJ-1412 B (3) and SRJ-505 state them (the stub never
# asks a permission, so the poller has nothing to find).
#
# Scenario 10 writes the scenario HOME's agent-director `[tmux]` table
# (SRJ-1306, SRJ-1401) before the server starts, through `write_ad_tmux_table`:
# the file at AD_SETTINGS_RELATIVE_PATH, table AD_TMUX_TABLE, and each key
# whose minimum is a whole number at that minimum (AD_SETTING_MINIMUMS, read
# through the printer with its AD_TMUX_KEYS check): `stopping_window_seconds`
# and `starting_session_seconds` (30 and 60 in the release), every name and
# value from src/ad-settings.ts, none typed here. BOUND_S is the larger
# minimum: the session must be older than both the stopping window (the
# statement's rule) and the starting-session bound (the finished-row kill's
# rule, and the own-id CONFLICT's rather than UNAVAILABLE's) before part B.
#
# Every notice text, phrase, label, interval and line count compared below is
# printed from the installed package by fixtures/fmk-texts.ts (src/ exports
# named beside each value); posts are read from the Slack stub's record
# (`slack_posts`), and CSCB's agent-director calls only from the
# agent-director shim's lines whose parent is a CSCB process (`cscb_ad_calls`,
# `cscb_ad_calls_between`, `cscb_ad_count`, `cscb_ad_count_between`): the
# harness's own calls, the stub's status reads and its stop line never count.
# The `version` calls the bot server makes on its own timer
# (AD_VERSION_RECHECK_INTERVAL_MS) are left out of every window's call list.
#
# Legs (each harness step is a human's, made from the scenario's own shell):
#   1. Start. The server's start pass launches the persona; the approver
#      clears the stub's dialog through agent-director and the row reads
#      `waiting` (a harness `status` read).
#   2. Part A (SRJ-1412 A), with the worker running. The harness runs
#      `find-missing` twice through the scenario HOME's binary behind the shim
#      (`ad_capture`): once with TMUX_TMPDIR set, for that call only, to an
#      empty directory under SCENARIO_ROOT, and once with TMUX set, for that
#      call only, to the second tmux server `start_second_tmux_server` started
#      on its own socket. Each exits 0 with a JSON object whose `ids` does not
#      hold the persona's instance id (every post-install row is looked up on
#      its recorded socket), and each is logged with the scenario's shell as
#      parent. The script checks that each prefix assignment did not outlive
#      its call, not which environment the binary saw (the shim logs a call's
#      arguments and parent, not its environment). Then the row still reads `waiting`, the worker runs, and over a
#      hold of one re-check interval and HOLD_EXTRA_S more, no CSCB process
#      makes a `resume`, `spawn`, `kill`, `read-pane` or `send-keys` for the
#      persona, nor any `find-missing`; the Slack record holds no post for the
#      persona, and server.log holds no latch line for it.
#   3. Part B, up to the latch (SRJ-1412 B (1), (2)). Once the worker's
#      session is more than BOUND_S old, the harness's one sqlite3 statement
#      (`ad_store_mark_finished <id> missing`, E39 T4's scenario 10 part B
#      statement; its column rules are checked in Test 0) marks the row
#      `missing`; a harness `status` read shows `missing` with no launch
#      start, and the worker still runs. The bot server is restarted without
#      teardown (ruling S4, the working default where the SRD names no
#      trigger: a plain `stop`, then `start`). The new bot server makes a
#      `resume` for the instance id; any UNAVAILABLE line carrying
#      STILL_STOPPING_PHRASE or STILL_STARTING_PHRASE comes before the first
#      line carrying CONFLICT_OWN_ID_PHRASE (the wait past BOUND_S means the
#      `resume` meets the CONFLICT directly: an UNAVAILABLE is allowed, not
#      expected); the persona latches with case
#      LATCH_CASE_OWN_ID; and the Slack record holds exactly one post for the
#      persona since part B began, carrying, in order, the persona prefix and
#      CONFLICT_NOTICE_FIRST_LINE_HEAD with the quoted session name, the
#      own-id case sentence (conflictCaseSentence), CONFLICT_NOTICE_POINTER_LINE
#      and CONFLICT_NOTICE_HUMAN_ONLY_LINE; the printer's
#      `sessionEndingCommandsIn` finds no session-ending command form in its
#      CSCB-authored lines (b.jg5 SRJ-1001, SRJ-1004).
#   4. The held latch (SRJ-1412 B (3); SRJ-505). Over two re-checks, each
#      window of CSCB calls from the end of the previous one makes exactly one
#      `status` and then one `read-pane` with `--n-lines` PROBE_PANE_READ_LINES
#      for the instance id, both by the bot server, and nothing else but
#      `version`; each round logs the probe holding (`still-latched` on a
#      pane); no further post is made; the worker runs and the row still
#      reads `missing`.
#   5. The human's finished-row kill (SRJ-1412 B (4); AC 16), right after the
#      second re-check: `ad_kill_include_finished <id>`, agent-director-admin's
#      `kill-finished --claude-instance-id <id>` (agent-director 0.11.0's form
#      of `kill --include-finished`), from the scenario's own shell. It
#      reports `kill_sent` true; the worker's session and process are gone;
#      the row keeps its `state`, `ended_at` and `row_version`.
#   6. The cleared probe (SRJ-1412 B (5), (6); SRJ-506, SRJ-1005; AC 5). From
#      the end of the second re-check to the first CSCB `resume` after it, the
#      bot server makes exactly `status`, the one-line `read-pane`,
#      `find-missing` and `resume`, in that order, once each; the round logs
#      the probe cleared on PANE_READ_GONE (the pane read's outcome for
#      agent-director's ErrTmuxCaptureFailed) with its retry; the resumed
#      launch proceeds (the approver clears the new stub's dialog and the row
#      reads `waiting`); and the second and last post of part B is exactly
#      formatPersonaNotice of conflictRecoveryText for the session with
#      LATCH_RECOVERY_REASON_RETRY_NOT_REFUSED.
#   7. Close. The agent-director shim's log holds exactly one finished-row
#      kill, the harness's, whose parent is the scenario's shell (its pid and
#      its command line); no CSCB process made a `kill` or a `delete`, and none
#      made a `spawn` from the latch on (the restart's bring-up makes one plain
#      `spawn` that agent-director answers ErrInstanceIdCollision before its
#      `resume`, as leg 1's start makes the first launch). The server is stopped with
#      --stop-bots, and the script ends with `assert_no_server_tmux`,
#      `assert_no_cscb_include_finished` and `assert_no_cscb_delete` (their
#      positive controls met by the approver's send-keys and the bot server's
#      version probe).
#
# Waits and their derivation:
#   - RECHECK_S, from LATCH_RECHECK_INTERVAL_MS (src/conflict-latch.ts,
#     120000): the first re-check comes one interval after the latch, each
#     next one interval after the previous one settled; each is waited for up
#     to RECHECK_S + RECHECK_ALLOWANCE_S from the end of the previous window.
#   - BOUND_S: the larger of the [tmux] minimums written above; part B waits
#     until the session is BOUND_S + AGE_MARGIN_S old.
#   - START_WAIT_S, REPORT_WAIT_S, LATCH_WAIT_S, POST_WAIT_S, KILL_END_WAIT_S
#     and SETTLE_S bound a start pass, a stub reporting in, the restart's
#     latch, a post reaching the stub, the killed session ending and a round's
#     calls after its read-pane.
#
# Matched fragments with no builder of their own (ruling S7), each quoted
# where it is matched with a comment naming its source: the latch line's head
# (src/conflict-latch.ts conflictLatchSetLine, whose whole line carries
# agent-director's description), the re-check round line's head and fields
# (src/conflict-latch.ts latchRecheckRoundLine) with the answers
# src/session-manager.ts composes inline (`still-latched (pane)`,
# `probe-cleared (gone); …`), and the quotes around the session name in the
# CONFLICT notice's first line (src/conflict-latch.ts slackQuotedSession).
set -euo pipefail

TEST_NAME="test-22-fmk-wrong-server"
# shellcheck source=lib/scenario.sh
source "$(dirname "$0")/lib/scenario.sh"

# ---------------------------------------------------------------------------
# Values, from src/ through the printer
# ---------------------------------------------------------------------------

STEP_VALUES="values"
PERSONA_NAME="${SCENARIO_TAG}_wrong"
PERSONA_KEY="$(persona_key "${PERSONA_NAME}")"
PERSONA_REF="$(persona_ref "${PERSONA_NAME}")"
CHANNEL="C0T22WRG1"
SLACK_SUFFIX="t22wrong"

# src/persona-identity.ts personaInstanceId, personaTmuxSessionName.
INSTANCE_ID="$(_scenario_printed "${STEP_VALUES}" personaInstanceId "${PERSONA_KEY}")"
SESSION_NAME="$(_scenario_printed "${STEP_VALUES}" personaTmuxSessionName "${PERSONA_KEY}")"
# src/conflict-latch.ts.
RECHECK_MS="$(_scenario_printed "${STEP_VALUES}" LATCH_RECHECK_INTERVAL_MS)"
OWN_ID_CASE="$(_scenario_printed "${STEP_VALUES}" LATCH_CASE_OWN_ID)"
OWN_ID_SENTENCE="$(_scenario_printed "${STEP_VALUES}" conflictCaseSentence "${OWN_ID_CASE}")"
NOTICE_HEAD="$(_scenario_printed "${STEP_VALUES}" formatPersonaNotice "${PERSONA_NAME}" CONFLICT_NOTICE_FIRST_LINE_HEAD)"
NOTICE_POINTER="$(_scenario_printed "${STEP_VALUES}" CONFLICT_NOTICE_POINTER_LINE)"
NOTICE_HUMAN_ONLY="$(_scenario_printed "${STEP_VALUES}" CONFLICT_NOTICE_HUMAN_ONLY_LINE)"
RECOVERY_POST="$(_scenario_printed "${STEP_VALUES}" formatPersonaNotice "${PERSONA_NAME}" \
    conflictRecoveryText "${SESSION_NAME}" LATCH_RECOVERY_REASON_RETRY_NOT_REFUSED)"
CALL_PROBE="$(_scenario_printed "${STEP_VALUES}" RECHECK_CALL_PROBE)"
CALL_RESUME="$(_scenario_printed "${STEP_VALUES}" RECHECK_CALL_RESUME)"
VERDICT_STILL_LATCHED="$(_scenario_printed "${STEP_VALUES}" RECHECK_VERDICT_STILL_LATCHED)"
# src/pane-read.ts.
PROBE_LINES="$(_scenario_printed "${STEP_VALUES}" PROBE_PANE_READ_LINES)"
READ_PANE="$(_scenario_printed "${STEP_VALUES}" PANE_READ_PANE)"
READ_GONE="$(_scenario_printed "${STEP_VALUES}" PANE_READ_GONE)"
# src/config.ts.
POLL_INTERVAL_MS="$(_scenario_printed "${STEP_VALUES}" MAX_AGENT_DIRECTOR_POLL_INTERVAL_MS)"
# src/ad-description-phrases.ts.
OWN_ID_PHRASE="$(_scenario_printed "${STEP_VALUES}" CONFLICT_OWN_ID_PHRASE)"
STOPPING_PHRASE="$(_scenario_printed "${STEP_VALUES}" STILL_STOPPING_PHRASE)"
STARTING_PHRASE="$(_scenario_printed "${STEP_VALUES}" STILL_STARTING_PHRASE)"
# src/ad-settings.ts: each `[tmux]` key with a whole-number minimum, `<key>=<n>`.
MINIMUMS_TEXT="$(_scenario_printed "${STEP_VALUES}" AD_SETTING_MINIMUMS)"
mapfile -t TMUX_PAIRS <<< "${MINIMUMS_TEXT}"

[[ "${RECHECK_MS}" =~ ^[1-9][0-9]*$ && "${PROBE_LINES}" =~ ^[1-9][0-9]*$ && "${POLL_INTERVAL_MS}" =~ ^[1-9][0-9]*$ ]] \
    || fail "${STEP_VALUES}: the re-check interval '${RECHECK_MS}', the probe's line count '${PROBE_LINES}' or the poll interval '${POLL_INTERVAL_MS}' is not a whole number"
RECHECK_S=$(( (RECHECK_MS + 999) / 1000 ))
BOUND_S=0
for pair in "${TMUX_PAIRS[@]}"; do
    [[ "${pair}" =~ ^[a-z_]+=([0-9]+)$ ]] || fail "${STEP_VALUES}: AD_SETTING_MINIMUMS printed '${pair}', not <key>=<n>"
    (( BASH_REMATCH[1] > BOUND_S )) && BOUND_S="${BASH_REMATCH[1]}"
done
(( BOUND_S > 0 )) || fail "${STEP_VALUES}: AD_SETTING_MINIMUMS printed no minimum above 0"

# Waits, in seconds (see the header).
STUB_WAIT_S=20
START_WAIT_S=120
REPORT_WAIT_S=60
LATCH_WAIT_S=120
POST_WAIT_S=30
KILL_END_WAIT_S=15
SETTLE_S=3
HOLD_EXTRA_S=5
AGE_MARGIN_S=2
RECHECK_ALLOWANCE_S=60
HELD_RECHECKS=2

# Set by the legs.
SLACK_STUB_PID=""
RECORD=""
WORKER_PID=""
PANE_PID=""

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

# start_slack_stub <dir> <suffix>: start the Slack stub in a new <dir>,
# answering ok for the token pair ending in <suffix> (label <suffix>) and
# refusing any other; wait for its ready file; export CSCB_SLACK_API_URL; set
# SLACK_STUB_PID and RECORD.
start_slack_stub() {
    local dir="$1" suffix="$2" step="slack stub" api_url
    mkdir "${dir}" || fail "${step}: could not create ${dir}"
    python3 - "${suffix}" << 'EOF' | write_file "${dir}/control.json"
import json, sys
print(json.dumps({
    "tokens": [{"suffix": sys.argv[1], "label": sys.argv[1], "auth": "ok", "connections": "ok"}],
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

# row_json <step>: print the persona's row (one JSON object) from a read-only
# store read.
row_json() {
    local out
    out="$(_scenario_row_json "$1" "${INSTANCE_ID}")" || exit 1
    jq -c '.[0]' <<< "${out}"
}

# True when the persona's row reads <state> (a read-only store read, which
# adds no line to the shim's log).
row_reads() {
    [[ "$(_scenario_store_read "row state" "SELECT state FROM spawns WHERE claude_instance_id = '${INSTANCE_ID}'")" == "$1" ]]
}

# expect_status <step> <state>: a harness `status` read of the persona's row
# reads <state>.
expect_status() {
    local step="$1" want="$2" got
    ad_capture status --claude-instance-id "${INSTANCE_ID}"
    (( AD_RC == 0 )) || fail "${step}: the harness status read exited ${AD_RC}: $(tr '\n' ' ' < "${AD_ERR}")"
    got="$(jq -r '.state // empty' "${AD_OUT}")"
    [[ "${got}" == "${want}" ]] || fail "${step}: the row reads '${got}', not ${want}"
}

# note_worker <step>: set WORKER_PID and PANE_PID from the row; fail unless
# both run and the pane's process is the stub.
note_worker() {
    local step="$1" row
    row="$(row_json "${step}")"
    WORKER_PID="$(jq -r '.pid // empty' <<< "${row}")"
    PANE_PID="$(jq -r '.pane_pid // empty' <<< "${row}")"
    [[ "${WORKER_PID}" =~ ^[0-9]+$ && "${PANE_PID}" =~ ^[0-9]+$ ]] \
        || fail "${step}: the row records worker pid '${WORKER_PID}' and pane pid '${PANE_PID}'"
    expect_worker_runs "${step}"
    grep -qzxF -- "${SCENARIO_BIN}/claude" "/proc/${PANE_PID}/cmdline" 2> /dev/null \
        || fail "${step}: the pane's process ${PANE_PID} is not the stub ${SCENARIO_BIN}/claude"
}

# expect_worker_runs <step>: the worker's process and the pane's process run.
expect_worker_runs() {
    if ! pid_alive "${WORKER_PID}" || ! pid_alive "${PANE_PID}"; then
        fail "$1: the worker (pid ${WORKER_PID}, pane pid ${PANE_PID}) no longer runs"
    fi
}

# True when neither the worker's process nor the pane's process runs.
worker_gone() {
    ! pid_alive "${WORKER_PID}" && ! pid_alive "${PANE_PID}"
}

# True when the scenario's tmux server holds a session named exactly <name>.
has_session() {
    "${SCENARIO_REAL_TMUX}" has-session -t "=$1" 2> /dev/null
}

no_session() {
    ! has_session "$1"
}

# post_count <after-seq>: print how many posts the Slack record holds for the
# persona's label after <after-seq>.
post_count() {
    local out
    out="$(slack_posts "${RECORD}" "${SLACK_SUFFIX}" "$1")" || exit 1
    if [[ -z "${out}" ]]; then
        echo 0
    else
        wc -l <<< "${out}" | tr -d ' '
    fi
}

posts_at_least() {
    (( $(post_count "$1") >= $2 ))
}

# post_text <after-seq> <n>: print the text of the <n>th post (from 1) after
# <after-seq>, with a sentinel so trailing newlines are kept (strip the last
# `x`).
post_text() {
    local out
    out="$(slack_posts "${RECORD}" "${SLACK_SUFFIX}" "$1")" || exit 1
    sed -n "$2p" <<< "${out}" | jq -j '.' && printf x
}

# expect_in_order <step> <text> <fragment>...: <text> holds every fragment,
# in order.
expect_in_order() {
    local step="$1" rest="$2" frag
    shift 2
    for frag in "$@"; do
        [[ "${rest}" == *"${frag}"* ]] || fail "${step}: the post lacks, in its order, '${frag}'"
        rest="${rest#*"${frag}"}"
    done
}

# True when the agent-director shim's log holds, after line <mark>, a line
# holding <verb> and the persona's instance id (a cheap scan; the windows
# below read whose call it is).
shim_line_after() {
    tail -n "+$(( $1 + 1 ))" "${SCENARIO_AD_SHIM_LOG}" 2> /dev/null | grep -F -- "$2" | grep -qF -- "${INSTANCE_ID}"
}

# window_calls <step> <from-mark> <to-mark|->: set WIN_VERBS, WIN_ARGS (the
# arguments joined by single spaces) and WIN_PPIDS to each CSCB-parented
# agent-director call in the shim log's window, in log order, leaving out
# `version`.
window_calls() {
    local step="$1" out line a
    WIN_VERBS=()
    WIN_ARGS=()
    WIN_PPIDS=()
    out="$(cscb_ad_calls_between "$2" "$3" "")" || exit 1
    [[ -n "${out}" ]] || return 0
    while IFS= read -r line; do
        if ! _scenario_split_line "${line}" || ! _scenario_decode_words; then
            fail "${step}: a shim log line does not parse: ${line}"
        fi
        _scenario_ad_verb
        [[ "${_L_VERB}" == version ]] && continue
        WIN_VERBS+=("${_L_VERB}")
        printf -v a '%s ' ${_L_ARGS[@]+"${_L_ARGS[@]}"}
        WIN_ARGS+=("${a% }")
        WIN_PPIDS+=("${_L_PPID}")
    done <<< "${out}"
}

# expect_window <step> <verb>...: the window's calls (window_calls) are
# exactly <verb>..., in order, each by the bot server; each but find-missing
# names the persona's instance id, and a read-pane reads PROBE_LINES lines.
expect_window() {
    local step="$1" i want
    shift
    want="$*"
    [[ "${WIN_VERBS[*]-}" == "${want}" ]] \
        || fail "${step}: the bot server's calls were '${WIN_VERBS[*]-}', not '${want}'"
    for i in "${!WIN_VERBS[@]}"; do
        [[ "${WIN_PPIDS[i]}" == "${SERVER_PID}" ]] \
            || fail "${step}: its ${WIN_VERBS[i]} has parent ${WIN_PPIDS[i]}, not the bot server ${SERVER_PID}"
        if [[ "${WIN_VERBS[i]}" != find-missing ]]; then
            [[ " ${WIN_ARGS[i]} " == *" --claude-instance-id ${INSTANCE_ID} "* ]] \
                || fail "${step}: its ${WIN_VERBS[i]} names no --claude-instance-id ${INSTANCE_ID}: ${WIN_ARGS[i]}"
        fi
        if [[ "${WIN_VERBS[i]}" == read-pane ]]; then
            [[ " ${WIN_ARGS[i]} " == *" --n-lines ${PROBE_LINES} "* ]] \
                || fail "${step}: its read-pane does not read ${PROBE_LINES} line(s): ${WIN_ARGS[i]}"
        fi
    done
}

# harness_find_missing <step> <mark>: the harness's last `ad_capture
# find-missing` exited 0 with a JSON object whose `ids` is an array without
# the persona's instance id, and the shim logged it, after <mark>, with the
# scenario's shell as parent.
harness_find_missing() {
    local step="$1" mark="$2" lines=() i n=0
    (( AD_RC == 0 )) || fail "${step}: find-missing exited ${AD_RC}: $(tr '\n' ' ' < "${AD_ERR}")"
    jq -e 'type == "object" and (.ids | type) == "array"' "${AD_OUT}" > /dev/null 2>&1 \
        || fail "${step}: find-missing printed no JSON object with an ids array: $(head -c 300 "${AD_OUT}")"
    jq -e --arg id "${INSTANCE_ID}" '.ids | index($id) == null' "${AD_OUT}" > /dev/null \
        || fail "${step}: find-missing listed ${INSTANCE_ID} in its ids: $(tr '\n' ' ' < "${AD_OUT}")"
    echo "${TEST_NAME}: ${step}: find-missing answered $(jq -c '.' "${AD_OUT}")"
    mapfile -t lines < <(tail -n "+$(( mark + 1 ))" "${SCENARIO_AD_SHIM_LOG}")
    for i in "${!lines[@]}"; do
        _scenario_split_line "${lines[i]}" && [[ "${_L_KIND}" == call ]] || continue
        _scenario_decode_words || continue
        _scenario_ad_verb
        [[ "${_L_VERB}" == find-missing && "${_L_PPID}" == "$$" && "${_L_PARENT}" == "${SCENARIO_SHELL_CMDLINE}" ]] \
            && n=$(( n + 1 ))
    done
    (( n == 1 )) || fail "${step}: the shim logged ${n} find-missing call(s) from the scenario's shell since the call, not 1"
}

# The fragments of the persona's latch line (src/conflict-latch.ts
# conflictLatchSetLine: `[slack] conflict-latch: persona=<key> latched — case=<case> …`;
# its tail carries agent-director's description, so only its head is matched).
LATCH_ANY="$(matcher "[slack] conflict-latch: persona=${PERSONA_KEY} " "latched — ")"
LATCH_OWN_ID="$(matcher "[slack] conflict-latch: persona=${PERSONA_KEY} latched — case=${OWN_ID_CASE}" "${OWN_ID_PHRASE}")"
# The re-check round line (src/conflict-latch.ts latchRecheckRoundLine,
# `[slack] conflict-latch: re-check of <ref> — case=<case> step=<step> call=<call> answer=<answer>`),
# with the answers src/session-manager.ts runLatchRecheckRound composes inline:
# `<verdict> (<pane read kind>)` for a probe that holds, and
# `probe-cleared (<pane read kind>); …` with call
# `<probe>+find-missing+<retry>` for one that cleared
# (latchRecheckClearedProbeRetry's call label).
ROUND_HELD="$(matcher "[slack] conflict-latch: re-check of ${PERSONA_REF} — case=${OWN_ID_CASE} " \
    " call=${CALL_PROBE} answer=${VERDICT_STILL_LATCHED} (${READ_PANE})")"
ROUND_CLEARED="$(matcher "[slack] conflict-latch: re-check of ${PERSONA_REF} — case=${OWN_ID_CASE} " \
    " call=${CALL_PROBE}+find-missing+${CALL_RESUME} answer=probe-cleared (${READ_GONE})")"

# ---------------------------------------------------------------------------
# Leg 1: set-up and start
# ---------------------------------------------------------------------------

STEP="set-up"
CREDS="${SCENARIO_ROOT}/credentials"
mkdir -m 700 "${CREDS}" || fail "${STEP}: could not create ${CREDS}"
CONFIG_DIR="${SCENARIO_ROOT}/claude-config"
mkdir -p "${CONFIG_DIR}" || fail "${STEP}: could not create ${CONFIG_DIR}"
WORK="$(make_workdir wrong)"
stub_mode "${WORK}" "${STUB_MODE_DEV_CHANNELS}"

# The [tmux] table, before the server starts: every whole-number minimum.
write_ad_tmux_table "${TMUX_PAIRS[@]}"
echo "${TEST_NAME}: ${STEP}: [tmux] ${TMUX_PAIRS[*]} (session must pass ${BOUND_S}s); re-check every ${RECHECK_S}s"

start_slack_stub "${SCENARIO_ROOT}/slack-stub" "${SLACK_SUFFIX}"
printf '{"bot_token": "%s", "app_token": "%s"}\n' "$(fake_token bot "${SLACK_SUFFIX}")" "$(fake_token app "${SLACK_SUFFIX}")" \
    | write_file "${CREDS}/wrong.json" 600
write_config << EOF
{
  "personas": [
    {
      "name": "${PERSONA_NAME}",
      "credentials_file": "${CREDS}/wrong.json",
      "working_directory": "${WORK}",
      "claude_config_dir": "${CONFIG_DIR}",
      "channels": [{ "id": "${CHANNEL}", "delivery": "all" }],
      "permission_prompts": "${CHANNEL}"
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
start_server --live
wait_for_log "$(completion_match 1)" "${START_WAIT_S}" "${STEP}: the start pass never completed"
expect_completion 1 "${STEP}" "0 not brought up"
wait_until "${REPORT_WAIT_S}" "${STEP}: row ${INSTANCE_ID} never reported in (waiting)" row_reads waiting
expect_status "${STEP}" waiting
note_worker "${STEP}"
(( $(cscb_ad_count send-keys "--claude-instance-id ${INSTANCE_ID}") >= 1 )) \
    || fail "${STEP}: no CSCB send-keys cleared the stub's dialog"

# ---------------------------------------------------------------------------
# Leg 2: part A, find-missing from another tmux environment
# ---------------------------------------------------------------------------

STEP="leg 2 (part A)"
MARK_A="$(ad_shim_mark)"
start_second_tmux_server > /dev/null
EMPTY_TMPDIR="${SCENARIO_ROOT}/tmux-empty"
mkdir -m 700 "${EMPTY_TMPDIR}" || fail "${STEP}: could not create ${EMPTY_TMPDIR}"

# The human's run with TMUX_TMPDIR set to an empty directory, for this call only.
mark="$(ad_shim_mark)"
TMUX_TMPDIR="${EMPTY_TMPDIR}" ad_capture find-missing
harness_find_missing "${STEP}: TMUX_TMPDIR=${EMPTY_TMPDIR}" "${mark}"
[[ "${TMUX_TMPDIR}" == "${SCENARIO_ROOT}/tmux" ]] || fail "${STEP}: TMUX_TMPDIR outlived the call: ${TMUX_TMPDIR}"

# The human's run with TMUX pointing at the second tmux server, for this call only.
mark="$(ad_shim_mark)"
TMUX="${SECOND_TMUX}" ad_capture find-missing
harness_find_missing "${STEP}: TMUX=${SECOND_TMUX}" "${mark}"
[[ -z "${TMUX:-}" ]] || fail "${STEP}: TMUX outlived the call: ${TMUX}"

expect_status "${STEP}: after both runs" waiting
expect_worker_runs "${STEP}: after both runs"

echo "${TEST_NAME}: ${STEP}: holding $(( RECHECK_S + HOLD_EXTRA_S ))s (one re-check interval and ${HOLD_EXTRA_S}s)"
sleep "$(( RECHECK_S + HOLD_EXTRA_S ))"
for verb in resume spawn kill read-pane send-keys; do
    n="$(cscb_ad_count_between "${MARK_A}" - "${verb}" "--claude-instance-id ${INSTANCE_ID}")"
    [[ "${n}" == 0 ]] || fail "${STEP}: a CSCB process made ${n} ${verb} call(s) for ${INSTANCE_ID} after part A"
done
n="$(cscb_ad_count_between "${MARK_A}" - find-missing)"
[[ "${n}" == 0 ]] || fail "${STEP}: a CSCB process made ${n} find-missing call(s) after part A"
n="$(post_count 0)"
[[ "${n}" == 0 ]] || fail "${STEP}: the Slack record holds ${n} post(s) for ${PERSONA_NAME}"
n="$(count_log "${LATCH_ANY}")"
[[ "${n}" == 0 ]] || fail "${STEP}: server.log holds ${n} latch line(s) for ${PERSONA_KEY}"
expect_status "${STEP}: after the hold" waiting
expect_worker_runs "${STEP}: after the hold"

# ---------------------------------------------------------------------------
# Leg 3: part B, the store statement, the restart and the own-id latch
# ---------------------------------------------------------------------------

STEP="leg 3 (part B: latch)"
POSTS_B="$(slack_record_mark "${RECORD}")"
created="$("${SCENARIO_REAL_TMUX}" display-message -p -t "=${SESSION_NAME}:" '#{session_created}')" \
    || fail "${STEP}: no session ${SESSION_NAME} on the scenario's tmux server"
wait_s=$(( created + BOUND_S + AGE_MARGIN_S - $(date +%s) ))
if (( wait_s > 0 )); then
    echo "${TEST_NAME}: ${STEP}: waiting ${wait_s}s until session ${SESSION_NAME} is more than ${BOUND_S}s old"
    sleep "${wait_s}"
fi

# The human's one store statement (the harness's only sqlite3 write here).
ENDED_AT="$(ad_store_mark_finished "${INSTANCE_ID}" missing)"
ad_capture status --claude-instance-id "${INSTANCE_ID}"
if (( AD_RC != 0 )) || ! jq -e '.state == "missing" and (has("launch_started_at") | not)' "${AD_OUT}" > /dev/null; then
    fail "${STEP}: after the statement the harness status read answered $(tr '\n' ' ' < "${AD_OUT}") (exit ${AD_RC})"
fi
expect_worker_runs "${STEP}: after the statement"
echo "${TEST_NAME}: ${STEP}: row marked missing, ended_at ${ENDED_AT}"

# The bot server restarted without teardown (ruling S4).
OLD_SERVER_PID="${SERVER_PID}"
LOG_B="$(wc -l < "${SLACK_STATE_DIR}/server.log")"
stop_server
expect_worker_runs "${STEP}: after the plain stop"
start_server --live
[[ "${SERVER_PID}" != "${OLD_SERVER_PID}" ]] || fail "${STEP}: the restart kept bot server ${SERVER_PID}"
wait_for_log "${LATCH_OWN_ID}" "${LATCH_WAIT_S}" "${STEP}: ${PERSONA_KEY} never latched on '${OWN_ID_PHRASE}'"

# The new bot server's resume met the own-id CONFLICT; any still-stopping or
# still-starting UNAVAILABLE came first.
out="$(cscb_ad_calls resume "--claude-instance-id ${INSTANCE_ID}")"
lines=()
[[ -z "${out}" ]] || mapfile -t lines <<< "${out}"
n=0
for line in ${lines[@]+"${lines[@]}"}; do
    [[ "$(cut -f4 <<< "${line}")" == "${SERVER_PID}" ]] && n=$(( n + 1 ))
done
(( n >= 1 )) || fail "${STEP}: the new bot server ${SERVER_PID} made no resume for ${INSTANCE_ID}"
conflict_line="$(first_log_line "${OWN_ID_PHRASE}")"
(( conflict_line > LOG_B )) || fail "${STEP}: '${OWN_ID_PHRASE}' first shows at server.log line ${conflict_line}, before the restart (line ${LOG_B})"
for phrase in "${STOPPING_PHRASE}" "${STARTING_PHRASE}"; do
    last="$(last_log_line "${phrase}")"
    if [[ -n "${last}" ]]; then
        (( last < conflict_line )) \
            || fail "${STEP}: an UNAVAILABLE line carrying '${phrase}' (line ${last}) comes after the CONFLICT (line ${conflict_line})"
        echo "${TEST_NAME}: ${STEP}: UNAVAILABLE '${phrase}' $(count_log "${phrase}") time(s) before the CONFLICT"
    fi
done
echo "${TEST_NAME}: ${STEP}: ${n} resume(s) by the new bot server before the latch"

# One latch post, with the CONFLICT notice's CSCB-authored parts and no
# session-ending command.
wait_until "${POST_WAIT_S}" "${STEP}: no post for ${PERSONA_NAME} after the latch" posts_at_least "${POSTS_B}" 1
sleep "${SETTLE_S}"
n="$(post_count "${POSTS_B}")"
[[ "${n}" == 1 ]] || fail "${STEP}: ${n} posts for ${PERSONA_NAME} after the latch, not 1"
LATCH_POST="$(post_text "${POSTS_B}" 1)"
LATCH_POST="${LATCH_POST%x}"
# The session name between double quotes (src/conflict-latch.ts slackQuotedSession).
expect_in_order "${STEP}: the latch post" "${LATCH_POST}" \
    "${NOTICE_HEAD}\"${SESSION_NAME}\"" "${OWN_ID_SENTENCE}" "${NOTICE_POINTER}" "${NOTICE_HUMAN_ONLY}"
[[ "${LATCH_POST}" == "${NOTICE_HEAD}"* ]] || fail "${STEP}: the latch post does not open with the persona prefix and the notice's head"
forms="$(printf '%s' "${LATCH_POST}" | bun "${SCENARIO_FIXTURES}/fmk-texts.ts" sessionEndingCommandsIn)" \
    || fail "${STEP}: fmk-texts could not read the latch post"
[[ -z "${forms}" ]] || fail "${STEP}: the latch post's own lines name a session-ending command: ${forms//$'\n'/, }"

# ---------------------------------------------------------------------------
# Leg 4: the held latch, two re-checks of one status and one one-line read-pane
# ---------------------------------------------------------------------------

STEP="leg 4 (held latch)"
mark="$(ad_shim_mark)"
MARK_LATCH="${mark}"
for round in $(seq 1 "${HELD_RECHECKS}"); do
    wait_until "$(( RECHECK_S + RECHECK_ALLOWANCE_S ))" "${STEP}: re-check ${round} made no read-pane" \
        shim_line_after "${mark}" read-pane
    sleep "${SETTLE_S}"
    next="$(ad_shim_mark)"
    window_calls "${STEP}: re-check ${round}" "${mark}" "${next}"
    expect_window "${STEP}: re-check ${round}" status read-pane
    wait_for_count "${ROUND_HELD}" "${round}" "${SETTLE_S}" "${STEP}: re-check ${round} logged no held probe"
    n="$(post_count "${POSTS_B}")"
    [[ "${n}" == 1 ]] || fail "${STEP}: re-check ${round}: ${n} posts for ${PERSONA_NAME} since part B, not 1"
    expect_worker_runs "${STEP}: re-check ${round}"
    row_reads missing || fail "${STEP}: re-check ${round}: the row no longer reads missing"
    echo "${TEST_NAME}: ${STEP}: re-check ${round} held (status, read-pane --n-lines ${PROBE_LINES})"
    mark="${next}"
done
MARK_HELD="${mark}"

# ---------------------------------------------------------------------------
# Leg 5: the human's finished-row kill
# ---------------------------------------------------------------------------

STEP="leg 5 (finished-row kill)"
before="$(row_json "${STEP}")"
ad_kill_include_finished "${INSTANCE_ID}" > /dev/null
jq -e '.kill_sent == true' "${AD_KILL_OUT}" > /dev/null \
    || fail "${STEP}: the kill answered $(tr '\n' ' ' < "${AD_KILL_OUT}"), not kill_sent true"
wait_until "${KILL_END_WAIT_S}" "${STEP}: session ${SESSION_NAME} outlived the kill" no_session "${SESSION_NAME}"
wait_until "${KILL_END_WAIT_S}" "${STEP}: the worker outlived the kill" worker_gone
after="$(row_json "${STEP}")"
for column in state ended_at row_version; do
    [[ "$(jq -c --arg c "${column}" '.[$c]' <<< "${after}")" == "$(jq -c --arg c "${column}" '.[$c]' <<< "${before}")" ]] \
        || fail "${STEP}: the kill changed the row's ${column}: $(jq -c --arg c "${column}" '.[$c]' <<< "${before}") -> $(jq -c --arg c "${column}" '.[$c]' <<< "${after}")"
done
echo "${TEST_NAME}: ${STEP}: kill-finished answered $(jq -c '.' "${AD_KILL_OUT}")"

# ---------------------------------------------------------------------------
# Leg 6: the cleared probe, one find-missing and one resume, one recovery post
# ---------------------------------------------------------------------------

STEP="leg 6 (cleared probe)"
wait_until "$(( RECHECK_S + RECHECK_ALLOWANCE_S ))" "${STEP}: no resume after the kill" \
    shim_line_after "${MARK_HELD}" resume
window_calls "${STEP}" "${MARK_HELD}" -
for i in "${!WIN_VERBS[@]}"; do
    if [[ "${WIN_VERBS[i]}" == resume ]]; then
        WIN_VERBS=("${WIN_VERBS[@]:0:i+1}")
        WIN_ARGS=("${WIN_ARGS[@]:0:i+1}")
        WIN_PPIDS=("${WIN_PPIDS[@]:0:i+1}")
        break
    fi
done
expect_window "${STEP}: from the second re-check to its resume" status read-pane find-missing resume
wait_for_log "${ROUND_CLEARED}" "${POST_WAIT_S}" "${STEP}: the round logged no probe cleared on ${READ_GONE}"
wait_until "${REPORT_WAIT_S}" "${STEP}: the resumed row never reported in (waiting)" row_reads waiting
expect_status "${STEP}" waiting
wait_until "${POST_WAIT_S}" "${STEP}: no recovery post" posts_at_least "${POSTS_B}" 2
sleep "${SETTLE_S}"
n="$(post_count "${POSTS_B}")"
[[ "${n}" == 2 ]] || fail "${STEP}: ${n} posts for ${PERSONA_NAME} in part B, not 2"
got="$(post_text "${POSTS_B}" 2)"
got="${got%x}"
[[ "${got}" == "${RECOVERY_POST}" ]] \
    || fail "${STEP}: the recovery post reads '${got}', not '${RECOVERY_POST}'"

# ---------------------------------------------------------------------------
# Leg 7: close
# ---------------------------------------------------------------------------

STEP="leg 7 (close)"
mapfile -t lines < "${SCENARIO_AD_SHIM_LOG}"
kills=0
for line in "${lines[@]}"; do
    _scenario_split_line "${line}" && [[ "${_L_KIND}" == call ]] || continue
    _scenario_decode_words || fail "${STEP}: a shim log line does not parse: ${line}"
    _scenario_finished_kill_words || continue
    kills=$(( kills + 1 ))
    [[ "${_L_PPID}" == "$$" && "${_L_PARENT}" == "${SCENARIO_SHELL_CMDLINE}" ]] \
        || fail "${STEP}: a finished-row kill's parent is ${_L_PPID}, not the scenario's shell $$: ${line}"
done
(( kills == 1 )) || fail "${STEP}: the shim's log holds ${kills} finished-row kill(s), not the harness's one"
n="$(cscb_ad_count kill)"
[[ "${n}" == 0 ]] || fail "${STEP}: a CSCB process made ${n} kill call(s)"
n="$(cscb_ad_count_between "${MARK_LATCH}" - spawn)"
[[ "${n}" == 0 ]] || fail "${STEP}: a CSCB process made ${n} spawn call(s) from the latch on"

stop_server --stop-bots
stop_tracked_pid "${SLACK_STUB_PID}" 10 "${STEP}: the Slack stub did not exit on SIGTERM"

assert_no_server_tmux
assert_no_cscb_include_finished
assert_no_cscb_delete
echo "PASS: ${TEST_NAME}"
