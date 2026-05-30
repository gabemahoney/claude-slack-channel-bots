#!/usr/bin/env bash
# Sequential integration-test runner. Executes tests 1 → 2 → 3 in order,
# short-circuits on first FAIL, writes a single-line verdict to
# /test-results/verdict.txt: either "PASS" or "FAIL: <test>: <step>".
# Exits 0 on PASS, 1 on FAIL.
set -uo pipefail

TESTS_DIR="$(cd "$(dirname "$0")" && pwd)"
RESULTS_DIR="/test-results"
VERDICT_FILE="${RESULTS_DIR}/verdict.txt"

mkdir -p "${RESULTS_DIR}"

write_verdict() {
    # Strip newlines so verdict.txt is exactly one line.
    printf '%s' "$1" | tr -d '\n' > "${VERDICT_FILE}"
    printf '\n' >> "${VERDICT_FILE}"
}

TESTS=(
    "test-1-install-startup.sh"
    "test-2-dryrun-spawn-skip.sh"
    "test-3-cozempic-restart.sh"
)

for test_script in "${TESTS[@]}"; do
    path="${TESTS_DIR}/integration/${test_script}"
    echo "=== Running ${test_script} ==="

    if ! out=$(bash "${path}" 2>&1); then
        printf '%s\n' "${out}"
        # Pull the first "FAIL: ..." line emitted by the test; fall back to a
        # generic message if the script died without printing one.
        first_fail=$(printf '%s\n' "${out}" | grep -m1 '^FAIL:' || true)
        if [[ -z "${first_fail}" ]]; then
            first_fail="FAIL: ${test_script}: exited non-zero without explicit FAIL line"
        fi
        write_verdict "${first_fail}"
        echo "=== VERDICT: ${first_fail} ==="
        exit 1
    fi

    printf '%s\n' "${out}"
done

write_verdict "PASS"
echo "=== VERDICT: PASS ==="
exit 0
