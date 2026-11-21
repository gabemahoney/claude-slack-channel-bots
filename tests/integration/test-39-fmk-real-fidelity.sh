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
# A distinct sender avoids the ordinary sender-name cache and leaves the
# original byte-size cases unchanged. The stub already supports user profiles.
python3 - "${SCENARIO_ROOT}/real-slack-stub/control.json" "${REAL_USER}META" <<'ATTR_USER'
import json,os,sys
path,user=sys.argv[1:]
with open(path) as f: control=json.load(f)
control.setdefault('users',{})[user]={'profile':{'display_name':'Dom \u200eMoorman'}}
with open(path+'.next','w') as f: json.dump(control,f)
os.replace(path+'.next',path)
ATTR_USER
start_server --live
real_wait_launch "${REAL_KEY}"
mapfile -t INPUTS < <(python3 - "${REAL_LABEL}" "${REAL_USER}" <<'INPUT'
import json,sys
label,user=sys.argv[1:]
frame=f'<channel source="slack-channel-router" chat_id="D0{label.upper()}" channel_name="dm" message_id="1792000000.123456" user="stub-{user.lower()}" user_id="{user}" ts="1792000000.123456" via="dm"></channel>'
cases=['emoji 👩🏽‍💻 👨‍👩‍👧‍👦','CJK 猫中文日本語','RTL \u200fשלום\u200e','NBSP a\u00a0b','separator a\u2028b','combining e\u0301 u\u0308','four byte 🦀𐐀','ends in plain @word']
for n in (850,1400,1900): cases.append('x'*(n-len(frame.encode())))
cases.append('\n'.join('line %02d'%i for i in range(60)))
named=[('original-%02d'%(i+1),s) for i,s in enumerate(cases)]
named += [
    ('b88t-reporter-short','1. \u200eDom Moorman'),
    ('b88t-reporter-22-lines','\n'.join(['1. \u200eDom Moorman']+['line %02d'%i for i in range(2,23)])),
    ('b88t-removed-class-short','removed a\u00adb\u034fc\u061cd\u115fe\u180ef\u200bg\u200ch\u200di\u200ej\u200fk\u202al\u202em\u2060n\u2061o\u2064p\u2066q\u2069r\u3164s\ufe0ft\ufeffu\uffa0v\ufff9w\U000e0041z'),
    ('b88t-paragraph-separator-short','paragraph a\u2029b'),
    ('b88t-nfc-short','NFC a\u0300 a\u0302 a\u0303 a\u030a c\u0327 \u1100\u1161 \uac00\u11a8 \u212b a\u0316\u0300'),
    ('b88t-literal-paste-frame-short','literal <pasted_content id="x">quoted</pasted_content>'),
    ('b88t-literal-paste-frame-22-lines','\n'.join(['<pasted_content id="x">','quoted','</pasted_content>']+['line %02d'%i for i in range(4,23)])),
]
for name,s in named: print(json.dumps([name,s],ensure_ascii=True))
print(json.dumps(['b88t-attribute-display-name','attribute display name',{'user':user+'META'}],ensure_ascii=True))
print(json.dumps(['b88t-attribute-nfd-attachment','attribute attachment name',{'subtype':'file_share','files':[{'id':'F0FIDELITYNFD','name':'Re\u0301sume\u0301.pdf','mimetype':'application/pdf','size':123}]}],ensure_ascii=True))
INPUT
)
COUNT=0
for input in "${INPUTS[@]}"; do
    real_wait_idle "${REAL_KEY}"
    CASE_NAME="$(python3 -c 'import json,sys; print(json.loads(sys.argv[1])[0],end="")' "${input}")"
    BODY="$(python3 -c 'import json,sys; print(json.loads(sys.argv[1])[1],end="")' "${input}")"
    METADATA="$(python3 -c 'import json,sys; v=json.loads(sys.argv[1]); print(json.dumps(v[2] if len(v)>2 else {}),end="")' "${input}")"
    if [[ "${METADATA}" == '{}' ]]; then
        real_dm "${REAL_LABEL}" "${BODY}"
    else
        EVENT="$(jq -cn --arg text "${BODY}" --arg ts "$(date +%s.%6N)" --arg channel "D0${REAL_LABEL^^}" \
            --arg user "${REAL_USER}" --argjson metadata "${METADATA}" \
            '{type:"message",channel:$channel,channel_type:"im",user:$user,text:$text,ts:$ts} + $metadata')"
        slack_stub_push "${REAL_LABEL}" "${EVENT}"
    fi
    COUNT=$((COUNT+1))
    real_wait_delivery "${REAL_KEY}" "${COUNT}" no-retype
    echo "recorded: fidelity input ${COUNT} confirmed exactly without retype"
    echo "recorded: fidelity case ${CASE_NAME} confirmed exactly without retype"
done
# Work accepted after the last wait's audit, such as a reply reminder, is
# awaited and must also be typed once, not raced by a one-shot audit.
real_wait_delivery "${REAL_KEY}" "${COUNT}" no-retype
case_assert fidelity-shapes
case_assert fidelity-attributes
echo 'recorded: native input rewrites escaped before typing: DICP/Cf, U+2028/U+2029, NFC changes; channel and paste-frame openers neutralized'

case_assert launches
real_finish "${REAL_KEY}"
echo "PASS: ${TEST_NAME}"
