# Slack Channel Router

A single HTTP MCP server that holds one Slack Socket Mode connection and routes messages to multiple independent Claude Code sessions, each scoped to a different repo and reachable via its own Slack channel. Inbound messages are dispatched to whichever session owns the channel they arrived on; outbound tool calls are restricted to channels that session has previously received a message from.

---

## Architecture

```
Slack (Socket Mode)
        │
        ▼
  server.ts (Bun HTTP + SocketModeClient)
        │
        ├── /mcp/project-a  ──►  Claude Code session A  (cwd: ~/projects/alpha)
        ├── /mcp/project-b  ──►  Claude Code session B  (cwd: ~/projects/beta)
        └── /mcp/project-c  ──►  Claude Code session C  (cwd: ~/projects/gamma)
```

Each Claude Code session connects to its own MCP endpoint. Channel `#project-a` sends messages only to session A, channel `#project-b` only to session B, and so on.

---

## Prerequisites

- [Bun](https://bun.sh) v1.0+
- A Slack app with **Socket Mode** enabled
- A **Bot Token** (`xoxb-…`) with scopes: `chat:write`, `reactions:write`, `channels:history`, `im:history`, `files:read`
- An **App-Level Token** (`xapp-…`) with scope: `connections:write`

---

## Setup

### 1. Clone and install

```sh
git clone <repo-url>
cd slack-channel-bots-project/repo
bun install
```

### 2. Configure credentials

Credentials are read from `~/.claude/channels/slack/.env` (the path can be overridden with the `SLACK_STATE_DIR` environment variable):

```sh
mkdir -p ~/.claude/channels/slack
cat > ~/.claude/channels/slack/.env <<'EOF'
SLACK_BOT_TOKEN=xoxb-your-bot-token
SLACK_APP_TOKEN=xapp-your-app-token
EOF
chmod 600 ~/.claude/channels/slack/.env
```

#### Environment variables

| Variable | Description |
|---|---|
| `SLACK_BOT_TOKEN` | Slack bot token (`xoxb-…`). Read from `.env` file. |
| `SLACK_APP_TOKEN` | Slack app-level token (`xapp-…`). Read from `.env` file. |
| `SLACK_STATE_DIR` | Override the directory where `.env`, `routing.json`, and access state are stored. Defaults to `~/.claude/channels/slack`. |
| `SLACK_ACCESS_MODE` | Set to `static` to load the access config once at startup and cache it for the lifetime of the process, rather than re-reading it on every event. Useful in high-throughput environments where disk reads are a concern. |

### 3. Configure routing

Create `~/.claude/channels/slack/routing.json` (see [Routing Configuration](#routing-configuration) below):

```json
{
  "routes": {
    "C0123456789": { "name": "project-a", "cwd": "~/projects/alpha" },
    "C9876543210": { "name": "project-b", "cwd": "~/projects/beta" }
  },
  "default_dm_session": "project-a"
}
```

---

## Routing Configuration

`routing.json` is read from `~/.claude/channels/slack/routing.json` by default.

### Full example

```json
{
  "routes": {
    "C0123456789": { "name": "project-a", "cwd": "~/projects/alpha" },
    "C9876543210": { "name": "project-b", "cwd": "~/projects/beta" }
  },
  "default_route": "project-a",
  "default_dm_session": "project-a",
  "bind": "127.0.0.1",
  "port": 3100,
  "use_waggle": false,
  "spawn_timeout": 60
}
```

### Field reference

| Field | Type | Default | Description |
|---|---|---|---|
| `routes` | object | required | Map of Slack channel ID → route entry. Each entry has `name` (the route identifier used in the URL) and `cwd` (the working directory for that session). `~` is expanded. |
| `default_route` | string | — | Route name to use when a message arrives on a channel with no explicit entry in `routes`. Must match an existing route name. |
| `default_dm_session` | string | — | Route name that handles direct messages. Must match an existing route name. |
| `bind` | string | `"127.0.0.1"` | Interface the HTTP server binds to. Use `"0.0.0.0"` to expose on all interfaces. |
| `port` | number | `3100` | Port the HTTP server listens on. |
| `use_waggle` | boolean | `false` | Enable auto-spawn of Claude Code sessions via waggle when a message arrives for a disconnected route. Requires waggle to be installed and in PATH. |
| `spawn_timeout` | number | `60` | Seconds to wait for a spawned session to connect before giving up and reporting an error to the originating channel. |

---

## Starting the server

```sh
bun run server.ts
```

On startup the server prints the MCP endpoint URLs and example `mcpServers` config for each configured route:

```
[slack] Loaded routing config: 2 route(s): project-a, project-b
[slack] Socket Mode connected
[slack] MCP server listening on http://127.0.0.1:3100/mcp/<routeName>

{
  "mcpServers": {
    "slack-project-a": { "type": "http", "url": "http://127.0.0.1:3100/mcp/project-a" },
    "slack-project-b": { "type": "http", "url": "http://127.0.0.1:3100/mcp/project-b" }
  }
}
```

---

## Connecting Claude Code sessions

Each Claude Code session needs to be told about the MCP endpoint for its route. Use `claude mcp add` in the working directory of the repo you want to connect:

```sh
# In ~/projects/alpha
claude mcp add --transport http slack-project-a http://127.0.0.1:3100/mcp/project-a

# In ~/projects/beta
claude mcp add --transport http slack-project-b http://127.0.0.1:3100/mcp/project-b
```

The URL pattern is `http://<host>:<port>/mcp/<routeName>` where `routeName` matches the `name` field in the routing config. The server rejects connections for unknown route names.

---

## Waggle auto-spawn

The router can automatically start a Claude Code session when a Slack message arrives for a route that has no connected session. This is done via [waggle](https://github.com/anthropics/waggle), an MCP server that manages tmux sessions.

### What waggle does

When `use_waggle` is `true` and a message arrives for a disconnected route, the router:

1. Checks whether a tmux session named after the route already exists (via waggle's `list_agents` tool).
2. If none exists, calls waggle's `spawn_agent` tool to create a new tmux session running Claude Code in the route's `cwd`.
3. Queues the incoming message while waiting for the session to connect to its MCP endpoint.
4. Flushes the queue once the session connects. If the session does not connect within `spawn_timeout` seconds, the queued messages are discarded and an error is posted to the originating Slack channel.

### Prerequisites

waggle must be installed and available in `PATH` before starting the router:

```sh
which waggle   # should print a path
```

### Configuration

Add `use_waggle: true` to your `routing.json`. The route `name` field is used as the tmux session name, so it must be a valid tmux identifier:

```json
{
  "routes": {
    "C0123456789": { "name": "project-a", "cwd": "~/projects/alpha" },
    "C9876543210": { "name": "project-b", "cwd": "~/projects/beta" }
  },
  "default_dm_session": "project-a",
  "use_waggle": true,
  "spawn_timeout": 60
}
```

### Error messages

If spawning fails or times out, the router posts a message to the originating channel:

| Situation | Message posted to Slack |
|---|---|
| Spawn timed out | `[Router] Session spawn for route \`<name>\` timed out after <N>s` |
| Spawn error (e.g. waggle not found) | `[Router] Failed to spawn session for route \`<name>\`: <reason>` |

To fix a timeout, check that the Claude Code session in the tmux window connected to the correct MCP endpoint (`claude mcp add …`) and that nothing is blocking the connection. Increase `spawn_timeout` if startup is slow on your machine.

### Disabling auto-spawn

Set `use_waggle: false` (the default) to run without auto-spawn. Messages that arrive for a disconnected route are silently dropped.

---

## How it works

**Inbound routing:** Slack messages arrive over a single Socket Mode connection. The server looks up the message's channel ID in `routing.json`, finds the matching session entry in the registry, and dispatches the message as an MCP notification to that session's server instance. If no session is connected for the channel, the message is dropped.

**Outbound scoping:** Each session tracks the set of channels it has received messages from (`deliveredChannels`). When a session calls the `reply` tool, the server checks that the target channel is in that set (or in the access allowlist). This prevents one session from sending messages to channels it has never received from, isolating sessions from each other even though they share the same bot token.

---

## Tools

Each MCP endpoint exposes the following tools to the connected Claude Code session:

| Tool | Description |
|---|---|
| `reply` | Send a message to a Slack channel or DM. Auto-chunks long text. Supports file attachments. |
| `react` | Add an emoji reaction to a Slack message. |
| `edit_message` | Edit a previously sent message (bot's own messages only). |
| `fetch_messages` | Fetch message history from a channel or thread. Returns oldest-first. |
| `download_attachment` | Download attachments from a Slack message. Returns local file paths. |
