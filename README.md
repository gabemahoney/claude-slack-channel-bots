# Claude Slack Channel Bots

A single HTTP MCP server that runs several independent Claude Code bots, called personas. Each persona has its own Slack app and identity (name and avatar) and one Claude Code instance with its own working directory. It is reachable by direct message when its `dm.enabled` is `true`, and in the Slack channels the server's channel mode gives it: in declarative mode, the default, the channels it is configured into; in fungible mode, every public or private channel its Slack app is invited to that is not externally shared (see [Channel modes](docs/channel-modes.md#channel-modes)). The server holds one Slack Socket Mode connection per persona and delivers each message to the persona whose app received it. Each persona's tool calls act as that persona: in declarative mode only in the channels it is configured into, in fungible mode in any channel ID it names, where the call goes to Slack, which decides; and in its direct messages when its `dm.enabled` is `true`.

---

## Quick Start

**[Bun](https://bun.sh) is required** — it is CSCB's runtime and the interpreter its install and start scripts run under. Install bun before you install CSCB. `npm install -g claude-slack-channel-bots` on a box without bun fails during postinstall (the postinstall script is a bun script).

1. **Install globally via bun:**

   ```sh
   bun install -g claude-slack-channel-bots
   ```

2. **Trust the package so postinstall runs:**

   ```sh
   bun pm -g trust claude-slack-channel-bots
   ```

   Bun blocks the lifecycle scripts of untrusted packages, so the postinstall does not run on the plain `install` above — you must trust the package for it to fire. The `-g` flag targets the global install; without it `bun pm trust` looks for a `package.json` in the current directory and errors with `No package.json was found`. (Run `bun pm -g untrusted` to confirm it is listed first.) The postinstall then creates skeleton config files in `~/.config/claude-slack-channel-bots/` (or in `SLACK_STATE_DIR` when it is set and non-empty, the same directory the server reads) and `~/.claude/slack-mcp.json`, and links the `debug-slack-channel-bots` skill into `~/.claude/skills/`. Skip this step and a later `start` fails with `missing prerequisite: config.json`.

3. **Run the setup skill:**

   The package includes a Claude Code skill at `skills/setup-slack-channel-bots/`. Copy or symlink it into `~/.claude/skills/`, then run:

   ```sh
   claude /setup-slack-channel-bots
   ```

   The wizard walks you through one persona at a time: creating and installing the persona's Slack app from `slack-app-manifest.yml`, setting its name and avatar, and inviting it to its channels, which you do in Slack; declaring the persona in `config.json`, which the wizard writes; and writing its credentials file, which you do in your terminal. Tokens go only into the wizard's [credentials command](skills/setup-slack-channel-bots/SKILL.md#credentials-command), `claude-slack-channel-bots credentials <persona>`, which you run in your own terminal, never into the chat. On a running server, the wizard explains how to confirm the pending change (see [Changing the configuration](#changing-the-configuration)).

4. **Or create your personas by hand:**

   Skip this step if the wizard created them. Create one Slack app per persona from `slack-app-manifest.yml`. Write each app's tokens to its own credentials file, then list the personas in `config.json`. See [A first configuration](#a-first-configuration), and [Personas (config.json)](docs/configuration.md#personas-configjson) and [Credentials files](docs/configuration.md#credentials-files) for the full reference.

5. **Start the server:**

   ```sh
   claude-slack-channel-bots start
   ```

---

## Prerequisites

- [Bun](https://bun.sh) `>= 1.0.21` (agent-director minimum)
- [Claude Code](https://claude.ai/code) 2.1.280 or later for the workers, installed and authenticated: CSCB's supported minimum and the version the fleet runs. No version pin or channels permission is required. A Claude Code too old for exec-form hooks (older than 2.1.139) has its hooks ignored, so every launch stays `pending`. The `claude` on the workers' `PATH` must be Claude Code's native binary or a wrapper that `exec`s it: a launcher or shim that runs Claude Code as a child process makes agent-director ignore every hook (`ad.hook.ignored` with the reason `pid_mismatch`), so every launch stays `pending`.
- [`agent-director`](https://github.com/gabemahoney/agent-director) 0.12.0 or later, **installed system-wide** as a prerequisite, like `git` or `docker`. The npm `agent-director` package CSCB depends on is the client only: it finds the system-installed binary at startup and refuses to start when the binary is missing, too old, or unreachable. This release pins the client to `agent-director@0.12.0` and requires the CLI at 0.12.0 or later, installed on the host together with it, and the two are rolled back together; CSCB changes no agent-director code (see "Switching over to agent-director Phase 1" in [Migration](docs/migration.md#migration)). Every agent on the host, with every long-running agent-director process (`agent-director serve` included), is stopped before either binary change (the Phase 1 install, and the rollback's restore of the previous binary) and started again after it. The startup gate refuses a binary below the client's own minimum (`min_binary_version` in the client's `dist/version-floor.json`) or below 0.12.0, and names the required version (see [Startup errors](docs/troubleshooting.md#startup-errors)). To check the install before you start, run `bun run install-check` (see [Checking your agent-director install](docs/agent-director.md#checking-your-agent-director-install)).
- [tmux](https://github.com/tmux/tmux) 3.2 or later, with `remain-on-exit` off. agent-director runs it; CSCB starts no tmux process. agent-director does not depend on tmux's `base-index` or `pane-base-index`, so their values don't matter.
- Slack workspace admin access (to create and configure one Slack app per persona)
- **cozempic** (optional) — Python 3.10+ and `pip install cozempic` — used by JSONL path resolution helpers retained for downstream callers.

### Supported platforms (inherited from agent-director)

| Platform | Status |
|---|---|
| `linux-x64` | Supported |
| `darwin-arm64` (Apple Silicon Mac) | Supported |
| `linux-arm64` | **Not supported** by agent-director |
| `darwin-x64` (Intel Mac) | **Not supported** by agent-director |
| Windows | **Not supported** by agent-director |

If the host is unsupported, the system-installed `agent-director` itself will refuse to install or run; CSCB's startup gate then exits non-zero with one of the `ad-system-install-*` class labels (see [Startup errors](docs/troubleshooting.md#startup-errors)) and writes the failure to `~/.config/claude-slack-channel-bots/startup-errors.log` and stderr. Consult [agent-director's documentation](https://github.com/gabemahoney/agent-director) for the canonical platform support list.

---

## A first configuration

`config.json` lives in `~/.config/claude-slack-channel-bots/` (or `SLACK_STATE_DIR`). This one runs one persona, `planner`, that receives every message in one channel and posts its permission prompts there:

```json
{
  "personas": [
    {
      "name": "planner",
      "credentials_file": "~/.config/claude-slack-channel-bots/planner-credentials.json",
      "working_directory": "~/projects/alpha",
      "channels": [
        { "id": "C0123456789", "delivery": "all" }
      ],
      "permission_prompts": "C0123456789"
    }
  ]
}
```

- `credentials_file` holds the persona's two Slack tokens. Write it with `claude-slack-channel-bots credentials planner` in your own terminal; it asks for the tokens and checks them with Slack.
- `working_directory` must exist; the persona's Claude instance runs there.
- `channels` lists the channels the persona is in, each with `delivery` `"all"` (every message) or `"mentions"` (only @mentions and `@here` / `@channel`). Invite the persona's Slack app to each one.
- `permission_prompts` is where the persona's permission prompts and notices go: one of its channels, or `"dm"` with a `dm` section.

Replace the channel ID and paths with your own. [Configuration](docs/configuration.md) has every persona field and a complete example; [Channel modes](docs/channel-modes.md) covers fungible mode.

---

## Everyday use

| Command | What it does |
|---|---|
| `claude-slack-channel-bots start` | Starts the server in the background. It brings up every persona's bot. |
| `claude-slack-channel-bots stop` | Stops the server. The bots keep running and are picked up by the next start. |
| `claude-slack-channel-bots stop --stop-bots` | Stops the server, then each bot, keeping its conversation for the next start. |
| `claude-slack-channel-bots clean_restart` | Stops the server and every bot, then starts them again. Conversations resume. |
| `claude-slack-channel-bots credentials <persona>` | Writes one persona's credentials file from your terminal. |
| `claude-slack-channel-bots clear-latch <persona>` | Ends one persona's hold once a human has fixed its cause. |

[CLI Reference](docs/cli.md) has every option, output and exit code.

Talk to a persona in its channels or, when its `dm.enabled` is `true`, by direct message. When its Claude instance needs a tool approved, an **Allow** / **Deny** prompt is posted to its destination, its `permission_prompts` (see [Permission Relay](docs/bots.md#permission-relay)).

CSCB durably queues accepted messages and types them into the persona’s terminal. Delivery is ordered and at-least-once: the next item waits for transcript confirmation of the previous one, and an unconfirmed item may appear again. The bot answers with `reply`; see [How a persona receives messages](docs/bots.md#how-a-persona-receives-messages).

### Changing the configuration

On a running server, saving `config.json` changes nothing yet. Within about 5 seconds the server writes a preview of the change to `config.json.pending`. Read it, then confirm it by renaming it:

```sh
cd "${SLACK_STATE_DIR:-${XDG_CONFIG_HOME:-$HOME/.config}/claude-slack-channel-bots}" && mv config.json.pending config.json.apply
```

The server applies it without a restart. Lines that start `DESTRUCTIVE:` name personas the change retires; their conversations are not resumed. [Reload](docs/reload.md) explains the preview and what each kind of change does.

---

## Documentation

| Page | Read it to |
|---|---|
| [Configuration](docs/configuration.md) | Write `config.json`: every persona field, credentials files and the load-time rules |
| [Server settings](docs/server-settings.md) | Set the server-wide settings, environment variables and `slack-mcp.json` |
| [Channel modes](docs/channel-modes.md) | Choose declarative or fungible mode, and see who can reach a persona in fungible mode |
| [Reload](docs/reload.md) | Change the configuration of a running server and read its preview |
| [CLI Reference](docs/cli.md) | Look up a command's behaviour, output and exit codes |
| [What a bot can do](docs/bots.md) | Learn the bots' tools, how messages reach them, `/interject`, the permission relay and the Slack Reply Guard |
| [Scheduled Prompts](docs/scheduled-prompts.md) | Send prompts to bots on a schedule |
| [agent-director](docs/agent-director.md) | Check the agent-director install and size CSCB's agent-director timeout |
| [Troubleshooting](docs/troubleshooting.md) | Fix a persona that is silent or down, a notice, or a startup error |
| [Migration](docs/migration.md) | Install this release over an earlier one, or roll it back |
| [CHANGELOG.md](CHANGELOG.md) | See what changed in each release |
| [CONTRIBUTING.md](CONTRIBUTING.md) | Work on CSCB itself |

The `debug-slack-channel-bots` skill, linked by the postinstall, diagnoses a persona that is silent, down or refused: run `/debug-slack-channel-bots` from Claude Code.
