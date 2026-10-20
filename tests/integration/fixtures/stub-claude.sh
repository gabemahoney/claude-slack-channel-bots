#!/usr/bin/env bash
# Fake claude for contained integration launches through real AD and tmux.
# Modes are selected by resolved cwd in stub-claude-modes (last selection wins):
# at-once reports SessionStart immediately; manual-start waits for harness Enter;
# silent fires no hooks; transcript-on-first-message delays its transcript until
# message receipt; linger-on-exit fires SessionEnd but waits for harness SIGUSR1.
# Optional stub-claude-report-delays postpones at-once SessionStart in seconds.
# Hooks execute as direct children, preserving AD's process identity checks.
# SessionStart re-fires every two seconds while AD says pending, until its grace
# bound, to make lost-create-reply cases deterministic. Exact user messages go
# to the transcript for receipt assertions. No native dialog bytes are fixtures.
# Launch argv are recorded under flock; --version only prints its pinned line.

set -uo pipefail

# The version line `claude --version` prints: the Claude Code minimum
# agent-director states.
STUB_VERSION_LINE='2.1.280 (Claude Code)'

if [[ "${1:-}" == --version || "${1:-}" == -v ]]; then
    printf '%s\n' "${STUB_VERSION_LINE}"
    exit 0
fi

# ---------------------------------------------------------------------------
# Parse the args we care about: --settings <json>, --resume <session_id> and
# --mcp-config <path or json>.
# ---------------------------------------------------------------------------
SETTINGS_JSON=""
RESUME_SID=""
MCP_CONFIG=""
prev=""
for arg in "$@"; do
    case "${prev}" in
        --settings)   SETTINGS_JSON="${arg}" ;;
        --resume)     RESUME_SID="${arg}" ;;
        --mcp-config) MCP_CONFIG="${arg}" ;;
    esac
    prev="${arg}"
done

# ---------------------------------------------------------------------------
# session_id + transcript path. On a fresh launch, mint a new id; on resume,
# reuse the id agent-director passed. Claude Code stores transcripts at
# ~/.claude/projects/<cwd-with-slashes-and-dots-as-dashes>/<session_id>.jsonl.
# ---------------------------------------------------------------------------
SESSION_ID="${RESUME_SID}"
if [[ -z "${SESSION_ID}" ]]; then
    SESSION_ID="$(cat /proc/sys/kernel/random/uuid 2>/dev/null \
        || python3 -c 'import uuid;print(uuid.uuid4())' 2>/dev/null \
        || echo "11111111-1111-4111-8111-111111111111")"
fi

REALCWD="$(pwd -P)"
PROJ_KEY="$(printf '%s' "${REALCWD}" | sed 's#[/._]#-#g')"
PROJ_DIR="${HOME}/.claude/projects/${PROJ_KEY}"
TRANSCRIPT="${PROJ_DIR}/${SESSION_ID}.jsonl"

ensure_transcript() {
    # transcript-on-first-message (a harness addition): no transcript until
    # the first message (handle_line sets TRANSCRIPT_DUE).
    if [[ "${MODE}" == "${MODE_TRANSCRIPT_ON_FIRST_MESSAGE}" && "${TRANSCRIPT_DUE:-0}" != 1 ]]; then
        return 0
    fi
    mkdir -p "${PROJ_DIR}" 2>/dev/null || true
    if [[ ! -f "${TRANSCRIPT}" ]]; then
        # Minimal transcript so `claude --resume` has a file to reference.
        printf '{"type":"summary","summary":"stub-claude session","leafUuid":"%s"}\n' \
            "${SESSION_ID}" > "${TRANSCRIPT}" 2>/dev/null || true
    fi
}

# ---------------------------------------------------------------------------
# The mode. STUB_DIR is the directory of the path the stub was run by (the
# kernel hands bash the path execvp found, so a PATH lookup gives it whole).
# ---------------------------------------------------------------------------
MODE_AT_ONCE=at-once
MODE_SILENT=silent
MODE_MANUAL_START=manual-start
# A harness addition.
MODE_TRANSCRIPT_ON_FIRST_MESSAGE=transcript-on-first-message
MODE_LINGER_ON_EXIT=linger-on-exit

STUB_DIR="${BASH_SOURCE[0]%/*}"
[[ "${STUB_DIR}" == "${BASH_SOURCE[0]}" ]] && STUB_DIR=.
STUB_MODES_FILE="${STUB_DIR}/stub-claude-modes"

# The record of every launch's argument list (not a `--version` call, which
# exited above): one line per launch appended to `stub-claude-launch-args`
# beside the stub. Each argument is shell-quoted (`printf %q`), so an argument
# with spaces or newlines (the `--settings` JSON) stays one word on the one
# line, and the line is written under flock in one append, so concurrent stubs
# do not interleave. A failed write is reported on standard error and changes
# nothing else.
STUB_LAUNCH_ARGS_FILE="${STUB_DIR}/stub-claude-launch-args"
launch_args_line=""
printf -v launch_args_line '%q ' "$@"
{ /usr/bin/flock -x 9 && printf '%s\n' "${launch_args_line% }" >&9; } 9>> "${STUB_LAUNCH_ARGS_FILE}" 2> /dev/null \
    || printf 'stub-claude[%s]: could not record the launch arguments in %s\n' "$$" "${STUB_LAUNCH_ARGS_FILE}" >&2

MODE="${MODE_AT_ONCE}"
if [[ -f "${STUB_MODES_FILE}" ]]; then
    while IFS=$'\t' read -r sel_mode sel_dir; do
        [[ "${sel_dir}" == "${REALCWD}" ]] && MODE="${sel_mode}"
    done < "${STUB_MODES_FILE}"
fi
case "${MODE}" in
    "${MODE_AT_ONCE}" | "${MODE_SILENT}" | "${MODE_MANUAL_START}") ;;
    "${MODE_TRANSCRIPT_ON_FIRST_MESSAGE}") ;;
    "${MODE_LINGER_ON_EXIT}") ;;
    *)
        printf 'stub-claude: unknown mode %q selected for %s; running %s\n' \
            "${MODE}" "${REALCWD}" "${MODE_AT_ONCE}" >&2
        MODE="${MODE_AT_ONCE}"
        ;;
esac

# The report-in delay, in whole seconds: the last setting
# naming the directory, 0 when none does.
STUB_DELAYS_FILE="${STUB_DIR}/stub-claude-report-delays"
REPORT_DELAY_S=0
if [[ -f "${STUB_DELAYS_FILE}" ]]; then
    while IFS=$'\t' read -r sel_delay sel_dir; do
        [[ "${sel_dir}" == "${REALCWD}" ]] && REPORT_DELAY_S="${sel_delay}"
    done < "${STUB_DELAYS_FILE}"
fi
if [[ ! "${REPORT_DELAY_S}" =~ ^[0-9]+$ ]]; then
    printf 'stub-claude: report-in delay %q set for %s is not a whole number of seconds; no delay\n' \
        "${REPORT_DELAY_S}" "${REALCWD}" >&2
    REPORT_DELAY_S=0
fi
REPORT_DELAY_S=$(( 10#${REPORT_DELAY_S} ))

# ---------------------------------------------------------------------------
# Registered hooks. HOOK_ARGV_JQ emits, for each `"type": "command"` entry of
# event $ev in every group, the entry's argv length and then its argv
# elements, each NUL-terminated. HOOK_FILE holds jq's output while it is read
# into the event's array, and later the payload a hook reads on stdin; it lives
# outside the transcript directory.
# ---------------------------------------------------------------------------
# shellcheck disable=SC2016 # $s and $ev are jq variables, not shell ones.
HOOK_ARGV_JQ='
  $s | objects | .hooks | objects | .[$ev] | arrays | .[]
  | objects | .hooks | arrays | .[]
  | objects | select(.type == "command" and (.command | type) == "string")
  | if (.args | type) == "array"
    then [.command] + [.args[] | tostring]
    else [.command | splits("[ \t\n]+") | select(length > 0)]
    end
  | select(length > 0)
  | "\(length)\u0000" + (map(. + "\u0000") | join(""))
'
HOOK_FILE="${TMPDIR:-/tmp}/stub-claude-hook-$$"
START_HOOKS=()
END_HOOKS=()
if [[ -n "${SETTINGS_JSON}" ]]; then
    if jq -nj --argjson s "${SETTINGS_JSON}" --arg ev SessionStart \
        "${HOOK_ARGV_JQ}" > "${HOOK_FILE}" 2>/dev/null; then
        mapfile -d '' -t START_HOOKS < "${HOOK_FILE}"
    fi
    if jq -nj --argjson s "${SETTINGS_JSON}" --arg ev SessionEnd \
        "${HOOK_ARGV_JQ}" > "${HOOK_FILE}" 2>/dev/null; then
        mapfile -d '' -t END_HOOKS < "${HOOK_FILE}"
    fi
    rm -f "${HOOK_FILE}"
fi

SENTINEL="__CSCB_TEST_EXIT__"

# fire_hooks <len> <argv…> [<len> <argv…> …]
# Runs each argv as a direct child of this process, one after another, with
# HOOK_FILE on stdin. A hook's exit status is not acted on.
fire_hooks() {
    local n
    while (( $# > 0 )); do
        n="$1"
        shift
        if [[ ! "${n}" =~ ^[0-9]+$ ]] || (( n < 1 || n > $# )); then
            return 0
        fi
        "${@:1:n}" < "${HOOK_FILE}" >/dev/null 2>&1
        shift "${n}"
    done
}

fire_session_start() {
    ensure_transcript
    if (( ${#START_HOOKS[@]} > 0 )); then
        printf '{"hook_event_name":"SessionStart","session_id":"%s","cwd":"%s","transcript_path":"%s","source":"startup"}\n' \
            "${SESSION_ID}" "${REALCWD}" "${TRANSCRIPT}" > "${HOOK_FILE}" \
            && fire_hooks "${START_HOOKS[@]}"
        rm -f "${HOOK_FILE}"
    fi
}

fire_session_end() {
    if (( ${#END_HOOKS[@]} > 0 )); then
        printf '{"hook_event_name":"SessionEnd","session_id":"%s","cwd":"%s","transcript_path":"%s","reason":"exit"}\n' \
            "${SESSION_ID}" "${REALCWD}" "${TRANSCRIPT}" > "${HOOK_FILE}" \
            && fire_hooks "${END_HOOKS[@]}"
        rm -f "${HOOK_FILE}"
    fi
}

# ---------------------------------------------------------------------------
# Dialogs
# ---------------------------------------------------------------------------

# Pending fixture controlled by a human/harness Enter. It contains no native UI.
print_manual_start() {
    printf 'Waiting for operator\n'
}

clear_manual_start() {
    printf '\033[H\033[2J\033[3J'
}

# ---------------------------------------------------------------------------
# Clock
# ---------------------------------------------------------------------------

# Set NOW_MS to the time now, in milliseconds since the epoch.
now_ms() {
    local us="${EPOCHREALTIME//[!0-9]/}"
    NOW_MS=$(( 10#${us} / 1000 ))
}

# ---------------------------------------------------------------------------
# The SessionStart re-fire
# ---------------------------------------------------------------------------

# agent-director's default pending grace period, in seconds.
DEFAULT_PENDING_GRACE_S=60
# The re-fire's period, in milliseconds.
REFIRE_PERIOD_MS=2000

# The program the first registered SessionStart entry names: the status
# reads run it, and its directory holds the shim's log in an fmk HOME.
STATUS_BIN="${START_HOOKS[1]:-}"
STATUS_OUT="${TMPDIR:-/tmp}/stub-claude-status-$$"
REFIRE_ON=0
NEXT_TICK_MS=0

# Set GRACE_S to G (see the header).
read_grace() {
    local file="${HOME}/.config/agent-director/config.toml" v=""
    # Deliberate pre-0.12 worker contract: the registered old hook selects
    # the old config layout, just as it selects the old status flag below.
    # A binary swap after migration keeps the installed hook's current layout.
    case "${STATUS_BIN}" in
        */.agent-director/bin/*) file="${HOME}/.agent-director/config.toml" ;;
    esac
    GRACE_S="${DEFAULT_PENDING_GRACE_S}"
    [[ -f "${file}" ]] || return 0
    v="$(awk '
        /^[[:space:]]*\[/ {
            t = $0
            sub(/#.*/, "", t)
            gsub(/[[:space:]]/, "", t)
            intmux = (t == "[tmux]")
            next
        }
        intmux && /^[[:space:]]*pending_grace_seconds[[:space:]]*=/ {
            v = $0
            sub(/^[^=]*=[[:space:]]*/, "", v)
            sub(/[[:space:]]*(#.*)?$/, "", v)
            print v
            exit
        }
    ' "${file}" 2> /dev/null)"
    if [[ "${v}" =~ ^[0-9]+$ ]] && (( 10#${v} > 0 )); then
        GRACE_S=$(( 10#${v} ))
    fi
}

# write_stop_line <instance id> <why…>: the one stop line (see the header).
write_stop_line() {
    local id="$1" words="" parent='?' line log
    shift
    local reason=(stub-claude stopped re-firing SessionStart for instance "${id}:" "$@")
    local parent_argv=()
    printf -v words '%q ' "${reason[@]}"
    words="${words% }"
    if mapfile -d '' -t parent_argv 2> /dev/null < "/proc/${PPID}/cmdline" \
        && (( ${#parent_argv[@]} > 0 )); then
        printf -v parent '%q ' "${parent_argv[@]}"
        parent="${parent% }"
    fi
    printf -v line 'stop\t%s\t%s\t%s\t%s\t%s' \
        "${EPOCHREALTIME/,/.}" "$$" "${PPID}" "${parent}" "${words}"
    log=""
    if [[ "${STATUS_BIN}" == */* ]]; then
        log="${STATUS_BIN%/*}/agent-director-shim.log"
    fi
    if [[ -n "${log}" && -f "${log}" ]] \
        && { /usr/bin/flock -x 9 && printf '%s\n' "${line}" >&9; } 9>> "${log}"; then
        return 0
    fi
    printf '%s\n' "${line}" >&2
}

stop_refire() {
    REFIRE_ON=0
    rm -f "${STATUS_OUT}" "${STATUS_OUT}.err"
}

# One tick: read the row, then re-fire, stop silently, or stop with the
# stop line.
refire_tick() {
    local id="${AGENT_DIRECTOR_INSTANCE_ID:-}" flag=--instance-id rc=0 parsed state launch launch_ms
    # Deliberate pre-0.12 worker contract: the old hook binary lives in the
    # old install layout and accepts only the old status flag. The worker id
    # environment variable itself did not change between these releases.
    case "${STATUS_BIN}" in
        */.agent-director/bin/*) flag=--claude-instance-id ;;
    esac
    if [[ -z "${id}" ]]; then
        stop_refire
        write_stop_line - AGENT_DIRECTOR_INSTANCE_ID is unset or empty
        return 0
    fi
    "${STATUS_BIN}" status "${flag}" "${id}" > "${STATUS_OUT}" 2> "${STATUS_OUT}.err" || rc=$?
    if (( rc != 0 )); then
        stop_refire
        write_stop_line "${id}" the status read exited "${rc}"
        return 0
    fi
    parsed="$(jq -r 'if type == "object" and (.state | type) == "string"
                     then [.state, (.launch_started_at // "" | tostring)] | @tsv
                     else empty end' "${STATUS_OUT}" 2> /dev/null)"
    if [[ -z "${parsed}" || "${parsed}" == *$'\n'* ]]; then
        stop_refire
        write_stop_line "${id}" the status read printed no status object
        return 0
    fi
    IFS=$'\t' read -r state launch <<< "${parsed}"
    if [[ "${state}" != pending ]]; then
        stop_refire
        return 0
    fi
    if [[ -z "${launch}" ]]; then
        stop_refire
        write_stop_line "${id}" the row reads pending with no launch start
        return 0
    fi
    if ! launch_ms="$(date -u -d "${launch}" +%s%3N 2> /dev/null)" || [[ ! "${launch_ms}" =~ ^[0-9]+$ ]]; then
        stop_refire
        write_stop_line "${id}" the status read gave a launch start that is not a time: "${launch}"
        return 0
    fi
    read_grace
    now_ms
    if (( NOW_MS >= 10#${launch_ms} + GRACE_S * 1000 )); then
        stop_refire
        return 0
    fi
    fire_session_start
}

start_refire() {
    (( ${#START_HOOKS[@]} > 0 )) || return 0
    REFIRE_ON=1
    now_ms
    NEXT_TICK_MS=$(( NOW_MS + REFIRE_PERIOD_MS ))
}

# ---------------------------------------------------------------------------
# The MCP session
# ---------------------------------------------------------------------------

MCP_CLIENT="${STUB_DIR}/stub-mcp-session.ts"
MCP_LOG="${STUB_DIR}/stub-mcp-session.log"
MCP_PID=""

mcp_session_running() {
    [[ -n "${MCP_PID}" ]] && kill -0 "${MCP_PID}" 2> /dev/null
}

open_mcp_session() {
    local bun_bin
    [[ -f "${MCP_CLIENT}" && -n "${MCP_CONFIG}" ]] || return 0
    mcp_session_running && return 0
    if [[ -n "${MCP_PID}" ]]; then
        wait "${MCP_PID}" 2> /dev/null
        MCP_PID=""
    fi
    bun_bin="$(command -v bun 2> /dev/null)" || {
        printf 'stub-claude[%s]: no bun on PATH; no MCP session opened\n' "$$" >> "${MCP_LOG}" 2> /dev/null
        return 0
    }
    "${bun_bin}" "${MCP_CLIENT}" "${MCP_CONFIG}" "${REALCWD}" < /dev/null >> "${MCP_LOG}" 2>&1 &
    MCP_PID=$!
}

# How long `/mcp reconnect` waits for a still-running client to end on
# SIGTERM before it sends SIGKILL, in tenths of a second.
MCP_END_WAIT_TENTHS=30

# reconnect_mcp_session: `/mcp reconnect`: end the client if one still runs
# (SIGTERM; SIGKILL when it has not ended within MCP_END_WAIT_TENTHS), reap
# it, then open a new session.
reconnect_mcp_session() {
    local i
    if mcp_session_running; then
        kill -TERM "${MCP_PID}" 2> /dev/null
        for (( i = 0; i < MCP_END_WAIT_TENTHS; i++ )); do
            mcp_session_running || break
            sleep 0.1
        done
        if mcp_session_running; then
            kill -KILL "${MCP_PID}" 2> /dev/null
        fi
        wait "${MCP_PID}" 2> /dev/null
        MCP_PID=""
    fi
    open_mcp_session
}

close_mcp_session() {
    if mcp_session_running; then
        kill -TERM "${MCP_PID}" 2> /dev/null
    fi
}

KEY_READER_PID=""
close_key_reader() {
    if [[ -n "${KEY_READER_PID}" ]]; then
        kill "${KEY_READER_PID}" 2> /dev/null || true
        wait "${KEY_READER_PID}" 2> /dev/null || true
    fi
}

trap 'close_key_reader; close_mcp_session; rm -f "${HOOK_FILE}" "${STATUS_OUT}" "${STATUS_OUT}.err"' EXIT

# ---------------------------------------------------------------------------
# Reporting in, and the read loop
# ---------------------------------------------------------------------------

REPORTED=0
AWAITING_ENTER=0
# While the report-in delay runs: when SessionStart is due, in milliseconds
# since the epoch; 0 otherwise.
REPORT_DUE_MS=0

report_in() {
    REPORTED=1
    AWAITING_ENTER=0
    fire_session_start
    draw_composer
    open_mcp_session
    start_refire
}

# Read raw keys so literal LF belongs to a message and CR alone submits it.
# C-u is the clear used by agent-director's pause path.
composer=""
draw_composer() {
    printf '%s\n' 'Listening for channel messages from: server:slack-channel-router'
    printf 'buffer: %s\n' "${composer}"
}

append_user_receipt() {
    local text="$1" uuid timestamp
    TRANSCRIPT_DUE=1
    ensure_transcript
    uuid="$(cat /proc/sys/kernel/random/uuid)"
    timestamp="$(date -u +%Y-%m-%dT%H:%M:%S.%3NZ)"
    jq -nc --arg text "${text}" --arg uuid "${uuid}" --arg session "${SESSION_ID}" --arg timestamp "${timestamp}" \
        '{type:"user",isSidechain:false,origin:{kind:"human"},uuid:$uuid,timestamp:$timestamp,sessionId:$session,message:{role:"user",content:$text}}' \
        >> "${TRANSCRIPT}"
}

# Disable terminal translations before reporting in: a prompt answer may be
# queued as soon as SessionStart fires. Literal LF is text; tmux's Enter is CR.
if [[ -t 0 ]]; then
    stty -icanon -echo -icrnl -inlcr -igncr min 1 time 0
    # Bash's character read re-enables ICRNL on a terminal. Read through a
    # pipe instead, so CR stays Enter and a literal LF stays draft content.
    # The forwarding child reads the original terminal and is reaped on exit.
    exec < <(exec cat)
    KEY_READER_PID=$!
fi

case "${MODE}" in
    "${MODE_MANUAL_START}")
        print_manual_start
        AWAITING_ENTER=1
        ;;
    "${MODE_AT_ONCE}" | "${MODE_TRANSCRIPT_ON_FIRST_MESSAGE}" | "${MODE_LINGER_ON_EXIT}")
        if (( REPORT_DELAY_S > 0 )); then
            printf 'Starting worker\n'
            now_ms
            REPORT_DUE_MS=$(( NOW_MS + REPORT_DELAY_S * 1000 ))
        else
            report_in
        fi
        ;;
    "${MODE_SILENT}")
        ;;
esac

# ---------------------------------------------------------------------------
# Lingering (`linger-on-exit`; see LINGERING)
# ---------------------------------------------------------------------------

# The line agent-director's `pause` types.
PAUSE_EXIT_LINE=/exit
LINGER_MARKER="${STUB_DIR}/stub-claude-lingering.$$"
RELEASED=0

# Mark the stub lingering, end the session, then wait for the release or the
# end of stdin, and exit 0. Never returns.
linger_after_exit() {
    local rc
    trap 'RELEASED=1' USR1
    trap 'close_key_reader; close_mcp_session; rm -f "${HOOK_FILE}" "${STATUS_OUT}" "${STATUS_OUT}.err" "${LINGER_MARKER}"' EXIT
    { printf '%s\n' "${REALCWD}" > "${LINGER_MARKER}.tmp" && mv -f -- "${LINGER_MARKER}.tmp" "${LINGER_MARKER}"; } 2> /dev/null \
        || printf 'stub-claude[%s]: could not write %s\n' "$$" "${LINGER_MARKER}" >&2
    fire_session_end
    stop_refire
    close_mcp_session
    while (( ! RELEASED )); do
        IFS= read -r -t 1 _
        rc=$?
        # A line or a timeout (or the release) goes round again; stdin closed ends it.
        (( rc == 0 || rc > 128 )) || break
    done
    exit 0
}

# handle_line <line>: the complete submitted composer (literal LFs retained).
handle_line() {
    local line="$1"
    if [[ "${line}" == *"${SENTINEL}"* ]]; then
        [[ "${MODE}" == "${MODE_SILENT}" ]] || fire_session_end
        exit 0
    fi
    if [[ "${MODE}" == "${MODE_LINGER_ON_EXIT}" && "${line}" == "${PAUSE_EXIT_LINE}" ]] && (( REPORTED )); then
        linger_after_exit
    fi
    # transcript-on-first-message: the first message after reporting in
    # writes the transcript; a slash command (a line starting with `/`, such
    # as `/exit` or `/mcp reconnect`) is no message.
    if (( REPORTED )) && [[ "${line}" =~ [^[:space:]] && ! "${line}" =~ ^[[:space:]]*/ ]]; then
        append_user_receipt "${line}"
    fi
    if (( AWAITING_ENTER )); then
        clear_manual_start
        report_in
    elif (( REPORTED )) && [[ "${line}" == '/mcp reconnect' || "${line}" == '/mcp reconnect '?* ]]; then
        reconnect_mcp_session
    fi
}

# Read loop. While report-in is delayed, each read waits until SessionStart
# is due. While the re-fire
# runs, each read waits at most until the next tick. A timeout cannot discard
# a partially typed message: each completed key is already in the composer.
handle_key() {
    case "$1" in
        $'\r')
            local submitted="${composer}"
            composer=""
            handle_line "${submitted}"
            (( REPORTED )) && draw_composer
            ;;
        $'\025')
            composer=""
            (( REPORTED )) && draw_composer
            ;;
        $'\177'|$'\b')
            composer="${composer%?}"
            (( REPORTED )) && draw_composer
            ;;
        *)
            composer+="$1"
            (( REPORTED )) && draw_composer
            ;;
    esac
    return 0
}

while :; do
    key=""
    if (( REPORT_DUE_MS > 0 )); then
        now_ms
        wait_ms=$(( REPORT_DUE_MS - NOW_MS ))
        if (( wait_ms <= 0 )); then
            REPORT_DUE_MS=0
            report_in
            continue
        fi
        printf -v wait_s '%d.%03d' $(( wait_ms / 1000 )) $(( wait_ms % 1000 ))
        IFS= read -r -N 1 -t "${wait_s}" key
        rc=$?
        if (( rc > 128 )); then
            continue
        fi
    elif (( REFIRE_ON )); then
        now_ms
        wait_ms=$(( NEXT_TICK_MS - NOW_MS ))
        if (( wait_ms <= 0 )); then
            refire_tick
            now_ms
            NEXT_TICK_MS=$(( NOW_MS + REFIRE_PERIOD_MS ))
            continue
        fi
        printf -v wait_s '%d.%03d' $(( wait_ms / 1000 )) $(( wait_ms % 1000 ))
        IFS= read -r -N 1 -t "${wait_s}" key
        rc=$?
        if (( rc > 128 )); then
            continue
        fi
    else
        IFS= read -r -N 1 key
        rc=$?
    fi
    # stdin closed (tmux pane killed): exit.
    (( rc == 0 )) || break
    handle_key "${key}"
done

exit 0
