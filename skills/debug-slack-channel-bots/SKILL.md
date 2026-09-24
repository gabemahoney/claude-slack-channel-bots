---
name: debug-slack-channel-bots
description: Diagnose a claude-slack-channel-bots persona that is silent, down or refused — find its server-log lines, match the class, and follow the fix for every persona failure and every config.json rejection.
version: 1.0.0
license: MIT
user-invocable: true
argument-hint: "[persona name or key]"
allowed-tools: [Bash, Read, Grep]
---

# /debug-slack-channel-bots

Diagnose a persona of `claude-slack-channel-bots` (CSCB) that doesn't answer,
doesn't come up, or gets refused. Every persona failure is logged to the
server log with a class label. This skill says where that log is, how to find
one persona's lines, what each line means, and what the operator does about it.
It also covers every reason `config.json` is rejected at start.

One broken persona never stops the server. Every healthy persona keeps serving,
and nothing about a broken persona is posted to Slack under any identity. The
server log is the place to look.

## Constraints

Whoever runs this skill (the operator, or a Claude session acting for one):

- NEVER display, copy, paste or summarise a token value or the contents of a
  credentials file. A shape check may report key names and whether each value
  has the expected prefix (see [Checking a credentials file's shape](#checking-a-credentials-files-shape)), never the value.
- NEVER start a second server, and never start, stop or restart the server
  without the operator's say-so.
- NEVER edit `config.json` or a credentials file without the operator's
  say-so. Tell the operator what to change instead.
- `config.json` names only paths and holds no tokens. If a value in it starts
  with `xoxb-` or `xapp-`, don't display it; tell the operator a token has been
  pasted into the configuration and must be moved to a credentials file.

---

## Triage

1. **Persona is silent, `/interject` returns 503 for it, or its scheduled
   prompts log `no-session`.** Find its key: the `persona-start` line for its
   name (see [Reading a persona line](#reading-a-persona-line)). If the
   persona is up but its instance can't take messages, each message sent to
   it is lost: its destination (its `permission_prompts` channel, or its DM
   with `dm.contact`) has a *Message lost* notice whose `Recovery:` wording
   says whether a server restart is needed, and `server.log` has a
   `No live session` or `DROP: no _GET_stream` line (see
   [Other lines you may see](#other-lines-you-may-see)).
2. **Pull every line for that key** from `server.log` (see
   [The server log](#the-server-log)).
3. **Match the class** of the first failure line after its latest
   `persona-start` line, and follow its entry under
   [Persona diagnostic classes](#persona-diagnostic-classes).
4. **The server didn't start at all?** `start` printed a
   `Server failed to start` block. If it contains a
   `Fatal: configuration error` line, match the message under
   [Configuration rejections](#configuration-rejections). Otherwise another
   start-time check failed, most often the agent-director startup gate
   (agent-director missing, too old or unreachable). Those failures are also
   recorded in `startup-errors.log`: read its latest lines and fix what they
   name (the `install-cscb` skill covers installing agent-director).
5. **No class line, but the persona still isn't served?** See
   [A persona is down but its instance is still running](#a-persona-is-down-but-its-instance-is-still-running)
   and [Other lines you may see](#other-lines-you-may-see).
6. **A `reply` to a user ID fails with `missing_scope`?** See
   [A persona can't open a DM](#a-persona-cant-open-a-dm-re-install-its-app-to-gain-imwrite).
   **Permission prompts or notices don't arrive?** Look for a
   [`persona-destination-failed`](#persona-destination-failed) line for the
   persona.
7. **A persona isn't reminded to reply in Slack, or is reminded after being
   opted out?** See
   [A persona isn't reminded to reply](#a-persona-isnt-reminded-to-reply-or-is-reminded-after-opting-out).

---

## The server log

The server writes everything, persona diagnostics included, to `server.log` in
its state directory: `$SLACK_STATE_DIR` when the server was started with it
set, otherwise `~/.claude/channels/slack/`. Use the state directory the server
was started with, which may differ from your shell's.

```sh
STATE="${SLACK_STATE_DIR:-$HOME/.claude/channels/slack}"
ls -l "$STATE"/server.log*
```

- **Rotation.** When `server.log` reaches `CSCB_LOG_MAX_BYTES` (default
  10 MiB) it is renamed `server.log.1`, the old `.1` becomes `.2`, and so on.
  `CSCB_LOG_KEEP` generations are kept (default 5); the oldest is deleted.
  Generations are not compressed, so plain `grep` reads them. A persona's
  `persona-start` line from the last start may be in an older generation.
- **Line shape.** Every line starts with an ISO-8601 timestamp in brackets.
  Persona lines then carry the `[slack]` prefix.
- **`startup-errors.log`** in the same directory is a separate file, never
  rotated by CSCB, for the agent-director startup gate and a few start-time
  warnings. No persona diagnostic goes there, and no configuration rejection
  either.

All lines for one persona (replace `ops_bot` with the key):

```sh
grep -h -E '\(key=ops_bot\)|persona=ops_bot\b' "$STATE"/server.log.* "$STATE"/server.log 2>/dev/null | sort
```

All lines of one class, for every persona:

```sh
grep -h -F 'persona-directory-missing:' "$STATE"/server.log.* "$STATE"/server.log 2>/dev/null | sort
```

Recent starts, with each persona's name and key:

```sh
grep -h -F 'persona-start:' "$STATE"/server.log 2>/dev/null | tail -n 40
```

---

## Reading a persona line

A persona diagnostic line looks like this:

```text
[2026-01-01T00:00:00.000Z] [slack] persona-directory-missing: personas[1] "Ops Bot" (key=ops_bot_5e2526f3) path="/srv/bots/ops": working directory does not exist
```

| Part | Meaning |
|---|---|
| `persona-directory-missing` | The class label. Every diagnostic line has exactly one. |
| `personas[1]` | The persona's position in `config.json`'s `personas` array, counting from 0. |
| `"Ops Bot"` | The persona's name, JSON-quoted as configured. |
| `(key=ops_bot_5e2526f3)` | The persona's key, derived from its name. |
| `path="…"` | The file or directory the line is about: the credentials file for credentials and Slack classes, the working directory for directory classes. Absent on `persona-start`, `unclaimed-channel`, `persona-dm-dropped` and `persona-destination-failed`. |
| After `path="…": ` (or `(key=<key>): ` when there is no path) | The cause. It may itself contain `: `. A bad token is named only by its key (`bot_token`, `app_token`) and the rule it breaks, never by value. |

**The key.** A name of 1–40 characters using only `a-z`, `0-9` and `_` is its
own key. Any other name maps to a lower-cased, `_`-joined stem plus `_` and 8
hex digits. Don't derive it by hand: read it from the persona's
`persona-start` line. The key names everything else about the persona:

| Where | Form |
|---|---|
| agent-director instance ID | `cscb_<key>` |
| tmux session | `slack_bot_<key>` |
| agent-director label | `persona=<key>` (with `service=cscb`) |
| Restart, relaunch and health-check lines | `persona=<key>` |

**Persona states.** Every bring-up ends in one of three outcomes:

| Outcome | Causes | Recovers on its own? |
|---|---|---|
| `up` | None | — |
| `broken` | Credentials missing, unreadable, invalid or refused by Slack | No: fix the credentials file and restart the server |
| `retrying` | Slack unreachable, or working directory missing or unusable | Yes, once the cause clears; no restart |

A persona that is not up posts nothing to Slack, and its instance, if one is
running, is kept but not served. Healthy personas are unaffected.

---

## Persona diagnostic classes

### `persona-start`

- **Line:** `[slack] persona-start: personas[<i>] "<name>" (key=<key>): bring-up starting`
- **Meaning:** One line per configured persona each time the server starts,
  before any other line about that persona's bring-up. It's the name-to-key
  map for that start.
- **Fix:** None. If a persona has no `persona-start` line in the latest start,
  it isn't in the `config.json` the server loaded, or the server didn't load
  the configuration at all (see [Configuration rejections](#configuration-rejections)).

### `persona-credentials-missing`

- **State:** `broken`. Doesn't recover on its own.
- **Cause text:** `credentials file does not exist`. The path in `path="…"`
  doesn't exist, or a directory on the way to it doesn't.
- **Fix:** Create the credentials file at that path, or correct the persona's
  `credentials_file` in `config.json`. Then restart the server.

### `persona-credentials-unreadable`

- **State:** `broken`. Doesn't recover on its own.
- **Cause text:** one of `credentials file is a directory`,
  `credentials file is not a regular file` (a FIFO, socket or device),
  `credentials file cannot be read: permission denied (<errno>)` (`EACCES` or `EPERM`), or
  `credentials file cannot be read (<errno>)`.
- **Fix:** Make the path a regular file readable by the user the server runs
  as (the file should be mode 0600, owned by that user). Then restart the
  server.

### `persona-credentials-invalid`

- **State:** `broken`. Doesn't recover on its own.
- **Meaning:** The file was read but isn't a valid credentials file, or its
  real path is another persona's credentials file.
- **The required shape:** a JSON object with exactly two string keys,
  `bot_token` starting `xoxb-` and `app_token` starting `xapp-`, each with
  something after the prefix and no whitespace or control character anywhere
  (a trailing newline inside the string counts):

  ```json
  { "bot_token": "xoxb-…", "app_token": "xapp-…" }
  ```

- **Cause text:** `credentials file is invalid: ` then one or more of, joined
  by `; `: `not valid JSON`, `not a JSON object`, `<key> is missing`,
  `<key> must be a string`, `<key> contains whitespace or control characters`,
  `<key> must start with xoxb-` / `xapp-`, `<key> has nothing after xoxb-` /
  `xapp-`, `<n> unexpected key(s) (only bot_token and app_token are allowed)`.
  Or, for a shared file: `real path is also the credentials_file of "<name>"
  (key=<key>)`, with `(both resolve to "<path>")` when a symlink is involved.
  The loader already rejects two personas naming the same file, so the shared
  case appears only when a symlink changed after the configuration loaded.
- **Fix:** The operator rewrites the file in the shape above (mode 0600), or
  gives the persona its own file. Then restart the server. Use
  [Checking a credentials file's shape](#checking-a-credentials-files-shape) to
  confirm the fix without showing a token.

### `persona-credentials-refused`

- **State:** `broken`. Doesn't recover on its own. Logged by the connection
  manager, with the credentials file as `path`.
- **Meaning:** Slack answered and refused a token. Two checks can refuse:
  - `bot_token refused by auth.test: Slack error <code>`
  - `app_token refused by the Socket Mode open: Slack error <code>`
- **Codes:** any Slack error except the five transient ones listed under
  `persona-slack-unreachable`. The expected ones are `not_authed`,
  `invalid_auth`, `account_inactive`, `token_revoked`, `token_expired` and
  `not_allowed_token_type`.
- **Fix:** Get a working token from the persona's Slack app and have the
  operator write it into the credentials file: for `bot_token`, the app's Bot
  User OAuth Token (re-install the app to the workspace if it was uninstalled
  or its token revoked); for `app_token`, an app-level token with the
  `connections:write` scope, with Socket Mode turned on. Then restart the
  server.
- A refusal on a persona that was already running is covered under
  [A token was revoked while the persona was running](#a-token-was-revoked-while-the-persona-was-running).

### `persona-slack-unreachable`

- **State:** `retrying`. Recovers on its own; no operator action.
- **Meaning:** Slack couldn't be reached while checking a token, so the
  persona isn't treated as broken. Retried on its own timer: 5 s, doubling to
  a 300 s ceiling, with no limit on attempts. A rate-limit wait is never
  shorter than Slack asks for.
- **Cause text:** `Slack unreachable checking <bot_token|app_token> via
  <auth.test|the Socket Mode open>: ` then one of `network or request error`,
  `HTTP status <n>`, `HTTP error`, `rate limited` (with `, retry after <n> s`),
  `no answer within 10 s`, `WebSocket phase timed out after 10 s`,
  `socket closed before hello`, `no WebSocket URL returned`,
  `no bot user ID or bot ID returned`, `unrecognised failure`, or
  `Slack error <code>` for a transient code (`internal_error`, `fatal_error`,
  `service_unavailable`, `request_timeout`, `ratelimited`).
- **Logged:** once when it starts, and once when it clears with the cause
  `cleared: Slack answered after being unreachable checking <key> via <check>`.
  Nothing per attempt.
- **Recovery:** once Slack answers, the persona is launched from its retry
  (see `up after its bring-up retry` under
  [Other lines you may see](#other-lines-you-may-see)). If Slack answers
  with a refusal instead, the persona becomes `persona-credentials-refused`.
- **Fix:** None needed. If it never clears, check the host's network, DNS and
  proxy settings, and Slack's status page.

### `persona-connection-lost`

- **State:** stays `up`. Recovers on its own.
- **Line cause:** `the Socket Mode connection closed; reopening`.
- **Meaning:** The persona's Socket Mode connection dropped without the server
  closing it. The server reopens it at once, then backs off 5 s doubling to
  300 s. Its Web API client keeps working in the meantime, and the persona's
  instance isn't touched.
- **Normal:** Slack refreshes Socket Mode connections routinely, every few
  hours. An occasional `persona-connection-lost` line followed within seconds
  by `persona-connection-restored` is expected and needs no action.
- **Flapping:** lost and restored pairs again and again, minutes apart or
  closer, are not Slack's routine refresh. The connection between the host and
  Slack is unstable (a proxy, firewall or NAT closing idle or long-lived
  connections, or a flaky network). The persona stays `up` and each reopen
  succeeds, but it hears nothing from Slack during each gap, so messages may
  arrive late or be missed. Check the host's network and proxy path to Slack.
- **Worth a look:** a lost line with no restored line for a long time (a
  network outage: the reopen keeps retrying, logging nothing more), or a lost
  line followed by `persona-credentials-refused` (see
  [A token was revoked while the persona was running](#a-token-was-revoked-while-the-persona-was-running)).

### `persona-connection-restored`

- **State:** `up`.
- **Line cause:** `the Socket Mode connection is open again`.
- **Meaning:** A lost connection reopened. Closes a `persona-connection-lost`
  line. No action.

### `persona-directory-missing`

- **State:** `retrying`. Recovers on its own once the directory exists; no
  restart and no confirmation.
- **Cause text:** `working directory does not exist`.
- **Meaning:** At bring-up the persona's `working_directory` didn't exist. No
  Slack connection is opened for it. The directory is re-checked on the same
  schedule as Slack retries (5 s doubling to 300 s, no limit), outside the
  restart counter and cap, so waiting doesn't use up restarts.
- **Logged:** once when it starts. Failed re-checks log nothing, even if the
  class changes to `persona-directory-unusable`. Once the directory is usable,
  one line with the same class and the cause
  `cleared: working directory is usable again; continuing the bring-up`, then
  Slack validation and the launch.
- **Fix:** Create the directory (readable and searchable by the server's user),
  or correct `working_directory` in `config.json` and restart the server.
- If the persona also has a credentials cause, the cleared line ends
  `the persona stays broken until its credentials are fixed and the server is restarted`
  instead. See [Both causes at once](#both-causes-at-once).

### `persona-directory-unusable`

- **State:** `retrying`. Same retry and logging as `persona-directory-missing`.
- **Cause text:** `working directory is not a directory`,
  `working directory is not readable (<errno>)`,
  `working directory is not searchable (<errno>)`,
  `working directory cannot be inspected (<errno>)`, or
  `real path is also the working_directory of "<name>" (key=<key>)` (a symlink
  changed after the configuration loaded; the loader rejects two personas
  sharing a directory).
- **Fix:** Make the path a directory the server's user can read and search
  (`chmod u+rx`), or point the persona at its own directory. The persona comes
  up on the next re-check, within 300 s.

### `unclaimed-channel`

- **State:** the persona is `up`; this is about a message, not the persona.
- **Line:** `[slack] unclaimed-channel: personas[<i>] "<name>" (key=<key>): message in channel <id> not delivered: no applied persona lists this channel`
- **Meaning:** The persona's Slack app is a member of a channel that no
  persona lists in `channels`, so the message reached no one. Logged by each
  persona whose app received it.
- **Fix:** Add the channel to the right persona's `channels` in `config.json`
  and restart the server, or remove the app from the channel. If the ID is a
  group DM (someone @mentioned the persona in a multi-person DM), the line is
  expected: do not add that ID to any persona's `channels`, because that would
  deliver group-DM mentions to it.

### `persona-dm-dropped`

- **State:** the persona is `up`; this is about a message.
- **Line:** `[slack] persona-dm-dropped: personas[<i>] "<name>" (key=<key>): direct message in conversation <id> ts=<ts> dropped: dm.enabled is off for this persona`
- **Meaning:** Someone sent a direct message to the persona's Slack app while
  that persona's `dm.enabled` is off, so the message was not delivered. The
  line names the persona, the DM conversation, the message ts and
  `dm.enabled`, never the message text.
- **Fix:** Set `dm.enabled` to `true` for that persona in `config.json` and
  restart the server. Leaving it off is valid when the persona should ignore
  DMs; the line is then expected.
- **Group DMs:** a group DM (a direct message with more than one person) is
  not delivered and never logs `persona-dm-dropped`, whatever `dm.enabled`
  says. This is by design, not a fault; turning `dm.enabled` on does not
  change it. A group-DM message that Slack marks with `channel_type` `mpim`
  logs the plain `[slack] persona "<name>" (key=<key>) dropped message from
  channel=<id> …: group-dm` line. An @mention of the persona in a group DM
  arrives without `channel_type`, so it logs `unclaimed-channel` instead (see
  [`unclaimed-channel`](#unclaimed-channel)).

### `persona-destination-failed`

- **State:** the persona stays `up`; this is about its permission prompts,
  stuck-prompt warnings and server notices.
- **Lines:** one when the failure starts, one when it clears:
  - `[slack] persona-destination-failed: personas[<i>] "<name>" (key=<key>): <step> failed for destination=<dest> with error <code>; holding its permission prompts and notices and retrying with backoff`
  - `[slack] persona-destination-failed: personas[<i>] "<name>" (key=<key>): cleared: destination=<dest> accepts posts again (was <step> error <code>); delivering what was held`

  `<dest>` is the persona's `permission_prompts` value: a channel ID, or
  `dm`. `<step>` is `conversations.open` (opening the DM with `dm.contact`,
  for `dm` only) or `chat.postMessage` (the post). For `missing_scope` on
  `conversations.open` the start line has
  ` — the Slack app lacks the im:write scope: re-install the app with im:write to grant it`
  after the code.
- **Meaning:** A post to the persona's destination failed, so the server holds
  that persona's prompts and notices and retries them, instead of dropping
  them or failing again every second:
  - nothing more is tried for the persona until its next retry, 5 s after the
    failure, then doubling to one every 300 s, with no limit on attempts. A
    rate-limit wait is never shorter than Slack asks for;
  - server notices wait in order, at most 20 per persona (past that the
    oldest is dropped with a line; see
    [Other lines you may see](#other-lines-you-may-see));
  - a permission request stays open in agent-director. Its prompt is posted
    at the first retry that succeeds, if the request is still open then;
  - the line is logged once per episode. Failed retries log nothing;
  - a spawn-failure notice that fails at startup writes a `spawn-failure-post`
    record to `startup-errors.log` at its first failed attempt. The notice is
    still held, so the record can be followed by the `cleared:` line and the
    notice's delivery.

  Buttons on prompts already posted keep working, and their verdict updates
  are not held. Other personas are unaffected.
- **Cause and fix, by the error the line names:**
  - `missing_scope` (the line names `im:write`): the persona's Slack app was
    installed before it had the `im:write` scope, so it can't open the DM with
    its contact. Follow
    [A persona can't open a DM](#a-persona-cant-open-a-dm-re-install-its-app-to-gain-imwrite).
    It covers the scope, the re-install and the check for a changed bot
    token. The server keeps retrying, so once the app has `im:write`, a later
    retry delivers what was held.
  - `not_in_channel`: the persona's app isn't a member of its
    `permission_prompts` channel. Invite the app to that channel (in Slack,
    `/invite @<app name>` in the channel).
  - Any other error: another Slack error such as `channel_not_found` or
    `is_archived`, or a network error or timeout (`network_error`,
    `unknown_error`, …). It's held and retried the same way. Check that the
    channel the line names exists, isn't archived and has the persona's app
    in it (for `dm`, that `dm.contact` is a user in the workspace), that the
    persona's app is still installed, and that the server's host can reach
    Slack. The Slack client retries a network failure itself first, for up to
    about 30 minutes, so a network outage can reach this line late.
- **Recovery:** No server restart is needed. At the next retry (at most
  5 minutes after the fix) the held notices and any still-open prompt appear
  at the destination under the persona's name and avatar, and `server.log`
  has the `cleared:` line. With nothing held and no prompt pending, no retry
  runs: the `cleared:` line comes with the persona's next prompt or notice.
  A later failure starts a new episode with a new line. A server restart
  drops held notices and logs `persona-destination-hold: shutting down — <n>
  held notice(s) … dropped, not posted` (see
  [Other lines you may see](#other-lines-you-may-see)). A request still open
  after the restart has its prompt posted once the destination accepts posts.
- **Answering a held request:** it can still be answered in the persona's
  terminal. Once agent-director's relay window for the request elapses,
  Claude asks at the persona's tmux pane (`tmux attach -t slack_bot_<key>`).
  A request answered there is closed, and no prompt is posted for it.
- **Not this class:** a post Slack refuses for the message itself
  (`invalid_blocks`, `msg_too_long`, `no_text`, …) holds nothing. It logs
  `[slack] permission-poller: chat.postMessage failed for <instance> …` on
  every attempt for a prompt, or
  `[slack] persona-notifier: failed to post notice for <ref> to <id> …` once
  for a notice, which is dropped. Report it as a bug, with the line.

---

## Combined and related cases

### Both causes at once

A persona with a credentials cause and a directory cause is `broken`. Both
lines are logged at bring-up. The directory is still re-checked, and its
cleared line says the persona stays broken until its credentials are fixed and
the server is restarted. Fix both: the directory, and the credentials file,
then restart the server.

### A running persona's directory disappears later

This is not a bring-up retry. A persona that was up and whose working directory
is later removed follows the restart path: its launches fail, restarts back off
from `session_restart_delay` and stop after 5 consecutive failures (a
`SpawnCapReached` notice), and a *Working directory unreachable* notice is
posted to the persona's `permission_prompts` channel. Restore the directory; if
restarts were capped, restart the server.

### Checking a credentials file's shape

Reports key names and prefixes only, never a value. Needs `jq`.

```sh
CREDS=/path/to/credentials.json   # the path="…" from the persona's line
ls -lL "$CREDS"
jq -r '
def check($k; $p):
  if has($k) | not then "\($k): missing"
  elif (.[$k] | type) != "string" then "\($k): not a string"
  elif (.[$k] | test("[[:space:][:cntrl:]]")) then "\($k): contains whitespace or control characters"
  elif (.[$k] | startswith($p) | not) then "\($k): does not start with \($p)"
  elif (.[$k] | length) == ($p | length) then "\($k): nothing after \($p)"
  else "\($k): shape ok" end;
if type != "object" then "not a JSON object"
else check("bot_token"; "xoxb-"), check("app_token"; "xapp-"),
  "unexpected keys: \([keys[] | select(. != "bot_token" and . != "app_token")] | length)"
end' "$CREDS" 2>/dev/null || echo "not valid JSON, or unreadable"
```

Never `cat`, `head` or `jq .` a credentials file. A good shape doesn't prove
Slack accepts the token: `persona-credentials-refused` is Slack's answer.

---

## A persona is down but its instance is still running

A persona that isn't up (`broken` or `retrying`) keeps its agent-director row
and its running Claude instance, so its conversation history survives. While
it's down the server doesn't serve that instance:

| What | Line or result |
|---|---|
| The instance's MCP registration is refused | `[slack] Session refused: persona "<name>" (key=<key>) is not up (<outcome>: <cause>) — not registered; its instance is kept and may register once the persona is up` |
| A registered session is dropped when the persona stops being up | `[slack] persona "<name>" (key=<key>): MCP session dropped — the persona is not up (<outcome>: <cause>); its instance and agent-director row are kept` |
| The permission poller skips its rows | `[slack] permission-poller: persona "<name>" (key=<key>) is not up — skipping its rows and holding its tracked prompts until it is up`, later `… is up again — polling its rows again` |
| `/interject` | HTTP 503 `{"error":"Persona is not up", …}`, logged as `[slack] /interject: refused for persona "<name>" (key=<key>) — the persona is not up; nothing delivered` |
| Scheduled prompts | `no-session` in the cron log; the prompt is dropped, never queued |
| Health check and restart don't relaunch it | `[slack] persona=<key>: not relaunched — its Slack connection is <state>; eligible again once it is up` (`<state>` is `not brought up`, `connecting`, `retrying its bring-up`, `broken` or `stopped`), or `… not relaunched — its bring-up has not succeeded; eligible again once it is up` |
| A restart is asked for | `[slack] Not scheduling restart for persona=<key> — the persona is not up (…)`, or, when the persona stopped being up while a restart was pending, `[slack] Skipping restart for persona=<key> — the persona is no longer up; its instance is left as it is`. Neither counts toward the restart cap. |
| Server notices for it are held | Posted once it's up. At most 20 are held; past that the oldest is dropped with `[slack] persona-notifier: more than 20 notices held for "<name>" (key=<key>) — oldest held notice dropped, not posted: <first line>` |

**Directory-broken rows at start.** When the working directory has no real
path, the start sweep keeps the persona's row instead of judging its `cwd`:
`[slack] reconcileOrphans: persona "<name>" (key=<key>) working_directory="<path>" cannot be resolved to a real path — keeping its rows; the cwd check is deferred to its launch`.
If a launch reaches that row while the directory is still missing, the launch
fails and the row is kept: `[slack] spawnForPersona: "<name>" (key=<key>) working_directory=<path> cannot be resolved to a real path — keeping its row (cwd=<cwd>, state=<state>); the launch fails and is retried by the restart path`.

**Once the persona is up**, its launch reaches the kept row through the
collision ladder (reconnect or resume), so the instance keeps its history.
Look for `Session connected: persona "<name>" (key=<key>)`.

**At every server start** instances that survived the previous server are
refused (`Session refused: …`) until their persona's bring-up finishes, even
for healthy personas. They then register again through the launch's reconnect
or, failing that, the health check: two consecutive ticks of
`health_check_interval` (120 s by default), then the restart delay
(`session_restart_delay`, 60 s by default), about 3–5 minutes with default
settings. A few refused lines right after a start are
normal. If a refused instance keeps reconnecting in a loop while its persona is
down, report it as a bug, with the persona's lines.

---

## A token was revoked while the persona was running

Which token was revoked decides what the log shows. A running persona's
Socket Mode reopen uses only the app token; `auth.test` (the bot token check)
runs only at bring-up, when the server starts.

### The app token

The Socket Mode connection drops (`persona-connection-lost`), and the reopen is
refused (`persona-credentials-refused` with `app_token refused by the Socket
Mode open`, typically `token_revoked`, `invalid_auth` or `account_inactive`).
There is no `persona-connection-restored` line. Then:

- the persona stays disconnected and becomes `broken`; no further attempts;
- its instance keeps running, and its MCP session is dropped (`MCP session
  dropped — the persona is not up (broken: …)`) until the persona is up again;
- nothing is posted to Slack about it.

**Fix:** a working token in the persona's credentials file (see
`persona-credentials-refused`), then restart the server. The instance
re-registers once the persona is up.

### The bot token

A bot token revoked while the persona runs may never be detected. Even if the
connection drops, the reopen doesn't check the bot token, so no
`persona-credentials-refused` line is logged. The persona stays `up` and keeps
its MCP session, but everything it sends to Slack fails:

- its tool calls (`reply`, `react`, `edit_message`, `fetch_messages`,
  `download_attachment`) return a tool error to the instance:
  `Tool "<tool>" failed for persona "<name>" (key=<key>): the tool call failed (<Slack error code>).`
- `server.log` has the matching line:
  `[slack] Tool "<tool>" failed for persona "<name>" (key=<key>): …`;
- its permission prompts and notices are held, with one
  [`persona-destination-failed`](#persona-destination-failed) line naming the
  Slack error (for example `token_revoked` or `invalid_auth`).

The next server start runs `auth.test`, which refuses the token: the persona
then logs `persona-credentials-refused` with `bot_token refused by auth.test`
and is `broken`.

**Fix:** put a working bot token in the persona's credentials file (see
`persona-credentials-refused`), then restart the server.

---

## A persona can't open a DM: re-install its app to gain `im:write`

- **Symptom:** a persona with `dm.enabled` on receives DMs and answers in
  them, but a `reply` to a Slack user ID fails with this tool error:
  `Tool "reply" failed for persona <ref>: could not open a DM with "<user>" (missing_scope). The persona's Slack app lacks the im:write scope; add it and re-install the app.`
  `server.log` has a matching `[slack] Tool "reply" failed for persona <ref>: could not open a DM with "<user>" …`
  line. Nothing is posted.
- **Same cause, prompts and notices:** a persona whose `permission_prompts`
  is `"dm"` opens its DM with `dm.contact` the same way, so its permission
  prompts, stuck-prompt warnings and server notices can't be posted either.
  They are held, not lost: `server.log` has one
  [`persona-destination-failed`](#persona-destination-failed) line naming
  `conversations.open`, `missing_scope` and `im:write`, and the server
  retries with backoff (up to 5 minutes apart), logging nothing per attempt.
- **Cause:** starting a DM with a user (a `reply` to a user ID, or a persona
  whose `permission_prompts` is `"dm"`) needs the `im:write` bot scope. The
  persona's Slack app was created, or last installed, from a manifest without
  it. A `"dm"` destination always opens its DM through `conversations.open`
  before it first posts there, even when the DM already exists, so an
  existing DM does not help. Receiving DMs and a `reply` into an existing DM
  (a `D…` ID) use other scopes, so they keep working.
- **Per app:** each persona is its own Slack app, so the fix is for that
  persona's app only. Other personas are unaffected; apply the fix to each app
  that shows the error.
- **Fix,** in that app's settings at api.slack.com/apps:
  1. Add the `im:write` bot scope, either as `- im:write` under
     `oauth_config.scopes.bot` in the app's own manifest, or under OAuth &
     Permissions → Bot Token Scopes. Do not paste the shipped
     `slack-app-manifest.yml` over the app's manifest: that resets the app's
     name and bot display name to the shipped defaults.
  2. Re-install the app to the workspace (Slack prompts for it after a scope
     change).
  3. Try the `reply` to the user ID again. Held prompts and notices need
     nothing: the persona's next retry, at most 5 minutes later, opens the
     DM and posts them, and `server.log` has the `persona-destination-failed`
     `cleared:` line. With nothing held or pending no retry runs, and the
     `cleared:` line comes with the persona's next prompt or notice. No server
     restart is needed while the bot token is unchanged.
- **The bot token after the re-install:** Slack adds the new scope to the
  app's existing grant, and the shipped manifest has token rotation off, so
  the Bot User OAuth Token normally stays the same. The operator checks this
  themselves, outside the chat: compare the Bot User OAuth Token on the app's
  OAuth & Permissions page with the persona's credentials file. If it changed,
  the operator writes the new token into the credentials file and restarts the
  server, as in the Fix of
  [`persona-credentials-refused`](#persona-credentials-refused);
  [Checking a credentials file's shape](#checking-a-credentials-files-shape)
  confirms the file without showing the token. Never ask for, read, print or
  compare a token value in the chat.

---

## A persona isn't reminded to reply, or is reminded after opting out

- **Symptom:** a persona ends a turn that started from a Slack message without
  replying, and gets no reminder to reply (the Slack Reply Guard's Stop-hook
  message), although its `stop_hook_bootstrap` should be `true`. Or the
  reverse: a persona set to `stop_hook_bootstrap: false` is still reminded.
- **How it works:** before each launch of a persona (spawn, resume or
  restart) the server writes the persona's effective `stop_hook_bootstrap` to
  its record, `reply-guard/<key>` in the state directory, as `true` or
  `false`. The reminder comes from the CSCB-managed Stop hook in the
  persona's `claude_config_dir`/`settings.json`, and the hook reminds only
  when the persona's own record reads `true`. Personas sharing one
  `claude_config_dir` share the hook, but each follows its own record.
- **Confirm,** read only (replace `ops_bot` with the key; `$STATE` as in
  [The server log](#the-server-log)):

  ```sh
  cat "$STATE/reply-guard/ops_bot"; echo
  grep -h -E 'stop-hook-bootstrap|reply-guard' "$STATE"/startup-errors.log "$STATE"/server.log 2>/dev/null | tail -n 40
  jq '.hooks.Stop' "<the persona's claude_config_dir>/settings.json"
  ```

  The server rewrites the record at every launch. Never edit or delete it by
  hand; change `config.json` instead.
- **Causes and fixes:**

  | Cause | How to confirm | Fix |
  |---|---|---|
  | The effective value isn't what you expect. A persona without its own `stop_hook_bootstrap` inherits the top-level one (default `true`). | The persona's entry and the top level of `config.json`. | With the operator's say-so, set `stop_hook_bootstrap` on the persona's entry (it overrides the top level), then relaunch it as in the next row. |
  | The value changed after the persona's instance launched. A running instance keeps the value it launched with; a change applies at the persona's next launch. A plain server restart reconnects to an instance that is still running, which is not a launch. | The record holds the old value. | With the operator's say-so, run `claude-slack-channel-bots clean_restart`. It relaunches every persona (resume or fresh spawn), cutting off their current turns, and each launch rewrites the persona's record. |
  | No `claude_config_dir` is configured for the persona (nor at the top level). No hook is installed for it, so it gets no reminder. | `server.log` has `[slack] stop-hook-bootstrap: "<name>" (key=<key>) has no claude_config_dir — skipping`. | Give the persona (or the top level) a `claude_config_dir` of its own, then `clean_restart`. The new directory must exist (else `stop-hook-bootstrap-dir-missing`) and be logged in to a Claude account, and the bot comes back without its conversation history. |
  | Its `claude_config_dir` resolves to the operator's own `~/.claude`. The server never installs the hook there, so the persona gets no reminder. | `startup-errors.log` has a `stop-hook-bootstrap-refuse-home` entry (recorded once per server start); `server.log` has `refusing to touch operator's own ~/.claude` at each launch. | Point the persona at a different `claude_config_dir`, then `clean_restart`. The new directory must exist (else `stop-hook-bootstrap-dir-missing`) and be logged in to a Claude account, and the bot comes back without its conversation history. |
  | `jq` is not on the host's `PATH`. The hook is installed but can't read the transcript, so it never reminds. | `startup-errors.log` has a `stop-hook-bootstrap-jq-missing` entry. | Install `jq`. No restart is needed; the next turn is checked. |
  | The hook couldn't be installed: the directory is missing, or its `settings.json` is unreadable or not valid JSON (left untouched). | `startup-errors.log` (at start) or `server.log` (at a launch) has `stop-hook-bootstrap-dir-missing`, `stop-hook-bootstrap-not-a-dir` or `stop-hook-bootstrap-settings-…`; the `jq` command above shows no `slack-reply-guard.sh` entry. | Create the directory or fix the file, then `clean_restart`. |
  | The record couldn't be written at launch. The stale record is removed, so the persona gets no reminder until its next launch. | No record file; `server.log` has `[slack] reply-guard: could not write the record for "<name>" (key=<key>) at <path>`. | Fix the state directory's permissions or free space, then `clean_restart`. |
  | Reminded after opting out: the instance launched while the value was `true`. | The record reads `true`. | `clean_restart` (second row). |

- **Not a fault:** the hook reminds at most once per turn, only for a turn
  that started from a Slack message the persona received, and only when it
  hasn't replied with the `reply` tool. A persona that replies, or a turn
  started by a scheduled prompt or `/interject`, gets no reminder.

---

## Other lines you may see

| Line | Meaning |
|---|---|
| `[slack] persona "<name>" (key=<key>): up after its bring-up retry (directory\|Slack) — launching` | A retrying persona came up and is launched from its retry. Normal recovery. |
| `[slack] Session connected: persona "<name>" (key=<key>) cwd="<path>"` | The persona's instance registered: it's being served. |
| `[slack] No live session for persona "<name>" (key=<key>) chat_id=<id> — dropping message` | The persona is up, but its instance has no live MCP session, so a message for it is lost: not delivered, not saved and not replayed later. Nothing else is posted in `<id>`, the conversation it came from (the notice below lands there only when `<id>` is the destination), and it gets no ack reaction. The persona posts one lost-message notice to its destination: `Persona "<name>" (key=<key>): :warning: *Message lost* — a message from <sender> …`, naming the sender (display name, else user ID; for a bot or webhook post, its name or bot ID) and ending in a `Recovery:` state, never the message text. `restarting` and `starting now`: the instance is being restarted; resend once it's back. `auto-restart disabled` and `restart limit reached`: the notice says to restart the server to recover. If the notice doesn't arrive, look for a [`persona-destination-failed`](#persona-destination-failed) line. |
| `[slack] DROP: no _GET_stream for persona "<name>" (key=<key>) chat_id=<id> cwd="<path>" mcpSessionId=<id> — message will not reach the bot; triggering recovery` | The instance's session is registered and looks connected, but its message stream is gone (the `Dispatching to persona …` line just before it has `hasGetStream=false`). The message is lost exactly as for `No live session` above: the same lost-message notice at the destination, nothing else in the source conversation. |
| `[slack] persona-routing: user-name lookup for persona "<name>" (key=<key>) failed, using the user ID: …` | The sender's display name couldn't be looked up through the persona's Slack client. The message is handled as usual, with the sender named by user ID (in the delivered message, or in a lost-message notice). Nothing to do unless it repeats; then check the persona's app and the host's Slack connectivity. |
| `[slack] persona-routing: lost-message notice for persona "<name>" (key=<key>) failed: …` | An internal error raising a lost-message notice: the message was lost and its recovery still ran, but no notice reaches the destination. Report it as a bug, with the persona's lines around it. |
| `[slack] Session connected with CWD "<path>" — no matching persona` | A Claude session connected from a directory that is no persona's `working_directory` (compared by real path). It is not registered: the server disconnects it. Start it from the persona's directory, or fix `working_directory`. |
| `[slack] persona-destination: <ref> has permission_prompts set to "dm" but dm.enabled is not true — no DM opened and nothing posted` (or `… dm.contact is not set …`; for a prompt the line starts `[slack] permission-poller: <ref>` and ends `— prompt for <instance> (request_token=…) not posted and no DM opened`) | The persona's prompt or notice had a `"dm"` destination without DMs on or a contact, which the loader rejects, so it should not happen. Nothing is sent. Report it as a bug, with the persona's lines. |
| `[slack] persona-destination-hold: more than 20 notices held for "<name>" (key=<key>) while its destination fails — oldest held notice dropped, not posted: <first line>` | The persona's destination has been failing for a while (see [`persona-destination-failed`](#persona-destination-failed)) and more than 20 notices are waiting. The oldest is dropped; the line shows its first line. Fix the destination. |
| `[slack] persona-destination-hold: persona=<key> is no longer applied — <n> held notice(s) dropped, not posted` | The persona was removed from the configuration while notices waited for its failing destination. They are dropped. Nothing to do. |
| `[slack] persona-destination-hold: shutting down — <n> held notice(s) for "<name>" (key=<key>) dropped, not posted` | The server stopped while the persona's destination was failing. Its held notices are lost; its still-open prompts are posted after the next start. Fix the destination (see [`persona-destination-failed`](#persona-destination-failed)). |
| `[slack] persona-destination-hold: hold cancelled — <n> held notice(s) for "<name>" (key=<key>) dropped, not posted` | The persona's held notices were dropped without being posted. Nothing to do. |
| `[slack] persona-destination-hold: persona or client lookup threw for persona=<key>: … — held notices wait and retry with backoff` | An internal error while retrying the persona's held notices. They keep waiting and are retried with backoff. Report it as a bug, with the persona's lines around it. |
| `[slack] Fatal: configuration error — …` | The server refused `config.json` and exited. See [Configuration rejections](#configuration-rejections). |
| `… launch after its bring-up retry failed: …`, `… working-directory retry failed: …`, `… handling its change from up to <outcome> failed: …`, `persona … not brought up: Slack bring-up threw: …`, `persona <step> failed: personas[<i>] …`, `persona-destination-hold: retry of held notices failed for persona=<key>: …`, `persona-destination-hold: notice failure callback threw for persona=<key>: …`, `unhandled rejection (process keeps running): …` | An internal error. The server keeps running. Report it as a bug, with the persona's lines around it. |

---

## Configuration rejections

`config.json` (in the state directory) is checked when the server starts. The
first violation stops the start before any persona is brought up: nothing
connects to Slack and nothing is launched. Credentials content and whether
directories exist are never checked here; those are bring-up checks with the
classes above.

**Where it shows.** The server logs one line to `server.log` and exits 1, and
`start` repeats the last lines of `server.log` on stderr under
`[slack] Server failed to start (exit code 1). From <path>:`. Nothing goes to
`startup-errors.log`.

```text
[slack] Fatal: configuration error — loadPersonaConfig: invalid persona config in "<path>/config.json": Persona config validation error: personas[1] "Ops Bot" (key=ops_bot_5e2526f3): permission_prompts is required: set it to "dm" or one of the persona's channel IDs.
```

Messages about one persona start `personas[<i>] "<name>" (key=<key>): `, or
just `personas[<i>]: ` when the name itself is the problem. A malformed value
(a bad channel ID, `dm.contact` or `permission_prompts`) is never echoed, and
no message shows a token. Messages do quote persona names and keys, channel
IDs, unknown key names, the configuration file's path and, in the
duplicate-path rules, the persona paths. After a fix, start the server again.

### Before any persona is read

| Message | Cause | Fix |
|---|---|---|
| `missing prerequisite: config.json not found at <path>` (from `start`), or `The configuration file "<path>" does not exist. The server requires the configuration file to start.` | No `config.json` in the state directory. | Create it; `{"personas": []}` is the smallest valid file. Check `SLACK_STATE_DIR`. |
| `The configuration file "<path>" cannot be read (<errno>). …` | Permissions, or the path is a directory. | Make it a readable file. |
| `loadPersonaConfig: malformed JSON in "<path>".` | Not valid JSON. | Fix the syntax (`jq . config.json` shows where). |
| `the configuration must be a JSON object, got <type>.` | Top level isn't an object. | Wrap it in `{ … }`. |
| A key belonging to the pre-persona shape | See [Pre-persona configuration](#pre-persona-configuration). | |
| `unknown top-level field(s) in config.json: "<key>", ….` | A top-level key the server doesn't know (often a typo). | Remove or correct it. |
| `claude_director_poll_interval_ms has been renamed to agent_director_poll_interval_ms …` | Old key name. | Rename it. |
| `personas is required: an array of persona entries, which may be empty.` / `personas must be an array, got <type>.` | Missing or wrong type. | Add `"personas": [ … ]`. |
| Server-wide type and range errors: `<key> must be a non-negative number.`, `<key> is invalid. Allowed values are: ….`, `<key> must be a boolean.`, `<key> must be a non-empty string when set.`, `<key> must be a string when set.`, `<key> must be a positive integer (>= 1) when set.`, `agent_director_poll_interval_ms must be a positive integer in [200, 3600000].`, `cron_table_path must be a non-empty string.`, `cron_log_path must be a non-empty string.` | A server-wide setting has the wrong type or is out of range. | Correct the named key. |

### Persona entries

| Message (after the persona prefix) | Cause | Fix |
|---|---|---|
| `personas[<i>] must be a JSON object, got <type>.` | An array element isn't an object. | Make it a persona object. |
| `unknown field(s) in the persona entry: "<key>".`, `… in dm: …`, `… in channels[<j>]: …` | A key the schema doesn't have, at that level. | Remove or correct it. |
| `name is required.` / `name must be a non-empty string.` | Missing or blank name. | Give the persona a name. |
| `credentials_file is required.` / `working_directory is required.` | Missing path. | Add it. |
| `<setting> must be an absolute path, "~" or a path starting with "~/".` | `credentials_file`, `working_directory` or `claude_config_dir` is relative (or not a string). | Use an absolute path or `~/…`. |
| `stop_hook_bootstrap must be a boolean.` / `dm.enabled must be a boolean.` | Wrong type. | Use `true` or `false`. |
| `dm must be a JSON object, got <type>.` / `channels must be an array, got <type>.` / `channels[<j>] must be a JSON object, got <type>.` | Wrong shape. | Fix the shape. |
| `channels[<j>].id is required.` / `channels[<j>].delivery is required.` | A channel entry lacks a key. | Every channel needs `id` and `delivery`. |
| `channels[<j>].id must be a Slack channel ID matching ^[CG][A-Z0-9]+$.` | Malformed channel ID (a name, a lower-case ID, a URL). | Use the channel ID, e.g. `C0123ABCD`. |
| `channels[<j>].delivery is invalid. Allowed values are: all, mentions.` | Bad delivery value. | `all` or `mentions`. |
| `channel <id> is listed more than once (channels[<a>] and channels[<b>]).` | One persona lists a channel twice. | Keep one entry. (Several personas may list the same channel.) |
| `dm.contact must be a Slack user ID matching ^[UW][A-Z0-9]+$.` | Malformed `dm.contact`. | Use a user ID, e.g. `U0123ABCD`. |
| `permission_prompts is required: set it to "dm" or one of the persona's channel IDs.` | Missing. | Add it. |
| `permission_prompts must be "dm" or a Slack channel ID matching ^[CG][A-Z0-9]+$.` | Malformed value. | Use `"dm"` or a channel ID. |
| `permission_prompts names channel <id>, which is not in the persona's channels.` | The destination channel isn't one the persona lists. | Add the channel to its `channels`, or pick one it lists. |
| `permission_prompts is "dm" but dm.contact is not set` / `… but dm.enabled is not true` / both, joined by `and` | A `dm` destination needs both. | Set `dm.contact` and `"dm": {"enabled": true, …}`, or use a channel. |
| `the persona has no channels and dm.enabled is not true, so it can receive no messages. Add a channel or set dm.enabled to true.` | Zero channels with DMs off. | Add a channel or turn DMs on. |

### Across personas

Checked only after every entry is valid.

| Message (after the later persona's prefix) | Cause | Fix |
|---|---|---|
| `name "<name>" is duplicated: personas[<j>] "<name>" (key=<key>) has the same name. Persona names and keys must be unique.` | Two personas share a name. | Rename one. |
| `key <key> is duplicated: … has the same key. …` | Two different names map to the same key. | Rename one so the keys differ. |
| `name "<name>" equals the key of personas[<j>] …. …` / `key <key> equals the name of personas[<j>] …. …` | One persona's name is another's key. | Rename one. |
| `working_directory "<path>" is also the working_directory of personas[<j>] …. Each persona needs its own working_directory.` | Two personas share a working directory. Compared by real path, so a symlink to another persona's directory counts; the message then shows both paths and `both resolve to "<real path>"`. | Give each persona its own directory. |
| `credentials_file "<path>" is also the credentials_file of personas[<j>] …. Each persona needs its own credentials_file.` | Two personas share a credentials file, compared by real path the same way. | One credentials file per persona (one Slack app per persona). |

---

## Pre-persona configuration

**Message:**

```text
"<key>" belongs to the pre-persona configuration shape, which is no longer accepted. The configuration must be converted to personas: rewrite it by hand as a "personas" array. Nothing is converted automatically and the file has not been changed.
```

- **Cause:** `config.json` still has a top-level `routes` (in any shape),
  `default_route` or `default_dm_session`. These are rejected before any other
  check.
- **Fix:** Rewrite the configuration by hand as a `personas` array and remove
  those keys. Nothing converts it for you, and the server never changes the
  file. Crontable lines that named channels must be rewritten to name personas
  too.

---

## Listing instances

Every CSCB instance carries the `service=cscb` label and its persona's
`persona=<key>` label; its instance ID is `cscb_<key>`. Repeated `--label`
filters must all match, so the second command lists one persona's row:

```sh
agent-director list --label service=cscb
agent-director list --label service=cscb --label persona=ops_bot_5e2526f3
```

Read the row's state with the persona's server-log lines:

| Row | Persona's lines | What it means |
|---|---|---|
| Live state (`working`, `waiting`, `pending`, `check_permission`, `ask_user`) | The persona is `broken` or `retrying` | Down persona with a live instance: kept, not served. Fix the persona's cause; the instance is picked up when it's up. |
| Live state | The persona is up, `Session connected: …` | Healthy. |
| Live state | The persona is up, but no `Session connected` since the start | Waiting to re-register; the health check reconnects it within about 3–5 minutes with default settings. |
| `ended`, `missing`, or no row | The persona is up | The instance is dead. Restart and the health check relaunch it; look for `Scheduling restart for persona=<key>` and `Relaunching session`. |
| `ended`, `missing`, or no row | The persona is down | Nothing to serve; it's launched once the persona comes up. |

`tmux has-session -t slack_bot_<key>` confirms whether the instance's tmux
session exists.

