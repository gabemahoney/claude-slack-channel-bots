#!/usr/bin/env bash
# D1 native gate: exact delivery, FIFO, real faults/crash and native observations.
set -euo pipefail
TEST_NAME="test-41-fmk-real-codex"
source "$(dirname "$0")/lib/scenario.sh"
REAL_FAILURE_AGENT=codex
source "$(dirname "$0")/lib/real-failure.sh"
require_ci_image codex-observation
require_scenario_home codex-observation
[[ -z "${TMUX+x}" && "${TMUX_TMPDIR:-}" == "${SCENARIO_ROOT}"/* ]] || fail 'Codex requires a private tmux server'
[[ "${CODEX_TEST_MODEL:-}" =~ ^[A-Za-z0-9._:/-]+$ ]] || fail 'Codex requires the runner-selected model'
[[ -f /run/codex-login/auth.json ]] || fail 'Codex requires its dedicated single-file login mount'
# No real-scenario.sh: D1 has no CSCB server, Slack stub or Claude model calls.
PATH="${SCENARIO_TMUX_SHIM_BIN}:${PATH}" bun "$(dirname "$0")/../real-agent/codex-delivery.ts" gate
[[ -L "${HOME}/.codex/auth.json" ]] || fail 'scratch Codex auth.json stopped being a symlink'
assert_codex_d1_safety
echo "PASS: ${TEST_NAME}"
