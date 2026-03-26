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
        └── /mcp  ──►  Claude Code session A  (cwd: ~/projects/alpha, channel: #project-a)
                  ──►  Claude Code session B  (cwd: ~/projects/beta,  channel: #project-b)
                  ──►  Claude Code session C  (cwd: ~/projects/gamma, channel: #project-c)
```

All Claude Code sessions connect to the same `/mcp` endpoint. After the MCP handshake, the server calls `roots/list` on the client and matches the reported CWD against `routing.json` to assign a route. Channel `#project-a` sends messages only to session A, channel `#project-b` only to session B, and so on.

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
    "C0123456789": { "cwd": "~/projects/alpha" },
    "C9876543210": { "cwd": "~/projects/beta" }
  },
  "default_dm_session": "~/projects/alpha"
}
```

---

## Routing Configuration

`routing.json` is read from `~/.claude/channels/slack/routing.json` by default.

### Full example

```json
{
  "routes": {
    "C0123456789": { "cwd": "~/projects/alpha" },
    "C9876543210": { "cwd": "~/projects/beta" }
  },
  "default_route": "~/projects/alpha",
  "default_dm_session": "~/projects/alpha",
  "bind": "127.0.0.1",
  "port": 3100
}
```

### Field reference

| Field | Type | Default | Description |
|---|---|---|---|
| `routes` | object | required | Map of Slack channel ID → route entry. Each entry has `cwd` (the working directory for that session — used to identify sessions via `roots/list`). `~` is expanded. |
| `default_route` | string | — | CWD path to use when a message arrives on a channel with no explicit entry in `routes`. Must match an existing route `cwd`. |
| `default_dm_session` | string | — | CWD path of the session that handles direct messages. Must match an existing route `cwd`. |
| `bind` | string | `"127.0.0.1"` | Interface the HTTP server binds to. Use `"0.0.0.0"` to expose on all interfaces. |
| `port` | number | `3100` | Port the HTTP server listens on. |

---

## Starting the server

```sh
bun run server.ts
```

On startup the server prints the single MCP endpoint URL and example `mcpServers` config:

```
[slack] Loaded routing config: 2 route(s)
[slack] Socket Mode connected
[slack] MCP server listening on http://127.0.0.1:3100/mcp

{
  "mcpServers": {
    "slack": { "type": "http", "url": "http://127.0.0.1:3100/mcp" }
  }
}
```

---

## Connecting Claude Code sessions

All sessions connect to the same `/mcp` URL. The server identifies each session by calling `roots/list` after the MCP handshake and matching the reported CWD against `routing.json`.

### 1. Add the MCP server to `~/.claude.json`

Add the following entry once (globally or per-project):

```json
{
  "mcpServers": {
    "slack": {
      "type": "http",
      "url": "http://127.0.0.1:3100/mcp"
    }
  }
}
```

The server prints this snippet on startup as a reminder.

### 2. Launch Claude from the project directory

```sh
cd ~/projects/alpha
claude
```

The server matches the session's CWD (from `roots/list`) to the `cwd` field in `routing.json`. Sessions with an unrecognized CWD are disconnected.

---

## How it works

**Session identification:** When a Claude Code session connects to `/mcp`, the server calls `roots/list` after the MCP handshake and matches the reported CWD against the `cwd` fields in `routing.json`. On a match, the session is registered for that route. Sessions with an unrecognized CWD are disconnected.

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
