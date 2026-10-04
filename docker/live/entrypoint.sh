#!/bin/bash
# docker/live/entrypoint.sh — PID 1 of the /ci-live container.
#
# It runs at the container's first start and again at every `docker restart`
# (the run's stand-in for a host reboot, Check 28):
#
# - First start only: installs the testplan's shell helpers and pre-flight
#   script for the test user (with TEST_HOST set to this container's
#   hostname), and writes the test user's Claude Code config: onboarding done,
#   the working directories trusted, the API key approved (as /ci does), and
#   a settings.json that allows only the CSCB MCP tools. It does NOT set
#   bypassPermissions: Checks 5, 18, 22 and 23 need Bash to raise a
#   permission prompt that CSCB relays to Slack.
# - Every start: when the runner has set the "start at boot" marker
#   (~/cscb-live/.start-at-boot, the analogue of the plan's @reboot line), it
#   starts `claude-slack-channel-bots start` as the test user, with no token
#   variable and no SLACK_STATE_DIR, logging to ~/cscb-live/boot-start.log.
# - Every start is numbered (the first start is boot 1, each restart adds
#   one), and when the start's work is done the entrypoint records
#   "<boot> ok" (or "<boot> first-boot-failed") in /var/lib/cscb-live/boot-done.
#   The runner waits for the number of the boot it caused, so after a
#   `docker restart` it never mistakes the previous boot's record for this one.
#
# Then it idles until the container is stopped. The package itself is
# installed by the runner's "install" check (docker exec), after the
# pre-flight, as testplans/b.yko Part 1.4 orders it.
set -uo pipefail

TESTUSER_HOME=/home/testuser
LIVE_DIR="${TESTUSER_HOME}/cscb-live"
BOOT_DIR=/var/lib/cscb-live
FIRST_BOOT_DONE="${BOOT_DIR}/first-boot-done"
BOOT_COUNT="${BOOT_DIR}/boot-count"
BOOT_DONE="${BOOT_DIR}/boot-done"
BOOT_MARKER="${LIVE_DIR}/.start-at-boot"

log() { printf '%s cscb-live-entrypoint: %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*"; }

# The container must never carry a Slack token variable or a state-dir override.
unset SLACK_BOT_TOKEN SLACK_APP_TOKEN SLACK_STATE_DIR

first_boot() {
    local host
    host="$(hostname)"
    if [[ -z "${CSCB_LIVE_TEST_HOST:-}" || "${CSCB_LIVE_TEST_HOST}" != "${host}" ]]; then
        log "CSCB_LIVE_TEST_HOST does not name this container's hostname; refusing to set up"
        return 1
    fi
    mkdir -p "${LIVE_DIR}" "${TESTUSER_HOME}/.claude" /var/lib/cscb-live
    for f in cscb-live-helpers.sh cscb-live-preflight.sh; do
        sed "s/@TEST_HOST@/${host}/" "/opt/cscb-live/${f}" > "${TESTUSER_HOME}/${f}"
    done
    chmod 0644 "${TESTUSER_HOME}/cscb-live-helpers.sh"
    chmod 0755 "${TESTUSER_HOME}/cscb-live-preflight.sh"

    python3 - "${TESTUSER_HOME}" <<'PY'
import json, os, subprocess, sys
home = sys.argv[1]
live = os.path.join(home, 'cscb-live')
d = {'numStartups': 100, 'hasCompletedOnboarding': True}
try:
    version = subprocess.run(['claude', '--version'], capture_output=True, text=True, timeout=60).stdout.split()[0]
    d['lastOnboardingVersion'] = version
except Exception:
    pass
projects = {}
for p in [home, live] + [os.path.join(live, x) for x in ('a', 'b', 'c', 'd', 'wizard')]:
    projects[p] = {'hasTrustDialogAccepted': True, 'hasCompletedProjectOnboarding': True}
d['projects'] = projects
key = os.environ.get('ANTHROPIC_API_KEY', '')
if key:
    d['apiKey'] = key
    d['customApiKeyResponses'] = {'approved': [key[-20:]], 'rejected': []}
with open(os.path.join(home, '.claude.json'), 'w') as f:
    json.dump(d, f, indent=2)
settings = {'permissions': {'allow': ['mcp__slack-channel-router__*'], 'defaultMode': 'default'}}
with open(os.path.join(home, '.claude', 'settings.json'), 'w') as f:
    json.dump(settings, f, indent=2)
PY
    chmod 0600 "${TESTUSER_HOME}/.claude.json"
    chown -R testuser:testuser "${TESTUSER_HOME}/.claude" "${TESTUSER_HOME}/.claude.json" "${LIVE_DIR}" \
        "${TESTUSER_HOME}/cscb-live-helpers.sh" "${TESTUSER_HOME}/cscb-live-preflight.sh"
    touch "${FIRST_BOOT_DONE}"
    log "first boot: helpers, pre-flight and Claude config written"
}

mkdir -p "${BOOT_DIR}"
previous="$(tr -dc '0-9' 2>/dev/null < "${BOOT_COUNT}")"
boot=$(( ${previous:-0} + 1 ))
printf '%s\n' "${boot}" > "${BOOT_COUNT}"
log "boot ${boot}"
status=ok

if [[ ! -e "${FIRST_BOOT_DONE}" ]]; then
    first_boot || { log "first boot setup failed"; status=first-boot-failed; }
fi

if [[ -e "${BOOT_MARKER}" ]]; then
    log "start-at-boot marker present: starting claude-slack-channel-bots as testuser"
    gosu testuser bash -c '
        export PATH="/opt/agent-director-rc/bin:$HOME/.bun/bin:/usr/local/bin:/usr/bin:/bin"
        cd "$HOME" && claude-slack-channel-bots start >> "$HOME/cscb-live/boot-start.log" 2>&1
    ' &
fi

# This boot's work is done (written whole, so the runner never reads half a record).
printf '%s %s\n' "${boot}" "${status}" > "${BOOT_DONE}.tmp" && mv -f "${BOOT_DONE}.tmp" "${BOOT_DONE}"
log "boot ${boot} done (${status}); idle"
trap 'log "stopping"; exit 0' TERM INT
sleep infinity &
wait $!
