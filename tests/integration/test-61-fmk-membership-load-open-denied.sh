#!/usr/bin/env bash
# ci-requires: test-1
# AC-C06: open first/later denied, two reopened 100,000-join personas, real socket ACKs.
# Selected cases and verdicts share lib/membership-load.sh.
# Native-agent N2/N3/N4 evidence remains the separate test-32 thread phase.
set -euo pipefail
TEST_NAME="test-61-fmk-membership-load-open-denied"
# shellcheck source=lib/scenario.sh
source "$(dirname "$0")/lib/scenario.sh"
# shellcheck source=lib/membership-load.sh
source "$(dirname "$0")/lib/membership-load.sh"
STARTED="$(date +%s)"
run_membership_load open denied
assert_no_server_tmux
assert_no_cscb_include_finished
assert_no_cscb_delete
echo "PASS: ${TEST_NAME} ($(( $(date +%s) - STARTED ))s; stub queues intentionally retained until cleanup)"
