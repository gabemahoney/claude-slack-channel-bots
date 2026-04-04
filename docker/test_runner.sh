#!/bin/bash
# test_runner.sh — Installs the package tarball and runs the /release-test skill
set -euo pipefail

echo "=== Installing package from tarball ==="
cd /test-repo
bun install /tmp/package.tgz

echo "=== Running integration tests ==="
exec claude "/release-test"
