#!/usr/bin/env bash
# Test 14 (HO §7 scenarios 16, 2 and 15; b.jg5 SRJ-1403, SRJ-1417; AC 1,
# AC 24, AC 64): a kill that really fails. With the tmux shim in `fail-kill`,
# a live row's agent-director `kill` finds its worker still running after the
# kill exit wait and answers ErrTmuxKillFailed: at an upgrade's first start
# sweep over pre-persona rows (scenario 16), at the start sweep, at a
# `config_dir` mismatch and at a `cwd` mismatch (scenario 2), and at a
# persona removal's teardown (scenario 15). At each site no CSCB delete or
# launch follows, the row is kept, and one kill-failure alert quoting
# agent-director's description is routed per SRJ-704 (b.jg5 SRJ-704,
# SRJ-705, SRJ-707, SRJ-411, SRJ-513, SRJ-714, SRJ-715, SRJ-801, SRJ-802,
# SRJ-803, SRJ-1002, SRJ-1003, SRJ-1007, SRJ-1013, SRJ-1014, SRJ-1020,
# SRJ-1401, SRJ-1418).
#
# fmk setup (lib/scenario.sh fmk mode; b.jg5 SRJ-1306, SRJ-1401):
# - its own HOME, agent-director store and tmux server, all under
#   SCENARIO_ROOT, with the agent-director shim in front of the binary and the
#   tmux shim first on the PATH of every CSCB process (the bot server, `start`
#   and `stop` runs), which agent-director inherits;
# - the 0.10.0 start (SCENARIO_AD_START=0.10.0: 0.10.0's binary behind the
#   shim, no store); scenario 16's rows seeded on it from the scenario's own
#   shell (`seed_prepersona_fleet`, `seed_010_row`: 0.10.0's own `spawn`,
#   which makes the store); then the release's install.sh over it
#   (`install_ad_release`, which migrates the store, re-shims both paths and
#   checks the shims), after which every leg runs on the release;
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
#   legs 0 and 4 limit `fail-kill` to one row's session name, session id and
#   pane id (`tmux_shim_mode fail-kill --targets`, a harness addition), so every other kill runs the real tmux;
# - the stub worker's mode per working directory (`stub_mode`): the start
#   sweep's persona reports in (`dev-channels`, the approver's Enter), the
#   `config_dir` and `cwd` personas never do (`silent`), so their rows stay
#   `pending` with a launch start; the removed persona reports in
#   (`dev-channels`); of the 0.10.0 rows, P's never reports in (`silent`) and
#   the others report in at once (`at-once`, `seed_010_row`'s default);
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
#   (`repoint_symlink`, a harness addition) is
#   the working default that makes a real `cwd` or `config_dir` mismatch with
#   no config edit: agent-director's spawn records the real `cwd`, CSCB writes
#   the `config_dir` label by real path, and `compareRowToPersona` resolves the
#   persona's directories by real path at every comparison. Setup checks its
#   refusals (a link or target outside SCENARIO_ROOT, a link that is not a
#   symlink, a missing target), each leaving the link as it was.
#
# Legs, in run order (each a function `leg_<name>`):
#   0. upgrade_sweep (scenario 16; SRJ-1417, SRJ-714) seeded on 0.10.0
#                   before the install: two pre-persona rows (A and B: a
#                   `channel` label, no `persona` label, named as the
#                   pre-persona package names them, workers reporting in at
#                   once); P's own row (`cscb_<P key>`, its `persona` label,
#                   in a directory other than P's configured one, its worker
#                   `silent`), which after the migration reads `pending` with
#                   no launch start (SRJ-513, SRJ-1020); and absent persona
#                   Q's live row. config.json names P (a Slack destination)
#                   and not Q; `fail-kill` is limited to A's session and pane
#                   (a guard only: the release sends no kill for a 0.10.0
#                   launch's session, which carries no label it reads, and
#                   answers ErrTmuxKillFailed with none sent, HO rev 31 §2
#                   (a), so the target list does not decide A's outcome; how
#                   many kills aimed at A's targets reached the tmux shim is
#                   logged); a start; once the start sweep's summary line is
#                   logged, `log`. Then the summary's counts (4 listed, 1
#                   recorded as retired, 1 left for a latch, and every live
#                   stray not killed kept with its kill failed); the pass's
#                   retry budget (SRJ-702, AC 56), with A, B and Q in the
#                   order CSCB first killed them (agent-director's `list`
#                   order is not assumed): the first whose kill failed made
#                   exactly KILL_RETRY_TRIES CSCB kills, each later one
#                   exactly 1, and one whose kill succeeded before it is
#                   logged; A's kill: each of its tries answered
#                   ErrTmuxKillFailed, its session still there, exactly one
#                   `orphan-cleanup` entry naming A (the pre-persona row's
#                   head, then the alert's ordinary version in its start-sweep
#                   form) and one server-log line of it; B's and Q's kills
#                   each either succeeded (the sweep's per-row line, no entry,
#                   the session gone) or did not (exactly one entry, the
#                   session still there), which is logged; P latched from its
#                   own listed row, no CSCB
#                   kill of P's row, and exactly one launch-start-not-recorded
#                   post at P's destination; Q's key in the retired-key record
#                   with cause `absent-at-start`; no CSCB delete; every seeded
#                   row present (harness `get`); every running stub worker in
#                   a session a row of the harness's `list` records, and at
#                   least A's and P's workers found running; nothing
#                   about A in the Slack stub's record. A plain stop; then the
#                   harness plays the human acting on the alerts ("Operator
#                   actions"): it ends each old worker's session by its
#                   session id and runs `find-missing` until A's, B's, Q's
#                   and P's rows read finished, so no later start sweeps them
#                   live and spends a later pass's retry budget (leg 1's X
#                   keeps its KILL_RETRY_TRIES tries).
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
#                   stub, no `tmux-unresponsive` post is made and no
#                   `tmux-unresponsive` condition starts, for X or any
#                   persona (no started line in server.log: a start-sweep
#                   kill and ErrTmuxKillFailed never start one, SRJ-307, and
#                   no persona is configured).
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
#                   no second alert (no post of any text at C's destination
#                   during the hold after it, NO_SECOND_ALERT_HOLD_S below,
#                   and the same count of posts there just before the leg's
#                   stop); after the first failed try no CSCB
#                   delete, spawn or resume of C's id; C's row present; no
#                   `tmux-unresponsive` post and no `tmux-unresponsive`
#                   started line for C's key.
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
#   4. persona_removal (scenario 15; SRJ-1417, SRJ-715, SRJ-1003, SRJ-803)
#                   persona R (Slack destination, `dev-channels`) is up, its
#                   row `waiting`. `fail-kill` limited to R's session and
#                   pane; the operator removes R from config.json and
#                   confirms the apply by renaming the pending file to the
#                   apply file (README "Reload"). R's teardown kill: each of
#                   its KILL_RETRY_TRIES tries answered ErrTmuxKillFailed, its
#                   tries ended exhausted; exactly one `persona-teardown-notice`
#                   entry naming R, "raised during its teardown", carrying the
#                   alert's ordinary version with the log-only closing
#                   sentence, and one server-log line of it; no CSCB delete;
#                   R's row present; R's key in the retired-key record with
#                   cause `removed`; nothing about R in the Slack stub's
#                   record after the edit, and no `tmux-unresponsive` post
#                   and no `tmux-unresponsive` started line for R's key.
#                   `log`; a plain stop.
#   Rows a leg keeps are swept again by a later start (leg 1's first start,
#   in `log`, sweeps P's row, P being absent then), so every check reads
#   only its own ids and window.
#   The `resume_enabled=false` site is not driven here: SRJ-1403 leaves it,
#   with `ErrSpawnNotResumable` with dead evidence, to SRJ-110's unit test
#   (dead evidence means the session is gone, so agent-director's kill sends
#   no kill for the shim to fail; dead-evidence rule).
#
# Waits: each leg's kills are waited for by their lines, bounded at
# KILL_WAIT_S (3 tries of up to the 5000 ms kill exit wait, 2 s apart, with
# their reads); a further retry by its line, bounded at RETRY_WAIT_S (the
# retry timer's next wait, 30 or 60 s, plus a kill's tries). No fixed sleep
# but the hold that checks no second alert follows: at least
# NO_SECOND_ALERT_HOLD_S, and at least twice the first alert's measured
# latency (from its kill tries' end line to its post, by their own times)
# plus NO_SECOND_ALERT_MARGIN_S.
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
#     src/persona-episodes.ts) and the condition's started line up to its
#     refusing verb (`tmuxUnresponsiveStartedLine`), for absence checks;
#   - instance ids (`personaInstanceId`, src/persona-identity.ts; each alert's
#     session is the one the row records, read with a harness `get`) and the
#     last-applied record's suffix (LAST_APPLIED_FILE_SUFFIX, src/reload.ts);
#   - legs 0 and 4: the `service` label and the `persona` label's key
#     (SERVICE_LABEL, PERSONA_LABEL_KEY) and a persona's session name
#     (`personaTmuxSessionName`), src/persona-identity.ts, for the 0.10.0 rows;
#     the start sweep's summary line and its fixed head
#     (`startSweepSummaryLine`), its per-row line for a kill whose success
#     stands (`startSweepKillSucceededLine`), its pre-persona `orphan-cleanup`
#     entry head (`startSweepKillFailedEntry`) and its line for a persona
#     latched from its own listed row (`startSweepLatchedFromOwnRowLine`, case
#     LATCH_CASE_LAUNCH_START_NOT_RECORDED), src/session-manager.ts; the
#     launch-start-not-recorded post's body (`launchStartNotRecordedNoticeText`,
#     src/conflict-latch.ts) after the notifier's prefix; the persona
#     teardown's class (PERSONA_TEARDOWN_NOTICE_LABEL) and its entry for the
#     alert (`personaTeardownNoticeEntryText`, src/persona-notifier.ts); the
#     retired-key record's path (`retiredKeysPath`) and the causes
#     RETIRED_KEY_CAUSE_REMOVED and RETIRED_KEY_CAUSE_ABSENT_AT_START,
#     src/retired-keys.ts (the record's `keys` and `cause` fields are its
#     format's, SRJ-802, which exports no field name); the pending and apply
#     files' suffixes (PENDING_FILE_SUFFIX, APPLY_FILE_SUFFIX, src/reload.ts).
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

# ---------------------------------------------------------------------------
# Scenario 16's rows, seeded on 0.10.0 before the release's install
# ---------------------------------------------------------------------------

t14_value SVC_LABEL SERVICE_LABEL
t14_value PERSONA_LABEL PERSONA_LABEL_KEY

# Two pre-persona rows (a `channel` label, no `persona` label), each with a
# worker that reports in at once. A's session and pane are `fail-kill`'s only
# targets, and A's kill must fail; B's outcome is logged, not asserted. On the
# release no kill is sent for any 0.10.0-launched session (HO rev 31 §2 (a)),
# so the target list does not act here: each such kill answers
# ErrTmuxKillFailed with none sent. Their routes' channel names give their
# ids and session names (`seed_prepersona_fleet`).
U_CONFIG="${SCENARIO_ROOT}/prepersona-config.json"
UA_CHANNEL="C0T14PPA"
UB_CHANNEL="C0T14PPB"
UA_WORK="$(make_workdir "${SCENARIO_TAG}prepersona_a")"
UB_WORK="$(make_workdir "${SCENARIO_TAG}prepersona_b")"
jq -n --arg a "${UA_CHANNEL}" --arg b "${UB_CHANNEL}" --arg da "${UA_WORK}" --arg db "${UB_WORK}" \
    '{routes: {($a): {cwd: $da}, ($b): {cwd: $db}}}' > "${U_CONFIG}" || fail "setup: could not write ${U_CONFIG}"
U_ROWS="$(seed_prepersona_fleet "${U_CONFIG}" "${UA_CHANNEL}=${SCENARIO_TAG} fails" "${UB_CHANNEL}=${SCENARIO_TAG} ends")"
read -r _ UA_ID UA_SESSION UA_SID UA_PANE <<< "$(grep "^${UA_CHANNEL} " <<< "${U_ROWS}")"
read -r _ UB_ID UB_SESSION _ _ <<< "$(grep "^${UB_CHANNEL} " <<< "${U_ROWS}")"
[[ -n "${UA_PANE:-}" && -n "${UB_SESSION:-}" ]] || fail "setup: seed_prepersona_fleet printed '${U_ROWS}'"

# P, which the configuration names: its own row (`cscb_<key>`, its `persona`
# label) in a working directory other than P's configured one, with a worker
# that never reports in, so after the migration it reads `pending` with no
# launch start (b.jg5 SRJ-513, SRJ-1020).
P_NAME="${SCENARIO_TAG}latched"
P_KEY="$(persona_key "${P_NAME}")"
t14_value P_ID personaInstanceId "${P_KEY}"
t14_value P_SESSION personaTmuxSessionName "${P_KEY}"
P_WORK="$(make_workdir "${SCENARIO_TAG}latched_work")"
P_ROW_WORK="$(make_workdir "${SCENARIO_TAG}latched_row")"
stub_mode "${P_ROW_WORK}" "${STUB_MODE_SILENT}"
seed_010_row "${P_ID}" "${P_SESSION}" "${P_ROW_WORK}" "${SVC_LABEL}" "${PERSONA_LABEL}=${P_KEY}" > /dev/null

# Q, which the configuration does not name: its live row, its worker
# reporting in at once.
Q_NAME="${SCENARIO_TAG}absent"
Q_KEY="$(persona_key "${Q_NAME}")"
t14_value Q_ID personaInstanceId "${Q_KEY}"
t14_value Q_SESSION personaTmuxSessionName "${Q_KEY}"
Q_WORK="$(make_workdir "${SCENARIO_TAG}absent_work")"
seed_010_row "${Q_ID}" "${Q_SESSION}" "${Q_WORK}" "${SVC_LABEL}" "${PERSONA_LABEL}=${Q_KEY}" > /dev/null

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
# How long no second alert may follow a further retry's failed kill: at
# least this, and at least twice the first alert's measured latency plus
# NO_SECOND_ALERT_MARGIN_S.
NO_SECOND_ALERT_HOLD_S=5
NO_SECOND_ALERT_MARGIN_S=5
# The Slack stub writing its ready file.
STUB_WAIT_S=30
# A stub process in no tmux pane ending (a short-lived run outside tmux).
WORKER_GONE_S=10
# Before the first pending-only retry (30 s after the launch, SRJ-302) the
# `cwd` symlink must be re-pointed: at most this many seconds after the launch
# start.
REPOINT_BEFORE_S=25

# A reload's preview reaching the pending file after a config.json edit (the
# reload tick runs 5 s after the previous pass).
RELOAD_WAIT_S=60

# ---------------------------------------------------------------------------
# More values from the installed package
# ---------------------------------------------------------------------------

t14_value KILL_TRIES KILL_RETRY_TRIES
t14_value PHRASE_RETRY RETRY_KILL_LATER_PHRASE
t14_value PHRASE_NEVER_DELETE NEVER_DELETE_ROW_PHRASE
t14_value ORPHAN_LABEL ORPHAN_CLEANUP_LABEL
t14_value LAST_APPLIED_SUFFIX LAST_APPLIED_FILE_SUFFIX
[[ "${KILL_TRIES}" =~ ^[1-9][0-9]*$ ]] || fail "setup: KILL_RETRY_TRIES '${KILL_TRIES}' is not a whole number"
t14_value PENDING_SUFFIX PENDING_FILE_SUFFIX
t14_value APPLY_SUFFIX APPLY_FILE_SUFFIX
t14_value TEARDOWN_LABEL PERSONA_TEARDOWN_NOTICE_LABEL
t14_value CAUSE_REMOVED RETIRED_KEY_CAUSE_REMOVED
t14_value CAUSE_ABSENT RETIRED_KEY_CAUSE_ABSENT_AT_START
t14_value SUMMARY_HEAD startSweepSummaryLine.head

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

# Scenario 16: P's configuration (its key, row and working directories are
# above, with the 0.10.0 seeding).
P_LABEL="${SCENARIO_TAG}latched1"
P_CHANNEL="C0T14LAT1"
P_CFG="${CFG_ROOT}/${SCENARIO_TAG}latched_cfg"

# Scenario 15, the persona removal: R.
R_NAME="${SCENARIO_TAG}removed"
R_LABEL="${SCENARIO_TAG}removed1"
R_CHANNEL="C0T14REM1"
R_WORK="$(make_workdir "${SCENARIO_TAG}removed_work")"
R_CFG="${CFG_ROOT}/${SCENARIO_TAG}removed_cfg"
R_KEY="$(persona_key "${R_NAME}")"
t14_value R_ID personaInstanceId "${R_KEY}"

mkdir -p "${X_CFG}" "${C_CFG_ONE}" "${C_CFG_TWO}" "${W_CFG}" "${P_CFG}" "${R_CFG}"
ln -s -- "${C_CFG_ONE}" "${C_CFG_LINK}"
ln -s -- "${W_ONE}" "${W_LINK}"

# repoint_symlink's refusals (a harness addition), each in a subshell: it fails, saying why, and changes nothing.
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

for t14_label in "${X_LABEL}" "${C_LABEL}" "${W_LABEL}" "${P_LABEL}" "${R_LABEL}"; do
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

# t14_write_config [<persona-json>...]: the operator's edit of config.json:
# it holds these personas.
t14_write_config() {
    local joined="" entry
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
}

# t14_config_for_next_start [<persona-json>...]: the operator's edit while the
# server is stopped: config.json holds these personas, and the last-applied
# record is moved aside, so the next start applies config.json as it stands.
t14_config_for_next_start() {
    local record
    t14_write_config "$@"
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
python3 - "${X_LABEL}" "${C_LABEL}" "${W_LABEL}" "${P_LABEL}" "${R_LABEL}" << 'EOF' | write_file "${STUB_DIR}/control.json"
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

# t14_try_description <id> <try> <nth> [<max>]: print agent-director's
# description of try <try> (of <max>, KILL_RETRY_TRIES when not given) of the
# <nth> kill-retry of <id> logged after the leg's mark, JSON-decoded from its
# per-try line; fail when there is none.
t14_try_description() {
    local id="$1" n="$2" nth="$3" max="${4:-${KILL_TRIES}}" head out rc=0
    t14_value head killRetryTryLine.description-head-of "${id}" "${n}" "${max}"
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

# t14_records_after <line>: the Slack stub's records after <line>, one JSON
# per line. The stub may be writing its last line: a line that does not
# parse (torn) is skipped, so a read never ends the script without a FAIL
# line; a later read finds it whole.
t14_records_after() {
    t14_after "${STUB_RECORD}" "$1" | jq -R -c 'fromjson? // empty'
}

# t14_posts_after <line>: the Slack stub's chat.postMessage records after <line>, one JSON per line.
t14_posts_after() {
    t14_records_after "$1" | jq -c 'select(.event == "api" and .method == "chat.postMessage")'
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
        got="$(t14_count_channel_posts "${since}" "${channel}")"
        [[ "${got}" == "${want}" ]] || fail "${step}: ${got} post(s) at ${channel} after the leg's mark, not ${want}"
        (( $(date +%s) < deadline )) || return 0
        sleep "${SCENARIO_POLL_S}"
    done
}

# t14_count_channel_posts <line> <channel>: every post at <channel> after
# <line>, whatever its text.
t14_count_channel_posts() {
    t14_posts_after "$1" | jq -s --arg c "$2" '[.[] | select(.channel == $c)] | length'
}

# t14_epoch <iso-time>: print the time as seconds since the epoch, with
# milliseconds.
t14_epoch() {
    date -u -d "$1" +%s.%3N || fail "could not read the time '$1'"
}

# t14_alert_latency <id> <channel> <text> <step>: print the seconds from the
# first end line of <id>'s kill tries after the leg's mark (server.log's own
# time) to the first post of <text> at <channel> after it (the Slack stub's
# record time), never below 0.
t14_alert_latency() {
    local id="$1" channel="$2" text="$3" step="$4" head line iso end_t post_iso post_t
    t14_value head killRetryEndLine.head "${id}"
    line="$(t14_after "${SLACK_STATE_DIR}/server.log" "${MARK_LOG}" | grep -F -m 1 -- "${head}" || true)"
    [[ "${line}" == \[* ]] || fail "${step}: no timed end line of ${id}'s kill tries after the mark: '${line:0:200}'"
    iso="${line#\[}"
    iso="${iso%%\]*}"
    end_t="$(t14_epoch "${iso}")" || exit 1
    post_iso="$(t14_posts_after "${MARK_RECORD}" | jq -r -s --arg c "${channel}" --arg t "${text}" \
        '[.[] | select(.channel == $c and .text == $t)] | if length == 0 then "" else .[0].ts end')"
    [[ -n "${post_iso}" ]] || fail "${step}: no post of the kill-failure alert for ${id} at ${channel} to time"
    post_t="$(t14_epoch "${post_iso}")" || exit 1
    awk -v a="${post_t}" -v b="${end_t}" 'BEGIN { d = a - b; if (d < 0) d = 0; printf "%.3f", d }'
}

# t14_recount_before_stop <step>: just before the leg's stop, the posts at the
# destination the no-second-alert hold watched are still the count it held.
t14_recount_before_stop() {
    local n
    n="$(t14_count_channel_posts "${MARK_RECORD}" "${T14_HOLD_CHANNEL}")"
    [[ "${n}" == "${T14_HOLD_COUNT}" ]] \
        || { t14_note_posts "${MARK_RECORD}" "${T14_HOLD_CHANNEL}" "$1"; fail "$1: ${n} post(s) at ${T14_HOLD_CHANNEL} after the leg's mark just before the stop, not the ${T14_HOLD_COUNT} the hold ended with"; }
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

# t14_no_unresponsive <key> <step>: the persona's `tmux-unresponsive`
# condition never started after the leg's mark: no server.log line after the
# mark holds its started line up to the refusing verb (the line the condition
# logs at its first refusal), and no post after the mark holds its onset
# (ErrTmuxKillFailed starts no such condition and makes no such post,
# SRJ-307). The started line is what makes this check able to fail within a
# leg: no leg lasts the alert threshold past a first refusal, so a post alone
# could never be seen.
t14_no_unresponsive() {
    local onset head n
    t14_value head tmuxUnresponsiveStartedLine.head "$1"
    n="$(t14_count_after "${SLACK_STATE_DIR}/server.log" "${MARK_LOG}" "${head}")"
    if [[ "${n}" != 0 ]]; then
        t14_after "${SLACK_STATE_DIR}/server.log" "${MARK_LOG}" | grep -F -- "${head}" | sed 's/^/  | /' >&2 || true
        fail "$2: ${n} tmux-unresponsive started line(s) for $1 after the leg's mark"
    fi
    t14_value onset tmuxUnresponsiveOnsetText "$1"
    n="$(t14_count_posts_holding "${MARK_RECORD}" "${onset}")"
    [[ "${n}" == 0 ]] || fail "$2: ${n} tmux-unresponsive onset post(s) for $1"
}

# t14_no_unresponsive_any <key> <step>: as `t14_no_unresponsive` for <key>,
# and no server.log line after the leg's mark is any persona's
# `tmux-unresponsive` started line (the started line's head with the key
# left open).
t14_no_unresponsive_any() {
    local head n
    t14_no_unresponsive "$1" "$2"
    t14_value head tmuxUnresponsiveStartedLine.head "$1"
    [[ "${head}" == *"$1"* ]] || fail "$2: the tmux-unresponsive started line's head does not name the key $1: ${head}"
    n="$(t14_count_after "${SLACK_STATE_DIR}/server.log" "${MARK_LOG}" "$(matcher "${head%%"$1"*}" "${head#*"$1"}")")"
    if [[ "${n}" != 0 ]]; then
        t14_after "${SLACK_STATE_DIR}/server.log" "${MARK_LOG}" | grep -F -- "${head#*"$1"}" | sed 's/^/  | /' >&2 || true
        fail "$2: ${n} tmux-unresponsive started line(s) for some persona after the leg's mark"
    fi
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

# t14_count_entries <label> <fragment>...: the startup-errors entries of
# class <label> written after the leg's mark that hold every fragment.
t14_count_entries() {
    local label="$1"
    shift
    t14_count_after "${SLACK_STATE_DIR}/startup-errors.log" "${MARK_ERRORS}" "$(matcher "] [${label}] " "$@")"
}

# t14_retired_cause <key>: print the cause the retired-key record holds for
# <key> (nothing when the record or the key's entry is missing). The record's
# `keys` and `cause` fields are its format's (b.jg5 SRJ-802;
# src/retired-keys.ts serializeRetiredKeys, which exports no field name).
t14_retired_cause() {
    local path
    t14_value path retiredKeysPath "${SLACK_STATE_DIR}"
    [[ -f "${path}" ]] || return 0
    jq -r --arg k "$1" '.keys[$k].cause // empty' "${path}"
}

# t14_stub_workers: print each running stub worker process (a process whose
# argv holds the stub's path, ${SCENARIO_BIN}/claude) as `<pid> <session>`,
# <session> the scenario's tmux session whose pane runs it or its parent
# chain, `-` for none.
t14_stub_workers() {
    local panes="${SCENARIO_ROOT}/t14-panes.txt"
    "${SCENARIO_REAL_TMUX}" list-panes -a -F '#{pane_pid} #{session_name}' > "${panes}" 2> /dev/null || : > "${panes}"
    python3 - "${SCENARIO_BIN}/claude" "${panes}" << 'EOF'
import os, sys
stub = sys.argv[1].encode()
panes = {}
with open(sys.argv[2], encoding="utf-8") as f:
    for line in f:
        pid, _, session = line.rstrip("\n").partition(" ")
        if pid.isdigit():
            panes[int(pid)] = session
def stat(pid):
    try:
        with open(f"/proc/{pid}/stat", encoding="utf-8", errors="replace") as f:
            s = f.read()
        fields = s[s.rindex(")") + 2:].split()
        return fields[0], int(fields[1])
    except (OSError, ValueError, IndexError):
        return "", 0
for d in os.listdir("/proc"):
    if not d.isdigit():
        continue
    try:
        with open(f"/proc/{d}/cmdline", "rb") as f:
            argv = f.read().split(b"\0")
    except OSError:
        continue
    if stub not in argv:
        continue
    state, _ = stat(d)
    if state in ("", "Z", "X"):
        continue
    pid, session, seen = int(d), "-", 0
    while pid > 1 and seen < 64:
        if pid in panes:
            session = panes[pid]
            break
        pid = stat(pid)[1]
        seen += 1
    print(d, session)
EOF
}

# t14_proc_desc <pid>: print <pid>'s command line and its parent's (best
# effort: nothing for a process already gone).
t14_proc_desc() {
    local ppid=""
    { ppid="$(awk '{ print $4 }' "/proc/$1/stat")"; } 2> /dev/null || ppid=""
    printf 'argv: %s; parent %s: %s' \
        "$({ tr '\0' ' ' < "/proc/$1/cmdline"; } 2> /dev/null)" "${ppid:-?}" \
        "$({ [[ -n "${ppid}" ]] && tr '\0' ' ' < "/proc/${ppid}/cmdline"; } 2> /dev/null)"
}

# t14_proc_gone <pid>: true once <pid> is gone (or a zombie).
t14_proc_gone() {
    ! pid_alive "$1"
}

# t14_check_workers_have_rows <step> <min>: every running stub worker runs in
# a tmux session that a row of the harness's `list` records (no old worker is
# left running without a row), and at least <min> workers are found (the
# workers the leg knows run), so the check never passes on finding none. A
# stub process in no pane that ends within WORKER_GONE_S (a short-lived run
# of the stub outside tmux, such as a version probe) is no worker; one still
# running then fails, with its command line and its parent's.
t14_check_workers_have_rows() {
    local step="$1" min="$2" workers pid session what n=0
    workers="$(t14_stub_workers)" || fail "${step}: could not read the stub workers"
    ad_capture list
    [[ "${AD_RC}" == 0 ]] || fail "${step}: harness list exited ${AD_RC}: $(tr '\n' ' ' < "${AD_ERR}")"
    while read -r pid session; do
        [[ -n "${pid}" ]] || continue
        if [[ "${session}" == - ]]; then
            what="$(t14_proc_desc "${pid}")"
            if wait_until "${WORKER_GONE_S}" "${step}: stub process ${pid} runs in no tmux pane: ${what}" t14_proc_gone "${pid}"; then
                echo "${TEST_NAME}: NOTE: ${step}: stub process ${pid} (${what}), in no tmux pane, ended within ${WORKER_GONE_S} s"
                continue
            fi
        fi
        n=$(( n + 1 ))
        jq -e --arg s "${session}" 'any(.spawns[]; .tmux_session_name == $s)' "${AD_OUT}" > /dev/null \
            || fail "${step}: stub worker ${pid} runs in session ${session}, which no row of the harness's list records"
    done <<< "${workers}"
    (( n >= min )) || fail "${step}: ${n} stub worker(s) found running, fewer than the ${min} the leg knows run"
    echo "${TEST_NAME}: ${step}: ${n} stub worker(s) running (at least ${min} known), each in a session a listed row records"
}

# t14_session_ids <session>: print the session's id and its pane's id, `$N %N`,
# read with the real tmux from the scenario's own shell.
t14_session_ids() {
    "${SCENARIO_REAL_TMUX}" display-message -p -t "=$1:" '#{session_id} #{pane_id}'
}

# t14_has_session <session>: true when the scenario's tmux server holds it.
t14_has_session() {
    "${SCENARIO_REAL_TMUX}" has-session -t "=$1" 2> /dev/null
}

# t14_no_records_about <step> <fragment>...: no Slack stub record after the
# leg's mark holds any <fragment> in its text or names it as its channel.
t14_no_records_about() {
    local step="$1" n frags
    shift
    frags="$(printf '%s\n' "$@" | jq -R . | jq -s .)"
    n="$(t14_records_after "${MARK_RECORD}" \
        | jq -s --argjson f "${frags}" '[.[] | select(.event == "api" and (. as $r | any($f[]; . as $x | (($r.channel // "") == $x) or (($r.text // "") | contains($x)))))] | length')"
    [[ "${n}" == 0 ]] || fail "${step}: ${n} Slack stub record(s) about $* after the mark"
}

# t14_check_summary <step>: exactly one start-sweep summary line after the
# leg's mark, one the printer renders for four rows listed, <k> killed, the
# other 3 - <k> live strays kept with their kills failed (A's at least), one
# key recorded as retired and one row left for a latch; <k> is logged.
t14_check_summary() {
    local step="$1" k line n found=""
    n="$(t14_count_after "${SLACK_STATE_DIR}/server.log" "${MARK_LOG}" "${SUMMARY_HEAD}")"
    for (( k = 0; k <= 2; k++ )); do
        t14_value line startSweepSummaryLine 4 "${k}" "$(( 3 - k ))" "$(( 3 - k ))" 1 1
        if [[ "$(t14_count_after "${SLACK_STATE_DIR}/server.log" "${MARK_LOG}" "${line}")" == 1 ]]; then
            found="${line}"
        fi
    done
    if [[ "${n}" != 1 || -z "${found}" ]]; then
        t14_after "${SLACK_STATE_DIR}/server.log" "${MARK_LOG}" | grep -F -- "${SUMMARY_HEAD}" | sed 's/^/  | /' >&2 || true
        fail "${step}: ${n} start-sweep summary line(s), not one for 4 listed, the live strays not killed kept with their kills failed, 1 recorded as retired and 1 left for a latch"
    fi
    echo "${TEST_NAME}: NOTE: ${step}: the start sweep's summary: ${found}"
}

# t14_check_kill_failed_tries <id> <tries> <step>: each of the <tries> tries
# (of <tries>) of the first kill-retry of <id> after the leg's mark answered
# ErrTmuxKillFailed (its per-try line holds the outcome's fixed part); set
# LAST_DESCRIPTION to the last try's description. The descriptions'
# kill-failure words are not checked here: a 0.10.0 launch's description is
# capped in the log before them (`renderLogMessageText`); legs 1 to 4 check
# them.
t14_check_kill_failed_tries() {
    local id="$1" tries="$2" step="$3" n desc
    for (( n = 1; n <= tries; n++ )); do
        desc="$(t14_try_description "${id}" "${n}" 1 "${tries}")" || exit 1
        echo "${TEST_NAME}: ${step}: kill try ${n} of ${tries} for ${id}: ErrTmuxKillFailed: ${desc}"
        LAST_DESCRIPTION="${desc}"
    done
}

# t14_later <a> <b>: true when the time <a> is later than <b>.
t14_later() {
    awk -v a="$1" -v b="$2" 'BEGIN { exit !(a + 0 > b + 0) }'
}

# t14_check_sweep_budget <step>: the start sweep's pass budget (SRJ-702, AC
# 56) over the live strays A, B and Q, taken in the order of CSCB's first
# kill of each after the leg's mark (agent-director's `list` order is not
# assumed). Before the first row whose kill failed (its `orphan-cleanup`
# entry), a row whose kill succeeded is logged with its kills; that first
# failed row made exactly KILL_RETRY_TRIES CSCB kills; every row after it
# exactly 1. Sets T14_TRIES_OF[<id>] to each row's CSCB kills, and logs the
# order.
declare -A T14_TRIES_OF=()
t14_check_sweep_budget() {
    local step="$1" id t first_t best spent=0 kills entries order=() rest=("${UA_ID}" "${UB_ID}" "${Q_ID}") keep
    declare -A first=()
    for id in "${rest[@]}"; do
        t="$(t14_first_call_time "${MARK_TIME}" kill "${id}")" || exit 1
        [[ -n "${t}" ]] || fail "${step}: no CSCB kill of the live stray ${id} after the start"
        first["${id}"]="${t}"
    done
    while (( ${#rest[@]} > 0 )); do
        best=""
        first_t=""
        for id in "${rest[@]}"; do
            if [[ -z "${best}" ]] || t14_later "${first_t}" "${first[${id}]}"; then
                best="${id}"
                first_t="${first[${id}]}"
            fi
        done
        order+=("${best}")
        keep=()
        for id in "${rest[@]}"; do
            [[ "${id}" == "${best}" ]] || keep+=("${id}")
        done
        rest=(${keep[@]+"${keep[@]}"})
    done
    echo "${TEST_NAME}: ${step}: the live strays in the order CSCB first killed them: ${order[*]}"
    for id in "${order[@]}"; do
        kills="$(t14_cscb_count_since "${MARK_TIME}" kill "${id}")"
        entries="$(t14_count_entries "${ORPHAN_LABEL}" "${id}")"
        T14_TRIES_OF["${id}"]="${kills}"
        if (( spent )); then
            [[ "${kills}" == 1 ]] \
                || fail "${step}: ${kills} CSCB kill(s) of ${id}, swept after the pass's retries were spent, not 1"
            echo "${TEST_NAME}: ${step}: ${id}, swept after the pass's retries were spent: 1 CSCB kill"
        elif [[ "${entries}" != 0 ]]; then
            [[ "${kills}" == "${KILL_TRIES}" ]] \
                || fail "${step}: ${kills} CSCB kill(s) of ${id}, the first swept row whose kill failed, not ${KILL_TRIES}"
            echo "${TEST_NAME}: ${step}: ${id}, the first swept row whose kill failed: ${KILL_TRIES} CSCB kills"
            spent=1
        else
            echo "${TEST_NAME}: NOTE: ${step}: ${id}'s kill succeeded, before the pass's retries were spent, after ${kills} CSCB kill(s)"
        fi
    done
    (( spent )) || fail "${step}: no live stray's kill failed (A's must)"
}

# t14_note_kills_at <step> <target>...: log how many tmux calls after the
# leg's mark holding a `kill-session` or `kill-pane` aimed at one of the
# targets (a session name, `$N` or `%N`) reached the tmux shim, whoever made
# them: under `fail-kill --targets` each was refused. A target word is read
# as the shim compares it (a leading `=` and everything from the first `:`
# dropped; the log's `printf %q` quoting of `$` undone).
t14_note_kills_at() {
    local step="$1" n
    shift
    n="$(awk -F'\t' -v t="${MARK_TIME}" -v targets="$*" '
        BEGIN { split(targets, tl, " "); for (i in tl) want[tl[i]] = 1 }
        $1 == "call" && $2 + 0 >= t + 0 {
            k = split($6, w, " ")
            kill = 0; hit = 0
            for (i = 1; i <= k; i++) {
                if (w[i] ~ /^kill-(session|pane)$|^killp$|^kill-ses|^kill-p/) kill = 1
                x = w[i]; sub(/^=/, "", x); sub(/:.*$/, "", x); gsub(/\\\$/, "$", x)
                if (x in want) hit = 1
            }
            if (kill && hit) n++
        }
        END { print n + 0 }' "${SCENARIO_TMUX_SHIM_LOG}" 2> /dev/null)" || n="?"
    echo "${TEST_NAME}: NOTE: ${step}: ${n} tmux call(s) holding a kill aimed at $* reached the tmux shim after the mark (each refused under fail-kill --targets)"
}

# t14_check_other_stray <id> <persona> <session> <step>: the start sweep's
# kill of the live stray <id> (<persona> as its lines name it, empty for a
# pre-persona row) either succeeded (its per-row line, no `orphan-cleanup`
# entry naming it, <session> gone) or did not (no such line, exactly one
# entry naming it, <session> still there); which one is logged.
t14_check_other_stray() {
    local id="$1" persona="$2" session="$3" step="$4" head tail ok entries kills
    t14_value tail startSweepKillSucceededLine.tail "${id}"
    if [[ -n "${persona}" ]]; then
        t14_value head startSweepKillSucceededLine.head "${id}" "${persona}"
    else
        t14_value head startSweepKillSucceededLine.pre-persona-head "${id}"
    fi
    ok="$(t14_count_after "${SLACK_STATE_DIR}/server.log" "${MARK_LOG}" "$(matcher "${head}" "${tail}")")"
    entries="$(t14_count_entries "${ORPHAN_LABEL}" "${id}")"
    kills="$(t14_cscb_count_since "${MARK_TIME}" kill "${id}")"
    if [[ "${ok}" == 1 && "${entries}" == 0 ]]; then
        ! t14_has_session "${session}" || fail "${step}: ${session} still runs after the kill of ${id} succeeded"
        echo "${TEST_NAME}: NOTE: ${step}: the kill of ${id} succeeded after ${kills} CSCB kill(s); ${session} is gone"
    elif [[ "${ok}" == 0 && "${entries}" == 1 ]]; then
        t14_has_session "${session}" || fail "${step}: ${session} is gone although the kill of ${id} did not succeed"
        echo "${TEST_NAME}: NOTE: ${step}: the kill of ${id} did not succeed after ${kills} CSCB kill(s); its row is kept with one ${ORPHAN_LABEL} entry and ${session} still runs"
    else
        fail "${step}: ${ok} kill-succeeded line(s) and ${entries} ${ORPHAN_LABEL} entries for ${id}, not one or the other"
    fi
}

# True once a harness `find-missing` run leaves A's, B's, Q's and P's rows
# finished (`missing` or `ended`). P's is among them: a live row of P that a
# later start swept (P is absent from leg 1 on) would spend that pass's
# retry budget (SRJ-702), leaving leg 1's X one try.
t14_old_rows_finished() {
    local id state
    ad_capture find-missing
    [[ "${AD_RC}" == 0 ]] || return 1
    for id in "${UA_ID}" "${UB_ID}" "${Q_ID}" "${P_ID}"; do
        state="$(t14_row_state "${id}")"
        [[ "${state}" == missing || "${state}" == ended ]] || return 1
    done
}

# t14_end_old_workers <step>: the human ends each 0.10.0 row's session still
# running, by its session id, from the scenario's own shell, then runs
# `find-missing` until A's, B's, Q's and P's rows read finished.
t14_end_old_workers() {
    local step="$1" session ids sid id
    for session in "${UA_SESSION}" "${UB_SESSION}" "${Q_SESSION}" "${P_SESSION}"; do
        t14_has_session "${session}" || continue
        ids="$(t14_session_ids "${session}")" || fail "${step}: could not read ${session}'s id"
        read -r sid _ <<< "${ids}"
        end_session "${sid}"
    done
    wait_until "${ROW_WAIT_S}" "${step}: find-missing never marked the old workers' rows finished" t14_old_rows_finished
    for id in "${UA_ID}" "${UB_ID}" "${Q_ID}" "${P_ID}"; do
        echo "${TEST_NAME}: NOTE: ${step}: after the human ended the old workers, ${id} reads '$(t14_row_state "${id}")'"
    done
}

# ---------------------------------------------------------------------------
# Leg 0 (scenario 16): an upgrade's start sweep with one failing kill
# ---------------------------------------------------------------------------

leg_upgrade_sweep() {
    local step="upgrade start sweep" ua_state id m n before kills entry_head alert expected prefix body
    local ids sid pane head tail

    # After the migration: P's own row reads `pending` with no launch start;
    # the other rows are live, their workers running.
    ad_capture status --claude-instance-id "${P_ID}"
    [[ "${AD_RC}" == 0 ]] && jq -e '.state == "pending" and ((.launch_started_at // "") == "")' "${AD_OUT}" > /dev/null \
        || fail "${step}: after the migration ${P_ID} does not read pending with no launch start: $(tr '\n' ' ' < "${AD_OUT}" "${AD_ERR}")"
    for id in "${UA_ID}" "${UB_ID}" "${Q_ID}"; do
        echo "${TEST_NAME}: ${step}: ${id} reads '$(t14_row_state "${id}")' after the migration"
    done
    ua_state="$(t14_row_state "${UA_ID}")"
    [[ -n "${ua_state}" && "${ua_state}" != pending ]] || fail "${step}: ${UA_ID} reads '${ua_state}' after the migration, not a reported-in live state"
    ids="$(t14_session_ids "${UA_SESSION}")" || fail "${step}: no session ${UA_SESSION}"
    read -r sid pane <<< "${ids}"
    [[ "${sid}" == "${UA_SID}" && "${pane}" == "${UA_PANE}" ]] \
        || fail "${step}: ${UA_SESSION} is now '${ids}', not the seeded ${UA_SID} ${UA_PANE}"

    # The configuration names P (a Slack destination) and not Q; A's session
    # and pane are fail-kill's only targets (a guard: on the release no kill
    # is sent for a 0.10.0-launched session, so the list does not act here).
    stub_mode "${P_WORK}" "${STUB_MODE_SILENT}"
    tmux_shim_mode log
    t14_config_for_next_start "$(t14_persona_json "${P_NAME}" "${P_LABEL}" "${P_WORK}" "${P_CFG}" "${P_CHANNEL}")"
    t14_mark
    tmux_shim_mode fail-kill --targets "${UA_SESSION}" "${UA_SID}" "${UA_PANE}"
    m="$(completion_match 1)" || exit 1
    before="$(count_log "${m}")"
    start_server --live
    wait_until "${KILL_WAIT_S}" "${step}: the start sweep never logged its summary line" \
        t14_count_after_at_least "${SLACK_STATE_DIR}/server.log" "${MARK_LOG}" "${SUMMARY_HEAD}" 1
    tmux_shim_mode log
    wait_for_count "${m}" "$(( before + 1 ))" "${START_WAIT_S}" "${step}: the start pass never completed"

    # The sweep's counts: four rows listed; every live stray it did not kill
    # kept with its kill failed; Q's key recorded; P's row left for its latch.
    # How many of B's and Q's kills succeed is agent-director's (a 0.10.0
    # launch's session carries no label the release reads, so its kill may
    # answer ErrTmuxKillFailed with no kill sent, HO rev 31 §2 (a)); it is
    # logged, not asserted.
    t14_check_summary "${step}"
    t14_note_kills_at "${step}" "${UA_SESSION}" "${UA_SID}" "${UA_PANE}"

    # The pass's retry budget, in the order CSCB swept the rows: the first
    # row whose kill failed got KILL_RETRY_TRIES kills, every later one 1.
    t14_check_sweep_budget "${step}"

    # A: each of its tries answered ErrTmuxKillFailed; its session still
    # there.
    kills="${T14_TRIES_OF[${UA_ID}]}"
    t14_check_kill_failed_tries "${UA_ID}" "${kills}" "${step}"
    t14_has_session "${UA_SESSION}" || fail "${step}: ${UA_SESSION} is gone after its failed kill"

    # Exactly one orphan-cleanup entry names A: its row, state, session and
    # outcome, then the alert's ordinary version in its start-sweep form; one
    # server-log line of it.
    n="$(t14_count_entries "${ORPHAN_LABEL}" "${UA_ID}")"
    [[ "${n}" == 1 ]] || fail "${step}: ${n} ${ORPHAN_LABEL} entries naming ${UA_ID}, not 1"
    t14_value entry_head startSweepKillFailedEntry.pre-persona "${UA_ID}" "${ua_state}" "${UA_SESSION}" "${LAST_DESCRIPTION}"
    t14_value alert killFailureAlertEntryText.start-sweep "${UA_ID}" "${UA_SESSION}" "${LAST_DESCRIPTION}"
    n="$(t14_count_entries "${ORPHAN_LABEL}" "${entry_head}" "${alert}")"
    if [[ "${n}" != 1 ]]; then
        t14_after "${SLACK_STATE_DIR}/startup-errors.log" "${MARK_ERRORS}" | sed 's/^/  | /' >&2
        echo "  | expected: [${ORPHAN_LABEL}] ${entry_head} … ${alert}" >&2
        fail "${step}: the ${ORPHAN_LABEL} entry for ${UA_ID} is not the pre-persona head and the start-sweep alert the printer renders"
    fi
    n="$(t14_count_after "${SLACK_STATE_DIR}/server.log" "${MARK_LOG}" "$(matcher "[${ORPHAN_LABEL}] ${entry_head}" "${alert}")")"
    [[ "${n}" == 1 ]] || fail "${step}: ${n} server-log line(s) of A's ${ORPHAN_LABEL} entry, not 1"

    # B's and Q's kills: each either succeeded (its per-row line, no entry,
    # its session gone) or did not (no such line, exactly one entry naming
    # it, its session still there); which one is logged.
    t14_check_other_stray "${UB_ID}" "" "${UB_SESSION}" "${step}"
    t14_check_other_stray "${Q_ID}" "${Q_KEY}" "${Q_SESSION}" "${step}"
    n="$(t14_count_entries "${ORPHAN_LABEL}")"
    echo "${TEST_NAME}: NOTE: ${step}: ${n} ${ORPHAN_LABEL} entries after the start"

    # P latched from its own listed row; no CSCB kill of P's row; its one
    # launch-start-not-recorded post at its destination.
    t14_value expected startSweepLatchedFromOwnRowLine.launch-start-not-recorded "${P_NAME}" "${P_ID}"
    n="$(t14_count_after "${SLACK_STATE_DIR}/server.log" "${MARK_LOG}" "${expected}")"
    [[ "${n}" == 1 ]] || fail "${step}: ${n} line(s) of ${P_NAME} latched from its own listed row, not 1"
    n="$(t14_cscb_count_since "${MARK_TIME}" kill "${P_ID}")"
    [[ "${n}" == 0 ]] || fail "${step}: ${n} CSCB kill(s) of ${P_ID}, whose persona latched"
    t14_value prefix personaNoticePrefix "${P_NAME}"
    t14_value body launchStartNotRecordedNoticeText "${P_KEY}"
    wait_until "${POST_WAIT_S}" "${step}: no launch-start-not-recorded post for ${P_NAME} reached ${P_CHANNEL}" \
        t14_post_arrived "${MARK_RECORD}" "${P_CHANNEL}" "${prefix}${body}"
    n="$(t14_count_posts "${MARK_RECORD}" "" "${prefix}${body}")"
    [[ "${n}" == 1 ]] || fail "${step}: ${n} launch-start-not-recorded post(s) for ${P_NAME}, not 1"
    t14_note_posts "${MARK_RECORD}" "${P_CHANNEL}" "${step}"

    # Q's key is recorded as retired, absent at the start.
    n="$(t14_retired_cause "${Q_KEY}")"
    [[ "${n}" == "${CAUSE_ABSENT}" ]] || fail "${step}: the retired-key record gives ${Q_KEY} the cause '${n}', not ${CAUSE_ABSENT}"

    # No delete; every seeded row present; every running worker has a row;
    # nothing about A reaches the Slack stub.
    n="$(t14_cscb_count_since "${MARK_TIME}" delete "")"
    [[ "${n}" == 0 ]] || fail "${step}: ${n} CSCB delete call(s)"
    for id in "${UA_ID}" "${UB_ID}" "${Q_ID}" "${P_ID}"; do
        t14_row_get "${id}"
        echo "${TEST_NAME}: ${step}: ${id}'s row is kept, reading $(jq -r '.state' "${AD_OUT}")"
    done
    # A's worker (its kill failed) and P's (latched, never killed) run.
    t14_check_workers_have_rows "${step}" 2
    t14_no_records_about "${step}" "${UA_ID}" "${UA_SESSION}" "${UA_CHANNEL}"

    stop_server

    # The human acts on the alerts (HO rev 31 §2 (a), "Operator actions"):
    # each old worker's session still running is ended by its session id,
    # and a find-missing run marks its row; so no later start sweeps these
    # rows as live strays (a later pass's retry budget is its own legs').
    t14_end_old_workers "${step}"
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
    m="$(matcher "] [${ORPHAN_LABEL}] " "${X_ID}")"
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
    n="$(t14_count_entries "${ORPHAN_LABEL}" "${X_ID}")"
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
    n="$(t14_records_after "${MARK_RECORD}" \
        | jq -s --arg id "${X_ID}" --arg name "${X_NAME}" --arg c "${X_CHANNEL}" --arg l "${X_LABEL}" \
            '[.[] | select(.event == "api" and ((.channel // "") == $c or .label == $l or ((.text // "") | contains($id) or contains($name))))] | length')"
    [[ "${n}" == 0 ]] || fail "${step}: ${n} Slack stub record(s) about ${X_NAME} after the mark"
    # No tmux-unresponsive condition starts, for X or any persona: X is
    # absent, so its kill is the start sweep's, and neither a start-sweep
    # kill nor ErrTmuxKillFailed starts one (SRJ-307); no persona is
    # configured, so no launch or recovery attempt could start one either.
    t14_no_unresponsive_any "${X_KEY}" "${step}"

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
    local expected first_kill expected_two n state uncovered latency hold
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

    t14_value prefix personaNoticePrefix "${name}"
    t14_value body killFailureAlertText.destination "${id}" "${session}" "${LAST_DESCRIPTION}"
    expected="${prefix}${body}"
    wait_until "${POST_WAIT_S}" "${step}: no kill-failure alert for ${id} reached ${channel}" \
        t14_post_arrived "${MARK_RECORD}" "${channel}" "${expected}"
    latency="$(t14_alert_latency "${id}" "${channel}" "${expected}" "${step}")" || exit 1
    hold="$(awk -v l="${latency}" -v m="${NO_SECOND_ALERT_MARGIN_S}" -v f="${NO_SECOND_ALERT_HOLD_S}" \
        'BEGIN { h = 2 * l + m; h = (h == int(h)) ? h : int(h) + 1; if (h < f) h = f; print h }')"

    # One further retry: its sequence's kill fails the same way.
    wait_until "${RETRY_WAIT_S}" "${step}: no further retry's kill tries for ${id} ended" \
        t14_count_after_at_least "${SLACK_STATE_DIR}/server.log" "${MARK_LOG}" "${end}" 2
    t14_check_try_descriptions "${id}" 2 "${step}: the further retry"
    t14_value body killFailureAlertText.destination "${id}" "${session}" "${LAST_DESCRIPTION}"
    expected_two="${prefix}${body}"
    # No post of any text at the destination for the hold: at least
    # NO_SECOND_ALERT_HOLD_S, and twice the first alert's latency plus a
    # margin; the count is checked again just before the leg's stop.
    echo "${TEST_NAME}: ${step}: the first alert reached ${channel} ${latency} s after its kill tries' end line; holding ${hold} s for no further post there"
    T14_HOLD_CHANNEL="${channel}"
    T14_HOLD_COUNT="$(t14_count_channel_posts "${MARK_RECORD}" "${channel}")"
    t14_no_new_post_hold "${MARK_RECORD}" "${T14_HOLD_COUNT}" "${channel}" "${hold}" "${step}: after the further retry"

    # Exactly one alert, at the destination only.
    n="$(t14_count_posts "${MARK_RECORD}" "" "${expected}")"
    if [[ "${expected_two}" != "${expected}" ]]; then
        n=$(( n + $(t14_count_posts "${MARK_RECORD}" "" "${expected_two}") ))
    fi
    [[ "${n}" == 1 ]] || fail "${step}: ${n} kill-failure alert post(s) for ${id}, not 1"
    [[ "$(t14_count_posts "${MARK_RECORD}" "${channel}" "${expected}")" == 1 ]] \
        || fail "${step}: the kill-failure alert for ${id} is not at its destination ${channel}"
    t14_note_posts "${MARK_RECORD}" "${channel}" "${step}"
    t14_no_unresponsive "${key}" "${step}"

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

    t14_recount_before_stop "${step}"
    tmux_shim_mode log
    stop_server
}

# ---------------------------------------------------------------------------
# Leg 3: a cwd mismatch met by a pending-only retry on a running server
# ---------------------------------------------------------------------------

leg_cwd() {
    local step="cwd mismatch" session launch launch_t repointed_t age repoint_log uncovered n
    stub_mode "${W_ONE}" "${STUB_MODE_SILENT}"
    tmux_shim_mode log
    t14_config_for_next_start "$(t14_persona_json "${W_NAME}" "${W_LABEL}" "${W_LINK}" "${W_CFG}" "${W_CHANNEL}")"
    t14_mark
    t14_start_and_wait 1
    wait_until "${ROW_WAIT_S}" "${step}: ${W_ID} never read pending with a launch start" \
        t14_row_pending_launched "${W_ID}"
    launch="$(jq -r '.launch_started_at' "${AD_OUT}")"
    launch_t="$(t14_epoch "${launch}")" || exit 1
    # Printed before the re-point, so nothing slow sits between it and its time.
    t14_value uncovered uncoveredPendingRowLine "${W_NAME}" PENDING_ROW_REASON_CWD_MISMATCH

    # Before the first pending-only retry: `fail-kill`, then the re-point,
    # its time taken right after it.
    tmux_shim_mode fail-kill
    repoint_log="$(t14_lines "${SLACK_STATE_DIR}/server.log")"
    repoint_symlink "${W_LINK}" "${W_TWO}"
    repointed_t="${EPOCHREALTIME/,/.}"
    age="$(awk -v a="${repointed_t}" -v b="${launch_t}" 'BEGIN { printf "%.3f", a - b }')"
    # The start launched W on a covered row: nothing found it not covered before the re-point.
    sed -n "$(( MARK_LOG + 1 )),${repoint_log}p" "${SLACK_STATE_DIR}/server.log" > "${SCENARIO_ROOT}/before-repoint.log"
    n="$(count_in "${SCENARIO_ROOT}/before-repoint.log" "${uncovered}")"
    [[ "${n}" == 0 ]] || fail "${step}: ${W_ID}'s pending row was found not covered before the re-point"
    awk -v a="${age}" -v b="${REPOINT_BEFORE_S}" 'BEGIN { exit !(a + 0 <= b + 0) }' \
        || fail "${step}: the symlink was re-pointed ${age} s after ${W_ID}'s launch start, not within ${REPOINT_BEFORE_S} s (before its first retry)"
    echo "${TEST_NAME}: ${step}: the symlink was re-pointed ${age} s after ${W_ID}'s launch start"
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

    t14_recount_before_stop "${step}"
    tmux_shim_mode log
    stop_server
}

# ---------------------------------------------------------------------------
# Leg 4 (scenario 15): a persona removal whose kill fails
# ---------------------------------------------------------------------------

leg_persona_removal() {
    local step="persona removal" session ids sid pane pending apply end kills entry ref n state
    stub_mode "${R_WORK}" "${STUB_MODE_DEV_CHANNELS}"
    tmux_shim_mode log
    t14_config_for_next_start "$(t14_persona_json "${R_NAME}" "${R_LABEL}" "${R_WORK}" "${R_CFG}" "${R_CHANNEL}")"
    t14_start_and_wait 1
    wait_until "${ROW_WAIT_S}" "${step}: ${R_ID} never reported in (waiting)" t14_row_is "${R_ID}" waiting
    t14_row_get "${R_ID}"
    session="$(jq -r '.tmux_session_name // empty' "${AD_OUT}")"
    [[ -n "${session}" ]] || fail "${step}: ${R_ID}'s row names no tmux session"
    ids="$(t14_session_ids "${session}")" || fail "${step}: no session ${session} on the scenario's tmux server"
    read -r sid pane <<< "${ids}"

    # `fail-kill` limited to R's session and pane; the operator removes R
    # from config.json and confirms the apply by renaming the pending file.
    t14_mark
    tmux_shim_mode fail-kill --targets "${session}" "${sid}" "${pane}"
    pending="${SLACK_STATE_DIR}/config.json${PENDING_SUFFIX}"
    apply="${SLACK_STATE_DIR}/config.json${APPLY_SUFFIX}"
    [[ ! -e "${pending}" ]] || fail "${step}: ${pending} exists before the edit"
    t14_write_config
    wait_for_file "${pending}" "${RELOAD_WAIT_S}" "${step}: no pending file after R's removal from config.json"
    mv -f -- "${pending}" "${apply}" || fail "${step}: could not rename ${pending} to ${apply}"

    # The teardown's kill: each try answered ErrTmuxKillFailed, its tries
    # ended exhausted with the ordinary alert decided; exactly
    # KILL_RETRY_TRIES CSCB kills.
    end="$(t14_end_matcher "${R_ID}")" || exit 1
    wait_until "${KILL_WAIT_S}" "${step}: ${R_ID}'s teardown kill tries never ended exhausted" \
        t14_count_after_at_least "${SLACK_STATE_DIR}/server.log" "${MARK_LOG}" "${end}" 1
    t14_check_try_descriptions "${R_ID}" 1 "${step}"
    kills="$(t14_cscb_count_since "${MARK_TIME}" kill "${R_ID}")"
    [[ "${kills}" == "${KILL_TRIES}" ]] || fail "${step}: ${kills} CSCB kill(s) of ${R_ID}, not ${KILL_TRIES}"
    t14_has_session "${session}" || fail "${step}: ${session} is gone after its failed kill"

    # Exactly one persona-teardown-notice entry naming R, "raised during its
    # teardown", carrying the ordinary alert for the persona-teardown route;
    # one server-log line of it.
    t14_value entry personaTeardownNoticeEntryText.kill-failure "${R_NAME}" "${session}" "${LAST_DESCRIPTION}"
    wait_until "${POST_WAIT_S}" "${step}: no ${TEARDOWN_LABEL} entry carrying R's kill-failure alert" \
        t14_count_after_at_least "${SLACK_STATE_DIR}/startup-errors.log" "${MARK_ERRORS}" "] [${TEARDOWN_LABEL}] ${entry}" 1
    ref="$(persona_ref "${R_NAME}")" || exit 1
    n="$(t14_count_entries "${TEARDOWN_LABEL}" "${ref}")"
    if [[ "${n}" != 1 ]]; then
        t14_after "${SLACK_STATE_DIR}/startup-errors.log" "${MARK_ERRORS}" | sed 's/^/  | /' >&2
        fail "${step}: ${n} ${TEARDOWN_LABEL} entries naming ${R_NAME}, not 1"
    fi
    n="$(t14_count_entries "${TEARDOWN_LABEL}" "${entry}")"
    [[ "${n}" == 1 ]] || fail "${step}: ${n} ${TEARDOWN_LABEL} entries carrying R's kill-failure alert, not 1"
    n="$(t14_count_after "${SLACK_STATE_DIR}/server.log" "${MARK_LOG}" "[${TEARDOWN_LABEL}] ${entry}")"
    [[ "${n}" == 1 ]] || fail "${step}: ${n} server-log line(s) of R's ${TEARDOWN_LABEL} entry, not 1"

    # No delete; R's row present; R's key recorded as retired, removed.
    n="$(t14_cscb_count_since "${MARK_TIME}" delete "")"
    [[ "${n}" == 0 ]] || fail "${step}: ${n} CSCB delete call(s) after the edit"
    state="$(t14_row_state "${R_ID}")"
    [[ -n "${state}" ]] || fail "${step}: ${R_ID}'s row is gone: $(tr '\n' ' ' < "${AD_ERR}")"
    echo "${TEST_NAME}: ${step}: ${R_ID}'s row is kept, reading ${state}"
    n="$(t14_retired_cause "${R_KEY}")"
    [[ "${n}" == "${CAUSE_REMOVED}" ]] || fail "${step}: the retired-key record gives ${R_KEY} the cause '${n}', not ${CAUSE_REMOVED}"

    # Nothing about the failure reaches the Slack stub.
    t14_no_records_about "${step}" "${R_CHANNEL}" "${R_ID}" "${R_NAME}" "${session}"
    t14_no_unresponsive "${R_KEY}" "${step}"

    tmux_shim_mode log
    stop_server
}

leg_upgrade_sweep
leg_start_sweep
leg_config_dir
leg_cwd
leg_persona_removal

# The closing assertions (b.jg5 SRJ-1401, SRJ-1418).
assert_no_server_tmux
assert_no_cscb_include_finished
assert_no_cscb_delete

echo "${TEST_NAME}: PASS"
