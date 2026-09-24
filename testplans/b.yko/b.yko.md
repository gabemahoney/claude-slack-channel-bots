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

Live acceptance run for idea b.av2 (personas), built by plan b.ob2. It runs
three persona apps against a real test Slack workspace and proves AC 14 (the
setup is only `config.json` plus the credentials files) and AC 47 (no token
environment). It also gives live evidence for AC 1, 2, 4, 12, 28 and 31.

Plan b.ob2's Epic 3 created this ticket and filled in only the channel checks.
Later Epics append their sections under the placeholder headings below.

This is not a docker integration test. `/ci` and `/release-test` never run it.
Its title deliberately does not start with "Test ".

---

## Safety

Read this section before every run.

- **Operator-run only**, on a **test Slack workspace**. Never on a workspace that production bots serve.
- **Never on the production install.** Use a dedicated host or VM whose HOME holds no production CSCB state (`~/.claude/channels/slack/`) and no production `~/.agent-director`. The start sweep kills and deletes every `service=cscb` agent-director row that names no configured persona, so a test server sharing `~/.agent-director` with a production CSCB would destroy the production bots. A dedicated OS user is acceptable only on a host that runs no production CSCB at all: only one CSCB server runs per host (they would both need port 3100).
- **Never through `/ci` or `/release-test`.** Only the operator runs this plan, by hand.
- **Never paste a token** into a chat, this ticket, the results table, a log or a shell command line. The operator creates the credentials files from the terminal (see Setup).

### Pre-flight

Save this script once on the test host and set `TEST_HOST` to the test host's name as `hostname` prints it. It exits non-zero, naming the first failed condition, unless the host is the named test host, no CSCB server is running, `127.0.0.1:3100` is free, agent-director lists no `service=cscb` row, there is no `server.pid`, and `config.json` is as the phase expects. It prints no file contents.

```sh
cat > ~/cscb-live-preflight.sh <<'EOF'
#!/usr/bin/env bash
# b.yko pre-flight. Usage: bash ~/cscb-live-preflight.sh setup|check1
set -u
TEST_HOST='<TEST_HOST>'   # the test host's name, exactly as `hostname` prints it
PHASE="${1:?usage: bash ~/cscb-live-preflight.sh setup|check1}"
STATE="$HOME/.claude/channels/slack"
fail() { echo "PRE-FLIGHT FAILED: $*" >&2; exit 1; }

[ "$(hostname)" = "$TEST_HOST" ] || fail "hostname is not $TEST_HOST"
[ -z "${SLACK_STATE_DIR:-}" ] || fail "SLACK_STATE_DIR is set; this plan uses the default state directory"
[ -z "$(pgrep -af 'cli\.ts start')" ] || fail "a CSCB server process is running on this host"
if (exec 3<>/dev/tcp/127.0.0.1/3100) 2>/dev/null; then fail "127.0.0.1:3100 is in use"; fi
ad_out="$(agent-director list --label service=cscb)" || fail "agent-director list failed"
printf '%s' "$ad_out" | bun -e 'try { const r = JSON.parse(await Bun.stdin.text()); process.exit(Array.isArray(r.spawns) && r.spawns.length === 0 ? 0 : 1) } catch { process.exit(1) }' \
  || fail "agent-director lists service=cscb rows"
[ ! -e "$STATE/server.pid" ] || fail "$STATE/server.pid exists"

CFG="$STATE/config.json"
case "$PHASE" in
  setup)   # before Setup: config.json absent, or exactly the postinstall skeleton
    if [ -e "$CFG" ]; then
      CFG="$CFG" bun -e 'try { const c = JSON.parse(await Bun.file(process.env.CFG).text()); process.exit(JSON.stringify(c) === "{\"personas\":[]}" ? 0 : 1) } catch { process.exit(1) }' \
        || fail "$CFG exists and is not {\"personas\": []}"
    fi ;;
  check1)  # before Check 1: config.json names exactly this plan's three personas
    CFG="$CFG" bun -e 'try { const c = JSON.parse(await Bun.file(process.env.CFG).text()); const n = (c.personas ?? []).map((p) => p.name).sort().join(","); process.exit(n === "persona_a,persona_b,persona_c" ? 0 : 1) } catch { process.exit(1) }' \
      || fail "$CFG does not name exactly persona_a, persona_b and persona_c" ;;
  *) fail "unknown phase $PHASE" ;;
esac
echo "pre-flight passed ($PHASE)"
EOF
```

Run it before Setup, and again right before Check 1:

```sh
bash ~/cscb-live-preflight.sh setup    # before Setup
bash ~/cscb-live-preflight.sh check1   # right before Check 1
```

If it fails, stop: this is not a clean test host. Rows left by an earlier run also fail it, because Check 1 expects every persona to be fresh-spawned.

---

## Setup

The setup uses only the Slack apps, the credentials files and `config.json`
(AC 14). No code is edited and no token is set in the environment (AC 47).

Install the build under test on the test host with README Quick Start steps 1
and 2 only (install and trust). Do not run the setup skill: it still exports
token variables and writes a `routes` config, which breaks AC 14 and AC 47.

### 1. Three Slack apps

Create three Slack apps in the test workspace from the shipped
`slack-app-manifest.yml`. Give each its own display name and avatar, so the
three are told apart at a glance (for example "CSCB Test A", "CSCB Test B",
"CSCB Test C", each with a different avatar). Install each app to the
workspace and generate its app-level token (`connections:write`).

Create two channels in the test workspace:

- **A-home**: invite app A.
- **coordination**: invite apps A and B.

App C is invited to no channel.

Note the two channel IDs and the operator's own Slack user ID (the DM
contact). They replace the placeholders `<A_HOME_CHANNEL_ID>`,
`<COORDINATION_CHANNEL_ID>` and `<OPERATOR_USER_ID>` below.

### 2. One credentials file per persona

The operator creates the credentials files. Create each from the terminal
without echoing the tokens: `read -s` hides the input, and `printf` is a shell
builtin, so the tokens never appear in the process list or shell history.
Repeat for `persona_a`, `persona_b` and `persona_c`, pasting that app's tokens:

```sh
umask 077
mkdir -p ~/.config/cscb-test
read -rs -p 'bot token (xoxb-…): ' BOT; echo
read -rs -p 'app token (xapp-…): ' APP; echo
printf '{"bot_token":"%s","app_token":"%s"}\n' "$BOT" "$APP" > ~/.config/cscb-test/persona_a-credentials.json
unset BOT APP
chmod 600 ~/.config/cscb-test/persona_a-credentials.json
```

Check the modes without printing the contents:

```sh
ls -l ~/.config/cscb-test/     # each file: -rw-------
```

### 3. `config.json`

Replace the postinstall skeleton at `~/.claude/channels/slack/config.json`
with the three personas:

- **A** (`persona_a`): receive-all in A-home, mentions-only in coordination, prompts to A-home.
- **B** (`persona_b`): mentions-only in coordination, DMs on, `dm` destination.
- **C** (`persona_c`): no channels, DM-only, `dm` destination and a DM contact.

```json
{
  "personas": [
    {
      "name": "persona_a",
      "credentials_file": "~/.config/cscb-test/persona_a-credentials.json",
      "working_directory": "~/cscb-live/a",
      "channels": [
        { "id": "<A_HOME_CHANNEL_ID>", "delivery": "all" },
        { "id": "<COORDINATION_CHANNEL_ID>", "delivery": "mentions" }
      ],
      "permission_prompts": "<A_HOME_CHANNEL_ID>"
    },
    {
      "name": "persona_b",
      "credentials_file": "~/.config/cscb-test/persona_b-credentials.json",
      "working_directory": "~/cscb-live/b",
      "channels": [
        { "id": "<COORDINATION_CHANNEL_ID>", "delivery": "mentions" }
      ],
      "dm": { "enabled": true, "contact": "<OPERATOR_USER_ID>" },
      "permission_prompts": "dm"
    },
    {
      "name": "persona_c",
      "credentials_file": "~/.config/cscb-test/persona_c-credentials.json",
      "working_directory": "~/cscb-live/c",
      "dm": { "enabled": true, "contact": "<OPERATOR_USER_ID>" },
      "permission_prompts": "dm"
    }
  ],
  "port": 3100
}
```

Create the working directories and check that they exist:

```sh
mkdir -p ~/cscb-live/a ~/cscb-live/b ~/cscb-live/c
ls -d ~/cscb-live/a ~/cscb-live/b ~/cscb-live/c
```

### 4. No token environment

The starting shell must have no token variable:

```sh
unset SLACK_BOT_TOKEN SLACK_APP_TOKEN
env | grep -c -E '^SLACK_(BOT|APP)_TOKEN=' # must print 0
```

### Limits of this build (E3)

These are expected in this build and are not failures:

- DMs to any persona are dropped until E6.
- B's `dm` destination only writes its prompts and notices to `server.log` until E7.
- So B is checked only by its coordination-channel mention, and C only by its `agent-director` row.

---

## E3 channel checks

Each check lists its steps, the expected observation and a pass line. Record
every result in the results table at the end.

### Check 1: start with no token variables

Steps:

```sh
bash ~/cscb-live-preflight.sh check1   # must print "pre-flight passed (check1)"
unset SLACK_BOT_TOKEN SLACK_APP_TOKEN
claude-slack-channel-bots start
```

Expected:

- `start` prints `[slack] Server starting in background (PID <pid>)` and exits 0.
- `~/.claude/channels/slack/server.log` contains (match literally; `Session connected` lines may interleave with the others):
  - `[slack] Loaded persona config: 3 persona(s)`
  - `[slack] startupSessionManager: 3 persona(s), concurrency=3`
  - one line per persona: `[slack] spawnForPersona: spawned "persona_a" (key=persona_a) instanceId=cscb_persona_a`, and the same for `persona_b` and `persona_c`
  - `[slack] startupSessionManager: complete — 3 persona(s): 0 resumed, 3 fresh-spawned, 0 fresh-after-amnesia, 0 fresh-after-inconclusive-amnesia, 0 reconnected, 0 no-op, 0 failed, 0 not brought up`
  - one line per persona: `[slack] Session connected: persona "persona_a" (key=persona_a) cwd="<real path of ~/cscb-live/a>"`, and the same for B and C
- No line of the form `[slack] persona "<name>" (key=<key>) not brought up:` for any persona.

The per-persona `persona-start` line arrives with E5, which updates this check.

Pass: `start` exits 0 with both token variables unset, and every line above is present.

### Check 2: each persona replies as itself

Steps:

1. In A-home, post a message that mentions no one, for example "Reply with the word ready."
2. In coordination, post a message that @mentions B, for example "@CSCB Test B reply with the word ready."

Expected:

- A replies in A-home under A's name and avatar.
- B replies in coordination under B's name and avatar, which differ from A's.

Pass: each reply comes from the addressed persona's own app identity.

### Check 3: a mention reaches only the persona mentioned

Steps: in coordination, post a message that @mentions A only, for example "@CSCB Test A reply with the word here." Wait two minutes.

Expected: A replies in coordination. B posts nothing, in the channel or in a thread.

Pass: A's reply is present and nothing from B appears.

### Check 4: one instance hears both of A's channels (AC 2)

Steps:

1. In A-home, post "Remember the word lantern."
2. In coordination, post "@CSCB Test A what word did I ask you to remember?"
3. Run `agent-director list --label service=cscb`.

Expected: A answers "lantern" in coordination, having received the A-home message in the same instance. The list shows a single row for A.

AC 12's receive-all-in-every-channel case is covered by the `persona-routing` unit tests, because A is mentions-only in coordination.

Pass: A replies in both channels from one instance and knows the word.

### Check 5: permission prompts go to A's destination (AC 28, AC 31)

Steps:

1. In A-home, ask A for work that needs a tool approval, for example "Run a shell command that writes the current date to a file named permission-check.txt in your working directory."
2. Click **Allow** on the prompt.
3. In coordination, @mention A with a similar request (a different file name). Click **Allow** on the prompt.

Expected:

- The first request's permission prompt is posted in A-home, under A's name and avatar, with **Allow** and **Deny** buttons.
- **Allow** resolves the request: the prompt message updates to `*Permission* — Allowed`, and A goes on with the work.
- The second request, started from coordination, also prompts in A-home. No prompt is posted in coordination.

Pass: both prompts appear in A-home only, and both resolve on **Allow**.

### Check 6: one agent-director row per persona

Steps:

```sh
agent-director list --label service=cscb
```

Expected: exactly three rows, with instance IDs `cscb_persona_a`, `cscb_persona_b` and `cscb_persona_c`. Each row carries a `persona` label naming its key.

Pass: one row per persona, with the expected instance ID and `persona` label.

### Check 7: crash and recover (AC 4)

Steps:

1. Kill A's tmux session to simulate a crash: `tmux kill-session -t slack_bot_persona_a`.
2. Wait for the auto-restart (the default `session_restart_delay` is 60 s; allow up to five minutes). Watch `server.log`.
3. Run `agent-director list --label service=cscb`.
4. In A-home, post "Reply with the word back."

Expected:

- `server.log` shows `[slack] Session disconnected` for persona `"persona_a" (key=persona_a)`, then `[slack] Scheduling restart for persona=persona_a in <n>s (backoff)`, `[slack] Relaunching session for persona=persona_a cwd="<working directory>"` and a new `[slack] Session connected: persona "persona_a" (key=persona_a)` line.
- The list again shows exactly three rows, one per persona, as in Check 6.
- A replies "back" in A-home under its own name and avatar.

Pass: one row per persona after the cycle, and A answers the new message.

---

## Bot-to-bot, broadcast and persona-post event capture (appended by E4)

Placeholder. E4 fills in this section.

## DMs (appended by E6)

Placeholder. E6 fills in this section, including B's and C's DM checks.

## DM prompts (appended by E7)

Placeholder. E7 fills in this section, including prompts to B's and C's `dm` destination.

## Lost message (appended by E8)

Placeholder. E8 fills in this section.

## Reboot (appended by E11)

Placeholder. E11 fills in this section: a host reboot, after which every persona comes back.

## Runtime add and remove (appended by E12)

Placeholder. E12 fills in this section.

## Setup from the wizard and README only (appended by E14)

Placeholder. E14 fills in this section.

---

## Teardown

On the test host only, after confirming `hostname` and `whoami` again:

```sh
claude-slack-channel-bots stop --stop-bots
agent-director list --label service=cscb        # rows remain, stopped, for resume
```

Remove the credentials files when the run is over if the test apps are
retired: `rm ~/.config/cscb-test/*-credentials.json`.

---

## Results

The operator adds one row per run. Record pass or fail only, never a token or
a log excerpt containing one.

| Date | Build commit | Host / user | Check 1 | Check 2 | Check 3 | Check 4 | Check 5 | Check 6 | Check 7 | Notes |
|---|---|---|---|---|---|---|---|---|---|---|
| | | | | | | | | | | |
