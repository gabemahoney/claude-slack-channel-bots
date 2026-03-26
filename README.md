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
| `use_waggle` | boolean | `false` | Reserved for future auto-spawn support. |
| `spawn_timeout` | number | `60` | Seconds to wait when spawning a session (reserved). |

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

## How it works

**Inbound routing:** Slack messages arrive over a single Socket Mode connection. The server looks up the message's channel ID in `routing.json`, finds the matching session entry in the registry, and dispatches the message as an MCP notification to that session's server instance. If no session is connected for the channel, the message is dropped.

**Outbound scoping:** Each session tracks the set of channels it has received messages from (`deliveredChannels`). When a session calls the `reply` tool, the server checks that the target channel is in that set (or in the access allowlist). This prevents one session from sending messages to channels it has never received from, isolating sessions from each other even though they share the same bot token.
