#!/usr/bin/env bash
# Test 14 (HO §7 scenario 2; b.jg5 SRJ-1403; AC 24, AC 64): a kill that
# really fails. With the tmux shim in `fail-kill`, a live row's agent-director
# `kill` finds its worker still running after the kill exit wait and answers
# ErrTmuxKillFailed, at the start sweep, at a `config_dir` mismatch and at a
# `cwd` mismatch. At each site no CSCB delete or launch follows, the row is
# kept, and one kill-failure alert quoting agent-director's description is
# routed per SRJ-704 (b.jg5 SRJ-704, SRJ-705, SRJ-707, SRJ-411, SRJ-714,
# SRJ-1002, SRJ-1007, SRJ-1013, SRJ-1014, SRJ-1401, SRJ-1418).
#
# fmk setup (lib/scenario.sh fmk mode; b.jg5 SRJ-1306, SRJ-1401):
# - its own HOME, agent-director store and tmux server, all under
#   SCENARIO_ROOT, with the agent-director shim in front of the binary and the
#   tmux shim first on the PATH of every CSCB process (the bot server, `start`
#   and `stop` runs), which agent-director inherits;
# - the 0.10.0 start (SCENARIO_AD_START=0.10.0: 0.10.0's binary behind the
#   shim, no store), then, as the script's first step, the release's
#   install.sh over it (`install_ad_release`, which re-shims both paths and
#   checks the shims). E47 T2's scenario 16 seeds its 0.10.0 rows before that
#   install and runs its section right after it;
# - agent-director at its default settings (no config.toml): kill_exit_wait_ms
#   at its default, 5000 ms, measured (slowest exit 603 ms) (RN-6; HO rev 31);
#   the bounded retry makes 3 tries 2 s apart (KILL_RETRY_TRIES,
#   KILL_RETRY_SPACING_MS, src/kill-retry.ts), so one kill's tries take about
#   20 s;
# - every start is live (`start_server --live`), against the loopback Slack
#   stub (fixtures/slack-stub-server.ts, one for the script, every persona's
#   token pair answered ok), with `health_check_interval` 0, so no health tick
#   reconnects or relaunches a persona; posts are read from the stub's record;
# - the tmux shim's mode per leg: `log` while a leg launches its persona,
#   `fail-kill` for the kills the leg checks, `log` again at the leg's end;
# - the stub worker's mode per working directory (`stub_mode`): the start
#   sweep's persona reports in (`dev-channels`, the approver's Enter), the
#   `config_dir` and `cwd` personas never do (`silent`), so their rows stay
#   `pending` with a launch start;
# - each leg has its own persona (key, credentials, channel, directories) and
#   reads only its own ids, and only lines written after its start mark (a
#   later start re-sweeps rows an earlier leg kept): server.log and
#   startup-errors.log from the mark's line, the Slack stub's record from the
#   mark's line, and CSCB's agent-director calls (`cscb_ad_calls`: only the
#   agent-director shim's lines whose parent is a CSCB process) from the
#   mark's time;
# - between legs the harness plays the operator: a plain `stop` (no
#   teardown), an edit of config.json and the last-applied record moved aside,
#   so the next start applies config.json as it stands (README "Reload");
# - re-pointing a symlinked `working_directory` or `claude_config_dir`
#   (`repoint_symlink`, a harness addition, confirm at the reconcile pass) is
#   the working default that makes a real `cwd` or `config_dir` mismatch with
#   no config edit: agent-director's spawn records the real `cwd`, CSCB writes
#   the `config_dir` label by real path, and `compareRowToPersona` resolves the
#   persona's directories by real path at every comparison. Setup checks its
#   refusals (a link or target outside SCENARIO_ROOT, a link that is not a
#   symlink, a missing target), each leaving the link as it was.
#
# Legs, in run order (each a function `leg_<name>`):
#   1. start_sweep  persona X reports in (`log`); a plain stop; X removed from
#                   config.json; `fail-kill`; a start. The start sweep
#                   (`reconcileOrphans`) sweeps X's live row (absent persona)
#                   and kills it with the bounded retry: each try answers
#                   ErrTmuxKillFailed, its description carrying
#                   RETRY_KILL_LATER_PHRASE and NEVER_DELETE_ROW_PHRASE. Then
#                   exactly KILL_RETRY_TRIES CSCB kills of X's id, no CSCB
#                   delete, spawn or resume of it; X's row present and still
#                   `waiting`; exactly one `orphan-cleanup` startup-errors
#                   entry for X, naming its row, state, session and the
#                   outcome, carrying the alert's ordinary version in its
#                   start-sweep form for the last try's description, and one
#                   server-log line of it; nothing about X reaches the Slack
#                   stub and no `tmux-unresponsive` post is made.
#   2. config_dir   persona C (Slack destination) has a symlinked
#                   claude_config_dir and the `silent` stub: its row stays
#                   `pending` with a launch start. A plain stop; the symlink
#                   re-pointed; `fail-kill`; a start. The start sweep never
#                   compares `config_dir` and keeps the row; the start pass's
#                   collision `get` finds it `pending` and not covered (its
#                   `config_dir` label differs, SRJ-411; the not-covered
#                   line), so the ladder's `pending` branch starts the
#                   live-row sequence, whose first kill's tries each answer
#                   ErrTmuxKillFailed. Then exactly
#                   one ordinary alert at C's destination (the persona
#                   notifier's prefix, then the alert for the last try's
#                   description with the "keeps retrying" closing sentence);
#                   C is observed through one further retry of its retry
#                   timer, whose sequence's kill fails the same way and posts
#                   no second alert; after the first failed try no CSCB
#                   delete, spawn or resume of C's id; C's row present; no
#                   `tmux-unresponsive` post.
#   3. cwd          persona W (Slack destination) has a symlinked
#                   working_directory and the `silent` stub; a start (`log`)
#                   launches it, its row reads `pending` and its retry timer
#                   runs in pending-only mode (first retry 30 s after the
#                   launch, SRJ-302). With `fail-kill` set, the symlink is
#                   re-pointed before that retry (within REPOINT_BEFORE_S of
#                   the launch start; no not-covered line before it); the
#                   retry's `status` read and its `get` find the row's `cwd`
#                   differing by real path (the not-covered line after the
#                   re-point, with no start in between), and the live-row
#                   sequence's kill fails. Then the same checks as leg 2,
#                   for W, through one further retry.
#   The `resume_enabled=false` site is not driven here: SRJ-1403 leaves it,
#   with `ErrSpawnNotResumable` with dead evidence, to SRJ-110's unit test
#   (dead evidence means the session is gone, so agent-director's kill sends
#   no kill for the shim to fail; dead-evidence rule).
#
# Waits: each leg's kills are waited for by their lines, bounded at
# KILL_WAIT_S (3 tries of up to the 5000 ms kill exit wait, 2 s apart, with
# their reads); a further retry by its line, bounded at RETRY_WAIT_S (the
# retry timer's next wait, 30 or 60 s, plus a kill's tries). No fixed sleep
# but NO_SECOND_ALERT_HOLD_S, a hold that checks no second alert follows.
#
# Matched values (every one printed by fixtures/fmk-texts.ts from the
# installed package, never typed here):
#   - the per-try line's fixed part before the JSON-quoted description
#     (`killRetryTryLine`, src/kill-retry.ts; `describeKillOutcome`,
#     src/checked-kill.ts), from which each try's description is read;
#   - the end line's parts (`killRetryEndLine`, src/kill-retry.ts), which
#     count each sequence's kill tries;
#   - RETRY_KILL_LATER_PHRASE, NEVER_DELETE_ROW_PHRASE
#     (src/ad-description-phrases.ts);
#   - ORPHAN_CLEANUP_LABEL (src/kill-failure-alert.ts), the entry's class,
#     matched as `[<class>] ` (the entry line's layout, src/startup-errors.ts
#     recordStartupError, which has no exported builder);
#   - the entry's head (`startSweepKillFailedEntry`, src/session-manager.ts)
#     and the alert's start-sweep entry form (`killFailureAlertEntryText` over
#     `killFailureAlertText`, src/kill-failure-alert.ts);
#   - the destination post (`formatPersonaNotice`, src/persona-notifier.ts,
#     then `killFailureAlertText` for Slack, src/kill-failure-alert.ts);
#   - the line for a `pending` row that is not covered
#     (`uncoveredPendingRowLine`, src/session-manager.ts, with
#     PENDING_ROW_REASON_CONFIG_DIR_MISMATCH or
#     PENDING_ROW_REASON_CWD_MISMATCH, src/pending-row.ts), which names the
#     site that sent the row to the live-row sequence;
#   - the `tmux-unresponsive` onset (`tmuxUnresponsiveOnsetText`,
#     src/persona-episodes.ts), for absence checks;
#   - instance ids (`personaInstanceId`, src/persona-identity.ts; each alert's
#     session is the one the row records, read with a harness `get`) and the
#     last-applied record's suffix (LAST_APPLIED_FILE_SUFFIX, src/reload.ts).
#
# Outcomes the SRD leaves open are logged as `NOTE:` lines, not asserted: the
# CSCB calls of a leg's id before its first kill, counted by verb, and the
# posts a leg's destination got.
#
# The script ends with the closing assertions, `assert_no_server_tmux`,
# `assert_no_cscb_include_finished` and `assert_no_cscb_delete` (b.jg5
# SRJ-1418), in its own shell; their counts read only the shims' lines whose
# parent is a CSCB process.
set -euo pipefail

TEST_NAME="test-14-fmk-kill-fails"
SCENARIO_AD_START=0.10.0
# shellcheck source=lib/scenario.sh
source "$(dirname "$0")/lib/scenario.sh"

# E47 T2's scenario 16 seeds its 0.10.0 rows here, before the release's
# install, and runs its section right after it.
install_ad_release "setup: the release's install.sh over the 0.10.0 start"
check_ad_shim "setup: the agent-director shim after the release's install"

# ---------------------------------------------------------------------------
# Bounds (seconds)
# ---------------------------------------------------------------------------

# A live start's start pass completing.
START_WAIT_S=120
# A launched persona's row reporting in, or reading pending with a launch start.
ROW_WAIT_S=120
# One kill's tries (3 tries of up to the 5 s kill exit wait, 2 s apart, with
# their reads), from a start or a retry, with room for the start itself.
KILL_WAIT_S=120
# A further retry of a persona's retry timer (its next wait, 30 or 60 s) and
# its sequence's kill's tries.
RETRY_WAIT_S=180
# A destination post reaching the Slack stub after its kill's tries ended.
POST_WAIT_S=60
# How long no second alert may follow a further retry's failed kill.
NO_SECOND_ALERT_HOLD_S=5
# The Slack stub writing its ready file.
STUB_WAIT_S=30
# Before the first pending-only retry (30 s after the launch, SRJ-302) the
# `cwd` symlink must be re-pointed: at most this many seconds after the launch
# start.
REPOINT_BEFORE_S=25

# ---------------------------------------------------------------------------
# Values from the installed package (fixtures/fmk-texts.ts)
# ---------------------------------------------------------------------------

T14_PRINTER="${SCENARIO_FIXTURES}/fmk-texts.ts"

# t14_text <entry> [<arg>...]: print the printer's value for <entry>.
t14_text() {
    bun "${T14_PRINTER}" "$@"
}

# t14_value <var> <entry> [<arg>...]: set <var> to the printer's value; fail
# naming the entry when the printer fails.
t14_value() {
    local -n t14_value_out="$1"
    shift
    t14_value_out="$(t14_text "$@")" || fail "the value printer failed for $*"
}

t14_value KILL_TRIES KILL_RETRY_TRIES
t14_value PHRASE_RETRY RETRY_KILL_LATER_PHRASE
t14_value PHRASE_NEVER_DELETE NEVER_DELETE_ROW_PHRASE
t14_value ORPHAN_LABEL ORPHAN_CLEANUP_LABEL
t14_value LAST_APPLIED_SUFFIX LAST_APPLIED_FILE_SUFFIX
[[ "${KILL_TRIES}" =~ ^[1-9][0-9]*$ ]] || fail "setup: KILL_RETRY_TRIES '${KILL_TRIES}' is not a whole number"

# ---------------------------------------------------------------------------
# Personas: one per leg, each with its own key, credentials and channel
# ---------------------------------------------------------------------------

CREDS_DIR="${SCENARIO_ROOT}/credentials"
CFG_ROOT="${SCENARIO_ROOT}/claude-config"
mkdir -m 700 "${CREDS_DIR}"
mkdir -p "${CFG_ROOT}"

# Leg 1, the start sweep: X.
X_NAME="${SCENARIO_TAG}sweep"
X_LABEL="${SCENARIO_TAG}sweep1"
X_CHANNEL="C0T14SWP1"
X_WORK="$(make_workdir "${SCENARIO_TAG}sweep_work")"
X_CFG="${CFG_ROOT}/${SCENARIO_TAG}sweep_cfg"
X_KEY="$(persona_key "${X_NAME}")"
t14_value X_ID personaInstanceId "${X_KEY}"

# Leg 2, the config_dir mismatch: C, its claude_config_dir a symlink.
C_NAME="${SCENARIO_TAG}cfgdir"
C_LABEL="${SCENARIO_TAG}cfgdir1"
C_CHANNEL="C0T14CFG1"
C_WORK="$(make_workdir "${SCENARIO_TAG}cfgdir_work")"
C_CFG_ONE="${CFG_ROOT}/${SCENARIO_TAG}cfgdir_one"
C_CFG_TWO="${CFG_ROOT}/${SCENARIO_TAG}cfgdir_two"
C_CFG_LINK="${CFG_ROOT}/${SCENARIO_TAG}cfgdir_link"
C_KEY="$(persona_key "${C_NAME}")"
t14_value C_ID personaInstanceId "${C_KEY}"

# Leg 3, the cwd mismatch: W, its working_directory a symlink.
W_NAME="${SCENARIO_TAG}cwd"
W_LABEL="${SCENARIO_TAG}cwd1"
W_CHANNEL="C0T14CWD1"
W_ONE="$(make_workdir "${SCENARIO_TAG}cwd_one")"
W_TWO="$(make_workdir "${SCENARIO_TAG}cwd_two")"
W_LINK="${SCENARIO_ROOT}/work/${SCENARIO_TAG}cwd_link"
W_CFG="${CFG_ROOT}/${SCENARIO_TAG}cwd_cfg"
W_KEY="$(persona_key "${W_NAME}")"
t14_value W_ID personaInstanceId "${W_KEY}"

mkdir -p "${X_CFG}" "${C_CFG_ONE}" "${C_CFG_TWO}" "${W_CFG}"
ln -s -- "${C_CFG_ONE}" "${C_CFG_LINK}"
ln -s -- "${W_ONE}" "${W_LINK}"

# repoint_symlink's refusals (a harness addition, confirm at the reconcile
# pass), each in a subshell: it fails, saying why, and changes nothing.
t14_expect_refusal() {
    local why="$1" err="${SCENARIO_ROOT}/repoint-refusal.err" rc=0
    shift
    ( repoint_symlink "$@" ) 2> "${err}" || rc=$?
    (( rc != 0 )) && grep -qF -- "${why}" "${err}" \
        || fail "setup: repoint_symlink $* did not refuse with '${why}': $(tr '\n' ' ' < "${err}")"
}
t14_expect_refusal "refused: the link" /tmp "${C_CFG_TWO}"
t14_expect_refusal "refused: the target" "${C_CFG_LINK}" /tmp
t14_expect_refusal "is not a symlink" "${C_CFG_ONE}" "${C_CFG_TWO}"
t14_expect_refusal "does not exist" "${C_CFG_LINK}" "${CFG_ROOT}/${SCENARIO_TAG}cfgdir_none"
[[ "$(realpath -e -- "${C_CFG_LINK}")" == "$(realpath -e -- "${C_CFG_ONE}")" ]] \
    || fail "setup: a refused repoint_symlink changed ${C_CFG_LINK}"

for t14_label in "${X_LABEL}" "${C_LABEL}" "${W_LABEL}"; do
    printf '{"bot_token": "%s", "app_token": "%s"}\n' "$(fake_token bot "${t14_label}")" "$(fake_token app "${t14_label}")" \
        | write_file "${CREDS_DIR}/${t14_label}.json" 600
done

# t14_persona_json <name> <label> <working-dir> <config-dir> <channel>: one
# persona entry: its credentials file, working directory, claude_config_dir
# and one channel, which also takes its permission prompts (its destination).
t14_persona_json() {
    printf '{"name": "%s", "credentials_file": "%s", "working_directory": "%s", "claude_config_dir": "%s", "channels": [{"id": "%s", "delivery": "all"}], "permission_prompts": "%s"}' \
        "$1" "${CREDS_DIR}/$2.json" "$3" "$4" "$5" "$5"
}

T14_RECORD_ASIDE=0

# t14_config_for_next_start [<persona-json>...]: the operator's edit while the
# server is stopped: config.json holds these personas, and the last-applied
# record is moved aside, so the next start applies config.json as it stands.
t14_config_for_next_start() {
    local joined="" entry record
    for entry in "$@"; do
        joined+="${joined:+, }${entry}"
    done
    write_config << EOF
{
  "personas": [${joined}],
  "bind": "127.0.0.1",
  "port": ${SCENARIO_PORT},
  "health_check_interval": 0,
  "exit_timeout": 5
}
EOF
    record="${SLACK_STATE_DIR}/config.json${LAST_APPLIED_SUFFIX}"
    if [[ -e "${record}" ]]; then
        T14_RECORD_ASIDE=$(( T14_RECORD_ASIDE + 1 ))
        mv -- "${record}" "${record}.aside-${T14_RECORD_ASIDE}" || fail "could not move ${record} aside"
    fi
}

# ---------------------------------------------------------------------------
# The Slack stub (one for the script)
# ---------------------------------------------------------------------------

STUB_DIR="${SCENARIO_ROOT}/slack-stub"
STUB_RECORD="${STUB_DIR}/record.jsonl"
mkdir "${STUB_DIR}"
python3 - "${X_LABEL}" "${C_LABEL}" "${W_LABEL}" << 'EOF' | write_file "${STUB_DIR}/control.json"
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
# Reading the row, the logs and the record
# ---------------------------------------------------------------------------

# t14_row_get <id>: a harness `get` of the row (AD_OUT holds it); fail when it
# fails.
t14_row_get() {
    ad_capture get --claude-instance-id "$1"
    [[ "${AD_RC}" == 0 ]] || fail "harness get of $1 exited ${AD_RC}: $(tr '\n' ' ' < "${AD_ERR}")"
}

# t14_row_state <id>: print the row's state (`status`), or nothing when the
# read fails.
t14_row_state() {
    ad_capture status --claude-instance-id "$1"
    [[ "${AD_RC}" == 0 ]] || return 0
    jq -r '.state // empty' "${AD_OUT}" 2> /dev/null || true
}

t14_row_is() {
    [[ "$(t14_row_state "$1")" == "$2" ]]
}

# True when the row reads `pending` with a launch start.
t14_row_pending_launched() {
    ad_capture status --claude-instance-id "$1"
    [[ "${AD_RC}" == 0 ]] || return 1
    jq -e '.state == "pending" and (.launch_started_at // "" | length > 0)' "${AD_OUT}" > /dev/null 2>&1
}

# t14_lines <file>: print how many lines <file> has (0 when missing).
t14_lines() {
    if [[ -f "$1" ]]; then
        wc -l < "$1" | tr -d ' '
    else
        echo 0
    fi
}

# t14_after <file> <line>: print <file>'s lines after line <line>.
t14_after() {
    [[ -f "$1" ]] || return 0
    tail -n "+$(( $2 + 1 ))" "$1"
}

# t14_count_after <file> <line> <matcher>: lines after <line> that match.
t14_count_after() {
    local tmp="${SCENARIO_ROOT}/count-after.tmp"
    t14_after "$1" "$2" > "${tmp}"
    count_in "${tmp}" "$3"
}

t14_count_after_at_least() {
    (( $(t14_count_after "$1" "$2" "$3") >= $4 ))
}

# t14_mark: the leg's start mark: the time, and the lines server.log,
# startup-errors.log and the Slack stub's record hold.
t14_mark() {
    MARK_TIME="${EPOCHREALTIME/,/.}"
    MARK_LOG="$(t14_lines "${SLACK_STATE_DIR}/server.log")"
    MARK_ERRORS="$(t14_lines "${SLACK_STATE_DIR}/startup-errors.log")"
    MARK_RECORD="$(t14_lines "${STUB_RECORD}")"
}

# t14_cscb_calls_since <time> <verb> <id>: print CSCB's agent-director calls
# of <verb> naming <id>, made at or after <time>.
t14_cscb_calls_since() {
    local out
    out="$(cscb_ad_calls "$2" "$3")" || exit 1
    [[ -n "${out}" ]] || return 0
    awk -F'\t' -v t="$1" '$2 + 0 >= t + 0' <<< "${out}"
}

# t14_cscb_count_since <time> <verb> <id>
t14_cscb_count_since() {
    local out
    out="$(t14_cscb_calls_since "$@")" || exit 1
    if [[ -z "${out}" ]]; then
        echo 0
    else
        wc -l <<< "${out}" | tr -d ' '
    fi
}

# t14_first_call_time <time> <verb> <id>: the time of CSCB's first <verb> of
# <id> at or after <time>; empty when none.
t14_first_call_time() {
    local out
    out="$(t14_cscb_calls_since "$@")" || exit 1
    [[ -n "${out}" ]] || return 0
    head -n 1 <<< "${out}" | cut -f 2
}

# t14_try_description <id> <try> <nth>: print agent-director's description
# of try <try> of the <nth> kill-retry of <id> logged after the leg's mark,
# JSON-decoded from its per-try line; fail when there is none.
t14_try_description() {
    local id="$1" n="$2" nth="$3" head out rc=0
    t14_value head killRetryTryLine.description-head "${id}" "${n}"
    out="$(python3 - "${SLACK_STATE_DIR}/server.log" "${MARK_LOG}" "${head}" "${nth}" << 'EOF'
import json, sys
path, since, head, nth = sys.argv[1], int(sys.argv[2]), sys.argv[3], int(sys.argv[4])
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
if len(found) < nth:
    sys.exit(4)
sys.stdout.write(found[nth - 1])
EOF
)" || rc=$?
    case "${rc}" in
        0) printf '%s' "${out}" ;;
        3) fail "server.log's kill try ${n} line for ${id} carries no JSON-quoted description after '${head}'" ;;
        4) fail "server.log holds no kill try ${n} line for ${id} answering ErrTmuxKillFailed (occurrence ${nth}) after the leg's mark: '${head}'" ;;
        *) fail "could not read the kill try ${n} line for ${id} (python3 exited ${rc})" ;;
    esac
}

# t14_check_try_descriptions <id> <nth> <step>: every try of the <nth>
# kill-retry of <id> answered ErrTmuxKillFailed (its per-try line holds the
# outcome's fixed part) with a description carrying agent-director's
# kill-failure words; set LAST_DESCRIPTION to the last try's.
t14_check_try_descriptions() {
    local id="$1" nth="$2" step="$3" n desc
    for (( n = 1; n <= KILL_TRIES; n++ )); do
        desc="$(t14_try_description "${id}" "${n}" "${nth}")" || exit 1
        [[ "${desc}" == *"${PHRASE_RETRY}"* && "${desc}" == *"${PHRASE_NEVER_DELETE}"* ]] \
            || fail "${step}: try ${n}'s description lacks '${PHRASE_RETRY}' or '${PHRASE_NEVER_DELETE}': ${desc}"
        echo "${TEST_NAME}: ${step}: kill try ${n} of ${KILL_TRIES} for ${id}: ErrTmuxKillFailed: ${desc}"
        LAST_DESCRIPTION="${desc}"
    done
}

# t14_end_matcher <id>: the bounded retry's end line for <id>'s tries ended
# exhausted with the ordinary alert decided.
t14_end_matcher() {
    local head tail
    t14_value head killRetryEndLine.head "$1"
    t14_value tail killRetryEndLine.tail "$1"
    matcher "${head}" "${tail}"
}

# t14_posts_after <line>: the Slack stub's chat.postMessage records after <line>, one JSON per line.
t14_posts_after() {
    t14_after "${STUB_RECORD}" "$1" | jq -c 'select(.event == "api" and .method == "chat.postMessage")'
}

# t14_count_posts <line> <channel> <text>: posts after <line> at <channel>
# (any channel when empty) whose text is <text> exactly.
t14_count_posts() {
    t14_posts_after "$1" | jq -s --arg c "$2" --arg t "$3" '[.[] | select(($c == "" or .channel == $c) and .text == $t)] | length'
}

# t14_count_posts_holding <line> <fragment>: posts after <line> whose text holds <fragment>.
t14_count_posts_holding() {
    t14_posts_after "$1" | jq -s --arg f "$2" '[.[] | select((.text // "") | contains($f))] | length'
}

t14_post_arrived() {
    (( $(t14_count_posts "$1" "$2" "$3") >= 1 ))
}

# t14_no_new_post_hold <line> <count> <channel> <hold-s> <step>: for <hold-s>
# seconds, the posts at <channel> after <line> stay <count>.
t14_no_new_post_hold() {
    local since="$1" want="$2" channel="$3" hold="$4" step="$5" deadline got
    deadline=$(( $(date +%s) + hold ))
    while :; do
        got="$(t14_posts_after "${since}" | jq -s --arg c "${channel}" '[.[] | select(.channel == $c)] | length')"
        [[ "${got}" == "${want}" ]] || fail "${step}: ${got} post(s) at ${channel} after the leg's mark, not ${want}"
        (( $(date +%s) < deadline )) || return 0
        sleep "${SCENARIO_POLL_S}"
    done
}

# t14_note_posts <line> <channel> <step>: log every post at <channel> after
# <line> (an outcome the SRD leaves open beside the checked alert).
t14_note_posts() {
    local text
    while IFS= read -r text; do
        echo "${TEST_NAME}: NOTE: ${3}: a post at ${2}: ${text}"
    done < <(t14_posts_after "$1" | jq -r --arg c "$2" 'select(.channel == $c) | .text | gsub("\n"; " ")')
}

# t14_note_calls_before <time-from> <time-to> <id> <step>: log how many CSCB
# calls of each verb named <id> between the two times (the calls a site made
# before its first kill; the SRD leaves their shape open).
t14_note_calls_before() {
    local out summary
    out="$(t14_cscb_calls_since "$1" "" "$3")" || exit 1
    summary="$(awk -F'\t' -v b="$2" '
        $2 + 0 < b + 0 {
            n = split($6, w, " ")
            for (i = 1; i <= n; i++) {
                if (w[i] == "--store-path" || w[i] == "--home" || w[i] == "--tmux-command") { i++; continue }
                c[w[i]]++
                break
            }
        }
        END { for (v in c) printf "%s=%d\n", v, c[v] }' <<< "${out}" | sort | tr '\n' ' ')"
    echo "${TEST_NAME}: NOTE: ${4}: CSCB calls of ${3} before its first kill: ${summary:-none}"
}

# t14_start_and_wait <persona-count>: a live start, and its start pass
# completing (its own completion line: server.log is appended across starts).
t14_start_and_wait() {
    local m before
    m="$(completion_match "$1")" || exit 1
    before="$(count_log "${m}")"
    start_server --live
    wait_for_count "${m}" "$(( before + 1 ))" "${START_WAIT_S}" "the start pass never completed"
}

# t14_no_unresponsive_post <key> <step>: no post after the leg's mark holds
# the persona's `tmux-unresponsive` onset (ErrTmuxKillFailed starts no such
# condition, SRJ-307).
t14_no_unresponsive_post() {
    local onset n
    t14_value onset tmuxUnresponsiveOnsetText "$1"
    n="$(t14_count_posts_holding "${MARK_RECORD}" "${onset}")"
    [[ "${n}" == 0 ]] || fail "$2: ${n} tmux-unresponsive onset post(s) for $1"
}

# t14_no_launch_since <time> <id> <step>: no CSCB spawn or resume of <id>,
# and no CSCB delete at all, at or after <time>.
t14_no_launch_since() {
    local verb n
    for verb in spawn resume; do
        n="$(t14_cscb_count_since "$1" "${verb}" "$2")"
        [[ "${n}" == 0 ]] || fail "$3: ${n} CSCB ${verb} call(s) of $2 after its first failed kill"
    done
    n="$(t14_cscb_count_since "$1" delete "")"
    [[ "${n}" == 0 ]] || fail "$3: ${n} CSCB delete call(s) after the first failed kill"
}

# ---------------------------------------------------------------------------
# Leg 1: the start sweep
# ---------------------------------------------------------------------------

leg_start_sweep() {
    local step="start sweep" session entry_head alert m n kills
    stub_mode "${X_WORK}" "${STUB_MODE_DEV_CHANNELS}"
    tmux_shim_mode log
    t14_config_for_next_start "$(t14_persona_json "${X_NAME}" "${X_LABEL}" "${X_WORK}" "${X_CFG}" "${X_CHANNEL}")"
    t14_start_and_wait 1
    wait_until "${ROW_WAIT_S}" "${step}: ${X_ID} never reported in (waiting)" t14_row_is "${X_ID}" waiting
    t14_row_get "${X_ID}"
    session="$(jq -r '.tmux_session_name // empty' "${AD_OUT}")"
    [[ -n "${session}" ]] || fail "${step}: ${X_ID}'s row names no tmux session"

    # A plain stop: the worker keeps running and the row stays live.
    stop_server
    t14_row_is "${X_ID}" waiting || fail "${step}: ${X_ID} reads '$(t14_row_state "${X_ID}")' after the plain stop, not waiting"

    t14_mark
    t14_config_for_next_start
    tmux_shim_mode fail-kill
    start_server --live
    m="$(matcher "] [${ORPHAN_LABEL}] " "instanceId=${X_ID} ")"
    wait_until "${KILL_WAIT_S}" "${step}: no ${ORPHAN_LABEL} entry for ${X_ID} after the start" \
        t14_count_after_at_least "${SLACK_STATE_DIR}/startup-errors.log" "${MARK_ERRORS}" "${m}" 1

    # Every try answered ErrTmuxKillFailed with agent-director's words.
    t14_check_try_descriptions "${X_ID}" 1 "${step}"
    kills="$(t14_cscb_count_since "${MARK_TIME}" kill "${X_ID}")"
    [[ "${kills}" == "${KILL_TRIES}" ]] || fail "${step}: ${kills} CSCB kill(s) of ${X_ID}, not ${KILL_TRIES}"

    # One orphan-cleanup entry for X: its row, state, session and outcome,
    # then the alert's ordinary version in its start-sweep form.
    t14_value entry_head startSweepKillFailedEntry "${X_ID}" "${X_KEY}" waiting "${session}" "${LAST_DESCRIPTION}"
    t14_value alert killFailureAlertEntryText.start-sweep "${X_ID}" "${session}" "${LAST_DESCRIPTION}"
    n="$(t14_count_after "${SLACK_STATE_DIR}/startup-errors.log" "${MARK_ERRORS}" "${m}")"
    [[ "${n}" == 1 ]] || fail "${step}: ${n} ${ORPHAN_LABEL} entries for ${X_ID}, not 1"
    n="$(t14_count_after "${SLACK_STATE_DIR}/startup-errors.log" "${MARK_ERRORS}" "$(matcher "] [${ORPHAN_LABEL}] ${entry_head}" "${alert}")")"
    if [[ "${n}" != 1 ]]; then
        t14_after "${SLACK_STATE_DIR}/startup-errors.log" "${MARK_ERRORS}" | sed 's/^/  | /' >&2
        echo "  | expected: [${ORPHAN_LABEL}] ${entry_head} … ${alert}" >&2
        fail "${step}: the ${ORPHAN_LABEL} entry for ${X_ID} is not the head and the start-sweep alert the printer renders"
    fi
    # Its server-log line (the entry's writer writes it to the server's stderr).
    n="$(t14_count_after "${SLACK_STATE_DIR}/server.log" "${MARK_LOG}" "$(matcher "[${ORPHAN_LABEL}] ${entry_head}" "${alert}")")"
    [[ "${n}" == 1 ]] || fail "${step}: ${n} server-log line(s) of X's ${ORPHAN_LABEL} entry, not 1"

    # No delete, no launch; the row kept, still live.
    t14_no_launch_since "${MARK_TIME}" "${X_ID}" "${step}"
    t14_row_is "${X_ID}" waiting || fail "${step}: ${X_ID} reads '$(t14_row_state "${X_ID}")' after the failed kill, not waiting"

    # Nothing about X reaches the Slack stub; no tmux-unresponsive post.
    n="$(t14_after "${STUB_RECORD}" "${MARK_RECORD}" \
        | jq -s --arg id "${X_ID}" --arg name "${X_NAME}" --arg c "${X_CHANNEL}" --arg l "${X_LABEL}" \
            '[.[] | select(.event == "api" and ((.channel // "") == $c or .label == $l or ((.text // "") | contains($id) or contains($name))))] | length')"
    [[ "${n}" == 0 ]] || fail "${step}: ${n} Slack stub record(s) about ${X_NAME} after the mark"
    t14_no_unresponsive_post "${X_KEY}" "${step}"

    tmux_shim_mode log
    stop_server
}

# ---------------------------------------------------------------------------
# Legs 2 and 3: a destination alert, then one further retry
# ---------------------------------------------------------------------------

# t14_check_destination_alert <name> <id> <channel> <session> <reason> <since> <step>:
# after server.log's line <since>, the row of <name> was found `pending` and
# not covered for <reason> (a `PENDING_ROW_REASON_*` export's name) and sent
# to the live-row sequence; after the first kill-retry of <id> since the
# mark: each try answered ErrTmuxKillFailed; exactly one ordinary alert at
# <channel>, as the printer renders it for the last try's description; one
# further retry's sequence kill fails the same way and no second alert
# follows; no CSCB delete, spawn or resume of <id> after the first failed
# kill; the row kept.
t14_check_destination_alert() {
    local name="$1" id="$2" channel="$3" session="$4" reason="$5" since="$6" step="$7" key end prefix body
    local expected first_kill expected_two n state uncovered
    key="$(persona_key "${name}")"
    end="$(t14_end_matcher "${id}")" || exit 1
    wait_until "${KILL_WAIT_S}" "${step}: ${id}'s kill tries never ended exhausted" \
        t14_count_after_at_least "${SLACK_STATE_DIR}/server.log" "${MARK_LOG}" "${end}" 1
    t14_value uncovered uncoveredPendingRowLine "${name}" "${reason}"
    n="$(t14_count_after "${SLACK_STATE_DIR}/server.log" "${since}" "${uncovered}")"
    (( n >= 1 )) || fail "${step}: server.log never said ${id}'s pending row is not covered (${reason}) after line ${since}"
    t14_check_try_descriptions "${id}" 1 "${step}"
    first_kill="$(t14_first_call_time "${MARK_TIME}" kill "${id}")"
    [[ -n "${first_kill}" ]] || fail "${step}: no CSCB kill of ${id} after the mark"
    t14_note_calls_before "${MARK_TIME}" "${first_kill}" "${id}" "${step}"

    t14_value prefix formatPersonaNotice "${name}"
    t14_value body killFailureAlertText.destination "${id}" "${session}" "${LAST_DESCRIPTION}"
    expected="${prefix}${body}"
    wait_until "${POST_WAIT_S}" "${step}: no kill-failure alert for ${id} reached ${channel}" \
        t14_post_arrived "${MARK_RECORD}" "${channel}" "${expected}"

    # One further retry: its sequence's kill fails the same way.
    wait_until "${RETRY_WAIT_S}" "${step}: no further retry's kill tries for ${id} ended" \
        t14_count_after_at_least "${SLACK_STATE_DIR}/server.log" "${MARK_LOG}" "${end}" 2
    t14_check_try_descriptions "${id}" 2 "${step}: the further retry"
    t14_value body killFailureAlertText.destination "${id}" "${session}" "${LAST_DESCRIPTION}"
    expected_two="${prefix}${body}"
    t14_no_new_post_hold "${MARK_RECORD}" \
        "$(t14_posts_after "${MARK_RECORD}" | jq -s --arg c "${channel}" '[.[] | select(.channel == $c)] | length')" \
        "${channel}" "${NO_SECOND_ALERT_HOLD_S}" "${step}: after the further retry"

    # Exactly one alert, at the destination only.
    n="$(t14_count_posts "${MARK_RECORD}" "" "${expected}")"
    if [[ "${expected_two}" != "${expected}" ]]; then
        n=$(( n + $(t14_count_posts "${MARK_RECORD}" "" "${expected_two}") ))
    fi
    [[ "${n}" == 1 ]] || fail "${step}: ${n} kill-failure alert post(s) for ${id}, not 1"
    [[ "$(t14_count_posts "${MARK_RECORD}" "${channel}" "${expected}")" == 1 ]] \
        || fail "${step}: the kill-failure alert for ${id} is not at its destination ${channel}"
    t14_note_posts "${MARK_RECORD}" "${channel}" "${step}"
    t14_no_unresponsive_post "${key}" "${step}"

    # No delete and no launch after the first failed kill; the row kept.
    t14_no_launch_since "${first_kill}" "${id}" "${step}"
    state="$(t14_row_state "${id}")"
    [[ -n "${state}" ]] || fail "${step}: ${id}'s row is gone: $(tr '\n' ' ' < "${AD_ERR}")"
    echo "${TEST_NAME}: ${step}: ${id}'s row is kept, reading ${state}"
}

# ---------------------------------------------------------------------------
# Leg 2: a config_dir mismatch at the ladder's pending branch
# ---------------------------------------------------------------------------

leg_config_dir() {
    local step="config_dir mismatch" session
    stub_mode "${C_WORK}" "${STUB_MODE_SILENT}"
    tmux_shim_mode log
    t14_config_for_next_start "$(t14_persona_json "${C_NAME}" "${C_LABEL}" "${C_WORK}" "${C_CFG_LINK}" "${C_CHANNEL}")"
    t14_start_and_wait 1
    wait_until "${ROW_WAIT_S}" "${step}: ${C_ID} never read pending with a launch start" \
        t14_row_pending_launched "${C_ID}"
    t14_row_get "${C_ID}"
    session="$(jq -r '.tmux_session_name // empty' "${AD_OUT}")"
    [[ -n "${session}" ]] || fail "${step}: ${C_ID}'s row names no tmux session"
    echo "${TEST_NAME}: ${step}: ${C_ID}'s row before the re-point: $(jq -c '{state, cwd, labels}' "${AD_OUT}")"

    # A plain stop; the worker keeps running and the row stays pending.
    stop_server
    t14_row_pending_launched "${C_ID}" || fail "${step}: ${C_ID} reads '$(t14_row_state "${C_ID}")' after the plain stop, not pending with a launch start"

    t14_mark
    repoint_symlink "${C_CFG_LINK}" "${C_CFG_TWO}"
    tmux_shim_mode fail-kill
    start_server --live
    t14_check_destination_alert "${C_NAME}" "${C_ID}" "${C_CHANNEL}" "${session}" \
        PENDING_ROW_REASON_CONFIG_DIR_MISMATCH "${MARK_LOG}" "${step}"

    tmux_shim_mode log
    stop_server
}

# ---------------------------------------------------------------------------
# Leg 3: a cwd mismatch met by a pending-only retry on a running server
# ---------------------------------------------------------------------------

# t14_seconds_since <rfc3339>: print the whole seconds from <rfc3339> to now.
t14_seconds_since() {
    local then
    then="$(date -d "$1" +%s)" || fail "could not read the time '$1'"
    echo $(( $(date +%s) - then ))
}

leg_cwd() {
    local step="cwd mismatch" session launch age repoint_log uncovered n
    stub_mode "${W_ONE}" "${STUB_MODE_SILENT}"
    tmux_shim_mode log
    t14_config_for_next_start "$(t14_persona_json "${W_NAME}" "${W_LABEL}" "${W_LINK}" "${W_CFG}" "${W_CHANNEL}")"
    t14_mark
    t14_start_and_wait 1
    wait_until "${ROW_WAIT_S}" "${step}: ${W_ID} never read pending with a launch start" \
        t14_row_pending_launched "${W_ID}"
    launch="$(jq -r '.launch_started_at' "${AD_OUT}")"

    # Before the first pending-only retry: `fail-kill`, then the re-point.
    tmux_shim_mode fail-kill
    repoint_log="$(t14_lines "${SLACK_STATE_DIR}/server.log")"
    repoint_symlink "${W_LINK}" "${W_TWO}"
    # The start launched W on a covered row: nothing found it not covered before the re-point.
    t14_value uncovered uncoveredPendingRowLine "${W_NAME}" PENDING_ROW_REASON_CWD_MISMATCH
    sed -n "$(( MARK_LOG + 1 )),${repoint_log}p" "${SLACK_STATE_DIR}/server.log" > "${SCENARIO_ROOT}/before-repoint.log"
    n="$(count_in "${SCENARIO_ROOT}/before-repoint.log" "${uncovered}")"
    [[ "${n}" == 0 ]] || fail "${step}: ${W_ID}'s pending row was found not covered before the re-point"
    age="$(t14_seconds_since "${launch}")"
    (( age <= REPOINT_BEFORE_S )) \
        || fail "${step}: the symlink was re-pointed ${age} s after ${W_ID}'s launch start, not within ${REPOINT_BEFORE_S} s (before its first retry)"
    t14_row_get "${W_ID}"
    session="$(jq -r '.tmux_session_name // empty' "${AD_OUT}")"
    [[ -n "${session}" ]] || fail "${step}: ${W_ID}'s row names no tmux session"
    echo "${TEST_NAME}: ${step}: ${W_ID}'s row at the re-point: $(jq -c '{state, cwd}' "${AD_OUT}")"
    [[ "$(jq -r '.cwd // empty' "${AD_OUT}")" == "$(realpath -e -- "${W_ONE}")" ]] \
        || fail "${step}: ${W_ID}'s row records cwd '$(jq -r '.cwd // empty' "${AD_OUT}")', not ${W_ONE}'s real path"

    t14_check_destination_alert "${W_NAME}" "${W_ID}" "${W_CHANNEL}" "${session}" \
        PENDING_ROW_REASON_CWD_MISMATCH "${repoint_log}" "${step}"
    # No start ran after the re-point: a retry of W's timer met the mismatch.
    n="$(t14_count_after "${SLACK_STATE_DIR}/server.log" "${repoint_log}" "$(completion_match 1)")"
    [[ "${n}" == 0 ]] || fail "${step}: a start pass completed after the re-point"

    tmux_shim_mode log
    stop_server
}

leg_start_sweep
leg_config_dir
leg_cwd

# The closing assertions (b.jg5 SRJ-1401, SRJ-1418).
assert_no_server_tmux
assert_no_cscb_include_finished
assert_no_cscb_delete

echo "${TEST_NAME}: PASS"
