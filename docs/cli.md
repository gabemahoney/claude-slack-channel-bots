# CLI Reference

The `claude-slack-channel-bots` binary exposes five subcommands.

## `claude-slack-channel-bots start`

Checks that the configuration file or the last-applied record exists, starts the server in the background, and waits for it to get through startup.

**Prerequisite check:** `STATE_DIR/config.json` or `STATE_DIR/config.json.last-applied` exists. If neither does, `start` exits 1 with:

```
missing prerequisite: config.json not found at <path>, and no config.json.last-applied at <path>
```

`start` reads no Slack token. The server checks the configuration, and each persona's credentials file, once it runs.

The server first runs the agent-director startup gate: it imports `agent-director`, constructs the singleton Client (which probes the system binary's version and refuses a binary below the client's own minimum), reads the binary's version from the built client and refuses a binary below CSCB's Phase 1 floor, and verifies `~/.config/agent-director/state.db` is owned by the current user. Failures land in `startup-errors.log` (see [Startup errors](troubleshooting.md#startup-errors)). agent-director enforces tmux availability at spawn time. The server then loads the configuration and starts listening. With a last-applied record it runs the record; without one it checks `config.json`, records it and applies it (see [Reload](reload.md#reload)). Only then does it write its PID to `STATE_DIR/server.pid`. Conversation context is preserved across server restarts when possible.

`start` waits up to 30 seconds for that PID file. The outcomes are:

- **The server is up:** `start` prints this line and exits 0.

  ```
  [slack] Server starting in background (PID 12345)
  ```

- **The server exits during startup:** `start` exits 1. It prints why the server stopped, followed by the last lines (at most 20) the server wrote to `server.log`, which carry the server's own reason:

  ```
  [slack] Server failed to start (exit code 1). From /home/you/.config/claude-slack-channel-bots/server.log:
  ```

- **The server is still starting after 30 seconds:** `start` exits 0 and leaves it running.

  ```
  [slack] Server is still starting in the background (PID 12345) after 30s — its log is /home/you/.config/claude-slack-channel-bots/server.log
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

This follows `clean_restart`'s order. It runs the [precheck](#precheck-before-stopping-bots) first, and stops nothing if it fails. When it passes, the server is stopped first, so it can't relaunch a just-exited bot mid-teardown and lose that bot's `ended` row and history, then the bot teardown runs for each persona in the last-applied record (or in `config.json` when there is no record), addressing its instance as `cscb_<key>`: pause the bot, poll until it exits (or up to `exit_timeout` seconds), then force-kill on timeout. Teardown kills but never deletes each row, preserving its `session_id` so the bots can resume their conversation history on the next start. Use it when you want a clean, flushed shutdown of the bots (for example before a host reboot).

If a persona can't be stopped after a passed precheck, the command prints a line naming it, its session and why, ends with a line counting the personas it could not stop, and exits 1 rather than silently reporting a clean stop (see [What the command prints when a bot can't be stopped](#what-the-command-prints-when-a-bot-cant-be-stopped)). `stop --stop-bots` never starts the server: after a failure the server stays stopped, unlike [`clean_restart`](#when-clean_restart-cant-stop-a-bot). When every persona is stopped, one stopped with a *Process outlived kill* text included, it exits with the server stop's status.

`stop --stop-bots` makes no version check of its own, so CSCB can always be stopped, whatever agent-director is installed. On an agent-director older than CSCB needs that the agent-director client still accepts, it works as usual and stops every bot: this is how you stop the bots before the switch-over (see the docs/migration.md section "Switching over to agent-director Phase 1"). On one below the client's own minimum, it stops only the server, leaves every bot and its row as it is, and exits 1 with the last line `stop --stop-bots: only the server was stopped; every worker and row was left as it is` (see ["The two CLI commands on an old binary"](../skills/debug-slack-channel-bots/SKILL.md#the-two-cli-commands-on-an-old-binary) in the debugging skill for its lines and how to tell whether the server is down).

A configuration that cannot be loaded, a bad record or a missing or pre-persona file included, is best-effort: it prints `[slack] stop --stop-bots: could not load config — skipping bot teardown:` with the cause, and no persona is checked. The command still connects to agent-director, with the default call timeout. Once the connection succeeds, the server is stopped and the teardown is skipped. A failed connection stops nothing (see [Precheck before stopping bots](#precheck-before-stopping-bots)); on an agent-director below the client's own minimum only the server is stopped, as described above.

## `claude-slack-channel-bots clean_restart`

Runs the [precheck](#precheck-before-stopping-bots), then stops the server, gracefully exits all managed Claude Code sessions, and starts the server again.

```sh
claude-slack-channel-bots clean_restart
```

For each persona in the last-applied record (or in `config.json` when there is no record), it pauses the persona's instance, `cscb_<key>`, through agent-director and waits until the instance has ended or is missing, or its row is gone. A bot that has not exited within `exit_timeout` seconds (default 120s) is force-killed. Teardown kills but never deletes each row, preserving its `session_id` so bots resume their conversation history on the next start. All personas are processed in parallel. After the server restarts, it decides for each persona whether to resume its conversation or start a fresh one.

`clean_restart` logs its progress to `STATE_DIR/clean_restart.log`. The lines that end it with an error (config load failure, agent-director initialization failure, a failed precheck, a persona it could not stop, the alert that the server was not started, start failure) are also printed to the terminal, and so is any *Process outlived kill* text from the teardown, even on a run that goes on to start the server.

`clean_restart` loads the last-applied record first, or `config.json` when there is no record, and takes `exit_timeout` from it. If it cannot (a record that can't be read or is invalid, or a missing or pre-persona file), it exits 1 with `[slack] clean_restart: failed to load config:` and the loader's error, and nothing is stopped. For a bad record, the error says that deleting it makes the next start apply `config.json` (see [Reload](reload.md#reload)). `clean_restart` doesn't apply a pending `config.json` edit: the server comes back on the record.

A persona whose force-kill succeeds, or whose instance is found already ended, missing or gone, counts as stopped; so does one whose force-kill ends with a *Process outlived kill* text. When every persona is stopped, the server is started and the command exits with the start's status. When a persona can't be stopped, the command prints its line once every persona's teardown has finished, then starts the server only if agent-director answers, and exits 1 either way (see [When `clean_restart` can't stop a bot](#when-clean_restart-cant-stop-a-bot)).

Behavior by case:

- **No personas** (`"personas": []`): nothing is torn down; the server is stopped and started.
- **A persona with no instance:** logs `[slack] teardownBots: no spawn row for persona "<name>" (key=<key>) — skipping` and continues. This message appears only when a persona genuinely has no instance, never when the command failed to reach agent-director.
- **Server already stopped:** `stop` reports `server is not running`; `start` then brings up a fresh server.
- **Server fails to start again:** `clean_restart` exits non-zero with `[slack] clean_restart: start failed with exit code <n>`; the reason is in `server.log`.
- **agent-director unreachable, or a persona's instance can't be read:** the precheck fails and nothing is stopped: the old server and every bot keep running, and `clean_restart` exits 1 (see [Precheck before stopping bots](#precheck-before-stopping-bots)).
- **An agent-director older than CSCB needs:** `clean_restart` runs the same version checks as the server's start, so on an agent-director below CSCB's Phase 1 floor, or below the client's own minimum, its precheck fails at the connection and nothing is stopped. Follow the docs/migration.md section "Switching over to agent-director Phase 1". To stop the bots before the switch-over, use `stop --stop-bots`, which works on any agent-director the client accepts (see [`stop`](#claude-slack-channel-bots-stop)).
- **agent-director fails during the teardown:** that persona can't be stopped, so the command exits 1, as below.

### What the command prints when a bot can't be stopped

`stop --stop-bots` and `clean_restart` share one bot teardown. A refused pause leads on to the force-kill unless the cause is one a force-kill can't fix (a tmux session conflict, an unusable tmux session name, tmux unavailable, an agent-director internal error or a refused config file); a force-kill that can't act right now is tried up to 3 times, 2 s apart. The other personas are still torn down. Once every persona's teardown has finished, the command prints one line per persona it could not stop, in configuration order:

```text
<command>: could not stop persona "<name>" (key=<key>), session "slack_bot_<key>": <CLASS>: <description>
```

When agent-director could not end the worker, the *Kill failed* notice's text follows the line; a persona whose force-kill ended with a process outliving it counts as stopped and gets the *Process outlived kill* text instead. The command ends with a last line counting the personas it could not stop:

```text
stop --stop-bots: could not stop <N> persona(s); rows are never deleted, so running the command again is safe
```

The lines go to the terminal and `server.log`, and each failed persona gets one entry in `startup-errors.log`; `clean_restart` also writes them to `clean_restart.log`. Nothing is posted to Slack, and no persona is held. The debugging skill's ["`stop --stop-bots` or `clean_restart` could not stop a persona"](../skills/debug-slack-channel-bots/SKILL.md#stop---stop-bots-or-clean_restart-could-not-stop-a-persona) has every class, the rules for the pause and the force-kill, where each line goes and how long a teardown can take; what to do is under "`clean_restart` or `stop --stop-bots` exits non-zero with `could not stop`" in [Troubleshooting](troubleshooting.md#troubleshooting).

### When `clean_restart` can't stop a bot

While agent-director answers, a bot that can't be stopped never leaves the whole fleet down. Once every persona's line is printed, `clean_restart` checks that agent-director answers (up to 3 tries, 2 s apart).

- **agent-director answers:** the server is started, as at any start. Every row is kept, and the new server keeps each configured persona's own instance that is still running, one the command could not stop included.
- **agent-director doesn't answer:** the server is not started, so nothing starts on top of bots the command could not reach. The command prints one alert naming every persona it could not stop, appends it to `server.log` and records it as one `clean-restart-not-restarted` entry in `startup-errors.log`:

  ```text
  clean_restart: could not stop persona "<name>" (key=<key>), session "slack_bot_<key>": <CLASS>; agent-director did not answer, so the server was not started: start it once agent-director answers
  ```

  Once `agent-director version` answers, start the server with `claude-slack-channel-bots start`.

Either way the last line follows, and the command exits 1. Rows are never deleted, so running `clean_restart` again once the cause is fixed is safe.

## Precheck before stopping bots

Before `stop --stop-bots` or `clean_restart` stops anything, it checks that agent-director answers and that each persona's instance can be read:

1. It connects to agent-director. `clean_restart` makes the same version checks as the server's start. `stop --stop-bots` makes no version check of its own: any agent-director the client accepts passes, one older than CSCB's Phase 1 floor included.
2. For each persona in the last-applied record (or in `config.json` when there is no record), it reads the persona's instance, `cscb_<key>`. A persona with no instance, or whose instance has finished, is skipped. A running instance has one line of its screen read.

A failed precheck prints one line per persona it could not check, naming its class (such as `CONFLICT`, `UNAVAILABLE` or `CONFIG`), then a closing line, and exits 1:

```text
clean_restart: precheck failed for persona "<name>" (key=<key>), session "slack_bot_<key>": <CLASS>: <description>
clean_restart: nothing was stopped
```

When the connection in step 1 fails, the command prints `[slack] <command>: agent-director initialization failed:` with the reason, then `<command>: nothing was stopped`. Nothing was stopped: the server and every bot keep running. Fix the cause, then run the command again. The debugging skill's ["A precheck failed: nothing was stopped"](../skills/debug-slack-channel-bots/SKILL.md#a-precheck-failed-nothing-was-stopped) has every class and its fix.

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

The PID file is stored at `STATE_DIR/server.pid` (default: `~/.config/claude-slack-channel-bots/server.pid`). It is written on startup and removed on clean shutdown. A conflict check at startup prevents running two servers against the same state directory.

Beside it, `STATE_DIR/server.port` records the server's process ID and the port it actually listens on. The server writes it once it is listening and removes it on shutdown. A start that finds a stale PID file removes a stale `server.port` with it, and `stop` removes it with the PID file. [`clear-latch`](#claude-slack-channel-bots-clear-latch) reads it to find the server, and uses it only when the process ID it records is the one in `server.pid`.
