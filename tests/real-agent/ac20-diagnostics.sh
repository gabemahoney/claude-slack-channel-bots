# Decision21(c) bootstrap. Sourced only for the separately authorized job.
# Native stdin/stdout remain the AD-owned terminal; raw debug stays in a pipe.
AC20_DIAGNOSTIC_HELPER="${BASH_SOURCE[0]%/*}/ac20-diagnostics.ts"
real_ac20_diagnostics_start() {
    [[ "${REAL_AGENT_AC20_DIAGNOSTICS:-}" == decision21c ]] || return 0
    require_scenario_home real_ac20_diagnostics_start
    [[ "${TEST_NAME}" == test-120-fmk-real-ai-ac20 && "${AI_CRITERION:-}" == 20 && "${REAL_CLAUDE_VERSION}" == 2.1.296 && "${REAL_AGENT_MODEL_PIN:-}" == azure/openai/gpt-6-astra ]] || fail 'diagnostic selection changed'
    AC20_DIAGNOSTIC_DIR="${SCENARIO_ROOT}/ac20-diagnostics"
    export AC20_DIAGNOSTIC_DIR AC20_DIAGNOSTIC_HELPER
    mkdir -m 700 "${AC20_DIAGNOSTIC_DIR}"
    printf '{"case":0}\n' > "${AC20_DIAGNOSTIC_DIR}/scope.json"
    touch "${AC20_DIAGNOSTIC_DIR}/gateway.jsonl"
    bun "${AC20_DIAGNOSTIC_HELPER}" verify "${AC20_DIAGNOSTIC_DIR}" "${REAL_CLAUDE}" || fail 'native binary audit failed'
    bun "${AC20_DIAGNOSTIC_HELPER}" gateway "${AC20_DIAGNOSTIC_DIR}" > "${AC20_DIAGNOSTIC_DIR}/gateway-process.log" 2>&1 &
    track_pid "$!"
    wait_for_file "${AC20_DIAGNOSTIC_DIR}/gateway-ready.json" 20 'diagnostic gateway never became ready'
    local wrapper="${SCENARIO_ROOT}/bin/ac20-native"
    cat > "${wrapper}" <<'WRAPPER'
#!/usr/bin/env bash
# The final execve in native() preserves this pane PID for AD's SessionStart
# association. Raw stderr only crosses an anonymous pipe to the sidecar.
exec bun "${AC20_DIAGNOSTIC_HELPER}" native "${AC20_DIAGNOSTIC_DIR}" /opt/claude-code/2.1.296/claude "$@" \
    2> >(exec bun "${AC20_DIAGNOSTIC_HELPER}" collect "${AC20_DIAGNOSTIC_DIR}" "$$")
WRAPPER
    chmod 700 "${wrapper}"
    python3 - "${SCENARIO_AD_ROOT}/config.toml" "${wrapper}" <<'CONFIG'
import json,pathlib,re,sys
p=pathlib.Path(sys.argv[1]);s=p.read_text()
s,n=re.subn(r'(?m)^claude_path = .*$', 'claude_path = '+json.dumps(sys.argv[2]),s)
assert n==1
p.write_text(s)
CONFIG
    on_exit real_ac20_diagnostics_report
    printf 'recorded: diagnostics enabled native=2.1.296 completion_ms=180000 ceiling_ms=2100000 grace_after_linked_retry_ms=60000\n'
}
real_ac20_diagnostic_case() {
    [[ "${REAL_AGENT_AC20_DIAGNOSTICS:-}" == decision21c ]] || return 0
    bun "${AC20_DIAGNOSTIC_HELPER}" case "${AC20_DIAGNOSTIC_DIR}" "$1" || fail 'diagnostic case unavailable'
}
real_ac20_diagnostic_readback() {
    [[ "${REAL_AGENT_AC20_DIAGNOSTICS:-}" == decision21c ]] || fail 'diagnostic completion observer not enabled'
    local started_ms
    # Use the ordinary scenario clock before launching Bun, so loading the
    # observer cannot extend the original wait_until180 assertion window.
    started_ms="$(_scenario_now_ms)"
    AI_CRITERION=20 bun "${AC20_DIAGNOSTIC_HELPER}" wait "${AC20_DIAGNOSTIC_DIR}" "${started_ms}" "${SLACK_STATE_DIR}" "${REAL_KEY}" "${SCENARIO_AD_SHIM_LOG}" "${HOME}/.claude/projects" "$1" "$2" \
        || fail 'completed exact readback absent within180s; diagnostic grace cannot promote failure'
    # Print the original successful oracle's proof; assertions and model stay
    # in ai-readback.ts. On failure the function above exits the scenario.
    ai_readback "$1" "$2"
}
real_ac20_diagnostics_report() {
    # These files contain only projected metadata; no raw debug is on disk.
    python3 - "${AC20_DIAGNOSTIC_DIR}" <<'REPORT'
import json,pathlib,sys
root=pathlib.Path(sys.argv[1]);total=0
for path in sorted(root.glob('*.jsonl')):
 for line in path.read_text().splitlines():
  row=json.loads(line);total+=len(line)+1
  assert total<=2097152
  print('recorded: diagnostic '+json.dumps(row,separators=(',',':')))
REPORT
}
