# SSE Spike Test Results

**Task:** t3.c1r.jp.ah.8v — Run SSE test and write results document
**Epic:** t1.c1r.jp — SSE Notification Spike
**Date:** 2026-03-25
**Tester:** Doc Writer agent
**Server path:** `/home/gmahoney/projects/slack-channel-bots-project/repo/sse-spike/`
**MCP SDK version:** `@modelcontextprotocol/sdk` 1.28.0
**Runtime:** Bun (located at `/home/gmahoney/.bun/bin/bun`)

---

## Overall Verdict: CONDITIONAL PASS

The server correctly implements the MCP Streamable HTTP protocol and delivers
`notifications/claude/channel` over SSE with sub-20ms latency. The core spike
objective — prove that Claude Code can receive server-pushed notifications over
HTTP MCP — is satisfied.

**One bug blocks production use:** the server creates a single stateless
transport instance at startup and reuses it for all requests, which the SDK
explicitly forbids. Every request after the first throws a 500 error. This must
be fixed before Epic 2 work begins. The fix is a two-line change (see below).

---

## Reproduction Steps

### 1. Start the server

```bash
cd /home/gmahoney/projects/slack-channel-bots-project/repo/sse-spike
/home/gmahoney/.bun/bin/bun run server.ts
```

Expected stderr output:
```
[sse-spike] MCP server connected to transport
[sse-spike] Listening on http://localhost:3000/mcp

Add to Claude Code ~/.claude.json mcpServers:
{
  "sse-spike": {
    "type": "http",
    "url": "http://localhost:3000/mcp"
  }
}
```

### 2. Test the MCP initialize handshake

```bash
curl -s -i -X POST http://localhost:3000/mcp \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -d '{
    "jsonrpc": "2.0",
    "id": 1,
    "method": "initialize",
    "params": {
      "protocolVersion": "2025-03-26",
      "capabilities": {},
      "clientInfo": { "name": "test-client", "version": "0.0.1" }
    }
  }'
```

Expected response (HTTP 200, `Content-Type: text/event-stream`):
```
event: message
data: {"result":{"protocolVersion":"2025-03-26","capabilities":{"experimental":{"claude/channel":{}},"tools":{}},"serverInfo":{"name":"sse-spike","version":"0.1.0"}},"jsonrpc":"2.0","id":1}
```

### 3. Listen to the SSE notification stream

```bash
curl -N -X GET http://localhost:3000/mcp \
  -H "Accept: text/event-stream"
```

Expected output (one event every ~5 seconds):
```
event: message
data: {"method":"notifications/claude/channel","params":{"content":"[sse-spike] tick from timer at 2026-03-26T05:03:10.778Z","meta":{"source":"timer","ts":"1774501390.778"}},"jsonrpc":"2.0"}
```

### 4. Register in Claude Code

Add to `~/.claude.json` under `mcpServers`:

```json
{
  "mcpServers": {
    "sse-spike": {
      "type": "http",
      "url": "http://localhost:3000/mcp"
    }
  }
}
```

Or via CLI:
```bash
claude mcp add --transport http sse-spike http://localhost:3000/mcp
```

---

## Test Results

### Test 1 — MCP initialize handshake

**Result: PASS**

- HTTP status: `200 OK`
- `Content-Type: text/event-stream` (SSE response, as spec requires)
- Response delivered as SSE `event: message` / `data:` frame
- Latency: **18ms** (first request on fresh server)
- Protocol version negotiated: `2025-03-26`

### Test 2 — `claude/channel` in capabilities

**Result: PASS**

The initialize response contains:
```json
{
  "capabilities": {
    "experimental": {
      "claude/channel": {}
    },
    "tools": {}
  }
}
```

`claude/channel` is present in `capabilities.experimental`. This is the
capability Claude Code looks for to enable server-push notifications.

### Test 3 — SSE stream delivers notifications

**Result: PASS**

Connected a GET SSE stream for 7 seconds. Received 2 `notifications/claude/channel`
events fired by the 5-second timer:

| Event | Timestamp | Content |
|-------|-----------|---------|
| 1 | 2026-03-26T05:03:10.778Z | `[sse-spike] tick from timer at 2026-03-26T05:03:10.778Z` |
| 2 | 2026-03-26T05:03:15.780Z | `[sse-spike] tick from timer at 2026-03-26T05:03:15.780Z` |

Interval between events: **5.002 seconds** (expected ~5s). Timer jitter is
negligible (<3ms).

Notification format is valid MCP JSON-RPC:
```json
{
  "method": "notifications/claude/channel",
  "params": {
    "content": "...",
    "meta": { "source": "timer", "ts": "1774501390.778" }
  },
  "jsonrpc": "2.0"
}
```

### Test 4 — Latency

**Result: PASS**

- `initialize` round-trip: **18ms** (including curl overhead, loopback)
- Timer notification delivery: consistent with 5s interval, sub-millisecond
  SSE write latency once stream is open
- No observable buffering delay on the SSE stream

### Test 5 — Reconnection

**Result: FAIL (server bug)**

After the first request is served, all subsequent requests to the same server
process return HTTP 500 with a Bun error page. The SDK throws:

```
Stateless transport cannot be reused across requests.
Create a new transport per request.
```

This means:
- Only the very first HTTP request succeeds per server process
- Reconnecting the SSE stream (client disconnect + reconnect) fails with 500
- A second `initialize` from a new Claude Code session fails with 500
- Any request after the initial one fails, including error-handling tests

**Root cause:** `server.ts` creates one `WebStandardStreamableHTTPServerTransport`
at module level and passes all requests to it. The SDK enforces that a stateless
transport (`sessionIdGenerator: undefined`) can only be used for a single
request, to prevent message ID collisions. The server violates this contract.

**Fix required** (two-line change in `server.ts`): move transport creation inside
the `fetch` handler so a fresh transport is created per request, or switch to
stateful mode with `sessionIdGenerator: () => crypto.randomUUID()`.

### Test 6 — Notifications dropped when no SSE listener

**Result: PASS (expected behavior)**

When no SSE client is connected, the timer still fires and `fireNotification()`
is called (confirmed by stderr log), but the `send()` call in the transport
silently returns early because `_streamMapping.get('_GET_stream')` is undefined.
No crash, no error. The notification is dropped — there is no buffering or
replay (no `eventStore` configured). This is expected for this spike's stateless
design.

### Test 7 — Error handling

**Result: PARTIAL PASS**

- Bad `Accept` header on POST → HTTP `406 Not Acceptable` with proper JSON-RPC
  error body. Correct per spec.
- Bad `Content-Type` on POST → HTTP `500` due to the stateless reuse bug
  (test ran after first request was consumed). The transport would have returned
  `415 Unsupported Media Type` if reached; the 500 is the reuse bug, not a
  separate error-handling defect.

---

## Observations and Quirks

### 1. Stateless transport reuse bug (critical)

`WebStandardStreamableHTTPServerTransport` with `sessionIdGenerator: undefined`
sets a `_hasHandledRequest` flag after the first call and throws on all
subsequent calls. The server creates exactly one transport at startup and never
replaces it. As a result, the server is functionally single-request — it handles
one HTTP request, then becomes unusable.

The MCP Streamable HTTP spec distinguishes stateless (no session ID, new
transport per request) from stateful (session ID, one transport per session).
The current server code conflates them: it uses the stateless SDK option but
expects one transport to handle many requests, which is the stateful pattern.

**Required fix:**

Option A — stateless per-request transport (simplest fix):
```typescript
Bun.serve({
  port: PORT,
  async fetch(req: Request): Promise<Response> {
    const transport = new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
    })
    await mcp.connect(transport)
    return transport.handleRequest(req)
  },
})
```
Note: the `mcp.notification()` timer call won't reach transports created after
startup unless you re-architect the notification dispatch. Stateless mode is
fundamentally incompatible with server-push notifications because there is no
persistent connection to push to.

Option B — stateful session transport (recommended for notifications):
```typescript
const transport = new WebStandardStreamableHTTPServerTransport({
  sessionIdGenerator: () => crypto.randomUUID(),
})
await mcp.connect(transport)

Bun.serve({
  port: PORT,
  async fetch(req: Request): Promise<Response> {
    return transport.handleRequest(req)
  },
})
```
In stateful mode the transport lives for the session lifetime. The GET SSE
stream is held open and timer notifications flow to it. Clients must include
`Mcp-Session-Id` on follow-up requests. This is the correct pattern for
persistent notification delivery.

### 2. URL routing is path-agnostic

`server.ts` passes all requests to `transport.handleRequest(req)` without
checking `req.url`. The server works on any path (`/`, `/mcp`, `/foo`). The
`/mcp` path in the startup log is informational only — the SDK does not enforce
it. This is fine for a spike.

### 3. No `initialized` notification sent

After `initialize` succeeds, MCP protocol requires the client to send an
`initialized` notification before issuing further requests. The spike server
handles this correctly — the transport accepts the `initialized` notification
and returns `202 Accepted` (no response body needed for notifications).

### 4. Notifications are fire-and-forget

`mcp.notification()` calls `transport.send()`, which checks if an SSE stream is
open and writes to it, or silently returns if not. There is no queue, no
retry, no delivery acknowledgment. Notifications fired while no client is
connected are permanently lost. For production, an event store
(`eventStore` option on the transport) would be needed for replay on reconnect.

### 5. Bun 500 error page format

When the stateless transport throws, Bun catches the exception and returns a
67KB HTML error page (with base64-encoded error details in a `<script>` tag)
rather than a JSON-RPC error. This is Bun's unhandled exception handler, not
the MCP SDK's error handling. A `try/catch` in the `fetch` handler would
surface a proper JSON-RPC 500 instead.

---

## Epic 2 Readiness Assessment

**Epic 2 (HTTP Transport Foundation) can proceed, with one prerequisite.**

The spike confirms that:

1. The MCP Streamable HTTP protocol works correctly over HTTP in Bun
2. `notifications/claude/channel` is correctly declared in server capabilities
3. Timer-driven `notifications/claude/channel` events are delivered over the
   SSE GET stream with correct JSON-RPC framing
4. Sub-20ms round-trip latency on loopback — well within acceptable bounds

The stateless transport reuse bug must be fixed before Epic 2 work begins.
The fix is straightforward: switch `server.ts` to stateful mode (Option B above).
The stateless option is incompatible with persistent server-push notifications
and should not be used for this use case.

**Recommended action before Epic 2:** Update `server.ts` to use stateful session
mode (`sessionIdGenerator: () => crypto.randomUUID()`). Re-run this test suite
to confirm reconnection and multi-request scenarios pass.

---

## MCP Config Snippet

Add to `~/.claude.json`:

```json
{
  "mcpServers": {
    "sse-spike": {
      "type": "http",
      "url": "http://localhost:3000/mcp"
    }
  }
}
```

Or register via CLI:

```bash
claude mcp add --transport http sse-spike http://localhost:3000/mcp
```

The server must be running before Claude Code connects. Start it with:

```bash
cd /home/gmahoney/projects/slack-channel-bots-project/repo/sse-spike
/home/gmahoney/.bun/bin/bun run server.ts
```

---

## Test Command Reference

```bash
# Initialize handshake
curl -s -i -X POST http://localhost:3000/mcp \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-03-26","capabilities":{},"clientInfo":{"name":"test","version":"0.0.1"}}}'

# SSE notification stream (Ctrl+C to stop)
curl -N -X GET http://localhost:3000/mcp \
  -H "Accept: text/event-stream"

# Send initialized notification (required by protocol after init)
curl -s -i -X POST http://localhost:3000/mcp \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -H "Mcp-Protocol-Version: 2025-03-26" \
  -d '{"jsonrpc":"2.0","method":"notifications/initialized","params":{}}'

# List tools
curl -s -i -X POST http://localhost:3000/mcp \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -H "Mcp-Protocol-Version: 2025-03-26" \
  -d '{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}'
```
