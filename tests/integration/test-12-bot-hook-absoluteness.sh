#!/usr/bin/env bash
# Test 12: the installed package removes the obsolete managed reply hook at
# startup, keeps unrelated user hooks, and still launches with absolute
# agent-director hook commands. No transcript or pane is read.
set -euo pipefail

TEST_NAME="test-12-bot-hook-absoluteness"
# shellcheck source=lib/scenario.sh
source "$(dirname "$0")/lib/scenario.sh"

FIXTURES="$(realpath "$(dirname "$0")")/fixtures"

# --- Bounds (seconds) ------------------------------------------------------
STUB_WAIT_S=20     # the stub writing its ready file
START_WAIT_S=120   # the start pass: one bring-up and one launch
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
[[ -d "${PKG_DIR}" ]] || fail "installed package not found at ${PKG_DIR} (Test 1 prerequisite)"
NODE_MODULES_REAL="$(realpath -e -- "${NODE_MODULES}")"

# The agent-director binary the client runs (agent-director's
# discoverSystemBinary): the standard install path when it exists, else the
# first agent-director on PATH. The stub bin dir prepended below holds only
# `claude`, so it does not change this.
if [[ -e "${HOME:?}/.config/agent-director/bin/agent-director" ]]; then
    AD_BIN="${HOME}/.config/agent-director/bin/agent-director"
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

# --- Expected text (fragments quoted from src/) ----------------------------
# src/session-manager.ts startupSessionManager
STARTUP_COMPLETE="$(completion_match 1)"
# src/persona-bringup-controller.ts bringUp through
# src/persona-diagnostics.ts formatPersonaDiagnostic
PERSONA_START="$(persona_start_match 0 "${NAME}")"
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

# Cleanup owns only the tmux session; the container owns all scratch files.
cleanup_launch() {
    tmux kill-session -t "=${TMUX_SESSION}" > /dev/null 2>&1 || true
    if tmux has-session -t "=${TMUX_SESSION}" > /dev/null 2>&1; then
        echo "  | cleanup: the scenario session is still running" >&2
        return 1
    fi
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

# Simulate an upgraded installation while preserving an independent user hook.
write_file "${CLAUDE_SETTINGS}" << 'EOF'
{"permissions":{"allow":["Read"]},"hooks":{"Stop":[{"hooks":[{"type":"command","command":"/obsolete/slack-reply-guard.sh /obsolete/records"},{"type":"command","command":"/bin/true"}]}]}}
EOF

start_server --live
wait_for_log "${STARTUP_COMPLETE}" "${START_WAIT_S}" "start: the start pass never completed"
expect_completion 1 "start" "0 not brought up"
expect_count "${PERSONA_START}" 1 "start: persona-start lines for ${NAME}"
# --- 2. The persona's launched claude --------------------------------------
wait_until "${PROC_WAIT_S}" \
    "claude process: no single live process carries ${INSTANCE_ID}, CSCB_PERSONA=${KEY} and a --settings argument" \
    one_claude_process
[[ "$(cat "${PROC_CONFIG_DIR}")" == "${CLAUDE_CONFIG}" ]] \
    || fail "claude process: its config directory differs from the persona configuration"

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

# --- 4. Legacy cleanup keeps the user hook and installs no replacement -----
[[ -f "${CLAUDE_SETTINGS}" ]] || fail "legacy cleanup removed the settings file"
python3 - "${CLAUDE_SETTINGS}" << 'EOF'
import json, sys
with open(sys.argv[1]) as f:
    settings = json.load(f)
expected = {"permissions": {"allow": ["Read"]}, "hooks": {"Stop": [{"hooks": [{"type": "command", "command": "/bin/true"}]}]}}
if settings != expected:
    raise SystemExit("legacy cleanup did not retain exactly the unrelated settings and user hook")
EOF
[[ ! -e "${PKG_DIR}/stop-hooks/slack-reply-guard.sh" ]] || fail "the installed package still ships the obsolete hook"
[[ -f "${PKG_DIR}/src/reply-reminder.ts" ]] || fail "the installed package does not ship reply reminders"
[[ -f "${PKG_DIR}/src/legacy-reply-hook-cleanup.ts" ]] || fail "the installed package does not ship legacy cleanup"
[[ ! -e "${SLACK_STATE_DIR}/reply-guard" ]] || fail "startup created obsolete reply-guard records"

# --- 5. Stop ---------------------------------------------------------------
stop_server --stop-bots
stop_tracked_pid "${STUB_PID}" 10 "the Slack stub did not exit on SIGTERM"

# The scenario session is removed by the exit hook, including on failure.
echo "${TEST_NAME}: ${ad_total} absolute agent-director hook command(s); legacy hook removed and user hook kept"
echo "PASS: ${TEST_NAME}"
