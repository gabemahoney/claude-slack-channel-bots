#!/usr/bin/env bash
# Shared image-only setup for the version-specific b.iy3 scenarios.
# Sourced only after scenario.sh has isolated HOME, state and the tmux socket.

displayed_exit_checks() {
    # Runs after processes stop, on success and failure, before scratch removal.
    # Only output/state surfaces: credentials.json is an intentional input.
    local files=() dir file n
    for dir in "${SLACK_STATE_DIR}" "${SCENARIO_ROOT}/slack-stub" "${SCENARIO_ROOT}/display-delivery"; do
        [[ -d "${dir}" ]] || continue
        while IFS= read -r file; do files+=("${file}"); done < <(find "${dir}" -type f -print)
    done
    while IFS= read -r file; do files+=("${file}"); done < <(
        find "${SCENARIO_ROOT}" -maxdepth 1 -type f \( -name '*.out' -o -name '*.err' \) -print
        find "${SCENARIO_BIN}" -maxdepth 1 -type f -name 'stub-claude-hooks.*' -print
    )
    files+=("${HOME}/.config/agent-director/ad-trail.jsonl" "${SCENARIO_AD_SHIM_LOG}"
        "${SCENARIO_TMUX_SHIM_LOG}" "${SCENARIO_CSCB_RECORD}")
    n="$(count_token_like "${files[@]}")"
    [[ "${n}" == 0 ]] || fail "displayed-state outputs contain ${n} token-like match(es)"
    if [[ -f "${SCENARIO_SLACK_RECORD:-}" ]]; then
        # Redacted stub values cannot prove the original arguments were clean.
        # A missing flag, like true, fails; diagnostics never print the record.
        jq -se 'all(.[]; .event != "api" or .args_token_like == false)' \
            "${SCENARIO_SLACK_RECORD}" > /dev/null 2>&1 \
            || fail "displayed-state Slack arguments leaked, lack leak metadata or have an invalid record"
    fi
    echo "recorded: displayed-state leak-check passed (scenario exit ${1:-0})"
    # Closing diagnostics from both the entrypoint and cleanup recheck are
    # *.err output above: release them only after the entire scan passes.
    if [[ -f "${SCENARIO_ROOT}/displayed-closing.err" ]]; then
        cat "${SCENARIO_ROOT}/displayed-closing.err" >&2
    fi
    # No driver diagnostic is released until the entire output scan passes.
    if [[ -f "${SCENARIO_ROOT}/displayed-driver.out" ]]; then
        cat "${SCENARIO_ROOT}/displayed-driver.out"
    fi
}

displayed_worker_ready() {
    require_ci_image "displayed-state waiting observation"
    require_scenario_home "displayed-state waiting observation"
    ad_capture get --instance-id "$1"
    (( AD_RC == 0 )) || fail "cannot read the actual scenario row"
    jq -e '.state == "waiting" and (.session_id | length > 0) and (.jsonl_path | length > 0)' "${AD_OUT}" > /dev/null
}

run_displayed_states() {
    require_ci_image "displayed-state scenario"
    require_scenario_home "displayed-state scenario"
    on_exit displayed_exit_checks
    # Capture raw shim records at their emission sites, so the assertions
    # keep their same-shell bookkeeping and the EXIT trap keeps its streams.
    # shellcheck disable=SC2034 # Read by scenario.sh's shim-log diagnostics.
    SCENARIO_SHIM_DIAGNOSTICS="${SCENARIO_ROOT}/displayed-closing.err"
    # The generic trap must not dump an unchecked server log after a leak
    # failure. Driver evidence is released by the checked exit hook instead.
    # shellcheck disable=SC2034 # Read by scenario.sh's EXIT trap.
    SCENARIO_LOG_TAIL_LINES=0
    local contract="$1" name key work channel label creds stub instance
    name="${SCENARIO_TAG}_displayed"
    key="$(persona_key "${name}")"
    instance="$(bun "${SCENARIO_FIXTURES}/fmk-texts.ts" personaInstanceId "${key}")"
    work="$(make_workdir displayed)"
    channel="C0${SCENARIO_TAG^^}DISPLAY"
    label="${SCENARIO_TAG}display"
    creds="${SCENARIO_ROOT}/credentials.json"
    stub="${SCENARIO_ROOT}/slack-stub"
    mkdir "${stub}"
    stub_mode "${work}" "${STUB_MODE_DISPLAYED_STATES}"
    write_ad_settings --state idle_screen_timeout_seconds=2 --state needs_intelligence_timeout_seconds=30
    check_ad_runtime "${SCENARIO_AD_BIN}.real" "${SCENARIO_INSTALLED_AD_RECORD}" "${contract}: selected runtime" \
        || fail "${contract}: selected runtime mismatch"
    # The default base remains current even when this HOME uses the legacy fixture.
    check_ad_runtime "${SCENARIO_RELEASE_BIN}" "${SCENARIO_RELEASE_RECORD}" "${contract}: default image runtime" \
        || fail "${contract}: default image runtime mismatch"
    jq -nc '{idle_screen_timeout_seconds:2,needs_intelligence_timeout_seconds:30}' \
        | sed 's/^/recorded: displayed-state-timeouts /'
    printf '{"bot_token":"%s","app_token":"%s"}\n' "$(fake_token bot "${label}")" "$(fake_token app "${label}")" \
        | write_file "${creds}" 600
    jq -nc --arg token_label "${label}" '{tokens:[{suffix:$token_label,label:$token_label,auth:"ok",connections:"ok"}],
        default:{auth:"invalid_auth",connections:"invalid_auth"}}' | write_file "${stub}/control.json"
    SCENARIO_SLACK_RECORD="${stub}/record.jsonl"
    bun "${SCENARIO_FIXTURES}/slack-stub-server.ts" --record "${SCENARIO_SLACK_RECORD}" \
        --control "${stub}/control.json" --ready-file "${stub}/ready.json" > "${stub}/out" 2>&1 &
    local stub_pid=$!
    track_pid "${stub_pid}"
    wait_for_file "${stub}/ready.json" 20 "displayed-state Slack stub not ready"
    CSCB_SLACK_API_URL="$(jq -r '.api_url' "${stub}/ready.json")"
    export CSCB_SLACK_API_URL
    [[ "${CSCB_SLACK_API_URL}" =~ ^http://127\.0\.0\.1:[0-9]+/api/$ ]] || fail "Slack stub is not loopback"
    jq -nc --arg name "${name}" --arg work "${work}" --arg channel "${channel}" --arg creds "${creds}" \
        --argjson port "${SCENARIO_PORT}" '{personas:[{name:$name,working_directory:$work,credentials_file:$creds,
          channels:[{id:$channel,delivery:"all"}],permission_prompts:$channel,dm:{enabled:false}}],
          bind:"127.0.0.1",port:$port,health_check_interval:0,exit_timeout:5}' | write_config
    start_server --live > "${SCENARIO_ROOT}/displayed-start.out" 2>&1
    wait_for_log "$(completion_match 1)" 150 "displayed-state persona startup did not complete"
    # Keep the actual bot, but stop the server so every driver leg owns a
    # fresh permission tracker and cannot borrow a server's earlier post.
    stop_server > "${SCENARIO_ROOT}/displayed-stop.out" 2>&1
    wait_until 30 "registered SessionStart did not provide waiting/session/transcript" displayed_worker_ready "${instance}"
    # Fake credentials travel only through the environment, never argv.
    local -x DISPLAY_BOT_TOKEN
    DISPLAY_BOT_TOKEN="$(fake_token bot "${label}")"
    local -x DISPLAY_PERSONA="${name}" DISPLAY_CHANNEL="${channel}" DISPLAY_WORK="${work}" DISPLAY_BIN="${SCENARIO_BIN}"
    local -x DISPLAY_RELEASE_RECORD="${SCENARIO_INSTALLED_AD_RECORD}" DISPLAY_SLACK_RECORD="${SCENARIO_SLACK_RECORD}"
    local -x DISPLAY_CAPTURE_FILE="${SCENARIO_ROOT}/displayed-captured.out"
    cscb_run bun "${SCENARIO_FIXTURES}/displayed-states.ts" "${contract}" \
        > "${SCENARIO_ROOT}/displayed-driver.out" 2>&1 \
        || fail "${contract}: real displayed-state consumer assertions"
    # Hooks have fallen back and the read loop is responsive; ordinary harness
    # teardown owns ending the tracked worker on the private socket.
    stop_tracked_pid "${stub_pid}" 10 "displayed-state Slack stub failed to stop"
}
