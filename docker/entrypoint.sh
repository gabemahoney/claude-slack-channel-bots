#!/bin/bash
# entrypoint.sh — Sets up Claude config and launches tmux ci session as testuser
set -euo pipefail

TESTUSER_HOME=/home/testuser

# Build .claude.json — merge host OAuth creds if mounted, add project trust
mkdir -p "${TESTUSER_HOME}/.claude"
python3 -c "
import json, os

# Start from host credentials if mounted (contains OAuth tokens)
d = {}
if os.path.exists('/host-claude.json'):
    with open('/host-claude.json') as f:
        d = json.load(f)
    print('Loaded host OAuth credentials')

# Ensure required fields
d['numStartups'] = 100
d['hasCompletedOnboarding'] = True

# Merge project trust entries (don't overwrite existing projects)
projects = d.get('projects', {})
for p in ['/test-repo', '/tmp/test-repo-a', '/tmp/test-repo-b']:
    projects.setdefault(p, {})
    projects[p]['hasTrustDialogAccepted'] = True
d['projects'] = projects

# API key as fallback if no OAuth
api_key = os.environ.get('ANTHROPIC_API_KEY', '')
if api_key and 'oauthAccount' not in str(d):
    d['apiKey'] = api_key

json.dump(d, open('${TESTUSER_HOME}/.claude.json', 'w'), indent=2)
print('Created .claude.json')
"

# Write settings.json with skipDangerousModePermissionPrompt
python3 -c "
import json
d = {
    'permissions': {
        'allow': ['Bash', 'Read', 'Write', 'Edit', 'Glob', 'Grep', 'mcp__bees__*'],
        'defaultMode': 'acceptEdits'
    },
    'skipDangerousModePermissionPrompt': True
}
json.dump(d, open('${TESTUSER_HOME}/.claude/settings.json', 'w'), indent=2)
print('Created settings.json')
"

# Write slack-mcp.json so managed sessions can connect back to the server
python3 -c "
import json
d = {'mcpServers': {'slack-channel-router': {'type': 'http', 'url': 'http://127.0.0.1:3100/mcp'}}}
json.dump(d, open('${TESTUSER_HOME}/.claude/slack-mcp.json', 'w'), indent=2)
print('Created slack-mcp.json')
"

chown -R testuser:testuser "${TESTUSER_HOME}/.claude" "${TESTUSER_HOME}/.claude.json" 2>/dev/null || true

# Launch as testuser: auto_approve in background, then tmux ci session
exec gosu testuser bash -c '
  /usr/local/bin/auto_approve.sh ci > /tmp/auto_approve.log 2>&1 &
  sleep 1
  tmux new-session -d -s ci /usr/local/bin/test_runner.sh
  while tmux has-session -t ci 2>/dev/null; do sleep 5; done
'
