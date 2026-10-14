# Moving between releases

How to install this release over an earlier one, and how to go back. What changed in each release is in [CHANGELOG.md](../CHANGELOG.md).

## Migration

This release requires agent-director 0.12.0 or later. Its 0.12.0 client and the host CLI are upgraded together, and rolled back together, by the two runbooks below. Beside them:

1. **Install the new CSCB together with agent-director 0.12.0**: installing the npm package is not the whole install. This release needs agent-director Phase 1 on the host, installed with it by the runbook in [Switching over to agent-director Phase 1](#switching-over-to-agent-director-phase-1), which also says when to install the package. The npm `agent-director` package CSCB pulls in is only the client; the binary is installed system-wide (see [Prerequisites](../README.md#prerequisites)).
2. **(Optional) Run a periodic agent-director `find-missing` sweep**. CSCB itself runs `find-missing` once before a resume during dead-session recovery, so a bot that died on reboot comes back with its history intact. If agent-director doesn't answer that sweep (it times out or reports tmux not answering), CSCB stops the recovery there, with no resume and no fresh session, and retries it later. CSCB's own recovery needs no periodic sweep; one reconciles the rows of agent-director's other users on a cadence. A host that follows the switch-over runbook runs one: [switch-over step 11](#step-11-schedule-the-daily-expire) adds it where the host has none. Run it as a cron entry, a systemd timer or a loop script (the switch-over runbook calls this the host's sweep schedule). As a cron entry:
   ```cron
   * * * * * $HOME/.config/agent-director/bin/agent-director find-missing
   ```
   The job must run as the workers' user and resolve their tmux socket, the socket switch-over step 1 pins.
3. **Install the startup-errors logrotate snippet** so `~/.config/claude-slack-channel-bots/startup-errors.log` doesn't grow unboundedly. Edit `USER` in the file to match the OS account running CSCB:
   ```sh
   sudo cp docs/logrotate-startup-errors.conf /etc/logrotate.d/claude-slack-channel-bots
   ```
   A snippet installed by an earlier release names `/home/USER/.claude/channels/slack/startup-errors.log` or `/home/USER/.config/cscb/startup-errors.log`: copy the file again, or change that path to `/home/USER/.config/claude-slack-channel-bots/startup-errors.log`.
4. **Stop the old server before the first start after an upgrade from a release that kept its state in `~/.claude/channels/slack` or `~/.config/cscb`.** The state directory is now `~/.config/claude-slack-channel-bots` (`$XDG_CONFIG_HOME/claude-slack-channel-bots` when `XDG_CONFIG_HOME` is an absolute path). The first `start` moves `~/.config/cscb` there, then `~/.claude/channels/slack`, overwrites nothing in the new directory, and leaves each old name as a symbolic link to it. It refuses to start (exit 1, nothing moved, a `[slack] state-migrate: a server is still running on the old state directory …` line) while a server still runs on an old directory: run `claude-slack-channel-bots stop` (it finds the old directory), then `start`; `clean_restart` does both. A host that follows the switch-over runbook stops the old server in step 3 and moves the directory at the first start, in step 10; create nothing at `~/.config/claude-slack-channel-bots` before that start, or it merges the old directory into the new one instead of moving it whole. With `SLACK_STATE_DIR` set, nothing moves. What each starting point (0.13 and earlier, 0.14.0, 0.15.0) ends with is in the [CHANGELOG](../CHANGELOG.md) entry "The state directory is renamed to `~/.config/claude-slack-channel-bots`"; a conflict or a failed move is in the debug skill under [The state directory's location and its move at start](../skills/debug-slack-channel-bots/SKILL.md#the-state-directorys-location-and-its-move-at-start).

### Switching over to agent-director Phase 1

This release requires agent-director Phase 1, installed on the host together with it; CSCB changes no agent-director code. The two are installed together, by this runbook, and [rolled back together, by "Rolling back the switch-over"](#rolling-back-the-switch-over).

- Every agent on the host, with every long-running agent-director process (`agent-director serve` included), is stopped before either binary change and started again after it.
- The previous CSCB runs only with its compatible CLI, and this release runs only with 0.12.0 or later: no bot server runs between step 3 and step 10, and no side-by-side install under another path is used.
- The switch-over log is your own record, kept wherever you choose until rollback is no longer wanted. Each step says what to record in it.
- Run every command as the workers' user (the user the bot server launches workers as), in the tmux environment step 1 pins.
- Steps marked "operator action" are done by a human on the host; nothing in CSCB does them.

#### Arrived here from a startup refusal?

Your new CSCB is installed and its server refused to start with `ad-below-phase1-floor` or `ad-system-install-too-old`. Ordinary 0.10.0/0.11.0 releases and 0.12.0 release candidates produce `ad-system-install-too-old`; the unsupported development placeholder `0.0.0-dev` produces `ad-below-phase1-floor`. The refusal launched, killed and deleted nothing, and left your bots as they were.

Check the resolved CLI path and version as the workers' user in the server launcher's environment. CSCB finds `$HOME/.config/agent-director/bin/agent-director` before PATH. A missing CLI, a CLI older than 0.12.0 or an unmigrated old layout must be fixed with the released installer before starting CSCB.

If the previous AD is still installed, first reinstall the previous CSCB without starting the new release, and restore its saved configuration, crontable and `/interject` callers as described in [rollback step 8](#step-8-reinstall-the-previous-cscb). Its client must be compatible with that CLI so step 3's `stop --stop-bots` can stop the workers. If the saved files are missing, rebuild them by hand before continuing; then start the previous CSCB on its compatible CLI and begin step 1.

If AD has already been upgraded, verify that the launcher resolves the upgraded CLI and its `config_dir`; fix any stale path before restarting, or restore both releases with the rollback runbook. No agent or caller may run across the AD upgrade. Do not create a new template or copy a binary over the old install.

A stop by the runtime re-check is not a switch-over case. Follow the debug skill's [Found while the server was running](../skills/debug-slack-channel-bots/SKILL.md#found-while-the-server-was-running) remedy.

#### The publishing host

`/publish` requires a system-installed CLI admitted by the pinned client: 0.12.0 or later. Use a host that already passes `bun run install-check`. A host without AD installs the released CLI using its installer; a host with an older install follows the coordinated upgrade below before running the new client.

#### Step 1: Check the host and stage the release

Do this beforehand, with the old CSCB running and still installed as the global package. Nothing goes down in this step.

1. **The go-ahead (operator action).** Confirm the go-ahead for the switch-over on this host, and record it in the switch-over log. The go-ahead is the approval for the switch-over. If there is no go-ahead, stop here, before anything goes down.

   The go-ahead is the operator's decision, and agent-director ships no install-gate file or record. agent-director's Phase 1 install gate is the set of CSCB fixes that must be in place on a host before Phase 1 is installed there. This release, installed together with agent-director Phase 1 as this runbook does, meets it.
2. **agent-director's version.** Run `agent-director version` in the bot server's launcher environment as the workers' user. Record its version and resolved path. Stage the released 0.12.0 installer and both binaries, and keep the prior install and flags for restoration. A host already on 0.12.0 or later needs no directory migration; verify its `config_dir` and client compatibility before restarting callers.
3. **The tmux socket (operator action).** Pin the tmux socket for the bot server's launcher, the host's sweep schedule and the workers. The sweep schedule is whatever runs `agent-director find-missing` on a schedule on your host: a cron entry, a systemd timer or a loop script. Run `tmux display-message -p '#{socket_path}'` from the bot server's launcher, the sweep schedule's environment and a worker's. Confirm that all three print the same path, that it is the pinned path (a `TMUX_TMPDIR` that names a missing path falls back silently to `/tmp`), and that the three share one HOME. A host with no sweep schedule checks the other two, and runs the one step 11 adds in the same environment. Record the result in the switch-over log.
4. **tmux.** Confirm tmux 3.2 or later, with `remain-on-exit` off.
5. **Claude Code.** Run `claude --version` in the bot server's launcher environment (the same user and `PATH` the server launches workers with), and confirm that the workers' Claude Code is 2.1.280 or later: CSCB's supported minimum and the version the fleet runs. On a Claude Code too old for exec-form hooks (older than 2.1.139), each hook prints nothing, agent-director records `ad.hook.ignored` with the reason `no_exec_form`, and every launch stays `pending`. If it is older than 2.1.280, stop here, before anything goes down. In the same environment, run `command -v claude` and confirm that it resolves to Claude Code's native binary or to a wrapper that `exec`s it. A launcher or shim that runs Claude Code as a child process makes agent-director ignore every hook, recording `ad.hook.ignored` with the reason `pid_mismatch`, and every launch stays `pending`; replace such a launcher now.
6. **agent-director's timing settings.** Before the AD directory move, read all nine keys of the `[tmux]` table of the existing installation’s `~/.agent-director/config.toml` (an explicit pre-upgrade path exception). If AD is already upgraded, use `~/.config/agent-director/config.toml` instead. A missing file, a missing key or `0` means the default (see [agent-director's timing settings](agent-director.md#agent-directors-timing-settings)). Also read that file’s `[pause] timeout_seconds` (30 s when the file or the key is missing). Record the effective values in the switch-over log. Confirm that the three windows, `pending_grace_seconds`, `stopping_window_seconds` and `starting_session_seconds`, are the values you intend and each is at or above its minimum: `starting_session_seconds` 60, `stopping_window_seconds` 30, and `pending_grace_seconds` the larger of 30 and ⌈(`create_timeout_ms` + `pipe_close_wait_ms`) / 1000⌉ + 20. A `pending_grace_seconds` above 540 s shortens agent-director's SessionStart wait to 540 s. In the same file, read `[defaults] expire_retention_days`: Phase 1 accepts 1 to 106751, and `0` or a missing key gives 31 days. A negative value or one above 106751 makes Phase 1 refuse its whole configuration with `ErrConfigMalformed`, from the install on: every store-backed verb, `serve` and the hooks. Correct such a value now, and record the effective value in the switch-over log.
7. **The call timeout.** Always computing from this host's values, confirm that the `agent_director_call_timeout_ms` the persona configuration will carry (staged below; `60000` when it leaves the setting out) exceeds the need: the largest ceiling among the verbs CSCB calls, plus the 15 s margin (15000 ms). Record the computed need in the switch-over log. With Q, A, C, W and E the host's `query_timeout_ms`, `action_timeout_ms`, `create_timeout_ms`, `pipe_close_wait_ms` and `kill_exit_wait_ms`, and B its `sweep_budget_seconds` in ms, the ceilings, in ms, are:
   - `kill`: the larger of 2Q + 2A + E + 4W and 3Q + 2A + 5W;
   - `read-pane`: 3Q + A + 4W;
   - `send-keys`: 3Q + 2A + 5W;
   - `pause`: 3Q + 2A + 5W, plus `[pause] timeout_seconds` (times 1000);
   - the launch row, `resume/spawn-with-reuse/plain-spawn` (`resume`, a spawn with reuse and a plain spawn): the larger of Q + C + 2A + 4W and 2Q + C + 3W;
   - `find-missing`: B + Q + W.

   `expire` is not among them: CSCB never calls it. [Sizing the agent-director call timeout](agent-director.md#sizing-the-agent-director-call-timeout) works through examples.
8. **Leftover sessions.** As the workers' user, on the pinned socket, compare `tmux ls` with `agent-director list`, and record in the switch-over log every `slack_bot_` session that no row names.
9. **Stage the new release without installing it.** Choose its exact version, record it in the switch-over log and confirm that it is available to install. On an existing-persona host (0.11.0 or later), retain the current persona configuration and credentials files, persona keys, `working_directory`, `claude_config_dir`, `resume_enabled` and state paths; check the existing call timeout against item 7. Nothing is installed over the global package yet, so step 3 uses the old package's own stop command against its current files. The rest of this item applies only to a pre-persona host (0.10.x). Write the persona configuration, with `agent_director_call_timeout_ms`, in a separate file, never `config.json`, which the old CSCB reads. Prepare the Slack apps. Nothing is installed over the global package yet, so step 3's `stop --stop-bots` is the old version's own and reads the old, pre-persona `config.json` from the old state directory, `~/.claude/channels/slack`, where the old package keeps it. In the staged file, name each persona's `credentials_file` in that directory too, never under `~/.config/claude-slack-channel-bots` (step 7 says why). Steps 1, 2, 3, 5 and 6 of [Upgrading to personas](#upgrading-to-personas) belong here.
10. **Copies for rollback.** On an existing-persona host (0.11.0 or later), back up the current persona `config.json`, credentials files, crontable, `/interject` callers and state files, including `config.json.last-applied` and `retired-keys.json` when present, outside the state directory. Record their current paths for restoration. On a pre-persona host (0.10.x), keep copies of the pre-persona `config.json`, the crontable, the `/interject` callers (the host crontab's `curl` lines included), `access.json` and the Slack token environment variables the old CSCB uses. The old CSCB keeps `config.json`, the crontable and `access.json` in the old state directory, `~/.claude/channels/slack`: keep the copies outside it, because the first start in step 10 moves that directory. Record the old CSCB's exact version in the switch-over log beside them.
11. **The orchestrator prompt (operator action).** The shared orchestrator prompt's "ship now" wording may go out any time before the switch-over. The shared orchestrator prompt is the system prompt your orchestrator bots load, for example the file `append_system_prompt_file` names.

#### Step 2: Disable CSCB's autostart

Disable the host's autostart for CSCB until step 10 (operator action), and record it in the switch-over log.

#### Step 3: Stop the old CSCB with its bots

With the old CSCB still installed, run its own stop:

```sh
claude-slack-channel-bots stop --stop-bots
```

On an existing-persona host (0.11.0 or later), this is the old package's own stop command, reading its current persona configuration and state paths. On a pre-persona host (0.10.x), this is the old version's own `stop --stop-bots`, which reads the old, pre-persona `config.json` from the old state directory, `~/.claude/channels/slack`, where the old package keeps it, since nothing new is installed before step 7. An operator arriving from a startup refusal has first reinstalled the previous CSCB (see [Arrived here from a startup refusal?](#arrived-here-from-a-startup-refusal)), so this holds for them too. From here until step 10, no bot server runs.

#### Step 4: Wait for the old rows to end

Run `agent-director find-missing`, then wait at most 5 minutes for every `service=cscb` row to read `ended` or `missing`:

```sh
agent-director find-missing
agent-director list --label service=cscb
```

A row still live after that is handled in step 5.

#### Step 5: Check for leftover sessions

As the workers' user, on the socket pinned in step 1, run a read-only `tmux ls`. Look for any old `slack_bot_<name>_<channel>` or `slack_bot_<channel ID>` session, and any live old row. Handle each leftover by its kind:

- **A leftover with a row** (live or finished) is ended in step 6, before the Phase 1 install.
- **A leftover with no row, whose name cannot equal any new persona's `slack_bot_<key>`:** record it in the switch-over log and go on; agent-director matches session names exactly. You may end it later with the exact-name `tmux kill-session -t =<name>`.
- **A leftover with no row, whose name equals a new persona's `slack_bot_<key>`:** note its window ids with a read-only `tmux list-windows -t =<name>`, end it with the exact-name `tmux kill-session -t =<name>`, and make the gone check.

**The gone check**, as the workers' user on the pinned socket: a read-only `tmux ls` no longer shows the session, and a read-only `tmux list-windows -a` shows none of its windows in any other session. A grouped session or a linked window keeps the worker running after its session is ended.

#### Step 6: End the leftovers that have a row

Only if step 5 found a leftover with a row. End each such leftover now, with the still-installed previous binary. After the Phase 1 install, a row from before it has no launch token or recorded socket, so no session is ever its current launch's: Phase 1's `kill` fails closed on it, and not even agent-director's option for a finished row ends its session.

For each one:

1. Note the session's window ids, as in step 5.
2. With a pre-0.12 CLI, take `<id>` from the old `claude_instance_id` field returned by `agent-director list` (any extraction pipeline must read `.claude_instance_id`, not `.instance_id`), then run `agent-director kill --claude-instance-id <id>` and check its result; on an error, don't delete or respawn. These old names are an explicit migration exception while that CLI remains installed. If AD is already on 0.12.0 or later, use the returned `instance_id` and run `agent-director kill --instance-id <id>` and check its result; on an error, don't delete or respawn. Then make the gone check.
3. If the session or one of its windows remains, end the session with the exact-name `tmux kill-session -t =<name>`, and make the gone check again.
4. Run `agent-director find-missing` until the row reads `ended` or `missing`, for at most 5 minutes.

A leftover that cannot be ended this way means no Phase 1 install: take step 8's "no go" branch, and investigate the leftover with `agent-director list --tmux-session-name <name>`.

#### Step 7: Install the new CSCB without starting it

1. Install the staged package over the global install, without starting it; the autostart stays disabled from step 2:
   ```sh
   bun install -g claude-slack-channel-bots@<the version recorded in step 1>
   ```
2. On an existing-persona host (0.11.0 or later), retain its current persona configuration and paths. On a pre-persona host (0.10.x), put the persona configuration in place as `config.json`, in the old state directory, `~/.claude/channels/slack`, which the new CLI keeps using until the new CSCB's first start.
3. On an existing-persona host, retain its credentials files and paths. On a pre-persona host (0.10.x), write each persona's credentials file with the new CLI (see [`claude-slack-channel-bots credentials`](cli.md#claude-slack-channel-bots-credentials)), into the same directory: each `credentials_file` in the staged configuration names a path there.
4. On an existing-persona host, retain the current crontable and `/interject` callers. On a pre-persona host (0.10.x), rewrite crontable targets and `/interject` callers to name personas, in the crontable in the same directory.
5. Run the new install check (see [Checking your agent-director install](agent-director.md#checking-your-agent-director-install)). An older CLI is refused by the 0.12.0 client; do not start CSCB until step 8 installs the required CLI.

On a pre-persona host (0.10.x), steps 4, 7 and 8 of [Upgrading to personas](#upgrading-to-personas) belong here. From this step the new CSCB is deployed but not started.

For a host whose state has not yet moved to the current directory, **steps 7 and 8, the call-timeout edit included, must not create `~/.config/claude-slack-channel-bots`.** The credentials command makes the directory of a `credentials_file` that is missing, so a path under `~/.config/claude-slack-channel-bots` creates it. The new CSCB's first start moves the old state directory to `~/.config/claude-slack-channel-bots` in one rename when that does not exist; when it exists, the start merges the old directory into it entry by entry, and a file that differs in the two is a conflict that leaves the old directory in place.

#### Step 8: Install agent-director Phase 1

1. **The go-ahead (operator action).** Confirm that the go-ahead for this host still stands, and record it in the switch-over log.

   **No go.** If there is no go-ahead, there is no Phase 1 install. Reinstall the previous CSCB, the version step 1 recorded, and restore its version-appropriate files at the paths saved in step 1. On an existing-persona host (0.11.0 or later), restore the persona configuration, credentials files, crontable, `/interject` callers and saved state, including `config.json.last-applied` and `retired-keys.json` when backed up. On a pre-persona host (0.10.x), restore the `config.json`, crontable, `/interject` callers, `access.json` and Slack token environment variables saved in step 1. Start it on the previous compatible CLI and re-enable its autostart (operator action). Every other agent this step already stopped is started again on the previous compatible CLI by its owner (operator action). The runbook stops there.
2. **Stop every other agent (operator action).** Otherwise, before the install, disable everything that starts agents and stop every other agent on the host: orchestrators' workers, hand-started sessions and sessions with an `agent-director serve`. Stop every long-running AD process and every caller, including TypeScript clients, before the installer runs. Use the still-installed CLI's `kill` and `find-missing` to reconcile stopped agents, using step 6's version-specific identifiers and flags. Confirm with `agent-director list` that all rows are non-live (`ended` or `missing`), with a read-only `tmux ls` that no agent session is left, and with process checks that all workers, callers, serves and launchers are stopped. Record it in the switch-over log. An unresolved live row or a process that cannot be stopped means "no go": do not run the installer, delete rows or edit SQL to fake a terminal state. No agent may run across the upgrade; the installer enforces this with `ErrAgentsLive`.
3. **Back up the store and locate the original install.** Run from a shell agent-director did not start, in the directory the original installer ran in (or the same repository). Before the move, the default store is `~/.agent-director/state.db`. For an external `[store] db_path`, save `state.db`, `state.db-wal` and `state.db-shm` while all callers are stopped; the installer migrates an external store in place and rollback needs that copy. Keep the original installer flags and registrations in the switch-over log.
4. **Install released agent-director 0.12.0 with its own installer.** Follow [agent-director's installer instructions](https://github.com/gabemahoney/agent-director/blob/v0.12.0/skills/install-agent-director/SKILL.md). Do not copy binaries by hand or create templates in the new directory first. The installer moves `~/.agent-director` to `~/.config/agent-director`, keeps the original as `~/.agent-director.pre-move-<timestamp>`, migrates the store to schema 9, and migrates config and templates. Preserve that kept directory until rollback is no longer wanted. Fix any manual PATH, hook or MCP entries the installer reports, including entries under other Claude config directories; confirm `agent-director version` reports 0.12.0 or later and the new `config_dir`.
5. **Write the `[tmux]` values.** Right after the install, before the restarts that follow and so before the new CSCB starts, write any non-default `[tmux]` values you want into `~/.config/agent-director/config.toml`. A long-running agent-director process reads the file only when it starts.
6. **Restart callers (operator action).** Restart every `agent-director serve` process and every caller, including TypeScript clients. Compare process start times to confirm that none is older than the install. Record the version and that result in the switch-over log.
7. **Check the settings again.** Read the nine timing settings and `[pause] timeout_seconds` again as in step 1, and record the effective values. Confirm them and the call timeout as in step 1; if the need has grown, raise `agent_director_call_timeout_ms` in `config.json` before step 10, in the host's current configuration at its existing path (step 7's warning applies if the state directory has not yet moved). Confirm that `agent-director list` answers without `ErrConfigMalformed`.

#### Step 9: Start the other agents again

Every other agent on the host is started again by its owner (operator action), which also starts its `serve` processes on the Phase 1 binary.

#### Step 10: Start the new CSCB

1. **The orchestrator prompt's worker cleanup (operator action).** Before the new CSCB starts, change worker cleanup in the shared orchestrator prompt, and in its source copy if you keep one, from row-delete cleanup to "kill, then leave the row". This change goes out in the same deploy as agent-director Phase 1. Kill-then-leave works on 0.10.0 too, so a rollback does not revert it.
2. **Start the new CSCB**, then re-enable the host's autostart for CSCB (operator action):

   On a host already running personas (0.11.0 or later), check each persona before starting:
   ```sh
   agent-director get --instance-id cscb_<key>
   ```
   For a resume, the row must show `state` as `ended` or `missing`, a non-empty `session_id`, and `transcript_status: present`. Keep the persona's key, `working_directory` and `claude_config_dir` unchanged, leave `resume_enabled` enabled, and confirm on the pinned tmux socket that no leftover session has the persona's session name. Record the results in the switch-over log.

   Start the server:
   ```sh
   claude-slack-channel-bots start
   ```
   On a host switching over from a pre-persona release (0.10.x), the first start has no last-applied record yet, so it checks `config.json`, records it and applies it; after that, edits wait until you apply them (see [Reload](reload.md#reload)). Each persona starts fresh once on that host. Pre-persona rows are kept and never resumed. On a host already running personas (0.11.0 or later), each persona resumes its conversation when the resume conditions above hold.

   For each persona being resumed, check `server.log` for `spawnForPersona: attempting resume for …`, and record it in the switch-over log. agent-director 0.12.0 resumes only the current session: it no longer falls back to an older session's transcript when the current one is missing.

   A host already using the current state directory keeps that path; with `SLACK_STATE_DIR` set, nothing moves. On a pre-persona host (0.10.x) still using the old default path, this start also moves the old state directory: `~/.claude/channels/slack` is renamed to `~/.config/claude-slack-channel-bots`, a symbolic link to it is left at the old name, and the server logs one `[slack] state-migrate: moved the state directory from …` line to `~/.config/claude-slack-channel-bots/server.log`. Edit `config.json` and the other state files through `~/.config/claude-slack-channel-bots` after it. An existing-persona host still using an earlier default state directory follows the state-directory move described in [Migration](#migration); keep its configuration and credentials paths intact.
3. **The post-install check (operator action).** Once every agent has been started again, confirm that `agent-director list --state pending` shows a `launch_started_at` on every row. Record the result in the switch-over log. A row without one is a human's to look at, and the persona whose row it is is held (see "A persona posts a *Held: launch start not recorded* notice" and "How a hold ends" in [Troubleshooting](troubleshooting.md#troubleshooting)).

#### Step 11: Schedule the daily expire

Schedule a daily `agent-director expire` at the default retention, never `--older-than 0d`, as the workers' user in the tmux environment step 1 pinned (operator action). Add it to the host's sweep schedule, the one step 1's socket check names: whatever runs `agent-director find-missing` on a schedule on your host, such as a cron entry, a systemd timer or a loop script. Nothing on the host runs `expire` before this step. A host with no sweep schedule must add one now (operator action), as the workers' user in the tmux environment step 1 pinned, running both `agent-director find-missing` on a schedule ([Migration](#migration) shows it as a cron entry) and the daily `expire`.

The shared orchestrator prompt's "hold until after" wording goes out now (operator action).

### Rolling back the switch-over

This runbook takes the host back to the previous CSCB on its previous compatible agent-director, whether agent-director Phase 1 was installed by [Switching over to agent-director Phase 1](#switching-over-to-agent-director-phase-1) or some other way. Both binaries are rolled back together.

- Stop all callers before restoring the previous agent-director using the released way-back procedure in step 6: restore the retained old directory and any external store's pre-upgrade copy. Schema 9 has no SQL downgrade. Data written since the upgrade is lost; restart only callers compatible with the restored CLI, including the previous CSCB.
- The store is shared by every agent-director user on the host. Without stopping all callers first, a restore would drop the rows of other services' workers spawned since the switch-over, leaving them running with no row.
- Every agent on the host, with every long-running agent-director process (`agent-director serve` included), is stopped before the previous binary is restored and started again after it.
- Keep using the switch-over log. Each step says what to record in it.
- Run every command as the workers' user, in the tmux environment switch-over step 1 pinned.
- Steps marked "operator action" are done by a human on the host; nothing in CSCB does them. "Operator actions" is that section of agent-director's README.

#### Step 1: Disable CSCB's autostart for the rollback

Disable the host's autostart for CSCB until step 9 (operator action), and record it in the switch-over log.

#### Step 2: Remove the daily expire from the sweep schedule

Remove the daily `agent-director expire` run that switch-over step 11 added to the host's sweep schedule, the cron entry, systemd timer or loop script that runs it (operator action), and record it in the switch-over log. This comes before the previous binary is restored, because the older `expire` does not check tmux.

#### Step 3: Stop the new CSCB with its bots

```sh
claude-slack-channel-bots stop --stop-bots
```

The command's failure lines are described in [Precheck before stopping bots](cli.md#precheck-before-stopping-bots) and [What the command prints when a bot can't be stopped](cli.md#what-the-command-prints-when-a-bot-cant-be-stopped).

- **A persona in CONFLICT.** If the command exits non-zero naming a persona in CONFLICT, a human follows "Operator actions" for that persona's session, checks the result, and runs `stop --stop-bots` again.
- **When the bots can't be stopped.** If that session cannot be ended that way, or the command exits non-zero because agent-director does not answer or a call stays UNAVAILABLE after its retries, stop the server with plain `stop`, and record in the switch-over log each persona and session the failed command named:
  ```sh
  claude-slack-channel-bots stop
  ```

#### Step 4: Wait for the new rows to end

Run `agent-director find-missing`, then wait at most 5 minutes for every `service=cscb` row, the rows of retired persona keys included, to read `ended` or `missing`:

```sh
agent-director find-missing
agent-director list --label service=cscb
```

A row still live after that (for example a retired key whose kill failed, which `stop --stop-bots` does not cover) is ended by a human:

1. Run `agent-director kill --instance-id <id>`, and check its result; on an error, don't delete or respawn.
2. A `kill` refused with CONFLICT ("not this launch's session") has met a leftover of an earlier launch: handle it as "Operator actions" describes.
3. If these kills keep failing, follow "Operator actions" for that worker, and record it in the switch-over log.

Nothing goes on to step 6 while such a worker runs, because every agent must be stopped before the previous binary is restored.

**When "Operator actions" cannot end it either**, the rollback stops here, with Phase 1 still installed, and the worker is taken to agent-director. So that the fleet does not stay down while agent-director investigates, start the new CSCB again, restore step 2's daily `expire` to the host's sweep schedule, and re-enable the host's autostart for CSCB (operator action). If that start is refused, the new CSCB stays stopped until agent-director has dealt with that worker; then follow the already-upgraded CLI check in [Arrived here from a startup refusal?](#arrived-here-from-a-startup-refusal).

#### Step 5: Check for leftover persona sessions

As the workers' user, on the socket switch-over step 1 pinned, run a read-only `tmux ls`, and confirm that no `slack_bot_<key>` session is left. Handle each leftover by whether it has a row and, if it has one, by that row's current state:

- **A leftover whose row is live:** end it with `agent-director kill --instance-id cscb_<key>`, and check its result; on an error, don't delete or respawn. When that `kill` is refused with "not this launch's session", handle it as "Operator actions" describes.
- **A finished row's own leftover session:** handle it as "Operator actions" describes.
- **An operator action refused inside the stopping window or the starting-session bound:** retry it once the longer of the two has passed. Read all nine timing settings again, as in switch-over step 1, for the two windows' values, and record them in the switch-over log. A plain `kill` never refuses for that reason.
- **A leftover with no row:** handle it as in [switch-over step 5](#step-5-check-for-leftover-sessions), against the previous CSCB's session names: `slack_bot_<key>` for an existing-persona release (0.11.0 or later); for a pre-persona release (0.10.x), the previous CSCB's session names (`slack_bot_<name>_<channel>` or `slack_bot_<channel ID>`) instead of the new personas'.

Check each result, then run `agent-director find-missing` and switch-over step 5's gone check again. Don't go on while a leftover remains. When rolling back to a pre-persona release (0.10.x), the previous CSCB's first start deletes every row without a `channel` label. This row-deletion warning does not apply when restoring an existing-persona release (0.11.0 or later).

#### Step 6: Stop every agent and restore the previous agent-director

1. **Stop every other agent (operator action).** Disable everything that starts agents. Before the previous binary is restored, stop every other agent on the host and every long-running agent-director process: orchestrators' workers, hand-started sessions and sessions with an `agent-director serve`. A `serve` runs inside its Claude session, so that session is stopped too. Stop every caller, including TypeScript clients, as well. Confirm as in [switch-over step 8](#step-8-install-agent-director-phase-1): `agent-director list` shows each stopped agent's row `ended` or `missing`, and a read-only `tmux ls` shows no agent session left. Record it in the switch-over log.

   The restore does not begin while any agent runs. Every row must be non-live and every worker, session, caller, serve and launcher stopped before restoration. An unresolved row means no go; do not delete rows or edit SQL to fake a terminal state. If one cannot be stopped, the rollback stops as step 4 says, and every agent this step stopped is started again on Phase 1 by its owner (operator action).
2. **Restore the previous agent-director** using [the released 0.12.0 way-back procedure](https://github.com/gabemahoney/agent-director/blob/v0.12.0/docs/operator-actions.md#going-back-to-the-previous-release). Set the new directory aside and restore the kept `~/.agent-director.pre-move-*` directory to `~/.agent-director`; restore any external store from its pre-upgrade copy. Restore registrations, hooks and paths with the previous release's own installer and its original flags, following that procedure. Schema 9 has no downgrade recipe: a binary swap or SQL column removal cannot roll it back. Data written since the upgrade is lost. Restart only callers compatible with the restored CLI.
3. **Start the other agents again (operator action).** Every other agent on the host is started again by its owner on the previous binary, which also starts its `serve` processes on it.

#### Step 7: Revert the orchestrator prompt's hold wording

Revert the shared orchestrator prompt's "hold until after" wording that switch-over step 11 put out (operator action). The worker cleanup switch-over step 10 changed to "kill, then leave the row" stays: keep the cleanup compatible with the restored CLI.

#### Step 8: Reinstall the previous CSCB

1. Move aside `config.json.last-applied` and `retired-keys.json` from the upgraded run (see [Files beside the config file](reload.md#files-beside-the-config-file)), which are in the host's current state directory after the new CSCB's first start. For rollback to an existing-persona release (0.11.0 or later), restore their switch-over step 1 copies along with the other saved state in item 3; do not discard the previous release's applied configuration or retired-key state.
2. Reinstall the previous CSCB, the version switch-over step 1 recorded, or else the version the host ran before, without starting it:
   ```sh
   bun install -g claude-slack-channel-bots@<the previous version>
   ```
3. For rollback to an existing-persona release (0.11.0 or later), restore the saved persona configuration, credentials files, crontable, `/interject` callers and state files, including the last-applied and retired-key records when backed up, at the paths recorded in switch-over step 1. Keep the persona keys, `working_directory`, `claude_config_dir` and `resume_enabled` unchanged. For rollback to a pre-persona release (0.10.x), put back what switch-over step 1 saved: the pre-persona `config.json`, the crontable, the `/interject` callers (the host crontab's `curl` lines included), `access.json` and the Slack token environment variables. Put `config.json`, the crontable and `access.json` back in the old state directory, by its old name, `~/.claude/channels/slack`: after the new CSCB's first start that name is a symbolic link to `~/.config/claude-slack-channel-bots`, and the previous CSCB reads its files through the link. Leave the link in place, and do not make a directory at the old name.
4. The following manual conversion applies only when rolling back to a pre-persona release (0.10.x). Where switch-over step 1's copy of a file is missing, the operator rebuilds the pre-persona file by hand from the persona configuration, reversing the manual conversion in [Upgrading to personas](#upgrading-to-personas). No tooling does this: CSCB ships no conversion tooling in either direction.

#### Step 9: Start the previous CSCB

Start the previous CSCB, then re-enable the host's autostart for CSCB (operator action), and record it in the switch-over log:

```sh
claude-slack-channel-bots start
```

### Upgrading to personas

This major version accepts only the persona configuration format. These are the configuration steps of an upgrade from an earlier major version. Do them inside the switch-over runbook, not on their own: steps 1, 2, 3, 5 and 6 (the persona file, names, reply settings, Slack apps and who can reach each persona) at [step 1 of the switch-over](#step-1-check-the-host-and-stage-the-release), and steps 4, 7 and 8 (credentials files, crontable and `/interject` callers) at [step 7 of the switch-over](#step-7-install-the-new-cscb-without-starting-it). At switch-over step 1, these steps are written into the separate staged file, not `config.json`; step 7 puts that file in place as `config.json`. Until the new CSCB's first start, the new CLI keeps using the old state directory, `~/.claude/channels/slack`, so the persona `config.json`, the credentials files and the crontable go there; the first start moves that directory to `~/.config/claude-slack-channel-bots`.

1. **Rewrite `config.json` by hand.** A configuration from an earlier major version stops the server at start, with an error that names the offending setting and says the configuration must be converted to personas. Nothing is converted automatically and the file is not changed. Write a `personas` list as described in [Personas (config.json)](configuration.md#personas-configjson); the server-wide settings keep their names. The `debug-slack-channel-bots` skill covers this error under "Pre-persona configuration".
2. **Pick persona names whose keys don't start with one another.** The configuration check rejects such a pair. If your bots were named `horde`, `horde_admin`, …, don't name a persona `horde` beside `horde_admin`: give the shorter name a suffix, such as `horde_main` (see [Persona name and key](configuration.md#persona-name-and-key)).
3. **Set the reply settings in `config.json`.** Nothing else carries an acknowledgement reaction over: to keep one, set `ack_reaction` as a top-level setting. If you had changed how replies are split, set `reply_chunk_limit` and `reply_chunk_mode` there too. See [Server-wide settings](server-settings.md#server-wide-settings).
4. **Move the tokens into credentials files.** Tokens come only from each persona's credentials file. Create one [credentials file](configuration.md#credentials-files) per persona, then remove any token environment variables you exported for the previous version.
5. **Give each persona its own Slack app.** Your existing app can serve one persona; create another app for each additional persona. Add the `im:write`, `channels:read` and `groups:read` bot scopes to the existing app and re-install it; the `debug-slack-channel-bots` skill has the steps under "A persona can't open a DM" and "The message archive shows channel IDs".
6. **Decide who can reach each persona.** In declarative mode, the mode an upgrade starts in, who can reach a persona is decided only by its `channels`, each channel's `delivery` and its `dm.enabled` switch (see [Channel delivery](configuration.md#channel-delivery) and [Direct messages](configuration.md#direct-messages-dmenabled)). Fungible mode changes that (see [Who can reach a persona in fungible mode](channel-modes.md#who-can-reach-a-persona-in-fungible-mode)).
7. **Rewrite crontable lines to name personas.** A crontable target that names a channel matches no persona, and the line is logged `unknown-persona` each time it fires. Rewrite each target as a persona's name or key (see [Scheduled Prompts](scheduled-prompts.md#scheduled-prompts-cscb_cron)).
8. **Update `/interject` callers to send `persona`.** A request without `persona` is refused with 400, and a successful response holds only `ok` and `persona`. Change every script that calls `/interject`, including host crontab `curl` lines, to name a persona by name or key (see [Interject](bots.md#interject)).

### Downgrading to an earlier release

An earlier release's loader rejects `allow_invited_channels` and `invited` as unknown keys, and a restarted server runs the last-applied record, so the record must not hold either key when the older build starts. A host whose `config.json` has never held either key downgrades as from any release: install the older build and restart the server on it. Otherwise, follow these steps in order, with the server running:

1. **Give every persona a valid declarative section.** Turning fungible mode off is checked by the declarative rules, so each persona needs a `permission_prompts`, and `channels` unless its `dm.enabled` is `true`, that pass them (see [Load-time rules](configuration.md#load-time-rules)).
2. **Remove `allow_invited_channels` and every persona's `invited` from `config.json`.**
3. **Confirm the pending change, and wait for its `reload-applied` or `reload-noop` line** (see [Confirming a change](reload.md#confirming-a-change)). Either one means the last-applied record holds the configuration without the two keys. A host that was already in declarative mode confirms as `reload-noop`.
4. **Install the older build and restart the server on it.** For example, `bun install -g claude-slack-channel-bots@<version>`, then `claude-slack-channel-bots stop` and `claude-slack-channel-bots start`. The older build ignores `channel-delivery.json`, so the file can stay where it is.

---

## Upgrading from pre-Epic-2 (v0.5.x → v0.6.x)

If you installed CSCB before v0.6.0 you may have legacy artifacts on disk that are no longer needed. Clean them up by hand; no install step removes them.

### 1. Remove old relay hook files

The `.sh` relay hooks are no longer shipped by CSCB. Delete them if present:

```sh
rm -f ~/.claude/hooks/permission-relay.sh ~/.claude/hooks/ask-relay.sh
```

### 2. Remove orphan settings.json hook entries

If you wired the hooks into `~/.claude/settings.json` by hand, remove the stale entries. Use this `jq` filter to check whether any are present:

```sh
jq '
  (.hooks.PermissionRequest // [] | map(select(.hooks[]?.command | strings | test("\\.sh$")))),
  (.hooks.PreToolUse // [] | map(select(.matcher == "AskUserQuestion" and (.hooks[]?.command | strings | test("\\.sh$")))))
' ~/.claude/settings.json 2>/dev/null
```

Any non-empty arrays in the output are orphan entries. Remove:

- Any object inside `hooks.PermissionRequest` whose `hooks[].command` ends in `permission-relay.sh`.
- Any object inside `hooks.PreToolUse` with `"matcher": "AskUserQuestion"` whose `hooks[].command` ends in `ask-relay.sh`.

The modern permission relay runs automatically via agent-director — no `PermissionRequest` or `PreToolUse` hook entries for `.sh` files are needed.
