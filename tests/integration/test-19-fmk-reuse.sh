#!/usr/bin/env bash
# Test 19 (HO §7 scenario 7; b.jg5 SRJ-1409; AC 1): reuse replaces delete.
# With `resume_enabled=false`, and separately with a missing transcript, a
# persona whose row is finished is brought up by a reuse spawn of its own id
# (`spawn --reuse-finished`), never a delete: the row reads `pending` with a
# `launch_started_at`, then `waiting`; `get`'s `prior_sessions` does not list
# the earlier life's session; the launch's `pre_trust` line says `ok`; and a
# `resume` of the new life before it is messaged answers
# ErrJsonlNeverWritten. In the missing-transcript leg the lost-transcript
# diagnosis runs before the reuse spawn (b.jg5 SRJ-707, SRJ-708, SRJ-711,
# SRJ-712, SRJ-413, SRJ-716, SRJ-1306, SRJ-1401, SRJ-1418; E22's hatch note:
# no CSCB `delete`).
#
# fmk setup (lib/scenario.sh fmk mode; b.jg5 SRJ-1306, SRJ-1401):
# - its own HOME, agent-director store and tmux server, all under
#   SCENARIO_ROOT, with the agent-director shim in front of the binary and the
#   tmux shim first on the PATH of every CSCB process (the bot server, `start`
#   and `stop` runs), which agent-director inherits;
# - the release start (SCENARIO_AD_START unset: the 0.11.0 release, installed
#   by its install.sh at sourcing), at agent-director's default settings (no
#   config.toml);
# - CSCB's configuration: `health_check_interval` 0, so no health tick
#   reconnects or relaunches a persona, and `session_restart_delay` 0, so the
#   MCP session a stub's exit closes schedules no restart (SRJ-1401: CSCB's
#   timings are changed only through its configuration); `resume_enabled`
#   false for leg E, true (the default, written out) for leg F;
# - every start is live (`start_server --live`), against the loopback Slack
#   stub (fixtures/slack-stub-server.ts, one for the script, every persona's
#   token pair answered ok);
# - each leg has its own persona (key, credentials, channel, directories):
#   E (`resume_enabled=false` leg) and F (missing-transcript leg). Each
#   persona's claude_config_dir holds a `.claude.json` (`{}`), as a user's
#   Claude config does, so agent-director's pre-trust has a file to write
#   (`pre_trust` `ok`; with no file it reports `failed`). Between legs the
#   harness plays the operator while the server is stopped: config.json is
#   rewritten to the next leg's persona and settings and the last-applied
#   record moved aside, so the next start applies config.json as it stands
#   (README "Reload");
# - checks read only their own leg's ids and window: server.log and
#   startup-errors.log from the leg's mark line, CSCB's agent-director calls
#   (`cscb_ad_calls`: only the agent-director shim's lines whose parent is a
#   CSCB process) from the mark's time; rows by a harness `get` or `status`.
#
# Stub modes (fixtures/stub-claude.sh): each persona's first life runs
# `dev-channels` (the reporting stub: the approver's Enter makes it report in,
# and it writes its transcript before SessionStart). Its new life runs
# `transcript-on-first-message` (a harness addition, confirm at the reconcile
# pass): the same dialog and report-in, but no transcript until a message is
# typed, so the new life's SessionStart finds no transcript, as a real
# never-messaged life's does. Each life is ended by the harness typing the
# stub's exit sentinel into the persona's pane (`stub_type_line`, a harness
# addition, confirm at the reconcile pass): the stub fires SessionEnd and
# exits, and the row reads `ended`.
#
# Harness check, first: the two harness additions on a stub the harness
# starts itself (`seed_unlabelled`, no agent-director and no CSCB process): in
# `transcript-on-first-message` no transcript exists at its dialog nor after
# the human's Enter reports it in, one exists once a line has been typed
# (`stub_type_line`), and the typed sentinel ends it.
#
# Legs, in run order (one scenario HOME, store, tmux server and Slack stub);
# each:
#   1. the persona's first life: config.json with the persona, a start, its
#      row `waiting`; the harness reads the life's session id (`get`'s
#      `claude_session_id`);
#   2. the harness ends that life with the exit sentinel, so the row reads
#      `ended` and its session is gone; leg F also deletes the life's
#      transcript, the file the row's `jsonl_path` names (working default:
#      the harness deletes it under SCENARIO_ROOT, a filesystem step);
#   3. `transcript-on-first-message` selected for the persona's directory; a
#      plain `stop`, the leg's mark, and a start. CSCB's first spawn of the
#      persona collides with the finished row, its collision `get` reads it
#      `ended`, and:
#        E (`resume_enabled=false`): the reuse spawn, with no `resume`;
#        F: CSCB's `resume` meets ErrJsonlMissing, the lost-transcript
#        diagnosis runs, then the reuse spawn;
#   4. a background harness `get` of the row (a subshell of the scenario's
#      own shell), started before the start and stopped once the row reads
#      `waiting`, records each read; checked: a read of `pending` with a
#      `launch_started_at`, then one of `waiting`, and no `waiting` before it;
#   5. checked after `waiting`:
#        - exactly one CSCB-parented `spawn` naming the persona's id with
#          `--reuse-finished` (agent-director shim's argv) after the mark;
#        - E: no CSCB `resume` of its id after the mark; F: at least one, and
#          the diagnosis's log line for F after the mark, its time no later
#          than the reuse spawn's call;
#        - a harness `get`: `prior_sessions` is an array that does not hold
#          the first life's session id;
#        - exactly one server.log line after the mark that is the launch's
#          `pre_trust` line for a reuse spawn with value `ok`, as the printer
#          renders it;
#        - no CSCB `delete` after the mark, and the row present;
#   6. working default (the SRD names no caller): the harness's own `resume`,
#      with no CSCB process able to act on the row: a plain `stop`, the
#      harness ends the unmessaged new life with the exit sentinel (the row
#      reads `ended`), then one `resume` of the persona's id through the
#      harness agent-director call (`ad_capture`), which must exit non-zero
#      answering ErrJsonlNeverWritten; the row is present afterwards.
#
# Waits: rows reporting in at ROW_WAIT_S; start passes at START_WAIT_S; a
# row reading `ended` after the sentinel, and its session going, at
# ENDED_WAIT_S; the harness check's transcript at TRANSCRIPT_WAIT_S. The
# pending window is read by the background `get` (POLL_PERIOD_S between
# reads), with no delay added to the stub: the window lasts from the reuse
# spawn's reset of the row until the approver's Enter reaches the stub and
# its SessionStart is applied.
#
# Matched values (every one printed by fixtures/fmk-texts.ts from the
# installed package, never typed here): instance ids and session names
# (`personaInstanceId`, `personaTmuxSessionName`, src/persona-identity.ts);
# the `pre_trust` line (`preTrustLogLine` with LAUNCH_VERB_REUSE_SPAWN,
# src/session-manager.ts, b.jg5 SRJ-413); the diagnosis's fixed fragment
# (JSONL_DIAGNOSIS_REUSE_WORDING) and its startup-errors classes
# (JSONL_DIAGNOSIS_INCONCLUSIVE_ENTRY_CLASS, JSONL_TRANSCRIPT_LOST_ENTRY_CLASS,
# src/session-manager.ts); the error names ErrJsonlNeverWritten and
# ErrJsonlMissing (`adErrorName`, src/agent-director-errors.ts); the
# last-applied record's suffix (LAST_APPLIED_FILE_SUFFIX, src/reload.ts).
# Quoted, with no exported builder: the diagnosis's log line head
# `[slack] ErrJsonlMissing diagnostic: ` (src/session-manager.ts
# diagnoseJsonlMissing, reportInconclusiveDiagnosis).
#
# Outcomes the SRD leaves open are logged as `NOTE:` lines, not asserted:
# each leg's CSCB calls of its id by verb, the new life's session id and
# `transcript_status`, the diagnosis's verdict (its startup-errors entries),
# and the pending reads' launch starts.
#
# The script ends with the closing assertions, `assert_no_server_tmux`,
# `assert_no_cscb_include_finished` and `assert_no_cscb_delete` (b.jg5
# SRJ-1418), in its own shell; their counts read only the shims' lines whose
# parent is a CSCB process. Later legs of test-19 go before them.
set -euo pipefail

TEST_NAME="test-19-fmk-reuse"
# shellcheck source=lib/scenario.sh
source "$(dirname "$0")/lib/scenario.sh"

# ---------------------------------------------------------------------------
# Values from the installed package (fixtures/fmk-texts.ts)
# ---------------------------------------------------------------------------

T19_PRINTER="${SCENARIO_FIXTURES}/fmk-texts.ts"

# t19_value <var> <entry> [<arg>...]: set <var> to the printer's value; fail
# naming the entry when the printer fails.
t19_value() {
    local -n t19_value_out="$1"
    shift
    t19_value_out="$(bun "${T19_PRINTER}" "$@")" || fail "the value printer failed for $*"
}

t19_value NEVER_WRITTEN adErrorName ErrJsonlNeverWritten
t19_value JSONL_MISSING adErrorName ErrJsonlMissing
t19_value REUSE_WORDING JSONL_DIAGNOSIS_REUSE_WORDING
t19_value INCONCLUSIVE_CLASS JSONL_DIAGNOSIS_INCONCLUSIVE_ENTRY_CLASS
t19_value LOST_CLASS JSONL_TRANSCRIPT_LOST_ENTRY_CLASS
t19_value LAST_APPLIED_SUFFIX LAST_APPLIED_FILE_SUFFIX

# The lost-transcript diagnosis's log line head (src/session-manager.ts
# diagnoseJsonlMissing and reportInconclusiveDiagnosis, which have no
# exported builder): `[slack] ErrJsonlMissing diagnostic: <ref> instance=<id>`.
DIAGNOSIS_HEAD='[slack] ErrJsonlMissing diagnostic: '

# ---------------------------------------------------------------------------
# Bounds (seconds)
# ---------------------------------------------------------------------------

# A live start's start pass completing.
START_WAIT_S=120
# A launched persona's row reporting in (`waiting`).
ROW_WAIT_S=120
# The Slack stub writing its ready file.
STUB_WAIT_S=30
# A row reading `ended`, and its session gone, after the exit sentinel.
ENDED_WAIT_S=30
# The harness check's transcript appearing after the typed line, and its
# stub's report-in banner.
TRANSCRIPT_WAIT_S=15
# The background `get`'s pause between reads.
POLL_PERIOD_S=0.05

# ---------------------------------------------------------------------------
# Personas: each with its own key, credentials, channel and directories
# ---------------------------------------------------------------------------

CREDS_DIR="${SCENARIO_ROOT}/credentials"
CFG_ROOT="${SCENARIO_ROOT}/claude-config"
mkdir -m 700 "${CREDS_DIR}"
mkdir -p "${CFG_ROOT}"

# t19_persona <prefix> <short> <channel>: set <prefix>_NAME, _LABEL,
# _CHANNEL, _WORK, _CFG, _KEY, _ID and _SESSION for one persona, write its
# credentials file and its Claude config's `.claude.json`, and select
# `dev-channels` for its working directory.
t19_persona() {
    local p="$1" short="$2" channel="$3" key value work cfg
    printf -v "${p}_NAME" '%s' "${SCENARIO_TAG}${short}"
    printf -v "${p}_LABEL" '%s' "${SCENARIO_TAG}${short}1"
    printf -v "${p}_CHANNEL" '%s' "${channel}"
    work="$(make_workdir "${SCENARIO_TAG}${short}_work")"
    printf -v "${p}_WORK" '%s' "${work}"
    cfg="${CFG_ROOT}/${SCENARIO_TAG}${short}_cfg"
    printf -v "${p}_CFG" '%s' "${cfg}"
    mkdir -p "${cfg}"
    printf '{}\n' | write_file "${cfg}/.claude.json" 600
    key="$(persona_key "${SCENARIO_TAG}${short}")"
    printf -v "${p}_KEY" '%s' "${key}"
    t19_value value personaInstanceId "${key}"
    printf -v "${p}_ID" '%s' "${value}"
    t19_value value personaTmuxSessionName "${key}"
    printf -v "${p}_SESSION" '%s' "${value}"
    stub_mode "${work}" "${STUB_MODE_DEV_CHANNELS}"
    printf '{"bot_token": "%s", "app_token": "%s"}\n' \
        "$(fake_token bot "${SCENARIO_TAG}${short}1")" "$(fake_token app "${SCENARIO_TAG}${short}1")" \
        | write_file "${CREDS_DIR}/${SCENARIO_TAG}${short}1.json" 600
}

t19_persona E reusee C0T19RSE1
t19_persona F reusef C0T19RSF1
ALL_PERSONAS=(E F)

# t19_persona_json <prefix>: one persona entry: its credentials file, working
# directory, claude_config_dir and one channel, which also takes its
# permission prompts (its destination).
t19_persona_json() {
    local n="$1_NAME" l="$1_LABEL" w="$1_WORK" c="$1_CFG" ch="$1_CHANNEL"
    printf '{"name": "%s", "credentials_file": "%s", "working_directory": "%s", "claude_config_dir": "%s", "channels": [{"id": "%s", "delivery": "all"}], "permission_prompts": "%s"}' \
        "${!n}" "${CREDS_DIR}/${!l}.json" "${!w}" "${!c}" "${!ch}" "${!ch}"
}

T19_RECORD_ASIDE=0

# t19_config_for_next_start <resume-enabled> <prefix>...: the operator's edit
# while the server is stopped: config.json holds these personas
# (`health_check_interval` 0, `session_restart_delay` 0, `resume_enabled` as
# given), and the last-applied record is moved aside, so the next start
# applies config.json as it stands.
t19_config_for_next_start() {
    local resume="$1" joined="" p record
    shift
    for p in "$@"; do
        joined+="${joined:+, }$(t19_persona_json "${p}")"
    done
    write_config << EOF
{
  "personas": [${joined}],
  "bind": "127.0.0.1",
  "port": ${SCENARIO_PORT},
  "health_check_interval": 0,
  "session_restart_delay": 0,
  "resume_enabled": ${resume}
}
EOF
    record="${SLACK_STATE_DIR}/config.json${LAST_APPLIED_SUFFIX}"
    if [[ -e "${record}" ]]; then
        T19_RECORD_ASIDE=$(( T19_RECORD_ASIDE + 1 ))
        mv -- "${record}" "${record}.aside-${T19_RECORD_ASIDE}" || fail "could not move ${record} aside"
    fi
}

# ---------------------------------------------------------------------------
# The Slack stub (one for the script)
# ---------------------------------------------------------------------------

STUB_DIR="${SCENARIO_ROOT}/slack-stub"
STUB_RECORD="${STUB_DIR}/record.jsonl"
mkdir "${STUB_DIR}"
t19_labels=()
for t19_p in "${ALL_PERSONAS[@]}"; do
    t19_label_var="${t19_p}_LABEL"
    t19_labels+=("${!t19_label_var}")
done
python3 - "${t19_labels[@]}" << 'EOF' | write_file "${STUB_DIR}/control.json"
import json, sys
print(json.dumps({
    "tokens": [{"suffix": s, "label": s, "auth": "ok", "connections": "ok"} for s in sys.argv[1:]],
    "default": {"auth": "invalid_auth", "connections": "invalid_auth"},
}))
EOF
(cd "${STUB_DIR}" && exec bun "${SCENARIO_FIXTURES}/slack-stub-server.ts" --record "${STUB_RECORD}" \
    --control "${STUB_DIR}/control.json" --ready-file "${STUB_DIR}/ready.json") > "${STUB_DIR}/stub.out" 2>&1 &
SLACK_STUB_PID=$!
track_pid "${SLACK_STUB_PID}"
wait_for_file "${STUB_DIR}/ready.json" "${STUB_WAIT_S}" "setup: the Slack stub never wrote its ready file"
CSCB_SLACK_API_URL="$(jq -r '.api_url' "${STUB_DIR}/ready.json")"
[[ "${CSCB_SLACK_API_URL}" =~ ^http://127\.0\.0\.1:[0-9]+/api/$ ]] \
    || fail "setup: the Slack stub's api_url '${CSCB_SLACK_API_URL}' is not loopback"
export CSCB_SLACK_API_URL

# ---------------------------------------------------------------------------
# Reading the rows, the logs and CSCB's calls
# ---------------------------------------------------------------------------

# t19_row_state <id>: print the row's state (a harness `status`), or nothing
# when the read fails.
t19_row_state() {
    ad_capture status --claude-instance-id "$1"
    [[ "${AD_RC}" == 0 ]] || return 0
    jq -r '.state // empty' "${AD_OUT}" 2> /dev/null || true
}

t19_row_is() {
    [[ "$(t19_row_state "$1")" == "$2" ]]
}

# t19_row_get <id> <step>: a harness `get` of the row (AD_OUT holds it); fail
# when it fails.
t19_row_get() {
    ad_capture get --claude-instance-id "$1"
    [[ "${AD_RC}" == 0 ]] || fail "$2: harness get of $1 exited ${AD_RC}: $(tr '\n' ' ' < "${AD_ERR}")"
}

# t19_lines <file>: how many lines <file> has (0 when missing).
t19_lines() {
    if [[ -f "$1" ]]; then
        wc -l < "$1" | tr -d ' '
    else
        echo 0
    fi
}

# t19_after <file> <line>: <file>'s lines after line <line>.
t19_after() {
    [[ -f "$1" ]] || return 0
    tail -n "+$(( $2 + 1 ))" "$1"
}

# t19_count_after <file> <line> <matcher>: lines after <line> that match.
t19_count_after() {
    local tmp="${SCENARIO_ROOT}/count-after.tmp"
    t19_after "$1" "$2" > "${tmp}"
    count_in "${tmp}" "$3"
}

# t19_log_after <matcher>: server.log's lines after the mark that match.
t19_log_after() {
    local tmp="${SCENARIO_ROOT}/log-after.tmp"
    t19_after "${SLACK_STATE_DIR}/server.log" "${MARK_LOG}" > "${tmp}"
    LC_ALL=C awk -v sep="${SCENARIO_SEP}" -v m="$1" '
        BEGIN { n = split(m, frags, sep) }
        {
            rest = $0
            for (i = 1; i <= n; i++) {
                if (frags[i] == "") continue
                p = index(rest, frags[i])
                if (p == 0) next
                rest = substr(rest, p + length(frags[i]))
            }
            print
        }' "${tmp}"
}

# t19_line_time <line>: the time a server.log line carries (its leading
# `[<ISO>] `, src/logging.ts), in seconds since the epoch.
t19_line_time() {
    local iso="${1#\[}"
    iso="${iso%%\]*}"
    date -u -d "${iso}" +%s.%3N || fail "could not read the time '${iso}'"
}

# t19_mark: the leg's mark: the time, and the lines server.log and
# startup-errors.log hold.
t19_mark() {
    MARK_TIME="${EPOCHREALTIME/,/.}"
    MARK_LOG="$(t19_lines "${SLACK_STATE_DIR}/server.log")"
    MARK_ERRORS="$(t19_lines "${SLACK_STATE_DIR}/startup-errors.log")"
}

# t19_cscb_calls_since <time> <verb> [<fragment>...]: CSCB's agent-director
# calls of <verb> holding every fragment, made at or after <time>.
t19_cscb_calls_since() {
    local since="$1" out
    shift
    out="$(cscb_ad_calls "$@")" || exit 1
    [[ -n "${out}" ]] || return 0
    awk -F'\t' -v t="${since}" '$2 + 0 >= t + 0' <<< "${out}"
}

# t19_cscb_count_since <time> <verb> [<fragment>...]
t19_cscb_count_since() {
    local out
    out="$(t19_cscb_calls_since "$@")" || exit 1
    if [[ -z "${out}" ]]; then
        echo 0
    else
        wc -l <<< "${out}" | tr -d ' '
    fi
}

# t19_reuse_spawns_since <time> <id>: CSCB's `spawn` calls naming <id> with
# `--reuse-finished` at or after <time>.
t19_reuse_spawns_since() {
    local out
    out="$(t19_cscb_calls_since "$1" spawn "$2")" || exit 1
    [[ -n "${out}" ]] || return 0
    grep -F -- '--reuse-finished' <<< "${out}" || true
}

# t19_note_calls <time> <id> <step>: log how many CSCB calls of each verb
# named <id> at or after <time>.
t19_note_calls() {
    local out summary
    out="$(t19_cscb_calls_since "$1" "" "$2")" || exit 1
    summary="$(awk -F'\t' '
        {
            n = split($6, w, " ")
            for (i = 1; i <= n; i++) {
                if (w[i] == "--store-path" || w[i] == "--home" || w[i] == "--tmux-command") { i++; continue }
                c[w[i]]++
                break
            }
        }
        END { for (v in c) printf "%s=%d\n", v, c[v] }' <<< "${out}" | sort | tr '\n' ' ')"
    echo "${TEST_NAME}: NOTE: ${3}: CSCB calls naming $2 after the mark: ${summary:-none}"
}

# t19_start_and_wait <persona-count>: a live start, and its start pass
# completing (its own completion line: server.log is appended across starts).
t19_start_and_wait() {
    local m before
    m="$(completion_match "$1")" || exit 1
    before="$(count_log "${m}")"
    start_server --live
    wait_for_count "${m}" "$(( before + 1 ))" "${START_WAIT_S}" "the start pass never completed"
}

# t19_has_session <session>: true when the scenario's tmux server holds it.
t19_has_session() {
    "${SCENARIO_REAL_TMUX}" has-session -t "=$1" 2> /dev/null
}

t19_no_session() {
    ! t19_has_session "$1"
}

# t19_end_life <prefix> <step>: the human ends the persona's live life by
# typing the stub's exit sentinel into its pane; the row reads `ended` and the
# session is gone.
t19_end_life() {
    local p="$1" step="$2" id_var="$1_ID" session_var="$1_SESSION"
    stub_type_line "${!session_var}" "${STUB_EXIT_SENTINEL}"
    wait_until "${ENDED_WAIT_S}" "${step}: ${!id_var} does not read ended after the exit sentinel" t19_row_is "${!id_var}" ended
    wait_until "${ENDED_WAIT_S}" "${step}: ${!session_var} is still there after the exit sentinel" t19_no_session "${!session_var}"
}

# ---------------------------------------------------------------------------
# The background harness `get` (the pending window)
# ---------------------------------------------------------------------------

# t19_poller_start <id> <file>: from now on, a subshell of the scenario's own
# shell (`track_pid`) reads the row with the harness `get`, every
# POLL_PERIOD_S, and appends one JSON line per answered read to <file>:
# {t, state, launch_started_at, claude_session_id}.
t19_poller_start() {
    local id="$1" file="$2"
    : > "${file}"
    (
        set +e
        tmp="${file}.read"
        while :; do
            if ad get --claude-instance-id "${id}" > "${tmp}" 2> /dev/null; then
                jq -c --arg t "${EPOCHREALTIME/,/.}" \
                    '{t: $t, state: .state, launch_started_at: (.launch_started_at // ""), claude_session_id: (.claude_session_id // "")}' \
                    "${tmp}" >> "${file}" 2> /dev/null
            fi
            sleep "${POLL_PERIOD_S}"
        done
    ) &
    T19_POLLER_PID=$!
    track_pid "${T19_POLLER_PID}"
}

# t19_poll_has_waiting <file>: true when a read in <file> is `waiting`.
t19_poll_has_waiting() {
    jq -e -s 'any(.[]; .state == "waiting")' "$1" > /dev/null 2>&1
}

# t19_check_pending_then_waiting <file> <id> <step>: the reads hold one of
# `pending` with a launch start, then one of `waiting`, and no `waiting`
# before that `pending`.
t19_check_pending_then_waiting() {
    local file="$1" id="$2" step="$3" verdict launches
    verdict="$(jq -r -s '
        (map(.state == "pending" and .launch_started_at != "") | index(true)) as $p
        | if $p == null then "no-pending"
          else ((.[$p:] | map(.state == "waiting") | index(true)) as $w
                | if $w == null then "no-waiting-after"
                  elif (.[:$p] | any(.state == "waiting")) then "waiting-before"
                  else "ok \(.[$p].t) \(.[$p].launch_started_at) \(.[$p + $w].t)" end)
          end' "${file}")" || fail "${step}: could not read the background get's reads of ${id}"
    case "${verdict}" in
        ok\ *)
            read -r _ T19_PENDING_T T19_LAUNCH_START T19_WAITING_T <<< "${verdict}"
            echo "${TEST_NAME}: ${step}: the harness get read ${id} pending at ${T19_PENDING_T} (launch start ${T19_LAUNCH_START}), then waiting at ${T19_WAITING_T}"
            ;;
        *)
            jq -c . "${file}" | sed 's/^/  | /' >&2 || true
            case "${verdict}" in
                no-pending) fail "${step}: the harness get never read ${id} pending with a launch start ($(t19_lines "${file}") reads, ${POLL_PERIOD_S} s apart): the pending window was too short to read" ;;
                no-waiting-after) fail "${step}: the harness get read ${id} pending with a launch start but never waiting after it" ;;
                waiting-before) fail "${step}: the harness get read ${id} waiting before the pending launch" ;;
                *) fail "${step}: the background get's reads of ${id} gave '${verdict}'" ;;
            esac
            ;;
    esac
    launches="$(jq -r -s '[.[] | select(.state == "pending") | .launch_started_at] | "\(length) read(s), launch start(s): \(unique | join(" "))"' "${file}")"
    echo "${TEST_NAME}: NOTE: ${step}: the pending reads of ${id}: ${launches}"
}

# ---------------------------------------------------------------------------
# Harness check: the transcript-on-first-message mode and stub_type_line
# (harness additions, confirm at the reconcile pass)
# ---------------------------------------------------------------------------

# t19_transcripts: how many transcript files the scenario HOME's Claude
# project directories hold.
t19_transcripts() {
    if [[ -d "${HOME}/.claude/projects" ]]; then
        find "${HOME}/.claude/projects" -type f -name '*.jsonl' | wc -l | tr -d ' '
    else
        echo 0
    fi
}

t19_transcripts_are() {
    [[ "$(t19_transcripts)" == "$1" ]]
}

# t19_pane_shows <pane> <text>: true when the pane's visible text holds <text>
# (the harness reading its own stub's pane).
t19_pane_shows() {
    "${SCENARIO_REAL_TMUX}" capture-pane -p -t "$1" 2> /dev/null | grep -qF -- "$2"
}

t19_harness_check() {
    local step="harness check" dir pane before out
    dir="$(make_workdir "${SCENARIO_TAG}selfcheck_work")"
    stub_mode "${dir}" "${STUB_MODE_TRANSCRIPT_ON_FIRST_MESSAGE}"
    before="$(t19_transcripts)"
    seed_unlabelled -c "${dir}" "${SCENARIO_TAG}_selfcheck" "${SCENARIO_BIN}/claude" > /dev/null
    pane="${SEEDED_PANE_ID}"
    # The stub's own texts (fixtures/stub-claude.sh): its dialog's first line,
    # and the banner it prints on reporting in.
    wait_until "${TRANSCRIPT_WAIT_S}" "${step}: the stub never showed its dialog" t19_pane_shows "${pane}" 'WARNING: Loading development channels'
    [[ "$(t19_transcripts)" == "${before}" ]] || fail "${step}: a transcript was written at the dialog"
    stub_press_enter "${pane}"
    wait_until "${TRANSCRIPT_WAIT_S}" "${step}: the stub never reported in after Enter" t19_pane_shows "${pane}" 'Listening for channel messages from:'
    [[ "$(t19_transcripts)" == "${before}" ]] || fail "${step}: a transcript was written at report-in"
    stub_type_line "${pane}" "a first message"
    wait_until "${TRANSCRIPT_WAIT_S}" "${step}: no transcript after a typed line" t19_transcripts_are "$(( before + 1 ))"
    stub_type_line "${pane}" "${STUB_EXIT_SENTINEL}"
    wait_until "${TRANSCRIPT_WAIT_S}" "${step}: the stub's session is still there after the typed sentinel" t19_no_session "${SCENARIO_TAG}_selfcheck"
    # A refusal through `fail`: a pane that does not exist.
    out="${SCENARIO_ROOT}/type-line-refused.out"
    if (stub_type_line '%999999' "a line") > "${out}" 2>&1; then
        fail "${step}: stub_type_line did not fail for a pane that does not exist"
    fi
    grep -q "^FAIL: ${TEST_NAME}: stub_type_line %999999: tmux send-keys of the line exited" "${out}" \
        || { sed 's/^/  | /' "${out}" >&2; fail "${step}: stub_type_line's refusal of a pane that does not exist is not its FAIL line"; }
    echo "${TEST_NAME}: ${step}: transcript-on-first-message wrote no transcript until a line was typed, and stub_type_line typed it"
}

# ---------------------------------------------------------------------------
# The legs (b.jg5 SRJ-1409)
# ---------------------------------------------------------------------------

# t19_leg <prefix> <step> <resume-enabled> <disabled|missing>
t19_leg() {
    local p="$1" step="$2" resume="$3" kind="$4"
    local id_var="$1_ID" name_var="$1_NAME" work_var="$1_WORK" session_var="$1_SESSION"
    local id="${!id_var}" name="${!name_var}" old_sid jsonl real_root real_jsonl poll n reuse reuse_t
    local ref m diag diag_t line rc

    # 1. The first life.
    t19_config_for_next_start "${resume}" "${p}"
    t19_start_and_wait 1
    wait_until "${ROW_WAIT_S}" "${step}: ${id}'s first life never reported in (waiting)" t19_row_is "${id}" waiting
    t19_row_get "${id}" "${step}: the first life"
    old_sid="$(jq -r '.claude_session_id // empty' "${AD_OUT}")"
    [[ -n "${old_sid}" ]] || fail "${step}: ${id}'s first life has no claude_session_id"
    jsonl="$(jq -r '.jsonl_path // empty' "${AD_OUT}")"
    echo "${TEST_NAME}: ${step}: ${id}'s first life: session ${old_sid}, transcript ${jsonl:-none}"

    # 2. The human ends it; leg F also deletes its transcript.
    t19_end_life "${p}" "${step}: the first life"
    if [[ "${kind}" == missing ]]; then
        [[ -n "${jsonl}" ]] || fail "${step}: ${id}'s first life recorded no jsonl_path"
        [[ -f "${jsonl}" ]] || fail "${step}: ${id}'s transcript ${jsonl} is not a file"
        real_root="$(realpath -e -- "${SCENARIO_ROOT}")" || fail "${step}: cannot resolve SCENARIO_ROOT"
        real_jsonl="$(realpath -e -- "${jsonl}")" || fail "${step}: cannot resolve ${jsonl}"
        [[ "${real_jsonl}" == "${real_root}"/* ]] \
            || fail "${step}: refused: the transcript ${real_jsonl} is not under SCENARIO_ROOT ${real_root}"
        rm -f -- "${real_jsonl}"
        [[ ! -e "${real_jsonl}" ]] || fail "${step}: ${real_jsonl} is still there after its removal"
        echo "${TEST_NAME}: ${step}: the harness deleted ${id}'s transcript ${real_jsonl}"
    fi

    # 3. The new life's mode, a plain stop, the mark and a start, with the
    #    background get reading from before it.
    stub_mode "${!work_var}" "${STUB_MODE_TRANSCRIPT_ON_FIRST_MESSAGE}"
    stop_server
    t19_mark
    poll="${SCENARIO_ROOT}/poll-${p}.jsonl"
    t19_poller_start "${id}" "${poll}"
    t19_start_and_wait 1
    wait_until "${ROW_WAIT_S}" "${step}: ${id}'s new life never reported in (waiting)" t19_row_is "${id}" waiting
    wait_until 10 "${step}: the background get never read ${id} waiting" t19_poll_has_waiting "${poll}"
    stop_tracked_pid "${T19_POLLER_PID}" 10 "${step}: stop the background get"

    # 4. pending with a launch start, then waiting.
    t19_check_pending_then_waiting "${poll}" "${id}" "${step}"

    # 5. The reuse spawn, the resume (or none), the diagnosis.
    reuse="$(t19_reuse_spawns_since "${MARK_TIME}" "${id}")" || exit 1
    n="$(grep -c . <<< "${reuse}" || true)"
    [[ "${n}" == 1 ]] || fail "${step}: ${n} CSCB-parented spawn(s) of ${id} carrying --reuse-finished after the mark, not 1"
    reuse_t="$(awk -F'\t' '{ print $2 }' <<< "${reuse}")"
    echo "${TEST_NAME}: ${step}: CSCB's reuse spawn of ${id} at ${reuse_t}"
    n="$(t19_cscb_count_since "${MARK_TIME}" resume "${id}")"
    ref="$(persona_ref "${name}")" || exit 1
    if [[ "${kind}" == disabled ]]; then
        [[ "${n}" == 0 ]] || fail "${step}: ${n} CSCB resume call(s) of ${id} after the mark with resume_enabled false"
    else
        (( n >= 1 )) || fail "${step}: no CSCB resume of ${id} after the mark (its ErrJsonlMissing comes from one)"
        m="$(matcher "${DIAGNOSIS_HEAD}${ref} instance=${id}" "${REUSE_WORDING}")"
        diag="$(t19_log_after "${m}")"
        n="$(grep -c . <<< "${diag}" || true)"
        if [[ "${n}" != 1 ]]; then
            t19_after "${SLACK_STATE_DIR}/server.log" "${MARK_LOG}" | sed 's/^/  | /' >&2
            fail "${step}: ${n} lost-transcript diagnosis line(s) for ${id} after the mark, not 1 ($(matcher_text "${m}"))"
        fi
        diag_t="$(t19_line_time "${diag}")"
        awk -v a="${diag_t}" -v b="${reuse_t}" 'BEGIN { exit !(a + 0 <= b + 0) }' \
            || fail "${step}: the lost-transcript diagnosis for ${id} (${diag_t}) is logged after the reuse spawn's call (${reuse_t})"
        echo "${TEST_NAME}: ${step}: the lost-transcript diagnosis for ${id} at ${diag_t}, before the reuse spawn"
        echo "${TEST_NAME}: NOTE: ${step}: the diagnosis's startup-errors entries after the mark: ${INCONCLUSIVE_CLASS}=$(t19_count_after "${SLACK_STATE_DIR}/startup-errors.log" "${MARK_ERRORS}" "] [${INCONCLUSIVE_CLASS}] ") ${LOST_CLASS}=$(t19_count_after "${SLACK_STATE_DIR}/startup-errors.log" "${MARK_ERRORS}" "] [${LOST_CLASS}] ")"
    fi

    # prior_sessions does not list the first life's session.
    t19_row_get "${id}" "${step}: the new life"
    jq -e '(.prior_sessions | type) == "array"' "${AD_OUT}" > /dev/null 2>&1 \
        || { sed 's/^/  | /' "${AD_OUT}" >&2; fail "${step}: the harness get of ${id} carries no prior_sessions array"; }
    if jq -e --arg sid "${old_sid}" '.prior_sessions | tostring | contains($sid)' "${AD_OUT}" > /dev/null 2>&1; then
        sed 's/^/  | /' "${AD_OUT}" >&2
        fail "${step}: the harness get of ${id}'s new life lists the first life's session ${old_sid} in prior_sessions"
    fi
    echo "${TEST_NAME}: NOTE: ${step}: ${id}'s new life: session '$(jq -r '.claude_session_id // ""' "${AD_OUT}")', transcript_status '$(jq -r '.transcript_status // ""' "${AD_OUT}")', prior_sessions $(jq -c '.prior_sessions' "${AD_OUT}")"

    # The pre_trust line: ok, for the reuse spawn.
    t19_value line preTrustLogLine "${name}" LAUNCH_VERB_REUSE_SPAWN ok
    n="$(t19_count_after "${SLACK_STATE_DIR}/server.log" "${MARK_LOG}" "] ${line}")"
    if [[ "${n}" != 1 ]]; then
        t19_after "${SLACK_STATE_DIR}/server.log" "${MARK_LOG}" | grep -F -- 'pre_trust' | sed 's/^/  | /' >&2 || true
        echo "  | expected: ${line}" >&2
        fail "${step}: ${n} server.log line(s) of ${id}'s reuse spawn pre_trust ok after the mark, not 1"
    fi

    # No CSCB delete; the row present.
    n="$(t19_cscb_count_since "${MARK_TIME}" delete)"
    [[ "${n}" == 0 ]] || fail "${step}: ${n} CSCB delete call(s) after the mark"
    t19_note_calls "${MARK_TIME}" "${id}" "${step}"

    # 6. The harness's resume of the unmessaged new life, with the server
    #    stopped and the life ended.
    stop_server
    t19_end_life "${p}" "${step}: the new life"
    ad_capture resume --claude-instance-id "${id}"
    rc="${AD_RC}"
    if [[ "${rc}" == 0 ]] || ! jq -e -s --arg n "${NEVER_WRITTEN}" 'any(.[]; type == "object" and .err_name == $n)' "${AD_OUT}" "${AD_ERR}" > /dev/null 2>&1; then
        sed 's/^/  | /' "${AD_OUT}" "${AD_ERR}" >&2
        fail "${step}: the harness resume of ${id}'s unmessaged new life exited ${rc}, not answering ${NEVER_WRITTEN}"
    fi
    echo "${TEST_NAME}: ${step}: the harness resume of ${id} answered ${NEVER_WRITTEN}"
    t19_row_get "${id}" "${step}: after the harness resume"
    echo "${TEST_NAME}: ${step}: ${id}'s row is kept, reading $(jq -r '.state' "${AD_OUT}")"
    if t19_has_session "${!session_var}"; then
        fail "${step}: ${!session_var} is there after the refused resume"
    fi
}

t19_harness_check
# S3: resume_enabled=false (SRJ-707's `resumeOrFreshSpawn` site).
t19_leg E "resume_enabled=false" false disabled
# S4: a missing transcript (SRJ-707, SRJ-712).
t19_leg F "missing transcript" true missing

# The closing assertions (b.jg5 SRJ-1401, SRJ-1418).
assert_no_server_tmux
assert_no_cscb_include_finished
assert_no_cscb_delete

echo "${TEST_NAME}: PASS"
