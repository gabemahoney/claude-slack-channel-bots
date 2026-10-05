#!/usr/bin/env bash
# Test 26 (HO §7 scenario 24; b.jg5 SRJ-1426; AC 80, 84): agent-director's
# timing values are logged and govern CSCB's waits. With the scenario HOME's
# agent-director settings file setting pending_grace_seconds 120,
# stopping_window_seconds 30 and starting_session_seconds 120 (the scenario
# inputs SRJ-1426 names), the server logs the nine [tmux] values it read; a
# launch held at an unrecognised dialog gets no pending-row run, live-row
# sequence `find-missing` run or slower approver read before G (120 s) from
# its launch start, and its relaunching stuck-launch post at B (300 s);
# scenario 13's "still stopping" follows the 30 s window; a value changed
# while the server runs is used from the next read, and a [pause]-only change
# logs no values line.
#
# Set-up (fmk mode, lib/scenario.sh): the scenario's own HOME, store and tmux
# server under SCENARIO_ROOT; the agent-director 0.11.0 release installed
# through its install.sh, behind the agent-director shim; the tmux shim in
# front of tmux for every CSCB process, in `log` mode; the Slack stub
# (fixtures/slack-stub-server.ts --record), which records each
# chat.postMessage text whole. Before the first start the scenario writes the
# scenario HOME's agent-director settings file (`write_ad_settings`, at
# AD_SETTINGS_RELATIVE_PATH under HOME) with a [tmux] table holding
# pending_grace_seconds 120, stopping_window_seconds 30 and
# starting_session_seconds 120: scenario 24 is one of the two scenarios that
# write [tmux] (b.jg5 SRJ-1401, SRJ-1306), and each key is checked to be one
# of the package's AD_TMUX_KEYS and each value to be at or above its
# minimum (AD_SETTING_MINIMUMS, pendingGraceMinimumSeconds at the default
# create_timeout_ms and pipe_close_wait_ms) before it is written.
# Server-wide: `health_check_interval` 0 (no health tick launches anyone;
# ruling S3), `resume_enabled` true (S's finished row is brought back by a
# `resume`), `exit_timeout` 5, and `agent_director_poll_interval_ms` at its
# maximum (3600000), so the permission poller's `list` calls do not crowd the
# shim's log; these are CSCB's own settings, through its config.
#
# Personas (each `t26_<x>`, instance `cscb_t26_<x>`, one channel each; the
# stub worker's mode is selected per working directory with `stub_mode`):
#   S  work/s, `linger-on-exit` (reports in at once; on `pause`'s `/exit` it
#      fires SessionEnd and keeps running until `stub_release`); in the
#      config from the first start
#   P  work/p, `unrecognised-dialog` (held at a startup dialog CSCB's
#      approver never answers), switched to `at-once` before B so the
#      abort's relaunch reports in; added to the config across a plain
#      stop and start
#   Q  work/q_link, a symlink first to work/q_held (`unrecognised-dialog`),
#      re-pointed to work/q_ready (`at-once`); added to the config across a
#      plain stop and start
# A persona added across a restart: a plain stop, the config written, the
# state dir's config.json.last-applied removed, so the start applies
# config.json as it stands with no preview to confirm (the README's
# "Reload"), and a start.
#   R  work/r, `unrecognised-dialog`, answered by a harness Enter
#      (`stub_press_enter`); added by a confirmed reload (config.json.pending
#      renamed to config.json.apply)
#   C1 work/c1, `at-once`; added by a confirmed reload while the settings file
#      is refused (leg refused-stopping)
#   C2 work/c2, `at-once`; the same in leg refused-grace
#
# Waits, all derived from the printer's values for the written table: G
# (adGraceMs, 120 s), B (adLaunchBoundMs, 300 s), the alert threshold
# (adAlertThresholdMs, 180 s, printed, not used: the alert timings are
# unit-tested, SRJ-309, SRJ-313) and the version re-check's 120 s tick
# (AD_VERSION_RECHECK_INTERVAL_MS), at which the server reads the settings
# file again (src/ad-settings.ts installAdSettings: after each timed probe).
# A bot-server probe is a CSCB `version` call in the agent-director shim's log
# whose parent is the bot server. Every time is taken by this script as it
# polls, or from a log line's own time: a shim line's time field, a
# server.log line's ISO prefix, a stub record's `ts`, a row's
# `launch_started_at` or `ended_at` (read with a harness `get`). The approver's
# paces come from the printer (DIALOG_POLL_INTERVAL_MS, 1 s before G;
# DIALOG_SLOW_POLL_INTERVAL_MS, 5 s from G); "what a 5 s pace allows" in a
# window of d seconds is floor(d / 5) + 1 reads. The whole script runs about
# 37 minutes: about 19 for the legs before the refused values (most of it the
# held launch's B and the change leg's three waits for the next timed probe)
# and about 9 for each refused-value leg (the wait for the next timed probe,
# the added persona's retries on its timer, and its timer's pending-only
# retry after it comes up).
#
# Legs (in order, each a function below; the later Tasks of scenario 24 add
# theirs before the closing assertions):
#   values      the first start, with S: exactly one values line, equal to
#               the printer's line for the written path, the three written
#               values and the six defaults (it carries the nine [tmux]
#               values only); every later start of the script logs exactly
#               one such line too.
#   stopping    scenario 13's "still stopping" (hatch decision): S up and
#               waiting (its session's creation time taken), `stop
#               --stop-bots` (CSCB's `pause` makes S's row `ended` while its
#               worker lingers), then `start` at once. Exactly one refusal
#               line for S carrying STILL_STOPPING_PHRASE, for S's first
#               `resume`, made less than stopping_window_seconds after the
#               row's `ended_at`; S's next `resume` (CSCB's UNAVAILABLE retry)
#               is made more than the window after `ended_at`, while the old
#               worker still runs and its session is younger than
#               starting_session_seconds, and its refusal carries
#               STILL_STARTING_PHRASE, never STILL_STOPPING_PHRASE (HO §2:
#               "still stopping", then "still starting", then the own-id
#               CONFLICT). Then the harness releases the stub; a later `resume`
#               brings S up (`waiting`). No post to S's channel, every refusal
#               line says no spawn-failure notice, no spawn-failed entry, no
#               latch.
#   held        P, launched by this server process (added across a restart):
#               its `launch_started_at` read with a harness `get`; P's
#               `read-pane` calls counted in (G/2, G) from the launch start
#               (above what the slow pace allows) and in (G + 5, G + 65) (at
#               most that); no CSCB `find-missing` before the launch start
#               plus G; no post to P's channel and no CSCB kill of P before
#               the relaunching post; exactly one relaunching post, its stub
#               record time no earlier than B and less than 30 s after it, its
#               text the printer's relaunching notice for P with B (in whole
#               minutes in it). P's pending-row lines and the abort that
#               follows are recorded, not asserted (test-24 asserts the
#               abort); P then reports in (`waiting`).
#   sequence    Q's live-row sequence (hatch decision, departing from the
#               SRD, which names no trigger): Q added across a restart, its
#               symlinked working directory pointing at q_held; Q's launch
#               start L read; the symlink re-pointed at q_ready (one rename),
#               so its row's `cwd` (agent-director records the real path) no
#               longer matches (ruling S5); a plain stop and start before L +
#               G (ruling S4: a restart without teardown). The restart's start
#               sweep (b.jg5 SRJ-714) kills that live row and makes its one
#               `find-missing` run after its kills at once: recorded, since
#               SRJ-1426's G rule is the live-row sequence's. The start pass
#               then starts Q's live-row sequence (the route; the script fails
#               saying so when it does not): its kill of Q comes before its
#               step-2 wait, which is armed from L with G (its armed line
#               equal to the printer's), its first `find-missing` run comes no
#               earlier than L + G with no CSCB `find-missing` between the
#               sequence's start and it, and the wait's end line is no earlier
#               than L + G; Q is brought up by a reuse spawn (`waiting`). A
#               run line saying a sequence run left Q's `pending` row in
#               neither list is followed by no kill of Q; no post to Q's
#               channel.
#   change      a [pause]-only change (timeout_seconds 60, the [tmux] values
#               kept) logs no values line through the next bot-server probe;
#               pending_grace_seconds raised to 240 (above its minimum) logs
#               exactly one values line, naming 240, after the next probe and
#               none before it; R, added by a confirmed reload, is held at its
#               dialog, and its `read-pane` count in (L + 130 s, L + 170 s)
#               from its launch start L is above what the slow pace allows
#               (the new G is in use); a harness Enter brings R up; the file's
#               earlier [tmux] values come back with no [pause] table, and
#               whether a values line follows the next probe is printed.
#   refused-stopping
#               refused values (b.jg5 SRJ-1426, SRJ-209, SRJ-316, SRJ-1018;
#               AC 84; the suite's only deliberately refused values, SRJ-1401's
#               exception): the server restarted with `session_restart_delay`
#               0 (and `health_check_interval` 0, as throughout), S, P, Q and
#               R up; the file written with stopping_window_seconds 10, below
#               its minimum; after the next bot-server probe C1 is added by a
#               confirmed reload, its launch meets agent-director's
#               ErrConfigMalformed (which reaches CSCB as ErrUnknownErrorName)
#               and it is retried on its timer at least twice, with a
#               bot-server probe inside the refusal; then the earlier accepted
#               file is written back. The checks (`refused_values_check`, one
#               function for both inputs): exactly one refused-read line, at
#               the first refused read, carrying the printer's fixed parts
#               (the file) and the key, none at the next read and no values
#               line while refused; one onset post to C1's channel (the
#               printer's fixed parts, naming the config file, around
#               agent-director's description) and one raise line, for C1
#               only; while refused no CSCB delete, kill, `kill-finished` or
#               resume, no stuck-launch abort, no counted launch failure, no
#               dead reading, one launch call (C1's plain spawn at the reload,
#               none for a persona already up), and each of C1's timed retries
#               reruns its recovery: one `status` call, refused and read as
#               unknown, no launch, nothing counted, the timer re-armed with
#               the reason liveness-unknown; no all-clear after the probe
#               inside the refusal; after the fix C1 reads `waiting`, one
#               all-clear post (the printer's text) made after the fix, one
#               clear line, C1's
#               retry timer stopped once a pending-only retry reads its row
#               live (so no persona up at the next leg has a timer), and no
#               values line through the next bot-server probe.
#   refused-grace
#               the same checks for pending_grace_seconds = "60" (a TOML
#               string), with C2 added by a confirmed reload and C1 among the
#               personas already up.
#
# The refused-value legs (hatch decisions, the Epic's "Hatch gap"): the
# persona meeting the refusal is added by a confirmed reload, so the last
# accepted read is the earlier file; the alert is one per affected persona
# per episode. Where the hatch decision and the SRD differ, the SRD is
# followed: "makes no spawn" (SRJ-1426) is checked as no launch call while
# refused but the reload's own launch of the added persona, whose timed
# retries rerun its recovery (a refused `status`, no launch) rather than
# retry the launch; and the Epic's "every call" is every store-backed call,
# `version` being answered.
#
# Matched values, each printed by fixtures/fmk-texts.ts from the installed
# package (never retyped):
#   TMUX_KEYS            AD_TMUX_KEYS                        src/ad-settings.ts
#   minimums             AD_SETTING_MINIMUMS <key> [floor|addend],
#                        pendingGraceMinimumSeconds          src/ad-settings.ts
#   defaults             DEFAULT_AD_SETTINGS tmux <key>      src/ad-settings.ts
#   VALUES_PREFIX        AD_SETTINGS_LOG_PREFIX              src/ad-settings.ts
#   values lines         buildAdSettingsValuesLine <path> <key>=<value>...
#                                                            src/ad-settings.ts
#   G_MS, B_MS, ALERT_MS adGraceMs, adLaunchBoundMs, adAlertThresholdMs
#                                                            src/ad-settings.ts
#   B_MINUTES            wholeMinutes <B_MS>                 src/ad-settings.ts
#   RECHECK_S            AD_VERSION_RECHECK_INTERVAL_MS / 1000
#                                                            src/ad-version-gate.ts
#   FAST_PACE_MS         DIALOG_POLL_INTERVAL_MS             src/session-manager.ts
#   SLOW_PACE_MS         DIALOG_SLOW_POLL_INTERVAL_MS        src/session-manager.ts
#   STILL_STOPPING       STILL_STOPPING_PHRASE               src/ad-description-phrases.ts
#   STILL_STARTING       STILL_STARTING_PHRASE               src/ad-description-phrases.ts
#   RELAUNCH_POST        formatPersonaNotice <P> stuckLaunchRelaunchingText <P's key> <B_MS>
#                                                            src/persona-notifier.ts,
#                                                            src/pending-row.ts
#   SPAWN_FAILED_LABEL   STARTUP_ERROR_SPAWN_FAILED          src/session-manager.ts
#   LIVE_PREFIX          LIVE_ROW_SEQUENCE_LOG_PREFIX        src/live-row-sequence.ts
#   the wait's lines     liveRowSequenceWaitArmedLine <Q's ref> <L in ms> <G_MS>,
#                        liveRowSequenceWaitEndedLine <Q's ref>
#                                                            src/live-row-sequence.ts
#   not-judged lines     liveRowSequenceRunLine <Q's ref> <step> <run> LIVE_ROW_RUN_NOT_JUDGED
#                                                            src/live-row-sequence.ts
#   CONFIG_FILE_NAME     AD_CONFIG_FILE_DISPLAY_NAME         src/ad-config-file.ts
#   RETRY_BASE_S         UNAVAILABLE_RETRY_BASE_S            src/unavailable-retry.ts
#   RETRY_CEILING_S      UNAVAILABLE_RETRY_CEILING_S         src/unavailable-retry.ts
#   LIVENESS_UNKNOWN_REASON
#                        RESTART_OUTCOME_LIVENESS_UNKNOWN    src/restart.ts
#   the retry timer's lines
#                        unavailableRetryRetryLine <C's key> <retry> full,
#                        unavailableRetryReArmedLine <C's key> <retry> full <marker> 0,
#                        unavailableRetryStoppedLine <C's key> full none <marker>
#                                                            src/unavailable-retry.ts
#   the refused-read line's fixed parts
#                        buildAdSettingsRefusedReadLine <file> <marker> accepted
#                                                            src/ad-settings.ts
#   the onset's fixed parts
#                        formatPersonaNotice <C> adConfigMalformedOnset <marker>
#                                                            src/outage-state.ts
#   the all-clear        formatPersonaNotice <C> ALL_CLEAR_TEMPLATE ad-config-malformed
#                                                            src/outage-state.ts
#   the raise line's fixed parts, the clear line
#                        adConfigMalformedRaisedLine <C's key> <marker>,
#                        adConfigMalformedClearedLine <C's key>
#                                                            src/outage-state.ts
# A marker the scenario passes in place of agent-director's description, the
# reader's reason or a retry line's reason splits a printed text into the
# fixed parts around it.
# Lines with no exported builder are matched by a fragment quoted from src/
# (ruling S7), each with its source beside it below.
#
# Hatch decisions (the Epic's "Hatch gap"):
# - the stuck-launch post at B is reachable: SRJ-1426's "no escalation, post
#   or kill while find-missing leaves the pending row in neither list" holds
#   before B; at B CSCB's own stuck launch gets the relaunching post (no
#   earlier than B, within 30 s after it) and its abort, which is recorded
#   here and asserted by test-24;
# - the live-row sequence's G wait is checked on a second held launch Q made
#   uncovered by re-pointing its symlinked working directory (ruling S5),
#   with a restart without teardown (ruling S4) inside Q's first G; if the
#   built code does not take that route, the script fails saying so;
# - "still stopping" is `stop --stop-bots`, then `start` at once, with S's
#   stub answering `pause`'s `/exit` with SessionEnd and lingering until the
#   harness releases it; S's session is kept younger than
#   starting_session_seconds, so agent-director's next rule is "still
#   starting", never the own-id CONFLICT;
# - R is added by a confirmed reload (test-8's approach).
# Where the SRD and the Task differ, the SRD is followed: the Task's "the
# first CSCB find-missing after the restart comes no earlier than L + G" is
# checked on the live-row sequence's first run (SRJ-1426), since the start
# sweep's run at once is SRJ-714's own.
#
# The script ends with the three closing assertions (assert_no_server_tmux,
# assert_no_cscb_include_finished, assert_no_cscb_delete).
set -euo pipefail

TEST_NAME="test-26-fmk-timing-settings"
# shellcheck source=lib/scenario.sh
source "$(dirname "$0")/lib/scenario.sh"

TEXTS="${SCENARIO_FIXTURES}/fmk-texts.ts"

# ---------------------------------------------------------------------------
# Values from src/ (through the printer) and the scenario's own
# ---------------------------------------------------------------------------

# The [tmux] table scenario 24 writes (b.jg5 SRJ-1426's scenario inputs).
GRACE_S=120
STOPPING_S=30
STARTING_S=120
# The raised grace period of the change leg (scenario input).
GRACE_RAISED_S=240
# The [pause] timeout_seconds of the [pause]-only change (scenario input).
PAUSE_TIMEOUT_S=60
# The change leg's window for R's read-pane calls, from its launch start, in
# seconds: past the first G and before the raised one (scenario inputs).
R_WINDOW_FROM_S=130
R_WINDOW_TO_S=170

TMUX_KEYS_TEXT="$(bun "${TEXTS}" AD_TMUX_KEYS)" || fail "setup: fmk-texts AD_TMUX_KEYS"
read -r -a TMUX_KEYS <<< "${TMUX_KEYS_TEXT}"

# tmux_key <name>: print <name> when it is one of the package's AD_TMUX_KEYS.
tmux_key() {
    local k
    for k in "${TMUX_KEYS[@]}"; do
        if [[ "${k}" == "$1" ]]; then
            printf '%s\n' "$1"
            return 0
        fi
    done
    fail "setup: '$1' is not one of the package's AD_TMUX_KEYS (${TMUX_KEYS_TEXT})"
}

KEY_GRACE="$(tmux_key pending_grace_seconds)" || exit 1
KEY_STOPPING="$(tmux_key stopping_window_seconds)" || exit 1
KEY_STARTING="$(tmux_key starting_session_seconds)" || exit 1
KEY_CREATE="$(tmux_key create_timeout_ms)" || exit 1
KEY_PIPE="$(tmux_key pipe_close_wait_ms)" || exit 1

# printed <entry> [<arg>...]: the printer's value, failing the script when the printer fails.
printed() {
    bun "${TEXTS}" "$@" || fail "setup: fmk-texts $*"
}

MIN_STOPPING="$(printed AD_SETTING_MINIMUMS "${KEY_STOPPING}")" || exit 1
MIN_STARTING="$(printed AD_SETTING_MINIMUMS "${KEY_STARTING}")" || exit 1
DEFAULT_CREATE="$(printed DEFAULT_AD_SETTINGS tmux "${KEY_CREATE}")" || exit 1
DEFAULT_PIPE="$(printed DEFAULT_AD_SETTINGS tmux "${KEY_PIPE}")" || exit 1
MIN_GRACE="$(printed pendingGraceMinimumSeconds "${DEFAULT_CREATE}" "${DEFAULT_PIPE}")" || exit 1
(( STOPPING_S >= MIN_STOPPING && STARTING_S >= MIN_STARTING && GRACE_S >= MIN_GRACE && GRACE_RAISED_S >= MIN_GRACE )) \
    || fail "setup: a scenario value is below its minimum (${KEY_STOPPING} ${STOPPING_S} >= ${MIN_STOPPING}, ${KEY_STARTING} ${STARTING_S} >= ${MIN_STARTING}, ${KEY_GRACE} ${GRACE_S} and ${GRACE_RAISED_S} >= ${MIN_GRACE})"

# The written table as <key>=<value> pairs, for the writer and the printer alike.
TABLE=("${KEY_GRACE}=${GRACE_S}" "${KEY_STOPPING}=${STOPPING_S}" "${KEY_STARTING}=${STARTING_S}")
TABLE_RAISED=("${KEY_GRACE}=${GRACE_RAISED_S}" "${KEY_STOPPING}=${STOPPING_S}" "${KEY_STARTING}=${STARTING_S}")

VALUES_PREFIX="$(printed AD_SETTINGS_LOG_PREFIX)" || exit 1
G_MS="$(printed adGraceMs "${TABLE[@]}")" || exit 1
B_MS="$(printed adLaunchBoundMs "${TABLE[@]}")" || exit 1
ALERT_MS="$(printed adAlertThresholdMs "${TABLE[@]}")" || exit 1
B_MINUTES="$(printed wholeMinutes "${B_MS}")" || exit 1
G_RAISED_MS="$(printed adGraceMs "${TABLE_RAISED[@]}")" || exit 1
RECHECK_MS="$(printed AD_VERSION_RECHECK_INTERVAL_MS)" || exit 1
FAST_PACE_MS="$(printed DIALOG_POLL_INTERVAL_MS)" || exit 1
SLOW_PACE_MS="$(printed DIALOG_SLOW_POLL_INTERVAL_MS)" || exit 1
STILL_STOPPING="$(printed STILL_STOPPING_PHRASE)" || exit 1
STILL_STARTING="$(printed STILL_STARTING_PHRASE)" || exit 1
SPAWN_FAILED_LABEL="$(printed STARTUP_ERROR_SPAWN_FAILED)" || exit 1
LIVE_PREFIX="$(printed LIVE_ROW_SEQUENCE_LOG_PREFIX)" || exit 1
for v in G_MS B_MS ALERT_MS G_RAISED_MS RECHECK_MS FAST_PACE_MS SLOW_PACE_MS; do
    [[ "${!v}" =~ ^[1-9][0-9]*$ && $(( ${!v} % 1000 )) == 0 ]] \
        || fail "setup: ${v} '${!v}' is not a whole number of seconds"
done
G_S=$(( G_MS / 1000 ))
B_S=$(( B_MS / 1000 ))
G_RAISED_S=$(( G_RAISED_MS / 1000 ))
RECHECK_S=$(( RECHECK_MS / 1000 ))
SLOW_PACE_S=$(( SLOW_PACE_MS / 1000 ))
(( G_S < R_WINDOW_FROM_S && R_WINDOW_FROM_S < R_WINDOW_TO_S && R_WINDOW_TO_S < G_RAISED_S && R_WINDOW_TO_S < B_S )) \
    || fail "setup: R's window (${R_WINDOW_FROM_S}s, ${R_WINDOW_TO_S}s) does not lie past G ${G_S}s and before the raised G ${G_RAISED_S}s and B ${B_S}s"
(( FAST_PACE_MS < SLOW_PACE_MS )) || fail "setup: the approver's pace before G (${FAST_PACE_MS} ms) is not faster than its slow pace (${SLOW_PACE_MS} ms)"

# Allowances (the scenario's own).
POST_ALLOWANCE_S=30   # the relaunching post: no earlier than B, within this after it
PROBE_ALLOWANCE_S=10  # a timed bot-server probe: within RECHECK_S plus this

# Personas, channels and the Slack stub's token suffixes.
P_NAME="${SCENARIO_TAG}_p"
declare -A KEY=() ID=() REF=() CHANNEL=() SUFFIX=() WORK=()
for x in s p q r c1 c2; do
    n="${SCENARIO_TAG}_${x}"
    KEY[${x}]="$(persona_key "${n}")"
    # src/persona-identity.ts personaInstanceId.
    ID[${x}]="cscb_${KEY[${x}]}"
    REF[${x}]="$(persona_ref "${n}")"
    CHANNEL[${x}]="C0T26${x^^}001"
    SUFFIX[${x}]="t26${x}"
done

RELAUNCH_POST="$(printed formatPersonaNotice "${P_NAME}" stuckLaunchRelaunchingText "${KEY[p]}" "${B_MS}")" || exit 1
RELAUNCH_TEXT="$(printed stuckLaunchRelaunchingText "${KEY[p]}" "${B_MS}")" || exit 1
[[ "${RELAUNCH_TEXT}" == *" ${B_MINUTES} "* ]] || fail "setup: the relaunching text does not state B (${B_MINUTES} whole minutes)"

# Fragments quoted from src/ (no exported builder):
# src/session-manager.ts logRefusal: `[slack] <site>: <what> refused for <ref>: <described> — no spawn-failure notice; …`.
REFUSED_FOR=' refused for '
NO_NOTICE_TAIL=' — no spawn-failure notice; nothing more is called'
# src/conflict-latch.ts: `[slack] conflict-latch: persona=<key> latched — …`.
LATCH_HEAD='[slack] conflict-latch: persona='
# src/pending-row.ts stuckLaunchLineHead: `[slack] pending-row: persona=<key> stuck-launch`.
STUCK_LINE_HEAD='[slack] pending-row: persona='
# src/restart.ts countLaunchFailure's line for a relaunch: `[slack] Session relaunch failed for persona=<key>`.
RELAUNCH_FAILED='[slack] Session relaunch failed for persona='
# src/session-manager.ts reconcileOrphans' lines: `[slack] reconcileOrphans: …`.
SWEEP_HEAD='[slack] reconcileOrphans: '
# src/reload-apply.ts renderAppliedLogLine.
APPLIED_CLASS='[slack] reload-applied:'

# Bounds, in seconds (the scenario's own).
STUB_WAIT_S=20      # the Slack stub writing its ready file
GATE_WAIT_S=60      # a start's first bot-server probe (the startup gate)
REPORT_WAIT_S=120   # a persona launching and reporting in (waiting)
LAUNCH_WAIT_S=60    # a start or reload making a persona's launch call
LOG_WAIT_S=30       # a server.log line following the call it reports
RETRY_WAIT_S=120    # CSCB's next UNAVAILABLE retry of a persona
PROBE_SETTLE_S=2    # after a probe's process has ended: the tick's listeners acting on it
RELOAD_WAIT_S=30    # a config change previewed, or a confirmation applied

STUB_DIR="${SCENARIO_ROOT}/slack-stub"
STUB_RECORD="${STUB_DIR}/record.jsonl"
CONFIG="${SLACK_STATE_DIR}/config.json"
SERVER_PID=""
# CSCB's session_restart_delay, written by write_personas when set (the
# refused-value legs set it to 0).
RESTART_DELAY_S=""

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

now_s() {
    printf '%s\n' "${EPOCHREALTIME/,/.}"
}

# Print <b> - <a>, both seconds with decimals.
seconds_between() {
    awk -v a="$1" -v b="$2" 'BEGIN { printf "%.3f\n", b - a }'
}

# True when <a> < <b>, both seconds with decimals.
time_before() {
    awk -v a="$1" -v b="$2" 'BEGIN { exit !(a < b) }'
}

# Print <a> + <b>, both seconds with decimals.
time_plus() {
    awk -v a="$1" -v b="$2" 'BEGIN { printf "%.3f\n", a + b }'
}

# epoch_of <step> <time-text>: an RFC 3339 or ISO 8601 time (a row's
# launch_started_at or ended_at, a stub record's ts, a server.log prefix) in
# epoch seconds with three decimals.
epoch_of() {
    local out
    out="$(date -u -d "$2" '+%s.%N' 2> /dev/null)" || fail "$1: '$2' is not a time"
    awk -v t="${out}" 'BEGIN { printf "%.3f\n", t }'
}

# sleep_until <epoch-s>: sleep until the clock reaches <epoch-s> (a window's
# end the script measured).
sleep_until() {
    local left
    left="$(seconds_between "$(now_s)" "$1")"
    if time_before 0 "${left}"; then
        sleep "${left}"
    fi
}

# call_fields <step> <line>: split an agent-director shim `call` line into
# CALL_T (its time, seconds), CALL_PID, CALL_PPID and CALL_VERB.
call_fields() {
    _scenario_split_line "$2" || fail "$1: not a shim log line: $2"
    [[ "${_L_KIND}" == call ]] || fail "$1: not a call line: $2"
    _scenario_decode_words || fail "$1: the call line's words do not parse: $2"
    _scenario_ad_verb
    CALL_T="$(awk -v us="${_L_US}" 'BEGIN { printf "%.6f\n", us / 1000000 }')"
    CALL_PID="${_L_PID}"
    CALL_PPID="${_L_PPID}"
    CALL_VERB="${_L_VERB}"
}

# wait_server_probe <count-before> <timeout-s> <step>: wait for the next
# bot-server version probe after CSCB's first <count-before> version calls
# (a `start` or `stop` CLI's own calls are skipped). Sets the CALL_* fields.
wait_server_probe() {
    local n="$1" timeout_s="$2" step="$3" line deadline left
    deadline=$(( SECONDS + timeout_s ))
    while :; do
        left=$(( deadline - SECONDS ))
        (( left > 0 )) || left=0
        line="$(wait_for_cscb_ad_call "${n}" "${left}" "${step}" version)" || exit 1
        call_fields "${step}" "${line}"
        [[ "${CALL_PPID}" == "${SERVER_PID}" ]] && return 0
        n=$(( n + 1 ))
    done
}

# settle_probe <step>: after the last call_fields line (a probe), wait until
# its process has ended, then PROBE_SETTLE_S for the tick's listeners (the
# settings re-read) to act on it.
settle_probe() {
    wait_until 15 "$1: the probe ${CALL_PID} did not end" _scenario_pid_gone "${CALL_PID}"
    sleep "${PROBE_SETTLE_S}"
}

# cscb_calls_between <from> <to> <verb> [<fragment>...]: how many of CSCB's
# calls matching <verb> and the fragments were made at or after <from> and
# before <to>.
cscb_calls_between() {
    local a="$1" b="$2"
    shift 2
    cscb_ad_calls "$@" | awk -F'\t' -v a="${a}" -v b="${b}" '$2 >= a && $2 < b' | wc -l | tr -d ' '
}

# first_cscb_call_at_or_after <from> <verb> [<fragment>...]: print the first
# such CSCB call line at or after <from> (nothing when there is none).
first_cscb_call_at_or_after() {
    local a="$1"
    shift
    cscb_ad_calls "$@" | awk -F'\t' -v a="${a}" '$2 >= a { print; exit }'
}

# row_state <instance-id>: a harness `get`'s state (empty when it fails).
row_state() {
    ad_capture get --claude-instance-id "$1"
    (( AD_RC == 0 )) || return 0
    jq -r '.state // empty' "${AD_OUT}"
}

row_state_is() {
    [[ "$(row_state "$1")" == "$2" ]]
}

# row_field <step> <instance-id> <field>: one field of a harness `get` (empty when absent).
row_field() {
    ad_capture get --claude-instance-id "$2"
    (( AD_RC == 0 )) || fail "$1: the harness get of $2 exited ${AD_RC}: $(head -c 300 "${AD_ERR}")"
    jq -r --arg f "$3" '.[$f] // empty' "${AD_OUT}"
}

# launch_start_of <step> <instance-id>: the row's launch start, read with a
# harness `get` of a `pending` row, in epoch seconds.
launch_start_of() {
    local raw
    ad_capture get --claude-instance-id "$2"
    (( AD_RC == 0 )) || fail "$1: the harness get of $2 exited ${AD_RC}: $(head -c 300 "${AD_ERR}")"
    [[ "$(jq -r '.state // empty' "${AD_OUT}")" == pending ]] \
        || fail "$1: $2 reads '$(jq -r '.state // empty' "${AD_OUT}")', not pending"
    raw="$(jq -r '.launch_started_at // empty' "${AD_OUT}")"
    [[ -n "${raw}" ]] || fail "$1: $2's pending row has no launch_started_at: $(head -c 400 "${AD_OUT}")"
    epoch_of "$1" "${raw}"
}

# session_of <step> <instance-id>: the row's tmux session name.
session_of() {
    local s
    s="$(row_field "$1" "$2" tmux_session_name)" || exit 1
    [[ -n "${s}" ]] || fail "$1: $2's row names no tmux session"
    printf '%s\n' "${s}"
}

has_session() {
    "${SCENARIO_REAL_TMUX}" has-session -t "=$1" 2> /dev/null
}

# tmux_session_value <session> <format>: one tmux format value of a session.
tmux_session_value() {
    "${SCENARIO_REAL_TMUX}" display-message -p -t "=$1:" "$2" 2> /dev/null
}

# log_time <line>: the epoch seconds of a server.log line's ISO prefix.
log_time() {
    local stamp="${1#\[}"
    stamp="${stamp%%\]*}"
    epoch_of "server.log line" "${stamp}"
}

# log_lines <matcher>: print the server.log lines that match.
log_lines() {
    local file="${SLACK_STATE_DIR}/server.log" m="$1"
    [[ -f "${file}" ]] || return 0
    LC_ALL=C awk '
        BEGIN { n = split(ARGV[3], frags, ARGV[2]); ARGV[2] = ""; ARGV[3] = "" }
        {
            rest = $0
            for (i = 1; i <= n; i++) {
                if (frags[i] == "") continue
                p = index(rest, frags[i])
                if (p == 0) next
                rest = substr(rest, p + length(frags[i]))
            }
            print
        }' "${file}" "${SCENARIO_SEP}" "${m}"
}

# lines_ending_with <text>: how many server.log lines end with <text>.
lines_ending_with() {
    local file="${SLACK_STATE_DIR}/server.log"
    [[ -f "${file}" ]] || { echo 0; return 0; }
    LC_ALL=C awk -v want="$1" '
        { n0 = length($0); n1 = length(want); if (n0 >= n1 && substr($0, n0 - n1 + 1) == want) n++ }
        END { print n + 0 }' "${file}"
}

# posts_to <channel>: the stub record's chat.postMessage lines to <channel>, compact JSON.
posts_to() {
    [[ -f "${STUB_RECORD}" ]] || return 0
    jq -c --arg c "$1" 'select(.event == "api" and .method == "chat.postMessage" and (.channel // "") == $c)' "${STUB_RECORD}"
}

post_count() {
    posts_to "$1" | wc -l | tr -d ' '
}

# relaunch_posts: P's channel's posts whose text is the relaunching notice whole.
relaunch_posts() {
    posts_to "${CHANNEL[p]}" | jq -c --arg t "${RELAUNCH_POST}" 'select((.text // "") == $t)'
}

relaunch_post_seen() {
    [[ -n "$(relaunch_posts)" ]]
}

# The values line's text up to the path: the printer's line for any path, cut
# before that path (the prefix and the words that lead to it, as built).
values_stem() {
    local line
    line="$(printed buildAdSettingsValuesLine "${AD_SETTINGS_FILE}")" || exit 1
    printf '%s\n' "${line%%\"${AD_SETTINGS_FILE}\"*}"
}

# values_lines: how many server.log lines are values lines (any values).
values_lines() {
    count_log "${VALUES_STEM}"
}

# expect_one_values_line <step> <count-before> <expected-line>: since
# <count-before>, exactly one values line, ending with <expected-line>.
expect_one_values_line() {
    local step="$1" before="$2" want="$3" last
    wait_for_count "${VALUES_STEM}" "$(( before + 1 ))" "${LOG_WAIT_S}" "${step}: no values line"
    [[ "$(values_lines)" == "$(( before + 1 ))" ]] || fail "${step}: $(( $(values_lines) - before )) values lines, not exactly one"
    last="$(_scenario_scan lastline "${SLACK_STATE_DIR}/server.log" "${VALUES_STEM}")"
    [[ "${last}" == *"${want}" ]] || {
        printf '  | got:  %s\n  | want: %s\n' "${last}" "${want}" >&2
        fail "${step}: the values line is not the printer's line"
    }
}

# start_slack_stub: the Slack stub in STUB_DIR, answering ok for the six
# personas' token pairs and refusing any other; export CSCB_SLACK_API_URL.
start_slack_stub() {
    local step="slack stub" api_url pid
    mkdir "${STUB_DIR}" || fail "${step}: could not create ${STUB_DIR}"
    printf '%s\n' "${SUFFIX[@]}" | jq -R . | jq -s '{
        tokens: map({suffix: ., label: ., auth: "ok", connections: "ok"}),
        default: {auth: "invalid_auth", connections: "invalid_auth"}}' \
        | write_file "${STUB_DIR}/control.json"
    (cd "${STUB_DIR}" && exec bun "${SCENARIO_FIXTURES}/slack-stub-server.ts" --record "${STUB_RECORD}" \
        --control "${STUB_DIR}/control.json" --ready-file "${STUB_DIR}/ready.json") > "${STUB_DIR}/stub.out" 2>&1 &
    pid=$!
    track_pid "${pid}"
    wait_for_file "${STUB_DIR}/ready.json" "${STUB_WAIT_S}" "${step}: the Slack stub never wrote its ready file"
    api_url="$(jq -r '.api_url' "${STUB_DIR}/ready.json")"
    [[ "${api_url}" =~ ^http://127\.0\.0\.1:[0-9]+/api/$ ]] || fail "${step}: the stub's api_url '${api_url}' is not loopback"
    export CSCB_SLACK_API_URL="${api_url}"
}

# persona_files <x>: the credentials file and claude config dir of persona <x>.
persona_files() {
    local x="$1"
    mkdir -p "${SCENARIO_ROOT}/claude-config-${x}"
    jq -n --arg b "$(fake_token bot "${SUFFIX[${x}]}")" --arg a "$(fake_token app "${SUFFIX[${x}]}")" '{bot_token: $b, app_token: $a}' \
        | write_file "${CREDS_DIR}/${x}.json" 600
}

# write_personas <x>...: the config with the personas <x>..., in that order,
# and `session_restart_delay` RESTART_DELAY_S when that is set.
write_personas() {
    local x personas="[]" one
    for x in "$@"; do
        one="$(jq -n --arg name "${SCENARIO_TAG}_${x}" --arg creds "${CREDS_DIR}/${x}.json" --arg work "${WORK[${x}]}" \
            --arg cfg "${SCENARIO_ROOT}/claude-config-${x}" --arg ch "${CHANNEL[${x}]}" '{
                name: $name, credentials_file: $creds, working_directory: $work, claude_config_dir: $cfg,
                channels: [{id: $ch, delivery: "all"}], permission_prompts: $ch}')"
        personas="$(jq -c --argjson one "${one}" '. + [$one]' <<< "${personas}")"
    done
    jq -n --argjson personas "${personas}" --argjson port "${SCENARIO_PORT}" --arg delay "${RESTART_DELAY_S}" '{
        personas: $personas,
        bind: "127.0.0.1", port: $port,
        health_check_interval: 0, exit_timeout: 5, resume_enabled: true,
        agent_director_poll_interval_ms: 3600000
    } + (if $delay == "" then {} else {session_restart_delay: ($delay | tonumber)} end)' | write_config
}

# start_live <step> <expected-values-line>: start the server; wait for the
# startup gate's probe (T_GATE) and for exactly one values line, equal to
# <expected-values-line>. Sets T_START (before the start).
start_live() {
    local step="$1" want="$2" n_version values_before
    n_version="$(cscb_ad_count version)"
    values_before="$(values_lines)"
    T_START="$(now_s)"
    start_server --live
    wait_server_probe "${n_version}" "${GATE_WAIT_S}" "${step}: the startup gate's probe"
    T_GATE="${CALL_T}"
    expect_one_values_line "${step}: startup" "${values_before}" "${want}"
}

# restart_with_personas <step> <x>...: a plain stop, the config with the
# personas <x>..., the last-applied record removed (so the start applies
# config.json as it stands, with no preview to confirm: the README's
# "Reload"), and a start (`start_live`).
restart_with_personas() {
    local step="$1"
    shift
    stop_server
    write_personas "$@"
    rm -f -- "${CONFIG}.last-applied" || fail "${step}: could not remove ${CONFIG}.last-applied"
    start_live "${step}" "${VALUES_LINE}"
}

has_cscb_call_at_or_after() {
    [[ -n "$(first_cscb_call_at_or_after "$@")" ]]
}

s_and_p_waiting() {
    row_state_is "${ID[s]}" waiting && row_state_is "${ID[p]}" waiting
}

leg() {
    echo "${TEST_NAME}: leg $1 (at ${SECONDS}s)"
}

# print_cscb_calls <from> <to> <label>: CSCB's calls in [from, to), one line
# each (time from <from>, verb, arguments), for the record.
print_cscb_calls() {
    local a="$1" b="$2" label="$3" line
    echo "${TEST_NAME}: ${label}:"
    while IFS= read -r line; do
        [[ -n "${line}" ]] || continue
        call_fields "${label}" "${line}"
        echo "  | +$(seconds_between "${a}" "${CALL_T}")s ${CALL_VERB} ${_L_ARGS[*]:0:6}"
    done < <(cscb_ad_calls "" | awk -F'\t' -v a="${a}" -v b="${b}" '$2 >= a && $2 < b')
}

# ---------------------------------------------------------------------------
# Set-up
# ---------------------------------------------------------------------------

AD_SETTINGS_FILE=""
write_ad_settings "${TABLE[@]}"
VALUES_STEM="$(values_stem)" || exit 1
[[ -n "${VALUES_STEM}" && "${VALUES_STEM}" == "${VALUES_PREFIX}"* ]] || fail "setup: the values line does not start with AD_SETTINGS_LOG_PREFIX"
VALUES_LINE="$(printed buildAdSettingsValuesLine "${AD_SETTINGS_FILE}" "${TABLE[@]}")" || exit 1
VALUES_LINE_RAISED="$(printed buildAdSettingsValuesLine "${AD_SETTINGS_FILE}" "${TABLE_RAISED[@]}")" || exit 1

start_slack_stub
CREDS_DIR="${SCENARIO_ROOT}/credentials"
mkdir -m 700 "${CREDS_DIR}"
WORK[s]="$(make_workdir s)"
WORK[p]="$(make_workdir p)"
WORK[r]="$(make_workdir r)"
WORK[c1]="$(make_workdir c1)"
WORK[c2]="$(make_workdir c2)"
Q_HELD="$(make_workdir q_held)"
Q_READY="$(make_workdir q_ready)"
WORK[q]="${SCENARIO_ROOT}/work/q_link"
ln -s -- "${Q_HELD}" "${WORK[q]}" || fail "setup: could not link ${WORK[q]} to ${Q_HELD}"
stub_mode "${WORK[s]}" "${STUB_MODE_LINGER_ON_EXIT}"
stub_mode "${WORK[p]}" "${STUB_MODE_UNRECOGNISED}"
stub_mode "${WORK[r]}" "${STUB_MODE_UNRECOGNISED}"
stub_mode "${Q_HELD}" "${STUB_MODE_UNRECOGNISED}"
stub_mode "${Q_READY}" "${STUB_MODE_AT_ONCE}"
stub_mode "${WORK[c1]}" "${STUB_MODE_AT_ONCE}"
stub_mode "${WORK[c2]}" "${STUB_MODE_AT_ONCE}"
for x in s p q r c1 c2; do
    persona_files "${x}"
done

echo "${TEST_NAME}: G ${G_S}s, B ${B_S}s (${B_MINUTES} whole minutes), alert threshold $(( ALERT_MS / 1000 ))s, raised G ${G_RAISED_S}s, re-check every ${RECHECK_S}s, approver pace ${FAST_PACE_MS}/${SLOW_PACE_MS} ms"

# ---------------------------------------------------------------------------
# Leg values: the startup values line
# ---------------------------------------------------------------------------

S_CREATED=""
S_PANE=""

leg_values() {
    leg values
    write_personas s
    start_live "values" "${VALUES_LINE}"
    wait_until "${REPORT_WAIT_S}" "values: S (${ID[s]}) never reported in (waiting)" row_state_is "${ID[s]}" waiting
    # Still one values line once S is up.
    [[ "$(values_lines)" == 1 ]] || fail "values: $(values_lines) values lines since the start, not exactly one"
    echo "${TEST_NAME}: values: $(_scenario_scan lastline "${SLACK_STATE_DIR}/server.log" "${VALUES_STEM}" | cut -c1-200)…"
}

# ---------------------------------------------------------------------------
# Leg stopping: scenario 13's "still stopping" follows the configured window
# ---------------------------------------------------------------------------

leg_stopping() {
    leg stopping
    local session ended_raw end_s n_resume line t1 t2 refused stop_m start_m posts_before entries_before
    local errors_log="${SLACK_STATE_DIR}/startup-errors.log"
    session="$(session_of "stopping" "${ID[s]}")" || exit 1
    S_CREATED="$(tmux_session_value "${session}" '#{session_created}')" || fail "stopping: S's session ${session} has no creation time"
    S_PANE="$(tmux_session_value "${session}" '#{pane_id}')" || fail "stopping: S's session ${session} has no pane"
    [[ "${S_CREATED}" =~ ^[0-9]+$ && "${S_PANE}" =~ ^%[0-9]+$ ]] || fail "stopping: S's session reads created '${S_CREATED}', pane '${S_PANE}'"
    posts_before="$(post_count "${CHANNEL[s]}")"
    entries_before="$(count_in "${errors_log}" "$(matcher "] [${SPAWN_FAILED_LABEL}] " "${REF[s]}")")"
    refused="$(matcher "${REFUSED_FOR}${REF[s]}: ")"
    stop_m="$(matcher "${REFUSED_FOR}${REF[s]}: " "${STILL_STOPPING}")"
    start_m="$(matcher "${REFUSED_FOR}${REF[s]}: " "${STILL_STARTING}")"
    [[ "$(count_log "${refused}")" == 0 ]] || fail "stopping: S was refused before the leg"

    stop_server --stop-bots
    wait_until 10 "stopping: S's row does not read ended after stop --stop-bots" row_state_is "${ID[s]}" ended
    ended_raw="$(row_field "stopping" "${ID[s]}" ended_at)" || exit 1
    [[ -n "${ended_raw}" ]] || fail "stopping: S's ended row has no ended_at"
    end_s="$(epoch_of "stopping" "${ended_raw}")" || exit 1
    pid_alive "$(tmux_session_value "${session}" '#{pane_pid}')" && has_session "${session}" \
        || fail "stopping: S's worker or session ${session} is gone after stop --stop-bots (the stub did not linger)"
    echo "${TEST_NAME}: stopping: S's row ended at ${ended_raw}; its session ${session} was created $(( ${end_s%.*} - S_CREATED ))s before"

    n_resume="$(cscb_ad_count resume --claude-instance-id "${ID[s]}")"
    start_live "stopping" "${VALUES_LINE}"
    line="$(wait_for_cscb_ad_call "${n_resume}" "${LAUNCH_WAIT_S}" "stopping: no resume of S" resume --claude-instance-id "${ID[s]}")" || exit 1
    call_fields "stopping" "${line}"
    t1="${CALL_T}"
    wait_for_count "${refused}" 1 "${LOG_WAIT_S}" "stopping: S's first resume was not refused"
    [[ "$(count_log "${stop_m}")" == 1 ]] \
        || fail "stopping: S's first refusal does not carry STILL_STOPPING_PHRASE: $(_scenario_scan lastline "${SLACK_STATE_DIR}/server.log" "${refused}")"
    time_before "$(seconds_between "${end_s}" "${t1}")" "${STOPPING_S}" \
        || fail "stopping: S's still-stopping resume came $(seconds_between "${end_s}" "${t1}")s after the row's end, not inside ${STOPPING_S}s"
    echo "${TEST_NAME}: stopping: resume 1 at +$(seconds_between "${end_s}" "${t1}")s from the row's end: still stopping"

    line="$(wait_for_cscb_ad_call "$(( n_resume + 1 ))" "${RETRY_WAIT_S}" "stopping: no second resume of S" resume --claude-instance-id "${ID[s]}")" || exit 1
    call_fields "stopping" "${line}"
    t2="${CALL_T}"
    pid_alive "$(tmux_session_value "${session}" '#{pane_pid}')" && has_session "${session}" \
        || fail "stopping: S's old worker had stopped by its second resume"
    # More than the window after the row's end: its recorded `ended_at`, the
    # time agent-director measures its stopping window from.
    time_before "$(time_plus "${end_s}" "${STOPPING_S}")" "${t2}" \
        || fail "stopping: S's second resume came $(seconds_between "${end_s}" "${t2}")s after the row's end, not more than ${STOPPING_S}s"
    time_before "$(seconds_between "${S_CREATED}" "${t2}")" "${STARTING_S}" \
        || fail "stopping: S's session was $(seconds_between "${S_CREATED}" "${t2}")s old at the second resume, not younger than ${STARTING_S}s"
    wait_for_count "${refused}" 2 "${LOG_WAIT_S}" "stopping: S's second resume was not refused"
    [[ "$(count_log "${stop_m}")" == 1 ]] || fail "stopping: a still-stopping refusal for S's resume made after the window"
    [[ "$(count_log "${start_m}")" == 1 ]] \
        || fail "stopping: S's second refusal does not carry STILL_STARTING_PHRASE: $(_scenario_scan lastline "${SLACK_STATE_DIR}/server.log" "${refused}")"
    echo "${TEST_NAME}: stopping: resume 2 at +$(seconds_between "${end_s}" "${t2}")s from the row's end (session $(seconds_between "${S_CREATED}" "${t2}")s old): still starting"

    stub_release "${S_PANE}"
    wait_until "$(( RETRY_WAIT_S + REPORT_WAIT_S ))" "stopping: S never reported in after the release" row_state_is "${ID[s]}" waiting
    (( $(cscb_ad_count resume --claude-instance-id "${ID[s]}") >= n_resume + 3 )) || fail "stopping: S came up without a later resume"
    [[ "$(count_log "${stop_m}")" == 1 ]] || fail "stopping: $(count_log "${stop_m}") still-stopping refusals for S, not exactly one"
    [[ "$(count_log "$(matcher "${LATCH_HEAD}${KEY[s]} ")")" == 0 ]] || fail "stopping: S latched"
    while IFS= read -r line; do
        [[ "${line}" == *"${NO_NOTICE_TAIL}"* ]] || fail "stopping: S's refusal line does not say no spawn-failure notice: ${line}"
    done < <(log_lines "${refused}")
    [[ "$(post_count "${CHANNEL[s]}")" == "${posts_before}" ]] \
        || fail "stopping: $(( $(post_count "${CHANNEL[s]}") - posts_before )) post(s) to S's channel for the refusals"
    [[ "$(count_in "${errors_log}" "$(matcher "] [${SPAWN_FAILED_LABEL}] " "${REF[s]}")")" == "${entries_before}" ]] \
        || fail "stopping: a ${SPAWN_FAILED_LABEL} entry for S"
    [[ "$(count_log "${RELAUNCH_FAILED}${KEY[s]}")" == 0 ]] || fail "stopping: a launch failure of S was counted"
    echo "${TEST_NAME}: stopping: S up after $(cscb_ad_count resume --claude-instance-id "${ID[s]}") resume(s) in all, $(count_log "${refused}") refusal(s)"
}

# ---------------------------------------------------------------------------
# Leg held: a launch held at an unrecognised dialog waits on G and gets the
# relaunching post at B
# ---------------------------------------------------------------------------

leg_held() {
    leg held
    local n_spawn line l_p w1 n1 n2 allowed fm post post_t post_log_t kills posts stuck_m
    n_spawn="$(cscb_ad_count spawn --claude-instance-id "${ID[p]}")"
    restart_with_personas "held" s p
    line="$(wait_for_cscb_ad_call "${n_spawn}" "${LAUNCH_WAIT_S}" "held: no spawn of P" spawn --claude-instance-id "${ID[p]}")" || exit 1
    call_fields "held" "${line}"
    [[ "${CALL_PPID}" == "${SERVER_PID}" ]] || fail "held: P's spawn was not made by this server process"
    wait_until "${LAUNCH_WAIT_S}" "held: P's row never read pending" row_state_is "${ID[p]}" pending
    l_p="$(launch_start_of "held" "${ID[p]}")" || exit 1
    echo "${TEST_NAME}: held: P's launch start is $(seconds_between "${CALL_T}" "${l_p}")s after its spawn call"
    wait_until "${REPORT_WAIT_S}" "S never reported in after the start" row_state_is "${ID[s]}" waiting

    # The two windows: (G/2, G) and (G + 5, G + 65) from the launch start.
    w1=$(( G_S / 2 ))
    sleep_until "$(time_plus "${l_p}" "$(( G_S + 65 + 1 ))")"
    allowed=$(( w1 / SLOW_PACE_S + 1 ))
    n1="$(cscb_calls_between "$(time_plus "${l_p}" "${w1}")" "$(time_plus "${l_p}" "${G_S}")" read-pane --claude-instance-id "${ID[p]}")"
    n2="$(cscb_calls_between "$(time_plus "${l_p}" "$(( G_S + 5 ))")" "$(time_plus "${l_p}" "$(( G_S + 65 ))")" read-pane --claude-instance-id "${ID[p]}")"
    echo "${TEST_NAME}: held: P's read-pane calls: ${n1} in (${w1}s, ${G_S}s), ${n2} in ($(( G_S + 5 ))s, $(( G_S + 65 ))s); the slow pace allows ${allowed} in each"
    (( n1 > allowed )) || fail "held: ${n1} read-pane calls of P before G, not more than the slow pace allows (${allowed}): a slower approver read before G"
    (( n2 <= allowed )) || fail "held: ${n2} read-pane calls of P from G, more than the slow pace allows (${allowed})"
    fm="$(cscb_calls_between "${T_START}" "$(time_plus "${l_p}" "${G_S}")" find-missing)"
    [[ "${fm}" == 0 ]] || fail "held: ${fm} CSCB find-missing run(s) before P's launch start plus G"

    # P's relaunch reports in at once.
    stub_mode "${WORK[p]}" "${STUB_MODE_AT_ONCE}"
    wait_until "$(awk -v e="$(time_plus "${l_p}" "$(( B_S + POST_ALLOWANCE_S + 5 ))")" -v n="$(now_s)" 'BEGIN { d = e - n; printf "%d\n", (d > 0 ? d : 0) }')" \
        "held: no relaunching post for P by B + ${POST_ALLOWANCE_S}s" relaunch_post_seen
    sleep 2
    [[ "$(relaunch_posts | wc -l | tr -d ' ')" == 1 ]] || fail "held: $(relaunch_posts | wc -l | tr -d ' ') relaunching posts for P, not exactly one"
    post="$(relaunch_posts)"
    post_t="$(epoch_of "held" "$(jq -r '.ts' <<< "${post}")")" || exit 1
    echo "${TEST_NAME}: held: the relaunching post at +$(seconds_between "${l_p}" "${post_t}")s from P's launch start (B ${B_S}s)"
    time_before "$(time_plus "${l_p}" "${B_S}")" "$(time_plus "${post_t}" 0.001)" || fail "held: the relaunching post came before B"
    time_before "${post_t}" "$(time_plus "${l_p}" "$(( B_S + POST_ALLOWANCE_S ))")" || fail "held: the relaunching post came ${POST_ALLOWANCE_S}s or more after B"
    [[ "$(jq -r '.text' <<< "${post}")" == *"${RELAUNCH_TEXT}"* ]] || fail "held: the post does not hold the relaunching text for P with B"
    posts="$(posts_to "${CHANNEL[p]}" | jq -r '.ts' | while IFS= read -r ts; do epoch_of "held" "${ts}"; done | awk -v t="${post_t}" '$1 < t' | wc -l | tr -d ' ')"
    [[ "${posts}" == 0 ]] || fail "held: ${posts} post(s) to P's channel before the relaunching post"
    stuck_m="$(matcher "${STUCK_LINE_HEAD}${KEY[p]} stuck-launch")"
    line="$(log_lines "${stuck_m}" | head -n 1)"
    [[ -n "${line}" ]] || fail "held: no stuck-launch line for P"
    post_log_t="$(log_time "${line}")" || exit 1
    time_before "$(time_plus "${l_p}" "${B_S}")" "$(time_plus "${post_log_t}" 0.001)" || fail "held: the stuck-launch line came before B: ${line}"
    kills="$(cscb_calls_between "${T_START}" "${post_log_t}" kill --claude-instance-id "${ID[p]}")"
    [[ "${kills}" == 0 ]] || fail "held: ${kills} CSCB kill(s) of P before the relaunching post"
    echo "${TEST_NAME}: held: P's pending-row lines (recorded):"
    log_lines "$(matcher "${STUCK_LINE_HEAD}${KEY[p]} ")" | sed 's/^/  | /' | cut -c1-260

    # The abort, recorded (test-24 asserts it).
    wait_until "${REPORT_WAIT_S}" "held: P never reported in after the abort" row_state_is "${ID[p]}" waiting
    print_cscb_calls "${post_log_t}" "$(now_s)" "held: CSCB's calls from the stuck-launch line until P reported in (recorded)"
    [[ "$(post_count "${CHANNEL[p]}")" == 1 ]] || {
        posts_to "${CHANNEL[p]}" | jq -r '.text' | cut -c1-200 | sed 's/^/  | /' >&2
        fail "held: $(post_count "${CHANNEL[p]}") posts to P's channel, not the one relaunching post"
    }
}

# ---------------------------------------------------------------------------
# Leg sequence: an uncovered held launch's live-row sequence makes no
# find-missing run before G from its launch start
# ---------------------------------------------------------------------------

leg_sequence() {
    leg sequence
    local n_spawn line l_q l_q_ms t_restart t_seq t_armed t_kill fm_line t_fm kill_line n_reuse ref_q not_judged step run l posts_before nj_t
    local seq_start_m armed_line ended_line
    n_spawn="$(cscb_ad_count spawn --claude-instance-id "${ID[q]}")"
    restart_with_personas "sequence" s p q
    wait_for_cscb_ad_call "${n_spawn}" "${LAUNCH_WAIT_S}" "sequence: no spawn of Q" spawn --claude-instance-id "${ID[q]}" > /dev/null
    wait_until "${LAUNCH_WAIT_S}" "sequence: Q's row never read pending" row_state_is "${ID[q]}" pending
    l_q="$(launch_start_of "sequence" "${ID[q]}")" || exit 1
    l_q_ms="$(awk -v t="${l_q}" 'BEGIN { printf "%.0f\n", t * 1000 }')"
    seq_start_m="$(matcher "${LIVE_PREFIX} ${REF[q]}: started at step 1 for ${ID[q]} ")"
    armed_line="$(printed liveRowSequenceWaitArmedLine "${REF[q]}" "${l_q_ms}" "${G_MS}")" || exit 1
    ended_line="$(printed liveRowSequenceWaitEndedLine "${REF[q]}")" || exit 1
    [[ "$(row_field "sequence" "${ID[q]}" cwd)" == "$(realpath -e -- "${Q_HELD}")" ]] \
        || fail "sequence: Q's row records cwd '$(row_field "sequence" "${ID[q]}" cwd)', not q_held's real path"
    wait_until "${REPORT_WAIT_S}" "sequence: S or P never reported in after the start" s_and_p_waiting

    # Re-point Q's working directory (ruling S5): one rename.
    ln -s -- "${Q_READY}" "${WORK[q]}.new" && mv -Tf -- "${WORK[q]}.new" "${WORK[q]}" \
        || fail "sequence: could not re-point ${WORK[q]} to ${Q_READY}"
    [[ "$(realpath -e -- "${WORK[q]}")" == "$(realpath -e -- "${Q_READY}")" ]] || fail "sequence: ${WORK[q]} does not resolve to q_ready"
    posts_before="$(post_count "${CHANNEL[q]}")"
    stop_server
    start_live "sequence restart" "${VALUES_LINE}"
    t_restart="${T_START}"
    time_before "${T_GATE}" "$(time_plus "${l_q}" "${G_S}")" \
        || fail "sequence: the restart's gate came $(seconds_between "${l_q}" "${T_GATE}")s after Q's launch start, not inside G"
    echo "${TEST_NAME}: sequence: restarted $(seconds_between "${l_q}" "${t_restart}")s after Q's launch start"

    # The start sweep (b.jg5 SRJ-714) runs first: it kills the live row whose
    # `cwd` is not the persona's working directory and makes one find-missing
    # run after its kills. Recorded: SRJ-1426's G rule is the live-row
    # sequence's, not the sweep's.
    echo "${TEST_NAME}: sequence: the restart's start sweep lines for Q (recorded):"
    log_lines "$(matcher "${SWEEP_HEAD}" "${ID[q]}")" | cut -c1-260 | sed 's/^/  | /'

    # The live-row sequence: started for Q (the route), its kill before its
    # first run, its step-2 wait armed from Q's launch start with G, and its
    # first run no earlier than the launch start plus G.
    wait_until "${LAUNCH_WAIT_S}" "sequence: hatch gap: the restart started no live-row sequence for Q (the build stops and reports)" \
        _scenario_log_has "${seq_start_m}"
    line="$(log_lines "${seq_start_m}" | tail -n 1)"
    t_seq="$(log_time "${line}")" || exit 1
    time_before "${t_restart}" "${t_seq}" || fail "sequence: Q's live-row sequence started before the restart"
    wait_until "${LOG_WAIT_S}" "sequence: Q's live-row sequence armed no step-2 wait from its launch start with G" \
        _scenario_log_has "${armed_line}"
    line="$(log_lines "${armed_line}" | tail -n 1)"
    t_armed="$(log_time "${line}")" || exit 1
    kill_line="$(first_cscb_call_at_or_after "${t_seq}" kill --claude-instance-id "${ID[q]}")"
    [[ -n "${kill_line}" ]] || fail "sequence: Q's live-row sequence made no kill"
    call_fields "sequence" "${kill_line}"
    t_kill="${CALL_T}"
    time_before "${t_kill}" "${t_armed}" || fail "sequence: Q's live-row sequence made no kill before its step-2 wait"
    wait_until "$(( G_S + LAUNCH_WAIT_S ))" "sequence: Q's live-row sequence made no find-missing run" \
        has_cscb_call_at_or_after "${t_armed}" find-missing
    fm_line="$(first_cscb_call_at_or_after "${t_armed}" find-missing)"
    call_fields "sequence" "${fm_line}"
    t_fm="${CALL_T}"
    echo "${TEST_NAME}: sequence: Q's sequence started at +$(seconds_between "${l_q}" "${t_seq}")s, killed at +$(seconds_between "${l_q}" "${t_kill}")s, its first find-missing at +$(seconds_between "${l_q}" "${t_fm}")s from Q's launch start (G ${G_S}s)"
    [[ "$(cscb_calls_between "${t_seq}" "${t_fm}" find-missing)" == 0 ]] || fail "sequence: a CSCB find-missing between Q's sequence start and its first run"
    if time_before "${t_fm}" "$(time_plus "${l_q}" "${G_S}")"; then
        fail "sequence: Q's live-row sequence made its first find-missing run $(seconds_between "${l_q}" "${t_fm}")s after Q's launch start, before G"
    fi
    line="$(log_lines "${ended_line}" | tail -n 1)"
    [[ -n "${line}" ]] || fail "sequence: Q's live-row sequence logged no end of its step-2 wait"
    if time_before "$(log_time "${line}")" "$(time_plus "${l_q}" "${G_S}")"; then
        fail "sequence: Q's step-2 wait ended before its launch start plus G"
    fi

    # Q brought up by a reuse spawn.
    n_reuse="$(cscb_calls_between "${t_restart}" "$(now_s)" spawn --claude-instance-id "${ID[q]}" --reuse-finished)"
    wait_until "${REPORT_WAIT_S}" "sequence: Q never reported in" row_state_is "${ID[q]}" waiting
    n_reuse="$(cscb_calls_between "${t_restart}" "$(now_s)" spawn --claude-instance-id "${ID[q]}" --reuse-finished)"
    (( n_reuse >= 1 )) || fail "sequence: Q came up with no reuse spawn"
    print_cscb_calls "${t_restart}" "$(now_s)" "sequence: CSCB's calls from the restart until Q reported in (recorded)"

    # A run that left Q's pending row in neither list: nothing follows it.
    ref_q="${REF[q]}"
    for step in 3 4; do
        for run in 1 2 3 4; do
            l="$(printed liveRowSequenceRunLine "${ref_q}" "${step}" "${run}" LIVE_ROW_RUN_NOT_JUDGED)" || exit 1
            not_judged="$(log_lines "${l}" | head -n 1)"
            [[ -n "${not_judged}" ]] || continue
            nj_t="$(log_time "${not_judged}")" || exit 1
            echo "${TEST_NAME}: sequence: a run left Q's row in neither list: ${not_judged}"
            [[ "$(cscb_calls_between "${nj_t}" "$(now_s)" kill --claude-instance-id "${ID[q]}")" == 0 ]] \
                || fail "sequence: a CSCB kill of Q followed a run that left its row in neither list"
        done
    done
    [[ "$(post_count "${CHANNEL[q]}")" == "${posts_before}" ]] || fail "sequence: a post to Q's channel"
}

# ---------------------------------------------------------------------------
# Leg change: a [pause]-only change logs no values line; a changed
# pending_grace_seconds is logged once and used from the next read
# ---------------------------------------------------------------------------

leg_change() {
    leg change
    local n_version before t_probe line n_spawn l_r n allowed session followed
    # [pause]-only.
    before="$(values_lines)"
    write_ad_settings --pause "${PAUSE_TIMEOUT_S}" "${TABLE[@]}"
    n_version="$(cscb_ad_count version)"
    wait_server_probe "${n_version}" "$(( RECHECK_S + PROBE_ALLOWANCE_S ))" "change: no bot-server probe after the [pause]-only change"
    settle_probe "change [pause]"
    [[ "$(values_lines)" == "${before}" ]] || fail "change: a values line followed the [pause]-only change"
    echo "${TEST_NAME}: change: no values line through the probe after the [pause]-only change"

    # The grace period raised.
    before="$(values_lines)"
    write_ad_settings --pause "${PAUSE_TIMEOUT_S}" "${TABLE_RAISED[@]}"
    n_version="$(cscb_ad_count version)"
    wait_server_probe "${n_version}" "$(( RECHECK_S + PROBE_ALLOWANCE_S ))" "change: no bot-server probe after the grace change"
    t_probe="${CALL_T}"
    expect_one_values_line "change: grace raised" "${before}" "${VALUES_LINE_RAISED}"
    line="$(_scenario_scan lastline "${SLACK_STATE_DIR}/server.log" "${VALUES_STEM}")"
    time_before "${t_probe}" "$(time_plus "$(log_time "${line}")" 0.001)" || fail "change: the values line naming ${GRACE_RAISED_S} came before the probe"
    settle_probe "change grace"
    [[ "$(values_lines)" == "$(( before + 1 ))" ]] || fail "change: $(( $(values_lines) - before )) values lines after the grace change, not one"

    # R, added by a confirmed reload.
    n_spawn="$(cscb_ad_count spawn --claude-instance-id "${ID[r]}")"
    write_personas s p q r
    wait_for_file "${CONFIG}.pending" "${RELOAD_WAIT_S}" "change: the reload adding R was not previewed"
    check_pending_layout "change: the reload adding R" added=1
    mv -- "${CONFIG}.pending" "${CONFIG}.apply" || fail "change: could not confirm the reload"
    wait_for_log "${APPLIED_CLASS}" "${RELOAD_WAIT_S}" "change: the reload adding R was not applied"
    wait_for_cscb_ad_call "${n_spawn}" "${LAUNCH_WAIT_S}" "change: no spawn of R" spawn --claude-instance-id "${ID[r]}" > /dev/null
    wait_until "${LAUNCH_WAIT_S}" "change: R's row never read pending" row_state_is "${ID[r]}" pending
    l_r="$(launch_start_of "change" "${ID[r]}")" || exit 1
    sleep_until "$(time_plus "${l_r}" "$(( R_WINDOW_TO_S + 1 ))")"
    allowed=$(( (R_WINDOW_TO_S - R_WINDOW_FROM_S) / SLOW_PACE_S + 1 ))
    n="$(cscb_calls_between "$(time_plus "${l_r}" "${R_WINDOW_FROM_S}")" "$(time_plus "${l_r}" "${R_WINDOW_TO_S}")" read-pane --claude-instance-id "${ID[r]}")"
    echo "${TEST_NAME}: change: R's read-pane calls in (${R_WINDOW_FROM_S}s, ${R_WINDOW_TO_S}s) from its launch start: ${n}; the slow pace allows ${allowed}"
    (( n > allowed )) || fail "change: ${n} read-pane calls of R in (${R_WINDOW_FROM_S}s, ${R_WINDOW_TO_S}s), not more than the slow pace allows (${allowed}): the raised G is not in use"

    session="$(session_of "change" "${ID[r]}")" || exit 1
    stub_press_enter "${session}"
    wait_until "${REPORT_WAIT_S}" "change: R never reported in after the Enter" row_state_is "${ID[r]}" waiting

    # The earlier [tmux] values back, with no [pause] table.
    before="$(values_lines)"
    write_ad_settings "${TABLE[@]}"
    n_version="$(cscb_ad_count version)"
    wait_server_probe "${n_version}" "$(( RECHECK_S + PROBE_ALLOWANCE_S ))" "change: no bot-server probe after the restore"
    settle_probe "change restore"
    followed="$(( $(values_lines) - before ))"
    echo "${TEST_NAME}: change: after the restore, ${followed} values line(s) followed the next probe$( (( followed > 0 )) && [[ "$(_scenario_scan lastline "${SLACK_STATE_DIR}/server.log" "${VALUES_STEM}")" == *"${VALUES_LINE}" ]] && echo ', naming the restored values')"
}

# ---------------------------------------------------------------------------
# Legs refused-stopping and refused-grace: a settings file agent-director
# refuses raises one ad-config-malformed alert per affected persona, changes
# nothing, keeps the last values, and clears once fixed
# ---------------------------------------------------------------------------

# iso_of <epoch-s>: the time as a server.log prefix or a stub record's `ts`
# writes it (UTC, milliseconds), so such times compare as text.
iso_of() {
    date -u -d "@$1" '+%Y-%m-%dT%H:%M:%S.%3NZ'
}

# log_lines_from <from> <to> <matcher>: the server.log lines that match, whose
# ISO prefix is at or after <from> and before <to> (epoch seconds; an empty
# <to> is no bound).
log_lines_from() {
    local a b=""
    a="$(iso_of "$1")"
    [[ -z "$2" ]] || b="$(iso_of "$2")"
    log_lines "$3" | LC_ALL=C awk -v a="${a}" -v b="${b}" '{ t = substr($0, 2, 24) } t >= a && (b == "" || t < b)'
}

count_log_from() {
    log_lines_from "$@" | wc -l | tr -d ' '
}

# split_at_marker <step> <text>: set HEAD and TAIL to <text> before and after
# REFUSED_MARKER, which must occur in it exactly once.
split_at_marker() {
    local rest="${2#*"${REFUSED_MARKER}"}"
    [[ "${rest}" != "$2" && "${rest}" != *"${REFUSED_MARKER}"* ]] \
        || fail "$1: the printer's text does not hold the marker exactly once: $2"
    HEAD="${2%%"${REFUSED_MARKER}"*}"
    TAIL="${rest}"
}

# The marker the printer is given in place of agent-director's description
# and the reader's reason (the scenario's own; neither text holds it).
REFUSED_MARKER='fmk-texts-refused-marker'
# The refused inputs (b.jg5 SRJ-1426's scenario inputs): stopping_window_seconds
# below its minimum, and pending_grace_seconds as a TOML string.
REFUSED_STOPPING_S=10
REFUSED_GRACE_TEXT='"60"'
(( REFUSED_STOPPING_S < MIN_STOPPING )) || fail "setup: ${KEY_STOPPING} ${REFUSED_STOPPING_S} is not below its minimum ${MIN_STOPPING}"
CONFIG_FILE_NAME="$(printed AD_CONFIG_FILE_DISPLAY_NAME)" || exit 1
RETRY_BASE_S="$(printed UNAVAILABLE_RETRY_BASE_S)" || exit 1
RETRY_CEILING_S="$(printed UNAVAILABLE_RETRY_CEILING_S)" || exit 1
[[ "${RETRY_BASE_S}" =~ ^[1-9][0-9]*$ && "${RETRY_CEILING_S}" =~ ^[1-9][0-9]*$ ]] \
    || fail "setup: UNAVAILABLE_RETRY_BASE_S '${RETRY_BASE_S}' or UNAVAILABLE_RETRY_CEILING_S '${RETRY_CEILING_S}' is not a whole number of seconds"
# The ad-config-malformed class, as the all-clear lists it (the printer
# checks it is one of the package's OUTAGE_CLASS_ORDER).
CONFIG_CLASS='ad-config-malformed'
# The refused-read line's fixed parts, for the settings file and a read
# accepted before it (fixtures/fmk-texts.ts buildAdSettingsRefusedReadLine).
line="$(printed buildAdSettingsRefusedReadLine "${AD_SETTINGS_FILE}" "${REFUSED_MARKER}" accepted)" || exit 1
split_at_marker "setup: the refused-read line" "${line}"
REFUSED_HEAD="${HEAD}"
REFUSED_TAIL="${TAIL}"
[[ "${REFUSED_HEAD}" == "${VALUES_PREFIX}"*"\"${AD_SETTINGS_FILE}\""* ]] \
    || fail "setup: the refused-read line's fixed part does not start with AD_SETTINGS_LOG_PREFIX and name ${AD_SETTINGS_FILE}"
# src/restart.ts: the line of a reconciled row that reads dead.
READS_DEAD='[slack] Session reads dead'
# src/server.ts isSessionAlive: `[slack] isSessionAlive: status error for
# persona=<key>: <error> — read as unknown, not dead`.
STATUS_ERROR_HEAD='[slack] isSessionAlive: status error for persona='
STATUS_ERROR_TAIL=' — read as unknown, not dead'
# src/restart.ts: `[slack] Liveness unknown for persona=<key>… — no
# reconnect, kill or launch; nothing counted`.
LIVENESS_UNKNOWN_HEAD='[slack] Liveness unknown for persona='
LIVENESS_UNKNOWN_TAIL=' — no reconnect, kill or launch; nothing counted'
# The again-reason of a retry whose liveness read was unknown.
LIVENESS_UNKNOWN_REASON="$(printed RESTART_OUTCOME_LIVENESS_UNKNOWN)" || exit 1
# src/pending-row.ts: the stuck-launch abort's start line, `[slack]
# pending-row: persona=<key> stuck-launch abort started for <ref> …`.
ABORT_WORDS=' stuck-launch abort started for '
# The personas up when a refused-value leg starts (added to as each leg adds one).
UP_PERSONAS=()

# refused_values_check <label> <x> <key> <key>=<value>...: one refused-value
# sub-leg (b.jg5 SRJ-1426, SRJ-209, SRJ-316, SRJ-1018). With the accepted
# TABLE in effect and every persona of UP_PERSONAS up, the settings file is
# written with the <key>=<value> pairs, which agent-director refuses for
# <key>; after the next bot-server probe persona <x> is added by a confirmed
# reload; its launch meets ErrConfigMalformed and it is retried on its timer
# at least twice, with a bot-server probe inside the refusal; then TABLE is
# written back. Checked:
#   - the refused-read line: exactly one, at the first refused read, with the
#     printer's fixed parts (the file in them) and <key> between them; none at
#     the next read; no values line while refused;
#   - the alert: one onset post to <x>'s channel, with the printer's fixed
#     parts (naming the config file) around agent-director's description;
#     one raise line for <x> and none for another persona; no other post;
#   - nothing done while refused: no CSCB delete, kill or resume, no
#     stuck-launch abort, no counted launch failure and no dead reading for
#     any persona; the one launch call is <x>'s plain spawn at the reload (no
#     launch call for a persona already up); at least two timed retries of
#     <x>, each rerunning its recovery: one `status` call, refused and read
#     as unknown, no launch, nothing counted, and the timer re-armed;
#   - the probe inside the refusal is followed by no all-clear and no clear;
#   - after the fix: <x>'s row reads `waiting`, one all-clear post (the
#     printer's text) made after the fix, one clear line, <x>'s retry timer
#     stops (its pending-only retry reads the row live), and the first
#     bot-server probe after the fix is followed by no values line; no post
#     to any other persona's channel.
refused_values_check() {
    local label="$1" x="$2" key="$3"
    shift 3
    local name="${SCENARIO_TAG}_${x}" y line t_bad t_fix t_onset t_probe n_version n_spawn n_applied
    local values_before refused_before raised_m raised_before onset onset_head onset_tail all_clear cleared
    local post text said n m retries spawns calls ch stopped_m raised_any_m t_read
    local -A posts_before=()
    onset="$(printed formatPersonaNotice "${name}" adConfigMalformedOnset "${REFUSED_MARKER}")" || exit 1
    split_at_marker "${label}: the onset" "${onset}"
    onset_head="${HEAD}"
    onset_tail="${TAIL}"
    [[ "${onset_head}${onset_tail}" == *"${CONFIG_FILE_NAME}"* ]] || fail "${label}: the onset's fixed part does not name ${CONFIG_FILE_NAME}"
    all_clear="$(printed formatPersonaNotice "${name}" ALL_CLEAR_TEMPLATE "${CONFIG_CLASS}")" || exit 1
    line="$(printed adConfigMalformedRaisedLine "${KEY[${x}]}" "${REFUSED_MARKER}")" || exit 1
    split_at_marker "${label}: the raise line" "${line}"
    raised_m="$(matcher "${HEAD}" "${TAIL}")"
    cleared="$(printed adConfigMalformedClearedLine "${KEY[${x}]}")" || exit 1
    # Any persona's raise line: the text before the persona key.
    raised_any_m="$(matcher "${HEAD%%persona=*}persona=")"

    values_before="$(values_lines)"
    refused_before="$(count_log "$(matcher "${REFUSED_HEAD}")")"
    raised_before="$(count_log "${raised_any_m}")"
    for y in "${UP_PERSONAS[@]}" "${x}"; do
        posts_before[${y}]="$(post_count "${CHANNEL[${y}]}")"
    done
    [[ "$(count_log "${raised_m}")" == 0 ]] || fail "${label}: ${name} was raised before the leg"

    # The refused file; the next bot-server probe's read refuses it.
    t_bad="$(now_s)"
    write_ad_settings "$@"
    n_version="$(cscb_ad_count version)"
    wait_server_probe "${n_version}" "$(( RECHECK_S + PROBE_ALLOWANCE_S ))" "${label}: no bot-server probe after the refused file was written"
    t_read="${CALL_T}"
    settle_probe "${label}: the refused read"
    wait_for_count "$(matcher "${REFUSED_HEAD}")" "$(( refused_before + 1 ))" "${LOG_WAIT_S}" "${label}: no refused-read line after the probe"
    [[ "$(count_log "$(matcher "${REFUSED_HEAD}")")" == "$(( refused_before + 1 ))" ]] \
        || fail "${label}: $(( $(count_log "$(matcher "${REFUSED_HEAD}")") - refused_before )) refused-read lines at the first refused read, not one"
    line="$(_scenario_scan lastline "${SLACK_STATE_DIR}/server.log" "$(matcher "${REFUSED_HEAD}")")"
    [[ "${line}" == *"${REFUSED_HEAD}"*"${key}"*"${REFUSED_TAIL}" ]] || {
        printf '  | got:  %s\n  | want: …%s<reason naming %s>%s\n' "${line}" "${REFUSED_HEAD}" "${key}" "${REFUSED_TAIL}" >&2
        fail "${label}: the refused-read line is not the printer's line naming ${key}"
    }
    time_before "${t_read}" "$(time_plus "$(log_time "${line}")" 0.001)" || fail "${label}: the refused-read line came before the probe's read"
    echo "${TEST_NAME}: ${label}: refused-read line: ${line#*"${REFUSED_HEAD}"}"
    [[ "$(values_lines)" == "${values_before}" ]] || fail "${label}: a values line at the refused read"

    # Persona <x> added by a confirmed reload.
    n_spawn="$(cscb_ad_count spawn --claude-instance-id "${ID[${x}]}")"
    n_applied="$(count_log "${APPLIED_CLASS}")"
    UP_PERSONAS+=("${x}")
    write_personas "${UP_PERSONAS[@]}"
    wait_for_file "${CONFIG}.pending" "${RELOAD_WAIT_S}" "${label}: the reload adding ${name} was not previewed"
    check_pending_layout "${label}: the reload adding ${name}" added=1
    mv -- "${CONFIG}.pending" "${CONFIG}.apply" || fail "${label}: could not confirm the reload"
    wait_for_count "${APPLIED_CLASS}" "$(( n_applied + 1 ))" "${RELOAD_WAIT_S}" "${label}: the reload adding ${name} was not applied"
    wait_for_cscb_ad_call "${n_spawn}" "${LAUNCH_WAIT_S}" "${label}: no spawn of ${name}" spawn --claude-instance-id "${ID[${x}]}" > /dev/null

    # The alert: one onset post, the printer's fixed parts around
    # agent-director's description.
    wait_until "${LOG_WAIT_S}" "${label}: no onset post to ${name}'s channel" posts_above "${CHANNEL[${x}]}" "${posts_before[${x}]}"
    wait_until "${LOG_WAIT_S}" "${label}: no raise line for ${name}" _scenario_log_has "${raised_m}"
    post="$(posts_to "${CHANNEL[${x}]}" | tail -n 1)"
    text="$(jq -r '.text' <<< "${post}")"
    [[ "${text}" == "${onset_head}"*"${onset_tail}" ]] && (( ${#text} > ${#onset_head} + ${#onset_tail} )) || {
        printf '  | got:  %s\n  | want: %s<agent-director'"'"'s description>%s\n' "${text}" "${onset_head}" "${onset_tail}" >&2
        fail "${label}: the post to ${name}'s channel is not the printer's onset"
    }
    said="${text#"${onset_head}"}"
    said="${said%"${onset_tail}"}"
    t_onset="$(epoch_of "${label}" "$(jq -r '.ts' <<< "${post}")")" || exit 1
    echo "${TEST_NAME}: ${label}: ${name}'s onset posted; agent-director's description in it: ${said}"

    # A bot-server probe inside the refusal, and at least two timed retries.
    n_version="$(cscb_ad_count version)"
    wait_server_probe "${n_version}" "$(( RECHECK_S + PROBE_ALLOWANCE_S ))" "${label}: no bot-server probe inside the refusal"
    t_probe="${CALL_T}"
    settle_probe "${label}: the probe inside the refusal"
    m="$(rearmed_matcher "${label}" "${x}" 2)" || exit 1
    wait_for_count "${m}" 1 "$(( 3 * RETRY_BASE_S + LAUNCH_WAIT_S ))" "${label}: ${name} was not retried twice on its timer"
    sleep "${PROBE_SETTLE_S}"
    t_fix="$(now_s)"

    # While refused.
    print_cscb_calls "${t_bad}" "${t_fix}" "${label}: CSCB's calls while the file was refused (recorded)"
    echo "${TEST_NAME}: ${label}: ${name}'s server.log lines while refused (recorded):"
    log_lines_from "${t_bad}" "${t_fix}" "$(matcher "${KEY[${x}]}")" | cut -c1-260 | sed 's/^/  | /'
    [[ "$(count_log "$(matcher "${REFUSED_HEAD}")")" == "$(( refused_before + 1 ))" ]] || fail "${label}: a refused-read line at a later refused read"
    [[ "$(values_lines)" == "${values_before}" ]] || fail "${label}: a values line while the file was refused"
    [[ "$(count_log "${raised_m}")" == 1 ]] || fail "${label}: $(count_log "${raised_m}") raise lines for ${name}, not one"
    [[ "$(count_log "${raised_any_m}")" == "$(( raised_before + 1 ))" ]] || fail "${label}: a raise line for a persona other than ${name}"
    [[ "$(count_log "${cleared}")" == 0 ]] || fail "${label}: ${name}'s outage cleared while the file was refused"
    for y in "${UP_PERSONAS[@]}"; do
        n="$(post_count "${CHANNEL[${y}]}")"
        if [[ "${y}" == "${x}" ]]; then
            (( n == posts_before[${x}] + 1 )) || fail "${label}: $(( n - posts_before[${x}] )) posts to ${name}'s channel while refused, not the one onset (the probe at +$(seconds_between "${t_onset}" "${t_probe}")s from it included)"
        else
            (( n == posts_before[${y}] )) || fail "${label}: a post to ${SCENARIO_TAG}_${y}'s channel while refused"
        fi
    done
    for calls in kill delete kill-finished resume; do
        n="$(cscb_calls_between "${t_bad}" "${t_fix}" "${calls}")"
        [[ "${n}" == 0 ]] || fail "${label}: ${n} CSCB ${calls} call(s) while the file was refused"
    done
    # One launch: <x>'s plain spawn at the reload; no launch for a persona already up.
    spawns="$(cscb_calls_between "${t_bad}" "${t_fix}" spawn)"
    n="$(cscb_calls_between "${t_bad}" "${t_fix}" spawn --claude-instance-id "${ID[${x}]}")"
    [[ "${spawns}" == 1 && "${n}" == 1 && "$(cscb_calls_between "${t_bad}" "${t_fix}" spawn --reuse-finished)" == 0 ]] \
        || fail "${label}: ${spawns} CSCB spawn(s) while refused, ${n} of them ${name}'s, not its one plain launch"
    # Each retry reran the recovery: its liveness read refused (read as
    # unknown, not dead), no launch, nothing counted, and the timer re-armed.
    retries=0
    while :; do
        m="$(printed unavailableRetryRetryLine "${KEY[${x}]}" "$(( retries + 1 ))" full)" || exit 1
        [[ "$(count_log "${m}")" == 1 ]] || break
        retries=$(( retries + 1 ))
        m="$(rearmed_matcher "${label}" "${x}" "${retries}")" || exit 1
        [[ "$(count_log "${m}")" == 1 ]] || fail "${label}: ${name}'s retry ${retries} was not re-armed as liveness unknown"
    done
    (( retries >= 2 )) || fail "${label}: ${retries} retries of ${name} while refused, not two or more"
    n="$(cscb_calls_between "${t_bad}" "${t_fix}" status --claude-instance-id "${ID[${x}]}")"
    [[ "${n}" == "${retries}" ]] || fail "${label}: ${n} CSCB status call(s) of ${name} for ${retries} retries"
    n="$(count_log_from "${t_bad}" "${t_fix}" "$(matcher "${STATUS_ERROR_HEAD}${KEY[${x}]}: " "${STATUS_ERROR_TAIL}")")"
    [[ "${n}" == "${retries}" ]] || fail "${label}: ${n} refused liveness read line(s) of ${name} for ${retries} retries"
    n="$(count_log_from "${t_bad}" "${t_fix}" "$(matcher "${LIVENESS_UNKNOWN_HEAD}${KEY[${x}]}" "${LIVENESS_UNKNOWN_TAIL}")")"
    [[ "${n}" == "${retries}" ]] || fail "${label}: ${n} 'no launch; nothing counted' line(s) of ${name} for ${retries} retries"
    n="$(count_log_from "${t_bad}" "${t_fix}" "$(matcher "${STUCK_LINE_HEAD}" "${ABORT_WORDS}")")"
    [[ "${n}" == 0 ]] || fail "${label}: a stuck-launch abort while refused"
    n="$(count_log_from "${t_bad}" "${t_fix}" "$(matcher "${RELAUNCH_FAILED}")")"
    [[ "${n}" == 0 ]] || fail "${label}: a launch failure was counted while refused"
    n="$(count_log_from "${t_bad}" "${t_fix}" "$(matcher "${READS_DEAD}")")"
    [[ "${n}" == 0 ]] || fail "${label}: a persona read as dead while refused"
    echo "${TEST_NAME}: ${label}: ${name} launched once and retried ${retries} times while refused, each retry's liveness read refused; one onset; no all-clear after the probe at +$(seconds_between "${t_onset}" "${t_probe}")s from the onset"

    # The fix: the earlier accepted file.
    write_ad_settings "${TABLE[@]}"
    t_fix="$(now_s)"
    n_version="$(cscb_ad_count version)"
    wait_until "$(( 4 * RETRY_BASE_S + REPORT_WAIT_S ))" "${label}: ${name} never reported in after the fix" row_state_is "${ID[${x}]}" waiting
    wait_until "${LOG_WAIT_S}" "${label}: no all-clear post to ${name}'s channel after the fix" \
        posts_above "${CHANNEL[${x}]}" "$(( posts_before[${x}] + 1 ))"
    # The timer that launched <x> runs on in pending-only mode until a retry
    # reads its row live; the next leg starts once it has stopped, so every
    # persona already up then has no timer.
    line="$(printed unavailableRetryStoppedLine "${KEY[${x}]}" full none "${REFUSED_MARKER}")" || exit 1
    split_at_marker "${label}: the stop line" "${line}"
    stopped_m="$(matcher "${HEAD%" — "}")"
    wait_until "$(( RETRY_CEILING_S + LOG_WAIT_S ))" "${label}: ${name}'s retry timer did not stop after it came up" _scenario_log_has "${stopped_m}"
    echo "${TEST_NAME}: ${label}: ${name}'s retry timer: $(log_lines "${stopped_m}" | tail -n 1 | cut -c1-200)"
    wait_server_probe "${n_version}" "$(( RECHECK_S + PROBE_ALLOWANCE_S ))" "${label}: no bot-server probe after the fix"
    settle_probe "${label}: the read after the fix"
    sleep "${PROBE_SETTLE_S}"
    [[ "$(post_count "${CHANNEL[${x}]}")" == "$(( posts_before[${x}] + 2 ))" ]] \
        || fail "${label}: $(( $(post_count "${CHANNEL[${x}]}") - posts_before[${x}] )) posts to ${name}'s channel, not the onset and one all-clear"
    post="$(posts_to "${CHANNEL[${x}]}" | tail -n 1)"
    [[ "$(jq -r '.text' <<< "${post}")" == "${all_clear}" ]] || {
        printf '  | got:  %s\n  | want: %s\n' "$(jq -r '.text' <<< "${post}")" "${all_clear}" >&2
        fail "${label}: the post after the fix is not the printer's all-clear"
    }
    time_before "${t_fix}" "$(epoch_of "${label}" "$(jq -r '.ts' <<< "${post}")")" || fail "${label}: the all-clear came before the fix"
    [[ "$(count_log "${cleared}")" == 1 ]] || fail "${label}: $(count_log "${cleared}") clear lines for ${name}, not one"
    [[ "$(values_lines)" == "${values_before}" ]] || fail "${label}: a values line after the fix, which left the values unchanged"
    [[ "$(count_log "$(matcher "${REFUSED_HEAD}")")" == "$(( refused_before + 1 ))" ]] || fail "${label}: a refused-read line after the fix"
    for y in "${UP_PERSONAS[@]}"; do
        [[ "${y}" == "${x}" ]] && continue
        ch="$(post_count "${CHANNEL[${y}]}")"
        [[ "${ch}" == "${posts_before[${y}]}" ]] || fail "${label}: a post to ${SCENARIO_TAG}_${y}'s channel"
    done
    echo "${TEST_NAME}: ${label}: after the fix ${name} is up, one all-clear at +$(seconds_between "${t_fix}" "$(epoch_of "${label}" "$(jq -r '.ts' <<< "${post}")")")s, no values line through the next probe"
}

# rearmed_matcher <step> <x> <retry>: a matcher of the re-armed line of
# persona <x>'s full-mode retry <retry> answered liveness-unknown: the
# printer's line up to its reason, the reason, and the words after it up to
# the next wait.
rearmed_matcher() {
    local line
    line="$(printed unavailableRetryReArmedLine "${KEY[$2]}" "$3" full "${REFUSED_MARKER}" 0)" || exit 1
    split_at_marker "$1: the re-armed line" "${line}"
    matcher "${HEAD}${LIVENESS_UNKNOWN_REASON}${TAIL%%,*}"
}

# True when <channel> has more than <n> posts.
posts_above() {
    (( $(post_count "$1") > $2 ))
}

leg_refused_stopping() {
    leg refused-stopping
    # The server restarted with session_restart_delay 0 (health_check_interval
    # is 0 throughout).
    RESTART_DELAY_S=0
    UP_PERSONAS=(s p q r)
    restart_with_personas "refused-stopping" "${UP_PERSONAS[@]}"
    wait_until "${REPORT_WAIT_S}" "refused-stopping: a persona never reported in after the restart" all_up
    refused_values_check refused-stopping c1 "${KEY_STOPPING}" \
        "${KEY_GRACE}=${GRACE_S}" "${KEY_STOPPING}=${REFUSED_STOPPING_S}" "${KEY_STARTING}=${STARTING_S}"
}

leg_refused_grace() {
    leg refused-grace
    refused_values_check refused-grace c2 "${KEY_GRACE}" \
        "${KEY_GRACE}=${REFUSED_GRACE_TEXT}" "${KEY_STOPPING}=${STOPPING_S}" "${KEY_STARTING}=${STARTING_S}"
}

# True when every persona of UP_PERSONAS reads waiting.
all_up() {
    local y
    for y in "${UP_PERSONAS[@]}"; do
        row_state_is "${ID[${y}]}" waiting || return 1
    done
}

# ---------------------------------------------------------------------------
# The legs, in order (later legs of scenario 24 are added before the closing
# assertions)
# ---------------------------------------------------------------------------

leg_values
leg_stopping
leg_held
leg_sequence
leg_change
leg_refused_stopping
leg_refused_grace

# ---------------------------------------------------------------------------
# Closing assertions (b.jg5 SRJ-1401, SRJ-1418)
# ---------------------------------------------------------------------------

assert_no_server_tmux
assert_no_cscb_include_finished
assert_no_cscb_delete

echo "PASS: ${TEST_NAME}"
