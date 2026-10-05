#!/usr/bin/env bash
# Test 16 (HO §7 scenario 4; b.jg5 SRJ-1405, SRJ-505, SRJ-506, SRJ-1004,
# SRJ-1005, SRJ-1401; AC 2): a session holding a persona's name latches it.
# A session with no label, made by hand, holds the name of persona
# `nolabel`, whose row is finished. The bring-up's `resume` gets CONFLICT
# "no valid instance id" naming that session; the persona latches with one
# post that points to "Operator actions" and names no command; nothing is
# killed or deleted. Each re-check, one interval apart, reads the row
# (`status`, `ended` or `missing`) and only then retries the `resume`, which
# agent-director refuses again before its move, writing nothing, and nothing
# is posted. Once the harness ends the session, the next re-check's `resume`
# launches, the persona reaches `waiting` and one recovery post follows.
#
# The script is built in five phases, each a function below, so that later
# scenarios' personas (scenario 19) join the same phases:
#   1. first life, for the personas that need a row;
#   2. `stop --stop-bots`, each persona's row left as its leg needs it;
#   3. harness seeding, with the server stopped;
#   4. second life, with every persona configured: latches, rounds and the
#      harness's clears;
#   5. a restart-leg hook (empty here).
#
# The fmk set-up (lib/scenario.sh, fmk mode: TEST_NAME carries `-fmk-`):
# - its own HOME, agent-director store and tmux server under SCENARIO_ROOT;
#   the release installed through its install.sh, behind the agent-director
#   shim (agent-director-admin too); agent-director's default settings (no
#   config.toml);
# - the tmux shim first on every CSCB process's PATH, in `log` mode
#   throughout;
# - the stub as `claude`, in `dev-channels` (no selection, the default) in
#   every persona's working directory: it prints the dev-channels dialog and
#   reports in only on Enter (CSCB's approver);
# - the live server against the Slack stub (fixtures/slack-stub-server.ts
#   with `--record`; posts are read from that record with `slack_posts`, on
#   each persona's own channel, PERSONA_CHANNEL), `health_check_interval` 0,
#   `session_restart_delay` at its default.
# The harness runs no `find-missing` anywhere in this script (SRJ-1401).
# Persona keys must not prefix one another (CSCB rejects that).
#
# Scenario 4's leg (persona `nolabel`, key `nolabel`). Steps marked
# [harness] are the harness playing a human from the scenario's own shell;
# no CSCB process makes them.
#   Phase 1. The live start spawns `nolabel` fresh; the approver clears the
#      dialog; a harness `get` reads the row `waiting`; its
#      claude_session_id and tmux session name are recorded.
#   Phase 2. [harness] The human ends `nolabel`'s worker as a human ends
#      Claude Code: the stub's exit line typed into its pane with the real
#      tmux (`__CSCB_TEST_EXIT__`, the stub's `/exit`, fixtures/stub-claude.sh),
#      which fires the worker's SessionEnd hooks, so agent-director itself
#      marks the row `ended`, and the worker's session ends with it. This is
#      how the row is left finished: a harness `kill` changes no row's state
#      in agent-director 0.11.0, the teardown's `kill` ends the stub with no
#      SessionEnd (the stub ignores the `/exit` that `pause` types), so a row
#      ended that way keeps reading `waiting`, and the harness runs no
#      `find-missing`; `ad_store_mark_finished` needs the worker's session
#      still there. The server's disconnect handler arms its restart after
#      `session_restart_delay` (60 s); `stop --stop-bots` follows at once and
#      stops the server first, and a check below shows no CSCB `resume` or
#      `spawn` of the row between the exit and the second life. Then
#      `stop --stop-bots`; a harness `get` reads the row `ended` or
#      `missing`, with the same claude_session_id, and its session is gone.
#   Phase 3. [harness] With the server stopped, a session with no label and
#      no @ad_pane, named as the row records (`slack_bot_<key>`), its pane
#      running `sleep` (`seed_unlabelled`). The row still reads finished.
#   Phase 4. The live start:
#      - the bring-up's one `resume` of `nolabel`'s row (parent: the bot
#        server; its earlier calls, a `spawn` that meets the finished row
#        among them, are recorded, not asserted) is refused: server.log
#        holds the latch-set line for case
#        `no-valid-id`, the session, refused operation `resume` and the
#        state read (`conflictLatchSetLine`, followed by agent-director's
#        description), once;
#      - exactly one post on its channel holds the CONFLICT notice head, and
#        its lines, in SRJ-1004's order, are: the persona prefix and the
#        first line for that case quoting the session; the description line
#        (head and tail as printed, holding agent-director's "no valid
#        instance id" phrase and the session name); the pointer line; the
#        list line; the human-only line. Every line but the description
#        line equals the printed line, so the post names no command;
#      - the harness reads the row's state and row_version (the store,
#        read-only) right after the latch;
#      - REFUSED_ROUNDS (2) re-check rounds: `persona_rounds` reads the
#        persona's CSCB calls after the latch, which must be exactly one
#        `status` then one `resume` per round, no `read-pane` and no other
#        call; the first round's `status` comes at least one interval
#        (LATCH_RECHECK_INTERVAL_MS) after the refused bring-up `resume` and
#        within the interval plus SETTLE_S, each next round's at least one
#        interval after the previous round's and within the interval plus
#        SETTLE_S, and each round's `resume` within SETTLE_S of its
#        `status`; after each, the round line (`latchRecheckRoundLine`, step
#        `step-2`, call `resume`, answer `still-latched`) is logged, the row
#        reads the same state and row_version, the seeded session is still
#        there with the same id, and the channel holds no new post;
#      - [harness] the human ends the seeded session by its session id
#        (`end_session`);
#      - the next round: its first two calls are one `status` then one
#        `resume`, at the cadence, with no CSCB `find-missing` between them
#        (`ad_cscb_verb_between`); the `resume` launches: the latch clears
#        (`latchClearedLine`, reason "a retry of the refused operation was
#        not refused", posted), the approver clears the dialog and the row
#        reads `waiting` with the first life's claude_session_id; the server
#        registers the stub's MCP session; exactly one post holds the
#        recovery head, and it equals the printed recovery notice
#        (`conflictRecoveryText`, reason LATCH_RECOVERY_REASON_RETRY_NOT_REFUSED);
#      - no CSCB `kill`, `kill-finished` or `delete` names `nolabel`'s row
#        in the second life; no tmux command CSCB caused reads from, types
#        into, kills or respawns the seeded session (by its session id, pane
#        id or name) up to the harness's end of it (`tmux_shim_targets`;
#        tmux numbers sessions and panes from $0 and %0 again once its
#        server, left with no session, exits and a new one starts); positive
#        control: such commands act on the resumed session after it.
#   Phase 5. Empty.
#   Then `stop --stop-bots`, and `nolabel`'s row is present at the end.
#
# Waits and their derivation (seconds): STUB_WAIT_S (20) for the Slack
# stub's ready file; START_WAIT_S (120) per start pass (one bring-up, one
# launch call); REPORT_WAIT_S (60) for the approver's Enter (it reads the
# pane every lap, about 1 s apart) and the stub's report-in; CONNECT_WAIT_S
# (30) for the server to register the stub's MCP session; EXIT_WAIT_S (30)
# for the stub's SessionEnd hooks and its session's end after the exit
# line; NOTICE_WAIT_S (30) for a post after the line that causes it.
# The re-check interval is fixtures/fmk-texts.ts's LATCH_RECHECK_INTERVAL_MS
# (120 s). SETTLE_S (30) is the stated settle: a round's own calls (one
# `status` and one `resume`, each one agent-director process, a few
# seconds at most), the timer's start after the previous round settled, and
# the shim's process start. The cadence checks hold each round's `status`
# to the interval plus SETTLE_S; each round's server-log line, written once
# the round settled, is waited for within the interval plus twice SETTLE_S
# from the previous round's checks. Expected runtime: about 7 minutes (three
# rounds, 120 s apart).
#
# Matched values. CSCB's values come from fixtures/fmk-texts.ts, printed from
# the installed package, never retyped:
# - personaInstanceId (src/persona-identity.ts), personaNoticePrefix and
#   formatPersonaNotice (src/persona-notifier.ts);
# - from src/conflict-latch.ts: LATCH_CASE_NO_VALID_ID,
#   REFUSED_OPERATION_RESUME, LATCH_RECHECK_INTERVAL_MS, RECHECK_STEP_TABLE,
#   RECHECK_CALL_RESUME, CONFLICT_NOTICE_FIRST_LINE_HEAD,
#   CONFLICT_NOTICE_DESCRIPTION_LINE_HEAD and _TAIL,
#   CONFLICT_NOTICE_POINTER_LINE, CONFLICT_NOTICE_HUMAN_ONLY_LINE,
#   CONFLICT_NOTICE_LINE_SEPARATOR, CONFLICT_RECOVERY_HEAD, and the builders
#   conflictNoticeFirstLine, conflictNoticeListLine, conflictRecoveryText,
#   conflictLatchSetLine, latchClearedLine and latchRecheckRoundLine;
# - CONFLICT_NO_VALID_ID_PHRASE (src/ad-description-phrases.ts).
# Fragments with no exported builder, each quoted from its source:
# - `[slack] Session connected: persona <ref>` (src/server.ts, the MCP
#   session's registration line);
# - the round answer `still-latched` (src/session-manager.ts
#   runLatchRecheckRound's answerAfter, for a retry that left the persona
#   latched);
# - the persona reference `"<name>" (key=<key>)` (lib/scenario.sh
#   persona_ref, src/persona-identity.ts renderPersonaRef).
#
# Closing: the script ends with `assert_no_server_tmux`,
# `assert_no_cscb_include_finished` and `assert_no_cscb_delete` in its own
# shell. Every count of CSCB's agent-director calls reads only shim lines
# whose parent is a CSCB process; no step reads a pane's text.
set -euo pipefail

TEST_NAME="test-16-fmk-conflict"
# shellcheck source=lib/scenario.sh
source "$(dirname "$0")/lib/scenario.sh"

# Bounds (seconds; see the header).
STUB_WAIT_S=20
START_WAIT_S=120
REPORT_WAIT_S=60
CONNECT_WAIT_S=30
EXIT_WAIT_S=30
NOTICE_WAIT_S=30
SETTLE_S=30

# Scenario 4's refused rounds before the harness ends the session.
REFUSED_ROUNDS=2

FMK_TEXTS="${SCENARIO_FIXTURES}/fmk-texts.ts"

# ---------------------------------------------------------------------------
# Personas: one table entry per persona, by key
# ---------------------------------------------------------------------------

# Scenario 4's persona.
S4_NAME="nolabel"
S4_KEY="$(persona_key "${S4_NAME}")"

declare -A PERSONA_NAME=([${S4_KEY}]="${S4_NAME}")
# The post reader's channel table: each persona's one channel, which is also
# where its permission prompts and notices go.
declare -A PERSONA_CHANNEL=([${S4_KEY}]="C0T16NL01")
# The Slack token label of each persona's fake token pair.
declare -A PERSONA_TOKEN=([${S4_KEY}]="t16nolabel")
# Filled in by the phases.
declare -A PERSONA_ID=() PERSONA_WORK=() PERSONA_CREDS=() PERSONA_SID=() PERSONA_SESSION=()

# The personas of the first life, and of the second (every persona).
LIFE1_KEYS=("${S4_KEY}")
LIFE2_KEYS=("${S4_KEY}")

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

# start_slack_stub <dir> <label>...: start the Slack stub in a new <dir>,
# answering ok for each token pair ending in a <label> and refusing any
# other; wait for its ready file; export CSCB_SLACK_API_URL; set
# SLACK_STUB_PID and SCENARIO_SLACK_RECORD (slack_posts' default record).
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

# prepare_persona <key>: its working directory and credentials file, and its
# instance id from the package.
prepare_persona() {
    local key="$1" label="${PERSONA_TOKEN[$1]}" creds="${SCENARIO_ROOT}/credentials"
    [[ -d "${creds}" ]] || mkdir -m 700 "${creds}"
    PERSONA_WORK[${key}]="$(make_workdir "${key}")"
    PERSONA_CREDS[${key}]="${creds}/${key}.json"
    printf '{"bot_token": "%s", "app_token": "%s"}\n' "$(fake_token bot "${label}")" "$(fake_token app "${label}")" \
        | write_file "${PERSONA_CREDS[${key}]}" 600
    PERSONA_ID[${key}]="$(fmk_text personaInstanceId "${key}")" || fail "setup: fmk-texts.ts could not print personaInstanceId ${key}"
}

# write_personas_config <key>...: the server's config.json, configuring the
# given personas (in that order) with `health_check_interval` 0.
write_personas_config() {
    local key personas="[]"
    for key in "$@"; do
        personas="$(jq -c --arg n "${PERSONA_NAME[${key}]}" --arg c "${PERSONA_CREDS[${key}]}" \
            --arg w "${PERSONA_WORK[${key}]}" --arg ch "${PERSONA_CHANNEL[${key}]}" \
            '. + [{name: $n, credentials_file: $c, working_directory: $w,
                   channels: [{id: $ch, delivery: "all"}], permission_prompts: $ch}]' <<< "${personas}")" \
            || fail "config: jq could not add persona ${key}"
    done
    jq -n --argjson p "${personas}" --argjson port "${SCENARIO_PORT}" \
        '{personas: $p, bind: "127.0.0.1", port: $port, health_check_interval: 0, exit_timeout: 5}' \
        | write_config
}

# read_row <step> <instance-id>: a harness `get` of the row. Sets ROW_STATE,
# ROW_SID (claude_session_id) and ROW_SESSION (tmux_session_name), each
# empty when absent.
read_row() {
    local fields
    ad_capture get --claude-instance-id "$2"
    (( AD_RC == 0 )) || fail "$1: the harness get of $2 exited ${AD_RC}: $(head -c 300 "${AD_ERR}")"
    fields="$(jq -r '[.state // "", .claude_session_id // "", .tmux_session_name // ""] | join("\u001f")' "${AD_OUT}")" \
        || fail "$1: the harness get of $2 printed no row object: $(head -c 300 "${AD_OUT}")"
    IFS=$'\x1f' read -r ROW_STATE ROW_SID ROW_SESSION <<< "${fields}"
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

# store_row <step> <instance-id>: the harness's read-only store read of the
# row (lib/scenario.sh's `_scenario_row_json`, both guards first). Sets
# STORE_STATE and STORE_RV (row_version).
store_row() {
    local json
    json="$(_scenario_row_json "$1" "$2")" || exit 1
    STORE_STATE="$(jq -r '.[0].state' <<< "${json}")"
    STORE_RV="$(jq -r '.[0].row_version' <<< "${json}")"
    [[ "${STORE_RV}" =~ ^[0-9]+$ ]] || fail "$1: the row's row_version reads '${STORE_RV}'"
}

# True when the scenario's tmux server holds a session named exactly <name>
# (asked with the real tmux).
has_session() {
    "${SCENARIO_REAL_TMUX}" has-session -t "=$1" 2> /dev/null
}

# True when the scenario's tmux server holds the session with id <$N>.
has_session_id() {
    "${SCENARIO_REAL_TMUX}" has-session -t "$1" 2> /dev/null
}

# True while the scenario's tmux server holds no session named exactly <name>.
session_gone() {
    ! has_session "$1"
}

# posts_of <key> <file>: write the posts on persona <key>'s channel to <file>
# and set POSTS to them (one element per post, in record order).
posts_of() {
    slack_posts "${PERSONA_CHANNEL[$1]}" > "$2"
    POSTS=()
    mapfile -d '' -t POSTS < "$2"
}

# post_count <key>: print how many posts persona <key>'s channel holds.
post_count() {
    posts_of "$1" "${SCENARIO_ROOT}/posts-count.bin"
    echo "${#POSTS[@]}"
}

# posts_holding <key> <from-index> <text>: set HOLDING to the posts on
# persona <key>'s channel from index <from-index> on that hold <text>.
posts_holding() {
    local post i
    posts_of "$1" "${SCENARIO_ROOT}/posts-holding.bin"
    HOLDING=()
    for (( i = $2; i < ${#POSTS[@]}; i++ )); do
        post="${POSTS[i]}"
        [[ "${post}" != *"$3"* ]] || HOLDING+=("${post}")
    done
}

# posts_holding_at_least <key> <from-index> <text> <n>: true once at least
# <n> posts from <from-index> on hold <text>.
posts_holding_at_least() {
    posts_holding "$1" "$2" "$3"
    (( ${#HOLDING[@]} >= $4 ))
}

# split_on <text> <separator>: set PARTS to <text>'s parts between the
# <separator>s.
split_on() {
    local rest="$1" sep="$2"
    PARTS=()
    while [[ "${rest}" == *"${sep}"* ]]; do
        PARTS+=("${rest%%"${sep}"*}")
        rest="${rest#*"${sep}"}"
    done
    PARTS+=("${rest}")
}

# persona_rounds <step> <instance-id> <from-mark> [<to-mark>]: the re-check
# rounds of a persona latched on a `resume`, from E42 T1's reader
# (`ad_cscb_calls`): its CSCB-parented calls after <from-mark> (up to
# <to-mark>) must be, in log order, one `status` then one `resume` per
# round, and no other call; fails otherwise, and on a `status` with no
# `resume` after it. Prints one line per round,
# `<status-pos> <status-us> <resume-pos> <resume-us>`.
persona_rounds() {
    local step="$1" id="$2" from="$3" to="${4:--}" rows pos time verb us want=status s_pos="" s_us=""
    rows="$(ad_cscb_calls "${id}" "${from}" "${to}")"
    [[ -n "${rows}" ]] || return 0
    while IFS=$'\t' read -r pos time _ verb _; do
        if [[ "${verb}" != "${want}" ]]; then
            sed 's/^/  | /' <<< "${rows}" >&2
            fail "${step}: CSCB call ${verb} of ${id} at shim line ${pos}, where a round's ${want} belongs (a round is one status then one resume, and nothing else)"
        fi
        us="$(us_of "${time}")"
        if [[ "${verb}" == status ]]; then
            s_pos="${pos}"
            s_us="${us}"
            want=resume
        else
            printf '%s %s %s %s\n' "${s_pos}" "${s_us}" "${pos}" "${us}"
            want=status
        fi
    done <<< "${rows}"
    [[ "${want}" == status ]] || fail "${step}: the status of ${id} at shim line ${s_pos} has no resume after it"
}

# check_cadence <step> <previous-us> <status-us> <resume-us>: fail unless the
# round's status comes at least one interval after <previous-us> and within
# the interval plus SETTLE_S, and its resume within SETTLE_S of its status.
check_cadence() {
    local step="$1" gap
    gap=$(( $3 - $2 ))
    (( gap >= INTERVAL_US )) \
        || fail "${step}: the round's status came $(secs_of "${gap}") s after the previous point, less than the ${INTERVAL_S} s interval"
    (( gap <= INTERVAL_US + SETTLE_S * 1000000 )) \
        || fail "${step}: the round's status came $(secs_of "${gap}") s after the previous point, more than the ${INTERVAL_S} s interval plus the ${SETTLE_S} s settle"
    (( $4 - $3 <= SETTLE_S * 1000000 )) \
        || fail "${step}: the round's resume came $(secs_of $(( $4 - $3 ))) s after its status, more than the ${SETTLE_S} s settle"
    echo "${TEST_NAME}: ${step}: status $(secs_of "${gap}") s after the previous point, resume $(secs_of $(( $4 - $3 ))) s after it"
}

# ---------------------------------------------------------------------------
# Values from the installed package
# ---------------------------------------------------------------------------

INTERVAL_MS="$(fmk_text LATCH_RECHECK_INTERVAL_MS)" || fail "setup: fmk-texts.ts could not print LATCH_RECHECK_INTERVAL_MS"
[[ "${INTERVAL_MS}" =~ ^[1-9][0-9]*$ ]] || fail "setup: LATCH_RECHECK_INTERVAL_MS is '${INTERVAL_MS}'"
INTERVAL_US=$(( INTERVAL_MS * 1000 ))
INTERVAL_S=$(( (INTERVAL_MS + 999) / 1000 ))
CASE_NO_VALID_ID="$(fmk_text LATCH_CASE_NO_VALID_ID)" || fail "setup: fmk-texts.ts could not print LATCH_CASE_NO_VALID_ID"
OP_RESUME="$(fmk_text REFUSED_OPERATION_RESUME)" || fail "setup: fmk-texts.ts could not print REFUSED_OPERATION_RESUME"
STEP_TABLE="$(fmk_text RECHECK_STEP_TABLE)" || fail "setup: fmk-texts.ts could not print RECHECK_STEP_TABLE"
CALL_RESUME="$(fmk_text RECHECK_CALL_RESUME)" || fail "setup: fmk-texts.ts could not print RECHECK_CALL_RESUME"
NO_VALID_ID_PHRASE="$(fmk_text CONFLICT_NO_VALID_ID_PHRASE)" || fail "setup: fmk-texts.ts could not print CONFLICT_NO_VALID_ID_PHRASE"
CONFLICT_HEAD="$(fmk_text CONFLICT_NOTICE_FIRST_LINE_HEAD)" || fail "setup: fmk-texts.ts could not print CONFLICT_NOTICE_FIRST_LINE_HEAD"
DESC_HEAD="$(fmk_text CONFLICT_NOTICE_DESCRIPTION_LINE_HEAD)" || fail "setup: fmk-texts.ts could not print CONFLICT_NOTICE_DESCRIPTION_LINE_HEAD"
DESC_TAIL="$(fmk_text CONFLICT_NOTICE_DESCRIPTION_LINE_TAIL)" || fail "setup: fmk-texts.ts could not print CONFLICT_NOTICE_DESCRIPTION_LINE_TAIL"
POINTER_LINE="$(fmk_text CONFLICT_NOTICE_POINTER_LINE)" || fail "setup: fmk-texts.ts could not print CONFLICT_NOTICE_POINTER_LINE"
HUMAN_LINE="$(fmk_text CONFLICT_NOTICE_HUMAN_ONLY_LINE)" || fail "setup: fmk-texts.ts could not print CONFLICT_NOTICE_HUMAN_ONLY_LINE"
RECOVERY_HEAD="$(fmk_text CONFLICT_RECOVERY_HEAD)" || fail "setup: fmk-texts.ts could not print CONFLICT_RECOVERY_HEAD"
NOTICE_SEP="$(fmk_text CONFLICT_NOTICE_LINE_SEPARATOR && printf x)" || fail "setup: fmk-texts.ts could not print CONFLICT_NOTICE_LINE_SEPARATOR"
NOTICE_SEP="${NOTICE_SEP%x}"
[[ -n "${NOTICE_SEP}" && -n "${CONFLICT_HEAD}" && -n "${POINTER_LINE}" && -n "${HUMAN_LINE}" && -n "${RECOVERY_HEAD}" ]] \
    || fail "setup: fmk-texts.ts printed an empty notice part"
(( INTERVAL_S > SETTLE_S )) || fail "setup: the ${SETTLE_S} s settle is not shorter than the ${INTERVAL_S} s re-check interval"
echo "${TEST_NAME}: re-check interval ${INTERVAL_MS} ms, settle ${SETTLE_S} s"

# ---------------------------------------------------------------------------
# Phase 1: first life, for the personas that need a row
# ---------------------------------------------------------------------------

phase1_first_life() {
    local step="phase 1: first life" key ref rows
    for key in "${LIFE2_KEYS[@]}"; do
        prepare_persona "${key}"
    done
    write_personas_config "${LIFE1_KEYS[@]}"
    start_server --live
    LIFE1_PID="${SERVER_PID}"
    wait_for_count "$(completion_match "${#LIFE1_KEYS[@]}")" 1 "${START_WAIT_S}" "${step}: the start pass never completed"
    expect_completion "${#LIFE1_KEYS[@]}" "${step}" "0 not brought up"
    for key in "${LIFE1_KEYS[@]}"; do
        ref="$(persona_ref "${PERSONA_NAME[${key}]}")"
        wait_row "${step}: ${key}'s report-in" "${REPORT_WAIT_S}" "${PERSONA_ID[${key}]}" waiting
        [[ -n "${ROW_SID}" ]] || fail "${step}: the live row ${PERSONA_ID[${key}]} has no claude_session_id"
        [[ -n "${ROW_SESSION}" ]] || fail "${step}: the live row ${PERSONA_ID[${key}]} names no tmux session"
        PERSONA_SID[${key}]="${ROW_SID}"
        PERSONA_SESSION[${key}]="${ROW_SESSION}"
        wait_for_count "[slack] Session connected: persona ${ref}" 1 "${CONNECT_WAIT_S}" \
            "${step}: the server never registered the stub's session as ${key}'s"
        rows="$(server_rows "${LIFE1_PID}" "$(verb_rows send-keys "$(ad_cscb_calls "${PERSONA_ID[${key}]}")")")"
        (( $(rows_count "${rows}") >= 1 )) || fail "${step}: no bot-server send-keys of ${PERSONA_ID[${key}]} (the approver's Enter)"
        echo "${TEST_NAME}: ${step}: ${PERSONA_ID[${key}]} reads waiting, claude_session_id ${ROW_SID}, session ${ROW_SESSION}"
    done
}

# ---------------------------------------------------------------------------
# Phase 2: stop --stop-bots, each row left as its leg needs it
# ---------------------------------------------------------------------------

# Scenario 4 [harness]: the human ends the worker as a human ends Claude
# Code (the stub's exit line), so agent-director marks the row ended.
s4_human_exit() {
    local step="phase 2: ${S4_KEY}'s worker ended by hand" id="${PERSONA_ID[${S4_KEY}]}" session="${PERSONA_SESSION[${S4_KEY}]}"
    S4_EXIT_MARK="$(ad_shim_mark)"
    "${SCENARIO_REAL_TMUX}" send-keys -t "=${session}:" -l __CSCB_TEST_EXIT__ \
        || fail "${step}: could not type the stub's exit line into ${session}"
    "${SCENARIO_REAL_TMUX}" send-keys -t "=${session}:" Enter \
        || fail "${step}: could not send Enter into ${session}"
    wait_row "${step}" "${EXIT_WAIT_S}" "${id}" ended missing
    wait_until "${EXIT_WAIT_S}" "${step}: session ${session} is still there after the worker's exit" session_gone "${session}"
    echo "${TEST_NAME}: ${step}: ${id} reads ${ROW_STATE}; ${session} is gone"
}

phase2_stop_bots() {
    local step="phase 2: stop --stop-bots" id rows n verb
    s4_human_exit
    stop_server --stop-bots
    sed "s/^/${TEST_NAME}: ${step}: stop said: /" "${STOP_OUT}"
    # Scenario 4: the row stays finished, with its session id, and nothing
    # relaunched it after the exit (the disconnect's restart never ran).
    id="${PERSONA_ID[${S4_KEY}]}"
    row_reads "${step}" "${id}" ended missing || fail "${step}: ${id} reads '${ROW_STATE}', not ended or missing"
    [[ "${ROW_SID}" == "${PERSONA_SID[${S4_KEY}]}" ]] \
        || fail "${step}: ${id}'s claude_session_id is '${ROW_SID}', not ${PERSONA_SID[${S4_KEY}]}"
    ! has_session "${PERSONA_SESSION[${S4_KEY}]}" || fail "${step}: session ${PERSONA_SESSION[${S4_KEY}]} is there"
    rows="$(ad_cscb_calls "${id}" "${S4_EXIT_MARK}")"
    echo "${TEST_NAME}: ${step}: CSCB calls of ${id} after the exit (recorded, not asserted): $(field_of 4 "${rows}" | tr '\n' ' ')"
    for verb in resume spawn; do
        n="$(rows_count "$(verb_rows "${verb}" "${rows}")")"
        (( n == 0 )) || fail "${step}: ${n} CSCB ${verb} call(s) of ${id} after the worker's exit"
    done
    S4_FINISHED_STATE="${ROW_STATE}"
    echo "${TEST_NAME}: ${step}: ${id} reads ${ROW_STATE} with claude_session_id ${ROW_SID}"
}

# ---------------------------------------------------------------------------
# Phase 3: harness seeding, with the server stopped
# ---------------------------------------------------------------------------

# Scenario 4 [harness]: a session with no label holds the row's name.
s4_seed() {
    local step="phase 3: ${S4_KEY}'s name held" id="${PERSONA_ID[${S4_KEY}]}" session="${PERSONA_SESSION[${S4_KEY}]}"
    [[ -z "$(server_pid)" ]] || fail "${step}: a server is running"
    seed_unlabelled -c "${PERSONA_WORK[${S4_KEY}]}" "${session}" sleep 86400 > "${SCENARIO_ROOT}/s4-seed.out"
    S4_SEEDED_SID="${SEEDED_SESSION_ID}"
    S4_SEEDED_PANE="${SEEDED_PANE_ID}"
    [[ "${S4_SEEDED_SID}" =~ ^\$[0-9]+$ ]] || fail "${step}: the seeded session id is '${S4_SEEDED_SID}'"
    row_reads "${step}" "${id}" "${S4_FINISHED_STATE}" || fail "${step}: ${id} reads '${ROW_STATE}', not ${S4_FINISHED_STATE}"
    echo "${TEST_NAME}: ${step}: ${session} (${S4_SEEDED_SID}, pane ${S4_SEEDED_PANE}) has no label; ${id} reads ${ROW_STATE}"
}

phase3_seed() {
    s4_seed
}

# ---------------------------------------------------------------------------
# Phase 4: second life, every persona configured
# ---------------------------------------------------------------------------

# Scenario 4: the latch, its one notice, and the harness's reads at the latch.
s4_latch() {
    local step="phase 4: ${S4_KEY} latches" id="${PERSONA_ID[${S4_KEY}]}" session="${PERSONA_SESSION[${S4_KEY}]}"
    local name="${PERSONA_NAME[${S4_KEY}]}" set_line rows notice prefix first list desc
    set_line="$(fmk_text conflictLatchSetLine "${S4_KEY}" "${CASE_NO_VALID_ID}" "${session}" "${OP_RESUME}" "${S4_FINISHED_STATE}")" \
        || fail "${step}: fmk-texts.ts could not print conflictLatchSetLine"
    wait_for_count "${set_line}" 1 "${START_WAIT_S}" "${step}: no latch-set line '${set_line}'"
    S4_LATCH_MARK="$(ad_shim_mark)"
    S4_LATCH_TMUX_MARK="$(tmux_shim_mark)"
    expect_count "${set_line}" 1 "${step}: latch-set lines"

    # The bring-up's one resume, the bot server's, was refused.
    rows="$(ad_cscb_calls "${id}" "${LIFE2_MARK}" "${S4_LATCH_MARK}")"
    echo "${TEST_NAME}: ${step}: CSCB calls of ${id} up to the latch (recorded, not asserted): $(field_of 4 "${rows}" | tr '\n' ' ')"
    rows="$(verb_rows resume "${rows}")"
    (( $(rows_count "${rows}") == 1 )) || fail "${step}: $(rows_count "${rows}") CSCB resume call(s) of ${id} before the latch, not one"
    [[ -n "$(server_rows "${LIFE2_PID}" "${rows}")" ]] || fail "${step}: the resume of ${id} is not the bot server's"
    S4_LATCH_US="$(us_of "$(field_of 2 "${rows}")")"

    # One CONFLICT notice, in SRJ-1004's order, naming no command.
    wait_until "${NOTICE_WAIT_S}" "${step}: no CONFLICT notice on ${PERSONA_CHANNEL[${S4_KEY}]}" \
        posts_holding_at_least "${S4_KEY}" "${S4_POSTS_BEFORE}" "${CONFLICT_HEAD}" 1
    posts_holding "${S4_KEY}" 0 "${CONFLICT_HEAD}"
    (( ${#HOLDING[@]} == 1 )) || fail "${step}: ${#HOLDING[@]} posts on ${PERSONA_CHANNEL[${S4_KEY}]} hold the CONFLICT notice head, not one"
    notice="${HOLDING[0]}"
    prefix="$(fmk_text personaNoticePrefix "${name}")" || fail "${step}: fmk-texts.ts could not print personaNoticePrefix"
    first="$(fmk_text conflictNoticeFirstLine "${CASE_NO_VALID_ID}" "${session}")" || fail "${step}: fmk-texts.ts could not print conflictNoticeFirstLine"
    list="$(fmk_text conflictNoticeListLine "${session}")" || fail "${step}: fmk-texts.ts could not print conflictNoticeListLine"
    split_on "${notice}" "${NOTICE_SEP}"
    if (( ${#PARTS[@]} != 5 )) || [[ "${PARTS[0]}" != "${prefix}${first}" || "${PARTS[2]}" != "${POINTER_LINE}" \
        || "${PARTS[3]}" != "${list}" || "${PARTS[4]}" != "${HUMAN_LINE}" ]]; then
        printf '  | posted:   %q\n  | expected: %q\n' "${notice}" "${prefix}${first}${NOTICE_SEP}${DESC_HEAD}…${DESC_TAIL}${NOTICE_SEP}${POINTER_LINE}${NOTICE_SEP}${list}${NOTICE_SEP}${HUMAN_LINE}" >&2
        fail "${step}: the CONFLICT notice is not the prefix and first line, the description line, the pointer line, the list line and the human-only line"
    fi
    desc="${PARTS[1]}"
    [[ "${desc}" == "${DESC_HEAD}"*"${DESC_TAIL}" ]] || fail "${step}: the notice's second line is not a description line: ${desc}"
    desc="${desc#"${DESC_HEAD}"}"
    desc="${desc%"${DESC_TAIL}"}"
    [[ "${desc}" == *"${NO_VALID_ID_PHRASE}"* ]] || fail "${step}: agent-director's description does not say '${NO_VALID_ID_PHRASE}': ${desc}"
    [[ "${desc}" == *"${session}"* ]] || fail "${step}: agent-director's description does not name ${session}: ${desc}"
    S4_POSTS_AT_LATCH="$(post_count "${S4_KEY}")"
    echo "${TEST_NAME}: ${step}: one CONFLICT notice; agent-director said: ${desc}"

    # The harness's reads at the latch: the row and the seeded session.
    store_row "${step}" "${id}"
    [[ "${STORE_STATE}" == ended || "${STORE_STATE}" == missing ]] || fail "${step}: ${id} reads ${STORE_STATE} in the store at the latch"
    S4_LATCH_STATE="${STORE_STATE}"
    S4_LATCH_RV="${STORE_RV}"
    has_session_id "${S4_SEEDED_SID}" || fail "${step}: the seeded session ${S4_SEEDED_SID} is gone"
    echo "${TEST_NAME}: ${step}: ${id} reads ${S4_LATCH_STATE} at row_version ${S4_LATCH_RV}"
}

# Scenario 4: REFUSED_ROUNDS rounds, each one status then one resume,
# refused, posting nothing and writing nothing.
s4_refused_rounds() {
    local id="${PERSONA_ID[${S4_KEY}]}" name="${PERSONA_NAME[${S4_KEY}]}" n step rounds prev status_us resume_us status_pos resume_pos
    local line
    line="$(fmk_text latchRecheckRoundLine "${name}" "${CASE_NO_VALID_ID}" "${STEP_TABLE}" "${CALL_RESUME}" ANSWER)" \
        || fail "phase 4: fmk-texts.ts could not print latchRecheckRoundLine"
    S4_ROUND_HEAD="${line%ANSWER}"
    S4_ROUND_REFUSED="${S4_ROUND_HEAD}still-latched"
    prev="${S4_LATCH_US}"
    for (( n = 1; n <= REFUSED_ROUNDS; n++ )); do
        step="phase 4: ${S4_KEY}'s round ${n} (refused)"
        wait_for_count "${S4_ROUND_HEAD}" "${n}" $(( INTERVAL_S + SETTLE_S + SETTLE_S )) "${step}: no round line ${n}"
        expect_count "${S4_ROUND_REFUSED}" "${n}" "${step}: refused round lines"
        rounds="$(persona_rounds "${step}" "${id}" "${S4_LATCH_MARK}")"
        (( $(rows_count "${rounds}") == n )) || fail "${step}: $(rows_count "${rounds}") rounds of ${id} after the latch, not ${n}"
        read -r status_pos status_us resume_pos resume_us <<< "$(tail -n 1 <<< "${rounds}")"
        check_cadence "${step}" "${prev}" "${status_us}" "${resume_us}"
        prev="${status_us}"
        S4_LAST_ROUND_POS="${resume_pos}"
        store_row "${step}" "${id}"
        [[ "${STORE_STATE}" == "${S4_LATCH_STATE}" && "${STORE_RV}" == "${S4_LATCH_RV}" ]] \
            || fail "${step}: ${id} reads ${STORE_STATE} at row_version ${STORE_RV}, not ${S4_LATCH_STATE} at ${S4_LATCH_RV}"
        has_session_id "${S4_SEEDED_SID}" || fail "${step}: the seeded session ${S4_SEEDED_SID} is gone"
        (( $(post_count "${S4_KEY}") == S4_POSTS_AT_LATCH )) \
            || fail "${step}: the channel holds $(post_count "${S4_KEY}") posts, not the ${S4_POSTS_AT_LATCH} it held at the latch"
        echo "${TEST_NAME}: ${step}: status at shim line ${status_pos}, resume at ${resume_pos}; ${id} still ${STORE_STATE} at row_version ${STORE_RV}"
    done
    S4_PREV_STATUS_US="${prev}"
}

# Scenario 4: the harness ends the session; the next round's resume launches
# and the latch clears with one recovery post.
s4_clear() {
    local step="phase 4: ${S4_KEY}'s clear" id="${PERSONA_ID[${S4_KEY}]}" session="${PERSONA_SESSION[${S4_KEY}]}"
    local name="${PERSONA_NAME[${S4_KEY}]}" ref rows s_pos s_time s_verb r_pos r_time r_verb s_us r_us between cleared recovery n
    ref="$(persona_ref "${name}")"
    S4_CONNECTS="$(count_log "[slack] Session connected: persona ${ref}")"
    # [harness] The human ends the session by its id.
    end_session "${S4_SEEDED_SID}"
    S4_END_TMUX_MARK="$(tmux_shim_mark)"
    echo "${TEST_NAME}: ${step}: the harness ended ${session} (${S4_SEEDED_SID})"

    wait_for_count "${S4_ROUND_HEAD}" $(( REFUSED_ROUNDS + 1 )) $(( INTERVAL_S + SETTLE_S + SETTLE_S )) "${step}: no round line after the session ended"
    rows="$(ad_cscb_calls "${id}" "${S4_LAST_ROUND_POS}")"
    IFS=$'\t' read -r s_pos s_time _ s_verb _ <<< "$(sed -n 1p <<< "${rows}")"
    IFS=$'\t' read -r r_pos r_time _ r_verb _ <<< "$(sed -n 2p <<< "${rows}")"
    if [[ "${s_verb}" != status || "${r_verb}" != resume ]]; then
        sed 's/^/  | /' <<< "${rows}" >&2
        fail "${step}: the round's first calls of ${id} are '${s_verb}' and '${r_verb}', not status then resume"
    fi
    s_us="$(us_of "${s_time}")"
    r_us="$(us_of "${r_time}")"
    check_cadence "${step}" "${S4_PREV_STATUS_US}" "${s_us}" "${r_us}"
    between="$(ad_cscb_verb_between find-missing "${s_pos}" "${r_pos}")"
    [[ -z "${between}" ]] || { sed 's/^/  | /' <<< "${between}" >&2; fail "${step}: a CSCB find-missing between the round's status and its resume"; }

    # The retry was not refused: the latch clears, posted.
    cleared="$(fmk_text latchClearedLine "${S4_KEY}" "${CASE_NO_VALID_ID}" "${session}" posted LATCH_RECOVERY_REASON_RETRY_NOT_REFUSED)" \
        || fail "${step}: fmk-texts.ts could not print latchClearedLine"
    expect_count "${cleared}" 1 "${step}: the clear line '${cleared}'"
    expect_count "${S4_ROUND_REFUSED}" "${REFUSED_ROUNDS}" "${step}: refused round lines"
    echo "${TEST_NAME}: ${step}: round line: $(_scenario_scan lastline "${SLACK_STATE_DIR}/server.log" "${S4_ROUND_HEAD}" | sed 's/^.*\] //')"

    # The resume launched: the persona comes back on its conversation.
    wait_row "${step}: the resume's report-in" "${REPORT_WAIT_S}" "${id}" waiting
    [[ "${ROW_SID}" == "${PERSONA_SID[${S4_KEY}]}" ]] \
        || fail "${step}: the resumed row's claude_session_id is '${ROW_SID}', not ${PERSONA_SID[${S4_KEY}]}"
    [[ "${ROW_SESSION}" == "${session}" ]] || fail "${step}: the resumed row records session '${ROW_SESSION}', not ${session}"
    wait_for_count "[slack] Session connected: persona ${ref}" $(( S4_CONNECTS + 1 )) "${CONNECT_WAIT_S}" \
        "${step}: the server never registered the resumed stub's session as ${S4_KEY}'s"
    read -r S4_RESUMED_SID S4_RESUMED_PANE <<< "$("${SCENARIO_REAL_TMUX}" display-message -p -t "=${session}:" '#{session_id} #{pane_id}' 2> /dev/null || true)"
    [[ "${S4_RESUMED_SID}" =~ ^\$[0-9]+$ && "${S4_RESUMED_PANE}" =~ ^%[0-9]+$ ]] \
        || fail "${step}: tmux gives no session id and pane for the resumed ${session}"

    # Exactly one recovery post, the printed notice.
    recovery="$(fmk_text formatPersonaNotice "${name}" conflictRecoveryText "${session}" LATCH_RECOVERY_REASON_RETRY_NOT_REFUSED)" \
        || fail "${step}: fmk-texts.ts could not print the recovery notice"
    wait_until "${NOTICE_WAIT_S}" "${step}: no recovery post on ${PERSONA_CHANNEL[${S4_KEY}]}" \
        posts_holding_at_least "${S4_KEY}" "${S4_POSTS_AT_LATCH}" "${RECOVERY_HEAD}" 1
    posts_holding "${S4_KEY}" 0 "${RECOVERY_HEAD}"
    n="${#HOLDING[@]}"
    (( n == 1 )) || fail "${step}: ${n} posts hold the recovery head, not one"
    if [[ "${HOLDING[0]}" != "${recovery}" ]]; then
        printf '  | posted:   %q\n  | expected: %q\n' "${HOLDING[0]}" "${recovery}" >&2
        fail "${step}: the recovery post is not the printed recovery notice"
    fi
    posts_holding "${S4_KEY}" 0 "${CONFLICT_HEAD}"
    (( ${#HOLDING[@]} == 1 )) || fail "${step}: ${#HOLDING[@]} posts hold the CONFLICT notice head, not one"
    echo "${TEST_NAME}: ${step}: ${id} reads waiting with claude_session_id ${ROW_SID}; one recovery post"
}

# Scenario 4: nothing killed or deleted for the persona, and the seeded
# session never acted on.
s4_no_kill() {
    local step="phase 4: ${S4_KEY} nothing killed" id="${PERSONA_ID[${S4_KEY}]}" rows verb n found target control=""
    rows="$(ad_cscb_calls "${id}" "${LIFE2_MARK}")"
    for verb in kill kill-finished delete; do
        n="$(rows_count "$(verb_rows "${verb}" "${rows}")")"
        (( n == 0 )) || fail "${step}: ${n} CSCB ${verb} call(s) of ${id} in the second life"
    done
    # Up to the harness's end of the seeded session: once the scenario's tmux
    # server has no session left it exits, and the next server numbers its
    # sessions and panes from $0 and %0 again.
    found="$(tmux_shim_targets "${S4_SEEDED_SID}" "${LIFE2_TMUX_MARK}" "${S4_END_TMUX_MARK}")"
    [[ -z "${found}" ]] || { sed 's/^/  | /' <<< "${found}" >&2; fail "${step}: tmux shim line(s) act on the seeded session ${S4_SEEDED_SID}"; }
    found="$(tmux_shim_targets "${S4_SEEDED_PANE}" "${LIFE2_TMUX_MARK}" "${S4_END_TMUX_MARK}")"
    [[ -z "${found}" ]] || { sed 's/^/  | /' <<< "${found}" >&2; fail "${step}: tmux shim line(s) act on the seeded pane ${S4_SEEDED_PANE}"; }
    found="$(tmux_shim_targets "${PERSONA_SESSION[${S4_KEY}]}" "${LIFE2_TMUX_MARK}" "${S4_END_TMUX_MARK}")"
    [[ -z "${found}" ]] || { sed 's/^/  | /' <<< "${found}" >&2; fail "${step}: tmux shim line(s) act on ${PERSONA_SESSION[${S4_KEY}]} while the seeded session held it"; }
    # Positive control: the approver typed into the resumed session.
    for target in "${PERSONA_SESSION[${S4_KEY}]}" "${S4_RESUMED_SID}" "${S4_RESUMED_PANE}"; do
        found="$(tmux_shim_targets "${target}" "${S4_END_TMUX_MARK}")"
        [[ -z "${found}" ]] || control+="${target}: $(field_of 4 "${found}" | sort | uniq -c | tr -s ' \n' ' ')"
    done
    [[ -n "${control}" ]] \
        || fail "${step}: positive control: tmux_shim_targets finds no command acting on the resumed ${PERSONA_SESSION[${S4_KEY}]}, ${S4_RESUMED_SID} or ${S4_RESUMED_PANE}"
    echo "${TEST_NAME}: ${step}: tmux commands acting on the resumed session: ${control}"
    echo "${TEST_NAME}: ${step}: no kill, kill-finished or delete of ${id}; the seeded session untouched"
}

phase4_second_life() {
    local step="phase 4: second life" completions
    S4_POSTS_BEFORE="$(post_count "${S4_KEY}")"
    write_personas_config "${LIFE2_KEYS[@]}"
    LIFE2_MARK="$(ad_shim_mark)"
    LIFE2_TMUX_MARK="$(tmux_shim_mark)"
    completions="$(count_log "$(completion_match "${#LIFE2_KEYS[@]}")")"
    start_server --live
    LIFE2_PID="${SERVER_PID}"
    wait_for_count "$(completion_match "${#LIFE2_KEYS[@]}")" "$(( completions + 1 ))" "${START_WAIT_S}" "${step}: the start pass never completed"
    echo "${TEST_NAME}: ${step}: $(_scenario_scan lastline "${SLACK_STATE_DIR}/server.log" "$(completion_match "${#LIFE2_KEYS[@]}")" | sed 's/^.*\] //')"
    s4_latch
    s4_refused_rounds
    s4_clear
    s4_no_kill
}

# ---------------------------------------------------------------------------
# Phase 5: the restart-leg hook
# ---------------------------------------------------------------------------

phase5_restart_leg() {
    :
}

# ---------------------------------------------------------------------------
# Run
# ---------------------------------------------------------------------------

slack_labels=()
for key in "${LIFE2_KEYS[@]}"; do
    slack_labels+=("${PERSONA_TOKEN[${key}]}")
done
start_slack_stub "${SCENARIO_ROOT}/slack-stub" "${slack_labels[@]}"
phase1_first_life
phase2_stop_bots
phase3_seed
phase4_second_life
phase5_restart_leg

stop_server --stop-bots
for key in "${LIFE2_KEYS[@]}"; do
    read_row "end" "${PERSONA_ID[${key}]}"
    [[ -n "${ROW_STATE}" && "${ROW_SID}" == "${PERSONA_SID[${key}]}" ]] \
        || fail "end: ${PERSONA_ID[${key}]} reads '${ROW_STATE}' (${ROW_SID}) at the end"
    echo "${TEST_NAME}: end: ${PERSONA_ID[${key}]} is present, reading ${ROW_STATE}"
done
stop_tracked_pid "${SLACK_STUB_PID}" 10 "the Slack stub did not exit on SIGTERM"

assert_no_server_tmux
assert_no_cscb_include_finished
assert_no_cscb_delete

echo "PASS: ${TEST_NAME}"
