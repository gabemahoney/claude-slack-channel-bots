#!/usr/bin/env bash
# Test 0 (b.jg5 SRJ-1306, SRJ-1401, SRJ-1418): the fmk harness's self-check.
# It runs the parts of lib/scenario.sh, fixtures/agent-director-shim.sh and
# fixtures/tmux-shim.sh that every fmk scenario (test-13 to test-28) stands
# on, and checks their effect. tests/runner.sh
# finds it by name and, in version order, runs it right after Tests 1 to 4
# and before every fmk scenario. Its TEST_NAME carries `-fmk-`, so sourcing
# lib/scenario.sh gives it its own HOME, agent-director install (the release
# candidate, through its install.sh, behind the shim), store and tmux server,
# all under SCENARIO_ROOT.
#
# The release candidate's version and commit come from the image's recorded
# release identity (/opt/agent-director-rc/client/release.json), never from a
# literal. The shim log is read as the shim's header states its line format:
# only lines whose first field is `call` are invocations, and a quoted field
# gives back its words through `eval`.
#
# Legs (each a function `leg_<name>`, run in the order LEGS lists them; a
# failing leg prints one FAIL line naming the leg and what it saw):
#   isolation        HOME and TMUX_TMPDIR are under SCENARIO_ROOT and are not
#                    the container user's; TMUX and TMUX_PANE are unset; every
#                    PATH entry is absolute, the scenario's bin directory is
#                    first, no entry holds an `agent-director` (the image's
#                    default binary's directory is gone) and the shell finds
#                    none; `claude` is the stub; bun is still found; the shim
#                    and its log are at the scenario HOME's standard path, and
#                    the container user's own ~/.agent-director/bin holds no
#                    shim log and no `.real` binary.
#   real_binary      the binary behind the shim, run by its own name, reports
#                    the recorded version and commit, and adds no log line.
#   setup_install    after the setup's install the standard path holds the
#                    shim (a regular file, the fixture byte for byte, with its
#                    marker), the release candidate's binary is behind it, a
#                    call through it reports the recorded version, and the
#                    install made the HOME's store.
#   harness_call_log a harness call (`ad_capture`, an argument holding a
#                    space) adds one `call` line: its time is the call's, its
#                    parent is the scenario's own shell ($$) with that shell's
#                    command line, and its words give back the argv exactly.
#   version_probe    bun runs under the scenario HOME: the installed package's
#                    agent-director client resolves the shim at the standard
#                    path, and its version probe (cwd /, scrubbed environment)
#                    gets the recorded version and is logged, its parent bun.
#   tmux_and_store   a harness spawn (the stub as `claude`) runs on the
#                    scenario's own tmux server: the row's socket is under
#                    TMUX_TMPDIR, the scenario shell's tmux reaches the session
#                    on that socket, and the server's environment carries this
#                    SCENARIO_ROOT. `ad_store_id` prints 16 lowercase hex
#                    characters, and an `ad_store_edit` of the spawned row's
#                    labels is what a later harness `get` returns.
#   swap             after a swap to 0.10.0 the shim is in place with 0.10.0
#                    behind it and a call through it reports 0.10.0; after the
#                    swap back, the release candidate again.
#   reinstall        after a second run of the release candidate's install.sh
#                    and its re-shim, the shim is in place with the release
#                    candidate behind it, and the store id is unchanged.
#   hide_restore     hide leaves no file at the standard path and none behind
#                    it, and keeps the log; restore puts the shim back with the
#                    release candidate behind it.
#   log_kept         the harness call's line is still in the log after every
#                    install, swap, hide and restore, and every line of the log
#                    has the format's six fields and a known kind.
#   start_on_010     a nested fmk run written into SCENARIO_ROOT, set to start
#                    on 0.10.0 (SCENARIO_AD_START=0.10.0), holds 0.10.0 behind
#                    the shim, no release-candidate binary anywhere in its HOME
#                    and no store; `install_ad_rc` then puts the release
#                    candidate behind the shim and makes a store with a store
#                    id. The nested run prints a `CHECK:` marker for each of
#                    these checks and then exits 0 without the closing
#                    assertions (it starts no bot server, so it could not meet
#                    their positive controls): the trap fails it with the
#                    closing enforcement's line and no other FAIL line. The
#                    nested run cleans up its own SCENARIO_ROOT.
#   guard_refusals   in subshells, with HOME outside SCENARIO_ROOT (a scratch
#                    directory under /tmp holding a decoy install and store,
#                    and a symlink under SCENARIO_ROOT that resolves to it),
#                    every install, re-shim, swap, hide and restore helper,
#                    `ad`, `ad_store_edit` and `ad_store_id` fails with the
#                    guard's reason, and the decoy is left exactly as it was.
#   shim_check       `check_ad_shim` passes a correct layout and fails, with
#                    its reason, on a symlink to the shim and on a copy of the
#                    shim without its marker line.
#
# The tmux shim's legs call it by its path from the scenario's own shell,
# whose PATH never holds it, or run a harness agent-director spawn with the
# shim's bin directory put first on that one call's PATH. Its delays are kept
# short through `tmux_shim_mode`'s delay, each still longer than the
# agent-director timeout the leg relies on: its create timeout
# (create_timeout_ms, 5000 at its defaults, the longest of its tmux call
# timeouts).
#   tmux_shim_log    in `log` mode a call runs the real tmux (its session
#                    exists, its -P output and an -e value holding a space
#                    reach the caller and the session), and adds one `call`
#                    line: its time is the call's, its pid is not the shell's,
#                    its parent is the scenario's shell ($$) with that shell's
#                    command line, and its words give back the argv exactly.
#                    `tmux_shim_mode` writes `<mode> <delay>` to the mode file
#                    and refuses an unknown mode, a delay for a mode that
#                    takes none and a delay that is not a number.
#   fail_kill        `kill-session`, `kill-pane`, the alias `killp`, the
#                    prefix `kill-ses`, a kill after a global option and a
#                    chained call holding one each exit 1 with one `tmux-shim:`
#                    line on standard error, run nothing (the chained call's
#                    other command prints nothing) and leave the session; other
#                    commands run. After a change to `log`, the next call
#                    kills the session.
#   fail_create      at the shim: `new-session`, its alias `new` and a call
#                    with no command (tmux's default new-session) each exit 1
#                    with no standard output and one `tmux-shim:` line on
#                    standard error, and leave no session; other commands
#                    run. A real agent-director spawn with the shim first on
#                    its PATH reaches the shim (a new-session line whose parent
#                    is that agent-director process), answers
#                    ErrTmuxSessionCreate, makes no session and leaves its row
#                    pending.
#   slow_create      a real spawn's session carries @ad_owner (naming the
#                    spawn's instance) and @ad_pane before the shim's delay
#                    ends (read before its new-session line's time plus the
#                    delay); the spawn answers ErrTmuxUnresponsive with its
#                    session present and its row pending.
#   wedge            a call's line is logged (its pid the call's) while the
#                    call still sleeps; the call then exits 1 no sooner than
#                    the delay (longer than the create timeout), with one
#                    `tmux-shim:` line on standard error, no standard output
#                    and no session made: it ran no tmux.
#   mode_spawns_not_cscb
#                    the tmux log holds lines whose parent is an
#                    agent-director process (the mode legs' harness spawns),
#                    yet `assert_no_server_tmux` fails its positive control:
#                    an agent-director process the harness ran is not one a
#                    CSCB process ran.
#   path_wiring      a command run through `cscb_run` has the tmux shim's bin
#                    directory first on its PATH, then the scenario's PATH; it
#                    is recorded with role `run`, its words, and a `gone`
#                    entry once it ended; `cscb_run` returns its status. The
#                    scenario's shell has no shim on PATH and finds the real
#                    tmux.
#   live_start       (the E17 hatch note) a live one-persona start against the
#                    Slack stub, with the stub as `claude` held at the
#                    dev-channels dialog: the start pass brings it up, the
#                    bot server (recorded with role `server`) has the shim
#                    first on its PATH, its dialog approver sends the keys
#                    through agent-director (a `send-keys` call whose parent
#                    is the bot server) and the row reports in (`waiting`).
#                    No tmux line has the bot server as its parent. The three
#                    closing assertions pass over this start's own lines (the
#                    lines it added, the whole record), and over the lines
#                    from before it both positive controls fail, so both are
#                    met by this start's own lines. `cscb_ad_calls` prints no
#                    harness call. The start is stopped with --stop-bots.
#   harness_include_finished
#                    a harness `kill --include-finished` from the scenario's
#                    shell, from a command substitution and from a pipeline
#                    each add a line whose parent has the shell's command
#                    line (the shell itself, then subshells of it), and
#                    `assert_no_cscb_include_finished` passes.
#   synthetic_server_tmux, synthetic_include_finished, synthetic_delete
#                    in subshells pointed at synthetic logs and records under
#                    SCENARIO_ROOT: each assertion passes a clean log and
#                    fails, naming itself and the reason, on each violating
#                    log (and each positive control on a log that lacks it);
#                    a line whose parent PID a recorded process held only
#                    outside that line's time never counts, nor a stop line;
#                    a line not in the shims' format fails.
#   count_helpers    on a synthetic log, `cscb_ad_count` and `cscb_ad_calls`
#                    count only the calls a CSCB process made in its window:
#                    never a harness call or a stop line; the verb is read past
#                    agent-director's global flags and fragments match in
#                    order.
#   closing_enforcement
#                    nested fmk runs written into SCENARIO_ROOT, each with a
#                    stand-in bot server (a process of the run, recorded as a
#                    bot server, whose agent-director and tmux lines it writes
#                    into its own logs): one that ends with the three closing
#                    assertions passes; one that writes a violating line after
#                    them fails with `after the closing assertions:` and the
#                    assertion's reason; one whose assertions ran over copies
#                    of its logs or in a subshell fails naming exactly those
#                    as not passed; one that fails on its own prints only its
#                    own FAIL line.
# The script then ends with the three closing assertions in its own shell,
# met by the live start's own lines.
# Teardown: an exit hook confirms that the trap stopped the scenario's tmux
# server (its PID gone, no socket under SCENARIO_ROOT answering).
set -euo pipefail

TEST_NAME="test-0-fmk-harness-self-check"
# shellcheck source=lib/scenario.sh
source "$(dirname "$0")/lib/scenario.sh"

SCENARIO_LIB="$(cd "$(dirname "$0")" && pwd)/lib/scenario.sh"

# The release candidate's identity, recorded in the image
# (docker/Dockerfile.test.base).
RC_RELEASE_JSON=/opt/agent-director-rc/client/release.json
[[ -f "${RC_RELEASE_JSON}" ]] || fail "setup: the release candidate's identity ${RC_RELEASE_JSON} is missing"
RC_VERSION="$(jq -r '.version // empty' "${RC_RELEASE_JSON}")" \
    || fail "setup: could not read .version from ${RC_RELEASE_JSON}"
RC_COMMIT="$(jq -r '.commit // empty' "${RC_RELEASE_JSON}")" \
    || fail "setup: could not read .commit from ${RC_RELEASE_JSON}"
[[ -n "${RC_VERSION}" && -n "${RC_COMMIT}" ]] \
    || fail "setup: ${RC_RELEASE_JSON} names no version or no commit"

# The row and tmux session the tmux_and_store leg spawns.
T0_ROW_ID="t0-self-check"
T0_SESSION="t0-self-check"

# Set by the legs: the harness call's log line, the store id, and the
# scenario's tmux server PID.
HARNESS_CALL_LINE=""
T0_STORE_ID=""
T0_TMUX_PID=""
OUTSIDE_HOME=""

# agent-director's create timeout at its defaults (create_timeout_ms 5000;
# src/ad-settings.ts DEFAULT_AD_SETTINGS), the longest of its tmux call
# timeouts, in seconds; and the tmux shim's delays the mode legs set, each
# longer than it.
AD_CREATE_TIMEOUT_S=5
SLOW_CREATE_DELAY_S=10
WEDGE_DELAY_S=7

# The live start: its persona, and bounds in seconds.
LIVE_NAME="${SCENARIO_TAG}_live"
LIVE_KEY="$(persona_key "${LIVE_NAME}")"
# src/persona-identity.ts personaInstanceId.
LIVE_INSTANCE_ID="cscb_${LIVE_KEY}"
LIVE_STUB_WAIT_S=20    # the Slack stub writing its ready file
LIVE_START_WAIT_S=120  # the start pass: one bring-up and one launch
LIVE_REPORT_WAIT_S=60  # after the start pass: the approver's Enter and the row reporting in

# The closing enforcement's FAIL line, after `FAIL: <test>: `, up to its list
# of the assertions not passed.
ENFORCEMENT_LINE='the script exited 0 without the closing assertions ('

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

# call_count [<log>]: print the number of `call` lines in <log> (the
# agent-director shim's log by default; 0 when there is none).
call_count() {
    local log="${1:-${SCENARIO_AD_SHIM_LOG}}"
    if [[ ! -f "${log}" ]]; then
        echo 0
        return 0
    fi
    awk -F'\t' '$1 == "call" { n++ } END { print n + 0 }' "${log}"
}

# last_call_line [<log>]: print <log>'s last `call` line (the agent-director
# shim's log by default).
last_call_line() {
    awk -F'\t' '$1 == "call" { l = $0 } END { print l }' "${1:-${SCENARIO_AD_SHIM_LOG}}"
}

# line_count <file>: print how many lines <file> holds (0 when there is none).
line_count() {
    if [[ ! -f "$1" ]]; then
        echo 0
        return 0
    fi
    wc -l < "$1" | tr -d ' '
}

# True when <a> < <b>, both seconds with decimals.
time_before() {
    awk -v a="$1" -v b="$2" 'BEGIN { exit !(a < b) }'
}

# Print the seconds from <a> to <b>, both seconds with decimals.
seconds_between() {
    awk -v a="$1" -v b="$2" 'BEGIN { printf "%.3f\n", b - a }'
}

# read_call <step> <line>: split one `call` line into CALL_TIME, CALL_PID,
# CALL_PPID, CALL_PARENT (the parent's command line, an array) and CALL_WORDS
# (the argv after argv[0], an array); fail unless it has the format's six
# fields and its quoted fields parse (through scenario.sh's
# `_scenario_eval_words`).
read_call() {
    local step="$1" line="$2" nf kind parent words
    nf="$(awk -F'\t' '{ print NF }' <<< "${line}")"
    [[ "${nf}" == 6 ]] || fail "${step}: shim log line has ${nf} field(s), not 6: ${line}"
    IFS=$'\t' read -r kind CALL_TIME CALL_PID CALL_PPID parent words <<< "${line}"
    [[ "${kind}" == call ]] || fail "${step}: shim log line's kind is '${kind}', not call"
    [[ "${CALL_TIME}" =~ ^[0-9]+\.[0-9]{6}$ ]] \
        || fail "${step}: shim log line's time '${CALL_TIME}' is not seconds with six decimals"
    [[ "${CALL_PID}" =~ ^[0-9]+$ && "${CALL_PPID}" =~ ^[0-9]+$ ]] \
        || fail "${step}: shim log line's pid '${CALL_PID}' or ppid '${CALL_PPID}' is not a number"
    CALL_PARENT=()
    if [[ "${parent}" != '?' ]]; then
        _scenario_eval_words CALL_PARENT "${parent}" || fail "${step}: shim log line's parent field does not parse: ${parent}"
    fi
    _scenario_eval_words CALL_WORDS "${words}" || fail "${step}: shim log line's words field does not parse: ${words}"
}

# same_words <array-name> <array-name>: true when both arrays hold the same
# elements in the same order.
same_words() {
    local -n same_a="$1" same_b="$2"
    local i
    (( ${#same_a[@]} == ${#same_b[@]} )) || return 1
    for i in "${!same_a[@]}"; do
        [[ "${same_a[i]}" == "${same_b[i]}" ]] || return 1
    done
}

# Print the words, each `printf %q`-quoted, so a failure shows where they differ.
quoted() {
    local q
    printf -v q '%q ' "$@"
    printf '%s\n' "${q% }"
}

# expect_shim_in_place <step> <binary>: the standard path holds the shim (a
# regular executable file, not a symlink, the fixture byte for byte, carrying
# its marker line) and the file behind it is <binary>, byte for byte.
expect_shim_in_place() {
    local step="$1" binary="$2" path="${SCENARIO_AD_BIN}"
    [[ -f "${path}" && ! -L "${path}" ]] || fail "${step}: ${path} is not a regular file"
    grep -qxF -- "${SCENARIO_AD_SHIM_MARKER}" "${path}" || fail "${step}: ${path} does not carry the shim's marker"
    cmp -s -- "${SCENARIO_AD_SHIM_SRC}" "${path}" || fail "${step}: ${path} is not the shim ${SCENARIO_AD_SHIM_SRC}"
    [[ -x "${path}" ]] || fail "${step}: the shim at ${path} is not executable"
    [[ -f "${path}.real" && ! -L "${path}.real" && -x "${path}.real" ]] \
        || fail "${step}: no executable regular file behind the shim at ${path}.real"
    cmp -s -- "${binary}" "${path}.real" || fail "${step}: the binary behind the shim is not ${binary}"
}

# expect_ad_version <step> <version> [<commit>]: a harness call of `version`
# through the shim answers <version> (and <commit>, when given).
expect_ad_version() {
    local step="$1" want="$2" want_commit="${3:-}" got got_commit
    ad_capture version
    (( AD_RC == 0 )) || fail "${step}: agent-director version exited ${AD_RC}: $(head -c 300 "${AD_ERR}")"
    got="$(jq -r '.version // empty' "${AD_OUT}")" || fail "${step}: version printed no JSON: $(head -c 300 "${AD_OUT}")"
    [[ "${got}" == "${want}" ]] || fail "${step}: a call through the shim reports version '${got}', not ${want}"
    if [[ -n "${want_commit}" ]]; then
        got_commit="$(jq -r '.commit // empty' "${AD_OUT}")"
        [[ "${got_commit}" == "${want_commit}" ]] \
            || fail "${step}: a call through the shim reports commit '${got_commit}', not ${want_commit}"
    fi
}

# expect_fails_in_home <step> <home> <reason> <command> [<arg>...]: run the
# command in a subshell with HOME=<home>; fail unless it exits non-zero with
# a FAIL line of this test carrying <reason>.
expect_fails_in_home() {
    local step="$1" home="$2" reason="$3"
    shift 3
    local out="${SCENARIO_ROOT}/expect-fails.out" rc=0 line
    ( export HOME="${home}"; "$@" ) > "${out}" 2>&1 || rc=$?
    if (( rc == 0 )); then
        sed 's/^/  | /' "${out}" >&2
        fail "${step}: '$*' with HOME ${home} succeeded"
    fi
    line="$(grep -m1 '^FAIL:' "${out}" || true)"
    if [[ "${line}" != "FAIL: ${TEST_NAME}: "*"${reason}"* ]]; then
        sed 's/^/  | /' "${out}" >&2
        fail "${step}: '$*' with HOME ${home} failed without '${reason}'"
    fi
}

# Print a digest of everything under <dir>: each entry's path, type, size,
# mode and modification time, and each file's SHA-256.
tree_digest() {
    (
        cd "$1" || exit 1
        find . -printf '%p %y %s %m %T@\n' | LC_ALL=C sort
        find . -type f -exec sha256sum {} + | LC_ALL=C sort
    )
}

# shim_call <name> <arg>...: run the tmux shim by its path from the scenario's
# shell, standard input from /dev/null; set SHIM_RC, SHIM_OUT and SHIM_ERR
# (its standard output and error, in files named after <name>).
shim_call() {
    local name="$1"
    shift
    SHIM_OUT="${SCENARIO_ROOT}/shim-${name}.out"
    SHIM_ERR="${SCENARIO_ROOT}/shim-${name}.err"
    SHIM_RC=0
    "${SCENARIO_TMUX_SHIM_BIN}/tmux" "$@" < /dev/null > "${SHIM_OUT}" 2> "${SHIM_ERR}" || SHIM_RC=$?
}

# expect_shim_refused <step>: the last shim_call exited 1, wrote nothing to
# standard output and one line to standard error, the shim's own (`tmux-shim:`),
# not tmux's.
expect_shim_refused() {
    local step="$1" n
    if (( SHIM_RC != 1 )) || [[ -s "${SHIM_OUT}" ]]; then
        sed 's/^/  | /' "${SHIM_OUT}" "${SHIM_ERR}" >&2
        fail "${step}: the call exited ${SHIM_RC} (not 1) or wrote to standard output"
    fi
    n="$(line_count "${SHIM_ERR}")"
    if [[ "${n}" != 1 ]] || ! grep -q '^tmux-shim: ' "${SHIM_ERR}"; then
        sed 's/^/  | /' "${SHIM_ERR}" >&2
        fail "${step}: standard error holds ${n} line(s), not the shim's one tmux-shim: line"
    fi
}

# True when the scenario's tmux server holds a session named exactly <name>
# (asked with the real tmux).
has_session() {
    "${SCENARIO_REAL_TMUX}" has-session -t "=$1" 2> /dev/null
}

# expect_ad_error <step> <err_name>: the last ad_capture failed with <err_name>.
expect_ad_error() {
    local step="$1" want="$2"
    if (( AD_RC == 0 )) || ! grep -qF "\"err_name\":\"${want}\"" "${AD_OUT}" "${AD_ERR}"; then
        sed 's/^/  | /' "${AD_OUT}" "${AD_ERR}" >&2
        fail "${step}: agent-director exited ${AD_RC} without ${want}"
    fi
}

# expect_row_state <step> <instance-id> <state>: a harness get of the row
# shows <state>.
expect_row_state() {
    local step="$1" id="$2" want="$3" got
    ad_capture get --claude-instance-id "${id}"
    (( AD_RC == 0 )) || fail "${step}: harness get of ${id} exited ${AD_RC}: $(head -c 300 "${AD_ERR}")"
    got="$(jq -r '.state // empty' "${AD_OUT}")"
    [[ "${got}" == "${want}" ]] || fail "${step}: row ${id} is '${got}', not ${want}"
}

# True when a harness get of row <instance-id> shows <state>.
row_state_is() {
    ad_capture get --claude-instance-id "$1"
    (( AD_RC == 0 )) && [[ "$(jq -r '.state // empty' "${AD_OUT}")" == "$2" ]]
}

# last_tmux_line_with <after> <fragment>...: print the last tmux shim log line
# after line <after> that holds every fixed-string <fragment>.
last_tmux_line_with() {
    local after="$1" line frag found=""
    shift
    while IFS= read -r line; do
        for frag in "$@"; do
            [[ "${line}" == *"${frag}"* ]] || continue 2
        done
        found="${line}"
    done < <(tail -n "+$(( after + 1 ))" "${SCENARIO_TMUX_SHIM_LOG}")
    printf '%s\n' "${found}"
}

# True when the tmux shim log holds more than <n> lines.
tmux_log_longer_than() {
    (( $(line_count "${SCENARIO_TMUX_SHIM_LOG}") > $1 ))
}

# Print how many `call` lines of the tmux shim log have as their parent an
# agent-director process (its argv[0] the agent-director shim's path).
tmux_lines_from_ad() {
    local line n=0
    while IFS= read -r line; do
        read_call "tmux lines from agent-director" "${line}"
        [[ "${CALL_PARENT[0]:-}" == */agent-director ]] && n=$(( n + 1 ))
    done < <(awk -F'\t' '$1 == "call"' "${SCENARIO_TMUX_SHIM_LOG}")
    echo "${n}"
}

# window_copy <dir> <tmux-from> <tmux-to> <ad-from> <ad-to>: write into <dir>
# lines <tmux-from>..<tmux-to> of the tmux shim log, lines <ad-from>..<ad-to>
# of the agent-director shim log (none when from > to) and the whole CSCB
# process record as it stands, under the real files' names.
window_copy() {
    local dir="$1"
    mkdir -p "${dir}"
    _scenario_cscb_after || fail "window copy: could not update the CSCB process record"
    awk -v a="$2" -v b="$3" 'NR >= a && NR <= b' "${SCENARIO_TMUX_SHIM_LOG}" > "${dir}/tmux-shim.log"
    awk -v a="$4" -v b="$5" 'NR >= a && NR <= b' "${SCENARIO_AD_SHIM_LOG}" > "${dir}/agent-director-shim.log"
    cp -- "${SCENARIO_CSCB_RECORD}" "${dir}/cscb-processes"
}

# on_files <dir> <command> [<arg>...]: run <command> in a subshell with the
# assertions and count helpers pointed at <dir>'s tmux-shim.log,
# agent-director-shim.log and cscb-processes; its status passes through. A
# closing assertion run so never counts toward the closing enforcement.
on_files() {
    local dir="$1"
    shift
    (
        SCENARIO_TMUX_SHIM_LOG="${dir}/tmux-shim.log"
        SCENARIO_AD_SHIM_LOG="${dir}/agent-director-shim.log"
        SCENARIO_CSCB_RECORD="${dir}/cscb-processes"
        "$@"
    )
}

# expect_on_files <step> <dir> <pass | fail> <assertion> [<reason>]: run
# <assertion> on <dir>'s files; fail unless it passes (pass) or fails with
# its FAIL line `FAIL: <test>: <assertion>: …<reason>…` (fail).
expect_on_files() {
    local step="$1" dir="$2" want="$3" assertion="$4" reason="${5:-}" out rc=0 line
    out="${dir}/${assertion}.out"
    on_files "${dir}" "${assertion}" > "${out}" 2>&1 || rc=$?
    if [[ "${want}" == pass ]]; then
        if (( rc != 0 )); then
            sed 's/^/  | /' "${out}" >&2
            fail "${step}: ${assertion} failed on ${dir##*/}: $(grep -m1 '^FAIL:' "${out}" || true)"
        fi
        return 0
    fi
    if (( rc == 0 )); then
        sed 's/^/  | /' "${dir}/tmux-shim.log" "${dir}/agent-director-shim.log" >&2
        fail "${step}: ${assertion} passed on ${dir##*/}"
    fi
    line="$(grep -m1 '^FAIL:' "${out}" || true)"
    if [[ "${line}" != "FAIL: ${TEST_NAME}: ${assertion}: "*"${reason}"* ]]; then
        sed 's/^/  | /' "${out}" >&2
        fail "${step}: ${assertion} failed on ${dir##*/} without '${reason}'"
    fi
}

# ---------------------------------------------------------------------------
# Synthetic logs and records (the synthetic_* and count_helpers legs)
# ---------------------------------------------------------------------------

# A synthetic record: a bot server (PID SYN_SERVER) whose window is 1000 to
# 2000 s, a CSCB CLI run (SYN_RUN) from 1100 to 1200 s; SYN_SHELL is a PID no
# entry holds, with the scenario shell's command line, as a harness call's
# parent is. PIDs above any pid_max, so none is a live process's.
SYN_SERVER=5000001
SYN_RUN=5000002
SYN_SHELL=5000003
SYN_OTHER=5000004
SYN_SERVER_CMD='bun /test-repo/node_modules/claude-slack-channel-bots/src/server.ts'
SYN_RUN_CMD='bun /test-repo/node_modules/.bin/claude-slack-channel-bots list'
SYN_AD_CMD=""  # the agent-director shim's path, quoted as a parent is (set by syn_base)

# syn_line <file> <kind> <time> <pid> <ppid> <parent> <word>...: append one
# line in the shims' format: <parent> as given (already quoted), each <word>
# `printf %q`-quoted.
syn_line() {
    local file="$1" kind="$2" time="$3" pid="$4" ppid="$5" parent="$6" words=""
    shift 6
    if (( $# > 0 )); then
        printf -v words '%q ' "$@"
        words="${words% }"
    fi
    printf '%s\t%s\t%s\t%s\t%s\t%s\n' "${kind}" "${time}" "${pid}" "${ppid}" "${parent}" "${words}" >> "${file}"
}

# syn_base <dir>: write the clean base case into <dir>: the record; an
# agent-director log with the bot server's version probe and its spawn; a
# tmux log with that spawn's new-session, its parent the spawn's
# agent-director process. Every closing assertion passes it.
syn_base() {
    local dir="$1"
    printf -v SYN_AD_CMD '%q spawn' "${SCENARIO_AD_BIN}"
    rm -rf -- "${dir}"
    mkdir -p "${dir}"
    printf 'proc\tserver\t%s\t11\t1000.000000\t%s\n' "${SYN_SERVER}" "${SYN_SERVER_CMD}" > "${dir}/cscb-processes"
    printf 'proc\trun\t%s\t12\t1100.000000\t%s\n' "${SYN_RUN}" "${SYN_RUN_CMD}" >> "${dir}/cscb-processes"
    printf 'gone\t%s\t12\t1200.000000\n' "${SYN_RUN}" >> "${dir}/cscb-processes"
    printf 'gone\t%s\t11\t2000.000000\n' "${SYN_SERVER}" >> "${dir}/cscb-processes"
    : > "${dir}/agent-director-shim.log"
    : > "${dir}/tmux-shim.log"
    syn_line "${dir}/agent-director-shim.log" call 1001.000000 6000001 "${SYN_SERVER}" "${SYN_SERVER_CMD}" version
    syn_line "${dir}/agent-director-shim.log" call 1002.000000 6000002 "${SYN_SERVER}" "${SYN_SERVER_CMD}" \
        spawn --claude-instance-id cscb_alpha
    syn_line "${dir}/tmux-shim.log" call 1002.100000 7000001 6000002 "${SYN_AD_CMD}" \
        -u new-session -d -s slack_bot_alpha
}

# syn_case <name>: a fresh copy of the base case; print its directory.
syn_case() {
    local dir="${SCENARIO_ROOT}/synthetic/$1"
    syn_base "${dir}"
    printf '%s\n' "${dir}"
}

# ---------------------------------------------------------------------------
# Nested fmk runs (the start_on_010 and closing_enforcement legs)
# ---------------------------------------------------------------------------

# run_nested <name> <ad-start> <body> [<function>...]: write a nested fmk run
# into SCENARIO_ROOT (TEST_NAME <name>, SCENARIO_AD_START <ad-start>, sourcing
# lib/scenario.sh, then RC_VERSION and RC_COMMIT, the <function>s and <body>,
# and a call of <body>), run it, and set NESTED_RC and NESTED_OUT (its output).
run_nested() {
    local name="$1" ad_start="$2" body="$3" script
    shift 3
    script="${SCENARIO_ROOT}/${name}.sh"
    NESTED_OUT="${SCENARIO_ROOT}/${name}.out"
    NESTED_RC=0
    {
        printf '%s\n' '#!/usr/bin/env bash' 'set -euo pipefail'
        printf 'TEST_NAME=%q\n' "${name}"
        printf 'SCENARIO_AD_START=%q\n' "${ad_start}"
        printf 'source %q\n' "${SCENARIO_LIB}"
        printf 'RC_VERSION=%q\nRC_COMMIT=%q\n' "${RC_VERSION}" "${RC_COMMIT}"
        declare -f "$@" "${body}"
        printf '%s\n' "${body}"
    } > "${script}"
    bash "${script}" > "${NESTED_OUT}" 2>&1 || NESTED_RC=$?
}

# expect_nested_markers <step> <marker>...: the nested run printed each
# `CHECK: <marker>` line.
expect_nested_markers() {
    local step="$1" m
    shift
    for m in "$@"; do
        if ! grep -qxF "CHECK: ${m}" "${NESTED_OUT}"; then
            sed 's/^/  | /' "${NESTED_OUT}" >&2
            fail "${step}: the nested run did not get past its check '${m}'"
        fi
    done
}

# expect_nested_only_fail <step> <name> <text>: the nested run exited
# non-zero, and its one FAIL line is `FAIL: <name>: <text>…`.
expect_nested_only_fail() {
    local step="$1" name="$2" want="$3" fails=()
    mapfile -t fails < <(grep '^FAIL:' "${NESTED_OUT}" || true)
    if (( NESTED_RC == 0 || ${#fails[@]} != 1 )) || [[ "${fails[0]}" != "FAIL: ${name}: ${want}"* ]]; then
        sed 's/^/  | /' "${NESTED_OUT}" >&2
        fail "${step}: the nested run exited ${NESTED_RC} with ${#fails[@]} FAIL line(s) (first: ${fails[0]:-none}), not exactly one 'FAIL: ${name}: ${want}…'"
    fi
}

# A stand-in bot server for a nested run (written into its script with
# `declare -f`): a background process of the run, recorded as a bot server
# from now; one agent-director `call` line whose parent it is (a version
# probe) and one tmux `call` line whose parent is that agent-director process,
# both written into the run's own logs at NESTED_T, inside its window, so
# every closing assertion and positive control passes. Sets
# NESTED_SERVER_PID and NESTED_T.
nested_stand_in() {
    local st ad_cmd
    sleep 300 &
    NESTED_SERVER_PID=$!
    st="$(_scenario_proc_starttime "${NESTED_SERVER_PID}")"
    [[ -n "${st}" ]] || fail "stand-in: no start time for ${NESTED_SERVER_PID}"
    NESTED_T="${EPOCHREALTIME/,/.}"
    _scenario_record_proc server "${NESTED_SERVER_PID}" "${st}" "${NESTED_T}" sleep 300
    printf -v ad_cmd '%q version' "${SCENARIO_AD_BIN}"
    printf 'call\t%s\t%s\t%s\t%s\t%s\n' "${NESTED_T}" 6000001 "${NESTED_SERVER_PID}" 'sleep 300' version \
        >> "${SCENARIO_AD_SHIM_LOG}"
    printf 'call\t%s\t%s\t%s\t%s\t%s\n' "${NESTED_T}" 7000001 6000001 "${ad_cmd}" list-sessions \
        >> "${SCENARIO_TMUX_SHIM_LOG}"
}

# The three closing assertions in the run's own shell, each followed by its
# marker.
nested_closing() {
    assert_no_server_tmux
    echo "CHECK: assert_no_server_tmux"
    assert_no_cscb_include_finished
    echo "CHECK: assert_no_cscb_include_finished"
    assert_no_cscb_delete
    echo "CHECK: assert_no_cscb_delete"
}

nested_closing_pass() {
    nested_stand_in
    nested_closing
    echo "PASS: ${TEST_NAME}"
}

nested_violation_after() {
    nested_stand_in
    nested_closing
    # A delete whose parent is the stand-in server, inside its window,
    # written after the closing assertions passed.
    printf 'call\t%s\t%s\t%s\t%s\t%s\n' "${NESTED_T}" 6000002 "${NESTED_SERVER_PID}" 'sleep 300' \
        'delete --claude-instance-id cscb_x' >> "${SCENARIO_AD_SHIM_LOG}"
    echo "CHECK: violating line written"
    echo "PASS: ${TEST_NAME}"
}

nested_closing_elsewhere() {
    local copies="${SCENARIO_ROOT}/copies" keep_tmux keep_ad keep_record
    nested_stand_in
    assert_no_server_tmux
    echo "CHECK: assert_no_server_tmux"
    # In the run's own shell, but over copies of its logs and record.
    mkdir -p "${copies}"
    cp -- "${SCENARIO_TMUX_SHIM_LOG}" "${SCENARIO_AD_SHIM_LOG}" "${SCENARIO_CSCB_RECORD}" "${copies}/"
    keep_tmux="${SCENARIO_TMUX_SHIM_LOG}"
    keep_ad="${SCENARIO_AD_SHIM_LOG}"
    keep_record="${SCENARIO_CSCB_RECORD}"
    SCENARIO_TMUX_SHIM_LOG="${copies}/${keep_tmux##*/}"
    SCENARIO_AD_SHIM_LOG="${copies}/${keep_ad##*/}"
    SCENARIO_CSCB_RECORD="${copies}/${keep_record##*/}"
    assert_no_cscb_include_finished
    echo "CHECK: assert_no_cscb_include_finished over copies"
    SCENARIO_TMUX_SHIM_LOG="${keep_tmux}"
    SCENARIO_AD_SHIM_LOG="${keep_ad}"
    SCENARIO_CSCB_RECORD="${keep_record}"
    # Over the run's own files, but in a subshell.
    ( assert_no_cscb_delete )
    echo "CHECK: assert_no_cscb_delete in a subshell"
    echo "PASS: ${TEST_NAME}"
}

nested_own_failure() {
    nested_stand_in
    echo "CHECK: stand-in"
    fail "planted failure before the closing assertions"
}

# ---------------------------------------------------------------------------
# Exit hooks
# ---------------------------------------------------------------------------

# The trap stopped the scenario's tmux server: the PID the tmux_and_store leg
# saw is gone and no tmux server answers on any socket under SCENARIO_ROOT.
tmux_server_gone() {
    local sock
    if [[ -n "${T0_TMUX_PID}" ]] && pid_alive "${T0_TMUX_PID}"; then
        fail "teardown: the scenario's tmux server (PID ${T0_TMUX_PID}) is still running after the trap"
    fi
    while IFS= read -r -d '' sock; do
        if timeout 5 "${SCENARIO_REAL_TMUX}" -S "${sock}" list-sessions > /dev/null 2>&1; then
            fail "teardown: a tmux server still answers on ${sock} after the trap"
        fi
    done < <(find "${SCENARIO_ROOT}" -type s -print0 2> /dev/null)
}

remove_outside_home() {
    if [[ -n "${OUTSIDE_HOME}" && "${OUTSIDE_HOME}" == /tmp/test-0-outside-home.* ]]; then
        rm -rf -- "${OUTSIDE_HOME}"
    fi
}

on_exit tmux_server_gone
on_exit remove_outside_home

# ---------------------------------------------------------------------------
# Legs
# ---------------------------------------------------------------------------

leg_isolation() {
    local step="isolation" passwd_home real_root real_home rc_dir dir found entries=()
    [[ "${HOME}" == "${SCENARIO_ROOT}/home" && "${HOME}" == "${SCENARIO_HOME}" && -d "${HOME}" ]] \
        || fail "${step}: HOME '${HOME}' is not the scenario HOME ${SCENARIO_ROOT}/home"
    real_root="$(realpath -e -- "${SCENARIO_ROOT}")"
    real_home="$(realpath -e -- "${HOME}")"
    [[ "${real_home}" == "${real_root}"/* ]] \
        || fail "${step}: HOME resolves to ${real_home}, outside SCENARIO_ROOT ${real_root}"
    passwd_home="$(getent passwd "$(id -u)" | cut -d: -f6)"
    [[ -n "${passwd_home}" && "${real_home}" != "${passwd_home}" ]] \
        || fail "${step}: HOME is the container user's own home '${passwd_home}'"
    [[ "${TMUX_TMPDIR:-}" == "${SCENARIO_ROOT}/tmux" && -d "${TMUX_TMPDIR}" ]] \
        || fail "${step}: TMUX_TMPDIR '${TMUX_TMPDIR:-}' is not ${SCENARIO_ROOT}/tmux"
    [[ -z "${TMUX+set}" && -z "${TMUX_PANE+set}" ]] || fail "${step}: TMUX or TMUX_PANE is set"

    rc_dir="${SCENARIO_RC_BIN%/*}"
    IFS=: read -r -a entries <<< "${PATH}"
    [[ "${entries[0]:-}" == "${SCENARIO_BIN}" ]] \
        || fail "${step}: PATH starts with '${entries[0]:-}', not the scenario's bin ${SCENARIO_BIN}"
    for dir in "${entries[@]}"; do
        [[ "${dir}" == /* ]] || fail "${step}: PATH holds the relative or empty entry '${dir}'"
        [[ "${dir}" != "${rc_dir}" ]] || fail "${step}: PATH holds the image's default agent-director directory ${rc_dir}"
        [[ ! -e "${dir}/agent-director" && ! -L "${dir}/agent-director" ]] \
            || fail "${step}: PATH entry ${dir} holds an agent-director"
    done
    found="$(type -a -P agent-director || true)"
    [[ -z "${found}" ]] || fail "${step}: the scenario shell finds an agent-director: ${found}"
    [[ "$(type -P claude || true)" == "${SCENARIO_BIN}/claude" ]] \
        || fail "${step}: claude resolves to '$(type -P claude || true)', not ${SCENARIO_BIN}/claude"
    cmp -s -- "${SCENARIO_FIXTURES}/stub-claude.sh" "${SCENARIO_BIN}/claude" \
        || fail "${step}: ${SCENARIO_BIN}/claude is not the stub"
    [[ "$(type -P bun || true)" == /* ]] || fail "${step}: bun is not found on the scenario's PATH"

    [[ "${SCENARIO_AD_BIN}" == "${HOME}/.agent-director/bin/agent-director" ]] \
        || fail "${step}: SCENARIO_AD_BIN ${SCENARIO_AD_BIN} is not the scenario HOME's standard path"
    [[ "${SCENARIO_AD_SHIM_LOG}" == "${HOME}/.agent-director/bin/agent-director-shim.log" ]] \
        || fail "${step}: SCENARIO_AD_SHIM_LOG ${SCENARIO_AD_SHIM_LOG} is not beside the standard path"
    for found in agent-director-shim.log agent-director.real; do
        [[ ! -e "${passwd_home}/.agent-director/bin/${found}" ]] \
            || fail "${step}: the container user's own ${passwd_home}/.agent-director/bin holds ${found}"
    done
}

leg_real_binary() {
    local step="real binary" before out got got_commit
    before="$(call_count)"
    out="$("${SCENARIO_AD_BIN}.real" version)" || fail "${step}: ${SCENARIO_AD_BIN}.real version failed"
    got="$(jq -r '.version // empty' <<< "${out}")"
    got_commit="$(jq -r '.commit // empty' <<< "${out}")"
    [[ "${got}" == "${RC_VERSION}" && "${got_commit}" == "${RC_COMMIT}" ]] \
        || fail "${step}: the binary behind the shim reports ${got} ${got_commit}, not the recorded ${RC_VERSION} ${RC_COMMIT}"
    [[ "$(call_count)" == "${before}" ]] || fail "${step}: running the real binary by its own name added a shim log line"
}

leg_setup_install() {
    local step="setup install"
    expect_shim_in_place "${step}: after the setup's install" "${SCENARIO_RC_BIN}"
    expect_ad_version "${step}" "${RC_VERSION}" "${RC_COMMIT}"
    [[ -f "${HOME}/.agent-director/state.db" ]] || fail "${step}: no store at ${HOME}/.agent-director/state.db"
}

leg_harness_call_log() {
    local step="harness call log" before t_before t_after mine=()
    local want=(get --claude-instance-id "t0 no such row")
    before="$(call_count)"
    t_before="${EPOCHREALTIME/,/.}"
    ad_capture "${want[@]}"
    t_after="${EPOCHREALTIME/,/.}"
    grep -qF '"err_name"' "${AD_OUT}" "${AD_ERR}" \
        || fail "${step}: the call got no answer from agent-director (exit ${AD_RC})"
    [[ "$(call_count)" == "$(( before + 1 ))" ]] || fail "${step}: the call did not add exactly one call line"
    HARNESS_CALL_LINE="$(last_call_line)"
    read_call "${step}" "${HARNESS_CALL_LINE}"
    awk -v a="${t_before}" -v t="${CALL_TIME}" -v b="${t_after}" 'BEGIN { exit !(a <= t && t <= b) }' \
        || fail "${step}: the line's time ${CALL_TIME} is not between ${t_before} and ${t_after}"
    [[ "${CALL_PPID}" == "$$" ]] || fail "${step}: the line's parent is ${CALL_PPID}, not the scenario's shell $$"
    [[ "${CALL_PID}" != "$$" ]] || fail "${step}: the line's pid is the scenario's shell"
    mapfile -d '' -t mine < "/proc/$$/cmdline"
    same_words CALL_PARENT mine \
        || fail "${step}: the line's parent command line $(quoted "${CALL_PARENT[@]}") is not the shell's $(quoted "${mine[@]}")"
    same_words CALL_WORDS want || fail "${step}: the line's words $(quoted "${CALL_WORDS[@]}") are not the argv $(quoted "${want[@]}")"
}

leg_version_probe() {
    local step="version probe" probe="${SCENARIO_ROOT}/version-probe.ts" out err before rc=0 got
    out="${SCENARIO_ROOT}/version-probe.out"
    err="${SCENARIO_ROOT}/version-probe.err"
    cat > "${probe}" << 'EOF'
// The installed package's agent-director client, resolved from its src/:
// discovery and the version probe, as a CSCB process makes them.
import { homedir } from 'node:os'
const [pkgSrc] = process.argv.slice(2)
const client = await import(Bun.resolveSync('agent-director', pkgSrc))
const found = await client.resolveSystemBinary()
console.log(JSON.stringify({ home: homedir(), path: found.path, version: found.version }))
EOF
    before="$(call_count)"
    bun --no-install "${probe}" "${SCENARIO_REPO}/node_modules/claude-slack-channel-bots/src" > "${out}" 2> "${err}" || rc=$?
    if (( rc != 0 )); then
        sed 's/^/  | /' "${out}" "${err}" >&2
        fail "${step}: bun exited ${rc}"
    fi
    got="$(jq -r '.home' "${out}")"
    [[ "${got}" == "${HOME}" ]] || fail "${step}: bun's home is '${got}', not the scenario HOME ${HOME}"
    got="$(jq -r '.path' "${out}")"
    [[ "${got}" == "${SCENARIO_AD_BIN}" ]] || fail "${step}: the client resolved '${got}', not the shim at ${SCENARIO_AD_BIN}"
    got="$(jq -r '.version' "${out}")"
    [[ "${got}" == "${RC_VERSION}" ]] || fail "${step}: the probe got version '${got}', not the recorded ${RC_VERSION}"
    [[ "$(call_count)" == "$(( before + 1 ))" ]] || fail "${step}: the probe did not add exactly one call line"
    read_call "${step}" "$(last_call_line)"
    [[ "${CALL_WORDS[0]:-}" == version ]] || fail "${step}: the probe's line has words $(quoted "${CALL_WORDS[@]}"), not version …"
    [[ "${CALL_PPID}" != "$$" && ( "${CALL_PARENT[0]:-}" == */bun || "${CALL_PARENT[0]:-}" == bun ) ]] \
        || fail "${step}: the probe's line has parent $(quoted "${CALL_PARENT[@]}") (${CALL_PPID}), not bun"
}

leg_tmux_and_store() {
    local step="tmux and store" work row_socket info sock_path store_id got
    work="$(make_workdir self-check)"
    ad_capture spawn --cwd "${work}" --claude-instance-id "${T0_ROW_ID}" \
        --tmux-session-name "${T0_SESSION}" --no-pre-trust --label "t0=spawned"
    if (( AD_RC != 0 )); then
        sed 's/^/  | /' "${AD_OUT}" "${AD_ERR}" >&2
        fail "${step}: harness spawn exited ${AD_RC}"
    fi
    ad_capture get --claude-instance-id "${T0_ROW_ID}"
    (( AD_RC == 0 )) || fail "${step}: harness get exited ${AD_RC}: $(head -c 300 "${AD_ERR}")"
    row_socket="$(jq -r '.tmux_socket // empty' "${AD_OUT}")"
    [[ "${row_socket}" == "${TMUX_TMPDIR}"/* && -S "${row_socket}" ]] \
        || fail "${step}: the row's tmux socket '${row_socket}' is not a socket under ${TMUX_TMPDIR}"
    got="$(jq -r '.labels.t0 // empty' "${AD_OUT}")"
    [[ "${got}" == spawned ]] || fail "${step}: the spawned row's label t0 is '${got}', not spawned"

    # The scenario shell's tmux (by TMUX_TMPDIR) reaches the session, on the
    # row's socket, and the server is this scenario's.
    info="$("${SCENARIO_REAL_TMUX}" display-message -p -t "${T0_SESSION}" '#{socket_path} #{pid}')" \
        || fail "${step}: the scenario shell's tmux does not reach session ${T0_SESSION}"
    sock_path="${info% *}"
    T0_TMUX_PID="${info##* }"
    [[ "${sock_path}" == "${row_socket}" ]] \
        || fail "${step}: the scenario shell's tmux talks to ${sock_path}, not the row's ${row_socket}"
    [[ "${T0_TMUX_PID}" =~ ^[0-9]+$ ]] || fail "${step}: tmux reported server PID '${T0_TMUX_PID}'"
    grep -qzxF -- "SCENARIO_ROOT=${SCENARIO_ROOT}" "/proc/${T0_TMUX_PID}/environ" \
        || fail "${step}: tmux server ${T0_TMUX_PID} does not carry this scenario's SCENARIO_ROOT"

    store_id="$(ad_store_id)"
    [[ "${store_id}" =~ ^[0-9a-f]{16}$ ]] || fail "${step}: ad_store_id printed '${store_id}'"
    T0_STORE_ID="${store_id}"
    ad_store_edit "UPDATE spawns SET labels = '{\"t0\":\"edited\"}' WHERE claude_instance_id = '${T0_ROW_ID}'"
    ad_capture get --claude-instance-id "${T0_ROW_ID}"
    (( AD_RC == 0 )) || fail "${step}: harness get after the edit exited ${AD_RC}"
    got="$(jq -r '.labels.t0 // empty' "${AD_OUT}")"
    [[ "${got}" == edited ]] || fail "${step}: harness get after ad_store_edit shows label t0 '${got}', not edited"
}

leg_swap() {
    local step="swap" got_commit
    swap_ad_binary 0.10.0 "${step}: to 0.10.0"
    expect_shim_in_place "${step}: after the swap to 0.10.0" "${SCENARIO_AD_010_BIN}"
    expect_ad_version "${step}: after the swap to 0.10.0" 0.10.0
    got_commit="$(jq -r '.commit // empty' "${AD_OUT}")"
    [[ "${got_commit}" != "${RC_COMMIT}" ]] || fail "${step}: 0.10.0 reports the release candidate's commit"
    swap_ad_binary rc "${step}: back to the release candidate"
    expect_shim_in_place "${step}: after the swap back" "${SCENARIO_RC_BIN}"
    expect_ad_version "${step}: after the swap back" "${RC_VERSION}" "${RC_COMMIT}"
}

leg_reinstall() {
    local step="reinstall" store_id
    install_ad_rc "${step}: install.sh again"
    expect_shim_in_place "${step}: after install.sh and its re-shim" "${SCENARIO_RC_BIN}"
    expect_ad_version "${step}" "${RC_VERSION}" "${RC_COMMIT}"
    store_id="$(ad_store_id)"
    [[ "${store_id}" == "${T0_STORE_ID}" ]] || fail "${step}: the store id changed from ${T0_STORE_ID} to ${store_id}"
}

leg_hide_restore() {
    local step="hide and restore"
    hide_ad_install "${step}: hide"
    [[ ! -e "${SCENARIO_AD_BIN}" && ! -L "${SCENARIO_AD_BIN}" ]] || fail "${step}: a file is at ${SCENARIO_AD_BIN} after the hide"
    [[ ! -e "${SCENARIO_AD_BIN}.real" && ! -L "${SCENARIO_AD_BIN}.real" ]] \
        || fail "${step}: a file is at ${SCENARIO_AD_BIN}.real after the hide"
    [[ -f "${SCENARIO_AD_SHIM_LOG}" ]] || fail "${step}: the shim log went with the hide"
    restore_ad_install "${step}: restore"
    expect_shim_in_place "${step}: after the restore" "${SCENARIO_RC_BIN}"
    expect_ad_version "${step}: after the restore" "${RC_VERSION}" "${RC_COMMIT}"
}

leg_log_kept() {
    local step="log kept" bad
    grep -qxF -- "${HARNESS_CALL_LINE}" "${SCENARIO_AD_SHIM_LOG}" \
        || fail "${step}: the harness call's line is gone from the shim log"
    bad="$(awk -F'\t' 'NF != 6 || ($1 != "call" && $1 != "stop") { print NR; exit }' "${SCENARIO_AD_SHIM_LOG}")"
    [[ -z "${bad}" ]] || fail "${step}: shim log line ${bad} does not have the format's six fields and a known kind"
}

# The body of the nested fmk run of leg_start_on_010 (written into its script
# with `declare -f`, after it sourced lib/scenario.sh with
# SCENARIO_AD_START=0.10.0). Each check prints its marker once it passed.
nested_start_on_010() {
    local step="0.10.0 start" file store_id
    expect_shim_in_place "${step}: after the setup's install" "${SCENARIO_AD_010_BIN}"
    echo "CHECK: 0.10.0 behind the shim"
    while IFS= read -r -d '' file; do
        ! cmp -s -- "${SCENARIO_RC_BIN}" "${file}" || fail "${step}: ${file} is the release candidate's binary"
    done < <(find "${HOME}" -type f -print0)
    echo "CHECK: no release-candidate binary"
    [[ ! -e "${HOME}/.agent-director/state.db" ]] || fail "${step}: a store exists before the release candidate's install"
    echo "CHECK: no store"
    expect_ad_version "${step}: a call through the shim" 0.10.0
    echo "CHECK: 0.10.0 answers"
    install_ad_rc "${step}: install_ad_rc"
    expect_shim_in_place "${step}: after install_ad_rc" "${SCENARIO_RC_BIN}"
    echo "CHECK: release candidate behind the shim"
    expect_ad_version "${step}: after install_ad_rc" "${RC_VERSION}" "${RC_COMMIT}"
    echo "CHECK: release candidate answers"
    store_id="$(ad_store_id)"
    [[ "${store_id}" =~ ^[0-9a-f]{16}$ ]] || fail "${step}: ad_store_id printed '${store_id}'"
    echo "CHECK: store id"
    echo "PASS: ${TEST_NAME}"
}

leg_start_on_010() {
    local step="0.10.0 start" name="test-0-fmk-nested-start-on-010"
    run_nested "${name}" 0.10.0 nested_start_on_010 expect_shim_in_place expect_ad_version
    expect_nested_markers "${step}" "0.10.0 behind the shim" "no release-candidate binary" "no store" \
        "0.10.0 answers" "release candidate behind the shim" "release candidate answers" "store id"
    # It started no bot server, so it cannot meet the closing assertions'
    # positive controls: it exits 0 without them, and the trap fails it.
    expect_nested_only_fail "${step}" "${name}" \
        "${ENFORCEMENT_LINE}assert_no_server_tmux, assert_no_cscb_include_finished, assert_no_cscb_delete: not passed in its own shell)"
}

leg_guard_refusals() {
    local step="guard refusals" link real_outside before home reason
    OUTSIDE_HOME="$(mktemp -d /tmp/test-0-outside-home.XXXXXX)" || fail "${step}: could not make a HOME outside SCENARIO_ROOT"
    # A decoy install and store each helper would act on, were it not refused.
    mkdir -p "${OUTSIDE_HOME}/.agent-director/bin"
    cp -- "${SCENARIO_AD_010_BIN}" "${OUTSIDE_HOME}/.agent-director/bin/agent-director"
    sqlite3 "${OUTSIDE_HOME}/.agent-director/state.db" \
        "CREATE TABLE store_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL); INSERT INTO store_meta VALUES ('store_id', '0123456789abcdef'); CREATE TABLE spawns (claude_instance_id TEXT PRIMARY KEY, labels TEXT NOT NULL DEFAULT '{}');" \
        || fail "${step}: could not make the decoy store"
    link="${SCENARIO_ROOT}/home-link-outside"
    ln -s -- "${OUTSIDE_HOME}" "${link}"
    real_outside="$(realpath -e -- "${OUTSIDE_HOME}")"
    before="$(tree_digest "${OUTSIDE_HOME}")"

    for home in "${OUTSIDE_HOME}" "${link}"; do
        if [[ "${home}" == "${link}" ]]; then
            reason="refused: HOME ${link} resolves to ${real_outside}, which is not under SCENARIO_ROOT"
        else
            reason="refused: HOME '${OUTSIDE_HOME}' is not under SCENARIO_ROOT"
        fi
        expect_fails_in_home "${step}" "${home}" "${reason}" install_ad_shim
        expect_fails_in_home "${step}" "${home}" "${reason}" reshim_ad
        expect_fails_in_home "${step}" "${home}" "${reason}" install_ad_rc
        expect_fails_in_home "${step}" "${home}" "${reason}" install_ad_010
        expect_fails_in_home "${step}" "${home}" "${reason}" swap_ad_binary rc
        expect_fails_in_home "${step}" "${home}" "${reason}" hide_ad_install
        expect_fails_in_home "${step}" "${home}" "${reason}" restore_ad_install
        expect_fails_in_home "${step}" "${home}" "${reason}" ad version
        expect_fails_in_home "${step}" "${home}" "${reason}" ad_store_edit "UPDATE spawns SET labels = '{}'"
        expect_fails_in_home "${step}" "${home}" "${reason}" ad_store_id
    done
    [[ "$(tree_digest "${OUTSIDE_HOME}")" == "${before}" ]] \
        || fail "${step}: the HOME outside SCENARIO_ROOT changed under the refused helpers"
}

leg_shim_check() {
    local step="shim check" home="${SCENARIO_ROOT}/home-shim-check" bin
    bin="${home}/.agent-director/bin"
    mkdir -p "${bin}"
    cp -- "${SCENARIO_RC_BIN}" "${bin}/agent-director.real"
    cp -- "${SCENARIO_AD_SHIM_SRC}" "${bin}/agent-director"
    chmod 0755 "${bin}/agent-director.real" "${bin}/agent-director"
    ( export HOME="${home}"; check_ad_shim "${step}: a correct layout" ) \
        || fail "${step}: check_ad_shim refused a correct layout"

    rm -f -- "${bin}/agent-director"
    ln -s -- "${SCENARIO_AD_SHIM_SRC}" "${bin}/agent-director"
    expect_fails_in_home "${step}" "${home}" "is a symlink, not the shim" check_ad_shim

    rm -f -- "${bin}/agent-director"
    grep -vxF -- "${SCENARIO_AD_SHIM_MARKER}" "${SCENARIO_AD_SHIM_SRC}" > "${bin}/agent-director"
    chmod 0755 "${bin}/agent-director"
    expect_fails_in_home "${step}" "${home}" "does not carry the shim's marker" check_ad_shim
}

leg_tmux_shim_log() {
    local step="tmux shim log" session="t0-shim-log" before t_before t_after got mine=()
    local want=(new-session -d -P -F '#{session_name}' -s "${session}" -e "T0_SHIM_WORDS=a b" -- sleep 600)
    [[ "$(cat "${SCENARIO_TMUX_SHIM_MODE_FILE}")" == log ]] || fail "${step}: the shim's mode is not log after setup"
    before="$(call_count "${SCENARIO_TMUX_SHIM_LOG}")"
    t_before="${EPOCHREALTIME/,/.}"
    shim_call log "${want[@]}"
    t_after="${EPOCHREALTIME/,/.}"
    if (( SHIM_RC != 0 )); then
        sed 's/^/  | /' "${SHIM_OUT}" "${SHIM_ERR}" >&2
        fail "${step}: the call exited ${SHIM_RC}"
    fi
    # The real tmux ran: the session exists, its -P output reached the
    # caller, and the -e value (with its space) reached the session.
    has_session "${session}" || fail "${step}: no session ${session} after the call"
    [[ "$(cat "${SHIM_OUT}")" == "${session}" ]] || fail "${step}: the call printed '$(cat "${SHIM_OUT}")', not ${session}"
    got="$("${SCENARIO_REAL_TMUX}" show-environment -t "=${session}" T0_SHIM_WORDS)"
    [[ "${got}" == "T0_SHIM_WORDS=a b" ]] || fail "${step}: the session's T0_SHIM_WORDS is '${got}', not 'a b'"

    [[ "$(call_count "${SCENARIO_TMUX_SHIM_LOG}")" == "$(( before + 1 ))" ]] \
        || fail "${step}: the call did not add exactly one call line"
    read_call "${step}" "$(last_call_line "${SCENARIO_TMUX_SHIM_LOG}")"
    awk -v a="${t_before}" -v t="${CALL_TIME}" -v b="${t_after}" 'BEGIN { exit !(a <= t && t <= b) }' \
        || fail "${step}: the line's time ${CALL_TIME} is not between ${t_before} and ${t_after}"
    [[ "${CALL_PPID}" == "$$" ]] || fail "${step}: the line's parent is ${CALL_PPID}, not the scenario's shell $$"
    [[ "${CALL_PID}" != "$$" ]] || fail "${step}: the line's pid is the scenario's shell"
    mapfile -d '' -t mine < "/proc/$$/cmdline"
    same_words CALL_PARENT mine \
        || fail "${step}: the line's parent command line $(quoted "${CALL_PARENT[@]}") is not the shell's $(quoted "${mine[@]}")"
    same_words CALL_WORDS want || fail "${step}: the line's words $(quoted "${CALL_WORDS[@]}") are not the argv $(quoted "${want[@]}")"
    "${SCENARIO_REAL_TMUX}" kill-session -t "=${session}" || fail "${step}: could not kill ${session}"

    # The mode setter.
    tmux_shim_mode wedge 2.5
    [[ "$(cat "${SCENARIO_TMUX_SHIM_MODE_FILE}")" == "wedge 2.5" ]] \
        || fail "${step}: tmux_shim_mode wedge 2.5 wrote '$(cat "${SCENARIO_TMUX_SHIM_MODE_FILE}")'"
    tmux_shim_mode log
    expect_fails_in_home "${step}" "${HOME}" "tmux_shim_mode: unknown mode 'bogus'" tmux_shim_mode bogus
    expect_fails_in_home "${step}" "${HOME}" "tmux_shim_mode: mode fail-kill takes no delay" tmux_shim_mode fail-kill 3
    expect_fails_in_home "${step}" "${HOME}" "tmux_shim_mode: delay '3s' is not a number of seconds" tmux_shim_mode wedge 3s
    [[ "$(cat "${SCENARIO_TMUX_SHIM_MODE_FILE}")" == log ]] || fail "${step}: a refused tmux_shim_mode changed the mode"
}

leg_fail_kill() {
    local step="fail-kill" session="t0-fail-kill"
    "${SCENARIO_REAL_TMUX}" new-session -d -s "${session}" -- sleep 600 || fail "${step}: could not make ${session}"
    tmux_shim_mode fail-kill
    shim_call fk-session kill-session -t "=${session}"
    expect_shim_refused "${step}: kill-session"
    has_session "${session}" || fail "${step}: kill-session killed the session"
    shim_call fk-pane kill-pane -t "=${session}"
    expect_shim_refused "${step}: kill-pane"
    has_session "${session}" || fail "${step}: kill-pane killed the session"
    shim_call fk-alias killp -t "=${session}"
    expect_shim_refused "${step}: killp"
    has_session "${session}" || fail "${step}: killp killed the session"
    shim_call fk-prefix kill-ses -t "=${session}"
    expect_shim_refused "${step}: kill-ses"
    has_session "${session}" || fail "${step}: kill-ses killed the session"
    shim_call fk-global -L default kill-session -t "=${session}"
    expect_shim_refused "${step}: -L default kill-session"
    has_session "${session}" || fail "${step}: -L default kill-session killed the session"
    # A chained call: its first command prints the name were it run.
    shim_call fk-chained display-message -p -t "${session}" '#{session_name}' ';' kill-session -t "=${session}"
    expect_shim_refused "${step}: a chained call holding kill-session"
    has_session "${session}" || fail "${step}: the chained call killed the session"
    # Other commands run.
    shim_call fk-other display-message -p -t "${session}" '#{session_name}'
    (( SHIM_RC == 0 )) && [[ "$(cat "${SHIM_OUT}")" == "${session}" ]] \
        || fail "${step}: display-message exited ${SHIM_RC} printing '$(cat "${SHIM_OUT}")', not ${session}"
    # The next call after a mode change reads the new mode.
    tmux_shim_mode log
    shim_call fk-log kill-session -t "=${session}"
    (( SHIM_RC == 0 )) || fail "${step}: kill-session in log mode, right after the change, exited ${SHIM_RC}"
    ! has_session "${session}" || fail "${step}: kill-session in log mode left the session"
}

leg_fail_create() {
    local step="fail-create" shim_session="t0-fail-create-shim" id="t0-fail-create" work line ad_pid
    tmux_shim_mode fail-create
    shim_call fc-new-session new-session -d -s "${shim_session}" -- sleep 600
    expect_shim_refused "${step}: new-session"
    shim_call fc-alias new -d -s "${shim_session}" -- sleep 600
    expect_shim_refused "${step}: new"
    shim_call fc-default
    expect_shim_refused "${step}: a call with no command"
    ! has_session "${shim_session}" || fail "${step}: a refused new-session made ${shim_session}"
    shim_call fc-other list-sessions -F '#{session_name}'
    (( SHIM_RC == 0 )) && grep -qxF -- "${T0_SESSION}" "${SHIM_OUT}" \
        || fail "${step}: list-sessions exited ${SHIM_RC} without ${T0_SESSION}"

    # A real agent-director spawn with the shim first on its PATH.
    work="$(make_workdir fail-create)"
    PATH="${SCENARIO_TMUX_SHIM_BIN}:${PATH}" ad_capture spawn --cwd "${work}" --claude-instance-id "${id}" \
        --tmux-session-name "${id}" --no-pre-trust
    expect_ad_error "${step}: the spawn" ErrTmuxSessionCreate
    read_call "${step}" "$(last_call_line)"
    ad_pid="${CALL_PID}"
    line="$(last_tmux_line_with 0 new-session "${id}")"
    [[ -n "${line}" ]] || fail "${step}: the tmux shim logged no new-session for ${id}"
    read_call "${step}" "${line}"
    [[ "${CALL_PPID}" == "${ad_pid}" ]] \
        || fail "${step}: the new-session line's parent is ${CALL_PPID}, not the spawn's agent-director process ${ad_pid}"
    ! has_session "${id}" || fail "${step}: the failed spawn left a session ${id}"
    tmux_shim_mode log
    expect_row_state "${step}" "${id}" pending
}

leg_slow_create() {
    local step="slow-create" id="t0-slow-create" work before line info t_read owner pane deadline
    tmux_shim_mode slow-create "${SLOW_CREATE_DELAY_S}"
    before="$(line_count "${SCENARIO_TMUX_SHIM_LOG}")"
    work="$(make_workdir slow-create)"
    PATH="${SCENARIO_TMUX_SHIM_BIN}:${PATH}" ad_capture spawn --cwd "${work}" --claude-instance-id "${id}" \
        --tmux-session-name "${id}" --no-pre-trust
    info="$("${SCENARIO_REAL_TMUX}" display-message -p -t "${id}" '#{@ad_owner}|#{@ad_pane}' 2> /dev/null || true)"
    t_read="${EPOCHREALTIME/,/.}"
    tmux_shim_mode log
    line="$(last_tmux_line_with "${before}" new-session "${id}")"
    [[ -n "${line}" ]] || fail "${step}: the tmux shim logged no new-session for ${id}"
    read_call "${step}" "${line}"
    deadline="$(awk -v t="${CALL_TIME}" -v d="${SLOW_CREATE_DELAY_S}" 'BEGIN { printf "%.6f\n", t + d }')"
    time_before "${t_read}" "${deadline}" \
        || fail "${step}: the session was read at ${t_read}, after the shim's delay ended (${deadline}); raise SLOW_CREATE_DELAY_S"
    owner="${info%%|*}"
    pane="${info#*|}"
    [[ " ${owner} " == *" ${id} "* ]] || fail "${step}: session ${id}'s @ad_owner is '${owner}', not naming ${id}, before the delay ended"
    [[ -n "${pane}" && "${info}" == *'|'* ]] || fail "${step}: session ${id} has no @ad_pane before the delay ended"
    expect_ad_error "${step}: the spawn" ErrTmuxUnresponsive
    has_session "${id}" || fail "${step}: the timed-out spawn's session ${id} is gone"
    expect_row_state "${step}" "${id}" pending
}

leg_wedge() {
    local step="wedge" session="t0-wedge" before pid rc=0 t_start t_end elapsed out err
    local want=(new-session -d -s "${session}" -- sleep 600)
    (( WEDGE_DELAY_S > AD_CREATE_TIMEOUT_S )) || fail "${step}: WEDGE_DELAY_S is not longer than the create timeout"
    out="${SCENARIO_ROOT}/shim-wedge.out"
    err="${SCENARIO_ROOT}/shim-wedge.err"
    tmux_shim_mode wedge "${WEDGE_DELAY_S}"
    before="$(line_count "${SCENARIO_TMUX_SHIM_LOG}")"
    t_start="${EPOCHREALTIME/,/.}"
    "${SCENARIO_TMUX_SHIM_BIN}/tmux" "${want[@]}" < /dev/null > "${out}" 2> "${err}" &
    pid=$!
    wait_until 5 "${step}: the call's line was not logged" tmux_log_longer_than "${before}"
    pid_alive "${pid}" || fail "${step}: the call had ended when its line was seen"
    read_call "${step}" "$(last_call_line "${SCENARIO_TMUX_SHIM_LOG}")"
    [[ "${CALL_PID}" == "${pid}" ]] || fail "${step}: the logged line's pid is ${CALL_PID}, not the call's ${pid}"
    same_words CALL_WORDS want || fail "${step}: the line's words $(quoted "${CALL_WORDS[@]}") are not the argv"
    wait "${pid}" || rc=$?
    t_end="${EPOCHREALTIME/,/.}"
    tmux_shim_mode log
    elapsed="$(seconds_between "${t_start}" "${t_end}")"
    (( rc == 1 )) || fail "${step}: the call exited ${rc}, not 1"
    ! time_before "${elapsed}" "${WEDGE_DELAY_S}" || fail "${step}: the call ended after ${elapsed}s, before its ${WEDGE_DELAY_S}s delay"
    [[ ! -s "${out}" ]] || fail "${step}: the call wrote to standard output"
    [[ "$(line_count "${err}")" == 1 ]] && grep -q '^tmux-shim: wedge: ' "${err}" \
        || fail "${step}: standard error is not the shim's one wedge line: $(head -c 300 "${err}")"
    ! has_session "${session}" || fail "${step}: the wedged call made ${session}: it ran tmux"
    [[ "$(line_count "${SCENARIO_TMUX_SHIM_LOG}")" == "$(( before + 1 ))" ]] \
        || fail "${step}: the wedged call logged more than its one line"
}

leg_mode_spawns_not_cscb() {
    local step="mode spawns not CSCB's" n
    n="$(tmux_lines_from_ad)"
    (( n >= 2 )) || fail "${step}: only ${n} tmux line(s) have an agent-director process as their parent, not the fail-create and slow-create spawns'"
    expect_fails_in_home "${step}" "${HOME}" "assert_no_server_tmux: positive control" assert_no_server_tmux
}

leg_path_wiring() {
    local step="path wiring" out="${SCENARIO_ROOT}/path-wiring.out" got rc=0 entries=() dir needle pid st
    cscb_run printenv PATH > "${out}"
    got="$(cat "${out}")"
    [[ "${got}" == "${SCENARIO_TMUX_SHIM_BIN}:${PATH}" ]] \
        || fail "${step}: a cscb_run command's PATH is '${got}', not the shim's bin directory, then the scenario's PATH"
    needle="$(awk -F'\t' 'NF == 6 && $1 == "proc" && $2 == "run" && $6 == "printenv PATH"' "${SCENARIO_CSCB_RECORD}")"
    [[ -n "${needle}" && "$(wc -l <<< "${needle}")" == 1 ]] \
        || fail "${step}: the record holds no single run entry for 'printenv PATH'"
    IFS=$'\t' read -r _ _ pid st _ <<< "${needle}"
    [[ "${pid}" =~ ^[0-9]+$ && "${st}" =~ ^[0-9]+$ ]] || fail "${step}: the run entry's PID '${pid}' or start time '${st}' is not a number"
    [[ -n "$(awk -F'\t' -v p="${pid}" -v s="${st}" '$1 == "gone" && $2 == p && $3 == s && $4 ~ /^[0-9]+\.[0-9][0-9][0-9][0-9][0-9][0-9]$/' \
        "${SCENARIO_CSCB_RECORD}")" ]] || fail "${step}: the record has no gone entry for the ended run ${pid}"
    cscb_run false || rc=$?
    (( rc == 1 )) || fail "${step}: cscb_run false returned ${rc}, not 1"

    IFS=: read -r -a entries <<< "${PATH}"
    for dir in "${entries[@]}"; do
        [[ "${dir}" != "${SCENARIO_TMUX_SHIM_BIN}" ]] || fail "${step}: the scenario's shell has the tmux shim on its PATH"
    done
    [[ "$(type -P tmux)" == "${SCENARIO_REAL_TMUX}" ]] \
        || fail "${step}: the scenario's shell finds tmux at '$(type -P tmux)', not the real ${SCENARIO_REAL_TMUX}"
}

leg_live_start() {
    local step="live start" stub_dir stub_pid api_url creds work config_dir tmux_before ad_before
    local tmux_after ad_after server_path line n lines=()
    stub_dir="${SCENARIO_ROOT}/slack-stub"
    mkdir -p "${stub_dir}"
    creds="${SCENARIO_ROOT}/credentials"
    mkdir -m 700 "${creds}"
    config_dir="${SCENARIO_ROOT}/claude-config"
    mkdir -p "${config_dir}"
    work="$(make_workdir live)"

    # The Slack stub: one token pair, answered ok; any other refused.
    python3 - << 'EOF' | write_file "${stub_dir}/control.json"
import json
print(json.dumps({
    "tokens": [{"suffix": "livev1", "label": "live", "auth": "ok", "connections": "ok"}],
    "default": {"auth": "invalid_auth", "connections": "invalid_auth"},
}))
EOF
    (cd "${stub_dir}" && exec bun "${SCENARIO_FIXTURES}/slack-stub-server.ts" --record "${stub_dir}/record.jsonl" \
        --control "${stub_dir}/control.json" --ready-file "${stub_dir}/ready.json") > "${stub_dir}/stub.out" 2>&1 &
    stub_pid=$!
    track_pid "${stub_pid}"
    wait_for_file "${stub_dir}/ready.json" "${LIVE_STUB_WAIT_S}" "${step}: the Slack stub never wrote its ready file"
    api_url="$(jq -r '.api_url' "${stub_dir}/ready.json")"
    [[ "${api_url}" =~ ^http://127\.0\.0\.1:[0-9]+/api/$ ]] || fail "${step}: the stub's api_url '${api_url}' is not loopback"
    export CSCB_SLACK_API_URL="${api_url}"

    printf '{"bot_token": "%s", "app_token": "%s"}\n' "$(fake_token bot livev1)" "$(fake_token app livev1)" \
        | write_file "${creds}/live.json" 600
    write_config << EOF
{
  "personas": [
    {
      "name": "${LIVE_NAME}",
      "credentials_file": "${creds}/live.json",
      "working_directory": "${work}",
      "claude_config_dir": "${config_dir}",
      "channels": [{ "id": "C0T0LIVE1", "delivery": "all" }],
      "permission_prompts": "C0T0LIVE1"
    }
  ],
  "bind": "127.0.0.1",
  "port": ${SCENARIO_PORT},
  "health_check_interval": 0,
  "exit_timeout": 5
}
EOF

    tmux_before="$(line_count "${SCENARIO_TMUX_SHIM_LOG}")"
    ad_before="$(line_count "${SCENARIO_AD_SHIM_LOG}")"
    start_server --live
    wait_for_log "$(completion_match 1)" "${LIVE_START_WAIT_S}" "${step}: the start pass never completed"
    expect_completion 1 "${step}" "0 not brought up"
    # The stub prints the dev-channels dialog and fires SessionStart only on
    # the Enter the approver sends: the row reports in once it is cleared.
    wait_until "${LIVE_REPORT_WAIT_S}" "${step}: row ${LIVE_INSTANCE_ID} never reported in (waiting)" \
        row_state_is "${LIVE_INSTANCE_ID}" waiting
    tmux_after="$(line_count "${SCENARIO_TMUX_SHIM_LOG}")"
    ad_after="$(line_count "${SCENARIO_AD_SHIM_LOG}")"

    # The bot server is a recorded CSCB process with the shim first on PATH.
    server_path="$(tr '\0' '\n' < "/proc/${SERVER_PID}/environ" | sed -n 's/^PATH=//p')"
    [[ "${server_path}" == "${SCENARIO_TMUX_SHIM_BIN}":* ]] \
        || fail "${step}: the bot server's PATH '${server_path}' does not start with the tmux shim's ${SCENARIO_TMUX_SHIM_BIN}"
    [[ -n "$(awk -F'\t' -v p="${SERVER_PID}" '$1 == "proc" && $2 == "server" && $3 == p' "${SCENARIO_CSCB_RECORD}")" ]] \
        || fail "${step}: the record holds no server entry for the bot server ${SERVER_PID}"

    # The approver answered the dialog through agent-director: a send-keys
    # whose parent is the bot server.
    mapfile -t lines < <(cscb_ad_calls send-keys "${LIVE_INSTANCE_ID}")
    (( ${#lines[@]} >= 1 )) || fail "${step}: no send-keys for ${LIVE_INSTANCE_ID} whose parent is a CSCB process"
    for line in "${lines[@]}"; do
        read_call "${step}" "${line}"
        [[ "${CALL_PPID}" == "${SERVER_PID}" ]] || fail "${step}: a send-keys for ${LIVE_INSTANCE_ID} has parent ${CALL_PPID}, not the bot server ${SERVER_PID}"
    done
    # No harness call is counted as CSCB's.
    mapfile -t lines < <(cscb_ad_calls "")
    (( ${#lines[@]} >= 1 )) || fail "${step}: cscb_ad_calls printed no call of the bot server"
    for line in "${lines[@]}"; do
        read_call "${step}" "${line}"
        [[ "${CALL_PPID}" != "$$" ]] || fail "${step}: cscb_ad_calls printed a harness call: ${line}"
    done

    # No tmux line has the bot server as its parent.
    n="$(awk -F'\t' -v p="${SERVER_PID}" '$1 == "call" && $4 == p { n++ } END { print n + 0 }' "${SCENARIO_TMUX_SHIM_LOG}")"
    [[ "${n}" == 0 ]] || fail "${step}: ${n} tmux line(s) have the bot server ${SERVER_PID} as their parent"

    # The closing assertions pass over this start's own lines, and both
    # positive controls fail over the lines from before it.
    window_copy "${SCENARIO_ROOT}/window-live" "$(( tmux_before + 1 ))" "${tmux_after}" "$(( ad_before + 1 ))" "${ad_after}"
    expect_on_files "${step}: its own lines" "${SCENARIO_ROOT}/window-live" pass assert_no_server_tmux
    expect_on_files "${step}: its own lines" "${SCENARIO_ROOT}/window-live" pass assert_no_cscb_include_finished
    expect_on_files "${step}: its own lines" "${SCENARIO_ROOT}/window-live" pass assert_no_cscb_delete
    window_copy "${SCENARIO_ROOT}/window-before" 1 "${tmux_before}" 1 "${ad_before}"
    expect_on_files "${step}: the lines before it" "${SCENARIO_ROOT}/window-before" fail assert_no_server_tmux "positive control"
    expect_on_files "${step}: the lines before it" "${SCENARIO_ROOT}/window-before" fail assert_no_cscb_include_finished "positive control"

    stop_server --stop-bots
    stop_tracked_pid "${stub_pid}" 10 "${step}: the Slack stub did not exit on SIGTERM"
}

leg_harness_include_finished() {
    local step="harness include-finished" before i mine=() lines=()
    before="$(call_count)"
    ad kill --claude-instance-id "${T0_ROW_ID}" --include-finished > /dev/null 2>&1 || true
    : "$(ad kill --claude-instance-id "${T0_ROW_ID}" --include-finished 2>&1)"
    ad kill --claude-instance-id "${T0_ROW_ID}" --include-finished 2>&1 | cat > /dev/null || true
    mapfile -t lines < <(awk -F'\t' '$1 == "call"' "${SCENARIO_AD_SHIM_LOG}" | tail -n "+$(( before + 1 ))")
    (( ${#lines[@]} == 3 )) || fail "${step}: the three calls added ${#lines[@]} call line(s)"
    mapfile -d '' -t mine < "/proc/$$/cmdline"
    for i in 0 1 2; do
        read_call "${step}" "${lines[i]}"
        [[ "${CALL_WORDS[0]:-}" == kill && " ${CALL_WORDS[*]} " == *" --include-finished "* ]] \
            || fail "${step}: call $(( i + 1 ))'s words are $(quoted "${CALL_WORDS[@]}")"
        same_words CALL_PARENT mine \
            || fail "${step}: call $(( i + 1 ))'s parent $(quoted "${CALL_PARENT[@]}") does not have the shell's command line"
        if (( i == 0 )); then
            [[ "${CALL_PPID}" == "$$" ]] || fail "${step}: the plain call's parent is ${CALL_PPID}, not the shell $$"
        else
            [[ "${CALL_PPID}" != "$$" ]] || fail "${step}: call $(( i + 1 )) (a subshell's) has the shell $$ itself as its parent"
        fi
    done
    ( assert_no_cscb_include_finished ) > "${SCENARIO_ROOT}/harness-include-finished.out" 2>&1 || {
        sed 's/^/  | /' "${SCENARIO_ROOT}/harness-include-finished.out" >&2
        fail "${step}: assert_no_cscb_include_finished failed with the harness's calls in the log"
    }
}

leg_synthetic_server_tmux() {
    local step="synthetic assert_no_server_tmux" dir a="assert_no_server_tmux"
    dir="$(syn_case server-tmux-clean)"
    expect_on_files "${step}: clean" "${dir}" pass "${a}"

    dir="$(syn_case server-tmux-violation)"
    syn_line "${dir}/tmux-shim.log" call 1500.000000 7000002 "${SYN_SERVER}" "${SYN_SERVER_CMD}" list-sessions
    expect_on_files "${step}: a bot server's tmux call" "${dir}" fail "${a}" \
        "1 tmux-shim.log line(s) have a bot server the scenario started as their parent (line 2)"

    # The server's PID, given to another process after the server was gone.
    dir="$(syn_case server-tmux-reused-pid)"
    syn_line "${dir}/tmux-shim.log" call 3000.000000 7000002 "${SYN_SERVER}" "${SYN_SERVER_CMD}" list-sessions
    expect_on_files "${step}: the server's PID reused after it was gone" "${dir}" pass "${a}"

    dir="$(syn_case server-tmux-empty)"
    : > "${dir}/tmux-shim.log"
    expect_on_files "${step}: an empty tmux log" "${dir}" fail "${a}" "positive control"

    # Only a harness spawn's tmux call: its agent-director's parent is no CSCB process.
    dir="$(syn_case server-tmux-harness-only)"
    : > "${dir}/tmux-shim.log"
    syn_line "${dir}/agent-director-shim.log" call 1300.000000 6000010 "${SYN_SHELL}" "${SCENARIO_SHELL_CMDLINE}" \
        spawn --claude-instance-id t0-h
    syn_line "${dir}/tmux-shim.log" call 1300.100000 7000003 6000010 "${SYN_AD_CMD}" new-session -d -s t0-h
    expect_on_files "${step}: only the harness's agent-director" "${dir}" fail "${a}" "positive control"

    # The CSCB-run agent-director's PID, but the parent is not agent-director.
    dir="$(syn_case server-tmux-parent-not-ad)"
    : > "${dir}/tmux-shim.log"
    syn_line "${dir}/tmux-shim.log" call 1002.100000 7000001 6000002 'bash -c x' new-session -d -s slack_bot_alpha
    expect_on_files "${step}: a parent whose argv[0] is not agent-director" "${dir}" fail "${a}" "positive control"

    # A parent field that does not parse never counts, and (in this subshell)
    # still ends in the assertion's own FAIL line.
    dir="$(syn_case server-tmux-parent-unparsed)"
    : > "${dir}/tmux-shim.log"
    syn_line "${dir}/tmux-shim.log" call 1002.100000 7000001 6000002 "'unterminated" new-session -d -s slack_bot_alpha
    expect_on_files "${step}: a parent field that does not parse" "${dir}" fail "${a}" "positive control"

    # The parent PID's latest call at or before the tmux line was the
    # harness's (the PID reused), and a tmux line before any call of its PID.
    dir="$(syn_case server-tmux-latest-call)"
    : > "${dir}/tmux-shim.log"
    syn_line "${dir}/agent-director-shim.log" call 1003.000000 6000020 "${SYN_SERVER}" "${SYN_SERVER_CMD}" list
    syn_line "${dir}/agent-director-shim.log" call 1004.000000 6000020 "${SYN_SHELL}" "${SCENARIO_SHELL_CMDLINE}" list
    syn_line "${dir}/tmux-shim.log" call 1004.500000 7000004 6000020 "${SYN_AD_CMD}" list-sessions
    syn_line "${dir}/tmux-shim.log" call 1001.500000 7000005 6000002 "${SYN_AD_CMD}" list-sessions
    expect_on_files "${step}: the latest call of the parent PID was the harness's" "${dir}" fail "${a}" "positive control"

    # The agent-director call's parent PID is the server's, outside its window.
    dir="$(syn_case server-tmux-outside-window)"
    : > "${dir}/tmux-shim.log"
    syn_line "${dir}/agent-director-shim.log" call 3000.000000 6000030 "${SYN_SERVER}" "${SYN_SERVER_CMD}" list
    syn_line "${dir}/tmux-shim.log" call 3000.100000 7000006 6000030 "${SYN_AD_CMD}" list-sessions
    expect_on_files "${step}: a call by the server's PID outside its window" "${dir}" fail "${a}" "positive control"

    dir="$(syn_case server-tmux-format)"
    printf 'call\t1500.000000\t7000007\t6000002\tbash\n' >> "${dir}/tmux-shim.log"
    expect_on_files "${step}: a five-field line" "${dir}" fail "${a}" "tmux-shim.log line 2 is not in the shims' line format"
}

leg_synthetic_include_finished() {
    local step="synthetic assert_no_cscb_include_finished" dir got a="assert_no_cscb_include_finished"
    local why="run kill with --include-finished from a parent other than the scenario's own shell or a subshell of it"
    dir="$(syn_case finished-clean)"
    expect_on_files "${step}: clean" "${dir}" pass "${a}"

    dir="$(syn_case finished-server)"
    syn_line "${dir}/agent-director-shim.log" call 1500.000000 6000040 "${SYN_SERVER}" "${SYN_SERVER_CMD}" \
        kill --claude-instance-id cscb_alpha --include-finished
    expect_on_files "${step}: from the bot server" "${dir}" fail "${a}" "1 agent-director-shim.log line(s) ${why} (line 3)"

    dir="$(syn_case finished-run)"
    syn_line "${dir}/agent-director-shim.log" call 1150.000000 6000041 "${SYN_RUN}" "${SYN_RUN_CMD}" \
        kill --claude-instance-id cscb_alpha --include-finished
    expect_on_files "${step}: from a CSCB CLI run" "${dir}" fail "${a}" "1 agent-director-shim.log line(s) ${why} (line 3)"

    dir="$(syn_case finished-wrapper)"
    syn_line "${dir}/agent-director-shim.log" call 1500.000000 6000042 "${SYN_OTHER}" 'timeout 10 agent-director' \
        kill --claude-instance-id cscb_alpha --include-finished
    expect_on_files "${step}: from a wrapper process" "${dir}" fail "${a}" "1 agent-director-shim.log line(s) ${why} (line 3)"

    # The shell's command line, but a PID a CSCB process held at that time.
    dir="$(syn_case finished-shell-text-cscb-pid)"
    syn_line "${dir}/agent-director-shim.log" call 1150.000000 6000043 "${SYN_RUN}" "${SCENARIO_SHELL_CMDLINE}" \
        kill --claude-instance-id cscb_alpha --include-finished
    expect_on_files "${step}: the shell's command line on a CSCB process's PID" "${dir}" fail "${a}" \
        "1 agent-director-shim.log line(s) ${why} (line 3)"

    # The flag's other spellings, and a verb after a global flag.
    dir="$(syn_case finished-spellings)"
    syn_line "${dir}/agent-director-shim.log" call 1500.000000 6000044 "${SYN_SERVER}" "${SYN_SERVER_CMD}" \
        kill -include-finished --claude-instance-id cscb_alpha
    syn_line "${dir}/agent-director-shim.log" call 1500.100000 6000045 "${SYN_SERVER}" "${SYN_SERVER_CMD}" \
        kill --claude-instance-id cscb_alpha --include-finished=true
    syn_line "${dir}/agent-director-shim.log" call 1500.200000 6000046 "${SYN_SERVER}" "${SYN_SERVER_CMD}" \
        --home /h kill --claude-instance-id cscb_alpha --include-finished
    expect_on_files "${step}: -include-finished, =true and --home before the verb" "${dir}" fail "${a}" \
        "3 agent-director-shim.log line(s) ${why} (line 3, 4, 5)"

    # Not violations: the harness from its shell, a kill without the flag, the
    # flag on another verb, the server's PID outside its window from the
    # shell's text, and a stop line.
    dir="$(syn_case finished-allowed)"
    syn_line "${dir}/agent-director-shim.log" call 1500.000000 6000050 "${SYN_SHELL}" "${SCENARIO_SHELL_CMDLINE}" \
        kill --claude-instance-id cscb_alpha --include-finished
    syn_line "${dir}/agent-director-shim.log" call 1500.100000 6000051 "${SYN_SERVER}" "${SYN_SERVER_CMD}" \
        kill --claude-instance-id cscb_alpha
    syn_line "${dir}/agent-director-shim.log" call 1500.200000 6000052 "${SYN_SERVER}" "${SYN_SERVER_CMD}" \
        get --claude-instance-id cscb_alpha --include-finished
    syn_line "${dir}/agent-director-shim.log" call 3000.000000 6000053 "${SYN_SERVER}" "${SCENARIO_SHELL_CMDLINE}" \
        kill --claude-instance-id cscb_alpha --include-finished
    syn_line "${dir}/agent-director-shim.log" stop 1500.300000 6000054 "${SYN_SERVER}" "${SYN_SERVER_CMD}" \
        stub-claude kill --include-finished
    expect_on_files "${step}: the harness, no flag, another verb, a reused PID, a stop line" "${dir}" pass "${a}"

    # No call has a bot server as its parent: the harness's, a CLI run's, and
    # the server's PID outside its window.
    dir="$(syn_case finished-no-control)"
    : > "${dir}/agent-director-shim.log"
    syn_line "${dir}/agent-director-shim.log" call 1150.000000 6000060 "${SYN_RUN}" "${SYN_RUN_CMD}" version
    syn_line "${dir}/agent-director-shim.log" call 1500.000000 6000061 "${SYN_SHELL}" "${SCENARIO_SHELL_CMDLINE}" version
    syn_line "${dir}/agent-director-shim.log" call 3000.000000 6000062 "${SYN_SERVER}" "${SYN_SERVER_CMD}" version
    syn_line "${dir}/agent-director-shim.log" stop 1500.000000 6000063 "${SYN_SERVER}" "${SYN_SERVER_CMD}" stub-claude reason
    expect_on_files "${step}: no call of a bot server" "${dir}" fail "${a}" "positive control"

    dir="$(syn_case finished-format)"
    printf 'call\t1500.000000\t6000064\t%s\t%s\t%s\n' "${SYN_SERVER}" "${SYN_SERVER_CMD}" "kill 'unterminated" \
        >> "${dir}/agent-director-shim.log"
    expect_on_files "${step}: words that do not decode" "${dir}" fail "${a}" \
        "agent-director-shim.log line 3 is not in the shims' line format"
    # The same in a command substitution, as a count helper is called: its
    # FAIL line still comes out.
    got="$(on_files "${dir}" cscb_ad_count kill 2>&1)" && fail "${step}: cscb_ad_count passed words that do not decode"
    [[ "${got}" == *"FAIL: ${TEST_NAME}: cscb_ad_count: "*"agent-director-shim.log line 3 is not in the shims' line format"* ]] \
        || fail "${step}: cscb_ad_count in a command substitution failed without its FAIL line: ${got}"
}

leg_synthetic_delete() {
    local step="synthetic assert_no_cscb_delete" dir a="assert_no_cscb_delete" why="run delete from a CSCB process"
    dir="$(syn_case delete-clean)"
    expect_on_files "${step}: clean" "${dir}" pass "${a}"

    dir="$(syn_case delete-server)"
    syn_line "${dir}/agent-director-shim.log" call 1500.000000 6000070 "${SYN_SERVER}" "${SYN_SERVER_CMD}" \
        delete --claude-instance-id cscb_alpha
    expect_on_files "${step}: from the bot server" "${dir}" fail "${a}" "1 agent-director-shim.log line(s) ${why} (line 3)"

    dir="$(syn_case delete-run-and-global-flag)"
    syn_line "${dir}/agent-director-shim.log" call 1150.000000 6000071 "${SYN_RUN}" "${SYN_RUN_CMD}" \
        delete --claude-instance-id cscb_alpha
    syn_line "${dir}/agent-director-shim.log" call 1500.000000 6000072 "${SYN_SERVER}" "${SYN_SERVER_CMD}" \
        --store-path=/s delete --claude-instance-id cscb_alpha
    expect_on_files "${step}: from a CLI run, and after --store-path=" "${dir}" fail "${a}" \
        "2 agent-director-shim.log line(s) ${why} (line 3, 4)"

    dir="$(syn_case delete-allowed)"
    syn_line "${dir}/agent-director-shim.log" call 1500.000000 6000073 "${SYN_SHELL}" "${SCENARIO_SHELL_CMDLINE}" \
        delete --claude-instance-id t0-h
    syn_line "${dir}/agent-director-shim.log" call 3000.000000 6000074 "${SYN_SERVER}" "${SYN_SERVER_CMD}" \
        delete --claude-instance-id cscb_alpha
    syn_line "${dir}/agent-director-shim.log" stop 1500.100000 6000075 "${SYN_SERVER}" "${SYN_SERVER_CMD}" \
        stub-claude delete
    expect_on_files "${step}: the harness, a reused PID, a stop line" "${dir}" pass "${a}"

    dir="$(syn_case delete-format)"
    printf 'call\t1500.000000\tx\t%s\t%s\tdelete\n' "${SYN_SERVER}" "${SYN_SERVER_CMD}" >> "${dir}/agent-director-shim.log"
    expect_on_files "${step}: a PID that is not a number" "${dir}" fail "${a}" \
        "agent-director-shim.log line 3 is not in the shims' line format"
}

leg_count_helpers() {
    local step="count helpers" dir got want=()
    dir="$(syn_case counts)"
    # Base: the server's version (line 1) and spawn (line 2). Then a CLI run's
    # list (3), the harness's spawn (4), a stop line (5), the server's spawn
    # after a global flag (6), the server's PID outside its window (7).
    syn_line "${dir}/agent-director-shim.log" call 1150.000000 6000080 "${SYN_RUN}" "${SYN_RUN_CMD}" list
    syn_line "${dir}/agent-director-shim.log" call 1500.000000 6000081 "${SYN_SHELL}" "${SCENARIO_SHELL_CMDLINE}" \
        spawn --claude-instance-id cscb_alpha
    syn_line "${dir}/agent-director-shim.log" stop 1500.100000 6000082 "${SYN_SERVER}" "${SYN_SERVER_CMD}" \
        stub-claude spawn --claude-instance-id cscb_alpha
    syn_line "${dir}/agent-director-shim.log" call 1500.200000 6000083 "${SYN_SERVER}" "${SYN_SERVER_CMD}" \
        --home /h spawn --tmux-session-name s --claude-instance-id cscb_alpha
    syn_line "${dir}/agent-director-shim.log" call 3000.000000 6000084 "${SYN_SERVER}" "${SYN_SERVER_CMD}" \
        spawn --claude-instance-id cscb_alpha
    expect_count_on "${step}" "${dir}" 4 ""
    expect_count_on "${step}" "${dir}" 2 spawn
    expect_count_on "${step}" "${dir}" 2 spawn cscb_alpha
    expect_count_on "${step}" "${dir}" 2 spawn --claude-instance-id cscb_alpha
    expect_count_on "${step}" "${dir}" 0 spawn cscb_alpha --claude-instance-id
    expect_count_on "${step}" "${dir}" 1 list
    expect_count_on "${step}" "${dir}" 1 version
    expect_count_on "${step}" "${dir}" 0 --home
    expect_count_on "${step}" "${dir}" 0 delete
    got="$(on_files "${dir}" cscb_ad_calls spawn)" || fail "${step}: cscb_ad_calls spawn failed"
    want=("$(sed -n 2p "${dir}/agent-director-shim.log")" "$(sed -n 6p "${dir}/agent-director-shim.log")")
    [[ "${got}" == "$(printf '%s\n' "${want[@]}")" ]] \
        || fail "${step}: cscb_ad_calls spawn printed '${got}', not lines 2 and 6"
}

# expect_count_on <step> <dir> <want> <verb> [<fragment>...]: cscb_ad_count on
# <dir>'s files prints <want>.
expect_count_on() {
    local step="$1" dir="$2" want="$3" got
    shift 3
    got="$(on_files "${dir}" cscb_ad_count "$@")" || fail "${step}: cscb_ad_count $* failed"
    [[ "${got}" == "${want}" ]] || fail "${step}: cscb_ad_count $(quoted "$@") printed ${got}, not ${want}"
}

leg_closing_enforcement() {
    local step="closing enforcement" name
    name="test-0-fmk-nested-closing-pass"
    run_nested "${name}" rc nested_closing_pass nested_stand_in nested_closing
    if (( NESTED_RC != 0 )) || grep -q '^FAIL:' "${NESTED_OUT}" || ! grep -qxF "PASS: ${name}" "${NESTED_OUT}"; then
        sed 's/^/  | /' "${NESTED_OUT}" >&2
        fail "${step}: a run that ends with the closing assertions exited ${NESTED_RC}: $(grep -m1 '^FAIL:' "${NESTED_OUT}" || true)"
    fi

    name="test-0-fmk-nested-violation-after"
    run_nested "${name}" rc nested_violation_after nested_stand_in nested_closing
    expect_nested_markers "${step}: a violating line after the assertions" \
        assert_no_server_tmux assert_no_cscb_include_finished assert_no_cscb_delete "violating line written"
    expect_nested_only_fail "${step}: a violating line after the assertions" "${name}" \
        "after the closing assertions: assert_no_cscb_delete: 1 agent-director-shim.log line(s) run delete from a CSCB process (line 2)"

    name="test-0-fmk-nested-closing-elsewhere"
    run_nested "${name}" rc nested_closing_elsewhere nested_stand_in
    expect_nested_markers "${step}: assertions over copies and in a subshell" assert_no_server_tmux \
        "assert_no_cscb_include_finished over copies" "assert_no_cscb_delete in a subshell"
    expect_nested_only_fail "${step}: assertions over copies and in a subshell" "${name}" \
        "${ENFORCEMENT_LINE}assert_no_cscb_include_finished, assert_no_cscb_delete: not passed in its own shell)"

    name="test-0-fmk-nested-own-failure"
    run_nested "${name}" rc nested_own_failure nested_stand_in
    expect_nested_markers "${step}: a run that fails on its own" stand-in
    expect_nested_only_fail "${step}: a run that fails on its own" "${name}" "planted failure before the closing assertions"
}

# ---------------------------------------------------------------------------
# Run
# ---------------------------------------------------------------------------

LEGS=(
    isolation
    real_binary
    setup_install
    harness_call_log
    version_probe
    tmux_and_store
    swap
    reinstall
    hide_restore
    log_kept
    start_on_010
    guard_refusals
    shim_check
    tmux_shim_log
    fail_kill
    fail_create
    slow_create
    wedge
    mode_spawns_not_cscb
    path_wiring
    live_start
    harness_include_finished
    synthetic_server_tmux
    synthetic_include_finished
    synthetic_delete
    count_helpers
    closing_enforcement
)

for leg in "${LEGS[@]}"; do
    echo "${TEST_NAME}: leg ${leg}"
    "leg_${leg}"
done

# The closing assertions (b.jg5 SRJ-1401), met by the live start's own lines.
assert_no_server_tmux
assert_no_cscb_include_finished
assert_no_cscb_delete

echo "PASS: ${TEST_NAME}"
