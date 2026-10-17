# D1 only: native Codex, installed delivery modules and the scenario's shim.
source "$(dirname "${BASH_SOURCE[0]}")/../integration/lib/scenario.sh"
require_ci_image codex-ai
require_scenario_home codex-ai
[[ -z "${TMUX+x}" && "${TMUX_TMPDIR:-}" == "${SCENARIO_ROOT}"/* ]] || fail 'Codex requires a private tmux server'
[[ "${CODEX_TEST_MODEL:-}" =~ ^[A-Za-z0-9._:/-]+$ ]] || fail 'Codex requires the runner-selected model'
[[ "${REAL_AGENT_TRIAL:-}" =~ ^[123]$ ]] || fail 'Codex requires an explicit independent trial 1, 2 or 3'
[[ -f /run/codex-login/auth.json ]] || fail 'Codex requires its dedicated single-file login mount'
bun "$(dirname "${BASH_SOURCE[0]}")/codex-delivery.ts" ai "${AI_CRITERION}"
[[ -L "${HOME}/.codex/auth.json" ]] || fail 'scratch Codex auth.json stopped being a symlink'
assert_codex_d1_safety
echo "PASS: ${TEST_NAME}"
