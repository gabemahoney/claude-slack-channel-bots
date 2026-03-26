/**
 * waggle.ts — MCP client wrapper for the waggle tmux-session manager.
 *
 * Implements Task t2.c1r.k7.j8 — MCP client connection to waggle.
 *
 * Waggle is an MCP server that manages tmux sessions. This module connects
 * to waggle as a client (via StdioClientTransport) and exposes typed wrapper
 * functions for the tools we need:
 *   - listAgents()  → calls waggle's list_agents tool
 *   - spawnAgent()  → calls waggle's spawn_agent tool
 *
 * Only activated when use_waggle is true in the routing config.
 *
 * SPDX-License-Identifier: MIT
 */

import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface AgentInfo {
  session_name: string
  status: string
  [key: string]: unknown
}

export interface WaggleClient {
  listAgents(): Promise<AgentInfo[]>
  spawnAgent(sessionName: string, cwd: string): Promise<void>
  disconnect(): Promise<void>
}

// ---------------------------------------------------------------------------
// Internal state
// ---------------------------------------------------------------------------

let _client: Client | null = null
let _transport: StdioClientTransport | null = null

// ---------------------------------------------------------------------------
// Connection
// ---------------------------------------------------------------------------

/**
 * Connect to waggle as an MCP client via StdioClientTransport.
 * Starts the waggle CLI as a subprocess and communicates over stdio.
 * Throws if the connection fails.
 */
export async function connectWaggle(): Promise<void> {
  const transport = new StdioClientTransport({ command: 'waggle', args: [] })
  const client = new Client({ name: 'slack-channel-router', version: '0.1.0' })
  await client.connect(transport)
  _client = client
  _transport = transport
  console.error('[waggle] Connected to waggle MCP server')
}

// ---------------------------------------------------------------------------
// Typed tool wrappers
// ---------------------------------------------------------------------------

/**
 * Call waggle's list_agents tool.
 * Returns an array of agent info objects describing active tmux sessions.
 */
export async function listAgents(): Promise<AgentInfo[]> {
  if (!_client) throw new Error('[waggle] Not connected — call connectWaggle() first')

  const result = await _client.callTool({ name: 'list_agents', arguments: {} })

  // The result content may be a JSON string or structured content
  const content = result.content
  if (!Array.isArray(content) || content.length === 0) return []

  const first = content[0]
  if (typeof first !== 'object' || first === null) return []

  const textContent = first as { type?: string; text?: string }
  if (textContent.type !== 'text' || typeof textContent.text !== 'string') return []

  try {
    const parsed = JSON.parse(textContent.text)
    if (Array.isArray(parsed)) return parsed as AgentInfo[]
    // Some implementations wrap it in an object
    if (parsed && Array.isArray(parsed.agents)) return parsed.agents as AgentInfo[]
    return []
  } catch {
    return []
  }
}

/**
 * Call waggle's spawn_agent tool to create a new tmux session with Claude Code.
 */
export async function spawnAgent(sessionName: string, cwd: string): Promise<void> {
  if (!_client) throw new Error('[waggle] Not connected — call connectWaggle() first')

  await _client.callTool({
    name: 'spawn_agent',
    arguments: { session_name: sessionName, cwd },
  })
}

// ---------------------------------------------------------------------------
// Disconnect
// ---------------------------------------------------------------------------

/**
 * Cleanly disconnect from waggle.
 * Safe to call if not connected.
 */
export async function disconnectWaggle(): Promise<void> {
  if (_transport) {
    try {
      await _transport.close()
    } catch { /* ignore */ }
    _transport = null
  }
  _client = null
  console.error('[waggle] Disconnected from waggle MCP server')
}

// ---------------------------------------------------------------------------
// Injectable interface factory (for testing)
// ---------------------------------------------------------------------------

/**
 * Returns a WaggleClient interface backed by the module-level connected client.
 * This allows SpawnManager to receive a waggle client as a dependency.
 */
export function getWaggleClient(): WaggleClient {
  return {
    listAgents,
    spawnAgent,
    disconnect: disconnectWaggle,
  }
}
