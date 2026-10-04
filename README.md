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
- [`agent-director`](https://github.com/gabemahoney/agent-director) **installed system-wide** as a prerequisite — like `git` or `docker`. CSCB no longer vendors the AD binary. The npm `agent-director` package CSCB depends on is now a thin TypeScript shim that locates the system-installed binary at startup via `resolveSystemBinary()` / `Client.create()` and refuses to start when the binary is missing, too old, or unreachable. This release requires agent-director Phase 1, installed on the host together with it, and the two are rolled back together; CSCB changes no agent-director code (see "Switching over to agent-director Phase 1" under [Migration](#migration)). The startup gate enforces AD's required version (declared by AD in `dist/version-floor.json`), also refuses a binary older than agent-director Phase 1 (see [Startup errors](#startup-errors)), and reports the required version on mismatch. agent-director itself requires [tmux](https://github.com/tmux/tmux) on the operator's PATH; CSCB no longer probes for it directly.
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
- A confirmed change to a persona's effective `claude_config_dir` makes it start a new conversation on the same instance at its next launch. Nothing is deleted: the old conversation stays in the old directory, kept as an earlier life of that instance.
- The Slack Reply Guard never installs its hook in `~/.claude`, so a persona whose directory resolves there gets no reminder (see [Personal-dir refusal](#personal-dir-refusal)).

**`stop_hook_bootstrap`** turns the [Slack Reply Guard](#slack-reply-guard-stop-hook) reminder on (`true`, the default) or off for the persona. It applies to that persona alone, even when it shares its `claude_config_dir` with other personas. A running bot keeps the value it was launched with until it is relaunched. See [Personas that answer without `reply`](#personas-that-answer-without-reply--opt-them-out) for when to turn it off.

#### Server-wide settings

These top-level fields apply to the whole server. A confirmed change to one takes effect at the next server start, with three exceptions. A change to `claude_config_dir` or `stop_hook_bootstrap` takes effect at each inheriting persona's next launch. `stop_timeout` and `exit_timeout` are used only by the CLI, which takes them from the record at once. `agent_director_call_timeout_ms` is used by both: the CLI takes it from the record at once, and the running server uses it from its next start. See [What a confirmation applies](#what-a-confirmation-applies).

| Field | Type | Default | Description |
|---|---|---|---|
| `bind` | string | `"127.0.0.1"` | Interface the HTTP server binds to. Use `"0.0.0.0"` to expose on all interfaces. The in-process cron scheduler delivers via `127.0.0.1`, and [`clear-latch`](#claude-slack-channel-bots-clear-latch) reaches the server there, so `bind` must include loopback (the default, or `0.0.0.0`) for scheduled fires and `clear-latch` to work. |
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
| `resume_enabled` | boolean | `true` | When `true` (default), a bot whose session died — including after a host reboot or pod resume — comes back with its prior conversation history intact instead of starting fresh. When `false`, a bot is never resumed: on startup and on runtime auto-restart it starts a new conversation on the same instance, even when a stored session exists, and its old conversation is kept as an earlier life of that instance. Set `false` as a workaround if your Claude Code version crashes with "sandbox required but unavailable" on resume (a known regression in v2.1.120). Requires a system-installed `agent-director` ≥ 0.8.0 for reboot recovery to actually restore history. |
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

`pending_grace_seconds` also sets the server's own waits on a persona's instance that is still starting, each counted from its launch's start: the server starts checking the instance with agent-director once `pending_grace_seconds` has passed, and posts the *Launch stuck* or *Session not starting* notice once the later of 5 minutes and `pending_grace_seconds` plus 60 s has passed (see "A persona's instance is still starting" and "A persona posts a *Launch stuck* or *Session not starting* notice" in [Troubleshooting](#troubleshooting)).

If the file can't be read or parsed, or a `[tmux]` value is one agent-director refuses (not a whole number, negative, above 2^63 − 1, or below its minimum), the server keeps the last values it accepted (the defaults, if none yet) and writes one line to `server.log`. The `debug-slack-channel-bots` skill explains that line under "agent-director's timing settings". agent-director's own answers always decide; the server's reading of the file never overrides them.

#### Sizing the agent-director call timeout

`agent_director_call_timeout_ms` (default `60000`, an integer in `[1000, 3_600_000]`; see [Server-wide settings](#server-wide-settings)) is how long CSCB waits on each agent-director call it makes for its personas:

- **The server** uses the value from the configuration its start runs: the last-applied record, else `config.json`.
- **`stop --stop-bots` and `clean_restart`** use the value from the last-applied record, else `config.json`. When `stop --stop-bots` can't read that configuration, it uses the default `60000`.

A call that runs past the timeout ends in an error while agent-director may still be carrying out the verb. When that call launches a persona, the server reads the persona's state once and does not launch it again while that instance may still be starting (see "A persona's instance is still starting" in [Troubleshooting](#troubleshooting)). So the setting must be greater than its **need**: the largest ceiling among the agent-director verbs CSCB calls, plus a 15 s margin (15000 ms: the store's 10 s busy timeout and 5 s to start agent-director's CLI). Each ceiling is computed from the host's `[tmux]` values in the table above, with these letters:

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
| `retired-keys.json` | The retired-key record: the persona keys the server holds as retired. A confirmed change records the key of each removed persona (a renamed persona's old key included) and of each persona whose `name`, `credentials_file` or `working_directory` changed, before `config.json.last-applied` is rewritten. A server start also records, before its clean-up of old instances ends any of them, the key of every agent-director instance labelled with a persona that is not in the applied configuration (for example, a persona that `config.json` no longer names, at a start after `config.json.last-applied` was deleted; see [Start rules](#start-rules)), so a persona added back later with that key starts fresh. If that write fails, the start logs it in `server.log`, holds those keys as retired until the server stops, and records them again at the next start. Only the server writes it, never the CLI. It is kept across restarts and is absent until a key is first recorded. A key's entry is removed on its own once the persona's new session is running. If it can't be read, the server doesn't start; moving it aside is the fix (see `retired-keys-unreadable` under [Startup errors](#startup-errors)). |

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
DESTRUCTIVE: persona "scribe" (key=scribe) is removed: the persona will be retired: its session stopped and never resumed.
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
| `DESTRUCTIVE: …` | Applying it retires that persona: its session is stopped and never resumed. A removed persona is retired. A persona whose `name`, `credentials_file` or `working_directory` changed is retired and brought up fresh. |
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
| `[slack] reload-record-write-failed: … the confirmed change is not applied and stays pending…` | `config.json.last-applied` or the retired-key record (`retired-keys.json`) couldn't be written, so nothing is applied; the line also says whether the keys the confirmation recorded as retired were removed again. Fix the state directory (permissions, free space), then confirm again. |

### What a confirmation applies

Each row is one kind of change: what happens once you confirm it, and what happens to the persona's live session (its instance and its conversation).

| Change | Once confirmed | Live session |
|---|---|---|
| `channels`, `delivery`, `permission_prompts`, `dm.enabled` or `dm.contact` changes | Applied in place, immediately: from the next event or post. A changed DM contact is used for the next prompt. | Kept |
| A credentials file's content changes (same path), such as a rotated token | Only that persona reconnects: the new connection opens, then the old one closes. If the new file can't be used or Slack refuses it, the old connection keeps running, `server.log` shows `persona-credentials-change-failed`, and the change stays pending. If Slack can't be reached, the old connection stays in use while the new one retries. A persona that is retrying (Slack unreachable, its working directory unusable, or held for its `claude_config_dir` by `persona-config-dir-unresolvable`) has no connection and retries with the new content. A persona down because of its credentials comes up on the confirmed change, with no restart; if its new file can't be used, it stays down with its usual line, such as `persona-credentials-invalid`, and nothing stays pending. | Kept |
| `claude_config_dir` changes (the persona's own or inherited) | Recorded. The persona's next launch uses it and starts a new conversation on the same instance when the directory changed: the conversation is not resumed, nothing is deleted, and the old transcript stays in the old directory. | Kept until the next launch |
| `stop_hook_bootstrap` changes (the persona's own or inherited) | Recorded. The persona's next launch uses it. | Kept |
| A persona is removed | Torn down: its session is ended, with the result checked and retried, and its agent-director row is kept as the old life until agent-director's `expire` removes it, never resumed. Its posted permission prompts stay in Slack, and clicking one has no effect. Until its old instance has ended, no persona is brought up in its working directory (see "A persona waits on an old instance in its working directory" in [Troubleshooting](#troubleshooting)). Previewed `DESTRUCTIVE:`. | Retired: never resumed |
| A persona's `credentials_file` path or `working_directory` changes | Torn down as a removal is (its row kept, never resumed), then brought up fresh from its new entry on the same instance, with no restart: a new conversation, and the new credentials file is read. The new conversation starts only once the old instance has ended, and any other persona in the old working directory waits until then too (see "A persona waits on an old instance in its working directory" in [Troubleshooting](#troubleshooting)). Previewed `DESTRUCTIVE:`. See [Destructive changes](#destructive-changes). | Retired: never resumed |
| A persona's `name` changes | A removal plus an addition: the name sets the key. The old persona is torn down as a removal is (its row kept until agent-director's `expire` removes it, never resumed), and the new one is brought up fresh once the old one's instance has ended (see "A persona waits on an old instance in its working directory" in [Troubleshooting](#troubleshooting)). The removal half is previewed `DESTRUCTIVE:` (`DESTRUCTIVE: persona "<old name>" … is removed`), followed by an `… is added` line for the new name. | Retired: never resumed |
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

`DESTRUCTIVE:` lines in the preview name the personas the change retires when you confirm it (see the table above). A retired persona's session is stopped and never resumed. Read the preview before you rename it. There is no undo. A persona removed and added again with the same key, or renamed and then renamed back, always starts a new conversation, even with a server restart in between: its old conversation is never resumed. A persona brought up from its new entry after a `credentials_file` path or `working_directory` change starts fresh the same way.

CSCB never deletes an agent-director row, and it checks the result of every kill it makes. A teardown ends the old session, checks the result, and keeps the row; a removed persona's row stays until agent-director's `expire` removes it, and is never resumed. A kill agent-director can't carry out right now is tried up to 3 times, 2 s apart. When the kill still fails (for example, the worker outlived each of its kills), `server.log` shows the teardown's line for it, which ends `— the row is kept; nothing latches and no retry timer is armed …`. The persona's new session is then not started over the old one: the bring-up after a `credentials_file` path or `working_directory` change ends the old session first and starts the new conversation only once that succeeds. A renamed persona's new name is brought up only once the old instance has ended, and so is any other persona that shares the old instance's working directory; until then a Claude Code session started from that directory is refused (see "A persona waits on an old instance in its working directory" in [Troubleshooting](#troubleshooting)). The old conversation is never resumed either way.

Nothing about the teardown is posted to Slack. Every notice raised for the persona while it runs goes to `server.log` and `startup-errors.log` as a `persona-teardown-notice` entry; see `persona-teardown-notice` under [Startup errors](#startup-errors), and "A persona posts a *Kill failed* or *Process outlived kill* notice" in [Troubleshooting](#troubleshooting).

### Stale confirmations

A confirmation is pinned to the exact content of `config.json` and of every credentials file it names. If any of them changed after the preview was written, nothing is applied. The confirmation is deleted, and one `reload-stale-confirmation` line is logged. The same happens for a confirmation that can't be read or isn't a pending file the server wrote.

To fix it, wait for the server to write `config.json.pending` again (within about 5 seconds), read it and rename it again. A confirmation is used once. If the same content comes back later, for example after a revert and a redo, confirm it again.

### Size limit

`config.json`, the files beside it and each credentials file are read only up to 64 KiB; a larger file is treated as unreadable. The retired-key record (`retired-keys.json`) has no size cap: only the server writes it. If a very large change makes `config.json.pending` itself larger, its rename is refused as stale, so split the change into smaller edits.

### No reload command

By design, no CLI subcommand, MCP tool or HTTP endpoint applies a change: the rename is the only way. Personas are Claude instances that read help output and tool lists, and a reload can remove a persona, so none of them advertises it; this isn't a security boundary, since a bot running as your user could rename the file itself, so only direct one to when you intend to.

### When the server can't start

A confirmation needs a running server. When the record keeps the server from starting (it can't be read or is invalid, or the first start recorded a bad `port` or `bind`), fix `config.json`, delete `config.json.last-applied`, then run `claude-slack-channel-bots start`. With no record, the start applies `config.json` as it stands and shows no preview.

---

## CLI Reference

The `claude-slack-channel-bots` binary exposes five subcommands.

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
- **Stale PID file** (process no longer running): removes the PID file and `server.port`, prints `server is not running (removed stale PID file)`, exits 0.
- **Live process:** sends `SIGTERM`, polls for exit for up to `stop_timeout` seconds (default 30s), read from the last-applied record when there is one. Prints `[slack] Server stopped.` on clean exit. Escalates to `SIGKILL` if the process does not exit within `stop_timeout`, then prints `[slack] Server killed.` once it has exited. Either way, it removes the PID file and `server.port` (see [PID file](#pid-file)).

Plain `stop` leaves the managed bots running — they are meant to survive a server restart. Pass `--stop-bots` to gracefully exit the bots too:

```sh
claude-slack-channel-bots stop --stop-bots
```

This follows `clean_restart`'s order. It runs the [precheck](#precheck-before-stopping-bots) first, and stops nothing if it fails. When it passes, the server is stopped, then the bot teardown runs for each persona in the last-applied record (or in `config.json` when there is no record), addressing its instance as `cscb_<key>` — pause the bot, poll until it exits (or up to `exit_timeout` seconds), then force-kill on timeout. A bot that can't be paused is handled as [When a bot can't be paused](#when-a-bot-cant-be-paused) describes. Teardown kills but never deletes each row, preserving its `claude_session_id` so the bots can resume their conversation history on the next start. Stopping the server before the teardown prevents its `onsessionclosed`/`scheduleRestart` handler from respawning a just-exited bot mid-teardown (which would delete its `ended` row and history). Use it when you want a clean, flushed shutdown of the bots (for example before a host reboot).

If agent-director can't be reached, or a persona's instance can't be read, the precheck fails: nothing is stopped and the command exits 1 (see [Precheck before stopping bots](#precheck-before-stopping-bots)). If a persona can't be stopped after a passed precheck, the command prints a line naming it, its session and why, ends with a line counting the personas it could not stop, and exits 1 rather than silently reporting a clean stop (see [What the command prints when a bot can't be stopped](#what-the-command-prints-when-a-bot-cant-be-stopped)). `stop --stop-bots` never starts the server: after a failure the server stays stopped, unlike [`clean_restart`](#when-clean_restart-cant-stop-a-bot). When every persona is stopped, one stopped with a *Process outlived kill* text included, it exits with the server stop's status.

`stop --stop-bots` makes no version check of its own, so CSCB can always be stopped, whatever agent-director is installed:

- **An agent-director older than CSCB needs, that the agent-director client still accepts:** the command works as usual. The precheck and the teardown run through that agent-director, and every bot is stopped. This is how you stop the bots before the switch-over (see the README section "Switching over to agent-director Phase 1").
- **An agent-director below the client's own minimum:** no agent-director call can be made, so only the server is stopped. No bot is checked, paused or killed, and every bot and its agent-director instance is left as it is. The command prints the reason, which names the version found, the version required and the README section "Switching over to agent-director Phase 1", then the server stop's own lines, then a last line, and exits 1:

  ```text
  [slack] stop --stop-bots: agent-director initialization failed: agent-director startup gate failed (ad-system-install-too-old): agent-director system install is too old: …
  [slack] Server stopped.
  stop --stop-bots: only the server was stopped; every worker and row was left as it is
  ```

  The exit status is 1 whatever the server stop did, so read the lines between the first and the last to tell whether the server is really down: `[slack] Server stopped.`, `[slack] Server killed.` or `server is not running` mean it is; `[slack] Warning: server did not die after SIGKILL.` means it is still running; `[slack] Could not read PID file: …` means the PID file could not be read, so the server's state is unknown. This happens whether or not the configuration could be loaded.

A configuration that cannot be loaded, a bad record or a missing or pre-persona file included, is best-effort: it prints `[slack] stop --stop-bots: could not load config — skipping bot teardown:` with the cause, and no persona is checked. The command still connects to agent-director, with the default call timeout. Once the connection succeeds, the server is stopped and the teardown is skipped. A failed connection stops nothing (see [Precheck before stopping bots](#precheck-before-stopping-bots)); on an agent-director below the client's own minimum only the server is stopped, as described above.

### `claude-slack-channel-bots clean_restart`

Runs the [precheck](#precheck-before-stopping-bots), then stops the server, gracefully exits all managed Claude Code sessions, and starts the server again.

```sh
claude-slack-channel-bots clean_restart
```

For each persona in the last-applied record (or in `config.json` when there is no record), calls `client.pause({claude_instance_id})` via agent-director with the persona's instance ID `cscb_<key>`, and polls `client.status(...)` until the spawn transitions to `ended` / `missing` (or `client.status(...)` fails with `ErrSpawnNotFound` because the row is gone). If the spawn does not exit within `exit_timeout` seconds (default 120s), the spawn is force-killed via `client.kill(...)`. Teardown kills but never deletes each row, preserving its `claude_session_id` so bots resume their conversation history on the next start. All personas are processed in parallel. After the server restarts, the SR-1.4 collision-then-act dispatcher decides resume-vs-fresh per persona — agent-director owns Claude session-id state, not CSCB.

`clean_restart` logs its progress to `STATE_DIR/clean_restart.log`. The lines that end it with an error (config load failure, agent-director initialization failure, a failed precheck, a persona it could not stop, the alert that the server was not started, start failure) are also printed to the terminal, and so is any *Process outlived kill* text from the teardown, even on a run that goes on to start the server.

`clean_restart` loads the last-applied record first, or `config.json` when there is no record, and takes `exit_timeout` from it. If it cannot (a record that can't be read or is invalid, or a missing or pre-persona file), it exits 1 with `[slack] clean_restart: failed to load config:` and the loader's error, and nothing is stopped. For a bad record, the error says that deleting it makes the next start apply `config.json` (see [Reload](#reload)). `clean_restart` doesn't apply a pending `config.json` edit: the server comes back on the record.

A persona whose force-kill succeeds, or whose instance is found already ended, missing or gone, counts as stopped; so does one whose force-kill ends with a *Process outlived kill* text. When every persona is stopped, the server is started and the command exits with the start's status. When a persona can't be stopped, the command prints its line once every persona's teardown has finished, then starts the server only if agent-director answers, and exits 1 either way (see [When `clean_restart` can't stop a bot](#when-clean_restart-cant-stop-a-bot)). That includes a pause refused for a reason that fails the teardown at once (see [When a bot can't be paused](#when-a-bot-cant-be-paused)) and a force-kill that fails (see [When a bot can't be force-killed](#when-a-bot-cant-be-force-killed)).

Behavior by case:

- **No personas** (`"personas": []`): nothing is torn down; the server is stopped and started.
- **A persona with no instance:** logs `[slack] teardownBots: no spawn row for persona "<name>" (key=<key>) — skipping` and continues.
- **Server already stopped:** `stop` reports `server is not running`; `start` then brings up a fresh server.
- **Server fails to start again:** `clean_restart` exits non-zero with `[slack] clean_restart: start failed with exit code <n>`; the reason is in `server.log`.
- **agent-director unreachable, or a persona's instance can't be read:** the precheck fails and nothing is stopped: the old server and every bot keep running, and `clean_restart` exits 1 (see [Precheck before stopping bots](#precheck-before-stopping-bots)).
- **An agent-director older than CSCB needs:** `clean_restart` runs the same version checks as the server's start, so on an agent-director below CSCB's Phase 1 floor, or below the client's own minimum, its precheck fails at the connection and nothing is stopped. Follow the README section "Switching over to agent-director Phase 1". To stop the bots before the switch-over, use `stop --stop-bots`, which works on any agent-director the client accepts (see [`stop`](#claude-slack-channel-bots-stop)).
- **agent-director fails during the teardown:** that persona can't be stopped, so the command exits 1. It starts the server if agent-director answers its check (3 tries, 2 s apart), and otherwise leaves the server stopped and records `clean-restart-not-restarted` (see [When `clean_restart` can't stop a bot](#when-clean_restart-cant-stop-a-bot)). The `no spawn row` message appears only when a persona genuinely has no spawn, never when the client failed to reach agent-director.

#### When a bot can't be paused

`stop --stop-bots` and `clean_restart` share one bot teardown. When agent-director refuses to pause a persona's bot, what happens depends on why.

The bot is force-killed instead, and its row is kept, when:

- its session is already gone;
- agent-director keeps not answering: the pause is tried 3 times, 2 s apart, before the force-kill;
- the bot is still launching (its instance is `pending`, for example at a launch dialog). Its instance stays `pending` until agent-director marks it `missing`: once the server runs, it checks the instance with agent-director from `pending_grace_seconds` after its launch's start (see "A persona's instance is still starting" in [Troubleshooting](#troubleshooting)), and those checks mark it;
- the pause times out. agent-director waits up to its `[pause] timeout_seconds` for the bot to exit, and the default call timeout covers that wait (see [Sizing the agent-director call timeout](#sizing-the-agent-director-call-timeout));
- agent-director refuses it for any reason not listed below.

That persona's teardown fails at once, with no force-kill, when:

- a tmux session conflict holds the persona's session, which may not be the bot's own;
- the tmux session name recorded on the persona's instance can't be used. The command puts no hold on the persona; only the server does that;
- tmux is unavailable;
- agent-director reports an internal error;
- agent-director refuses its config file, `~/.agent-director/config.toml`. The error names the file.

The other personas are still torn down. A persona whose teardown fails makes the command exit non-zero (see [`stop`](#claude-slack-channel-bots-stop) and [`clean_restart`](#claude-slack-channel-bots-clean_restart)).

#### When a bot can't be force-killed

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

The server may be holding a persona for a human (see [Troubleshooting](#troubleshooting)). `stop --stop-bots` and `clean_restart` still stop it, because running them is a human's deliberate action. For a bot whose launch has no recorded start, the force-kill ends no session.

#### What the command prints when a bot can't be stopped

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

The server is stopped at that point, so the command writes `server.log` itself, in the server's timestamped form and with its rotation (see [Server log rotation](#server-log-rotation)); the entries are described under [Startup errors](#startup-errors). Each line reaches the terminal once. The two file writes are best effort. When the `server.log` write fails, the command prints `[slack] <command>: could not append a line to server.log: …`: on the terminal for `stop --stop-bots`, and in `clean_restart.log` only for `clean_restart`. When the `startup-errors.log` write fails, the terminal shows `[<time>] [startup-errors] WARNING: could not write to <path>: …`. Either way the print, the other file and the exit status are unchanged. Nothing is posted to Slack, and no persona is held. What to do: see "`clean_restart` or `stop --stop-bots` exits non-zero with `could not stop`" in [Troubleshooting](#troubleshooting).

#### When `clean_restart` can't stop a bot

While agent-director answers, a bot that can't be stopped never leaves the whole fleet down. Once every persona's line is printed, `clean_restart` checks that agent-director answers: it lists CSCB's instances, up to 3 tries, 2 s apart. Each failed try, whatever the error, writes `[slack] clean_restart: agent-director answer check: list try <n> of 3 failed: <CLASS>: <description>` to `clean_restart.log`.

- **agent-director answers:** the server is started, as at any start. Its clean-up of old instances deletes no agent-director row, so every row is kept, the ones the command could not stop included. The new server keeps each configured persona's own instance that is still running, one the command could not stop included, and brings up the others. When the start lists its agent-director instances, before its clean-up ends any of them, a persona whose own row has conflicting labels, or reads pending with no launch start, is held for a human, and that start ends none of its instances. A persona whose launch meets a tmux session conflict is held too (see "A persona posts a *Held: tmux session conflict* notice" and "A persona posts a *Held: launch start not recorded* notice" in [Troubleshooting](#troubleshooting)). A start that fails prints `[slack] clean_restart: start failed with exit code <n>`, and records no `clean-restart-not-restarted` entry.
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

#### How long a teardown can take

Personas are torn down in parallel. Each persona's teardown takes at most the sum of:

- the read of its instance;
- the pause: up to 3 tries, 2 s apart;
- the wait for the bot to exit: up to [`exit_timeout`](#server-wide-settings) seconds, then one last read;
- the force-kill: up to 3 tries, 2 s apart, with one read of the instance before each further try.

Each agent-director call takes at most `agent_director_call_timeout_ms` (see [Sizing the agent-director call timeout](#sizing-the-agent-director-call-timeout)). The [precheck](#precheck-before-stopping-bots) that runs before it is bounded the same way: up to 3 tries, 2 s apart, of each of its two calls per persona.

### Precheck before stopping bots

Before `stop --stop-bots` or `clean_restart` stops anything, it checks that agent-director answers and that each persona's instance can be read:

1. It connects to agent-director. `clean_restart` makes the same version checks as the server's start. `stop --stop-bots` makes no version check of its own: any agent-director the client accepts passes, one older than CSCB's Phase 1 floor included.
2. For each persona in the last-applied record (or in `config.json` when there is no record), it reads the persona's instance, `cscb_<key>`. A persona with no instance, or whose instance has finished, is skipped. A running instance has one line of its screen read.

A persona fails the precheck when agent-director answers with one of these classes:

| Class | Meaning |
|---|---|
| `CONFLICT` | A tmux session conflict holds the persona's session (see "A persona posts a *Held: tmux session conflict* notice" under [Troubleshooting](#troubleshooting)) |
| `UNUSABLE_NAME` | The tmux session name recorded on the persona's instance can't be used (see "A persona posts a *Held: unusable tmux session name* notice" under [Troubleshooting](#troubleshooting)) |
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

### `claude-slack-channel-bots clear-latch`

Ends one persona's hold on the running server, whichever of these held it: a *Held: tmux session conflict*, *Held: unusable tmux session name* or *Held: launch start not recorded* notice (see "How a hold ends" under [Troubleshooting](#troubleshooting)). A *Cannot launch* hold is not one of these: `clear-latch` does not end it and answers that the persona `was not latched` (see "A persona posts a *Cannot launch* notice" under [Troubleshooting](#troubleshooting)).

```sh
claude-slack-channel-bots clear-latch <persona>
```

`<persona>` is the persona's name or its key in the configuration the server runs; quote a name with spaces for your shell. Only that persona's hold is cleared.

Use it once a human has resolved the hold's cause through the "Operator actions" section of agent-director's README: it brings the persona back at once instead of at the server's own check every 2 minutes, and it ends a hold that check cannot clear, such as one on a description the server does not recognise. It is for a human only: no bot is offered it. No restart is needed.

When the persona was held, its destination gets one recovery notice, *Conflict cleared* or *Hold cleared*, and the server brings the persona up at once. If the cause is still there, the persona is held again, with one new notice.

It prints one line on stderr and never repeats its argument:

| Line | Exit | When |
|---|---|---|
| `Usage: claude-slack-channel-bots clear-latch <persona name or key>` | `2` | Not given exactly one non-empty argument. |
| `clear-latch: no server is running` | `1` | `STATE_DIR/server.pid` is absent, unreadable or stale, read as `stop` reads it. |
| `clear-latch: the server did not answer: <cause>` | `1` | The server could not be reached. `<cause>` says why: `server.port is absent`, `server.port could not be read`, `server.port is malformed`, `server.port holds a PID or port out of range` or `server.port was written by another process` (see [PID file](#pid-file)); the connection failed, for example `Error: connect ECONNREFUSED 127.0.0.1:<port>`; or the server gave an unexpected answer, `HTTP <status>`. Check that the server is running and its `bind` (below). |
| `clear-latch: the server did not confirm within 30 s; the clear is queued and may still run. Check this persona's latch in the server log before trying again.` | `1` | No answer came within 30 s, for example while work for the persona was still running; the clear may still run. Look for the persona's `conflict-latch: persona=<key> cleared` line in `server.log` before running the command again. |
| `clear-latch: no persona in the running configuration has that name or key` | `1` | No persona of the configuration the server runs has that name or key. Nothing changed. |
| `clear-latch: cleared the latch of persona "<name>" (key=<key>)` | `0` | The persona was held; the hold is cleared. |
| `clear-latch: persona "<name>" (key=<key>) was not latched; nothing changed` | `0` | The persona was not held, or only by a *Cannot launch* hold, which this command does not end. |

It reaches the server at `127.0.0.1`, at the port the running server recorded in `server.port`, not at the `port` of `config.json`. It connects directly and ignores proxy environment variables such as `HTTP_PROXY`, so its argument never leaves the host. So the server's `bind` must be `127.0.0.1` (the default) or `0.0.0.0`, as scheduled prompts need. On any other `bind` it cannot reach the server, and a hold ends only by the server's own check every 2 minutes, by the persona's teardown (removing it, or a destructive change to it), or by a server restart, which drops every hold.

It needs no agent-director, reads no configuration file and writes or removes no file.

### PID file

The PID file is stored at `STATE_DIR/server.pid` (default: `~/.claude/channels/slack/server.pid`). It is written on startup and removed on clean shutdown. A conflict check at startup prevents running two servers against the same state directory.

Beside it, `STATE_DIR/server.port` records the server's process ID and the port it actually listens on. The server writes it once it is listening and removes it on shutdown. A start that finds a stale PID file removes a stale `server.port` with it, and `stop` removes it with the PID file. [`clear-latch`](#claude-slack-channel-bots-clear-latch) reads it to find the server, and uses it only when the process ID it records is the one in `server.pid`.

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

A session from a directory where an old instance may still be running is refused with its own line, whichever persona names the directory: `Session refused: its working directory "<path>" is held for an old life that may still be running (instanceId="<id>") — registered as no persona's session until the hold ends (b.jg5 SRJ-810, SRJ-1505)`, one `instanceId` for each such old instance. See "A persona waits on an old instance in its working directory" below.

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

**A persona's instance waits at a startup prompt**
After each launch of a persona's instance (a start, a restart, a resume or a confirmed change's bring-up), the server watches it through agent-director while it starts. It does the same after a launch that timed out, once it finds that launch's instance still starting (see "A persona's instance is still starting" below). When Claude Code's folder-trust or development-channels prompt shows, the server presses Enter to accept it. It types nothing else, and nothing at all when neither prompt shows; the server runs no tmux command for this.

How long and how often it watches:

- It watches until the session starts, for at most the later of 5 minutes and agent-director's `pending_grace_seconds` plus 60 s, counted from the launch's start (see [agent-director's timing settings](#agent-directors-timing-settings)). At the defaults that is 5 minutes.
- It looks once a second, and once every 5 s after `pending_grace_seconds` has passed since the launch's start. After agent-director answers that it can't act right now, or refuses its config file, the next look also waits 5 s.
- When that time runs out it gives up: it writes one line to `server.log` and, during a server start, a `dev-channels-approve-not-ready` entry (see [Startup errors](#startup-errors)). The watch posts nothing to Slack; if the session still hasn't started, the persona posts a *Launch stuck* or *Session not starting* notice (see "A persona posts a *Launch stuck* or *Session not starting* notice" below).

It also stops watching, with a line in `server.log`, when:

- agent-director reports the instance ended or missing, or its session gone: the restart handling decides what happens next;
- agent-director says the session holding the persona's name is not this launch's: nothing is typed and nothing is ended;
- the persona is held: see the *Held:* entries below ("A persona posts a *Held: tmux session conflict* notice", "… *Held: unusable tmux session name* …" and "… *Held: launch start not recorded* …"). A hold set while it watches stops it at once, and nothing is typed;
- tmux is unavailable: see "A persona posts a *tmux unavailable* or *tmux server changed* notice" below.

When agent-director refuses its config file ("A persona posts an *agent-director refuses its config file* notice" below), the server keeps watching within the same time limit.

To look at the session, or to answer its prompt by hand, attach to it:

```sh
tmux attach -t =slack_bot_<key>
```

To follow the server's watch for one persona:

```sh
grep -E '\[slack\] approvePreSessionDialogs: .*(\(key=<key>\)|persona=<key>\b)' ~/.claude/channels/slack/server.log
```

agent-director also accepts the persona's folder trust itself at each launch and reports whether it did. The server writes one line to `server.log` with that report for each launch call that returns success (a failed launch call writes none), and does nothing else because of it:

- `[slack] spawnForPersona: "<name>" (key=<key>) <spawn|resume> pre_trust=ok (logged only, b.jg5 SRJ-413)`: the folder trust was accepted.
- `… pre_trust=skipped …`: it was not accepted for this launch, so the folder-trust prompt may show.
- `… pre_trust=failed …`: agent-director could not accept it, so the folder-trust prompt may show.
- `[slack] spawnForPersona: "<name>" (key=<key>) <spawn|resume> result carries no pre_trust: it came from an agent-director older than Phase 1 (logged only, b.jg5 SRJ-413)`: the installed agent-director reports nothing about it.

A folder-trust prompt that still shows is accepted by the server as described above. To see these lines for one persona:

```sh
grep -F 'pre_trust' ~/.claude/channels/slack/server.log | grep -F '(key=<key>)'
```

**A persona's instance is still starting**
agent-director shows the persona's instance as launched, but its session has not started yet. This is normal for a short time after every launch: a start, a restart, a resume, a confirmed change's bring-up, a replacement of an old instance, or a retry's relaunch.

While the persona's own instance is starting:

- Its retries read its state, until the session starts (see "A persona is retried after agent-director refuses it" below). Until agent-director's grace period (`pending_grace_seconds`, see [agent-director's timing settings](#agent-directors-timing-settings)) has passed since its launch's start, they do nothing else. After that, each retry checks it: when the startup-prompt watch is no longer running, it looks at the session once and presses Enter only on the folder-trust or development-channels prompt, then asks agent-director to check whether the launch is still alive and reads its state again. When the startup-prompt watch stops with the instance still starting (other than for a hold, a confirmed change or a server stop), one more such check follows. A check agent-director can't decide yet leads to nothing more until the next retry.
- While they read it as still starting, they never launch a second instance over it and never end it, except for that one relaunch of the server's own launch, and a launch that is still starting never counts as a failure. Once agent-director finds the launch gone, the persona is brought up again, keeping its conversation where it can.
- If it still hasn't started by the later of 5 minutes and `pending_grace_seconds` plus 60 s from its launch's start, the persona posts a notice (see "A persona posts a *Launch stuck* or *Session not starting* notice" below). When this server made that launch itself, the notice is *Launch stuck*, and the server ends the launch and launches the persona again, once while it stays stuck. Any other launch gets *Session not starting*, is never ended, and the checks go on.
- While the persona is held for a human, or waits on an old instance in its working directory, none of these checks is made; a held persona gets only the hold's own check (see "The server's own check" under "A persona posts a *Held: tmux session conflict* notice" below).
- The startup prompt is answered for this launch, and nothing else is typed (see "A persona's instance waits at a startup prompt" above).
- A restart can still end it in one case: when agent-director answers the restart's check that its own install has disappeared, that check reads nothing of the instance, so the restart ends it before relaunching, without knowing whether it is still starting.
- A server start's clean-up of old instances and a bot teardown you run from the command line follow their own rules for every instance, a starting one included (see "Bots come back with no memory of the prior conversation after a reboot" below and the [CLI Reference](#cli-reference)).

An old instance that is still starting is never typed into. That is one of a persona that was removed, renamed or destructively changed, before the persona's new conversation has begun, or one started in another working directory or with another config directory. The server replaces it as it replaces any old one: it ends it with a checked kill, then, while it still reads as starting, waits until agent-director's grace period (`pending_grace_seconds`, see [agent-director's timing settings](#agent-directors-timing-settings)) has passed since that instance's launch start, confirms it has ended (with one more checked kill if needed) and brings the persona up on a new conversation on the same instance (see "Bots come back with no memory of the prior conversation after a reboot" below).

A launch that times out (the server's call to agent-director runs past its limit, or agent-director answers that the session may have been created) may still have started the persona's instance. The server then reads the persona's state once, before doing anything else, and launches nothing more in that attempt; the same read follows every other launch agent-director refuses as not answering or not able to act right now. What it does next depends on what it reads:

- The persona's own launch, still starting: after a timed-out launch, its startup prompt is still answered (see "A persona's instance waits at a startup prompt" above), and its retries read and check it as described above until its session starts. After any other refusal no startup-prompt watch runs; the retries watch and check it the same way.
- An old instance still starting, or one in another working directory or with another config directory: never typed into, and replaced as described below.
- A running instance: never launched over; the next retry reconnects it.
- An ended instance, or none at all: launched again at the next retry, never in the same attempt.

Nothing is counted toward the restart limit and nothing is ended because of the timeout.

A launch whose session agent-director could not create is a launch failure: it is counted, with a `Spawn failure:` notice (and a `spawn-failed` entry at a start, see [Startup errors](#startup-errors)), and nothing is launched in its place. Its instance may be left still starting; so may that of a resume or relaunch that failed the same way. Such an instance is not the server's own launch, so it is waited out like any other: the retries begin at once, check it from `pending_grace_seconds` as described above, never end it or launch over it, and at the time limit the persona posts *Session not starting* (see "A persona posts a *Launch stuck* or *Session not starting* notice" below). Once agent-director finds it gone, the persona is brought up.

A still-starting instance whose launch start agent-director did not record holds the persona instead (see "A persona posts a *Held: launch start not recorded* notice" below). When the server can't tell yet whether the instance is the persona's own launch (its working directory or config directory can't be resolved right now), it leaves the instance alone and reads it again at the next retry.

To follow it for one persona:

```sh
grep -E 'unavailable-retry: persona=<key> |Deferring persona=<key>: |pending-row: (not arming )?"[^"]*" \(key=<key>\)|pending-row: persona=<key> ' ~/.claude/channels/slack/server.log
```

To follow the read after a launch that timed out or was refused:

```sh
grep -F 'one get after the' ~/.claude/channels/slack/server.log | grep -F '(key=<key>)'
```

`[slack] spawnForPersona: one get after the <call> of "<name>" (key=<key>) ended in a launch timeout (ErrCallTimeout): read pending; this launch's row: yes (launch start <time>) — covered: the approver starts once the launch call has returned; the retry timer watches the row; no launch in this attempt (b.jg5 SRJ-407)` marks a timed-out launch whose instance is starting; the line names what was read and what follows (`ErrTmuxUnresponsive` in place of `ErrCallTimeout` for agent-director's own timeout, `UNAVAILABLE (…)` for another refusal).

`[slack] unavailable-retry: persona=<key> armed in pending-only mode (pending-row) — first retry in 30 s` marks the persona's own launch being watched, and `[slack] unavailable-retry: persona=<key> stopped (pending-only, row <state>) — its row is live out of pending; nothing else is called` its session starting. `[slack] pending-row: "<name>" (key=<key>)'s pending row is not covered (<reason>: <why>) — it goes through the live-row sequence, the conversation not kept (alert context recovery); no approver, nothing typed (b.jg5 SRJ-411)` marks an old instance being replaced, and `… pending row is undecided (…)` one the server can't place yet. The `debug-slack-channel-bots` skill explains every line.

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
The bot is wedged in `check_permission` on a native Claude Code TUI prompt that never reached Slack (a permission decision AD recorded but could not deliver). The bot stops responding, and after ~90 s the poller posts a one-shot warning naming the persona to the persona's destination (a channel or a DM with its contact). Recover by inspecting the native prompt with `agent-director read-pane --claude-instance-id <id>`, then killing and respawning the session (`agent-director kill <id>` or tmux-kill, then let the server restart it or `claude-slack-channel-bots stop && claude-slack-channel-bots start`). Do **not** use `send-keys` — agent-director hard-rejects it while the spawn is in this relayed permission state. The warning fires once per wedge episode; the detector re-arms if the bot later wedges again. While a confirmed change tears the persona down, the warning is not posted: it goes to `server.log` and `startup-errors.log` as a `persona-teardown-notice` entry.

**Session not restarting after crash**
Auto-restart backs off exponentially on repeated launch failures — the delay doubles from `session_restart_delay` (default 60s) on each consecutive failure, up to a 15-minute ceiling. After 5 consecutive failures the persona hits a cap: a `SpawnCapReached` notice naming the persona is posted to the persona's destination (a channel or a DM with its contact, per its `permission_prompts`) and automatic restarts stop. A launch that agent-director refuses is not handled by this backoff and cap: it is not counted, and the persona is retried on its own instead, even with `session_restart_delay` set to `0` (see "A persona is retried after agent-director refuses it" below).

The server never kills an instance it has just read as ended or missing, or found gone: such an instance needs no kill, and a kill then could end a launch someone started after that read. So a restart that finds the instance ended, missing or gone relaunches the persona with no kill, and so does one whose health check found no proof the old instance is gone (agent-director refused the reconnect, or had already finished the row or had no row for it); `server.log` shows `No kill before the launch for persona=<key>` or `No kill before the relaunch for persona=<key>` before it. The server kills the persona's old instance before a relaunch only when agent-director answers the restart's check that its own install has disappeared, which reads nothing of the instance, and then checks the result. The relaunch follows only a kill that succeeded, or one that found the instance already gone; after any other result nothing is relaunched over the old instance and nothing counts toward the restart limit: the persona is retried on its own, or held for a human (see the *Held:* entries below). `server.log` shows `Session kill for persona=<key> did not succeed (…)` for such a kill. When agent-director reports that it could not end the old worker, the persona's destination also gets a *Kill failed* notice (see "A persona posts a *Kill failed* or *Process outlived kill* notice" below).

A message sent to a persona whose instance can't take it is lost, whether it came from the persona's own channel, a shared channel or a DM: it is not delivered, saved or replayed later, and nothing else is posted where it was sent. Instead, the persona posts one lost-message notice to its destination (its `permission_prompts` channel, or its DM with its contact). That notice is the only post; it lands in the conversation the message came from only when that conversation is the destination.

The notice names the sender (by display name, or user ID; for a bot or webhook post, its name or bot ID) and the recovery state below. It never includes the message text.

- **One notice per lost message.** A persona whose instance can't take messages while its Slack connection is up (held for a human, held because agent-director rejected its launch, after a failed kill, not answering, starting, restarting, while the server replaces its old instance, while it waits on an old instance in its working directory, at the restart limit, or with auto-restart off) posts one notice for each message it loses in a busy `delivery: all` channel. With a `"dm"` destination, each notice is a separate DM to its contact.
- **Held notices are capped.** While the persona can't post to its destination, its notices are held and retried, up to 20 per persona; past that, the oldest is dropped (see "A permission prompt or notice doesn't arrive" above).
- **Notices reach other personas.** A notice is a Slack post like any other, so a persona with `delivery: all` in the destination channel receives it. When the instances of two personas both can't take messages and each persona receives every message in the other's destination channel, each one's notice is a lost message for the other, so they keep posting notices about each other's notices until one of their instances takes messages again. Give each persona a destination the others don't receive every message in (see [Permission prompts](#permission-prompts)).

The notice reports the first state that applies, in the table's order.

| Recovery state in the notice | What it means | What to do |
|------------------------------|---------------|------------|
| `not up` | The persona stopped being up (broken or retrying) while the message was being handled, so no restart was started. A persona that isn't up receives no new messages, so this appears only in that short window. Its instance is launched once the persona recovers. | Fix the persona's cause (see "A persona doesn't come up or doesn't answer"), then resend once it's back. |
| `held for a human` | The persona is held until a human resolves a problem with its tmux session or agent-director row, so no restart was started. | Follow the persona's hold notice (see "A persona posts a *Held: tmux session conflict* notice", "A persona posts a *Held: unusable tmux session name* notice" and "A persona posts a *Held: launch start not recorded* notice" below), then resend once it's back. |
| `cannot launch` | The host's agent-director rejected the persona's launch, so the persona is held until the agent-director binary changes or the server restarts; no restart was started. | Follow the *Cannot launch* notice (see "A persona posts a *Cannot launch* notice" below), then resend once the persona is back. |
| `kill failed` | The server could not end a worker of the persona, which may still be running; no restart was started. Either the persona's own old worker could not be ended and the server posted a *Kill failed* notice, or the persona is waiting on an old instance (one still running in its working directory, or its own earlier instance) that a confirmed change's teardown, a server start's clean-up or the server's later kill could not end. For such an old instance nothing is posted: the *Kill failed* text is in `startup-errors.log` (see [Startup errors](#startup-errors)). It applies until agent-director reports that worker's row ended or missing, or no longer has it. A persona that is also held for a human reports `held for a human`. | Follow the *Kill failed* notice, or for an old instance the *Kill failed* text in `startup-errors.log` (see "A persona posts a *Kill failed* or *Process outlived kill* notice" below), then resend once the persona is back. |
| `not answering` | agent-director or tmux is not answering for the persona, tmux is not available for it, or agent-director refuses its config file, and the server is retrying the persona on its own; no restart was started. It applies only while those retries are running: a persona at its restart limit reports `restart limit reached` instead, whatever is wrong with tmux or agent-director, and one whose retries have stopped reports the next state that applies. | Follow the persona's own notice (see "A persona posts a *Not answering*, *Still not answering* or *Answering again* notice", "A persona posts a *tmux unavailable* or *tmux server changed* notice" and "A persona posts an *agent-director refuses its config file* notice" below), then resend once it's back. |
| `starting` | The persona's session is starting but has not come up yet, so no restart was started: a launch of it is running, or the server checked with agent-director once, when it found the message lost, and the session was still starting. A check that fails never reports `starting`. | Resend once the persona is up. |
| `restarting` | A restart of the persona's instance was already under way, or the server is replacing the persona's old instance, still running, on the same instance: with a new conversation, for a relaunch that can't resume it because `resume_enabled` is false or its working directory or config directory changed; or keeping its conversation, for a relaunch after its session was found gone while agent-director still reads it as running. It is also reported while the server is ending an old instance the persona waits on (see "A persona waits on an old instance in its working directory" below), even while the persona's own row reads `pending`. A message lost while the old instance is being replaced or ended starts no restart of its own. | Resend the message (or ask the sender to) once the persona is back. |
| `auto-restart disabled` | `session_restart_delay` is `0`, so no restart was started. A persona the server is already retrying on its own (see "A persona is retried after agent-director refuses it" below) comes back when a retry succeeds; otherwise a server restart recovers it. | If the persona isn't being retried, restart the server; resend once it's back. |
| `restart limit reached` | The persona is capped; automatic restarts are suspended. It takes precedence over `not answering`: a capped persona reports it even while tmux or agent-director is failing for it, unless a restart is already under way, auto-restart is disabled, or its session is starting. | Restart the server to clear the limit, then resend. |
| `starting now` | The lost message triggered a fast restart (the backoff delay is clamped down to 5 seconds, never raised). A persona waiting on an old instance in its working directory comes up only once that instance has ended (see "A persona waits on an old instance in its working directory" below). | Resend in a moment, once the persona is back. |

`starting` and `starting now` differ: `starting` means the session was already starting and the message started nothing; `starting now` means the message itself started a restart.

A `starting now` restart still counts each failed launch toward the backoff/cap, and a restart already pending or active is not stacked.

A **capped** persona (or any persona when auto-restart is disabled via `session_restart_delay: 0`) does **not** recover on an inbound message — firing another launch there would only burn a spawn attempt against a persona that cannot come up. Nor does a persona that is held for a human, cannot be launched (`cannot launch`), has a failed kill (`kill failed`), is not answering or is starting: an inbound message starts no restart for it. A capped persona reports `restart limit reached`, never `not answering`, even while tmux or agent-director is failing for it, and the message starts no retry for it. To clear the cap and retry, restart the server with `claude-slack-channel-bots stop && claude-slack-channel-bots start`; the failure counter is in-process and cleared on restart, giving each persona a fresh attempt. To disable auto-restart entirely, set `session_restart_delay` to `0` in `config.json` and apply the change (see [Reload](#reload)); it takes effect at the next server start.

**A persona is retried after agent-director refuses it**
Symptom: a persona stays down or silent while agent-director refuses the server's calls for it (it is unreachable, or answers that it can't act right now). The server retries the persona on its own: 30 seconds after the refusal, then after 60, 120 and 240 seconds more, then every 300 seconds, whatever `session_restart_delay` and `health_check_interval` are, `0` included. Each retry reads the persona's state first, never starts a second instance over one that is running, and reconnects or relaunches it. A refusal never counts toward the restart limit, so the persona is never given up for it. A refusal posts no `Spawn failure:` notice and ends the launch or restart it met, with nothing more killed or launched in it. Once agent-director answers again, the next retry recovers the persona: in the common case there is nothing to do. After any launch of the persona, a retry's relaunch included, and after a launch that timed out, the later retries read its state until its new session has started, and from agent-director's grace period on also check the starting instance with agent-director (see "A persona's instance is still starting" above).

The retries stop when the persona is recovered, when it reaches the restart limit through failed launches, when it stops being up (its own bring-up retry takes over), when it is held for a human (see "A persona posts a *Held: tmux session conflict* notice", "A persona posts a *Held: unusable tmux session name* notice" and "A persona posts a *Held: launch start not recorded* notice" below), while it is held because agent-director rejected its launch (see "A persona posts a *Cannot launch* notice" below), when it is removed from the configuration, and when the server stops. To follow them for one persona:

```sh
grep -E 'unavailable-retry: persona=<key> |Session relaunch refused for persona=<key> |Session kill for persona=<key> did not succeed |Restart retry skipped for persona=<key> ' ~/.claude/channels/slack/server.log
```

`[slack] unavailable-retry: persona=<key> armed (<cause>) — first retry in 30 s` starts them (after a launch, `armed in pending-only mode (pending-row)`), and `[slack] unavailable-retry: persona=<key> stopped — nothing left to recover` shows the persona is back (after a launch, the last line says `pending-only` instead). The `debug-slack-channel-bots` skill explains the other retry lines. If the persona keeps retrying and never clears, check that agent-director responds:

```sh
agent-director version
```

If it doesn't, fix agent-director; the next retry recovers the persona with no server restart.

When agent-director answers that it can't use tmux for the persona, the persona is retried the same way, and its destination gets a *tmux unavailable* or *tmux server changed* notice (see "A persona posts a *tmux unavailable* or *tmux server changed* notice" below).

When agent-director refuses its own config file, the persona is retried the same way, and its destination gets an *agent-director refuses its config file* notice (see "A persona posts an *agent-director refuses its config file* notice" below). A working `agent-director version` doesn't show that this one is fixed.

When agent-director returns an error the server can't classify, the persona is retried the same way, and its destination may get an *Unclassified agent-director error* notice (see "A persona posts an *Unclassified agent-director error* notice" below).

When the refused calls act on the persona's session itself, its destination may also get *Not answering*, *Still not answering* and *Answering again* notices (see "A persona posts a *Not answering*, *Still not answering* or *Answering again* notice" below).

When agent-director can't end the persona's old worker, the persona is retried the same way, and its destination gets a *Kill failed* notice (see "A persona posts a *Kill failed* or *Process outlived kill* notice" below).

**A persona waits on an old instance in its working directory**
Symptom: a persona stays silent and is not brought up, while an old instance may still be running in its working directory. The server brings no persona up in a directory until agent-director reads the old instance's row ended or missing, so two workers never share one directory. It happens:

- after a confirmed removal, rename, or `working_directory` or `credentials_file` path change, until the old instance has ended: a renamed persona's new name, and any persona whose working directory is the old one, wait (a changed persona's own new conversation also starts only then, once its replacement of the old instance has ended it; see [Destructive changes](#destructive-changes));
- after a server start whose clean-up of old instances could not end a stale instance, for any persona whose working directory is that instance's;
- after a server restart, while a retired persona's old instance is still running there.

What you see:

- The persona's Slack connection is up, but its instance is not launched and it posts nothing about the wait. Each launch of it makes no agent-director call and logs `[slack] spawnForPersona: not launching "<name>" (key=<key>) — its working directory "<path>" is held for an old life that may still be running (instanceId="<id>": wait <state>); waiting on it, its retry timer is armed (held-for-old-life); no agent-director call (sequence-waiting; b.jg5 SRJ-810, SRJ-1502)`. A server start counts it under `waiting on a live-row sequence` (see "Reading the start summary" below).
- A restart of it, including one a lost message starts, does nothing and logs `[slack] Skipping restart for persona=<key> — its working directory is held for an old life that may still be running; no agent-director call, nothing recorded (sequence-waiting; b.jg5 SRJ-810, SRJ-812)`. A persona that was already running when the old instance began to hold its directory is left running: it is not reconnected, killed or relaunched until the hold ends. A restart while the server is stopping, or of a persona that is not up, ends before this check and logs no such line.
- A Claude Code session started from that directory is refused and disconnected, whichever persona names the directory: `[slack] Session refused: its working directory "<path>" is held for an old life that may still be running (instanceId="<id>") — registered as no persona's session until the hold ends (b.jg5 SRJ-810, SRJ-1505)`.
- Nothing is typed into the old instance: the server never sends it `/mcp reconnect`.

Meanwhile the server keeps ending the old instance in the background, with the same checked kills and `find-missing` checks it uses to replace a persona's instance, and never launches it. An agent-director that can't be reached only delays that: the waiting persona is retried on its own, with nothing counted toward the restart limit. Nothing about the old instance is posted to Slack: each failure goes to `server.log` and `startup-errors.log` (a failed kill as a `persona-kill-failed` entry, a surviving process as `persona-kill-survivor`, and a session conflict or an unusable session name as `persona-teardown-notice`; see [Startup errors](#startup-errors)). Only a *tmux unavailable* or *agent-director refuses its config file* notice met there reaches the waiting persona's destination, as for any of its calls.

A message lost for the persona meanwhile reports `restarting` while the server is ending the old instance, `kill failed` once a kill of it has failed, and otherwise the state that applies; a `starting now` restart brings the persona up only once the old instance has ended (see "Session not restarting after crash" above).

The persona comes up by itself, at once, once the old instance's row reads ended or missing: `[slack] old-life hold: ended for instanceId="<id>" — retrying its waiting personas at once: <keys>[; once the stopped wait on its own row has settled: <keys>][; not retried: <key> (<why>)] (b.jg5 SRJ-810)`, a persona removed, held for a human, held on rejected launch flags (see "A persona posts a *Cannot launch* notice" below) or not up meanwhile named as not retried (`not applied`, `latched`, `held on ErrInvalidFlags`, `not up`). A persona that is held or not up gets no retries from the server's work on the old instance either (`[slack] old-life-wait: persona=<key>: held on ErrInvalidFlags — no retry timer armed …` or `… not up — no retry timer armed; its bring-up owns it …`); a persona that is not up is brought up by its own bring-up retries. A persona whose own earlier instance is the old one is retried a moment later, once the server has stopped ending that instance: `[slack] old-life hold: the stopped wait on instanceId="<id>" has settled — persona=<key> retried at once (b.jg5 SRJ-810)`, or `… not retried (<why>) …` when it was removed, held or not up meanwhile. A renamed persona's new name then starts a new conversation. If the old instance's kill keeps failing, a human follows the "Operator actions" section of agent-director's README for it; the persona then comes up with no server restart. To follow it:

```sh
grep -E 'held for an old life|old-life hold: |old-life-wait' ~/.claude/channels/slack/server.log
grep -E '\(old-life wait\)|raised during its old-life wait' ~/.claude/channels/slack/startup-errors.log
agent-director get --claude-instance-id <id>
```

The `debug-slack-channel-bots` skill explains every line.

**Bot alive but silently unresponsive (MCP disconnected)**
A bot can stay running yet lose its MCP connection to the server — the process is alive but no longer reachable, so it stops responding without ever emitting a disconnect event. The periodic health-check recovers this automatically: once a persona is seen alive-but-disconnected on two consecutive ticks, the health-check schedules a reconnect (or a relaunch if the process has since died), so a stranded persona comes back with no inbound message and no server restart. The recovery lands within roughly two `health_check_interval` periods (default 120 s each) plus the restart backoff delay (default `session_restart_delay` 60 s) before the reconnect runs — about 3–5 minutes with default settings. A bot mid-turn (`working` state) is deliberately left alone and reconnected on a later tick once its turn ends. agent-director can keep reporting a bot as `working` after its turn has ended. Such a bot is reconnected anyway, on a later reconnect attempt, once for at least a minute both of these have held without changing: its screen shows no busy spinner, API retry message, prompt or dialog, and its conversation transcript ends with a finished reply. Every persona's Claude runs with Claude Code's prompt suggestions off (`CLAUDE_CODE_ENABLE_PROMPT_SUGGESTION=false`), which removes a likely cause of such a stale `working` state, so a session you attach to shows no suggested prompt. The health check's reconnect never types into a bot whose screen shows a running turn or a prompt, whatever state agent-director reports, and types nothing while agent-director can't report the bot's state; a later tick retries. The reconnect is typed once and never repeated on the spot: when agent-director can't carry it out right now (it is unreachable or timed out, tmux is unavailable, or it gives an answer the server doesn't handle), the reconnect posts no failure notice of its own, nothing counts toward the restart limit, and the persona is tried again later; an outage it meets still posts that outage's notice, as for any other refused call (see "A persona is retried after agent-director refuses it" above); when it meets a tmux session conflict, the persona is held instead, with nothing typed (see "A persona posts a *Held: tmux session conflict* notice" below). A bot waiting on a prompt or dialog is reported instead (see "A persona posts a *Waiting on a prompt*, *Not connected* or *Not receiving messages* notice" below). So is a bot agent-director reports as `working` that the server has held back from for 10 minutes without being able to tell that it's idle, whatever `session_restart_delay` is: the persona's destination gets a *Not connected* notice. With `session_restart_delay` set to `0` the health check reconnects nothing; the persona's destination gets a *Not connected* notice instead. A bot killed mid-turn is not waited on either: when agent-director reports that no pane of the bot's session is there (or that it has no record of the bot at all), the server types nothing into it, and the restart that learns this relaunches it, with no external `find-missing` sweep needed, once agent-director has marked the bot's row ended or missing; until it has, the server waits for it (see "A persona posts a *Slow recovery* notice" below). When agent-director reported that no pane of the bot's session is there, the relaunch resumes the bot, keeping its conversation; if agent-director still reads the bot's row as running when the relaunch resumes it, the server first ends that old session through agent-director, then resumes the bot, still keeping its conversation. The same goes for a bot killed between turns, and for one killed with a prompt open (agent-director reports no pane of its session, or no record of it). A server start resumes such a bot.

Only that proof, that the bot's session is gone, leads the server to end a session agent-director still reads as running. When agent-director refused the reconnect, or had already finished the bot's row or had no row for it, nothing is killed and no running instance is replaced on that finding: a finished bot is resumed, and one agent-director still reads as running, or in a state this server version doesn't know, is left alone and checked again at its next health check or retry. A state the server doesn't know never leads it to end a session, even after that proof. A bot whose launch is still in progress is left alone as well, while it starts.

A closely related symptom is a bot that still *looks* connected but silently drops every inbound message — its underlying message stream went away without the connection registering as closed. The same health-check path recovers this on the same two-consecutive-tick cadence, so no inbound message or server restart is needed; with `session_restart_delay` set to `0` the persona's destination gets a *Not receiving messages* notice instead. A message for such a persona that arrives before recovery lands is lost, and the persona's destination gets a lost-message notice as described under "Session not restarting after crash" above.

To verify recovery in the field, tail `server.log` for a stranded persona and confirm a tick-driven recovery lands — look for a `[slack] Scheduling restart for persona=<key> in <N>s (backoff)` line and a `[slack] Session alive but disconnected — reconnecting MCP for persona=<key>` line naming that persona's key. When the bot is mid-turn, with its busy spinner or an API retry message on screen, that line is followed by `[slack] reconnectSession: persona=<key> is working — deferring /mcp reconnect to a later tick (b.9a7/b.rmy)`, and a later tick reconnects it. A bot reported `working` whose screen sits idle and whose transcript ends with a finished reply logs `[slack] reconnectSession: persona=<key> is working; its pane shows an idle screen (no busy indicator, no prompt) and its transcript ends with a completed turn, both unchanged for <N>s of the 60s needed — deferring /mcp reconnect to a later tick, which reads them again (b.f2b)` instead, and then, once both have stayed the same for a minute, `[slack] reconnectSession: persona=<key> reads working, but its pane has shown the same idle screen (no busy indicator, no prompt) and its transcript has ended with a completed turn, both unchanged, for <N>s — treating the row as stale and reconnecting (b.f2b)`. An idle screen whose transcript doesn't end with a finished reply, or can't be read, logs `[slack] reconnectSession: persona=<key> is working and its pane shows an idle screen, but <why> — no idle evidence; deferring /mcp reconnect to a later tick (b.f2b/b.rmy)` and is not reconnected. A bot killed mid-turn logs `[slack] reconnectSession: persona=<key> is working but agent-director's read-pane found no pane of its launch: <error> — not deferring; sweeping and escalating (escalate-dead); the restart path's re-probe decides (read-pane class=<CLASS>; b.d61, b.jg5 SRJ-603)` instead, then `[slack] escalate-dead: persona=<key> verdict=working-tmux-gone — agent-director's read-pane found no pane of the row's launch (GONE) on its working row, triggering internal findMissing reconciliation (the row may stay live for further ticks, each escalate-dead tick sweeping again; ~/startup/find-missing-loop.sh is belt-and-braces)`. The server then checks the row again, and that check decides: once agent-director reads the row dead it logs `[slack] Session reads dead after escalate-dead reconciliation — relaunching in this restart run for persona=<key> (b.d61)` and `[slack] Relaunching session for persona=<key> cwd="<path>"` right after; while agent-director still reads the row live it logs `[slack] Session still reads live after escalate-dead — no relaunch in this restart run for persona=<key>; the row may stay live for further ticks, each escalate-dead tick sweeping again`, relaunches nothing, and the row is swept again at later health checks until it reads dead (see "A persona posts a *Slow recovery* notice" below). A **capped** persona is exempt: the health-check skips it entirely, including reconnects, so a capped persona still requires a server restart (see above).

At a server start, a persona whose instance agent-director reports as `working` is reconnected once its turn ends, and it doesn't hold up the other personas or the health check. `server.log` shows `[slack] startupSessionManager: "<name>" (key=<key>) is waiting for its working row to settle — the start pass goes on without it; its launch stays in flight in the background (b.f2b)`, then, when the wait ends, `[slack] startupSessionManager: background launch for "<name>" (key=<key>) settled: <outcome> (b.f2b)`. `reconnected` means the reconnect was typed into the session; `not-reconnected` means the session was left running without it, and the line just before says what happens next. An idle screen and a transcript ending with a finished reply (or with a turn you interrupted), both unchanged for a minute, end the wait with a reconnect, and a prompt or dialog on screen for a minute raises a *Waiting on a prompt* notice. Otherwise the wait gives up after 10 minutes; if agent-director still reports the persona as `working` then, its destination gets a *Not connected* notice. While agent-director can't report the persona's state, the wait keeps waiting and posts nothing; if it still can't after 10 minutes, the instance is left running for the health check (with `session_restart_delay` set to `0`, a *Not connected* notice reports it), with no `spawn-failed` entry and nothing counted toward the restart limit. If agent-director no longer has a row for the persona, it is relaunched. Removing the persona with a confirmed change ends its wait at once, with nothing typed.

**Reading the start summary**
Each server start logs one summary line in `server.log` when its launches have settled or are waiting in the background:

```text
[slack] startupSessionManager: complete — <N> persona(s): <n> resumed, <n> fresh-spawned, <n> fresh-after-amnesia, <n> fresh-after-inconclusive-amnesia, <n> reconnected, <n> no-op, <n> failed, <n> not brought up, <n> not reconnected, <n> latched, <n> retrying, <n> waiting on a live-row sequence, <n> held on invalid flags, <n> fresh as retired keys
```

Each persona is counted once, except one whose launch is still waiting in the background (see above): it is in no count, and the next line gives how many:

```text
[slack] startupSessionManager: <n> persona(s) still waiting in the background for a working row to settle — not counted above; each logs its outcome when it settles (b.f2b)
```

None of the last five counts is a failure, and none is counted as `fresh-spawned`:

- `latched`: the persona is held until a human acts (see the *Held* entries below).
- `retrying`: agent-director refused the launch, and the persona is retried on its own (see "A persona is retried after agent-director refuses it" above).
- `waiting on a live-row sequence`: the persona's old instance, still running, is ended first, and its new launch follows (see "Bots come back with no memory of the prior conversation after a reboot" below); or an old instance may still be running in its working directory, and the persona comes up once that instance has ended (see "A persona waits on an old instance in its working directory" above).
- `held on invalid flags`: agent-director rejected the persona's launch flags (see "A persona posts a *Cannot launch* notice" below).
- `fresh as retired keys`: a persona whose key was retired came back on a new conversation (see "Bots come back with no memory of the prior conversation after a reboot" below).

`not brought up` counts personas held before their launch: missing credentials, a missing working directory, a `claude_config_dir` that can't be resolved yet, or Slack refusing or unreachable. A persona whose Slack connection is still being retried is counted there, never under `retrying`. A start during which the server begins stopping (a `stop`, or the agent-director version re-check) launches no persona still waiting for its turn: each logs a `not launching … — the server has begun shutting down` line and is in no count.

**A persona posts a *Waiting on a prompt*, *Not connected* or *Not receiving messages* notice**
Each of these notices means the persona's session is running but messages can't reach it, so messages sent to it are lost. At most one of them is posted to the persona's destination per episode: after one is posted, none is posted again until the persona's session connects to the server again or the health check finds it reachable again. `server.log` shows `[slack] session-manager: persona=<key> is not connected (<reason>) — raising a not-connected notice (b.f2b)` when it is posted. The `=` in the attach commands below and in the notices attaches to that exact session only, never to another persona's session whose name starts with it.

- *Waiting on a prompt* (`blocked-on-prompt`): the session shows a permission prompt, question or dialog that no one has answered. Once the session has started, the server never types into a prompt. It posts this notice only while agent-director still reports a pane of the persona's session (or can't answer, which is no proof the session is gone). A session that died with a prompt open, which agent-director keeps reporting as waiting on the prompt, is relaunched instead, with no notice; `server.log` shows `… but agent-director's read-pane found no pane of its launch: <error> — not deferring; …`. Once the prompt has kept the persona disconnected for 10 minutes, each later health-check retry also has agent-director check that its Claude process still runs, and relaunches the persona if it doesn't. Attach with `tmux attach -t =slack_bot_<key>` and answer it; a permission prompt that was also posted to the persona's destination can be answered there instead. Once it is answered, the server reconnects the persona when it can tell the session is idle again; if it stays disconnected, type `/mcp reconnect slack-channel-router` there. With `session_restart_delay` set to `0`, if it is still not connected once its turn ends, type that command there or restart the server.
- *Not connected* (`auto-restart-disabled`): `session_restart_delay` is `0`, so nothing will reconnect the persona. The notice says why it isn't connected. Attach with `tmux attach -t =slack_bot_<key>`, deal with anything on screen and type `/mcp reconnect slack-channel-router`, or restart the server.
- *Not connected* (`unproven-idle`), at any `session_restart_delay`: agent-director reports the session as `working`, but the server can't prove it's idle, so it won't type into it, and it has held back from it for 10 minutes. For example, its transcript can't be read, or its screen keeps changing. Attach with `tmux attach -t =slack_bot_<key>`: let a running turn finish and answer anything on screen; if it sits idle at its prompt, type `/mcp reconnect slack-channel-router` there. With `session_restart_delay` above `0` the server keeps checking and reconnects it once it can tell it's idle; with `0`, restart the server if it stays disconnected.
- *Not receiving messages* (`auto-restart-disabled`): the session is connected, but its message stream has been gone on two health checks in a row, and `session_restart_delay` is `0`, so nothing will restore it. Recover it as for *Not connected*.

**A persona posts a *Not answering*, *Still not answering* or *Answering again* notice**
These notices mean agent-director or tmux is not answering for the persona's session (named in the notice as `"slack_bot_<key>"`): agent-director refused a call that starts, resumes or stops the persona's instance, reads its screen or types into it, while the server was launching or recovering the persona. They are about that one persona, not an agent-director outage. A failed call that only reads the persona's state never produces them.

- *Not answering*: posted only if the session is still not answering at the next health check after the first refusal; a single short refusal that clears by then posts nothing. With `health_check_interval` set to `0`, it is posted at the first retry at least 2 minutes after the refusal began. Nothing is needed at this point: the server keeps retrying the persona on its own (see "A persona is retried after agent-director refuses it" above), never counts it toward the restart limit and takes no destructive action. It is skipped when *Still not answering* has already been posted for the episode. It is posted only while the server is retrying the persona: while its retries are stopped it is not posted, until a later refusal starts them again in the same episode (retries a health check restarts on its own don't count); after the persona was torn down or removed from the configuration, or once the server is stopping, it is never posted again in that episode.
- *Still not answering*: posted once the session has not answered for longer than the alert threshold, which comes from agent-director's timing settings in effect: the longer of `stopping_window_seconds` and `starting_session_seconds`, plus 60 seconds (about 6 minutes at agent-director's defaults; see [agent-director's timing settings](#agent-directors-timing-settings)). The notice states the threshold in whole minutes. The retries continue. It is posted only while the server is retrying the persona: if its retries stop first, it is not posted, unless a later refusal starts them again in the same episode; after the persona was torn down or removed from the configuration, or once the server is stopping, it is never posted again in that episode, even if its retries had already stopped before that.
- *Answering again*: posted when the persona reaches its session again, only after a *Not answering* or a *Still not answering*. When the episode began with a launch that timed out, it is posted once the server reads that launch's new session as started, or earlier when the server reaches the session's screen while answering its startup prompt.

From the first refusal until the session answers again, a message sent to the persona is lost. While the server is retrying the persona, its lost-message notice reports `not answering`, with no restart started. At the restart limit it reports `restart limit reached` instead; if the persona's retries have stopped, it reports the next state that applies, which can be `starting now`.

The usual order is *Not answering*, *Still not answering*, *Answering again*; when *Still not answering* comes first (for example with `health_check_interval` `0` and a 3-minute alert threshold), *Not answering* is skipped. Each is posted at most once per episode, from the first refusal until the session answers again; a later refusal starts a new episode. After *Still not answering*, a human should check the host's tmux server and agent-director, with read-only checks only, for example `agent-director version`, `agent-director get --claude-instance-id cscb_<key>` and `timeout 10 tmux list-sessions`. Run `tmux list-sessions` as the user the workers run as, with their tmux socket, since another user or socket asks a different tmux server; it shows only whether tmux answers, never whose a session is, so take ownership from agent-director's row, never from this list. Never run a command that ends a session or deletes an agent-director row to clear it: once agent-director and tmux answer, the next retry recovers the persona and *Answering again* follows. To follow one persona's episode:

```sh
grep -E 'persona-episodes: persona=<key> tmux-unresponsive (started|onset|alert|ended|recovery)' ~/.claude/channels/slack/server.log
```

`[slack] persona-episodes: persona=<key> tmux-unresponsive started — <verb> failed: <error>` marks the first refusal, `… onset posted — still not answering at <a health tick|a retry>, <s> s after its first refusal` the *Not answering* notice, `… alert posted — not answering for <s> s, over its alert threshold of <s> s` the *Still not answering* notice, `… onset not posted — its alert already posted` and `… onset not posted — its retry timer stopped and no refusal has re-armed it` a skipped *Not answering*, `… alert check cancelled — its retry timer stopped: <reason>` and `… alert check armed again — a new refusal armed its retry timer again` the alert's check stopping and starting with the retries, and `… ended — <reason>` followed by `… recovery posted` the *Answering again* notice. Once a confirmed change's teardown of the persona is queued, none of the three notices is posted. Until the teardown starts, `… onset not posted — muted, its persona teardown was submitted; …`, `… alert not posted — muted, its persona teardown was submitted; …` and `… recovery not posted — muted, its persona teardown was submitted` take the place of the posted lines; while it runs, a notice is written as a `persona-teardown-notice` entry instead (see [Startup errors](#startup-errors)). The `debug-slack-channel-bots` skill explains every line.

**A persona posts a *Slow recovery* notice**
Symptom: the persona is silent, and its destination has a notice reading `:hourglass_flowing_sand: *Slow recovery* — agent-director has not yet marked the worker row of this persona's session "slack_bot_<key>" ended or missing. CSCB keeps retrying; no action is needed unless this persists.`

The server found the persona's session gone, but agent-director still reports the persona's row as live, so the server can't relaunch it yet: it relaunches a persona only once agent-director has marked its row ended or missing. agent-director can take several health checks to do so.

Meanwhile the server asks agent-director to reconcile the row again at each health check that finds the session gone, and relaunches the persona as soon as the row reads ended or missing. It kills, deletes and relaunches nothing else for it, and counts nothing toward the restart limit. The notice is posted once, after the third such health check in a row that still found the row live; a health check that finds the persona healthy (live, connected and with its stream) in between, a restart that finds it already reconnected or still starting (`pending`), or a restart whose reconnect ends without an `escalate-dead` verdict starts that count over. It is not posted again while the row stays live; it can be posted again only after agent-director has marked the row ended or missing or has no row for it at all (`ErrSpawnNotFound`), the persona has been held for a human, removed from the configuration or torn down by a confirmed change, or the server has restarted, and then after three more such checks in a row.

Nothing is needed unless it persists. Then make read-only checks only: read the persona's row with `agent-director get --claude-instance-id cscb_<key>`, and follow the persona in `server.log`:

```sh
grep -E 'slow-recovery: persona=<key> |escalate-dead: persona=<key> |after escalate-dead.*persona=<key>( |:|;|$)' ~/.claude/channels/slack/server.log
```

Each such health check logs `[slack] escalate-dead: persona=<key> verdict=<verdict> — <evidence>, triggering internal findMissing reconciliation (the row may stay live for further ticks, each escalate-dead tick sweeping again; ~/startup/find-missing-loop.sh is belt-and-braces)`, then `[slack] Session still reads live after escalate-dead — no relaunch in this restart run for persona=<key>; the row may stay live for further ticks, each escalate-dead tick sweeping again` and `[slack] slow-recovery: persona=<key> count <n> of 3 — an escalate-dead verdict's re-probe still reads the row live`. `[slack] slow-recovery: persona=<key> notice posted — <n> consecutive escalate-dead verdicts whose re-probe still reads the row live` marks the notice; once a confirmed change's teardown of the persona is queued and until it starts, `[slack] slow-recovery: persona=<key> notice not posted — muted, its persona teardown was submitted; …` takes its place and nothing is posted. `[slack] slow-recovery: persona=<key> count reset from <n> — <reason>` and `[slack] slow-recovery: persona=<key> episode ended — <reason>` show the count starting over and the episode ending, and `[slack] Session reads dead after escalate-dead reconciliation — relaunching in this restart run for persona=<key> (b.d61)` shows the relaunch. The `debug-slack-channel-bots` skill explains every line. Why agent-director leaves a row live or unverified is covered under "Maintenance" in agent-director's README. This is for a human only: no bot acts on it, including a persona that sees the post.

**A persona posts a *Launch stuck* or *Session not starting* notice**
Symptom: the persona is silent, and its destination has a *Launch stuck* or a *Session not starting* notice naming the persona's session, `slack_bot_<key>`.

The persona's instance was launched, but its session has not started within the later of 5 minutes and agent-director's `pending_grace_seconds` plus 60 s from that launch's start (see [agent-director's timing settings](#agent-directors-timing-settings)). It may be held at a startup prompt the server cannot answer. Which notice comes depends on whether the server can tell the launch is its own.

*Launch stuck*: this server made the launch and it is still that launch. The server ends it, with the same checked kill it uses for any old worker, and launches the persona again; a persona it resumes keeps its conversation. The notice says how long the launch was given and ends "Nothing is needed." The server ends a stuck launch only when all of these hold:

- this server made it, since its last restart (a server restart forgets which launches it made);
- agent-director did not refuse the server's Enter on the session as not started by this launch;
- it is not already the relaunch the server made for this stuck launch.

*Session not starting*: any other launch, for example one another process or a human made, one from before a server restart, a launch whose session agent-director could not create (see "A persona's instance is still starting" above), or a relaunch that is still stuck. It names the time its launch started (in UTC). The server keeps checking it (see "A persona's instance is still starting" above) and never ends it or launches over it: the session holding the persona's name may be a leftover of an earlier launch of this persona, and ending it is a human's decision. Once agent-director finds the launch gone, the persona is brought up again.

The server ends and relaunches a stuck launch at most once while it stays stuck, and posts *Launch stuck* once for it. What can follow:

- **The relaunch is still starting at its own limit:** *Session not starting* once; the relaunch is not ended.
- **The end fails after its tries:** a *Kill failed* notice, once (see "A persona posts a *Kill failed* or *Process outlived kill* notice" below). Nothing is relaunched, and a later check posts *Session not starting* once.
- **The end is refused as not this launch's session:** the persona is held, with one *Held: tmux session conflict* notice (see "A persona posts a *Held: tmux session conflict* notice" below). The end is never tried again. An unusable tmux session name holds it the same way (see "A persona posts a *Held: unusable tmux session name* notice" below).
- **agent-director could not carry out the end for now** (it is not answering, or can't act right now): a later retry tries it again, with no second *Launch stuck* notice. When tmux is unavailable, or agent-director refuses its config file, that retry waits until the problem clears.
- **The persona stopped being up while the end was being tried:** nothing is posted, and once it is up a later retry tries the end again, with no second notice.

Neither notice is posted, and nothing is ended, while tmux is unavailable for the persona: the *tmux unavailable* notice is then the persona's notice (see "A persona posts a *tmux unavailable* or *tmux server changed* notice" below). While agent-director refuses its config file, the server's own stuck launch (a relaunch after the server already ended it once included) gets neither notice and is not ended; once the file is fixed, it gets *Launch stuck* and the relaunch, or *Session not starting* if that one end was already made. Any other stuck launch still gets *Session not starting* meanwhile (see "A persona posts an *agent-director refuses its config file* notice" below). Nor is either notice posted while the persona is held for a human; the hold's own check is then the only check made (see "The server's own check" under "A persona posts a *Held: tmux session conflict* notice" below).

Each notice is posted at most once while the launch stays stuck, at the first check at or after that time. Either can be posted again only after the session has started, the persona has been held or torn down, or the server has restarted.

When the server's attempt to press Enter on the session was refused because the session holding the name was not started by this launch, the *Session not starting* notice says so and leaves out the attach remedy: answering that session's prompt would not start this launch.

What to do: for *Launch stuck*, nothing. For *Session not starting*, a human chooses among the notice's remedies. This is for a human only: no bot acts on it, including a persona that sees the post.

- Look at the session and answer its startup prompt (only when the notice lists this remedy):

  ```sh
  tmux attach -t =slack_bot_<key>
  ```

- See which agent-director rows record the session name (on the command line; over MCP, `list` ignores this filter):

  ```sh
  agent-director list --tmux-session-name slack_bot_<key>
  ```

- To end the launch, follow the "Operator actions" section of agent-director's README. The server's next check then finds the launch gone and brings the persona up again.

To follow the checks, the notices and the relaunch for one persona:

```sh
grep -E 'pending-row: ("[^"]*" \(key=<key>\)|persona=<key> )|pendingRowRule stuck-launch abort: .*cscb_<key>|stopping the approver for "[^"]*" \(key=<key>\) \(stuck-launch-abort\)' ~/.claude/channels/slack/server.log
```

Each check from the grace period on logs `[slack] pending-row: "<name>" (key=<key>) rule (retry): launch started <time>; …` naming what it found and what follows (`rule (approver-stop)` for the check when the startup-prompt watch stops). `… at B: the held text; the row is left, never killed (b.jg5 SRJ-410)` is logged at every check at or after the limit, not only the one that posts the notice. The poster's line logged right after it tells which: `[slack] pending-row: persona=<key> stuck-launch held text posted` (`held text (no attach line: …) posted` for the form without the attach line) means the notice was posted then, and `… stuck-launch held text not posted — already posted in this stuck-launch episode` means an earlier check posted it.

For the server's own launch the check logs `… at B: CSCB's own stuck launch: the relaunching post and the abort (<kind>) (b.jg5 SRJ-410)` instead, after these lines:

- `[slack] pending-row: persona=<key> stuck-launch relaunching text posted`: the *Launch stuck* notice (`… not posted — already posted in this stuck-launch episode` when a later retry tries the end again);
- `[slack] pending-row: persona=<key> stuck-launch abort started for "<name>" (key=<key>) (launch started <time>) — …`: the end begins, after the startup-prompt watch is stopped (`stopping the approver for "<name>" (key=<key>) (stuck-launch-abort): …`);
- `[slack] pendingRowRule stuck-launch abort: kill try <n> of 3 for cscb_<key>: …`: each try of the end;
- `[slack] pending-row: persona=<key> stuck-launch abort kill: <kind> (<outcome>) — <what follows>`: how the end went (`succeeded`, `kill-failed`, `latched`, `try-later` or `stopped`);
- `[slack] pending-row: persona=<key> stuck-launch abort: the live-row sequence started at its second step, keeping a resumed launch's conversation …`: the relaunch began;
- `[slack] pending-row: persona=<key> stuck-launch abort not made — <why>`: no end this round, and why (for example `the stuck-launch episode's one abort was used, …` for a relaunch still stuck).

The `debug-slack-channel-bots` skill explains every line.

**A persona posts a *tmux unavailable* or *tmux server changed* notice**
agent-director answered a call for the persona that it can't use tmux for it, and the persona's destination gets one of two notices, once, from whichever answer comes first. Either way, the server retries the persona on its own (see "A persona is retried after agent-director refuses it" above), counts nothing toward the restart limit, and kills, deletes and relaunches nothing because of it. While the notice holds, the health check never restarts or reconnects the persona, and a stuck launch gets no *Launch stuck* or *Session not starting* notice and is not ended (see "A persona posts a *Launch stuck* or *Session not starting* notice" above). A message sent to it meanwhile is lost, and its lost-message notice reports `not answering`, with no restart started. Neither a lost message nor a dropped session connection ever starts a restart: if the persona's retries are not running, either one starts them instead, even with `session_restart_delay` and `health_check_interval` both `0`, unless the persona is held for a human or a launch of it is running (the notice then reports `held for a human` or `starting`). At the restart limit nothing is started, and the notice reports `restart limit reached` (or `restarting`, `auto-restart disabled` or `starting`, when one of those applies first).

- *tmux unavailable*: tmux can't be used for the persona. Follow the notice's own advice.
- *tmux server changed*: the persona's tmux socket now reaches a different tmux server from the one its worker was launched on, so agent-director will not act on its session. A human follows the "Operator actions" section of agent-director's README. This is for a human only: no bot acts on it, including a persona that sees the post. Don't install or repair tmux for this notice.

The notice clears only once the persona's tmux answers again: a call that works the persona's session succeeds, a call that works it is told the session is gone, or the health check or a retry finds the persona running, connected and receiving messages. A state read that succeeds while tmux still can't be used doesn't clear it. When it clears and nothing else is wrong for the persona, its destination gets an *All clear.* notice naming `tmux-unavailable`. To follow one persona:

```sh
grep -E 'unavailable-retry: persona=<key> ' ~/.claude/channels/slack/server.log
```

`[slack] unavailable-retry: persona=<key> armed (environment: <error>) — first retry in 30 s` marks the first such answer, or `promoted to full mode (environment: <error>) — its due time is kept` when the persona's retries were only reading its state. Once it clears, the last line is usually `stopped — nothing left to recover` (a retry found the persona healthy) or, after a retry relaunched it, `kept — the tmux-unavailable condition cleared, but its row last read pending` followed later by `stopped (pending-only, row <state>) — its row is live out of pending; nothing else is called`; a clear between retries, by a health check or another call, logs `stopped — the tmux-unavailable condition cleared`.

**A persona posts a *Held: tmux session conflict* notice**
Symptom: the persona is silent, and its destination has a *Held: tmux session conflict* notice naming the persona and its tmux session. The server met one of these:

- agent-director refused to act on that tmux session because of a session conflict, when the server launched or resumed the persona. A launch refused before it started, because a session left over from an earlier launch holds the name, leaves no instance behind and is not counted as a launch failure: this notice is its only post;
- agent-director refused, the same way, a restart's kill of the persona's old instance, the kill a launch makes before it replaces the persona's row, or the server's end of its own stuck launch (see "A persona posts a *Launch stuck* or *Session not starting* notice" above). A kill refused as "not this launch's session" means a session left over from an earlier launch holds the persona's session name and nothing was sent; the server never sends that kill again;
- agent-director had noted conflicting labels on the persona's own row when the server read it (while launching the persona, while checking whether a session whose row reads `working` is really idle, right after the server's own `find-missing` run listed that row as unverified (the run after a hold clears included: see "How a hold ends" below), or when a server start listed its agent-director instances before its clean-up of old ones). This is the "Conflicting labels" case below.

Only the persona's own row counts. agent-director's other notes on a row, and any note on a row that is not one of your personas', never hold a persona.

A persona held at a start keeps its instances: that start's clean-up of old instances ends none of them, neither its own nor any other carrying its label, even one running in another working directory or config directory.

While the persona is held, the server attempts nothing else for it: apart from its own check every 2 minutes (below), it launches, resumes, reconnects and restarts nothing, and the health check and the automatic retries make no attempt for it. Messages sent to it meanwhile are lost, and each one's lost-message notice reports `held for a human`, with no restart started. A *Not answering* or *Unclassified agent-director error* episode the persona had ends with no further notice. Other personas are not affected.

**The server's own check.** Every 2 minutes, whatever `health_check_interval` is (`0` included), the server checks each held persona once: the first check comes 2 minutes after the hold begins, and each next one 2 minutes after the previous one has finished. A check reads the persona's agent-director row once, then makes at most one more call, the one the hold's case allows, or none. Apart from the one restart attempt a *Conflicting labels* hold can get (below), which does what any restart does, the check never ends a session or types into one, never launches over a row that reads as running or still starting, and never repeats a refused kill or keystroke. By the hold's case (the first line of its notice):

| Case | What the check does after its read |
|---|---|
| This row's own id | When the refused launch was a resume or a relaunch on the persona's row, and the row reads ended or missing: one look at the last line of the session's screen through agent-director. Otherwise nothing. Once a launch tried after such a look is refused again with this case, the looks stop for the rest of the hold, and each check that reads the row ended or missing tries the refused launch once more instead. |
| The agent's pane was not found | One look at the last line of the session's screen through agent-director (for a refused resume or relaunch on the row, only once the row reads ended or missing). |
| Left over from an earlier life, No valid instance id, A different instance id, Another agent-director store | A refused resume or relaunch on the persona's row is tried once more, once the row reads ended or missing. A refused first launch: as below the table. Any other refused call: nothing. |
| Not this launch's session | Nothing while the row reads as running or still starting. Once it reads ended or missing, or is gone, one relaunch: a resume of the row when it has a conversation, otherwise a fresh launch on the row, or a first launch when no row is left. |
| Conflicting labels | Its read shows whether agent-director still notes conflicting labels on the row; while it does, nothing. Otherwise: on a row still starting, one look at the last line of its screen, typing nothing; on a running row, one restart attempt, as for any persona; on a row read ended or missing, the refused resume or relaunch tried once more (one restart attempt when the hold came from anything else). |
| A description the server does not recognise | Nothing. |

A refused first launch (every case but "The agent's pane was not found") gets no call while the persona's row reads as running or still starting; once the row reads ended or missing, one launch on that row, and with no row, the launch tried once more. An *unusable tmux session name* or *launch start not recorded* hold gets the read only (see those entries below).

What a check can lead to:

- **No change:** the same case again, or a look at the screen that shows the problem is still there, keeps the hold and posts nothing.
- **The problem looks gone:** a look at the screen that finds it gone does not end the hold by itself. In the same check, the server runs agent-director's `find-missing` once, then tries the refused launch once more (a restart attempt when the hold came from anything but a launch), and that launch's answer decides, as below. When that run fails because agent-director is not answering or can't act right now, tmux is unavailable, agent-director refuses its config file, or with an error the server can't classify, nothing is tried in that check and the hold stays, with no hold or recovery notice (a refused config file or unavailable tmux still raises its own notice); the next check looks again.
- **No information:** an answer that tells the server nothing (agent-director is not answering or can't act right now, tmux is unavailable, or an error the server can't classify) keeps the hold and raises no other notice: no *Not answering*, *tmux unavailable* or *Unclassified agent-director error* notice, and no automatic retries. The next check comes 2 minutes later.
- **No launch this time:** before any launch it would try, the check asks what every other launch asks. When the persona is not up (its Slack connection is not serving, or its bring-up is broken or retrying), is also held on `ErrInvalidFlags` (see "A persona posts a *Cannot launch* notice" below), or its working directory is held for an old instance that may still be running, the check launches nothing and the hold stays, with no post; the next check, 2 minutes later, reads the row and asks again. For an old instance, the server starts ending it as for any launch; the hold's own check, not a retry timer, tries the persona again.
- **agent-director refuses its config file:** the hold is kept, and the persona gets that notice (see "A persona posts an *agent-director refuses its config file* notice" below).
- **Held for another reason:** a launch, restart attempt or look at a still-starting screen answered with another case, an answer of an unusable tmux session name, or a read that finds a launch start not recorded holds the persona again for that reason, with one new notice, and the next checks follow the new hold. A look at the screen for "This row's own id" or "The agent's pane was not found" answered with another case changes nothing.
- **The hold ends**, with one recovery notice: see "How a hold ends" below. When the launch the check made succeeds, or fails outright (agent-director could not create its session, or the working directory is missing), the hold ends and the launch is handled as any other: a success brings the persona up, and a launch failure is counted toward the restart limit with its usual notice.

A server start's clean-up of old instances holds nothing either: when one of its kills meets a session conflict, nobody is held and nothing is posted; the kill is only logged, and recorded as an `orphan-cleanup` entry (see [Startup errors](#startup-errors)). A confirmed change's teardown of the persona (a removal, or the old half of a `credentials_file` path or `working_directory` change) holds nothing: when its kill meets a session conflict, the persona is not held and nothing is posted; the conflict is only logged, to `server.log` and as a `persona-teardown-notice` entry in `startup-errors.log` (see [Startup errors](#startup-errors)). A *Held:* notice that a launch still running raises during the teardown is written there too, not posted.

**How a hold ends.** The hold clears on its own once its cause is gone, found by the server's own check every 2 minutes; no restart is needed. After a human follows the "Operator actions" section of agent-director's README, the server notices within 2 minutes, or the human ends the hold at once with [`clear-latch`](#claude-slack-channel-bots-clear-latch), which also ends a hold the check cannot clear. By the hold (the first line of its notice, or the notice's title for the two row holds below):

| Hold | What the check looks for | It clears when |
|---|---|---|
| Any hold but "Not this launch's session" | The persona's row, at each check | The row is gone, or it reads running when the hold began on a row that was ended, missing, still starting or absent; never while agent-director still notes conflicting labels on it. A refused first launch, or a refused relaunch on the row, whose row is gone is tried again instead (below). |
| This row's own id, The agent's pane was not found | The session's screen, once the row reads ended or missing (for "The agent's pane was not found" after anything but a resume or relaunch, at each check) | The look finds the problem gone, and the refused launch, or the restart attempt, tried once more after it is not refused. |
| Left over from an earlier life, No valid instance id, A different instance id, Another agent-director store | The refused resume or relaunch, tried again once the row reads ended or missing | That launch is not refused. |
| A refused first launch (any case) | The launch tried again: with no row, as it was; on a row read ended or missing, a launch on that row | That launch is not refused. |
| Not this launch's session | The row reading ended or missing, or gone | The one relaunch is not refused. A row that reads running never clears it. |
| Conflicting labels | Whether agent-director still notes conflicting labels on the row | The note is gone, and a look at a still-starting screen finds a screen or no session, or the restart attempt or launch tried again is not refused. |
| *Held: unusable tmux session name* | The persona's row | The row is gone; the persona then comes up fresh. |
| *Held: launch start not recorded* | The persona's row | The row reads running, ended or missing, or is gone. |
| A description the server does not recognise | The persona's row | Only when the row is gone or has started running, as the first row says; otherwise only `clear-latch`, a removal, a destructive change or a server restart ends it (below). |

A launch or restart attempt the check makes is "not refused" when it succeeds or fails outright (agent-director could not create its session, or the working directory is missing); a failure is then counted toward the restart limit with its usual notice.

When a hold clears, the persona's destination gets one recovery notice, once per clear: *Conflict cleared* for a tmux session conflict, *Hold cleared* for an unusable tmux session name or a launch start not recorded. It says why the hold cleared (the row is gone, the row reads a given state, a retry was not refused, the row finished and a relaunch was not refused, or it was cleared by hand) and closes with "CSCB is recovering this persona again." The persona is then brought up:

- **Cleared by the check's read, or by a look at a still-starting screen, or a launch start not recorded whose row reads ended or missing, or by `clear-latch`:** nothing was launched, so the server brings the persona up at once, as a restart would. When the read found the row gone or running, and after `clear-latch`, it first runs agent-director's `find-missing` once, so a note your action has made stale is gone before the row is read again; if agent-director still notes conflicting labels on the row after that run, the persona is held again, with one new notice. When that run fails (agent-director not answering, for example), nothing is launched then and the persona's automatic retries take over (see "A persona is retried after agent-director refuses it" above).
- **Cleared by a launch or restart attempt the check made:** that attempt's result stands, and nothing is launched a second time.

A launch the check makes that meets the same case again keeps the hold and posts nothing. One that meets another case, or an unusable tmux session name, holds the persona again for that reason, with one new hold notice and no recovery notice. A persona whose hold has cleared and that later meets a problem again is held again, with one new notice.

The hold also ends in these ways. A human runs [`clear-latch`](#claude-slack-channel-bots-clear-latch) for the persona, once the cause is resolved; a persona whose cause is still there is held again, with one new notice. Removing the persona from the configuration (a confirmed change) ends its hold, with no post. A destructive change (its name, credentials file or working directory) also brings the persona up unheld; it is held again, with one post to its destination, only if it meets a conflict again: at its launch, or when the server later reads conflicting labels on its own row. The hold is kept in the server's memory only, so a server restart drops every hold; a persona whose conflict is still there is held again, with one new post: at that start, when its listing shows conflicting labels on the persona's own row, or else at its next launch.

The notice is posted once per hold, even when the persona already has a *Waiting on a prompt* or *Not connected* notice. When agent-director refused a launch or resume, the notice quotes agent-director's description of the conflict, with anything that looks like a token removed. When the hold came from conflicting labels noted on the row, the notice names the persona's own tmux session (`slack_bot_<key>`) and quotes no description. Its first line names the case:

| Case | What it means | Operator actions pointer |
|---|---|---|
| This row's own id | The persona's own session, or its worker process, still runs although agent-director has marked the persona finished; the worker may be hung. | Yes |
| Left over from an earlier life | A session left over from an earlier launch of this persona holds the name, or still carries the persona's label under another name. | Yes |
| Not this launch's session | A session left over from an earlier launch of this persona is there. | Yes |
| No valid instance id | A session with no valid agent-director label holds the name. | Yes |
| A different instance id | Another agent-director row's session holds the name. **It must not be ended.** | No |
| The agent's pane was not found | The worker's recorded pane is gone or was replaced, or a leftover session has no pane agent-director can find. | Yes |
| Conflicting labels | Two sessions carry the same launch's agent-director label, or an agent-director label value is set at tmux's server, global or global-window scope. | Yes |
| Another agent-director store | A worker of another agent-director store sharing this tmux server holds the name. **It must not be ended.** | Yes |

A description the server does not recognise gets a general first line with no case, and the pointer.

What to do: for every case with a pointer, a human follows the "Operator actions" section of agent-director's README for the session the notice names. This is for a human only: no bot acts on it, including a persona that sees the post. The notice gives one read-only check, to see which agent-director rows record the session name (on the command line; over MCP, `list` ignores this filter):

```sh
agent-director list --tmux-session-name <name>
```

To follow one persona's hold in `server.log`:

```sh
grep -E 'conflict-latch: (persona=<key> |re-check of .*\(key=<key>\) )|latch-recheck: .*\(key=<key>\)|latch-clear: .*(\(key=<key>\)|persona=<key> )|\(key=<key>\): .*— CONFLICT: |\(key=<key>\) latched from its own listed row |\(key=<key>\): forgetting its latch failed|\(key=<key>\) — .*latched \(case=|(Not scheduling|Skipping) restart for persona=<key> — the persona is latched|Session relaunch for persona=<key> ended latched|reconnectSession: persona=<key> is latched|unavailable-retry: persona=<key> (stopped.* — the persona is latched|the latched query failed)|persona-episodes: persona=<key> ((tmux-unresponsive|unclassified-error) ended — the persona latched|conflict notice failed)' ~/.claude/channels/slack/server.log
```

`[slack] conflict-latch: persona=<key> latched — case=<case> session="<name>" refused=<operation> state=<state>` marks the hold (with ` message="<description>"` when agent-director gave one), and after it, once the hold is in place, the launch step that met it logs `[slack] spawnForPersona: <step> refused for "<name>" (key=<key>): <error> — CONFLICT: the persona latched; no spawn-failure notice; nothing more is called (b.jg5 SRJ-105, SRJ-501)`. Each launch the server then skips logs `[slack] spawnForPersona: not launching "<name>" (key=<key>) — it is latched (case=<case>); no agent-director call (b.jg5 SRJ-502)`, each restart it declines to schedule `[slack] Not scheduling restart for persona=<key> — the persona is latched; no timer armed (b.jg5 SRJ-502)`, each restart already pending that it skips `[slack] Skipping restart for persona=<key> — the persona is latched; no agent-director call, nothing recorded (b.jg5 SRJ-502)`, and each reconnect it declines to type `[slack] reconnectSession: persona=<key> is latched — not typing /mcp reconnect; nothing done (b.jg5 SRJ-502)`. When the server cannot tell whether the persona is held, it treats it as held: those lines then say `taken as latched`. A hold set by a start's listing is followed by `[slack] reconcileOrphans: "<name>" (key=<key>) latched from its own listed row instanceId=cscb_<key> (case=<case>) — its own row and every row labelled with it are left unkilled (b.jg5 SRJ-116, SRJ-502, SRJ-714)`. Each of the server's own checks logs one line, `[slack] conflict-latch: re-check of "<name>" (key=<key>) — case=<case> call=<call> answer=<answer>`: `call=none` when it made no call after its read, and `answer` what came of it (for example `still-latched`, or `no-information (…)` for an answer that told the server nothing). A clear logs `[slack] conflict-latch: persona=<key> cleared — case=<case> session="<name>" reason="<reason>"; recovery notice posted`, and the bring-up that follows it lines starting `[slack] latch-clear: `, such as `[slack] latch-clear: "<name>" (key=<key>)'s retry at once after its latch cleared answered <outcome> (b.jg5 SRJ-506)`. To follow only the clears:

```sh
grep -E 'conflict-latch: persona=<key> cleared — |latch-clear: .*(\(key=<key>\)|persona=<key> )' ~/.claude/channels/slack/server.log
```

The `debug-slack-channel-bots` skill explains every line.

**A persona posts a *Held: unusable tmux session name* notice**
Symptom: the persona is silent, and its destination has a *Held: unusable tmux session name* notice naming the persona and its agent-director row, `cscb_<key>`. agent-director will not act on that row because the tmux session name recorded on it cannot be used. The server never records such a name on a persona's own row, so agent-director's store was edited by hand.

The server holds the persona when agent-director gives this answer to one of these calls for its row: a launch's spawn or resume, a kill the server makes while it replaces the persona's old instance, or its end of its own stuck launch; a restart's kill of the persona's old instance before its relaunch; a read of the persona's row by a launch, by a launch waiting for the persona to come up, by a restart's checks, by the health check, by an automatic retry, or for a lost message; or a read of the persona's screen by a launch waiting for it to come up or by a restart's checks. The same answer to a kill made by the server's clean-up of old sessions at a start, or to the row read that follows that clean-up, holds nobody: it is only logged in `server.log` (a kill's answer also as an `orphan-cleanup` entry). Nor does it hold anybody when a confirmed change's teardown kill meets it, at a try or at the read between its tries: it is only logged, to `server.log` and as a `persona-teardown-notice` entry in `startup-errors.log`, and nothing is posted. While it is held, the server launches, resumes, reconnects, restarts and kills nothing for it, makes no tmux call for it and counts nothing toward the restart limit; its own check reads the row every 2 minutes and makes no other call (see "The server's own check" under "A persona posts a *Held: tmux session conflict* notice" above). Messages sent to it meanwhile are lost, and each one's lost-message notice reports `held for a human`, with no restart started. A *Not answering* or *Unclassified agent-director error* episode the persona had ends with no further notice. Other personas are not affected.

The notice is posted once per hold, even when the persona already has a *Waiting on a prompt* or *Not connected* notice. It quotes agent-director's description, with anything that looks like a token removed. A persona already held for another reason (a tmux session conflict or a launch start not recorded) is held again for this reason, with one new notice.

What to do: a human follows the "Operator actions" section of agent-director's README for the row the notice names. This is for a human only: no bot acts on it, including a persona that sees the post. Read-only checks: the row itself, and the persona's hold lines in `server.log`:

```sh
agent-director get --claude-instance-id cscb_<key>
grep -E 'conflict-latch: persona=<key> (latched|relatched) — case=unusable-recorded-name|(\(key=<key>\)|persona=<key>): .*— UNUSABLE NAME: |reconnectSession: persona=<key> is waiting and is latched' ~/.claude/channels/slack/server.log
```

`[slack] conflict-latch: persona=<key> latched — case=unusable-recorded-name session="<name>" refused=none state=<state> message="<description>"` marks the hold, and the step that met the answer logs a line containing `— UNUSABLE NAME: the persona latched`. While the persona is held, the health check and the persona's own check still read its state; a read that gets the same answer logs a line containing `— UNUSABLE NAME: the persona was already latched with this case`, and nothing more is done for it. The `debug-slack-channel-bots` skill explains every line.

How a hold ends: the server's own check clears it once the row is gone, with one *Hold cleared* notice, and the persona then comes up fresh; once the row is gone, a human can also clear it at once with [`clear-latch`](#claude-slack-channel-bots-clear-latch) (see the *Held: unusable tmux session name* row of "How a hold ends" under "A persona posts a *Held: tmux session conflict* notice" above, which also gives the other ways a hold ends).

**A persona posts a *Held: launch start not recorded* notice**
Symptom: the persona is silent, and its destination has a *Held: launch start not recorded* notice naming the persona and its tmux session, `slack_bot_<key>`. The persona's agent-director row, `cscb_<key>`, reads pending but records no launch start. Only an agent-director process older than the installed one, or a hand edit of agent-director's store, writes such a row, and agent-director will not act on a session for it.

The server holds the persona the first time it reads such a row for it: when a server start lists its agent-director instances before its clean-up of old ones, while launching it, while waiting for it to come up, during a restart's checks, at a health check, at an automatic retry, or for a lost message. It holds it whether or not the server launched that row. Only a persona in your current configuration is held: such a row under a key no persona uses holds nobody. A row that reads this way and also carries conflicting labels holds the persona for this reason only. Holds are kept in memory only, so after a server restart a persona whose row still reads this way is held again by that start's listing, with one new notice; the start's clean-up then ends none of its instances, its own or any other carrying its label, even one running in another working directory or config directory.

While the persona is held, the server launches, resumes, reconnects, restarts and kills nothing for it, types nothing into its session and counts nothing toward the restart limit; its own check reads the row every 2 minutes and makes no other call (see "The server's own check" under "A persona posts a *Held: tmux session conflict* notice" above). When that read finds the row running, ended or missing, or gone, the hold ends, with one *Hold cleared* notice (see "How a hold ends" below). Messages sent to it meanwhile are lost, and each one's lost-message notice reports `held for a human`, not `starting`, with no restart started. A *Not answering* or *Unclassified agent-director error* episode the persona had ends with no further notice. Other personas are not affected.

The notice is posted once per hold, even when the persona already has a *Waiting on a prompt* or *Not connected* notice. A persona already held for another reason (a tmux session conflict or an unusable tmux session name) is held again for this reason, with one new notice.

What to do: a human follows the "Operator actions" section of agent-director's README. This is for a human only: no bot acts on it, including a persona that sees the post. Read-only checks: the row itself (its state, and that it shows no launch start), and the persona's hold lines in `server.log`:

```sh
agent-director get --claude-instance-id cscb_<key>
grep -E 'conflict-latch: persona=<key> (latched|relatched) — case=launch-start-not-recorded|(\(key=<key>\)|persona=<key>): (its row reads pending with no launch start|its row read latches the persona \(case=launch-start-not-recorded)|\(key=<key>\) latched from its own listed row ' ~/.claude/channels/slack/server.log
```

`[slack] conflict-latch: persona=<key> latched — case=launch-start-not-recorded session="slack_bot_<key>" refused=none state=pending` marks the hold (`relatched` and `(was <case>)` after the case when the persona was held for another reason). The read that found the row logs a line containing `its row reads pending with no launch start (state=pending) — the persona latched` or `its row read latches the persona (case=launch-start-not-recorded, state=pending) — the persona latched`. While the row stays as it is, each health check and each of the persona's own checks reads it again and logs the second line ending `— the persona was already latched with this case; nothing more is called for it (b.jg5 SRJ-115, SRJ-501)`, and nothing more is done for the persona. A hold set by a start's listing is followed by `[slack] reconcileOrphans: "<name>" (key=<key>) latched from its own listed row instanceId=cscb_<key> (case=launch-start-not-recorded) — its own row and every row labelled with it are left unkilled (b.jg5 SRJ-116, SRJ-502, SRJ-714)`. The `debug-slack-channel-bots` skill explains every line.

How a hold ends: the server's own check clears it once the row reads running, ended or missing, or is gone, with one *Hold cleared* notice, and the persona is then brought up at once; a human can also clear it at once with [`clear-latch`](#claude-slack-channel-bots-clear-latch) once the cause is resolved (see the *Held: launch start not recorded* row of "How a hold ends" under "A persona posts a *Held: tmux session conflict* notice" above, which also gives the other ways a hold ends).

**A persona posts a *Cannot launch* notice**
Symptom: the persona is silent, and its destination has one *Cannot launch* notice: the host's agent-director rejected the flags of this persona's launch (`ErrInvalidFlags`). The installed agent-director may not match this CSCB release. The server holds the persona when agent-director gives this answer to the launch that brings the persona up fresh on its own agent-director row, after one immediate check of the agent-director binary's version that does not stop the server.

While the persona is held, the server launches, resumes and restarts nothing for it, and the health check and the automatic retries make no attempt for it. It never tries another kind of launch in its place. Nothing counts toward the restart limit. Messages sent to the persona meanwhile are lost, and each one's lost-message notice reports `cannot launch`, with no restart started. The notice is posted once per hold. Other personas are not affected.

What to do: a human checks the installed agent-director against this release's [Prerequisites](#prerequisites), and installs agent-director as the README section "Switching over to agent-director Phase 1" describes. This is for a human only: no bot acts on it, including a persona that sees the post. The read-only check:

```sh
agent-director version
```

How a hold ends:

- **The binary changes.** The server re-checks the agent-director binary every 120 s. Once it finds another version that passes the check, the hold ends, with no post, and the persona is retried at once. A binary below the required version stops the server instead (see "Found while the server was running" under [Startup errors](#startup-errors)).
- **A server restart.** The hold is kept in the server's memory only, so a restart ends every hold. A persona whose launch is still rejected is held again, with one new notice.
- **Removing the persona, or a destructive change to it** (a confirmed change), ends its hold, with no post.

A persona whose hold ended and whose launch is rejected again is held again, with one new notice. To follow one persona's hold in `server.log`:

```sh
grep -E 'invalid-flags-hold: persona=<key> |\(key=<key>\) answered ErrInvalidFlags|(persona=<key>|\(key=<key>\)) .*held on ErrInvalidFlags' ~/.claude/channels/slack/server.log
```

`[slack] invalid-flags-hold: persona=<key> held — a reuse spawn answered ErrInvalidFlags and the version re-check did not stop the server; …` marks the hold, and the launch's own line, `[slack] reuseSpawnForPersona: reuse spawn of "<name>" (key=<key>) answered ErrInvalidFlags …`, follows it. Each launch the server then skips logs `[slack] spawnForPersona: not launching "<name>" (key=<key>) — it is held on ErrInvalidFlags; no agent-director call (held; b.jg5 SRJ-207)`, and each restart it declines to schedule `[slack] Not scheduling restart for persona=<key> — the persona is held on ErrInvalidFlags; no timer armed (b.jg5 SRJ-207)`. `[slack] invalid-flags-hold: persona=<key> hold ended — agent-director version <old> changed to <new> (b.jg5 SRJ-207)` marks the end, followed by `[slack] invalid-flags-hold: persona=<key> retried at once after its hold ended (b.jg5 SRJ-207)`; removing the persona, a destructive change to it or stopping the server logs `… hold forgotten — …` instead. When the server cannot tell whether the persona is held, it treats it as held: those lines then say `taken as held`. The `debug-slack-channel-bots` skill explains every line.

**A persona posts a *Kill failed* or *Process outlived kill* notice**
Before the server relaunches a persona or replaces its agent-director row, it ends the persona's old worker through agent-director and checks the result. Where the server last read the worker's row as running, a kill agent-director can't carry out right now is tried up to 3 times, 2 s apart, before its result stands; a restart's kill, made only after agent-director answered that its own install had disappeared, is made once. At a server start, a stuck tmux delays the start by at most one worker's tries: once one worker's kill has used its 3 tries, every later kill in that start is made once. The end of the server's own stuck launch is one more such kill, tried up to 3 times; when it fails, nothing is relaunched, and the stuck launch later gets a *Session not starting* notice (see "A persona posts a *Launch stuck* or *Session not starting* notice" above).

- *Kill failed*: agent-director could not end the old worker after those tries. The worker, or another process in its session, may still be running. The server keeps the worker's agent-director row and launches nothing over it. The notice quotes agent-director's description of the failure, with anything that looks like a token removed, names a check for a human and points to the "Operator actions" section of agent-director's README. It is posted once per episode: a later failed kill for the same persona posts nothing more until agent-director reports the old worker's row ended or missing, or no longer has it. The server keeps retrying the persona on its own (see "A persona is retried after agent-director refuses it" above); a failed kill never counts toward the restart limit and never starts a *Not answering* episode. The notice then ends `CSCB keeps retrying on its own and posts no second alert about this.` When the persona is held for a human by then (for example, a read between its tries held it), it ends `This persona is held for a human (see its hold post); CSCB posts no second alert about this.` instead: its *Held:* notice goes to the same destination, and the server retries nothing for it (see the *Held:* entries above). While the episode lasts, a message sent to the persona is lost and its lost-message notice reports `kill failed` (or `held for a human` for a held persona), with no restart started.
  The notice also comes when the server replaces a persona's old instance that is still running, which a relaunch does when it can't resume it because `resume_enabled` is false or the persona's working directory or config directory changed, or when the persona's session was found gone while agent-director still lists the old instance as running (the relaunch then keeps its conversation): its kills returned, but after a few checks a few seconds apart agent-director still lists the old instance as running. That notice has no "agent-director said" sentence. The old instance's row is kept, nothing is launched over it, and it too is posted once per episode. A persona whose old instance is still starting gets no notice: the server leaves it alone and retries the persona later.
- *Process outlived kill*: agent-director ended the worker, but a process of its session outlived the kill; the notice names it by pid and quotes agent-director's description. Nothing in the server checks that process again. The persona comes back as usual: the relaunch or the replacement goes ahead. The notice is posted once for each such kill, holds nothing and starts no episode, so a message lost afterwards never reports `kill failed`. It ends `CSCB takes no further action on this process and posts no second alert about it.`

What to do: a human follows the "Operator actions" section of agent-director's README for the worker or the process the notice names. Both notices are for a human only: no bot acts on them, including a persona that sees the post. A read-only check of the persona's row:

```sh
agent-director get --claude-instance-id cscb_<key>
```

For a persona no longer in the configuration (for example, one removed while its old worker was being killed), for the kills of the server's clean-up of old instances at a start, and for the kill a confirmed change's teardown makes (a removal, or the old half of a `credentials_file` path or `working_directory` change), nothing goes to Slack: the notice's text goes to `server.log` and `startup-errors.log` instead (see [Startup errors](#startup-errors)). For the teardown's kill, and for any kill-failure notice raised for the persona while that teardown runs, that is a `persona-teardown-notice` entry naming the persona and `raised during its teardown` (a *Process outlived kill* text a `persona-kill-survivor` entry); nothing goes to the new half's destination either. `stop --stop-bots` and `clean_restart` post nothing to Slack either: they print the notice's text after the persona's line, append it to `server.log` and record it in `startup-errors.log` (a *Kill failed* text in the persona's `persona-kill-failed` entry, a *Process outlived kill* text as a `persona-kill-survivor` entry), with the context `(CLI teardown, <command>)`. There a *Kill failed* text ends `The CLI does not retry this kill: once the worker is ended, run the command again.`, and a *Process outlived kill* text ends `This persona's teardown has finished; nothing in CSCB checks this process again.` (see [What the command prints when a bot can't be stopped](#what-the-command-prints-when-a-bot-cant-be-stopped)). A kill whose tries were stopped (the persona was removed, torn down or stopped being up, the server is stopping, or the check of agent-director's version stops the server) raises neither notice, during a teardown too: `server.log` gets one line naming the stop's cause and the descriptions of the failed tries, and for a persona removed during the tries the same line goes to `startup-errors.log` as a `persona-kill-failed` entry, with no notice text.

For an old instance a persona waits on (see "A persona waits on an old instance in its working directory" above), the server's later kills of it post nothing either. A *Kill failed* text goes to `server.log` and `startup-errors.log` as a `persona-kill-failed` entry, `<ref> (old-life wait): <the notice's text>`, where `<ref>` is `persona=<old key>`, or `instanceId=<id>` for an instance from before personas or under another instance id; a *Process outlived kill* text as a `persona-kill-survivor` entry of the same form; and a session conflict or an unusable session name met there as a `persona-teardown-notice` entry, `<ref>, raised during its old-life wait: …`, holding nobody. When the server stops, or the last persona waiting on that instance is torn down, during such a kill's tries, its `persona-kill-failed` entry carries the stop's line instead, with no notice text. A failed kill there makes a message lost for a waiting persona report `kill failed` until the old instance has ended.

To follow one persona's kills and notices:

```sh
grep -E 'persona-episodes: persona=<key> kill-failure |(kill try [0-9]+( of [0-9]+)?|kill tries) for cscb_<key>' ~/.claude/channels/slack/server.log
```

`[slack] persona-episodes: persona=<key> kill-failure ordinary alert posted to its destination (recovery; destination)` marks the *Kill failed* notice (`destination-latched` in place of `destination` for a held persona), `… survivor alert posted to its destination (recovery)` the *Process outlived kill* notice, `… ordinary alert not posted — its episode's alert already posted` a later failed kill in the same episode, and `… ended — its own row read ended or missing` or `… ended — its own row is gone (ErrSpawnNotFound)` the episode's end. `… alert written to the server log and startup-errors.log (<class>) — not-configured` is the notice for a persona no longer in the configuration (`<class>` `persona-kill-failed` or `persona-kill-survivor`), `… alert written to the server log and startup-errors.log (<class>) — persona-teardown, raised during its teardown (<context>)` is a notice raised while a confirmed change's teardown of the persona runs, whether or not the persona is still in the configuration (`<class>` `persona-teardown-notice` or `persona-kill-survivor`), and `… alert not posted to its destination — muted, its persona teardown was submitted …` one raised after the teardown was queued and before it started. `… ordinary alert not raised — its tries were stopped (<cause>)…, so nothing retries this kill; …` is a kill whose tries were stopped, `<cause>` naming the stop (such as `its keep-going check answered false: the server is shutting down`, `its keep-going check answered false: the persona is torn down or not up`, or `its live-row sequence was stopped: the persona's teardown began`); `… stopped retry's log line (no alert text) written to the server log and startup-errors.log (persona-kill-failed) — stopped` follows it for a persona removed during the tries. The `kill try <n> of <max>` lines show each try, with agent-director's answer. The `debug-slack-channel-bots` skill explains every line.

**A persona posts an *agent-director refuses its config file* notice**
agent-director refuses its own config file, `~/.agent-director/config.toml`, so it fails every call that reads its store until a human fixes the file. Each persona it refuses gets this notice once, at its destination, and stays down or silent meanwhile. The notice quotes agent-director's own description of the problem.

The server does nothing because of it: it counts nothing toward the restart limit, never reads the persona as dead, kills, deletes and relaunches nothing, and posts no `Spawn failure:` notice. It retries the persona on its own, with `session_restart_delay` and `health_check_interval` at `0` too (see "A persona is retried after agent-director refuses it" above). The server's own stuck launch is not ended meanwhile and gets no *Launch stuck* notice until the file is fixed (see "A persona posts a *Launch stuck* or *Session not starting* notice" above). A message sent to the persona meanwhile is lost. While the server is retrying the persona, its lost-message notice reports `not answering`, with no restart started. At the restart limit it reports `restart limit reached` instead; if the persona's retries have stopped, it reports the next state that applies, which can be `starting now`.

A human fixes `~/.agent-director/config.toml` following agent-director's documentation, which gives the file's rules. This is for a human only: no bot acts on it, including a persona that sees the post.

The confirmation is the *All clear.* notice naming `ad-config-malformed`, posted at the first successful call for the persona that reads agent-director's store (a retry's, a health check's or any other), or at a state check that finds its row gone. A call that fails clears nothing. A working `agent-director version` or `agent-director help` proves nothing, because both run without the config file. When the notice is raised while a confirmed change tears the persona down, neither it nor its *All clear.*, whenever that comes, is posted: both go to `server.log` and `startup-errors.log` as `persona-teardown-notice` entries. Raised after the teardown was queued and before it started, the notice is not posted and writes no entry (`server.log` says `… of ad-config-malformed not posted — muted, its persona teardown was submitted; …`), and its *All clear.* is written as a `persona-teardown-notice` entry, never posted. An *All clear.* that also names another outage is split: only the part naming the other outage is posted. To follow one persona:

```sh
grep -E 'outage-state: ad-config-malformed (raised|cleared) for persona=<key>[: ]|unavailable-retry: persona=<key> ' ~/.claude/channels/slack/server.log
```

`[slack] outage-state: ad-config-malformed raised for persona=<key>: class=CONFIG name=ErrConfigMalformed message="<description>" — no action is taken; the retry timer retries the persona (b.jg5 SRJ-316)` marks the first such answer, with `[slack] unavailable-retry: persona=<key> armed (config: <error>) — first retry in 30 s` when it starts the retries. `[slack] outage-state: ad-config-malformed cleared for persona=<key> — agent-director read its store again (b.jg5 SRJ-312)` marks the fix taking effect for the persona.

**A persona posts an *Unclassified agent-director error* notice**
agent-director returned an error for the persona that the server can't classify while launching or recovering it: for example an internal error, a store it can't open, its install disappearing, or an error the server has no handling for. The notice names the error when its name is safe to show, and quotes agent-director's description with token-like text redacted, on one line and cut short.

The server keeps retrying the persona on its own (see "A persona is retried after agent-director refuses it" above). It never counts the error toward the restart limit, and kills, deletes, relaunches and posts nothing else because of it: no `Spawn failure:` notice and no `spawn-failed` entry.

The notice is posted at most once per episode, and only once the error has lasted longer than the alert threshold, which comes from agent-director's timing settings in effect: the longer of `stopping_window_seconds` and `starting_session_seconds`, plus 60 seconds (about 6 minutes at agent-director's defaults; see [agent-director's timing settings](#agent-directors-timing-settings)). It comes with the first retry or restart that still meets such an error after the threshold has passed, so an error that clears before then posts nothing. The episode runs from the first such error until a retry finds the persona recovered (after a relaunch, until its new session has started, ended or disappeared), its retries stop because tmux answers again for it, the persona reaches the restart limit, it is held for a human (a *Held:* notice), it is torn down, or the server stops. A later error starts a new episode, which can post the notice again. A persona whose retries stop for another reason, such as no longer being up, no longer being in the configuration, a declined relaunch or a failed retry, keeps its episode.

If the persona was removed from the configuration while a launch for it was still running, the notice is not posted to Slack: it is written to `server.log` and as a `persona-unclassified-error` entry in `startup-errors.log` (see [Startup errors](#startup-errors)). While a confirmed change's teardown of the persona runs (a removal, or the old half of a `credentials_file` path or `working_directory` change), it is written as a `persona-teardown-notice` entry instead, whether or not the persona is still in the configuration, and from the moment that teardown is queued it is not posted.

A human checks the host's agent-director, following agent-director's documentation, and the persona's lines in `server.log`. This is for a human only: no bot acts on it, including a persona that sees the post. Once agent-director answers normally, the next retry recovers the persona with no server restart. To follow one persona:

```sh
grep -E 'persona-episodes: persona=<key> unclassified-error |unavailable-retry: persona=<key> ' ~/.claude/channels/slack/server.log
```

`[slack] persona-episodes: persona=<key> unclassified-error started — class=UNCLASSIFIED[ name=<name>][ message="<description>"]` marks the first such error, and `[slack] unavailable-retry: persona=<key> armed (unclassified: <error>) — first retry in 30 s` (or `armed (read-error: <error>)` when the error came from reading the persona's state) starts the retries. `… alert posted to its destination — an UNCLASSIFIED outcome met <s> s after the episode's first, over its alert threshold of <s> s: <classification>` marks the notice; for a persona no longer in the configuration the line reads `… alert written to the server log and startup-errors.log (persona-unclassified-error) — the persona is not in the applied configuration; an UNCLASSIFIED outcome met …` instead, during a teardown `… alert written to the server log and startup-errors.log (persona-teardown-notice) — raised during its persona teardown; an UNCLASSIFIED outcome met …`, and after the teardown was queued but before it started `… alert not posted to its destination — muted, its persona teardown was submitted; …`. `… ended — a retry found nothing left to recover`, `… ended — a retry read its row live out of pending`, `… ended — its retry timer stopped when its tmux condition ended`, `… ended — a retry read its row ended or gone`, `… ended — the persona reached the restart cap` or `… ended — the persona latched` ends the episode. Each launch step the error stopped logs `[slack] spawnForPersona: <step> refused for "<name>" (key=<key>): <error> — no spawn-failure notice; nothing more is called (b.jg5 SRJ-105)`, and a restart's kill that met it logs `[slack] killSession (restart adapter): kill for persona=<key>: outcome=not-killed class=UNCLASSIFIED …`, then `[slack] Session kill for persona=<key> did not succeed (…) — no relaunch; not counted`.

**Session stuck during clean_restart**
If a bot does not exit within `exit_timeout` seconds (default 120s) after its pause, `clean_restart` force-kills it, keeping its row. A force-kill that succeeds, or that finds the bot's instance already ended, missing or gone, counts as stopped, and the restart goes on. A force-kill that still fails after its tries fails that persona: the command prints its line naming its session and why, with the *Kill failed* text after it when agent-director could not end the worker (see [What the command prints when a bot can't be stopped](#what-the-command-prints-when-a-bot-cant-be-stopped)). It then starts the server if agent-director answers, or prints the alert that the server was not started, then the last line, and exits 1 (see [When `clean_restart` can't stop a bot](#when-clean_restart-cant-stop-a-bot)). If the worker may still be running, a human follows the "Operator actions" section of agent-director's README for it; this is for a human only, and no bot acts on it. Then run `clean_restart` again: rows are never deleted, so a retry is safe.

**`clean_restart` or `stop --stop-bots` exits non-zero with `nothing was stopped`**
The precheck failed, so nothing was stopped: the server and every bot keep running. The `precheck failed for persona` lines name each persona it could not check and why, by class (see [Precheck before stopping bots](#precheck-before-stopping-bots)); an `agent-director initialization failed:` line means agent-director could not be reached or (for `clean_restart`) its version was refused. Fix the cause, then re-run the command.

**`stop --stop-bots` exits non-zero with `only the server was stopped`**
The installed agent-director is below the agent-director client's own minimum, so only the server was stopped. See [`stop`](#claude-slack-channel-bots-stop) for what was left running and how to read the server stop's lines, then follow the README section "Switching over to agent-director Phase 1".

**`clean_restart` or `stop --stop-bots` exits non-zero with `could not stop`**
The precheck passed and the server was stopped, but at least one persona could not be stopped. This is intentional: the command fails loudly rather than reporting a clean stop. After `stop --stop-bots` the server stays stopped. After `clean_restart` the server was started again if agent-director answered its check; `[slack] clean_restart: start failed with exit code <n>` means that start failed (the reason is in `server.log`). If agent-director did not answer, the command printed the alert ending `the server was not started: start it once agent-director answers` and recorded `clean-restart-not-restarted`: start the server with `claude-slack-channel-bots start` once `agent-director version` answers (see [When `clean_restart` can't stop a bot](#when-clean_restart-cant-stop-a-bot)). Each `could not stop persona` line names the persona, its session and why, by class (see [What the command prints when a bot can't be stopped](#what-the-command-prints-when-a-bot-cant-be-stopped)); the same lines are in `server.log` and `startup-errors.log`, and for `clean_restart` in `clean_restart.log`:

```sh
grep -E 'could not stop persona|\(CLI teardown, ' ~/.claude/channels/slack/server.log
grep -E '\[(cli-teardown-failed|persona-kill-failed|persona-kill-survivor|clean-restart-not-restarted)\]' ~/.claude/channels/slack/startup-errors.log
```

Fix the cause first: for `UNAVAILABLE`, confirm agent-director is installed and responsive with `agent-director version`; for the other classes, see [When a bot can't be paused](#when-a-bot-cant-be-paused) and [When a bot can't be force-killed](#when-a-bot-cant-be-force-killed). When the line is followed by a *Kill failed* text, the worker may still be running: a human follows the "Operator actions" section of agent-director's README for it, and no bot acts on it. Rows are never deleted on any failure path, so running the command again is safe once the cause is fixed.

**Bots come back with no memory of the prior conversation after a reboot**
With `resume_enabled: true`, a bot whose host rebooted (or pod resumed) should return with its conversation history. If it comes back amnesiac, confirm the system-installed `agent-director` is **≥ 0.8.0** (`agent-director version`) — reboot recovery relies on capabilities added in that release. Note that `bun run install-check` does **not** confirm this: its client floor is `0.7.0`, lower than the reboot-recovery requirement, so install-check passes on a `0.7.x` binary that still yields amnesiac bots. Verify the resume requirement directly with `agent-director version`. Note: legacy sessions created before upgrading to 0.8.0 may lose history exactly once on their first post-upgrade recovery, then resume cleanly thereafter.

A bot also starts a new conversation, by design, when its session no longer matches the applied configuration. A config edit takes effect only once it is applied (see [Reload](#reload)); a restart or reboot alone runs the last-applied record. When a change to a persona's `working_directory` is applied, the persona is torn down and brought up fresh, once its old instance has ended (see "A persona waits on an old instance in its working directory" above). When a change to a persona's effective `claude_config_dir` (its own or the top-level default) is applied, the bot starts a new conversation the next time it would be resumed (see [When next-launch and server-wide changes take effect](#when-next-launch-and-server-wide-changes-take-effect)); a bot that keeps running keeps its old config directory until then. A bot whose instance no longer matches its working directory or config directory, or whose `resume_enabled` is false, starts a new conversation on the same instance: the old conversation stays in its directory as an earlier life of that instance, and nothing is deleted. A bot that is still running is first ended, with each kill checked, before the new conversation starts; one that is still starting is never typed into: it is ended with a checked kill, and the new conversation starts only once agent-director's grace period has passed since its launch start (see "A persona's instance is still starting" above). A persona retired by a confirmed change (removed and added again with the same key, renamed back, or brought up from its new entry after a `credentials_file` path or `working_directory` change) starts a new conversation on the same instance, restarts included, and its old conversation is never resumed. So does a persona whose instance a server start found while the persona was not in the applied configuration (for example, after `config.json.last-applied` was deleted) and that is added back later: that start recorded its key as retired. After upgrading from an earlier release, each bot also starts fresh once: a bot instance from before the upgrade is never resumed (see [Step 10: Start the new CSCB](#step-10-start-the-new-cscb)). The log names the reason: search `server.log` for `sweeping row`, `pre-persona row`, `replacing the row`, `not resuming; replacing its row` or `key is retired`.

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

`stop --stop-bots` and `clean_restart` append their bot-teardown lines to `server.log` while the server is stopped (see [What the command prints when a bot can't be stopped](#what-the-command-prints-when-a-bot-cant-be-stopped)); those lines take the same timestamped form and are rotated the same way.

Note this covers only `server.log` / `clean_restart.log`. `startup-errors.log` and `permission-trail.jsonl` are separate append-only files with their own retention (see below).

---

## Startup errors

CSCB writes startup errors to `~/.claude/channels/slack/startup-errors.log` (override the directory with `SLACK_STATE_DIR`) in addition to stderr. Each entry is a single timestamped line. The file is append-only and never rotated by CSCB — copy `docs/logrotate-startup-errors.conf` into `/etc/logrotate.d/` if you want host-level rotation.

The classes in the first list are fatal: the process exits non-zero. Two of them can also be written while the server runs (see "Found while the server was running" after the list). The later groups (Slack Reply Guard setup, persona launch and conversation memory) are non-fatal: they are recorded, and the start continues. Four non-fatal classes, `persona-unclassified-error`, `persona-kill-failed`, `persona-teardown-notice` and `persona-kill-survivor`, are written while the server runs; of them only `persona-kill-survivor` can also be written at start (see "Written while the server runs" below). `stop --stop-bots` and `clean_restart` write `cli-teardown-failed`, `persona-kill-failed` and `persona-kill-survivor` entries while the server is stopped, and `clean_restart` also `clean-restart-not-restarted` (see "Written by `stop --stop-bots` and `clean_restart`" below).

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
- `retired-keys-unreadable` — the retired-key record, `retired-keys.json` in the state directory, exists but can't be read, parsed or validated (it was edited or damaged, or the path isn't a regular file), so the server doesn't start: it never guesses which persona keys are retired. The entry names the file and what is wrong with it. Moving the file aside lets the server start, at the cost that the keys it held are no longer retired, so a persona whose key it held may resume the conversation of the life that was retired:

  ```sh
  STATE="${SLACK_STATE_DIR:-$HOME/.claude/channels/slack}"
  mv "$STATE/retired-keys.json" "$STATE/retired-keys.json.moved-aside"
  ```

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

The following classes are **non-fatal** failures while preparing or launching personas at server start. A line for a failed agent-director call ends with agent-director's error name and, when it gives one, its description as `message="…"`, on one line, with token-like text redacted and long text cut short. At a later launch, the same failures are `server.log` lines only; the persona classes written while the server runs are listed under "Written while the server runs" below.

- `ad-same-user-unenforced` — the platform gives no process user ID, so the check that `~/.agent-director/state.db` belongs to the CSCB user is skipped. Run CSCB on a supported platform (see [Supported platforms](#supported-platforms-inherited-from-agent-director)).
- `trust-bootstrap-config-missing` — a persona's `<claude_config_dir>/.claude.json` can't be read, so its workspace trust isn't pre-accepted. Log the directory in (see [Next-launch settings](#next-launch-settings)).
- `trust-bootstrap-config-parse` — that `.claude.json` isn't valid JSON, so it is left untouched. Fix its syntax.
- `trust-bootstrap` — an unexpected error while pre-accepting a persona's workspace trust, such as a failed write of `.claude.json`; the line names the persona and its working directory. Check that the file is writable.
- `spawn-failed` — launching or resuming a persona's instance failed; the line names the persona and the step. The server keeps running; see "Session not restarting after crash" in [Troubleshooting](#troubleshooting) for how restarts are retried. An instance the failed launch left still starting is waited out and never ended; see "A persona's instance is still starting" in [Troubleshooting](#troubleshooting). No `spawn-failed` entry is written when agent-director refuses the call or can't read the persona's state (it is unreachable, answers that it can't act right now, or refuses its own config file), or answers with an error the server can't classify: such a refusal is not a failure, and the server retries the persona on its own. See "A persona is retried after agent-director refuses it", "A persona posts a *Not answering*, *Still not answering* or *Answering again* notice", "A persona posts an *agent-director refuses its config file* notice" and "A persona posts an *Unclassified agent-director error* notice" in [Troubleshooting](#troubleshooting).
- `dev-channels-approve-spawn-died` — during a server start, agent-director reported a persona's instance ended or missing before its startup prompt was cleared; the entry is written as soon as that is found. Restarts are retried as for `spawn-failed`. See "A persona's instance waits at a startup prompt" in [Troubleshooting](#troubleshooting).
- `dev-channels-approve-not-ready` — during a server start, a persona's instance didn't start within the time the server watches it (see "A persona's instance waits at a startup prompt" in [Troubleshooting](#troubleshooting)): its startup dialog wasn't recognised or the session hung. The entry itself posts nothing to Slack; a session that still doesn't start gets the *Launch stuck* or *Session not starting* notice (see "A persona posts a *Launch stuck* or *Session not starting* notice" in [Troubleshooting](#troubleshooting)). Inspect the instance with `agent-director read-pane --claude-instance-id <id>`.
- `spawn-failure-post` — posting a `Spawn failure:` notice to a persona's destination failed. The notice is held and retried; see "A permission prompt or notice doesn't arrive" in [Troubleshooting](#troubleshooting).
- `orphan-cleanup-list-failed` — the server couldn't list its agent-director instances to clean up stale ones (see "Bots come back with no memory" in [Troubleshooting](#troubleshooting)). At this start the server ends no stale instance, records no persona as retired and holds no persona from the listing; the start goes on.
- `orphan-cleanup` — at a start, the kill of one such instance did not succeed after its tries. The line names the instance, the persona label it carries, the state it was listed in and its tmux session, then agent-director's answer with its class: `kill did not succeed for orphan instanceId=<id> persona=<persona> state=<state> tmux_session=<session>: …; row kept, its session may still be running`. `<persona>` is the persona's name and key (`"<name>" (key=<key>)`) while the persona is in the applied configuration, and the label's value otherwise. When the server began stopping during the kill's tries, or the kill's agent-director version re-check stopped the server, the answer is followed by `; its tries were stopped because the server is shutting down, so no kill-failure alert is raised` and the line carries no notice text. The row is kept, as every row is, and its session may still be running. A `kill did not succeed for pre-persona row instanceId=<id> …` line names a bot instance from before the upgrade to personas, kept the same way. A session conflict or an unusable session name met here holds nobody. When agent-director could not end the instance after its tries (see "A persona posts a *Kill failed* or *Process outlived kill* notice" in [Troubleshooting](#troubleshooting)), the line goes on with the *Kill failed* notice's text, after `; kill-failure alert: instanceId=<id> (start sweep): `. Nothing is posted to Slack, and the text's last sentence says the server retries that kill only while a persona waits on that worker; a human follows the "Operator actions" section of agent-director's README for it. The next start's clean-up tries the kill again. Until agent-director reads that instance finished, a persona whose working directory is the row's waits and is not brought up, and the server keeps trying to end the instance (see "A persona waits on an old instance in its working directory" in [Troubleshooting](#troubleshooting)). A kill that succeeded after an earlier try named a surviving process writes `persona-kill-survivor` instead (below).

**Written by `stop --stop-bots` and `clean_restart`.** When the bot teardown after a passed precheck can't stop a persona, or stops it with a *Process outlived kill* text, the command records one entry per persona in this file, and `clean_restart` one more when it did not start the server, with no copy on the terminal, since it has printed the same line already (see [What the command prints when a bot can't be stopped](#what-the-command-prints-when-a-bot-cant-be-stopped)). Each entry carries the time it was written. Nothing is posted to Slack.

- `cli-teardown-failed` — a persona the command could not stop, with no *Kill failed* text after its line. The entry is the persona's line: `[<time>] [cli-teardown-failed] <command>: could not stop persona "<name>" (key=<key>), session "slack_bot_<key>": <CLASS>: <description>`, naming the command, the persona, its session, the class and agent-director's description, redacted. What to do: see "`clean_restart` or `stop --stop-bots` exits non-zero with `could not stop`" in [Troubleshooting](#troubleshooting).
- `persona-kill-failed` and `persona-kill-survivor` — the same classes as below, with the context `CLI teardown, <command>`: a persona whose line is followed by a *Kill failed* text gets one `persona-kill-failed` entry holding its line and then `persona "<name>" (key=<key>) (CLI teardown, <command>): <the notice's text>`, on one line; a persona stopped with a *Process outlived kill* text gets one `persona-kill-survivor` entry, `persona "<name>" (key=<key>) (CLI teardown, <command>): <the notice's text>`, and counts as stopped.
- `clean-restart-not-restarted` — `clean_restart` could not stop at least one persona, and agent-director did not answer its check after the teardown, so the server was not started. One entry per run, the same text the command printed and appended to `server.log`: `[<time>] [clean-restart-not-restarted] clean_restart: could not stop persona "<name>" (key=<key>), session "slack_bot_<key>": <CLASS>; agent-director did not answer, so the server was not started: start it once agent-director answers`, naming each persona it could not stop with its session and class. The server and the bots it did stop stay down until a human starts the server: once `agent-director version` answers, run `claude-slack-channel-bots start` (see [When `clean_restart` can't stop a bot](#when-clean_restart-cant-stop-a-bot)).

**Written while the server runs.** These non-fatal classes are written while the server runs; only `persona-kill-survivor` is also written at start, and `stop --stop-bots` and `clean_restart` also write `persona-kill-failed` and `persona-kill-survivor` (above):

- `persona-unclassified-error` — the *Unclassified agent-director error* notice for a persona that is no longer in the applied configuration, for example one removed while a launch for it was still running. Instead of a Slack post, the server writes this entry, `[<time>] [persona-unclassified-error] persona=<key>: <the notice's text>`, naming the persona's key, and the same line to `server.log`. Nothing is posted to Slack. Nothing needs doing for the removed persona itself; a human checks the host's agent-director, as described under "A persona posts an *Unclassified agent-director error* notice" in [Troubleshooting](#troubleshooting).
- `persona-kill-failed` — the *Kill failed* notice for a persona that is no longer in the applied configuration, for example one removed while the server was killing its old worker (for `stop --stop-bots` and `clean_restart`, see above). Instead of a Slack post, the server writes this entry, `[<time>] [persona-kill-failed] persona=<key> (recovery): <the notice's text>`, and the same line to `server.log`. The same class records a failed kill of an old instance a persona waits on (see "A persona waits on an old instance in its working directory" in [Troubleshooting](#troubleshooting)): `[<time>] [persona-kill-failed] <ref> (old-life wait): <the notice's text>`, where `<ref>` is `persona=<old key>`, or `instanceId=<id>` for an instance from before personas or under another instance id, and, when the server stopped or the last persona waiting on it was torn down during the kill's tries, the stop's line with no notice text. Its last sentence says the server retries that kill only while a persona waits on that worker. A human checks the worker as described under "A persona posts a *Kill failed* or *Process outlived kill* notice" in [Troubleshooting](#troubleshooting). A kill whose tries were stopped for a persona removed during them writes this class too, with no notice text: the entry is the server's line for the stop, `persona=<key> (<context>): the kill-failure ordinary alert not raised — its tries were stopped (<cause>)…`, naming the descriptions of the failed tries.
- `persona-teardown-notice` — a notice raised for a persona while a confirmed change tears it down (a removed persona, or the old half of a `credentials_file` path or `working_directory` change), from the start of the teardown until it completes: the *Kill failed* notice for its kill, a session conflict or an unusable tmux session name its kill met (the persona is not held), an outage notice such as *tmux unavailable* or *agent-director refuses its config file*, an *Unclassified agent-director error* notice, a *Held:* or *Cannot launch* notice from a launch still running, a stuck permission prompt warning, or any other notice for the persona. Nothing about it is posted to Slack, at the old destination or the new half's, and none is dropped. The entry is `[<time>] [persona-teardown-notice] persona "<name>" (key=<key>), raised during its teardown: <the notice's text>`; the same line goes to `server.log`, followed by `[slack] persona-notifier: notice for "<name>" (key=<key>) raised during its teardown — written to the server log and startup-errors.log (persona-teardown-notice), not posted: <its first line>`. The *All clear.* of an outage whose notice was written this way is written the same way whenever it comes; after the teardown has completed its entry says `the all-clear of an outage raised during its teardown` in place of `raised during its teardown`. A conflict or an unusable name the kill met reads `agent-director kill of cscb_<key> refused at a try: <agent-director's answer>` (or `refused at a status read between its tries`). The same class records a session conflict or an unusable session name met while the server ends an old instance a persona waits on, as `[<time>] [persona-teardown-notice] <ref>, raised during its old-life wait: <text>` (`<ref>` as for `persona-kill-failed`); nobody is held. A kill that did not succeed and that no *Kill failed* entry, `refused at a try` entry or outage notice records reads `agent-director kill of cscb_<key> did not succeed after <n> kill(s); the row is kept: <agent-director's answer>`: the old session may still run, the row is kept, and a removed persona's row is killed again by the next start's clean-up. The notice's text is written with Slack's escapes undone (`&`, `<` and `>` as themselves), and a *Kill failed* or *Process outlived kill* text of a kill other than the teardown's own (a launch still running) starts with its context in parentheses, such as `(recovery) `. What to do is the inner notice's own: follow the Troubleshooting entry for that notice (for a conflict or an unusable name, "A persona posts a *Held: tmux session conflict* notice" or "A persona posts a *Held: unusable tmux session name* notice"). The persona's row is kept, and its new session, if any, is not started over the old one. From the moment the teardown is queued, the persona's once-per-episode notices are not posted either: *Held: tmux session conflict*, *Held: unusable tmux session name*, *Held: launch start not recorded*, *Cannot launch*, *Slow recovery*, *Not answering*, *Still not answering*, *Answering again*, *Unclassified agent-director error*, *Kill failed*, *Process outlived kill* and *agent-director refuses its config file*. One raised before the teardown starts writes no entry, but an *agent-director refuses its config file* notice's *All clear.* is then written as a `persona-teardown-notice` entry, never posted. Until the teardown starts, every other notice is handled as usual.
- `persona-kill-survivor` — the *Process outlived kill* notice where it has no Slack destination: for a persona no longer in the applied configuration (`persona=<key> (recovery): <the notice's text>`), for a persona being torn down by a confirmed change (`persona "<name>" (key=<key>), raised during its teardown: <the notice's text>`), at a start, for a kill by the clean-up of old instances (`instanceId=<id> (start sweep): <the notice's text>`), for a kill of an old instance a persona waits on (`<ref> (old-life wait): <the notice's text>`), or for a persona `stop --stop-bots` or `clean_restart` stopped (`persona "<name>" (key=<key>) (CLI teardown, <command>): <the notice's text>`, above). The same line goes to `server.log`; nothing is posted. The entry names the process by pid; a human deals with it as described under "A persona posts a *Kill failed* or *Process outlived kill* notice" in [Troubleshooting](#troubleshooting).

The following classes are **non-fatal warnings** about conversation-memory loss. They are recorded to the same log but never exit the process or block startup. The first four are written by the JSONL-persistence safeguard, which runs *before* the resume path to warn about an *impending* loss; the last two (`jsonl-transcript-lost-on-resume`, `jsonl-diagnosis-inconclusive`) are written *by the resume path itself* when it tried to resume a row and either confirmed a wipe or could not determine whether one occurred. Those two lines end with agent-director's error name and `message="…"`, as above:

- `jsonl-non-persistent` — a session-transcript storage root (`<claude_config_dir>/projects`) is on a `tmpfs`/`ramfs` mount, so nothing there survives a reboot and session resume is structurally impossible on this host. A warning is also posted to the destination of each affected persona — those whose transcript storage root is the flagged mount, not every persona. Move the config dir to a persistent filesystem.
- `jsonl-persistence-check-warning` — the safeguard could not determine the filesystem type of a transcript storage root (unreadable/unparseable `/proc/self/mountinfo`, or an unresolvable path), so persistence is unverified. No Slack post is made. Investigate the mount before relying on resume.
- `jsonl-transcript-stale-path` — a persona's saved transcript exists on disk at the resolved fallback path, but agent-director's recorded `jsonl_path` points elsewhere (missing/empty). On the next restart the resume path would treat it as missing and wipe the persona's memory. A warning is posted to the persona's destination; an operator should reconcile the path before restarting.
- `jsonl-transcript-lost` — a persona's transcript is gone from disk (neither the recorded nor the fallback path exists), yet the message archive shows messages in the persona's `delivery: all` channels since the bot spawned. Only those channels are counted. Conversation history has been lost and resume will start the bot fresh. A warning is posted to the persona's destination. Requires `message_archive_db` to be configured for the archive evidence. When the archive shows nothing, the safeguard logs a quiet line only: no transcript is expected for a persona idle since spawn, and for a persona with a `delivery: mentions` channel or DMs on a zero count proves nothing. A row the server will replace rather than resume (its working directory or config directory changed) is not checked.
- `jsonl-transcript-lost-on-resume` — resume actually threw `ErrJsonlMissing` for a persona, so the bot is brought up fresh on the same instance and its agent-director row is kept (its history archived to the earlier life), and the message archive shows messages in the persona's `delivery: all` channels since it spawned — so conversation history was lost, not merely at risk. Only those channels are counted. Once the bot is up, a warning is also posted to the persona's destination ("my conversation memory has been lost and I was brought up fresh by a reuse spawn of the same instance, and its row is kept (its history archived to the earlier life)"); when bringing it up fails, the entry stays and no warning is posted. This is the resume path's own after-the-fact report (distinct from the pre-resume `jsonl-transcript-lost` warning above); the log line names every transcript path tried and whether each came from agent-director or was computed locally. A missing transcript on a persona that was *idle since spawn* — the archive was consulted and shows zero messages since spawn, and every one of the persona's channels is `delivery: all` with DMs off — is expected (the transcript is created lazily on first message) and produces a quiet log line only, no error class and no Slack post. Requires `message_archive_db` for the archive evidence; when the archive cannot be consulted the case is instead reported as `jsonl-diagnosis-inconclusive` below.
- `jsonl-diagnosis-inconclusive` — resume threw `ErrJsonlMissing`, so the bot is brought up fresh on the same instance and its agent-director row is kept, but the diagnosis could not determine whether conversation history was lost: the agent-director row was already gone, `started_at` was unparseable, the message archive could not be read, `message_archive_db` is not configured at all, or the archive shows zero messages but the persona has a `delivery: mentions` channel or DMs on, so a zero count cannot show it was idle (the archive cannot attribute messages from `mentions` channels or DMs to a persona). Because "inconclusive" correlates with the same storage problems that cause real loss, this is surfaced (not silently downgraded to a benign never-created): the line records *why* the diagnosis failed, and once the bot is up, a warning is posted to the persona's destination worded as uncertainty ("on restart I was brought up fresh by a reuse spawn of the same instance, and its row is kept (its history archived to the earlier life); I could not determine whether my prior conversation history was preserved") rather than as a confirmed loss; when bringing it up fails, the entry stays and no warning is posted. When the reason is an unconfigured archive, the message notes that diagnosis is impossible without `message_archive_db` and suggests enabling it. These personas are counted separately in the startup summary as `fresh-after-inconclusive-amnesia` (distinct from the `fresh-after-amnesia` count). When agent-director can't answer that row fetch at all (it is unavailable, or any other error), nothing is diagnosed: no entry is recorded, no warning is posted, the bot is not brought up, and the launch is retried later like any other refused launch. When that row fetch finds conflicting labels noted on the persona's own row, nothing is diagnosed or brought up either: the persona is held (see "A persona posts a *Held: tmux session conflict* notice" under Troubleshooting). So is it when that row fetch answers that the row's recorded tmux session name can't be used (see "A persona posts a *Held: unusable tmux session name* notice" under Troubleshooting), or finds the persona's own row pending with no launch start (see "A persona posts a *Held: launch start not recorded* notice" under Troubleshooting).

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
2. **Tests exist and pass.** At least one `*.test.ts` file under `tests/`, and `bun test`, run with a fresh scratch HOME, exits zero.
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

1. **Install the new CSCB together with agent-director Phase 1**: installing the npm package is not the whole install. This release needs agent-director Phase 1 on the host, installed with it by the runbook in [Switching over to agent-director Phase 1](#switching-over-to-agent-director-phase-1), which also says when to install the package. The npm `agent-director` package CSCB pulls in is only the client; the binary is installed system-wide (see [Prerequisites](#prerequisites)). Remove `claude-director` first if present: `bun remove claude-director`.
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

### Switching over to agent-director Phase 1

This release requires agent-director Phase 1, installed on the host together with it; CSCB changes no agent-director code. The two are installed together, by this runbook, and rolled back together, by "Rolling back the switch-over".

- Every agent on the host, with every long-running agent-director process (`agent-director serve` included), is stopped before either binary change and started again after it.
- The old CSCB never runs against Phase 1, and the new one never against 0.10.0: no bot server runs between step 3 and step 10, and no side-by-side install under another path is used.
- The switch-over log is your own record, kept wherever you choose until rollback is no longer wanted. Each step says what to record in it.
- Run every command as the workers' user (the user the bot server launches workers as), in the tmux environment step 1 pins.
- Steps marked "operator action" are done by a human on the host; nothing in CSCB does them.

#### Arrived here from a startup refusal?

Your new CSCB is installed and its server refused to start with `ad-below-phase1-floor` or `ad-system-install-too-old`. The refusal launched, killed and deleted nothing, and left your bots as they were.

This block covers only a refusal before agent-director Phase 1 is installed on the host, by step 8 or otherwise. Act in this order:

1. If `config.json` is in persona form and no pre-persona copy of it exists, neither step 1's copy nor one you kept elsewhere, stop here and change nothing: no reinstall, no start and no step 1. Rebuild the pre-persona `config.json` by hand, as step 8 of "Rolling back the switch-over" says. Once you have rebuilt it, follow this block again from its start.
2. Otherwise, first rebuild by hand to their pre-persona form, as step 8 of "Rolling back the switch-over" says, the crontable targets and `/interject` callers that the conversion to personas left in persona form where step 1's copy of them is missing. Then reinstall the previous CSCB, the version step 1 recorded or else the version the host ran before, with the pre-persona `config.json`, crontable, `/interject` callers, `access.json` and Slack token environment variables: from step 1's files, or a pre-persona copy of `config.json` you kept, where they exist, and otherwise from those still in place. Start it, re-enabling the host's autostart for CSCB if it was disabled, as step 8's "no go" branch does.
3. Then, if agent-director is not 0.10.0 (below 0.7.0 under `ad-system-install-too-old`; 0.7.0 to 0.9.x under `ad-below-phase1-floor`), bring it to 0.10.0 outside this runbook. This block gives no command for it.
4. Then start the runbook at [step 1](#step-1-check-the-host-and-stage-the-release). Step 3 is then the old CSCB's own stop.

**A refusal after Phase 1 was installed.** Installing agent-director Phase 1 migrates agent-director's store. A refusal at step 10, or at any later start of the new CSCB (an autostart, `clean_restart` or the restart in step 4 of "Rolling back the switch-over" included), on a host whose Phase 1 install was step 8's or agent-director's own install on a publishing host, means the server finds the wrong agent-director binary. For that refusal, and only for it:

1. Check the binary. The server finds `$HOME/.agent-director/bin/agent-director` first, then the first `agent-director` on `PATH`. Take the binary path the startup-errors entry names and run `<path> version`, as the workers' user in the bot server's launcher environment.
2. Then either put agent-director Phase 1 back as the binary the server finds, or follow "Rolling back the switch-over", which starts the previous CSCB. To put it back, stop every agent on the host and every long-running agent-director process (`agent-director serve` included) before that binary change, and start them again after it. A human stops any CSCB bot still running through the item "Stopping a set of agents before a binary change" in the "Operator actions" section of agent-director's README. Once the server finds Phase 1, start the new CSCB as [step 10](#step-10-start-the-new-cscb) does.

Never reinstall the old CSCB onto the migrated store. At the restart in step 4 of "Rolling back the switch-over", an agent that could not be stopped still runs: put nothing back and don't follow the rollback again. The new CSCB stays stopped until agent-director has dealt with that agent (as that step says), and then this branch applies.

**Phase 1 installed some other way.** A host where agent-director Phase 1 was installed in any other way outside this runbook is not a target of this runbook, the same way step 1 sends a host on any version but 0.10.0 outside it. Follow "Rolling back the switch-over" and the item "agent-director was installed outside the caller's switch-over" in the "Operator actions" section of agent-director's README. Don't put Phase 1 back and start the new CSCB.

**A stop by the runtime re-check** is not a switch-over case. See [Found while the server was running](skills/debug-slack-channel-bots/SKILL.md#found-while-the-server-was-running) in the debugging skill.

#### The publishing host

`/publish` checks that the publishing host has an agent-director binary the client accepts: 0.7.0, the client's minimum, or later. This runbook starts by staging a release that is already published, so the host that publishes it is covered here:

1. Publish from a host that already passes that check. This is the first choice.
2. A host with no agent-director installs agent-director's Phase 1 release by agent-director's own install, then publishes. It has no agents and nothing to back up.
3. A host below the client's minimum (0.7.0) publishes from another host, and is not a target of this runbook: it brings agent-director to 0.10.0 first, outside this runbook, since step 1 stops on any version but 0.10.0. This block gives no command for it.

A publishing host needs no install-gate go line.

#### Step 1: Check the host and stage the release

Do this beforehand, with the old CSCB running and still installed as the global package. Nothing goes down in this step.

1. **The go line.** Confirm that agent-director's Phase 1 install-gate record has this host's dated go line. It is written before the Phase 1 install and is the approval for the switch-over. If it does not, stop here, before anything goes down. This runbook never writes the go line.
2. **agent-director's version.** Run `agent-director version` in the bot server's launcher environment, as the workers' user, the same as the Claude Code check below, and confirm that it shows 0.10.0, the only supported starting point. If it does not, stop here, before anything goes down. A host on an earlier version (below 0.7.0, or 0.7.0 to 0.9.x) first brings agent-director to 0.10.0, outside this runbook; this step names no command for it.
3. **The tmux socket (operator action).** Pin the tmux socket for the bot server's launcher, `find-missing-loop.sh` and the workers. Run `tmux display-message -p '#{socket_path}'` from the bot server's launcher, the loop's environment and a worker's. Confirm that all three print the same path, that it is the pinned path (a `TMUX_TMPDIR` that names a missing path falls back silently to `/tmp`), and that the three share one HOME. Record the result in the switch-over log.
4. **tmux.** Confirm tmux 3.2 or later, with `remain-on-exit` off.
5. **Claude Code.** Run `claude --version` in the bot server's launcher environment (the same user and `PATH` the server launches workers with), and confirm that the workers' Claude Code is 2.1.280 or later: the minimum agent-director states for its exec-form hooks, and the version the fleet runs. On a Claude Code too old for exec-form hooks (older than 2.1.139), each hook prints nothing, agent-director records `ad.hook.ignored` with the reason `no_exec_form`, and every launch stays `pending`. If it is older than 2.1.280, stop here, before anything goes down.
6. **agent-director's timing settings.** Read all nine keys of the `[tmux]` table of `~/.agent-director/config.toml` (see [agent-director's timing settings](#agent-directors-timing-settings); a missing file, a missing key or `0` means the default) and its `[pause] timeout_seconds` (30 s when the file or the key is missing). Record the effective values in the switch-over log. Confirm that the three windows, `pending_grace_seconds`, `stopping_window_seconds` and `starting_session_seconds`, are the values you intend and each is at or above its minimum: `starting_session_seconds` 60, `stopping_window_seconds` 30, and `pending_grace_seconds` the larger of 30 and ⌈(`create_timeout_ms` + `pipe_close_wait_ms`) / 1000⌉ + 20. A `pending_grace_seconds` above 540 s shortens agent-director's SessionStart wait to 540 s.
7. **The call timeout.** Always computing from this host's values, confirm that the `agent_director_call_timeout_ms` the persona configuration will carry (staged below; `60000` when it leaves the setting out) exceeds the need: the largest ceiling among the verbs CSCB calls, plus the 15 s margin (15000 ms). Record the computed need in the switch-over log. With Q, A, C, W and E the host's `query_timeout_ms`, `action_timeout_ms`, `create_timeout_ms`, `pipe_close_wait_ms` and `kill_exit_wait_ms`, and B its `sweep_budget_seconds` in ms, the ceilings, in ms, are:
   - `kill`: the larger of 2Q + 2A + E + 4W and 3Q + 2A + 5W;
   - `read-pane`: 3Q + A + 4W;
   - `send-keys`: 3Q + 2A + 5W;
   - `pause`: 3Q + 2A + 5W, plus `[pause] timeout_seconds` (times 1000);
   - the launch row, `resume/spawn-with-reuse/plain-spawn` (`resume`, a spawn with reuse and a plain spawn): the larger of Q + C + 2A + 4W and 2Q + C + 3W;
   - `find-missing`: B + Q + W.

   `expire` is not among them: CSCB never calls it. [Sizing the agent-director call timeout](#sizing-the-agent-director-call-timeout) works through examples.
8. **Leftover sessions.** As the workers' user, on the pinned socket, compare `tmux ls` with `agent-director list`, and record in the switch-over log every `slack_bot_` session that no row names.
9. **Stage the new release without installing it.** Choose its exact version, record it in the switch-over log and confirm that it is available to install. Write the persona configuration, with `agent_director_call_timeout_ms`, in a separate file, never `config.json`, which the old CSCB reads. Prepare the Slack apps. Nothing is installed over the global package yet, so step 3's `stop --stop-bots` is the old version's own and reads the old, pre-persona `config.json`. Steps 1, 2, 3, 5 and 6 of [Upgrading to personas](#upgrading-to-personas) belong here.
10. **Copies for rollback.** Keep copies of the pre-persona `config.json`, the crontable, the `/interject` callers (the host crontab's `curl` lines included), `access.json` and the Slack token environment variables the old CSCB uses. Record the old CSCB's exact version in the switch-over log beside them.
11. **The orchestrator prompt (operator action).** The orchestrator system prompt's "ship now" wording may go out any time before the switch-over.

#### Step 2: Disable CSCB's autostart

Disable the host's autostart for CSCB until step 10 (operator action), and record it in the switch-over log.

#### Step 3: Stop the old CSCB with its bots

With the old CSCB still installed, run its own stop:

```sh
claude-slack-channel-bots stop --stop-bots
```

This is the old version's own `stop --stop-bots`, which reads the old, pre-persona `config.json`, since nothing new is installed before step 7. An operator arriving from a startup refusal has first reinstalled the previous CSCB (see [Arrived here from a startup refusal?](#arrived-here-from-a-startup-refusal)), so this holds for them too. From here until step 10, no bot server runs.

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

Only if step 5 found a leftover with a row. End each such leftover now, with the still-installed 0.10.0 binary. After the Phase 1 install, a row from before it has no launch token or recorded socket, so no session is ever its current launch's: Phase 1's `kill` fails closed on it, and not even agent-director's option for a finished row ends its session.

For each one:

1. Note the session's window ids, as in step 5.
2. Run `agent-director kill --claude-instance-id <id>`, then make the gone check.
3. If the session or one of its windows remains, end the session with the exact-name `tmux kill-session -t =<name>`, and make the gone check again.
4. Run `agent-director find-missing` until the row reads `ended` or `missing`, for at most 5 minutes.

A leftover that cannot be ended this way means no Phase 1 install: take step 8's "no go" branch, and investigate the leftover with `agent-director list --tmux-session-name <name>`.

#### Step 7: Install the new CSCB without starting it

1. Install the staged package over the global install, without starting it; the autostart stays disabled from step 2:
   ```sh
   bun install -g claude-slack-channel-bots@<the version recorded in step 1>
   ```
2. Put the persona configuration in place as `config.json`.
3. Write each persona's credentials file with the new CLI (see [`claude-slack-channel-bots credentials`](#claude-slack-channel-bots-credentials)).
4. Rewrite crontable targets and `/interject` callers to name personas.
5. Run the new install check (see [Checking your agent-director install](#checking-your-agent-director-install)). It passes on the still-installed 0.10.0, with its note.

Steps 4, 7 and 8 of [Upgrading to personas](#upgrading-to-personas) belong here. From this step the new CSCB is deployed but not started.

#### Step 8: Install agent-director Phase 1

1. **The go line.** Confirm that the install-gate record has this host's dated go line.

   **No go.** If it does not, there is no Phase 1 install. Reinstall the previous CSCB, the version step 1 recorded, with the `config.json`, crontable, `/interject` callers, `access.json` and Slack token environment variables saved in step 1. Start it on 0.10.0 and re-enable its autostart (operator action). Every other agent this step already stopped is started again on 0.10.0 by its owner (operator action). The runbook stops there.
2. **Stop every other agent (operator action).** Otherwise, before the install, stop every other agent on the host: orchestrators' workers, hand-started sessions and sessions with an `agent-director serve`. Confirm with `agent-director list` that each stopped agent's row reads `ended` or `missing` (a row that 0.10.0 left stuck live for a dead agent is expected), and with a read-only `tmux ls` that no agent session is left. Record it in the switch-over log. An agent that cannot be stopped means "no go".
3. **Back up the store.** Back up `~/.agent-director/state.db` with an online-consistent copy, sqlite3's `.backup`, not a plain file copy, because the store runs in WAL mode:
   ```sh
   sqlite3 ~/.agent-director/state.db ".backup '<backup file>'"
   ```
   The backup is for disaster recovery only. It is not the rollback path.
4. **Install agent-director Phase 1.** Its schema migration adds thirteen columns and the one-row `store_meta` table, which holds the store's id. Confirm that `agent-director version` shows the Phase 1 version.
5. **Write the `[tmux]` values.** Right after the install, before the restarts that follow and so before the new CSCB starts, write any non-default `[tmux]` values you want into `~/.agent-director/config.toml`. A long-running agent-director process reads the file only when it starts.
6. **Restart `serve` (operator action).** Restart every `agent-director serve` process and every other long-running agent-director process still running. Compare process start times to confirm that none is older than the install. Record the version and that result in the switch-over log.
7. **Check the settings again.** Read the nine timing settings and `[pause] timeout_seconds` again as in step 1, and record the effective values. Confirm them and the call timeout as in step 1; if the need has grown, raise `agent_director_call_timeout_ms` in `config.json` before step 10. Confirm that `agent-director list` answers without `ErrConfigMalformed`.

#### Step 9: Start the other agents again

Every other agent on the host is started again by its owner (operator action), which also starts its `serve` processes on the Phase 1 binary.

#### Step 10: Start the new CSCB

1. **The orchestrator prompt's worker cleanup (operator action).** Before the new CSCB starts, change worker cleanup in the shared orchestrator prompt, `~/.claude/channels/slack/system-prompt.md`, and its source copy, `~/projects/horde_admin/cscb_system_prompt.md`, from row-delete cleanup to "kill, then leave the row". This change goes out in the same deploy as agent-director Phase 1. Kill-then-leave works on 0.10.0 too, so a rollback does not revert it.
2. **Start the new CSCB**, then re-enable the host's autostart for CSCB (operator action):
   ```sh
   claude-slack-channel-bots start
   ```
   The first start has no last-applied record yet, so it checks `config.json`, records it and applies it; after that, edits wait until you apply them (see [Reload](#reload)). Each persona starts fresh once. Pre-persona rows are kept and never resumed.
3. **The post-install check (operator action).** Once every agent has been started again, confirm that `agent-director list --state pending` shows a `launch_started_at` on every row. Record the result in the switch-over log, and as this host's dated post-install check line in agent-director's install-gate record. A row without one is a human's to look at, and the persona whose row it is is held (see "A persona posts a *Held: launch start not recorded* notice" and "How a hold ends" in [Troubleshooting](#troubleshooting)).

#### Step 11: Schedule the daily expire

Schedule a daily `agent-director expire` at the default retention, never `--older-than 0d`, as the workers' user in the tmux environment step 1 pinned (operator action). Add it to the host's sweep loop, `~/startup/find-missing-loop.sh`, the script step 1's socket check names: nothing on the host runs `expire` before this step.

The orchestrator system prompt's "hold until after" wording goes out now (operator action).

### Upgrading to personas

This major version accepts only the persona configuration format. These are the configuration steps of an upgrade from an earlier major version. Do them inside the switch-over runbook, not on their own: steps 1, 2, 3, 5 and 6 (the persona file, names, reply settings, Slack apps and who can reach each persona) at [step 1 of the switch-over](#step-1-check-the-host-and-stage-the-release), and steps 4, 7 and 8 (credentials files, crontable and `/interject` callers) at [step 7 of the switch-over](#step-7-install-the-new-cscb-without-starting-it). At switch-over step 1, these steps are written into the separate staged file, not `config.json`; step 7 puts that file in place as `config.json`.

1. **Rewrite `config.json` by hand.** A configuration from an earlier major version stops the server at start, with an error that names the offending setting and says the configuration must be converted to personas. Nothing is converted automatically and the file is not changed. Write a `personas` list as described in [Personas (config.json)](#personas-configjson); the server-wide settings keep their names. The `debug-slack-channel-bots` skill covers this error under "Pre-persona configuration".
2. **Pick persona names whose keys don't start with one another.** The configuration check rejects such a pair. If your bots were named `horde`, `horde_admin`, …, don't name a persona `horde` beside `horde_admin`: give the shorter name a suffix, such as `horde_main` (see [Persona name and key](#persona-name-and-key)).
3. **Set the reply settings in `config.json`.** Nothing else carries an acknowledgement reaction over: to keep one, set `ack_reaction` as a top-level setting. If you had changed how replies are split, set `reply_chunk_limit` and `reply_chunk_mode` there too. See [Server-wide settings](#server-wide-settings).
4. **Move the tokens into credentials files.** Tokens come only from each persona's credentials file. Create one [credentials file](#credentials-files) per persona, then remove any token environment variables you exported for the previous version.
5. **Give each persona its own Slack app.** Your existing app can serve one persona; create another app for each additional persona. Re-install the existing app from the current `slack-app-manifest.yml` so it gains the `im:write` scope; the `debug-slack-channel-bots` skill has the steps under "A persona can't open a DM".
6. **Decide who can reach each persona.** Who can reach a persona is decided only by its `channels`, each channel's `delivery` and its `dm.enabled` switch (see [Channel delivery](#channel-delivery) and [Direct messages](#direct-messages-dmenabled)).
7. **Rewrite crontable lines to name personas.** A crontable target that names a channel matches no persona, and the line is logged `unknown-persona` each time it fires. Rewrite each target as a persona's name or key (see [Scheduled Prompts](#scheduled-prompts-cscb_cron)).
8. **Update `/interject` callers to send `persona`.** A request without `persona` is refused with 400, and a successful response holds only `ok` and `persona`. Change every script that calls `/interject`, including host crontab `curl` lines, to name a persona by name or key (see [Interject](#interject)).

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

