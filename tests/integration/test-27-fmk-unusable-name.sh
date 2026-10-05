#!/usr/bin/env bash
# Test 27 (HO §7 scenario 25; b.jg5 SRJ-1427, SRJ-512, SRJ-1019, SRJ-1005,
# SRJ-505, SRJ-104, SRJ-1401; AC 85): an unusable recorded session name.
#
# Persona `unusable` (U) has a finished row whose recorded tmux session name
# the harness hand-edits to hold a `.`, which tmux stores differently, so
# agent-director will not pass it to tmux. U's `resume`, and a reuse spawn
# forced through fixtures/fmk-driver.ts, get `ErrUnknownErrorName` with
# `unknownName` "ErrInternal" and a description naming the recorded tmux
# session name; U latches ("unusable recorded name") with one post that names
# the persona and its instance id, quotes the description, points to
# "Operator actions" and names no command. CSCB then makes no delete, kill,
# spawn, `resume`, pane verb or tmux call for U and counts nothing; each
# re-check is one `status`. The harness then plays the human's last
# procedure step, the removal of the row, and the next re-check's `status`
# gets `ErrSpawnNotFound`: the latch clears with one "Hold cleared" post and
# U comes up fresh. Beside it, another caller's live row with no recorded
# process and an unusable name gets agent-director's
# `tmux_session_name_rewritten` note from a CSCB `find-missing`, and CSCB
# ignores it.
#
# The `delete` is the harness playing the human's last procedure step (the
# "Operator actions" section of agent-director's README ends with removing
# the row), made from the scenario's own shell through scenario.sh's
# `ad_delete_unusable_row` (agent-director-admin's `delete`). This is the one
# fmk script whose agent-director shim log holds a `delete`;
# `assert_no_cscb_delete` still holds, because it counts only lines whose
# parent is a CSCB process.
#
# The fmk set-up (lib/scenario.sh, fmk mode: TEST_NAME carries `-fmk-`):
# - its own HOME, agent-director store and tmux server under SCENARIO_ROOT;
#   the release installed through its install.sh, behind the agent-director
#   shim (agent-director-admin too); agent-director's default settings (no
#   config.toml);
# - the tmux shim first on every CSCB process's PATH, in `log` mode
#   throughout;
# - the stub as `claude`: in `dev-channels` (no selection, the default) in
#   U's working directory, where it prints the dev-channels dialog and reports
#   in only on Enter (CSCB's approver); in `silent` in the other caller's
#   working directory, where it never reports in and opens no MCP session;
# - the live server against the Slack stub (fixtures/slack-stub-server.ts
#   with `--record`; posts are read from that record with `slack_posts`), one
#   persona `unusable` (key `unusable`), `health_check_interval` 0, in one
#   state dir for both lives (the configuration does not change).
# The harness runs no `find-missing` anywhere in this script (SRJ-1401): the
# only `find-missing` runs are CSCB's.
#
# Steps, in run order. Steps marked [harness] are the harness playing a human
# from the scenario's own shell; no CSCB process makes them.
#   1. First life: the live start spawns U fresh; the approver clears the
#      dialog (a bot-server `send-keys` of U's row); a harness `get` reads the
#      row `waiting`, its tmux session name the package's
#      (`personaTmuxSessionName`); its claude_session_id is recorded.
#      [harness] The human ends U's worker as a human ends Claude Code: the
#      stub's exit line typed into its pane with the real tmux
#      (`__CSCB_TEST_EXIT__`, fixtures/stub-claude.sh), which fires its
#      SessionEnd hooks, so agent-director marks the row `ended` and the
#      session ends (a teardown's `kill` would end the stub with no SessionEnd
#      and leave the row reading `waiting`, and 0.11.0's `kill` changes no
#      row's state). Then `stop --stop-bots`, at once (the disconnect's
#      restart waits `session_restart_delay`): the row reads `ended` or
#      `missing` with the same claude_session_id, the session is gone, and no
#      CSCB `resume` or `spawn` of the row followed the exit.
#   2. [harness] With the server stopped:
#      - E39's scenario 25 statement (`ad_store_unusable_name`): U's row's
#        tmux_session_name becomes `<U's session name>.x`, nothing else
#        changing;
#      - the other caller's row (SRJ-1427 bullet 2): a harness `spawn`
#        (`ad_capture`, from the scenario's shell) of instance id
#        `<SCENARIO_TAG>_other`, outside CSCB's namespace, with no label at all
#        (so no `service=cscb` label, which the start sweep would read as a
#        CSCB row to kill, SRJ-714), in a working directory of its own whose
#        stub is `silent`; the row reads `pending` and its pane runs the stub.
#        Then one script-local `ad_store_edit` UPDATE (other_row_unusable;
#        lib/scenario.sh's store-statement rules: named by its id, its
#        `pending` state and its row_version as read just before) makes it a
#        live row with no recorded process and an unusable name: state
#        `waiting` (with no launch start, as a row that reported in has),
#        pid, proc_starttime, pane_pid and pane_starttime NULL,
#        tmux_session_name `<SCENARIO_TAG>_other.x`, row_version + 1; a store
#        read after it shows every other column unchanged, and a harness `get`
#        reads it `waiting` with no liveness note. The shim's position is
#        marked here (the seeding mark).
#   3. Second life (the live start, its start pass waited for):
#      a. U's latch: server.log holds the latch-set line
#         (`conflictLatchSetLine`: case "unusable recorded name", the session
#         `<U's session name>.x` quoted in agent-director's description,
#         refused operation `none`, the state step 1 recorded), once, and the
#         server's UNUSABLE NAME line for U (`refused for <ref>: ErrInternal
#         message="…<the phrase>…" — UNUSABLE NAME: `), once; the shim marks
#         are then taken (the latch marks); the bot server's calls of U's row
#         from the second life's start to the latch are recorded (the
#         bring-up ladder's plain spawn, which the existing row refuses as a
#         collision, and its `get` come first); among them is exactly one
#         `resume`, the bot server's, and no reuse spawn (a `spawn` carrying
#         `--reuse-finished`), `kill`, `kill-finished` or `delete`; the start
#         pass's completion line counts `0 failed` and `1 latched`;
#      b. exactly one post on U's channel since the second life began, the
#         unusable-name notice: the persona prefix, then
#         `unusableNameNoticeText`'s text for U's key around the quoted
#         description (its fixed parts name `cscb_<key>` and point to
#         "Operator actions"), the description holding the unusable-name
#         phrase and the unusable name; so the post names no command;
#      c. [harness] the forced reuse spawn: fixtures/fmk-driver.ts
#         `reuse-spawn`, through `cscb_run`, prints one outcome line with
#         `called=true`, `counted=false`, `error=ErrUnknownErrorName`, CSCB's
#         class for an unusable name, `unknown_name=ErrInternal` and a
#         description holding the phrase and the unusable name; its only
#         agent-director call naming U's row is one `spawn` carrying
#         `--reuse-finished`, parented by the driver; the store row is the
#         same before and after it;
#      d. STATUS_ROUNDS (2) re-check rounds: each round line
#         (`latchRecheckRoundLine`, step `step-2`, call `none`, answer
#         `still-latched`) is waited for; the bot server's calls of U's row
#         after the latch mark are exactly one `status` per round and nothing
#         else (no delete, kill, spawn, `resume` or pane verb), the driver's
#         one reuse spawn its only other CSCB call of U's row and no call of
#         it from any other process; the first `status` at least one interval
#         (LATCH_RECHECK_INTERVAL_MS) after the refused `resume` and within the
#         interval plus SETTLE_S, each next one at least one interval after the
#         previous and within the interval plus SETTLE_S; the latch-set line is
#         still logged once and no relatch line is logged; the channel holds no
#         new post;
#      e. the tmux shim's log holds no line from the latch mark to the
#         harness's `delete`: the harness's own calls use the real tmux, so
#         any such line would be CSCB's; no tmux command CSCB caused names U's
#         session name or its unusable name from the second life's start to
#         the `delete` (`tmux_shim_targets`);
#      f. nothing counted: server.log holds no counted launch-failure line for
#         U, and no post on U's channel holds a spawn-failure notice;
#      g. [harness] the human's last procedure step: `ad_delete_unusable_row`
#         of U's row (agent-director-admin's `delete`, from the scenario's own
#         shell; it refuses unless the recorded name holds the `.`, and checks
#         the id reported `ok` and the row gone);
#      h. the next round: its line (`latchRecheckRoundLine`, step
#         `clear-gone`, call `none`) is waited for within the interval plus
#         twice SETTLE_S; its `status`, the bot server's first call of U's row
#         after the `delete`, comes at the cadence; it got `ErrSpawnNotFound`:
#         the clear line (`latchClearedLine`, reason "its agent-director row is
#         gone", posted), once; exactly one post holds the hold-recovery head,
#         and it equals the printed notice (`holdRecoveryText`,
#         LATCH_RECOVERY_REASON_ROW_GONE);
#      i. U comes up fresh: the row reads `waiting` on a new
#         claude_session_id and the package's session name; the server
#         registers the stub's MCP session; the bot server's calls of U's row
#         after the `delete` hold exactly one `spawn`, with no
#         `--reuse-finished` (a plain spawn), and no `resume`, `kill`,
#         `kill-finished` or `delete`; a CSCB `find-missing` lies between the
#         clearing round's `status` and that spawn (the step-1 clear's one
#         bypassing run); U's channel holds exactly the notice and the
#         recovery post from the second life on, neither a CONFLICT nor a
#         launch-start notice.
#   4. The other caller's row (SRJ-1427 bullet 2), checked after U's clear:
#      - positive control: a CSCB `find-missing` came after the seeding mark
#        (the first one is recorded; the step-1 clear's run, at the latest);
#      - the harness's `get` of the row shows the `tmux_session_name_rewritten`
#        note, the row still `waiting` with its unusable name;
#      - no CSCB-parented call names the row's instance id or its session
#        names (`cscb_ad_count`; positive control: CSCB calls name U's id);
#      - no conflict-latch line in server.log names it, and no post in the
#        Slack stub's record holds it.
#   5. [harness] The human ends U's fresh worker with the stub's exit line, so
#      the closing `stop --stop-bots` pauses no live stub (a pause of the
#      stub, which ignores the `/exit` it types, waits out its 30 s timeout);
#      then `stop --stop-bots`. U's row is present at the end, with the fresh
#      claude_session_id; the agent-director shim's log holds exactly one
#      `delete` call line, parented by the scenario's own shell (its PID and
#      command line) and by no CSCB process.
#   6. The three closing assertions.
#
# Waits and their derivation (seconds): STUB_WAIT_S (20) for the Slack
# stub's ready file; START_WAIT_S (120) per start pass (one bring-up, one
# launch call), and for U's fresh bring-up after the clear (the step-1
# clear's `find-missing`, a plain spawn and the approver's Enter); REPORT_WAIT_S
# (60) for the approver's Enter (it reads the pane every lap, about 1 s apart)
# and the stub's report-in; CONNECT_WAIT_S (30) for the server to register
# the stub's MCP session; EXIT_WAIT_S (30) for the stub's SessionEnd hooks
# and its session's end after the exit line; NOTICE_WAIT_S (30) for a post
# after the line that causes it; OTHER_WAIT_S (10) for the other caller's
# pane process to become the stub. The re-check interval is
# fixtures/fmk-texts.ts's LATCH_RECHECK_INTERVAL_MS (120 s). SETTLE_S (30) is
# the stated settle: a round's own call (one `status`, one agent-director
# process, a few seconds at most), the timer's start after the previous round
# settled, and the shim's process start. Each round's `status` is held to the
# interval plus SETTLE_S after the previous point; each round line is waited
# for within the interval plus twice SETTLE_S from the previous check.
# Expected runtime: about 8 minutes (the first life and the seeding under a
# minute, three rounds about 6 minutes, the fresh bring-up under a minute).
#
# Matched values. CSCB's values come from fixtures/fmk-texts.ts, printed from
# the installed package, never retyped:
# - personaInstanceId and personaTmuxSessionName (src/persona-identity.ts);
#   personaNoticePrefix and formatPersonaNotice (src/persona-notifier.ts);
# - from src/conflict-latch.ts: LATCH_CASE_UNUSABLE_RECORDED_NAME,
#   REFUSED_OPERATION_NONE, RECHECK_STEP_TABLE, RECHECK_STEP_CLEAR_GONE,
#   RECHECK_CALL_NONE, LATCH_RECHECK_INTERVAL_MS, UNUSABLE_NAME_NOTICE_HEAD,
#   UNUSABLE_NAME_NOTICE_POINTER, HOLD_RECOVERY_HEAD,
#   CONFLICT_NOTICE_FIRST_LINE_HEAD, LAUNCH_START_NOTICE_HEAD, and the
#   builders unusableNameNoticeText (with a placeholder description, split
#   there into the text before and after it), holdRecoveryText,
#   conflictLatchSetLine (whole, and cut before its `case=` for the count of
#   latch-set lines; with a previous case, cut before its ` — `, for the
#   relatch line), latchClearedLine and latchRecheckRoundLine (whole for the
#   refused rounds; cut before its `step=` for every round line of U; cut
#   before its answer for the clearing round);
# - UNUSABLE_RECORDED_NAME_PHRASE (src/ad-description-phrases.ts);
# - AD_ERROR_CLASS_UNUSABLE_NAME (src/ad-error-class.ts).
# Fragments with no exported builder, each quoted from its source:
# - `[slack] Session connected: persona <ref>` (src/server.ts, the MCP
#   session's registration line);
# - the round answer `still-latched` (src/session-manager.ts
#   runLatchRecheckRound's answerAfter, for a round that left the persona
#   latched);
# - the UNUSABLE NAME line's ` refused for <ref>: `, `message="` and
#   ` — UNUSABLE NAME: ` (src/session-manager.ts logUnusableName, the
#   reported name and message as src/ad-error-class.ts
#   describeReportedAdFailure renders them);
# - the counted launch-failure lines `[slack] Launch failed for persona=<key>`
#   and `[slack] Session relaunch failed for persona=<key>` (src/restart.ts
#   recordLaunchResultOutsideRestartWork and the restart work's
#   countLaunchFailure), and the spawn-failure notice's first line
#   `Spawn failure:` (src/session-manager.ts spawnFailureNoticeText);
# - the persona reference `"<name>" (key=<key>)` (lib/scenario.sh
#   persona_ref, src/persona-identity.ts renderPersonaRef);
# - "Operator actions", the README section SRJ-1019's post points to;
# - fixtures/fmk-driver.ts's outcome line fields (its header);
# - `--reuse-finished`, the agent-director client's flag for a spawn's
#   reuse_finished (the agent-director 0.11.0 npm client), and its error
#   names `ErrUnknownErrorName` and the `unknownName` "ErrInternal";
# - agent-director's note `tmux_session_name_rewritten` (agent-director
#   0.11.0, pkg/api/find_missing.go) and its row states `pending`, `waiting`,
#   `ended` and `missing`.
#
# Closing: the script ends with `assert_no_server_tmux`,
# `assert_no_cscb_include_finished` and `assert_no_cscb_delete` in its own
# shell. Every count of CSCB's agent-director calls reads only shim lines
# whose parent is a CSCB process; no step reads a pane's text.
set -euo pipefail

TEST_NAME="test-27-fmk-unusable-name"
# shellcheck source=lib/scenario.sh
source "$(dirname "$0")/lib/scenario.sh"

# Persona U and its channel.
U_NAME="unusable"
U_KEY="$(persona_key "${U_NAME}")"
U_REF="$(persona_ref "${U_NAME}")"
U_CHANNEL="C0T27UN01"
TOKEN_LABEL="t27unusable"

# The other caller's row: an instance id outside CSCB's namespace, and its
# session names (the one it is spawned in, and the unusable one the statement
# records).
OTHER_ID="${SCENARIO_TAG}_other"
OTHER_SESSION="${SCENARIO_TAG}_other"
OTHER_UNUSABLE="${OTHER_SESSION}.x"

# Bounds (seconds; see the header).
STUB_WAIT_S=20
START_WAIT_S=120
REPORT_WAIT_S=60
CONNECT_WAIT_S=30
EXIT_WAIT_S=30
NOTICE_WAIT_S=30
OTHER_WAIT_S=10
SETTLE_S=30

# U's status-only rounds before the harness's delete.
STATUS_ROUNDS=2

FMK_TEXTS="${SCENARIO_FIXTURES}/fmk-texts.ts"

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

# fmk_text <entry> [<arg>...]: print fixtures/fmk-texts.ts's value.
fmk_text() {
    bun --no-install "${FMK_TEXTS}" "$@"
}

# rows_count <text>: print how many lines <text> holds (0 when empty).
rows_count() {
    if [[ -z "$1" ]]; then
        echo 0
        return 0
    fi
    wc -l <<< "$1" | tr -d ' '
}

# field_of <n> <rows>: print field <n> of each TAB-separated row.
field_of() {
    [[ -z "$2" ]] || cut -f "$1" <<< "$2"
}

# server_rows <pid> <rows>: print the rows whose ppid (field 3) is <pid>.
server_rows() {
    [[ -z "$2" ]] || awk -F'\t' -v p="$1" '$3 == p' <<< "$2"
}

# verb_rows <verb> <rows>: print the rows whose verb (field 4) is <verb>.
verb_rows() {
    [[ -z "$2" ]] || awk -F'\t' -v v="$1" '$4 == v' <<< "$2"
}

# us_of <time>: a shim time (seconds, six decimals) in microseconds.
us_of() {
    [[ "$1" =~ ^[0-9]+\.[0-9]{6}$ ]] || fail "us_of: '$1' is not a shim time"
    echo $(( 10#${1/./} ))
}

# secs_of <us>: microseconds as seconds with three decimals (for messages).
secs_of() {
    printf '%d.%03d' $(( $1 / 1000000 )) $(( ($1 % 1000000) / 1000 ))
}

# start_slack_stub <dir> <suffix>: start the Slack stub in a new <dir>,
# answering ok for the token pair ending in <suffix> and refusing any other;
# wait for its ready file; export CSCB_SLACK_API_URL; set SLACK_STUB_PID and
# SCENARIO_SLACK_RECORD (slack_posts' default record).
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
    SCENARIO_SLACK_RECORD="${dir}/record.jsonl"
    (cd "${dir}" && exec bun "${SCENARIO_FIXTURES}/slack-stub-server.ts" --record "${SCENARIO_SLACK_RECORD}" \
        --control "${dir}/control.json" --ready-file "${dir}/ready.json") > "${dir}/stub.out" 2>&1 &
    SLACK_STUB_PID=$!
    track_pid "${SLACK_STUB_PID}"
    wait_for_file "${dir}/ready.json" "${STUB_WAIT_S}" "${step}: the Slack stub never wrote its ready file"
    api_url="$(jq -r '.api_url' "${dir}/ready.json")"
    [[ "${api_url}" =~ ^http://127\.0\.0\.1:[0-9]+/api/$ ]] || fail "${step}: the stub's api_url '${api_url}' is not loopback"
    export CSCB_SLACK_API_URL="${api_url}"
}

# read_row <step> <instance-id>: a harness `get` of the row. Sets ROW_STATE,
# ROW_SID (claude_session_id), ROW_SESSION (tmux_session_name) and ROW_NOTE
# (liveness_note), each empty when absent.
read_row() {
    local fields
    ad_capture get --claude-instance-id "$2"
    (( AD_RC == 0 )) || fail "$1: the harness get of $2 exited ${AD_RC}: $(head -c 300 "${AD_ERR}")"
    fields="$(jq -r '[.state // "", .claude_session_id // "", .tmux_session_name // "", .liveness_note // ""] | join("\u001f")' "${AD_OUT}")" \
        || fail "$1: the harness get of $2 printed no row object: $(head -c 300 "${AD_OUT}")"
    IFS=$'\x1f' read -r ROW_STATE ROW_SID ROW_SESSION ROW_NOTE <<< "${fields}"
}

# row_reads <step> <instance-id> <state>...: read the row; true when its
# state is one of the <state>s.
row_reads() {
    local step="$1" id="$2" s
    shift 2
    read_row "${step}" "${id}"
    for s in "$@"; do
        [[ "${ROW_STATE}" == "${s}" ]] && return 0
    done
    return 1
}

# wait_row <step> <timeout-s> <instance-id> <state>...: read the row until
# its state is one of the <state>s; fail, naming the last state read, when
# it is not within <timeout-s>.
wait_row() {
    local step="$1" timeout_s="$2" id="$3" deadline
    shift 3
    deadline=$(( SECONDS + timeout_s ))
    until row_reads "${step}" "${id}" "$@"; do
        (( SECONDS < deadline )) \
            || fail "${step}: row ${id} never read $* (not within ${timeout_s}s; last read '${ROW_STATE}')"
        sleep "${SCENARIO_POLL_S}"
    done
}

# fresh_row_waiting <step>: true once the store holds U's row again and a
# harness `get` reads it `waiting` (the row is absent from the delete until
# the fresh spawn writes it, when `get` would fail).
fresh_row_waiting() {
    local n
    n="$(_scenario_store_read "$1" "SELECT COUNT(*) FROM spawns WHERE claude_instance_id = '${U_ID}'")" || exit 1
    [[ "${n}" == 1 ]] || return 1
    row_reads "$1" "${U_ID}" waiting
}

# True when the scenario's tmux server holds a session named exactly <name>
# (asked with the real tmux).
has_session() {
    "${SCENARIO_REAL_TMUX}" has-session -t "=$1" 2> /dev/null
}

# True while the scenario's tmux server holds no session named exactly <name>.
session_gone() {
    ! has_session "$1"
}

# True when <pid> runs the scenario's stub `claude`.
stub_running() {
    grep -qzxF -- "${SCENARIO_BIN}/claude" "/proc/$1/cmdline" 2> /dev/null
}

# posts_of <file>: write the posts on U's channel to <file> and set POSTS to
# them (one element per post, in record order).
posts_of() {
    slack_posts "${U_CHANNEL}" > "$1"
    POSTS=()
    mapfile -d '' -t POSTS < "$1"
}

# post_count: print how many posts U's channel holds.
post_count() {
    posts_of "${SCENARIO_ROOT}/posts-count.bin"
    echo "${#POSTS[@]}"
}

# posts_holding <from-index> <text>: set HOLDING to the posts on U's channel
# from index <from-index> on that hold <text>.
posts_holding() {
    local i
    posts_of "${SCENARIO_ROOT}/posts-holding.bin"
    HOLDING=()
    for (( i = $1; i < ${#POSTS[@]}; i++ )); do
        [[ "${POSTS[i]}" != *"$2"* ]] || HOLDING+=("${POSTS[i]}")
    done
}

# posts_holding_at_least <from-index> <text> <n>: true once at least <n>
# posts from <from-index> on hold <text>.
posts_holding_at_least() {
    posts_holding "$1" "$2"
    (( ${#HOLDING[@]} >= $3 ))
}

# record_posts_naming <text>: print how many chat.postMessage calls in the
# Slack stub's record, on any channel, hold <text>.
record_posts_naming() {
    jq -s --arg t "$1" '[.[] | select(.event == "api" and .method == "chat.postMessage" and ((.text // "") | contains($t)))] | length' \
        "${SCENARIO_SLACK_RECORD}" || fail "record_posts_naming: jq could not read ${SCENARIO_SLACK_RECORD}"
}

# end_worker <step> <session> [harness]: the human ends U's worker as a human
# ends Claude Code (the stub's exit line typed into its pane with the real
# tmux), so agent-director marks the row ended and the session ends.
end_worker() {
    local step="$1" session="$2"
    "${SCENARIO_REAL_TMUX}" send-keys -t "=${session}:" -l __CSCB_TEST_EXIT__ \
        || fail "${step}: could not type the stub's exit line into ${session}"
    "${SCENARIO_REAL_TMUX}" send-keys -t "=${session}:" Enter || fail "${step}: could not send Enter into ${session}"
    wait_row "${step}" "${EXIT_WAIT_S}" "${U_ID}" ended missing
    wait_until "${EXIT_WAIT_S}" "${step}: session ${session} is still there after the worker's exit" session_gone "${session}"
}

# check_cadence <step> <previous-us> <status-us>: fail unless the round's
# status comes at least one interval after <previous-us> and within the
# interval plus SETTLE_S.
check_cadence() {
    local step="$1" gap
    gap=$(( $3 - $2 ))
    (( gap >= INTERVAL_US )) \
        || fail "${step}: the round's status came $(secs_of "${gap}") s after the previous point, less than the ${INTERVAL_S} s interval"
    (( gap <= INTERVAL_US + SETTLE_S * 1000000 )) \
        || fail "${step}: the round's status came $(secs_of "${gap}") s after the previous point, more than the ${INTERVAL_S} s interval plus the ${SETTLE_S} s settle"
    echo "${TEST_NAME}: ${step}: status $(secs_of "${gap}") s after the previous point"
}

# status_rounds <step> <from-mark> [<to-mark>]: U's status-only rounds, from
# E42 T1's reader (`ad_cscb_calls`): every CSCB-parented call of U's row after
# <from-mark> (up to <to-mark>) must be the bot server's `status`, or the
# driver's (checked in step 3c); fails on any other verb from the bot server
# and on a call from any other CSCB process. Prints one line per `status`,
# `<position> <us>`.
status_rounds() {
    local step="$1" from="$2" to="${3:--}" rows pos time ppid verb
    rows="$(ad_cscb_calls "${U_ID}" "${from}" "${to}")"
    [[ -n "${rows}" ]] || return 0
    while IFS=$'\t' read -r pos time ppid verb _; do
        if [[ -n "${DRIVER_PID:-}" && "${ppid}" == "${DRIVER_PID}" ]]; then
            continue
        fi
        if [[ "${ppid}" != "${LIFE2_PID}" || "${verb}" != status ]]; then
            sed 's/^/  | /' <<< "${rows}" >&2
            fail "${step}: CSCB call ${verb} of ${U_ID} at shim line ${pos} from ${ppid}; after the latch only the bot server's (${LIFE2_PID}) status rounds may name the row"
        fi
        printf '%s %s\n' "${pos}" "$(us_of "${time}")"
    done <<< "${rows}"
}

# delete_lines: print `<position> TAB <ppid> TAB <cscb|harness>` for every
# `delete` call line in the agent-director shim's whole log (its verb read
# as lib/scenario.sh's readers read it; `cscb` when its parent is a CSCB
# process), with lib/scenario.sh's line readers.
delete_lines() {
    local lines=() i who
    _scenario_query_prep delete_lines
    _scenario_read_log delete_lines "${SCENARIO_AD_SHIM_LOG}" lines
    for i in "${!lines[@]}"; do
        _scenario_split_line "${lines[i]}"
        [[ "${_L_KIND}" == call ]] || continue
        _scenario_decode_words
        _scenario_ad_verb
        [[ "${_L_VERB}" == delete ]] || continue
        who=harness
        if _scenario_role_at "${_L_PPID}" "${_L_US}"; then
            who=cscb
        fi
        printf '%s\t%s\t%s\t%s\n' "$(( i + 1 ))" "${_L_PPID}" "${who}" "${_L_PARENT}"
    done
    return 0
}

# ---------------------------------------------------------------------------
# Values from the installed package
# ---------------------------------------------------------------------------

U_ID="$(fmk_text personaInstanceId "${U_KEY}")" || fail "setup: fmk-texts.ts could not print personaInstanceId"
[[ "${OTHER_ID}" != "${U_ID%"${U_KEY}"}"* ]] || fail "setup: the other caller's id ${OTHER_ID} is inside CSCB's namespace"
U_SESSION="$(fmk_text personaTmuxSessionName "${U_KEY}")" || fail "setup: fmk-texts.ts could not print personaTmuxSessionName"
U_UNUSABLE="${U_SESSION}.x"
INTERVAL_MS="$(fmk_text LATCH_RECHECK_INTERVAL_MS)" || fail "setup: fmk-texts.ts could not print LATCH_RECHECK_INTERVAL_MS"
[[ "${INTERVAL_MS}" =~ ^[1-9][0-9]*$ ]] || fail "setup: LATCH_RECHECK_INTERVAL_MS is '${INTERVAL_MS}'"
INTERVAL_US=$(( INTERVAL_MS * 1000 ))
INTERVAL_S=$(( (INTERVAL_MS + 999) / 1000 ))
(( INTERVAL_S > SETTLE_S )) || fail "setup: the ${SETTLE_S} s settle is not shorter than the ${INTERVAL_S} s re-check interval"
CASE_UNUSABLE="$(fmk_text LATCH_CASE_UNUSABLE_RECORDED_NAME)" || fail "setup: fmk-texts.ts could not print LATCH_CASE_UNUSABLE_RECORDED_NAME"
OP_NONE="$(fmk_text REFUSED_OPERATION_NONE)" || fail "setup: fmk-texts.ts could not print REFUSED_OPERATION_NONE"
STEP_TABLE="$(fmk_text RECHECK_STEP_TABLE)" || fail "setup: fmk-texts.ts could not print RECHECK_STEP_TABLE"
STEP_CLEAR_GONE="$(fmk_text RECHECK_STEP_CLEAR_GONE)" || fail "setup: fmk-texts.ts could not print RECHECK_STEP_CLEAR_GONE"
CALL_NONE="$(fmk_text RECHECK_CALL_NONE)" || fail "setup: fmk-texts.ts could not print RECHECK_CALL_NONE"
UNUSABLE_PHRASE="$(fmk_text UNUSABLE_RECORDED_NAME_PHRASE)" || fail "setup: fmk-texts.ts could not print UNUSABLE_RECORDED_NAME_PHRASE"
UNUSABLE_HEAD="$(fmk_text UNUSABLE_NAME_NOTICE_HEAD)" || fail "setup: fmk-texts.ts could not print UNUSABLE_NAME_NOTICE_HEAD"
UNUSABLE_POINTER="$(fmk_text UNUSABLE_NAME_NOTICE_POINTER)" || fail "setup: fmk-texts.ts could not print UNUSABLE_NAME_NOTICE_POINTER"
HOLD_RECOVERY_HEAD="$(fmk_text HOLD_RECOVERY_HEAD)" || fail "setup: fmk-texts.ts could not print HOLD_RECOVERY_HEAD"
CONFLICT_HEAD="$(fmk_text CONFLICT_NOTICE_FIRST_LINE_HEAD)" || fail "setup: fmk-texts.ts could not print CONFLICT_NOTICE_FIRST_LINE_HEAD"
LAUNCH_START_HEAD="$(fmk_text LAUNCH_START_NOTICE_HEAD)" || fail "setup: fmk-texts.ts could not print LAUNCH_START_NOTICE_HEAD"
CLASS_UNUSABLE="$(fmk_text AD_ERROR_CLASS_UNUSABLE_NAME)" || fail "setup: fmk-texts.ts could not print AD_ERROR_CLASS_UNUSABLE_NAME"
PREFIX="$(fmk_text personaNoticePrefix "${U_NAME}")" || fail "setup: fmk-texts.ts could not print personaNoticePrefix"
[[ -n "${UNUSABLE_PHRASE}" && -n "${UNUSABLE_HEAD}" && -n "${HOLD_RECOVERY_HEAD}" && -n "${CLASS_UNUSABLE}" ]] \
    || fail "setup: fmk-texts.ts printed an empty value"

# The unusable-name notice's text before and after the quoted description,
# built for U's key around a placeholder description.
NOTICE_BODY="$(fmk_text unusableNameNoticeText "${U_KEY}" DESCRIPTIONSLOT)" || fail "setup: fmk-texts.ts could not print unusableNameNoticeText"
[[ "${NOTICE_BODY}" == *DESCRIPTIONSLOT* ]] || fail "setup: the unusable-name notice does not quote its description: ${NOTICE_BODY}"
NOTICE_BEFORE="${PREFIX}${NOTICE_BODY%%DESCRIPTIONSLOT*}"
NOTICE_AFTER="${NOTICE_BODY#*DESCRIPTIONSLOT}"
[[ "${NOTICE_BEFORE}" == "${PREFIX}${UNUSABLE_HEAD}${U_ID}"* ]] \
    || fail "setup: the unusable-name notice does not start with its head and ${U_ID}: ${NOTICE_BODY}"
[[ "${UNUSABLE_POINTER}" == *'"Operator actions"'* && "${NOTICE_AFTER}" == *"${UNUSABLE_POINTER}"* ]] \
    || fail "setup: the unusable-name notice does not point to \"Operator actions\": ${NOTICE_BODY}"

# U's round lines: every round's head, a refused round's whole line, and the
# clearing round's head.
LINE_A="$(fmk_text latchRecheckRoundLine "${U_NAME}" "${CASE_UNUSABLE}" STEPSLOT x x)" \
    || fail "setup: fmk-texts.ts could not print latchRecheckRoundLine"
ROUND_HEAD="${LINE_A%%step=STEPSLOT*}"
[[ "${ROUND_HEAD}" != "${LINE_A}" && "${ROUND_HEAD}" == *"${U_REF}"* ]] || fail "setup: the round line '${LINE_A}' has no step= after U's reference"
ROUND_STILL="$(fmk_text latchRecheckRoundLine "${U_NAME}" "${CASE_UNUSABLE}" "${STEP_TABLE}" "${CALL_NONE}" still-latched)" \
    || fail "setup: fmk-texts.ts could not print latchRecheckRoundLine"
LINE_A="$(fmk_text latchRecheckRoundLine "${U_NAME}" "${CASE_UNUSABLE}" "${STEP_CLEAR_GONE}" "${CALL_NONE}" ANSWERSLOT)" \
    || fail "setup: fmk-texts.ts could not print latchRecheckRoundLine"
ROUND_CLEAR_HEAD="${LINE_A%ANSWERSLOT}"

# U's latch lines: the start every latch-set line for U shares, and a relatch's.
LINE_A="$(fmk_text conflictLatchSetLine "${U_KEY}" "${CASE_UNUSABLE}" SESSIONSLOT "${OP_NONE}" ended)" \
    || fail "setup: fmk-texts.ts could not print conflictLatchSetLine"
LATCH_HEAD="${LINE_A%%case=*}"
LINE_A="$(fmk_text conflictLatchSetLine "${U_KEY}" "${CASE_UNUSABLE}" SESSIONSLOT "${OP_NONE}" ended "${CASE_UNUSABLE}")" \
    || fail "setup: fmk-texts.ts could not print conflictLatchSetLine"
RELATCH_HEAD="${LINE_A%% — *}"
[[ "${LATCH_HEAD}" == *"=${U_KEY} "* && "${RELATCH_HEAD}" == *"=${U_KEY} "* && "${LATCH_HEAD}" != "${RELATCH_HEAD}"* ]] \
    || fail "setup: the latch-set and relatch fragments '${LATCH_HEAD}' and '${RELATCH_HEAD}' do not name U's key apart"
echo "${TEST_NAME}: ${U_ID} in ${U_SESSION}; unusable name ${U_UNUSABLE}; re-check interval ${INTERVAL_MS} ms, settle ${SETTLE_S} s"

# ---------------------------------------------------------------------------
# Scenario 25
# ---------------------------------------------------------------------------

# Step 1: the first life, U's worker ended by hand, then stop --stop-bots.
step_first_life() {
    local step="step 1: first life" creds rows verb n
    creds="${SCENARIO_ROOT}/credentials"
    mkdir -m 700 "${creds}"
    U_WORK="$(make_workdir "${U_KEY}")"
    printf '{"bot_token": "%s", "app_token": "%s"}\n' "$(fake_token bot "${TOKEN_LABEL}")" "$(fake_token app "${TOKEN_LABEL}")" \
        | write_file "${creds}/${U_KEY}.json" 600
    write_config << EOF
{
  "personas": [
    {
      "name": "${U_NAME}",
      "credentials_file": "${creds}/${U_KEY}.json",
      "working_directory": "${U_WORK}",
      "channels": [{ "id": "${U_CHANNEL}", "delivery": "all" }],
      "permission_prompts": "${U_CHANNEL}"
    }
  ],
  "bind": "127.0.0.1",
  "port": ${SCENARIO_PORT},
  "health_check_interval": 0,
  "exit_timeout": 5
}
EOF
    CONNECTED="$(matcher "[slack] Session connected: persona ${U_REF}")"
    start_server --live
    LIFE1_PID="${SERVER_PID}"
    wait_for_count "$(completion_match 1)" 1 "${START_WAIT_S}" "${step}: the start pass never completed"
    expect_completion 1 "${step}" "0 not brought up"
    wait_row "${step}: the report-in" "${REPORT_WAIT_S}" "${U_ID}" waiting
    U_SID="${ROW_SID}"
    [[ -n "${U_SID}" ]] || fail "${step}: the live row ${U_ID} has no claude_session_id"
    [[ "${ROW_SESSION}" == "${U_SESSION}" ]] || fail "${step}: the live row records session '${ROW_SESSION}', not ${U_SESSION}"
    wait_for_count "${CONNECTED}" 1 "${CONNECT_WAIT_S}" "${step}: the server never registered the stub's session as ${U_KEY}'s"
    rows="$(server_rows "${LIFE1_PID}" "$(verb_rows send-keys "$(ad_cscb_calls "${U_ID}")")")"
    (( $(rows_count "${rows}") >= 1 )) || fail "${step}: no bot-server send-keys of ${U_ID} (the approver's Enter)"
    echo "${TEST_NAME}: ${step}: ${U_ID} reads waiting, claude_session_id ${U_SID}, session ${U_SESSION}"

    # [harness] The human ends the worker; then stop --stop-bots.
    EXIT_MARK="$(ad_shim_mark)"
    end_worker "${step}: the worker ended by hand" "${U_SESSION}"
    stop_server --stop-bots
    sed "s/^/${TEST_NAME}: ${step}: stop said: /" "${STOP_OUT}"
    row_reads "${step}" "${U_ID}" ended missing || fail "${step}: ${U_ID} reads '${ROW_STATE}', not ended or missing"
    [[ "${ROW_SID}" == "${U_SID}" ]] || fail "${step}: ${U_ID}'s claude_session_id is '${ROW_SID}', not ${U_SID}"
    ! has_session "${U_SESSION}" || fail "${step}: session ${U_SESSION} is there"
    rows="$(ad_cscb_calls "${U_ID}" "${EXIT_MARK}")"
    for verb in resume spawn; do
        n="$(rows_count "$(verb_rows "${verb}" "${rows}")")"
        (( n == 0 )) || fail "${step}: ${n} CSCB ${verb} call(s) of ${U_ID} after the worker's exit"
    done
    U_FINISHED_STATE="${ROW_STATE}"
    echo "${TEST_NAME}: ${step}: ${U_ID} reads ${U_FINISHED_STATE}; ${U_SESSION} is gone"
}

# Step 2a [harness]: E39's scenario 25 statement on U's finished row.
step_unusable_name() {
    local step="step 2: U's recorded name made unusable"
    [[ -z "$(server_pid)" ]] || fail "${step}: a server is running"
    ad_store_unusable_name "${U_ID}" "${U_UNUSABLE}"
    read_row "${step}" "${U_ID}"
    [[ "${ROW_STATE}" == "${U_FINISHED_STATE}" && "${ROW_SESSION}" == "${U_UNUSABLE}" ]] \
        || fail "${step}: ${U_ID} reads ${ROW_STATE} in '${ROW_SESSION}', not ${U_FINISHED_STATE} in ${U_UNUSABLE}"
    echo "${TEST_NAME}: ${step}: ${U_ID} reads ${ROW_STATE}, recorded session ${ROW_SESSION}"
}

# other_row_unusable <step> [harness]: the other caller's `pending` row made a
# live row with no recorded process and an unusable name, by one
# `ad_store_edit` UPDATE (lib/scenario.sh's store-statement rules): state
# `waiting` and no launch start (a row that reported in records none); pid,
# proc_starttime, pane_pid and pane_starttime NULL (no recorded process, so
# find-missing cannot judge it by one); tmux_session_name OTHER_UNUSABLE;
# row_version + 1; named by its id, its `pending` state and its row_version as
# read just before. The store read after it shows every other column
# unchanged.
other_row_unusable() {
    local step="$1: live, no recorded process, unusable name" before after rv out
    before="$(_scenario_row_json "${step}" "${OTHER_ID}")" || exit 1
    rv="$(jq -r '.[0].row_version' <<< "${before}")"
    [[ "${rv}" =~ ^[0-9]+$ ]] || fail "${step}: the row's row_version reads '${rv}'"
    out="$(ad_store_edit "UPDATE spawns SET state = 'waiting', launch_started_at = NULL, pid = NULL, proc_starttime = NULL, pane_pid = NULL, pane_starttime = NULL, tmux_session_name = '${OTHER_UNUSABLE}', row_version = row_version + 1 WHERE claude_instance_id = '${OTHER_ID}' AND state = 'pending' AND row_version = ${rv} RETURNING claude_instance_id")" \
        || exit 1
    [[ "${out}" == "${OTHER_ID}" ]] || fail "${step}: the row is no longer pending at row_version ${rv}, and the edit wrote nothing"
    after="$(_scenario_row_json "${step}" "${OTHER_ID}")" || exit 1
    _scenario_row_diff_check "${step}" "${before}" "${after}" \
        "{\"state\": \"waiting\", \"launch_started_at\": null, \"pid\": null, \"proc_starttime\": null, \"pane_pid\": null, \"pane_starttime\": null, \"tmux_session_name\": \"${OTHER_UNUSABLE}\", \"row_version\": $(( rv + 1 ))}"
}

# Step 2b [harness]: the other caller's row, spawned by the harness and then
# edited (SRJ-1427 bullet 2).
step_other_row() {
    local step="step 2: the other caller's row" dir pid
    [[ -z "$(server_pid)" ]] || fail "${step}: a server is running"
    dir="$(make_workdir other)"
    stub_mode "${dir}" "${STUB_MODE_SILENT}"
    ad_capture spawn --cwd "${dir}" --claude-instance-id "${OTHER_ID}" --tmux-session-name "${OTHER_SESSION}" --no-pre-trust
    if (( AD_RC != 0 )); then
        sed 's/^/  | /' "${AD_OUT}" "${AD_ERR}" >&2
        fail "${step}: the harness spawn of ${OTHER_ID} exited ${AD_RC}"
    fi
    pid="$("${SCENARIO_REAL_TMUX}" display-message -p -t "=${OTHER_SESSION}:" '#{pane_pid}' 2> /dev/null)" \
        || fail "${step}: no session ${OTHER_SESSION} on the scenario's tmux server"
    wait_until "${OTHER_WAIT_S}" "${step}: the other caller's pane process ${pid} never became the stub" stub_running "${pid}"
    read_row "${step}" "${OTHER_ID}"
    [[ "${ROW_STATE}" == pending ]] || fail "${step}: ${OTHER_ID} reads '${ROW_STATE}', not pending"
    [[ "$(jq '.labels // {} | length' "${AD_OUT}")" == 0 ]] || fail "${step}: ${OTHER_ID} carries labels $(jq -c '.labels' "${AD_OUT}")"
    other_row_unusable "${step}"
    read_row "${step}" "${OTHER_ID}"
    [[ "${ROW_STATE}" == waiting && "${ROW_SESSION}" == "${OTHER_UNUSABLE}" && -z "${ROW_NOTE}" ]] \
        || fail "${step}: ${OTHER_ID} reads '${ROW_STATE}' in '${ROW_SESSION}' with note '${ROW_NOTE}', not waiting in ${OTHER_UNUSABLE} with no note"
    OTHER_SEED_MARK="$(ad_shim_mark)"
    echo "${TEST_NAME}: ${step}: ${OTHER_ID} reads waiting, recorded session ${OTHER_UNUSABLE}, no note; its stub ${pid} runs in ${OTHER_SESSION}; seeding mark ${OTHER_SEED_MARK}"
}

# Step 3a: the second life's start; U latches.
step_latch() {
    local step="step 3a: U latches" completions rows unusable_line verb
    POSTS_BEFORE="$(post_count)"
    LIFE2_MARK="$(ad_shim_mark)"
    LIFE2_TMUX_MARK="$(tmux_shim_mark)"
    completions="$(count_log "$(completion_match 1)")"
    start_server --live
    LIFE2_PID="${SERVER_PID}"
    wait_for_count "$(completion_match 1)" "$(( completions + 1 ))" "${START_WAIT_S}" "${step}: the start pass never completed"
    LATCH_SET="$(fmk_text conflictLatchSetLine "${U_KEY}" "${CASE_UNUSABLE}" "${U_UNUSABLE}" "${OP_NONE}" "${U_FINISHED_STATE}")" \
        || fail "${step}: fmk-texts.ts could not print conflictLatchSetLine"
    wait_for_count "${LATCH_SET}" 1 "${START_WAIT_S}" "${step}: no latch-set line '${LATCH_SET}'"
    LATCH_MARK="$(ad_shim_mark)"
    LATCH_TMUX_MARK="$(tmux_shim_mark)"
    expect_count "${LATCH_SET}" 1 "${step}: latch-set lines"
    expect_count "${LATCH_HEAD}" 1 "${step}: latch-set lines for ${U_KEY}"
    expect_completion 1 "${step}" "0 failed" "1 latched"
    echo "${TEST_NAME}: ${step}: $(_scenario_scan lastline "${SLACK_STATE_DIR}/server.log" "$(completion_match 1)" | sed 's/^.*\] //')"

    # The server's UNUSABLE NAME line for U: agent-director's ErrInternal,
    # with the description, latched.
    unusable_line="$(matcher " refused for ${U_REF}: ErrInternal message=\"" "${UNUSABLE_PHRASE}" " — UNUSABLE NAME: ")"
    expect_count "${unusable_line}" 1 "${step}: UNUSABLE NAME lines for ${U_KEY}"

    # The bring-up's one resume, the bot server's; no reuse spawn, kill or
    # delete. The ladder's earlier calls (its plain spawn, which the existing
    # row refuses as a collision, and the get after it) are recorded.
    rows="$(ad_cscb_calls "${U_ID}" "${LIFE2_MARK}" "${LATCH_MARK}")"
    echo "${TEST_NAME}: ${step}: CSCB calls of ${U_ID} up to the latch (recorded, not asserted): $(field_of 4 "${rows}" | tr '\n' ' ')"
    [[ " $(field_of 6 "$(verb_rows spawn "${rows}")" | tr '\n' ' ') " != *" --reuse-finished "* ]] \
        || fail "${step}: a CSCB reuse spawn of ${U_ID} before the latch"
    for verb in kill kill-finished delete; do
        (( $(rows_count "$(verb_rows "${verb}" "${rows}")") == 0 )) || fail "${step}: a CSCB ${verb} of ${U_ID} before the latch"
    done
    rows="$(verb_rows resume "${rows}")"
    (( $(rows_count "${rows}") == 1 )) || fail "${step}: $(rows_count "${rows}") CSCB resume call(s) of ${U_ID} before the latch, not one"
    [[ -n "$(server_rows "${LIFE2_PID}" "${rows}")" ]] || fail "${step}: the resume of ${U_ID} is not the bot server's"
    RESUME_US="$(us_of "$(field_of 2 "${rows}")")"
    echo "${TEST_NAME}: ${step}: the bot server's resume at shim line $(field_of 1 "${rows}") was refused; latch mark ${LATCH_MARK}, tmux mark ${LATCH_TMUX_MARK}"
}

# Step 3b: one unusable-name notice, naming no command.
step_notice() {
    local step="step 3b: the unusable-name notice" notice desc
    wait_until "${NOTICE_WAIT_S}" "${step}: no unusable-name notice on ${U_CHANNEL}" \
        posts_holding_at_least "${POSTS_BEFORE}" "${UNUSABLE_HEAD}" 1
    (( $(post_count) == POSTS_BEFORE + 1 )) \
        || fail "${step}: ${U_CHANNEL} got $(( $(post_count) - POSTS_BEFORE )) posts since the second life began, not one"
    posts_holding 0 "${UNUSABLE_HEAD}"
    (( ${#HOLDING[@]} == 1 )) || fail "${step}: ${#HOLDING[@]} posts hold the unusable-name notice head, not one"
    notice="${HOLDING[0]}"
    if [[ "${notice}" != "${NOTICE_BEFORE}"*"${NOTICE_AFTER}" ]]; then
        printf '  | posted:   %q\n  | expected: %q\n' "${notice}" "${NOTICE_BEFORE}…${NOTICE_AFTER}" >&2
        fail "${step}: the post is not the persona prefix and the unusable-name notice for ${U_KEY} around a description"
    fi
    desc="${notice#"${NOTICE_BEFORE}"}"
    desc="${desc%"${NOTICE_AFTER}"}"
    [[ "${desc}" == *"${UNUSABLE_PHRASE}"* && "${desc}" == *"${U_UNUSABLE}"* ]] \
        || fail "${step}: the quoted description does not say '${UNUSABLE_PHRASE}' and name ${U_UNUSABLE}: ${desc}"
    POSTS_AT_LATCH="$(post_count)"
    echo "${TEST_NAME}: ${step}: one notice; agent-director said: ${desc}"
}

# Step 3c [harness]: the reuse spawn forced through fmk-driver.ts.
step_forced_reuse() {
    local step="step 3c: the forced reuse spawn" out err rc=0 lines=() line before after rows desc want
    out="${SCENARIO_ROOT}/fmk-driver-reuse-spawn.out"
    err="${SCENARIO_ROOT}/fmk-driver-reuse-spawn.err"
    before="$(_scenario_row_json "${step}" "${U_ID}")" || exit 1
    DRIVER_MARK="$(ad_shim_mark)"
    cscb_run env "CSCB_PKG_DIR=${SCENARIO_REPO}/node_modules/claude-slack-channel-bots" \
        "DRIVER_PERSONA=${U_NAME}" "DRIVER_PERSONA_CHANNEL=${U_CHANNEL}" "DRIVER_WORKING_DIRECTORY=${U_WORK}" \
        bun --no-install "${SCENARIO_FIXTURES}/fmk-driver.ts" reuse-spawn < /dev/null > "${out}" 2> "${err}" || rc=$?
    DRIVER_END_MARK="$(ad_shim_mark)"
    mapfile -t lines < <(grep -E '^DRIVER(_FAIL)?:' "${out}" || true)
    if (( rc != 0 || ${#lines[@]} != 1 )) || [[ "${lines[0]}" != "DRIVER: FORCED reuse-spawn "* ]]; then
        sed 's/^/  | /' "${out}" >&2
        tail -n 20 "${err}" | sed 's/^/  | /' >&2
        fail "${step}: the driver exited ${rc} with ${#lines[@]} outcome line(s), not one 'DRIVER: FORCED reuse-spawn …' line"
    fi
    line="${lines[0]}"
    echo "${TEST_NAME}: ${step}: ${line:0:600}"
    for want in " called=true " " counted=false " " error=ErrUnknownErrorName " " class=${CLASS_UNUSABLE} " " unknown_name=ErrInternal "; do
        [[ "${line}" == *"${want}"* ]] || fail "${step}: the outcome line lacks '${want# }'"
    done
    [[ "${line}" == *" description="*" result="* ]] || fail "${step}: the outcome line has no description and result"
    desc="${line#* description=}"
    desc="$(jq -r . <<< "${desc% result=*}")" || fail "${step}: the outcome line's description is not a JSON string"
    [[ "${desc}" == *"${UNUSABLE_PHRASE}"* && "${desc}" == *"${U_UNUSABLE}"* ]] \
        || fail "${step}: the forced reuse's description does not say '${UNUSABLE_PHRASE}' and name ${U_UNUSABLE}: ${desc}"

    # The driver's record entry (role run), whose PID is the driver's own.
    DRIVER_PID="$(awk -F'\t' '$1 == "proc" && $2 == "run" && index($6, "fmk-driver.ts reuse-spawn") { p = $3 } END { print p }' "${SCENARIO_CSCB_RECORD}")"
    [[ "${DRIVER_PID}" =~ ^[0-9]+$ ]] || fail "${step}: the record holds no run entry for the driver"
    rows="$(server_rows "${DRIVER_PID}" "$(ad_cscb_calls "${U_ID}" "${DRIVER_MARK}" "${DRIVER_END_MARK}")")"
    if (( $(rows_count "${rows}") != 1 )) || [[ "$(field_of 4 "${rows}")" != spawn || " $(field_of 6 "${rows}") " != *" --reuse-finished "* ]]; then
        sed 's/^/  | /' <<< "${rows}" >&2
        fail "${step}: the driver's calls of ${U_ID} are not one spawn carrying --reuse-finished"
    fi
    after="$(_scenario_row_json "${step}" "${U_ID}")" || exit 1
    [[ "$(jq -S . <<< "${before}")" == "$(jq -S . <<< "${after}")" ]] || fail "${step}: the forced reuse changed U's row: ${after}"
    echo "${TEST_NAME}: ${step}: the driver (${DRIVER_PID}) made one reuse spawn of ${U_ID}, refused; agent-director said: ${desc}"
}

# Step 3d: STATUS_ROUNDS status-only rounds at the cadence, with no post.
step_status_rounds() {
    local n step rounds pos us prev="${RESUME_US}"
    for (( n = 1; n <= STATUS_ROUNDS; n++ )); do
        step="step 3d: round ${n} (status only)"
        wait_for_count "${ROUND_HEAD}" "${n}" $(( INTERVAL_S + SETTLE_S + SETTLE_S )) "${step}: no round line ${n}"
        expect_count "${ROUND_STILL}" "${n}" "${step}: status-only round lines"
        rounds="$(status_rounds "${step}" "${LATCH_MARK}")"
        (( $(rows_count "${rounds}") == n )) || fail "${step}: $(rows_count "${rounds}") status call(s) of ${U_ID} after the latch, not ${n}"
        read -r pos us <<< "$(tail -n 1 <<< "${rounds}")"
        check_cadence "${step}" "${prev}" "${us}"
        prev="${us}"
        expect_count "${LATCH_HEAD}" 1 "${step}: latch-set lines for ${U_KEY}"
        expect_count "${RELATCH_HEAD}" 0 "${step}: relatch lines for ${U_KEY}"
        (( $(post_count) == POSTS_AT_LATCH )) \
            || fail "${step}: ${U_CHANNEL} holds $(post_count) posts, not the ${POSTS_AT_LATCH} it held at the latch"
        echo "${TEST_NAME}: ${step}: status at shim line ${pos}"
    done
    LAST_STATUS_US="${prev}"
}

# Steps 3e and 3f: no tmux line since the latch; nothing counted.
step_no_tmux_nothing_counted() {
    local step="step 3e: no tmux call" target found post
    TMUX_AT_DELETE="$(tmux_shim_mark)"
    if (( TMUX_AT_DELETE != LATCH_TMUX_MARK )); then
        tail -n "+$(( LATCH_TMUX_MARK + 1 ))" "${SCENARIO_TMUX_SHIM_LOG}" | sed 's/^/  | /' >&2
        fail "${step}: the tmux shim's log holds $(( TMUX_AT_DELETE - LATCH_TMUX_MARK )) line(s) from the latch to the delete"
    fi
    for target in "${U_SESSION}" "${U_UNUSABLE}"; do
        found="$(tmux_shim_targets "${target}" "${LIFE2_TMUX_MARK}" "${TMUX_AT_DELETE}")"
        [[ -z "${found}" ]] || { sed 's/^/  | /' <<< "${found}" >&2; fail "${step}: tmux shim line(s) act on ${target} in the second life"; }
    done
    echo "${TEST_NAME}: ${step}: the tmux shim's log is at line ${TMUX_AT_DELETE}, as at the latch"

    step="step 3f: nothing counted"
    expect_count "[slack] Launch failed for persona=${U_KEY}" 0 "${step}: counted launch-failure lines"
    expect_count "[slack] Session relaunch failed for persona=${U_KEY}" 0 "${step}: counted relaunch-failure lines"
    posts_of "${SCENARIO_ROOT}/posts-all.bin"
    for post in ${POSTS[@]+"${POSTS[@]}"}; do
        [[ "${post}" != *"Spawn failure:"* ]] || { printf '  | %q\n' "${post}" >&2; fail "${step}: a spawn-failure notice on ${U_CHANNEL}"; }
    done
}

# Step 3g [harness]: the human's last procedure step, the row's removal.
step_delete() {
    local step="step 3g: the harness's delete"
    DELETE_MARK="$(ad_shim_mark)"
    ad_delete_unusable_row "${U_ID}"
    echo "${TEST_NAME}: ${step}: agent-director-admin removed ${U_ID}: $(tr '\n' ' ' < "${AD_OUT}")"
}

# Steps 3h and 3i: the next round's status finds no row; the latch clears with
# one recovery post, and U comes up fresh.
step_clear_fresh() {
    local step="step 3h: the clear" cleared recovery rows s_pos s_time s_ppid s_verb spawns n verb connections between
    connections="$(count_log "${CONNECTED}")"
    wait_for_count "${ROUND_CLEAR_HEAD}" 1 $(( INTERVAL_S + SETTLE_S + SETTLE_S )) "${step}: no clearing round line after the delete"
    expect_count "${ROUND_CLEAR_HEAD}" 1 "${step}: clearing round lines"
    expect_count "${ROUND_STILL}" "${STATUS_ROUNDS}" "${step}: status-only round lines"
    cleared="$(fmk_text latchClearedLine "${U_KEY}" "${CASE_UNUSABLE}" "${U_UNUSABLE}" posted LATCH_RECOVERY_REASON_ROW_GONE)" \
        || fail "${step}: fmk-texts.ts could not print latchClearedLine"
    expect_count "${cleared}" 1 "${step}: the clear line '${cleared}'"
    echo "${TEST_NAME}: ${step}: round line: $(_scenario_scan lastline "${SLACK_STATE_DIR}/server.log" "${ROUND_CLEAR_HEAD}" | sed 's/^.*\] //')"

    # Exactly one recovery post, the printed notice.
    recovery="$(fmk_text formatPersonaNotice "${U_NAME}" holdRecoveryText LATCH_RECOVERY_REASON_ROW_GONE)" \
        || fail "${step}: fmk-texts.ts could not print the recovery notice"
    wait_until "${NOTICE_WAIT_S}" "${step}: no recovery post on ${U_CHANNEL}" \
        posts_holding_at_least "${POSTS_AT_LATCH}" "${HOLD_RECOVERY_HEAD}" 1
    posts_holding 0 "${HOLD_RECOVERY_HEAD}"
    (( ${#HOLDING[@]} == 1 )) || fail "${step}: ${#HOLDING[@]} posts hold the hold-recovery head, not one"
    if [[ "${HOLDING[0]}" != "${recovery}" ]]; then
        printf '  | posted:   %q\n  | expected: %q\n' "${HOLDING[0]}" "${recovery}" >&2
        fail "${step}: the recovery post is not the printed hold-recovery notice"
    fi

    # U comes up fresh.
    step="step 3i: U comes up fresh"
    wait_until "${START_WAIT_S}" "${step}: ${U_ID} never read waiting again" fresh_row_waiting "${step}"
    read_row "${step}" "${U_ID}"
    [[ -n "${ROW_SID}" && "${ROW_SID}" != "${U_SID}" ]] || fail "${step}: the row's claude_session_id is '${ROW_SID}', not a new one"
    [[ "${ROW_SESSION}" == "${U_SESSION}" ]] || fail "${step}: the row records session '${ROW_SESSION}', not ${U_SESSION}"
    U_FRESH_SID="${ROW_SID}"
    wait_for_count "${CONNECTED}" "$(( connections + 1 ))" "${CONNECT_WAIT_S}" "${step}: the server never registered the fresh stub's session as ${U_KEY}'s"

    # The bot server's calls of U's row after the delete: the clearing
    # round's status first, at the cadence, then one plain spawn.
    rows="$(ad_cscb_calls "${U_ID}" "${DELETE_MARK}")"
    echo "${TEST_NAME}: ${step}: CSCB calls of ${U_ID} after the delete (recorded, not asserted): $(field_of 4 "${rows}" | tr '\n' ' ')"
    [[ "$(rows_count "${rows}")" == "$(rows_count "$(server_rows "${LIFE2_PID}" "${rows}")")" ]] \
        || fail "${step}: a CSCB call of ${U_ID} after the delete is not the bot server's"
    IFS=$'\t' read -r s_pos s_time s_ppid s_verb _ <<< "$(sed -n 1p <<< "${rows}")"
    [[ "${s_verb}" == status ]] || fail "${step}: the bot server's first call of ${U_ID} after the delete is '${s_verb}', not the round's status"
    check_cadence "step 3h: the clearing round" "${LAST_STATUS_US}" "$(us_of "${s_time}")"
    spawns="$(verb_rows spawn "${rows}")"
    if (( $(rows_count "${spawns}") != 1 )) || [[ " $(field_of 6 "${spawns}") " == *" --reuse-finished "* ]]; then
        sed 's/^/  | /' <<< "${rows}" >&2
        fail "${step}: the calls of ${U_ID} after the delete do not hold exactly one plain spawn"
    fi
    for verb in resume kill kill-finished delete; do
        n="$(rows_count "$(verb_rows "${verb}" "${rows}")")"
        (( n == 0 )) || fail "${step}: ${n} CSCB ${verb} call(s) of ${U_ID} after the delete"
    done
    between="$(ad_cscb_verb_between find-missing "${s_pos}" "$(field_of 1 "${spawns}")")"
    [[ -n "${between}" ]] || fail "${step}: no CSCB find-missing between the clearing round's status and the plain spawn"

    # U's channel: only the notice and the recovery post since the second life.
    posts_of "${SCENARIO_ROOT}/posts-end.bin"
    (( ${#POSTS[@]} == POSTS_BEFORE + 2 )) \
        || fail "${step}: ${U_CHANNEL} got $(( ${#POSTS[@]} - POSTS_BEFORE )) posts since the second life began, not the notice and the recovery post"
    for (( n = POSTS_BEFORE; n < ${#POSTS[@]}; n++ )); do
        [[ "${POSTS[n]}" != *"${CONFLICT_HEAD}"* && "${POSTS[n]}" != *"${LAUNCH_START_HEAD}"* ]] \
            || fail "${step}: a CONFLICT or launch-start notice on ${U_CHANNEL}"
    done
    echo "${TEST_NAME}: ${step}: ${U_ID} reads waiting with the fresh claude_session_id ${U_FRESH_SID}; one recovery post"
}

# Step 4: the other caller's row got its note from a CSCB find-missing, and
# CSCB ignored it.
step_other_ignored() {
    local step="step 4: the other caller's row ignored" fm target n
    fm="$(ad_cscb_verb_between find-missing "${OTHER_SEED_MARK}" -)"
    [[ -n "${fm}" ]] || fail "${step}: positive control: no CSCB find-missing after the seeding"
    echo "${TEST_NAME}: ${step}: the first CSCB find-missing after the seeding is at shim line $(field_of 1 "$(sed -n 1p <<< "${fm}")") (the delete at ${DELETE_MARK}); $(rows_count "${fm}") in all"
    read_row "${step}" "${OTHER_ID}"
    [[ "${ROW_NOTE}" == tmux_session_name_rewritten ]] \
        || fail "${step}: ${OTHER_ID}'s liveness note reads '${ROW_NOTE}', not tmux_session_name_rewritten"
    [[ "${ROW_STATE}" == waiting && "${ROW_SESSION}" == "${OTHER_UNUSABLE}" ]] \
        || fail "${step}: ${OTHER_ID} reads '${ROW_STATE}' in '${ROW_SESSION}', not waiting in ${OTHER_UNUSABLE}"
    (( $(cscb_ad_count "" "${U_ID}") > 0 )) || fail "${step}: positive control: no CSCB call's arguments hold ${U_ID}"
    for target in "${OTHER_ID}" "${OTHER_UNUSABLE}" "${OTHER_SESSION}"; do
        n="$(cscb_ad_count "" "${target}")"
        (( n == 0 )) || { cscb_ad_calls "" "${target}" | sed 's/^/  | /' >&2; fail "${step}: ${n} CSCB call(s) name ${target}"; }
        n="$(count_log "$(matcher "conflict-latch: " "${target}")")"
        (( n == 0 )) || fail "${step}: ${n} conflict-latch line(s) name ${target}"
        n="$(record_posts_naming "${target}")"
        (( n == 0 )) || fail "${step}: ${n} post(s) in the Slack stub's record name ${target}"
    done
    echo "${TEST_NAME}: ${step}: ${OTHER_ID} carries ${ROW_NOTE}; no CSCB call, latch line or post names it"
}

start_slack_stub "${SCENARIO_ROOT}/slack-stub" "${TOKEN_LABEL}"
step_first_life
step_unusable_name
step_other_row
step_latch
step_notice
step_forced_reuse
step_status_rounds
step_no_tmux_nothing_counted
step_delete
step_clear_fresh
step_other_ignored

# Step 5 [harness]: the human ends U's fresh worker, then stop --stop-bots.
end_worker "step 5: the fresh worker ended by hand" "${U_SESSION}"
stop_server --stop-bots
read_row "end" "${U_ID}"
[[ -n "${ROW_STATE}" && "${ROW_SID}" == "${U_FRESH_SID}" ]] || fail "end: ${U_ID} reads '${ROW_STATE}' (${ROW_SID}) at the end"
echo "${TEST_NAME}: end: ${U_ID} is present, reading ${ROW_STATE}"
DELETES="$(delete_lines)"
if (( $(rows_count "${DELETES}") != 1 )) || [[ "$(field_of 2 "${DELETES}")" != "$$" || "$(field_of 3 "${DELETES}")" != harness \
    || "$(field_of 4 "${DELETES}")" != "${SCENARIO_SHELL_CMDLINE}" ]]; then
    sed 's/^/  | /' <<< "${DELETES}" >&2
    fail "end: the agent-director shim's log does not hold exactly one delete, the scenario shell's"
fi
echo "${TEST_NAME}: end: the shim's log holds one delete, at line $(field_of 1 "${DELETES}"), from the scenario's own shell"
stop_tracked_pid "${SLACK_STUB_PID}" 10 "the Slack stub did not exit on SIGTERM"

assert_no_server_tmux
assert_no_cscb_include_finished
assert_no_cscb_delete

echo "PASS: ${TEST_NAME}"
