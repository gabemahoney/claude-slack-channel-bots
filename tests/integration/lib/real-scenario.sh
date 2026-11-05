#!/usr/bin/env bash
# Shared executable infrastructure, sourced AFTER scenario.sh (b.omv SR-14).
# Scenario scripts own their case inputs/assertions; this owns containment,
# native selection, onboarding, transport observations and exact receipts.
require_ci_image real-scenario
require_scenario_home real-scenario
source "${BASH_SOURCE[0]%/*}/real-failure.sh"
[[ "${TEST_NAME}" == *-fmk-real-* ]] || fail 'real-scenario requires a -fmk-real- script'
REAL_DELIVERY_WAIT_S=180
# Functional watchdogs: no exact workload receipt progress for 180s, or a
# bounded 30-minute batch overall. AC76 uses its separate unchanged audit.
REAL_DELIVERY_MAX_WAIT_S=1800
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
# Optional third argument selects an isolated work directory within this scenario.
real_persona() {
    REAL_NAME="$1"
    REAL_KEY="$(persona_key "${REAL_NAME}")"
    REAL_LABEL="${REAL_KEY//_/}"
    REAL_CHANNEL="C0${REAL_LABEL^^}"
    REAL_USER="U0${REAL_LABEL^^}"
    REAL_BOT_USER_ID="U0${REAL_LABEL^^}BOT"
    REAL_BOT_ID="B0${REAL_LABEL^^}"
    REAL_WORK="$(make_workdir "${3:-${REAL_KEY}}")"
    local creds="${SCENARIO_ROOT}/${REAL_KEY}.credentials.json"
    printf '%s\n' "${2:-Acknowledge every relayed channel message with exactly OK. Do not use tools unless the message explicitly requests one.}" > "${REAL_WORK}/CLAUDE.md"
    jq -n --arg bot "$(fake_token bot "${REAL_LABEL}")" --arg app "$(fake_token app "${REAL_LABEL}")" \
        '{bot_token:$bot,app_token:$app}' | write_file "${creds}" 600
    jq -cn --arg name "${REAL_NAME}" --arg creds "${creds}" --arg work "${REAL_WORK}" \
        --arg channel "${REAL_CHANNEL}" --arg user "${REAL_USER}" \
        '{name:$name,credentials_file:$creds,working_directory:$work,channels:[{id:$channel,delivery:"all"}],dm:{enabled:true,contact:$user},permission_prompts:"dm"}' >> "${REAL_PERSONAS}"
    jq -cn --arg token_label "${REAL_LABEL}" --arg user_id "${REAL_BOT_USER_ID}" --arg bot_id "${REAL_BOT_ID}" --arg channel "${REAL_CHANNEL}" \
        '{suffix:$token_label,label:$token_label,user_id:$user_id,bot_id:$bot_id,memberships:[$channel],auth:"ok",connections:"ok"}' >> "${REAL_TOKENS}"
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
    # A replacement also needs AD to report a new native session. A still-live
    # old row and a historical MCP connection do not finish its live-row sequence.
    wait_until "${REAL_LAUNCH_WAIT_S}" "real persona $1 never launched/connected" _real_connected "$1" "${2:-}" "${3:-0}"
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
_real_latency_admission() {
    bun "${REAL_RECEIPTS%/*}/ac76-admission.ts" admission "${SLACK_STATE_DIR}" "$1" \
        "${SCENARIO_AD_SHIM_LOG}" "${HOME}/.claude/projects" "$2" "${SCENARIO_ROOT}" \
        "${SCENARIO_AD_ROOT}/bin/agent-director.real" "${SCENARIO_ROOT}/relaunch-$1.json" "${REAL_CONNECTION_LINE_BASE}"
}
real_wait_latency_admission() {
    # Test32 only: unresolved prior candidates remain closed even when AD is
    # waiting. Poll evidence under a watchdog; elapsed time never grants entry.
    _scenario_check_timeout "${REAL_DELIVERY_WAIT_S}" real_wait_latency_admission
    if _scenario_poll_until "${REAL_DELIVERY_WAIT_S}" _real_latency_admission "$1" "$2"; then return 0; fi
    fail 'AC76 pre-sample admission timed out (see reason codes and counts)'
}
real_record_state() {
    local status="${SCENARIO_ROOT}/real-status.json"
    real_ad status --instance-id "$(real_instance "$1")" > "${status}"
    bun "${SCENARIO_FIXTURES}/real-observations.ts" "${status}" || fail 'cannot observe AD state'
}
_real_connected() {
    local status row instance
    status="$(real_ad status --instance-id "$(real_instance "$1")" 2>/dev/null)" || return 1
    jq -e '.state == "waiting" or .state == "working"' <<< "${status}" >/dev/null || return 1
    if [[ -n "${2:-}" ]]; then
        instance="$(real_instance "$1")"
        row="$(real_ad get --instance-id "${instance}" 2>/dev/null)" || return 1
        jq -e --arg instance "${instance}" --arg old_session "$2" \
            '.instance_id == $instance and (.state == "waiting" or .state == "working")
             and .labels.tag_prompt == "1" and (.session_id | type == "string" and length > 0)
             and .session_id != $old_session' <<< "${row}" >/dev/null || return 1
    fi
    # A resumed conversation keeps its session ID. Its new MCP connection
    # must still occur after the caller's post-stop log cursor.
    tail -n "+$((${3:-0}+1))" "${SLACK_STATE_DIR}/server.log" \
        | grep -F 'Session connected: persona ' | grep -qF "(key=$1)"
}
# real_wait_delivery <key> [count] [mode] [-- <case assertion...>]
real_wait_delivery() {
    _scenario_check_timeout "${REAL_DELIVERY_WAIT_S}" real_wait_delivery
    _scenario_check_timeout "${REAL_DELIVERY_MAX_WAIT_S}" real_wait_delivery
    # A case assertion re-reads newer evidence than the ready audit, which can
    # hold work accepted since (a reply reminder). It completes this wait only
    # when it passes too; its receipts-pending exit keeps polling under the
    # same watchdogs, and any other failure is the case's own verdict.
    # Must equal RECEIPTS_PENDING_EXIT in fixtures/real-case-assertions.ts.
    local -r receipts_pending=75
    local -a wait=() assertion=()
    while (( $# )) && [[ "$1" != -- ]]; do wait+=("$1"); shift; done
    if (( $# )); then shift; assertion=("$@"); fi
    set -- "${wait[@]}"
    local started last_progress now progress most=0 reason status
    started="$(_scenario_now_ms)"
    last_progress="${started}"
    while :; do
        # Progress never substitutes for the complete receipt/FIFO audit.
        if bun "${REAL_RECEIPTS}" ready "${SLACK_STATE_DIR}" "$1" "${SCENARIO_AD_SHIM_LOG}" "${HOME}/.claude/projects" "${2:-}" "${3:-}"; then
            (( ${#assertion[@]} )) || return 0
            status=0
            "${assertion[@]}" || status=$?
            if (( status == 0 )); then return 0; fi
            if (( status != receipts_pending )); then return "${status}"; fi
        fi
        now="$(_scenario_now_ms)"
        if (( now - started >= REAL_DELIVERY_MAX_WAIT_S * 1000 )); then reason=overall; break; fi
        progress="$(bun "${REAL_RECEIPTS}" progress "${SLACK_STATE_DIR}" "$1" "${SCENARIO_AD_SHIM_LOG}" "${HOME}/.claude/projects" "${2:-}" "${3:-}")" || progress=''
        if [[ "${progress}" =~ ^[0-9]+$ ]] && (( progress > most )); then
            most="${progress}"
            last_progress="${now}"
        fi
        if (( now - last_progress >= REAL_DELIVERY_WAIT_S * 1000 )); then reason=no-progress; break; fi
        sleep "${SCENARIO_POLL_S}"
    done
    # Capture only structured state/receipt diagnostics before cleanup.
    _real_delivery_diagnostic "$@" || echo 'recorded: delivery diagnostic unavailable'
    fail "real persona $1 has open/unconfirmed deliveries (${reason} watchdog; receipts=${most}; idle bound=${REAL_DELIVERY_WAIT_S}s; overall bound=${REAL_DELIVERY_MAX_WAIT_S}s)"
}
_real_delivery_diagnostic() {
    local status="${SCENARIO_ROOT}/real-delivery-status.json"
    real_ad status --instance-id "$(real_instance "$1")" > "${status}" 2>/dev/null || printf '{}\n' > "${status}"
    bun "${REAL_RECEIPTS}" diagnostic "${SLACK_STATE_DIR}" "$1" "${SCENARIO_AD_SHIM_LOG}" "${HOME}/.claude/projects" "${2:-}" "${3:-}" "${status}" \
        || echo 'recorded: delivery receipt diagnostic unavailable'
    bun "${SCENARIO_FIXTURES}/real-observations.ts" "${status}" \
        || echo 'recorded: delivery AD diagnostic unavailable'
}
real_assert_latency() {
    bun "${REAL_RECEIPTS}" latency "${SLACK_STATE_DIR}" "$1" "${SCENARIO_AD_SHIM_LOG}" "${HOME}/.claude/projects" "$2" \
        || fail 'real AC76 latency audit failed'
}
# SR-8 uses a fresh state directory: seed before its first server start. Keep
# the DM phase's journals for once-only usage/duplicate accounting on EXIT.
# Two population personas: alpha is measured; beta's channel takes the
# concurrent writes, through its own MCP session in open and its own live
# leave and rejoin events in strict, without replacing alpha's connection.
REAL_THREAD_LOOKUP_DELAY_MS=500
REAL_PRIOR_STATES=()
real_thread_personas() {
    require_scenario_home real_thread_personas
    local instruction config compact key
    instruction="$(cat "${REAL_WORK}/CLAUDE.md")"
    REAL_THREAD_MODE="$1"
    [[ "${REAL_THREAD_MODE}" == strict || "${REAL_THREAD_MODE}" == open ]] || fail 'invalid thread mode'
    REAL_PRIOR_STATES+=("${SLACK_STATE_DIR}")
    export SLACK_STATE_DIR="${SCENARIO_ROOT}/thread-${REAL_THREAD_MODE}-state"
    REAL_THREAD_EVIDENCE="${SCENARIO_ROOT}/thread-${REAL_THREAD_MODE}-evidence"
    mkdir -p "${SLACK_STATE_DIR}" "${REAL_THREAD_EVIDENCE}"
    REAL_SR8="${SCENARIO_FIXTURES}/sr8-evidence.ts"
    REAL_THREAD_CONTEXT=("${TEST_NAME}" "${REAL_THREAD_MODE}" 100000 2)
    compact="$(bun "${SCENARIO_FIXTURES}/fmk-texts.ts" QUEUE_COMPACT_INTERVAL_MS)"
    OVERRIDES_LINE="$(bun "${SCENARIO_FIXTURES}/fmk-texts.ts" buildTestTimerOverridesLine "queue_compact_interval_ms=${compact}")"
    OVERRIDES_STEM="$(overrides_stem "${OVERRIDES_LINE}")"
    config="${REAL_THREAD_EVIDENCE}/population-config.json"
    bun "${REAL_SR8}" config "${REAL_THREAD_MODE}" 100000 2 "${SCENARIO_ROOT}" "${SCENARIO_PORT}" "${compact}" > "${config}"
    # Read names from the population configuration; no second population recipe.
    while IFS= read -r key; do real_persona "${key}" "${instruction}" "thread-${REAL_THREAD_MODE}-${key}"; done < <(jq -r '.personas[].name' "${config}")
    REAL_WRITER_NAME="${REAL_NAME}"
    REAL_WRITER_KEY="${REAL_KEY}"
    REAL_WRITER_LABEL="${REAL_LABEL}"
    REAL_WRITER_WORK="${REAL_WORK}"
    jq --slurpfile real "${REAL_PERSONAS}" '
      .personas |= map(. as $p | ($real | map(select(.name == $p.name)) | last) as $r |
        . + {credentials_file:$r.credentials_file,working_directory:$r.working_directory,dm:$r.dm,permission_prompts:$r.permission_prompts}) |
      . + {session_restart_delay:0,exit_timeout:5,stop_timeout:15,test_mcp_drop_endpoint:true}' "${config}" | write_config
    REAL_NAME="$(jq -r '.personas[0].name' "${config}")"
    REAL_KEY="$(persona_key "${REAL_NAME}")"
    REAL_LABEL="${REAL_KEY}"
    REAL_WORK="$(jq -r '.personas[0].working_directory' "${SLACK_STATE_DIR}/config.json")"
    REAL_CHANNEL="$(jq -r '.personas[0].channels[0].id' "${config}")"
    REAL_MEMBER_CHANNEL="$(jq -r '.personas[0].channels | map(select(.delivery=="off"))[0].id' "${config}")"
    REAL_WRITE_CHANNEL="$(jq -r '.personas[0].channels | map(select(.delivery=="off"))[1].id' "${config}")"
    # Beta's inventory is its configured channel list, in config order.
    mapfile -t REAL_WRITER_CHANNELS < <(jq -r --arg n "${REAL_WRITER_NAME}" '.personas[] | select(.name==$n) | .channels[].id' "${SLACK_STATE_DIR}/config.json")
    jq -e --arg n "${REAL_WRITER_NAME}" --arg c "${REAL_WRITE_CHANNEL}" 'any(.personas[] | select(.name==$n) | .channels[]; .id==$c)' \
        "${SLACK_STATE_DIR}/config.json" > /dev/null || fail 'beta does not hold the write channel'
    jq -s --slurpfile config "${SLACK_STATE_DIR}/config.json" '
      {tokens:map(. as $t | ($config[0].personas | map(select(.name==$t.label)) | first) as $p |
        if $p then .memberships=[$p.channels[].id] else . end) | unique_by(.label),default:{auth:"invalid_auth",connections:"invalid_auth"}}' \
        "${REAL_TOKENS}" > "${REAL_THREAD_EVIDENCE}/stub-control.json"
    slack_stub_controls "${REAL_THREAD_EVIDENCE}/stub-control.json"
    REAL_BOT_USER_ID="$(slack_stub_identity "${REAL_LABEL}" user_id)"
}
real_seed_threads() {
    require_scenario_home real_seed_threads
    [[ -z "$(server_pid)" ]] || fail 'thread population must be seeded before start'
    bun "${REAL_SR8}" seed "${SLACK_STATE_DIR}/config.json" "${SLACK_STATE_DIR}" 100000
}
real_thread_now_ms() { python3 -c 'import time; print(time.monotonic_ns() / 1000000)'; }
# Operation endpoints share the durable queue's Unix epoch clock, not the
# startup duration's monotonic clock.
real_thread_epoch_ms() { python3 -c 'import time; print(time.time_ns() / 1000000)'; }
# Build every sample and write argument before admitting any sample.
# IDs come from f6's shared builder, including two previously unused senders.
# Membership events are built by their workers instead: production ignores a
# live event older than its persona's last rescan, which each push starts.
real_thread_workload() {
    require_scenario_home real_thread_workload
    local n ts sender text args delivery
    REAL_THREAD_ROOT="$(scenario_ts)"
    text="$(scenario_mention_text "${REAL_BOT_USER_ID}" "$(scenario_text thread-root)")"
    slack_mention_event "${REAL_CHANNEL}" "${text}" "${REAL_THREAD_ROOT}" > "${REAL_THREAD_EVIDENCE}/root.json"
    REAL_THREAD_SAMPLES=()
    REAL_THREAD_DELAYED_USER="$(scenario_id U "thread-${REAL_THREAD_MODE}-delayed-sender")"
    REAL_THREAD_HUNG_USER="$(scenario_id U "thread-${REAL_THREAD_MODE}-hung-sender")"
    REAL_THREAD_WRITE_TOOL="$(bun "${SCENARIO_FIXTURES}/fmk-texts.ts" SET_CHANNEL_DELIVERY_TOOL)"
    for ((n=1; n<=20; n++)); do
        ts="$(scenario_ts)"; sender="$(scenario_id U human)"
        if (( n == 7 )); then sender="${REAL_THREAD_DELAYED_USER}"; REAL_THREAD_DELAYED_TS="${ts}"; fi
        if (( n == 14 )); then sender="${REAL_THREAD_HUNG_USER}"; REAL_THREAD_HUNG_TS="${ts}"; fi
        REAL_THREAD_SAMPLES+=("${ts}")
        text="$(scenario_text "thread-latency-${n}")"
        slack_reply_event "${REAL_CHANNEL}" "${REAL_THREAD_ROOT}" "${text}" "${ts}" "${sender}" > "${REAL_THREAD_EVIDENCE}/sample-${n}.json"
        if (( n % 2 )); then delivery=all; else delivery=off; fi
        args="$(attempt_args "$(scenario_attempt_id "thread-${REAL_THREAD_MODE}-write-${n}")" "${REAL_WRITE_CHANNEL}" "${delivery}")"
        printf '%s\n' "${args}" > "${REAL_THREAD_EVIDENCE}/write-${n}.json"
    done
}
real_thread_root() {
    slack_stub_push "${REAL_LABEL}" "$(cat "${REAL_THREAD_EVIDENCE}/root.json")"
}
real_thread_reply() {
    slack_stub_push "${REAL_LABEL}" "$(cat "${REAL_THREAD_EVIDENCE}/sample-$1.json")"
}
real_thread_writer_start() {
    require_scenario_home real_thread_writer_start
    write_mcp_config "${SCENARIO_PORT}"
    bun "${SCENARIO_STUB_DIR}/stub-mcp-session.ts" "${HOME}/.claude/slack-mcp.json" "${REAL_WRITER_WORK}" > "${REAL_THREAD_EVIDENCE}/writer.log" 2>&1 &
    REAL_THREAD_WRITER_PID="$!"
    track_pid "${REAL_THREAD_WRITER_PID}"
    wait_until 30 'thread writer session never connected' _real_thread_writer_connected
}
_real_thread_writer_connected() {
    stub_session_sessions "${REAL_WRITER_WORK}" | jq -se 'any(.[]; .event=="connected")' > /dev/null
}
# Both personas' production-parsed facts, as files: the shared lists exceed
# a safe single argument. The live membership channel is alpha's concurrent
# event target and the write channel beta's; every other assignment and
# leave, and both incarnations, must hold.
_real_thread_write_facts() {
    shared_persona_facts "${REAL_KEY}" > "$1.alpha.json" || return 1
    shared_persona_facts "${REAL_WRITER_KEY}" > "$1.beta.json" || return 1
    jq -cn --slurpfile a "$1.alpha.json" --slurpfile b "$1.beta.json" \
        --arg member "${REAL_MEMBER_CHANNEL}" --arg write "${REAL_WRITE_CHANNEL}" '
      {written:($b[0].assignments[$write] // null), leave:($b[0].leaves[$write] // null),
       membership:($b[0].historicalMembership[$write] // null | if . then {member,boundary} else null end),
       unrelated:[$a[0].incarnation, ($a[0].assignments|del(.[$member])), ($a[0].leaves|del(.[$member])),
         $b[0].incarnation, ($b[0].assignments|del(.[$write])), ($b[0].leaves|del(.[$write]))]}' > "$1"
}
real_thread_concurrent_work() {
    local n="$1" membership=channel_left envelope args delivery event event_id attempt_id start end line expected
    (( n % 2 )) || membership=member_joined_channel
    slack_membership_event "${membership}" "${REAL_LABEL}" "${REAL_MEMBER_CHANNEL}" "$(scenario_ts)" > "${REAL_THREAD_EVIDENCE}/membership-${n}.json"
    event="$(cat "${REAL_THREAD_EVIDENCE}/membership-${n}.json")"
    event_id="$(jq -r .event_ts <<< "${event}")"
    args="$(cat "${REAL_THREAD_EVIDENCE}/write-${n}.json")"
    delivery="$(jq -r .delivery <<< "${args}")"
    attempt_id="$(jq -r .attempt_id <<< "${args}")"
    start="$(real_thread_epoch_ms)"
    envelope="$(slack_stub_push "${REAL_LABEL}" "${event}")"
    slack_wait_one_ack "${envelope}"
    end="$(real_thread_epoch_ms)"
    printf 'membership\t%s\t%s\t%s\n' "${event_id}" "${start}" "${end}" >> "${REAL_THREAD_EVIDENCE}/operations.tsv"
    if [[ "${REAL_THREAD_MODE}" == strict ]]; then
        real_thread_membership_write "${n}"
        return
    fi
    start="$(real_thread_epoch_ms)"
    line="$(stub_session_call "${REAL_WRITER_WORK}" "${REAL_THREAD_WRITE_TOOL}" "${args}")" || exit 1
    end="$(real_thread_epoch_ms)"
    # Preserve expect_attempt's exact retained-result check, outside timing.
    jq -e 'has("error")|not' <<< "${line}" >/dev/null || fail "thread-write-${n}: no tool result"
    expected="$(bun "${SCENARIO_FIXTURES}/fmk-texts.ts" channelDeliveryAttemptResultText \
        "${SLACK_STATE_DIR}/config.json" "${SLACK_STATE_DIR}/config.json.last-applied" "${REAL_WRITER_KEY}" \
        "${REAL_WRITE_CHANNEL}" "${delivery}" "${attempt_id}" new "${delivery}")" || fail 'cannot read durable thread write result'
    [[ "$(jq -r .isError <<< "${line}")" == false && "$(jq -r .text <<< "${line}")" == "${expected}" ]] \
        || fail "thread-write-${n}: tool result differs from retained outcome/current facts"
    printf 'write\t%s\t%s\t%s\n' "${attempt_id}" "${start}" "${end}" >> "${REAL_THREAD_EVIDENCE}/operations.tsv"
}
# Strict refuses bot assignments (t1.tad.5i SR-2.3), so beta's per-sample
# write is its own live leave (odd samples) or rejoin (even) of the write
# channel: one event, acknowledged only once durable. Beta's inventory is
# staged to agree first, without a control replacement, and the event's scan
# settles before the facts are read. The event is built after staging, so its
# timestamp follows the previous write's settled rescan. The leave must be this
# event's, never a scan's, and the rejoin a fresh default at a later order
# applied by its event.
real_thread_membership_write() {
    local n="$1" kind=leave membership=channel_left id="thread-strict-write-$1" facts event ids envelope event_id start end applied channel
    local -a staged=()
    (( n % 2 )) || { kind=join; membership=member_joined_channel; }
    facts="${REAL_THREAD_EVIDENCE}/${id}"
    for channel in "${REAL_WRITER_CHANNELS[@]}"; do
        if [[ "${kind}" == join || "${channel}" != "${REAL_WRITE_CHANNEL}" ]]; then staged+=("${channel}"); fi
    done
    _real_thread_write_facts "${facts}.before" || fail "${id}: cannot read shared facts"
    slack_stub_inventory_stage "${REAL_WRITER_LABEL}" memberships "${staged[@]}" > "${facts}.stage"
    slack_membership_event "${membership}" "${REAL_WRITER_LABEL}" "${REAL_WRITE_CHANNEL}" "$(scenario_ts)" > "${REAL_THREAD_EVIDENCE}/beta-membership-${n}.json"
    event="$(cat "${REAL_THREAD_EVIDENCE}/beta-membership-${n}.json")"
    start="$(real_thread_epoch_ms)"
    ids="$(slack_push_event_ids "${REAL_WRITER_LABEL}" "${event}")"
    slack_wait_one_ack "${ids%%$'\t'*}"
    end="$(real_thread_epoch_ms)"
    IFS=$'\t' read -r envelope event_id <<< "${ids}"
    wait_membership_rescan "${REAL_WRITER_KEY}" "${REAL_WRITER_LABEL}" "$(slack_stub_record_field seq push "envelope_id=${envelope}")"
    _real_thread_write_facts "${facts}.after" || fail "${id}: cannot read shared facts"
    applied="$(shared_membership_event "${REAL_WRITER_KEY}" "${event_id}")" || fail "${id}: cannot read the applied event"
    jq -en --slurpfile before "${facts}.before" --slurpfile after "${facts}.after" --argjson applied "${applied}" \
        --arg kind "${kind}" --arg event "${event_id}" --arg channel "${REAL_WRITE_CHANNEL}" '
      $before[0] as $b | $after[0] as $a | $a.unrelated == $b.unrelated and $b.membership.member == ($kind == "leave") and
      if $kind == "leave" then
        $a.written == null and ($event | startswith("scan:") | not) and $a.leave.event == $event
        and ($a.leave.boundary | type) == "number" and $a.leave.boundary > ([$b.written.order // 0, $b.leave.boundary // 0] | max)
        and $a.membership == {member:false,boundary:$a.leave.boundary}
        and $applied == {channel:$channel,member:false,order:$a.leave.boundary,boundary:$a.leave.boundary}
      else
        $b.written == null and ($a.written.order | type) == "number" and $a.written == {delivery:"off",order:$a.written.order}
        and $a.written.order > ($b.leave.boundary // 0) and $a.leave == $b.leave
        and $a.membership == {member:true,boundary:$a.written.order}
        and $applied == {channel:$channel,member:true,order:$a.written.order,boundary:$a.written.order}
      end
    ' > /dev/null || fail "${id}: ${kind} was not applied by its own event in order, or changed unrelated state"
    printf 'write\t%s\t%s\t%s\n' "${event_id}" "${start}" "${end}" >> "${REAL_THREAD_EVIDENCE}/operations.tsv"
}
real_assert_thread_latency() {
    bun "${REAL_RECEIPTS}" thread-latency "${SLACK_STATE_DIR}" "${REAL_KEY}" "${SCENARIO_AD_SHIM_LOG}" "${HOME}/.claude/projects" \
        "${TEST_NAME}" "${REAL_THREAD_MODE}" "${REAL_CHANNEL}" "${REAL_THREAD_DELAYED_TS}" "${REAL_THREAD_HUNG_TS}" "${REAL_THREAD_SAMPLES[@]}"
}
real_report() {
    [[ "${REAL_USAGE_REPORTED}" == 0 ]] || return 0
    REAL_USAGE_REPORTED=1
    if (( ${#REAL_PRIOR_STATES[@]} )); then
        bun "${REAL_RECEIPTS}" report-states "${SLACK_STATE_DIR}" "${SCENARIO_AD_SHIM_LOG}" "${HOME}/.claude/projects" "${REAL_PRIOR_STATES[@]}"
        return "$?"
    fi
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
