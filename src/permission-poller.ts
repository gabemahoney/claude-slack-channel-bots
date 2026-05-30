/**
 * permission-poller.ts — SR-2.1 permission-state poller.
 *
 * Every tick, for each spawn in check_permission, calls client.get() and
 * compares the returned request_id to the live entry's stored requestId.
 * DB state is definitive; CSCB reconciles its Slack UI against it.
 *
 * Behavior matrix per tick:
 *   1. No live entry → post Block Kit.
 *   2. Live entry, request_id matches, handled=false → no-op.
 *   3. Live entry, request_id matches, handled=true  → no-op.
 *   4. Live entry, request_id changed:
 *        handled=false → chat.update "no longer active" + dropPermission + post fresh Block Kit.
 *        handled=true  → dropPermission only, then post fresh Block Kit.
 *   5. Spawn drops from list:
 *        handled=false → expire chat.update + dropPermission.
 *        handled=true  → dropPermission only (suppress chat.update).
 *
 * If get() returns permission_request===null while spawn is still in
 * check_permission, treat as a transient race and skip reconciliation for
 * that row this tick.
 *
 * SPDX-License-Identifier: MIT
 */

import {
  AgentDirectorError,
  ErrSpawnNotFound,
} from 'agent-director'
import type {
  GetResult,
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
  requestId: number
  /** Set to true by the click handler once its final chat.update succeeds. */
  handled: boolean
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
    get: (params: import('agent-director').GetParams) => Promise<import('agent-director').GetResult>
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

// ---------------------------------------------------------------------------
// Module-state accessors (used by the click handler)
// ---------------------------------------------------------------------------

/** Return the live entry for a claude_instance_id, or undefined. */
export function getLivePermission(claudeInstanceId: string): LivePermission | undefined {
  return livePermissions.get(claudeInstanceId)
}

/** Mark the entry as handled — call from the click handler after its chat.update succeeds. */
export function markHandled(claudeInstanceId: string): boolean {
  const entry = livePermissions.get(claudeInstanceId)
  if (!entry) return false
  entry.handled = true
  return true
}

/** Drop the entry — the tick is the sole owner of clearing entries. */
export function dropPermission(claudeInstanceId: string): void {
  livePermissions.delete(claudeInstanceId)
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
 * shape changes (SR-2.2 — full claude_instance_id + request_id encoding).
 */
export function buildPermissionBlocks(
  toolName: string,
  toolInput: Record<string, unknown>,
  claudeInstanceId: string,
  requestId: number,
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
          action_id: encodePermissionActionId('allow', claudeInstanceId, requestId),
        },
        {
          type: 'button',
          text: { type: 'plain_text', text: 'Deny' },
          style: 'danger',
          action_id: encodePermissionActionId('deny', claudeInstanceId, requestId),
        },
      ],
    },
  ]
}

// ---------------------------------------------------------------------------
// Tick implementation
// ---------------------------------------------------------------------------

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
    let rows: ListRow[]
    try {
      const r = await client.list({ state: ['check_permission'], label: ['service=cscb'] })
      rows = r.spawns
    } catch (err) {
      logViaDeps(deps, '[slack] permission-poller: list failed:', err)
      return
    }

    const seenIds = new Set<string>()
    for (const row of rows) {
      seenIds.add(row.claude_instance_id)

      // Always fetch the full row to compare request_id.
      let got: GetResult
      try {
        got = await client.get({ claude_instance_id: row.claude_instance_id })
      } catch (err) {
        if (err instanceof ErrSpawnNotFound) continue
        const e = err instanceof AgentDirectorError ? err : null
        logViaDeps(deps, `[slack] permission-poller: get failed for ${row.claude_instance_id}: ${e?.errName ?? String(err)}`)
        continue
      }

      if (!got.permission_request) {
        // Transient race: spawn is in check_permission but permission_request is null.
        // Leave existing entry alone; skip reconciliation for this row this tick.
        continue
      }

      const incomingRequestId = got.permission_request.request_id
      const existing = livePermissions.get(row.claude_instance_id)

      if (!existing) {
        // Case 1: No live entry — post Block Kit.
        await postPermissionPrompt(deps, row, got.permission_request)
        continue
      }

      if (existing.requestId === incomingRequestId) {
        // Cases 2 & 3: request_id matches — no-op regardless of handled.
        continue
      }

      // Case 4: request_id changed (advanced).
      if (!existing.handled) {
        // handled=false → update old message to "no longer active" + drop + post fresh.
        await updateNoLongerActive(deps, row.claude_instance_id, existing)
      }
      // handled=true → drop only (click handler already wrote "Allowed/Denied").
      dropPermission(row.claude_instance_id)
      await postPermissionPrompt(deps, row, got.permission_request)
    }

    // Case 5: Expire entries no longer in the result set.
    for (const [id, entry] of livePermissions) {
      if (seenIds.has(id)) continue
      if (!entry.handled) {
        await expirePermissionPrompt(deps, id, entry)
      }
      // handled=true → suppress chat.update; just drop.
      livePermissions.delete(id)
    }
  } finally {
    tickInFlight = false
  }
}

async function postPermissionPrompt(
  deps: PollerDeps,
  row: ListRow,
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

  const blocks = buildPermissionBlocks(
    permission.tool_name,
    toolInput,
    row.claude_instance_id,
    permission.request_id,
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
    livePermissions.set(row.claude_instance_id, {
      channelId,
      messageTs,
      requestId: permission.request_id,
      handled: false,
    })
  } catch (err) {
    logViaDeps(deps, `[slack] permission-poller: chat.postMessage failed for ${row.claude_instance_id}:`, err)
  }
}

async function updateNoLongerActive(
  deps: PollerDeps,
  claudeInstanceId: string,
  entry: LivePermission,
): Promise<void> {
  try {
    await deps.web.chat.update({
      channel: entry.channelId,
      ts: entry.messageTs,
      text: 'permission request no longer active',
      blocks: [
        {
          type: 'section',
          text: {
            type: 'mrkdwn',
            text: '⏳ Permission request no longer active.',
          },
        },
      ] as never,
    })
  } catch (err) {
    logViaDeps(deps, `[slack] permission-poller: no-longer-active chat.update failed for ${claudeInstanceId}:`, err)
  }
}

async function expirePermissionPrompt(
  deps: PollerDeps,
  claudeInstanceId: string,
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
    logViaDeps(deps, `[slack] permission-poller: expire chat.update failed for ${claudeInstanceId}:`, err)
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
