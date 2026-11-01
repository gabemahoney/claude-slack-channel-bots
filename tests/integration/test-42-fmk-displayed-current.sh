#!/usr/bin/env bash
# ci-requires: test-1
# b.iy3 current AD contract: real hook-driven idle screen and aged permission
# requests, production delivery receipt extension and permission Slack posts.
# Legacy additionally requires unnormalized real-client negative controls.
set -euo pipefail
TEST_NAME="test-42-fmk-displayed-current"
# shellcheck source=lib/scenario.sh
source "$(dirname "$0")/lib/scenario.sh"
# shellcheck source=lib/displayed-states.sh
source "$(dirname "$0")/lib/displayed-states.sh"
run_displayed_states current
assert_no_server_tmux
assert_no_cscb_include_finished
assert_no_cscb_delete
echo "PASS: ${TEST_NAME}"
