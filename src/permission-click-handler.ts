/**
 * permission-click-handler.ts — Block Kit decision relay.
 *
 * Consumes Socket Mode interactive events whose `action_id` matches
 * `perm_(allow|deny)_<claude_instance_id>_<request_token>`. The handler is
 * a small, single-AD-call function: it parses the action_id, calls AD's
 * `decide` (always carrying `request_token`), and — when a live entry is
 * still present — renders the operator-decide verdict against just that
 * row's Slack message.
 *
 * Stale clicks (entry absent from the pending map) still hit AD so that
 * AD remains the source of truth; the next poller tick reconciles the
 * Slack rendering. `ErrAlreadyDecided` is the canonical race sentinel and
 * is swallowed silently for the same reason.
 *
 * `ErrRelayFallenBack` (AD 0.10.0) is the other end of that race: the
 * request's relay window elapsed, Claude fell back to its own tmux pane, and
 * AD refuses the verdict. The session is healthy, so the handler neither
 * retries nor touches the session — it repaints the prompt message to say the
 * answer must now be given at the pane (b.qi1).
 *
 * Clicks resolve through the receiving persona (b.av2 SR-7.1): the persona
 * whose connection received the click. Its key keys the outage state around
 * `decide`, and the verdict update and the relay-fallen-back repaint go
 * through its client, to the channel and `ts` recorded on the live entry. A
 * click whose receiving persona cannot be resolved is logged and bypassed;
 * one whose instance ID is not `cscb_<receiving key>` is logged and neither
 * decided nor updated (fail closed).
 *
 * A prompt posted in a DM is handled the same way: the recorded conversation
 * is its `D…` ID, and the persona comes from the receiving connection, never
 * from a channel lookup. Nothing here reads the persona's current destination
 * or DMs switch, so a DM prompt stays answerable after DMs were turned off
 * (b.av2 SR-5.1: an update is not a post). The click path never posts and
 * never calls `conversations.open`.
 *
 * SPDX-License-Identifier: MIT
 */

import type { WebClient } from '@slack/web-api'

import { decideWithToken } from './agent-director-client.ts'
import {
  AgentDirectorError,
  ErrAlreadyDecided,
  ErrRelayFallenBack,
  ErrSystemInstallDisappeared,
  ErrTmuxNotAvailable,
} from './agent-director-errors.ts'
import type { Persona } from './config.ts'
import { withOutageDetection } from './outage-state.ts'
import { parsePermissionActionId, type PermissionDecision } from './permission-action-id.ts'
import { describeSlackCallFailure } from './persona-connection-errors.ts'
import { classifySlackError } from './persona-destination.ts'
import { personaInstanceId, renderPersonaRef } from './persona-identity.ts'
import { getLivePermission, markHandled } from './permission-poller.ts'
import { emitTrail as defaultEmitTrail } from './permission-trail.ts'
import type {
  AdDecideResponseClass,
  ClosureVerdictTag,
  ParseFailureReason,
  TrailEventBase,
} from './permission-trail.ts'

export interface ClickDeps {
  /**
   * Key of the persona whose connection received the click; undefined when
   * it is not known.
   */
  receivingPersonaKey?: string
  /**
   * The persona's chat-capable Slack client, or undefined when it is not
   * available (not validated yet, dry run, unknown key).
   */
  clientFor: (key: string) => Pick<WebClient, 'chat'> | undefined
  /** The applied persona with this key, or undefined. */
  getPersona: (key: string) => Persona | undefined
  log?: (...args: unknown[]) => void
  /**
   * Trail emitter hook (SR-V). Defaults to `emitTrail` from
   * `permission-trail.ts`. Tests override with a capture stub.
   */
  emitTrail?: (
    partial: Omit<TrailEventBase, 'ts'> & { [extra: string]: unknown },
  ) => void
}

function logDeps(deps: ClickDeps, ...args: unknown[]): void {
  if (deps.log) deps.log(...args)
  else console.error(...args)
}

/**
 * SR-V-2.7 call-side classification of an agent-director `decide` error.
 * Mirrors the existing branches in `handlePermissionClick`'s catch so the
 * trail's `result_class` is identical to the operational discriminator.
 */
function classifyAdDecideError(err: unknown): AdDecideResponseClass {
  if (err instanceof ErrAlreadyDecided) return 'ErrAlreadyDecided'
  if (err instanceof ErrRelayFallenBack) return 'ErrRelayFallenBack'
  if (err instanceof AgentDirectorError && err.errName === 'ErrInvalidFlags') return 'ErrInvalidFlags'
  if (err instanceof AgentDirectorError && err.errName === 'ErrAmbiguousRequest') return 'ErrAmbiguousRequest'
  return 'other'
}

// Match the poller's SR-2.4 terminal verdict text exactly so the click-handler
// render and the next-tick reconciliation render are byte-identical — no
// visible flicker.
function buildDecisionBlocks(decision: PermissionDecision): unknown[] {
  const text = decision === 'allow'
    ? '*Permission* — Allowed'
    : '*Permission* — Denied by operator'
  return [
    {
      type: 'section',
      text: { type: 'mrkdwn', text },
    },
  ]
}

/**
 * b.qi1 — message body for a click AD refused with `ErrRelayFallenBack`. The
 * request's relay window elapsed before the click landed, so Claude already
 * fell back to asking at its own tmux pane and AD will not record a verdict
 * nothing would read. The session is alive and unharmed; only THIS prompt is
 * no longer answerable from Slack, so the rendering strips the now-inert
 * buttons and says where the answer has to be given instead.
 */
const RELAY_FALLEN_BACK_TEXT =
  '*Permission* — relay window elapsed; answer this prompt at the session\'s tmux pane'

function buildRelayFallenBackBlocks(): unknown[] {
  return [
    {
      type: 'section',
      text: { type: 'mrkdwn', text: RELAY_FALLEN_BACK_TEXT },
    },
  ]
}

/**
 * Render a terminal state over a live prompt's Slack message through the
 * receiving persona's client and emit the SR-V-2.5
 * `cscb.chat_update.attempted` event. Returns true when Slack accepted the
 * update. When the persona's client is unavailable, logs one line and makes
 * no update (decide has already happened; the next poller tick reconciles
 * the rendering) and returns false.
 */
async function renderPromptUpdate(
  deps: ClickDeps,
  emit: (partial: Omit<TrailEventBase, 'ts'> & { [extra: string]: unknown }) => void,
  persona: Persona,
  entry: { claudeInstanceId: string; requestToken: string; channelId: string; messageTs: string },
  text: string,
  blocks: unknown[],
  verdictTag: ClosureVerdictTag,
): Promise<boolean> {
  const web = deps.clientFor(persona.key)
  if (!web) {
    logDeps(
      deps,
      `[slack] permission-click: no Slack client for ${renderPersonaRef(persona.name, persona.key)} — ` +
        `update for ${entry.claudeInstanceId} (request_token=${entry.requestToken}, verdict=${verdictTag}) ` +
        'skipped; the next poller tick reconciles the rendering',
    )
    return false
  }
  const envelope = {
    event: 'cscb.chat_update.attempted',
    claude_instance_id: entry.claudeInstanceId,
    request_token: entry.requestToken,
    channel: entry.channelId,
    message_ts: entry.messageTs,
    text,
    blocks,
    verdict_tag: verdictTag,
    triggered_by: 'click_handler' as const,
  }
  try {
    await web.chat.update({
      channel: entry.channelId,
      ts: entry.messageTs,
      text,
      blocks: blocks as never,
    })
    emit({ ...envelope, ok: true })
    return true
  } catch (err) {
    // b.emk: failures land in BOTH server.log and the trail JSONL.
    logDeps(
      deps,
      `[slack] permission-click: decision chat.update failed for ${entry.claudeInstanceId}${describeSlackCallFailure(err)}`,
    )
    emit({ ...envelope, ok: false, error: classifySlackError(err) })
    return false
  }
}

/**
 * Inbound context captured from the Socket Mode interactive payload. Used by
 * the SR-V-2.6 `cscb.click_handler.invoked` event so investigations can
 * pivot by clicking user or by the Slack message being clicked against.
 * Optional so unit-test call sites can omit it; the trail event records the
 * fields as undefined/missing when not supplied (open envelope per SR-V-1).
 */
export interface ClickInteractionContext {
  /** Inbound Slack channel id from the interactive payload. */
  channel?: string
  /** The clicked-message ts from the interactive payload. */
  messageTs?: string
  /** Clicking user's Slack id from the interactive payload. */
  user?: string
}

/**
 * Handle a permission Block Kit click. Returns true when the action_id was a
 * valid permission decision (the caller has already ack'd); false when the
 * action_id did not match the expected shape (caller should keep looking).
 * Parsing comes first: an action_id that does not parse returns false before
 * the receiving persona is resolved.
 */
export async function handlePermissionClick(
  actionId: string,
  deps: ClickDeps,
  context: ClickInteractionContext = {},
): Promise<boolean> {
  const parsed = parsePermissionActionId(actionId)
  if (parsed === null) return false

  const { decision, claudeInstanceId, requestToken } = parsed
  const emit = deps.emitTrail ?? defaultEmitTrail
  // SR-V-2.6: live_pending captures the click-time state. Read the entry
  // here so the trail event records the value at handler entry, before any
  // markHandled / drop later in this function (or in the next tick) mutates
  // the map.
  const earlyEntry = getLivePermission(claudeInstanceId, requestToken)
  emit({
    event: 'cscb.click_handler.invoked',
    claude_instance_id: claudeInstanceId,
    request_token: requestToken,
    channel: context.channel ?? earlyEntry?.channelId,
    message_ts: context.messageTs ?? earlyEntry?.messageTs,
    user: context.user,
    raw_action_id: actionId,
    decision,
    live_pending: earlyEntry !== undefined,
  })

  const receivingKey = deps.receivingPersonaKey
  const persona = receivingKey === undefined ? undefined : deps.getPersona(receivingKey)
  if (!persona) {
    logDeps(
      deps,
      `[slack] permission-click-handler: cannot resolve the receiving persona ` +
        `(receiving key=${receivingKey ?? 'undefined'}, ` +
        `claude_instance_id=${claudeInstanceId}, ` +
        `action_id=${actionId}, ` +
        `request_token=${requestToken}) ` +
        `— logging and bypassing this click. This is a CSCB bug — investigate.`,
    )
    return true
  }

  // Fail closed: a button built for another persona's instance is never
  // decided or updated through this persona. The request stays open and
  // times out on agent-director's side.
  const expectedInstanceId = personaInstanceId(persona.key)
  if (claudeInstanceId !== expectedInstanceId) {
    logDeps(
      deps,
      `[slack] permission-click-handler: click for ${claudeInstanceId} received for ` +
        `${renderPersonaRef(persona.name, persona.key)} (instance ${expectedInstanceId}) — ` +
        `not deciding (request_token=${requestToken})`,
    )
    return true
  }

  // SR-4.1, SR-4.2, SR-7.2: AD is the source of truth. Always call decide
  // with the decoded request_token — including for stale clicks whose
  // composite key is no longer in the pending map. This is the click's ONLY
  // AD interaction (SR-4.3 retires the pre-decide get).
  const decideEnvelope = {
    event: 'cscb.ad_decide.attempted',
    claude_instance_id: claudeInstanceId,
    request_token: requestToken,
    decision,
  }
  try {
    await withOutageDetection(persona.key, undefined, (client) =>
      decideWithToken(client, {
        claude_instance_id: claudeInstanceId,
        decision,
        request_token: requestToken,
      }),
    )
    // SR-V-2.7 call-side success emission.
    emit({ ...decideEnvelope, result_class: 'ok' satisfies AdDecideResponseClass })
  } catch (err) {
    if (err instanceof ErrSystemInstallDisappeared || err instanceof ErrTmuxNotAvailable) {
      // SR-V-2.7 ad/tmux carve-out: the wrapper already raised the outage
      // flag (one Slack onset alert via the state machine). Forensic
      // requirement: the trail JSONL must still carry the typed error name
      // and message so post-incident debugging can correlate the click
      // attempt with the AD-down cause — the loud Slack alert tells the
      // operator something is broken; the trail entry tells the engineer
      // what was actually thrown.
      const result_class: AdDecideResponseClass = err.errName as AdDecideResponseClass
      const raw_error_message = err.message
      emit({ ...decideEnvelope, result_class, raw_error_message })
      return true
    }
    // SR-V-2.7 call-side failure emission. Classify against the same AD
    // error names the existing branches discriminate on so the trail's
    // result_class stays consistent with src/agent-director-errors.ts. The
    // existing logDeps operational logging is preserved alongside the
    // canonical trail event — the two serve different purposes (live
    // stderr vs after-the-fact debugging).
    const result_class: AdDecideResponseClass = classifyAdDecideError(err)
    const emission: Omit<TrailEventBase, 'ts'> & { [extra: string]: unknown } = {
      ...decideEnvelope,
      result_class,
    }
    if (result_class === 'other') {
      const raw = err instanceof Error ? err.message : String(err)
      emission['raw_error_message'] = raw
    }
    emit(emission)

    // SR-4.4: ErrAlreadyDecided is silently swallowed — the next poller tick
    // reconciles the operator-visible Slack rendering via SR-2.4 / SR-5.
    if (err instanceof ErrAlreadyDecided) return true
    // b.qi1: the relay window for this request elapsed before the click landed.
    // AD refuses the verdict because Claude has already fallen back to asking
    // at its own tmux pane. Nothing is broken and nothing is retryable here —
    // re-deciding would fail identically, and killing or respawning the session
    // would destroy a healthy session over one un-relayed prompt. The only
    // useful action is to tell the operator loudly that their click did NOT
    // land and where the prompt now lives.
    if (err instanceof ErrRelayFallenBack) {
      logDeps(
        deps,
        `[slack] permission-click: ErrRelayFallenBack from decide for ${claudeInstanceId} ` +
          `(request_token=${requestToken}) — relay window elapsed; the prompt must be ` +
          `answered at the session's tmux pane`,
      )
      const staleEntry = getLivePermission(claudeInstanceId, requestToken)
      if (staleEntry) {
        // Deliberately no markHandled(): this is not a verdict. The request row
        // stays open on AD's side, so a later poller closure (timeout /
        // find_missing / a pane answer) must still be free to render over it.
        await renderPromptUpdate(
          deps,
          emit,
          persona,
          staleEntry,
          RELAY_FALLEN_BACK_TEXT,
          buildRelayFallenBackBlocks(),
          'click_handler_relay_fallen_back',
        )
      }
      return true
    }
    if (err instanceof AgentDirectorError && err.errName === 'ErrInvalidFlags') {
      logDeps(deps, `[slack] permission-click: ErrInvalidFlags from decide for ${claudeInstanceId} (request_token=${requestToken})`)
      return true
    }
    // ErrAmbiguousRequest is a defense-in-depth backstop per SR-4.4; under
    // contract it should be unreachable.
    if (err instanceof AgentDirectorError && err.errName === 'ErrAmbiguousRequest') {
      logDeps(deps, `[slack] permission-click: ErrAmbiguousRequest from decide for ${claudeInstanceId} (request_token=${requestToken})`)
      return true
    }
    const e = err instanceof AgentDirectorError ? err : null
    logDeps(deps, `[slack] permission-click: decide failed for ${claudeInstanceId}: ${e?.errName ?? String(err)}`)
    return true
  }

  // SR-4.2 stale-click semantics: decide already fired; no live entry means
  // nothing to render against here. (The poller's reconciliation tick will
  // surface the closure on whichever Slack message currently tracks it.)
  const entry = getLivePermission(claudeInstanceId, requestToken)
  if (!entry) return true

  // SR-4.5 sibling independence: target only this row's messageTs.
  const text = decision === 'allow'
    ? '*Permission* — Allowed'
    : '*Permission* — Denied by operator'
  const blocks = buildDecisionBlocks(decision)
  const verdictTag: ClosureVerdictTag = decision === 'allow'
    ? 'click_handler_allow'
    : 'click_handler_deny'
  const ok = await renderPromptUpdate(deps, emit, persona, entry, text, blocks, verdictTag)
  if (ok) markHandled(claudeInstanceId, requestToken)
  return true
}

// ---------------------------------------------------------------------------
// SR-V-2.9 inbound block_actions emission
// ---------------------------------------------------------------------------

/**
 * Classify a `block_actions` action_id for the SR-V-2.9 trail event without
 * mutating state. Exported so `src/server.ts`'s `socket.on('interactive')`
 * handler stays a thin wiring layer and so this branch can be unit-tested
 * in isolation (server.ts has module-load side effects and is not directly
 * importable from tests).
 *
 * The decision split is intentional: a `perm_(allow|deny)_*` prefix
 * indicates a CSCB permission button whose body failed to parse
 * (`malformed_token`); anything else is foreign (`foreign_action_id`). Note
 * that `stale_prompt` is NOT a parse-failure reason here — a stale click
 * decodes fine and shows up as `cscb.click_handler.invoked{live_pending:false}`.
 */
const PERMISSION_BUTTON_PREFIX_RE = /^perm_(allow|deny)_/

export interface BlockActionTrailContext {
  /** Inbound Slack channel id from the interactive payload. */
  channel?: string
  /** Clicked message ts from the interactive payload. */
  messageTs?: string
  /** Clicking user's Slack id. */
  user?: string
}

/**
 * Emit one `cscb.block_action.received` event for an inbound `block_actions`
 * action_id. Called once per action in the payload's `actions` array,
 * regardless of whether the action_id decodes (SR-V-2.9 — the
 * decode-failure case is the diagnostically critical surface for
 * "I clicked Allow and nothing happened").
 */
export function emitBlockActionReceived(
  actionId: string,
  context: BlockActionTrailContext,
  emit: (
    partial: Omit<TrailEventBase, 'ts'> & { [extra: string]: unknown },
  ) => void = defaultEmitTrail,
): void {
  const parsed = parsePermissionActionId(actionId)
  const base = {
    event: 'cscb.block_action.received',
    channel: context.channel,
    message_ts: context.messageTs,
    user: context.user,
    raw_action_id: actionId,
  }
  if (parsed !== null) {
    emit({
      ...base,
      claude_instance_id: parsed.claudeInstanceId,
      request_token: parsed.requestToken,
      decision: parsed.decision,
    })
    return
  }
  const reason: ParseFailureReason = PERMISSION_BUTTON_PREFIX_RE.test(actionId)
    ? 'malformed_token'
    : 'foreign_action_id'
  emit({ ...base, parse_failure_reason: reason })
}
