#!/usr/bin/env bash
# stub-claude.sh — a fake `claude` binary for the integration tests that launch
# a real bot through agent-director and tmux (Test 4, Test 10, Test 12 and the
# fmk scenarios, test-0 and test-13 onward).
#
# Each of those tests copies this file first on PATH as `claude`, so the real
# agent-director and tmux launch path runs without the Anthropic API or a
# model. agent-director starts `claude` in a tmux pane with at least two argv
# elements, so no shell stands between tmux and this script: the stub's own
# process is the pane's main process.
#
# `claude --version` (or `-v`) prints `2.1.280 (Claude Code)` and exits 0, the
# version line of the Claude Code agent-director states as its minimum.
#
# MODES
# -----
# The stub's working directory, by its resolved real path, chooses its mode.
# The harness writes the selection (lib/scenario.sh `stub_mode`) to the file
# `stub-claude-modes` beside the stub (the directory of the path the stub was
# run by), one line per selection: `<mode> TAB <real path>`; the last line
# naming the directory wins. The selection reads no environment variable, so
# it holds whatever environment tmux or agent-director gives the worker. A
# directory with no selection, or a stub with no such file beside it (Test 4,
# Test 10, Test 12), runs `dev-channels`. The modes:
#
#   dev-channels         print the dev-channels warning dialog, byte-identical
#                        to tests/fixtures/dev-channels-pane-2.1.120.txt, which
#                        holds CSCB's DEV_CHANNELS_DIALOG_NEEDLE
#                        (src/session-manager.ts), and report in on the first
#                        line that reaches stdin (the approver's Enter, sent
#                        through `agent-director send-keys`).
#   at-once              report in at once.
#   silent               print nothing and never report in: no SessionStart,
#                        no re-fire, no MCP session. The sentinel ends it with
#                        no hook fired.
#   unrecognised-dialog  print a startup dialog (Claude Code's theme picker)
#                        that holds neither DEV_CHANNELS_DIALOG_NEEDLE nor
#                        TRUST_DIALOG_NEEDLE, so CSCB's approver never answers
#                        it, and report in on the first line that reaches stdin
#                        (the harness's `stub_press_enter`, a human answering).
#   folder-trust         when the working directory is trusted, report in at
#                        once; otherwise print the folder-trust prompt, which
#                        holds TRUST_DIALOG_NEEDLE, and report in on the first
#                        line that reaches stdin (the prompt answered by
#                        Enter). Trust is read from
#                        `<CLAUDE_CONFIG_DIR>/.claude.json`, or from
#                        `~/.claude.json` only when CLAUDE_CONFIG_DIR is unset
#                        or empty, as src/trust-bootstrap.ts writes it: the
#                        directory is trusted when
#                        `projects[<dir>].hasTrustDialogAccepted` is `true` for
#                        its real path or for $PWD.
#   transcript-on-first-message
#                        (a harness addition)
#                        as `dev-channels` (the same dialog, reporting in on
#                        the first line that reaches stdin), except that
#                        reporting in writes no transcript: until the first
#                        message, every SessionStart (the report-in's and the
#                        re-fire's) names a `transcript_path` with no file at
#                        it, so agent-director's SessionStart finds none. The
#                        transcript is written at the first message after
#                        reporting in: the first line that is not the
#                        sentinel, does not start with `/` (a slash command
#                        typed into the pane, such as CSCB's `/exit` at a
#                        `pause` or `/mcp reconnect`, is no message) and is
#                        not empty or blank (an extra Enter, which writes
#                        nothing in Claude Code either), as a human typing
#                        into the pane (lib/scenario.sh `stub_type_line`).
#                        Once written it stays, as in every other mode: the
#                        life's later SessionStarts (its re-fire's) name it,
#                        and a resumed launch of that session id (see
#                        RESUME) finds it at its SessionStart; a resumed
#                        launch of a session never messaged finds none until
#                        its own first message.
#   linger-on-exit       harness addition (scenario 24, and scenario 13's
#                        "still stopping"): report in at once, as `at-once`;
#                        then, on the `/exit` line agent-director's `pause`
#                        types, end the session but keep the process running,
#                        as a Claude Code still shutting down does, until the
#                        harness releases it (see LINGERING).
#
# Only the dev-channels dialog holds DEV_CHANNELS_DIALOG_NEEDLE, and only the
# folder-trust prompt holds TRUST_DIALOG_NEEDLE.
#
# THE DIALOG DELAY
# ----------------
# A harness addition (b.jg5 SRJ-1306): an
# optional delay before the dev-channels dialog, set per working directory,
# so a launch stays `pending` at the dialog long enough for a scenario to act
# on it before CSCB's approver can answer. The harness writes it
# (lib/scenario.sh `stub_dialog_delay`) to the file `stub-claude-dialog-delays`
# beside the stub, one line per setting: `<seconds> TAB <real path>`; the last
# line naming the directory wins. A directory with no setting, a setting of
# 0, or a stub with no such file beside it has no delay, and the stub behaves
# as the modes above state. The delay acts only in `dev-channels`:
#   - for the set number of seconds, from the stub's start, it shows a
#     starting screen that holds neither DEV_CHANNELS_DIALOG_NEEDLE nor
#     TRUST_DIALOG_NEEDLE, so the approver finds nothing to answer;
#   - it then clears the screen and prints the dev-channels dialog, the same
#     bytes as with no delay, and holds until Enter, reporting in as the
#     dialog mode does (the re-fire and the MCP session included);
#   - while the delay runs the sentinel ends the stub, as in a dialog mode,
#     and any other line is ignored: it answers no dialog;
#   - a setting that is not a whole number is reported on stderr and read as
#     no delay.
# Hook firing, the sentinel, the stop line and the re-fire are as stated
# below, with or without a delay.
#
# LINGERING
# ---------
# Harness addition (scenario 24, test-26, and scenario 13): a finished row
# whose own session still runs. In `linger-on-exit`, once reported in, the
# line `/exit` (agent-director's `pause` sends C-u, types `/exit` and Enter)
# makes the stub linger:
#   - it marks itself lingering: the file `stub-claude-lingering.<stub pid>`
#     beside the stub, holding its working directory's real path, written by
#     one rename;
#   - it fires every SessionEnd hook the `--settings` JSON registers, as the
#     sentinel does (see HOOK FIRING; reason `exit`, which agent-director takes
#     as a session that ended), so the row reads `ended`;
#   - it stops the SessionStart re-fire and ends its MCP session;
#   - it keeps running, its pane and session with it, ignoring every further
#     line, until it gets SIGUSR1 (the harness's release, lib/scenario.sh
#     `stub_release`) or its stdin closes; then it removes its marker and
#     exits 0.
# Before it lingers, `/exit` is an ordinary line (ignored), and SIGUSR1 is
# not handled.
#
# Every mode keeps these rules:
#   - Reporting in writes a minimal transcript JSONL at Claude Code's canonical
#     location, fires every SessionStart hook the `--settings` JSON registers
#     (see HOOK FIRING), prints a live-session banner, opens the MCP session
#     (see THE MCP SESSION) and starts the re-fire (see THE SESSIONSTART
#     RE-FIRE). agent-director derives the row's session_id from the payload's
#     `transcript_path` basename, so a later `claude --resume <session_id>`
#     finds that transcript.
#   - In `transcript-on-first-message` reporting in writes no transcript; the
#     first message does (see its entry above). Everything else here holds.
#   - After reporting in the stub keeps reading stdin, so the process and its
#     tmux pane stay alive. Further lines are ignored, apart from the sentinel
#     and `/mcp reconnect`, alone or with a server's name (see THE MCP
#     SESSION), and, in `linger-on-exit`, `/exit` (see LINGERING).
#   - Answering a dialog (`dev-channels`, `unrecognised-dialog`, and
#     `folder-trust` when it printed its prompt): the line that answers it
#     first clears the screen and the scrollback (`ESC[H ESC[2J ESC[3J`), as
#     Claude Code redraws its screen once a dialog is answered, and then the
#     stub reports in. So a pane read after the answer (CSCB's waiting-row
#     check reads `FULL_PANE_READ_LINES` lines, scrollback included) finds the
#     live-session banner and no dialog text, which it would read as a
#     prompt. Output before the answer, and a dialog left unanswered (stdin
#     closed, or the sentinel), is unchanged.
#   - The sentinel line `__CSCB_TEST_EXIT__` fires every SessionEnd hook the
#     `--settings` JSON registers and exits 0 (in `silent`, it fires none). In
#     a dialog mode it does so before the dialog is answered too.
#   - In `linger-on-exit`, the `/exit` line too (see LINGERING).
#   - When stdin closes (the pane was killed), the stub exits 0.
#
# RESUME
# ------
# agent-director resume re-execs `claude --resume <session_id> …`. The stub
# reuses that session_id and its transcript and follows its directory's mode
# again: a dialog mode prints its dialog again, so the resumed launch's dialog
# must be answered too.
#
# HOOK FIRING
# -----------
# agent-director applies a hook only when the hook's parent process is the
# pane's recorded main process, so every hook runs as a direct child of this
# script's process: the script runs the hook's argv as a simple command, with
# the payload on stdin by redirect from a file, never through `sh -c`, `eval`,
# a subshell, a pipeline, a background job, a coprocess or a command
# substitution.
#
#   - Every group of the event and every `"type": "command"` entry in it is
#     fired, in the order `--settings` lists them.
#   - An entry with an `args` array (exec form) runs `command` verbatim with
#     those `args`.
#   - An entry with no `args` (shell form) runs the words of its `command`.
#   - An entry's `timeout` is not acted on and no timeout wraps a hook: each
#     hook runs until it exits.
#   - The payload carries `hook_event_name`, `session_id`, `cwd`,
#     `transcript_path` and `source` (SessionStart) or `reason` (SessionEnd),
#     and no `agent_id`.
#
# The entries are read once, at start-up, into one flat array per event: for
# each entry its argv length, then its argv elements.
#
# THE SESSIONSTART RE-FIRE
# ------------------------
# After every report-in, whatever caused it (at once, Enter at a dialog, the
# folder-trust prompt answered, a trusted folder, a resume lap), the stub reads
# its own row every 2 s and fires SessionStart again while the row reads
# `pending`. agent-director applies a SessionStart that arrives before it has
# recorded the launch's pane once that record exists, waiting up to the
# pending grace period G from the launch start; the re-fire keeps /ci
# deterministic and is harmless under that wait.
#   - The read: `<bin> status --claude-instance-id <id>`, where <bin> is the
#     program the first registered SessionStart entry names (exec form's
#     `command`, or a shell form's first word), run as a direct child, and <id>
#     is AGENT_DIRECTOR_INSTANCE_ID, which agent-director puts in the worker's
#     environment (the hooks' `args` carry no id). Under the RC's hooks <bin>
#     is the real binary, so these reads bypass the agent-director shim.
#   - `pending` with a launch start (`launch_started_at`), and G not yet passed
#     since that launch start: fire every registered SessionStart hook again,
#     by the rules above, then read again 2 s after the hooks finished.
#   - `pending` with G passed since the launch start, or any state other than
#     `pending`: stop re-firing, writing nothing.
#   - A failed read (no instance id, a non-zero exit, or output that is not a
#     status object or carries a launch start that is not a time), or `pending`
#     with no launch start: stop re-firing, fire nothing more, and write one
#     stop line (below).
#   - G is `[tmux] pending_grace_seconds` from
#     `$HOME/.agent-director/config.toml`, read at every tick; a missing file,
#     a missing key, 0 or a value that is not a whole number gives 60 s,
#     agent-director's default (DefaultPendingGraceSeconds in its
#     internal/config/tmux.go).
#   - With no registered SessionStart hook there is nothing to re-fire: no read
#     and no stop line.
#   - The timer runs in the stub's main process, as the timeout of its stdin
#     read: Enter, the sentinel and `/mcp reconnect` are still handled between
#     ticks, and each tick's hooks finish before the next tick.
#
# THE STOP LINE
# -------------
# One line in the agent-director shim's line format (its header,
# fixtures/agent-director-shim.sh, states it), kind `stop`:
#   stop TAB <time> TAB <stub pid> TAB <stub ppid> TAB <parent> TAB <words>
# whose words are `stub-claude`, then the reason as words:
#   stopped re-firing SessionStart for instance <id>: <why>
# where <why> is one of
#   AGENT_DIRECTOR_INSTANCE_ID is unset or empty   (<id> is then `-`)
#   the status read exited <n>
#   the status read printed no status object
#   the status read gave a launch start that is not a time: <text>
#   the row reads pending with no launch start
# It is appended in one write, under `/usr/bin/flock -x` on the log, to
# `agent-director-shim.log` in the directory of the read's <bin> (the shim's
# log, beside the real binary, in an fmk HOME); where no such file exists
# (test-1 to test-12), to the stub's stderr. A reader that counts invocations
# takes only `call` lines, so the stop line is never read as one.
#
# THE MCP SESSION
# ---------------
# Once it has fired SessionStart on reporting in, the stub opens an MCP
# session to the bot server, as the real `claude` does for its launch, and
# holds it until the stub ends, so the server registers it as the persona's
# session and a health tick reads the persona connected. The session is the
# client `stub-mcp-session.ts` beside the stub, run with bun as a child of the
# stub's process (never a CSCB process), its output appended to
# `stub-mcp-session.log` beside the stub. It reads the `--mcp-config` the stub
# was given (a file path, `~/` expanded, or inline JSON), connects to the
# server's URL, and answers the server's roots request with the stub's
# working directory, by which the server matches the persona. It ends when the
# stub ends: on the stub's exit (the sentinel or stdin closing) the stub sends
# it SIGTERM, and on any other end of the stub (a kill) it sees its parent
# change and exits, or dies with the pane's hang-up. When the server ends the
# session (a refusal, a stop), the client exits; a later `/mcp reconnect` line,
# alone or followed by a space and a server name as CSCB types it
# (`/mcp reconnect slack-channel-router`) into a persona's pane to reconnect
# it, opens a new session, as the real `claude` reconnects: a client still
# running then (one whose server restarted before its next ping noticed) is
# ended first, with SIGTERM, then SIGKILL if it still runs 3 s later, and
# reaped, so a reconnect never holds the stub's read loop longer than that.
# In `linger-on-exit` the `/exit` line ends the session and the lingering
# stub opens none (see LINGERING).
# No session is opened when the client is not beside the stub (Test 4, Test 10
# and Test 12, which copy only the stub), when the stub was given no
# `--mcp-config`, or in a mode that has not reported in (`silent`, a dialog not
# yet answered).
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
MODE_DEV_CHANNELS=dev-channels
MODE_AT_ONCE=at-once
MODE_SILENT=silent
MODE_UNRECOGNISED=unrecognised-dialog
MODE_FOLDER_TRUST=folder-trust
# A harness addition.
MODE_TRANSCRIPT_ON_FIRST_MESSAGE=transcript-on-first-message
MODE_LINGER_ON_EXIT=linger-on-exit

STUB_DIR="${BASH_SOURCE[0]%/*}"
[[ "${STUB_DIR}" == "${BASH_SOURCE[0]}" ]] && STUB_DIR=.
STUB_MODES_FILE="${STUB_DIR}/stub-claude-modes"

MODE="${MODE_DEV_CHANNELS}"
if [[ -f "${STUB_MODES_FILE}" ]]; then
    while IFS=$'\t' read -r sel_mode sel_dir; do
        [[ "${sel_dir}" == "${REALCWD}" ]] && MODE="${sel_mode}"
    done < "${STUB_MODES_FILE}"
fi
case "${MODE}" in
    "${MODE_DEV_CHANNELS}" | "${MODE_AT_ONCE}" | "${MODE_SILENT}" | "${MODE_UNRECOGNISED}" | "${MODE_FOLDER_TRUST}") ;;
    "${MODE_TRANSCRIPT_ON_FIRST_MESSAGE}") ;;
    "${MODE_LINGER_ON_EXIT}") ;;
    *)
        printf 'stub-claude: unknown mode %q selected for %s; running %s\n' \
            "${MODE}" "${REALCWD}" "${MODE_DEV_CHANNELS}" >&2
        MODE="${MODE_DEV_CHANNELS}"
        ;;
esac

# The dialog delay, in whole seconds (see THE DIALOG DELAY): the last setting
# naming the directory, 0 when none does.
STUB_DELAYS_FILE="${STUB_DIR}/stub-claude-dialog-delays"
DIALOG_DELAY_S=0
if [[ -f "${STUB_DELAYS_FILE}" ]]; then
    while IFS=$'\t' read -r sel_delay sel_dir; do
        [[ "${sel_dir}" == "${REALCWD}" ]] && DIALOG_DELAY_S="${sel_delay}"
    done < "${STUB_DELAYS_FILE}"
fi
if [[ ! "${DIALOG_DELAY_S}" =~ ^[0-9]+$ ]]; then
    printf 'stub-claude: dialog delay %q set for %s is not a whole number of seconds; no delay\n' \
        "${DIALOG_DELAY_S}" "${REALCWD}" >&2
    DIALOG_DELAY_S=0
fi
DIALOG_DELAY_S=$(( 10#${DIALOG_DELAY_S} ))

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

# Sentinel line the driver sends via `agent-director send-keys` to request a
# clean session end. Distinct from the bare Enter the dialog approver sends, so
# the resume lap's approval Enter never triggers an exit.
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

print_dev_channels_dialog() {
    # MUST stay byte-identical to tests/fixtures/dev-channels-pane-2.1.120.txt.
    cat <<'DIALOG'
WARNING: Loading development channels

--dangerously-load-development-channels is for local channel development only. Do not
use this option to run channels you have downloaded off the internet.

Please use --channels to run a list of approved channels.

Channels: server:slack-channel-router

❯ 1. I am using this for local development
  2. Exit

Enter to confirm · Esc to cancel
DIALOG
}

# The starting screen the dialog delay shows: no needle of CSCB's approver.
print_delay_screen() {
    printf 'Starting Claude Code...\n'
}

# Clear the screen, so the dialog after the delay is all the pane shows.
clear_screen() {
    printf '\033[H\033[2J'
}

# A startup dialog no needle of CSCB's approver matches.
print_unrecognised_dialog() {
    cat <<'DIALOG'
Let's get started.

Choose the text style that looks best with your terminal
To change this later, run /theme

❯ 1. Dark mode
  2. Light mode
  3. Dark mode (colorblind-friendly)
  4. Light mode (colorblind-friendly)

Enter to confirm · Esc to cancel
DIALOG
}

print_trust_dialog() {
    cat <<DIALOG
Accessing workspace:

${REALCWD}

Quick safety check: Is this a project you created or one you trust? (Like your
own code, a well-known open source project, or work from your team). If not,
take a moment to review what's in this folder first.

Claude Code'll be able to read, edit, and execute files here.

❯ 1. Yes, I trust this folder
  2. No, exit

Enter to confirm · Esc to cancel
DIALOG
}

# True when the working directory is trusted in the Claude config's
# .claude.json, as src/trust-bootstrap.ts writes it.
folder_trusted() {
    local file
    if [[ -n "${CLAUDE_CONFIG_DIR:-}" ]]; then
        file="${CLAUDE_CONFIG_DIR}/.claude.json"
    else
        file="${HOME}/.claude.json"
    fi
    [[ -f "${file}" ]] || return 1
    jq -e --arg real "${REALCWD}" --arg pwd "${PWD:-}" '
        .projects | objects
        | ((.[$real] | objects | .hasTrustDialogAccepted) == true)
          or ($pwd != "" and ((.[$pwd] | objects | .hasTrustDialogAccepted) == true))
    ' "${file}" > /dev/null 2>&1
}

# A dialog answered: clear the screen (cursor home, erase the screen) and the
# scrollback (erase saved lines, which tmux fills with the erased screen),
# as Claude Code redraws its screen once a dialog is answered, so no pane
# read after the answer finds the dialog's text.
clear_answered_dialog() {
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
    local file="${HOME}/.agent-director/config.toml" v=""
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
    local id="${AGENT_DIRECTOR_INSTANCE_ID:-}" rc=0 parsed state launch launch_ms
    if [[ -z "${id}" ]]; then
        stop_refire
        write_stop_line - AGENT_DIRECTOR_INSTANCE_ID is unset or empty
        return 0
    fi
    "${STATUS_BIN}" status --claude-instance-id "${id}" > "${STATUS_OUT}" 2> "${STATUS_OUT}.err" || rc=$?
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

trap 'close_mcp_session; rm -f "${HOOK_FILE}" "${STATUS_OUT}" "${STATUS_OUT}.err"' EXIT

# ---------------------------------------------------------------------------
# Reporting in, and the read loop
# ---------------------------------------------------------------------------

REPORTED=0
AWAITING_ENTER=0
# While the dialog delay runs: the time the dialog is due, in milliseconds
# since the epoch; 0 otherwise.
DIALOG_DUE_MS=0

report_in() {
    REPORTED=1
    AWAITING_ENTER=0
    fire_session_start
    echo "Listening for channel messages from: server:slack-channel-router"
    open_mcp_session
    start_refire
}

case "${MODE}" in
    "${MODE_DEV_CHANNELS}")
        if (( DIALOG_DELAY_S > 0 )); then
            print_delay_screen
            now_ms
            DIALOG_DUE_MS=$(( NOW_MS + DIALOG_DELAY_S * 1000 ))
        else
            print_dev_channels_dialog
            AWAITING_ENTER=1
        fi
        ;;
    "${MODE_TRANSCRIPT_ON_FIRST_MESSAGE}")
        print_dev_channels_dialog
        AWAITING_ENTER=1
        ;;
    "${MODE_UNRECOGNISED}")
        print_unrecognised_dialog
        AWAITING_ENTER=1
        ;;
    "${MODE_FOLDER_TRUST}")
        if folder_trusted; then
            report_in
        else
            print_trust_dialog
            AWAITING_ENTER=1
        fi
        ;;
    "${MODE_AT_ONCE}")
        report_in
        ;;
    "${MODE_SILENT}")
        ;;
    "${MODE_LINGER_ON_EXIT}")
        report_in
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
    trap 'close_mcp_session; rm -f "${HOOK_FILE}" "${STATUS_OUT}" "${STATUS_OUT}.err" "${LINGER_MARKER}"' EXIT
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

# handle_line <line>: one line from stdin.
handle_line() {
    local line="$1"
    if [[ "${line}" == "${SENTINEL}" ]]; then
        [[ "${MODE}" == "${MODE_SILENT}" ]] || fire_session_end
        exit 0
    fi
    if [[ "${MODE}" == "${MODE_LINGER_ON_EXIT}" && "${line}" == "${PAUSE_EXIT_LINE}" ]] && (( REPORTED )); then
        linger_after_exit
    fi
    # transcript-on-first-message: the first message after reporting in
    # writes the transcript; a slash command (a line starting with `/`, such
    # as `/exit` or `/mcp reconnect`) is no message.
    if (( REPORTED )) && [[ "${MODE}" == "${MODE_TRANSCRIPT_ON_FIRST_MESSAGE}" \
        && "${line}" =~ [^[:space:]] && ! "${line}" =~ ^[[:space:]]*/ ]]; then
        TRANSCRIPT_DUE=1
        ensure_transcript
    fi
    if (( AWAITING_ENTER )); then
        clear_answered_dialog
        report_in
    elif (( REPORTED )) && [[ "${line}" == '/mcp reconnect' || "${line}" == '/mcp reconnect '?* ]]; then
        reconnect_mcp_session
    fi
}

# Read loop. While the dialog delay runs, each read waits at most until the
# dialog is due, and once it is due the dialog is shown. While the re-fire
# runs, each read waits at most until the next tick, and a read that times
# out runs the tick. In either wait, the part of a line read by the timeout
# (none from a terminal, which hands over whole lines) is kept for the next
# read.
partial=""
while :; do
    line=""
    if (( DIALOG_DUE_MS > 0 )); then
        now_ms
        wait_ms=$(( DIALOG_DUE_MS - NOW_MS ))
        if (( wait_ms <= 0 )); then
            DIALOG_DUE_MS=0
            clear_screen
            print_dev_channels_dialog
            AWAITING_ENTER=1
            continue
        fi
        printf -v wait_s '%d.%03d' $(( wait_ms / 1000 )) $(( wait_ms % 1000 ))
        IFS= read -r -t "${wait_s}" line
        rc=$?
        if (( rc > 128 )); then
            partial+="${line}"
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
        IFS= read -r -t "${wait_s}" line
        rc=$?
        if (( rc > 128 )); then
            partial+="${line}"
            continue
        fi
    else
        IFS= read -r line
        rc=$?
    fi
    # stdin closed (tmux pane killed): exit.
    (( rc == 0 )) || break
    line="${partial}${line}"
    partial=""
    handle_line "${line}"
done

exit 0
