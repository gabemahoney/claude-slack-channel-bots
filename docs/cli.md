# CLI Reference

The `claude-slack-channel-bots` binary exposes five subcommands.

## `claude-slack-channel-bots start`

Checks that the configuration file or the last-applied record exists, starts the server in the background, and waits for it to get through startup.

**Prerequisite check:** `STATE_DIR/config.json` or `STATE_DIR/config.json.last-applied` exists. If neither does, `start` exits 1 with:

```
missing prerequisite: config.json not found at <path>, and no config.json.last-applied at <path>
```

`start` reads no Slack token. The server checks the configuration, and each persona's credentials file, once it runs.

The server first runs the agent-director startup gate: it imports `agent-director`, constructs the singleton Client (which probes the system binary's version and refuses a binary below the client's own minimum), reads the binary's version from the built client and refuses a binary below CSCB's Phase 1 floor, and verifies `~/.agent-director/state.db` is owned by the current user. Failures land in `startup-errors.log` (see [Startup errors](troubleshooting.md#startup-errors)). agent-director enforces tmux availability at spawn time. The server then loads the configuration and starts listening. With a last-applied record it runs the record; without one it checks `config.json`, records it and applies it (see [Reload](reload.md#reload)). Only then does it write its PID to `STATE_DIR/server.pid`. Conversation context is preserved across server restarts when possible.

`start` waits up to 30 seconds for that PID file. The outcomes are:

- **The server is up:** `start` prints this line and exits 0.

  ```
  [slack] Server starting in background (PID 12345)
  ```

- **The server exits during startup:** `start` exits 1. It prints why the server stopped, followed by the last lines (at most 20) the server wrote to `server.log`, which carry the server's own reason:

  ```
  [slack] Server failed to start (exit code 1). From /home/you/.claude/channels/slack/server.log:
  ```

- **The server is still starting after 30 seconds:** `start` exits 0 and leaves it running.

  ```
  [slack] Server is still starting in the background (PID 12345) after 30s — its log is /home/you/.claude/channels/slack/server.log
  ```

At a start with no last-applied record, a configuration from before personas stops the start. The server writes the conversion error to `server.log` and exits, so `start` shows the same line on the terminal and exits 1. In `server.log`, where each line is prefixed with a timestamp, it reads:

```
[slack] Fatal: configuration error — loadPersonaConfig: invalid persona config in "<path>": Persona config validation error: "<key>" belongs to the pre-persona configuration shape, which is no longer accepted. The configuration must be converted to personas: rewrite it by hand as a "personas" array. Nothing is converted automatically and the file has not been changed.
```

`<key>` is the first pre-persona key found in the file. Any other invalid configuration fails the same way, with a message naming the persona and the field. A last-applied record that can't be read or is invalid stops the start with `[slack] Fatal: last-applied record error —` and the deletion hint, and a record that can't be written stops it with `reload-record-write-failed` (see [Troubleshooting](troubleshooting.md#troubleshooting)). A server that is already running makes the new one exit with `[slack] Server is already running (PID <pid>). Exiting.`, so `start` exits 1.

## `claude-slack-channel-bots stop`

Reads `STATE_DIR/server.pid` and sends `SIGTERM` to the process.

Behavior by case:

- **PID file missing:** prints `server is not running` and exits 0.
- **Stale PID file** (process no longer running): removes the PID file and `server.port`, prints `server is not running (removed stale PID file)`, exits 0.
- **Live process:** sends `SIGTERM`, polls for exit for up to `stop_timeout` seconds (default 30s), read from the last-applied record when there is one. Prints `[slack] Server stopped.` on clean exit. Escalates to `SIGKILL` if the process does not exit within `stop_timeout`, then prints `[slack] Server killed.` once it has exited. Either way, it removes the PID file and `server.port` (see [PID file](#pid-file)).

Plain `stop` leaves the managed bots running — they are meant to survive a server restart. Pass `--stop-bots` to gracefully exit the bots too:

```sh
claude-slack-channel-bots stop --stop-bots
```

This follows `clean_restart`'s order. It runs the [precheck](#precheck-before-stopping-bots) first, and stops nothing if it fails. When it passes, the server is stopped, then the bot teardown runs for each persona in the last-applied record (or in `config.json` when there is no record), addressing its instance as `cscb_<key>` — pause the bot, poll until it exits (or up to `exit_timeout` seconds), then force-kill on timeout. A bot that can't be paused is handled as [When a bot can't be paused](#when-a-bot-cant-be-paused) describes. Teardown kills but never deletes each row, preserving its `claude_session_id` so the bots can resume their conversation history on the next start. Stopping the server before the teardown prevents its `onsessionclosed`/`scheduleRestart` handler from respawning a just-exited bot mid-teardown (which would delete its `ended` row and history). Use it when you want a clean, flushed shutdown of the bots (for example before a host reboot).

If agent-director can't be reached, or a persona's instance can't be read, the precheck fails: nothing is stopped and the command exits 1 (see [Precheck before stopping bots](#precheck-before-stopping-bots)). If a persona can't be stopped after a passed precheck, the command prints a line naming it, its session and why, ends with a line counting the personas it could not stop, and exits 1 rather than silently reporting a clean stop (see [What the command prints when a bot can't be stopped](#what-the-command-prints-when-a-bot-cant-be-stopped)). `stop --stop-bots` never starts the server: after a failure the server stays stopped, unlike [`clean_restart`](#when-clean_restart-cant-stop-a-bot). When every persona is stopped, one stopped with a *Process outlived kill* text included, it exits with the server stop's status.

`stop --stop-bots` makes no version check of its own, so CSCB can always be stopped, whatever agent-director is installed:

- **An agent-director older than CSCB needs, that the agent-director client still accepts:** the command works as usual. The precheck and the teardown run through that agent-director, and every bot is stopped. This is how you stop the bots before the switch-over (see the docs/migration.md section "Switching over to agent-director Phase 1").
- **An agent-director below the client's own minimum:** no agent-director call can be made, so only the server is stopped. No bot is checked, paused or killed, and every bot and its agent-director instance is left as it is. The command prints the reason, which names the version found, the version required and the docs/migration.md section "Switching over to agent-director Phase 1", then the server stop's own lines, then a last line, and exits 1:

  ```text
  [slack] stop --stop-bots: agent-director initialization failed: agent-director startup gate failed (ad-system-install-too-old): agent-director system install is too old: …
  [slack] Server stopped.
  stop --stop-bots: only the server was stopped; every worker and row was left as it is
  ```

  The exit status is 1 whatever the server stop did, so read the lines between the first and the last to tell whether the server is really down: `[slack] Server stopped.`, `[slack] Server killed.` or `server is not running` mean it is; `[slack] Warning: server did not die after SIGKILL.` means it is still running; `[slack] Could not read PID file: …` means the PID file could not be read, so the server's state is unknown. This happens whether or not the configuration could be loaded.

A configuration that cannot be loaded, a bad record or a missing or pre-persona file included, is best-effort: it prints `[slack] stop --stop-bots: could not load config — skipping bot teardown:` with the cause, and no persona is checked. The command still connects to agent-director, with the default call timeout. Once the connection succeeds, the server is stopped and the teardown is skipped. A failed connection stops nothing (see [Precheck before stopping bots](#precheck-before-stopping-bots)); on an agent-director below the client's own minimum only the server is stopped, as described above.

## `claude-slack-channel-bots clean_restart`

Runs the [precheck](#precheck-before-stopping-bots), then stops the server, gracefully exits all managed Claude Code sessions, and starts the server again.

```sh
claude-slack-channel-bots clean_restart
```

For each persona in the last-applied record (or in `config.json` when there is no record), calls `client.pause({claude_instance_id})` via agent-director with the persona's instance ID `cscb_<key>`, and polls `client.status(...)` until the spawn transitions to `ended` / `missing` (or `client.status(...)` fails with `ErrSpawnNotFound` because the row is gone). If the spawn does not exit within `exit_timeout` seconds (default 120s), the spawn is force-killed via `client.kill(...)`. Teardown kills but never deletes each row, preserving its `claude_session_id` so bots resume their conversation history on the next start. All personas are processed in parallel. After the server restarts, the SR-1.4 collision-then-act dispatcher decides resume-vs-fresh per persona — agent-director owns Claude session-id state, not CSCB.

`clean_restart` logs its progress to `STATE_DIR/clean_restart.log`. The lines that end it with an error (config load failure, agent-director initialization failure, a failed precheck, a persona it could not stop, the alert that the server was not started, start failure) are also printed to the terminal, and so is any *Process outlived kill* text from the teardown, even on a run that goes on to start the server.

`clean_restart` loads the last-applied record first, or `config.json` when there is no record, and takes `exit_timeout` from it. If it cannot (a record that can't be read or is invalid, or a missing or pre-persona file), it exits 1 with `[slack] clean_restart: failed to load config:` and the loader's error, and nothing is stopped. For a bad record, the error says that deleting it makes the next start apply `config.json` (see [Reload](reload.md#reload)). `clean_restart` doesn't apply a pending `config.json` edit: the server comes back on the record.

A persona whose force-kill succeeds, or whose instance is found already ended, missing or gone, counts as stopped; so does one whose force-kill ends with a *Process outlived kill* text. When every persona is stopped, the server is started and the command exits with the start's status. When a persona can't be stopped, the command prints its line once every persona's teardown has finished, then starts the server only if agent-director answers, and exits 1 either way (see [When `clean_restart` can't stop a bot](#when-clean_restart-cant-stop-a-bot)). That includes a pause refused for a reason that fails the teardown at once (see [When a bot can't be paused](#when-a-bot-cant-be-paused)) and a force-kill that fails (see [When a bot can't be force-killed](#when-a-bot-cant-be-force-killed)).

Behavior by case:

- **No personas** (`"personas": []`): nothing is torn down; the server is stopped and started.
- **A persona with no instance:** logs `[slack] teardownBots: no spawn row for persona "<name>" (key=<key>) — skipping` and continues.
- **Server already stopped:** `stop` reports `server is not running`; `start` then brings up a fresh server.
- **Server fails to start again:** `clean_restart` exits non-zero with `[slack] clean_restart: start failed with exit code <n>`; the reason is in `server.log`.
- **agent-director unreachable, or a persona's instance can't be read:** the precheck fails and nothing is stopped: the old server and every bot keep running, and `clean_restart` exits 1 (see [Precheck before stopping bots](#precheck-before-stopping-bots)).
- **An agent-director older than CSCB needs:** `clean_restart` runs the same version checks as the server's start, so on an agent-director below CSCB's Phase 1 floor, or below the client's own minimum, its precheck fails at the connection and nothing is stopped. Follow the docs/migration.md section "Switching over to agent-director Phase 1". To stop the bots before the switch-over, use `stop --stop-bots`, which works on any agent-director the client accepts (see [`stop`](#claude-slack-channel-bots-stop)).
- **agent-director fails during the teardown:** that persona can't be stopped, so the command exits 1. It starts the server if agent-director answers its check (3 tries, 2 s apart), and otherwise leaves the server stopped and records `clean-restart-not-restarted` (see [When `clean_restart` can't stop a bot](#when-clean_restart-cant-stop-a-bot)). The `no spawn row` message appears only when a persona genuinely has no spawn, never when the client failed to reach agent-director.

### When a bot can't be paused

`stop --stop-bots` and `clean_restart` share one bot teardown. When agent-director refuses to pause a persona's bot, what happens depends on why.

The bot is force-killed instead, and its row is kept, when:

- its session is already gone;
- agent-director keeps not answering: the pause is tried 3 times, 2 s apart, before the force-kill;
- the bot is still launching (its instance is `pending`, for example at a launch dialog). Its instance stays `pending` until agent-director marks it `missing`: once the server runs, it checks the instance with agent-director from `pending_grace_seconds` after its launch's start (see "A persona's instance is still starting" in [Troubleshooting](troubleshooting.md#troubleshooting)), and those checks mark it;
- the pause times out. agent-director waits up to its `[pause] timeout_seconds` for the bot to exit, and the default call timeout covers that wait (see [Sizing the agent-director call timeout](agent-director.md#sizing-the-agent-director-call-timeout));
- agent-director refuses it for any reason not listed below.

That persona's teardown fails at once, with no force-kill, when:

- a tmux session conflict holds the persona's session, which may not be the bot's own;
- the tmux session name recorded on the persona's instance can't be used. The command puts no hold on the persona; only the server does that;
- tmux is unavailable;
- agent-director reports an internal error;
- agent-director refuses its config file, `~/.agent-director/config.toml`. The error names the file.

The other personas are still torn down. A persona whose teardown fails makes the command exit non-zero (see [`stop`](#claude-slack-channel-bots-stop) and [`clean_restart`](#claude-slack-channel-bots-clean_restart)).

### When a bot can't be force-killed

The force-kill, after the pause or once `exit_timeout` passes, ends the bot's session and keeps its row. No force-kill ever removes a row.

The persona counts as stopped when:

- the force-kill succeeds. A force-kill through an agent-director older than Phase 1, which only `stop --stop-bots` reaches, is a plain success;
- agent-director finds no instance for the persona;
- the read of the bot's instance before a further try finds it already ended, missing or gone. No further force-kill is made.

When agent-director does not answer in time, answers that it could not end the worker or that tmux did not answer, or answers with an error the agent-director client does not recognise, the force-kill is tried up to 3 times, 2 s apart. Before each further try the bot's instance is read; a read that fails, for any reason but the config file below, lets the try go ahead. If the last try still fails, the persona's teardown fails.

That persona's teardown fails at once, with no further force-kill, when:

- a tmux session conflict holds the persona's session, which may not be the bot's own; a session left over from an earlier launch of the bot included. The error names the session;
- tmux is unavailable;
- the tmux session name recorded on the persona's instance can't be used. The command puts no hold on the persona; only the server does that;
- agent-director answers that the bot's tmux session is already gone. A force-kill should not give this answer, so the command cannot confirm that the bot stopped. This differs from a refused pause, where the same answer leads on to the force-kill, and from a read of the instance that finds it gone, which counts as stopped;
- agent-director reports an internal error, an error about its store, or another error that does not fit a force-kill;
- agent-director refuses its config file, `~/.agent-director/config.toml`, at a try or at the read before a further try. The error names the file.

When agent-director answered that a process outlived the force-kill, a persona that then counts as stopped still counts as stopped, and the command's exit status is unchanged; the command prints a *Process outlived kill* text for it (see below).

The server may be holding a persona for a human (see [Troubleshooting](troubleshooting.md#troubleshooting)). `stop --stop-bots` and `clean_restart` still stop it, because running them is a human's deliberate action. For a bot whose launch has no recorded start, the force-kill ends no session.

### What the command prints when a bot can't be stopped

`stop --stop-bots` and `clean_restart` tear the personas down in parallel. Once every persona's teardown has finished, the command reports each persona in configuration order. A persona that can't be stopped gets one line:

```text
<command>: could not stop persona "<name>" (key=<key>), session "slack_bot_<key>": <CLASS>: <description>
```

`<command>` is `stop --stop-bots` or `clean_restart`. `<description>` is agent-director's error name and description, as `<name> message="…"`, on one line, with anything that looks like a token replaced by a redaction marker; a CONFIG one starts `agent-director refuses its config file ~/.agent-director/config.toml: `. `<CLASS>` is one of:

| Class | Meaning |
|---|---|
| `UNAVAILABLE` | agent-director didn't answer, or couldn't act right now: at a read of the bot's instance, at once; at the force-kill, after its 3 tries |
| `CONFLICT` | A tmux session conflict holds the persona's session, which may not be the bot's own |
| `UNUSABLE_NAME` | The tmux session name recorded on the persona's instance can't be used |
| `ENVIRONMENT` | tmux is unavailable |
| `CONFIG` | agent-director refuses its config file, `~/.agent-director/config.toml` |
| `GONE` | The force-kill answered that the bot's tmux session is already gone, so the command cannot confirm that the bot stopped |
| `UNCLASSIFIED` | An internal error, an error about agent-director's store, or another answer CSCB doesn't recognise |
| `STATE`, `DIRECTORY`, `LAUNCH_FAILURE` | An answer to the force-kill, or to a read of the instance, that does not fit it |

When the force-kill failed because agent-director could not end the worker, or failed in any way after agent-director reported a process that outlived an earlier try, the line is followed by the *Kill failed* notice's text, led by `persona "<name>" (key=<key>) (CLI teardown, <command>): ` and ending `The CLI does not retry this kill: once the worker is ended, run the command again.`

A persona whose force-kill ended with a process outliving it counts as stopped: it gets no failure line and is not counted. The *Process outlived kill* text is printed for it instead, led the same way and ending `This persona's teardown has finished; nothing in CSCB checks this process again.` It changes no exit status.

When at least one persona could not be stopped, the command ends with a last line counting them. For `clean_restart`, it comes after the restart's outcome (see [When `clean_restart` can't stop a bot](#when-clean_restart-cant-stop-a-bot)):

```text
stop --stop-bots: could not stop persona "<name>" (key=<key>), session "slack_bot_<key>": <CLASS>: <description>
stop --stop-bots: could not stop <N> persona(s); rows are never deleted, so running the command again is safe
```

Where each line goes:

| Line | Terminal (stderr) | `clean_restart.log` | `server.log` | `startup-errors.log` |
|---|---|---|---|---|
| A failure line with no *Kill failed* text | yes | `clean_restart` only | yes | one `cli-teardown-failed` entry |
| A failure line and the *Kill failed* text after it | yes, two lines | `clean_restart` only | yes, two lines | one `persona-kill-failed` entry holding both |
| A *Process outlived kill* text | yes | `clean_restart` only | yes | one `persona-kill-survivor` entry |
| `clean_restart`'s alert that the server was not started | yes | yes | yes | one `clean-restart-not-restarted` entry |
| The last line | yes | `clean_restart` only | no | no |

The server is stopped at that point, so the command writes `server.log` itself, in the server's timestamped form and with its rotation (see [Server log rotation](troubleshooting.md#server-log-rotation)); the entries are described under [Startup errors](troubleshooting.md#startup-errors). Each line reaches the terminal once. The two file writes are best effort. When the `server.log` write fails, the command prints `[slack] <command>: could not append a line to server.log: …`: on the terminal for `stop --stop-bots`, and in `clean_restart.log` only for `clean_restart`. When the `startup-errors.log` write fails, the terminal shows `[<time>] [startup-errors] WARNING: could not write to <path>: …`. Either way the print, the other file and the exit status are unchanged. Nothing is posted to Slack, and no persona is held. What to do: see "`clean_restart` or `stop --stop-bots` exits non-zero with `could not stop`" in [Troubleshooting](troubleshooting.md#troubleshooting).

### When `clean_restart` can't stop a bot

While agent-director answers, a bot that can't be stopped never leaves the whole fleet down. Once every persona's line is printed, `clean_restart` checks that agent-director answers: it lists CSCB's instances, up to 3 tries, 2 s apart. Each failed try, whatever the error, writes `[slack] clean_restart: agent-director answer check: list try <n> of 3 failed: <CLASS>: <description>` to `clean_restart.log`.

- **agent-director answers:** the server is started, as at any start. Its clean-up of old instances deletes no agent-director row, so every row is kept, the ones the command could not stop included. The new server keeps each configured persona's own instance that is still running, one the command could not stop included, and brings up the others. When the start lists its agent-director instances, before its clean-up ends any of them, a persona whose own row has conflicting labels, or reads pending with no launch start, is held for a human, and that start ends none of its instances. A persona whose launch meets a tmux session conflict is held too (see "A persona posts a *Held: tmux session conflict* notice" and "A persona posts a *Held: launch start not recorded* notice" in [Troubleshooting](troubleshooting.md#troubleshooting)). A start that fails prints `[slack] clean_restart: start failed with exit code <n>`, and records no `clean-restart-not-restarted` entry.
- **agent-director doesn't answer:** the server is not started, so nothing starts on top of bots the command could not reach. The command prints one alert naming every persona it could not stop, with its session and class, appends it to `server.log` and records it as one `clean-restart-not-restarted` entry in `startup-errors.log`:

  ```text
  clean_restart: could not stop persona "<name>" (key=<key>), session "slack_bot_<key>": <CLASS>; agent-director did not answer, so the server was not started: start it once agent-director answers
  ```

  With more personas, each is named as `persona "<name>" (key=<key>), session "slack_bot_<key>": <CLASS>`, separated by `; `. Once `agent-director version` answers, start the server with `claude-slack-channel-bots start`.

Either way the last line follows, and the command exits 1. For example, after a tmux session conflict with agent-director answering:

```text
clean_restart: could not stop persona "<name>" (key=<key>), session "slack_bot_<key>": CONFLICT: <description>
clean_restart: could not stop 1 persona(s); rows are never deleted, so running the command again is safe
```

Rows are never deleted, so running `clean_restart` again once the cause is fixed is safe. The check adds at most 3 agent-director calls and two 2 s waits after the teardown.

### How long a teardown can take

Personas are torn down in parallel. Each persona's teardown takes at most the sum of:

- the read of its instance;
- the pause: up to 3 tries, 2 s apart;
- the wait for the bot to exit: up to [`exit_timeout`](configuration.md#server-wide-settings) seconds, then one last read;
- the force-kill: up to 3 tries, 2 s apart, with one read of the instance before each further try.

Each agent-director call takes at most `agent_director_call_timeout_ms` (see [Sizing the agent-director call timeout](agent-director.md#sizing-the-agent-director-call-timeout)). The [precheck](#precheck-before-stopping-bots) that runs before it is bounded the same way: up to 3 tries, 2 s apart, of each of its two calls per persona.

## Precheck before stopping bots

Before `stop --stop-bots` or `clean_restart` stops anything, it checks that agent-director answers and that each persona's instance can be read:

1. It connects to agent-director. `clean_restart` makes the same version checks as the server's start. `stop --stop-bots` makes no version check of its own: any agent-director the client accepts passes, one older than CSCB's Phase 1 floor included.
2. For each persona in the last-applied record (or in `config.json` when there is no record), it reads the persona's instance, `cscb_<key>`. A persona with no instance, or whose instance has finished, is skipped. A running instance has one line of its screen read.

A persona fails the precheck when agent-director answers with one of these classes:

| Class | Meaning |
|---|---|
| `CONFLICT` | A tmux session conflict holds the persona's session (see "A persona posts a *Held: tmux session conflict* notice" under [Troubleshooting](troubleshooting.md#troubleshooting)) |
| `UNUSABLE_NAME` | The tmux session name recorded on the persona's instance can't be used (see "A persona posts a *Held: unusable tmux session name* notice" under [Troubleshooting](troubleshooting.md#troubleshooting)) |
| `ENVIRONMENT` | tmux is unavailable |
| `UNCLASSIFIED` | An answer CSCB doesn't recognise |
| `UNAVAILABLE` | agent-director didn't answer, or timed out, after 3 tries 2 s apart |
| `CONFIG` | agent-director refuses its config file, `~/.agent-director/config.toml`. Fails at once, with no retry, and the line names the file |

Every persona is checked, even after one fails. A conflicting-labels note on a persona's instance fails nothing on its own.

A failed precheck prints one line per persona it could not check, then a closing line, and exits 1:

```text
clean_restart: precheck failed for persona "<name>" (key=<key>), session "slack_bot_<key>": <CLASS>: <description>
clean_restart: nothing was stopped
```

The lines start with the command, `stop --stop-bots` or `clean_restart`. `<description>` is the error's name and agent-director's description, as `<name> message="…"`, on one line, with anything that looks like a token replaced by a redaction marker. `stop --stop-bots` prints the lines on the terminal only; `clean_restart` prints them on the terminal and in `clean_restart.log`. When the connection in step 1 fails, the command prints `[slack] <command>: agent-director initialization failed:` with the reason, then `<command>: nothing was stopped`, and exits 1. For `clean_restart` this includes an agent-director older than CSCB needs. The one exception is `stop --stop-bots` on an agent-director below the client's own minimum: it stops the server alone and ends with `stop --stop-bots: only the server was stopped; every worker and row was left as it is` (see [`stop`](#claude-slack-channel-bots-stop)).

Nothing was stopped: the server and every bot keep running. Fix the cause, then run the command again.

A passed precheck doesn't prove that the session running under a persona's name is that persona's own. The teardown that follows still acts only on the persona's own launch.

## `claude-slack-channel-bots credentials`

Writes one persona's credentials file from your terminal. The setup wizard gives you this line (see [Credentials files](configuration.md#credentials-files)):

```sh
claude-slack-channel-bots credentials <persona>
```

`<persona>` is the persona's name or its key, as `config.json` declares it; quote a name with spaces for your shell. The command reads `STATE_DIR/config.json` as it stands, not the last-applied record, so a persona you have just declared is found before you confirm anything. It needs no running server and no agent-director.

It prints `Credentials file of persona "<name>" (key=<key>): <path>`, then runs the package's `scripts/write-credentials.sh` with `bash` for that path, on your terminal:

1. If the file exists, it asks you to type `yes` to replace it. Anything else leaves the file untouched.
2. It asks for the bot token, then the app-level token, without echoing them. A token goes to `curl` only on its standard input, never on a command line.
3. It checks both locally (not empty, `xoxb-` / `xapp-`, only letters, digits and dashes), then validates the bot token with Slack `auth.test` and the app token with `apps.connections.open`, printing `bot_token: ok (auth.test)` and `app_token: ok (apps.connections.open)`, or the key and Slack's error code.
4. Only when both pass, it writes the file, a JSON object with `bot_token` and `app_token`, with mode 0600, replacing it in one step, and prints `Wrote <path> with mode 0600. bot_token and app_token both validated.`

It needs `bash` and `curl`. Exit codes: `0` when the file was written; `2` without exactly one persona (it prints `Usage: claude-slack-channel-bots credentials <persona name or key>`); `1` otherwise, with nothing written. A `config.json` that can't be loaded prints `credentials: cannot read the personas in <path>:` and the loader's error; a name or key no persona has prints `credentials: no persona in <path> has that name or key; declare it there first (declared: …)`, listing the declared personas. Neither asks for a token.

On a running server, a new or replaced credentials file waits for confirmation like a `config.json` edit (see [Reload](reload.md#reload)).

## `claude-slack-channel-bots clear-latch`

Ends one persona's hold on the running server, whichever of these held it: a *Held: tmux session conflict*, *Held: unusable tmux session name* or *Held: launch start not recorded* notice (see "How a hold ends" under [Troubleshooting](troubleshooting.md#troubleshooting)). A *Cannot launch* hold is not one of these: `clear-latch` does not end it and answers that the persona `was not latched` (see "A persona posts a *Cannot launch* notice" under [Troubleshooting](troubleshooting.md#troubleshooting)).

```sh
claude-slack-channel-bots clear-latch <persona>
```

`<persona>` is the persona's name or its key in the configuration the server runs; quote a name with spaces for your shell. Only that persona's hold is cleared.

Use it once a human has resolved the hold's cause through the "Operator actions" section of agent-director's README: it brings the persona back at once instead of at the server's own check every 2 minutes, and it ends a hold that check cannot clear, such as one on a description the server does not recognise. It is for a human only: no bot is offered it. No restart is needed.

When the persona was held, its destination gets one recovery notice, *Conflict cleared* or *Hold cleared*, and the server brings the persona up at once. If the cause is still there, the persona is held again, with one new notice. Ending a hold also clears the persona's restart limit, so a held persona that had reached the limit is brought up too (see "A held persona at the restart limit" under "How a hold ends" in [Troubleshooting](troubleshooting.md#troubleshooting)). For a persona that is not held, `clear-latch` changes nothing, its restart limit included.

It prints one line on stderr and never repeats its argument:

| Line | Exit | When |
|---|---|---|
| `Usage: claude-slack-channel-bots clear-latch <persona name or key>` | `2` | Not given exactly one non-empty argument. |
| `clear-latch: no server is running` | `1` | `STATE_DIR/server.pid` is absent, unreadable or stale, read as `stop` reads it. |
| `clear-latch: the server did not answer: <cause>` | `1` | The server could not be reached. `<cause>` says why: `server.port is absent`, `server.port could not be read`, `server.port is malformed`, `server.port holds a PID or port out of range` or `server.port was written by another process` (see [PID file](#pid-file)); the connection failed, for example `Error: connect ECONNREFUSED 127.0.0.1:<port>`; or the server gave an unexpected answer, `HTTP <status>`. Check that the server is running and its `bind` (below). |
| `clear-latch: the server did not confirm within 30 s; the clear is queued and may still run. Check this persona's latch in the server log before trying again.` | `1` | No answer came within 30 s, for example while work for the persona was still running; the clear may still run. Look for the persona's `conflict-latch: persona=<key> cleared` line in `server.log` before running the command again. |
| `clear-latch: no persona in the running configuration has that name or key` | `1` | No persona of the configuration the server runs has that name or key. Nothing changed. |
| `clear-latch: cleared the latch of persona "<name>" (key=<key>)` | `0` | The persona was held; the hold and its restart limit are cleared. |
| `clear-latch: persona "<name>" (key=<key>) was not latched; nothing changed` | `0` | The persona was not held, or only by a *Cannot launch* hold, which this command does not end. Its restart limit is unchanged. |

It reaches the server at `127.0.0.1`, at the port the running server recorded in `server.port`, not at the `port` of `config.json`. It connects directly and ignores proxy environment variables such as `HTTP_PROXY`, so its argument never leaves the host. So the server's `bind` must be `127.0.0.1` (the default) or `0.0.0.0`, as scheduled prompts need. On any other `bind` it cannot reach the server, and a hold ends only by the server's own check every 2 minutes, by the persona's teardown (removing it, or a destructive change to it), or by a server restart, which drops every hold.

It needs no agent-director, reads no configuration file and writes or removes no file.

## PID file

The PID file is stored at `STATE_DIR/server.pid` (default: `~/.claude/channels/slack/server.pid`). It is written on startup and removed on clean shutdown. A conflict check at startup prevents running two servers against the same state directory.

Beside it, `STATE_DIR/server.port` records the server's process ID and the port it actually listens on. The server writes it once it is listening and removes it on shutdown. A start that finds a stale PID file removes a stale `server.port` with it, and `stop` removes it with the PID file. [`clear-latch`](#claude-slack-channel-bots-clear-latch) reads it to find the server, and uses it only when the process ID it records is the one in `server.pid`.
