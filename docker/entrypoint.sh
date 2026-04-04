#!/bin/bash
# entrypoint.sh — Sets up Claude config and launches tmux ci session as testuser
set -euo pipefail

TESTUSER_HOME=/home/testuser

# Build .claude.json with API key auth and project trust
mkdir -p "${TESTUSER_HOME}/.claude"
python3 -c "
import json, os
api_key = os.environ.get('ANTHROPIC_API_KEY', '')
bees_url = os.environ.get('BEES_MCP_URL', 'http://host.docker.internal:8000')
d = {
    'numStartups': 100,
    'hasCompletedOnboarding': True,
    'projects': {'/test-repo': {'hasTrustDialogAccepted': True}},
    'mcpServers': {
        'bees': {'type': 'http', 'url': bees_url + '/mcp'}
    }
}
if api_key:
    d['apiKey'] = api_key
json.dump(d, open('${TESTUSER_HOME}/.claude.json', 'w'), indent=2)
print('Created .claude.json')
"

chown -R testuser:testuser "${TESTUSER_HOME}/.claude" "${TESTUSER_HOME}/.claude.json" 2>/dev/null || true

# Launch as testuser: auto_approve in background, then tmux ci session
exec gosu testuser bash -c '
  /usr/local/bin/auto_approve.sh ci > /tmp/auto_approve.log 2>&1 &
  sleep 1
  tmux new-session -d -s ci
  while tmux has-session -t ci 2>/dev/null; do sleep 5; done
'
