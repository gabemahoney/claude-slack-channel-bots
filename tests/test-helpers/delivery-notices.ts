/** reporting composition over the real queue, episodes and persona notifier. */
import * as fs from 'node:fs'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createDeliveryReporting, type DeliveryReportState } from '../../src/delivery-notices.ts'
import type { DeliveryReason, DeliveryStatus } from '../../src/delivery-engine.ts'
import type { AcceptedInput, QueueItem, DeliveryQueue } from '../../src/delivery-queue.ts'
import { isOpenItem, itemOpenedAt } from '../../src/delivery-queue.ts'
import { renderPersonaRef } from '../../src/persona-identity.ts'
import { createDeliveryPreparation } from '../../src/delivery-intake.ts'
import { createPersonaRouting } from '../../src/persona-routing.ts'
import { createChannelDeliveryStore } from '../../src/channel-delivery.ts'
import type { ChannelMode } from '../../src/config.ts'
import { registerSession, unregisterSession, type SessionEntry } from '../../src/registry.ts'
import { createOwnPostJoins, createOwnPostObserver, ownPostChoice, ownPostEligibility, pendingOwnPostViews, type OwnPostJoins, type OwnPostObserver } from '../../src/own-post.ts'
import { createPostHoldResolver, type PostHoldResolver } from '../../src/post-holds.ts'
import { makeMultiPersonaConfig, type PersonaSpec } from './persona-config.ts'
import { makeNoticeAlertsRig, makeNotifierHarness } from './persona-notifier.ts'
import { makeQueue, slackInput, deliveredRecord, readQueue } from './delivery-queue.ts'
import { makeSharedAuthority } from './shared-channels.ts'
import { observedMembership } from './persona-routing-harness.ts'
import { makeThreadMemoryHarness, type ThreadMemoryHarness } from './thread-memory.ts'
import { asWebClient, makeChannelMessage, makeDeferredWebApiCall, type DeferredWebApiCall } from './slack-stub.ts'
import { assertNoLeak, LEAK_SENTINEL, sentinelInMessage } from './credentials.ts'
import { durableIo } from './durable-io.ts'

export async function makeDeliveryNoticeHarness(options: {
  queue?: DeliveryQueue; leakMarker?: string; holds?: boolean; fs?: typeof fs
  personas?: PersonaSpec[]; channel_mode?: ChannelMode; ownPosts?: OwnPostObserver
  /** Bind a recording `queued` callback; by default reporting gets none (`holds` binds it too). */
  recordQueued?: boolean
} = {}) {
  const root = mkdtempSync(join(tmpdir(), 'delivery-notices-'))
  const config = makeMultiPersonaConfig(options.personas ?? [
    { name: 'alpha', channels: [{ id: 'C0ALPHA01', delivery: 'all' }, { id: 'C0BETA001', delivery: 'all' }], permission_prompts: 'C0ALPHA01' },
    { name: 'beta', channels: [{ id: 'C0BETA001', delivery: 'all' }, { id: 'C0ALPHA01', delivery: 'all' }], permission_prompts: 'C0BETA001' },
  ], root, { channel_mode: options.channel_mode ?? 'strict' })
  const h = makeNotifierHarness(config, { leakMarker: options.leakMarker, ownPosts: options.ownPosts })
  const rig = makeNoticeAlertsRig(h, { logDir: root, omitStderr: true })
  const logs: string[] = [], blocked: { key: string; rule: 'menu' | 'input' }[] = [], delivered: { key: string; item: QueueItem }[] = []
  const queued: { key: string; item: QueueItem }[] = []
  const states = new Map(config.personas.map(p => [p.key, { up: true } as DeliveryReportState]))
  const queueIo = durableIo({ base: options.fs })
  h.clock.settleOn(queueIo)
  const queue = options.queue ?? await makeQueue(root, { fs: queueIo.fs, now: h.clock.now, onEvent: event => reporting?.queueEvent(event) })
  const reporting = createDeliveryReporting({ queue, episodes: rig.episodes, persona: key => config.personas.find(p => p.key === key), state: key => states.get(key)!,
    log: line => logs.push(line), notify: (key, text) => h.notifier.notify(key, text),
    delivered: (key, item) => { delivered.push({ key, item }) }, now: h.clock.now,
    ...(options.holds || options.recordQueued ? { queued: (key: string, item: QueueItem) => { queued.push({ key, item }) } } : {}),
  })
  const [alpha, beta] = config.personas.map(p => p.key) as [string, string]
  const ref = (key = alpha) => { const p = config.personas.find(p => p.key === key)!; return renderPersonaRef(p.name, key) }
  async function accept(overrides: Partial<AcceptedInput> = {}, key = alpha) {
    const result = await queue.accept(key, slackInput(overrides))
    if (result.status === 'failed') throw new Error('notice fixture store failed')
    return result.item!
  }
  function status(item: QueueItem, patch: Partial<DeliveryStatus> = {}, key = alpha): DeliveryStatus {
    return { key, seq: item.accepted.seq, count: queue.items(key).filter(options.holds ? isOpenItem : i => !i.delivered).length, ageMs: h.clock.now() - (options.holds ? itemOpenedAt(item) : item.accepted.received_at),
      row: 'waiting', retypeCount: item.retypeCount, marker: true, relay: true, connected: true, up: true, latched: false, held: false,
      receiptWorking: false, dialogMaybeOpen: false, reconnectDeferred: false, ...patch }
  }
  function waiting(item: QueueItem, reason: DeliveryReason = 'not-now', patch: Partial<DeliveryStatus> = {}, key = alpha) {
    const facts = status(item, patch, key)
    reporting.engineEvent({ type: 'waiting', key, seq: item.accepted.seq, reason, ageMs: facts.ageMs, status: facts })
  }
  return { root, config, h, rig, queue, reporting, logs, blocked, delivered, queued, states, alpha, beta, ref, accept, status, waiting,
    async complete(item: QueueItem, key = alpha) {
      if (!item.fixed) await queue.append(key, { v: 1, kind: 'fixed', seq: item.accepted.seq, parts: ['fixed'] })
      await queue.append(key, { ...deliveredRecord(item.accepted.seq, h.clock.now()), seq: item.accepted.seq })
      reporting.engineEvent({ type: 'item-delivered', key, seq: item.accepted.seq, at: h.clock.now(), waitMs: 0 })
    },
    async flush() { await h.clock.flush(); await Promise.resolve(); await Promise.resolve() },
    async cleanup() { await queue.stop(); rig.episodes.close(); h.cleanup(); rmSync(root, { recursive: true, force: true }) },
  }
}
export type DeliveryNoticeHarness = Awaited<ReturnType<typeof makeDeliveryNoticeHarness>>

/** The storage harness's Slack identities, shared with its cases. */
export const STORAGE_NOTICE_IDS = {
  /** The fixture message's channel, another listed channel, and the channel Notice Destination. */
  source: 'C0SOURCE1', other: 'C0OTHER01', notice: 'C0NOTICE1',
  /** The fixture message's sender and ts, and another message's ts in its channel. */
  sender: 'U0SENDER1', ts: '1700000000.000001', otherTs: '1700000000.000002',
  /** An earlier thread root in the source channel, for replies held for P's own post there. */
  root: '1699999999.000001',
  /** Slack's ts for a posted warning, for its same-place correction, and for two later replies in the correction's thread. */
  warningTs: '1800000000.000001', correctionTs: '1800000000.000003', replyTs: '1800000000.000004', laterReplyTs: '1800000000.000005',
} as const

/** b.vki: real Slack intake and durable storage, with only the disk fault and Slack answers scripted. */
export async function makeStorageNoticeHarness(options: {
  destination?: 'dm' | 'channel'; channel_mode?: ChannelMode
  /** The source channel is `thread_hybrid` over real Thread Memory, with the server's own-post owner
   * and Post Hold resolver, so intake holds a reply for P's pending own post. The stored hold reaches
   * reporting's `holdStored` as `src/server.ts` binds `onHoldStored`. */
  threads?: boolean
  /** The channel Notice Destination's delivery choice; `thread_hybrid` (with `threads`) makes every
   * notice there, corrections included, P's own post in a channel that follows threads. */
  noticeDelivery?: 'all' | 'thread_hybrid'
  /** The notice resolver's own-post observer; with `threads` the default is the real owner's. */
  ownPosts?: OwnPostObserver
} = {}) {
  const ids = STORAGE_NOTICE_IDS
  let diskFailed = false
  let owner: OwnPostJoins | undefined
  const observer = createOwnPostObserver(() => owner)
  const n = await makeDeliveryNoticeHarness({
    channel_mode: options.channel_mode,
    leakMarker: LEAK_SENTINEL,
    ownPosts: options.ownPosts ?? (options.threads ? observer : undefined),
    personas: ['alpha', 'beta'].map(name => ({
      name, channels: [{ id: ids.source, delivery: options.threads ? 'thread_hybrid' as const : 'all' as const },
        { id: ids.other, delivery: 'all' as const },
        // A channel destination must be one of the persona's channels in both modes.
        ...options.destination === 'channel' ? [{ id: ids.notice, delivery: options.noticeDelivery ?? 'all' }] : []],
      dm: { enabled: true, contact: name === 'alpha' ? 'U0ALPHA01' : 'U0BETA001' },
      permission_prompts: options.destination === 'channel' ? ids.notice : 'dm',
    })),
    fs: durableIo({ before(step) {
      if (step.op === 'fsync' && diskFailed && fs.fstatSync(step.fd!).isFile()) throw Object.assign(new Error(sentinelInMessage('store')), { code: 'ENOSPC' })
    } }).fs,
  })
  const held: DeferredWebApiCall[] = []
  const acks: { key: string; records: ReturnType<typeof readQueue> }[] = []
  const preparation = createDeliveryPreparation({
    queue: n.queue, clock: n.h.clock, resolveUserName: async (_key, user) => user,
    clientFor: key => asWebClient(n.h.stub(key).web), onReceived: n.reporting.received,
  })
  // A connected in-memory registry entry avoids all lost-session/agent work.
  for (const persona of n.config.personas) registerSession(persona.working_directory, persona.key,
    { close: async () => {} } as SessionEntry['transport'], {} as SessionEntry['server'])
  // Intake selects only from the shared authority's applied choices and the
  // persona's current membership, in both Channel Modes.
  const authority = makeSharedAuthority(n.root, { ...n.config,
    personas: n.config.personas.map(({ key, index, sections, ...persona }) => persona),
  })
  const choices = createChannelDeliveryStore(authority)
  const membership = observedMembership(Object.fromEntries(n.config.personas.map(p => [p.key, p.channels.map(c => c.id)])))
  // As src/server.ts composes them: one owner over Thread Memory and the queue's
  // keys, its observer for every own post, and the Post Hold resolver it checks.
  let threads: ThreadMemoryHarness | undefined, postHolds: PostHoldResolver | undefined, unsubscribe = () => {}
  if (options.threads) {
    const t = threads = makeThreadMemoryHarness(n.root, { authority,
      heldStamps: key => n.queue.unresolvedHolds(key).filter(hold => hold.memoryDependent).map(hold => ({ channel: hold.channel, stamp: hold.stamp })) })
    await t.start()
    const sources = { config: () => n.config, persona: (key: string) => n.config.personas.find(p => p.key === key),
      choices: () => choices, membership: membership.read }
    const joins = owner = createOwnPostJoins({ memory: t.memory, lookupSlackKey: (key, slackKey) => n.queue.lookupSlackKey(key, slackKey),
      choice: ownPostChoice(sources), eligibility: ownPostEligibility(sources), now: t.clock.now,
      operationId: () => crypto.randomUUID(), isDryRun: () => false })
    const resolver = postHolds = createPostHoldResolver({ queue: n.queue, owner: joins,
      release: (key, item, mode) => routing.releaseHeld(key, item, mode), onParked: () => {},
      clock: t.clock, decisionNow: t.clock.now })
    unsubscribe = joins.subscribe(event => resolver.check(event.key))
  }
  const routing = createPersonaRouting({
    getChannelDelivery: () => choices, membership,
    getPersonaConfig: () => n.config, getBotIdentity: key => n.h.stub(key).identity,
    queue: n.queue, prepare: preparation.prepare, onReceived: n.reporting.received,
    archive: () => {}, log: line => n.logs.push(line), now: n.h.clock.now,
    ...(threads && owner && postHolds ? threadIntake(threads, owner, postHolds) : {}),
  })
  function threadIntake(t: ThreadMemoryHarness, joins: OwnPostJoins, resolver: PostHoldResolver): Partial<Parameters<typeof createPersonaRouting>[0]> {
    return {
      threadMemory: (key, channel, root) => { joins.settleDeferred(key, channel); return t.memory.view(key, channel, root) },
      pendingOwnPosts: (key, channel) => pendingOwnPostViews(joins.pendingOwnPosts(key, channel)),
      threadStampUndecided: (key, channel) => authority.channelStamp(key, channel)?.kind === 'undecided',
      joins: { stamp: (key, channel) => authority.channelStamp(key, channel),
        hasSavedJoin: (key, channel, root, stamp) => t.memory.hasSavedJoin(key, channel, root, stamp),
        clock: key => t.memory.clock(key), addJoin: (key, fact) => t.memory.addJoin(key, fact),
        saveJoins: (key, facts) => t.memory.saveJoins(key, facts) },
      monotonicNow: t.clock.now, postHolds: resolver,
      // As src/server.ts binds it, less the Memory Hold resolver this harness doesn't build.
      onHoldStored: key => {
        try { resolver.check(key) } catch { /* independent hold owners */ }
        try { n.reporting.holdStored(key) } catch { /* reporting is independent of the holds */ }
      },
    }
  }
  const body = 'private storage-warning regression body'
  const event = makeChannelMessage({ channel: ids.source, user: ids.sender, ts: ids.ts,
    // A true mention selects the receiving persona in both Channel Modes.
    text: `<@${n.h.stub(n.alpha).identity.botUserId}> ${body}` })
  const captured = () => ({ logs: [...n.logs, ...n.h.logs, ...n.rig.lines],
    calls: [...n.h.stubs.values()].flatMap(stub => stub.callLog).filter(call => call.method.startsWith('chat.')) })
  /** `chat.update` calls made on each acknowledging persona's stub by the time of each ack. */
  const editsAtAck: number[] = []
  return { ...n, event, body, acks, editsAtAck, routing, preparation, captured, threads, observer, postHolds,
    failStores(value = true) { diskFailed = value },
    hold(method: 'open' | 'post' | 'update', key = n.alpha) {
      const call = makeDeferredWebApiCall(); held.push(call); n.h.stub(key).script[method].push(call.outcome); return call
    },
    async receive(overrides: Record<string, unknown> = {}, key = n.alpha) {
      await routing.receive({ ...event, ...overrides }, () => {
        acks.push({ key, records: readQueue(n.root, key) }); editsAtAck.push(n.h.stub(key).calls.update.length)
      }, key, false)
      await n.flush()
    },
    forget(key = n.alpha) {
      routing.forget(key); n.reporting.forget(key); preparation.forget(key)
      n.rig.episodes.forget(key); n.h.notifier.forget(key); n.h.hold.cancel(key); n.h.destinations.forget(key)
    },
    async cleanup() {
      diskFailed = false
      n.rig.episodes.close(); n.h.hold.cancelAll()
      for (const call of held) if (!call.settled) call.settle()
      unsubscribe(); postHolds?.stop(); owner?.stop()
      await n.flush(); await preparation.stop(); await threads?.close()
      for (const persona of n.config.personas) unregisterSession(persona.key)
      try {
        assertNoLeak(captured())
        if (JSON.stringify(captured()).includes(body)) throw new Error('storage notice leaked the message body')
      } finally { await n.cleanup() }
    },
  }
}
export type StorageNoticeHarness = Awaited<ReturnType<typeof makeStorageNoticeHarness>>
