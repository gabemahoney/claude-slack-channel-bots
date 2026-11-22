/** b.o83's two guards share real storage, full-reader reopen and publication.
 * Setup is deliberately outside every measured/counted operation. */
import { expect, spyOn } from 'bun:test'
import { createHash } from 'node:crypto'
import { linkSync, mkdirSync, readFileSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { makePersonaConfigInput } from './persona-config.ts'
import { makeReloadHarness, type ReloadRunOptions } from './reload-harness.ts'
import { membershipPage } from './shared-channels.ts'
import { assertNoLeak } from './credentials.ts'
import { parsePersonaConfigBytes, type DeliveryMode } from '../../src/config.ts'
import { durableWriteFileSync } from '../../src/atomic-write.ts'
import {
  applySharedMemberships, createSharedChannelAuthority, initialSharedChannelState,
  parseSharedChannelState, serializeSharedChannelState, type SharedChannelState,
} from '../../src/shared-channels.ts'
import { botAttemptBinding, botAttemptKey, type ChannelDeliveryAttemptRequest, type SharedBotAttempt } from '../../src/channel-delivery-attempt.ts'
import { createReviewObserver, reviewLedger } from '../../src/reload-review.ts'
import { SET_CHANNEL_DELIVERY_TOOL } from '../../src/channel-delivery.ts'
import { stubCallCount } from './agent-director-stub.ts'
import { slackInstallationKey } from '../../src/persona-slack-validation.ts'

export const AUTHORITY_POPULATIONS = [0, 4000] as const
export const AUTHORITY_OPERATIONS = ['assignment', 'writingTick', 'idleTick'] as const
export type AuthorityOperation = typeof AUTHORITY_OPERATIONS[number]
// Hang backstop for two full shape builds/reopens, not a performance verdict.
export const AUTHORITY_FIXTURE_TIMEOUT_MS = 30_000
const hash = (s: string) => createHash('sha256').update(s).digest('hex')
const CHANNELS = Array.from({ length: 1100 }, (_, i) => `C0LARGE${String(i).padStart(5, '0')}`)
const CYCLE: DeliveryMode[] = ['off', 'mentions', 'all', 'thread_hybrid']
export interface AuthorityWrite {
  byteLength: number; ms: number; scanPath: string; image?: Uint8Array; linkError?: unknown
}
export interface AuthorityLeakFailure { label: string; error: unknown }

/** Seed helper, not a performance imitation: one general production transaction
 * reserves distinct positions; its full validator must accept every record.
 * Live applied records are superseded by a later assignment; old-life records
 * precede their retirement. Both populations reserve the same revision span. */
function seedHistory(authority: ReturnType<typeof createSharedChannelAuthority>, extra: number) {
  const requests: Array<{ incarnation: string; request: ChannelDeliveryAttemptRequest }> = []
  const key = 'beta', incarnation = authority.incarnation(key)!, retired = 'authority-cost-retired-beta'
  const result = authority.transact(authority.revision, (next, order) => {
    const life = next.personas[key]!
    next.outcomes.botAttempts = {}
    next.retiredIdentities[retired] = { key, incarnation: retired, declaration: { ...life.declaration },
      channels: [{ id: CHANNELS.at(-1)!, delivery: 'all' }], order: order - 1 }
    for (let i = 0; i < extra; i++) {
      const old = i % 4 === 3
      const request: ChannelDeliveryAttemptRequest = { attempt_id: `retained-${String(i).padStart(4, '0')}`,
        channel: CHANNELS.at(-1)!, delivery: 'all', intent: 'assignment' }
      const binding = botAttemptBinding(key, old ? retired : incarnation, request)
      const start = order - 9000 + 2 * i
      const record: SharedBotAttempt = i % 4 === 0 ? { ...binding, startedOrder: start, status: 'pending' }
        : i % 4 === 1 ? { ...binding, startedOrder: start, status: 'not-applied', resolvedOrder: start + 1, reason: 'membership' }
        : { ...binding, startedOrder: start, status: 'applied', resolvedOrder: start + 1,
          facts: { saved: 'all', effective: 'all' }, previous: 'mentions' }
      next.outcomes.botAttempts[botAttemptKey(binding)] = record
      requests.push({ incarnation: binding.incarnation, request })
    }
    // The final channel already has mentions; move only its application order.
    life.assignments[CHANNELS.at(-1)!]!.order = order
  }, 10_000)
  expect(result.kind).toBe('applied')
  return requests
}

export async function makeAuthorityCostRig(extra: number, keepImages = false) {
  const h = makeReloadHarness()
  const operatorFiles = [h.paths.config]
  const leakFailures: AuthorityLeakFailure[] = []
  function checkLeak(value: unknown, label: string) {
    try { assertNoLeak(value, label) }
    catch (error) { leakFailures.push({ label, error }) }
  }
  try {
    const channels = CHANNELS.map((id, i) => ({ id, delivery: i < 400 ? CYCLE[i % 4]! : 'mentions' as const }))
    const personas = ['alpha', 'beta'].map(name => h.persona(name, { channels, permission_prompts: CHANNELS[3]! }))
    operatorFiles.push(...personas.map(p => p.credentials_file!))
    const installations = Object.fromEntries(personas.map((p, i) => [p.name, {
      teamId: 'T'.padEnd(21, '0'), appId: 'A'.padEnd(21, String(i)),
      botUserId: 'U'.padEnd(21, String(i)), botId: 'B'.padEnd(21, String(i)),
    }]))
    h.materialize(...personas)
    const source = h.writeConfig(makePersonaConfigInput({ channel_mode: 'open', personas }, h.root))
    const config = parsePersonaConfigBytes(source, h.paths.config, h.dir, { home: h.home })
    const seed = createSharedChannelAuthority(h.paths.lastApplied, initialSharedChannelState(source, config),
      { write(path, bytes) {
        try { durableWriteFileSync(path, bytes) }
        finally { checkLeak({ path, bytes }, 'setup.authorityWrite') }
      }, home: h.home, sourcePath: h.paths.config })
    for (let scan = 0; scan < 2; scan++) for (const p of config.personas) {
      const scanId = hash(`${p.key}:${scan}`).slice(0, 36)
      const observations = p.channels.map(c => ({ event: `scan:${scanId}:${c.id}`, channel: c.id, member: true,
        identity: slackInstallationKey(installations[p.key]!), boundary: seed.lifetime(p.key, c.id)?.membershipBoundary ?? 0,
        isExtSharedChannel: false, channelType: 'channel' as const, observedThrough: '1795200000.000000' }))
      expect(observations[0]!.event.length).toBe(54)
      expect(seed.transactMembership(p.key, seed.revision, (next, order) =>
        applySharedMemberships(next, order - observations.length + 1, p.key, seed.incarnation(p.key)!, observations), observations.length).kind).toBe('applied')
    }
    const historyRequests = seedHistory(seed, extra)
    const observe = createReviewObserver()
    observe(seed, hash('retained pending review'), true, 0, hash('source'))
    observe(seed, hash('retained superseded review'), false, 0, hash('source'))
    const seeded = parseSharedChannelState(readFileSync(h.paths.lastApplied), h.paths.lastApplied, { home: h.home })!
    expect(seeded).not.toBeNull()
    expect(Object.keys(seeded.outcomes.botAttempts!)).toHaveLength(extra)
    const attempts = Object.values(seeded.outcomes.botAttempts!)
    expect(attempts.filter(a => a.status === 'pending')).toHaveLength(extra / 4)
    expect(attempts.filter(a => a.status === 'not-applied')).toHaveLength(extra / 4)
    expect(attempts.filter(a => a.status === 'applied' && a.incarnation === seed.incarnation('beta'))).toHaveLength(extra / 4)
    expect(attempts.filter(a => a.incarnation !== seed.incarnation('beta'))).toHaveLength(extra / 4)
    const retainedReviews = structuredClone(reviewLedger(seeded)!.outcomes)
    expect(Object.keys(retainedReviews)).toHaveLength(1)
    const writes: AuthorityWrite[] = []
    let writeStart = 0
    const runOptions: ReloadRunOptions = { realLifecycle: true, threadMemory: {}, slack: installations,
      beforeWrite(path) { if (path === h.paths.lastApplied) writeStart = performance.now() },
      afterWrite(path, bytes) {
        checkLeak({ path, bytes }, 'setup.reloadWrite')
      },
    }
    const run = await h.startDetecting(runOptions)
    const authority = run.controller.sharedChannels()!
    expect(authority.snapshot().outcomes.botAttempts).toEqual(seeded.outcomes.botAttempts)
    // Authenticated in-memory eligibility must be current, in addition to the
    // two retained scans. These are real membership scanner production paths.
    for (const p of personas) run.stub(p.name).script.inventory.push(membershipPage(CHANNELS))
    await run.membershipClock.runNext()
    for (const p of personas) expect(run.membershipScanner.status(p.name).state).toBe('complete')
    const ready = authority.snapshot()
    for (const life of Object.values(ready.personas)) {
      expect(Object.keys(life.assignments)).toHaveLength(1100)
      expect(Object.keys(life.membershipEvents)).toHaveLength(2200)
      expect([...new Set(Object.values(life.membershipEvents).map(e => e.identity.length))]).toEqual([97])
      expect([...new Set(Object.keys(life.membershipEvents).map(id => id.length))]).toEqual([54])
    }
    await run.ticks.tick()
    run.registerSession('beta')
    // Capture the actual SDK server built by the run, not a replica handler.
    // Its registered tools/call wrapper includes SDK schema validation and the
    // production registry handler. Keep transport/session setup out of timing.
    let sdkServer: Server | undefined
    const original = Server.prototype.setRequestHandler
    const registration = spyOn(Server.prototype, 'setRequestHandler').mockImplementation(function (this: Server, schema, handler) {
      sdkServer = this
      return original.call(this, schema, handler)
    })
    try {
      await run.callTool('beta', SET_CHANNEL_DELIVERY_TOOL, { attempt_id: 'unbound-setup-retry', intent: 'retry', channel: CHANNELS.at(-1)!, delivery: 'all' })
    } finally { registration.mockRestore() }
    type ToolHandler = (request: { method: 'tools/call'; params: { name: string; arguments: ChannelDeliveryAttemptRequest } }, extra: object) => Promise<{ isError?: boolean }>
    const handler = (sdkServer as unknown as { _requestHandlers: Map<string, ToolHandler> })._requestHandlers.get('tools/call')
    if (!handler) throw new Error('SDK tools/call handler was not registered')
    // Keep the promise in the rig instead of a local so its complete result
    // (or rejection) can be collected after measurement, before the next call.
    let pendingToolCall: ReturnType<ToolHandler> | undefined
    const scanDir = join(h.root, 'authority-write-scans')
    mkdirSync(scanDir)
    let scanNumber = 0
    // A link preserves this durable inode across the next atomic rename,
    // without retaining the production buffer. Scanning stays outside the
    // window; the one metadata syscall is included in the measured hold.
    runOptions.afterWrite = (path, bytes) => {
      if (path === h.paths.lastApplied) {
        const ms = performance.now() - writeStart
        const write: AuthorityWrite = { byteLength: bytes.byteLength, ms,
          scanPath: join(scanDir, `w${scanNumber++}`), ...(keepImages ? { image: Buffer.from(bytes) } : {}) }
        writes.push(write)
        try { linkSync(path, write.scanPath) }
        catch (error) { write.linkError = error; throw error }
      }
    }
    let sequence = 0
    const assigned: ChannelDeliveryAttemptRequest[] = []
    async function operation(op: AuthorityOperation) {
      if (op === 'assignment') {
        const request: ChannelDeliveryAttemptRequest = { attempt_id: `measured-${sequence}`, intent: 'assignment',
          channel: CHANNELS.at(-1)!, delivery: sequence++ % 2 ? 'mentions' : 'all' }
        assigned.push(request)
        const before = writes.length
        pendingToolCall = handler!({ method: 'tools/call', params: { name: SET_CHANNEL_DELIVERY_TOOL, arguments: request } }, {})
        // The complete MCP assignment, including both writes, must finish
        // before returning its promise. Assert separately from CPU work.
        const synchronousWrites = writes.length - before
        const result = await pendingToolCall
        return { isError: result.isError === true, synchronousWrites }
      }
      await run.ticks.tick()
      return undefined
    }
    function restart() {
      const before = authority.snapshot()
      const state = parseSharedChannelState(readFileSync(h.paths.lastApplied), h.paths.lastApplied, { home: h.home })
      expect(state).not.toBeNull()
      const reopened = createSharedChannelAuthority(h.paths.lastApplied, state!, { home: h.home, sourcePath: h.paths.config })
      expect(reopened.snapshot()).toEqual(before)
      expect(state!.outcomes.botAttempts).toEqual(before.outcomes.botAttempts)
      expect(reviewLedger(state!)!.outcomes).toEqual(retainedReviews)
      for (const [id, record] of Object.entries(seeded.outcomes.botAttempts!)) expect(state!.outcomes.botAttempts![id]).toEqual(record)
      for (const { incarnation, request } of historyRequests) {
        const record = seeded.outcomes.botAttempts![botAttemptKey(botAttemptBinding('beta', incarnation, request))]!
        const result = reopened.lookupBotAttempt('beta', incarnation, { ...request, intent: 'retry' })
        // Retired records remain retained, but old-life access stays inactive.
        expect(result).toEqual(incarnation !== reopened.incarnation('beta') ? { kind: 'inactive' }
          : record.status === 'applied' ? { kind: 'applied', historical: true, outcome: record }
          : record.status === 'pending' ? { kind: 'pending' } : { kind: 'not-applied', reason: record.reason })
      }
      for (const request of assigned) {
        const result = reopened.lookupBotAttempt('beta', reopened.incarnation('beta')!, { ...request, intent: 'retry' })
        expect(result).toMatchObject({ kind: 'applied', historical: true, outcome: { delivery: request.delivery,
          facts: { saved: request.delivery, effective: request.delivery } } })
      }
      expect(reopened.choice('beta', CHANNELS.at(-1)!)).toBe(assigned.at(-1)?.delivery ?? 'mentions')
    }
    const cp = run.checkpoint(), adCalls = stubCallCount(run.composition!.agentDirector)
    return { h, run, authority, writes, operation, restart, leakFailures,
      // Call after each operation, outside every measured/counted window and
      // before the next arming. Scan intermediate output, then release it;
      // only assertNoLeak's small, safe error records survive the operation.
      async collect(label: string) {
        const scanErrors: unknown[] = []
        try {
          for (let i = 0; i < writes.length; i++) {
            const write = writes[i]!
            if (write.linkError !== undefined) scanErrors.push(write.linkError)
            try {
              const bytes = readFileSync(write.scanPath)
              expect(bytes.byteLength).toBe(write.byteLength)
              checkLeak(bytes, `${label}.writes[${i}]`)
            } catch (error) { scanErrors.push(error) }
            finally {
              try { unlinkSync(write.scanPath) }
              catch (error) { scanErrors.push(error) }
            }
          }
          if (pendingToolCall !== undefined) {
            try { checkLeak(await pendingToolCall, `${label}.mcpResult`) }
            catch (error) { checkLeak(error, `${label}.mcpError`) }
          }
        } finally {
          pendingToolCall = undefined
          writes.length = 0
        }
        if (scanErrors.length) throw new AggregateError(scanErrors, `Authority write scan failed: ${label}`)
      },
      captured(extra: Record<string, unknown> = {}) {
        const captured = run.captured({
          server: h.serverSideFiles(...operatorFiles), ...extra })
        // Check files and the large startup outcome while they still exist.
        // Deferred verdicts keep only logs/errors and small call metadata,
        // never a startup state, file contents or measured write buffers.
        checkLeak(captured, `population[${extra.population ?? 'run'}].captured`)
        return { logs: captured.logs, writes: captured.writes, removes: captured.removes,
          toolResponses: captured.toolResponses, toolResults: captured.toolResults, ...extra }
      },
      stateBytes: serializeSharedChannelState(authority.snapshot()).byteLength,
      assertNoCalls() {
        expect(run.since(cp).slackCalls).toEqual([])
        expect(run.since(cp).slackBuilds).toBe(0)
        expect(stubCallCount(run.composition!.agentDirector)).toBe(adCalls)
      },
      close: () => h.cleanup(),
    }
  } catch (error) {
    try { assertNoLeak({ error, runs: h.runs.map(run => run.captured()), server: h.serverSideFiles(...operatorFiles) }) }
    finally { await h.cleanup() }
    throw error
  }
}
export type AuthorityCostRig = Awaited<ReturnType<typeof makeAuthorityCostRig>>

export interface AuthorityWork {
  parsedAttemptRecords: number; parsedBytes: number; parseCalls: number
  serializedAttemptRecords: number
  clonedAttemptRecords: number; wholeStateClones: number
  attemptKeyVisits: number; snapshotCalls: number; snapshotAttemptRecords: number
}
/** Observe real JSON input and actual attempt-record key enumerations (the
 * clone and full validator both enumerate them). No timing and no src seam.
 * Parsing bytes are diagnostic only: whole-file output growth is permitted.
 * Snapshot counts include the real snapshot return's retained records. */
export async function countAuthorityWork(rig: AuthorityCostRig, op: AuthorityOperation) {
  return countAuthorityCallback(rig, () => rig.operation(op))
}
/** Same observation window for a deferred real scanner continuation. */
export async function countAuthorityCallback<T>(rig: AuthorityCostRig, operation: () => Promise<T>, observe?: {
  parsed(value: unknown): void; serialized(value: unknown): void; visited(value: unknown): void
}) {
  const work: AuthorityWork = { parsedAttemptRecords: 0, parsedBytes: 0, parseCalls: 0, serializedAttemptRecords: 0,
    clonedAttemptRecords: 0, wholeStateClones: 0,
    attemptKeyVisits: 0, snapshotCalls: 0, snapshotAttemptRecords: 0 }
  const parse = JSON.parse, stringify = JSON.stringify, keys = Object.keys, snapshot = rig.authority.snapshot, clone = structuredClone
  const parsing = spyOn(JSON, 'parse').mockImplementation((text, reviver) => {
    const result = parse(text, reviver)
    observe?.parsed(result)
    work.parseCalls++; work.parsedBytes += Buffer.byteLength(text)
    work.parsedAttemptRecords += keys(result?.outcomes?.botAttempts ?? {}).length
    return result
  })
  const keying = spyOn(Object, 'keys').mockImplementation(value => {
    const result = keys(value)
    if (value && Object.hasOwn(value, 'identifierHash') && Object.hasOwn(value, 'startedOrder')) work.attemptKeyVisits += result.length
    return result
  })
  const serializing = spyOn(JSON, 'stringify').mockImplementation((value, replacer, space) => {
    observe?.serialized(value)
    const visit = (value: unknown) => {
      observe?.visited(value)
      if (value && typeof value === 'object' && Object.hasOwn(value, 'identifierHash') && Object.hasOwn(value, 'startedOrder')) work.serializedAttemptRecords++
    }
    if (Array.isArray(replacer)) return stringify(value, replacer, space)
    return stringify(value, function (key, member) {
      visit(member)
      return typeof replacer === 'function' ? replacer.call(this, key, member) : member
    }, space)
  })
  const snapshots = spyOn(rig.authority, 'snapshot').mockImplementation(() => {
    const value = snapshot()
    work.snapshotCalls++
    work.snapshotAttemptRecords += keys(value.outcomes.botAttempts ?? {}).length
    return value
  })
  const cloning = spyOn(globalThis, 'structuredClone').mockImplementation((value, options) => {
    const input: unknown = value
    if (input && typeof input === 'object' && 'outcomes' in input && 'personas' in input) {
      const state = input as SharedChannelState
      work.wholeStateClones++
      work.clonedAttemptRecords += keys(state.outcomes.botAttempts ?? {}).length
    }
    return clone(value, options)
  })
  try { return { work, result: await operation() } }
  finally { cloning.mockRestore(); snapshots.mockRestore(); serializing.mockRestore(); keying.mockRestore(); parsing.mockRestore() }
}

export function readAuthorityImage(rig: AuthorityCostRig, write: AuthorityWrite): SharedChannelState {
  if (!write.image) throw new Error('This rig did not retain write images')
  const state = parseSharedChannelState(write.image, rig.h.paths.lastApplied, { home: rig.h.home })
  if (!state) throw new Error('Production reader rejected a measured write')
  return state
}
