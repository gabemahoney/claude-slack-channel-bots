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
# Everything started here runs in shard/server, at the container's quota less
# the driver's one CPU: the same quota as an ordinary shard. The driver's
# launcher (tests/integration/fixtures/burst-driver.sh --serve) is born in
# shard/driver, at 0.9 CPU, and starts every driver there. The 0.1 CPU left is
# headroom that makes the container's quota rarely throttle the server's
# group; it is no guarantee. testuser owns no cgroup file, so the server's UID
# can neither move a process nor change a limit. The cpu controller is
# threaded, so PID 1 keeps the container's cgroup, which the host runner reads.
split_driver_cpu() {
    local root="$1" membership="$2" spool="$3" quota period line
    read -r line < "${membership}"
    if [[ ${line} != 0::/ ]] || ! grep -qx "$$" "${root}/cgroup.procs"; then
        echo "entrypoint.sh: the cgroup mount is not this container's own; a burst-driver shard needs --cgroupns private" >&2
        return 1
    fi
    read -r quota period < "${root}/cpu.max"
    if ! [[ ${quota} =~ ^[0-9]+$ && ${period} =~ ^[0-9]+$ ]] || (( quota <= period )); then
        echo "entrypoint.sh: the container's cpu.max leaves no CPU for the burst driver" >&2
        return 1
    fi
    mkdir "${root}/shard"
    echo threaded > "${root}/shard/cgroup.type"
    echo +cpu > "${root}/cgroup.subtree_control"
    echo +cpu > "${root}/shard/cgroup.subtree_control"
    mkdir "${root}/shard/server" "${root}/shard/driver"
    echo threaded > "${root}/shard/server/cgroup.type"
    echo threaded > "${root}/shard/driver/cgroup.type"
    echo "$(( quota - period )) ${period}" > "${root}/shard/server/cpu.max"
    echo "$(( period * 9 / 10 )) ${period}" > "${root}/shard/driver/cpu.max"
    mkdir -m 0700 "${spool}"
    mkfifo -m 0600 "${spool}/requests"
    chown testuser:testuser "${spool}" "${spool}/requests"
    # The launcher forks while this process is in shard/driver, then this
    # process, and everything it later starts, goes to shard/server.
    echo "$$" > "${root}/shard/driver/cgroup.procs"
    gosu testuser bash /tests/integration/fixtures/burst-driver.sh --serve "${spool}" &
    echo "$$" > "${root}/shard/server/cgroup.procs"
}
if [[ -w /sys/fs/cgroup/cgroup.subtree_control ]] && (( $$ != 1 )); then
    split_driver_cpu /sys/fs/cgroup /proc/self/cgroup /run/cscb-burst-driver
fi

exec gosu testuser bash /tests/runner.sh "$@"
