#!/usr/bin/env bash
# Test 4: real AD fresh/resumed launches and an unanswered startup hold.
# The stub reports immediately for positive phases; CSCB never interprets its UI.
if [[ ! -e /etc/cscb-ci-image ]]; then
    echo "FAIL: test-4-resume-dialog: refused: /etc/cscb-ci-image is absent; this test runs only in a cscb-ci image (/ci)" >&2
    exit 1
fi

set -euo pipefail

TEST_NAME="test-4-resume-dialog"
PKG_DIR="/test-repo/node_modules/claude-slack-channel-bots"
FIXTURES="/tests/integration/fixtures"
DRIVER_LOG="/tmp/test-4-driver.log"
DRIVER_PERSONA="resume_test"
DRIVER_PERSONA_CHANNEL="C0RESUME1"
DRIVER_WORKING_DIRECTORY="/tmp/test-repo-resume"

fail() {
    echo "FAIL: ${TEST_NAME}: $1" >&2
    exit 1
}

# --- Prerequisites --------------------------------------------------------
command -v tmux >/dev/null 2>&1 \
    || fail "tmux not on PATH (image must include tmux — see docker/Dockerfile.test.base)"

command -v agent-director >/dev/null 2>&1 \
    || fail "agent-director not on PATH (Test 1 prerequisite / base image)"

test -d "${PKG_DIR}" \
    || fail "installed package not found at ${PKG_DIR} (Test 1 prerequisite)"

test -f "${FIXTURES}/stub-claude.sh" \
    || fail "stub-claude fixture missing at ${FIXTURES}/stub-claude.sh"

test -f "${FIXTURES}/driver.ts" \
    || fail "driver fixture missing at ${FIXTURES}/driver.ts"

# --- Stub `claude` on PATH (ahead of any real claude) ---------------------
STUB_BIN_DIR="/tmp/test-4-bin"
mkdir -p "${STUB_BIN_DIR}"
cp "${FIXTURES}/stub-claude.sh" "${STUB_BIN_DIR}/claude"
chmod +x "${STUB_BIN_DIR}/claude"
export PATH="${STUB_BIN_DIR}:${PATH}"

# The stub records each launch's argument list, one line per launch, in this
# file beside it; start from none so only this run's launches are read.
LAUNCH_ARGS_FILE="${STUB_BIN_DIR}/stub-claude-launch-args"
rm -f "${LAUNCH_ARGS_FILE}"

command -v claude >/dev/null 2>&1 \
    || fail "stub claude not resolvable on PATH after install"
[ "$(command -v claude)" = "${STUB_BIN_DIR}/claude" ] \
    || fail "PATH resolves claude to $(command -v claude), expected ${STUB_BIN_DIR}/claude"

# --- Persona working directory ---------------------------------------------
mkdir -p "${DRIVER_WORKING_DIRECTORY}"
printf 'at-once\t%s\n' "$(realpath -e -- "${DRIVER_WORKING_DIRECTORY}")" > "${STUB_BIN_DIR}/stub-claude-modes"
git -C "${DRIVER_WORKING_DIRECTORY}" init -q 2>/dev/null || true

# --- Run the driver (NON-dry-run: SLACK_DRY_RUN deliberately unset) --------
# Write driver errors to a private log
# shown on failure; keep stdout (DRIVER: markers) for the phase asserts.
set +e
CSCB_PKG_DIR="${PKG_DIR}" \
DRIVER_STUB_MODES_FILE="${STUB_BIN_DIR}/stub-claude-modes" \
DRIVER_PERSONA="${DRIVER_PERSONA}" \
DRIVER_PERSONA_CHANNEL="${DRIVER_PERSONA_CHANNEL}" \
DRIVER_WORKING_DIRECTORY="${DRIVER_WORKING_DIRECTORY}" \
    bun "${FIXTURES}/driver.ts" > /tmp/test-4-driver.out 2> "${DRIVER_LOG}"
DRIVER_RC=$?
set -e

DRIVER_OUT="$(cat /tmp/test-4-driver.out 2>/dev/null || true)"

# Surface driver output for debugging on failure.
if [ "${DRIVER_RC}" -ne 0 ]; then
    echo "--- driver stdout ---" >&2
    printf '%s\n' "${DRIVER_OUT}" >&2
    echo "--- driver stderr (tail) ---" >&2
    tail -n 40 "${DRIVER_LOG}" >&2 || true
    first_driver_fail="$(printf '%s\n' "${DRIVER_OUT}" | grep -m1 '^DRIVER_FAIL:' || true)"
    if [ -n "${first_driver_fail}" ]; then
        fail "driver reported ${first_driver_fail}"
    fi
    fail "driver exited ${DRIVER_RC} without an explicit DRIVER_FAIL line"
fi

# --- Assertions -----------------------------------------------------------

for phase in PHASE1_OK PRECONDITION_OK PHASE2_OK; do
    grep -q "^DRIVER: ${phase}" /tmp/test-4-driver.out || fail "missing AD lifecycle phase ${phase}"
done

# 4. Both launches carried `--system-prompt-snapshot off` (the template
#    installed from a config without `fresh_system_prompt`): the stub recorded
#    one line per launch, the fresh one then the resumed one (phase 2's
#    `resumed` result), and each holds the two words adjacent, in that order.
test -f "${LAUNCH_ARGS_FILE}" \
    || fail "launch arguments: the stub recorded no launch (${LAUNCH_ARGS_FILE} is absent)"
LAUNCH_COUNT="$(wc -l < "${LAUNCH_ARGS_FILE}")"
[ "${LAUNCH_COUNT}" -eq 3 ] \
    || fail "launch arguments: expected 3 recorded launches (fresh, resumed, unanswered startup hold), found ${LAUNCH_COUNT}: $(cat "${LAUNCH_ARGS_FILE}")"
launch_no=0
for launch_label in fresh resumed held-startup; do
    launch_no=$((launch_no + 1))
    launch_line="$(sed -n "${launch_no}p" "${LAUNCH_ARGS_FILE}")"
    [[ "${launch_line}" != *--dangerously-load-development-channels* && "${launch_line}" != *server:slack-channel-router* ]] \
        || fail "${launch_label}: launch carried channel arguments"
    [[ "$(grep -o -- '--append-system-prompt-file' <<< "${launch_line}" | wc -l)" == 1 ]] \
        || fail "${launch_label}: launch needs exactly one composed prompt path"
    printf '%s\n' "${launch_line}" | grep -Eq '(^| )--system-prompt-snapshot off( |$)' \
        || fail "launch arguments: the ${launch_label} launch lacks adjacent '--system-prompt-snapshot off': ${launch_line}"
done

printf '%s\n' "${DRIVER_OUT}" | grep -q '^DRIVER: STARTUP_HOLD_UNANSWERED_OK' \
    || fail "the startup hold was automatically answered"
echo "PASS: ${TEST_NAME}"
