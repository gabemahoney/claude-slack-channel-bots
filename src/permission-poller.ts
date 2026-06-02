/**
 * permission-poller.ts — SR-2.1 permission-state poller.
 *
 * Single-threaded interval loop that calls
 *
 *   client.list({ state: ['check_permission'], label: ['service=cscb'] })
 *
 * On each tick, for any newly-seen `(claude_instance_id, request_token)` pair
 * we use the inline `permission_request` payload from the list row, build the
 * SR-2.2 Block Kit message via `buildPermissionBlocks`, and `chat.postMessage`
 * it to the spawn's `channel` label. We remember the composite key
 * `${claude_instance_id}::${request_token}` in a module-level map.
 *
 * For any tracked entry whose composite key disappears from a later list result
 * (the spawn transitioned out of `check_permission` for any reason), we
 * `chat.update` the Slack message to "expired" and drop the entry — unless
 * the click handler has marked the entry as `finalized_at` within the last
 * 30 s. That window prevents poller / click-handler races on the same message.
 *
 * For tracked entries whose instance IS in the list result (new request
 * arrived), we call `getPermission` to check whether the specific tracked
 * request was already decided or removed.
 *
 * If a tick is still in flight when the next interval fires, the new tick
 * is *skipped*. Skipping five or more times in a row logs a WARN —
 * tick-budget degradation observability.
 *
 * SPDX-License-Identifier: MIT
 */

import {
  AgentDirectorError,
  ErrPermissionRequestNotFound,
} from 'agent-director'
import type {
  GetPermissionParams,
  GetPermissionResult,
  ListRow,
  PermissionRequestInfo,
} from 'agent-director'
import type { WebClient } from '@slack/web-api'

import { encodePermissionActionId } from './permission-action-id.ts'

// ---------------------------------------------------------------------------
// Types — exported so the click handler can share the live map.
// ---------------------------------------------------------------------------

/** State CSCB tracks for each open Slack permission prompt. */
export interface LivePermission {
  channelId: string
  messageTs: string
  claudeInstanceId: string
  requestToken: string
  /** Set to Date.now() by the click handler to claim the message. */
  finalizedAt: number | null
}

/**
 * Injection points for the poller. Production callers supply the real Bun
 * setInterval/clearInterval and a real WebClient + getClient(); tests pass
 * stubs.
 */
export interface PollerDeps {
  /** Returns the agent-director Client singleton. */
  getClient: () => {
    list: (params: import('agent-director').ListParams) => Promise<import('agent-director').ListResult>
    getPermission: (params: GetPermissionParams) => Promise<GetPermissionResult>
  }
  /** Slack WebClient (or a stub satisfying the chat.* surface). */
  web: Pick<WebClient, 'chat'>
  /** Poll interval in ms; from config.agent_director_poll_interval_ms. */
  intervalMs: number
  /** Hook to record runtime errors. Defaults to console.error. */
  log?: (...args: unknown[]) => void
  /** Hook factories so tests can stub timer scheduling. */
  setInterval?: (cb: () => void, ms: number) => ReturnType<typeof setInterval>
  clearInterval?: (handle: ReturnType<typeof setInterval>) => void
}

// ---------------------------------------------------------------------------
// Module-scoped live state
// ---------------------------------------------------------------------------

const livePermissions = new Map<string, LivePermission>()
let pollerHandle: ReturnType<typeof setInterval> | null = null
let tickInFlight = false
let skippedTicks = 0
let depsRef: PollerDeps | null = null

/** Window during which a click handler's `finalizedAt` claim suppresses the poller's "expired" update. */
const FINALIZED_WINDOW_MS = 30_000

// ---------------------------------------------------------------------------
// Composite key helper
// ---------------------------------------------------------------------------

/** Build the composite map key for a permission entry. */
export function makePermKey(claudeInstanceId: string, requestToken: string): string {
  return `${claudeInstanceId}::${requestToken}`
}

// ---------------------------------------------------------------------------
// Module-state accessors (used by the click handler)
// ---------------------------------------------------------------------------

/** Return the live entry for a composite key, or undefined. */
export function getLivePermission(key: string): LivePermission | undefined {
  return livePermissions.get(key)
}

/** Claim the message: set finalizedAt to now() — call from the click handler. */
export function claimPermission(key: string): boolean {
  const entry = livePermissions.get(key)
  if (!entry) return false
  entry.finalizedAt = Date.now()
  return true
}

/** Drop the entry — called from the click handler after the decision update lands. */
export function dropPermission(key: string): void {
  livePermissions.delete(key)
}

/** Test-only: reset module-scoped state. */
export function _resetPollerState(): void {
  if (pollerHandle !== null) {
    if (depsRef?.clearInterval) depsRef.clearInterval(pollerHandle)
    else clearInterval(pollerHandle)
  }
  livePermissions.clear()
  pollerHandle = null
  tickInFlight = false
  skippedTicks = 0
  depsRef = null
}

// ---------------------------------------------------------------------------
// Block Kit builder — local copy of the SR-2.2 Block Kit format
// ---------------------------------------------------------------------------

/**
 * Construct the Block Kit blocks for a permission prompt. Preserved
 * verbatim from the old server.ts implementation; only the action_id
 * shape changes (SR-2.2 — full claude_instance_id + request_token UUID encoding).
 */
export function buildPermissionBlocks(
  toolName: string,
  toolInput: Record<string, unknown>,
  claudeInstanceId: string,
  requestToken: string,
): unknown[] {
  let summary: string
  if (toolName === 'Bash') {
    summary = '`' + String(toolInput['command'] ?? JSON.stringify(toolInput).slice(0, 500)) + '`'
  } else if (toolName === 'Edit' || toolName === 'Write') {
    summary = '`' + String(toolInput['file_path'] ?? JSON.stringify(toolInput).slice(0, 500)) + '`'
  } else {
    const raw = JSON.stringify(toolInput)
    summary = '`' + (raw.length > 500 ? raw.slice(0, 500) + '…' : raw) + '`'
  }

  return [
    {
      type: 'section',
      text: { type: 'mrkdwn', text: `🤖🛠️ *${toolName}*\n${summary}` },
    },
    {
      type: 'actions',
      elements: [
        {
          type: 'button',
          text: { type: 'plain_text', text: 'Allow' },
          style: 'primary',
          action_id: encodePermissionActionId('allow', claudeInstanceId, requestToken),
        },
        {
          type: 'button',
          text: { type: 'plain_text', text: 'Deny' },
          style: 'danger',
          action_id: encodePermissionActionId('deny', claudeInstanceId, requestToken),
        },
      ],
    },
  ]
}

// ---------------------------------------------------------------------------
// Tick implementation
// ---------------------------------------------------------------------------

/** AD 0.6.3 inlines permission_request on check_permission rows; extend the type locally. */
type ListRowWithPermission = ListRow & {
  permission_request?: PermissionRequestInfo | null
}

function logViaDeps(deps: PollerDeps, ...args: unknown[]): void {
  if (deps.log) deps.log(...args)
  else console.error(...args)
}

async function runTick(deps: PollerDeps): Promise<void> {
  if (tickInFlight) {
    skippedTicks++
    if (skippedTicks >= 5) {
      logViaDeps(deps, `[slack] permission-poller: skipped ${skippedTicks} consecutive ticks — tick budget exceeded`)
    }
    return
  }
  tickInFlight = true
  skippedTicks = 0
  try {
    const client = deps.getClient()
    let rows: ListRowWithPermission[]
    try {
      const r = await client.list({ state: ['check_permission'], label: ['service=cscb'] })
      rows = r.spawns as ListRowWithPermission[]
    } catch (err) {
      logViaDeps(deps, '[slack] permission-poller: list failed:', err)
      return
    }

    const seenInstanceIds = new Set<string>()
    for (const row of rows) {
      seenInstanceIds.add(row.claude_instance_id)
      if (!row.permission_request) {
        logViaDeps(deps, `[slack] permission-poller: row for ${row.claude_instance_id} has no permission_request — skipping`)
        continue
      }
      const key = makePermKey(row.claude_instance_id, row.permission_request.request_token)
      if (livePermissions.has(key)) continue
      await postPermissionPrompt(deps, row, row.permission_request)
      // Expire any stale entries for the same instance with a different request_token:
      for (const [k, entry] of livePermissions) {
        if (entry.claudeInstanceId === row.claude_instance_id && entry.requestToken !== row.permission_request.request_token) {
          const claimedWithinWindow = entry.finalizedAt !== null && Date.now() - entry.finalizedAt < FINALIZED_WINDOW_MS
          if (!claimedWithinWindow) await expirePermissionPrompt(deps, k, entry)
          livePermissions.delete(k)
        }
      }
    }

    // Expire entries no longer in the result set, or whose specific request was resolved.
    for (const [k, entry] of livePermissions) {
      if (!seenInstanceIds.has(entry.claudeInstanceId)) {
        // Instance left check_permission entirely — existing expire-or-skip window logic.
        const claimedWithinWindow =
          entry.finalizedAt !== null &&
          Date.now() - entry.finalizedAt < FINALIZED_WINDOW_MS
        if (!claimedWithinWindow) {
          await expirePermissionPrompt(deps, k, entry)
        }
        livePermissions.delete(k)
      } else {
        // Instance is still in list — probe whether this specific request was resolved.
        try {
          const result = await client.getPermission({ request_token: entry.requestToken })
          if (result.decision != null) {
            // Request was decided — expire and drop.
            await expirePermissionPrompt(deps, k, entry)
            livePermissions.delete(k)
          }
          // decision === null → still open, leave alive.
        } catch (err) {
          if (err instanceof ErrPermissionRequestNotFound) {
            // Request is gone from DB — expire and drop.
            await expirePermissionPrompt(deps, k, entry)
            livePermissions.delete(k)
          } else if (err instanceof AgentDirectorError) {
            logViaDeps(deps, `[slack] permission-poller: getPermission failed for ${entry.claudeInstanceId}::${entry.requestToken}: ${err.errName}`)
            // Leave alive — transient failure, retry next tick.
          } else {
            logViaDeps(deps, `[slack] permission-poller: getPermission failed for ${entry.claudeInstanceId}::${entry.requestToken}:`, err)
            // Leave alive — unknown error, retry next tick.
          }
        }
      }
    }
  } finally {
    tickInFlight = false
  }
}

async function postPermissionPrompt(
  deps: PollerDeps,
  row: ListRowWithPermission,
  permission: PermissionRequestInfo,
): Promise<void> {
  const channelId = row.labels['channel']
  if (!channelId) {
    logViaDeps(deps, `[slack] permission-poller: spawn ${row.claude_instance_id} has no channel label — skipping`)
    return
  }

  // tool_input is a raw JSON string per the typed contract; parse for the
  // Block Kit builder, fall back to the raw string + warning on parse fail.
  let toolInput: Record<string, unknown>
  try {
    const parsed = JSON.parse(permission.tool_input) as unknown
    toolInput = parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : { raw: permission.tool_input }
  } catch {
    logViaDeps(deps, `[slack] permission-poller: tool_input not JSON-parseable for ${row.claude_instance_id} — using raw string`)
    toolInput = { raw: permission.tool_input }
  }

  const key = makePermKey(row.claude_instance_id, permission.request_token)
  const blocks = buildPermissionBlocks(
    permission.tool_name,
    toolInput,
    row.claude_instance_id,
    permission.request_token,
  )

  try {
    const response = await deps.web.chat.postMessage({
      channel: channelId,
      text: `🤖🛠️ permission request: ${permission.tool_name}`,
      blocks: blocks as never,
    })
    const messageTs = (response as { ts?: string }).ts
    if (!messageTs) {
      logViaDeps(deps, `[slack] permission-poller: chat.postMessage returned no ts for ${row.claude_instance_id}`)
      return
    }
    livePermissions.set(key, {
      channelId,
      messageTs,
      claudeInstanceId: row.claude_instance_id,
      requestToken: permission.request_token,
      finalizedAt: null,
    })
  } catch (err) {
    logViaDeps(deps, `[slack] permission-poller: chat.postMessage failed for ${row.claude_instance_id}:`, err)
  }
}

async function expirePermissionPrompt(
  deps: PollerDeps,
  key: string,
  entry: LivePermission,
): Promise<void> {
  try {
    await deps.web.chat.update({
      channel: entry.channelId,
      ts: entry.messageTs,
      text: 'permission request expired — no longer actionable',
      blocks: [
        {
          type: 'section',
          text: {
            type: 'mrkdwn',
            text: '⏳ Permission request expired — no longer actionable.',
          },
        },
      ] as never,
    })
  } catch (err) {
    logViaDeps(deps, `[slack] permission-poller: expire chat.update failed for ${entry.claudeInstanceId}::${entry.requestToken}:`, err)
  }
}

// ---------------------------------------------------------------------------
// Public start / stop
// ---------------------------------------------------------------------------

/**
 * Start the poller. Safe to call once after Socket Mode is up; idempotent
 * (a second call is a no-op).
 */
export function startPermissionPoller(deps: PollerDeps): void {
  if (pollerHandle !== null) return
  depsRef = deps
  const setIntervalFn = deps.setInterval ?? setInterval
  pollerHandle = setIntervalFn(() => {
    // Fire-and-forget. runTick itself never throws.
    void runTick(deps)
  }, deps.intervalMs) as unknown as ReturnType<typeof setInterval>
}

/** Stop the poller. Safe to call multiple times. */
export function stopPermissionPoller(): void {
  if (pollerHandle === null) return
  const clearIntervalFn = depsRef?.clearInterval ?? clearInterval
  clearIntervalFn(pollerHandle)
  pollerHandle = null
}
