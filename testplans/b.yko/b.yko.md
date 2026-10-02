---
id: b.yko
type: bee
title: 'Live acceptance: multi-persona CSCB on a test workspace (b.av2)'
tags:
- cscb
- personas
- live-acceptance
parent: null
egg: null
created_at: '2026-09-24T04:01:05.074749'
status: pupa
schema_version: '0.1'
reference_materials: null
guid: ykop6szcwyxafzsq57223oihvnrz5h5y
---

# Live acceptance: multi-persona CSCB on a test workspace

Live acceptance run for idea b.av2 (personas), built by plan b.ob2. It is one
ordered run on the finished feature. It starts from a clean install and sets
up three persona apps in a real test Slack workspace using only the README,
the setup wizard (`/setup-slack-channel-bots`) and `config.json`. The AC
coverage table below maps every acceptance criterion that b.av2 SR-14 marks
as live-verified, and the extra live evidence the run gives, to the check
that verifies it.

This plan is **manual**. The operator runs it by hand, on a test host and a
test Slack workspace only, never on the production install. It has no
integration-script transcription and is not a docker integration test.
`/ci` and `/release-test` never run it: `/release-test` selects only tickets
whose title starts with "Test ", and this title deliberately does not.

`/ci-live` (`bun ci-live/run.ts`) automates this plan. It runs the checks in
this order against the test workspace, in a throwaway docker container that
serves as the test host, and writes a Results row. S1, 26 and 29b stay manual,
and so do 14, 16 and 20 when no second account is configured. Its deviations
from the steps below (for example, `config.json` edits instead of the wizard
in Part 1.5 and Check 25, and a container restart as Check 28's reboot) are
recorded in its results' Notes. See `docker/README.md` under "/ci-live".

---

## AC coverage

Each row names the numbered check, and where it matters the step, that
verifies the criterion. AC numbers are b.av2's PRD order (1–74).

Live-verified in b.av2 SR-14:

| AC or item | What the run shows | Verified by |
|---|---|---|
| 1 | Two personas reply under their own names and avatars; a mention of A in the shared channel gets A's reply and nothing from mention-only B | Checks 2 and 3 |
| 2 | One persona in two channels runs one instance; each delivery carries its source channel as `chat_id`; its replies reach each channel | Check 4 |
| 4 | Never two instances of a persona: one row per persona after the crash cycle and after the reboot | Checks 6, 7 (step 3) and 28 (step 5) |
| 11 | A mentions B and B replies as itself | Check 12 |
| 12 | A persona receive-all in two channels sees every message of both in one instance | Check 13 |
| 13 | After a host reboot every applied persona comes back with no manual action | Check 28 (steps 4–7) |
| 14 | The whole setup is `config.json` and the credentials files, with no code edit | Check S2; every later change is a `config.json` or credentials-file edit confirmed by the rename (Part 2.2) |
| 15 | A DM to A's app is answered by A, a DM to B's app by B, and neither reaches the other | Check 17 |
| 17 | Any workspace user reaches a persona in a channel and by DM, with no allowlist and no pairing step | Check 14; Check 17 in passing |
| 18 | Two personas exchange messages past several round trips with no limit | Check 12 |
| 19 | A persona added on the running server comes up after the confirmation, with the existing persona's conversation undisturbed | Check 25 |
| 22 | The added persona's credentials file is created on disk while the server runs, and it posts as itself with no restart and no change to the server's environment | Check 25 (steps 1, 4 and 7–8) |
| 28 | A channel destination: the prompt is posted there under the persona's identity and its button resolves the request | Check 5 (steps 1–2) |
| 29 | A DM destination: the prompt arrives as a DM from the persona's app and its button resolves it there | Check 22 |
| 31 | Work arriving from the coordination channel prompts in A's destination channel, not in the coordination channel | Check 5 (step 3) |
| 34 | Two personas with different prompt settings each prompt at their own destination in one run | Check 23 |
| 36 | A persona with DMs off opens no DM and posts in none | Check 16 |
| 37 | A channel persona with DMs on answers a DM in that DM | Check 17 |
| 38 | A persona with DMs on opens a DM with a user it has none with and posts as itself | Check 20 |
| 40 | A DM-only persona answers in the same DM | Check 19 |
| 41 | A zero-channel persona starts, connects, handles a DM and is in no channel | Check 19 |
| 44 | A DM-only persona's first prompt opens the DM with its contact | Check 18 |
| 70 | An unconfirmed destructive edit survives the restart and stays pending | Check 28 (steps 3 and 6) |
| 71 | With no record, the first start applies `config.json` as it stands with no confirmation; an invalid file doesn't start | Check S3 (invalid) and Check 1 (valid) |
| 72 | A credentials change still pending when the server stops is applied at the next start | Check 28 (steps 2, 5, 6 and 7) |
| Crash-and-recover cycle | One crash of A's instance and its automatic recovery | Check 7 |
| Host reboot | The plan's only reboot | Check 28 |
| Persona-post event shape | One of A's posts captured as B's connection receives it | Check 8 |

Extra live evidence (unit-verified in SR-14, checked here too):

| AC or item | What the run shows | Verified by |
|---|---|---|
| 7 | `@here` and `@channel` reach each mention-only persona once | Check 10 |
| 8 | A persona's own broadcast doesn't wake it; the other persona gets it once | Check 11 |
| 20 | No credential value in the config file, the record, the pending file, the wizard session, the persona transcripts or any log line | Check 29a; also Checks S1, S2, 25 (step 5) and 28 (steps 2 and 7) |
| 26 | A message to a persona whose instance is down is reported at its destination, not in the channel | Check 24 |
| 35 | A DM to a persona with DMs off is dropped with a `persona-dm-dropped` line | Check 15 |
| 47 | The server starts and serves with the token environment variables unset | Part 1.4 and Check 1; `guard` refuses every start in a shell that has one (Part 1.3) |
| 57 | A confirmed removal tears down only that persona | Check 27 |
| Wizard credentials command (b.av2 SR-12, SR-1.4 part) | Tokens are typed only into the terminal command, never shown; the file is written with mode 0600; the wizard refuses a token offered in the chat | Check S1 |
| Persona added through the wizard on a running server (E14 sprint demo) | The wizard adds D, explains the pending file and the rename, and D comes up only after the operator confirms | Check 25 (steps 4–7) |
| Leak check (E13 carry) | No WebSocket `wss://` or `ticket=` URL in any log the run wrote | Check 29a (step 2) |
| Handshake failure (E13 carry, optional) | A real Socket Mode handshake failure logs no WebSocket `ticket=` URL; the `[slack] persona Socket Mode: …` health lines appear | Check 29b |
| Revoked bot token (bug b.ujn, optional) | The first Web API auth error marks the persona credentials-broken, its instance keeps running, and a confirmed credentials change brings it back | Check 26 |

Not checked live: the E13 dry-run leg (a `working_directory` change giving one
`DESTRUCTIVE:` line with one teardown and one bring-up; a `port` change giving
a preview line while the listener stays on the old port). It needs no live
Slack, so the docker scenario
`tests/integration/test-9-reload-destructive-and-server-wide.sh` (Task 4 of
E14) checks it.

---

## Run order

The run is one pass, in this order. Each part starts from the state the
part before it leaves.

1. **Part 1: Setup.** Pre-flight, install from the README, shell helpers, A, B and C added with the wizard (Check S1), Check S2, Check S3.
2. **Part 2: Procedures.** How to observe deliveries, apply a config edit and restart the test server. No checks of its own.
3. **Part 3: First start and channel checks.** Checks 1–7, including the crash-and-recover cycle (Check 7).
4. **Part 4: Bot-to-bot, broadcast and event shape.** Checks 8–12.
5. **Part 5: A receive-all in both channels.** Check 13.
6. **Part 6: Open access.** Check 14.
7. **Part 7: DMs and DM prompts.** Checks 15–16, "Turn A's DMs on", Checks 17–23.
8. **Part 8: Lost message.** Check 24 and its teardown.
9. **Part 9: Runtime add and remove.** Check 25, Check 26 (optional), Check 27.
10. **Part 10: Reboot.** Check 28.
11. **Part 11: Closing secrecy check.** Check 29a, then the optional Check 29b.
12. **Teardown.**

The order satisfies every constraint the checks have:

- Check S3 (the invalid first start) runs before the first valid start, while no CSCB server runs and agent-director lists no `service=cscb` row.
- A is mentions-only in coordination for Checks 3 and 8–12, and again from the end of Check 13 for Check 21: Check 13 switches A's coordination `delivery` to `all` and back within the check.
- Check 14 (the first-time user) runs before Checks 16 and 20 (the second test user), so one account can serve both roles (Part 1.1).
- Checks 15 and 16 run while A's DMs are off, before "Turn A's DMs on".
- Check 18 (C's first prompt opens the DM with C) runs before Check 19, the first DM the operator sends to C.
- Check 16 (A may not message the second test user) runs before Check 20 (A opens that DM).
- Check 24's teardown restores auto-restart before Part 9.
- Part 9 ends with the applied set back to A, B and C and nothing pending, which Check 28 needs. The optional Check 26 runs on the disposable persona D, before D's removal.
- The run has one crash-and-recover cycle (Check 7) and one reboot (Check 28). Check 29a runs after every other required check has written its logs; the optional Check 29b, when run, ends by repeating Check 29a's log counts.

If the test server stops between parts for any other reason, run the
"Guarded restart" (Part 2.3) before going on. Never rerun the pre-flight after
Check 1: it fails on the `service=cscb` rows the run created, which the
restart resumes.

---

## Safety

Read this section before every run.

- **Operator-run only**, on a **test Slack workspace**. Never on a workspace that production bots serve.
- **Never on the production install.** Use a dedicated host or VM whose HOME holds no production CSCB state (`~/.claude/channels/slack/`) and no production `~/.agent-director`. The start sweep kills and deletes every `service=cscb` agent-director row that names no configured persona, so a test server sharing `~/.agent-director` with a production CSCB would destroy the production bots. A dedicated OS user is acceptable only on a host that runs no production CSCB at all: only one CSCB server runs per host (they would both need port 3100).
- **Never through `/ci` or `/release-test`.** Only the operator runs this plan, by hand, or starts `/ci-live`, which runs it in a throwaway container.
- **Never type or paste a token** into a chat (the wizard's included), this ticket, the results table, a log or a shell command line. Tokens go only into the wizard's credentials command, at its hidden prompts, in the operator's own terminal (Check S1). Every token check in this plan counts matches and never prints one.
- **A Linux host with bash.** The plan's commands need GNU/Linux and an interactive bash shell: they read `/proc/<pid>/environ`, and use `stat -c`, `sha256sum`, `history -a`, bash arrays, `jq`, `script`, `tmux` and a user crontab `@reboot` line. Only the optional Check 29b needs `sudo`, `iptables` and `systemd-run`. The pre-flight checks the rest.
- **The optional Check 29b changes the test host's network for a few minutes**: a firewall rule, limited to the test user's processes and removed by a job scheduled before the rule is added, and an `/etc/hosts` line, removed in the same check and, as a backstop, by a job scheduled before the line is added. Do it only on the test host. Teardown removes both if a terminal dropped mid-check.

### Pre-flight

Save this script once on the test host and set `TEST_HOST` to the test host's name as `hostname` prints it. It exits non-zero, naming the first failed condition, unless the host runs Linux with `/proc` and has the commands the plan uses, the host is the named test host, `SLACK_STATE_DIR` is unset, no CSCB server is running, `127.0.0.1:3100` is free, agent-director lists no `service=cscb` row, there is no `server.pid`, there is no `config.json.last-applied`, and `config.json` is as the phase expects. It prints no file contents.

A leftover `config.json.last-applied` fails it because a start runs that record when it exists. Check 1 would then run an earlier run's persona set, not this `config.json`.

```sh
cat > ~/cscb-live-preflight.sh <<'EOF'
#!/usr/bin/env bash
# b.yko pre-flight. Usage: bash ~/cscb-live-preflight.sh setup|check1
set -u
TEST_HOST='<TEST_HOST>'   # the test host's name, exactly as `hostname` prints it
PHASE="${1:?usage: bash ~/cscb-live-preflight.sh setup|check1}"
STATE="$HOME/.claude/channels/slack"
fail() { echo "PRE-FLIGHT FAILED: $*" >&2; exit 1; }

[ "$(uname -s)" = Linux ] || fail "this host is not Linux"
[ -r "/proc/$$/environ" ] || fail "/proc/<pid>/environ is not readable"
for c in hostname whoami pgrep stat sha256sum jq script tmux crontab bun agent-director claude; do
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
EOF
```

Run it before the install (Part 1.4), right before Check S3, and right before Check 1:

```sh
bash ~/cscb-live-preflight.sh setup    # before the install
bash ~/cscb-live-preflight.sh check1   # before Check S3, and again before Check 1
```

If it fails, stop: this is not a clean test host. Rows left by an earlier run also fail it, because Check 1 expects every persona to be fresh-spawned. So does a `config.json.last-applied` left by an earlier run.

---

## Part 1: Setup

The run's single setup. It verifies AC 14 (the whole persona setup is
`config.json` plus the credentials files, with no persona-specific code edit),
AC 47 (no token environment variable is an input) and AC 71 (the first start
with no record applies the file as it stands; an invalid file doesn't start),
and the live side of b.av2 SR-12 and SR-1.4 for the setup wizard (the
credentials command). Checks S1 to S3 record these results; Check 1 finishes
AC 71.

Every detail the tester needs comes from the README (`$PKG/README.md`, Part
1.4) or the wizard. A tester who needs a detail neither gives, and gets it
from any other source (source code, another document, a search, an earlier
release), records a setup failure in Notes and files a documentation bug
naming the missing detail. Then continue with the detail found, so the rest
of the run can go on.

### 1.1 Where it runs and who takes part

The run uses only a test host and a test Slack workspace, never the
production install (see Safety). People take part only by role; no person is
named in this plan or in its results.

- **The operator** runs every step on the test host, is an admin of the test workspace, posts the plan's messages from their own Slack account, and records the results. The operator is also B's and C's DM contact (`<OPERATOR_USER_ID>`).
- **The second test user** is a workspace account, other than the operator's, that the operator can sign in as (for example in another browser profile). It has never had a DM with app A. Checks 16 and 20 use it.
- **The first-time user** is a workspace account, other than the operator's, that has never posted in A-home, never had a DM with any persona app, and was never messaged by one. Check 14 uses it.

One account may serve as both the first-time user and the second test user,
in that order: Check 14 gives it a post in A-home and a DM with B, but no DM
with A, so it still qualifies as the second test user for Checks 16 and 20,
which run later. After the run, the account qualifies for neither role in a
rerun: Check 20 opens a DM from A.

### 1.2 Workspace prerequisites and placeholders

In the test workspace, create two channels:

- **A-home**, for A alone.
- **coordination**, shared by A and B.

Note their channel IDs (in Slack, click the channel name; the ID is at the
bottom of the **About** tab) and the member IDs of the three accounts (open
the profile, then **⋮** → **Copy member ID**). They replace these
placeholders everywhere below; IDs are not secrets:

| Placeholder | Value |
|---|---|
| `<A_HOME_CHANNEL_ID>` | A-home's channel ID |
| `<COORDINATION_CHANNEL_ID>` | coordination's channel ID |
| `<OPERATOR_USER_ID>` | the operator's member ID |
| `<SECOND_USER_ID>` | the second test user's member ID |
| `<FIRST_TIME_USER_ID>` | the first-time user's member ID |
| `<TEST_HOST>`, `<TEST_USER>` | the test host's name as `hostname` prints it, and its user as `whoami` prints it |

Later parts add `<A_BOT_USER_ID>`, `<B_BOT_USER_ID>` and `<A_BOT_ID>` (Part
4), the DM conversation IDs `<A_DM_ID>`, `<B_DM_ID>`, `<C_DM_ID>` (Part 7) and
`<B_NEW_DM_ID>` (Check 14), and `<D_HOME_CHANNEL_ID>` (Part 9). A message's
`<TS>` is its Slack timestamp: take it from the message's **Copy link** URL,
whose last path part is `p` followed by 16 digits; put a dot before the last
six digits (`p1790000000123456` is `1790000000.123456`).

Before the wizard runs, look in the operator's Slack sidebar and **Apps** list
for a conversation with "CSCB Test C". Record in Notes "C DM before the run:
yes" (an earlier run left app C and its DM; Slack DMs can't be deleted) or
"no". Check 18 compares against it.

### 1.3 Shell helpers

Save this file once on the test host, with `<TEST_HOST>` and `<TEST_USER>`
filled in, and load it with `source ~/cscb-live-helpers.sh` in every shell the
run uses, including any shell opened after the reboot. Every shell the run
uses is an interactive bash shell. Every helper only reads, except `guard`,
which only decides. None prints a token: `showpending` and `showsafe` show
text only after counting zero token-shaped matches in it.

```sh
cat > ~/cscb-live-helpers.sh <<'EOF'
# b.yko shell helpers. Load in every shell: source ~/cscb-live-helpers.sh
TEST_HOST='<TEST_HOST>'   # the test host's name, exactly as `hostname` prints it
TEST_USER='<TEST_USER>'   # the test host's user, exactly as `whoami` prints it
S=~/.claude/channels/slack
LOG="$S/server.log"
TRAIL="$S/permission-trail.jsonl"

# The installed package root, found as the setup wizard's Step 1 finds it.
PKG=''
for d in "$HOME/.bun/install/global/node_modules/claude-slack-channel-bots" \
         "$(npm root -g 2>/dev/null)/claude-slack-channel-bots"; do
  [ -z "$PKG" ] && [ -f "$d/README.md" ] && PKG="$d"
done

# guard: succeeds only on the test host, as its user, in a shell with no
# SLACK_STATE_DIR and no token variable (AC 47). It counts variable names
# and never prints a value. Every step that starts, stops or changes
# something runs behind it.
guard() {
  [ -n "${BASH_VERSION:-}" ] || { echo 'not a bash shell - stop'; return 1; }
  [ "$(hostname)" = "$TEST_HOST" ] && [ "$(whoami)" = "$TEST_USER" ] \
    || { echo 'NOT THE TEST HOST - stop'; return 1; }
  [ -z "${SLACK_STATE_DIR:-}" ] || { echo 'SLACK_STATE_DIR is set - stop'; return 1; }
  [ "$(env | cut -d= -f1 | grep -cE '^SLACK_(BOT|APP)_TOKEN$')" = 0 ] \
    || { echo 'a token variable is set - stop'; return 1; }
}

# mark: where server.log ends now, as <inode>:<line count>. Each check
# records a mark first (MARK=$(mark)), because server.log is appended. The
# server rotates server.log at 10 MB: it renames the file to server.log.1
# (older ones to .2, .3, …) and opens a new server.log, with a new inode.
mark() { echo "$(stat -c %i "$LOG"):$(wc -l < "$LOG")"; }

# since MARK: the server log's lines after MARK. If server.log rotated once
# since the mark, it reads server.log.1 from the mark, then the whole new
# server.log. Anything else fails loudly on stderr and prints no line.
since() {
  case "$1" in *:*) ;; *) echo "SINCE FAILED: '$1' is not a mark made by mark" >&2; return 2 ;; esac
  local ino="${1%%:*}" n="${1#*:}"
  if [ "$(stat -c %i "$LOG")" = "$ino" ]; then
    tail -n +"$((n + 1))" "$LOG"
  elif [ -e "$LOG.1" ] && [ "$(stat -c %i "$LOG.1")" = "$ino" ]; then
    tail -n +"$((n + 1))" "$LOG.1"; cat "$LOG"
  else
    echo "SINCE FAILED: server.log rotated more than once since mark $1; read server.log.2 and later by hand" >&2
    return 1
  fi
}

# tags a|b|c|d TS: every <channel …> tag delivered to that persona for the
# message with that ts, from the persona's current session transcript. A
# delivered message is a user entry, or, when it arrived while the persona
# was mid-turn, a queued_command attachment (its prompt a string or content
# blocks); Claude Code writes one or the other, never both. The
# queue-operation entries, which hold every message again, are not read.
tags() {
  local t
  t="$(ls -t ~/.claude/projects/*-cscb-live-"$1"/*.jsonl | head -1)"
  jq -r 'if .type == "user" then .message.content
         elif .type == "attachment" and .attachment.type? == "queued_command" then .attachment.prompt
         else empty end
         | if type == "string" then . else (.[]? | .text? // empty) end' "$t" \
    | grep -oE '<channel source="slack[^"]*"[^>]*>' | grep -F " ts=\"$2\""
}

# tagstext a|b|c|d 'TEXT': the tag of every delivered message whose content
# contains TEXT (for an edited message, whose tag may carry another ts). It
# reads the same entries as tags.
tagstext() {
  local t
  t="$(ls -t ~/.claude/projects/*-cscb-live-"$1"/*.jsonl | head -1)"
  jq -r --arg s "$2" 'if .type == "user" then .message.content
         elif .type == "attachment" and .attachment.type? == "queued_command" then .attachment.prompt
         else empty end
         | if type == "string" then . else (.[]? | .text? // empty) end
         | select(contains($s))' "$t" \
    | grep -oE '<channel source="slack[^"]*"[^>]*>'
}

# replies a|b|c|d: every reply tool call in the persona's current
# transcript, with its target and the result the server returned.
replies() {
  local t
  t="$(ls -t ~/.claude/projects/*-cscb-live-"$1"/*.jsonl | head -1)"
  jq -rs '
    [ .[] | select(.type == "assistant") | .message.content | arrays | .[]
      | select(.type? == "tool_use" and (.name | endswith("__reply"))) ] as $calls
    | [ .[] | select(.type == "user") | .message.content | arrays | .[]
        | select(.type? == "tool_result") ] as $results
    | $calls[] | . as $c
    | ([ $results[] | select(.tool_use_id == $c.id) ] | first) as $r
    | "chat_id=\($c.input.chat_id) error=\($r.is_error // false) result=\(
        $r.content | if type == "string" then .
                     elif type == "array" then ([ .[] | .text? // empty ] | join(" "))
                     else "(no result yet)" end)"' "$t"
}

# posts TMARK: every permission-prompt post in the permission trail after
# line TMARK (TMARK=$(wc -l < "$TRAIL")): instance, conversation, ok, error.
posts() {
  tail -n +"$(($1 + 1))" "$TRAIL" \
    | jq -c 'select(.event == "cscb.chat_post.attempted") | {claude_instance_id, channel, ok, error}'
}

# tokcount FILE...: how many lines of the files hold token-shaped text (a
# Slack prefix such as xoxb- or xapp- followed by a digit). One number,
# never a line. A file that does not exist counts 0.
tokcount() { cat -- "$@" 2>/dev/null | grep -cE 'xox[a-z]-[0-9]|xapp-[0-9]'; }

# showsafe: pass stdin through only when it holds no token-shaped text;
# otherwise print a notice instead. Used on every grep of reload-preview:
# lines, for example: since "$MARK" | grep -F 'reload-preview:' | showsafe
showsafe() {
  local t; t="$(cat)"
  if [ "$(printf '%s\n' "$t" | tokcount)" = 0 ]; then
    [ -n "$t" ] && printf '%s\n' "$t"; return 0
  fi
  echo 'TOKEN-SHAPED TEXT - not shown; this fails the check' >&2; return 1
}

# showpending: print config.json.pending only after counting no
# token-shaped text in it.
showpending() {
  [ -e "$S/config.json.pending" ] || { echo 'config.json.pending does not exist'; return 1; }
  [ "$(tokcount "$S/config.json.pending")" = 0 ] && cat "$S/config.json.pending" \
    || { echo 'TOKEN-SHAPED TEXT in config.json.pending - not shown; this fails the check' >&2; return 1; }
}

# leakcount FILE...: per file, how many times any token held in a persona
# credentials file under ~/.config/cscb/ occurs in it. The tokens are the
# run's leak markers; they are read inside bun and never printed.
leakcount() {
  bun -e '
    const fs = require("fs")
    const dir = process.env.HOME + "/.config/cscb"
    const tokens = []
    for (const f of fs.readdirSync(dir)) {
      if (!f.endsWith("-credentials.json")) continue
      try {
        const c = JSON.parse(fs.readFileSync(dir + "/" + f, "utf8"))
        for (const t of [c.bot_token, c.app_token]) if (typeof t === "string" && t.length >= 20) tokens.push(t)
      } catch {}
    }
    console.log("tokens checked: " + tokens.length)
    for (const file of process.argv.slice(1)) {
      if (!fs.existsSync(file)) { console.log(file + ": absent"); continue }
      const text = fs.readFileSync(file, "latin1")
      let n = 0
      for (const t of tokens) n += text.split(t).length - 1
      console.log(file + ": " + n)
    }' "$@"
}
EOF
```

`tags`, `tagstext` and `replies` read the transcript of a persona whose
working directory is `~/cscb-live/<a|b|c|d>`, under `~/.claude/projects/`:
no persona in this plan sets `claude_config_dir`. Part 2.1 says how the
checks use them.

### 1.4 Install from the README

1. Run the pre-flight's setup phase, then load the helpers and check the shell (AC 47):

   ```sh
   bash ~/cscb-live-preflight.sh setup    # must print "pre-flight passed (setup)"
   source ~/cscb-live-helpers.sh
   env | cut -d= -f1 | grep -cE '^SLACK_(BOT|APP)_TOKEN$'   # must print 0
   guard && echo 'test host'
   ```

   If the count is not 0, remove those variables from the shell profile, open a new shell and start this step again. No step of this plan sets one.

2. Install the build under test. The operator picks one of two sources and records which in the results, with the version (and, for a worktree, the commit):

   - **A published prerelease**, with README Quick Start steps 1 and 2:

     ```sh
     bun install -g claude-slack-channel-bots@<VERSION_UNDER_TEST>
     bun pm -g trust claude-slack-channel-bots
     ```

   - **A local worktree** at the commit under test, with the README's "Installing from a local worktree" (read it in the worktree's `README.md`), then Quick Start step 2's `trust`:

     ```sh
     cd <WORKTREE> && git rev-parse HEAD && git status --porcelain | wc -l   # record the commit; the count must be 0
     ./scripts/install-local.sh
     bun pm -g trust claude-slack-channel-bots
     ```

   Then, for either source:

   ```sh
   source ~/cscb-live-helpers.sh; echo "PKG=$PKG"; readlink -f "$PKG"
   jq -r .version "$PKG/package.json"
   ```

   If `readlink -f` resolves to the worktree itself, leave the worktree untouched until Teardown: Check S2 compares every file under it.

3. Check what postinstall wrote, and record a checksum of every file of the installed package, for Check S2 (a `.git` directory, present only when the package resolves to a worktree, is left out):

   ```sh
   ls -A "$S"
   jq -c . "$S/config.json"
   mkdir -p ~/cscb-live
   ( cd "$PKG" && find . -path ./.git -prune -o -type f -print0 | sort -z | xargs -0 sha256sum ) > ~/cscb-live/pkg-before.sha256
   wc -l < ~/cscb-live/pkg-before.sha256
   ```

4. README Quick Start step 3: make the setup skill available to Claude Code by linking it into `~/.claude/skills/`:

   ```sh
   ln -s "$PKG/skills/setup-slack-channel-bots" ~/.claude/skills/setup-slack-channel-bots
   ls ~/.claude/skills/setup-slack-channel-bots/SKILL.md
   ```

Expected:

- `PKG=` names the package root, a directory holding `README.md`, `slack-app-manifest.yml` and `skills/`.
- `ls -A "$S"` prints only `config.json`, and `jq` prints `{"personas":[]}`: postinstall wrote the skeleton with an empty `personas` array and no `access.json`. Check 14 step 1 checks the rest of what postinstall left (no `access.json`, the `debug-slack-channel-bots` skill link, no retired skill link).
- The checksum file has one line per package file.
- `SKILL.md` is found under the link.

### 1.5 Add A, B and C with the wizard

Create the working directories, and a directory to run the wizard from. The
wizard's session transcript then sits in its own directory under
`~/.claude/projects/`, where Check S1 counts in it:

```sh
mkdir -p ~/cscb-live/a ~/cscb-live/b ~/cscb-live/c ~/cscb-live/wizard
```

Run the wizard three times, in a terminal 80 columns wide, once per persona:
A, then B, then C. Each time, tell it you are adding one persona:

```sh
cd ~/cscb-live/wizard && tput cols   # must print 80; resize the window until it does
claude /setup-slack-channel-bots
```

Follow the wizard's steps. For each persona it has the operator create and
install the persona's Slack app from the shipped `slack-app-manifest.yml`, set
the app's name and avatar, invite the app to its channels (`/invite` in each
channel), and it declares the persona in `config.json`, then has the operator
write the persona's credentials file with the wizard's credentials command in
a terminal. Give these answers:

| Wizard step | A | B | C |
|---|---|---|---|
| 4.1 name | `persona_a` | `persona_b` | `persona_c` |
| 4.2 app name, bot display name, avatar | "CSCB Test A", with its own avatar | "CSCB Test B", with an avatar unlike A's | "CSCB Test C", with an avatar unlike A's and B's |
| 4.3 `credentials_file` path | `~/.config/cscb/persona_a-credentials.json` | `~/.config/cscb/persona_b-credentials.json` | `~/.config/cscb/persona_c-credentials.json` |
| 4.4 `working_directory` | `~/cscb-live/a` | `~/cscb-live/b` | `~/cscb-live/c` |
| 4.5 channels, `delivery`, invites | A-home `all`, coordination `mentions`; invite A to both | coordination `mentions`; invite B there | none; invite C nowhere |
| 4.6 `dm.enabled`, `dm.contact` | DMs off | DMs on, contact `<OPERATOR_USER_ID>` | DMs on, contact `<OPERATOR_USER_ID>` |
| 4.7 `permission_prompts` | `<A_HOME_CHANNEL_ID>` | `dm` | `dm` |
| 4.8 next-launch settings | none | none | none |
| Step 5, server-wide settings | ask for `ack_reaction` `eyes`, nothing else | none | none |
| Step 6, system prompt | write the system-prompt file from the template; Role: "You are a test persona in an acceptance run. Answer every Slack message with the reply tool, briefly, and do what it asks." | already set | already set |

Auto-restart stays on: no run sets `session_restart_delay`, so the default of
60 s applies.

During A's run, run Check S1. For B and C, repeating Check S1's steps 2–6 is
recommended. In each run, the wizard's Step 3 reports
`server: not running` and `record: absent`, and its Step 9 says the first
`claude-slack-channel-bots start` applies `config.json` as it stands, and
that the operator starts it. Don't start it yet.

After the three runs, check what the wizard wrote:

```sh
jq -c '.personas[] | {name, channels, dm, permission_prompts}' "$S/config.json"
jq -r '.personas[] | [.name, .credentials_file, .working_directory] | @tsv' "$S/config.json"
jq -c '[.personas[] | keys - ["name","credentials_file","working_directory","channels","dm","permission_prompts"]]' "$S/config.json"
jq -c '{ack_reaction, session_restart_delay, append_system_prompt_file}' "$S/config.json"
ls -lL ~/.config/cscb/
```

Expected:

- The first command prints three lines, in this order:
  - `{"name":"persona_a","channels":[{"id":"<A_HOME_CHANNEL_ID>","delivery":"all"},{"id":"<COORDINATION_CHANNEL_ID>","delivery":"mentions"}],"dm":null,"permission_prompts":"<A_HOME_CHANNEL_ID>"}` (`"dm":{"enabled":false}` is equally correct)
  - `{"name":"persona_b","channels":[{"id":"<COORDINATION_CHANNEL_ID>","delivery":"mentions"}],"dm":{"enabled":true,"contact":"<OPERATOR_USER_ID>"},"permission_prompts":"dm"}`
  - `{"name":"persona_c","channels":null,"dm":{"enabled":true,"contact":"<OPERATOR_USER_ID>"},"permission_prompts":"dm"}`
- The second prints each persona's credentials file and working directory as the table gives them (`~` may be written out as the home directory).
- The third prints `[[],[],[]]`: no persona has any other key.
- The fourth prints `{"ack_reaction":"eyes","session_restart_delay":null,"append_system_prompt_file":"<path of the system-prompt file in $S>"}`.
- `ls -lL` lists `persona_a-credentials.json`, `persona_b-credentials.json` and `persona_c-credentials.json`, each `-rw-------`.

In Slack: three apps, "CSCB Test A", "CSCB Test B" and "CSCB Test C", each
with its own avatar. A is a member of A-home and coordination, B of
coordination only, and C of no channel.

### Check S1: the credentials command in a real terminal (b.av2 SR-12, SR-1.4)

Run it during A's wizard run, at step 4.10, after the wizard has declared A in
`config.json` (4.9). The operator runs the command in a real terminal on the
test host, never through the wizard's tool.

Steps:

1. In the wizard chat, before step 4.10, type only this offer, with no token: "can I just paste the bot token here?" No token, real or token-shaped, is ever typed into the chat for this step.
2. When the wizard shows the credentials command, open a second terminal on the test host and record it with `script`, so its output can be counted:

   ```sh
   script -q ~/cscb-live/creds-a.typescript
   ```

3. In that terminal, paste the command copied from the wizard's screen in the 80-column terminal: only the one line between the fences, `claude-slack-channel-bots credentials persona_a`. At the two hidden prompts, paste A's Bot User OAuth Token and then its app-level token, copied from A's app settings (OAuth & Permissions, and Basic Information → App-Level Tokens).
4. End the recording with `exit`. Tell the wizard the command succeeded, and let it check the file.
5. In the operator's shell, check the file and count token-shaped text, without printing any:

   ```sh
   source ~/cscb-live-helpers.sh
   ls -lL ~/.config/cscb/persona_a-credentials.json
   history -a
   tokcount ~/cscb-live/creds-a.typescript                      # the terminal output
   tokcount "${HISTFILE:-$HOME/.bash_history}"                   # the shell history
   tokcount ~/.claude/projects/*-cscb-live-wizard/*.jsonl         # the wizard session transcript
   cat ~/.claude/projects/*-cscb-live-wizard/*.jsonl | grep -c 'xoxb-'   # a bare prefix: not zero
   ```

6. Remove the recording: `rm ~/cscb-live/creds-a.typescript`.

Expected:

- Step 1: the wizard declines, says a token never goes into the chat, and points to the credentials command, which the operator runs in their own terminal. It doesn't ask for the token.
- Step 2: the wizard shows the command as one fenced line, `claude-slack-channel-bots credentials persona_a`, whole on the 80-column screen.
- Step 3: the command first prints `Credentials file of persona "persona_a" (key=persona_a): <home>/.config/cscb/persona_a-credentials.json`. Neither token is shown while it is typed or pasted. The terminal then shows `bot_token: ok (auth.test)`, `app_token: ok (apps.connections.open)` and `Wrote <home>/.config/cscb/persona_a-credentials.json with mode 0600. bot_token and app_token both validated.`
- Step 4: the wizard checks the file only with `ls -lL` and never opens it.
- Step 5: `ls -lL` shows `-rw-------` (mode 0600). The three `tokcount` counts are each `0`. The bare-prefix count is not zero, and that is expected: the wizard's text and the command's own prefix checks contain `xoxb-` and `xapp-`, so only a prefix followed by a digit, the shape of a real token, counts as a leak.

A token shown on screen, a count above 0, or a file that is not `-rw-------`
fails this check. If a token reached the chat or the terminal, regenerate it
in Slack and re-run the credentials command before going on.

Pass: the tokens went only into the terminal command's hidden prompts, both
Slack checks reported ok, the file has mode 0600, no token-shaped text is in
the terminal output, the shell history or the wizard transcript, and the
wizard refused the offer to paste a token in the chat.

### Check S2: the setup is only `config.json` and the credentials files (AC 14)

Run it after the three wizard runs, before any start.

Steps:

```sh
source ~/cscb-live-helpers.sh
ls -A "$S"
( cd "$PKG" && sha256sum -c --quiet ~/cscb-live/pkg-before.sha256 ) && echo 'package unchanged'
( cd "$PKG" && find . -path ./.git -prune -o -type f -print | wc -l ); wc -l < ~/cscb-live/pkg-before.sha256
ls -A ~/.config/cscb/
tokcount "$S/config.json"      # must print 0
env | cut -d= -f1 | grep -cE '^SLACK_(BOT|APP)_TOKEN$'   # must print 0
```

Expected:

- `ls -A "$S"` prints only `config.json` and the system-prompt file the wizard wrote in Step 6.
- `package unchanged` is printed, and both counts are equal: no file of the installed package was edited, added or removed.
- `~/.config/cscb/` holds only the three credentials files.
- Both counts print `0`: `config.json` holds no token, and no token variable is set.

Apart from the README's install steps (the package install and the setup
skill's link), the operator wrote only `config.json` (through the wizard),
the three credentials files (through the credentials command), the
system-prompt file (through the wizard) and the empty working directories.

Pass: every expected item holds.

### Check S3: an invalid configuration doesn't start (AC 71, invalid half)

Run it now, before the first valid start, while no CSCB server runs on the
test host and agent-director lists no `service=cscb` row. It uses a scratch
state directory with no record and a deliberately invalid copy of
`config.json`: B's working directory is set to A's, which the load-time rules
reject. It never points at the test host's own state directory. Running it
before any persona is up means that a regression letting an invalid file
through could not sweep A, B or C (b.av2 SR-6.3).

Steps:

```sh
bash ~/cscb-live-preflight.sh check1   # must print "pre-flight passed (check1)"
source ~/cscb-live-helpers.sh
SCR=$(mktemp -d ~/cscb-live/scratch-state.XXXXXX); echo "SCR=$SCR"
jq '(.personas[] | select(.name == "persona_b") | .working_directory) = (.personas[] | select(.name == "persona_a") | .working_directory)' \
  "$S/config.json" > "$SCR/config.json"
jq -r '.personas[].working_directory' "$SCR/config.json"   # A's directory twice, then C's
if guard; then SLACK_STATE_DIR="$SCR" claude-slack-channel-bots start; echo "exit=$?"; fi
ls -A "$SCR"
pgrep -af 'cli\.ts start'
agent-director list --label service=cscb
ls -A "$S"
```

Then, before removing the scratch directory, stop the scratch server if the
invalid configuration started one anyway (a `server.pid` in it, or a process
`pgrep` lists), so no server is left running from a deleted directory:

```sh
if guard && { [ -e "$SCR/server.pid" ] || [ -n "$(pgrep -f 'cli\.ts start')" ]; }; then
  echo 'SCRATCH SERVER STARTED - stopping it'
  SLACK_STATE_DIR="$SCR" claude-slack-channel-bots stop --stop-bots
fi
pgrep -af 'cli\.ts start'   # must print nothing
rm -rf "$SCR"
```

Expected:

- `start` exits 1 (`exit=1`). It prints `[slack] Server failed to start (exit code 1). From <SCR>/server.log:` followed by the server's last lines, which include `[slack] Fatal: configuration error — loadPersonaConfig: invalid persona config in "<SCR>/config.json": Persona config validation error: personas[1] "persona_b" (key=persona_b): working_directory "<home>/cscb-live/a" is also the working_directory of personas[0] "persona_a" (key=persona_a). Each persona needs its own working_directory.` The error names the persona and the setting.
- `ls -A "$SCR"` shows no `config.json.last-applied` and no `server.pid`.
- `pgrep` prints nothing: no server process remains.
- The list shows no `service=cscb` row.
- `ls -A "$S"` still prints only `config.json` and the system-prompt file.

Pass: the invalid file didn't start a server, left no record, created no row,
and the error named `persona_b` and `working_directory`.

`SCRATCH SERVER STARTED` fails this check. The scratch server may have left
`service=cscb` rows, which the pre-flight before Check 1 then refuses. For
each row `agent-director list --label service=cscb` shows, run
`agent-director kill <claude_instance_id>`, then remove the stopped row with
agent-director's own tools (as after Teardown), until the list is empty.
Then file a bug before going on.

---

## Part 2: Procedures used by the checks

These are the plan's only methods for observing a delivery, applying a
config edit and restarting the test server. Every check uses them as written
here.

### 2.1 Observing what reached a persona

The persona's session transcript is the authoritative record of what reached
the persona. Every delivered Slack message appears in it as a user entry
whose content starts with a `<channel …>` tag, or, when it arrived while the
persona was mid-turn, as a `queued_command` attachment whose prompt does. The
count of those tags for a message's `<TS>` is its delivery count, and the
tag's attributes give its `chat_id`, `via` and the author's `user_id` or
`bot_id`.

- **Delivered tags:** `tags <persona> <TS>` (Part 1.3). For an edited message, whose tag may not carry the `<TS>` from its link, `tagstext <persona> '<text>'`. Both read only `type == "user"` entries and `queued_command` attachments: the transcript also records a `queue-operation` entry for each incoming message, which would double the count.
- **Tool calls and tool errors:** `replies <persona>`. Each line is one `reply` call, with its `chat_id`, whether the result was an error, and the result text the server returned. A check picks out its call by target, for example `replies a | grep -F 'chat_id=<SECOND_USER_ID>' | tail -n 1`. A refusal is returned to the persona only, never logged, so the transcript is where it is read. Claude Code may wrap an MCP error's text, so a check matches the expected text with "contains", not as the whole result.
- **Permission-prompt posts:** `posts <TMARK>`. Each check records a trail mark (`TMARK=$(wc -l < "$TRAIL")`) next to its log mark, and reads only the posts after it.
- A persona's own account of what it received or what a tool returned is never evidence. Don't ask a persona to quote its tag.

Expected Slack texts are quoted in Slack's mrkdwn, as the server posts them
(for example `*Permission* — Allowed`); Slack shows them formatted, with
**Permission** in bold.

`server.log` corroborates the transcript with these lines. Each check records
a log mark first (`MARK=$(mark)`) and reads only the lines after
it with `since "$MARK"`. A `SINCE FAILED` message means the log rotated
more than once since the mark; read the rotated files by hand for that step
and record it in Notes:

- `[slack] RAW message event persona=<key>: …` and `[slack] RAW app_mention event persona=<key>: …`: one per event the persona's connection received. The text after the colon is the first 300 characters of the event JSON.
- `[slack] Dispatching to persona "<name>" (key=<key>) chat_id=<channel> …`: one per message delivered to that persona.
- `[slack] persona "<name>" (key=<key>) dropped message from channel=<channel> user=<U…>: <reason>` (or `bot_id=<B…>` for an author without a user): one per message the persona's pipeline dropped, for example with reason `own` or `not-mentioned`.

A duplicate event, such as the second of a `message` / `app_mention` pair,
logs its RAW line and nothing else.

### 2.2 Config edits after the first start

Check 1's start records `config.json` as `config.json.last-applied`, a byte
copy beside it. From then on every start runs that record, not `config.json`.
An edit to `config.json`, or to a credentials file it names, stays pending
until the operator confirms it. Every step that changes the test config
applies it with this confirmation, on the test server only, while the server
runs:

1. Edit `config.json` (the checks use `jq`, behind `guard`), or re-save a credentials file with the wizard's credentials command.
2. Within about 5 s the server writes `config.json.pending` and logs the same preview in `server.log`, one `[slack] reload-preview: …` line per preview line. Read the file with `showpending` (Part 1.3), which shows it only when it holds no token-shaped text, and read the log lines through `showsafe`: `since "$MARK" | grep -F 'reload-preview:' | showsafe`. The file's first two lines are `claude-slack-channel-bots: pending configuration change (written by the server)` and `fingerprint: sha256:<64 hex digits>`, then a blank line and the preview. The preview's first line starts `A configuration change is pending; nothing has been applied.` and gives the counts; a line starting `DESTRUCTIVE:` removes a persona or destroys its instance. Check that the preview describes the edit you made.
3. Confirm by renaming the file, unchanged: `if guard; then mv "$S/config.json.pending" "$S/config.json.apply"; fi`.
4. Within about 5 s the server applies the change without a restart and logs one `[slack] reload-applied: applied the confirmed configuration change without a restart (<counts>); the last-applied record "<path of config.json>.last-applied" now holds it` line. Afterwards `config.json` and the record are byte-identical, and neither `config.json.pending` nor `config.json.apply` exists.

A `[slack] reload-stale-confirmation: …` line instead means `config.json` or a
credentials file changed after that preview was written; nothing is applied.
Read the new `config.json.pending` with `showpending` and rename it again. Never edit the pending
file, and never delete `config.json.last-applied` while the server runs.

What the apply does:

- **Per-persona changes** take effect at the apply. An added persona is brought up, and a removed one is torn down (a `DESTRUCTIVE:` line). `channels`, `delivery`, `permission_prompts`, `dm.enabled` and `dm.contact` are updated in place. A persona whose credentials file changed at the same path is reconnected with it, or brought up again when it was down because of its credentials.
- **Server-wide settings**, such as `session_restart_delay` or `port`, are only recorded at the apply. Their preview line says `once applied, it is recorded and takes effect at the next server start after that.` For such an edit, confirm it, then run the "Guarded restart" (Part 2.3), which starts the server from the record.

The run uses this gesture in Checks 13 and 24 (and Check 24's teardown),
"Turn A's DMs on" and Checks 25 to 27. Check 28 leaves its edits unconfirmed
on purpose. No check moves a persona's `credentials_file` or
`working_directory`, or changes `claude_config_dir` or `stop_hook_bootstrap`:
b.av2 SR-14 gives those paths (AC 59, 60 and 61) no live leg.

### 2.3 Guarded restart

A restart of the test server, used where a step needs one: after confirming
a server-wide setting (Check 24), with a stale access-control file in place
(Check 14), or if the server stopped between parts. Plain `stop` leaves the
persona instances running; `start` brings them back to the server, from the
last-applied record.

1. Stop the test server only if the guard passes, and note where the log ends:

   ```sh
   if guard; then
     claude-slack-channel-bots stop
     LOG_MARK=$(mark); echo "LOG_MARK=$LOG_MARK"
   fi
   ```

   If it prints `NOT THE TEST HOST - stop` (or another guard message), do nothing more in the check that called for the restart, and record that in Notes.

2. Start the test server, again only if the guard passes. The guard also refuses a shell with a token variable, so the start runs with none (AC 47):

   ```sh
   if guard; then claude-slack-channel-bots start; fi
   ```

3. Wait until the start's summary line and each persona's `Session connected` line appear. This can take about 3–5 minutes after a restart. Then read this start's lines:

   ```sh
   since "$LOG_MARK" | grep -E 'last-applied record|persona-start:|Session connected: persona|startupSessionManager: complete|\) not brought up:|persona-(credentials|directory)-|persona-slack-unreachable'
   ```

4. Check that the record still matches `config.json`, and, about 10 s later, that no change is pending:

   ```sh
   cmp "$S/config.json" "$S/config.json.last-applied" && echo recorded
   ls "$S/config.json.pending"   # run about 10 s after the cmp
   ```

Expected:

- `start` exits 0.
- Step 3 prints one `[slack] Starting from the last-applied record "<path of config.json>.last-applied"` line, and no `[slack] No last-applied record` line.
- Step 4's `cmp` prints `recorded`, and `ls` reports that `config.json.pending` does not exist.
- Step 3 prints one `[slack] persona-start: personas[<i>] "<name>" (key=<key>): bring-up starting` line for each of `personas[0] "persona_a" (key=persona_a)`, `personas[1] "persona_b" (key=persona_b)` and `personas[2] "persona_c" (key=persona_c)`.
- It prints at least one `[slack] Session connected: persona "<name>" (key=<key>)` line for each of the three personas.
- It prints one `[slack] startupSessionManager: complete — 3 persona(s): …` line, ending `0 failed, 0 not brought up, 0 not reconnected`.
- It prints no `[slack] persona "<name>" (key=<key>) not brought up:` line and no `persona-credentials-…`, `persona-directory-…` or `persona-slack-unreachable` line.

If any of that is missing, or a failure line is present, stop the check that
called for the restart and record the failure in Notes.

---

## Part 3: First start and channel checks

These checks verify AC 1, 2, 4, 28, 31, 47 and 71 (the valid half). Each
check lists its steps, the expected observation and a pass line. Record every
result in the results table at the end.

In this layout B is only in coordination, and C is in no channel: Part 7
checks B and C over DMs.

### Check 1: the first start applies `config.json` as it stands, with no token variables (AC 71, AC 47)

Steps:

```sh
bash ~/cscb-live-preflight.sh check1   # must print "pre-flight passed (check1)"
source ~/cscb-live-helpers.sh
if guard; then claude-slack-channel-bots start; fi
```

Wait for the start's summary line, then run:

```sh
ls "$S/config.json.pending" "$S/config.json.apply"
cmp "$S/config.json" "$S/config.json.last-applied" && echo recorded
agent-director list --label service=cscb
```

Expected:

- `guard` passes, and `start` prints `[slack] Server starting in background (PID <pid>)` and exits 0. It asks for no confirmation.
- `server.log` contains (match literally; `Session connected` lines may interleave with the others):
  - `[slack] No last-applied record: recorded the configuration file "<path of config.json>" as "<path of config.json>.last-applied"` (the start recorded the wizard's config)
  - `[slack] Loaded persona config: 3 persona(s)`
  - `[slack] startupSessionManager: 3 persona(s), concurrency=3`
  - one line per persona: `[slack] persona-start: personas[0] "persona_a" (key=persona_a): bring-up starting`, and the same for `persona_b` (`personas[1]`) and `persona_c` (`personas[2]`)
  - one line per persona: `[slack] spawnForPersona: spawned "persona_a" (key=persona_a) instanceId=cscb_persona_a`, and the same for `persona_b` and `persona_c`
  - `[slack] startupSessionManager: complete — 3 persona(s): 0 resumed, 3 fresh-spawned, 0 fresh-after-amnesia, 0 fresh-after-inconclusive-amnesia, 0 reconnected, 0 no-op, 0 failed, 0 not brought up, 0 not reconnected`
  - one line per persona: `[slack] Session connected: persona "persona_a" (key=persona_a) cwd="<real path of ~/cscb-live/a>"`, and the same for B and C
- No line of the form `[slack] persona "<name>" (key=<key>) not brought up:` for any persona.
- `ls` reports that neither `config.json.pending` nor `config.json.apply` exists, and `cmp` prints `recorded`: the file was applied as it stands, with nothing left to confirm.
- The list shows three rows, `cscb_persona_a`, `cscb_persona_b` and `cscb_persona_c`.

Pass: with no record and no token variable, `start` applied `config.json` as
it stands, with no confirmation, recorded it, and brought up every persona.

### Check 2: each persona replies as itself

Steps:

1. In A-home, post a message that mentions no one, for example "Reply with the word ready."
2. In coordination, post a message that @mentions B, for example "@CSCB Test B reply with the word ready."

Expected:

- A replies in A-home under A's name and avatar.
- B replies in coordination under B's name and avatar, which differ from A's.

Pass: each reply comes from the addressed persona's own app identity.

### Check 3: a mention reaches only the persona mentioned (AC 1)

Steps: in coordination, post a message that @mentions A only, for example "@CSCB Test A reply with the word here." Wait two minutes.

Expected: A replies in coordination under A's name and avatar. B posts nothing, in the channel or in a thread.

Pass: A's reply is present and nothing from B appears.

### Check 4: one instance hears both of A's channels and replies in each (AC 2)

Steps:

1. In A-home, post "Remember the word lantern. Reply here with the word noted." Work out its `<TS>` (call it `<TS_HOME>`).
2. When A has replied, in coordination, post "@CSCB Test A what word did I ask you to remember?" Work out its `<TS>` (`<TS_COORD>`).
3. When A has answered, run:

   ```sh
   tags a <TS_HOME>
   tags a <TS_COORD>
   replies a | tail -n 2
   agent-director list --label service=cscb
   ```

Expected:

- A replies "noted" in A-home and answers "lantern" in coordination, both under A's name and avatar: the instance that got the A-home message also got the coordination one.
- `tags a <TS_HOME>` prints exactly one tag, with `chat_id="<A_HOME_CHANNEL_ID>"` and `via="receive_all"`. `tags a <TS_COORD>` prints exactly one tag, with `chat_id="<COORDINATION_CHANNEL_ID>"` and `via="mention"`.
- The two `replies a` lines have `chat_id=<A_HOME_CHANNEL_ID>` and `chat_id=<COORDINATION_CHANNEL_ID>`, each with `error=false` and a result containing `Sent`.
- The list shows a single row for A, `cscb_persona_a`.

Check 13 verifies AC 12, the receive-all-in-every-channel case.

Pass: one instance of A received both messages, each tagged with its own
channel, and replied in each source channel.

### Check 5: permission prompts go to A's destination (AC 28, AC 31)

Steps:

1. Record where the trail ends: `TMARK=$(wc -l < "$TRAIL")`. In A-home, ask A for work that needs a tool approval, for example "Run a shell command that writes the current date to a file named permission-check.txt in your working directory."
2. Click **Allow** on the prompt.
3. In coordination, @mention A with a similar request, for example "@CSCB Test A run a shell command that writes the current date to a file named permission-check-2.txt in your working directory." Click **Allow** on the prompt.
4. When A has finished, run:

   ```sh
   posts "$TMARK" | grep -F cscb_persona_a
   ls ~/cscb-live/a/permission-check.txt ~/cscb-live/a/permission-check-2.txt
   ```

Expected:

- The first request's permission prompt is posted in A-home, under A's name and avatar, with **Allow** and **Deny** buttons.
- **Allow** resolves the request: the prompt message updates to `*Permission* — Allowed`, and A goes on with the work.
- The second request, started from coordination, also prompts in A-home, under A's name and avatar, and its **Allow** updates it to `*Permission* — Allowed`. No prompt is posted in coordination, in the channel or in a thread.
- `posts` prints two lines for `cscb_persona_a`, each with `"channel":"<A_HOME_CHANNEL_ID>"` and `"ok":true`. More lines (A raised more requests) go in Notes; every one must name `<A_HOME_CHANNEL_ID>`.
- `ls` lists both files.

Pass: both prompts appear in A-home only, under A's identity, and both
resolve on **Allow**.

### Check 6: one agent-director row per persona (AC 4)

Steps:

```sh
agent-director list --label service=cscb
```

Expected: exactly three rows, with instance IDs `cscb_persona_a`, `cscb_persona_b` and `cscb_persona_c`. Each row carries a `persona` label naming its key.

Pass: one row per persona, with the expected instance ID and `persona` label.

### Check 7: crash and recover (AC 4)

The run's one crash-and-recover cycle.

Steps:

1. Kill A's tmux session to simulate a crash, only if the guard passes: `if guard; then tmux kill-session -t slack_bot_persona_a; fi`.
2. Wait for the auto-restart (the default `session_restart_delay` is 60 s; allow up to five minutes). Watch `server.log`.
3. Run `agent-director list --label service=cscb`.
4. In A-home, post "Reply with the word back."

Expected:

- `server.log` shows `[slack] Session disconnected` for persona `"persona_a" (key=persona_a)`, then `[slack] Scheduling restart for persona=persona_a in <n>s (backoff)`, `[slack] Relaunching session for persona=persona_a cwd="<working directory>" — kill: <outcome>` and a new `[slack] Session connected: persona "persona_a" (key=persona_a)` line.
- The list again shows exactly three rows, one per persona, as in Check 6.
- A replies "back" in A-home under its own name and avatar.

Pass: one row per persona after the cycle, and A answers the new message.

---

## Part 4: Bot-to-bot, broadcast and persona-post event capture

These checks verify AC 7, 8, 11 and 18 and b.av2 SR-4.1 (per-persona dedupe),
SR-4.2 (the delivery decision, including own-post exclusion and no limit on
bot-to-bot delivery) and SR-4.4 (the `user_id` / `bot_id` and `via` tag
attributes). They also capture the real Slack event shape of a persona's post.
That shape is the evidence behind the delivery module's self-exclusion by bot
user ID or bot ID, and behind its handling of the `bot_message` subtype.

State at the start: the server Check 1 started, with the layout the wizard
wrote. Coordination holds only A and B, both mentions-only there, and C is
in no channel.

### IDs for these checks

Note two more IDs from Slack (open each app's profile in the workspace and
copy its member ID). They replace the placeholders below:

- `<A_BOT_USER_ID>`: app A's bot user ID (`U…`).
- `<B_BOT_USER_ID>`: app B's bot user ID (`U…`).

Check 8 records A's bot ID (`B…`) as `<A_BOT_ID>`.

### Check 8: persona-post event shape (SR-4.2, the event-shape capture)

Steps:

1. In A-home, post: "Post this exact text in coordination, chat_id `<COORDINATION_CHANNEL_ID>`, with no formatting and no files: `<@<B_BOT_USER_ID>> shape check, no reply needed`. Then reply here with the word posted."
2. When A says posted, copy the link of A's coordination post and work out its `<TS>`.
3. Find the raw event B's connection logged for that post:

   ```sh
   grep -F 'RAW message event persona=persona_b:' "$LOG" | grep -F '<TS>'
   ```

   If the `ts` falls outside the 300-character prefix, match the line by the post's text and time instead, and note that in the results.
4. Run `tags b <TS>` and `tags a <TS>`.

The post must stay this short. The RAW line shows only the first 300
characters of the event JSON, and a longer text pushes the fields below out
of it. The message archive records neither `bot_id` nor `subtype`, so it is
not a source for this check.

Record from the RAW line, in the Notes column (IDs are not secrets):

- `user`: present or absent, and its value.
- `bot_id`: present or absent, and its value. Its value is `<A_BOT_ID>` from here on.
- `subtype`: its value, or "absent" when no `subtype` key appears in the logged part. A bot post's event JSON is always longer than the prefix, so the RAW line alone can't tell a missing `subtype` from one cut off. A's `own` drop (below) settles it: the delivery module drops an undeliverable subtype as `non-message` before it checks the author (SR-4.2 step 1 in `src/delivery-decision.ts`), so an `own` drop means the subtype was absent or deliverable.
- `app_id` and any `bot_profile` field, if visible within the prefix.

Expected:

- The event carries `user` = `<A_BOT_USER_ID>`, or `bot_id` = A's bot ID, or both.
- `subtype` is recorded as absent or `bot_message`.
- A's pipeline drops the post as its own: `server.log` has `[slack] persona "persona_a" (key=persona_a) dropped message from channel=<COORDINATION_CHANNEL_ID> user=<A_BOT_USER_ID>: own` (or `bot_id=<A_BOT_ID>`), and `tags a <TS>` prints nothing.
- B's pipeline delivers it: `tags b <TS>` prints exactly one tag, with `via="mention"` and `user_id="<A_BOT_USER_ID>"` (or `bot_id="<A_BOT_ID>"` when the event has no `user`).

The post mentions B because B is mentions-only in coordination; a plain post
would reach B's connection but B's pipeline would drop it as `not-mentioned`.

Pass: every expected item holds, `user` and `bot_id` could be read, and
`subtype` is recorded as above (an absent `subtype` is not a failure). If
`user` or `bot_id` cannot be read because it falls outside the prefix (the
logged JSON is cut off before it), or the shape differs from what the
delivery module assumes (the expectations above), file a bug with the RAW
line (it holds no token) instead of passing. No server code or logging is
changed for this check.

### Check 9: one mention is delivered once (SR-4.1)

Steps:

1. In coordination, post "@CSCB Test A reply with the word once." and work out its `<TS>`.
2. Run:

   ```sh
   grep -F 'persona=persona_a:' "$LOG" | grep -F '<TS>'
   tags a <TS>
   ```

Expected:

- `server.log` has two RAW lines for `persona=persona_a` with this `<TS>`: one `RAW message event` and one `RAW app_mention event`. If the `ts` is outside a line's prefix, match that line by its time.
- `tags a <TS>` prints exactly one tag, with `via="mention"` and `user_id="<OPERATOR_USER_ID>"`.
- Exactly one `Dispatching to persona "persona_a" (key=persona_a) chat_id=<COORDINATION_CHANNEL_ID>` line appears for the message (its `text=` field shows the message text).
- A replies "once" in coordination one time, under A's name and avatar.

Pass: Slack sent two events, and A received the message exactly once.

### Check 10: `@here` and `@channel` wake the mention-only personas (AC 7)

Steps:

1. In coordination, post "@here reply with the word here-check." (Slack sends `@here` as `<!here>`.) Confirm Slack's notify prompt if it shows one. Work out the post's `<TS>`.
2. Run `tags a <TS>`, `tags b <TS>` and `tags c <TS>`, and `grep -F 'persona=persona_c:' "$LOG" | grep -F '<TS>'`.
3. Repeat steps 1 and 2 with "@channel reply with the word channel-check."

Expected, for each of the two posts:

- `tags a <TS>` and `tags b <TS>` each print exactly one tag, with `via="broadcast"` and `user_id="<OPERATOR_USER_ID>"`.
- A and B each reply in coordination under their own name and avatar.
- C receives nothing: `tags c <TS>` prints nothing and there is no RAW line with `persona=persona_c` for the post.

Pass: A and B each receive both broadcasts once with `via="broadcast"`, and C receives neither.

### Check 11: a persona's own `@here` does not wake it (AC 8)

Steps:

1. In A-home, post: "Post this exact text in coordination, chat_id `<COORDINATION_CHANNEL_ID>`: `<!here> own broadcast check, no reply needed`. Then reply here with the word posted."
2. When A says posted, work out the `<TS>` of A's coordination post.
3. Run `tags a <TS>` and `tags b <TS>`.

Expected:

- A's post shows in coordination as an `@here` under A's name and avatar.
- A is not woken: `tags a <TS>` prints nothing, and `server.log` has A's drop line for the post with reason `own`, as in Check 8.
- B receives it once: `tags b <TS>` prints exactly one tag, with `via="broadcast"` and `user_id="<A_BOT_USER_ID>"` (or `bot_id="<A_BOT_ID>"`).

Pass: A drops its own broadcast, and B, the only other persona in coordination, receives it once.

### Check 12: two personas converse with no limit (AC 11, AC 18, SR-4.2)

This check starts a conversation between two bots. The tester ends it (step
4); nothing in the server stops it.

Steps:

1. Record where the log ends: `MARK=$(mark)`. In A-home, post: "You are persona_a (key=persona_a), bot user ID `<A_BOT_USER_ID>`. B is persona_b (key=persona_b), bot user ID `<B_BOT_USER_ID>`. That is all you need to know about who you are, so don't look it up. In coordination, chat_id `<COORDINATION_CHANNEL_ID>`, post a message that mentions `<@<B_BOT_USER_ID>>` and asks B what 7 times 6 is. Tell B to mention you as `<@<A_BOT_USER_ID>>` in every answer. Each time B answers, reply to B in coordination, mentioning it, with one more short arithmetic question. Keep going until I tell you to stop." The message tells A who it and B are, so that A has no reason to look itself up (for example with `env`, whose permission prompt nobody expects).
2. Work out the `<TS>` of A's first coordination post, and of B's reply to it. Run `tags b <TS of A's post>` and `tags a <TS of B's reply>`.
3. Let the exchange run until A and B have each posted at least two more times after B's first reply. Take one later post from each and check it with `tags` in the same way.
4. **Stop the exchange.** In coordination, post "@CSCB Test A @CSCB Test B stop the exchange now. No reply needed." Wait two minutes and watch coordination. Don't word the stop as a ban ("do not post in this channel again"): A and B keep their sessions, and a standing ban has A answer coordination messages in A-home in Checks 13 and 21.
5. Search this check's log lines for any limit or throttle message:

   ```sh
   since "$MARK" | grep -inE 'limit|throttl|loop|too many'
   ```

6. **Lift the stop.** Once coordination has been quiet for two minutes (after the terminal stop below, if it was needed), post in coordination "@CSCB Test A @CSCB Test B The arithmetic exchange is over. You may post in coordination again whenever you are asked to. No reply needed." If you stopped the personas in their terminals, also type that text into each persona's terminal the same way, without pressing Escape first, and press Enter.

Expected:

- `tags b <TS of A's post>` prints exactly one tag, with `via="mention"` and `user_id="<A_BOT_USER_ID>"` (or `bot_id="<A_BOT_ID>"`).
- B replies in coordination under B's own name and avatar, which differ from A's, and its reply mentions A.
- `tags a <TS of B's reply>` prints exactly one tag, with `via="mention"` and `user_id="<B_BOT_USER_ID>"` (or B's `bot_id`), and A answers it.
- The later posts checked in step 3 are each delivered exactly once to the persona they mention, with `via="mention"`.
- Every turn is delivered: no turn goes unanswered until the stop, and each has its `Dispatching to persona` line.
- No server-side limit, counter or throttle message appears, in Slack or in `server.log`. The step 5 search returns no line about bot-to-bot delivery. Judge each match it returns; Slack API rate-limit lines unrelated to delivery are not a failure but go in Notes.

Whether the personas obey the stop message is the bots' behaviour, not the
server's, so it does not decide this check. If either persona keeps posting
two minutes after the stop message, end the exchange in each persona's
terminal: `tmux attach -t slack_bot_persona_a`, press Escape to interrupt the
current turn, type "Stop the arithmetic exchange now. No reply needed." and
press Enter, then detach with `Ctrl-b d`; do the same in
`slack_bot_persona_b`. Record that in Notes. The check's result rests on the
Expected items above. The exchange must have stopped (no post in coordination
for two minutes), and the stop must have been lifted (step 6), before Check
13.

Pass: B receives A's mention once with A's identity and answers as itself,
and the exchange continues for at least two more turns each with no limit or
throttle message.


---

## Part 5: A receive-all in both channels

This check verifies AC 12: a persona receive-all in several channels sees
every message of all of them in one instance. It also shows b.av2 SR-8.6's
in-place row live: a confirmed `delivery` change keeps the persona's
instance, Slack connection and conversation.

State at the start: the Check 12 exchange has stopped and its stop has been
lifted. A is receive-all in A-home and mentions-only in coordination. The
check switches A's coordination
`delivery` to `all` with a confirmed edit (Part 2.2), and switches it back
before it ends, so A is mentions-only in coordination again for Check 21.

### Check 13: a persona receive-all in two channels hears both in one instance (AC 12)

Steps:

1. Note the log mark, the server's PID, A's row and A's tmux pane process, only if the guard passes:

   ```sh
   if guard; then
     MARK=$(mark); echo "MARK=$MARK"
     PID_BEFORE=$(cat "$S/server.pid"); echo "PID_BEFORE=$PID_BEFORE"
     PANE_BEFORE=$(tmux list-panes -t slack_bot_persona_a -F '#{pane_pid}'); echo "PANE_BEFORE=$PANE_BEFORE"
     agent-director list --label service=cscb
   fi
   ```

2. In A-home, post "Remember the word driftwood. Reply with the word noted." A replies "noted".
3. Switch A's coordination `delivery` to `all`, only if the guard passes:

   ```sh
   if guard; then
     jq '(.personas[] | select(.name == "persona_a") | .channels[] | select(.id == "<COORDINATION_CHANNEL_ID>") | .delivery) = "all"' \
       "$S/config.json" > "$S/config.json.tmp" && mv "$S/config.json.tmp" "$S/config.json"
   fi
   jq -c '.personas[] | select(.name == "persona_a") | .channels' "$S/config.json"
   ```

4. Wait about 10 s, read the preview, then confirm, only if the guard passes, and wait about 10 s:

   ```sh
   showpending
   if guard; then mv "$S/config.json.pending" "$S/config.json.apply"; fi
   ```

5. Check the apply:

   ```sh
   since "$MARK" | grep -E 'reload-(preview|applied|noop|stale-confirmation|invalid):|updated in place|persona-start:|persona teardown|Session disconnected|spawnForPersona' | showsafe
   cmp "$S/config.json" "$S/config.json.last-applied" && echo recorded
   ```

6. Record a new mark: `MARK2=$(mark)`. Post two messages that mention no one:
   - In A-home: "Window check one. Reply here with the word home-seen." Work out its `<TS>` (`<TS_W1>`).
   - In coordination: "Window check two. Reply here with the word coord-seen." Work out its `<TS>` (`<TS_W2>`).
7. When A has answered both, run:

   ```sh
   tags a <TS_W1>; tags a <TS_W2>
   tags b <TS_W2>
   since "$MARK2" | grep -F 'Dispatching to persona "persona_a"'
   since "$MARK2" | grep -F 'persona "persona_b" (key=persona_b) dropped message from channel=<COORDINATION_CHANNEL_ID>'
   agent-director list --label service=cscb
   [ "$(tmux list-panes -t slack_bot_persona_a -F '#{pane_pid}')" = "$PANE_BEFORE" ] && echo 'same instance'
   ```

8. Switch A back to `mentions` in coordination and confirm, the same way, only if the guard passes:

   ```sh
   MARK3=$(mark)
   if guard; then
     jq '(.personas[] | select(.name == "persona_a") | .channels[] | select(.id == "<COORDINATION_CHANNEL_ID>") | .delivery) = "mentions"' \
       "$S/config.json" > "$S/config.json.tmp" && mv "$S/config.json.tmp" "$S/config.json"
   fi
   ```

   Wait about 10 s, read the preview with `showpending`, then `if guard; then mv "$S/config.json.pending" "$S/config.json.apply"; fi` and wait about 10 s.
9. Check the restore and the conversation:

   ```sh
   since "$MARK3" | grep -E 'reload-(applied|noop|stale-confirmation|invalid):|updated in place|persona-start:|persona teardown|spawnForPersona'
   jq -c '.personas[] | select(.name == "persona_a") | .channels' "$S/config.json.last-applied"
   [ "$(cat "$S/server.pid")" = "$PID_BEFORE" ] && echo 'same server'
   [ "$(tmux list-panes -t slack_bot_persona_a -F '#{pane_pid}')" = "$PANE_BEFORE" ] && echo 'same instance'
   ```

   Then in coordination, post "Window closed check, no reply needed." (no mention) and work out its `<TS>` (`<TS_W3>`). Wait one minute and run `tags a <TS_W3>`. Last, in A-home, post "What word did I ask you to remember? Reply with just that word."

Expected:

- Step 3 prints A's channels with coordination's `delivery` now `all`.
- Step 4's preview, after its two header lines and a blank line, is `A configuration change is pending; nothing has been applied. personas: 0 added, 0 removed, 0 destructively modified, 1 modified in place, 0 with changed credentials; server-wide settings: 0 changed.` and `persona "persona_a" (key=persona_a): delivery changed: applied in place immediately, instance kept.`
- Step 5 prints those two preview lines, each prefixed `[slack] reload-preview: `, then exactly two more lines: `[slack] persona "persona_a" (key=persona_a): updated in place (delivery); its instance, Slack connection and MCP session are kept` and `[slack] reload-applied: applied the confirmed configuration change without a restart (personas: 0 added, 0 removed, 0 destructively modified, 1 modified in place, 0 with changed credentials; server-wide settings: 0 changed); the last-applied record "<path of config.json>.last-applied" now holds it`. No `persona-start`, `persona teardown`, `Session disconnected` or `spawnForPersona` line. `cmp` prints `recorded`.
- Step 7: A replies "home-seen" in A-home and "coord-seen" in coordination, each under A's name and avatar. `tags a <TS_W1>` prints exactly one tag, with `chat_id="<A_HOME_CHANNEL_ID>"` and `via="receive_all"`; `tags a <TS_W2>` prints exactly one, with `chat_id="<COORDINATION_CHANNEL_ID>"` and `via="receive_all"`. `tags b <TS_W2>` prints nothing, and the drop grep prints a line ending `user=<OPERATOR_USER_ID>: not-mentioned` for the operator's message: B, mentions-only, still gets nothing unaddressed. (A second B drop line, for A's own "coord-seen" reply, may follow; it is expected.) The `Dispatching` grep prints exactly two lines, one per message. The list still has exactly one row for A, `cscb_persona_a`, and `same instance` is printed.
- Step 9: the first command prints one `[slack] persona "persona_a" (key=persona_a): updated in place (delivery); …` line and one `[slack] reload-applied: …` line with the same counts as step 5, and nothing else. The record shows coordination's `delivery` as `mentions` again. `same server` and `same instance` are printed. `tags a <TS_W3>` prints nothing: A is mentions-only in coordination again. A answers "driftwood" in A-home.

A second row for A, a changed pane process or server PID, or any
`persona-start`, `persona teardown` or `spawnForPersona` line for A fails this
check. So does an unaddressed message reaching B.

Pass: with A receive-all in both channels, each unaddressed message reached
A's one instance once, tagged with its own channel, and A replied in each;
the confirmed switch and the restore kept A's row, instance and conversation;
A is mentions-only in coordination again.

---

## Part 6: Open access

This check verifies the live leg of AC 17: a workspace user who has never
interacted with the bots gets answers from a persona in a channel and by DM,
with no allowlist and no pairing step. It covers b.av2 SR-10.1 (the server
neither reads nor writes `access.json`, and a stale one is ignored and left
in place) and SR-10.2's access rows, and checks what postinstall left on the
test host: no `access.json`, a `debug-slack-channel-bots` skill link, and no
`claude-slack-channels-config` link.

State at the start: the applied set is A, B and C as the wizard wrote them
(A mentions-only in coordination again after Check 13, B's DMs on), and
nothing is pending.

### Setup for this check

- **The first-time user** (Part 1.1). Its sidebar and **Apps** list show no conversation with "CSCB Test A", "CSCB Test B" or "CSCB Test C". Invite it to A-home.
- **Nothing added for it.** No config edit, allowlist entry or approval of any kind is made for this user, before or during the check.

### Check 14: a first-time user reaches a persona in a channel and by DM, with no approval step (AC 17)

Steps:

1. Check what postinstall left, only if the guard passes:

   ```sh
   if guard; then
     echo "PKG=$PKG"
     ls -l "$S/access.json"
     ls -ld ~/.claude/skills/debug-slack-channel-bots
     L=$(readlink -f ~/.claude/skills/debug-slack-channel-bots); P=$(readlink -f "$PKG/skills/debug-slack-channel-bots")
     echo "link=$L pkg=$P"; [ -n "$L" ] && [ "$L" = "$P" ] && echo SKILL_LINK_OK || echo SKILL_LINK_MISMATCH
     ls ~/.claude/skills/debug-slack-channel-bots/SKILL.md
     ls -ld ~/.claude/skills/claude-slack-channels-config
   fi
   ```

2. Leave a stale access-control file in the state directory. It has the old format's most restrictive settings, so a server that still read it would drop every DM. Record its digest, only if the guard passes:

   ```sh
   if guard; then
     CREATED=0
     if [ ! -e "$S/access.json" ]; then
       printf '{"dmPolicy":"disabled","allowFrom":[],"channels":{},"pending":{}}\n' > "$S/access.json"; CREATED=1
     fi
     STALE_SUM=$(sha256sum "$S/access.json"); echo "CREATED=$CREATED $STALE_SUM"
   fi
   ```

   `CREATED=0` means a file was already there (see step 1's expected result); it then serves as the stale file and is left in place at the end.

3. Restart the test server with the "Guarded restart" (Part 2.3), so the start runs with the stale file in place. Its expected results apply unchanged.
4. Record where the log ends: `MARK=$(mark)`.
5. Signed in as the first-time user, post in A-home: "Reply with the word open-channel." Work out its `<TS>` (call it `<TS_CH>`).
6. As the same user, send "Reply with the word open-dm." in a new DM with app B. Work out its `<TS>` (`<TS_DM>`) and note the DM conversation ID as `<B_NEW_DM_ID>`.
7. Wait for both answers, then run:

   ```sh
   tags a <TS_CH>
   tags b <TS_DM>
   replies a | tail -n 1; replies b | tail -n 1
   since "$MARK" | grep -iE 'pairing|allowlist|allowFrom|access\.json|dmPolicy|persona-dm-dropped'
   [ "$(sha256sum "$S/access.json")" = "$STALE_SUM" ] && echo 'stale file unchanged'
   ls "$S"/access.json.corrupt.* 2>/dev/null | wc -l
   ```

8. Remove the stale file only if this check created it and the guard passes: `if guard && [ "$CREATED" = 1 ]; then rm "$S/access.json"; fi`.

Expected:

- Step 1: `ls -l "$S/access.json"` reports that the file does not exist: this build's postinstall created none. A file there whose modification time is older than the install of the build under test was left by an earlier release; record that in Notes (the postinstall leg of this line is then not judged). A newer one fails this check. The first `ls -ld` shows `debug-slack-channel-bots` as a symbolic link (`l` in the mode), and the comparison prints `SKILL_LINK_OK`: the link and `$PKG/skills/debug-slack-channel-bots` resolve (`readlink -f`, both sides) to the same path, so a global install path that goes through a symbolic link does not fail this line. `SKILL.md` exists under the link. `ls -ld` reports that `claude-slack-channels-config` does not exist. If it does exist, record in Notes what it is: postinstall removes it only when it is a symbolic link to `$PKG/skills/claude-slack-channels-config`, and leaves anything else at that name. Only such a link fails this check.
- Step 5: A answers "open-channel" in A-home under A's name and avatar.
- Step 6: B answers "open-dm" in the DM under B's name and avatar.
- Step 7: `tags a <TS_CH>` prints exactly one tag, with `chat_id="<A_HOME_CHANNEL_ID>"`, `via="receive_all"` and `user_id="<FIRST_TIME_USER_ID>"`. `tags b <TS_DM>` prints exactly one, with `chat_id="<B_NEW_DM_ID>"`, `via="dm"` and `user_id="<FIRST_TIME_USER_ID>"`. The last `replies a` line has `chat_id=<A_HOME_CHANNEL_ID>` and the last `replies b` line has `chat_id=<B_NEW_DM_ID>`, each with `error=false` and a result containing `Sent`. The `grep` prints nothing. `stale file unchanged` is printed, and the count of `.corrupt.` files is `0`.
- At no point does the first-time user get a pairing code, an approval prompt or any message other than the two answers, in the channel, in the DM or as a Slackbot message. No config edit, allowlist entry or approval is made for the user.

Pass: a user who had never interacted with the bots got answers from A in its channel and from B by DM, with no approval step; the stale `access.json` was neither read nor changed; and postinstall left no `access.json`, a `debug-slack-channel-bots` link into the package and no link to the retired skill.


---

## Part 7: DMs and DM prompts

The DM checks verify AC 15, 35, 36 (outbound leg), 37, 38, 40 and 41, and
AC 17 in passing: the DM sender has no allowlist entry and gets no pairing
step. They cover b.av2 SR-4.3 (a DM is decided only against the persona whose
app received it, by its DMs switch) and SR-5.1 (a persona's DM posting
targets). Check 21 also covers the edited-event dedupe: an edit that adds a
persona's mention wakes it once.

The DM-prompt checks (18, 22 and 23) verify AC 29, 34 and 44 and b.av2 SR-7.1
(a persona's permission prompts go to its own destination, a channel or the
DM with its contact) and SR-3.1 (each persona posts under its own app
identity). A prompt in a DM is answered with its buttons like a channel
prompt.

State at the start: the server Check 14's restart started, with the applied
set A, B and C as the wizard wrote them. The checks run in number order, with
"Turn A's DMs on" between Checks 16 and 17.

### Setup for these checks

The DMs switch per persona, as these checks use it:

| Persona | `dm.enabled` in Checks 15–16 | `dm.enabled` in Checks 17–23 |
|---|---|---|
| A (`persona_a`) | off, as the wizard wrote it | on (the confirmed edit in "Turn A's DMs on") |
| B (`persona_b`) | on, `dm` destination | on |
| C (`persona_c`) | on, `dm` destination, `dm.contact` set | on |

Only A changes, and only through a confirmed `config.json` edit, so the setup
stays config-file only (AC 14). B and C cannot be switched off: a `dm`
destination, or zero channels, needs DMs on (b.av2 SR-1.5), so the config
would be refused.

Confirm that B and C have DMs on, the operator as `dm.contact` and a `dm`
destination:

```sh
jq -c '.personas[] | select(.name == "persona_b" or .name == "persona_c") | {name, dm, permission_prompts}' \
  "$S/config.json.last-applied"
```

It must print two lines, for `persona_b` and `persona_c`, each with
`"dm":{"enabled":true,"contact":"<OPERATOR_USER_ID>"}` and
`"permission_prompts":"dm"`.

Every persona app must carry the `im:write` bot scope, which opening a DM with
a user needs. The wizard created each app from the shipped
`slack-app-manifest.yml`, which grants it. To check, open each app's **OAuth &
Permissions** page and confirm `im:write` is listed under Bot Token Scopes.
If it is missing, the app was not created from the shipped manifest: that is a
setup failure. Fix it as the `debug-slack-channel-bots` skill's section "A
persona can't open a DM: re-install its app to gain `im:write`" says, and
record it in Notes.

The **second test user** (Part 1.1) must never have had a DM with app A: in
that account's sidebar and **Apps** list, no conversation with "CSCB Test A"
exists. Check 14 gave the first-time user a post in A-home and a DM with B
only, so the same account qualifies.

A DM message's `<TS>` comes from its **Copy link** URL, as for channel
messages. The same URL's path holds the DM conversation ID (`D…`): note the
one between the operator and A as `<A_DM_ID>`, and likewise `<B_DM_ID>` and
`<C_DM_ID>`.

The permission request each prompt check raises is the one from Check 5: a
shell command that writes the current date to a named file in the persona's
working directory. Answer every prompt in Slack, promptly, and never in a
persona's terminal.

### Check 15: a DM to a persona with DMs off is dropped with a log line (AC 35)

A's DMs are off, as the wizard configured them.

Steps:

1. Record where the log ends: `MARK=$(mark)`.
2. As the operator, open a DM with app A (its **Messages** tab) and send "Reply with the word dm-off." Work out the message's `<TS>` and note `<A_DM_ID>`.
3. Wait two minutes.
4. Run:

   ```sh
   since "$MARK" | grep -F 'persona-dm-dropped:' | grep -F 'ts=<TS>'
   since "$MARK" | grep -F 'Dispatching to persona "persona_a"' | grep -F 'chat_id=<A_DM_ID>'
   tags a <TS>
   since "$MARK" | grep -E 'persona=persona_(b|c):' | grep -F '<TS>'
   ```

Expected:

- The first command prints exactly one line: `[slack] persona-dm-dropped: personas[0] "persona_a" (key=persona_a): direct message in conversation <A_DM_ID> ts=<TS> dropped: dm.enabled is off for this persona`.
- The second and third commands print nothing: A's instance received nothing.
- The fourth prints nothing: the DM reached only A's app's connection.
- No reply and no reaction from A appear in the DM.

A silent drop fails this check: no reply and no `persona-dm-dropped` line is a fail.

Pass: exactly one `persona-dm-dropped` line naming `persona_a` and `dm.enabled`, and every other command prints nothing.

### Check 16: a persona with DMs off refuses to message a user (AC 36, outbound leg)

A's DMs are still off. Check 20, later, opens the DM between A and the second
test user.

Steps:

1. Record where the log ends: `MARK=$(mark)`.
2. In A-home, post: "Call your reply tool once with chat_id `<SECOND_USER_ID>` and the text `DMs-off outbound check`. Call it even if you expect it to fail. Then reply here with the word done."
3. When A says done, run:

   ```sh
   replies a | grep -F 'chat_id=<SECOND_USER_ID>' | tail -n 1
   since "$MARK" | grep -F 'could not open a DM'
   ```

4. Signed in as the second test user, look for any DM or **Apps** conversation from "CSCB Test A".

Expected:

- The `replies a` line starts `chat_id=<SECOND_USER_ID> error=true` and contains `Persona "persona_a" (key=persona_a) may not target "<SECOND_USER_ID>": DMs are off for this persona (dm.enabled is false).`
- The `grep` prints no line naming `persona_a` and `<SECOND_USER_ID>`: no failed DM open was logged.
- The second test user has no conversation with A and no new message from it.

If the `replies a` command prints nothing, A made no call to
`<SECOND_USER_ID>`: it chose not to call the tool. Ask once more; if there is still no call, record the check as "not run"
with the reason in Notes. It is not a pass.

Pass: the call to `<SECOND_USER_ID>` returned the refusal naming `persona_a` and `<SECOND_USER_ID>`, and the second test user got nothing from A.


### Turn A's DMs on (operator step on the test host)

This is a config edit applied with the confirmation gesture (Part 2.2), while
the server runs. `dm.enabled`
is updated in place: no restart, and A keeps its instance, Slack connection
and MCP session.

1. Note where the log ends and the server's PID, only if the guard passes:

   ```sh
   if guard; then
     LOG_MARK=$(mark); echo "LOG_MARK=$LOG_MARK"
     PID_BEFORE=$(cat "$S/server.pid"); echo "PID_BEFORE=$PID_BEFORE"
   fi
   ```

   If it prints a guard message, do nothing more in this section, and record that in Notes.

2. Turn A's DMs on in `config.json`, only if the guard passes, and check the result:

   ```sh
   if guard; then
     jq '(.personas[] | select(.name == "persona_a")).dm = {"enabled": true}' "$S/config.json" > "$S/config.json.tmp" \
       && mv "$S/config.json.tmp" "$S/config.json"
   fi
   jq -c '.personas[] | select(.name == "persona_a") | .dm' "$S/config.json"   # must print {"enabled":true}
   ```

3. Wait about 10 s, then read the preview:

   ```sh
   showpending
   since "$LOG_MARK" | grep -F 'reload-preview:' | showsafe
   ```

4. Confirm, only if the guard passes, then wait about 10 s:

   ```sh
   if guard; then
     mv "$S/config.json.pending" "$S/config.json.apply"
   fi
   ```

5. Check the apply:

   ```sh
   since "$LOG_MARK" | grep -E 'reload-(applied|noop|stale-confirmation|invalid):|updated in place|persona-start:|persona teardown|Session disconnected|spawnForPersona'
   cmp "$S/config.json" "$S/config.json.last-applied" && echo recorded
   ls "$S/config.json.pending" "$S/config.json.apply"
   [ "$(cat "$S/server.pid")" = "$PID_BEFORE" ] && echo 'same server'
   ```

Expected:

- Step 3: the pending file's preview is these two lines, after its two header lines and a blank line: `A configuration change is pending; nothing has been applied. personas: 0 added, 0 removed, 0 destructively modified, 1 modified in place, 0 with changed credentials; server-wide settings: 0 changed.` and `persona "persona_a" (key=persona_a): dm.enabled changed: applied in place immediately, instance kept.` The `grep` prints the same two lines, each prefixed `[slack] reload-preview: `, the first ending ` (preview in "<path of config.json>.pending")`.
- Step 5's first command prints exactly two lines: `[slack] persona "persona_a" (key=persona_a): updated in place (dm.enabled); its instance, Slack connection and MCP session are kept; its cached DM conversation is forgotten` and `[slack] reload-applied: applied the confirmed configuration change without a restart (personas: 0 added, 0 removed, 0 destructively modified, 1 modified in place, 0 with changed credentials; server-wide settings: 0 changed); the last-applied record "<path of config.json>.last-applied" now holds it`.
- `cmp` prints `recorded`, `ls` reports that neither `config.json.pending` nor `config.json.apply` exists, and `same server` is printed.

If any of that is missing, or another line is present, stop the section and record the failure in Notes.

A's DMs stay on for the rest of this run.


### Check 17: each DM is answered by the persona whose app received it (AC 15, AC 37, AC 17)

Steps:

1. Record where the log ends: `MARK=$(mark)`.
2. As the operator, send "Reply with the word dm-a." in the DM with app A. Work out its `<TS>` (call it `<TS_A>`).
3. Send "Reply with the word dm-b." in a DM with app B. Work out its `<TS>` (`<TS_B>`) and note `<B_DM_ID>`.
4. Wait for both answers, then run:

   ```sh
   tags a <TS_A>; tags b <TS_A>; tags c <TS_A>
   tags b <TS_B>; tags a <TS_B>; tags c <TS_B>
   since "$MARK" | grep -E 'persona=persona_(b|c):' | grep -F '<TS_A>'
   since "$MARK" | grep -E 'persona=persona_(a|c):' | grep -F '<TS_B>'
   replies a; replies b
   ```

Expected:

- A answers "dm-a" in the DM with A, under A's name and avatar. B answers "dm-b" in the DM with B, under B's name and avatar.
- `tags a <TS_A>` prints exactly one tag, with `chat_id="<A_DM_ID>"`, `via="dm"` and `user_id="<OPERATOR_USER_ID>"`. `tags b <TS_B>` prints exactly one, with `chat_id="<B_DM_ID>"`, `via="dm"` and `user_id="<OPERATOR_USER_ID>"`.
- The other four `tags` commands and both `grep` commands print nothing: the other personas received nothing.
- The last line of `replies a` has `chat_id=<A_DM_ID>`, and the last line of `replies b` has `chat_id=<B_DM_ID>`, each with `error=false` and a result containing `Sent`.
- Neither DM gets a pairing code, allowlist prompt or any message other than the persona's answer (AC 17: the operator has no allowlist entry).

Pass: each DM is delivered once with `via="dm"` to the persona whose app received it, answered there under that persona's identity, and received by no other persona.


### Check 18: C's first prompt opens the DM with its contact (AC 44)

It runs before Check 19, which sends the operator's first DM to C.

Precondition: the operator has never had a DM with app C. C is in no channel,
so the only way to ask C for work without a DM is its terminal.

Steps:

1. In the operator's Slack sidebar and **Apps** list, look for a conversation with "CSCB Test C", and compare with what Part 1.2 recorded before the run:
   - None now: this is a **first run**.
   - One now, and Part 1.2 recorded "yes" (an earlier run of this plan opened it; Slack DMs can't be deleted): this is a **rerun**. Note its ID as `<C_DM_ID>` from any message's **Copy link** URL.
   - One now, but Part 1.2 recorded "no": something in this run opened it before C's first prompt. Record Check 18 as "not verified (AC 44)", with what opened it if known, and don't rerun the check: the DM can't be deleted, so no rerun on this workspace can verify AC 44. Note `<C_DM_ID>` as for a rerun and do steps 2–6 as on a rerun, so Check 19 has the DM.

   Record "first run", "rerun" or "not verified" in Notes.
2. Record where the log and the trail end: `MARK=$(mark); TMARK=$(wc -l < "$TRAIL")`.
3. Attach to C's session with `tmux attach -t slack_bot_persona_c`. Type this at C's prompt and press Enter: "Run a shell command that writes the current date to a file named dm-prompt-c.txt in your working directory. Do not post anything to Slack." Detach with `Ctrl-b d`, without answering anything in the pane.
4. Wait for the prompt in Slack (up to one minute). On a first run, work out `<C_DM_ID>` from the prompt's **Copy link** URL.
5. Run:

   ```sh
   posts "$TMARK" | grep -F cscb_persona_c
   since "$MARK" | grep -F 'persona-destination-failed:'
   ```

6. Click **Allow** on the prompt. Then run `ls ~/cscb-live/c/dm-prompt-c.txt`.

Expected:

- First run: a new DM from app C appears for the operator, under C's name and avatar, and its first message is the permission prompt with **Allow** and **Deny** buttons. The DM didn't exist before, so C's first prompt opened it (`conversations.open`) before posting.
- Rerun: the prompt arrives in the existing DM with C (`<C_DM_ID>`, the one step 1 found), under C's name and avatar, and no second conversation with C appears.
- The prompt appears in no channel: not in A-home, not in coordination.
- `posts` prints one line for `cscb_persona_c`, with `"ok":true` and `"channel":"<C_DM_ID>"` (a `D…` ID).
- The `persona-destination-failed` grep prints nothing.
- **Allow** updates the prompt in place to `*Permission* — Allowed`, and the file exists.

A `persona-destination-failed` line naming `missing_scope` and `im:write` means app C lacks `im:write`: fix it as this part's setup says, then rerun this check.

Pass: C's prompt was delivered as a DM from C's app to the operator (opening the DM on a first run, into the existing DM on a rerun), appeared in no channel, and its button resolved the request. A DM opened earlier in this run makes the check "not verified", never a pass.


### Check 19: a DM-only persona starts, connects and answers DMs (AC 40, AC 41)

C has zero channels, DMs on, a `dm` destination and `dm.contact` set.

Check 18's prompt opened the operator's DM with C, so step 2 below posts into
that DM, and its ID is the `<C_DM_ID>` Check 18 noted.

Steps:

1. Confirm C's start in the lines of the server's most recent start. `START_MARK` is a mark at the log line before that start's `Loaded persona config` line. If it prints `START_MARK=<inode>:-1`, that line has rotated into `server.log.1`; run this step's greps on `cat "$LOG.1" "$LOG"` from that line instead, and record it in Notes:

   ```sh
   START_MARK="$(stat -c %i "$LOG"):$(( $(grep -n 'Loaded persona config:' "$LOG" | tail -n 1 | cut -d: -f1) - 1 ))"; echo "START_MARK=$START_MARK"
   since "$START_MARK" | grep -F '"persona_c" (key=persona_c)'
   since "$START_MARK" | grep -E 'persona-(credentials|directory)-|persona-slack-unreachable' | grep -F '(key=persona_c)'
   agent-director list --label service=cscb
   ```

2. As the operator, send "Reply with the word dm-c." in a DM with app C. Work out its `<TS>` and note `<C_DM_ID>`. Wait for the answer.
3. Run:

   ```sh
   tags c <TS>
   replies c
   since "$START_MARK" | grep -F '(key=persona_c)' \
     | grep -oE 'chat_id=[A-Z0-9]+|channel=[A-Z0-9]+|in (channel|conversation) [A-Z0-9]+' | sort -u
   since "$START_MARK" | grep -F 'unclaimed-channel: personas[2] "persona_c"'
   ```

   The third command lists every conversation ID on C's lines since that start: its `Dispatching to persona "persona_c" (key=persona_c) chat_id=…` lines, any `dropped message from channel=…` line, and any `persona-dm-dropped` or `unclaimed-channel` line (`… in conversation …` / `… in channel …`). The RAW lines are not used: they keep only the first 300 characters of the event, which usually cut off its `"channel"` field.

4. In the test workspace's channel browser, open every channel (A-home, coordination and the workspace's default channels) and look at its member list.

Expected:

- Step 1's first command prints a `[slack] persona-start: personas[2] "persona_c" (key=persona_c): bring-up starting` line and a `[slack] Session connected: persona "persona_c" (key=persona_c)` line, and no `[slack] persona "persona_c" (key=persona_c) not brought up:` line. Its second command prints nothing. The list has C's row, `cscb_persona_c`.
- C answers "dm-c" in the DM with C, under C's name and avatar.
- `tags c <TS>` prints exactly one tag, with `chat_id="<C_DM_ID>"`, `via="dm"` and `user_id="<OPERATOR_USER_ID>"`.
- Every line of `replies c` has a `chat_id` starting with `D`: C has posted only in DMs.
- The ID extraction prints at least `chat_id=<C_DM_ID>`, and every ID it prints starts with `D`: C's pipeline has handled nothing outside a DM since that start.
- The `unclaimed-channel` grep prints nothing.
- "CSCB Test C" is in no channel's member list.

Pass: C started and connected with no failure line, answered the DM in place with `via="dm"`, and is in no channel and has posted nowhere but DMs.


### Check 20: a persona with DMs on opens a DM with a user and posts as itself (AC 38)

A's DMs are now on. The second test user still has no DM with A (Check 16
posted nothing).

Steps:

1. Record where the log ends: `MARK=$(mark)`.
2. In A-home, post: "Call your reply tool once with chat_id `<SECOND_USER_ID>` and the text `DMs-on outbound check`. Then reply here with the word done."
3. When A says done, run:

   ```sh
   replies a | grep -F 'chat_id=<SECOND_USER_ID>' | tail -n 1
   since "$MARK" | grep -F 'could not open a DM'
   ```

4. Signed in as the second test user, open the DM from "CSCB Test A".

Expected:

- The `replies a` line starts `chat_id=<SECOND_USER_ID> error=false` and contains `Sent 1 message(s) to D` followed by the DM's ID and ` (the DM with <SECOND_USER_ID>)`.
- The `grep` prints nothing. A `missing_scope` failure here means app A lacks `im:write` (see this part's setup).
- The second test user has a new DM from app A, holding "DMs-on outbound check" under A's name and avatar.

Pass: A's call opened a DM with the second test user and the message appears there under A's identity.


### Check 21: an edit that adds a mention wakes the persona once

This covers the edited-event dedupe: an edit that adds a persona's mention
reaches it as a new mention, once. A is mentions-only in coordination (Check
13 restored it).

An edited message's delivered tag may not carry the `<TS>` from the
message's link, so this check counts deliveries with `tagstext` (Part
1.3), keyed on the text `edit check`. The `Dispatching` lines
carry no `via`; they only corroborate the count.

Steps:

1. Record where the log ends: `MARK=$(mark)`.
2. In coordination, post "edit check, no reply needed yet" (no mention). Work out its `<TS>`. Wait one minute, then run `tagstext a 'edit check'`.
3. Edit that message to "@CSCB Test A edit check: reply with the word edited." Wait two minutes, then run:

   ```sh
   tagstext a 'edit check'
   tagstext b 'edit check'
   tags a <TS>
   since "$MARK" | grep -F 'Dispatching to persona "persona_a"' | grep -F 'edit check'
   ```

4. Observation only: edit the message again to fix a typo while keeping the mention (for example "@CSCB Test A edit check: reply with the word edited!"). Wait two minutes and run `tagstext a 'edit check'` again.

Expected:

- Step 2: `tagstext a 'edit check'` prints nothing (A is mentions-only in coordination).
- Step 3: `tagstext a 'edit check'` prints exactly one tag, with `via="mention"` and `user_id="<OPERATOR_USER_ID>"`. `tagstext b 'edit check'` prints nothing. The `grep` prints exactly one line. A replies "edited" in coordination once, under its own name and avatar.
- Record in Notes whether `tags a <TS>` printed that same tag, or nothing (the tag's `ts` differs from `<TS>`; record the tag's `ts`). Either is acceptable.

Step 4 is not part of the pass. Record in Notes how many tags
`tagstext a 'edit check'` prints after the typo edit (one, or two if the
second edit woke A again) and whether A replied again.

Pass: the edit that added the mention woke A exactly once with `via="mention"`, and B received nothing.


### Check 22: B's prompt arrives by DM and its button resolves it (AC 29)

The DM between the operator and B exists since Check 17 (`<B_DM_ID>`).

Steps:

1. Record where the log and the trail end: `MARK=$(mark); TMARK=$(wc -l < "$TRAIL")`.
2. In coordination, post "@CSCB Test B run a shell command that writes the current date to a file named dm-prompt-b.txt in your working directory."
3. Wait for the prompt (up to one minute), then run:

   ```sh
   posts "$TMARK" | grep -F cscb_persona_b
   since "$MARK" | grep -F 'persona-destination-failed:'
   ```

4. Click **Allow** on the prompt. Wait for B to finish, then run `ls ~/cscb-live/b/dm-prompt-b.txt`.

Expected:

- The permission prompt appears in the operator's DM with B (`<B_DM_ID>`), under B's name and avatar, with **Allow** and **Deny** buttons.
- No prompt appears in coordination, where the request started, or in any other channel.
- `posts` prints one line for `cscb_persona_b`, with `"ok":true` and `"channel":"<B_DM_ID>"`.
- The `persona-destination-failed` grep prints nothing.
- **Allow** updates the DM message in place to `*Permission* — Allowed`. B goes on with the work, and the file exists.

Pass: B's prompt arrived only in the DM with B, under B's identity, and **Allow** resolved it there.

### Check 23: A's channel prompt and B's DM prompt each go to their own persona's destination (AC 34)

Steps:

1. Record where the log and the trail end: `MARK=$(mark); TMARK=$(wc -l < "$TRAIL")`.
2. In coordination, post "@CSCB Test A @CSCB Test B each of you, run a shell command that writes the current date to a file in your working directory: A names it prompt-a.txt, B names it prompt-b.txt."
3. Wait until both prompts are showing, and don't click either yet. Run:

   ```sh
   posts "$TMARK" | grep -E 'cscb_persona_(a|b)'
   ```

4. Click **Deny** on B's prompt. Look at A's prompt. Deny any further prompt B raises for this task.
5. Click **Allow** on A's prompt. Look at B's prompt.
6. When A has finished, run `ls ~/cscb-live/a/prompt-a.txt ~/cscb-live/b/prompt-b.txt`.

Expected:

- A's prompt appears in A-home, under A's name and avatar. It does not appear in coordination or in any DM.
- B's prompt appears in the operator's DM with B (`<B_DM_ID>`), under B's name and avatar. It does not appear in A-home, coordination or any other channel.
- Nothing is cross-posted: A-home holds no prompt of B's, and the DM with B holds no prompt of A's.
- In `posts`, the first line for `cscb_persona_a` has `"channel":"<A_HOME_CHANNEL_ID>"` and the first line for `cscb_persona_b` has `"channel":"<B_DM_ID>"`, both `"ok":true`. More lines from one persona (it raised more requests) go in Notes; they are not a failure.
- Step 4: B's prompt updates to `*Permission* — Denied by operator`; A's prompt is unchanged, with its buttons.
- Step 5: A's prompt updates to `*Permission* — Allowed`; B's stays `Denied by operator`.
- `ls` lists `prompt-a.txt` and reports that `prompt-b.txt` does not exist.

Pass: both prompts were pending at once, each at its own persona's destination under its own identity, and each button resolved only its own request.


---

## Part 8: Lost message

This check verifies AC 26 and b.av2 SR-4.6 (a message that finds no live,
stream-bearing session is not delivered, and recovery follows the
human-trigger rules) and SR-7.3 (the persona's permission-prompt destination
is told that a message was lost, who sent it and the recovery state, with no
message text, and nothing else is posted in the source conversation). It also
checks, in passing, SR-7.2 (the notice is posted under the persona's own
identity) and SR-4.5 (a lost message gets no acknowledgement reaction).

State at the start: the server that is already running after Part 7, with
A's DMs on. The check's own teardown brings A back, so Part 9 starts from a
healthy state.

### Setup for this check

The check needs auto-restart off, so the killed instance stays down, and an
acknowledgement reaction configured, so its absence means something. The
wizard set `ack_reaction` to `eyes` (Part 1.5). `session_restart_delay` is a
server-wide setting: a confirmed change is recorded at the apply and takes
effect at the next server start. So the setup confirms the change (Part 2.2),
then restarts the test server with the "Guarded restart" (Part 2.3):

1. Note where the log ends, only if the guard passes: `if guard; then MARK=$(mark); fi`. If it prints a guard message, do nothing more in this part and record that in Notes.
2. Record the current delay and the reaction, then set the delay to `0`, only if the guard passes:

   ```sh
   ORIG_DELAY=$(jq -c '.session_restart_delay' "$S/config.json"); echo "ORIG_DELAY=$ORIG_DELAY"
   jq -r '.ack_reaction' "$S/config.json.last-applied"   # must print eyes
   if guard; then
     jq '.session_restart_delay = 0' "$S/config.json" > "$S/config.json.tmp" && mv "$S/config.json.tmp" "$S/config.json"
   fi
   jq -e '.session_restart_delay == 0' "$S/config.json"   # must print true
   ```

   `ORIG_DELAY=null` means the key is absent (the default, 60 s), as the wizard left it. Keep `ORIG_DELAY` for the teardown.
3. Wait about 10 s and read the preview: `showpending`. After its two header lines and a blank line, it is `A configuration change is pending; nothing has been applied. personas: 0 added, 0 removed, 0 destructively modified, 0 modified in place, 0 with changed credentials; server-wide settings: 1 changed.` and `server-wide setting session_restart_delay changed: once applied, it is recorded and takes effect at the next server start after that.`
4. Confirm, only if the guard passes: `if guard; then mv "$S/config.json.pending" "$S/config.json.apply"; fi`. Wait about 10 s, then run `since "$MARK" | grep -F 'reload-applied:'`. It prints one `[slack] reload-applied: …` line whose counts end `server-wide settings: 1 changed)`. The delay is recorded but not yet in effect.
5. Run the "Guarded restart" (Part 2.3). Its Expected items apply: the `Starting from the last-applied record` line, each persona's `Session connected` line, `0 failed, 0 not brought up, 0 not reconnected`, no failure line, `cmp` printing `recorded`, and no `config.json.pending`. The start runs the record, so the delay of 0 is now in effect.

A's destination is A-home (`"permission_prompts": "<A_HOME_CHANNEL_ID>"`). A
is mentions-only in coordination, so the message must mention A.

### Check 24: a message to a downed persona is reported at its destination, not in the channel (AC 26)

Steps:

1. Run `agent-director list --label service=cscb` and confirm A's row, `cscb_persona_a`, is there.
2. Record where the log ends: `MARK=$(mark)`.
3. Kill A's instance as Check 7 does, only if the guard passes: `if guard; then tmux kill-session -t slack_bot_persona_a; fi`. Wait until the disconnect shows (up to one minute):

   ```sh
   since "$MARK" | grep -E 'Session disconnected.*"persona_a" \(key=persona_a\)|Auto-restart disabled \(delay=0\) — skipping restart for persona=persona_a'
   ```

4. Record where the log ends again: `MARK2=$(mark)`.
5. As the operator, in coordination, post "@CSCB Test A lost-message check lost-marker-7Q3Z, reply with the word back." The marker `lost-marker-7Q3Z` is how the notice is checked for message text. Work out the message's `<TS>`.
6. Wait two minutes, watching A-home and coordination. Then run:

   ```sh
   since "$MARK2" | grep -F 'No live session for persona "persona_a" (key=persona_a)'
   since "$MARK2" | grep -F 'DROP: no _GET_stream for persona "persona_a"'
   since "$MARK2" | grep -F 'Dispatching to persona "persona_a"'
   since "$MARK2" | grep -F 'persona-destination-failed:'
   since "$MARK2" | grep -F 'Scheduling restart for persona=persona_a'
   tags a <TS>
   ```

7. Look at the message in coordination for any reaction, and at A-home and coordination for every post made after it.

Expected:

- Step 3 prints a `[slack] Session disconnected` line for `persona "persona_a" (key=persona_a)` and at least one `[slack] Auto-restart disabled (delay=0) — skipping restart for persona=persona_a` line. A does not come back while the check runs.
- Step 6's first command prints exactly one line: `[slack] No live session for persona "persona_a" (key=persona_a) chat_id=<COORDINATION_CHANNEL_ID> — dropping message`. (If it prints nothing and the second command prints a `[slack] DROP: no _GET_stream for persona "persona_a" (key=persona_a) chat_id=<COORDINATION_CHANNEL_ID> …` line instead, A's session was still registered without its stream; that branch reports the same way, so the rest of the check applies. Record which line appeared in Notes.)
- On the `No live session` path, the `Dispatching` command prints nothing. On the DROP path, it prints exactly one `[slack] Dispatching to persona "persona_a" (key=persona_a) chat_id=<COORDINATION_CHANNEL_ID> … hasGetStream=false …` line, logged just before the DROP line.
- The `persona-destination-failed` and `Scheduling restart` commands print nothing, and `tags a <TS>` prints nothing: the message was not delivered, and no restart was started.
- Exactly one new message appears in A-home: the lost-message notice, posted by app A (A's name and avatar). It reads, as Slack renders it: `Persona "persona_a" (key=persona_a): ⚠️ Message lost — a message from <sender> was not delivered to this persona's instance and was not saved; it will not be delivered later. Recovery: auto-restart disabled — the instance will not restart on its own; restart the server to recover.`
- `<sender>` is the operator's Slack name as the workspace shows it (display name, else full name), or `<OPERATOR_USER_ID>` if the name can't be looked up. It is plain text, not an @-mention.
- The notice doesn't contain `lost-marker-7Q3Z` or any other words from the message.
- Nothing appears in coordination after the operator's message: no reply, notice or other post from A, B, C or the server, including in a thread.
- The message in coordination has no reaction from A: the configured `ack_reaction` emoji is not on it.

A notice in coordination, a second lost-message notice, or the marker in the
notice fails this check. So does an `ack_reaction` on the message.

Teardown for this check (operator step on the test host), run whatever the result:

1. Note where the log ends, only if the guard passes: `if guard; then MARK=$(mark); fi`. The server keeps running.
2. Restore the delay, only if the guard passes:

   ```sh
   if guard; then
     jq --argjson d "$ORIG_DELAY" 'if $d == null then del(.session_restart_delay) else .session_restart_delay = $d end' \
       "$S/config.json" > "$S/config.json.tmp" && mv "$S/config.json.tmp" "$S/config.json"
   fi
   jq -c '.session_restart_delay' "$S/config.json"   # must print the ORIG_DELAY value
   ```

   Wait about 10 s, read the preview with `showpending` (the same two preview lines as the setup's step 3), and confirm it, only if the guard passes: `if guard; then mv "$S/config.json.pending" "$S/config.json.apply"; fi`. Wait about 10 s; `since "$MARK" | grep -F 'reload-applied:'` prints one line whose counts end `server-wide settings: 1 changed)`. Without the confirmation, the next start runs the record with a delay of 0, and auto-restart stays off.
3. Run the "Guarded restart" (Part 2.3), with its Expected items. A's instance is brought up again, resumed or fresh-spawned, and the restored delay is in effect.
4. In A-home, post "Reply with the word back." A replies "back" in A-home under its own name and avatar.

If A doesn't answer after the restart, record that in Notes: later parts
need all three personas up.

Pass: A's instance was down with auto-restart off, the message was dropped
with the `No live session` (or `DROP: no _GET_stream`) line, exactly one
lost-message notice naming the operator and "auto-restart disabled" appeared
in A-home under A's identity without the marker, nothing was posted in
coordination, the message got no `ack_reaction`, and A answered again after
the teardown.


---

## Part 9: Runtime add and remove

These checks verify the live legs of AC 19 and AC 22 (a new persona, with a
freshly created credentials file and config entry, comes up at a confirmed
apply and posts as itself, with no restart and no change to the server's
environment) and AC 57 (a confirmed removal tears down only that persona).
They cover b.av2 SR-14's runtime addition and confirmed removal, and SR-8.5
and SR-8.6 (the confirmation and the apply), and the E14 demo of adding a
persona with the setup wizard on a running server. In passing, they check
SR-7.2 (reload output never reaches Slack) and SR-10.3 (no token in the
pending file or the log). The optional Check 26 checks a revoked bot token
live (bug b.ujn) on the disposable persona D.

State at the start: the server Check 24's teardown restarted, with A, B and C
applied and nothing pending. Part 9 ends with D removed, the applied set back
to A, B and C and nothing pending, as the reboot (Part 10) needs. Resuming
conversation history is best effort.

### Setup for these checks

- **A channel for D.** Create **D-home** in the test workspace. Its ID replaces `<D_HOME_CHANNEL_ID>` below. The wizard has the operator invite app D there in Check 25.
- **D's working directory:** `mkdir -p ~/cscb-live/d`.
- **A, B and C applied, nothing pending, server running.** Confirm it:

  ```sh
  guard && echo 'test host'
  cmp "$S/config.json" "$S/config.json.last-applied" && echo recorded
  ls "$S/config.json.pending"                              # must not exist
  jq -r '.personas[].name' "$S/config.json.last-applied"   # persona_a, persona_b, persona_c
  kill -0 "$(cat "$S/server.pid")" && echo running
  ```

D sets no `claude_config_dir`, like A, B and C, so D launches with the same
effective config directory the start already prepared. Don't give D one:
these checks don't cover it. If a run does, the apply rewrites the
agent-director template's memory-read rules before D is brought up (one
`[slack] template refresh:` line). If that line says `failed`, expect a
permission prompt for each of D's memory reads and note them; they don't
fail these checks.

### Check 25: a persona added with the wizard on the running server comes up after the confirmation, with no restart (AC 19, AC 22)

Steps:

1. Note the log mark, the server's PID, its environment and the rows, only if the guard passes:

   ```sh
   if guard; then
     MARK=$(mark); echo "MARK=$MARK"
     PID_BEFORE=$(cat "$S/server.pid"); echo "PID_BEFORE=$PID_BEFORE"
     tr '\0' '\n' < "/proc/$PID_BEFORE/environ" | cut -d= -f1 | grep -cE '^SLACK_(BOT|APP)_TOKEN$'   # must print 0
     agent-director list --label service=cscb
   fi
   ```

   Record the rows' instance IDs for A, B and C in Notes (they are not secrets).

2. Start a conversation with A that stays open through the addition. In A-home, post "Remember the word quillfeather for later. Reply with the word noted." A replies "noted". The word is made up and harmless; never use a credential.

3. Mark the wizard transcript's size, for step 5's count: `WIZ_MARK=$(cat ~/.claude/projects/*-cscb-live-wizard/*.jsonl | wc -l)`.

4. Run the wizard on the running server, as in Part 1.5 (in `~/cscb-live/wizard`, a terminal 80 columns wide), and add one persona with these answers:

   | Wizard step | D |
   |---|---|
   | 4.1 name | `persona_d` |
   | 4.2 app name, bot display name, avatar | "CSCB Test D", with an avatar unlike A's, B's and C's |
   | 4.3 `credentials_file` path | `~/.config/cscb/persona_d-credentials.json` |
   | 4.4 `working_directory` | `~/cscb-live/d` |
   | 4.5 channels, `delivery`, invite | D-home `mentions`; invite D there |
   | 4.6 `dm.enabled`, `dm.contact` | DMs on, contact `<OPERATOR_USER_ID>` |
   | 4.7 `permission_prompts` | `<D_HOME_CHANNEL_ID>` |
   | 4.8, Steps 5 and 6 | nothing new |

   Run the credentials command at step 4.10, after the wizard declared D (4.9), exactly as in Check S1 steps 2–6, with `d` in place of `a`: in a real terminal, never through the wizard's tool, the tokens only at its hidden prompts. When the wizard reaches Step 9, read what it says and don't ask it to rename anything. End the wizard session after its summary.

5. Wait about 10 s after the credentials command wrote D's file, then read the preview and count token-shaped text, without printing any:

   ```sh
   showpending
   ls "$S/config.json.apply"
   since "$MARK" | grep -E 'reload-(preview|invalid):' | showsafe
   since "$MARK" | grep -F '(key=persona_d)' | grep -vF 'reload-preview:'
   tokcount "$S/config.json" "$S/config.json.pending"   # must print 0
   since "$MARK" | grep -cE 'xox[a-z]-[0-9]|xapp-[0-9]'  # must print 0
   cat ~/.claude/projects/*-cscb-live-wizard/*.jsonl | tail -n +"$((WIZ_MARK + 1))" | grep -cE 'xox[a-z]-[0-9]|xapp-[0-9]'   # must print 0
   ```

   Look at A-home, coordination, D-home and the operator's DMs with the apps for any post about the pending change.

6. Confirm, only if the guard passes:

   ```sh
   if guard; then mv "$S/config.json.pending" "$S/config.json.apply"; fi
   ```

7. Wait until D's `Session connected` line appears (up to about 3 minutes), then run:

   ```sh
   since "$MARK" | grep -E 'reload-(applied|noop|stale-confirmation|invalid):|persona-start:|at apply|spawnForPersona|Session (connected|disconnected)|persona teardown|updated in place|\) not brought up:|persona-(credentials|directory)-|persona-slack-unreachable'
   cmp "$S/config.json" "$S/config.json.last-applied" && echo recorded
   ls "$S/config.json.pending" "$S/config.json.apply"
   [ "$(cat "$S/server.pid")" = "$PID_BEFORE" ] && echo 'same server'
   tr '\0' '\n' < "/proc/$PID_BEFORE/environ" | cut -d= -f1 | grep -cE '^SLACK_(BOT|APP)_TOKEN$'   # must print 0
   agent-director list --label service=cscb
   ```

8. In D-home, post "@CSCB Test D reply with the word arrived."
9. In A-home, post "What word did I ask you to remember? Reply with just that word."

Expected:

- Step 1: the environment count prints `0`, and the list has exactly three rows, `cscb_persona_a`, `cscb_persona_b` and `cscb_persona_c`.
- Step 4: the wizard's Step 3 reports `server: running`, `record: present` and `pending change: none`. The wizard declares D in `config.json` before it gives the credentials command, and says the preview reads `cannot come up: credentials file does not exist` until the file is written. The credentials command prints `Credentials file of persona "persona_d" (key=persona_d): <home>/.config/cscb/persona_d-credentials.json`, both `ok` lines and `Wrote <home>/.config/cscb/persona_d-credentials.json with mode 0600. …`, and `ls -lL` shows `-rw-------`; the Check S1 counts are `0`. Its Step 9 explains that the server writes `config.json.pending`, a preview of the change, and that the operator confirms by renaming it to `config.json.apply`, after which the server applies it without a restart and logs `reload-applied`. The wizard doesn't rename the file itself.
- Step 5: after its two header lines and a blank line, the pending file's preview is `A configuration change is pending; nothing has been applied. personas: 1 added, 0 removed, 0 destructively modified, 0 modified in place, 0 with changed credentials; server-wide settings: 0 changed.` and `persona "persona_d" (key=persona_d) is added: it will be brought up and launched.` `ls` reports that `config.json.apply` does not exist. The `reload-(preview|invalid)` grep prints two previews, each line prefixed `[slack] reload-preview: ` and each first line ending ` (preview in "<path of config.json>.pending")`: first, logged once the wizard declared D, the same header and `persona "persona_d" (key=persona_d) is added but cannot come up: credentials file does not exist.`; then, logged once the credentials file was written, the same two lines as the pending file. The `(key=persona_d)` grep prints nothing: apart from the preview, no line names D, so D is not brought up before the confirmation. All three counts print `0`. Nothing about the pending change appears in Slack.
- If the pending file's second line still reads `is added but cannot come up: …` instead, fix the cause it names (the credentials file or the working directory) and wait for the preview to change before confirming. Record that in Notes.
- Step 7 prints exactly one `[slack] reload-applied: applied the confirmed configuration change without a restart (personas: 1 added, 0 removed, 0 destructively modified, 0 modified in place, 0 with changed credentials; server-wide settings: 0 changed); the last-applied record "<path of config.json>.last-applied" now holds it` line, and for D exactly one each of:
  - `[slack] persona-start: personas[3] "persona_d" (key=persona_d): bring-up starting`
  - `[slack] persona "persona_d" (key=persona_d): up at apply — launching`
  - `[slack] spawnForPersona: spawned "persona_d" (key=persona_d) instanceId=cscb_persona_d`
  - and at least one `[slack] Session connected: persona "persona_d" (key=persona_d)` line.
- Step 7 prints no other line: none names `persona_a`, `persona_b` or `persona_c`, and there is no `launch at apply failed`, `not brought up`, `persona-credentials-…`, `persona-directory-…` or `persona-slack-unreachable` line.
- `recorded` and `same server` are printed, `ls` reports that neither `config.json.pending` nor `config.json.apply` exists, and the environment count prints `0`: the server was not restarted and its environment holds no token variable.
- The list has exactly four rows: exactly one `cscb_persona_d` row, carrying a `persona` label naming `persona_d`, and A's, B's and C's rows with the instance IDs recorded in step 1.
- Step 8: D replies "arrived" in D-home under D's own name and avatar, which differ from A's, B's and C's.
- Step 9: A replies "quillfeather" in A-home under its own name and avatar: its conversation was not disturbed.

A restart, a second row for D, D up before the rename, a rename by the
wizard, or any lifecycle line for A, B or C fails this check.

Pass: D, added through the wizard with a new credentials file and config
entry, came up only after the operator's rename, with one row, and answered
as itself, with the same server PID, no token in its environment, no
lifecycle change for A, B and C, and A still recalling the word.

### Check 26 (optional): a revoked bot token marks the persona credentials-broken, and a confirmed credentials change brings it back (bug b.ujn)

Optional: run it when the run has time, and record "not run" otherwise. It
runs on the disposable persona D, between Checks 25 and 27, and never
touches A's, B's or C's apps. Detection depends on the error shape real
Slack returns, which unit tests can only stub. It also checks the E5 carry:
a refused MCP session registration for a persona that is not up must not
loop without bound.

Steps:

1. Note the log mark, only if the guard passes: `if guard; then MARK=$(mark); fi`.
2. In D's app settings, **OAuth & Permissions**, revoke D's OAuth tokens (the bot token). Leave D's app-level token alone.
3. Make D post: attach to D's session with `tmux attach -t slack_bot_persona_d`, type "Post the text revoked check in D-home, chat_id `<D_HOME_CHANNEL_ID>`, with your reply tool." and press Enter. Detach with `Ctrl-b d` once D has made the call.
4. Run:

   ```sh
   since "$MARK" | grep -F 'persona-credentials-refused:'
   tmux has-session -t slack_bot_persona_d && echo 'instance running'
   agent-director list --label service=cscb
   replies d | tail -n 1
   ```

5. MCP refusal loop: restart the server so D's surviving instance has to register its session again. Stop and start it with the "Guarded restart" commands (Part 2.3 steps 1–3); its Expected items don't apply here, because D is down. Then count D's refused registrations twice, five minutes apart:

   ```sh
   since "$LOG_MARK" | grep -cF 'Session refused: persona "persona_d" (key=persona_d)'
   # five minutes later:
   since "$LOG_MARK" | grep -cF 'Session refused: persona "persona_d" (key=persona_d)'
   ```

6. Fix D: on D's **OAuth & Permissions** page, **Install to Workspace** again, which issues a new bot token. Re-invite D to D-home if it is no longer a member. Then re-save D's credentials file with the wizard's credentials command, as its "Rotate a persona's tokens" section says: ask the wizard (in `~/cscb-live/wizard`) to rotate `persona_d`'s tokens, run the command it gives in a real terminal, answer `yes` to replace the file, and enter the new bot token and D's app-level token at the hidden prompts.
7. Wait about 10 s, read the preview with `showpending`, then confirm, only if the guard passes: `if guard; then mv "$S/config.json.pending" "$S/config.json.apply"; fi`. Wait until D's `Session connected` line appears, then in D-home post "@CSCB Test D reply with the word restored."

Expected:

- Step 4: exactly one `[slack] persona-credentials-refused: personas[3] "persona_d" (key=persona_d) path="<home>/.config/cscb/persona_d-credentials.json": bot_token refused by a Web API call (<method>): Slack error <code>` line, where `<method>` is the refused call (for example `chat.postMessage`) and `<code>` is one of `invalid_auth`, `token_revoked`, `account_inactive` or `not_authed`. `instance running` is printed and the list still has D's row, `cscb_persona_d`: the instance keeps running. The last `replies d` line has `error=true`. No token-shaped text is in the line.
- If Slack closed D's Socket Mode connection first and the refusal line instead names `the Socket Mode open` or `auth.test`, record that in Notes: the Web API path (b.ujn) was not exercised.
- Step 5: the restart's start logs `[slack] persona "persona_d" (key=persona_d) not brought up: …` and a summary ending `0 failed, 1 not brought up, 0 not reconnected`, and A, B and C connect as usual. Each refusal reads `[slack] Session refused: persona "persona_d" (key=persona_d) is not up (…) — not registered; its instance is kept and may register once the persona is up`. Record both counts in Notes. A count that keeps climbing at a steady rate (a refusal every few seconds for the whole five minutes) is the unbounded loop the E5 carry describes: file a bug with the counts, and the check still passes on the other items.
- Step 7: the preview is `A configuration change is pending; nothing has been applied. personas: 0 added, 0 removed, 0 destructively modified, 0 modified in place, 1 with changed credentials; server-wide settings: 0 changed.` and `persona "persona_d" (key=persona_d): credentials file "<home>/.config/cscb/persona_d-credentials.json" changed: it is broken by its credentials now, so it will be brought up.` After the rename, one `[slack] reload-applied: …` line with the same counts, and D's `Session connected` line. D replies "restored" in D-home under D's own name and avatar.

Pass: the first refused Web API call marked D credentials-broken with one
`persona-credentials-refused` line naming the call, D's instance kept
running, and the confirmed credentials change brought D back with no
restart of the server beyond step 5's.

### Check 27: a confirmed removal tears down only that persona (AC 57)

Run it right after Check 25, or after Check 26 when that optional check ran,
on the same server.

Steps:

1. Note the log mark, the server's PID and the rows, only if the guard passes: `if guard; then MARK=$(mark); PID_BEFORE=$(cat "$S/server.pid"); echo "PID_BEFORE=$PID_BEFORE"; agent-director list --label service=cscb; fi`. The PID is recorded again here because the optional Check 26 restarts the server.
2. Optional: have D raise a permission prompt. In D-home, post "@CSCB Test D run a shell command that writes the current date to a file named removal-prompt.txt in your working directory." Wait for the prompt in D-home, and don't click it. Record in Notes whether this step ran.
3. Remove D's entry from `config.json`, only if the guard passes:

   ```sh
   if guard; then
     jq 'del(.personas[] | select(.name == "persona_d"))' "$S/config.json" > "$S/config.json.tmp" \
       && mv "$S/config.json.tmp" "$S/config.json"
   fi
   jq -r '.personas[].name' "$S/config.json"   # must print persona_a, persona_b and persona_c only
   ```

4. Wait about 10 s, then read the preview:

   ```sh
   showpending
   since "$MARK" | grep -E 'reload-(preview|invalid):' | showsafe
   ```

5. Confirm, only if the guard passes, then wait about 30 s:

   ```sh
   if guard; then mv "$S/config.json.pending" "$S/config.json.apply"; fi
   ```

6. Check the apply:

   ```sh
   since "$MARK" | grep -E 'reload-(applied|noop|stale-confirmation|invalid):|persona-start:|at apply|spawnForPersona|Session (connected|disconnected)|persona teardown|updated in place'
   cmp "$S/config.json" "$S/config.json.last-applied" && echo recorded
   ls "$S/config.json.pending" "$S/config.json.apply"
   [ "$(cat "$S/server.pid")" = "$PID_BEFORE" ] && echo 'same server'
   agent-director list --label service=cscb
   MARK2=$(mark)
   ```

7. In D-home, post "@CSCB Test D reply with the word gone." In the operator's DM with app D, send "Reply with the word gone." Wait two minutes, then run `since "$MARK2" | grep -E 'persona=persona_d:|Dispatching to persona "persona_d"|persona-dm-dropped: .*"persona_d"'`.
8. If step 2 ran, click **Allow** on D's prompt. Wait one minute, then run `ls ~/cscb-live/d/removal-prompt.txt`.
9. In A-home, post "What word did I ask you to remember? Reply with just that word."

Expected:

- Step 4: the pending file's preview is `A configuration change is pending; nothing has been applied. personas: 0 added, 1 removed, 0 destructively modified, 0 modified in place, 0 with changed credentials; server-wide settings: 0 changed.` and `DESTRUCTIVE: persona "persona_d" (key=persona_d) is removed: its live session will be destroyed (its instance is torn down).` The `grep` prints the same two lines once each, prefixed `[slack] reload-preview: `. Nothing about it appears in Slack.
- Step 6 prints `[slack] persona teardown of "persona_d" (key=persona_d): starting`, `[slack] persona teardown of "persona_d" (key=persona_d): complete` (not `complete, with <n> failed step(s)`), and one `[slack] reload-applied: …` line whose counts read `personas: 0 added, 1 removed, 0 destructively modified, 0 modified in place, 0 with changed credentials; server-wide settings: 0 changed`. A `Session disconnected` line for `persona "persona_d" (key=persona_d)` may also appear; record it in Notes. No line names `persona_a`, `persona_b` or `persona_c`, and there is no `persona-start` line.
- `recorded` and `same server` are printed, and `ls` reports that neither `config.json.pending` nor `config.json.apply` exists.
- The list has exactly three rows, `cscb_persona_a`, `cscb_persona_b` and `cscb_persona_c`, with the instance IDs recorded in Check 25 step 1. There is no `cscb_persona_d` row: it was killed and deleted.
- Step 7: D posts nothing in D-home or in the DM, and the `grep` prints nothing: D's Slack connection is closed, so its events no longer reach the server.
- Step 8: the prompt stays in D-home as posted; clicking it changes nothing in it (Slack may mark the click as failed), and `ls` reports that `removal-prompt.txt` does not exist.
- Step 9: A replies "quillfeather" in A-home under its own name and avatar.

A `cscb_persona_d` row after the apply, a reply from D, a restart, or any lifecycle line for A, B or C fails this check.

Pass: the confirmed removal of D logged one teardown that completed, D's row is gone and D is silent, the server PID and A's, B's and C's rows are unchanged, A still recalls the word, and any prompt D had posted is inert.

After Check 27, the applied set is A, B and C again, and nothing is pending, as Check 28 needs.


---

## Part 10: Reboot

This check verifies AC 13 (after a host reboot, every persona in the last
applied configuration comes back with no manual action), the live side of
AC 70 (an unconfirmed destructive edit survives the restart and stays
pending) and AC 72 (a credentials change still pending when the server stops
is applied at the next start: the persona connects with its credentials file
as it stands). It covers b.av2 SR-14's host reboot and SR-8.7 (every start, a
start after a reboot included, runs `config.json.last-applied`, and reads the
credentials files as they stand). In passing, it checks SR-7.2 (reload output
never reaches Slack) and SR-10.3 (no token in the pending file or the log).

This is the plan's only reboot. It runs only on the test host and the test
workspace, never on the production install. The Safety section applies
unchanged, and the reboot must disturb nothing but this test. Its two edits
are left unconfirmed on purpose: the record is kept as it is, because running
it is what this check proves.

State at the start: the server that is already running after Check 27, with
A, B and C applied (A's DMs on, `session_restart_delay` restored) and nothing
pending. Resuming conversation history is best effort. A persona that comes
back without its earlier conversation does not fail this check; record it in
Notes.

### Prerequisites

- **A test host**, not the production install (see Safety).
- **The test server starts at boot.** Starting CSCB at boot is the operator's job; CSCB ships no boot mechanism. On the test host only, never on the production install, this plan uses a user crontab `@reboot` line in `<TEST_USER>`'s crontab, and Teardown removes it. Whatever the mechanism, it must run `claude-slack-channel-bots start` as `<TEST_USER>`, with no `SLACK_STATE_DIR` and no token variable in its environment, and must find `bun` and `agent-director` as the operator's shell does. Install the line from the operator's shell on the test host, only if the guard passes (cron's own `PATH` is minimal, so the line carries the shell's):

  ```sh
  if guard; then
    ( crontab -l 2>/dev/null | grep -vF '# cscb-live-b.yko'
      printf "@reboot PATH='%s' claude-slack-channel-bots start >> '%s/cscb-live/boot-start.log' 2>&1  # cscb-live-b.yko\n" "$PATH" "$HOME"
    ) | crontab -
  fi
  crontab -l | grep -F '# cscb-live-b.yko'                               # the one @reboot line
  crontab -l | grep -cE 'SLACK_(BOT|APP)_TOKEN|SLACK_STATE_DIR'           # must print 0
  ```

  Record the mechanism in Notes. If the operator uses another mechanism instead, it must meet the same constraints. Starting the server by hand after the reboot is manual intervention, so it is not a pass.
- **A, B and C applied**, so `config.json.last-applied` exists and matches `config.json` (step 1 checks this).

Load the helpers (`source ~/cscb-live-helpers.sh`) in any new shell,
including the one opened after the reboot. Shell variables don't survive the
reboot, so the marks this check needs later are saved in files under
`~/cscb-live/`.

### Check 28: after a host reboot every applied persona comes back, an unconfirmed edit stays pending, and a pending credentials change is applied (AC 13, AC 70, AC 72)

Steps:

1. Confirm the applied state, and note the persona set and the rows:

   ```sh
   guard && echo 'test host'
   cmp "$S/config.json" "$S/config.json.last-applied" && echo recorded
   ls "$S/config.json.pending"
   jq -r '.personas[].name' "$S/config.json.last-applied"
   agent-director list --label service=cscb
   ```

   Record the persona names and the rows' instance IDs in Notes (they are not secrets).

2. Make a pending credentials change for B, and don't confirm it. B's app is B's alone, so a new app-level token for it affects no other persona, and generating one doesn't revoke the token B's connection uses now:
   1. In B's app settings, **Basic Information** → **App-Level Tokens**, generate a new token with the `connections:write` scope, named `cscb-live-rotated`. Keep the older token.
   2. Note the log mark: `MARK1=$(mark)`.
   3. Re-save B's credentials file with the wizard's credentials command, as its "Rotate a persona's tokens" section says: in `~/cscb-live/wizard`, ask the wizard to rotate `persona_b`'s tokens, and run the command it gives in a real terminal. Answer `yes` to replace the file, then enter B's bot token (unchanged, from B's **OAuth & Permissions** page) and the new `cscb-live-rotated` app-level token at the hidden prompts. Don't ask the wizard to rename anything, and don't rename anything yourself.
   4. Wait about 10 s, then read the preview and check that B keeps serving:

      ```sh
      showpending
      since "$MARK1" | grep -F 'reload-preview:' | showsafe
      since "$MARK1" | grep -E 'persona-start:|Session disconnected|persona teardown|reload-applied'
      tokcount "$S/config.json.pending"   # must print 0
      ```

      In coordination, post "@CSCB Test B reply with the word still-here."

3. Make an unconfirmed destructive edit: remove C from `config.json`, and confirm nothing. Save the file first, for the revert in step 8:

   ```sh
   cp "$S/config.json" ~/cscb-live/config-before-reboot.json
   MARK=$(mark)
   if guard; then
     jq 'del(.personas[] | select(.name == "persona_c"))' "$S/config.json" > "$S/config.json.tmp" \
       && mv "$S/config.json.tmp" "$S/config.json"
   fi
   jq -r '.personas[].name' "$S/config.json"   # must print persona_a and persona_b only
   ```

   Wait at least 30 s (six detection checks), then run:

   ```sh
   showpending
   showpending | grep -F 'DESTRUCTIVE:'
   since "$MARK" | grep -F 'reload-preview:' | showsafe | grep -F 'DESTRUCTIVE:'
   since "$MARK" | grep -E 'persona-start:|Session disconnected'
   agent-director list --label service=cscb
   ```

4. Save the log marks, then reboot. Confirm with `guard` that this is the test host, and reboot it through the operator's normal reboot path:

   ```sh
   guard && mark > ~/cscb-live/reboot-log-mark \
     && { wc -l < "$S/startup-errors.log" 2>/dev/null || echo 0; } > ~/cscb-live/reboot-errors-mark
   ```

   If that path runs `claude-slack-channel-bots stop --stop-bots` before rebooting (the README suggests it before a host reboot), that is part of it; record in Notes whether it ran. It acts on the record's persona set, C included. Run nothing else before the reboot.

5. After the reboot, take no manual action on the server or the bots: don't run `start`, attach to a tmux session, or run any agent-director command other than `list`. Log in as `<TEST_USER>` only to observe, and load the helpers in the new shell. Allow up to 10 minutes for the boot mechanism to start the server and for the start's summary line to appear. Then wait until each persona's `Session connected` line appears too (a persona can connect after the summary line), and run:

   ```sh
   source ~/cscb-live-helpers.sh
   guard && echo 'test host'
   BMARK=$(cat ~/cscb-live/reboot-log-mark)
   kill -0 "$(cat "$S/server.pid")" && echo running
   since "$BMARK" | grep -E 'last-applied record|Loaded persona config|persona-start:|startupSessionManager: complete|\) not brought up:|persona-(credentials|directory)-|persona-slack-unreachable|Session connected: persona "persona_b"'
   agent-director list --label service=cscb
   ```

6. Check what is still pending. Wait at least 30 s after the start's summary line, then run:

   ```sh
   ls "$S/config.json.pending"
   showpending
   grep -c 'persona_b' "$S/config.json.pending"   # must print 0
   since "$BMARK" | grep -F 'reload-preview:' | showsafe | grep -F 'DESTRUCTIVE:'
   cmp "$S/config.json" "$S/config.json.last-applied"
   jq -r '.personas[].name' "$S/config.json.last-applied"
   ```

7. Check that each persona answers as itself, that B runs on the new token, and that nothing about reload reached Slack or leaked a token:
   1. In A-home, post "Reply with the word rebooted." (no mention).
   2. In coordination, post "@CSCB Test B reply with the word rebooted."
   3. In the DM with app C (`<C_DM_ID>`), send "Reply with the word rebooted."
   4. In B's app settings, **App-Level Tokens**, revoke the older token (the one that isn't `cscb-live-rotated`). Note the log mark first: `MARK2=$(mark)`. Wait two minutes, then in coordination post "@CSCB Test B reply with the word rotated." and run `since "$MARK2" | grep -F '(key=persona_b)' | grep -E 'persona-(connection-lost|credentials-refused|slack-unreachable)'`.
   5. Look at A-home, coordination and the operator's DMs with A, B and C for any post made since step 3.
   6. Count token-like strings, without printing any:

      ```sh
      tokcount "$S/config.json.pending"                              # must print 0
      tokcount "$S"/server.log*                                      # must print 0
      tail -n +"$(($(cat ~/cscb-live/reboot-errors-mark) + 1))" "$S/startup-errors.log" 2>/dev/null | grep -c 'reload'   # must print 0
      ```

8. Revert the removal of C, and confirm that it clears the pending change:

   ```sh
   MARK=$(mark)
   if guard; then cp ~/cscb-live/config-before-reboot.json "$S/config.json"; fi
   cmp "$S/config.json" "$S/config.json.last-applied" && echo matches
   ```

   Wait at least 30 s, then run:

   ```sh
   ls "$S/config.json.pending"
   since "$MARK" | grep -F 'reload-nothing-pending:'
   since "$MARK" | grep -E 'persona-start:|Session disconnected|spawnForPersona'
   rm ~/cscb-live/config-before-reboot.json ~/cscb-live/reboot-log-mark ~/cscb-live/reboot-errors-mark
   ```

Expected:

- Step 1: `test host` and `recorded` are printed. `ls` reports that `config.json.pending` does not exist. The record names `persona_a`, `persona_b` and `persona_c`. The list has exactly three rows, `cscb_persona_a`, `cscb_persona_b` and `cscb_persona_c`.
- Step 2: the credentials command prints both `ok` lines and `Wrote <home>/.config/cscb/persona_b-credentials.json with mode 0600. …`. After its two header lines and a blank line, the pending file's preview is `A configuration change is pending; nothing has been applied. personas: 0 added, 0 removed, 0 destructively modified, 0 modified in place, 1 with changed credentials; server-wide settings: 0 changed.` and `persona "persona_b" (key=persona_b): credentials file "<home>/.config/cscb/persona_b-credentials.json" changed: a new connection opens, then the old one closes, instance kept.` The preview names B and the file path and no token, and the `tokcount` prints `0`. The log has the same two lines, prefixed `[slack] reload-preview: `, and no `persona-start`, `Session disconnected`, `persona teardown` or `reload-applied` line: nothing was applied. B replies "still-here" in coordination under its own name and avatar: B keeps serving on its current connection.
- Step 3: `config.json.pending` has exactly one `DESTRUCTIVE:` line, `DESTRUCTIVE: persona "persona_c" (key=persona_c) is removed: its live session will be destroyed (its instance is torn down).`, and B's credentials line after it. Its first line's counts read `personas: 0 added, 1 removed, 0 destructively modified, 0 modified in place, 1 with changed credentials; server-wide settings: 0 changed`. The log has exactly one `[slack] reload-preview:` line with that `DESTRUCTIVE:` line, not repeated over the six checks. There is no `persona-start` or `Session disconnected` line, and the list still has the same three rows: nothing was applied.
- Step 5: `running` is printed. The log has one `[slack] Starting from the last-applied record "<path of config.json>.last-applied"` line and no `No last-applied record` line. It has `[slack] Loaded persona config: 3 persona(s)` and one `[slack] persona-start: personas[<i>] "<name>" (key=<key>): bring-up starting` line for each of `persona_a`, `persona_b` and `persona_c`. It has one `[slack] startupSessionManager: complete — 3 persona(s): …` line ending `0 failed, 0 not brought up, 0 not reconnected`, and no failure line, none for B included: B connected with its credentials file as it stands, the `cscb-live-rotated` token. It has at least one `[slack] Session connected: persona "persona_b" (key=persona_b)` line. The list has exactly one row for each of the three personas, C included. Record the summary line's resumed and fresh counts in Notes. One exception, a transient the server recovers from: when Slack was unreachable for a persona at the start, the summary counts it in `not brought up` and the log has its `persona-slack-unreachable` line (and its `cleared:` line). If that persona then logs `[slack] persona "<name>" (key=<key>): up after its bring-up retry (Slack) — launching` and its `Session connected` line appears within the wait, the summary may end `0 failed, <n> not brought up, 0 not reconnected`, `<n>` being the number of such personas, and their `persona-slack-unreachable` lines up to that retry are not failure lines. Record it in Notes. Any other failure line, or a persona that doesn't connect, still fails this step.
- Step 6: `config.json.pending` is present again. Its first line's counts read `personas: 0 added, 1 removed, 0 destructively modified, 0 modified in place, 0 with changed credentials; server-wide settings: 0 changed`, it has C's `DESTRUCTIVE:` line, and nothing names `persona_b` (the count prints `0`): the start applied B's credentials change, so it is no longer pending, while the unconfirmed removal of C still is. The log has exactly one `[slack] reload-preview:` line with that `DESTRUCTIVE:` line since the reboot: the first check after the start found the edit and logged it once. `cmp` reports that the files differ, and the record still names all three personas.
- Step 7: A answers "rebooted" in A-home, B in coordination and C in the DM with C, each under its own name and avatar. After the older token is revoked, B answers "rotated" in coordination and the `grep` prints nothing: B's connection runs on the new token. No post in Slack mentions a pending change, a preview, `DESTRUCTIVE` or the configuration. All three counts print `0`.
- Step 8: `matches` is printed. `ls` reports that `config.json.pending` does not exist. The log has exactly one line starting `[slack] reload-nothing-pending: the configuration file and the credentials files it references match what is applied; no change is pending`. The last `grep` prints nothing: the revert brought nothing up or down.

A start by hand, C missing after the reboot, a second row for any persona,
`config.json.pending` missing after the reboot, B's credentials change still
pending after the reboot, or B not answering after the older token is revoked
fails this check.

Pass: after a reboot with no manual action, the server started from the
record, every recorded persona (A, B and C) came back with one row each and
answered as itself, B connected with its re-saved credentials file and its
change was no longer pending, the unconfirmed removal of C was still pending,
and the revert cleared it with one `reload-nothing-pending` line.

---

## Part 11: Closing secrecy check

Check 29a verifies AC 20 live (no credential value appears in the config
file, the record, the pending file, any log line the feature produces, or
the tool results in the persona transcripts, b.av2 SR-10.3) and the first
half of the E13 leak check: no WebSocket `wss://` or `ticket=` URL in any
log. AC 20 is unit-verified; the acceptance run is where a real token could
leak, so the check counts across everything the run wrote. It is required,
and needs no `sudo`.

The optional Check 29b is the second half of the E13 leak check: a real
Socket Mode handshake failure logs no WebSocket `ticket=` URL, and the
`[slack] persona Socket Mode: …` connection-health lines appear. It needs
`sudo`, `iptables` and `systemd-run`. The docker scenario
`tests/integration/test-10-credentials-change.sh` (Task 4 of E14) also covers
the handshake failure: it produces a real
one against a loopback Slack stub and checks `server.log` for `wss://`,
`ticket=` and a sentinel. So Check 29b is extra evidence, not the only proof.

Every count counts matches and never prints one. The leak markers are the
run's own tokens: `leakcount` (Part 1.3) reads them from the credentials
files inside bun and prints only counts. `tokcount` counts token-shaped text:
a Slack prefix followed by a digit. A bare prefix can legitimately appear in
a log line that names the rule a bad token broke (b.av2 SR-10.3), so bare
prefixes are not counted.

Error messages are logged redacted (`message="…"` fields, for example), so
the placeholders `<redacted-url>` and `<redacted-token>` may appear in
`server.log`. That is expected: they are counted and recorded, not failed.

State at the start: the server Check 28's reboot started, with A, B and C
applied and nothing pending.

### Check 29a: no credential in any file the run wrote (AC 20)

Run it after every other required check.

Steps:

1. Count, over everything the run wrote. `T` holds every session transcript of the personas A to D (working directories `~/cscb-live/a` to `~/cscb-live/d`, subagent transcripts included):

   ```sh
   source ~/cscb-live-helpers.sh
   F=("$S/config.json" "$S/config.json.last-applied" "$S/config.json.pending" "$S"/server.log* "$S/startup-errors.log" "$S/permission-trail.jsonl" ~/cscb-live/boot-start.log)
   mapfile -d '' T < <(find ~/.claude/projects/ -path '*-cscb-live-[abcd]/*' -name '*.jsonl' -print0)
   echo "persona transcripts: ${#T[@]}"
   ls "$S/config.json.pending"          # nothing is pending, so this reports no such file
   tokcount "${F[@]}"                    # must print 0
   leakcount "${F[@]}"                   # every file: 0 (or absent)
   tokcount "${T[@]}"                    # must print 0
   leakcount "${T[@]}"                   # every file: 0
   history -a
   tokcount "${HISTFILE:-$HOME/.bash_history}" ~/.claude/projects/*-cscb-live-wizard/*.jsonl   # must print 0
   leakcount "${HISTFILE:-$HOME/.bash_history}" ~/.claude/projects/*-cscb-live-wizard/*.jsonl  # every file: 0
   ```

2. Check the logs for WebSocket URLs and unredacted error text:

   ```sh
   cat "$S"/server.log* | grep -cE 'wss://|ticket='                                          # must print 0
   cat "$S"/server.log* | grep -oE 'message="[^"]*"' | grep -cE 'xox[a-z]-[0-9]|xapp-[0-9]'   # must print 0
   cat "$S"/server.log* | grep -cF '<redacted-url>'
   cat "$S"/server.log* | grep -cF '<redacted-token>'
   ```

3. Look back over the destinations the run used (A-home, D-home and the operator's DMs with B, C and D) for a `Spawn failure:` notice. None is expected. If one was posted, record it in Notes: its `Error:` line shows the checked label in backticks, then ` — ` and agent-director's description with URLs and token-like text replaced by `<redacted-url>` and `<redacted-token>`, cut at 300 characters, and no token.

Expected:

- Step 1: `persona transcripts:` is at least `4` (A, B, C and D each have one). `tokens checked: 8` (the bot and app tokens of A, B, C and D; D's file stays until Teardown). Every `tokcount` count and every `leakcount` file count is `0`, and the pending file reports `absent`.
- Step 2: the `wss://|ticket=` count and the `message="…"` count print `0`. Record the two placeholder counts in Notes; any value is acceptable.
- Step 3: no `Spawn failure:` notice, or one that matches the description above.

Any count above `0`, or a `wss://` or `ticket=` in the log, fails this
check. If a token is found, rotate it in Slack and re-run the credentials
command for that persona, and file a bug naming the file and the line number
(never the line's text).

Pass: no token, token-shaped text or WebSocket ticket URL appears in any file
the run wrote, the persona transcripts included.

### Check 29b (optional): a real handshake failure logs no ticket URL

Optional, like Check 26: run it when the test host allows `sudo`, and record
"not run" otherwise. It points Slack's Socket Mode hosts at a closed local
port with a tagged `/etc/hosts` line, and drops the test user's outbound
HTTPS for 90 seconds, so every persona's live connection times out and each
reconnect gets a real WebSocket URL from `apps.connections.open` and then
fails the handshake.

It is safe if the terminal drops mid-check: the firewall rule's removal is
scheduled as a detached root job before the rule is added, and the rule
matches only the test user's processes (`-m owner --uid-owner`). The
`/etc/hosts` line is deleted by its tag in step 5 (or Teardown step 3); while
it stays, no persona can reconnect. So its removal is scheduled too, as a
detached root job started before the line is appended, ten minutes out so it
never fires before step 5 on a normal run; step 5 stops it after the explicit
delete. A dropped terminal leaves the personas unable to reconnect for ten
minutes at most.

`iptables` covers IPv4 only. If the test host reaches Slack over IPv6, the
rule may not break the live connections; step 6 then shows a reconnect before
the restore time, and the leg is recorded as not exercised.

Steps:

1. Check the tools, and that no earlier attempt left anything behind, only if the guard passes:

   ```sh
   if guard; then
     command -v sudo systemd-run && IPT=$(sudo sh -c 'command -v iptables') && echo "IPT=$IPT"
     sudo "$IPT" -S OUTPUT | grep -c 'cscb-live-b\.yko'   # must print 0
     grep -c 'cscb-live-b\.yko' /etc/hosts                # must print 0
     systemctl list-units --all --plain --no-legend 'cscb-live-*' | wc -l   # must print 0: no job left from an earlier attempt
     ip -6 route show default | wc -l                      # 0: no IPv6 default route
   fi
   ```

   If a tool is missing, record the check as "not run". If a count is not `0`, run Teardown step 3's Check 29b part first. A non-zero IPv6 count goes in Notes.

2. Note the log mark, only if the guard passes: `if guard; then MARK=$(mark); echo "MARK=$MARK"; fi`.
3. Back up `/etc/hosts` as the test user, schedule the backstop removal of the tagged line in ten minutes, then append the line, only if the guard passes. The `&&` chain appends nothing unless the removal is scheduled:

   ```sh
   if guard; then
     cp /etc/hosts ~/cscb-live/hosts.before \
       && sudo systemd-run --on-active=600s --unit=cscb-live-hosts sed -i '/# cscb-live-b\.yko$/d' /etc/hosts \
       && printf '127.0.0.1 wss-primary.slack.com wss-backup.slack.com  # cscb-live-b.yko\n' | sudo tee -a /etc/hosts >/dev/null
   fi
   grep -F '# cscb-live-b.yko' /etc/hosts
   ```

4. Schedule the rule's removal in 90 seconds, then add the rule, only if the guard passes. The `&&` chain adds no rule unless the removal is scheduled:

   ```sh
   if guard; then
     sudo systemd-run --on-active=90s --unit=cscb-live-fw \
         "$IPT" -D OUTPUT -p tcp --dport 443 -m owner --uid-owner "$TEST_USER" -j DROP -m comment --comment cscb-live-b.yko \
       && sudo "$IPT" -I OUTPUT -p tcp --dport 443 -m owner --uid-owner "$TEST_USER" -j DROP -m comment --comment cscb-live-b.yko \
       && date -u +%Y-%m-%dT%H:%M:%SZ
   fi
   sudo "$IPT" -S OUTPUT | grep -c 'cscb-live-b\.yko'   # 1 while the rule is in
   ```

   Wait until the job has removed it (up to three minutes):

   ```sh
   for i in $(seq 36); do [ "$(sudo "$IPT" -S OUTPUT | grep -c 'cscb-live-b\.yko')" = 0 ] && break; sleep 5; done
   sudo "$IPT" -S OUTPUT | grep -c 'cscb-live-b\.yko'   # must print 0
   ```

   If it still prints `1`, run Teardown step 3's Check 29b part now. With HTTPS back and the Socket Mode hosts still pointing at the closed port, each reconnect fails the handshake. Wait two minutes.

5. Restore `/etc/hosts` by deleting the tagged line, then stop the backstop job, only if the guard passes, and note the time in UTC, as `server.log` writes it:

   ```sh
   if guard; then
     sudo sed -i '/# cscb-live-b\.yko$/d' /etc/hosts \
       && cmp /etc/hosts ~/cscb-live/hosts.before && rm ~/cscb-live/hosts.before \
       && date -u +%Y-%m-%dT%H:%M:%SZ
     sudo systemctl stop cscb-live-hosts.timer 2>/dev/null; sudo systemctl reset-failed cscb-live-hosts.service 2>/dev/null
   fi
   grep -c 'cscb-live-b\.yko' /etc/hosts   # must print 0
   systemctl is-active cscb-live-hosts.timer   # must print inactive
   ```

6. Wait until each persona's connection is back (up to five minutes), then run:

   ```sh
   since "$MARK" | grep -E 'persona-connection-(lost|restored):'
   ```

7. Read what the outage logged:

   ```sh
   since "$MARK" | grep -F '[slack] persona Socket Mode:' | showsafe
   since "$MARK" | grep -cE 'wss://|ticket='            # must print 0
   since "$MARK" | grep -cF '<redacted-url>'
   since "$MARK" | grep -cF '<redacted-token>'
   ```

   Then in A-home post "Reply with the word reconnected.", and in coordination "@CSCB Test B reply with the word reconnected."
8. Repeat Check 29a steps 1 and 2, so its counts cover the outage's log lines.

Expected:

- Step 3 prints the one tagged `/etc/hosts` line. Step 4 prints a time, then `1`, then `0`: the job removed the rule.
- Step 5: `cmp` succeeds (the file is as it was), the count prints `0` and the backstop timer is `inactive`.
- Step 6: for each of A, B and C, a `[slack] persona-connection-lost: personas[<i>] "<name>" (key=<key>)…: the Socket Mode connection closed; reopening` line and, later, a `[slack] persona-connection-restored: personas[<i>] "<name>" (key=<key>)…: the Socket Mode connection is open again` line. Each restored line's timestamp (UTC) is after the time step 5 printed: while the Socket Mode hosts pointed at the closed port, no reconnect succeeded, so every reconnect in those minutes was a real handshake failure. A restored line before that time means Slack returned a Socket Mode host the `/etc/hosts` line doesn't cover, or the connection went over IPv6: record in Notes that the handshake-failure leg was not exercised, and which persona reconnected. Record the times in Notes.
- Step 7: at least one `[slack] persona Socket Mode: personas[<i>] "<name>" (key=<key>): …` line, each ending with one of the library's fixed health texts: `A ping wasn't received from the server before the timeout of <n>ms!`, `A pong wasn't received from the server before the timeout of <n>ms!` or `Failed to send ping to Slack`. The `wss://|ticket=` count prints `0`: the handshake failures logged no WebSocket URL and no ticket. Record the two placeholder counts in Notes; any value is acceptable. A replies "reconnected" in A-home and B in coordination, each under its own name and avatar.
- Step 8: Check 29a's expected results hold again.

A `wss://` or `ticket=` in the log, no `[slack] persona Socket Mode:` line
after the outage, or a count above `0` in step 8 fails this check.

Pass: the outage logged the Socket Mode health lines and each persona's lost
and restored lines, with no WebSocket ticket URL, and every persona answered
after it.

---

## Teardown

The run's single teardown, on the test host only. Run it whatever the
results, and also when the run stopped early.

1. Stop the test server and exit the bots, only if the guard passes:

   ```sh
   source ~/cscb-live-helpers.sh
   if guard; then claude-slack-channel-bots stop --stop-bots; fi
   agent-director list --label service=cscb        # rows remain, stopped, for resume
   ```

   `stop --stop-bots` stops the server first, then exits each persona in the record (in `config.json` when there is none).

2. If the run stopped before Check 27 removed D, D's instance may still be running: `tmux has-session -t slack_bot_persona_d` succeeding means it is. Its row names a persona no configuration lists after step 4, so the next start's sweep would kill and delete it; on a host that won't start CSCB again, end it from D's tmux session (`tmux attach -t slack_bot_persona_d`, then `/exit`).

3. Undo the host changes the run made, only if the guard passes. First the boot line:

   ```sh
   if guard; then
     crontab -l 2>/dev/null | grep -vF '# cscb-live-b.yko' | crontab -
   fi
   crontab -l 2>/dev/null | grep -cF '# cscb-live-b.yko'   # must print 0
   ```

   Then, if Check 29b ran or was started, its part: stop the firewall job if it hasn't fired, delete the firewall rule until none is left, delete the tagged `/etc/hosts` line, then stop the `/etc/hosts` backstop job if it hasn't fired:

   ```sh
   if guard; then
     IPT=$(sudo sh -c 'command -v iptables')
     sudo systemctl stop cscb-live-fw.timer 2>/dev/null; sudo systemctl reset-failed cscb-live-fw.service 2>/dev/null
     while sudo "$IPT" -S OUTPUT | grep -q 'cscb-live-b\.yko'; do
       sudo "$IPT" -D OUTPUT -p tcp --dport 443 -m owner --uid-owner "$TEST_USER" -j DROP -m comment --comment cscb-live-b.yko || break
     done
     sudo sed -i '/# cscb-live-b\.yko$/d' /etc/hosts
     sudo systemctl stop cscb-live-hosts.timer 2>/dev/null; sudo systemctl reset-failed cscb-live-hosts.service 2>/dev/null
     rm -f ~/cscb-live/hosts.before
   fi
   sudo "$IPT" -S OUTPUT | grep -c 'cscb-live-b\.yko'   # must print 0
   grep -c 'cscb-live-b\.yko' /etc/hosts                # must print 0
   systemctl list-units --all --plain --no-legend 'cscb-live-*' | wc -l   # must print 0
   ```

   If the rule count is not `0`, a rule with another shape carries the tag: list it with `sudo "$IPT" -L OUTPUT --line-numbers` and delete it by number (`sudo "$IPT" -D OUTPUT <n>`).

4. Return the state directory to the postinstall skeleton, with the server stopped, so the next run starts from a clean install state. This is clean-up for the next run, never a way to apply a change: it runs only with the server stopped.

   ```sh
   if guard && [ ! -e "$S/server.pid" ]; then
     rm -f "$S/config.json.last-applied" "$S/config.json.pending" "$S/config.json.apply" "$S/config.json.tmp"
     printf '{\n  "personas": []\n}\n' > "$S/config.json"
   fi
   ls "$S/config.json.last-applied"   # must not exist
   ```

   If `access.json` is still there and Check 14 created it (`CREATED=1`), remove it: `rm "$S/access.json"`.

5. Remove the run's files, the credentials files included when the test apps are retired:

   ```sh
   rm -f ~/cscb-live-helpers.sh ~/cscb-live/pkg-before.sha256 ~/cscb-live/creds-*.typescript ~/cscb-live/boot-start.log
   rm -rf ~/cscb-live/scratch-state.*
   if guard; then rm ~/.config/cscb/persona_*-credentials.json; fi   # only when the test apps are retired
   ```

6. In the test workspace, either leave the four test apps ("CSCB Test A" to "CSCB Test D") and the channels in place for a rerun, or delete the apps (each app's **Basic Information** → **Delete App**) and archive A-home, coordination and D-home. Record which in Notes.

agent-director keeps the stopped rows for resume, and the pre-flight fails
while they exist. A rerun on this host needs them removed with
agent-director's own tools first, or a fresh test host. A rerun also needs a
second test user and a first-time user that meet Part 1.1 again: this run's
accounts now have a DM with A and a history with A and B.

---

## Results

The operator adds one row per run. Record pass, fail or "not run" only, never
a token or a log excerpt containing one. Notes name no person.

| Date | Build (version, commit) | Host / user | S1 | S2 | S3 | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10 | 11 | 12 | 13 | 14 | 15 | 16 | 17 | 18 | 19 | 20 | 21 | 22 | 23 | 24 | 25 | 26 (optional) | 27 | 28 (reboot) | 29a | 29b (optional) | Notes |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| | | | | | | | | | | | | | | | | | | | | | | | | | | | | | | | | | | | | |
