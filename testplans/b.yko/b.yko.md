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

| Date | Build commit | Host / user | Check 1 | Check 2 | Check 3 | Check 4 | Check 5 | Check 6 | Check 7 | Check 8 | Check 9 | Check 10 | Check 11 | Check 12 | Notes |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| | | | | | | | | | | | | | | | |
