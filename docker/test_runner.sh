#!/bin/bash
# test_runner.sh — Installs the package tarball and runs the /release-test skill
set -euo pipefail

echo "=== Installing package from tarball ==="
cd /test-repo
bun install /tmp/package.tgz

echo "=== Setting up local bees hive ==="
mkdir -p ~/.bees
python3 -c "
import json
config = {
    'scopes': {
        '/test-repo/**': {
            'hives': {
                'testplans': {
                    'path': '/test-repo/testplans',
                    'display_name': 'testplans'
                }
            }
        }
    }
}
with open('$(echo ~)/.bees/config.json', 'w') as f:
    json.dump(config, f, indent=2)
print('Created bees config')
"

echo "=== Registering bees MCP server ==="
claude mcp add bees -- bees serve --stdio 2>&1 || echo "WARN: claude mcp add failed"

echo "=== Running integration tests ==="
exec claude "/release-test"
