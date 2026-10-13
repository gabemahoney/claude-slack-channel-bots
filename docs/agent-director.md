# agent-director

CSCB requires agent-director CLI 0.12.0 or later and pins its TypeScript client to `agent-director@0.12.0`. Workers require Claude Code 2.1.296 or later. Upgrade the CLI with its released installer before upgrading CSCB; see [Migration](migration.md#migration).

CSCB runs every bot through [agent-director](https://github.com/gabemahoney/agent-director), installed system-wide. This page covers checking that install, the `install-cscb` skill that walks you through a failed check, and the agent-director settings CSCB reads.

## Checking your agent-director install

Before starting the server, you can confirm `agent-director` is installed system-wide at a version this CSCB release can be installed beside with:

```sh
bun run install-check
```

The script finds the system-installed agent-director binary and reads its version, then judges it in two steps: first against the agent-director client's own minimum (`min_binary_version` in the installed client's `dist/version-floor.json`), then against CSCB's Phase 1 floor. `/publish`'s preflight check makes the same decision. There are three outcomes:

- **Pass.** The binary meets both. The script exits 0 and prints one block naming `agent-director`, the resolved binary path, the version found and, on the line labelled `floor:`, the agent-director client's minimum (not CSCB's Phase 1 floor).
- **Pass with a note.** The binary meets the client's minimum but is below CSCB's Phase 1 floor (the development placeholder `0.0.0-dev` included). The script still exits 0 and prints the same block, followed by a note: the server will not start on this binary until agent-director Phase 1 is installed; see the docs/migration.md section "Switching over to agent-director Phase 1".
- **Fail.** The script writes one of the class labels below, with its message, to stderr and exits non-zero:
  - `ad-system-install-not-found` — no agent-director on PATH or at the standard install path. The message points to the block ["The publishing host"](migration.md#the-publishing-host) in the docs/migration.md section "Switching over to agent-director Phase 1", which covers a host with no agent-director. The stderr also points at the install-cscb skill.
  - `ad-system-install-too-old` — the binary is below the agent-director client's own minimum. The message names the version found, the version the client requires, the binary path and the docs/migration.md section "Switching over to agent-director Phase 1", which is how agent-director is installed for this CSCB release. The stderr points at the skill.
  - `ad-system-install-unreachable` — the binary's version cannot be read: AD discovered it but the probe could not invoke it, it reported a version that does not parse (reason `unparseable-version`), or the probe failed some other way (reason `other`). The message names the `.reason` value (`unknown` when the error carries no reason or one that is not a short lowercase word), or for another failure the error's name or type. The message says to diagnose with the install-cscb skill and names the docs/migration.md section "Switching over to agent-director Phase 1"; for another failure it names that section or says to file a bug. The stderr points at the skill.
  - `ad-version-floor-unreadable` — `dist/version-floor.json` is missing or malformed, or its `min_binary_version` is missing or is not a version. The message says to check the `agent-director` npm package installed with CSCB and names the docs/migration.md section "Switching over to agent-director Phase 1". The install-cscb skill cannot fix the package, so this case does NOT append the skill instructions block.

The script is purely diagnostic — it never prompts, never runs an install command, never fetches the skill. At server start the startup gate refuses a binary below the client's minimum or below CSCB's Phase 1 floor (`ad-system-install-too-old` or `ad-below-phase1-floor`, see [Startup errors](troubleshooting.md#startup-errors)), so a binary that passes the install check with its note is still refused at start. `install-check` is for operators who want to confirm their setup ahead of time.

## Installing the install-cscb skill

If `bun run install-check` passes with a note, or it or the startup gate
reports one of the `ad-system-install-*` failure classes, you can install the `install-cscb`
Claude skill for an interactive walkthrough. The skill drives the same
shared check module but walks you through each failure class: the block
["The publishing host"](migration.md#the-publishing-host) for a missing binary (and,
after the startup gate's refusal on a bot host, the section's
[step 1](migration.md#step-1-check-the-host-and-stage-the-release) version check), the
docs/migration.md section "Switching over to agent-director Phase 1" for a too-old
one, and a per-reason diagnosis for each of the eight
`ErrSystemInstallUnreachable.reason` values.

The skill is NOT auto-installed by `bun install` — fetch it manually
from CSCB's GitHub repo and place it in your local Claude skills
folder:

1. **Fetch** `SKILL.md` from:

   ```
   https://github.com/gabemahoney/claude-slack-channel-bots/blob/main/skills/install-cscb/SKILL.md
   ```

   (The startup gate's `ad-system-install-*` error log line includes
   this URL automatically.)

2. **Place** it at:

   ```
   ~/.claude/skills/install-cscb/SKILL.md
   ```

3. **Invoke** the skill from Claude Code:

   ```
   /install-cscb
   ```

The skill first states that this CSCB release and agent-director Phase 1
are installed, and rolled back, together, by the docs/migration.md sections
"Switching over to agent-director Phase 1" and "Rolling back the
switch-over", which it points to by title. It names the agent-director
client CSCB pins, `agent-director@0.12.0`, which comes installed with
CSCB; the skill runs no install or upgrade of the client or the binary.

The skill calls `bun run install-check` on each iteration. On a pass that
carries the install check's `note:` line (the binary is below CSCB's Phase
1 floor), it relays the note as printed, says the server refuses to start
on that binary until the switch-over, points to "Switching over to
agent-director Phase 1" and runs nothing for it. Three classes end the skill instead of
looping, and it runs nothing for them: for `ad-system-install-not-found` it
names the block "The publishing host" of the docs/migration.md section "Switching
over to agent-director Phase 1" (after the startup gate's refusal on a bot
host, that section's step 1 instead, whose version check as the workers'
user in the bot server's launcher environment shows whether the launcher's
HOME or PATH differs from the workers'), for `ad-system-install-too-old` it names
that section and runs no upgrade, since the runbook's `state.db` backup and
`serve` restarts come with the install, and for `ad-version-floor-unreadable` it says to check the
`agent-director` npm package installed with CSCB (the skill cannot fix that
package). For `ad-system-install-unreachable` it gives each reason's
read-only diagnosis, `chmod +x` for a binary without its executable bit,
and points to the same section.

The published CSCB npm tarball includes `skills/install-cscb/SKILL.md`
under its `files` array, so the skill source is also available via
`node_modules/claude-slack-channel-bots/skills/install-cscb/SKILL.md`
after `bun install`. The manual GitHub-fetch step above is for users
who haven't yet installed CSCB at all.

---

## agent-director's timing settings

agent-director keeps its timing settings in the `[tmux]` table of `~/.config/agent-director/config.toml`. They are agent-director's settings, not CSCB configuration: CSCB only reads them, from the file under the HOME the server runs in. Set HOME to a nonempty absolute path: CSCB refuses to read settings through an unset, empty or relative HOME, and the agent-director installer and uninstaller exit 2 for those values.

The server reads the table when it starts and every 120 s after that, whatever `health_check_interval` is (`0` included), so a change on the host is used within about 120 s (each read follows the binary re-check, which runs 120 s after the previous one ends and can take up to its 30 s time limit). It applies agent-director's own rule: a missing file, a missing key or `0` means agent-director's default. At the first read it accepts, and at each later accepted read that changes any of them, the server writes one line to `server.log` with the nine `[tmux]` values in effect; a read that changes only `[pause] timeout_seconds` (see [Sizing the agent-director call timeout](#sizing-the-agent-director-call-timeout)) writes none.

| Key | Default |
|---|---|
| `pending_grace_seconds` | `60` |
| `stopping_window_seconds` | `90` |
| `starting_session_seconds` | `300` |
| `sweep_budget_seconds` | `15` |
| `query_timeout_ms` | `1500` |
| `action_timeout_ms` | `2000` |
| `create_timeout_ms` | `5000` |
| `pipe_close_wait_ms` | `100` |
| `kill_exit_wait_ms` | `5000` |

`pending_grace_seconds` also sets the server's own waits on a persona's instance that is still starting, each counted from its launch's start: the server starts checking the instance with agent-director once `pending_grace_seconds` has passed, and posts the *Launch stuck* or *Session not starting* notice once the later of 5 minutes and `pending_grace_seconds` plus 60 s has passed (see "A persona's instance is still starting" and "A persona posts a *Launch stuck* or *Session not starting* notice" in [Troubleshooting](troubleshooting.md#troubleshooting)).

If the file can't be read or parsed, or a `[tmux]` value is one agent-director refuses (not a whole number, negative, above 2^63 − 1, or below its minimum), the server keeps the last values it accepted (the defaults, if none yet) and writes one line to `server.log`. The `debug-slack-channel-bots` skill explains that line under "agent-director's timing settings". agent-director's own answers always decide; the server's reading of the file never overrides them.

### Sizing the agent-director call timeout

`agent_director_call_timeout_ms` (default `60000`, an integer in `[1000, 3_600_000]`; see [Server-wide settings](server-settings.md#server-wide-settings)) is how long CSCB waits on each agent-director call it makes for its personas:

- **The server** uses the value from the configuration its start runs: the last-applied record, else `config.json`.
- **`stop --stop-bots` and `clean_restart`** use the value from the last-applied record, else `config.json`. When `stop --stop-bots` can't read that configuration, it uses the default `60000`.

A call that runs past the timeout ends in an error while agent-director may still be carrying out the verb. When that call launches a persona, the server reads the persona's state once and does not launch it again while that instance may still be starting (see "A persona's instance is still starting" in [Troubleshooting](troubleshooting.md#troubleshooting)). So the setting must be greater than its **need**: the largest ceiling among the agent-director verbs CSCB calls, plus a 15 s margin (15000 ms: the store's 10 s busy timeout and 5 s to start agent-director's CLI). Each ceiling is computed from the host's `[tmux]` values in the table above, with these letters:

| Letter | `[tmux]` key |
|---|---|
| Q | `query_timeout_ms` |
| A | `action_timeout_ms` |
| C | `create_timeout_ms` |
| W | `pipe_close_wait_ms` |
| E | `kill_exit_wait_ms` |
| B | `sweep_budget_seconds` (times 1000, in ms) |

| Verb | Ceiling (ms) | At agent-director's defaults |
|---|---|---|
| `kill` | the larger of 2Q + 2A + E + 4W and 3Q + 2A + 5W | 12.4 s |
| `read-pane` | 3Q + A + 4W | 6.9 s |
| `send-keys` | 3Q + 2A + 5W | 9 s |
| `pause` | 3Q + 2A + 5W, plus `[pause] timeout_seconds` (times 1000) | 39 s (9 s + 30 s) |
| `resume`, a spawn that reuses an instance, and a plain spawn | the larger of Q + C + 2A + 4W and 2Q + C + 3W | 10.9 s |
| `find-missing` | B + Q + W | 16.6 s |
| `expire` | B + Q + W | 16.6 s; CSCB never calls it, so it never sets the need |

At agent-director's defaults, `pause` sets the need: its 9 s plus 30 s is 39 s, plus 15 s is 54 s (54000 ms), below the default `60000`. Two more examples:

- `create_timeout_ms` 40000 (with `pending_grace_seconds` at 61, its minimum then): the launch ceiling that `resume`, a reuse and a plain spawn share is 45.9 s, so the need is 60.9 s (60900 ms), above the default, and the line names `resume/spawn-with-reuse/plain-spawn`. Raise the setting above it.
- `[pause] timeout_seconds` 60: `pause`'s ceiling is 69 s, so the need is 84 s (84000 ms).

`[pause] timeout_seconds` is `pause`'s wait, in the `[pause]` table of the same file. It is 30 s when the file, the table or the key is missing. A positive whole number is used as given. Any other value (`0`, a negative number, a number above 2^63 − 1, a value that isn't a whole number, or a `pause` that isn't a table) is not used: the need then counts `pause` without its wait, and the server reports it.

**The startup warning.** Once per start, right after the server reads agent-director's settings and before any persona is brought up, the server writes one line to `server.log` when the setting is at or below the need:

```text
[slack] agent-director settings: agent_director_call_timeout_ms is <value>, at or below its need of <need> ms (the <verb> ceiling plus the 15000 ms margin): a call can time out while its verb still acts; see the switch-over runbook in docs/migration.md, section "Switching over to agent-director Phase 1" (b.jg5 SRJ-213)
```

`<verb>` names the row whose ceiling sets the need: its verb, or `resume/spawn-with-reuse/plain-spawn` for the launch row those three share. When `[pause] timeout_seconds` holds a value that is not used, the line is this one instead, whatever the setting is:

```text
[slack] agent-director settings: agent_director_call_timeout_ms is <value>; its need is unknown: [pause] timeout_seconds holds <found>, a value that is not used, so pause's wait is not counted and the need without it is <need> ms; see the switch-over runbook in docs/migration.md, section "Switching over to agent-director Phase 1" (b.jg5 SRJ-213)
```

`<found>` is the number (for example `0`) or the kind of value, never the file's text. At agent-director's defaults, the default `60000` writes no line; a setting of `54000` writes the first line, naming `pause`.

Either way the server still starts, and no value changes. The check runs only at start: a later change to `config.toml` is checked at the next start.

To fix it, raise `agent_director_call_timeout_ms` in `config.json` above the need and confirm the change (see [Reload](reload.md#reload)). `stop --stop-bots` and `clean_restart` use the new value at once; the server uses it from its next start.

For the second line, give `[pause] timeout_seconds` a positive whole number, or remove it for the 30 s default; the next start checks the setting against the need that gives.
