#!/usr/bin/env bash
# Pending launches, launch timeouts, controller restart, failed create and stopping.
# Delayed SessionStart keeps rows pending without a screen parser or startup keys.
# AD row observations and existing retry timers own recovery.

set -euo pipefail

TEST_NAME="test-17-fmk-launch-pending"
# shellcheck source=lib/scenario.sh
source "$(dirname "$0")/lib/scenario.sh"

# Persona P, its key, row and channel. src/persona-identity.ts
# personaInstanceId: `cscb_<key>`.
P_NAME="${SCENARIO_TAG}_p"
P_KEY="$(persona_key "${P_NAME}")"
P_REF="$(persona_ref "${P_NAME}")"
P_ID="cscb_${P_KEY}"
P_CHANNEL="C0T17PND1"

# CSCB's config for the leg (seconds), and the derived report-in delay.
HEALTH_TICK_S=3
RESTART_DELAY_S=5
FORCED_RESUME_S=20
HOLD_SLACK_S=7
REPORT_DELAY_S=$(( HEALTH_TICK_S + FORCED_RESUME_S + HOLD_SLACK_S ))
REPORT_SLACK_S=15

# Bounds (seconds).
STUB_WAIT_S=20        # the Slack stub writing its ready file
START_WAIT_S=120      # the start pass: one bring-up and one launch
REPORT_WAIT_S=60
CONNECT_WAIT_S=30     # after the row reported in: the server registering the stub's session
ENDED_WAIT_S=20       # after the sentinel: the row reading ended or missing
RESUME_WAIT_S=$(( RESTART_DELAY_S + 2 * HEALTH_TICK_S + 30 ))
SESSION_WAIT_S=10     # after the hold's first pending read: P's tmux session present
REPORT_WAIT_BOUND_S=$(( REPORT_DELAY_S + 10 ))

# The fixtures the leg runs.
FMK_TEXTS="${SCENARIO_FIXTURES}/fmk-texts.ts"
FMK_DRIVER="${SCENARIO_FIXTURES}/fmk-driver.ts"
PKG_DIR="${SCENARIO_REPO}/node_modules/claude-slack-channel-bots"

# agent-director's error name the forced `resume` gets on a `pending` row.
NOT_RESUMABLE=ErrSpawnNotResumable


# The launch-timeout legs' personas, by role: `spawn` (no row: a plain
# spawn), `reuse` (a finished row in another working directory: a reuse
# spawn) and `resume` (a finished row with its session_id: a resume).
LT_ROLES=(spawn reuse resume)
declare -A LT_NAME=([spawn]="${SCENARIO_TAG}_spawn" [reuse]="${SCENARIO_TAG}_reuse" [resume]="${SCENARIO_TAG}_resume")
declare -A LT_CHANNEL=([spawn]=C0T17SPN1 [reuse]=C0T17REU1 [resume]=C0T17RSM1)
declare -A LT_SUFFIX=([spawn]=t17s [reuse]=t17u [resume]=t17m)
declare -A LT_KEY=() LT_REF=() LT_ID=() LT_WORK=()
for role in "${LT_ROLES[@]}"; do
    LT_KEY[${role}]="$(persona_key "${LT_NAME[${role}]}")"
    LT_REF[${role}]="$(persona_ref "${LT_NAME[${role}]}")"
    LT_ID[${role}]="cscb_${LT_KEY[${role}]}"
done

# The restart leg's persona Q.
Q_NAME="${SCENARIO_TAG}_restart"
Q_KEY="$(persona_key "${Q_NAME}")"
Q_REF="$(persona_ref "${Q_NAME}")"
Q_ID="cscb_${Q_KEY}"
Q_CHANNEL="C0T17RST1"
Q_SUFFIX=t17q

# The launch-timeout legs (seconds).
LT_HOLD_SLACK_S=8         # the report-in delay past the last launch call's end
LT_REPORT_WAIT_S=60       # reporting allowance in the fixed combined leg deadline below
LT_RETRY_READ_S=5         # after a retry line: that retry's read of the row
LT_RETRY_SLACK_S=30       # past the retry timer's first wait: each persona's timer stopped

# The restart leg (seconds).
RESTART_REPORT_DELAY_S=30 # longer than the stop and the start take, shorter than G (checked)
RESTART_LAP_SLACK_S=10    # past G and the retry ceiling: the lap's calls, the report-in, the harness read
RESTART_POLL_S=1          # the harness's read of the row while it waits for the lap

# Scenario 11's persona F (no row before its leg).
F_NAME="${SCENARIO_TAG}_failed"
F_KEY="$(persona_key "${F_NAME}")"
F_REF="$(persona_ref "${F_NAME}")"
F_ID="cscb_${F_KEY}"
F_CHANNEL="C0T17FCR1"
F_SUFFIX=t17f

# Scenario 11's leg (seconds).
FC_BRINGUP_SLACK_S=40
FC_POLL_S=1               # the harness's read of the row while it waits

# agent-director's error name for a launch whose session-creating call failed.
SESSION_CREATE_ERR=ErrTmuxSessionCreate

# The words SRJ-1413 says no post holds.
DISPATCHER_BUG='dispatcher bug'

# Scenario 13's persona S (working directory `paused`, selected for the
# stub's linger-on-exit). No persona's name, key or row id is a prefix of
# another's.
S_NAME="${SCENARIO_TAG}_stopping"
S_KEY="$(persona_key "${S_NAME}")"
S_REF="$(persona_ref "${S_NAME}")"
S_ID="cscb_${S_KEY}"
S_CHANNEL="C0T17PSE1"
S_SUFFIX=t17z

# Scenario 13's leg (seconds; see the header for ST_TICK_S's derivation).
ST_RESTART_DELAY_S=3      # session_restart_delay: the restart the session's end schedules
ST_PAUSE_S=5              # from the tick read the pause follows to the pause's return (checked)
ST_LAUNCH_SLACK_S=10      # a restart run's or a retry's calls before its resume (checked for the retry)
ST_TICK_JITTER_S=2        # the next tick's read, against the first read plus the interval
ST_SESSION_END_WAIT_S=10  # after the release: the lingering worker's tmux session gone

# The call's name (`what`) the post-UNAVAILABLE get line gives a `resume`
# (src/session-manager.ts, the resume site's literal; no export).
RESUME_WHAT=resume

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

# fmk_text <entry> [<arg>...]: print fixtures/fmk-texts.ts's value for
# <entry>, read from the package the server and the driver run (PKG_DIR).
fmk_text() {
    CSCB_PKG_DIR="${PKG_DIR}" bun --no-install "${FMK_TEXTS}" "$@"
}

# text_parts <array-name> <count> <entry> <arg>: set the array to the lines
# of fixtures/fmk-texts.ts's value for <entry> <arg>; fail unless there are
# <count> lines, none empty.
text_parts() {
    local -n text_parts_out="$1"
    local value part
    value="$(fmk_text "$3" "$4")" || fail "setup: fmk-texts.ts could not print $3 $4"
    mapfile -t text_parts_out <<< "${value}"
    (( ${#text_parts_out[@]} == $2 )) || fail "setup: fmk-texts.ts printed ${#text_parts_out[@]} line(s) for $3 $4, not $2"
    for part in "${text_parts_out[@]}"; do
        [[ -n "${part}" ]] || fail "setup: fmk-texts.ts printed an empty line for $3 $4"
    done
}

# key_text <array-name> <entry> <key>: set the associative array's element
# <key> to fixtures/fmk-texts.ts's one-line value for <entry> <key> (a head
# cut from the entry's builder); fail when it is empty or cannot be printed.
key_text() {
    local -n key_text_out="$1"
    local value
    value="$(fmk_text "$2" "$3")" || fail "setup: fmk-texts.ts could not print $2 $3"
    [[ -n "${value}" && "${value}" != *$'\n'* ]] || fail "setup: fmk-texts.ts printed no one-line value for $2 $3"
    key_text_out["$3"]="${value}"
}

# naming_persona <key> <ref>: print the lines of standard input that name
# persona <key> whole (`persona=<key>` followed by no key character) or hold
# its reference <ref>, so no other persona's key or reference matches.
naming_persona() {
    awk -v k="persona=$1" -v r="$2" '
        {
            hit = index($0, r) > 0
            s = $0
            while (!hit && (p = index(s, k)) > 0) {
                c = substr(s, p + length(k), 1)
                if (c !~ /[a-z0-9_]/) hit = 1
                s = substr(s, p + length(k))
            }
            if (hit) print
        }'
}

# retry_hits <from-line> <head> <tail>...: `log_hits`'s output for the
# server.log lines after <from-line> whose text after the `[<ISO time>] `
# head is exactly <head>, a whole number and one of the <tail>s: the retry
# lines (fmk-texts.ts `unavailableRetryRetryLineParts`), never the re-armed
# line, which starts the same way.
retry_hits() {
    python3 - "${SLACK_STATE_DIR}/server.log" "$@" << 'EOF'
import datetime, re, sys
path, start, head, tails = sys.argv[1], int(sys.argv[2]), sys.argv[3], sys.argv[4:]
line_re = re.compile(re.escape(head) + "[0-9]+(?:" + "|".join(re.escape(t) for t in tails) + ")")
try:
    lines = open(path, encoding="utf-8", errors="replace").read().split("\n")
except FileNotFoundError:
    sys.exit(0)
for n, text in enumerate(lines, 1):
    if n <= start or not text.startswith("[") or "] " not in text:
        continue
    at = text.index("] ")
    if not line_re.fullmatch(text[at + 2:]):
        continue
    try:
        t = datetime.datetime.strptime(text[1:at], "%Y-%m-%dT%H:%M:%S.%fZ").replace(tzinfo=datetime.timezone.utc).timestamp()
    except ValueError:
        continue
    print(f"{n}\t{t:.3f}\t{text}")
EOF
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

# Print the Slack stub record's posts (chat.* and files.* methods), one JSON
# object per line, from record line <from> on (default 1).
record_posts() {
    [[ -f "${SLACK_RECORD}" ]] || return 0
    tail -n "+${1:-1}" "${SLACK_RECORD}" \
        | jq -c 'select(.event == "api" and ((.method // "") | test("^(chat|files)\\.")))'
}

# line_count <file>: print how many lines <file> holds (0 when there is none).
line_count() {
    if [[ ! -f "$1" ]]; then
        echo 0
        return 0
    fi
    wc -l < "$1" | tr -d ' '
}

# read_row_of <id> <step>: a harness `get` of row <id>. Sets ROW_READ_AT (the
# time just before the call), ROW_STATE, ROW_SID (session_id),
# ROW_LAUNCH (launch_started_at as printed) and ROW_SESSION
# (tmux_session_name), each empty when absent.
read_row_of() {
    local id="$1" fields
    ROW_READ_AT="$(now_s)"
    ad_capture get --instance-id "${id}"
    (( AD_RC == 0 )) || fail "$2: the harness get of ${id} exited ${AD_RC}: $(head -c 300 "${AD_ERR}")"
    fields="$(jq -r '[.state // "", .session_id // "", (.launch_started_at // "" | tostring), .tmux_session_name // ""] | join("\u001f")' "${AD_OUT}")" \
        || fail "$2: the harness get of ${id} printed no row object: $(head -c 300 "${AD_OUT}")"
    IFS=$'\x1f' read -r ROW_STATE ROW_SID ROW_LAUNCH ROW_SESSION <<< "${fields}"
}

# read_row <step>: `read_row_of` for P's row.
read_row() {
    read_row_of "${P_ID}" "$1"
}

# row_of_reads <id> <step> <state>...: read row <id>; true when its state is
# one of the <state>s.
row_of_reads() {
    local id="$1" step="$2" s
    shift 2
    read_row_of "${id}" "${step}"
    for s in "$@"; do
        [[ "${ROW_STATE}" == "${s}" ]] && return 0
    done
    return 1
}

# row_reads <step> <state>...: `row_of_reads` for P's row.
row_reads() {
    row_of_reads "${P_ID}" "$@"
}

# row_left_pending <step>: read the row; true once its state is not `pending`.
row_left_pending() {
    read_row "$1"
    [[ -n "${ROW_STATE}" && "${ROW_STATE}" != pending ]]
}

# pane_capture <step> <session> <file>: P's pane on the scenario's tmux
# server, read with the real tmux from the scenario's own shell, into <file>.

# has_session <session>: true when the scenario's tmux server holds it.
has_session() {
    "${SCENARIO_REAL_TMUX}" has-session -t "=$1" 2> /dev/null
}


# server_calls <verb> <from> <to> [<fragment>...]: print the agent-director
# shim's `call` lines naming P's row whose parent is the bot server
# (SERVER_PID), whose verb is <verb> and whose arguments hold every
# <fragment> in order (`cscb_ad_calls`), with a time after <from> and at or
# before <to> (`-` for no bound).
server_calls() {
    server_calls_of "${P_ID}" "$@"
}

# server_calls_of <id> <verb> <from> <to> [<fragment>...]: `server_calls` for
# row <id>, named whole (` --instance-id <id> ` in the line's words),
# so another row whose id <id> is a prefix of is never counted.
server_calls_of() {
    local id="$1" verb="$2" from="$3" to="$4" lines=()
    shift 4
    mapfile -t lines < <(cscb_ad_calls "${verb}" "--instance-id ${id}" "$@")
    (( ${#lines[@]} > 0 )) || return 0
    printf '%s\n' "${lines[@]}" | awk -F'\t' -v p="${SERVER_PID}" -v id="${id}" -v a="${from}" -v b="${to}" '
        $4 == p && index(" " $6 " ", " --instance-id " id " ") \
            && (a == "-" || $2 + 0 > a + 0) && (b == "-" || $2 + 0 <= b + 0)'
}

# server_count <verb> <from> <to> [<fragment>...]: how many lines
# `server_calls` prints.
server_count() {
    local out
    out="$(server_calls "$@")"
    if [[ -z "${out}" ]]; then
        echo 0
        return 0
    fi
    wc -l <<< "${out}" | tr -d ' '
}



# any_calls_naming <verb> <from> <to>: print every agent-director shim `call`
# line, from any parent, whose words hold <verb> and P's row id, each as a
# whole word, with a time in (<from>, <to>] (`-` for no bound).
any_calls_naming() {
    any_calls_naming_of "${P_ID}" "$@"
}

# any_calls_naming_of <id> <verb> <from> <to>: `any_calls_naming` for row <id>.
any_calls_naming_of() {
    awk -F'\t' -v v="$2" -v id="$1" -v a="$3" -v b="$4" '
        $1 == "call" && index(" " $6 " ", " " v " ") && index(" " $6 " ", " " id " ") \
            && (a == "-" || $2 + 0 > a + 0) && (b == "-" || $2 + 0 <= b + 0)
    ' "${SCENARIO_AD_SHIM_LOG}"
}

# call_table <file>: write <file>, one TAB-separated line per agent-director
# shim `call` line whose parent is a CSCB process (`cscb_ad_calls`), in log
# order: its time, its PPID (the CSCB process), its verb, the row id its
# `--instance-id` names (`-` when none) and its arguments joined by
# single spaces. Read once per check, so each check reads the shim's log
# once.
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
# the time of the first line `calls` prints (empty when none).
first_call_at() {
    calls "$@" | head -n 1 | cut -f1
}

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

# posts_to <channel> <from-time>: print the Slack stub record's posts
# (`record_posts`) to <channel> (any channel when empty) recorded in the
# second of <from-time> (epoch seconds) or later, one JSON object per line,
# text cut to 200 characters.
posts_to() {
    record_posts 1 | jq -c --arg c "$1" --argjson t "$2" '
        select(($c == "" or (.channel // "") == $c) and ((.ts // "" | sub("\\.[0-9]+Z$"; "Z") | fromdateiso8601) >= ($t | floor)))
        | {ts, method, channel, text: ((.text // "") | .[0:200])}'
}

# ---------------------------------------------------------------------------
# Values from the installed package
# ---------------------------------------------------------------------------

G_S="$(fmk_text DEFAULT_AD_SETTINGS.tmux.pending_grace_seconds)" \
    || fail "setup: fmk-texts.ts could not print DEFAULT_AD_SETTINGS.tmux.pending_grace_seconds"
[[ "${G_S}" =~ ^[0-9]+$ ]] || fail "setup: G '${G_S}' is not a whole number of seconds"
(( REPORT_DELAY_S + REPORT_SLACK_S < G_S )) \
    || fail "setup: the report-in delay ${REPORT_DELAY_S}s plus reporting slack ${REPORT_SLACK_S}s is not shorter than G ${G_S}s"
echo "${TEST_NAME}: G ${G_S}s; report-in delay ${REPORT_DELAY_S}s (tick ${HEALTH_TICK_S}s + forced resume ${FORCED_RESUME_S}s + slack ${HOLD_SLACK_S}s)"

CREATE_TIMEOUT_MS="$(fmk_text DEFAULT_AD_SETTINGS.tmux.create_timeout_ms)" \
    || fail "setup: fmk-texts.ts could not print DEFAULT_AD_SETTINGS.tmux.create_timeout_ms"
CALL_TIMEOUT_MS="$(fmk_text DEFAULT_AGENT_DIRECTOR_CALL_TIMEOUT_MS)" \
    || fail "setup: fmk-texts.ts could not print DEFAULT_AGENT_DIRECTOR_CALL_TIMEOUT_MS"
TIMEOUT_PHRASE="$(fmk_text LAUNCH_TIMEOUT_PHRASE)" || fail "setup: fmk-texts.ts could not print LAUNCH_TIMEOUT_PHRASE"
OUTCOME_PENDING="$(fmk_text LAUNCH_UNAVAILABLE_OUTCOME_COVERED_NO_APPROVER)" \
    || fail "setup: fmk-texts.ts could not print LAUNCH_UNAVAILABLE_OUTCOME_COVERED_NO_APPROVER"
RETRY_BASE_S="$(fmk_text UNAVAILABLE_RETRY_BASE_S)" || fail "setup: fmk-texts.ts could not print UNAVAILABLE_RETRY_BASE_S"
RETRY_CEILING_S="$(fmk_text UNAVAILABLE_RETRY_CEILING_S)" || fail "setup: fmk-texts.ts could not print UNAVAILABLE_RETRY_CEILING_S"
PENDING_ROW_HEAD="$(fmk_text PENDING_ROW_RULE_LOG_HEAD)" || fail "setup: fmk-texts.ts could not print PENDING_ROW_RULE_LOG_HEAD"
# How the post-UNAVAILABLE get line names the outcome: each launch-timeout
# form, and the head of a plain UNAVAILABLE.
FORM_CALL_TIMEOUT="$(fmk_text launchUnavailableFormText LAUNCH_TIMEOUT_FORM_CALL_TIMEOUT)" \
    || fail "setup: fmk-texts.ts could not print launchUnavailableFormText LAUNCH_TIMEOUT_FORM_CALL_TIMEOUT"
FORM_TMUX_UNRESPONSIVE="$(fmk_text launchUnavailableFormText LAUNCH_TIMEOUT_FORM_TMUX_UNRESPONSIVE)" \
    || fail "setup: fmk-texts.ts could not print launchUnavailableFormText LAUNCH_TIMEOUT_FORM_TMUX_UNRESPONSIVE"
FORM_UNAVAILABLE_HEAD="$(fmk_text launchUnavailableFormText none)" || fail "setup: fmk-texts.ts could not print launchUnavailableFormText none"
[[ -n "${PENDING_ROW_HEAD}" && -n "${FORM_CALL_TIMEOUT}" && -n "${FORM_TMUX_UNRESPONSIVE}" && -n "${FORM_UNAVAILABLE_HEAD}" ]] \
    || fail "setup: fmk-texts.ts printed an empty value"
[[ "${CREATE_TIMEOUT_MS}" =~ ^[1-9][0-9]*$ && "${CALL_TIMEOUT_MS}" =~ ^[1-9][0-9]*$ ]] \
    || fail "setup: the create timeout '${CREATE_TIMEOUT_MS}' or the call timeout '${CALL_TIMEOUT_MS}' is not a whole number of milliseconds"
[[ "${RETRY_BASE_S}" =~ ^[1-9][0-9]*$ && "${RETRY_CEILING_S}" =~ ^[1-9][0-9]*$ ]] \
    || fail "setup: the retry base '${RETRY_BASE_S}' or ceiling '${RETRY_CEILING_S}' is not a whole number of seconds"
[[ -n "${TIMEOUT_PHRASE}" && -n "${OUTCOME_PENDING}" ]] || fail "setup: fmk-texts.ts printed an empty value"
# The start pass's launch calls end within CSCB's call timeout; then each one's get.
LAUNCH_END_WAIT_S=$(( CALL_TIMEOUT_MS / 1000 + 30 ))
# The launch-timeout legs' report-in delay: agent-director makes one launch's
# session-creating call at a time, so the last launch call ends about one
# create timeout per persona after the first launch start at worst. Keep
# the existing 23-second delay: losing the response after AD records the
# successful launch leaves time for each recovery get to observe pending.
LT_REPORT_DELAY_S=$(( ${#LT_ROLES[@]} * ((CREATE_TIMEOUT_MS + 999) / 1000) + LT_HOLD_SLACK_S ))
(( LT_REPORT_DELAY_S < G_S )) || fail "setup: the launch-timeout legs' report-in delay ${LT_REPORT_DELAY_S}s is not shorter than G ${G_S}s"
# Each persona's retry timer, armed at its launch timeout, has run its first retry or stopped.
LT_RETRY_WAIT_S=$(( RETRY_BASE_S + LT_RETRY_SLACK_S ))
(( RESTART_REPORT_DELAY_S < G_S )) \
    || fail "setup: the restart leg's report-in delay ${RESTART_REPORT_DELAY_S}s is not shorter than G ${G_S}s"
# The restart leg's wait: from the launch start, G and one longest retry wait, then the lap and the report-in.
RESTART_CLEAR_BOUND_S=$(( G_S + RETRY_CEILING_S + RESTART_LAP_SLACK_S ))
echo "${TEST_NAME}: successful launch response loss (report-in delay ${LT_REPORT_DELAY_S}s, call timeout ${CALL_TIMEOUT_MS}ms); retry base ${RETRY_BASE_S}s, ceiling ${RETRY_CEILING_S}s; restart leg: report-in delay ${RESTART_REPORT_DELAY_S}s, clear bound ${RESTART_CLEAR_BOUND_S}s"

MARKED_MISSING="$(fmk_text PENDING_ROW_RUN_MARKED_MISSING)" || fail "setup: fmk-texts.ts could not print PENDING_ROW_RUN_MARKED_MISSING"
SPAWN_FAILURE_HEAD="$(fmk_text spawnFailureNoticeHead "${SESSION_CREATE_ERR}")" \
    || fail "setup: fmk-texts.ts could not print spawnFailureNoticeHead"
# The notice's first line, the same for every error.
SPAWN_FAILURE_FIRST="${SPAWN_FAILURE_HEAD%%$'\n'*}"
[[ -n "${MARKED_MISSING}" && -n "${SPAWN_FAILURE_FIRST}" && "${SPAWN_FAILURE_HEAD}" == *"${SESSION_CREATE_ERR}"* ]] \
    || fail "setup: fmk-texts.ts printed an empty value, or a spawn-failure notice head naming no ${SESSION_CREATE_ERR}"
# Scenario 11's wait: from the launch start, G and one longest retry wait, then the bring-up.
FC_BRINGUP_BOUND_S=$(( G_S + RETRY_CEILING_S + FC_BRINGUP_SLACK_S ))
echo "${TEST_NAME}: scenario 11: bring-up bound ${FC_BRINGUP_BOUND_S}s from the launch start"

STILL_STOPPING="$(fmk_text STILL_STOPPING_PHRASE)" || fail "setup: fmk-texts.ts could not print STILL_STOPPING_PHRASE"
STOP_WINDOW_S="$(fmk_text DEFAULT_AD_SETTINGS.tmux.stopping_window_seconds)" \
    || fail "setup: fmk-texts.ts could not print DEFAULT_AD_SETTINGS.tmux.stopping_window_seconds"
S_ONSET="$(fmk_text tmuxUnresponsiveOnsetText "${S_KEY}")" || fail "setup: fmk-texts.ts could not print tmuxUnresponsiveOnsetText"
[[ -n "${STILL_STOPPING}" && -n "${S_ONSET}" ]] || fail "setup: fmk-texts.ts printed an empty value"
[[ "${STOP_WINDOW_S}" =~ ^[1-9][0-9]*$ ]] || fail "setup: the stopping window '${STOP_WINDOW_S}' is not a whole number of seconds"
# Scenario 13's tick interval: from the tick read the pause follows, the
# pause, the restart delay and the restart run's calls before its refused
# resume, then the retry timer's first wait and the retry's calls before its
# resume, all before the next tick.
ST_TICK_S=$(( ST_PAUSE_S + ST_RESTART_DELAY_S + ST_LAUNCH_SLACK_S + RETRY_BASE_S + ST_LAUNCH_SLACK_S ))
(( ST_TICK_S > RETRY_BASE_S )) || fail "setup: scenario 13's tick interval ${ST_TICK_S}s is not longer than the retry base ${RETRY_BASE_S}s"
(( ST_PAUSE_S + ST_RESTART_DELAY_S + ST_LAUNCH_SLACK_S < STOP_WINDOW_S )) \
    || fail "setup: scenario 13's refused resume is not due inside the stopping window ${STOP_WINDOW_S}s"
# The bring-up launch's pending-only retry timer has run its first retry and stopped.
ST_TIMER_WAIT_S=$(( RETRY_BASE_S + LT_RETRY_SLACK_S ))
echo "${TEST_NAME}: scenario 13: stopping window ${STOP_WINDOW_S}s, health tick ${ST_TICK_S}s, restart delay ${ST_RESTART_DELAY_S}s, retry base ${RETRY_BASE_S}s"

# The log lines with exported builders, per persona key, each printed by
# fmk-texts.ts (see the header): the head of every retry-timer line
# (RT_LINE_HEAD), of the arm line in either mode (RT_ARMED), of the stop line
# (RT_STOPPED), of the not-armed line (RT_NOT_ARMED), the retry line's parts
# (RT_RETRY_HEAD, then RT_RETRY_FULL or RT_RETRY_PENDING after its number),
# the head of the tmux-unresponsive lines (TU_HEAD), and the
# post-UNAVAILABLE get line's text between the call's name and the form
# (GET_OF; GET_HEAD before the call's name, the same for every persona).
declare -A RT_LINE_HEAD=() RT_ARMED=() RT_STOPPED=() RT_NOT_ARMED=() RT_RETRY_HEAD=() RT_RETRY_FULL=() RT_RETRY_PENDING=()
declare -A TU_HEAD=() GET_OF=()
GET_HEAD=""

# retry_texts <key>: RT_LINE_HEAD, RT_STOPPED, the retry line's parts and
# TU_HEAD for <key>.
retry_texts() {
    local parts=()
    key_text RT_LINE_HEAD unavailableRetryLineHead "$1"
    key_text RT_STOPPED unavailableRetryStoppedHead "$1"
    key_text TU_HEAD tmuxUnresponsiveLineHead "$1"
    text_parts parts 3 unavailableRetryRetryLineParts "$1"
    RT_RETRY_HEAD[$1]="${parts[0]}"
    RT_RETRY_FULL[$1]="${parts[1]}"
    RT_RETRY_PENDING[$1]="${parts[2]}"
}

# get_line_texts <key> <ref>: GET_OF for <key> (persona reference <ref>),
# and GET_HEAD, which must be the same for every reference.
get_line_texts() {
    local parts=()
    text_parts parts 2 launchUnavailableGetLineParts "$2"
    [[ -z "${GET_HEAD}" || "${GET_HEAD}" == "${parts[0]}" ]] \
        || fail "setup: the get line's head for $2 is '${parts[0]}', not '${GET_HEAD}'"
    GET_HEAD="${parts[0]}"
    GET_OF[$1]="${parts[1]}"
}

for role in "${LT_ROLES[@]}"; do
    retry_texts "${LT_KEY[${role}]}"
    get_line_texts "${LT_KEY[${role}]}" "${LT_REF[${role}]}"
done
key_text RT_LINE_HEAD unavailableRetryLineHead "${Q_KEY}"
key_text RT_ARMED unavailableRetryArmedHead "${Q_KEY}"
key_text RT_NOT_ARMED unavailableRetryNotArmedHead "${Q_KEY}"
key_text RT_LINE_HEAD unavailableRetryLineHead "${F_KEY}"
retry_texts "${S_KEY}"
key_text RT_ARMED unavailableRetryArmedHead "${S_KEY}"
get_line_texts "${S_KEY}" "${S_REF}"

# ---------------------------------------------------------------------------
# Scenario 5's leg
# ---------------------------------------------------------------------------

leg_launch_pending() {
    local step="scenario 5" creds work connected sid session sentinel_at resume_line resume_at
    local hold_at hold_log0 hold_log1 posts0 launch_ms drv_out drv_err drv_rc=0 drv_at drv_end drv_s
    local drv_line drv_pid outcome=() lines=() line verb launches=0 pane="${SCENARIO_ROOT}/p-pane.txt"
    local shown="${SCENARIO_ROOT}/p-shown-dialogs.txt" on_pane
    local deadline last_clear="" dialog_at="" live_at statuses panes ticks want_ticks n first_send first_read hits
    local restart_lines

    # Step 1: the live start brings P up.
    creds="${SCENARIO_ROOT}/credentials"
    mkdir -m 700 "${creds}"
    work="$(make_workdir p)"
    stub_mode "${work}" "${STUB_MODE_AT_ONCE}"
    start_slack_stub "${SCENARIO_ROOT}/slack-stub" t17p1
    printf '{"bot_token": "%s", "app_token": "%s"}\n' "$(fake_token bot t17p1)" "$(fake_token app t17p1)" \
        | write_file "${creds}/p.json" 600
    write_config << EOF
{
  "personas": [
    {
      "name": "${P_NAME}",
      "credentials_file": "${creds}/p.json",
      "working_directory": "${work}",
      "channels": [{ "id": "${P_CHANNEL}", "delivery": "all" }],
      "permission_prompts": "${P_CHANNEL}"
    }
  ],
  "bind": "127.0.0.1",
  "port": ${SCENARIO_PORT},
  "health_check_interval": ${HEALTH_TICK_S},
  "session_restart_delay": ${RESTART_DELAY_S},
  "exit_timeout": 5
}
EOF
    start_server --live
    wait_for_log "$(completion_match 1)" "${START_WAIT_S}" "${step}: the start pass never completed"
    expect_completion 1 "${step}" "0 not brought up"
    wait_until "${REPORT_WAIT_S}" "${step}: row ${P_ID} never reported in (waiting) after the start" \
        row_reads "${step}: bring-up" waiting
    sid="${ROW_SID}"
    session="${ROW_SESSION}"
    [[ -n "${sid}" ]] || fail "${step}: the live row ${P_ID} has no session_id"
    [[ -n "${session}" ]] || fail "${step}: the live row ${P_ID} names no tmux session"
    # src/server.ts: the MCP session's registration line.
    connected="$(matcher "[slack] Session connected: persona ${P_REF}")"
    wait_for_log "${connected}" "${CONNECT_WAIT_S}" "${step}: the server never registered the stub's session as P's"

    # Step 2 [harness]: the report-in delay in P's working directory.
    stub_mode "${work}" "${STUB_MODE_AT_ONCE}"
    stub_report_delay "${work}" "${REPORT_DELAY_S}"

    # Step 3 [harness]: P's worker ends with the stub's sentinel.
    sentinel_at="$(now_s)"
    "${SCENARIO_REAL_TMUX}" send-keys -t "=${session}:" __CSCB_TEST_EXIT__ Enter \
        || fail "${step}: could not send the sentinel into ${session}"
    wait_until "${ENDED_WAIT_S}" "${step}: row ${P_ID} never read ended or missing after the sentinel" \
        row_reads "${step}: after the sentinel" ended missing
    [[ "${ROW_SID}" == "${sid}" ]] \
        || fail "${step}: the ${ROW_STATE} row's session_id is '${ROW_SID}', not the live row's ${sid}"
    echo "${TEST_NAME}: ${step}: after the sentinel the row reads ${ROW_STATE} with session_id ${ROW_SID}"

    # Step 4: the bot server resumes P through its restart path.
    wait_until "${RESUME_WAIT_S}" "${step}: row ${P_ID} never read pending after the sentinel (no resume)" \
        row_reads "${step}: the resume" pending
    hold_at="${ROW_READ_AT}"
    hold_log0="$(line_count "${SLACK_STATE_DIR}/server.log")"
    posts0="$(( $(line_count "${SLACK_RECORD}") + 1 ))"

    # Step 5: the hold. The row: pending, the same session id, a launch start.
    [[ "${ROW_SID}" == "${sid}" ]] \
        || fail "${step}: the pending row's session_id is '${ROW_SID}', not the kept ${sid}"
    [[ -n "${ROW_LAUNCH}" ]] || fail "${step}: the pending row has no launch_started_at"
    launch_ms="$(date -u -d "${ROW_LAUNCH}" +%s%3N 2> /dev/null)" && [[ "${launch_ms}" =~ ^[0-9]+$ ]] \
        || fail "${step}: the pending row's launch_started_at '${ROW_LAUNCH}' does not parse"
    echo "${TEST_NAME}: ${step}: the held row reads pending, session_id ${ROW_SID}, launch_started_at ${ROW_LAUNCH}"
    [[ -z "${ROW_SESSION}" ]] || session="${ROW_SESSION}"
    restart_lines="$(grep -F -- "Scheduling restart for persona=${P_KEY} " "${SLACK_STATE_DIR}/server.log" || true)"
    echo "${TEST_NAME}: ${step}: what scheduled the restart (src/restart.ts scheduleRestart lines): ${restart_lines:-none}"

    # The leg's one resume: the bot server's, after the sentinel.
    mapfile -t lines < <(server_calls resume "${sentinel_at}" -)
    (( ${#lines[@]} == 1 )) || fail "${step}: ${#lines[@]} resume call(s) of ${P_ID} by the bot server after the sentinel, not one"
    resume_line="${lines[0]}"
    resume_at="$(cut -f2 <<< "${resume_line}")"
    (( $(server_count resume - "${sentinel_at}") == 0 )) \
        || fail "${step}: the bot server resumed ${P_ID} before the sentinel"
    echo "${TEST_NAME}: ${step}: the bot server's calls of ${P_ID} from the sentinel to the resume (recorded, not asserted): $(server_calls "" "${sentinel_at}" "${resume_at}" | cut -f6 | tr '\n' ';')"

    wait_until "${SESSION_WAIT_S}" "${step}: no tmux session ${session} for the held row" has_session "${session}"

    # The forced resume (fixtures/fmk-driver.ts, a CSCB process).
    drv_out="${SCENARIO_ROOT}/fmk-driver-resume.out"
    drv_err="${SCENARIO_ROOT}/fmk-driver-resume.err"
    drv_at="$(now_s)"
    cscb_run env "CSCB_PKG_DIR=${PKG_DIR}" "DRIVER_PERSONA=${P_NAME}" "DRIVER_PERSONA_CHANNEL=${P_CHANNEL}" \
        "DRIVER_WORKING_DIRECTORY=${work}" bun --no-install "${FMK_DRIVER}" resume \
        < /dev/null > "${drv_out}" 2> "${drv_err}" || drv_rc=$?
    drv_end="$(now_s)"
    drv_s="$(seconds_between "${drv_at}" "${drv_end}")"
    mapfile -t outcome < <(grep -E '^DRIVER(_FAIL)?:' "${drv_out}" || true)
    if (( drv_rc != 0 || ${#outcome[@]} != 1 )) || [[ "${outcome[0]}" != "DRIVER: FORCED resume "* ]]; then
        sed 's/^/  | /' "${drv_out}" >&2
        tail -n 20 "${drv_err}" | sed 's/^/  | /' >&2
        fail "${step}: the forced resume exited ${drv_rc} with ${#outcome[@]} outcome line(s) (first: ${outcome[0]:-none})"
    fi
    drv_line="${outcome[0]}"
    echo "${TEST_NAME}: ${step}: the forced resume (${drv_s}s): ${drv_line:0:600}"
    awk -v s="${drv_s}" -v b="${FORCED_RESUME_S}" 'BEGIN { exit !(s <= b) }' \
        || fail "${step}: the forced resume took ${drv_s}s, longer than FORCED_RESUME_S ${FORCED_RESUME_S}s the report-in delay is derived from"
    [[ "${drv_line}" == *" called=true "* ]] || fail "${step}: the forced resume was not called: ${drv_line}"
    [[ "${drv_line}" == *" error=${NOT_RESUMABLE} "* ]] || fail "${step}: the forced resume did not get ${NOT_RESUMABLE}: ${drv_line}"
    [[ "${drv_line}" == *" counted=false "* ]] || fail "${step}: the forced resume's ${NOT_RESUMABLE} was counted: ${drv_line}"
    echo "${TEST_NAME}: ${step}: the forced resume's own fields (recorded, not asserted):$(grep -oE ' (action|latched|class)=[^ ]+' <<< "${drv_line}" | tr '\n' ' ')"
    # It posted nothing: the driver installs no notifier, so a notice would
    # be logged on its stderr by either sink, never posted: src/session-manager.ts
    # sendPersonaNotice's no-notifier line (no export; ruling S7), or the
    # driver's own outage-notice line (fixtures/fmk-driver.ts).
    hits="$(grep -F -e "no notifier installed — notice for persona=${P_KEY} not posted" \
        -e "[fmk-driver] outage-notice persona=${P_KEY}: " "${drv_err}" || true)"
    if [[ -n "${hits}" ]]; then
        sed 's/^/  | /' <<< "${hits}" >&2
        fail "${step}: the forced resume tried to post a notice for P (its line on the driver's stderr)"
    fi
    # It is the driver's only launch call (spawn or resume).
    line="$(awk -F'\t' -v w="fmk-driver.ts resume" '$1 == "proc" && $2 == "run" && index($6, w) { l = $0 } END { print l }' "${SCENARIO_CSCB_RECORD}")"
    drv_pid="$(cut -f3 <<< "${line}")"
    [[ "${drv_pid}" =~ ^[0-9]+$ ]] || fail "${step}: the record holds no run entry for the driver"
    mapfile -t lines < <(awk -F'\t' -v p="${drv_pid}" -v a="${drv_at}" '$1 == "call" && $4 == p && $2 + 0 >= a + 0' "${SCENARIO_AD_SHIM_LOG}")
    for line in "${lines[@]}"; do
        _scenario_split_line "${line}" && _scenario_decode_words || fail "${step}: a driver call line does not parse: ${line}"
        _scenario_ad_verb
        case "${_L_VERB}" in
            spawn) fail "${step}: the driver made a spawn: ${line}" ;;
            resume)
                [[ " ${_L_ARGS[*]} " == *" --instance-id ${P_ID} "* ]] \
                    || fail "${step}: the driver's resume names another row: ${line}"
                launches=$(( launches + 1 )) ;;
        esac
    done
    (( launches == 1 )) || fail "${step}: the driver made ${launches} resume call(s), not one"

    # Still held once the driver returned.
    read_row "${step}: after the forced resume"
    [[ "${ROW_STATE}" == pending && "${ROW_SID}" == "${sid}" ]] \
        || fail "${step}: after the forced resume the row reads ${ROW_STATE} (${ROW_SID}), not still pending: the delay ended too soon"
    last_clear="${ROW_READ_AT}"
    deadline=$(( $(_scenario_now_ms) + REPORT_WAIT_BOUND_S * 1000 ))
    while :; do
        read_row "${step}: waiting for SessionStart"
        if [[ "${ROW_STATE}" != pending ]]; then
            live_at="${ROW_READ_AT}"
            break
        fi
        last_clear="${ROW_READ_AT}"
        (( $(_scenario_now_ms) < deadline )) || fail "${step}: delayed SessionStart never left pending"
        sleep "${SCENARIO_POLL_S}"
    done
    [[ "${ROW_STATE}" == waiting && "${ROW_SID}" == "${sid}" ]] \
        || fail "${step}: delayed SessionStart did not preserve the waiting session"
    hold_log1="$(line_count "${SLACK_STATE_DIR}/server.log")"
    awk -v s="$(seconds_between "${hold_at}" "${last_clear}")" -v t="${HEALTH_TICK_S}" 'BEGIN { exit !(s >= t) }' \
        || fail "${step}: the pending hold lasted less than a health tick"

    statuses="$(server_count status "${hold_at}" "${last_clear}")"
    panes="$(server_count read-pane "${hold_at}" "${last_clear}")"
    ticks="$({ server_calls status - -; server_calls read-pane - -; } | sort -t $'\t' -k2,2n \
        | awk -F'\t' -v a="${hold_at}" -v b="${last_clear}" '
            { verb = (index(" " $6 " ", " read-pane ") ? "pane" : "status") }
            prev_status && verb != "pane" { n++ }
            { prev_status = (verb == "status" && $2 + 0 > a + 0 && $2 + 0 <= b + 0) }
            END { if (prev_status) n++; print n + 0 }')"
    want_ticks="$(awk -v a="${hold_at}" -v b="${last_clear}" -v t="${HEALTH_TICK_S}" 'BEGIN { n = int((b - a) / t) - 1; print (n < 0 ? 0 : n) }')"
    echo "${TEST_NAME}: ${step}: in the hold before the dialog ($(seconds_between "${hold_at}" "${last_clear}")s): ${statuses} status read(s) and ${panes} read-pane call(s) of P by the bot server, ${ticks} status read(s) with no read-pane after them (at least ${want_ticks} wanted)"
    (( ticks >= want_ticks )) \
        || fail "${step}: only ${ticks} bot-server status read(s) of P in the hold had no read-pane after them, fewer than ${want_ticks}: health ticks did not read it every ${HEALTH_TICK_S}s"

    # No spawn, reuse, resume or kill of P by the bot server after the resume.
    for verb in spawn resume kill; do
        n="$(server_count "${verb}" "${resume_at}" -)"
        (( n == 0 )) || fail "${step}: the bot server made ${n} ${verb} call(s) of ${P_ID} after the leg's resume"
    done

    # No send-keys of P from any process between the resume and the delay's end.
    mapfile -t lines < <(any_calls_naming send-keys "${resume_at}" "${last_clear}")
    (( ${#lines[@]} == 0 )) || {
        printf '  | %s\n' "${lines[@]}" >&2
        fail "${step}: ${#lines[@]} send-keys call(s) of ${P_ID} before the delay ended"
    }
    for verb in read-pane send-keys; do
        n="$(server_count "${verb}" "${resume_at}" "${live_at}")"
        (( n == 0 )) || fail "${step}: ${n} automatic ${verb} call(s) before delayed SessionStart"
    done

    # No post in the hold.
    mapfile -t lines < <(record_posts "${posts0}")
    (( ${#lines[@]} == 0 )) || {
        printf '  | %s\n' "${lines[@]}" >&2
        fail "${step}: ${#lines[@]} post(s) reached the Slack stub's record while the row was pending"
    }

    # Scheduled/deferred recovery is allowed while AD says pending. The
    # call/post checks above prove that it performs no keys, pane read or
    # launch. Retain the diagnostic window without treating prose as action.
    hits="$(sed -n "$(( hold_log0 + 1 )),${hold_log1}p" "${SLACK_STATE_DIR}/server.log" \
        | naming_persona "${P_KEY}" "${P_REF}" || true)"
    echo "${TEST_NAME}: ${step}: pending recovery diagnostics (no lifecycle or key calls): ${hits}"

    # Every post across the leg (recorded, not asserted).
    mapfile -t lines < <(record_posts 1 | jq -c '{method, channel, text: ((.text // "") | .[0:160])}')
    echo "${TEST_NAME}: ${step}: ${#lines[@]} post(s) across the leg"
    for line in "${lines[@]}"; do
        echo "${TEST_NAME}: ${step}:   ${line}"
    done

    stop_server --stop-bots
    stop_tracked_pid "${SLACK_STUB_PID}" 10 "${step}: the Slack stub did not exit on SIGTERM"
}


# ---------------------------------------------------------------------------
# Helpers of the launch-timeout and restart legs
# ---------------------------------------------------------------------------

# persona_json <name> <credentials-file> <working-dir> <channel>: one persona
# object of the config.
persona_json() {
    jq -n -c --arg n "$1" --arg c "$2" --arg w "$3" --arg ch "$4" \
        '{name: $n, credentials_file: $c, working_directory: $w, channels: [{id: $ch, delivery: "all"}], permission_prompts: $ch}'
}

# write_personas_config <persona-json>...: the config with those personas and
# the health check off (`health_check_interval` 0, ruling S3).
write_personas_config() {
    printf '%s\n' "$@" | jq -s --argjson port "${SCENARIO_PORT}" \
        '{personas: ., bind: "127.0.0.1", port: $port, health_check_interval: 0, session_restart_delay: 5, exit_timeout: 5}' \
        | write_config
}

# poll_row_of <id> <step>: `read_row_of`, except that a row agent-director
# does not know (ErrSpawnNotFound) reads ROW_STATE `absent` instead of
# failing.
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

# launch_ms <text>: print a launch_started_at as epoch milliseconds; false
# when it does not parse.
launch_ms() {
    local ms
    ms="$(date -u -d "$1" +%s%3N 2> /dev/null)" && [[ "${ms}" =~ ^[0-9]+$ ]] && printf '%s\n' "${ms}"
}

# plus_s <time> <seconds>: print <time> + <seconds>, three decimals.
plus_s() {
    awk -v t="$1" -v d="$2" 'BEGIN { printf "%.3f\n", t + d }'
}

# timeout_get_lines_seen <from-line>: true once each launch-timeout persona
# has its post-timeout get line after server.log line <from-line>.
timeout_get_lines_seen() {
    local role
    for role in "${LT_ROLES[@]}"; do
        [[ -n "$(log_hits "$1" "${GET_HEAD}" "${GET_OF[${LT_KEY[${role}]}]}")" ]] || return 1
    done
}

# lt_timers_stopped <from-line>: true once each launch-timeout persona's retry
# timer has a stopped line after server.log line <from-line>.
lt_timers_stopped() {
    local role
    for role in "${LT_ROLES[@]}"; do
        [[ -n "$(log_hits "$1" "${RT_STOPPED[${LT_KEY[${role}]}]}")" ]] || return 1
    done
}

# server_read_pane_seen <id>: true once the bot server has read row <id>'s pane.

# end_worker <id> <step>: a plain stop has left row <id>'s worker running;
# end it with the stub's sentinel, sent into its pane with the real tmux, and
# wait until the row reads ended or missing.
end_worker() {
    read_row_of "$1" "$2"
    [[ -n "${ROW_SESSION}" ]] || fail "$2: row $1 names no tmux session"
    "${SCENARIO_REAL_TMUX}" send-keys -t "=${ROW_SESSION}:" __CSCB_TEST_EXIT__ Enter \
        || fail "$2: could not send the sentinel into ${ROW_SESSION}"
    wait_until "${ENDED_WAIT_S}" "$2: row $1 never read ended or missing after the sentinel" \
        row_of_reads "$1" "$2" ended missing
}

# ---------------------------------------------------------------------------
# The launch-timeout legs: a plain spawn, a reuse and a resume (response loss)
# ---------------------------------------------------------------------------

lt_launch_reply_faults() {
    require_ci_image 'launch response faults'
    require_scenario_home 'launch response faults'
    local file="${SCENARIO_AD_SHIM_LOG%.log}.faults" role verb
    # Preserve collisions and all failed launches. Each rule is consumed
    # only when this persona's real launch succeeds with its identity saved.
    {
        flock -x 8 || fail 'launch response faults: cannot lock rules'
        for role in "${LT_ROLES[@]}"; do
            verb=spawn
            [[ "${role}" != resume ]] || verb=resume
            printf '%s instance=%s launch-reply-timeout 1\n' "${verb}" "${LT_ID[${role}]}"
        done > "${file}"
    } 8> "${file}.lock"
}

leg_launch_timeouts() {
    local step="launch timeouts" creds="${SCENARIO_ROOT}/credentials-lt" role id ref key verb
    local log0 lt_start reset_at="" deadline left reads="${SCENARIO_ROOT}/lt-reads.tsv" table="${SCENARIO_ROOT}/lt-calls.tsv"
    local -A sid=() out_at=() out_state=() out_sid=() launch_at=() get_at=() send_at=() pane_at=()
    local lines=() hits=() posts=() n t connected_at ended pend srv

    # Step 1: the reuse and resume personas are brought up, then their workers end.
    new_state_dir bringup
    mkdir -m 700 "${creds}"
    start_slack_stub "${SCENARIO_ROOT}/slack-stub-lt" "${LT_SUFFIX[@]}"
    for role in "${LT_ROLES[@]}"; do
        printf '{"bot_token": "%s", "app_token": "%s"}\n' "$(fake_token bot "${LT_SUFFIX[${role}]}")" "$(fake_token app "${LT_SUFFIX[${role}]}")" \
            | write_file "${creds}/${role}.json" 600
    done
    LT_WORK[reuse]="$(make_workdir reuse-a)"
    LT_WORK[resume]="$(make_workdir resume)"
    write_personas_config \
        "$(persona_json "${LT_NAME[reuse]}" "${creds}/reuse.json" "${LT_WORK[reuse]}" "${LT_CHANNEL[reuse]}")" \
        "$(persona_json "${LT_NAME[resume]}" "${creds}/resume.json" "${LT_WORK[resume]}" "${LT_CHANNEL[resume]}")"
    start_server --live
    wait_for_log "$(completion_match 2)" "${START_WAIT_S}" "${step}: the bring-up's start pass never completed"
    expect_completion 2 "${step}: the bring-up" "0 not brought up"
    for role in reuse resume; do
        wait_until "${REPORT_WAIT_S}" "${step}: row ${LT_ID[${role}]} never reported in (waiting) at the bring-up" \
            row_of_reads "${LT_ID[${role}]}" "${step}: the bring-up" waiting
        sid[${role}]="${ROW_SID}"
        [[ -n "${sid[${role}]}" ]] || fail "${step}: the live ${role} row ${LT_ID[${role}]} has no session_id"
        wait_for_log "$(matcher "[slack] Session connected: persona ${LT_REF[${role}]}")" "${CONNECT_WAIT_S}" \
            "${step}: the server never registered the ${role} persona's session at the bring-up"
    done
    # A plain stop leaves the workers running, and no restart path runs when they end.
    stop_server
    for role in reuse resume; do
        end_worker "${LT_ID[${role}]}" "${step}: the ${role} worker"
        [[ "${ROW_SID}" == "${sid[${role}]}" ]] \
            || fail "${step}: the ${ROW_STATE} ${role} row's session_id is '${ROW_SID}', not the live row's ${sid[${role}]}"
        echo "${TEST_NAME}: ${step}: the ${role} row reads ${ROW_STATE} with session_id ${ROW_SID}"
    done

    # Step 2: the three personas, the reuse persona in another working
    # directory, in a new state dir (a start reads its state dir's
    # last-applied configuration; a change to it waits for a reload). Each
    # working directory has the report-in delay.
    new_state_dir launch
    LT_WORK[spawn]="$(make_workdir spawn)"
    LT_WORK[reuse]="$(make_workdir reuse-b)"
    for role in "${LT_ROLES[@]}"; do
        stub_mode "${LT_WORK[${role}]}" "${STUB_MODE_AT_ONCE}"
        stub_report_delay "${LT_WORK[${role}]}" "${LT_REPORT_DELAY_S}"
    done
    write_personas_config \
        "$(persona_json "${LT_NAME[spawn]}" "${creds}/spawn.json" "${LT_WORK[spawn]}" "${LT_CHANNEL[spawn]}")" \
        "$(persona_json "${LT_NAME[reuse]}" "${creds}/reuse.json" "${LT_WORK[reuse]}" "${LT_CHANNEL[reuse]}")" \
        "$(persona_json "${LT_NAME[resume]}" "${creds}/resume.json" "${LT_WORK[resume]}" "${LT_CHANNEL[resume]}")"

    # Step 3: lose successful launch responses, then start. A slow-create
    # timeout returns before AD saves pane identity on 0.12, so SessionStart
    # cannot report in; that is a different contract from this success leg.
    lt_launch_reply_faults
    log0="$(line_count "${SLACK_STATE_DIR}/server.log")"
    lt_start="$(now_s)"
    start_server --live
    srv="${SERVER_PID}"

    # Steps 4 and 5 [harness]: read the three rows until each has left
    # pending. The unchanged deadline is LAUNCH_END_WAIT_S + LT_REPORT_WAIT_S
    # from this polling phase's start, not a fresh 60 seconds after the gets.
    : > "${reads}"
    deadline=$(( $(_scenario_now_ms) + (LAUNCH_END_WAIT_S + LT_REPORT_WAIT_S) * 1000 ))
    while :; do
        if [[ -z "${reset_at}" ]] && timeout_get_lines_seen "${log0}"; then
            reset_at="$(now_s)"
            echo "${TEST_NAME}: ${step}: every launch call ended in its get by $(seconds_between "${lt_start}" "${reset_at}")s after the start"
        fi
        left=0
        for role in "${LT_ROLES[@]}"; do
            [[ -n "${out_at[${role}]:-}" ]] && continue
            poll_row_of "${LT_ID[${role}]}" "${step}: ${role}"
            printf '%s\t%s\t%s\n' "${role}" "${ROW_READ_AT}" "${ROW_STATE}" >> "${reads}"
            case "${ROW_STATE}" in
                absent | ended | missing | pending) left=1 ;;
                *)
                    out_at[${role}]="${ROW_READ_AT}"
                    out_state[${role}]="${ROW_STATE}"
                    out_sid[${role}]="${ROW_SID}" ;;
            esac
        done
        (( left )) || break
        if (( $(_scenario_now_ms) >= deadline )); then
            [[ -n "${reset_at}" ]] || fail "${step}: the three launch calls had not all ended in their get within the combined $((LAUNCH_END_WAIT_S + LT_REPORT_WAIT_S))s polling bound"
            fail "${step}: not every row left pending within the combined $((LAUNCH_END_WAIT_S + LT_REPORT_WAIT_S))s polling bound (${LT_REPORT_WAIT_S}s reporting allowance)"
        fi
        sleep "${SCENARIO_POLL_S}"
    done
    [[ -n "${reset_at}" ]] || fail "${step}: a row left pending before every launch call had ended in its get"
    wait_for_log "$(completion_match 3)" "${START_WAIT_S}" "${step}: the timeout start's start pass never completed"
    echo "${TEST_NAME}: ${step}: the timeout start's summary (recorded): $(log_hits "${log0}" "$(completion_match 3)" | tail -n 1 | cut -f3)"
    for role in "${LT_ROLES[@]}"; do
        [[ "${out_state[${role}]}" == waiting ]] || fail "${step}: ${role}: the row left pending for ${out_state[${role}]}, not waiting"
        wait_for_log "$(matcher "[slack] Session connected: persona ${LT_REF[${role}]}")" "${CONNECT_WAIT_S}" \
            "${step}: ${role}: the server never registered the persona's session after its launch timeout"
    done
    [[ "${out_sid[resume]}" == "${sid[resume]}" ]] \
        || fail "${step}: resume: the waiting row's session_id is '${out_sid[resume]}', not the resumed ${sid[resume]}"
    echo "${TEST_NAME}: ${step}: the reuse row's session_id was ${sid[reuse]} and is now ${out_sid[reuse]} (recorded)"

    # Step 6: each persona's retry timer has stopped (recorded when not).
    _scenario_poll_until "${LT_RETRY_WAIT_S}" lt_timers_stopped "${log0}" \
        || echo "${TEST_NAME}: ${step}: not every retry timer had stopped ${LT_RETRY_WAIT_S}s after the launches (recorded)"

    # Step 7: the checks, over the bot server's calls (`call_table`).
    call_table "${table}"
    for role in "${LT_ROLES[@]}"; do
        id="${LT_ID[${role}]}" ref="${LT_REF[${role}]}" key="${LT_KEY[${role}]}"
        echo "${TEST_NAME}: ${step}: ${role}: the bot server's calls of ${id} (recorded): $(calls "${table}" "${srv}" "${id}" - - - | awk -F'\t' '{ a = $5; sub(/ --label .*/, " …", a); printf "%s %s [%s]; ", $1, $3, a }')"

        # The launch, of its kind: the plain spawn carries no --reuse-finished,
        # the reuse spawn carries it, the third is a resume. The reuse's and
        # the resume's own plain spawn collided first (recorded).
        case "${role}" in
            spawn)
                launch_at[${role}]="$(first_call_at "${table}" "${srv}" "${id}" spawn - - '!--reuse-finished')"
                n="$(count_calls "${table}" "${srv}" "${id}" spawn - - --reuse-finished)"
                (( n == 0 )) || fail "${step}: ${role}: the bot server made ${n} reuse spawn(s) of ${id}"
                n="$(count_calls "${table}" "${srv}" "${id}" resume - -)"
                (( n == 0 )) || fail "${step}: ${role}: the bot server made ${n} resume(s) of ${id}" ;;
            reuse)
                launch_at[${role}]="$(first_call_at "${table}" "${srv}" "${id}" spawn - - --reuse-finished)"
                n="$(count_calls "${table}" "${srv}" "${id}" resume - -)"
                (( n == 0 )) || fail "${step}: ${role}: the bot server made ${n} resume(s) of ${id}" ;;
            resume)
                launch_at[${role}]="$(first_call_at "${table}" "${srv}" "${id}" resume - -)"
                n="$(count_calls "${table}" "${srv}" "${id}" spawn - - --reuse-finished)"
                (( n == 0 )) || fail "${step}: ${role}: the bot server made ${n} reuse spawn(s) of ${id}" ;;
        esac
        [[ -n "${launch_at[${role}]}" ]] || fail "${step}: ${role}: the bot server made no launch of its kind for ${id}"
        verb=spawn
        [[ "${role}" != resume ]] || verb=resume
        n="$(awk -F'\t' -v p="${srv}" -v w="${verb} instance=${id} launch-reply-timeout 1" \
            '$1 == "fault" && $4 == p && $6 == w { n++ } END { print n + 0 }' "${SCENARIO_AD_SHIM_LOG}")"
        (( n == 1 )) || fail "${step}: ${role}: ${n} successful launch responses lost, not one"
        if [[ "${role}" != spawn ]]; then
            echo "${TEST_NAME}: ${step}: ${role}: its plain spawn's collision (recorded): $(log_hits "${log0}" "[slack] spawnForPersona: collision resolved, state=" "for ${ref}" | cut -f3 | tr '\n' '|')"
        fi

        mapfile -t hits < <(log_hits "${log0}" "${TIMEOUT_PHRASE}" | naming_persona "${key}" "${ref}")
        mapfile -t lines < <(log_hits "${log0}" "${GET_HEAD}" "${GET_OF[${key}]}")
        (( ${#lines[@]} == 1 )) || fail "${step}: ${role}: ${#lines[@]} post-timeout get line(s) for ${ref}, not one"
        echo "${TEST_NAME}: ${step}: ${role}: ${#hits[@]} server.log line(s) naming it carry the launch-timeout phrase; its get line: $(cut -f3 <<< "${lines[0]}")"
        (( ${#hits[@]} > 0 )) || [[ "${lines[0]}" == *"${GET_OF[${key}]}${FORM_CALL_TIMEOUT}"* ]] \
            || fail "${step}: ${role}: no server.log line naming ${ref} carries the launch-timeout phrase, and its get line names no '${FORM_CALL_TIMEOUT}'"
        [[ "${lines[0]}" == *"${GET_OF[${key}]}${FORM_CALL_TIMEOUT}"* || "${lines[0]}" == *"${GET_OF[${key}]}${FORM_TMUX_UNRESPONSIVE}"* ]] \
            || fail "${step}: ${role}: its get line names no launch timeout ('${FORM_CALL_TIMEOUT}' or '${FORM_TMUX_UNRESPONSIVE}')"
        [[ "${lines[0]}" == *"${OUTCOME_PENDING}"* ]] || fail "${step}: ${role}: its get line did not leave pending recovery to the timer"

        get_at[${role}]="$(first_call_at "${table}" "${srv}" "${id}" get "${launch_at[${role}]}" -)"
        [[ -n "${get_at[${role}]}" ]] || fail "${step}: ${role}: no recovery get after launch timeout"
        for verb in read-pane send-keys; do
            n="$(count_calls "${table}" "${srv}" "${id}" "${verb}" "${launch_at[${role}]}" "${out_at[${role}]}")"
            (( n == 0 )) || fail "${step}: ${role}: ${n} automatic startup ${verb} call(s)"
        done
        for verb in spawn resume; do
            n="$(count_calls "${table}" "${srv}" "${id}" "${verb}" "${launch_at[${role}]}" -)"
            (( n == 0 )) || fail "${step}: ${role}: the bot server made ${n} ${verb} call(s) of ${id} after its timed-out launch"
        done
        n="$(count_calls "${table}" - "${id}" kill "${lt_start}" -)"
        (( n == 0 )) || fail "${step}: ${role}: ${n} kill call(s) of ${id} by a CSCB process"
        # [harness] The row read pending after the get.
        pend="$(awk -F'\t' -v r="${role}" -v a="${get_at[${role}]}" '$1 == r && $3 == "pending" && $2 + 0 > a + 0 { n++ } END { print n + 0 }' "${reads}")"
        (( pend > 0 )) || fail "${step}: ${role}: no harness read of ${id} after the bot server's get read pending"

        # The tmux-unresponsive condition's ended line, no later than the
        # first harness read out of pending.
        ended="$(fmk_text tmuxUnresponsiveEndedLines "${key}")" || fail "${step}: fmk-texts.ts could not print tmuxUnresponsiveEndedLines"
        n="$(grep -nF -f <(printf '%s\n' "${ended}") "${SLACK_STATE_DIR}/server.log" | awk -F: -v s="${log0}" '$1 + 0 > s + 0 { print $1; exit }' || true)"
        [[ -n "${n}" ]] || fail "${step}: ${role}: no tmux-unresponsive ended line for ${key}"
        t="$(log_hits "$(( n - 1 ))" "" | head -n 1 | cut -f2)"
        awk -v e="${t:-0}" -v o="${out_at[${role}]}" 'BEGIN { exit !(e + 0 > 0 && e + 0 <= o + 0) }' \
            || fail "${step}: ${role}: the tmux-unresponsive ended line (${t:-no time}) came after the first harness read out of pending (${out_at[${role}]})"
        echo "${TEST_NAME}: ${step}: ${role}: its tmux-unresponsive condition (recorded): $(log_hits "${log0}" "${TU_HEAD[${key}]}" | cut -f3 | cut -c1-200 | tr '\n' '|')"

        # Every retry (its retry line exactly, never the re-armed line) reads
        # the row (status or get) within LT_RETRY_READ_S and launches nothing
        # (above); the retry-timer lines and the number of retries are
        # recorded (a retry is not certain; see the header).
        echo "${TEST_NAME}: ${step}: ${role}: its retry timer (recorded): $(log_hits "${log0}" "${RT_LINE_HEAD[${key}]}" | cut -f3 | cut -c1-200 | tr '\n' '|')"
        mapfile -t lines < <(retry_hits "${log0}" "${RT_RETRY_HEAD[${key}]}" "${RT_RETRY_FULL[${key}]}" "${RT_RETRY_PENDING[${key}]}" | cut -f2)
        echo "${TEST_NAME}: ${step}: ${role}: ${#lines[@]} retry line(s) of its retry timer (recorded)"
        for t in "${lines[@]}"; do
            n=$(( $(count_calls "${table}" "${srv}" "${id}" status "$(plus_s "${t}" -0.001)" "$(plus_s "${t}" "${LT_RETRY_READ_S}")") \
                + $(count_calls "${table}" "${srv}" "${id}" get "$(plus_s "${t}" -0.001)" "$(plus_s "${t}" "${LT_RETRY_READ_S}")") ))
            (( n > 0 )) || fail "${step}: ${role}: the retry at ${t} made no status or get of ${id} within ${LT_RETRY_READ_S}s"
        done

        # No CONFLICT latch.
        expect_count "$(matcher "[slack] conflict-latch: persona=${key} ")" 0 "${step}: ${role}: conflict-latch lines"
    done

    # No post (a spawn-failure or CONFLICT notice among them) from the timeout start on.
    mapfile -t posts < <(posts_to "" "${lt_start}")
    (( ${#posts[@]} == 0 )) || {
        printf '  | %s\n' "${posts[@]}" >&2
        fail "${step}: ${#posts[@]} post(s) reached the Slack stub's record after the timeout start"
    }

    # A plain stop, then each worker ends with the sentinel (`stop
    # --stop-bots` would wait out each persona's pause, which the stub never
    # answers, before its kill).
    stop_server
    for role in "${LT_ROLES[@]}"; do
        end_worker "${LT_ID[${role}]}" "${step}: the end"
    done
    stop_tracked_pid "${SLACK_STUB_PID}" 10 "${step}: the Slack stub did not exit on SIGTERM"
}


leg_restart_mid_launch() {
    local step="restart mid-launch" creds="${SCENARIO_ROOT}/credentials-rs" work log0 old_pid new_pid leg_start
    local l_ms l_s stopped_at restarted_at deadline out_at="" table="${SCENARIO_ROOT}/rs-calls.tsv" n verb
    local spawn_at first_pane send old_log posts=() lines=()

    new_state_dir restart
    mkdir -m 700 "${creds}"
    start_slack_stub "${SCENARIO_ROOT}/slack-stub-rs" "${Q_SUFFIX}"
    printf '{"bot_token": "%s", "app_token": "%s"}\n' "$(fake_token bot "${Q_SUFFIX}")" "$(fake_token app "${Q_SUFFIX}")" \
        | write_file "${creds}/q.json" 600
    work="$(make_workdir restart)"
    stub_mode "${work}" "${STUB_MODE_AT_ONCE}"
    stub_mode "${work}" "${STUB_MODE_AT_ONCE}"
    stub_report_delay "${work}" "${RESTART_REPORT_DELAY_S}"
    write_personas_config "$(persona_json "${Q_NAME}" "${creds}/q.json" "${work}" "${Q_CHANNEL}")"

    # Step 1: the server launches Q, whose stub shows its starting screen.
    leg_start="$(now_s)"
    start_server --live
    old_pid="${SERVER_PID}"
    wait_for_log "$(completion_match 1)" "${START_WAIT_S}" "${step}: the first start pass never completed"
    wait_until "${REPORT_WAIT_S}" "${step}: row ${Q_ID} never read pending" row_of_reads "${Q_ID}" "${step}: the launch" pending
    l_ms="$(launch_ms "${ROW_LAUNCH}")" || fail "${step}: the pending row's launch_started_at '${ROW_LAUNCH}' does not parse"
    l_s="$(awk -v m="${l_ms}" 'BEGIN { printf "%.3f\n", m / 1000 }')"
    echo "${TEST_NAME}: ${step}: Q's row reads pending, launch_started_at ${ROW_LAUNCH}"
    # Step 2 [harness]: a plain stop, then a start, inside the delay.
    stopped_at="$(now_s)"
    stop_server
    log0="$(line_count "${SLACK_STATE_DIR}/server.log")"
    start_server --live
    new_pid="${SERVER_PID}"
    wait_for_count "$(completion_match 1)" 2 "${START_WAIT_S}" "${step}: the second start pass never completed"
    restarted_at="$(now_s)"
    echo "${TEST_NAME}: ${step}: stopped at +$(seconds_between "${l_s}" "${stopped_at}")s and started again by +$(seconds_between "${l_s}" "${restarted_at}")s from the launch start"
    awk -v r="${restarted_at}" -v l="${l_s}" -v d="${RESTART_REPORT_DELAY_S}" 'BEGIN { exit !(r - l < d) }' \
        || fail "${step}: the stop and start ended past the report-in delay ${RESTART_REPORT_DELAY_S}s from the launch start"
    read_row_of "${Q_ID}" "${step}: after the restart"
    [[ "${ROW_STATE}" == pending && "$(launch_ms "${ROW_LAUNCH}")" == "${l_ms}" ]] \
        || fail "${step}: after the restart Q's row reads ${ROW_STATE} (launch ${ROW_LAUNCH}), not the same pending launch"

    # Step 3 [harness]: read the row until it leaves pending, bounded from the launch start.
    deadline=$(( l_ms + RESTART_CLEAR_BOUND_S * 1000 ))
    while :; do
        read_row_of "${Q_ID}" "${step}: the wait"
        if [[ "${ROW_STATE}" != pending ]]; then
            out_at="${ROW_READ_AT}"
            break
        fi
        (( $(_scenario_now_ms) < deadline )) \
            || fail "${step}: Q's row still pending ${RESTART_CLEAR_BOUND_S}s after its launch start (G, the retry ceiling and ${RESTART_LAP_SLACK_S}s)"
        sleep "${RESTART_POLL_S}"
    done
    echo "${TEST_NAME}: ${step}: Q's row left pending for ${ROW_STATE} $(seconds_between "${l_s}" "${out_at}")s after its launch start"
    [[ "${ROW_STATE}" == waiting ]] || fail "${step}: Q's row left pending for ${ROW_STATE}, not waiting"
    [[ -n "${ROW_SID}" ]] || fail "${step}: Q's waiting row has no session_id"

    # Step 4: the checks, over the CSCB processes' calls (`call_table`).
    call_table "${table}"
    echo "${TEST_NAME}: ${step}: the old server's calls of ${Q_ID} (recorded): $(calls "${table}" "${old_pid}" "${Q_ID}" - - - | awk -F'\t' '{ a = $5; sub(/ --label .*/, " …", a); printf "%s %s [%s]; ", $1, $3, a }')"
    echo "${TEST_NAME}: ${step}: the new server's calls of ${Q_ID} (recorded): $(calls "${table}" "${new_pid}" "${Q_ID}" - - - | awk -F'\t' '{ a = $5; sub(/ --label .*/, " …", a); printf "%s %s [%s]; ", $1, $3, a }')"
    # The new server launched nothing: its start pass's one plain spawn
    # collided with the pending row (the ladder's first step), and no spawn,
    # reuse, resume or kill followed.
    n="$(count_calls "${table}" "${new_pid}" "${Q_ID}" spawn - - '!--reuse-finished')"
    (( n == 1 )) || fail "${step}: the new server made ${n} plain spawn(s) of ${Q_ID}, not its start pass's one"
    spawn_at="$(first_call_at "${table}" "${new_pid}" "${Q_ID}" spawn - -)"
    n="$(count_calls "${table}" "${new_pid}" "${Q_ID}" spawn - - --reuse-finished)"
    (( n == 0 )) || fail "${step}: the new server made ${n} reuse spawn(s) of ${Q_ID}"
    for verb in resume kill; do
        n="$(count_calls "${table}" "${new_pid}" "${Q_ID}" "${verb}" - -)"
        (( n == 0 )) || fail "${step}: the new server made ${n} ${verb} call(s) of ${Q_ID}"
    done
    mapfile -t lines < <(log_hits "${log0}" "[slack] spawnForPersona: collision resolved, state=pending for ${Q_REF}" | cut -f2)
    (( ${#lines[@]} == 1 )) || fail "${step}: ${#lines[@]} collision line(s) reading Q's row pending in the new server's log, not one"
    awk -v c="${lines[0]}" -v s="${spawn_at}" 'BEGIN { exit !(c + 0 > s + 0) }' \
        || fail "${step}: the new server's collision line came before its plain spawn"
    for verb in read-pane send-keys; do
        n="$(count_calls "${table}" - "${Q_ID}" "${verb}" "${leg_start}" "${out_at}")"
        (( n == 0 )) || fail "${step}: ${n} automatic ${verb} call(s) while Q was pending"
    done
    # Shutdown ends the old controller's ownership; its PID makes no later calls.
    n="$(calls "${table}" "${old_pid}" "${Q_ID}" - "${restarted_at}" - | grep -c . || true)"
    (( n == 0 )) || fail "${step}: old controller made ${n} calls after restart"
    echo "${TEST_NAME}: ${step}: the new server's retry and pending-row lines for Q (recorded): $(log_hits "${log0}" "" | cut -f3 | grep -F -e "${RT_LINE_HEAD[${Q_KEY}]}" -e "${PENDING_ROW_HEAD} ${Q_REF}" | cut -c1-260 | tr '\n' '|')"
    # No post in the leg.
    mapfile -t posts < <(posts_to "" "${leg_start}")
    (( ${#posts[@]} == 0 )) || {
        printf '  | %s\n' "${posts[@]}" >&2
        fail "${step}: ${#posts[@]} post(s) reached the Slack stub's record in the leg"
    }

    stop_server
    end_worker "${Q_ID}" "${step}: the end"
    stop_tracked_pid "${SLACK_STUB_PID}" 10 "${step}: the Slack stub did not exit on SIGTERM"
}

# ---------------------------------------------------------------------------
# Scenario 11: a failed fresh spawn (fail-create), waited out from G
# ---------------------------------------------------------------------------

# fc_failure_seen <from-line>: true once server.log holds, after line
# <from-line>, the plain spawn's ErrTmuxSessionCreate line for F.
fc_failure_seen() {
    [[ -n "$(log_hits "$1" '[slack] spawnForPersona: ' "failed for ${F_REF}: " "${SESSION_CREATE_ERR}")" ]]
}

# fc_only_pending <step>: a harness `list --state pending`; fail unless F's
# row is the only `pending` row.
fc_only_pending() {
    local ids
    ad_capture list --state pending
    (( AD_RC == 0 )) || fail "$1: the harness list exited ${AD_RC}: $(head -c 300 "${AD_ERR}")"
    ids="$(jq -r '(if type == "array" then . else .spawns end)[] | .instance_id' "${AD_OUT}" | sort | tr '\n' ' ')" \
        || fail "$1: the harness list printed no row list: $(head -c 300 "${AD_OUT}")"
    [[ "${ids}" == "${F_ID} " ]] || fail "$1: the pending rows are '${ids% }', not ${F_ID} alone"
}

leg_fail_create() {
    local step="scenario 11" creds="${SCENARIO_ROOT}/credentials-fc" work log0 srv leg_start reset_at creates
    local l_ms l_s g_at deadline launch out_at first_missing="" reads="${SCENARIO_ROOT}/fc-reads.tsv"
    local table="${SCENARIO_ROOT}/fc-calls.tsv" n spawn0 next_at fm_at get_at rule_at
    local lines=() notices=()

    new_state_dir failcreate
    mkdir -m 700 "${creds}"
    start_slack_stub "${SCENARIO_ROOT}/slack-stub-fc" "${F_SUFFIX}"
    printf '{"bot_token": "%s", "app_token": "%s"}\n' "$(fake_token bot "${F_SUFFIX}")" "$(fake_token app "${F_SUFFIX}")" \
        | write_file "${creds}/f.json" 600
    work="$(make_workdir failcreate)"
    stub_mode "${work}" "${STUB_MODE_AT_ONCE}"
    write_personas_config "$(persona_json "${F_NAME}" "${creds}/f.json" "${work}" "${F_CHANNEL}")"

    # Step 1 [harness]: F has no row.
    poll_row_of "${F_ID}" "${step}: before the start"
    [[ "${ROW_STATE}" == absent ]] || fail "${step}: row ${F_ID} reads ${ROW_STATE} before the start, not absent"

    # Step 2: fail-create, then the start: the server's plain spawn of F.
    tmux_shim_mode fail-create
    log0="$(line_count "${SLACK_STATE_DIR}/server.log")"
    leg_start="$(now_s)"
    start_server --live
    srv="${SERVER_PID}"

    # Step 3: once the spawn has failed, the tmux shim goes back to `log`.
    wait_until "${START_WAIT_S}" "${step}: no ${SESSION_CREATE_ERR} line for ${F_REF} after the start" \
        fc_failure_seen "${log0}"
    tmux_shim_mode log
    reset_at="$(now_s)"
    echo "${TEST_NAME}: ${step}: the spawn failed by $(seconds_between "${leg_start}" "${reset_at}")s after the start; the tmux shim is back in log mode. Its line (recorded): $(log_hits "${log0}" '[slack] spawnForPersona: ' "failed for ${F_REF}: " "${SESSION_CREATE_ERR}" | head -n 1 | cut -f3 | cut -c1-400)"
    creates="$(awk -F'\t' -v a="${leg_start}" -v b="${reset_at}" \
        '$1 == "call" && $2 + 0 > a + 0 && $2 + 0 <= b + 0 && $6 ~ /(^| )new-session( |$)/ { n++ } END { print n + 0 }' "${SCENARIO_TMUX_SHIM_LOG}")"
    (( creates >= 1 )) || fail "${step}: no new-session call reached the tmux shim while it was in fail-create"
    echo "${TEST_NAME}: ${step}: ${creates} new-session call(s) failed in fail-create (recorded)"
    wait_for_log "$(completion_match 1)" "${START_WAIT_S}" "${step}: the start pass never completed"
    echo "${TEST_NAME}: ${step}: the start pass's summary (recorded): $(log_hits "${log0}" "$(completion_match 1)" | tail -n 1 | cut -f3)"

    # Step 4 [harness]: the row reads pending with a launch start L, the only pending row.
    read_row_of "${F_ID}" "${step}: after the failure"
    [[ "${ROW_STATE}" == pending ]] || fail "${step}: after the failed spawn row ${F_ID} reads ${ROW_STATE}, not pending"
    l_ms="$(launch_ms "${ROW_LAUNCH}")" || fail "${step}: the pending row's launch_started_at '${ROW_LAUNCH}' does not parse"
    l_s="$(awk -v m="${l_ms}" 'BEGIN { printf "%.3f\n", m / 1000 }')"
    g_at="$(plus_s "${l_s}" "${G_S}")"
    echo "${TEST_NAME}: ${step}: F's row reads pending, launch_started_at ${ROW_LAUNCH}"
    fc_only_pending "${step}: after the failure"

    # Step 5 [harness]: read the row every FC_POLL_S until it is live,
    # bounded from L; before G, F's is the only pending row.
    : > "${reads}"
    deadline=$(( l_ms + FC_BRINGUP_BOUND_S * 1000 ))
    while :; do
        poll_row_of "${F_ID}" "${step}: the wait"
        printf '%s\t%s\t%s\n' "${ROW_READ_AT}" "${ROW_STATE}" "${ROW_LAUNCH}" >> "${reads}"
        case "${ROW_STATE}" in
            pending)
                launch="$(launch_ms "${ROW_LAUNCH}")" || fail "${step}: a pending read's launch_started_at '${ROW_LAUNCH}' does not parse"
                if [[ "${launch}" == "${l_ms}" ]] && awk -v n="$(now_s)" -v g="${g_at}" 'BEGIN { exit !(n + 0 < g + 0) }'; then
                    fc_only_pending "${step}: before G"
                fi ;;
            missing) [[ -n "${first_missing}" ]] || first_missing="${ROW_READ_AT}" ;;
            absent | ended) ;;
            *)
                out_at="${ROW_READ_AT}"
                break ;;
        esac
        (( $(_scenario_now_ms) < deadline )) \
            || fail "${step}: row ${F_ID} not live ${FC_BRINGUP_BOUND_S}s after its launch start (G, the retry ceiling and ${FC_BRINGUP_SLACK_S}s)"
        sleep "${FC_POLL_S}"
    done
    echo "${TEST_NAME}: ${step}: the row read ${ROW_STATE} $(seconds_between "${l_s}" "${out_at}")s after its launch start; the harness reads in order (recorded): $(cut -f2 "${reads}" | uniq -c | awk '{ printf "%s x%s; ", $2, $1 }')"
    [[ "${ROW_STATE}" == waiting ]] || fail "${step}: F's row came up ${ROW_STATE}, not waiting"
    wait_for_log "$(matcher "[slack] Session connected: persona ${F_REF}")" "${CONNECT_WAIT_S}" \
        "${step}: the server never registered F's session after the bring-up"

    # Step 6: the checks, over the bot server's calls (`call_table`).
    call_table "${table}"
    echo "${TEST_NAME}: ${step}: the bot server's calls of ${F_ID} (recorded): $(calls "${table}" "${srv}" "${F_ID}" - - - | awk -F'\t' '{ a = $5; sub(/ --label .*/, " …", a); printf "%s %s [%s]; ", $1, $3, a }')"
    echo "${TEST_NAME}: ${step}: the bot server's find-missing runs, from L (recorded): $(calls "${table}" "${srv}" - find-missing - - | cut -f1 | while read -r n; do printf '+%ss ' "$(seconds_between "${l_s}" "${n}")"; done)"
    # While fail-create was set, the server's one launch: F's plain spawn.
    mapfile -t lines < <(awk -F'\t' -v p="${srv}" -v a="${leg_start}" -v b="${reset_at}" \
        '$2 == p && ($3 == "spawn" || $3 == "resume") && $1 + 0 > a + 0 && $1 + 0 <= b + 0' "${table}")
    (( ${#lines[@]} == 1 )) || fail "${step}: the bot server made ${#lines[@]} launch call(s) while the shim was in fail-create, not one"
    [[ "$(cut -f4 <<< "${lines[0]}")" == "${F_ID}" && "$(cut -f3 <<< "${lines[0]}")" == spawn && " $(cut -f5 <<< "${lines[0]}") " != *" --reuse-finished "* ]] \
        || fail "${step}: the launch while the shim was in fail-create is not F's plain spawn: ${lines[0]}"
    spawn0="$(cut -f1 <<< "${lines[0]}")"
    # No bot-server find-missing from L to G after it.
    n="$(count_calls "${table}" "${srv}" - find-missing "${l_s}" "$(plus_s "${g_at}" -0.001)")"
    (( n == 0 )) || fail "${step}: the bot server ran find-missing ${n} time(s) between F's launch start and G after it"
    # F's next launch, and the run and the get before it.
    next_at="$(calls "${table}" "${srv}" "${F_ID}" - "${spawn0}" - | awk -F'\t' '$3 == "spawn" || $3 == "resume"' | head -n 1 | cut -f1)"
    [[ -n "${next_at}" ]] || fail "${step}: the bot server made no launch of ${F_ID} after the failed spawn"
    fm_at="$(calls "${table}" "${srv}" - find-missing - "${next_at}" | tail -n 1 | cut -f1)"
    [[ -n "${fm_at}" ]] || fail "${step}: no bot-server find-missing before F's next launch"
    awk -v f="${fm_at}" -v g="${g_at}" 'BEGIN { exit !(f + 0 >= g + 0) }' \
        || fail "${step}: the last bot-server find-missing before F's next launch came $(seconds_between "${l_s}" "${fm_at}")s after L, before G ${G_S}s"
    get_at="$(first_call_at "${table}" "${srv}" "${F_ID}" get "${fm_at}" "${next_at}")"
    [[ -n "${get_at}" ]] || fail "${step}: no bot-server get of ${F_ID} between its find-missing and its next launch"
    # The rule's round marked the row missing and its get read missing.
    mapfile -t lines < <(log_hits "${log0}" "${PENDING_ROW_HEAD} ${F_REF} rule (" "find-missing: ${MARKED_MISSING}" "get: missing")
    (( ${#lines[@]} == 1 )) || fail "${step}: ${#lines[@]} pending-row rule line(s) for F name the row marked and read missing, not one"
    rule_at="$(cut -f2 <<< "${lines[0]}")"
    awk -v r="${rule_at}" -v n="${next_at}" 'BEGIN { exit !(r + 0 <= n + 0) }' \
        || fail "${step}: the pending-row rule's missing line came after F's next launch"
    echo "${TEST_NAME}: ${step}: from L: find-missing +$(seconds_between "${l_s}" "${fm_at}")s, get +$(seconds_between "${l_s}" "${get_at}")s, next launch +$(seconds_between "${l_s}" "${next_at}")s ($(calls "${table}" "${srv}" "${F_ID}" - "$(plus_s "${next_at}" -0.001)" "${next_at}" | cut -f5 | sed 's/ --label .*/ …/'))"
    # The harness's read of missing, when it made one, came after the run.
    if [[ -n "${first_missing}" ]]; then
        awk -v m="${first_missing}" -v f="${fm_at}" 'BEGIN { exit !(m + 0 > f + 0) }' \
            || fail "${step}: the harness read F's row missing ($(seconds_between "${l_s}" "${first_missing}")s from L) before the bot server's find-missing"
        echo "${TEST_NAME}: ${step}: the harness read the row missing at +$(seconds_between "${l_s}" "${first_missing}")s from L (recorded)"
    else
        echo "${TEST_NAME}: ${step}: no harness read caught the row missing (recorded)"
    fi
    # No kill of F's row from any CSCB process.
    n="$(count_calls "${table}" - "${F_ID}" kill - -)"
    (( n == 0 )) || fail "${step}: ${n} kill call(s) of ${F_ID} by a CSCB process"
    # Only the bot server ran find-missing in the leg: none from the scenario's shell.
    mapfile -t lines < <(awk -F'\t' -v a="${leg_start}" -v p="${srv}" \
        '$1 == "call" && $2 + 0 > a + 0 && $4 != p && $6 ~ /(^| )find-missing( |$)/' "${SCENARIO_AD_SHIM_LOG}")
    (( ${#lines[@]} == 0 )) || {
        printf '  | %s\n' "${lines[@]}" >&2
        fail "${step}: ${#lines[@]} find-missing call(s) in the leg not made by the bot server"
    }
    echo "${TEST_NAME}: ${step}: F's retry timer (recorded): $(log_hits "${log0}" "${RT_LINE_HEAD[${F_KEY}]}" | cut -f3 | cut -c1-200 | tr '\n' '|')"
    echo "${TEST_NAME}: ${step}: F's pending-row rule lines (recorded): $(log_hits "${log0}" "${PENDING_ROW_HEAD} ${F_REF} rule (" | cut -f3 | cut -c1-900 | tr '\n' '|')"
    echo "${TEST_NAME}: ${step}: F's collision lines (recorded): $(log_hits "${log0}" "[slack] spawnForPersona: collision resolved, state=" "for ${F_REF}" | cut -f3 | tr '\n' '|')"
    echo "${TEST_NAME}: ${step}: startup-errors.log lines naming F (recorded): $(grep -F -- "${F_REF}" "${SLACK_STATE_DIR}/startup-errors.log" 2> /dev/null | cut -c1-300 | tr '\n' '|')"

    # Posts: none holds "dispatcher bug"; at most one spawn-failure post,
    # naming ErrTmuxSessionCreate (whether it was made is recorded); no other.
    mapfile -t lines < <(record_posts 1 | jq -c --arg w "${DISPATCHER_BUG}" 'select(tostring | ascii_downcase | contains($w))')
    (( ${#lines[@]} == 0 )) || {
        printf '  | %s\n' "${lines[@]}" >&2
        fail "${step}: ${#lines[@]} post(s) hold '${DISPATCHER_BUG}'"
    }
    mapfile -t notices < <(record_posts 1 | jq -c --arg h "${SPAWN_FAILURE_FIRST}" 'select((.text // "") | contains($h))')
    (( ${#notices[@]} <= 1 )) || {
        printf '  | %s\n' "${notices[@]}" >&2
        fail "${step}: ${#notices[@]} spawn-failure posts, not at most one"
    }
    if (( ${#notices[@]} == 1 )); then
        jq -e --arg h "${SPAWN_FAILURE_HEAD}" '(.text // "") | contains($h)' <<< "${notices[0]}" > /dev/null \
            || fail "${step}: the spawn-failure post names no ${SESSION_CREATE_ERR}: ${notices[0]:0:400}"
        echo "${TEST_NAME}: ${step}: the counted failure posted a spawn-failure notice (recorded): $(jq -c '{method, channel, text: ((.text // "") | .[0:300])}' <<< "${notices[0]}")"
    else
        echo "${TEST_NAME}: ${step}: the counted failure posted no spawn-failure notice (recorded)"
    fi
    mapfile -t lines < <(record_posts 1 | jq -c --arg h "${SPAWN_FAILURE_FIRST}" 'select((.text // "") | contains($h) | not) | {ts, method, channel, text: ((.text // "") | .[0:300])}')
    (( ${#lines[@]} == 0 )) || {
        printf '  | %s\n' "${lines[@]}" >&2
        fail "${step}: ${#lines[@]} post(s) other than the spawn-failure notice (a cap, alert or stuck-launch post among them?)"
    }

    stop_server
    end_worker "${F_ID}" "${step}: the end"
    stop_tracked_pid "${SLACK_STUB_PID}" 10 "${step}: the Slack stub did not exit on SIGTERM"
}

# ---------------------------------------------------------------------------
# Scenario 13: a paused bot's immediate resume meets "still stopping"
# ---------------------------------------------------------------------------

# server_status_after <id> <time>: print the time of the bot server's
# (SERVER_PID's) first `status` of row <id> after <time>, read straight from
# the agent-director shim's log (empty when none).
server_status_after() {
    awk -F'\t' -v p="${SERVER_PID}" -v id="$1" -v t="$2" '
        $1 == "call" && $4 == p && $2 + 0 > t + 0 && index(" " $6 " ", " status ") \
            && index(" " $6 " ", " --instance-id " id " ") { print $2; exit }' "${SCENARIO_AD_SHIM_LOG}"
}

# server_status_seen <id> <time>: true once `server_status_after` prints a time.
server_status_seen() {
    [[ -n "$(server_status_after "$1" "$2")" ]]
}

# st_timer_idle <from-line>: true when, after server.log line <from-line>, S's
# retry timer has as many stopped lines as armed lines (none armed, or each
# arm stopped).
st_timer_idle() {
    local armed stopped
    armed="$(log_hits "$1" "${RT_ARMED[${S_KEY}]}" | wc -l)"
    stopped="$(log_hits "$1" "${RT_STOPPED[${S_KEY}]}" | wc -l)"
    (( stopped >= armed ))
}

# st_refusal_seen <from-line>: true once server.log holds, after line
# <from-line>, the refusal of a `resume` of S carrying STILL_STOPPING_PHRASE.
st_refusal_seen() {
    [[ -n "$(log_hits "$1" "[slack] spawnForPersona: resume refused for ${S_REF}: " "${STILL_STOPPING}")" ]]
}

# st_session_gone <session>: true once the scenario's tmux server no longer
# holds <session>.
st_session_gone() {
    ! has_session "$1"
}

# st_no_posts <step> <from-time>: the Slack stub's record holds no post with
# S's tmux-unresponsive onset or the spawn-failure notice's first line, and
# no post at all from <from-time> (epoch seconds) on.
st_no_posts() {
    local posts=()
    mapfile -t posts < <(record_posts 1 | jq -c --arg o "${S_ONSET}" 'select((.text // "") | contains($o))')
    (( ${#posts[@]} == 0 )) || fail "$1: ${#posts[@]} post(s) hold S's tmux-unresponsive onset"
    mapfile -t posts < <(record_posts 1 | jq -c --arg h "${SPAWN_FAILURE_FIRST}" 'select((.text // "") | contains($h))')
    (( ${#posts[@]} == 0 )) || fail "$1: ${#posts[@]} post(s) hold a spawn-failure notice"
    mapfile -t posts < <(posts_to "" "$2")
    (( ${#posts[@]} == 0 )) || {
        printf '  | %s\n' "${posts[@]}" >&2
        fail "$1: ${#posts[@]} post(s) reached the Slack stub's record after the pause"
    }
}

leg_still_stopping() {
    local step="scenario 13" creds="${SCENARIO_ROOT}/credentials-st" work srv sid session pane_pid
    local t tick0 paused_at refusal_at release_at gone_at live_at next_tick gap retry_at get_at
    local resume1 resume2 table="${SCENARIO_ROOT}/st-calls.tsv" n verb hits connected
    local lines=() resumes=()

    new_state_dir paused
    mkdir -m 700 "${creds}"
    start_slack_stub "${SCENARIO_ROOT}/slack-stub-st" "${S_SUFFIX}"
    printf '{"bot_token": "%s", "app_token": "%s"}\n' "$(fake_token bot "${S_SUFFIX}")" "$(fake_token app "${S_SUFFIX}")" \
        | write_file "${creds}/s.json" 600
    work="$(make_workdir paused)"
    stub_mode "${work}" "${STUB_MODE_AT_ONCE}"
    stub_mode "${work}" "${STUB_MODE_LINGER_ON_EXIT}"
    persona_json "${S_NAME}" "${creds}/s.json" "${work}" "${S_CHANNEL}" \
        | jq -s --argjson port "${SCENARIO_PORT}" --argjson tick "${ST_TICK_S}" --argjson delay "${ST_RESTART_DELAY_S}" \
            '{personas: ., bind: "127.0.0.1", port: $port, health_check_interval: $tick, session_restart_delay: $delay, exit_timeout: 5}' \
        | write_config

    # Step 1: the live start brings S up; its stub reports in at once.
    start_server --live
    srv="${SERVER_PID}"
    wait_for_log "$(completion_match 1)" "${START_WAIT_S}" "${step}: the start pass never completed"
    expect_completion 1 "${step}" "0 not brought up"
    wait_until "${REPORT_WAIT_S}" "${step}: row ${S_ID} never reported in (waiting) after the start" \
        row_of_reads "${S_ID}" "${step}: bring-up" waiting
    sid="${ROW_SID}"
    session="${ROW_SESSION}"
    [[ -n "${sid}" && -n "${session}" ]] || fail "${step}: the live row ${S_ID} has no session_id or names no tmux session"
    # src/server.ts: the MCP session's registration line.
    connected="$(matcher "[slack] Session connected: persona ${S_REF}")"
    wait_for_log "${connected}" "${CONNECT_WAIT_S}" "${step}: the server never registered the stub's session as S's"
    # The bring-up launch's retry timer has stopped, so the refusal arms a
    # fresh timer whose first retry is RETRY_BASE_S after it.
    wait_until "${ST_TIMER_WAIT_S}" "${step}: S's retry timer from the bring-up had not stopped ${ST_TIMER_WAIT_S}s after it" \
        st_timer_idle 0

    t="$(now_s)"
    wait_until "$(( ST_TICK_S + 10 ))" "${step}: no health tick read S's status within $(( ST_TICK_S + 10 ))s" \
        server_status_seen "${S_ID}" "${t}"
    tick0="$(server_status_after "${S_ID}" "${t}")"

    # Step 3 [harness]: pause S from the scenario's shell, at once.
    ad_capture pause --instance-id "${S_ID}"
    paused_at="$(now_s)"
    (( AD_RC == 0 )) || fail "${step}: the harness pause of ${S_ID} exited ${AD_RC}: $(head -c 300 "${AD_ERR}") $(head -c 300 "${AD_OUT}")"
    awk -v a="${tick0}" -v b="${paused_at}" -v s="${ST_PAUSE_S}" 'BEGIN { exit !(b - a <= s) }' \
        || fail "${step}: the pause returned $(seconds_between "${tick0}" "${paused_at}")s after the tick read, longer than ST_PAUSE_S ${ST_PAUSE_S}s the tick interval is derived from"
    read_row_of "${S_ID}" "${step}: after the pause"
    [[ "${ROW_STATE}" == ended && "${ROW_SID}" == "${sid}" ]] \
        || fail "${step}: after the pause the row reads ${ROW_STATE} (${ROW_SID}), not ended with ${sid}"
    # The worker still runs: its tmux session and the pane's process.
    has_session "${session}" || fail "${step}: the paused worker's tmux session ${session} is gone before its release"
    pane_pid="$("${SCENARIO_REAL_TMUX}" display-message -p -t "=${session}:" '#{pane_pid}')" \
        || fail "${step}: tmux could not read ${session}'s pane"
    pid_alive "${pane_pid}" || fail "${step}: the paused worker's process ${pane_pid} is gone before its release"
    echo "${TEST_NAME}: ${step}: paused $(seconds_between "${tick0}" "${paused_at}")s after the tick read; the row reads ended while the worker ${pane_pid} still runs"

    # Step 4: the bot server's resume of S, refused as still stopping.
    wait_until "$(( ST_RESTART_DELAY_S + ST_LAUNCH_SLACK_S + 10 ))" "${step}: no still-stopping refusal of S's resume after the pause" \
        st_refusal_seen 0
    refusal_at="$(log_hits 0 "[slack] spawnForPersona: resume refused for ${S_REF}: " "${STILL_STOPPING}" | head -n 1 | cut -f2)"

    # Step 5 [harness]: release the lingering worker, at once.
    stub_release "${session}"
    release_at="$(now_s)"
    wait_until "${ST_SESSION_END_WAIT_S}" "${step}: the worker's tmux session ${session} still runs ${ST_SESSION_END_WAIT_S}s after its release" \
        st_session_gone "${session}"
    gone_at="$(now_s)"
    ! pid_alive "${pane_pid}" || fail "${step}: the released worker's process ${pane_pid} still runs"
    echo "${TEST_NAME}: ${step}: released $(seconds_between "${refusal_at}" "${release_at}")s after the refusal; the session was gone by $(seconds_between "${refusal_at}" "${gone_at}")s"

    # Step 6: a later resume succeeds: S reads waiting with the same session id.
    wait_until "$(( RETRY_BASE_S + ST_LAUNCH_SLACK_S + REPORT_WAIT_S ))" "${step}: row ${S_ID} never read waiting again after the release" \
        row_of_reads "${S_ID}" "${step}: after the release" waiting
    live_at="${ROW_READ_AT}"
    [[ "${ROW_SID}" == "${sid}" ]] || fail "${step}: the waiting row's session_id is '${ROW_SID}', not the paused row's ${sid}"
    wait_for_count "${connected}" 2 "${CONNECT_WAIT_S}" "${step}: the server never registered the resumed stub's session as S's"

    # Step 7: the next health tick's read (its onset check is covered by the
    # record checks run again after the server's stop).
    wait_until "$(( ST_TICK_S + 10 ))" "${step}: no health tick read S's status near ${ST_TICK_S}s after the first" \
        server_status_seen "${S_ID}" "$(plus_s "${tick0}" "$(( ST_TICK_S - ST_TICK_JITTER_S ))")"
    next_tick="$(server_status_after "${S_ID}" "$(plus_s "${tick0}" "$(( ST_TICK_S - ST_TICK_JITTER_S ))")")"
    gap="$(seconds_between "${tick0}" "${next_tick}")"
    awk -v g="${gap}" -v i="${ST_TICK_S}" -v j="${ST_TICK_JITTER_S}" 'BEGIN { exit !(g <= i + j) }' \
        || fail "${step}: the next tick's read of S came ${gap}s after the first, not within ${ST_TICK_JITTER_S}s of the interval ${ST_TICK_S}s"

    # Step 8: the checks, over the bot server's calls (`call_table`).
    call_table "${table}"
    echo "${TEST_NAME}: ${step}: the bot server's calls of ${S_ID} from the pause, from the tick read (recorded): $(calls "${table}" "${srv}" "${S_ID}" - "${paused_at}" - | awk -F'\t' -v t="${tick0}" '{ a = $5; sub(/ --label .*/, " …", a); printf "+%.3fs %s [%s]; ", $1 - t, $3, a }')"
    echo "${TEST_NAME}: ${step}: what scheduled the resume (recorded): $(log_hits 0 "Scheduling restart for persona=${S_KEY} " | cut -f3 | cut -c1-200 | tr '\n' '|')"
    # Exactly two bot-server resumes of S after the pause; no reuse spawn or
    # kill of S by any CSCB process (each ladder's plain spawn, its first
    # step, collides with the row: recorded).
    mapfile -t resumes < <(calls "${table}" "${srv}" "${S_ID}" resume "${paused_at}" - | cut -f1)
    (( ${#resumes[@]} == 2 )) || fail "${step}: ${#resumes[@]} bot-server resume(s) of ${S_ID} after the pause, not two (the refused one and the retry's)"
    resume1="${resumes[0]}"
    resume2="${resumes[1]}"
    n="$(count_calls "${table}" - "${S_ID}" spawn "${paused_at}" - --reuse-finished)"
    (( n == 0 )) || fail "${step}: ${n} reuse spawn(s) of ${S_ID} by a CSCB process after the pause"
    n="$(count_calls "${table}" - "${S_ID}" kill "${paused_at}" -)"
    (( n == 0 )) || fail "${step}: ${n} kill call(s) of ${S_ID} by a CSCB process after the pause"
    echo "${TEST_NAME}: ${step}: $(count_calls "${table}" "${srv}" "${S_ID}" spawn "${paused_at}" - '!--reuse-finished') plain spawn(s) of S after the pause, each a ladder's first step; their collision lines (recorded): $(log_hits 0 "[slack] spawnForPersona: collision resolved, state=" "for ${S_REF}" | cut -f3 | cut -c1-160 | tr '\n' '|')"
    # The first resume fell inside the stopping window from the pause.
    awk -v a="${paused_at}" -v b="${resume1}" -v w="${STOP_WINDOW_S}" 'BEGIN { exit !(b - a < w) }' \
        || fail "${step}: the first resume came $(seconds_between "${paused_at}" "${resume1}")s after the pause, outside the stopping window ${STOP_WINDOW_S}s"
    # Exactly one refusal of S's resume carries STILL_STOPPING_PHRASE, between the two resumes.
    mapfile -t lines < <(log_hits 0 "[slack] spawnForPersona: resume refused for ${S_REF}: " "${STILL_STOPPING}")
    (( ${#lines[@]} == 1 )) || fail "${step}: ${#lines[@]} still-stopping refusal line(s) for S's resume, not one"
    awk -v a="${resume1}" -v r="${refusal_at}" -v b="${resume2}" 'BEGIN { exit !(r + 0 >= a - 0.001 && r + 0 <= b + 0) }' \
        || fail "${step}: the refusal line is not between the two resumes"
    echo "${TEST_NAME}: ${step}: the refusal (recorded): $(cut -f3 <<< "${lines[0]}" | cut -c1-400)"
    echo "${TEST_NAME}: ${step}: every server.log line naming S that carries the still-stopping phrase (recorded): $(log_hits 0 "${STILL_STOPPING}" | cut -f3 | naming_persona "${S_KEY}" "${S_REF}" | cut -c1-200 | tr '\n' '|')"
    # One get after the UNAVAILABLE outcome (SRJ-407): its line, and exactly
    # one bot-server get of S from the refused resume to that line.
    mapfile -t lines < <(log_hits 0 "${GET_HEAD}${RESUME_WHAT}${GET_OF[${S_KEY}]}${FORM_UNAVAILABLE_HEAD}")
    (( ${#lines[@]} == 1 )) || fail "${step}: ${#lines[@]} post-refusal get line(s) for S's resume, not one"
    get_at="$(cut -f2 <<< "${lines[0]}")"
    echo "${TEST_NAME}: ${step}: the get line (recorded): $(cut -f3 <<< "${lines[0]}" | cut -c1-400)"
    n="$(count_calls "${table}" "${srv}" "${S_ID}" get "${resume1}" "${get_at}")"
    (( n == 1 )) || fail "${step}: ${n} bot-server get(s) of ${S_ID} between the refused resume and its get line, not one"
    # The retry: its line comes after the release (and after the worker's
    # session ended), and the second resume follows it, before the next tick.
    retry_at="$(retry_hits 0 "${RT_RETRY_HEAD[${S_KEY}]}" "${RT_RETRY_FULL[${S_KEY}]}" "${RT_RETRY_PENDING[${S_KEY}]}" \
        | awk -F'\t' -v r="${refusal_at}" '$2 + 0 > r + 0 { print $2; exit }')"
    [[ -n "${retry_at}" ]] || fail "${step}: no retry line for S after the refusal"
    echo "${TEST_NAME}: ${step}: S's retry-timer lines (recorded): $(log_hits 0 "${RT_LINE_HEAD[${S_KEY}]}" | cut -f3 | cut -c1-200 | tr '\n' '|')"
    awk -v r="${retry_at}" -v l="${release_at}" -v g="${gone_at}" 'BEGIN { exit !(l + 0 < r + 0 && g + 0 < r + 0) }' \
        || fail "${step}: the retry ($(seconds_between "${refusal_at}" "${retry_at}")s after the refusal) came before the release or before the worker's session ended"
    awk -v r="${retry_at}" -v b="${resume2}" -v s="${ST_LAUNCH_SLACK_S}" 'BEGIN { exit !(b + 0 > r - 0.001 && b - r <= s) }' \
        || fail "${step}: the second resume came $(seconds_between "${retry_at}" "${resume2}")s after the retry line, not within ${ST_LAUNCH_SLACK_S}s after it"
    awk -v b="${resume2}" -v n="${next_tick}" 'BEGIN { exit !(b + 0 < n + 0) }' \
        || fail "${step}: the second resume came after the next health tick's read of S"
    awk -v b="${resume2}" -v l="${live_at}" 'BEGIN { exit !(b + 0 < l + 0) }' \
        || fail "${step}: the row read waiting before the second resume"
    echo "${TEST_NAME}: ${step}: from the tick read: pause +$(seconds_between "${tick0}" "${paused_at}")s, refused resume +$(seconds_between "${tick0}" "${resume1}")s, release +$(seconds_between "${tick0}" "${release_at}")s, retry +$(seconds_between "${tick0}" "${retry_at}")s, resume +$(seconds_between "${tick0}" "${resume2}")s, next tick +${gap}s"
    echo "${TEST_NAME}: ${step}: S's tmux-unresponsive lines (recorded): $(log_hits 0 "${TU_HEAD[${S_KEY}]}" | cut -f3 | cut -c1-200 | tr '\n' '|')"
    # No post: no onset, alert or spawn-failure notice, and nothing else.
    st_no_posts "${step}" "${paused_at}"
    # Ruling S3: after the second resume no server.log line naming S has a
    # reconnect, relaunch, restart scheduling or not-connected text.
    hits="$(log_hits 0 "" | awk -F'\t' -v b="${resume2}" '$2 + 0 > b + 0' | cut -f3 \
        | naming_persona "${S_KEY}" "${S_REF}" | grep -iE "${HOLD_TROUBLE}" || true)"
    if [[ -n "${hits}" ]]; then
        sed 's/^/  | /' <<< "${hits}" >&2
        fail "${step}: after the second resume the server logged a reconnect, relaunch or not-connected line for S (ruling S3)"
    fi

    # The record checks again once the server has stopped: any post the
    # next tick's onset check made is in the record by then (shutdown ends
    # every episode silently, and the Slack stub still runs).
    stop_server
    st_no_posts "${step}: after the server's stop" "${paused_at}"
    end_worker "${S_ID}" "${step}: the end"
    stop_tracked_pid "${SLACK_STUB_PID}" 10 "${step}: the Slack stub did not exit on SIGTERM"
}

leg_launch_pending
leg_launch_timeouts
leg_restart_mid_launch
leg_fail_create
leg_still_stopping

assert_no_server_tmux
assert_no_cscb_include_finished
assert_no_cscb_delete
echo "${TEST_NAME}: PASS"
