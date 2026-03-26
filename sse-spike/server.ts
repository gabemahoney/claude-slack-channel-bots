#!/usr/bin/env bun
/**
 * Minimal HTTP MCP notification server (spike)
 *
 * Uses WebStandardStreamableHTTPServerTransport (native Bun/Web Standard APIs).
 * Exposes a single `ping` tool for connectivity testing.
 * Fires notifications/claude/channel on a 5-second timer and on every ping call.
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js'
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js'

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const PORT = Number(process.env['MCP_PORT'] ?? 3000)

// ---------------------------------------------------------------------------
// MCP Server
// ---------------------------------------------------------------------------

const mcp = new Server(
  { name: 'sse-spike', version: '0.1.0' },
  {
    capabilities: {
      experimental: {
        'claude/channel': {},
      },
      tools: {},
    },
  },
)

// ---------------------------------------------------------------------------
// Tools
// ---------------------------------------------------------------------------

mcp.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: 'ping',
      description: 'Connectivity test. Returns pong and fires a channel notification.',
      inputSchema: {
        type: 'object' as const,
        properties: {},
        required: [],
      },
    },
  ],
}))

mcp.setRequestHandler(CallToolRequestSchema, async (request) => {
  if (request.params.name === 'ping') {
    fireNotification('ping tool called')
    return {
      content: [{ type: 'text', text: 'pong' }],
    }
  }
  return {
    content: [{ type: 'text', text: `Unknown tool: ${request.params.name}` }],
    isError: true,
  }
})

// ---------------------------------------------------------------------------
// Notification helper
// ---------------------------------------------------------------------------

function fireNotification(source: string): void {
  const ts = String(Date.now() / 1000)
  mcp.notification({
    method: 'notifications/claude/channel',
    params: {
      content: `[sse-spike] tick from ${source} at ${new Date().toISOString()}`,
      meta: { source, ts },
    },
  })
  process.stderr.write(`[sse-spike] notification sent — source=${source} ts=${ts}\n`)
}

// ---------------------------------------------------------------------------
// Transport + HTTP server
// ---------------------------------------------------------------------------

const transport = new WebStandardStreamableHTTPServerTransport({
  sessionIdGenerator: undefined, // stateless — no session management
})

await mcp.connect(transport)
process.stderr.write('[sse-spike] MCP server connected to transport\n')

// 5-second notification timer
setInterval(() => {
  fireNotification('timer')
}, 5000)

// Bun HTTP server — route all requests through the transport
Bun.serve({
  port: PORT,
  async fetch(req: Request): Promise<Response> {
    return transport.handleRequest(req)
  },
})

process.stderr.write(`[sse-spike] Listening on http://localhost:${PORT}/mcp\n`)
process.stderr.write('\n')
process.stderr.write('Add to Claude Code ~/.claude.json mcpServers:\n')
process.stderr.write(
  JSON.stringify(
    {
      'sse-spike': {
        type: 'http',
        url: `http://localhost:${PORT}/mcp`,
      },
    },
    null,
    2,
  ) + '\n',
)
process.stderr.write('\n')
