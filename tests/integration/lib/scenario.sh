# shellcheck shell=bash
# tests/integration/lib/scenario.sh — shared helper for the docker integration
# scenario scripts (test-5 onwards). Sourced, never run:
#
#   #!/usr/bin/env bash
#   set -euo pipefail
#   TEST_NAME="test-N-<short-name>"
#   # shellcheck source=lib/scenario.sh
#   source "$(dirname "$0")/lib/scenario.sh"
#
# (tests/integration/.shellcheckrc lets `shellcheck` follow that directive
# without -x, so the helper's globals count as used.)
#
# Runs only inside the cscb-ci container (tests/runner.sh, via /ci), after
# Test 1 installed the package into /test-repo. Never source it on a dev box.
#
# What sourcing does:
# - sets TEST_NAME from the script's file name when the script did not;
# - makes the scenario's scratch root (SCENARIO_ROOT, `mktemp -d` under /tmp,
#   exported, so every process the scenario starts carries it in its
#   environment) and a first state dir under it, exported as SLACK_STATE_DIR,
#   so the scenario never touches ~/.claude/channels/slack or another
#   script's state (a fresh state dir has no config.json.last-applied);
# - picks a free port (SCENARIO_PORT; never 3100, which Tests 1-3's server
#   keeps) for the scenario's config to name;
# - sets SCENARIO_TAG ("t<N>" from TEST_NAME). Persona names must be unique
#   across scripts, since every script shares one HOME and one agent-director
#   store: build them from the tag (for example "${SCENARIO_TAG}_alpha");
# - installs an EXIT trap that stops every server the scenario started, kills
#   every process it registered with `track_pid`, runs the `on_exit` hooks,
#   prints the tail of each state dir's server.log when the script failed,
#   and removes SCENARIO_ROOT. The trap signals only a process that is still
#   the scenario's own (see "PIDs" below).
#
# Matchers (E14 decision 14). Scenario scripts assert a line's class prefix,
# persona ref and distinguishing fragments, never a whole sentence the unit
# tests own. A matcher is one or more fixed-string fragments; a line matches
# when it holds every fragment, in the given order (anything may sit between
# two fragments). A plain string is a one-fragment matcher, so every function
# below that takes a <matcher> also takes a plain fixed string. Build a
# multi-fragment matcher with `matcher`; the `*_match` builders return one.
# Fragments are fixed strings (no regex), matched unanchored: a `cwd=<dir>`
# fragment also matches a longer directory, so give no working dir a name
# that is a prefix of another's.
#
# Functions (every step that can fail calls `fail`, which prints the runner's
# `FAIL: <test>: <step>` line and exits 1; the trap then cleans up):
#
#   Steps and cleanup
#   fail <step>                        print the FAIL line and exit 1
#   on_exit <function>                 run <function> in the EXIT trap (see "Exit hooks")
#   track_pid <pid>                    kill <pid> in the EXIT trap (a background stub, for example)
#   stop_tracked_pid <pid> [<timeout-s>] [<step>]
#                                      SIGTERM <pid>, fail unless it is gone within <timeout-s>
#                                      (default 10), then stop tracking it
#
#   State dirs, ports, files
#   new_state_dir [<label>]            fresh state dir under SCENARIO_ROOT, exported as SLACK_STATE_DIR
#   free_port                          print a free loopback port (20000-29999)
#   make_workdir <name>                create and `git init` SCENARIO_ROOT/work/<name>; print its path
#   write_config                       stdin -> $SLACK_STATE_DIR/config.json, written atomically
#   write_file <path> [<mode>]         stdin -> <path>, written atomically (mode applied before the rename)
#
#   Server
#   run_start [--live]                 run `start`; set START_RC and START_OUT; never fails
#   start_server [--live]              run `start`, fail unless it exits 0 and the daemon is running; set SERVER_PID
#   stop_server [--stop-bots]          run `stop` (under `timeout 90`) for $SLACK_STATE_DIR (output in
#                                      STOP_OUT); fail unless its daemon is gone, then forget its PID
#   server_pid                         print the PID in $SLACK_STATE_DIR/server.pid (empty when none)
#   pid_alive <pid>                    true when <pid> is a live process (a zombie counts as gone)
#   port_listening <port>              true when an HTTP server answers on 127.0.0.1:<port>
#   port_closed <port>                 true when nothing answers on 127.0.0.1:<port>
#
#   Matching and counting (server.log is $SLACK_STATE_DIR/server.log)
#   matcher <fragment>...              print a matcher of the fragments, in order
#   matcher_text <matcher>             print a matcher readably (fragments joined by " … ")
#   count_in <file> <matcher>          print how many lines of <file> match (0 when no file)
#   count_log <matcher>                print how many server.log lines match (0 when no log)
#   first_log_line <matcher>           print the line number of the first matching server.log line (empty when none)
#   last_log_line <matcher>            print the line number of the last matching server.log line (empty when none)
#   expect_count <matcher> <want> <step>
#                                      fail unless exactly <want> server.log lines match
#   wait_for_log <matcher> <timeout-s> [<step>]
#   wait_for_count <matcher> <min> <timeout-s> [<step>]
#   wait_for_file <path> <timeout-s> [<step>]
#   wait_until <timeout-s> <step> <command> [<arg>...]
#
#   Line builders (each prints a matcher; see "Line builders" for the fragments)
#   persona_ref <name>                 print `"<name>" (key=<key>)` (text, not a matcher)
#   persona_start_match <index> <name>
#   skip_match <name> [<cwd>]
#   completion_match <persona-count>
#   counts [<field>=<n>]...            print the reload counts field (text, not a matcher)
#   preview_header_match [<field>=<n>]...
#   applied_match [<field>=<n>]...
#   destructive_match <name> <setting>
#   expect_completion <persona-count> <step> <part>...
#                                      fail unless the last completion line holds every "<n> <what>" part
#
#   Reload files ($SLACK_STATE_DIR/config.json.pending, .last-applied)
#   PENDING_HEADER                     line 1 of every pending file (src/reload-fingerprint.ts PENDING_FILE_HEADER)
#   pending_has_line <matcher>         true when a line of the pending file matches
#   check_pending_layout <step> [<field>=<n>]...
#                                      fail unless the pending file has the header, a sha256
#                                      fingerprint line and (with counts) a line holding `counts <field>=<n>...`
#   hold_not_applied <hold-s> <step> [<command> [<arg>...]]
#                                      for <hold-s> seconds: the record keeps its inode and bytes, no new
#                                      `[slack] reload-applied:` line, <command> stays true; then the
#                                      pending file still exists
#
#   HTTP
#   interject_status <persona> [<port>] [<body-file>]
#                                      print the HTTP status of POST /interject (000 when nothing
#                                      answers); the response body goes to <body-file> when given
#   expect_interject <persona> <status> <step> [<body-fragment>] [<port>]
#                                      fail unless POST /interject answers <status> and (when given)
#                                      its body holds <body-fragment>
#
#   Personas and tokens
#   persona_key <name>                 print the persona key the server derives from an ASCII <name>
#   fake_token <bot|app> <label>       print a fake token, built at runtime
#   count_token_like <file>...         print the number of token-like matches (never the text)
#
# Line builders (every fragment is quoted from src/; <ref> is `persona_ref`):
#   persona_start_match   `[slack] persona-start: personas[<index>] <ref>`
#                         (src/persona-bringup-controller.ts bringUp, format
#                         src/persona-diagnostics.ts formatPersonaDiagnostic)
#   skip_match            `[slack] dry-run: skipping spawn for <ref>`, then ` cwd=<cwd>` when given
#                         (src/session-manager.ts spawnForPersona)
#   completion_match      `[slack] startupSessionManager: complete — <n> persona(s):`
#                         (src/session-manager.ts startupSessionManager)
#   counts                `personas: <added> added, <removed> removed, <destructive> destructively
#                         modified, <in_place> modified in place, <credentials> with changed
#                         credentials; server-wide settings: <settings> changed`; fields
#                         added, removed, destructive, in_place, credentials, settings, each 0
#                         unless given (src/reload-plan.ts renderChangePlanCounts)
#   preview_header_match  `[slack] reload-preview: `, then the counts field
#                         (src/reload-plan.ts renderPreviewLogLines; only the header holds the counts)
#   applied_match         `[slack] reload-applied:`, then `(<counts>)`, then the record path quoted,
#                         `"<state dir>/config.json.last-applied"` (src/reload-apply.ts renderAppliedLogLine)
#   destructive_match     `DESTRUCTIVE: persona <ref>`, then ` <setting> changed` (src/reload-plan.ts
#                         destructiveLine; matches the pending-file line and its reload-preview log line)
#
# `start` runs with SLACK_BOT_TOKEN, SLACK_APP_TOKEN and CSCB_PERSONA unset,
# and with SLACK_DRY_RUN=1 unless `--live` is passed (then SLACK_DRY_RUN is
# unset). Any other variable the scenario exports reaches the daemon.
#
# Waiting: the reload tick runs 5 s after the previous pass and is not
# overridable, so wait with `wait_for_*` / `wait_until` and a stated bound,
# never with a fixed sleep. server.log is appended across starts in one state
# dir: to see a start's own lines, take `count_log` before it and
# `wait_for_count` for one more after it.
#
# PIDs: `stop_server` forgets its daemon's PID once the daemon is gone, and
# `stop_tracked_pid` forgets a tracked PID once it is gone. Before the trap
# stops or kills any PID it confirms the process is still the scenario's: a
# child of this shell, or a process whose environment holds this scenario's
# SCENARIO_ROOT. A PID the system reused for another process is left alone.
#
# Exit hooks: `on_exit <function>` registers extra cleanup (removing files
# outside SCENARIO_ROOT, for example). The trap runs the hooks in registration
# order, each in a subshell, after every server and tracked process is
# stopped and before SCENARIO_ROOT is removed; on success and on failure
# alike. A hook that exits non-zero (or calls `fail`) turns a passing run
# into a failed one; a hook's failure never stops the rest of the cleanup.
#
# Don't call a function that can fail inside `$( … )` unless the assignment
# stands alone (`dir="$(make_workdir a)"`): `set -e` then ends the script on
# its non-zero status, and the FAIL line it printed still reaches the runner.
#
# No token literal anywhere under tests/ (tests/secrecy-audit.test.ts): fake
# tokens come only from `fake_token`, which builds them at runtime.
#
# Don't replace the EXIT trap; register a background process with
# `track_pid` and extra cleanup with `on_exit` instead.

set -euo pipefail

if [[ -z "${TEST_NAME:-}" ]]; then
    TEST_NAME="$(basename "$0" .sh)"
fi

# The installed CLI (Test 1 installs the package into /test-repo).
SCENARIO_REPO="${SCENARIO_REPO:-/test-repo}"
SCENARIO_CLI="${SCENARIO_CLI:-${SCENARIO_REPO}/node_modules/.bin/claude-slack-channel-bots}"

# Poll interval of every wait, in seconds.
SCENARIO_POLL_S="0.2"

# Bound on the daemon exiting after `stop` reports success, in seconds.
SCENARIO_STOP_WAIT_S=15

# Bound on the CLI's `stop` itself, in seconds (as the trap's stop).
SCENARIO_STOP_CLI_S=90

# Lines of each server.log the trap prints when the script failed.
SCENARIO_LOG_TAIL_LINES=40

# The separator between a matcher's fragments (ASCII unit separator).
SCENARIO_SEP=$'\x1f'

# src/reload-fingerprint.ts PENDING_FILE_HEADER.
PENDING_HEADER='claude-slack-channel-bots: pending configuration change (written by the server)'

_SCENARIO_STATE_DIRS=()   # every state dir a `start` ran in
_SCENARIO_SERVER_PIDS=()  # daemon PIDs a start reported and no stop_server saw gone
_SCENARIO_TRACKED_PIDS=() # background processes registered with track_pid
_SCENARIO_EXIT_HOOKS=()   # functions registered with on_exit
_SCENARIO_LIVE=0          # 1 once a start ran with --live
_SCENARIO_STATE_COUNT=0
_SCENARIO_START_COUNT=0

fail() {
    echo "FAIL: ${TEST_NAME}: $1" >&2
    exit 1
}

# ---------------------------------------------------------------------------
# PIDs
# ---------------------------------------------------------------------------

pid_alive() {
    local pid="$1" state
    [[ "${pid}" =~ ^[0-9]+$ ]] || return 1
    kill -0 "${pid}" 2>/dev/null || return 1
    # A zombie is dead but still answers kill -0 until it is reaped. The
    # state is the field after the parenthesised command name.
    state="$(sed -E 's/^.*\) ([A-Za-z]).*$/\1/' "/proc/${pid}/stat" 2>/dev/null || true)"
    [[ "${state}" != "Z" ]]
}

_scenario_pid_gone() {
    ! pid_alive "$1"
}

# True when <pid> is gone or is no longer the scenario's (reused).
_scenario_pid_not_ours() {
    ! _scenario_pid_ours "$1"
}

# True when <pid> is live and still the scenario's own: a child of this
# shell, or a process whose environment names this SCENARIO_ROOT (the
# variable is exported before any process is started, so the daemons and
# every exec'd background process inherit it). A reused PID is neither.
_scenario_pid_ours() {
    local pid="$1" ppid
    pid_alive "${pid}" || return 1
    ppid="$(sed -n 's/^PPid:[[:space:]]*//p' "/proc/${pid}/status" 2>/dev/null || true)"
    [[ "${ppid}" == "$$" ]] && return 0
    [[ -n "${SCENARIO_ROOT:-}" ]] || return 1
    { tr '\0' '\n' < "/proc/${pid}/environ"; } 2>/dev/null \
        | grep -qxF -- "SCENARIO_ROOT=${SCENARIO_ROOT}"
}

# _scenario_drop <array-name> <pid>: remove every copy of <pid> from the array.
_scenario_drop() {
    local -n _scenario_drop_list="$1"
    local keep=() p
    for p in ${_scenario_drop_list[@]+"${_scenario_drop_list[@]}"}; do
        [[ "${p}" == "$2" ]] || keep+=("${p}")
    done
    _scenario_drop_list=(${keep[@]+"${keep[@]}"})
}

# _scenario_add <array-name> <pid>: append <pid> unless the array holds it.
_scenario_add() {
    local -n _scenario_add_list="$1"
    local p
    for p in ${_scenario_add_list[@]+"${_scenario_add_list[@]}"}; do
        [[ "${p}" == "$2" ]] && return 0
    done
    _scenario_add_list+=("$2")
}

track_pid() {
    [[ "${1:-}" =~ ^[0-9]+$ ]] || fail "track_pid: '${1:-}' is not a PID"
    _scenario_add _SCENARIO_TRACKED_PIDS "$1"
}

stop_tracked_pid() {
    local pid="${1:-}" timeout_s="${2:-10}"
    local step="${3:-tracked process ${pid} did not exit on SIGTERM}"
    [[ "${pid}" =~ ^[0-9]+$ ]] || fail "stop_tracked_pid: '${pid}' is not a PID"
    _scenario_check_timeout "${timeout_s}" "${step}"
    if _scenario_pid_ours "${pid}"; then
        kill -TERM "${pid}" 2>/dev/null || true
    fi
    _scenario_poll_until "${timeout_s}" _scenario_pid_not_ours "${pid}" \
        || fail "${step} (not within ${timeout_s}s)"
    _scenario_drop _SCENARIO_TRACKED_PIDS "${pid}"
}

on_exit() {
    declare -F -- "${1:-}" > /dev/null || fail "on_exit: '${1:-}' is not a function"
    _SCENARIO_EXIT_HOOKS+=("$1")
}

# ---------------------------------------------------------------------------
# Cleanup
# ---------------------------------------------------------------------------

# Stop the daemon of one state dir, if its PID file names a live process
# that is still the scenario's: the CLI `stop` first (with --stop-bots once a
# live start ran), bounded, then SIGKILL. Never fails.
_scenario_stop_dir() {
    local dir="$1" pid
    [[ -f "${dir}/server.pid" ]] || return 0
    pid="$(tr -d '[:space:]' < "${dir}/server.pid" 2>/dev/null || true)"
    [[ "${pid}" =~ ^[0-9]+$ ]] || return 0
    _scenario_pid_ours "${pid}" || return 0
    local args=(stop)
    [[ "${_SCENARIO_LIVE}" == 1 ]] && args+=(--stop-bots)
    SLACK_STATE_DIR="${dir}" timeout "${SCENARIO_STOP_CLI_S}" "${SCENARIO_CLI}" "${args[@]}" > /dev/null 2>&1 || true
    _scenario_pid_ours "${pid}" && kill -KILL "${pid}" 2>/dev/null
    return 0
}

_scenario_cleanup() {
    local rc=$? dir pid hook hook_rc
    set +e
    trap - EXIT
    for dir in ${_SCENARIO_STATE_DIRS[@]+"${_SCENARIO_STATE_DIRS[@]}"}; do
        _scenario_stop_dir "${dir}"
    done
    for pid in ${_SCENARIO_SERVER_PIDS[@]+"${_SCENARIO_SERVER_PIDS[@]}"} \
               ${_SCENARIO_TRACKED_PIDS[@]+"${_SCENARIO_TRACKED_PIDS[@]}"}; do
        if _scenario_pid_ours "${pid}"; then
            kill -TERM "${pid}" 2>/dev/null
            _scenario_poll_until 5 _scenario_pid_gone "${pid}" \
                || { _scenario_pid_ours "${pid}" && kill -KILL "${pid}" 2>/dev/null; }
        fi
    done
    for hook in ${_SCENARIO_EXIT_HOOKS[@]+"${_SCENARIO_EXIT_HOOKS[@]}"}; do
        ( "${hook}" )
        hook_rc=$?
        if [[ "${hook_rc}" -ne 0 ]]; then
            if [[ "${rc}" -eq 0 ]]; then
                echo "FAIL: ${TEST_NAME}: exit hook ${hook} failed (exit ${hook_rc})" >&2
                rc=1
            else
                echo "  | exit hook ${hook} also failed (exit ${hook_rc})" >&2
            fi
        fi
    done
    if [[ "${rc}" -ne 0 ]]; then
        for dir in ${_SCENARIO_STATE_DIRS[@]+"${_SCENARIO_STATE_DIRS[@]}"}; do
            [[ -f "${dir}/server.log" ]] || continue
            echo "--- ${TEST_NAME}: last ${SCENARIO_LOG_TAIL_LINES} lines of ${dir}/server.log ---" >&2
            # Indented, so no dumped line can pass for the runner's FAIL line.
            tail -n "${SCENARIO_LOG_TAIL_LINES}" "${dir}/server.log" | sed 's/^/  | /' >&2
        done
    fi
    if [[ -n "${SCENARIO_ROOT:-}" && -d "${SCENARIO_ROOT}" ]]; then
        rm -rf "${SCENARIO_ROOT}"
    fi
    exit "${rc}"
}

# ---------------------------------------------------------------------------
# Polling
# ---------------------------------------------------------------------------

_scenario_now_ms() {
    echo $(( $(date +%s%N) / 1000000 ))
}

# Run `<command> [<arg>...]` every SCENARIO_POLL_S until it succeeds (0) or
# <timeout-s> passes (1). The command runs once more at the deadline.
_scenario_poll_until() {
    local timeout_s="$1"; shift
    local deadline=$(( $(_scenario_now_ms) + timeout_s * 1000 ))
    while :; do
        if "$@"; then return 0; fi
        if (( $(_scenario_now_ms) >= deadline )); then
            "$@" && return 0
            return 1
        fi
        sleep "${SCENARIO_POLL_S}"
    done
}

_scenario_check_timeout() {
    [[ "$1" =~ ^[0-9]+$ ]] || fail "$2: timeout '$1' is not a whole number of seconds"
}

wait_until() {
    local timeout_s="$1" step="$2"; shift 2
    _scenario_check_timeout "${timeout_s}" "${step}"
    _scenario_poll_until "${timeout_s}" "$@" || fail "${step} (not within ${timeout_s}s)"
}

# ---------------------------------------------------------------------------
# Matchers
# ---------------------------------------------------------------------------

matcher() {
    local IFS="${SCENARIO_SEP}"
    printf '%s\n' "$*"
}

matcher_text() {
    printf '%s\n' "${1//${SCENARIO_SEP}/ … }"
}

# _scenario_scan <mode> <file> <matcher>: over the lines of <file> that hold
# every fragment of <matcher> in order, print by <mode>: `count` (how many;
# 0 when <file> is missing), `first` / `last` (the line number, empty when
# none) or `lastline` (the last such line's text). Byte-wise (LC_ALL=C), the
# fragments passed as operands, so no escape in them is interpreted.
_scenario_scan() {
    local mode="$1" file="$2" m="$3"
    if [[ ! -f "${file}" ]]; then
        [[ "${mode}" == count ]] && echo 0
        return 0
    fi
    LC_ALL=C awk '
        BEGIN {
            mode = ARGV[2]; n = split(ARGV[4], frags, ARGV[3])
            ARGV[2] = ""; ARGV[3] = ""; ARGV[4] = ""
            count = 0; first = ""; last = ""; lastline = ""
        }
        {
            rest = $0
            for (i = 1; i <= n; i++) {
                if (frags[i] == "") continue
                p = index(rest, frags[i])
                if (p == 0) next
                rest = substr(rest, p + length(frags[i]))
            }
            count++
            if (first == "") first = NR
            last = NR
            lastline = $0
        }
        END {
            if (mode == "count") print count
            else if (mode == "first") { if (first != "") print first }
            else if (mode == "last") { if (last != "") print last }
            else if (count > 0) print lastline
        }
    ' "${file}" "${mode}" "${SCENARIO_SEP}" "${m}"
}

count_in() {
    _scenario_scan count "$1" "$2"
}

count_log() {
    _scenario_scan count "${SLACK_STATE_DIR}/server.log" "$1"
}

first_log_line() {
    _scenario_scan first "${SLACK_STATE_DIR}/server.log" "$1"
}

last_log_line() {
    _scenario_scan last "${SLACK_STATE_DIR}/server.log" "$1"
}

expect_count() {
    local m="$1" want="$2" step="$3" n
    [[ "${want}" =~ ^[0-9]+$ ]] || fail "${step}: count '${want}' is not a whole number"
    n="$(count_log "${m}")"
    [[ "${n}" == "${want}" ]] \
        || fail "${step}: expected ${want} server.log line(s) matching '$(matcher_text "${m}")', found ${n}"
}

_scenario_log_has() {
    (( $(count_log "$1") > 0 ))
}

_scenario_log_count_at_least() {
    (( $(count_log "$1") >= $2 ))
}

wait_for_log() {
    local m="$1" timeout_s="$2"
    # shellcheck disable=SC2016 # the quotes are literal text in the step
    local step="${3:-server.log never showed '$(matcher_text "${m}")'}"
    _scenario_check_timeout "${timeout_s}" "${step}"
    _scenario_poll_until "${timeout_s}" _scenario_log_has "${m}" \
        || fail "${step} (not within ${timeout_s}s)"
}

wait_for_count() {
    local m="$1" min="$2" timeout_s="$3"
    # shellcheck disable=SC2016 # the quotes are literal text in the step
    local step="${4:-server.log never held ${min} line(s) matching '$(matcher_text "${m}")'}"
    [[ "${min}" =~ ^[0-9]+$ ]] || fail "${step}: count '${min}' is not a whole number"
    _scenario_check_timeout "${timeout_s}" "${step}"
    _scenario_poll_until "${timeout_s}" _scenario_log_count_at_least "${m}" "${min}" \
        || fail "${step} (not within ${timeout_s}s; found $(count_log "${m}"))"
}

wait_for_file() {
    local path="$1" timeout_s="$2"
    local step="${3:-${path} never appeared}"
    _scenario_check_timeout "${timeout_s}" "${step}"
    _scenario_poll_until "${timeout_s}" test -e "${path}" \
        || fail "${step} (not within ${timeout_s}s)"
}

# ---------------------------------------------------------------------------
# Line builders
# ---------------------------------------------------------------------------

# src/persona-identity.ts renderPersonaRef: the JSON-quoted name and the key.
# Names here hold no `"` or `\`, so the JSON quoting is plain quotes.
persona_ref() {
    local name="$1" key
    [[ "${name}" != *[\"\\]* ]] || fail "persona_ref: '${name}' holds a quote or a backslash"
    key="$(persona_key "${name}")" || exit 1
    printf '"%s" (key=%s)\n' "${name}" "${key}"
}

persona_start_match() {
    local ref
    [[ "${1:-}" =~ ^[0-9]+$ ]] || fail "persona_start_match: index '${1:-}' is not a whole number"
    ref="$(persona_ref "$2")" || exit 1
    matcher "[slack] persona-start: personas[$1] ${ref}"
}

skip_match() {
    local ref
    ref="$(persona_ref "$1")" || exit 1
    if [[ -n "${2:-}" ]]; then
        matcher "[slack] dry-run: skipping spawn for ${ref}" " cwd=$2"
    else
        matcher "[slack] dry-run: skipping spawn for ${ref}"
    fi
}

completion_match() {
    [[ "${1:-}" =~ ^[0-9]+$ ]] || fail "completion_match: persona count '${1:-}' is not a whole number"
    matcher "[slack] startupSessionManager: complete — $1 persona(s):"
}

expect_completion() {
    local n="$1" step="$2" m line part
    shift 2
    m="$(completion_match "${n}")" || exit 1
    line="$(_scenario_scan lastline "${SLACK_STATE_DIR}/server.log" "${m}")"
    [[ -n "${line}" ]] || fail "${step}: server.log has no line matching '$(matcher_text "${m}")'"
    # Each part is one whole "<n> <what>" field of the line, so a count
    # added to the line later does not break a scenario.
    for part in "$@"; do
        case "${line}" in
            *[:,]" ${part},"* | *[:,]" ${part}") ;;
            *) fail "${step}: completion line lacks '${part}': ${line#*\] }" ;;
        esac
    done
}

counts() {
    local added=0 removed=0 destructive=0 in_place=0 credentials=0 settings=0 spec field value
    for spec in "$@"; do
        field="${spec%%=*}"
        value="${spec#*=}"
        [[ "${spec}" == *=* && "${value}" =~ ^[0-9]+$ ]] \
            || fail "counts: '${spec}' is not <field>=<whole number>"
        case "${field}" in
            added) added="${value}" ;;
            removed) removed="${value}" ;;
            destructive) destructive="${value}" ;;
            in_place) in_place="${value}" ;;
            credentials) credentials="${value}" ;;
            settings) settings="${value}" ;;
            *) fail "counts: unknown field '${field}'" ;;
        esac
    done
    printf 'personas: %s added, %s removed, %s destructively modified, %s modified in place, %s with changed credentials; server-wide settings: %s changed\n' \
        "${added}" "${removed}" "${destructive}" "${in_place}" "${credentials}" "${settings}"
}

preview_header_match() {
    local c
    c="$(counts "$@")" || exit 1
    matcher '[slack] reload-preview: ' "${c}"
}

applied_match() {
    local c
    c="$(counts "$@")" || exit 1
    matcher '[slack] reload-applied:' "(${c})" "\"${SLACK_STATE_DIR}/config.json.last-applied\""
}

destructive_match() {
    local ref
    [[ -n "${2:-}" ]] || fail "destructive_match: no setting given"
    ref="$(persona_ref "$1")" || exit 1
    matcher "DESTRUCTIVE: persona ${ref}" " $2 changed"
}

# ---------------------------------------------------------------------------
# Reload files
# ---------------------------------------------------------------------------

pending_has_line() {
    (( $(count_in "${SLACK_STATE_DIR}/config.json.pending" "$1") > 0 ))
}

check_pending_layout() {
    local step="$1" pending="${SLACK_STATE_DIR}/config.json.pending" c
    shift
    [[ -f "${pending}" ]] || fail "${step}: ${pending} is missing"
    [[ "$(sed -n '1p' "${pending}")" == "${PENDING_HEADER}" ]] \
        || fail "${step}: pending file line 1 is not the server's header"
    [[ "$(sed -n '2p' "${pending}")" =~ ^fingerprint:\ sha256:[0-9a-f]{64}$ ]] \
        || fail "${step}: pending file line 2 is not 'fingerprint: sha256:<64 hex>'"
    if (( $# > 0 )); then
        c="$(counts "$@")" || exit 1
        pending_has_line "${c}" || fail "${step}: pending file lacks the counts '${c}'"
    fi
}

# One poll of hold_not_applied (0 while nothing is applied): the record
# keeps the inode and bytes it had when the hold began, the reload-applied
# count is unchanged, and the extra command, if any, holds.
_scenario_hold_ok() {
    local record="$1" snapshot="$2" inode="$3" applied="$4"; shift 4
    [[ "$(stat -c '%i' "${record}" 2>/dev/null || true)" == "${inode}" ]] || {
        _SCENARIO_HOLD_WHY="config.json.last-applied was rewritten"; return 1; }
    cmp -s -- "${snapshot}" "${record}" || {
        _SCENARIO_HOLD_WHY="config.json.last-applied changed"; return 1; }
    (( $(count_log '[slack] reload-applied:') == applied )) || {
        _SCENARIO_HOLD_WHY="a reload-applied line was logged"; return 1; }
    if (( $# > 0 )) && ! "$@"; then
        _SCENARIO_HOLD_WHY="'$*' stopped holding"; return 1
    fi
    return 0
}

hold_not_applied() {
    local hold_s="$1" step="$2"; shift 2
    local record="${SLACK_STATE_DIR}/config.json.last-applied"
    local pending="${SLACK_STATE_DIR}/config.json.pending"
    local snapshot="${SCENARIO_ROOT}/hold.last-applied" inode applied deadline
    _scenario_check_timeout "${hold_s}" "${step}"
    [[ -f "${record}" ]] || fail "${step}: ${record} is missing at the start of the hold"
    cp -- "${record}" "${snapshot}" || fail "${step}: could not snapshot ${record}"
    inode="$(stat -c '%i' "${record}")" || fail "${step}: could not stat ${record}"
    applied="$(count_log '[slack] reload-applied:')"
    _SCENARIO_HOLD_WHY=""
    deadline=$(( $(_scenario_now_ms) + hold_s * 1000 ))
    while (( $(_scenario_now_ms) < deadline )); do
        _scenario_hold_ok "${record}" "${snapshot}" "${inode}" "${applied}" "$@" \
            || fail "${step}: ${_SCENARIO_HOLD_WHY} before a confirmation"
        sleep "${SCENARIO_POLL_S}"
    done
    _scenario_hold_ok "${record}" "${snapshot}" "${inode}" "${applied}" "$@" \
        || fail "${step}: ${_SCENARIO_HOLD_WHY} before a confirmation"
    [[ -e "${pending}" ]] || fail "${step}: config.json.pending vanished before a confirmation"
}

# ---------------------------------------------------------------------------
# Processes
# ---------------------------------------------------------------------------

server_pid() {
    local file="${SLACK_STATE_DIR}/server.pid"
    [[ -f "${file}" ]] || return 0
    # The file can vanish under a stop between the test and the read.
    tr -d '[:space:]' < "${file}" 2> /dev/null || true
    echo
}

_scenario_pid_file_live() {
    local pid
    pid="$(server_pid)"
    [[ -n "${pid}" ]] && pid_alive "${pid}"
}

_scenario_register_state_dir() {
    local dir
    for dir in ${_SCENARIO_STATE_DIRS[@]+"${_SCENARIO_STATE_DIRS[@]}"}; do
        [[ "${dir}" == "$1" ]] && return 0
    done
    _SCENARIO_STATE_DIRS+=("$1")
}

run_start() {
    local live=0
    case "${1:-}" in
        --live) live=1 ;;
        "") ;;
        *) fail "run_start: unknown option '$1'" ;;
    esac
    [[ "${SLACK_STATE_DIR}" == "${SCENARIO_ROOT}"/* ]] \
        || fail "run_start: SLACK_STATE_DIR ${SLACK_STATE_DIR} is not under ${SCENARIO_ROOT}"
    _SCENARIO_START_COUNT=$(( _SCENARIO_START_COUNT + 1 ))
    START_OUT="${SCENARIO_ROOT}/start.${_SCENARIO_START_COUNT}.out"
    # Registered before the start: a start that reports failure may still
    # leave a daemon behind, and the trap stops it.
    _scenario_register_state_dir "${SLACK_STATE_DIR}"
    local env_args=(-u SLACK_BOT_TOKEN -u SLACK_APP_TOKEN -u CSCB_PERSONA -u SLACK_DRY_RUN)
    if [[ "${live}" == 1 ]]; then
        _SCENARIO_LIVE=1
    else
        env_args+=(SLACK_DRY_RUN=1)
    fi
    set +e
    (cd "${SCENARIO_REPO}" && env "${env_args[@]}" "${SCENARIO_CLI}" start) > "${START_OUT}" 2>&1
    START_RC=$?
    set -e
    local pid
    pid="$(server_pid)"
    if [[ -n "${pid}" ]]; then
        _scenario_add _SCENARIO_SERVER_PIDS "${pid}"
    fi
    return 0
}

start_server() {
    run_start "$@"
    if [[ "${START_RC}" -ne 0 ]]; then
        cat "${START_OUT}" >&2
        fail "start in ${SLACK_STATE_DIR} exited ${START_RC}"
    fi
    # `start` returns once the daemon wrote its PID file (it is then
    # listening), or after 30 s with the daemon still starting.
    _scenario_poll_until 30 _scenario_pid_file_live || {
        cat "${START_OUT}" >&2
        fail "no live daemon in ${SLACK_STATE_DIR}/server.pid after start"
    }
    SERVER_PID="$(server_pid)"
    _scenario_add _SCENARIO_SERVER_PIDS "${SERVER_PID}"
    # The trap signals only the scenario's own processes: a daemon it could
    # not recognise would outlive the script.
    _scenario_pid_ours "${SERVER_PID}" \
        || fail "daemon PID ${SERVER_PID} does not carry this scenario's SCENARIO_ROOT"
}

stop_server() {
    local args=(stop) rc
    case "${1:-}" in
        --stop-bots) args+=(--stop-bots) ;;
        "") ;;
        *) fail "stop_server: unknown option '$1'" ;;
    esac
    [[ "${SLACK_STATE_DIR}" == "${SCENARIO_ROOT}"/* ]] \
        || fail "stop_server: SLACK_STATE_DIR ${SLACK_STATE_DIR} is not under ${SCENARIO_ROOT}"
    local pid
    STOP_OUT="${SCENARIO_ROOT}/stop.out"
    pid="$(server_pid)"
    [[ -n "${pid}" ]] || fail "stop: no server.pid in ${SLACK_STATE_DIR}"
    set +e
    timeout "${SCENARIO_STOP_CLI_S}" "${SCENARIO_CLI}" "${args[@]}" > "${STOP_OUT}" 2>&1
    rc=$?
    set -e
    if [[ "${rc}" -ne 0 ]]; then
        cat "${STOP_OUT}" >&2
        if [[ "${rc}" -eq 124 ]]; then
            fail "${args[*]} in ${SLACK_STATE_DIR} did not finish within ${SCENARIO_STOP_CLI_S}s"
        fi
        fail "${args[*]} in ${SLACK_STATE_DIR} exited ${rc}"
    fi
    _scenario_poll_until "${SCENARIO_STOP_WAIT_S}" _scenario_pid_gone "${pid}" \
        || fail "server PID ${pid} still running ${SCENARIO_STOP_WAIT_S}s after ${args[*]}"
    # Gone: the trap must never signal this PID, which the system may reuse.
    _scenario_drop _SCENARIO_SERVER_PIDS "${pid}"
}

# ---------------------------------------------------------------------------
# State dirs, ports, files
# ---------------------------------------------------------------------------

new_state_dir() {
    _SCENARIO_STATE_COUNT=$(( _SCENARIO_STATE_COUNT + 1 ))
    local dir="${SCENARIO_ROOT}/state-${1:-${_SCENARIO_STATE_COUNT}}"
    [[ ! -e "${dir}" ]] || fail "new_state_dir: ${dir} already exists"
    mkdir -p "${dir}" || fail "new_state_dir: could not create ${dir}"
    export SLACK_STATE_DIR="${dir}"
}

free_port() {
    python3 - << 'EOF' || fail "free_port: no free port found in 20000-29999"
import random, socket, sys
# Outside the ephemeral range, so an outgoing connection can't take it later.
for port in random.sample(range(20000, 30000), 200):
    s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    try:
        s.bind(("127.0.0.1", port))
    except OSError:
        continue
    finally:
        s.close()
    print(port)
    sys.exit(0)
sys.exit(1)
EOF
}

make_workdir() {
    local dir="${SCENARIO_ROOT}/work/$1"
    mkdir -p "${dir}" || fail "make_workdir: could not create ${dir}"
    git -C "${dir}" init -q || fail "make_workdir: git init failed in ${dir}"
    printf '%s\n' "${dir}"
}

write_file() {
    local path="$1" mode="${2:-}"
    local tmp
    tmp="$(mktemp "$(dirname "${path}")/.scenario-write.XXXXXX")" \
        || fail "write_file: could not create a temp file beside ${path}"
    cat > "${tmp}" || fail "write_file: could not write ${path}"
    if [[ -n "${mode}" ]]; then
        chmod "${mode}" "${tmp}" || fail "write_file: chmod ${mode} failed for ${path}"
    fi
    # One rename, so a reload tick never reads a half-written file.
    mv -f "${tmp}" "${path}" || fail "write_file: could not rename into ${path}"
}

write_config() {
    write_file "${SLACK_STATE_DIR}/config.json"
}

# ---------------------------------------------------------------------------
# HTTP
# ---------------------------------------------------------------------------

interject_status() {
    local persona="$1" port="${2:-${SCENARIO_PORT}}" out="${3:-/dev/null}" body
    body="$(python3 -c 'import json, sys; print(json.dumps({"persona": sys.argv[1], "message": sys.argv[2]}))' \
        "${persona}" "${TEST_NAME} interject")"
    curl -s --max-time 10 -o "${out}" -w '%{http_code}' -X POST \
        -H 'Content-Type: application/json' -d "${body}" \
        "http://127.0.0.1:${port}/interject" || true
}

expect_interject() {
    local persona="$1" want="$2" step="$3" fragment="${4:-}" port="${5:-${SCENARIO_PORT}}"
    local out="${SCENARIO_ROOT}/interject.out" code
    rm -f -- "${out}"
    code="$(interject_status "${persona}" "${port}" "${out}")"
    [[ "${code}" == "${want}" ]] \
        || fail "${step}: /interject for ${persona} returned ${code}, expected ${want}"
    if [[ -n "${fragment}" ]] && ! grep -qF -- "${fragment}" "${out}" 2>/dev/null; then
        fail "${step}: /interject for ${persona} answered ${code} without '${fragment}'"
    fi
}

port_listening() {
    local code
    code="$(curl -s --max-time 5 -o /dev/null -w '%{http_code}' "http://127.0.0.1:$1/" || true)"
    [[ -n "${code}" && "${code}" != "000" ]]
}

port_closed() {
    ! port_listening "$1"
}

# ---------------------------------------------------------------------------
# Personas and tokens
# ---------------------------------------------------------------------------

# The key rule of src/persona-identity.ts personaKey (b.av2 SR-2.1), written
# out independently so the scenarios check the server against the rule, not
# against its own code. ASCII names only.
persona_key() {
    local name="$1" stem suffix
    if [[ "${name}" == *$'\n'* ]] || LC_ALL=C grep -q '[^ -~]' <<< "${name}"; then
        fail "persona_key: '${name}' is not printable ASCII"
    fi
    if [[ "${name}" =~ ^[a-z0-9_]{1,40}$ ]]; then
        printf '%s\n' "${name}"
        return 0
    fi
    suffix="$(printf '%s' "${name}" | sha256sum | cut -c1-8)"
    stem="$(printf '%s' "${name}" | LC_ALL=C tr '[:upper:]' '[:lower:]' \
        | LC_ALL=C sed -E 's/[^a-z0-9_]+/_/g; s/^_+//; s/_+$//')"
    stem="${stem:0:40}"
    if [[ -z "${stem}" ]]; then
        printf '%s\n' "${suffix}"
    else
        printf '%s_%s\n' "${stem}" "${suffix}"
    fi
}

# A fake token of a real token's shape: the prefix, a dash, the digit 1, the
# marker SCENARIOFAKE, then a dash and <label>. The prefix and the dash are
# joined only at runtime, so this file holds no token-like literal.
fake_token() {
    local prefix
    case "$1" in
        bot) prefix='xoxb' ;;
        app) prefix='xapp' ;;
        *) fail "fake_token: kind must be bot or app, not '$1'" ;;
    esac
    [[ "${2:-}" =~ ^[A-Za-z0-9]+$ ]] || fail "fake_token: label must be letters and digits"
    printf '%s-1SCENARIOFAKE-%s\n' "${prefix}" "$2"
}

# tests/test-helpers/credentials.ts TOKEN_LIKE, as an ERE (no look-behind):
# a Slack prefix not glued to a preceding letter or digit, a dash, then a
# letter or digit. Prints the count only, never the matched text. A missing
# file counts 0.
count_token_like() {
    local file total=0 n
    for file in "$@"; do
        [[ -f "${file}" ]] || continue
        n="$({ grep -oE '(^|[^A-Za-z0-9])(xox[a-z]|xapp)-[A-Za-z0-9]' "${file}" || true; } | wc -l)"
        total=$(( total + n ))
    done
    echo "${total}"
}

# ---------------------------------------------------------------------------
# Setup (runs on source)
# ---------------------------------------------------------------------------

[[ "${TEST_NAME}" =~ ^test-([0-9]+)- ]] \
    || fail "TEST_NAME '${TEST_NAME}' is not test-<N>-<name>"
SCENARIO_TAG="t${BASH_REMATCH[1]}"
export SCENARIO_TAG

command -v python3 > /dev/null 2>&1 || fail "python3 not on PATH (base image prerequisite)"
command -v curl > /dev/null 2>&1 || fail "curl not on PATH (base image prerequisite)"
[[ -x "${SCENARIO_CLI}" ]] \
    || fail "installed CLI ${SCENARIO_CLI} missing or not executable (Test 1 prerequisite)"

SCENARIO_ROOT="$(mktemp -d "/tmp/${TEST_NAME}.XXXXXX")" \
    || fail "could not create the scenario's scratch root"
export SCENARIO_ROOT
trap _scenario_cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

new_state_dir main
SCENARIO_PORT="$(free_port)"
export SCENARIO_PORT
