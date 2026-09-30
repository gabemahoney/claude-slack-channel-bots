# Claude Slack Channel Bots

A single HTTP MCP server that runs several independent Claude Code bots, called personas. Each persona has its own Slack app and identity (name and avatar), one Claude Code instance with its own working directory, and is reachable from the Slack channels it is configured into and, when its `dm.enabled` is `true`, by direct message. The server holds one Slack Socket Mode connection per persona and delivers each message to the persona whose app received it; each persona's tool calls may post only to the channels it is configured into and, when its `dm.enabled` is `true`, to its direct messages, as that persona.

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

   Bun blocks the lifecycle scripts of untrusted packages, so the postinstall does not run on the plain `install` above — you must trust the package for it to fire. The `-g` flag targets the global install; without it `bun pm trust` looks for a `package.json` in the current directory and errors with `No package.json was found`. (Run `bun pm -g untrusted` to confirm it is listed first.) The postinstall then creates skeleton config files in `~/.claude/channels/slack/` (or in `SLACK_STATE_DIR` when it is set and non-empty, the same directory the server reads) and `~/.claude/slack-mcp.json`, and links the `debug-slack-channel-bots` skill into `~/.claude/skills/`. Skip this step and a later `start` fails with `missing prerequisite: config.json`.

3. **Run the setup skill:**

   The package includes a Claude Code skill at `skills/setup-slack-channel-bots/`. Copy or symlink it into `~/.claude/skills/`, then run:

   ```sh
   claude /setup-slack-channel-bots
   ```

   The wizard walks you through one persona at a time: creating and installing the persona's Slack app from `slack-app-manifest.yml`, setting its name and avatar, and inviting it to its channels, which you do in Slack; declaring the persona in `config.json`, which the wizard writes; and writing its credentials file, which you do in your terminal. Tokens go only into the wizard's [credentials command](skills/setup-slack-channel-bots/SKILL.md#credentials-command), `claude-slack-channel-bots credentials <persona>`, which you run in your own terminal, never into the chat. On a running server, the wizard explains how to confirm the pending change (see [Reload](#reload)).

4. **Or create your personas by hand:**

   Skip this step if the wizard created them. Create one Slack app per persona from `slack-app-manifest.yml`. Write each app's tokens to its own credentials file, then list the personas in `config.json`. See [Personas (config.json)](#personas-configjson) and [Credentials files](#credentials-files).

5. **Start the server:**

   ```sh
   claude-slack-channel-bots start
   ```

See the sections below for manual configuration details if you prefer not to use the skill.

---

## Prerequisites

- [Bun](https://bun.sh) `>= 1.0.21` (agent-director minimum)
- [Claude Code](https://claude.ai/code) installed and authenticated
- [`agent-director`](https://github.com/gabemahoney/agent-director) **installed system-wide** as a prerequisite — like `git` or `docker`. CSCB no longer vendors the AD binary. The npm `agent-director` package CSCB depends on is now a thin TypeScript shim that locates the system-installed binary at startup via `resolveSystemBinary()` / `Client.create()` and refuses to start when the binary is missing, too old, or unreachable. The startup gate enforces AD's required version (declared by AD in `dist/version-floor.json`), also refuses a binary older than agent-director Phase 1 (see [Startup errors](#startup-errors)), and reports the required version on mismatch. agent-director itself requires [tmux](https://github.com/tmux/tmux) on the operator's PATH; CSCB no longer probes for it directly.
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

If the host is unsupported, the system-installed `agent-director` itself will refuse to install or run; CSCB's startup gate then exits non-zero with one of the `ad-system-install-*` class labels (see [Startup errors](#startup-errors)) and writes the failure to `~/.claude/channels/slack/startup-errors.log` and stderr. Consult [agent-director's documentation](https://github.com/gabemahoney/agent-director) for the canonical platform support list.

> **Note on agent-director versions.** v0.4.1 is a zombie release (the published tarball is missing `dist/` and cannot be imported). v0.4.2 lacks the `MakeTemplateParams.overwrite` field CSCB needs for the boot-time template refresh. v0.5.4 and earlier lack `allow_pending` on `readPane`/`sendKeys`, causing `ErrSpawnNotInteractive` during dev-channels dialog approval on freshly-spawned bots. v0.6.0 shipped a stale TS shim whose `Client` dropped `getPermission`, whose `buildDecide()` dropped `--request-token`, and whose error catalog omitted `ErrInvalidFlags` / `ErrPermissionRequestNotFound` / `ErrAmbiguousRequest` — each silently breaks the disambiguation relay. v0.6.1–0.6.2 still lack the full `permission_requests` plural projection + composite-key disambiguation surface CSCB depends on for concurrent open requests. From v0.7.0 onward, AD ships as a thin npm shim around a system-installed binary, AD's library-side `Client.create()` enforces AD's own minimum from `dist/version-floor.json`, and CSCB also refuses a binary older than agent-director Phase 1 (see [Startup errors](#startup-errors)). CSCB's `package.json` caret-pin on `agent-director` governs npm resolution of AD's TypeScript shim only — not these runtime minimums.

### Checking your agent-director install

Before starting the server, you can confirm `agent-director` is installed system-wide at a version this CSCB release can be installed beside with:

```sh
bun run install-check
```

The script finds the system-installed agent-director binary and reads its version, then judges it in two steps: first against the agent-director client's own minimum (`min_binary_version` in the installed client's `dist/version-floor.json`), then against CSCB's Phase 1 floor. `/publish`'s preflight check makes the same decision. There are three outcomes:

- **Pass.** The binary meets both. The script exits 0 and prints one block naming `agent-director`, the resolved binary path, the version found and, on the line labelled `floor:`, the agent-director client's minimum (not CSCB's Phase 1 floor).
- **Pass with a note.** The binary meets the client's minimum but is below CSCB's Phase 1 floor (the development placeholder `0.0.0-dev` included). The script still exits 0 and prints the same block, followed by a note: the server will not start on this binary until agent-director Phase 1 is installed; see the README section "Switching over to agent-director Phase 1".
- **Fail.** The script writes one of the class labels below, with its message, to stderr and exits non-zero:
  - `ad-system-install-not-found` — no agent-director on PATH or at the standard install path. Install AD and retry. The stderr also points at the install-cscb skill for interactive remediation.
  - `ad-system-install-too-old` — the binary is below the agent-director client's own minimum. The message names the version found, the version the client requires, the binary path and the README section "Switching over to agent-director Phase 1", which is how agent-director is installed for this CSCB release. The stderr points at the skill.
  - `ad-system-install-unreachable` — the binary's version cannot be read: AD discovered it but the probe could not invoke it, it reported a version that does not parse (reason `unparseable-version`), or the probe failed some other way (reason `other`). The message names the `.reason` value (`unknown` when the error carries no reason or one that is not a short lowercase word), or for another failure the error's name or type. The stderr points at the skill.
  - `ad-version-floor-unreadable` — `dist/version-floor.json` is missing or malformed, or its `min_binary_version` is missing or is not a version. The remediation is to check or reinstall the `agent-director` npm package; the install-cscb skill cannot fix a corrupt AD package, so this case does NOT append the skill instructions block.

The script is purely diagnostic — it never prompts, never runs an install command, never fetches the skill. At server start the startup gate refuses a binary below the client's minimum or below CSCB's Phase 1 floor (`ad-system-install-too-old` or `ad-below-phase1-floor`, see [Startup errors](#startup-errors)), so a binary that passes the install check with its note is still refused at start. `install-check` is for operators who want to confirm their setup ahead of time.

### Installing the install-cscb skill

If `bun run install-check` (or the startup gate) reports one of the
`ad-system-install-*` failure classes, you can install the `install-cscb`
Claude skill for an interactive walkthrough. The skill drives the same
shared check module but walks you through each failure class: install for
a missing binary, the README section "Switching over to agent-director
Phase 1" for a too-old one, and a per-reason remediation flow for each of
the eight `ErrSystemInstallUnreachable.reason` values.

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

The skill calls `bun run install-check` on each iteration, surfaces
`agent-director`'s published install command verbatim for a missing
binary (no CSCB-owned install command — AD's documentation is the source
of truth), prompts before running, and loops until the check passes or
you decline. Two classes end the skill instead of looping: for
`ad-system-install-too-old` it names the README section "Switching over
to agent-director Phase 1" and runs nothing, and for
`ad-version-floor-unreadable` it prints reinstall-from-npm guidance (the
skill cannot fix a corrupt AD npm package).

The published CSCB npm tarball includes `skills/install-cscb/SKILL.md`
under its `files` array, so the skill source is also available via
`node_modules/claude-slack-channel-bots/skills/install-cscb/SKILL.md`
after `bun install`. The manual GitHub-fetch step above is for users
who haven't yet installed CSCB at all.

---

## Configuration

### Environment Variables

Runtime options are read from environment variables. None of them is required. Slack tokens come only from each persona's credentials file (see [Credentials files](#credentials-files)). There is no `.env` file — export any of these in your shell profile.

| Variable | Description |
|---|---|
| `SLACK_STATE_DIR` | Override the directory where `config.json` and runtime state are stored. Defaults to `~/.claude/channels/slack`. |
| `SLACK_DRY_RUN` | Set to `1` (or `true` / `yes`) to start the server without Slack. No credentials file is read and no Slack call is made. Each persona runs with a placeholder identity (`U000DRY_<key>`), and MCP tool calls (`reply`, `react`, etc.) and server notices are logged instead of sent. Useful for integration testing. |
| `CSCB_LOG_MAX_BYTES` | Rotate `server.log` / `clean_restart.log` when the active file reaches this many bytes. Defaults to `10485760` (10 MiB). Values `<= 0` or non-numeric are ignored. |
| `CSCB_LOG_KEEP` | Number of rotated generations to retain (`server.log.1` … `server.log.N`). Defaults to `5`. Set to `0` to keep none (the log is truncated instead of rolled). Values `< 0` or non-numeric are ignored. |
| `CSCB_AD_VERBOSE` | Set to a truthy value (`1`, `true`, `yes`, `on`) to restore the agent-director library's per-poll `SubprocessClient: <verb> ok` success dumps in `server.log`. Off by default — these routine dumps are dropped so the log stays readable. Failures and warnings from agent-director always pass through regardless of this flag. Read once at server startup, so it takes effect on server restart. |
| `CSCB_HTTP_VERBOSE` | Set to a truthy value (`1`, `true`, `yes`, `on`) to restore the per-request MCP access line (`HTTP <method> <path> session=…`) in `server.log`. Off by default — the `/mcp` endpoint is hit on every client poll and SSE open, so these routine lines are dropped to keep the log readable. Session connect/disconnect, sessions with no matching persona, and errors are logged unconditionally regardless of this flag. Checked per request, so it takes effect without a restart. |

Shell profile example:

```sh
# Optional overrides:
export SLACK_STATE_DIR=~/.config/slack-channel-bots
# Dry-run mode (no Slack credentials needed):
export SLACK_DRY_RUN=1
```

---

### Personas (config.json)

`config.json` is read from `~/.claude/channels/slack/config.json` by default. Override the directory with `SLACK_STATE_DIR`. The server needs only this file and the credentials files it names.

Each bot is a **persona**: one Slack app, one Claude instance with its own working directory, and the channels it is configured into. Create one Slack app per persona (see `slack-app-manifest.yml`); that app gives the persona its own name and avatar in Slack.

The top level holds a required `personas` array and the [server-wide settings](#server-wide-settings). Unknown keys are rejected at every level: the top level, each persona, its `dm` object and each channel entry. Only this persona format is accepted; a configuration written for an earlier major version must be rewritten by hand (see [Upgrading to personas](#upgrading-to-personas)).

The first start of an install applies the file as it stands. After that, the server runs a recorded copy, and an edit changes nothing until you confirm it; a server restart alone doesn't apply it. See [Reload](#reload), and [What a confirmation applies](#what-a-confirmation-applies) for how each kind of change is applied.

Postinstall creates a skeleton with an empty persona list. An empty list is valid: the server starts with no persona connected.

```json
{
  "personas": []
}
```

#### Example

A complete `config.json` with three personas:

- `planner` receives every message in its home channel `C0123456789` and in the shared channel `C0555555555`. Its permission prompts and notices go to its home channel. It takes no DMs.
- `reviewer` receives only its @mentions and `@here` / `@channel` broadcasts in the shared channel. It takes DMs, and its prompts and notices go by DM to its contact `U0123456789`. It has its own Claude config directory and turns the [Slack Reply Guard](#slack-reply-guard-stop-hook) off for itself.
- `helpdesk` is DM-only: it is in no channel and is reached only by DM. Its prompts and notices go by DM to its contact `U0987654321`.

`planner` and `helpdesk` inherit the top-level `claude_config_dir`. The server-wide settings turn on an acknowledgement reaction and set how replies are split.

```json
{
  "personas": [
    {
      "name": "planner",
      "credentials_file": "~/.config/cscb/planner-credentials.json",
      "working_directory": "~/projects/alpha",
      "channels": [
        { "id": "C0123456789", "delivery": "all" },
        { "id": "C0555555555", "delivery": "all" }
      ],
      "permission_prompts": "C0123456789"
    },
    {
      "name": "reviewer",
      "credentials_file": "~/.config/cscb/reviewer-credentials.json",
      "working_directory": "~/projects/beta",
      "channels": [
        { "id": "C0555555555", "delivery": "mentions" }
      ],
      "dm": { "enabled": true, "contact": "U0123456789" },
      "permission_prompts": "dm",
      "claude_config_dir": "~/.claude-reviewer",
      "stop_hook_bootstrap": false
    },
    {
      "name": "helpdesk",
      "credentials_file": "~/.config/cscb/helpdesk-credentials.json",
      "working_directory": "~/projects/helpdesk",
      "dm": { "enabled": true, "contact": "U0987654321" },
      "permission_prompts": "dm"
    }
  ],
  "port": 3100,
  "session_restart_delay": 60,
  "claude_config_dir": "~/.claude-bots",
  "ack_reaction": "eyes",
  "reply_chunk_limit": 3000,
  "reply_chunk_mode": "newline"
}
```

Replace the channel IDs, user IDs and paths with your own. Each persona's credentials file must exist with its tokens before that persona can come up (see [Credentials files](#credentials-files)).

#### Persona fields

| Field | Type | Required | Default | Description |
|---|---|---|---|---|
| `name` | string | yes | — | Any non-empty string; no format rule. See [Persona name and key](#persona-name-and-key). |
| `credentials_file` | path | yes | — | Path to the persona's [credentials file](#credentials-files). |
| `working_directory` | path | yes | — | Working directory of the persona's Claude instance. It must exist before the persona can come up. |
| `channels` | array | yes, unless `dm.enabled` is `true` | none | The channels the persona is in: a list of [channel entries](#channel-entries). See [Channel delivery](#channel-delivery). |
| `dm.enabled` | boolean | no | `false` | The persona's DMs switch. See [Direct messages](#direct-messages-dmenabled). |
| `dm.contact` | string | when `permission_prompts` is `"dm"` | — | A Slack user ID such as `U0123456789`: the person a `"dm"` destination addresses. In Slack, open the person's profile, then **⋮** → **Copy member ID**. |
| `permission_prompts` | string | yes | — | The persona's **destination**: where its permission prompts and server notices are posted. One of the persona's own channel IDs, or `"dm"`. See [Permission prompts](#permission-prompts). |
| `claude_config_dir` | path | no | top-level `claude_config_dir` | Claude config directory for this persona. See [Next-launch settings](#next-launch-settings). |
| `stop_hook_bootstrap` | boolean | no | top-level `stop_hook_bootstrap` | Slack Reply Guard switch for this persona. See [Next-launch settings](#next-launch-settings). |

`dm` is an object holding `enabled` and `contact`: `"dm": { "enabled": true, "contact": "U0123456789" }`. A path is absolute, `~` or starts with `~/`. Paths are never redacted: a log line, preview or error that names a path shows it in full, with `~` expanded.

#### Channel entries

Each entry of `channels` is an object with two required fields:

| Field | Description |
|---|---|
| `id` | A Slack channel ID: `C` or `G` followed by capital letters and digits, such as `C0123456789`. Not a channel name. In Slack, click the channel name; the ID is at the bottom of the **About** tab. |
| `delivery` | `"all"` or `"mentions"`. See [Channel delivery](#channel-delivery). |

#### Persona name and key

The `name` identifies the persona in `config.json`, logs and targets. It isn't its Slack display name, which comes from the persona's Slack app. Any non-empty name is accepted.

Logs, previews and Slack notices show the name JSON-quoted, with its key beside it, as `"planner" (key=planner)`. Inside a quoted error message (`message="…"`), token-like text is redacted, so a token-like name is redacted there too.

A name of 1–40 characters, all lower-case letters, digits and `_`, is its own key. Any other name gets a derived key:

1. The name is lower-cased.
2. Each run of characters other than `a-z`, `0-9` and `_` becomes one `_`.
3. Leading and trailing `_` are trimmed, and the result is cut to 40 characters.
4. `_` and an 8-character hash of the name are appended. A name with nothing left after step 3 gets the hash alone.

`"Help Desk"`, for example, has the key `help_desk_95a3a6f5`. Each persona's `persona-start` line in `server.log` shows its key.

The key is used for:

- the persona's agent-director instance, `cscb_<key>`;
- its tmux session, `slack_bot_<key>`;
- the `CSCB_PERSONA` environment variable of its Claude instance;
- targets: [`/interject`](#interject) and the [crontable](#scheduled-prompts-cscb_cron) accept the persona's name or its key.

**No persona's key may start with another persona's key.** The server rejects such a pair when it checks the configuration (see [Load-time rules](#load-time-rules)), with an error that names both personas and suggests a new name. agent-director 0.10.0 reads a persona's screen, types into its session, kills it and checks that it exists by a tmux session name that also matches the start of a longer name. So with personas `dev` and `dev_2`, while `dev`'s session is gone, agent-director could take `slack_bot_dev_2` for it: read that screen as `dev`'s, type `dev`'s reconnect into it, or end it. The server's own tmux commands name each session exactly.

Give the shorter name a suffix, such as `dev_main` beside `dev_2`, or `horde_main` beside `horde_admin`, or rename either so that neither key starts with the other. Keys that only share a start, such as `dev_a` and `dev_b`, are fine. A name that isn't its own key counts by its key: `"Dev Bot"` (key `dev_bot_…`) can't sit beside `dev` either.

Renaming a persona changes its key, so the old persona is removed and a new one added (see [What a confirmation applies](#what-a-confirmation-applies)).

#### Credentials files

Each persona's Slack tokens live in its own credentials file, and `config.json` names that file only by path. The file is a JSON object with exactly two keys:

```json
{
  "bot_token": "<bot token, starts with xoxb->",
  "app_token": "<app-level token, starts with xapp->"
}
```

`bot_token` is the app's bot token (`xoxb-…`), shown under OAuth & Permissions once you install the app to the workspace. `app_token` is an app-level token (`xapp-…`) with the `connections:write` scope, generated under Basic Information → App-Level Tokens.

- Tokens come only from these files, never from `config.json`.
- Two personas can't share a credentials file.
- The server never writes or copies the file and doesn't check its mode. Keep it private: `chmod 600`.
- The file's content is checked when the persona comes up, not when `config.json` is checked. A missing or malformed file keeps only that persona down (see [Troubleshooting](#troubleshooting)).
- On a running server, a change to the file waits for confirmation like a `config.json` edit (see [Reload](#reload)).

The setup wizard, `setup-slack-channel-bots`, has you write this file with its [credentials command](skills/setup-slack-channel-bots/SKILL.md#credentials-command), which you run in your own terminal once the persona is declared in `config.json`:

```sh
claude-slack-channel-bots credentials <persona>
```

`<persona>` is the persona's name or key. The command finds the persona in `config.json`, reads both tokens without echoing them, validates the bot token with Slack `auth.test` and the app token with `apps.connections.open`, and writes the persona's `credentials_file` with mode 0600 only when both pass. It asks before replacing an existing file. See [`claude-slack-channel-bots credentials`](#claude-slack-channel-bots-credentials).

To rotate a persona's tokens, run the credentials command for it again (see the wizard's [Rotate a persona's tokens](skills/setup-slack-channel-bots/SKILL.md#rotate-a-personas-tokens)), then confirm the pending change (see [Confirming a change](#confirming-a-change)). Only that persona reconnects, and no restart is needed.

Never put a token in `config.json`, a ticket or a chat.

#### Channel delivery

Each channel entry's `delivery` sets which messages in that channel reach the persona:

- **`all`**: every message in the channel.
- **`mentions`**: only messages that @mention the persona directly, and `@here` / `@channel` broadcasts.

Any number of personas may list the same channel, each with its own `delivery`. One persona can't list a channel twice. Invite the persona's Slack app to each of its channels. [How a persona receives messages](#how-a-persona-receives-messages) says how each message arrives and which `via` it carries.

#### Direct messages (`dm.enabled`)

`dm.enabled` is each persona's DMs switch. It is off (`false`) by default.

- **On:** anyone in the workspace can DM the persona's own Slack app, and that persona alone receives the DM and answers in it. The persona can also start a DM with a workspace user by passing the user's ID to `reply`, and posts there as itself.
- **Off:** DMs to the persona's app are not delivered. The server logs one `persona-dm-dropped` line naming the persona and `dm.enabled`. The persona never opens, reads or posts in a DM.
- **Group DMs** (DMs with more than one person) are never delivered to any persona, whatever `dm.enabled` says.

A persona with no `channels` must have `dm.enabled` set to `true`.

`dm.contact` is the person who receives the persona's prompts and notices when `permission_prompts` is `"dm"`. It gates nothing else: it doesn't limit who can DM the persona.

Starting a DM with a user (a `reply` to a user ID, or a persona whose `permission_prompts` is `"dm"`) needs the `im:write` bot scope, which the shipped `slack-app-manifest.yml` grants. A `"dm"` destination always opens its DM through Slack before it first posts there, even when the DM already exists. For an app created from an earlier manifest, a `"dm"` persona's prompts and notices are not posted, and a `reply` to a user ID fails with `missing_scope`, until the scope is added and the app is re-installed.

Receiving DMs and replying in an existing DM (a `D…` ID) work without the scope. The `debug-slack-channel-bots` skill (see [Troubleshooting](#troubleshooting)) has the steps under "A persona can't open a DM".

#### Permission prompts

`permission_prompts` is required. It is the persona's destination: its permission prompts and its server notices, such as lost-message notices and restart-limit warnings, are posted there as the persona.

- **A channel ID:** one of the persona's own `channels`. Everyone in that channel sees the prompts and notices.
- **`"dm"`:** a DM from the persona's app to its `dm.contact`. It needs `dm.enabled: true` and a `dm.contact`.

Give each persona a destination that no other persona receives every message in, such as its own channel or `"dm"`. Don't give a persona `delivery: all` in another persona's destination channel. A notice is a Slack post like any other: when two personas each receive every message in the other's destination channel and neither persona's instance can take messages, each loses the other's lost-message notices and posts a notice about it, so they keep posting notices about each other until either instance takes messages again (see [Troubleshooting](#troubleshooting)).

[Permission Relay](#permission-relay) covers how prompts are delivered and answered, and [Troubleshooting](#troubleshooting) what happens when Slack refuses a post to the destination.

#### Next-launch settings

`claude_config_dir` and `stop_hook_bootstrap` can be set on a persona or at the top level. A persona's own value wins; the top-level value is the default for every persona without one. Once a change is confirmed, it takes effect at the persona's next launch (see [When next-launch and server-wide changes take effect](#when-next-launch-and-server-wide-changes-take-effect)).

**`claude_config_dir`** is the Claude config directory the persona's instance launches with (`CLAUDE_CONFIG_DIR`), so each persona can authenticate as a different Claude account. Populate each directory before the persona first launches:

```sh
CLAUDE_CONFIG_DIR=~/.claude-reviewer claude auth login --claudeai
```

Use `--console` instead of `--claudeai` for a Console account. When neither the persona nor the top level sets one, Claude's own default applies.

- A directory that doesn't exist yet is fine when its parent exists.
- A persona whose `claude_config_dir` can't be resolved to a real path (for example, a symlink on its path that points to nothing) is held: it closes or never opens its Slack connection and receives nothing, and `server.log` shows `persona-config-dir-unresolvable`. It reconnects once the directory resolves, with no restart.
- A confirmed change to a persona's effective `claude_config_dir` makes it start fresh, without its prior conversation, at its next launch. The old transcript stays in the old directory.
- The Slack Reply Guard never installs its hook in `~/.claude`, so a persona whose directory resolves there gets no reminder (see [Personal-dir refusal](#personal-dir-refusal)).

**`stop_hook_bootstrap`** turns the [Slack Reply Guard](#slack-reply-guard-stop-hook) reminder on (`true`, the default) or off for the persona. It applies to that persona alone, even when it shares its `claude_config_dir` with other personas. A running bot keeps the value it was launched with until it is relaunched. See [Personas that answer without `reply`](#personas-that-answer-without-reply--opt-them-out) for when to turn it off.

#### Server-wide settings

These top-level fields apply to the whole server. A confirmed change to one takes effect at the next server start, with three exceptions. A change to `claude_config_dir` or `stop_hook_bootstrap` takes effect at each inheriting persona's next launch. `stop_timeout` and `exit_timeout` are used only by the CLI, which takes them from the record at once. `agent_director_call_timeout_ms` is used by both: the CLI takes it from the record at once, and the running server uses it from its next start. See [What a confirmation applies](#what-a-confirmation-applies).

| Field | Type | Default | Description |
|---|---|---|---|
| `bind` | string | `"127.0.0.1"` | Interface the HTTP server binds to. Use `"0.0.0.0"` to expose on all interfaces. The in-process cron scheduler delivers via `127.0.0.1`, so `bind` must include loopback (the default, or `0.0.0.0`) for scheduled fires to work. |
| `port` | number | `3100` | Port the HTTP server listens on. |
| `session_restart_delay` | number | `60` | Seconds to wait before auto-restarting a dead session. Set to `0` to disable auto-restart and the health check's reconnects (not the retries of a persona agent-director refused; see [Troubleshooting](#troubleshooting)); a persona whose session runs but can't receive messages then gets a *Not connected* or *Not receiving messages* notice at its destination (see [Troubleshooting](#troubleshooting)). At any value, a persona reported as `working` that the server can't prove idle for 10 minutes gets a *Not connected* notice. Must be non-negative. |
| `health_check_interval` | number | `120` | Seconds between periodic liveness polls. Set to `0` to disable; the retries of a persona agent-director refused still run. Must be non-negative. |
| `exit_timeout` | number | `120` | Seconds to wait for a managed Claude Code session to exit gracefully during `clean_restart` or `stop --stop-bots` before force-killing it through agent-director. |
| `stop_timeout` | number | `30` | Seconds to wait for the server process to exit after `SIGTERM` before escalating to `SIGKILL`. |
| `mcp_config_path` | string | `~/.claude/slack-mcp.json` | Path to the MCP config file passed to Claude Code when launching managed sessions. |
| `append_system_prompt_file` | string | — | Path to a file appended to every managed session's system prompt via `--append-system-prompt-file`. Missing file silently skipped. See `skills/EXAMPLE_CLAUDE.md` for a template. |
| `system_prompt_mode` | string | `"append"` | Controls how `append_system_prompt_file` is applied. `"append"`: the custom prompt file is appended on top of `CLAUDE.md` (default, current behavior). `"none"`: only `CLAUDE.md` is used; `append_system_prompt_file` is ignored even if set. Use `"none"` when the project's `CLAUDE.md` already contains everything the bot needs. |
| `cozempic_prescription` | string | `"standard"` | Cozempic cleaning intensity before resume. Valid values: `gentle`, `standard`, `aggressive`. Has no effect if cozempic is not installed. |
| `message_archive_db` | string | — | Path to a SQLite DB where every inbound Slack message is archived in real time. Parent directories are created if missing; schema is initialized on first open. Compatible with the `archive-messages.py` backfill script — both can write concurrently. Feature is disabled when absent. |
| `claude_config_dir` | string | — | Default Claude on-disk config directory for every persona. When a persona has one (its own or this default), its session launches with `CLAUDE_CONFIG_DIR='<resolved-path>'` so the bot authenticates against a specific account. `~` is expanded and the path is resolved to absolute. A persona's own `claude_config_dir` overrides this value. When neither is set, Claude's own default applies. Must be non-empty when set. |
| `resume_enabled` | boolean | `true` | When `true` (default), a bot whose session died — including after a host reboot or pod resume — comes back with its prior conversation history intact instead of starting fresh. When `false`, the session manager always performs a fresh launch instead of resuming, both on startup and on runtime auto-restart, even when a stored session exists. Set `false` as a workaround if your Claude Code version crashes with "sandbox required but unavailable" on resume (a known regression in v2.1.120). Requires a system-installed `agent-director` ≥ 0.8.0 for reboot recovery to actually restore history. |
| `agent_director_poll_interval_ms` | number | `1000` | Poll interval (ms) for the agent-director permission relay tick. Must be a positive integer in `[200, 3_600_000]`. Replaces the pre-rename `claude_director_poll_interval_ms` — the old name is rejected at startup. |
| `agent_director_call_timeout_ms` | number | `60000` | How long (ms) CSCB waits on each agent-director call it makes for its personas, in the server and in `stop --stop-bots` and `clean_restart`. Must be an integer in `[1000, 3_600_000]`; out-of-range values are rejected at load. It should be greater than the need that agent-director's timing settings give; see [Sizing the agent-director call timeout](#sizing-the-agent-director-call-timeout). |
| `stop_hook_bootstrap` | boolean | `true` | Default for every persona: whether the persona gets the Slack Reply Guard reminder (see [Slack Reply Guard (Stop hook)](#slack-reply-guard-stop-hook)). The value applies per persona, from the persona's first launch after the change is applied (see [Reload](#reload)). A persona's own `stop_hook_bootstrap` overrides this value. Non-boolean values are rejected at startup. |
| `cron_table_path` | string | `<config dir>/crontab` | Path to the crontable for the built-in cron scheduler (`cscb_cron`). Defaults to `crontab` in the directory of the loaded `config.json`. `~` is expanded like other path keys. The resolved path is exported into every managed session as `CSCB_CRONTABLE_PATH` so bots can find the crontable and self-schedule (see [Scheduled Prompts](#scheduled-prompts-cscb_cron)). Must be a non-empty string when set. |
| `cron_log_path` | string | `<config dir>/cron.log` | Path to the `cscb_cron` log file. Defaults to `cron.log` in the directory of the loaded `config.json`. `~` is expanded like other path keys. Must be a non-empty string when set. |
| `cron_log_max_bytes` | number | — | Size cap in bytes for the cron log. Must be a positive integer when set. Cron-log pruning is disabled when absent. |
| `ack_reaction` | string | — | Emoji name, without colons (for example `"eyes"`), of the acknowledgement reaction. When set, each persona a message is dispatched to adds the reaction under its own Slack identity once the message has reached its instance, not on receipt, so a message that reaches several personas carries one reaction per persona. A message that isn't dispatched gets no reaction: one lost because the persona's instance is down, or one the persona doesn't receive. Messages sent through `/interject` or cron aren't Slack messages and get none either. A persona's first `reply` in that conversation carrying the message's `message_id` removes that persona's reaction only; other personas' reactions stay until they reply. Absent means no acknowledgement. Must be non-empty when set. |
| `reply_chunk_limit` | number | `4000` | Maximum characters per posted message: the `reply` tool splits longer text into several messages. Must be a positive integer. |
| `reply_chunk_mode` | `"length"` \| `"newline"` | `"newline"` | How the `reply` tool splits text longer than `reply_chunk_limit`. `length`: hard split at the limit. `newline`: split at newline boundaries within the limit; a single line longer than the limit is posted whole. |

#### Load-time rules

Before it applies `config.json`, the server checks the whole file and reports the first rule it breaks:

- A persona's name or key equals another persona's name or key.
- A persona's key starts with another persona's key, such as `dev` and `dev_2` (see [Persona name and key](#persona-name-and-key)).
- Two personas share a `working_directory` or a `credentials_file`, compared by real path.
- `permission_prompts` names a channel that isn't in the persona's `channels`.
- `permission_prompts` is `"dm"` without `dm.enabled: true` or without a `dm.contact`.
- A persona has no channels and `dm.enabled` isn't `true`.
- A persona lists the same channel twice.
- A channel ID or `dm.contact` is malformed. Channel IDs start with `C` or `G` and user IDs with `U` or `W`, followed by capital letters and digits only; underscores are not allowed.
- A path isn't absolute, `~` or `~/…`.
- A required field is missing, or a key is unknown.
- A value has the wrong type, isn't an allowed value, or is out of range.

For a persona error, the error names the persona (`personas[<i>]`) and the field. Credentials content and whether directories exist are not checked here; they are checked when each persona comes up. At a start with no last-applied record, an error stops the start. On a running server, an error shows as an `INVALID` pending change (see [Reload](#reload)). The `debug-slack-channel-bots` skill (`skills/debug-slack-channel-bots/SKILL.md`) lists every rejection with its cause and fix under "Configuration rejections".

---

### MCP Server Config (slack-mcp.json)

Claude Code sessions need a config file pointing at the MCP server. A skeleton is created by postinstall at `~/.claude/slack-mcp.json`.

```json
{
  "mcpServers": {
    "slack-channel-router": {
      "type": "http",
      "url": "http://127.0.0.1:3100/mcp"
    }
  }
}
```

If you change `port` or `bind` in `config.json`, the confirmed change takes effect only at the next start (see [Reload](#reload)), so update the `url` here to match at that restart. The server-managed session launcher uses `mcp_config_path` from the applied configuration to locate this file.

---

### agent-director's timing settings

agent-director keeps its timing settings in the `[tmux]` table of `~/.agent-director/config.toml`. They are agent-director's settings, not CSCB configuration: CSCB only reads them, from the file under the HOME the server runs in.

The server reads the table when it starts and every 120 s after that, whatever `health_check_interval` is (`0` included), so a change on the host is used within about 120 s (each read follows the binary re-check, which runs 120 s after the previous one ends and can take up to its 30 s time limit). It applies agent-director's own rule: a missing file, a missing key or `0` means agent-director's default.

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

If the file can't be read or parsed, or a `[tmux]` value is one agent-director refuses (not a whole number, negative, above 2^63 − 1, or below its minimum), the server keeps the last values it accepted (the defaults, if none yet) and writes one line to `server.log`. The `debug-slack-channel-bots` skill explains that line under "agent-director's timing settings". agent-director's own answers always decide; the server's reading of the file never overrides them.

#### Sizing the agent-director call timeout

`agent_director_call_timeout_ms` (default `60000`, an integer in `[1000, 3_600_000]`; see [Server-wide settings](#server-wide-settings)) is how long CSCB waits on each agent-director call it makes for its personas:

- **The server** uses the value from the configuration its start runs: the last-applied record, else `config.json`.
- **`stop --stop-bots` and `clean_restart`** use the value from the last-applied record, else `config.json`. When `stop --stop-bots` can't read that configuration, it uses the default `60000`.

A call that runs past the timeout ends in an error while agent-director may still be carrying out the verb. So the setting must be greater than its **need**: the largest ceiling among the agent-director verbs CSCB calls, plus a 15 s margin (15000 ms: the store's 10 s busy timeout and 5 s to start agent-director's CLI). Each ceiling is computed from the host's `[tmux]` values in the table above, with these letters:

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
[slack] agent-director settings: agent_director_call_timeout_ms is <value>, at or below its need of <need> ms (the <verb> ceiling plus the 15000 ms margin): a call can time out while its verb still acts; see the README's switch-over runbook, section "Switching over to agent-director Phase 1" (b.jg5 SRJ-213)
```

`<verb>` names the row whose ceiling sets the need: its verb, or `resume/spawn-with-reuse/plain-spawn` for the launch row those three share. When `[pause] timeout_seconds` holds a value that is not used, the line is this one instead, whatever the setting is:

```text
[slack] agent-director settings: agent_director_call_timeout_ms is <value>; its need is unknown: [pause] timeout_seconds holds <found>, a value that is not used, so pause's wait is not counted and the need without it is <need> ms; see the README's switch-over runbook, section "Switching over to agent-director Phase 1" (b.jg5 SRJ-213)
```

`<found>` is the number (for example `0`) or the kind of value, never the file's text. At agent-director's defaults, the default `60000` writes no line; a setting of `54000` writes the first line, naming `pause`.

Either way the server still starts, and no value changes. The check runs only at start: a later change to `config.toml` is checked at the next start.

To fix it, raise `agent_director_call_timeout_ms` in `config.json` above the need and confirm the change (see [Reload](#reload)). `stop --stop-bots` and `clean_restart` use the new value at once; the server uses it from its next start.

For the second line, give `[pause] timeout_seconds` a positive whole number, or remove it for the 30 s default; the next start checks the setting against the need that gives.

---

## Reload

Saving `config.json` doesn't change what runs. The server runs the last configuration it applied, and it shows an edit as a pending change until you confirm it (see [Confirming a change](#confirming-a-change)).

### Files beside the config file

These files sit in the same directory as `config.json` (`~/.claude/channels/slack/` by default, or `SLACK_STATE_DIR`). Never edit them by hand.

| File | What it is |
|---|---|
| `config.json.last-applied` | The record: a byte copy of the last configuration the server applied. The server writes it. |
| `config.json.pending` | A preview of what applying the edit would do, written by the server. It exists only while a change is pending. |
| `config.json.apply` | Your confirmation: the pending file, renamed. The server deletes it at its next check (see [Confirming a change](#confirming-a-change)). |

### Start rules

| At start | What happens |
|---|---|
| A record exists | The server runs the record, not `config.json`. This includes the start after a host reboot. |
| No record (a fresh install, or the first start after upgrading to this release) | The server checks `config.json`, records it and applies it. If the file is missing or invalid, the server doesn't start and `server.log` says why. |
| The record can't be read or is invalid | The server doesn't start. The log line names the record and says that deleting it makes the next start apply `config.json` as it stands. |
| The record can't be written | The server doesn't start and logs `reload-record-write-failed`. |

A configuration with zero personas is valid and starts.

CSCB ships no boot mechanism: starting the server after a host reboot is the operator's job.

Credentials files are read as they stand at every start. So a credentials change still pending when the server stopped takes effect at the next start.

`stop`, `stop --stop-bots` and `clean_restart` take their timeouts and persona set from the record when there is one, and from `config.json` otherwise.

Deleting the record discards it: the next start applies `config.json` as it stands, whatever it contains.

If the first start fails on a setting such as `port` or `bind`, see "A fix to config.json is ignored after a failed first start" in [Troubleshooting](#troubleshooting).

### Editing the configuration

While the server runs, it checks `config.json` and each credentials file the file names about every 5 seconds. It applies nothing it finds. When either differs from what is applied, the server writes `config.json.pending` and logs the same preview once in `server.log`. The change waits for your confirmation (see [Confirming a change](#confirming-a-change)). Nothing about a pending change is posted to Slack.

- Restarting the server or rebooting the host doesn't apply a pending `config.json` edit. The start brings back the recorded personas, and the edit stays pending.
- A pending credentials-file change is the exception: every start reads credentials files as they stand, so the next start applies it.
- Reverting the edit byte for byte deletes the pending file, and the server logs `reload-nothing-pending`. A revert that leaves only a whitespace difference stays pending, as `no effective change`.
- In dry run (`SLACK_DRY_RUN`), credentials files are not compared.

To see what is pending:

```sh
cat ~/.claude/channels/slack/config.json.pending
grep -E 'reload-(preview|invalid|nothing-pending)' ~/.claude/channels/slack/server.log | tail
```

### Reading the preview

The first line counts the personas added, removed, destructively modified, modified in place and with changed credentials, and the server-wide settings changed. Then there is one line per affected persona and per changed setting. For example:

```
claude-slack-channel-bots: pending configuration change (written by the server)
fingerprint: sha256:<64 hex digits>

A configuration change is pending; nothing has been applied. personas: 1 added, 1 removed, 0 destructively modified, 1 modified in place, 1 with changed credentials; server-wide settings: 2 changed.
DESTRUCTIVE: persona "scribe" (key=scribe) is removed: its live session will be destroyed (its instance is torn down).
persona "helper" (key=helper) is added but cannot come up: working directory does not exist.
persona "planner" (key=planner): channels changed: applied in place immediately, instance kept.
persona "reviewer" (key=reviewer): credentials file "/home/operator/.config/cscb/reviewer-credentials.json" changed: a new connection opens, then the old one closes, instance kept.
server-wide setting port changed: once applied, it is recorded and takes effect at the next server start after that.
server-wide setting claude_config_dir changed: inherited by "planner" (key=planner), "reviewer" (key=reviewer); takes effect at each one's next launch, which starts fresh (the conversation is not resumed), instance kept until then.
```

The preview describes the full effect of the change. What each kind of change does once confirmed is in [What a confirmation applies](#what-a-confirmation-applies).

Paths in the preview are absolute: a `~` in `config.json` is shown expanded. In `server.log`, each preview line (everything after the `fingerprint:` line and the blank line) is prefixed `[slack] reload-preview:`, and the first one ends with where the preview is written: ` (preview in "<path of config.json.pending>")`.

| Line | Meaning |
|---|---|
| `DESTRUCTIVE: …` | Applying it destroys that persona's live session: its instance and its conversation. A removed persona is torn down. A persona whose `name`, `credentials_file` or `working_directory` changed is torn down and brought up fresh. |
| `… is added but cannot come up: …` | The new persona would fail to come up, for the reasons given: its credentials file, its working directory, and its `claude_config_dir` (`claude_config_dir cannot be resolved to a real path (<errno>)`, for example a symlink on its path that points to nothing). Every reason found is listed. A `claude_config_dir` that doesn't exist yet but whose parent does is fine. |
| `credentials file "<path>" changed: …` | The persona's credentials file changed at the same path. The line names the persona and the path, never a token, and says what applying it does: a persona that is up opens a new connection, then closes the old one; a persona still retrying retries with the new content; a persona down because of its credentials `will be brought up`. |
| `credentials file "<path>" changed, but it cannot be used (<cause>): …` | The new content is missing, unreadable or invalid, for example `credentials file does not exist`. A persona that is up keeps its current connection, and a persona still retrying keeps retrying with its current content; confirming logs `persona-credentials-change-failed` in `server.log`, and the change stays pending. A persona down because of its credentials stays down, and confirming logs its usual credentials line and leaves nothing pending. Every start reads the file as it stands, so after a restart the persona is down until the file is fixed and the change confirmed. |
| `claude_config_dir changed: …, which starts fresh (the conversation is not resumed)` | The persona's next launch uses the new config directory and starts a new conversation. The running instance is kept until then. |
| `…; but at that launch it cannot come up: claude_config_dir cannot be resolved to a real path (<errno>)` | A warning after a changed `claude_config_dir`: the new directory can't be resolved, for example a symlink on its path points to nothing. On a changed top-level `claude_config_dir`, the warning names the inheriting personas it stops; on a `DESTRUCTIVE:` line that also changes the directory, it reads `but it cannot come up`. Confirming still applies the change: at the persona's next launch (at once, for a destructive change) it is held, its Slack connection closed, and it comes up once the directory resolves (`persona-config-dir-unresolvable` in `server.log`). Fix the directory, or the setting, before confirming. A directory that doesn't exist yet but whose parent does is fine. |
| `… could not be checked.` | The server couldn't check whether an added persona can come up, whether a changed `claude_config_dir` can be resolved, or whether a persona is down because of its credentials. `server.log` has a `reload: cannot check …` line; report it as a bug. |
| `server-wide setting … inherited by …` | A changed top-level default. The line lists the personas that inherit it. If none does, it says `no persona inherits it, so no instance is affected`. |
| `server-wide setting … changed: once applied, it is recorded and takes effect at the next server start after that.` | A setting such as `port` or `bind`. It doesn't take effect until the server starts after the change is applied. |
| `server-wide setting … changed: once applied, it is recorded, and the CLI takes it from the record from then on (the running server does not use it).` | `stop_timeout` or `exit_timeout`. Only the CLI uses them: once the change is applied, the next `stop` or `clean_restart` uses the new value, with no restart needed. |
| `server-wide setting … changed: once applied, it is recorded, the CLI takes it from the record from then on, and the running server uses it from its next start.` | `agent_director_call_timeout_ms`. Once the change is applied, the next `stop --stop-bots` or `clean_restart` uses the new value; the running server keeps its current value until it next starts. |
| `INVALID: <error> Nothing will be applied.` | The edited `config.json` is invalid or missing. Fix the file; nothing is applied until it is valid. `server.log` shows a `reload-invalid` line. |
| `… no effective change: …` | The edit changes nothing that runs (for example, whitespace, or a default written out). |

### Confirming a change

To apply a pending change, rename `config.json.pending` to `config.json.apply` in the same directory, with the server running:

```sh
cd "${SLACK_STATE_DIR:-$HOME/.claude/channels/slack}" && mv config.json.pending config.json.apply
```

Read the preview first. The server picks the confirmation up at its next check, within about 5 seconds; a check still running an earlier apply delays it, so `reload-applied` can come minutes later. It deletes the confirmation and applies it without a restart; next-launch and server-wide settings are recorded and take effect later (see [What a confirmation applies](#what-a-confirmation-applies)).

You can direct an agent to do the rename for you. Nothing has to be computed, copied or typed. A confirmation made while the server is stopped is processed at the first check after the next start.

Each confirmation logs one of these lines in `server.log`:

```sh
grep -E 'reload-(applied|noop|invalid|stale-confirmation|record-write-failed)' "${SLACK_STATE_DIR:-$HOME/.claude/channels/slack}/server.log" | tail
```

| Line | Meaning |
|---|---|
| `[slack] reload-applied: applied the confirmed configuration change without a restart (personas: …); the last-applied record "<path>" now holds it` | The change is applied, and `config.json.last-applied` holds it. |
| `[slack] reload-noop: the confirmed configuration has no effective change, …` | Nothing that runs changed. The record was rewritten, and nothing is left pending. |
| `[slack] reload-invalid: the confirmed configuration is invalid, so nothing is applied: <error>` | `config.json` was invalid or missing when you confirmed. The line carries the full error. Fix the file, then confirm the new preview. |
| `[slack] reload-stale-confirmation: the confirmation "<path>" …; nothing is applied` | See [Stale confirmations](#stale-confirmations). |
| `[slack] reload-record-write-failed: … the confirmed change is not applied and stays pending` | `config.json.last-applied` couldn't be written, so nothing is applied. Fix the state directory (permissions, free space), then confirm again. |

### What a confirmation applies

Each row is one kind of change: what happens once you confirm it, and what happens to the persona's live session (its instance and its conversation).

| Change | Once confirmed | Live session |
|---|---|---|
| `channels`, `delivery`, `permission_prompts`, `dm.enabled` or `dm.contact` changes | Applied in place, immediately: from the next event or post. A changed DM contact is used for the next prompt. | Kept |
| A credentials file's content changes (same path), such as a rotated token | Only that persona reconnects: the new connection opens, then the old one closes. If the new file can't be used or Slack refuses it, the old connection keeps running, `server.log` shows `persona-credentials-change-failed`, and the change stays pending. If Slack can't be reached, the old connection stays in use while the new one retries. A persona that is retrying (Slack unreachable, its working directory unusable, or held for its `claude_config_dir` by `persona-config-dir-unresolvable`) has no connection and retries with the new content. A persona down because of its credentials comes up on the confirmed change, with no restart; if its new file can't be used, it stays down with its usual line, such as `persona-credentials-invalid`, and nothing stays pending. | Kept |
| `claude_config_dir` changes (the persona's own or inherited) | Recorded. The persona's next launch uses it and starts fresh when the directory changed: the conversation is not resumed, and the old transcript stays in the old directory. | Kept until the next launch |
| `stop_hook_bootstrap` changes (the persona's own or inherited) | Recorded. The persona's next launch uses it. | Kept |
| A persona is removed | Torn down. Its agent-director row is destroyed too. Its posted permission prompts stay in Slack, and clicking one has no effect. Previewed `DESTRUCTIVE:`. | Destroyed |
| A persona's `credentials_file` path or `working_directory` changes | Torn down, then brought up fresh from its new entry, with no restart. Its agent-director row is destroyed too, and the new credentials file is read. Previewed `DESTRUCTIVE:`. See [Destructive changes](#destructive-changes). | Destroyed |
| A persona's `name` changes | A removal plus an addition: the name sets the key. The old persona is torn down and the new one brought up fresh. The removal half is previewed `DESTRUCTIVE:` (`DESTRUCTIVE: persona "<old name>" … is removed`), followed by an `… is added` line for the new name. | Destroyed |
| A server-wide setting changes, such as `port` | Recorded. The running server keeps its current value, and the next server start uses the recorded one. `stop_timeout` and `exit_timeout` are an exception: only the CLI uses them, and it takes them from the record at once, so the next `stop` or `clean_restart` uses them. `agent_director_call_timeout_ms` is the other: the CLI takes it from the record at once, and the running server uses it from its next start. | Not affected |
| A persona is added | Brought up exactly as at start, including the storage check (`jsonl-non-persistent`, see [Startup errors](#startup-errors)). If its credentials file or working directory is bad, it logs the same lines as at start and never affects running personas. See "A persona doesn't come up or doesn't answer" in [Troubleshooting](#troubleshooting). | New session |

- **Inherited defaults.** A changed top-level `claude_config_dir` or `stop_hook_bootstrap` takes effect at each inheriting persona's next launch. The preview lists those personas; a persona that sets its own value isn't affected.
- **Unchanged personas.** A persona whose declaration and credentials are unchanged is not touched.
- **Several changes to one persona.** A `credentials_file` path or `working_directory` change wins: the persona is brought up fresh from its new entry, which carries its other changes with it. Otherwise each change applies as its row says. The order is teardowns, in-place updates, credentials reconnects, then bring-ups.
- **Fixed on Slack's side.** A persona down because Slack refused its tokens, fixed in Slack (for example, its app re-installed) with the same tokens, has nothing pending. Re-save its credentials file with any byte change (a trailing newline is enough), wait for the pending change, then confirm it. The `debug-slack-channel-bots` skill (see [Troubleshooting](#troubleshooting)) has the details.

### When next-launch and server-wide changes take effect

A persona's next launch happens when the bot dies (a crash or a failed health check), at a `clean_restart`, at `stop --stop-bots` then `start`, or after a host reboot. A plain `stop` and `start` reconnects to the running instance, which is not a launch. Server-wide settings take effect at the next server start. The CLI takes `stop_timeout`, `exit_timeout` and `agent_director_call_timeout_ms` from the record at once; see the table.

To make them take effect sooner, wait for the `reload-applied` line, then run `claude-slack-channel-bots clean_restart`. It reads the bot list from the record before it stops the server, so if you run it earlier it can work from the old record. The server comes back on the record, and every bot is relaunched. Conversations resume, except that a changed `claude_config_dir` starts that persona fresh.

### Destructive changes

`DESTRUCTIVE:` lines in the preview name the sessions the change destroys when you confirm it (see the table above). Read the preview before you rename it. There is no undo. Re-adding a removed persona brings up a fresh session, and the old conversation isn't guaranteed to resume.

If the teardown can't delete the persona's agent-director row (for example, agent-director is unreachable), `server.log` shows `[slack] persona teardown of "<name>" (key=<key>): agent-director delete of cscb_<key> failed: …`, and the bring-up finds that row. A row whose working directory or config directory no longer matches is replaced. When neither changed (for example, only the `credentials_file` path changed), the row still matches, so the bring-up may resume it with its conversation instead of starting fresh.

### Stale confirmations

A confirmation is pinned to the exact content of `config.json` and of every credentials file it names. If any of them changed after the preview was written, nothing is applied. The confirmation is deleted, and one `reload-stale-confirmation` line is logged. The same happens for a confirmation that can't be read or isn't a pending file the server wrote.

To fix it, wait for the server to write `config.json.pending` again (within about 5 seconds), read it and rename it again. A confirmation is used once. If the same content comes back later, for example after a revert and a redo, confirm it again.

### Size limit

`config.json`, the files beside it and each credentials file are read only up to 64 KiB; a larger file is treated as unreadable. If a very large change makes `config.json.pending` itself larger, its rename is refused as stale, so split the change into smaller edits.

### No reload command

By design, no CLI subcommand, MCP tool or HTTP endpoint applies a change: the rename is the only way. Personas are Claude instances that read help output and tool lists, and a reload can remove a persona, so none of them advertises it; this isn't a security boundary, since a bot running as your user could rename the file itself, so only direct one to when you intend to.

### When the server can't start

A confirmation needs a running server. When the record keeps the server from starting (it can't be read or is invalid, or the first start recorded a bad `port` or `bind`), fix `config.json`, delete `config.json.last-applied`, then run `claude-slack-channel-bots start`. With no record, the start applies `config.json` as it stands and shows no preview.

---

## CLI Reference

The `claude-slack-channel-bots` binary exposes four subcommands.

### `claude-slack-channel-bots start`

Checks that the configuration file or the last-applied record exists, starts the server in the background, and waits for it to get through startup.

**Prerequisite check:** `STATE_DIR/config.json` or `STATE_DIR/config.json.last-applied` exists. If neither does, `start` exits 1 with:

```
missing prerequisite: config.json not found at <path>, and no config.json.last-applied at <path>
```

`start` reads no Slack token. The server checks the configuration, and each persona's credentials file, once it runs.

The server first runs the agent-director startup gate: it imports `agent-director`, constructs the singleton Client (which probes the system binary's version and refuses a binary below the client's own minimum), reads the binary's version from the built client and refuses a binary below CSCB's Phase 1 floor, and verifies `~/.agent-director/state.db` is owned by the current user. Failures land in `startup-errors.log` (see [Startup errors](#startup-errors)). agent-director enforces tmux availability at spawn time. The server then loads the configuration and starts listening. With a last-applied record it runs the record; without one it checks `config.json`, records it and applies it (see [Reload](#reload)). Only then does it write its PID to `STATE_DIR/server.pid`. Conversation context is preserved across server restarts when possible.

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

`<key>` is the first pre-persona key found in the file. Any other invalid configuration fails the same way, with a message naming the persona and the field. A last-applied record that can't be read or is invalid stops the start with `[slack] Fatal: last-applied record error —` and the deletion hint, and a record that can't be written stops it with `reload-record-write-failed` (see [Troubleshooting](#troubleshooting)). A server that is already running makes the new one exit with `[slack] Server is already running (PID <pid>). Exiting.`, so `start` exits 1.

### `claude-slack-channel-bots stop`

Reads `STATE_DIR/server.pid` and sends `SIGTERM` to the process.

Behavior by case:

- **PID file missing:** prints `server is not running` and exits 0.
- **Stale PID file** (process no longer running): removes the PID file, prints `server is not running (removed stale PID file)`, exits 0.
- **Live process:** sends `SIGTERM`, polls for exit for up to `stop_timeout` seconds (default 30s), read from the last-applied record when there is one. Prints `[slack] Server stopped.` on clean exit. Escalates to `SIGKILL` if the process does not exit within `stop_timeout`.

Plain `stop` leaves the managed bots running — they are meant to survive a server restart. Pass `--stop-bots` to gracefully exit the bots first:

```sh
claude-slack-channel-bots stop --stop-bots
```

This mirrors `clean_restart`'s order: the server is stopped **first**, then the bot teardown runs for each persona in the last-applied record (or in `config.json` when there is no record), addressing its instance as `cscb_<key>` — pause the bot, poll until it exits (or up to `exit_timeout` seconds), then force-kill on timeout. Teardown kills but never deletes each row, preserving its `claude_session_id` so the bots can resume their conversation history on the next start. Stopping the server first prevents its `onsessionclosed`/`scheduleRestart` handler from respawning a just-exited bot mid-teardown (which would delete its `ended` row and history). Use it when you want a clean, flushed shutdown of the bots (for example before a host reboot).

If agent-director is unreachable, the teardown **fails loudly** — the command prints the error and exits non-zero rather than silently reporting a clean stop. (A configuration that cannot be loaded, a bad record or a missing or pre-persona file included, is best-effort: teardown is skipped with `[slack] stop --stop-bots: could not load config — skipping bot teardown:` and the server stop still succeeds, since the server is already down.)

### `claude-slack-channel-bots clean_restart`

Gracefully exits all managed Claude Code sessions, then stops and starts the server.

```sh
claude-slack-channel-bots clean_restart
```

For each persona in the last-applied record (or in `config.json` when there is no record), calls `client.pause({claude_instance_id})` via agent-director with the persona's instance ID `cscb_<key>`, and polls `client.status(...)` until the spawn transitions to `ended` / `missing` (or `client.status(...)` fails with `ErrSpawnNotFound` because the row is gone). If the spawn does not exit within `exit_timeout` seconds (default 120s), the spawn is force-killed via `client.kill(...)`. Teardown kills but never deletes each row, preserving its `claude_session_id` so bots resume their conversation history on the next start. All personas are processed in parallel. After the server restarts, the SR-1.4 collision-then-act dispatcher decides resume-vs-fresh per persona — agent-director owns Claude session-id state, not CSCB.

`clean_restart` logs its progress to `STATE_DIR/clean_restart.log`. The lines that end it with an error (config load failure, agent-director initialization failure, teardown failure, start failure) are also printed to the terminal.

`clean_restart` loads the last-applied record first, or `config.json` when there is no record, and takes `exit_timeout` from it. If it cannot (a record that can't be read or is invalid, or a missing or pre-persona file), it exits 1 with `[slack] clean_restart: failed to load config:` and the loader's error, and nothing is stopped. For a bad record, the error says that deleting it makes the next start apply `config.json` (see [Reload](#reload)). `clean_restart` doesn't apply a pending `config.json` edit: the server comes back on the record.

A benign kill outcome — the row already being gone — is tolerated per persona and does not abort the restart. Any other per-persona teardown failure, including a pause failure that escalates to a kill which then fails to reach agent-director, is fatal: it fails loudly and aborts the restart (non-zero exit).

Behavior by case:

- **No personas** (`"personas": []`): nothing is torn down; the server is stopped and started.
- **A persona with no instance:** logs `[slack] teardownBots: no spawn row for persona "<name>" (key=<key>) — skipping` and continues.
- **Server already stopped:** `stop` reports `server is not running`; `start` then brings up a fresh server.
- **Server fails to start again:** `clean_restart` exits non-zero with `[slack] clean_restart: start failed with exit code <n>`; the reason is in `server.log`.
- **agent-director unreachable:** teardown fails loudly and the restart is aborted (non-zero exit); no new server is started. The `no spawn row` message appears only when a persona genuinely has no spawn, never when the client failed to reach agent-director.

### `claude-slack-channel-bots credentials`

Writes one persona's credentials file from your terminal. The setup wizard gives you this line (see [Credentials files](#credentials-files)):

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

On a running server, a new or replaced credentials file waits for confirmation like a `config.json` edit (see [Reload](#reload)).

### PID file

The PID file is stored at `STATE_DIR/server.pid` (default: `~/.claude/channels/slack/server.pid`). It is written on startup and removed on clean shutdown. A conflict check at startup prevents running two servers against the same state directory.

### Installing from a local worktree

To install the version of CSCB sitting in your working copy (so the globally-linked `claude-slack-channel-bots` binary runs your local sources), use the helper script rather than `bun install -g .`:

```sh
./scripts/install-local.sh
```

`bun install -g .` (and the equivalent `bun install -g <local-path>`) is broken on Bun 1.3.13 — it inserts an invalid empty-string dependency key into `~/.bun/install/global/package.json` and then any subsequent global op fails with `error: Package "@" has a dependency loop` (upstream: [oven-sh/bun#24207](https://github.com/oven-sh/bun/issues/24207)). The script uses `bun add -g file:<abs-path>` instead, and pre-emptively strips any empty-string entry a prior `bun install -g .` may have already left behind.

### Direct invocation for development

Skip the CLI and run the server directly with Bun for development or debugging:

```sh
bun src/server.ts
```

It follows the same [start rules](#start-rules) as `start`. With no last-applied record, a missing `config.json` stops it with `[slack] Fatal: configuration error — The configuration file "<path>" does not exist. The server requires the configuration file to start.` On startup the server prints the persona count, the MCP endpoint and example config:

```
[slack] Loaded persona config: 2 persona(s)
[slack] MCP server listening on http://127.0.0.1:3100/mcp

Save this to ~/.claude/slack-mcp.json:
{
  "mcpServers": {
    "slack-channel-router": {
      "type": "http",
      "url": "http://127.0.0.1:3100/mcp"
    }
  }
}

Then launch Claude from a project directory with:
  claude --mcp-config ~/.claude/slack-mcp.json --dangerously-load-development-channels server:slack-channel-router
```

With `SLACK_DRY_RUN=1`, `[slack] Running in dry-run mode — Slack disabled` follows the persona count.

---

## Tools

Each MCP endpoint exposes the following tools to the connected Claude Code session:

| Tool | Description |
|---|---|
| `reply` | Send a message to one of the persona's configured channels or, when the persona's `dm.enabled` is `true`, to a DM conversation ID (`D…`) or a Slack user ID (`U…`/`W…`). A user ID opens a DM with that user and posts there as the persona; the result names the DM conversation ID to use for later calls. Splits long text into several messages by the server-wide `reply_chunk_limit` and `reply_chunk_mode` settings. With `message_id` (the message being answered), removes this persona's acknowledgement reaction from that message. Supports file attachments. |
| `react` | Add an emoji reaction to a Slack message in a configured channel or, with `dm.enabled` `true`, a DM conversation (`D…`). |
| `edit_message` | Edit a previously sent message (bot's own messages only) in a configured channel or, with `dm.enabled` `true`, a DM conversation (`D…`). |
| `fetch_messages` | Fetch message history from a configured channel, a DM conversation (`D…`, with `dm.enabled` `true`) or a thread in either. Returns oldest-first. |
| `download_attachment` | Download attachments from a Slack message in a configured channel or, with `dm.enabled` `true`, a DM conversation (`D…`). Saves files to `STATE_DIR/inbox/`. Returns local file paths. Only files hosted by Slack are downloaded; external files are refused. |

Only `reply` takes a user ID; the other tools need a channel or DM conversation ID. When `dm.enabled` ([Persona fields](#persona-fields)) is `false`, the persona has no DM target: no tool can post in, read or open a DM. A tool call with any other target is refused with a tool error naming the persona and the target, and nothing is sent to Slack.

---

## Interject

POST to `/interject` to inject a message into a persona's running Claude instance from localhost. The message reaches only the named persona's instance, never any other persona. Only requests from `127.0.0.1` or `::1` are accepted — external callers are rejected with 403. The bot sees it as described in [How a persona receives messages](#how-a-persona-receives-messages); the Slack Reply Guard does not remind it to reply.

An injected message carries no Slack conversation. If you want the bot to post a reply in Slack, say in the message text where to post it.

### Request

```sh
curl -X POST http://localhost:<port>/interject \
  -H "Content-Type: application/json" \
  -d '{"persona": "planner", "message": "Hello from a script", "sender": "my-cron-job"}'
```

| Field | Required | Description |
|---|---|---|
| `persona` | yes | The target persona's name or its key. A bot can address itself with the key in its `CSCB_PERSONA` environment variable. |
| `message` | yes | Text to inject into the session. |
| `sender` | no | Label attached to the injected message. Defaults to `"interject"`. |

### Response

On success, returns HTTP 200:

```json
{ "ok": true, "persona": "planner" }
```

`persona` is the target persona's name, even when the request named it by key.

### Error conditions

| Status | Meaning |
|---|---|
| 400 | Invalid JSON, or a missing, empty or non-string `persona` or `message`. |
| 403 | Request did not originate from localhost. |
| 404 | No persona in the applied configuration has that name or key. |
| 405 | Must use POST method. |
| 413 | Request body exceeds 32KB. |
| 503 | The persona is configured but not up (broken or retrying), even if its instance is running, or it has no live connected session. Nothing is delivered. The persona's lines in the server log give the cause. |

### Example: crontab reminder

For recurring prompts, prefer the built-in scheduler (see [Scheduled Prompts](#scheduled-prompts-cscb_cron)) — it needs no host cron and delivers straight to a persona. The host-crontab example below is an alternative when you already run `cron`:

```sh
# crontab -e
0 9 * * 1 curl -s -X POST http://localhost:3100/interject \
  -H "Content-Type: application/json" \
  -d '{"persona": "planner", "message": "Weekly reminder: update the changelog before standup.", "sender": "cron"}'
```

---

## Scheduled Prompts (cscb_cron)

The server fires scheduled prompts into personas once per minute, reading them from a crontable. Each fire is delivered as an `/interject` message to the target persona, exactly as if a script had POSTed it.

### The crontable

Schedules live in the crontable file at `cron_table_path` (default `<config dir>/crontab`, where `<config dir>` is the directory of your loaded `config.json`; override it with the `cron_table_path` key in `config.json`). The server creates the file on first boot if it is absent, with a self-documenting comment header describing the line format. See [Crontable format](#crontable-format) below for the full reference. With the default config location the crontable is at `~/.claude/channels/slack/crontab`:

```sh
cat ~/.claude/channels/slack/crontab
```

### Crontable format

On first boot the server auto-creates the crontable with this self-documenting header:

```
# CSCB crontable — scheduled prompts for the Slack channel bots.
#
# One schedule per line. Fields are positional and whitespace-delimited:
#
#   <min> <hour> <dom> <mon> <dow> <prompt-path> [<persona>[,<persona>...]]
#
#   tokens 1-5 : a standard 5-field cron expression (minute hour day-of-month
#                month day-of-week).
#   token 6    : path to the prompt file to run. It must contain NO spaces — a
#                line with more than 7 whitespace-delimited tokens is a parse
#                error (a path with spaces is unrepresentable). The prompt
#                file's content is capped at 32KB (enforced when the job fires).
#   token 7    : OPTIONAL comma-separated list of personas to target, each
#                written as the persona's name or its key. Naming a persona
#                twice (by name, by key, or both) delivers to it once. A name
#                containing whitespace or a comma cannot be written here —
#                write that persona's key instead. A bot can target itself
#                with the key in its CSCB_PERSONA environment variable. A
#                target that names no persona is logged unknown-persona.
#                Omit the token entirely to target ALL bots — that omission IS
#                the all-bots form. All-bots fan-out is not delivered yet: such
#                a line is logged fanout-deferred each time it fires. There is
#                NO all-bots wildcard: a literal '*' in the target position is
#                a parse error, not "all personas".
#
# Lines beginning with '#' and blank lines are ignored. A malformed line is
# skipped on its own; sibling lines still schedule.
#
# Example (every day at 09:00, run grooming-tick.md, target two personas):
#   0 9 * * * /home/horde/prompts/grooming-tick.md planner,reviewer
#
# Example (every hour on the hour, run standup.md, target all bots):
#   0 * * * * /home/horde/prompts/standup.md
```

Each schedule is one line of **exactly 5 cron fields**, then the prompt-file path, then an optional comma-separated list of personas, each written as the persona's name or its key:

```
0 9 * * 1 /home/horde/prompts/weekly-report.md planner,reviewer
```

Rules:

- **Exactly 5 cron fields** (minute hour day-of-month month day-of-week). Croner's 6-field (seconds-precision) and `@macro` forms are **not** supported.
- **Name each persona by its name or its key.** A persona named twice — by name, by key, or both — receives the prompt once.
- **Use the key for a name with whitespace or a comma.** Such a name cannot be written in a crontable line.
- **Omit the persona list to target ALL bots** — the omission itself is the all-bots form. (All-bots delivery is currently deferred — see [Delivery semantics](#delivery-semantics).)
- **No `*` wildcard in the persona position.** A literal `*` where a persona belongs is a parse error, not "all personas".
- **Prompt paths cannot contain spaces.** A path with spaces is unrepresentable; the extra tokens make the line a parse error and it is skipped.
- **`#` comments and blank lines are allowed** and ignored.
- **A bad line is skipped and logged** (as `parse-error` in the cron log), never fatal — sibling lines still schedule.

Because the count is positional, a **6-field line silently mis-parses instead of erroring.** For example:

```
0 0 1 1 1 1 ~/prompts/p.md
```

Here the 6th field (`1`) is taken as the prompt path and the real path (`~/prompts/p.md`) is taken as the persona list. No error is raised — every slot is filled with something syntactically acceptable — so the schedule fires on a nonsense cadence against a nonsense path. Keep expressions to exactly 5 fields.

**Upgrading a crontable that names channels.** The server never rewrites an existing crontable, so channel-ID targets are not converted. Once your config defines personas, a Slack channel ID no longer names a bot, so edit each such line to a persona name or key; until you do, the target logs `unknown-persona`.

An existing crontable also keeps its old comment header, which still tells bots to write channel IDs. Replace that comment block by hand with the header shown above.

### Path resolution

The prompt-file path resolves as follows:

- A leading `~` expands to the home directory.
- A **relative** path resolves against the **crontable's own directory** — not `$HOME`. This is a deliberate divergence from system cron's convention, so you can keep a `prompts/` directory alongside the crontable and reference it as `prompts/standup.md`.
- An **absolute** path is used as-is.

### How fires appear

A scheduled fire reaches only the target persona's instance, as an `/interject` message with no Slack conversation attached. Its `sender` label is `cscb-cron:<prompt-file-basename>` — for a prompt file `standup.md` the sender is `cscb-cron:standup`. This distinguishes a cron tick from a human and from peer-bot traffic. The [Slack Reply Guard](#slack-reply-guard-stop-hook) never reminds a bot to reply to a scheduled prompt: like every injected message, a fire carries no `via`. Because a fire carries no channel, a prompt file that wants a Slack reply must say where to post it. Each schedule delivers its own message independently, so when several schedules match the same minute for the same persona each one arrives as its own `/interject` message.

### The cron log

Every fire outcome is recorded in the cron log at `cron_log_path` (default `<config dir>/cron.log`; override with the `cron_log_path` key). Each attempt writes one line per persona targeted (showing the target as first written in the crontable), plus a per-fire summary line carrying `delivered=N failed=M` counts. The log is plain text, so `grep no-session cron.log` yields readable lines.

The `outcome` field of each line is one of these classes:

| Outcome | What happened | What to do |
|---|---|---|
| `delivered` | The prompt reached the target persona's session. | Nothing — success. |
| `no-session` | The persona exists but is not up (broken or retrying) or has no live connected session, so the message was dropped. | Check the persona's lines in the server log for the cause. A retrying persona comes up on its own; otherwise bring the session up. Failed fires are **never** retried or queued (see below). |
| `unknown-persona` | No persona in the applied configuration has that name or key. | Correct the target in the crontable. |
| `prompt-missing` | The prompt file did not exist at fire time. | Create the file or correct its path in the crontable. |
| `prompt-unreadable` | The prompt file existed but could not be read (see the `errno`). | Fix file permissions or the path. |
| `prompt-oversize` | The prompt exceeds the 32KB `/interject` cap and was skipped, never truncated. | Shorten the prompt file. |
| `parse-error` | The crontable line could not be parsed. | Fix the line — see the crontable header for the format. |
| `http-error` | The localhost POST hit an unexpected HTTP status or a network failure. | Check that the server is listening on loopback (see the `bind` note below) and inspect the `errno`/`status` in the line. |
| `fanout-deferred` | A line with no persona list (all-bots) was matched but not delivered. | None — all-bots fan-out is not yet enabled; give the line an explicit persona to deliver it today. |

### Delivery semantics

- **No retry.** A failed fire is logged and dropped — never queued or re-sent. A persona that is not up, or has no live session, fails every fire until it is up and its session is running again; the server does not queue the missed prompts.
- **Missed fires are skipped, not caught up.** While the server is down, no scheduled prompts fire, and they are not replayed on restart. The `scheduler started, N schedules loaded` line in the cron log marks when scheduling resumed, bounding the outage window.
- **Edits take effect within a minute — no restart.** The scheduler checks the crontable fresh on every tick, so an edit by hand or a line appended by a bot starts (or stops) firing within about a minute. The server is never restarted for a schedule change.
- **Deleting the crontable stops all schedules.** Nothing fires from that moment, a WARN appears in the cron log, and the server re-creates the file empty (with its header) within about two minutes — detection and re-creation happen on separate once-a-minute passes, so the re-create lands up to two tick boundaries after the deletion. Add lines back and they schedule on the next check.
- **Server-local time.** Cron expressions are evaluated in the server's local timezone.
- **Lines without a persona list are deferred.** A line with no persona list is currently matched but logged `fanout-deferred` and not delivered. Give a line an explicit persona to have it fire.
- **`bind` must include loopback.** The scheduler delivers via `127.0.0.1`, so a `bind` set to a single non-loopback interface makes every fire fail with `http-error`. Use the default `127.0.0.1` or `0.0.0.0`.

### Bot self-scheduling

Every managed session carries the resolved crontable path in the `CSCB_CRONTABLE_PATH` environment variable and its own persona key in `CSCB_PERSONA`, so a bot can schedule its own prompts without being told where the crontable lives or what to call itself. Discover both from inside a session:

```sh
echo $CSCB_CRONTABLE_PATH $CSCB_PERSONA
```

To schedule a prompt for itself, a bot appends a line whose persona list is its `CSCB_PERSONA` key:

```sh
echo "0 9 * * 1-5 prompts/standup.md $CSCB_PERSONA" >> "$CSCB_CRONTABLE_PATH"
```

The crontable is the single source of truth for schedules. When adding a schedule, **append** a new line — never rewrite, reorder, or delete other lines. An appended line starts firing within about a minute; no server restart is needed.

---

## Permission Relay

When Claude Code requires tool approval, the permission relay surfaces an interactive Slack message with **Allow** and **Deny** buttons instead of blocking the TUI. Architecture is polling-based on the `agent-director` library — there are **no hook scripts to install** and no HTTP long-poll loops.

Flow:

1. agent-director moves the spawn into `check_permission` state when Claude requests a tool permission.
2. CSCB's poller (`src/permission-poller.ts`) runs `client.list({ state: ['check_permission'], label: ['service=cscb'] })` at the `agent_director_poll_interval_ms` cadence (default 1000 ms).
3. For each new spawn, `client.get(...)` returns the open permission request (tool name, tool input and an opaque `request_token`). CSCB identifies the persona that owns the spawn from its `persona` label and posts the Block Kit prompt to the persona's destination as that persona: its `permission_prompts` channel, or, for `"dm"`, a DM from the persona's app to its `dm.contact`. The server opens that DM if none exists yet, so a DM-only persona's first prompt is delivered too. Each persona follows its own setting.
4. The operator clicks Allow / Deny in Slack, in the channel or the DM; the buttons work the same in both. CSCB resolves the click through the same persona: it calls `client.decide({ claude_instance_id, decision, request_token })` and, as that persona, updates the message to "*Permission* — Allowed" or "*Permission* — Denied by operator".
5. If a tracked prompt closes for any reason other than a Slack click, the next poller tick replaces the buttons with the verdict: "⏱ *Permission* — Timed out", "🪦 *Permission* — Session ended", "*Permission* — Allowed", "*Permission* — Denied by operator", or "*Permission* — Denied (closed)" when the reason is unknown.

While a persona is not up (broken or retrying), its instance keeps running but its permission prompts are not posted and its already-posted prompts are left as they are. They appear, or get their verdict, on the first poll after the persona comes up.

If Slack refuses a post to the persona's destination, see "A permission prompt or notice doesn't arrive" under [Troubleshooting](#troubleshooting).

### Slack app prerequisites

Each persona's Slack app must have **interactivity enabled** with **Socket Mode** as the delivery method. In each app's config, open **Interactivity & Shortcuts** → toggle **Interactivity** on. No Request URL is needed; Socket Mode delivers interaction payloads over the existing socket. This is included automatically for an app created from `slack-app-manifest.yml`.

### AskUserQuestion

The `AskUserQuestion` tool is denied for every CSCB-spawned bot via the agent-director template (`deny: ['AskUserQuestion']`). Bots respond to operator questions via the Slack `reply` MCP tool instead. There is no `ask-relay.sh` hook and no `/ask` HTTP endpoint.

### Memory-directory reads

The template also pre-allows each bot to read its own persistent-memory directory, so those reads don't surface a permission prompt to a human. One `Read(//<config-dir>/projects/*/memory/**)` rule is derived per distinct Claude config directory across your personas (a persona's own `claude_config_dir`, the top-level `claude_config_dir`, or the `~/.claude` default). The rules follow the applied personas: when a confirmed change alters the set of config directories, the server rewrites them. If that rewrite fails, `server.log` shows a `template refresh: … failed` line. Until the directories change again or the server restarts, a persona using a new directory then asks for permission each time it reads its memory notes. The rule is scoped to `projects/*/memory/**` only — never the config-dir root, which holds live credentials — so it never pre-authorizes credential reads.

---

## How a persona receives messages

Every message reaches a persona's Claude instance as its text wrapped in a `<channel source="slack-channel-router" …>` tag. A message from Slack carries a `via` attribute that says how it reached the persona. An injected message (a scheduled prompt or an `/interject` message) carries no `via`.

A message from Slack carries these tag attributes:

| Attribute | Value |
|---|---|
| `chat_id` | The channel ID, or the DM conversation ID (`D…`) for a direct message. |
| `message_id`, `ts` | The message's Slack timestamp, for example `1789936743.069939`. |
| `user` | The author's Slack display name, falling back to real name, then Slack username, then user ID. For a post by a bot or integration without a user: the post's username, else its bot profile name, else its bot ID. |
| `user_id` | The author's Slack user ID. |
| `bot_id` | The author's bot ID, in place of `user_id`, for a post without a user. |
| `via` | How the message reached the persona (see the next table). |
| `thread_ts` | The thread's timestamp, for a thread reply. |
| `attachment_count`, `attachments` | The number of attached files and each file's name, type and size, when files are attached. |

Each way a message reaches a persona:

| Kind | How it reaches the persona | Tag attributes | `via` | Reminder |
|---|---|---|---|---|
| Direct message | A DM to the persona's own Slack app, when its `dm.enabled` is `true`, whatever the text mentions. With `dm.enabled` `false` the server drops it and logs one `persona-dm-dropped` line. A group DM is never delivered. | Slack attributes; `chat_id` is the DM conversation ID | `dm` | Yes, direct-message wording |
| Direct @mention | A message that @mentions the persona in a channel listed in its `channels`, with `delivery: mentions` or `delivery: all`. | Slack attributes | `mention` | Yes, direct-mention wording |
| `@here` / `@channel` broadcast | A message that uses `@here` or `@channel` in a channel listed in the persona's `channels`, with either `delivery`. `@everyone` and user-group mentions are not broadcasts. | Slack attributes | `broadcast` | Yes, broadcast wording |
| Every message, shared channel | A message that neither @mentions the persona nor broadcasts, in a channel listed in its `channels` with `delivery: all`, when at least one other persona in the applied configuration also has `delivery: all` for that channel, whether or not that persona is up. | Slack attributes | `receive_all_shared` | Yes, shared-channel wording |
| Every message, this persona alone | A message that neither @mentions the persona nor broadcasts, in a channel listed in its `channels` with `delivery: all`, when no other persona in the applied configuration has `delivery: all` for that channel. | Slack attributes | `receive_all` | Yes, only-you wording |
| Scheduled prompt | A crontable line naming the persona fires, and the scheduler posts it to `/interject` for that persona only (see [Scheduled Prompts](#scheduled-prompts-cscb_cron)). | Only `user` = `cscb-cron:<prompt file name without its extension>` (`cscb-cron:standup` for `standup.md`) and `ts` = the server clock in seconds. No `chat_id`, `message_id` or `via`. | none | Never |
| `/interject` message | A localhost POST to `/interject` addressed by `persona` (see [Interject](#interject)); it reaches only that persona. | Only `user` = the request's `sender` (default `interject`) and `ts`, as for a scheduled prompt. No `chat_id`, `message_id` or `via`. | none | Never |

A "Yes" in the Reminder column means the [Slack Reply Guard](#slack-reply-guard-stop-hook) reminds the persona once if it ends its turn without replying, wherever the reminder is on for that persona. Each `via` has its own reminder wording, stating how the message arrived; that section lists them.

- **The first applicable `via` wins,** in the order `dm`, `mention`, `broadcast`, `receive_all_shared`, `receive_all`. A message that @mentions the persona in a channel it receives in full arrives as `mention`.
- **The persona's own @mention is removed from the text.** Mentions of other personas and `@here` / `@channel` stay.
- **Every author counts.** Posts by people, bots, integrations and other personas all arrive by these rules. Each persona posts as its own Slack app, so another persona's post reaches it like anyone else's.
- **Anyone in the workspace can reach a persona,** in a channel it is configured into by that channel's `delivery` setting, and by DM when its `dm.enabled` is `true`. There is no approval step.
- **A persona never receives its own posts.**
- **Each message arrives at most once per persona,** even though Slack sends a channel @mention twice. A Slack redelivery more than 10 minutes after the first, or after a server restart, arrives again.
- **A message without `via` is an injected prompt.** Its `user` label is free-form, so an `/interject` sender label, even one starting with `cscb-cron:`, cannot make it look like a Slack message.
- **When the reminder is off.** A persona gets no reminder when its effective `stop_hook_bootstrap` was `false` at its last launch, when it has no `claude_config_dir` (its own or the top-level one), when that directory resolves to `~/.claude`, or when `jq` is not installed. See [Slack Reply Guard](#slack-reply-guard-stop-hook).

---

## Slack Reply Guard (Stop hook)

CSCB ships a Claude Code Stop hook that gives a persona a **one-time, declinable reminder** to answer in Slack. It is on for every persona whose effective `stop_hook_bootstrap` is `true` (the default), except a persona with no `claude_config_dir`, one whose directory resolves to `~/.claude`, or any persona when `jq` is missing (see [When the guard stays silent](#when-the-guard-stays-silent)). When the messages that started the turn include a message from Slack and the persona ends its turn without calling the `mcp__slack-channel-router__reply` tool, the hook exits `2` and Claude Code shows the persona a reminder. The message's `via` picks the wording:

| `via` | Reminder |
|---|---|
| `dm` | `This turn started from a Slack direct message (conversation <chat_id>) and you haven't replied. If you meant to answer in Slack, do it now with the mcp__slack-channel-router__reply tool. If no reply is needed, just end your turn.` |
| `mention` | `This turn started from a Slack message that @mentioned you directly (channel <chat_id>) and you haven't replied. If you meant to answer in Slack, do it now with the mcp__slack-channel-router__reply tool. If no reply is needed, just end your turn.` |
| `broadcast` | `This turn started from an @here or @channel broadcast in a Slack channel (channel <chat_id>) and you haven't replied. If you meant to answer in Slack, do it now with the mcp__slack-channel-router__reply tool. If no reply is needed, just end your turn.` |
| `receive_all_shared` | `This turn started from a message in a Slack channel where you and other personas receive every message (channel <chat_id>) and you haven't replied. If you meant to answer in Slack, do it now with the mcp__slack-channel-router__reply tool. If no reply is needed, just end your turn.` |
| `receive_all` | `This turn started from a message in a Slack channel where only you receive every message (channel <chat_id>) and you haven't replied. If you meant to answer in Slack, do it now with the mcp__slack-channel-router__reply tool. If no reply is needed, just end your turn.` |
| any other value, empty included | `This turn started from a Slack channel message (channel <chat_id>) and you haven't replied. If you meant to answer in Slack, do it now with the mcp__slack-channel-router__reply tool. If no reply is needed, just end your turn.` |

`<chat_id>` is the message's `chat_id`. When `chat_id` is absent or is not a Slack ID (capital letters and digits only), the reminder omits the parenthesis, for example:

```text
This turn started from a Slack direct message and you haven't replied. If you meant to answer in Slack, do it now with the mcp__slack-channel-router__reply tool. If no reply is needed, just end your turn.
```

When several Slack messages started the turn, the last one picks the wording. A `reply` call after the earliest of them counts as a reply. The persona then continues once: it can reply, or end the turn without replying. That continuation carries `stop_hook_active=true`, which the guard always lets through, so the reminder appears at most once per turn and never loops.

**Only messages from Slack trigger it.** The guard recognises a message from Slack by its `via` attribute; any `via` value counts. Injected prompts (scheduled prompts and `/interject` messages) carry no `via`, so they never trigger the reminder: no Slack conversation is waiting on them. An injected message that arrives right after a Slack message does not cancel the reminder for the Slack message. [How a persona receives messages](#how-a-persona-receives-messages) lists every kind of message and its `via`.

### Turning it on or off

Set `stop_hook_bootstrap` in `config.json`: at the top level for every persona, or on a persona to override the top-level value for that persona alone. It defaults to `true`. Setting `stop_hook_bootstrap: false` on the persona, or inheriting `false` from the top level, is all an opt-out needs, even when the persona shares its `claude_config_dir` with other personas. See [Next-launch settings](#next-launch-settings) and [Server-wide settings](#server-wide-settings).

A change reaches a persona at its first launch after the change is applied (see [Reload](#reload)); see [Timing](#timing-when-the-hook-is-patched-and-the-record-written).

### Personas that answer without `reply` — opt them out

The guard only recognises a reply made with `mcp__slack-channel-router__reply`. A persona whose only Slack surface is `edit_message` or `react` ends its turn without that call, so the guard reminds it after every Slack message, costing one useless continuation each time. Set `stop_hook_bootstrap: false` on that persona.

### What the server writes, and where

**The hook.** The server patches `<claude_config_dir>/settings.json` in each applied persona's effective `claude_config_dir` (the persona's own value, else the top-level value). Where the hook is installed, the file holds **exactly one** managed Stop-hook group of this shape:

```jsonc
{
  "hooks": {
    "Stop": [
      { "hooks": [ { "type": "command", "command": "'<absolute path>/stop-hooks/slack-reply-guard.sh' '<state dir>/reply-guard'" } ] }
    ]
  }
}
```

The command is the absolute path of the script inside CSCB's installed package, then the record directory, each in single quotes. There is no `matcher` field, because Stop is not a tool-scoped event. Your other Stop hooks, and every other key in `settings.json`, are preserved. Writes are atomic (`.tmp` + `rename`). A missing `settings.json` is created with just this group. A malformed `settings.json` is left untouched and an error is recorded.

**Recognition rule.** The server treats *any* Stop-hook `command` containing `slack-reply-guard.sh` as CSCB-managed. Only the exact current command is kept: duplicates collapse to one group, and an entry with an older script path, no record directory or another record directory is replaced. This is how the hook heals itself across upgrades.

**The record.** Each persona has a record file, `reply-guard/<persona key>` in the state directory (`~/.claude/channels/slack/`, or `SLACK_STATE_DIR` when set). It holds `true` or `false`: the persona's effective `stop_hook_bootstrap`. The server writes it atomically immediately before it spawns or resumes the persona's instance. Reconnecting to an instance that is still running leaves the record as it was.

**What the guard reads.** Every persona's instance runs with its key in `CSCB_PERSONA`. The guard reads the record `<record directory>/<CSCB_PERSONA>` and reminds only when it reads exactly `true`. A missing argument, an unset `CSCB_PERSONA`, or a missing record means no reminder.

### Personas sharing a config directory

Personas that share one `claude_config_dir` each follow their own `stop_hook_bootstrap`, through their own record. The managed hook stays installed in a directory while any persona counting toward it has an effective `stop_hook_bootstrap` of `true` or a record reading `true`. A persona counts toward its effective directory and toward the directory its running instance launched with. When no such persona is left, the server removes the hook from that directory.

### Timing: when the hook is patched and the record written

- **Server start.** The server patches the hook for every applied persona before any launch.
- **Each launch.** Immediately before each spawn or resume (including a restart), the server writes the persona's record and patches the hook in the persona's new effective directory and, if it differs, the directory it last launched with.

A running instance keeps the value it launched with, because the guard reads that instance's own record, written only at its launch. The hook itself may appear in or vanish from a shared directory while an instance runs, for example when a neighbour launches; Claude Code normally picks up such edits without a restart, but the instance's own record still decides. On a plain server restart, live instances are reconnected rather than relaunched, so a changed value reaches them at their next launch.

The directory an instance launched with is kept in memory only. After a confirmed `claude_config_dir` change and a plain server restart, the server no longer counts a still-running instance toward its old directory. If every persona it still counts toward that directory has the reminder off, the next hook pass there (the restart's own, or a launch of such a persona) removes the managed hook, and the still-running instance gets no reminder until its next launch. A `clean_restart` relaunches it with its new directory.

### Personal-dir refusal

The server never installs the hook in your own `~/.claude` (it never edits `~/.claude/settings.json`). A persona whose effective `claude_config_dir` resolves to `~/.claude` (symlinks followed) gets no reminder. At server start the refusal is recorded once as the startup error `stop-hook-bootstrap-refuse-home` (see [Startup errors](#startup-errors)). At a later launch it is a server-log line only.

### Personas without a `claude_config_dir`

A persona with no effective `claude_config_dir` (neither its own nor the top-level one; an empty or whitespace-only value counts as none) gets no reminder. The server logs this as a server-log line only; no startup error is recorded. To give a persona the reminder, give it a real `claude_config_dir`.

### When the guard stays silent

The guard is **fail-open by design**: when anything is missing or goes wrong, it exits `0` and the turn ends normally. Besides the cases above, it stays silent when:

- `jq` is not installed. The server records `stop-hook-bootstrap-jq-missing` at start and installs the hook anyway, so installing `jq` later is enough.
- The record could not be written before a launch. The server removes any stale record, logs one line and launches anyway.
- The transcript is missing or unreadable, or the message's opening `<channel>` tag is not in the shape the guard expects (see below).

### Tag drift — fail-open, verify after upgrades

The guard reads the `<channel …>` tag at the very start of each message that started the turn. It treats the tag as Slack's when its `source` starts with `slack`, and reads its `via` and `chat_id`. A tag quoted later in a message's text is ignored.

CSCB sends only the message content and its attributes over MCP. The **Claude Code harness itself** renders the `<channel source="…">` tag when it writes the message into the transcript; `source` is the MCP server name (`slack-channel-router`). The tag is therefore an **external, harness-owned contract**. A future Claude Code release can rename or restructure it, and the guard would silently stop reminding.

The guard also relies on the harness escaping attribute values. `via` comes after the free-form `user` attribute, so if the harness stopped escaping `>` in attribute values, a display name containing `>` would cut the tag short before `via`, and the reminder would be silently skipped.

After every CSCB or Claude Code upgrade, verify the guard end to end:

1. Send a persona that has the reminder on a Slack message that needs a reply.
2. Confirm the reply lands in Slack.
3. Inspect the persona's most recently modified transcript. It lives in `<claude_config_dir>/projects/<folder named after the persona's working_directory>/`, where `<claude_config_dir>` is the persona's effective `claude_config_dir` (a persona the guard covers always has one, and never `~/.claude`). Claude Code names that folder (`<project_folder>` below) after the absolute `working_directory`, with every character other than a letter, a digit or `-` replaced by `-`: `/home/me/projects/alpha` becomes `-home-me-projects-alpha`. Other personas sharing the config dir have their own folders, so use this one, not `projects/*`. Replace both placeholders:

   ```sh
   f=$(ls -t <claude_config_dir>/projects/<project_folder>/*.jsonl | head -n 1)
   grep -o '<channel source=\\"slack[^>]*>' "$f" | tail -n 1
   grep -n '<channel source=\\"slack' "$f" | tail -n 1 | cut -d: -f1
   grep -n '"name":"mcp__slack-channel-router__reply"' "$f" | tail -n 1 | cut -d: -f1
   ```

   The transcript stores the tag's quotes escaped (`\"`), which is why the patterns contain `\\"`. The first `grep` prints the last Slack tag, which must carry both `via` and `chat_id`. The next two print the line numbers of the last Slack tag and of the last `mcp__slack-channel-router__reply` `tool_use`. The reply's line number must be greater than the tag's; no reply line, or a smaller number, means the reply was not recorded after the message.

If the tag, `via` or `chat_id` no longer appears, the guard is dark or misreading messages — file an issue.

---

## Troubleshooting

**config.json not found**
This applies only when there is no last-applied record. `start` exits with `missing prerequisite: config.json not found at <path>, and no config.json.last-applied at <path>`. Run `bun src/postinstall.ts` from the installed package directory to create the skeleton (`{"personas": []}`), or create the file manually. Verify `SLACK_STATE_DIR` matches the directory you populated. With a record, the server starts from the record, and a missing `config.json` shows as an `INVALID` pending change (see [Reload](#reload)).

**The server won't start: last-applied record error**
`server.log` shows `[slack] Fatal: last-applied record error — The last-applied record "<path>" …`: the record can't be read or is invalid. The line ends with the fix: deleting the record makes the next start apply `config.json` as it stands. That discards the record, so check `config.json` first; whatever it holds is what runs. See [Reload](#reload).

**The server won't start: `reload-record-write-failed`**
`server.log` shows `[slack] reload-record-write-failed: cannot write the last-applied record "<path>"`: a start with no record could not write it, so nothing was applied. Check that the directory holding `config.json` is writable and not full, then start again. If the line says the record `was written but its directory could not be synced`, the record is on disk and the next start runs it.

**A fix to config.json is ignored after a failed first start**
The first start writes the record before the server opens its port. If that start failed on a setting such as `port` or `bind`, the record still holds the bad value, and later starts run it. Apply the fix as described in [When the server can't start](#when-the-server-cant-start).

The `debug-slack-channel-bots` skill (below) has the full entries for these start failures and for pending changes.

**Session connects but has no persona**
If a Claude Code session connects but immediately disconnects, `server.log` shows `Session connected with CWD "<path>" — no matching persona`: the session's working directory is no persona's `working_directory`. It is compared with each persona's `working_directory` by real path (after tilde expansion, with symlinks resolved), so a symlinked path to the same directory also matches. If a second session connects from the same directory, it replaces the first. Two personas with the same working directory (or the same credentials file) are rejected at a start with no last-applied record, and an edit that introduces them previews as `INVALID`. At a start from the record, only the personas involved fail to come up (`persona-directory-unusable`, retried, or `persona-credentials-invalid` for a shared credentials file), and the others come up.

**A persona doesn't come up or doesn't answer**
Symptoms: the persona is silent, `/interject` returns 503 for it, or its scheduled prompts log `no-session`. One broken persona never stops the server or delays the others, and nothing about it is posted to Slack. Look in `server.log` instead. Find the persona's key on its `persona-start` line, then read its lines. Each failure line names a class, the persona's `personas[i]` entry and the file or directory at fault:

```sh
grep persona-start ~/.claude/channels/slack/server.log | tail
grep -E '\(key=<key>\)|persona=<key>\b' ~/.claude/channels/slack/server.log
```

| Class | Persona | What to do |
|---|---|---|
| `persona-credentials-missing`, `-unreadable`, `-invalid` | Stays down | Fix the credentials file, then confirm the pending change; the persona comes up with no restart |
| `persona-credentials-refused` | Stays down | Put a working token in the credentials file (`claude-slack-channel-bots credentials <persona>`), then confirm the pending change; the persona comes up with no restart. If the fix was made on Slack's side and the tokens are unchanged, nothing is pending: re-save the credentials file with any byte change (a trailing newline is enough), then confirm |
| `persona-credentials-change-failed` | Keeps running on its old credentials | Fix the credentials file, then confirm the new pending change |
| `persona-slack-unreachable` | Retries on its own | Nothing; it comes up once Slack answers. If it doesn't, the line that started the episode ends with the failure's message (`message="…"`, URLs and tokens redacted), such as a DNS or connection error: check the host's network and proxy |
| `persona-directory-*` | Retries on its own | Create or fix the working directory; the persona comes up with no restart |
| `persona-config-dir-unresolvable` | Retries on its own. Its Slack connection is closed and it receives nothing; its instance and conversation are kept | Remount the drive or fix the symlink behind its `claude_config_dir`; the persona reconnects and resumes its conversation with no restart |

While a persona is down, its Claude instance keeps running and keeps its history, but the server doesn't serve it until the persona is up.

The `debug-slack-channel-bots` skill has an entry for every persona log class, every `config.json` rejection and each recovery step. It ships in the package at `skills/debug-slack-channel-bots/SKILL.md`, and postinstall links it into `~/.claude/skills/debug-slack-channel-bots`; a copied directory or file already at that path is left in place, and postinstall logs `skipped: <path> (not a link; …)` — remove it and re-run postinstall to get the link. Invoke `/debug-slack-channel-bots` from Claude Code.

**A persona doesn't receive messages in a channel or DM**
Check each of these for the persona that should receive the messages:

- Its Slack app is invited to the channel.
- The channel is in its `channels`, with the `delivery` you want. With `mentions`, only messages that @mention the persona directly and `@here` / `@channel` broadcasts arrive (see [Channel delivery](#channel-delivery)).
- The edit that added the channel is applied. Until you confirm it, it is still pending (see [Reload](#reload)).
- For DMs, `dm.enabled` is `true`. An app created from an earlier manifest needs the `im:write` scope and a re-install to start a DM (see [Direct messages](#direct-messages-dmenabled)).

If the persona is down, see "A persona doesn't come up or doesn't answer" above, or run `/debug-slack-channel-bots`.

**File attachment fails after a long wait**
Each attempt of a Slack request is limited to 30 s, and that includes uploading a file attached with `reply`. An upload that takes longer than 30 s fails on every attempt, so the tool returns an error only after about 30 minutes, once the standard retries are spent. This is not a hang: send smaller files, or split a large attachment into several smaller ones.

**Messages in a channel no persona is configured into are not delivered**
A channel that is in no persona's `channels` reaches no bot, even when a persona's Slack app is a member. Each such message logs an `unclaimed-channel` line naming the channel and the persona whose app received it in `server.log`:

```sh
grep unclaimed-channel ~/.claude/channels/slack/server.log
```

Add the channel to a persona's `channels` and apply the change (see [Reload](#reload)). Restarting the server alone doesn't apply it.

**Permission relay not working**
Check that the persona's Slack app has interactivity enabled (Interactivity & Shortcuts → toggle on). Verify the bot is in `check_permission` state via `agent-director list --state check_permission --label service=cscb` (operator CLI). Inspect `server.log` for `permission-poller:` lines — skipped-tick WARNs at 5+ consecutive skips signal that the poll interval is too tight; increase `agent_director_poll_interval_ms` in `config.json` and apply the change (see [Reload](#reload)); like every server-wide setting, it takes effect at the next server start.

**A permission prompt or notice doesn't arrive**
When Slack refuses a post to a persona's destination, the server holds the persona's prompts and notices and retries them with backoff. Once Slack accepts posts again, held notices are delivered, and a prompt is posted if its request is still open. It logs one `persona-destination-failed` line in `server.log` naming the persona, its destination and Slack's error, and one `cleared` line when posting works again:

```sh
grep persona-destination-failed ~/.claude/channels/slack/server.log
```

- `missing_scope` (the line names `im:write`): add the scope and re-install the persona's Slack app; see the `im:write` note under [Direct messages](#direct-messages-dmenabled).
- `not_in_channel`: invite the persona's app to its `permission_prompts` channel.

Up to 20 notices per persona are kept while it retries; past that the oldest is dropped. The `debug-slack-channel-bots` skill has the full entry for `persona-destination-failed`.

**Bot appears dead / posts a "blocked on a native Claude Code permission prompt" warning**
The bot is wedged in `check_permission` on a native Claude Code TUI prompt that never reached Slack (a permission decision AD recorded but could not deliver). The bot stops responding, and after ~90 s the poller posts a one-shot warning naming the persona to the persona's destination (a channel or a DM with its contact). Recover by inspecting the native prompt with `agent-director read-pane --claude-instance-id <id>`, then killing and respawning the session (`agent-director kill <id>` or tmux-kill, then let the server restart it or `claude-slack-channel-bots stop && claude-slack-channel-bots start`). Do **not** use `send-keys` — agent-director hard-rejects it while the spawn is in this relayed permission state. The warning fires once per wedge episode; the detector re-arms if the bot later wedges again.

**Session not restarting after crash**
Auto-restart backs off exponentially on repeated launch failures — the delay doubles from `session_restart_delay` (default 60s) on each consecutive failure, up to a 15-minute ceiling. After 5 consecutive failures the persona hits a cap: a `SpawnCapReached` notice naming the persona is posted to the persona's destination (a channel or a DM with its contact, per its `permission_prompts`) and automatic restarts stop. A launch that agent-director refuses is not handled by this backoff and cap: it is not counted, and the persona is retried on its own instead, even with `session_restart_delay` set to `0` (see "A persona is retried after agent-director refuses it" below).

A message sent to a persona whose instance can't take it is lost, whether it came from the persona's own channel, a shared channel or a DM: it is not delivered, saved or replayed later, and nothing else is posted where it was sent. Instead, the persona posts one lost-message notice to its destination (its `permission_prompts` channel, or its DM with its contact). That notice is the only post; it lands in the conversation the message came from only when that conversation is the destination.

The notice names the sender (by display name, or user ID; for a bot or webhook post, its name or bot ID) and the recovery state below. It never includes the message text.

- **One notice per lost message.** A persona whose instance can't take messages while its Slack connection is up (restarting, at the restart limit, or with auto-restart off) posts one notice for each message it loses in a busy `delivery: all` channel. With a `"dm"` destination, each notice is a separate DM to its contact.
- **Held notices are capped.** While the persona can't post to its destination, its notices are held and retried, up to 20 per persona; past that, the oldest is dropped (see "A permission prompt or notice doesn't arrive" above).
- **Notices reach other personas.** A notice is a Slack post like any other, so a persona with `delivery: all` in the destination channel receives it. When the instances of two personas both can't take messages and each persona receives every message in the other's destination channel, each one's notice is a lost message for the other, so they keep posting notices about each other's notices until one of their instances takes messages again. Give each persona a destination the others don't receive every message in (see [Permission prompts](#permission-prompts)).

| Recovery state in the notice | What it means | What to do |
|------------------------------|---------------|------------|
| `not up` | The persona stopped being up (broken or retrying) while the message was being handled, so no restart was started. A persona that isn't up receives no new messages, so this appears only in that short window. Its instance is launched once the persona recovers. | Fix the persona's cause (see "A persona doesn't come up or doesn't answer"), then resend once it's back. |
| `restarting` | A restart of the persona's instance was already under way. | Resend the message (or ask the sender to) once the persona is back. |
| `starting now` | The lost message triggered a fast restart (the backoff delay is clamped down to 5 seconds, never raised). | Resend in a moment, once the persona is back. |
| `auto-restart disabled` | `session_restart_delay` is `0`; the instance will not restart on its own. | Restart the server, then resend. |
| `restart limit reached` | The persona is capped; automatic restarts are suspended. | Restart the server to clear the limit, then resend. |

A `starting now` restart still counts each failed launch toward the backoff/cap, and a restart already pending or active is not stacked.

A **capped** persona (or any persona when auto-restart is disabled via `session_restart_delay: 0`) does **not** recover on an inbound message — firing another launch there would only burn a spawn attempt against a persona that cannot come up. To clear the cap and retry, restart the server with `claude-slack-channel-bots stop && claude-slack-channel-bots start`; the failure counter is in-process and cleared on restart, giving each persona a fresh attempt. To disable auto-restart entirely, set `session_restart_delay` to `0` in `config.json` and apply the change (see [Reload](#reload)); it takes effect at the next server start.

**A persona is retried after agent-director refuses it**
Symptom: a persona stays down or silent while agent-director refuses the server's calls for it (it is unreachable, or answers that it can't act right now). The server retries the persona on its own: 30 seconds after the refusal, then after 60, 120 and 240 seconds more, then every 300 seconds, whatever `session_restart_delay` and `health_check_interval` are, `0` included. Each retry reads the persona's state first, never starts a second instance over one that is running, and reconnects or relaunches it. A refusal never counts toward the restart limit, so the persona is never given up for it. A refusal posts no `Spawn failure:` notice and ends the launch or restart it met, with nothing more killed or launched in it. Once agent-director answers again, the next retry recovers the persona: in the common case there is nothing to do. After a retry relaunches the persona, the later retries only read its state, until its new session has started.

The retries stop when the persona is recovered, when it reaches the restart limit through failed launches, when it stops being up (its own bring-up retry takes over), when it is removed from the configuration, and when the server stops. To follow them for one persona:

```sh
grep -E 'unavailable-retry: persona=<key> |Session relaunch refused for persona=<key> |Session kill refused for persona=<key> |Restart retry skipped for persona=<key> ' ~/.claude/channels/slack/server.log
```

`[slack] unavailable-retry: persona=<key> armed (<cause>) — first retry in 30 s` starts them, and `[slack] unavailable-retry: persona=<key> stopped — nothing left to recover` shows the persona is back (after a relaunch, the last line says `pending-only` instead). The `debug-slack-channel-bots` skill explains the other retry lines. If the persona keeps retrying and never clears, check that agent-director responds:

```sh
agent-director version
```

If it doesn't, fix agent-director; the next retry recovers the persona with no server restart.

When the refused calls act on the persona's session itself, its destination may also get *Not answering*, *Still not answering* and *Answering again* notices (see "A persona posts a *Not answering*, *Still not answering* or *Answering again* notice" below).

**Bot alive but silently unresponsive (MCP disconnected)**
A bot can stay running yet lose its MCP connection to the server — the process is alive but no longer reachable, so it stops responding without ever emitting a disconnect event. The periodic health-check recovers this automatically: once a persona is seen alive-but-disconnected on two consecutive ticks, the health-check schedules a reconnect (or a relaunch if the process has since died), so a stranded persona comes back with no inbound message and no server restart. The recovery lands within roughly two `health_check_interval` periods (default 120 s each) plus the restart backoff delay (default `session_restart_delay` 60 s) before the reconnect runs — about 3–5 minutes with default settings. A bot mid-turn (`working` state) is deliberately left alone and reconnected on a later tick once its turn ends. agent-director can keep reporting a bot as `working` after its turn has ended. Such a bot is reconnected anyway, on a later reconnect attempt, once for at least a minute both of these have held without changing: its screen shows no busy spinner, API retry message, prompt or dialog, and its conversation transcript ends with a finished reply. Every persona's Claude runs with Claude Code's prompt suggestions off (`CLAUDE_CODE_ENABLE_PROMPT_SUGGESTION=false`), which removes a likely cause of such a stale `working` state, so a session you attach to shows no suggested prompt. The health check's reconnect never types into a bot whose screen shows a running turn or a prompt, whatever state agent-director reports, and types nothing while agent-director can't report the bot's state; a later tick retries. A bot waiting on a prompt or dialog is reported instead (see "A persona posts a *Waiting on a prompt*, *Not connected* or *Not receiving messages* notice" below). So is a bot agent-director reports as `working` that the server has held back from for 10 minutes without being able to tell that it's idle, whatever `session_restart_delay` is: the persona's destination gets a *Not connected* notice. With `session_restart_delay` set to `0` the health check reconnects nothing; the persona's destination gets a *Not connected* notice instead. A bot killed mid-turn or with a prompt open (its tmux session is gone) is not waited on: the restart that finds its session gone relaunches it at once, with no external `find-missing` sweep needed, and a server start resumes it.

A closely related symptom is a bot that still *looks* connected but silently drops every inbound message — its underlying message stream went away without the connection registering as closed. The same health-check path recovers this on the same two-consecutive-tick cadence, so no inbound message or server restart is needed; with `session_restart_delay` set to `0` the persona's destination gets a *Not receiving messages* notice instead. A message for such a persona that arrives before recovery lands is lost, and the persona's destination gets a lost-message notice as described under "Session not restarting after crash" above.

To verify recovery in the field, tail `server.log` for a stranded persona and confirm a tick-driven recovery lands — look for a `[slack] Scheduling restart for persona=<key> in <N>s (backoff)` line and a `[slack] Session alive but disconnected — reconnecting MCP for persona=<key>` line naming that persona's key. When the bot is mid-turn, with its busy spinner or an API retry message on screen, that line is followed by `[slack] reconnectSession: persona=<key> is working — deferring /mcp reconnect to a later tick (b.9a7/b.rmy)`, and a later tick reconnects it. A bot reported `working` whose screen sits idle and whose transcript ends with a finished reply logs `[slack] reconnectSession: persona=<key> is working; its pane shows an idle screen (no busy indicator, no prompt) and its transcript ends with a completed turn, both unchanged for <N>s of the 60s needed — deferring /mcp reconnect to a later tick, which reads them again (b.f2b)` instead, and then, once both have stayed the same for a minute, `[slack] reconnectSession: persona=<key> reads working, but its pane has shown the same idle screen (no busy indicator, no prompt) and its transcript has ended with a completed turn, both unchanged, for <N>s — treating the row as stale and reconnecting (b.f2b)`. An idle screen whose transcript doesn't end with a finished reply, or can't be read, logs `[slack] reconnectSession: persona=<key> is working and its pane shows an idle screen, but <why> — no idle evidence; deferring /mcp reconnect to a later tick (b.f2b/b.rmy)` and is not reconnected. A bot killed mid-turn logs `[slack] reconnectSession: persona=<key> is working but its tmux session "slack_bot_<key>" is gone — not deferring; reconciling so the restart relaunches it (b.d61)` instead, then `[slack] Session reads dead after escalate-dead reconciliation — relaunching in this restart run for persona=<key> (b.d61)` and `[slack] Relaunching session for persona=<key> cwd="<path>"` right after. A **capped** persona is exempt: the health-check skips it entirely, including reconnects, so a capped persona still requires a server restart (see above).

At a server start, a persona whose instance agent-director reports as `working` is reconnected once its turn ends, and it doesn't hold up the other personas or the health check. `server.log` shows `[slack] startupSessionManager: "<name>" (key=<key>) is waiting for its working row to settle — the start pass goes on without it; its launch stays in flight in the background (b.f2b)`, then, when the wait ends, `[slack] startupSessionManager: background launch for "<name>" (key=<key>) settled: <outcome> (b.f2b)`. `reconnected` means the reconnect was typed into the session; `not-reconnected` means the session was left running without it, and the line just before says what happens next. An idle screen and a transcript ending with a finished reply (or with a turn you interrupted), both unchanged for a minute, end the wait with a reconnect, and a prompt or dialog on screen for a minute raises a *Waiting on a prompt* notice. Otherwise the wait gives up after 10 minutes; if agent-director still reports the persona as `working` then, its destination gets a *Not connected* notice. Removing the persona with a confirmed change ends its wait at once, with nothing typed.

**A persona posts a *Waiting on a prompt*, *Not connected* or *Not receiving messages* notice**
Each of these notices means the persona's session is running but messages can't reach it, so messages sent to it are lost. At most one of them is posted to the persona's destination per episode: after one is posted, none is posted again until the persona's session connects to the server again or the health check finds it reachable again. `server.log` shows `[slack] session-manager: persona=<key> is not connected (<reason>) — raising a not-connected notice (b.f2b)` when it is posted. The `=` in the attach commands below and in the notices attaches to that exact session only, never to another persona's session whose name starts with it.

- *Waiting on a prompt* (`blocked-on-prompt`): the session shows a permission prompt, question or dialog that no one has answered. The server never types into a prompt. It posts this notice only while the persona's tmux session is still there. A session that died with a prompt open, which agent-director keeps reporting as waiting on the prompt, is relaunched instead, with no notice; `server.log` shows `… but its tmux session "slack_bot_<key>" is gone — no prompt is waiting in it; …`. Once the prompt has kept the persona disconnected for 10 minutes, each later health-check retry also has agent-director check that its Claude process still runs, and relaunches the persona if it doesn't. Attach with `tmux attach -t =slack_bot_<key>` and answer it; a permission prompt that was also posted to the persona's destination can be answered there instead. Once it is answered, the server reconnects the persona when it can tell the session is idle again; if it stays disconnected, type `/mcp reconnect slack-channel-router` there. With `session_restart_delay` set to `0`, if it is still not connected once its turn ends, type that command there or restart the server.
- *Not connected* (`auto-restart-disabled`): `session_restart_delay` is `0`, so nothing will reconnect the persona. The notice says why it isn't connected. Attach with `tmux attach -t =slack_bot_<key>`, deal with anything on screen and type `/mcp reconnect slack-channel-router`, or restart the server.
- *Not connected* (`unproven-idle`), at any `session_restart_delay`: agent-director reports the session as `working`, but the server can't prove it's idle, so it won't type into it, and it has held back from it for 10 minutes. For example, its transcript can't be read, or its screen keeps changing. Attach with `tmux attach -t =slack_bot_<key>`: let a running turn finish and answer anything on screen; if it sits idle at its prompt, type `/mcp reconnect slack-channel-router` there. With `session_restart_delay` above `0` the server keeps checking and reconnects it once it can tell it's idle; with `0`, restart the server if it stays disconnected.
- *Not receiving messages* (`auto-restart-disabled`): the session is connected, but its message stream has been gone on two health checks in a row, and `session_restart_delay` is `0`, so nothing will restore it. Recover it as for *Not connected*.

**A persona posts a *Not answering*, *Still not answering* or *Answering again* notice**
These notices mean agent-director or tmux is not answering for the persona's session (named in the notice as `"slack_bot_<key>"`): agent-director refused a call that starts, resumes or stops the persona's instance, reads its screen or types into it, while the server was launching or recovering the persona. They are about that one persona, not an agent-director outage. A failed call that only reads the persona's state never produces them.

- *Not answering*: posted only if the session is still not answering at the next health check after the first refusal; a single short refusal that clears by then posts nothing. With `health_check_interval` set to `0`, it is posted at the first retry at least 2 minutes after the refusal began. Nothing is needed at this point: the server keeps retrying the persona on its own (see "A persona is retried after agent-director refuses it" above), never counts it toward the restart limit and takes no destructive action. It is skipped when *Still not answering* has already been posted for the episode.
- *Still not answering*: posted once the session has not answered for longer than the alert threshold, which comes from agent-director's timing settings in effect: the longer of `stopping_window_seconds` and `starting_session_seconds`, plus 60 seconds (about 6 minutes at agent-director's defaults; see [agent-director's timing settings](#agent-directors-timing-settings)). The notice states the threshold in whole minutes. The retries continue. It is posted only while the server is retrying the persona: if its retries stop first, it is not posted, unless a later refusal starts them again in the same episode.
- *Answering again*: posted when the persona reaches its session again, only after a *Not answering* or a *Still not answering*.

The usual order is *Not answering*, *Still not answering*, *Answering again*; when *Still not answering* comes first (for example with `health_check_interval` `0` and a 3-minute alert threshold), *Not answering* is skipped. Each is posted at most once per episode, from the first refusal until the session answers again; a later refusal starts a new episode. After *Still not answering*, a human should check the host's tmux server and agent-director, with read-only checks only, for example `agent-director version`, `agent-director get --claude-instance-id cscb_<key>` and `timeout 10 tmux list-sessions`. Run `tmux list-sessions` as the user the workers run as, with their tmux socket, since another user or socket asks a different tmux server; it shows only whether tmux answers, never whose a session is, so take ownership from agent-director's row, never from this list. Never run a command that ends a session or deletes an agent-director row to clear it: once agent-director and tmux answer, the next retry recovers the persona and *Answering again* follows. To follow one persona's episode:

```sh
grep -E 'persona-episodes: persona=<key> tmux-unresponsive (started|onset|alert|ended|recovery)' ~/.claude/channels/slack/server.log
```

`[slack] persona-episodes: persona=<key> tmux-unresponsive started — <verb> failed: <error>` marks the first refusal, `… onset posted — still not answering at <a health tick|a retry>, <s> s after its first refusal` the *Not answering* notice, `… alert posted — not answering for <s> s, over its alert threshold of <s> s` the *Still not answering* notice, `… onset not posted — its alert already posted` a skipped *Not answering*, `… alert check cancelled — its retry timer stopped: <reason>` and `… alert check armed again — a new refusal armed its retry timer again` the alert's check stopping and starting with the retries, and `… ended — <reason>` followed by `… recovery posted` the *Answering again* notice. The `debug-slack-channel-bots` skill explains every line.

**Session stuck during clean_restart**
If a session does not exit within `exit_timeout` seconds (default 120s), `clean_restart` force-kills the spawn via `agent-director kill` and proceeds. To manually recover, run `agent-director list --label service=cscb` to find lingering spawns and `agent-director kill <claude_instance_id>` to clear them, then `claude-slack-channel-bots stop && claude-slack-channel-bots start`.

**`clean_restart` or `stop --stop-bots` exits non-zero with an agent-director teardown error**
This is intentional: when agent-director is unreachable, the teardown cannot run, so the command fails loudly rather than silently no-op'ing and (for `clean_restart`) restarting on top of bots it never touched. Confirm agent-director is installed and responsive with `agent-director version`, then re-run the command. Teardown kills but never deletes rows on any failure path, so it is always safe to retry once agent-director is reachable.

**Bots come back with no memory of the prior conversation after a reboot**
With `resume_enabled: true`, a bot whose host rebooted (or pod resumed) should return with its conversation history. If it comes back amnesiac, confirm the system-installed `agent-director` is **≥ 0.8.0** (`agent-director version`) — reboot recovery relies on capabilities added in that release. Note that `bun run install-check` does **not** confirm this: its client floor is `0.7.0`, lower than the reboot-recovery requirement, so install-check passes on a `0.7.x` binary that still yields amnesiac bots. Verify the resume requirement directly with `agent-director version`. Note: legacy sessions created before upgrading to 0.8.0 may lose history exactly once on their first post-upgrade recovery, then resume cleanly thereafter.

A bot also starts fresh, by design, when its session no longer matches the applied configuration. A config edit takes effect only once it is applied (see [Reload](#reload)); a restart or reboot alone runs the last-applied record. When a change to a persona's `working_directory` is applied, the persona is torn down and brought up fresh at once. When a change to a persona's effective `claude_config_dir` (its own or the top-level default) is applied, the bot starts fresh the next time it would be resumed: after `clean_restart`, after `stop --stop-bots` then `start`, after a reboot, or when the bot dies. A bot that keeps running across a plain `stop` and `start` keeps its old config directory until then. The old transcript stays in the old config directory. After upgrading from an earlier release, each bot also starts fresh once: a bot instance from before the upgrade is never resumed (see [Upgrading to personas](#upgrading-to-personas)). The log names the reason: search `server.log` for `sweeping row`, `pre-persona row`, `replacing the row` or `not resuming; spawning fresh`.

**Session crashes on resume with "sandbox required but unavailable"**
This is a known regression in certain Claude Code releases (e.g. v2.1.120) where `--resume` triggers a sandbox check that fails in headless environments. Set `resume_enabled: false` in `config.json`, apply the change and restart the server (server-wide settings take effect at the next start; see [Reload](#reload)) to disable `--resume` entirely — the bot will always start a fresh Claude session instead of resuming a prior conversation, both on startup and on runtime auto-restart:

```json
{
  "personas": [ ... ],
  "resume_enabled": false
}
```

---

## Server log rotation

The server daemon writes runtime output to `~/.claude/channels/slack/server.log` (and `clean_restart.log` for the `clean_restart` subcommand). Rotation is built into CSCB, so it applies on every machine with no per-host logrotate config: when the active file crosses `CSCB_LOG_MAX_BYTES` it is rolled to `server.log.1`, the previous `.1` → `.2`, and so on up to `CSCB_LOG_KEEP` generations; the oldest is discarded. Rotated generations are not compressed. See the environment-variable table above for the size, retention, and verbosity settings that tune this behavior.

Note this covers only `server.log` / `clean_restart.log`. `startup-errors.log` and `permission-trail.jsonl` are separate append-only files with their own retention (see below).

---

## Startup errors

CSCB writes startup errors to `~/.claude/channels/slack/startup-errors.log` (override the directory with `SLACK_STATE_DIR`) in addition to stderr. Each entry is a single timestamped line. The file is append-only and never rotated by CSCB — copy `docs/logrotate-startup-errors.conf` into `/etc/logrotate.d/` if you want host-level rotation.

The classes in the first list are fatal: the process exits non-zero. Two of them can also be written while the server runs (see "Found while the server was running" after the list). The later groups (Slack Reply Guard setup, persona launch and conversation memory) are non-fatal: they are recorded, and the start continues.

Fatal classes you may see:

- `ad-system-install-not-found` — `Client.create()` could not locate an `agent-director` binary on PATH or at the standard install path. Install agent-director system-wide and retry. The log line appends a manual-skill-install instructions block pointing at `skills/install-cscb/SKILL.md` (URL, target path under `~/.claude/skills/`, and invocation command `/install-cscb`) for the interactive install flow.
- `ad-system-install-too-old` — the system-installed agent-director binary is below the agent-director client's own minimum (declared in `dist/version-floor.json`). The log line names the version found, the version the client requires, that this CSCB release needs CSCB's Phase 1 floor or later (release candidates included), and the binary path, says this CSCB release and agent-director Phase 1 are installed together, and names the README section "Switching over to agent-director Phase 1" as the way to install agent-director. It appends the manual-skill-install instructions block; for this class the skill names the same section and runs nothing.
- `ad-below-phase1-floor` — the binary passed the client's own minimum but is below CSCB's Phase 1 floor: the Phase 1 agent-director release or later is required, its release candidates included (the development placeholder `0.0.0-dev` is below it). The log line names the version found, the version required, the binary path and that the startup check found it. Nothing is launched and nothing is posted to Slack. Follow the README section "Switching over to agent-director Phase 1", then start the server again. The line appends no skill block.
- `ad-system-install-unreachable` — agent-director was discovered but the probe could not execute it (e.g. permission bits, broken symlink, runtime crash). The log line surfaces AD's supplied `err.reason` value verbatim (one of `not-executable`, `not-a-regular-file`, `probe-timeout`, `probe-nonzero-exit`, `probe-killed-by-signal`, `unparseable-version`, `spawn-failed`, `other`) and appends the manual-skill-install instructions block.
- `ad-bun-version-too-old` — agent-director needs Bun `>= 1.0.21`. Upgrade Bun.
- `ad-client-construct` — `Client.create()` failed with an error other than the `ad-system-install-*` ones; the line gives its detail. Check the install with the `install-cscb` skill, then retry.
- `ad-shim-missing-get-permission` — the installed `agent-director` TS shim's `Client` does not expose `getPermission`. The npm-published package is out of sync with the system-installed binary. Reinstall a matching `agent-director` version and confirm the resolved package actually ships the method.
- `ad-shim-catalog-incomplete` — the installed `agent-director` TS error catalog is missing one or more of `ErrInvalidFlags`, `ErrPermissionRequestNotFound`, `ErrAmbiguousRequest`, `ErrTmuxKillFailed`, `ErrTmuxUnresponsive`, `ErrTmuxSessionConflict`. The log line lists the missing names. Same remediation as `ad-shim-missing-get-permission`.
- `ad-shim-decide-drops-token` — the installed `agent-director` dist does not include `--request-token` in its bundled JS, meaning `buildDecide()` would resolve permission clicks against the wrong row. Reinstall a matching `agent-director` version and confirm `buildDecide` carries the flag.
- `ad-version-floor-unreadable` — `node_modules/agent-director/dist/version-floor.json` could not be read or parsed, or its `.min_binary_version` is missing or is not a version. This is a packaging defect — reinstall `agent-director` from npm. Surfaced by `bun run install-check`; the startup gate itself does not emit this label (it relies on `Client.create()`, which fails differently when the AD package is corrupt).
- `ad-same-user` — `~/.agent-director/state.db` is owned by a different UID than the CSCB process. Reinstall agent-director as the correct user or remove the mismatched file.
- `ad-same-user-stat` — Non-ENOENT stat error on the state DB (permissions, I/O). Investigate the file before re-launching.
- `ad-template-install` — `client.makeTemplate(...)` rejected the boot-time refresh of the `slack-channel-bot` template. The line names the template and includes agent-director's error name and its description.

**Found while the server was running.** `ad-system-install-too-old` and `ad-below-phase1-floor` can also be written by the runtime re-check: while the server runs, it re-checks the agent-director binary every 120 s, whatever `health_check_interval` is (`0` included), and stops with a non-zero exit when the binary fails either check. The entry names the version found, the version required, the binary path and that it was found by a runtime re-check while the server was running, so the server stopped. The stop posts nothing to Slack and leaves every bot and its agent-director row as it was: the bots keep running, but nothing serves them. Follow the README section "Switching over to agent-director Phase 1", then start the server again.

The following classes are **non-fatal**: the Slack Reply Guard's setup pass at server start (see [Slack Reply Guard (Stop hook)](#slack-reply-guard-stop-hook)). The guard stays fail-open, so an affected persona gets no reminder, and every other persona and the rest of the start are unaffected. Directory and file failures at a later launch are server-log lines only, never records here.

- `stop-hook-bootstrap-refuse-home` — a persona's effective `claude_config_dir` resolves to `~/.claude`, which the server never writes. Recorded once per server start; the line names the directory and the personas. Give those personas their own `claude_config_dir` if they should get the reminder.
- `stop-hook-bootstrap-jq-missing` — `jq` is not on `PATH`. The hook is installed anyway; it stays silent until `jq` is installed, with no restart needed.
- `stop-hook-bootstrap-dir-missing` — a `claude_config_dir` that should get the hook doesn't exist, so it is skipped. Create the directory (for example with `claude auth login`, see [Next-launch settings](#next-launch-settings)); the persona's next launch installs the hook.
- `stop-hook-bootstrap-not-a-dir` — a `claude_config_dir` exists but isn't a directory, so it is skipped. Fix the path.
- `stop-hook-bootstrap-settings-read` — `<claude_config_dir>/settings.json` exists but can't be read (for example, permissions). The file is left untouched.
- `stop-hook-bootstrap-settings-parse` — `settings.json` isn't valid JSON. The file is left untouched; fix its syntax.
- `stop-hook-bootstrap-settings-shape` — the top level of `settings.json` isn't a JSON object. The file is left untouched.
- `stop-hook-bootstrap-init` — the server couldn't resolve the path of its own `slack-reply-guard.sh`, so no directory is processed. Reinstall the package.
- `stop-hook-bootstrap-dir` — an unexpected error while processing one directory; the line names the directory and the personas. Other directories are still processed.
- `stop-hook-bootstrap` — an unexpected error in the setup pass itself. Report it as a bug.

The following classes are **non-fatal** failures while preparing or launching personas at server start. A line for a failed agent-director call ends with agent-director's error name and, when it gives one, its description as `message="…"`, on one line, with token-like text redacted and long text cut short. At a later launch, the same failures are `server.log` lines only.

- `ad-same-user-unenforced` — the platform gives no process user ID, so the check that `~/.agent-director/state.db` belongs to the CSCB user is skipped. Run CSCB on a supported platform (see [Supported platforms](#supported-platforms-inherited-from-agent-director)).
- `trust-bootstrap-config-missing` — a persona's `<claude_config_dir>/.claude.json` can't be read, so its workspace trust isn't pre-accepted. Log the directory in (see [Next-launch settings](#next-launch-settings)).
- `trust-bootstrap-config-parse` — that `.claude.json` isn't valid JSON, so it is left untouched. Fix its syntax.
- `trust-bootstrap` — an unexpected error while pre-accepting a persona's workspace trust, such as a failed write of `.claude.json`; the line names the persona and its working directory. Check that the file is writable.
- `spawn-failed` — launching, resuming or reconnecting a persona's instance failed; the line names the persona and the step. The server keeps running; see "Session not restarting after crash" in [Troubleshooting](#troubleshooting) for how restarts are retried. No `spawn-failed` entry is written when agent-director refuses the call or can't read the persona's state (it is unreachable, or answers that it can't act right now): such a refusal is not a failure, and the server retries the persona on its own. See "A persona is retried after agent-director refuses it" and "A persona posts a *Not answering*, *Still not answering* or *Answering again* notice" in [Troubleshooting](#troubleshooting).
- `dev-channels-approve-spawn-died` — a persona's instance ended before its startup dialog was cleared. Restarts are retried as for `spawn-failed`.
- `dev-channels-approve-not-ready` — a persona's instance didn't become ready in time: its startup dialog wasn't recognised or the session hung. A `Spawn failure:` notice is also posted to the persona's destination. Inspect the instance with `agent-director read-pane --claude-instance-id <id>`.
- `spawn-failure-post` — posting a `Spawn failure:` notice to a persona's destination failed. The notice is held and retried; see "A permission prompt or notice doesn't arrive" in [Troubleshooting](#troubleshooting).
- `orphan-cleanup-list-failed` — the server couldn't list its agent-director instances to remove stale ones (see "Bots come back with no memory" in [Troubleshooting](#troubleshooting)). Nothing is removed at this start.
- `orphan-cleanup` — killing or deleting one such instance failed; the line names the instance and the persona label it carries. A `kill failed for pre-persona row` line names a bot instance from before the upgrade to personas: its row is kept, and its session may still be running. Check with `tmux ls` as in [First start on a host with running bots](#first-start-on-a-host-with-running-bots).

The following classes are **non-fatal warnings** about conversation-memory loss. They are recorded to the same log but never exit the process or block startup. The first four are written by the JSONL-persistence safeguard, which runs *before* the resume path to warn about an *impending* loss; the last two (`jsonl-transcript-lost-on-resume`, `jsonl-diagnosis-inconclusive`) are written *by the resume path itself* when it tried to resume a row and either confirmed a wipe or could not determine whether one occurred. Those two lines end with agent-director's error name and `message="…"`, as above:

- `jsonl-non-persistent` — a session-transcript storage root (`<claude_config_dir>/projects`) is on a `tmpfs`/`ramfs` mount, so nothing there survives a reboot and session resume is structurally impossible on this host. A warning is also posted to the destination of each affected persona — those whose transcript storage root is the flagged mount, not every persona. Move the config dir to a persistent filesystem.
- `jsonl-persistence-check-warning` — the safeguard could not determine the filesystem type of a transcript storage root (unreadable/unparseable `/proc/self/mountinfo`, or an unresolvable path), so persistence is unverified. No Slack post is made. Investigate the mount before relying on resume.
- `jsonl-transcript-stale-path` — a persona's saved transcript exists on disk at the resolved fallback path, but agent-director's recorded `jsonl_path` points elsewhere (missing/empty). On the next restart the resume path would treat it as missing and wipe the persona's memory. A warning is posted to the persona's destination; an operator should reconcile the path before restarting.
- `jsonl-transcript-lost` — a persona's transcript is gone from disk (neither the recorded nor the fallback path exists), yet the message archive shows messages in the persona's `delivery: all` channels since the bot spawned. Only those channels are counted. Conversation history has been lost and resume will start the bot fresh. A warning is posted to the persona's destination. Requires `message_archive_db` to be configured for the archive evidence. When the archive shows nothing, the safeguard logs a quiet line only: no transcript is expected for a persona idle since spawn, and for a persona with a `delivery: mentions` channel or DMs on a zero count proves nothing. A row the server will replace rather than resume (its working directory or config directory changed) is not checked.
- `jsonl-transcript-lost-on-resume` — resume actually threw `ErrJsonlMissing` for a persona, the bot was delete+fresh-spawned, and the message archive shows messages in the persona's `delivery: all` channels since it spawned — so conversation history was destroyed by this recovery, not merely at risk. Only those channels are counted. A warning is also posted to the persona's destination. This is the resume path's own after-the-fact report (distinct from the pre-resume `jsonl-transcript-lost` warning above); the log line names every transcript path tried and whether each came from agent-director or was computed locally. A missing transcript on a persona that was *idle since spawn* — the archive was consulted and shows zero messages since spawn, and every one of the persona's channels is `delivery: all` with DMs off — is expected (the transcript is created lazily on first message) and produces a quiet log line only, no error class and no Slack post. Requires `message_archive_db` for the archive evidence; when the archive cannot be consulted the case is instead reported as `jsonl-diagnosis-inconclusive` below.
- `jsonl-diagnosis-inconclusive` — resume threw `ErrJsonlMissing` and the bot was delete+fresh-spawned, but the diagnosis could not determine whether conversation history was lost: the agent-director row was already gone or its fetch got a configuration or unusable-name answer, `started_at` was unparseable, the message archive could not be read, `message_archive_db` is not configured at all, or the archive shows zero messages but the persona has a `delivery: mentions` channel or DMs on, so a zero count cannot show it was idle (the archive cannot attribute messages from `mentions` channels or DMs to a persona). Because "inconclusive" correlates with the same storage problems that cause real loss, this is surfaced (not silently downgraded to a benign never-created): the line records *why* the diagnosis failed, and a warning is posted to the persona's destination worded as uncertainty ("on restart I was started fresh; I could not determine whether my prior conversation history was preserved") rather than as a confirmed loss. When the reason is an unconfigured archive, the message notes that diagnosis is impossible without `message_archive_db` and suggests enabling it. These personas are counted separately in the startup summary as `fresh-after-inconclusive-amnesia` (distinct from the `fresh-after-amnesia` count). When agent-director can't answer that row fetch at all (it is unavailable, or any other error), nothing is diagnosed: no entry is recorded, no warning is posted, the bot is not deleted or spawned, and the launch is retried later like any other refused launch.

---

## Release process

CSCB releases are cut with the `/publish` skill from a clean checkout of `main` on a dev box that has `npm login` against the publishing account. The skill bumps the version, packs and smoke-tests the release tarball, commits and tags the release, pushes to GitHub, publishes to npm, polls the registry until the new version is visible, reinstalls the just-published version on the dev box, and prints a final summary.

### Invocation

```
/publish <patch|minor|major>
```

The bump kind is **required** — there is no default. The skill exits with a usage line if the argument is missing or not one of `patch`, `minor`, `major`.

### Preflight gates

Before any side-effecting step runs, `/publish` enforces seven fail-fast gates. Any failure aborts before the version is bumped, the tarball is packed, or anything is committed:

1. **Clean working tree on `main` in sync with origin/main.** No uncommitted changes; HEAD branch is `main`; `main` is exactly equal to `origin/main` after `git fetch origin`.
2. **Tests exist and pass.** At least one `*.test.ts` file under `tests/` and `bun test` exits zero.
3. **Typecheck passes.** `bun run typecheck` exits zero.
4. **npm authenticated.** `npm whoami` exits zero (run `npm login` first if not).
5. **Next version not already published.** `npm view claude-slack-channel-bots@<next-version> version` must report nothing.
6. **No stranded finished work.** `scripts/audit-finished-tickets.sh` must exit zero. It flags any `finished` ticket whose fix is neither on `main` nor explicitly closed — closure means either a stated reason (no-repro / won't-fix / not-a-bug / by design / works as intended / superseded / abandoned / satisfied by other work) or one of the anchored headings `## +closed:out-of-repo <path>` (fix landed outside this repo; the path names the artifact) and `## +closed:docs-only` (product lives outside any git repo) — any unmerged branch tied to a finished ticket, and any unmerged branch that references no known ticket at all. A release cannot ship while a fix is silently stranded on a dead branch. The gate is read-only — it never mutates tickets or git. This gate runs in Phase 1 preflight, **before** the `/ci` gate below, so a stranded-work failure aborts the release before the Docker suite ever runs. The gate splits its failure by the audit's exit code: audit exit 1 (stranded work) → preflight exit 16; audit exit 2 (setup failure — the Bugs/Plans/Ideas hives, a git repo, or a `main` ref were not locatable from this checkout, e.g. a throwaway `/tmp` clone) → preflight exit 17, whose fix is to rerun `/publish` from the canonical checkout that sits beside the hives. **This gate is green today — it exits zero with no findings.** There is no known expected debt in either class, so a non-zero result is a new, real finding to investigate before releasing. Do not re-list findings here — the audit's own output is the inventory.
7. **`/ci` integration suite passes.** The full Docker-based integration test suite is run via the `/ci` skill and must report PASS. **`/ci` is mandatory and has no opt-out flag** — release without an unbroken integration run is not possible through this skill.

### What happens during a release

After all gates pass, the skill, in this order:

1. Bumps `package.json` and `bun.lock` to `<next-version>` (no commit, no tag yet).
2. Packs the release tarball with `bun pm pack` and verifies its internal version matches.
3. Scratch-installs the tarball into a temp `BUN_INSTALL` and runs the bin smoke check (non-zero exit + `Usage:` in stderr). Any failure here rolls back the working tree and aborts — no commit, no push, no publish.
4. Creates the `Release v<version>` commit and the annotated `v<version>` tag locally.
5. Pushes the release commit to `origin/main`.
6. Publishes the smoke-tested tarball with `npm publish <tarball-path>` (the smoke-tested artifact bytes — not a repack from CWD).
7. Pushes the `v<version>` tag to `origin`, bringing GitHub and npm into agreement.
8. Polls the npm registry every 5 seconds for up to 10 minutes until the new version is visible, printing a progress line every ~30 seconds. npm propagation commonly takes a few minutes, so a multi-minute wait here is normal.
9. Sanitizes the bun-1.3.13 empty-string-dependency-key poison from the global `package.json` (see [Installing from a local worktree](#installing-from-a-local-worktree)), removes any pre-existing global install, then runs `bun install -g claude-slack-channel-bots@<version>` — the exact command an end user would run — and verifies the installed bin resolves under `~/.bun/install/global/` at the published version. If the `claude-slack-channel-bots` on PATH resolves somewhere else (an install in another bun prefix shadowing this one), the diagnostic names the shadowing path, the symlink chain, and the manual fix.
10. Trusts the package if the global manifest does not already (`bun pm -g trust`) and checks that the postinstall's `~/.claude/channels/slack/config.json` (under `SLACK_STATE_DIR` when it is set) and `~/.claude/slack-mcp.json` exist — a missing file is a warning, not a release failure.
11. Prints a success summary identifying the published version, npm URL, GitHub release tag URL, resolved local install path, and the next-operator-action command.

### After the skill exits

The dev box now has the freshly-published version installed globally as a real copy, but the running CSCB daemon is still on the prior version. Swap the daemon over:

```sh
claude-slack-channel-bots clean_restart
```

This gracefully exits the managed Claude Code sessions, stops and restarts the server on the new binary, and brings each session back up. See [`clean_restart`](#claude-slack-channel-bots-clean_restart) above for full behavior.

---

## Migration

For operators upgrading from a pre-`agent-director` install:

1. **Install the new CSCB**: `bun remove claude-director` (if present) and `bun install -g claude-slack-channel-bots@^<new>`. The `agent-director` library is pulled in transitively — no separate install step.
2. **Delete any old relay hooks** — see [Upgrading from pre-Epic-2 (v0.5.x → v0.6.x)](#upgrading-from-pre-epic-2-v05x--v06x) for the cleanup commands.
3. **(Optional) Configure an agent-director `find-missing` sweep**. CSCB itself runs `find-missing` once before a resume during dead-session recovery, so a bot that died on reboot comes back with its history intact. If agent-director doesn't answer that sweep (it times out or reports tmux not answering), CSCB stops the recovery there, with no resume and no fresh session, and retries it later. A standalone periodic sweep is no longer required for CSCB recovery, but remains useful if you want stuck rows from non-CSCB spawns reconciled on a cadence. To add one, use a cron entry (or systemd timer):
   ```cron
   * * * * * /usr/local/bin/agent-director find-missing --timeout 30s
   ```
4. **Install the startup-errors logrotate snippet** so `~/.claude/channels/slack/startup-errors.log` doesn't grow unboundedly. Edit `USER` in the file to match the OS account running CSCB:
   ```sh
   sudo cp docs/logrotate-startup-errors.conf /etc/logrotate.d/claude-slack-channel-bots
   ```
5. **Rename your config field**. Pre-Epic-2 configs used `claude_director_poll_interval_ms`; CSCB now expects `agent_director_poll_interval_ms` and rejects the old name (no silent alias). Edit `~/.claude/channels/slack/config.json` accordingly. Unknown top-level fields are also rejected — clear any other deprecated keys.
6. **Optional cleanup**: `~/.claude/channels/slack/sessions.json` and `sessions.json.last` are no longer read or written. CSCB ignores them; you can safely `rm` them after a successful boot.
7. **`tmux` is no longer a CSCB-direct prereq** but is still required transitively via agent-director — keep it installed.

After step 1, every CSCB bot is spawned through `client.spawn(...)` with `relay_mode='on'`. The green/red Slack button UX is byte-identical to the pre-migration behavior; the action_id shape changes from `perm_(allow|deny)_<uuid>` to `perm_(allow|deny)_cscb_<key>_<request_token>` (where `<key>` is the persona key and `<request_token>` is a UUIDv4 minted by agent-director) but this is invisible to end users.

### Upgrading to personas

This major version accepts only the persona configuration format. When you upgrade from an earlier major version, take these steps in order:

1. **Stop the old bots first.** Before you install this version or change `config.json`, stop the earlier version with its bots and check that none is left: follow steps 1–3 of [First start on a host with running bots](#first-start-on-a-host-with-running-bots) below. Then install this version.
2. **Rewrite `config.json` by hand.** A configuration from an earlier major version stops the server at start, with an error that names the offending setting and says the configuration must be converted to personas. Nothing is converted automatically and the file is not changed. Write a `personas` list as described in [Personas (config.json)](#personas-configjson); the server-wide settings keep their names. The `debug-slack-channel-bots` skill covers this error under "Pre-persona configuration".
3. **Pick persona names whose keys don't start with one another.** The configuration check rejects such a pair. If your bots were named `horde`, `horde_admin`, …, don't name a persona `horde` beside `horde_admin`: give the shorter name a suffix, such as `horde_main` (see [Persona name and key](#persona-name-and-key)).
4. **Set the reply settings in `config.json`.** Nothing else carries an acknowledgement reaction over: to keep one, set `ack_reaction` as a top-level setting. If you had changed how replies are split, set `reply_chunk_limit` and `reply_chunk_mode` there too. See [Server-wide settings](#server-wide-settings).
5. **Move the tokens into credentials files.** Tokens come only from each persona's credentials file. Create one [credentials file](#credentials-files) per persona, then remove any token environment variables you exported for the previous version.
6. **Give each persona its own Slack app.** Your existing app can serve one persona; create another app for each additional persona. Re-install the existing app from the current `slack-app-manifest.yml` so it gains the `im:write` scope; the `debug-slack-channel-bots` skill has the steps under "A persona can't open a DM".
7. **Decide who can reach each persona.** Who can reach a persona is decided only by its `channels`, each channel's `delivery` and its `dm.enabled` switch (see [Channel delivery](#channel-delivery) and [Direct messages](#direct-messages-dmenabled)).
8. **Rewrite crontable lines to name personas.** A crontable target that names a channel matches no persona, and the line is logged `unknown-persona` each time it fires. Rewrite each target as a persona's name or key (see [Scheduled Prompts](#scheduled-prompts-cscb_cron)).
9. **Update `/interject` callers to send `persona`.** A request without `persona` is refused with 400, and a successful response holds only `ok` and `persona`. Change every script that calls `/interject`, including host crontab `curl` lines, to name a persona by name or key (see [Interject](#interject)).
10. **Start this version** with `claude-slack-channel-bots start`. The first start has no last-applied record yet, so it checks `config.json`, records it and applies it. After that, edits wait until you apply them; see [Reload](#reload).
11. **Expect each bot to start fresh once.** Bot instances created before this version are never resumed, so each persona starts once without its prior conversation. Their agent-director rows are kept, never deleted: no persona reuses their instance IDs. If one is still running at the first start, the start kills it and logs `pre-persona row` in `server.log`.

#### First start on a host with running bots

Stop the earlier version's bots, and check that none is left, before this version starts for the first time. Its start kills an old bot that is still running, but agent-director can report that kill as done while the bot's tmux session keeps running, and nothing would find that bot afterwards.

1. **Stop the earlier version with its bots**, before you install this version or rewrite `config.json` (this command reads the configuration the earlier version runs):
   ```sh
   claude-slack-channel-bots stop --stop-bots
   ```
2. **Wait until every old row reads `ended` or `missing`.** Run this until the `state` of every row it lists is `ended` or `missing`:
   ```sh
   agent-director list --label service=cscb
   ```
3. **Check by hand that no old bot session is left.** As the user that runs the bots, run `tmux ls`. No session named `slack_bot_<name>_<channel ID>` (or `slack_bot_<channel ID>`) may be listed; this version hasn't started, so every `slack_bot_` session is an old bot. If one is, end it by its exact name, `tmux kill-session -t '=<session name>'` (the `=` matches that name only), and run `tmux ls` again.
4. **Install this version and go on with the upgrade** from step 2 of [Upgrading to personas](#upgrading-to-personas): `config.json`, credentials files and Slack apps, then `claude-slack-channel-bots start`.

---

## Upgrading from pre-Epic-2 (v0.5.x → v0.6.x)

If you installed CSCB before v0.6.0 you may have legacy artifacts on disk that are no longer needed. Clean them up manually — automatic postinstall migration is tracked under idea b.irf and not yet implemented.

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

### 3. Note on automated migration

A postinstall step that performs this cleanup automatically is tracked under idea b.irf. Until that lands, the steps above are manual.

