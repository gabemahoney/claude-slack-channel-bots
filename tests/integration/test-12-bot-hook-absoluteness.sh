#!/usr/bin/env bash
# Test 12 (b.cnu SR-8.2; the b.2qu absolute-path rule for the reply guard):
# every hook a persona's Claude is launched with has a `command` path that is
# an absolute path to an existing, executable file. agent-director's own hooks
# point at the user's agent-director install, outside the customer's
# node_modules; CSCB's Slack Reply Guard Stop hook points at the installed
# package's stop-hooks/slack-reply-guard.sh.
#
# This needs a real agent-director spawn, which a unit test never makes, so
# it lives here and not in `bun test` (it replaces
# tests/bot-hook-absoluteness.test.ts, whose one case could only be skipped).
# The launch is a customer's: Test 1's installed package, a live start
# (`start_server --live`) against the loopback Slack stub
# (fixtures/slack-stub-server.ts, through CSCB_SLACK_API_URL, as Test 10) and
# the real agent-director spawning the persona in tmux, with
# fixtures/stub-claude.sh first on PATH as `claude`. As in Test 10, the health
# check is off and `exit_timeout` is 5 s (stub-claude ignores the `/exit` that
# `stop --stop-bots` sends).
#
# Where the hooks are:
# - agent-director's: the `--settings` JSON on the launched claude's command
#   line (agent-director builds it for each spawn and writes no file). The
#   process is found through /proc by its environment:
#   AGENT_DIRECTOR_INSTANCE_ID=cscb_<key> and CSCB_PERSONA=<key>
#   (src/persona-identity.ts personaInstanceId, personaSpawnEnv).
# - CSCB's: <claude_config_dir>/settings.json (src/stop-hook-bootstrap.ts),
#   the user settings the launched claude reads through CLAUDE_CONFIG_DIR.
# agent-director registers its hooks in exec form (`command` with `args`, run
# with no shell between Claude Code and the hook), so the path this test
# checks is the hook's `command`, read verbatim, never split into words.
# CSCB's own Stop hook stays a shell-form command (no `args`), so its words
# are read as a shell reads them (Python's shlex, POSIX mode; nothing is run)
# and its `command` path is the first of them. An `args` that is not a list
# of strings is not the settings shape and fails the test.
#
# Steps:
# 1. Start one persona with its own claude_config_dir (a fresh scratch dir;
#    stop_hook_bootstrap is on by default). It is brought up: one
#    persona-start line, the start pass ends with `0 not brought up`, no
#    `[slack] stop-hook-bootstrap:` line (each is a skip or a failure) and
#    no stop-hook-bootstrap record in startup-errors.log. The dialog approver
#    runs after the launch returns, so the start pass does not wait for the
#    launched claude's SessionStart: within TRANSCRIPT_WAIT_S of the start
#    pass's end the working dir gets a transcript, and every transcript in it
#    carries stub-claude's marker (the launched claude was the stub).
# 2. Exactly one live process carries the persona's instance ID and key and
#    a `--settings` argument; its CLAUDE_CONFIG_DIR is the persona's
#    claude_config_dir.
# 3. agent-director's hooks, from that `--settings` JSON: SessionStart and
#    PermissionRequest (the permission relay) have one each at least, and
#    every hook's `command` path is an absolute path to an existing
#    executable file whose real path is the user's agent-director install
#    (the binary the agent-director client runs:
#    ~/.agent-director/bin/agent-director when present, else agent-director
#    on PATH), outside the customer's node_modules.
# 4. CSCB's hooks, from <claude_config_dir>/settings.json: every hook's
#    `command` path is an absolute path to an existing executable file.
#    Exactly one command is managed (names slack-reply-guard.sh, the SR-3.7
#    recognition rule): a shell-form Stop hook of two words, the installed
#    package's stop-hooks/slack-reply-guard.sh (by real path) and
#    <state dir>/reply-guard, where the persona's record reads `true`. Run
#    through sh exactly as written, with no input, it exits 0 (the guard
#    fails open on empty input; a command the shell cannot run exits 126 or
#    127).
# 5. stop --stop-bots.
#
# An exit hook (on pass and on failure) kills the persona's tmux session and
# removes stub-claude's transcripts; the agent-director row is left to the
# ephemeral container (as Test 10). Like Test 10's, this live start's sweep
# kills the live rows of personas not in this config and records their keys
# as retired; it deletes no row. Expected runtime: under a minute.
set -euo pipefail

TEST_NAME="test-12-bot-hook-absoluteness"
# shellcheck source=lib/scenario.sh
source "$(dirname "$0")/lib/scenario.sh"

FIXTURES="$(realpath "$(dirname "$0")")/fixtures"

# --- Bounds (seconds) ------------------------------------------------------
STUB_WAIT_S=20     # the stub writing its ready file
START_WAIT_S=120   # the start pass: one bring-up and one launch
TRANSCRIPT_WAIT_S=60  # after the start pass: the dialog approver's Enter and SessionStart
PROC_WAIT_S=15    # the persona's claude being the one process with its IDs

# --- Prerequisites ---------------------------------------------------------
for tool in bun tmux agent-director jq realpath; do
    command -v "${tool}" > /dev/null 2>&1 || fail "${tool} not on PATH (base image prerequisite)"
done
for fixture in slack-stub-server.ts stub-claude.sh; do
    [[ -f "${FIXTURES}/${fixture}" ]] || fail "fixture ${FIXTURES}/${fixture} missing"
done

# --- The customer's install ------------------------------------------------
NODE_MODULES="${SCENARIO_REPO}/node_modules"
PKG_DIR="${NODE_MODULES}/claude-slack-channel-bots"
GUARD="${PKG_DIR}/stop-hooks/slack-reply-guard.sh"
[[ -d "${PKG_DIR}" ]] || fail "installed package not found at ${PKG_DIR} (Test 1 prerequisite)"
[[ -f "${GUARD}" ]] || fail "the installed package has no ${GUARD}"
NODE_MODULES_REAL="$(realpath -e -- "${NODE_MODULES}")"
GUARD_REAL="$(realpath -e -- "${GUARD}")"

# The agent-director binary the client runs (agent-director's
# discoverSystemBinary): the standard install path when it exists, else the
# first agent-director on PATH. The stub bin dir prepended below holds only
# `claude`, so it does not change this.
if [[ -e "${HOME:?}/.agent-director/bin/agent-director" ]]; then
    AD_BIN="${HOME}/.agent-director/bin/agent-director"
else
    AD_BIN="$(command -v agent-director)"
fi
AD_REAL="$(realpath -e -- "${AD_BIN}")" || fail "the agent-director install ${AD_BIN} does not resolve"

# --- Stub `claude` first on PATH (the daemon's launches inherit it) --------
STUB_BIN="${SCENARIO_ROOT}/bin"
mkdir -p "${STUB_BIN}"
cp "${FIXTURES}/stub-claude.sh" "${STUB_BIN}/claude"
chmod +x "${STUB_BIN}/claude"
export PATH="${STUB_BIN}:${PATH}"
[[ "$(command -v claude)" == "${STUB_BIN}/claude" ]] \
    || fail "PATH does not resolve claude to the stub ${STUB_BIN}/claude"

# --- Names and paths -------------------------------------------------------
NAME="${SCENARIO_TAG}_hooks"
KEY="$(persona_key "${NAME}")"
# src/persona-identity.ts personaInstanceId, personaTmuxSessionName.
INSTANCE_ID="cscb_${KEY}"
TMUX_SESSION="slack_bot_${KEY}"
CHANNEL="C0${SCENARIO_TAG^^}H1"

WORK_DIR="$(make_workdir hooks)"
CLAUDE_CONFIG="${SCENARIO_ROOT}/claude-config"
mkdir -p "${CLAUDE_CONFIG}"
CLAUDE_SETTINGS="${CLAUDE_CONFIG}/settings.json"
# src/reply-guard-record.ts replyGuardRecordDir: <state dir>/reply-guard.
RECORD_DIR="${SLACK_STATE_DIR}/reply-guard"

CREDS_DIR="${SCENARIO_ROOT}/credentials"
mkdir -m 700 "${CREDS_DIR}"
CREDS="${CREDS_DIR}/hooks.json"

STUB_DIR="${SCENARIO_ROOT}/stub"
mkdir -p "${STUB_DIR}"
STUB_RECORD="${STUB_DIR}/record.jsonl"
STUB_CONTROL="${STUB_DIR}/control.json"
STUB_READY="${STUB_DIR}/ready.json"
STUB_OUT="${STUB_DIR}/stub.out"

# What the checks read: the launched claude's `--settings` JSON and
# CLAUDE_CONFIG_DIR (written by find-claude), and each file's hook list.
PROC_DIR="${SCENARIO_ROOT}/claude-process"
AD_SETTINGS="${PROC_DIR}/settings.json"
PROC_CONFIG_DIR="${PROC_DIR}/claude-config-dir"
AD_HOOKS="${SCENARIO_ROOT}/ad-hooks.txt"
CSCB_HOOKS="${SCENARIO_ROOT}/cscb-hooks.txt"

# stub-claude's transcripts: ~/.claude/projects/<real working dir with / . _
# as -> (fixtures/stub-claude.sh). The working dir is under the scratch root,
# so the name is this run's own.
ROOT_KEY="$(realpath "${SCENARIO_ROOT}" | sed 's#[/._]#-#g')"
TRANSCRIPTS="${HOME}/.claude/projects/$(realpath "${WORK_DIR}" | sed 's#[/._]#-#g')"
[[ -n "${ROOT_KEY}" && "$(basename "${TRANSCRIPTS}")" == "${ROOT_KEY}"-work-* ]] \
    || fail "transcript directory name ${TRANSCRIPTS} is not under the scratch root's"
# The summary line stub-claude writes into every transcript it creates
# (fixtures/stub-claude.sh ensure_transcript).
STUB_SESSION_MARKER='"summary":"stub-claude session"'

# --- Expected text (fragments quoted from src/) ----------------------------
# src/session-manager.ts startupSessionManager
STARTUP_COMPLETE="$(completion_match 1)"
# src/persona-bringup-controller.ts bringUp through
# src/persona-diagnostics.ts formatPersonaDiagnostic
PERSONA_START="$(persona_start_match 0 "${NAME}")"
# src/stop-hook-bootstrap.ts: every line it logs is a skip or a failure, and
# every startup-errors.log class it records starts `stop-hook-bootstrap`
# (src/startup-errors.ts recordStartupError writes `[<class>]`).
BOOTSTRAP_LINE='[slack] stop-hook-bootstrap:'
BOOTSTRAP_ERROR_CLASS='] [stop-hook-bootstrap'
# src/stop-hook-bootstrap.ts MANAGED_MARKER (the SR-3.7 recognition rule).
MANAGED_MARKER='slack-reply-guard.sh'

# --- Helpers ---------------------------------------------------------------

# hooks.py find-claude <instance-id> <key> <out-dir>: print how many live
# processes carry both AGENT_DIRECTOR_INSTANCE_ID=<instance-id> and
# CSCB_PERSONA=<key> in their environment and a `--settings <json>` pair in
# their argv; when exactly one does, write its <json> to <out-dir>/settings.json
# and its CLAUDE_CONFIG_DIR (empty when unset) to <out-dir>/claude-config-dir.
#
# hooks.py list <settings-file>: one line per command hook (type "command";
# other hook types carry no path) of the file's `hooks` block, fields joined
# by the ASCII unit separator: index, event, form, managed (1 when the
# `command` holds slack-reply-guard.sh), word count, `command` path, second
# word. An entry with an `args` list is form `exec`: its words are `command`,
# verbatim and never split, then each of `args`. An entry without `args` is
# form `shell`: its words are `command` as a shell splits it. Exits 1 with a
# reason on stderr for a file that is not the settings shape (an `args` that
# is not a list of strings among them) or a shell-form command a shell cannot
# split.
#
# hooks.py raw <settings-file> <index>: print command hook <index>'s
# `command` verbatim.
HOOKS_PY="${SCENARIO_ROOT}/hooks.py"
cat > "${HOOKS_PY}" << 'EOF'
import json, os, shlex, sys

SEP = "\x1f"
MARKER = "slack-reply-guard.sh"


def die(msg):
    print(msg, file=sys.stderr)
    sys.exit(1)


def read_nul(path):
    with open(path, "rb") as f:
        parts = f.read().split(b"\0")
    if parts and parts[-1] == b"":
        parts.pop()
    return [p.decode("utf-8", "replace") for p in parts]


def find_claude(instance_id, key, out_dir):
    want = {"AGENT_DIRECTOR_INSTANCE_ID=" + instance_id, "CSCB_PERSONA=" + key}
    found = []
    for name in os.listdir("/proc"):
        if not name.isdigit():
            continue
        try:
            env = read_nul("/proc/%s/environ" % name)
            argv = read_nul("/proc/%s/cmdline" % name)
        except OSError:
            continue
        if not want.issubset(env) or "--settings" not in argv:
            continue
        i = argv.index("--settings")
        if i + 1 >= len(argv):
            continue
        config_dir = ""
        for entry in env:
            if entry.startswith("CLAUDE_CONFIG_DIR="):
                config_dir = entry.split("=", 1)[1]
        found.append((argv[i + 1], config_dir))
    os.makedirs(out_dir, exist_ok=True)
    for leaf in ("settings.json", "claude-config-dir"):
        try:
            os.remove(os.path.join(out_dir, leaf))
        except FileNotFoundError:
            pass
    if len(found) == 1:
        with open(os.path.join(out_dir, "settings.json"), "w") as f:
            f.write(found[0][0])
        with open(os.path.join(out_dir, "claude-config-dir"), "w") as f:
            f.write(found[0][1])
    print(len(found))


def commands(path):
    try:
        with open(path) as f:
            data = json.load(f)
    except (OSError, ValueError) as e:
        die("%s: not readable JSON (%s)" % (path, e))
    if not isinstance(data, dict):
        die("%s: the top level is not an object" % path)
    hooks = data.get("hooks", {})
    if not isinstance(hooks, dict):
        die("%s: `hooks` is not an object" % path)
    out = []
    for event, groups in hooks.items():
        if not isinstance(groups, list):
            die("%s: hooks.%s is not a list" % (path, event))
        for group in groups:
            if not isinstance(group, dict) or not isinstance(group.get("hooks"), list):
                die("%s: a hooks.%s group has no `hooks` list" % (path, event))
            for hook in group["hooks"]:
                if not isinstance(hook, dict):
                    die("%s: a hooks.%s entry is not an object" % (path, event))
                if hook.get("type") != "command":
                    continue
                command = hook.get("command")
                if not isinstance(command, str):
                    die("%s: a hooks.%s command hook has no command string" % (path, event))
                args = None
                if "args" in hook:
                    args = hook["args"]
                    if not isinstance(args, list) or not all(isinstance(a, str) for a in args):
                        die("%s: a hooks.%s command hook's `args` is not a list of strings" % (path, event))
                out.append((event, command, args))
    return out


def list_hooks(path):
    for index, (event, command, args) in enumerate(commands(path)):
        if args is not None:
            # Exec form: Claude Code runs `command` itself with `args`, no
            # shell between, so the path is `command` verbatim.
            form = "exec"
            words = [command] + args
        else:
            form = "shell"
            try:
                words = shlex.split(command, posix=True)
            except ValueError as e:
                die("%s: hooks.%s command #%d is not shell words (%s)" % (path, event, index, e))
        for text in [event] + words[:2]:
            if SEP in text or "\n" in text:
                die("%s: hooks.%s command #%d holds a separator or newline" % (path, event, index))
        first = words[0] if words else ""
        second = words[1] if len(words) > 1 else ""
        managed = "1" if MARKER in command else "0"
        print(SEP.join([str(index), event, form, managed, str(len(words)), first, second]))


def raw(path, index):
    sys.stdout.write(commands(path)[int(index)][1])


mode, *args = sys.argv[1:]
if mode == "find-claude":
    find_claude(*args)
elif mode == "list":
    list_hooks(*args)
elif mode == "raw":
    raw(*args)
else:
    die("hooks.py: unknown mode %s" % mode)
EOF

one_claude_process() {
    local n
    n="$(python3 "${HOOKS_PY}" find-claude "${INSTANCE_ID}" "${KEY}" "${PROC_DIR}")" || return 1
    [[ "${n}" == 1 ]]
}

# list_hooks <settings-file> <out-file> <step>: write the file's hook list.
list_hooks() {
    python3 "${HOOKS_PY}" list "$1" > "$2" || fail "$3: could not list the hook commands of $1"
}

# check_command_path <step> <path>: a hook's `command` path is an absolute
# path to an existing, executable regular file.
check_command_path() {
    local step="$1" path="$2"
    [[ "${path}" == /* ]] || fail "${step}: command path '${path}' is not an absolute path"
    [[ -f "${path}" ]] || fail "${step}: ${path} is not an existing file"
    [[ -x "${path}" ]] || fail "${step}: ${path} is not executable"
}

# True when <dir> holds a non-empty transcript (stub-claude writes its one
# line in a single write, so a non-empty file is a whole one).
has_transcript() {
    local f
    for f in "$1"/*.jsonl; do
        [[ -s "${f}" ]] && return 0
    done
    return 1
}

# True when <dir> holds at least one transcript and every transcript in it
# carries stub-claude's session marker.
stub_transcripts_only() {
    local dir="$1" f n=0
    for f in "${dir}"/*.jsonl; do
        [[ -f "${f}" ]] || continue
        n=$(( n + 1 ))
        grep -qF -- "${STUB_SESSION_MARKER}" "${f}" || return 1
    done
    (( n > 0 ))
}

# Exit hook (on pass and on failure, after the trap's stop --stop-bots): kill
# the persona's tmux session by name (agent-director's kill does not always
# reap it, b.vub) and remove the stub-claude transcript dir. A dir holding
# anything but stub-claude's transcripts is left in place and fails the hook.
cleanup_launch() {
    local rc=0
    tmux kill-session -t "=${TMUX_SESSION}" > /dev/null 2>&1 || true
    if tmux has-session -t "=${TMUX_SESSION}" > /dev/null 2>&1; then
        echo "  | cleanup: tmux session ${TMUX_SESSION} is still running" >&2
        rc=1
    fi
    if [[ -e "${TRANSCRIPTS}" ]]; then
        if stub_transcripts_only "${TRANSCRIPTS}"; then
            rm -rf -- "${TRANSCRIPTS}"
        else
            echo "  | cleanup: ${TRANSCRIPTS} holds no stub-claude transcript or another one; left in place" >&2
            rc=1
        fi
    fi
    return "${rc}"
}
on_exit cleanup_launch

# --- Stub ------------------------------------------------------------------
# One token pair, answered `ok`; any other token is refused.
python3 - << 'EOF' | write_file "${STUB_CONTROL}"
import json
print(json.dumps({
    "tokens": [{"suffix": "hooksv1", "label": "hooks", "auth": "ok", "connections": "ok"}],
    "default": {"auth": "invalid_auth", "connections": "invalid_auth"},
}))
EOF

(cd "${STUB_DIR}" && exec bun "${FIXTURES}/slack-stub-server.ts" \
    --record "${STUB_RECORD}" --control "${STUB_CONTROL}" --ready-file "${STUB_READY}") \
    > "${STUB_OUT}" 2>&1 &
STUB_PID=$!
track_pid "${STUB_PID}"

wait_for_file "${STUB_READY}" "${STUB_WAIT_S}" "the Slack stub never wrote its ready file"
STUB_API_URL="$(python3 -c 'import json, sys; print(json.load(open(sys.argv[1]))["api_url"])' "${STUB_READY}")"
[[ "${STUB_API_URL}" =~ ^http://127\.0\.0\.1:[0-9]+/api/$ ]] \
    || fail "the stub's api_url is not http://127.0.0.1:<port>/api/"
export CSCB_SLACK_API_URL="${STUB_API_URL}"

# --- 1. Start: the persona is brought up and launched ----------------------
BOT_TOKEN="$(fake_token bot hooksv1)"
APP_TOKEN="$(fake_token app hooksv1)"
printf '{"bot_token": "%s", "app_token": "%s"}\n' "${BOT_TOKEN}" "${APP_TOKEN}" | write_file "${CREDS}" 600

write_config << EOF
{
  "personas": [
    {
      "name": "${NAME}",
      "credentials_file": "${CREDS}",
      "working_directory": "${WORK_DIR}",
      "claude_config_dir": "${CLAUDE_CONFIG}",
      "channels": [{ "id": "${CHANNEL}", "delivery": "all" }],
      "permission_prompts": "${CHANNEL}"
    }
  ],
  "bind": "127.0.0.1",
  "port": ${SCENARIO_PORT},
  "health_check_interval": 0,
  "exit_timeout": 5
}
EOF

start_server --live
wait_for_log "${STARTUP_COMPLETE}" "${START_WAIT_S}" "start: the start pass never completed"
expect_completion 1 "start" "0 not brought up"
expect_count "${PERSONA_START}" 1 "start: persona-start lines for ${NAME}"
expect_count "${BOOTSTRAP_LINE}" 0 "start: stop-hook-bootstrap skip or failure lines"
n="$(count_in "${SLACK_STATE_DIR}/startup-errors.log" "${BOOTSTRAP_ERROR_CLASS}")"
[[ "${n}" == 0 ]] || fail "start: ${n} stop-hook-bootstrap record(s) in startup-errors.log"

# The dialog approver runs after the launch returns, so the start pass ends
# before the launched claude's SessionStart writes its transcript: wait for
# it.
wait_until "${TRANSCRIPT_WAIT_S}" \
    "start: no transcript in ${TRANSCRIPTS}: the launched claude did not write one" \
    has_transcript "${TRANSCRIPTS}"
stub_transcripts_only "${TRANSCRIPTS}" \
    || fail "start: ${TRANSCRIPTS} holds no transcript with stub-claude's session marker: the launched claude was not the stub"

# --- 2. The persona's launched claude --------------------------------------
wait_until "${PROC_WAIT_S}" \
    "claude process: no single live process carries ${INSTANCE_ID}, CSCB_PERSONA=${KEY} and a --settings argument" \
    one_claude_process
[[ "$(cat "${PROC_CONFIG_DIR}")" == "${CLAUDE_CONFIG}" ]] \
    || fail "claude process: its CLAUDE_CONFIG_DIR is '$(cat "${PROC_CONFIG_DIR}")', not the persona's ${CLAUDE_CONFIG}"

# --- 3. agent-director's hooks (the --settings JSON) -----------------------
list_hooks "${AD_SETTINGS}" "${AD_HOOKS}" "agent-director hooks"
ad_total=0
ad_session_start=0
ad_permission_request=0
while IFS="${SCENARIO_SEP}" read -r index event _ managed nwords path _; do
    step="agent-director hooks: ${event} command #${index}"
    ad_total=$(( ad_total + 1 ))
    case "${event}" in
        SessionStart) ad_session_start=$(( ad_session_start + 1 )) ;;
        PermissionRequest) ad_permission_request=$(( ad_permission_request + 1 )) ;;
    esac
    (( nwords >= 1 )) || fail "${step}: the command is empty"
    [[ "${managed}" == 0 ]] || fail "${step}: agent-director's settings name ${MANAGED_MARKER}"
    check_command_path "${step}" "${path}"
    real="$(realpath -e -- "${path}")" || fail "${step}: ${path} does not resolve"
    [[ "${real}" == "${AD_REAL}" ]] \
        || fail "${step}: ${path} resolves to ${real}, not the agent-director install ${AD_REAL}"
    [[ "${real}/" != "${NODE_MODULES_REAL}/"* ]] \
        || fail "${step}: ${path} lies inside the customer's node_modules"
done < "${AD_HOOKS}"
(( ad_total > 0 )) || fail "agent-director hooks: the --settings JSON holds no hook command"
(( ad_session_start > 0 )) || fail "agent-director hooks: no SessionStart hook command"
(( ad_permission_request > 0 )) || fail "agent-director hooks: no PermissionRequest hook command (the permission relay)"

# --- 4. CSCB's hooks (<claude_config_dir>/settings.json) -------------------
[[ -f "${CLAUDE_SETTINGS}" ]] || fail "reply guard: ${CLAUDE_SETTINGS} was not written"
list_hooks "${CLAUDE_SETTINGS}" "${CSCB_HOOKS}" "reply guard"
guard_count=0
guard_index=""
while IFS="${SCENARIO_SEP}" read -r index event form managed nwords path second; do
    step="reply guard: ${event} command #${index} of ${CLAUDE_SETTINGS}"
    (( nwords >= 1 )) || fail "${step}: the command is empty"
    check_command_path "${step}" "${path}"
    if [[ "${managed}" != 1 ]]; then
        continue
    fi
    guard_count=$(( guard_count + 1 ))
    guard_index="${index}"
    [[ "${event}" == Stop ]] || fail "${step}: the managed command is not a Stop hook"
    [[ "${form}" == shell ]] || fail "${step}: the managed command carries an args list, not a shell-form command"
    [[ "${nwords}" == 2 ]] || fail "${step}: the managed command has ${nwords} words, not the guard and the record dir"
    real="$(realpath -e -- "${path}")" || fail "${step}: ${path} does not resolve"
    [[ "${real}" == "${GUARD_REAL}" ]] \
        || fail "${step}: ${path} resolves to ${real}, not the installed package's ${GUARD_REAL}"
    [[ "${second}" == "${RECORD_DIR}" ]] \
        || fail "${step}: the record dir is '${second}', not ${RECORD_DIR}"
done < "${CSCB_HOOKS}"
[[ "${guard_count}" == 1 ]] \
    || fail "reply guard: ${CLAUDE_SETTINGS} holds ${guard_count} commands naming ${MANAGED_MARKER}, not 1"
[[ -f "${RECORD_DIR}/${KEY}" && "$(cat "${RECORD_DIR}/${KEY}")" == true ]] \
    || fail "reply guard: the record ${RECORD_DIR}/${KEY} does not read true"

# The command exactly as written, through sh as Claude Code runs it, with
# no input: the guard fails open (exit 0). 126 or 127 is a command the shell
# cannot run.
guard_command="$(python3 "${HOOKS_PY}" raw "${CLAUDE_SETTINGS}" "${guard_index}")" \
    || fail "reply guard: could not read the managed command"
set +e
env CSCB_PERSONA="${KEY}" sh -c "${guard_command}" < /dev/null > "${SCENARIO_ROOT}/guard.out" 2>&1
guard_rc=$?
set -e
[[ "${guard_rc}" == 0 ]] \
    || fail "reply guard: the managed command run through sh with no input exited ${guard_rc}, not 0"

# --- 5. Stop ---------------------------------------------------------------
stop_server --stop-bots
stop_tracked_pid "${STUB_PID}" 10 "the Slack stub did not exit on SIGTERM"

# The tmux session and stub-claude's transcripts go in the exit hook
# (cleanup_launch), which runs on a failure too.
echo "${TEST_NAME}: ${ad_total} agent-director hook command(s) run ${AD_REAL}; the reply guard runs ${GUARD_REAL}"
echo "PASS: ${TEST_NAME}"
