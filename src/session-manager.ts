/**
 * session-manager.ts — Startup orchestration for claude-director-managed Claude Code sessions.
 *
 * Handles three cases per route at server startup via the collision-then-act dispatch:
 *   fresh     — no existing spawn → direct spawn
 *   collision → get → resume/reconnect/wait-then-reconnect/no-op based on state
 *   orphan cleanup — spawns whose channel label is not a configured route are killed and deleted
 *
 * SPDX-License-Identifier: MIT
 */

import { existsSync } from 'fs'
import {
  spawn as cliSpawn,
  resume as cliResume,
  list as cliList,
  get as cliGet,
  kill as cliKill,
  deleteSpawn as cliDeleteSpawn,
  status as cliStatus,
  sendKeys as cliSendKeys,
  type ClaudeDirectorError,
} from './claude-director-cli.ts'
import { checkCozempicAvailable, resolveJsonlPath } from './cozempic.ts'
import { type RoutingConfig, MCP_SERVER_NAME } from './config.ts'
import { recordStartupError } from './startup-errors.ts'
import { isDryRun } from './tokens.ts'
import { type WebClient } from '@slack/web-api'

// ---------------------------------------------------------------------------
// Live-state set — reused by isSessionAliveAdapter (server.ts) and the E2-T5 poller
// ---------------------------------------------------------------------------

/**
 * claude-director states in which a spawn is considered alive.
 * Terminal states (ended, missing) and ErrSpawnNotFound are treated as dead.
 */
export const CLAUDE_DIRECTOR_LIVE_STATES = new Set([
  'pending',
  'waiting',
  'working',
  'ask_user',
  'check_permission',
] as const)

// ---------------------------------------------------------------------------
// JSONL existence helper (kept for resume pre-check)
// ---------------------------------------------------------------------------

/**
 * Returns true if the JSONL conversation file exists for the given session.
 */
export function jsonlExistsForSession(cwd: string, sessionId: string, configDir?: string): boolean {
  if (!/^[a-zA-Z0-9_-]+$/.test(sessionId)) return false
  const path = resolveJsonlPath(cwd, sessionId, configDir)
  return existsSync(path)
}

// ---------------------------------------------------------------------------
// Spawn-failure queue (E6) — pre-auth buffering
// ---------------------------------------------------------------------------

interface SpawnFailureEntry {
  channelId: string
  error: ClaudeDirectorError
  remediation: string
}

const spawnFailureQueue: SpawnFailureEntry[] = []

/**
 * Surface a spawn failure to the bot's configured Slack channel.
 * Pre-auth: pushed onto queue; flushed by flushSpawnFailureQueue after socket.start().
 * Dry-run: logs to stderr; does NOT call web.chat.postMessage.
 * chat.postMessage failure: logged via errorSink (startup-errors.log at startup,
 * console.error at runtime). Never thrown.
 */
export function postSpawnFailureToChannel(
  channelId: string,
  error: ClaudeDirectorError,
  web?: WebClient,
  isStartup = true,
): void {
  const remediation = remediationHint(error)

  if (!web) {
    // Pre-auth: queue it
    spawnFailureQueue.push({ channelId, error, remediation })
    return
  }

  if (isDryRun()) {
    console.error(
      `[slack] dry-run: would post spawn failure for channel=${channelId} kind=${error.kind} remediation="${remediation}"`,
    )
    return
  }

  const errorMsg = (error as Record<string, unknown>)['message'] as string | undefined
    ?? (error as Record<string, unknown>)['stderr'] as string | undefined
    ?? String(error.kind)
  const text =
    `Spawn failure for channel \`${channelId}\`:\n` +
    `  Error: \`${error.kind}\` — ${errorMsg.slice(0, 300)}\n` +
    `  Remediation: ${remediation}`

  web.chat.postMessage({ channel: channelId, text }).catch((err) => {
    if (isStartup) {
      recordStartupError('spawn-failure-post', `failed to post spawn failure to channel=${channelId}`, err)
    } else {
      console.error(`[slack] spawn-failure-post: failed to post spawn failure to channel=${channelId}`, err)
    }
  })
}

function remediationHint(error: ClaudeDirectorError): string {
  switch (error.kind) {
    case 'ErrBinaryMissing':
      return 'Install claude-director (see docs).'
    case 'ErrNonZeroExit':
      return 'Check claude-director logs and `claude-director list`.'
    case 'ErrInstanceIdCollision':
      return 'spawn dispatcher bug — please report'
    default:
      return 'Check server.log for details.'
  }
}

/**
 * Drain the pre-auth queue after socket.start() succeeds.
 * Called from server.ts main() immediately after socket.start().
 */
export function flushSpawnFailureQueue(web: WebClient): void {
  while (spawnFailureQueue.length > 0) {
    const entry = spawnFailureQueue.shift()!
    postSpawnFailureToChannel(entry.channelId, entry.error, web)
  }
}

// ---------------------------------------------------------------------------
// E4: sendMcpReconnect helper (waiting state)
// ---------------------------------------------------------------------------

/**
 * Send `/mcp reconnect <MCP_SERVER_NAME>` + Enter to a waiting spawn via claude-director send-keys.
 * Returns true on success, false on failure.
 */
export async function reconnectMcp(channelId: string, web?: WebClient): Promise<boolean> {
  console.error(`[slack] reconnecting MCP server "${MCP_SERVER_NAME}": channel=${channelId}`)
  const result = cliSendKeys({ channelId, keys: [`/mcp reconnect ${MCP_SERVER_NAME}`, 'Enter'] })
  if (!result.ok) {
    console.error(`[slack] reconnectMcp: send-keys failed for channel=${channelId}: ${result.error.kind}`)
    postSpawnFailureToChannel(channelId, result.error, web)
    return false
  }
  return true
}

// ---------------------------------------------------------------------------
// E5: waitForWaitingAndReconnect helper (working state)
// ---------------------------------------------------------------------------

/** Hard timeout for waiting-state poller. Override in tests via _setWaitForWaitingTimeoutMs. */
export const WAIT_FOR_WAITING_TIMEOUT_MS = 10 * 60 * 1000

let _waitForWaitingTimeoutMs = WAIT_FOR_WAITING_TIMEOUT_MS

/** Test-only seam: override the wait-for-waiting timeout. */
export function _setWaitForWaitingTimeoutMs(ms: number): void {
  _waitForWaitingTimeoutMs = ms
}

/** Test-only seam: restore the wait-for-waiting timeout to its default. */
export function _resetWaitForWaitingTimeoutMs(): void {
  _waitForWaitingTimeoutMs = WAIT_FOR_WAITING_TIMEOUT_MS
}

/**
 * Poll status until state transitions to `waiting`, then call reconnectMcp.
 * On expiry: logs gave-up and returns success (no Slack post — long turns are not errors).
 */
export async function waitForWaitingAndReconnect(
  channelId: string,
  routingConfig: RoutingConfig,
  web?: WebClient,
): Promise<boolean> {
  const pollIntervalMs = routingConfig.claude_director_poll_interval_ms
  const deadline = Date.now() + _waitForWaitingTimeoutMs

  while (Date.now() < deadline) {
    const statusResult = cliStatus({ channelId })

    if (!statusResult.ok) {
      if (statusResult.error.kind === 'ErrSpawnNotFound') {
        console.error(`[slack] waitForWaitingAndReconnect: spawn not found for channel=${channelId} — aborting poll`)
        return true
      }
      console.error(`[slack] waitForWaitingAndReconnect: status error for channel=${channelId}: ${statusResult.error.kind}`)
      postSpawnFailureToChannel(channelId, statusResult.error, web)
      return false
    }

    const state = statusResult.data.state

    if (state === 'waiting') {
      return reconnectMcp(channelId, web)
    }

    if (state === 'working') {
      await new Promise<void>((resolve) => setTimeout(resolve, pollIntervalMs))
      continue
    }

    // Any other state (ended, missing, check_permission, ask_user, pending) — abort cleanly
    console.error(`[slack] waitForWaitingAndReconnect: channel=${channelId} transitioned to state=${state} — aborting (health-check will handle)`)
    return true
  }

  // Timeout
  console.error(
    `[slack] reconnect: gave up waiting for channel=${channelId} after ${_waitForWaitingTimeoutMs}ms — health-check will retry`,
  )
  return true
}

// ---------------------------------------------------------------------------
// E2: spawnForRoute — collision-then-act spawn dispatcher
// ---------------------------------------------------------------------------

export interface SpawnRouteResult {
  channelId: string
  action: 'spawned' | 'resumed' | 'reconnected' | 'no-op' | 'failed'
}

/**
 * Core per-route spawn dispatcher (SR-1.4).
 *
 * 1. Dry-run: skip entirely, return synthetic success.
 * 2. Attempt spawn. On success → done.
 * 3. ErrInstanceIdCollision → get-then-act:
 *    - ended/missing + resume_enabled → cozempic clean + resume (fallback to delete+spawn on ErrNoSessionId/ErrJsonlMissing)
 *    - ended/missing + !resume_enabled → kill + delete + fresh spawn
 *    - waiting → reconnectMcp
 *    - working → waitForWaitingAndReconnect
 *    - pending/check_permission/ask_user → no-op
 * 4. Other errors → surface to Slack + startup-errors.log, return failure.
 */
export async function spawnForRoute(
  channelId: string,
  route: { cwd: string },
  routingConfig: RoutingConfig,
  web?: WebClient,
  isStartup = true,
): Promise<SpawnRouteResult> {
  // E8: dry-run short-circuit
  if (isDryRun()) {
    console.error(`[slack] dry-run: skipping claude-director spawn for channel=${channelId} cwd=${route.cwd}`)
    return { channelId, action: 'no-op' }
  }

  const effectiveConfigDir =
    routingConfig.routes[channelId]?.claude_config_dir ?? routingConfig.claude_config_dir

  const extraEnv: Record<string, string> = {}
  if (effectiveConfigDir) {
    extraEnv['CLAUDE_CONFIG_DIR'] = effectiveConfigDir
  }

  // --- Attempt fresh spawn ---
  const spawnResult = cliSpawn({ channelId, cwd: route.cwd, extraEnv: Object.keys(extraEnv).length > 0 ? extraEnv : undefined })

  if (spawnResult.ok) {
    console.error(`[slack] spawnForRoute: spawned channel=${channelId} instanceId=${spawnResult.data.claudeInstanceId}`)
    return { channelId, action: 'spawned' }
  }

  if (spawnResult.error.kind !== 'ErrInstanceIdCollision') {
    // Non-collision failure — surface to Slack + error sink
    console.error(`[slack] spawnForRoute: spawn failed for channel=${channelId}: ${spawnResult.error.kind}`)
    if (isStartup) {
      recordStartupError('spawn-failed', `spawn failed for channel=${channelId}: ${spawnResult.error.kind}`, spawnResult.error)
    } else {
      console.error(`[slack] spawn-failed: spawn failed for channel=${channelId}: ${spawnResult.error.kind}`, spawnResult.error)
    }
    postSpawnFailureToChannel(channelId, spawnResult.error, web, isStartup)
    return { channelId, action: 'failed' }
  }

  // --- Collision handling: get-then-act ---
  console.error(`[slack] spawnForRoute: ErrInstanceIdCollision for channel=${channelId} — fetching current state`)

  const getResult = cliGet({ channelId })

  if (!getResult.ok) {
    if (getResult.error.kind === 'ErrSpawnNotFound') {
      // Race: collision resolved before our get — retry spawn once
      console.error(`[slack] spawnForRoute: ErrSpawnNotFound after collision for channel=${channelId} — retrying spawn (single retry)`)
      const retryResult = cliSpawn({ channelId, cwd: route.cwd, extraEnv: Object.keys(extraEnv).length > 0 ? extraEnv : undefined })
      if (retryResult.ok) {
        console.error(`[slack] spawnForRoute: retry-spawn succeeded for channel=${channelId}`)
        return { channelId, action: 'spawned' }
      }
      console.error(`[slack] spawnForRoute: retry-spawn also failed for channel=${channelId}: ${retryResult.error.kind}`)
      if (isStartup) {
        recordStartupError('spawn-failed', `retry-spawn failed for channel=${channelId}: ${retryResult.error.kind}`, retryResult.error)
      } else {
        console.error(`[slack] spawn-failed: retry-spawn failed for channel=${channelId}: ${retryResult.error.kind}`, retryResult.error)
      }
      postSpawnFailureToChannel(channelId, retryResult.error, web, isStartup)
      return { channelId, action: 'failed' }
    }

    console.error(`[slack] spawnForRoute: get failed for channel=${channelId}: ${getResult.error.kind}`)
    postSpawnFailureToChannel(channelId, getResult.error, web, isStartup)
    return { channelId, action: 'failed' }
  }

  const state = getResult.data.state
  console.error(`[slack] spawnForRoute: collision resolved, state=${state} for channel=${channelId}`)

  if (state === 'ended' || state === 'missing') {
    if (routingConfig.resume_enabled === false) {
      // Kill + delete + fresh spawn (no resume)
      console.error(`[slack] spawnForRoute: resume_enabled=false — kill+delete+fresh for channel=${channelId}`)
      cliKill({ channelId }) // best-effort
      const deleteResult = cliDeleteSpawn({ channelId })
      if (!deleteResult.ok) {
        console.error(`[slack] spawnForRoute: delete failed for channel=${channelId}: ${deleteResult.error.kind}`)
        if (isStartup) {
          recordStartupError('spawn-failed', `delete failed for channel=${channelId}: ${deleteResult.error.kind}`, deleteResult.error)
        } else {
          console.error(`[slack] spawn-failed: delete failed for channel=${channelId}: ${deleteResult.error.kind}`, deleteResult.error)
        }
        postSpawnFailureToChannel(channelId, deleteResult.error, web, isStartup)
        return { channelId, action: 'failed' }
      }
      const freshResult = cliSpawn({ channelId, cwd: route.cwd, extraEnv: Object.keys(extraEnv).length > 0 ? extraEnv : undefined })
      if (!freshResult.ok) {
        console.error(`[slack] spawnForRoute: fresh spawn after delete failed for channel=${channelId}: ${freshResult.error.kind}`)
        if (isStartup) {
          recordStartupError('spawn-failed', `fresh spawn after delete failed for channel=${channelId}: ${freshResult.error.kind}`, freshResult.error)
        } else {
          console.error(`[slack] spawn-failed: fresh spawn after delete failed for channel=${channelId}: ${freshResult.error.kind}`, freshResult.error)
        }
        postSpawnFailureToChannel(channelId, freshResult.error, web, isStartup)
        return { channelId, action: 'failed' }
      }
      console.error(`[slack] spawnForRoute: fresh-spawned (after kill+delete) for channel=${channelId}`)
      return { channelId, action: 'spawned' }
    }

    // resume_enabled: attempt cozempic clean + resume
    // Per PM polish #1: no JSONL pre-check optimization — call resume directly and
    // accept the ErrJsonlMissing round-trip if JSONL is genuinely missing.
    console.error(`[slack] spawnForRoute: attempting resume for channel=${channelId}`)

    // Note: cozempic clean requires a sessionId. Since claude-director's get result
    // does not surface claudeSessionId (PM polish #1 — no pre-check optimization),
    // we skip the cozempic clean here. Resume still proceeds; ErrJsonlMissing triggers
    // the delete+fresh fallback path below.

    const resumeResult = cliResume({ channelId })
    if (resumeResult.ok) {
      console.error(`[slack] spawnForRoute: resumed channel=${channelId}`)
      return { channelId, action: 'resumed' }
    }

    if (
      resumeResult.error.kind === 'ErrNoSessionId' ||
      resumeResult.error.kind === 'ErrJsonlMissing'
    ) {
      // No resumable session — delete + fresh spawn
      console.error(`[slack] spawnForRoute: ${resumeResult.error.kind} on resume for channel=${channelId} — delete+fresh`)
      const deleteResult = cliDeleteSpawn({ channelId })
      if (!deleteResult.ok) {
        console.error(`[slack] spawnForRoute: delete failed for channel=${channelId}: ${deleteResult.error.kind}`)
        if (isStartup) {
          recordStartupError('spawn-failed', `delete failed for channel=${channelId}: ${deleteResult.error.kind}`, deleteResult.error)
        } else {
          console.error(`[slack] spawn-failed: delete failed for channel=${channelId}: ${deleteResult.error.kind}`, deleteResult.error)
        }
        postSpawnFailureToChannel(channelId, deleteResult.error, web, isStartup)
        return { channelId, action: 'failed' }
      }
      const freshResult = cliSpawn({ channelId, cwd: route.cwd, extraEnv: Object.keys(extraEnv).length > 0 ? extraEnv : undefined })
      if (!freshResult.ok) {
        console.error(`[slack] spawnForRoute: fresh spawn after delete failed for channel=${channelId}: ${freshResult.error.kind}`)
        if (isStartup) {
          recordStartupError('spawn-failed', `fresh spawn after delete failed for channel=${channelId}: ${freshResult.error.kind}`, freshResult.error)
        } else {
          console.error(`[slack] spawn-failed: fresh spawn after delete failed for channel=${channelId}: ${freshResult.error.kind}`, freshResult.error)
        }
        postSpawnFailureToChannel(channelId, freshResult.error, web, isStartup)
        return { channelId, action: 'failed' }
      }
      console.error(`[slack] spawnForRoute: fresh-spawned (after delete) for channel=${channelId}`)
      return { channelId, action: 'spawned' }
    }

    // Other resume errors
    console.error(`[slack] spawnForRoute: resume failed for channel=${channelId}: ${resumeResult.error.kind}`)
    postSpawnFailureToChannel(channelId, resumeResult.error, web, isStartup)
    return { channelId, action: 'failed' }
  }

  if (state === 'waiting') {
    await reconnectMcp(channelId, web)
    return { channelId, action: 'reconnected' }
  }

  if (state === 'working') {
    await waitForWaitingAndReconnect(channelId, routingConfig, web)
    return { channelId, action: 'reconnected' }
  }

  if (state === 'pending' || state === 'check_permission' || state === 'ask_user') {
    console.error(`[slack] spawnForRoute: no action — claude-director state=${state} for channel=${channelId}`)
    return { channelId, action: 'no-op' }
  }

  // Unexpected state
  console.error(`[slack] spawnForRoute: unexpected state=${state} for channel=${channelId} — no action`)
  return { channelId, action: 'no-op' }
}

// ---------------------------------------------------------------------------
// E1: reconcileOrphans — startup orphan reconciliation (SR-1.6)
// ---------------------------------------------------------------------------

export interface OrphanReconcileResult {
  found: number
  killed: number
  failed: number
}

/**
 * Enumerate all cscb-labeled spawns from claude-director and reconcile against
 * configured routes. Spawns whose `channel` label is missing or not in
 * routingConfig.routes are killed and deleted.
 *
 * Never throws. Per-orphan errors route through startup-errors.log (class 'orphan-cleanup').
 * List-level failure routes through startup-errors.log (class 'orphan-cleanup-list-failed').
 */
export async function reconcileOrphans(
  routingConfig: RoutingConfig,
): Promise<OrphanReconcileResult> {
  if (isDryRun()) {
    console.error('[slack] dry-run: skipping orphan reconciliation')
    return { found: 0, killed: 0, failed: 0 }
  }

  const listResult = cliList({ labels: { service: 'cscb' } })

  if (!listResult.ok) {
    recordStartupError(
      'orphan-cleanup-list-failed',
      `failed to list spawns for orphan reconciliation: ${listResult.error.kind}`,
      listResult.error,
    )
    return { found: 0, killed: 0, failed: 0 }
  }

  const rows = listResult.data
  const configuredChannels = new Set(Object.keys(routingConfig.routes))

  let found = 0
  let killed = 0
  let failed = 0

  for (const row of rows) {
    const channelLabel = row.labels['channel']
    const isOrphan = !channelLabel || !configuredChannels.has(channelLabel)
    if (!isOrphan) continue

    found++
    const displayChannel = channelLabel ?? '<no channel label>'
    console.error(
      `[slack] reconcileOrphans: orphan found channel=${displayChannel} instanceId=${row.claudeInstanceId} state=${row.state} — killing and deleting`,
    )

    // Kill
    const killResult = cliKill({ claudeInstanceId: row.claudeInstanceId })
    if (!killResult.ok) {
      recordStartupError(
        'orphan-cleanup',
        `kill failed for orphan instanceId=${row.claudeInstanceId} channel=${displayChannel}: ${killResult.error.kind}`,
        killResult.error,
      )
      // Continue to delete attempt anyway
    }

    // Delete
    const deleteResult = cliDeleteSpawn({ claudeInstanceId: row.claudeInstanceId })
    if (!deleteResult.ok) {
      recordStartupError(
        'orphan-cleanup',
        `delete failed for orphan instanceId=${row.claudeInstanceId} channel=${displayChannel}: ${deleteResult.error.kind}`,
        deleteResult.error,
      )
      failed++
      continue
    }

    killed++
  }

  console.error(`[slack] reconcileOrphans: found=${found} killed=${killed} failed=${failed}`)
  return { found, killed, failed }
}

// ---------------------------------------------------------------------------
// startupSessionManager — iterate routes and dispatch per-channel
// ---------------------------------------------------------------------------

export interface StartupSessionManagerResult {
  succeeded: number
  failed: number
  perChannel: Array<{ channelId: string; action: SpawnRouteResult['action'] }>
}

/**
 * On server startup, iterate all configured routes and call spawnForRoute for each.
 * Uses a worker-pool pattern to limit concurrency.
 *
 * Per-route failures are logged and recorded in startup-errors.log but never crash the server.
 * Also invokes cozempic availability check (background, non-blocking for failures).
 */
export async function startupSessionManager(
  routingConfig: RoutingConfig,
  options?: { concurrency?: number; startupTimeout?: number },
  web?: WebClient,
): Promise<StartupSessionManagerResult> {
  await checkCozempicAvailable()

  const routeEntries = Object.entries(routingConfig.routes)
  const concurrency = options?.concurrency ?? 3

  console.error(
    `[slack] startupSessionManager: ${routeEntries.length} route(s), concurrency=${concurrency}`,
  )

  const perChannel: Array<{ channelId: string; action: SpawnRouteResult['action'] }> = []
  let succeeded = 0
  let failed = 0
  let nextIdx = 0

  async function processRoute(channelId: string, route: { cwd: string }): Promise<void> {
    try {
      const result = await spawnForRoute(channelId, route, routingConfig, web)
      perChannel.push({ channelId, action: result.action })
      if (result.action === 'failed') {
        failed++
      } else {
        succeeded++
      }
    } catch (err) {
      console.error(`[slack] startupSessionManager: unexpected error for channel=${channelId}:`, err)
      recordStartupError(
        'spawn-failed',
        `unexpected error spawning channel=${channelId}: ${String(err)}`,
        err,
      )
      perChannel.push({ channelId, action: 'failed' })
      failed++
    }
  }

  async function worker(): Promise<void> {
    while (nextIdx < routeEntries.length) {
      const idx = nextIdx++
      if (idx >= routeEntries.length) break
      const [channelId, route] = routeEntries[idx]
      await processRoute(channelId, route)
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(concurrency, routeEntries.length || 1) }, () => worker()),
  )

  console.error(`[slack] startupSessionManager: complete — ${succeeded} ok, ${failed} failed`)

  return { succeeded, failed, perChannel }
}
