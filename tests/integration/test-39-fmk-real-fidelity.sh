#!/usr/bin/env bash
# real native Claude; all state belongs to this container.
set -euo pipefail
TEST_NAME="test-39-fmk-real-fidelity"
source "$(dirname "$0")/lib/scenario.sh"
source "$(dirname "$0")/lib/real-scenario.sh"
CASE_ASSERT="${SCENARIO_FIXTURES}/real-case-assertions.ts"
case_assert() { bun "${CASE_ASSERT}" "$1" "${SLACK_STATE_DIR}" "${REAL_KEY}" "${SCENARIO_AD_SHIM_LOG}" "${HOME}/.claude/projects" "${@:2}"; }
real_prepare
real_persona fidelity
real_write_config
real_start_stub
start_server --live
real_wait_launch "${REAL_KEY}"
mapfile -t INPUTS < <(python3 - "${REAL_LABEL}" "${REAL_USER}" <<'INPUT'
import json,sys
label,user=sys.argv[1:]
frame=f'<channel source="slack-channel-router" chat_id="D0{label.upper()}" channel_name="dm" message_id="1792000000.123456" user="stub-{user.lower()}" user_id="{user}" ts="1792000000.123456" via="dm"></channel>'
cases=['emoji 👩🏽‍💻 👨‍👩‍👧‍👦','CJK 猫中文日本語','RTL \u200fשלום\u200e','NBSP a\u00a0b','separator a\u2028b','combining e\u0301 u\u0308','four byte 🦀𐐀','ends in plain @word']
for n in (850,1400,1900): cases.append('x'*(n-len(frame.encode())))
cases.append('\n'.join('line %02d'%i for i in range(60)))
for s in cases: print(json.dumps(s,ensure_ascii=True))
INPUT
)
COUNT=0
for input in "${INPUTS[@]}"; do
    real_wait_idle "${REAL_KEY}"
    BODY="$(python3 -c 'import json,sys; print(json.loads(sys.argv[1]),end="")' "${input}")"
    real_dm "${REAL_LABEL}" "${BODY}"
    COUNT=$((COUNT+1))
    real_wait_delivery "${REAL_KEY}" "${COUNT}" no-retype
    echo "recorded: fidelity input ${COUNT} confirmed exactly without retype"
done
real_assert_no_retype "${REAL_KEY}" "${COUNT}"
case_assert fidelity-shapes
echo 'recorded: native input rewrites escaped before typing: U+2028=>&#8232; U+0301=>&#769; U+0308=>&#776;'

case_assert launches
real_finish "${REAL_KEY}"
echo "PASS: ${TEST_NAME}"
