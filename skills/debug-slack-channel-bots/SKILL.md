---
name: debug-slack-channel-bots
description: Diagnose a claude-slack-channel-bots persona that is silent, down or refused — find its server-log lines, match the class, and follow the fix for every persona failure, every config.json rejection, every last-applied record failure at start, and every pending configuration change and its confirmation, in declarative and fungible channel mode, with the stored-choice file channel-delivery.json.
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
reason the last-applied record (`config.json.last-applied`) stops a start,
how to read and confirm a pending configuration change
(`config.json.pending`), both channel modes (declarative and fungible, set by
`allow_invited_channels`), and the stored-choice file
(`channel-delivery.json`).

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
- NEVER edit, or offer to edit, agent-director's config file
  (`~/.agent-director/config.toml`). An *agent-director refuses its config
  file* notice is for a human only (see
  **agent-director refuses its config file** under
  [agent-director refuses a persona](#agent-director-refuses-a-persona-it-is-retried-on-its-own)).
- NEVER end, type into or otherwise act on a session or agent-director row
  named in any *Held:* notice (*Held: tmux session conflict*, *Held:
  unusable tmux session name*, *Held: launch start not recorded*), and never
  carry out a step of the "Operator actions" section of agent-director's
  README. Those notices are for a human only (see
  [A persona posts a Held: tmux session conflict notice](#a-persona-posts-a-held-tmux-session-conflict-notice),
  [A persona posts a Held: unusable tmux session name notice](#a-persona-posts-a-held-unusable-tmux-session-name-notice)
  and
  [A persona posts a Held: launch start not recorded notice](#a-persona-posts-a-held-launch-start-not-recorded-notice)).
- NEVER run `clear-latch` without the operator's explicit say-so, as for
  starting or stopping the server, and never tell a persona, or any bot, to
  run it. It is the operator's command (see
  [Clearing a hold by hand: `clear-latch`](#clearing-a-hold-by-hand-clear-latch)).
- NEVER change, or offer to change, the agent-director install for a
  *Cannot launch* notice, and never act on the persona's row or session
  beyond the read-only checks. That notice is for a human only (see
  [A persona posts a Cannot launch notice](#a-persona-posts-a-cannot-launch-notice)).
- NEVER run, or offer to run, a command a *Kill failed* or *Process
  outlived kill* notice (or its `startup-errors.log` entry) names, never
  end or signal a process such a notice names by pid, and never carry out a
  step of the "Operator actions" section of agent-director's README for it.
  Those notices are for a human only (see
  [A persona posts a Kill failed or Process outlived kill notice](#a-persona-posts-a-kill-failed-or-process-outlived-kill-notice)).
- NEVER edit, write or delete the stored-choice file `channel-delivery.json`,
  and move it aside only on the operator's say-so (see
  [The stored-choice file: `channel-delivery.json`](#the-stored-choice-file-channel-deliveryjson)).

---

## Triage

1. **Persona is silent, `/interject` returns 503 for it, or its scheduled
   prompts log `no-session`.** Find its key: the `persona-start` line for its
   name (see [Reading a persona line](#reading-a-persona-line)). If the
   persona is up but its instance can't take messages, each message sent to
   it is lost: its destination (its `permission_prompts` channel in
   declarative mode, its `invited.permission_prompts` channel in fungible
   mode, or its DM with `dm.contact` for a `"dm"` destination, which in
   fungible mode is also the default) has a *Message lost* notice whose `Recovery:` wording
   says whether a server restart is needed. `held for a human`,
   `cannot launch`, `kill failed`, `not answering` and `starting` say no
   restart was started and what the persona waits on: a human to resolve
   its hold, a human to check its agent-director version, a human to
   check a worker a kill could not end, the server's own retries, or a
   launch already running. `server.log` has a
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
   **Silent only in a channel its app was invited to?** See
   [A persona is silent in a channel its app was invited to](#a-persona-is-silent-in-a-channel-its-app-was-invited-to).
   **Answering every message in a channel, not only @mentions?** See
   [A persona receives every message in a channel](#a-persona-receives-every-message-in-a-channel).
   An `unclaimed-channel` line ending
   `to serve this channel, use declarative mode with the channel listed` is
   the fungible-mode form: see its reasons under
   [`unclaimed-channel`](#unclaimed-channel).
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
   A `[retired-keys-unreadable]` line is covered under
   [The retired-key record can't be read or is invalid](#the-retired-key-record-cant-be-read-or-is-invalid).
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
   diagnoses it and names the README section that installs it.
   **The server was running and has stopped?** Read the latest lines of
   `startup-errors.log`. One that says `found by a runtime re-check while the
   server was running` is covered under
   [Found while the server was running](#found-while-the-server-was-running).
5. **The persona's lines show `unavailable-retry`, `Session relaunch refused`, `Session kill for persona=… did not succeed` or `no spawn-failure notice; nothing more is called`?**
   agent-director refused it and the server retries it on its own. See
   [agent-director refuses a persona](#agent-director-refuses-a-persona-it-is-retried-on-its-own).
   Lines with `kill try <n> of <max>` or `status read before kill try` are
   a kill being tried again: see
   [A kill that is tried again](#a-kill-that-is-tried-again).
   A persona that doesn't come back after the server replaced its old
   instance: its `[slack] live-row-sequence:` lines show each step and how
   the replacement ended; see the `live-row-sequence` rows under
   [Other lines you may see](#other-lines-you-may-see).
   **No class line, but the persona still isn't served?** See
   [A persona is down but its instance is still running](#a-persona-is-down-but-its-instance-is-still-running)
   and [Other lines you may see](#other-lines-you-may-see). A *Waiting on a
   prompt*, *Not connected* or *Not receiving messages* notice at its
   destination, or a row that reads `working` while the instance sits idle,
   is covered under
   [A persona's instance runs but isn't connected](#a-personas-instance-runs-but-isnt-connected).
   A persona that is silent with a *Slow recovery* notice at its
   destination, or a `slow-recovery: persona=<key>` line, is covered under
   [A persona whose recovery is slow](#a-persona-whose-recovery-is-slow).
   A *Not answering*, *Still not answering* or *Answering again* notice is
   covered under
   [A persona posts a Not answering notice](#a-persona-posts-a-not-answering-notice).
   A persona that is silent with a *Held: tmux session conflict* notice at
   its destination, or a `conflict-latch: persona=<key>` line, is covered
   under
   [A persona posts a Held: tmux session conflict notice](#a-persona-posts-a-held-tmux-session-conflict-notice).
   A persona that is silent with a *Held: unusable tmux session name* notice
   at its destination, or a line containing `— UNUSABLE NAME:`, is covered
   under
   [A persona posts a Held: unusable tmux session name notice](#a-persona-posts-a-held-unusable-tmux-session-name-notice).
   A persona that is silent with a *Held: launch start not recorded* notice
   at its destination, or a line containing
   `case=launch-start-not-recorded` or
   `its row reads pending with no launch start`, is covered under
   [A persona posts a Held: launch start not recorded notice](#a-persona-posts-a-held-launch-start-not-recorded-notice).
   A persona that is silent with a *Cannot launch* notice at its
   destination, or an `invalid-flags-hold: persona=<key>` line or a line
   containing `held on ErrInvalidFlags`, is covered under
   [A persona posts a Cannot launch notice](#a-persona-posts-a-cannot-launch-notice).
   A *Kill failed* or *Process outlived kill* notice at its destination, a
   `persona-episodes: persona=<key> kill-failure` line, or a
   `persona-kill-failed`, `persona-teardown-notice` or
   `persona-kill-survivor` entry (or an `orphan-cleanup` entry carrying `; kill-failure alert:`) in
   `startup-errors.log`, is covered under
   [A persona posts a Kill failed or Process outlived kill notice](#a-persona-posts-a-kill-failed-or-process-outlived-kill-notice).
   Any `persona-teardown-notice` entry (`raised during its teardown`), or a
   `persona-notifier: notice for … raised during its teardown` line, is a
   notice raised while a confirmed change tore a persona down, written
   instead of posted: see
   [A notice raised during a teardown](#a-notice-raised-during-a-teardown),
   then the inner notice's own section.
   A *tmux unavailable* or *tmux server changed* notice is covered under
   **tmux isn't available** in
   [agent-director refuses a persona](#agent-director-refuses-a-persona-it-is-retried-on-its-own).
   An *agent-director refuses its config file* notice, or an
   `outage-state: ad-config-malformed` line, is covered under
   **agent-director refuses its config file** in the same section.
   An *Unclassified agent-director error* notice, a
   `persona-episodes: persona=<key> unclassified-error` line, or a
   `persona-unclassified-error` entry in `startup-errors.log`, is covered
   under **agent-director returns an error the server can't classify** in
   the same section.
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
   `allow_invited_channels` was turned on or off? It applies in place, with
   every session kept: see the switch under
   [Confirming a pending change](#confirming-a-pending-change), then
   [A persona is silent in a channel its app was invited to](#a-persona-is-silent-in-a-channel-its-app-was-invited-to)
   for a channel that isn't served as expected.
   A confirmed change to its credentials file didn't take? Look for a
   [`persona-credentials-change-failed`](#persona-credentials-change-failed)
   line. A persona broken by its credentials whose app was fixed on Slack's
   side, with nothing pending? See
   [Fixed on Slack's side, same tokens](#fixed-on-slacks-side-same-tokens).
10. **`stop --stop-bots` or `clean_restart` printed `nothing was stopped`
    and exited 1?** Its precheck failed and the server and every bot still
    run. See
    [A precheck failed: nothing was stopped](#a-precheck-failed-nothing-was-stopped).
    `stop --stop-bots` printed `only the server was stopped` and exited 1?
    The installed agent-director is too old for the client. See
    [The two CLI commands on an old binary](#the-two-cli-commands-on-an-old-binary).
    Printed `could not stop persona` and exited 1? That persona could not
    be stopped. After `stop --stop-bots` the server stays stopped; after
    `clean_restart` the server was started again if agent-director
    answered, and otherwise not (`clean-restart-not-restarted`). See
    [`stop --stop-bots` or `clean_restart` could not stop a persona](#stop---stop-bots-or-clean_restart-could-not-stop-a-persona).
11. **The cause of a hold is fixed but the persona is still held, or
    `clear-latch` printed a line and exited non-zero?** See
    [Clearing a hold by hand: `clear-latch`](#clearing-a-hold-by-hand-clear-latch).
12. **A `channel-delivery-unreadable` line, or `[slack] channel-delivery:`
    lines?** See
    [The stored-choice file: `channel-delivery.json`](#the-stored-choice-file-channel-deliveryjson).
    **An agent's `set_channel_delivery` call was refused or failed?** The
    refusals, in the order they are checked, and the failed write are under
    [`persona-channel-delivery-set`](#persona-channel-delivery-set).

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
  `agent-director initialization failed:` line of `stop --stop-bots` and
  `clean_restart` prints the startup gate's own message in full, and any
  other failure in the redacted form above, on one line: on the terminal
  (and in `clean_restart.log` for `clean_restart`). The
  `could not stop persona` lines of `stop --stop-bots` and `clean_restart`
  show agent-director's error name and description in the same redacted
  one-line form, and are also written to `server.log` and
  `startup-errors.log` (see
  [`stop --stop-bots` or `clean_restart` could not stop a persona](#stop---stop-bots-or-clean_restart-could-not-stop-a-persona)). The `precheck failed for persona`
  lines of `stop --stop-bots` and `clean_restart` show agent-director's
  error name and its description in the redacted one-line form above, on
  the terminal (and in `clean_restart.log` for `clean_restart`); neither
  command writes them to `server.log` or `startup-errors.log` (see
  [A precheck failed: nothing was stopped](#a-precheck-failed-nothing-was-stopped)). The `[slack] Fatal:` line of a start that failed
  unexpectedly prints the raw error.
- **`startup-errors.log`** in the same directory is a separate file, never
  rotated by CSCB. Most entries are written at start: the agent-director
  startup gate, the retired-key record's refusal
  (`retired-keys-unreadable`) and a few start-time warnings. Some are written while the
  server runs: the runtime version re-check's stop (see
  [Found while the server was running](#found-while-the-server-was-running))
  and `persona-unclassified-error`, the *Unclassified agent-director error*
  notice of a persona no longer in the applied configuration (see
  **agent-director returns an error the server can't classify** under
  [agent-director refuses a persona](#agent-director-refuses-a-persona-it-is-retried-on-its-own)),
  the kill-failure notices with no Slack destination (`persona-kill-failed`,
  `persona-kill-survivor`; see
  [A persona posts a Kill failed or Process outlived kill notice](#a-persona-posts-a-kill-failed-or-process-outlived-kill-notice))
  and the notices raised during a persona teardown
  (`persona-teardown-notice`). `stop --stop-bots` and `clean_restart` write
  `cli-teardown-failed`, `persona-kill-failed` and `persona-kill-survivor`
  entries while the server is stopped, and `clean_restart` also
  `clean-restart-not-restarted` (see
  [`stop --stop-bots` or `clean_restart` could not stop a persona](#stop---stop-bots-or-clean_restart-could-not-stop-a-persona)).
  Each entry is also a line in `server.log`. The persona diagnostic classes
  below never go there, and no configuration or last-applied record refusal
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
| `path="…"` | The file or directory the line is about: the credentials file for credentials and Slack classes, the working directory for directory classes, the Claude config directory for `persona-config-dir-unresolvable`. Absent on `persona-start`, `unclaimed-channel` (in both channel modes), `persona-dm-dropped`, `persona-destination-failed`, `persona-invited-channel` and `persona-channel-delivery-set`. |
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
- **Two forms.** The line has one form per channel mode, the mode in force
  when the message arrived. Either way it is logged by the persona whose app
  received the message, one event logs at most one drop line, and the line
  has no `path` part.

**Declarative mode** (`allow_invited_channels` absent or `false`):

- **Line:** `[slack] unclaimed-channel: personas[<i>] "<name>" (key=<key>): message in channel <id> not delivered: no applied persona lists this channel`
- **Meaning:** In declarative mode, the persona's Slack app is a member of a
  channel that no persona lists in `channels`, so the message reached no one.
  Logged by each persona whose app received it. A channel that another
  applied persona lists logs nothing: that persona receives the message. An
  @mention of the persona in a group DM logs this line too (see **Group DMs**
  under [`persona-dm-dropped`](#persona-dm-dropped)).
- **Fix:** one of:
  - Add the channel to the right persona's `channels` in `config.json`. The
    edit becomes pending (see [Pending changes](#pending-changes)); once
    confirmed (see [Confirming a pending change](#confirming-a-pending-change))
    it applies in place, with no restart, and the persona keeps its instance
    and conversation.
  - For a public or private channel that is not externally shared: turn
    fungible mode on, which serves every such channel each persona's app is
    a member of (see
    [Turning fungible mode on or off](../../README.md#turning-fungible-mode-on-or-off)
    and, before that, [Who can reach a persona in fungible mode](../../README.md#who-can-reach-a-persona-in-fungible-mode)).
  - Remove the app from the channel.

  Fungible mode is never the fix for a group DM: a group DM is never served
  in either mode. If the ID is a group DM (someone @mentioned the persona in
  a multi-person DM), the line is expected: do not add that ID to any
  persona's `channels`, because that would deliver group-DM mentions to it.

**Fungible mode** (`allow_invited_channels` is `true`):

- **Line:** `[slack] unclaimed-channel: personas[<i>] "<name>" (key=<key>): message in channel <id> not delivered in fungible mode: <reason>; to serve this channel, use declarative mode with the channel listed`
- **Meaning:** In fungible mode, a `message` event the persona's app received
  was refused by the fungible path, so it reached no one. One line per
  refused `message` event, logged by the persona that received it, and no
  `persona-invited-channel` line for it. An `app_mention` never logs this
  line in fungible mode: the `message` event carrying the same mention
  decides. The line's own advice is the one way to serve such a channel:
  declarative mode, with the channel listed.
- **Reasons and fixes:** the conditions are checked in this order, and the
  first that fails is the reason:

  | `<reason>` | Meaning | Fix |
  |---|---|---|
  | `the conversation is not a public or private channel` | The event's `channel_type` is neither `channel` (public) nor `group` (private), or it is missing. A DM and a group DM never reach this check (see [`persona-dm-dropped`](#persona-dm-dropped)). | None in fungible mode. Serve it in declarative mode, with the channel listed, or remove the app from the conversation. |
  | `the channel ID is malformed` | The channel ID isn't a `C…` or `G…` ID of capital letters and digits. | None: `config.json` can't list such an ID either, so neither mode serves it. If the line repeats, report it as a bug, with the line. |
  | `the event envelope carries no is_ext_shared_channel flag` | Slack's event envelope didn't say whether the channel is externally shared, so the server can't tell and doesn't serve it. | None in fungible mode. Serve it in declarative mode, with the channel listed. |
  | `the event envelope's is_ext_shared_channel flag is not a boolean` | The envelope's flag is neither `true` nor `false`, so the server can't tell and doesn't serve it. | None in fungible mode. Serve it in declarative mode, with the channel listed. |
  | `the channel is externally shared` | Slack marks the channel as externally shared (Slack Connect). Fungible mode never serves it. | Serve it in declarative mode, with the channel listed, or remove the app from the channel. |

  Serving a channel in declarative mode means turning fungible mode off for
  every persona (see
  [Channel modes](../../README.md#channel-modes)); there is no per-channel
  exception.

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
  never delivered, in either channel mode, and never logs
  `persona-dm-dropped`, whatever `dm.enabled` says. This is by design, not a
  fault; turning `dm.enabled` on, or turning fungible mode on, does not
  change it. What it logs:
  - a group-DM message that Slack marks with `channel_type` `mpim` logs the
    plain `[slack] persona "<name>" (key=<key>) dropped message from
    channel=<id> …: group-dm` line, in both modes;
  - an @mention of the persona in a group DM arrives as an `app_mention`
    event without `channel_type`. In declarative mode it logs
    [`unclaimed-channel`](#unclaimed-channel). In fungible mode it logs no
    line of its own, only the server's
    `[slack] RAW app_mention event persona=<key>: …` intake line.

### `persona-invited-channel`

- **State:** the persona is `up`; this is an audit line, not a failure.
- **Line:** `[slack] persona-invited-channel: personas[<i>] "<name>" (key=<key>): hears <public|private> channel <id> in fungible mode, at channel delivery <mentions|all>`
- **Meaning:** The persona hears that channel in fungible mode. The line:
  - is logged only in fungible mode (`allow_invited_channels` is `true`),
    never in declarative mode;
  - is logged once per persona life and channel, on the first event from
    that channel that takes the persona's fungible path (a `message` event
    in a public or private channel that isn't externally shared), whether
    the message is delivered or not, and in addition to any drop line for
    that event. A message that doesn't mention the persona, or one lost
    because the persona has no live session, logs it too;
  - is logged by each persona for each channel: two personas in one channel
    log a line each, and one persona logs a line per channel;
  - is logged again for a persona torn down and brought back, and afresh
    after every server start. A confirmed change to `allow_invited_channels`
    doesn't reset it;
  - goes only to `server.log`, and carries no message text, user ID or
    token.

  The delivery shown is the one in force at that first event; a later
  change to it logs no second line of this class (a change made with
  `set_channel_delivery` logs a
  [`persona-channel-delivery-set`](#persona-channel-delivery-set) line).
- **Log rotation:** because the line is logged once per persona life and
  channel, log rotation can discard a channel's only audit line on a
  long-running server (see [The server log](#the-server-log)). After a
  restart, the first fungible-path event from each channel logs it again.
- **Cause:** The persona's Slack app is a member of that public or private
  channel, the channel isn't externally shared, and `allow_invited_channels`
  is `true`. The invite alone is enough: Slack sends the app events only from
  channels it is in, so nothing about membership is stored and no Slack call
  checks it.
- **Fix:** None when the persona is expected to hear the channel. To stop the
  persona hearing it, remove its app from the channel in Slack. To change the
  delivery shown, ask the persona in that channel: its agent calls
  `set_channel_delivery`, which logs a
  [`persona-channel-delivery-set`](#persona-channel-delivery-set) line. The
  delivery shown is `mentions`, whatever the persona chose for the channel,
  when the channel is another persona's fungible destination (its
  `invited.permission_prompts` channel), so two personas can't answer each
  other in a loop. It is `mentions` too when the persona has no stored
  choice for the channel, or when the stored-choice file can't be read (see
  [`channel-delivery-unreadable`](#channel-delivery-unreadable)). A persona
  that hears a channel but doesn't answer there is covered under
  [A persona is silent in a channel its app was invited to](#a-persona-is-silent-in-a-channel-its-app-was-invited-to).
- **Two personas at `all` in one channel:** don't. Each receives every
  message there, the other's posts included, so the two can keep answering
  each other with no human involved. Keep at most one at `all` (see
  [Channel delivery in fungible mode](../../README.md#channel-delivery-in-fungible-mode)).

### `persona-channel-delivery-set`

- **State:** the persona is `up`; this is an audit line, not a failure.
- **Line:** `[slack] persona-channel-delivery-set: personas[<i>] "<name>" (key=<key>): stored choice for channel <id> set from <none|mentions|all> to <mentions|all>, at channel delivery <mentions|all> after the loop guard`

  `from` is the persona's stored choice for the channel before the call
  (`none` when it had none), `to` is the choice the call stored, and
  `at channel delivery` is the persona's channel delivery there after the
  loop guard. The line has no `path` part.
- **Meaning:** The persona's agent called `set_channel_delivery` and the
  server stored its choice for that channel. The line:
  - is logged once for each accepted call, including one that stores the
    value already stored, and including in dry run, where the tool stores
    its choice the same way and makes no Slack call;
  - is logged only in fungible mode (`allow_invited_channels` is `true`):
    in declarative mode every call is refused;
  - goes only to `server.log`, in the `[slack]` stream: no
    `startup-errors.log` entry, and nothing is posted to Slack;
  - carries no message text, user ID or token.

  The choice applies from the next event in that channel. It is kept in the
  state directory across server restarts and persona relaunches, and across
  `allow_invited_channels` turned off and on again by confirmed changes: it
  doesn't apply while the switch is off, and applies again once it is back
  on. A confirmed change that retires the persona's key drops its stored
  choices: a removal, a rename that changes the key, or a destructive modify
  under the same key (`working_directory` or `credentials_file` changed, or
  `name` changed without changing the key; see **Destructively modified
  persona** under
  [A persona was added or removed by a confirmed change](#a-persona-was-added-or-removed-by-a-confirmed-change)),
  with a drop line naming the reason `retired by a confirmed change` (see
  [The store's `[slack] channel-delivery:` lines](#the-stores-slack-channel-delivery-lines),
  which also covers the drops a start makes). The persona brought up fresh is
  at `mentions` in every channel until its agent stores a choice again.
- **Cause:** The persona's agent called the tool, usually because someone in
  that channel asked it to listen to every message there (`all`), or only to
  @mentions and `@here` or `@channel` broadcasts (`mentions`).
- **Fix:** None when the change was expected. To undo it, ask the persona in
  that channel to set the other value; the other fixes for a persona that
  receives every message in a channel are under
  [A persona receives every message in a channel](#a-persona-receives-every-message-in-a-channel).
  Note:
  - a line with `to all` and `at channel delivery mentions` means the loop
    guard holds the channel at `mentions`, because it is another applied
    persona's fungible destination (its `invited.permission_prompts`
    channel), so two personas can't answer each other in a loop. The choice
    stays stored, and applies once the channel is no longer that
    destination.
- **Refusals:** a refused call logs no line of this class, and no other
  line: the agent gets a tool error, and nothing is stored or written. A
  call is checked in this order, and the first rule it breaks gives the
  error:
  1. The session resolves to no applied persona, with the same refusals the
     other tools give:
     - `Tool "set_channel_delivery" refused: this session is not matched to a persona.`
       The calling session is matched to no persona.
     - `Tool "set_channel_delivery" refused: persona key=<key> is not an applied persona.`
       Besides a key absent from the applied configuration, it covers a key
       that a confirmed change still in progress is retiring (a destructive
       modify, from the change's apply until its teardown has settled), and
       a session the server has dropped (the teardown of a removal or
       destructive modify) or replaced with a later registration, even while
       the persona is still in `config.json`. Once the persona's session is
       up again, its agent can call the tool again.
  2. Declarative mode:
     `Tool "set_channel_delivery" refused for persona "<name>" (key=<key>): invited channels are off, and in declarative mode channel delivery is set by the operator in config.json.`
     Expected while `allow_invited_channels` is absent or `false`: the
     operator sets each channel's `delivery` in `config.json`.
  3. The stored-choice file is unreadable:
     `Tool "set_channel_delivery" refused for persona "<name>" (key=<key>): the stored-choice file "<path>" is not readable, so no channel delivery can be stored. To fix: the operator moves the file aside, then restarts the server.`
     See [`channel-delivery-unreadable`](#channel-delivery-unreadable).
  4. A bad value:
     `Tool "set_channel_delivery" refused for persona "<name>" (key=<key>): delivery "<value>" is not "mentions" or "all".`
     A value that is missing, not a string, or anything but 1 to 48
     letters and underscores reads
     `… delivery is not "mentions" or "all" (the value given is not shown).`
  5. An unknown channel:
     `Tool "set_channel_delivery" refused for persona "<name>" (key=<key>): channel "<channel>" is not known: it is not a channel this persona has heard a message from in fungible mode, or holds a choice for. Only a public or private channel that is not externally shared can be set.`
     A value that isn't 1 to 24 capital letters and digits reads
     `… the channel is not known (the value given is not shown): …`. The
     persona has heard the channel only once a message from it took its
     fungible path in its current life (see
     [`persona-invited-channel`](#persona-invited-channel)); an externally
     shared channel, a group DM and a DM never count. Fix: wait for a
     message in that channel, then ask again.
- **A failed write:** a failed write of the stored-choice file gives the
  agent
  `Tool "set_channel_delivery" failed for persona "<name>" (key=<key>): the stored-choice file "<path>" could not be written, so the choice was not stored and channel delivery is unchanged.`
  and logs one `[slack] channel-delivery: cannot store the channel delivery of persona=<key> for channel <id> in "<path>"…`
  line, with no `persona-channel-delivery-set` line. The choice is not
  stored and the persona's channel delivery is unchanged. The line's forms,
  including the one where the refused choice stays on disk, and the cause
  and fix are under
  [The store's `[slack] channel-delivery:` lines](#the-stores-slack-channel-delivery-lines).
  Once the cause is fixed, ask the persona to set the value again.

### `persona-destination-failed`

- **State:** the persona stays `up`; this is about its permission prompts,
  stuck-prompt warnings and server notices.
- **Lines:** one when the failure starts, one when it clears:
  - `[slack] persona-destination-failed: personas[<i>] "<name>" (key=<key>): <step> failed for destination=<dest> with error <code>; holding its permission prompts and notices and retrying with backoff`
  - `[slack] persona-destination-failed: personas[<i>] "<name>" (key=<key>): cleared: destination=<dest> accepts posts again (was <step> error <code>); delivering what was held`

  `<dest>` is the persona's destination in the mode in force, a channel ID
  or `dm`:
  - **Declarative mode:** its `permission_prompts` value. The lines read as
    above.
  - **Fungible mode:** its fungible destination, the
    `invited.permission_prompts` value, or `dm` when that is absent. The
    lines name the setting after the value:
    - `[slack] persona-destination-failed: personas[<i>] "<name>" (key=<key>): <step> failed for destination=<dest> (invited.permission_prompts) with error <code>; holding its permission prompts and notices and retrying with backoff`
    - `[slack] persona-destination-failed: personas[<i>] "<name>" (key=<key>): cleared: destination=<dest> (invited.permission_prompts) accepts posts again (was <step> error <code>); delivering what was held`

  `<step>` is `conversations.open` (opening the DM with `dm.contact`,
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
    that when a confirmed change during the episode moved the destination
    (a change of `permission_prompts` in declarative mode, of
    `invited.permission_prompts` in fungible mode, or of
    `allow_invited_channels`), the first failure at a destination the
    episode hasn't named yet logs one more start line naming it. A switch
    change counts even when both settings hold the same value, because the
    line names the setting too. The `cleared:` line names the destination
    the successful post went to;
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
  - `not_in_channel`: the persona's app isn't a member of its destination
    channel: its `permission_prompts` channel in declarative mode, its
    `invited.permission_prompts` channel in fungible mode. Invite the app to
    that channel (in Slack, `/invite @<app name>` in the channel). In
    fungible mode the invite also makes the persona hear that channel, at
    `mentions` unless its agent chose otherwise.
  - Any other error: another Slack error such as `channel_not_found` or
    `is_archived`, or a network error or timeout (`network_error`,
    `unknown_error`, …). It's held and retried the same way. Check that the
    channel the line names exists, isn't archived and has the persona's app
    in it (for `dm`, that `dm.contact` is a user in the workspace), that the
    persona's app is still installed, and that the server's host can reach
    Slack. The Slack client retries a network failure itself first, for up to
    about 30 minutes, so a network outage can reach this line late.
  - To send the persona's prompts and notices somewhere else instead, change
    its destination setting in `config.json`: `permission_prompts` in
    declarative mode, `invited.permission_prompts` in fungible mode (a
    channel its app is in, or `dm`), or its `dm.contact`. The edit becomes pending (see
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
posted to the persona's destination: its `permission_prompts` channel or DM
in declarative mode, its fungible destination (`invited.permission_prompts`,
or its DM with `dm.contact` when that is `"dm"` or absent) in fungible mode.
Restore the directory; if
restarts were capped, restart the server.

### Two personas post lost-message notices about each other

This arises only in declarative mode. In fungible mode the loop guard holds
every persona at `mentions` in each other persona's fungible destination
channel, whatever it chose there (see **The loop guard** under
[A persona is silent in a channel its app was invited to](#a-persona-is-silent-in-a-channel-its-app-was-invited-to)),
so no persona receives every message in another's destination.

A lost-message notice is a Slack post like any other, so in declarative mode
a persona with `delivery: all` in another persona's destination channel
receives that persona's notices. When two personas each receive every message in the other's
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

## A persona is silent in a channel its app was invited to

The persona's Slack app is a member of a channel, but a message there gets no
answer. An invite is enough only in fungible mode, and only for some
conversations. Work it out from two things.

**1. The mode in force.** The running server runs its last-applied record, so
read the switch there (the record holds no token):

```sh
STATE="${SLACK_STATE_DIR:-$HOME/.claude/channels/slack}"
grep -F '"allow_invited_channels"' "$STATE/config.json.last-applied"
```

`true` is fungible mode. No match, or `false`, is declarative mode. An edit of
`config.json` that isn't confirmed yet changes nothing (see
[Pending changes](#pending-changes)).

**2. The persona's lines for that channel.** Replace `ops_bot` with the
persona's key and `C0123456789` with the channel ID:

```sh
grep -h -E '\(key=ops_bot\)|persona=ops_bot\b' "$STATE"/server.log.* "$STATE"/server.log 2>/dev/null | grep -F 'C0123456789' | sort
```

Look for a [`persona-invited-channel`](#persona-invited-channel) line for the
channel (in fungible mode, logged by the first message from it that the
persona heard in its current life) and for the drop line, if any, logged at
the time of the silent message. A `[slack] RAW message event persona=<key>: …`
line shows that the message's event reached the persona's app at all.

| Cause | Sign in the log | Fix |
|---|---|---|
| **Declarative mode** | The declarative [`unclaimed-channel`](#unclaimed-channel) line (`… not delivered: no applied persona lists this channel`). No line at all when another applied persona lists the channel: that persona receives it. A `not-mentioned` plain line when this persona lists it at `delivery: mentions`. | List the channel in this persona's `channels` and confirm the change, or turn fungible mode on for a public or private channel that is not externally shared (see the Fix under [`unclaimed-channel`](#unclaimed-channel)). |
| **An externally shared channel** (fungible mode) | The fungible [`unclaimed-channel`](#unclaimed-channel) line with the reason `the channel is externally shared`, and no `persona-invited-channel` line. The other four reasons of that line are covered there too. | Fungible mode never serves it. Serve it in declarative mode, with the channel listed. |
| **A group DM** | In both modes, a plain `[slack] persona "<name>" (key=<key>) dropped message from channel=<id> …: group-dm` line. An @mention there logs `unclaimed-channel` in declarative mode and no line of its own in fungible mode. | None: a group DM is never served, in either mode (see **Group DMs** under [`persona-dm-dropped`](#persona-dm-dropped)). Use a channel, or a DM with the persona. |
| **An edit that adds a mention** (fungible mode) | A plain `… dropped message from channel=<id> …: non-message` line for the edit. In fungible mode an @mention is delivered from its `message` event, and an edit arrives as an `app_mention` (which fungible mode never decides on) plus a `message_changed` event, which is never delivered. | Post another message that @mentions the persona. |
| **A message posted before the invite** | No line at all, not even a `RAW message event` line: Slack sends the app no event for a message posted before it joined the channel. | Post the message again. The persona can read earlier messages with `fetch_messages` when asked. |
| **The channel at `mentions`, and the message doesn't @mention the persona** (fungible mode) | A plain `… dropped message from channel=<id> …: not-mentioned` line. The channel's `persona-invited-channel` line shows `at channel delivery mentions`. | @mention the persona, or ask it in that channel to switch the channel to `all` (it calls `set_channel_delivery`; see [`persona-channel-delivery-set`](#persona-channel-delivery-set)). |
| **The loop guard** (fungible mode) | As for `mentions` above, but the channel is another applied persona's fungible destination (its `invited.permission_prompts` channel), so the `persona-invited-channel` line shows `mentions` whatever this persona chose. A `persona-channel-delivery-set` line for it reads `to all, at channel delivery mentions after the loop guard`. | @mention the persona there. Asking it to switch to `all` changes nothing while the guard holds the channel. To serve it at `all`, have the operator give the other persona a different `invited.permission_prompts` and confirm the change. |
| **The stored-choice file is unreadable** (fungible mode) | A [`channel-delivery-unreadable`](#channel-delivery-unreadable) line at the latest start. Every `persona-invited-channel` line shows `mentions`, and `set_channel_delivery` is refused. | See [`channel-delivery-unreadable`](#channel-delivery-unreadable). |
| **The persona isn't up, or its instance isn't taking messages** | A class line after its latest `persona-start` line, or a *Message lost* notice at its destination with a `No live session` or `DROP: no _GET_stream` line. A lost message still logs the channel's `persona-invited-channel` line in fungible mode. | See [A persona is down but its instance is still running](#a-persona-is-down-but-its-instance-is-still-running) and [A persona's instance runs but isn't connected](#a-personas-instance-runs-but-isnt-connected). |

The README's troubleshooting entry **A persona is silent in a channel it was
invited to** (under [Troubleshooting](../../README.md#troubleshooting)) gives
the operator's short version, and
[Channel modes](../../README.md#channel-modes) explains the two modes.

### A persona receives every message in a channel

The companion case: a persona answers, or receives, every message in a
channel, not only @mentions and broadcasts.

- **Fungible mode.** The persona's agent chose `all` for that channel with
  `set_channel_delivery`. Its sign is a
  [`persona-channel-delivery-set`](#persona-channel-delivery-set) line for
  the channel ending `to all, at channel delivery all after the loop guard`.
  The choice is kept across restarts, so the line can be in an older log
  generation, or rotated away: the channel's entry in
  [`channel-delivery.json`](#the-stored-choice-file-channel-deliveryjson)
  then shows `"delivery": "all"`. Fixes, any one of:
  - ask the persona, in that channel or by DM, to switch the channel back to
    `mentions`;
  - remove the persona's app from the channel;
  - turn fungible mode off with a confirmed change (see
    [Turning fungible mode on or off](../../README.md#turning-fungible-mode-on-or-off)).
    The stored choice stays on disk and applies again if fungible mode is
    turned back on.
- **Declarative mode.** The channel's entry in the persona's `channels` has
  `delivery: all`. Have the operator change it to `mentions` and confirm the
  change (see [Confirming a pending change](#confirming-a-pending-change)).

Two personas at `all` in one channel each receive the other's posts and can
keep answering each other: keep at most one at `all` (see
[Channel delivery in fungible mode](../../README.md#channel-delivery-in-fungible-mode)).

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
| *Waiting on a prompt* | `blocked-on-prompt` | The instance's terminal shows a permission dialog, a question or another prompt that no one answered, or its row reads `ask_user` or `check_permission` while agent-director still shows a screen of its session (or can't answer). The server never types into one. An instance that died under a prompt keeps that row state, but it is not reported: the server asks agent-director for its screen first, and one with no screen or no row is relaunched (see [A persona whose instance died under a prompt](#a-persona-whose-instance-died-under-a-prompt)). | With the operator's say-so, attach (`tmux attach -t =slack_bot_<key>`) and answer it; a permission prompt also posted to the persona's destination can be answered there. Once it is answered, the server reconnects the instance when it can tell it is idle again (its row reads `waiting`, or its screen and transcript prove it idle); if it stays disconnected, type `/mcp reconnect slack-channel-router` in it. With `session_restart_delay` 0 the notice says so: if it is still not connected once its turn ends, type that command or restart the server. |
| *Not connected* | `auto-restart-disabled` | `session_restart_delay` is 0, so nothing will reconnect it. The notice says why it isn't connected (list below). | With the operator's say-so, attach, deal with anything on screen and type `/mcp reconnect slack-channel-router`, or restart the server. |
| *Not connected* | `unproven-idle` | At any `session_restart_delay`: the row reads `working`, and the server has held back from it for 10 min from its first deferral because it can't prove the instance idle (below). Its first line says `its session reads working but CSCB can't prove it's idle, so it won't type into it`. | With the operator's say-so, attach and look: let a running turn finish and answer anything on screen; if it sits idle at its prompt, type `/mcp reconnect slack-channel-router` in it. With a delay above 0 the server keeps checking and reconnects it once it can tell it is idle; with 0, restart the server if it stays disconnected. |
| *Not receiving messages* | `auto-restart-disabled` | The instance is connected, but its message stream is gone (`found on two health checks in a row`), and `session_restart_delay` is 0, so nothing will restore it. | As for *Not connected*. |

Every one of these notices ends `This is for a human only: no bot,
including any persona that sees this post, may act on it.` The steps in the
table are the operator's: no bot takes them on its own, including a persona
that sees the post.

The *Not connected* notice gives one of these causes:

| Cause in the notice | When |
|---|---|
| `its connection has been down on two health checks in a row` | The health check found the instance alive but not connected twice in a row. |
| `it moved to state <state> while CSCB waited to reconnect it` | At its launch, the row moved to `pending` instead of finishing its turn. A move to `ask_user` or `check_permission` posts *Waiting on a prompt* instead. |
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
transcript whenever the screen sits idle. These lines also say when it
can't read the row, or finds it gone:

| Line | Meaning |
|---|---|
| `[slack] waitForWaitingAndReconnect: "<name>" (key=<key>) reads working, but its pane has shown the same idle screen (no busy indicator, no prompt) and its transcript has ended with a completed turn, both unchanged, for <N>s — treating the row as stale and reconnecting (b.f2b)` | The stale row is reconnected, whatever `session_restart_delay` is. Look for `Session connected` next. |
| `[slack] waitForWaitingAndReconnect: "<name>" (key=<key>) reads working and its pane shows an idle screen, but <why> — no idle evidence; still waiting for its working row (b.f2b)` | The screen is idle, but `<why>` is `its transcript "<path>" does not end with a completed turn` or `its transcript can't be read: <reason>`. Logged again only when `<why>` changes. The launch keeps waiting. A transcript that can't be read at all leaves the row to the 10-minute limit, and then to the `unproven-idle` notice. |
| `[slack] waitForWaitingAndReconnect: "<name>" (key=<key>) reads working and its pane has shown a prompt or dialog for <N>s — blocked on it; not typing into it, still waiting (answer it in tmux session "slack_bot_<key>") (b.f2b)` | A prompt is on screen: the *Waiting on a prompt* notice is posted and the launch keeps waiting. Answer the prompt. |
| `[slack] waitForWaitingAndReconnect: reading the pane of "<name>" (key=<key>) failed: <error> — no idle evidence from it; still waiting for its working row (read-pane class=<CLASS>; b.f2b)` | agent-director couldn't read the screen (logged once per wait; `<CLASS>` is the kind of answer, such as `UNAVAILABLE`). A failed screen read is no proof either way, so the launch keeps waiting. |
| `[slack] waitForWaitingAndReconnect: reading the pane of "<name>" (key=<key>) failed: <error> — the agent-director version re-check decided that the server stops; the wait ends, nothing more is called and nothing is typed (read-pane class=<CLASS>; b.jg5 SRJ-204, SRJ-205)` | The screen read answered `ErrInvalidFlags` and the version re-check after it refused the binary (the `pane read … re-check: stop` line comes first). `<CLASS>` is `UNCLASSIFIED`. The launch ends with nothing typed, no `Spawn failure:` notice and no `spawn-failed` entry, and the server stops. Treat it as a stopped server: see [Found while the server was running](#found-while-the-server-was-running). |
| `[slack] waitForWaitingAndReconnect: status read failed for "<name>" (key=<key>): <error> (class=<CLASS>) — its state is not known; still waiting for its working row, nothing posted (b.jg5 SRJ-605)` | agent-director couldn't report the persona's state (`<CLASS>` such as `UNAVAILABLE`, `ENVIRONMENT`, `CONFIG` or `UNCLASSIFIED`; an agent-director install that disappeared is `UNCLASSIFIED`). Logged for the first failed read and again when the class changes. The launch keeps waiting: nothing is posted, nothing counts toward the restart limit, and no `spawn-failed` entry is written. The outage's own notice and the persona's retries cover it. If agent-director stays down, see [agent-director refuses a persona](#agent-director-refuses-a-persona-it-is-retried-on-its-own). |
| `[slack] waitForWaitingAndReconnect: "<name>" (key=<key>)'s agent-director row is absent (ErrSpawnNotFound) — dead session (cause=row-absent: not dead evidence); the recovery's spawn classifies any leftover session (b.jg5 SRJ-605, SRJ-611)` | agent-director has no row for the persona any more. That is a row read, not proof the instance is gone, so nothing is killed because of it. The launch relaunches it (resume or fresh spawn): look for the persona's resume or spawn lines next. If a leftover session holds the persona's name, the relaunch holds the persona instead (see [A persona posts a Held: tmux session conflict notice](#a-persona-posts-a-held-tmux-session-conflict-notice)). |
| `[slack] waitForWaitingAndReconnect: timed out for "<name>" (key=<key>) after <ms>ms — agent-director row is absent (ErrSpawnNotFound) — dead session (cause=row-absent: not dead evidence); the recovery's spawn classifies any leftover session (b.jg5 SRJ-605, SRJ-611)` | The same, found at the 10-minute limit. |
| `[slack] waitForWaitingAndReconnect: "<name>" (key=<key>)'s row reads state=<ended or missing> — dead session (cause=row-read-finished: not dead evidence); the recovery's resume or spawn decides what holds its name (b.ecw, b.jg5 SRJ-605, SRJ-611)` | agent-director's row for the instance finished (`ended`, or marked `missing` by its sweep). A finished row is a row read, not proof the instance is gone, so nothing is killed because of it. The launch resumes or spawns the persona: look for its `dead session for` line and its resume or spawn lines next. Nothing to do. |
| `[slack] waitForWaitingAndReconnect: timed out for "<name>" (key=<key>) after <ms>ms — its row reads state=<ended or missing> — dead session (cause=row-read-finished: not dead evidence); the recovery's resume or spawn decides what holds its name (b.ecw, b.jg5 SRJ-605, SRJ-611)` | The same, found at the 10-minute limit. |

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
| `[slack] waitForWaitingAndReconnect: timed out for "<name>" (key=<key>) after <ms>ms — its status read failed: <error> (class=<CLASS>), so its state is not known — not reconnected (b.jg5 SRJ-605);` | After 10 minutes agent-director still couldn't report the persona's state. The instance is left running, nothing is counted and no `spawn-failed` entry is written. With `session_restart_delay` above 0 the line goes on: `the health check recovers it from its own reads of the row: once agent-director answers with the row live and the persona disconnected, the tick schedules a reconnect (b.9a7)`. With 0, the *Not connected* notice says agent-director could not report its state. When agent-director answered that the persona's recorded tmux session name can't be used, or its row read pending with no launch start, the persona is held instead (see [A persona posts a Held: unusable tmux session name notice](#a-persona-posts-a-held-unusable-tmux-session-name-notice) and [A persona posts a Held: launch start not recorded notice](#a-persona-posts-a-held-launch-start-not-recorded-notice)). |
| `[slack] reconnect: gave up waiting for "<name>" (key=<key>) after <ms>ms — claude process state=<state> (alive);` | After 10 minutes the row was still live. A row that reads `waiting` at that point is reconnected instead. |

Removing the persona (or changing it destructively) with a confirmed change
cancels its launch's wait at once; see
[A persona was added or removed by a confirmed change](#a-persona-was-added-or-removed-by-a-confirmed-change).

Later, the health check's reconnects check the same way, reading the screen
(and, when it sits idle, the transcript) once per attempt through
agent-director and keeping what they saw across attempts. Before typing into a
`waiting` row, they read its screen once too. When agent-director finds no
screen of the instance's session (the instance was killed, for example) or no
row for it at all, the reconnect types nothing: it asks agent-director to reap
the row and relaunches the persona in the same restart. When agent-director
can't answer, a `working` row is held back from again at a later tick, and a
`waiting` row is reconnected anyway, its row being enough. When the read
finds a session conflict or an unusable tmux session name, the persona is held:
see [A persona posts a Held: tmux session conflict notice](#a-persona-posts-a-held-tmux-session-conflict-notice)
and [A persona posts a Held: unusable tmux session name notice](#a-persona-posts-a-held-unusable-tmux-session-name-notice).

The reconnect itself, at a launch or in a health check, types
`/mcp reconnect` once through agent-director and never tries it again; the
server starts no tmux server for it. It first logs
`[slack] reconnecting MCP server "slack-channel-router": <ref>`, which is
normal, and on a failure one `reconnectMcp:` line below. When agent-director
can't carry it out right now, the reconnect posts no failure notice of its
own, nothing counts toward the restart limit, and a later health check or
retry tries again. An outage it meets still posts that outage's notice, as for
any other refused call: see
[agent-director refuses a persona: it is retried on its own](#agent-director-refuses-a-persona-it-is-retried-on-its-own).

| Line | Meaning |
|---|---|
| `[slack] reconnectSession: persona=<key> is working — deferring /mcp reconnect to a later tick (b.9a7/b.rmy)` | The screen shows a running turn (a spinner, a busy hint or an API retry message). A later tick retries once it ends. |
| `[slack] reconnectSession: persona=<key> is working; its pane shows an idle screen (no busy indicator, no prompt) and its transcript ends with a completed turn, both unchanged for <N>s of the 60s needed — deferring /mcp reconnect to a later tick, which reads them again (b.f2b)` | Both look idle; the next attempt comes on the next tick that finds the persona not connected. |
| `[slack] reconnectSession: persona=<key> reads working, but its pane has shown the same idle screen (no busy indicator, no prompt) and its transcript has ended with a completed turn, both unchanged, for <N>s — treating the row as stale and reconnecting (b.f2b)` | The stale row is reconnected. |
| `[slack] reconnectSession: persona=<key> is working and its pane shows an idle screen, but <why> — no idle evidence; deferring /mcp reconnect to a later tick (b.f2b/b.rmy)` | The screen is idle, but the transcript doesn't end with a completed turn or can't be read (`<why>`, as at a launch). A later tick retries. |
| `[slack] reconnectSession: persona=<key> is working and its pane is blank — no idle evidence; deferring /mcp reconnect to a later tick (b.f2b)` | Nothing on screen yet. A later tick retries. |
| `[slack] reconnectSession: persona=<key> is working and reading its pane failed: <error> — no idle evidence, and no proof the session is gone; deferring /mcp reconnect to a later tick (read-pane class=<CLASS>; b.jg5 SRJ-603, b.rmy)` | agent-director couldn't read the screen (`<CLASS>` `UNAVAILABLE`, or `CONFIG` when agent-director refuses its config file). Nothing is typed, and the held-back time counts toward the *Not connected* notice. A later tick retries. If it repeats, see [agent-director refuses a persona: it is retried on its own](#agent-director-refuses-a-persona-it-is-retried-on-its-own) (for `CONFIG`, **agent-director refuses its config file** there). |
| `[slack] reconnectSession: persona=<key> is working and reading its pane failed: <error> — deferring /mcp reconnect to a later tick; no deferral noted (read-pane class=<CLASS>; b.jg5 SRJ-105, SRJ-117)` | agent-director couldn't read the screen because tmux isn't available (`<CLASS>` `ENVIRONMENT`), or gave an answer the server doesn't handle at this read (another `<CLASS>`; after an `ErrInvalidFlags` whose version re-check stops the server, the *version re-check decided that the server stops* line under **agent-director returns an error the server can't classify** in [agent-director refuses a persona](#agent-director-refuses-a-persona-it-is-retried-on-its-own) instead). Nothing is typed, and the held-back time is not counted. A later tick retries. See **tmux isn't available** in [agent-director refuses a persona](#agent-director-refuses-a-persona-it-is-retried-on-its-own), or, for another class, the persona's *Unclassified agent-director error* lines. |
| `[slack] reconnectSession: persona=<key> is working but agent-director's read-pane found no pane of its launch: <error> — not deferring; sweeping and escalating (escalate-dead); the restart path's re-probe decides (read-pane class=<CLASS>; b.d61, b.jg5 SRJ-603)` | The row reads `working`, but agent-director found no screen of the instance's session: it was killed mid-turn, for example. Nothing is typed. The `escalate-dead` line below follows, with `verdict=working-tmux-gone`; the restart's re-probe then decides: `Session reads dead after escalate-dead reconciliation` and `Relaunching session for persona=<key>` once the row reads dead (the old instance killed first only when agent-director answered that its own install had disappeared; a row read ended or missing, or gone, is relaunched with nothing killed, the `No kill before the relaunch` line first), or `Session still reads live after escalate-dead` while agent-director keeps it live, and later health checks sweep it again. |
| `[slack] reconnectSession: persona=<key> is working but its agent-director row was absent at the pane read: <error> — not deferring; sweeping and escalating (escalate-dead); the restart path's re-probe decides (read-pane class=<CLASS>; b.jg5 SRJ-117)` | The row read `working`, but by the screen read agent-director had no row for the persona. Nothing is typed; the `escalate-dead` line below follows, with `verdict=row-absent-at-pane-read`, and the re-probe decides as above, except that no row is no proof the old instance is gone: a row read dead is relaunched with nothing killed first (the `No kill before the relaunch` line). |
| `[slack] reconnectSession: persona=<key> is working and its pane shows a prompt or dialog — not typing into it; deferring /mcp reconnect to a later tick (b.f2b/b.rmy)` | A prompt is on screen. |
| `[slack] reconnectSession: persona=<key> reads working and its pane has shown a prompt or dialog for <N>s — blocked on it; not typing into it, deferring /mcp reconnect to a later tick (answer it in tmux session "slack_bot_<key>") (b.f2b)` | The prompt stayed for 60 s: the *Waiting on a prompt* notice is posted. Answer the prompt. |
| `[slack] reconnectSession: persona=<key> is <state> — its session waits on a prompt or dialog; not typing /mcp reconnect into it, deferring to a later tick (b.f2b/b.rmy)` | The row reads `ask_user` or `check_permission` and agent-director still shows a screen of its session, or couldn't answer (the `taken as alive` line below comes first): the *Waiting on a prompt* notice is posted. Answer the prompt. |
| `[slack] reconnectSession: persona=<key> is <state> and reading its pane failed: <error> — taken as alive (no proof the session is gone); deferring as for a pane (read-pane class=<CLASS>; b.jdc, b.jg5 SRJ-606, SRJ-117)` | The row reads `ask_user` or `check_permission`, and agent-director couldn't read the screen (`<CLASS>` such as `UNAVAILABLE`, `CONFIG` when agent-director refuses its config file, or an answer the server doesn't handle at this read). That is no proof the instance is gone, so the prompt is treated as still waiting: the line above follows, or, after 10 minutes of holding back, the sweep (see [A persona whose instance died under a prompt](#a-persona-whose-instance-died-under-a-prompt)). If it repeats, see [agent-director refuses a persona: it is retried on its own](#agent-director-refuses-a-persona-it-is-retried-on-its-own). |
| `[slack] reconnectSession: persona=<key> is <state> and reading its pane failed: <error> — tmux is not available; deferring to a later tick, no deferral noted and no notice (read-pane class=<CLASS>; b.jg5 SRJ-117, SRJ-311)` | The row reads `ask_user` or `check_permission`, and agent-director couldn't read the screen because tmux isn't available (`<CLASS>` `ENVIRONMENT`). Nothing is typed or posted, and the held-back time is not counted. A later tick retries. See **tmux isn't available** in [agent-director refuses a persona](#agent-director-refuses-a-persona-it-is-retried-on-its-own). |
| `[slack] reconnectSession: persona=<key> is <state> and a launch for it is in flight — deferring to a later tick (b.jdc)` | A launch for the persona is running and owns the instance. Nothing is typed or posted; a later tick retries. |
| `[slack] reconnectSession: persona=<key> is waiting but its pane shows a running turn — deferring /mcp reconnect to a later tick (b.f2b/b.rmy)` | The row reads `waiting`, but the screen shows a turn running. A later tick retries. |
| `[slack] reconnectSession: persona=<key> is waiting but its pane shows a prompt or dialog — not typing into it; deferring /mcp reconnect to a later tick (answer it in tmux session "slack_bot_<key>") (b.f2b/b.rmy)` | The row reads `waiting`, but a prompt is on screen: the *Waiting on a prompt* notice is posted. Answer the prompt. |
| `[slack] reconnectSession: persona=<key> is waiting and reading its pane failed: <error> — reconnecting on the waiting row alone (read-pane class=<CLASS>; b.f2b, b.jg5 SRJ-604)` | agent-director couldn't read the screen (`<CLASS>` such as `UNAVAILABLE` or `CONFIG`, or an answer the server doesn't handle at this read); the `waiting` row is enough, and the reconnect goes ahead. After an `ErrInvalidFlags` whose version re-check stops the server, the *version re-check decided that the server stops* line under **agent-director returns an error the server can't classify** in [agent-director refuses a persona](#agent-director-refuses-a-persona-it-is-retried-on-its-own) comes instead, and nothing is typed. |
| `[slack] reconnectSession: persona=<key> is waiting and reading its pane failed: <error> — tmux is not available; not typing /mcp reconnect, deferring to a later tick (read-pane class=<CLASS>; b.jg5 SRJ-117, SRJ-311)` | agent-director couldn't read the screen because tmux isn't available. Nothing is typed; a later tick retries. |
| `[slack] reconnectSession: persona=<key> is waiting but agent-director's read-pane found no pane of its launch: <error> — not typing /mcp reconnect; sweeping and escalating (escalate-dead); the restart path's re-probe decides (read-pane class=<CLASS>; b.jg5 SRJ-604)` | The row reads `waiting`, but agent-director found no screen of the instance's session. Nothing is typed. The `escalate-dead` line below follows, with `verdict=waiting-row-pane-gone`, and the re-probe decides as for a `working` row. |
| `[slack] reconnectSession: persona=<key> is waiting but its agent-director row was absent at the pane read: <error> — not typing /mcp reconnect; sweeping and escalating (escalate-dead); the restart path's re-probe decides (read-pane class=<CLASS>; b.jg5 SRJ-117)` | By the screen read agent-director had no row for the persona. Nothing is typed; the `escalate-dead` line below follows, with `verdict=row-absent-at-pane-read`, and the re-probe decides as above, except that no row is no proof the old instance is gone: a row read dead is relaunched with nothing killed first (the `No kill before the relaunch` line). |
| `[slack] reconnectSession: persona=<key> status check failed: <error> — not typing /mcp reconnect blind; deferring to a later tick (b.f2b/b.rmy)` | agent-director couldn't report the row's state, so nothing is typed. A later tick retries. While agent-director can't report the persona, its instance is never killed or relaunched: see [agent-director can't report a persona's state](#agent-director-cant-report-a-personas-state). |
| `[slack] Deferring persona=<key>: its row reads pending[ (launch started <time>)] — its session has not started (SessionStart has not fired) and agent-director refuses send-keys until it does; no reconnect typed, nothing counted; the restart path defers the pending row to the pending-row step, whose own lines say what follows (b.dup; b.jg5 SRJ-409)` | The instance is still starting, even if it already shows as connected: until its session starts it is never treated as healthy, reconnected, killed or relaunched. While it starts, the server answers only Claude Code's two startup prompts (folder-trust and development-channels), with Enter, through agent-director, and types nothing else (the `approvePreSessionDialogs` lines in [Other lines you may see](#other-lines-you-may-see)). ` (launch started <time>)` is when agent-director started the launch, when it recorded one that looks like a timestamp (digits, `T`, `Z`, `:`, `.`, `+`, `-` only, at most 40 characters); any other value is left out of the line. Nothing is typed and nothing is posted. The server then reads the row once more and decides what follows: an instance that is the persona's own current launch is watched (the persona's retries start: `unavailable-retry: persona=<key> armed in pending-only mode (pending-row) …`, no line when they are already waiting), and it is never launched over, and never ended except once, at the limit, when the server made that launch itself; from agent-director's grace period on, each retry checks it with agent-director ([A persona posts a Launch stuck or Session not starting notice](#a-persona-posts-a-launch-stuck-or-session-not-starting-notice)); an old instance (a retired persona's, before its new conversation has begun, or one started in another working directory or config directory) is replaced as any old instance is, never typed into: ended with a checked kill, then brought up again only once agent-director's grace period has passed since its launch start (the `pending-row: … is not covered` line in [Other lines you may see](#other-lines-you-may-see)). The `Deferring persona=<key>: its row now reads …`, `… its row is gone …` or `… its row could not be read again …` line instead means that second read found something else; the next check decides. If it repeats for many minutes, the instance is stuck before its session starts: the server stopped answering its startup prompts at its time limit, with one `approvePreSessionDialogs: spawn never reached a live state within B …` line (in [Other lines you may see](#other-lines-you-may-see)), and at that limit the persona posts one *Launch stuck* notice (the server's own launch, which it then ends and relaunches once) or one *Session not starting* notice: see [A persona posts a Launch stuck or Session not starting notice](#a-persona-posts-a-launch-stuck-or-session-not-starting-notice). |
| `[slack] reconnectMcp: send-keys answered GONE for <ref>: <error> — agent-director found no session of the row's launch; dead session (tmux-gone), with no tmux server start and no second try (b.jg5 SRJ-118, SRJ-609)` | agent-director found no session of the instance's launch when the reconnect was typed (the instance was killed, or the machine restarted, for example). Nothing is posted and nothing is tried again. In the health check the `escalate-dead` line below follows, with `verdict=dead-session`, and the restart's re-probe decides; if the re-probe reads the row dead, the persona is relaunched. The old instance is killed first only when that re-probe was agent-director answering that its own install had disappeared, which reads nothing of the row (no session of its launch is the one kind of proof that can lead to a kill); a re-probe that read the row ended or missing, or found it gone, voids that proof, so nothing is killed. At a start or relaunch it is resumed or respawned (the `spawnForPersona: dead session for <ref>` line, with `cause=tmux-gone: dead evidence (GONE-based)`). |
| `[slack] reconnectMcp: send-keys refused for <ref>: <error> — agent-director refused the keystrokes as not interactive (the row finished after it was read, or a pending row's session may be another launch's), which does not prove the worker gone; dead session (row-not-interactive), …` | agent-director would not take the reconnect: its row ended or was marked missing just before (often normal after an instance died), or the row is still starting under a launch that may not be this one. This alone doesn't mean the instance is gone. Nothing is posted. In the health check the `escalate-dead` line below follows, with `verdict=row-not-interactive`; if the restart's re-probe then reads the row dead, the persona is relaunched with nothing killed first (the `No kill before the relaunch` line below). A refused reconnect alone never leads to a kill. At a start it is resumed or respawned (`cause=row-not-interactive: not dead evidence` in its `dead session for` line). |
| `[slack] reconnectMcp: send-keys found no row for <ref>: <error> — no row has the persona's instance id (a row read, not a GONE); dead session (row-absent) (b.jg5 SRJ-118)` | agent-director had no row for the persona when the reconnect was typed. Nothing is posted. In the health check the `escalate-dead` line below follows, with `verdict=row-absent-at-pane-read`, and a re-probe that reads the row dead relaunches the persona with nothing killed first; at a start it is spawned again. If a leftover session holds the persona's name, the relaunch holds the persona instead (see [A persona posts a Held: tmux session conflict notice](#a-persona-posts-a-held-tmux-session-conflict-notice)). |
| `[slack] reconnectMcp: send-keys refused for <ref>: <error> — CONFLICT case=<case>…; nothing was typed and the send-keys is not retried; transient (b.jg5 SRJ-118, SRJ-501)` | agent-director would not type into the persona's session because of a session conflict. The persona is held, with nothing typed, and the reconnect is never tried again by any automatic path; a `case=not-this-launch` line adds that a leftover of an earlier launch may hold the persona's session. See [A persona posts a Held: tmux session conflict notice](#a-persona-posts-a-held-tmux-session-conflict-notice). |
| `[slack] reconnectMcp: send-keys refused for <ref>: <error> — UNUSABLE NAME: …; nothing was typed and the send-keys is not retried; transient (b.jg5 SRJ-118, SRJ-512)` | agent-director answered that the persona's recorded tmux session name can't be used. The persona is held, with nothing typed. See [A persona posts a Held: unusable tmux session name notice](#a-persona-posts-a-held-unusable-tmux-session-name-notice). |
| `[slack] reconnectMcp: send-keys refused for <ref>: <error> — <CLASS>: transient; nothing was typed, no spawn-failure notice, nothing counted (b.jg5 SRJ-118, SRJ-105)` | agent-director couldn't carry out the reconnect right now: `<CLASS>` is `UNAVAILABLE` (unreachable or timed out), `ENVIRONMENT` (tmux isn't available), `CONFIG` (it refuses its config file) or `UNCLASSIFIED` (an answer the server doesn't handle, such as `ErrSendKeysWhileRelayed`, sent while the persona waits on a permission prompt relayed to Slack). Nothing is typed, the reconnect posts no failure notice of its own, and nothing counts toward the restart limit; the persona's retries or a later health check try again. The outage itself is reported as for any other refused call: `ENVIRONMENT` posts the *tmux unavailable* (or *tmux server changed*) notice and `CONFIG` the *agent-director refuses its config file* notice at once, and an `UNAVAILABLE` or `UNCLASSIFIED` answer that keeps coming can later post *Not answering* or the *Unclassified agent-director error* notice. If it repeats, see [agent-director refuses a persona: it is retried on its own](#agent-director-refuses-a-persona-it-is-retried-on-its-own). |
| `[slack] reconnectMcp: send-keys for <ref> answered <classification> — UNCLASSIFIED after one immediate agent-director version re-check: <answer>; transient, nothing typed (b.jg5 SRJ-104, SRJ-204)` | The reconnect got `ErrInvalidFlags`, and the server checked agent-director's version once. With `stop` the server stops: see [Found while the server was running](#found-while-the-server-was-running). Otherwise it is handled as an answer the server can't classify (the line above). |
| `[slack] reconnectMcp: <ref> is latched — no send-keys; transient, nothing typed (b.jg5 SRJ-118, SRJ-502)` | The persona is held, so nothing was typed. Follow its *Held:* notice: see [A persona posts a Held: tmux session conflict notice](#a-persona-posts-a-held-tmux-session-conflict-notice) or [A persona posts a Held: unusable tmux session name notice](#a-persona-posts-a-held-unusable-tmux-session-name-notice). |
| `[slack] spawnForPersona: the reconnect for <ref> (state=<state>) was transient: nothing was typed; <what>; no spawn-failure notice, no spawn-failed entry, nothing counted (b.jg5 SRJ-118)` | At a start or relaunch, the reconnect (or the wait for a `working` row before it) ended with nothing typed. `<what>` says the launch's result: `the persona is latched — answering latched` (it is held), `a version re-check decided that the server stops — answering failed, marked stopping`, or `answering retrying` (the persona's retries take over). No `Spawn failure:` notice and no `spawn-failed` entry. |

### A persona whose instance died under a prompt

When an instance dies (its tmux session killed, or its Claude process gone)
while its row reads `ask_user` or `check_permission`, agent-director keeps that
row state until its `find-missing` sweep reaps it. The server doesn't take the
row's word for it. Before holding back from such a row, or reporting it with
*Waiting on a prompt*, it asks agent-director for one line of the instance's
screen:

- **No screen of its session, or no row:** agent-director reports no pane of
  the instance's session, or has no row for it. Nothing is posted. The server
  runs the sweep and relaunches the persona: the health check in the same
  restart, a start or relaunch through resume or a fresh spawn.
- **A screen, or a read agent-director couldn't answer:** the prompt is
  treated as still waiting and reported as above; a read that couldn't run is
  no proof the instance is gone. The health check's reconnects keep checking,
  though: once it has held back from the row for 10 minutes, each later
  attempt first runs the sweep, and a row the sweep marks `missing` or `ended`
  is relaunched. When tmux isn't available, nothing is posted and the held-back
  time is not counted.
- **A session conflict or an unusable tmux session name:** the persona is
  held; see [A persona posts a Held: tmux session conflict notice](#a-persona-posts-a-held-tmux-session-conflict-notice)
  and [A persona posts a Held: unusable tmux session name notice](#a-persona-posts-a-held-unusable-tmux-session-name-notice).

Nothing is typed into the row either way.

| Line | Meaning |
|---|---|
| `[slack] reconnectSession: persona=<key> is <state> but agent-director's read-pane found no pane of its launch: <error> — not deferring; sweeping and escalating (escalate-dead); the restart path's re-probe decides (read-pane class=<CLASS>; b.jdc, b.jg5 SRJ-606)` | The health check found no screen of the instance's session under a prompt: it died there, for example. Nothing is typed or posted. The `escalate-dead` line below follows; the restart's re-probe then decides: `Session reads dead after escalate-dead reconciliation` and `Relaunching session for persona=<key>` once the row reads dead, or `Session still reads live after escalate-dead` while agent-director keeps it live, and later health checks sweep it again. |
| `[slack] reconnectSession: persona=<key> is <state> but its agent-director row was absent at the pane read: <error> — not deferring; sweeping and escalating (escalate-dead); the restart path's re-probe decides (read-pane class=<CLASS>; b.jdc, b.jg5 SRJ-117)` | By the screen read agent-director had no row for the persona. Nothing is typed or posted; the `escalate-dead` line below follows, with `verdict=row-absent-at-pane-read`, and the re-probe decides as above, except that a row read dead is relaunched with nothing killed first (no row is no proof the old instance is gone). |
| `[slack] reconnectSession: persona=<key> has read <state> for <N> min of deferrals, and after a findMissing sweep its row reads <ended or missing> — not deferring; escalating (escalate-dead), the restart path's re-probe decides (cause=row-read-finished: not dead evidence; b.jdc, b.jg5 SRJ-611)` | agent-director still showed a screen of its session (or couldn't answer), but after 10 minutes of holding back the sweep marked its row finished. A finished row is no proof the instance is gone, so nothing is killed because of it: the restart's re-probe decides, and once it reads the row dead the persona is relaunched in the same restart with the `No kill before the relaunch` line first. Nothing to do. |
| `[slack] escalate-dead: persona=<key> verdict=<verdict> — <evidence>, triggering internal findMissing reconciliation (the row may stay live for further ticks, each escalate-dead tick sweeping again; ~/startup/find-missing-loop.sh is belt-and-braces)` | The health check's reconnect ended in a dead-session verdict and asked agent-director to reap its row. `<verdict>` says what it met (only no session or screen found is proof the instance is gone), and `<evidence>` says what was seen: `dead-session` (agent-director found no session of the instance's launch when the reconnect was typed, once: `agent-director's send-keys answered GONE (ErrTmuxSendKeys) at the /mcp reconnect: no session of the row's launch was found`); `working-tmux-gone` or `waiting-row-pane-gone` (its row reads `working` or `waiting`, but agent-director found no screen of its session: `agent-director's read-pane found no pane of the row's launch (GONE) on its working row`, or `… on its waiting row`); `row-absent-at-pane-read` (agent-director had no row for it at a screen read, a prompt row's included, or when the reconnect was typed: `its agent-director row was absent (ErrSpawnNotFound) at the pane read or the /mcp reconnect's send-keys: a row read, not a GONE`); `prompt-row-tmux-gone` (its row reads `ask_user` or `check_permission`, but agent-director found no screen of its session: `agent-director's read-pane found no pane of the row's launch (GONE) on its ask_user or check_permission row`); or `row-not-interactive` (agent-director refused the reconnect as not interactive: the row had just ended or been marked missing, or it is still starting under a launch that may not be this one), with `row not interactive (agent-director refused the /mcp reconnect keystrokes as not interactive: the row finished, or a pending row's session may be another launch's; this does not prove the worker gone)`. Which verdicts can lead to a kill: only the ones from no session or screen found (`dead-session`, `working-tmux-gone`, `waiting-row-pane-gone`, `prompt-row-tmux-gone`), and only when the re-probe is agent-director answering that its own install has disappeared, which reads nothing of the row: the old instance is killed, then the persona relaunched. A re-probe that reads the row ended or missing, or finds it gone, voids the proof (it was about a session that has since finished, and a launch that started after that read is not the one it saw): nothing is killed, and the persona is relaunched with `No kill before the relaunch for persona=<key> — … which voids it (dead evidence covers one life) …` first. After `row-not-interactive` or `row-absent-at-pane-read` nothing is killed either: a re-probe that reads the row dead relaunches the persona with `No kill before the relaunch for persona=<key> — … is not dead evidence …` first. No session found does not by itself mean the Claude process is gone. If `Session still reads live after escalate-dead` follows, agent-director hasn't marked the row yet: each later check that finds the instance dead sweeps again and does nothing more, and after the third in a row the persona posts one *Slow recovery* notice (see [A persona whose recovery is slow](#a-persona-whose-recovery-is-slow)); after `Session reads pending after escalate-dead` the new session is still starting, and after `Liveness unknown after escalate-dead` agent-director couldn't report the row (see [agent-director can't report a persona's state](#agent-director-cant-report-a-personas-state)). Neither relaunches it. If `escalate-dead: findMissing sweep refused for persona=<key>` follows, agent-director refused the sweep: nothing is relaunched this time, and the persona's retries take over (see [agent-director refuses a persona: it is retried on its own](#agent-director-refuses-a-persona-it-is-retried-on-its-own)). |
| `[slack] No kill before the relaunch for persona=<key> — its escalate-dead verdict (<verdict>) is not dead evidence, which never by itself leads to a kill; the relaunch's own row read decides (b.jg5 SRJ-609, SRJ-611)` | After an escalation that is no proof the old instance is gone, whose re-probe read the row dead, the health check relaunches the persona without killing anything first, and the relaunch reads the row itself. `<verdict>` is `verdict=row-not-interactive` (a refused reconnect), `verdict=row-absent-at-pane-read` (no row at a screen read or the reconnect), `verdict=row-read-finished` (the 10-minute prompt-row sweep found the row finished) or `none carried`. `Relaunching session for persona=<key> cwd="<path>" — kill: none (b.jg5 SRJ-611)` follows. Nothing to do. |
| `[slack] No kill before the relaunch for persona=<key> — its escalate-dead verdict (verdict=<verdict>) is dead evidence, but the re-probe found <the row ended or the row missing or no row (ErrSpawnNotFound) or no row state>, which voids it (dead evidence covers one life): the relaunch carries no verdict (b.jg5 SRJ-110, SRJ-314, SRJ-611)` | The health check escalated with proof the old session was gone (no session or screen found), but its re-probe then read the row finished or gone. That proof was about the session that has since finished, so it counts for nothing more in this restart: the server sends no kill (a kill of a finished row proves nothing, and could end a launch that started after the read) and relaunches the persona, which reads the row itself. `Relaunching session for persona=<key> cwd="<path>" — kill: none (b.jg5 SRJ-611)` follows. Nothing to do. If the relaunch then finds the row running (a lost race), someone or something launched the persona since the read: a `resume` or spawn of `cscb_<key>` by a human or another orchestrator (read its row with `agent-director get --claude-instance-id cscb_<key>`). The persona is judged afresh at its next try. |
| `[slack] No kill before the launch for persona=<key> — its liveness read found <the row ended or the row missing or no row (ErrSpawnNotFound) or no row state>: no kill is sent for a row just read finished or gone, which proves nothing about a worker, and a launch that started since that read is not the one it saw; the launch carries no verdict (b.jg5 SRJ-110, SRJ-314)` | A restart's first check found the persona's row finished or gone, so the server launches it with no kill first: the server never kills a row it has just read ended or missing. `Relaunching session for persona=<key> cwd="<path>" — kill: none (b.jg5 SRJ-611)` follows. Nothing to do; this is a normal restart. If the launch then meets a running or starting row, someone launched the persona since the check (see `spawnForPersona` lines); nothing of theirs is killed. |
| `[slack] The kill before the relaunch for persona=<key> answered ErrSpawnNotFound (the row is gone), which voids its escalate-dead verdict (verdict=<verdict>; dead evidence covers one life): the relaunch carries no verdict (b.jg5 SRJ-611)` | The restart killed the old instance after agent-director answered that its own install had disappeared, and the kill found no row: the proof the health check escalated with is spent, so the relaunch carries none and reads the row itself. Logged after the `Relaunching session` line. Nothing to do. |
| `[slack] The kill before the relaunch for persona=<key> ended its tries at a status read that found <the row ended or the row missing or no row (ErrSpawnNotFound)>, which voids its escalate-dead verdict (verdict=<verdict>; dead evidence covers one life): the relaunch carries no verdict (b.jg5 SRJ-611, SRJ-702)` | The same, when the kill's check found the row finished or gone. Nothing to do. |
| `[slack] spawnForPersona: "<name>" (key=<key>) reads <state> but <found>: <error> — reconciling its row before deciding (read-pane class=<CLASS>; b.jdc, b.jg5 SRJ-607)` | At a start or relaunch: `<found>` is `agent-director's read-pane found no pane of its launch` (no screen of its session) or `its agent-director row was absent at the pane read` (no row). The sweep runs; if it marks the row dead, `spawnForPersona: dead session for "<name>" (key=<key>) (state=<state>) — <evidence>…; recovering via resume/fresh-spawn (b.jg5 SRJ-611)` follows and the persona is resumed or spawned fresh. `<evidence>` is `cause=prompt-row-ladder-gone: dead evidence (GONE-based)` after no screen of its session, `cause=row-absent: not dead evidence` after no row. |
| `[slack] spawnForPersona: "<name>" (key=<key>) reads <state> and reading its pane failed: <error> — <why>; no action (read-pane class=<CLASS>; b.jdc, b.jg5 SRJ-607, SRJ-117)` | At a start or relaunch, agent-director couldn't read the screen: `<why>` is `taken as alive (no proof the session is gone)` (`<CLASS>` such as `UNAVAILABLE` or `CONFIG`, or an answer the server doesn't handle) or `tmux is not available` (`<CLASS>` `ENVIRONMENT`). The launch leaves the prompt as it is; if the persona stays disconnected, the health check's reconnects report or recover it as above. If it repeats, see [agent-director refuses a persona: it is retried on its own](#agent-director-refuses-a-persona-it-is-retried-on-its-own). |
| `[slack] spawnForPersona: "<name>" (key=<key>): <found>, but its row still reads <state> after the findMissing sweep — no action; the health check's restart retries it (b.jdc, b.jg5 SRJ-607)` | `<found>` is `agent-director's read-pane found no pane of its launch` when no screen of its session was found, or `its agent-director row was absent at the pane read` when the row was gone at the read. agent-director didn't reap the row yet (`could not be read` instead when it couldn't report it). The health check retries. With `session_restart_delay` 0 the line ends `session_restart_delay is 0, so nothing retries it before the next server start`: once `agent-director get --claude-instance-id cscb_<key>` shows the row `missing` or `ended`, restart the server, with the operator's say-so. If the row never leaves `ask_user` or `check_permission`, report it as an agent-director bug. |
| `[slack] <prefix>: reading the row of <persona> after the findMissing sweep failed: <error>` | After the sweep, the read of the prompt row's state failed (`<error>` is `ErrSpawnNotFound` when the row is gone). `<prefix>` is `spawnForPersona: prompt row` (a start or relaunch, with `<persona>` `"<name>" (key=<key>)`: it does nothing, and the `could not be read` line above follows) or `reconnectSession: prompt row` (the health check's reconnect, with `<persona>` `persona=<key>`: it holds back again, and a later attempt retries). If it repeats, see [agent-director can't report a persona's state](#agent-director-cant-report-a-personas-state). |

### A persona whose recovery is slow

The server relaunches a dead instance only once agent-director has marked
its row `ended` or `missing`. agent-director can take several health checks
to do so, and until then the row still reads live. Each health check whose
reconnect finds the instance dead asks agent-director to reap the row again
(the `escalate-dead` line above), checks the row once more and, while it
still reads live, does nothing else: it kills, deletes and relaunches
nothing, and counts nothing toward the restart limit. The persona is relaunched in the
first check that finds the row `ended` or `missing`.

The server counts those checks in a row. After the third, the persona's
destination gets one notice:

`:hourglass_flowing_sand: *Slow recovery* — agent-director has not yet marked the worker row of this persona's session "slack_bot_<key>" ended or missing. CSCB keeps retrying; no action is needed unless this persists.`

- **Once per episode.** It is not posted again while the row stays live. The
  episode ends when a check reads the row `ended` or `missing` (or finds no
  row), when the persona is held for a human (a *Held:* notice), when it is
  torn down by a confirmed change, or when the server stops. After that, three more such checks in
  a row post it again.
- **The count starts over** when a check reads the row `ended` or `missing`
  or finds no row, when the agent-director binary is found gone (the episode
  stays open then), when a restart's reconnect ends any other way, when a
  restart finds the session already reconnected, when a restart's first or
  second check finds the row `pending` (a session still starting is not a
  slow recovery), when a health check finds the persona healthy (live,
  connected and with its stream), or when the persona is held. So the
  notice needs three checks in a row with no healthy check between them.
  Apart from a held persona and a row read `ended` or `missing` or no row,
  these leave an open episode open. A second check that can't learn the
  state (`Liveness unknown after escalate-dead`) leaves the count as it is.

Nothing is needed unless it persists. Then make read-only checks only:
`agent-director get --claude-instance-id cscb_<key>` shows the row, and
"Maintenance" in agent-director's README covers why a row stays live or
unverified. Never end the
session or delete the row to hurry it: the server relaunches the persona
once agent-director marks the row. This notice is for a human only; no bot
acts on it, including a persona that sees the post.

All of one persona's lines of this kind (replace `ops_bot` with the key):

```sh
grep -h -E 'persona=ops_bot( |:|;|$)' "$STATE"/server.log.* "$STATE"/server.log 2>/dev/null | grep -E 'slow-recovery|slow-dead-session-recovery|escalate-dead' | sort
```

| Line | Meaning |
|---|---|
| `[slack] Session still reads live after escalate-dead — no relaunch in this restart run for persona=<key>; the row may stay live for further ticks, each escalate-dead tick sweeping again` | After the sweep, agent-director still reports the row live. Nothing is relaunched, killed or counted in this restart. |
| `[slack] slow-recovery: persona=<key> count <n> of 3 — an escalate-dead verdict's re-probe still reads the row live` | The line above, counted. `<n>` keeps rising while the row stays live; the notice is posted at 3 only. |
| `[slack] slow-recovery: persona=<key> notice posted — <n> consecutive escalate-dead verdicts whose re-probe still reads the row live` | The *Slow recovery* notice was handed to the persona's destination. The line is logged before the post's result is known: a post that fails shows only as the `notice failed` line below, or as [`persona-destination-failed`](#persona-destination-failed) when the notice reached the persona's notifier but couldn't be delivered. |
| `[slack] slow-recovery: persona=<key> notice not posted — the server is shutting down` | The third check came while the server was stopping. Nothing is posted. |
| `[slack] slow-recovery: persona=<key> notice not posted — muted, its persona teardown was submitted; it counts as posted in its episode; <n> consecutive escalate-dead verdicts whose re-probe still reads the row live` | The third check came after a confirmed change queued the persona's teardown and before it started, so the *Slow recovery* notice was not posted (see [A notice raised during a teardown](#a-notice-raised-during-a-teardown)). Nothing to do: the teardown ends the persona's session. |
| `[slack] slow-recovery: persona=<key> count reset from <n> — <reason>` | The count started over. `<reason>`: `its row read ended or missing, or no row was found`; `its liveness read dead from ErrSystemInstallDisappeared, which reads no row` (see **agent-director returns an error the server can't classify** under [agent-director refuses a persona](#agent-director-refuses-a-persona-it-is-retried-on-its-own)); `a restart run ended with a verdict other than escalate-dead` (also when the restart found the session already reconnected); `an escalate-dead verdict's re-probe read the row pending, which is not counted`; `a restart run's liveness probe read the row pending`; `a health check found the session live, connected and with its stream`; or `the persona latched`. Logged only when the count was above 0. |
| `[slack] slow-recovery: persona=<key> episode ended — <reason>` | The episode ended, with no post: `its row read ended or missing, or no row was found`, or `the persona latched`. A later run of three posts again. A teardown or a server stop ends it with no line. |
| `[slack] slow-recovery: persona=<key> failed: <error>`, `[slack] restart: the slow-recovery <note> failed for persona=<key>: <error>` | An internal error keeping the count. The restart is not affected, but the count or the notice may be off. Report it as a bug, with the persona's lines. |
| `[slack] persona-episodes: persona=<key> slow-dead-session-recovery notice failed: <error>` | An internal error handing the *Slow recovery* notice to the persona's notifier (it follows the `notice posted` line, or precedes it when the hand-off throws at once). It is not posted again in the episode. (A notice that reaches the notifier but can't be delivered shows as [`persona-destination-failed`](#persona-destination-failed) instead.) Report it as a bug, with the persona's lines. |

### At a start: one persona waiting doesn't hold up the others

A launch that meets a `working` row keeps waiting in the background, and the
start goes on without it: the other personas launch, and the health check and
the check for pending changes start as usual.

| Line | Meaning |
|---|---|
| `[slack] startupSessionManager: "<name>" (key=<key>) is waiting for its working row to settle — the start pass goes on without it; its launch stays in flight in the background (b.f2b)` | Normal. Until the launch ends, the health check still checks this persona but never restarts, reconnects or reports it. |
| `[slack] startupSessionManager: complete — <N> persona(s): <n> resumed, <n> fresh-spawned, <n> fresh-after-amnesia, <n> fresh-after-inconclusive-amnesia, <n> reconnected, <n> no-op, <n> failed, <n> not brought up, <n> not reconnected, <n> latched, <n> retrying, <n> waiting on a live-row sequence, <n> held on invalid flags, <n> fresh as retired keys` | The start summary. Each persona's launch is counted once, in one count, except one still waiting in the background: it is in no count, and the next line gives how many. `not reconnected` counts instances left running without a reconnect (see the lines above). `latched` counts launches that held the persona for a human, or found it held (see [A persona posts a Held: tmux session conflict notice](#a-persona-posts-a-held-tmux-session-conflict-notice) and the two Held sections after it). `retrying` counts launches agent-director refused, now in the persona's automatic retries (see [agent-director refuses a persona: it is retried on its own](#agent-director-refuses-a-persona-it-is-retried-on-its-own)). `waiting on a live-row sequence` counts launches waiting while the server replaces the persona's old instance (the `replacing the row of …` and `not launching … — its live-row sequence runs` lines under [Other lines you may see](#other-lines-you-may-see)). `held on invalid flags` counts launches of a persona held because agent-director rejected its launch flags (see [A persona posts a Cannot launch notice](#a-persona-posts-a-cannot-launch-notice)). `fresh as retired keys` counts personas whose key is retired, brought up on a new conversation (see [Added again or renamed back](#added-again-or-renamed-back)). None of these five is a failure, and none is counted as `fresh-spawned`. A persona held before its launch (its credentials, working directory or Slack connection, still being retried) is counted under `not brought up`, never under `retrying`. |
| `[slack] startupSessionManager: <n> persona(s) still waiting in the background for a working row to settle — not counted above; each logs its outcome when it settles (b.f2b)` | Launches still waiting when the summary was logged. |
| `[slack] startupSessionManager: background launch for "<name>" (key=<key>) settled: <outcome> (b.f2b)` | The launch ended. `reconnected`: the reconnect was typed. `not-reconnected`: the instance was left running without it (the line before says what happens next), or the persona's removal cancelled the wait. A relaunch action (`resumed`, `spawned`, `fresh-after-amnesia` or `fresh-after-inconclusive-amnesia`): the instance had died and was relaunched; for the two amnesia actions, its transcript was missing, so the persona was brought up fresh on the same instance and its agent-director row was kept, and the persona's `[slack] ErrJsonlMissing diagnostic:` line says whether its conversation history was lost. `deferred`: its `claude_config_dir` stopped resolving, and the persona is held until it does. `latched`: the wait or the relaunch met a tmux session conflict, an unusable recorded tmux session name, or a row pending with no launch start, and the persona is held (see [A persona posts a Held: tmux session conflict notice](#a-persona-posts-a-held-tmux-session-conflict-notice), [A persona posts a Held: unusable tmux session name notice](#a-persona-posts-a-held-unusable-tmux-session-name-notice) and [A persona posts a Held: launch start not recorded notice](#a-persona-posts-a-held-launch-start-not-recorded-notice)). `failed`: see the persona's spawn-failure lines; after a *version re-check decided that the server stops* line, the server is stopping. |
| `[slack] startupSessionManager: unexpected error in the background launch for "<name>" (key=<key>): <error>` | An internal error, also recorded as `spawn-failed` in `startup-errors.log`. Report it as a bug, with the persona's lines. |

---

## A persona posts a Launch stuck or Session not starting notice

The persona's own instance was launched, but its session has not started
within the later of 5 minutes and agent-director's `pending_grace_seconds`
plus 60 s from its launch's start (agent-director's row reads `pending`). It
may be held at a startup prompt the server cannot answer. Both notices name
the persona's session, `slack_bot_<key>`.

**Launch stuck.** This server made the launch, and it is still that launch.
The server ends it once and launches the persona again; a resumed persona
keeps its conversation. The notice ends "Nothing is needed." A launch counts
as the server's own only when all of these hold:

- this server made it since its last start: the server noted the launch's
  start time when its startup-prompt watch first read the row after a launch
  call that returned, or when its one read after a timed-out launch call
  found it, and the row still shows that start time. A server restart
  forgets the launches it made;
- no `send-keys` on this launch was refused as not interactive;
- it is not already the relaunch the server made for this stuck launch.

To tell from the log whether a launch was the server's own: the check at
the limit logs `at B: CSCB's own stuck launch: the relaunching post and the
abort (<kind>)` for it, and `at B: the held text; …` for any other.

The end runs once per stuck launch: the *Launch stuck* post, the stop of
the startup-prompt watch if it still runs, one checked kill with up to 3
tries 2 s apart, then the server's replacement of the instance from its
`get` step, ending in a `resume` of the same session when the row has one.
After that:

- a relaunch still starting at its own limit gets *Session not starting*
  once, and is never ended; while agent-director refuses its config file,
  it gets no notice, and *Session not starting* follows once that clears;
- a kill that fails after its tries posts *Kill failed* once (context
  `stuck-launch abort`), nothing is relaunched, and a later check posts
  *Session not starting* once;
- a kill refused as "not this launch's session", or meeting an unusable
  session name, holds the persona with its *Held:* notice, and is never
  sent again;
- a kill agent-director could not carry out for now (not answering, tmux
  not available, its config file refused, or an error it can't classify)
  is tried again at a later retry that reaches the limit check, with no
  second *Launch stuck* post; while tmux is unavailable or the config file is
  refused, that waits until the problem clears;
- a kill whose tries stopped because the persona stopped being up, was torn
  down or the server is stopping raises no alert; once the persona is up, a
  later retry makes the same end with no second post.

A *Session not starting* that follows *Launch stuck* means the relaunch is
stuck too, or the end failed: from then on the launch is a human's, as below.

**Session not starting.** Any other launch: one another process or a human
made, one from before a server restart, one whose `send-keys` was refused as
not interactive, one whose session agent-director could not create (its
`… a counted launch failure; nothing is killed …` line and `Spawn failure:`
notice came first, also after a failed resume or reuse spawn that left the
instance still starting), or a relaunch still stuck. The server never ends such a
launch and never launches over it: the session holding the persona's name
may be a leftover of an earlier launch of this persona, and ending it is a
human's decision.

Either way, it keeps checking:

- before agent-director's grace period (`pending_grace_seconds`) has passed
  since the launch's start, the persona's retries only read its state;
- from then on, each retry, and once the stop of the startup-prompt watch
  (at its time limit, a newer launch's watch, a session gone, a session
  that is not this launch's, tmux unavailable, or an internal error), makes
  one check: when no startup-prompt watch runs and no `send-keys` of this
  launch was refused as not interactive, it reads the screen once and
  presses Enter only on the folder-trust or development-channels prompt;
  then it asks agent-director to check whether the launch is still alive
  (a `find-missing` run) and reads the row again;
- a check that agent-director can't decide yet leads to nothing more until
  the next retry, and a row read that fails ends the check;
- once the row reads ended or missing, or is gone, the persona is brought up
  again, keeping its conversation where it can;
- at or after the limit, while the row still reads `pending`, the persona
  posts one of the two notices, each once while the launch stays stuck.

No check is made, no notice posted and nothing ended while the persona is
held for a human (its hold's own check is then the only one: see **The
server's own check** under
[A persona posts a Held: tmux session conflict notice](#a-persona-posts-a-held-tmux-session-conflict-notice)),
while it waits on an old instance in its working directory, or before the
grace period. Neither notice is posted, and nothing
is ended, while the persona's *tmux unavailable* notice holds: that is its
notice. While agent-director refuses its config file, the server's own stuck
launch gets neither notice and is not ended until the file is fixed. Either
notice can be posted again only after the session has started, the persona
has been held or torn down, or the server has restarted. The checks never
come closer together than the retries (30 s, then 60, 120 and 240 s more,
then every 300 s), apart from the one when the startup-prompt watch stops.

**The two forms.** When a `send-keys` on this launch, by the startup-prompt
watch or by a check, was refused as not interactive, the session holding
the persona's name was not started by this launch: the notice says so and
leaves out the attach remedy, and the poster's line says `held text (no
attach line: the session holding its name was not started by CSCB's
launch)`. Otherwise the notice lists the attach remedy, and the line says
`held text`.

**Read-only checks** (with the operator's say-so for anything beyond reading):

```sh
agent-director get --claude-instance-id cscb_<key>
agent-director list --tmux-session-name slack_bot_<key>
```

The `get` shows the row's state and its launch start; `list` (on the
command line; over MCP it ignores this filter) shows which rows record the
session name. To see whether a session of the persona is there, use the
one-line `read-pane` check under [Listing instances](#listing-instances),
with both of its caveats: a pane can be a single leftover's, and
`ErrTmuxCaptureFailed` does not prove the worker gone.

**What to do.** For *Launch stuck*, nothing. The *Session not starting* notice's remedies are a human's: attach to the session
by its exact name (`tmux attach -t =slack_bot_<key>`, only when the notice
lists it) and answer its prompt, or, to end the launch, follow the
"Operator actions" section of agent-director's README; the server's next
check then finds the launch gone and brings the persona up. This skill
describes no step of ending it. No bot acts on the notice, including a
persona that sees the post.

The lines:

```sh
grep -E 'pending-row: ("[^"]*" \(key=<key>\)|persona=<key> )|pendingRowRule: lap Enter .*\(key=<key>\)|the pending-row rule for "[^"]*" \(key=<key>\)|(Deferring persona|Pending deferral for persona)=<key>(: at this retry| read its row)|pendingRowRule stuck-launch abort: .*cscb_<key>|stopping the approver for "[^"]*" \(key=<key>\) \(stuck-launch-abort\)' ~/.claude/channels/slack/server.log
```

| Line | Meaning | Cause and fix |
|---|---|---|
| `[slack] pending-row: "<name>" (key=<key>) rule (<origin>): launch started <time>; lap: <…>; find-missing: <placement>; get: <…> — <follows> (b.jg5 SRJ-410)` | One check. `<origin>` is `retry`, or `approver-stop` for the check when the startup-prompt watch stopped. `lap:` says what the screen read and Enter did (`none, a dialog approver runs` when the watch still runs; `none, this launch's send-keys met ErrSpawnNotInteractive` after a refused `send-keys`). `<placement>` is what agent-director's check found: `marked-missing`, `not-judged` (it can't decide yet), `judged-alive`, `judged-left-live`, `refused`, `latched` or `failed`. `<follows>` says what came of it. | Nothing while it repeats before the limit. `at B: the held text; the row is left, never killed` (or `… without the attach line …`) repeats at every check at or after the limit; the next line, `[slack] pending-row: persona=<key> stuck-launch held text …`, tells whether this check posted the notice (`… posted`) or an earlier one did (`… not posted — already posted in this stuck-launch episode`): see **What to do**. `at B: CSCB's own stuck launch: …` is the server's own launch, which it ends once (the *Launch stuck* rows below). `at B: its tmux-unavailable outage is raised …` means no notice for now: see **tmux isn't available** in [agent-director refuses a persona](#agent-director-refuses-a-persona-it-is-retried-on-its-own). `the get failed: nothing more this round` repeating: see that section too. |
| `[slack] pending-row: "<name>" (key=<key>) rule (<origin>): no lap, run or post — <why> (b.jg5 SRJ-410)` | No check this time: the persona is held, a launch or a replacement of its instance runs, its working directory waits on an old instance, the row isn't `pending`, or it has no launch start. | Nothing; the next retry checks again. For a hold, follow its *Held:* notice. |
| `[slack] pending-row: "<name>" (key=<key>) rule (<origin>): failed: <error> — nothing more this round (b.jg5 SRJ-410)` | An internal error in the check. | Nothing at once; the next retry checks again. If it repeats, report it with the lines around it. |
| `[slack] pending-row: "<name>" (key=<key>) rule (approver-stop): its dialog approver stopped (<reason>) with the row pending — the run answered <answer> (b.jg5 SRJ-404, SRJ-410)` | The one check after the startup-prompt watch stopped, and what it found (`refusal (<reason>)`, `gone (<state>)`, `live (<state>)`, `latched`, `read refused`, `held (<post>)`). | Nothing; the retries go on. |
| `[slack] pending-row: "<name>" (key=<key>) rule (approver-stop): dropped — the server is shutting down; no call (b.jg5 SRJ-404)` | The server stopped before the check ran. | Nothing. |
| `[slack] pending-row: "<name>" (key=<key>) rule (approver-stop): dropped — <why>; no call (b.jg5 SRJ-404, SRJ-410, SRJ-305)` | The check after the startup-prompt watch stopped was not made, for the same reasons a retry makes no call: `<why>` says the persona was removed (a teardown ran first), is held (session conflict or `ErrInvalidFlags`), is not up, reached its restart limit, or the server is stopping; `its gate failed (<error>), taken as stopped` is an internal error. Nothing was read, typed, posted or ended. | Nothing for a removal or a stop; for a hold or the restart limit, follow its notice. If `its gate failed` repeats, report it with the lines around it. |
| `[slack] pending-row: "<name>" (key=<key>): the pending-row rule already ran in this retry — no second lap, run or post (b.jg5 SRJ-410)` | A second check asked in one retry; none is made. | Nothing. |
| `[slack] pending-row: "<name>" (key=<key>): no pending-row rule is installed — its covered pending row keeps its pending-only arm only; no lap, run or post (b.jg5 SRJ-410)` (or `… its dialog approver stopped (<reason>) with the row pending, and no pending-row rule is installed …`) | The server runs without the check. Production always installs it. | Report it. |
| `[slack] pending-row: persona=<key> stuck-launch held text posted` | The notice was handed to the persona's destination (`held text (no attach line: …)` for the other form). | See **What to do**. |
| `[slack] pending-row: persona=<key> stuck-launch held text not posted — already posted in this stuck-launch episode` | A later check at the limit; the notice is not posted twice. | As above. |
| `[slack] pending-row: persona=<key> stuck-launch held text not posted — no notice episodes are installed (b.jg5 SRJ-1017)` | The server had nothing to post through. Production always has. | Report it. |
| `[slack] pending-row: "<name>" (key=<key>) rule (<origin>): … — at B: CSCB's own stuck launch: the relaunching post and the abort (<kind>) (b.jg5 SRJ-410)` | The check at the limit found the server's own launch. `<kind>` is `sequence-started` (ended; the relaunch began), `latched` (the persona is held) or `kept` (no end this round; the abort lines above it say why). Logged after the abort's own lines. | `sequence-started`: nothing; watch the relaunch. `latched`: follow the *Held:* notice. `kept`: see the abort lines. |
| `[slack] pending-row: "<name>" (key=<key>) rule (<origin>): … — at B: CSCB's own stuck launch while ad-config-malformed is raised: neither text and no abort until it clears (b.jg5 SRJ-410)` | The server's own launch is stuck, but agent-director refuses its config file: no notice and no end for now. | Fix the config file: see **agent-director refuses its config file** in [agent-director refuses a persona](#agent-director-refuses-a-persona-it-is-retried-on-its-own). The end follows at the next check after it clears. |
| `[slack] pending-row: "<name>" (key=<key>) rule (<origin>): … — at B: CSCB's own stuck launch, its abort used, while ad-config-malformed is raised: neither text until it clears (b.jg5 SRJ-410)` | The server already ended this stuck launch once and its relaunch is stuck too, but agent-director refuses its config file: no notice for now. | Fix the config file, as above. *Session not starting* follows at the next check after it clears. |
| `[slack] pending-row: persona=<key> stuck-launch post not made — <why> (b.jg5 SRJ-1017)` | Logged just before either line above: no notice for the server's own stuck launch while agent-director refuses its config file. `<why>` says what follows once it clears: *Launch stuck* and the end, or, when the one end was already made, *Session not starting*. Any other stuck launch still gets *Session not starting*. | As above. |
| `[slack] pending-row: persona=<key> stuck-launch relaunching text posted` | The *Launch stuck* notice was handed to the persona's destination. | Nothing. |
| `[slack] pending-row: persona=<key> stuck-launch relaunching text not posted — already posted in this stuck-launch episode` | A later check tries the same end again; no second *Launch stuck* post. | Nothing. |
| `[slack] pending-row: persona=<key> stuck-launch <text> not posted — an episodes call failed` | The post failed inside the server (its own line `stuck-launch post failed: <error>` comes first). With the relaunching text, no end is made this round. | Nothing at once; the next check tries again. If it repeats, report it with the lines around it. |
| `[slack] pending-row: persona=<key> stuck-launch relaunching text not posted — no notice episodes are installed, so no abort is made (b.jg5 SRJ-1017, SRJ-412)` | The server had nothing to post through, so nothing is ended. Production always has. | Report it. |
| `[slack] pending-row: persona=<key> stuck-launch abort started for "<name>" (key=<key>) (launch started <time>) — its dialog approver is stopped if one runs, then one checked kill of its row (b.jg5 SRJ-412)` | The end of the server's own stuck launch begins. | Nothing. |
| `[slack] approvePreSessionDialogs: stopping the approver for "<name>" (key=<key>) (stuck-launch-abort): CSCB is aborting the persona's own stuck launch, and its kill follows; no pending-row run follows this stop; it makes no further call (b.jg5 SRJ-401, SRJ-404)` | The startup-prompt watch was stopped for the end. No check follows this stop. | Nothing. |
| `[slack] pendingRowRule stuck-launch abort: kill try <n> of 3 for cscb_<key>: <outcome> — <next> (b.jg5 SRJ-702)` | One try of the end, with agent-director's answer. The reads between tries and the end line carry the same prefix. | As for the kill line below. |
| `[slack] pending-row: persona=<key> stuck-launch abort kill: succeeded (<outcome>) — the episode's one abort is used; the live-row sequence follows from its second step (b.jg5 SRJ-412)` | The launch was ended. | Nothing; the relaunch follows. |
| `[slack] pending-row: persona=<key> stuck-launch abort kill: kill-failed (<outcome>) — the abort kill failed after its tries: … (b.jg5 SRJ-412)` | agent-director could not end the launch after 3 tries: a *Kill failed* notice with context `stuck-launch abort`, nothing relaunched. | Follow the *Kill failed* notice: [A persona posts a Kill failed or Process outlived kill notice](#a-persona-posts-a-kill-failed-or-process-outlived-kill-notice). *Session not starting* follows at a later check. |
| `[slack] pending-row: persona=<key> stuck-launch abort kill: latched (<outcome>) — the persona latched: … (b.jg5 SRJ-412)` | The kill met a session conflict (for example "not this launch's session") or an unusable session name: the persona is held, and the kill is never sent again. | Follow the *Held:* notice: [A persona posts a Held: tmux session conflict notice](#a-persona-posts-a-held-tmux-session-conflict-notice) or [A persona posts a Held: unusable tmux session name notice](#a-persona-posts-a-held-unusable-tmux-session-name-notice). |
| `[slack] pending-row: persona=<key> stuck-launch abort kill: try-later (<outcome>) — the abort kill did nothing: … (b.jg5 SRJ-412)` | agent-director could not carry out the kill for now (not answering, tmux not available, its config file refused, or an error it can't classify). | Nothing; a later retry tries the same end again, with no second post. For tmux or the config file, see [agent-director refuses a persona](#agent-director-refuses-a-persona-it-is-retried-on-its-own). |
| `[slack] pending-row: persona=<key> stuck-launch abort kill: stopped (<outcome>) — the abort kill's tries were stopped: … (b.jg5 SRJ-412)` | The tries stopped: the persona stopped being up or was torn down, the server is stopping, or a version check stops the server. No alert. | Nothing; once the persona is up, a later retry makes the same end. |
| `[slack] pending-row: persona=<key> stuck-launch abort: the live-row sequence started at its second step, keeping a resumed launch's conversation (b.jg5 SRJ-412, SRJ-705)` | The relaunch began, through the server's replacement of the instance. | Follow it with `live-row-sequence:` lines. |
| `[slack] pending-row: persona=<key> stuck-launch abort: the live-row sequence did not start (<why>) — nothing more this round (b.jg5 SRJ-412, SRJ-705)` | The launch was ended, but the relaunch did not start (for example, a replacement already runs, or the persona is held on `ErrInvalidFlags`). | Nothing at once; the persona's retries bring it up once the row reads gone. If `<why>` names a failure, report it. |
| `[slack] pending-row: persona=<key> stuck-launch abort not made — <why> (b.jg5 SRJ-412)` | No end this round. `<why>` says: the one end for this stuck launch was already made (a relaunch still stuck gets *Session not starting*; logged just before the check's `at B: the held text` line), tmux is unavailable, agent-director refuses its config file, an end is already running, the server is stopping, the *Launch stuck* post failed, no stuck-launch episode is open, the persona is held, or `the abort failed: <error>`. | Nothing for the first; for an outage, see its notice; for a failure that repeats, report it. |
| `[slack] pendingRowRule: lap Enter refused for "<name>" (key=<key>): <error> — CONFLICT: <outcome>; nothing is typed and nothing more is called for it (b.jg5 SRJ-105, SRJ-501)` (or `UNUSABLE NAME`, `SRJ-512`) | The check's Enter met a session conflict, or an unusable session name: the persona is held. | Follow the *Held:* notice: [A persona posts a Held: tmux session conflict notice](#a-persona-posts-a-held-tmux-session-conflict-notice) or [A persona posts a Held: unusable tmux session name notice](#a-persona-posts-a-held-unusable-tmux-session-name-notice). |
| `[slack] pendingRowRule: lap Enter for "<name>" (key=<key>) answered <classification> — UNCLASSIFIED after one immediate agent-director version re-check: <recheck>; nothing typed (b.jg5 SRJ-104, SRJ-204)` | The check's Enter got `ErrInvalidFlags`, and the server checked agent-director's version once. | With `stop`, see [Found while the server was running](#found-while-the-server-was-running); otherwise as for **agent-director returns an error the server can't classify** in [agent-director refuses a persona](#agent-director-refuses-a-persona-it-is-retried-on-its-own). |
| `[slack] spawnForPersona: the pending-row rule for "<name>" (key=<key>) answered <answer> — nothing launched in this attempt; answering retrying, its retry timer owns it and its next retry reads the row (b.jg5 SRJ-410, SRJ-1015)` | A relaunch's check found the row gone, or couldn't read it; nothing is launched in that attempt. | Nothing; the next retry brings the persona up. |
| `[slack] Deferring persona=<key>: at this retry its row reads <state> — no longer pending; the restart run goes on to its relaunch, with no kill for a row read finished (b.jg5 SRJ-410, SRJ-303)` | A restart retry's check found the row `ended`, `missing` or gone (`no-row`). | Nothing; the same run relaunches the persona, with nothing killed first. |
| `[slack] Pending deferral for persona=<key> read its row <state> — no longer pending; this restart run goes on to its relaunch, with no kill for a row read finished (b.jg5 SRJ-410, SRJ-303)` | The restart that made the check takes that finding. | As above. |

## A persona posts a Not answering notice

When agent-director refuses a call that acts on a persona's session
(starting, resuming or stopping its instance, reading its screen, or typing
into it) while the server is launching or recovering that persona, the
server records that the persona's session is not answering. This is about
that one persona, not an agent-director outage: no outage notice is posted
for it. The refused call is retried on its own (see
[agent-director refuses a persona](#agent-director-refuses-a-persona-it-is-retried-on-its-own)).
The record ends as soon as the session answers again: a call that acts on
its session succeeds or is told the session is gone, or a health check or
retry finds its instance running
with its session connected and receiving messages. After a launch that timed
out (see [A launch that timed out](#a-launch-that-timed-out)), it also ends
once a read finds that launch's instance started; usually the startup-prompt
watcher's first screen read ends it earlier. A `status`, `get` or
`list` failure alone (a call that only reads the persona's state) never
starts it, ends it or produces these notices, and neither does a failure to
stop the instance's session (the `kill-failed` cause), which posts a *Kill
failed* notice instead (see
[A persona posts a Kill failed or Process outlived kill notice](#a-persona-posts-a-kill-failed-or-process-outlived-kill-notice)).

While the record holds, a message sent to the persona is lost. While the
server is retrying the persona, its *Message lost* notice reports
`not answering`, with no restart started. At the restart limit it reports
`restart limit reached` instead (unless a restart is already under way,
`session_restart_delay` is `0` or its session is starting); if its retries
have stopped below the limit, it reports the next state that applies, which
can be `starting now`.

While the record holds, the persona's destination can get up to three
notices, each naming the persona's session (`"slack_bot_<key>"`):

| Notice | When it is posted | What it means | What to do |
|---|---|---|---|
| *Not answering* | At the next health check after the first refusal, if the session still isn't answering after that check. With `health_check_interval` `0`, at the first retry at least 2 minutes after the first refusal (a retry skipped because a launch was running counts). A single refusal that clears before then posts nothing. Never posted once *Still not answering* has been posted for the episode. Only while the server is retrying: not posted while the persona's retries are stopped, for any reason, until a later refusal in the same episode starts them again; never again in the episode once the persona was torn down or removed from the configuration, or the server is stopping. A health check that restarts the retries on its own does not allow it. | agent-director or tmux isn't answering for the persona's session. The server keeps retrying. | Nothing yet. |
| *Still not answering* | Once the session has not answered for longer than the alert threshold: the longer of agent-director's `stopping_window_seconds` and `starting_session_seconds`, plus 60 s, from the values in effect (see [agent-director's timing settings](#agent-directors-timing-settings)). At agent-director's defaults that is 6 minutes, and the notice says `over 6 minutes`. It doesn't wait for *Not answering* first. Only while the server is retrying: if the persona's retries stop before it is posted, it is not posted; if a later refusal in the same episode starts the retries again, it is posted once the time since the first refusal is over the threshold (at once when it already is), unless the persona was removed or the server is stopping. | It has lasted long enough to need a human. The retries continue; the notice stops nothing, counts toward nothing and takes no destructive action. | The read-only checks below. |
| *Answering again* | When the record ends, only if *Not answering* or *Still not answering* was posted for it. | The persona reaches its session again. | Nothing. |

The usual order is *Not answering*, *Still not answering*, *Answering
again*. When *Still not answering* comes first (for example with
`health_check_interval` `0` and an alert threshold of 180 s, whose alert
falls before the first retry at least 2 minutes after the first refusal),
*Not answering* is skipped: the order is *Still not answering*, then
*Answering again*.

Each is posted at most once per episode: from the first refusal until the
record ends. After it ends, a new refusal starts a new episode, which posts
them again. Removing the persona or stopping the server ends the episode with
no notice. The notices and the record behind them never make the server kill,
delete or relaunch anything, and never count toward the restart limit; any
relaunch comes from the ordinary retries, which never start a second
instance over one that is running.

**After *Still not answering*: read-only checks only.** Check the host's
tmux server and agent-director without changing either:

```sh
agent-director version
agent-director get --claude-instance-id cscb_<key>
agent-director list --label service=cscb --label persona=<key>
agent-director read-pane --claude-instance-id cscb_<key> --n-lines 1
```

Run them as the user the workers run as, in the bot server's launcher
environment. The `read-pane` reaches the persona's tmux session through
agent-director: an answer in time shows that tmux answers, and
`ErrTmuxUnresponsive` or `ErrCallTimeout` shows it still doesn't. It never
shows whose a session is (see its caveats under
[Listing instances](#listing-instances)): ownership comes from
agent-director's row (the `get` and `list` above), so never act on a session
because of it.

A command that hangs or times out points at the host (its load, or the tmux
server). Never run a command that ends a session or deletes a row to clear
it: the fix is the host's, and once agent-director and tmux answer, the next
retry brings the persona back and *Answering again* follows.

All of one persona's lines of this kind (replace `ops_bot` with the key):

```sh
grep -h -E 'persona-episodes: persona=ops_bot tmux-unresponsive |unavailable-retry: persona=ops_bot (stopped|kept)' "$STATE"/server.log.* "$STATE"/server.log 2>/dev/null | sort
```

| Line | Meaning | What to do |
|---|---|---|
| `[slack] persona-episodes: persona=<key> tmux-unresponsive started — <verb> failed: <error>` | agent-director refused `<verb>` for the persona while it was being launched or recovered: `spawn` or `resume` (starting its instance), `read-pane` (reading its screen), `send-keys` (typing into it) or `kill` (stopping an instance it had found running). `<error>` is the error (see [The server log](#the-server-log), Error detail), usually `ErrTmuxUnresponsive` or `ErrCallTimeout`: agent-director, or the terminal sessions it drives, didn't answer in time. Logged once, at the first refusal; later refusals while the session still isn't answering log nothing. No notice yet. | Nothing at first: the retries bring the persona back once agent-director answers. |
| `[slack] persona-episodes: persona=<key> tmux-unresponsive onset posted — still not answering at <where>, <s> s after its first refusal` | *Not answering* was posted. `<where>` is `a health tick` or, with `health_check_interval` `0`, `a retry`. | Nothing yet. |
| `[slack] persona-episodes: persona=<key> tmux-unresponsive alert posted — not answering for <s> s, over its alert threshold of <s> s` | *Still not answering* was posted; the second number is the alert threshold in effect. | The read-only checks above. |
| `[slack] persona-episodes: persona=<key> tmux-unresponsive onset not posted — its alert already posted` | *Not answering* was due, but *Still not answering* had already been posted in this episode, so it was skipped. Logged once per episode. | The read-only checks above. |
| `[slack] persona-episodes: persona=<key> tmux-unresponsive onset not posted — its retry timer stopped and no refusal has re-armed it` | *Not answering* was due, but the persona's retries had stopped (see the `unavailable-retry` `stopped` line before it) and no later refusal had started them again, so it was skipped. It can still be posted in this episode if a later refusal starts the retries again; after a `stopped` reason of `the persona was torn down`, `the persona is not in the applied configuration` or `the server is shutting down`, it never is. Logged once per episode. | Follow the `stopped` line's reason (see [agent-director refuses a persona](#agent-director-refuses-a-persona-it-is-retried-on-its-own)). |
| `[slack] persona-episodes: persona=<key> tmux-unresponsive alert check cancelled — its retry timer stopped: <reason>` | The persona's retries stopped (`<reason>` matches the `unavailable-retry` `stopped` line) before *Still not answering* was due, so it will not be posted unless the retries start again. With `<reason>` `the persona was torn down`, `the persona is not in the applied configuration` or `the server is shutting down`, it never comes back in this episode, even when an earlier stop had already cancelled it (that later stop logs no second line). | Follow the `stopped` line's reason (see [agent-director refuses a persona](#agent-director-refuses-a-persona-it-is-retried-on-its-own)). |
| `[slack] persona-episodes: persona=<key> tmux-unresponsive alert check armed again — a new refusal armed its retry timer again` | A new refusal restarted the retries in the same episode, so *Still not answering* is due again, timed from the first refusal. Never logged after the persona was torn down or removed from the configuration, or the server began shutting down, in this episode. | Nothing yet. |
| `[slack] persona-episodes: persona=<key> tmux-unresponsive ended — <reason>` | The persona's session answers again. `<reason>`: `a tmux-touching call succeeded or answered GONE` (a call on its session went through, or agent-director reported the session gone, which the recovery then handles), `a health tick found its row live and its session connected with its stream` or `a retry found its row live and its session connected with its stream` (the persona is being served), `after a launch timeout, this launch's row left pending for a live state` (a read found the timed-out launch's instance started; the `this launch's row left pending` line follows, see [A launch that timed out](#a-launch-that-timed-out)), or `the persona latched` (see [A persona posts a Held: tmux session conflict notice](#a-persona-posts-a-held-tmux-session-conflict-notice); no *Answering again* follows, and the retries were already stopped). Otherwise the retries then stop (`stopped — the tmux-unresponsive condition ended`), or go on when a `kept` line follows. When the end came during a retry and a later call in that same retry was refused again (a `tmux-unresponsive started` line follows), a new episode begins and the retries go on with no `stopped` line. When the call that went through launched the instance (`spawn` or `resume`), its new session may not have started yet, so the `kept — … its row last read pending` line follows and the next retry checks the instance. | Nothing. |
| `[slack] persona-episodes: persona=<key> tmux-unresponsive recovery posted` | *Answering again* was posted, right after the `ended` line. | Nothing. |
| `[slack] persona-episodes: persona=<key> tmux-unresponsive onset not posted — muted, its persona teardown was submitted; …`, `… alert not posted — muted, its persona teardown was submitted; …`, `… recovery not posted — muted, its persona teardown was submitted` | A confirmed change queued the persona's teardown, so the notice was not posted (it counts as posted). Once the teardown starts, such a notice goes to a `persona-teardown-notice` entry instead (see [A notice raised during a teardown](#a-notice-raised-during-a-teardown)). | Nothing. |
| `[slack] persona-episodes: persona=<key> tmux-unresponsive recovery not posted — a silent end (a CONFLICT answer ended it)` | The record ended, after *Not answering* or *Still not answering*, on an answer whose own notice follows, so *Answering again* was not posted. | Follow that notice. |
| `[slack] persona-episodes: persona=<key> tmux-unresponsive alert check not armed: <error>`, `… alert check failed: <error>`, `… alert check cancel failed: <error>`, `… onset check at a retry failed: <error>`, `[slack] persona-episodes: tmux-unresponsive onset check at a health tick failed: <error>`, `[slack] persona-episodes: persona=<key> tmux-unresponsive episode close step failed: <error>`, `[slack] health-check: the tick-end hook failed: <error>`, `[slack] health-check: the tick's start time could not be read: <error> — no tick-end hook this tick` | An internal error: a notice may be missing, but the retries go on unchanged. | Report it as a bug, with the persona's lines. |
| `[slack] persona-episodes: tmux-unresponsive health-check mode read failed: <error> — taken as on` | An internal error reading `health_check_interval`; the notice is timed as with the health check on. | Report it as a bug. |
| `[slack] health-check: the tick failed: <error>` | An internal error ended one health check early, outside any one persona's check (for example, reading the list of personas failed). The *Not answering* check at the end of that health check still runs, and the next health check runs as usual. | Nothing if it happens once. If it repeats, report it as a bug, with the lines around it. |
| `[slack] persona-episodes: persona=<key> tmux-unresponsive notice failed: <error>` | An internal error handing one of the three notices to the persona's notifier; it is not posted again in the episode. (A notice that reaches the notifier but can't be delivered shows as [`persona-destination-failed`](#persona-destination-failed) instead.) | Report it as a bug, with the persona's lines. |

---

## A persona posts a Held: tmux session conflict notice

The server met one of two things:

- agent-director refused to act on the persona's tmux session because of a
  session conflict (`ErrTmuxSessionConflict`), when the server launched or
  resumed the persona or brought it up fresh on its own instance id (a reuse
  spawn, after a resume that found no conversation), while it read the persona's screen (a launch waiting
  on a `working` row, or the health check's reconnect checking a `working`
  or `waiting` row), or while it answered the startup prompts of the
  persona's starting instance (a `CONFLICT` line under
  [Other lines you may see](#other-lines-you-may-see)), or when the server
  killed the persona's old session before a restart's relaunch, or while it
  replaces the persona's old instance, or when it ended its own stuck launch
  (a `kill refused … CONFLICT` line from `killSession (restart adapter)`,
  `live-row-sequence` or `pendingRowRule stuck-launch abort`; see
  [A persona posts a Launch stuck or Session not starting notice](#a-persona-posts-a-launch-stuck-or-session-not-starting-notice)). A kill refused as
  "not this launch's session" on a live row means a session left over from
  an earlier launch holds the persona's session name and nothing was sent;
  the server never sends that kill again;
- agent-director had noted conflicting labels on the persona's own row
  (its liveness note `provenance_conflict`) when the server read that row:
  while launching the persona (the row read after the instance id was
  already taken, or before bringing up fresh a persona whose resume found
  its transcript missing),
  or while checking whether a session whose row reads `working` is really
  idle, or right after the server's own `find-missing` run listed the
  persona's row as unverified (the server then reads that row once), or when
  a server start listed its agent-director instances before its clean-up of
  old ones. This is the "Conflicting labels" case below.

A confirmed change's teardown of the persona (a removal, or the old half
of a destructive change) holds nothing: when its kill meets a session
conflict, nothing latches and nothing is posted. The conflict is written to
`server.log` and a `persona-teardown-notice` entry,
`agent-director kill of cscb_<key> refused at a try: outcome=not-killed class=CONFLICT …`
(or `refused at a status read between its tries`), and a *Held:* notice
that a launch still running raises during the teardown is written there too,
not posted (see
[A notice raised during a teardown](#a-notice-raised-during-a-teardown)).
The "What to do" below still applies to the session it names.

Only the persona's own row, for a persona in the configuration, counts.
agent-director's other liveness notes (such as `tmux_server_changed` or
`process_not_seen_session_present`), and any note on a row that is not one
of your personas' own, never hold a persona.

The persona is then held: the persona's destination gets one *Held: tmux
session conflict* notice naming the persona and its session, and the server
attempts nothing more for it but its own check every 2 minutes (see
**The server's own check** below).

A persona held at a start keeps its instances: that start's clean-up of old
instances ends none of them, neither its own nor any other carrying its
label, even one in another working directory or config directory (the
`latched from its own listed row` line below).

While the persona is held:

- the server stops answering the startup prompts of its starting instance
  at once (an `approvePreSessionDialogs: … is latched` or `stopping the
  approver … (latched)` line), and types nothing into it;
- its starting instance gets no *Session not starting* notice and no
  check with agent-director but the server's own check below (a
  `pending-row: … rule (<origin>): no lap, run or post — the persona is
  latched` line at most);
- it is not launched, resumed or reconnected, by the start, a bring-up, a
  restart or a retry, and no agent-director call is made for it, except by
  the server's own check below;
- a restart for it does nothing and counts nothing;
- its automatic retries stop; a retry armed later stops at its first try,
  with no agent-director call;
- the health check still reads it, but never restarts it, reconnects it or
  posts a notice for it;
- messages sent to it are lost, and each one's *Message lost* notice
  reports `held for a human`, with no restart started;
- a *Not answering* record ends with no *Answering again*, and an
  *Unclassified agent-director error* episode ends with no notice;
- nothing is killed, deleted or counted toward the restart limit for it
  by the server on its own (a confirmed removal or destructive change still
  tears it down; see **How a hold clears**), and no `Spawn failure:` notice
  is posted.

Other personas are not affected.

**The server's own check.** Every 2 minutes, whatever
`health_check_interval` is (`0` included), the server checks each held
persona once: the first check 2 minutes after the hold began, each next one
2 minutes after the previous one finished. A check reads the persona's
agent-director row once, then makes at most one more call, the one the
hold's case allows, or none:

- *This row's own id*: a one-line look at the session's screen through
  agent-director, only for a refused resume or relaunch on the persona's
  row, and only once that row reads `ended` or `missing`; once a launch
  tried after such a look is refused again with this case, the looks stop
  for the rest of the hold, and each check that reads the row `ended` or
  `missing` tries the refused launch once more instead;
- *The agent's pane was not found*: the same one-line look (for a refused
  resume or relaunch, only once the row reads `ended` or `missing`);
- *Left over from an earlier life*, *No valid instance id*, *A different
  instance id*, *Another agent-director store*: a refused resume or
  relaunch tried once more, once the row reads `ended` or `missing`;
- a refused first launch (`refused=plain-spawn`, any case but the pane
  case): nothing while the row reads as running or still starting; on an
  `ended` or `missing` row one launch on that row; with no row, the launch
  tried once more;
- *Not this launch's session*: only the read, until the row reads `ended`
  or `missing` or is gone; then one relaunch (a resume when the row has a
  conversation, else a fresh launch on the row, or a first launch when no
  row is left). The refused kill or keystroke is never sent again;
- *Conflicting labels*: the read shows whether the labels are still noted;
  while they are, nothing. Otherwise: on a row still starting, a one-line
  look at its screen that types nothing; on a running row, one restart
  attempt, as for any persona; on an `ended` or `missing` row, the refused
  resume or relaunch tried once more (one restart attempt when the hold came
  from anything else);
- an unrecognised description, and the cases in the two *Held:* sections
  below: only the read.

Apart from that one restart attempt, a check never ends a session or types
into one while the persona stays held. An answer that tells the server
nothing (agent-director not answering or unable to act right now, tmux
unavailable, an error it can't classify, an instance id already in use)
keeps the hold and raises no other notice: no *Not answering*, *tmux
unavailable* or *Unclassified agent-director error* notice and no automatic
retries. agent-director refusing its config file keeps the hold and raises
that notice (see
[agent-director refuses a persona](#agent-director-refuses-a-persona-it-is-retried-on-its-own)).
A launch or restart attempt, or the look at a still-starting screen,
answered with another case, an unusable tmux session name, or a read that
finds a launch start not recorded, holds the persona again with one new
notice, and later checks follow the new hold; the same case again changes
nothing and posts nothing. A look at the screen that finds the problem gone
does not end the hold by itself: in the same check the server runs
agent-director's `find-missing` once, then tries the refused launch once
more (one restart attempt when the hold came from anything but a launch),
and that launch's answer decides. When that `find-missing` run fails
(agent-director not answering or unable to act right now, tmux unavailable,
agent-director refusing its config file, an error it can't classify),
nothing is tried in that check and nothing is posted; a refused config file
or unavailable tmux still raises its own notice.

The restart limit wins over the check. For a persona that has reached it (5
failed launches in a row, with its `SpawnCapReached` notice), the check makes
no launch and no restart attempt, and no `find-missing` run after a look at
the screen that finds the problem gone; it logs one `is at the restart cap`
line instead (see the table below). It still reads the row, and looks at the
screen when the case calls for it, so a hold that clears on that read still
clears; one that clears only when a launch or restart attempt is not refused
stays held. See **A held persona at the restart limit** below.

Each check logs one line, `[slack] conflict-latch: re-check of "<name>"
(key=<key>) — case=<case> step=<step> call=<call> answer=<answer>` (see the table
below). A check whose answer is `no-information` needs nothing from you: the
next check comes 2 minutes later.

**How a hold clears.** The hold clears on its own once its cause is gone,
found by the server's own check every 2 minutes; no restart is needed. After
a human follows the "Operator actions" section of agent-director's README,
the server notices within 2 minutes, or, on the operator's say-so, the hold
is cleared at once by hand (see
[Clearing a hold by hand: `clear-latch`](#clearing-a-hold-by-hand-clear-latch)),
which also ends a hold the check cannot clear. By the hold's case:

| Hold (`case=`) | What the check looks for | It clears when |
|---|---|---|
| Any but `not-this-launch` | The persona's row, at each check | The row is gone, or it reads running when the hold began on a row recorded `ended`, `missing`, `pending` or `no-row` (`state=` in the `latched` line); never while conflicting labels are still noted. A refused first launch or relaunch on the row (`refused=plain-spawn`, `refused=reuse-spawn`) whose row is gone is tried again instead. |
| `own-id`, `pane-not-found` | The one-line look at the screen | The look finds the problem gone, and the refused launch (or restart attempt) tried once more after one `find-missing` run is not refused. |
| `leftover`, `no-valid-id`, `different-id`, `another-store` | The refused resume or relaunch, tried again once the row reads `ended` or `missing` | That launch is not refused. |
| `refused=plain-spawn`, any case | The launch tried again (no row: as it was; `ended` or `missing`: a launch on that row) | That launch is not refused. |
| `not-this-launch` | The row reading `ended` or `missing`, or gone | The one relaunch is not refused; a running row never clears it. |
| `conflicting-labels` | The note on the row | The note is gone, and the look at a still-starting screen finds a screen or no session, or the restart attempt or launch is not refused. |
| `unusable-recorded-name` | The row | The row is gone; the persona comes up fresh. |
| `launch-start-not-recorded` | The row | The row reads running, `ended` or `missing`, or is gone. |
| `unrecognised`, `never-reported-in` | The row | Only as the first row says; otherwise only `clear-latch`, a removal, a destructive change or a server restart ends it. |

A launch or restart attempt is "not refused" when it succeeds or fails
outright (agent-director could not create its session, or the working
directory is missing); a failure is counted toward the restart limit with
its usual notice.

**What a clear posts.** One recovery notice per clear, to the persona's
destination: *Conflict cleared* for a tmux session conflict, *Hold cleared*
for an unusable tmux session name or a launch start not recorded. It says why
(the row is gone, the row reads a state, a retry was not refused, the row
finished and a relaunch was not refused, or it was cleared by hand) and closes with "CSCB is recovering
this persona again." Nothing is posted before a launch the check makes; only
its answer clears.

**What follows a clear.**

- Cleared by the check's read (row gone or running), by the look at a
  still-starting screen, or a launch start not recorded whose row reads
  `ended` or `missing`, or by hand (`clear-latch`): nothing was launched, so
  the persona is brought up at once, as a restart would. At the restart
  limit a clear by the check launches nothing, while a clear by hand also
  clears the limit and brings the persona up (**A held persona at the
  restart limit** below). After a clear by the
  read or by hand the server first runs
  `find-missing` once; if conflicting labels are still noted after it, the
  persona is held again with one new notice, and if that run fails nothing is
  launched then and the persona's automatic retries take over.
- Cleared by a launch or restart attempt the check made: that attempt's
  result stands; nothing is launched a second time.

**Held again.** A launch the check makes that meets the same case keeps the
hold and posts nothing; another case, or an unusable tmux session name,
holds the persona again with one new hold notice and no recovery notice. A
persona whose hold cleared and that later meets a problem again is held
again, with one new notice.

**The other ends.** The operator's `clear-latch` ends the hold, with one
recovery notice (see
[Clearing a hold by hand: `clear-latch`](#clearing-a-hold-by-hand-clear-latch)).
Removing the persona from the configuration (a
confirmed change) ends its hold, with no post. A destructive change (its
name, credentials file or working directory) also brings the persona up
unheld; it is held again, with one post to its destination, only if it meets
a conflict again: at its launch, or when the server later reads conflicting
labels on its own row. The hold is kept in the server's memory only, so a
server restart drops every hold; a persona whose conflict is still there is
held again, with one new post: by that start's listing, when conflicting
labels are still noted on its own row, or else at its next launch. For a session with no
valid label (`case=no-valid-id`) on a finished row, that launch's resume
finds no conversation and its reuse spawn of the same instance id meets the
session again (`refused=reuse-spawn`); nothing is deleted.

**A held persona at the restart limit.** The restart limit wins over the
hold. While the persona is held, its check makes only reads, and each check
that would have launched or made a restart attempt logs `[slack]
latch-recheck: "<name>" (key=<key>) is at the restart cap — no <call> in this
re-check; the persona stays latched (…)`, with the check line's `answer=`
`no-information (at-cap)` (or `probe-cleared (<kind>); no retry (at-cap)`
after a look at the screen).

When the operator ends the hold with `clear-latch`, the clear also clears
the persona's restart limit, before the bring-up that follows it: the
recovery notice is posted, `clear-latch` answers `cleared the latch of
persona "<name>" (key=<key>)`, and the persona is brought up at once: after
the `find-missing` run, its `latch-clear: … answered <outcome>` line shows
the bring-up (`launched` when it came up). Its count of failed launches
starts again from 0, so it reaches the limit again only after 5 more failed
launches in a row, with a new `SpawnCapReached` notice.

When the server's own check clears the hold, the limit still applies: the
recovery notice is posted, but the bring-up after the clear launches
nothing: `[slack] Restart retry skipped for persona=<key> — the persona is
at the restart cap; nothing killed or launched`, then the `latch-clear: …
answered capped` line (while other work for the persona is still running,
the skip line names that work and the answer is `in-flight`). Here the
notice's closing "CSCB is recovering this persona again." does not mean the
persona comes back. The persona stays down, unheld, and a lost message's
notice reports `restart limit reached`. `clear-latch` does not help then:
for a persona that is not held it changes nothing. The fix is the
operator's server restart (`claude-slack-channel-bots stop &&
claude-slack-channel-bots start`), which clears the limit and drops every
hold; a persona whose cause is still there is held again, with one new
notice. A destructive change to the persona also clears both.

**The clear line.** Each clear logs one line:

```text
[slack] conflict-latch: persona=<key> cleared — case=<case> session="<name>" reason="<reason>"; recovery notice posted
```

It means the hold ended for `<reason>` and the recovery notice was posted;
the check's own line shows `answer=cleared (…)` or, after a look at the
screen, `probe-cleared (…); …`. A clear by hand has `reason="cleared by
hand"` and no check line before it. The cause is whatever removed the problem,
usually a human following "Operator actions". Nothing to fix: watch the
`latch-clear:` lines that follow for the bring-up (table below). With
`recovery notice not posted (the notice episodes are closed)` the server was
shutting down. To see only the clears:

```sh
grep -h -E 'conflict-latch: persona=ops_bot cleared — |latch-clear: .*(\(key=ops_bot\)|persona=ops_bot[^_a-zA-Z0-9])|clear-latch: .*\(key=ops_bot\)' "$STATE"/server.log.* "$STATE"/server.log 2>/dev/null | sort
```

**The notice.** It is posted once per hold, even when the persona already
has a *Waiting on a prompt* or *Not connected* notice. Its first line names
the session and the case. For a refused launch or resume, its next line
quotes agent-director's description (`agent-director said: "…"`), with
anything that looks like a token removed. For a hold set from conflicting
labels noted on the row, the session is the persona's own
(`slack_bot_<key>`) and there is no `agent-director said` line, since the
note carries no description. Then, for every case but one, a pointer to the "Operator
actions" section of agent-director's README; then the read-only `list`
check below; and last, that it is for a human only.

| Case | What it means | Notice carries |
|---|---|---|
| This row's own id | The persona's own session, or its worker process, still runs although agent-director has marked the persona finished; the worker may be hung. | The pointer |
| Left over from an earlier life | A session left over from an earlier launch of this persona holds the name, or still carries the persona's label under another name. | The pointer |
| Not this launch's session | A session left over from an earlier launch of this persona is there. | The pointer |
| No valid instance id | A session with no valid agent-director label holds the name. | The pointer |
| A different instance id | Another agent-director row's session holds the name. | That the session must not be ended; **no pointer** |
| The agent's pane was not found | The worker's recorded pane is gone or was replaced, or a leftover session has no pane agent-director can find. | The pointer |
| Conflicting labels | Two sessions carry the same launch's agent-director label, or an agent-director label value is set at tmux's server, global or global-window scope. | The pointer |
| Another agent-director store | A worker of another agent-director store sharing this tmux server holds the name. | That the session must not be ended, then the pointer |

A description the server does not recognise gets a general first line with
no case, and the pointer. The `case=` value in the log lines below is one of
`own-id`, `leftover`, `not-this-launch`, `no-valid-id`, `different-id`,
`pane-not-found`, `conflicting-labels`, `another-store`, `never-reported-in`
or `unrecognised` (the last two get the general first line).

**The fix is a human's.** For every case with a pointer, a human follows the
"Operator actions" section of agent-director's README for the session the
notice names. This skill describes no step of it and takes none; no bot acts
on the notice, including a persona that sees the post. Never act on the
named session, and never on one of the two sessions that must not be ended.

**Read-only checks only.** The notice's own check shows which agent-director
rows record the session name. Run it on the command line; over MCP, `list`
ignores this filter:

```sh
agent-director list --tmux-session-name '<name>'
```

The notice's line quotes the name for the shell (single quotes, each `'` in
it written `'\''`; a plain name reads
`agent-director list --tmux-session-name 'slack_bot_dev'`). When the name
holds a control character, a line or paragraph separator, or a backtick, or
when rendering it as the notice renders agent-director's text would change
it (a token-like part redacted, leading or trailing whitespace trimmed, a
name of whitespace alone included, or the name cut at the length cap), the
notice leaves the line out and says "The session name could not be shown
safely." instead: a command filtering on a changed name would list nothing.

**After a launch's plain spawn met the conflict** (`refused=plain-spawn` in
the `latched` line below), the persona's own row reads one of two ways, and
either is expected. Which one depends on where agent-director refused, not
on the `case=` word: `case=leftover` and `case=conflicting-labels` can come
from either place.

```sh
agent-director get --claude-instance-id cscb_<key>
```

| What `get` shows | Why | What to do |
|---|---|---|
| No row (`ErrSpawnNotFound`) | agent-director's scan before the spawn refused (a session left over for the instance id, or conflicting labels at server, global or global-window scope) and wrote nothing. | As for the notice. |
| The row reads `ended` | The spawn wrote its row, then its tmux call met "duplicate session" (a session already holding the name that the scan did not count, with any case), and agent-director ended the new row at once. No hook of the session holding the name revives that row. Rarely it reads `pending` instead, when agent-director could not write the end. | As for the notice. The server launches nothing over the row while the persona is held. |

Either way the persona is held, nothing was killed or counted, and the
server takes no further step for it.

**Not a hold: a row `ended` after tmux could not answer.** A launch's plain
spawn that met a session holding the name, and then could not look that
session up because tmux did not answer (the refusal line names
`ErrTmuxUnresponsive` or `ErrTmuxNotAvailable`, and agent-director's
description says the new row was ended), also leaves the row `ended`. The
persona is not held and no *Held:* notice is posted; nothing is counted.
Its next try recovers it with no action: that launch finds the instance id
taken, reads the row `ended`, and (after a resume that finds no
conversation, when `resume_enabled` is on) brings the persona up on its own instance id (a
`reuseSpawnForPersona:` line), never with a second plain spawn. If tmux
stays unavailable, see **tmux isn't available** in
[agent-director refuses a persona](#agent-director-refuses-a-persona-it-is-retried-on-its-own).

All of one persona's hold lines (replace `ops_bot` with the key):

```sh
grep -h -E 'conflict-latch: (persona=ops_bot |re-check of .*\(key=ops_bot\) )|latch-recheck: .*\(key=ops_bot\)|latch-clear: .*(\(key=ops_bot\)|persona=ops_bot[^_a-zA-Z0-9])|clear-latch: .*\(key=ops_bot\)|(\(key=ops_bot\)|persona=ops_bot): .*— CONFLICT: |(\(key=ops_bot\)|persona=ops_bot): (its row carries the liveness note provenance_conflict|applying the note rule failed)|\(key=ops_bot\) is latched — the wait ends|(\(key=ops_bot\)|persona=ops_bot) is latched after (the findMissing sweep|its )|reconnectSession: persona=ops_bot is (working|waiting|ask_user|check_permission) and is latched|\(key=ops_bot\) reads (ask_user|check_permission) and is latched|\(key=ops_bot\): forgetting its latch failed|\(key=ops_bot\) — .*latched \(case=|\(key=ops_bot\) (latched from its own listed row|is latched \(case=)|(Not scheduling|Skipping) restart for persona=ops_bot — the persona is latched|Session relaunch for persona=ops_bot ended latched|reconnectSession: persona=ops_bot is latched|unavailable-retry: persona=ops_bot (stopped.* — the persona is latched|the latched query failed)|persona-episodes: persona=ops_bot ((tmux-unresponsive|unclassified-error) ended — the persona latched|conflict notice failed)' "$STATE"/server.log.* "$STATE"/server.log 2>/dev/null | sort
```

| Line | Meaning | What to do |
|---|---|---|
| `[slack] <site>: <step> refused for <persona>: <error> — CONFLICT: the persona latched; no spawn-failure notice; nothing more is called (b.jg5 SRJ-105, SRJ-501)` | A launch step or a kill was refused with `ErrTmuxSessionConflict`. `<site>: <step>` is `spawnForPersona: <step>` (a launch step: `spawn`, `retry-spawn`, `resume` or `fresh spawn after ErrSpawnNotFound on resume`), with `<persona>` `"<name>" (key=<key>)`; or `reuseSpawnForPersona: reuse spawn` (bringing the persona up fresh on its own instance id: after a resume that found no conversation, or a replacement's launch), with `<persona>` `"<name>" (key=<key>)`; or `live-row-sequence: kill` (a kill while the server replaces the persona's old instance); or `killSession (restart adapter): kill` (a restart's kill of the old session), with `<persona>` `persona=<key>`. The kill is not tried again. The launch or restart stops there: nothing is killed, deleted or launched after it. Logged once the persona is held, so it comes after the `latched` or `relatched` line below. | As for the notice. |
| `[slack] spawnForPersona: <step> refused for "<name>" (key=<key>): <error> — CONFLICT: the persona was latched elsewhere during the latch-time status read, so that latch stands; no spawn-failure notice; nothing more is called (b.jg5 SRJ-105, SRJ-501)` | A launch step was refused with `ErrTmuxSessionConflict`, but by the time the one state read made right after it returned, the persona had already been held by another check (such as the health check). That hold stands, with its own notice; the conflict adds no hold and no notice. The launch stops there. | As for the notice the persona's destination has. |
| `[slack] <site>: pane read refused for persona=<key>: <error> — CONFLICT: <outcome>; nothing is typed and nothing more is called for it (b.jg5 SRJ-105, SRJ-501)` | A read of the persona's screen (`<site>` `readWorkingPane`: by a launch waiting on a `working` row, or by the health check's reconnect checking a `waiting` row; `<site>` `reconnectSession`: by the health check's reconnect checking a `working` row; `<site>` `reconnectSession: prompt row` or `spawnForPersona: prompt row`: by the health check's reconnect or a launch checking an `ask_user` or `check_permission` row) was refused with `ErrTmuxSessionConflict`, and the persona is held. `<outcome>` is `the persona latched`, `the persona relatched` or `the persona was already latched with this case`. The wait ends or the check holds back; nothing is typed. A persona already held gets no screen read and no such line. Logged once the persona is held, so it comes after the `latched` or `relatched` line below. With `latching the persona failed: <error>` as the outcome, an internal error: the wait or check still stopped and typed nothing, but the hold may not be recorded and the notice may be missing. | As for the notice; for `latching the persona failed`, report it as a bug, with the persona's lines. |
| Any of the lines above ending `— CONFLICT: the persona is not in the applied configuration (case=<case> refused=<operation>), so nothing is latched or posted (b.jg5 SRJ-1002); …`, or of the `UNUSABLE NAME` lines (see [A persona posts a Held: unusable tmux session name notice](#a-persona-posts-a-held-unusable-tmux-session-name-notice)) ending `— UNUSABLE NAME: the persona is not in the applied configuration (case=unusable-recorded-name refused=none), so nothing is latched or posted (b.jg5 SRJ-1002); …` | agent-director refused the call as for the line's other form, but the persona is no longer in the applied configuration: a launch or check begun before an apply removed the persona answered after it, and the persona's teardown had not yet begun its turn (or had finished). `<case>` and `<operation>` name the case and the refused operation the hold would have recorded. Nobody is held, no notice is posted and no startup-errors entry is written; the step stops there as for a hold. Once the removed persona's teardown has begun its turn, the same answer from a launch it waits for holds the persona as usual: the line ends as the hold's line does, its notice is written as one `persona-teardown-notice` entry (never posted), and the teardown drops the hold once that launch has settled. | Nothing. |
| `[slack] configured-persona query for <persona> failed: <error> — the latch entry latches as for a configured persona (b.jg5 SRJ-1002)` | A CONFLICT or UNUSABLE NAME answer came in, and checking whether the persona is still in the applied configuration failed. The server holds the persona as it would a configured one, so the hold's own lines and notice follow. | Report it as a bug, with the persona's lines. If the persona is still configured, act on its notice. |
| `[slack] <site>: <what> for <persona>: its row carries the liveness note provenance_conflict (state=<state>) — the persona latched; nothing more is called for it (b.jg5 SRJ-114, SRJ-501)` | agent-director has noted conflicting labels on the persona's own row, and the server read that row. `<site>: <what>` is `spawnForPersona: collision get` (a launch found the instance id taken and read its row) or `spawnForPersona: ErrJsonlMissing diagnosis get` (a resume's transcript was missing; no history diagnosis is reported, and nothing is launched), with `<persona>` `"<name>" (key=<key>)`; or `readPersonaTranscript: transcript get` (checking whether a `working` row is idle), with `<persona>` `persona=<key>`; or `<prefix>: post-sweep get` (the server's `find-missing` run listed the persona's row as unverified, and the server read it once; `<prefix>` names the step that ran it, such as `escalate-dead`, `spawnForPersona: before resume`, `waitForWaitingAndReconnect`, `reconcileOrphans`, or `latch-clear`, the run right after a hold cleared, so the persona is held again with a new notice: see **How a hold clears** above), with `<persona>` `persona=<key>`; or `reconcileOrphans: start sweep list` (a server start listed its agent-director instances before its clean-up of old ones; the `latched from its own listed row` line follows), with `<persona>` `"<name>" (key=<key>)`. `<state>` is the state that read gave (for the start's listing, the state the row was listed in). Nothing more is called for the persona: the launch stops, or the wait or check ends. Logged once the persona is held, so it comes after the `latched` or `relatched` line below. With `the persona relatched` the hold now records this case and a new notice was posted; with `the persona was already latched with this case` nothing new is posted. | As for the notice. |
| `[slack] <site>: <what> for <persona>: its row carries the liveness note provenance_conflict, but persona=<key> is not a persona of the applied configuration — the note is not applied (b.jg5 SRJ-114)`, `[slack] <site>: <what> for <persona>: its row carries the liveness note provenance_conflict, but the row is not the persona's own (claude_instance_id="<id>") — the note is not applied (b.jg5 SRJ-114)` | The note was read, but on a row that is not the own row of a persona in the configuration (for example, the persona was removed meanwhile). Nobody is held and nothing is posted; the server goes on as if the row had no note. | Nothing. |
| `[slack] <site>: <what> for <persona>: its row carries the liveness note "<note>", which latches no one — going on (b.jg5 SRJ-114)` | agent-director noted something else on the persona's row (for example `tmux_server_changed` or `process_not_seen_session_present`). Only conflicting labels hold a persona; the server goes on. Logged once per persona for a note: again only when the note changes, after a read showing no note or conflicting labels, or after the persona reconnects, is found healthy again or is removed. Not a hold line, so the grep above leaves it out. | Nothing. |
| `[slack] waitForWaitingAndReconnect: "<name>" (key=<key>) is latched — the wait ends; nothing more is called and nothing is typed (b.jg5 SRJ-502)` | A launch waiting on the persona's `working` row found the persona held (by the wait's own row or screen read, or by another path meanwhile). The wait stops: nothing is typed and no *Not connected* notice is posted. | As for the notice. |
| `[slack] reconnectSession: persona=<key> is working and is latched — deferring; no deferral noted, nothing typed (b.jg5 SRJ-502)` | The health check's reconnect, checking whether a `working` row is idle, found the persona held (by its own row or screen read, or by another path before or meanwhile). Nothing is typed, and the held-back time toward the *Not connected* notice is not counted. | As for the notice. |
| `[slack] reconnectSession: persona=<key> is waiting and is latched — deferring; nothing typed (b.jg5 SRJ-502)` | The health check's reconnect, about to read the screen of a `waiting` row, found the persona held: that read held it (a conflict or an unusable tmux session name), or it was already held and the screen was not read. Nothing is typed. | As for the notice. |
| `[slack] reconnectSession: persona=<key> is <state> and is latched — deferring; no deferral noted, no notice, nothing typed (b.jg5 SRJ-502)` | The health check's reconnect, about to read the screen of an `ask_user` or `check_permission` row, found the persona held: that read held it (a conflict or an unusable tmux session name), or it was already held and the screen was not read. Nothing is typed, no *Waiting on a prompt* notice is posted and the held-back time is not counted. | As for the notice. |
| `[slack] spawnForPersona: "<name>" (key=<key>) reads <state> and is latched — no action; nothing typed and nothing more is called for it (b.jg5 SRJ-502)` | A launch found an `ask_user` or `check_permission` row and the persona held: its screen read held it, it was already held and the screen was not read, or another check held it while the read was out. Nothing is swept, resumed, killed or launched. | As for the notice. |
| `[slack] <prefix>: after the findMissing sweep for <ref> — one get of each configured persona's own row in unverified_ids: persona=<key> <read\|latched\|absent\|refused (<failure>)\|skipped (latched)>, … (b.jg5 SRJ-120)` | The server's `find-missing` run listed these personas' own rows as unverified, so it read each once, all at once, before going on, except a persona already held by a conflict; personas are listed in `unverified_ids` order. Logged when at least one of your personas was read or skipped. `latched` means the read held that persona (conflicting labels noted on its row, its row pending with no launch start, or an unusable tmux session name; that read's line and the `latched` line come before this one); `read` means no hold; `absent` that the row is gone; `refused` that agent-director refused the read (with `<prefix>` `reconcileOrphans`, the start sweep, it can also be an unusable tmux session name, which holds nobody there: its `UNUSABLE NAME met in the start sweep` line comes first, see [A persona posts a Held: unusable tmux session name notice](#a-persona-posts-a-held-unusable-tmux-session-name-notice)): for the persona whose step ran the sweep, that step stops (its `post-sweep get refused` line follows); for any other persona it changes nothing; `skipped (latched)` that the persona was already held, so its row was not read and no new notice was posted (it stays held; its step stops as for any hold). Rows that aren't your personas' own are never read. The grep above leaves it out; a `latched` persona's hold shows in its note line, which the grep keeps. | For `latched`, as for the notice; otherwise nothing. |
| `[slack] spawnForPersona: "<name>" (key=<key>) is latched after the findMissing sweep before resume — not resuming; nothing more is called for it (b.jg5 SRJ-502)` | A launch recovering a dead session ran `find-missing` first, and the persona was held by then (that run's read of its row, or another path meanwhile). Nothing is resumed, killed, deleted or launched. | As for the notice. |
| `[slack] <prefix>: <persona> is latched after the findMissing sweep — its row is not read; nothing more is called for it (b.jg5 SRJ-502)` | A persona whose row reads `ask_user` or `check_permission` had its `find-missing` run, and was held by then. `<prefix>` is `spawnForPersona: prompt row` (a launch: nothing is resumed or launched) or `reconnectSession: prompt row` (the health check's reconnect after 10 minutes of holding back: no *Waiting on a prompt* notice and no relaunch). | As for the notice. |
| `[slack] <site>: <persona> is latched after its <what> — nothing more is called for it (b.jg5 SRJ-502)` | A read of the persona's row came back and the persona was held by then: by another check while the read was out (such as the health check), or by that read itself (its own hold line comes first). `<site>: … <what>` is `spawnForPersona: … collision get` (the row read after the instance id was taken: nothing is spawned, killed, deleted, resumed or launched), `spawnForPersona: … ErrJsonlMissing diagnosis get` (the row read before bringing the persona up fresh after a missing transcript: no history diagnosis is reported, and nothing is launched), both with `<persona>` `"<name>" (key=<key>)`, or `<prefix>: … status read after the findMissing sweep` for a prompt row, `<prefix>` as in the line above (a launch does nothing more; the health check's reconnect posts no *Waiting on a prompt* notice and relaunches nothing). | As for the notice. |
| `[slack] <site>: <what> for <persona>: its row carries the liveness note provenance_conflict (state=<state>) — latching the persona failed: <error>; nothing more is called for it (b.jg5 SRJ-114, SRJ-501)`, `[slack] <site>: <what> for <persona>: its row carries the liveness note provenance_conflict, but the configured-persona query failed: <error> — the note is not applied (b.jg5 SRJ-114)`, `[slack] <site>: <what> for <persona>: applying the note rule failed: <error> (b.jg5 SRJ-114)` | An internal error while applying the note. With `latching the persona failed`, that launch, wait or check still stopped, but the hold may not be recorded and the notice may be missing. With the other two, the note was not applied and nobody was held. | Report it as a bug, with the persona's lines. |
| `[slack] conflict-latch: persona=<key> latched — case=<case> session="<name>" refused=<operation> state=<state>[ message="<description>"]` | The persona is held. `<operation>` is the refused call (`plain-spawn`, `reuse-spawn` or `resume`), or `bring-up` for a hold set from conflicting labels noted on its row (`case=conflicting-labels`, `session="slack_bot_<key>"`, no ` message=`); `<state>` is the state the server last read for its row before that call, or, when it had read none (the first spawn), the state one read right after the refusal gives (`no-row` when there is no row, `unreadable` when it could not be read), or for a noted row the state that read gave; ` message="…"` is agent-director's description, redacted, when it gave one. The notice is posted right after. | As for the notice. |
| `[slack] conflict-latch: re-check of "<name>" (key=<key>) — case=<case> step=<step> call=<call> answer=<answer>` | The server's own check of the held persona, one line every 2 minutes. `step` is what its first read of the row decided: `step-2` (the usual case: the row was there and the check went on to decide from it), `spawn-retry` (no row, and the hold came from a refused launch: that launch is tried again), `finished-row-retry` (no row, for a *Not this launch's session* hold: the persona is relaunched on its instance), `clear-reported-in` or `clear-gone` (the read itself showed the problem gone), `no-information` (the read failed) or `not-decided` (the read itself held the persona for another reason, or it was no longer held). `call` is the one call it made after reading the row: `none`, `read-pane` (the one-line look at the screen), `read-pane-pending` (the look at a still-starting screen of a *Conflicting labels* hold), `plain-spawn`, `reuse-spawn` or `resume` (the refused launch tried once more, or its replacement), `restart-decision` (one restart attempt), `finished-row-retry` (a *Not this launch's session* hold's read found nothing to relaunch) or `finished-row-retry:<launch>`. `answer` is what came of it: `still-latched` (the problem is still there), `no-information` or `no-information (…)` (the answer told the server nothing: agent-director not answering, tmux unavailable, an unclassified error, an instance id in use; `no-information (at-cap)` when the check made no launch or restart attempt because the persona is at the restart limit; `no-information (not-up)`, `(held)` or `(sequence-waiting)` when the check tried no launch because the persona is not up, is held on `ErrInvalidFlags`, or its working directory is held for an old instance; `no-information (observer-failed)` when its restart attempt could not be made), `config (config)` (agent-director refuses its config file), `kept (…)` (a look at the screen gave an answer that changes nothing), `probe-cleared (<kind>); <what came of it>` (the look at the screen found the problem gone; `call` then reads `read-pane+none` (with `no retry (at-cap)` for a persona at the restart limit: no `find-missing` and no launch), `read-pane+find-missing` when the `find-missing` run failed, or `read-pane+find-missing+<launch>` for the launch tried after it, whose answer decides), `relatched (case=<case>)`, `relatched-by-read (case=<case>)` or `unusable-name: …` (held again for another reason, with one new notice), `cleared (…)` (the hold ended, with one recovery notice and its `cleared` line), `not-latched` or `not-applied`. | For `no-information`, nothing: the next check comes 2 minutes later. For `config`, see [agent-director refuses a persona](#agent-director-refuses-a-persona-it-is-retried-on-its-own). For a new hold, follow its notice. For `cleared`, nothing. Otherwise as for the notice. |
| `[slack] conflict-latch: persona=<key> cleared — case=<case> session="<name>" reason="<reason>"; recovery notice posted` | The hold ended, and its one recovery notice (*Conflict cleared* or *Hold cleared*) was posted with `<reason>`. With `recovery notice not posted (the notice episodes are closed)`, the server was shutting down. See **The clear line** above. | Nothing; follow the `latch-clear:` lines for the bring-up. |
| `[slack] latch-recheck: "<name>" (key=<key>)'s "this row's own id" single retry was refused again with that case — its probe is dropped for the rest of this episode (b.jg5 SRJ-505)` | The launch tried after a look at the screen met *This row's own id* again: the worker may still run although its session is gone, which the look cannot see. From now on each check that reads the row `ended` or `missing` tries the refused launch instead of looking. | As for the notice. |
| `[slack] latch-clear: "<name>" (key=<key>)'s retry at once after its latch cleared answered <outcome> (b.jg5 SRJ-506)` | After a clear that launched nothing, the persona was brought up at once; `<outcome>` is what that restart attempt did (for example `launched`, `already-connected`, `pending-deferred` when its row is still starting and its retries wait it out, or `capped` when the persona is at the restart limit, so nothing was launched and it stays down; after a clear by hand only when the reset of its restart limit failed, since that clear clears the limit first). | Nothing, unless `<outcome>` is a failure: then as for that failure's notice. For `capped`, see **A held persona at the restart limit** above. |
| `[slack] latch-clear: the bypassing find-missing after "<name>" (key=<key>)'s latch cleared was refused — no launch in this attempt; the persona is left to its retry timer (b.jg5 SRJ-506, SRJ-120)` | The `find-missing` run after the clear failed, so nothing was launched then; the persona is no longer held, and its automatic retries bring it up. | See [agent-director refuses a persona](#agent-director-refuses-a-persona-it-is-retried-on-its-own). |
| `[slack] latch-clear: "<name>" (key=<key>) is latched again after the bypassing find-missing that followed its clear — no retry (b.jg5 SRJ-506, SRJ-114)` | The run after the clear still found conflicting labels on the persona's row: it is held again, with one new notice. | As for the new notice. |
| `[slack] latch-clear: "<name>" (key=<key>) is latched again before the run that follows its clear — nothing is called for it (b.jg5 SRJ-506, SRJ-502)`, `[slack] latch-clear: persona=<key> is not in the applied configuration — no find-missing and no retry after its latch cleared (b.jg5 SRJ-506)` | The server's own check cleared the hold, and the persona was held again before the bring-up that check owed it ran (a clear by hand never logs this), or it was removed meanwhile: nothing was called. | For a new hold, as for its notice; otherwise nothing. |
| `[slack] clear-latch: persona "<name>" (key=<key>) was not latched; nothing changed` | A request to clear the persona's hold by hand reached the server, but the persona was not held: nothing was posted, called or changed, its restart limit included. A hold cleared by hand logs only the clear line above, with `reason="cleared by hand"`, posts the recovery notice and clears the persona's restart limit; the `latch-clear:` lines of its bring-up follow. | Nothing. |
| `[slack] clear-latch: no persona in the applied configuration has the requested name or key; nothing cleared` | A request to clear a hold by hand named no persona of the configuration the server runs (the name or key it gave is never logged). Nothing was cleared. | Check the persona's name or key against the configuration the server runs (the last-applied record when there is one), then ask again. |
| `[slack] clear-latch: the clear of persona "<name>" (key=<key>) failed: <error>`, `[slack] latch-clear: the clear of persona=<key> failed: <error> — nothing runs after it (b.jg5 SRJ-506)`, `[slack] latch-clear: the run after persona=<key>'s latch cleared failed: <error> (b.jg5 SRJ-506)` | An internal error in a clear by hand: the clear itself failed, so whether the persona is still held is unknown and nothing ran after it; or the bring-up after a clear that succeeded failed. | Report it as a bug, with the persona's lines. Look for its `conflict-latch: persona=<key> cleared` line to tell whether the hold ended. |
| `[slack] latch-clear: the reset of persona=<key>'s restart failure count after its clear by hand failed: <error> (b.av2 SR-6.3; b.jg5 SRJ-506, SRJ-509)` | An internal error in a clear by hand: the hold ended, with its recovery notice, but the persona's restart limit may not have been cleared. The `find-missing` run and the bring-up still follow; for a persona at the limit the bring-up launches nothing (`answered capped`). | Report it as a bug, with the persona's lines. A server restart clears the limit; that is the operator's call. |
| `[slack] latch-clear: "<name>" (key=<key>)'s retry at once after its latch cleared failed: <error> (b.jg5 SRJ-506)`, `[slack] latch-clear: the run after persona=<key>'s latch cleared could not be run in its serializer turn: <error> (b.jg5 SRJ-506)`, `[slack] runRestartRetryInTurn: deps not initialized — skipping the retry for persona=<key>`, `[slack] conflict-latch: persona=<key> clear step failed (<step>): <error>` | An internal error after a clear: the bring-up may not have run, or a step of the clear (the record, the timer, the recovery post or the notice's end) failed. | Report it as a bug, with the persona's lines. |
| `[slack] latch-recheck: "<name>" (key=<key>)'s latch (refused=<operation>, case=<case>) matches no re-check row — its read only (b.jg5 SRJ-505)` | The hold's refused call and case leave the server's check nothing to try (for example a refused kill or screen read with a case that only a launch is retried for): each check only reads the row. | As for the notice. |
| `[slack] latch-recheck: the <what> of "<name>" (key=<key>) answered ErrInstanceIdCollision — no information: no get-then-act and nothing more is called; the persona stays latched (b.jg5 SRJ-505, SRJ-506)`, `[slack] spawnForPersona: the <what> of "<name>" (key=<key>) ended in <form> inside its latch re-check — no information: no get, nothing more is called; the persona stays latched (b.jg5 SRJ-505)`, `[slack] unavailable-retry: persona=<key> not armed (<cause>) — inside its latch re-check, an answer gives no information` | The launch the check made got an answer that tells the server nothing (its instance id in use, agent-director not answering or timing out); the persona stays held, and no retry is started for it. | Nothing: the next check comes 2 minutes later. |
| `[slack] latch-recheck: a launch is in flight for "<name>" (key=<key>) — no <call> in this re-check (b.jg5 SRJ-505)`, `[slack] latch-recheck: "<name>" (key=<key>)'s claude_config_dir does not resolve — no <call> in this re-check; the persona stays latched (b.jg5 SRJ-505)` | The check made no launch this time: another launch was still running for the persona, or its `claude_config_dir` does not resolve to a real path. | For the config directory, see [`persona-config-dir-unresolvable`](#persona-config-dir-unresolvable); otherwise nothing. |
| `[slack] latch-recheck: "<name>" (key=<key>) is at the restart cap — no <call> in this re-check; the persona stays latched (b.av2 SR-6.3; b.jg5 SRJ-505, SRJ-506)` | The check made no launch and no restart attempt this time (`<call>` names the one it would have made), and after a look at the screen that found the problem gone, no `find-missing` either: the persona has reached the restart limit (5 failed launches in a row, with its `SpawnCapReached` notice), and the limit wins over the hold. It stays held; each check still reads its row, so a hold that clears on that read still clears, but nothing is launched after it. | See **A held persona at the restart limit** above. `clear-latch` ends the hold and clears the limit, and restarting the server also clears it; either is the operator's call. |
| `[slack] latch-recheck: "<name>" (key=<key>) is not up — no <call> in this re-check; the persona stays latched (b.av2 SR-6.4; b.jg5 SRJ-505)` | The check made no launch this time: the persona is not up (its Slack connection is not serving, or its bring-up is broken or retrying). It stays held, and the next check, 2 minutes later, asks again. | See why the persona is not up (its bring-up lines); the hold is checked again once it is. |
| `[slack] latch-recheck: not launching "<name>" (key=<key>) — it is held on ErrInvalidFlags; no agent-director call (held; b.jg5 SRJ-207)` | The check made no launch this time: the persona is also held because agent-director rejected its launch flags. It stays held by the conflict too, and the next check asks again. | See [A persona posts a Cannot launch notice](#a-persona-posts-a-cannot-launch-notice) for that hold. |
| `[slack] latch-recheck: not launching "<name>" (key=<key>) — its working directory "<D>" is held for an old life that may still be running (…); waiting on it, its retry timer is not armed: it is latched, and its latch re-check retries it; no agent-director call (sequence-waiting; b.jg5 SRJ-810, SRJ-1502)` | The check made no launch this time: an old instance may still be running in the persona's working directory. The server waits for it to end; no retry timer is started, since the check itself tries again 2 minutes later. | See [A persona waiting on an old instance](#a-persona-waiting-on-an-old-instance). |
| `[slack] conflict-latch: persona=<key> re-check timer could not be set: <error> — not armed`, `[slack] conflict-latch: persona=<key> re-check round failed: <error>`, `[slack] conflict-latch: persona=<key> forget observer failed: <error>`, `[slack] latch-recheck: the clear hand-off failed for "<name>" (key=<key>): <error>`, `[slack] latch-recheck: the run of the restart path's decision failed for "<name>" (key=<key>): <error>`, `[slack] latch-recheck: the latch's set observer could not be added for "<name>" (key=<key>)'s run of the restart path's decision: <error> — its permit could not be revoked, so no run is made; the persona stays latched (b.jg5 SRJ-505, SRJ-506)` | An internal error in the server's own check: a held persona may get no further checks, or one check did nothing. The persona stays held. | Report it as a bug, with the persona's lines. |
| `[slack] conflict-latch: persona=<key> relatched — case=<case> (was <case>) session="<name>" refused=<operation> state=<state>[ message="<description>"]` | A held persona met a conflict of another case; the hold now records the new one, and a new notice is posted for it. The same case again logs nothing and posts nothing. | As for the notice. |
| `[slack] reconcileOrphans: "<name>" (key=<key>) latched from its own listed row instanceId=cscb_<key> (case=<case>) — its own row and every row labelled with it are left unkilled (b.jg5 SRJ-116, SRJ-502, SRJ-714)` | A server start's listing showed the persona's own row with conflicting labels (`case=conflicting-labels`) or pending with no launch start (`case=launch-start-not-recorded`), and the persona is held; its read line and the `latched` line come first. That start's clean-up ends none of the persona's instances, its own or any other carrying its label, whatever else is wrong with them, such as another working directory. After a restart this is how a hold whose cause is still there comes back, with one new notice. | As for the notice. |
| `[slack] reconcileOrphans: "<name>" (key=<key>) is latched (case=<case>) — its own row and every row labelled with it are left unkilled (b.jg5 SRJ-502, SRJ-714)` | The persona was already held when the start's clean-up ran, so its instances are left as they are. | As for the notice. |
| `[slack] spawnForPersona: not launching "<name>" (key=<key>) — it is latched (case=<case>); no agent-director call (b.jg5 SRJ-502)` | A launch was asked for the held persona (the start, a bring-up, a restart or a retry) and skipped. | Nothing more: this is the hold working. |
| `[slack] Not scheduling restart for persona=<key> — the persona is latched; no timer armed (b.jg5 SRJ-502)` | A restart was asked for the held persona (for example by a dropped connection) and none was scheduled. A lost message asks for none: its notice reports `held for a human`. | Nothing more: this is the hold working. |
| `[slack] Skipping restart for persona=<key> — the persona is latched; no agent-director call, nothing recorded (b.jg5 SRJ-502)` | A restart already pending when the persona was held, or a retry, did nothing. | Nothing more. |
| `[slack] reconnectSession: persona=<key> is latched — not typing /mcp reconnect; nothing done (b.jg5 SRJ-502)` | A restart was about to reconnect the persona's session and found it held just before typing, so nothing was typed and nothing was killed or counted. | Nothing more: this is the hold working. |
| `[slack] Session relaunch for persona=<key> ended latched — not counted; nothing more is done for it` | A restart's relaunch met the conflict and the persona was held at it. Nothing counts toward the restart limit. | As for the notice. |
| `[slack] unavailable-retry: persona=<key> stopped[ (pending-only)] — the persona is latched` | The persona's automatic retries stopped because it is held. | Nothing more. |
| `[slack] persona-episodes: persona=<key> tmux-unresponsive ended — the persona latched`, `[slack] persona-episodes: persona=<key> unclassified-error ended — the persona latched` | The hold ended the persona's *Not answering* record or its *Unclassified agent-director error* episode, with no further notice for either. | Nothing more. |
| `[slack] conflict-latch: persona=<key> hold failed (<hold>): <error>`, `[slack] conflict-latch: persona=<key> set observer failed: <error>`, `[slack] persona-episodes: persona=<key> conflict notice failed: <error>` | An internal error while holding the persona: a retry may still run, a record may stay open, or the notice may be missing. | Report it as a bug, with the persona's lines. The persona is still held. |
| `[slack] spawnForPersona: <step> refused for "<name>" (key=<key>): <error> — CONFLICT: latching the persona failed: <error>; no spawn-failure notice; nothing more is called (b.jg5 SRJ-105, SRJ-501)` | A launch step met the conflict but recording the hold failed (an internal error). That launch still stopped there, but the hold may not be recorded and the notice may be missing, so a later launch may try the persona again. | Report it as a bug, with the persona's lines. |
| `[slack] spawnForPersona: not launching "<name>" (key=<key>) — the latched query failed: <error> — taken as latched (case=unknown); no agent-director call (b.jg5 SRJ-502)`, `[slack] spawnForPersona: not launching "<name>" (key=<key>) — its latch record could not be read: <error> — taken as latched (case=unknown); no agent-director call (b.jg5 SRJ-502)`, `[slack] Not scheduling restart for persona=<key> — the persona is latched (the latched query failed: <error> — taken as latched); no timer armed (b.jg5 SRJ-502)`, `[slack] Skipping restart for persona=<key> — the persona is latched (the latched query failed: <error> — taken as latched); no agent-director call, nothing recorded (b.jg5 SRJ-502)`, `[slack] Session relaunch for persona=<key> ended latched (the latched query failed: <error> — taken as latched) — not counted; nothing more is done for it`, `[slack] reconnectSession: persona=<key> is latched (the latched query failed: <error> — taken as latched) — not typing /mcp reconnect; nothing done (b.jg5 SRJ-502)`, `[slack] unavailable-retry: persona=<key> the latched query failed: <error> — taken as latched; no agent-director call` | An internal error checking whether the persona is held. The server treats it as held: that launch, restart or retry did nothing, and a retry's timer stopped. A persona that was not really held is not launched again while the error lasts. A plain `not launching … — it is latched (case=unknown)` means the persona is held but its record could not be read. | Report it as a bug, with the persona's lines. |

---

## A persona posts a Held: unusable tmux session name notice

agent-director answered a call for the persona's own agent-director row
(`cscb_<key>`) that the tmux session name recorded on that row can't be
used: an internal error (`ErrInternal`) whose description names "the
recorded tmux session name". The server never records such a name on a
persona's own row, so agent-director's store was edited by hand. Any other
internal error is not this hold: it is an unclassified error (see
**agent-director returns an error the server can't classify** under
[agent-director refuses a persona](#agent-director-refuses-a-persona-it-is-retried-on-its-own)).

The server holds the persona when it meets that answer at:

- a launch step: any spawn or the resume of a launch (the reuse spawn that
  brings the persona up fresh on its own instance id included), or a kill
  the server makes while it replaces the persona's old instance (an
  `UNUSABLE NAME` line from `live-row-sequence: kill`);
- a restart's kill of the persona's old session before its relaunch (an
  `UNUSABLE NAME` line from `killSession (restart adapter)`); nothing is
  relaunched;
- the end of the server's own stuck launch (an `UNUSABLE NAME` line from
  `pendingRowRule stuck-launch abort: kill`); nothing is relaunched;
- a read of the persona's row: the row read after the instance id was
  already taken, the row read before bringing up fresh a persona whose
  resume found its transcript missing, the row read while checking whether a `working` row is idle, the
  row read right after the server's own `find-missing` run, the state reads
  of a launch waiting on a `working` row or on a prompt row, the state read
  of an automatic retry, the state reads of the health check and of a
  restart, the reconnect's state read, the one read made for a lost
  message, and the state read of the server's watch of a starting
  instance's startup prompts;
- a read of the persona's screen: by a launch waiting on a `working` row,
  and by the health check's reconnect checking a `working` or `waiting` row;
- the server's answer to a starting instance's startup prompts: its read
  of the screen or its Enter (an `UNUSABLE NAME` line under
  [Other lines you may see](#other-lines-you-may-see)); nothing is typed.

The row read right after the `find-missing` run of the start sweep (the
clean-up of old sessions at a server start) is the exception: there the
answer holds nobody and posts nothing. It is only logged (the `UNUSABLE NAME
met in the start sweep` line below), and the persona's launch goes on.
The kill of a confirmed change's teardown (or the read between its tries)
holds nobody either: nothing latches and nothing is posted, and the answer
is written to `server.log` and a `persona-teardown-notice` entry,
`agent-director kill of cscb_<key> refused at a try: outcome=not-killed class=UNUSABLE_NAME …`
(see
[A notice raised during a teardown](#a-notice-raised-during-a-teardown)).

The persona is then held: its destination gets one *Held: unusable tmux
session name* notice, and the server attempts nothing more for it.

While the persona is held:

- the server stops answering the startup prompts of its starting instance
  at once (an `approvePreSessionDialogs: … is latched` or `stopping the
  approver … (latched)` line), and types nothing into it;
- its starting instance gets no check with agent-director and no *Session
  not starting* notice (a `pending-row: … rule (<origin>): no lap, run or
  post — the persona is latched` line at most);
- it is not launched, resumed, reconnected or killed by the server on its
  own, nothing is typed into its session, and the server makes no tmux call
  for it;
- nothing is counted toward the restart limit for it, no `Spawn failure:`
  notice is posted and no `spawn-failed` entry is recorded;
- its automatic retries stop; a retry armed later stops at its first try;
- the health check still reads its state, but never restarts it,
  reconnects it or posts a notice for it; the server's own check (see
  **The server's own check** under
  [A persona posts a Held: tmux session conflict notice](#a-persona-posts-a-held-tmux-session-conflict-notice))
  reads its row every 2 minutes and makes no other call;
- messages sent to it are lost, and each one's *Message lost* notice
  reports `held for a human`, with no restart started;
- a *Not answering* record ends with no *Answering again*, and an
  *Unclassified agent-director error* episode ends with no notice.

Other personas are not affected.

**How a hold clears.** The server's own check clears it once its read finds
the row gone (`ErrSpawnNotFound`: a human removed it), or running when the
hold began on a row recorded `ended`, `missing`, `pending` or `no-row`. The
persona's destination gets one *Hold cleared* notice, its `cleared` line is
logged with `reason="its agent-director row is gone"` (or `reads <state>`),
and the persona comes up fresh at once, after one `find-missing` run (its
`latch-clear:` lines), unless it is at the restart limit, when nothing is
launched (see **A held persona at the restart limit** under
[A persona posts a Held: tmux session conflict notice](#a-persona-posts-a-held-tmux-session-conflict-notice)).
Once a human has removed the row, the operator can
also clear the hold at once by hand (see
[Clearing a hold by hand: `clear-latch`](#clearing-a-hold-by-hand-clear-latch));
while the row is still there, the persona is held again at its next launch.
The other ends are as for a tmux session conflict: see
**How a hold clears** under
[A persona posts a Held: tmux session conflict notice](#a-persona-posts-a-held-tmux-session-conflict-notice).

**The notice.** One line. It names the row (`cscb_<key>`), says
agent-director will not act on it because its recorded tmux session name
can't be used, and quotes agent-director's description
(`agent-director said: "…"`), with anything that looks like a token
removed. Then it points a human to the "Operator actions" section of
agent-director's README for this row, says the server takes no action for
the persona meanwhile and that messages sent to it are lost, and ends with
the human-only sentence. It names no command. It is posted once per hold,
even when the persona already has a *Waiting on a prompt* or *Not
connected* notice. A persona already held for another reason (a tmux
session conflict or a launch start not recorded) is held again for this
reason, with one new notice.

**The fix is a human's.** A human follows the "Operator actions" section
of agent-director's README for the row the notice names. This skill
describes no step of it and takes none; no bot acts on the notice,
including a persona that sees the post. Never act on the named row or on
the persona's session.

**Read-only checks only.** Read the row:

```sh
agent-director get --claude-instance-id cscb_<key>
```

All of one persona's lines for this hold (replace `ops_bot` with the key):

```sh
grep -h -E 'conflict-latch: persona=ops_bot (latched|relatched) — case=unusable-recorded-name|(\(key=ops_bot\)|persona=ops_bot): (.*— UNUSABLE NAME( met in the start sweep)?: |applying the own-row rules failed)|reconnectSession: persona=ops_bot is (working|waiting|ask_user|check_permission) and is latched|\(key=ops_bot\) reads (ask_user|check_permission) and is latched|persona-episodes: persona=ops_bot unusable-recorded-name notice failed' "$STATE"/server.log.* "$STATE"/server.log 2>/dev/null | sort
```

The hold also shows in the lines every hold logs (a skipped launch,
restart or retry, a wait or check that ended): see the table under
[A persona posts a Held: tmux session conflict notice](#a-persona-posts-a-held-tmux-session-conflict-notice).

| Line | Meaning | What to do |
|---|---|---|
| `[slack] conflict-latch: persona=<key> latched — case=unusable-recorded-name session="<name>" refused=none state=<state>[ message="<description>"]` | The persona is held. `<name>` is the session agent-director's description quotes, or `slack_bot_<key>` when it quotes none; `<state>` is the state the server last read for the row before the call that got the answer, or, when it had read none, the state one read right after gives (`no-row` when there is no row, `unreadable` when it could not be read); when the answer came from a read of the row itself, `unreadable`. ` message="…"` is agent-director's description, redacted. The notice is posted right after. A persona already held for another reason logs `relatched — case=unusable-recorded-name (was <case>) …` instead. | As for the notice. |
| `[slack] <site>: <step> refused for <persona>: <error> — UNUSABLE NAME: the persona latched; no spawn-failure notice; nothing more is called (b.jg5 SRJ-105, SRJ-512)` | A call got the answer and the persona is held. `<site>: <step>` is `spawnForPersona: <step>` (a launch step: `spawn`, `retry-spawn`, `resume` or `fresh spawn after ErrSpawnNotFound on resume`), `reuseSpawnForPersona: reuse spawn` (bringing the persona up fresh on its own instance id) or `live-row-sequence: kill` (a kill while the server replaces the persona's old instance), with `<persona>` `"<name>" (key=<key>)`; or `killSession (restart adapter): kill` (a restart's kill of the old session; the restart stops with no relaunch), with `<persona>` `persona=<key>`. Nothing is killed, deleted, launched or typed after it, and nothing is counted. Logged after the `latched` line above. | As for the notice. |
| `[slack] <site>: pane read refused for persona=<key>: <error> — UNUSABLE NAME: the persona latched; nothing is typed and nothing more is called for it (b.jg5 SRJ-105, SRJ-512)` | A read of the persona's screen (`<site>` as in the conflict line: `readWorkingPane` for a launch's wait or a `waiting` row, `reconnectSession` for a `working` row, `reconnectSession: prompt row` or `spawnForPersona: prompt row` for an `ask_user` or `check_permission` row) got the answer, and the persona is held. The wait ends or the check holds back; nothing is typed. A persona already held gets no screen read and no such line. Logged after the `latched` line above. | As for the notice. |
| `[slack] <site>: <what> for <persona>: <error> — UNUSABLE NAME: the persona latched; nothing more is called for it (b.jg5 SRJ-105, SRJ-512)` | A read of the persona's row got the answer and the persona is held. `<site>: <what>` is `spawnForPersona: collision get`, `spawnForPersona: ErrJsonlMissing diagnosis get` (no history diagnosis is reported, and nothing is launched) or `spawnForPersona: latch-time status read`; `killSession (restart adapter): latch-time status read` (made only when a restart's kill was refused after the persona read dead because the agent-director install was gone; the restart stops with no relaunch); `readPersonaTranscript: transcript get`; `<prefix>: post-sweep get` or `<prefix>: status read after the findMissing sweep` (`<prefix>` names the step that ran the `find-missing` run, as in the conflict section's table); `waitForWaitingAndReconnect: status read` or `waitForWaitingAndReconnect: timeout: status read` (a launch waiting on a `working` row: the wait ends, nothing typed); `unavailable-retry: retry row read` (the retries stop); `isSessionAlive: status` (the health check's, a restart's or a lost message's read: the restart stops, and a lost message reports `held for a human`); `reconnectSession: status check` (nothing is typed); or `approvePreSessionDialogs: readiness status read` (a starting instance's own read: the server stops answering its startup prompts and types nothing). `<persona>` is `"<name>" (key=<key>)` or `persona=<key>`. | As for the notice. |
| The same three lines ending `— UNUSABLE NAME: the persona was already latched with this case; …` | The persona was already held for this reason, and a read or call got the same answer again. Nothing new is posted. The health check reads a held persona's state at every check; a read that gets the same answer logs an `isSessionAlive: status` line like this one, followed by `[slack] health-check: liveness unknown for persona=<key> — skipping it this tick; not read as dead`. A read that answers normally logs neither. | Nothing more: this is the hold working. |
| The same three lines ending `— UNUSABLE NAME: the persona relatched; …` | The persona was held for another reason and is now held for this one, with one new notice. | As for the notice. |
| `[slack] spawnForPersona: <step> refused for <persona>: <error> — UNUSABLE NAME: the latch-time status read latched the persona, so that latch stands; no spawn-failure notice; nothing more is called (b.jg5 SRJ-105, SRJ-512)` | A launch step got the answer, and the one state read made right after it got the same answer, which held the persona already (its `spawnForPersona: latch-time status read` line comes first). One hold and one notice. | As for the notice. |
| `[slack] spawnForPersona: <step> refused for <persona>: <error> — UNUSABLE NAME: the persona was latched elsewhere during the latch-time status read, so that latch stands; no spawn-failure notice; nothing more is called (b.jg5 SRJ-105, SRJ-512)` | A launch step got the answer, but by the time the one state read made right after it returned, the persona had already been held by another check (such as the health check). That hold stands, with its own notice; this answer adds no hold and no notice. | As for the notice the persona's destination has. |
| `[slack] reconcileOrphans: post-sweep get for persona=<key>: <error> — UNUSABLE NAME met in the start sweep: routed to the server log; nothing latches (b.jg5 SRJ-512, SRJ-1002)` | At a server start, the row read right after the start sweep's `find-missing` run got the answer. Nobody is held and nothing is posted; the sweep's `one get of each configured persona's own row` line shows the persona as `refused (<error>)`, and its launch goes on. If its launch meets the same answer, that holds the persona as above. | Read the row (below). If it shows the same, a human follows the "Operator actions" section of agent-director's README for it; no bot acts on it. |
| The three `UNUSABLE NAME` lines with `latching the persona failed: <error>` as the outcome, `[slack] persona-episodes: persona=<key> unusable-recorded-name notice failed: <error>`, `[slack] <site>: <what> for <persona>: applying the own-row rules failed: <error> (b.jg5 SRJ-115)` | An internal error while holding the persona or posting its notice: the step that met the answer still stopped, but the hold may not be recorded or the notice may be missing. | Report it as a bug, with the persona's lines. |

---

## A persona posts a Held: launch start not recorded notice

The persona's own agent-director row (`cscb_<key>`) reads `pending` but
records no launch start: the row shows none, or one that is not a valid
timestamp. Only an agent-director process older than the installed one, or
a hand edit of agent-director's store, writes such a row, and agent-director
acts on no session for it: it types nothing into it and never ends it.

The server holds the persona the first time it reads such a row for it,
at any read of the persona's row: a server start's listing of its
agent-director instances, before its clean-up of old ones (that start then
ends none of the persona's instances, its own or any other carrying its
label, even one in another working directory or config directory; after a
restart this is how the hold comes back, with one new notice), the row read after the instance id was
already taken, the row read before bringing up fresh a persona whose resume
found its transcript missing, the row read while checking whether a `working` row is idle, the
row read right after the server's own `find-missing` run, the state reads
of a launch waiting on a `working` row or on a prompt row, the state read
of an automatic retry, the state reads of the health check and of a
restart, the reconnect's state read, the one read made for a lost message,
the state read of the server's watch of a starting instance's startup
prompts, and the state read made right after a launch step met a tmux session
conflict or an unusable tmux session name. It holds it whether or not the
server launched that row, a row whose working directory differs from the
persona's included. Only a persona in the applied configuration is held:
such a row under a key no persona uses holds nobody.

The persona is then held: its destination gets one *Held: launch start not
recorded* notice, and the server attempts nothing more for it.

While the persona is held:

- the server stops answering the startup prompts of its starting instance
  at once (an `approvePreSessionDialogs: … is latched` or `stopping the
  approver … (latched)` line), and types nothing into it;
- its starting instance gets no check with agent-director and no *Session
  not starting* notice (a `pending-row: … rule (<origin>): no lap, run or
  post — the persona is latched` line at most);
- it is not launched, resumed, reconnected or killed by the server on its
  own, and nothing is typed into its session;
- nothing is counted toward the restart limit for it, no `Spawn failure:`
  notice is posted and no `spawn-failed` entry is recorded;
- its automatic retries stop, and a retry armed later stops at its first
  try;
- the health check still reads its row, but never restarts it, reconnects
  it or posts a notice for it; the server's own check (see
  **The server's own check** under
  [A persona posts a Held: tmux session conflict notice](#a-persona-posts-a-held-tmux-session-conflict-notice))
  reads its row every 2 minutes and makes no other call;
- messages sent to it are lost, and each one's *Message lost* notice
  reports `held for a human`, not `starting`, with no restart started;
- a *Not answering* record ends with no *Answering again*, and an
  *Unclassified agent-director error* episode ends with no notice.

Other personas are not affected.

**How a hold clears.** The server's own check clears it once its read finds
the row running, `ended` or `missing`, or gone (its line shows
`answer=cleared (…)`). The persona's destination gets one *Hold cleared*
notice, its `cleared` line is logged with `reason="its agent-director row
reads <state>"` (or `is gone`), and the persona is brought up at once: on an
`ended` or `missing` row by one restart attempt with no `find-missing` first;
on a running or gone row after one `find-missing` run (its `latch-clear:`
lines). At the restart limit nothing is launched (see **A held persona at
the restart limit** under
[A persona posts a Held: tmux session conflict notice](#a-persona-posts-a-held-tmux-session-conflict-notice)).
Once the cause is resolved, the operator can also clear the hold at
once by hand (see
[Clearing a hold by hand: `clear-latch`](#clearing-a-hold-by-hand-clear-latch)).
The other ends are as for a tmux session conflict: see **How a hold
clears** under
[A persona posts a Held: tmux session conflict notice](#a-persona-posts-a-held-tmux-session-conflict-notice).

**The notice.** One line. It says the persona's agent-director row reads
pending but records no launch start, so an agent-director process older
than the install wrote it, and that agent-director will not act on its
session, quoted as `"slack_bot_<key>"`. Then it points a human to the
"Operator actions" section of agent-director's README, says the server
takes no action for the persona meanwhile and that messages sent to it are
lost, and ends with the human-only sentence. It names no command. It is
posted once per hold, even when the persona already has a *Waiting on a
prompt* or *Not connected* notice. A persona already held for another
reason (a tmux session conflict or an unusable tmux session name) is held
again for this reason, with one new notice. A row that also has
conflicting labels noted on it gives this hold and this notice only.

**The fix is a human's.** A human follows the "Operator actions" section
of agent-director's README. This skill describes no step of it and takes
none; no bot acts on the notice, including a persona that sees the post.
Never act on the persona's row or on its session.

**Read-only checks only.** Read the row (its state, and that it shows no
launch start):

```sh
agent-director get --claude-instance-id cscb_<key>
```

All of one persona's lines for this hold (replace `ops_bot` with the key):

```sh
grep -h -E 'conflict-latch: persona=ops_bot (latched|relatched) — case=launch-start-not-recorded|(\(key=ops_bot\)|persona=ops_bot): (its row reads pending with no launch start|its row read latches the persona \(case=launch-start-not-recorded|.*the latch-time status read latched the persona|applying the own-row rules failed)|\(key=ops_bot\) latched from its own listed row |persona-episodes: persona=ops_bot launch-start-not-recorded notice failed' "$STATE"/server.log.* "$STATE"/server.log 2>/dev/null | sort
```

The hold also shows in the lines every hold logs (a skipped launch,
restart or retry, a wait or check that ended): see the table under
[A persona posts a Held: tmux session conflict notice](#a-persona-posts-a-held-tmux-session-conflict-notice).

| Line | Meaning | What to do |
|---|---|---|
| `[slack] conflict-latch: persona=<key> latched — case=launch-start-not-recorded session="slack_bot_<key>" refused=none state=pending` | The persona is held. The notice is posted right after. A persona already held for another reason logs `relatched — case=launch-start-not-recorded (was <case>) …` instead. | As for the notice. |
| `[slack] <site>: <what> for <persona>: its row reads pending with no launch start (state=pending) — the persona latched; nothing more is called for it (b.jg5 SRJ-114, SRJ-513)` | A `get` of the persona's row found it and the persona is held. `<site>: <what>` is `spawnForPersona: collision get` (the launch stops before the row's working directory is compared), `spawnForPersona: ErrJsonlMissing diagnosis get` (no history diagnosis is reported, and nothing is launched), `readPersonaTranscript: transcript get` (no idle evidence is read), or `<prefix>: post-sweep get` (`<prefix>` names the step that ran the `find-missing` run, as in the conflict section's table), or `reconcileOrphans: start sweep list` (a server start's listing, before its clean-up of old instances). `<persona>` is `"<name>" (key=<key>)` or `persona=<key>`. Logged after the `latched` line above. | As for the notice. |
| `[slack] reconcileOrphans: "<name>" (key=<key>) latched from its own listed row instanceId=cscb_<key> (case=launch-start-not-recorded) — its own row and every row labelled with it are left unkilled (b.jg5 SRJ-116, SRJ-502, SRJ-714)` | The start's listing held the persona (its `start sweep list` line comes first). That start's clean-up ends none of the persona's instances. See the conflict section's table for this line and its `is latched (case=<case>)` form. | As for the notice. |
| `[slack] <site>: <what> for <persona>: its row read latches the persona (case=launch-start-not-recorded, state=pending) — the persona latched; nothing more is called for it (b.jg5 SRJ-115, SRJ-501)` | A state read of the persona's row found it and the persona is held. `<site>: <what>` is `spawnForPersona: latch-time status read`; `killSession (restart adapter): latch-time status read` (made only when a restart's kill was refused after the persona read dead because the agent-director install was gone; the restart stops with no relaunch); `<prefix>: status read after the findMissing sweep`; `waitForWaitingAndReconnect: status read` or `waitForWaitingAndReconnect: timeout: status read` (a launch waiting on a `working` row: the wait ends, nothing typed); `unavailable-retry: retry row read` (the retries stop); `isSessionAlive: status` (the health check's, a restart's or a lost message's read: the restart stops, and a lost message reports `held for a human`); `reconnectSession: status check` (nothing is typed); or `approvePreSessionDialogs: readiness status read` (a starting instance's own read: the server stops answering its startup prompts and types nothing). `<persona>` is `"<name>" (key=<key>)` or `persona=<key>`. | As for the notice. |
| The same two lines ending `— the persona was already latched with this case; …` | The persona was already held for this reason, and a read found the row unchanged. Nothing new is posted. While the row stays as it is, every health check reads it, logs an `isSessionAlive: status` line like this one, then `[slack] health-check: liveness unknown for persona=<key> — skipping it this tick; not read as dead`. | Nothing more: this is the hold working. |
| The same two lines ending `— the persona relatched; …` | The persona was held for another reason and is now held for this one, with one new notice. | As for the notice. |
| `[slack] spawnForPersona: <step> refused for <persona>: <error> — CONFLICT: the latch-time status read latched the persona, so that latch stands; no spawn-failure notice; nothing more is called (b.jg5 SRJ-105, SRJ-501)`, or the same with `— UNUSABLE NAME:` and `(b.jg5 SRJ-105, SRJ-512)` | A launch step met a tmux session conflict or an unusable tmux session name, and the one state read made right after it found the row pending with no launch start, which held the persona for that (its `spawnForPersona: latch-time status read` line comes first). One hold and one notice, *Held: launch start not recorded*. | As for the notice. |
| The two lines above with `latching the persona failed: <error>` as the outcome, `[slack] persona-episodes: persona=<key> launch-start-not-recorded notice failed: <error>`, `[slack] <site>: <what> for <persona>: applying the own-row rules failed: <error> (b.jg5 SRJ-115)` | An internal error while holding the persona or posting its notice: the step that read the row still stopped, but the hold may not be recorded or the notice may be missing. | Report it as a bug, with the persona's lines. |

---

## Clearing a hold by hand: `clear-latch`

The operator ends one persona's hold on the running server, whichever of
these held it (*Held: tmux session conflict*, *Held: unusable tmux session
name* or *Held: launch start not recorded*), with the command below. A
*Cannot launch* hold (`ErrInvalidFlags`) is not one of these: the command
does not end it and answers `was not latched`.

```sh
claude-slack-channel-bots clear-latch <persona>
```

`<persona>` is the persona's name or key in the configuration the server
runs; a name with spaces is quoted for the shell. Only that persona's hold is
cleared. It is run only on the operator's explicit say-so, never by a
persona (see [Constraints](#constraints)).

**When the operator uses it.** Once a human has resolved the hold's cause
through the "Operator actions" section of agent-director's README, to bring
the persona back at once instead of at the server's own check every 2
minutes, or for a hold that check cannot clear (`case=unrecognised` or
`case=never-reported-in` on a row that stays as it is). No restart is
needed.

**What a clear posts.** For a held persona: one recovery notice, *Conflict
cleared* or *Hold cleared*, closing with "CSCB is recovering this persona
again." The server logs the clear line with `reason="cleared by hand"`, then
runs `find-missing` once and brings the persona up at once; its
`latch-clear:` lines follow (see **What follows a clear** under
[A persona posts a Held: tmux session conflict notice](#a-persona-posts-a-held-tmux-session-conflict-notice)).
A persona whose cause is still there is held again, with one new notice:
after that `find-missing` run when conflicting labels are still noted
(`is latched again after the bypassing find-missing`), or at the launch that
meets the problem again (a new `latched` line). Ending a hold also clears
the persona's restart limit, before the bring-up: a persona that had
reached it is brought up too, and its count of failed launches starts again
from 0 (see **A held persona at the restart limit** under
[A persona posts a Held: tmux session conflict notice](#a-persona-posts-a-held-tmux-session-conflict-notice)).
An unheld persona gets nothing: no post, no call, no change to its restart
limit, and one `was not latched` line.

**How it reaches the server.** It reads `server.pid` as `stop` does, then
`server.port`, which the running server writes beside it, and uses that
record only when its PID is the running server's. It sends one request to
`127.0.0.1` at the recorded port, never to the `bind` or `port` of
`config.json` or the last-applied record, connecting directly whatever
proxy variable (`HTTP_PROXY` and the like) is set, and waits at most 30 s for the
answer. So it reaches only a server whose `bind` is `127.0.0.1` (the
default) or `0.0.0.0`, as scheduled prompts do. On any other `bind` a hold
ends only by the server's own check, by the persona's teardown (its removal
or a destructive change), or by a server restart, which drops every hold.
It reads no configuration file, needs no agent-director, and writes or
removes no file.

**Its lines.** Each run prints one line on stderr; none repeats the
argument.

| Line (exit code) | Meaning and cause | Fix |
|---|---|---|
| `Usage: claude-slack-channel-bots clear-latch <persona name or key>` (2) | It was not given exactly one non-empty argument: none, more than one (a name with spaces left unquoted), or an empty one. | Run it again with one persona name or key, quoted if it has spaces. |
| `clear-latch: no server is running` (1) | `server.pid` is absent, unreadable or names a process that is not running: no server runs against this state directory, so there is no hold to clear (a hold lives only in the running server's memory). | Check `SLACK_STATE_DIR` is the server's. Starting the server is the operator's call; a fresh start holds a persona again only if its cause is still there. |
| `clear-latch: the server did not answer: <cause>` (1) | The server could not be reached, so nothing was cleared, or the clear's result is unknown. `<cause>` says why: `server.port is absent`, `server.port could not be read`, `server.port is malformed`, `server.port holds a PID or port out of range` or `server.port was written by another process` (no request was made: the record is missing or not the running server's, for example after its write failed at start, or a server stopped between the check and the read); a connection error (the server stopped meanwhile, or its `bind` gives it no `127.0.0.1` listener); or `HTTP <status>`, an answer the command did not expect (`HTTP 500`: the clear failed inside the server). | Look for a `server.port: could not write` line (see [Other lines you may see](#other-lines-you-may-see)) and check the `bind` in the configuration the server runs. For `HTTP 500`, look for the `clear-latch: the clear of persona … failed` line and the persona's `cleared` line (grep below). Then, on the operator's say-so, run it again. |
| `clear-latch: the server did not confirm within 30 s; the clear is queued and may still run. Check this persona's latch in the server log before trying again.` (1) | No answer came back within 30 s, usually because other work for the persona was still running; the clear is queued behind it and may still run. | Run the grep below: a `cleared` line with `reason="cleared by hand"` means the hold ended. Try again only if the persona is still held. |
| `clear-latch: no persona in the running configuration has that name or key` (1) | No persona of the configuration the server runs (the last-applied record when there is one) has that name or key. Nothing changed. | Check the name or key against that configuration (see [Reading a persona line](#reading-a-persona-line)), then run it again. |
| `clear-latch: cleared the latch of persona "<name>" (key=<key>)` (0) | The persona was held, and the hold and its restart limit are cleared: its recovery notice is posted and it is being brought up. | Nothing; follow its `latch-clear:` lines. If it is held again, its cause is still there: follow the new notice. If the retry at once `answered capped`, the reset of its restart limit failed: see the `latch-clear: the reset of … failed` line in the table under [A persona posts a Held: tmux session conflict notice](#a-persona-posts-a-held-tmux-session-conflict-notice). |
| `clear-latch: persona "<name>" (key=<key>) was not latched; nothing changed` (0) | The persona was not held, for example because the server's own check already cleared it. A *Cannot launch* hold also answers this, since the command does not end it. Its restart limit is unchanged: a persona at the limit that is not held stays down until the operator restarts the server or makes a destructive change to the persona. | Nothing; for a *Cannot launch* hold, follow that notice's section. For a persona at the restart limit, see **A held persona at the restart limit** under [A persona posts a Held: tmux session conflict notice](#a-persona-posts-a-held-tmux-session-conflict-notice). |

To follow a clear by hand for one persona (`ops_bot` here), read-only:

```sh
grep -h -E 'conflict-latch: persona=ops_bot cleared — .*reason="cleared by hand"|latch-clear: .*(\(key=ops_bot\)|persona=ops_bot[^_a-zA-Z0-9])|clear-latch: .*\(key=ops_bot\)' "$STATE"/server.log.* "$STATE"/server.log 2>/dev/null | sort
```

The server's own lines for a clear by hand (`clear-latch: … was not
latched`, `no persona in the applied configuration`, `the clear of persona …
failed`) are in the hold's table under
[A persona posts a Held: tmux session conflict notice](#a-persona-posts-a-held-tmux-session-conflict-notice).

---

## A persona posts a Cannot launch notice

The host's agent-director rejected the flags of the persona's launch
(`ErrInvalidFlags`) when the server brought the persona up fresh on its own
agent-director row (a reuse spawn: after a finished row, after a resume that
found no conversation, or as the last step of replacing an old instance).
The installed agent-director may not match this CSCB release, so every
further launch would be rejected the same way.

Right after that answer the server checks the agent-director binary's
version once more. A binary below the required version stops the server
instead, with nothing posted (see
[Found while the server was running](#found-while-the-server-was-running)).
Otherwise (the check passed, could not run, or no check was running) the
persona is held: its destination gets one *Cannot launch* notice, and the
server launches nothing more for it. The server never tries another kind
of launch in its place and makes no tmux call for it. Only this launch
holds a persona: the same answer to a resume or to any other call holds
nobody.

While the persona is held:

- it is not launched, resumed, reconnected or restarted by the server, on
  any path (the start, a bring-up, a restart, a retry or a replacement of
  its old instance), and no agent-director call is made for a launch;
- nothing is counted toward the restart limit for it, no `Spawn failure:`
  notice is posted and no `spawn-failed` entry is recorded; a start counts
  it under `held on invalid flags`, neither as failed nor as succeeded;
- its automatic retries stop, and a retry armed later stops at its first
  try;
- the health check still reads its row, but never restarts it or posts a
  notice for it;
- messages sent to it are lost, and each one's *Message lost* notice
  reports `cannot launch`, with no restart started.

Other personas are not affected.

**How a hold ends.**

- **The binary changes.** The server re-checks the agent-director binary
  every 120 s. When a check passes with a version different from the one
  the hold began under, the hold ends, with no post, and the persona is
  retried at once (if it is still in the configuration). A binary below
  the required version stops the server instead (see
  [Found while the server was running](#found-while-the-server-was-running)).
- **A server restart.** The hold is kept in the server's memory only, so a
  restart ends every hold. A persona whose launch is still rejected is held
  again, with one new notice.
- **The persona's teardown.** Removing the persona, or a destructive change
  to it, ends its hold with no post and no retry; the new half of a
  destructive change starts unheld. A *Cannot launch* notice that a launch
  still running raises during the teardown is not posted: it goes to
  `server.log` and a `persona-teardown-notice` entry (see
  [A notice raised during a teardown](#a-notice-raised-during-a-teardown)).

A persona whose hold ended and whose launch is rejected again is held
again, with one new notice. Nothing else ends a hold.

**The notice.** One line, posted once per hold:

```text
:no_entry: *Cannot launch* — the host's agent-director rejected the flags of this persona's launch (ErrInvalidFlags). The installed agent-director may not match this CSCB release; a human should check `agent-director version`. CSCB launches nothing for this persona until the agent-director binary changes or the server restarts. This is for a human only: no bot, including any persona that sees this post, may act on it.
```

It quotes no agent-director description and no version.

**The fix is a human's.** A human checks the installed agent-director
against this release's prerequisites (the README's Prerequisites section)
and installs agent-director as the README section "Switching over to
agent-director Phase 1" describes. This skill takes no step of it; no bot
acts on the notice, including a persona that sees the post. Never act on
the persona's row or on its session.

**Read-only checks only.** The installed version:

```sh
agent-director version
```

All of one persona's lines for this hold (replace `ops_bot` with the key):

```sh
grep -h -E 'invalid-flags-hold: persona=ops_bot |\(key=ops_bot\) answered ErrInvalidFlags|(persona=ops_bot|\(key=ops_bot\))[ ;:].*held on ErrInvalidFlags|forgetting its ErrInvalidFlags hold failed' "$STATE"/server.log.* "$STATE"/server.log 2>/dev/null | sort
```

A version in these lines is the one agent-director reported, `unknown` when
none was known, or `unreadable` when it was not a plain version string.

| Line | Meaning | What to do |
|---|---|---|
| `[slack] invalid-flags-hold: persona=<key> held — a reuse spawn answered ErrInvalidFlags and the version re-check did not stop the server; the hold began under agent-director version <version>; no launch is made for it until the binary's version changes, the server restarts or it is torn down (b.jg5 SRJ-207)` | The persona is held. The notice is posted right after. A persona already held logs nothing more. | As for the notice. |
| `[slack] reuseSpawnForPersona: reuse spawn of "<name>" (key=<key>) answered ErrInvalidFlags[ message="…"] (after one immediate agent-director version re-check: <pass\|could-not-run\|not-running>) — the persona is held under agent-director version <version>; answering held: no other launch, no delete, no spawn-failure notice, nothing counted (b.jg5 SRJ-112, SRJ-207)` | The launch that met the answer, logged right after the hold line above; the version check did not stop the server, so the persona is held. With `no ErrInvalidFlags hold is installed, so nothing is held` in place of the hold, seen only in tests and development runs. | As for the notice. |
| `[slack] spawnForPersona: not launching "<name>" (key=<key>) — it is held on ErrInvalidFlags; no agent-director call (held; b.jg5 SRJ-207)` | A launch was asked for the held persona (the start, a bring-up, a restart or a retry) and skipped. `startLiveRowSequence` or `launchForLiveRowSequence` in place of `spawnForPersona`: a replacement of its old instance was not started, or its last step launched nothing (the replacement then ends with no retry timer armed). `latch-recheck` in its place: the persona is also held by a conflict, and that hold's own check launched nothing (see [A persona posts a Held: tmux session conflict notice](#a-persona-posts-a-held-tmux-session-conflict-notice)). | Nothing more: this is the hold working. |
| `[slack] Not scheduling restart for persona=<key> — the persona is held on ErrInvalidFlags; no timer armed (b.jg5 SRJ-207)` | A restart was asked for the held persona (for example by a dropped connection) and none was scheduled. A lost message asks for none: its notice reports `cannot launch`. | Nothing more: this is the hold working. |
| `[slack] Skipping restart for persona=<key> — the persona is held on ErrInvalidFlags; no agent-director call, nothing recorded (b.jg5 SRJ-207)` | A restart already pending when the persona was held, or a retry, did nothing. | Nothing more. |
| `[slack] Restart for persona=<key> goes no further <where> — the persona is held on ErrInvalidFlags; nothing more is called for it, nothing recorded (b.jg5 SRJ-207)` | A restart already running found the persona held (`<where>`: `after its liveness probe`, `after its escalate-dead reconnect`, `after its re-probe` or `before its kill`) and stopped there. | Nothing more. |
| `[slack] Session relaunch for persona=<key> ended held on ErrInvalidFlags — not counted; nothing more is done for it (b.jg5 SRJ-207)` | A restart's relaunch met the answer and the persona was held at it. Nothing counts toward the restart limit. | As for the notice. |
| `[slack] unavailable-retry: persona=<key> stopped[ (pending-only)] — the persona is held on ErrInvalidFlags` | The persona's automatic retries stopped because it is held. | Nothing more. |
| `[slack] invalid-flags-hold: persona=<key> hold ended — agent-director version <old> changed to <new> (b.jg5 SRJ-207)` | A version check found a binary of another version, and the hold ended, with no post. | Nothing; the lines below show its retry. |
| `[slack] invalid-flags-hold: persona=<key> retried at once after its hold ended (b.jg5 SRJ-207)`, then `[slack] invalid-flags-hold: persona=<key> retry after its hold ended answered <outcome> (b.jg5 SRJ-207)` | The persona was retried right after its hold ended. `<outcome>` is what the retry did (for example `launched`, or `held` when the new binary rejects its launch too and the persona is held again, with one new notice). | Nothing, unless it is held again: then as for the notice. |
| `[slack] invalid-flags-hold: persona=<key> not retried after its hold ended — it is not in the applied configuration (b.jg5 SRJ-207)` | The hold ended for a persona that is no longer configured, so nothing is retried. | Nothing. |
| `[slack] invalid-flags-hold: persona=<key> hold forgotten — it began under agent-director version <version>; nothing is posted or retried (b.jg5 SRJ-207)` | The persona was removed or destructively changed, or the server is stopping, so its hold ended with no post and no retry. | Nothing. |
| `[slack] spawnForPersona: not launching "<name>" (key=<key>) — it is held on ErrInvalidFlags; no agent-director call (held; b.jg5 SRJ-207) (the held query failed: <error> — taken as held)`, the same ` (the held query failed: <error> — taken as held)` after `ErrInvalidFlags` in the restart lines, `[slack] unavailable-retry: persona=<key> the held query failed: <error> — taken as held; no agent-director call` | An internal error: the server could not tell whether the persona is held, so it treated it as held and launched nothing. | Report it as a bug, with the persona's lines. |
| `[slack] reuseSpawnForPersona: reuse spawn of … — holding the persona failed: <error>; answering held: …`, `[slack] invalid-flags-hold: persona=<key> <step> failed: <error>` (`<step>`: `set observer`, `end observer`, `retry timer stop`, `alert`, `ending its hold episode` or `its retry`), `[slack] invalid-flags-hold: ending the holds on a version change failed: <error>`, `[slack] persona teardown of "<name>" (key=<key>): forgetting its ErrInvalidFlags hold failed: <error>` | An internal error while holding the persona, posting its notice, ending its hold or retrying it: the hold may not be recorded, a retry may still run, the notice may be missing, or a hold may not have ended. | Report it as a bug, with the persona's lines. A server restart ends every hold. |

---

## A persona posts a Kill failed or Process outlived kill notice

Before the server relaunches a persona (a restart) or replaces its
agent-director row (a launch), it ends the persona's old worker through
agent-director and checks the result. A kill of a row the server last read
as running is tried up to 3 times, 2 s apart (see
[A kill that is tried again](#a-kill-that-is-tried-again)); a restart's
kill, made after the row read as ended, missing or gone, is made once. When
the tries are over, the server may post one of two notices to the persona's
destination:

- *Kill failed*: agent-director could not end the old worker after its
  tries (`ErrTmuxKillFailed` stood, or the tries failed in another way after
  agent-director had named a process that outlived an earlier try). The
  worker, or another process in its session, may still be running. The
  notice quotes agent-director's description (redacted, on one line, cut
  short), names a check and a next step for a human, warns that a
  `read-pane` answer may not prove the worker's state (the two caveats under
  [Listing instances](#listing-instances)), points to the "Operator
  actions" section of agent-director's README, and says its commands are
  for a human only.
  It also comes when the server replaces a persona's old instance that is
  still running (a launch that can't keep its row: `resume_enabled` is
  `false`, or the working directory or config directory changed; or a
  launch that found the persona's session gone while agent-director still
  read its row as running): its
  kills returned, but agent-director still listed the old instance's row as
  running after `find-missing` checks that judged it (the
  `live-row-sequence:` lines end `escalated: the row stayed live after
  runs that judged it; the kill-failure alert was raised`). That notice
  quotes no agent-director description: it has no "agent-director said"
  sentence. An old instance still starting, which agent-director did not
  judge, never leads to it: the server stops and retries the persona later
  (the `not judged` rows under [Other lines you may see](#other-lines-you-may-see)).
- *Process outlived kill*: agent-director ended the worker, but an earlier
  try had named a process of its session that outlived the kill. The
  notice names that process by pid, quotes agent-director's description,
  names no command and points to "Operator actions".

The end of the server's own stuck launch (see
[A persona posts a Launch stuck or Session not starting notice](#a-persona-posts-a-launch-stuck-or-session-not-starting-notice))
is one more such kill, tried up to 3 times, and its notices carry the
context `stuck-launch abort`, as does the relaunch's replacement of the
instance. After its *Kill failed*, nothing is relaunched and the stuck
launch later gets *Session not starting* once.

**What the server does.**

- After *Kill failed*, the worker's agent-director row is kept and nothing
  is launched over it. The persona's retries run on their own (see
  [agent-director refuses a persona](#agent-director-refuses-a-persona-it-is-retried-on-its-own)),
  nothing counts toward the restart limit, and no *Not answering* record
  starts for it. The notice ends `CSCB keeps retrying on its own and posts
  no second alert about this.` When the persona is held by then (a read
  between the tries held it, for example, or the last try met a tmux
  session conflict after an earlier try named a process that outlived the
  kill), it ends `This persona is held for a human (see its hold
  post); CSCB posts no second alert about this.` instead: the *Held:*
  notice goes to the same destination and nothing retries the persona.
- *Kill failed* is posted once per episode. The episode ends, with no
  post, when a read of the persona's row finds it `ended` or `missing`, or
  finds no row (so a persona that came back, its old row read as finished
  or gone, no longer reports `kill failed`); a later kill that succeeds while the row still reads running
  does not end it. So a later replacement in the same episode posts
  nothing, even when its kills succeed while the row stays running. The persona's removal or destructive change by
  a confirmed change, or a server restart, ends it too. While it lasts, a message sent to the persona is lost and its
  *Message lost* notice reports `kill failed` (`held for a human` for a held
  persona), with no restart started.
- After *Process outlived kill*, the persona comes back as usual: the
  relaunch, or the replacement of its row, goes ahead. Nothing in
  the server checks that process again. The notice is posted once for each
  such kill, holds nothing and starts no episode, so a message lost
  afterwards never reports `kill failed`. It ends `CSCB takes no further
  action on this process and posts no second alert about it.`
- A kill whose tries stopped because the persona was removed or stopped
  being up, or because the server is stopping, posts nothing: nothing
  retries that kill. One `not raised` line records it (below); for a
  persona already removed from the applied configuration, its
  `persona-kill-failed` entry is written instead (**Where it goes**). When
  an earlier try had named a process that outlived the kill, nothing else
  reports that process, so the *Kill failed* text is also written to
  `server.log` and `startup-errors.log` as
  `[<time>] [persona-kill-failed] persona=<key> (recovery): <text>`, with
  the log-only last sentence (**Where it goes**); still nothing is posted
  and no episode starts.

**Where it goes.**

- A persona in the applied configuration: its destination, as above.
- A persona no longer in the applied configuration (removed while its old
  worker was being killed): nothing is posted. `startup-errors.log` gets
  `[<time>] [persona-kill-failed] persona=<key> (recovery): <text>` for
  *Kill failed*, or `[<time>] [persona-kill-survivor] persona=<key>
  (recovery): <text>` for *Process outlived kill*, and `server.log` the
  same line. The text's last sentence is `CSCB retries this kill only while
  a persona waits on this worker (its own persona's next launch, or a
  persona in its working directory); until one does, nothing retries it.`
  or `CSCB does not retry this kill or check this process again.`
- The clean-up of old instances at a server start: nothing is posted, for
  any persona. A kill that did not succeed and whose tries call for *Kill
  failed* carries its text in its `orphan-cleanup` entry, after `;
  kill-failure alert: instanceId=<id> (start sweep): `. After a kill that
  succeeded once an earlier try named a surviving process, a
  `persona-kill-survivor` entry, `instanceId=<id> (start sweep): <text>`,
  names the instance. The row is kept either way: the start's clean-up
  never deletes a row.
- The kill of a confirmed change's teardown (a removed persona, or the old
  half of a destructive change), and any kill failure raised for the
  persona while that teardown runs: nothing is posted, at the old
  destination or the new half's, whether or not the persona is still in the
  configuration. `startup-errors.log` gets
  `[<time>] [persona-teardown-notice] persona "<name>" (key=<key>), raised during its teardown: <text>`
  for *Kill failed*, or the same with `[persona-kill-survivor]` for
  *Process outlived kill*, and `server.log` the same line, with the same
  last sentences as above. Nothing is held. The persona's row is kept either
  way (see
  [A notice raised during a teardown](#a-notice-raised-during-a-teardown)).
- The server's kill of an old instance it is ending in a persona's working
  directory (a removed, renamed or destructively changed persona's earlier
  instance, or one a start could not end): nothing is posted, for any
  persona. `startup-errors.log` gets
  `[<time>] [persona-kill-failed] <ref> (old-life wait): <text>` for *Kill
  failed*, or the same with `[persona-kill-survivor]` for *Process outlived
  kill*, `<ref>` being `persona=<old key>` or `instanceId=<id>`, and
  `server.log` the same line, with the log-only last sentences above. See
  [An old instance the server is ending](#an-old-instance-the-server-is-ending).
- The force-kill of `stop --stop-bots` or `clean_restart`: nothing is
  posted. The command prints the text, appends it to `server.log` and
  records it in `startup-errors.log`, led by
  `persona "<name>" (key=<key>) (CLI teardown, <command>): `. A *Kill
  failed* text follows the persona's `could not stop persona` line, and the
  two make one `persona-kill-failed` entry; it ends `The CLI does not retry
  this kill: once the worker is ended, run the command again.` A *Process
  outlived kill* text is one `persona-kill-survivor` entry, the persona
  counts as stopped, and it ends `This persona's teardown has finished;
  nothing in CSCB checks this process again.` (see
  [`stop --stop-bots` or `clean_restart` could not stop a persona](#stop---stop-bots-or-clean_restart-could-not-stop-a-persona)).
- A kill whose tries were stopped (the persona was removed, torn down or
  stopped being up, the server is stopping, or the check of agent-director's
  version stops the server) raises neither notice, during a teardown too:
  one `not raised` line (below), and, for a persona removed during the
  tries, a `persona-kill-failed` entry carrying that line, with no notice
  text.

| Class | Cause | Fix |
|---|---|---|
| `persona-kill-failed` | A *Kill failed* notice for a persona no longer in the applied configuration, or for an old instance the server is ending (`(old-life wait)`); a `could not stop persona` line of `stop --stop-bots` or `clean_restart` followed by the *Kill failed* text (context `CLI teardown, <command>`); or, with no notice text, the `not raised` line of a kill whose tries were stopped for a persona removed during them, or of an old instance's kill stopped when the server stopped. | A human checks the worker the entry names, following the "Operator actions" section of agent-director's README. Nothing needs doing for the removed persona itself. |
| `persona-teardown-notice` | A notice raised for a persona while a confirmed change tore it down (a removed persona, or the old half of a destructive change), whether or not the persona is still in the configuration: here, a *Kill failed* notice. The row is kept. An entry worded `raised during its old-life wait` is a session conflict or an unusable session name met while the server ended an old instance (see [An old instance the server is ending](#an-old-instance-the-server-is-ending)). | As for `persona-kill-failed`; see [A notice raised during a teardown](#a-notice-raised-during-a-teardown). |
| `persona-kill-survivor` | A *Process outlived kill* notice with no Slack destination: a persona no longer in the applied configuration, a persona being torn down by a confirmed change, the clean-up's kill at a start, an old instance the server is ending, or the force-kill of `stop --stop-bots` or `clean_restart` (context `CLI teardown, <command>`; the persona counts as stopped). | A human deals with the process the entry names by pid, following "Operator actions". |
| `orphan-cleanup` carrying `; kill-failure alert:` | A start's clean-up could not end an old instance after its tries. Its row is kept. | As for `persona-kill-failed`. The next start's clean-up tries the kill again. |

**The fix is a human's.** For *Kill failed*, a human takes the next step
the notice names, a `read-pane` check and then `agent-director kill`, whose
result the human checks; on an error, nothing is deleted or respawned. For
anything beyond that kill, and for the process a *Process outlived kill*
notice names, a human follows the "Operator actions" section of
agent-director's README. This skill takes none of these steps; no bot acts
on either notice, including a persona that sees the post. Never run a
command the notice names and never end or signal a process it names by pid.

**Read-only checks only.** Read the persona's row:

```sh
agent-director get --claude-instance-id cscb_<key>
```

To see whether a session of the persona is there, use the one-line
`read-pane` check under [Listing instances](#listing-instances), with its
caveats: `ErrTmuxCaptureFailed` does not prove the worker gone after a kill
failure whose description says no session or pane of this launch was
found, and a pane can be a leftover's.

All of one persona's kill and notice lines (replace `ops_bot` with the key):

```sh
grep -h -E 'persona-episodes: persona=ops_bot kill-failure |(kill try [0-9]+( of [0-9]+)?|kill tries) for cscb_ops_bot|kill for (persona=ops_bot|"[^"]*" \(key=ops_bot\)): (the kill-failure alert|raising the kill-failure alert)|kill-failure episode end for persona=ops_bot ' "$STATE"/server.log.* "$STATE"/server.log 2>/dev/null | sort
```

All of one persona's replacement steps (replace `ops_bot` with the key):

```sh
grep -h -E 'live-row-sequence: .*(persona=ops_bot\b|\(key=ops_bot\)|cscb_ops_bot\b)' "$STATE"/server.log.* "$STATE"/server.log 2>/dev/null | sort
```

| Line | Meaning | What to do |
|---|---|---|
| `[slack] persona-episodes: persona=<key> kill-failure ordinary alert posted to its destination (<context>; <closing>)` | The *Kill failed* notice was posted. `<context>` is `recovery` (a restart's kill, or a kill while the server replaces the persona's old instance) or `stuck-launch abort` (the end of the server's own stuck launch, or its relaunch's replacement of the instance). `<closing>` is `destination`, or `destination-latched` when the persona was held and the notice ends with the held sentence. | As for the notice. |
| `[slack] persona-episodes: persona=<key> kill-failure ordinary alert not posted — its episode's alert already posted` | Another kill failed in the same episode: nothing new is posted. | Nothing more: the first notice stands. |
| `[slack] persona-episodes: persona=<key> kill-failure survivor alert posted to its destination (<context>)` | The *Process outlived kill* notice was posted; the relaunch or the launch goes on. | As for the notice. |
| `[slack] persona-episodes: persona=<key> kill-failure <version> alert written to the server log and startup-errors.log (<class>) — <route>` | The notice went to `server.log` and a `<class>` entry instead of Slack. `<route>` says why: `not-configured` when the persona is no longer in the applied configuration, or for an old instance the server is ending (`<key>` its old key or instance id; `<class>` `persona-kill-failed` for `ordinary`, `persona-kill-survivor` for `survivor`), or `persona-teardown` for the kill of a confirmed change's teardown with no teardown window open (`<class>` `persona-teardown-notice` for `ordinary`, `persona-kill-survivor` for `survivor`). | See the class table above. |
| `[slack] persona-episodes: persona=<key> kill-failure <version> alert written to the server log and startup-errors.log (<class>) — persona-teardown, raised during its teardown (<context>)` | The notice was raised while a confirmed change tore the persona down, whether or not it is still in the configuration: written to `server.log` and a `persona-teardown-notice` (`ordinary`) or `persona-kill-survivor` (`survivor`) entry, posted nowhere. `<context>` is `persona teardown` for the teardown's own kill. | See [A notice raised during a teardown](#a-notice-raised-during-a-teardown). |
| `[slack] persona-episodes: persona=<key> kill-failure ordinary alert not posted to its destination — muted, its persona teardown was submitted; it counts as posted in its episode (<context>; <closing>)`, `… survivor alert not posted to its destination — muted, its persona teardown was submitted (<context>)` | The notice came after a confirmed change queued the persona's teardown and before it started, so it was not posted. | As for the notice; check the worker the line's descriptions name. |
| `[slack] persona-episodes: persona=<key> kill-failure ordinary alert not raised — its tries were stopped (<cause>)[; its last outcome's class: <class>], so nothing retries this kill; <descriptions> (<context>)` | A kill that agent-director could not carry out, or whose tmux did not answer, stopped its tries. For a persona still configured this line is the whole record; for one removed during the tries a `persona-kill-failed` entry carries it too, with no notice text. `<cause>` says why: `its keep-going check answered false: the server is shutting down`, `its keep-going check answered false: the persona is torn down or not up` (or both, `… the persona is torn down or not up, or the server is shutting down`, when the server could not tell which), `its live-row sequence was stopped: ` followed by `the persona's teardown began`, `the server is shutting down`, `the persona is not up` or `the persona latched` (the server was replacing the persona's old instance), `its old-life wait was stopped: the server is shutting down` (the server was ending an old instance; its `persona-kill-failed` entry follows), or `the last outcome's version re-check stops the server`. It is no notice, during a teardown too: nothing is posted, no episode starts and no `persona-teardown-notice` entry is written. `<descriptions>` quotes agent-director's answers, redacted (`last="…"`, `earlier survivor-naming="…"`). | Nothing for the persona. If the worker, or a process the descriptions name, may still run, a human checks it as for the notice. |
| `[slack] persona-episodes: persona=<key> kill-failure stopped retry's log line (no alert text) written to the server log and startup-errors.log (persona-kill-failed) — stopped` | Follows the `not raised` line for a persona removed during the tries: the same line went to a `persona-kill-failed` entry, with no notice text. | As for the `not raised` line. |
| `[slack] persona-episodes: persona=<key> kill-failure ended — <reason>` | The episode ended with no post. `<reason>`: `its own row read ended or missing` or `its own row is gone (ErrSpawnNotFound)`. A later failed kill can post *Kill failed* again. | Nothing. |
| `[slack] persona-episodes: persona=<key> kill-failure configured-key lookup failed: <error> — the alert takes the log-only route` | An internal error while checking whether the persona is still configured: the notice went to the log and `startup-errors.log` instead of Slack. | Report it as a bug, with the persona's lines. |
| `[slack] persona-episodes: persona=<key> kill-failure <version> alert not posted — the episodes are closed` | The server is stopping, so nothing is posted. | Nothing. |
| `[slack] persona-episodes: persona=<key> kill-failure <version> alert not routed — no log-only route is installed`, `… <version> log-only alert failed: <error>`, `… raise failed: <error>`, `[slack] <site>: kill for <ref>: raising the kill-failure alert failed: <error>`, `[slack] kill-failure episode end for persona=<key> failed: <error>`, `[slack] reconcileOrphans: building the kill-failure alert for instanceId=<id> failed: <error>` | An internal error: the notice or entry may be missing, or the episode may not have ended. | Report it as a bug, with the persona's lines. |
| `[slack] <site>: kill for <ref>: the kill-failure alert's <version> version is not raised — no kill-failure alerts are installed; <descriptions> (b.jg5 SRJ-704)`, `[slack] <site>: kill for <ref>: the kill-failure alert is not raised — its tries were stopped (<cause>); its last outcome's class: <class>; no kill-failure alerts are installed; <descriptions> (b.jg5 SRJ-702, SRJ-704)` | Seen only in tests and development runs, where the server's notice wiring is not set up. The second form is a kill whose tries were stopped early. | Nothing. |

---

## A persona was added or removed by a confirmed change

A confirmed change applies additions and removals on the running server, with
no restart. A rename is both: the old key is removed and the new key is added.
The new key, and any persona added in a removed persona's working
directory, is brought up only once the old instance there has ended: while
the old row is still running it waits (see
[A persona waiting on an old instance](#a-persona-waiting-on-an-old-instance)).
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
bring-up of the change has settled, which can take minutes: up to 10 when a
leftover instance of the persona is still `working` (about 1 when its screen
and transcript show it idle; see
[A persona's instance runs but isn't connected](#a-personas-instance-runs-but-isnt-connected)).
It doesn't wait for the server's answers to a new instance's startup
prompts: those run on their own after the launch, for at most the later of
5 minutes and agent-director's `pending_grace_seconds` plus 60 s from the
launch's start (see
[agent-director's timing settings](#agent-directors-timing-settings)).
A teardown also waits for any restart already under way for its persona, but
not for a launch waiting on a `working` row: it cancels that wait, and nothing
is typed. Meanwhile `config.json.pending` isn't refreshed and
no other confirmation is picked up. Stopping the server doesn't wait for it.

**Removed persona.** It is torn down at once, with no graceful wind-down.
When the change is applied, its key is recorded as retired and the server
stops answering its instance's startup prompts at once. The teardown then
stops everything else the server runs for it first (its retries, its
replacement of an old instance, its hold and its notices), closes its Slack
connection, drops its MCP session and its reply-guard record, and ends its
instance `cscb_<key>` with the result checked: a kill agent-director can't
carry out right now is tried up to 3 times, 2 s apart. Its agent-director
row is kept until agent-director's `expire` removes it, whatever the kill's
result: the persona is retired, and the row is its old conversation, which
is never resumed. Its permission prompts stay
in Slack as posted; clicking one does nothing, because clicks arrive only on
the persona's own Slack connection, which the removal closed. A held
persona's hold ends with it, silently. Nothing about the teardown is posted to Slack: every notice raised for the persona while it runs goes to `startup-errors.log` and `server.log` (see [A notice raised during a teardown](#a-notice-raised-during-a-teardown)). To bring the persona back, add it to
`config.json` again and confirm: it starts a new conversation on the same
instance, even with a server restart in between, and never resumes the old
one. A persona renamed and then renamed back does the same. See
[Added again or renamed back](#added-again-or-renamed-back) for its lines.

| Line | Meaning |
|---|---|
| `[slack] persona teardown of "<name>" (key=<key>): starting`, later `…: complete` | The teardown ran. Normal. |
| `[slack] persona teardown of "<name>" (key=<key>): complete, with <n> failed step(s)` | Some steps failed; each has its own line (below). |
| `[slack] approvePreSessionDialogs: stopping the approver for "<name>" (key=<key>) (retired-key): its key was recorded as retired; it makes no further call (b.jg5 SRJ-401, SRJ-404)` | The change recorded the persona's key as retired while its instance was still starting, so the server stopped answering its startup prompts before the teardown began. Normal. |
| `[slack] approvePreSessionDialogs: stopping the approver for "<name>" (key=<key>) (teardown): its teardown began; it makes no further call (b.jg5 SRJ-401, SRJ-404)` | The same, stopped by the teardown itself. Normal. |
| `[slack] old-life hold: began on "<real path>" for oldKey=<key> (instanceId="cscb_<key>"): apply step 1 recorded its key as retired — the old life may still be running (b.jg5 SRJ-809)` | When the change was applied, before the teardown, the server began tracking the persona's old instance in its working directory (`<real path>`): it may still be running until agent-director reads its row finished. A destructively modified persona gets one too, at its old working directory. `began again on …: … — one hold is kept, on its held directory` means it was already tracked: the server keeps tracking it in the directory it already had (the one the line names), because the old row's real directory wins over the persona's declared one. Normal. |
| `[slack] old-life hold: ended on "<real path>" for oldKey=<key> (instanceId="cscb_<key>"): <reason>[ (<read>)]; waiting personas: <keys\|none> (b.jg5 SRJ-809)` | The server stopped tracking the old instance: `<reason>` is `the old row read ended` or `the old row read missing, or no row` (a read of its row, which `<read>` names, for example `persona teardown kill: status read between tries`), `a find-missing run listed the old row in its ids`, or `a reuse for the key began its new life` (the persona's new conversation started). A kill alone never ends it, whatever it answered: after a kill that succeeded this line comes with the next read of the row, which may be at a later launch. A restart drops every tracked instance with no end line; the next start tracks the instance again only if it is still running. Normal. |
| `[slack] live-row-sequence: <ref>: stop asked — the persona's teardown began; no further call (b.jg5 SRJ-706)` | The server was replacing the persona's old instance; the teardown stopped that first. Normal. |
| `[slack] persona teardown kill for persona=<key>: kill try <n> of <max> for cscb_<key>: <outcome> — <what follows> (b.jg5 SRJ-702)`, `…: status read before kill try <n> for cscb_<key>: <state> — <what it decides> (b.jg5 SRJ-702)`, `…: kill tries for cscb_<key> ended (<end>) after <n> kill(s) and <m> read(s): <outcome> — alert=<none\|survivor\|ordinary> (b.jg5 SRJ-702)` | The teardown's kill, one line per try and per read of the row between tries. More than one try means agent-director couldn't carry out the kill at once; a read of `ended` or `missing` between tries ends them as a success. `(names a surviving pid)` after an outcome means a process outlived the kill (see `alert=` and the *Process outlived kill* entry under [A persona posts a Kill failed or Process outlived kill notice](#a-persona-posts-a-kill-failed-or-process-outlived-kill-notice)). |
| `[slack] persona teardown of "<name>" (key=<key>): agent-director kill of cscb_<key>: <outcome> after <n> kill(s); the row is kept (b.jg5 SRJ-715)` | The teardown stopped the instance: `<outcome>` is `outcome=killed kill_sent=<true\|false\|absent>`, `outcome=row-gone (ErrSpawnNotFound)`, `outcome=session-gone (<error name>)` or the finished row a read between tries found. `kill_sent=false` means agent-director found no session of the current launch and the worker gone or not recorded; it is no fault. The row is kept; nothing deletes it. |
| `[slack] persona teardown of "<name>" (key=<key>): agent-director kill of cscb_<key> failed: <outcome> after <n> kill(s) — the row is kept; nothing latches and no retry timer is armed (b.jg5 SRJ-715, SRJ-110)` | agent-director couldn't stop the instance (`outcome=not-killed class=<class> …`; often because it was unreachable), so its session may still be running. The row is kept, nothing is held, no retry timer is armed, and the other steps still ran. The row is still there (see [Listing instances](#listing-instances)); for a removed persona, the next server start's clean-up kills it again with the result checked and keeps the row until agent-director's `expire` removes it. For a destructively modified persona, its bring-up never launches over the old session: it ends it first and starts the new conversation on the same instance only once that succeeds; the old conversation is never resumed. For a renamed persona's new name, and any persona in the old working directory, the launch waits until the old instance has ended (see [A persona waiting on an old instance](#a-persona-waiting-on-an-old-instance)). When the tries call for it, a *Kill failed* entry follows (the `[persona-teardown-notice]` row below); when no other entry records the failure, an `agent-director kill of cscb_<key> did not succeed after <n> kill(s); the row is kept: …` entry follows instead, so every failed kill has an entry. |
| `[slack] persona teardown of "<name>" (key=<key>): agent-director kill of cscb_<key> failed: it answered no kill outcome — the row is kept (b.jg5 SRJ-715)` | An internal error in the teardown's kill; the row is kept and the other steps still ran. Report it as a bug. |
| `[slack] persona teardown of "<name>" (key=<key>): agent-director kill of cscb_<key>: it answered a malformed kill-failure alert decision — no kill-failure alert is raised (b.jg5 SRJ-704)` | An internal error in the teardown's kill: its tries answered an alert decision the teardown could not read, so no *Kill failed* or *Process outlived kill* entry is written for it. The kill's own line, which follows it, still says how it went; the row is kept and the other steps still ran. Report it as a bug; if that line says the kill failed, a human checks the worker as for the notice. |
| `[<time>] [persona-teardown-notice] persona "<name>" (key=<key>), raised during its teardown: <text>` (or `[persona-kill-survivor]`), in `startup-errors.log` and `server.log` | A notice raised during the teardown, written instead of posted: for example agent-director could not end the instance after its tries (*Kill failed*), or ended it while a process outlived the kill (*Process outlived kill*), or its kill met a session conflict or an unusable tmux session name (`agent-director kill of cscb_<key> refused at a try: …`; nothing is held), or its kill did not succeed and nothing else recorded it (`agent-director kill of cscb_<key> did not succeed after <n> kill(s); the row is kept: …`). Nothing is posted to Slack. See [A notice raised during a teardown](#a-notice-raised-during-a-teardown). |
| `[slack] persona-notifier: notice for "<name>" (key=<key>) raised during its teardown — written to the server log and startup-errors.log (<class>), not posted: <first line>` | Follows that entry's line. See [A notice raised during a teardown](#a-notice-raised-during-a-teardown) for this line and the teardown's other notice lines. |
| `[slack] persona teardown of "<name>" (key=<key>): forgetting its latch failed: <error>` | An internal error ending the persona's hold (see [A persona posts a Held: tmux session conflict notice](#a-persona-posts-a-held-tmux-session-conflict-notice)). The other steps still ran, but the key may still be held: a destructively modified persona, or a persona added again with the same key, is then not launched (`spawnForPersona: not launching … — it is latched`) until the server next starts. Report it as a bug, with the persona's lines. |
| `[slack] persona teardown of "<name>" (key=<key>): forgetting its ErrInvalidFlags hold failed: <error>` | An internal error ending the persona's *Cannot launch* hold (see [A persona posts a Cannot launch notice](#a-persona-posts-a-cannot-launch-notice)). The other steps still ran, but the key may still be held; a server restart ends every hold. Report it as a bug. |
| `[slack] invalid-flags-hold: persona=<key> hold forgotten — it began under agent-director version <version>; nothing is posted or retried (b.jg5 SRJ-207)` | The persona was held because agent-director rejected its launch; its hold ended with it, with no post and no retry. |
| `[slack] persona teardown of "<name>" (key=<key>): <step> failed: <error>`, any other step | An internal error. The other steps still ran. Report it as a bug. |
| `[slack] dry-run: persona teardown of "<name>" (key=<key>): skipping the agent-director kill of cscb_<key>; the row is kept` | Dry run: the instance and its row are left alone; every other step ran. |
| `[slack] Cancelled restart timer for persona=<key>` | A restart that was pending for it was cancelled. |
| `[slack] unavailable-retry: persona=<key> stopped[ (pending-only)] — the persona was torn down` | Its retries after an agent-director refusal were stopped. |
| `[slack] persona teardown of "<name>" (key=<key>): stopping its UNAVAILABLE retry timer before its turn failed: <error>` | An internal error in that stop, for a destructively modified persona; the teardown still runs. Report it as a bug. |
| `[slack] waitForWaitingAndReconnect: persona=<key> — cancelling its launch's wait for its working row (b.f2b)` | Its launch was waiting for a `working` row. The wait is cancelled, so the teardown doesn't wait up to 10 minutes for it. |
| `[slack] waitForWaitingAndReconnect: persona=<key> — its launch in flight will not wait for a working row: any such wait is cancelled at once (b.f2b)` | Its launch was running but not waiting yet; a wait it starts ends at once. |
| `[slack] waitForWaitingAndReconnect: the wait for "<name>" (key=<key>) was cancelled (its persona is being torn down) — nothing typed (b.f2b)` | The cancelled wait ended with nothing typed; the teardown goes on. |
| `[slack] persona teardown of "<name>" (key=<key>): cancelling its launch's wait for a working row before its turn failed: <error>` | An internal error in that cancel; the teardown still runs. Report it as a bug. |
| `[slack] permission-poller: persona=<key>: dropped <n> tracked prompt(s); their Slack messages stay as posted` | Its open prompts are no longer tracked. Their messages stay in Slack, and clicking them does nothing. |
| `[slack] persona-notifier: persona=<key>: dropped <n> held notice(s), not posted — the persona was torn down` | Notices that were waiting for its Slack client before the teardown started are dropped. A notice raised during the teardown is never dropped: it is written (above). |
| `[slack] persona-destination-hold: hold cancelled — <n> held notice(s) for "<name>" (key=<key>) dropped, not posted` | Notices that were waiting for its failing destination are dropped, as soon as the teardown starts, so none of them reaches Slack while it runs (for a changed persona, not the new destination either). |

**Destructively modified persona.** A kept persona whose `credentials_file`
path or `working_directory` changed gets both: the removed persona's teardown
lines, then the added persona's bring-up lines (`persona-start`, then
`up at apply — launching` or a class line). Its teardown keeps the old row,
and its bring-up starts a new conversation on the same instance `cscb_<key>`
over it; when the old session is still running (its kill did not succeed),
the bring-up ends it first and never launches over it or resumes it. Any
other persona in its old working directory waits until then, and a Claude
session from that directory is refused (see
[A persona waiting on an old instance](#a-persona-waiting-on-an-old-instance)). It
comes up fresh, with no
conversation history, even with a server restart in between (its lines are
under [Added again or renamed back](#added-again-or-renamed-back)), and unheld: a hold it had ends with its teardown, and it
is held again, with one new notice, only if it meets a conflict again: at its
launch, or when the server later reads conflicting labels on its own row.
A restart or retry that was pending for it is cancelled
when its teardown is queued, so the old entry is never relaunched in between.
No notice raised during its teardown reaches the new half's destination (see
[A notice raised during a teardown](#a-notice-raised-during-a-teardown)).
`[slack] persona teardown of "<name>" (key=<key>): <step> before its turn failed: <error>`
is an internal error in that cancel; the teardown still runs. Report it as a
bug.

**Stored channel choices.** Once the change's last-applied record is
written, the stored channel deliveries of every key it retires (a removed
persona's, a renamed persona's old key, and a destructively modified
persona's) are dropped from `channel-delivery.json`, in either mode, with a
`[slack] channel-delivery: dropped the stored choices of persona=<key> in <n> channels: retired by a confirmed change (b.deo SRI-405, SRI-905)`
line (see
[The store's `[slack] channel-delivery:` lines](#the-stores-slack-channel-delivery-lines)).
They never apply again. A persona brought up under that key, a
destructively modified persona's new half included, is at `mentions` in
every channel in fungible mode until its agent sets a channel again with
`set_channel_delivery`. From the change's apply until its teardowns have
settled, a destructively modified persona's `set_channel_delivery` calls are
refused as for a key that isn't applied (see
[`persona-channel-delivery-set`](#persona-channel-delivery-set)).

**Either.** `[slack] reload: apply step <n> (<step>) failed for persona "<name>" (key=<key>): <error>`
is an internal error in that persona's teardown or bring-up; the other
personas were still handled. Report it as a bug, with the persona's lines.

### A notice raised during a teardown

From the start of a removed or destructively modified persona's teardown
until it completes, nothing about the persona is posted to Slack, at its old
destination or at the new half's. Every notice raised for it in that time is
written to `startup-errors.log` and `server.log` instead, and none is
dropped:

```
[<time>] [persona-teardown-notice] persona "<name>" (key=<key>), raised during its teardown: <the notice's text>
```

followed in `server.log` by
`[slack] persona-notifier: notice for "<name>" (key=<key>) raised during its teardown — written to the server log and startup-errors.log (persona-teardown-notice), not posted: <first line>`.
A *Process outlived kill* notice raised then has the same form with the
class `persona-kill-survivor`. `<the notice's text>` is the notice as it
would have been posted, but with Slack's escapes undone (`&`, `<` and `>`
appear as themselves, not as `&amp;`, `&lt;` and `&gt;`), in the entry and
the line alike. A *Kill failed* or *Process outlived kill* notice of a kill
other than the teardown's own (a launch still running) starts with its
context in parentheses, for example `(recovery) `.

**The fix is the inner notice's own.** The entry only says where the notice
went; read `<the notice's text>` and follow that notice's own section:

| Inner notice | Where to look |
|---|---|
| *Kill failed* or *Process outlived kill* (the teardown's kill, or a kill of a launch still running) | [A persona posts a Kill failed or Process outlived kill notice](#a-persona-posts-a-kill-failed-or-process-outlived-kill-notice) |
| `agent-director kill of cscb_<key> refused at a try: outcome=not-killed class=CONFLICT …` (or `class=UNUSABLE_NAME`, or `refused at a status read between its tries`) | The teardown's kill met a session conflict or an unusable tmux session name. Nothing is held for it. The "What to do" of [A persona posts a Held: tmux session conflict notice](#a-persona-posts-a-held-tmux-session-conflict-notice) or [A persona posts a Held: unusable tmux session name notice](#a-persona-posts-a-held-unusable-tmux-session-name-notice) applies to the session or row it names. |
| `agent-director kill of cscb_<key> did not succeed after <n> kill(s); the row is kept: outcome=not-killed class=<class> …` | The teardown's kill did not succeed, and no other entry (*Kill failed*, a `refused at a try` entry, or an outage notice) records it: for example agent-director answered an error the server can't classify, or a removed persona's kill met an ENVIRONMENT or CONFIG answer. The row is kept and the session may still run. Read the row (see [Listing instances](#listing-instances)); for a removed persona the next start's clean-up kills it again, with the result checked, and keeps the row; and a destructively modified persona's bring-up ends the old session before it launches. For `class=ENVIRONMENT`, `class=CONFIG` or `class=UNCLASSIFIED`, see [agent-director refuses a persona](#agent-director-refuses-a-persona-it-is-retried-on-its-own). |
| *tmux unavailable*, *tmux server changed*, *agent-director refuses its config file*, and that outage's *All clear.* | [agent-director refuses a persona](#agent-director-refuses-a-persona-it-is-retried-on-its-own) |
| *Unclassified agent-director error* | **agent-director returns an error the server can't classify** in [agent-director refuses a persona](#agent-director-refuses-a-persona-it-is-retried-on-its-own) |
| A *Held:* or *Cannot launch* notice from a launch still running | The *Held:* or *Cannot launch* section for that notice. The teardown already ended the hold. |
| A stuck permission prompt warning | The persona's session was blocked on a native permission prompt; its teardown ends that session. |

**An outage's all-clear.** An outage whose notice was written this way keeps
its state past the teardown, and its *All clear.*, whenever it comes, is
written the same way and never posted, the new half's destination included.
After the teardown has completed, the entry reads
`persona "<name>" (key=<key>), the all-clear of an outage raised during its teardown: <text>`
and the line
`[slack] persona-notifier: all-clear for "<name>" (key=<key>) of an outage raised during its teardown — written to the server log and startup-errors.log (persona-teardown-notice), not posted: <first line>`.
When one *All clear.* covers both such an outage and another one whose
notice was posted, it is split: the part for the outage written this way is
written as above, and an *All clear.* naming only the other outage is posted
to the destination as usual.

**Before the teardown starts.** Once the teardown is queued, none of the
persona's once-per-episode notices is posted: *Held: tmux session conflict*,
*Held: unusable tmux session name*, *Held: launch start not recorded*,
*Cannot launch*, *Slow recovery*, *Not answering*, *Still not answering*,
*Answering again*, *Unclassified agent-director error*, *Kill failed* and
*Process outlived kill*. Their lines say `not posted — muted, its persona
teardown was submitted`. *agent-director refuses its config file* is not
posted either: the line
`[slack] persona-notifier: onset for "<name>" (key=<key>) of ad-config-malformed not posted — muted, its persona teardown was submitted; its all-clear is written, never posted: <first line>`
says so, and its *All clear.* is later written as above, never posted.
Every other notice raised then is handled as usual (another outage's notice,
such as *tmux unavailable*, a stuck permission prompt warning, a
spawn-failure notice and a lost-message notice): a removed persona's is
dropped (`no applied persona with key=<key> — notice dropped`), and a
destructively modified persona's goes to its destination.

**A kill the teardown stopped is no notice.** A kill the server was trying
again for the persona when the teardown began (while replacing its old
instance, for example) stops its tries. It posts nothing and writes no
`persona-teardown-notice` entry: one
`kill-failure ordinary alert not raised — its tries were stopped (<cause>)`
line, its cause usually `its live-row sequence was stopped: the persona's
teardown began` or `its keep-going check answered false: the persona is torn
down or not up`, and
for a persona removed during the tries a `persona-kill-failed` entry carrying
that line (see
[A persona posts a Kill failed or Process outlived kill notice](#a-persona-posts-a-kill-failed-or-process-outlived-kill-notice)).

**Read-only checks.** One persona's teardown entries and lines (replace
`ops_bot` with the key):

```sh
grep -h -E '\[persona-(teardown-notice|kill-survivor)\] persona "[^"]*" \(key=ops_bot\)' "$STATE"/startup-errors.log
grep -h -E 'persona-notifier: (notice|all-clear|onset) for "[^"]*" \(key=ops_bot\)|persona teardown of "[^"]*" \(key=ops_bot\)|(persona-episodes|slow-recovery): persona=ops_bot .*(muted, its persona teardown|raised during its|its persona teardown was submitted)|stuck-prompt warning for "[^"]*" \(key=ops_bot\)' "$STATE"/server.log.* "$STATE"/server.log 2>/dev/null | sort
```

| Line | Meaning |
|---|---|
| `[slack] persona-notifier: notice for "<name>" (key=<key>) raised during its teardown — written to the server log and startup-errors.log (<class>), not posted: <first line>` | A notice raised during the teardown was written, not posted. Follow the inner notice (above). |
| `[slack] persona-notifier: all-clear for "<name>" (key=<key>) of an outage raised during its teardown — written to the server log and startup-errors.log (persona-teardown-notice), not posted: <first line>` | The outage that notice reported has cleared. Nothing to do. |
| `… not posted, and its startup-errors entry was not written: <reason>` at the end of either line | An internal error: the notice is in `server.log` only. Report it as a bug. |
| `[slack] persona-episodes: persona=<key> kill-failure <version> alert written to the server log and startup-errors.log (<class>) — persona-teardown, raised during its teardown (<context>)` | A *Kill failed* (`ordinary`) or *Process outlived kill* (`survivor`) notice raised during the teardown; `<context>` is `persona teardown` for the teardown's own kill, or `recovery` for a launch still running. |
| `[slack] persona-episodes: persona=<key> unclassified-error alert written to the server log and startup-errors.log (persona-teardown-notice) — raised during its persona teardown; …` | An *Unclassified agent-director error* notice raised during the teardown. |
| `[slack] permission-poller: stuck-prompt warning for "<name>" (key=<key>) (<id>) raised during its persona teardown — handed to the notifier, which writes it to the server log and startup-errors.log, not posted (b.jg5 SRJ-1003)` | A stuck permission prompt warning raised during the teardown. |
| `[slack] persona-episodes: persona=<key> <kind> notice not posted — its persona teardown was submitted (b.jg5 SRJ-1003)`, and a poster's `… not posted — muted, its persona teardown was submitted …` line | A notice between the teardown being queued and its start: not posted. Nothing to do. |
| `[slack] persona-notifier: onset for "<name>" (key=<key>) of ad-config-malformed not posted — muted, its persona teardown was submitted; its all-clear is written, never posted: <first line>` | *agent-director refuses its config file* between the teardown being queued and its start: not posted, and no entry. Its *All clear.* is written, never posted. If agent-director still refuses its config file afterwards, see [agent-director refuses a persona](#agent-director-refuses-a-persona-it-is-retried-on-its-own). |
| `[slack] persona teardown of "<name>" (key=<key>): raising the notice for the <CONFLICT\|UNUSABLE_NAME> its kill met failed: <error>`, `…: raising the notice for its kill's outcome failed: <error>`, `…: opening its notice window failed: <error>`, `…: closing its notice window failed: <error>`, `…: forgetting its outage state failed: <error>`, `…: registering its submit failed: <error>`, `…: ending its submit failed: <error>`, `…: no notifier route is installed for the notice: <text>` | An internal error: a notice may have been posted or lost. Report it as a bug, with the persona's lines. |

### Added again or renamed back

A confirmed change records the key of a removed persona (a renamed persona's
old key included) and of a destructively modified one as retired, in
`retired-keys.json` (see
[The retired-key record can't be read or is invalid](#the-retired-key-record-cant-be-read-or-is-invalid)).
While a key is recorded, every launch of a persona with that key, at an
apply, a start, a restart or a retry, starts a new conversation on the same
instance `cscb_<key>`: the old conversation is never resumed. An old session
still running is ended first, never reconnected. Once the new conversation
has begun, the server marks the key; once it then reads the new session
running, it removes the key's entry, and the persona is resumed as usual from
then on. Search `server.log` for `key is retired`.

The stored channel choices of a retired key don't come back with it. The
confirmed change that retired the key dropped them (see **Stored channel
choices** under
[A persona was added or removed by a confirmed change](#a-persona-was-added-or-removed-by-a-confirmed-change)),
so a persona added again or renamed back starts at `mentions` in every
channel in fungible mode. If that drop's write failed, the confirmed change
that adds the persona back writes the stored-choice file first, and applies
nothing if it can't (see
[`reload-record-write-failed`](#reload-record-write-failed)); a start drops
them too, while the key is absent or held as retired with no new life begun.

A server start records keys too: before its clean-up of old instances ends
any of them, it records as retired, in one write, the key of every
agent-director instance labelled with a persona that is not in the applied
configuration (for example, a start without `config.json.last-applied` whose
`config.json` no longer names the persona; see
[Starting without the record](#starting-without-the-record)). Adding that
persona back later starts it fresh, as above. Read-only checks: the record
itself, and the start's lines for it:

```sh
cat "$STATE/retired-keys.json"
grep -h -E 'retired-keys: (recorded|cannot record) .*cause=absent-at-start|reconcileOrphans: (no retired-key store is installed|recording the keys of absent personas)' "$STATE"/server.log.* "$STATE"/server.log 2>/dev/null | sort
```

| Line | Meaning |
|---|---|
| `[slack] spawnForPersona: "<name>" (key=<key>)'s key is retired (<mark words>) — its first launch is a reuse spawn of the same id, never a plain spawn or a resume (b.jg5 SRJ-805)` | The persona's key is retired, so its launch starts a new conversation on the same instance. `<mark words>` is `no new life has begun yet, so any row it has is the old life` or `its new life has begun`. Normal. |
| `[slack] spawnForPersona: the retired key's reuse spawn of "<name>" (key=<key>) collided — fetching current state; this is the one get-then-act a reuse collision gives (b.jg5 SRJ-805, SRJ-112)` | Its instance was still running, so nothing started; the server reads the instance next, once. An old life is then replaced (the `replacing the row of … (its key is retired …` line, under [Other lines you may see](#other-lines-you-may-see)); a new life is kept. Normal. If the new conversation it then tries collides too, the server tries no more in this attempt: nothing is counted and the persona's retry timer is armed with `collision`, so it is tried again later. |
| `[slack] spawnForPersona: "<name>" (key=<key>)'s key is retired (<mark words>; last read <state>) — not resuming: a reuse spawn of the same id first; nothing is deleted (b.jg5 SRJ-805)` | A path that would have resumed the persona starts a new conversation instead. Normal. |
| `[slack] reuseSpawnForPersona: "<name>" (key=<key>)'s key is retired and its new life has begun — answering fresh-retired; <mark> (b.jg5 SRJ-806, SRJ-112)` | The new conversation started; a start's summary counts it under `fresh as retired keys`, not under `fresh-spawned`. `<mark>` is `its mark is set in the retired-key record` or `its mark was already set, so nothing is written`; normal. `writing its mark failed, so this server holds the mark in memory and writes it again at the key's next launch decision` follows a `cannot mark` line (below). |
| `[slack] reuseSpawnForPersona: "<name>" (key=<key>)'s key was recorded as retired while this reuse spawn's launch attempt was in flight (<how>) — the launch was decided before that recording, so its life is the old life: no mark is set; answering spawned (b.jg5 SRJ-806, SRJ-805)` | A new conversation started, but the key was retired (again) after its launch attempt started, for example by a confirmed change applied at that moment. That conversation is the old life, so the key is not marked; the persona's next launch (for a confirmed change, its bring-up) replaces it and starts the real new conversation, with an `answering fresh-retired` line. `<how>` is `it was not recorded when the launch attempt started`, `recorded again while the launch attempt was in flight` or `its record generation could not be read, so a recording during the launch attempt cannot be ruled out` (the last follows a `record-generation query` line, below). Normal. |
| `[slack] spawnForPersona: "<name>" (key=<key>)'s key is retired, so its reuse spawn answered fresh-retired — answering it, not an amnesia result; the lost-transcript diagnosis's persona notice is not posted (b.jg5 SRJ-112, SRJ-806)` | The persona's resume found its transcript missing, but its key is retired, so the new conversation is its expected fresh start, not lost memory: no memory-loss notice is posted and the start summary does not count it as amnesia. Normal. |
| `[slack] retired-keys: persona=<key> marked: its new life has begun, in "<path>" (b.jg5 SRJ-806)` | The server recorded that the persona's new conversation has begun, so its running session is never taken for the old one. Normal. A `; it carries …` part before `(b.jg5` says the write also saved changes an earlier failed write held. |
| `[slack] retired-keys: cannot mark persona=<key> in "<path>"<detail>; this server holds its mark in memory, and its next launch decision writes it again (b.jg5 SRJ-806)` | The state directory couldn't be written (`<detail>` names the error). The running server still treats the new session as the new life. Fix the state directory (permissions, free space). If the server restarts before the mark is written, the persona's running session is taken for the old one and is replaced by another new conversation. |
| `[slack] retired-keys: writing the held mark of persona=<key> again failed: <error>; this server still reads it as marked (b.jg5 SRJ-806)` | An internal error writing that mark again. Report it as a bug, with the persona's lines. |
| `[slack] retired-keys: persona=<key> entry cleared from "<path>" on its row read <state> with its mark set (<site>: <what>) (b.jg5 SRJ-807)` | The server read the persona's new session running, so the key is no longer retired. `<site>: <what>` names the read, such as `persona teardown kill: status read between tries` for a teardown's read of the row between its kill tries, `reconcileOrphans: status read between kill tries` for a start's read of a stale instance's row between its kill tries, or `reconcileOrphans: start sweep list` for a start's listing. Normal. |
| `[slack] retired-keys: recorded persona=<key> (cause=absent-at-start), … in "<path>" (b.jg5 SRJ-803)` | A server start recorded these keys as retired: each names a persona not in the applied configuration whose instance the start listed. A key already recorded with its new life begun shows `, its "new life has begun" mark cleared` inside its parentheses; one already recorded with no mark is left as it is and not named. Normal. |
| `[slack] retired-keys: cannot record persona=<key> (cause=absent-at-start), … in "<path>"<detail>; this server holds persona=<key>, … as retired in memory for its life, and the next write of the record that succeeds carries them (b.jg5 SRJ-803, SRJ-714)` | The state directory couldn't be written at a start (`<detail>` names the error). The start goes on. The running server still treats those keys as retired, so a persona added back with one starts fresh, and the confirmed change that adds it writes the record first. The next start records them again. Fix the state directory (permissions, free space). |
| `[slack] reconcileOrphans: no retired-key store is installed, so the keys of absent personas' rows are not recorded as retired: <keys> (b.jg5 SRJ-714, SRJ-803)`, `[slack] reconcileOrphans: recording the keys of absent personas' rows as retired failed: <error>; nothing is recorded (b.jg5 SRJ-714, SRJ-803)` | An internal error: a start recorded none of these keys, so a persona added back with one of them may resume its old conversation. Report it as a bug, with the start's lines. |
| `[slack] reconnectSession: persona=<key> is <state> and its key is retired with no new life begun — not typing /mcp reconnect into its old life; the live-row sequence replaces it (start answered <answer>); deferring (b.jg5 SRJ-805)` | The health check or a restart found the retired persona's old session still running. Nothing is typed into it; it is ended and a new conversation starts (the `live-row-sequence` lines under [Other lines you may see](#other-lines-you-may-see) follow). Normal. |
| `[slack] live-row-sequence: "<name>" (key=<key>): its key is retired, so the sequence carries the retired-key flag and ends in a reuse spawn, never a resume (b.jg5 SRJ-805, SRJ-705)` | Replacing the persona's old session ends in a new conversation, never the old one. Normal. |
| `[slack] retired-keys: the recorded query for persona=<key> failed: <error>; taken as not recorded (b.jg5 SRJ-805)`, `[slack] retired-keys: the mark query for persona=<key> failed: <error>; taken as not marked, so its row is the old life (b.jg5 SRJ-805, SRJ-806)`, `[slack] retired-keys: the record-generation query for persona=<key> failed: <error>; a recording during the launch attempt cannot be ruled out, so no mark is set (b.jg5 SRJ-806)` | An internal error reading the retired-key record. Report it as a bug, with the persona's lines. After the record-generation line the new conversation is not marked, so the persona's next launch replaces it with another new conversation. |

---

## A persona's routing settings were changed by a confirmed change

A confirmed change to a kept persona's routing settings applies in place on
the running server, with no restart. Which settings those are depends on the
mode the change's own `allow_invited_channels` picks:

- **Declarative mode:** `channels` (each entry's `delivery` included) and
  `permission_prompts`;
- **Fungible mode:** `invited.permission_prompts`, the fungible destination
  (an absent value and `"dm"` count as the same);
- **both modes:** `dm.enabled` and `dm.contact`.

A change to the other mode's section is recorded only and applies nothing
(the preview's `recorded, with no effect until …` line; see
[Pending changes](#pending-changes)). A change of `allow_invited_channels`
itself also applies in place, keeping every session (see
[Confirming a pending change](#confirming-a-pending-change)). The persona's instance, its
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
| `[slack] persona "<name>" (key=<key>): updated in place (<settings>); its instance, Slack connection and MCP session are kept` | The change was applied. `<settings>` lists what changed, such as `channels, dm.contact` in declarative mode or `invited.permission_prompts, dm.enabled` in fungible mode. Normal. The same line is logged for a persona that is `retrying` or `broken`, though it has no instance, connection or session yet; it serves with the new values once it comes up. |
| … the same line ending `; its cached DM conversation is forgotten` | The destination setting (`permission_prompts`, or `invited.permission_prompts` in fungible mode) or `dm.*` changed, so the next post to a DM destination opens the DM again. Normal. |
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
- **Same cause, prompts and notices:** a persona with a `"dm"` destination
  (its `permission_prompts` is `"dm"` in declarative mode; in fungible mode
  its `invited.permission_prompts` is `"dm"` or absent, `"dm"` being the
  default) opens its DM with `dm.contact` the same way, so its permission
  prompts, stuck-prompt warnings and server notices can't be posted either.
  They are held, not lost: `server.log` has one
  [`persona-destination-failed`](#persona-destination-failed) line naming
  `conversations.open`, `missing_scope` and `im:write`, and the server
  retries with backoff (up to 5 minutes apart), logging nothing per attempt.
- **Cause:** starting a DM with a user (a `reply` to a user ID, or a persona
  with a `"dm"` destination) needs the `im:write` bot scope. The
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

## agent-director refuses a persona: it is retried on its own

When agent-director refuses the calls that bring a persona back (it is
unreachable, or it answers that it can't act right now), the server doesn't
count that against the persona's restart limit and doesn't give up on it.
A refusal posts no `Spawn failure:` notice and writes no `spawn-failed`
entry to `startup-errors.log`. The launch or restart that met it stops
there, and nothing more is killed or launched in it.
Instead it retries the persona on its own: 30 s after the refusal, then after
60, 120 and 240 s more, then every 300 s, for as long as the refusal lasts.
It does this whatever `session_restart_delay` and `health_check_interval`
are, `0` included. Each retry reads the persona's state first, never starts a
second instance over one that is running, and reconnects or relaunches it as
the restart path would. Once agent-director answers again, the next retry
brings the persona back, so in the common case there is nothing to do.
A launch that timed out, or that agent-director refused as not answering or
not able to act right now, is followed by one read of the persona's row and
no further launch in that attempt (see
[A launch that timed out](#a-launch-that-timed-out)).
After any launch of the persona (a start, a restart, a confirmed change's
bring-up, a replacement or a retry's relaunch), after a launch that timed out
while its instance is still starting, and whenever the server finds
its instance still starting, the later retries read its state (the
lines say `pending-only`): they wait while its session is still starting,
never launch over it, never end it except for the one end of the server's
own stuck launch, stop once it has started, and hand the
persona back to one more recovery if the instance is gone. From
agent-director's grace period (`pending_grace_seconds`) past the launch's
start, each retry also checks the starting instance once with agent-director
(the `pending-row: … rule (retry)` lines), and the restart path's retries do
the same; see
[A persona posts a Launch stuck or Session not starting notice](#a-persona-posts-a-launch-stuck-or-session-not-starting-notice). A still-starting
instance that turns out to be an old one (a retired persona's, or one in
another working directory or config directory) is replaced as any old
instance is, never typed into (`live-row-sequence-started` below).

The retries stop when a retry finds nothing left to recover (the persona is
connected again), when the persona reaches the restart limit through failed
launches, when it stops being up (its own bring-up retry then brings it back),
when it is held for a human (see
[A persona posts a Held: tmux session conflict notice](#a-persona-posts-a-held-tmux-session-conflict-notice),
[A persona posts a Held: unusable tmux session name notice](#a-persona-posts-a-held-unusable-tmux-session-name-notice)
and
[A persona posts a Held: launch start not recorded notice](#a-persona-posts-a-held-launch-start-not-recorded-notice)),
while it is held because agent-director rejected its launch (see
[A persona posts a Cannot launch notice](#a-persona-posts-a-cannot-launch-notice)),
when it is removed from the configuration, and when the server stops. The
retries' own lines go only to the server log.

All of one persona's retry lines (replace `ops_bot` with the key):

```sh
grep -h -E 'unavailable-retry: persona=ops_bot |health-check: persona=ops_bot has its tmux-unavailable |Session relaunch refused for persona=ops_bot |Session kill for persona=ops_bot did not succeed |killSession \(restart adapter\): kill for persona=ops_bot: |refused for persona=ops_bot: |refused for "[^"]*" \(key=ops_bot\)|Restart retry skipped for persona=ops_bot |Deferring persona=ops_bot: |pending-row: (not arming )?"[^"]*" \(key=ops_bot\)' "$STATE"/server.log.* "$STATE"/server.log 2>/dev/null | sort
```

`<cause>` is `unavailable` (agent-director refused a call), `kill-failed`
(agent-director could not stop the instance's session), `environment`
(agent-director answered that tmux isn't available, `ErrTmuxNotAvailable`),
`config` (agent-director refuses its own config file, `ErrConfigMalformed`),
`unclassified` (agent-director returned an error the server can't classify,
see **agent-director returns an error the server can't classify** below)
or `read-error` (agent-director could not report the persona's state),
followed by the error (see [The server log](#the-server-log), Error detail).

**tmux isn't available.** When agent-director answers any call for a
persona with `ErrTmuxNotAvailable`, the persona's destination gets one
notice, and the persona's retries start with the
`environment` cause, even when nothing was launching or recovering it (a
health check, a permission prompt or a removal met it). Which notice depends
on the answer that raised it; the first such answer picks it, and a later
one of either kind while it holds posts nothing:

| Notice | When it is posted | What it means | What to do |
|---|---|---|---|
| *tmux unavailable* | The answer's description does not say the tmux server is a different one. | agent-director cannot reach tmux for this persona; the notice speaks for this persona only. | The notice's own advice: install or repair tmux for the user the workers run as, checking it with the read-only commands under [A persona posts a Not answering notice](#a-persona-posts-a-not-answering-notice). |
| *tmux server changed* | The answer's description says the tmux server answering on the persona's recorded socket is not the one its worker was launched on (agent-director's words: `not the tmux server the agent was launched on`). | The persona's tmux socket now reaches a different tmux server, so agent-director will not act on its session. | A human follows the "Operator actions" section of agent-director's README. No bot acts on it, including a persona that sees the post. Don't install or repair tmux for it. |

Both clear the same way, with the same *All clear.* notice naming
`tmux-unavailable` (posted once nothing else is wrong for the persona), as
below. Nothing is killed,
deleted or relaunched because of it, no `Spawn failure:` notice is posted and
nothing counts toward the restart limit. When the answer comes while the
server is answering a just-launched instance's startup prompts, the server
stops answering them (the `answered that tmux is not available` line under
[Other lines you may see](#other-lines-you-may-see)). While the notice holds, a
still-starting instance gets no *Launch stuck* or *Session not starting*
notice, and the server's own stuck launch is not ended: the *tmux
unavailable* notice is its notice, and an end agent-director answered with
tmux unavailable is tried again, with no second *Launch stuck*, once it
clears (see
[A persona posts a Launch stuck or Session not starting notice](#a-persona-posts-a-launch-stuck-or-session-not-starting-notice)). While the notice holds, the health
check still checks the persona but never restarts or reconnects it; the
retries go on at their backoff. If the retries stopped while the notice still
holds (the persona wasn't up at a retry, its relaunch was declined, or the
retry failed internally), the next health check that finds the persona not
healthy starts them again with the `environment` cause (the
`has its tmux-unavailable outage raised with no retry timer` line below), so
the persona is never left with nothing retrying it. A message lost while
the notice holds reports `not answering` and starts no restart; if the
persona's retries are not running, it starts them with the `environment`
cause first, as a session disconnect does (the `Lost message: … arming one`
line below), so it still reports `not answering`. It starts none while the
persona is held for a human (it reports `held for a human`), while a launch of it
is running or its startup prompts are still being answered (it reports
`starting`), or while the server replaces its old instance (it reports
`restarting`). At the restart limit it starts nothing
and reports `restart limit reached` (or `restarting`, `auto-restart disabled`
or `starting`, whichever applies first), never `not answering`. A session
disconnect while the notice holds never schedules a restart; one line after
its `Session disconnected` line says what it did instead (the `has its
tmux-unavailable outage raised` lines below). With the persona's retries
running it does nothing more: they recover it. With none running it starts
them with the `environment` cause, so a retry comes even with
`session_restart_delay` and `health_check_interval` both `0`; it starts
nothing while the persona is held for a human, a launch of it is running, the
server is replacing its old instance, or its just-launched instance's startup prompts are still being answered. The notice clears, with its
all-clear, only once tmux itself answers: a call that works the persona's
session succeeds or is told the session is gone, or a health check or retry finds the persona running,
connected and receiving messages. The retry line that follows is usually
`stopped — nothing left to recover` (a retry found the persona healthy) or,
after a retry relaunched it, `kept — the tmux-unavailable condition cleared,
but its row last read pending` (the retries go on reading the new session's
row until it is live). A clear between retries, by a health check or another
call, logs `stopped — the tmux-unavailable condition cleared`. A state
check or row read that succeeds while tmux is still broken clears nothing. A
retry started for a persona that was removed or isn't up stops at its first
retry with no call; one started during a removal or a destructive change
(by a launch still running then) is stopped by the teardown itself, so it
never retries a persona whose settings changed and is coming up again. The
teardown's own kill starts none.

**agent-director refuses its config file.** When agent-director answers any
call for a persona with `ErrConfigMalformed`, it refuses its own config file,
`~/.agent-director/config.toml`, and fails every call that reads its store
until a human fixes the file. The persona's destination gets one
*agent-director refuses its config file* notice, which quotes
agent-director's description of the problem, and the persona's retries start
with the `config` cause, even when nothing was launching or recovering it (a
health check, a permission prompt or a removal met it). The quoted
description is shown as text: a mention or link in it notifies no one. A
later answer of the same kind while the notice holds posts nothing. When the
answer comes while a confirmed change tears the persona down (its kill, the
read between its tries, or a launch still running), neither the notice nor
its later *All clear.*, whenever that comes, is posted: both go to
`server.log` and `persona-teardown-notice` entries (see
[A notice raised during a teardown](#a-notice-raised-during-a-teardown));
the fix is the same.

The server does nothing because of it: nothing counts toward the restart
limit, the persona is never read as dead (its state reads unknown), nothing
is killed, deleted or relaunched, no `Spawn failure:` notice is posted and no
`spawn-failed` entry is written. Every launch or restart step that meets it
stops there with its `refused` line (below). The server's own stuck launch
gets no *Launch stuck* notice and is not ended while the notice holds (an
end whose tries meet it stops them, with no further kill); once the file is
fixed, the next check at the limit posts *Launch stuck* and ends it (see
[A persona posts a Launch stuck or Session not starting notice](#a-persona-posts-a-launch-stuck-or-session-not-starting-notice)). When the answer comes while
the server is answering a just-launched instance's startup prompts, the
server keeps watching that instance within its time limit, checking every
5 s after such an answer (the `polling on within the bound` lines under
[Other lines you may see](#other-lines-you-may-see)). The retries go on at their
backoff whatever `session_restart_delay` and `health_check_interval` are, `0`
included. A message lost while the notice holds reports `not answering`, with
no restart started, while the persona's retries are running. At the restart
limit it reports `restart limit reached` instead (unless a restart is
already under way, `session_restart_delay` is `0` or its session is
starting); if the retries have stopped below the limit, it reports the next
state that applies, which can be `starting now`.

The fix is a human's: a human fixes `~/.agent-director/config.toml`
following agent-director's documentation, which gives the file's rules. This
skill never edits that file, never offers to, and describes no edit to it; no
bot acts on the notice, including a persona that sees the post. Read-only
checks only: the persona's lines below.

The notice clears at the first successful call for the persona that reads
agent-director's store (a retry's, a health check's or any other), or a state
check told the persona's row is gone: its destination then gets an *All
clear.* notice naming `ad-config-malformed` (once nothing else is wrong for
the persona). A call that fails, for any reason, clears nothing. A working
`agent-director version` or `agent-director help` proves nothing, because
both run without the config file; the *All clear.* is the confirmation. Its
clear doesn't stop the retries: they stop by their own rules (usually
`stopped — nothing left to recover` at the next retry).

| Line | Meaning | What to do |
|---|---|---|
| `[slack] outage-state: ad-config-malformed raised for persona=<key>: class=CONFIG name=ErrConfigMalformed message="<description>" — no action is taken; the retry timer retries the persona (b.jg5 SRJ-316)` | agent-director refused its config file for a call for the persona; the notice was posted. Logged once per notice. `<description>` is agent-director's own words (redacted, on one line, shortened when long); ` message="…"` is absent when it gave none. | A human fixes the file, following agent-director's documentation. Nothing for a bot to do. |
| `[slack] outage-state: ad-config-malformed cleared for persona=<key> — agent-director read its store again (b.jg5 SRJ-312)` | A call for the persona that reads agent-director's store worked (or a state check found its row gone), so the fix has taken effect for the persona. The *All clear.* follows when nothing else is wrong for it. | Nothing. |
| `[slack] outage-state: onset notice for persona=<key> failed: <error> — the flag stays raised; the notice counts as posted` | Posting the *agent-director refuses its config file* notice failed, so the persona's destination did not get it. It is not posted again while the file is refused; the retries start as usual. | Check the persona's destination (see [`persona-destination-failed`](#persona-destination-failed)). The human fix of the file is the same. |
| `[slack] outage-state: all-clear notice for persona=<key> failed: <error> — the flags stay cleared; the notice counts as posted` | tmux answered again for the persona, so its *tmux unavailable* problem cleared, but posting the all-clear failed and the persona's destination did not get it. It is not posted again; the server goes on as usual. | Check the persona's destination (see [`persona-destination-failed`](#persona-destination-failed)). |
| `[slack] unavailable-retry: persona=<key> armed (config: <error>) — first retry in 30 s` | The retries started with the `config` cause. | Nothing. |
| `[slack] isSessionAlive: status error for persona=<key>: <error> — read as unknown, not dead` | With `ErrConfigMalformed` in `<error>`, logged at every state check while the file is refused, beside the one `raised` line above. | Nothing beyond the human fix. |

**agent-director returns an error the server can't classify.** While the
server launches or recovers a persona, agent-director can answer with an
error the server has no handling for: an `ErrInternal` (other than one about
the persona's recorded session name), a store it can't open
(`ErrSchemaMismatch`, `ErrSchemaMigrationRequired`, `ErrStoreOpen`), its
install disappearing (`ErrSystemInstallDisappeared`, which also posts the
*agent-director unreachable* notice: it says the outage affects every
persona, since the binary is host-wide, and its remedy points to the
README section "Switching over to agent-director Phase 1"), any other error name the server gives no
handling, or a resume's `ErrInvalidFlags` after the server re-checked the
binary's version. The server does nothing destructive because of it:
nothing is deleted, killed or relaunched after it, nothing counts toward the
restart limit, no `Spawn failure:` notice is posted and no `spawn-failed`
entry is written. Every launch or restart step that meets it stops there
with its `refused` line (below), and the persona's retries start with the
`unclassified` cause (`read-error` when the error came from reading the
persona's state). The same errors met outside a launch or recovery (a
health check, a permission prompt) start no retries and no episode.

A human hears of it once per episode, and only when it lasts: the persona's
destination gets one *Unclassified agent-director error* notice, at the
first launch or recovery step (a retry's, usually) that still meets such an
error more than the alert threshold after the first one. The threshold is
the one *Still not answering* uses: the longer of agent-director's
`stopping_window_seconds` and `starting_session_seconds`, plus 60 s, from
the values in effect (see
[agent-director's timing settings](#agent-directors-timing-settings)). With
both at agent-director's defaults that is 360 s, so the notice usually comes
with the retry about 450 s after the first error. The notice names the error when its
name is safe to show and quotes agent-director's description (redacted, on
one line, shortened when long); it says the server keeps retrying and takes
no destructive action, and that a human should check the host's
agent-director. No second notice follows in the episode.

The episode runs from the first such error until a retry finds nothing left
to recover, a retry that only reads the persona's state after a relaunch
finds its new session started, ended or gone, the persona's retries stop
because its tmux condition ended (the `tmux-unavailable` condition cleared
or the `tmux-unresponsive` condition ended), the persona reaches the restart
limit, it is held for a human (a *Held:* notice), it is torn down, or the
server stops. Its retries stopping for
another reason (the persona isn't up, it is no longer in the applied
configuration, its relaunch was declined, a retry run failed) leave the
episode open. A later error after the end
starts a new episode, which posts the notice again.

**A persona no longer configured.** When the notice falls due for a persona
that is no longer in the applied configuration (a launch for it was still
running when it was removed), nothing reaches Slack. The server writes one
`persona-unclassified-error` entry to `startup-errors.log`, the same line to
`server.log`, and its own `alert written to the server log and
startup-errors.log` line (below). The entry names the persona's key and the
notice's text:
`[<time>] [persona-unclassified-error] persona=<key>: :warning: *Unclassified agent-director error* — <rest of the notice>`.

**During a teardown.** When the notice falls due while a confirmed change
tears the persona down (a launch for it was still running), nothing reaches
Slack, whether or not the persona is still configured: it goes to
`server.log` and a `persona-teardown-notice` entry instead of a
`persona-unclassified-error` one (see
[A notice raised during a teardown](#a-notice-raised-during-a-teardown)).
Once the teardown is queued and before it starts, the notice is not posted
either (the `not posted to its destination — muted` line below).

```sh
grep -h -F '[persona-unclassified-error]' "$STATE"/startup-errors.log 2>/dev/null | tail -n 20
grep -h -E 'persona-episodes: persona=ops_bot unclassified-error alert written' "$STATE"/server.log.* "$STATE"/server.log 2>/dev/null | sort
```

The fix is a human's: check the host's agent-director, following
agent-director's documentation, and the persona's lines below. This skill
names no agent-director command for it and takes no action on it; no bot acts
on the notice, including a persona that sees the post. Once agent-director
answers normally, the next retry recovers the persona with no server
restart.

All of one persona's lines of this kind (replace `ops_bot` with the key):

```sh
grep -h -E 'persona-episodes: persona=ops_bot unclassified-error |unavailable-retry: persona=ops_bot armed \((unclassified|read-error)|refused for persona=ops_bot: |refused for "[^"]*" \(key=ops_bot\)|pane read for persona=ops_bot answered ' "$STATE"/server.log.* "$STATE"/server.log 2>/dev/null | sort
```

| Line | Meaning | What to do |
|---|---|---|
| `[slack] persona-episodes: persona=<key> unclassified-error started — class=UNCLASSIFIED[ name=<name>][ message="<description>"]` | The episode began: the first error the server can't classify while launching or recovering the persona. ` name=<name>` is absent when the name isn't safe to show, ` message="…"` when agent-director gave no description. No notice yet. | Nothing yet: the retries go on. |
| `[slack] unavailable-retry: persona=<key> armed (unclassified: <error>) — first retry in 30 s` | The retries started with the `unclassified` cause (`armed (read-error: <error>)` when the error came from reading the persona's state). | Nothing. |
| `[slack] persona-episodes: persona=<key> unclassified-error alert posted to its destination — an UNCLASSIFIED outcome met <s> s after the episode's first, over its alert threshold of <s> s: class=UNCLASSIFIED[ name=<name>][ message="<description>"]` | The *Unclassified agent-director error* notice went to the persona's destination. The numbers are the time since the episode's first error and the alert threshold in effect; the classification is the error the notice quotes. | A human checks the host's agent-director, following agent-director's documentation. If the notice doesn't arrive, see [`persona-destination-failed`](#persona-destination-failed). |
| `[slack] persona-episodes: persona=<key> unclassified-error alert written to the server log and startup-errors.log (persona-unclassified-error) — the persona is not in the applied configuration; an UNCLASSIFIED outcome met <s> s after the episode's first, over its alert threshold of <s> s: <classification>` | The notice was due, but the persona is no longer in the applied configuration, so it went to `startup-errors.log` (the `persona-unclassified-error` entry) and `server.log` only. | As above; nothing to do for the removed persona itself. |
| `[slack] persona-episodes: persona=<key> unclassified-error alert written to the server log and startup-errors.log (persona-teardown-notice) — raised during its persona teardown; an UNCLASSIFIED outcome met …` | The notice fell due while a confirmed change tore the persona down: it went to a `persona-teardown-notice` entry and `server.log` only. | As above. |
| `[slack] persona-episodes: persona=<key> unclassified-error alert not posted to its destination — muted, its persona teardown was submitted; it counts as posted in its episode; an UNCLASSIFIED outcome met …` | The notice fell due after a confirmed change queued the persona's teardown, before it started: not posted. | As above. |
| `[slack] persona-episodes: persona=<key> unclassified-error ended — <reason>` | The episode ended with no notice. `<reason>`: `a retry found nothing left to recover` (the persona is back), `a retry read its row live out of pending` (after a relaunch, its new session started), `its retry timer stopped when its tmux condition ended` (tmux answers again for the persona), `a retry read its row ended or gone` (after a relaunch, its new session ended or disappeared; the restart path decides what happens next), `the persona reached the restart cap` (see the `SpawnCapReached` notice), or `the persona latched` (see [A persona posts a Held: tmux session conflict notice](#a-persona-posts-a-held-tmux-session-conflict-notice)). | Nothing. At the restart cap, restart the server to retry the persona once agent-director answers normally. |
| `[slack] spawnForPersona: resume refused for "<name>" (key=<key>): class=UNCLASSIFIED name=ErrInvalidFlags[ message="<description>"] (after one immediate agent-director version re-check: <answer>) — no spawn-failure notice; nothing more is called (b.jg5 SRJ-105)` | agent-director refused the persona's resume with `ErrInvalidFlags`. The server re-checked the binary's version once (`<answer>`: `pass`, `could-not-run` or `not-running`) and treats it as an error it can't classify: the resume stops, nothing is deleted, killed or launched, and the retries take over. When the re-check refuses the binary instead, the line reads `resume failed for … (after one immediate agent-director version re-check: stop)` and the server stops (see [Found while the server was running](#found-while-the-server-was-running)). | Nothing yet; the notice follows if it lasts. |
| `[slack] spawnForPersona: <call> refused for "<name>" (key=<key>): class=UNCLASSIFIED name=ErrInvalidFlags[ message="<description>"] (after one immediate agent-director version re-check: <answer>) — no spawn-failure notice; nothing more is called (b.jg5 SRJ-105)` | The same for a launch's plain spawn of the persona's instance id (`<call>`: `spawn`, `retry-spawn` or `fresh spawn after ErrSpawnNotFound on resume`): one version re-check, then an error the server can't classify. Nothing else is launched, the persona is not held, no `Spawn failure:` notice is posted, and the retries take over. With a re-check that refuses the binary the line reads `<call> failed for … (after one immediate agent-director version re-check: stop)` and the server stops. | Nothing yet; the notice follows if it lasts. |
| `[slack] spawnForPersona: <call> refused for "<name>" (key=<key>): class=UNCLASSIFIED[ name=<name>][ message="<description>"] — no spawn-failure notice; nothing more is called (b.jg5 SRJ-105)` | That spawn got an agent-director error it gives no meaning (such as a state error), so the server treats it as one it can't classify: no `Spawn failure:` notice, nothing counted, and the retries take over. | Nothing yet; the notice follows if it lasts. |
| `[slack] <site>: pane read for persona=<key> answered <classification> — UNCLASSIFIED after one immediate agent-director version re-check: <recheck> (b.jg5 SRJ-104, SRJ-204)` | agent-director answered a read of the persona's screen with `ErrInvalidFlags`, which means nothing for that read. `<site>` is `readWorkingPane` (a launch waiting on a `working` row, or the health check's reconnect checking a `waiting` row), `reconnectSession` (the health check's reconnect checking a `working` row), `reconnectSession: prompt row` (the health check's reconnect checking an `ask_user` or `check_permission` row) or `spawnForPersona: prompt row` (a launch checking such a row). The server re-checked the binary's version once (`<recheck>`: `pass`, `stop`, `could-not-run` or `not-running`) and treats the answer as an error it can't classify: the reader's own line for that class follows (for the health check, a `reading its pane failed` line in [A row that reads `working` while the instance sits idle](#a-row-that-reads-working-while-the-instance-sits-idle)). Inside a launch or recovery attempt the persona's retries take over and the episode is reported; in a health check no episode starts. With `<recheck>` `stop` the re-check refused the binary: the read types nothing, the launch's wait or the health check's reconnect logs one of the *version re-check decided that the server stops* lines (the wait's is in [A row that reads `working` while the instance sits idle](#a-row-that-reads-working-while-the-instance-sits-idle); the reconnect's three and the launch's prompt-row one are below) and calls nothing more for the persona, and the server stops (see [Found while the server was running](#found-while-the-server-was-running)). | Nothing yet; the notice follows if it lasts. With `stop`, as for a stopped server. |
| `[slack] reconnectSession: persona=<key> is waiting and reading its pane failed: <error> — the agent-director version re-check decided that the server stops; not typing /mcp reconnect, nothing more is called for it (read-pane class=<CLASS>; b.jg5 SRJ-204, SRJ-205)` | The health check's reconnect read the screen of a persona whose row reads `waiting`; agent-director answered `ErrInvalidFlags`, and the version re-check after it refused the binary (the `pane read … re-check: stop` line above comes first). `<CLASS>` is `UNCLASSIFIED`. Nothing is typed, nothing more is called for the persona, no episode starts, and the server stops. | Treat it as a stopped server: see [Found while the server was running](#found-while-the-server-was-running). |
| `[slack] reconnectSession: persona=<key> is working and reading its pane failed: <error> — the agent-director version re-check decided that the server stops; not typing /mcp reconnect, nothing more is called for it (read-pane class=<CLASS>; b.jg5 SRJ-204, SRJ-205)` | The same for a persona whose row reads `working`: the screen read answered `ErrInvalidFlags` and the version re-check refused the binary. `<CLASS>` is `UNCLASSIFIED`. Nothing is typed, no held-back time is counted, nothing more is called for the persona, and the server stops. | Treat it as a stopped server: see [Found while the server was running](#found-while-the-server-was-running). |
| `[slack] reconnectSession: persona=<key> is <state> and reading its pane failed: <error> — the agent-director version re-check decided that the server stops; nothing more is called for it (read-pane class=<CLASS>; b.jg5 SRJ-204, SRJ-205)` | The same for a persona whose row reads `ask_user` or `check_permission` (`<state>`). `<CLASS>` is `UNCLASSIFIED`. Nothing is typed or posted, nothing more is called for the persona, and the server stops. | Treat it as a stopped server: see [Found while the server was running](#found-while-the-server-was-running). |
| `[slack] spawnForPersona: "<name>" (key=<key>) reads <state> and reading its pane failed: <error> — the agent-director version re-check decided that the server stops; nothing more is called for it (read-pane class=<CLASS>; b.jg5 SRJ-204, SRJ-205)` | The same at a start or relaunch that found an `ask_user` or `check_permission` row. The launch ends with no `Spawn failure:` notice and no `spawn-failed` entry, and the server stops. | Treat it as a stopped server: see [Found while the server was running](#found-while-the-server-was-running). |
| `[slack] persona-episodes: persona=<key> unclassified-error configured-key lookup failed: <error> — the alert takes the log-only route` | An internal error checking whether the persona is still configured; the notice went to `startup-errors.log` and `server.log` instead of Slack. | Report it as a bug, with the persona's lines. |
| `[slack] persona-episodes: persona=<key> unclassified-error report failed: <error>`, `… log-only alert failed: <error>`, `… alert not routed — the persona is not in the applied configuration and no log-only route is installed; <…>`, `[slack] persona-episodes: persona=<key> unclassified-error notice failed: <error>` | An internal error: the notice may be missing, but the retries go on unchanged. | Report it as a bug, with the persona's lines. |

| Line | Meaning | What to do |
|---|---|---|
| `[slack] unavailable-retry: persona=<key> armed (<cause>) — first retry in 30 s` | agent-director refused a call while the persona was being launched or recovered, answered any call for it with `ErrTmuxNotAvailable` (`environment`, at any time) or `ErrConfigMalformed` (`config`, at any time), returned an error the server can't classify while the persona was being launched or recovered (`unclassified`), or a restart couldn't read the persona's state (`read-error`). `held-for-old-life`: the persona waits on an old instance the server is ending (see [An old instance the server is ending](#an-old-instance-the-server-is-ending) and [A persona waiting on an old instance](#a-persona-waiting-on-an-old-instance)); once that instance ends it is retried at once (`retrying now (old-life-hold-ended)`). Its first retry is due in 30 s. A refusal while it is already waiting logs nothing and keeps the time. | Nothing. If it keeps retrying, see below. |
| `[slack] unavailable-retry: persona=<key> armed in pending-only mode (pending-row) — first retry in 30 s` | The persona's instance is still starting, and it is the persona's own launch: after any launch that returned (a start, a restart, a confirmed change's bring-up, a replacement, a retry's relaunch), after a launch that could not create its tmux session, when the startup-prompt watch stopped while it was still starting, or when a restart or retry found it still starting. Its retries read its state until the session starts, and from agent-director's grace period on check it once each with agent-director: nothing is ended or launched over it, and nothing is typed into it but Enter on a startup prompt the server recognises. When the persona's retries are already waiting, no such line is logged. | Nothing. If it stays starting for many minutes, see [A persona posts a Launch stuck or Session not starting notice](#a-persona-posts-a-launch-stuck-or-session-not-starting-notice). |
| `[slack] health-check: persona=<key> has its tmux-unavailable outage raised with no retry timer — arming one` | The persona's *tmux unavailable* or *tmux server changed* notice still holds, a health check found it not running, still starting, disconnected or not receiving messages, and nothing was retrying it (its earlier retries stopped: it wasn't up at a retry, its relaunch was declined, or the retry failed internally). The health check starts the retries; `[slack] unavailable-retry: persona=<key> armed (environment) — first retry in 30 s` follows. The health check itself still restarts and reconnects nothing. | Nothing; the retries take over. If the persona isn't up, the first retry stops with `the persona is not up; its bring-up owns it`: follow its class line (see [Persona diagnostic classes](#persona-diagnostic-classes)). For tmux itself, see **tmux isn't available** above and **It never clears** below. |
| `[slack] Session relaunch refused for persona=<key> — not counted; its UNAVAILABLE retry timer owns the persona` | A relaunch was refused by agent-director. It doesn't count toward the restart limit; the retries above take over. | Nothing. |
| `[slack] <step>: <call> refused for "<name>" (key=<key>): <error> — no spawn-failure notice; nothing more is called (b.jg5 SRJ-105)` | While the persona was being launched, agent-director refused a call (`<call>` names it, such as `spawn`, `resume`, `kill`, `delete`, `collision get` or `findMissing sweep`), or couldn't report the persona's state (`ErrJsonlMissing diagnosis get`: the read of the persona's old row before bringing it up fresh after a missing transcript). An `<error>` naming `ErrConfigMalformed` is agent-director refusing its config file (see **agent-director refuses its config file** above); one the server can't classify, such as an `ErrInternal`, a store agent-director can't open or `ErrSystemInstallDisappeared`, is covered under **agent-director returns an error the server can't classify** above. The launch stops there with no `Spawn failure:` notice, no `spawn-failed` entry and nothing counted; nothing is deleted, killed or launched after it. After `ErrJsonlMissing diagnosis get` there is also no `jsonl-diagnosis-inconclusive` entry and no uncertainty warning to the persona: nothing was diagnosed. The retries above take over. A reconnect that agent-director can't carry out right now logs its own line instead, `reconnectMcp: send-keys refused for <ref>: <error> — <CLASS>: transient; …` (see [A row that reads `working` while the instance sits idle](#a-row-that-reads-working-while-the-instance-sits-idle)): nothing is typed or counted, and the retries above take over the same way. A refused `findMissing sweep` on the restart path logs `escalate-dead: findMissing sweep refused for persona=<key>: <error> — …` (after its `escalate-dead:` line) or `reconnectSession: prompt row: findMissing sweep refused for persona=<key>: <error> — …`: the restart does nothing more this time (nothing is checked again, stopped or relaunched, and no notice is posted). After a `findMissing sweep` that succeeded, `<step>: post-sweep get refused for <persona>: <error> — …` means the server's follow-up read of the persona's own row failed (it comes after the sweep's `one get of each configured persona's own row` line, which shows that persona as `refused (<error>)`); the persona's launch or restart stops the same way. A `reconnectMcp: send-keys refused` line naming `ErrSpawnNotInteractive` and saying `dead session (row-not-interactive)` is not a refusal: the restart or the launch decides what happens to the persona next. | Nothing. If it keeps happening, see **It never clears** below. |
| `[slack] reuseSpawnForPersona: reuse spawn refused for "<name>" (key=<key>): <error> — no spawn-failure notice; nothing more is called (b.jg5 SRJ-105)` | agent-director refused the spawn that brings the persona up fresh on its own instance id (after a resume that found no conversation, or a replacement's launch): it can't act right now, tmux isn't available, it refuses its config file, or an error the server can't classify (an `ErrInvalidFlags` after a version re-check that let the server run on ends `<error>` with `(after one immediate agent-director version re-check: <answer>)`). Nothing else is launched, killed or deleted, no `Spawn failure:` notice is posted and nothing is counted; the retries above take over. | Nothing. If it keeps happening, see **It never clears** below. |
| `[slack] spawnForPersona: collision get failed for "<name>" (key=<key>): <error> — nothing more is called`, `[slack] spawnForPersona: ErrJsonlMissing diagnosis get failed for "<name>" (key=<key>): <error> — nothing more is called` | Not expected: a read of the persona's row during a launch failed with an error the server neither refuses nor recognises. The launch stops there (after the `ErrJsonlMissing diagnosis get`, nothing is diagnosed or launched), with no `Spawn failure:` notice and no `spawn-failed` entry. | Report it as a bug, with the persona's lines. |
| `[slack] killSession (restart adapter): kill for persona=<key>: <outcome>` | A restart's kill of the persona's old session, before its relaunch. `<outcome>` says how it went. Successes, after which the relaunch follows: `outcome=killed kill_sent=true` (agent-director stopped it), `outcome=killed kill_sent=false` (agent-director found no session of the persona's current launch, and its worker was gone or not recorded: a normal recovery, nothing to check), `outcome=killed kill_sent=absent` (an agent-director older than Phase 1 answered), `outcome=row-gone (ErrSpawnNotFound)` or `outcome=session-gone (<error name>)` (already gone). `outcome=not-killed class=<class> …` did not succeed; a `Session kill … did not succeed` line follows, after a `kill refused … CONFLICT` or `… UNUSABLE NAME` line for those two classes. The kill is made only after agent-director answered the restart's check that its own install had disappeared, which reads nothing of the instance; a restart never kills a row it has just read ended or missing, or found gone. The kill is never repeated, so its one `kill try 1 of 1` line comes just before this one (see [A kill that is tried again](#a-kill-that-is-tried-again)). | Nothing for a success. For `not-killed`, the next lines. |
| `[slack] Session kill for persona=<key> did not succeed (<outcome>) — no relaunch; not counted` | The restart stopped at a kill that did not succeed: agent-director couldn't stop the session (`class=UNAVAILABLE`, `ErrTmuxKillFailed` among them, with agent-director's description), answered that tmux isn't available (`class=ENVIRONMENT`), refused its config file (`class=CONFIG`), or returned an error the server can't classify (`class=UNCLASSIFIED`, `ErrSystemInstallDisappeared` among them). The old session may still be running, so nothing was relaunched over it, and nothing counts toward the restart limit. The retries above take over. For `ErrTmuxKillFailed` the persona's destination also gets a *Kill failed* notice (see [A persona posts a Kill failed or Process outlived kill notice](#a-persona-posts-a-kill-failed-or-process-outlived-kill-notice)). | Nothing. For `ErrTmuxKillFailed`, see that section; for `ENVIRONMENT`, see **tmux isn't available** above; for `CONFIG`, **agent-director refuses its config file** above; for `UNCLASSIFIED`, **agent-director returns an error the server can't classify** above. If it keeps happening, see **It never clears** below. |
| `[slack] Session kill for persona=<key> did not succeed (<outcome>) — the persona is latched; no relaunch; not counted` | A restart's kill answered a session conflict (`class=CONFLICT`) or an unusable recorded session name (`class=UNUSABLE_NAME`): the persona is now held, nothing was relaunched, and the kill is never sent again. | See [A persona posts a Held: tmux session conflict notice](#a-persona-posts-a-held-tmux-session-conflict-notice) or [A persona posts a Held: unusable tmux session name notice](#a-persona-posts-a-held-unusable-tmux-session-name-notice). |
| `[slack] Session kill for persona=<key> did not succeed (<outcome>) — the version re-check decided that the server stops; no relaunch; not counted; nothing more is called` | A restart's kill answered `ErrInvalidFlags`, the server re-checked the agent-director binary's version once (`recheck=stop` in `<outcome>`), and the binary is one the server can't run with: the server stops. | See [Found while the server was running](#found-while-the-server-was-running). |
| `[slack] unavailable-retry: persona=<key> retry <n> — rerunning its recovery` | Retry `<n>` runs: it reads the persona's state, then reconnects or relaunches it. | Nothing. |
| `[slack] unavailable-retry: persona=<key> retry <n> (pending-only) — reading its row` | Retry `<n>` runs after a launch, or while the instance is still starting: it only reads the persona's state (and, when it is still starting, reads its row once more to tell whether it is the persona's own launch), and types nothing and launches nothing. | Nothing. |
| `[slack] unavailable-retry: persona=<key> retry <n>[ (pending-only)]: <reason> — re-armed[ in <mode> mode], next retry in <s> s` | The retry didn't finish the recovery; the next is due in `<s>` s. ` (pending-only)`: the retry only read the state. ` in pending-only mode`: the next retries only read the state; ` in full mode`: they recover the persona again. `<reason>`: a `<cause>` as above (agent-director still refuses), `launch-in-flight`, `live-row-sequence-in-flight` or `old-life-wait-in-flight` (a launch for the persona was already running, the server was replacing its old instance, or the server was ending an old instance the persona waits on, see [An old instance the server is ending](#an-old-instance-the-server-is-ending), so the retry did nothing; with or without ` (pending-only)`), `live-row-sequence-waiting` (the server began replacing the persona's old instance while the retry waited its turn, so the retry did nothing), `launch-failed` (the relaunch failed and was counted toward the restart limit), `reconnect-deferred` (the instance runs but couldn't be reconnected yet), `pending-deferred` (the instance is still starting, so nothing was typed), `launched` (the relaunch succeeded; the next retries only read the state until the new session has started, unless agent-director refused another call during that retry or a kill failed, when they recover the persona again), `row-pending` (the instance is still starting, and it is the persona's own launch), `live-row-sequence-started` (the instance is still starting but is an old one, a retired persona's or one in another working directory or config directory, so the server began replacing it: the `live-row-sequence:` lines follow, and the retry itself launched and typed nothing), `restart-not-initialised` (the server was still starting), `liveness-unknown` (agent-director couldn't report the persona's state, so nothing was done; see [agent-director can't report a persona's state](#agent-director-cant-report-a-personas-state)). A `<cause>` after ` (pending-only)`, with ` in full mode`: agent-director refused another call for the persona while the retry read its state, so the retries go on and the next one recovers the persona again, whatever the state read. `the retry failed: <error>` after ` (pending-only)`: agent-director couldn't report the state; it is usually followed by ` in full mode`, and the next retry recovers the persona again. `the retry failed: <error>`, `the retry gave no answer`, `no cause given` or `unnamed` mean an internal error, and the retries go on. | Nothing while it is agent-director refusing: see below if it never clears. `launch-failed` repeating: read the `Session relaunch failed` and spawn-failure lines for the persona. An internal error that repeats: report it as a bug, with the persona's lines. |
| `[slack] Restart retry skipped for persona=<key> — <a launch is in flight\|its live-row sequence runs\|an old-life wait step it waits on runs>; no agent-director call` | A retry found work for the persona already running and made no call: a launch of it, the server replacing its old instance, or the server ending an old instance it waits on (see [An old instance the server is ending](#an-old-instance-the-server-is-ending)). That work decides the outcome; the retry comes back later. | Nothing. |
| `[slack] Restart retry skipped for persona=<key> — the persona is at the restart cap; nothing killed or launched` | A retry waited behind other recovery work for the persona, and that work's failed relaunch brought the persona to the restart limit (5 failures in a row, with its `SpawnCapReached` notice). The retry made no call and counted nothing; `stopped — the persona is at the restart cap` follows. The same line comes from the bring-up right after the server's own check ended a hold of a persona already at the restart limit (after `clear-latch` only when the reset of its restart limit failed, since that clear clears the limit first): nothing was launched, and the `latch-clear: … answered capped` line follows instead (see **A held persona at the restart limit** under [A persona posts a Held: tmux session conflict notice](#a-persona-posts-a-held-tmux-session-conflict-notice)). | As for that stopped line: restart the server to retry it. Check first that agent-director answers: `agent-director version` (see **It never clears** below). |
| `[slack] health-check: persona=<key> is at cap — skipping tick (SR-25.3/25.4)` | Not a retry line: every health check logs it for any persona at the restart limit (5 failed relaunches in a row, whatever their cause), and does nothing else for it, even while a launch for it is still running. | Fix the cause of the failed relaunches (read the persona's `Session relaunch failed` and spawn-failure lines), then restart the server to retry it. |
| `[slack] restart retry: in-flight check failed for persona=<key>: <error> — treated as in flight` | An internal error checking for a running launch; the retry made no call and comes back later. | Report it as a bug if it repeats. |
| `[slack] runRestartRetry: deps not initialized — skipping the retry for persona=<key>` | A retry fell due while the server was still starting; it comes back later. | Nothing, unless it repeats: then report it as a bug. |
| `[slack] unavailable-retry: persona=<key> promoted to full mode (<cause>) — its due time is kept` | agent-director refused a call for a persona whose retries were only reading its state. The next retry, at the time already set, recovers the persona again. | Nothing. |
| `[slack] unavailable-retry: persona=<key> stopped (pending-only, row <state>) — its row is live out of pending; nothing else is called` | After a launch, the new session has started (`<state>` is its state, such as `waiting` or `working`). The retries stop, with no further call. | Nothing. If the persona still isn't served, see [A persona is down but its instance is still running](#a-persona-is-down-but-its-instance-is-still-running). |
| `[slack] unavailable-retry: persona=<key> stopped (pending-only, row <state>) — its row is ended, missing or gone; the restart path's decision runs once` | After a launch, the new instance's row reads finished or absent (`<state>` is `ended`, `missing` or `absent`). The retries stop, and the persona gets one more recovery: its own lines follow, and a refusal in it starts the retries again at 30 s. | Nothing, unless it repeats: then read the persona's `Session relaunch` and spawn-failure lines. |
| `[slack] unavailable-retry: persona=<key> hand-off after the stop failed: <error>` | An internal error in that one more recovery. The retries have stopped. | Report it as a bug, with the persona's lines. |
| `[slack] unavailable-retry: persona=<key> stopped[ (pending-only)] — <reason>` | The retries stopped. `nothing left to recover`: the persona is back. `the persona is at the restart cap`: its relaunches failed 5 times in a row (see the `SpawnCapReached` notice); restart the server to retry it. `the persona is not up; its bring-up owns it` or `its relaunch was declined (the persona is not up, or the server is stopping)`: follow its class line (see [Persona diagnostic classes](#persona-diagnostic-classes)). `the persona is not in the applied configuration` or `the persona was torn down`: it was removed. `the server is shutting down`: the server stopped. `the tmux-unresponsive condition ended`: the persona's session answers again (see [A persona posts a Not answering notice](#a-persona-posts-a-not-answering-notice)). `the tmux-unavailable condition cleared`: tmux answers for the persona again (see **tmux isn't available** above). `the persona is latched`: the persona is held for a human, and nothing retries it (see [A persona posts a Held: tmux session conflict notice](#a-persona-posts-a-held-tmux-session-conflict-notice), [A persona posts a Held: unusable tmux session name notice](#a-persona-posts-a-held-unusable-tmux-session-name-notice) or [A persona posts a Held: launch start not recorded notice](#a-persona-posts-a-held-launch-start-not-recorded-notice), whichever notice its destination has). `the persona is held on ErrInvalidFlags`: agent-director rejected the persona's launch, and nothing retries it until the binary changes or the server restarts (see [A persona posts a Cannot launch notice](#a-persona-posts-a-cannot-launch-notice)). | As in the meaning. |
| `[slack] unavailable-retry: persona=<key> kept — <condition>, but <why>` | `<condition>` is `the tmux-unresponsive condition ended` or `the tmux-unavailable condition cleared`: the persona's session, or tmux, answers again, but the retries go on at the time already set. `<why>` is `its row last read pending` (the instance was just launched and its session may not have started yet; the next retry checks it) or `a kill-failed cause is recorded` (agent-director couldn't stop an earlier session, so the retries keep recovering the persona), or both. | Nothing. The next retry stops the retries once the persona is back. |
| `[slack] unavailable-retry: persona=<key> not armed (<cause>) — the server is shutting down` | A refusal arrived while the server was stopping; nothing is retried. | Nothing. The next start brings the persona up. |
| `[slack] unavailable-retry: persona=<key> arm failed: <error> — not armed` or `[slack] unavailable-retry: persona=<key> retry run failed: <error>` | An internal error setting the retry's timer. The retries for the persona stop until agent-director refuses a call for it again. A relaunch whose refusal logged `arm failed` counts toward the restart limit, since nothing retries it. | Report it as a bug, with the persona's lines. |

**It never clears.** The persona keeps retrying with the same `<cause>` every
300 s. With the `config` cause, see **agent-director refuses its config
file** above instead: a working `version` proves nothing there. Otherwise,
check that agent-director answers:

```sh
agent-director version
```

If it doesn't answer, or answers with an error, agent-director is the
problem: fix it (the `install-cscb` skill diagnoses it), and the next
retry recovers the persona with no server restart. With the `environment`
cause, tmux is the problem. After a *tmux unavailable* notice, install or
repair it for the user the workers run as, checking it with the read-only
commands under
[A persona posts a Not answering notice](#a-persona-posts-a-not-answering-notice),
and the next retry recovers the persona. After a *tmux server changed*
notice, don't install or repair tmux: a human follows the "Operator actions"
section of agent-director's README, and no bot acts on it (see
**tmux isn't available** above). If both answer normally but the
retries keep failing, report it as a bug, with the persona's lines.

### A launch that timed out

A launch of a persona (a spawn, a reuse of its instance or a `resume`) times
out when the server's call to agent-director runs past
`agent_director_call_timeout_ms` (`ErrCallTimeout`), or when agent-director
answers `ErrTmuxUnresponsive` saying the session may have been created. Such a
launch may still have started the instance, perhaps held at a startup prompt.
So the server reads the persona's row once with `get` and launches nothing
more in that attempt. It makes the same one read after every other launch
agent-director refuses as not answering ("still stopping", "still starting",
tmux unreadable, a "duplicate session" whose holder it could not read, or a
pre-spawn scan that could not answer). The launch is never counted, nothing
is ended, and the retries start as for any refusal:

- **A still-starting row of this persona's own launch:** after a timed-out
  launch the server answers its startup prompt (the `approvePreSessionDialogs`
  lines, below), and the retries only read it until its session starts.
  After any other refusal nothing is typed into it; the retries still watch
  it.
- **A still-starting old instance** (a retired persona's, or one in another
  working directory or with another config directory): replaced as any old
  instance is, never typed into (`live-row-sequence` lines).
- **A running instance:** never launched over; the next retry reconnects it.
- **Ended, missing or no row:** the next retry launches the persona again.

After a timed-out reuse of a retired persona's key that read its own new
row, the key's new life has begun: the server records that, as after a reuse
that succeeded.

To follow it (replace `ops_bot` with the key):

```sh
grep -h -E 'one get after the .* \(key=ops_bot\)|\(key=ops_bot\)(.s key)? .*timed out but launched|approvePreSessionDialogs: (starting|not starting) the approver for "[^"]*" \(key=ops_bot\) \(launch-timeout\)|\(key=ops_bot\): this launch.s row left pending' "$STATE"/server.log.* "$STATE"/server.log 2>/dev/null | sort
```

| Line | Meaning | What to do |
|---|---|---|
| `[slack] spawnForPersona: one get after the <call> of "<name>" (key=<key>) ended in <form>: read <read>; this launch's row: <yes (launch start <time>)\|no> — <outcome>; no launch in this attempt (b.jg5 SRJ-407)` | The one read after a launch timeout or another refusal. `<call>` is `spawn`, `retry-spawn`, `fresh spawn after ErrSpawnNotFound on resume`, `reuse spawn` or `resume`. `<form>` is `a launch timeout (ErrCallTimeout)`, `a launch timeout (ErrTmuxUnresponsive)` or `UNAVAILABLE (<error>)` for another refusal. `<read>` is the row's state, `no row (ErrSpawnNotFound)`, `nothing (a refused read)` or `an UNUSABLE NAME answer`. `this launch's row: yes` means the row's launch start lies within the timed-out call, so it is this launch's own; `no` for any other row, and always after a refusal that was not a timeout. `<outcome>` says what follows: `covered: the approver starts once the launch call has returned; …` (the startup prompt is answered), `covered, but the approver was not started; …`, `covered: no approver after this outcome; …` (a refusal that was not a timeout), `undecided: …` (its directory or config directory can't be resolved right now; read again at the next retry), `not covered (<reason>): the live-row sequence, no approver; …` (an old instance being replaced), `the row is finished: …`, `no row: …`, `another live state: no launch over it; …`, `the read was refused: …` (a refusal line comes before it), `a state CSCB does not know: …`, or `the persona is latched: …` / `no launch start: …` (see the *Held:* entry the persona's notice names) | Nothing: the retries go on on their own. A read-only check, `agent-director get --claude-instance-id cscb_<key>`, shows the row as it is now. If timeouts repeat, check the call timeout against its need (see [The call timeout](#the-call-timeout)) |
| `[slack] approvePreSessionDialogs: starting the approver for "<name>" (key=<key>) (launch-timeout): its launch call timed out and the get after it read its pending row covered — the approver runs after the launch call returned, under the same stop rules as after a returned launch (b.jg5 SRJ-401, SRJ-404, SRJ-407)` | The server answers the startup prompt of an instance whose launch timed out, as after a launch that returned; its other `approvePreSessionDialogs` lines follow | Nothing |
| `[slack] approvePreSessionDialogs: not starting the approver for "<name>" (key=<key>) (launch-timeout): its pending row <why> — no status, read-pane or send-keys (b.jg5 SRJ-401, SRJ-407)` | The row read after a timeout is not one the server may type into: `has no launch start`, `is not covered (<reason>)` (an old instance) or `is undecided (<reason>)`. Nothing is typed | Nothing; the one-read line says what follows |
| `[slack] <site>: <what> for "<name>" (key=<key>): this launch's row left pending for <state> after its launch timeout — the tmux-unresponsive condition ends if it holds (SRJ-310 rule 3; b.jg5 SRJ-407)` | A later read (`<site>: <what>`, for example the approver's `approvePreSessionDialogs: readiness status read`, a retry's read or a health check's) found the timed-out launch's instance started. The `persona-episodes … tmux-unresponsive ended — after a launch timeout, …` line comes just before it when the record was open (see [A persona posts a Not answering notice](#a-persona-posts-a-not-answering-notice)) | Nothing |
| `[slack] spawnForPersona: "<name>" (key=<key>)'s key is retired and its reuse spawn timed out but launched (its row is this launch's) — its new life has begun; <mark>; the launch answers retrying (b.jg5 SRJ-407, SRJ-806)` | A reuse of a retired persona's key timed out, and the read found its own new row: the key's new life is recorded (`<mark>` says whether the record was written), and an old instance the persona's directory waited on is no longer waited on | Nothing. If `<mark>` says the write failed, see [The retired-key record can't be read or is invalid](#the-retired-key-record-cant-be-read-or-is-invalid) |
| `[slack] spawnForPersona: "<name>" (key=<key>)'s key was recorded as retired while its reuse spawn's launch attempt was in flight (<how>) — the reuse timed out but launched; its life is the old life: no mark is set (b.jg5 SRJ-407, SRJ-806)` | A confirmed change recorded the key during the timed-out launch, so the row it started is treated as the old life and replaced | Nothing |

### A persona's session stops answering

When a refused call acts on the persona's session itself, the persona's
destination may also get a *Not answering*, *Still not answering* or
*Answering again* notice. What they mean, when each is posted, their log
lines and what to check are under
[A persona posts a Not answering notice](#a-persona-posts-a-not-answering-notice).

### agent-director can't report a persona's state

When the server checks whether a persona's instance is still running and
agent-director can't say (it answers with an error, times out, reports a
state the server doesn't know, or the check itself fails), the server reads
the persona's state as unknown, never as dead. It leaves the instance as it
is: nothing is reconnected, killed or relaunched, and nothing counts toward
the restart limit. The health check skips the persona for that check and
tries again at the next one. A restart that meets it stops there and hands
the persona to the retries above (`armed (<cause>)`, then the
`liveness-unknown` reason), so once agent-director answers again the persona
is recovered with no server restart. `<cause>` is `unavailable` when
agent-director timed out, couldn't be reached or gave an error name this
agent-director client doesn't recognise, `config` when it refused its config
file (`ErrConfigMalformed`, which also posts a notice: see **agent-director
refuses its config file** above), and `read-error` for any other error (an
internal error, for example), an error the server can't classify (see
**agent-director returns an error the server can't classify** above), a
state the server doesn't know, or a check that itself failed. Only a state
that reads the instance dead (`ended`,
`missing`, no row, or the agent-director binary gone) leads to a relaunch;
a restart's kill that then finds the binary still gone is refused, and
nothing is relaunched. Inside a restart, an internal error or a store
agent-director can't open also counts toward the persona's episode under
**agent-director returns an error the server can't classify** above.

All of one persona's lines of this kind (replace `ops_bot` with the key):

```sh
grep -h -E 'persona=ops_bot( |:|$)' "$STATE"/server.log.* "$STATE"/server.log 2>/dev/null | grep -E 'read as unknown|iveness unknown|arming the retry timer|reads pending after escalate-dead|the pending deferral failed' | sort
```

| Line | Meaning | What to do |
|---|---|---|
| `[slack] isSessionAlive: status error for persona=<key>: <error> — read as unknown, not dead` | agent-director answered the state check with an error (see [The server log](#the-server-log), Error detail): it timed out, was unreachable, reported an internal or configuration error, or gave an error the server doesn't know. The persona's state is read as unknown. For `ErrConfigMalformed` (agent-director refuses its config file) the line comes at every check, and the notice and its one `outage-state: ad-config-malformed raised` line come with the first. A lost message's one check with agent-director (see `starting` in the `No live session` row under [Other lines you may see](#other-lines-you-may-see)) logs it too; that message's notice then reports another state, never `starting`, and the check starts no retries, except for `ErrConfigMalformed`, which raises its notice and starts them as from any check, so the notice reports `not answering`. | Nothing while it passes. For `ErrConfigMalformed`, see **agent-director refuses its config file** above. If it repeats otherwise, see **It keeps reading unknown** below. |
| `[slack] isSessionAlive: status answered a state CSCB does not know for persona=<key> — read as unknown, not dead` | agent-director reported a row state this server version doesn't know. Read as unknown, never as dead. | If it repeats, the installed agent-director may be newer than this server expects: report it as a bug, with the persona's lines and `agent-director version`. |
| `[slack] health-check: liveness unknown for persona=<key>[ (isSessionAlive failed: <error>)] — skipping it this tick; not read as dead` | The health check couldn't learn the persona's state (` (isSessionAlive failed: <error>)` when the check itself failed), so it skipped the persona for this check: nothing restarted, nothing posted. It counts as a fresh start for the two-checks-in-a-row rule. | Nothing. The next check tries again. |
| `[slack] Liveness unknown for persona=<key>[ (isSessionAlive failed: <error>)] — no reconnect, kill or launch; nothing counted` | A restart couldn't learn the persona's state, so it did nothing and counted nothing. The persona's retries take over (`unavailable-retry: persona=<key> armed (<cause>) …`, `<cause>` as above, unless they were already waiting). | Nothing while the retries run. |
| `[slack] Liveness unknown after escalate-dead for persona=<key>[ (isSessionAlive failed: <error>)] — no relaunch in this restart run; nothing counted` | After finding the instance's session dead and asking agent-director to reap its row, the restart checked the state again and agent-director couldn't report it. Nothing is relaunched or counted; the retries take over. | Nothing while the retries run. |
| `[slack] Session reads pending after escalate-dead — its session has not started; no relaunch in this restart run for persona=<key>` | That second check found a row whose session hasn't started yet, so nothing is relaunched over it. The `Deferring persona=<key>` line follows, and it decides as there: the persona's own launch is watched, an old one is replaced. The retries record it as still starting. | Nothing, unless it repeats for many minutes: then see the `Deferring persona=<key>` line in [A persona's instance runs but isn't connected](#a-personas-instance-runs-but-isnt-connected). |
| `[slack] Session re-probe after escalate-dead read an unhandled kind "<kind>" — no relaunch in this restart run for persona=<key>; nothing noted` | After finding the instance's session dead and asking agent-director to reap its row, the restart checked the state again and got a reading this server version has no handling for. Nothing is killed, relaunched, counted or noted; the next health check tries again. | Report it as a bug, with the persona's lines. |
| `[slack] restart: arming the retry timer failed for persona=<key>: <error>` | An internal error handing the persona to its retries after an unknown state. Nothing was done to the instance; the next health check tries again. | Report it as a bug, with the persona's lines. |
| `[slack] restart: the pending deferral failed for persona=<key>: <error>` | An internal error handing a still-starting instance (its row reads pending) to its deferral. Nothing was done to the instance and nothing counted; the next health check tries again. | Report it as a bug, with the persona's lines. |

**It keeps reading unknown.** Check that agent-director answers, and what it
reports for the persona:

```sh
agent-director version
agent-director get --claude-instance-id cscb_<key>
```

If agent-director doesn't answer, or answers with an error, fix it (the
`install-cscb` skill diagnoses it); the next retry recovers the
persona with no server restart. An error naming `ErrConfigMalformed` is
agent-director refusing its config file: see **agent-director refuses its
config file** above, and don't edit the file. If it answers normally but the lines keep
coming, report it as a bug, with the persona's lines.

### A kill that is tried again

When the server stops an instance whose state it last read as running (a
launch replacing the persona's row, or a start's clean-up of a leftover
instance) and agent-director can't do it right now, the kill is tried up to
3 times, 2 s apart, before its result stands. Before each further try the
server reads the instance's state once: an instance already gone ends the
tries as a success. A kill refused for any other reason (a session conflict,
an unusable session name, a config-file refusal, tmux not available, an error
the server can't classify) is not tried again. A restart's kill, which comes
after the instance read as gone, is made once. Only the result that stands
counts: a kill that succeeds on a later try starts no retries and no *Not
answering* notice. At a start, once one instance has used its 3 tries
without success, every later kill in that start is made once, so a stuck tmux
holds a start up by at most one instance's tries.

Every try and every read between tries for one instance (replace
`cscb_ops_bot` with the instance id the lines name):

```sh
grep -h -E '(kill try [0-9]+ of [0-9]+|status read before kill try [0-9]+|kill tries) for cscb_ops_bot' "$STATE"/server.log.* "$STATE"/server.log 2>/dev/null | sort
```

`<site>` is `killSession (restart adapter)`, `spawnForPersona`,
`reconcileOrphans`, `old-life-wait for <ref>` for an old instance the
server is ending (see [An old instance the server is ending](#an-old-instance-the-server-is-ending)), whose tries can also end with
`kill tries for <id> end before try <n>: the old-life hold ended …` when
agent-director read that instance finished meanwhile, or
`teardownBots: persona "<name>" (key=<key>)` for the force-kill of
`stop --stop-bots` and `clean_restart`; `<outcome>` says how the try went, as in the
`killSession (restart adapter): kill for persona=<key>` line above.

| Line | Meaning | What to do |
|---|---|---|
| `[slack] <site>: kill try <n> of <max> for <id>: <outcome>[ (names a surviving pid)] — trying again in 2 s, after a status read of the row (b.jg5 SRJ-702)` | agent-director couldn't stop the instance on this try (it was busy, timed out, or reported that it couldn't stop the session); the server tries again in 2 s. Nothing is retried or posted for it yet. ` (names a surviving pid)`: agent-director's answer names a process of the session, other than the Claude process, that outlived the kill; no later try checks that process again. | Nothing: wait for the tries' outcome, the next lines for `<id>`. |
| `[slack] <site>: kill try <n> of <max> for <id>: <outcome> — the tries end in this success (b.jg5 SRJ-702)` | The kill succeeded on this try, and the step after it (a relaunch, a fresh launch, or the next instance of a start's clean-up, which keeps the row) goes on. | Nothing. |
| `[slack] <site>: kill try <n> of <max> for <id>: <outcome> — not tried again (only UNAVAILABLE is); this outcome stands (b.jg5 SRJ-702)` | agent-director refused the kill for a reason a second try wouldn't change (`class=CONFLICT`, `UNUSABLE_NAME`, `CONFIG`, `ENVIRONMENT` or `UNCLASSIFIED` in `<outcome>`). `ENVIRONMENT` right after the server stopped the last instance on a tmux server can mean that tmux server is shutting down. | Follow the lines after it for that class: the *Held:* entries, **tmux isn't available**, **agent-director refuses its config file** or **agent-director returns an error the server can't classify** above. |
| `[slack] <site>: kill try <n> of <max> for <id>: <outcome>[ (names a surviving pid)] — the row was not last read live, so it gets one try; this outcome stands (b.jg5 SRJ-702)` | The kill couldn't be carried out, and the server had not last read the instance as running (a restart's kill, made after agent-director answered that its own install had disappeared, for example), so a second try would prove nothing. | Follow the lines after it, such as `Session kill for persona=<key> did not succeed`. |
| `[slack] <site>: kill try <n> of <max> for <id>: <outcome>[ (names a surviving pid)] — no tries left; this outcome stands (b.jg5 SRJ-702)` | The third try failed too. The kill did not succeed: nothing is launched over the instance, its row is kept, and for a running persona its retries start (see the `armed (<cause>)` line above). When agent-director reported that it couldn't stop the session, a *Kill failed* notice follows (see [A persona posts a Kill failed or Process outlived kill notice](#a-persona-posts-a-kill-failed-or-process-outlived-kill-notice)). | Follow the lines after it. If it repeats, see **It never clears** above. |
| `[slack] reconcileOrphans: kill try 1 of 1 for <id>: <outcome>[ (names a surviving pid)] — this start pass's retries are spent (one row already used its tries on UNAVAILABLE), so it gets one try; this outcome stands (b.jg5 SRJ-702)` | At a start, an earlier leftover instance used its 3 tries without success, so this one's kill was made once, to keep the start from waiting on a stuck tmux. A kill that didn't succeed keeps the instance's row and is recorded in `startup-errors.log` (`orphan-cleanup`); the next start tries it again. | Check that tmux answers for the user the workers run as, with the read-only commands under [A persona posts a Not answering notice](#a-persona-posts-a-not-answering-notice); the next start cleans the instance up once it does. |
| `[slack] <site>: status read before kill try <n> for <id>: <answer> — the row is finished: the tries end as a success with no further kill (b.jg5 SRJ-702)` | Between tries, agent-director reported the instance finished (`state=ended`, `state=missing`) or gone (`no row (ErrSpawnNotFound)`): the kill counts as a success and the next step goes on. | Nothing. |
| `[slack] <site>: status read before kill try <n> for <id>: the read latched the persona — no further kill (no call is made for a latched persona); the last try's outcome stands (b.jg5 SRJ-702)` | Reading the instance between tries put the persona on hold (its *Held:* notice follows), so nothing more is called for it. | See the *Held:* entry the persona's notice names. |
| `[slack] <site>: status read before kill try <n> for <id>: failed: <failure> — the row was last read pending: no further kill while agent-director's config is unreadable; the last try's outcome stands (b.jg5 SRJ-702)` | Between tries agent-director refused its config file, and the instance was last read as still starting, so it is not killed while that lasts. | See **agent-director refuses its config file** above. |
| `[slack] teardownBots: persona "<name>" (key=<key>): status read before kill try <n> for <id>: failed: <failure> — the row was last read <state>, and this caller ends the tries on any CONFIG read: no further kill while agent-director's config is unreadable; the last try's outcome stands (b.jg5 SRJ-702)` | `stop --stop-bots` or `clean_restart` only: between force-kill tries agent-director refused its config file, so no further force-kill is made, whatever the instance was last read as. The persona fails as CONFIG. | See **agent-director refuses its config file** above, then see [`stop --stop-bots` or `clean_restart` could not stop a persona](#stop---stop-bots-or-clean_restart-could-not-stop-a-persona). |
| `[slack] <site>: status read before kill try <n> for <id>: failed: <failure> — the row was last read <state>: the try goes ahead (b.jg5 SRJ-702)` | Between tries agent-director refused its config file; the instance was last read running (`<state>`), so the next try is made. | See **agent-director refuses its config file** above. |
| `[slack] <site>: status read before kill try <n> for <id>: <answer> — the try goes ahead (b.jg5 SRJ-702)` | Between tries the instance still read running (`state=<state>`), or the read failed for another reason (`failed: <failure>`); the next try is made. | Nothing: wait for the tries' outcome. |
| `[slack] <site>: kill tries for <id> stop before try <n>: <why> — no further kill; the last try's outcome stands (b.jg5 SRJ-702)` | The tries stopped early. `<why>`: `the caller's keep-going check answered false` (the persona was put on hold, removed or is no longer up, or the server is stopping) or `the wait between tries failed` (an internal error). | For a hold, see the *Held:* entry; for a removal or a stopping server, nothing. `the wait between tries failed`: report it as a bug, with the persona's lines. |
| `[slack] <site>: kill tries for <id> ended (<end>) after <n> kill(s) and <m> read(s): <outcome> — alert=<none\|survivor\|ordinary> (b.jg5 SRJ-702)` | The summary of a kill that took more than one call, or whose tries met agent-director's report that it couldn't stop the session. `<outcome>` is the result that stands. `alert=` records which kind of human alert the tries call for: `survivor` (the kill ended as a success, but an earlier try named a surviving process: a *Process outlived kill* notice) or `ordinary` (agent-director couldn't stop the session: a *Kill failed* notice), or `none`. The notice, or the entry or line that stands in for it, comes after this line. | Nothing for `none`. Otherwise see [A persona posts a Kill failed or Process outlived kill notice](#a-persona-posts-a-kill-failed-or-process-outlived-kill-notice); the tries' lines above it for `<id>` quote agent-director's answer. |
| `[slack] reconcileOrphans: the status read between kill tries for instanceId=<id> answered CONFIG; the row names no persona of the applied configuration, so no outage is raised — logged only (b.jg5 SRJ-110, SRJ-316)` | At a start, agent-director refused its config file while the server was reading a leftover instance (a removed persona's, or one from before personas) between its kill's tries. No persona's notice is raised for it. | See **agent-director refuses its config file** above. |


**In `stop --stop-bots` and `clean_restart`.** Their force-kill writes the
same try, read and end lines with the prefix
`[slack] teardownBots: persona "<name>" (key=<key>)`, on the terminal for
`stop --stop-bots` and in `clean_restart.log` for `clean_restart`, never in
`server.log`. Only `class=UNAVAILABLE` is tried again; a GONE answer is not
tried again and fails the persona. A read between tries latches nothing:
one that fails lets the try go ahead, and a CONFIG answer ends the tries,
whatever state was last read (`the row was last read pending: no further kill …`,
or `the row was last read <state>, and this caller ends the tries on any CONFIG read: …`;
then `ended (read-config)`), and fails the persona as CONFIG. The `ended (<end>) … alert=<…>` line's
`alert=` value says which notice text the command prints for the persona
(see
[`stop --stop-bots` or `clean_restart` could not stop a persona](#stop---stop-bots-or-clean_restart-could-not-stop-a-persona)).

---

## A server start's clean-up of old instances

At every start, before any persona is brought up, the server lists every
CSCB instance agent-director has and cleans up the ones it doesn't run: an
instance of a persona that is not in the applied configuration, one whose
instance id is not `cscb_<key>`, one in another directory than its
persona's `working_directory`, and one left from a build before personas (no
`persona` label). Only a running instance (any live state, `pending`
included) is stopped; a finished one is left as it is. The server checks the
result of every kill and never deletes an agent-director row: every row is
kept, and a removed persona's row or one from before personas stays until
agent-director's `expire` removes it, never resumed. A persona held at that
start keeps its instances (see its *Held:* entry).

The clean-up also tracks each instance that may still be running in a
directory: a running instance of a retired key (a removed persona's, or a
changed persona's old instance), and any instance whose kill did not
succeed. The server tracks it until agent-director reads its row finished
(`old-life hold:` lines). This tracking lives in the server's memory, so
each start's clean-up picks it up again.

After the kills, one `find-missing` run asks agent-director which of the
stopped instances are gone, and one summary line ends the clean-up. A stop
that begins during the start ends it early (see
[Found while the server was running](#found-while-the-server-was-running)).

A start's clean-up lines and entries (read-only):

```sh
STATE="${SLACK_STATE_DIR:-$HOME/.claude/channels/slack}"
grep -h 'reconcileOrphans: ' "$STATE"/server.log.* "$STATE"/server.log 2>/dev/null | sort
grep -h -E '\[orphan-cleanup\]|\(start sweep\)' "$STATE/startup-errors.log"
grep -h 'old-life hold: ' "$STATE"/server.log.* "$STATE"/server.log 2>/dev/null | sort
```

`<row>` is `orphan instanceId=<id> persona=<persona>` for an instance with a
`persona` label and `pre-persona row instanceId=<id>` for one from before
personas. Each kill's tries log their own lines (see
[A kill that is tried again](#a-kill-that-is-tried-again)).

| Line | Meaning | What to do |
|---|---|---|
| `[slack] old-life hold: began on "<real path>" for oldKey=<key> (instanceId="<id>"): the start sweep listed it live while its key is recorded as retired without the "new life has begun" mark — the old life may still be running (b.jg5 SRJ-809)` | The start found a running instance (`pending` included) of a key recorded as retired whose new conversation hasn't begun, and tracks it in the directory it runs in (`<real path>`) until agent-director reads it finished. Logged before any instance is stopped, whether the clean-up then stops it, keeps it or leaves it for a held persona. After a restart, this is how the server picks up the tracking a confirmed change began. | Nothing. |
| `[slack] reconcileOrphans: sweeping row (<reason>) persona=<persona> instanceId=<id> state=<state>[ cwd=<cwd>] — <it is live, so it is killed; the row is kept\|it is finished, so it is not killed (a finished row is never killed); the row is kept> (b.jg5 SRJ-714)` | An instance the start doesn't keep running: `<reason>` is `absent persona` (its persona isn't in the applied configuration), `wrong instance ID` or `wrong cwd`. A running one is stopped next; a finished one is left as it is. | Nothing. |
| `[slack] reconcileOrphans: killing <row> state=<state> tmux_session=<session>; the row is kept whatever the outcome (b.jg5 SRJ-714)` | The server is stopping this running instance. | Nothing: its outcome follows. |
| `[slack] reconcileOrphans: kill succeeded for <row> (<outcome>) — row kept` | The instance was stopped; its row is kept. `<outcome>` says how (`outcome=killed kill_sent=…`, `outcome=row-gone …`, `outcome=session-gone …`, or `outcome=row-finished read=…` when a read between tries found it already finished). When an earlier try named a surviving process, a `persona-kill-survivor` entry, `instanceId=<id> (start sweep): <text>`, follows. | Nothing, unless that entry is there: see [A persona posts a Kill failed or Process outlived kill notice](#a-persona-posts-a-kill-failed-or-process-outlived-kill-notice). |
| `[orphan-cleanup] kill did not succeed for <row> state=<state> tmux_session=<session>: <outcome>; row kept, its session may still be running` (in `startup-errors.log`) | The kill did not succeed after its tries; the row is kept and the session may still run. `<outcome>` names the class. Nothing is held and no retries start: a session conflict or an unusable session name met here holds nobody, and an `ENVIRONMENT` or `CONFIG` class also raises the outage of a persona still in the configuration. With `; kill-failure alert: instanceId=<id> (start sweep): …` after it, agent-director couldn't stop the session: the *Kill failed* text. | The next start's clean-up tries the kill again. With the *Kill failed* text, see [A persona posts a Kill failed or Process outlived kill notice](#a-persona-posts-a-kill-failed-or-process-outlived-kill-notice). If the entry repeats start after start, check the row with `agent-director get --claude-instance-id <id>` and follow the "Operator actions" section of agent-director's README. |
| `[slack] old-life hold: began on "<real path>" for oldKey=<key> (instanceId="<id>"): its start-sweep kill did not succeed — the old life may still be running (b.jg5 SRJ-809)` | Follows the `orphan-cleanup` entry above when the instance wasn't already tracked: its session may still run, so the server tracks its directory. `oldKey` is the instance id itself (quoted) for an instance from before personas or one under another instance id than its persona's. | As for that entry. |
| `[slack] reconcileOrphans: kill tries for <row> (start sweep) were stopped: the server is shutting down; its last outcome's class: <class>; no kill-failure alert is raised; <descriptions> (b.jg5 SRJ-702, SRJ-714)` | The server began stopping during this kill's tries, so no further try was made. The row is kept, and its `orphan-cleanup` entry says `its tries were stopped because the server is shutting down, so no kill-failure alert is raised`, with no *Kill failed* text. `<descriptions>` quotes agent-director's answers, a surviving process it named included. Nothing is posted to Slack. | Nothing: the next start's clean-up stops and checks the instance again. If `<descriptions>` names a surviving process, a human deals with it by pid, following "Operator actions". |
| `[slack] reconcileOrphans: kill tries for <row> (start sweep) were stopped: the version re-check decided that the server stops; row kept; the sweep makes no further call; its last outcome's class: <class>; no kill-failure alert is raised; <descriptions> (b.jg5 SRJ-702, SRJ-714, SRJ-205)` | A clean-up kill answered `ErrInvalidFlags`, the version re-check found a binary the server can't run with, and the server stops. The row is kept, its `orphan-cleanup` entry (its `<outcome>` showing `recheck=stop`) carries no *Kill failed* text, and no later instance is stopped. `<descriptions>` quotes agent-director's answers, an earlier try's surviving process included. This is the clean-up's only stop line: no `the server began shutting down — the sweep stops` line follows, only the summary. Nothing is posted to Slack. | See [Found while the server was running](#found-while-the-server-was-running). If `<descriptions>` names a surviving process, a human deals with it by pid, following "Operator actions". |
| `[slack] reconcileOrphans: the server began shutting down — the sweep stops: no further kill, status read, findMissing or get, and no further latch, record write or clear; what it did stands, and the rows it left unkilled count as kept (b.jg5 SRJ-714, SRJ-205)` | The server began stopping while the clean-up ran (logged once, right before the summary, also when the `find-missing` run then failed or the stop came while personas' rows were read after it). It makes no further agent-director call and acts on no answer that comes in after it: no persona is held, no outage is raised and nothing is cleared. What it did stands, and every row is kept. Its summary line follows. | Nothing. For a stop by the version re-check, see [Found while the server was running](#found-while-the-server-was-running). |
| `[slack] reconcileOrphans: the <class> answer to the <call> for persona=<key> came after the sweep stopped — no outage is raised (b.jg5 SRJ-714)` | A clean-up kill (`<call>` `kill`) answered `ENVIRONMENT` or `CONFIG`, or the read between its tries (`<call>` `status read between kill tries`) answered `CONFIG`, after the clean-up had stopped, so the persona's tmux or config-file outage is not raised. | Nothing: the server is stopping. If the class repeats at the next start, it is raised then. |
| `[slack] reconcileOrphans: post-sweep get for persona=<key>: the get settled after its caller stopped — not acted on: no latch, clear or episode end (b.jg5 SRJ-714)` | The read of a persona's row after the `find-missing` run came back once the server had begun stopping, so nothing was done with it: the persona is not held and nothing is cleared. The reads' line shows `persona=<key> not acted on (its caller stopped)`. | Nothing. |
| `[slack] reconcileOrphans: raising the outage for persona=<key> failed: <error>` | An internal error raising a persona's tmux or config-file outage after a clean-up kill answered `ENVIRONMENT` or `CONFIG`; the row is kept and recorded all the same. | Report it as a bug. |
| `[slack] reconcileOrphans: findMissing sweep for the rows the start sweep killed — count=<n> ids=[…] unverified=<n> unverified_ids=[…]` | The `find-missing` run after the kills, over every instance the start tried to stop. | Nothing. |
| `[slack] reconcileOrphans: after the findMissing sweep for the rows the start sweep killed — no post-sweep get is made: its caller stopped (b.jg5 SRJ-120, SRJ-714)` | The server began stopping during that run, so no persona's row is read after it. | Nothing. |
| `[slack] reconcileOrphans: findMissing after the kills of <n> row(s): missing=<n> [<ids>] still-live=<n> [<ids>] not-judged=<n> [<ids>] — a row that still reads live is killed again by the next start's sweep when it sweeps it; a not-judged row was pending and not judged by this run (retry later)` | Which stopped instances agent-director now reads as gone (`missing`), which still read running (`still-live`, stopped again by the next start), and which were still starting (`pending`) and not judged this time (`not-judged`, no fault: looked at again at the next start). | Nothing, unless the same rows stay `still-live` start after start: then check them with `agent-director get --claude-instance-id <id>` and follow the "Operator actions" section of agent-director's README. |
| `[slack] reconcileOrphans: findMissing after the kills of <n> row(s) failed — each reads as it did, and a live one is killed again by the next start's sweep when it sweeps it` | The `find-missing` run failed (its own failure line comes first). The start goes on. | Nothing, unless it repeats: then check that agent-director answers (`agent-director version`). |
| `[slack] old-life hold: ended on "<real path>" for oldKey=<key> (instanceId="<id>"): <reason>[ (<read>)]; waiting personas: <keys\|none> (b.jg5 SRJ-809)` | The server stopped tracking an instance because agent-director reads it finished: the `find-missing` run listed it (`a find-missing run listed the old row in its ids`, read `reconcileOrphans: findMissing sweep`), or a read of its row found it `ended` or `missing` (`reconcileOrphans: start sweep list` for the start's listing, `reconcileOrphans: status read between kill tries` for a read between a kill's tries). A kill alone never ends it, whatever it answered, so an instance the kill stopped stays tracked until such a read. | Nothing. |
| `[slack] old-life hold: began again on "<real path>" for oldKey=<key> (instanceId="<id>"): <cause> — one hold is kept, on its held directory (b.jg5 SRJ-809)` | The server was already tracking this instance. It keeps one record of it, still in the directory it already had (the one the line names), with the new cause; a directory the persona declares does not move it, because the old row's real directory wins. Only a later read of the row showing another directory moves it. | Nothing. |
| `[slack] old-life hold: an end observer failed for instanceId="<id>": <error> (b.jg5 SRJ-809)`, `[slack] reconcileOrphans: beginning the old-life hold of instanceId=<id> failed: <error> (b.jg5 SRJ-809)`, `[slack] reload: beginning the old-life hold of <id> failed: <error> (b.jg5 SRJ-809)`, `[slack] old-life hold: noting the read of instanceId=<id> failed: <error> (b.jg5 SRJ-809)`, `[slack] old-life hold: ending the hold of persona=<key> for its new life failed: <error> (b.jg5 SRJ-809)`, `[slack] old-life hold: marking instanceId=<id> kill-failed failed: <error> (b.jg5 SRJ-812)` | An internal error tracking an old instance. The start, change or read went on. | Report it as a bug, with the lines around it. |
| `[slack] reconcileOrphans: summary — listed=<n> killed=<n> kept=<n> (kill-failed=<n>) recorded-as-retired=<n> left-unkilled-for-latch=<n> (b.jg5 SRJ-714)` | The clean-up's last line. `listed`: every instance it read. `killed`: instances it stopped. `kept`: instances left running or finished as they were (finished ones, ones the persona keeps, ones whose directory check waits for the persona's launch, kills that didn't succeed, and any left after a stop), `kill-failed` of them the kills that didn't succeed. `recorded-as-retired`: keys of personas no longer configured that it recorded as retired (see [Added again or renamed back](#added-again-or-renamed-back)). `left-unkilled-for-latch`: instances of held personas. | Nothing. With `kill-failed` above 0, read the `orphan-cleanup` entries. |

---

## An old instance the server is ending

An old instance may still run in a persona's working directory: a removed
or renamed persona's, the earlier instance of a persona changed
destructively, or one whose kill at a start did not succeed. The server
tracks it until agent-director reads it finished (`old-life hold:` lines,
see [A server start's clean-up of old instances](#a-server-starts-clean-up-of-old-instances)).
To end it, the server makes the same checked kills and `find-missing`
checks it uses when it replaces a persona's instance, on the old instance
only, and launches nothing in its place. These are its `old-life-wait` lines.
A persona waits on such an instance when its working directory is the one
tracked, or when the old instance is its own earlier one.

**What the server does.**

- Everything is reported under the old instance's name, `persona=<old key>`,
  or `instanceId=<id>` for an instance from before personas or under another
  instance id. Nothing about the old instance is posted to Slack: its
  entries and lines are in the logs only. A session conflict or an unusable
  session name met here holds nobody. There are two exceptions, both a
  waiting persona's own notice:
  - *tmux unavailable* and *agent-director refuses its config file*, which
    the server posts for each waiting persona when it meets them here;
  - when the old instance is a configured persona's own earlier one, a read
    of its row can hold that persona, with its *Held:* post, as any read of
    a persona's own row can.
- A kill whose tries end in a success with nothing ended (`kill_sent=false`)
  or that answers a session conflict ends nothing by itself: only
  agent-director reading the old instance finished ends the tracking.
- When a round ends with the old instance still tracked, each persona that
  waits on it, is not held and is up gets its retries (`armed (held-for-old-life)`), never counted
  toward the restart limit. A waiting persona that is held for a human, held
  because agent-director rejected its launch flags, or not up gets none, with
  one line saying which, and is not retried when the old instance ends. The old instance's own name never gets retries
  and is never launched.
- `tmux isn't available` or `agent-director refuses its config file` met
  here raises that notice for each persona waiting on the old instance. Each
  later call here that agent-director answers clears the *agent-director
  refuses its config file* notice for them. The *tmux unavailable* notice is
  not cleared here, because clearing it would stop the retries the waiting
  persona is held on; it clears through the persona's own calls once the
  old instance is no longer tracked.
- When the old instance is a configured persona's own earlier one and that
  persona is held, the server makes no kill and no call on it. If a read
  between kill tries holds that persona, the round ends there: the old
  instance stays tracked, the waiting personas get their retries, the
  round's entries are kept, and when the kill had failed it counts as a
  failed kill (`the hold is marked kill-failed`). If that persona is held
  between the kill's tries any other way, the tries stop: one line naming
  `its old-life wait was stopped: the persona whose own row it is latched`,
  and no `persona-kill-failed` entry (the persona's *Held:* notice is what
  to follow).
- When a server start's clean-up lists the old instance `pending` (still
  starting), the first round starts from that reading: while
  *agent-director refuses its config file* is raised, it makes no kill and
  no call, and the round ends `a CONFIG answer, or no kill of a row last
  read pending while agent-director refuses its config file`, the waiting
  personas getting their retries.
- Otherwise the kill keeps its tries until the server stops: a waiting
  persona being held (on another instance) or not being up never stops it.
  When agent-director reads the old instance finished while the kill is
  still being tried, the tries end as a success, and no further kill is
  made, even if the server has started tracking the same instance again
  meanwhile.
- The *Kill failed* text names the old instance's tmux session as
  agent-director last read it, else as a server start's clean-up listed it,
  else `slack_bot_<key>` for a persona's own earlier instance, else
  `"unknown"`.
- An error the server can't classify is reported once per tracked old
  instance, as for a persona: nothing for the first round that meets it, one
  `persona-unclassified-error` entry from the first round that still meets
  it past the alert threshold, and none after, until the old instance is no
  longer tracked.
- While one of these steps runs, a retry of a waiting persona makes no
  agent-director call (`old-life-wait-in-flight`), the health check makes no
  attempt for it, and a message lost for it reports `restarting`. Once the
  old instance's kill has failed (the *Kill failed* text in its
  `persona-kill-failed` entry, or its teardown's or a start's clean-up's),
  a message lost for a waiting persona reports `kill failed`, until
  agent-director reads the old instance finished.

**Read-only checks.** Its lines, its entries and the old instance's row:

```sh
STATE="${SLACK_STATE_DIR:-$HOME/.claude/channels/slack}"
grep -h -E 'old-life-wait|old-life hold: |\(old-life form\)' "$STATE"/server.log.* "$STATE"/server.log 2>/dev/null | sort
grep -h -E '\(old-life wait\)|raised during its old-life wait|\[persona-unclassified-error\] (persona|instanceId)=' "$STATE/startup-errors.log"
agent-director get --claude-instance-id <id>
```

The steps' own lines are the replacement's, `[slack] live-row-sequence:
<ref>: …`, its start line reading `no launch (old-life form)` and
`alert context old-life wait` (see
[Other lines you may see](#other-lines-you-may-see)); the kill's tries are
headed `[slack] old-life-wait for <ref>` (see
[A kill that is tried again](#a-kill-that-is-tried-again)).

| Line | Meaning | What to do |
|---|---|---|
| `[slack] old-life-wait: <ref> (instanceId=<id>): ended — <what ended it>; <the hold goes on\|the hold is over\|nothing more>[; the hold is marked kill-failed]; waiting personas armed (held-for-old-life): <keys\|none> (b.jg5 SRJ-811)` | One round of the steps ended. `<what ended it>`: `the old row is finished` or `its hold ended while it ran (a success, as a finished read is)` (the old instance is gone; `the hold is over`); `stopped (a shutdown, or the teardown of the last persona waiting on its hold)` (`nothing more`); `the row's own persona is latched (a read of the row latched it, or it was latched already)` (the persona is held, see its *Held:* notice; `the hold is marked kill-failed` follows when its kill had failed); `the old key's kill failed (the ordinary kill-failure alert)` or `the old row stayed live after runs that judged it (the ordinary kill-failure alert)` (with `the hold is marked kill-failed`: a `persona-kill-failed` entry carries the *Kill failed* text); `a CONFLICT or an unusable recorded name was met; nothing latches`; `a run did not judge the pending old row; no alert` (it was still starting); `an UNAVAILABLE answer`, `an ENVIRONMENT answer (tmux-unavailable is raised for the waiting personas)`, `a CONFIG answer, or no kill of a row last read pending while agent-director refuses its config file` or `an UNCLASSIFIED answer`; `a get or a run failed` (a read or run failed for a reason other than those four answers, which name the failed call's answer instead) or `a dependency failed`. `<keys>`: the waiting personas whose retries were started. | Nothing while the hold goes on and agent-director answers. After `the hold is marked kill-failed`, see the `persona-kill-failed` entry below. `a dependency failed`: report it as a bug, with the lines around it. |
| `[slack] old-life-wait for <ref>: kill tries for <id> end <before try <n>\|after try <n>>: the old-life hold ended (another call read the old row finished) — the tries end as a success with no further kill or status read (b.jg5 SRJ-702, SRJ-811)` | Another read found the old instance finished while its kill was being tried: no further kill, and no *Kill failed* text. A *Process outlived kill* entry follows when an earlier try named a surviving process. | Nothing, unless that entry is there. |
| `[slack] <site>: <persona> waits on the old-life wait running on its own row — its retry timer is armed (held-for-old-life) (sequence-waiting; b.jg5 SRJ-811)` | A launch of the persona was asked for while the server is ending its own earlier instance: nothing was launched, its retries were started and, if it is still configured, it is retried once that instance ends (see [A persona waiting on an old instance](#a-persona-waiting-on-an-old-instance)). `… its retry timer could not be armed …` when they could not be; `… its retry timer is not armed: the step skips this persona, as the line before says …` when the persona is held, latched, not up or no longer configured (the line before it says which; nothing failed). | Nothing. |
| `[slack] old-life-wait: persona=<key>: not in the applied configuration — no retry timer armed (b.jg5 SRJ-1512, b.av2 SR-8.6)` | The persona is no longer configured, so it gets no retries. | Nothing. |
| `[slack] old-life-wait: <get\|status read between kill tries> for <ref>: <error> — UNUSABLE NAME met in the old-life wait: routed to the server log; nothing latches (b.jg5 SRJ-512, SRJ-1002)` | agent-director could not use the recorded session name of the persona's own earlier instance. Nobody is held; a `persona-teardown-notice` entry follows. | As for that entry. |
| `[slack] old-life-wait: instanceId=<id>: no old-life hold is on it — no wait started (b.jg5 SRJ-811)`, `[slack] old-life-wait: instanceId=<id>: no sequence registry or wait bindings are installed — no wait started (b.jg5 SRJ-811)` | Nothing was started: the instance is no longer tracked, or the server was not set up yet. | Nothing; the second after startup: report it as a bug. |
| `[slack] old-life-wait: <ref>: raising the kill-failure alert failed: <error>`, `[slack] old-life-wait: raising the outage for persona=<key> failed: <error>`, `[slack] old-life-wait: persona=<key>: arming the retry timer failed: <error>`, `[slack] old-life-wait: the waiting personas of instanceId=<id> could not be read: <error> — none`, `[slack] old-life-wait: the end of the wait on instanceId=<id> could not be handled: <error>`, `[slack] old-life hold: stopping the wait on instanceId=<id> failed: <error> (b.jg5 SRJ-811)`, `[slack] old-life-wait: <ref>: the old-life wait never launches its old key — no launch (b.jg5 SRJ-811, SRJ-1512)` | An internal error. | Report it as a bug, with the lines around it. |
| `[slack] old-life-wait: <ref>: the kill-failure alert's <version> version is not raised — no kill-failure alerts are installed; …`, `[slack] old-life-wait: <ref>: no unclassified-error episodes are installed — the UNCLASSIFIED answer is not reported (b.jg5 SRJ-313, SRJ-811)` | Seen only in tests and development runs. | Nothing. |

Its `startup-errors.log` entries (none is posted):

| Entry | Meaning | What to do |
|---|---|---|
| `[persona-kill-failed] <ref> (old-life wait): <text>` | The *Kill failed* text, with its log-only last sentence: agent-director could not end the old instance after its tries, or it still read running after `find-missing` checks that judged it. | A human checks the instance, following the "Operator actions" section of agent-director's README. |
| `[persona-kill-failed] <ref> (old-life wait): the kill-failure ordinary alert not raised — its tries were stopped (its old-life wait was stopped: the server is shutting down)…` (or `… (its old-life wait was stopped: the last persona waiting on its hold was torn down)…`) | The server stopped, or the last persona waiting on the old instance was removed or changed, while the old instance's kill was being tried; no *Kill failed* text. A stop by the latch of the persona whose own earlier instance it is writes no entry, only its server-log line (`… (its old-life wait was stopped: the persona whose own row it is latched)…`). `(its old-life wait was stopped)` with no cause after it is a stop the server has no name for: report it, with the lines around it. Its `descriptions` quote agent-director's answers, a surviving process included. | Nothing: the next start's clean-up picks the instance up again. If a surviving process is named, a human deals with it by pid, following "Operator actions". |
| `[persona-kill-survivor] <ref> (old-life wait): <text>` | The *Process outlived kill* text: the old instance ended, but an earlier try named a process of its session that outlived the kill. | A human deals with the process by pid, following "Operator actions". |
| `[persona-teardown-notice] <ref>, raised during its old-life wait: agent-director kill of <id> refused at a try: <outcome>` (or `… at a status read between its tries: …`, or `agent-director <get\|find-missing> for <id> refused: class=<CLASS> …`) | A session conflict or an unusable session name met while ending the old instance. Nobody is held. | If it repeats, check the instance with `agent-director get --claude-instance-id <id>` and follow "Operator actions". |
| `[persona-unclassified-error] <ref>: <text>` | The *Unclassified agent-director error* text for an error met while ending the old instance, still met past the alert threshold; at most one while the instance is tracked. | See **agent-director returns an error the server can't classify** under [agent-director refuses a persona](#agent-director-refuses-a-persona-it-is-retried-on-its-own). |
| `[slack] persona-episodes: instanceId=<id> unclassified-error alert written to the server log and startup-errors.log (persona-unclassified-error) — the row is an old life the server is ending; <…>` | Logged right after that entry: the error was met while ending old instance `<id>`, so it is written, never posted, even when `<id>` is a configured persona's own earlier instance. The same episode's other lines start `[slack] persona-episodes: instanceId=<id> unclassified-error` too. | As for the entry above. |

### A persona waiting on an old instance

While an old instance may still run in a directory, the server brings no
persona up there, admits no Claude session from there and types nothing into
the old instance. A persona whose working directory it is waits: a renamed
persona's new name, a persona added in a removed persona's directory, or one
in the directory of an instance a start's clean-up could not stop. Its Slack
connection stays up; it is not launched and posts nothing about the wait.
Each launch or restart of it makes no agent-director call, starts the steps
above on the old instance if they aren't running, and starts its retries
(`armed (held-for-old-life)`), never counted toward the restart limit. A
persona already running when its directory became tracked is left running:
it is not reconnected, killed or relaunched until the old instance ends; a
still-starting instance of its own gets no check with agent-director and no
*Session not starting* notice meanwhile. It
comes up by itself once the server reads the old row ended or missing (after
a human acts, at its next retry); a renamed persona's new name then starts a
new conversation.

A persona whose own earlier instance is the old one (a start's clean-up
could not stop it) waits on it too: a launch refused while the server is
ending that instance, or a reconnect that would have typed into it, records
the persona as waiting. When the old instance ends, the other waiting
personas are retried at once, and this one as soon as the server has
stopped ending its instance, unless it was removed, held or stopped being
up meanwhile. If it
is removed while it is the last persona waiting, the server stops ending
the old instance.

A destructively changed persona whose own earlier instance is the old one is
not held back this way: its own replacement of the old instance ends it
first (see **Destructively modified persona** under
[A persona was added or removed by a confirmed change](#a-persona-was-added-or-removed-by-a-confirmed-change)).
A held persona (see its *Held:* entry, or its *Cannot launch* notice for
rejected launch flags) is not retried while it is held, and gets no retries
from the old instance's steps. Neither does a persona that is not up (its
Slack connection, credentials or working directory is not ready): its own
bring-up brings it up, and a restart of it ends before the old-instance
check, so it logs no `Skipping restart … held for an old life` line.

A message lost for a waiting persona reports `restarting` while the steps
above run, `kill failed` once the old instance's kill failed, and otherwise
the state that applies. A `starting now` notice for it means the restart the
message started does nothing while it waits: the persona comes up only once
the old instance has ended.

**Read-only checks.** Its lines, then the old instance's row (see
[Listing instances](#listing-instances)):

```sh
STATE="${SLACK_STATE_DIR:-$HOME/.claude/channels/slack}"
grep -h -E 'held for an old life|old-life hold: |old-life-wait|retrying now( \(pending-only\))? \(old-life-hold-ended\)' "$STATE"/server.log.* "$STATE"/server.log 2>/dev/null | sort
agent-director get --claude-instance-id <id>
```

| Line | Meaning | What to do |
|---|---|---|
| `[slack] <site>: not launching <ref> — its working directory "<path>" is held for an old life that may still be running (instanceId="<id>": wait <what>[, …]); waiting on it, its retry timer is armed (held-for-old-life); no agent-director call (sequence-waiting; b.jg5 SRJ-810, SRJ-1502)` | A launch of the persona (`<site>` `spawnForPersona`, `launchForLiveRowSequence` for a replacement's last step, `runRestartWork` for a restart, or `latch-recheck` for the check of a persona held by a conflict) was held back because the old instance `<id>` may still run in its directory. `<what>` is `started` (the steps above began on it), `running` or `already-running` (they were already running), or `closed`, `not-held` or `not-installed` (none started: the server is stopping, the instance stopped being tracked, or it wasn't set up yet). Its retries were started; `… its retry timer could not be armed …` when they weren't, `… its retry timer is not armed: the step skips this persona, as the line before says …` when the persona is held, latched, not up or no longer configured (the line before it says which; nothing failed), and `… its retry timer is not armed: it is latched, and its latch re-check retries it …` at `latch-recheck`, where the hold's own check tries again instead. At a start it is counted under `waiting on a live-row sequence`. | Nothing while the old instance's lines show it being ended. If its kill keeps failing (a `persona-kill-failed` entry above), a human follows the "Operator actions" section of agent-director's README for `<id>`; the persona then comes up with no restart. |
| `[slack] Skipping restart for persona=<key> — its working directory is held for an old life that may still be running; no agent-director call, nothing recorded (sequence-waiting; b.jg5 SRJ-810, SRJ-812)`, `[slack] Restart for persona=<key> goes no further <where> — its working directory is held for an old life that may still be running; nothing more is called for it, nothing recorded (sequence-waiting; b.jg5 SRJ-810, SRJ-812)` | A restart of the persona (a health check's, a retry's, or one a lost message started) did nothing: nothing was read, reconnected, killed or launched, and nothing counted. A running persona's worker is left as it is. With `(the old-life hook failed: <error> — taken as held)`, the server could not tell and held it to be safe. A restart while the server is stopping, or for a persona that is not up, ends before this check, so neither logs it. | Nothing. The `taken as held` form: report it as a bug. |
| `[slack] unavailable-retry: persona=<key> retry <n>: old-life-wait-in-flight — re-armed, next retry in <s> s` | A retry found the persona still waiting while the steps above ran; it retries later. | Nothing. |
| `[slack] reconnectMcp: <ref> — its own row instanceId="<id>" is held for an old life that may still be running: no send-keys; transient, nothing typed; its retry timer is armed (held-for-old-life) (b.jg5 SRJ-810)` (or `… its retry timer could not be armed …`, or `… its retry timer is not armed: the step skips this persona, as the line before says …` when the persona is held, latched, not up or no longer configured, the line before saying which) | A reconnect of the persona would have typed into its own earlier instance, which is the tracked old instance, so nothing was typed. If it is still configured, it waits on that instance and is retried once it ends. | Nothing. |
| `[slack] reconnectSession: persona=<key> is <state> and its own row is held for an old life — not typing /mcp reconnect into it; the live-row sequence replaces it (start answered <answer>); deferring (b.jg5 SRJ-810, SRJ-805)` | The persona's own instance is a tracked old instance a start's clean-up could not stop (it ran in another directory), so a restart replaces it instead of reconnecting it. `already-running` means the steps above are running on it; the persona waits for them. | Nothing. |
| `[slack] old-life hold: ended for instanceId="<id>" — retrying its waiting personas at once: <keys\|none>[; once the stopped wait on its own row has settled: <keys>][; not retried: <key> (<why>)[, …]] (b.jg5 SRJ-810)` | The old instance ended; each waiting persona still configured, not held and up is retried at once (`not applied`: removed meanwhile; `latched`: held for a human; `held on ErrInvalidFlags`: held until its launch flags are fixed; `not up`: its Slack connection or bring-up is not up, and its bring-up brings it up; `its retry failed: <error>`: report it as a bug). A `retrying now (old-life-hold-ended)` line follows for each, then its launch. `once the stopped wait on its own row has settled` names a persona whose own earlier instance was the old one: it is retried once the server has stopped ending that instance (the next line). | Nothing. |
| `[slack] old-life hold: the stopped wait on instanceId="<id>" has settled — persona=<key> retried at once (b.jg5 SRJ-810)`, `[slack] old-life hold: the stopped wait on instanceId="<id>" has settled — persona=<key> not retried (<why>) (b.jg5 SRJ-810)` | The server has stopped ending the persona's own earlier instance, and the persona is retried (a `retrying now (old-life-hold-ended)` line follows), or not: `not applied` (removed meanwhile), `latched` (held for a human), `held on ErrInvalidFlags` or `not up`, as in the line above. | Nothing; for `latched`, follow its *Held:* notice; for `held on ErrInvalidFlags`, its *Cannot launch* notice; for `not up`, see [Persona diagnostic classes](#persona-diagnostic-classes). |
| `[slack] old-life-wait: persona=<key> torn down — forgotten as waiting on instanceId="<id>"; <what>` | A waiting persona was removed or changed. `the wait is stopped: no other persona waits on the hold` means the server stopped ending the old instance; the next persona that waits on it, or the next start, starts again. `the wait goes on: <keys> still wait on the hold` means it keeps going for them. | Nothing. |
| `[slack] old-life-wait: persona=<key>: latched — no retry timer armed (b.jg5 SRJ-305, SRJ-502)` | A waiting persona is held for a human, so it gets no retries. | Follow its *Held:* notice. |
| `[slack] old-life-wait: persona=<key>: held on ErrInvalidFlags — no retry timer armed (b.jg5 SRJ-305, SRJ-207)` | A waiting persona is held because agent-director rejected its launch flags, so it gets no retries, and it is not retried when the old instance ends. | Follow its *Cannot launch* notice. |
| `[slack] old-life-wait: persona=<key>: not up — no retry timer armed; its bring-up owns it (b.jg5 SRJ-305)` | A waiting persona is not up (its Slack connection, credentials or working directory is not ready), so the old-instance steps arm no retries for it, and it is not retried when the old instance ends; its own bring-up retries bring it up. | Follow its bring-up lines (see [Persona diagnostic classes](#persona-diagnostic-classes)). |
| `[slack] old-life hold: retrying the waiting personas of instanceId=<id> failed: <error> (b.jg5 SRJ-810)`, `[slack] old-life hold: retrying persona=<key> after the wait on instanceId=<id> settled failed: <error> (b.jg5 SRJ-810)`, `[slack] old-life-wait: persona=<key>: forgetting its old-life waits failed: <error> (b.jg5 SRJ-811)` | An internal error. | Report it as a bug, with the lines around it. |

---

## Other lines you may see

| Line | Meaning |
|---|---|
| `[slack] teardownBots: no spawn row for persona "<name>" (key=<key>) — skipping`, `[slack] teardownBots: persona "<name>" (key=<key>) already terminal (state=<state>) — skipping` | `stop --stop-bots` or `clean_restart` found no instance for the persona, or a finished one: it counts as stopped. On the terminal for `stop --stop-bots`, in `clean_restart.log` for `clean_restart`. Nothing. |
| `[slack] teardownBots: pause failed for persona "<name>" (key=<key>) — escalating to kill: <description>` | The pause was refused for a reason that leads on to the force-kill (the session already gone, the bot still launching, a pause timeout, agent-director not answering after 3 tries, or an answer the teardown gives no other meaning). Nothing: the force-kill's lines follow. |
| `[slack] teardownBots: persona "<name>" (key=<key>) exited cleanly in <ms>ms`, `[slack] teardownBots: persona "<name>" (key=<key>) force-killed after <ms>ms` | The persona was stopped, after its pause or by the force-kill at `exit_timeout`. Nothing. |
| `[slack] teardownBots: kill failed for persona "<name>" (key=<key>): <description>` | The force-kill at `exit_timeout` did not stop the persona; its `could not stop persona` line follows once every persona has finished. See [`stop --stop-bots` or `clean_restart` could not stop a persona](#stop---stop-bots-or-clean_restart-could-not-stop-a-persona). |
| `[slack] <command>: could not append a line to server.log: <error>` | `stop --stop-bots` or `clean_restart` could not append one of its report lines to `server.log` (for example, the state directory isn't writable). For `stop --stop-bots` the line is on the terminal; for `clean_restart` it is in `clean_restart.log` only. The print, `startup-errors.log` and the exit status are unchanged. Check the state directory's permissions and free space. |
| `[slack] clean_restart: agent-director answer check: list try <n> of 3 failed: <CLASS>: <description>` (`clean_restart.log`) | `clean_restart` could not stop a persona and is checking that agent-director answers before it starts the server again; this try failed. After 3 failed tries the server is not started and `clean-restart-not-restarted` is recorded. See [`stop --stop-bots` or `clean_restart` could not stop a persona](#stop---stop-bots-or-clean_restart-could-not-stop-a-persona). |
| `[slack] clean_restart: agent-director answers — starting server after the failed teardown` (`clean_restart.log`) | The check answered, so `clean_restart` starts the server even though a persona could not be stopped. Read `server.log` for the new start. |
| `[slack] server.port: could not write <path>; clear-latch cannot reach this server until it restarts: <error>` | At start the server could not record its PID and port in `server.port` beside its PID file (for example, the state directory isn't writable or is full). The server runs normally, but a hold cannot be cleared by hand on it until it restarts. Check the state directory's permissions and free space; the record is written again at the next start. |
| `[<time>] [startup-errors] WARNING: could not write to <path>: <error>` (terminal) | The command could not record one of its entries in `startup-errors.log` at `<path>`. The print, `server.log` and the exit status are unchanged. Check the state directory's permissions and free space. |
| `[slack] persona "<name>" (key=<key>): up after its bring-up retry (directory\|Slack) — launching` | A retrying persona came up and is launched from its retry. Normal recovery. |
| `[slack] spawnForPersona: "<name>" (key=<key>) row cwd=<dir> differs from working_directory=<dir> (state=<state>) — replacing the row by a reuse spawn of the same id; nothing is deleted` | At a start or relaunch the persona's agent-director row was in another directory than its `working_directory`, so it can't be kept: the persona starts a new conversation on the same instance, and the old row stays as an earlier life. The `replacing the row of` line below follows. Nothing. |
| `[slack] spawnForPersona: resume_enabled=false for "<name>" (key=<key>) — not resuming; replacing its row by a reuse spawn of the same id` | `resume_enabled` is `false`, so the persona starts a new conversation on the same instance instead of resuming; the old row stays as an earlier life. The `replacing the row of` line below follows. Nothing. |
| `[slack] spawnForPersona: "<name>" (key=<key>) config_dir label <missing\|changed> (<label absent\|was=<old>>, now=<new> for claude_config_dir=<dir>) — not resuming; replacing its row by a reuse spawn of the same id` | The row was launched with another `claude_config_dir` (or records none), and a resume would keep that old directory, so the persona starts a new conversation on the same instance. The old conversation stays in the old directory, kept as an earlier life; nothing is deleted. `<dir>` is `<default>` when none is set. The `replacing the row of` line below follows. Nothing, if the config directory change was meant. |
| `[slack] pending-row: "<name>" (key=<key>)'s pending row is not covered (<reason>: <why>) — it goes through the live-row sequence, the conversation not kept (alert context recovery); no approver, nothing typed (b.jg5 SRJ-411)` | A row that is still starting (`pending`) is not the persona's current launch, so the server replaces it as an old instance, never typing into it: it ends it with a checked kill, then, while it still reads `pending`, waits until agent-director's grace period (`pending_grace_seconds`) has passed since that launch's start, confirms it has ended (one more checked kill if needed) and brings the persona up on a new conversation on the same instance (the `live-row-sequence:` lines below). `<reason>`: `cwd-mismatch` (`its cwd differs from the persona's working directory`: it was launched in another directory), `config-dir-mismatch` (`its config_dir label is missing or differs`: it was launched with another `claude_config_dir`, or records none) or `retired-key-old-life` (`its key is retired and no new life has begun yet, so the row is the old life`: see [Added again or renamed back](#added-again-or-renamed-back)). During a launch the `replacing the row of … a live row goes through the live-row sequence first …` line follows; after a restart's or a retry's check, the `pending-row: … live-row sequence start answered <answer>` line. Nothing. |
| `[slack] spawnForPersona: replacing the row of "<name>" (key=<key>) (<why>; last read <state>): a reuse spawn of the same id; nothing is deleted (b.jg5 SRJ-707)` | The row was finished (`<state>` `ended`, `missing` or `no-row`), so the persona is brought up on the same instance id at once (the `reuseSpawnForPersona:` lines follow). `<why>` is `resume_enabled is false`, `its cwd differs from the persona's working directory` or `its config_dir label is missing or differs`. Nothing. |
| `[slack] spawnForPersona: replacing the row of "<name>" (key=<key>) (<why>; last read <state>): a live row goes through the live-row sequence first, which ends in a reuse spawn of the same id; start answered <answer> — answering <sequence-waiting\|held>; no other call, nothing counted (b.jg5 SRJ-707, SRJ-705, SRJ-706)` | The row was still running (or starting, `pending`, or could not be read), so it is never launched over: the server began replacing the old instance step by step (the `live-row-sequence:` lines below, alert context `recovery`), ending in a new conversation on the same instance. For a persona whose key is retired (see [Added again or renamed back](#added-again-or-renamed-back)), the line reads `… the live-row sequence first (its key is retired), which ends …`, `<why>` starts `its key is retired and`, and it ends `SRJ-706, SRJ-805)`. This launch makes no other call and counts nothing. `<answer>` is `started`, or `already-running`, `closed` (the server is stopping) or `not-installed`, each with its own line. `start answered held — answering held`: the persona is held because agent-director rejected its launch, so no replacement started (see [A persona posts a Cannot launch notice](#a-persona-posts-a-cannot-launch-notice)). Nothing. A *Kill failed* notice can follow if the old instance can't be stopped (see [A persona posts a Kill failed or Process outlived kill notice](#a-persona-posts-a-kill-failed-or-process-outlived-kill-notice)). |
| `[slack] spawnForPersona: the reuse spawn of "<name>" (key=<key>) collided with a live row — nothing launched; re-running get-then-act once (b.jg5 SRJ-112)` | Right after the reuse spawn's collision line (below): the instance id's row was live again, so nothing was launched; the launch reads the row once more and decides again. After a resume that found no conversation the line (and the one below) reads `the reuse spawn after its resume's no-transcript answer of "<name>" (key=<key>)`. Nothing. |
| `[slack] spawnForPersona: the reuse spawn of "<name>" (key=<key>) collided with a live row again, in the re-run of get-then-act — nothing launched; answering retrying, no spawn-failure notice, nothing counted; the retry timer is armed (cause=collision; b.jg5 SRJ-112, SRJ-1015)` | It collided a second time. No notice and nothing counted; the persona's retries start (`[slack] unavailable-retry: persona=<key> armed (collision) — first retry in 30 s`, unless they were already waiting), and the next try reads the row again. `could not be armed` in place of `is armed` is seen only in tests and development runs. Nothing. |
| `[slack] spawnForPersona: the <call> of "<name>" (key=<key>) collided with a live row — nothing launched, no spawn-failure notice, nothing counted; re-running get-then-act once (b.jg5 SRJ-111, SRJ-114, SRJ-713)` | A spawn the launch made after finding no row (`<call>`: `retry-spawn`, or `fresh spawn after ErrSpawnNotFound on resume`) found the instance id's row live again, so nothing was launched; the launch reads the row once more and decides again. Nothing. |
| `[slack] spawnForPersona: the <call> of "<name>" (key=<key>) collided with a live row — nothing launched, no spawn-failure notice, nothing counted; this is the re-run of get-then-act it gave — answering retrying; the retry timer is armed (cause=collision) (b.jg5 SRJ-111, SRJ-114, SRJ-713)` | Such a spawn collided again in that second read's launch. No notice and nothing counted; the persona's retries start (`armed (collision)`), and the next try reads the row again. `could not be armed` in place of `is armed` is seen only in tests and development runs. Nothing. |
| `[slack] spawnForPersona: dead session for "<name>" (key=<key>) (state=<state>) — <evidence>[; the restart path carried in <evidence>]; the path <holds dead evidence or holds no dead evidence>; recovering via resume/fresh-spawn (b.jg5 SRJ-611)` | At a start or relaunch the persona's reconnect, or its wait for a `working` row, ended in a dead-session verdict (no session of its launch, a refused reconnect, no row, or a finished row), or a restart relaunch reached a finished row, and the persona is resumed or spawned fresh (a `find-missing` sweep runs first for a `waiting` or `working` row). `<evidence>` says what showed it, and whether that is proof the old instance is gone: `cause=tmux-gone: dead evidence (GONE-based)` (no session of the instance's launch) or `cause=prompt-row-ladder-gone: dead evidence (GONE-based)` (no screen under a prompt), against `cause=row-not-interactive`, `cause=row-absent` or `cause=row-read-finished`, each `: not dead evidence` (a refused reconnect, no row, a finished row), or `no cause carried: not dead evidence`. A restart relaunch adds what its health check escalated with. `the path holds no dead evidence: <what voided it>, which voids it` means the launch had proof of a gone session but has since read the row finished or gone (or the reconnect was refused as not interactive, for proof a restart carried in); the `dead evidence (…) is void` line below follows. Nothing is killed at this step either way. Nothing to do. |
| `[slack] spawnForPersona: "<name>" (key=<key>)'s dead evidence (<evidence>) is void for the rest of this attempt — <what voided it>; a later live reading of the row is a launch that evidence never saw, handled as on a path with no dead evidence (b.jg5 SRJ-611)` | The launch held proof that the persona's old session was gone (no session or screen found), then read the row finished or gone, or was told something that means the row's life has changed. That proof covered the session it was about, which has finished, so for the rest of this launch it counts for nothing: if the row then reads running, that is someone else's launch, and the server kills nothing of it (a lost race; the persona is tried again later). `<what voided it>` names it: `the collision get read the row <state>` or `… found no row (ErrSpawnNotFound)`, `the prompt-row ladder action's re-read after its find-missing run read the row <state>`, `the get of its own row after the path's find-missing run read the row <state>`, `the read behind its dead-session cause (cause=<cause>) …`, `the path's last read …`, `resume answered ErrSpawnNotFound: the row is gone`, `the reconnect's send-keys answered ErrSpawnNotInteractive (row-not-interactive): the row is finished, or pending under a launch the verdict never saw`, `the reuse spawn collided, and the re-run of get-then-act it gives carries no dead evidence`, or `the retired key's first launch is a reuse spawn that starts a new life, which the evidence never saw, so the get-then-act its collision enters carries no dead evidence`. One line per voided piece. Nothing to do. If a lost race follows and repeats, check for a `resume` or spawn of `cscb_<key>` made by a human or another orchestrator; the persona is judged afresh at each try. |
| `[slack] spawnForPersona: the joining call for "<name>" (key=<key>) carried an escalate-dead verdict (<evidence>) — dropped; it gets the launch in flight's result (b.jg5 SRJ-611)` | A restart relaunch found a launch of the persona already running (after `launch already in flight … joining it`): it takes that launch's result, and what its health check escalated with is not used. Nothing. |
| `[slack] spawnForPersona: attempting resume for "<name>" (key=<key>)`, then `[slack] spawnForPersona: resumed "<name>" (key=<key>)` | A launch resumes the persona's conversation, and the resume succeeded; a `pre_trust` line follows. When agent-director refuses the resume over a tmux session conflict, the persona is held instead: see [A persona posts a Held: tmux session conflict notice](#a-persona-posts-a-held-tmux-session-conflict-notice). Nothing. |
| `[slack] spawnForPersona: <error> on resume for "<name>" (key=<key>) — re-read: <re-read>; <evidence> — <outcome> (b.jg5 SRJ-710, SRJ-611)` | agent-director said the instance can't be resumed (`ErrSpawnNotResumable`): its row was not finished when the resume ran. That alone never stops or replaces anything: the server read the row once more (`<re-read>`: `state=<state>`, `state=unreadable` when the state couldn't be read, `state=no-row`, `the read failed` or `the read latched the persona`). `<evidence>` is what the launch held about the old session, worded as in the `dead session for` line above. `<outcome>` says what followed: `the persona is latched: …` (follow the *Held:* entry the persona's notice names); `a launch in progress, not a failure: …` (the row is still starting, so nothing is counted or posted; the next line, `no action — state=pending` or a `not covered` line, says whether it is left alone or replaced); `the path holds dead evidence and the row is live: the live-row sequence, with the conversation kept (alert context recovery), ending in resume; start answered <answer> — …` (the session was proven gone but its row still reads one of the running states this server knows, other than `pending`, so the server ends the old instance step by step and then resumes the persona's conversation; the `live-row-sequence:` lines follow); or `a lost race: nothing killed, deleted or launched; … the retry timer is armed (cause=spawn-not-resumable-lost-race)` (no proof the old session is gone, or proof a read of the row as finished or gone has voided (see the `dead evidence (…) is void` line), the row reads a state this server version doesn't know or couldn't read (whatever the proof), or the row finished or vanished meanwhile: nothing is stopped or launched, no notice is posted and nothing is counted; the persona's retries start, `armed (spawn-not-resumable-lost-race)`, and the next try reads the row again). Nothing; if the lost race repeats for a long time, see the persona's row (see [Listing instances](#listing-instances)). |
| `[slack] spawnForPersona: replacing the row of "<name>" (key=<key>) (<why>; last read <state>; <evidence>) — the path holds no dead evidence, so the row is read again first: re-read: <re-read> — <outcome> (b.jg5 SRJ-609, SRJ-611, SRJ-707)` | The persona's row had to be replaced (`<why>`: `resume_enabled is false` or `its config_dir label is missing or differs`) and was last read running, but nothing proved its old session gone (for example, agent-director refused the reconnect), so the server read the row again instead of acting on that read. `<outcome>`: `the row is finished: …` (a new conversation on the same instance follows, with the `replacing the row of` line above); `a launch in progress: …` (the row is still starting; the next line says whether it is left alone or replaced); `a lost race: …` (the row still runs, or reads a state this server version doesn't know or couldn't read: nothing is stopped or launched, and the persona's retries start, `armed (spawn-not-resumable-lost-race)`); `the read was refused: …` (agent-director didn't answer; the persona's retries start); `the persona is latched: …` (follow the *Held:* entry). Nothing. |
| `[slack] spawnForPersona: ErrSpawnNotFound on resume for "<name>" (key=<key>) — fresh-spawn: one plain spawn of the same id, which makes agent-director's pre-spawn scan; no spawn-failure notice for the ErrSpawnNotFound (b.jg5 SRJ-113, SRJ-111)`, then `[slack] spawnForPersona: fresh-spawned (after ErrSpawnNotFound on resume) for "<name>" (key=<key>)` | agent-director had no row for the persona when it was resumed (it was removed or expired meanwhile), so the persona is launched fresh on the same instance id. No notice is posted for the missing row. If that launch meets a tmux session conflict, the persona is held: see [A persona posts a Held: tmux session conflict notice](#a-persona-posts-a-held-tmux-session-conflict-notice). Nothing. The live-row sequence's resume logs the same line with `[slack] live-row-sequence:` in place of `[slack] spawnForPersona:`. |
| `[slack] pending-row: "<name>" (key=<key>)'s live-row sequence start answered <answer>; no other call, nothing counted (b.jg5 SRJ-411, SRJ-706)` | After a restart's or a retry's check found an old instance still starting (the `is not covered` line above), the server began replacing it (`started`), or it was already being replaced (`already-running`); `held`, `closed` (the server is stopping) and `not-installed` start nothing. Nothing counts toward the restart limit. Nothing. |
| `[slack] pending-row: "<name>" (key=<key>)'s pending row is undecided (<reason>: <why>) — no approver, no sequence; its retry timer is armed in pending-only mode, and the next read decides again (b.jg5 SRJ-409)` | The instance is still starting, but the server can't tell yet whether it is the persona's own launch: `cwd-unresolved` (`its working_directory does not resolve to a real path now`) or `config-dir-unresolved` (`its claude_config_dir cannot be resolved now`). It is left alone and read again at the next retry. `its retry timer could not be armed` in its place: the persona is held. Check that the working directory, or the `claude_config_dir` drive or symlink, is there (see `persona-directory-*` and `persona-config-dir-unresolvable` in [Persona diagnostic classes](#persona-diagnostic-classes)). |
| `[slack] pending-row: "<name>" (key=<key>)'s pending row has no launch start — nothing armed, no sequence (b.jg5 SRJ-513)` | The persona's row reads starting but records no launch start: the persona is held. See [A persona posts a Held: launch start not recorded notice](#a-persona-posts-a-held-launch-start-not-recorded-notice). |
| `[slack] pending-row: not arming "<name>" (key=<key>)'s retry timer for its pending row — the persona is latched (b.jg5 SRJ-305)` | The persona is held, so its still-starting instance is not watched; nothing retries it. Follow the *Held:* entry the persona's notice names. |
| `[slack] spawnForPersona: get after ErrSpawnNotResumable failed for "<name>" (key=<key>): <error> — nothing more is called`, `[slack] spawnForPersona: get before replacing failed for "<name>" (key=<key>): <error> — nothing more is called` | Not seen in practice: the server's read of the row failed in a way it doesn't classify. Nothing is stopped or launched; the persona is tried again later. Report it as a bug, with the persona's lines. |
| `[slack] spawnForPersona: <step> failed for "<name>" (key=<key>): <error> — a counted launch failure; nothing is killed and no spawn is made in its place (b.jg5 SRJ-602)` | A launch of the persona could not create its tmux session (`ErrTmuxSessionCreate`). `<step>` is `spawn` (the first spawn), `retry-spawn`, `resume` or `fresh spawn after ErrSpawnNotFound on resume`; a reuse spawn logs its own line (`reuseSpawnForPersona: reuse spawn failed …`, below). The server posts a `Spawn failure:` notice and writes a `spawn-failed` entry when this happens at a start. The failure counts toward the restart limit only when the launch is a restart's (logged next as `[slack] Session relaunch failed for persona=<key>`) or the live-row sequence's own launch (`[slack] Launch failed for persona=<key> — counted (b.jg5 SRJ-112, SRJ-113, SRJ-602)`); a start adds it only to the `failed` count of its `[slack] startupSessionManager: complete — …` line, and any other launch counts nothing. The launch also starts the persona's retries in pending-only mode, logged as `[slack] unavailable-retry: persona=<key> armed in pending-only mode (pending-row) — first retry in 30 s`, so the next try reads the persona's row first. When the persona's retries are already pending, no such line is logged: they keep their mode and their next try's time. The session holding the name is left running, and no other launch is made in its place. When the failed launch left the persona's instance still starting, that launch is never the server's own: the retries check it from `pending_grace_seconds`, never end it, post *Session not starting* once at the limit, and bring the persona up once agent-director marks it missing; see [A persona posts a Launch stuck or Session not starting notice](#a-persona-posts-a-launch-stuck-or-session-not-starting-notice). Nothing, unless that notice comes. |
| `[slack] spawnForPersona: <step> failed for "<name>" (key=<key>): <error>` | A launch step failed for another reason (`<step>` as in the row above). The server posts a `Spawn failure:` notice and, for a spawn at a start, writes a `spawn-failed` entry; the persona's next restart tries again. |
| `[slack] spawnForPersona: <error> on resume for "<name>" (key=<key>) — a reuse spawn of the same id follows; nothing is deleted (b.jg5 SRJ-707)` | agent-director had no conversation to resume (`ErrNoSessionId`, `ErrJsonlMissing` or `ErrJsonlNeverWritten`), so the persona is brought up fresh on the same instance id by a reuse spawn, and its agent-director row is kept as an earlier life. After `ErrJsonlMissing` an `ErrJsonlMissing diagnostic:` line (below) comes first; then the reuse spawn's own line. Nothing. |
| `[slack] ErrJsonlMissing diagnostic: "<name>" (key=<key>) instance=cscb_<key>: resume threw ErrJsonlMissing and the persona is brought up fresh by a reuse spawn of the same instance, and its row is kept (its history archived to the earlier life), but the message archive holds <n> message(s) since spawn (started_at=<time>). Conversation history was LOST. Transcript candidates tried (<source>): <paths>.` | Declarative mode only: in fungible mode no channel is counted, so this line is never logged there (see the `INCONCLUSIVE` row below). The persona's transcript was missing although the message archive shows messages since it started: its conversation memory is lost. At a start a `jsonl-transcript-lost-on-resume` entry with the same text goes to `startup-errors.log`. Once the persona is up, its destination gets a warning ("… my conversation memory has been lost and I was brought up fresh by a reuse spawn of the same instance, and its row is kept (its history archived to the earlier life). …"); when bringing it up fails, the entry stays and no warning is posted. The start's summary counts it as `fresh-after-amnesia`. A human checks the transcript storage under the persona's `claude_config_dir` (the paths the line names; each path is shown on one line, with anything that looks like a credential masked and a long one shortened). |
| `[slack] ErrJsonlMissing diagnostic: "<name>" (key=<key>) instance=cscb_<key> — transcript never created (archive consulted: 0 archived messages since spawn). Nothing to lose; the persona is brought up fresh by a reuse spawn of the same instance, and its row is kept (its history archived to the earlier life). Transcript candidates tried (<source>): <paths>.` | Declarative mode only, like the `LOST` row above. The persona never had a conversation since it started, so no transcript was written; nothing was lost. No entry and no warning; the start's summary counts it as `fresh-after-amnesia`. Nothing. |
| `[slack] ErrJsonlMissing diagnostic: "<name>" (key=<key>) instance=cscb_<key>: resume threw ErrJsonlMissing and the persona is brought up fresh by a reuse spawn of the same instance, and its row is kept (its history archived to the earlier life), but diagnosis was INCONCLUSIVE — could not determine whether conversation history was lost because <reason>.` | The server could not tell whether the persona's conversation was lost (`<reason>`: its row was absent, its start time unreadable, the archive not configured or unreadable, a zero count it can't attribute, or fungible mode). In fungible mode every diagnosis with a readable start time is inconclusive with the reason `` the server is in fungible mode (`allow_invited_channels` is true), where a persona serves every channel its app is a member of and the configuration cannot predict its traffic, so no channel is counted and 0 archived messages since spawn proves nothing ``, whether or not `message_archive_db` is set: the archive is never consulted, so a persona with no archive gets this reason, not the hint to enable the archive. At a start a `jsonl-diagnosis-inconclusive` entry goes to `startup-errors.log`; once the persona is up, its destination gets a warning ("on restart I was brought up fresh by a reuse spawn of the same instance, and its row is kept (its history archived to the earlier life); I could not determine whether my prior conversation history was preserved …"), and none when bringing it up fails. The start's summary counts it as `fresh-after-inconclusive-amnesia`. When the reason is the archive, configure `message_archive_db` (in declarative mode only: in fungible mode the archive can't decide it); otherwise a human checks the transcript storage. |
| `[slack] reuseSpawnForPersona: reuse-spawned "<name>" (key=<key>) instanceId=cscb_<key> — a new life on its own id; its row is kept as an earlier life (b.jg5 SRJ-112)` | The persona was brought up fresh on its own instance id, and its agent-director row and history are kept as an earlier life. With `the id had no row when last read (an ordinary fresh spawn), so no earlier life is kept` in place of `its row is kept as an earlier life`, the instance id had no row, so this was an ordinary fresh spawn. Its `pre_trust` line follows. Nothing. |
| `[slack] reuseSpawnForPersona: <error> on the reuse spawn of "<name>" (key=<key>) — its row is live, so nothing was launched; no spawn-failure notice, nothing counted (b.jg5 SRJ-112)` | That spawn found the instance id's row live again (`ErrInstanceIdCollision`), so nothing was launched, nothing posted and nothing counted. The line after it says what follows: at a launch, the `collided with a live row` line above (the launch reads the row once more; a second collision ends it, and it is retried), or, at the live-row sequence's launch, its `live-row-sequence: the reuse spawn of … collided with a live row` line (below), and the replacement ends (`not launched (…; reuse-collision)`). Nothing. |
| `[slack] reuseSpawnForPersona: reuse spawn failed for "<name>" (key=<key>): <error> — a counted launch failure; nothing is killed and no spawn is made in its place (b.jg5 SRJ-112, SRJ-602)` | That spawn could not create its tmux session (`ErrTmuxSessionCreate`). A `Spawn failure:` notice is posted, and at a start a `spawn-failed` entry (`reuse spawn failed for …`) is written. The failure counts toward the restart limit only when the launch is a restart's (logged next as `[slack] Session relaunch failed for persona=<key>`) or the live-row sequence's own launch (`[slack] Launch failed for persona=<key> — counted (b.jg5 SRJ-112, SRJ-113, SRJ-602)`); a start adds it only to the `failed` count of its `[slack] startupSessionManager: complete — …` line, and any other launch counts nothing. The persona's retries start in pending-only mode, so the next try reads the row first. Nothing is killed, and no other launch is made in its place; an instance it left still starting is waited out as for the `<step> failed … a counted launch failure` line above. |
| `[slack] spawnForPersona: <error> on the resume of "<name>" (key=<key>) — its row is live, so nothing was launched; no spawn-failure notice, nothing counted; answering retrying, the retry timer is armed (cause=collision), and that retry's run of the restart path's decision is the get-then-act (b.jg5 SRJ-713, SRJ-112, SRJ-301)` | Not seen in practice: agent-director answered a resume of the persona with an instance-id collision (`ErrInstanceIdCollision`), which it does not do today. Nothing was launched, posted or counted; the persona's retry reads the row and acts on it. `could not be armed` in place of `is armed`: the line came from outside a launch attempt, and the persona's next retry or restart decides. Nothing. |
| `[slack] reuseSpawnForPersona: reuse spawn failed for "<name>" (key=<key>): <classification> (after one immediate agent-director version re-check: stop); no other launch` | That spawn answered `ErrInvalidFlags` and the version re-check found a binary the server can't run with: the server stops. Nothing is posted or counted. See [Found while the server was running](#found-while-the-server-was-running). |
| `[slack] Launch failed for persona=<key> — counted (b.jg5 SRJ-112, SRJ-113, SRJ-602)` | The live-row sequence's own launch (its `resume` or reuse spawn) failed in a way that counts (`ErrTmuxSessionCreate`, or a working directory that can't be found or isn't a directory), so one failure was counted toward the restart limit. At the limit the `Cap reached` line and notice follow. Follow the launch's own failure line just before it. |
| `[slack] live-row-sequence: <ref>: started at step <n> for <id> (last read <state>; <form>; alert context <context>) (b.jg5 SRJ-705)` | The server began replacing the persona's old instance `<id>`, whose row it last read as `<state>`, step by step (the `live-row-sequence` rows below; `<ref>` names the persona, as `persona=<key>` or `"<name>" (key=<key>)`). `<n>` is `1` (it ends the old instance first) or `2` (that was done already). `<form>` is `ends in a launch` or `no launch (old-life form)`. `<context>` is what a *Kill failed* notice from it would name: `recovery` when a launch started it: because it found the persona's row still running but could not keep it (`resume_enabled` is `false`, the row's working directory or config directory differs, or the persona's key is retired and the row is its old life; the `replacing the row of … a live row goes through the live-row sequence first` line comes just before), or because the persona's session was proven gone while agent-director still read its row as running and the resume was refused (the `spawnForPersona: … on resume for … the live-row sequence, with the conversation kept` line comes just before; this replacement ends in a resume that keeps the persona's conversation); or `stuck-launch abort` at step `2`, when the server ended its own stuck launch and relaunches it (the `stuck-launch abort: the live-row sequence started at its second step` line comes just after; see [A persona posts a Launch stuck or Session not starting notice](#a-persona-posts-a-launch-stuck-or-session-not-starting-notice)). Nothing to do: the lines after it show each step, and one end line closes it. |
| `[slack] live-row-sequence: <ref>: step <1\|4> kill: <outcome> after <t> kill(s) and <r> read(s) (end=<end>; alert=<none\|survivor\|ordinary>) (b.jg5 SRJ-705, SRJ-702)` | The replacement's kill of the old instance, after its tries (see [A kill that is tried again](#a-kill-that-is-tried-again)). A success goes on to the next step; any other `<outcome>` ends the replacement (the end line says how). `alert=` says which notice the tries call for. Nothing for a success. Otherwise follow the end line and any notice. |
| `[slack] live-row-sequence: <ref>: step <1\|4>: no kill — the row was last read pending and agent-director refuses its config file (ad-config-malformed) (b.jg5 SRJ-706, SRJ-316)` | The old instance was still starting and agent-director refuses its config file, so the server does not end it: the replacement ends with no kill and the persona is retried later. See **agent-director refuses its config file** under [agent-director refuses a persona](#agent-director-refuses-a-persona-it-is-retried-on-its-own); the retries go on once agent-director reads its config again. |
| `[slack] live-row-sequence: <ref>: step <2\|3\|4> get: <answer> (b.jg5 SRJ-705, SRJ-114)` | One read of the old instance's row. `<answer>`: `state=<state>`; `no row (ErrSpawnNotFound)`; `failed: <failure>` (the read failed: the replacement ends and the persona is retried later; `<failure>` is `class=<class> name=<reportedName> message="…"`, as on the kill line, when agent-director's answer carries a name or a message (classes `UNCLASSIFIED`, `UNUSABLE_NAME` and `CONFIG`; `name=` or `message=` is left out when absent), else agent-director's error name and its message); or `the read latched the persona` (the read held the persona: its *Held:* notice follows and the replacement stops). After step 3 or 4, `state=ended`, `state=missing` or no row sends the sequence on to its launch (a row read, after the sequence's own kill, not by itself proof the old instance is gone). Nothing, unless it failed repeatedly (check that agent-director answers) or held the persona (follow its *Held:* entry). |
| `[slack] live-row-sequence: <ref>: step 2: waiting on the pending row until G past its launch start (launch start=<time>; G=<n> ms[; deadline=<time>]) (b.jg5 SRJ-705, SRJ-406)` | The old instance, or the server's own stuck launch it just ended, was still starting, so the server waits until agent-director's grace period G (`pending_grace_seconds`) has passed since its launch start before checking it. `G=beyond any wait (it never ends while so set)` when that setting is too large to wait out; `G=could not be read (the wait is armed again until it reads)` when the setting could not be read (see the next line). Nothing. If G is very large, see [agent-director's timing settings](#agent-directors-timing-settings). |
| `[slack] live-row-sequence: <ref>: step 2: G could not be read while arming the wait (<error>) — the wait is not ended; armed again in 5000 ms (b.jg5 SRJ-705, SRJ-210)` | The server could not read G while starting that wait, so it does not wait any shorter: it tries again every 5 s until G reads. The line is written at the first failure, when the error changes, and otherwise at most once a minute, so a long outage logs about one line per minute. `<error>` is the error's name and message. Nothing if it stops. If it repeats, report it with the lines around it, and check the agent-director timing-settings line under [agent-director's timing settings](#agent-directors-timing-settings). |
| `[slack] live-row-sequence: <ref>: step 2: G has passed since the launch start — the runs begin (b.jg5 SRJ-705, SRJ-406)` | The wait above is over; the checks begin. Nothing. |
| `[slack] live-row-sequence: <ref>: step 2: the pending row has no launch start — no wait (b.jg5 SRJ-705, SRJ-408)` | The old instance's row reads starting but records no launch start (an old key's row), so the checks begin at once. Nothing. |
| `[slack] live-row-sequence: <ref>: step <3\|4> run <k> of 4: <placement> (b.jg5 SRJ-705, SRJ-120)`, `<placement>` `marked missing (in ids)`, `judged and left live (in unverified_ids)` or `judged alive (in neither list; last read live, not pending)` | One `find-missing` check of the old instance, at most 4 per replacement, 5 s apart. agent-director judged the row: gone (`marked missing`), or still running. A `get` of the row follows each check. Nothing. |
| `[slack] live-row-sequence: <ref>: step <3\|4> run <k> of 4: not judged (a pending row in neither list) — the episode stops (b.jg5 SRJ-705, SRJ-120, SRJ-717)` | The old instance is still starting (inside agent-director's grace period, or its launch's worker is alive), and agent-director did not judge it. The replacement stops at once: no notice, no further kill, nothing counted toward the restart limit. The persona is retried on its own (`armed (sequence-not-judged)`, below). Nothing: the server retries on its own. |
| `[slack] live-row-sequence: <ref>: step <3\|4> run <k> of 4: run refused — the sequence ends without its launch (b.jg5 SRJ-705, SRJ-120)` | agent-director refused the check (it can't act right now, tmux isn't available, it refuses its config file, or an error the server can't classify). The replacement ends with nothing launched and the persona is retried later; the refusal's own line and any notice come with it. Follow that refusal under [agent-director refuses a persona](#agent-director-refuses-a-persona-it-is-retried-on-its-own). |
| `[slack] live-row-sequence: <ref>: step <3\|4> run <k> of 4: the persona is latched after the run (b.jg5 SRJ-705, SRJ-120)` | The check's read held the persona (its *Held:* notice follows); the replacement stops. Follow the *Held:* entry the persona's notice names. |
| `[slack] live-row-sequence: <ref>: step <3\|4> run <k> of 4: run failed — it judged nothing; the step goes on (b.jg5 SRJ-705, SRJ-120)` | The check failed in another way (its `findMissing sweep failed` line has the reason). It counts as no judgement; the `get` and the next check go on. Nothing, unless every check fails (then the end line reads `no run judged it`). |
| `[slack] live-row-sequence: <ref>: step 6: <resume\|reuse> — <reason> (b.jg5 SRJ-705)` | The old instance is gone, and the server launches the persona again: `resume` keeps its conversation (`the row has a session id and the persona keeps its conversation`); `reuse` starts it fresh under the same instance id, with `<reason>` one of `the key is retired`, `the persona does not keep its conversation`, `there is no row`, `the row has no session id`, `the persona is not in the applied configuration`, `resume_enabled is false`, `the row's cwd differs from the persona's working directory` or `the row's config_dir label is missing or differs`. Nothing. |
| `[slack] live-row-sequence: <ref>: launched (<resume\|reuse>; result=<result>) — runs=<n> kills=<n> judged=<n>; no cause armed by the sequence; the launch's success arms the pending-only watch (pending-row) (b.jg5 SRJ-705, SRJ-717, SRJ-301)` | The end line of a replacement whose launch succeeded: the new instance is watched while it starts, as after any launch (`unavailable-retry: persona=<key> armed in pending-only mode (pending-row) …`, unless the persona's retries were already waiting). `no retry timer armed` in its place: the launch reconnected or did nothing. Nothing. |
| `[slack] live-row-sequence: <ref>: the launch failed (<resume\|reuse>; result=<result>[, refused][, stopping]) — runs=<n> kills=<n> judged=<n>; <armed> (b.jg5 SRJ-705, SRJ-717, SRJ-301)` | The replacement's launch did not succeed (`<result>` `failed`, `deferred`, `latched` or `held`; `held`: see [A persona posts a Cannot launch notice](#a-persona-posts-a-cannot-launch-notice)). Nothing more is called. `<armed>` is `the retry timer armed (sequence-ended-without-launch)`: the persona is retried later; `the retry timer armed by the launch (pending-only)`: the launch could not create its tmux session (`ErrTmuxSessionCreate`) and started the persona's retries itself, in pending-only mode; or `no retry timer armed` when the launch held the persona, the server is stopping, or the persona's teardown or the server's shutdown stopped the replacement. Follow the launch's own lines just before it. |
| `[slack] live-row-sequence: <ref>: not launched (<resume\|reuse>; <why>) — runs=<n> kills=<n> judged=<n>; the retry timer armed (<cause>) (b.jg5 SRJ-705, SRJ-717, SRJ-301)` | No launch was made. `<why>`: `not-resumable` (agent-director said the instance can't be resumed and the row was then not found starting; the line ends `the retry timer armed (spawn-not-resumable-lost-race)`), `not-resumable-pending` (the same, but the row was starting again), `not-applied` (the persona left the configuration), `reuse-collision` (the `reuse` launch found the instance id's row live again, so nothing was launched and nothing is counted; the line ends `the retry timer armed (collision)`) or `stopped` (the persona was held, or its teardown or the server's shutdown began, while the launch waited for another launch of it; the line then ends `no retry timer armed`: follow the *Held:* entry if one was posted). `<cause>` is `collision` for `reuse-collision`, `spawn-not-resumable-lost-race` for `not-resumable` and `sequence-ended-without-launch` otherwise; the line ends `no retry timer armed` instead when the persona is held. The persona's retries start, except for `stopped`; for a persona no longer in the configuration they stop at their first retry, with no call. Nothing. |
| `[slack] live-row-sequence: <ref>: the row is finished (no launch) — runs=<n> kills=<n> judged=<n>; no retry timer armed (b.jg5 SRJ-705, SRJ-717, SRJ-301)` | The no-launch form ended with the old instance's row finished. Nothing. |
| `[slack] live-row-sequence: <ref>: stopped at step <3\|4>: a run did not judge the pending row; no alert, no further kill, nothing counted — runs=<n> kills=<n> judged=<n>; the retry timer armed (sequence-not-judged) (b.jg5 SRJ-705, SRJ-717, SRJ-301)` | The end line after a `not judged` check (above): the old instance is still starting. The persona's retries start, followed by `[slack] unavailable-retry: persona=<key> armed (sequence-not-judged) — first retry in 30 s` (no line when they were already running). Nothing: the server retries on its own. |
| `[slack] live-row-sequence: <ref>: aborted at step <1\|4> by the kill's class <class>[ (the persona latched)] — runs=<n> kills=<n> judged=<n>; <armed> (b.jg5 SRJ-705, SRJ-717, SRJ-301)` | The kill did not succeed (`<class>`: `UNAVAILABLE`, `CONFLICT`, `UNUSABLE_NAME`, `CONFIG`, `ENVIRONMENT` or `UNCLASSIFIED`). Nothing is launched over the old instance. With ` (the persona latched)` the persona is held (its *Held:* notice follows) and nothing is retried; otherwise it is retried later. A *Kill failed* notice may come with it. Follow the *Held:* entry, or the *Kill failed* entry, the persona's notice names. |
| `[slack] live-row-sequence: <ref>: escalated: the row stayed live after runs that judged it; the kill-failure alert was raised — runs=<n> kills=<n> judged=<n>; the retry timer armed (sequence-ended-without-launch) (b.jg5 SRJ-705, SRJ-717, SRJ-301)` | agent-director still listed the old instance as running after both kills and checks that judged it. A *Kill failed* notice with no agent-director description goes to the destination, once per episode; nothing is launched over the old instance and the persona is retried later. See [A persona posts a Kill failed or Process outlived kill notice](#a-persona-posts-a-kill-failed-or-process-outlived-kill-notice). |
| `[slack] live-row-sequence: <ref>: ended: the row stayed live, but no run judged it; no alert — runs=<n> kills=<n> judged=0; the retry timer armed (sequence-ended-without-launch) (b.jg5 SRJ-705, SRJ-717, SRJ-301)` | The old instance still reads running, but none of the checks gave a judgement (each failed). No notice; nothing is launched and the persona is retried later. Nothing, unless it repeats: then look at the `findMissing sweep failed` lines for the persona. |
| `[slack] live-row-sequence: <ref>: ended at step <1\|4> with no kill (ad-config-malformed, row last read pending) — runs=<n> kills=<n> judged=<n>; the retry timer armed (sequence-ended-without-launch) (b.jg5 SRJ-705, SRJ-717, SRJ-301)` | The end line after the `no kill` line above. As for that line. |
| `[slack] live-row-sequence: <ref>: ended at step <2\|3\|4>: the get failed — runs=<n> kills=<n> judged=<n>; the retry timer armed (sequence-ended-without-launch) (b.jg5 SRJ-705, SRJ-717, SRJ-301)` | A read of the old instance's row failed (the `get: failed: …` line before it). Nothing is launched; the persona is retried later. Nothing, unless it repeats: then check that agent-director answers (`agent-director version`). |
| `[slack] live-row-sequence: <ref>: ended at step <3\|4>: the run was refused — runs=<n> kills=<n> judged=<n>; the retry timer armed (sequence-ended-without-launch) (b.jg5 SRJ-705, SRJ-717, SRJ-301)` | The end line after a `run refused` check (above). As for that line. |
| `[slack] live-row-sequence: <ref>: stopped: <why>; no further call — runs=<n> kills=<n> judged=<n>; no retry timer armed (b.jg5 SRJ-705, SRJ-717, SRJ-301)` | The replacement stopped with nothing more called. `<why>`: `the persona is latched` (it is held: follow its *Held:* entry), `the persona's teardown began` (it was removed or changed by a confirmed change), `the server is shutting down`, `the persona is not up or the server is stopping`, or `the old-life hold it serves ended` (the server was ending an old instance, `no launch (old-life form)`, and agent-director read it finished; see [An old instance the server is ending](#an-old-instance-the-server-is-ending)). Only for a hold: follow the *Held:* entry. Otherwise nothing. |
| `[slack] live-row-sequence: <ref>: the step <2\|3\|4> get answered after the sequence was stopped — its answer is dropped; no further call (b.jg5 SRJ-706)`; the same for `the step <3\|4> run` and `the step 6 launch` | A read, check or launch that was under way when the replacement stopped for the persona's teardown or the server's shutdown returned, after its own line; its answer is ignored and a `stopped:` end line with `no retry timer armed` follows. Nothing. |
| `[slack] live-row-sequence: <ref>: the step <1\|4> kill answered after the sequence was stopped — its answer is dropped; no further call (b.jg5 SRJ-706)` | Right after the `step <1\|4> kill:` line: the kill returned after the replacement stopped for a teardown or a shutdown. Its answer is ignored: the persona is not held over it, no *Kill failed* notice is posted and its retries are not started; a `stopped:` end line follows. Nothing. |
| `[slack] live-row-sequence: <ref>: the step <1\|4> kill's latch answered after the sequence was stopped — its answer is dropped; no further call (b.jg5 SRJ-706)` | The kill answered with a conflict or an unusable name, the server held the persona over it, and the replacement was stopped for a teardown or a shutdown while that ran. The *Held:* notice has gone out; no *Kill failed* notice follows, and a `stopped:` end line closes it. Follow the *Held:* entry the persona's notice names. |
| `[slack] live-row-sequence: <ref>: the failed step answered after the sequence was stopped — its answer is dropped; no further call (b.jg5 SRJ-706)` | Right after an `a step failed:` line (below), when the replacement had already stopped: nothing is retried and a `stopped:` end line follows. Report the failure as a bug, with the persona's lines. |
| `[slack] live-row-sequence: <ref>: a step failed: <error> — the sequence ends without its launch (b.jg5 SRJ-705)`, then `… ended: a dependency failed — …; the retry timer armed (sequence-ended-without-launch) …` | An internal error during the replacement. Nothing more is called and the persona is retried later; when the replacement had already stopped, the `failed step` line (above) and a `stopped:` end line come instead, and nothing is retried. Report it as a bug, with the persona's lines. |
| `[slack] live-row-sequence: a launch for <ref> is in flight — the sequence's launch waits for it to settle (b.jg5 SRJ-705, SRJ-706)` | The replacement's launch waits for another launch of the persona to finish first, so the two never overlap. Nothing. |
| `[slack] live-row-sequence: not launching <ref> — <why> (case=<case>); no agent-director call (b.jg5 SRJ-502)` | The persona was held just before the replacement's launch, so nothing is launched (`<why>`: `it is latched`, or a failed check `— taken as latched`). Follow the *Held:* entry the persona's notice names. |
| `[slack] live-row-sequence: resuming <ref> (b.jg5 SRJ-705)`, then `[slack] live-row-sequence: resumed <ref>` | The replacement's launch resumes the persona's conversation, and the resume succeeded. A `pre_trust` line follows. Nothing. |
| `[slack] live-row-sequence: <failure> on resume for <ref> — going on to a reuse spawn of the same id; nothing is deleted (b.jg5 SRJ-705, SRJ-707)` | agent-director had no conversation to resume (`ErrNoSessionId`, `ErrJsonlMissing` or `ErrJsonlNeverWritten`), so the persona is brought up fresh on the same instance id and its row is kept. After `ErrJsonlMissing` an `ErrJsonlMissing diagnostic:` line (below) comes first, and the end line's result is `fresh-after-amnesia` or `fresh-after-inconclusive-amnesia`. Nothing. |
| `[slack] live-row-sequence: <failure> on resume for <ref> — re-read: <re-read> — <outcome> (b.jg5 SRJ-710, SRJ-706)` | The replacement's own resume was refused (`ErrSpawnNotResumable`); it never starts a second replacement. The server read the row once more (`<re-read>` as in the `spawnForPersona: … on resume for` line above) and ends the replacement without its launch: `the persona is latched: …` (follow the *Held:* entry), `a launch in progress: …` (the row is starting again; `not launched (resume; not-resumable-pending)` follows, and the persona's retries start, `armed (sequence-ended-without-launch)`) or `a lost race: …` (any other state, one this server version doesn't know or couldn't read included, or no row; `not launched (resume; not-resumable)` follows, and the retries start, `armed (spawn-not-resumable-lost-race)`). Nothing is stopped, launched or counted. Nothing, unless it repeats: then check the row with `agent-director get --claude-instance-id cscb_<key>`. |
| `[slack] live-row-sequence: the reuse spawn of "<name>" (key=<key>) collided with a live row — no further launch, nothing counted; the sequence ends without its launch (b.jg5 SRJ-112, SRJ-705)` | Right after the reuse spawn's collision line (`reuseSpawnForPersona: … its row is live, so nothing was launched`): the replacement's reuse spawn, or the reuse spawn after its resume found no conversation, found the instance id's row live again. Nothing more is launched and nothing is counted toward the restart limit; the end line `not launched (…; reuse-collision)` follows and the persona's retries start (`armed (collision)`), so the next try reads the row again. Nothing, unless it repeats: then check the row with `agent-director get --claude-instance-id cscb_<key>`. |
| `[slack] live-row-sequence: the fresh spawn after ErrSpawnNotFound on resume of "<name>" (key=<key>) collided with a live row — nothing launched, no spawn-failure notice, nothing counted; the sequence ends without its launch, and the retry it arms runs get-then-act (b.jg5 SRJ-111, SRJ-705, SRJ-713)` | The replacement's resume found no row, and the spawn it made instead found the instance id's row live again. Nothing more is launched, posted or counted; the end line `not launched (…; spawn-collision)` follows and the persona's retries start (`armed (collision)`), and the next try reads the row and decides. Nothing, unless it repeats: then check the row with `agent-director get --claude-instance-id cscb_<key>`. |
| `[slack] live-row-sequence: <ref>: step 6: the persona is not in the applied configuration — no launch (b.jg5 SRJ-705)` | The persona left the configuration during the replacement, so nothing is launched. Nothing. |
| `[slack] dry-run: skipping the live-row sequence's <resume\|reuse> for <ref>` | Dry run: nothing is launched. Nothing. |
| `[slack] live-row-sequence: counting the launch of <ref> failed: <error>` | An internal error recording the replacement's launch result toward the restart limit (a success, or a failure that counts): the launch itself stands, but the persona's restart-limit count may not reflect it. Report it as a bug, with the persona's lines. |
| `[slack] live-row-sequence: persona=<key>: arming the retry timer failed: <error>`, `[slack] live-row-sequence: <ref>: raising the kill-failure alert failed: <error>` | An internal error: the retries or the notice may be missing. Report it as a bug, with the persona's lines. |
| `[slack] live-row-sequence: <ref>: the kill-failure alert's ordinary version is not raised — no kill-failure alerts are installed (b.jg5 SRJ-704, SRJ-705)` | Seen only in tests and development runs, where the server's notice wiring is not set up. Nothing. |
| `[slack] live-row-sequence: <ref>: not started for <id> — a sequence already runs for this persona or instance id; nothing more is started (b.jg5 SRJ-706)` | The server was asked to replace the persona's old instance `<id>`, or to end an old instance, while a replacement for the persona, or the steps ending that instance, were already running on it, so nothing new started; the running one carries on and its own lines show how it ends. Nothing. |
| `[slack] live-row-sequence: <ref>: not started for <id> — the server is shutting down; no sequence starts (b.jg5 SRJ-706)` | A replacement was asked for after the server began stopping, so none started. Nothing. |
| `[slack] live-row-sequence: <ref>: stop asked — <reason>; no further call (b.jg5 SRJ-706)` | The server stopped a running replacement: `<reason>` is `the persona is latched` (the persona is held: follow its *Held:* entry), `the persona's teardown began` (a confirmed change removed or changed the persona), `the server is shutting down` or `the old-life hold it serves ended` (agent-director read the old instance finished; see [An old instance the server is ending](#an-old-instance-the-server-is-ending)). The replacement makes no call after the one under way returns, and its `stopped:` end line follows. Nothing, unless it is a hold. |
| `[slack] live-row-sequence: not launching <ref> — the sequence was stopped (<reason>); no agent-director call (b.jg5 SRJ-706)` | The replacement's launch was waiting for another launch of the persona to finish when the replacement was stopped (`<reason>`: `latched`, `teardown` or `shutdown`), so nothing is launched. Nothing; for `latched`, follow the *Held:* entry the persona's notice names. |
| `[slack] spawnForPersona: not launching <ref> — its live-row sequence runs; no agent-director call (sequence-waiting; b.jg5 SRJ-706)` | A launch of the persona (the start, a bring-up, a restart or a retry) was asked for while the server is replacing its old instance, so it made no call: the replacement decides the outcome, launching the persona itself or ending without a launch (its end line says which; the persona's retries start unless it was stopped). Nothing is counted toward the restart limit, and a retry comes back later. Nothing. |
| `[slack] Skipping restart for persona=<key> — its live-row sequence runs; no agent-director call, nothing recorded (sequence-waiting; b.jg5 SRJ-706, SRJ-303)` | A restart (a scheduled one, a retry, or one a lost message started) found the server replacing the persona's old instance, so it checked, killed and launched nothing; the replacement decides the outcome. With ` (the running query failed: <error> — taken as running)` after `runs`, an internal error made the server assume a replacement was running. Nothing; report the internal error as a bug if it repeats. |
| `[slack] Restart for persona=<key> goes no further <where> — its live-row sequence runs; nothing more is called for it, nothing recorded (sequence-waiting; b.jg5 SRJ-706, SRJ-303)` | A restart was under way when the server began replacing the persona's old instance (a launch found its row still running but could not keep it), so the restart stopped there: nothing more is checked, killed or launched, and the replacement decides the outcome. `<where>` is `after its liveness probe`, `after its escalate-dead reconnect`, `after its re-probe`, `before its kill`, `before its launch` or `after its launch`. A retry comes back later, its line naming `live-row-sequence-waiting`. Nothing. |
| `[slack] live-row-sequence: <ref>: no sequence registry is installed — nothing started (b.jg5 SRJ-706)` | Seen only in tests and development runs; a running server always has its registry. Report it as a bug if a running server logs it. |
| `[slack] stopping the live-row sequences on shutdown failed: <error>` | An internal error while the server was stopping; the shutdown went on. Report it as a bug if it repeats. |
| `[slack] unavailable-retry: persona=<key> armed (sequence-not-judged) — first retry in 30 s`, `… armed (sequence-ended-without-launch) — first retry in 30 s` | A replacement ended without launching the persona (not judged, or any other end above), so its retries start. Never counted toward the restart limit. Nothing: the server retries on its own. |
| `[slack] Relaunching session for persona=<key> cwd="<path>" — kill: <kill>` | A restart relaunches the persona. `<kill>` is the old session's kill outcome (a success), `not killed (a guard made no call)` when a launch was already running or the persona's config directory could not be found, or `none (b.jg5 SRJ-611)` when no kill was made: the restart's check read the row ended or missing, or found it gone, or the health check's escalation was no proof the old instance is gone (a refused reconnect, no row, or a finished row), and the server relaunches without killing (a `No kill before the launch` or `No kill before the relaunch` line comes first). The old instance is killed first only when agent-director answered the restart's check that its own install had disappeared, which reads nothing of the row: at the first check, or after an escalation from no session or screen found. Normal. |
| `[slack] persona Socket Mode: personas[<i>] "<name>" (key=<key>): <text>` | A connection-health line from the Slack library: a ping or pong timeout, or `Failed to send ping to Slack`. The connection is treated as dead and reopened. See [`persona-connection-lost`](#persona-connection-lost). |
| `[WARN]  web-api:WebClient …` (or `[INFO]`, `[ERROR]`) | The Slack library's own line for a persona's Web API client: a Slack response warning, a rate-limit wait, or a failed request. URLs show as `<redacted-url>` and token-like text as `<redacted-token>`. Nothing to do unless it repeats. |
| `[slack] Session connected: persona "<name>" (key=<key>) cwd="<path>"` | The persona's instance registered: it's being served. |
| `[slack] spawnForPersona: "<name>" (key=<key>) <spawn\|resume\|reuse spawn> pre_trust=<ok\|skipped\|failed> (logged only, b.jg5 SRJ-413)` | Written once for every launch that succeeded (`spawn`, `resume` or `reuse spawn`): agent-director's report of whether it accepted the persona's folder trust for this launch. `ok`: it did. `skipped`: it did not, as pre-trust was off for this launch. `failed`: it tried and could not. Cause: agent-director accepts the folder trust itself at each launch. The line never needs action by itself, and nothing the server does depends on it. After `skipped` or `failed` the instance may show Claude Code's folder-trust prompt; the server accepts it with Enter as it does any startup prompt (the `approvePreSessionDialogs` lines in this table; the README's Troubleshooting entry "A persona's instance waits at a startup prompt"). Look further only if the instance stays at that prompt: then follow the `approvePreSessionDialogs` lines for the persona. |
| `[slack] spawnForPersona: "<name>" (key=<key>) <spawn\|resume\|reuse spawn> result carries no pre_trust: it came from an agent-director older than Phase 1 (logged only, b.jg5 SRJ-413)` | Written once for every launch that succeeded, in place of the line above, when agent-director's answer did not report the folder trust at all. Cause: the agent-director binary that answered predates Phase 1. The launch goes on unchanged and a folder-trust prompt, if one shows, is accepted as above. No action is needed for the line itself; check the installed agent-director version as in [The server refuses the agent-director binary at start](#the-server-refuses-the-agent-director-binary-at-start). |
| `[slack] approvePreSessionDialogs: "<name>" (key=<key>) reads <state>: the launch is over, so the approver stops with no pane read and the restart path decides (b.jg5 SRJ-402)` | While a newly launched instance was starting, agent-director reported it `ended` or `missing` (`<state>`): it died before its session started. The server stops watching it at once and reads nothing from its screen. During a server start the same text is in `startup-errors.log` as `dev-channels-approve-spawn-died`. The restart handling relaunches it as for any dead instance; if it keeps dying, attach with the operator's say-so (`tmux attach -t =slack_bot_<key>`) on its next launch to see what it shows, or read the persona's other lines around this one. |
| `[slack] approvePreSessionDialogs: "<name>" (key=<key>) has no row (ErrSpawnNotFound): the approver stops; nothing is read or typed (b.jg5 SRJ-402)` | agent-director has no record of the newly launched instance, so the server stops watching it. Nothing is written to `startup-errors.log`. The restart handling or the next health check brings the persona back; nothing to do unless it repeats. |
| `[slack] approvePreSessionDialogs: "<name>" (key=<key>) reads pending with no launch start: the approver stops; nothing is read or typed (b.jg5 SRJ-401, SRJ-513)` | The instance's record shows it starting but carries no launch start, so the server neither reads nor types into it. For a persona in the applied configuration you never see this line: the server holds the persona instead (see [A persona posts a Held: launch start not recorded notice](#a-persona-posts-a-held-launch-start-not-recorded-notice)). The line appears when the persona is no longer in the applied configuration, for example it was removed while its instance was starting: the server stops answering its startup prompts and holds nothing, which is expected. No action is needed beyond checking that the persona was in fact removed (its removal lines around this one, or its absence from `config.json`). |
| `[slack] approvePreSessionDialogs: "<name>" (key=<key>) reads the state "<state>", which is neither pending, live nor finished — nothing read or typed; polling on within the bound` | agent-director reported a state the server doesn't know for a starting instance. Nothing is read or typed, and the server checks again, within its time limit (see the `spawn never reached a live state within B` row). If it repeats, check that the agent-director version is one the server supports (`agent-director version`). |
| `[slack] approvePreSessionDialogs: status of "<name>" (key=<key>) failed: <error> — polling on within the bound` | agent-director couldn't report a starting instance's state (see [The server log](#the-server-log), Error detail): it can't act right now, refuses its config file, or gave an error the server can't classify. The server checks again, until the instance starts or its time limit passes; after a can't-act-now or config-file answer the next check waits 5 s. A config-file refusal also raises the persona's *agent-director refuses its config file* notice. If it repeats, check that agent-director responds (`agent-director version`). |
| `[slack] approvePreSessionDialogs: read-pane of "<name>" (key=<key>) failed: <error> — polling on within the bound` (or `send-keys of …`) | agent-director couldn't read a starting instance's screen, or couldn't press Enter on its startup prompt (it can't act right now, refuses its config file, or gave an error the server can't classify). The server tries again, until the instance starts or its time limit passes; after a can't-act-now or config-file answer the next try waits 5 s. If the instance stays at its prompt, attach with the operator's say-so (`tmux attach -t =slack_bot_<key>`) and accept it by hand. |
| `[slack] approvePreSessionDialogs: spawn never reached a live state within B (<ms>ms from the launch start) for "<name>" (key=<key>) — dialog unrecognized or session hung (dev-needle='I am using this for local development'); the approver stops and nothing is posted (b.jg5 SRJ-404, SRJ-405)` (or `from the approver's start`) | A newly launched instance didn't start within the server's time limit B: the later of 5 minutes and agent-director's `pending_grace_seconds` plus 60 s (`<ms>`), counted from the launch start agent-director recorded (`from the approver's start` when no read of the row had shown one yet). Cause: a startup prompt the server doesn't recognise, or a hung session. The server stops answering its startup prompts, and the watch posts nothing to Slack; during a server start `startup-errors.log` has `dev-channels-approve-not-ready` with the same text. The server then checks the instance once with agent-director (the `rule (approver-stop)` line), and the persona's retries go on checking it; a session still not started gets the *Session not starting* notice (see [A persona posts a Launch stuck or Session not starting notice](#a-persona-posts-a-launch-stuck-or-session-not-starting-notice)). Fix: with the operator's say-so, attach (`tmux attach -t =slack_bot_<key>`) to see what it shows, and accept a prompt by hand; or inspect it with `agent-director read-pane --claude-instance-id cscb_<key>`. |
| `[slack] approvePreSessionDialogs: "<name>" (key=<key>) reads pending with a launch start other than the one this approver kept: the row belongs to a newer launch, whose own approver works on it — this approver stops; nothing read or typed (b.jg5 SRJ-401)` | While the server was answering a starting instance's startup prompts, agent-director reported a newer launch of the persona. The older watcher stops without reading or typing anything, so a prompt never gets two Enters; the newer launch's own watcher answers its prompts. Nothing to do. |
| `[slack] approvePreSessionDialogs: read-pane of "<name>" (key=<key>) answered that the session is gone: <error> — the approver stops; nothing typed (b.jg5 SRJ-117, SRJ-118, SRJ-404)` (or `status of …`, `send-keys of …`) | agent-director found the starting instance's tmux session gone, or no record of it for the screen read or the Enter. The server stops answering its startup prompts. The restart handling or the next health check deals with the instance; nothing to do unless it repeats. |
| `[slack] approvePreSessionDialogs: send-keys of "<name>" (key=<key>) answered that the row is not interactive: <error> — the session holding the name is not this launch's (by its label's token), or the row has no launch start; the approver stops with nothing typed and nothing killed (b.jg5 SRJ-118, SRJ-404)` (or `status of …`, `read-pane of …`) | agent-director refused to read or type into the starting instance: the tmux session holding the persona's name is not the one this launch created, or its record carries no launch start. The server stops answering its startup prompts, types nothing and ends nothing; it makes no further attempt to answer this launch's prompts, and a *Session not starting* notice for it leaves out the attach remedy (see [A persona posts a Launch stuck or Session not starting notice](#a-persona-posts-a-launch-stuck-or-session-not-starting-notice)). Cause: usually a session left from an earlier launch, or one started by hand, holds the name. Fix: with the operator's say-so, look at it (`tmux attach -t =slack_bot_<key>`) and check the record with `agent-director get --claude-instance-id cscb_<key>`, then follow the "Operator actions" section of agent-director's README. |
| `[slack] approvePreSessionDialogs: read-pane of "<name>" (key=<key>) answered that tmux is not available: <error> — the approver stops; the tmux-unavailable outage is raised and nothing is counted (b.jg5 SRJ-311, SRJ-404)` (or `status of …`, `send-keys of …`) | tmux couldn't be reached while the instance was starting. The server stops answering its startup prompts; the persona's *tmux unavailable* notice and its retries follow (see **tmux isn't available** under [agent-director refuses a persona](#agent-director-refuses-a-persona-it-is-retried-on-its-own)). Nothing is counted toward the restart limit. Fix tmux as that entry says. |
| `[slack] approvePreSessionDialogs: send-keys of "<name>" (key=<key>) refused: <error> — CONFLICT: <outcome>; the approver stops; nothing typed (b.jg5 SRJ-404, SRJ-501)` (or `status of …`, `read-pane of …`) | agent-director refused to act on the starting instance's tmux session (a conflict). The persona is held (`<outcome>`: `the persona latched`, `the persona relatched` or `the persona was already latched with this case`; `latching the persona failed: <error>` is an internal error: the approver still stops and types nothing, but the hold may not be recorded or the notice may be missing, so report it as a bug), nothing is typed, and the server stops answering its startup prompts. See [A persona posts a Held: tmux session conflict notice](#a-persona-posts-a-held-tmux-session-conflict-notice). |
| `[slack] approvePreSessionDialogs: read-pane of "<name>" (key=<key>) refused: <error> — UNUSABLE NAME: <outcome>; the approver stops; nothing typed (b.jg5 SRJ-404, SRJ-512)` (or `send-keys of …`) | agent-director can't use the tmux session name recorded for the starting instance. The persona is held, nothing is typed, and the server stops answering its startup prompts. See [A persona posts a Held: unusable tmux session name notice](#a-persona-posts-a-held-unusable-tmux-session-name-notice). |
| `[slack] approvePreSessionDialogs: "<name>" (key=<key>) is latched — the approver stops; nothing more is read or typed (b.jg5 SRJ-502)` | The persona was held (by any of the three *Held:* notices) before or while the server checked its starting instance. The server stops answering its startup prompts and types nothing more. See the *Held:* entry the persona's notice names. |
| `[slack] approvePreSessionDialogs: stopping the approver for "<name>" (key=<key>) (latched): the persona latched; it makes no further call (b.jg5 SRJ-401, SRJ-404)` | The persona was held while its instance was starting; the server stops answering that instance's startup prompts at once. See the *Held:* entry the persona's notice names. |
| `[slack] approvePreSessionDialogs: stopping the approver for "<name>" (key=<key>) (superseded): a later launch started its own approver; it makes no further call (b.jg5 SRJ-401, SRJ-404)` | The persona was launched again while the server was still answering the previous launch's startup prompts. Only the newest launch's prompts are answered. Normal after a quick relaunch; if it repeats for the same persona, look at its lines around this one for why it keeps being relaunched. |
| `[slack] approvePreSessionDialogs: stopping the approver for "<name>" (key=<key>) (teardown): its teardown began; it makes no further call (b.jg5 SRJ-401, SRJ-404)` | The persona was removed or changed destructively while its instance was still starting. The server stops answering its startup prompts first, so nothing is typed into an instance being torn down. Normal; the teardown's own lines follow. |
| `[slack] approvePreSessionDialogs: stopping the approver for "<name>" (key=<key>) (retired-key): its key was recorded as retired; it makes no further call (b.jg5 SRJ-401, SRJ-404)` | A confirmed change removed the persona or changed it destructively while its instance was still starting. Applying it records the persona's key as retired and stops answering its startup prompts at once, before the teardown and before anything else is ended, so nothing is typed into the old instance. Normal; the teardown's own lines follow. |
| `[slack] approvePreSessionDialogs: stopping the approver for "<name>" (key=<key>) (shutdown): the server is shutting down; it makes no further call (b.jg5 SRJ-401, SRJ-404)` | The server stopped while a persona's instance was still starting. Its startup prompts are not answered any more; the instance is left as it is and the next start handles it. Nothing to do. |
| `[slack] approvePreSessionDialogs: stopping the approver for "<name>" (key=<key>) (stuck-launch-abort): CSCB is aborting the persona's own stuck launch, and its kill follows; no pending-row run follows this stop; it makes no further call (b.jg5 SRJ-401, SRJ-404)` | The server is ending its own stuck launch at the limit; the end and the relaunch follow. See [A persona posts a Launch stuck or Session not starting notice](#a-persona-posts-a-launch-stuck-or-session-not-starting-notice). Nothing to do. |
| `[slack] approvePreSessionDialogs: not starting the approver for "<name>" (key=<key>) (<reason>): it was stopped before its launch returned; nothing read or typed (b.jg5 SRJ-404)` | A launch of the persona finished after a confirmed change recorded its key as retired (`retired-key`), after its teardown began (`teardown`) or after the server began stopping (`shutdown`), so the server doesn't answer that instance's startup prompts. Normal. |
| `[slack] approvePreSessionDialogs: the approver for "<name>" (key=<key>) failed: <error> — it stops; nothing more is called` | An internal error in the server's watcher of a starting instance. Its startup prompts are no longer answered; if the instance stays at a prompt, attach with the operator's say-so (`tmux attach -t =slack_bot_<key>`) and accept it by hand. Report it as a bug, with the persona's lines. |
| `[slack] stopping the dialog approvers on shutdown failed: <error>` | An internal error while the server was stopping; the shutdown went on. Report it as a bug if it repeats. |
| `[slack] Session disconnected[ (SSE abort)]: persona "<name>" (key=<key>) has its tmux-unavailable outage raised — no restart scheduled; its retry timer recovers it (b.jg5 SRJ-311)` | Follows the persona's `[slack] Session disconnected[ (SSE abort)]: persona "<name>" (key=<key>) cwd="<path>"` line (its instance's session closed). Its *tmux unavailable* or *tmux server changed* notice holds and its retries are running, so the disconnect scheduled no restart; the retries bring the persona back once tmux answers (see **tmux isn't available** under [agent-director refuses a persona](#agent-director-refuses-a-persona-it-is-retried-on-its-own)). Nothing to do. |
| `[slack] Session disconnected[ (SSE abort)]: persona "<name>" (key=<key>) has its tmux-unavailable outage raised with no retry timer — no restart scheduled; arming one (b.jg5 SRJ-311)` | Follows the persona's `Session disconnected … cwd="<path>"` line. Its *tmux unavailable* or *tmux server changed* notice holds and nothing was retrying it (its earlier retries stopped: it wasn't up at a retry, its relaunch was declined, or the retry failed internally), so the disconnect scheduled no restart and started the retries with the `environment` cause instead; `[slack] unavailable-retry: persona=<key> armed (environment) — first retry in 30 s` follows. The retries come even with `session_restart_delay` and `health_check_interval` both `0`. Nothing to do; for tmux itself, see **tmux isn't available** under [agent-director refuses a persona](#agent-director-refuses-a-persona-it-is-retried-on-its-own). |
| `[slack] Session disconnected[ (SSE abort)]: persona "<name>" (key=<key>) has its tmux-unavailable outage raised and is latched — no restart scheduled, no retry timer armed (b.jg5 SRJ-311, SRJ-502)` | Follows the persona's `Session disconnected … cwd="<path>"` line. Its *tmux unavailable* or *tmux server changed* notice holds and the persona is also held for a human, so the disconnect scheduled no restart and started no retries. Follow [A persona posts a Held: tmux session conflict notice](#a-persona-posts-a-held-tmux-session-conflict-notice). |
| `[slack] Session disconnected[ (SSE abort)]: persona "<name>" (key=<key>) has its tmux-unavailable outage raised with work in flight — no restart scheduled, no retry timer armed (b.jg5 SRJ-311, SRJ-315)` | Follows the persona's `Session disconnected … cwd="<path>"` line. Its *tmux unavailable* or *tmux server changed* notice holds and a launch of the persona is running, the server is replacing its old instance or ending an old instance the persona waits on, or the server is still answering a just-launched instance's startup prompts, so the disconnect scheduled no restart and started no retries; the launch's own outcome decides what follows. Nothing to do. If the persona is still not back once the launch ends and nothing retries it, the next health check that finds it not healthy starts its retries, unless `health_check_interval` is `0` (the `health-check: … with no retry timer — arming one` line). |
| `[slack] Session disconnected[ (SSE abort)]: persona "<name>" (key=<key>) has its tmux-unavailable outage raised and no retry controller — no restart scheduled, no retry timer armed (b.jg5 SRJ-311)` | Follows the persona's `Session disconnected … cwd="<path>"` line. Its *tmux unavailable* or *tmux server changed* notice holds, but the disconnect came before the server had set up its retries during startup, so it scheduled no restart and started none. Nothing to do; the next health check that finds the persona not healthy starts its retries, unless `health_check_interval` is `0`. If it repeats after startup, report it as a bug, with the persona's lines. |
| `[slack] Session disconnected[ (SSE abort)]: persona "<name>" (key=<key>) cwd="<path>"`, then `[slack] Skipping restart — server is shutting down (persona=<key>)` | The persona's instance's session closed while the server was stopping (stopping the server closes every session). Nothing is restarted and no retries are started. Nothing to do. |
| `[slack] Lost message: persona=<key> has its tmux-unavailable outage raised with no retry timer — no restart scheduled; arming one (b.jg5 SRJ-311)` | A message for the persona was lost while its *tmux unavailable* or *tmux server changed* notice holds and nothing was retrying it (its earlier retries stopped: it wasn't up at a retry, its relaunch was declined, or the retry failed internally), below the restart limit (at the limit nothing is started and this line is not logged). The lost-message notice reports `not answering`; no restart was started, and the retries were started with the `environment` cause instead; `[slack] unavailable-retry: persona=<key> armed (environment) — first retry in 30 s` follows. The retries come even with `session_restart_delay` and `health_check_interval` both `0`. Nothing to do; for tmux itself, see **tmux isn't available** under [agent-director refuses a persona](#agent-director-refuses-a-persona-it-is-retried-on-its-own). |
| `[slack] No live session for persona "<name>" (key=<key>) chat_id=<id> — dropping message` | The persona's instance has no live MCP session (the persona is up but its instance isn't registered, or the persona stopped being up while the message was being handled), so a message for it is lost: not delivered, not saved and not replayed later. Nothing else is posted in `<id>`, the conversation it came from (the notice below lands there only when `<id>` is the destination), and it gets no ack reaction. The persona posts one lost-message notice to its destination: `Persona "<name>" (key=<key>): :warning: *Message lost* — a message from <sender> …`, naming the sender (display name, else user ID; for a bot or webhook post, its name or bot ID) and ending in a `Recovery:` state, never the message text. The notice reports the first state that applies, in this order. `not up`: the persona stopped being up (broken or retrying) while the message was being handled, so no restart was started; its instance is launched once the persona recovers: fix its cause (its class line), then resend. A persona that isn't up receives nothing, so this state appears only when the persona stops being up after its connection received a message and before the session lookup (for example Slack refuses a Web API call for its bot token), or when the old half of a persona being torn down by a destructive change receives a message just before its connection stops. `held for a human`: the persona is held until a human resolves a problem with its tmux session or agent-director row; follow [A persona posts a Held: tmux session conflict notice](#a-persona-posts-a-held-tmux-session-conflict-notice), [A persona posts a Held: unusable tmux session name notice](#a-persona-posts-a-held-unusable-tmux-session-name-notice) or [A persona posts a Held: launch start not recorded notice](#a-persona-posts-a-held-launch-start-not-recorded-notice), whichever notice its destination has, then resend. A persona whose row reads pending with no launch start reports `held for a human`, never `starting`, even when the one read made for the lost message is the one that held it. `cannot launch`: the host's agent-director rejected the persona's launch, so it is held until the agent-director binary changes or the server restarts, and no restart was started; follow [A persona posts a Cannot launch notice](#a-persona-posts-a-cannot-launch-notice), then resend once it's back. `kill failed`: the server could not end a worker of the persona, which may still be running, and posted a *Kill failed* notice; it applies until agent-director reports that worker's row ended or missing, or no longer has it, and a held persona reports `held for a human` instead; follow [A persona posts a Kill failed or Process outlived kill notice](#a-persona-posts-a-kill-failed-or-process-outlived-kill-notice), then resend once it's back. It also applies, with nothing posted, while the persona waits on an old instance (one in its working directory, or its own earlier one) whose kill failed: a confirmed change's teardown kill, a start's clean-up kill or the server's later kill of that instance could not end it (the *Kill failed* text is in its `persona-teardown-notice`, `orphan-cleanup` or `persona-kill-failed` entry), until agent-director reports that old instance finished; see [An old instance the server is ending](#an-old-instance-the-server-is-ending). A *Process outlived kill* notice never gives this state. `not answering`: the persona's *Not answering* record holds, or its *tmux unavailable* / *tmux server changed* or *agent-director refuses its config file* notice holds, and the server is retrying it (a persona at its restart limit never reports this, whatever is wrong with tmux or agent-director; one whose retries stopped reports the next state that applies); follow that notice's entry, then resend once it's back. `starting`: the persona's session is starting but hasn't come up yet: a launch of it is running, or the server is still answering the startup prompts of its just-launched instance (no check with agent-director is made then), or, when nothing earlier applies and nothing is running for it, the server checked with agent-director once, when it found the message lost, and its row still reads starting (a check that fails never gives `starting`); resend once it's up. No restart is started in these five states. `restarting`: a restart was already under way, the server is replacing the persona's old instance (its `live-row-sequence:` lines show it), or the server is ending an old instance the persona waits on (its `old-life-wait` lines show it; see [An old instance the server is ending](#an-old-instance-the-server-is-ending)), even while that instance's row still reads starting; no check with agent-director is made and no restart is started for the message; resend once it's back. `auto-restart disabled`: `session_restart_delay` is `0`, so no restart was started; a persona the server is already retrying (see [agent-director refuses a persona](#agent-director-refuses-a-persona-it-is-retried-on-its-own)) comes back when a retry succeeds, otherwise a server restart recovers it. `restart limit reached`: the persona is capped, and this takes precedence over `not answering` even while tmux or agent-director is failing for it; nothing was started for it; the notice says to restart the server to recover. `starting now`: the message itself started a restart (not the same as `starting`); resend once it's back. A persona waiting on an old instance comes up only once that instance has ended: the restart the message started does nothing while it waits (see [A persona waiting on an old instance](#a-persona-waiting-on-an-old-instance)). If the notice doesn't arrive, look for a [`persona-destination-failed`](#persona-destination-failed) line. |
| `[slack] DROP: no _GET_stream for persona "<name>" (key=<key>) chat_id=<id> cwd="<path>" mcpSessionId=<id> — message will not reach the bot; triggering recovery` | The instance's session is registered and looks connected, but its message stream is gone (the `Dispatching to persona …` line just before it has `hasGetStream=false`). The message is lost exactly as for `No live session` above: the same lost-message notice at the destination, with the same `Recovery:` states in the same order, `starting now` last (`held for a human`, `cannot launch`, `kill failed`, `not answering`, `starting` and `restarting` included, none of which starts a restart), nothing else in the source conversation. |
| `[slack] persona-routing: user-name lookup for persona "<name>" (key=<key>) failed, using the user ID: …` | The sender's display name couldn't be looked up through the persona's Slack client. The message is handled as usual, with the sender named by user ID (in the delivered message, or in a lost-message notice). Nothing to do unless it repeats; then check the persona's app and the host's Slack connectivity. |
| `[slack] persona-routing: lost-message notice for persona "<name>" (key=<key>) failed: …` | An internal error raising a lost-message notice: the message was lost and its recovery still ran, but no notice reaches the destination. Report it as a bug, with the persona's lines around it. |
| `[slack] persona-routing: lost-message row read for persona "<name>" (key=<key>) failed — session-starting left out: …` | The server's one check with agent-director for a lost message (see `starting` in the `No live session` row) failed internally, so the notice reports the next state that applies, never `starting`. The message was lost as usual and its notice still goes out. If the state is `starting now`, the restart it started checks agent-director again before launching and never launches over a session still starting. Nothing to do unless it repeats; then report it as a bug, with the persona's lines around it. |
| `[slack] Session connected with CWD "<path>" — no matching persona` | A Claude session connected from a directory that is no persona's `working_directory` (compared by real path). It is not registered: the server disconnects it. Start it from the persona's directory, or fix `working_directory`. |
| `[slack] Session refused: its working directory "<path>" is held for an old life that may still be running (instanceId="<id>"[, instanceId="<id>" …]) — registered as no persona's session until the hold ends (b.jg5 SRJ-810, SRJ-1505)` | A Claude session connected from a directory where an old instance (each `<id>`) may still be running, so it is registered as no persona's and disconnected, whichever persona names the directory and whether or not that persona is up. It is checked before any persona is matched. With `(the held-directory query failed: <error> — taken as held)` in place of the ids, the server could not tell and refused it to be safe: report that as a bug. Nothing to do for the session itself: once agent-director reads the old instance finished, a session from the directory is decided as usual. Check the old instance read-only with `agent-director get --claude-instance-id <id>`, and see [A persona waiting on an old instance](#a-persona-waiting-on-an-old-instance). |
| `[slack] persona-destination: <ref> has permission_prompts set to "dm" but dm.enabled is not true — no DM opened and nothing posted` (or `… dm.contact is not set …`; for a prompt the line starts `[slack] permission-poller: <ref>` and ends `— prompt for <instance> (request_token=…) not posted and no DM opened`). In fungible mode the line names the fungible destination's setting: `… <ref> has invited.permission_prompts set to "dm" but …`, also when `invited.permission_prompts` is absent and `"dm"` is its default | The persona's prompt or notice had a `"dm"` destination without DMs on or a contact, which the loader rejects in the mode in force, so it should not happen. Nothing is sent. Report it as a bug, with the persona's lines. |
| `[slack] Tool "<tool>" failed for persona "<name>" (key=<key>) on channel "<channel>": <error>` (fungible mode) | In fungible mode a persona's tools may target any channel ID and Slack decides, so a call on a channel can fail at Slack. The agent gets `Tool "<tool>" failed for persona "<name>" (key=<key>) on channel "<channel>": Slack refused the call (<code>).`, or `…: the tool call failed.` when the failure has no Slack error code (a network or local failure). `not_in_channel`, or `channel_not_found` for a private channel, means the persona's app isn't in that channel: invite the app to it, or have the persona use a channel its app is in. A target that is neither a channel ID nor an allowed DM target is refused before any Slack call, with the tool error `Persona "<name>" (key=<key>) may not target "<target>": it is neither a channel ID nor an allowed DM target.` In declarative mode a channel the persona doesn't list is refused before any Slack call instead, with `… may not target "<target>": it is not one of the persona's configured channels.` |
| `[slack] persona-destination-hold: more than 20 notices held for "<name>" (key=<key>) while its destination fails — oldest held notice dropped, not posted: <first line>` | The persona's destination has been failing for a while (see [`persona-destination-failed`](#persona-destination-failed)) and more than 20 notices are waiting. The oldest is dropped; the line shows its first line. Fix the destination. |
| `[slack] persona-destination-hold: persona=<key> is no longer applied — <n> held notice(s) dropped, not posted` | The persona was removed from the configuration while notices waited for its failing destination. They are dropped. Nothing to do. |
| `[slack] persona-destination-hold: shutting down — <n> held notice(s) for "<name>" (key=<key>) dropped, not posted` | The server stopped while the persona's destination was failing. Its held notices are lost; its still-open prompts are posted after the next start. Fix the destination (see [`persona-destination-failed`](#persona-destination-failed)). |
| `[slack] persona-destination-hold: hold cancelled — <n> held notice(s) for "<name>" (key=<key>) dropped, not posted` | The persona was removed by a confirmed change, and its held notices were dropped without being posted. Nothing to do. |
| `[slack] persona-destination-hold: persona or client lookup threw for persona=<key>: … — held notices wait and retry with backoff` | An internal error while retrying the persona's held notices. They keep waiting and are retried with backoff. Report it as a bug, with the persona's lines around it. |
| `[slack] Fatal: configuration error — …` | There was no last-applied record, and the server refused `config.json` and exited. See [Configuration rejections](#configuration-rejections). |
| `[slack] Fatal: last-applied record error — …` | The server couldn't read or validate its last-applied record and exited. See [The last-applied record can't be read or is invalid](#the-last-applied-record-cant-be-read-or-is-invalid). |
| `[<timestamp>] [retired-keys-unreadable] The retired-key record "<path>" …` | The server couldn't read, parse or validate its retired-key record and exited 1. See [The retired-key record can't be read or is invalid](#the-retired-key-record-cant-be-read-or-is-invalid). |
| `[slack] Starting from the last-applied record "<path>"` or `[slack] No last-applied record: recorded the configuration file "<path>" as "<path>"` | Which configuration a start runs. See [The last-applied record](#the-last-applied-record). |
| `[slack] agent-director version re-check: the runtime re-check could not run: <description>; the server keeps running and checks again at the next 120 s re-check` | The server's 120 s check of the agent-director binary couldn't run: the binary is missing, unreadable, unreachable, or didn't answer within 30 s. `<description>` says which (an error name such as `ErrSystemInstallUnreachable (reason <reason>, binary at <path>)`, or `no answer within the 30 s time limit`). Nothing changes: the server keeps running and checks again every 120 s. One line per run of failures: the first failure after start, or after a check that passed, logs it, and the failures after it log nothing until a check passes. Nothing goes to `startup-errors.log` or Slack. If the line keeps coming back, check that the agent-director binary is present and executable. If a later check finds a version the server refuses, the server stops as in [Found while the server was running](#found-while-the-server-was-running). |
| `[slack] agent-director settings: the [tmux] values in effect from "<path>": pending_grace_seconds <n> s, stopping_window_seconds <n> s, starting_session_seconds <n> s, sweep_budget_seconds <n> s, query_timeout_ms <n> ms, action_timeout_ms <n> ms, create_timeout_ms <n> ms, pipe_close_wait_ms <n> ms, kill_exit_wait_ms <n> ms (b.jg5 SRJ-209, SRJ-1014)` | The nine agent-director timing settings the server uses: written at its first accepted read of the settings file and whenever one of the nine changes. Nothing to do; see [agent-director's timing settings](#agent-directors-timing-settings). |
| `[slack] agent-director settings: the read of "<path>" was refused: <reason>; <kept> stay in effect until a read is accepted (b.jg5 SRJ-209)` | The server refused agent-director's timing settings file and keeps its last accepted values (`the defaults` at start). One line per run of refused reads. See [agent-director's timing settings](#agent-directors-timing-settings). |
| `[slack] agent-director settings: agent_director_call_timeout_ms is <value>, at or below its need of <need> ms (the <verb> ceiling plus the 15000 ms margin): a call can time out while its verb still acts; see the README's switch-over runbook, section "Switching over to agent-director Phase 1" (b.jg5 SRJ-213)` | Written once per start, before any persona is brought up. The call timeout is at or below the need that agent-director's timing settings give, so an agent-director call can end in an error while its verb still acts. The server still starts and no value changes. Fix: with the operator's say-so, raise the setting in `config.json` and confirm it. See [The call timeout](#the-call-timeout). |
| `[slack] agent-director settings: agent_director_call_timeout_ms is <value>; its need is unknown: [pause] timeout_seconds holds <found>, a value that is not used, so pause's wait is not counted and the need without it is <need> ms; see the README's switch-over runbook, section "Switching over to agent-director Phase 1" (b.jg5 SRJ-213)` | Written once per start, in place of the line above, whatever the setting is. `[pause] timeout_seconds` holds a value that is not used (see below), so `pause`'s wait, and so the need, can't be known. The server still starts and no value changes. Fix: the operator gives it a positive whole number, or removes it for the 30 s default, then checks the setting against the need. See [The call timeout](#the-call-timeout). |
| `… launch after its bring-up retry failed: …`, `… working-directory retry failed: …`, `… handling its change from up to <outcome> failed: …`, `persona … not brought up: Slack bring-up threw: …`, `persona <step> failed: personas[<i>] …`, `persona-destination-hold: retry of held notices failed for persona=<key>: …`, `persona-destination-hold: notice failure callback threw for persona=<key>: …`, `unhandled rejection (process keeps running): …` | An internal error. The server keeps running. Report it as a bug, with the persona's lines around it. |

---

## A precheck failed: nothing was stopped

`stop --stop-bots` and `clean_restart` check agent-director before they stop
anything: they connect to it, then, for each persona in the last-applied
record (else `config.json`), read its instance `cscb_<key>` and, when it is
running, one line of its screen. A persona with no instance or a finished
one is skipped. When the check fails, the command stops nothing and exits 1.

- **Lines:** one line per persona it could not check, in configuration
  order, then the closing line:

  ```text
  <command>: precheck failed for persona "<name>" (key=<key>), session "slack_bot_<key>": <CLASS>: <description>
  <command>: nothing was stopped
  ```

  `<command>` is `stop --stop-bots` or `clean_restart`. `<description>` is
  agent-director's error name and its description, redacted and on one line
  (see [The server log](#the-server-log)). When it could not connect to
  agent-director at all, there is no per-persona line: it prints
  `[slack] <command>: agent-director initialization failed: <failure>`,
  then `<command>: nothing was stopped`. For `clean_restart`, a binary the
  startup gate refuses fails here too; `stop --stop-bots` fails here only on
  a refusal other than the client's too-old one (see
  [The two CLI commands on an old binary](#the-two-cli-commands-on-an-old-binary)).
- **Where:** on the terminal. `clean_restart` also writes them to
  `clean_restart.log` in the state directory. Neither command writes them to
  `server.log` or `startup-errors.log`.
- **Effect:** nothing was stopped: the server and every bot keep running as
  before. The check latches nothing, posts no notice and writes no record.
  A conflicting-labels note on an instance fails nothing on its own.
- **Fix:** fix the cause the class names, below, then, with the operator's
  say-so, run the command again.

| Class | Meaning | Cause | Fix |
|---|---|---|---|
| `CONFLICT` | agent-director refuses the persona's tmux session because of a session conflict. | A session left over from an earlier launch, or another session, holds the persona's session name. | As under [A persona posts a Held: tmux session conflict notice](#a-persona-posts-a-held-tmux-session-conflict-notice). |
| `UNUSABLE_NAME` | The tmux session name recorded on the persona's row can't be used. | agent-director's store was edited by hand. | As under [A persona posts a Held: unusable tmux session name notice](#a-persona-posts-a-held-unusable-tmux-session-name-notice). |
| `CONFIG` | agent-director refuses its config file. The description starts `agent-director refuses its config file ~/.agent-director/config.toml:`. Not retried. | `~/.agent-director/config.toml` is malformed. | As under **agent-director refuses its config file** in [agent-director refuses a persona](#agent-director-refuses-a-persona-it-is-retried-on-its-own). |
| `ENVIRONMENT` | tmux can't be used for the persona. | tmux is missing or not usable on the host. | As under **tmux isn't available** in [agent-director refuses a persona](#agent-director-refuses-a-persona-it-is-retried-on-its-own). |
| `UNAVAILABLE` | agent-director didn't answer after 3 tries, 2 s apart. | It is unreachable, it timed out, or it gave an error name this agent-director client doesn't recognise. | As under [agent-director can't report a persona's state](#agent-director-cant-report-a-personas-state); a call that keeps timing out may need a longer call timeout ([The call timeout](#the-call-timeout)). |
| `UNCLASSIFIED` | An answer the check doesn't handle. | An `ErrInternal` that isn't an unusable session name; a store agent-director can't open (`ErrSchemaMismatch`, `ErrSchemaMigrationRequired`, `ErrStoreOpen`); `ErrSystemInstallDisappeared`; any other error name agent-director reports; or an answer the check gives no meaning: a STATE name other than `ErrSpawnNotFound`, a LAUNCH FAILURE or a DIRECTORY answer, from either call, or a GONE answer to the `get`. A GONE answer to the `read-pane` passes the persona. | Report the line to the operator as written; take no action on it. |

A passed check doesn't prove that the session running under a persona's
name is that persona's own: the teardown that follows acts only on the
persona's own launch.

## `stop --stop-bots` or `clean_restart` could not stop a persona

After a passed precheck, `stop --stop-bots` and `clean_restart` stop the
server, then tear every persona down in parallel: pause, wait up to
`exit_timeout` for the bot to exit, then force-kill. Once every persona's
teardown has finished, the command reports each persona in configuration
order.

- **Failure line:** one per persona it could not stop:

  ```text
  <command>: could not stop persona "<name>" (key=<key>), session "slack_bot_<key>": <CLASS>: <description>
  ```

  `<command>` is `stop --stop-bots` or `clean_restart`. `<description>` is
  agent-director's error name and its description, redacted and on one line
  (see [The server log](#the-server-log)); a CONFIG one starts
  `agent-director refuses its config file ~/.agent-director/config.toml: `.
  The line has no `[slack]` prefix.
- ***Kill failed* after it:** when the force-kill failed because
  agent-director could not end the worker, or failed in any way after an
  earlier try named a process that outlived the kill, the failure line is
  followed by the *Kill failed* text, led by
  `persona "<name>" (key=<key>) (CLI teardown, <command>): ` and ending
  `The CLI does not retry this kill: once the worker is ended, run the
  command again.` The worker may still be running.
- ***Process outlived kill*:** a persona whose force-kill ended as a
  success after an earlier try named a surviving process counts as stopped.
  It gets no failure line and is not counted; the *Process outlived kill*
  text is printed instead, led the same way and ending `This persona's
  teardown has finished; nothing in CSCB checks this process again.` It
  changes no exit status, and on `clean_restart` the server is started as
  usual.
- **Last line:** when at least one persona could not be stopped, after
  every persona's lines (for `clean_restart`, after the restart's outcome,
  below):

  ```text
  <command>: could not stop <N> persona(s); rows are never deleted, so running the command again is safe
  ```
- **Where:** every line is printed on the terminal (stderr) once;
  `clean_restart` also writes it to `clean_restart.log`. The failure lines
  and the two notice texts are also appended to `server.log` in the state
  directory (the server is stopped, so the command writes it, timestamped and
  rotated as the server does) and recorded in `startup-errors.log`, one entry
  per persona: `cli-teardown-failed` for a failure line alone,
  `persona-kill-failed` for a failure line and its *Kill failed* text (both
  on one line), `persona-kill-survivor` for a *Process outlived kill* text.
  The last line goes to neither file. A `server.log` write
  that fails prints one `[slack] <command>: could not append a line to
  server.log: …` line (on the terminal for `stop --stop-bots`, in
  `clean_restart.log` only for `clean_restart`); a `startup-errors.log`
  write that fails prints `[<time>] [startup-errors] WARNING: could not
  write to <path>: …` on the terminal (both under
  [Other lines you may see](#other-lines-you-may-see)). Neither changes the
  print, the other file or the exit status.
- **Effect:** both commands exit 1. `stop --stop-bots` never starts the
  server: it stays stopped. `clean_restart` then decides whether to start
  it (below). Every row is kept. Nothing is posted to Slack, and the
  command itself holds or latches nothing.
- **Fix:** fix the cause the class names, below. When a *Kill failed* text
  follows the line, a human deals with the worker by following the
  "Operator actions" section of agent-director's README; this skill
  describes no step of it and takes none. Then, with the operator's say-so,
  run the command again.

| Class | Meaning | Cause | Fix |
|---|---|---|---|
| `UNAVAILABLE` | agent-director didn't answer, or couldn't act right now. A read of the instance fails at once; a force-kill fails after 3 tries, 2 s apart, with a read before each further try. | It is unreachable or timed out; or the force-kill could not end the worker (`ErrTmuxKillFailed`, with the *Kill failed* text after the line) or tmux did not answer (`ErrTmuxUnresponsive`); or it gave an error name this agent-director client doesn't recognise. | As under [agent-director can't report a persona's state](#agent-director-cant-report-a-personas-state); a call that keeps timing out may need a longer call timeout ([The call timeout](#the-call-timeout)). For a *Kill failed* text, see [A persona posts a Kill failed or Process outlived kill notice](#a-persona-posts-a-kill-failed-or-process-outlived-kill-notice). |
| `CONFLICT` | agent-director refused the pause or the force-kill because of a tmux session conflict; no further force-kill follows. | A session left over from an earlier launch, or another session, holds the persona's session name. | As under [A persona posts a Held: tmux session conflict notice](#a-persona-posts-a-held-tmux-session-conflict-notice). The command holds nothing. |
| `UNUSABLE_NAME` | The tmux session name recorded on the persona's row can't be used. | agent-director's store was edited by hand. | As under [A persona posts a Held: unusable tmux session name notice](#a-persona-posts-a-held-unusable-tmux-session-name-notice). The command holds nothing. |
| `CONFIG` | agent-director refuses its config file, at any step or at the read before a further force-kill. No further force-kill follows. | `~/.agent-director/config.toml` is malformed. | As under **agent-director refuses its config file** in [agent-director refuses a persona](#agent-director-refuses-a-persona-it-is-retried-on-its-own). |
| `ENVIRONMENT` | tmux can't be used for the persona. | tmux is missing or not usable on the host. | As under **tmux isn't available** in [agent-director refuses a persona](#agent-director-refuses-a-persona-it-is-retried-on-its-own). |
| `GONE` | The force-kill answered that the persona's tmux session is already gone (`ErrTmuxSendKeys`, `ErrTmuxCaptureFailed`). A force-kill should not give this answer, so the command cannot confirm that the bot stopped. | Not known from the line. | Report the line to the operator as written; take no action on it. The one-line `read-pane` check under [Listing instances](#listing-instances), with its caveats, is read-only. |
| `UNCLASSIFIED` | An answer the teardown doesn't handle. | An `ErrInternal`; a store agent-director can't open (`ErrSchemaMismatch`, `ErrSchemaMigrationRequired`, `ErrStoreOpen`), never retried; any other error name agent-director reports. | Report the line to the operator as written; take no action on it. |
| `STATE`, `DIRECTORY`, `LAUNCH_FAILURE` | An answer to the force-kill, or to a read of the instance, that does not fit it. | Not known from the line. | Report the line to the operator as written; take no action on it. |

Only some steps print lines of their own: the force-kill's try, read and
end lines (under [A kill that is tried again](#a-kill-that-is-tried-again))
and `[slack] teardownBots: pause failed for persona <ref> — escalating to
kill: …`. A failure line with no kill lines before it came from the state
read, the pause or the poll, which print nothing of their own. These lines
are on the terminal for `stop --stop-bots`, in `clean_restart.log` for
`clean_restart`.

**`clean_restart`'s restart after a failed teardown.** While agent-director
answers, a persona it could not stop never leaves every bot down. Once every persona's lines are out,
`clean_restart` checks that agent-director answers: one list of CSCB's
instances, up to 3 tries, 2 s apart, any error a failed try. Each failed
try writes one line to `clean_restart.log` only:

```text
[slack] clean_restart: agent-director answer check: list try <n> of 3 failed: <CLASS>: <description>
```

- **agent-director answered:** `clean_restart.log` shows
  `[slack] clean_restart: agent-director answers — starting server after the failed teardown`,
  then `[slack] clean_restart: starting server`, and the server is started
  as at any start. In `server.log`, look for the new start and each
  persona's own lines (`grep -F '(key=<key>)'`): the new server keeps a
  configured persona's own instance that is still running, the one the
  command could not stop included, and a persona whose launch meets a tmux
  session conflict is held (see
  [A persona posts a Held: tmux session conflict notice](#a-persona-posts-a-held-tmux-session-conflict-notice)).
  A start that fails prints
  `[slack] clean_restart: start failed with exit code <n>` on the terminal
  and records no `clean-restart-not-restarted` entry; the reason is in
  `server.log`.
- **agent-director did not answer:** the server is not started, so nothing
  starts on top of bots the command could not reach. One alert for the run
  is printed, appended to `server.log` and recorded as one
  `clean-restart-not-restarted` entry (below).

Either way the last line follows and the exit is 1.

Read-only checks:

```sh
STATE="${SLACK_STATE_DIR:-$HOME/.claude/channels/slack}"
grep -h -E 'could not stop persona|\(CLI teardown, ' "$STATE"/server.log.* "$STATE"/server.log 2>/dev/null | sort
grep -h -E '\[(cli-teardown-failed|persona-kill-failed|persona-kill-survivor|clean-restart-not-restarted)\]' "$STATE"/startup-errors.log
grep -h -E 'teardownBots|clean_restart' "$STATE"/clean_restart.log | tail -n 60
agent-director get --claude-instance-id cscb_<key>
```

The classes only these commands write:

| Class | Cause | Fix |
|---|---|---|
| `cli-teardown-failed` | `stop --stop-bots` or `clean_restart` could not stop a persona, and no *Kill failed* text follows its line. The entry is the failure line. | Fix the cause its class names, above, then run the command again. |
| `clean-restart-not-restarted` | `clean_restart` could not stop at least one persona, and agent-director did not answer the check after the teardown, so the server was not started. One entry per run: `clean_restart: could not stop persona "<name>" (key=<key>), session "slack_bot_<key>": <CLASS>[; persona …]; agent-director did not answer, so the server was not started: start it once agent-director answers`, naming each persona it could not stop with its session and class. The server, and every bot the teardown did stop, stays down. | Confirm agent-director answers: `agent-director version`, and the list under [Listing instances](#listing-instances). Once it does, with the operator's say-so, start the server: `claude-slack-channel-bots start`. Each failed persona's own line says why it could not be stopped; fix that as above. |

The same commands' `persona-kill-failed` and `persona-kill-survivor` entries
are described under
[A persona posts a Kill failed or Process outlived kill notice](#a-persona-posts-a-kill-failed-or-process-outlived-kill-notice).

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
install. The section opens with the block
["Arrived here from a startup refusal?"](../../README.md#arrived-here-from-a-startup-refusal),
which says what a refused operator does, in order; tell the operator to
follow that block. A bot or this skill never changes the agent-director
install itself, and never starts the server on its own after a refusal. A
running server can stop on the same two classes; that stop is not a
switch-over case and has its own remedy, under
[Found while the server was running](#found-while-the-server-was-running).

**What the block says.** It covers only a refusal before agent-director
Phase 1 is installed on the host, by step 8 of the runbook or otherwise:

- If `config.json` is in persona form and no pre-persona copy of it exists
  (neither step 1's copy nor one the operator kept elsewhere), the operator
  stops there and changes nothing until that file is rebuilt by hand, as
  step 8 of "Rolling back the switch-over" says, then follows the block
  again from its start.
- Otherwise the operator rebuilds by hand the crontable targets and
  `/interject` callers left in persona form where step 1's copy of them is
  missing, then reinstalls and starts the previous CSCB (the version step 1
  recorded, or else the one the host ran before) from step 1's files, a
  pre-persona `config.json` copy the operator kept, or the files in place,
  re-enabling its autostart if it was disabled.
- A host not on agent-director 0.10.0 brings it to 0.10.0 outside the
  runbook; the block gives no command for it.
- Then the operator starts the runbook at step 1. The new server starts at
  step 10 of the runbook, not before.

A refusal at step 10, or at any later start of the new CSCB (an autostart,
`clean_restart` or the restart in step 4 of "Rolling back the switch-over"
included), on a host whose Phase 1 install was step 8's or agent-director's
own install on a publishing host, means the server finds the wrong
agent-director binary: the block's "A refusal after Phase 1 was installed"
gives its binary check and next step, the same as
[Found while the server was running](#found-while-the-server-was-running)
below. A host where Phase 1 was installed in any other way outside the
runbook is not a target of the runbook: the block sends it to "Rolling back
the switch-over" and the item "agent-director was installed outside the
caller's switch-over" in the "Operator actions" section of agent-director's
README.

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
- **Fix:** the operator follows the block "Arrived here from a startup
  refusal?" of the README section "Switching over to agent-director
  Phase 1" (above); the runbook's step 10 starts the new server.

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
- **Fix:** the operator follows the block "Arrived here from a startup
  refusal?" of the README section "Switching over to agent-director
  Phase 1" (above); the runbook's step 10 starts the new server.

### Found while the server was running

A running server re-checks the agent-director binary every 120 s, on its own
timer: `health_check_interval` `0` turns off the health check, not this
re-check. A binary that fails either check above stops the server with a
non-zero exit. `startup-errors.log` and `server.log` get one line of the
same class, `ad-below-phase1-floor` or `ad-system-install-too-old`. It
names the versions and the binary path as at start, but says:

```text
found by a runtime re-check while the server was running, so the server stopped
```

in place of the floor entry's "found by the startup check" (for the too-old
entry, right after the binary path), and it points here instead of to the
README section or the install skill. The floor entry ends:

```text
Note: this CSCB release requires agent-director Phase 1 or later; see the debug skill (skills/debug-slack-channel-bots/SKILL.md), section "Found while the server was running", for what to do.
```

and the too-old entry ends:

```text
This CSCB release and agent-director Phase 1 are installed together; see the debug skill (skills/debug-slack-channel-bots/SKILL.md), section "Found while the server was running", for what to do.
```

with no install-skill block after it. `server.log` then shows
`[slack] Shutting down: the runtime version re-check refused the agent-director binary (see startup-errors.log)`
and, last, `[slack] Shutdown complete` (or, if the shutdown hung,
`[slack] Shutdown did not complete within 30 s — exiting with code 1`; a
shutdown that hung with nothing left open ends with neither line, still with
exit code 1).

- **Cause:** the agent-director binary the server finds is not the one the
  running server started with: it was swapped, while the server ran, for an
  older build or one that fails the check (such as a `0.0.0-dev`
  development build). The server finds
  `$HOME/.agent-director/bin/agent-director` first, then the first
  `agent-director` on `PATH`.
- **What the stop did not do:** the shutdown made no agent-director call. No
  bot was killed, paused or deleted, and every agent-director row is as it
  was: the bots keep running, but nothing serves them until the server is
  back. Nothing was posted to Slack.
- **A stop while the server was still starting:** the start's clean-up of
  old instances ends early. It makes no further agent-director call, what it
  already did stands, and it deletes no row. Its last `reconcileOrphans`
  line is its summary, after either its `the server began shutting down —
  the sweep stops` line or, when a clean-up kill's own re-check found the
  binary, that kill's `kill tries for <row> (start sweep) were stopped: the
  version re-check decided that the server stops; …` line, never both. An
  answer that comes in after the stop is not acted on: no persona is held,
  no outage is raised and nothing is cleared (see
  [A server start's clean-up of old instances](#a-server-starts-clean-up-of-old-instances)).
  No later start step runs, and no persona is brought up.
- **A stop while the start was launching personas:** no persona still
  waiting for its turn to launch is launched. Each logs
  `[slack] startupSessionManager: not launching "<name>" (key=<key>) — the server has begun shutting down; no agent-director call, counted in no summary count (b.jg5 SRJ-205)`
  and is counted in none of the start summary's counts, never as failed. A
  launch already under way is not interrupted.
- **Fix:** a human's. A bot or this skill never changes the agent-director
  install itself, and never starts the server without the operator's
  say-so.
  1. **Check the binary.** The server finds
     `$HOME/.agent-director/bin/agent-director` first, then the first
     `agent-director` on `PATH`. Take the binary path the startup-errors
     entry names and run `<path> version`, as the workers' user in the bot
     server's launcher environment.
  2. **Then either put agent-director Phase 1 back, or roll back.**
     - To put agent-director Phase 1 back as the binary the server finds:
       every agent on the host and every long-running agent-director
       process (`agent-director serve` included) is stopped before that
       binary change and started again after it. CSCB's own bots, which
       the stop left running, are stopped by a human through the item
       "Stopping a set of agents before a binary change" in the "Operator
       actions" section of agent-director's README; this skill names no
       command for it. Once the server finds Phase 1, start CSCB.
     - If the host is being rolled back, follow
       ["Rolling back the switch-over"](../../README.md#rolling-back-the-switch-over),
       which starts the previous CSCB.

  Installing agent-director Phase 1 migrated agent-director's store, so
  never reinstall the old CSCB onto it.
- **At the restart in step 4 of "Rolling back the switch-over":** an agent
  that could not be stopped still runs, so put nothing back and don't follow
  the rollback runbook again. The new CSCB stays stopped until
  agent-director has dealt with that agent (as rollback step 4 says); then
  this remedy applies.

### The two CLI commands on an old binary

`stop --stop-bots` and `clean_restart` connect to agent-director before they
stop anything. They treat the two classes differently:

| Binary | `stop --stop-bots` | `clean_restart` |
|---|---|---|
| Below CSCB's Phase 1 floor, accepted by the client (`ad-below-phase1-floor` at start) | Works as usual: it makes no version check of its own, so the precheck and the teardown run through that binary and every bot is stopped. | Stops nothing: its connection runs the same checks as the server's start and fails (see [A precheck failed: nothing was stopped](#a-precheck-failed-nothing-was-stopped)). Exit 1. |
| Below the client's own minimum (`ad-system-install-too-old`) | Stops the server only, as below. Exit 1. | Stops nothing, as above. Exit 1. |

So an operator on an agent-director older than Phase 1 can stop the bots
with `stop --stop-bots` before the switch-over; `clean_restart` needs the
switch-over first.

`bun run install-check` passes a binary below CSCB's Phase 1 floor that the
client accepts only with a `note`: the version found and CSCB's floor (its
release candidates included), that the server refuses to start on it until
agent-director Phase 1 is installed, and the README section
["Switching over to agent-director Phase 1"](../../README.md#switching-over-to-agent-director-phase-1)
(see
[Checking your agent-director install](../../README.md#checking-your-agent-director-install)).
The note names no command. A binary that passes
with it is still refused at start as `ad-below-phase1-floor`. The operator
follows that README section; this skill runs nothing for the note.

**`stop --stop-bots` on a binary the client refuses as too old.**

- **Lines** (terminal only):

  ```text
  [slack] stop --stop-bots: agent-director initialization failed: agent-director startup gate failed (ad-system-install-too-old): <too-old message>
  <the server stop's own lines>
  stop --stop-bots: only the server was stopped; every worker and row was left as it is
  ```

  The too-old message is the one described under
  [`ad-system-install-too-old`](#ad-system-install-too-old): it names the
  version found, the version required and the README section "Switching
  over to agent-director Phase 1".
- **Meaning:** no agent-director call could be made, so only the server was
  stopped. No bot was checked, paused or killed, and every bot and its
  agent-director row is as it was. The command exits 1 whatever the server
  stop did, and whether or not the configuration could be loaded. The server
  stop's lines tell whether the server is really down: `[slack] Server
  stopped.`, `[slack] Server killed.` or `server is not running` mean it is;
  `[slack] Warning: server did not die after SIGKILL.` means it is still
  running, though the last line still prints; `[slack] Could not read PID
  file: …` means the PID file could not be read, so the server's state is
  unknown.
- **Cause:** the system-installed binary is older than the minimum the
  agent-director client accepts.
- **Fix:** the operator follows the README section "Switching over to
  agent-director Phase 1". A bot or this skill never changes the
  agent-director install itself.

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
- **The values line:** the server's first accepted read (a missing file
  counts) writes the nine `[tmux]` values it uses to `server.log`, and so
  does each later accepted read that changes any of the nine:

  ```text
  [slack] agent-director settings: the [tmux] values in effect from "<path>": pending_grace_seconds <n> s, stopping_window_seconds <n> s, starting_session_seconds <n> s, sweep_budget_seconds <n> s, query_timeout_ms <n> ms, action_timeout_ms <n> ms, create_timeout_ms <n> ms, pipe_close_wait_ms <n> ms, kill_exit_wait_ms <n> ms (b.jg5 SRJ-209, SRJ-1014)
  ```

  Each `<n>` is the value in effect after the default rule, so a missing
  key or `0` shows its default. A read that changes nothing, a change of
  `[pause] timeout_seconds` alone and a refused read write no values line.
  Nothing goes to `startup-errors.log` or Slack. A refused read keeps the
  values in effect, so the last values line in `server.log` since the
  server started shows what it uses now.
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
- **How to check:** start from the last values line in `server.log`: it
  shows the values in effect and the path read. Then read the file at
  `<path>` and compare the `[tmux]` table with the rules above. The reason names only the first broken rule, so
  check the others too.
- **Fix:** the operator's. This skill never edits the file. Once the file is
  fixed, the server picks it up within about 120 s, with no restart.
- **Who decides:** agent-director's own answers always decide. The server's
  reading of the file never overrides what agent-director does or reports.
- **What `pending_grace_seconds` sets on the server's side:** how long and
  how often the server watches a just-launched instance to answer its
  startup prompts. It watches for at most the later of 5 minutes and
  `pending_grace_seconds` plus 60 s, counted from the launch's start (5
  minutes at the default 60; 6 minutes at 300). It checks once a second,
  then once every 5 s once `pending_grace_seconds` has passed since the
  launch's start. The value in effect is used at each check, so a change is
  used within about 120 s, as above. The same value sets when the persona's
  retries start checking a still-starting instance with agent-director
  (once `pending_grace_seconds` has passed since its launch's start) and
  when the *Session not starting* notice can be posted (at that same later
  of 5 minutes and `pending_grace_seconds` plus 60 s); see
  [A persona posts a Launch stuck or Session not starting notice](#a-persona-posts-a-launch-stuck-or-session-not-starting-notice).

### The call timeout

`agent_director_call_timeout_ms` in `config.json` (default 60000 ms) bounds
how long CSCB waits on each agent-director call it makes for a persona. A call
that runs past it ends in an error while agent-director may still be carrying
out the verb. A launch that times out this way is followed by one read of the
persona's row and is never launched over (see
[A launch that timed out](#a-launch-that-timed-out)). The server takes it from the configuration its start runs;
`stop --stop-bots` and `clean_restart` take it from the last-applied record
(else `config.json`), and `stop --stop-bots` uses the default when it can't
read that configuration.

- **When the server checks it:** once per start, right after it reads
  agent-director's settings and before any persona is brought up. It writes
  at most one of the two lines in
  [Other lines you may see](#other-lines-you-may-see), never refuses to start
  and changes no value. It doesn't check again until the next start.
- **How to check:** compare the setting in effect (the last-applied record's
  value, else `config.json`'s, else 60000) with the need. The need is the
  largest ceiling among the verbs CSCB calls, computed from the host's
  `[tmux]` values and, for `pause`, `[pause] timeout_seconds`, plus 15 s. The
  README section "Sizing the agent-director call timeout", under
  "Configuration", has the formulas. At agent-director's defaults the need is
  54000 ms, set by `pause` (9 s plus its 30 s wait, plus 15 s). With
  `create_timeout_ms` 40000 (with `pending_grace_seconds` 61) it is 60900 ms,
  set by the launch ceiling that `resume`, a spawn with reuse and a plain
  spawn share (the line names `resume/spawn-with-reuse/plain-spawn`); with
  `[pause] timeout_seconds` 60 it is 84000 ms. The setting must be greater
  than the need.
- **`[pause] timeout_seconds` values that are not used:** `0`, a negative
  number, a number above 2^63 − 1, any value that isn't a whole number, or a
  `pause` that isn't a table. A missing file, table or key means 30 s. `<found>`
  in the line gives the number, or the kind of value, never the file's text.
- **Fix:** the operator's. With the operator's say-so, raise
  `agent_director_call_timeout_ms` in `config.json` above the need and confirm
  the change (see [Confirming a pending change](#confirming-a-pending-change)).
  `stop --stop-bots` and `clean_restart` use it at once; the server uses it at
  its next start or a `clean_restart`. For an unused `[pause] timeout_seconds`,
  the operator gives it a positive whole number or removes it. This skill
  never edits `config.toml`.

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
(a bad channel ID, `dm.contact`, `permission_prompts` or
`invited.permission_prompts`) is never echoed, and neither is a rejected
`allow_invited_channels`, and
no message shows a `bot_token` or `app_token` value. Messages do quote
persona names (as written) and keys, channel IDs, the configuration file's path and, in the duplicate-path rules, the
persona paths. An unknown key's name is quoted only when it is a plain setting
name (letters and underscores, up to 48 characters); any other unknown key is
counted instead, since it could be a pasted token. A name with a digit, such
as `channels2`, is therefore not shown. After a fix, start the server again.

**Each mode has its own persona rules.** The switch `allow_invited_channels`
is checked with the server-wide settings, before any persona entry, and the
mode it picks sets which rules each entry is checked by: declarative mode
(absent or `false`) checks `channels` and the top-level
`permission_prompts`, fungible mode (`true`) checks `invited`. Each mode
leaves the other section unchecked and unread, so a malformed `invited`
loads in declarative mode, and malformed `channels` or `permission_prompts`
load in fungible mode. `dm` and the rules [across personas](#across-personas)
apply in both modes. A pending change is judged by the mode its own switch
picks, not the mode in force: an edit that turns fungible mode on or off
can give an `INVALID` preview for a persona section that loaded until then
(see [`reload-invalid`](#reload-invalid)). The README's
[Load-time rules](../../README.md#load-time-rules) list each mode's rules.

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
| `allow_invited_channels must be a boolean.` | The channel-mode switch is a string, a number, `null`, an object or an array. Its value is never shown. Checked in either mode, after the other server-wide settings and before any persona entry. | Use `true` (fungible mode) or `false`, or remove the key (declarative mode). See [Channel modes](../../README.md#channel-modes). |

### Persona entries

The **Mode** column says which mode checks the rule: *both*, *declarative*
(`allow_invited_channels` absent or `false`) or *fungible* (`true`). A rule
of one mode is never checked in the other.

| Message (after the persona prefix) | Mode | Cause | Fix |
|---|---|---|---|
| `personas[<i>] must be a JSON object, got <type>.` | both | An array element isn't an object. | Make it a persona object. |
| `unknown field(s) in the persona entry: "<key>".`, `… in dm: …`, each possibly with `1 field whose name is not shown …` or `plus <n> fields whose names are not shown …` | both | A key the schema doesn't have, at that level. As at the top level, only plain setting names are shown; others (a digit, as in `channels2`, a dash, a pasted token) are counted. `channels`, `permission_prompts` and `invited` are known persona-entry keys in both modes. | Remove or correct it. For an unshown field, compare that entry's keys with the persona keys in the README. |
| `unknown field(s) in channels[<j>]: …`, with the same forms | declarative | A key a channel entry doesn't have. | Remove or correct it. |
| `invited must be a JSON object, got <type>.` | fungible | `invited` is a string, a number, an array or another non-object. | Make it an object, `{"permission_prompts": "<channel ID or dm>"}`, or remove it to use the default `"dm"`. |
| `unknown field(s) in invited: "<key>".`, with the same forms as the persona entry's | fungible | `invited` holds a key other than `permission_prompts`. | Remove or correct it. |
| `name is required.` / `name must be a non-empty string.` | both | Missing or blank name. Any other name is accepted: there is no format rule. | Give the persona a name. |
| `credentials_file is required.` / `working_directory is required.` | both | Missing path. | Add it. |
| `<setting> must be an absolute path, "~" or a path starting with "~/".` | both | `credentials_file`, `working_directory` or `claude_config_dir` is relative (or not a string). | Use an absolute path or `~/…`. |
| `stop_hook_bootstrap must be a boolean.` / `dm.enabled must be a boolean.` | both | Wrong type. | Use `true` or `false`. |
| `dm must be a JSON object, got <type>.` | both | Wrong shape. | Fix the shape. |
| `channels must be an array, got <type>.` / `channels[<j>] must be a JSON object, got <type>.` | declarative | Wrong shape. | Fix the shape. |
| `channels[<j>].id is required.` / `channels[<j>].delivery is required.` | declarative | A channel entry lacks a key. | Every channel needs `id` and `delivery`. |
| `channels[<j>].id must be a Slack channel ID matching ^[CG][A-Z0-9]+$.` | declarative | Malformed channel ID (a name, a lower-case ID, a URL). | Use the channel ID, e.g. `C0123ABCD`. |
| `channels[<j>].delivery is invalid. Allowed values are: all, mentions.` | declarative | Bad delivery value. | `all` or `mentions`. |
| `channel <id> is listed more than once (channels[<a>] and channels[<b>]).` | declarative | One persona lists a channel twice. | Keep one entry. (Several personas may list the same channel.) |
| `dm.contact must be a Slack user ID matching ^[UW][A-Z0-9]+$.` | both | Malformed `dm.contact`. | Use a user ID, e.g. `U0123ABCD`. |
| `permission_prompts is required: set it to "dm" or one of the persona's channel IDs.` | declarative | Missing. | Add it. |
| `permission_prompts must be "dm" or a Slack channel ID matching ^[CG][A-Z0-9]+$.` | declarative | Malformed value. | Use `"dm"` or a channel ID. |
| `invited.permission_prompts must be "dm" or a Slack channel ID matching ^[CG][A-Z0-9]+$.` | fungible | Malformed fungible destination (a channel name, a lower-case ID, a non-string). Checked after `dm.contact`. | Use `"dm"` or a channel ID. The channel needs no listing: invite the persona's app to it so posts there succeed. |
| `the persona has no channels and dm.enabled is not true, so it can receive no messages. Add a channel or set dm.enabled to true.` | declarative | Zero channels with DMs off. Checked before the two destination rules below. | Add a channel or turn DMs on. |
| `permission_prompts names channel <id>, which is not in the persona's channels.` | declarative | The destination channel isn't one the persona lists. | Add the channel to its `channels`, or pick one it lists. |
| `permission_prompts is "dm" but dm.contact is not set` / `… but dm.enabled is not true` / both, joined by `and` | declarative | A `dm` destination needs both. | Set `dm.contact` and `"dm": {"enabled": true, …}`, or use a channel. |
| `invited.permission_prompts is "dm" but dm.contact is not set.` / `… but dm.enabled is not true.` / `… but dm.contact is not set and dm.enabled is not true.` | fungible | An explicit `"dm"` fungible destination needs DMs on and a contact. | Set `dm.contact` and `"dm": {"enabled": true, …}`, or set `invited.permission_prompts` to a channel ID. |
| `invited.permission_prompts is not set, so it is "dm" by default, but dm.contact is not set.` / `… but dm.enabled is not true.` / `… but dm.contact is not set and dm.enabled is not true.` | fungible | No `invited.permission_prompts`, so the destination is `"dm"` by default, which needs DMs on and a contact. A persona with DMs off and no contact needs a channel destination in fungible mode. | Set `invited.permission_prompts` to a channel ID, or set `dm.contact` and `"dm": {"enabled": true, …}`. |

In fungible mode no rule asks a persona for a way to receive: a persona with
DMs off, no `channels` and a channel fungible destination loads, and receives
from the channels its app is invited to.

### Across personas

Checked only after every entry is valid, in both channel modes, with the
same messages. The two shared-path rules below are
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
| `key dev_2 starts with the key of personas[0] "dev" (key=dev). tmux matches a session target by prefix unless it is written with =, so a human's tmux command without = for one persona (for example tmux attach -t slack_bot_dev) could reach slack_bot_dev_2. No persona's key may start with another persona's key: rename one of the two so that neither key starts with the other. For example, rename personas[0] "dev" (key=dev) to "dev_main" (key=dev_main).` (for `dev`, then `dev_2`) / `key <key> is the start of the key of personas[<j>] …. …` (the longer key first) | One persona's key starts with another's: `dev` and `dev_2`, `horde` and `horde_admin`, or `dev` and `"Dev Bot"` (key `dev_bot_…`). tmux matches a session target by prefix unless it is written with `=`, so a human's tmux command without `=` for one persona (for example `tmux attach -t slack_bot_dev`) could reach another persona's session. Checked in the last-applied record too. | Rename one so that neither key starts with the other. The `For example` sentence, when there is one, is a name for the persona with the shorter key that fits every other persona: its key plus `_main` (`_main_2`, … when that is taken). Keys that only share a start, such as `dev_a` and `dev_b`, are fine. For a record, fix `config.json` first, then delete the record. |
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
changed credentials counts in both. A persona whose only change is recorded
(a change to the section its mode doesn't read) counts nowhere.
`allow_invited_channels` counts under `server-wide settings`.

**Line order and kinds.** After the header: removals, destructive modifies,
additions, other changed personas (in `config.json` order), recorded
changes (in `config.json` order), then server-wide settings, the switch's
line among them.

| Line | Meaning |
|---|---|
| `DESTRUCTIVE: persona "<name>" (key=<key>) is removed: the persona will be retired: its session stopped and never resumed.` | The persona is gone from `config.json`. At the confirmation it is retired: its session is stopped and never resumed. Renaming a persona changes its key, so a rename shows as this line for the old name plus an `is added` line for the new one. |
| `DESTRUCTIVE: persona "<name>" (key=<key>) working_directory changed to "<path>": the persona will be retired and brought up fresh: its session stopped and never resumed.` | Its `credentials_file` or `working_directory` (compared by real path) changed, or its `name` changed without changing its key (`name changed`). Several are joined by ` and `, e.g. `credentials_file changed to "<path>" and working_directory changed to "<path>"`. At the confirmation the persona is retired (its session stopped and never resumed) and brought up fresh: the instance is replaced and loses its session history. |
| `persona "<name>" (key=<key>) is added: it will be brought up and launched.` | A new persona. |
| `persona "<name>" (key=<key>) is added but cannot come up: <cause>; <cause>.` | A new persona whose bring-up would fail now. The causes, in this order, are the credentials and working-directory cause texts under [Persona diagnostic classes](#persona-diagnostic-classes) (for example `credentials file does not exist`, `credentials file is invalid: …`, `working directory does not exist`), then `claude_config_dir cannot be resolved to a real path (<errno>)`, or `(<errno>: a symlink on its path points to nothing)` for a dangling symlink (see [`persona-config-dir-unresolvable`](#persona-config-dir-unresolvable)). Every check runs, so one cause never hides another. A `claude_config_dir` not created yet under an existing parent is not listed. Fix them before the change is applied. |
| `persona "<name>" (key=<key>): <settings> changed: applied in place immediately, instance kept.` | `<settings>` lists one or more of the in-place settings of the mode the edit's own `allow_invited_channels` picks. Declarative mode: `channels` (a channel added or removed), `delivery` (a kept channel's mode), `permission_prompts`. Fungible mode: `invited.permission_prompts` (an absent value and `"dm"` count as the same). Both modes: `dm.enabled`, `dm.contact`. Reordering channels isn't a change. When the same edit turns the switch on or off, the newly selected section counts as changed wherever its JSON differs from before. |
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
| `persona "<name>" (key=<key>): <fields> changed in the <declarative or fungible> section: recorded, with no effect until allow_invited_channels selects <declarative or fungible> mode.` | A change to the section the edit's mode doesn't read: `channels` or `permission_prompts` (the declarative section) while the edit is in fungible mode, or `invited` (the fungible section) while it is in declarative mode. `<fields>` lists the changed keys, such as `channels, permission_prompts`. The change is written into the record at the confirmation and does nothing until the switch selects that section; it is never validated until then. The persona isn't counted as modified. |
| `server-wide setting allow_invited_channels changed: turns <fungible or declarative> mode on, applied in place at once, from the next event, tool call, prompt and notice, for "<name>" (key=<key>), ….` | The channel-mode switch changed. Every persona present before and after the edit is named, in `config.json` order; with none, the line ends `; no persona is affected.` instead. It applies in place at the confirmation, with no restart and every session kept (see [Confirming a pending change](#confirming-a-pending-change)). Writing `false` where the switch was absent is no change. Before turning fungible mode on, review each app's channels and past `unclaimed-channel` lines (see [Turning fungible mode on or off](../../README.md#turning-fungible-mode-on-or-off)). |
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

An edit made only of recorded changes (see the `recorded, with no effect
until …` row above) is also no effective change: its preview is this line
followed by its recorded lines. Confirming it rewrites the record and logs
[`reload-noop`](#reload-noop).

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
  down and brought up fresh from its new entry: its old session is ended,
  its agent-director row kept and its old conversation never resumed, it
  starts a new conversation on the same instance, and the new credentials
  file is read. When the old session could not be ended, the new
  conversation starts only once a later kill of it succeeds (the
  `agent-director kill of cscb_<key> failed` row there).
  See [A persona was added or removed by a confirmed change](#a-persona-was-added-or-removed-by-a-confirmed-change).
- **A kept persona's routing settings**, the preview's `… changed: applied in
  place immediately, instance kept` lines: in declarative mode `channels`, a
  channel's `delivery` and `permission_prompts`; in fungible mode
  `invited.permission_prompts`; `dm.*` in both. See
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
- **The channel-mode switch `allow_invited_channels`**, the preview's
  `server-wide setting allow_invited_channels changed: turns … mode on …`
  line. It is the one server-wide setting applied in place, at once: no
  persona is torn down, brought up, relaunched or reconnected, and every
  persona keeps its instance, conversation, Slack connection and MCP session.
  The mode it turns on applies from the next event, tool call, permission
  prompt and notice. Turning fungible mode on serves, from its next message,
  every public or private channel each persona's app is already in that is
  not externally shared, at `mentions` unless a stored choice applies;
  listed `delivery` values are not carried over. Turning it off returns
  every persona to its `channels` from the next event; stored choices stay
  in `channel-delivery.json` and stop applying. Prompts and notices go to
  the destination of the mode turned on, held ones included, and prompts
  already posted stay answerable. See
  [Channel modes](../../README.md#channel-modes).
- **A recorded change** to the section the mode doesn't read, the preview's
  `recorded, with no effect until …` lines: written into the record, with no
  effect until the switch selects that section.

Next-launch and other server-wide settings are recorded and take effect later (see
[Next-launch and server-wide settings](#next-launch-and-server-wide-settings)).
Never delete the record to apply an edit: the confirmation has already
written the change into it. Deleting the record is only for a server that
can't start (see [Starting without the record](#starting-without-the-record)).

### Next-launch and server-wide settings

A confirmation records these changes in `config.json.last-applied`, and they
take effect later. Until then, each persona keeps running as it was launched,
with the same instance, conversation and Slack connection. The one exception
among server-wide settings is `allow_invited_channels`, which applies in
place at once, with every session kept, from the next event, tool call,
prompt and notice (see
[Confirming a pending change](#confirming-a-pending-change)); it never waits
for a server start.

| Preview line | After the confirmation | To carry it out sooner |
|---|---|---|
| `stop_hook_bootstrap changed` or `claude_config_dir changed` (`takes effect at its next launch`, or a top-level setting `inherited by …`) | Recorded. It reaches each persona at its next launch: when the bot dies (a crash or a failed health check), at a `clean_restart`, at `stop --stop-bots` then `start`, or after a host reboot. A changed `claude_config_dir` makes that launch start a new conversation on the same instance; nothing is deleted, and the old conversation stays in the old directory. | Relaunch the bots: `claude-slack-channel-bots clean_restart`, or `stop --stop-bots` then `start`. Both cut off the bots' current turns. A plain restart reconnects running bots, which is not a launch. |
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
| [`reload-applied`](#reload-applied) | The change was applied. Personas added, removed, destructively modified, changed in place or with a changed credentials file are handled (a credentials file that can't be used logs [`persona-credentials-change-failed`](#persona-credentials-change-failed) and stays pending); `allow_invited_channels` applies at once, in place; next-launch and other server-wide settings are recorded (see [Next-launch and server-wide settings](#next-launch-and-server-wide-settings)). A persona that isn't up has its own class line. |
| [`reload-noop`](#reload-noop) | The change had no effect (whitespace, key order, a default written out); the record now matches `config.json`. Nothing else happens. |
| [`reload-invalid`](#reload-invalid), `the confirmed configuration is invalid, so nothing is applied` | `config.json` was invalid. Nothing is applied and the confirmation is used up. Fix the file, then confirm the new preview. |
| [`reload-stale-confirmation`](#reload-stale-confirmation) | The confirmation didn't match the files as they stand, or couldn't be read. Nothing is applied. |
| [`reload-record-write-failed`](#reload-record-write-failed), `the confirmed change is not applied and stays pending` | The record, the retired-key record written before it, or the stored-choice file (`channel-delivery.json`) written before both, couldn't be written. Nothing is applied; fix the state directory, then confirm again. |
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
  sets the key) has its running instance killed by the start sweep, with the
  result checked. Its agent-director row is kept until agent-director's
  `expire` removes it, and is never resumed. A renamed persona comes up
  fresh under its new key, without its session history. Before any of those
  kills, the start records as retired the old key of each such persona whose
  instance it lists, so adding that persona back later starts it fresh (see
  [Added again or renamed back](#added-again-or-renamed-back)).
- A persona whose `working_directory` changed has its running instance killed
  by the start sweep too, with the result checked and its row kept, and comes
  up fresh in the new directory.
- A changed `credentials_file` only reconnects the persona to Slack with the
  new app; its instance keeps running.
- A setting that takes effect at a bot's launch (`stop_hook_bootstrap`, a
  changed `claude_config_dir`) doesn't reach a bot that kept running. If the
  server is still running, stop it with `stop --stop-bots` instead of `stop`.

With the operator's say-so, stop the server if it is still running:

```sh
claude-slack-channel-bots stop --stop-bots
```

Go on only once the server is stopped. If the command exits 1 with
`stop --stop-bots: nothing was stopped`, nothing was stopped: the server and
every bot still run. Don't delete the record; follow
[A precheck failed: nothing was stopped](#a-precheck-failed-nothing-was-stopped)
first, then run it again. If it exits 1 with `could not stop persona`
lines, the server was stopped and stays stopped (`stop --stop-bots` never
starts it), and those personas may still run; see
[`stop --stop-bots` or `clean_restart` could not stop a persona](#stop---stop-bots-or-clean_restart-could-not-stop-a-persona)
before going on. Otherwise confirm the server is down: `stop` prints
`server is not running`.

```sh
claude-slack-channel-bots stop
```

Then keep a copy of the record if it can be read, delete it and start. Keep
the `.bak` copy until the new configuration runs as intended:

```sh
STATE="${SLACK_STATE_DIR:-$HOME/.claude/channels/slack}"
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

The server couldn't write `config.json.last-applied` durably, or, at a
confirmed apply, a file it writes before that record (the stored-choice file
or the retired-key record). It happens in two places: at a start without a
record, and when a running server applies a confirmed change. The `(<errno>)` part appears only when the error has a
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
(`config.json.apply`) writes, in this order, before it changes anything
else:

1. the stored-choice file, `channel-delivery.json` in the state directory
   (see [The stored-choice file: `channel-delivery.json`](#the-stored-choice-file-channel-deliveryjson)),
   only when the change brings up a persona (an added persona, or the new
   half of a destructive modify) whose key has a drop of its stored choices
   that no write has carried yet (an earlier
   `[slack] channel-delivery: cannot write the drop of persona=<key> …`
   line). The write carries only drops already in force. Otherwise nothing
   is written here;
2. the retired-key record, `retired-keys.json` in the state directory, with
   the keys of the personas the change retires (removed personas, a renamed
   persona's old key, and personas whose `name`, `credentials_file` or
   `working_directory` changed);
3. the record.

- **Line:** one of:
  - `[slack] reload-record-write-failed: cannot write the stored-choice file "<path>" before bringing up a persona whose stored choices were dropped; the retired-key record is not written, the last-applied record "<record path>" is not rewritten, and the confirmed change is not applied and stays pending (b.deo SRI-408; b.jg5 SRJ-804)`:
    the stored-choice file couldn't be written (a write whose directory
    couldn't be synced counts as failed), so neither record was touched.
    The store's own `[slack] channel-delivery: cannot write the drop of persona=<key> in "<path>"<detail>; …`
    line before it carries the error code (see
    [The store's `[slack] channel-delivery:` lines](#the-stores-slack-channel-delivery-lines)).
    The dropped choices still don't apply, and the persona isn't brought up
    until a confirmation succeeds; a restart before then drops them again at
    start.
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
  - `[slack] reload-record-write-failed: cannot write the retired-key record "<path>"; the last-applied record "<record path>" is not rewritten, and the confirmed change is not applied and stays pending; the retired-key record holds what this server held as retired before this apply (b.jg5 SRJ-803, SRJ-804)`:
    the retired-key record couldn't be written, so the last-applied record wasn't touched.
    A `[slack] retired-keys: cannot record …` line before it carries the
    error, followed by the store's `[slack] retired-keys: restored …` or
    `[slack] retired-keys: cannot restore …` line. The end can instead read
    `putting the retired-key record back to what it held before this apply failed too, so a key this apply recorded that reached the file stays retired`.

  When the retired-key record was written first, the two last-applied record
  lines end with
  `; the retired-key record "<path>" is put back to what it held before this apply: the keys this apply recorded are removed again, and keys recorded before it stay (b.jg5 SRJ-804)`,
  or, when putting it back failed,
  `; putting the retired-key record "<path>" back to what it held before this apply failed, so the keys this apply recorded stay retired (b.jg5 SRJ-804)`.
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
  [slack] reload-preview: DESTRUCTIVE: persona "<name>" (key=<key>) is removed: the persona will be retired: its session stopped and never resumed.
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
  (`agent_director_call_timeout_ms`), as its preview line says. The
  exception is `allow_invited_channels`: it takes effect at once, in place,
  from the next event, tool call, prompt and notice, with every session kept
  and no lifecycle step for any persona.
- **What happens to personas now:** the apply switches the persona set the
  server runs at once. Message delivery, the up check, the notifier and the
  permission poller read that set at each use. Then:
  - a removed persona (or the old key of a renamed one) is torn down: its
    Slack connection is closed and its instance killed; its agent-director
    row is kept until agent-director's `expire` removes it, but its key is
    retired, so its conversation is never resumed; its permission
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
      once its teardown starts, and until it completes, a notice for it is
      not dropped: it goes to `server.log` and a `persona-teardown-notice`
      entry in `startup-errors.log` (see
      [A notice raised during a teardown](#a-notice-raised-during-a-teardown));
    - it is never restarted or relaunched again;
  - a kept persona's routing settings take effect at once, for the next
    message, notice or prompt: `channels` (each entry's `delivery` included)
    and `permission_prompts` in declarative mode,
    `invited.permission_prompts` in fungible mode, and `dm.*` in both;
  - a change to the section the mode doesn't read is only written into the
    record, with no effect until the switch selects that section;
  - a kept persona's `stop_hook_bootstrap` or `claude_config_dir` change
    takes effect at its next launch (a relaunch after the bot dies, a
    `clean_restart`, `stop --stop-bots` then `start`, or a host reboot; a
    plain `stop` and `start` only reconnects), which launches the new
    declaration; until then its instance runs as launched;
  - a kept persona whose `credentials_file` path or `working_directory`
    changed is torn down, like a removed persona, then brought up fresh from
    its new entry, like an added one: its old instance is ended and its row
    kept, its old conversation is never resumed, it starts a new
    conversation on the same instance, and it reads the new credentials
    file;
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
  settings other than `allow_invited_channels`, already in force (see
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
  edit, a setting written out with its default value (`allow_invited_channels`
  written as `false` included), or an edit made only of recorded changes to
  the section the mode doesn't read (the preview's
  `recorded, with no effect until …` lines) does this.
- **Meaning:** The record was rewritten with `config.json`'s bytes, so the two
  match again and nothing is pending. No persona, instance or setting changed.
  The record holds any recorded change, which takes effect only once a
  later confirmed change turns the switch to the mode that reads it.
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
  `[slack] clean_restart: failed to load config:` and stops nothing, and
  `stop --stop-bots` logs `could not load config — skipping bot teardown`,
  checks no persona and stops only the server. If it can't connect to
  agent-director first, it stops nothing (see
  [A precheck failed: nothing was stopped](#a-precheck-failed-nothing-was-stopped)),
  unless the client refused the binary as too old: then it stops only the
  server and exits 1 (see
  [The two CLI commands on an old binary](#the-two-cli-commands-on-an-old-binary)). `stop` logs one line saying it could not load the applied
  configuration, and uses a 30 s `stop_timeout`.
- **Fix:** If it can't be read, make it a readable file and start again; the
  record is kept. Otherwise, with the operator's say-so, delete the record and
  start, as under [Starting without the record](#starting-without-the-record).
- **Warning:** Deleting the record makes the next start run whatever is in
  `config.json` now, including any edit that was never applied. Read
  `config.json` before deleting the record.

### The retired-key record can't be read or is invalid

The server keeps the persona keys it holds as retired in `retired-keys.json`,
in the state directory beside `config.json.last-applied`. Only the server
writes it; it is absent until a key is first recorded. Never edit it.

- **Line:** `[<timestamp>] [retired-keys-unreadable] The retired-key record "<path>" <problem>, so the server does not start: it never guesses which persona keys are retired. Moving the file aside (for example, renaming it) lets the server start, at the cost that the keys it held are no longer retired, so a persona whose key it held may resume the conversation of the life that was retired.`
  The same line is in `startup-errors.log` and `server.log`.
- **Cause:** `<problem>` is one of:
  - `cannot be read (<errno>)`: the server's user can't read the file, or the
    path is a directory (`EISDIR`); `(not a regular file)` means a FIFO,
    socket or device, which is never read;
  - `is not valid UTF-8`, or `is not valid JSON at line <L>, column <C>`: the
    file was edited or damaged;
  - `is invalid: …`: the JSON breaks a rule of the format (a missing or
    unknown field, a `version` other than 1, a cause or time it doesn't
    accept); an entry is named by its position in `keys`, never by its key.
- **Effect:** The server exits 1 before it records the configuration,
  writes its PID file, connects to Slack or launches anything. The start
  never guesses which keys are retired.
- **Fix:** If it can't be read, make it a readable regular file and start
  again; the record is kept. Otherwise, with the operator's say-so, move it
  aside and start:

  ```sh
  STATE="${SLACK_STATE_DIR:-$HOME/.claude/channels/slack}"
  mv "$STATE/retired-keys.json" "$STATE/retired-keys.json.moved-aside"
  ```

- **Cost:** The keys the moved file held are no longer retired, so a persona
  whose key it held may resume the conversation of the life that was retired.
  Keep the moved file for the operator to read.

---

## The stored-choice file: `channel-delivery.json`

The server keeps the channel deliveries that personas' agents choose with
`set_channel_delivery` in `channel-delivery.json`, in the state directory
beside `retired-keys.json`. For each persona key it holds the persona's
declaration (its `name`, `credentials_file` and `working_directory`) and, for
each channel, the stored choice (`mentions` or `all`) and when it was stored.
That is persona keys, names, paths, channel IDs, choices and times only: no
token, no credentials content and no message text.

- **Only the server reads and writes it.** No CLI command reads, writes,
  creates or removes it. Never edit it by hand (see
  [Constraints](#constraints)).
- **Read once per start.** The server reads it whole, with no size cap, once
  at every start, in both channel modes and in dry run, before any persona is
  brought up. It isn't read again while the server runs.
- **Absent until the first stored choice.** A missing file is an empty
  record. Only the first accepted `set_channel_delivery` call creates it.
  Every call is refused in declarative mode, so declarative mode never
  creates it.
- **Stored choices apply only in fungible mode** (`allow_invited_channels`
  is `true`). While the switch is off they stay on disk and apply again once
  it is back on (see
  [`persona-channel-delivery-set`](#persona-channel-delivery-set)).
- **The server on its own only ever drops choices.** A confirmed change
  that retires a persona's key drops its choices, and so do the start rules
  at every start; each drop logs a line (see
  [The store's `[slack] channel-delivery:` lines](#the-stores-slack-channel-delivery-lines)).

To see whether the file exists and what it holds (no token is in it):

```sh
STATE="${SLACK_STATE_DIR:-$HOME/.claude/channels/slack}"
ls -l "$STATE/channel-delivery.json"
cat "$STATE/channel-delivery.json"
```

### `channel-delivery-unreadable`

- **Line:** one line at start, with no persona reference:

  ```text
  [slack] channel-delivery-unreadable: the stored-choice file "<path>" <what>. It is left in place, and this run neither writes it nor drops anything from it: in fungible mode every channel is served at mentions, and set_channel_delivery is refused. To fix: move the file aside, then restart the server (b.deo SRI-403, SRI-904)
  ```

  `<what>` says which step failed. It never shows the file's content:
  - `could not be read (<code>)`: the read failed. `<code>` is the error
    code, such as `EACCES` or `EPERM` (permissions), `EISDIR` (the path is a
    directory) or `not a regular file` (a FIFO, socket or device, which is
    never read). The ` (<code>)` part is missing when the error has none.
  - `could not be parsed: it is not valid UTF-8`, or
    `could not be parsed: it is not valid JSON at line <L>, column <C>`
    (`it is not valid JSON` when there is no position).
  - `could not be validated: it is invalid: <problem>`: the JSON breaks a
    rule of the format. `<problem>` names an entry by its position
    (``entry <n> of `personas` ``, ``channel <n> of `channels` ``), never by
    its key, channel ID or value; for example
    `it has a top-level field the format does not name` or
    ``entry 2 of `personas` has no `declaration` ``.
- **Meaning:** The server couldn't use the stored-choice file, so for the
  rest of this run the store is unreadable: no stored choice applies, and
  nothing is stored.
- **Cause:** The file could not be read, parsed or validated. Usually its
  permissions (the server's user can't read it), a directory or other
  non-regular file at its path, invalid JSON, or a damaged or hand-edited
  file (a field the format doesn't name, a `version` other than 1, a key that
  isn't a persona key, a `delivery` other than `mentions` or `all`, or a
  `set_at` that isn't an RFC 3339 UTC time ending in `Z`).
- **Effect:**
  - In fungible mode every channel is served at `mentions`, whatever was
    stored, and each `persona-invited-channel` line shows `mentions`. Every
    `set_channel_delivery` call is refused, with this tool error, and nothing
    is stored:
    `Tool "set_channel_delivery" refused for persona "<name>" (key=<key>): the stored-choice file "<path>" is not readable, so no channel delivery can be stored. To fix: the operator moves the file aside, then restarts the server.`
  - Nothing is written to the file and nothing is dropped from it, and the
    start rules don't run, so this run logs no drop line.
  - The server starts and runs every persona. Declarative mode delivers by
    each persona's listed channels, as it always does.
  - The state lasts for the rest of the run, even if a confirmed change turns
    fungible mode on later in it: readability is decided once, at start.
  - No `startup-errors.log` entry is written, and nothing is posted to Slack.
    This line in `server.log` is the only sign.
- **Fix:** With the operator's say-so, move the file aside. Never edit it in
  place:

  ```sh
  STATE="${SLACK_STATE_DIR:-$HOME/.claude/channels/slack}"
  mv "$STATE/channel-delivery.json" "$STATE/channel-delivery.json.moved-aside"
  ```

  Then, also with the operator's say-so, restart the server
  (`claude-slack-channel-bots stop && claude-slack-channel-bots start`; the
  bots keep running). The start finds no file, so every stored choice is
  gone: each channel is served at `mentions` until a persona's agent sets it
  again with `set_channel_delivery`. Keep the moved file for the operator to
  read.
- **Restoring the file instead of moving it aside:** while the store is
  unreadable nothing can be dropped from it. If the operator makes that same
  file usable again in place (fixes its permissions, or puts the same bytes
  back) and restarts, a persona that was removed and added back during that
  run with the same `name`, `credentials_file` and `working_directory` gets
  its earlier stored choices again. Moving the file aside avoids this.

### The store's `[slack] channel-delivery:` lines

The store logs plain lines with no class label, each starting
`[slack] channel-delivery:`. None of them names a channel's choice, and none
carries a token or message text. Declarative mode with no stored-choice file
logs none of them. To list them:

```sh
grep -h -F '[slack] channel-delivery:' "$STATE"/server.log.* "$STATE"/server.log 2>/dev/null | sort
```

**Drop lines.** One line per persona key whose stored choices a drop removed:

```text
[slack] channel-delivery: dropped the stored choices of persona=<key> in <n> channels: <reason> (b.deo SRI-405, SRI-905)
```

(`in 1 channel` for one.) The key's choices stop applying at once, so in
fungible mode its persona is at `mentions` in those channels until its agent
sets them again. `<reason>` is one of:

| Reason | Meaning |
|---|---|
| `retired by a confirmed change` | A confirmed change retired the key: the persona was removed, renamed (its old key), or destructively modified (`name`, `credentials_file` or `working_directory` changed; see [A persona was added or removed by a confirmed change](#a-persona-was-added-or-removed-by-a-confirmed-change)). Logged once the change's last-applied record is written. At a start it also covers a key that `retired-keys.json` holds as retired while the persona's next session has not begun. |
| `not an applied persona at start` | At a start, the key belongs to no persona in the configuration the start runs: the persona was removed or renamed, for example by a start without the record. |
| `its declaration changed` | At a start, the persona's `name`, `credentials_file` or `working_directory` differs from the one stored with its choices. Paths count as equal when they are equal as written or resolve to the same real path, so a symlink retargeted to another directory counts as changed. |

The start rules run right after the read at every start, in both modes, so
drop lines can appear in declarative mode whenever the file exists. A key that
matches several rules is dropped once, with the first reason in the order
`not an applied persona at start`, `its declaration changed`,
`retired by a confirmed change`. With no file there is nothing to drop, so
nothing is written or logged. Each rule only ever drops choices, toward
`mentions`. No fix is
needed: if a persona should hear a channel at `all` again, ask it in that
channel to set it.

**Failed-write lines.** One line per failed write, naming the action, the file
and the error:

```text
[slack] channel-delivery: cannot <action> in "<path>"<detail>; <what holds>
```

- **A stored choice's write** (a `set_channel_delivery` call):

  ```text
  [slack] channel-delivery: cannot store the channel delivery of persona=<key> for channel <id> in "<path>"<detail>; the stored choices in memory are unchanged (b.deo SRI-404, SRI-506)
  ```

  The agent gets the tool error
  `Tool "set_channel_delivery" failed for persona "<name>" (key=<key>): the stored-choice file "<path>" could not be written, so the choice was not stored and channel delivery is unchanged.`,
  and no `persona-channel-delivery-set` line is logged. `<detail>` is one of:
  - ` (<code>); the file is unchanged`;
  - `: the record was written but its directory could not be synced (<code>); <write-back>`,
    where `<write-back>` is `the previous record was written back`, or
    `the file, absent before, was removed again` when the call would have
    created it, either one possibly followed by
    `, though its directory could not be synced either`;
  - the write-back variant:
    `: the record was written but its directory could not be synced (<code>); putting the previous state back failed too (<code>), so the file holds the refused choice until the next successful write`.
    The refused choice is on disk but not in memory, so it doesn't apply in
    this run. It stays there until the next successful write of the file
    replaces it with the record held in memory. A restart before that write
    reads it, and the refused choice then applies.
- **A drop's write** (a confirmed change's drop, the start rules, or a later
  write that carries an earlier failed drop):

  ```text
  [slack] channel-delivery: cannot write the drop of persona=<key> in "<path>"<detail>; the dropped choices do not apply, and the next successful write of the file carries the drop (b.deo SRI-405)
  ```

  A drop of several keys names each, sorted and joined by `, `
  (`persona=<key>, persona=<key>`). `<detail>` is ` (<code>); the file is unchanged`, or
  `: the record was written but its directory could not be synced (<code>), so a crash can undo it`.
  The dropped choices stop applying at once in memory, whatever the write
  did. The drop stays unwritten until the next successful write of the file,
  which carries it: an accepted `set_channel_delivery` call, another drop, or
  a confirmed change that brings that key up again (which writes the file
  first, and applies nothing if it can't; see
  [`reload-record-write-failed`](#reload-record-write-failed)). A restart
  before then reads the file with the dropped choices still in it, and the
  start rules drop them again.

The `(<code>)` parts appear only when the error has a code. **Cause and fix of
a failed write:** as under
[`reload-record-write-failed`](#reload-record-write-failed), usually the state
directory: the server's user can't create or rename files in it (`EACCES`,
`EPERM`), the disk or quota is full (`ENOSPC`, `EDQUOT`), or the filesystem is
read-only (`EROFS`); a directory that can't be synced points at the
filesystem. Have the operator fix it, then ask the persona to set the choice
again. Any later successful write also carries an unwritten drop and replaces
a refused choice left on disk.

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
| `ended`, `missing`, or no row | The persona is up | The instance reads dead. Restart and the health check relaunch it; look for `Scheduling restart for persona=<key>` and `Relaunching session`. |
| `ended`, `missing`, or no row | The persona is down | Nothing to serve; it's launched once the persona comes up. |
| `ended` or `missing` | `persona teardown of … agent-director kill of cscb_<key>: … the row is kept`, then `…: complete` | The persona was removed or destructively modified by a confirmed change: its instance was ended and its row kept as its old life. Its key is retired, so the row is never resumed. Expected. A removed persona's row is kept until agent-director's `expire` removes it; a server start's clean-up never deletes it. |
| No row | `persona teardown of … complete` | The persona was removed by a confirmed change and its row was already gone, or agent-director's `expire` has removed it since. Expected. |
| `ended` or `missing`, labelled with a persona that is no longer configured, or with no `persona` label | None (no persona has that key) | A finished instance of a removed persona, or one left from a build before personas. A server start's clean-up leaves it as it is: it is kept until agent-director's `expire` removes it, and it is never resumed. Expected. |
| Live state | `persona teardown of …: agent-director kill of cscb_<key> failed` | The teardown couldn't stop the instance, so it kept the row; its session may still be running. See [A persona posts a Kill failed or Process outlived kill notice](#a-persona-posts-a-kill-failed-or-process-outlived-kill-notice). For a removed persona, the next server start's clean-up kills it again, with the result checked, and keeps the row until `expire`; for a destructively modified one, its bring-up ends that session first and starts a new conversation on the same instance, never resuming the old one. |
| Any state | `key is retired`, and no `answering fresh-retired` since (a `was recorded as retired while this reuse spawn's launch attempt was in flight` line counts as none) | The persona's key is retired (added again, renamed back, or destructively modified) and this row is its old life: it is never resumed or reconnected, and the server replaces it with a new conversation on the same instance. See [Added again or renamed back](#added-again-or-renamed-back). |
| Live state, its `cwd` a waiting persona's working directory | That persona's `not launching … — its working directory "<path>" is held for an old life that may still be running (instanceId="<id>" …)`, with this row's id, and no `old-life hold: ended for instanceId="<id>"` since | The old instance the persona waits on: the server keeps ending it and brings the persona up once agent-director reads it finished. See [A persona waiting on an old instance](#a-persona-waiting-on-an-old-instance). If its kills keep failing, a human follows the "Operator actions" section of agent-director's README for it. |
| `pending` | The persona is up, `armed in pending-only mode (pending-row)` and no `stopped (pending-only, row …)` since | Its own launch, still starting: watched, never launched over, never ended except once at the limit when this server made the launch (*Launch stuck*), and never typed into except to accept its startup prompts. Its retries check it from agent-director's grace period on and stop once it has started. If it stays `pending` for many minutes, see [A persona posts a Launch stuck or Session not starting notice](#a-persona-posts-a-launch-stuck-or-session-not-starting-notice). |
| `pending` | `pending-row: … is not covered (…)` for the persona | An old instance still starting: a retired persona's before its new conversation, or one launched in another working directory or config directory. It is never typed into: the server ends it with a checked kill, then, while it still reads `pending`, waits until agent-director's grace period has passed since its launch start, confirms it has ended (one more checked kill if needed) and brings the persona up on a new conversation on the same instance (`live-row-sequence:` lines). Expected. |
| Live state | `answering fresh-retired`, then no `entry cleared` line yet | The persona's new conversation: kept and served as any live row. The key's entry is removed once the server reads it running. |

To check whether a session of the persona is there, read one line of its
screen through agent-director:

```sh
agent-director read-pane --claude-instance-id cscb_<key> --n-lines 1
```

- **A pane:** a session of the persona is there. It can be a single leftover
  of an earlier launch rather than the row's current launch; then `kill`
  answers CONFLICT, "not this launch's session" (see
  [A persona posts a Held: tmux session conflict notice](#a-persona-posts-a-held-tmux-session-conflict-notice)).
- **`ErrTmuxCaptureFailed`:** no session of the row's current launch is
  there. That does not prove the worker gone after a kill failure whose
  description says no session or pane of this launch was found.

For a leftover's pane, or a worker that runs with no session or pane of its
launch, a human follows the "Operator actions" section of
agent-director's README. This skill describes no step of it.

