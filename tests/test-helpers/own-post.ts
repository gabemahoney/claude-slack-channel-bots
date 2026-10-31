/** Shared per-call observation and the server's own-post composition over real readers. */
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { createChannelDeliveryStore } from '../../src/channel-delivery.ts'
import {
  createOwnPostJoins, createOwnPostObserver, ownPostChoice, ownPostEligibility,
  type OwnPostEvent, type OwnPostObserver, type OwnPostOperation,
} from '../../src/own-post.ts'
import { makeQueue, slackInput } from './delivery-queue.ts'
import { makeMembershipHarness, membershipPage, SHARED_CHANNEL_IDS, type MembershipHarness } from './shared-channels.ts'
import { makeThreadMemoryHarness, readThreads, threadPath, type ThreadHarnessOptions } from './thread-memory.ts'
import { assertNoLeak, writtenFile } from './credentials.ts'

type StartArgs = Parameters<OwnPostObserver['start']>
type EndArgs = Parameters<OwnPostObserver['end']>
export type OwnPostCall =
  | { kind: 'start'; key: StartArgs[0]; surface: StartArgs[1]; target: StartArgs[2]; content: StartArgs[3]; operation?: OwnPostOperation }
  | { kind: 'end'; operation: EndArgs[0]; answer: EndArgs[1] }
export interface OwnPostStep {
  /** Omitted means a distinct operation with no ready promise. */
  start?: 'operation' | 'undefined'
  ready?: Promise<void>
  throwStart?: Error
  throwEnd?: Error
}

/** A caller-owned gate: pass ready to one scripted start, then resolve or reject it. */
export function holdOwnPostReady() {
  let resolve!: () => void, reject!: (error: unknown) => void
  const ready = new Promise<void>((yes, no) => { resolve = yes; reject = no })
  return { ready, resolve, reject }
}

/** Deliberately bypasses the production fault wrapper to test surface containment.
 * Calls contain raw input content; leak-check the surface's outputs, not this log.
 */
export function makeRecordingOwnPostObserver(steps: readonly OwnPostStep[] = []) {
  const script = [...steps], calls: OwnPostCall[] = []
  const endings = new WeakMap<OwnPostOperation, OwnPostStep>()
  const observer: OwnPostObserver = {
    start(key, surface, target, content) {
      const step = script.shift() ?? {}
      const call: Extract<OwnPostCall, { kind: 'start' }> = { kind: 'start', key, surface,
        target: structuredClone(target), content: structuredClone(content) }
      calls.push(call)
      if (step.throwStart) throw step.throwStart
      if (step.start === 'undefined') return undefined
      const operation = {} as OwnPostOperation
      call.operation = operation
      endings.set(operation, step)
      return { operation, ...(step.ready ? { ready: step.ready } : {}) }
    },
    end(operation, answer) {
      calls.push({ kind: 'end', operation, answer: structuredClone(answer) })
      const step = operation ? endings.get(operation) : undefined
      if (step?.throwEnd) throw step.throwEnd
    },
  }
  return { observer, calls, enqueue: (...next: OwnPostStep[]) => { script.push(...next) } }
}

export interface OwnPostHarnessOptions {
  /** Supply the surface's existing composition to share its actual readers.
   * Supplied members and queue must already be started; their caller closes them.
   */
  members?: MembershipHarness
  choices?: ReturnType<typeof createChannelDeliveryStore>
  queue?: Awaited<ReturnType<typeof makeQueue>>
  membership?: Parameters<typeof makeMembershipHarness>[1]
  memory?: Omit<ThreadHarnessOptions, 'authority' | 'clock' | 'seal' | 'queueOptions'>
  operationId?: () => string
  isDryRun?: () => boolean
  /** False leaves memory and helper-owned membership for start() to initialize. */
  start?: boolean
}

/** The caller owns stateDir (a scratch directory) and removes it after close().
 * No choice, eligibility, membership, stamp or queue lookup is stubbed.
 */
async function buildOwnPostHarness(stateDir: string, options: OwnPostHarnessOptions) {
  if (options.choices && !options.members) throw new Error('own-post choices require their membership harness')
  const members = options.members ?? makeMembershipHarness(stateDir, {
    mode: 'strict', channels: [{ id: SHARED_CHANNEL_IDS.primary, delivery: 'thread_hybrid' }], ...options.membership,
  })
  const threads = makeThreadMemoryHarness(stateDir, { ...options.memory, authority: members.authority, clock: members.h.clock })
  const queue = options.queue ?? await makeQueue(stateDir, { now: threads.clock.now,
    setInterval: (() => ({ unref() {} })) as unknown as typeof setInterval,
    clearInterval: (() => {}) as typeof clearInterval })
  const choices = options.choices ?? createChannelDeliveryStore(members.authority)
  const sources = {
    config: () => members.authority.config(),
    persona: (key: string) => members.authority.config().personas.find(p => p.key === key),
    choices: () => choices, membership: members.membership.read,
  }
  let dryRun = options.memory?.dryRun ?? false
  const owner = createOwnPostJoins({ memory: threads.memory, lookupSlackKey: queue.lookupSlackKey,
    choice: ownPostChoice(sources), eligibility: ownPostEligibility(sources), now: threads.clock.now,
    operationId: options.operationId ?? (() => crypto.randomUUID()), isDryRun: options.isDryRun ?? (() => dryRun) })
  const observer = createOwnPostObserver(() => owner), events: OwnPostEvent[] = []
  owner.subscribe(event => { events.push(event) })
  const unsubscribe = members.authority.subscribeThreadView(() => {
    for (const persona of members.authority.config().personas) owner.onSharedStatePublished(persona.key)
  })
  // Keep snapshots so later settlement/forgetting cannot erase output evidence.
  const returned: unknown[] = []
  const capture = <T>(value: T): T => { returned.push(structuredClone(value)); return value }
  const read = {
    pendingOwnPosts: (...args: Parameters<typeof owner.pendingOwnPosts>) => capture(owner.pendingOwnPosts(...args)),
    operation: (...args: Parameters<typeof owner.operation>) => capture(owner.operation(...args)),
    subscribe: owner.subscribe,
  }
  const captured = () => ({ membership: members.captured(), sharedWrites: members.writes, events, returned,
    threadMemory: { events: threads.events, logs: threads.logs, posts: threads.posts,
      retryEvents: threads.retryEvents, sealEvents: threads.sealEvents },
    files: ['threads', 'queue'].map(name => join(stateDir, name)).filter(existsSync).map(writtenFile) })
  let started = false, closing: Promise<void> | undefined
  async function start() {
    if (started) return
    started = true
    await threads.start()
    if (!options.members) {
      const channels = options.membership?.channels?.map(c => c.id) ?? [SHARED_CHANNEL_IDS.primary]
      for (const persona of members.authority.config().personas) {
        members.h.stub(members.h.p(persona.name)).script.inventory.push(membershipPage(channels))
      }
      await members.start(); await members.scan()
    }
  }
  function close() {
    return closing ??= (async () => {
      try { assertNoLeak(captured()) } finally {
        unsubscribe(); owner.stop()
        try { if (!options.queue) await queue.stop() } finally {
          try { await threads.close() } finally {
            try { if (!options.members) await members.close() } finally { assertNoLeak(captured()) }
          }
        }
      }
    })()
  }
  if (options.start !== false) {
    try { await start() } catch (error) { await close(); throw error }
  }
  return {
    stateDir, threads, memory: threads.memory, io: threads.io, clock: threads.clock,
    authority: members.authority, members, choices, sources, queue, owner, observer, read, events,
    start, close, captured, flush: threads.clock.flush,
    dryRun(value: boolean) { dryRun = value },
    view: (...args: Parameters<typeof threads.memory.view>) => capture(threads.memory.view(...args)),
    records(key = 'alpha') { return capture(existsSync(threadPath(stateDir, key)) ? readThreads(stateDir, key) : []) },
    storeSlack(key: string, input: Parameters<typeof slackInput>[0] = {}) { return queue.accept(key, slackInput(input)) },
  }
}
export type OwnPostHarness = Awaited<ReturnType<typeof buildOwnPostHarness>> & { reopen(): Promise<OwnPostHarness> }

export async function makeOwnPostHarness(stateDir: string, options: OwnPostHarnessOptions = {}): Promise<OwnPostHarness> {
  const harness = await buildOwnPostHarness(stateDir, options)
  return { ...harness,
    /** Close this owner before replay. External members/queue remain caller-owned. */
    async reopen() {
      await harness.close()
      return makeOwnPostHarness(stateDir, { ...options, start: true,
        membership: { ...options.membership, reopen: true },
        memory: { ...options.memory, fs: undefined, reopen: true } })
    },
  }
}
