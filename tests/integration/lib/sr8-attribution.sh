# Shared SR-8 failure retention. scenario.sh invokes on_failure after stopping
# the server (and draining its recorder), before deleting scenario scratch.
sr8_retain_failure_measurements() {
    bun "${SCENARIO_FIXTURES}/sr8-attribution.ts" "${TEST_NAME}" "${SCENARIO_ROOT}" \
        "/test-results" \
        "$(bun "${SCENARIO_FIXTURES}/fmk-texts.ts" THREAD_REPLY_HOLD_MS)"
}
on_failure sr8_retain_failure_measurements
