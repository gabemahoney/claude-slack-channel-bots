/**
 * permission-poller.ts — permission-state poller.
 *
 * Every tick, lists spawns in check_permission with the cscb service label
 * and reconciles CSCB's live Slack-prompt state against agent-director's
 * plural `permission_requests` projection. The pending map is keyed on a
 * composite of (claude_instance_id, request_token) so concurrent open
 * requests on the same spawn each get their own Slack prompt without
 * colliding.
 *
 * Behavior per tick:
 *   1. list({state:['check_permission'], label:['service=cscb']}).
 *   2. For each row, get({claude_instance_id}). When the plural projection
 *      is absent (undefined/null), log non-conformance and skip — do not
 *      mutate state for that row.
 *   3. For each PermissionRequestRow in the plural projection, compute the
 *      composite key. If already tracked → skip (duplicate-tick no-op).
 *      Else post a fresh Block Kit prompt and register the live entry.
 *   4. After all rows are processed, sweep: any tracked entry whose
 *      composite key was NOT observed this tick is dropped; if it was
 *      handled=false, send the expire chat.update first.
 *
 * Case 4 (per-spawn request_id advancement) is GONE — the composite key
 * means a "new" token simply appears as an unseen entry and the old token
 * naturally falls out of the seen-set on the next tick.
 *
 * SPDX-License-Identifier: MIT
 */

import {
  AgentDirectorError,
  ErrSpawnNotFound,
} from 'agent-director'
import type {
  GetResult as ADGetResult,
  ListRow,
} from 'agent-director'
import type { WebClient } from '@slack/web-api'

import { encodePermissionActionId } from './permission-action-id.ts'

// ---------------------------------------------------------------------------
// Wire-shape types (local — paired AD release ships the matching wire)
// ---------------------------------------------------------------------------

/**
 * A single open permission_requests row per the paired agent-director
 * release's plural projection wire. CSCB treats `request_token` as opaque
 * (no parsing, no validation of the bytes themselves).
 */
export interface PermissionRequestRow {
  /** Opaque per-request token minted by agent-director. */
  request_token: string
  /** AD autoincrement PK; retained for logging only. */
  request_id: number
  tool_name: string
  /** Raw JSON string per the typed contract. */
  tool_input: string
  requested_at: string
}

/**
 * Local view of the paired-release `GetResult`. The published package still
 * carries singular `permission_request`; the paired release replaces it
 * with plural `permission_requests`. We strip the singular field via Omit
 * and re-add the plural one so we never accidentally read the old shape.
 */
export interface GetResultWithPermissionRequests extends Omit<ADGetResult, 'permission_request'> {
  permission_requests?: PermissionRequestRow[] | null
}

// ---------------------------------------------------------------------------
// Live-permission state
// ---------------------------------------------------------------------------

/** State CSCB tracks for each open Slack permission prompt. */
export interface LivePermission {
  claudeInstanceId: string
  /** Opaque per-request token. */
  requestToken: string
  channelId: string
  messageTs: string
  /** Retained for logging only; never used for routing/keying/encoding. */
  requestId: number
  /** Set to true by the click handler once its final chat.update succeeds. */
  handled: boolean
}

/**
 * Deterministic composite key for the pending map. The null byte
 * separator is chosen because neither claude_instance_id nor a UUIDv4
 * token can contain \x00.
 */
export function makeCompositeKey(claudeInstanceId: string, requestToken: string): string {
  return `${claudeInstanceId}\x00${requestToken}`
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

/** Return the live entry for a (claude_instance_id, request_token) pair. */
export function getLivePermission(
  claudeInstanceId: string,
  requestToken: string,
): LivePermission | undefined {
  return livePermissions.get(makeCompositeKey(claudeInstanceId, requestToken))
}

/** Mark the entry as handled — call from the click handler after its chat.update succeeds. */
export function markHandled(claudeInstanceId: string, requestToken: string): boolean {
  const entry = livePermissions.get(makeCompositeKey(claudeInstanceId, requestToken))
  if (!entry) return false
  entry.handled = true
  return true
}

/** Drop the entry — the tick is the sole owner of clearing entries. */
export function dropPermission(claudeInstanceId: string, requestToken: string): void {
  livePermissions.delete(makeCompositeKey(claudeInstanceId, requestToken))
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
// Block Kit builder
// ---------------------------------------------------------------------------

/**
 * Construct the Block Kit blocks for a permission prompt. The body lines
 * (tool name + summary) are unchanged from the prior implementation; only
 * the action_id encoding swaps request_id for the opaque request_token.
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

    const seenComposite = new Set<string>()
    const nonConformingInstanceIds = new Set<string>()
    for (const row of rows) {
      let got: GetResultWithPermissionRequests
      try {
        got = (await client.get({
          claude_instance_id: row.claude_instance_id,
        })) as unknown as GetResultWithPermissionRequests
      } catch (err) {
        if (err instanceof ErrSpawnNotFound) continue
        const e = err instanceof AgentDirectorError ? err : null
        logViaDeps(deps, `[slack] permission-poller: get failed for ${row.claude_instance_id}: ${e?.errName ?? String(err)}`)
        continue
      }

      if (got.permission_requests === null || got.permission_requests === undefined) {
        logViaDeps(deps, `[slack] permission-poller: non-conforming open-rows response for ${row.claude_instance_id} — skipping`)
        nonConformingInstanceIds.add(row.claude_instance_id)
        continue
      }

      for (const perm of got.permission_requests) {
        const key = makeCompositeKey(row.claude_instance_id, perm.request_token)
        seenComposite.add(key)
        if (livePermissions.has(key)) continue
        await postPermissionPrompt(deps, row, perm)
      }
    }

    for (const [key, entry] of livePermissions) {
      if (nonConformingInstanceIds.has(entry.claudeInstanceId)) continue
      if (seenComposite.has(key)) continue
      if (!entry.handled) {
        await expirePermissionPrompt(deps, entry)
      }
      livePermissions.delete(key)
    }
  } finally {
    tickInFlight = false
  }
}

async function postPermissionPrompt(
  deps: PollerDeps,
  row: ListRow,
  permission: PermissionRequestRow,
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
    livePermissions.set(makeCompositeKey(row.claude_instance_id, permission.request_token), {
      claudeInstanceId: row.claude_instance_id,
      requestToken: permission.request_token,
      channelId,
      messageTs,
      requestId: permission.request_id,
      handled: false,
    })
  } catch (err) {
    logViaDeps(deps, `[slack] permission-poller: chat.postMessage failed for ${row.claude_instance_id}:`, err)
  }
}

async function expirePermissionPrompt(
  deps: PollerDeps,
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
    logViaDeps(deps, `[slack] permission-poller: expire chat.update failed for ${entry.claudeInstanceId}:`, err)
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
