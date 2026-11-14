#!/usr/bin/env bash
# ci-requires: test-1
# Synthetic custody tests and actual legacy raw-input/receipt transport.
# No real Claude. See busy-send-driver.ts for the precise client boundary.
set -euo pipefail
TEST_NAME=test-50-fmk-busy-send
source "$(dirname "$0")/lib/scenario.sh"
# Like D1's selected closing assertions, this packed-module scenario has no
# bot server. Keep the tmux/delete checks; replace only the server-probe
# positive control with real driver get/send calls. The EXIT trap rechecks it.
SCENARIO_CLOSING_ASSERTIONS=(assert_no_server_tmux assert_busy_send_no_finished assert_no_cscb_delete)
assert_busy_send_no_finished() {
    local step=assert_busy_send_no_finished lines=() parent=() i get=0 send=0
    _scenario_query_prep "${step}"
    (( _SCENARIO_START_COUNT == 0 )) || fail "${step}: test-50 must not start a bot server"
    _scenario_read_log "${step}" "${SCENARIO_AD_SHIM_LOG}" lines
    for i in "${!lines[@]}"; do
        _scenario_split_line "${lines[i]}"
        [[ "${_L_KIND}" == call ]] || continue
        _scenario_decode_words
        _scenario_finished_kill_words && fail "${step}: finished-row kill is forbidden"
        _scenario_ad_verb
        _scenario_eval_words parent "${_L_PARENT}" || fail "${step}: unreadable parent"
        [[ "${parent[0]##*/}" == bun && "${parent[1]:-}" == */fixtures/busy-send-driver.ts ]] || continue
        [[ "${_L_VERB}" != get ]] || get=1
        [[ "${_L_VERB}" != send-keys ]] || send=1
    done
    (( get && send )) || fail "${step}: missing packed driver get/send-keys positive controls"
    _scenario_closing_ran "${step}"
}
bun "${SCENARIO_FIXTURES}/busy-send-controls.ts" || fail 'busy-send shim self-test'
cp "${SCENARIO_FIXTURES}/agent-director-busy-send.ts" "${SCENARIO_AD_ROOT}/bin/agent-director-busy-send.ts"
cp "${SCENARIO_FIXTURES}/busy-result.ts" "${SCENARIO_AD_ROOT}/bin/busy-result.ts"
ln -s /usr/local/bin/bun "${SCENARIO_AD_ROOT}/bin/agent-director-busy-bun"
touch "${SCENARIO_BIN}/stub-claude-count-prompts"
work=$(make_workdir dual-path)
instance=cscb_t50_fixture
stub_mode "${work}" at-once
ad_capture spawn --agent claude --cwd "${work}" --instance-id "${instance}" \
    --tmux-session-name "${instance}" --no-pre-trust --relay-mode on --label tag_prompt=1
(( AD_RC == 0 )) || fail 'spawn legacy fixture'
waiting() {
    ad_capture get --instance-id "${instance}"
    (( AD_RC == 0 )) && jq -e '.state == "waiting"' "${AD_OUT}" > /dev/null
}
wait_until 30 'fixture did not report waiting' waiting
control="${SCENARIO_AD_ROOT}/bin/agent-director-busy-send.json"
# E2 candidates really cover fresh launches; do not pretend they are the
# old runtime. The absent leg belongs to the ordinary legacy run only.
ad_capture get --instance-id "${instance}"
coverage=$(jq -r '.busy_send // "absent"' "${AD_OUT}")
if [[ "${coverage}" == absent ]]; then
    cscb_run bun "${SCENARIO_FIXTURES}/busy-send-driver.ts" "${SCENARIO_ROOT}" "${instance}" "${work}" absent \
        || fail 'absent capability delivery'
else
    echo "recorded: actual runtime reports busy_send=${coverage}; absent-field proof requires the legacy run"
fi
modes=(covered unknown)
if [[ "${coverage}" != covered ]]; then modes=(not_covered fallback "${modes[@]}"); fi
for mode in "${modes[@]}"; do
    cscb_run bun "${SCENARIO_FIXTURES}/busy-send-driver.ts" "${SCENARIO_ROOT}" "${instance}" "${work}" "${mode}" \
        || fail "dual path ${mode}"
done
# Legacy receipt count proves synthetic held/lookup paths never typed to the
# worker. These prompts are complete real stub receipts, not shim successes.
expected=0
[[ "${coverage}" == covered ]] || expected=2
[[ "${coverage}" != absent ]] || expected=3
actual=0
if [[ -f "${SCENARIO_BIN}/stub-claude-prompt-receipts" ]]; then
    actual=$(wc -l < "${SCENARIO_BIN}/stub-claude-prompt-receipts")
fi
[[ "${actual}" == "${expected}" ]] \
    || fail 'duplicate or unexpected native prompt receipt'
rm -f "${control}"
ad_capture kill --instance-id "${instance}"
(( AD_RC == 0 )) || fail 'fixture kill failed'
assert_no_server_tmux
assert_busy_send_no_finished
assert_no_cscb_delete
echo "PASS: ${TEST_NAME}"
