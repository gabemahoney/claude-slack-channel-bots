#!/bin/bash
# entrypoint.sh — Sets up testuser's Claude config (bot Claudes spawned by the
# daemon-under-test still consume .claude.json + settings.json), then execs
# the bash test runner, passing it every argument this entrypoint got,
# unchanged and in order (the shard's arguments:).
# No tmux, no orchestrator Claude.
set -euo pipefail

# CI credentials become native credentials only inside the disposable image.
# An explicitly supplied CI family replaces the whole legacy family.
if [[ ${CI_ANTHROPIC_API_KEY+x} || ${CI_ANTHROPIC_BASE_URL+x} || ${CI_ANTHROPIC_MODEL+x} ]]; then
    export ANTHROPIC_API_KEY="${CI_ANTHROPIC_API_KEY:-}"
    export ANTHROPIC_BASE_URL="${CI_ANTHROPIC_BASE_URL:-}"
    export ANTHROPIC_MODEL="${CI_ANTHROPIC_MODEL:-}"
fi

TESTUSER_HOME=/home/testuser

mkdir -p "${TESTUSER_HOME}/.claude"

python3 -c "
import json, os

d = {}
if os.path.exists('/host-claude.json'):
    with open('/host-claude.json') as f:
        d = json.load(f)
    print('Loaded host OAuth credentials')

d['numStartups'] = 100
d['hasCompletedOnboarding'] = True

projects = d.get('projects', {})
for p in ['/test-repo', '/tmp/test-repo-a', '/tmp/test-repo-b']:
    projects.setdefault(p, {})
    projects[p]['hasTrustDialogAccepted'] = True
d['projects'] = projects

api_key = os.environ.get('ANTHROPIC_API_KEY', '')
if api_key and 'oauthAccount' not in str(d):
    d['apiKey'] = api_key

json.dump(d, open('${TESTUSER_HOME}/.claude.json', 'w'), indent=2)
print('Created .claude.json')
"

python3 -c "
import json
d = {
    'permissions': {
        'allow': ['Bash', 'Read', 'Write', 'Edit', 'Glob', 'Grep'],
        'defaultMode': 'bypassPermissions'
    },
    'skipDangerousModePermissionPrompt': True
}
json.dump(d, open('${TESTUSER_HOME}/.claude/settings.json', 'w'), indent=2)
print('Created settings.json')
"

python3 -c "
import json
d = {'mcpServers': {'slack-channel-router': {'type': 'http', 'url': 'http://127.0.0.1:3100/mcp'}}}
json.dump(d, open('${TESTUSER_HOME}/.claude/slack-mcp.json', 'w'), indent=2)
print('Created slack-mcp.json')
"

mkdir -p /test-results
chown -R testuser:testuser "${TESTUSER_HOME}/.claude" "${TESTUSER_HOME}/.claude.json" /test-results 2>/dev/null || true

# A burst-driver shard (scripts/ci-run.ts: docker-init as PID 1, a private
# cgroup namespace and a writable cgroup) keeps the SR-8 burst driver off the
# server's CPU quota. It refuses unless the cgroup it sees is this container's
# own: this process at its namespace root, the mount's root listing it.
# The server's 2-CPU quota is the server's alone: a start launcher is born
# in shard/server. Everything else starts in shard/harness, capped at 1 CPU,
# including the runner, scripts, Slack stub and harness-born tmux/personas.
# The driver's launcher
# (tests/integration/fixtures/burst-driver.sh --serve) is born in
# shard/driver, at 0.9 CPU, and starts every driver there. The runner gives the
# container 5 CPUs (scripts/ci-run.ts DRIVER_CPUS), so 1.1 CPU is left as
# headroom. With only 0.1 CPU left, the container's quota could throttle the
# server's group while the server's own quota was not exhausted, unseen in
# the server's cpu.stat (b.9p6: late Post Hold releases with the server
# runnable but not running), so a container with less than 1 CPU of headroom
# (tests/integration/fixtures/sr8-evidence.ts SR8_CONTAINER_HEADROOM_CPUS) is
# refused. testuser owns no cgroup file, so the server's UID can neither move
# a process nor change a limit.
# The cpu controller is threaded, so PID 1 keeps the container's cgroup, which
# the host runner reads.
split_driver_cpu() {
    local root="$1" membership="$2" spool="$3" quota period line
    read -r line < "${membership}"
    if [[ ${line} != 0::/ ]] || ! grep -qx "$$" "${root}/cgroup.procs"; then
        echo "entrypoint.sh: the cgroup mount is not this container's own; a burst-driver shard needs --cgroupns private" >&2
        return 1
    fi
    read -r quota period < "${root}/cpu.max"
    if ! [[ ${quota} =~ ^[0-9]+$ && ${period} =~ ^[0-9]+$ ]] || (( quota < period * 4 + period * 9 / 10 )); then
        echo "entrypoint.sh: the container's cpu.max leaves less than 1 CPU of headroom beside the server's 2 CPUs, the burst driver's 0.9 and the harness's 1" >&2
        return 1
    fi
    mkdir "${root}/shard"
    echo threaded > "${root}/shard/cgroup.type"
    echo +cpu > "${root}/cgroup.subtree_control"
    echo +cpu > "${root}/shard/cgroup.subtree_control"
    mkdir "${root}/shard/server" "${root}/shard/driver" "${root}/shard/harness"
    echo threaded > "${root}/shard/server/cgroup.type"
    echo threaded > "${root}/shard/driver/cgroup.type"
    echo threaded > "${root}/shard/harness/cgroup.type"
    echo "$(( period * 2 )) ${period}" > "${root}/shard/server/cpu.max"
    echo "$(( period * 9 / 10 )) ${period}" > "${root}/shard/driver/cpu.max"
    echo "${period} ${period}" > "${root}/shard/harness/cpu.max"
    mkdir -m 0700 "${spool}"
    mkfifo -m 0600 "${spool}/requests"
    chown testuser:testuser "${spool}" "${spool}/requests"
    # Each launcher is born in its group; no child migrates after launch.
    echo "$$" > "${root}/shard/driver/cgroup.procs"
    gosu testuser bash /tests/integration/fixtures/burst-driver.sh --serve "${spool}" &
    echo "$$" > "${root}/shard/server/cgroup.procs"
    local server_spool="${spool}-server"
    mkdir -m 0755 "${server_spool}"
    mkdir -m 0700 "${server_spool}/jobs"
    mkfifo -m 0660 "${server_spool}/requests"
    chown root:testuser "${server_spool}/requests"
    chown testuser:testuser "${server_spool}/jobs"
    gosu testuser bash /tests/integration/fixtures/server-start.sh --serve "${server_spool}" &
    echo "$$" > "${root}/shard/harness/cgroup.procs"
    export CSCB_TEST_RUNNER_PID=$$
}
if [[ -w /sys/fs/cgroup/cgroup.subtree_control ]] && (( $$ != 1 )); then
    split_driver_cpu /sys/fs/cgroup /proc/self/cgroup /run/cscb-burst-driver
fi

exec gosu testuser bash /tests/runner.sh "$@"
