/** Production participation, queue and routing composition in caller-owned scratch state. */
import * as fs from 'node:fs'
import { basename, join } from 'node:path'
import { createThreadParticipation, type OwnPostPosted, type OwnPostSurface, type ThreadObservation, type ThreadParticipation } from '../../src/thread-participation.ts'
import type { MembershipReading } from '../../src/channel-membership.ts'
import { parseQueueRecord, type DeliveryQueueOptions, type QueueItem, type QueueRecord } from '../../src/delivery-queue.ts'
import { createQueuedAckCallback, createDeliveryAckCallback } from '../../src/ack-tracker.ts'
import { createDeliveryReporting } from '../../src/delivery-notices.ts'
import { makeDeliveryNoticeHarness } from './delivery-notices.ts'
import type { ChannelMode, DeliveryMode } from '../../src/config.ts'
import { makeRoutingHarness, observedMembership, NEVER_FIRE_RESTART_DELAY_S, type RoutingHarnessOptions } from './persona-routing-harness.ts'
import { createFakeClock } from './fake-clock.ts'
import { makeChannelMessage, mentionText, type SlackEvent } from './slack-stub.ts'
import { SHARED_CHANNEL_IDS } from './shared-channels.ts'
import { queuePath, readQueue, slackInput } from './delivery-queue.ts'
import { assertNoLeak, writtenFile } from './credentials.ts'

export const THREAD_CHANNEL = SHARED_CHANNEL_IDS.primary
export const THREAD_OTHER_CHANNEL = SHARED_CHANNEL_IDS.secondary
export const THREAD_ROOT = '1700000000.000100'
export const THREAD_OTHER_ROOT = '1700000000.000200'
export const threadReply = (overrides: Partial<SlackEvent> = {}): SlackEvent => makeChannelMessage({
  channel: THREAD_CHANNEL, thread_ts: THREAD_ROOT, ts: '1700000000.000101', text: '  original reply\r\n\tsecond line\n\n', ...overrides,
})
/** Controlled promise, used only at the production interruption seams. */
export function threadHold() {
  let release!: () => void
  let arrive!: () => void
  const entered = new Promise<void>(resolve => { arrive = resolve })
  const pending = new Promise<void>(resolve => { release = resolve })
  return { entered, release, wait: async () => { arrive(); await pending } }
}

export type ThreadFault = 'read' | 'write' | 'fsync' | 'recovery-fsync' | 'ambiguous' | 'rewrite' | 'truncate'
/** Faults target parsed production records, or for rewrite/truncate the persona's journal file;
 * unrelated personas and writes run normally. */
export function threadDisk() {
  const failures: ThreadFault[] = []
  let fault: { kind: ThreadFault; key: string; record: QueueRecord['kind'] } | undefined
  const handles = new Map<number, string>(), targeted = new Set<number>()
  const failure = () => Object.assign(new Error('injected participation disk failure'), { code: 'EIO' })
  const io = { ...fs,
    openSync(...args: Parameters<typeof fs.openSync>) { const fd = fs.openSync(...args); handles.set(fd, String(args[0])); return fd },
    closeSync(fd: number) { handles.delete(fd); targeted.delete(fd); fs.closeSync(fd) },
    readFileSync: ((path: fs.PathOrFileDescriptor, ...args: unknown[]) => {
      if (fault?.kind === 'read' && basename(String(path)) === `${fault.key}.jsonl`) throw failure()
      return (fs.readFileSync as Function)(path, ...args)
    }) as typeof fs.readFileSync,
    writeSync: ((fd: number, bytes: Uint8Array, offset: number, length: number) => {
      const records = Buffer.from(bytes).subarray(offset, offset + length).toString().split('\n').filter(Boolean).map(parseQueueRecord)
      const name = basename(handles.get(fd) ?? '')
      if (fault && (name === `${fault.key}.jsonl` || name.startsWith(`${fault.key}.jsonl.`)) && records.some(r => r?.kind === fault!.record)) {
        targeted.add(fd)
        if (fault.kind === 'write') { failures.push(fault.kind); throw failure() }
      }
      return fs.writeSync(fd, bytes, offset, length)
    }) as typeof fs.writeSync,
    fsyncSync(fd: number) {
      if (fault?.kind === 'recovery-fsync' && basename(handles.get(fd) ?? '') === `${fault.key}.jsonl`) { failures.push(fault.kind); throw failure() }
      if (targeted.has(fd) && (fault?.kind === 'fsync' || fault?.kind === 'ambiguous')) { failures.push(fault.kind); throw failure() }
      fs.fsyncSync(fd)
    },
    ftruncateSync(fd: number, length: number) {
      if (fault?.kind === 'truncate' && basename(handles.get(fd) ?? '') === `${fault.key}.jsonl`) { failures.push(fault.kind); throw failure() }
      if (targeted.has(fd) && fault?.kind === 'ambiguous') throw failure()
      fs.ftruncateSync(fd, length)
    },
    renameSync(from: fs.PathLike, to: fs.PathLike) {
      if (fault?.kind === 'rewrite' && basename(String(to)) === `${fault.key}.jsonl`) { failures.push(fault.kind); throw failure() }
      fs.renameSync(from, to)
    },
  } as typeof fs
  return { fs: io, failures, fail(kind: ThreadFault, record: QueueRecord['kind'] = 'accepted', key = 'alpha') { fault = { kind, record, key } },
    repair() { fault = undefined; targeted.clear() } }
}

export async function makeThreadHarness(stateDir: string, options: {
  mode?: ChannelMode; delivery?: DeliveryMode; names?: string[]; clock?: ReturnType<typeof createFakeClock>;
  disk?: ReturnType<typeof threadDisk>; routing?: RoutingHarnessOptions; queue?: Omit<DeliveryQueueOptions, 'stateDir'>;
  /** Runs after the real observation save resolves, before its caller continues. */
  afterObservationSave?: (key: string, observation: ThreadObservation) => Promise<void>;
  /** Runs before the real observation save starts (the first await of an own-post confirmation). */
  beforeObservationSave?: (key: string, observation: ThreadObservation, state?: 'observed' | 'enrolled') => Promise<void>;
  /** An error returned here is thrown in place of the production recovery call. */
  recoverFault?: (key: string, id?: string) => Error | undefined;
} = {}) {
  const names = options.names ?? ['alpha', 'beta']
  const clock = options.clock ?? createFakeClock({ start: 1_700_000_000_000 })
  const disk = options.disk ?? threadDisk()
  const received: Array<{ key: string; item: QueueItem }> = [], failed: string[] = [], settled: string[] = []
  const failures: Array<{ key: string; id: string; unaccepted: boolean }> = []
  const reactions: Promise<void>[] = []
  let reporting: ReturnType<typeof createDeliveryReporting> | undefined
  const hooks = options.routing?.routingHooks
  // Current membership is independent evidence: every persona eligible in both channels unless a case overrides one reading.
  const observed = observedMembership(Object.fromEntries(names.map(n => [n, [THREAD_CHANNEL, THREAD_OTHER_CHANNEL]])))
  const membership = new Map<string, MembershipReading>()
  const h = makeRoutingHarness(names.map(name => ({ name, channels: [THREAD_CHANNEL, THREAD_OTHER_CHANNEL].map(id => ({ id, delivery: options.delivery ?? 'thread_hybrid' })),
    dm: { enabled: true, contact: 'U0OPERATOR' }, permission_prompts: 'dm' })), stateDir, {
    mode: options.mode ?? 'strict',
    membership: { ...observed, read: (key, channel, mode) => membership.get(`${key}:${channel}`) ?? observed.read(key, channel, mode) },
    onOwnPost: outcome => reporting?.ownPostObserved(outcome),
    participation: true, upCheck: true, preparationClock: clock, dedupeClock: clock.now,
    restartDelayS: NEVER_FIRE_RESTART_DELAY_S, channelDelivery: { stateDir }, ...options.routing,
    queueOptions: { fs: disk.fs, ...options.queue, onEvent(event) { reporting?.queueEvent(event); options.queue?.onEvent?.(event) } },
    routingHooks: { ...hooks,
      beginIntake(key) {
        const release = reporting!.beginIntake(key), releaseHook = hooks?.beginIntake?.(key)
        return () => { release(); releaseHook?.() }
      },
      onReceived(key, item) { received.push({ key, item }); reporting!.received(key, item); hooks?.onReceived?.(key, item) },
      onParticipationFailure(key, id, event, error, unaccepted = false) {
        failed.push(id); failures.push({ key, id, unaccepted })
        reporting!.participationFailed(key, id, event, error, unaccepted); hooks?.onParticipationFailure?.(key, id, event, error, unaccepted)
      },
      onParticipationSettled(key, id) { settled.push(id); reporting!.participationSettled(key, id); hooks?.onParticipationSettled?.(key, id) },
    },
  })
  const queued = createQueuedAckCallback({ queue: h.queue, getReaction: () => h.config!.queued_ack_reaction, clientFor: key => h.p(key).stub.web })
  const delivered = createDeliveryAckCallback({ getReaction: () => h.config!.ack_reaction, clientFor: key => h.p(key).stub.web })
  const notices = await makeDeliveryNoticeHarness({ queue: h.queue })
  reporting = createDeliveryReporting({ queue: h.queue, episodes: notices.rig.episodes, persona: key => h.config?.personas.find(p => p.key === key),
    state: key => ({ up: !h.notUp.has(key) }), now: clock.now, log: line => h.logs.push(line), notify: (key, text) => notices.h.notifier.notify(key, text), defer: notices.defer,
    ownPostFindings: key => h.participation?.ownPostFindings(key) ?? [],
    queued(key, item) { const promise = queued(key, item); reactions.push(promise); return promise },
    delivered(key, item) { const promise = delivered(key, item); reactions.push(promise); return promise },
  })
  await h.ready
  // Installed after startup recovery and only when requested, so hook-free tests run the unwrapped production calls.
  const { recoverFault, afterObservationSave, beforeObservationSave } = options
  const instrument = (owner: ThreadParticipation) => {
    if (!recoverFault) return owner
    const recover = owner.recover.bind(owner)
    owner.recover = (key, id) => { const error = recoverFault(key, id); if (error) throw error; return recover(key, id) }
    return owner
  }
  instrument(h.participation!)
  if (afterObservationSave || beforeObservationSave) {
    const save = h.queue.recordThreadObservation.bind(h.queue)
    h.queue.recordThreadObservation = async (key, observation, state) => {
      await beforeObservationSave?.(key, observation, state)
      const saved = await save(key, observation, state)
      await afterObservationSave?.(key, observation)
      return saved
    }
  }
  const result = {
    h, clock, disk, stateDir, received, failed, failures, settled, reporting, notices, membership,
    get threads() { return h.participation! },
    get authority() { return h.channelDelivery!.authority },
    mention(overrides: Partial<SlackEvent> = {}, key = 'alpha') {
      return makeChannelMessage({ channel: THREAD_CHANNEL, ts: THREAD_ROOT, text: mentionText(h.p(key).stub.identity.botUserId), ...overrides })
    },
    read(root: string = THREAD_ROOT, key = 'alpha', channel: string = THREAD_CHANNEL) { return h.participation!.read(key, channel, root).kind },
    async drainReactions() { await clock.flush(); await Promise.all(reactions) },
    async receive(event: unknown, keys: string[] = ['alpha']) {
      let acknowledged = 0
      await h.routing.receive(event, () => { acknowledged++ }, keys, false)
      await result.drainReactions()
      return { returned: true, acknowledged }
    },
    async choose(delivery: DeliveryMode, key = 'alpha', channel = THREAD_CHANNEL) {
      const a = result.authority
      const outcome = a.assign(key, a.incarnation(key)!, channel, delivery, a.revision)
      if (outcome.kind !== 'applied') throw new Error(`fixture choice failed: ${outcome.kind}`)
    },
    /** Applies an edit of the applied source config through the reviewed shared-config path, as a live config change does. */
    reviewConfig(edit: (applied: { channel_mode?: ChannelMode; personas: Array<Record<string, any>> }) => void) {
      const a = result.authority, applied = JSON.parse(a.sourceBytes().toString())
      edit(applied)
      const outcome = a.applyReviewed(Buffer.from(JSON.stringify(applied)), a.revision)
      if (outcome.kind !== 'applied') throw new Error(`fixture config change failed: ${outcome.kind}`)
    },
    chooseMode(mode: ChannelMode) {
      result.reviewConfig(applied => { applied.channel_mode = mode })
      if (h.config!.channel_mode !== mode) throw new Error('fixture mode change failed')
    },
    /** A persona's applied source entry, by key; throws when the applied config has none. */
    personaEntry(applied: { personas: Array<Record<string, any>> }, key: string) {
      const persona = applied.personas.find(p => (p.key ?? p.name) === key)
      if (!persona) throw new Error(`fixture config change has no persona ${key}`)
      return persona
    },
    /** Applies a persona's permission_prompts destination through the reviewed shared-config path. */
    chooseDestination(key: string, destination: string) {
      result.reviewConfig(applied => { result.personaEntry(applied, key).permission_prompts = destination })
      if (h.config!.personas.find(p => p.key === key)?.permission_prompts !== destination) throw new Error('fixture destination change failed')
    },
    restoreOwner() {
      h.participation!.stop()
      h.participation = instrument(createThreadParticipation({ queue: h.queue, authority: result.authority, ...h.ownPostOptions }))
      h.participation.start()
    },
    /** One confirmed own post through the production owner: identity captured at issue, Slack's success facts at confirm. */
    confirmPost(posted: OwnPostPosted, key = 'alpha', surface: OwnPostSurface = 'text') {
      const issue = h.participation!.issueOwnPost(key, surface)
      return { issue, outcome: h.participation!.confirmOwnPost(issue, posted) }
    },
    async close() {
      reporting!.stop(); await result.drainReactions(); await h.close()
      assertNoLeak({ captured: h.captured(), notices: notices.h.allPosts(), noticeLogs: notices.logs, queue: writtenFile(join(stateDir, 'queue')), authority: writtenFile(result.authority.path) })
      await notices.cleanup()
    },
  }
  return result
}
export type ThreadHarness = Awaited<ReturnType<typeof makeThreadHarness>>

/** Reseeds a closed production journal with its newest record's bytes cut to an unfinished append (`final`),
 * or, as complete damage, newline-terminated at the end (`terminated`) or after the first record (`mid`).
 * The cut is a byte offset: at the midpoint, or after the first byte of the multi-byte `inside` character. */
export function tearJournal(stateDir: string, at: 'final' | 'terminated' | 'mid' = 'final', key = 'alpha', inside?: string) {
  const kept = readQueue(stateDir, key).slice(0, -1), bytes = fs.readFileSync(queuePath(stateDir, key))
  if (bytes.at(-1) !== 10) throw new Error('fixture tear needs a newline-terminated closed journal')
  const lines: Buffer[] = []
  for (let start = 0; start < bytes.length;) { const end = bytes.indexOf(10, start) + 1; lines.push(bytes.subarray(start, end)); start = end }
  const line = lines.pop()!.subarray(0, -1)
  let cut = Math.ceil(line.length / 2)
  if (inside !== undefined) {
    const start = line.indexOf(Buffer.from(inside))
    if (Buffer.byteLength(inside) < 2 || start < 0) throw new Error('fixture tear needs a multi-byte character in the newest record')
    cut = start + 1
  }
  const torn = Buffer.from(line.subarray(0, cut)), nl = Buffer.from('\n')
  fs.writeFileSync(queuePath(stateDir, key), Buffer.concat(at === 'final' ? [...lines, torn] : at === 'terminated' ? [...lines, torn, nl] : [lines[0]!, torn, nl, ...lines.slice(1)]))
  return { torn, kept, prefix: Buffer.concat(lines) }
}

/** An incoming observation uses production identity/hash/validation, never a parallel schema. */
export function observeThread(h: ThreadHarness, overrides: Partial<{ key: string; channel: string; root: string; ts: string }> = {}): ThreadObservation {
  const key = overrides.key ?? 'alpha', channel = overrides.channel ?? THREAD_CHANNEL, root = overrides.root ?? THREAD_ROOT
  const observation = h.threads.observeIncoming(key, { chat_id: channel, ts: overrides.ts ?? root }, root,
    { mode: h.h.config!.channel_mode ?? 'strict', delivery: h.authority.choice(key, channel)! })
  if (!observation) throw new Error('fixture observation rejected')
  return observation
}
export async function acceptObservation(h: ThreadHarness, observation: ThreadObservation) {
  await h.threads.persist(observation)
  const result = await h.h.queue.accept(observation.lifetime.key, slackInput({
    key: observation.slackKey, ts: observation.slackKey!.ts, channel: observation.lifetime.channel,
    thread_ts: observation.root === observation.slackKey!.ts ? undefined : observation.root, via: 'mention', thread_enrollment: observation,
  }))
  if (result.status === 'failed') throw result.error
  return result
}
