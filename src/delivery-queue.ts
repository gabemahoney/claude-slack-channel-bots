/** Durable per-persona FIFO journals. No import-time I/O. */
import { testSyncWorkStart, testSyncWorkEnd, createTestSyncWorkScope, type TestSyncWorkScope } from './test-stall-attribution.ts'
import type { GetResult } from 'agent-director'
import * as nodeFs from 'node:fs'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { durableWriteFileSync, DurableWriteUnsyncedError } from './atomic-write.ts'
import { PERSONA_KEY_RE } from './persona-identity.ts'
import { cloneJournalData, createDurableJournal, splitJournalLines, type AppendRollback } from './durable-journal.ts'
import type { ChannelStamp } from './shared-channels.ts'
import type { ChannelMode } from './config.ts'

export const QUEUE_KEY_KEEP_MS = 24 * 60 * 60 * 1000
export const REPLY_REMINDER_KEEP_MS = 24 * 60 * 60 * 1000
export const QUEUE_COMPACT_INTERVAL_MS = 60 * 60 * 1000
export const QUEUE_DIRECTORY_MODE = 0o700
export const QUEUE_FILE_MODE = 0o600
/** Acceptances sharing one append and fsync. A runtime pause during a batch
 * delays every member's store, so a small batch keeps one pause from moving
 * a burst's store percentiles. */
export const QUEUE_GROUP_COMMIT_MAX = 8
export type DeliverySource = 'slack' | 'interject' | 'cron' | 'reaction'
export interface SlackKey { chat_id: string; ts: string; edited_ts?: string }
export type ReactionChange = 'added' | 'removed'
export type ReactionOrigin = 'slack-event' | 'bot-tool'
/** A Reaction Item's identity. Origin, stored mode and persona name are outside it. */
export interface ReactionKey { chat_id: string; message_ts: string; reactor: string; emoji: string; change: ReactionChange; event_ts: string }
export interface QueueFile { name: string; mimetype?: string; size?: number }
export interface QueueThreadJoin { thread_ts: string; stamp: ChannelStamp; at: number }
export interface MemoryHoldField { on: 'memory'; thread_ts: string; stamp: ChannelStamp; arrived_at: number }
/** Waits on the named Pending Own Posts; root_unknown records the view at arrival. */
export interface PostHoldField {
  on: 'post'; operations: readonly string[]; thread_ts: string; stamp: ChannelStamp; root_unknown: boolean; arrived_at: number
}
export type HoldField = MemoryHoldField | PostHoldField
export type HoldKind = HoldField['on']
export type HoldOutcome = 'released' | 'withdrawn' | 'parked'
export interface HoldResolution { seq: number; outcome: HoldOutcome; at: number }
/** A parked Post Hold is listed in the Memory Hold form. */
export type UnresolvedHold = HoldField & { seq: number; channel: string; memoryDependent: boolean }
/** kind is the effective kind: a parked Post Hold is a Memory Hold. */
export interface HoldSummary { field: HoldField; kind: HoldKind; state: 'unresolved' | 'released' | 'withdrawn'; at?: number }
export interface AcceptedInput {
  source: DeliverySource
  text: string
  received_at?: number
  ts?: string
  sender?: string
  key?: SlackKey
  channel?: string
  channel_type?: string
  thread_ts?: string
  edited_ts?: string
  user?: string
  bot_id?: string
  username?: string
  bot_profile_name?: string
  files?: QueueFile[]
  via?: string
  /** Internal link for an injected reply reminder; never accepted from Slack intake. */
  reminder_for?: number
  /** Original queued emoji, retained with open work across configuration changes. */
  queued_ack_reaction?: string
  /** Join saved by this acceptance until Thread Memory saves its own copy. */
  thread_join?: QueueThreadJoin
  hold?: HoldField
  /** Opening time retained when compaction removes a released hold's field. */
  released_at?: number
  /** Reaction Items only; see ReactionAcceptedInput. */
  message_ts?: string
  change?: ReactionChange
  emoji?: string
  origin?: ReactionOrigin
  mode?: ChannelMode
  reaction_key?: ReactionKey
  reactor_persona_name?: string
}
/** One reaction for one Bot: `channel` is the conversation, `message_ts` the
 * reacted message, `ts` the event ts exactly as received and `user`
 * (preferred) or `bot_id` the reactor. It holds no message text, so `text`
 * is always empty. `mode` is the channel mode its intake decision used;
 * preparation reads it, and `reactor_persona_name`, from the item, never
 * from the configuration in effect (guide exception E1, Reaction Items only). */
export interface ReactionAcceptedInput extends AcceptedInput {
  source: 'reaction'; text: ''; channel: string; message_ts: string; ts: string
  change: ReactionChange; emoji: string; origin: ReactionOrigin; mode: ChannelMode; reaction_key: ReactionKey
  /** Required for origin `bot-tool`: the reacting Bot's persona name at hand-off. */
  reactor_persona_name?: string
  key?: undefined; queued_ack_reaction?: undefined; reminder_for?: undefined; files?: undefined
}
interface BaseRecord { v: 1; seq: number }
export interface AcceptedRecord extends BaseRecord, AcceptedInput {
  kind: 'accepted'; received_at: number; ts: string; attempt_high_watermark?: number; item_id?: string
}
/** Durable AD pair, written before sending. Recovered intents are lookup-only. */
export interface SubmittedRecord extends BaseRecord {
  kind: 'submitted'; attempt: number; part: number; at: number
  caller_uuid: string; delivery_request_id: string; instance_id: string
  /** Retained for old journals only; AD binds launch_token after hand-over. */
  launch_token?: string; session_id: string
}
/** Terminal local handling. Unknown delivery never authorizes a new send. */
export interface SubmissionBlockedRecord extends BaseRecord {
  kind: 'submission-blocked'; attempt: number; at: number; reason: string
}
export interface ReactionAcceptedRecord extends BaseRecord, ReactionAcceptedInput {
  kind: 'accepted'; received_at: number; ts: string; attempt_high_watermark?: number
}
/** Compaction keeps dedupe facts without message content. */
export interface QueueKeyRecord extends BaseRecord {
  kind: 'accepted'; compact: 'key'; key: SlackKey; received_at: number; delivered_at: number
}
/** Non-content high water marks survive even an entirely delivered injected queue. */
export interface QueueAllocationRecord extends BaseRecord {
  kind: 'accepted'; compact: 'allocation'; injected_ts?: string
}
/** A closed Reaction Item's dedupe fact without its content. */
export interface QueueReactionKeyRecord extends BaseRecord {
  kind: 'accepted'; compact: 'reaction-key'; reaction_key: ReactionKey; received_at: number
  /** The withdrawal time, or the final delivered time. */
  closed_at: number
}
export interface FixedRecord extends BaseRecord { kind: 'fixed'; parts: string[] }
export type ReactionWithdrawalReason = 'server-post' | 'conversation-unknown' | 'group-dm' | 'open-refused'
/** `not_in_channel` and `channel_not_found` are Slack refusal codes. */
export type ReactionFungibleCondition = 'not-a-channel' | 'externally-shared' | 'not_in_channel' | 'channel_not_found'
/** Terminal: a withdrawn Reaction Item is closed, never typed or delivered. */
export interface WithdrawnRecord extends BaseRecord {
  kind: 'withdrawn'; reason: ReactionWithdrawalReason; at: number
  /** Present exactly when `reason` is `open-refused`. */
  failed_condition?: ReactionFungibleCondition
}
export interface SentRecord extends BaseRecord {
  kind: 'sent'; attempt: number; part: number; send_kind: 'text' | 'enter' | 'retype'
  at: number; session_id: string; transcript_path: string; transcript_size: number
}
/** A damaged send remains evidence of an unknown outcome, across compaction/restart. */
export interface UnknownSentRecord extends BaseRecord {
  kind: 'sent'; attempt: number; unknown_outcome: true; at: number; quarantine: { path: string; line: number }
}
export interface DeliveredRecord extends BaseRecord {
  kind: 'delivered'; part: number; at: number; receipt: { path: string; uuid?: string; offset?: number }
  ad?: { launch_token: string | null; session_id: string; evidence_kind: string | null }
}
export interface RefusedRecord extends BaseRecord { kind: 'refused'; attempt: number; at: number }
export interface ReplyReminderRecord extends BaseRecord {
  kind: 'reply-reminder'; at: number
  /** Fixed eligibility origin; repeated AD observations must not extend retention. */
  delivered_at?: number
  state: 'observed' | 'replied' | 'nudged' | 'cancelled'
  row_state?: string; session_id?: string; launch_started_at?: string | null
  /** A pre-receipt reply covers only these attempts, while they remain unrefused. */
  reply_attempts?: number[]
  /** Non-content send facts retained when compaction removes the delivered item. */
  delivery_attempts?: number[]
}
export interface ReplyCallTarget { seq: number; attempts?: number[] }
export interface NoticedRecord extends BaseRecord { kind: 'noticed'; at: number }
/** Operator resolution without delivery; every item record remains retained. */
export interface AbandonedRecord extends BaseRecord { kind: 'abandoned'; at: number }
export type AbandonResult = 'abandoned' | 'unknown' | 'delivered' | 'not-head' | 'already-abandoned'
/** A hold resolution's record kind. A withdrawn hold's is `hold-withdrawn`, apart from a Reaction Item's `withdrawn`. */
export type HoldResolutionKind = 'released' | 'hold-withdrawn' | 'parked'
const HOLD_RESOLUTION_KINDS: Readonly<Record<HoldOutcome, HoldResolutionKind>> = { released: 'released', withdrawn: 'hold-withdrawn', parked: 'parked' }
const HOLD_OUTCOMES: readonly HoldOutcome[] = ['released', 'withdrawn', 'parked']
export interface HoldResolutionRecord extends BaseRecord { kind: HoldResolutionKind; at: number }
export type QueueRecord = AcceptedRecord | QueueKeyRecord | QueueAllocationRecord | QueueReactionKeyRecord | FixedRecord | WithdrawnRecord | SentRecord | UnknownSentRecord | SubmittedRecord | SubmissionBlockedRecord | DeliveredRecord | RefusedRecord | NoticedRecord | ReplyReminderRecord | HoldResolutionRecord | AbandonedRecord
export type ItemRecord = AcceptedRecord | FixedRecord | WithdrawnRecord | SentRecord | UnknownSentRecord | SubmittedRecord | SubmissionBlockedRecord | DeliveredRecord | RefusedRecord | NoticedRecord | HoldResolutionRecord | AbandonedRecord
export interface QueueItem {
  accepted: AcceptedRecord; fixed?: FixedRecord; records: ItemRecord[]; delivered: boolean
  /** A withdrawn item stays `delivered: false`; see isQueueItemClosed. */
  withdrawn?: WithdrawnRecord
  abandoned?: AbandonedRecord
  unknownSend: boolean; retypeCount: number; nextAttempt: number
  hold?: HoldSummary
}
/** Delivered, withdrawn or abandoned: no longer FIFO work. */
export function isQueueItemClosed(item: Pick<QueueItem, 'delivered' | 'withdrawn' | 'abandoned'>): boolean { return item.delivered || item.withdrawn !== undefined || item.abandoned !== undefined }
/** The item's fixed or withdrawn outcome is already durable. The journal stays writable. */
export class QueueOutcomeFinal extends Error {}
/** Only Reaction Items have a withdrawn outcome. Not a storage failure: the journal stays writable. */
export class QueueNotWithdrawable extends Error {}
export function isOpenItem(item: QueueItem): boolean { return !isQueueItemClosed(item) && (!item.hold || item.hold.state === 'released') }
export function itemOpenedAt(item: QueueItem): number { return (item.hold?.state === 'released' ? item.hold.at : undefined) ?? item.accepted.released_at ?? item.accepted.received_at }
/** The kind of a timed store: an ordinary acceptance or one holding on a Post or Memory Hold. */
export type QueueStoreKind = 'accepted' | 'post-hold' | 'memory-hold'
/** A turn's timing on the queue's monotonic clock: from the turn's start to
 * its append's return, and that return. Only with `measureTimings`. */
export interface QueueStoreTiming { storeMs: number; atMonoMs: number }
export type QueueEvent =
  | ({ type: 'holds-resolved'; key: string; resolutions: HoldResolution[] } & Partial<QueueStoreTiming>)
  | { type: 'store-failed'; key: string; path?: string; source?: DeliverySource; sender?: string; user?: string; bot_id?: string; channel?: string; ts?: string; edited_ts?: string; slackKey?: SlackKey; reactionKey?: ReactionKey; error: unknown }
  | ({ type: 'stored'; key: string; seq?: number; store?: QueueStoreKind } & Partial<QueueStoreTiming>)
  | { type: 'writable'; key: string }
  /** A newly written `fixed` record; never a `stored` event, which ends a not-saved episode. Only with `measureTimings`. */
  | ({ type: 'fixed-stored'; key: string; seq: number } & QueueStoreTiming)
  | { type: 'append-failed' | 'recovery-failed' | 'compaction-failed'; key: string; path?: string; seq?: number; error: unknown }
  | { type: 'record-unreadable'; key: string; line: number; quarantinePath: string; alert: boolean }
  | { type: 'retained'; key: string; count: number }
export type QueueAcceptResult = { status: 'accepted' | 'duplicate'; item?: QueueItem; seq: number } | { status: 'failed'; error: unknown }
export type QueueAccept = (key: string, input: AcceptedInput) => Promise<QueueAcceptResult>
export interface QueueEffectThread { channel: string; root: string }
export type QueueAcceptDecision<T> = { store: AcceptedInput; afterStore?: (stored: { seq: number }) => void; effectThread?: QueueEffectThread } | { skip: T }
export type QueueDecidedResult<T> = QueueAcceptResult | { status: 'skipped'; outcome: T }
export interface DeliveryQueue {
  start(): Promise<void>
  accept: QueueAccept
  /** Decide after the durable key check in the persona's writer turn. Both
   * callbacks must be synchronous: no I/O, network, log or shared-state write,
   * except that `decide` may take an in-memory retention no decision reads,
   * which its caller releases unless `afterStore` hands it on.
   * `decide` may run while the persona's earlier stores are staged in a group
   * commit but not yet durable or published. It never reads an unfinished
   * store's record (`unresolvedHolds` lists staged holds) or depends on that
   * store's outcome. Decisions run in section-arrival order. Only a decision
   * sharing an unfinished effect's thread (channel and root) or durable key
   * waits for that effect; a key check also waits for any unfinished store of
   * its key. A waiting head holds back later decisions. Other decisions may
   * run before earlier stores finish and their frozen inputs are never
   * re-evaluated. Groups contain up to 8 stores, effects included, and never
   * pass another queue write. After all required fsyncs, records publish,
   * effects apply and callers are answered in sequence order. A failed group
   * fails every store and applies none of its effects. Supply the decision's
   * event thread and, if different, the after-store effect's thread. */
  acceptDecided<T>(key: string, slackKey: SlackKey | undefined, decide: (facts: { keyChecked: boolean }) => QueueAcceptDecision<T>, thread?: QueueEffectThread): Promise<QueueDecidedResult<T>>
  /** Serial intakes and acceptance stores, queued or running, not yet answered. */
  hasAcceptanceBacklog?(key: string): boolean
  /** One notification when that persona next has no acceptance backlog. */
  onAcceptanceBacklogCleared?(key: string, callback: () => void): () => void
  /** Retention only: includes decided holds not yet assigned a queue sequence.
   * Intake decisions must not read it. */
  memoryHoldStamps?(key: string): readonly { channel: string; stamp: ChannelStamp }[]
  append(key: string, record: QueueRecord): Promise<void>
  /** Check and close exactly the open head in one serialized durable turn. */
  abandon(key: string, seq: number, at: number): Promise<AbandonResult>
  /** One durable caller identity per state directory; lazy, before covered sends. */
  callerUuid?(): string
  /** Adopt pre-two-stage accepted work before its first queued Slack mutation. */
  rememberQueuedReaction(key: string, seq: number, name: string): Promise<string | undefined>
  lookupSlackKey(key: string, slackKey: SlackKey): QueueAcceptResult | undefined
  lookupReactionKey(key: string, reactionKey: ReactionKey): QueueAcceptResult | undefined
  /** A deeply frozen snapshot, shared until that item changes. */
  item(key: string, seq: number): QueueItem | undefined
  /** A fresh ordered array of deeply frozen per-item snapshots. */
  items(key: string): QueueItem[]
  openCount(key: string): number
  /** A fresh ordered array of deeply frozen holds. Includes decisions whose
   * store is in progress, for stale-join retention. */
  unresolvedHolds(key: string): UnresolvedHold[]
  /** Returns only resolutions newly saved by this call, in input order.
   * onCommitted observes that batch synchronously after publication, before
   * other observers or the caller's continuation can cancel its reporting.
   * It is not awaited, and its errors cannot change the durable result. */
  resolveHolds(key: string, resolutions: readonly HoldResolution[], current?: () => boolean,
    onCommitted?: (saved: readonly HoldResolution[]) => void): Promise<HoldResolution[]>
  /** Pending journal repair or an append storage failure suspends keys. Validation refusals preserve this state. */
  isWritable?(key: string): boolean
  /** A repaired replay is visible before its rewrite succeeds. Until then its
   * thread facts (`thread_join`, and holds judged against Thread Memory) are
   * not trusted; the loading turn that completes the repair recovers them. */
  durabilityPending?(key: string): boolean
  keys(): string[]
  compact(key?: string, current?: () => boolean): Promise<void>
  startMaintenance(intervalMs?: number): void
  stop(): Promise<void>
  retained(key: string): void
  startupFindings(): QueueEvent[]
}
export type ReplyReminderRow = Pick<GetResult, 'state' | 'session_id' | 'launch_started_at' | 'busy_send' | 'delivery'>
/** Server-owned journal operations; ordinary delivery adapters need only DeliveryQueue. */
export interface ReplyReminderQueue extends DeliveryQueue {
  /** Test-only: bind timing after the server resolves its start configuration. */
  setMeasureTimings(enabled: boolean): void
  replyReminderItems(key: string): ReplyReminderRecord[]
  replyCallTargets(key: string): ReplyCallTarget[]
  recordReplyCall(key: string, targets: readonly ReplyCallTarget[]): Promise<void>
  observeReplyReminders(key: string, row: ReplyReminderRow, text: string, enabled: boolean, current: () => boolean): Promise<QueueItem[]>
  cancelReplyReminders(key: string): Promise<void>
  /** Another module opened `key`'s existing journal, as the seal does to hash
   * it, possibly before this queue reads it. Only this run's first opening counts. */
  journalOpened(key: string): void
}
export interface DeliveryQueueOptions {
  stateDir: string
  now?: () => number
  onEvent?: (event: QueueEvent) => void
  fs?: typeof nodeFs
  setInterval?: typeof globalThis.setInterval
  clearInterval?: typeof globalThis.clearInterval
  /** One synchronous compaction pass's confirmation that its join copies may
   * be discarded. Construct fresh after preparatory I/O; retention stays lazy. */
  threadJoinSaved?(key: string): (channel: string, threadJoin: QueueThreadJoin) => boolean
  /** A journal start() didn't load (one unreadable then, or whose repair
   * rewrite failed) has loaded. Called once, inside the turn that loaded or
   * repaired it and before that turn's own work, so it must be synchronous
   * with no I/O; its throw is ignored. */
  onLoadedAfterStart?(key: string): void
  /** Test-only: time stores on `monotonicNow`. Off, the queue reads no clock for timing and emits no timing field or event. */
  measureTimings?: boolean
  monotonicNow?: () => number
  /** The maintenance compaction interval; `QUEUE_COMPACT_INTERVAL_MS` unless given. */
  compactIntervalMs?: number
}
const object = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)
const str = (v: unknown): v is string => typeof v === 'string'
const number = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v)
const integer = (v: unknown): v is number => number(v) && Number.isSafeInteger(v) && v >= 0
const positive = (v: unknown): v is number => integer(v) && v > 0
const timestamp = (v: unknown): v is string => str(v) && /^\d+\.\d{6}$/.test(v)
const nonEmpty = (v: unknown): v is string => str(v) && v !== ''
/** In-memory members holding undefined are absent on disk. */
const onlyKeys = (r: Record<string, unknown>, allowed: readonly string[]): boolean => Object.keys(r).every(k => r[k] === undefined || allowed.includes(k))
/** Exact members only: String() coercion would admit a non-string such as ['added']. */
const oneOf = (members: readonly string[], v: unknown): v is string => str(v) && members.includes(v)
export function isSlackKey(v: unknown): v is SlackKey {
  return object(v) && str(v.chat_id) && v.chat_id !== '' && str(v.ts) && v.ts !== '' && (v.edited_ts === undefined || str(v.edited_ts))
}
function isQueueThreadJoin(v: unknown): v is QueueThreadJoin {
  return object(v) && timestamp(v.thread_ts) && number(v.at) &&
    Object.keys(v).every(k => ['thread_ts', 'stamp', 'at'].includes(k)) &&
    object(v.stamp) && str(v.stamp.incarnation) && v.stamp.incarnation !== '' &&
    str(v.stamp.threadHybridSince) && v.stamp.threadHybridSince !== '' &&
    Object.keys(v.stamp).every(k => ['incarnation', 'threadHybridSince'].includes(k))
}
function isHoldField(v: unknown): v is HoldField {
  if (!object(v) || !number(v.arrived_at) || !isQueueThreadJoin({ thread_ts: v.thread_ts, stamp: v.stamp, at: v.arrived_at })) return false
  if (v.on === 'memory') return Object.keys(v).every(k => ['on', 'thread_ts', 'stamp', 'arrived_at'].includes(k))
  return v.on === 'post' && typeof v.root_unknown === 'boolean' && Array.isArray(v.operations) && v.operations.length > 0 &&
    v.operations.every(o => str(o) && o !== '') && new Set(v.operations).size === v.operations.length &&
    Object.keys(v).every(k => ['on', 'operations', 'thread_ts', 'stamp', 'root_unknown', 'arrived_at'].includes(k))
}
function memoryForm(field: HoldField): MemoryHoldField {
  return { on: 'memory', thread_ts: field.thread_ts, stamp: field.stamp, arrived_at: field.arrived_at }
}
function unresolvedEntry(field: HoldField, kind: HoldKind, seq: number, channel: string): UnresolvedHold {
  if (field.on === 'post' && kind === 'post') return { ...field, seq, channel, memoryDependent: field.root_unknown }
  return { ...memoryForm(field), seq, channel, memoryDependent: true }
}
function isHoldResolution(r: QueueRecord): r is HoldResolutionRecord { return r.kind === 'released' || r.kind === 'hold-withdrawn' || r.kind === 'parked' }
const REACTION_CHANGES: readonly string[] = ['added', 'removed'] satisfies ReactionChange[]
const REACTION_ORIGINS: readonly string[] = ['slack-event', 'bot-tool'] satisfies ReactionOrigin[]
const REACTION_MODES: readonly string[] = ['strict', 'open'] satisfies ChannelMode[]
const WITHDRAWAL_REASONS: readonly string[] = ['server-post', 'conversation-unknown', 'group-dm', 'open-refused'] satisfies ReactionWithdrawalReason[]
const FUNGIBLE_CONDITIONS: readonly string[] = ['not-a-channel', 'externally-shared', 'not_in_channel', 'channel_not_found'] satisfies ReactionFungibleCondition[]
const REACTION_KEY_FIELDS = ['chat_id', 'message_ts', 'reactor', 'emoji', 'change', 'event_ts']
const REACTION_ACCEPTED_FIELDS = ['v', 'kind', 'seq', 'source', 'text', 'received_at', 'ts', 'channel', 'message_ts', 'change', 'emoji', 'user', 'bot_id', 'origin', 'mode', 'reaction_key', 'reactor_persona_name', 'attempt_high_watermark']
/** No other source stores these, so no other queued item keeps a routing copy. */
const REACTION_ONLY_FIELDS = ['message_ts', 'change', 'emoji', 'origin', 'mode', 'reaction_key', 'reactor_persona_name']
export function isReactionKey(v: unknown): v is ReactionKey {
  return object(v) && nonEmpty(v.chat_id) && nonEmpty(v.message_ts) && nonEmpty(v.reactor) && nonEmpty(v.emoji) && oneOf(REACTION_CHANGES, v.change) && nonEmpty(v.event_ts) && onlyKeys(v, REACTION_KEY_FIELDS)
}
/** The ordered six-tuple; Slack keys have their own index and encoding. */
export function reactionKeyString(key: ReactionKey): string { return JSON.stringify([key.chat_id, key.message_ts, key.reactor, key.emoji, key.change, key.event_ts]) }
/** Content-free by allowlist; every key component must agree with its stored field. */
function isReactionAccepted(r: Record<string, unknown>): boolean {
  if (r.text !== '' || !nonEmpty(r.channel) || !nonEmpty(r.message_ts) || !nonEmpty(r.ts) || !number(r.received_at) || !nonEmpty(r.emoji)) return false
  if (!oneOf(REACTION_CHANGES, r.change) || !oneOf(REACTION_ORIGINS, r.origin) || !oneOf(REACTION_MODES, r.mode)) return false
  if ((r.user !== undefined && !str(r.user)) || (r.bot_id !== undefined && !str(r.bot_id))) return false
  if (r.attempt_high_watermark !== undefined && !integer(r.attempt_high_watermark)) return false
  if (r.origin === 'bot-tool' ? !nonEmpty(r.reactor_persona_name) : r.reactor_persona_name !== undefined) return false
  if (!onlyKeys(r, REACTION_ACCEPTED_FIELDS)) return false
  const reactor = nonEmpty(r.user) ? r.user : r.bot_id, k = r.reaction_key
  return nonEmpty(reactor) && isReactionKey(k) && k.chat_id === r.channel && k.message_ts === r.message_ts && k.reactor === reactor && k.emoji === r.emoji && k.change === r.change && k.event_ts === r.ts
}
/** Structural on-disk schema. Invalid versions/kinds and partial records are never replayed. */
export function isQueueRecord(value: unknown): value is QueueRecord {
  if (!object(value) || value.v !== 1 || !integer(value.seq)) return false
  const r = value
  // Hold metadata belongs only to full accepted records; compact forms reject it below.
  if (r.kind !== 'accepted' && ('hold' in r || 'released_at' in r)) return false
  switch (r.kind) {
    case 'accepted':
      if (r.compact === 'allocation') return (r.injected_ts === undefined || timestamp(r.injected_ts)) && Object.keys(r).every(k => ['v', 'kind', 'seq', 'compact', 'injected_ts'].includes(k))
      if (r.compact === 'key') return isSlackKey(r.key) && number(r.received_at) && number(r.delivered_at) && Object.keys(r).every(k => ['v', 'kind', 'seq', 'compact', 'key', 'received_at', 'delivered_at'].includes(k))
      if (r.compact === 'reaction-key') return isReactionKey(r.reaction_key) && number(r.received_at) && number(r.closed_at) && onlyKeys(r, ['v', 'kind', 'seq', 'compact', 'reaction_key', 'received_at', 'closed_at'])
      if (r.compact !== undefined) return false
      if (r.source === 'reaction') return isReactionAccepted(r)
      if (!str(r.source) || !['slack', 'interject', 'cron'].includes(r.source) || !str(r.text) || !str(r.ts) || !number(r.received_at)) return false
      if (REACTION_ONLY_FIELDS.some(k => r[k] !== undefined)) return false
      if (r.reminder_for !== undefined && (!positive(r.reminder_for) || r.source !== 'interject')) return false
      if (r.attempt_high_watermark !== undefined && !integer(r.attempt_high_watermark)) return false
      if (r.item_id !== undefined && (!str(r.item_id) || !r.item_id)) return false
      if (r.queued_ack_reaction !== undefined && (!str(r.queued_ack_reaction) || !r.queued_ack_reaction.trim())) return false
      if (r.thread_join !== undefined && (r.source !== 'slack' || !oneOf(['mention', 'broadcast'], r.via) || !isQueueThreadJoin(r.thread_join))) return false
      if (r.hold !== undefined && (r.source !== 'slack' || r.via !== 'thread' || r.thread_join !== undefined || !isHoldField(r.hold))) return false
      if (r.released_at !== undefined && !number(r.released_at)) return false
      for (const k of ['sender', 'channel', 'channel_type', 'thread_ts', 'edited_ts', 'user', 'bot_id', 'username', 'bot_profile_name', 'via']) if (r[k] !== undefined && !str(r[k])) return false
      if (r.files !== undefined && (!Array.isArray(r.files) || !r.files.every(f => object(f) && str(f.name) && (f.mimetype === undefined || str(f.mimetype)) && (f.size === undefined || number(f.size))))) return false
      return r.source === 'slack' ? isSlackKey(r.key) && str(r.channel) && str(r.via) : timestamp(r.ts) && str(r.sender) && r.key === undefined
    case 'fixed': return Array.isArray(r.parts) && r.parts.length > 0 && r.parts.every(p => str(p) && p !== '')
    case 'submitted': return positive(r.attempt) && positive(r.part) && number(r.at) && ['caller_uuid', 'delivery_request_id', 'instance_id', 'session_id'].every(k => str(r[k]) && r[k] !== '') && (r.launch_token === undefined || (str(r.launch_token) && r.launch_token !== ''))
    case 'submission-blocked': return positive(r.attempt) && number(r.at) && str(r.reason)
    case 'withdrawn': return positive(r.seq) && number(r.at) && oneOf(WITHDRAWAL_REASONS, r.reason) && (r.reason === 'open-refused' ? oneOf(FUNGIBLE_CONDITIONS, r.failed_condition) : r.failed_condition === undefined) && onlyKeys(r, ['v', 'kind', 'seq', 'reason', 'at', 'failed_condition'])
    case 'sent':
      if (!positive(r.attempt) || !number(r.at)) return false
      if (r.unknown_outcome === true) return object(r.quarantine) && str(r.quarantine.path) && positive(r.quarantine.line)
      return positive(r.part) && str(r.send_kind) && ['text', 'enter', 'retype'].includes(r.send_kind) && str(r.session_id) && str(r.transcript_path) && integer(r.transcript_size)
    case 'delivered': return positive(r.part) && number(r.at) && object(r.receipt) && str(r.receipt.path) && (str(r.receipt.uuid) || integer(r.receipt.offset)) && (r.ad === undefined || (object(r.ad) && (r.ad.launch_token === null || str(r.ad.launch_token)) && str(r.ad.session_id) && (r.ad.evidence_kind === null || str(r.ad.evidence_kind))))
    case 'refused': return positive(r.attempt) && number(r.at)
    case 'reply-reminder': return number(r.at) && (r.delivered_at === undefined || number(r.delivered_at)) && str(r.state) && ['observed', 'replied', 'nudged', 'cancelled'].includes(r.state) && (r.row_state === undefined || str(r.row_state)) && (r.session_id === undefined || str(r.session_id)) && (r.launch_started_at === undefined || r.launch_started_at === null || str(r.launch_started_at)) && (r.reply_attempts === undefined || (r.state === 'replied' && Array.isArray(r.reply_attempts) && r.reply_attempts.length > 0 && r.reply_attempts.every(positive))) && (r.delivery_attempts === undefined || (Array.isArray(r.delivery_attempts) && r.delivery_attempts.length > 0 && r.delivery_attempts.every(positive)))
    case 'noticed': return number(r.at)
    case 'abandoned': return positive(r.seq) && number(r.at) && onlyKeys(r, ['v', 'kind', 'seq', 'at'])
    case 'released': case 'hold-withdrawn': case 'parked':
      return number(r.at) && Object.keys(r).every(k => ['v', 'kind', 'seq', 'at'].includes(k))
    default: return false
  }
}
export function parseQueueRecord(line: string): QueueRecord | undefined {
  try { const value: unknown = JSON.parse(line); return isQueueRecord(value) ? value : undefined } catch { return undefined }
}
export function slackKeyString(key: SlackKey): string { return JSON.stringify([key.chat_id, key.ts, key.edited_ts ?? null]) }
function isAccepted(r: QueueRecord): r is AcceptedRecord { return r.kind === 'accepted' && !('compact' in r) }
/** Only these feed the injected microsecond watermark; Slack and reaction ts are kept exactly. */
const injectedSource = (source: DeliverySource): boolean => source === 'interject' || source === 'cron'
const sameWithdrawal = (a: WithdrawnRecord, b: WithdrawnRecord): boolean => a.seq === b.seq && a.reason === b.reason && a.at === b.at && a.failed_condition === b.failed_condition
function microseconds(ts: string): bigint { const [s, f = ''] = ts.split('.'); return BigInt(s!) * 1000000n + BigInt(f.padEnd(6, '0').slice(0, 6)) }
function formatMicros(us: bigint): string { return `${us / 1000000n}.${String(us % 1000000n).padStart(6, '0')}` }
interface Journal extends AppendRollback {
  records: QueueRecord[]; nextSeq: number; lastInjected?: bigint; loaded: boolean; quarantineRollback?: AppendRollback
  /** Quarantine is durable; this replay must replace the source before writes. */
  pendingRecovery?: boolean
  reminders: Map<number, ReplyReminderRecord>; items: Map<number, QueueItem>; slackKeys: Map<string, AcceptedRecord | QueueKeyRecord>
  reactionKeys: Map<string, AcceptedRecord | QueueReactionKeyRecord>; openCount: number
  holds: Map<number, UnresolvedHold>
  itemChanges: ItemChange
}
/** Forward-only changes: the queue retains only the tail. A reader retains
 * changes since its last read, and dropping it requires no unsubscribe. */
interface ItemChange { next?: ItemChange; seq?: number }
// Key by the item reader so adapters that forward/copy the queue's methods
// retain its index without extending the DeliveryQueue interface.
const itemSources = new WeakMap<DeliveryQueue['item'], (key: string) => Journal>()
/** Internal incremental reader for the engine; DeliveryQueue's public read
 * contract stays unchanged. Injected queues without the index use full reads. */
export function createQueueItemReader(queue: DeliveryQueue, key: string): () => { reset: boolean; items: QueueItem[] } {
  let index: Journal['items'] | undefined, cursor: ItemChange | undefined
  return () => {
    const j = itemSources.get(queue.item)?.(key)
    if (!j) return { reset: true, items: queue.items(key) }
    if (index !== j.items) {
      index = j.items; cursor = j.itemChanges
      return { reset: true, items: queue.items(key) }
    }
    const changed = new Set<number>()
    while (cursor?.next) { changed.add(cursor.seq!); cursor = cursor.next }
    return { reset: false, items: [...changed].map(seq => queue.item(key, seq)!).filter(Boolean) }
  }
}
type AcceptOutcome = { result: QueueDecidedResult<unknown> } | { error: unknown }
/** One acceptance waiting in its persona's group. */
interface AcceptMember {
  decides?: boolean
  thread?: QueueEffectThread
  /** The key its duplicate check reads. */
  dedupeKey?: SlackKey
  /** A Reaction Item's key, which its duplicate check reads instead. */
  reactionKey?: ReactionKey
  /** Runs in the group's turn: checks, decides and returns the input to store, or its final result. */
  stage(): Promise<{ input: AcceptedInput; afterStore?: (stored: { seq: number }) => void; effectThread?: QueueEffectThread } | { result: QueueDecidedResult<unknown> }>
  /** Called once, in member order; must not throw. */
  settle(outcome: AcceptOutcome): void
}
interface StagedAccept { record: AcceptedRecord; turnStarted: number | undefined; afterStore?: (stored: { seq: number }) => void; effectThread?: QueueEffectThread }
interface BatchEntry { member: AcceptMember; staged?: StagedAccept; outcome?: AcceptOutcome }
interface PreparedAccept {
  member: AcceptMember; input?: AcceptedInput; afterStore?: (stored: { seq: number }) => void
  effectThread?: QueueEffectThread; receivedAt?: number; turnStarted?: number; outcome?: AcceptOutcome
}
interface AcceptGroup { members: AcceptMember[]; notify?: () => void }
interface StageCursor { nextSeq: number; lastInjected?: bigint }
function emptyJournal(): Journal { return { records: [], nextSeq: 1, loaded: false, reminders: new Map(), items: new Map(), slackKeys: new Map(), reactionKeys: new Map(), holds: new Map(), openCount: 0, itemChanges: {} } }
/** Queue snapshots contain only journal data (objects, arrays and scalars).
 * Freeze before descending so shared nested references are visited once. */
function freezeSnapshot<T>(value: T): T {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value)
    for (const nested of Object.values(value)) freezeSnapshot(nested)
  }
  return value
}
/** Compaction keeps the allocation mark and removes only closed items, so below
 * that mark a seq with no item was closed and compacted away (or its accepted
 * record was quarantined on replay). A seq at or above it was never allocated. */
const compactedClosed = (j: Journal, seq: number): boolean => positive(seq) && seq < j.nextSeq && !j.items.has(seq)
/** All file access is explicit; construction allocates only memory. */
export function createDeliveryQueue(options: DeliveryQueueOptions): ReplyReminderQueue {
  const fs = options.fs ?? nodeFs
  const now = options.now ?? Date.now
  const monotonicNow = options.monotonicNow ?? (() => performance.now())
  let measureTimings = options.measureTimings === true
  const dir = join(options.stateDir, 'queue')
  const { ensureDir, durableAppend, reconcileRollback, rewrite, read, opened } = createDurableJournal({ dir, parentDir: options.stateDir, directoryMode: QUEUE_DIRECTORY_MODE, fileMode: QUEUE_FILE_MODE, fs })
  const journals = new Map<string, Journal>()
  // Items and hold entries are replaced on changes, including rebuilds. Weak
  // keys let obsolete versions go without a second invalidation/eviction index.
  const snapshots = new WeakMap<object, object>()
  const writers = new Map<string, Promise<unknown>>()
  const appendBlocked = new Set<string>()
  const storingHolds = new Map<string, Map<number, UnresolvedHold>>()
  const formingAccepts = new Map<string, AcceptGroup>()
  const preparingHolds = new Map<string, Set<AcceptedInput>>()
  const maintenanceQueued = new Set<string>()
  const acceptanceBacklog = new Map<string, number>()
  const backlogCleared = new Map<string, Set<() => void>>()
  const startId = `${new Date(now()).toISOString().replace(/[:]/g, '-')}-${randomUUID()}`
  let started = false, stopped = false
  let timer: ReturnType<typeof globalThis.setInterval> | undefined
  let callerUuid: string | undefined
  const findings: QueueEvent[] = []
  function event(e: QueueEvent): void { if (e.type === 'record-unreadable') findings.push({ ...e }); try { void Promise.resolve(options.onEvent?.(e)).catch(() => {}) } catch { /* observers cannot change durable outcomes */ } }
  function pathFor(key: string): string {
    if (!PERSONA_KEY_RE.test(key)) throw new Error('Invalid queue persona key')
    return join(dir, `${key}.jsonl`)
  }
  function journal(key: string): Journal {
    pathFor(key)
    let j = journals.get(key)
    if (!j) { j = emptyJournal(); journals.set(key, j) }
    return j
  }
  function serial<T>(key: string, work: () => T | Promise<T>): Promise<T> {
    // Later acceptances must not join a group queued ahead of this work.
    formingAccepts.delete(key)
    const next = (writers.get(key) ?? Promise.resolve()).catch(() => {}).then(work)
    writers.set(key, next)
    return next
  }
  /** A running turn's first timing reading; no clock read unless measuring. */
  function turnStart(): number | undefined { return measureTimings ? monotonicNow() : undefined }
  /** The second reading, taken as the turn's append returns. */
  function timing(turnStarted: number | undefined): QueueStoreTiming | undefined {
    if (turnStarted === undefined) return undefined
    const atMonoMs = monotonicNow()
    return { storeMs: atMonoMs - turnStarted, atMonoMs }
  }
  function update(j: Journal, record: QueueRecord, replay = false): void {
    j.records.push(record); j.nextSeq = Math.max(j.nextSeq, record.seq + 1)
    if (!replay) indexRecord(j, record)
    if (record.kind === 'accepted') {
      const ts = 'compact' in record ? record.compact === 'allocation' ? record.injected_ts : undefined : injectedSource(record.source) ? record.ts : undefined
      if (ts) j.lastInjected = j.lastInjected !== undefined && j.lastInjected > microseconds(ts) ? j.lastInjected : microseconds(ts)
    }
  }
  /** Derive only the changed item; public snapshots never expose these records. */
  function summarize(accepted: AcceptedRecord, records: ItemRecord[]): QueueItem {
    const item: QueueItem = { accepted, records, delivered: false, unknownSend: false, retypeCount: 0, nextAttempt: (accepted.attempt_high_watermark ?? 0) + 1 }
    // The first durable outcome is final; a later conflicting one never replaces it.
    for (const r of records) {
      if (r.kind === 'fixed' && !item.withdrawn) item.fixed ??= r
      else if (r.kind === 'withdrawn' && !item.fixed && !item.withdrawn && accepted.source === 'reaction') item.withdrawn = r
      else if (r.kind === 'abandoned') item.abandoned ??= r
    }
    const refused = new Set(records.flatMap(r => r.kind === 'refused' ? [r.attempt] : []))
    for (const r of records) if (r.kind === 'refused' || r.kind === 'submitted' || r.kind === 'submission-blocked') item.nextAttempt = Math.max(item.nextAttempt, r.attempt + 1)
    for (const r of records) if (r.kind === 'sent') {
      item.nextAttempt = Math.max(item.nextAttempt, r.attempt + 1)
      if ('unknown_outcome' in r) item.unknownSend = true
      else if (r.send_kind === 'retype' && !refused.has(r.attempt)) item.retypeCount++
    }
    if (item.fixed) item.delivered = item.fixed.parts.every((_, i) => records.some(r => r.kind === 'delivered' && r.part === i + 1))
    if (accepted.hold) {
      const field = accepted.hold
      const first = records.findIndex(r => r.kind === 'released' || r.kind === 'hold-withdrawn')
      const resolution = first < 0 ? undefined : records[first] as HoldResolutionRecord
      // Only parking before the first saved resolution, of a Post Hold whose
      // root was unknown at arrival, turns it into a Memory Hold.
      const parked = field.on === 'post' && field.root_unknown && (first < 0 ? records : records.slice(0, first)).some(r => r.kind === 'parked')
      const kind: HoldKind = parked ? 'memory' : field.on
      item.hold = { field, kind, state: 'unresolved' }
      if (resolution) item.hold = { field, kind, state: resolution.kind === 'released' ? 'released' : 'withdrawn', at: resolution.at }
      else if (records.some(r => r.kind === 'fixed' || r.kind === 'sent' || r.kind === 'delivered')) {
        const times = records.flatMap(r => r.kind === 'sent' || r.kind === 'delivered' ? [r.at] : [])
        item.hold = { field, kind, state: 'released', at: times.length ? Math.min(...times) : accepted.received_at }
      }
    }
    return item
  }
  function indexHold(j: Journal, item: QueueItem): void {
    if (item.hold?.state === 'unresolved') j.holds.set(item.accepted.seq, unresolvedEntry(item.hold.field, item.hold.kind, item.accepted.seq, item.accepted.channel!))
    else j.holds.delete(item.accepted.seq)
  }
  function indexItem(j: Journal, item: QueueItem): void {
    j.items.set(item.accepted.seq, item)
    j.itemChanges.seq = item.accepted.seq
    j.itemChanges = j.itemChanges.next = {}
  }
  function indexRecord(j: Journal, record: QueueRecord): void {
    if (record.kind === 'reply-reminder') { j.reminders.set(record.seq, record); return }
    if (record.kind === 'accepted') {
      if ('key' in record && record.key) {
        const encoded = slackKeyString(record.key)
        if (!j.slackKeys.has(encoded)) j.slackKeys.set(encoded, record)
      }
      if ('reaction_key' in record && record.reaction_key) {
        const encoded = reactionKeyString(record.reaction_key)
        if (!j.reactionKeys.has(encoded)) j.reactionKeys.set(encoded, record)
      }
      if (isAccepted(record) && !j.items.has(record.seq)) {
        const item = summarize(record, [record])
        indexItem(j, item); indexHold(j, item); j.openCount += Number(isOpenItem(item))
      }
      return
    }
    const previous = j.items.get(record.seq)
    if (!previous) return
    const item = summarize(previous.accepted, [...previous.records, record])
    indexItem(j, item)
    indexHold(j, item)
    ensureReminder(j, item)
    j.openCount += Number(isOpenItem(item)) - Number(isOpenItem(previous))
  }
  function rebuild(j: Journal): void {
    j.items = new Map(); j.itemChanges = {}; j.slackKeys = new Map(); j.reactionKeys = new Map(); j.reminders = new Map(); j.holds = new Map(); j.openCount = 0
    // Replay groups records once, rather than repeatedly copying a long
    // history of retypes for the same item.
    for (const record of j.records) {
      if (record.kind === 'accepted' || record.kind === 'reply-reminder') indexRecord(j, record)
      else j.items.get(record.seq)?.records.push(record)
    }
    for (const [seq, previous] of j.items) {
      const item = summarize(previous.accepted, previous.records)
      indexItem(j, item)
      indexHold(j, item)
      ensureReminder(j, item)
      j.openCount += Number(isOpenItem(item)) - Number(isOpenItem(previous))
    }
  }
  function materialize(j: Journal): QueueItem[] {
    return [...j.items.values()].sort((a, b) => a.accepted.seq - b.accepted.seq)
  }
  function snapshot<T extends QueueItem | UnresolvedHold>(value: T): T {
    let cached = snapshots.get(value) as T | undefined
    if (!cached) {
      cached = freezeSnapshot(cloneJournalData(value))
      snapshots.set(value, cached)
    }
    return cached
  }
  async function load(key: string, scope?: TestSyncWorkScope): Promise<void> {
    const stored = journal(key)
    if (stored.loaded) return
    if (stored.pendingRecovery) { await finishRecovery(key, stored, scope); return }
    // Publish only a complete replay after quarantine is durable. Its existing
    // items must remain visible to startup preparation and delivery recovery.
    const j = emptyJournal()
    let bytes: Buffer
    try { bytes = read(pathFor(key)) } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') { stored.loaded = true; return }
      event({ type: 'recovery-failed', key, error }); throw error
    }
    const lines: { bytes: Buffer; line: number; record?: QueueRecord; raw?: Record<string, unknown>; whole: boolean }[] = []
    for (const split of splitJournalLines(bytes)) {
      const { text, whole } = split
      let raw: Record<string, unknown> | undefined
      try { const parsed: unknown = JSON.parse(text); if (object(parsed)) raw = parsed } catch {
        // A torn or syntactically damaged send can still identify its item. Retain
        // conservative unknown-outcome evidence, never the damaged text.
        const kind = /(?:^|[,{])\s*"kind"\s*:\s*"([^"\\]+)"/.exec(text)?.[1]
        const seqText = /(?:^|[,{])\s*"seq"\s*:\s*(\d+)(?=\s*[,}])/.exec(text)?.[1]
        const attemptText = /(?:^|[,{])\s*"attempt"\s*:\s*(\d+)(?=\s*[,}])/.exec(text)?.[1]
        if (kind !== undefined || seqText !== undefined) raw = { kind, seq: seqText === undefined ? undefined : Number(seqText), attempt: attemptText === undefined ? undefined : Number(attemptText) }
      }
      lines.push({ bytes: split.bytes, line: split.line, record: whole ? parseQueueRecord(text) : undefined, raw, whole })
    }
    const accepted = new Set(lines.flatMap(l => l.record && isAccepted(l.record) ? [l.record.seq] : []))
    const quarantinePath = join(dir, `${key}.unreadable-${startId}`)
    const damaged: typeof lines = []
    const seenAccept = new Set<number>()
    for (const l of lines) {
      const r = l.record
      const orphan = r && r.kind !== 'accepted' && r.kind !== 'reply-reminder' && !accepted.has(r.seq)
      const duplicate = r && isAccepted(r) && seenAccept.has(r.seq)
      if (!r || orphan || duplicate) { damaged.push(l); continue }
      if (isAccepted(r)) seenAccept.add(r.seq)
      update(j, r, true)
    }
    // Put accepted records first for recovery of valid out-of-order journal rows.
    j.records.sort((a, b) => a.seq - b.seq || (isAccepted(a) ? -1 : isAccepted(b) ? 1 : 0))
    rebuild(j)
    if (damaged.length) {
      // Exact original bytes, including torn tails, preserved before rewriting the source.
      await durableAppend(quarantinePath, Buffer.concat(damaged.map(l => l.bytes)), stored.quarantineRollback ??= {}, scope)
      for (const l of damaged) {
        const raw = l.raw
        const seq = raw?.seq
        if ((raw?.kind === 'sent' || raw?.kind === 'submitted') && integer(seq) && accepted.has(seq)) {
          const item = j.items.get(seq)!
          const attempt = positive(raw.attempt) && !item.records.some(r => (r.kind === 'sent' || r.kind === 'submitted') && r.attempt === raw.attempt) ? raw.attempt : item.nextAttempt
          if (raw.kind === 'submitted') update(j, { v: 1, kind: 'submission-blocked', seq, attempt, at: item.accepted.received_at, reason: 'damaged-submission: pair unknown; automatic resend forbidden' })
          else update(j, { v: 1, kind: 'sent', seq, attempt, unknown_outcome: true, at: item.accepted.received_at, quarantine: { path: quarantinePath, line: l.line } })
        }
        event({ type: 'record-unreadable', key, line: l.line, quarantinePath, alert: l.line !== lines.length && !(integer(seq) && accepted.has(seq)) && (raw?.kind === 'accepted' || !oneOf(['fixed', 'withdrawn', 'abandoned', 'sent', 'delivered', 'refused', 'noticed', 'released', 'hold-withdrawn', 'parked'], raw?.kind)) })
      }
      // Retry this exact replay, without appending the quarantined bytes again.
      // Rewriting also persists unknown-send markers atomically with removal of
      // the damage; truncating a torn send alone would lose that evidence.
      j.pendingRecovery = true
      journals.set(key, j)
      await finishRecovery(key, j, scope)
      return
    }
    j.loaded = true
    journals.set(key, j)
    loadedAfterStart(key)
  }
  async function finishRecovery(key: string, stored: Journal, scope?: TestSyncWorkScope): Promise<void> {
    try { await rewrite(pathFor(key), Buffer.from(stored.records.map(r => JSON.stringify(r) + '\n').join('')), scope) } catch (error) { event({ type: 'recovery-failed', key, error }); throw error }
    // A rename followed by failed directory fsync is still pending: no writer
    // can append until retry makes this same recovered journal durable.
    stored.pendingRecovery = false
    stored.loaded = true
    // Its thread facts are trusted only now, so a repair after start gets the
    // start's thread recovery in this turn, as a journal first read late does.
    loadedAfterStart(key)
  }
  function loadedAfterStart(key: string): void {
    if (started && !stopped) { try { options.onLoadedAfterStart?.(key) } catch { /* the published load stands */ } }
  }
  function lastSend(item: QueueItem): SentRecord | SubmittedRecord | undefined {
    const refused = new Set(item.records.flatMap(r => r.kind === 'refused' ? [r.attempt] : []))
    for (let i = item.records.length - 1; i >= 0; i--) {
      const record = item.records[i]!
      if ((record.kind === 'submitted' || (record.kind === 'sent' && !('unknown_outcome' in record))) && !refused.has(record.attempt)) return record
    }
    return undefined
  }
  function unrefusedAttempts(item: QueueItem): number[] {
    const refused = new Set(item.records.flatMap(r => r.kind === 'refused' ? [r.attempt] : []))
    return item.records.flatMap(r => (r.kind === 'sent' || r.kind === 'submitted') && !refused.has(r.attempt) ? [r.attempt] : [])
  }
  function deliveredSession(item: QueueItem, fallback: string): string {
    const handover = item.records.filter((r): r is DeliveredRecord => r.kind === 'delivered' && r.ad !== undefined).at(-1)
    return handover?.ad?.session_id ?? fallback
  }
  function reminderResolved(j: Journal, item: QueueItem): boolean {
    const record = j.reminders.get(item.accepted.seq)
    if (!record) return false
    if (record.state !== 'replied' || record.reply_attempts === undefined) return true
    const attempts = unrefusedAttempts(item)
    return record.reply_attempts.some(attempt => attempts.includes(attempt))
  }
  /** Derive missing initial facts from CSCB's delivery records, including a torn append. */
  function ensureReminder(j: Journal, item: QueueItem): void {
    if (!item.delivered || item.accepted.source !== 'slack' || reminderResolved(j, item)) return
    const sent = lastSend(item)
    if (!sent) return
    const delivered_at = Math.max(...item.records.flatMap(r => r.kind === 'delivered' ? [r.at] : []))
    j.reminders.set(item.accepted.seq, { v: 1, kind: 'reply-reminder', seq: item.accepted.seq, at: delivered_at, delivered_at, state: 'observed', session_id: deliveredSession(item, sent.session_id), delivery_attempts: unrefusedAttempts(item) })
  }
  function reminderExpired(record: ReplyReminderRecord, at = now()): boolean {
    // Older journals have only their last observation timestamp. Freeze that
    // fallback on the next observation instead of refreshing it indefinitely.
    return at - (record.delivered_at ?? record.at) >= REPLY_REMINDER_KEEP_MS
  }
  function replyCandidates(j: Journal): ReplyReminderRecord[] {
    return [...j.reminders.values()].filter(record => record.state === 'observed' && !reminderExpired(record))
  }
  function replySequences(j: Journal): number[] {
    return replyTargets(j).map(target => target.seq)
  }
  function replyTargets(j: Journal): ReplyCallTarget[] {
    const targets = new Map(replyCandidates(j).map(record => [record.seq, { seq: record.seq } as ReplyCallTarget]))
    for (const item of materialize(j)) {
      if (item.accepted.source !== 'slack' || item.abandoned) continue
      const attempts = unrefusedAttempts(item)
      const previous = j.reminders.get(item.accepted.seq)
      if (attempts.length && (!previous || previous.state === 'replied')) {
        targets.set(item.accepted.seq, { seq: item.accepted.seq, ...(item.delivered ? {} : { attempts }) })
      }
    }
    return [...targets.values()]
  }
  async function compactOne(key: string, current: () => boolean = () => true): Promise<void> {
    const scope = createTestSyncWorkScope('queue-compact-sync', key)
    try {
      scope?.phase('queue-phase-load')
      await load(key, scope)
      const j = journal(key)
      await reconcileRollback(pathFor(key), j, scope)
      // The caller's lifetime can end while the repair awaits the disk.
      if (!current()) return
      scope?.phase('queue-phase-selection')
      const selectionStart = testSyncWorkStart()
      const threadJoinSaved = options.threadJoinSaved?.(key)
      const at = now(), retained: QueueRecord[] = []
      const retainedJoinItems = new Set<number>()
      const queuedReminders = new Set(materialize(j).flatMap(item => item.accepted.reminder_for === undefined ? [] : [item.accepted.reminder_for]))
      for (const r of j.records) if (r.kind === 'accepted' && 'compact' in r && (r.compact === 'key' || r.compact === 'reaction-key') && at - r.received_at < QUEUE_KEY_KEEP_MS) retained.push(r)
      for (const item of materialize(j)) {
        if (item.abandoned) {
          // Operator resolution never discards text, attempts, receipts or dedupe.
          retained.push(...item.records)
        } else if (item.hold?.state === 'withdrawn') {
          if (item.accepted.key && at - item.accepted.received_at < QUEUE_KEY_KEEP_MS) retained.push({ v: 1, kind: 'accepted', seq: item.accepted.seq, compact: 'key', key: item.accepted.key, received_at: item.accepted.received_at, delivered_at: item.hold.at! })
        } else if (isQueueItemClosed(item)) {
          // Closed content goes; only a fresh key fact stays, unless Thread Memory
          // still needs the join copy. Open items keep their full record, key included.
          const a = item.accepted
          if (a.thread_join !== undefined && threadJoinSaved?.(a.channel!, a.thread_join) !== true) {
            retained.push(...item.records)
            retainedJoinItems.add(a.seq)
          } else if (at - a.received_at < QUEUE_KEY_KEEP_MS) {
            const closedAt = item.withdrawn?.at ?? Math.max(...item.records.flatMap(r => r.kind === 'delivered' ? [r.at] : []))
            if (a.key) retained.push({ v: 1, kind: 'accepted', seq: a.seq, compact: 'key', key: a.key, received_at: a.received_at, delivered_at: closedAt })
            else if (a.reaction_key) retained.push({ v: 1, kind: 'accepted', seq: a.seq, compact: 'reaction-key', reaction_key: a.reaction_key, received_at: a.received_at, closed_at: closedAt })
          }
        } else {
          const refused = new Set(item.records.flatMap(r => r.kind === 'refused' ? [r.attempt] : []))
          const removable = new Set(item.records.flatMap(r => r.kind === 'sent' && !('unknown_outcome' in r) && refused.has(r.attempt) ? [r.attempt] : []))
          const accepted = { ...item.accepted, attempt_high_watermark: item.nextAttempt - 1 }
          if (item.hold?.state === 'released') { delete accepted.hold; accepted.via = 'thread'; accepted.released_at = item.hold.at }
          // A parked Post Hold keeps only the Memory Hold form; its parked record goes below.
          else if (item.hold?.kind === 'memory' && item.hold.field.on === 'post') accepted.hold = memoryForm(item.hold.field)
          retained.push(accepted)
          retained.push(...item.records.filter(r => r.kind !== 'accepted' && !isHoldResolution(r) && !((r.kind === 'sent' || r.kind === 'refused') && removable.has(r.attempt))))
        }
      }
      // Pending reminder facts contain no delivered body, fixed text, or receipt
      // path. Suppression must outlive every full item retained for its join:
      // replay could otherwise derive a new candidate from its delivery facts.
      // Unfinished items keep suppression until delivery; other completed and
      // expired facts disappear without discarding accepted delivery work.
      for (const record of j.reminders.values()) {
        if (retainedJoinItems.has(record.seq)) {
          // A torn append can keep the reminder's acceptance but lose its
          // terminal fact. Preserve that evidence even if this compaction
          // removes the delivered reminder itself.
          retained.push(queuedReminders.has(record.seq) && record.state === 'observed' ? { ...record, state: 'nudged' } : record)
          continue
        }
        if (queuedReminders.has(record.seq)) continue
        if ((record.state === 'observed' && !reminderExpired(record, at)) || (j.items.has(record.seq) && isOpenItem(j.items.get(record.seq)!))) retained.push(record)
      }
      // Preserve both sequence allocation and the injected microsecond watermark forever.
      retained.push({ v: 1, kind: 'accepted', seq: j.nextSeq - 1, compact: 'allocation', ...(j.lastInjected === undefined ? {} : { injected_ts: formatMicros(j.lastInjected) }) })
      testSyncWorkEnd(selectionStart, 'queue-compact-selection', key)
      scope?.phase('queue-phase-stringify')
      const stringifyStart = testSyncWorkStart()
      let bytes: Buffer
      try { bytes = Buffer.from(retained.map(r => JSON.stringify(r) + '\n').join('')) }
      finally { testSyncWorkEnd(stringifyStart, 'queue-compact-stringify', key) }
      scope?.phase('queue-phase-write')
      await rewrite(pathFor(key), bytes, scope)
      scope?.phase('queue-phase-rebuild')
      j.records = retained
      const rebuildStart = testSyncWorkStart()
      try { rebuild(j) } finally { testSyncWorkEnd(rebuildStart, 'queue-compact-rebuild', key) }
    } finally { scope?.stop() }
  }
  function lookupSlackKey(key: string, slack: SlackKey): QueueAcceptResult | undefined {
    const j = journal(key)
    const encoded = slackKeyString(slack)
    const r = j.slackKeys.get(encoded)
    return r ? cloneJournalData({ status: 'duplicate' as const, seq: r.seq, item: j.items.get(r.seq) }) : undefined
  }
  // --- Group commit of acceptances
  /** Joins the persona's forming group, or queues a new one. A group forms
   * only while it is the last work queued for the persona, so acceptances
   * never pass other writes. */
  function enqueueAccept(key: string, member: AcceptMember): void {
    acceptanceBacklog.set(key, (acceptanceBacklog.get(key) ?? 0) + 1)
    let settled = false
    const settle = member.settle
    member.settle = outcome => {
      if (settled) return
      settled = true
      try { settle(outcome) } finally {
        const remaining = acceptanceBacklog.get(key)! - 1
        if (remaining) acceptanceBacklog.set(key, remaining)
        else {
          acceptanceBacklog.delete(key)
          const callbacks = backlogCleared.get(key)
          backlogCleared.delete(key)
          for (const callback of callbacks ?? []) { try { callback() } catch { /* an observer cannot change acceptance */ } }
        }
      }
    }
    const forming = formingAccepts.get(key)
    if (forming) { forming.members.push(member); forming.notify?.(); return }
    const group: AcceptGroup = { members: [member] }
    void serial(key, async () => {
      // An unexpected throw still answers every caller that has no result.
      try { await storeGroup(key, group) } catch (error) { for (const m of group.members) m.settle({ error }) }
      finally { if (formingAccepts.get(key) === group) formingAccepts.delete(key); preparingHolds.delete(key) }
    })
    formingAccepts.set(key, group)
  }
  /** Decisions remain serial while the single writer commits earlier batches.
   * A dependency drains those batches first; an independent decision freezes
   * its input without waiting for disk. Sequence allocation stays with the
   * writer, so a failed batch cannot leave gaps in a later batch. */
  async function storeGroup(key: string, group: AcceptGroup): Promise<void> {
    let batch: PreparedAccept[] = [], stores = 0, active = 0, index = 0
    let committed = Promise.resolve()
    const pendingKeys = new Map<string, number>(), pendingReactions = new Map<string, number>(), effectThreads = new Map<string, number>()
    let effects = 0, unknownThreads = 0
    const threadKey = (thread: QueueEffectThread) => JSON.stringify([thread.channel, thread.root])
    const count = (map: Map<string, number>, value: string, delta: number) => {
      const next = (map.get(value) ?? 0) + delta
      if (next) map.set(value, next); else map.delete(value)
    }
    const track = (entry: PreparedAccept, delta: number) => {
      if (entry.input?.key) count(pendingKeys, slackKeyString(entry.input.key), delta)
      if (entry.input?.reaction_key) count(pendingReactions, reactionKeyString(entry.input.reaction_key), delta)
      if (entry.afterStore) {
        effects += delta
        if (entry.effectThread) count(effectThreads, threadKey(entry.effectThread), delta)
        else unknownThreads += delta
      }
    }
    const flush = () => {
      if (!batch.length) return
      const prepared = batch; batch = []; stores = 0; active++
      committed = committed.then(async () => {
        const j = journal(key), cursor: StageCursor = { nextSeq: j.nextSeq, lastInjected: j.lastInjected }
        const entries: BatchEntry[] = prepared.map(entry => {
          if (!entry.input) return { member: entry.member, outcome: entry.outcome }
          preparingHolds.get(key)?.delete(entry.input)
          try {
            const turnStarted = entry.turnStarted ?? turnStart()
            const record = stageRecord(entry.input, cursor, entry.receivedAt)
            if (record.hold) {
              let storing = storingHolds.get(key)
              if (!storing) storingHolds.set(key, storing = new Map())
              storing.set(record.seq, unresolvedEntry(record.hold, record.hold.on, record.seq, record.channel!))
            }
            return { member: entry.member, staged: { record, turnStarted, afterStore: entry.afterStore, effectThread: entry.effectThread } }
          } catch (error) { return { member: entry.member, outcome: { error } } }
        })
        try { await commitBatch(key, entries) }
        catch (error) { for (const entry of prepared) entry.member.settle({ error }) }
        finally {
          for (const entry of prepared) if (entry.input) track(entry, -1)
          if (preparingHolds.get(key)?.size === 0) preparingHolds.delete(key)
          active--
        }
      })
    }
    for (;;) {
      while (index < group.members.length) {
        const member = group.members[index++]!
        const blocked = (member.dedupeKey && pendingKeys.has(slackKeyString(member.dedupeKey))) ||
          (member.reactionKey && pendingReactions.has(reactionKeyString(member.reactionKey))) ||
          (member.decides && (member.thread ? unknownThreads > 0 || effectThreads.has(threadKey(member.thread)) : effects > 0))
        if (blocked) { flush(); await committed }
        // Waiting for a prior group's writer is queueing, outside storeMs.
        // The first batch still includes its members' own staging work.
        const turnStarted = active === 0 ? turnStart() : undefined
        let entry: PreparedAccept
        try {
          const staged = await member.stage()
          if ('result' in staged) entry = { member, outcome: staged }
          else {
            const input = staged.input
            // Validate before exposing even retention-only facts. The real
            // sequence, injected watermark and item ID belong to the writer.
            const j = journal(key)
            const checked = stageRecord(input, { nextSeq: j.nextSeq, lastInjected: j.lastInjected }, undefined, false)
            const root = input.thread_join?.thread_ts ?? input.hold?.thread_ts ?? input.thread_ts ?? input.ts ?? input.key?.ts
            entry = { member, input, receivedAt: checked.received_at, turnStarted, afterStore: staged.afterStore,
              effectThread: staged.effectThread ?? (input.channel && root ? { channel: input.channel, root } : undefined) }
            if (input.hold) {
              let holds = preparingHolds.get(key)
              if (!holds) preparingHolds.set(key, holds = new Set())
              holds.add(input)
            }
            track(entry, 1)
            stores++
          }
        } catch (error) { entry = { member, outcome: { error } } }
        batch.push(entry)
        if (stores >= QUEUE_GROUP_COMMIT_MAX) flush()
      }
      flush()
      if (!active) { if (formingAccepts.get(key) === group) formingAccepts.delete(key); return }
      // New arrivals may join only while no other queue write has closed
      // this group. Wake to decide them even if the current fsync is held.
      await Promise.race([committed, new Promise<void>(resolve => { group.notify = resolve })])
      group.notify = undefined
    }
  }
  /** The next record in a batch; `cursor` carries the batch's unpublished sequence and injected watermark. */
  function stageRecord(input: AcceptedInput, cursor: StageCursor, received_at = input.received_at ?? now(), allocateId = true): AcceptedRecord {
    const candidate = BigInt(Math.trunc(received_at * 1000))
    const injected = cursor.lastInjected === undefined || candidate > cursor.lastInjected ? candidate : cursor.lastInjected + 1n
    // Reaction records keep their closed field set; covered sends derive their id instead.
    const record: AcceptedRecord = { ...input, v: 1, kind: 'accepted', ...(input.source === 'reaction' || !allocateId ? {} : { item_id: randomUUID() }), seq: cursor.nextSeq, received_at, ts: input.source === 'slack' ? input.ts ?? input.key?.ts ?? '' : input.source === 'reaction' ? input.ts ?? '' : formatMicros(injected) }
    if (!isQueueRecord(record)) throw new Error('Invalid accepted record')
    cursor.nextSeq = record.seq + 1
    if (injectedSource(record.source)) cursor.lastInjected = injected
    return record
  }
  /** One durable append for the batch's records; each member is published and
   * settled in order only after it, and every staged member fails with it.
   * `afterStore` runs in the same synchronous step that publishes its record. */
  async function commitBatch(key: string, entries: readonly BatchEntry[]): Promise<void> {
    const records = entries.flatMap(e => e.staged ? [e.staged.record] : [])
    let failure: { error: unknown } | undefined, atMonoMs: number | undefined
    if (records.length) {
      try {
        await durableAppend(pathFor(key), Buffer.from(records.map(r => JSON.stringify(r) + '\n').join('')), journal(key))
        if (measureTimings) atMonoMs = monotonicNow()
      } catch (error) { failure = { error } }
    }
    const j = records.length ? journal(key) : undefined
    if (j && !failure) for (const record of records) update(j, record)
    const storing = storingHolds.get(key)
    for (const record of records) storing?.delete(record.seq)
    if (storing?.size === 0) storingHolds.delete(key)
    for (const { member, staged, outcome } of entries) {
      if (!staged) { member.settle(outcome!); continue }
      if (failure) { member.settle(failure); continue }
      const { record, turnStarted, afterStore } = staged
      const store: QueueStoreKind = record.hold?.on === 'post' ? 'post-hold' : record.hold?.on === 'memory' ? 'memory-hold' : 'accepted'
      event(turnStarted !== undefined && atMonoMs !== undefined ? { type: 'stored', key, seq: record.seq, store, storeMs: atMonoMs - turnStarted, atMonoMs } : { type: 'stored', key })
      const item = cloneJournalData(j!.items.get(record.seq)!)
      try { afterStore?.({ seq: record.seq }) } catch { /* a saved acceptance cannot be undone by its observer */ }
      member.settle({ result: { status: 'accepted', seq: record.seq, item } })
    }
  }
  function storeFailed(key: string, input: AcceptedInput | undefined, error: unknown): QueueAcceptResult {
    event({ type: 'store-failed', key, path: PERSONA_KEY_RE.test(key) ? pathFor(key) : undefined, source: input?.source, sender: input?.sender, user: input?.user, bot_id: input?.bot_id, channel: input?.channel, ts: input?.ts ?? input?.key?.ts, edited_ts: input?.edited_ts ?? input?.key?.edited_ts, slackKey: input?.key, reactionKey: input?.source === 'reaction' && isReactionKey(input.reaction_key) ? { ...input.reaction_key } : undefined, error })
    return { status: 'failed', error }
  }
  function lookupReactionKey(key: string, reaction: ReactionKey): QueueAcceptResult | undefined {
    const j = journal(key)
    const r = j.reactionKeys.get(reactionKeyString(reaction))
    return r ? cloneJournalData({ status: 'duplicate' as const, seq: r.seq, item: j.items.get(r.seq) }) : undefined
  }
  async function compact(key?: string, current = () => true): Promise<void> {
    await Promise.all((key ? [key] : [...journals.keys()]).map(k => serial(k, async () => { if (!current()) return; try { await compactOne(k, current) } catch (error) { event({ type: 'compaction-failed', key: k, error }); throw error } })))
  }
  /** The maintenance timer's pass. A queue whose maintenance compaction is
   * queued and not yet started gets no second one: that one compacts the
   * state at or after this trigger. */
  async function compactForMaintenance(): Promise<void> {
    await Promise.all([...journals.keys()].filter(k => !maintenanceQueued.has(k)).map(k => {
      maintenanceQueued.add(k)
      return serial(k, async () => { maintenanceQueued.delete(k); try { await compactOne(k) } catch (error) { event({ type: 'compaction-failed', key: k, error }); throw error } })
    }))
  }
  /** One append/fsync boundary for reminder facts and their injected delivery. */
  async function appendReminderRecords(key: string, records: QueueRecord[]): Promise<void> {
    if (!started || stopped) throw new Error('Queue is not writable')
    if (!records.length) return
    const j = journal(key)
    await durableAppend(pathFor(key), Buffer.from(records.map(r => JSON.stringify(r) + '\n').join('')), j)
    for (const r of records) update(j, r)
  }
  // Values callers hand in are copied with structuredClone itself:
  // cloneJournalData copies only records the queue built or already copied.
  const api: ReplyReminderQueue = {
    memoryHoldStamps(key) {
      return [...api.unresolvedHolds(key).filter(hold => hold.memoryDependent).map(hold => ({ channel: hold.channel, stamp: hold.stamp })),
        ...[...preparingHolds.get(key) ?? []].filter(input => input.hold!.on === 'memory' || (input.hold!.on === 'post' && input.hold!.root_unknown))
          .map(input => ({ channel: input.channel!, stamp: structuredClone(input.hold!.stamp) }))]
    },
    hasAcceptanceBacklog: key => acceptanceBacklog.has(key),
    onAcceptanceBacklogCleared(key, callback) {
      if (!acceptanceBacklog.has(key)) { callback(); return () => {} }
      let callbacks = backlogCleared.get(key)
      if (!callbacks) backlogCleared.set(key, callbacks = new Set())
      callbacks.add(callback)
      return () => { callbacks.delete(callback); if (!callbacks.size && backlogCleared.get(key) === callbacks) backlogCleared.delete(key) }
    },
    callerUuid() {
      if (callerUuid) return callerUuid
      // start() has already ensured the queue directory.
      if (!started || stopped) throw new Error('Queue is not writable')
      const path = join(dir, 'caller-uuid')
      try {
        if (!fs.existsSync(path)) durableWriteFileSync(path, Buffer.from(randomUUID() + '\n'), {
          openSync: (name, flags) => fs.openSync(name, flags, QUEUE_FILE_MODE),
          writeSync: (fd, bytes, offset, length) => fs.writeSync(fd, bytes, offset, length),
          fsyncSync: fd => fs.fsyncSync(fd), closeSync: fd => fs.closeSync(fd),
          // Publish the fully synced private temp inode without replacing
          // an identity another queue/process published in the meantime.
          renameSync: (temp, target) => { fs.linkSync(temp, target); fs.unlinkSync(temp) },
          unlinkSync: name => fs.unlinkSync(name),
        })
      } catch (error) {
        if (error instanceof DurableWriteUnsyncedError || (error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
      }
      const dirFd = fs.openSync(dir, 'r')
      try { fs.fsyncSync(dirFd) } finally { fs.closeSync(dirFd) }
      const value = fs.readFileSync(path, 'utf8').trim()
      if (!/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/.test(value)) throw new Error('Invalid durable AD caller UUID; covered delivery held')
      // A prior failed creation may have left complete but unsynced bytes.
      const existing = fs.openSync(path, 'r')
      try { fs.fsyncSync(existing) } finally { fs.closeSync(existing) }
      callerUuid = value
      return value
    },
    replyReminderItems: key => replyCandidates(journal(key)).map(record => cloneJournalData(record)),
    replyCallTargets: key => replyTargets(journal(key)),
    async recordReplyCall(key, targets) {
      targets = structuredClone(targets)
      await serial(key, async () => {
        await load(key)
        const j = journal(key), records: ReplyReminderRecord[] = []
        for (const target of targets) {
          const previous = j.reminders.get(target.seq)
          if (previous?.state === 'nudged' || previous?.state === 'cancelled') continue
          let attempts = target.attempts
          if (attempts !== undefined) {
            const item = j.items.get(target.seq)
            const unrefused = item ? unrefusedAttempts(item) : previous?.delivery_attempts ?? []
            attempts = attempts.filter(attempt => unrefused.includes(attempt))
            if (!attempts.length) continue
            // Concurrent replies can settle in either order; retain the union
            // of their exact attempts rather than suppressing a later retry.
            if (previous?.state === 'replied') {
              if (previous.reply_attempts === undefined) continue
              attempts = [...new Set([...previous.reply_attempts, ...attempts])]
            }
          }
          records.push({ v: 1, kind: 'reply-reminder', seq: target.seq, at: now(), state: 'replied', ...(attempts === undefined ? {} : { reply_attempts: attempts }) })
        }
        await appendReminderRecords(key, records)
      })
    },
    async cancelReplyReminders(key) {
      await serial(key, async () => {
        await load(key)
        await appendReminderRecords(key, replySequences(journal(key)).map(seq => ({ v: 1, kind: 'reply-reminder', seq, at: now(), state: 'cancelled' })))
      })
    },
    async observeReplyReminders(key, row, text, enabled, current) {
      return serial(key, async () => {
        await load(key)
        if (!current()) return []
        const j = journal(key), records: QueueRecord[] = [], injected: number[] = []
        let seq = j.nextSeq
        let injectedAt = j.lastInjected
        const items = materialize(j)
        for (const previous of replyCandidates(j)) {
          const originalSeq = previous.seq
          const alreadyQueued = items.some(other => other.accepted.reminder_for === originalSeq)
          const sameLife = previous.session_id === row.session_id && (previous.row_state === undefined || previous.launch_started_at === row.launch_started_at)
          const cancelled = !enabled || !sameLife || ['pending', 'ended', 'missing', 'error'].includes(row.state)
          // SR-5.6: a waiting row may still have input awaiting Turn Start.
          const turnTaken = row.busy_send !== 'covered' || row.delivery?.awaiting_turn_start === 0
          const nudge = !cancelled && turnTaken && previous.row_state === 'working' && row.state === 'waiting'
          if (!cancelled && !turnTaken) continue
          if (!alreadyQueued && !cancelled && !nudge && previous.row_state === row.state && sameLife) continue
          if (nudge && !alreadyQueued) {
            const at = now(), candidate = BigInt(Math.trunc(at * 1000))
            injectedAt = injectedAt === undefined || candidate > injectedAt ? candidate : injectedAt + 1n
            // Acceptance precedes resolution: a torn append can replay it and
            // recover the missing resolution without accepting a duplicate.
            const accepted: AcceptedRecord = { v: 1, kind: 'accepted', item_id: randomUUID(), seq: seq++, source: 'interject', sender: 'reply-reminder', text, received_at: at, ts: formatMicros(injectedAt), reminder_for: originalSeq }
            records.push(accepted); injected.push(accepted.seq)
          }
          records.push({ v: 1, kind: 'reply-reminder', seq: originalSeq, at: now(), delivered_at: previous.delivered_at ?? previous.at, state: cancelled ? 'cancelled' : alreadyQueued || nudge ? 'nudged' : 'observed', row_state: row.state, session_id: row.session_id, launch_started_at: row.launch_started_at, ...(previous.delivery_attempts === undefined ? {} : { delivery_attempts: previous.delivery_attempts }) })
        }
        await appendReminderRecords(key, records)
        return injected.map(seq => cloneJournalData(j.items.get(seq)!))
      })
    },
    async start() {
      if (started) return
      await ensureDir()
      const keys = fs.readdirSync(dir).filter(p => p.endsWith('.jsonl')).map(p => p.slice(0, -6))
      for (const key of keys) {
        // stop() waits only for writers that exist when it runs.
        if (stopped) return
        try { await serial(key, () => compactOne(key, () => !stopped)) } catch { /* inaccessible queues refuse acceptance; other personas still recover */ }
      }
      started = true
    },
    async accept(key, input) {
      try {
        if (!started || stopped) throw new Error('Queue is not accepting')
        input = structuredClone(input)
      } catch (error) { return storeFailed(key, input, error) }
      const dedupeKey = input.source === 'slack' ? input.key : undefined
      const reactionKey = input.source === 'reaction' && isReactionKey(input.reaction_key) ? input.reaction_key : undefined
      return new Promise<QueueAcceptResult>(resolve => enqueueAccept(key, {
        dedupeKey,
        reactionKey,
        async stage() {
          await load(key)
          if (dedupeKey) { const existing = lookupSlackKey(key, dedupeKey); if (existing) return { result: existing } }
          if (reactionKey) { const existing = lookupReactionKey(key, reactionKey); if (existing) return { result: existing } }
          return { input }
        },
        settle: outcome => resolve('error' in outcome ? storeFailed(key, input, outcome.error) : outcome.result as QueueAcceptResult),
      }))
    },
    async acceptDecided<T>(key: string, slackKey: SlackKey | undefined, decide: (facts: { keyChecked: boolean }) => QueueAcceptDecision<T>, thread?: QueueEffectThread): Promise<QueueDecidedResult<T>> {
      let input: AcceptedInput | undefined
      try { slackKey = structuredClone(slackKey); thread = structuredClone(thread) } catch (error) { return storeFailed(key, input, error) }
      return new Promise<QueueDecidedResult<T>>(resolve => enqueueAccept(key, {
        dedupeKey: slackKey,
        decides: true,
        thread,
        async stage() {
          let keyChecked = false, unavailable: unknown
          try {
            if (!started || stopped) throw new Error('Queue is not accepting')
            await load(key)
            const duplicate = slackKey ? lookupSlackKey(key, slackKey) : undefined
            if (duplicate) return { result: duplicate }
            keyChecked = true
          } catch (error) { unavailable = error }
          const decision = decide({ keyChecked })
          if ('skip' in decision) return { result: { status: 'skipped' as const, outcome: decision.skip } }
          input = structuredClone(decision.store)
          if (!keyChecked) throw unavailable
          return { input, afterStore: decision.afterStore, effectThread: structuredClone(decision.effectThread) }
        },
        settle: outcome => resolve('error' in outcome ? storeFailed(key, input, outcome.error) : outcome.result as QueueDecidedResult<T>),
      }))
    },
    async abandon(key, seq, at) {
      const path = pathFor(key)
      return serial(key, async () => {
        if (!started || stopped) throw new Error('Queue is not writable')
        const storageFailed = (error: unknown): never => {
          appendBlocked.add(key)
          event({ type: 'append-failed', key, path, seq, error })
          throw error
        }
        try { await load(key) } catch (error) { storageFailed(error) }
        const j = journal(key), item = j.items.get(seq)
        if (!item) return 'unknown'
        if (item.delivered) return 'delivered'
        if (item.abandoned) return 'already-abandoned'
        if (materialize(j).find(isOpenItem)?.accepted.seq !== seq) return 'not-head'
        const record: AbandonedRecord = { v: 1, kind: 'abandoned', seq, at }
        if (!isQueueRecord(record)) throw new Error('Invalid abandonment record')
        try { await durableAppend(path, Buffer.from(JSON.stringify(record) + '\n'), j) } catch (error) { storageFailed(error) }
        update(j, record)
        if (appendBlocked.delete(key)) event({ type: 'writable', key })
        return 'abandoned'
      })
    },
    async append(key, record) {
      if (!started || stopped) throw new Error('Queue is not writable')
      record = structuredClone(record)
      const path = pathFor(key)
      const storageFailed = (error: unknown): never => {
        appendBlocked.add(key)
        event({ type: 'append-failed', key, path, seq: record.seq, error })
        throw error
      }
      await serial(key, async () => {
        // Only a fixation is timed: N4's fallback is measured from its turn's start.
        const turnStarted = record.kind === 'fixed' ? turnStart() : undefined
        try { await load(key) } catch (error) { storageFailed(error) }
        const j = journal(key)
        if (!isQueueRecord(record) || record.kind === 'accepted' || record.kind === 'reply-reminder' || record.kind === 'abandoned' || isHoldResolution(record)) throw new Error('Invalid append record')
        const item = j.items.get(record.seq)
        if (!item) {
          if ((record.kind === 'fixed' || record.kind === 'withdrawn') && compactedClosed(j, record.seq)) throw new QueueOutcomeFinal('Closed item was compacted')
          throw new Error('Append has no accepted item')
        }
        if (item.abandoned) throw new QueueOutcomeFinal('Abandoned item is closed')
        // A durable fixed or withdrawn outcome is never decided again, and a
        // withdrawn item takes no attempt, receipt or notice.
        if (record.kind === 'withdrawn') {
          if (item.accepted.source !== 'reaction') throw new QueueNotWithdrawable('Only reaction items may be withdrawn')
          if (item.withdrawn) {
            if (sameWithdrawal(item.withdrawn, record)) return
            throw new QueueOutcomeFinal('Withdrawal is immutable')
          }
          if (item.fixed) throw new QueueOutcomeFinal('Fixed item cannot be withdrawn')
          if (item.records.some(r => r.kind !== 'accepted')) throw new QueueOutcomeFinal('Attempted item cannot be withdrawn')
        } else if (item.withdrawn) throw new QueueOutcomeFinal('Withdrawn item is closed')
        // Immutable fixation and stable attempt identifiers allow safe retry after failures.
        if (record.kind === 'fixed' && item.fixed) {
          if (JSON.stringify(item.fixed) !== JSON.stringify(record)) throw new Error('Fixed text is immutable')
          return
        }
        if ((record.kind === 'sent' || record.kind === 'submitted') && record.attempt < item.nextAttempt) throw new Error('Attempt number must increase')
        if (record.kind === 'submitted' && (!item.fixed || record.part > item.fixed.parts.length)) throw new Error('Submission has no fixed part')
        if (record.kind === 'refused') {
          const attempt = record.attempt
          if (!item.records.some(r => (r.kind === 'submitted' || (r.kind === 'sent' && !('unknown_outcome' in r))) && r.attempt === attempt)) throw new Error('Refusal has no sent attempt')
        }
        if (record.kind === 'delivered' && (!item.fixed || record.part > item.fixed.parts.length)) throw new Error('Receipt has no fixed part')
        const records: QueueRecord[] = [record]
        if (record.kind === 'delivered') {
          const deliveredItem = summarize(item.accepted, [...item.records, record])
          const sent = lastSend(deliveredItem)
          if (deliveredItem.delivered && item.accepted.source === 'slack' && sent && !reminderResolved(j, deliveredItem)) records.push({ v: 1, kind: 'reply-reminder', seq: record.seq, at: record.at, state: 'observed', session_id: deliveredSession(deliveredItem, sent.session_id), delivery_attempts: unrefusedAttempts(deliveredItem) })
        }
        const bytes = Buffer.from(records.map(r => JSON.stringify(r) + '\n').join(''))
        try { await durableAppend(path, bytes, j) } catch (error) { storageFailed(error) }
        const timed = timing(turnStarted)
        for (const next of records) update(j, next)
        if (timed) event({ type: 'fixed-stored', key, seq: record.seq, ...timed })
        // Only a durable write clears a block; an identical fixed or withdrawn retry writes nothing.
        if (appendBlocked.delete(key)) event({ type: 'writable', key })
      })
    },
    async rememberQueuedReaction(key, seq, name) {
      return serial(key, async () => {
        if (!started || stopped) throw new Error('Queue is not writable')
        await load(key)
        const j = journal(key), item = j.items.get(seq)
        if (!item || item.accepted.source !== 'slack') return undefined
        if (item.accepted.queued_ack_reaction) return item.accepted.queued_ack_reaction
        // Delivery may have completed while reporting waited for its turn.
        if (!isOpenItem(item)) return undefined
        const accepted = { ...item.accepted, queued_ack_reaction: name }
        if (!isQueueRecord(accepted)) throw new Error('Invalid queued reaction')
        await reconcileRollback(pathFor(key), j)
        const records = j.records.map(r => isAccepted(r) && r.seq === seq ? accepted : r)
        await rewrite(pathFor(key), Buffer.from(records.map(r => JSON.stringify(r) + '\n').join('')))
        j.records = records
        rebuild(j)
        return name
      })
    },
    lookupSlackKey,
    lookupReactionKey,
    item(key, seq) {
      const item = journal(key).items.get(seq)
      return item ? snapshot(item) : undefined
    },
    items: key => materialize(journal(key)).map(snapshot),
    openCount: key => journal(key).openCount,
    unresolvedHolds(key) {
      const holds = new Map(journal(key).holds)
      for (const [seq, storing] of storingHolds.get(key) ?? []) holds.set(seq, storing)
      return [...holds.values()].sort((a, b) => a.seq - b.seq).map(snapshot)
    },
    async resolveHolds(key, resolutions, current = () => true, onCommitted) {
      const copy = structuredClone(resolutions)
      const path = pathFor(key)
      // As in append: only a storage failure blocks the journal.
      const storageFailed = (error: unknown): never => {
        appendBlocked.add(key)
        event({ type: 'append-failed', key, path, error })
        throw error
      }
      return await serial(key, async () => {
        const turnStarted = turnStart()
        if (!current()) return []
        if (!started || stopped) throw new Error('Queue is not writable')
        try { await load(key) } catch (error) { storageFailed(error) }
        if (!current()) return []
        const j = journal(key), seen = new Set<number>(), saved: HoldResolution[] = []
        for (const resolution of copy) {
          const hold = j.holds.get(resolution.seq)
          if (!hold || seen.has(resolution.seq)) continue
          // An exact string first: the kind lookup below would coerce ['withdrawn'] to a valid key.
          if (!oneOf(HOLD_OUTCOMES, resolution.outcome)) throw new Error('Invalid hold resolution')
          // Only an unparked Post Hold whose root was unknown at arrival parks.
          if (resolution.outcome === 'parked' && !(hold.on === 'post' && hold.root_unknown)) continue
          const record = { v: 1 as const, kind: HOLD_RESOLUTION_KINDS[resolution.outcome], seq: resolution.seq, at: resolution.at }
          if (!isQueueRecord(record) || !isHoldResolution(record)) throw new Error('Invalid hold resolution')
          saved.push(resolution); seen.add(resolution.seq)
        }
        if (!saved.length) return []
        const records: HoldResolutionRecord[] = saved.map(r => ({ v: 1, kind: HOLD_RESOLUTION_KINDS[r.outcome], seq: r.seq, at: r.at }))
        try { await durableAppend(path, Buffer.from(records.map(r => JSON.stringify(r) + '\n').join('')), j) } catch (error) { storageFailed(error) }
        const timed = timing(turnStarted)
        for (const record of records) update(j, record)
        const wasBlocked = appendBlocked.delete(key)
        // Transfer committed evidence before a queue observer can submit
        // teardown. Never turn an observer failure into an append failure.
        try { void Promise.resolve(onCommitted?.(cloneJournalData(saved))).catch(() => {}) } catch { /* saved facts remain saved */ }
        if (wasBlocked) event({ type: 'writable', key })
        event({ type: 'holds-resolved', key, resolutions: cloneJournalData(saved), ...timed })
        return saved
      })
    },
    isWritable: key => !appendBlocked.has(key) && !journals.get(key)?.pendingRecovery,
    durabilityPending: key => journals.get(key)?.pendingRecovery === true,
    keys: () => [...journals.keys()],
    compact,
    setMeasureTimings(enabled) { measureTimings = enabled },
    journalOpened: key => opened(pathFor(key)),
    startMaintenance(intervalMs) {
      if (timer !== undefined || stopped) return
      timer = (options.setInterval ?? globalThis.setInterval)(() => { void compactForMaintenance().catch(() => {}) }, intervalMs ?? options.compactIntervalMs ?? QUEUE_COMPACT_INTERVAL_MS)
      timer.unref?.()
    },
    async stop() {
      stopped = true
      if (timer !== undefined) (options.clearInterval ?? globalThis.clearInterval)(timer)
      timer = undefined
      await Promise.allSettled([...writers.values()])
    },
    startupFindings: () => findings.map(e => ({ ...e })),
    retained(key) { event({ type: 'retained', key, count: api.openCount(key) }) },
  }
  itemSources.set(api.item, journal)
  return api
}
