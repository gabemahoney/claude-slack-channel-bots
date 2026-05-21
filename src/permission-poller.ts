/**
 * permission-poller.ts — Single-threaded relay poller for claude-director permission requests.
 *
 * SR-2.1: Polls claude-director `list --state check_permission --label service=cscb` on
 * each tick. Posts Block Kit to Slack for new instances; expires prompts for disappeared
 * instances. Single-threaded gate prevents tick pileup. 30s finalized_at ownership
 * protocol with the click handler.
 *
 * Does NOT observe `ask_user` (AUQ denied at template; filter is state=check_permission).
 * The poller NEVER calls `decide` — decide is exclusively the click handler's (E4) job.
 *
 * SPDX-License-Identifier: MIT
 */

import {
  list as directorList,
  get as directorGet,
} from './claude-director-cli.ts'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface LivePromptEntry {
  messageTs: string
  channelId: string
  requestId: string
  toolName: string
  /** Set by the click handler (E4) to claim ownership of the Slack message. */
  finalizedAt?: number
}

// ---------------------------------------------------------------------------
// Dep-injection interface (injected by initPermissionPoller)
// ---------------------------------------------------------------------------

export interface PermissionPollerDeps {
  /** Milliseconds between ticks — from routingConfig.claude_director_poll_interval_ms. */
  pollIntervalMs: number
  /**
   * Post a Block Kit permission prompt to Slack.
   * Returns the message timestamp on success, or throws on failure.
   */
  postPermissionMessage(channelId: string, toolName: string, toolInput: Record<string, unknown>, claudeInstanceId: string, requestId: string): Promise<string>
  /**
   * Update the Slack message to show it has expired (no decision was made).
   * Called when a live prompt disappears from the director list outside the 30s window.
   */
  expirePermissionMessage(channelId: string, messageTs: string, toolName: string): Promise<void>
}

// ---------------------------------------------------------------------------
// Module-level state
// ---------------------------------------------------------------------------

/** Live prompts map: claudeInstanceId → entry. SR-2.1 */
const livePrompts = new Map<string, LivePromptEntry>()

let deps: PermissionPollerDeps | null = null
let intervalHandle: ReturnType<typeof setInterval> | null = null
let tickInFlight = false
let consecutiveSkipCount = 0

const WARN_SKIP_THRESHOLD = 5
const FINALIZED_WINDOW_MS = 30_000

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

// EXPORTED FOR: server.ts main() (wiring) + tests (TW1, TW2)
export function initPermissionPoller(d: PermissionPollerDeps): void {
  deps = d
}

// EXPORTED FOR: server.ts main() after socket.start() + tests (TW1, TW2)
export function startPermissionPoller(): void {
  if (!deps) throw new Error('permission-poller: initPermissionPoller() must be called before startPermissionPoller()')
  if (intervalHandle !== null) return // already running
  intervalHandle = setInterval(() => {
    runTick().catch((err) => {
      console.error('[permission-poller] Unexpected error in tick:', err)
    })
  }, deps.pollIntervalMs)
}

// EXPORTED FOR: server.ts shutdown() before socket disconnect + tests (TW1, TW2)
export function stopPermissionPoller(): void {
  if (intervalHandle !== null) {
    clearInterval(intervalHandle)
    intervalHandle = null
  }
}

/**
 * Mark a live prompt as finalized (claimed by the click handler).
 * EXPORTED FOR: click-handler (E4) + tests (TW1, TW2)
 */
export function markFinalized(claudeInstanceId: string): void {
  const entry = livePrompts.get(claudeInstanceId)
  if (entry) {
    entry.finalizedAt = Date.now()
  }
}

/**
 * Return a shallow snapshot of the live prompts map.
 * EXPORTED FOR: click-handler (E4) + tests (TW1, TW2)
 */
export function getLivePromptsSnapshot(): ReadonlyMap<string, LivePromptEntry> {
  return livePrompts
}

/**
 * Look up a single live prompt entry by claudeInstanceId.
 * EXPORTED FOR: click-handler (E4) + tests (TW1, TW2)
 */
export function getLivePrompt(claudeInstanceId: string): LivePromptEntry | undefined {
  return livePrompts.get(claudeInstanceId)
}

/**
 * Drop a live prompt entry from the map.
 * EXPORTED FOR: click-handler (E4) on happy-path drop-after-decide + tests (TW1, TW2)
 */
export function dropLivePrompt(claudeInstanceId: string): void {
  livePrompts.delete(claudeInstanceId)
}

/**
 * Test seam — reset all poller state to initial values.
 * EXPORTED FOR: tests (TW1, TW2) — NOT called from any runtime path.
 */
export function _resetPollerState(): void {
  livePrompts.clear()
  deps = null
  if (intervalHandle !== null) {
    clearInterval(intervalHandle)
    intervalHandle = null
  }
  tickInFlight = false
  consecutiveSkipCount = 0
}

// ---------------------------------------------------------------------------
// Tick body (SR-2.1)
// ---------------------------------------------------------------------------

async function runTick(): Promise<void> {
  // Single-threaded gate: skip if previous tick is still in flight.
  if (tickInFlight) {
    consecutiveSkipCount++
    if (consecutiveSkipCount === WARN_SKIP_THRESHOLD) {
      console.warn(`[permission-poller] WARN: ${WARN_SKIP_THRESHOLD} consecutive ticks skipped — previous tick still in flight`)
    }
    return
  }
  tickInFlight = true
  consecutiveSkipCount = 0

  try {
    await doTick()
  } finally {
    tickInFlight = false
  }
}

async function doTick(): Promise<void> {
  if (!deps) return

  // SR-2.1: list spawns in check_permission state with service=cscb label.
  const listResult = directorList({ state: 'check_permission', labels: { service: 'cscb' } })
  if (!listResult.ok) {
    // Log to stderr per SR-2.1; do NOT write to startup-errors.log (T-A).
    console.error('[permission-poller] list error:', listResult.error.kind, listResult.error)
    return
  }

  const currentRows = listResult.data
  const currentIds = new Set(currentRows.map((r) => r.claudeInstanceId))

  // -------------------------------------------------------------------------
  // New instances: not yet in livePrompts → directorGet → postMessage
  // -------------------------------------------------------------------------
  for (const row of currentRows) {
    const { claudeInstanceId } = row
    if (livePrompts.has(claudeInstanceId)) continue // already tracked

    // SR-2.1 / CE7: use claudeInstanceId directly with directorGet (no prefix-stripping).
    // TODO: once E2-T1's GetArgs.claudeInstanceId extension lands, remove strip logic.
    // For now the wrapper resolves via resolveInstanceId which prepends cscb_ when only
    // channelId is given, but we have claudeInstanceId directly, so pass it through.
    const getResult = directorGet({ claudeInstanceId })
    if (!getResult.ok) {
      if (getResult.error.kind === 'ErrSpawnNotFound') {
        // Race: disappeared between list and get — skip silently.
        continue
      }
      // Other error — log, skip, do not crash.
      console.error('[permission-poller] get error for', claudeInstanceId, ':', getResult.error.kind, getResult.error)
      continue
    }

    const { permissionRequest, labels } = getResult.data

    // SR-2.1 race: decided but state hasn't transitioned yet — skip.
    if (permissionRequest === null) continue

    const { requestId, toolName, toolInput: toolInputRaw } = permissionRequest

    // Parse tool_input — it arrives as a raw JSON string per claude-director's contract.
    let toolInput: Record<string, unknown>
    try {
      toolInput = JSON.parse(toolInputRaw) as Record<string, unknown>
    } catch {
      // Parse failure: use { raw: ... } fallback so buildPermissionBlocks typed sig holds.
      console.warn('[permission-poller] tool_input JSON parse failed for', claudeInstanceId, '— using raw fallback')
      toolInput = { raw: toolInputRaw }
    }

    // Read channelId from spawn labels (PM polish #5: warn if absent).
    const channelId = labels['channel']
    if (!channelId) {
      console.warn('[permission-poller] row has no channel label — skipping', claudeInstanceId)
      continue
    }

    // Post Block Kit to Slack.
    let messageTs: string
    try {
      messageTs = await deps.postPermissionMessage(channelId, toolName, toolInput, claudeInstanceId, requestId)
    } catch (err) {
      console.error('[permission-poller] postMessage failed for', claudeInstanceId, ':', err)
      continue
    }

    // Record in live-prompts map.
    livePrompts.set(claudeInstanceId, {
      messageTs,
      channelId,
      requestId,
      toolName,
    })
  }

  // -------------------------------------------------------------------------
  // Disappeared instances: in livePrompts but not in current list → expire or drop
  // -------------------------------------------------------------------------
  const now = Date.now()
  for (const [claudeInstanceId, entry] of livePrompts) {
    if (currentIds.has(claudeInstanceId)) continue // still live

    if (entry.finalizedAt !== undefined && now - entry.finalizedAt < FINALIZED_WINDOW_MS) {
      // Within 30s finalized_at window — click handler already updated the message.
      // Drop from map silently without calling chat.update again.
      livePrompts.delete(claudeInstanceId)
      continue
    }

    // Prompt expired without a decision — update Slack message to "expired".
    try {
      await deps.expirePermissionMessage(entry.channelId, entry.messageTs, entry.toolName)
    } catch (err) {
      console.error('[permission-poller] expireMessage failed for', claudeInstanceId, ':', err)
    }
    livePrompts.delete(claudeInstanceId)
  }
}
