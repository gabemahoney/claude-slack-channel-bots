#!/usr/bin/env bash
# Stuck pending launches: own-launch abort, foreign-process hold, relabel conflict
# and grouped viewer preservation. AD rows and existing retry backoff own timing;
# abort must follow B and may wait until the next retry. No startup UI is read.

set -euo pipefail

TEST_NAME="test-24-fmk-stuck-launch"
# shellcheck source=lib/scenario.sh
source "$(dirname "$0")/lib/scenario.sh"

# Persona P (the own-launch leg). src/persona-identity.ts personaInstanceId: `cscb_<key>`.
P_NAME="${SCENARIO_TAG}_p"
P_KEY="$(persona_key "${P_NAME}")"
P_REF="$(persona_ref "${P_NAME}")"
P_ID="cscb_${P_KEY}"
P_CHANNEL="C0T24OWN1"
P_SUFFIX=t24p

# Persona Q (the other-process leg).
Q_NAME="${SCENARIO_TAG}_q"
Q_KEY="$(persona_key "${Q_NAME}")"
Q_REF="$(persona_ref "${Q_NAME}")"
Q_ID="cscb_${Q_KEY}"
Q_CHANNEL="C0T24OTH1"
Q_SUFFIX=t24q

# Persona R (the relabelled-session leg).
R_NAME="${SCENARIO_TAG}_r"
R_KEY="$(persona_key "${R_NAME}")"
R_REF="$(persona_ref "${R_NAME}")"
R_ID="cscb_${R_KEY}"
R_CHANNEL="C0T24REL1"
R_SUFFIX=t24r

# Persona V (the grouped-viewer leg).
V_NAME="${SCENARIO_TAG}_v"
V_KEY="$(persona_key "${V_NAME}")"
V_REF="$(persona_ref "${V_NAME}")"
V_ID="cscb_${V_KEY}"
V_CHANNEL="C0T24VEW1"
V_SUFFIX=t24v

# Bounds and slacks (seconds; see the header).
STUB_WAIT_S=20        # the Slack stub writing its ready file
START_WAIT_S=120      # a start pass: one bring-up or one launch
REPORT_WAIT_S=60      # after a start pass or an Enter: the row reporting in
CONNECT_WAIT_S=30     # after the row reported in: the server registering the stub's session
ENDED_WAIT_S=20       # after the sentinel: the row reading ended or missing
SESSION_WAIT_S=10     # after the first pending read: the session present
ABORT_SLACK_S=30
RELAUNCH_SLACK_S=60
HOLD_POLL_S=1
HOLD_READ_GAP_S=5
GONE_WAIT_S=10        # after the kill: the worker's process gone
OTHER_START_MARGIN_S=15
HELD_SLACK_S=40
LATCH_WAIT_S=30       # after R's kill: the latch-set line
RECHECK_SLACK_S=60

# The fixtures.
FMK_TEXTS="${SCENARIO_FIXTURES}/fmk-texts.ts"

# The stub's sentinel (fixtures/stub-claude.sh).
SENTINEL=__CSCB_TEST_EXIT__


# The fragments of a counted launch failure and of the restart cap, each
# followed by the persona's key in its line (src/restart.ts runRestartWork,
# countLaunchFailure and recordLaunchResultOutsideRestartWork, inline, no
# export); each is checked at setup to appear in the installed package's
# src/restart.ts.
COUNTED_FAILURE_HEADS=("[slack] Session relaunch failed for persona=" "[slack] Launch failed for persona=" "[slack] Cap reached for persona=")

# The installed package under test, as fixtures/fmk-texts.ts reads it.
INSTALLED_PKG_DIR="${CSCB_PKG_DIR:-/test-repo/node_modules/claude-slack-channel-bots}"

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

# Print the time now, epoch seconds with microseconds (the shim logs' clock).
now_s() {
    printf '%s\n' "${EPOCHREALTIME/,/.}"
}

# Print <b> - <a>, both seconds with decimals.
seconds_between() {
    awk -v a="$1" -v b="$2" 'BEGIN { printf "%.3f\n", b - a }'
}

# plus_s <time> <seconds>: print <time> + <seconds>, three decimals.
plus_s() {
    awk -v t="$1" -v d="$2" 'BEGIN { printf "%.3f\n", t + d }'
}

# before <a> <b>: true when time <a> is earlier than time <b>.
before() {
    awk -v a="$1" -v b="$2" 'BEGIN { exit !(a + 0 < b + 0) }'
}

# fmk_text <entry> [<arg>...]: print fixtures/fmk-texts.ts's value for <entry>.
fmk_text() {
    bun --no-install "${FMK_TEXTS}" "$@"
}

# start_slack_stub <dir> <suffix>...: start the Slack stub in a new <dir>,
# answering ok for each token pair ending in a <suffix> and refusing any
# other; wait for its ready file; export CSCB_SLACK_API_URL; set
# SLACK_STUB_PID and SLACK_RECORD.
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
    SLACK_RECORD="${dir}/record.jsonl"
    (cd "${dir}" && exec bun "${SCENARIO_FIXTURES}/slack-stub-server.ts" --record "${SLACK_RECORD}" \
        --control "${dir}/control.json" --ready-file "${dir}/ready.json") > "${dir}/stub.out" 2>&1 &
    SLACK_STUB_PID=$!
    track_pid "${SLACK_STUB_PID}"
    wait_for_file "${dir}/ready.json" "${STUB_WAIT_S}" "${step}: the Slack stub never wrote its ready file"
    api_url="$(jq -r '.api_url' "${dir}/ready.json")"
    [[ "${api_url}" =~ ^http://127\.0\.0\.1:[0-9]+/api/$ ]] || fail "${step}: the stub's api_url '${api_url}' is not loopback"
    export CSCB_SLACK_API_URL="${api_url}"
}

# line_count <file>: print how many lines <file> holds (0 when there is none).
line_count() {
    if [[ ! -f "$1" ]]; then
        echo 0
        return 0
    fi
    wc -l < "$1" | tr -d ' '
}

# record_posts <from-line>: print the Slack stub record's posts (chat.* and
# files.* methods), one JSON object per line, from record line <from-line> on.
record_posts() {
    [[ -f "${SLACK_RECORD}" ]] || return 0
    tail -n "+$1" "${SLACK_RECORD}" \
        | jq -c 'select(.event == "api" and ((.method // "") | test("^(chat|files)\\.")))'
}

# record_posts_of <from-line> <label>: as `record_posts`, only the posts made
# with the token pair the Slack stub labels <label> (a persona's suffix).
record_posts_of() {
    record_posts "$1" | jq -c --arg l "$2" 'select(.label == $l)'
}

# persona_json <name> <credentials-file> <working-dir> <channel>: one persona
# object of the config.
persona_json() {
    jq -n -c --arg n "$1" --arg c "$2" --arg w "$3" --arg ch "$4" \
        '{name: $n, credentials_file: $c, working_directory: $w, channels: [{id: $ch, delivery: "all"}], permission_prompts: $ch}'
}

# write_personas_config <persona-json>...: the config with those personas,
# the health check off (`health_check_interval` 0, ruling S3).
write_personas_config() {
    printf '%s\n' "$@" | jq -s --argjson port "${SCENARIO_PORT}" \
        '{personas: ., bind: "127.0.0.1", port: $port, health_check_interval: 0, session_restart_delay: 5, exit_timeout: 5}' \
        | write_config
}

# write_credentials <dir> <suffix>: a credentials file for the token pair
# ending in <suffix>, at <dir>/<suffix>.json; print its path.
write_credentials() {
    local file="$1/$2.json"
    printf '{"bot_token": "%s", "app_token": "%s"}\n' "$(fake_token bot "$2")" "$(fake_token app "$2")" \
        | write_file "${file}" 600
    printf '%s\n' "${file}"
}

# poll_row_of <id> <step>: a harness `get` of row <id>. Sets ROW_READ_AT (the
# time just before the call), ROW_STATE (`absent` for ErrSpawnNotFound),
# ROW_SID (session_id), ROW_LAUNCH (launch_started_at as printed) and
# ROW_SESSION (tmux_session_name), each empty when absent.
poll_row_of() {
    local id="$1" fields
    ROW_READ_AT="$(now_s)"
    ad_capture get --instance-id "${id}"
    if (( AD_RC != 0 )); then
        if grep -qF ErrSpawnNotFound "${AD_OUT}" "${AD_ERR}"; then
            ROW_STATE=absent ROW_SID="" ROW_LAUNCH="" ROW_SESSION=""
            return 0
        fi
        fail "$2: the harness get of ${id} exited ${AD_RC}: $(head -c 300 "${AD_ERR}")"
    fi
    fields="$(jq -r '[.state // "", .session_id // "", (.launch_started_at // "" | tostring), .tmux_session_name // ""] | join("\u001f")' "${AD_OUT}")" \
        || fail "$2: the harness get of ${id} printed no row object: $(head -c 300 "${AD_OUT}")"
    IFS=$'\x1f' read -r ROW_STATE ROW_SID ROW_LAUNCH ROW_SESSION <<< "${fields}"
}

# row_of_reads <id> <step> <state>...: read row <id>; true when its state is
# one of the <state>s.
row_of_reads() {
    local id="$1" step="$2" s
    shift 2
    poll_row_of "${id}" "${step}"
    for s in "$@"; do
        [[ "${ROW_STATE}" == "${s}" ]] && return 0
    done
    return 1
}

# launch_ms <text>: print a launch_started_at as epoch milliseconds; false
# when it does not parse.
launch_ms() {
    local ms
    ms="$(date -u -d "$1" +%s%3N 2> /dev/null)" && [[ "${ms}" =~ ^[0-9]+$ ]] && printf '%s\n' "${ms}"
}

# ms_to_s <ms>: print epoch milliseconds as seconds, three decimals.
ms_to_s() {
    awk -v m="$1" 'BEGIN { printf "%.3f\n", m / 1000 }'
}

# pane_capture <step> <session> <file>: a pane on the scenario's tmux server,
# read with the real tmux from the scenario's own shell, into <file>.

# has_session <session>: true when the scenario's tmux server holds it.
has_session() {
    "${SCENARIO_REAL_TMUX}" has-session -t "=$1" 2> /dev/null
}

# pane_pid_of <step> <session>: print the process of the session's pane (the
# stub, which is the pane's own process), read with the real tmux.
pane_pid_of() {
    local pids
    pids="$("${SCENARIO_REAL_TMUX}" list-panes -t "=$2:" -F '#{pane_pid}' 2> /dev/null)" \
        || fail "$1: tmux could not list the panes of session $2"
    [[ "${pids}" =~ ^[0-9]+$ ]] || fail "$1: session $2 has no single pane process ('${pids}')"
    printf '%s\n' "${pids}"
}



hold_pending_worker() {
    wait_until "${SESSION_WAIT_S}" "$1: no tmux session $2 for the held row" has_session "$2"
}

# end_worker <id> <step>: a plain stop has left row <id>'s worker running;
# end it with the stub's sentinel, sent into its pane with the real tmux, and
# wait until the row reads ended or missing.
end_worker() {
    poll_row_of "$1" "$2"
    [[ -n "${ROW_SESSION}" ]] || fail "$2: row $1 names no tmux session"
    "${SCENARIO_REAL_TMUX}" send-keys -t "=${ROW_SESSION}:" "${SENTINEL}" Enter \
        || fail "$2: could not send the sentinel into ${ROW_SESSION}"
    wait_until "${ENDED_WAIT_S}" "$2: row $1 never read ended or missing after the sentinel" \
        row_of_reads "$1" "$2" ended missing
}

# call_table <file>: write <file>, one TAB-separated line per agent-director
# shim `call` line whose parent is a CSCB process (`cscb_ad_calls`), in log
# order: its time, its PPID (the CSCB process), its verb, the row id its
# `--instance-id` names (`-` when none) and its arguments joined by
# single spaces.
call_table() {
    local out="$1" line time id i
    : > "${out}"
    while IFS= read -r line; do
        _scenario_split_line "${line}" && _scenario_decode_words || fail "call_table: a shim log line does not parse: ${line}"
        _scenario_ad_verb
        time="${line#*$'\t'}"
        time="${time%%$'\t'*}"
        id=-
        for (( i = 0; i < ${#_L_ARGS[@]}; i++ )); do
            case "${_L_ARGS[i]}" in
                --instance-id) id="${_L_ARGS[i + 1]:--}" ;;
                --instance-id=*) id="${_L_ARGS[i]#*=}" ;;
            esac
        done
        printf '%s\t%s\t%s\t%s\t%s\n' "${time}" "${_L_PPID}" "${_L_VERB}" "${id}" "${_L_ARGS[*]}" >> "${out}"
    done < <(cscb_ad_calls "")
}

# calls <table> <ppid> <id> <verb> <from> <to> [<word>|!<word>]...: print the
# `call_table` lines whose PPID is <ppid> (`-` for any CSCB process), whose
# row is <id>, whose verb is <verb> (`-` for any), whose time is in
# (<from>, <to>] (`-` for no bound), whose arguments hold every <word> as a
# whole argument and no `!<word>`.
calls() {
    local table="$1" ppid="$2" id="$3" verb="$4" from="$5" to="$6"
    shift 6
    awk -F'\t' -v p="${ppid}" -v id="${id}" -v v="${verb}" -v a="${from}" -v b="${to}" -v w="$*" '
        BEGIN { n = split(w, want, " ") }
        (p == "-" || $2 == p) && $4 == id && (v == "-" || $3 == v) \
            && (a == "-" || $1 + 0 > a + 0) && (b == "-" || $1 + 0 <= b + 0) {
            m = split($5, args, " ")
            for (k in has) delete has[k]
            for (i = 1; i <= m; i++) has[args[i]] = 1
            ok = 1
            for (i = 1; i <= n; i++) {
                x = want[i]
                if (substr(x, 1, 1) == "!") { if (substr(x, 2) in has) ok = 0 }
                else if (!(x in has)) ok = 0
            }
            if (ok) print
        }' "${table}"
}

# count_calls <table> <ppid> <id> <verb> <from> <to> [<word>|!<word>]...: how
# many lines `calls` prints.
count_calls() {
    calls "$@" | wc -l | tr -d ' '
}

# first_call_at <table> <ppid> <id> <verb> <from> <to> [<word>|!<word>]...:
# the time of the first line `calls` prints (empty when none). `sed -n 1p`
# reads all its input, so `calls` never meets a closed pipe under pipefail.
first_call_at() {
    calls "$@" | sed -n 1p | cut -f1
}

# server_calls_of <id> <verb>: print the agent-director shim's `call` lines
# naming row <id> whose parent is the bot server (SERVER_PID) and whose verb
# is <verb> (`cscb_ad_calls`).
server_calls_of() {
    local lines=()
    mapfile -t lines < <(cscb_ad_calls "$2" "--instance-id $1")
    (( ${#lines[@]} > 0 )) || return 0
    printf '%s\n' "${lines[@]}" | awk -F'\t' -v p="${SERVER_PID}" '$4 == p'
}


# server_killed <id> <srv>: true once the shim's log holds a `call` line whose
# parent is the bot server <srv> and whose words hold `kill` and row <id>.
server_killed() {
    awk -F'\t' -v p="$2" -v id="$1" '
        $1 == "call" && $4 == p && $6 ~ /(^| )kill( |$)/ && index($6, id) { found = 1 }
        END { exit !found }' "${SCENARIO_AD_SHIM_LOG}"
}

# server_call_after <id> <srv> <verb> <time>: print the time of the first
# shim `call` line after <time> whose parent is the bot server <srv> and
# whose words hold <verb> and row <id>; false when there is none.

# server_called_after <id> <srv> <verb> <time>: true once `server_call_after`
# finds such a line; prints nothing.

# server_call_pid_after <id> <srv> <verb> <time>: as `server_call_after`, but
# print `<time> <pid>`, the pid being the call's agent-director process (the
# shim `exec`s it, so the logged pid is that process's).


# log_hits <from-line> <fragment>...: print `<line number> TAB <time> TAB
# <text>` for each line of $SLACK_STATE_DIR/server.log after line
# <from-line> that holds every fixed-string <fragment> in order, <time> being
# the line's `[<ISO time>]` head (src/logging.ts) in epoch seconds, three
# decimals.
log_hits() {
    python3 - "${SLACK_STATE_DIR}/server.log" "$@" << 'EOF'
import datetime, sys
path, start, frags = sys.argv[1], int(sys.argv[2]), sys.argv[3:]
try:
    lines = open(path, encoding="utf-8", errors="replace").read().split("\n")
except FileNotFoundError:
    sys.exit(0)
for n, text in enumerate(lines, 1):
    if n <= start or not text.startswith("[") or "] " not in text:
        continue
    rest, ok = text, True
    for f in frags:
        p = rest.find(f)
        if p < 0:
            ok = False
            break
        rest = rest[p + len(f):]
    if not ok:
        continue
    head = text[1:text.index("] ")]
    try:
        t = datetime.datetime.strptime(head, "%Y-%m-%dT%H:%M:%S.%fZ").replace(tzinfo=datetime.timezone.utc).timestamp()
    except ValueError:
        continue
    print(f"{n}\t{t:.3f}\t{text}")
EOF
}

# log_lines_equal <from-line> <text>: print `<line number> TAB <time>` for
# each server.log line after <from-line> whose text after its time head is
# exactly <text>.
log_lines_equal() {
    local hit text
    while IFS= read -r hit; do
        text="${hit#*$'\t'*$'\t'}"
        text="${text#*] }"
        [[ "${text}" == "$2" ]] && printf '%s\n' "${hit%$'\t'*}"
    done < <(log_hits "$1" "$2")
    return 0
}

# log_lines_starting <from-line> <head>: as `log_lines_equal`, for each line
# whose text after its time head starts with <head>.
log_lines_starting() {
    local hit text
    while IFS= read -r hit; do
        text="${hit#*$'\t'*$'\t'}"
        text="${text#*] }"
        [[ "${text}" == "$2"* ]] && printf '%s\n' "${hit%$'\t'*}"
    done < <(log_hits "$1" "$2")
    return 0
}

# poster_line_seen <from-line> <text>: true once server.log holds a line
# equal to <text> after line <from-line>.
poster_line_seen() {
    [[ -n "$(log_lines_equal "$1" "$2")" ]]
}

# log_line_starting_seen <from-line> <head>: true once server.log holds a line
# starting with <head> after line <from-line>.
log_line_starting_seen() {
    [[ -n "$(log_lines_starting "$1" "$2")" ]]
}

# log_message_of <text>: print the JSON-decoded value of the ` message="…"`
# that ends a log line's <text> (src/persona-connection-errors.ts
# describeLogMessage); false when it holds none.
log_message_of() {
    python3 - "$1" << 'EOF'
import json, sys
text = sys.argv[1]
at = text.rfind(' message="')
if at < 0:
    sys.exit(1)
try:
    value, end = json.JSONDecoder().raw_decode(text[at + len(' message='):])
except ValueError:
    sys.exit(1)
if not isinstance(value, str) or text[at + len(' message=') + end:] != "":
    sys.exit(1)
sys.stdout.write(value)
EOF
}

# log_fragment_seen <from-line> <fragment>: true once server.log holds a line
# holding <fragment> after line <from-line>.
log_fragment_seen() {
    [[ -n "$(log_hits "$1" "$2")" ]]
}

# pid_gone <pid>: true once <pid> is not a live process.
pid_gone() {
    ! pid_alive "$1"
}

bring_up() {
    wait_for_log "$(completion_match 1)" "${START_WAIT_S}" "$1: the start pass never completed"
    expect_completion 1 "$1" "0 not brought up"
    persona_brought_up "$@"
}

persona_brought_up() {
    wait_until "${REPORT_WAIT_S}" "$1: row $2 never reported in (waiting) after the start" \
        row_of_reads "$2" "$1: bring-up" waiting
    BROUGHT_UP_SID="${ROW_SID}"
    [[ -n "${BROUGHT_UP_SID}" ]] || fail "$1: the live row $2 has no session_id"
    # src/server.ts: the MCP session's registration line.
    wait_for_log "$(matcher "[slack] Session connected: persona $3")" "${CONNECT_WAIT_S}" \
        "$1: the server never registered the stub's session"
}

# The checks the own-launch, relabelled-session and grouped-viewer legs share.
# Each reads server.log after line `log0`, the calling leg's local.

# reads_before_kill_pending <step> <reads> <kill-at> <launch-ms> <launch-s> <who>:
# every harness read in <reads> before <kill-at> reads `pending` with launch
# start <launch-ms>, at least one, the last within HOLD_READ_GAP_S of the kill.
reads_before_kill_pending() {
    local step="$1" reads="$2" kill_at="$3" l_ms="$4" l_s="$5" who="$6" n t read_state read_launch
    n="$(awk -F'\t' -v k="${kill_at}" '$1 + 0 < k + 0' "${reads}" | wc -l | tr -d ' ')"
    (( n > 0 )) || fail "${step}: no harness read of ${who} before its kill"
    while IFS=$'\t' read -r t read_state read_launch; do
        [[ "${read_state}" == pending && "$(launch_ms "${read_launch}")" == "${l_ms}" ]] \
            || fail "${step}: a harness read of ${who} at +$(seconds_between "${l_s}" "${t}")s from its launch start, before the abort kill, reads ${read_state} (launch ${read_launch}), not pending with launch start L (read missing: agent-director judged the row before the abort)"
    done < <(awk -F'\t' -v k="${kill_at}" '$1 + 0 < k + 0' "${reads}")
    t="$(awk -F'\t' -v k="${kill_at}" '$1 + 0 < k + 0 { t = $1 } END { print t }' "${reads}")"
    awk -v t="${t}" -v k="${kill_at}" -v g="${HOLD_READ_GAP_S}" 'BEGIN { exit !(k - t <= g) }' \
        || fail "${step}: the last harness read of ${who} before its kill came $(seconds_between "${t}" "${kill_at}")s before it, more than ${HOLD_READ_GAP_S}s"
}

# one_abort_kill <step> <table> <srv> <id> <from>: exactly one `kill` of row
# <id> from any CSCB process after <from>, the bot server's, carrying no
# `--include-finished`; print its time.
one_abort_kill() {
    local step="$1" table="$2" srv="$3" id="$4" from="$5" n at
    n="$(count_calls "${table}" - "${id}" kill "${from}" -)"
    (( n == 1 )) || fail "${step}: ${n} kill call(s) of ${id} by a CSCB process in the leg, not one"
    at="$(first_call_at "${table}" "${srv}" "${id}" kill "${from}" -)"
    [[ -n "${at}" ]] || fail "${step}: the leg's kill of ${id} is not the bot server's"
    n="$(calls "${table}" "${srv}" "${id}" kill "${from}" - | cut -f5 | grep -cE -- '(^| )--?include-finished(=| |$)' || true)"
    (( n == 0 )) || fail "${step}: the bot server's kill of ${id} carries --include-finished"
    printf '%s\n' "${at}"
}


expect_relaunching_post_line() {
    local step="$1" line="$2" bound_at="$3" kill_at="$4" hits=() at
    mapfile -t hits < <(log_lines_equal "${log0}" "${line}")
    (( ${#hits[@]} == 1 )) || fail "${step}: ${#hits[@]} relaunching poster line(s), not one: ${line}"
    at="$(cut -f2 <<< "${hits[0]}")"
    awk -v p="${at}" -v b="${bound_at}" 'BEGIN { exit !(p + 0 >= b + 0) }' || fail "${step}: the relaunching post came before B"
    awk -v p="${at}" -v k="${kill_at}" 'BEGIN { exit !(p + 0 <= k + 0) }' || fail "${step}: the relaunching post came after the kill"
    printf '%s\n' "${at}"
}

# expect_no_held_posted <step> <lines>: no server.log line equals any of
# <lines> (`stuckLaunchHeldPostedLines`: every held poster line with the
# answer `posted`, in either form of the held text).
expect_no_held_posted() {
    local step="$1" n
    n="$(grep -cxF -f <(printf '%s\n' "$2") <(tail -n "+$(( log0 + 1 ))" "${SLACK_STATE_DIR}/server.log" | sed 's/^\[[^]]*\] //') || true)"
    (( n == 0 )) || fail "${step}: ${n} held poster line(s) with the answer posted"
}

# expect_no_counted_failure <step> <key>: no server.log line holding a
# COUNTED_FAILURE_HEADS fragment followed by persona <key>.
expect_no_counted_failure() {
    local step="$1" key="$2" head n
    for head in "${COUNTED_FAILURE_HEADS[@]}"; do
        n="$(log_hits "${log0}" "${head}${key}" | grep -c . || true)"
        (( n == 0 )) || fail "${step}: ${n} server.log line(s) holding '${head}${key}'"
    done
}

# ---------------------------------------------------------------------------
# Values from the installed package
# ---------------------------------------------------------------------------

G_S="$(fmk_text DEFAULT_AD_SETTINGS.tmux.pending_grace_seconds)" \
    || fail "setup: fmk-texts.ts could not print DEFAULT_AD_SETTINGS.tmux.pending_grace_seconds"
B_MS="$(fmk_text 'adLaunchBoundMs(DEFAULT_AD_SETTINGS_IN_EFFECT)')" \
    || fail "setup: fmk-texts.ts could not print adLaunchBoundMs(DEFAULT_AD_SETTINGS_IN_EFFECT)"
RETRY_BASE_S="$(fmk_text UNAVAILABLE_RETRY_BASE_S)" || fail "setup: fmk-texts.ts could not print UNAVAILABLE_RETRY_BASE_S"
RETRY_CEILING_S="$(fmk_text UNAVAILABLE_RETRY_CEILING_S)" || fail "setup: fmk-texts.ts could not print UNAVAILABLE_RETRY_CEILING_S"
PENDING_ROW_HEAD="$(fmk_text PENDING_ROW_RULE_LOG_HEAD)" || fail "setup: fmk-texts.ts could not print PENDING_ROW_RULE_LOG_HEAD"
NOT_JUDGED="$(fmk_text PENDING_ROW_RUN_NOT_JUDGED)" || fail "setup: fmk-texts.ts could not print PENDING_ROW_RUN_NOT_JUDGED"
ORIGIN_RETRY="$(fmk_text PENDING_ROW_RULE_ORIGIN_RETRY)" || fail "setup: fmk-texts.ts could not print PENDING_ROW_RULE_ORIGIN_RETRY"
[[ -n "${NOT_JUDGED}" && -n "${ORIGIN_RETRY}" ]] || fail "setup: fmk-texts.ts printed an empty value"
[[ "${G_S}" =~ ^[1-9][0-9]*$ ]] || fail "setup: G '${G_S}' is not a whole number of seconds"
[[ "${B_MS}" =~ ^[1-9][0-9]*$ ]] || fail "setup: B '${B_MS}' is not a whole number of milliseconds"
[[ "${RETRY_BASE_S}" =~ ^[1-9][0-9]*$ && "${RETRY_CEILING_S}" =~ ^[1-9][0-9]*$ ]] \
    || fail "setup: the retry base '${RETRY_BASE_S}' or ceiling '${RETRY_CEILING_S}' is not a whole number of seconds"
B_S=$(( (B_MS + 999) / 1000 ))
(( G_S > RETRY_BASE_S )) || fail "setup: G ${G_S}s is not longer than the retry timer's first wait ${RETRY_BASE_S}s"
(( B_S > G_S )) || fail "setup: B ${B_S}s is not longer than G ${G_S}s"
RUN_GAP_MIN_S=$(( 2 * RETRY_BASE_S ))
ABORT_WAIT_S=$(( B_S + RETRY_CEILING_S + ABORT_SLACK_S ))
RELAUNCH_WAIT_S=$(( B_S + 2 * RETRY_CEILING_S + RELAUNCH_SLACK_S ))
OTHER_START_AFTER_S=$(( B_S - 3 * RETRY_BASE_S + OTHER_START_MARGIN_S ))
(( OTHER_START_AFTER_S > 0 && OTHER_START_AFTER_S + RETRY_BASE_S >= G_S )) \
    || fail "setup: the other-process leg's start ${OTHER_START_AFTER_S}s after the launch start leaves its first retry before G ${G_S}s"
HELD_WAIT_S=$(( B_S + RETRY_CEILING_S + HELD_SLACK_S ))
AGAIN_WAIT_S=$(( RETRY_CEILING_S + HELD_SLACK_S ))
echo "${TEST_NAME}: G ${G_S}s, B ${B_S}s (${B_MS}ms), retry base ${RETRY_BASE_S}s, ceiling ${RETRY_CEILING_S}s; own-launch leg: abort bound ${ABORT_WAIT_S}s, relaunch bound ${RELAUNCH_WAIT_S}s, runs at least ${RUN_GAP_MIN_S}s apart; other-process leg: start ${OTHER_START_AFTER_S}s after the launch start, held-post bound ${HELD_WAIT_S}s, next-retry bound ${AGAIN_WAIT_S}s"

RELAUNCHING_POST="$(fmk_text stuckLaunchRelaunchingPost "${P_NAME}" "${P_KEY}" "${B_MS}")" \
    || fail "setup: fmk-texts.ts could not print stuckLaunchRelaunchingPost"
P_RELAUNCHING_POSTED="$(fmk_text stuckLaunchPostLine "${P_KEY}" relaunching posted)" \
    || fail "setup: fmk-texts.ts could not print stuckLaunchPostLine for P"
P_HELD_POSTED_LINES="$(fmk_text stuckLaunchHeldPostedLines "${P_KEY}")" || fail "setup: fmk-texts.ts could not print stuckLaunchHeldPostedLines for P"
P_RETRY_ROUND_HEAD="$(fmk_text pendingRowRuleRoundLineHead "${P_REF}" "${ORIGIN_RETRY}")" \
    || fail "setup: fmk-texts.ts could not print pendingRowRuleRoundLineHead for the retry origin"
ABORT_KILL_HEAD="$(fmk_text stuckLaunchAbortKillSucceededHead "${P_KEY}")" \
    || fail "setup: fmk-texts.ts could not print stuckLaunchAbortKillSucceededHead"
MARKED_MISSING_LINES="$(fmk_text liveRowSequenceStep3MarkedMissingLines "${P_REF}")" \
    || fail "setup: fmk-texts.ts could not print liveRowSequenceStep3MarkedMissingLines"
Q_HELD_POSTED="$(fmk_text stuckLaunchPostLine "${Q_KEY}" held posted)" || fail "setup: fmk-texts.ts could not print stuckLaunchPostLine for Q"
Q_HELD_AGAIN="$(fmk_text stuckLaunchPostLine "${Q_KEY}" held already-posted)" \
    || fail "setup: fmk-texts.ts could not print stuckLaunchPostLine for Q"
Q_RELAUNCHING_POSTED="$(fmk_text stuckLaunchPostLine "${Q_KEY}" relaunching posted)" \
    || fail "setup: fmk-texts.ts could not print stuckLaunchPostLine for Q"
for v in RELAUNCHING_POST P_RELAUNCHING_POSTED P_HELD_POSTED_LINES P_RETRY_ROUND_HEAD \
    ABORT_KILL_HEAD MARKED_MISSING_LINES Q_HELD_POSTED Q_HELD_AGAIN Q_RELAUNCHING_POSTED; do
    [[ -n "${!v}" ]] || fail "setup: fmk-texts.ts printed an empty ${v}"
done
# Every held poster line is one non-empty line.
! grep -qx '' <<< "${P_HELD_POSTED_LINES}" || fail "setup: fmk-texts.ts printed an empty held poster line for P"

# A zero count of a counted-failure fragment means something only if the
# installed package writes it.
[[ -f "${INSTALLED_PKG_DIR}/src/restart.ts" ]] || fail "setup: the installed package has no src/restart.ts under ${INSTALLED_PKG_DIR}"
for t in "${COUNTED_FAILURE_HEADS[@]}"; do
    grep -qF -- "${t}" "${INSTALLED_PKG_DIR}/src/restart.ts" \
        || fail "setup: the installed package's src/restart.ts does not hold the counted-failure fragment '${t}'; the no-counted-failure checks would count nothing"
done

# The relabelled-session and grouped-viewer legs' values.
NOT_THIS_LAUNCH_PHRASE="$(fmk_text CONFLICT_NOT_THIS_LAUNCH_PHRASE)" || fail "setup: fmk-texts.ts could not print CONFLICT_NOT_THIS_LAUNCH_PHRASE"
RECHECK_MS="$(fmk_text LATCH_RECHECK_INTERVAL_MS)" || fail "setup: fmk-texts.ts could not print LATCH_RECHECK_INTERVAL_MS"
[[ "${RECHECK_MS}" =~ ^[1-9][0-9]*$ ]] || fail "setup: the latch re-check interval '${RECHECK_MS}' is not a whole number of milliseconds"
RECHECK_S=$(( (RECHECK_MS + 999) / 1000 ))
R_RELAUNCHING_POST="$(fmk_text stuckLaunchRelaunchingPost "${R_NAME}" "${R_KEY}" "${B_MS}")" \
    || fail "setup: fmk-texts.ts could not print stuckLaunchRelaunchingPost for R"
R_RELAUNCHING_POSTED="$(fmk_text stuckLaunchPostLine "${R_KEY}" relaunching posted)" || fail "setup: fmk-texts.ts could not print stuckLaunchPostLine for R"
R_HELD_POSTED_LINES="$(fmk_text stuckLaunchHeldPostedLines "${R_KEY}")" || fail "setup: fmk-texts.ts could not print stuckLaunchHeldPostedLines for R"
R_ABORT_CONFLICT_HEAD="$(fmk_text stuckLaunchAbortKillConflictHead "${R_KEY}")" \
    || fail "setup: fmk-texts.ts could not print stuckLaunchAbortKillConflictHead"
R_ABORT_SUCCEEDED_HEAD="$(fmk_text stuckLaunchAbortKillSucceededHead "${R_KEY}")" \
    || fail "setup: fmk-texts.ts could not print stuckLaunchAbortKillSucceededHead for R"
R_LATCHED_HEAD="$(fmk_text conflictLatchSetLineHead "${R_KEY}" latched)" || fail "setup: fmk-texts.ts could not print conflictLatchSetLineHead"
R_RELATCHED_HEAD="$(fmk_text conflictLatchSetLineHead "${R_KEY}" relatched)" || fail "setup: fmk-texts.ts could not print conflictLatchSetLineHead"
R_RECHECK_HEAD="$(fmk_text latchRecheckNotThisLaunchRoundHead "${R_REF}")" \
    || fail "setup: fmk-texts.ts could not print latchRecheckNotThisLaunchRoundHead"
V_RELAUNCHING_POST="$(fmk_text stuckLaunchRelaunchingPost "${V_NAME}" "${V_KEY}" "${B_MS}")" \
    || fail "setup: fmk-texts.ts could not print stuckLaunchRelaunchingPost for V"
V_RELAUNCHING_POSTED="$(fmk_text stuckLaunchPostLine "${V_KEY}" relaunching posted)" || fail "setup: fmk-texts.ts could not print stuckLaunchPostLine for V"
V_ABORT_KILL_HEAD="$(fmk_text stuckLaunchAbortKillSucceededHead "${V_KEY}")" \
    || fail "setup: fmk-texts.ts could not print stuckLaunchAbortKillSucceededHead for V"
for v in NOT_THIS_LAUNCH_PHRASE R_RELAUNCHING_POST R_RELAUNCHING_POSTED R_HELD_POSTED_LINES R_ABORT_CONFLICT_HEAD \
    R_ABORT_SUCCEEDED_HEAD R_LATCHED_HEAD R_RELATCHED_HEAD R_RECHECK_HEAD V_RELAUNCHING_POST V_RELAUNCHING_POSTED V_ABORT_KILL_HEAD \
    ; do
    [[ -n "${!v}" ]] || fail "setup: fmk-texts.ts printed an empty ${v}"
done
! grep -qx '' <<< "${R_HELD_POSTED_LINES}" || fail "setup: fmk-texts.ts printed an empty held poster line for R"
echo "${TEST_NAME}: relabelled-session and grouped-viewer legs: latch re-check interval ${RECHECK_S}s, re-check bound ${RECHECK_S}s + ${RECHECK_SLACK_S}s after the latch"

# ---------------------------------------------------------------------------
# The own-launch leg: CSCB's own resumed launch, aborted once at B and resumed
# ---------------------------------------------------------------------------

leg_own_stuck_launch() {
    local step="own stuck launch" creds="${SCENARIO_ROOT}/credentials-own" creds_file work sid session srv log0 posts0 leg_start
    local l_ms l_s g_at b_at worker deadline kill_at live_at="" reads="${SCENARIO_ROOT}/own-reads.tsv"
    local table="${SCENARIO_ROOT}/own-calls.tsv" lines=() fms=() hits=() n i bound_at stop_run_at gap
    local post_at resume_at fm_after get_at relaunch_at marked_at relaunched="" retry_rounds stop_rounds

    new_state_dir own
    mkdir -m 700 "${creds}"
    start_slack_stub "${SCENARIO_ROOT}/slack-stub-own" "${P_SUFFIX}"
    work="$(make_workdir own)"
    stub_mode "${work}" "${STUB_MODE_AT_ONCE}"
    creds_file="$(write_credentials "${creds}" "${P_SUFFIX}")"
    write_personas_config "$(persona_json "${P_NAME}" "${creds_file}" "${work}" "${P_CHANNEL}")"

    # Step 1: the live start brings P up.
    start_server --live
    bring_up "${step}: the bring-up" "${P_ID}" "${P_REF}"
    sid="${BROUGHT_UP_SID}"

    # Step 2: a plain stop, then [harness] the worker ends with the sentinel.
    stop_server
    end_worker "${P_ID}" "${step}: the worker"
    [[ "${ROW_SID}" == "${sid}" ]] || fail "${step}: the ${ROW_STATE} row's session_id is '${ROW_SID}', not the live row's ${sid}"
    echo "${TEST_NAME}: ${step}: after the sentinel the row reads ${ROW_STATE} with session_id ${ROW_SID}"

    stub_mode "${work}" "${STUB_MODE_MANUAL_START}"
    log0="$(line_count "${SLACK_STATE_DIR}/server.log")"
    posts0="$(( $(line_count "${SLACK_RECORD}") + 1 ))"
    leg_start="$(now_s)"
    start_server --live
    srv="${SERVER_PID}"

    # Step 4 [harness]: pending, the same session id, a launch start L; the pane holds no needle.
    wait_until "${START_WAIT_S}" "${step}: row ${P_ID} never read pending after the start" \
        row_of_reads "${P_ID}" "${step}: the resume" pending
    [[ "${ROW_SID}" == "${sid}" ]] || fail "${step}: the pending row's session_id is '${ROW_SID}', not the kept ${sid}"
    l_ms="$(launch_ms "${ROW_LAUNCH}")" || fail "${step}: the pending row's launch_started_at '${ROW_LAUNCH}' does not parse"
    l_s="$(ms_to_s "${l_ms}")"
    g_at="$(plus_s "${l_s}" "${G_S}")"
    b_at="$(ms_to_s "$(( l_ms + B_MS ))")"
    session="${ROW_SESSION}"
    [[ -n "${session}" ]] || fail "${step}: the pending row names no tmux session"
    echo "${TEST_NAME}: ${step}: the held row reads pending, session_id ${ROW_SID}, launch_started_at ${ROW_LAUNCH}"
    hold_pending_worker "${step}: the held launch" "${session}"
    worker="$(pane_pid_of "${step}" "${session}")"

    # Step 5 [harness]: the next launch in P's directory reports in at once.
    stub_mode "${work}" "${STUB_MODE_AT_ONCE}"

    # Step 6 [harness]: read the row until the bot server's kill, bounded from L.
    : > "${reads}"
    deadline=$(( l_ms + ABORT_WAIT_S * 1000 ))
    while ! server_killed "${P_ID}" "${srv}"; do
        poll_row_of "${P_ID}" "${step}: the hold"
        printf '%s\t%s\t%s\n' "${ROW_READ_AT}" "${ROW_STATE}" "${ROW_LAUNCH}" >> "${reads}"
        (( $(_scenario_now_ms) < deadline )) \
            || fail "${step}: no bot-server kill of ${P_ID} within ${ABORT_WAIT_S}s of its launch start (B and ${ABORT_SLACK_S}s)"
        sleep "${HOLD_POLL_S}"
    done

    # Step 7 [harness]: read the row until it is live, bounded from L.
    deadline=$(( l_ms + RELAUNCH_WAIT_S * 1000 ))
    while :; do
        poll_row_of "${P_ID}" "${step}: the relaunch"
        printf '%s\t%s\t%s\n' "${ROW_READ_AT}" "${ROW_STATE}" "${ROW_LAUNCH}" >> "${reads}"
        case "${ROW_STATE}" in
            absent | ended | missing | pending) ;;
            *)
                live_at="${ROW_READ_AT}"
                break ;;
        esac
        (( $(_scenario_now_ms) < deadline )) \
            || fail "${step}: row ${P_ID} not live ${RELAUNCH_WAIT_S}s after its launch start (B, the retry ceiling and ${RELAUNCH_SLACK_S}s)"
        sleep "${HOLD_POLL_S}"
    done
    [[ "${ROW_STATE}" == waiting ]] || fail "${step}: the relaunched row came up ${ROW_STATE}, not waiting"
    [[ "${ROW_SID}" == "${sid}" ]] || fail "${step}: the relaunched row's session_id is '${ROW_SID}', not the kept ${sid}"
    wait_until "${CONNECT_WAIT_S}" "${step}: the server never registered the relaunched stub's session as P's" \
        log_fragment_seen "${log0}" "[slack] Session connected: persona ${P_REF}"
    echo "${TEST_NAME}: ${step}: the row read ${ROW_STATE} $(seconds_between "${l_s}" "${live_at}")s after its launch start, session_id ${ROW_SID}; the harness reads in order (recorded): $(cut -f2 "${reads}" | uniq -c | awk '{ printf "%s x%s; ", $2, $1 }')"

    # Step 8: the checks, over the bot server's calls (`call_table`).
    call_table "${table}"
    echo "${TEST_NAME}: ${step}: the start pass's summary (recorded): $(log_hits "${log0}" "$(completion_match 1)" | tail -n 1 | cut -f3)"
    echo "${TEST_NAME}: ${step}: the bot server's calls of ${P_ID} in the leg, by verb (recorded): $(calls "${table}" "${srv}" "${P_ID}" - "${leg_start}" - | cut -f3 | sort | uniq -c | awk '{ printf "%s x%s; ", $2, $1 }')"
    echo "${TEST_NAME}: ${step}: the bot server's calls of ${P_ID} other than status and read-pane, from L (recorded): $(calls "${table}" "${srv}" "${P_ID}" - "${leg_start}" - | awk -F'\t' -v l="${l_s}" '$3 != "status" && $3 != "read-pane" { a = $5; sub(/ --label .*/, " …", a); printf "%+.1fs %s [%s]; ", $1 - l, $3, a }')"
    echo "${TEST_NAME}: ${step}: the bot server's find-missing runs, from L (recorded): $(calls "${table}" "${srv}" - find-missing - - | awk -F'\t' -v l="${l_s}" '{ printf "%+.1fs ", $1 - l }')"

    # The one kill: the bot server's, no --include-finished.
    kill_at="$(one_abort_kill "${step}" "${table}" "${srv}" "${P_ID}" "${leg_start}")" || exit 1
    echo "${TEST_NAME}: ${step}: the abort kill at +$(seconds_between "${l_s}" "${kill_at}")s from L (B is +${B_S}s)"

    # The row stayed pending with launch start L until the kill.
    reads_before_kill_pending "${step}" "${reads}" "${kill_at}" "${l_ms}" "${l_s}" P

    # No bot-server find-missing from L to G after it.
    n="$(count_calls "${table}" "${srv}" - find-missing "${l_s}" "$(plus_s "${g_at}" -0.001)")"
    (( n == 0 )) || fail "${step}: the bot server ran find-missing ${n} time(s) between P's launch start and G after it"

    # The timer owns the abort after B; no automatic pane/key activity occurs.
    bound_at="${b_at}"
    before "${b_at}" "$(plus_s "${kill_at}" 0.001)" || fail "${step}: abort came before B"
    for verb in read-pane send-keys; do
        n="$(count_calls "${table}" "${srv}" "${P_ID}" "${verb}" "${l_s}" "${kill_at}")"
        (( n == 0 )) || fail "${step}: ${n} automatic ${verb} call(s) during pending launch"
    done

    # The find-missing runs from G to the kill.
    mapfile -t fms < <(calls "${table}" "${srv}" - find-missing "${g_at}" "${kill_at}" | cut -f1)
    stop_run_at="$(first_call_at "${table}" "${srv}" - find-missing "${bound_at}" "${kill_at}")"
    [[ -n "${stop_run_at}" ]] || fail "${step}: no bot-server find-missing between B and the kill"
    [[ "${fms[-1]}" == "${stop_run_at}" ]] \
        || fail "${step}: $(( ${#fms[@]} )) find-missing run(s) from G to the kill, and the abort retry is not the last before the kill"
    (( ${#fms[@]} >= 1 )) || fail "${step}: no retry find-missing run after G"
    for (( i = 1; i < ${#fms[@]}; i++ )); do
        gap="$(seconds_between "${fms[i - 1]}" "${fms[i]}")"
        awk -v g="${gap}" -v m="${RUN_GAP_MIN_S}" 'BEGIN { exit !(g + 0 >= m + 0) }' \
            || fail "${step}: two bot-server find-missing runs before the abort only ${gap}s apart, closer than ${RUN_GAP_MIN_S}s"
    done
    # Each retry's run: one pending-row rule line of origin retry, its run not judged.
    retry_rounds="$(log_hits "${log0}" "${P_RETRY_ROUND_HEAD}" "find-missing: " \
        | awk -F'\t' -v k="${kill_at}" '$2 + 0 <= k + 0')"
    n="$(grep -c . <<< "${retry_rounds}" || true)"
    (( n == ${#fms[@]} - 1 )) || {
        sed 's/^/  | /' <<< "${retry_rounds}" >&2
        fail "${step}: ${n} retry-origin pending-row rule round line(s) with a run before the kill, for $(( ${#fms[@]} - 1 )) retry run(s)"
    }
    n="$(grep -cvF -- "find-missing: ${NOT_JUDGED}" <<< "${retry_rounds}" || true)"
    (( n == 0 )) || fail "${step}: ${n} retry-origin rule round(s) before the abort did not read the run as not judged"
    post_at="$(expect_relaunching_post_line "${step}" "${P_RELAUNCHING_POSTED}" "${bound_at}" "${kill_at}")" || exit 1
    expect_no_held_posted "${step}" "${P_HELD_POSTED_LINES}"
    mapfile -t lines < <(record_posts "${posts0}")
    (( ${#lines[@]} == 1 )) || {
        printf '  | %s\n' "${lines[@]}" >&2
        fail "${step}: ${#lines[@]} post(s) in the Slack stub's record from the start on, not the relaunching post alone"
    }
    jq -e --arg want "${RELAUNCHING_POST}" '.text == $want' <<< "${lines[0]}" > /dev/null || {
        printf '  | %s\n' "${lines[0]}" >&2
        fail "${step}: the leg's post is not the relaunching post for P: ${RELAUNCHING_POST}"
    }

    # kill_sent true (the abort kill's line), and the worker's process gone.
    mapfile -t hits < <(log_lines_starting "${log0}" "${ABORT_KILL_HEAD}")
    (( ${#hits[@]} == 1 )) || fail "${step}: ${#hits[@]} abort kill line(s) starting '${ABORT_KILL_HEAD}', not one"
    echo "${TEST_NAME}: ${step}: the abort's lines (recorded): $(log_hits "${log0}" "[slack] pending-row: persona=${P_KEY} stuck-launch" | cut -f3 | cut -c1-260 | tr '\n' '|')"
    wait_until "${GONE_WAIT_S}" "${step}: P's worker process ${worker} still runs ${GONE_WAIT_S}s after the kill" \
        pid_gone "${worker}"
    if [[ -f "${HOME}/.config/agent-director/ad-trail.jsonl" ]]; then
        echo "${TEST_NAME}: ${step}: the trail's kill records for ${P_ID} (recorded): $(jq -c --arg id "${P_ID}" 'select(.event == "ad.kill.called" and .instance_id == $id)' "${HOME}/.config/agent-director/ad-trail.jsonl" 2> /dev/null | cut -c1-400 | tr '\n' '|')"
    fi

    # After the kill: a find-missing, the sequence's run marking the row missing, a get, then the resume.
    n="$(count_calls "${table}" "${srv}" "${P_ID}" resume "${leg_start}" "${kill_at}")"
    (( n == 1 )) || fail "${step}: ${n} bot-server resume(s) of ${P_ID} before the kill, not the start pass's one"
    resume_at="$(first_call_at "${table}" "${srv}" "${P_ID}" resume "${kill_at}" -)"
    [[ -n "${resume_at}" ]] || fail "${step}: no bot-server resume of ${P_ID} after the kill"
    n="$(count_calls "${table}" "${srv}" "${P_ID}" resume "${kill_at}" -)"
    (( n == 1 )) || fail "${step}: ${n} bot-server resume(s) of ${P_ID} after the kill, not one"
    fm_after="$(calls "${table}" "${srv}" - find-missing "${kill_at}" "${resume_at}" | tail -n 1 | cut -f1)"
    [[ -n "${fm_after}" ]] || fail "${step}: no bot-server find-missing between the kill and the resume"
    get_at="$(first_call_at "${table}" "${srv}" "${P_ID}" get "${fm_after}" "${resume_at}")"
    [[ -n "${get_at}" ]] || fail "${step}: no bot-server get of ${P_ID} between its last find-missing and the resume"
    mapfile -t hits < <(grep -nxF -f <(printf '%s\n' "${MARKED_MISSING_LINES}") <(sed -n "$(( log0 + 1 )),\$p" "${SLACK_STATE_DIR}/server.log" | sed 's/^\[[^]]*\] //') || true)
    (( ${#hits[@]} == 1 )) || fail "${step}: ${#hits[@]} live-row sequence run line(s) marking P's row missing, not one"
    marked_at="$(log_hits "$(( log0 + ${hits[0]%%:*} - 1 ))" "" | sed -n 1p | cut -f2)"
    awk -v m="${marked_at}" -v k="${kill_at}" -v r="${resume_at}" 'BEGIN { exit !(m + 0 >= k + 0 && m + 0 <= r + 0) }' \
        || fail "${step}: the sequence's marked-missing run line is not between the kill and the resume"
    n="$(count_calls "${table}" "${srv}" "${P_ID}" spawn "${leg_start}" - --reuse-finished)"
    (( n == 0 )) || fail "${step}: the bot server made ${n} reuse spawn(s) of ${P_ID}"
    relaunch_at="$(first_call_at "${table}" "${srv}" "${P_ID}" resume "${leg_start}" -)"
    n="$(count_calls "${table}" "${srv}" "${P_ID}" spawn "${relaunch_at}" -)"
    (( n == 0 )) || fail "${step}: the bot server made ${n} spawn(s) of ${P_ID} after the start pass's resume"
    echo "${TEST_NAME}: ${step}: after the kill: find-missing +$(seconds_between "${kill_at}" "${fm_after}")s, marked missing +$(seconds_between "${kill_at}" "${marked_at}")s, get +$(seconds_between "${kill_at}" "${get_at}")s, resume +$(seconds_between "${kill_at}" "${resume_at}")s"
    echo "${TEST_NAME}: ${step}: the live-row sequence's lines (recorded): $(log_hits "${log0}" "[slack] live-row-sequence: ${P_REF}" | cut -f3 | cut -c1-240 | tr '\n' '|')"

    # No counted failure.
    expect_no_counted_failure "${step}" "${P_KEY}"

    # Recorded, not asserted.
    relaunched="$(pane_pid_of "${step}" "${session}" 2> /dev/null || true)"
    echo "${TEST_NAME}: ${step}: the relaunched worker's process (recorded): ${relaunched:-none} (the held one was ${worker})"
    echo "${TEST_NAME}: ${step}: P's retry-timer and pending-row rule lines (recorded): $(log_hits "${log0}" "" | cut -f3 | grep -F -e "[slack] unavailable-retry: persona=${P_KEY} " -e "${PENDING_ROW_HEAD} ${P_REF} " | cut -c1-300 | tr '\n' '|')"
    echo "${TEST_NAME}: ${step}: startup-errors.log lines naming P (recorded): $(grep -F -- "${P_REF}" "${SLACK_STATE_DIR}/startup-errors.log" 2> /dev/null | cut -c1-300 | tr '\n' '|')"

    stop_server
    end_worker "${P_ID}" "${step}: the end"
    stop_tracked_pid "${SLACK_STUB_PID}" 10 "${step}: the Slack stub did not exit on SIGTERM"
}

# ---------------------------------------------------------------------------
# The other-process leg: a pending row the server did not launch, one held
# post and no kill
# ---------------------------------------------------------------------------

leg_other_process() {
    local step="other process" creds="${SCENARIO_ROOT}/credentials-other" creds_file work sid session srv log0 posts0
    local l_ms l_s start_at resume_lines=() lines=() hits=() n table="${SCENARIO_ROOT}/other-calls.tsv"
    local held_at again_at spawn_at wait_s held_post

    new_state_dir other
    mkdir -m 700 "${creds}"
    start_slack_stub "${SCENARIO_ROOT}/slack-stub-other" "${Q_SUFFIX}"
    work="$(make_workdir other)"
    stub_mode "${work}" "${STUB_MODE_AT_ONCE}"
    creds_file="$(write_credentials "${creds}" "${Q_SUFFIX}")"
    write_personas_config "$(persona_json "${Q_NAME}" "${creds_file}" "${work}" "${Q_CHANNEL}")"

    # Step 1: the live start brings Q up.
    start_server --live
    bring_up "${step}: the bring-up" "${Q_ID}" "${Q_REF}"
    sid="${BROUGHT_UP_SID}"

    # Step 2: a plain stop, then [harness] the worker ends with the sentinel.
    stop_server
    end_worker "${Q_ID}" "${step}: the worker"
    [[ "${ROW_SID}" == "${sid}" ]] || fail "${step}: the ${ROW_STATE} row's session_id is '${ROW_SID}', not the live row's ${sid}"

    stub_mode "${work}" "${STUB_MODE_MANUAL_START}"

    # Step 4 [harness, playing another process]: the harness's own resume of Q,
    # from the scenario's own shell.
    ad_capture resume --instance-id "${Q_ID}"
    (( AD_RC == 0 )) || fail "${step}: the harness's resume of ${Q_ID} exited ${AD_RC}: $(head -c 300 "${AD_ERR}")"
    wait_until "${REPORT_WAIT_S}" "${step}: row ${Q_ID} never read pending after the harness's resume" \
        row_of_reads "${Q_ID}" "${step}: the harness's resume" pending
    [[ "${ROW_SID}" == "${sid}" ]] || fail "${step}: the pending row's session_id is '${ROW_SID}', not the kept ${sid}"
    l_ms="$(launch_ms "${ROW_LAUNCH}")" || fail "${step}: the pending row's launch_started_at '${ROW_LAUNCH}' does not parse"
    l_s="$(ms_to_s "${l_ms}")"
    session="${ROW_SESSION}"
    [[ -n "${session}" ]] || fail "${step}: the pending row names no tmux session"
    echo "${TEST_NAME}: ${step}: the harness's resume left the row pending, launch_started_at ${ROW_LAUNCH} (rendered $(fmk_text describeLaunchStartForLog "${ROW_LAUNCH}"))"
    hold_pending_worker "${step}: the held launch" "${session}"
    held_post="$(fmk_text stuckLaunchHeldPost "${Q_NAME}" "${Q_KEY}" "${ROW_LAUNCH}" false)" \
        || fail "${step}: fmk-texts.ts could not print stuckLaunchHeldPost"

    # Step 5 [harness]: the live start at L + OTHER_START_AFTER_S.
    wait_s="$(awk -v l="${l_s}" -v d="${OTHER_START_AFTER_S}" -v n="$(now_s)" 'BEGIN { w = l + d - n; printf "%.3f\n", (w > 0 ? w : 0) }')"
    echo "${TEST_NAME}: ${step}: the start comes ${OTHER_START_AFTER_S}s after the launch start (in ${wait_s}s)"
    sleep "${wait_s}"
    log0="$(line_count "${SLACK_STATE_DIR}/server.log")"
    posts0="$(( $(line_count "${SLACK_RECORD}") + 1 ))"
    start_at="$(now_s)"
    start_server --live
    srv="${SERVER_PID}"
    wait_for_count "$(completion_match 1)" 2 "${START_WAIT_S}" "${step}: the start pass never completed"

    # Step 6 [harness]: the held post, then a later retry's held text not posted again.
    wait_until "$(( HELD_WAIT_S - OTHER_START_AFTER_S ))" "${step}: no held post for Q within ${HELD_WAIT_S}s of its launch start" \
        poster_line_seen "${log0}" "${Q_HELD_POSTED}"
    held_at="$(log_lines_equal "${log0}" "${Q_HELD_POSTED}" | sed -n 1p | cut -f2)"
    echo "${TEST_NAME}: ${step}: the held post at +$(seconds_between "${l_s}" "${held_at}")s from L"
    wait_until "${AGAIN_WAIT_S}" "${step}: no later retry reached the held text within ${AGAIN_WAIT_S}s of the held post" \
        poster_line_seen "${log0}" "${Q_HELD_AGAIN}"
    again_at="$(log_lines_equal "${log0}" "${Q_HELD_AGAIN}" | sed -n 1p | cut -f2)"
    echo "${TEST_NAME}: ${step}: a later retry reached the held text at +$(seconds_between "${held_at}" "${again_at}")s after the held post and posted nothing"

    # Step 7: the checks.
    call_table "${table}"
    echo "${TEST_NAME}: ${step}: the start pass's summary (recorded): $(log_hits "${log0}" "$(completion_match 1)" | tail -n 1 | cut -f3)"
    echo "${TEST_NAME}: ${step}: the bot server's calls of ${Q_ID} from L (recorded): $(calls "${table}" "${srv}" "${Q_ID}" - - - | awk -F'\t' -v l="${l_s}" '{ a = $5; sub(/ --label .*/, " …", a); printf "%+.1fs %s [%s]; ", $1 - l, $3, a }')"
    echo "${TEST_NAME}: ${step}: the bot server's find-missing runs, from L (recorded): $(calls "${table}" "${srv}" - find-missing - - | awk -F'\t' -v l="${l_s}" '{ printf "%+.1fs ", $1 - l }')"
    # The only resume of Q's row: the harness's, its parent the scenario's own shell.
    mapfile -t resume_lines < <(awk -F'\t' -v id="${Q_ID}" '$1 == "call" && $6 ~ /(^| )resume( |$)/ && index($6, id)' "${SCENARIO_AD_SHIM_LOG}")
    (( ${#resume_lines[@]} == 1 )) || {
        printf '  | %s\n' "${resume_lines[@]}" >&2
        fail "${step}: ${#resume_lines[@]} resume call(s) of ${Q_ID} from any process, not the harness's one"
    }
    [[ "$(cut -f4 <<< "${resume_lines[0]}")" == "$$" ]] \
        || fail "${step}: the one resume of ${Q_ID} is not the scenario shell's ($$): ${resume_lines[0]}"
    # No reuse spawn, resume or kill from a CSCB process; the one plain spawn collided.
    n="$(count_calls "${table}" - "${Q_ID}" resume - -)"
    (( n == 0 )) || fail "${step}: ${n} resume(s) of ${Q_ID} by a CSCB process"
    n="$(count_calls "${table}" - "${Q_ID}" spawn - - --reuse-finished)"
    (( n == 0 )) || fail "${step}: ${n} reuse spawn(s) of ${Q_ID} by a CSCB process"
    n="$(count_calls "${table}" - "${Q_ID}" kill "${start_at}" -)"
    (( n == 0 )) || fail "${step}: ${n} kill call(s) of ${Q_ID} by a CSCB process in the leg"
    n="$(count_calls "${table}" "${srv}" "${Q_ID}" spawn - - '!--reuse-finished')"
    (( n == 1 )) || fail "${step}: the bot server made ${n} plain spawn(s) of ${Q_ID}, not its start pass's ladder's one"
    spawn_at="$(first_call_at "${table}" "${srv}" "${Q_ID}" spawn - -)"
    mapfile -t hits < <(log_hits "${log0}" "[slack] spawnForPersona: collision resolved, state=pending for ${Q_REF}" | cut -f2)
    (( ${#hits[@]} == 1 )) || fail "${step}: ${#hits[@]} collision line(s) reading Q's row pending, not one"
    before "${spawn_at}" "${hits[0]}" || fail "${step}: the collision line came before the bot server's plain spawn"
    # One held post, equal to the builder's for Q's launch start, with the attach remedy.
    mapfile -t lines < <(record_posts "${posts0}")
    (( ${#lines[@]} == 1 )) || {
        printf '  | %s\n' "${lines[@]}" >&2
        fail "${step}: ${#lines[@]} post(s) in the Slack stub's record from the start on, not the held post alone"
    }
    jq -e --arg want "${held_post}" '.text == $want' <<< "${lines[0]}" > /dev/null || {
        printf '  | %s\n' "${lines[0]}" >&2
        fail "${step}: the leg's post is not the held post for Q's launch start: ${held_post}"
    }
    mapfile -t hits < <(log_lines_equal "${log0}" "${Q_HELD_POSTED}")
    (( ${#hits[@]} == 1 )) || fail "${step}: ${#hits[@]} held poster line(s) for Q, not one"
    mapfile -t hits < <(log_lines_equal "${log0}" "${Q_RELAUNCHING_POSTED}")
    (( ${#hits[@]} == 0 )) || fail "${step}: ${#hits[@]} relaunching poster line(s) for Q"
    echo "${TEST_NAME}: ${step}: Q's retry-timer and pending-row rule lines (recorded): $(log_hits "${log0}" "" | cut -f3 | grep -F -e "[slack] unavailable-retry: persona=${Q_KEY} " -e "${PENDING_ROW_HEAD} ${Q_REF} rule (" -e "[slack] pending-row: persona=${Q_KEY} stuck-launch" | cut -c1-300 | tr '\n' '|')"

    # Step 8 [harness, playing a human]: Enter into Q's pane; the row reports in.
    stub_press_enter "${session}"
    wait_until "${REPORT_WAIT_S}" "${step}: row ${Q_ID} never read waiting after the harness's Enter" \
        row_of_reads "${Q_ID}" "${step}: after the Enter" waiting
    [[ "${ROW_SID}" == "${sid}" ]] || fail "${step}: the waiting row's session_id is '${ROW_SID}', not the kept ${sid}"
    mapfile -t lines < <(record_posts "${posts0}")
    (( ${#lines[@]} == 1 )) || fail "${step}: ${#lines[@]} post(s) in the leg after the Enter, not the one held post"
    call_table "${table}"
    n="$(count_calls "${table}" - "${Q_ID}" kill "${start_at}" -)"
    (( n == 0 )) || fail "${step}: ${n} kill call(s) of ${Q_ID} by a CSCB process in the leg"

    stop_server
    end_worker "${Q_ID}" "${step}: the end"
    stop_tracked_pid "${SLACK_STUB_PID}" 10 "${step}: the Slack stub did not exit on SIGTERM"
}

# ---------------------------------------------------------------------------
# The relabelled-session leg (persona R) and the grouped-viewer leg (persona
# V), in one server run: R's abort kill answered "not this launch's session",
# latching once and never retried; V's abort kill ending the worker though a
# grouped viewer is attached
# ---------------------------------------------------------------------------

# plan_relabel <step> <session>: the labels `relabel_session`
# (lib/scenario.sh) writes to make <session> an earlier launch of its own
# instance id, drawn and checked as it draws and checks them, with nothing
# written: RELABEL_SID and RELABEL_PANE (the session, and its worker pane:
# the one whose `@ad_pane` names the label's token), RELABEL_TOKEN (a fresh
# token other than the label's and the row's current launch token),
# RELABEL_OWNER (`ad_owner_label`, ending with the scenario store's own id
# from `ad_store_id`) and RELABEL_PANE_LABEL (`ad_pane_label`).
plan_relabel() {
    local step="$1: the relabel of $2" session="$2" cur store old id
    require_ci_image "${step}"
    require_scenario_home "${step}"
    _scenario_tmux_check "${step}"
    RELABEL_SID="$(_scenario_session_id "${step}" "${session}")" || exit 1
    cur="$(_scenario_tmux show-options -qv -t "${RELABEL_SID}" @ad_owner)" \
        || fail "${step}: could not read @ad_owner of ${RELABEL_SID}: $(_scenario_tmux_err)"
    store="$(ad_store_id)" || exit 1
    [[ "${cur}" =~ ^ad1\ ([0-9a-f]{16})\ (\$[0-9]+)\ (.+)\ ([0-9a-f]{16})$ \
        && "${BASH_REMATCH[2]}" == "${RELABEL_SID}" && "${BASH_REMATCH[4]}" == "${store}" ]] \
        || fail "${step}: session ${RELABEL_SID} carries no valid label of this store (its @ad_owner reads '${cur}')"
    old="${BASH_REMATCH[1]}"
    id="${BASH_REMATCH[3]}"
    _scenario_check_instance_id "${step}" "${id}"
    RELABEL_PANE="$(_scenario_worker_pane "${step}" "${RELABEL_SID}" "${old}")" || exit 1
    RELABEL_TOKEN="$(ad_new_token "${id}" "${old}")" || exit 1
    RELABEL_OWNER="$(ad_owner_label "${RELABEL_TOKEN}" "${RELABEL_SID}" "${id}" "${store}")" || exit 1
    RELABEL_PANE_LABEL="$(ad_pane_label "${RELABEL_TOKEN}" "${RELABEL_PANE}")" || exit 1
}

# write_relabel <step>: write plan_relabel's labels in one tmux invocation,
# the session's `@ad_owner` and its worker pane's `@ad_pane` as one command
# list. The tmux server runs a client's command list as one step, so no
# other client's command (agent-director's lookup, which reads `@ad_owner`,
# or its pane listing, which reads `@ad_pane`) comes between the two writes:
# every reader sees both labels old or both new. agent-director writes a
# session's two labels the same way (its "label by id" call).
write_relabel() {
    require_ci_image "$1"
    require_scenario_home "$1"
    _scenario_tmux_check "$1"
    _scenario_tmux set-option -t "${RELABEL_SID}" @ad_owner "${RELABEL_OWNER}" \; \
        set-option -p -t "${RELABEL_PANE}" @ad_pane "${RELABEL_PANE_LABEL}" \
        || fail "$1: could not set @ad_owner on ${RELABEL_SID} and @ad_pane on ${RELABEL_PANE} in one tmux invocation: $(_scenario_tmux_err)"
}

# check_relabelled_session: the relabelled-session leg's checks (step 9 of
# the header), over the shared run's locals.
check_relabelled_session() {
    local step="relabelled session" kill_at n hits=() lines=() bound_at post_at abort_line abort_rest latch_line latch_at
    local description want_line want_post recheck_at t

    # Exactly one kill of R's row, the bot server's, at the abort.
    kill_at="$(one_abort_kill "${step}" "${table}" "${srv}" "${R_ID}" "${leg_start}")" || exit 1
    echo "${TEST_NAME}: ${step}: the abort kill at +$(seconds_between "${r_l_s}" "${kill_at}")s from R's launch start (B is +${B_S}s)"

    # Until the kill the row read pending with launch start L: no find-missing run marked it before B.
    reads_before_kill_pending "${step}" "${r_reads}" "${kill_at}" "${r_l_ms}" "${r_l_s}" R

    bound_at="${r_b_at}"
    post_at="$(expect_relaunching_post_line "${step}" "${R_RELAUNCHING_POSTED}" "${bound_at}" "${kill_at}")" || exit 1
    expect_no_held_posted "${step}" "${R_HELD_POSTED_LINES}"

    # The kill answered CONFLICT, "not this launch's session": the abort kill's line for a latch.
    mapfile -t hits < <(log_lines_starting "${log0}" "${R_ABORT_CONFLICT_HEAD}")
    (( ${#hits[@]} == 1 )) || {
        log_hits "${log0}" "[slack] pending-row: persona=${R_KEY} stuck-launch abort" | cut -f3 | sed 's/^/  | /' >&2
        fail "${step}: ${#hits[@]} abort kill line(s) for R starting '${R_ABORT_CONFLICT_HEAD}' (CONFLICT, latched), not one"
    }
    abort_line="$(sed -n "$(cut -f1 <<< "${hits[0]}")p" "${SLACK_STATE_DIR}/server.log")"
    abort_rest="${abort_line#*"${R_ABORT_CONFLICT_HEAD}"}"
    [[ "${abort_rest}" == *"${NOT_THIS_LAUNCH_PHRASE}"* ]] \
        || fail "${step}: R's abort kill line does not carry '${NOT_THIS_LAUNCH_PHRASE}': ${abort_line}"
    before "${kill_at}" "$(plus_s "$(cut -f2 <<< "${hits[0]}")" 0.001)" || fail "${step}: R's abort kill line came before the kill"
    mapfile -t hits < <(log_lines_starting "${log0}" "${R_ABORT_SUCCEEDED_HEAD}")
    (( ${#hits[@]} == 0 )) || fail "${step}: ${#hits[@]} abort kill line(s) for R reading a success with kill_sent true"
    echo "${TEST_NAME}: ${step}: R's abort kill line: ${abort_line#*] }"
    echo "${TEST_NAME}: ${step}: the bot server's read-pane calls of ${R_ID} from the relabel to the kill (recorded): $(count_calls "${table}" "${srv}" "${R_ID}" read-pane "${relabel_at}" "${kill_at}")"

    # R latched once, with the case "not this launch's session", and never relatched.
    mapfile -t hits < <(log_lines_starting "${log0}" "${R_LATCHED_HEAD}")
    (( ${#hits[@]} == 1 )) || fail "${step}: ${#hits[@]} latch-set line(s) for R, not one"
    latch_at="$(cut -f2 <<< "${hits[0]}")"
    latch_line="$(sed -n "$(cut -f1 <<< "${hits[0]}")p" "${SLACK_STATE_DIR}/server.log")"
    latch_line="${latch_line#*] }"
    before "${kill_at}" "$(plus_s "${latch_at}" 0.001)" || fail "${step}: R latched before the abort kill: ${latch_line}"
    mapfile -t hits < <(log_lines_starting "${log0}" "${R_RELATCHED_HEAD}")
    (( ${#hits[@]} == 0 )) || fail "${step}: ${#hits[@]} relatch line(s) for R"
    description="$(log_message_of "${latch_line}")" || fail "${step}: R's latch-set line holds no message: ${latch_line}"
    [[ "${description}" == *"${NOT_THIS_LAUNCH_PHRASE}"* ]] \
        || fail "${step}: agent-director's description in R's latch does not carry '${NOT_THIS_LAUNCH_PHRASE}': ${description}"
    want_line="$(fmk_text conflictNotThisLaunchLatchedLine "${R_KEY}" "${description}")" \
        || fail "${step}: fmk-texts.ts could not print conflictNotThisLaunchLatchedLine"
    [[ "${latch_line}" == "${want_line}" ]] || fail "${step}: R's latch-set line is not the abort kill's not-this-launch latch: '${latch_line}', not '${want_line}'"
    echo "${TEST_NAME}: ${step}: R latched at +$(seconds_between "${kill_at}" "${latch_at}")s after the kill: ${latch_line}"

    # R's posts from the start on: the relaunching post, then one CONFLICT post.
    want_post="$(fmk_text conflictNotThisLaunchPost "${R_NAME}" "${R_KEY}" "${description}")" \
        || fail "${step}: fmk-texts.ts could not print conflictNotThisLaunchPost"
    mapfile -t lines < <(record_posts_of "${posts0}" "${R_SUFFIX}")
    (( ${#lines[@]} == 2 )) || {
        printf '  | %s\n' "${lines[@]}" >&2
        fail "${step}: ${#lines[@]} post(s) for R in the Slack stub's record from the start on, not the relaunching post and one CONFLICT post"
    }
    jq -e --arg want "${R_RELAUNCHING_POST}" '.text == $want' <<< "${lines[0]}" > /dev/null || {
        printf '  | %s\n' "${lines[0]}" >&2
        fail "${step}: R's first post is not its relaunching post: ${R_RELAUNCHING_POST}"
    }
    jq -e --arg want "${want_post}" '.text == $want' <<< "${lines[1]}" > /dev/null || {
        printf '  | %s\n' "${lines[1]}" >&2
        fail "${step}: R's second post is not the CONFLICT post for its not-this-launch latch: ${want_post}"
    }

    # Never retried: a re-check after the latch, and still the one kill.
    mapfile -t hits < <(log_lines_starting "${log0}" "${R_RECHECK_HEAD}")
    (( ${#hits[@]} >= 1 )) || fail "${step}: no latch re-check round line for R"
    recheck_at="$(cut -f2 <<< "${hits[0]}")"
    before "${latch_at}" "${recheck_at}" || fail "${step}: R's first re-check round line came before its latch"
    n="$(count_calls "${table}" - "${R_ID}" kill "${leg_start}" -)"
    (( n == 1 )) || fail "${step}: ${n} kill call(s) of ${R_ID} by a CSCB process through R's latch re-check, not the abort's one"
    echo "${TEST_NAME}: ${step}: ${#hits[@]} re-check round line(s) for R, the first $(seconds_between "${latch_at}" "${recheck_at}")s after the latch (recorded): $(printf '%s\n' "${hits[@]}" | cut -f1 | while read -r t; do sed -n "${t}p" "${SLACK_STATE_DIR}/server.log"; done | sed 's/^\[[^]]*\] //' | tr '\n' '|')"
    echo "${TEST_NAME}: ${step}: the bot server's calls of ${R_ID} after the latch (recorded): $(calls "${table}" "${srv}" "${R_ID}" - "${latch_at}" - | awk -F'\t' -v l="${latch_at}" '{ printf "%+.1fs %s; ", $1 - l, $3 }')"

    # No relaunch of R: the start pass's one resume, before the kill, and no spawn after it.
    n="$(count_calls "${table}" "${srv}" "${R_ID}" resume "${leg_start}" -)"
    (( n == 1 )) || fail "${step}: ${n} bot-server resume(s) of ${R_ID} in the leg, not the start pass's one"
    t="$(first_call_at "${table}" "${srv}" "${R_ID}" resume "${leg_start}" -)"
    before "${t}" "${kill_at}" || fail "${step}: the bot server's resume of ${R_ID} came after the kill"
    n="$(count_calls "${table}" "${srv}" "${R_ID}" spawn "${t}" -)"
    (( n == 0 )) || fail "${step}: the bot server made ${n} spawn(s) of ${R_ID} after the start pass's resume"

    # No counted failure.
    expect_no_counted_failure "${step}" "${R_KEY}"
    echo "${TEST_NAME}: ${step}: R's pending-row rule, abort and latch lines (recorded): $(log_hits "${log0}" "" | cut -f3 | grep -F -e "${PENDING_ROW_HEAD} ${R_REF} " -e "[slack] pending-row: persona=${R_KEY} stuck-launch" -e "[slack] conflict-latch: " | grep -F -e "${R_KEY}" -e "${R_REF}" | cut -c1-300 | tr '\n' '|')"
}

# check_grouped_viewer: the grouped-viewer leg's checks (step 10 of the
# header), over the shared run's locals.
check_grouped_viewer() {
    local step="grouped viewer" kill_at hits=() lines=() bound_at post_at

    # Exactly one kill of V's row, the bot server's, with kill_sent true.
    kill_at="$(one_abort_kill "${step}" "${table}" "${srv}" "${V_ID}" "${leg_start}")" || exit 1
    echo "${TEST_NAME}: ${step}: the abort kill at +$(seconds_between "${v_l_s}" "${kill_at}")s from V's launch start (B is +${B_S}s)"
    reads_before_kill_pending "${step}" "${v_reads}" "${kill_at}" "${v_l_ms}" "${v_l_s}" V
    mapfile -t hits < <(log_lines_starting "${log0}" "${V_ABORT_KILL_HEAD}")
    (( ${#hits[@]} == 1 )) || {
        log_hits "${log0}" "[slack] pending-row: persona=${V_KEY} stuck-launch abort" | cut -f3 | sed 's/^/  | /' >&2
        fail "${step}: ${#hits[@]} abort kill line(s) for V starting '${V_ABORT_KILL_HEAD}' (kill_sent true), not one"
    }

    bound_at="${v_b_at}"
    post_at="$(expect_relaunching_post_line "${step}" "${V_RELAUNCHING_POSTED}" "${bound_at}" "${kill_at}")" || exit 1
    mapfile -t lines < <(record_posts_of "${posts0}" "${V_SUFFIX}")
    (( ${#lines[@]} == 1 )) || {
        printf '  | %s\n' "${lines[@]}" >&2
        fail "${step}: ${#lines[@]} post(s) for V in the Slack stub's record from the start on, not the relaunching post alone"
    }
    jq -e --arg want "${V_RELAUNCHING_POST}" '.text == $want' <<< "${lines[0]}" > /dev/null || {
        printf '  | %s\n' "${lines[0]}" >&2
        fail "${step}: V's post is not its relaunching post: ${V_RELAUNCHING_POST}"
    }

    # V's worker process is gone (waited for right after the kill).
    pid_gone "${v_worker}" || fail "${step}: V's worker process ${v_worker} still runs after the kill"

    # Recorded, not asserted.
    echo "${TEST_NAME}: ${step}: V's abort lines (recorded): $(log_hits "${log0}" "[slack] pending-row: persona=${V_KEY} stuck-launch" | cut -f3 | cut -c1-260 | tr '\n' '|')"
    echo "${TEST_NAME}: ${step}: the viewer session ${viewer} after the kill (recorded): $(has_session "${viewer}" && echo present || echo gone)"
}

legs_relabelled_session_and_grouped_viewer() {
    local step="relabel and viewer" creds="${SCENARIO_ROOT}/credentials-rv" r_work v_work r_creds v_creds r_sid v_sid srv log0 posts0 leg_start
    local r_l_ms r_l_s r_b_at r_session r_worker r_pending_at v_l_ms v_l_s v_b_at v_session v_worker viewer viewer_sid
    local r_reads="${SCENARIO_ROOT}/relabel-reads.tsv" v_reads="${SCENARIO_ROOT}/viewer-reads.tsv" table="${SCENARIO_ROOT}/rv-calls.tsv"
    local lap_at pane_at relabel_at relabel_end label_sid label_pane token store got want deadline r_killed="" v_killed="" r_kill_seen v_kill_seen
    local latch_seen raced verb anchor_from attempt pane_pid next_due next_at slacks=""

    new_state_dir relabel-viewer
    mkdir -m 700 "${creds}"
    start_slack_stub "${SCENARIO_ROOT}/slack-stub-rv" "${R_SUFFIX}" "${V_SUFFIX}"
    r_work="$(make_workdir relabel)"
    stub_mode "${r_work}" "${STUB_MODE_AT_ONCE}"
    v_work="$(make_workdir viewer)"
    stub_mode "${v_work}" "${STUB_MODE_AT_ONCE}"
    r_creds="$(write_credentials "${creds}" "${R_SUFFIX}")"
    v_creds="$(write_credentials "${creds}" "${V_SUFFIX}")"
    write_personas_config "$(persona_json "${R_NAME}" "${r_creds}" "${r_work}" "${R_CHANNEL}")" \
        "$(persona_json "${V_NAME}" "${v_creds}" "${v_work}" "${V_CHANNEL}")"

    # Step 1: the live start brings R and V up.
    start_server --live
    wait_for_log "$(completion_match 2)" "${START_WAIT_S}" "${step}: the bring-up's start pass never completed"
    expect_completion 2 "${step}: the bring-up" "0 not brought up"
    persona_brought_up "${step}: R's bring-up" "${R_ID}" "${R_REF}"
    r_sid="${BROUGHT_UP_SID}"
    persona_brought_up "${step}: V's bring-up" "${V_ID}" "${V_REF}"
    v_sid="${BROUGHT_UP_SID}"

    # Step 2: a plain stop, then [harness] both workers end with the sentinel.
    stop_server
    end_worker "${R_ID}" "${step}: R's worker"
    [[ "${ROW_SID}" == "${r_sid}" ]] || fail "${step}: R's ${ROW_STATE} row's session_id is '${ROW_SID}', not the live row's ${r_sid}"
    end_worker "${V_ID}" "${step}: V's worker"
    [[ "${ROW_SID}" == "${v_sid}" ]] || fail "${step}: V's ${ROW_STATE} row's session_id is '${ROW_SID}', not the live row's ${v_sid}"

    stub_mode "${r_work}" "${STUB_MODE_MANUAL_START}"
    stub_mode "${v_work}" "${STUB_MODE_MANUAL_START}"
    log0="$(line_count "${SLACK_STATE_DIR}/server.log")"
    posts0="$(( $(line_count "${SLACK_RECORD}") + 1 ))"
    leg_start="$(now_s)"
    start_server --live
    srv="${SERVER_PID}"

    # Step 4 [harness]: each row pending with its own session id and a launch start; no needle in either pane.
    wait_until "${START_WAIT_S}" "${step}: row ${R_ID} never read pending after the start" \
        row_of_reads "${R_ID}" "${step}: R's resume" pending
    [[ "${ROW_SID}" == "${r_sid}" ]] || fail "${step}: R's pending row's session_id is '${ROW_SID}', not the kept ${r_sid}"
    r_pending_at="${ROW_READ_AT}"
    r_l_ms="$(launch_ms "${ROW_LAUNCH}")" || fail "${step}: R's pending row's launch_started_at '${ROW_LAUNCH}' does not parse"
    r_l_s="$(ms_to_s "${r_l_ms}")"
    r_b_at="$(ms_to_s "$(( r_l_ms + B_MS ))")"
    r_session="${ROW_SESSION}"
    [[ -n "${r_session}" ]] || fail "${step}: R's pending row names no tmux session"
    hold_pending_worker "${step}: R's held launch" "${r_session}"
    r_worker="$(pane_pid_of "${step}" "${r_session}")"
    echo "${TEST_NAME}: ${step}: R's held row reads pending, launch_started_at ${ROW_LAUNCH}, session ${r_session}"
    wait_until "${START_WAIT_S}" "${step}: row ${V_ID} never read pending after the start" \
        row_of_reads "${V_ID}" "${step}: V's resume" pending
    [[ "${ROW_SID}" == "${v_sid}" ]] || fail "${step}: V's pending row's session_id is '${ROW_SID}', not the kept ${v_sid}"
    v_l_ms="$(launch_ms "${ROW_LAUNCH}")" || fail "${step}: V's pending row's launch_started_at '${ROW_LAUNCH}' does not parse"
    v_l_s="$(ms_to_s "${v_l_ms}")"
    v_b_at="$(ms_to_s "$(( v_l_ms + B_MS ))")"
    v_session="${ROW_SESSION}"
    [[ -n "${v_session}" ]] || fail "${step}: V's pending row names no tmux session"
    hold_pending_worker "${step}: V's held launch" "${v_session}"
    v_worker="$(pane_pid_of "${step}" "${v_session}")"
    echo "${TEST_NAME}: ${step}: V's held row reads pending, launch_started_at ${ROW_LAUNCH}, session ${v_session}"

    # Step 5 [harness]: V's relaunch reports in at once; a grouped viewer session on V's session.
    stub_mode "${v_work}" "${STUB_MODE_AT_ONCE}"
    viewer_sid="$(attach_viewer "${v_session}")"
    viewer="$("${SCENARIO_REAL_TMUX}" display-message -p -t "${viewer_sid}:" '#{session_name}')" \
        || fail "${step}: tmux could not read the viewer ${viewer_sid}'s name"
    echo "${TEST_NAME}: ${step}: the grouped viewer ${viewer} (${viewer_sid}) is attached to V's session ${v_session}"

    # Relabel before G: no screen poller runs, and the first acting retry waits for G.
    plan_relabel "${step}" "${r_session}"
    relabel_at="${EPOCHREALTIME/,/.}"
    before "${relabel_at}" "$(plus_s "${r_l_s}" "${G_S}")" || fail "${step}: relabel started after G"
    write_relabel "${step}"
    relabel_end="${EPOCHREALTIME/,/.}"
    label_sid="${RELABEL_SID}"
    label_pane="${RELABEL_PANE}"
    token="${RELABEL_TOKEN}"
    # The seeding rules: the label keeps the store's own id; the worker pane carries @ad_pane with the label's token.
    store="$(ad_store_id)"
    want="$(ad_owner_label "${token}" "${label_sid}" "${R_ID}" "${store}")"
    got="$("${SCENARIO_REAL_TMUX}" show-options -qv -t "${label_sid}" @ad_owner)" || fail "${step}: tmux could not read @ad_owner of ${label_sid}"
    [[ "${got}" == "${want}" ]] || fail "${step}: R's relabelled @ad_owner reads '${got}', not '${want}'"
    [[ "${got}" == *" ${store}" ]] || fail "${step}: R's relabelled @ad_owner '${got}' does not end with the scenario store's id ${store}"
    got="$("${SCENARIO_REAL_TMUX}" show-options -p -qv -t "${label_pane}" @ad_pane)" || fail "${step}: tmux could not read @ad_pane of ${label_pane}"
    [[ "${got}" == "${token} ${label_pane}" ]] || fail "${step}: R's worker pane's @ad_pane reads '${got}', not '${token} ${label_pane}'"
    got="$("${SCENARIO_REAL_TMUX}" display-message -p -t "${label_pane}" '#{pane_pid}')" || fail "${step}: tmux could not read the process of ${label_pane}"
    [[ "${got}" == "${r_worker}" ]] || fail "${step}: the relabelled pane ${label_pane} runs ${got}, not R's worker ${r_worker}"
    before "$(now_s)" "${r_b_at}" || fail "${step}: the relabel ended at or after B"
    echo "${TEST_NAME}: ${step}: R's session ${label_sid} relabelled before G at +$(seconds_between "${r_l_s}" "${relabel_at}")s; @ad_owner '${want}'"

    # Step 7 [harness]: read both rows until the bot server's kill of each, bounded from the later launch start.
    : > "${r_reads}"
    : > "${v_reads}"
    deadline=$(( (r_l_ms > v_l_ms ? r_l_ms : v_l_ms) + ABORT_WAIT_S * 1000 ))
    while [[ -z "${r_killed}" || -z "${v_killed}" ]]; do
        r_kill_seen="${r_killed}"
        v_kill_seen="${v_killed}"
        [[ -n "${r_killed}" ]] || ! server_killed "${R_ID}" "${srv}" || r_killed=1
        [[ -n "${v_killed}" ]] || ! server_killed "${V_ID}" "${srv}" || v_killed=1
        if [[ -z "${r_kill_seen}" ]]; then
            poll_row_of "${R_ID}" "${step}: R's hold"
            printf '%s\t%s\t%s\n' "${ROW_READ_AT}" "${ROW_STATE}" "${ROW_LAUNCH}" >> "${r_reads}"
        fi
        if [[ -z "${v_kill_seen}" ]]; then
            poll_row_of "${V_ID}" "${step}: V's hold"
            printf '%s\t%s\t%s\n' "${ROW_READ_AT}" "${ROW_STATE}" "${ROW_LAUNCH}" >> "${v_reads}"
        fi
        [[ -n "${r_killed}" && -n "${v_killed}" ]] && break
        (( $(_scenario_now_ms) < deadline )) \
            || fail "${step}: no bot-server kill of$([[ -n "${r_killed}" ]] || echo " ${R_ID}")$([[ -n "${v_killed}" ]] || echo " ${V_ID}") within ${ABORT_WAIT_S}s of the launch starts (B and ${ABORT_SLACK_S}s)"
        sleep "${HOLD_POLL_S}"
    done

    # Step 8: V's worker gone; V relaunched and live; R latched, then one latch re-check.
    wait_until "${GONE_WAIT_S}" "${step}: V's worker process ${v_worker} still runs ${GONE_WAIT_S}s after the kill" \
        pid_gone "${v_worker}"
    wait_until "$(( RELAUNCH_WAIT_S - B_S ))" "${step}: row ${V_ID} not live after the abort (the retry ceiling and ${RELAUNCH_SLACK_S}s)" \
        row_of_reads "${V_ID}" "${step}: V's relaunch" waiting
    [[ "${ROW_SID}" == "${v_sid}" ]] || fail "${step}: V's relaunched row's session_id is '${ROW_SID}', not the kept ${v_sid}"
    wait_until "${CONNECT_WAIT_S}" "${step}: the server never registered V's relaunched stub's session" \
        log_fragment_seen "${log0}" "[slack] Session connected: persona ${V_REF}"
    wait_until "${LATCH_WAIT_S}" "${step}: no latch-set line for R within ${LATCH_WAIT_S}s of its abort kill" \
        log_line_starting_seen "${log0}" "${R_LATCHED_HEAD}"
    latch_seen="$(now_s)"
    wait_until "$(( RECHECK_S + RECHECK_SLACK_S ))" "${step}: no latch re-check round line for R within ${RECHECK_S}s and ${RECHECK_SLACK_S}s of its latch" \
        log_line_starting_seen "${log0}" "${R_RECHECK_HEAD}"
    echo "${TEST_NAME}: ${step}: R's first latch re-check round line came $(seconds_between "${latch_seen}" "$(now_s)")s after its latch was seen"
    poll_row_of "${R_ID}" "${step}: R after the re-check"
    echo "${TEST_NAME}: ${step}: R's row after the re-check (recorded): ${ROW_STATE}, launch_started_at ${ROW_LAUNCH}"

    # Steps 9 and 10: the checks, over the bot server's calls (`call_table`).
    call_table "${table}"
    echo "${TEST_NAME}: ${step}: the start pass's summary (recorded): $(log_hits "${log0}" "$(completion_match 2)" | tail -n 1 | cut -f3)"
    echo "${TEST_NAME}: ${step}: the bot server's find-missing runs, from R's launch start (recorded): $(calls "${table}" "${srv}" - find-missing - - | awk -F'\t' -v l="${r_l_s}" '{ printf "%+.1fs ", $1 - l }')"
    check_relabelled_session
    check_grouped_viewer

    # The end: a plain stop; [harness] V's worker ends with the sentinel, and
    # R's held worker too (its row is recorded, not asserted).
    stop_server
    end_worker "${V_ID}" "${step}: V's end"
    "${SCENARIO_REAL_TMUX}" send-keys -t "=${r_session}:" "${SENTINEL}" Enter || fail "${step}: could not send the sentinel into ${r_session}"
    wait_until "${GONE_WAIT_S}" "${step}: R's worker ${r_worker} still runs ${GONE_WAIT_S}s after the sentinel" pid_gone "${r_worker}"
    poll_row_of "${R_ID}" "${step}: R's end"
    echo "${TEST_NAME}: ${step}: R's row after its worker ended (recorded): ${ROW_STATE}"
    stop_tracked_pid "${SLACK_STUB_PID}" 10 "${step}: the Slack stub did not exit on SIGTERM"
}

leg_own_stuck_launch
leg_other_process
legs_relabelled_session_and_grouped_viewer

assert_no_server_tmux
assert_no_cscb_include_finished
assert_no_cscb_delete
echo "${TEST_NAME}: PASS"
