#!/usr/bin/env bash
# b.omv SR-14.4: heavy scenario, outside /ci gate discovery.
set -euo pipefail
TEST_NAME="test-101-fmk-real-busy"
source "$(dirname "$0")/../integration/lib/scenario.sh"
source "$(dirname "$0")/../integration/lib/real-scenario.sh"
source "$(dirname "$0")/../integration/lib/real-recovery.sh"
CASE_ASSERT="${SCENARIO_FIXTURES}/real-case-assertions.ts"
BUSY_SETTLED="$(dirname "$0")/test-101-denial-settled.ts"
case_assert() { bun "${CASE_ASSERT}" "$1" "${SLACK_STATE_DIR}" "${REAL_KEY}" "${SCENARIO_AD_SHIM_LOG}" "${HOME}/.claude/projects" "${@:2}"; }
# Acknowledgements may be replies, edits or reactions. These are not the
# permission probes; allowing them keeps the scenario independent of that choice.
real_prepare "${REAL_AGENT_CLAUDE_VERSION:-2.1.296}" 'Bash(sleep *)' \
    mcp__slack-channel-router__reply mcp__slack-channel-router__edit_message mcp__slack-channel-router__react
# Native Claude can auto-allow harmless printf commands. Force only these
# deliberate probes to ask, in the guarded scenario's disposable HOME.
python3 - "${HOME}/.claude/settings.json" <<'PY'
import json, pathlib, sys
path = pathlib.Path(sys.argv[1])
settings = json.loads(path.read_text())
settings['permissions']['ask'] = [
    'Bash(printf permission-probe)', 'Bash(printf subagent-deny-probe)']
path.write_text(json.dumps(settings))
print('recorded: busy native permissions ' + json.dumps(settings['permissions']))
PY
real_persona busy 'Follow each explicit tool request. When asked for a subagent use Agent, have it ask permission for its requested command, and keep the subagent dialog open after a deny. Otherwise acknowledge OK.'
real_write_config '{"test_timer_overrides":{"delivery_stuck_after_ms":3000}}'
real_start_stub
start_server --live
real_wait_launch "${REAL_KEY}"
real_dm "${REAL_LABEL}" 'Run exactly sleep 20 with Bash now.'
wait_until 180 'preallowed sleep tool never observed active' case_assert active-tool 'sleep 20' "${SCENARIO_ROOT}/busy-tool.json"
real_dm "${REAL_LABEL}" 'message while long sleep is running'
real_wait_delivery "${REAL_KEY}" 2
real_wait_idle "${REAL_KEY}"
# AD waiting can precede the durable assistant end_turn record. Poll the
# unchanged proof for at most 180 s; timeout retains its exact final snapshot.
case_assert busy-proof-wait "${SCENARIO_ROOT}/busy-tool.json" 2
real_dm "${REAL_LABEL}" 'Use Bash to run printf permission-probe. Wait for approval.'
wait_until 180 'permission prompt never opened' case_assert permission "${SCENARIO_SLACK_RECORD}"
MARK="$(date +%s%3N)"
real_dm "${REAL_LABEL}" 'message held behind permission prompt'
wait_until 180 'held prompt message not accepted' case_assert accepted 4
wait_until 180 'permission hold did not span the stuck interval' case_assert permission-held "${SCENARIO_SLACK_RECORD}"
case_assert no-send "${MARK}"
case_assert no-stuck
ACTION="$(case_assert relay-action "${SCENARIO_SLACK_RECORD}" allow "${REAL_USER}")"
curl -fsS --max-time 20 -X POST -H 'Content-Type: application/json' --data-binary "${ACTION}" "${SCENARIO_SLACK_STUB_URL}/_push" > "${SCENARIO_ROOT}/allow-action.json"
wait_until 180 'Allow click did not reach CSCB relay' case_assert relay-decision "${SCENARIO_SLACK_RECORD}" allow
real_wait_delivery "${REAL_KEY}" 4
real_wait_idle "${REAL_KEY}"
real_dm "${REAL_LABEL}" 'Use Agent to ask a subagent to run Bash printf subagent-deny-probe. Keep its dialog open after the denied tool.'
wait_until 180 'subagent permission not opened' case_assert subagent-permission "${SCENARIO_SLACK_RECORD}"
ACTION="$(case_assert relay-action "${SCENARIO_SLACK_RECORD}" deny "${REAL_USER}")"
printf '%s\n' "${ACTION}" > "${SCENARIO_ROOT}/deny-click.json"
curl -fsS --max-time 20 -X POST -H 'Content-Type: application/json' --data-binary "${ACTION}" "${SCENARIO_SLACK_STUB_URL}/_push" > "${SCENARIO_ROOT}/deny-action.json"
wait_until 180 'Deny click did not reach CSCB relay' case_assert relay-decision "${SCENARIO_SLACK_RECORD}" deny
# A Stop can precede background Agent completion. Observe the actual matching
# denial and native completion first, then AD waiting.
wait_until 180 'denied subagent did not settle after successful relay response' \
    bun "${BUSY_SETTLED}" "${SLACK_STATE_DIR}" "${REAL_KEY}" \
    "${HOME}/.claude/projects" "${SCENARIO_SLACK_RECORD}" "${SCENARIO_ROOT}/deny-click.json"
real_wait_idle "${REAL_KEY}"
real_dm "${REAL_LABEL}" 'message after denied subagent request'
wait_until 180 'dialog-hold Delivery stuck was not posted' case_assert dialog-notice "${SCENARIO_SLACK_RECORD}" "${REAL_LABEL}"
echo 'recorded: busy kill/recovery started'
real_kill_and_reconcile "${REAL_KEY}"
start_server --live
real_wait_relaunch "${REAL_KEY}"
real_wait_delivery "${REAL_KEY}" 6
echo 'recorded: busy kill/recovery completed'

case_assert launches
real_finish "${REAL_KEY}"
echo "PASS: ${TEST_NAME}"
