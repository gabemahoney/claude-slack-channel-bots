/**
 * spawn-manager.ts — Per-route spawn state machine for waggle auto-spawn.
 *
 * Implements Task t2.c1r.k7.6b — Spawn flow with dedup, timeout, and message queuing.
 *
 * When a Slack message arrives for a route that has no connected session and
 * use_waggle is true, SpawnManager coordinates spawning a new Claude Code session
 * via waggle and queues messages until the session connects.
 *
 * State machine per route:
 *   idle → spawning → connected (flush queue)
 *   idle → spawning → timed-out (discard queue, return to idle)
 *   idle → spawning → error (discard queue, return to idle)
 *
 * SPDX-License-Identifier: MIT
 */

import type { AgentInfo, WaggleClient } from './waggle.ts'
import type { SessionEntry } from './registry.ts'
import type { RoutingConfig } from './config.ts'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface QueuedMessage {
  /** Slack channel ID the message arrived on */
  channelId: string
  /** Notification method */
  method: string
  /** Notification params */
  params: { content: string; meta: Record<string, string> }
}

const MAX_QUEUE_DEPTH = 50

type SpawnState = 'idle' | 'spawning'

interface RouteState {
  state: SpawnState
  queue: QueuedMessage[]
  /** Resolve function to signal that the session connected (for polling loop) */
  connectResolvers: Array<(entry: SessionEntry) => void>
  /** Reject function to signal failure */
  connectRejecters: Array<(err: Error) => void>
}

export interface SpawnManagerDeps {
  waggle: WaggleClient
  registry: {
    getSessionByRoute(routeName: string): SessionEntry | undefined
  }
  config: RoutingConfig
  onError: (channelId: string, error: string) => void
}

// ---------------------------------------------------------------------------
// SpawnManager
// ---------------------------------------------------------------------------

export class SpawnManager {
  private deps: SpawnManagerDeps
  private routeStates = new Map<string, RouteState>()

  constructor(opts: SpawnManagerDeps) {
    this.deps = opts
  }

  // ---------------------------------------------------------------------------
  // Public API
  // ---------------------------------------------------------------------------

  /**
   * Called when a message arrives for a disconnected route.
   *
   * Returns the SessionEntry immediately if the session is already connected.
   * Returns null if the session is being spawned (message is queued).
   * On connect, the queued messages are flushed via the session's server.
   */
  async ensureSession(
    routeName: string,
    channelId: string,
    message: QueuedMessage,
  ): Promise<SessionEntry | null> {
    const { registry } = this.deps

    // Fast path: already live
    const existing = registry.getSessionByRoute(routeName)
    if (existing && existing.connected) return existing

    const state = this._getOrCreateState(routeName)

    if (state.state === 'spawning') {
      // Already in progress — just queue the message, enforcing max depth
      if (state.queue.length >= MAX_QUEUE_DEPTH) {
        const dropped = state.queue.shift()
        console.error(
          `[spawn-manager] Route "${routeName}" queue full (${MAX_QUEUE_DEPTH}) — dropped oldest message`,
        )
        void dropped // suppress unused-variable warning
      }
      state.queue.push(message)
      console.error(
        `[spawn-manager] Route "${routeName}" already spawning — queued message (queue depth: ${state.queue.length})`,
      )
      return null
    }

    // Transition to spawning
    state.state = 'spawning'
    // Enforce max depth even on the first message (defensive)
    if (state.queue.length >= MAX_QUEUE_DEPTH) {
      state.queue.shift()
    }
    state.queue.push(message)
    console.error(`[spawn-manager] Spawning session for route "${routeName}"`)

    // Kick off spawn sequence in background; don't await here to avoid blocking caller
    this._spawnSequence(routeName, channelId).catch((err) => {
      console.error(`[spawn-manager] Spawn sequence error for route "${routeName}":`, err)
    })

    return null
  }

  /**
   * Called when a session connects to the registry.
   * Flushes any queued messages and transitions the route back to idle.
   */
  notifyConnected(routeName: string, entry: SessionEntry): void {
    const state = this.routeStates.get(routeName)
    if (!state) return

    const queue = state.queue.splice(0)
    state.state = 'idle'

    // Resolve all waiting promises
    const resolvers = state.connectResolvers.splice(0)
    for (const resolve of resolvers) resolve(entry)

    if (queue.length > 0) {
      console.error(
        `[spawn-manager] Flushing ${queue.length} queued message(s) for route "${routeName}"`,
      )
      for (const msg of queue) {
        try {
          entry.server.notification({ method: msg.method, params: msg.params })
          entry.deliveredChannels.add(msg.channelId)
        } catch (err) {
          console.error(`[spawn-manager] Error flushing queued message for route "${routeName}":`, err)
        }
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Internal helpers
  // ---------------------------------------------------------------------------

  private _getOrCreateState(routeName: string): RouteState {
    let state = this.routeStates.get(routeName)
    if (!state) {
      state = { state: 'idle', queue: [], connectResolvers: [], connectRejecters: [] }
      this.routeStates.set(routeName, state)
    }
    return state
  }

  private async _spawnSequence(routeName: string, channelId: string): Promise<void> {
    const { waggle, registry, config, onError } = this.deps
    const timeoutMs = config.spawn_timeout * 1000
    const state = this._getOrCreateState(routeName)

    // Find the cwd for this route from the config
    const routeEntry = Object.entries(config.routes).find(([, r]) => r.name === routeName)
    const cwd = routeEntry?.[1].cwd ?? process.cwd()

    try {
      // Step 1: check if a tmux session already exists for this route
      let agents: AgentInfo[] = []
      try {
        agents = await waggle.listAgents()
      } catch (err) {
        console.error(`[spawn-manager] listAgents() failed for route "${routeName}":`, err)
        // Don't abort — we'll try to spawn anyway
      }

      const existingAgent = agents.find((a) => a.session_name === routeName)

      if (!existingAgent) {
        // No session — spawn one
        console.error(
          `[spawn-manager] No existing tmux session for route "${routeName}" — calling spawnAgent`,
        )
        await waggle.spawnAgent(routeName, cwd)
      } else {
        console.error(
          `[spawn-manager] Found existing tmux session for route "${routeName}" — waiting for MCP connect`,
        )
      }

      // Step 2: poll the registry until the session connects or timeout
      const connected = await this._waitForConnection(routeName, timeoutMs)

      if (connected) {
        // notifyConnected will flush the queue; but if it wasn't called externally,
        // we flush here directly as well
        const entry = registry.getSessionByRoute(routeName)
        if (entry && entry.connected) {
          this.notifyConnected(routeName, entry)
        }
      } else {
        // Timed out
        this._failRoute(routeName, channelId, `timed out after ${config.spawn_timeout}s`)
        onError(
          channelId,
          `[Router] Session spawn for route \`${routeName}\` timed out after ${config.spawn_timeout}s`,
        )
      }
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err)
      this._failRoute(routeName, channelId, reason)
      onError(
        channelId,
        `[Router] Failed to spawn session for route \`${routeName}\`: ${reason}`,
      )
    }
  }

  /**
   * Poll the registry until the session connects or timeout expires.
   * Returns true if connected, false if timed out.
   */
  private async _waitForConnection(routeName: string, timeoutMs: number): Promise<boolean> {
    const { registry } = this.deps
    const pollIntervalMs = 500
    const deadline = Date.now() + timeoutMs

    while (Date.now() < deadline) {
      const entry = registry.getSessionByRoute(routeName)
      if (entry && entry.connected) return true

      await new Promise<void>((resolve) => setTimeout(resolve, pollIntervalMs))
    }

    return false
  }

  /**
   * Transition route to idle, discard queue, reject any waiting promises.
   */
  private _failRoute(routeName: string, _channelId: string, reason: string): void {
    const state = this.routeStates.get(routeName)
    if (!state) return

    state.queue.splice(0) // discard
    state.state = 'idle'

    const rejecters = state.connectRejecters.splice(0)
    state.connectResolvers.splice(0)
    const err = new Error(`[spawn-manager] Spawn failed for route "${routeName}": ${reason}`)
    for (const reject of rejecters) reject(err)

    console.error(
      `[spawn-manager] Spawn failed for route "${routeName}": ${reason} — queue discarded`,
    )
  }
}
