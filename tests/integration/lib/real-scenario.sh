#!/usr/bin/env bash
# Shared executable infrastructure, sourced AFTER scenario.sh (b.omv SR-14).
# Scenario scripts own their case inputs/assertions; this owns containment,
# native selection, onboarding, transport observations and exact receipts.
require_ci_image real-scenario
require_scenario_home real-scenario
source "${BASH_SOURCE[0]%/*}/real-failure.sh"
[[ "${TEST_NAME}" == *-fmk-real-* ]] || fail 'real-scenario requires a -fmk-real- script'
REAL_DELIVERY_WAIT_S=180
REAL_LAUNCH_WAIT_S=300
REAL_COMPACT_WAIT_S=120
REAL_IDLE_WAIT_S=2700
REAL_RECEIPTS="${SCENARIO_FIXTURES}/transcript-receipts.ts"
REAL_PERSONAS="${SCENARIO_ROOT}/real-personas.jsonl"
REAL_TOKENS="${SCENARIO_ROOT}/real-stub-tokens.jsonl"
REAL_USAGE_REPORTED=0
touch "${REAL_PERSONAS}" "${REAL_TOKENS}"

# scenario.sh invokes EXIT hooks before deleting the isolated HOME/transcripts.
# Register at source time so launch, delivery and assertion failures still
# account for usage once. Hook failure cannot erase the script's original exit.
_real_usage_on_exit() {
    real_report
}
on_exit _real_usage_on_exit

_real_capture_before_start() {
    bun "${REAL_RECEIPTS}" capture "${SLACK_STATE_DIR}"
}
on_before_start _real_capture_before_start

# real_prepare [version] [permission-allow-rule ...]
real_prepare() {
    require_scenario_home real_prepare
    REAL_CLAUDE_VERSION="${1:-${REAL_AGENT_CLAUDE_VERSION:-2.1.296}}"
    (( $# == 0 )) || shift
    [[ "${REAL_CLAUDE_VERSION}" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || fail 'invalid native Claude version'
    REAL_CLAUDE="/opt/claude-code/${REAL_CLAUDE_VERSION}/claude"
    [[ -x "${REAL_CLAUDE}" ]] || fail "native Claude missing at ${REAL_CLAUDE}"
    [[ -n "${ANTHROPIC_API_KEY:-}" ]] || fail 'ANTHROPIC_API_KEY is absent'
    export DISABLE_AUTOUPDATER=1
    # Inherited host subscription credentials must never be used by a real leg.
    unset CLAUDE_CODE_OAUTH_TOKEN ANTHROPIC_AUTH_TOKEN CLAUDE_CONFIG_DIR
    if [[ -n "${REAL_AGENT_MODEL_PIN:-}" ]]; then
        # Only the heavy job sets this pin; ordinary /ci keeps its own settings.
        export ANTHROPIC_MODEL="${REAL_AGENT_MODEL_PIN}"
        export CLAUDE_CODE_DISABLE_REFUSAL_FALLBACK=1
    fi
    local actual
    actual="$("${REAL_CLAUDE}" --version)" || fail 'native Claude version check failed'
    [[ "${actual%% *}" == "${REAL_CLAUDE_VERSION}" ]] || fail 'native Claude version mismatch'
    printf 'recorded: native Claude %s\n' "${actual}"
    python3 - "${HOME}" "${SCENARIO_AD_ROOT}/config.toml" "${REAL_CLAUDE}" "${REAL_CLAUDE_VERSION}" "$@" <<'PY'
import json, os, pathlib, re, sys
home, config, native, version, *allow = sys.argv[1:]
p = pathlib.Path(config)
old = p.read_text() if p.exists() else ''
old = re.sub(r'(?ms)^\[launch\][^\[]*(?=^\[|\Z)', '', old)
p.write_text(old + '\n[launch]\nclaude_path = ' + json.dumps(native) + '\n')
pathlib.Path(home, '.claude').mkdir(exist_ok=True)
key = os.environ['ANTHROPIC_API_KEY']
d = {'numStartups':100, 'hasCompletedOnboarding':True, 'lastOnboardingVersion':version,
     'customApiKeyResponses':{'approved':[key[-20:]], 'rejected':[]}, 'projects':{},
     'hasSeenAutoDefaultNudge':True, 'hasResetAutoModeOptInForDefaultOffer':True}
p = pathlib.Path(home, '.claude.json')
p.write_text(json.dumps(d))
p.chmod(0o600)
settings = {
    'permissions':{'allow':allow, 'defaultMode':'default'},
    'autoUpdatesChannel':'stable', 'enableAllProjectMcpServers':True}
model_pin = os.environ.get('REAL_AGENT_MODEL_PIN')
if model_pin:
    # The allowlist blocks a flagged target without an interactive switch
    # dialog. An empty chain also disables availability-based fallback.
    settings.update(model=model_pin, availableModels=[model_pin],
                    switchModelsOnFlag=False, fallbackModel=[])
pathlib.Path(home, '.claude/settings.json').write_text(json.dumps(settings))
PY
    if [[ "${REAL_AGENT_AC20_DIAGNOSTICS:-}" == decision21c ]]; then
        source "${BASH_SOURCE[0]%/*}/../../real-agent/ac20-diagnostics.sh"
        real_ac20_diagnostics_start
    fi
}

# Creates a persona and exposes REAL_{NAME,KEY,WORK,LABEL,CHANNEL,USER,
# BOT_USER_ID,BOT_ID}; explicit stub identities support the mention cases.
# Call in the current shell so those values and the accumulated config survive.
real_persona() {
    REAL_NAME="$1"
    REAL_KEY="$(persona_key "${REAL_NAME}")"
    REAL_LABEL="${REAL_KEY//_/}"
    REAL_CHANNEL="C0${REAL_LABEL^^}"
    REAL_USER="U0${REAL_LABEL^^}"
    REAL_BOT_USER_ID="U0${REAL_LABEL^^}BOT"
    REAL_BOT_ID="B0${REAL_LABEL^^}"
    REAL_WORK="$(make_workdir "${REAL_KEY}")"
    local creds="${SCENARIO_ROOT}/${REAL_KEY}.credentials.json"
    printf '%s\n' "${2:-Acknowledge every relayed channel message with exactly OK. Do not use tools unless the message explicitly requests one.}" > "${REAL_WORK}/CLAUDE.md"
    jq -n --arg bot "$(fake_token bot "${REAL_LABEL}")" --arg app "$(fake_token app "${REAL_LABEL}")" \
        '{bot_token:$bot,app_token:$app}' | write_file "${creds}" 600
    jq -cn --arg name "${REAL_NAME}" --arg creds "${creds}" --arg work "${REAL_WORK}" \
        --arg channel "${REAL_CHANNEL}" --arg user "${REAL_USER}" \
        '{name:$name,credentials_file:$creds,working_directory:$work,channels:[{id:$channel,delivery:"all"}],dm:{enabled:true,contact:$user},permission_prompts:"dm"}' >> "${REAL_PERSONAS}"
    jq -cn --arg token_label "${REAL_LABEL}" --arg user_id "${REAL_BOT_USER_ID}" --arg bot_id "${REAL_BOT_ID}" \
        '{suffix:$token_label,label:$token_label,user_id:$user_id,bot_id:$bot_id,auth:"ok",connections:"ok"}' >> "${REAL_TOKENS}"
    python3 - "${HOME}/.claude.json" "${REAL_WORK}" <<'PY'
import json,sys
p,work=sys.argv[1:]
d=json.load(open(p))
d['projects'][work]={'hasTrustDialogAccepted':True,'hasCompletedProjectOnboarding':True}
with open(p,'w') as f: json.dump(d,f)
PY
}

real_write_config() {
    local overrides="${1:-}"
    [[ -n "${overrides}" ]] || overrides='{}'
    jq -s --argjson port "${SCENARIO_PORT}" --argjson overrides "${overrides}" \
        '{personas:.,bind:"127.0.0.1",port:$port,health_check_interval:0,exit_timeout:5,stop_timeout:15,test_mcp_drop_endpoint:true} + $overrides' \
        "${REAL_PERSONAS}" | write_config
}

real_start_stub() {
    local dir="${SCENARIO_ROOT}/real-slack-stub"
    mkdir -p "${dir}"
    SCENARIO_SLACK_RECORD="${dir}/record.jsonl"
    jq -s '{tokens:.,default:{auth:"invalid_auth",connections:"invalid_auth"}}' "${REAL_TOKENS}" > "${dir}/control.json"
    bun "${SCENARIO_FIXTURES}/slack-stub-server.ts" --record "${SCENARIO_SLACK_RECORD}" \
        --control "${dir}/control.json" --ready-file "${dir}/ready.json" > "${dir}/out" 2>&1 &
    track_pid "$!"
    wait_for_file "${dir}/ready.json" 20 'real Slack stub never became ready'
    CSCB_SLACK_API_URL="$(jq -r .api_url "${dir}/ready.json")"
    export CSCB_SLACK_API_URL
    SCENARIO_SLACK_STUB_URL="${CSCB_SLACK_API_URL%/api/}"
}

real_fault() {
    [[ "$#" == 4 ]] || fail 'real_fault takes verb match action count'
    local file="${SCENARIO_AD_SHIM_LOG%.log}.faults"
    # Use the same stable lock inode as consumers, so adding a rule cannot
    # race a concurrent count decrement/atomic rename.
    { flock -x 8; printf '%s %s %s %s\n' "$@" >> "${file}"; } 8> "${file}.lock"
}

real_dm() {
    local label="$1" text="$2" ts="${3:-}" event
    if [[ -z "${ts}" ]]; then ts="$(date +%s.%6N)"; fi
    event="$(jq -cn --arg text "${text}" --arg ts "${ts}" --arg channel "D0${label^^}" \
        --arg user "U0${label^^}" '{type:"message",channel:$channel,channel_type:"im",user:$user,text:$text,ts:$ts}')"
    slack_stub_push "${label}" "${event}"
}

real_ad() {
    require_scenario_home real_ad
    "${SCENARIO_AD_ROOT}/bin/agent-director.real" "$@"
}
real_instance() { bun "${SCENARIO_FIXTURES}/fmk-texts.ts" personaInstanceId "$1"; }
real_wait_launch() {
    # Persona names need not equal their derived key: match by key alone.
    wait_until "${REAL_LAUNCH_WAIT_S}" "real persona $1 never launched/connected" _real_connected "$1"
    real_wait_idle "$1" "${REAL_LAUNCH_WAIT_S}"
}
_real_waiting() {
    local status
    status="$(real_ad status --instance-id "$(real_instance "$1")" 2>/dev/null)" || return 1
    jq -e '.state == "waiting"' <<< "${status}" >/dev/null
}
real_wait_idle() {
    local timeout="${2:-${REAL_DELIVERY_WAIT_S}}" status="${SCENARIO_ROOT}/real-idle-status.json"
    _scenario_check_timeout "${timeout}" real_wait_idle
    if _scenario_poll_until "${timeout}" _real_waiting "$1"; then return 0; fi
    real_ad status --instance-id "$(real_instance "$1")" > "${status}" 2>/dev/null || printf '{}\n' > "${status}"
    bun "${SCENARIO_FIXTURES}/real-observations.ts" "${status}" || echo 'recorded: AD state diagnostic unavailable'
    fail "real persona $1 never reached AD waiting (not within ${timeout}s)"
}
real_record_state() {
    local status="${SCENARIO_ROOT}/real-status.json"
    real_ad status --instance-id "$(real_instance "$1")" > "${status}"
    bun "${SCENARIO_FIXTURES}/real-observations.ts" "${status}" || fail 'cannot observe AD state'
}
_real_connected() {
    local status
    status="$(real_ad status --instance-id "$(real_instance "$1")" 2>/dev/null)" || return 1
    jq -e '.state == "waiting" or .state == "working"' <<< "${status}" >/dev/null || return 1
    grep -F 'Session connected: persona ' "${SLACK_STATE_DIR}/server.log" | grep -qF "(key=$1)"
}
real_wait_delivery() {
    _scenario_check_timeout "${REAL_DELIVERY_WAIT_S}" real_wait_delivery
    if _scenario_poll_until "${REAL_DELIVERY_WAIT_S}" \
        bun "${REAL_RECEIPTS}" ready "${SLACK_STATE_DIR}" "$1" "${SCENARIO_AD_SHIM_LOG}" "${HOME}/.claude/projects" "${2:-}" "${3:-}"; then return 0; fi
    # Capture while the live row, composer and receipt files still exist.
    # Diagnostics cannot turn the expired wait into success or replace FAIL.
    _real_delivery_diagnostic "$@" || echo 'recorded: delivery diagnostic unavailable'
    fail "real persona $1 has open/unconfirmed deliveries (not within ${REAL_DELIVERY_WAIT_S}s)"
}
_real_delivery_diagnostic() {
    local status="${SCENARIO_ROOT}/real-delivery-status.json"
    real_ad status --instance-id "$(real_instance "$1")" > "${status}" 2>/dev/null || printf '{}\n' > "${status}"
    bun "${REAL_RECEIPTS}" diagnostic "${SLACK_STATE_DIR}" "$1" "${SCENARIO_AD_SHIM_LOG}" "${HOME}/.claude/projects" "${2:-}" "${3:-}" "${status}" \
        || echo 'recorded: delivery receipt diagnostic unavailable'
    bun "${SCENARIO_FIXTURES}/real-observations.ts" "${status}" \
        || echo 'recorded: delivery AD diagnostic unavailable'
}
real_assert_no_retype() {
    bun "${REAL_RECEIPTS}" ready "${SLACK_STATE_DIR}" "$1" "${SCENARIO_AD_SHIM_LOG}" "${HOME}/.claude/projects" "${2:-}" no-retype \
        || fail 'real fidelity receipt audit found a retype'
}
real_assert_delivery() {
    bun "${REAL_RECEIPTS}" audit "${SLACK_STATE_DIR}" "$1" "${SCENARIO_AD_SHIM_LOG}" "${HOME}/.claude/projects" "${2:-}" "${3:-}" \
        || fail 'real receipt/order/in-flight audit failed'
}
real_assert_latency() {
    bun "${REAL_RECEIPTS}" latency "${SLACK_STATE_DIR}" "$1" "${SCENARIO_AD_SHIM_LOG}" "${HOME}/.claude/projects" "$2" \
        || fail 'real AC76 latency audit failed'
}
real_report() {
    [[ "${REAL_USAGE_REPORTED}" == 0 ]] || return 0
    REAL_USAGE_REPORTED=1
    bun "${REAL_RECEIPTS}" report "${SLACK_STATE_DIR}" "${SCENARIO_AD_SHIM_LOG}" "${HOME}/.claude/projects" "$@" \
        || return 1
}
real_finish() {
    assert_no_server_tmux
    assert_no_cscb_include_finished
    assert_no_cscb_delete
}
real_drop_mcp() {
    local status
    status="$(curl -sS --max-time 20 -o /dev/null -w '%{http_code}' -X POST -H 'Content-Type: application/json' \
        --data-binary "$(jq -cn --arg persona "$1" '{persona:$persona}')" "http://127.0.0.1:${SCENARIO_PORT}/test/drop-mcp")"
    [[ "${status}" == 200 ]] || fail "test MCP drop returned ${status}"
}
