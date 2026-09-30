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
   [Other lines you may see](#other-lines-you-may-see)). Two personas posting
   *Message lost* notices about each other: see
   [Two personas post lost-message notices about each other](#two-personas-post-lost-message-notices-about-each-other).
   A quick delivery check when `ack_reaction` is set: the persona adds that
   reaction under its own name once a message reaches its instance, and
   removes it with its first reply to that message. A Slack message with neither the persona's
   reaction nor its reply was most likely not dispatched to it. Adding the
   reaction can fail without a log line, so treat this as a hint and confirm
   in `server.log`.
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
   name. An agent-director binary refused as too old or below CSCB's Phase 1
   floor is covered under
   [The server refuses the agent-director binary at start](#the-server-refuses-the-agent-director-binary-at-start);
   for a missing or unreachable agent-director, the `install-cscb` skill
   covers installing it.
   **The server was running and has stopped?** Read the latest lines of
   `startup-errors.log`. One that says `found by a runtime re-check while the
   server was running` is covered under
   [Found while the server was running](#found-while-the-server-was-running).
5. **No class line, but the persona still isn't served?** See
   [A persona is down but its instance is still running](#a-persona-is-down-but-its-instance-is-still-running)
   and [Other lines you may see](#other-lines-you-may-see). A *Waiting on a
   prompt*, *Not connected* or *Not receiving messages* notice at its
   destination, or a row that reads `working` while the instance sits idle,
   is covered under
   [A persona's instance runs but isn't connected](#a-personas-instance-runs-but-isnt-connected).
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
9. **A persona was just added, removed or destructively modified by a confirmed change?** See
   [A persona was added or removed by a confirmed change](#a-persona-was-added-or-removed-by-a-confirmed-change).
   Its channels, destination or DM settings were changed? See
   [A persona's routing settings were changed by a confirmed change](#a-personas-routing-settings-were-changed-by-a-confirmed-change).
   A confirmed change to its credentials file didn't take? Look for a
   [`persona-credentials-change-failed`](#persona-credentials-change-failed)
   line. A persona broken by its credentials whose app was fixed on Slack's
   side, with nothing pending? See
   [Fixed on Slack's side, same tokens](#fixed-on-slacks-side-same-tokens).

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
- **Error detail.** A failure on a Slack or agent-director path (a `<error>`
  in the lines below) shows the error's class, a code such as `ENOENT` or an
  agent-director error name such as `ErrSpawnNotFound`, the error's message
  as `message="…"`, and stack frames. The message is on one line, cut at 300
  characters (ending in `…`), with URLs shown as `<redacted-url>` and
  token-like text as `<redacted-token>`. For an agent-director error the
  message is agent-director's own description, in the same form, in
  `server.log` and in the `spawn-failed`, `orphan-cleanup…`,
  `jsonl-transcript-lost-on-resume` and `jsonl-diagnosis-inconclusive`
  records in `startup-errors.log`. The `Spawn failure:` notice at the
  persona's destination renders it differently, as
  ``Error: `<errName>` — <description>``: URLs and token-like text in the
  description are redacted as above and it is cut at 300 characters, but
  it is not quoted, not joined onto one line and gets no `…` mark. An error
  reading or parsing a credentials file is never quoted: its line states a
  fixed cause instead. The
  `stop --stop-bots` lines `agent-director initialization failed:` and
  `bot teardown failed:` print the startup gate's or the teardown's own
  message in full. The `[slack] Fatal:` line of a start that failed
  unexpectedly prints the raw error.
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
| `path="…"` | The file or directory the line is about: the credentials file for credentials and Slack classes, the working directory for directory classes, the Claude config directory for `persona-config-dir-unresolvable`. Absent on `persona-start`, `unclaimed-channel`, `persona-dm-dropped` and `persona-destination-failed`. |
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
| `broken` | Credentials missing, unreadable, invalid or refused by Slack | No: fix the credentials file, wait for the pending change and confirm it (see [Recovering a persona broken by its credentials](#recovering-a-persona-broken-by-its-credentials)); no restart |
| `retrying` | Slack unreachable, working directory missing or unusable, or `claude_config_dir` unresolvable | Yes, once the cause clears; no restart |

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
  and one for each persona a confirmed change adds or brings up again after
  a credentials change (a persona broken by its credentials, after
  `broken by its credentials and its credentials file changed — bringing it
  up again`), before any other line about that bring-up. It's the
  name-to-key map.
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
- **Fix:** Create the credentials file at that path, then confirm the
  pending change (see
  [Recovering a persona broken by its credentials](#recovering-a-persona-broken-by-its-credentials)).
  Or correct the persona's `credentials_file` in `config.json` and confirm
  the edit: the persona is torn down and brought up fresh with the new path,
  with no restart (see
  [Confirming a pending change](#confirming-a-pending-change)); a plain restart without the confirmation doesn't apply it.
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
  as (the file should be mode 0600, owned by that user). Then confirm the
  pending change (see
  [Recovering a persona broken by its credentials](#recovering-a-persona-broken-by-its-credentials)).
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
  file. See [A credentials file shared by two personas](#a-credentials-file-shared-by-two-personas)
  for the fix.
- **Fix:** The operator rewrites the file in the shape above (mode 0600), then
  confirms the pending change (see
  [Recovering a persona broken by its credentials](#recovering-a-persona-broken-by-its-credentials)).
  Use [Checking a credentials file's shape](#checking-a-credentials-files-shape) to
  confirm the fix without showing a token.
- **Added at runtime:** the same line, with the same fix, when a confirmed
  change adds this persona. Other personas are not affected.

### `persona-credentials-refused`

- **State:** `broken`. Doesn't recover on its own. Logged by the connection
  manager, with the credentials file as `path`.
- **Meaning:** Slack answered and refused a token. Three checks can refuse:
  - `bot_token refused by auth.test: Slack error <code>` (at bring-up)
  - `app_token refused by the Socket Mode open: Slack error <code>` (at
    bring-up, or when a running persona's connection is reopened)
  - `bot_token refused by a Web API call (<method>): Slack error <code>` (a
    running persona's call, such as `chat.postMessage`, was refused)
- **Codes:** for `auth.test` and the Socket Mode open, any Slack error except
  the five transient ones listed under `persona-slack-unreachable`. The
  expected ones are `not_authed`, `invalid_auth`, `account_inactive`,
  `token_revoked`, `token_expired` and `not_allowed_token_type`. For a Web API
  call, only `invalid_auth`, `token_revoked`, `account_inactive` and
  `not_authed`.
- **Fix:** Get a working token from the persona's Slack app and have the
  operator write it into the credentials file, in their own terminal, with
  `claude-slack-channel-bots credentials <persona>` (it asks for both tokens
  without echo and validates them with Slack first): for `bot_token`, the app's Bot
  User OAuth Token (re-install the app to the workspace if it was uninstalled
  or its token revoked); for `app_token`, an app-level token with the
  `connections:write` scope, with Socket Mode turned on. Then confirm the
  pending change (see
  [Recovering a persona broken by its credentials](#recovering-a-persona-broken-by-its-credentials)).
  If the fix was made on Slack's side and the tokens didn't change (the app
  re-installed or re-enabled), nothing is pending: see
  [Fixed on Slack's side, same tokens](#fixed-on-slacks-side-same-tokens).
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
- **Error message:** when the failure carried one, the line that starts the
  episode ends with it after the cause, as `message="…"`, for example
  `network or request error message="A request error occurred: connect ECONNREFUSED …"`.
  It is redacted as on every other line that carries an error's message:
  URL-like text reads `<redacted-url>` and token-like text `<redacted-token>`,
  on one line, cut at 300 characters. The two 10 s timeouts, a socket closed
  before hello and a missing bot ID carry none, nor does the cleared line.
  Read it for the reason behind `network or request error` or
  `unrecognised failure` (DNS, a refused connection, a proxy).
- **Logged:** once when it starts, and once when it clears with the cause
  `cleared: Slack answered after being unreachable checking <key> via <check>`.
  Nothing per attempt. A hold for the persona's config directory ends it
  instead with the cause
  `cleared: the persona's Slack connection was closed while its claude_config_dir cannot be resolved`
  (see [`persona-config-dir-unresolvable`](#persona-config-dir-unresolvable)).
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
- **Flapping:** lost and restored lines that keep repeating, minutes apart or
  closer, are not Slack's routine refresh. The connection between the host and
  Slack is unstable (a proxy, firewall or NAT closing idle or long-lived
  connections, or a flaky network). The persona stays `up` and each reopen
  succeeds, but it hears nothing from Slack during each gap, so messages may
  arrive late or be missed. Check the host's network and proxy path to Slack.
- **Worth a look:** a lost line with no restored line for a long time (a
  network outage: the reopen keeps retrying, logging nothing more), or a lost
  line followed by `persona-credentials-refused` (see
  [A token was revoked while the persona was running](#a-token-was-revoked-while-the-persona-was-running)).
- **Other ends:** a lost line closed by one with the cause
  `cleared: the persona's Slack connection was closed while its claude_config_dir cannot be resolved`
  means the persona was held for its config directory; see
  [`persona-config-dir-unresolvable`](#persona-config-dir-unresolvable). A
  persona removed by a confirmed change, or a server shutdown, closes the
  connection with no further line, so a lost line then has no end.
- **Library reason:** shortly before the lost line there may be a
  `[slack] persona Socket Mode: personas[<i>] "<name>" (key=<key>): …` line
  from the Slack library, giving its reason:
  `A ping wasn't received from the server before the timeout of <n>ms!` (Slack
  sent no ping in time) or
  `A pong wasn't received from the server before the timeout of <n>ms!` (Slack
  didn't answer the client's pings). Either way the connection was judged dead,
  closed, and is reopened as above. `Failed to send ping to Slack` means the
  client couldn't send its ping (the error detail is not logged). An occasional
  one is harmless; frequent ones point at the network path to Slack or at
  Slack itself. The library's other output is deliberately not logged, since
  it can hold the connection's URL and ticket; the server logs connection
  failures itself.

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
  Or correct `working_directory` in `config.json` and confirm the edit: the
  persona is torn down and brought up fresh in the new directory, with no
  restart (see [Confirming a pending change](#confirming-a-pending-change)); a plain restart without the confirmation doesn't apply it.
- **Added at runtime:** the same line when a confirmed change adds this
  persona; it comes up on its own once the directory is usable. Other
  personas are not affected.
- If the persona also has a credentials cause, the cleared line ends
  `the persona stays broken until its credentials file is fixed and the change confirmed`
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
  symlink, or by changing `working_directory` in `config.json` and confirming
  the edit, which tears the persona down and brings it up fresh with no
  restart, see [Confirming a pending change](#confirming-a-pending-change)). A fixed path comes up on the next re-check, within 300 s.
- **Added at runtime:** the same line when a confirmed change adds this
  persona; it comes up on its own once the directory is usable. Other
  personas are not affected.

### `persona-config-dir-unresolvable`

- **State:** `retrying`. Recovers on its own once the directory resolves; no
  restart and no confirmation.
- **Line:** `[slack] persona-config-dir-unresolvable: personas[<i>] "<name>" (key=<key>) path="<dir>": claude_config_dir cannot be resolved to a real path (<code>); its Slack connection is closed and its launch waits until it resolves`.
  For a symlink that points to nothing, `(<code>)` reads
  `(ENOENT: a symlink on its path points to nothing)`. `<dir>` is the
  persona's effective `claude_config_dir` (its own, else the top-level one,
  else `~/.claude`) as an absolute path. `<code>` is the error code, such as
  `EIO`, `ENOTCONN`, `ESTALE`, `EACCES`, `ELOOP` or `ENOTDIR`, or `unknown`.
- **Meaning:** The persona's Claude config directory, which holds its login,
  settings and conversation history, can't be resolved to a real path.
  Usually it is a symlink onto a drive that isn't mounted, or a network or
  removable mount that dropped. The server checks it right before the
  persona connects to Slack (at a start, when a confirmed change adds or
  brings up the persona, and when a working-directory retry reaches Slack),
  and again at each launch (a restart, a retry, or the next launch after a
  confirmed `claude_config_dir` change). For a persona a pending change
  adds, the preview already lists the same cause under `is added but cannot
  come up`, and for a pending change of a persona's `claude_config_dir` (its
  own or the top-level one it inherits) it warns `but at that launch it
  cannot come up` (see [Pending changes](#pending-changes)).
- **What the server does:**
  - The persona is not up and has no Slack connection: found before it
    connects, it never connects; found at a later launch, its Slack
    connection is closed. It receives no Slack messages, `/interject`
    returns 503, its MCP session is dropped if it had one, and its
    permission prompts wait (see
    [A persona is down but its instance is still running](#a-persona-is-down-but-its-instance-is-still-running)).
  - Its instance, agent-director row and conversation are kept: no kill, no
    delete and no fresh spawn.
  - Its notices are held, up to 20 (the oldest is dropped past that), and
    posted once it is up again.
  - The directory is re-checked on the persona's own timer, 5 s doubling to
    300 s with no limit, outside the restart counter and cap.
  - The start's transcript check skips the persona, so there is no
    lost-history notice for it.
  - A confirmed change to its credentials file content is taken while it is
    held: no connection opens, and it connects with the new content once
    the directory resolves.
- **Logged:** once when it starts; failed re-checks log nothing. If a
  launch found it while the persona's Slack connection still had an open
  [`persona-connection-lost`](#persona-connection-lost),
  [`persona-slack-unreachable`](#persona-slack-unreachable) or
  [`persona-credentials-refused`](#persona-credentials-refused) line, that
  line is closed right after by one of the same class with the cause
  `cleared: the persona's Slack connection was closed while its claude_config_dir cannot be resolved`.
  The persona's return then connects afresh, so no restored line follows.
  A launch queued for the persona just before it was held does nothing when
  its turn comes; the return launches it instead. Once the
  path resolves, one line with the same class and the cause
  `cleared: claude_config_dir resolves to a real path again; continuing the bring-up`,
  then Slack validation and connection with its current credentials, then
  `[slack] persona "<name>" (key=<key>): up after its claude_config_dir resolved — launching`.
  The launch resumes its agent-director row. If Slack is unreachable at that
  point, the persona becomes `persona-slack-unreachable` and launches once
  Slack answers. A persona Slack had refused when the hold started gets the
  cleared cause ending
  `the persona stays broken until its credentials file is fixed and the change confirmed`
  instead (see
  [Recovering a persona broken by its credentials](#recovering-a-persona-broken-by-its-credentials)).
- **Fix:** Have the operator remount the drive or repair the symlink so the
  path resolves again. The persona reconnects and resumes its own session at
  the next re-check, within 300 s, with no confirmation and no restart. To
  check the path read only (these show the path, not the directory's
  contents):

  ```sh
  ls -ld "<dir>"; realpath -e "<dir>"
  ```

- **Not this error:** a directory that doesn't exist yet under a parent that
  resolves. Claude Code creates it at the first launch, and the persona
  launches normally. A dropped mount that leaves an empty mount point looks
  the same, so it doesn't log this line: remount it before the persona next
  launches.
- **Other lines for it:**
  `[slack] spawnForPersona: "<name>" (key=<key>) claude_config_dir could not be resolved during the launch — keeping its row; not launching`
  (the path stopped resolving while a launch ran),
  `[slack] killSession (restart adapter): persona=<key> claude_config_dir cannot be resolved to a real path — not killing; its row is kept`
  (a restart found it, so the relaunch is skipped and counts toward no cap),
  `[slack] jsonl-persistence-check: "<name>" (key=<key>) claude_config_dir="<dir>" cannot be resolved to a real path (<code>) — transcript not checked this pass`
  and `[slack] persona "<name>" (key=<key>): no longer applied — its claude_config_dir retry stops`
  (a confirmed change removed it). A
  `[slack] persona "<name>" (key=<key>): claude_config_dir retry failed: <error>`
  or `[slack] persona "<name>" (key=<key>): closing its Slack connection for its claude_config_dir failed: <error>`
  line is an internal error: report it as a bug.

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
  Claude asks at the persona's tmux pane (`tmux attach -t =slack_bot_<key>`).
  A request answered there is closed, and no prompt is posted for it.
- **Not this class:** a post Slack refuses for the message itself
  (`invalid_blocks`, `msg_too_long`, `no_text`, …) holds nothing. It logs
  `[slack] permission-poller: chat.postMessage failed for <instance> …` on
  every attempt for a prompt, or
  `[slack] persona-notifier: failed to post notice for <ref> to <id> …` once
  for a notice, which is dropped. Report it as a bug, with the line.

### `persona-credentials-change-failed`

- **State:** unchanged. A persona that was `up` stays `up`; one that was
  `retrying` keeps retrying. One whose own connection Slack refused while the
  change was being tried (for example, its bot token was revoked meanwhile)
  stays `broken`.
- **Line:**
  `[slack] persona-credentials-change-failed: personas[<i>] "<name>" (key=<key>) path="<path>": the confirmed credentials change cannot be used: <cause>; the current connection stays in use, and the change stays pending`.
  For a persona that is retrying its bring-up, the end reads
  `it keeps retrying with its current credentials, and the change stays pending`.
  For a persona whose own connection was refused meanwhile, it reads
  `it stays broken by its credentials, and the change stays pending`.
- **Meaning:** The operator confirmed a change to the persona's credentials
  file (same path, new content), and the server couldn't use the new file.
  `<cause>` says why:
  - the file is missing, unreadable or invalid: the cause texts of
    [`persona-credentials-missing`](#persona-credentials-missing),
    [`persona-credentials-unreadable`](#persona-credentials-unreadable) and
    [`persona-credentials-invalid`](#persona-credentials-invalid);
  - its real path is another persona's credentials file:
    `real path is also the credentials_file of "<name>" (key=<key>)`;
  - Slack refused a new token: `bot_token refused by auth.test: Slack error <code>`
    or `app_token refused by the Socket Mode open: Slack error <code>` (see
    [`persona-credentials-refused`](#persona-credentials-refused) for the
    codes).
- **Effect:** Nothing about the persona changed. It keeps running on its old
  connection and old tokens (or stays `broken`, for the `stays broken`
  ending), and its instance and conversation are untouched.
  Other personas are not affected. The change stays pending, so
  `config.json.pending` is written again with the same
  `credentials file "<path>" changed …` line (see
  [Pending changes](#pending-changes)).
- **Also logged later:** when a confirmed change first found Slack
  unreachable and Slack then refuses the new token while the persona is still
  up on its old connection, this line is logged at that point, and the change
  is pending again. If the old connection was refused meanwhile, the later
  refusal is logged as [`persona-credentials-refused`](#persona-credentials-refused)
  instead, and the persona stays `broken`: fix the file and confirm again.
- **Fix:** Have the operator correct the credentials file: the shape under
  [`persona-credentials-invalid`](#persona-credentials-invalid) (check it with
  [Checking a credentials file's shape](#checking-a-credentials-files-shape)),
  or a working token as described under
  [`persona-credentials-refused`](#persona-credentials-refused). Each save
  regenerates `config.json.pending` within about 5 s. Wait for it, then
  confirm again (see [Confirming a pending change](#confirming-a-pending-change)).
  No restart is needed.
- **Not this class: Slack unreachable.** A confirmed change that can't reach
  Slack isn't a failure. The persona keeps its current connection while the
  new one retries on its own (5 s doubling to 300 s), and `server.log` has
  `[slack] persona "<name>" (key=<key>): its changed credentials cannot reach Slack yet; the new connection retries and the current one stays in use`
  plus a [`persona-slack-unreachable`](#persona-slack-unreachable) line for
  the new connection. Once Slack answers, the persona switches to the new
  connection with no further action, and the `reconnected …` line below is
  logged then. A persona whose own connection Slack refused meanwhile logs
  `[slack] persona "<name>" (key=<key>): its changed credentials cannot reach Slack yet; the new connection retries, and it stays broken by its credentials until that connection is in use`
  instead; it comes up again once the new connection is in use. If a later
  confirmed change replaces the retrying one, or the persona's connection is
  stopped, the new connection's `persona-slack-unreachable` line is closed by
  one ending `cleared: the new connection of its confirmed credentials change is no longer retried: …`
  with the reason.
- **When it works:** an up persona logs
  `[slack] persona "<name>" (key=<key>): reconnected with its changed credentials; its instance and MCP session are kept`;
  one whose own connection Slack had refused meanwhile logs
  `[slack] persona "<name>" (key=<key>): reconnected with its changed credentials and up again; its instance is kept`,
  then `up after its confirmed credentials change — launching`, and its kept
  instance registers again;
  a retrying one logs
  `[slack] persona "<name>" (key=<key>): it retries its bring-up with its changed credentials`.
  A persona held for its `claude_config_dir`
  ([`persona-config-dir-unresolvable`](#persona-config-dir-unresolvable)) is
  retrying with no connection: it takes the new content, opens no
  connection, and connects with it once the directory resolves.
- **When its state changed since the preview:** a persona the preview said
  would be reconnected, but that is broken by its credentials when the
  change is applied, logs
  `[slack] persona "<name>" (key=<key>): broken by its credentials now, so it is brought up again rather than reconnected`
  and is then brought up again (`broken by its credentials and its
  credentials file changed — bringing it up again`, a new `persona-start`
  line). A persona the preview said would be brought up, but that a pending
  reconnect of an earlier change has brought up since, logs
  `[slack] persona "<name>" (key=<key>): not brought up again — it is not broken by its credentials now, so its changed credentials are applied as a credentials change`,
  then the lines above for an up persona.
- **Not this class: a persona already broken by its credentials when the
  change is applied.** Its bad new file doesn't log this line. It is brought up again and logs its usual class
  line (`persona-credentials-invalid`, `-missing`, `-unreadable` or
  `-refused`), stays `broken`, and nothing is pending until the file
  changes again.

---

## Combined and related cases

### Both causes at once

A persona with a credentials cause and a directory cause is `broken`. Both
lines are logged at bring-up. The directory is still re-checked, and its
cleared line says the persona stays broken until its credentials file is fixed
and the change confirmed. Fix both: the directory, and the credentials file,
then confirm the pending change (see
[Confirming a pending change](#confirming-a-pending-change)); no restart is
needed.

### Recovering a persona broken by its credentials

A persona that is `broken` (`persona-credentials-missing`, `-unreadable`,
`-invalid` or `-refused`) comes up again through a confirmed change to its
credentials file, with no restart. This holds whether it broke at a start, when
a confirmed change added it, or while it was running.

1. Have the operator correct the file: create it, fix its permissions, rewrite
   it in the required shape (see
   [`persona-credentials-invalid`](#persona-credentials-invalid)), or put a
   working token in it (see
   [`persona-credentials-refused`](#persona-credentials-refused)). Check it
   with [Checking a credentials file's shape](#checking-a-credentials-files-shape).
2. Within about 5 s `config.json.pending` appears with
   `…: credentials file "<path>" changed: it is broken by its credentials now, so it will be brought up.`
   (see [Pending changes](#pending-changes)).
3. With the operator's say-so, confirm it by the rename (see
   [Confirming a pending change](#confirming-a-pending-change)).
4. `server.log` shows
   `[slack] persona "<name>" (key=<key>): broken by its credentials and its credentials file changed — bringing it up again`,
   a new `persona-start` line, then
   `[slack] persona "<name>" (key=<key>): up at apply — launching`. The launch
   reaches the persona's kept instance, so it keeps its conversation history.

If the file still can't be used, or Slack refuses the new token, the persona
logs its usual class line again and stays `broken`, and nothing stays pending
until the file changes again. A server restart isn't needed: every start reads
credentials files as they stand, so a restart would also pick up the fixed
file, but it cuts off every persona and isn't the fix.

### Fixed on Slack's side, same tokens

A persona refused by Slack (`persona-credentials-refused`) whose app was then
repaired in Slack (re-installed to the workspace, or re-enabled) with the same
tokens stays `broken`. Nothing is pending, because the file didn't change, and
a persona broken by its credentials recovers only through a confirmed change
to its credentials file.

**Fix:** have the operator re-save the credentials file with any byte change
that keeps it valid; for example, re-save with a trailing newline, then confirm.
A newline after the closing `}` is enough; a newline inside a token's string
makes the file invalid. Then wait for `config.json.pending` and confirm it as in
[Recovering a persona broken by its credentials](#recovering-a-persona-broken-by-its-credentials).
If Slack still refuses the token, a new `persona-credentials-refused` line names
the cause, the persona stays `broken`, and nothing stays pending: the file's
new bytes are now the ones the server holds, so fix the app or the token and
save the file again.

### A credentials file shared by two personas

`config.json` validated at a start without a record, and every edit, reject two
personas whose `credentials_file` paths share a real path (see
[Across personas](#across-personas); the edit previews as `INVALID`). The two
cases where it still happens:

- **At a start from the last-applied record** (which doesn't run that check),
  each persona sharing the file is `broken` with
  [`persona-credentials-invalid`](#persona-credentials-invalid)
  (`real path is also the credentials_file of "<name>" (key=<key>)`), and the
  start goes on for the other personas.
- **At a confirmed change**, when a symlink changed after the preview so that a
  persona's credentials file now resolves to another applied persona's: a
  persona being brought up is `broken` with that same line, and a persona that
  is up logs
  [`persona-credentials-change-failed`](#persona-credentials-change-failed)
  with that cause and keeps its current connection.

**Fix after a start from the record.** Give one persona (say A) its own file:
change its `credentials_file` in `config.json`, or point its symlink
elsewhere. Changing the path in `config.json` and confirming is a destructive
change of A (`DESTRUCTIVE: … credentials_file changed to "<path>" …`): A is
torn down and brought up fresh from its new file. The other persona (B) stays
`broken`, because its own file didn't change. To bring B up, have the operator
re-save B's file with any byte change (see
[Fixed on Slack's side, same tokens](#fixed-on-slacks-side-same-tokens)) and
confirm its `credentials file "<path>" changed: it is broken by its credentials now, so it will be brought up.`
line. Both steps can go into one confirmation: edit `config.json`, re-save B's
file, wait until the preview shows both A's `DESTRUCTIVE:` line and B's
`credentials file` line, then confirm once. B's bring-up checks the file
against the configuration just applied, where A no longer shares it. They can
also be two confirmations, one after the other.

### A running persona's directory disappears later

This is not a bring-up retry. A persona that was up and whose working directory
is later removed follows the restart path: its launches fail, restarts back off
from `session_restart_delay` and stop after 5 consecutive failures (a
`SpawnCapReached` notice), and a *Working directory unreachable* notice is
posted to the persona's `permission_prompts` channel. Restore the directory; if
restarts were capped, restart the server.

### Two personas post lost-message notices about each other

A lost-message notice is a Slack post like any other, so a persona with
`delivery: all` in another persona's destination channel receives that
persona's notices. When two personas each receive every message in the other's
destination channel and neither persona's instance can take messages, each
loses the other's notices and posts a *Message lost* notice about each one.
They keep posting notices about each other until either instance takes
messages again.

**Fix:** recover either persona's instance, as its notice's `Recovery:` state
says (see the `No live session` row under
[Other lines you may see](#other-lines-you-may-see)); the notices stop then. To
keep it from happening, have the operator give each persona a destination that
no other persona receives every message in, such as its own channel or `"dm"`,
and not give a persona `delivery: all` in another persona's `permission_prompts`
channel.

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
settings. With `session_restart_delay` 0 the health check reconnects nothing;
see [A persona's instance runs but isn't connected](#a-personas-instance-runs-but-isnt-connected).
A few refused lines right after a start are
normal. If a refused instance keeps reconnecting in a loop while its persona is
down, report it as a bug, with the persona's lines.

---

## A persona's instance runs but isn't connected

The persona is up and its Claude instance runs, but messages can't reach it,
so messages sent to it are lost (each with a *Message lost* notice). Usually
the launch or the health check reconnects it within minutes. When it can't,
the persona's destination gets one of the notices below. At most one of them is
posted per episode: after one, none is posted again until the instance
registers with the server again, the health check finds it reachable again,
or the persona is removed. `server.log` has, when the notice is posted:

```text
[slack] session-manager: persona=<key> is not connected (<reason>) — raising a not-connected notice (b.f2b)
```

| Notice | `<reason>` | Why | What to do |
|---|---|---|---|
| *Waiting on a prompt* | `blocked-on-prompt` | The instance's terminal shows a permission dialog, a question or another prompt that no one answered, or its row reads `ask_user` or `check_permission` while its tmux session is alive. The server never types into one. An instance that died under a prompt keeps that row state, but it is not reported: its tmux session is checked first, and a gone one is relaunched (see [A persona whose instance died under a prompt](#a-persona-whose-instance-died-under-a-prompt)). | With the operator's say-so, attach (`tmux attach -t =slack_bot_<key>`) and answer it; a permission prompt also posted to the persona's destination can be answered there. Once it is answered, the server reconnects the instance when it can tell it is idle again (its row reads `waiting`, or its screen and transcript prove it idle); if it stays disconnected, type `/mcp reconnect slack-channel-router` in it. With `session_restart_delay` 0 the notice says so: if it is still not connected once its turn ends, type that command or restart the server. |
| *Not connected* | `auto-restart-disabled` | `session_restart_delay` is 0, so nothing will reconnect it. The notice says why it isn't connected (list below). | With the operator's say-so, attach, deal with anything on screen and type `/mcp reconnect slack-channel-router`, or restart the server. |
| *Not connected* | `unproven-idle` | At any `session_restart_delay`: the row reads `working`, and the server has held back from it for 10 min from its first deferral because it can't prove the instance idle (below). Its first line says `its session reads working but CSCB can't prove it's idle, so it won't type into it`. | With the operator's say-so, attach and look: let a running turn finish and answer anything on screen; if it sits idle at its prompt, type `/mcp reconnect slack-channel-router` in it. With a delay above 0 the server keeps checking and reconnects it once it can tell it is idle; with 0, restart the server if it stays disconnected. |
| *Not receiving messages* | `auto-restart-disabled` | The instance is connected, but its message stream is gone (`found on two health checks in a row`), and `session_restart_delay` is 0, so nothing will restore it. | As for *Not connected*. |

The *Not connected* notice gives one of these causes:

| Cause in the notice | When |
|---|---|
| `its connection has been down on two health checks in a row` | The health check found the instance alive but not connected twice in a row. |
| `it moved to state <state> while CSCB waited to reconnect it` | At its launch, the row moved to `pending` instead of finishing its turn. A move to `ask_user` or `check_permission` posts *Waiting on a prompt* instead. |
| `agent-director has no record of its session, though its tmux session is alive` | At its launch, the row vanished while the tmux session lives. |
| `agent-director could not report its state when CSCB stopped waiting for it, 10 min after launching it` | The launch waited 10 minutes and agent-director couldn't answer at the end. |
| `its agent-director row still read <state> 10 min after launch, and CSCB found no proof it was idle` | The launch waited 10 minutes and the row stayed live but not `working` (for example `pending`). A row still `working` then gets the `unproven-idle` notice instead. |

To see what the instance shows without touching it:

```sh
agent-director list --label service=cscb --label persona=<key>
agent-director read-pane --claude-instance-id cscb_<key>
agent-director get --claude-instance-id cscb_<key>
```

`get` shows the row's `claude_session_id`, `cwd` and, once recorded,
`jsonl_path`: the transcript the server reads (below).

### A row that reads `working` while the instance sits idle

agent-director can keep reporting a row as `working` after the turn has
ended. The server trusts neither the row nor the screen alone: a turn waiting
on the API can hold a still screen with no spinner. It reconnects a `working`
row only when, at every read across 60 s, both of these held and neither
changed:

- **The screen is idle.** No busy spinner line (such as `✳ Harmonizing… (2m 42s · ↓ 10.1k tokens)`,
  or a custom verb of several words from the `spinnerVerbs` setting; on Linux
  the `●` before each reply and tool call is not a spinner, even with an
  ellipsis in the line),
  no `esc to interrupt` or `esc to cancel` hint, no API retry message
  (`No response from the API after …`, `Rate limit reached · Retrying in …`,
  `Waiting for API response · will retry in …`, `… · attempt <n>/<m>`), and
  no prompt or dialog (a numbered option list with its `❯` cursor).
- **The transcript ends with a completed turn.** Its last conversation entry
  is Claude's final reply, or the `[Request interrupted by user]` (or `… for
  tool use]`) marker of a turn the user interrupted, which gets no Stop, so
  agent-director leaves its row `working`. A prompt, a tool call, a tool
  result, a queued message, or a Stop hook's context or blocking error after
  the reply (the turn goes on with it) means the turn is still open. The server reads only the file's last
  256 KiB. The file is the row's `jsonl_path` when it names the row's session,
  else `<claude_config_dir>/projects/<slug>/<claude_session_id>.jsonl`, where
  `<slug>` is the row's `cwd` with every character other than a letter, digit
  or `-` replaced by `-`. A transcript that can't be found or read is no sign
  of idleness.

It never types into a running turn or a prompt. Holding back is bounded,
though: once the server has held back from a `working` row for 10 min from
its first deferral, at a launch or in the health check's reconnects, the
persona's destination gets the `unproven-idle` *Not connected* notice (above),
whatever `session_restart_delay` is. A row that reads another state, a
reconnect and a new launch start the 10 min over.

At a launch (a start, an added persona, a relaunch), the launch waits for the
row. While the row reads `working` it reads the screen every 5 s, and the
transcript whenever the screen sits idle:

| Line | Meaning |
|---|---|
| `[slack] waitForWaitingAndReconnect: "<name>" (key=<key>) reads working, but its pane has shown the same idle screen (no busy indicator, no prompt) and its transcript has ended with a completed turn, both unchanged, for <N>s — treating the row as stale and reconnecting (b.f2b)` | The stale row is reconnected, whatever `session_restart_delay` is. Look for `Session connected` next. |
| `[slack] waitForWaitingAndReconnect: "<name>" (key=<key>) reads working and its pane shows an idle screen, but <why> — no idle evidence; still waiting for its working row (b.f2b)` | The screen is idle, but `<why>` is `its transcript "<path>" does not end with a completed turn` or `its transcript can't be read: <reason>`. Logged again only when `<why>` changes. The launch keeps waiting. A transcript that can't be read at all leaves the row to the 10-minute limit, and then to the `unproven-idle` notice. |
| `[slack] waitForWaitingAndReconnect: "<name>" (key=<key>) reads working and its pane has shown a prompt or dialog for <N>s — blocked on it; not typing into it, still waiting (answer it in tmux session "slack_bot_<key>") (b.f2b)` | A prompt is on screen: the *Waiting on a prompt* notice is posted and the launch keeps waiting. Answer the prompt. |
| `[slack] waitForWaitingAndReconnect: reading the pane of "<name>" (key=<key>) failed: <error> — no idle evidence from it; still waiting for its working row (b.f2b)` | agent-director couldn't read the screen (logged once per wait). The launch keeps waiting. |

When the wait ends with the instance running and nothing typed, the line ends
with what happens next. With `session_restart_delay` above 0 it names the
health check's recovery; with 0 it ends
`session_restart_delay is 0, so nothing will reconnect it — the not-connected notice reports it (once per episode) (b.f2b)`
and the *Not connected* notice (or, for a row at `ask_user` or
`check_permission`, *Waiting on a prompt*) is posted. A row still `working`
at the deadline gets the `unproven-idle` *Not connected* notice at any delay,
once the server has held back from it for 10 min:

| Line starts with | Meaning |
|---|---|
| `[slack] waitForWaitingAndReconnect: "<name>" (key=<key>) transitioned to state=<state> — aborting;` | The row moved to `pending`, `ask_user` or `check_permission`. |
| `[slack] waitForWaitingAndReconnect: spawn not found for "<name>" (key=<key>) but tmux session alive — aborting poll;` | The row vanished; the tmux session lives. |
| `[slack] waitForWaitingAndReconnect: timed out for "<name>" (key=<key>) after <ms>ms — <reason>, tmux session alive;` | After 10 minutes agent-director couldn't report the row. |
| `[slack] reconnect: gave up waiting for "<name>" (key=<key>) after <ms>ms — claude process state=<state> (alive);` | After 10 minutes the row was still live. A row that reads `waiting` at that point is reconnected instead. |

Removing the persona (or changing it destructively) with a confirmed change
cancels its launch's wait at once; see
[A persona was added or removed by a confirmed change](#a-persona-was-added-or-removed-by-a-confirmed-change).

Later, the health check's reconnects check the same way, reading the screen
(and, when it sits idle, the transcript) once per attempt and keeping what
they saw across attempts. Before typing into a `waiting` row, they read its
screen once too:

| Line | Meaning |
|---|---|
| `[slack] reconnectSession: persona=<key> is working — deferring /mcp reconnect to a later tick (b.9a7/b.rmy)` | The screen shows a running turn (a spinner, a busy hint or an API retry message). A later tick retries once it ends. |
| `[slack] reconnectSession: persona=<key> is working; its pane shows an idle screen (no busy indicator, no prompt) and its transcript ends with a completed turn, both unchanged for <N>s of the 60s needed — deferring /mcp reconnect to a later tick, which reads them again (b.f2b)` | Both look idle; the next attempt comes on the next tick that finds the persona not connected. |
| `[slack] reconnectSession: persona=<key> reads working, but its pane has shown the same idle screen (no busy indicator, no prompt) and its transcript has ended with a completed turn, both unchanged, for <N>s — treating the row as stale and reconnecting (b.f2b)` | The stale row is reconnected. |
| `[slack] reconnectSession: persona=<key> is working and its pane shows an idle screen, but <why> — no idle evidence; deferring /mcp reconnect to a later tick (b.f2b/b.rmy)` | The screen is idle, but the transcript doesn't end with a completed turn or can't be read (`<why>`, as at a launch). A later tick retries. |
| `[slack] reconnectSession: persona=<key> is working and its pane is blank — no idle evidence; deferring /mcp reconnect to a later tick (b.f2b)` | Nothing on screen yet. A later tick retries. |
| `[slack] reconnectSession: persona=<key> is working and reading its pane failed: <error> — no idle evidence; deferring /mcp reconnect to a later tick (b.f2b/b.rmy)` | agent-director couldn't read the screen. A later tick retries. |
| `[slack] reconnectSession: persona=<key> is working and its pane shows a prompt or dialog — not typing into it; deferring /mcp reconnect to a later tick (b.f2b/b.rmy)` | A prompt is on screen. |
| `[slack] reconnectSession: persona=<key> reads working and its pane has shown a prompt or dialog for <N>s — blocked on it; not typing into it, deferring /mcp reconnect to a later tick (answer it in tmux session "slack_bot_<key>") (b.f2b)` | The prompt stayed for 60 s: the *Waiting on a prompt* notice is posted. Answer the prompt. |
| `[slack] reconnectSession: persona=<key> is <state> — its session waits on a prompt or dialog; not typing /mcp reconnect into it, deferring to a later tick (b.f2b/b.rmy)` | The row reads `ask_user` or `check_permission` and its tmux session is alive: the *Waiting on a prompt* notice is posted. Answer the prompt. |
| `[slack] reconnectSession: persona=<key> is <state> and its tmux session probe failed: <error> — taking the session as alive (b.jdc/b.rmy)` | The server couldn't check the tmux session, so it treats the prompt as still waiting; the line above follows. |
| `[slack] reconnectSession: persona=<key> is <state> and a launch for it is in flight — deferring to a later tick (b.jdc)` | A launch for the persona is running and owns the instance. Nothing is typed or posted; a later tick retries. |
| `[slack] reconnectSession: persona=<key> is waiting but its pane shows a running turn — deferring /mcp reconnect to a later tick (b.f2b/b.rmy)` | The row reads `waiting`, but the screen shows a turn running. A later tick retries. |
| `[slack] reconnectSession: persona=<key> is waiting but its pane shows a prompt or dialog — not typing into it; deferring /mcp reconnect to a later tick (answer it in tmux session "slack_bot_<key>") (b.f2b/b.rmy)` | The row reads `waiting`, but a prompt is on screen: the *Waiting on a prompt* notice is posted. Answer the prompt. |
| `[slack] reconnectSession: persona=<key> is waiting and reading its pane failed: <error> — reconnecting on the waiting row alone (b.f2b)` | agent-director couldn't read the screen; the `waiting` row is enough, and the reconnect goes ahead. |
| `[slack] reconnectSession: persona=<key> status check failed: <error> — not typing /mcp reconnect blind; deferring to a later tick (b.f2b/b.rmy)` | agent-director couldn't report the row's state, so nothing is typed. A later tick retries; while agent-director stays unreachable the health check reads the persona as dead and relaunches it. |
| `[slack] reconnectSession: persona=<key> is pending — its session has not started (SessionStart has not fired), agent-director refuses send-keys until it does, and it connects on its own once it starts; not typing /mcp reconnect, deferring to a later tick (b.dup)` | The instance is still starting. Nothing is typed and nothing is posted; a later tick retries. If it repeats for many minutes, the instance is stuck before its session starts, and its launch posted a `Spawn failure:` notice (`DialogApprovalTimeout`); attach to its tmux session `slack_bot_<key>` to see what it shows. |
| `[slack] reconnectMcp: send-keys refused for <ref>: ErrSpawnNotInteractive message="…" — agent-director ended its row or marked it missing after its state was read (SessionEnd or a findMissing sweep), so its claude process is gone — dead session (b.dup)` | Normal after an instance died: agent-director found it gone just before the reconnect was typed. Nothing is posted. In the health check the persona is relaunched in the same restart (`Relaunching session for persona=<key>` follows); at a start it is resumed or respawned (`spawnForPersona: dead session for <ref> … — recovering via resume/fresh-spawn`). |

### A persona whose instance died under a prompt

When an instance dies (its tmux session killed, or its Claude process gone)
while its row reads `ask_user` or `check_permission`, agent-director keeps that
row state until its `find-missing` sweep reaps it. The server doesn't take the
row's word for it. Before holding back from such a row, or reporting it with
*Waiting on a prompt*, it checks the instance's own tmux session
(`slack_bot_<key>`, matched exactly):

- **Gone:** nothing is posted. It runs the sweep and relaunches the persona:
  the health check in the same restart, a start or relaunch through
  resume or a fresh spawn.
- **Alive:** the prompt is treated as still waiting and reported as above. The
  health check's reconnects keep checking, though: once it has held back from
  the row for 10 minutes, each later attempt first runs the sweep, and a row
  the sweep marks `missing` or `ended` is relaunched.

Nothing is typed into the row either way.

| Line | Meaning |
|---|---|
| `[slack] reconnectSession: persona=<key> is <state> but its tmux session "slack_bot_<key>" is gone — no prompt is waiting in it; not deferring, reconciling so the restart relaunches it (b.jdc)` | The health check found the instance dead under a prompt. The `escalate-dead` line below follows, then `Session reads dead after escalate-dead reconciliation — relaunching in this restart run for persona=<key> (b.d61)` and `Relaunching session for persona=<key>`. |
| `[slack] reconnectSession: persona=<key> has read <state> for <N> min of deferrals, and after a findMissing sweep its row reads <ended or missing> — its claude process is gone; not deferring, the restart relaunches it (b.jdc)` | Its tmux session was still there, but the sweep found its Claude process gone. The persona is relaunched in the same restart. |
| `[slack] escalate-dead: persona=<key> verdict=<verdict> — <evidence>, triggering internal findMissing reconciliation (the restart relaunches it once its row reads dead; ~/startup/find-missing-loop.sh is belt-and-braces)` | The health check's reconnect found the instance dead and asked agent-director to reap its row. `<verdict>` says how it knew: `dead-session` (the reconnect couldn't reach its tmux session), `working-tmux-gone` or `prompt-row-tmux-gone` (its row reads `working`, or `ask_user`/`check_permission`, but its tmux session is gone), all with `tmux session provably dead`; or `row-not-interactive` (agent-director refused the reconnect because it had already ended the row or marked it missing), with `row not interactive (…)`. If `Session still reads alive after escalate-dead` follows, a later tick retries. |
| `[slack] spawnForPersona: "<name>" (key=<key>) reads <state> but its tmux session "slack_bot_<key>" is gone — no prompt is waiting in it; reconciling its row before deciding (b.jdc)` | At a start or relaunch. If the sweep marks the row dead, `spawnForPersona: dead session for "<name>" (key=<key>) (state=<state>) — recovering via resume/fresh-spawn` follows and the persona is resumed. |
| `[slack] spawnForPersona: "<name>" (key=<key>): its tmux session is gone, but its row still reads <state> after the findMissing sweep — no action; the health check's restart retries it (b.jdc)` | agent-director didn't reap the row yet (`could not be read` instead when it couldn't report it). The health check retries. With `session_restart_delay` 0 the line ends `session_restart_delay is 0, so nothing retries it before the next server start`: once `agent-director get --claude-instance-id cscb_<key>` shows the row `missing` or `ended`, restart the server, with the operator's say-so. If the row never leaves `ask_user` or `check_permission`, report it as an agent-director bug. |

### At a start: one persona waiting doesn't hold up the others

A launch that meets a `working` row keeps waiting in the background, and the
start goes on without it: the other personas launch, and the health check and
the check for pending changes start as usual.

| Line | Meaning |
|---|---|
| `[slack] startupSessionManager: "<name>" (key=<key>) is waiting for its working row to settle — the start pass goes on without it; its launch stays in flight in the background (b.f2b)` | Normal. The health check leaves this persona alone until the launch ends. |
| `[slack] startupSessionManager: complete — <N> persona(s): … <n> not brought up, <m> not reconnected` | The start summary. `not reconnected` counts instances left running without a reconnect (see the lines above). |
| `[slack] startupSessionManager: <n> persona(s) still waiting in the background for a working row to settle — not counted above; each logs its outcome when it settles (b.f2b)` | Launches still waiting when the summary was logged. |
| `[slack] startupSessionManager: background launch for "<name>" (key=<key>) settled: <outcome> (b.f2b)` | The launch ended. `reconnected`: the reconnect was typed. `not-reconnected`: the instance was left running without it (the line before says what happens next), or the persona's removal cancelled the wait. A relaunch action (`resumed`, `spawned`, `fresh-after-amnesia` or `fresh-after-inconclusive-amnesia`): the instance had died and was relaunched; for the two amnesia actions, the persona's `[slack] ErrJsonlMissing diagnostic:` lines say whether its conversation history was kept. `deferred`: its `claude_config_dir` stopped resolving, and the persona is held until it does. `failed`: see the persona's spawn-failure lines. |
| `[slack] startupSessionManager: unexpected error in the background launch for "<name>" (key=<key>): <error>` | An internal error, also recorded as `spawn-failed` in `startup-errors.log`. Report it as a bug, with the persona's lines. |

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
the persona is still `working` (about 1 when its screen and transcript show
it idle; see
[A persona's instance runs but isn't connected](#a-personas-instance-runs-but-isnt-connected)).
A teardown also waits for any restart already under way for its persona, but
not for a launch waiting on a `working` row: it cancels that wait, and nothing
is typed. Meanwhile `config.json.pending` isn't refreshed and
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
| `[slack] persona teardown of "<name>" (key=<key>): agent-director kill of cscb_<key> failed: <error>` (or `… delete of cscb_<key> failed: …`) | agent-director couldn't kill or delete the instance, often because it was unreachable. The row may still be there (see [Listing instances](#listing-instances)); for a removed persona, the next server start removes it. For a destructively modified persona, its bring-up finds the row: a row whose working directory or config directory no longer matches is replaced, but when neither changed (for example a `credentials_file` path change alone) the row still matches, so the launch may resume it with its conversation instead of spawning a fresh instance. |
| `[slack] persona teardown of "<name>" (key=<key>): <step> failed: <error>`, any other step | An internal error. The other steps still ran. Report it as a bug. |
| `[slack] dry-run: persona teardown of "<name>" (key=<key>): skipping the agent-director kill and delete of cscb_<key>` | Dry run: the instance and its row are left alone. |
| `[slack] Cancelled restart timer for persona=<key>` | A restart that was pending for it was cancelled. |
| `[slack] waitForWaitingAndReconnect: persona=<key> — cancelling its launch's wait for its working row (b.f2b)` | Its launch was waiting for a `working` row. The wait is cancelled, so the teardown doesn't wait up to 10 minutes for it. |
| `[slack] waitForWaitingAndReconnect: persona=<key> — its launch in flight will not wait for a working row: any such wait is cancelled at once (b.f2b)` | Its launch was running but not waiting yet; a wait it starts ends at once. |
| `[slack] waitForWaitingAndReconnect: the wait for "<name>" (key=<key>) was cancelled (its persona is being torn down) — nothing typed (b.f2b)` | The cancelled wait ended with nothing typed; the teardown goes on. |
| `[slack] persona teardown of "<name>" (key=<key>): cancelling its launch's wait for a working row before its turn failed: <error>` | An internal error in that cancel; the teardown still runs. Report it as a bug. |
| `[slack] permission-poller: persona=<key>: dropped <n> tracked prompt(s); their Slack messages stay as posted` | Its open prompts are no longer tracked. Their messages stay in Slack, and clicking them does nothing. |
| `[slack] persona-notifier: persona=<key>: dropped <n> held notice(s), not posted — the persona was torn down` | Notices that were waiting for its Slack client are dropped. |
| `[slack] persona-destination-hold: hold cancelled — <n> held notice(s) for "<name>" (key=<key>) dropped, not posted` | Notices that were waiting for its failing destination are dropped. |

**Destructively modified persona.** A kept persona whose `credentials_file`
path or `working_directory` changed gets both: the removed persona's teardown
lines, then the added persona's bring-up lines (`persona-start`, then
`up at apply — launching` or a class line). It comes up fresh, with no
conversation history. A restart or retry that was pending for it is cancelled
when its teardown is queued, so the old entry is never relaunched in between.
`[slack] persona teardown of "<name>" (key=<key>): <step> before its turn failed: <error>`
is an internal error in that cancel; the teardown still runs. Report it as a
bug.

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

Which token was revoked decides what the log shows. The Socket Mode
connection uses only the app token, so a revoked app token shows up when that
connection is reopened. Every Web API call (posts, reactions, history,
downloads) uses the bot token, so a revoked bot token shows up at the first
such call Slack refuses. Either way the persona becomes `broken` with one
`persona-credentials-refused` line.

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
`persona-credentials-refused`), then confirm the pending change (see
[Confirming a pending change](#confirming-a-pending-change)); no restart is
needed. The persona is brought up again as under the bot token below, and the
instance re-registers once it is up.

### The bot token

**Symptom:** the persona stops answering in Slack, and its instance's MCP
session is dropped and then refused. The Socket Mode connection stays up on
the app token, so nothing looks wrong on the connection itself.

**When it's noticed:** at the first Web API call on the persona's client that
Slack refuses with `invalid_auth`, `token_revoked`, `account_inactive` or
`not_authed`: a tool call from its instance, or a permission prompt or notice
the server posts for it. A persona that makes no call isn't noticed until it
does. Any other Slack error, or a network failure, doesn't mark it.

**What the log shows:** one line, logged at once:

```
[slack] persona-credentials-refused: personas[<i>] "<name>" (key=<key>) path="<credentials file>": bot_token refused by a Web API call (<method>): Slack error <code>
```

`<method>` is the Slack method that was refused, such as `chat.postMessage`.
The call that hit the error fails as it would anyway (a tool error to the
instance, with its `[slack] Tool "<tool>" failed for persona …` line; a
refused prompt or notice may also log
[`persona-destination-failed`](#persona-destination-failed)). Then comes
`MCP session dropped — the persona is not up (broken: …)` if a session was
registered.

**What the server did:**

- the persona is `broken`, with no further attempts; its Socket Mode
  connection is closed, and messages sent to it are no longer delivered;
- its client makes no more calls: any later call on it is refused without
  reaching Slack, so nothing is posted under the persona's or any other
  identity;
- its MCP session is dropped, and the instance's reconnects are refused, as
  under [A persona is down but its instance is still running](#a-persona-is-down-but-its-instance-is-still-running);
- its instance and agent-director row are kept, so its conversation survives;
- other personas are not affected, and nothing is posted to Slack about it.

**Fix:** get a working Bot User OAuth Token from the persona's Slack app
(re-install the app to the workspace if it was uninstalled or the token
revoked), have the operator write it into the persona's credentials file, then
confirm the pending change (see
[Confirming a pending change](#confirming-a-pending-change)). The preview
reads `…: credentials file "<path>" changed: it is broken by its credentials
now, so it will be brought up.` No restart is needed. Once applied, the log
shows `[slack] persona "<name>" (key=<key>): broken by its credentials and its
credentials file changed — bringing it up again`, a new `persona-start` line
and `up at apply — launching`. The launch reaches the kept instance, which
registers again with its history. If the new token is refused too, a new
`persona-credentials-refused` line names the cause and the persona stays
`broken`.

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
     `cleared:` line comes with the persona's next prompt or notice. No restart
     is needed (if the bot token changed, see the next bullet).
- **The bot token after the re-install:** Slack adds the new scope to the
  app's existing grant, and the shipped manifest has token rotation off, so
  the Bot User OAuth Token normally stays the same. The operator checks this
  themselves, outside the chat: compare the Bot User OAuth Token on the app's
  OAuth & Permissions page with the persona's credentials file. If it changed,
  the operator writes the new token into the credentials file, waits for the
  pending change and confirms it: a persona that is up reconnects with its
  instance kept (see
  [`persona-credentials-change-failed`](#persona-credentials-change-failed),
  *When it works*), and one broken by its credentials comes up (see
  [Recovering a persona broken by its credentials](#recovering-a-persona-broken-by-its-credentials));
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
  | The effective value isn't what you expect. A persona without its own `stop_hook_bootstrap` inherits the top-level one (default `true`). | The persona's entry and the top level of `config.json`. | With the operator's say-so, set `stop_hook_bootstrap` on the persona's entry (it overrides the top level), then confirm the edit. It applies at the persona's next launch; to apply it now, relaunch the bots with `clean_restart` (see [Next-launch and server-wide settings](#next-launch-and-server-wide-settings)). |
  | The value changed after the persona's instance launched. A running instance keeps the value it launched with; a change applies at the persona's next launch. A plain server restart reconnects to an instance that is still running, which is not a launch. | The record holds the old value. | With the operator's say-so, run `claude-slack-channel-bots clean_restart`. It relaunches every persona (resume or fresh spawn), cutting off their current turns, and each launch rewrites the persona's record. |
  | No `claude_config_dir` is configured for the persona (nor at the top level). No hook is installed for it, so it gets no reminder. | `server.log` has `[slack] stop-hook-bootstrap: "<name>" (key=<key>) has no claude_config_dir — skipping`. | Give the persona (or the top level) a `claude_config_dir` of its own, then confirm the edit and relaunch the bots with `clean_restart` (see [Next-launch and server-wide settings](#next-launch-and-server-wide-settings)). The new directory must exist (else `stop-hook-bootstrap-dir-missing`) and be logged in to a Claude account, and the bot comes back without its conversation history. |
  | Its `claude_config_dir` resolves to the operator's own `~/.claude`. The server never installs the hook there, so the persona gets no reminder. | `startup-errors.log` has a `stop-hook-bootstrap-refuse-home` entry (recorded once per server start); `server.log` has `refusing to touch operator's own ~/.claude` at each launch. | Point the persona at a different `claude_config_dir`, then confirm the edit and relaunch the bots with `clean_restart` (see [Next-launch and server-wide settings](#next-launch-and-server-wide-settings)). The new directory must exist (else `stop-hook-bootstrap-dir-missing`) and be logged in to a Claude account, and the bot comes back without its conversation history. |
  | `jq` is not on the host's `PATH`. The hook is installed but can't read the transcript, so it never reminds. | `startup-errors.log` has a `stop-hook-bootstrap-jq-missing` entry. | Install `jq`. No restart is needed; the next turn is checked. |
  | The hook couldn't be installed: the directory is missing, or its `settings.json` is unreadable or not valid JSON (left untouched). | `startup-errors.log` (at start) or `server.log` (at a launch) has `stop-hook-bootstrap-dir-missing`, `stop-hook-bootstrap-not-a-dir` or `stop-hook-bootstrap-settings-…`; the `jq` command above shows no `slack-reply-guard.sh` entry. | Create the directory or fix the file, then `clean_restart`. |
  | The record couldn't be written at launch. The stale record is removed, so the persona gets no reminder until its next launch. | No record file; `server.log` has `[slack] reply-guard: could not write the record for "<name>" (key=<key>) at <path>`. | Fix the state directory's permissions or free space, then `clean_restart`. |
  | Reminded after opting out: the instance launched while the value was `true`. | The record reads `true`. | `clean_restart` (second row). |
  | No reminder after a confirmed `claude_config_dir` change and a plain server restart. The server keeps each instance's launched-with directory in memory only, so after the restart it no longer counts the still-running instance toward its old directory. When every persona the server still counts toward the old directory has the reminder off, the next hook pass there (the restart's own start pass, or a launch of such a neighbour) removes the managed hook. Only the reply reminder is lost, until that instance's next launch. | The `jq` command above, run on the old directory, shows no `slack-reply-guard.sh` entry. | `clean_restart`, with the operator's say-so. |

- **Not a fault:** the hook reminds at most once per turn, only for a turn
  that started from a Slack message the persona received, and only when it
  hasn't replied with the `reply` tool. A persona that replies, or a turn
  started by a scheduled prompt or `/interject`, gets no reminder.

---

## Other lines you may see

| Line | Meaning |
|---|---|
| `[slack] persona "<name>" (key=<key>): up after its bring-up retry (directory\|Slack) — launching` | A retrying persona came up and is launched from its retry. Normal recovery. |
| `[slack] persona Socket Mode: personas[<i>] "<name>" (key=<key>): <text>` | A connection-health line from the Slack library: a ping or pong timeout, or `Failed to send ping to Slack`. The connection is treated as dead and reopened. See [`persona-connection-lost`](#persona-connection-lost). |
| `[WARN]  web-api:WebClient …` (or `[INFO]`, `[ERROR]`) | The Slack library's own line for a persona's Web API client: a Slack response warning, a rate-limit wait, or a failed request. URLs show as `<redacted-url>` and token-like text as `<redacted-token>`. Nothing to do unless it repeats. |
| `[slack] Session connected: persona "<name>" (key=<key>) cwd="<path>"` | The persona's instance registered: it's being served. |
| `[slack] No live session for persona "<name>" (key=<key>) chat_id=<id> — dropping message` | The persona's instance has no live MCP session (the persona is up but its instance isn't registered, or the persona stopped being up while the message was being handled), so a message for it is lost: not delivered, not saved and not replayed later. Nothing else is posted in `<id>`, the conversation it came from (the notice below lands there only when `<id>` is the destination), and it gets no ack reaction. The persona posts one lost-message notice to its destination: `Persona "<name>" (key=<key>): :warning: *Message lost* — a message from <sender> …`, naming the sender (display name, else user ID; for a bot or webhook post, its name or bot ID) and ending in a `Recovery:` state, never the message text. `not up`: the persona stopped being up (broken or retrying) while the message was being handled, so no restart was started; its instance is launched once the persona recovers: fix its cause (its class line), then resend. A persona that isn't up receives nothing, so this state appears only when the persona stops being up after its connection received a message and before the session lookup (for example Slack refuses a Web API call for its bot token), or when the old half of a persona being torn down by a destructive change receives a message just before its connection stops. `restarting` and `starting now`: the instance is being restarted; resend once it's back. `auto-restart disabled` and `restart limit reached`: the notice says to restart the server to recover. If the notice doesn't arrive, look for a [`persona-destination-failed`](#persona-destination-failed) line. |
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
| `[slack] agent-director version re-check: the runtime re-check could not run: <description>; the server keeps running and checks again at the next 120 s re-check` | The server's 120 s check of the agent-director binary couldn't run: the binary is missing, unreadable, unreachable, or didn't answer within 30 s. `<description>` says which (an error name such as `ErrSystemInstallUnreachable (reason <reason>, binary at <path>)`, or `no answer within the 30 s time limit`). Nothing changes: the server keeps running and checks again every 120 s. One line per run of failures: the first failure after start, or after a check that passed, logs it, and the failures after it log nothing until a check passes. Nothing goes to `startup-errors.log` or Slack. If the line keeps coming back, check that the agent-director binary is present and executable. If a later check finds a version the server refuses, the server stops as in [Found while the server was running](#found-while-the-server-was-running). |
| `[slack] agent-director settings: the read of "<path>" was refused: <reason>; <kept> stay in effect until a read is accepted (b.jg5 SRJ-209)` | The server refused agent-director's timing settings file and keeps its last accepted values (`the defaults` at start). One line per run of refused reads. See [agent-director's timing settings](#agent-directors-timing-settings). |
| `… launch after its bring-up retry failed: …`, `… working-directory retry failed: …`, `… handling its change from up to <outcome> failed: …`, `persona … not brought up: Slack bring-up threw: …`, `persona <step> failed: personas[<i>] …`, `persona-destination-hold: retry of held notices failed for persona=<key>: …`, `persona-destination-hold: notice failure callback threw for persona=<key>: …`, `unhandled rejection (process keeps running): …` | An internal error. The server keeps running. Report it as a bug, with the persona's lines around it. |

---

## The server refuses the agent-director binary at start

The startup gate reads the version of the system-installed `agent-director`
binary before anything else runs. A binary that is too old stops the start:
`start` prints its `Server failed to start` block, and the refusal is one
timestamped line in `startup-errors.log` and the same line in `server.log`:

```text
[<timestamp>] [<class>] <message>
```

Nothing was launched, killed or deleted, no persona was brought up, and
nothing was posted to Slack. Running agent-director instances are left as
they were. For both classes, this CSCB release and agent-director Phase 1
are installed together, through the README section "Switching over to
agent-director Phase 1": its `state.db` backup and restarts come with the
install. Tell the operator to follow that section; a bot or this skill never
changes the agent-director install itself. A running server can stop on
the same two classes; see
[Found while the server was running](#found-while-the-server-was-running).

### `ad-below-phase1-floor`

The binary is below CSCB's Phase 1 floor. The line names the version found,
the version required (the Phase 1 release or later, its release candidates
included), the binary path, that the startup check found it, and the README
section "Switching over to agent-director Phase 1". It has no
install-skill block.

- **Cause:** the binary passed the agent-director client's own minimum but
  predates agent-director Phase 1. A development build that reports the
  placeholder version `0.0.0-dev` is below the floor too and is refused the
  same way. A build that reports the bare version `dev` does not reach this
  check: the version does not parse, so the client refuses it first as
  `ad-system-install-unreachable` (reason `unparseable-version`).
- **Fix:** the operator follows the README section "Switching over to
  agent-director Phase 1", then starts the server again.

### `ad-system-install-too-old`

The binary is below the agent-director client's own minimum. The line names
the version found, the version the client requires (its minimum, which the
client reports), that this CSCB release needs CSCB's Phase 1 floor or later
(release candidates included), the binary path, that this CSCB release and
agent-director Phase 1 are installed together, and the
README section "Switching over to agent-director Phase 1". It ends with the
install-skill block (the `install-cscb` skill's URL, target path and
command); that skill names the same section and runs nothing for this
class.

- **Cause:** the system-installed binary is older than the minimum that
  the npm `agent-director` client CSCB depends on accepts.
- **Fix:** the operator follows the README section "Switching over to
  agent-director Phase 1", then starts the server again.

### Found while the server was running

A running server re-checks the agent-director binary every 120 s, on its own
timer: `health_check_interval` `0` turns off the health check, not this
re-check. A binary that fails either check above stops the server with a
non-zero exit. `startup-errors.log` and `server.log` get one line of the
same class, `ad-below-phase1-floor` or `ad-system-install-too-old`, in the
same form as at start, except that it says:

```text
found by a runtime re-check while the server was running, so the server stopped
```

in place of the floor entry's "found by the startup check" (for the too-old
entry, right after the binary path). It still names the versions and the
binary path, and the too-old entry still ends with the install-skill block.
`server.log` then shows
`[slack] Shutting down: the runtime version re-check refused the agent-director binary (see startup-errors.log)`
and, last, `[slack] Shutdown complete` (or, if the shutdown hung,
`[slack] Shutdown did not complete within 30 s — exiting with code 1`; a
shutdown that hung with nothing left open ends with neither line, still with
exit code 1).

- **Cause:** the binary was swapped, while the server ran, for an older
  build or one that fails the check (such as a `0.0.0-dev` development
  build).
- **What the stop did not do:** the shutdown made no agent-director call. No
  bot was killed, paused or deleted, and every agent-director row is as it
  was: the bots keep running, but nothing serves them until the server is
  back. Nothing was posted to Slack.
- **Fix:** the same as at start: the operator follows the README section
  "Switching over to agent-director Phase 1", then starts the server again.
  A bot or this skill never changes the agent-director install itself.

---

## agent-director's timing settings

agent-director keeps nine timing settings in the `[tmux]` table of
`~/.agent-director/config.toml`. The file is agent-director's; CSCB only
reads it, from the HOME the server process runs in (not a persona's
directory). The README section "agent-director's timing settings" lists the
nine keys and their defaults.

- **When the server reads it:** once at start, after the agent-director
  version check passes and the configuration is loaded, before any persona
  is brought up, then every 120 s with the binary re-check, whatever
  `health_check_interval` is (`0` included). Each read follows the binary
  re-check, and the next re-check starts 120 s after the previous one ends,
  so reads are 120 s plus the re-check's run time apart (up to its 30 s time
  limit when the binary doesn't answer). A change to the file is used within
  about 120 s, with no restart.
- **The default rule:** a missing file, a missing key or `0` means
  agent-director's default for that key. Other tables and keys are ignored,
  so a misspelt key leaves its default in force.
- **A refused read.** The server refuses the whole file when:
  - the server can't find its home directory;
  - the file exists but can't be read (it's a directory or not a regular
    file, it's over the server's own 64 KiB limit, or a permission or I/O
    error), isn't valid UTF-8 (its bytes are never replaced) or isn't valid
    TOML;
  - `tmux` is there but isn't a table;
  - one of the nine keys holds a string, a float (`60.0` included: write
    whole numbers without a decimal point), or any other non-integer;
  - one of them is negative;
  - one of them is larger than 2^63 − 1 (9223372036854775807), the largest
    whole number agent-director can hold;
  - `starting_session_seconds` is below 60 or `stopping_window_seconds` is
    below 30 (after the default rule, so a missing key or `0` is checked as
    its default);
  - `pending_grace_seconds` is below its minimum, which depends on two other
    keys: take `create_timeout_ms` plus `pipe_close_wait_ms`, turn it into
    whole seconds (rounding up) and add 20; the minimum is that, or 30 if 30
    is larger. At the defaults it is 30. With `create_timeout_ms` 40000, it
    is 61, so the default 60 (from a missing key or `0`) is refused too.
- **What a refused read does:** nothing changes. The server keeps the values
  of the last read it accepted (the defaults, if it has accepted none since
  start) and writes one line to `server.log`, at the first refused read. The
  refused reads after it write nothing; the next accepted read ends the run,
  so a later refusal logs again. Nothing goes to `startup-errors.log` or
  Slack, and the server keeps running. The line:

  ```text
  [slack] agent-director settings: the read of "<path>" was refused: <reason>; <kept> stay in effect until a read is accepted (b.jg5 SRJ-209)
  ```

  `<path>` is the file the server read (`~/.agent-director/config.toml` when
  it couldn't find its home directory). `<kept>` is `the defaults` or `the
  values of the last accepted read`. `<reason>` names the first broken rule,
  in the key order of the README's table: for example
  `[tmux] stopping_window_seconds is 10, below its minimum of 30`,
  `[tmux] query_timeout_ms is not an integer (it is a string)`,
  `[tmux] action_timeout_ms is too large for agent-director`,
  `[tmux] pending_grace_seconds is missing, so its default 60 applies, below its minimum of 61, which create_timeout_ms 40000 and pipe_close_wait_ms 100 set`,
  `it is not valid TOML (at line <L>, column <C>)`,
  `it is not valid UTF-8`,
  `it cannot be read (<errno code, or "not a regular file">)` (or bare
  `it cannot be read` when the failure has no errno code),
  `it is larger than the 64 KiB limit` or
  `the home directory cannot be found`. It never quotes the file's text.
- **How to check:** read the file at `<path>` and compare the `[tmux]` table
  with the rules above. The reason names only the first broken rule, so
  check the others too.
- **Fix:** the operator's. This skill never edits the file. Once the file is
  fixed, the server picks it up within about 120 s, with no restart.
- **Who decides:** agent-director's own answers always decide. The server's
  reading of the file never overrides what agent-director does or reports.

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
no message shows a `bot_token` or `app_token` value. Messages do quote
persona names (as written) and keys, channel IDs, the configuration file's path and, in the duplicate-path rules, the
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
| Server-wide type and range errors: `<key> must be a non-negative number.`, `<key> is invalid. Allowed values are: ….`, `<key> must be a boolean.`, `<key> must be a non-empty string when set.`, `<key> must be a string when set.`, `<key> must be a positive integer (>= 1) when set.`, `agent_director_poll_interval_ms must be a positive integer in [200, 3600000].`, `agent_director_call_timeout_ms must be a positive integer in [1000, 3600000].`, `cron_table_path must be a non-empty string.`, `cron_log_path must be a non-empty string.` | A server-wide setting has the wrong type or is out of range. | Correct the named key. |

### Persona entries

| Message (after the persona prefix) | Cause | Fix |
|---|---|---|
| `personas[<i>] must be a JSON object, got <type>.` | An array element isn't an object. | Make it a persona object. |
| `unknown field(s) in the persona entry: "<key>".`, `… in dm: …`, `… in channels[<j>]: …`, each possibly with `1 field whose name is not shown …` or `plus <n> fields whose names are not shown …` | A key the schema doesn't have, at that level. As at the top level, only plain setting names are shown; others (a digit, as in `channels2`, a dash, a pasted token) are counted. | Remove or correct it. For an unshown field, compare that entry's keys with the persona keys in the README. |
| `name is required.` / `name must be a non-empty string.` | Missing or blank name. Any other name is accepted: there is no format rule. | Give the persona a name. |
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
| `key <key> starts with the key of personas[<j>] "<name>" (key=<key>). tmux matches a session name by its start, so once slack_bot_<key> is gone, a command meant for it (reading its pane, typing into it, ending it) can act on slack_bot_<key>. No persona's key may start with another persona's key: rename one of the two so that neither key starts with the other. For example, rename personas[<i>] "<name>" (key=<key>) to "<new name>" (key=<new key>).` / `key <key> is the start of the key of personas[<j>] …. …` | One persona's key starts with another's: `dev` and `dev_2`, `horde` and `horde_admin`, or `dev` and `"Dev Bot"` (key `dev_bot_…`). agent-director 0.10.0 finds a persona's tmux session by a name that also matches the start of a longer one, so it could read, type into or end the other persona's session. Checked in the last-applied record too. | Rename one so that neither key starts with the other. The `For example` sentence, when there is one, is a name for the persona with the shorter key that fits every other persona: its key plus `_main` (`_main_2`, … when that is taken). Keys that only share a start, such as `dev_a` and `dev_b`, are fine. For a record, fix `config.json` first, then delete the record. |
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
| `DESTRUCTIVE: persona "<name>" (key=<key>) working_directory changed to "<path>": its live session will be destroyed, then it is brought up fresh.` | Its `credentials_file` or `working_directory` (compared by real path) changed, or its `name` changed without changing its key (`name changed`). Several are joined by ` and `, e.g. `credentials_file changed to "<path>" and working_directory changed to "<path>"`. At the confirmation the persona is torn down and brought up fresh: the instance is replaced and loses its session history. |
| `persona "<name>" (key=<key>) is added: it will be brought up and launched.` | A new persona. |
| `persona "<name>" (key=<key>) is added but cannot come up: <cause>; <cause>.` | A new persona whose bring-up would fail now. The causes, in this order, are the credentials and working-directory cause texts under [Persona diagnostic classes](#persona-diagnostic-classes) (for example `credentials file does not exist`, `credentials file is invalid: …`, `working directory does not exist`), then `claude_config_dir cannot be resolved to a real path (<errno>)`, or `(<errno>: a symlink on its path points to nothing)` for a dangling symlink (see [`persona-config-dir-unresolvable`](#persona-config-dir-unresolvable)). Every check runs, so one cause never hides another. A `claude_config_dir` not created yet under an existing parent is not listed. Fix them before the change is applied. |
| `persona "<name>" (key=<key>): <settings> changed: applied in place immediately, instance kept.` | `<settings>` lists one or more of `channels` (a channel added or removed), `delivery` (a kept channel's mode), `permission_prompts`, `dm.enabled`, `dm.contact`. Reordering channels isn't a change. |
| `…: stop_hook_bootstrap changed: takes effect at its next launch, instance kept.` | The persona's own `stop_hook_bootstrap` changed. The running instance doesn't see it until it is launched again. |
| `…: claude_config_dir changed: takes effect at its next launch, which starts fresh (the conversation is not resumed), instance kept until then.` | The persona's own `claude_config_dir` changed (by real path). The running instance is kept; its next launch uses the new directory and starts a new conversation. With both settings changed, the line reads `claude_config_dir, stop_hook_bootstrap changed:` with this effect. |
| `…: claude_config_dir changed: …, instance kept until then; but at that launch it cannot come up: claude_config_dir cannot be resolved to a real path (<errno>).` | A warning: the new directory can't be resolved now, with the same check and wording as an added persona's (`(<errno>: a symlink on its path points to nothing)` for a dangling symlink). It is not a refusal: confirming applies the change, and at the persona's next launch it is held as [`persona-config-dir-unresolvable`](#persona-config-dir-unresolvable) (its Slack connection closed, its launch waiting) until the directory resolves. The same warning ends a changed top-level `claude_config_dir` line, naming the inheriting personas it stops (`; but at that launch "<name>" (key=<key>), … cannot come up: …`), and a `DESTRUCTIVE:` line whose persona's `claude_config_dir` changed too (`; but it cannot come up: …`; that persona is held when it is brought up at the confirmation). Fix the directory, or the setting, before confirming. If the check itself failed, the line ends `; whether it can come up at that launch could not be checked` (see the `cannot check` line below). |
| `…: credentials file "<path>" changed: a new connection opens, then the old one closes, instance kept.` | The credentials file's content changed at the same path, and the persona is up. The line names the persona and the path, never a token. |
| `…: credentials file "<path>" changed: it has no connection yet, so it retries with the new content, instance kept.` | The same, for a persona still retrying its bring-up (Slack unreachable, its working directory unusable, or held for its `claude_config_dir`, see [`persona-config-dir-unresolvable`](#persona-config-dir-unresolvable)). |
| `…: credentials file "<path>" changed: it is broken by its credentials now, so it will be brought up.` | The same, for a persona that is broken by its credentials: its credentials file is missing, unreadable or invalid, or Slack refused its tokens ([`persona-credentials-refused`](#persona-credentials-refused)). |
| `…: credentials file "<path>" changed, but it cannot be used (<cause>): the current connection is kept, instance kept.` | The new content is missing, unreadable or invalid; `<cause>` is the credentials cause text, for example `credentials file does not exist` (never file content). The persona is up and keeps its current connection. Confirming it changes nothing and logs [`persona-credentials-change-failed`](#persona-credentials-change-failed). A restart reads the file as it stands, so the persona would then be `broken`: fix the file. |
| `…: credentials file "<path>" changed, but it cannot be used (<cause>): it keeps retrying with its current content, instance kept.` | The same bad content, for a persona still retrying its bring-up. |
| `…: credentials file "<path>" changed, but it cannot be used (<cause>): it stays broken by its credentials.` | The same bad content, for a persona broken by its credentials. It stays broken until the file is fixed. |
| `persona "<name>" (key=<key>) is added; whether it can come up could not be checked.` | A new persona whose credentials and working directory the check couldn't examine (see the `cannot check` line below). It isn't counted differently in the header. |
| `…: credentials file "<path>" changed; whether it is broken by its credentials now could not be checked.` | A credentials change whose persona's bring-up state couldn't be read (see the `cannot check` line below). With bad content it starts `credentials file "<path>" changed, but it cannot be used (<cause>);`. |
| `server-wide setting <name> changed: once applied, it is recorded and takes effect at the next server start after that.` | A top-level setting such as `port` or `bind`. |
| `server-wide setting <name> changed: once applied, it is recorded, and the CLI takes it from the record from then on (the running server does not use it).` | `stop_timeout` or `exit_timeout`, which only the CLI uses. |
| `server-wide setting <name> changed: once applied, it is recorded, the CLI takes it from the record from then on, and the running server uses it from its next start.` | `agent_director_call_timeout_ms`, which both the CLI and the server use. |
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
rewritten without a new log line: if an added persona's directory, or a
changed `claude_config_dir`, is created later, its line in the file changes,
but the log keeps the old one. The file is the current preview.

If the check can't gather a fact the preview needs, it logs one line, and the
preview says that fact `could not be checked` instead of guessing:
`[slack] reload: cannot check <what>: <error>; the preview says it could not be checked`.
`<what>` is `whether the added persona "<name>" (key=<key>) can come up`,
`the claude_config_dir of persona "<name>" (key=<key>)` (a changed one) or
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
   `config.json`'s bytes first. Then removed and destructively modified
   personas are torn down, changed routing settings are updated in place and
   personas whose credentials file changed are reconnected. The agent-director
   template's memory-read rules are rewritten when the set of config
   directories changed. Last, added and destructively modified personas, and
   personas broken by their credentials whose credentials file changed, are
   brought up.
   Otherwise nothing is applied and
   [`reload-stale-confirmation`](#reload-stale-confirmation) is logged.
5. Watch `server.log` for the outcome:

   ```sh
   grep -h -E 'reload-(applied|noop|invalid|stale-confirmation|record-write-failed)|reload: ' "$STATE"/server.log | tail
   ```

   [`reload-applied`](#reload-applied) (or [`reload-noop`](#reload-noop))
   is logged once every teardown, reconnect attempt and bring-up has
   settled, possibly minutes later; a persona that is `retrying` at that point isn't up yet. See
   [I confirmed but nothing happened](#i-confirmed-but-nothing-happened) for
   every other outcome.

What changes at once, with no restart:

- **Added and removed personas** (a rename is one of each), the preview's
  `is added` and `is removed` lines. See
  [A persona was added or removed by a confirmed change](#a-persona-was-added-or-removed-by-a-confirmed-change).
- **A kept persona's `credentials_file` path or `working_directory`**, the
  preview's `DESTRUCTIVE: … changed to "<path>" …` lines. The persona is torn
  down and brought up fresh from its new entry: its instance, agent-director
  row and conversation are destroyed, and the new credentials file is read.
  If the teardown's agent-director delete fails and neither the working
  directory nor the config directory changed (for example a `credentials_file`
  path change alone), the old row can be resumed instead; after a
  `working_directory` change the row is replaced (the `… delete of cscb_<key>
  failed` row there).
  See [A persona was added or removed by a confirmed change](#a-persona-was-added-or-removed-by-a-confirmed-change).
- **A kept persona's routing settings**, the preview's `… changed: applied in
  place immediately, instance kept` lines: `channels`, a channel's
  `delivery`, `permission_prompts` and `dm.*`. See
  [A persona's routing settings were changed by a confirmed change](#a-personas-routing-settings-were-changed-by-a-confirmed-change).
- **A kept persona's credentials file content** (same path), the preview's
  `credentials file "<path>" changed …` lines. A persona that is up is
  reconnected: the new connection opens, then the old one closes, and its
  instance, MCP session and conversation are kept. A persona still retrying
  its bring-up retries with the new content. A persona broken by its
  credentials is brought up again, and its launch reaches its kept
  instance, so its conversation is kept. For a persona that is up or
  retrying, a new file that can't be used changes nothing and logs
  [`persona-credentials-change-failed`](#persona-credentials-change-failed);
  the change stays pending. A persona broken by its credentials whose new
  file can't be used is still brought up again: it logs its `persona-start`
  line and its usual class line (`persona-credentials-invalid`,
  `-missing`, `-unreadable` or `-refused`), stays broken, and nothing is
  pending until the file changes again.

Next-launch and server-wide settings are recorded and take effect later (see
[Next-launch and server-wide settings](#next-launch-and-server-wide-settings)).
Never delete the record to apply an edit: the confirmation has already
written the change into it. Deleting the record is only for a server that
can't start (see [Starting without the record](#starting-without-the-record)).

### Next-launch and server-wide settings

A confirmation records these changes in `config.json.last-applied`, and they
take effect later. Until then, each persona keeps running as it was launched,
with the same instance, conversation and Slack connection.

| Preview line | After the confirmation | To carry it out sooner |
|---|---|---|
| `stop_hook_bootstrap changed` or `claude_config_dir changed` (`takes effect at its next launch`, or a top-level setting `inherited by …`) | Recorded. It reaches each persona at its next launch: when the bot dies (a crash or a failed health check), at a `clean_restart`, at `stop --stop-bots` then `start`, or after a host reboot. A changed `claude_config_dir` makes that launch start fresh. | Relaunch the bots: `claude-slack-channel-bots clean_restart`, or `stop --stop-bots` then `start`. Both cut off the bots' current turns. A plain restart reconnects running bots, which is not a launch. |
| `server-wide setting <name> changed: once applied, it is recorded and takes effect at the next server start after that.` | Recorded. The running server keeps the value it started with. | Restart. |
| `server-wide setting <name> changed: once applied, it is recorded, and the CLI takes it from the record from then on (the running server does not use it).` | `stop_timeout` or `exit_timeout`. The next `stop` or `clean_restart` uses it. | Nothing. |
| `server-wide setting <name> changed: once applied, it is recorded, the CLI takes it from the record from then on, and the running server uses it from its next start.` | `agent_director_call_timeout_ms`. The next `stop --stop-bots` or `clean_restart` uses it; the running server keeps the value it started with. | Restart, or `clean_restart`. |

Wait for `reload-applied`, then, with the operator's say-so, run
`claude-slack-channel-bots clean_restart`. It covers every row above: the
server comes back on the record and every bot is relaunched, resuming its
conversation except where a changed `claude_config_dir` starts it fresh. When
no next-launch setting changed,
`claude-slack-channel-bots stop && claude-slack-channel-bots start` is
enough, and bots keep running undisturbed. The record already holds the
change, so don't delete it.

**Memory-note reads.** When a confirmed change alters the set of Claude
config directories the personas use, the server rewrites the agent-director
template's memory-read rules, logging
`[slack] template refresh: rewrote the agent-director template '<name>' with the memory-read rules of the applied config directories (<n> rule(s)); its other arguments are the start's`.
If that fails, it logs
`[slack] template refresh: refreshing the agent-director template '<name>' failed (<detail>); its memory-read rules stay as last installed until the config directories change again or the server restarts`.
The change is still applied and no persona is disturbed, but a persona using
a directory new to the set asks for permission each time it reads its memory
notes. Nothing retries the rewrite: a later confirmed change that alters the
set of directories again, or a server restart, rewrites the rules. If the
failure repeats, check that agent-director is reachable (see
[Listing instances](#listing-instances)).

### I confirmed but nothing happened

Look in `server.log` for the lines logged after the rename (the `grep` in
[Confirming a pending change](#confirming-a-pending-change)):

| Line | Meaning |
|---|---|
| [`reload-applied`](#reload-applied) | The change was applied. Personas added, removed, destructively modified, changed in place or with a changed credentials file are handled (a credentials file that can't be used logs [`persona-credentials-change-failed`](#persona-credentials-change-failed) and stays pending); next-launch and server-wide settings are recorded (see [Next-launch and server-wide settings](#next-launch-and-server-wide-settings)). A persona that isn't up has its own class line. |
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
  effect at the next start, or for the CLI at once (`stop_timeout`,
  `exit_timeout`), or both: the CLI at once and the server at its next start
  (`agent_director_call_timeout_ms`), as its preview line says.
- **What happens to personas now:** the apply switches the persona set the
  server runs at once. Message delivery, the up check, the notifier and the
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
  - a kept persona's `stop_hook_bootstrap` or `claude_config_dir` change
    takes effect at its next launch (a relaunch after the bot dies, a
    `clean_restart`, `stop --stop-bots` then `start`, or a host reboot; a
    plain `stop` and `start` only reconnects), which launches the new
    declaration; until then its instance runs as launched;
  - a kept persona whose `credentials_file` path or `working_directory`
    changed is torn down, like a removed persona, then brought up fresh from
    its new entry, like an added one: its old instance, row and conversation
    are gone, and it reads the new credentials file;
  - an added persona is brought up and launched, as at a start (its
    `persona-start` line, then `up at apply — launching` or a class line);
  - a persona with a changed credentials file (same path) is reconnected
    with it when up (`reconnected with its changed credentials; its
    instance and MCP session are kept`), retries with it when retrying, and
    is brought up again when broken by its credentials. For a persona that
    is up or retrying, a new file that can't be used leaves it as it was and
    logs [`persona-credentials-change-failed`](#persona-credentials-change-failed),
    and that change stays pending (see [Pending changes](#pending-changes)).
    A persona broken by its credentials whose new file can't be used is
    brought up again anyway, logs its usual class line (for example
    `persona-credentials-invalid`) and stays broken; nothing is pending.

  The next start runs the new record, which also carries out the server-wide
  settings (see
  [Next-launch and server-wide settings](#next-launch-and-server-wide-settings)); the record already holds the change, so don't delete it.
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
  A `claude_config_dir` moved to another path for the same real directory
  (through a symlink) still logs one `template refresh:` line (see
  [Memory-note reads](#next-launch-and-server-wide-settings)): the template's
  rules are written from the path as spelled.
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
| Live state | The persona is up, but no `Session connected` since the start | Waiting to re-register; the health check reconnects it within about 3–5 minutes with default settings. A `working` row waits for its turn to end, and a prompt on screen or `session_restart_delay` 0 posts a notice instead: see [A persona's instance runs but isn't connected](#a-personas-instance-runs-but-isnt-connected). |
| `ended`, `missing`, or no row | The persona is up | The instance is dead. Restart and the health check relaunch it; look for `Scheduling restart for persona=<key>` and `Relaunching session`. |
| `ended`, `missing`, or no row | The persona is down | Nothing to serve; it's launched once the persona comes up. |
| No row | `persona teardown of … complete` | The persona was removed by a confirmed change; its instance was destroyed. Expected. |
| A row | `persona teardown of …: agent-director delete of cscb_<key> failed` | The teardown couldn't delete it. For a removed persona, the next server start removes it; for a destructively modified one, its bring-up replaces it, or may resume it when neither its working directory nor its config directory changed. |

`tmux has-session -t =slack_bot_<key>` confirms whether the instance's tmux
session exists. Keep the `=`: it matches that exact name only. A bare
`slack_bot_<key>` also matches another persona's session whose name starts
with it (`slack_bot_dev_2` for `slack_bot_dev`), so a gone session would read
as present.

