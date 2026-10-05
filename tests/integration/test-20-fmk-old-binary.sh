#!/usr/bin/env bash
# Test 20 (HO §7 scenarios 8 and 23; b.jg5 SRJ-1410, SRJ-1425; AC 1, 11, 21,
# 22, 23): this build never runs against an agent-director older than Phase 1
# or a development build. It refuses to start on 0.10.0, stops without
# touching a worker or row when the binary behind the shim becomes 0.10.0
# while it runs, shrugs off a version re-check that cannot run (one log line
# for the run), and on a reuse spawn's ErrInvalidFlags either stops (a
# below-floor binary) or holds the persona with one alert and no delete until
# the binary's version changes (a passing one) (scenario 8). It launches on
# the floor's release-candidate form, refuses the development builds
# `0.0.0-dev` and `dev` at startup, launching nothing, and judges the binary's
# version (`binaryVersion`), never the client's package version (scenario
# 23).
#
# Set-up (fmk mode, lib/scenario.sh): the scenario's own HOME, store and tmux
# server under SCENARIO_ROOT; the agent-director 0.11.0 release installed
# through its install.sh, behind the agent-director shim; the tmux shim in
# front of tmux for every CSCB process, in `log` mode; the Slack stub
# (fixtures/slack-stub-server.ts --record), which records each
# chat.postMessage text whole. agent-director runs at its default settings:
# the scenario HOME's agent-director settings file carries no [tmux] table
# (b.jg5 SRJ-1401; set-up fails if it does). One persona, P (`t20_p`,
# instance `cscb_t20_p`, one channel), whose working directory selects the
# stub worker's `at-once` mode (it reports in with no dialog). Server-wide:
# `health_check_interval` 0 (no health tick can relaunch P; ruling S3),
# `resume_enabled` false (P's finished row is brought back by a reuse spawn,
# never a `resume`), `exit_timeout` 5, and `agent_director_poll_interval_ms`
# at its maximum (3600000), so the permission poller's `list` calls do not
# crowd the shim's log; these are the only delays set, all CSCB's own,
# through its config.
#
# The binary behind the shim (the shim itself stays at the standard path
# throughout, apart from the not-found step):
#   setup        the release (0.11.0)
#   8a           0.10.0 (`swap_ad_binary 0.10.0`), then the release again
#   8b           the release; nothing (`hide_ad_install`: shim and binary
#                moved aside, no agent-director on the server's PATH); the
#                stand-in reporting no parseable version
#                (`restore_ad_install_with_stand_in unparseable pass`); the
#                release
#   8c           0.10.0, then the release once the server has stopped
#   8d           the passing wrapper (`install_ad_stand_in <floor>-rc.1
#                reject`), then the release
#   8e           the release; the below-floor stand-in (`install_ad_stand_in
#                <0.10.0's version> reject`) once the start-pass launch has
#                failed; the release once the server has stopped
#   23a          the stand-in reporting the floor's release-candidate form
#                (`install_ad_stand_in <floor>-rc.1 pass`), then the release
#                once the server has stopped
#   23b          the stand-in reporting the client's development sentinel
#                (`install_ad_stand_in 0.0.0-dev pass`), then the release
#   23c          the stand-in reporting `dev` (`install_ad_stand_in dev
#                pass`), then the release
# The stand-in (fixtures/ad-version-stand-in.sh) hands every call but
# `version` to the image's release binary; with `reject` it turns the reuse
# flag into a flag the release does not define, so the release itself
# answers ErrInvalidFlags.
#
# Waits come from the runtime re-check (src/ad-version-gate.ts
# AD_VERSION_RECHECK_INTERVAL_MS, RECHECK_S below): its first re-check runs
# RECHECK_S after the startup gate passes and each later one RECHECK_S after
# the previous one ends. Every re-check wait is bounded by RECHECK_S plus
# EXIT_ALLOWANCE_S (10 s: the probe, the shutdown and this script's polling),
# and watches shim-log and server-log lines, never a fixed sleep alone. The
# harness's finishing of P's row (8d, 8e) waits out agent-director's default
# windows: `ad_store_mark_finished` needs P's session older than the stopping
# window, and agent-director-admin's `kill-finished` needs it past the
# starting-session bound, so the step first waits, bounded by FINISH_AGE_S +
# 30 s, until tmux reports the session FINISH_AGE_S old (the longer of the
# two defaults, AD_STARTING_BOUND_S and AD_STOPPING_WINDOW_S below, plus
# 2 s). In 8d P's session is already older than that; in 8e, with the server
# stopped, the step waits about five minutes for the session the 8d reuse
# spawn made. The whole script runs about 18 minutes (measured: 1060 s;
# scenario 23's legs take a few seconds of it). A bot-server version probe
# is a CSCB `version` call in the agent-director shim's log whose parent is
# the bot server. The shim's lines carry no server-log timestamp, so every
# time is taken by this script as it polls, or from a shim line's own time
# field.
#
# Legs (in order; none is independent of the ones before it):
#   8a   0.10.0 behind the shim; its reported version is read with a harness
#        `version` call (OLD_VERSION, kept for 8e's stand-in); a live `start`
#        then fails: the CLI reports the daemon's non-zero exit, exactly one
#        `ad-below-phase1-floor` entry equals the startup form of the floor
#        message for OLD_VERSION and the binary's path, with its one
#        server-log line; no spawn, resume, kill, kill-finished, delete or
#        pause call, no new tmux session and no new stub-record line (no
#        Slack connection) from this start. The release goes back.
#   8b   start on the release: P launches and reports in (`waiting`); its row
#        (state, row_version, pid) and tmux session are recorded. Not found:
#        the install is hidden (before the first timed re-check) and the
#        server's PATH holds no agent-director; within RECHECK_S + 10 s one
#        could-not-run line (its prefix
#        AD_VERSION_RECHECK_COULD_NOT_RUN_LOG_PREFIX) naming
#        ErrSystemInstallNotFound, and no probe while hidden. Unparseable:
#        the shim comes back with the unparseable stand-in behind it (a
#        harness `version` call through it exits 0 and reads no version); at
#        the next bot-server probe still exactly one line, the server running.
#        Recovery: the release back; at the next probe (a pass) still one
#        line, the server running.
#   8c   0.10.0 swapped in (the time taken); the server exits within
#        RECHECK_S + 10 s of the swap, with its re-check shutdown line and
#        exactly one new entry, equal to the runtime form of the floor
#        message (OLD_VERSION, the path; it carries RUNTIME_RECHECK_PHRASE
#        and the debug skill), with its one server-log line; no CSCB kill,
#        kill-finished, pause, delete, spawn or resume after the swap. What
#        CSCB's calls met while 0.10.0 sat behind the shim (ErrSchemaMismatch
#        on the migrated store) is printed, not asserted. With the release
#        back: P's worker process and session alive, and its row's state,
#        row_version and pid as recorded in 8b.
#   8d   P's row is finished by harness steps (the method, also 8e's:
#        `ad_store_mark_finished <P> ended`, then agent-director-admin's
#        `kill-finished` through `ad_kill_include_finished`, which ends its
#        session; a harness `get` reads `ended` or `missing`). The passing
#        wrapper goes behind the shim: it reports the floor with an `-rc.1`
#        tag (PASSING_VERSION), and a harness `version` call reads it.
#        fmk-driver.ts's forced reuse of P (through `cscb_run`) prints one
#        `DRIVER:` line naming ErrInvalidFlags and CSCB's class for it, the
#        proof that the wrapper's rejection is a real ErrInvalidFlags through
#        CSCB's production classification. The server starts with the
#        wrapper in place: exactly one CSCB `spawn` carrying
#        --reuse-finished (after the start pass's collision ladder's plain
#        spawn, which collides with P's finished row and launches nothing;
#        printed), directly followed by a bot-server probe (the immediate
#        re-check); the server keeps running; one post to P's channel holds
#        the Cannot launch alert whole; P's row stays finished.
#        Same version: over the next timed re-check, no further launch and
#        no second post. Version change: the release goes back; at the next
#        timed re-check exactly one CSCB reuse spawn for P succeeds and P
#        reads `waiting`; still one alert, no delete. While the hold lasts,
#        from the rejected reuse spawn (its shim line's time) to the timed
#        re-check that read the new version: no CSCB kill, kill-finished,
#        pause, delete, spawn or resume, and no tmux session for P.
#   8e   the server stopped, P's row finished again (as in 8d, once P's new
#        session is past the starting-session bound), the tmux shim in
#        `fail-create`. Start on the release: the gate passes (the bot
#        server's first probe, the time taken) and the start-pass reuse spawn
#        fails (its failure line). Then the tmux shim back to `log` and the
#        below-floor stand-in behind the shim. P's next attempt must be a
#        reuse spawn made before the first timed re-check, with no resume
#        and no plain spawn that did not collide with P's row before it
#        (hatch gap: if it is not, the script fails saying so and the build
#        stops and reports); that rejected spawn is directly followed by a bot-server
#        probe, with no other probe between the swap and it; the server exits
#        with its re-check shutdown line and exactly one more entry, equal to
#        the runtime form for OLD_VERSION, all less than RECHECK_S after the
#        gate; no CSCB kill, kill-finished, delete or pause follows, and P's
#        row (read with the release back) stays finished.
#   23a  the server stopped, P's row finished (from 8e); the stand-in
#        reporting PASSING_VERSION (the floor's `<floor>-rc.N` form) goes
#        behind the shim in `pass` mode, and a harness `version` call reads
#        it. Start: the gate passes (the bot server's first probe; the
#        server keeps running), at least one CSCB launch call (spawn or
#        resume) follows, P reports in (`waiting`), and the start wrote no
#        `ad-below-phase1-floor` entry. The server is stopped and the
#        release goes back.
#   23b  AC 11 first: the installed client's package version
#        (CLIENT_PKG_VERSION, read from the package.json of the client the
#        installed package resolves, as docker/ad-client-check.sh finds it)
#        meets the floor (`meetsPhase1Floor` prints `true`). The stand-in
#        reporting DEV_SENTINEL (`0.0.0-dev`) goes behind the shim; a live
#        `start` fails: the CLI reports the daemon's non-zero exit, exactly
#        one `ad-below-phase1-floor` entry equals the startup form of the
#        floor message for DEV_SENTINEL and the binary's path (it names the
#        floor), with its one server-log line, and no
#        `ad-system-install-unreachable` entry; the start made `version`
#        calls only (at least one), no new tmux session and no new
#        stub-record line. The release goes back.
#   23c  the stand-in reporting GO_BUILD_VERSION (`dev`) goes behind the
#        shim; a live `start` fails as in 23b, launching nothing, with
#        exactly one new `ad-system-install-unreachable` entry naming the
#        reason UNPARSEABLE_REASON and the binary's path (the client's
#        `Client.create()` refuses a version that does not parse) and no
#        new `ad-below-phase1-floor` entry. The release goes back.
#
# Matched values, each printed by fixtures/fmk-texts.ts from the installed
# package (never retyped):
#   FLOOR                PHASE1_FLOOR_VERSION              src/ad-version-gate.ts
#   FLOOR_LABEL          AD_BELOW_PHASE1_FLOOR             src/install-check-labels.ts
#   floor messages       buildBelowPhase1FloorMessage <version> <path> <startup|runtime>
#                                                          src/ad-version-gate.ts
#   RUNTIME_PHRASE       RUNTIME_RECHECK_PHRASE            src/ad-version-gate.ts
#   RECHECK_S            AD_VERSION_RECHECK_INTERVAL_MS / 1000
#                                                          src/ad-version-gate.ts
#   RECHECK_STOP_EXIT    AD_VERSION_RECHECK_STOP_EXIT_CODE src/ad-version-gate.ts
#   COULD_NOT_RUN_PREFIX AD_VERSION_RECHECK_COULD_NOT_RUN_LOG_PREFIX
#                                                          src/ad-version-gate.ts
#   ALERT_TEXT           INVALID_FLAGS_HOLD_ALERT_TEXT     src/invalid-flags-hold.ts
#   ALERT_POST           formatPersonaNotice <P> INVALID_FLAGS_HOLD_ALERT_TEXT
#                                                          src/persona-notifier.ts
#   INVALID_FLAGS_CLASS  classifyAdError ErrInvalidFlags   src/ad-error-class.ts
#   AD_STARTING_BOUND_S  DEFAULT_AD_SETTINGS tmux starting_session_seconds
#                                                          src/ad-settings.ts
#   AD_STOPPING_WINDOW_S DEFAULT_AD_SETTINGS tmux stopping_window_seconds
#                                                          src/ad-settings.ts
#   the settings file    AD_SETTINGS_RELATIVE_PATH (under HOME), AD_TMUX_TABLE
#   and its [tmux] table                                   src/ad-settings.ts
#   DEV_SENTINEL         CLIENT_DEV_SENTINEL_VERSION       src/ad-version-gate.ts
#   UNREACHABLE_LABEL    AD_SYSTEM_INSTALL_UNREACHABLE     src/install-check-labels.ts
#   UNPARSEABLE_REASON   UNREACHABLE_REASON_UNPARSEABLE_VERSION
#                                                          src/ad-version-gate.ts
#   the AC 11 check      meetsPhase1Floor <CLIENT_PKG_VERSION>
#                                                          src/ad-version-gate.ts
# GO_BUILD_VERSION (`dev`, a plain `go build`'s version) is not a CSCB
# constant: it is quoted, citing b.jg5 SRJ-202 and HO §7 scenario 23.
# Lines with no exported builder are matched by a fragment quoted from src/
# (ruling S7), each with its source beside it below. The binary path in the
# floor messages is the client's resolved path of the standard path (the
# shim), read with realpath. The daemon is not this script's child, so its
# exit status is read from the CLI's start report (8a) or, for a re-check
# stop (8c, 8e), from its shutdown line naming the re-check, the one path
# that exits with AD_VERSION_RECHECK_STOP_EXIT_CODE; set-up checks that the
# printer's RECHECK_STOP_EXIT is non-zero, so that line stands for a
# non-zero exit.
#
# Hatch decisions (the Epic's "Hatch gap"):
# - scenario 8's server effects come from the server's own reuse spawn of P
#   (`resume_enabled` false, a finished row): at the start pass under the
#   passing wrapper (8d); after a `fail-create` start-pass failure under the
#   below-floor stand-in (8e). fmk-driver.ts's forced reuse runs under the
#   passing wrapper only;
# - the below-floor binary is the stand-in reporting 0.10.0's own version
#   (read in 8a), since a real 0.10.0 answers ErrSchemaMismatch on the
#   migrated store before it parses flags;
# - the passing wrapper reports PASSING_VERSION, the floor with an `-rc.1`
#   tag: SRJ-202 compares only major.minor.patch, so it passes the floor,
#   and putting the release (exactly the floor) back is the version change
#   that ends the hold (the hold ends only on a different version string);
# - the exit bound is RECHECK_S + EXIT_ALLOWANCE_S, measured from the swap;
# - ErrSchemaMismatch noise while 0.10.0 sits behind the shim is printed,
#   not asserted;
# - scenario 23's release-candidate leg (23a) runs on the stand-in reporting
#   PASSING_VERSION in `pass` mode, every call handed to the release, since
#   the image holds the 0.11.0 release and no release candidate;
# - AC 11: the installed client's package version is the release's (0.11.0),
#   which meets the floor, so the proof is the development-build legs: a
#   CSCB that judged the client's package version would launch on
#   `0.0.0-dev` and `dev`, and it refuses both.
#
# The script ends with the three closing assertions (assert_no_server_tmux,
# assert_no_cscb_include_finished, assert_no_cscb_delete), which count only
# lines whose parent is a CSCB process: the harness's own kill-finished calls
# (8d, 8e) come from this script's shell.
set -euo pipefail

TEST_NAME="test-20-fmk-old-binary"
# shellcheck source=lib/scenario.sh
source "$(dirname "$0")/lib/scenario.sh"

TEXTS="${SCENARIO_FIXTURES}/fmk-texts.ts"

# ---------------------------------------------------------------------------
# Values from src/ (through the printer) and the scenario's own
# ---------------------------------------------------------------------------

FLOOR="$(bun "${TEXTS}" PHASE1_FLOOR_VERSION)" || fail "setup: fmk-texts PHASE1_FLOOR_VERSION"
FLOOR_LABEL="$(bun "${TEXTS}" AD_BELOW_PHASE1_FLOOR)" || fail "setup: fmk-texts AD_BELOW_PHASE1_FLOOR"
RUNTIME_PHRASE="$(bun "${TEXTS}" RUNTIME_RECHECK_PHRASE)" || fail "setup: fmk-texts RUNTIME_RECHECK_PHRASE"
RECHECK_MS="$(bun "${TEXTS}" AD_VERSION_RECHECK_INTERVAL_MS)" || fail "setup: fmk-texts AD_VERSION_RECHECK_INTERVAL_MS"
COULD_NOT_RUN_PREFIX="$(bun "${TEXTS}" AD_VERSION_RECHECK_COULD_NOT_RUN_LOG_PREFIX)" \
    || fail "setup: fmk-texts AD_VERSION_RECHECK_COULD_NOT_RUN_LOG_PREFIX"
ALERT_TEXT="$(bun "${TEXTS}" INVALID_FLAGS_HOLD_ALERT_TEXT)" || fail "setup: fmk-texts INVALID_FLAGS_HOLD_ALERT_TEXT"
INVALID_FLAGS_CLASS="$(bun "${TEXTS}" classifyAdError ErrInvalidFlags)" || fail "setup: fmk-texts classifyAdError ErrInvalidFlags"
[[ "${RECHECK_MS}" =~ ^[0-9]+$ ]] && (( RECHECK_MS > 0 && RECHECK_MS % 1000 == 0 )) \
    || fail "setup: AD_VERSION_RECHECK_INTERVAL_MS '${RECHECK_MS}' is not a whole number of seconds"
RECHECK_S=$(( RECHECK_MS / 1000 ))
# The re-check's stop exits with this status, its shutdown line the one
# path that does; non-zero, so that line stands for a non-zero exit.
RECHECK_STOP_EXIT="$(bun "${TEXTS}" AD_VERSION_RECHECK_STOP_EXIT_CODE)" || fail "setup: fmk-texts AD_VERSION_RECHECK_STOP_EXIT_CODE"
[[ "${RECHECK_STOP_EXIT}" =~ ^[1-9][0-9]*$ ]] \
    || fail "setup: AD_VERSION_RECHECK_STOP_EXIT_CODE '${RECHECK_STOP_EXIT}' is not a non-zero exit status"
# agent-director's default starting-session bound and stopping window, in
# seconds, as CSCB records them; the session age the harness's finishing
# steps wait for (past both).
AD_STARTING_BOUND_S="$(bun "${TEXTS}" DEFAULT_AD_SETTINGS tmux starting_session_seconds)" \
    || fail "setup: fmk-texts DEFAULT_AD_SETTINGS tmux starting_session_seconds"
AD_STOPPING_WINDOW_S="$(bun "${TEXTS}" DEFAULT_AD_SETTINGS tmux stopping_window_seconds)" \
    || fail "setup: fmk-texts DEFAULT_AD_SETTINGS tmux stopping_window_seconds"
[[ "${AD_STARTING_BOUND_S}" =~ ^[1-9][0-9]*$ && "${AD_STOPPING_WINDOW_S}" =~ ^[1-9][0-9]*$ ]] \
    || fail "setup: the default starting-session bound '${AD_STARTING_BOUND_S}' or stopping window '${AD_STOPPING_WINDOW_S}' is not a positive whole number of seconds"
FINISH_AGE_S=$(( (AD_STARTING_BOUND_S > AD_STOPPING_WINDOW_S ? AD_STARTING_BOUND_S : AD_STOPPING_WINDOW_S) + 2 ))

# The allowance on top of RECHECK_S for the probe, the shutdown and this
# script's polling (hatch decision), and so every re-check wait's bound.
EXIT_ALLOWANCE_S=10
RECHECK_WAIT_S=$(( RECHECK_S + EXIT_ALLOWANCE_S ))

# SRJ-202 compares only major.minor.patch, so the floor with a pre-release
# tag passes the floor while reading as a different version string from the
# release put back (src/ad-version-gate.ts meetsPhase1Floor). The `-rc.1`
# suffix is the scenario's own; the floor comes from the printer.
PASSING_VERSION="${FLOOR}-rc.1"

# Scenario 23's development builds: a `make` build without a version stamp
# reports the client's development sentinel; a plain `go build` reports
# `dev`, which CSCB exports no constant for (b.jg5 SRJ-202, which refuses a
# version that does not parse; HO §7 scenario 23).
DEV_SENTINEL="$(bun "${TEXTS}" CLIENT_DEV_SENTINEL_VERSION)" || fail "setup: fmk-texts CLIENT_DEV_SENTINEL_VERSION"
GO_BUILD_VERSION='dev'
UNREACHABLE_LABEL="$(bun "${TEXTS}" AD_SYSTEM_INSTALL_UNREACHABLE)" || fail "setup: fmk-texts AD_SYSTEM_INSTALL_UNREACHABLE"
UNPARSEABLE_REASON="$(bun "${TEXTS}" UNREACHABLE_REASON_UNPARSEABLE_VERSION)" \
    || fail "setup: fmk-texts UNREACHABLE_REASON_UNPARSEABLE_VERSION"

# The installed package under test: lib/scenario.sh's CSCB_PKG_DIR, which
# fmk-texts.ts and fmk-driver.ts read.
CSCB_PKG="${CSCB_PKG_DIR}"

# The release's identity, recorded in the image (docker/Dockerfile.test.base).
AD_RELEASE_JSON=/opt/agent-director/client/release.json
REL_VERSION="$(jq -r '.version // empty' "${AD_RELEASE_JSON}")" || fail "setup: could not read ${AD_RELEASE_JSON}"
[[ -n "${REL_VERSION}" && "${REL_VERSION}" != "${PASSING_VERSION}" ]] \
    || fail "setup: the release's version '${REL_VERSION}' is empty or equals the passing wrapper's ${PASSING_VERSION}"

# Persona P, its one channel and the Slack stub's token suffix.
P_NAME="${SCENARIO_TAG}_p"
P_KEY="$(persona_key "${P_NAME}")"
# src/persona-identity.ts personaInstanceId.
P_ID="cscb_${P_KEY}"
P_REF="$(persona_ref "${P_NAME}")"
P_CHANNEL="C0T20P001"
P_SUFFIX="t20p"
ALERT_POST="$(bun "${TEXTS}" formatPersonaNotice "${P_NAME}" INVALID_FLAGS_HOLD_ALERT_TEXT)" \
    || fail "setup: fmk-texts formatPersonaNotice ${P_NAME} INVALID_FLAGS_HOLD_ALERT_TEXT"

# Fragments quoted from src/ (no exported builder):
# src/cli.ts awaitDaemonStartup / reportDaemonFailure.
START_FAILED_FRAGMENT='[slack] Server failed to start (exit code '
# src/server.ts main(): the re-check's stop callback's shutdown reason, in
# shutdown()'s `[slack] Shutting down: <reason>` line.
RECHECK_SHUTDOWN_LINE='[slack] Shutting down: the runtime version re-check refused the agent-director binary'
# src/session-manager.ts reuseSpawnFailedAt (LAUNCH FAILURE).
REUSE_FAILED_FRAGMENT="[slack] reuseSpawnForPersona: reuse spawn failed for ${P_REF}"
# src/session-manager.ts spawnForPersona (the collision ladder's plain spawn
# meeting a row).
COLLISION_FRAGMENT="[slack] spawnForPersona: ErrInstanceIdCollision for ${P_REF}"
# src/session-manager.ts reuseSpawnForPersona (success).
REUSE_SPAWNED_FRAGMENT="[slack] reuseSpawnForPersona: reuse-spawned ${P_REF}"

# Bounds, in seconds.
STUB_WAIT_S=20      # the Slack stub writing its ready file
GATE_WAIT_S=60      # a start's first bot-server probe (the startup gate)
REPORT_WAIT_S=120   # P launching and reporting in (waiting)
POST_WAIT_S=30      # the Cannot launch alert reaching the stub
END_WAIT_S=30       # a killed session ending
PROBE_SETTLE_S=2    # after a probe's process has ended: the re-check acting on it

# The agent-director verbs that end, pause or remove a worker or row, and the
# launch verbs.
TOUCH_VERBS=(kill kill-finished pause delete spawn resume)

# Set by the legs.
OLD_VERSION=""
AD_BIN_PATH=""
SERVER_PID=""
P_SESSION=""
P_ROW0=""
P_PID0=""
CLIENT_PKG_JSON=""
CLIENT_PKG_VERSION=""
REFUSED_AD_LINES=0
REFUSED_RECORD=0
REFUSED_SESSIONS=""
STUB_DIR="${SCENARIO_ROOT}/slack-stub"
STUB_RECORD="${STUB_DIR}/record.jsonl"

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

# True when <a> <= <b>, both seconds with decimals.
time_at_most() {
    awk -v a="$1" -v b="$2" 'BEGIN { exit !(a <= b) }'
}

# line_count <file>: how many lines <file> holds (0 when there is none).
line_count() {
    if [[ ! -f "$1" ]]; then
        echo 0
        return 0
    fi
    wc -l < "$1" | tr -d ' '
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

# expect_server_probe <step> <line>: <line> is a `version` call whose parent
# is the bot server (SERVER_PID).
expect_server_probe() {
    call_fields "$1" "$2"
    [[ "${CALL_VERB}" == version && "${CALL_PPID}" == "${SERVER_PID}" ]] \
        || fail "$1: the call is '${CALL_VERB}' from ${CALL_PPID}, not a version probe from the bot server ${SERVER_PID}: $2"
}

# wait_server_probe <count-before> <timeout-s> <step>: wait for the next
# bot-server version probe after CSCB's first <count-before> version calls
# (a `start` or `stop` CLI's own calls are skipped); print it. Sets the
# CALL_* fields from it.
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
# its process has ended, then PROBE_SETTLE_S for the re-check to act on it.
settle_probe() {
    wait_until 15 "$1: the probe ${CALL_PID} did not end" _scenario_pid_gone "${CALL_PID}"
    sleep "${PROBE_SETTLE_S}"
}

# next_cscb_line_after <line>: print the CSCB call line that follows <line>
# among CSCB's calls (any verb); nothing when none does yet.
next_cscb_line_after() {
    local lines=() i
    mapfile -t lines < <(cscb_ad_calls "")
    for i in "${!lines[@]}"; do
        if [[ "${lines[i]}" == "$1" ]]; then
            printf '%s\n' "${lines[i + 1]:-}"
            return 0
        fi
    done
    return 0
}

# expect_directly_followed_by_probe <step> <line>: the next CSCB call after
# <line> is a bot-server version probe (waited for, bounded).
expect_directly_followed_by_probe() {
    local step="$1" line="$2" next=""
    wait_until 30 "${step}: no CSCB call followed ${line}" next_cscb_line_exists "${line}"
    next="$(next_cscb_line_after "${line}")"
    expect_server_probe "${step}: the CSCB call right after the rejected reuse spawn" "${next}"
}

# cscb_calls_before <time> <verb> [<fragment>...]: how many of CSCB's calls
# matching <verb> and the fragments (`cscb_ad_calls`) were made before <time>.
cscb_calls_before() {
    local t="$1"
    shift
    cscb_ad_calls "$@" | awk -F'\t' -v t="${t}" '$2 < t' | wc -l | tr -d ' '
}

# cscb_calls_strictly_between <from> <to> <verb> [<fragment>...]: how many of
# CSCB's calls matching <verb> and the fragments were made after <from> and
# before <to>.
cscb_calls_strictly_between() {
    local a="$1" b="$2"
    shift 2
    cscb_ad_calls "$@" | awk -F'\t' -v a="${a}" -v b="${b}" '$2 > a && $2 < b' | wc -l | tr -d ' '
}

next_cscb_line_exists() {
    [[ -n "$(next_cscb_line_after "$1")" ]]
}

# cscb_counts <array-name>: CSCB's count of each TOUCH_VERBS verb (every
# CSCB call: P is the one persona).
cscb_counts() {
    local -n cscb_counts_out="$1"
    local verb
    cscb_counts_out=()
    for verb in "${TOUCH_VERBS[@]}"; do
        cscb_counts_out["${verb}"]="$(cscb_ad_count "${verb}")"
    done
}

# expect_counts_unchanged <step> <array-name> [<verb>...]: CSCB's count of
# each <verb> (default: every TOUCH_VERBS verb) is as in the array.
expect_counts_unchanged() {
    local step="$1" verb now verbs=()
    local -n expect_counts_before="$2"
    shift 2
    verbs=("$@")
    (( ${#verbs[@]} > 0 )) || verbs=("${TOUCH_VERBS[@]}")
    for verb in "${verbs[@]}"; do
        now="$(cscb_ad_count "${verb}")"
        [[ "${now}" == "${expect_counts_before[${verb}]}" ]] \
            || fail "${step}: CSCB made $(( now - expect_counts_before[${verb}] )) more ${verb} call(s)"
    done
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

# expect_finished <step>: a harness `get` reads P's row `ended` or `missing`.
expect_finished() {
    local state
    state="$(row_state "${P_ID}")"
    [[ "${state}" == ended || "${state}" == missing ]] \
        || fail "$1: P's row reads '${state}', not finished (ended or missing)"
}

# row_snapshot: P's row's state, row_version and pid, from the store
# (read-only), as compact JSON.
row_snapshot() {
    local out
    out="$(ad_store_row "${P_ID}")" || exit 1
    jq -c '.[0] | {state, row_version, pid}' <<< "${out}"
}

has_session() {
    "${SCENARIO_REAL_TMUX}" has-session -t "=$1" 2> /dev/null
}

no_session() {
    ! has_session "$1"
}

# tmux_session_names: the scenario tmux server's session names (none when no
# server runs).
tmux_session_names() {
    "${SCENARIO_REAL_TMUX}" list-sessions -F '#{session_name}' 2> /dev/null | LC_ALL=C sort || true
}

# session_age_at_least <session> <seconds>
session_age_at_least() {
    local created
    created="$("${SCENARIO_REAL_TMUX}" display-message -p -t "=$1:" '#{session_created}' 2> /dev/null)" || return 1
    [[ "${created}" =~ ^[0-9]+$ ]] && (( $(date +%s) - created >= $2 ))
}

# floor_entries <message>: how many startup-errors.log entries are
# `[<time>] [FLOOR_LABEL] <message>` exactly (src/startup-errors.ts).
floor_entries() {
    local file="${SLACK_STATE_DIR}/startup-errors.log"
    [[ -f "${file}" ]] || { echo 0; return 0; }
    LC_ALL=C awk -v want="[${FLOOR_LABEL}] $1" '
        /^\[[^]]*\] / { rest = substr($0, index($0, "] ") + 2); if (rest == want) n++ }
        END { print n + 0 }' "${file}"
}

# floor_entries_any: how many startup-errors.log entries carry FLOOR_LABEL.
floor_entries_any() {
    count_in "${SLACK_STATE_DIR}/startup-errors.log" "] [${FLOOR_LABEL}] "
}

# server_log_entry_lines <message>: how many server.log lines end with
# `[FLOOR_LABEL] <message>` (the entry's copy on the daemon's stderr).
server_log_entry_lines() {
    local file="${SLACK_STATE_DIR}/server.log"
    [[ -f "${file}" ]] || { echo 0; return 0; }
    LC_ALL=C awk -v want="[${FLOOR_LABEL}] $1" '
        { n0 = length($0); n1 = length(want); if (n0 >= n1 && substr($0, n0 - n1 + 1) == want) n++ }
        END { print n + 0 }' "${file}"
}

# expect_one_floor_entry <step> <message> <same-before> <any-before>: this
# step added exactly one entry, equal to <message>: entries equal to it are
# <same-before> + 1, entries of FLOOR_LABEL <any-before> + 1, and server.log
# lines carrying it <same-before> + 1.
expect_one_floor_entry() {
    local step="$1" msg="$2" same="$3" any="$4" n
    n="$(floor_entries "${msg}")"
    if [[ "${n}" != "$(( same + 1 ))" ]]; then
        sed 's/^/  | /' "${SLACK_STATE_DIR}/startup-errors.log" >&2 2> /dev/null || true
        printf '  | want: [%s] %s\n' "${FLOOR_LABEL}" "${msg}" >&2
        fail "${step}: $(( n - same )) new ${FLOOR_LABEL} entr(y/ies) equal to the expected message, not exactly one"
    fi
    n="$(floor_entries_any)"
    [[ "${n}" == "$(( any + 1 ))" ]] || fail "${step}: ${n} ${FLOOR_LABEL} entries in all, not ${any} + 1"
    n="$(server_log_entry_lines "${msg}")"
    [[ "${n}" == "$(( same + 1 ))" ]] || fail "${step}: $(( n - same )) new server.log line(s) carry the ${FLOOR_LABEL} entry, not exactly one"
}

# alert_posts: how many chat.postMessage texts in the stub's record hold the
# Cannot launch alert.
alert_posts() {
    [[ -f "${STUB_RECORD}" ]] || { echo 0; return 0; }
    jq -c --arg t "${ALERT_TEXT}" \
        'select(.event == "api" and .method == "chat.postMessage" and ((.text // "") | contains($t)))' \
        "${STUB_RECORD}" | wc -l | tr -d ' '
}

alert_posts_at_least() {
    (( $(alert_posts) >= $1 ))
}

# server_path_has_no_ad <pid>: the bot server's PATH (from its environment)
# names no directory holding an agent-director.
server_path_has_no_ad() {
    local path dirs=() dir
    path="$(tr '\0' '\n' < "/proc/$1/environ" | sed -n 's/^PATH=//p')"
    [[ -n "${path}" ]] || fail "8b not found: could not read the bot server's PATH"
    IFS=: read -r -a dirs <<< "${path}"
    for dir in "${dirs[@]}"; do
        [[ ! -e "${dir}/agent-director" && ! -L "${dir}/agent-director" ]] \
            || fail "8b not found: the bot server's PATH holds ${dir}/agent-director"
    done
}

# start_slack_stub: the Slack stub in STUB_DIR, answering ok for P's token
# pair and refusing any other; export CSCB_SLACK_API_URL.
start_slack_stub() {
    local step="slack stub" api_url pid
    mkdir "${STUB_DIR}" || fail "${step}: could not create ${STUB_DIR}"
    jq -n --arg s "${P_SUFFIX}" \
        '{tokens: [{suffix: $s, label: $s, auth: "ok", connections: "ok"}], default: {auth: "invalid_auth", connections: "invalid_auth"}}' \
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

# finish_p <step>: once tmux reports P's session FINISH_AGE_S old (past
# agent-director's default stopping window and starting-session bound;
# bounded), the harness finishes P's row: `ad_store_mark_finished` (ended),
# then agent-director-admin's kill-finished, which ends its session; a
# harness `get` then reads it finished.
finish_p() {
    local step="$1" session pid t0
    session="$(jq -r '.tmux_session_name // empty' <<< "$(ad get --claude-instance-id "${P_ID}")")"
    [[ -n "${session}" ]] || fail "${step}: P's row names no tmux session"
    t0="${SECONDS}"
    wait_until $(( FINISH_AGE_S + 30 )) "${step}: P's session ${session} never got ${FINISH_AGE_S}s old" \
        session_age_at_least "${session}" "${FINISH_AGE_S}"
    echo "${TEST_NAME}: ${step}: waited $(( SECONDS - t0 ))s for P's session to get ${FINISH_AGE_S}s old"
    pid="$(jq -r '.[0].pid // empty' <<< "$(ad_store_row "${P_ID}")")"
    ad_store_mark_finished "${P_ID}" ended > /dev/null
    ad_kill_include_finished "${P_ID}" > /dev/null
    wait_until "${END_WAIT_S}" "${step}: P's session ${session} outlived kill-finished" no_session "${session}"
    if [[ "${pid}" =~ ^[0-9]+$ ]]; then
        wait_until "${END_WAIT_S}" "${step}: P's worker ${pid} outlived kill-finished" _scenario_pid_gone "${pid}"
    fi
    expect_finished "${step}"
}

leg() {
    echo "${TEST_NAME}: leg $1 (at ${SECONDS}s)"
}

# begin_refused_start: record what a start that must be refused may not
# change: the agent-director shim log's length, the tmux sessions and the
# Slack stub record's length.
begin_refused_start() {
    REFUSED_AD_LINES="$(line_count "${SCENARIO_AD_SHIM_LOG}")"
    REFUSED_RECORD="$(line_count "${STUB_RECORD}")"
    REFUSED_SESSIONS="$(tmux_session_names)"
}

# expect_refused_start <step>: the last `run_start` was refused at startup
# (after begin_refused_start): the CLI reports the daemon's non-zero exit and
# no daemon runs; every agent-director call since then is a `version` call,
# at least one (the daemon refused before it wrote its PID file, so it is not
# in the CSCB record and the shim log is read whole); no new tmux session; no
# new stub-record line (no Slack connection).
expect_refused_start() {
    local step="$1" report pid line verb versions=0 calls=()
    (( START_RC != 0 )) || { cat "${START_OUT}" >&2; fail "${step}: the start exited 0"; }
    report="$(grep -F -- "${START_FAILED_FRAGMENT}" "${START_OUT}" || true)"
    [[ -n "${report}" && "${report}" != *"${START_FAILED_FRAGMENT}0)"* ]] \
        || { sed 's/^/  | /' "${START_OUT}" >&2; fail "${step}: start did not report the daemon's non-zero exit"; }
    pid="$(server_pid)"
    [[ -z "${pid}" ]] || ! pid_alive "${pid}" || fail "${step}: a daemon (${pid}) is running after the refused start"
    mapfile -t calls < <(tail -n "+$(( REFUSED_AD_LINES + 1 ))" "${SCENARIO_AD_SHIM_LOG}" | awk -F'\t' '$1 == "call"')
    for line in ${calls[@]+"${calls[@]}"}; do
        call_fields "${step}" "${line}"
        for verb in "${TOUCH_VERBS[@]}"; do
            [[ "${CALL_VERB}" != "${verb}" ]] || fail "${step}: the refused start made a ${verb} call: ${line}"
        done
        [[ "${CALL_VERB}" != version ]] || versions=$(( versions + 1 ))
    done
    (( versions >= 1 )) || fail "${step}: the refused start made no version probe through the shim"
    echo "${TEST_NAME}: ${step}: the refused start's agent-director calls: ${#calls[@]} (${versions} version)"
    [[ "$(tmux_session_names)" == "${REFUSED_SESSIONS}" ]] || fail "${step}: the refused start left a new tmux session"
    [[ "$(line_count "${STUB_RECORD}")" == "${REFUSED_RECORD}" ]] \
        || fail "${step}: the Slack stub recorded $(( $(line_count "${STUB_RECORD}") - REFUSED_RECORD )) line(s) during the refused start"
}

# launch_count: CSCB's launch calls (spawn and resume).
launch_count() {
    echo $(( $(cscb_ad_count spawn) + $(cscb_ad_count resume) ))
}

launch_count_above() {
    (( $(launch_count) > $1 ))
}

# unreachable_entries: how many startup-errors.log entries carry
# UNREACHABLE_LABEL.
unreachable_entries() {
    count_in "${SLACK_STATE_DIR}/startup-errors.log" "] [${UNREACHABLE_LABEL}] "
}

# read_client_package_version <step>: set CLIENT_PKG_JSON and
# CLIENT_PKG_VERSION from the package metadata of the agent-director client
# the installed package resolves (the field the client's `version()`
# reports), found as docker/ad-client-check.sh finds it: bun's resolver from
# the package's src/, then the nearest directory above the entry point whose
# package.json names agent-director. No agent-director call.
read_client_package_version() {
    local step="$1" entry dir
    entry="$(cd / && RESOLVE_FROM="${CSCB_PKG}/src" bun --no-install -e \
        'process.stdout.write(Bun.resolveSync("agent-director", process.env.RESOLVE_FROM))')" \
        || fail "${step}: the installed package at ${CSCB_PKG} resolves no agent-director client"
    [[ "${entry}" == /* ]] || fail "${step}: the resolved entry point '${entry}' is not an absolute path"
    dir="$(dirname "${entry}")"
    while [[ "${dir}" != / ]]; do
        if [[ -f "${dir}/package.json" && "$(jq -r '.name // empty' "${dir}/package.json")" == agent-director ]]; then
            CLIENT_PKG_JSON="${dir}/package.json"
            CLIENT_PKG_VERSION="$(jq -r '.version // empty' "${CLIENT_PKG_JSON}")"
            [[ -n "${CLIENT_PKG_VERSION}" ]] || fail "${step}: ${CLIENT_PKG_JSON} records no version"
            return 0
        fi
        dir="$(dirname "${dir}")"
    done
    fail "${step}: no agent-director package.json above ${entry}"
}

# ---------------------------------------------------------------------------
# Set-up
# ---------------------------------------------------------------------------

# agent-director's default settings: no [tmux] table in the scenario HOME's
# settings file (b.jg5 SRJ-1401), at the package's AD_SETTINGS_RELATIVE_PATH
# under HOME, the table named as the package's AD_TMUX_TABLE.
AD_SETTINGS_REL="$(bun "${TEXTS}" AD_SETTINGS_RELATIVE_PATH)" || fail "setup: fmk-texts AD_SETTINGS_RELATIVE_PATH"
TMUX_TABLE="$(bun "${TEXTS}" AD_TMUX_TABLE)" || fail "setup: fmk-texts AD_TMUX_TABLE"
[[ -n "${AD_SETTINGS_REL}" && "${AD_SETTINGS_REL}" != /* ]] \
    || fail "setup: the package's AD_SETTINGS_RELATIVE_PATH '${AD_SETTINGS_REL}' is not a relative path"
[[ "${TMUX_TABLE}" =~ ^[a-z_]+$ ]] || fail "setup: the package's AD_TMUX_TABLE '${TMUX_TABLE}' is not a TOML bare key"
AD_CONFIG="${HOME}/${AD_SETTINGS_REL}"
if [[ -e "${AD_CONFIG}" ]] && grep -Eq "^[[:space:]]*\[[[:space:]]*${TMUX_TABLE}[[:space:]]*\]" "${AD_CONFIG}"; then
    fail "setup: ${AD_CONFIG} carries a [${TMUX_TABLE}] table; scenario 8 runs at agent-director's default settings"
fi
AD_BIN_PATH="$(realpath -e -- "${SCENARIO_AD_BIN}")" || fail "setup: cannot resolve ${SCENARIO_AD_BIN}"

start_slack_stub
P_WORK="$(make_workdir p)"
stub_mode "${P_WORK}" "${STUB_MODE_AT_ONCE}"
P_CONFIG_DIR="${SCENARIO_ROOT}/claude-config-p"
mkdir -p "${P_CONFIG_DIR}"
CREDS_DIR="${SCENARIO_ROOT}/credentials"
mkdir -m 700 "${CREDS_DIR}"
jq -n --arg b "$(fake_token bot "${P_SUFFIX}")" --arg a "$(fake_token app "${P_SUFFIX}")" '{bot_token: $b, app_token: $a}' \
    | write_file "${CREDS_DIR}/p.json" 600
jq -n --arg name "${P_NAME}" --arg creds "${CREDS_DIR}/p.json" --arg work "${P_WORK}" --arg cfg "${P_CONFIG_DIR}" \
    --arg ch "${P_CHANNEL}" --argjson port "${SCENARIO_PORT}" '{
        personas: [{
            name: $name, credentials_file: $creds, working_directory: $work, claude_config_dir: $cfg,
            channels: [{id: $ch, delivery: "all"}], permission_prompts: $ch
        }],
        bind: "127.0.0.1", port: $port,
        health_check_interval: 0, exit_timeout: 5, resume_enabled: false,
        agent_director_poll_interval_ms: 3600000
    }' | write_config

echo "${TEST_NAME}: floor ${FLOOR}, release ${REL_VERSION}, passing wrapper ${PASSING_VERSION}, re-check every ${RECHECK_S}s, ErrInvalidFlags class ${INVALID_FLAGS_CLASS}"

# ---------------------------------------------------------------------------
# 8a: a start on 0.10.0 is refused
# ---------------------------------------------------------------------------

leg 8a
swap_ad_binary 0.10.0 "8a: 0.10.0 behind the shim"
ad_capture version
(( AD_RC == 0 )) || fail "8a: the harness version call exited ${AD_RC}: $(head -c 300 "${AD_ERR}")"
OLD_VERSION="$(jq -r '.version // empty' "${AD_OUT}")" || fail "8a: version printed no JSON: $(head -c 300 "${AD_OUT}")"
[[ -n "${OLD_VERSION}" && "${OLD_VERSION}" != "${FLOOR}" && "${OLD_VERSION}" != "${REL_VERSION}" ]] \
    || fail "8a: 0.10.0's binary reports '${OLD_VERSION}', not an older version than the floor ${FLOOR}"
echo "${TEST_NAME}: 8a: 0.10.0's binary reports version ${OLD_VERSION}"

MSG_8A="$(bun "${TEXTS}" buildBelowPhase1FloorMessage "${OLD_VERSION}" "${AD_BIN_PATH}" startup)" \
    || fail "8a: fmk-texts buildBelowPhase1FloorMessage startup"
entries_before="$(floor_entries_any)"
begin_refused_start
run_start --live
expect_refused_start "8a"
expect_one_floor_entry "8a" "${MSG_8A}" 0 "${entries_before}"
swap_ad_binary release "8a: the release back behind the shim"

# ---------------------------------------------------------------------------
# 8b: a re-check that cannot run logs once and changes nothing
# ---------------------------------------------------------------------------

leg 8b
n_version="$(cscb_ad_count version)"
start_server --live
wait_server_probe "${n_version}" "${GATE_WAIT_S}" "8b: the startup gate's probe"
T_GATE="${CALL_T}"
wait_until "${REPORT_WAIT_S}" "8b: P (${P_ID}) never reported in (waiting)" row_state_is "${P_ID}" waiting
ad_capture get --claude-instance-id "${P_ID}"
P_SESSION="$(jq -r '.tmux_session_name // empty' "${AD_OUT}")"
[[ -n "${P_SESSION}" ]] && has_session "${P_SESSION}" || fail "8b: P's row names no running tmux session ('${P_SESSION}')"
P_ROW0="$(row_snapshot)"
P_PID0="$(jq -r '.pid // empty' <<< "${P_ROW0}")"
[[ "${P_PID0}" =~ ^[0-9]+$ ]] && pid_alive "${P_PID0}" || fail "8b: P's row records no live worker pid (${P_ROW0})"
echo "${TEST_NAME}: 8b: P's row ${P_ROW0}, session ${P_SESSION}"

# Not found: before the first timed re-check.
time_at_most "$(seconds_between "${T_GATE}" "$(now_s)")" "$(( RECHECK_S - 15 ))" \
    || fail "8b: P reported in too late to hide the install before the first timed re-check"
cnr="$(count_log "${COULD_NOT_RUN_PREFIX}")"
n_version="$(cscb_ad_count version)"
hide_ad_install "8b: hide the shim and the binary"
server_path_has_no_ad "${SERVER_PID}"
wait_for_count "${COULD_NOT_RUN_PREFIX}" "$(( cnr + 1 ))" "${RECHECK_WAIT_S}" "8b not found: no could-not-run line"
cnr_line="$(_scenario_scan lastline "${SLACK_STATE_DIR}/server.log" "${COULD_NOT_RUN_PREFIX}")"
echo "${TEST_NAME}: 8b: ${cnr_line#*"${COULD_NOT_RUN_PREFIX}"}"
[[ "${cnr_line}" == *ErrSystemInstallNotFound* ]] || fail "8b not found: the could-not-run line does not name ErrSystemInstallNotFound: ${cnr_line}"
pid_alive "${SERVER_PID}" || fail "8b not found: the server stopped"
[[ "$(cscb_ad_count version)" == "${n_version}" ]] || fail "8b not found: a version probe ran while the install was hidden"

# Unparseable.
restore_ad_install_with_stand_in unparseable pass "8b: the shim back with the unparseable stand-in"
ad_capture version
(( AD_RC == 0 )) || fail "8b unparseable: a harness version call through the stand-in exited ${AD_RC}: $(head -c 300 "${AD_ERR}")"
! jq -e '.version' "${AD_OUT}" > /dev/null 2>&1 \
    || fail "8b unparseable: a harness version call through the stand-in reads a version: $(head -c 300 "${AD_OUT}")"
wait_server_probe "${n_version}" "${RECHECK_WAIT_S}" "8b unparseable: no bot-server probe"
settle_probe "8b unparseable"
expect_count "${COULD_NOT_RUN_PREFIX}" "$(( cnr + 1 ))" "8b unparseable: a second could-not-run line in one run"
pid_alive "${SERVER_PID}" || fail "8b unparseable: the server stopped"

# Recovery.
n_version="$(cscb_ad_count version)"
swap_ad_binary release "8b: the release back behind the shim"
wait_server_probe "${n_version}" "${RECHECK_WAIT_S}" "8b recovery: no bot-server probe"
settle_probe "8b recovery"
expect_count "${COULD_NOT_RUN_PREFIX}" "$(( cnr + 1 ))" "8b recovery: a could-not-run line after the pass"
pid_alive "${SERVER_PID}" || fail "8b recovery: the server stopped"

# ---------------------------------------------------------------------------
# 8c: a swap to 0.10.0 stops the server, touching no worker or row
# ---------------------------------------------------------------------------

leg 8c
MSG_RUNTIME="$(bun "${TEXTS}" buildBelowPhase1FloorMessage "${OLD_VERSION}" "${AD_BIN_PATH}" runtime)" \
    || fail "8c: fmk-texts buildBelowPhase1FloorMessage runtime"
declare -A touch_8c=()
cscb_counts touch_8c
entries_before="$(floor_entries_any)"
same_before="$(floor_entries "${MSG_RUNTIME}")"
shutdown_before="$(count_log "${RECHECK_SHUTDOWN_LINE}")"
log_before="$(line_count "${SLACK_STATE_DIR}/server.log")"
ad_lines_before="$(line_count "${SCENARIO_AD_SHIM_LOG}")"
swap_ad_binary 0.10.0 "8c: 0.10.0 behind the shim"
T_SWAP="$(now_s)"
wait_until "${RECHECK_WAIT_S}" "8c: the server still runs ${RECHECK_WAIT_S}s after the swap to 0.10.0" _scenario_pid_gone "${SERVER_PID}"
T_EXIT="$(now_s)"
echo "${TEST_NAME}: 8c: the server exited $(seconds_between "${T_SWAP}" "${T_EXIT}")s after the swap (bound ${RECHECK_WAIT_S}s)"
time_at_most "$(seconds_between "${T_SWAP}" "${T_EXIT}")" "${RECHECK_WAIT_S}" || fail "8c: the server exited after the bound"
_scenario_cscb_after || fail "8c: could not update the CSCB process record"
expect_count "${RECHECK_SHUTDOWN_LINE}" "$(( shutdown_before + 1 ))" "8c: the re-check's shutdown line"
[[ "${MSG_RUNTIME}" == *"${RUNTIME_PHRASE}"* ]] || fail "8c: the runtime floor message lacks RUNTIME_RECHECK_PHRASE"
expect_one_floor_entry "8c" "${MSG_RUNTIME}" "${same_before}" "${entries_before}"
expect_counts_unchanged "8c: after the swap" touch_8c
# Recorded, not asserted: what CSCB's calls met while 0.10.0 sat behind the shim.
echo "${TEST_NAME}: 8c: agent-director calls after the swap: $(tail -n "+$(( ad_lines_before + 1 ))" "${SCENARIO_AD_SHIM_LOG}" | awk -F'\t' '$1 == "call" { print $6 }' | awk '{ print $1 }' | sort | uniq -c | tr -s ' \n' ' ')"
echo "${TEST_NAME}: 8c: server.log lines after the swap naming ErrSchemaMismatch: $(tail -n "+$(( log_before + 1 ))" "${SLACK_STATE_DIR}/server.log" | grep -c ErrSchemaMismatch || true)"
swap_ad_binary release "8c: the release back behind the shim"
pid_alive "${P_PID0}" || fail "8c: P's worker ${P_PID0} is gone after the stop"
has_session "${P_SESSION}" || fail "8c: P's session ${P_SESSION} is gone after the stop"
row_now="$(row_snapshot)"
[[ "${row_now}" == "${P_ROW0}" ]] || fail "8c: P's row reads ${row_now}, not ${P_ROW0} as recorded in 8b"
[[ "$(row_state "${P_ID}")" == "$(jq -r '.state' <<< "${P_ROW0}")" ]] || fail "8c: a harness get of P's row reads another state"

# ---------------------------------------------------------------------------
# 8d: a passing wrapper that rejects the reuse holds P
# ---------------------------------------------------------------------------

leg 8d
finish_p "8d: finish P's row"
install_ad_stand_in "${PASSING_VERSION}" reject "8d: the passing wrapper behind the shim"
ad_capture version
[[ "${AD_RC}" == 0 && "$(jq -r '.version // empty' "${AD_OUT}")" == "${PASSING_VERSION}" ]] \
    || fail "8d: a harness version call through the wrapper reads '$(head -c 300 "${AD_OUT}")', not ${PASSING_VERSION}"

# The driver's forced reuse, a real ErrInvalidFlags through CSCB's classification.
n_reuse="$(cscb_ad_count spawn --reuse-finished)"
driver_out="${SCENARIO_ROOT}/fmk-driver-reuse-spawn.out"
driver_rc=0
cscb_run env "CSCB_PKG_DIR=${CSCB_PKG}" \
    "DRIVER_PERSONA=${P_NAME}" "DRIVER_PERSONA_CHANNEL=${P_CHANNEL}" "DRIVER_WORKING_DIRECTORY=${P_WORK}" \
    bun --no-install "${SCENARIO_FIXTURES}/fmk-driver.ts" reuse-spawn < /dev/null > "${driver_out}" 2> "${driver_out}.err" || driver_rc=$?
mapfile -t driver_lines < <(grep -E '^DRIVER(_FAIL)?:' "${driver_out}" || true)
if (( driver_rc != 0 || ${#driver_lines[@]} != 1 )) || [[ "${driver_lines[0]}" != "DRIVER: FORCED reuse-spawn "* ]]; then
    sed 's/^/  | /' "${driver_out}" >&2
    tail -n 20 "${driver_out}.err" | sed 's/^/  | /' >&2
    fail "8d driver: exited ${driver_rc} with ${#driver_lines[@]} outcome line(s), not one 'DRIVER: FORCED reuse-spawn …' line"
fi
echo "${TEST_NAME}: 8d driver: ${driver_lines[0]:0:400}"
[[ "${driver_lines[0]}" == *" called=true "* && "${driver_lines[0]}" == *" error=ErrInvalidFlags class=${INVALID_FLAGS_CLASS} "* ]] \
    || fail "8d driver: the outcome does not class the answer ErrInvalidFlags (${INVALID_FLAGS_CLASS}): ${driver_lines[0]}"
[[ "${driver_lines[0]}" == *reuse-finished* ]] || fail "8d driver: the ErrInvalidFlags description names no reuse flag"
[[ "$(cscb_ad_count spawn --reuse-finished)" == "$(( n_reuse + 1 ))" ]] \
    || fail "8d driver: the driver made $(( $(cscb_ad_count spawn --reuse-finished) - n_reuse )) reuse spawn(s), not one"
expect_finished "8d driver"

# The server's hold.
declare -A touch_8d=()
cscb_counts touch_8d
n_reuse="$(cscb_ad_count spawn --reuse-finished)"
n_version="$(cscb_ad_count version)"
posts_before="$(alert_posts)"
reuse_ok_before="$(count_log "${REUSE_SPAWNED_FRAGMENT}")"
start_server --live
wait_server_probe "${n_version}" "${GATE_WAIT_S}" "8d: the startup gate's probe"
reuse_line="$(wait_for_cscb_ad_call "${n_reuse}" "${REPORT_WAIT_S}" "8d: no reuse spawn of P at the start pass" spawn --reuse-finished)"
call_fields "8d hold" "${reuse_line}"
# The hold begins at the rejected reuse spawn.
T_HOLD="${CALL_T}"
[[ "${CALL_PPID}" == "${SERVER_PID}" ]] || fail "8d hold: the reuse spawn's parent is ${CALL_PPID}, not the bot server"
expect_directly_followed_by_probe "8d hold" "${reuse_line}"
settle_probe "8d hold"
wait_until "${POST_WAIT_S}" "8d hold: no Cannot launch alert reached the stub" alert_posts_at_least "$(( posts_before + 1 ))"
alert="$(jq -c --arg t "${ALERT_TEXT}" \
    'select(.event == "api" and .method == "chat.postMessage" and ((.text // "") | contains($t)))' "${STUB_RECORD}" | tail -n 1)"
[[ "$(jq -r '.channel // empty' <<< "${alert}")" == "${P_CHANNEL}" ]] || fail "8d hold: the alert went to '$(jq -r '.channel // empty' <<< "${alert}")', not P's channel ${P_CHANNEL}"
jq -e --arg t "${ALERT_POST}" '(.text // "") | contains($t)' <<< "${alert}" > /dev/null \
    || fail "8d hold: the posted alert does not hold the printer's Cannot launch notice for P whole"
pid_alive "${SERVER_PID}" || fail "8d hold: the server stopped"
expect_finished "8d hold"
[[ "$(cscb_ad_count spawn --reuse-finished)" == "$(( n_reuse + 1 ))" ]] || fail "8d hold: more than one reuse spawn of P"
no_session "${P_SESSION}" || fail "8d hold: P has a tmux session"
# Recorded: the start pass's launch calls before the hold (its collision
# ladder's plain spawn, which collides with P's finished row, then the reuse).
echo "${TEST_NAME}: 8d hold: CSCB spawns at the start pass: $(( $(cscb_ad_count spawn) - touch_8d[spawn] )) ($(( $(cscb_ad_count spawn --reuse-finished) - n_reuse )) reuse)"
# The hold has begun: from here no launch, delete or kill for P.
declare -A touch_hold=()
cscb_counts touch_hold

# Same version: one full timed re-check.
n_version="$(cscb_ad_count version)"
wait_server_probe "${n_version}" "${RECHECK_WAIT_S}" "8d same version: no timed bot-server probe"
settle_probe "8d same version"
[[ "$(cscb_ad_count spawn --reuse-finished)" == "$(( n_reuse + 1 ))" ]] || fail "8d same version: a further reuse spawn of P"
[[ "$(alert_posts)" == "$(( posts_before + 1 ))" ]] || fail "8d same version: $(( $(alert_posts) - posts_before )) alerts, not one"
expect_counts_unchanged "8d same version: while the hold lasts" touch_hold
no_session "${P_SESSION}" || fail "8d same version: P has a tmux session"
expect_finished "8d same version"
pid_alive "${SERVER_PID}" || fail "8d same version: the server stopped"

# Version change: the release back.
n_version="$(cscb_ad_count version)"
swap_ad_binary release "8d: the release back behind the shim"
wait_server_probe "${n_version}" "${RECHECK_WAIT_S}" "8d version change: no timed bot-server probe"
T_CHANGE="${CALL_T}"
# From the rejected reuse spawn to the re-check that read the new version:
# no CSCB call of a TOUCH_VERBS verb (every CSCB call is P's).
for verb in "${TOUCH_VERBS[@]}"; do
    n="$(cscb_calls_strictly_between "${T_HOLD}" "${T_CHANGE}" "${verb}")"
    [[ "${n}" == 0 ]] \
        || fail "8d version change: CSCB made ${n} ${verb} call(s) while the hold lasted (after the rejected reuse spawn, before the re-check that read the new version)"
done
wait_for_cscb_ad_call "$(( n_reuse + 1 ))" 30 "8d version change: no reuse spawn of P after the hold ended" spawn --reuse-finished > /dev/null
wait_until "${REPORT_WAIT_S}" "8d version change: P never reported in (waiting)" row_state_is "${P_ID}" waiting
wait_for_count "${REUSE_SPAWNED_FRAGMENT}" "$(( reuse_ok_before + 1 ))" 10 "8d version change: no successful reuse spawn line"
expect_count "${REUSE_SPAWNED_FRAGMENT}" "$(( reuse_ok_before + 1 ))" "8d version change: reuse spawns that succeeded"
[[ "$(cscb_ad_count spawn --reuse-finished)" == "$(( n_reuse + 2 ))" ]] || fail "8d version change: not exactly one reuse spawn after the change"
echo "${TEST_NAME}: 8d version change: CSCB spawns after the hold ended: $(( $(cscb_ad_count spawn) - touch_hold[spawn] )) (1 reuse)"
[[ "$(alert_posts)" == "$(( posts_before + 1 ))" ]] || fail "8d version change: $(( $(alert_posts) - posts_before )) alerts in all, not one"
expect_counts_unchanged "8d version change" touch_hold resume delete kill kill-finished
[[ "$(cscb_ad_count delete)" == 0 ]] || fail "8d version change: a CSCB delete"

# ---------------------------------------------------------------------------
# 8e: a below-floor binary that rejects the reuse stops the server
# ---------------------------------------------------------------------------

leg 8e
stop_server
finish_p "8e: finish P's row again"
tmux_shim_mode fail-create
declare -A touch_8e=()
cscb_counts touch_8e
n_reuse="$(cscb_ad_count spawn --reuse-finished)"
n_version="$(cscb_ad_count version)"
entries_before="$(floor_entries_any)"
same_before="$(floor_entries "${MSG_RUNTIME}")"
shutdown_before="$(count_log "${RECHECK_SHUTDOWN_LINE}")"
failed_before="$(count_log "${REUSE_FAILED_FRAGMENT}")"
start_server --live
wait_server_probe "${n_version}" "${GATE_WAIT_S}" "8e: the startup gate's probe"
T_GATE="${CALL_T}"
wait_for_cscb_ad_call "${n_reuse}" "${REPORT_WAIT_S}" "8e: no start-pass reuse spawn of P" spawn --reuse-finished > /dev/null
wait_for_count "${REUSE_FAILED_FRAGMENT}" "$(( failed_before + 1 ))" 30 "8e: the start-pass reuse spawn's failure was not logged"
tmux_shim_mode log
n_version="$(cscb_ad_count version)"
collided_before="$(count_log "${COLLISION_FRAGMENT}")"
install_ad_stand_in "${OLD_VERSION}" reject "8e: the below-floor stand-in behind the shim"
T_SWAP="$(now_s)"
remaining="$(awk -v g="${T_GATE}" -v n="$(now_s)" -v r="${RECHECK_S}" 'BEGIN { d = g + r - n; printf "%d\n", (d > 0 ? d : 0) }')"
echo "${TEST_NAME}: 8e: the stand-in went in $(seconds_between "${T_GATE}" "${T_SWAP}")s after the gate; ${remaining}s left before the first timed re-check"
reuse_line="$(wait_for_cscb_ad_call "$(( n_reuse + 1 ))" "${remaining}" \
    "8e: hatch gap: P's next attempt is not a reuse spawn made before the first timed re-check (the build stops and reports)" \
    spawn --reuse-finished)"
call_fields "8e" "${reuse_line}"
[[ "${CALL_PPID}" == "${SERVER_PID}" ]] || fail "8e: the reuse spawn's parent is ${CALL_PPID}, not the bot server"
SPAWN_T="${CALL_T}"
# P's next attempt is this reuse spawn: between the swap and it, CSCB made
# no resume, and any plain spawn collided with P's row (launching nothing)
# before the attempt's reuse spawn.
mapfile -t between < <(cscb_ad_calls "" | awk -F'\t' -v a="${T_SWAP}" -v b="${SPAWN_T}" '$2 >= a && $2 < b')
plain=0
verbs_between=()
for line in ${between[@]+"${between[@]}"}; do
    call_fields "8e" "${line}"
    verbs_between+=("${CALL_VERB}")
    [[ "${CALL_VERB}" != resume ]] || fail "8e: hatch gap: P's next attempt made a resume before its reuse spawn (the build stops and reports)"
    [[ "${CALL_VERB}" != spawn ]] || plain=$(( plain + 1 ))
done
echo "${TEST_NAME}: 8e: CSCB calls between the swap and the reuse spawn: ${verbs_between[*]:-none}"
(( $(count_log "${COLLISION_FRAGMENT}") - collided_before >= plain )) \
    || fail "8e: hatch gap: a plain spawn of P after the swap did not collide with its row (the build stops and reports)"
n_version_at_spawn="$(cscb_calls_before "${SPAWN_T}" version)"
[[ "${n_version_at_spawn}" == "${n_version}" ]] \
    || fail "8e: $(( n_version_at_spawn - n_version )) bot-server probe(s) between the swap and the rejected reuse spawn"
expect_directly_followed_by_probe "8e" "${reuse_line}"
deadline="$(awk -v g="${T_GATE}" -v n="$(now_s)" -v r="${RECHECK_S}" 'BEGIN { d = g + r - n; printf "%d\n", (d > 0 ? d : 0) }')"
wait_until "${deadline}" "8e: the server still runs ${RECHECK_S}s after the gate" _scenario_pid_gone "${SERVER_PID}"
T_EXIT="$(now_s)"
echo "${TEST_NAME}: 8e: the server exited $(seconds_between "${T_GATE}" "${T_EXIT}")s after the gate (bound ${RECHECK_S}s)"
awk -v a="$(seconds_between "${T_GATE}" "${T_EXIT}")" -v b="${RECHECK_S}" 'BEGIN { exit !(a < b) }' \
    || fail "8e: the server exited $(seconds_between "${T_GATE}" "${T_EXIT}")s after the gate, not less than ${RECHECK_S}s"
_scenario_cscb_after || fail "8e: could not update the CSCB process record"
expect_count "${RECHECK_SHUTDOWN_LINE}" "$(( shutdown_before + 1 ))" "8e: the re-check's shutdown line"
expect_one_floor_entry "8e" "${MSG_RUNTIME}" "${same_before}" "${entries_before}"
expect_counts_unchanged "8e: after the stop" touch_8e kill kill-finished delete pause
swap_ad_binary release "8e: the release back behind the shim"
expect_finished "8e: after the stop"

# ---------------------------------------------------------------------------
# 23a: the floor's release-candidate form passes the gate and launches
# ---------------------------------------------------------------------------

leg 23a
install_ad_stand_in "${PASSING_VERSION}" pass "23a: the stand-in reporting ${PASSING_VERSION} behind the shim"
ad_capture version
[[ "${AD_RC}" == 0 && "$(jq -r '.version // empty' "${AD_OUT}")" == "${PASSING_VERSION}" ]] \
    || fail "23a: a harness version call through the stand-in reads '$(head -c 300 "${AD_OUT}")', not ${PASSING_VERSION}"
entries_before="$(floor_entries_any)"
n_version="$(cscb_ad_count version)"
n_launch="$(launch_count)"
start_server --live
wait_server_probe "${n_version}" "${GATE_WAIT_S}" "23a: the startup gate's probe"
wait_until "${REPORT_WAIT_S}" "23a: CSCB made no launch call (spawn or resume)" launch_count_above "${n_launch}"
wait_until "${REPORT_WAIT_S}" "23a: P (${P_ID}) never reported in (waiting)" row_state_is "${P_ID}" waiting
pid_alive "${SERVER_PID}" || fail "23a: the server stopped"
[[ "$(floor_entries_any)" == "${entries_before}" ]] \
    || fail "23a: the start on ${PASSING_VERSION} wrote $(( $(floor_entries_any) - entries_before )) ${FLOOR_LABEL} entr(y/ies)"
echo "${TEST_NAME}: 23a: CSCB launch calls from this start: $(( $(launch_count) - n_launch ))"
stop_server
swap_ad_binary release "23a: the release back behind the shim"

# ---------------------------------------------------------------------------
# 23b, 23c: development builds launch nothing; CSCB reads binaryVersion
# ---------------------------------------------------------------------------

# AC 11: the installed client's package version (the field its `version()`
# reports) meets the floor, so a CSCB that judged it would launch on the
# development builds below; their refusals show CSCB judges the binary's
# version (the client's `binaryVersion`).
read_client_package_version "23 (AC 11)"
client_meets="$(bun "${TEXTS}" meetsPhase1Floor "${CLIENT_PKG_VERSION}")" \
    || fail "23 (AC 11): fmk-texts meetsPhase1Floor ${CLIENT_PKG_VERSION}"
[[ "${client_meets}" == true ]] \
    || fail "23 (AC 11): the installed client's package version ${CLIENT_PKG_VERSION} (${CLIENT_PKG_JSON}) does not meet the floor ${FLOOR} (meetsPhase1Floor: ${client_meets}), so the development-build legs cannot show which version CSCB judges"
echo "${TEST_NAME}: 23 (AC 11): the installed client's package version ${CLIENT_PKG_VERSION} (${CLIENT_PKG_JSON}) meets the floor ${FLOOR}"

leg 23b
MSG_DEV="$(bun "${TEXTS}" buildBelowPhase1FloorMessage "${DEV_SENTINEL}" "${AD_BIN_PATH}" startup)" \
    || fail "23b: fmk-texts buildBelowPhase1FloorMessage ${DEV_SENTINEL} startup"
install_ad_stand_in "${DEV_SENTINEL}" pass "23b: the stand-in reporting ${DEV_SENTINEL} behind the shim"
entries_before="$(floor_entries_any)"
same_before="$(floor_entries "${MSG_DEV}")"
unreachable_before="$(unreachable_entries)"
begin_refused_start
run_start --live
expect_refused_start "23b"
expect_one_floor_entry "23b" "${MSG_DEV}" "${same_before}" "${entries_before}"
[[ "$(unreachable_entries)" == "${unreachable_before}" ]] || fail "23b: the refused start wrote an ${UNREACHABLE_LABEL} entry"
swap_ad_binary release "23b: the release back behind the shim"

leg 23c
install_ad_stand_in "${GO_BUILD_VERSION}" pass "23c: the stand-in reporting ${GO_BUILD_VERSION} behind the shim"
entries_before="$(floor_entries_any)"
unreachable_before="$(unreachable_entries)"
begin_refused_start
run_start --live
expect_refused_start "23c"
[[ "$(unreachable_entries)" == "$(( unreachable_before + 1 ))" ]] \
    || fail "23c: $(( $(unreachable_entries) - unreachable_before )) new ${UNREACHABLE_LABEL} entr(y/ies), not exactly one"
entry="$(_scenario_scan lastline "${SLACK_STATE_DIR}/startup-errors.log" "] [${UNREACHABLE_LABEL}] ")"
[[ "${entry}" == *"${UNPARSEABLE_REASON}"* && "${entry}" == *"${AD_BIN_PATH}"* ]] \
    || fail "23c: the ${UNREACHABLE_LABEL} entry does not name the reason ${UNPARSEABLE_REASON} and the binary ${AD_BIN_PATH}: ${entry}"
[[ "$(floor_entries_any)" == "${entries_before}" ]] || fail "23c: the refused start wrote an ${FLOOR_LABEL} entry"
swap_ad_binary release "23c: the release back behind the shim"

# ---------------------------------------------------------------------------
# Closing assertions (b.jg5 SRJ-1401, SRJ-1418)
# ---------------------------------------------------------------------------

assert_no_server_tmux
assert_no_cscb_include_finished
assert_no_cscb_delete

echo "PASS: ${TEST_NAME}"
