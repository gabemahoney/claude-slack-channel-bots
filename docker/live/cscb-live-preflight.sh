#!/usr/bin/env bash
# b.yko pre-flight, adapted to the /ci-live container (testplans/b.yko
# "Pre-flight"). The entrypoint installs it as ~/cscb-live-preflight.sh with
# TEST_HOST set to the container's hostname.
# Usage: bash ~/cscb-live-preflight.sh setup|check1
#
# Change from the plan's script: `crontab` is not required. The container
# has no cron; the runner's "start at boot" marker, which the entrypoint acts
# on at every container start, stands in for the plan's @reboot line.
set -u
TEST_HOST='@TEST_HOST@'   # the container's hostname
PHASE="${1:?usage: bash ~/cscb-live-preflight.sh setup|check1}"
export PATH="/opt/agent-director/bin:$HOME/.bun/bin:/usr/local/bin:/usr/bin:/bin"
STATE="$HOME/.claude/channels/slack"
fail() { echo "PRE-FLIGHT FAILED: $*" >&2; exit 1; }

[ "$(uname -s)" = Linux ] || fail "this host is not Linux"
[ -r "/proc/$$/environ" ] || fail "/proc/<pid>/environ is not readable"
for c in hostname whoami pgrep stat sha256sum jq script tmux bun agent-director claude; do
  command -v "$c" >/dev/null 2>&1 || fail "command not found: $c"
done
if [ "$PHASE" = check1 ]; then
  command -v claude-slack-channel-bots >/dev/null 2>&1 || fail "command not found: claude-slack-channel-bots"
fi
[ "$(hostname)" = "$TEST_HOST" ] || fail "hostname is not $TEST_HOST"
[ -z "${SLACK_STATE_DIR:-}" ] || fail "SLACK_STATE_DIR is set; this plan uses the default state directory"
[ -z "$(pgrep -af 'cli\.ts start')" ] || fail "a CSCB server process is running on this host"
if (exec 3<>/dev/tcp/127.0.0.1/3100) 2>/dev/null; then fail "127.0.0.1:3100 is in use"; fi
ad_out="$(agent-director list --label service=cscb)" || fail "agent-director list failed"
printf '%s' "$ad_out" | bun -e 'try { const r = JSON.parse(await Bun.stdin.text()); process.exit(Array.isArray(r.spawns) && r.spawns.length === 0 ? 0 : 1) } catch { process.exit(1) }' \
  || fail "agent-director lists service=cscb rows"
[ ! -e "$STATE/server.pid" ] || fail "$STATE/server.pid exists"
[ ! -e "$STATE/config.json.last-applied" ] || fail "$STATE/config.json.last-applied exists; a start would run it instead of config.json"

CFG="$STATE/config.json"
case "$PHASE" in
  setup)   # before the install: config.json absent, or exactly the postinstall skeleton
    if [ -e "$CFG" ]; then
      CFG="$CFG" bun -e 'try { const c = JSON.parse(await Bun.file(process.env.CFG).text()); process.exit(JSON.stringify(c) === "{\"personas\":[]}" ? 0 : 1) } catch { process.exit(1) }' \
        || fail "$CFG exists and is not {\"personas\": []}"
    fi ;;
  check1)  # before Checks S3 and 1: config.json names exactly this plan's three personas
    CFG="$CFG" bun -e 'try { const c = JSON.parse(await Bun.file(process.env.CFG).text()); const n = (c.personas ?? []).map((p) => p.name).sort().join(","); process.exit(n === "persona_a,persona_b,persona_c" ? 0 : 1) } catch { process.exit(1) }' \
      || fail "$CFG does not name exactly persona_a, persona_b and persona_c" ;;
  *) fail "unknown phase $PHASE" ;;
esac
echo "pre-flight passed ($PHASE)"
