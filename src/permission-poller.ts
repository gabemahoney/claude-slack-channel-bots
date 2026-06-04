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
 *      mutate state for that row, and exclude that spawn's live entries
 *      from the newly-closed sweep this tick.
 *   3. For each PermissionRequestRow in the plural projection, compute the
 *      composite key. If already tracked → skip (duplicate-tick no-op).
 *      Else post a fresh Block Kit prompt and register the live entry.
 *   4. Newly-closed reconciliation (SR-2.4): for each live entry whose
 *      composite key was NOT observed this tick (excluding non-conforming
 *      spawns), call `get-permission`, render the verdict-distinct
 *      chat.update against that row's messageTs, and drop the entry.
 *      `ErrPermissionRequestNotFound` → render generic deny + drop + no
 *      retry. Other transient errors → leave entry alive, retry next tick.
 *      Unknown `decision_reason` → fail-closed generic deny (SR-5.2).
 *
 * Per-spawn request_id advancement is no longer a special path — the
 * composite key means a "new" token simply appears as an unseen entry and
 * the old token naturally falls out of the seen-set on the next tick.
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

import {
  getPermission,
  isErrPermissionRequestNotFound,
} from './agent-director-client.ts'
import type {
  GetPermissionParams,
  GetPermissionResult,
} from './agent-director-client.ts'
import { encodePermissionActionId } from './permission-action-id.ts'
import { emitTrail as defaultEmitTrail } from './permission-trail.ts'
import type { RowDecisionAction, TrailEventBase } from './permission-trail.ts'

// ---------------------------------------------------------------------------
// Wire-shape types (local — mirrors the `^0.6.0` wire)
// ---------------------------------------------------------------------------

/**
 * A single open permission_requests row from agent-director's plural
 * projection (`^0.6.0`+). CSCB treats `request_token` as opaque (no parsing,
 * no validation of the bytes themselves).
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
 * Local view of the `^0.6.0` `GetResult`. The locked `0.5.6` types still
 * carry singular `permission_request`; `^0.6.0` replaces it with the plural
 * `permission_requests`. We strip the singular field via Omit and re-add the
 * plural one so we never accidentally read the old shape until the lockfile
 * catches up.
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
    /**
     * AD `get-permission` verb (SR-7.1; shipped in `^0.6.0`). Optional on the
     * structural type so the runtime path compiles against the locked
     * `0.5.6` Client types (which have no such method) and so tests can
     * supply a stub.
     */
    getPermission?: (params: GetPermissionParams) => Promise<GetPermissionResult>
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
  /**
   * Trail emitter hook (SR-V). Defaults to `emitTrail` from
   * `permission-trail.ts`. Tests override with a capture stub to assert
   * emission shape without touching the on-disk JSONL.
   */
  emitTrail?: (
    partial: Omit<TrailEventBase, 'ts'> & { [extra: string]: unknown },
  ) => void
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

/**
 * SR-V-2.3 row-decision emitter. Builds a `cscb.poller.row_decision` event
 * with the canonical envelope fields and the action identifier. `request_token`
 * is omitted (not empty) when absent per SR-V-1.1.
 */
function emitRowDecision(
  deps: PollerDeps,
  action: RowDecisionAction,
  claudeInstanceId: string,
  requestToken: string | undefined,
): void {
  const emit = deps.emitTrail ?? defaultEmitTrail
  const event: Omit<TrailEventBase, 'ts'> & { [extra: string]: unknown } = {
    event: 'cscb.poller.row_decision',
    claude_instance_id: claudeInstanceId,
    action,
  }
  if (requestToken !== undefined) event.request_token = requestToken
  emit(event)
}

/**
 * Map an unknown Slack error to a stable error-class string per SR-V-2.4.
 * Slack platform errors expose `data.error` (e.g. `channel_not_found`); other
 * errors collapse to short class labels.
 */
function classifySlackError(err: unknown): string {
  if (err !== null && typeof err === 'object') {
    const data = (err as { data?: unknown }).data
    if (data !== null && typeof data === 'object') {
      const e = (data as { error?: unknown }).error
      if (typeof e === 'string' && e.length > 0) return e
    }
  }
  if (err instanceof Error) {
    if (err.name === 'AbortError') return 'aborted'
    return 'network_error'
  }
  return 'unknown_error'
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
        // SR-V-2.3: request_token omitted (no row was readable) per SR-V-1.1.
        emitRowDecision(deps, 'non_conforming_skipped', row.claude_instance_id, undefined)
        continue
      }

      for (const perm of got.permission_requests) {
        const key = makeCompositeKey(row.claude_instance_id, perm.request_token)
        seenComposite.add(key)
        if (livePermissions.has(key)) {
          emitRowDecision(deps, 'already_tracked', row.claude_instance_id, perm.request_token)
          continue
        }
        emitRowDecision(deps, 'post_attempted', row.claude_instance_id, perm.request_token)
        await postPermissionPrompt(deps, row, perm)
      }
    }

    // SR-2.4 newly-closed reconciliation. Collect first, then reconcile —
    // avoids mutating the map while iterating it.
    const closedEntries: LivePermission[] = []
    for (const [key, entry] of livePermissions) {
      if (seenComposite.has(key)) continue
      if (nonConformingInstanceIds.has(entry.claudeInstanceId)) continue
      closedEntries.push(entry)
    }

    for (const entry of closedEntries) {
      let info: GetPermissionResult
      try {
        info = await getPermission(client, { request_token: entry.requestToken })
      } catch (err) {
        if (isErrPermissionRequestNotFound(err)) {
          logViaDeps(deps, `[slack] permission-poller: get-permission not-found for ${entry.claudeInstanceId} token=${entry.requestToken} — generic deny + drop`)
          emitRowDecision(deps, 'not_found_generic_deny', entry.claudeInstanceId, entry.requestToken)
          await renderClosureUpdate(deps, entry, 'not_found')
          dropPermission(entry.claudeInstanceId, entry.requestToken)
          continue
        }
        const e = err instanceof AgentDirectorError ? err : null
        logViaDeps(deps, `[slack] permission-poller: get-permission failed for ${entry.claudeInstanceId} token=${entry.requestToken}: ${e?.errName ?? String(err)}`)
        // SR-2.4 transient retry: leave entry alive; next tick will retry.
        emitRowDecision(deps, 'transient_retry', entry.claudeInstanceId, entry.requestToken)
        continue
      }

      const verdict = classifyVerdict(info)
      if (verdict === 'unknown') {
        logViaDeps(deps, `[slack] permission-poller: unknown verdict for ${entry.claudeInstanceId} token=${entry.requestToken} decision=${info.decision} decision_reason=${String(info.decision_reason)} — fail-closed generic deny`)
      }
      emitRowDecision(deps, 'reconciled_closed', entry.claudeInstanceId, entry.requestToken)
      await renderClosureUpdate(deps, entry, verdict)
      dropPermission(entry.claudeInstanceId, entry.requestToken)
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

  const text = `🤖🛠️ permission request: ${permission.tool_name}`
  const emit = deps.emitTrail ?? defaultEmitTrail
  try {
    const response = await deps.web.chat.postMessage({
      channel: channelId,
      text,
      blocks: blocks as never,
    })
    const messageTs = (response as { ts?: string }).ts
    // SR-V-2.4: emit on success (and on the no-ts edge case below) with the
    // Slack-returned ts. Full text + blocks pass through verbatim (SR-V-3.1).
    emit({
      event: 'cscb.chat_post.attempted',
      claude_instance_id: row.claude_instance_id,
      request_token: permission.request_token,
      channel: channelId,
      text,
      blocks,
      ok: true,
      slack_ts: messageTs,
    })
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
    // SR-V-2.4: failure-only logViaDeps removed; ok=false event is now the
    // first-class failure signal. `error` carries the Slack platform error
    // class string, not JS Error.name.
    emit({
      event: 'cscb.chat_post.attempted',
      claude_instance_id: row.claude_instance_id,
      request_token: permission.request_token,
      channel: channelId,
      text,
      blocks,
      ok: false,
      error: classifySlackError(err),
    })
  }
}

// ---------------------------------------------------------------------------
// Verdict classification + closure rendering (SR-5.1, SR-5.2, SR-5.3, SR-5.4)
// ---------------------------------------------------------------------------

/** Discriminated verdict tag produced from a `get-permission` response. */
export type VerdictTag =
  | 'operator_allow'
  | 'operator_deny'
  | 'timeout'
  | 'find_missing'
  | 'unknown'
  | 'not_found'

/**
 * Map the AD `decision` + `decision_reason` pair to a verdict tag. The mapping
 * is intentionally strict: ANY combination outside the four canonical pairs
 * (including allow with non-null reason, or deny with an unrecognized reason)
 * collapses to `'unknown'` — the SR-5.2 fail-closed generic deny path.
 */
export function classifyVerdict(info: GetPermissionResult): VerdictTag {
  if (info.decision === 'allow' && info.decision_reason === null) return 'operator_allow'
  if (info.decision === 'deny') {
    if (info.decision_reason === 'operator') return 'operator_deny'
    if (info.decision_reason === 'timeout') return 'timeout'
    if (info.decision_reason === 'find_missing') return 'find_missing'
  }
  return 'unknown'
}

/**
 * Block Kit body + text for a closure verdict. Each tag yields a visually
 * distinct text so operators can tell from the message why the prompt closed
 * (SR-5.1). The `not_found` and `unknown` tags share the generic-deny
 * rendering (SR-2.4 not-found path and SR-5.2 fail-closed path).
 *
 * The poller-side `operator_allow` / `operator_deny` renderings stand in for
 * the case where the click handler's chat.update did not land (e.g. failure,
 * or the click came in too late and AD already had the row closed). The
 * click handler's "by X" rendering (SR-5.4) is still authoritative for the
 * happy path; the verdict surface only carries the closure state since the
 * operator identity is unknown to the poller.
 */
function buildVerdictRendering(tag: VerdictTag): { text: string; blocks: unknown[] } {
  let text: string
  switch (tag) {
    case 'operator_allow':
      text = '*Permission* — Allowed'
      break
    case 'operator_deny':
      text = '*Permission* — Denied by operator'
      break
    case 'timeout':
      text = '⏱ *Permission* — Timed out'
      break
    case 'find_missing':
      text = '🪦 *Permission* — Session ended'
      break
    case 'unknown':
    case 'not_found':
      text = '*Permission* — Denied (closed)'
      break
  }
  return {
    text,
    blocks: [
      {
        type: 'section',
        text: { type: 'mrkdwn', text },
      },
    ],
  }
}

/**
 * Issue exactly one `chat.update` carrying the verdict-distinct rendering
 * against this entry's messageTs. Sibling-independent by construction: the
 * call only ever names `entry.channelId` + `entry.messageTs` (SR-5.3).
 */
async function renderClosureUpdate(
  deps: PollerDeps,
  entry: LivePermission,
  tag: VerdictTag,
): Promise<void> {
  const { text, blocks } = buildVerdictRendering(tag)
  try {
    await deps.web.chat.update({
      channel: entry.channelId,
      ts: entry.messageTs,
      text,
      blocks: blocks as never,
    })
  } catch (err) {
    logViaDeps(deps, `[slack] permission-poller: closure chat.update failed for ${entry.claudeInstanceId} token=${entry.requestToken} (verdict=${tag}):`, err)
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
