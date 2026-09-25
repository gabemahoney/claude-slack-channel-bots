#!/usr/bin/env bash
# Test 8 (t3.ob2.5e.u7.k3; E11/E12): the confirmed reload, in dry run.
#
# A running server with two personas:
# 1. Apply. An in-place edit of config.json (a channel added to one persona)
#    is previewed: config.json.pending appears holding a preview that names
#    that persona, each of its preview lines is logged as a `reload-preview`
#    line, and for a full tick interval nothing is applied
#    (config.json.last-applied keeps the start's bytes). Renaming the pending
#    file to config.json.apply confirms it: the server deletes .apply, logs
#    `reload-applied`, the record now holds the configuration file's bytes,
#    and the pending file is removed.
# 2. Stale confirmation. A second edit is previewed and its pending file set
#    aside; config.json is edited again, and once the server's fresh pending
#    file for that newest edit is written, the second edit's preview is
#    renamed into place as config.json.apply. The server logs
#    `reload-stale-confirmation`, applies nothing, and keeps a pending file
#    for the newest edit, which is then confirmed and applied.
#
# Lines are matched by class prefix, persona ref and distinguishing fragments
# (E14 decision 14; lib/scenario.sh "Matchers"), each quoted from src/: the
# reload file names (src/reload.ts reloadFilePaths), the pending file's
# layout (src/reload-fingerprint.ts composePendingFile), the preview lines
# (src/reload-plan.ts renderPreviewLines, renderPreviewLogLines), the apply
# and stale lines (src/reload-apply.ts renderAppliedLogLine,
# renderStaleConfirmationLogLine) and the in-place update line
# (src/persona-lifecycle.ts runUpdateInPlace). The persona lines of a preview
# are not retyped: the log is checked against the pending file's own lines.
#
# The detection tick runs 5 s after the previous pass (src/reload-timer.ts
# RELOAD_TICK_INTERVAL_MS, not overridable), so each wait below is bounded by
# a few tick intervals. Runs in its own state dir and port (the shared
# helper); the helper's EXIT trap stops the server and removes the scratch
# root. Expected runtime: about 45 s.
set -euo pipefail

TEST_NAME="test-8-reload-confirm"
# shellcheck source=lib/scenario.sh
source "$(dirname "$0")/lib/scenario.sh"

# Bound on one change showing up: the first pass runs 5 s after the start
# bring-up pass returns, and each later pass 5 s after the previous one ends.
TICK_WAIT_S=30

# How long an unconfirmed edit is watched for an apply: more than one full
# tick interval after its preview was written.
HOLD_S=7

CONFIG="${SLACK_STATE_DIR}/config.json"
PENDING="${CONFIG}.pending"
APPLY="${CONFIG}.apply"
LAST="${CONFIG}.last-applied"

ALPHA="${SCENARIO_TAG}_alpha"
BRAVO="${SCENARIO_TAG}_bravo"

CH_TAG="${SCENARIO_TAG^^}"
A1="C0${CH_TAG}A1"
A2="C0${CH_TAG}A2"
B1="C0${CH_TAG}B1"

ALPHA_DIR="$(make_workdir alpha)"
BRAVO_DIR="$(make_workdir bravo)"

# --- Expected text (fragments quoted from src/, see the header) -----------
PREVIEW='[slack] reload-preview: '
APPLIED_CLASS='[slack] reload-applied:'
STALE_CLASS='[slack] reload-stale-confirmation:'
NOTHING_PENDING='[slack] reload-nothing-pending:'

# A persona's preview line (in the pending file; its log line is the same
# with the reload-preview class in front): the persona, then the changed
# setting, then the in-place effect (src/reload-plan.ts modifiedLine).
in_place_body() {
    local ref
    ref="$(persona_ref "$1")" || exit 1
    matcher "persona ${ref}:" " $2 changed" 'applied in place'
}

# A persona's in-place update line for exactly the settings given
# (src/persona-lifecycle.ts runUpdateInPlace: `updated in place (<settings>)`).
updated_in_place_match() {
    local ref
    ref="$(persona_ref "$1")" || exit 1
    matcher "[slack] persona ${ref}:" "updated in place ($2)"
}

# The preview header's log line for the counts given, pointing at the
# pending file (src/reload-plan.ts previewFileSuffix).
preview_logged_header() {
    local m
    m="$(preview_header_match "$@")" || exit 1
    matcher "${m}" "\"${PENDING}\""
}

ALPHA_CHANNELS_BODY="$(in_place_body "${ALPHA}" channels)"
ALPHA_DELIVERY_BODY="$(in_place_body "${ALPHA}" delivery)"
BRAVO_DELIVERY_BODY="$(in_place_body "${BRAVO}" delivery)"
ALPHA_UPDATED_CHANNELS="$(updated_in_place_match "${ALPHA}" channels)"
ALPHA_UPDATED_DELIVERY="$(updated_in_place_match "${ALPHA}" delivery)"
BRAVO_UPDATED_DELIVERY="$(updated_in_place_match "${BRAVO}" delivery)"
# The mismatch reason (src/reload-apply.ts renderStaleConfirmationLogLine).
STALE_MATCH="$(matcher "${STALE_CLASS}" "\"${APPLY}\"" 'does not match')"
APPLIED_1="$(applied_match in_place=1)"
APPLIED_2="$(applied_match in_place=2)"
HEADER_1="$(preview_logged_header in_place=1)"
HEADER_2="$(preview_logged_header in_place=2)"

# --- Helpers ---------------------------------------------------------------

# The two-persona config. $1: alpha's channel list (JSON array body);
# $2: bravo's channel delivery.
emit_config() {
    cat << EOF
{
  "personas": [
    {
      "name": "${ALPHA}",
      "credentials_file": "${SCENARIO_ROOT}/credentials-alpha.json",
      "working_directory": "${ALPHA_DIR}",
      "channels": [$1],
      "permission_prompts": "${A1}"
    },
    {
      "name": "${BRAVO}",
      "credentials_file": "${SCENARIO_ROOT}/credentials-bravo.json",
      "working_directory": "${BRAVO_DIR}",
      "channels": [{ "id": "${B1}", "delivery": "$2" }],
      "permission_prompts": "${B1}"
    }
  ],
  "bind": "127.0.0.1",
  "port": ${SCENARIO_PORT}
}
EOF
}

# Config versions: v0 at start; v1 adds a channel to alpha; v2 switches that
# channel to mentions; v3 is v2 with bravo's channel switched to mentions.
V0_ALPHA="{ \"id\": \"${A1}\", \"delivery\": \"all\" }"
V1_ALPHA="${V0_ALPHA}, { \"id\": \"${A2}\", \"delivery\": \"all\" }"
V2_ALPHA="${V0_ALPHA}, { \"id\": \"${A2}\", \"delivery\": \"mentions\" }"

same_bytes() {
    cmp -s -- "$1" "$2"
}

# The pending file's fingerprint line (empty when absent or malformed).
fingerprint_of() {
    [[ -f "$1" ]] || return 0
    sed -n '2p' "$1" 2> /dev/null || true
}

# A pending file for the newest edit: names bravo's change and carries a
# fingerprint other than the (to be) stale confirmation's.
fresh_pending_for_v3() {
    pending_has_line "${BRAVO_DELIVERY_BODY}" \
        && [[ "$(fingerprint_of "${PENDING}")" != "${STALE_FINGERPRINT}" ]]
}

# True when every preview line of the pending-file copy <file> (line 4 on:
# after the header, the fingerprint and a blank line) is in server.log as
# `[slack] reload-preview: <line>` (the header's log line goes on with the
# pending file's path, which the unanchored match allows).
preview_logged() {
    local file="$1" line n=0
    while IFS= read -r line; do
        n=$(( n + 1 ))
        (( $(count_log "${PREVIEW}${line}") > 0 )) || return 1
    done < <(tail -n +4 -- "${file}")
    (( n > 0 ))
}

# Copy the pending file (so every check reads one version of it) and wait
# until each of its preview lines was logged.
expect_preview_logged() {
    local step="$1" copy="${SCENARIO_ROOT}/pending.$2"
    [[ -f "${PENDING}" ]] || fail "${step}: ${PENDING} is missing"
    cp -- "${PENDING}" "${copy}" || fail "${step}: could not copy ${PENDING}"
    wait_until 10 "${step}: the pending file's preview lines were not all logged as reload-preview lines" \
        preview_logged "${copy}"
}

no_alpha_channels_update() {
    (( $(count_log "${ALPHA_UPDATED_CHANNELS}") == 0 ))
}

# --- Start ----------------------------------------------------------------
emit_config "${V0_ALPHA}" all | write_config
V0_COPY="${SCENARIO_ROOT}/config.v0.json"
cp -- "${CONFIG}" "${V0_COPY}"

# shellcheck disable=SC2119 # dry-run start: no --live
start_server
wait_for_file "${LAST}" "${TICK_WAIT_S}" "start never wrote config.json.last-applied"
same_bytes "${CONFIG}" "${LAST}" || fail "start: config.json.last-applied does not hold config.json's bytes"
[[ ! -e "${PENDING}" ]] || fail "start: config.json.pending exists with no edit made"

# --- 1. Apply: preview, hold, confirm ------------------------------------
emit_config "${V1_ALPHA}" all | write_config

wait_for_file "${PENDING}" "${TICK_WAIT_S}" "edit 1: config.json.pending never appeared"
wait_until 10 "edit 1: config.json.pending never named persona ${ALPHA}'s channels change" \
    pending_has_line "${ALPHA_CHANNELS_BODY}"
check_pending_layout "edit 1" in_place=1
wait_for_log "${HEADER_1}" 10 "edit 1: reload-preview header not logged"
expect_preview_logged "edit 1" edit1
same_bytes "${V0_COPY}" "${LAST}" || fail "edit 1: config.json.last-applied changed before a confirmation"

# An unconfirmed edit never applies: watch a full tick interval (the record
# keeps its bytes, no reload-applied line, alpha is not updated in place).
hold_not_applied "${HOLD_S}" "edit 1 unconfirmed" no_alpha_channels_update

mv -f -- "${PENDING}" "${APPLY}"

wait_for_log "${APPLIED_1}" "${TICK_WAIT_S}" "confirm 1: reload-applied not logged"
[[ ! -e "${APPLY}" ]] || fail "confirm 1: config.json.apply still present after the apply"
same_bytes "${CONFIG}" "${LAST}" || fail "confirm 1: config.json.last-applied does not hold the confirmed config.json"
wait_for_log "${ALPHA_UPDATED_CHANNELS}" 10 "confirm 1: persona ${ALPHA} not updated in place"
# The same pass removes the pending file (nothing is pending any more) and,
# having applied, logs no reload-nothing-pending line.
wait_until 10 "confirm 1: config.json.pending not removed after the apply" test ! -e "${PENDING}"
expect_count "${NOTHING_PENDING}" 0 "confirm 1: reload-nothing-pending logged after an apply"
expect_count "${APPLIED_CLASS}" 1 "confirm 1: reload-applied lines"
V1_COPY="${SCENARIO_ROOT}/config.v1.json"
cp -- "${CONFIG}" "${V1_COPY}"

# --- 2. Stale confirmation -----------------------------------------------
emit_config "${V2_ALPHA}" all | write_config

wait_until "${TICK_WAIT_S}" "edit 2: config.json.pending never named persona ${ALPHA}'s delivery change" \
    pending_has_line "${ALPHA_DELIVERY_BODY}"
check_pending_layout "edit 2" in_place=1
# Same counts as edit 1's header, so this is its second occurrence.
wait_for_count "${HEADER_1}" 2 10 "edit 2: reload-preview header not logged"
expect_preview_logged "edit 2" edit2

# Keep edit 2's preview aside (same file system, so the move below is one
# rename): the server rewrites config.json.pending for edit 3 below.
STALE_COPY="${SCENARIO_ROOT}/stale-confirmation"
cp -- "${PENDING}" "${STALE_COPY}"
STALE_FINGERPRINT="$(fingerprint_of "${STALE_COPY}")"
if (( $(count_in "${STALE_COPY}" "${ALPHA_DELIVERY_BODY}") == 0 )) || [[ -z "${STALE_FINGERPRINT}" ]]; then
    fail "edit 2: the copy of config.json.pending is not edit 2's preview"
fi

# Edit 3; once the server has previewed it, confirm edit 2's preview.
emit_config "${V2_ALPHA}" mentions | write_config
wait_until "${TICK_WAIT_S}" "edit 3: no fresh config.json.pending naming persona ${BRAVO}'s delivery change" \
    fresh_pending_for_v3
check_pending_layout "edit 3" in_place=2
pending_has_line "${ALPHA_DELIVERY_BODY}" || fail "edit 3: config.json.pending lost persona ${ALPHA}'s delivery change"
wait_for_log "${HEADER_2}" 10 "edit 3: reload-preview header not logged"
expect_preview_logged "edit 3" edit3
same_bytes "${V1_COPY}" "${LAST}" || fail "edit 3: config.json.last-applied changed before a confirmation"

mv -f -- "${STALE_COPY}" "${APPLY}"

wait_for_log "${STALE_MATCH}" "${TICK_WAIT_S}" "stale confirmation: reload-stale-confirmation not logged"
[[ ! -e "${APPLY}" ]] || fail "stale confirmation: config.json.apply still present"
same_bytes "${V1_COPY}" "${LAST}" || fail "stale confirmation: config.json.last-applied changed"
expect_count "${APPLIED_CLASS}" 1 "stale confirmation: a change was applied (reload-applied lines)"
expect_count "${ALPHA_UPDATED_DELIVERY}" 0 "stale confirmation: persona ${ALPHA} updated in place"
expect_count "${BRAVO_UPDATED_DELIVERY}" 0 "stale confirmation: persona ${BRAVO} updated in place"

# The newest edit is still pending, as its own preview.
wait_until 10 "stale confirmation: no pending file for the newest edit afterwards" fresh_pending_for_v3
check_pending_layout "stale confirmation" in_place=2

mv -f -- "${PENDING}" "${APPLY}"

wait_for_log "${APPLIED_2}" "${TICK_WAIT_S}" "confirm 3: reload-applied not logged"
[[ ! -e "${APPLY}" ]] || fail "confirm 3: config.json.apply still present after the apply"
same_bytes "${CONFIG}" "${LAST}" || fail "confirm 3: config.json.last-applied does not hold the confirmed config.json"
wait_for_log "${ALPHA_UPDATED_DELIVERY}" 10 "confirm 3: persona ${ALPHA} not updated in place"
wait_for_log "${BRAVO_UPDATED_DELIVERY}" 10 "confirm 3: persona ${BRAVO} not updated in place"
wait_until 10 "confirm 3: config.json.pending not removed after the apply" test ! -e "${PENDING}"
expect_count "${APPLIED_CLASS}" 2 "confirm 3: reload-applied lines"
expect_count "${STALE_CLASS}" 1 "confirm 3: reload-stale-confirmation lines"

# --- Stop -----------------------------------------------------------------
# shellcheck disable=SC2119 # no bot was launched: no --stop-bots
stop_server

echo "PASS: ${TEST_NAME}"
