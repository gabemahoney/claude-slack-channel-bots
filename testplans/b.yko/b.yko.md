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

### Expected in this setup

These are expected and are not failures:

- The E3 checks cover B only by its coordination-channel mention, and C only by its `agent-director` row. The DMs section (E6) and the DM prompts section (E7) check B and C over DMs.
- B's and C's permission prompts and notices go to the operator's DM with that persona's app, never to a channel.
- A has DMs off in this setup (no `dm` field), so a DM to A is dropped until the DMs section turns A's DMs on.

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
  - one line per persona: `[slack] persona-start: personas[0] "persona_a" (key=persona_a): bring-up starting`, and the same for `persona_b` (`personas[1]`) and `persona_c` (`personas[2]`)
  - one line per persona: `[slack] spawnForPersona: spawned "persona_a" (key=persona_a) instanceId=cscb_persona_a`, and the same for `persona_b` and `persona_c`
  - `[slack] startupSessionManager: complete — 3 persona(s): 0 resumed, 3 fresh-spawned, 0 fresh-after-amnesia, 0 fresh-after-inconclusive-amnesia, 0 reconnected, 0 no-op, 0 failed, 0 not brought up`
  - one line per persona: `[slack] Session connected: persona "persona_a" (key=persona_a) cwd="<real path of ~/cscb-live/a>"`, and the same for B and C
- No line of the form `[slack] persona "<name>" (key=<key>) not brought up:` for any persona.

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

These checks verify AC 7, 8, 11 and 18 and b.av2 SR-4.1 (per-persona dedupe),
SR-4.2 (the delivery decision, including own-post exclusion and no limit on
bot-to-bot delivery) and SR-4.4 (the `user_id` / `bot_id` and `via` tag
attributes). They also capture the real Slack event shape of a persona's post.
That shape is the evidence behind the delivery module's self-exclusion by bot
user ID or bot ID, and behind its handling of the `bot_message` subtype.

Like the rest of this plan, the section runs only on the test workspace and
the test host's server, never on the production install. The Safety section
applies unchanged. Run it after Check 7, on the server Check 1 started. If the
server was stopped since, confirm with `hostname` and `whoami` that this is
still the test host and its user, then run `unset SLACK_BOT_TOKEN
SLACK_APP_TOKEN` and `claude-slack-channel-bots start`. Do not rerun the
check1 pre-flight: it fails on the `service=cscb` rows Checks 1–7 created,
which the restart resumes.

### Setup for these checks

Nothing is added to `config.json`. The layout from Setup is what these checks
rely on: coordination holds only A and B, both mentions-only there, and C is
in no channel.

Note two more IDs from Slack (open each app's profile in the workspace and
copy its member ID). They replace the placeholders below:

- `<A_BOT_USER_ID>`: app A's bot user ID (`U…`).
- `<B_BOT_USER_ID>`: app B's bot user ID (`U…`).

Check 8 records A's bot ID (`B…`) as `<A_BOT_ID>`.

A message's `<TS>` is its Slack timestamp. Take it from the message's
**Copy link** URL: the last path part is `p` followed by 16 digits; put a dot
before the last six digits (`p1790000000123456` is `1790000000.123456`).

### How to observe delivered tags

The persona's session transcript is the authoritative record of what reached
the persona. Every delivered Slack message appears in it as a user entry whose
content starts with a `<channel …>` tag. The count of those tags for a
message's `<TS>` is its delivery count, and the tag's attributes give `via` and
the author's `user_id` or `bot_id`.

The plan's `config.json` sets no `claude_config_dir`, so each transcript is
under `~/.claude/projects/`, in the directory named after the persona's
working directory. Define this read-only helper in the tester's shell. It
prints every delivered tag for one message in one persona's current
transcript:

```sh
tags() {  # usage: tags a|b|c <TS>
  local t
  t="$(ls -t ~/.claude/projects/*-cscb-live-"$1"/*.jsonl | head -1)"
  jq -r 'select(.type == "user") | .message.content
         | if type == "string" then . else (.[]? | .text? // empty) end' "$t" \
    | grep -oE '<channel source="slack[^"]*"[^>]*>' | grep -F " ts=\"$2\""
}
```

It reads only `type == "user"` entries: the transcript also records a queue
entry for each incoming message, which would double the count. Do not ask a
persona to quote its own tag; its answer is not evidence.

`~/.claude/channels/slack/server.log` corroborates the transcript with these
lines:

- `[slack] RAW message event persona=<key>: …` and `[slack] RAW app_mention event persona=<key>: …`: one per event the persona's connection received. The text after the colon is the first 300 characters of the event JSON.
- `[slack] Dispatching to persona "<name>" (key=<key>) chat_id=<channel> …`: one per message delivered to that persona.
- `[slack] persona "<name>" (key=<key>) dropped message from channel=<channel> user=<U…>: <reason>` (or `bot_id=<B…>` for an author without a user): one per message the persona's pipeline dropped, for example with reason `own` or `not-mentioned`.

A duplicate event, such as the second of a `message` / `app_mention` pair,
logs its RAW line and nothing else.

### Check 8: persona-post event shape (SR-4.2)

Steps:

1. In A-home, post: "Post this exact text in coordination, chat_id `<COORDINATION_CHANNEL_ID>`, with no formatting and no files: `<@<B_BOT_USER_ID>> shape check, no reply needed`. Then reply here with the word posted."
2. When A says posted, copy the link of A's coordination post and work out its `<TS>`.
3. Find the raw event B's connection logged for that post:

   ```sh
   grep -F 'RAW message event persona=persona_b:' ~/.claude/channels/slack/server.log | grep -F '<TS>'
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
   grep -F 'persona=persona_a:' ~/.claude/channels/slack/server.log | grep -F '<TS>'
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
2. Run `tags a <TS>`, `tags b <TS>` and `tags c <TS>`, and `grep -F 'persona=persona_c:' ~/.claude/channels/slack/server.log | grep -F '<TS>'`.
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

1. In A-home, post: "In coordination, chat_id `<COORDINATION_CHANNEL_ID>`, post a message that mentions `<@<B_BOT_USER_ID>>` and asks B what 7 times 6 is. Tell B to mention you as `<@<A_BOT_USER_ID>>` in every answer. Each time B answers, reply to B in coordination, mentioning it, with one more short arithmetic question. Keep going until I tell you to stop."
2. Work out the `<TS>` of A's first coordination post, and of B's reply to it. Run `tags b <TS of A's post>` and `tags a <TS of B's reply>`.
3. Let the exchange run until A and B have each posted at least two more times after B's first reply. Take one later post from each and check it with `tags` in the same way.
4. **Stop the exchange.** In coordination, post "@CSCB Test A @CSCB Test B stop the exchange now. Do not post in this channel again." Wait two minutes and watch coordination.
5. Search the log for any limit or throttle message:

   ```sh
   grep -inE 'limit|throttl|loop|too many' ~/.claude/channels/slack/server.log
   ```

Expected:

- `tags b <TS of A's post>` prints exactly one tag, with `via="mention"` and `user_id="<A_BOT_USER_ID>"` (or `bot_id="<A_BOT_ID>"`).
- B replies in coordination under B's own name and avatar, which differ from A's, and its reply mentions A.
- `tags a <TS of B's reply>` prints exactly one tag, with `via="mention"` and `user_id="<B_BOT_USER_ID>"` (or B's `bot_id`), and A answers it.
- The later posts checked in step 3 are each delivered exactly once to the persona they mention, with `via="mention"`.
- Every turn is delivered: no turn goes unanswered until the stop, and each has its `Dispatching to persona` line.
- No server-side limit, counter or throttle message appears, in Slack or in `server.log`. The step 5 search returns no line about bot-to-bot delivery. Judge each match it returns; Slack API rate-limit lines unrelated to delivery are not a failure but go in Notes.

Whether the personas obey the stop message is the bots' behaviour, not the
server's, so it does not decide this check. If either persona keeps posting
two minutes after the stop message, end the exchange with the Teardown
commands and record that in Notes; the check's result rests on the Expected
items above.

Pass: B receives A's mention once with A's identity and answers as itself,
and the exchange continues for at least two more turns each with no limit or
throttle message.

## DMs (appended by E6)

These checks verify AC 15, 35, 36 (outbound leg), 37, 38, 40 and 41, and AC 17
in passing: the DM sender has no allowlist entry and gets no pairing step.
They cover b.av2 SR-4.3 (a DM is decided only against the persona whose app
received it, by its DMs switch) and SR-5.1 (a persona's DM posting targets).
Check 18 also covers the edited-event dedupe: an edit that adds a persona's
mention wakes it once.

Like the rest of this plan, the section runs only on the test workspace and
the test host's server, never on the production install. The Safety section
applies unchanged. Run it after Check 12, on the server that is already
running. If the server was stopped since, restart it as the E4 section says
(confirm `hostname` and `whoami`, unset the token variables, `start`; do not
rerun the check1 pre-flight).

**Run order:** Check 19 (in "DM prompts", below) runs in this section, after
Check 15 and before Check 16. It needs a contact that has never had a DM with
C's app, and Check 16 step 2 creates that DM.

### Setup for these checks

The DMs switch per persona, as these checks use it:

| Persona | `dm.enabled` in Checks 13–14 | `dm.enabled` in Checks 15–18 |
|---|---|---|
| A (`persona_a`) | off (Setup's config has no `dm` field) | on (the restart step below adds it) |
| B (`persona_b`) | on, `dm` destination | on |
| C (`persona_c`) | on, `dm` destination, `dm.contact` set | on |

Only A changes, and only through `config.json` and a restart of the test
server, so the setup stays config-file only (AC 14). B and C cannot be
switched off: a `dm` destination, or zero channels, needs DMs on (b.av2
SR-1.5), so the config would be refused.

Every persona app must carry the `im:write` bot scope, which opening a DM
with a user needs. The shipped `slack-app-manifest.yml` grants it. To check,
open each app's **OAuth & Permissions** page and confirm `im:write` is listed
under Bot Token Scopes. An app created from an older manifest gets `im:write`
added and is then re-installed, as the `debug-slack-channel-bots` skill's
section "A persona can't open a DM: re-install its app to gain `im:write`"
says. The bot token normally stays the same; if the OAuth & Permissions page
shows a different token, re-create that persona's credentials file as in
Setup step 2, then restart the test server before Check 13 with the guarded
stop and start of "Turn A's DMs on" (its steps 1, 2 and 4, without the config
edit). The operator compares the token outside the chat; never print it or
compare it in a chat.

A **second test user** is needed: a user account in the test workspace, other
than the operator's, that the operator can sign in as (for example in another
browser profile). It must never have had a DM with app A: in that account's
sidebar and **Apps** list, no conversation with "CSCB Test A" exists. Its
member ID (`U…`, from its profile) replaces `<SECOND_USER_ID>` below. A
second test user from an earlier run already has a DM with A (Check 17 opened
it), so a rerun uses a user that A has never messaged.

Note two more values for the restart step below: `<TEST_HOST>`, the test
host's name exactly as `hostname` prints it (the pre-flight's `TEST_HOST`),
and `<TEST_USER>`, the test host's user exactly as `whoami` prints it.

Define these shell helpers in the tester's shell, next to `tags`. `LOG` names
the server log, and `since <mark>` prints only the log lines after line
`<mark>`. `server.log` is appended across runs and checks, so each check
records a mark first and reads only the lines after it:

```sh
LOG=~/.claude/channels/slack/server.log
since() { tail -n +"$(($1 + 1))" "$LOG"; }   # usage: since <mark>
```

Define this read-only helper next to `tags` (see "How to observe delivered
tags"). It prints every `reply` tool call in one persona's current transcript,
with its target and the tool's result:

```sh
replies() {  # usage: replies a|b|c
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
```

The last lines of `replies a` are A's most recent calls, so a check picks
out its call by target, for example
`replies a | grep -F 'chat_id=<SECOND_USER_ID>' | tail -n 1`. The result text
is what the server returned to the persona; a refusal is returned to the
persona only, never logged, so the transcript is where it is read. Claude Code
may wrap an MCP error's text, so a check matches the expected text with
"contains", not as the whole result. As with `tags`, a persona's own account
of a tool result is not evidence.

Check 18 also needs a text-keyed variant of `tags`, for a message whose
delivered tag may not carry the `<TS>` from its link (an edited message). It
prints the `<channel …>` tag of every user entry in one persona's current
transcript whose content contains the given text:

```sh
tagstext() {  # usage: tagstext a|b|c '<text>'
  local t
  t="$(ls -t ~/.claude/projects/*-cscb-live-"$1"/*.jsonl | head -1)"
  jq -r --arg s "$2" 'select(.type == "user") | .message.content
         | if type == "string" then . else (.[]? | .text? // empty) end
         | select(contains($s))' "$t" \
    | grep -oE '<channel source="slack[^"]*"[^>]*>'
}
```

A DM message's `<TS>` comes from its **Copy link** URL, as for channel
messages. The same URL's path holds the DM conversation ID (`D…`): note the
one between the operator and A as `<A_DM_ID>`, and likewise `<B_DM_ID>` and
`<C_DM_ID>`.

### Check 13: a DM to a persona with DMs off is dropped with a log line (AC 35)

A's DMs are off, as Setup configured it.

Steps:

1. Record where the log ends: `MARK=$(wc -l < "$LOG")`.
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

### Check 14: a persona with DMs off refuses to message a user (AC 36, outbound leg)

A's DMs are still off. Run this before Check 17, which opens the DM between A
and the second test user.

Steps:

1. Record where the log ends: `MARK=$(wc -l < "$LOG")`.
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

This is a config edit and a restart of the test server, not a runtime
reload. Plain `stop` leaves the persona instances running; `start` brings
them back to the server.

1. Define the guard. It fails, and says why, unless this is the test host
   and its user (the pre-flight's hostname comparison, plus the user), and
   unless `config.json.last-applied` is absent from the test state directory.
   That file belongs to a later Epic's confirmed reload; if it exists, a
   restart would leave this edit pending rather than applied, so stop the
   section and record that in Notes.

   ```sh
   guard() {
     [ "$(hostname)" = '<TEST_HOST>' ] && [ "$(whoami)" = '<TEST_USER>' ] \
       || { echo 'NOT THE TEST HOST - stop'; return 1; }
     [ ! -e ~/.claude/channels/slack/config.json.last-applied ] \
       || { echo 'config.json.last-applied exists - stop'; return 1; }
   }
   ```

2. Stop the test server only if the guard passes, and note where the log ends:

   ```sh
   if guard; then
     claude-slack-channel-bots stop
     LOG_MARK=$(wc -l < "$LOG"); echo "LOG_MARK=$LOG_MARK"
   fi
   ```

   If it prints `NOT THE TEST HOST - stop` or `config.json.last-applied exists - stop`, do nothing more in this section.

3. In `~/.claude/channels/slack/config.json`, add this line to the `persona_a` entry, after its `channels` array (mind the commas):

   ```json
   "dm": { "enabled": true },
   ```

   Then check the file still parses: `jq -e '.personas[0].dm.enabled' ~/.claude/channels/slack/config.json` must print `true`.
4. Start the test server with no token variables, again only if the guard passes:

   ```sh
   if guard; then
     unset SLACK_BOT_TOKEN SLACK_APP_TOKEN
     claude-slack-channel-bots start
   fi
   ```

5. Wait until the start's summary line and each persona's `Session connected` line appear. This can take about 3–5 minutes after a restart. Then read this start's lines:

   ```sh
   since "$LOG_MARK" | grep -E 'persona-start:|Session connected: persona|startupSessionManager: complete|\) not brought up:|persona-(credentials|directory)-|persona-slack-unreachable'
   ```

Expected:

- `start` exits 0.
- The last command prints one `[slack] persona-start: personas[<i>] "<name>" (key=<key>): bring-up starting` line for each of `personas[0] "persona_a" (key=persona_a)`, `personas[1] "persona_b" (key=persona_b)` and `personas[2] "persona_c" (key=persona_c)`.
- It prints at least one `[slack] Session connected: persona "<name>" (key=<key>)` line for each of the three personas.
- It prints one `[slack] startupSessionManager: complete — 3 persona(s): …` line, ending `0 failed, 0 not brought up`.
- It prints no `[slack] persona "<name>" (key=<key>) not brought up:` line and no `persona-credentials-…`, `persona-directory-…` or `persona-slack-unreachable` line.

If any of that is missing, or a failure line is present, stop the section and record the failure in Notes.

A's DMs stay on for the rest of this run. Teardown removes the `dm` line
again, so the next run starts from Setup's config.

### Check 15: each DM is answered by the persona whose app received it (AC 15, AC 37, AC 17)

Steps:

1. Record where the log ends: `MARK=$(wc -l < "$LOG")`.
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

### Check 16: a DM-only persona starts, connects and answers DMs (AC 40, AC 41)

C has zero channels, DMs on, a `dm` destination and `dm.contact` set.

Run Check 19 (in "DM prompts") first. Its prompt opened the operator's DM
with C, so step 2 below posts into that DM and its ID is the `<C_DM_ID>`
Check 19 noted.

Steps:

1. Confirm C's start in the restart's lines (from "Turn A's DMs on"):

   ```sh
   since "$LOG_MARK" | grep -F '"persona_c" (key=persona_c)'
   since "$LOG_MARK" | grep -E 'persona-(credentials|directory)-|persona-slack-unreachable' | grep -F '(key=persona_c)'
   agent-director list --label service=cscb
   ```

2. As the operator, send "Reply with the word dm-c." in a DM with app C. Work out its `<TS>` and note `<C_DM_ID>`. Wait for the answer.
3. Run:

   ```sh
   tags c <TS>
   replies c
   since "$LOG_MARK" | grep -F '(key=persona_c)' \
     | grep -oE 'chat_id=[A-Z0-9]+|channel=[A-Z0-9]+|in (channel|conversation) [A-Z0-9]+' | sort -u
   since "$LOG_MARK" | grep -F 'unclaimed-channel: personas[2] "persona_c"'
   ```

   The third command lists every conversation ID on C's lines since the restart: its `Dispatching to persona "persona_c" (key=persona_c) chat_id=…` lines, any `dropped message from channel=…` line, and any `persona-dm-dropped` or `unclaimed-channel` line (`… in conversation …` / `… in channel …`). The RAW lines are not used: they keep only the first 300 characters of the event, which usually cut off its `"channel"` field.

4. In the test workspace's channel browser, open every channel (A-home, coordination and the workspace's default channels) and look at its member list.

Expected:

- Step 1's first command prints a `[slack] persona-start: personas[2] "persona_c" (key=persona_c): bring-up starting` line and a `[slack] Session connected: persona "persona_c" (key=persona_c)` line, and no `[slack] persona "persona_c" (key=persona_c) not brought up:` line. Its second command prints nothing. The list has C's row, `cscb_persona_c`.
- C answers "dm-c" in the DM with C, under C's name and avatar.
- `tags c <TS>` prints exactly one tag, with `chat_id="<C_DM_ID>"`, `via="dm"` and `user_id="<OPERATOR_USER_ID>"`.
- Every line of `replies c` has a `chat_id` starting with `D`: C has posted only in DMs.
- The ID extraction prints at least `chat_id=<C_DM_ID>`, and every ID it prints starts with `D`: C's pipeline has handled nothing outside a DM since the restart.
- The `unclaimed-channel` grep prints nothing.
- "CSCB Test C" is in no channel's member list.

Pass: C started and connected with no failure line, answered the DM in place with `via="dm"`, and is in no channel and has posted nowhere but DMs.

### Check 17: a persona with DMs on opens a DM with a user and posts as itself (AC 38)

A's DMs are now on. The second test user still has no DM with A (Check 14
posted nothing).

Steps:

1. Record where the log ends: `MARK=$(wc -l < "$LOG")`.
2. In A-home, post: "Call your reply tool once with chat_id `<SECOND_USER_ID>` and the text `DMs-on outbound check`. Then reply here with the word done."
3. When A says done, run:

   ```sh
   replies a | grep -F 'chat_id=<SECOND_USER_ID>' | tail -n 1
   since "$MARK" | grep -F 'could not open a DM'
   ```

4. Signed in as the second test user, open the DM from "CSCB Test A".

Expected:

- The `replies a` line starts `chat_id=<SECOND_USER_ID> error=false` and contains `Sent 1 message(s) to D` followed by the DM's ID and ` (the DM with <SECOND_USER_ID>)`.
- The `grep` prints nothing. A `missing_scope` failure here means app A lacks `im:write` (see this section's setup).
- The second test user has a new DM from app A, holding "DMs-on outbound check" under A's name and avatar.

Pass: A's call opened a DM with the second test user and the message appears there under A's identity.

### Check 18: an edit that adds a mention wakes the persona once

This covers the edited-event dedupe: an edit that adds a persona's mention
reaches it as a new mention, once.

Steps:

An edited message's delivered tag may not carry the `<TS>` from the
message's link, so this check counts deliveries with `tagstext` (see this
section's setup), keyed on the text `edit check`. The `Dispatching` lines
carry no `via`; they only corroborate the count.

Steps:

1. Record where the log ends: `MARK=$(wc -l < "$LOG")`.
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

## DM prompts (appended by E7)

These checks verify AC 29, 34 and 44 and b.av2 SR-7.1 (a persona's permission
prompts go to its own destination, a channel or the DM with its contact) and
SR-3.1 (each persona posts under its own app identity). A prompt in a DM is
answered with its buttons like a channel prompt.

Like the rest of this plan, the section runs only on the test workspace and
the test host's server, never on the production install. The Safety section
applies unchanged.

**Run order:** Check 19 runs inside the DMs section, after Check 15 and before
Check 16 (see that section's run order). Checks 20 and 21 run after Check 18,
on the server that is already running. If the server was stopped since,
restart it as the E4 section says (confirm `hostname` and `whoami`, unset the
token variables, `start`; do not rerun the check1 pre-flight).

### Setup for these checks

Nothing is added to `config.json`. Confirm that B and C have DMs on, the
operator as `dm.contact` and a `dm` destination:

```sh
jq -c '.personas[] | select(.name == "persona_b" or .name == "persona_c") | {name, dm, permission_prompts}' \
  ~/.claude/channels/slack/config.json
```

It must print two lines, for `persona_b` and `persona_c`, each with
`"dm":{"enabled":true,"contact":"<OPERATOR_USER_ID>"}` and
`"permission_prompts":"dm"`. Every app carries `im:write` (see the DMs
section's setup).

The permission trail records every prompt post: which instance posted, to
which conversation, and whether it succeeded. Define this read-only helper
next to `since` (it prints no message text):

```sh
TRAIL=~/.claude/channels/slack/permission-trail.jsonl
posts() {  # usage: posts <trail mark>
  tail -n +"$(($1 + 1))" "$TRAIL" \
    | jq -c 'select(.event == "cscb.chat_post.attempted") | {claude_instance_id, channel, ok, error}'
}
```

Each check records a trail mark next to its log mark, as
`TMARK=$(wc -l < "$TRAIL")`, and reads only the posts after it.

The permission request each check raises is the one from Check 5: a shell
command that writes the current date to a named file in the persona's working
directory. Answer every prompt in Slack, promptly, and never in a persona's
terminal.

### Check 19: C's first prompt opens the DM with its contact (AC 44)

Run this after Check 15 and before Check 16, with this section's setup done
first.

Precondition: the operator has never had a DM with app C. C is in no channel,
so the only way to ask C for work without a DM is its terminal.

Steps:

1. In the operator's Slack sidebar and **Apps** list, look for a conversation with "CSCB Test C".
   - None: this is a **first run**.
   - One exists (an earlier run of this plan opened it; Slack DMs can't be deleted): this is a **rerun**. Note its ID as `<C_DM_ID>` from any message's **Copy link** URL.

   Record "first run" or "rerun" in Notes.
2. Record where the log and the trail end: `MARK=$(wc -l < "$LOG"); TMARK=$(wc -l < "$TRAIL")`.
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

A `persona-destination-failed` line naming `missing_scope` and `im:write` means app C lacks `im:write`: fix it as the DMs section's setup says, then rerun this check.

Pass: C's prompt was delivered as a DM from C's app to the operator (opening the DM on a first run, into the existing DM on a rerun), appeared in no channel, and its button resolved the request.

### Check 20: B's prompt arrives by DM and its button resolves it (AC 29)

The DM between the operator and B exists since Check 15 (`<B_DM_ID>`).

Steps:

1. Record where the log and the trail end: `MARK=$(wc -l < "$LOG"); TMARK=$(wc -l < "$TRAIL")`.
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

### Check 21: A's channel prompt and B's DM prompt route independently (AC 34)

Steps:

1. Record where the log and the trail end: `MARK=$(wc -l < "$LOG"); TMARK=$(wc -l < "$TRAIL")`.
2. In coordination, post "@CSCB Test A @CSCB Test B each of you, run a shell command that writes the current date to a file in your working directory: A names it route-a.txt, B names it route-b.txt."
3. Wait until both prompts are showing, and don't click either yet. Run:

   ```sh
   posts "$TMARK" | grep -E 'cscb_persona_(a|b)'
   ```

4. Click **Deny** on B's prompt. Look at A's prompt. Deny any further prompt B raises for this task.
5. Click **Allow** on A's prompt. Look at B's prompt.
6. When A has finished, run `ls ~/cscb-live/a/route-a.txt ~/cscb-live/b/route-b.txt`.

Expected:

- A's prompt appears in A-home, under A's name and avatar. It does not appear in coordination or in any DM.
- B's prompt appears in the operator's DM with B (`<B_DM_ID>`), under B's name and avatar. It does not appear in A-home, coordination or any other channel.
- Nothing is cross-posted: A-home holds no prompt of B's, and the DM with B holds no prompt of A's.
- In `posts`, the first line for `cscb_persona_a` has `"channel":"<A_HOME_CHANNEL_ID>"` and the first line for `cscb_persona_b` has `"channel":"<B_DM_ID>"`, both `"ok":true`. More lines from one persona (it raised more requests) go in Notes; they are not a failure.
- Step 4: B's prompt updates to `*Permission* — Denied by operator`; A's prompt is unchanged, with its buttons.
- Step 5: A's prompt updates to `*Permission* — Allowed`; B's stays `Denied by operator`.
- `ls` lists `route-a.txt` and reports that `route-b.txt` does not exist.

Pass: both prompts were pending at once, each at its own persona's destination under its own identity, and each button resolved only its own request.

## Lost message (appended by E8)

This check verifies AC 26 and b.av2 SR-4.6 (a message that finds no live,
stream-bearing session is not delivered, and recovery follows the
human-trigger rules) and SR-7.3 (the persona's permission-prompt destination
is told that a message was lost, who sent it and the recovery state, with no
message text, and nothing else is posted in the source conversation). It also
checks, in passing, SR-7.2 (the notice is posted under the persona's own
identity) and SR-4.5 (a lost message gets no acknowledgement reaction).

Like the rest of this plan, the section runs only on the test workspace and
the test host's server, never on the production install. The Safety section
applies unchanged.

**Run order:** run it after Check 21, on the server that is already running.
If the server was stopped since, restart it as the E4 section says (confirm
`hostname` and `whoami`, unset the token variables, `start`; do not rerun the
check1 pre-flight). The section's own teardown brings A back, so later
sections start from a healthy state.

### Setup for these checks

The check needs auto-restart off, so the killed instance stays down, and an
acknowledgement reaction configured, so its absence means something.

First confirm an acknowledgement reaction is configured, so the single
restart below picks it up. Until a later Epic moves it, the reaction is
`ackReaction` in `~/.claude/channels/slack/access.json`:

```sh
jq -r '.ackReaction // empty' ~/.claude/channels/slack/access.json   # must print an emoji name
```

If it prints nothing, set one now, and note it for the teardown:

```sh
A=~/.claude/channels/slack/access.json
jq '.ackReaction = "eyes"' "$A" > "$A.tmp" && mv "$A.tmp" "$A"
ACK_ADDED=1
```

The restart below makes the server read the reaction even when
`SLACK_ACCESS_MODE=static`, where `access.json` is read only at `start`.
Without a configured reaction the "no reaction" result proves nothing, so
the check can't pass.

`session_restart_delay` is a server-wide `config.json` key that the server
reads once, at `start`. Setting it needs the guarded stop and start of "Turn
A's DMs on", with this edit in place of the `dm` line:

1. Define `guard()` as in "Turn A's DMs on" step 1, if this shell doesn't have it.
2. Stop the test server only if the guard passes, as in "Turn A's DMs on" step 2 (it records `LOG_MARK`). If it prints `NOT THE TEST HOST - stop` or `config.json.last-applied exists - stop`, do nothing more in this section and record that in Notes.
3. Record the current value, then set it to `0`:

   ```sh
   CFG=~/.claude/channels/slack/config.json
   ORIG_DELAY=$(jq -c '.session_restart_delay' "$CFG"); echo "ORIG_DELAY=$ORIG_DELAY"
   jq '.session_restart_delay = 0' "$CFG" > "$CFG.tmp" && mv "$CFG.tmp" "$CFG"
   jq -e '.session_restart_delay == 0' "$CFG"   # must print true
   ```

   `ORIG_DELAY=null` means the key was absent (the default, 60 s). Keep `ORIG_DELAY` for the teardown.
4. Start the test server as in "Turn A's DMs on" step 4, and wait for it as in step 5. The same Expected items apply: each persona's `Session connected` line, `0 failed, 0 not brought up`, and no failure line.

A's destination is A-home (`"permission_prompts": "<A_HOME_CHANNEL_ID>"`). A
is mentions-only in coordination, so the message must mention A.

### Check 22: a message to a downed persona is reported at its destination, not in the channel (AC 26)

Steps:

1. Run `agent-director list --label service=cscb` and confirm A's row, `cscb_persona_a`, is there.
2. Record where the log ends: `MARK=$(wc -l < "$LOG")`.
3. Kill A's instance, as Check 7 does: `tmux kill-session -t slack_bot_persona_a`. Wait until the disconnect shows (up to one minute):

   ```sh
   since "$MARK" | grep -E 'Session disconnected.*"persona_a" \(key=persona_a\)|Auto-restart disabled \(delay=0\) — skipping restart for persona=persona_a'
   ```

4. Record where the log ends again: `MARK2=$(wc -l < "$LOG")`.
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
- The message in coordination has no reaction from A: the configured `ackReaction` emoji is not on it.

A notice in coordination, a second lost-message notice, or the marker in the
notice fails this check. So does an `ackReaction` on the message.

Teardown for this check (operator step on the test host), run whatever the result:

1. Stop the test server only if the guard passes, as in "Turn A's DMs on" step 2 (it records a new `LOG_MARK`).
2. Restore the delay:

   ```sh
   CFG=~/.claude/channels/slack/config.json
   if [ "$ORIG_DELAY" = null ]; then jq 'del(.session_restart_delay)' "$CFG"; else jq --argjson d "$ORIG_DELAY" '.session_restart_delay = $d' "$CFG"; fi > "$CFG.tmp" && mv "$CFG.tmp" "$CFG"
   jq -c '.session_restart_delay' "$CFG"   # must print the ORIG_DELAY value
   ```

3. If the setup added the reaction (`ACK_ADDED=1`), remove it: `A=~/.claude/channels/slack/access.json; jq 'del(.ackReaction)' "$A" > "$A.tmp" && mv "$A.tmp" "$A"`.
4. Start the test server as in "Turn A's DMs on" step 4, and wait for it as in step 5, with the same Expected items. A's instance is brought up again, resumed or fresh-spawned.
5. In A-home, post "Reply with the word back." A replies "back" in A-home under its own name and avatar.

If A doesn't answer after the restart, record that in Notes: later sections
need all three personas up.

Pass: A's instance was down with auto-restart off, the message was dropped
with the `No live session` (or `DROP: no _GET_stream`) line, exactly one
lost-message notice naming the operator and "auto-restart disabled" appeared
in A-home under A's identity without the marker, nothing was posted in
coordination, the message got no `ackReaction`, and A answered again after
the teardown.

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

If the DMs section ran, return `config.json` to Setup's config so the next
run starts from it: once the server is stopped, delete the
`"dm": { "enabled": true },` line that "Turn A's DMs on" added to the
`persona_a` entry (mind the commas), then check that A has no `dm` field:
`jq -e '.personas[0] | has("dm") | not' ~/.claude/channels/slack/config.json`
must print `true`.

If the lost-message section stopped before its own teardown, restore
`session_restart_delay` (and remove an `ackReaction` it added) as that
teardown's steps 2 and 3 say, once the server is stopped.

A rerun of the DMs section needs a second test user that A has never
messaged: the one used here now has a DM with A (Check 17 opened it).

Remove the credentials files when the run is over if the test apps are
retired: `rm ~/.config/cscb-test/*-credentials.json`.

---

## Results

The operator adds one row per run. Record pass or fail only, never a token or
a log excerpt containing one.

| Date | Build commit | Host / user | Check 1 | Check 2 | Check 3 | Check 4 | Check 5 | Check 6 | Check 7 | Check 8 | Check 9 | Check 10 | Check 11 | Check 12 | Check 13 | Check 14 | Check 15 | Check 16 | Check 17 | Check 18 | Check 19 | Check 20 | Check 21 | Check 22 | Notes |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| | | | | | | | | | | | | | | | | | | | | | | | | | |
