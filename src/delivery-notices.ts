/** Delivery reporting consumes durable facts and never authorizes keys. */
import type { QueueEvent, QueueItem, DeliveryQueue, AcceptedRecord } from './delivery-queue.ts'
import type { DeliveryEngineEvent, DeliveryReason, DeliveryStatus } from './delivery-engine.ts'
import type { PersonaEpisodes } from './persona-episodes.ts'
import { CONFLICT_NOTICE_HUMAN_ONLY_LINE } from './conflict-latch.ts'
import { DELIVERY_STUCK_AFTER_MS } from './delivery-constants.ts'
import { escapeSlackControlCharacters } from './slack-text-escape.ts'
import { redactSlackLogText } from './slack-log-redaction.ts'
import { renderPersonaRef } from './persona-identity.ts'
import { MESSAGE_NOT_SAVED, MESSAGE_RECEIVED, MESSAGE_DELIVERED, MESSAGE_RETYPED, MESSAGE_NOT_TAKEN_IN, DELIVERY_STUCK, QUEUE_RECORD_UNREADABLE, QUEUE_UNWRITABLE, QUEUE_KEPT, OWN_POST_NOT_ENROLLED, ROOT_LOOKUP_CAPABILITY_MISSING, PARTICIPATION_RECOVERY, deliveryIdentity, buildDeliveryDiagnostic, queueErrorCode, type DeliveryDiagnosticClass } from './persona-diagnostics.ts'
import { PERSONA_EPISODE_KIND_OWN_POST_NOT_ENROLLED, PERSONA_EPISODE_KIND_ROOT_LOOKUP_CAPABILITY } from './persona-episodes.ts'
import type { OwnPostOutcome } from './thread-participation.ts'
import { capabilityGapHoldsLookups, type RootLookupCapabilityGap } from './participation-channel-evidence.ts'
import type { ParticipationRecoveryCause, ParticipationRecoveryFinding } from './participation-recovery.ts'

export { DELIVERY_DIAGNOSTIC_CLASSES, MESSAGE_NOT_SAVED, MESSAGE_RECEIVED, MESSAGE_DELIVERED, MESSAGE_RETYPED, MESSAGE_NOT_TAKEN_IN, DELIVERY_STUCK, MESSAGES_WAITING, QUEUE_RECORD_UNREADABLE, QUEUE_UNWRITABLE, QUEUE_KEPT, SYSTEM_PROMPT_UNWRITABLE, OWN_POST_NOT_ENROLLED, ROOT_LOOKUP_CAPABILITY_MISSING, PARTICIPATION_RECOVERY, deliveryIdentity, buildDeliveryDiagnostic, queueErrorCode } from './persona-diagnostics.ts'
const safe = (text: string): string => redactSlackLogText(text).replace(/[\r\n]/g, ' ')
const slack = (text: string): string => escapeSlackControlCharacters(safe(text))
export function deliveryAge(ageMs: number): string {
  const seconds = Math.max(0, Math.floor(ageMs / 1000))
  return seconds < 60 ? `${seconds}s` : seconds < 3600 ? `${Math.floor(seconds / 60)}m` : `${Math.floor(seconds / 3600)}h ${Math.floor(seconds % 3600 / 60)}m`
}
/** The one permitted dispatch excerpt, at first actual Slack typing. */
export function buildDeliveryDispatchLine(persona: string, accepted: AcceptedRecord): string {
  return `[slack] dispatch: persona=${safe(persona)} ${deliveryIdentity(accepted)} text=${JSON.stringify(safe(accepted.text.slice(0, 80)))}`
}
export function buildMessageNotSavedNotice(persona: string, sender: string): string {
  return `:warning: *Message not saved* — a message from ${slack(sender)} for ${slack(persona)} could not be saved. Slack will send it again a few times; it is delivered if one copy is saved, otherwise it is lost and should be sent again. Further messages to this persona may fail the same way until storing works; server.log counts them. Check the server's disk.`
}
export type DeliveryStuckReason = 'relay-off' | 'mcp' | 'refused' | 'transcript' | 'queue-unwritable' | 'not-taken-in' | 'dialog-hold'
export function deliveryStuckRemedy(reason: DeliveryStuckReason, key: string, count: number): string {
  const attach = `\`tmux attach -t =slack_bot_${key}\``
  switch (reason) {
    case 'relay-off': return `Its permission relay is off. Restart the persona's bot.`
    case 'mcp': return `It is not connected to this server over MCP. Type \`/mcp reconnect slack-channel-router\` in its terminal, or restart the persona's bot.`
    case 'refused': return `agent-director keeps refusing to type into it. Check its state with \`agent-director get --instance-id cscb_${key}\`.`
    case 'transcript': return `Its transcript can't be read, so CSCB can't confirm delivery and keeps offering the message. Check that the transcript exists and that the server's user can read it.`
    case 'queue-unwritable': return `CSCB can't write its queue file, so it types nothing more for this persona until it can. Check the server's disk.`
    case 'not-taken-in': return `It doesn't take the message in: CSCB has typed it ${count} times and keeps offering it. Attach with ${attach} to see why, or restart the persona's bot.`
    case 'dialog-hold': return `agent-director won't type into it until it can prove an answered permission prompt is gone; a subagent's denied prompt stays held until the bot ends. Restart the persona's bot.`
  }
}
export function buildDeliveryStuckNotice(persona: string, key: string, count: number, ageMs: number, reason: DeliveryStuckReason, typedCount: number): string {
  return `:warning: *Delivery stuck* — ${count} message(s) for ${slack(persona)} are waiting; the oldest has waited ${deliveryAge(ageMs)}. ${deliveryStuckRemedy(reason, key, typedCount)} ${CONFLICT_NOTICE_HUMAN_ONLY_LINE}`
}
export function buildMessageNotTakenInNotice(persona: string, sender: string): string {
  return `:warning: *Message not taken in* — the message from ${slack(sender)} for ${slack(persona)} is still queued. CSCB keeps offering it (again at least every 15 minutes while it can type it) until the bot's transcript shows it. Later messages for this persona wait behind it. The bot may see it more than once.`
}
export const MESSAGES_WAITING_STATES = ['down', 'down at its restart limit', 'down with automatic restarts off', 'latched', 'held on invalid flags', 'held after a failed kill', 'waiting on an old life', 'waiting for its upgrade replacement'] as const
export type MessagesWaitingState = typeof MESSAGES_WAITING_STATES[number]
export interface DeliveryReportState {
  up: boolean; latched?: boolean; invalidFlags?: boolean; killFailed?: boolean; oldLife?: boolean; upgrade?: boolean
  atRestartLimit?: boolean; restartsOff?: boolean; outage?: boolean; prompt?: boolean; launch?: boolean
}
export function messagesWaitingState(status: DeliveryStatus, state: DeliveryReportState): MessagesWaitingState | undefined {
  if (!state.up) return undefined
  if (state.latched || status.latched) return 'latched'
  if (state.invalidFlags) return 'held on invalid flags'
  if (state.killFailed) return 'held after a failed kill'
  if (state.oldLife) return 'waiting on an old life'
  if (state.upgrade) return 'waiting for its upgrade replacement'
  if (status.row !== 'ended' && status.row !== 'missing' && status.row !== 'absent') return undefined
  return state.atRestartLimit ? 'down at its restart limit' : state.restartsOff ? 'down with automatic restarts off' : 'down'
}
export function buildMessagesWaitingNotice(persona: string, count: number, ageMs: number, state: MessagesWaitingState): string {
  return `:warning: *Messages waiting* — ${count} message(s) for ${slack(persona)} are waiting; the oldest has waited ${deliveryAge(ageMs)}. The persona is ${state}. The messages are kept and delivered once the persona is up.`
}
export function buildQueueRecordUnreadableNotice(persona: string, count: number, path: string): string {
  return `:warning: *Queue record unreadable* — ${count} queued message(s) for ${slack(persona)} could not be read at start and will not be delivered. Their bytes are kept in \`${slack(path)}\`. Ask the senders to send them again.`
}
/** What a confirmed own post's participation still lacks, in operator terms. */
export const OWN_POST_FINDING_CAUSES = ['storage', 'root-metadata', 'channel-eligibility', 'operation'] as const
export type OwnPostFindingCause = typeof OWN_POST_FINDING_CAUSES[number]
/** The own-post fields a finding's line or notice may name: identifiers only, never a body or error text. */
export type OwnPostFinding = Pick<OwnPostOutcome, 'kind' | 'surface' | 'operation' | 'part' | 'channel' | 'ts' | 'parent' | 'root' | 'file' | 'delivery' | 'missing' | 'reason' | 'error'>
/** Distinct finding lines logged per persona before further ones are only counted by the episode. */
export const OWN_POST_FINDINGS_LOGGED_PER_PERSONA = 20
export function ownPostFindingCause(finding: Pick<OwnPostOutcome, 'kind' | 'missing' | 'reason'>): OwnPostFindingCause {
  if (finding.kind === 'gap') return finding.reason === 'storage' ? 'storage' : finding.reason === 'eligibility-unavailable' ? 'channel-eligibility' : 'operation'
  // A failed write over durable pending evidence is a storage fault, whatever the evidence still lacks.
  if (finding.reason === 'storage') return 'storage'
  if (finding.reason === 'operation') return 'operation'
  return finding.missing.includes('root') ? 'root-metadata' : 'channel-eligibility'
}
/**
 * Whether new-mention guidance applies: the finding names its thread (its
 * root, or a parent or ts while the root is not missing) and records the
 * channel's applied choice, which is not `off`, where a mention is not
 * delivered and enrolls nothing. An unknown choice may be `off`.
 */
export function ownPostMentionApplies(finding: Pick<OwnPostOutcome, 'root' | 'parent' | 'ts' | 'missing' | 'delivery'>): boolean {
  const thread = finding.root ?? (finding.missing.includes('root') ? undefined : finding.parent ?? finding.ts)
  return thread !== undefined && finding.delivery !== undefined && finding.delivery !== 'off'
}
/** Corrective action per cause. `mention`: add the new-mention guidance (`ownPostMentionApplies`). */
export function ownPostFindingAction(cause: OwnPostFindingCause, gap: boolean, mention = true): string {
  const follow = mention
    ? ` A new mention of the persona in that thread can also make it follow the thread${cause === 'storage' ? ', once the server can save its state again' : ''}.`
    : ''
  if (gap) {
    // A storage gap is in-process evidence recovery saves again; it is no longer listed after a restart.
    if (cause === 'storage') return `Check the server's disk and state directory. CSCB saves the post's evidence again while the server runs, once it can save its state and the persona is up; a restart before then loses it.${follow}`
    return `Check that the persona is applied and up. CSCB cannot rebuild a record it never saved: restore the server's state only from a reviewed, trustworthy backup, or accept that the persona does not follow the thread.${follow}`
  }
  const waits = cause === 'root-metadata' ? "the thread's root message is known"
    : cause === 'channel-eligibility' ? "the persona's channel membership and the channel's sharing are verified"
      : cause === 'storage' ? 'the server can save its state again, retrying while idle'
        : 'the post is bound to the persona again'
  return `CSCB keeps the evidence and follows the thread once ${waits}.${follow}`
}
const ownPostIdentity = (f: OwnPostFinding): string =>
  `surface=${f.surface} chat_id=${JSON.stringify(f.channel)}${f.ts ? ` ts=${JSON.stringify(f.ts)}` : ''}${f.parent ? ` parent=${JSON.stringify(f.parent)}` : ''}` +
  `${f.file ? ` file=${JSON.stringify(f.file)}` : ''} operation=${f.operation} part=${f.part}`
/** The `own-post-not-enrolled` line: state, the exact missing evidence, cause and action; never the post's text. */
export function buildOwnPostNotEnrolledLine(persona: string, finding: OwnPostFinding): string {
  const cause = ownPostFindingCause(finding), gap = finding.kind === 'gap'
  return buildDeliveryDiagnostic(OWN_POST_NOT_ENROLLED, persona, ownPostIdentity(finding),
    `state=${gap ? 'gap' : 'pending'} missing=${finding.missing.length ? finding.missing.join(',') : 'none'} cause=${cause}` +
    `${finding.reason ? ` reason=${finding.reason}` : ''}${finding.error !== undefined ? ` code=${queueErrorCode(finding.error)}` : ''}` +
    ` action=${JSON.stringify(ownPostFindingAction(cause, gap, ownPostMentionApplies(finding)))}`)
}
/** The once-per-persona line when its finding lines reach the cap. */
export function buildOwnPostFindingsCappedLine(persona: string): string {
  return buildDeliveryDiagnostic(OWN_POST_NOT_ENROLLED, persona, `limit=${OWN_POST_FINDINGS_LOGGED_PER_PERSONA}`, 'further findings are not logged until this persona has none')
}
/** Outcomes seen before reporting started and over its buffer: not kept, so never logged one by one. */
export function buildOwnPostOutcomesDroppedLine(persona: string, count: number): string {
  return buildDeliveryDiagnostic(OWN_POST_NOT_ENROLLED, persona, `dropped=${count}`,
    'outcomes seen before reporting started were not kept; recorded evidence is still reported and recovered')
}
const OWN_POST_CAUSE_TEXT: Readonly<Record<OwnPostFindingCause, string>> = {
  'storage': "its state couldn't be saved",
  'root-metadata': "the thread's root message isn't known",
  'channel-eligibility': "its channel membership and the channel's sharing aren't verified",
  'operation': "the post couldn't be bound to the persona's current life",
}
/** The Slack notice for a persona's first own-post finding in an episode. */
export function buildOwnPostNotEnrolledNotice(persona: string, finding: OwnPostFinding): string {
  const cause = ownPostFindingCause(finding), gap = finding.kind === 'gap'
  const where = `channel ${slack(finding.channel)}${finding.ts ? ` (message ${slack(finding.ts)})` : finding.file ? ` (file ${slack(finding.file)})` : ''}`
  const head = gap
    ? `:warning: *Thread participation not saved* — ${slack(persona)} posted in ${where}, but CSCB could not save that it follows that thread: ${OWN_POST_CAUSE_TEXT[cause]}.`
    : `:warning: *Thread not followed yet* — ${slack(persona)} posted in ${where}, but CSCB can't record yet that it follows that thread: ${OWN_POST_CAUSE_TEXT[cause]}.`
  return `${head} The post itself succeeded; don't post it again. Replies in that thread may not reach the persona until this resolves. ${ownPostFindingAction(cause, gap, ownPostMentionApplies(finding))}`
}
/** What the operator does about a root-lookup capability gap. */
export function rootLookupCapabilityAction(gap: RootLookupCapabilityGap): string {
  if (gap.kind === 'method-refused') return "Check that the persona's bot token is a bot token of an app installed with the manifest's history scopes, and reinstall the app if it is. While replies are waiting, CSCB tries one thread lookup again about once a minute, so no restart is needed after the reinstall."
  const fix = `Add the missing bot scope(s) ${gap.scopes.join(', ')} to the persona's Slack app (the shipped manifest lists them), reinstall the app, and update the persona's bot token if Slack issued a new one.`
  return capabilityGapHoldsLookups(gap)
    ? `${fix} While replies are waiting, CSCB re-checks the token's scopes about once a minute, so no restart is needed after the reinstall.`
    : `${fix} No reply waits on this scope, so CSCB checks it again only when the persona's token is next validated (for example at a server restart or a bot token update).`
}
/** The `root-lookup-capability-missing` line: the missing scopes or the refused method and Slack error; never a token. */
export function buildRootLookupCapabilityLine(persona: string, gap: RootLookupCapabilityGap): string {
  const identity = gap.kind === 'missing-scope' ? `cause=missing-scope scopes=${gap.scopes.join(',')}` : `cause=method-refused method=${gap.method} slack_error=${gap.slackError}`
  const effect = capabilityGapHoldsLookups(gap)
    ? 'the persona stays up; only thread replies whose root must be looked up wait'
    : 'the persona stays up; no reply waits, because thread lookups in channels do not need this scope'
  return buildDeliveryDiagnostic(ROOT_LOOKUP_CAPABILITY_MISSING, persona, identity,
    `effect="${effect}" action=${JSON.stringify(rootLookupCapabilityAction(gap))}`)
}
/** The Slack notice for a persona's root-lookup capability gap, once per episode. */
export function buildRootLookupCapabilityNotice(persona: string, gap: RootLookupCapabilityGap): string {
  const what = gap.kind === 'missing-scope'
    ? `its bot token lacks the scope(s) ${gap.scopes.map(scope => `\`${slack(scope)}\``).join(', ')}`
    : `Slack refused its thread lookup (\`${slack(gap.method)}\`: \`${slack(gap.slackError)}\`)`
  if (!capabilityGapHoldsLookups(gap)) {
    return `:warning: *DM history scope missing* — ${slack(persona)} is up, but ${what}, which its configuration requires for DMs; no thread lookup CSCB makes needs it now. ` +
      `Mentions, all delivery, DMs and threads it already follows still work. ${rootLookupCapabilityAction(gap)}`
  }
  return `:warning: *Thread lookups unavailable* — ${slack(persona)} is up, but CSCB can't look up who started a thread: ${what}. ` +
    `Mentions, all delivery, DMs and threads it already follows still work; replies whose thread root must be looked up wait until this is fixed. ${rootLookupCapabilityAction(gap)}`
}
/** Distinct recovery finding lines logged per persona before further ones wait for its recovery. */
export const PARTICIPATION_RECOVERY_LOGGED_PER_PERSONA = 20
/** Gap causes: recovery stops looking until the connection comes up again (lost access also until a new message there); the rest it retries while idle. */
const PARTICIPATION_RECOVERY_GAPS: ReadonlySet<ParticipationRecoveryCause> = new Set(['root-deleted', 'access-lost', 'file-unavailable'])
/** Settled causes: the thread is decided not followed; nothing stays pending. */
const PARTICIPATION_RECOVERY_UNFOLLOWED: ReadonlySet<ParticipationRecoveryCause> = new Set(['root-outside-lifetime'])
const PARTICIPATION_RECOVERY_ACTIONS: Readonly<Record<ParticipationRecoveryCause, string>> = {
  'storage': "CSCB retries saving while idle. Check the server's disk and state directory.",
  'metadata': 'CSCB retries the lookup while idle, within the published retry bound and any Retry-After Slack asks for. Nothing to do unless it persists.',
  'capability': "Check that the persona's Slack app was installed with the shipped manifest's scopes and that its bot token is current; reinstall the app if not.",
  'root-deleted': "The thread's root message was deleted, so CSCB cannot tell who started the thread; replies there wait. A new mention of the persona in the thread makes it follow the thread.",
  'access-lost': 'The persona can no longer read that channel; replies there wait. Add the app to the channel again: CSCB looks again when the persona next receives a new message in that channel or reconnects.',
  'file-unavailable': "Slack no longer shows the file's share, so CSCB cannot tell which thread the upload started; the upload itself succeeded. A new mention of the persona in that thread makes it follow the thread.",
  'root-outside-lifetime': "The persona started this thread, but no post CSCB recorded in the channel's current lifetime did (it predates an upgrade, a reset or a leave), so CSCB does not follow it and replies there are not delivered. A new mention of the persona in the thread makes it follow the thread.",
  'root-unmatched': "The persona started this thread, but CSCB cannot match it to a post it recorded in this channel lifetime, so replies there wait. A new mention of the persona in the thread makes it follow the thread.",
}
/** The `participation-recovery` line for one finding: state, cause, identifiers and action; never a body, token or raw error. */
export function buildParticipationRecoveryLine(persona: string, finding: ParticipationRecoveryFinding): string {
  const state = PARTICIPATION_RECOVERY_GAPS.has(finding.cause) ? 'gap' : PARTICIPATION_RECOVERY_UNFOLLOWED.has(finding.cause) ? 'unfollowed' : 'pending'
  const where = `${finding.channel ? ` chat_id=${JSON.stringify(finding.channel)}` : ''}${finding.root ? ` root=${JSON.stringify(finding.root)}` : ''}` +
    `${finding.file ? ` file=${JSON.stringify(finding.file)}` : ''}${finding.code ? ` code=${safe(finding.code)}` : ''}`
  return buildDeliveryDiagnostic(PARTICIPATION_RECOVERY, persona, `state=${state} cause=${finding.cause}${where}`,
    `action=${JSON.stringify(PARTICIPATION_RECOVERY_ACTIONS[finding.cause])}`)
}
/** Once per persona when its finding lines reach the cap. */
export function buildParticipationRecoveryCappedLine(persona: string): string {
  return buildDeliveryDiagnostic(PARTICIPATION_RECOVERY, persona, `limit=${PARTICIPATION_RECOVERY_LOGGED_PER_PERSONA}`, 'further findings are not logged until this persona recovers')
}
/** SR-4.3's recovery report: the persona's thread state is readable, its evidence resolved and every recoverable enrollment saved. */
export function buildParticipationRecoveredLine(persona: string): string {
  return buildDeliveryDiagnostic(PARTICIPATION_RECOVERY, persona, 'state=recovered', 'effect="pending thread evidence is resolved and saved; the persona follows the threads it should"')
}
function stuckReason(reason: DeliveryReason, status: DeliveryStatus): DeliveryStuckReason | undefined {
  if (reason === 'transcript-unreadable') return 'transcript'
  if (reason === 'not-now') return 'refused'
  if ((reason === 'receipt' || reason === 'backoff') && status.retypeCount > 0) return 'not-taken-in'
  return ['relay-off', 'mcp', 'queue-unwritable', 'dialog-hold'].includes(reason) ? reason as DeliveryStuckReason : undefined
}
export interface DeliveryReportingDeps {
  queue: DeliveryQueue; episodes: PersonaEpisodes
  persona(key: string): { name: string; key: string } | undefined
  state(key: string): DeliveryReportState
  log(line: string): void
  notify(key: string, text: string): void | Promise<unknown>
  queued?(key: string, item: QueueItem): void | Promise<void>
  delivered?(key: string, item: QueueItem): void | Promise<void>
  stuckAfterMs?: number
  now?: () => number
  /** Schedule outside the intake turn; returns cancellation for teardown. */
  defer?(run: () => void): () => void
  /** The participation owner's unresolved own-post obligations; an episode ends only when none remains. */
  ownPostFindings?(key: string): readonly OwnPostOutcome[]
  /**
   * An own-post episode ended at the settling outcome `id`, so recovery's
   * report is owed: schedule a recovery pass (`ParticipationRecovery.kick`,
   * which never runs one in the caller's turn and ignores an id its running
   * pass is working on).
   */
  recoveryOwed?(key: string, id: string | undefined): void
}
interface SaveFailure { sender: string; channel?: string; ts?: string; edited_ts?: string }
export function createDeliveryReporting(deps: DeliveryReportingDeps) {
  const alertedAtStartup = new Set<string>()
  const pendingFindings: QueueEvent[] = []
  let findingFlushPending = false
  const received = new Set<string>(), completed = new Set<string>(), failures = new Map<string, number>(), unwritable = new Set<string>(), heads = new Map<string, number>()
  const participationFailures = new Map<string, Map<string, string>>()
  const ownPostFindings = new Map<string, { open: Map<string, 'pending' | 'gap'>; logged: number }>()
  const intakes = new Map<string, { count: number }>()
  const capabilityLines = new Map<string, string>()
  const recoveryFindings = new Map<string, { seen: Set<string>; logged: number }>()
  /** Personas whose own-post episode ended before recovery reported: recovery's next report is logged. */
  const recoveryOwed = new Set<string>()
  const pendingFailures = new Map<string, { notices: Map<string, SaveFailure>; cancel?: () => void }>()
  const failureId = (failure: SaveFailure) => JSON.stringify([failure.channel, failure.ts, failure.edited_ts, failure.sender])
  let stopped = false
  const defer = deps.defer ?? ((run: () => void) => { const timer = setTimeout(run, 0); timer.unref?.(); return () => clearTimeout(timer) })
  const ref = (key: string) => { const p = deps.persona(key); return p ? renderPersonaRef(p.name, key) : `key=${key}` }
  const protect = (run: () => unknown) => { try { const result = run(); if (result && typeof (result as Promise<unknown>).catch === 'function') void (result as Promise<unknown>).catch(() => {}) } catch { /* reporting cannot interrupt durability */ } }
  function log(kind: DeliveryDiagnosticClass, key: string, identity: string, detail = '') { protect(() => deps.log(buildDeliveryDiagnostic(kind, ref(key), identity, detail))) }
  function cancelFailureNotice(key: string): void {
    pendingFailures.get(key)?.cancel?.()
    pendingFailures.delete(key)
  }
  function scheduleFailureNotice(key: string): void {
    const pending = pendingFailures.get(key)
    if (stopped || !pending || pending.cancel || intakes.get(key)?.count) return
    pending.cancel = defer(() => protect(() => {
      pending.cancel = undefined
      if (stopped || pendingFailures.get(key) !== pending || intakes.get(key)?.count) return
      pendingFailures.delete(key)
      // A racing retry may already have retained this exact message. Never
      // tell its sender that accepted work was lost or should be sent again.
      for (const failure of pending.notices.values()) {
        if (failure.channel && failure.ts) {
          const accepted = deps.queue.lookupSlackKey(key, { chat_id: failure.channel, ts: failure.ts, ...(failure.edited_ts ? { edited_ts: failure.edited_ts } : {}) })
          if (accepted && accepted.status !== 'failed') continue
        }
        deps.episodes.post(key, 'message-not-saved', buildMessageNotSavedNotice(ref(key), failure.sender))
        return
      }
    }))
  }
  function failureNotice(key: string, sender: string, channel?: string, ts?: string, edited_ts?: string): void {
    if (stopped) return
    deps.episodes.begin(key, 'message-not-saved')
    const pending = pendingFailures.get(key) ?? { notices: new Map<string, SaveFailure>() }
    const failure = { sender, channel, ts, edited_ts }
    pending.notices.set(failureId(failure), failure)
    pendingFailures.set(key, pending)
    scheduleFailureNotice(key)
  }
  function beginIntake(key: string): () => void {
    const own = intakes.get(key) ?? { count: 0 }
    own.count++; intakes.set(key, own)
    const pending = pendingFailures.get(key)
    pending?.cancel?.()
    if (pending) pending.cancel = undefined
    let released = false
    return () => {
      if (released || intakes.get(key) !== own) return
      released = true
      if (--own.count === 0) { intakes.delete(key); scheduleFailureNotice(key) }
    }
  }
  function move(key: string, seq?: number) {
    if (heads.get(key) === seq) return
    heads.delete(key); if (seq !== undefined) heads.set(key, seq)
    deps.episodes.end(key, 'delivery-stuck'); deps.episodes.end(key, 'messages-waiting')
  }
  function receivedItem(key: string, item: QueueItem): void {
    const id = `${key}:${item.accepted.seq}`
    if (!received.has(id)) {
      received.add(id); log(MESSAGE_RECEIVED, key, deliveryIdentity(item.accepted))
    }
    // Log lifetime is the server run; reaction lifetime is one persona life.
    // The tracker deduplicates successful stages and permits restoration/retry.
    if (item.accepted.source === 'slack' && !item.delivered) protect(() => deps.queued?.(key, item))
  }
  function reconcileQueued(key: string): void {
    if (!deps.persona(key) || !deps.state(key).up) return
    // One pass when the current life becomes usable, detached from Slack and
    // delivery. Unreported intake still belongs to its normal post-ack path.
    for (const item of deps.queue.items(key)) {
      if (received.has(`${key}:${item.accepted.seq}`) && item.accepted.source === 'slack' && !item.delivered) {
        protect(() => deps.queued?.(key, item))
      }
    }
  }
  function queueEvent(event: QueueEvent): void {
    const key = event.key
    switch (event.type) {
      case 'stored':
        failures.delete(key)
        if (!participationFailures.get(key)?.size) { cancelFailureNotice(key); deps.episodes.end(key, 'message-not-saved') }
        return
      case 'writable': unwritable.delete(key); return
      case 'store-failed': {
        const count = (failures.get(key) ?? 0) + 1; failures.set(key, count)
        const source = event.source ?? 'slack'
        const identity = deliveryIdentity({ ...event, source, ts: event.ts ?? '' })
        log(MESSAGE_NOT_SAVED, key, identity, `count=${count} path=${JSON.stringify(event.path ?? '')} code=${queueErrorCode(event.error)}`)
        if (source === 'slack') failureNotice(key, event.user ?? event.bot_id ?? 'unknown', event.channel, event.ts, event.edited_ts)
        return
      }
      case 'append-failed':
        if (!unwritable.has(key)) { unwritable.add(key); log(QUEUE_UNWRITABLE, key, `path=${JSON.stringify(event.path ?? '')} code=${queueErrorCode(event.error)}`) }
        return
      case 'record-unreadable':
        log(QUEUE_RECORD_UNREADABLE, key, `line=${event.line} path=${JSON.stringify(event.quarantinePath)}`)
        pendingFindings.push(event)
        if (!findingFlushPending) {
          findingFlushPending = true
          queueMicrotask(() => { findingFlushPending = false; protect(() => startupFindings(pendingFindings.splice(0))) })
        }
        return
      case 'retained': log(QUEUE_KEPT, key, `count=${event.count}`); return
      case 'recovery-failed': case 'compaction-failed': return
    }
  }
  function startupFindings(events: readonly QueueEvent[]): void {
    const groups = new Map<string, { count: number; path: string }>()
    for (const e of events) if (e.type === 'record-unreadable' && e.alert) { const g = groups.get(e.key) ?? { count: 0, path: e.quarantinePath }; g.count++; groups.set(e.key, g) }
    for (const [key, g] of groups) if (!alertedAtStartup.has(key)) { alertedAtStartup.add(key); protect(() => deps.notify(key, buildQueueRecordUnreadableNotice(ref(key), g.count, g.path))) }
  }
  function engineEvent(event: DeliveryEngineEvent): void {
    const key = event.key
    if (event.type === 'launch-observed' || event.type === 'launch-first-waiting') {
      deps.log(`[slack] delivery-${event.type}: ${JSON.stringify({ key, session_id: event.sessionId, at: event.at })}`)
      return
    }
    if (event.type === 'transcript-reference') {
      deps.log(`[slack] delivery-transcript-reference: ${JSON.stringify({ key: safe(key), instance_id: safe(event.instanceId), session_id: safe(event.sessionId), jsonl_path: safe(event.path), at: event.at })}`)
      return
    }
    if (event.type === 'marker-missing' || event.type === 'delivered') return
    const item = deps.queue.items(key).find(i => i.accepted.seq === event.seq)
    if (!item) return
    const identity = deliveryIdentity(item.accepted), id = `${key}:${event.seq}`
    if (event.type === 'item-delivered') {
      if (!item.delivered || completed.has(id)) return
      completed.add(id)
      receivedItem(key, item)
      log(MESSAGE_DELIVERED, key, identity, `at=${event.at} wait_ms=${event.waitMs}`)
      move(key, deps.queue.items(key).find(i => !i.delivered)?.accepted.seq)
      protect(() => deps.delivered?.(key, item)); return
    }
    if (event.type === 'first-typed') {
      if (item.accepted.source === 'slack') protect(() => deps.log(buildDeliveryDispatchLine(ref(key), item.accepted)))
      return
    }
    if (event.type === 'retyped') { log(MESSAGE_RETYPED, key, identity, `retype_count=${event.count}`); return }
    if (event.type === 'first-unconfirmed-retype') {
      log(MESSAGE_NOT_TAKEN_IN, key, identity)
      protect(() => deps.notify(key, buildMessageNotTakenInNotice(ref(key), item.accepted.user ?? item.accepted.bot_id ?? item.accepted.sender ?? 'unknown'))); return
    }
    if (event.type !== 'waiting' || !event.status) return
    const status = event.status, state = deps.state(key)
    move(key, event.seq)
    if (!state.up) return
    const waiting = messagesWaitingState(status, state)
    if (waiting) { deps.episodes.begin(key, 'messages-waiting'); deps.episodes.post(key, 'messages-waiting', buildMessagesWaitingNotice(ref(key), status.count, status.ageMs, waiting)); return }
    if (state.outage || state.prompt || state.launch || status.row === 'pending' || status.row === 'check_permission' || status.row === 'working' && (status.receiptWorking || status.dialogMaybeOpen || event.reason === 'receipt')) return
    const reason = stuckReason(event.reason, status)
    if (!reason || status.ageMs <= (deps.stuckAfterMs ?? DELIVERY_STUCK_AFTER_MS)) return
    const begun = deps.episodes.begin(key, 'delivery-stuck')
    if (begun === 'begun') log(DELIVERY_STUCK, key, identity, `reason=${reason} age_ms=${status.ageMs}`)
    deps.episodes.post(key, 'delivery-stuck', buildDeliveryStuckNotice(ref(key), key, status.count, status.ageMs, reason, status.retypeCount + 1))
  }
  function participationFailed(key: string, id: string, event: Record<string, unknown>, error: unknown, unaccepted = false): void {
    const held = participationFailures.get(key) ?? new Map<string, string>()
    const first = !held.has(id)
    const field = (name: string) => typeof event[name] === 'string' ? event[name] as string : undefined
    const edited = event.edited
    const failure: SaveFailure = { sender: field('user') ?? field('bot_id') ?? 'unknown', channel: field('channel'), ts: field('ts'),
      edited_ts: typeof edited === 'object' && edited !== null && 'ts' in edited && typeof edited.ts === 'string' ? edited.ts : undefined }
    held.set(id, failureId(failure)); participationFailures.set(key, held)
    const identity = deliveryIdentity({ source: 'slack', channel: field('channel'), ts: field('ts') ?? '', user: field('user'), bot_id: field('bot_id') })
    if (first) log(unaccepted ? MESSAGE_NOT_SAVED : QUEUE_UNWRITABLE, key, identity, `participation=unresolved code=${redactSlackLogText(queueErrorCode(error))}`)
    deps.episodes.begin(key, 'message-not-saved')
    // A read/reconciliation fault does not prove an accepted item was lost.
    // Only a failed incoming save warrants the finite Slack retry warning.
    if (unaccepted) failureNotice(key, failure.sender, failure.channel, failure.ts, failure.edited_ts)
  }
  /** Thread participation is readable for the persona (a queue without the reading counts as readable). */
  function threadsReadable(key: string): boolean {
    try { return (deps.queue as Partial<DeliveryQueue>).threadReadable?.(key) ?? true } catch { return false }
  }
  /** Drop open own-post findings the owner no longer reports, such as one whose lifetime was superseded. */
  function pruneOwnPostFindings(own: { open: Map<string, 'pending' | 'gap'> }, remaining: readonly OwnPostOutcome[]): void {
    const ids = new Set(remaining.map(finding => finding.id))
    for (const open of [...own.open.keys()]) if (!ids.has(open)) own.open.delete(open)
  }
  /**
   * SR-4.3, called only by idle recovery (`participation-recovery.ts`) after
   * a pass with no open root lookup, held reply or gap:
   * once no own-post finding is open either and thread state is readable,
   * end the own-post episode and log one recovery line. Nothing is announced
   * while state is unreadable, or when nothing was reported.
   */
  function recovered(key: string): void {
    if (stopped) return
    const own = ownPostFindings.get(key), findings = recoveryFindings.get(key)
    if ((!own && !findings && !recoveryOwed.has(key)) || !threadsReadable(key)) return
    const remaining = deps.ownPostFindings?.(key)
    if (own && remaining) pruneOwnPostFindings(own, remaining)
    if (own?.open.size || remaining?.length) return
    ownPostFindings.delete(key)
    recoveryFindings.delete(key)
    recoveryOwed.delete(key)
    deps.episodes.end(key, PERSONA_EPISODE_KIND_OWN_POST_NOT_ENROLLED)
    protect(() => deps.log(buildParticipationRecoveredLine(ref(key))))
  }
  /** One recovery finding line per distinct finding, capped per persona until its recovery. Log only: recovery posts nothing. */
  function recoveryFinding(key: string, finding: ParticipationRecoveryFinding): void {
    if (stopped || !deps.persona(key)) return
    let own = recoveryFindings.get(key)
    if (!own) { own = { seen: new Set(), logged: 0 }; recoveryFindings.set(key, own) }
    const id = JSON.stringify([finding.cause, finding.channel, finding.root, finding.file, finding.code])
    if (own.seen.has(id) || own.logged >= PARTICIPATION_RECOVERY_LOGGED_PER_PERSONA) return
    own.seen.add(id)
    own.logged++
    protect(() => deps.log(buildParticipationRecoveryLine(ref(key), finding)))
    if (own.logged === PARTICIPATION_RECOVERY_LOGGED_PER_PERSONA) protect(() => deps.log(buildParticipationRecoveryCappedLine(ref(key))))
  }
  /**
   * Bounded per-persona reporting of own-post outcomes. A pending or gap
   * finding logs once (capped) and, except for a notice's own post or at
   * startup, posts one notice per episode. Only findings with an observation
   * id stay open: an id-less gap leaves no obligation anything can settle.
   * The episode and log cap end at the persona's next settling outcome,
   * including a settled duplicate such as a reply into a followed thread,
   * once no open finding remains and the owner reports none. That ending
   * logs nothing itself; it asks for a recovery pass (`recoveryOwed`). Idle
   * recovery, which also sees root lookups, held replies and gaps, reports
   * the persona recovered (`recovered`) once everything is resolved, and the
   * ended episode is still followed by that one `participation-recovery` line. A storage gap stays open until idle
   * recovery saves its evidence again. Nothing here posts or reposts the post.
   */
  function ownPostObserved(outcome: OwnPostOutcome, startup = false): void {
    const key = outcome.key, id = outcome.id
    // A persona that is not applied, such as one removed after `forget`, gets nothing until it is applied again.
    if (stopped || !deps.persona(key)) return
    let own = ownPostFindings.get(key)
    if (outcome.kind !== 'pending' && outcome.kind !== 'gap') {
      if (!own) return
      if (id !== undefined) own.open.delete(id)
      const remaining = deps.ownPostFindings?.(key)
      if (remaining) pruneOwnPostFindings(own, remaining)
      if (own.open.size || remaining?.length) return
      ownPostFindings.delete(key)
      recoveryOwed.add(key)
      deps.episodes.end(key, PERSONA_EPISODE_KIND_OWN_POST_NOT_ENROLLED)
      protect(() => deps.recoveryOwed?.(key, id))
      return
    }
    if (!own) { own = { open: new Map(), logged: 0 }; ownPostFindings.set(key, own) }
    if (id !== undefined) {
      if (own.open.get(id) === outcome.kind) return
      own.open.set(id, outcome.kind)
    }
    if (own.logged < OWN_POST_FINDINGS_LOGGED_PER_PERSONA) {
      own.logged++
      protect(() => deps.log(buildOwnPostNotEnrolledLine(ref(key), outcome)))
      if (own.logged === OWN_POST_FINDINGS_LOGGED_PER_PERSONA) protect(() => deps.log(buildOwnPostFindingsCappedLine(ref(key))))
    }
    // A notice's own finding never raises another notice.
    if (startup || outcome.surface === 'notice') return
    deps.episodes.begin(key, PERSONA_EPISODE_KIND_OWN_POST_NOT_ENROLLED)
    deps.episodes.post(key, PERSONA_EPISODE_KIND_OWN_POST_NOT_ENROLLED, buildOwnPostNotEnrolledNotice(ref(key), outcome))
  }
  /**
   * A persona's root-lookup capability gap: logged when its episode begins
   * and posted once per episode; repeated recovery attempts and the same gap
   * again add nothing. A different gap in the same episode is logged only.
   */
  function capabilityGap(key: string, gap: RootLookupCapabilityGap): void {
    if (stopped || !deps.persona(key)) return
    const begun = deps.episodes.begin(key, PERSONA_EPISODE_KIND_ROOT_LOOKUP_CAPABILITY)
    const line = buildRootLookupCapabilityLine(ref(key), gap)
    if (begun === 'begun' || capabilityLines.get(key) !== line) protect(() => deps.log(line))
    capabilityLines.set(key, line)
    deps.episodes.post(key, PERSONA_EPISODE_KIND_ROOT_LOOKUP_CAPABILITY, buildRootLookupCapabilityNotice(ref(key), gap))
  }
  function capabilityCleared(key: string): void {
    capabilityLines.delete(key)
    deps.episodes.end(key, PERSONA_EPISODE_KIND_ROOT_LOOKUP_CAPABILITY)
  }
  function participationSettled(key: string, id: string): void {
    const held = participationFailures.get(key)
    const failure = held?.get(id), pending = pendingFailures.get(key)
    if (failure) pending?.notices.delete(failure)
    if (pending && !pending.notices.size) cancelFailureNotice(key)
    held?.delete(id)
    if (!held?.size) {
      participationFailures.delete(key)
      if (!failures.has(key)) { cancelFailureNotice(key); deps.episodes.end(key, 'message-not-saved') }
    }
  }
  return {
    beginIntake,
    received: (key: string, item: QueueItem) => protect(() => receivedItem(key, item)),
    reconcileQueued: (key: string) => protect(() => reconcileQueued(key)),
    queueEvent: (event: QueueEvent) => protect(() => queueEvent(event)),
    engineEvent: (event: DeliveryEngineEvent) => protect(() => engineEvent(event)), startupFindings,
    participationFailed: (key: string, id: string, event: Record<string, unknown>, error?: unknown, unaccepted = false) => protect(() => participationFailed(key, id, event, error, unaccepted)),
    participationSettled: (key: string, id: string) => protect(() => participationSettled(key, id)),
    ownPostObserved: (outcome: OwnPostOutcome) => protect(() => ownPostObserved(outcome)),
    /** Restored pending own-post evidence, after protection and notifier wiring: logged, never re-announced. */
    ownPostStartup: (findings: readonly OwnPostOutcome[]) => { for (const finding of findings) protect(() => ownPostObserved(finding, true)) },
    /** One line per persona for outcomes its buffer could not keep before reporting started. */
    ownPostDropped: (counts: ReadonlyMap<string, number>) => {
      for (const [key, count] of counts) if (count > 0) protect(() => deps.log(buildOwnPostOutcomesDroppedLine(ref(key), count)))
    },
    /** Root-lookup capability (`participation-capability.ts`): a gap begins and posts its episode once; clearing ends it silently. */
    capabilityGap: (key: string, gap: RootLookupCapabilityGap) => protect(() => capabilityGap(key, gap)),
    capabilityCleared: (key: string) => protect(() => capabilityCleared(key)),
    /** Idle recovery (`participation-recovery.ts`): one bounded line per distinct finding. */
    recoveryFinding: (key: string, finding: ParticipationRecoveryFinding) => protect(() => recoveryFinding(key, finding)),
    /** Idle recovery resolved everything recoverable: the only caller that reports recovery, when anything was reported. */
    participationRecovered: (key: string) => protect(() => recovered(key)),
    forget(key: string) { cancelFailureNotice(key); intakes.delete(key); failures.delete(key); participationFailures.delete(key); ownPostFindings.delete(key); unwritable.delete(key); heads.delete(key); capabilityLines.delete(key); recoveryFindings.delete(key); recoveryOwed.delete(key) },
    stop() { stopped = true; for (const key of pendingFailures.keys()) cancelFailureNotice(key); intakes.clear() },
  }
}
