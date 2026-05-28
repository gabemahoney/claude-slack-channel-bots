/**
 * session-manager.ts — Library-backed startup orchestration for CSCB.
 *
 * The previous tmux-direct implementation has been replaced with calls to the
 * agent-director TypeScript library `Client` singleton (SR-1). Every spawn
 * carries `relay_mode='on'` and `service=cscb` / `channel=<id>` labels.
 * Per-route reconciliation uses the SR-1.4 collision-then-act dispatch:
 *
 *   1. Try `client.spawn(...)` directly.
 *   2. On `ErrInstanceIdCollision`, call `client.get(...)` and branch on the
 *      observed state (ended/missing → resume or kill+delete+spawn; waiting
 *      → /mcp reconnect via sendKeys; working → wait for waiting then
 *      reconnect; pending/check_permission/ask_user → no-op).
 *   3. Any other error surfaces to the affected Slack channel via
 *      `postSpawnFailureToChannel` and is logged.
 *
 * Orphan reconciliation (SR-1.6) lists every `service=cscb` spawn and
 * kills+deletes any whose `channel` label is missing or not in
 * `routingConfig.routes`.
 *
 * No tmux process-tree walks, no JSONL existence checks for resume eligibility:
 * the library encapsulates both.
 *
 * SPDX-License-Identifier: MIT
 */

import {
  AgentDirectorError,
  ErrInstanceIdCollision,
  ErrJsonlMissing,
  ErrNoSessionId,
  ErrSpawnNotFound,
  ErrSpawnNotResumable,
} from 'agent-director'
import type { ListRow, SpawnParams } from 'agent-director'
import type { WebClient } from '@slack/web-api'

import { checkCozempicAvailable } from './cozempic.ts'
import { type RoutingConfig, MCP_SERVER_NAME } from './config.ts'
import { getClient } from './agent-director-client.ts'
import { recordStartupError } from './startup-errors.ts'
import { isDryRun } from './tokens.ts'

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * Live states per SR-11 (agent-director Spawn state machine). Terminal states
 * (`ended`, `missing`) and the typed `ErrSpawnNotFound` rejection from
 * `client.status(...)` are treated as dead by callers.
 */
export const AGENT_DIRECTOR_LIVE_STATES: ReadonlySet<string> = new Set([
  'pending',
  'waiting',
  'working',
  'ask_user',
  'check_permission',
])

/** The CSCB-shipped template name (mirrors agent-director-client). */
const TEMPLATE_NAME = 'slack-channel-bot'

/** Build the deterministic claude_instance_id for a channelId. */
export function instanceIdFor(channelId: string): string {
  return `cscb_${channelId}`
}

/** Build the canonical tmux session name for a channelId. */
export function tmuxSessionNameFor(channelId: string): string {
  return `slack_bot_${channelId}`
}

// ---------------------------------------------------------------------------
// Spawn-failure queue — Slack-error surface (SR-1.1 channel-post path)
// ---------------------------------------------------------------------------

interface SpawnFailureEntry {
  channelId: string
  error: AgentDirectorError
  remediation: string
}

const spawnFailureQueue: SpawnFailureEntry[] = []

/**
 * Surface a spawn-related failure to the bot's configured Slack channel.
 * Before Socket Mode is up, queue the entry; `flushSpawnFailureQueue` drains
 * the queue once the WebClient is authenticated. Dry-run logs to stderr only.
 */
export function postSpawnFailureToChannel(
  channelId: string,
  error: AgentDirectorError,
  web?: WebClient,
  isStartup = true,
): void {
  const remediation = remediationHint(error)

  if (!web) {
    spawnFailureQueue.push({ channelId, error, remediation })
    return
  }

  if (isDryRun()) {
    console.error(
      `[slack] dry-run: would post spawn failure for channel=${channelId} errName=${error.errName} remediation="${remediation}"`,
    )
    return
  }

  const text =
    `Spawn failure for channel \`${channelId}\`:\n` +
    `  Error: \`${error.errName}\` — ${error.errDescription.slice(0, 300)}\n` +
    `  Remediation: ${remediation}`

  web.chat.postMessage({ channel: channelId, text }).catch((err) => {
    if (isStartup) {
      recordStartupError('spawn-failure-post', `failed to post spawn failure to channel=${channelId}`, err)
    } else {
      console.error(`[slack] spawn-failure-post: failed to post spawn failure to channel=${channelId}`, err)
    }
  })
}

function remediationHint(error: AgentDirectorError): string {
  if (error instanceof ErrInstanceIdCollision) return 'spawn dispatcher bug — please report'
  if (error instanceof ErrSpawnNotFound) return 'transient — restarting the server should resolve'
  return 'Check server.log for details.'
}

/** Drain the pre-auth queue once Socket Mode is up. Called from server.ts main(). */
export function flushSpawnFailureQueue(web: WebClient): void {
  while (spawnFailureQueue.length > 0) {
    const entry = spawnFailureQueue.shift()!
    postSpawnFailureToChannel(entry.channelId, entry.error, web)
  }
}

// ---------------------------------------------------------------------------
// reconnectMcp — send `/mcp reconnect <server-name>` via library sendKeys
// ---------------------------------------------------------------------------

/**
 * Send `/mcp reconnect <MCP_SERVER_NAME>` to the spawn's pane. Library's
 * sendKeys appends Enter automatically per its contract.
 */
export async function reconnectMcp(channelId: string, web?: WebClient): Promise<boolean> {
  const claude_instance_id = instanceIdFor(channelId)
  console.error(`[slack] reconnecting MCP server "${MCP_SERVER_NAME}": channel=${channelId}`)
  try {
    await getClient().sendKeys({
      claude_instance_id,
      text: `/mcp reconnect ${MCP_SERVER_NAME}`,
    })
    return true
  } catch (err) {
    const e = err instanceof AgentDirectorError ? err : new AgentDirectorError('send-keys', 'UnknownError', String(err))
    console.error(`[slack] reconnectMcp: send-keys failed for channel=${channelId}: ${e.errName}`)
    postSpawnFailureToChannel(channelId, e, web)
    return false
  }
}

// ---------------------------------------------------------------------------
// approveDevChannelsDialog — auto-approve the dev-channels warning on spawn
// ---------------------------------------------------------------------------

/**
 * Verified against Claude Code 2.1.120 (2026-05-27). If this stops matching,
 * the dev-channels dialog has drifted — see b.yy6. Match the option label
 * (semantic, stable) rather than the header (cosmetic, drifts).
 */
export const DEV_CHANNELS_DIALOG_NEEDLE = 'I am using this for local development'

/** Default poll interval while watching for the dev-channels dialog. */
export const DIALOG_POLL_INTERVAL_MS = 500

/** Default deadline for both the appearance poll and the still-visible poll. */
export const DIALOG_POLL_TIMEOUT_MS = 30_000

/** Number of consecutive "needle absent" reads required to confirm approval. */
export const DIALOG_GONE_CONFIRMS_REQUIRED = 2

let _dialogPollIntervalMs = DIALOG_POLL_INTERVAL_MS
let _dialogPollTimeoutMs = DIALOG_POLL_TIMEOUT_MS

/** Test-only seam: override the dev-channels poll interval. */
export function _setDialogPollIntervalMs(ms: number): void {
  _dialogPollIntervalMs = ms
}

/** Test-only seam: restore the default poll interval. */
export function _resetDialogPollIntervalMs(): void {
  _dialogPollIntervalMs = DIALOG_POLL_INTERVAL_MS
}

/** Test-only seam: override the dev-channels poll timeout. */
export function _setDialogPollTimeoutMs(ms: number): void {
  _dialogPollTimeoutMs = ms
}

/** Test-only seam: restore the default poll timeout. */
export function _resetDialogPollTimeoutMs(): void {
  _dialogPollTimeoutMs = DIALOG_POLL_TIMEOUT_MS
}

/**
 * Poll the freshly-spawned bot's tmux pane until the dev-channels approval
 * dialog appears, send Enter to accept the pre-selected
 * "I am using this for local development" option, then confirm the dialog
 * has cleared. All errors caught locally — never throws to the caller.
 *
 * readPane/sendKeys use `allow_pending: true` because the bot is still in
 * `pending` AD state when this runs (b.98w — formerly caused ErrSpawnNotInteractive).
 *
 * Two distinct failure modes are recorded via `recordStartupError` so a
 * future Claude Code release that changes the dialog cannot silently break
 * fresh-spawn approval:
 *   - `dev-channels-approve-no-dialog`   — needle never observed
 *   - `dev-channels-approve-still-visible` — needle persists after Enter
 */
export async function approveDevChannelsDialog(
  channelId: string,
  web: WebClient | undefined,
  isStartup: boolean,
): Promise<void> {
  void web
  const claude_instance_id = instanceIdFor(channelId)
  const client = getClient()
  const deadline = Date.now() + _dialogPollTimeoutMs

  let approved = false
  while (Date.now() < deadline) {
    try {
      const { pane } = await client.readPane({ claude_instance_id, n_lines: 40, allow_pending: true })
      if (pane.includes(DEV_CHANNELS_DIALOG_NEEDLE)) {
        await client.sendKeys({ claude_instance_id, text: '', allow_pending: true })
        approved = true
        break
      }
    } catch (err) {
      console.error(`[slack] approveDevChannelsDialog: readPane error channel=${channelId}: ${String(err)}`)
    }
    await new Promise((r) => setTimeout(r, _dialogPollIntervalMs))
  }

  if (!approved) {
    const msg = `dev-channels dialog never appeared for channel=${channelId} within ${_dialogPollTimeoutMs}ms (dialog text may have drifted — see b.yy6)`
    console.error(`[slack] approveDevChannelsDialog: ${msg}`)
    if (isStartup) recordStartupError('dev-channels-approve-no-dialog', msg)
    return
  }

  let misses = 0
  while (Date.now() < deadline && misses < DIALOG_GONE_CONFIRMS_REQUIRED) {
    await new Promise((r) => setTimeout(r, _dialogPollIntervalMs))
    try {
      const { pane } = await client.readPane({ claude_instance_id, n_lines: 40, allow_pending: true })
      misses = pane.includes(DEV_CHANNELS_DIALOG_NEEDLE) ? 0 : misses + 1
    } catch {
      /* tolerate transient readPane failure */
    }
  }
  if (misses < DIALOG_GONE_CONFIRMS_REQUIRED) {
    const msg = `dev-channels dialog still visible after Enter for channel=${channelId} (sendKeys may not have reached pane)`
    console.error(`[slack] approveDevChannelsDialog: ${msg}`)
    if (isStartup) recordStartupError('dev-channels-approve-still-visible', msg)
  }
}

// ---------------------------------------------------------------------------
// waitForWaitingAndReconnect — used when a colliding spawn is in `working`
// ---------------------------------------------------------------------------

/** Hard cap on the wait-for-waiting poller (10 minutes). Test-only override below. */
export const WAIT_FOR_WAITING_TIMEOUT_MS = 10 * 60 * 1000

let _waitForWaitingTimeoutMs = WAIT_FOR_WAITING_TIMEOUT_MS

/** Test-only seam: override the wait-for-waiting timeout. */
export function _setWaitForWaitingTimeoutMs(ms: number): void {
  _waitForWaitingTimeoutMs = ms
}

/** Test-only seam: restore the default. */
export function _resetWaitForWaitingTimeoutMs(): void {
  _waitForWaitingTimeoutMs = WAIT_FOR_WAITING_TIMEOUT_MS
}

/**
 * Poll `status({claude_instance_id})` until the spawn transitions to
 * `waiting`, then call reconnectMcp. On other terminal transitions (ended,
 * missing, etc) return true without sending — health-check picks it up.
 * On timeout, log and return true (long turns aren't errors).
 */
export async function waitForWaitingAndReconnect(
  channelId: string,
  routingConfig: RoutingConfig,
  web?: WebClient,
): Promise<boolean> {
  const claude_instance_id = instanceIdFor(channelId)
  const pollIntervalMs = routingConfig.agent_director_poll_interval_ms
  const deadline = Date.now() + _waitForWaitingTimeoutMs

  while (Date.now() < deadline) {
    let state: string
    try {
      const r = await getClient().status({ claude_instance_id })
      state = r.state
    } catch (err) {
      if (err instanceof ErrSpawnNotFound) {
        console.error(`[slack] waitForWaitingAndReconnect: spawn not found for channel=${channelId} — aborting poll`)
        return true
      }
      const e = err instanceof AgentDirectorError ? err : new AgentDirectorError('status', 'UnknownError', String(err))
      console.error(`[slack] waitForWaitingAndReconnect: status error for channel=${channelId}: ${e.errName}`)
      postSpawnFailureToChannel(channelId, e, web)
      return false
    }

    if (state === 'waiting') {
      return reconnectMcp(channelId, web)
    }

    if (state === 'working') {
      await new Promise<void>((resolve) => setTimeout(resolve, pollIntervalMs))
      continue
    }

    console.error(`[slack] waitForWaitingAndReconnect: channel=${channelId} transitioned to state=${state} — aborting (health-check will handle)`)
    return true
  }

  console.error(
    `[slack] reconnect: gave up waiting for channel=${channelId} after ${_waitForWaitingTimeoutMs}ms — health-check will retry`,
  )
  return true
}

// ---------------------------------------------------------------------------
// spawnForRoute — SR-1.4 collision-then-act dispatcher
// ---------------------------------------------------------------------------

export interface SpawnRouteResult {
  channelId: string
  action: 'spawned' | 'resumed' | 'reconnected' | 'no-op' | 'failed'
}

/** Build SpawnParams for a route (SR-1.1). Per-route claude_config_dir wins. */
function buildSpawnParams(
  channelId: string,
  route: { cwd: string },
  routingConfig: RoutingConfig,
): SpawnParams {
  const effectiveConfigDir =
    routingConfig.routes[channelId]?.claude_config_dir ?? routingConfig.claude_config_dir
  const params: SpawnParams = {
    template: TEMPLATE_NAME,
    cwd: route.cwd,
    claude_instance_id: instanceIdFor(channelId),
    relay_mode: 'on',
    tmux_session_name: tmuxSessionNameFor(channelId),
    label: ['service=cscb', `channel=${channelId}`],
  }
  if (effectiveConfigDir) {
    params.extra_env = { CLAUDE_CONFIG_DIR: effectiveConfigDir }
  }
  return params
}

/** Best-effort kill — never throws. */
async function tryKill(channelId: string): Promise<void> {
  try {
    await getClient().kill({ claude_instance_id: instanceIdFor(channelId) })
  } catch {
    /* ignore */
  }
}

/** Delete the spawn row; surface failures. Returns whether the delete succeeded. */
async function tryDelete(channelId: string, web: WebClient | undefined, isStartup: boolean): Promise<boolean> {
  try {
    await getClient().delete({ claude_instance_id: [instanceIdFor(channelId)] })
    return true
  } catch (err) {
    const e = err instanceof AgentDirectorError ? err : new AgentDirectorError('delete', 'UnknownError', String(err))
    console.error(`[slack] tryDelete: failed for channel=${channelId}: ${e.errName}`)
    if (isStartup) recordStartupError('spawn-failed', `delete failed for channel=${channelId}: ${e.errName}`, e)
    postSpawnFailureToChannel(channelId, e, web, isStartup)
    return false
  }
}

/**
 * Core per-route spawn dispatcher (SR-1.4):
 *
 * 1. Dry-run: skip entirely, return synthetic success.
 * 2. Attempt `client.spawn(...)`. On success → done.
 * 3. `ErrInstanceIdCollision` → `client.get(...)` then branch on state:
 *    - ended/missing + resume_enabled → resume; on ErrNoSessionId/
 *      ErrJsonlMissing → delete + fresh spawn.
 *    - ended/missing + !resume_enabled → kill + delete + fresh spawn.
 *    - waiting → reconnectMcp.
 *    - working → waitForWaitingAndReconnect.
 *    - pending/check_permission/ask_user → no-op.
 * 4. Other errors → surface to Slack + (when isStartup) startup-errors.log.
 */
export async function spawnForRoute(
  channelId: string,
  route: { cwd: string },
  routingConfig: RoutingConfig,
  web?: WebClient,
  isStartup = true,
): Promise<SpawnRouteResult> {
  if (isDryRun()) {
    console.error(`[slack] dry-run: skipping spawn for channel=${channelId} cwd=${route.cwd}`)
    return { channelId, action: 'no-op' }
  }

  const params = buildSpawnParams(channelId, route, routingConfig)
  const client = getClient()

  // Attempt fresh spawn ---
  try {
    const r = await client.spawn(params)
    console.error(`[slack] spawnForRoute: spawned channel=${channelId} instanceId=${r.claude_instance_id}`)
    await approveDevChannelsDialog(channelId, web, isStartup)
    return { channelId, action: 'spawned' }
  } catch (err) {
    if (!(err instanceof ErrInstanceIdCollision)) {
      const e = err instanceof AgentDirectorError ? err : new AgentDirectorError('spawn', 'UnknownError', String(err))
      console.error(`[slack] spawnForRoute: spawn failed for channel=${channelId}: ${e.errName}`)
      if (isStartup) recordStartupError('spawn-failed', `spawn failed for channel=${channelId}: ${e.errName}`, e)
      postSpawnFailureToChannel(channelId, e, web, isStartup)
      return { channelId, action: 'failed' }
    }
    // Collision → fall through to get-then-act
    console.error(`[slack] spawnForRoute: ErrInstanceIdCollision for channel=${channelId} — fetching current state`)
  }

  // Collision-handling: get-then-act ---
  let state: string
  try {
    const r = await client.get({ claude_instance_id: instanceIdFor(channelId) })
    state = r.state
  } catch (err) {
    if (err instanceof ErrSpawnNotFound) {
      // Race: row deleted between spawn-collision and get. Retry spawn once.
      console.error(`[slack] spawnForRoute: ErrSpawnNotFound after collision for channel=${channelId} — retrying spawn (single retry)`)
      try {
        const r = await client.spawn(params)
        console.error(`[slack] spawnForRoute: retry-spawn succeeded for channel=${channelId} instanceId=${r.claude_instance_id}`)
        await approveDevChannelsDialog(channelId, web, isStartup)
        return { channelId, action: 'spawned' }
      } catch (err2) {
        const e = err2 instanceof AgentDirectorError ? err2 : new AgentDirectorError('spawn', 'UnknownError', String(err2))
        console.error(`[slack] spawnForRoute: retry-spawn also failed for channel=${channelId}: ${e.errName}`)
        if (isStartup) recordStartupError('spawn-failed', `retry-spawn failed for channel=${channelId}: ${e.errName}`, e)
        postSpawnFailureToChannel(channelId, e, web, isStartup)
        return { channelId, action: 'failed' }
      }
    }
    const e = err instanceof AgentDirectorError ? err : new AgentDirectorError('get', 'UnknownError', String(err))
    console.error(`[slack] spawnForRoute: get failed for channel=${channelId}: ${e.errName}`)
    postSpawnFailureToChannel(channelId, e, web, isStartup)
    return { channelId, action: 'failed' }
  }

  console.error(`[slack] spawnForRoute: collision resolved, state=${state} for channel=${channelId}`)

  if (state === 'ended' || state === 'missing') {
    if (routingConfig.resume_enabled === false) {
      console.error(`[slack] spawnForRoute: resume_enabled=false — kill+delete+fresh for channel=${channelId}`)
      await tryKill(channelId)
      if (!(await tryDelete(channelId, web, isStartup))) return { channelId, action: 'failed' }
      try {
        await client.spawn(params)
        console.error(`[slack] spawnForRoute: fresh-spawned (after kill+delete) for channel=${channelId}`)
        await approveDevChannelsDialog(channelId, web, isStartup)
        return { channelId, action: 'spawned' }
      } catch (err) {
        const e = err instanceof AgentDirectorError ? err : new AgentDirectorError('spawn', 'UnknownError', String(err))
        console.error(`[slack] spawnForRoute: fresh spawn after delete failed for channel=${channelId}: ${e.errName}`)
        if (isStartup) recordStartupError('spawn-failed', `fresh spawn after delete failed for channel=${channelId}: ${e.errName}`, e)
        postSpawnFailureToChannel(channelId, e, web, isStartup)
        return { channelId, action: 'failed' }
      }
    }

    // resume_enabled: attempt resume
    console.error(`[slack] spawnForRoute: attempting resume for channel=${channelId}`)
    try {
      await client.resume({ claude_instance_id: instanceIdFor(channelId) })
      console.error(`[slack] spawnForRoute: resumed channel=${channelId}`)
      return { channelId, action: 'resumed' }
    } catch (err) {
      if (err instanceof ErrNoSessionId || err instanceof ErrJsonlMissing) {
        console.error(`[slack] spawnForRoute: ${err.errName} on resume for channel=${channelId} — delete+fresh`)
        if (!(await tryDelete(channelId, web, isStartup))) return { channelId, action: 'failed' }
        try {
          await client.spawn(params)
          console.error(`[slack] spawnForRoute: fresh-spawned (after delete) for channel=${channelId}`)
          await approveDevChannelsDialog(channelId, web, isStartup)
          return { channelId, action: 'spawned' }
        } catch (err2) {
          const e = err2 instanceof AgentDirectorError ? err2 : new AgentDirectorError('spawn', 'UnknownError', String(err2))
          console.error(`[slack] spawnForRoute: fresh spawn after delete failed for channel=${channelId}: ${e.errName}`)
          if (isStartup) recordStartupError('spawn-failed', `fresh spawn after delete failed for channel=${channelId}: ${e.errName}`, e)
          postSpawnFailureToChannel(channelId, e, web, isStartup)
          return { channelId, action: 'failed' }
        }
      }
      if (err instanceof ErrSpawnNotResumable) {
        // Row is non-terminal but resume rejected — defensive: kill + delete + spawn
        console.error(`[slack] spawnForRoute: ErrSpawnNotResumable for channel=${channelId} — kill+delete+fresh`)
        await tryKill(channelId)
        if (!(await tryDelete(channelId, web, isStartup))) return { channelId, action: 'failed' }
        try {
          await client.spawn(params)
          await approveDevChannelsDialog(channelId, web, isStartup)
          return { channelId, action: 'spawned' }
        } catch (err2) {
          const e = err2 instanceof AgentDirectorError ? err2 : new AgentDirectorError('spawn', 'UnknownError', String(err2))
          if (isStartup) recordStartupError('spawn-failed', `fresh spawn failed for channel=${channelId}: ${e.errName}`, e)
          postSpawnFailureToChannel(channelId, e, web, isStartup)
          return { channelId, action: 'failed' }
        }
      }
      const e = err instanceof AgentDirectorError ? err : new AgentDirectorError('resume', 'UnknownError', String(err))
      console.error(`[slack] spawnForRoute: resume failed for channel=${channelId}: ${e.errName}`)
      postSpawnFailureToChannel(channelId, e, web, isStartup)
      return { channelId, action: 'failed' }
    }
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
    console.error(`[slack] spawnForRoute: no action — state=${state} for channel=${channelId}`)
    return { channelId, action: 'no-op' }
  }

  console.error(`[slack] spawnForRoute: unexpected state=${state} for channel=${channelId} — no action`)
  return { channelId, action: 'no-op' }
}

// ---------------------------------------------------------------------------
// reconcileOrphans — SR-1.6 startup orphan reconciliation
// ---------------------------------------------------------------------------

export interface OrphanReconcileResult {
  found: number
  killed: number
  failed: number
}

/**
 * Enumerate all `service=cscb` spawns and kill+delete any whose `channel`
 * label is missing or not in routingConfig.routes. List-level failure is
 * logged but does not block startup.
 */
export async function reconcileOrphans(
  routingConfig: RoutingConfig,
): Promise<OrphanReconcileResult> {
  if (isDryRun()) {
    console.error('[slack] dry-run: skipping orphan reconciliation')
    return { found: 0, killed: 0, failed: 0 }
  }

  const client = getClient()
  let rows: ListRow[]
  try {
    const r = await client.list({ label: ['service=cscb'] })
    rows = r.spawns
  } catch (err) {
    const e = err instanceof AgentDirectorError ? err : new AgentDirectorError('list', 'UnknownError', String(err))
    recordStartupError(
      'orphan-cleanup-list-failed',
      `failed to list spawns for orphan reconciliation: ${e.errName}`,
      e,
    )
    return { found: 0, killed: 0, failed: 0 }
  }

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
      `[slack] reconcileOrphans: orphan found channel=${displayChannel} instanceId=${row.claude_instance_id} state=${row.state} — killing and deleting`,
    )

    try {
      await client.kill({ claude_instance_id: row.claude_instance_id })
    } catch (err) {
      const e = err instanceof AgentDirectorError ? err : new AgentDirectorError('kill', 'UnknownError', String(err))
      recordStartupError(
        'orphan-cleanup',
        `kill failed for orphan instanceId=${row.claude_instance_id} channel=${displayChannel}: ${e.errName}`,
        e,
      )
      // continue to delete attempt
    }

    try {
      await client.delete({ claude_instance_id: [row.claude_instance_id] })
      killed++
    } catch (err) {
      const e = err instanceof AgentDirectorError ? err : new AgentDirectorError('delete', 'UnknownError', String(err))
      recordStartupError(
        'orphan-cleanup',
        `delete failed for orphan instanceId=${row.claude_instance_id} channel=${displayChannel}: ${e.errName}`,
        e,
      )
      failed++
    }
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
 * On server startup, iterate all configured routes and call spawnForRoute
 * for each. Uses a worker-pool pattern to limit concurrency.
 *
 * Per-route failures are logged and recorded in startup-errors.log but never
 * crash the server. cozempic availability is probed in the background
 * (non-blocking).
 */
export async function startupSessionManager(
  routingConfig: RoutingConfig,
  options?: { concurrency?: number },
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
      if (result.action === 'failed') failed++
      else succeeded++
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

// ---------------------------------------------------------------------------
// launchSession — restart.ts adapter
// ---------------------------------------------------------------------------

/**
 * Restart-adapter shim for restart.ts (`RestartDeps.launchSession`).
 *
 * Returns true on any non-failed action (spawned / resumed / reconnected /
 * no-op), false on `failed`. The richer `SpawnRouteResult` is collapsed
 * here because the restart subsystem only cares about did-it-relaunch.
 */
export async function launchSession(
  channelId: string,
  cwd: string,
  routingConfig: RoutingConfig,
  web?: WebClient,
): Promise<boolean> {
  const result = await spawnForRoute(channelId, { cwd }, routingConfig, web, false)
  return result.action !== 'failed'
}
