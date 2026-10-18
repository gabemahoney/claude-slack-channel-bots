# Failure-only metadata for every native scenario, including cleanup failures.
# Source after scenario.sh. Native Codex writes its projected pane before retiring.
REAL_FAILURE_HELPER="${BASH_SOURCE[0]%/*}/../../real-agent/ai-failure-diagnostics.ts"
REAL_FAILURE_PANES="${SCENARIO_ROOT}/real-final-panes.jsonl"
_real_final_panes() {
    [[ "${REAL_FAILURE_AGENT:-claude}" == claude ]] || return 0
    [[ -f "${REAL_PERSONAS:-}" ]] || return 0
    local name key raw="${SCENARIO_ROOT}/failure-pane.json"
    while IFS= read -r name; do
        key="$(persona_key "${name}")"
        real_pane "${key}" 80 > "${raw}" 2>/dev/null || printf '{}\n' > "${raw}"
        bun "${REAL_FAILURE_HELPER}" pane claude "${raw}" "${key}" >> "${REAL_FAILURE_PANES}"
    done < <(jq -r '.name' "${REAL_PERSONAS}")
}
_real_failure_evidence() {
    local agent="${REAL_FAILURE_AGENT:-claude}" root="${HOME}/.claude/projects"
    [[ "${agent}" != codex ]] || root="${HOME}/.codex/sessions"
    bun "${REAL_FAILURE_HELPER}" capture "${agent}" "${root}" "${TEST_NAME}" "${REAL_AGENT_TRIAL:-}" "${REAL_FAILURE_PANES}"
}
on_before_cleanup _real_final_panes
on_failure _real_failure_evidence
