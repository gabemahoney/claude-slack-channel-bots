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
 * Rows are mapped to personas by their `persona` label (b.av2 SR-7.1). A
 * persona's prompts go to its destination through that persona's own Web
 * client (`clientFor`), never to a channel taken from the row: its channel, or
 * its DM with `dm.contact`, opened with `conversations.open` on that client
 * and cached by the destination resolver (`persona-destination.ts`, shared
 * with the per-persona notifier). Each live entry records the conversation
 * the prompt was posted in (the `D…` ID for a DM) and the posting persona;
 * closing updates go there, whatever the persona's destination or DMs switch
 * is now (b.av2 SR-5.1: an update is not a post). Outage state is keyed by
 * the persona key.
 *
 * Behavior per tick:
 *   1. list({state:['check_permission'], label:['service=cscb']}).
 *   2. For each row, resolve the persona from its `persona` label; a row with
 *      no label, or one naming no applied persona, is logged and skipped.
 *      Then get({claude_instance_id}). When the plural projection is absent
 *      (undefined/null), log non-conformance and skip — do not mutate state
 *      for that row, and exclude that spawn's live entries from the
 *      newly-closed sweep this tick.
 *   3. For each PermissionRequestRow in the plural projection, compute the
 *      composite key. If already tracked → skip (duplicate-tick no-op).
 *      Else post a fresh Block Kit prompt to the persona's destination and
 *      register the live entry. A persona whose client is unavailable, or
 *      whose `dm` destination is refused (DMs off or no contact), is logged
 *      once per open request and not tracked. A failed open or post is
 *      trailed and not tracked. A later tick retries all of these, except
 *      that a persona held by the destination hold (below) is not attempted
 *      until its retry is due.
 *   4. Newly-closed reconciliation (SR-2.4): for each live entry whose
 *      composite key was NOT observed this tick (excluding non-conforming
 *      spawns), call `get-permission`, render the verdict-distinct
 *      chat.update through the posting persona's client against that row's
 *      channel and messageTs, and drop the entry.
 *      `ErrPermissionRequestNotFound` → render generic deny + drop + no
 *      retry. Other transient errors → leave entry alive, retry next tick.
 *      Unknown `decision_reason` → fail-closed generic deny (SR-5.2).
 *
 * Per-spawn request_id advancement is no longer a special path — the
 * composite key means a "new" token simply appears as an unseen entry and
 * the old token naturally falls out of the seen-set on the next tick.
 *
 * Destination failures (b.av2 SR-7.1): every new prompt and stuck-prompt
 * warning goes through the destination hold (`persona-destination-hold.ts`,
 * shared with the notifier), which answers whether the persona may be
 * attempted now. When a post fails at the destination (`missing_scope` on the
 * DM open, `not_in_channel`, Slack unreachable, …) the persona is held: no
 * Slack call is made for it, and no `post_attempted` row decision emitted,
 * until its retry is due on the SR-3.2 backoff, and the prompt stays
 * untracked, so a later tick derives it again. The hold logs one
 * `persona-destination-failed` line per episode instead of a line per
 * attempt; every real attempt still emits its trail event. A failure of the
 * message itself (`invalid_blocks`, `msg_too_long`, …) does not hold the
 * persona: it is logged and trailed per attempt and tried again next tick.
 * Closing updates and clicks are never gated (an update is not a post).
 *
 * A persona teardown (b.jg5 SRJ-1003): while the persona's teardown window is
 * open (the injected `teardownNotices`), its stuck-prompt warning is not
 * posted: it is handed to the notifier's `notify`, whose window writes it as
 * one log line and one `persona-teardown-notice` entry, and the warning's
 * latch is set, so it is written once and never dropped. Outside a window it
 * routes as above:
 *
 *   [slack] permission-poller: stuck-prompt warning for "<name>" (key=<key>) (<id>) raised during its persona teardown — handed to the notifier, which writes it to the server log and startup-errors.log, not posted (b.jg5 SRJ-1003)
 *
 * A persona that is not up (b.av2 SR-6.4, the injected `isPersonaUp`) keeps
 * its instance, but the poller leaves it alone: its rows get no `get`, no
 * prompt and no wedge-detector tick, and its tracked prompts and wedge state
 * are held as they are (not treated as closed, not re-armed) until it is up,
 * when the next tick reconciles them normally. The skip emits no trail event;
 * it is logged once when it starts and once when it ends:
 *
 *   [slack] permission-poller: persona "<name>" (key=<key>) is not up — skipping its rows and holding its tracked prompts until it is up
 *   [slack] permission-poller: persona "<name>" (key=<key>) is up again — polling its rows again
 *
 * SPDX-License-Identifier: MIT
 */

import {
  ErrSpawnNotFound,
  ErrSystemInstallDisappeared,
  ErrTmuxNotAvailable,
} from 'agent-director'
import type {
  GetResult as ADGetResult,
  ListRow,
} from 'agent-director'

import type { Persona } from './config.ts'
import {
  getPermission,
  isErrPermissionRequestNotFound,
} from './agent-director-client.ts'
import type {
  GetPermissionParams,
  GetPermissionResult,
} from './agent-director-client.ts'
import { describeAgentDirectorFailure } from './ad-error-class.ts'
import { withOutageDetection } from './outage-state.ts'
import { encodePermissionActionId } from './permission-action-id.ts'
import {
  describeSlackCallFailure,
  describeThrownValue,
} from './persona-connection-errors.ts'
import {
  classifySlackError,
  createPersonaDestinations,
  describeDestinationFailure,
  describeDmDestinationRefusal,
  dmDestinationRefusal,
  safeFailureCode,
  type DestinationSlackClient,
  type PersonaDestinations,
} from './persona-destination.ts'
import {
  createPersonaDestinationHold,
  isDestinationFailure,
  type HoldAttempt,
  type PersonaDestinationHold,
} from './persona-destination-hold.ts'
import { PERSONA_LABEL_KEY, personaInstanceId, renderPersonaRef } from './persona-identity.ts'
import { formatPersonaNotice, notifySafely, type PersonaNotifier } from './persona-notifier.ts'
import { emitTrail as defaultEmitTrail } from './permission-trail.ts'
import type {
  ClosureVerdictTag,
  RowDecisionAction,
  TrailEventBase,
} from './permission-trail.ts'

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
  /** Key of the persona whose client posted the prompt; closing updates go through it. */
  personaKey: string
  /** Conversation the prompt was posted in: the channel, or the `D…` DM conversation. */
  channelId: string
  messageTs: string
  /** Retained for logging only; never used for routing/keying/encoding. */
  requestId: number
  /** Set to true by the click handler once its final chat.update succeeds. */
  handled: boolean
}

/** Why an open request's prompt was not posted: no client, or a refused `dm` destination. */
type UnpostedReason = 'client-unavailable' | 'destination-refused'

/**
 * Deterministic composite key for the pending map. The null byte
 * separator is chosen because neither claude_instance_id nor a UUIDv4
 * token can contain \x00.
 */
export function makeCompositeKey(claudeInstanceId: string, requestToken: string): string {
  return `${claudeInstanceId}\x00${requestToken}`
}

/** The Slack surface the poller uses on a persona's client: posts, updates and DM opens. */
export type PollerSlackClient = DestinationSlackClient

/**
 * Injection points for the poller. Production callers supply the real Bun
 * setInterval/clearInterval, getClient() and the per-persona client and
 * persona lookups; tests pass stubs.
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
  /**
   * The persona's Slack client, or undefined when it is not available (not
   * validated yet, dry run, unknown key).
   */
  clientFor: (key: string) => PollerSlackClient | undefined
  /**
   * The destination resolver (per-persona DM cache) shared with the
   * notifier. Used only to build the default destination hold when
   * `destinationHold` is not given (the poller posts through the hold, never
   * through this directly); a `destinationHold` that is given must be built
   * over this same resolver. Defaults to a module-level instance, reset by
   * `_resetPollerState`.
   */
  destinations?: PersonaDestinations
  /**
   * The destination hold (per-persona episodes and retries) shared with the
   * notifier: a new prompt or stuck-prompt warning is attempted only when it
   * allows. Defaults to a module-level instance over `destinations` and the
   * real clock, reset by `_resetPollerState`; the poller alone never makes it
   * set a timer (it holds no notices).
   */
  destinationHold?: PersonaDestinationHold
  /**
   * The persona notifier (b.jg5 SRJ-1003): while the key's persona teardown
   * window is open (`teardownWindowState` answers `open`), the stuck-prompt
   * warning is handed to its `notify`, whose window writes it as a teardown
   * notice (one log line and one `persona-teardown-notice` entry), never
   * posted, held or dropped. Absent, or outside a window: the warning goes
   * through the destination hold (`destinationHold`).
   */
  teardownNotices?: Pick<PersonaNotifier, 'notify' | 'teardownWindowState'>
  /**
   * The applied persona with this key, or undefined. Read on every tick, so a
   * swapped persona set is seen at once.
   */
  getPersona: (key: string) => Persona | undefined
  /**
   * Whether the persona with this key is up (b.av2 SR-6.4); production passes
   * `createPersonaUpPredicate`. An applied persona that is not up is skipped.
   */
  isPersonaUp: (key: string) => boolean
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
// Wedge-detector tuning (b.fae F4)
// ---------------------------------------------------------------------------

/**
 * Wall-clock a spawn must sit in check_permission with ZERO open
 * `permission_requests` rows before we declare it wedged (b.fae F4).
 *
 * Sizing rationale: the poll interval defaults to 1 s
 * (DEFAULT_AGENT_DIRECTOR_POLL_INTERVAL_MS) but is operator-configurable in
 * [200 ms, 1 h]. A raw tick count (the ticket's "K=30") would therefore mean
 * 6 s at a 200 ms interval or 30 min at a 1 min interval — not a stable
 * wall-clock. So we derive the tick threshold K from the interval to target a
 * FIXED wall-clock window, `WEDGE_TRIP_WALL_CLOCK_MS`.
 *
 * The window (90 s) is chosen to straddle the two regimes the investigation
 * measured:
 *   - The LEGITIMATE transient — the sub-second/few-second race where `decide`
 *     has closed the last open row and the next hook has not yet fired to
 *     advance state — is at most a few seconds, well under 90 s, so a healthy
 *     spawn never trips.
 *   - The real wedge takes MINUTES to develop (the incident's lost decision
 *     landed 680 s after the request), so 90 s still fires long before an
 *     operator would otherwise notice the bot is silently dead, while staying
 *     safely clear of the transient.
 * The ticket's K=30 (~30 s at the 1 s default) also clears the transient; 90 s
 * is chosen as a more conservative margin above it that still alarms within a
 * couple of minutes.
 */
export const WEDGE_TRIP_WALL_CLOCK_MS = 90_000

/**
 * Convert the poll interval into the consecutive-tick threshold K that
 * approximates `WEDGE_TRIP_WALL_CLOCK_MS`. Floored at 5 ticks so a
 * pathologically large interval can never make K so small the transient trips
 * it (K=1 would fire on a single tick that happens to catch the race).
 */
export function wedgeTripTicks(intervalMs: number): number {
  return Math.max(5, Math.ceil(WEDGE_TRIP_WALL_CLOCK_MS / intervalMs))
}

/**
 * Per-spawn detector state for the empty-open-rows wedge. A spawn appears here
 * only while it is observed in check_permission with an empty
 * `permission_requests` array. It is removed (counter AND fired flag reset)
 * the moment it leaves that condition — it exits check_permission, an open row
 * appears, or the spawn disappears — so a later genuine wedge alarms again.
 */
interface WedgeState {
  /** Key of the spawn's persona, so its state is held while the persona is not up. */
  personaKey: string
  /** Consecutive ticks observed empty-in-check_permission. */
  emptyTicks: number
  /** One-shot latch: true only once the warning has SUCCESSFULLY posted for
   * this episode, suppressing per-tick spam until the spawn recovers (b.vfx dedupe shape:
   * in-memory first-occurrence, reset on recovery / daemon restart). b.fae
   * F3: set only after a successful chat.postMessage, so a transient Slack
   * failure retries on a later tick instead of permanently swallowing the
   * episode's one warning. */
  warningFired: boolean
  /**
   * b.fae F3 — throttle for warning-post RETRIES while the latch is unset (the
   * post keeps failing). Once the tick threshold is crossed we attempt a post;
   * on failure `warningFired` stays false so we retry, but attempting every
   * tick would hammer Slack (intervals go as low as 200 ms). This records the
   * `emptyTicks` value at the last attempt so we back off to at most one retry
   * per `WEDGE_WARN_RETRY_TICKS`-worth of ticks. The `ok:false` trail event is
   * still emitted on each ACTUAL attempt — we suppress attempts, not the
   * diagnostic record of the attempts we make.
   */
  lastWarnAttemptTicks: number
}

/**
 * b.fae F3 — minimum wall-clock (ms) between warning-post retries while the
 * latch is unset. Converted to a tick count against the live interval, same
 * pattern as {@link wedgeTripTicks}. 30 s keeps a Slack outage from producing
 * a per-tick storm of failing posts while still recovering promptly once Slack
 * returns.
 */
export const WEDGE_WARN_RETRY_WALL_CLOCK_MS = 30_000

/** Tick count between warning-post retries; floored at 1 so a huge interval
 * always retries on the very next empty tick. */
export function wedgeWarnRetryTicks(intervalMs: number): number {
  return Math.max(1, Math.ceil(WEDGE_WARN_RETRY_WALL_CLOCK_MS / intervalMs))
}

// ---------------------------------------------------------------------------
// Module-scoped live state
// ---------------------------------------------------------------------------

const livePermissions = new Map<string, LivePermission>()
/**
 * Composite key → why an open request was not posted (the persona's client
 * unavailable, or its `dm` destination refused). Keeps the not-posted log line to one per
 * open request and reason; an entry is forgotten once the request is posted
 * or no longer observed.
 */
const unpostedPrompts = new Map<string, UnpostedReason>()
/** claude_instance_id → wedge-detector state (b.fae F4). */
const wedgeStates = new Map<string, WedgeState>()
/** Keys of the personas in a not-up skip episode, for its start and end lines (b.av2 SR-6.4). */
const notUpSkipping = new Set<string>()
/**
 * Instance IDs of listed rows with no `persona` label whose skip line has been
 * logged (b.1ix). The start sweep keeps a pre-persona row, so one can sit in
 * `check_permission` for good; its line is logged once while it stays listed,
 * not every tick. An ID a successful list no longer holds (the row left
 * `check_permission`, or it gained a label) is forgotten, so the row logs
 * again if it comes back.
 */
const noLabelLogged = new Set<string>()
let pollerHandle: ReturnType<typeof setInterval> | null = null
let tickInFlight = false
let skippedTicks = 0
let depsRef: PollerDeps | null = null
/** The destination resolver used when `PollerDeps.destinations` is not given. */
let defaultDestinations: PersonaDestinations | null = null
/** The destination hold used when `PollerDeps.destinationHold` is not given. */
let defaultDestinationHold: PersonaDestinationHold | null = null

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

/**
 * Forget everything the poller keeps for persona `key` and its instance
 * (`cscb_<key>`; b.av2 SR-6.5, a teardown): its tracked prompts, their
 * not-posted records, its wedge and stuck-prompt state and its not-up skip
 * episode. Makes no Slack call and renders no closing update: the posted
 * prompts stay as they are, and a later tick has nothing of the persona's to
 * reconcile. No other persona's state changes; no trail event. Logs one line
 * when tracked prompts were dropped. Returns how many were.
 */
export function forgetPersonaPrompts(key: string): number {
  const instanceId = personaInstanceId(key)
  const ownedBy = (personaKey: string, claudeInstanceId: string) =>
    personaKey === key || claudeInstanceId === instanceId
  let dropped = 0
  for (const [compositeKey, entry] of [...livePermissions]) {
    if (!ownedBy(entry.personaKey, entry.claudeInstanceId)) continue
    livePermissions.delete(compositeKey)
    dropped++
  }
  const instancePrefix = makeCompositeKey(instanceId, '')
  for (const compositeKey of [...unpostedPrompts.keys()]) {
    if (compositeKey.startsWith(instancePrefix)) unpostedPrompts.delete(compositeKey)
  }
  for (const [claudeInstanceId, state] of [...wedgeStates]) {
    if (ownedBy(state.personaKey, claudeInstanceId)) wedgeStates.delete(claudeInstanceId)
  }
  notUpSkipping.delete(key)
  if (dropped > 0) {
    const line = `[slack] permission-poller: persona=${key}: dropped ${dropped} tracked prompt(s); their Slack messages stay as posted`
    if (depsRef) logViaDeps(depsRef, line)
    else console.error(line)
  }
  return dropped
}

/** Test-only: reset module-scoped state. */
export function _resetPollerState(): void {
  if (pollerHandle !== null) {
    if (depsRef?.clearInterval) depsRef.clearInterval(pollerHandle)
    else clearInterval(pollerHandle)
  }
  livePermissions.clear()
  unpostedPrompts.clear()
  wedgeStates.clear()
  notUpSkipping.clear()
  noLabelLogged.clear()
  pollerHandle = null
  tickInFlight = false
  skippedTicks = 0
  depsRef = null
  defaultDestinations = null
  defaultDestinationHold?.cancelAll()
  defaultDestinationHold = null
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
 * The tail of a failed agent-director call's log line
 * (`describeAgentDirectorFailure`, declared in `src/ad-error-class.ts` beside
 * the classifier and re-exported here for this module's callers).
 */
export { describeAgentDirectorFailure }

/** The injected destination resolver, else the module-level default. */
function destinationsFor(deps: PollerDeps): PersonaDestinations {
  if (deps.destinations) return deps.destinations
  defaultDestinations ??= createPersonaDestinations({ log: (line) => logViaDeps(deps, line) })
  return defaultDestinations
}

/** The injected destination hold, else the module-level default over `destinationsFor(deps)`. */
function destinationHoldFor(deps: PollerDeps): PersonaDestinationHold {
  if (deps.destinationHold) return deps.destinationHold
  defaultDestinationHold ??= createPersonaDestinationHold({
    destinations: destinationsFor(deps),
    getPersona: (key) => deps.getPersona(key),
    clientFor: (key) => deps.clientFor(key),
    log: (line) => logViaDeps(deps, line),
  })
  return defaultDestinationHold
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
 * b.fae F4 / b.jg5 SRJ-1012 — one-shot warning for a spawn wedged in
 * check_permission with zero open rows: the persona prefix (b.av2 SR-7.2)
 * followed by {@link buildWedgeWarningBody}. The text names agent-director
 * verbs only, as a human's steps: `read-pane` to see the native prompt, then
 * `kill` with "check the result", after which the server brings the persona
 * up again on its own. It names no tmux command and no respawn as a human's
 * step, and carries SRJ-1001's human-only sentence. `send-keys` is NOT
 * offered: AD's relay guard hard-rejects send-keys whenever relay_mode=on &&
 * state=check_permission, with no open-row exemption.
 */
export function buildWedgeWarningText(persona: Pick<Persona, 'name' | 'key'>, claudeInstanceId: string): string {
  return formatPersonaNotice(persona, buildWedgeWarningBody(claudeInstanceId))
}

/**
 * b.jg5 SRJ-1012 — the wedge warning's body, with no persona reference (the
 * notifier adds its own): SRJ-1012's text, with `claudeInstanceId` in both
 * places it names the instance id. Used by the post and by the
 * teardown-window notice alike.
 */
export function buildWedgeWarningBody(claudeInstanceId: string): string {
  return (
    '⚠️ This persona appears blocked on a native Claude Code permission prompt that ' +
    "never reached Slack — it will not respond until it's cleared. To recover: run " +
    '`agent-director read-pane --claude-instance-id ' +
    claudeInstanceId +
    '` to see the native prompt, then end the session with ' +
    '`agent-director kill --claude-instance-id ' +
    claudeInstanceId +
    '` and check the result; the server then brings the persona up again. ' +
    'Do NOT use send-keys — it is rejected in this state. ' +
    'These commands are for a human only: no bot, including any persona that sees this post, may run them.'
  )
}

/**
 * b.jg5 SRJ-1003 — while the persona's teardown window is open, hand the
 * wedge warning to the notifier, whose window writes it as a teardown notice
 * (never posted, held or dropped), and answer true; answer false (nothing
 * done) when no notifier is given or no window is open. A failing notifier
 * is logged. Never throws.
 */
function writeWedgeWarningInTeardown(deps: PollerDeps, persona: Persona, claudeInstanceId: string): boolean {
  const notices = deps.teardownNotices
  if (notices === undefined) return false
  const ref = renderPersonaRef(persona.name, persona.key)
  try {
    if (notices.teardownWindowState(persona.key) !== 'open') return false
  } catch (err) {
    logViaDeps(deps, `[slack] permission-poller: teardown window read for ${ref} failed: ${describeThrownValue(err)} — read as not open`)
    return false
  }
  logViaDeps(
    deps,
    `[slack] permission-poller: stuck-prompt warning for ${ref} (${claudeInstanceId}) raised during its persona teardown — ` +
      'handed to the notifier, which writes it to the server log and startup-errors.log, not posted (b.jg5 SRJ-1003)',
  )
  notifySafely(notices.notify, persona.key, buildWedgeWarningBody(claudeInstanceId), undefined, (err) =>
    logViaDeps(deps, `[slack] permission-poller: stuck-prompt warning for ${ref} (${claudeInstanceId}) failed at the notifier: ${describeThrownValue(err)}`),
  )
  return true
}

/**
 * b.fae F4 / b.av2 SR-7.2 — deliver the one-shot wedge warning to the
 * persona's destination (its channel, or its DM, opened if needed) as one
 * top-level message (no thread_ts) through the persona's client, as the
 * destination hold's `attempt` (which the caller obtained and releases).
 * `text` is the warning, built before the attempt was begun. Returns true only
 * when the post succeeds, so the latch may be set. A client that is
 * unavailable, or a `dm` destination the resolver refuses, counts as a failed post (false) with no Slack call and no trail
 * event, so the retry throttle governs the next attempt. Every actual attempt
 * emits `cscb.poller.wedge_detected` with `channel` equal to the conversation
 * posted to; a failed DM open emits it with `ok: false` and no `channel`. A
 * destination failure is logged by the hold (once per episode); only a
 * failure of the message itself is logged here.
 */
async function postWedgeWarning(
  deps: PollerDeps,
  attempt: HoldAttempt,
  claudeInstanceId: string,
  persona: Persona,
  text: string,
): Promise<boolean> {
  const ref = renderPersonaRef(persona.name, persona.key)
  const web = deps.clientFor(persona.key)
  if (!web) {
    logViaDeps(
      deps,
      `[slack] permission-poller: no Slack client for ${ref} — stuck-prompt warning for ${claudeInstanceId} ` +
        'not posted; retrying on a later tick',
    )
    return false
  }
  const emit = deps.emitTrail ?? defaultEmitTrail
  const result = await attempt.post(persona, web, { text })
  if (result.outcome === 'refused') return false
  if (result.outcome === 'posted') {
    emit({
      event: 'cscb.poller.wedge_detected',
      claude_instance_id: claudeInstanceId,
      channel: result.channelId,
      text,
      ok: true,
      slack_ts: result.ts,
    })
    return true
  }
  // b.emk convention: failures land in BOTH server.log and the trail JSONL.
  // A destination failure reaches server.log as the hold's episode line.
  if (!isDestinationFailure(result)) {
    logViaDeps(
      deps,
      `[slack] permission-poller: wedge warning postMessage failed for ${ref} (${claudeInstanceId})` +
        describeDestinationFailure(result),
    )
  }
  const event: Omit<TrailEventBase, 'ts'> & { [extra: string]: unknown } = {
    event: 'cscb.poller.wedge_detected',
    claude_instance_id: claudeInstanceId,
    text,
    ok: false,
    error: safeFailureCode(result.code),
  }
  if (result.channelId !== undefined) event.channel = result.channelId
  emit(event)
  return false
}

/**
 * b.fae F4 — advance the wedge detector for one spawn observed this tick in
 * check_permission with an EMPTY `permission_requests` array. Increments the
 * per-spawn consecutive-empty-tick counter; when it crosses the K threshold
 * (`wedgeTripTicks`) for the first time this episode, logs, and sends the
 * one-shot warning to the persona's destination. The `warningFired` latch
 * suppresses per-tick spam thereafter (the operator-hostile behavior b.vfx
 * documents) — but b.fae F3: it latches ONLY after a successful post, so a
 * transient chat.postMessage failure retries on a later tick instead of
 * permanently swallowing the episode's one warning. Retries are throttled to
 * one per {@link wedgeWarnRetryTicks} so a Slack outage cannot storm the API
 * at a 200 ms interval. A retry is also attempted only when the destination
 * hold allows (b.av2 SR-7.1): while the persona is held nothing is attempted
 * or logged, and the throttle is left as it is. The detector is re-armed by
 * `reconcileWedgeStates` dropping the spawn's state the moment it leaves the
 * wedged condition.
 */
async function observeWedgeCandidate(
  deps: PollerDeps,
  claudeInstanceId: string,
  persona: Persona,
): Promise<void> {
  const k = wedgeTripTicks(deps.intervalMs)
  let state = wedgeStates.get(claudeInstanceId)
  if (!state) {
    state = { personaKey: persona.key, emptyTicks: 0, warningFired: false, lastWarnAttemptTicks: 0 }
    wedgeStates.set(claudeInstanceId, state)
  }
  state.emptyTicks++
  if (state.emptyTicks < k || state.warningFired) return

  // Threshold crossed and not yet successfully warned. Throttle retries: only
  // (re)attempt if this is the first attempt (lastWarnAttemptTicks === 0) or
  // enough ticks have elapsed since the last failed attempt.
  const retryEvery = wedgeWarnRetryTicks(deps.intervalMs)
  if (
    state.lastWarnAttemptTicks !== 0 &&
    state.emptyTicks - state.lastWarnAttemptTicks < retryEvery
  ) {
    return
  }
  // b.jg5 SRJ-1003: inside the persona's teardown window the warning is a
  // teardown notice, written once and latched as delivered.
  if (writeWedgeWarningInTeardown(deps, persona, claudeInstanceId)) {
    state.warningFired = true
    return
  }
  const text = buildWedgeWarningText(persona, claudeInstanceId)
  const attempt = destinationHoldFor(deps).begin(persona.key)
  if (!attempt) return
  // The attempt always ends, even on a throw (a no-op after its post), so a
  // retrying persona is never left held with no timer.
  try {
    state.lastWarnAttemptTicks = state.emptyTicks
    logViaDeps(
      deps,
      `[slack] permission-poller: spawn ${claudeInstanceId} for ${renderPersonaRef(persona.name, persona.key)} wedged in check_permission with zero open rows for ${state.emptyTicks} ticks (~${Math.round((state.emptyTicks * deps.intervalMs) / 1000)}s) — sending one-shot warning`,
    )
    const warned = await postWedgeWarning(deps, attempt, claudeInstanceId, persona, text)
    // b.fae F3: latch only on success; a failed post leaves warningFired false so
    // a subsequent tick retries and exactly one message lands on recovery.
    if (warned) state.warningFired = true
  } finally {
    attempt.release()
  }
}

/**
 * b.fae F4 — re-arm the detector for any tracked spawn POSITIVELY observed
 * non-wedged this tick. A spawn leaves the wedged condition when it exits
 * check_permission, an open row appears, or it disappears entirely; in every
 * such case its instance id is absent from `observedEmpty`, so we drop its
 * state (counter AND fired flag) and a later genuine wedge alarms afresh.
 *
 * b.fae F4 follow-up: a spawn merely SKIPPED this tick due to a transient `get`
 * error or a non-conforming response (`skippedThisTick`) is NOT a positive
 * observation — resetting on it would let a single flaky AD connection zero the
 * counter and defer detection indefinitely. Such spawns are exempted (mirrors
 * the closed-row sweep's `nonConformingInstanceIds` exemption): their state is
 * preserved so the empty-tick count accumulates across transient read gaps.
 * The state of a spawn whose persona is not up (`isHeld`, b.av2 SR-6.4) is
 * preserved the same way, listed this tick or not.
 */
function reconcileWedgeStates(
  observedEmpty: Set<string>,
  skippedThisTick: Set<string>,
  isHeld: (personaKey: string) => boolean,
): void {
  for (const [instanceId, state] of [...wedgeStates]) {
    if (observedEmpty.has(instanceId)) continue
    if (skippedThisTick.has(instanceId)) continue
    if (isHeld(state.personaKey)) continue
    wedgeStates.delete(instanceId)
  }
}

async function runTick(deps: PollerDeps): Promise<void> {
  if (tickInFlight) {
    skippedTicks++
    // Fire exactly once when the streak crosses 5 (4 → 5 transition). Further
    // skips within the same streak are silent; the next successfully-started
    // tick body resets skippedTicks to 0 and re-arms the warning for a future
    // streak. Mirrors src/health-check.ts:55-62 — see that block for the
    // budget-exhaustion rationale.
    if (skippedTicks === 5) {
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
      logViaDeps(deps, `[slack] permission-poller: list failed: ${describeThrownValue(err)}`)
      return
    }
    forgetUnlistedNoLabelRows(rows)

    const seenComposite = new Set<string>()
    const nonConformingInstanceIds = new Set<string>()
    // b.fae F4: spawns observed this tick in check_permission with an empty
    // (conforming) permission_requests array. Any tracked wedge state NOT in
    // this set at tick-end is re-armed (the spawn left the wedged condition)…
    const wedgeObservedEmpty = new Set<string>()
    // …UNLESS the spawn was merely SKIPPED this tick due to a transient `get`
    // error or a non-conforming (null/undefined) open-rows response. b.fae F4
    // follow-up: a single flaky AD connection must not zero the wedge counter
    // and defer detection indefinitely. This is the analogue of the closed-row
    // sweep exempting `nonConformingInstanceIds`: we only reset wedge state for
    // spawns POSITIVELY observed non-wedged (non-empty rows, or confirmed gone
    // via ErrSpawnNotFound), never for spawns we simply could not read this
    // tick. Spawns in this set keep their prior emptyTicks/warningFired.
    const wedgeSkippedThisTick = new Set<string>()
    for (const row of rows) {
      const resolved = resolveRowPersona(deps, row)
      if (resolved.kind === 'not_applied') {
        // The spawn's requests may still be open in agent-director: exempt its
        // live entries from the closing sweep and keep its wedge state, as for
        // any other spawn not read this tick.
        nonConformingInstanceIds.add(row.claude_instance_id)
        wedgeSkippedThisTick.add(row.claude_instance_id)
        continue
      }
      if (resolved.kind === 'no_label') continue
      let persona = resolved.persona
      // A confirmed reload's step 1 may swap the applied set during any await
      // below: re-read the persona before each wedge attempt and prompt post,
      // so a prompt goes to the destination applied now. A persona gone by
      // then is skipped exactly as a row naming no applied persona is.
      const reResolve = (): boolean => {
        const current = deps.getPersona(persona.key)
        if (current) {
          persona = current
          return true
        }
        logRowNotApplied(deps, row, persona.key)
        nonConformingInstanceIds.add(row.claude_instance_id)
        wedgeSkippedThisTick.add(row.claude_instance_id)
        return false
      }
      if (!deps.isPersonaUp(persona.key)) {
        // b.av2 SR-6.4: no get, no prompt, no wedge tick for a persona that is
        // not up; its requests stay open, so hold its live entries and wedge
        // state exactly as for a spawn that could not be read this tick.
        noteNotUpSkip(deps, persona)
        nonConformingInstanceIds.add(row.claude_instance_id)
        wedgeSkippedThisTick.add(row.claude_instance_id)
        continue
      }

      let got: GetResultWithPermissionRequests
      // b.jg5 SRJ-122: this `get` (like the `list` above) is not one of
      // SRJ-114's sites, so none of the decisions of `src/row-read-rules.ts`
      // applies here: a liveness note on the row, `provenance_conflict`
      // included, and a `pending` row with no launch start (SRJ-513) latch
      // no one, and a retired key's row read live with its mark set clears
      // no retired-key entry (SRJ-807); they change nothing.
      try {
        got = (await withOutageDetection(persona.key, undefined, 'get', () =>
          client.get({ claude_instance_id: row.claude_instance_id })
        )) as unknown as GetResultWithPermissionRequests
      } catch (err) {
        // ErrSpawnNotFound is a POSITIVE observation the spawn is gone — it left
        // check_permission, so let reconcileWedgeStates re-arm it (do NOT
        // exempt). Every other error is a transient read failure: exempt the
        // spawn from re-arming so its counter survives the flaky tick.
        if (err instanceof ErrSpawnNotFound) continue
        wedgeSkippedThisTick.add(row.claude_instance_id)
        if (err instanceof ErrSystemInstallDisappeared || err instanceof ErrTmuxNotAvailable) {
          // Outage flag raised; skip per-event log.
          continue
        }
        logViaDeps(deps, `[slack] permission-poller: get failed for ${row.claude_instance_id}: ${describeAgentDirectorFailure(err)}`)
        continue
      }

      if (got.permission_requests === null || got.permission_requests === undefined) {
        logViaDeps(deps, `[slack] permission-poller: non-conforming open-rows response for ${row.claude_instance_id} — skipping`)
        nonConformingInstanceIds.add(row.claude_instance_id)
        // b.fae F4 follow-up: a non-conforming response is a read we could not
        // trust, not a positive non-wedged observation — exempt from re-arming.
        wedgeSkippedThisTick.add(row.claude_instance_id)
        // SR-V-2.3: request_token omitted (no row was readable) per SR-V-1.1.
        emitRowDecision(deps, 'non_conforming_skipped', row.claude_instance_id, undefined)
        continue
      }

      // b.fae F4: an EMPTY (but conforming) array is a spawn sitting in
      // check_permission with zero open rows — the silent-wedge signature.
      // Feed it to the detector; a non-empty array means the spawn is NOT
      // wedged, so it is intentionally excluded from wedgeObservedEmpty and
      // will be re-armed by reconcileWedgeStates below.
      if (got.permission_requests.length === 0) {
        if (!reResolve()) continue
        wedgeObservedEmpty.add(row.claude_instance_id)
        await observeWedgeCandidate(deps, row.claude_instance_id, persona)
      }

      for (const perm of got.permission_requests) {
        const key = makeCompositeKey(row.claude_instance_id, perm.request_token)
        seenComposite.add(key)
        if (livePermissions.has(key)) {
          emitRowDecision(deps, 'already_tracked', row.claude_instance_id, perm.request_token)
          continue
        }
        if (!reResolve()) break
        await dispatchPermissionPrompt(deps, row, persona, perm, key)
      }
    }

    // b.fae F4: re-arm the wedge detector for spawns no longer wedged (left
    // check_permission, gained an open row, or disappeared), but NOT for spawns
    // merely skipped by a transient read error this tick.
    // b.av2 SR-6.4: a not-up persona's wedge state and tracked prompts are
    // held even when its spawn was not listed this tick.
    const isHeld = (personaKey: string) => isHeldForNotUpPersona(deps, personaKey)
    reconcileWedgeStates(wedgeObservedEmpty, wedgeSkippedThisTick, isHeld)
    forgetUnobservedUnposted(seenComposite, wedgeSkippedThisTick)

    // SR-2.4 newly-closed reconciliation. Collect first, then reconcile —
    // avoids mutating the map while iterating it.
    const closedEntries: LivePermission[] = []
    for (const [key, entry] of livePermissions) {
      if (seenComposite.has(key)) continue
      if (nonConformingInstanceIds.has(entry.claudeInstanceId)) continue
      if (isHeld(entry.personaKey)) continue
      closedEntries.push(entry)
    }
    endNotUpSkips(deps)

    for (const entry of closedEntries) {
      let info: GetPermissionResult
      try {
        info = await withOutageDetection(entry.personaKey, undefined, 'get-permission', () =>
          getPermission(client, { request_token: entry.requestToken })
        )
      } catch (err) {
        if (err instanceof ErrSystemInstallDisappeared || err instanceof ErrTmuxNotAvailable) {
          // Outage flag raised; skip per-event log.
          continue
        }
        if (isErrPermissionRequestNotFound(err)) {
          logViaDeps(deps, `[slack] permission-poller: get-permission not-found for ${entry.claudeInstanceId} token=${entry.requestToken} — generic deny + drop`)
          emitRowDecision(deps, 'not_found_generic_deny', entry.claudeInstanceId, entry.requestToken)
          await renderClosureUpdate(deps, entry, 'not_found')
          dropPermission(entry.claudeInstanceId, entry.requestToken)
          continue
        }
        logViaDeps(deps, `[slack] permission-poller: get-permission failed for ${entry.claudeInstanceId} token=${entry.requestToken}: ${describeAgentDirectorFailure(err)}`)
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

// ---------------------------------------------------------------------------
// Not-up personas (b.av2 SR-6.4)
// ---------------------------------------------------------------------------

/** Open the persona's not-up skip episode, logging its start line once. */
function noteNotUpSkip(deps: PollerDeps, persona: Pick<Persona, 'name' | 'key'>): void {
  if (notUpSkipping.has(persona.key)) return
  notUpSkipping.add(persona.key)
  logViaDeps(
    deps,
    `[slack] permission-poller: persona ${renderPersonaRef(persona.name, persona.key)} is not up — ` +
      'skipping its rows and holding its tracked prompts until it is up',
  )
}

/**
 * Whether state kept for `personaKey` (a tracked prompt, a wedge state) is
 * held this tick: the persona is applied and not up. The skip episode is
 * opened when it is. A persona no longer applied is not held (E3's handling).
 */
function isHeldForNotUpPersona(deps: PollerDeps, personaKey: string): boolean {
  const persona = deps.getPersona(personaKey)
  if (!persona || deps.isPersonaUp(personaKey)) return false
  noteNotUpSkip(deps, persona)
  return true
}

/** Close the skip episode of every persona that is up again (or no longer applied), logging its end line once. */
function endNotUpSkips(deps: PollerDeps): void {
  for (const key of [...notUpSkipping]) {
    const persona = deps.getPersona(key)
    if (persona && !deps.isPersonaUp(key)) continue
    notUpSkipping.delete(key)
    logViaDeps(
      deps,
      persona
        ? `[slack] permission-poller: persona ${renderPersonaRef(persona.name, persona.key)} is up again — polling its rows again`
        : `[slack] permission-poller: persona=${key} is no longer applied — no longer skipping its rows`,
    )
  }
}

/** Outcome of resolving a listed row's persona. */
type RowPersona =
  | { kind: 'persona'; persona: Persona }
  | { kind: 'no_label' }
  | { kind: 'not_applied' }

/**
 * Resolve a listed row's persona from its `persona` label (b.av2 SR-7.1). A row
 * with no `persona` label (`no_label`) is logged once while it stays listed
 * (`noLabelLogged`, b.1ix), and one naming no applied persona (`not_applied`)
 * is logged; the caller skips both. The `channel` label is never read.
 */
function resolveRowPersona(deps: PollerDeps, row: ListRow): RowPersona {
  const key = row.labels[PERSONA_LABEL_KEY]
  if (!key) {
    if (!noLabelLogged.has(row.claude_instance_id)) {
      noLabelLogged.add(row.claude_instance_id)
      logViaDeps(deps, `[slack] permission-poller: spawn ${row.claude_instance_id} has no persona label — skipping`)
    }
    return { kind: 'no_label' }
  }
  const persona = deps.getPersona(key)
  if (!persona) {
    logRowNotApplied(deps, row, key)
    return { kind: 'not_applied' }
  }
  return { kind: 'persona', persona }
}

/**
 * Forget the logged no-label row of every ID this tick's list doesn't hold
 * with no `persona` label, so such a row logs again when it is next listed.
 */
function forgetUnlistedNoLabelRows(rows: ListRow[]): void {
  if (noLabelLogged.size === 0) return
  const listed = new Set(rows.filter((row) => !row.labels[PERSONA_LABEL_KEY]).map((row) => row.claude_instance_id))
  for (const id of [...noLabelLogged]) {
    if (!listed.has(id)) noLabelLogged.delete(id)
  }
}

/** Log that a listed row names no applied persona; the caller skips it. */
function logRowNotApplied(deps: PollerDeps, row: ListRow, key: string): void {
  logViaDeps(deps, `[slack] permission-poller: spawn ${row.claude_instance_id} names no applied persona (persona=${key}) — skipping`)
}

/**
 * Log once per open request and reason why its prompt was not posted. A
 * later tick with the same reason is silent; a changed reason logs again.
 */
function logUnpostedOnce(deps: PollerDeps, compositeKey: string, reason: UnpostedReason, line: string): void {
  if (unpostedPrompts.get(compositeKey) === reason) return
  unpostedPrompts.set(compositeKey, reason)
  logViaDeps(deps, line)
}

/**
 * Forget the not-posted record of every request no longer observed, except
 * for spawns that could not be read this tick (their requests may still be
 * open).
 */
function forgetUnobservedUnposted(seenComposite: Set<string>, skippedThisTick: Set<string>): void {
  for (const compositeKey of [...unpostedPrompts.keys()]) {
    if (seenComposite.has(compositeKey)) continue
    const instanceId = compositeKey.slice(0, compositeKey.indexOf('\x00'))
    if (skippedThisTick.has(instanceId)) continue
    unpostedPrompts.delete(compositeKey)
  }
}

/**
 * Route one untracked open request to the persona's destination (b.av2
 * SR-7.1). A `dm` destination the resolver would refuse (DMs off or no
 * contact; the loader rejects both) is logged once and not tracked, with no
 * Slack call. A persona whose client is unavailable is logged once and not
 * tracked, so a later tick retries it. A persona the destination hold is
 * holding (its retry not due, or in flight) gets no Slack call, no row
 * decision and no line; the prompt stays untracked for a later tick.
 * Otherwise the `post_attempted` row decision is emitted and the prompt is
 * posted through the persona's client to its destination: the channel, or
 * the DM (opened if needed).
 */
async function dispatchPermissionPrompt(
  deps: PollerDeps,
  row: ListRow,
  persona: Persona,
  permission: PermissionRequestRow,
  compositeKey: string,
): Promise<void> {
  const ref = renderPersonaRef(persona.name, persona.key)
  const refusal = dmDestinationRefusal(persona)
  if (refusal) {
    logUnpostedOnce(
      deps,
      compositeKey,
      'destination-refused',
      `[slack] permission-poller: ${ref} has permission_prompts set to "dm" but ` +
        `${describeDmDestinationRefusal(refusal)} — prompt for ${row.claude_instance_id} ` +
        `(request_token=${permission.request_token}) not posted and no DM opened`,
    )
    return
  }
  const web = deps.clientFor(persona.key)
  if (!web) {
    logUnpostedOnce(
      deps,
      compositeKey,
      'client-unavailable',
      `[slack] permission-poller: no Slack client for ${ref} — prompt for ${row.claude_instance_id} ` +
        `(request_token=${permission.request_token}) not posted; retrying on a later tick`,
    )
    return
  }
  unpostedPrompts.delete(compositeKey)
  // Built before the attempt is begun, so a row the builder rejects (it
  // throws) never takes an attempt.
  const prompt = buildPromptMessage(row, permission)
  const attempt = destinationHoldFor(deps).begin(persona.key)
  if (!attempt) return
  // The attempt always ends, even on a throw (a no-op after its post), so a
  // retrying persona is never left held with no timer.
  try {
    emitRowDecision(deps, 'post_attempted', row.claude_instance_id, permission.request_token)
    if (prompt.toolInputUnparsed) {
      logViaDeps(deps, `[slack] permission-poller: tool_input not JSON-parseable for ${row.claude_instance_id} — using raw string`)
    }
    await postPermissionPrompt(deps, attempt, web, row, persona, permission, prompt)
  } finally {
    attempt.release()
  }
}

/** A prompt's message, built before its attempt is begun. */
interface PromptMessage {
  text: string
  blocks: ReturnType<typeof buildPermissionBlocks>
  /** `tool_input` was not a JSON object string; the raw string was used (logged once the attempt is begun). */
  toolInputUnparsed: boolean
}

/**
 * Build the prompt's text and Block Kit blocks. Throws when the builder
 * rejects the row (e.g. an instance ID without the `cscb_` prefix or an empty
 * request token). Logs nothing: an unparseable `tool_input` is reported by
 * the caller only when an attempt is made, so a held persona's rows log
 * nothing per tick.
 */
function buildPromptMessage(row: ListRow, permission: PermissionRequestRow): PromptMessage {
  // tool_input is a raw JSON string per the typed contract; parse for the
  // Block Kit builder, fall back to the raw string + warning on parse fail.
  let toolInput: Record<string, unknown>
  let toolInputUnparsed = false
  try {
    const parsed = JSON.parse(permission.tool_input) as unknown
    toolInput = parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : { raw: permission.tool_input }
  } catch {
    toolInputUnparsed = true
    toolInput = { raw: permission.tool_input }
  }
  const blocks = buildPermissionBlocks(
    permission.tool_name,
    toolInput,
    row.claude_instance_id,
    permission.request_token,
  )
  return { text: `🤖🛠️ permission request: ${permission.tool_name}`, blocks, toolInputUnparsed }
}

/**
 * Post the prompt (built by `buildPromptMessage`) to the persona's
 * destination as the destination hold's `attempt` (which reports the outcome
 * to the hold; the caller releases it) and register the live
 * entry with the conversation it was posted in. Every attempt emits one
 * `cscb.chat_post.attempted`; a failed DM open emits it with `ok: false` and
 * no `channel`. A destination failure is logged by the hold, once per
 * episode; a failure of the message itself is logged here, per attempt. A
 * refusal (logged by the resolver) makes no Slack call and emits nothing.
 */
async function postPermissionPrompt(
  deps: PollerDeps,
  attempt: HoldAttempt,
  web: PollerSlackClient,
  row: ListRow,
  persona: Persona,
  permission: PermissionRequestRow,
  prompt: PromptMessage,
): Promise<void> {
  const { text, blocks } = prompt
  const emit = deps.emitTrail ?? defaultEmitTrail
  const result = await attempt.post(persona, web, { text, blocks })
  if (result.outcome === 'refused') return
  if (result.outcome === 'failed') {
    // b.emk: failures land in BOTH server.log (real-time visibility) AND the
    // trail JSONL (after-the-fact debugging). Success paths stay trail-only,
    // preserving the SR-V-2.4 asymmetric-behavior fix. A destination failure
    // reaches server.log as the hold's episode line (b.av2 SR-7.1), so a
    // held persona's retries don't log one line each.
    if (!isDestinationFailure(result)) {
      logViaDeps(
        deps,
        `[slack] permission-poller: ${result.step} failed for ${row.claude_instance_id}${describeDestinationFailure(result)}`,
      )
    }
    const event: Omit<TrailEventBase, 'ts'> & { [extra: string]: unknown } = {
      event: 'cscb.chat_post.attempted',
      claude_instance_id: row.claude_instance_id,
      request_token: permission.request_token,
      text,
      blocks,
      ok: false,
      error: safeFailureCode(result.code),
    }
    if (result.channelId !== undefined) event.channel = result.channelId
    emit(event)
    return
  }
  const channelId = result.channelId
  const messageTs = result.ts
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
    personaKey: persona.key,
    channelId,
    messageTs,
    requestId: permission.request_id,
    handled: false,
  })
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
 * against this entry's messageTs, through the client of the persona that
 * posted it: a prompt stays where it was posted. The destination is never
 * resolved again and the DMs switch is not read: a DM prompt is updated in
 * its `D…` conversation even after DMs were turned off (b.av2 SR-5.1: an
 * update is not a post), and no `conversations.open` is made. Sibling-independent by
 * construction: the call only ever names `entry.channelId` +
 * `entry.messageTs` (SR-5.3). When that persona's client is unavailable, one
 * line is logged and no update is made (the caller still drops the entry:
 * agent-director has already closed the request).
 */
async function renderClosureUpdate(
  deps: PollerDeps,
  entry: LivePermission,
  tag: VerdictTag,
): Promise<void> {
  const web = deps.clientFor(entry.personaKey)
  if (!web) {
    const persona = deps.getPersona(entry.personaKey)
    const ref = persona ? renderPersonaRef(persona.name, persona.key) : `persona=${entry.personaKey}`
    logViaDeps(
      deps,
      `[slack] permission-poller: no Slack client for ${ref} — closure update for ` +
        `${entry.claudeInstanceId} token=${entry.requestToken} (verdict=${tag}) skipped`,
    )
    return
  }
  const { text, blocks } = buildVerdictRendering(tag)
  const emit = deps.emitTrail ?? defaultEmitTrail
  const envelope = {
    event: 'cscb.chat_update.attempted',
    claude_instance_id: entry.claudeInstanceId,
    request_token: entry.requestToken,
    channel: entry.channelId,
    message_ts: entry.messageTs,
    text,
    blocks,
    verdict_tag: tag as ClosureVerdictTag,
    triggered_by: 'poller' as const,
  }
  try {
    await web.chat.update({
      channel: entry.channelId,
      ts: entry.messageTs,
      text,
      blocks: blocks as never,
    })
    emit({ ...envelope, ok: true })
  } catch (err) {
    // b.emk: failures land in BOTH server.log and the trail JSONL.
    logViaDeps(
      deps,
      `[slack] permission-poller: closure chat.update failed for ${entry.claudeInstanceId} token=${entry.requestToken} ` +
        `(verdict=${tag})${describeSlackCallFailure(err)}`,
    )
    emit({ ...envelope, ok: false, error: classifySlackError(err) })
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
    // Fire-and-forget. runTick catches agent-director read failures, but it
    // has no catch around a row: a row the prompt builder rejects (an instance
    // ID without the `cscb_` prefix, or an empty `request_token`), or a
    // throwing injected `emitTrail` or `log`, ends the tick at that row. Later
    // rows, the wedge re-arm and the closed-request check are skipped for that
    // tick, and this promise rejects (in production the server's
    // `unhandledRejection` handler logs it). The tick's `finally` still clears
    // the in-flight flag, and any hold attempt begun is released, so the next
    // tick runs as usual.
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
