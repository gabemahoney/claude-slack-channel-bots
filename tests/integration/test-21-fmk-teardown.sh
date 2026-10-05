#!/usr/bin/env bash
# Test 21 (HO §7 scenario 9; b.jg5 SRJ-1411; AC 4, AC 73, AC 75): teardowns
# that meet a conflict. One persona in CONFLICT fails the precheck of
# `clean_restart` and of `stop --stop-bots`, which stop nothing; after a
# passing precheck a teardown whose kills fail restarts the server under
# `clean_restart` and leaves it stopped under `stop --stop-bots`; with
# agent-director not answering `list` at the fallback, `clean_restart` starts
# nothing and gives one not-restarted alert, printed, logged and recorded; and
# a `pending` persona's teardown escalates to a kill, after which the next
# server never kills that row and brings the persona up once CSCB's own
# `find-missing` run marks the row `missing` (b.jg5 SRJ-901, SRJ-903 to
# SRJ-907, SRJ-909, SRJ-702, SRJ-704, SRJ-1007, SRJ-1013, SRJ-410, SRJ-713,
# SRJ-1306, SRJ-1401, SRJ-1418).
#
# fmk setup (lib/scenario.sh fmk mode; b.jg5 SRJ-1306, SRJ-1401):
# - its own HOME, agent-director store and tmux server, all under
#   SCENARIO_ROOT, with the agent-director shim in front of the binary and the
#   tmux shim first on the PATH of every CSCB process (the bot server, `start`
#   and `stop` runs, and the CLI commands this script runs through `cscb_run`,
#   `t21_cli`), which agent-director inherits;
# - the release start (SCENARIO_AD_START unset: the 0.11.0 release, installed
#   by its install.sh at sourcing), at agent-director's default settings (no
#   config.toml): `[pause] timeout_seconds` 30, so a `pause` whose `/exit` the
#   stub ignores ends in ErrPauseTimeout and escalates to the kill (SRJ-903);
#   kill_exit_wait_ms 5000; the pending grace period G printed from
#   `adGraceMs` of the defaults;
# - CSCB's configuration: `health_check_interval` 0, so no health tick
#   reconnects or relaunches a persona, and `session_restart_delay` 0, so a
#   closed MCP session schedules no restart (SRJ-1401: CSCB's timings are
#   changed only through its configuration); `exit_timeout` 5;
# - every start is live (`start_server --live`), against the loopback Slack
#   stub (fixtures/slack-stub-server.ts, one for the script, every persona's
#   token pair answered ok); the CLI commands run with SLACK_DRY_RUN unset, so
#   the server `clean_restart` starts is live too;
# - each leg has its own personas (key, credentials, channel, directories):
#   A and B (precheck legs), C and E (teardown-failure legs), F and G
#   (not-restarted leg), D (pending-persona leg). Between legs the harness
#   plays the operator while the server is stopped: config.json is rewritten
#   to the next leg's personas and the last-applied record moved aside, so the
#   next start applies config.json as it stands (README "Reload"); that
#   start's sweep kills the earlier leg's live rows (absent personas), in
#   `log`, so no earlier persona's teardown enters a later leg's lines;
# - stub workers: `dev-channels` (the reporting stub: the approver's Enter
#   makes it report in) for A, B, C, E, F and G; D runs `unrecognised-dialog`
#   (CSCB's approver never answers it, so D's row stays `pending` at that
#   dialog), then `dev-channels` for its recovery. The stub ignores `pause`'s
#   `/exit` (its exit sentinel is `__CSCB_TEST_EXIT__`);
# - checks read only their own leg's ids and window: server.log,
#   startup-errors.log and clean_restart.log from the leg's mark line,
#   CSCB's agent-director calls (`cscb_ad_calls`: only the agent-director
#   shim's lines whose parent is a CSCB process) from the mark's time, and a
#   command's own calls (CLI-parented) by its run's PID; rows by a harness
#   `get`; agent-director's trail ($HOME/.agent-director/ad-trail.jsonl) for
#   its `find-missing` marks and its launch records.
#
# How the conflict is injected (S3): the harness respawns A's worker pane
# with another process (`respawn_worker_pane`, a `sleep`), from the
# scenario's own shell. The pane keeps its id but runs a new process, so the
# release's one-line `read-pane` of A's row finds its session (Ours) and no
# pane with the row's recorded pane id and pid: ErrTmuxSessionConflict, "the
# agent's pane was not found", while A's row stays live. It touches no other
# persona. (agent-director's answer `ad-answer-held-clean-restart.md`, which
# stages CONFLICT by changing the row's `launch_token`, was not needed: a
# changed launch token makes the lookup Leftover, whose lone leftover's pane
# `read-pane` reads, so the precheck would pass; the respawn is what the
# precheck's `read-pane` answers CONFLICT for.)
#
# How the teardown failure is injected (S4, S5): the tmux shim in
# `fail-kill`, unlimited (every kill-session and kill-pane a CSCB-run
# agent-director makes fails), set just before the command. The stub
# ignores `/exit`, so each persona's `pause` ends in ErrPauseTimeout after
# 30 s and escalates to the kill, whose KILL_RETRY_TRIES tries, 2 s apart,
# each answer ErrTmuxKillFailed (UNAVAILABLE), so the persona's teardown
# fails with the kill-failure alert's ordinary version (SRJ-702, SRJ-1007).
# How agent-director stops answering at the fallback (S5): the list-refusing
# stand-in (fixtures/agent-director-list-refusing.sh, a harness addition,
# confirm at the reconcile pass) swapped in behind the shim
# (`swap_ad_binary`, shim check after the swap and after the restore): it
# refuses `list` and runs the release for every other verb.
#
# Legs, in run order (one scenario HOME, store, tmux server and Slack stub):
#   S3 precheck legs: A and B up, rows `waiting`; A's pane respawned; the
#      script runs `clean_restart`, then `stop --stop-bots`. Each exits
#      non-zero and prints the precheck failure line naming A, its key,
#      `slack_bot_<key>` and CONFLICT (the description matched through
#      CONFLICT_PANE_NOT_FOUND_PHRASE), no line for B, then its "nothing was
#      stopped" line, last; A's precheck failure line in neither server.log
#      nor startup-errors.log; the bot server's PID unchanged and running after
#      each; at least one CLI-parented `read-pane` of A's id (the command's
#      calls found) and no CLI-parented `pause` or `kill`; A's and B's rows
#      unchanged (a
#      harness `get` before and after). Then the harness ends A's session by
#      its session id (`end_session`); a harness `read-pane` of A then
#      answers GONE (ErrTmuxCaptureFailed), which the precheck passes.
#   S4 teardown-failure legs: a plain stop; C and E configured and started,
#      rows `waiting`. `fail-kill`, then `clean_restart`: it exits non-zero;
#      for each of C and E, every kill try answered ErrTmuxKillFailed (read
#      from its per-try lines), exactly KILL_RETRY_TRIES CLI-parented kills,
#      the failure line printed once in the command's output (standard
#      output and error together) and followed there by the ordinary alert
#      for the CLI-teardown route, both appended once to server.log (and,
#      under `clean_restart`, to clean_restart.log), and one `persona-kill-failed` entry holding both (context
#      `clean_restart`); two such entries in all; the last line counting 2;
#      the bot server running afterwards with a new PID. Then, still
#      `fail-kill`, `stop --stop-bots`: the same lines and entries (context
#      `stop --stop-bots`), exit non-zero, the server's PID gone, no
#      server.pid and no bot server recorded after the command's mark (no
#      start). No CSCB `delete`; C's and E's rows present and their sessions
#      still there.
#   S5 not-restarted leg: `log`; F and G configured and started (the
#      start sweep kills C's and E's rows), rows `waiting`. The stand-in
#      swapped in (a harness `list` refused with no result; a harness
#      `version` and `get` answered); `fail-kill`; `clean_restart`. Its
#      precheck passes (no precheck line; its `get` and `read-pane` reach the
#      release through the stand-in, as the teardown's `status`, `pause` and
#      `kill` do) and its teardown fails (F's and G's UNAVAILABLE failure
#      lines); exactly 3
#      CLI-parented `list` calls carrying the `service` label, each refused
#      (answer-check lines for tries 1 to 3 in clean_restart.log); no bot
#      server running and none recorded after the mark; exactly one
#      not-restarted alert naming F and G with their sessions and class
#      UNAVAILABLE, as the printer renders it, printed once in the command's
#      output (standard output and error together), appended once to
#      clean_restart.log and once to server.log and recorded as one
#      `clean-restart-not-restarted` entry; the last line counting 2; exit
#      non-zero; no CSCB `delete`. Then the release restored behind the shim
#      and `log`.
#   S6 pending-persona leg (working default: the teardown is
#      `stop --stop-bots`, the SRD names none): D configured with
#      `unrecognised-dialog` and started (the start sweep kills F's and G's
#      rows), D's row `pending` with a launch start. `stop --stop-bots` well
#      before G (the pending grace period; the script fails, saying so,
#      when G or more has passed since D's launch start before it runs the
#      command): its precheck passes on D's `pending` row (the release's
#      `read-pane` has no state guard, SRJ-901), D's CLI-parented `pause`
#      answers ErrSpawnNotPausable (its escalation line in the CLI's output),
#      the one CLI-parented `kill` that follows succeeds, the command exits 0,
#      the server is gone and D's session is gone. D's directory switched to
#      `dev-channels`; a start. Waited until D's row reads `waiting`, bounded
#      at D_RECOVER_WAIT_S (below). Then: no CSCB `kill` naming D after the
#      restart's mark; no harness `find-missing` in the whole run (SRJ-1401:
#      D is unlatched, so CSCB's own pending-row runs mark it); exactly one
#      `ad.find_missing.tick` in the trail marking D's row `missing` from
#      `pending` after the mark, made while a CSCB-parented `find-missing`
#      ran (one at or before it, after the mark); exactly one launch record
#      for D after the mark (`ad.spawn.reused` or `ad.resume.moved_to_pending`),
#      after that tick; D's row `waiting`.
#
# Waits: rows reporting in at ROW_WAIT_S; start passes at START_WAIT_S; the
# CLI commands run to their end (their own bounds, SRJ-908: a teardown's
# pause tries, exit_timeout and kill tries, each call bounded by CSCB's call
# timeout). D_RECOVER_WAIT_S, D's recovery: from the restart, D's retry timer
# (armed by the start pass's `pending` branch) retries at
# UNAVAILABLE_RETRY_BASE_S, doubling to UNAVAILABLE_RETRY_CEILING_S; the
# first retry at or past G from D's launch start makes the lap and the
# bypassing `find-missing` that marks the row, then the recovery's launch and
# the approver's Enter; bounded at G + UNAVAILABLE_RETRY_CEILING_S +
# ROW_WAIT_S (at least 300 s, SRJ-1401).
#
# Matched values (every one printed by fixtures/fmk-texts.ts from the
# installed package, never typed here):
#   - the commands as the lines name them (CLI_COMMAND_CLEAN_RESTART,
#     CLI_COMMAND_STOP_BOTS), the class labels (`adErrorClass`), the precheck
#     failure line's head and the "nothing was stopped" line
#     (`precheckFailureLine`, `precheckNothingStoppedLine`), the teardown
#     failure line's head (`teardownFailureLine`), a kill-failed persona's
#     report (`teardownKillOutcomeOf`, `personaTeardownReportOf`: its failure
#     line, its ordinary alert for the CLI-teardown route and its entry's
#     class and message), the last line (`teardownNotStoppedLine`), the
#     not-restarted alert (`cleanRestartNotRestartedAlert`) and its class
#     (CLEAN_RESTART_NOT_RESTARTED_LABEL), the answer check's try line head
#     (`answerCheckFailedTryLine`), src/cli-teardown.ts; the CLI-teardown
#     route's class (PERSONA_KILL_FAILED_LABEL, src/kill-failure-alert.ts);
#     CONFLICT_PANE_NOT_FOUND_PHRASE (src/ad-description-phrases.ts); the
#     error names ErrSpawnNotPausable and ErrTmuxCaptureFailed (`adErrorName`,
#     src/agent-director-errors.ts);
#   - the per-try line's fixed part before its description
#     (`killRetryTryLine.description-head`, src/kill-retry.ts,
#     src/checked-kill.ts) and KILL_RETRY_TRIES; G (`adGraceMs.default`,
#     src/ad-settings.ts) and the retry schedule's ceiling
#     (UNAVAILABLE_RETRY_CEILING_S, src/unavailable-retry.ts); instance ids
#     and session names (`personaInstanceId`, `personaTmuxSessionName`,
#     src/persona-identity.ts), the `service` label (SERVICE_LABEL) and the
#     last-applied record's suffix (LAST_APPLIED_FILE_SUFFIX, src/reload.ts).
#   - Quoted, with no exported builder: the teardown's escalation line
#     `[slack] teardownBots: pause failed for persona <ref> — escalating to
#     kill: ` (src/cli.ts teardownPersona); the startup-errors entry's layout
#     `[<time>] [<class>] <message>` (src/startup-errors.ts
#     recordStartupError).
#
# Outcomes the SRD leaves open are logged as `NOTE:` lines, not asserted:
# each leg's CSCB calls of its ids by verb, D's row state after the kill,
# and the restarted server's PID.
#
# The script ends with the closing assertions, `assert_no_server_tmux`,
# `assert_no_cscb_include_finished` and `assert_no_cscb_delete` (b.jg5
# SRJ-1418), in its own shell; their counts read only the shims' lines whose
# parent is a CSCB process.
set -euo pipefail

TEST_NAME="test-21-fmk-teardown"
# shellcheck source=lib/scenario.sh
source "$(dirname "$0")/lib/scenario.sh"

# ---------------------------------------------------------------------------
# Values from the installed package (fixtures/fmk-texts.ts)
# ---------------------------------------------------------------------------

T21_PRINTER="${SCENARIO_FIXTURES}/fmk-texts.ts"

# t21_value <var> <entry> [<arg>...]: set <var> to the printer's value; fail
# naming the entry when the printer fails.
t21_value() {
    local -n t21_value_out="$1"
    shift
    t21_value_out="$(bun "${T21_PRINTER}" "$@")" || fail "the value printer failed for $*"
}

# t21_whole <var> <entry>: as t21_value, for a whole number.
t21_whole() {
    t21_value "$1" "$2"
    local -n t21_whole_out="$1"
    [[ "${t21_whole_out}" =~ ^[1-9][0-9]*$ ]] || fail "setup: $2 '${t21_whole_out}' is not a whole number"
}

t21_whole KILL_TRIES KILL_RETRY_TRIES
t21_whole GRACE_MS adGraceMs.default
t21_whole RETRY_CEILING_S UNAVAILABLE_RETRY_CEILING_S
t21_value CLASS_CONFLICT adErrorClass AD_ERROR_CLASS_CONFLICT
t21_value CLASS_UNAVAILABLE adErrorClass AD_ERROR_CLASS_UNAVAILABLE
t21_value PANE_NOT_FOUND CONFLICT_PANE_NOT_FOUND_PHRASE
t21_value NOT_PAUSABLE adErrorName ErrSpawnNotPausable
t21_value CAPTURE_FAILED adErrorName ErrTmuxCaptureFailed
t21_value KILL_FAILED_LABEL PERSONA_KILL_FAILED_LABEL
t21_value NOT_RESTARTED_LABEL CLEAN_RESTART_NOT_RESTARTED_LABEL
t21_value SVC_LABEL SERVICE_LABEL
t21_value LAST_APPLIED_SUFFIX LAST_APPLIED_FILE_SUFFIX

# The teardown's escalation line (src/cli.ts teardownPersona, which has no
# exported builder): `[slack] teardownBots: pause failed for persona <ref> —
# escalating to kill: <description>`; its fixed fragments around the ref.
ESCALATION_HEAD='[slack] teardownBots: pause failed for persona '
ESCALATION_MID=' — escalating to kill: '

# ---------------------------------------------------------------------------
# Bounds (seconds)
# ---------------------------------------------------------------------------

# A live start's start pass completing.
START_WAIT_S=120
# A launched persona's row reporting in (`waiting`), or reading `pending`
# with a launch start.
ROW_WAIT_S=120
# The Slack stub writing its ready file.
STUB_WAIT_S=30
# A stopped server's process exiting after its command returned.
SERVER_GONE_S=15
# D's recovery after the restart (see "Waits" in the header).
D_RECOVER_WAIT_S=$(( GRACE_MS / 1000 + RETRY_CEILING_S + ROW_WAIT_S ))
(( D_RECOVER_WAIT_S >= 300 )) || D_RECOVER_WAIT_S=300

# ---------------------------------------------------------------------------
# Personas: each with its own key, credentials, channel and directories
# ---------------------------------------------------------------------------

CREDS_DIR="${SCENARIO_ROOT}/credentials"
CFG_ROOT="${SCENARIO_ROOT}/claude-config"
mkdir -m 700 "${CREDS_DIR}"
mkdir -p "${CFG_ROOT}"

# t21_persona <prefix> <short> <channel>: set <prefix>_NAME, _LABEL,
# _CHANNEL, _WORK, _CFG, _KEY, _ID and _SESSION for one persona, write its
# credentials file and select `dev-channels` for its working directory.
t21_persona() {
    local p="$1" short="$2" channel="$3" key value work
    printf -v "${p}_NAME" '%s' "${SCENARIO_TAG}${short}"
    printf -v "${p}_LABEL" '%s' "${SCENARIO_TAG}${short}1"
    printf -v "${p}_CHANNEL" '%s' "${channel}"
    work="$(make_workdir "${SCENARIO_TAG}${short}_work")"
    printf -v "${p}_WORK" '%s' "${work}"
    printf -v "${p}_CFG" '%s' "${CFG_ROOT}/${SCENARIO_TAG}${short}_cfg"
    mkdir -p "${CFG_ROOT}/${SCENARIO_TAG}${short}_cfg"
    key="$(persona_key "${SCENARIO_TAG}${short}")"
    printf -v "${p}_KEY" '%s' "${key}"
    t21_value value personaInstanceId "${key}"
    printf -v "${p}_ID" '%s' "${value}"
    t21_value value personaTmuxSessionName "${key}"
    printf -v "${p}_SESSION" '%s' "${value}"
    stub_mode "${work}" "${STUB_MODE_DEV_CHANNELS}"
    printf '{"bot_token": "%s", "app_token": "%s"}\n' \
        "$(fake_token bot "${SCENARIO_TAG}${short}1")" "$(fake_token app "${SCENARIO_TAG}${short}1")" \
        | write_file "${CREDS_DIR}/${SCENARIO_TAG}${short}1.json" 600
}

t21_persona A conflicta C0T21PRA1
t21_persona B passesb C0T21PRB1
t21_persona C killc C0T21KLC1
t21_persona E kille C0T21KLE1
t21_persona F fallbackf C0T21FBF1
t21_persona G fallbackg C0T21FBG1
t21_persona D pendingd C0T21PND1
ALL_PERSONAS=(A B C E F G D)

# t21_persona_json <prefix>: one persona entry: its credentials file, working
# directory, claude_config_dir and one channel, which also takes its
# permission prompts (its destination).
t21_persona_json() {
    local n="$1_NAME" l="$1_LABEL" w="$1_WORK" c="$1_CFG" ch="$1_CHANNEL"
    printf '{"name": "%s", "credentials_file": "%s", "working_directory": "%s", "claude_config_dir": "%s", "channels": [{"id": "%s", "delivery": "all"}], "permission_prompts": "%s"}' \
        "${!n}" "${CREDS_DIR}/${!l}.json" "${!w}" "${!c}" "${!ch}" "${!ch}"
}

T21_RECORD_ASIDE=0

# t21_config_for_next_start <prefix>...: the operator's edit while the server
# is stopped: config.json holds these personas (`health_check_interval` 0,
# `session_restart_delay` 0), and the last-applied record is moved aside, so
# the next start applies config.json as it stands.
t21_config_for_next_start() {
    local joined="" p record
    for p in "$@"; do
        joined+="${joined:+, }$(t21_persona_json "${p}")"
    done
    write_config << EOF
{
  "personas": [${joined}],
  "bind": "127.0.0.1",
  "port": ${SCENARIO_PORT},
  "health_check_interval": 0,
  "session_restart_delay": 0,
  "exit_timeout": 5
}
EOF
    record="${SLACK_STATE_DIR}/config.json${LAST_APPLIED_SUFFIX}"
    if [[ -e "${record}" ]]; then
        T21_RECORD_ASIDE=$(( T21_RECORD_ASIDE + 1 ))
        mv -- "${record}" "${record}.aside-${T21_RECORD_ASIDE}" || fail "could not move ${record} aside"
    fi
}

# ---------------------------------------------------------------------------
# The Slack stub (one for the script)
# ---------------------------------------------------------------------------

STUB_DIR="${SCENARIO_ROOT}/slack-stub"
STUB_RECORD="${STUB_DIR}/record.jsonl"
mkdir "${STUB_DIR}"
t21_labels=()
for t21_p in "${ALL_PERSONAS[@]}"; do
    t21_label_var="${t21_p}_LABEL"
    t21_labels+=("${!t21_label_var}")
done
python3 - "${t21_labels[@]}" << 'EOF' | write_file "${STUB_DIR}/control.json"
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
# Reading the rows, the logs, the record, the trail and the times
# ---------------------------------------------------------------------------

# t21_row_state <id>: print the row's state (a harness `status`), or nothing
# when the read fails.
t21_row_state() {
    ad_capture status --claude-instance-id "$1"
    [[ "${AD_RC}" == 0 ]] || return 0
    jq -r '.state // empty' "${AD_OUT}" 2> /dev/null || true
}

t21_row_is() {
    [[ "$(t21_row_state "$1")" == "$2" ]]
}

# True when the row reads `pending` with a launch start.
t21_row_pending_launched() {
    ad_capture status --claude-instance-id "$1"
    [[ "${AD_RC}" == 0 ]] || return 1
    jq -e '.state == "pending" and (.launch_started_at // "" | length > 0)' "${AD_OUT}" > /dev/null 2>&1
}

# t21_row_get <id> <step>: a harness `get` of the row (AD_OUT holds it); fail
# when it fails.
t21_row_get() {
    ad_capture get --claude-instance-id "$1"
    [[ "${AD_RC}" == 0 ]] || fail "$2: harness get of $1 exited ${AD_RC}: $(tr '\n' ' ' < "${AD_ERR}")"
}

# t21_row_snapshot <id> <step>: print the row as a harness `get` reads it,
# keys sorted, on one line.
t21_row_snapshot() {
    t21_row_get "$1" "$2"
    jq -cS . "${AD_OUT}"
}

# t21_lines <file>: how many lines <file> has (0 when missing).
t21_lines() {
    if [[ -f "$1" ]]; then
        wc -l < "$1" | tr -d ' '
    else
        echo 0
    fi
}

# t21_after <file> <line>: <file>'s lines after line <line>.
t21_after() {
    [[ -f "$1" ]] || return 0
    tail -n "+$(( $2 + 1 ))" "$1"
}

# t21_count_after <file> <line> <matcher>: lines after <line> that match.
t21_count_after() {
    local tmp="${SCENARIO_ROOT}/count-after.tmp"
    t21_after "$1" "$2" > "${tmp}"
    count_in "${tmp}" "$3"
}

# t21_count_exact <file> <line>: lines of <file> that are exactly <line>.
t21_count_exact() {
    local n
    n="$(grep -cxF -- "$2" "$1" 2> /dev/null)" || true
    printf '%s\n' "${n:-0}"
}

# t21_mark: the leg's mark: the time, and the lines server.log,
# startup-errors.log and clean_restart.log hold.
t21_mark() {
    MARK_TIME="${EPOCHREALTIME/,/.}"
    MARK_LOG="$(t21_lines "${SLACK_STATE_DIR}/server.log")"
    MARK_ERRORS="$(t21_lines "${SLACK_STATE_DIR}/startup-errors.log")"
    MARK_CLEAN="$(t21_lines "${SLACK_STATE_DIR}/clean_restart.log")"
}

# t21_cscb_calls_since <time> <verb> [<fragment>...]: CSCB's agent-director
# calls of <verb> holding every fragment, made at or after <time>.
t21_cscb_calls_since() {
    local since="$1" out
    shift
    out="$(cscb_ad_calls "$@")" || exit 1
    [[ -n "${out}" ]] || return 0
    awk -F'\t' -v t="${since}" '$2 + 0 >= t + 0' <<< "${out}"
}

# t21_cscb_count_since <time> <verb> [<fragment>...]
t21_cscb_count_since() {
    local out
    out="$(t21_cscb_calls_since "$@")" || exit 1
    if [[ -z "${out}" ]]; then
        echo 0
    else
        wc -l <<< "${out}" | tr -d ' '
    fi
}

# t21_run_count <run-pid> <time> <verb> [<fragment>...]: the calls of
# `t21_cscb_calls_since` whose parent is the CLI run <run-pid> (CLI-parented).
t21_run_count() {
    local pid="$1" out
    shift
    out="$(t21_cscb_calls_since "$@")" || exit 1
    [[ -n "${out}" ]] || { echo 0; return 0; }
    awk -F'\t' -v p="${pid}" '$4 == p' <<< "${out}" | wc -l | tr -d ' '
}

# t21_note_calls <time> <id> <step>: log how many CSCB calls of each verb
# named <id> at or after <time>.
t21_note_calls() {
    local out summary
    out="$(t21_cscb_calls_since "$1" "" "$2")" || exit 1
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

# t21_harness_find_missing: how many `find-missing` calls in the
# agent-director shim's whole log came from no CSCB process (the harness's).
t21_harness_find_missing() {
    local all cscb
    all="$(awk -F'\t' '$1 == "call" && $6 ~ /(^| )find-missing( |$)/' "${SCENARIO_AD_SHIM_LOG}" | wc -l | tr -d ' ')"
    cscb="$(cscb_ad_count find-missing)" || exit 1
    echo $(( all - cscb ))
}

# t21_cli <out-file> <cli-arg>...: a CLI command of the package under test,
# run as a CSCB process from the scenario's own shell (`cscb_run`, the tmux
# shim first on its PATH), with no Slack token, no CSCB_PERSONA and
# SLACK_DRY_RUN unset (so a server it starts is live); its standard output
# and error in <out-file>. Sets T21_RC to its status and T21_RUN_PID to its
# PID (the run's record entry), the parent of every call it makes.
t21_cli() {
    local out="$1" rc=0
    shift
    cscb_run env -u SLACK_BOT_TOKEN -u SLACK_APP_TOKEN -u CSCB_PERSONA -u SLACK_DRY_RUN \
        "${SCENARIO_CLI}" "$@" < /dev/null > "${out}" 2>&1 || rc=$?
    T21_RC="${rc}"
    T21_RUN_PID="$(awk -F'\t' '$1 == "proc" && $2 == "run" { p = $3 } END { print p }' "${SCENARIO_CSCB_RECORD}")"
    [[ "${T21_RUN_PID}" =~ ^[0-9]+$ ]] || fail "the CSCB process record holds no run entry for $*"
    echo "${TEST_NAME}: ${*} exited ${T21_RC} (run PID ${T21_RUN_PID})"
}

# t21_show <file> <what>: print <file> indented on stderr, for a failing step.
t21_show() {
    echo "  | ${2}:" >&2
    sed 's/^/  | /' "$1" >&2 || true
}

# t21_servers_since <time>: how many bot servers the CSCB process record
# holds that started at or after <time>.
t21_servers_since() {
    t21_note_record
    awk -F'\t' -v t="$1" '$1 == "proc" && $2 == "server" && $5 + 0 >= t + 0' "${SCENARIO_CSCB_RECORD}" | wc -l | tr -d ' '
}

# Bring the record up to date before it is read: a harness-side read of the
# CSCB processes, as `cscb_ad_calls` makes one.
t21_note_record() {
    cscb_ad_count "" > /dev/null || exit 1
}

# t21_server_down: true when the state dir's server.pid names no live process.
t21_server_down() {
    local pid
    pid="$(server_pid)"
    [[ -z "${pid}" ]] || ! pid_alive "${pid}"
}

# t21_start_and_wait <persona-count>: a live start, and its start pass
# completing (its own completion line: server.log is appended across starts).
t21_start_and_wait() {
    local m before
    m="$(completion_match "$1")" || exit 1
    before="$(count_log "${m}")"
    start_server --live
    wait_for_count "${m}" "$(( before + 1 ))" "${START_WAIT_S}" "the start pass never completed"
}

# t21_up <step> <prefix>...: a live start of these personas, each row
# reporting in (`waiting`).
t21_up() {
    local step="$1" p id_var
    shift
    t21_config_for_next_start "$@"
    t21_start_and_wait "$#"
    for p in "$@"; do
        id_var="${p}_ID"
        wait_until "${ROW_WAIT_S}" "${step}: ${!id_var} never reported in (waiting)" t21_row_is "${!id_var}" waiting
    done
}

# t21_session_ids <session>: print the session's id and its pane's id,
# `$N %N`, read with the real tmux from the scenario's own shell.
t21_session_ids() {
    "${SCENARIO_REAL_TMUX}" display-message -p -t "=$1:" '#{session_id} #{pane_id}'
}

# t21_has_session <session>: true when the scenario's tmux server holds it.
t21_has_session() {
    "${SCENARIO_REAL_TMUX}" has-session -t "=$1" 2> /dev/null
}

# t21_try_description <file> <since-line> <id> <try>: print agent-director's
# description of kill try <try> of <id> logged in <file> after line
# <since-line>, JSON-decoded from its per-try line; fail when there is none,
# or more than one.
t21_try_description() {
    local file="$1" since="$2" id="$3" n="$4" head out rc=0
    t21_value head killRetryTryLine.description-head "${id}" "${n}"
    out="$(python3 - "${file}" "${since}" "${head}" << 'EOF'
import json, sys
path, since, head = sys.argv[1], int(sys.argv[2]), sys.argv[3]
found = []
with open(path, encoding="utf-8", errors="surrogateescape") as f:
    for i, line in enumerate(f, 1):
        if i <= since:
            continue
        at = line.find(head)
        if at < 0:
            continue
        try:
            text, _ = json.JSONDecoder().raw_decode(line[at + len(head):])
        except ValueError:
            sys.exit(3)
        if not isinstance(text, str):
            sys.exit(3)
        found.append(text)
if len(found) != 1:
    sys.stderr.write(str(len(found)))
    sys.exit(4)
sys.stdout.write(found[0])
EOF
)" || rc=$?
    case "${rc}" in
        0) printf '%s' "${out}" ;;
        3) fail "${file##*/}'s kill try ${n} line for ${id} carries no JSON-quoted description after '${head}'" ;;
        4) fail "${file##*/} holds not exactly one kill try ${n} line for ${id} answering ErrTmuxKillFailed after line ${since}: '${head}'" ;;
        *) fail "could not read the kill try ${n} line for ${id} (python3 exited ${rc})" ;;
    esac
}

# t21_check_kill_failed_persona <prefix> <command> <out-file> <tries-file>
# <tries-since> <step>: persona <prefix>'s teardown under <command> (the name
# of a `CLI_COMMAND_*` export, as the printer takes it) failed
# on its kill: each of its KILL_RETRY_TRIES tries answered ErrTmuxKillFailed
# (its per-try line in <tries-file> after line <tries-since>), exactly
# KILL_RETRY_TRIES CLI-parented kills of its id; its failure line, as the
# printer renders it for the last try's description, printed once in
# <out-file> and followed there by the ordinary alert for the CLI-teardown
# route; each of the two appended once to server.log and, for
# `clean_restart`, once to clean_restart.log after the mark; one
# startup-errors entry of PERSONA_KILL_FAILED_LABEL holding both.
t21_check_kill_failed_persona() {
    local p="$1" command="$2" out="$3" tries_file="$4" tries_since="$5" step="$6"
    local id_var="${1}_ID" name_var="${1}_NAME" n desc last="" failure alert entry_class entry_message at next kills
    for (( n = 1; n <= KILL_TRIES; n++ )); do
        desc="$(t21_try_description "${tries_file}" "${tries_since}" "${!id_var}" "${n}")" || exit 1
        echo "${TEST_NAME}: ${step}: kill try ${n} of ${KILL_TRIES} for ${!id_var}: ErrTmuxKillFailed: ${desc}"
        last="${desc}"
    done
    kills="$(t21_run_count "${T21_RUN_PID}" "${MARK_TIME}" kill "${!id_var}")"
    [[ "${kills}" == "${KILL_TRIES}" ]] || fail "${step}: ${kills} CLI-parented kill(s) of ${!id_var}, not ${KILL_TRIES}"

    t21_value failure cliTeardownKillFailed.failure-line "${command}" "${!name_var}" "${last}"
    t21_value alert cliTeardownKillFailed.alert-line "${command}" "${!name_var}" "${last}"
    t21_value entry_class cliTeardownKillFailed.entry-class "${command}" "${!name_var}" "${last}"
    t21_value entry_message cliTeardownKillFailed.entry-message "${command}" "${!name_var}" "${last}"
    [[ "${entry_class}" == "${KILL_FAILED_LABEL}" ]] \
        || fail "${step}: the printer gives ${!id_var}'s entry the class '${entry_class}', not ${KILL_FAILED_LABEL}"

    # Printed: the failure line once, the alert on the line after it.
    n="$(t21_count_exact "${out}" "${failure}")"
    if [[ "${n}" != 1 ]]; then
        t21_show "${out}" "the command's output"
        echo "  | expected: ${failure}" >&2
        fail "${step}: ${n} printed failure line(s) for ${!name_var}, not 1"
    fi
    at="$(grep -nxF -- "${failure}" "${out}" | cut -d: -f1)"
    next="$(sed -n "$(( at + 1 ))p" "${out}")"
    if [[ "${next}" != "${alert}" ]]; then
        t21_show "${out}" "the command's output"
        echo "  | expected after line ${at}: ${alert}" >&2
        fail "${step}: ${!name_var}'s failure line is not followed by the ordinary alert for the CLI-teardown route"
    fi
    n="$(t21_count_exact "${out}" "${alert}")"
    [[ "${n}" == 1 ]] || fail "${step}: ${n} printed alert line(s) for ${!name_var}, not 1"

    # server.log: each once after the mark.
    n="$(t21_count_after "${SLACK_STATE_DIR}/server.log" "${MARK_LOG}" "] ${failure}")"
    [[ "${n}" == 1 ]] || fail "${step}: ${n} server.log line(s) of ${!name_var}'s failure line after the mark, not 1"
    n="$(t21_count_after "${SLACK_STATE_DIR}/server.log" "${MARK_LOG}" "] ${alert}")"
    [[ "${n}" == 1 ]] || fail "${step}: ${n} server.log line(s) of ${!name_var}'s alert after the mark, not 1"

    # clean_restart.log: clean_restart prints through its fatal path, which
    # also writes there.
    if [[ "${command}" == CLI_COMMAND_CLEAN_RESTART ]]; then
        n="$(t21_count_after "${SLACK_STATE_DIR}/clean_restart.log" "${MARK_CLEAN}" "] ${failure}")"
        [[ "${n}" == 1 ]] || fail "${step}: ${n} clean_restart.log line(s) of ${!name_var}'s failure line after the mark, not 1"
        n="$(t21_count_after "${SLACK_STATE_DIR}/clean_restart.log" "${MARK_CLEAN}" "] ${alert}")"
        [[ "${n}" == 1 ]] || fail "${step}: ${n} clean_restart.log line(s) of ${!name_var}'s alert after the mark, not 1"
    fi

    # One startup-errors entry holding the failure line and the alert.
    n="$(t21_count_after "${SLACK_STATE_DIR}/startup-errors.log" "${MARK_ERRORS}" "] [${KILL_FAILED_LABEL}] ${entry_message}")"
    if [[ "${n}" != 1 ]]; then
        t21_after "${SLACK_STATE_DIR}/startup-errors.log" "${MARK_ERRORS}" | sed 's/^/  | /' >&2
        echo "  | expected: [${KILL_FAILED_LABEL}] ${entry_message}" >&2
        fail "${step}: ${n} ${KILL_FAILED_LABEL} entries for ${!name_var} after the mark, not 1"
    fi
}

# t21_check_rows_kept <step> <prefix>...: no CSCB delete after the mark; each
# persona's row present (a harness `get`) and its session still there.
t21_check_rows_kept() {
    local step="$1" p id_var session_var n
    shift
    n="$(t21_cscb_count_since "${MARK_TIME}" delete)"
    [[ "${n}" == 0 ]] || fail "${step}: ${n} CSCB delete call(s) after the mark"
    for p in "$@"; do
        id_var="${p}_ID"
        session_var="${p}_SESSION"
        t21_row_get "${!id_var}" "${step}"
        echo "${TEST_NAME}: ${step}: ${!id_var}'s row is kept, reading $(jq -r '.state' "${AD_OUT}")"
        t21_has_session "${!session_var}" || fail "${step}: ${!session_var} is gone although its kills failed"
        t21_note_calls "${MARK_TIME}" "${!id_var}" "${step}"
    done
}

# t21_check_last_line <out-file> <line> <step>: <line> is <out-file>'s last line.
t21_check_last_line() {
    local got
    got="$(tail -n 1 "$1")"
    if [[ "${got}" != "$2" ]]; then
        t21_show "$1" "the command's output"
        fail "$3: the command's last line is '${got}', not '$2'"
    fi
}

# ---------------------------------------------------------------------------
# S3: the precheck legs (SRJ-901; E32's hatch note)
# ---------------------------------------------------------------------------

t21_precheck_legs() {
    local step="precheck" a_before b_before after pid out cmd cmd_name args head nothing n ids a_sid
    t21_up "${step}: setup" A B

    # The harness respawns A's worker pane with another process: A's
    # `read-pane` answers CONFLICT ("the agent's pane was not found") while
    # its row stays live.
    respawn_worker_pane "${A_SESSION}" sleep 86400 > /dev/null
    a_before="$(t21_row_snapshot "${A_ID}" "${step}")" || exit 1
    b_before="$(t21_row_snapshot "${B_ID}" "${step}")" || exit 1
    pid="$(server_pid)"
    [[ -n "${pid}" ]] && pid_alive "${pid}" || fail "${step}: no bot server running before the commands"
    t21_mark

    for cmd_name in CLI_COMMAND_CLEAN_RESTART CLI_COMMAND_STOP_BOTS; do
        t21_value cmd "${cmd_name}"
        read -r -a args <<< "${cmd}"
        out="${SCENARIO_ROOT}/precheck-${args[0]}.out"
        t21_cli "${out}" "${args[@]}"
        (( T21_RC != 0 )) || { t21_show "${out}" "the command's output"; fail "${step}: ${cmd} exited 0"; }

        # The precheck failure line naming A, its key, its session and
        # CONFLICT, the description holding agent-director's words; no line
        # for B; then "nothing was stopped", last.
        t21_value head precheckFailureLine.head "${cmd_name}" "${A_NAME}" AD_ERROR_CLASS_CONFLICT
        n="$(count_in "${out}" "$(matcher "${head}" "${PANE_NOT_FOUND}")")"
        if [[ "${n}" != 1 ]]; then
            t21_show "${out}" "the command's output"
            echo "  | expected: ${head}… ${PANE_NOT_FOUND} …" >&2
            fail "${step}: ${cmd}: ${n} precheck failure line(s) for ${A_NAME} in CONFLICT, not 1"
        fi
        t21_value head precheckFailureLine.head "${cmd_name}" "${B_NAME}" AD_ERROR_CLASS_CONFLICT
        head="${head%"${CLASS_CONFLICT}: "}"
        n="$(count_in "${out}" "${head}")"
        [[ "${n}" == 0 ]] || fail "${step}: ${cmd}: ${n} precheck failure line(s) for ${B_NAME}"
        t21_value nothing precheckNothingStoppedLine "${cmd_name}"
        t21_check_last_line "${out}" "${nothing}" "${step}: ${cmd}"
        n="$(t21_count_exact "${out}" "${nothing}")"
        [[ "${n}" == 1 ]] || fail "${step}: ${cmd}: ${n} '${nothing}' line(s), not 1"

        # Printed only: no precheck line in server.log or startup-errors.log.
        t21_value head precheckFailureLine.head "${cmd_name}" "${A_NAME}" AD_ERROR_CLASS_CONFLICT
        n="$(t21_count_after "${SLACK_STATE_DIR}/server.log" "${MARK_LOG}" "${head}")"
        [[ "${n}" == 0 ]] || fail "${step}: ${cmd}: ${n} precheck failure line(s) in server.log"
        n="$(t21_count_after "${SLACK_STATE_DIR}/startup-errors.log" "${MARK_ERRORS}" "${head}")"
        [[ "${n}" == 0 ]] || fail "${step}: ${cmd}: ${n} precheck failure line(s) in startup-errors.log"

        # The server was never stopped: same PID, still running.
        [[ "$(server_pid)" == "${pid}" ]] || fail "${step}: ${cmd}: server.pid reads '$(server_pid)', not the PID before the command, ${pid}"
        pid_alive "${pid}" || fail "${step}: ${cmd}: the bot server ${pid} is not running after the command"

        # No CLI-parented pause or kill; the positive control: the
        # command's own precheck `read-pane` of A, so its calls are counted.
        n="$(t21_run_count "${T21_RUN_PID}" "${MARK_TIME}" read-pane "${A_ID}")"
        (( n >= 1 )) || fail "${step}: ${cmd}: no CLI-parented read-pane of ${A_ID} (run PID ${T21_RUN_PID}): the command's calls were not found"
        for t21_verb in pause kill; do
            n="$(t21_run_count "${T21_RUN_PID}" "${MARK_TIME}" "${t21_verb}")"
            [[ "${n}" == 0 ]] || fail "${step}: ${cmd}: ${n} CLI-parented ${t21_verb} call(s)"
        done
        echo "${TEST_NAME}: ${step}: ${cmd} failed its precheck on ${A_NAME} and stopped nothing"
    done

    # A's and B's rows unchanged.
    after="$(t21_row_snapshot "${A_ID}" "${step}")" || exit 1
    [[ "${after}" == "${a_before}" ]] || fail "${step}: ${A_ID}'s row changed: ${after} (was ${a_before})"
    after="$(t21_row_snapshot "${B_ID}" "${step}")" || exit 1
    [[ "${after}" == "${b_before}" ]] || fail "${step}: ${B_ID}'s row changed: ${after} (was ${b_before})"
    t21_note_calls "${MARK_TIME}" "${A_ID}" "${step}"

    # The human ends A's session by its session id; A's read-pane then
    # answers GONE, which the precheck passes.
    ids="$(t21_session_ids "${A_SESSION}")" || fail "${step}: no session ${A_SESSION}"
    read -r a_sid _ <<< "${ids}"
    end_session "${a_sid}"
    ad_capture read-pane --claude-instance-id "${A_ID}" --n-lines 1
    if (( AD_RC == 0 )) || ! grep -qF -- "${CAPTURE_FAILED}" "${AD_OUT}" "${AD_ERR}"; then
        sed 's/^/  | /' "${AD_OUT}" "${AD_ERR}" >&2
        fail "${step}: after its session ended, a harness read-pane of ${A_ID} does not answer ${CAPTURE_FAILED} (GONE)"
    fi
}

# ---------------------------------------------------------------------------
# S4: the teardown-failure legs (SRJ-905, SRJ-906, SRJ-907, SRJ-909; E33's
# hatch note)
# ---------------------------------------------------------------------------

t21_teardown_failure_legs() {
    local step out pid new_pid last n p
    stop_server
    t21_up "teardown failure: setup" C E

    # clean_restart with every kill failing: the server restarted.
    step="clean_restart with a failed teardown"
    pid="$(server_pid)"
    t21_mark
    tmux_shim_mode fail-kill
    out="${SCENARIO_ROOT}/teardown-clean_restart.out"
    t21_cli "${out}" clean_restart
    (( T21_RC != 0 )) || { t21_show "${out}" "the command's output"; fail "${step}: clean_restart exited 0"; }
    for p in C E; do
        t21_check_kill_failed_persona "${p}" CLI_COMMAND_CLEAN_RESTART "${out}" "${SLACK_STATE_DIR}/clean_restart.log" "${MARK_CLEAN}" "${step}"
    done
    n="$(t21_count_after "${SLACK_STATE_DIR}/startup-errors.log" "${MARK_ERRORS}" "] [${KILL_FAILED_LABEL}] ")"
    [[ "${n}" == 2 ]] || fail "${step}: ${n} ${KILL_FAILED_LABEL} entries after the mark, not 2"
    t21_value last teardownNotStoppedLine CLI_COMMAND_CLEAN_RESTART 2
    t21_check_last_line "${out}" "${last}" "${step}"
    new_pid="$(server_pid)"
    [[ -n "${new_pid}" && "${new_pid}" != "${pid}" ]] || fail "${step}: server.pid reads '${new_pid}' after clean_restart, not a new PID (was ${pid})"
    pid_alive "${new_pid}" || fail "${step}: the restarted bot server ${new_pid} is not running"
    echo "${TEST_NAME}: NOTE: ${step}: the bot server ${pid} was restarted as ${new_pid}"
    t21_check_rows_kept "${step}" C E

    # stop --stop-bots with the same failure: the server stays stopped.
    step="stop --stop-bots with a failed teardown"
    pid="${new_pid}"
    t21_mark
    out="${SCENARIO_ROOT}/teardown-stop.out"
    t21_cli "${out}" stop --stop-bots
    (( T21_RC != 0 )) || { t21_show "${out}" "the command's output"; fail "${step}: stop --stop-bots exited 0"; }
    for p in C E; do
        t21_check_kill_failed_persona "${p}" CLI_COMMAND_STOP_BOTS "${out}" "${out}" 0 "${step}"
    done
    n="$(t21_count_after "${SLACK_STATE_DIR}/startup-errors.log" "${MARK_ERRORS}" "] [${KILL_FAILED_LABEL}] ")"
    [[ "${n}" == 2 ]] || fail "${step}: ${n} ${KILL_FAILED_LABEL} entries after the mark, not 2"
    t21_value last teardownNotStoppedLine CLI_COMMAND_STOP_BOTS 2
    t21_check_last_line "${out}" "${last}" "${step}"
    wait_until "${SERVER_GONE_S}" "${step}: the bot server ${pid} still runs after the command" t21_server_down
    ! pid_alive "${pid}" || fail "${step}: the bot server ${pid} still runs after the command"
    [[ ! -e "${SLACK_STATE_DIR}/server.pid" ]] || fail "${step}: server.pid is still there after the command"
    n="$(t21_servers_since "${MARK_TIME}")"
    [[ "${n}" == 0 ]] || fail "${step}: ${n} bot server(s) started after the command's mark (it runs no start)"
    t21_check_rows_kept "${step}" C E
}

# ---------------------------------------------------------------------------
# S5: the not-restarted leg (SRJ-906; SRD over Epic: one alert per run,
# printed, logged and recorded)
# ---------------------------------------------------------------------------

t21_not_restarted_leg() {
    local step="not restarted" out pid n alert head last p id_var name_var t
    tmux_shim_mode log
    t21_up "${step}: setup" F G
    pid="$(server_pid)"

    # The list-refusing stand-in behind the shim (shim check in the swap).
    swap_ad_binary "${SCENARIO_FIXTURES}/agent-director-list-refusing.sh" "${step}: swap in the list-refusing stand-in"
    ad_capture list --label "${SVC_LABEL}"
    if (( AD_RC == 0 )) || [[ -s "${AD_OUT}" ]]; then
        sed 's/^/  | /' "${AD_OUT}" "${AD_ERR}" >&2
        fail "${step}: behind the shim the stand-in answered a harness list (exit ${AD_RC})"
    fi
    ad_capture version
    (( AD_RC == 0 )) || { sed 's/^/  | /' "${AD_OUT}" "${AD_ERR}" >&2; fail "${step}: behind the shim the stand-in's version call exited ${AD_RC}"; }
    t21_row_get "${F_ID}" "${step}: the stand-in forwards get"

    t21_mark
    tmux_shim_mode fail-kill
    out="${SCENARIO_ROOT}/not-restarted.out"
    t21_cli "${out}" clean_restart
    (( T21_RC != 0 )) || { t21_show "${out}" "the command's output"; fail "${step}: clean_restart exited 0"; }

    # The precheck passed, the teardown failed.
    for p in F G; do
        name_var="${p}_NAME"
        t21_value head precheckFailureLine.head CLI_COMMAND_CLEAN_RESTART "${!name_var}" AD_ERROR_CLASS_CONFLICT
        head="${head%"${CLASS_CONFLICT}: "}"
        n="$(count_in "${out}" "${head}")"
        [[ "${n}" == 0 ]] || { t21_show "${out}" "the command's output"; fail "${step}: ${n} precheck failure line(s) for ${p}"; }
        t21_value head teardownFailureLine.head CLI_COMMAND_CLEAN_RESTART "${!name_var}" AD_ERROR_CLASS_UNAVAILABLE
        n="$(count_in "${out}" "${head}")"
        [[ "${n}" == 1 ]] || { t21_show "${out}" "the command's output"; fail "${step}: ${n} UNAVAILABLE teardown failure line(s) for ${p}, not 1"; }
    done

    # 3 CLI-parented `list` calls, each refused.
    n="$(t21_run_count "${T21_RUN_PID}" "${MARK_TIME}" list "${SVC_LABEL}")"
    [[ "${n}" == 3 ]] || fail "${step}: ${n} CLI-parented list call(s) carrying ${SVC_LABEL}, not 3"
    for (( t = 1; t <= 3; t++ )); do
        t21_value head answerCheckFailedTryLine.head "${t}"
        n="$(t21_count_after "${SLACK_STATE_DIR}/clean_restart.log" "${MARK_CLEAN}" "${head}")"
        [[ "${n}" == 1 ]] || fail "${step}: ${n} clean_restart.log line(s) of a failed answer-check try ${t}, not 1"
    done

    # No bot server running, none started.
    wait_until "${SERVER_GONE_S}" "${step}: the bot server ${pid} still runs after the command" t21_server_down
    n="$(t21_servers_since "${MARK_TIME}")"
    [[ "${n}" == 0 ]] || fail "${step}: ${n} bot server(s) started after the command's mark"

    # One not-restarted alert naming F and G with their sessions and class:
    # printed (stderr and clean_restart.log), appended to server.log and
    # recorded as one entry, the same text on all three.
    t21_value alert cleanRestartNotRestartedAlert AD_ERROR_CLASS_UNAVAILABLE "${F_NAME},${G_NAME}"
    n="$(t21_count_exact "${out}" "${alert}")"
    if [[ "${n}" != 1 ]]; then
        t21_show "${out}" "the command's output"
        echo "  | expected: ${alert}" >&2
        fail "${step}: ${n} printed not-restarted alert(s), not 1"
    fi
    for t21_file in clean_restart.log server.log; do
        case "${t21_file}" in
            clean_restart.log) n="$(t21_count_after "${SLACK_STATE_DIR}/${t21_file}" "${MARK_CLEAN}" "] ${alert}")" ;;
            *) n="$(t21_count_after "${SLACK_STATE_DIR}/${t21_file}" "${MARK_LOG}" "] ${alert}")" ;;
        esac
        [[ "${n}" == 1 ]] || fail "${step}: ${n} ${t21_file} line(s) of the not-restarted alert after the mark, not 1"
    done
    n="$(t21_count_after "${SLACK_STATE_DIR}/startup-errors.log" "${MARK_ERRORS}" "] [${NOT_RESTARTED_LABEL}] ")"
    [[ "${n}" == 1 ]] || fail "${step}: ${n} ${NOT_RESTARTED_LABEL} entries after the mark, not 1"
    n="$(t21_count_after "${SLACK_STATE_DIR}/startup-errors.log" "${MARK_ERRORS}" "] [${NOT_RESTARTED_LABEL}] ${alert}")"
    if [[ "${n}" != 1 ]]; then
        t21_after "${SLACK_STATE_DIR}/startup-errors.log" "${MARK_ERRORS}" | sed 's/^/  | /' >&2
        fail "${step}: the ${NOT_RESTARTED_LABEL} entry is not the printed alert"
    fi
    t21_value last teardownNotStoppedLine CLI_COMMAND_CLEAN_RESTART 2
    t21_check_last_line "${out}" "${last}" "${step}"

    n="$(t21_cscb_count_since "${MARK_TIME}" delete)"
    [[ "${n}" == 0 ]] || fail "${step}: ${n} CSCB delete call(s) after the mark"
    for p in F G; do
        id_var="${p}_ID"
        t21_row_get "${!id_var}" "${step}"
        echo "${TEST_NAME}: ${step}: ${!id_var}'s row is kept, reading $(jq -r '.state' "${AD_OUT}")"
    done

    # The release back behind the shim (shim check in the swap), and `log`.
    swap_ad_binary release "${step}: restore the release behind the shim"
    tmux_shim_mode log
}

# ---------------------------------------------------------------------------
# S6: the pending-persona leg (SRJ-1411's second sentence, SRJ-903, SRJ-410;
# AC 4)
# ---------------------------------------------------------------------------

# t21_trail_after <time> <event> <id>: the trail's <event> records for <id>
# at or after <time> (seconds since the epoch), one JSON per line, each with
# `epoch` added.
t21_trail_after() {
    local trail="${HOME}/.agent-director/ad-trail.jsonl"
    [[ -f "${trail}" ]] || return 0
    jq -c --arg e "$2" --arg id "$3" --argjson t "$1" '
        select(.event == $e and .claude_instance_id == $id)
        | (.ts | capture("^(?<s>[^.Z]+)(\\.(?<f>[0-9]+))?Z$")) as $ts
        | . + {epoch: (($ts.s + "Z" | fromdateiso8601) + ("0." + ($ts.f // "0") | tonumber))}
        | select(.epoch >= $t)' "${trail}" || fail "could not read ${trail}'s $2 records for $3"
}

# t21_ms_since <iso-time> <step>: print the whole milliseconds from
# <iso-time> to now.
t21_ms_since() {
    local then_ms
    then_ms="$(date -u -d "$1" +%s%3N)" || fail "$2: could not read the time '$1'"
    echo $(( $(date +%s%3N) - then_ms ))
}

t21_pending_leg() {
    local step="pending persona" out ref n launch session mark tick tick_t launches fm_before age_ms
    stub_mode "${D_WORK}" "${STUB_MODE_UNRECOGNISED}"
    t21_config_for_next_start D
    t21_start_and_wait 1
    wait_until "${ROW_WAIT_S}" "${step}: ${D_ID} never read pending with a launch start" t21_row_pending_launched "${D_ID}"
    launch="$(jq -r '.launch_started_at' "${AD_OUT}")"
    echo "${TEST_NAME}: ${step}: ${D_ID} reads pending at its dialog, launch start ${launch}"
    t21_has_session "${D_SESSION}" || fail "${step}: no session ${D_SESSION} for D's pending launch"

    # stop --stop-bots, before G (the pending grace period) has passed since
    # D's launch start, so D's row still reads `pending`: D's pause answers
    # ErrSpawnNotPausable, its kill succeeds.
    age_ms="$(t21_ms_since "${launch}" "${step}")" || exit 1
    (( age_ms < GRACE_MS )) \
        || fail "${step}: ${age_ms} ms passed since ${D_ID}'s launch start before stop --stop-bots, not less than G (${GRACE_MS} ms): its row may no longer read pending"
    echo "${TEST_NAME}: ${step}: stop --stop-bots ${age_ms} ms after ${D_ID}'s launch start (G ${GRACE_MS} ms)"
    t21_mark
    out="${SCENARIO_ROOT}/pending-stop.out"
    t21_cli "${out}" stop --stop-bots
    (( T21_RC == 0 )) || { t21_show "${out}" "the command's output"; fail "${step}: stop --stop-bots exited ${T21_RC}, not 0 with every persona stopped"; }
    ref="$(persona_ref "${D_NAME}")" || exit 1
    n="$(count_in "${out}" "$(matcher "${ESCALATION_HEAD}${ref}${ESCALATION_MID}" "${NOT_PAUSABLE}")")"
    [[ "${n}" == 1 ]] || { t21_show "${out}" "the command's output"; fail "${step}: ${n} escalation line(s) for ${D_NAME} carrying ${NOT_PAUSABLE}, not 1"; }
    n="$(t21_run_count "${T21_RUN_PID}" "${MARK_TIME}" pause "${D_ID}")"
    [[ "${n}" == 1 ]] || fail "${step}: ${n} CLI-parented pause call(s) of ${D_ID}, not 1"
    n="$(t21_run_count "${T21_RUN_PID}" "${MARK_TIME}" kill "${D_ID}")"
    [[ "${n}" == 1 ]] || fail "${step}: ${n} CLI-parented kill call(s) of ${D_ID}, not 1 that succeeded"
    wait_until "${SERVER_GONE_S}" "${step}: the bot server still runs after the command" t21_server_down
    ! t21_has_session "${D_SESSION}" || fail "${step}: ${D_SESSION} is still there after the kill"
    echo "${TEST_NAME}: NOTE: ${step}: after the kill ${D_ID} reads '$(t21_row_state "${D_ID}")'"

    # The next server: D's directory reports in now.
    stub_mode "${D_WORK}" "${STUB_MODE_DEV_CHANNELS}"
    t21_mark
    mark="${MARK_TIME}"
    t21_start_and_wait 1
    wait_until "${D_RECOVER_WAIT_S}" "${step}: ${D_ID} never came back (waiting)" t21_row_is "${D_ID}" waiting

    # The new server never kills D's row; the harness ran no find-missing.
    n="$(t21_cscb_count_since "${mark}" kill "${D_ID}")"
    [[ "${n}" == 0 ]] || fail "${step}: ${n} CSCB kill call(s) of ${D_ID} after the restart"
    n="$(t21_harness_find_missing)"
    [[ "${n}" == 0 ]] || fail "${step}: ${n} find-missing call(s) from no CSCB process (the harness runs none for an unlatched persona)"

    # CSCB's own run marked D's row missing: one trail mark, from pending,
    # with a CSCB find-missing at or before it.
    tick="$(t21_trail_after "${mark}" ad.find_missing.tick "${D_ID}" | jq -c 'select(.new_state == "missing")')" \
        || fail "${step}: could not read the trail's find-missing marks of ${D_ID}"
    n="$(grep -c . <<< "${tick}" || true)"
    [[ "${n}" == 1 ]] || fail "${step}: ${n} trail mark(s) of ${D_ID} missing after the restart, not 1: ${tick}"
    [[ "$(jq -r '.prior_state' <<< "${tick}")" == pending ]] || fail "${step}: the trail marks ${D_ID} missing from '$(jq -r '.prior_state' <<< "${tick}")', not pending"
    tick_t="$(jq -r '.epoch' <<< "${tick}")"
    fm_before="$(t21_cscb_calls_since "${mark}" find-missing | awk -F'\t' -v t="${tick_t}" '$2 + 0 <= t + 0' | wc -l | tr -d ' ')"
    (( fm_before >= 1 )) || fail "${step}: no CSCB find-missing call after the restart at or before the trail's mark of ${D_ID} (${tick_t})"
    echo "${TEST_NAME}: ${step}: ${D_ID} marked missing at ${tick_t} ($(jq -r '.reconciliation_reason' <<< "${tick}")), after ${fm_before} CSCB find-missing call(s)"

    # Brought up once: one launch record after the restart, after the mark.
    launches="$( { t21_trail_after "${mark}" ad.spawn.reused "${D_ID}"; t21_trail_after "${mark}" ad.resume.moved_to_pending "${D_ID}"; } )" \
        || fail "${step}: could not read the trail's launch records of ${D_ID}"
    n="$(grep -c . <<< "${launches}" || true)"
    [[ "${n}" == 1 ]] || fail "${step}: ${n} launch record(s) of ${D_ID} after the restart, not 1: ${launches}"
    awk -v a="$(jq -r '.epoch' <<< "${launches}")" -v b="${tick_t}" 'BEGIN { exit !(a + 0 >= b + 0) }' \
        || fail "${step}: ${D_ID}'s launch ($(jq -r '.epoch' <<< "${launches}")) came before its row was marked missing (${tick_t})"
    echo "${TEST_NAME}: ${step}: ${D_ID} brought up once ($(jq -r '.event' <<< "${launches}"))"
    t21_row_is "${D_ID}" waiting || fail "${step}: ${D_ID} reads '$(t21_row_state "${D_ID}")', not waiting"
    t21_note_calls "${mark}" "${D_ID}" "${step}"
}

t21_precheck_legs
t21_teardown_failure_legs
t21_not_restarted_leg
t21_pending_leg
stop_server

# The closing assertions (b.jg5 SRJ-1401, SRJ-1418).
assert_no_server_tmux
assert_no_cscb_include_finished
assert_no_cscb_delete

echo "${TEST_NAME}: PASS"
