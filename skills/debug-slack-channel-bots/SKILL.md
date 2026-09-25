---
name: debug-slack-channel-bots
description: Diagnose a claude-slack-channel-bots persona that is silent, down or refused — find its server-log lines, match the class, and follow the fix for every persona failure, every config.json rejection, every last-applied record failure at start, and every pending configuration change and its confirmation.
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
It also covers every reason `config.json` is rejected at start, every
reason the last-applied record (`config.json.last-applied`) stops a start, and
how to read and confirm a pending configuration change
(`config.json.pending`).

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
   [Configuration rejections](#configuration-rejections). A
   `Fatal: last-applied record error` line or a `reload-record-write-failed`
   line is covered under [The last-applied record](#the-last-applied-record).
   A first start that failed binding its port, then failed the same way after
   `config.json` was fixed, is covered under
   [A first start that fails after recording](#a-first-start-that-fails-after-recording).
   Otherwise another
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
8. **An edit of `config.json` had no effect, `config.json.pending` exists, or
   `server.log` has `reload-preview` or `reload-invalid` lines?** The edit is
   pending, not applied. See [Pending changes](#pending-changes), and
   [Confirming a pending change](#confirming-a-pending-change) to apply it.
   Renamed `config.json.pending` to `config.json.apply` and nothing
   happened? See [I confirmed but nothing happened](#i-confirmed-but-nothing-happened).
9. **A persona was just added or removed by a confirmed change?** See
   [A persona was added or removed by a confirmed change](#a-persona-was-added-or-removed-by-a-confirmed-change).
   Its channels, destination or DM settings were changed? See
   [A persona's routing settings were changed by a confirmed change](#a-personas-routing-settings-were-changed-by-a-confirmed-change).

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
  warnings. No persona diagnostic goes there, and no configuration or
  last-applied record refusal either.

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

**Personas added at runtime.** When a confirmed change adds a persona, the
running server brings it up exactly as a start does, so every class below is
logged for it the same way, with the same fix. Personas that were already
running are not affected. See
[A persona was added or removed by a confirmed change](#a-persona-was-added-or-removed-by-a-confirmed-change).

### `persona-start`

- **Line:** `[slack] persona-start: personas[<i>] "<name>" (key=<key>): bring-up starting`
- **Meaning:** One line per configured persona each time the server starts,
  and one for each persona a confirmed change adds, before any other line
  about that persona's bring-up. It's the name-to-key map.
- **Fix:** None. If a persona has no `persona-start` line in the latest start,
  it isn't in the configuration the server applied at that start, or the
  server didn't start at all (see [Configuration rejections](#configuration-rejections)
  and [The last-applied record](#the-last-applied-record)). When a
  last-applied record exists, a start runs the record, not `config.json`: a
  persona added to `config.json` since the record was written isn't brought up
  until the edit is confirmed (see
  [Confirming a pending change](#confirming-a-pending-change)).

### `persona-credentials-missing`

- **State:** `broken`. Doesn't recover on its own.
- **Cause text:** `credentials file does not exist`. The path in `path="…"`
  doesn't exist, or a directory on the way to it doesn't.
- **Fix:** Create the credentials file at that path, then restart the server.
  Or correct the persona's `credentials_file` in `config.json`, confirm the
  edit, then restart the server (see
  [What a confirmation doesn't apply yet](#what-a-confirmation-doesnt-apply-yet)); a plain restart without the confirmation doesn't apply it.
- **Added at runtime:** the same line, with the same fix, when a confirmed
  change adds this persona. Other personas are not affected.

### `persona-credentials-unreadable`

- **State:** `broken`. Doesn't recover on its own.
- **Cause text:** one of `credentials file is a directory`,
  `credentials file is not a regular file` (a FIFO, socket or device),
  `credentials file cannot be read: permission denied (<errno>)` (`EACCES` or `EPERM`),
  `credentials file cannot be read (<errno>)`, or
  `credentials file is larger than the 64 KiB limit` (the server never reads
  a file over 64 KiB; a real credentials file is far smaller, so the path
  names the wrong file).
- **Fix:** Make the path a regular file readable by the user the server runs
  as (the file should be mode 0600, owned by that user). Then restart the
  server.
- **Added at runtime:** the same line, with the same fix, when a confirmed
  change adds this persona. Other personas are not affected.

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
  The shared case can't come from `config.json` validated at a start without
  a record: that check rejects two personas sharing a file (see
  [Across personas](#across-personas)). It appears at a start from the
  last-applied record, which doesn't run that check, or when a symlink changed
  after the configuration loaded. Each persona sharing the file gets this line
  and is `broken`; the other personas come up. A dry run reads no credentials
  file, so it never logs the shared case. Re-saving the shared file with
  different content shows a pending credentials change for each persona that
  shares it (the server hashes the file for this and takes no token from it),
  but that change can't bring either persona up while they still share the
  file.
- **Fix:** The operator rewrites the file in the shape above (mode 0600), then
  restarts the server. For a shared file, give each persona its own file: point
  the symlink elsewhere and restart, or change a `credentials_file` in
  `config.json`, confirm the edit and restart (see
  [What a confirmation doesn't apply yet](#what-a-confirmation-doesnt-apply-yet)). Use
  [Checking a credentials file's shape](#checking-a-credentials-files-shape) to
  confirm the fix without showing a token.
- **Added at runtime:** the same line, with the same fix, when a confirmed
  change adds this persona. Other personas are not affected.

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
- **Added at runtime:** the same line, with the same fix, when a confirmed
  change adds this persona. Other personas are not affected.
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
- **Added at runtime:** the same line, with the same fix, when a confirmed
  change adds this persona. Other personas are not affected.

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
- **Fix:** Create the directory (readable and searchable by the server's user).
  Or correct `working_directory` in `config.json`, confirm the edit, then
  restart the server (see
  [What a confirmation doesn't apply yet](#what-a-confirmation-doesnt-apply-yet)); a plain restart without the confirmation doesn't apply it.
- **Added at runtime:** the same line when a confirmed change adds this
  persona; it comes up on its own once the directory is usable. Other
  personas are not affected.
- If the persona also has a credentials cause, the cleared line ends
  `the persona stays broken until its credentials are fixed and the server is restarted`
  instead. See [Both causes at once](#both-causes-at-once).

### `persona-directory-unusable`

- **State:** `retrying`. Same retry and logging as `persona-directory-missing`.
- **Cause text:** `working directory is not a directory`,
  `working directory is not readable (<errno>)`,
  `working directory is not searchable (<errno>)`,
  `working directory cannot be inspected (<errno>)`, or
  `real path is also the working_directory of "<name>" (key=<key>)`, with
  `(both resolve to "<path>")` when a symlink is involved.
- **Shared directory:** `config.json` validated at a start without a record
  rejects two personas sharing a directory (see [Across personas](#across-personas)).
  A start from the last-applied record doesn't run that check, so there (or
  after a symlink changed) each persona sharing the directory gets this line
  and keeps retrying; the other personas come up.
- **Fix:** Make the path a directory the server's user can read and search
  (`chmod u+rx`), or point the persona at its own directory (by changing the
  symlink, or by changing `working_directory` in `config.json`, confirming the
  edit and restarting, see
  [What a confirmation doesn't apply yet](#what-a-confirmation-doesnt-apply-yet)). A fixed path comes up on the next re-check, within 300 s.
- **Added at runtime:** the same line when a confirmed change adds this
  persona; it comes up on its own once the directory is usable. Other
  personas are not affected.

### `unclaimed-channel`

- **State:** the persona is `up`; this is about a message, not the persona.
- **Line:** `[slack] unclaimed-channel: personas[<i>] "<name>" (key=<key>): message in channel <id> not delivered: no applied persona lists this channel`
- **Meaning:** The persona's Slack app is a member of a channel that no
  persona lists in `channels`, so the message reached no one. Logged by each
  persona whose app received it.
- **Fix:** Add the channel to the right persona's `channels` in `config.json`,
  or remove the app from the channel. A `config.json` edit becomes pending (see
  [Pending changes](#pending-changes)); once confirmed (see
  [Confirming a pending change](#confirming-a-pending-change)) it applies in
  place, with no restart, and the persona keeps its instance and
  conversation. If the ID is a
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
- **Fix:** Set `dm.enabled` to `true` for that persona in `config.json`. The
  edit becomes pending (see [Pending changes](#pending-changes)); once
  confirmed (see [Confirming a pending change](#confirming-a-pending-change))
  it applies in place, with no restart, and the persona keeps its instance and
  conversation. DMs sent before that aren't delivered later. Leaving it off
  is valid when the persona should ignore DMs; the line is then expected.
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
  - the line is logged once per episode. Failed retries log nothing, except
    that when `permission_prompts` was changed by a confirmed reload during
    the episode, the first failure at the new destination logs one more start
    line naming it. The `cleared:` line names the destination the successful
    post went to;
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
  - To send the persona's prompts and notices somewhere else instead, change
    its `permission_prompts` (a channel its app is in, or `dm`) or its
    `dm.contact` in `config.json`. The edit becomes pending (see
    [Pending changes](#pending-changes)); once confirmed (see
    [Confirming a pending change](#confirming-a-pending-change)) it applies
    in place, with no restart, and the persona keeps its instance and
    conversation. What is held goes to the new destination at its next retry;
    prompts already posted stay where they are and can still be answered; a
    changed `dm.contact` gets a fresh DM at the next prompt or notice (see
    [A persona's routing settings were changed by a confirmed change](#a-personas-routing-settings-were-changed-by-a-confirmed-change)).
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
| A restart is asked for | `[slack] Not scheduling restart for persona=<key> — the relaunch gate refused it (the persona is not up, or is no longer in the applied configuration)`, or, when the persona stopped being up while a restart was pending, `[slack] Skipping restart for persona=<key> — the persona is no longer up; its instance is left as it is`. Neither counts toward the restart cap. |
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

## A persona was added or removed by a confirmed change

A confirmed change applies additions and removals on the running server, with
no restart. A rename is both: the old key is removed and the new key is added.
Every line below is in `server.log` only. The only things posted to Slack
are an added persona's storage warning and spawn-failure notice, both at its
own destination (below); a removal posts nothing.

**Added persona.** It is brought up as at a start: its `persona-start` line,
then any class line under
[Persona diagnostic classes](#persona-diagnostic-classes), each with its usual
fix. A persona that can't come up (bad credentials, a missing directory)
never affects the personas already running. If the server was already
shutting down when the bring-up began, it logs only the `not brought up` line
below. If shutdown began during a bring-up that succeeded, its
`persona-start` line (and any class line) comes first, then `not brought up`
instead of `up at apply`.

| Line | Meaning |
|---|---|
| `[slack] persona "<name>" (key=<key>): up at apply — launching` | It came up and its instance is being launched. Normal. |
| `[slack] persona "<name>" (key=<key>): launch at apply failed: <error>` | The launch threw. Look for a spawn-failure notice at the persona's destination and the persona's lines around it; if nothing explains it, report it as a bug. |
| `[slack] persona "<name>" (key=<key>): storage check at apply failed: <error>` | An internal error in the storage check. The bring-up went on. Report it as a bug. |
| `[slack] persona "<name>" (key=<key>): not brought up — the server is shutting down` | The server was stopping, so the persona wasn't brought up or launched. It comes up at the next start. |

Its conversation storage is checked as at start: a storage root on
`tmpfs`/`ramfs` is recorded in `startup-errors.log` as `jsonl-non-persistent`,
and a warning goes to the persona's destination once its Slack client is
validated.

The server's next check for pending changes waits until every teardown and
bring-up of the change has settled, which can take minutes: up to 5 when a
pre-session dialog has to be approved, up to 10 when a leftover instance of
the persona is still `working`. A teardown also waits for any restart already
under way for its persona. Meanwhile `config.json.pending` isn't refreshed and
no other confirmation is picked up. Stopping the server doesn't wait for it.

**Removed persona.** It is torn down at once, with no graceful wind-down: its
Slack connection is closed, its MCP session dropped, its reply-guard record
deleted, and its instance `cscb_<key>` killed and its agent-director row
deleted. Its conversation can't be resumed. Its permission prompts stay in
Slack as posted; clicking one does nothing, because clicks arrive only on the
persona's own Slack connection, which the removal closed. To bring the persona
back, add it to `config.json` again and confirm; its old conversation isn't
guaranteed to be resumed.

| Line | Meaning |
|---|---|
| `[slack] persona teardown of "<name>" (key=<key>): starting`, later `…: complete` | The teardown ran. Normal. |
| `[slack] persona teardown of "<name>" (key=<key>): complete, with <n> failed step(s)` | Some steps failed; each has its own line (below). |
| `[slack] persona teardown of "<name>" (key=<key>): agent-director kill of cscb_<key> failed: <error>` (or `… delete of cscb_<key> failed: …`) | agent-director couldn't kill or delete the instance, often because it was unreachable. The row may still be there (see [Listing instances](#listing-instances)); the next server start removes it. |
| `[slack] persona teardown of "<name>" (key=<key>): <step> failed: <error>`, any other step | An internal error. The other steps still ran. Report it as a bug. |
| `[slack] dry-run: persona teardown of "<name>" (key=<key>): skipping the agent-director kill and delete of cscb_<key>` | Dry run: the instance and its row are left alone. |
| `[slack] Cancelled restart timer for persona=<key>` | A restart that was pending for it was cancelled. |
| `[slack] permission-poller: persona=<key>: dropped <n> tracked prompt(s); their Slack messages stay as posted` | Its open prompts are no longer tracked. Their messages stay in Slack, and clicking them does nothing. |
| `[slack] persona-notifier: persona=<key>: dropped <n> held notice(s), not posted — the persona was torn down` | Notices that were waiting for its Slack client are dropped. |
| `[slack] persona-destination-hold: hold cancelled — <n> held notice(s) for "<name>" (key=<key>) dropped, not posted` | Notices that were waiting for its failing destination are dropped. |

**Either.** `[slack] reload: apply step <n> (<step>) failed for persona "<name>" (key=<key>): <error>`
is an internal error in that persona's teardown or bring-up; the other
personas were still handled. Report it as a bug, with the persona's lines.

---

## A persona's routing settings were changed by a confirmed change

A confirmed change to a kept persona's `channels` (each entry's `delivery`
included), `permission_prompts`, `dm.enabled` or `dm.contact` applies in
place on the running server, with no restart. The persona's instance, its
conversation, its Slack connection and its MCP session are kept. The new
values govern its next message, tool call, permission prompt and notice. This
holds for a persona that is `retrying` or `broken` too: it uses the new values
once it is up.

- **Prompts already posted** stay where they were posted and can still be
  answered, including a prompt in the persona's DM after `dm.enabled` is
  turned off.
- **Prompts and notices held** for a failing destination (see
  [`persona-destination-failed`](#persona-destination-failed)) aren't
  dropped: each retry goes to the new destination.
- **A changed `dm.contact`** gets a fresh DM: the next prompt or notice opens
  the DM with the new contact.

| Line | Meaning |
|---|---|
| `[slack] persona "<name>" (key=<key>): updated in place (<settings>); its instance, Slack connection and MCP session are kept` | The change was applied. `<settings>` lists what changed, such as `channels, dm.contact`. Normal. The same line is logged for a persona that is `retrying` or `broken`, though it has no instance, connection or session yet; it serves with the new values once it comes up. |
| … the same line ending `; its cached DM conversation is forgotten` | `permission_prompts` or `dm.*` changed, so the next post to a DM destination opens the DM again. Normal. |
| … the same line ending `; forgetting its cached DM conversation failed: <error>` | An internal error. The new values still apply. Report it as a bug. |
| `[slack] persona "<name>" (key=<key>): in-place update failed: <error>` | An internal error. The new values still apply, because the server reads them at each use. Report it as a bug. |

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
  hand; change `config.json` and apply the edit.
- **Causes and fixes:**

  | Cause | How to confirm | Fix |
  |---|---|---|
  | The effective value isn't what you expect. A persona without its own `stop_hook_bootstrap` inherits the top-level one (default `true`). | The persona's entry and the top level of `config.json`. | With the operator's say-so, set `stop_hook_bootstrap` on the persona's entry (it overrides the top level), then confirm the edit and relaunch the bots with `clean_restart` (see [What a confirmation doesn't apply yet](#what-a-confirmation-doesnt-apply-yet)). |
  | The value changed after the persona's instance launched. A running instance keeps the value it launched with; a change applies at the persona's next launch. A plain server restart reconnects to an instance that is still running, which is not a launch. | The record holds the old value. | With the operator's say-so, run `claude-slack-channel-bots clean_restart`. It relaunches every persona (resume or fresh spawn), cutting off their current turns, and each launch rewrites the persona's record. |
  | No `claude_config_dir` is configured for the persona (nor at the top level). No hook is installed for it, so it gets no reminder. | `server.log` has `[slack] stop-hook-bootstrap: "<name>" (key=<key>) has no claude_config_dir — skipping`. | Give the persona (or the top level) a `claude_config_dir` of its own, then confirm the edit and relaunch the bots with `clean_restart` (see [What a confirmation doesn't apply yet](#what-a-confirmation-doesnt-apply-yet)). The new directory must exist (else `stop-hook-bootstrap-dir-missing`) and be logged in to a Claude account, and the bot comes back without its conversation history. |
  | Its `claude_config_dir` resolves to the operator's own `~/.claude`. The server never installs the hook there, so the persona gets no reminder. | `startup-errors.log` has a `stop-hook-bootstrap-refuse-home` entry (recorded once per server start); `server.log` has `refusing to touch operator's own ~/.claude` at each launch. | Point the persona at a different `claude_config_dir`, then confirm the edit and relaunch the bots with `clean_restart` (see [What a confirmation doesn't apply yet](#what-a-confirmation-doesnt-apply-yet)). The new directory must exist (else `stop-hook-bootstrap-dir-missing`) and be logged in to a Claude account, and the bot comes back without its conversation history. |
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
| `[slack] persona-destination-hold: hold cancelled — <n> held notice(s) for "<name>" (key=<key>) dropped, not posted` | The persona was removed by a confirmed change, and its held notices were dropped without being posted. Nothing to do. |
| `[slack] persona-destination-hold: persona or client lookup threw for persona=<key>: … — held notices wait and retry with backoff` | An internal error while retrying the persona's held notices. They keep waiting and are retried with backoff. Report it as a bug, with the persona's lines around it. |
| `[slack] Fatal: configuration error — …` | There was no last-applied record, and the server refused `config.json` and exited. See [Configuration rejections](#configuration-rejections). |
| `[slack] Fatal: last-applied record error — …` | The server couldn't read or validate its last-applied record and exited. See [The last-applied record can't be read or is invalid](#the-last-applied-record-cant-be-read-or-is-invalid). |
| `[slack] Starting from the last-applied record "<path>"` or `[slack] No last-applied record: recorded the configuration file "<path>" as "<path>"` | Which configuration a start runs. See [The last-applied record](#the-last-applied-record). |
| `… launch after its bring-up retry failed: …`, `… working-directory retry failed: …`, `… handling its change from up to <outcome> failed: …`, `persona … not brought up: Slack bring-up threw: …`, `persona <step> failed: personas[<i>] …`, `persona-destination-hold: retry of held notices failed for persona=<key>: …`, `persona-destination-hold: notice failure callback threw for persona=<key>: …`, `unhandled rejection (process keeps running): …` | An internal error. The server keeps running. Report it as a bug, with the persona's lines around it. |

---

## Configuration rejections

`config.json` (in the state directory) is checked at a start only when there
is no last-applied record (`config.json.last-applied`, see
[The last-applied record](#the-last-applied-record)): the first start, the
first start after an upgrade, or a start after the record was deleted. Then the
first violation stops the start before any persona is brought up: nothing
connects to Slack and nothing is launched. Credentials content and whether
directories exist are never checked here; those are bring-up checks with the
classes above.

When a record exists, a start runs the record and doesn't read `config.json`,
so a restart doesn't apply an edit of `config.json`. The running server still
checks an edit, within about 5 s once a start's bring-up is done (see
[The last-applied record](#the-last-applied-record)). If the edit is wrong, it
writes the error as one `INVALID:` line to `config.json.pending` and logs it
once under [`reload-invalid`](#reload-invalid) in `server.log`; nothing is
applied. The error is the same message as in the tables below. To apply an
edit, confirm it (see [Confirming a pending change](#confirming-a-pending-change)).

```text
[slack] reload-invalid: the pending configuration is invalid and nothing will be applied: <loader error> (preview in "<path>/config.json.pending")
```

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
IDs, the configuration file's path and, in the duplicate-path rules, the
persona paths. An unknown key's name is quoted only when it is a plain setting
name (letters and underscores, up to 48 characters); any other unknown key is
counted instead, since it could be a pasted token. A name with a digit, such
as `channels2`, is therefore not shown. After a fix, start the server again.

### Before any persona is read

| Message | Cause | Fix |
|---|---|---|
| `missing prerequisite: config.json not found at <path>, and no config.json.last-applied at <path>` (from `start`), or `The configuration file "<path>" does not exist. The server requires the configuration file to start.` | No `config.json` and no last-applied record in the state directory. | Create `config.json`; `{"personas": []}` is the smallest valid file. Check `SLACK_STATE_DIR`. |
| `The configuration file "<path>" cannot be read (<errno>). …` | Permissions, or the path is a directory (`EISDIR`). `(not a regular file)` in place of the errno: the path is a FIFO, socket or device, which is never read. | Make it a readable regular file. |
| `The configuration file "<path>" is larger than the 64 KiB limit. …` | The file is over 64 KiB. Start and the reload check never read past that; a real configuration is far smaller, so the file is damaged or the wrong file. | Replace it with the intended configuration. |
| `loadPersonaConfig: malformed JSON in "<path>" at line <L>, column <C>.` | Not valid JSON. The line and column (from 1) point at the first character that breaks it; the file's content is never echoed. | Fix the syntax at that position. |
| `the configuration must be a JSON object, got <type>.` | Top level isn't an object. | Wrap it in `{ … }`. |
| A key belonging to the pre-persona shape | See [Pre-persona configuration](#pre-persona-configuration). | |
| `unknown top-level field(s) in config.json: "chanels".`, or `…: 1 field whose name is not shown (it is not a plain setting name, so it could be a pasted secret).`, or `…: "chanels", plus 2 fields whose names are not shown (they are not plain setting names, so they could be pasted secrets).` | A top-level key the server doesn't know (often a typo). Only names made of letters and underscores (up to 48 characters) are shown; any other name (one with a digit such as `channels2`, a dash, a dot, or a pasted token) is only counted. | Remove or correct it. For an unshown field, compare the file's top-level keys with the settings in the README. |
| `claude_director_poll_interval_ms has been renamed to agent_director_poll_interval_ms …` | Old key name. | Rename it. |
| `personas is required: an array of persona entries, which may be empty.` / `personas must be an array, got <type>.` | Missing or wrong type. | Add `"personas": [ … ]`. |
| Server-wide type and range errors: `<key> must be a non-negative number.`, `<key> is invalid. Allowed values are: ….`, `<key> must be a boolean.`, `<key> must be a non-empty string when set.`, `<key> must be a string when set.`, `<key> must be a positive integer (>= 1) when set.`, `agent_director_poll_interval_ms must be a positive integer in [200, 3600000].`, `cron_table_path must be a non-empty string.`, `cron_log_path must be a non-empty string.` | A server-wide setting has the wrong type or is out of range. | Correct the named key. |

### Persona entries

| Message (after the persona prefix) | Cause | Fix |
|---|---|---|
| `personas[<i>] must be a JSON object, got <type>.` | An array element isn't an object. | Make it a persona object. |
| `unknown field(s) in the persona entry: "<key>".`, `… in dm: …`, `… in channels[<j>]: …`, each possibly with `1 field whose name is not shown …` or `plus <n> fields whose names are not shown …` | A key the schema doesn't have, at that level. As at the top level, only plain setting names are shown; others (a digit, as in `channels2`, a dash, a pasted token) are counted. | Remove or correct it. For an unshown field, compare that entry's keys with the persona keys in the README. |
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

Checked only after every entry is valid. The two shared-path rules below are
checked only for `config.json` at a start without a record. At a start from
the last-applied record, a shared path is a bring-up failure of each persona
involved instead ([`persona-directory-unusable`](#persona-directory-unusable)
or [`persona-credentials-invalid`](#persona-credentials-invalid)), and the
other personas come up.

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
  too. Like every configuration rejection, this stops only a start without a
  last-applied record.

---

## The last-applied record

The server keeps a byte copy of the configuration it last applied,
`config.json.last-applied`, beside `config.json` in the state directory. Every
start runs the record when it exists and doesn't read `config.json` to decide
what runs, so saving `config.json`, restarting or rebooting doesn't change the
running configuration. Credentials files are the exception: every start reads
them as they stand, so a changed credentials file takes effect at the next
start.

Without a record (the first start, the first start after an upgrade, or after
the record was deleted), `config.json` is checked, copied to the record, then
applied. The CLI takes its settings and persona set from the record too, or
from `config.json` when there is none: `stop` (its `stop_timeout`),
`stop --stop-bots` and `clean_restart`. Never edit the record's contents.

Each start logs which configuration it runs:

| Line | Meaning |
|---|---|
| `[slack] Starting from the last-applied record "<record path>"` | A record exists; the start runs it. |
| `[slack] No last-applied record: recorded the configuration file "<config path>" as "<record path>"` | No record; `config.json` was valid and is now the record. |

Once a start's bring-up is done, the running server checks `config.json`
every 5 s, and the credentials files it references too, unless the server
runs with `SLACK_DRY_RUN`. It applies nothing it finds. While an edit (or a
changed credentials file) is waiting, it keeps `config.json.pending` beside
`config.json`, and it deletes the file when nothing is waiting any more.
The file holds a preview of what applying the change would do, and the same
preview is logged once (see [Pending changes](#pending-changes)). To apply an
edit, confirm it (see [Confirming a pending change](#confirming-a-pending-change)). The
check writes only to the server log, never to Slack.

If the check can't keep that file in step, it logs one of these plain
`[slack] reload:` lines, with no class label. A failure that keeps repeating
is logged once, until a later check succeeds or what is waiting changes (an
edit made, changed again or reverted), and the check tries again every 5 s:

- `[slack] reload: cannot write the pending-change file "<pending path>" (<errno>); retrying at the next check`
- `[slack] reload: wrote the pending-change file "<pending path>" but could not sync its directory (<errno>); writing it again at the next check`
- `[slack] reload: cannot remove the pending-change file "<pending path>" (<errno>); retrying at the next check`
- `[slack] reload: detection check failed: <error>; checking again at the next tick`

One more line has no retry, because the file is already gone:

- `[slack] reload: removed the pending-change file "<pending path>" but could not sync its directory (<errno>); it may reappear after a crash, and the next start removes it`

The server counts that file as removed, and
[`reload-nothing-pending`](#reload-nothing-pending) follows (except for a
file placed by hand while nothing was waiting, which is removed silently). If a crash
brings the file back, the first check after the next start removes it.

The `(<errno>)` part appears only when the error has a code. The usual causes
are the ones under
[`reload-record-write-failed`](#reload-record-write-failed): the state
directory's permissions, free space or filesystem. Nothing running is
affected.

### Pending changes

`config.json.pending` sits beside `config.json` in the state directory. It
appears within about 5 s of saving `config.json`, or a credentials file that
`config.json` references, with content that differs from what is applied. It
says what applying the change would do. It is deleted when nothing differs
any more. Nothing in it is applied, and it never reaches Slack.

- **Saving, restarting or rebooting applies nothing.** Every start runs the
  last-applied record, so a `config.json` edit stays pending across restarts
  and reboots. A pending credentials-file change is the exception: every start
  reads credentials files as they stand, so the next start applies it.
- **Dry run.** With `SLACK_DRY_RUN` set, no credentials file is read: a
  changed credentials file never shows as pending, and an added persona's
  credentials file isn't checked.
- **When it's checked.** The first check runs once a start's bring-up is done,
  then every 5 s.
- **Applying it.** With the operator's say-so, rename `config.json.pending`
  to `config.json.apply`; the next check applies the change it describes,
  if the files still match it (see
  [Confirming a pending change](#confirming-a-pending-change)). The operator
  may direct an agent to do the rename. There is no reload command: no CLI
  subcommand, MCP tool or HTTP endpoint applies a change.

Read it, and compare the edit with the applied configuration:

```sh
STATE="${SLACK_STATE_DIR:-$HOME/.claude/channels/slack}"
cat "$STATE/config.json.pending"
diff "$STATE/config.json.last-applied" "$STATE/config.json"
```

The file holds no token and no credentials content. It shows no setting value
except the new path of a destructive path change (`working_directory changed
to "<path>"`), plus persona names and credentials-file paths. The diff can
show anything in `config.json` (see [Constraints](#constraints)).

The first two lines are written by the server:
`claude-slack-channel-bots: pending configuration change (written by the server)`
and `fingerprint: sha256:<64 hex digits>`. The fingerprint identifies the
exact files the preview was made from; nobody needs to read or type it. After
a blank line comes the preview, one line per effect. Personas are named as
`persona "<name>" (key=<key>)`.

**Header.** The first preview line:

```text
A configuration change is pending; nothing has been applied. personas: <n> added, <n> removed, <n> destructively modified, <n> modified in place, <n> with changed credentials; server-wide settings: <n> changed.
```

`modified in place` counts personas with an in-place setting changed, or with
a next-launch setting changed on the persona's own entry. A persona that only
inherits a changed top-level default isn't counted there; the setting counts
under `server-wide settings`. A persona with both an in-place change and
changed credentials counts in both.

**Line order and kinds.** After the header: removals, destructive modifies,
additions, other changed personas (in `config.json` order), then server-wide
settings.

| Line | Meaning |
|---|---|
| `DESTRUCTIVE: persona "<name>" (key=<key>) is removed: its live session will be destroyed (its instance is torn down).` | The persona is gone from `config.json`. Renaming a persona changes its key, so a rename shows as this line for the old name plus an `is added` line for the new one. |
| `DESTRUCTIVE: persona "<name>" (key=<key>) working_directory changed to "<path>": its live session will be destroyed, then it is brought up fresh.` | Its `credentials_file` or `working_directory` (compared by real path) changed, or its `name` changed without changing its key (`name changed`). Several are joined by ` and `, e.g. `credentials_file changed to "<path>" and working_directory changed to "<path>"`. The instance is replaced and loses its session history. |
| `persona "<name>" (key=<key>) is added: it will be brought up and launched.` | A new persona. |
| `persona "<name>" (key=<key>) is added but cannot come up: <cause>; <cause>.` | A new persona whose bring-up would fail now. The causes are the credentials and working-directory cause texts under [Persona diagnostic classes](#persona-diagnostic-classes) (for example `credentials file does not exist`, `credentials file is invalid: …`, `working directory does not exist`). Fix them before the change is applied. |
| `persona "<name>" (key=<key>): <settings> changed: applied in place immediately, instance kept.` | `<settings>` lists one or more of `channels` (a channel added or removed), `delivery` (a kept channel's mode), `permission_prompts`, `dm.enabled`, `dm.contact`. Reordering channels isn't a change. |
| `…: stop_hook_bootstrap changed: takes effect at its next launch, instance kept.` | The persona's own `stop_hook_bootstrap` changed. The running instance doesn't see it until it is launched again. |
| `…: claude_config_dir changed: takes effect at its next launch, which starts fresh (the conversation is not resumed), instance kept until then.` | The persona's own `claude_config_dir` changed (by real path). The running instance is kept; its next launch uses the new directory and starts a new conversation. With both settings changed, the line reads `claude_config_dir, stop_hook_bootstrap changed:` with this effect. |
| `…: credentials file "<path>" changed: a new connection opens, then the old one closes, instance kept.` | The credentials file's content changed at the same path, and the persona is up. The line names the persona and the path, never a token. |
| `…: credentials file "<path>" changed: it has no connection yet, so it retries with the new content, instance kept.` | The same, for a persona still retrying its bring-up (Slack unreachable, or its working directory unusable). |
| `…: credentials file "<path>" changed: it is broken by its credentials now, so it will be brought up.` | The same, for a persona that is broken by its credentials: its credentials file is missing, unreadable or invalid, or Slack refused its tokens ([`persona-credentials-refused`](#persona-credentials-refused)). |
| `…: credentials file "<path>" changed, but it cannot be used (<cause>): the current connection is kept, instance kept.` | The new content is missing, unreadable or invalid; `<cause>` is the credentials cause text, for example `credentials file does not exist` (never file content). The persona is up and keeps its current connection. A restart reads the file as it stands, so the persona would then be `broken`: fix the file. |
| `…: credentials file "<path>" changed, but it cannot be used (<cause>): it has no connection yet, so it retries with the new content, instance kept.` | The same bad content, for a retrying persona. |
| `…: credentials file "<path>" changed, but it cannot be used (<cause>): it stays broken by its credentials.` | The same bad content, for a persona broken by its credentials. It stays broken until the file is fixed. |
| `persona "<name>" (key=<key>) is added; whether it can come up could not be checked.` | A new persona whose credentials and working directory the check couldn't examine (see the `cannot check` line below). It isn't counted differently in the header. |
| `…: credentials file "<path>" changed; whether it is broken by its credentials now could not be checked.` | A credentials change whose persona's bring-up state couldn't be read (see the `cannot check` line below). With bad content it starts `credentials file "<path>" changed, but it cannot be used (<cause>);`. |
| `server-wide setting <name> changed: once applied, it is recorded and takes effect at the next server start after that.` | A top-level setting such as `port` or `bind`. |
| `server-wide setting <name> changed: inherited by "<name>" (key=<key>), …; takes effect at each one's next launch, instance kept.` | The top-level `stop_hook_bootstrap` changed; the listed personas take the default and are affected. |
| `server-wide setting claude_config_dir changed: inherited by "<name>" (key=<key>), …; takes effect at each one's next launch, which starts fresh (the conversation is not resumed), instance kept until then.` | The top-level `claude_config_dir` changed; each listed persona's next launch starts a new conversation. |
| `server-wide setting <name> changed: once applied, it is recorded; no persona inherits it, so no instance is affected.` | The top-level `claude_config_dir` or `stop_hook_bootstrap` changed, but every persona sets its own value. |

One persona's effects share one line, joined by `; `, for example
`persona "bravo" (key=bravo): channels changed: applied in place immediately, instance kept; credentials file "<path>" changed: a new connection opens, then the old one closes, instance kept.`

**Invalid.** When the edit can't be applied, the preview is one line and
nothing else, and [`reload-invalid`](#reload-invalid) is logged:

```text
INVALID: <error> Nothing will be applied.
```

The error is a message from [Configuration rejections](#configuration-rejections),
or `the configuration file "<path>" does not exist.`,
`the configuration file "<path>" cannot be read (<errno>).` or
`the configuration file "<path>" is larger than the 64 KiB limit.`

**No effective change.** The bytes differ but nothing would change, for
example a whitespace or key-order edit, or a setting written out with its
default value:

```text
A configuration change is pending; nothing has been applied. no effective change: applying it would change no persona and no server-wide setting.
```

**Logged once.** The same preview goes to `server.log` under
[`reload-preview`](#reload-preview) (or `reload-invalid`), once each time the
change differs from the one last logged, not at every check. The file can be
rewritten without a new log line: if an added persona's directory is created
later, its line in the file changes, but the log keeps the old one. The file
is the current preview.

If the check can't gather a fact the preview needs, it logs one line, and the
preview says that fact `could not be checked` instead of guessing:
`[slack] reload: cannot check <what>: <error>; the preview says it could not be checked`.
`<what>` is `whether the added persona "<name>" (key=<key>) can come up` or
`the bring-up state of persona "<name>" (key=<key>)`. The line is logged once, and again
only after a check that gathered every fact. It is an internal error: report
it as a bug.

**Withdrawing a change.** Revert the edit so the file matches what is applied
byte for byte (whitespace counts); for a credentials file, put back the
content it had. With the operator's say-so, the applied `config.json` can be
restored from the record, which discards every unapplied edit:

```sh
cp "$STATE/config.json.last-applied" "$STATE/config.json"
```

Within about 5 s the server deletes `config.json.pending` and logs
[`reload-nothing-pending`](#reload-nothing-pending) once.

### Confirming a pending change

A running server applies a `config.json` edit only when its preview is
confirmed: with the operator's say-so, rename `config.json.pending` to
`config.json.apply` in the same state directory. The operator may do the
rename, or direct an agent (such as a Claude session running this skill) to
do it. No CLI subcommand, MCP tool or HTTP endpoint applies a change, by
design; saving, restarting and rebooting apply nothing.

1. Read the preview and diff `config.json` against the record (see
   [Pending changes](#pending-changes)). The confirmation applies every edit
   in `config.json`, not just the one you meant, and the preview lists them
   all. If it reads `INVALID`, fix `config.json` first.
2. Finish editing, and don't save `config.json` or a credentials file it
   references again until the change is applied: any save after the preview
   was written makes the confirmation stale.
3. With the operator's say-so, rename the preview:

   ```sh
   STATE="${SLACK_STATE_DIR:-$HOME/.claude/channels/slack}"
   mv "$STATE/config.json.pending" "$STATE/config.json.apply"
   ```

4. Within about 5 s the next check reads the confirmation and deletes it, so
   it is used once. If its fingerprint still describes `config.json` and the
   credentials files, the change is applied: the record is rewritten with
   `config.json`'s bytes first, then removed personas are torn down, changed
   routing settings are updated in place and added personas are brought up.
   Otherwise nothing is applied and
   [`reload-stale-confirmation`](#reload-stale-confirmation) is logged.
5. Watch `server.log` for the outcome:

   ```sh
   grep -h -E 'reload-(applied|noop|invalid|stale-confirmation|record-write-failed)|reload: ' "$STATE"/server.log | tail
   ```

   [`reload-applied`](#reload-applied) (or [`reload-noop`](#reload-noop))
   is logged once every teardown and bring-up has settled, possibly minutes
   later; a persona that is `retrying` at that point isn't up yet. See
   [I confirmed but nothing happened](#i-confirmed-but-nothing-happened) for
   every other outcome.

What changes at once, with no restart:

- **Added and removed personas** (a rename is one of each), the preview's
  `is added` and `is removed` lines. See
  [A persona was added or removed by a confirmed change](#a-persona-was-added-or-removed-by-a-confirmed-change).
- **A kept persona's routing settings**, the preview's `… changed: applied in
  place immediately, instance kept` lines: `channels`, a channel's
  `delivery`, `permission_prompts` and `dm.*`. See
  [A persona's routing settings were changed by a confirmed change](#a-personas-routing-settings-were-changed-by-a-confirmed-change).

Everything else in the change is recorded, and a later start carries it out
(see [What a confirmation doesn't apply yet](#what-a-confirmation-doesnt-apply-yet)).
Never delete the record to apply an edit: the confirmation has already
written the change into it. Deleting the record is only for a server that
can't start (see [Starting without the record](#starting-without-the-record)).

### What a confirmation doesn't apply yet

A confirmation records these changes in `config.json.last-applied`, but the
running server doesn't carry them out. Until the next start (or launch), the
persona keeps running as it was launched: same instance, same directory, same
Slack connection. One exception to "as it was": after a confirmed
`working_directory` change, MCP admission matches the new directory. If the
running bot's MCP session re-registers from the old directory, it is refused
(no matching persona) and the bot goes silent; if its session disconnects,
the restart path relaunches it fresh in the new directory, without its
conversation. So restart promptly after `reload-applied`.

| Preview line | After the confirmation | To carry it out |
|---|---|---|
| `DESTRUCTIVE: … changed to "<path>" …` or `… name changed …` (a kept persona's `credentials_file`, `working_directory` or `name`) | Recorded. The persona isn't torn down or brought up again. | Restart: at the start, a persona whose `working_directory` changed has its instance killed by the start sweep and comes up fresh in the new directory, without its session history; a changed `credentials_file` only reconnects the persona to Slack with the new app, and its instance keeps running. |
| `credentials file "<path>" changed …` | Not applied: the persona keeps its current connection, and the credentials change stays pending in `config.json.pending`. | Restart: every start reads credentials files as they stand. No confirmation is needed for it. |
| `stop_hook_bootstrap changed` or `claude_config_dir changed` (`takes effect at its next launch`, or a top-level setting `inherited by …`) | Recorded. It reaches each persona at its next launch. | Relaunch the bots: `claude-slack-channel-bots clean_restart`, or `stop --stop-bots` then `start`. Both cut off the bots' current turns. A plain restart reconnects running bots, which is not a launch. |
| `server-wide setting <name> changed: once applied, it is recorded and takes effect at the next server start after that.` | Recorded. | Restart. |

Wait for `reload-applied`, then, with the operator's say-so, run
`claude-slack-channel-bots clean_restart`. It covers every row above: the
server comes back on the record and every bot is relaunched, resuming its
conversation except where a changed `working_directory` or
`claude_config_dir` starts it fresh. When no next-launch setting changed,
`claude-slack-channel-bots stop && claude-slack-channel-bots start` is
enough, and bots whose declaration didn't change keep running undisturbed.
The record already holds
the change, so don't delete it.

A persona added by a confirmation, or an existing one relaunched (crash
auto-restart or health check) after a confirmed `claude_config_dir` change,
whose effective `claude_config_dir` (its own, else the top-level one, else
`~/.claude`) no persona used at the last server start launches from an agent-director template without the rule that lets
it read its memory notes, so each read of its memory notes asks for
permission until the next server start refreshes the template.

### I confirmed but nothing happened

Look in `server.log` for the lines logged after the rename (the `grep` in
[Confirming a pending change](#confirming-a-pending-change)):

| Line | Meaning |
|---|---|
| [`reload-applied`](#reload-applied) | The change was applied. Personas added, removed or changed in place are handled; the rest is recorded (see [What a confirmation doesn't apply yet](#what-a-confirmation-doesnt-apply-yet)). A persona that isn't up has its own class line. |
| [`reload-noop`](#reload-noop) | The change had no effect (whitespace, key order, a default written out); the record now matches `config.json`. Nothing else happens. |
| [`reload-invalid`](#reload-invalid), `the confirmed configuration is invalid, so nothing is applied` | `config.json` was invalid. Nothing is applied and the confirmation is used up. Fix the file, then confirm the new preview. |
| [`reload-stale-confirmation`](#reload-stale-confirmation) | The confirmation didn't match the files as they stand, or couldn't be read. Nothing is applied. |
| [`reload-record-write-failed`](#reload-record-write-failed), `the confirmed change is not applied and stays pending` | The record couldn't be written. Nothing is applied; fix the state directory, then confirm again. |
| `[slack] reload: cannot remove the confirmation "<apply path>" (<errno>); it was acted on once and is ignored until its content changes` | The confirmation was acted on once (one of the lines above), but the server couldn't delete it. It is ignored while its content stays the same. Fix the directory's permissions (or the read-only filesystem), then remove `config.json.apply` by hand. |
| `[slack] reload: apply step <n> (<step>) failed …` or `[slack] reload: updating the server's applied configuration failed: <error>` | An internal error during the apply. Report it as a bug, with the lines around it. |

No line at all:

- **`config.json.apply` is still there.** The server isn't running, its
  first check after a start hasn't run yet (checks begin once the start's
  bring-up is done), or the file is in a different state directory from the
  server's (see [The server log](#the-server-log)). A confirmation left while
  the server is stopped is processed by the first check after the next start.
- **An earlier confirmed change is still settling.** The next check waits
  for every teardown and bring-up of it, which can take minutes (see
  [A persona was added or removed by a confirmed change](#a-persona-was-added-or-removed-by-a-confirmed-change)).
- **The file is gone and nothing new was logged.** It was a confirmation
  already acted on that couldn't be deleted (an earlier `cannot remove the
  confirmation` line): the server deletes it silently at a later check, once
  it can. Or it was removed by hand.

### Starting without the record

Only for a server that can't start: the record can't be read or is invalid
(see [The last-applied record can't be read or is invalid](#the-last-applied-record-cant-be-read-or-is-invalid)),
or a first start failed after writing the record (see
[A first start that fails after recording](#a-first-start-that-fails-after-recording)).
A start without a record checks `config.json` as it stands, records it and
applies it, with no preview and no confirmation.

Read `config.json` first: the start applies every edit in it that was never
applied. Compared with a confirmation:

- A persona that was removed or renamed (a mistyped name counts: the name
  sets the key) has its running instance killed by the start sweep. A renamed
  persona comes up fresh under its new key, without its session history.
- A persona whose `working_directory` changed has its running instance killed
  by the start sweep too, and comes up fresh in the new directory.
- A changed `credentials_file` only reconnects the persona to Slack with the
  new app; its instance keeps running.
- A setting that takes effect at a bot's launch (`stop_hook_bootstrap`, a
  changed `claude_config_dir`) doesn't reach a bot that kept running. If the
  server is still running, stop it with `stop --stop-bots` instead of `stop`.

With the operator's say-so, stop the server if it is still running, keep a
copy of the record if it can be read, delete it and start. Keep the `.bak`
copy until the new configuration runs as intended:

```sh
STATE="${SLACK_STATE_DIR:-$HOME/.claude/channels/slack}"
claude-slack-channel-bots stop --stop-bots
cp "$STATE/config.json.last-applied" "$STATE/config.json.last-applied.bak"
diff "$STATE/config.json.last-applied.bak" "$STATE/config.json"
rm "$STATE/config.json.last-applied" &&
  claude-slack-channel-bots start
```

The configuration holds no tokens; if a value in the diff starts with
`xoxb-` or `xapp-`, follow [Constraints](#constraints). If `config.json` is
invalid, the start is refused (see
[Configuration rejections](#configuration-rejections)), nothing runs and no
record is written. Fix `config.json` and start again, or restore the copy as
`config.json.last-applied` to run the previous configuration.

### A first start that fails after recording

A start without a record writes `config.json.last-applied` before the server
binds its port. If that start then fails, the record stays, and every later
start runs it. The usual case is the first start, or the first after the
record was deleted, failing on the listening address:

- **Line:** `start` prints its `Server failed to start` block after the
  `No last-applied record: recorded the configuration file …` line, and the
  failure is a `[slack] Fatal:` line with the error from binding
  `bind`:`port` (for example, the port is already in use).
- **Trap:** Fixing `bind` or `port` in `config.json` and starting again
  changes nothing: the next start runs the record, which holds the failing
  values, and fails the same way.
- **Fix:** If the cause is outside the file (another process holds the port),
  free it and start again. If the fix is an edit of `config.json`, apply it
  with [Starting without the record](#starting-without-the-record): delete
  the record and start, so the start checks, records and applies the fixed
  file.

### `reload-record-write-failed`

The server couldn't write `config.json.last-applied` durably. It happens in
two places: at a start without a record, and when a running server applies a
confirmed change. The `(<errno>)` part appears only when the error has a
code.

**At a start without a record.**

- **Line:** one of:
  - `[slack] reload-record-write-failed: cannot write the last-applied record "<record path>" (<errno>); the server does not start and nothing is applied`:
    the record wasn't written, and there is still no record.
  - `[slack] reload-record-write-failed: the last-applied record "<record path>" was written but its directory could not be synced (<errno>), so it may not survive a crash, and the next start will run it; the server does not start`:
    the record is in place, but the state directory couldn't be synced, so it
    may be lost in a crash or power loss.
- **When:** `config.json` was valid, but the server couldn't write the record
  beside it durably.
- **Effect:** The server exits 1. No persona is brought up and nothing is
  applied. `start` shows the line in its `Server failed to start` block. After
  the second line, the next start runs the record that was written (a copy of
  `config.json` at that start), unless a crash lost it.
- **Fix:** Fix the cause below, then start the server again.

**At a confirmed apply.** A running server acting on a confirmation
(`config.json.apply`) writes the record first, before it changes anything
else.

- **Line:** one of:
  - `[slack] reload-record-write-failed: cannot write the last-applied record "<record path>" (<errno>); the confirmed change is not applied and stays pending`:
    the old record is unchanged.
  - `[slack] reload-record-write-failed: wrote the last-applied record "<record path>" but could not sync its directory (<errno>); the previous record was written back; the confirmed change is not applied and stays pending`:
    the new record was put back to the old one. Instead of
    `the previous record was written back`, the middle part can read
    `the previous record was written back, though its directory could not be synced either`,
    or
    `writing the previous record back failed too (<errno>), so the next start may run the unapplied change`:
    then the record may hold the unapplied change, and the next start would
    run it.
- **Effect:** Nothing is applied. The server keeps running what it ran, the
  change stays pending, and within about 5 s `config.json.pending` is written
  again. The confirmation was used up: it isn't acted on again.
- **Fix:** Fix the cause below. Then read the new `config.json.pending`
  (see [Pending changes](#pending-changes)) and confirm it again (see
  [Confirming a pending change](#confirming-a-pending-change)). If the line
  says writing the previous record back failed too, compare the record with
  `config.json` before any restart: the next start runs the record.

**Cause (both).** Usually the state directory: the server's user can't create
or rename files in it (`EACCES`, `EPERM`), the disk or quota is full
(`ENOSPC`, `EDQUOT`), or the filesystem is read-only (`EROFS`). A directory
that can't be synced usually points at the filesystem (an I/O error, `EIO`,
or a filesystem that doesn't support syncing a directory).

### `reload-nothing-pending`

- **Line:** one of two variants:
  - `[slack] reload-nothing-pending: the configuration file and the credentials files it references match what is applied; no change is pending, and the pending-change file "<pending path>" is removed`,
    when that check removed `config.json.pending`;
  - `[slack] reload-nothing-pending: the configuration file and the credentials files it references match what is applied; no change is pending`,
    when there was no `config.json.pending` to remove (for example it was
    deleted by hand, or never written).
- **When:** once, when the state changes to nothing waiting, not at every
  check. It is logged only after `config.json.pending` is gone. Two cases:
  - an edit of `config.json` or of a credentials file was reverted, so the
    files match what is applied again;
  - the first check after a start removed a `config.json.pending` left over
    from before, which the start made obsolete: the start applied the
    waiting edit (the record was deleted, as under
    [Starting without the record](#starting-without-the-record)), applied a
    changed credentials file, or `config.json` was put back while the server
    was stopped.
- It is never logged at a clean start, where nothing was waiting and no
  leftover file was found. After a start, it is logged only if the first
  check actually removed a leftover file.
- **Meaning:** Nothing is waiting to be applied. The server runs what it
  applied, and `config.json` and the credentials files match it.
- **Fix:** None. It is informational. If the removal failed, a plain
  `[slack] reload: cannot remove the pending-change file …` line comes
  first, and this line follows once a later check removes the file. If the
  file was removed but its directory could not be synced, the
  `[slack] reload: removed the pending-change file … but could not sync its directory …`
  line comes first and this line follows at once.

### `reload-preview`

- **Line:** every line of the preview in `config.json.pending`, each as
  `[slack] reload-preview: <preview line>`. The first is the header, and it
  ends with where the preview is written:

  ```text
  [slack] reload-preview: A configuration change is pending; nothing has been applied. personas: 0 added, 1 removed, 0 destructively modified, 0 modified in place, 0 with changed credentials; server-wide settings: 0 changed. (preview in "<pending path>")
  [slack] reload-preview: DESTRUCTIVE: persona "<name>" (key=<key>) is removed: its live session will be destroyed (its instance is torn down).
  ```

  The ` (preview in "<pending path>")` part is missing when the pending file
  couldn't be written (a plain `[slack] reload: cannot write the pending-change file …`
  line says why).
- **When:** once each time the pending change differs from the one last
  logged: an edit made, changed again, or a credentials file re-saved with
  new content. Also once at the first check after each start while a change
  is still pending. Not at every check, and not when the file is only
  rewritten.
- **Meaning:** Informational. `config.json`, or a credentials file it
  references, differs from what is applied, and the edit is valid. Nothing
  has been applied. Each line is explained under
  [Pending changes](#pending-changes).
- **Fix:** Review the preview (the file is the current one). To withdraw the
  change, revert the edit (see [Pending changes](#pending-changes)). To apply
  a `config.json` edit, see
  [Confirming a pending change](#confirming-a-pending-change).

### `reload-invalid`

- **Line:** one line, with the full error:

  ```text
  [slack] reload-invalid: the pending configuration is invalid and nothing will be applied: <error> (preview in "<pending path>")
  ```

  For example
  `… nothing will be applied: loadPersonaConfig: malformed JSON in "<config path>" at line 1, column 17. (preview in "<pending path>")`.
  The ` (preview in "<pending path>")` part is missing when the pending file
  couldn't be written. `config.json.pending` holds the one line
  `INVALID: <error> Nothing will be applied.`
- **When:** a running server's check, once each time the pending change
  differs from the one last logged, and once at the first check after each
  start while it is still pending. An invalid candidate logs only this line,
  never `reload-preview`.
- **Confirmed variant:** when a confirmation (`config.json.apply`) matched an
  invalid candidate, the line is instead:

  ```text
  [slack] reload-invalid: the confirmed configuration is invalid, so nothing is applied: <error>
  ```

  For example
  `… so nothing is applied: loadPersonaConfig: malformed JSON in "<config path>" at line 3, column 5.`
  Normally a candidate gets two lines: the pending-time line when its
  `INVALID` preview is written, then this one when the confirmation is
  processed. When the confirmation is already there on the pass that first
  sees the candidate (for example the first check after a start), only this
  line is logged.
- **Cause:** the edited `config.json` fails to parse or validate (the
  `<error>` is a message from
  [Configuration rejections](#configuration-rejections); an unknown key whose
  name could be a pasted token is counted, not shown), or `config.json` is
  missing, can't be read or is too large while a record exists:
  `the configuration file "<config path>" does not exist.`,
  `the configuration file "<config path>" cannot be read (<errno>).` or
  `the configuration file "<config path>" is larger than the 64 KiB limit.`
  To the reload check, a file over 64 KiB counts as unreadable and is never
  read in full. (Only the file-send guard reads `config.json` whole, so a
  credentials path named in an oversized file stays protected.)
- **Effect:** Nothing is applied. The server keeps running the last-applied
  record. A confirmation of an invalid candidate is used up: it applies
  nothing, and it isn't acted on again.
- **Fix:** Correct `config.json` at the position or rule the error names, or
  restore it (see withdrawing under [Pending changes](#pending-changes)).
  Within about 5 s the check writes the new preview, or removes the pending
  file and logs `reload-nothing-pending` if the file matches what is applied.
  After the confirmed variant, the old confirmation can't be reused: read the
  new `config.json.pending` once the fix is in, then confirm it (see
  [Confirming a pending change](#confirming-a-pending-change)).

### `reload-applied`

- **Line:**

  ```text
  [slack] reload-applied: applied the confirmed configuration change without a restart (personas: 0 added, 1 removed, 0 destructively modified, 0 modified in place, 0 with changed credentials; server-wide settings: 0 changed); the last-applied record "<record path>" now holds it
  ```

  The counts are the ones in the preview's header.
- **When:** a running server's check found a confirmation
  (`config.json.apply`) whose fingerprint matched the pending change, and the
  change was valid and had an effect. The confirmation is deleted first, so
  it is used once.
- **Meaning:** `config.json.last-applied` now holds the confirmed
  `config.json`, byte for byte, and the server runs its persona set. Every
  later start runs it too. A changed server-wide setting is recorded and takes
  effect at the next start, as its preview line says.
- **What happens to personas now:** the apply switches the persona set the
  server runs at once. Message routing, the up check, the notifier and the
  permission poller read that set at each use. Then:
  - a removed persona (or the old key of a renamed one) is torn down: its
    Slack connection is closed, its instance killed and its agent-director
    row deleted, so its conversation can't be resumed; its permission
    prompts stay in Slack as posted, and clicking one does nothing (see
    [A persona was added or removed by a confirmed change](#a-persona-was-added-or-removed-by-a-confirmed-change)).
    In the moment before its teardown it is already out of service:
    - each event it receives is dropped, with
      `[slack] persona-routing: no applied persona with key=<key> — event not delivered to it`;
    - `/interject` for it returns 404 (`Persona not found in the applied config`);
    - a new MCP session from its working directory matches no persona and
      is disconnected (`Session connected with CWD "<path>" — no matching persona`);
    - an MCP session of it that is still registered stays connected, but
      each tool call it makes fails with
      `Tool "<name>" refused: persona key=<key> is not an applied persona.`;
    - the permission poller skips its spawn
      (`spawn <id> names no applied persona (persona=<key>) — skipping`), and
      a notice for it is dropped
      (`persona-notifier: no applied persona with key=<key> — notice dropped`);
    - it is never restarted or relaunched again;
  - a kept persona's `channels` (each entry's `delivery` included), `dm.*`
    and `permission_prompts`
    take effect at once, for the next message, notice or prompt;
  - a kept persona's `working_directory`, `stop_hook_bootstrap` or
    `claude_config_dir` change takes effect at its next relaunch (a restart
    after its session ends), which launches the new declaration; until then
    its instance runs as launched;
  - an added persona is brought up and launched, as at a start (its
    `persona-start` line, then `up at apply — launching` or a class line);
  - a kept persona's `credentials_file` path change is only recorded: its
    connection keeps running as it is until a restart reconnects it;
  - a persona with changed credentials keeps its current connection, and the
    credentials change stays pending (see
    [Pending changes](#pending-changes)).

  The next start runs the new record and carries out what the
  confirmation left to it (see
  [What a confirmation doesn't apply yet](#what-a-confirmation-doesnt-apply-yet)); the record already holds the change, so don't delete it.
- **Fix:** None. If `config.json.pending` is written again after this line,
  something is still pending: see [Pending changes](#pending-changes). With
  nothing left pending, no `reload-nothing-pending` line follows; this line
  says what happened.

### `reload-noop`

- **Line:**

  ```text
  [slack] reload-noop: the confirmed configuration has no effective change, so no persona and no server-wide setting changed; the last-applied record "<record path>" was rewritten with it
  ```

- **When:** a confirmation (`config.json.apply`) matched a pending change
  whose preview said `no effective change`: `config.json`'s bytes differ from
  the record's, but nothing they configure does. A whitespace or key-order
  edit, or a setting written out with its default value, does this.
- **Meaning:** The record was rewritten with `config.json`'s bytes, so the two
  match again and nothing is pending. No persona, instance or setting changed.
- **Fix:** None.

### `reload-stale-confirmation`

- **Line:**
  `[slack] reload-stale-confirmation: the confirmation "<apply path>" <reason>; nothing is applied`,
  where `<reason>` is one of:
  - `does not match the configuration as it stands (the configuration file or a credentials file it references changed after that preview was written)`;
  - `cannot be read (<errno>)` (for example `EISDIR`, a directory),
    `cannot be read (not a regular file)` (a FIFO, socket or device, never
    read), or `is larger than the 64 KiB limit`;
  - `holds no well-formed fingerprint (it is not a pending-change file as the server writes it)`.
- **When:** a running server's check found `config.json.apply` beside
  `config.json`, including one left there while the server was stopped (the
  first check after the start processes it). The line never shows the file's
  content.
- **Cause:** The confirmation's content no longer matches `config.json` and
  the credentials files it references as they stand. A confirmation carries
  the fingerprint line of the `config.json.pending` it was made from, and it
  applies only while that still describes the files. The usual reasons:
  - **An edit saved after the preview was written.** `config.json`, or a
    credentials file it references, was saved again between the preview and
    the rename, even with a change that was meant to go along with it.
  - **A half-written save.** The check read `config.json` while an editor or
    script was still writing it, wrote a preview of the partial file, and the
    finished save no longer matches.
  - **An older copy renamed.** The renamed file was an earlier
    `config.json.pending` (a copy kept aside, or one from before a later
    edit). A copy whose change was already applied still matches while the
    files are unchanged: it logs `reload-noop`, not this line.
  - **A hand-made or hand-edited confirmation.** A file written by hand, or a
    preview edited or damaged, holds no well-formed fingerprint. One that is
    a directory, a FIFO, socket or device, or over 64 KiB can't be read.
- **Effect:** Nothing is applied. The confirmation is deleted, and the line is
  logged once; the confirmation isn't acted on again. A change that is still
  pending keeps its current preview in `config.json.pending`, which the check
  writes again if it is missing.
- **Fix:** Finish editing, wait about 5 s for `config.json.pending` to
  refresh, read the new preview (see [Pending changes](#pending-changes)) and
  rename it again (see
  [Confirming a pending change](#confirming-a-pending-change)). Never write
  or edit a confirmation: only the server's current `config.json.pending`
  applies, renamed (a byte-for-byte copy also matches, but the rename is the
  supported way). A confirmation is used once. After an edit
  is reverted and redone, rename the new `config.json.pending`, even if it
  reads the same as one renamed before.
- **`is larger than the 64 KiB limit` on a fresh rename:** the server's own
  `config.json.pending` can exceed the cap for a very large single change
  (hundreds of personas renamed or credentials files changed at once), even
  while `config.json` is under it. The check then rewrites the pending file
  at every tick and can never apply it. Split the change into smaller
  `config.json` edits and confirm each one in turn.
- **A confirmation that can't be removed:** any confirmation, matched or not,
  is deleted before it is acted on. If that fails, the plain line
  `[slack] reload: cannot remove the confirmation "<apply path>" (<errno>); it was acted on once and is ignored until its content changes`
  is logged just before the line that says how it was acted on. The server retries the delete silently at each check and ignores
  the file while its content stays the same. Remove it by hand once its
  directory is fixed (permissions, or a read-only filesystem). If it was
  removed but its directory couldn't be synced, the line is
  `[slack] reload: removed the confirmation "<apply path>" but could not sync its directory (<errno>); it may reappear after a crash`.

### The last-applied record can't be read or is invalid

- **Line:** `[slack] Fatal: last-applied record error — <cause> Deleting the last-applied record "<record path>" makes the next start apply the configuration file "<config path>" as it stands.`
  It carries no class label.
- **Cause:** one of:
  - `The last-applied record "<record path>" cannot be read (<errno>).`: the
    record exists but the server's user can't read it (permissions, or the path
    is a directory, `EISDIR`); `(not a regular file)` means the path is a FIFO,
    socket or device, which is never read;
  - `The last-applied record "<record path>" is larger than the 64 KiB limit.`:
    the record is over 64 KiB, so it was damaged or replaced;
  - `loadPersonaConfig: malformed JSON in "<record path>" at line <L>, column <C>.`:
    the record isn't valid JSON (it was edited or damaged);
  - `loadPersonaConfig: invalid persona config in "<record path>": <message>`:
    the record breaks a rule. The messages are the ones under
    [Configuration rejections](#configuration-rejections), except the two
    shared-path rules, which a record start leaves to the bring-up.
- **Effect:** The server exits 1 and doesn't fall back to `config.json`.
  Until the record is fixed or deleted, `clean_restart` fails with
  `[slack] clean_restart: failed to load config:`, and `stop --stop-bots`
  logs `could not load config — skipping bot teardown` and stops only the
  server. `stop` logs one line saying it could not load the applied
  configuration, and uses a 30 s `stop_timeout`.
- **Fix:** If it can't be read, make it a readable file and start again; the
  record is kept. Otherwise, with the operator's say-so, delete the record and
  start, as under [Starting without the record](#starting-without-the-record).
- **Warning:** Deleting the record makes the next start run whatever is in
  `config.json` now, including any edit that was never applied. Read
  `config.json` before deleting the record.

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
| No row | `persona teardown of … complete` | The persona was removed by a confirmed change; its instance was destroyed. Expected. |
| A row | `persona teardown of …: agent-director delete of cscb_<key> failed` | The teardown couldn't delete it. The next server start removes it. |

`tmux has-session -t slack_bot_<key>` confirms whether the instance's tmux
session exists.

