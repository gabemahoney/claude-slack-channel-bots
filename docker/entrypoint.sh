#!/bin/bash
# entrypoint.sh — Sets up testuser's Claude config (bot Claudes spawned by the
# daemon-under-test still consume .claude.json + settings.json), then execs
# the bash test runner. No tmux, no orchestrator Claude.
set -euo pipefail

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

exec gosu testuser bash /tests/runner.sh
