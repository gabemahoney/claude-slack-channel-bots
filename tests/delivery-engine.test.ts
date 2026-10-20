import { MCP_SERVER_NAME } from '../src/config.ts'
/** b.omv SR-5/6: production executor over a durable queue and real adapters.
 * Receipt permutations and gate lifecycle live in their
 * own suite. Every timestamp and retry is driven by the injected fake clock. */
import { afterEach, describe, expect, test } from 'bun:test'
import { readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { createDeliveryCallBudget, createDeliveryEngines, createDeliveryLifecycle, DELIVERY_MAX_AD_CALLS_PER_S, DELIVERY_ROW_POLL_MS, DeliveryBudgetWait, deliveryTextWasRefused, ENTER_DELAY_MS, LAUNCH_SETTLE_MS, NOT_NOW_RETRY_MS, RECEIPT_WAIT_MS, RETYPE_BACKOFF_MS } from '../src/delivery-engine.ts'
import { applyDeliveryOwnRowRead, handleDeliveryKeyError, recoverDeliveryGone, setDeliveryLifecycle, setDeliveryPersonaLookup } from '../src/session-manager.ts'
import { LIVE_ROW_LAUNCH_REASON_KEEPS_CONVERSATION, LIVE_ROW_LAUNCH_RESUME, LIVE_ROW_OUTCOME_LAUNCHED } from '../src/live-row-sequence.ts'
import { KILL_RETRY_TRIES } from '../src/kill-retry.ts'
import { UNAVAILABLE_RETRY_MODE_PENDING_ONLY, UNAVAILABLE_RETRY_RUN_NOW_ARMED, UNAVAILABLE_RETRY_RUN_NOW_CLOSED, UNAVAILABLE_RETRY_RUN_NOW_RAN, UNAVAILABLE_RETRY_RUN_NOW_RUNNING, UNAVAILABLE_RETRY_STOP_ROW_LIVE, type UnavailableRetryController, type UnavailableRetryRunNowResult } from '../src/unavailable-retry.ts'
import { cannedPermissionRequest, errCallTimeout, errConfigMalformed, errDialogMaybeOpen, errInstanceIdCollision, errInternal, errInvalidFlags, errPaneChanged, errRelayFallenBack, errSendKeysWhileRelayed, errSpawnNotFound, errSpawnNotInteractive, errSystemInstallDisappeared, errTmuxNotAvailable, errTmuxSendKeys, errTmuxSessionConflict, errTmuxUnresponsive, errUnusableName } from './test-helpers/agent-director-stub.ts'
import { makeEngineHarness, type EngineHarness } from './test-helpers/delivery-engine.ts'
import { injectedInput, makeQueue, readQueue } from './test-helpers/delivery-queue.ts'
import { assertNoLeak } from './test-helpers/credentials.ts'
import { makeRecoveryHarness, personaOf, personaRow, retryNow } from './test-helpers/recovery-harness.ts'
import { balancedAfter, onlyCallArguments, stripComments } from './test-helpers/source-audit.ts'
import { appendTranscript, codexPromptEntry, endedTurn, promptEntry, queueOperationEntry, replyEntry, writeTranscript } from './test-helpers/working-row-panes.ts'

const harnesses: EngineHarness[] = []
afterEach(async () => { for (const h of harnesses.splice(0).reverse()) await h.cleanup() })
async function harness(options: Parameters<typeof makeEngineHarness>[0] = {}) { const h = await makeEngineHarness(options); harnesses.push(h); return h }
async function start(h: EngineHarness, key = 'alpha') { await h.tick(key); await h.advance(LAUNCH_SETTLE_MS) }
async function delivered(h: EngineHarness, key = 'alpha') { await h.until(() => h.queue.openCount(key) === 0) }
async function drainTimers(h: EngineHarness) {
  for (let turns = 0; h.engine.running('alpha') && turns < 1000; turns++) {
    await new Promise<void>(resolve => setImmediate(resolve))
    await h.clock.runNext()
  }
  expect(h.queue.openCount('alpha')).toBe(0)
  expect(h.engine.running('alpha')).toBe(false)
}

// Run main()'s actual callback without starting the server. A copied callback
// would miss a regression in the production ownership handoff.
const engineWiring = onlyCallArguments(
  stripComments(readFileSync(new URL('../src/server.ts', import.meta.url), 'utf8')), 'createDeliveryEngines',
)
const absentRecoveryProperty = engineWiring.match(/\brecoverAbsent\s*:/g)
if (absentRecoveryProperty?.length !== 1) throw new Error('server delivery engine must have one recoverAbsent callback')
const absentRecoveryStart = engineWiring.indexOf(absentRecoveryProperty[0]!) + absentRecoveryProperty[0]!.length
const absentRecoveryExpression = engineWiring.slice(absentRecoveryStart, balancedAfter(engineWiring, absentRecoveryStart, '{', '}')[1] + 1)
const bindAbsentRecovery = new Function(
  'deliveryLifecycle', 'retryTimers', 'UNAVAILABLE_RETRY_RUN_NOW_RAN', 'UNAVAILABLE_RETRY_RUN_NOW_ARMED',
  'UNAVAILABLE_RETRY_RUN_NOW_RUNNING', 'UNAVAILABLE_RETRY_RUN_NOW_CLOSED',
  `return (${absentRecoveryExpression})`,
) as (
  lifecycle: Pick<ReturnType<typeof createDeliveryLifecycle>, 'launchId'>,
  retryTimers: Pick<UnavailableRetryController, 'runNow'>,
  ...results: UnavailableRetryRunNowResult[]
) => (key: string, launch: string) => boolean
function productionAbsentRecovery(
  lifecycle: Pick<ReturnType<typeof createDeliveryLifecycle>, 'launchId'>,
  retryTimers: Pick<UnavailableRetryController, 'runNow'>,
) {
  return bindAbsentRecovery(lifecycle, retryTimers, UNAVAILABLE_RETRY_RUN_NOW_RAN, UNAVAILABLE_RETRY_RUN_NOW_ARMED,
    UNAVAILABLE_RETRY_RUN_NOW_RUNNING, UNAVAILABLE_RETRY_RUN_NOW_CLOSED)
}

/** Restart with an unconfirmed text attempt and a stale AD waiting row.
 * Only AD's Enter outcome establishes that the old session is gone. */
async function goneRecovery(options: {
  delay?: number; pending?: boolean; holdKill?: boolean; refusedKills?: number; keyError?: () => Error; recoverAbsent?: boolean
} = {}) {
  const h = makeRecoveryHarness({ personas: [{}], sessionRestartDelay: options.delay ?? 0, harnessNow: true })
  const key = h.keys[0]!, persona = personaOf(h, key)
  const lifecycle = createDeliveryLifecycle({ startId: 'gone-recovery', clock: h.clock })
  setDeliveryLifecycle(lifecycle)
  setDeliveryPersonaLookup(k => k === key ? persona : undefined)
  let queue = await makeQueue(h.stateDir, { now: h.clock.now })
  let path = join(h.stateDir, 'old-session.jsonl')
  writeTranscript(path, [])
  let row = personaRow(h, key, { state: 'waiting', session_id: 'old-session', jsonl_path: path })
  let resumed = false, draft = '', failed = false, restartAsks = 0, handoffs = 0, killAttempts = 0, up = true
  let readError: Error | undefined, statusError: Error | undefined, beforeGet: (() => Promise<void>) | undefined
  let afterKeyError: (() => void) | undefined
  let absent = false, acceptAbsent = true, absentHandoffs = 0
  let releaseKill!: () => void, enteredKill!: () => void
  const heldKill = new Promise<void>(resolve => { releaseKill = resolve })
  const killEntered = new Promise<void>(resolve => { enteredKill = resolve })
  const keys: string[] = [], owners: string[] = [], errors: unknown[] = [], recoveryCalls: string[] = []
  const absentResults: UnavailableRetryRunNowResult[] = []
  const recoverAbsent = productionAbsentRecovery(lifecycle, {
    runNow(...args) {
      const result = h.controller.runNow(...args)
      absentResults.push(result)
      return result
    },
  })
  h.script({
    spawnFn: () => {
      if (!absent) return errInstanceIdCollision()
      absent = false; resumed = true
      path = join(h.stateDir, 'spawned-session.jsonl')
      writeTranscript(path, [])
      row = { ...row, state: 'waiting', session_id: 'spawned-session', jsonl_path: path, launch_started_at: new Date(h.clock.now()).toISOString() }
      return { instance_id: row.instance_id }
    },
    getFn: () => readError ?? (absent ? errSpawnNotFound() : { ...row }),
    statusFn: () => statusError ?? (absent ? errSpawnNotFound() : { state: row.state }),
    sendKeysFn(params) {
      keys.push(params.key ?? params.text ?? '')
      if (!resumed) { failed = true; return options.keyError?.() ?? errTmuxSendKeys() }
      if (params.no_enter) draft = params.text!
      else if (draft) { appendTranscript(path, [promptEntry(draft)]); draft = '' }
      return {}
    },
    async killFn() {
      enteredKill()
      if (options.holdKill) await heldKill
      if (killAttempts++ < (options.refusedKills ?? 0)) return errCallTimeout('kill')
      row = { ...row, state: 'missing' }
      return {}
    },
    resumeFn() {
      resumed = true
      row = { ...row, state: 'waiting', launch_started_at: new Date(h.clock.now()).toISOString() }
      return { instance_id: row.instance_id }
    },
  })
  for (let n = 0; n < 3; n++) {
    const accepted = await queue.accept(key, injectedInput({ text: `message ${n}` }))
    if (accepted.status === 'failed') throw new Error('fixture acceptance failed')
    await queue.append(key, { v: 1, kind: 'fixed', seq: accepted.seq, parts: [`message ${n}`] })
    if (n === 0) await queue.append(key, {
      v: 1, kind: 'sent', seq: accepted.seq, part: 1, attempt: 1, send_kind: 'text', at: 0,
      launch_id: 'previous-process', session_id: row.session_id, transcript_path: path, transcript_size: 0,
    })
  }
  // Reopen the actual on-disk journal as a new server process would.
  await queue.stop()
  queue = await makeQueue(h.stateDir, { now: h.clock.now })
  const engine = createDeliveryEngines({
    queue, lifecycle, clock: h.clock,
    constants: { LAUNCH_SETTLE_MS: 1, ENTER_DELAY_MS: 1, RECEIPT_WAIT_MS: 10, RETYPE_BACKOFF_MS: [10], NOT_NOW_RETRY_MS: [1] },
    clientFor: async () => h.stub.client, instanceId: () => row.instance_id,
    call: async (_key, verb, client, run) => {
      if (verb === 'get') { recoveryCalls.push('get'); await beforeGet?.() }
      return run(client)
    },
    persona: () => ({ cwd: persona.working_directory }), isUp: () => up,
    isLatched: () => h.latch.isLatched(key), isHeld: () => h.sequenceRunning(key), isConnected: () => resumed,
    prepare: async () => {}, onRow: applyDeliveryOwnRowRead,
    onKeyError: async (...args) => { await handleDeliveryKeyError(...args); afterKeyError?.() },
    isRestartPendingOrActive: () => options.pending ?? false, scheduleRestart: () => { restartAsks++ },
    recoverGone: (...args) => { recoveryCalls.push('handoff'); handoffs++; owners.push(lifecycle.owner(key)); return recoverDeliveryGone(...args) },
    recoverAbsent: options.recoverAbsent ? (key, launch) => {
      recoveryCalls.push('absent-handoff'); absentHandoffs++
      return acceptAbsent && recoverAbsent(key, launch)
    } : undefined,
    reconnect: async () => {}, onError: (_key, error) => errors.push(error),
  })
  return {
    h, key, queue, engine, lifecycle, keys, owners, errors, recoveryCalls, absentResults, killEntered, releaseKill,
    failed: () => failed, resumed: () => resumed, restarts: () => restartAsks, handoffs: () => handoffs,
    absentHandoffs: () => absentHandoffs,
    setAbsent(value: boolean) { absent = value },
    acceptAbsent(value: boolean) { acceptAbsent = value },
    replaceWithHealthyRow() {
      absent = false; resumed = true
      path = join(h.stateDir, 'replacement-session.jsonl')
      writeTranscript(path, [])
      row = { ...row, session_id: 'replacement-session', jsonl_path: path, launch_started_at: new Date(h.clock.now() + 1).toISOString() }
      h.setConnected(key, true)
    },
    afterKeyError: (hook: () => void) => { afterKeyError = hook },
    setUp(value: boolean) { up = value; h.setUp(key, value) },
    changeRow(patch: Partial<typeof row>) { row = { ...row, ...patch } },
    failReads(error?: Error) { readError = error },
    failStatusReads(error?: Error) { statusError = error },
    beforeGet(hook?: () => Promise<void>) { beforeGet = hook },
    async advance() { await h.clock.advance(1000); await engine.tick(key) },
    async failRecoveryEnter() {
      expect((await h.launch(key)).action).toBe('retrying')
      for (let n = 0; n < 100 && !failed; n++) await this.advance()
      expect(failed).toBe(true)
      expect(keys[0]).toBe('Enter')
    },
    async cleanup() {
      h.shutdown()
      releaseKill()
      await engine.stop()
      await h.driveSequence(h.sequenceSettled(key))
      await queue.stop()
      await lifecycle.stop()
      setDeliveryLifecycle(undefined)
      setDeliveryPersonaLookup(() => undefined)
      try { assertNoLeak(h.captured()); expect(h.clock.pending()).toEqual([]) } finally { h.cleanup() }
    },
  }
}

describe('b.acu: AD GONE during durable startup recovery', () => {
  test.each([0, 60].flatMap(delay => [false, true].map(pending => [delay, pending] as const)))(
    'delay=%s, ordinary restart pending=%s: checked recovery resumes the conversation and drains FIFO', async (delay, pending) => {
      const f = await goneRecovery({ delay, pending })
      try {
        expect(f.queue.openCount(f.key)).toBe(3)
        await f.failRecoveryEnter()
        expect(await f.h.driveSequence(f.h.sequenceSettled(f.key))).toMatchObject({
          kind: LIVE_ROW_OUTCOME_LAUNCHED, launchKind: LIVE_ROW_LAUNCH_RESUME, reason: LIVE_ROW_LAUNCH_REASON_KEEPS_CONVERSATION,
        })
        expect(f.resumed()).toBe(true)
        expect(f.handoffs()).toBe(1)
        expect(f.owners).toEqual(['free'])
        expect(f.restarts()).toBe(0)
        expect(f.h.stub.calls.killCalls).toHaveLength(1)
        expect(f.h.stub.calls.findMissingCalls).toHaveLength(1)
        expect(f.h.stub.calls.resumeCalls).toHaveLength(1)
        expect(f.h.stub.calls.resumeCalls[0]!.instance_id).toBe(f.h.stub.calls.killCalls[0]!.instance_id)
        expect(f.h.stub.calls.deleteCalls).toEqual([])
        expect(f.h.stub.calls.readPaneCalls).toEqual([])
        for (let n = 0; n < 200 && f.queue.openCount(f.key); n++) await f.advance()
        expect(f.queue.openCount(f.key)).toBe(0)
        // The resumed conversation checks the retained draft with Enter
        // before receipt expiry permits retyping the head.
        expect(f.keys).toEqual(['Enter', 'Enter', 'message 0', 'Enter', 'message 1', 'Enter', 'message 2', 'Enter'])
        expect(readQueue(f.h.stateDir, f.key).filter(r => r.kind === 'delivered').map(r => r.seq)).toEqual([1, 2, 3])
        expect(f.errors).toEqual([])
      } finally { await f.cleanup() }
    },
  )

  test('shutdown with a checked kill in flight stops the engine without waiting on its detached sequence', async () => {
    const f = await goneRecovery({ holdKill: true })
    try {
      await f.failRecoveryEnter()
      await f.h.driveSequence(f.killEntered)
      expect(f.h.sequenceRunning(f.key)).toBe(true)
      f.h.shutdown()
      await f.engine.stop()
      const count = f.keys.length
      f.releaseKill()
      await f.h.driveSequence(f.h.sequenceSettled(f.key))
      expect(f.keys).toHaveLength(count)
      expect(f.h.stub.calls.resumeCalls).toEqual([])
      expect(f.queue.openCount(f.key)).toBe(3)
    } finally { await f.cleanup() }
  })

  test('a not-up guard retains GONE without keys until bring-up allows checked recovery', async () => {
    const f = await goneRecovery()
    try {
      f.afterKeyError(() => f.setUp(false))
      await f.failRecoveryEnter()
      const count = f.keys.length
      for (let n = 0; n < 5; n++) await f.advance()
      expect(f.h.stub.calls.killCalls).toEqual([])
      expect(f.keys).toHaveLength(count)
      f.setUp(true)
      await f.advance()
      await f.h.driveSequence(f.h.sequenceSettled(f.key))
      expect(f.h.stub.calls.killCalls).toHaveLength(1)
      expect(f.h.stub.calls.resumeCalls).toHaveLength(1)
      expect(f.restarts()).toBe(0)
    } finally { await f.cleanup() }
  })

  test('a launch changed during GONE classification receives none of the old launch handoff', async () => {
    const f = await goneRecovery()
    try {
      f.afterKeyError(() => f.lifecycle.beforeLaunch(f.key))
      await f.failRecoveryEnter()
      expect(f.handoffs()).toBe(0)
      expect(f.h.stub.calls.killCalls).toEqual([])
      expect(f.h.stub.calls.resumeCalls).toEqual([])
      expect(f.restarts()).toBe(0)
    } finally { await f.cleanup() }
  })

  const retryGone = (f: Awaited<ReturnType<typeof goneRecovery>>, via: 'tick' | 'reconnect') =>
    via === 'tick' ? f.engine.tick(f.key) : f.engine.recoverBeforeReconnect(f.key)

  async function retainGoneThenRemoveRow(f: Awaited<ReturnType<typeof goneRecovery>>) {
    f.afterKeyError(() => f.setUp(false))
    await f.failRecoveryEnter()
    f.setAbsent(true)
    f.setUp(true)
    f.recoveryCalls.length = 0
  }

  async function expectExactFifoAfterAbsentRecovery(f: Awaited<ReturnType<typeof goneRecovery>>) {
    for (let n = 0; n < 200 && f.queue.openCount(f.key); n++) await f.advance()
    expect(f.queue.openCount(f.key)).toBe(0)
    expect(f.keys.filter(k => k !== 'Enter')).toEqual(['message 0', 'message 1', 'message 2'])
    expect(readQueue(f.h.stateDir, f.key).filter(r => r.kind === 'delivered').map(r => [r.seq, r.part])).toEqual([[1, 1], [2, 1], [3, 1]])
    // Further wakes cannot repeat a persisted receipt or a delivered part.
    const keys = [...f.keys]
    for (let n = 0; n < 3; n++) await f.advance()
    expect(f.keys).toEqual(keys)
    expect(readQueue(f.h.stateDir, f.key).filter(r => r.kind === 'delivered')).toHaveLength(3)
  }

  test.each([
    [UNAVAILABLE_RETRY_RUN_NOW_RAN, true],
    [UNAVAILABLE_RETRY_RUN_NOW_ARMED, true],
    [UNAVAILABLE_RETRY_RUN_NOW_RUNNING, false],
    [UNAVAILABLE_RETRY_RUN_NOW_CLOSED, false],
  ] as const)('server absent callback reports ownership correctly for %s', (result, accepted) => {
    const calls: unknown[][] = []
    const recover = productionAbsentRecovery({ launchId: () => 'current' }, {
      runNow: (...args) => { calls.push(args); return result },
    })
    expect(recover('alpha', 'current')).toBe(accepted)
    expect(calls).toEqual([['alpha', { kind: 'delivery-row-absent' }, 'delivery-row-absent']])
  })

  test('server absent callback rejects a stale launch without asking the retry controller', () => {
    const calls: unknown[][] = []
    const recover = productionAbsentRecovery({ launchId: () => 'replacement' }, {
      runNow: (...args) => { calls.push(args); return UNAVAILABLE_RETRY_RUN_NOW_ARMED },
    })
    expect(recover('alpha', 'old-launch')).toBe(false)
    expect(calls).toEqual([])
  })

  test.each(['tick', 'reconnect'] as const)('%s retains GONE when an overlapping pending-only retry stops on an older waiting result', async via => {
    const f = await goneRecovery({ recoverAbsent: true })
    let release!: () => void, entered!: () => void
    const held = new Promise<void>(resolve => { release = resolve })
    const observedWaiting = new Promise<void>(resolve => { entered = resolve })
    try {
      await retainGoneThenRemoveRow(f)
      f.setAbsent(false)
      // Let the real pending-only action observe AD waiting, then delay its
      // result reaching the controller until the engine has observed absence.
      f.h.setAction(async (key, attempt) => {
        const outcome = await f.h.fullModeAction(key, attempt)
        expect(attempt.mode).toBe(UNAVAILABLE_RETRY_MODE_PENDING_ONLY)
        expect(outcome).toEqual({ kind: 'stop', reason: UNAVAILABLE_RETRY_STOP_ROW_LIVE, row: 'waiting', yieldsToFullMode: true })
        entered()
        await held
        return outcome
      })
      f.h.controller.armPendingOnly(f.key)
      expect(f.h.controller.runNow(f.key, { kind: 'pending-row' }, 'pending-row')).toBe(UNAVAILABLE_RETRY_RUN_NOW_RAN)
      await observedWaiting
      f.setAbsent(true)
      await retryGone(f, via)
      expect(f.absentResults).toEqual([UNAVAILABLE_RETRY_RUN_NOW_RUNNING])
      expect(f.queue.openCount(f.key)).toBe(3)
      expect(f.keys).toEqual(['Enter'])
      release()
      await f.h.settle()
      expect(f.h.controller.view(f.key)).toBeUndefined()
      expect(f.resumed()).toBe(false)
      expect(f.h.stub.calls.spawnCalls).toHaveLength(1)
      f.h.setAction(undefined)
      // No clock advance: retained GONE must force the next fresh absence
      // handoff even while the engine's ordinary row cache would still apply.
      await f.engine.tick(f.key)
      await f.h.settle()
      expect(f.absentResults).toEqual([UNAVAILABLE_RETRY_RUN_NOW_RUNNING, UNAVAILABLE_RETRY_RUN_NOW_ARMED])
      expect(f.resumed()).toBe(true)
      expect(f.h.stub.calls.killCalls).toEqual([])
      expect(f.h.stub.calls.resumeCalls).toEqual([])
      expect(f.h.stub.calls.readPaneCalls).toEqual([])
      expect(f.restarts()).toBe(0)
      await expectExactFifoAfterAbsentRecovery(f)
    } finally { release(); await f.cleanup() }
  })

  test('an already armed retry accepts absent GONE ownership and drains exact FIFO receipts', async () => {
    const f = await goneRecovery({ recoverAbsent: true })
    try {
      await retainGoneThenRemoveRow(f)
      f.h.controller.arm(f.key, { kind: 'read-error' })
      await f.engine.tick(f.key)
      await f.h.settle()
      expect(f.absentResults).toEqual([UNAVAILABLE_RETRY_RUN_NOW_RAN])
      expect(f.resumed()).toBe(true)
      await expectExactFifoAfterAbsentRecovery(f)
      expect(f.absentHandoffs()).toBe(1)
    } finally { await f.cleanup() }
  })

  test('a closed retry controller leaves absent GONE retryable without keys or queue loss', async () => {
    const f = await goneRecovery({ recoverAbsent: true })
    try {
      await retainGoneThenRemoveRow(f)
      f.h.controller.close('test shutdown')
      await f.engine.tick(f.key)
      await f.engine.tick(f.key)
      expect(f.absentResults).toEqual([UNAVAILABLE_RETRY_RUN_NOW_CLOSED, UNAVAILABLE_RETRY_RUN_NOW_CLOSED])
      expect(f.h.attempts).toEqual([])
      expect(f.h.stub.calls.spawnCalls).toHaveLength(1)
      expect(f.h.stub.calls.killCalls).toEqual([])
      expect(f.keys).toEqual(['Enter'])
      expect(f.queue.openCount(f.key)).toBe(3)
      expect(readQueue(f.h.stateDir, f.key).filter(r => r.kind === 'delivered')).toEqual([])
    } finally { await f.cleanup() }
  })

  test.each(['tick', 'reconnect'] as const)('%s transfers permanently absent GONE to real retry recovery with delay=0 and drains exact FIFO receipts', async via => {
    const f = await goneRecovery({ delay: 0, recoverAbsent: true })
    try {
      await retainGoneThenRemoveRow(f)
      await retryGone(f, via)
      await f.h.settle()
      expect(f.recoveryCalls.slice(0, 2)).toEqual(['get', 'absent-handoff'])
      expect(f.absentHandoffs()).toBe(1)
      expect(f.handoffs()).toBe(0)
      expect(f.h.attempts.some(a => a.causes.includes('delivery-row-absent'))).toBe(true)
      expect(f.resumed()).toBe(true)
      expect(f.h.stub.calls.spawnCalls).toHaveLength(2) // original collision, then absent-row spawn
      expect(f.h.stub.calls.killCalls).toEqual([])
      expect(f.h.stub.calls.resumeCalls).toEqual([])
      expect(f.h.stub.calls.deleteCalls).toEqual([])
      expect(f.h.stub.calls.readPaneCalls).toEqual([])
      expect(f.restarts()).toBe(0)
      await expectExactFifoAfterAbsentRecovery(f)
      expect(f.absentHandoffs()).toBe(1)
    } finally { await f.cleanup() }
  })

  test('a healthy replacement appearing after absent transfer is re-read by the retry owner without a stale kill', async () => {
    const f = await goneRecovery({ recoverAbsent: true })
    let release!: () => void
    const held = new Promise<void>(resolve => { release = resolve })
    try {
      await retainGoneThenRemoveRow(f)
      f.h.setAction(async (key, attempt) => { await held; return f.h.fullModeAction(key, attempt) })
      await f.engine.tick(f.key)
      expect(f.absentHandoffs()).toBe(1)
      expect(f.queue.openCount(f.key)).toBe(3)
      expect(f.keys).toEqual(['Enter'])
      f.replaceWithHealthyRow()
      release()
      await f.h.settle()
      expect(f.h.stub.calls.killCalls).toEqual([])
      expect(f.h.stub.calls.spawnCalls).toHaveLength(1)
      expect(f.h.stub.calls.resumeCalls).toEqual([])
      await expectExactFifoAfterAbsentRecovery(f)
    } finally { release(); await f.cleanup() }
  })

  test('a rejected absent transfer keeps GONE retryable without queue loss or keys', async () => {
    const f = await goneRecovery({ recoverAbsent: true })
    try {
      await retainGoneThenRemoveRow(f)
      f.acceptAbsent(false)
      await f.engine.tick(f.key)
      expect(f.absentHandoffs()).toBe(1)
      expect(f.h.attempts).toEqual([])
      expect(f.h.stub.calls.killCalls).toEqual([])
      expect(f.keys).toEqual(['Enter'])
      expect(f.queue.openCount(f.key)).toBe(3)
      expect(readQueue(f.h.stateDir, f.key).filter(r => r.kind === 'delivered')).toEqual([])
      f.acceptAbsent(true)
      await f.engine.tick(f.key) // same clock: force a fresh absence read
      await f.h.settle()
      expect(f.absentHandoffs()).toBe(2)
      expect(f.resumed()).toBe(true)
      await expectExactFifoAfterAbsentRecovery(f)
    } finally { await f.cleanup() }
  })

  test('accepted absent recovery preserves the real retry backoff after an AD status refusal', async () => {
    const f = await goneRecovery({ recoverAbsent: true })
    try {
      await retainGoneThenRemoveRow(f)
      f.failStatusReads(errCallTimeout('status'))
      await f.engine.tick(f.key)
      await f.h.settle()
      expect(f.absentHandoffs()).toBe(1)
      expect(f.h.attempts).toHaveLength(1)
      const retry = f.h.controller.view(f.key)!
      expect(retry.dueAt).toBeGreaterThan(f.h.clock.now())
      expect(f.h.stub.calls.spawnCalls).toHaveLength(1)
      expect(f.keys).toEqual(['Enter'])
      expect(f.queue.openCount(f.key)).toBe(3)
      for (let n = 0; n < 3; n++) await f.engine.tick(f.key)
      expect(f.h.controller.view(f.key)).toEqual(retry)
      expect(f.h.attempts).toHaveLength(1)
      expect(f.absentHandoffs()).toBe(1)
      f.failStatusReads()
      expect(await retryNow(f.h, f.key)).toBe(retry.dueAt!)
      expect(f.resumed()).toBe(true)
      expect(f.h.stub.calls.killCalls).toEqual([])
      expect(f.h.stub.calls.resumeCalls).toEqual([])
      await expectExactFifoAfterAbsentRecovery(f)
    } finally { await f.cleanup() }
  })

  test.each(['not up', 'new launch'] as const)('absence read rechecks %s before transferring retained GONE', async guard => {
    const f = await goneRecovery({ recoverAbsent: true })
    try {
      await retainGoneThenRemoveRow(f)
      f.beforeGet(async () => {
        if (guard === 'not up') f.setUp(false)
        else f.lifecycle.beforeLaunch(f.key)
      })
      await f.engine.tick(f.key)
      expect(f.absentHandoffs()).toBe(0)
      expect(f.h.attempts).toEqual([])
      expect(f.h.stub.calls.killCalls).toEqual([])
      expect(f.h.stub.calls.spawnCalls).toHaveLength(1)
      expect(f.keys).toEqual(['Enter'])
      expect(f.queue.openCount(f.key)).toBe(3)
      expect(readQueue(f.h.stateDir, f.key).filter(r => r.kind === 'delivered')).toEqual([])
      if (guard === 'not up') {
        f.beforeGet()
        f.setUp(true)
        await f.engine.tick(f.key)
        await f.h.settle()
        expect(f.absentHandoffs()).toBe(1)
        await expectExactFifoAfterAbsentRecovery(f)
      }
    } finally { await f.cleanup() }
  })

  test.each((['tick', 'reconnect'] as const).flatMap(via =>
    (['session', 'launch timestamp'] as const).map(identity => [via, identity] as const),
  ))('%s freshly rejects retained GONE after an unannounced AD %s change', async (via, identity) => {
    const f = await goneRecovery()
    try {
      f.afterKeyError(() => f.setUp(false))
      await f.failRecoveryEnter()
      expect(f.handoffs()).toBe(0)
      const launch = f.lifecycle.launchId(f.key), keys = f.keys.length
      // No lifecycle notification: the next get is the only way to learn
      // that another process replaced the launch while bring-up held it.
      f.changeRow(identity === 'session' ? { session_id: 'replacement-session' }
        : { launch_started_at: new Date(f.h.clock.now() + 1).toISOString() })
      expect(f.lifecycle.launchId(f.key)).toBe(launch)
      f.setUp(true)
      f.recoveryCalls.length = 0
      await retryGone(f, via)
      expect(f.recoveryCalls[0]).toBe('get')
      expect(f.lifecycle.launchId(f.key)).not.toBe(launch)
      expect(f.handoffs()).toBe(0)
      expect(f.h.stub.calls.killCalls).toEqual([])
      expect(f.h.stub.calls.resumeCalls).toEqual([])
      expect(f.keys).toHaveLength(keys)
      expect(f.queue.openCount(f.key)).toBe(3)
      expect(readQueue(f.h.stateDir, f.key).filter(r => r.kind === 'delivered')).toEqual([])
    } finally { await f.cleanup() }
  })

  test.each((['tick', 'reconnect'] as const).flatMap(via => [
    [via, 'unreadable', () => errCallTimeout('get')],
    [via, 'absent', () => errSpawnNotFound()],
  ] as const))('%s retains GONE and queued work while the fresh AD row is %s', async (via, _label, makeError) => {
    const f = await goneRecovery()
    try {
      f.afterKeyError(() => f.setUp(false))
      await f.failRecoveryEnter()
      const keys = f.keys.length, error = makeError()
      f.failReads(error)
      f.setUp(true)
      f.recoveryCalls.length = 0
      await retryGone(f, via)
      expect(f.recoveryCalls[0]).toBe('get')
      expect(f.handoffs()).toBe(0)
      expect(f.h.stub.calls.killCalls).toEqual([])
      expect(f.h.stub.calls.resumeCalls).toEqual([])
      expect(f.keys).toHaveLength(keys)
      expect(f.queue.openCount(f.key)).toBe(3)
      expect(readQueue(f.h.stateDir, f.key).filter(r => r.kind === 'delivered')).toEqual([])
      expect(f.errors.length).toBeGreaterThan(0)
      expect(f.errors.every(e => e === error)).toBe(true)
      // Retry without advancing the clock: retained GONE must bypass the
      // row cache, and the unchanged life must eventually resume normally.
      f.failReads()
      f.recoveryCalls.length = 0
      await retryGone(f, via)
      expect(f.recoveryCalls.slice(0, 2)).toEqual(['get', 'handoff'])
      await f.h.driveSequence(f.h.sequenceSettled(f.key))
      expect(f.handoffs()).toBe(1)
      expect(f.resumed()).toBe(true)
      expect(f.h.stub.calls.killCalls).toHaveLength(1)
      expect(f.h.stub.calls.resumeCalls).toHaveLength(1)
      for (let n = 0; n < 200 && f.queue.openCount(f.key); n++) await f.advance()
      expect(f.queue.openCount(f.key)).toBe(0)
    } finally { await f.cleanup() }
  })

  test.each(['tick', 'reconnect'] as const)('%s rechecks a not-up guard changed during the fresh GONE get', async via => {
    const f = await goneRecovery()
    let release!: () => void
    const held = new Promise<void>(resolve => { release = resolve })
    let entered!: () => void
    const reading = new Promise<void>(resolve => { entered = resolve })
    try {
      f.afterKeyError(() => f.setUp(false))
      await f.failRecoveryEnter()
      f.setUp(true)
      f.beforeGet(() => { entered(); return held })
      f.recoveryCalls.length = 0
      const retry = retryGone(f, via)
      await reading
      f.setUp(false)
      release()
      await retry
      expect(f.recoveryCalls).toEqual(['get'])
      expect(f.handoffs()).toBe(0)
      expect(f.h.stub.calls.killCalls).toEqual([])
      expect(f.keys).toEqual(['Enter'])
      expect(f.queue.openCount(f.key)).toBe(3)
      f.beforeGet()
      f.setUp(true)
      f.recoveryCalls.length = 0
      await retryGone(f, via)
      expect(f.recoveryCalls.slice(0, 2)).toEqual(['get', 'handoff'])
      await f.h.driveSequence(f.h.sequenceSettled(f.key))
      expect(f.resumed()).toBe(true)
    } finally { release(); await f.cleanup() }
  })

  test('reconnect defers to an in-flight GONE refresh without another read or handoff', async () => {
    const f = await goneRecovery()
    let release!: () => void
    const held = new Promise<void>(resolve => { release = resolve })
    let entered!: () => void
    const reading = new Promise<void>(resolve => { entered = resolve })
    try {
      f.afterKeyError(() => f.setUp(false))
      await f.failRecoveryEnter()
      f.setUp(true)
      f.beforeGet(() => { entered(); return held })
      f.recoveryCalls.length = 0
      const tick = f.engine.tick(f.key)
      await reading
      expect(await f.engine.recoverBeforeReconnect(f.key)).toBe(false)
      expect(f.recoveryCalls).toEqual(['get'])
      expect(f.handoffs()).toBe(0)
      release()
      await tick
      expect(f.recoveryCalls.slice(0, 2)).toEqual(['get', 'handoff'])
      await f.h.driveSequence(f.h.sequenceSettled(f.key))
      expect(f.handoffs()).toBe(1)
      expect(f.h.stub.calls.killCalls).toHaveLength(1)
      expect(f.resumed()).toBe(true)
    } finally { release(); await f.cleanup() }
  })

  test('exhausted checked kills retain the ordinary retry owner, whose later retry resumes recovery', async () => {
    const f = await goneRecovery({ refusedKills: KILL_RETRY_TRIES })
    try {
      await f.failRecoveryEnter()
      await f.h.driveSequence(f.h.sequenceSettled(f.key))
      expect(f.resumed()).toBe(false)
      expect(f.h.stub.calls.killCalls).toHaveLength(KILL_RETRY_TRIES)
      expect(f.h.controller.isArmed(f.key)).toBe(true)
      expect(f.lifecycle.deferred(f.key)).toBeUndefined()
      const count = f.keys.length
      for (let n = 0; n < 5; n++) await f.advance()
      expect(f.keys).toHaveLength(count)
      expect(f.handoffs()).toBe(1)
      await retryNow(f.h, f.key)
      await f.h.driveSequence(f.h.sequenceSettled(f.key))
      expect(f.resumed()).toBe(true)
      expect(f.handoffs()).toBe(2)
      expect(f.h.stub.calls.killCalls).toHaveLength(KILL_RETRY_TRIES + 1)
      expect(f.h.stub.calls.resumeCalls).toHaveLength(1)
      expect(f.restarts()).toBe(0)
    } finally { await f.cleanup() }
  })

  test.each([
    ['UNAVAILABLE', () => errCallTimeout('send-keys')],
    ['dialog refusal', () => errDialogMaybeOpen()],
    ['relay refusal', () => errSendKeysWhileRelayed()],
  ] as const)('%s during recovery Enter retains the queue without a death handoff', async (_label, keyError) => {
    const f = await goneRecovery({ keyError })
    try {
      await f.failRecoveryEnter()
      for (let n = 0; n < 5; n++) await f.advance()
      expect(f.handoffs()).toBe(0)
      expect(f.h.stub.calls.killCalls).toEqual([])
      expect(f.h.stub.calls.resumeCalls).toEqual([])
      expect(f.restarts()).toBe(0)
      expect(f.queue.openCount(f.key)).toBe(3)
      expect(readQueue(f.h.stateDir, f.key).filter(r => r.kind === 'delivered')).toEqual([])
    } finally { await f.cleanup() }
  })
})

describe('durable FIFO and send sequence', () => {
  test.each([
    ['claude', 'lost-enter'],
    ['claude', 'missing-receipt'],
    ['codex', 'lost-enter'],
  ] as const)('one wake autonomously recovers %s / %s and delivers the FIFO successor', async (agent, fault) => {
    // The row must select Codex even when configured fallback says Claude.
    const h = await harness({ configuredAgent: 'claude' })
    await h.accept('first'); await h.accept('second')
    const p = h.p()
    p.row.agent = agent
    if (fault === 'lost-enter') p.lostEnters = 1
    else {
      let enters = 0
      p.keyHook = params => { if (params.key === 'Enter') p.autoReceipt = ++enters > 1; return undefined }
    }
    h.engine.wake('alpha')
    // Drive only the injected timers. Yield the real file writer's pending
    // I/O without calling tick, advance, until or another wake on the harness.
    for (let turns = 0; h.queue.openCount('alpha') > 0 && turns < 1000; turns++) {
      await new Promise<void>(resolve => setImmediate(resolve))
      await h.clock.runNext()
    }
    expect(h.queue.openCount('alpha')).toBe(0)
    expect(h.errors).toEqual([])
    expect(h.events.filter(e => e.type === 'delivered').map(e => e.seq)).toEqual([1, 2])
    expect(h.keyCalls().map(c => c.params.key ?? c.params.text)).toEqual(fault === 'lost-enter'
      ? ['first', 'Enter', 'Enter', 'second', 'Enter']
      : ['first', 'Enter', 'Enter', 'first', 'Enter', 'second', 'Enter'])
    const records = h.records()
    expect(records.filter(r => r.kind === 'sent').map(r => 'send_kind' in r && r.send_kind)).toEqual(fault === 'lost-enter' ? ['text', 'enter', 'text'] : ['text', 'enter', 'retype', 'text'])
    expect(records.filter(r => r.kind === 'sent' || r.kind === 'delivered').map(r => [r.kind, r.seq])).toEqual([
      ['sent', 1], ['sent', 1], ...(fault === 'missing-receipt' ? [['sent' as const, 1]] : []), ['delivered', 1], ['sent', 2], ['delivered', 2],
    ])
    if (agent === 'codex') {
      const transcript = readFileSync(p.path, 'utf8').trim().split('\n').map(line => JSON.parse(line))
      expect(transcript.filter(record => record.type === 'response_item')).toEqual([codexPromptEntry('first'), codexPromptEntry('second')])
    }
    const calls = h.calls.length
    await h.clock.advance(RECEIPT_WAIT_MS)
    expect(h.calls).toHaveLength(calls)
    expect(h.clock.pending()).toEqual([])
  })

  test('30 items, multipart, retries, server reload and bot restart retain strict one-in-flight order', async () => {
    const h = await harness()
    const expected: string[] = []
    for (let n = 0; n < 30; n++) {
      const parts = n === 4 ? [`part ${n}/1`, `part ${n}/2`] : [`message ${n}`]
      expected.push(...parts)
      await h.accept(`message ${n}`, 'alpha', parts)
    }
    const p = h.p(), attempts: string[] = []
    p.keyHook = params => {
      if (params.no_enter) {
        const head = h.queue.items('alpha').find(i => !i.delivered)!
        const pending = head.fixed!.parts.find((_, i) => !head.records.some(r => r.kind === 'delivered' && r.part === i + 1))
        expect(params.text).toBe(pending)
        attempts.push(params.text!)
      }
      return undefined
    }
    p.lostEnters = 1
    await start(h)
    await h.until(() => h.events.filter(e => e.type === 'delivered').length >= 7)
    await h.restartServer()
    h.lifecycle.beforeLaunch('alpha')
    await delivered(h)
    expect(attempts).toEqual(expected)
    expect(h.events.filter(e => e.type === 'delivered').map(e => [e.seq, e.part])).toEqual(expected.flatMap((_, i) => i < 4 ? [[i + 1, 1]] : i === 4 ? [[5, 1]] : i === 5 ? [[5, 2]] : [[i, 1]]))
    expect(h.queue.items('alpha').every(i => i.delivered)).toBe(true)
  })
  test('first text waits for waiting settle; Enter is separate and delayed', async () => {
    const h = await harness()
    await h.accept()
    await h.tick()
    const launch = { key: 'alpha', launchId: h.lifecycle.launchId('alpha'), sessionId: h.p().row.session_id, at: h.clock.now() }
    expect(h.events.filter(e => e.type.startsWith('launch-'))).toEqual([
      { type: 'launch-observed', ...launch }, { type: 'launch-first-waiting', ...launch },
    ])
    await h.advance(LAUNCH_SETTLE_MS - 1)
    expect(h.keyCalls()).toEqual([])
    await h.advance(1)
    expect(h.keyCalls()).toHaveLength(1)
    const text = h.keyCalls()[0]!
    expect(text.params).toEqual({ instance_id: 'cscb_alpha', text: 'message', no_enter: true })
    expect(h.records().filter(r => r.kind === 'sent')).toHaveLength(1)
    await h.advance(ENTER_DELAY_MS - 1)
    expect(h.keyCalls()).toHaveLength(1)
    await h.advance(1)
    expect(h.keyCalls()[1]).toMatchObject({ at: text.at + ENTER_DELAY_MS, params: { instance_id: 'cscb_alpha', key: 'Enter' } })
    await delivered(h)
    expect(h.events).toContainEqual({ type: 'delivered', key: 'alpha', seq: 1, part: 1 })
    const count = h.calls.length
    await h.advance(RECEIPT_WAIT_MS)
    expect(h.calls).toHaveLength(count)
    expect(h.events.filter(e => e.type.startsWith('launch-'))).toHaveLength(2)
  })
  test('first-waiting diagnostics start the settle window once per launch, including a replacement session', async () => {
    // b.omv SR-14.2: launch timing evidence must report the same origin that
    // actually gates typing, even when the first observed row is still busy.
    const h = await harness()
    await h.clock.advance(137)
    for (const [i, state] of (['working', 'pending'] as const).entries()) {
      h.p().row.state = state
      h.p().row.session_id = `session-${i}`
      h.p().path = `${h.root}/session-${i}.jsonl`
      h.p().row.jsonl_path = h.p().path
      writeTranscript(h.p().path, endedTurn())
      await h.accept(`message-${i}`)
      await h.tick()
      await h.until(() => h.events.filter(e => e.type === 'launch-observed').length === i + 1)
      const observed = h.events.filter(e => e.type === 'launch-observed')[i]!
      expect(observed).toEqual({ type: 'launch-observed', key: 'alpha', launchId: h.lifecycle.launchId('alpha'), sessionId: `session-${i}`, at: h.clock.now() })
      await h.advance(LAUNCH_SETTLE_MS + DELIVERY_ROW_POLL_MS)
      expect(h.textCalls()).toHaveLength(i)
      expect(h.events.filter(e => e.type === 'launch-first-waiting')).toHaveLength(i)

      const beforeWaiting = h.calls.length
      h.p().row.state = 'waiting'
      await h.until(() => h.events.filter(e => e.type === 'launch-first-waiting').length === i + 1)
      const firstWaiting = h.events.filter(e => e.type === 'launch-first-waiting')[i]!
      expect(firstWaiting).toEqual({ ...observed, type: 'launch-first-waiting', at: h.calls.slice(beforeWaiting).find(c => c.verb === 'get')!.at })
      await h.advance(firstWaiting.at + LAUNCH_SETTLE_MS - h.clock.now() - 1)
      expect(h.textCalls()).toHaveLength(i)
      await h.advance(1)
      expect(h.textCalls()[i]).toMatchObject({ at: firstWaiting.at + LAUNCH_SETTLE_MS, params: { text: `message-${i}`, no_enter: true } })
      await delivered(h)
      expect(h.events.filter(e => e.type.startsWith('launch-'))).toHaveLength((i + 1) * 2)
    }
    const launches = h.events.filter(e => e.type === 'launch-observed')
    expect(launches[0]!.launchId).not.toBe(launches[1]!.launchId)
    expect(h.errors).toEqual([])
  })
  test('20 sequential idle-ready messages meet AC76 with autonomous timers across empty queues', async () => {
    const h = await harness(), typing: number[] = [], confirmation: number[] = []
    for (let n = 0; n < 20; n++) {
      // A real idle gap, rather than a permanently nonempty batch, exercises
      // retirement of each engine while the native launch stays the same.
      const calls = h.calls.length
      await h.clock.advance(50)
      expect(h.calls).toHaveLength(calls)
      expect(h.clock.pending()).toEqual([])
      expect(h.p().row.state).toBe('waiting')
      expect(h.p().connected).toBe(true)
      expect(h.p().box).toBe('')
      const at = h.clock.now()
      await h.accept(`latency ${n}`)
      h.engine.wake('alpha')
      await drainTimers(h)
      typing.push(h.textCalls()[n]!.at - at)
      confirmation.push(h.clock.now() - at)
    }
    const p95 = (values: number[]) => [...values].sort((a, b) => a - b)[Math.ceil(values.length * .95) - 1]!
    // PRD N2 / AC76: these are latency requirements, independent of retry
    // or receipt-wait constants that happen to have similar values.
    expect(p95(typing)).toBeLessThanOrEqual(2000)
    expect(p95(confirmation)).toBeLessThanOrEqual(10000)
    expect(h.events.filter(e => e.type.startsWith('launch-')).map(e => e.type)).toEqual(['launch-observed', 'launch-first-waiting'])
    expect(h.events.filter(e => e.type === 'delivered').map(e => e.seq)).toEqual(Array.from({ length: 20 }, (_, i) => i + 1))
    expect(h.textCalls().map(c => c.params.text)).toEqual(Array.from({ length: 20 }, (_, i) => `latency ${i}`))
    for (const c of h.calls) expect(h.calls.filter(x => x.at > c.at - 10000 && x.at <= c.at).length).toBeLessThanOrEqual(DELIVERY_MAX_AD_CALLS_PER_S * 10)
    const calls = h.calls.length
    await h.clock.advance(RECEIPT_WAIT_MS)
    expect(h.calls).toHaveLength(calls)
    expect(h.clock.pending()).toEqual([])
    expect(h.errors).toEqual([])
  })
  test.each(['launch', 'session', 'forget', 'server'] as const)('%s after an empty queue starts a new first-waiting settle window', async change => {
    const h = await harness()
    await h.accept('before'); h.engine.wake('alpha'); await drainTimers(h)
    const prior = h.events.filter(e => e.type === 'launch-first-waiting')[0]!
    await h.clock.advance(50)
    if (change === 'launch') h.lifecycle.beforeLaunch('alpha')
    else if (change === 'session') {
      h.p().row.session_id = 'replacement-session'
      h.p().path = `${h.root}/replacement-session.jsonl`
      h.p().row.jsonl_path = h.p().path
      writeTranscript(h.p().path, endedTurn())
    }
    else if (change === 'forget') await h.engine.forget('alpha')
    else await h.restartServer()
    await h.accept('after'); await h.tick()
    const waiting = h.events.filter(e => e.type === 'launch-first-waiting').at(-1)!
    expect(h.events.filter(e => e.type === 'launch-observed')).toHaveLength(2)
    expect(h.events.filter(e => e.type === 'launch-first-waiting')).toHaveLength(2)
    expect(waiting.at).toBe(h.clock.now())
    expect(waiting.at).toBeGreaterThan(prior.at)
    await h.clock.advance(LAUNCH_SETTLE_MS - 1)
    expect(h.textCalls().map(c => c.params.text)).toEqual(['before'])
    await drainTimers(h)
    expect(h.textCalls()[1]!.at).toBeGreaterThanOrEqual(waiting.at + LAUNCH_SETTLE_MS)
    expect(h.textCalls().map(c => c.params.text)).toEqual(['before', 'after'])
    expect(h.errors).toEqual([])
  })
  test('a working row after queue retirement keeps its real first-waiting evidence without inventing another', async () => {
    const h = await harness()
    await h.accept('before'); h.engine.wake('alpha'); await drainTimers(h)
    const launchEvents = h.events.filter(e => e.type.startsWith('launch-'))
    await h.clock.advance(50)
    h.p().row.state = 'working'
    const at = h.clock.now()
    await h.accept('while working'); h.engine.wake('alpha')
    await h.advance(LAUNCH_SETTLE_MS * 2)
    expect(h.textCalls().map(c => c.params.text)).toEqual(['before'])
    h.p().row.state = 'waiting'
    await drainTimers(h)
    expect(h.textCalls().map(c => c.params.text)).toEqual(['before', 'while working'])
    expect(h.textCalls()[1]!.at - at).toBeGreaterThanOrEqual(LAUNCH_SETTLE_MS * 2)
    expect(h.events.filter(e => e.type.startsWith('launch-'))).toEqual(launchEvents)
    expect(h.errors).toEqual([])
  })
  test('an intake wake during the text-to-Enter pause keeps delivery ownership until the separate Enter', async () => {
    const h = await harness(); await h.accept()
    let notifyText!: () => void
    const textTyped = new Promise<void>(resolve => { notifyText = resolve })
    h.p().keyHook = params => { if (params.no_enter) notifyText(); return undefined }
    await h.tick()
    // Use only the production timer here, without the harness's explicit laps.
    const advancing = h.clock.advance(LAUNCH_SETTLE_MS)
    await textTyped; await advancing; await h.clock.flush()
    expect(h.keyCalls()).toHaveLength(1)
    expect(h.lifecycle.owner('alpha')).toBe('delivery')
    h.engine.wake('alpha') // Another accepted event can wake this same engine.
    await h.clock.advance(1)
    expect(h.lifecycle.owner('alpha')).toBe('delivery')
    await h.advance(ENTER_DELAY_MS - 1)
    expect(h.keyCalls()[1]?.params.key).toBe('Enter')
    await delivered(h)
  })
  test('stuck persona holds its own head while another persona delivers', async () => {
    const h = await harness({ keys: ['alpha', 'beta'] })
    await h.accept('stuck'); await h.accept('later'); await h.accept('other', 'beta')
    h.p().row.state = 'working'
    await h.tick(); await h.tick('beta'); await delivered(h, 'beta')
    expect(h.textCalls()).toEqual([])
    expect(h.queue.openCount('alpha')).toBe(2)
    expect(h.textCalls('beta').map(c => c.params.text)).toEqual(['other'])
    h.p().row.state = 'waiting'
    await delivered(h)
    expect(h.textCalls().map(c => c.params.text)).toEqual(['stuck', 'later'])
  })
  test('accepted sends never confirm without a transcript record', async () => {
    const h = await harness()
    await h.accept('first'); await h.accept('second')
    h.p().autoReceipt = false
    await start(h); await h.advance(ENTER_DELAY_MS + RECEIPT_WAIT_MS)
    expect(h.queue.openCount('alpha')).toBe(2)
    expect(h.events.filter(e => e.type === 'delivered')).toEqual([])
    expect(h.textCalls().every(c => c.params.text === 'first')).toBe(true)
    h.p().autoReceipt = true
    await delivered(h)
    expect(h.textCalls().at(-1)?.params.text).toBe('second')
  })

})

describe('fresh send guards', () => {

  test.each(['working', 'relay', 'pending', 'check_permission', 'ask_user', 'latched', 'held', 'down', 'mcp', 'marker'] as const)('%s blocks and then releases the head', async guard => {
    const h = await harness(), p = h.p()
    await h.accept()
    if (guard === 'working') p.row.state = 'working'
    else if (guard === 'relay') p.row.relay_mode = 'off'
    else if (['pending', 'check_permission', 'ask_user'].includes(guard)) p.row.state = guard as typeof p.row.state
    else if (guard === 'latched') p.latched = true
    else if (guard === 'held') p.held = true
    else if (guard === 'down') p.up = false
    else if (guard === 'mcp') p.connected = false
    else p.row.labels.tag_prompt = '0'
    await start(h); await h.advance(RECEIPT_WAIT_MS)
    expect(h.keyCalls()).toEqual([])
    expect(h.queue.openCount('alpha')).toBe(1)
    if (guard === 'marker') expect(h.events.some(e => e.type === 'marker-missing')).toBe(true)
    p.pane = undefined; p.box = ''; p.row.relay_mode = 'on'; p.row.state = 'waiting'; p.latched = false; p.held = false; p.up = true; p.connected = true; p.row.labels.tag_prompt = '1'
    await delivered(h)
    expect(h.textCalls()).toHaveLength(1)
  })

  test('a reconnect gate owner blocks delivery without blocking a sibling persona', async () => {
    const h = await harness({ keys: ['alpha', 'beta'] })
    await h.accept('alpha text'); await h.accept('beta text', 'beta')
    const release = h.lifecycle.acquire('alpha', 'reconnect')!
    await h.tick(); await h.tick('beta'); await delivered(h, 'beta')
    expect(h.keyCalls()).toEqual([])
    release()
    const reconnectRelease = h.lifecycle.acquire('alpha', 'reconnect')!
    await h.advance(RECEIPT_WAIT_MS)
    expect(h.keyCalls()).toEqual([])
    reconnectRelease(); await delivered(h)
    expect(h.textCalls().map(c => c.params.text)).toEqual(['alpha text'])
  })
  test('a key outside the applied set cannot start delivery while its applied sibling continues', async () => {
    const h = await harness({ keys: ['alpha', 'beta'] })
    await h.accept('retired'); await h.accept('live', 'beta')
    h.p().applied = false
    h.engine.wake('alpha'); h.engine.wake('not-configured')
    await h.tick(); await h.tick('not-configured'); await h.tick('beta')
    await delivered(h, 'beta')
    expect(h.keyCalls()).toEqual([])
    expect(h.calls.filter(c => c.key === 'alpha' || c.key === 'not-configured')).toEqual([])
    expect(h.restarts).toEqual([])
    expect(h.queue.openCount('alpha')).toBe(1)
    h.p().applied = true; h.engine.wake('alpha')
    await delivered(h)
    expect(h.textCalls().map(c => c.params.text)).toEqual(['retired'])
  })

})

describe('Enter and at-least-once recovery', () => {

  test.each(['text-typed', 'text-untyped', 'enter'] as const)('unknown %s outcome is checked before another text', async fault => {
    const h = await harness(); await h.accept(); const p = h.p(); let failed = false
    p.keyHook = params => {
      if (!failed && ((fault === 'enter') === (params.key === 'Enter'))) {
        failed = true
        if (fault === 'text-typed') p.box = params.text!
        return errTmuxUnresponsive('send-keys')
      }
      return undefined
    }
    await start(h); await delivered(h)
    expect(h.records().filter(r => r.kind === 'refused')).toEqual([])
    expect(h.textCalls()).toHaveLength(fault === 'text-untyped' ? 2 : 1)
  })
  test.each(['server-between-text-and-Enter', 'server-after-Enter', 'session', 'compaction'] as const)('%s checks existing receipts before retyping', async change => {
    const h = await harness(); await h.accept(); await start(h)
    const p = h.p()
    if (change !== 'server-between-text-and-Enter') await h.advance(ENTER_DELAY_MS)
    if (change.startsWith('server-')) await h.restartServer()
    else if (change === 'session') p.row.session_id = 'resumed-session'
    else appendTranscript(p.path, [{ type: 'system', subtype: 'compact_boundary' }])
    await delivered(h)
    expect(h.textCalls()).toHaveLength(1)
  })
  test('a server crash after durable sent but before the first key recovers the unknown attempt and retypes its head', async () => {
    const h = await harness(); await h.accept('first'); await h.accept('second')
    await h.queue.append('alpha', { v: 1, kind: 'sent', seq: 1, part: 1, attempt: 1, send_kind: 'text', at: h.clock.now(), launch_id: h.lifecycle.launchId('alpha'), session_id: h.p().row.session_id, transcript_path: h.p().path, transcript_size: statSync(h.p().path).size })
    expect(h.keyCalls()).toEqual([])
    await h.restartServer()
    await delivered(h)
    expect(h.textCalls().map(c => c.params.text)).toEqual(['first', 'second'])
    expect(h.records().filter(r => r.kind === 'sent').map(r => 'send_kind' in r && r.send_kind)).toEqual(['text', 'enter', 'retype', 'text'])
    expect(h.events.filter(e => e.type === 'delivered').map(e => e.seq)).toEqual([1, 2])
  })

  test('retypes follow every growing backoff, stay at the last slot and reset after a bot launch', async () => {
    const h = await harness(); await h.accept(); const p = h.p(); p.autoReceipt = false
    await start(h)
    // Unrelated replies never supply a user receipt.
    const original = p.keyHook
    p.keyHook = params => { if (params.key === 'Enter') appendTranscript(p.path, [replyEntry()]); return undefined }
    await h.until(() => h.textCalls().length >= RETYPE_BACKOFF_MS.length + 3, 3 * (RETYPE_BACKOFF_MS.reduce((n, t) => n + t, 0) + RETYPE_BACKOFF_MS.at(-1)! * 3))
    const texts = h.textCalls()
    for (let n = 1; n < texts.length; n++) {
      expect(texts[n]!.at - (texts[n - 1]!.at + ENTER_DELAY_MS)).toBeGreaterThanOrEqual(RETYPE_BACKOFF_MS[Math.min(n - 1, RETYPE_BACKOFF_MS.length - 1)]!)
    }
    expect(h.events.filter(e => e.type === 'first-unconfirmed-retype')).toHaveLength(1)
    await h.advance(ENTER_DELAY_MS)
    expect(h.events.filter(e => e.type === 'retyped')).toHaveLength(texts.length - 1)
    h.lifecycle.beforeLaunch('alpha'); p.autoReceipt = true; p.keyHook = original
    await delivered(h)
    expect(h.textCalls().at(-1)!.at - texts.at(-1)!.at).toBeLessThan(RETYPE_BACKOFF_MS.at(-1)!)
  }, 30000)
})

describe('per-keystroke refusal and storage recovery', () => {
  const refusals = [
    ['invalid flags', () => errInvalidFlags('send-keys')], ['not found', errSpawnNotFound],
    ['pending', () => errSpawnNotInteractive('send-keys')], ['relayed', errSendKeysWhileRelayed],
    ['fallback', errRelayFallenBack], ['dialog', errDialogMaybeOpen], ['pane changed', errPaneChanged],
    ['conflict', () => errTmuxSessionConflict('send-keys', 'not-this-launch')], ['unusable', errUnusableName], ['environment', () => errTmuxNotAvailable(undefined, 'send-keys')],
    ['config', errConfigMalformed], ['binary gone', errSystemInstallDisappeared], ['pane gone', errTmuxSendKeys],
  ] as const
  test.each(refusals)('%s text refusal is durably recorded and never delivered from send success', async (_label, error) => {
    const h = await harness(); await h.accept(); let refused = false
    h.p().keyHook = params => { if (params.no_enter && !refused) { refused = true; return error() }; return undefined }
    await start(h)
    expect(h.records().filter(r => r.kind === 'refused')).toHaveLength(1)
    expect(h.queue.openCount('alpha')).toBe(1)
    if (h.restarts.length) h.lifecycle.beforeLaunch('alpha')
    await delivered(h)
    expect(h.textCalls()).toHaveLength(2)
    expect(deliveryTextWasRefused(error())).toBe(true)
  })
  test.each(refusals)('%s at Enter preserves the accepted text as an unknown outcome and checks it before retyping', async (_label, error) => {
    const h = await harness(); await h.accept(); let failed = false
    h.p().keyHook = params => { if (params.key === 'Enter' && !failed) { failed = true; return error() }; return undefined }
    await start(h); await h.advance(ENTER_DELAY_MS)
    expect(h.records().filter(r => r.kind === 'refused')).toEqual([])
    expect(h.queue.openCount('alpha')).toBe(1)
    expect(h.p().box).toBe('message')
    if (h.restarts.length) h.lifecycle.beforeLaunch('alpha')
    await delivered(h)
    expect(h.textCalls()).toHaveLength(1)
    expect(h.keyCalls().map(c => c.params.key ?? 'text')).toEqual(['text', 'Enter', 'Enter'])
  })
  test('SpawnNotInteractive re-reads pending as a launch in progress, without scheduling a restart', async () => {
    const h = await harness(); await h.accept(); let failed = false
    h.p().keyHook = params => {
      if (params.no_enter && !failed) { failed = true; h.p().row.state = 'pending'; return errSpawnNotInteractive('send-keys') }
      return undefined
    }
    await start(h); await h.advance(RECEIPT_WAIT_MS)
    expect(h.restarts).toEqual([])
    expect(h.keyCalls()).toHaveLength(1)
    expect(h.records().filter(r => r.kind === 'refused')).toHaveLength(1)
    h.p().row.state = 'waiting'
    await delivered(h)
    expect(h.textCalls()).toHaveLength(2)
  })
  test.each(['waiting', 'working'] as const)('a denied subagent request on %s reports the appropriate hold reason without giving up', async state => {
    const h = await harness(); await h.accept()
    h.p().row.unproven_requests = [cannedPermissionRequest({ decision: 'deny' })]
    h.p().keyHook = params => {
      if (params.no_enter) { h.p().row.state = state; return errDialogMaybeOpen() }
      return undefined
    }
    await start(h); await h.advance(RECEIPT_WAIT_MS)
    expect(h.events.some(e => e.type === 'waiting' && e.reason === 'dialog-hold')).toBe(state === 'waiting')
    expect(h.queue.openCount('alpha')).toBe(1)
    h.p().keyHook = undefined; h.p().row.state = 'waiting'; h.p().row.unproven_requests = []
    await delivered(h)
  })
  test.each([['timeout', () => errCallTimeout('send-keys')], ['unclassified', errInternal]] as const)('%s has an unknown outcome, never a refused text', async (_label, error) => {
    const h = await harness(); await h.accept(); let failed = false
    h.p().keyHook = params => { if (params.no_enter && !failed) { failed = true; h.p().box = params.text!; return error() }; return undefined }
    await start(h); await delivered(h)
    expect(h.records().filter(r => r.kind === 'refused')).toEqual([])
    expect(h.textCalls()).toHaveLength(1)
  })
  test('GONE schedules at most one restart under each launch id', async () => {
    const h = await harness(); await h.accept(); h.p().row.state = 'ended'
    await h.tick(); await h.advance(RECEIPT_WAIT_MS)
    expect(h.restarts).toEqual([{ key: 'alpha', cwd: h.root }])
    h.p().row.state = 'pending'; await h.advance(LAUNCH_SETTLE_MS); h.p().row.state = 'ended'; await h.advance(RECEIPT_WAIT_MS)
    expect(h.restarts).toHaveLength(2)
  })
  test.each([false, true])('a GONE text result bars all keys in that launch, restart already pending=%s', async pending => {
    const h = await harness(); await h.accept()
    h.p().restartPending = pending
    let failed = false
    h.p().keyHook = params => { if (params.no_enter && !failed) { failed = true; return errTmuxSendKeys() }; return undefined }
    await start(h)
    expect(h.restarts).toEqual(pending ? [] : [{ key: 'alpha', cwd: h.root }])
    const launch = h.lifecycle.launchId('alpha')
    await h.advance(NOT_NOW_RETRY_MS.at(-1)! + RECEIPT_WAIT_MS)
    expect(h.keyCalls()).toHaveLength(1)
    expect(h.lifecycle.launchId('alpha')).toBe(launch)
    expect(h.queue.openCount('alpha')).toBe(1)
    h.lifecycle.beforeLaunch('alpha')
    await delivered(h)
    expect(h.textCalls()).toHaveLength(2)
    expect(h.restarts).toHaveLength(pending ? 0 : 1)
  })
  test.each([false, true])('retype spacing resets for new items and spans same-item parts, multipart=%s', async multipart => {
    const h = await harness(); await h.accept('first', 'alpha', multipart ? ['first', 'second'] : ['first'])
    if (!multipart) await h.accept('second')
    h.p().autoReceipt = false
    h.p().keyHook = params => { if (params.key === 'Enter') appendTranscript(h.p().path, [replyEntry()]); return undefined }
    await start(h)
    await h.until(() => h.textCalls().filter(c => c.params.text === 'first').length === 3)
    await h.advance(ENTER_DELAY_MS)
    appendTranscript(h.p().path, [promptEntry('first')])
    await h.until(() => h.textCalls().filter(c => c.params.text === 'second').length === 2)
    const second = h.textCalls().filter(c => c.params.text === 'second')
    expect(second[1]!.at - second[0]!.at).toBe(ENTER_DELAY_MS + 2 * Math.max(RECEIPT_WAIT_MS, RETYPE_BACKOFF_MS[multipart ? 2 : 0]))
    h.p().autoReceipt = true
    await delivered(h)
  })
  test.each(['sent', 'delivered', 'refused'] as const)('failed %s append releases the gate, retries durably, and prevents overtaking', async kind => {
    const h = await harness(); await h.accept('first'); await h.accept('second'); h.failAppend(kind)
    if (kind === 'refused') { let failed = false; h.p().keyHook = params => { if (params.no_enter && !failed) { failed = true; return errDialogMaybeOpen() }; return undefined } }
    await start(h); await h.advance(ENTER_DELAY_MS + 1000)
    expect(h.queue.openCount('alpha')).toBe(2)
    expect(h.textCalls().every(c => c.params.text === 'first')).toBe(true)
    expect(h.lifecycle.owner('alpha')).toBe('free')
    await delivered(h)
    expect(h.textCalls().at(-1)?.params.text).toBe('second')
  })
  test('NOT_NOW backoff grows through every slot and resets on accepted text', async () => {
    const h = await harness(); await h.accept(); let remaining = NOT_NOW_RETRY_MS.length + 2
    h.p().keyHook = params => params.no_enter && remaining-- > 0 ? errPaneChanged() : undefined
    await start(h); await delivered(h)
    const texts = h.textCalls()
    for (let n = 1; n < texts.length; n++) expect(texts[n]!.at - texts[n - 1]!.at).toBeGreaterThanOrEqual(NOT_NOW_RETRY_MS[Math.min(n - 1, NOT_NOW_RETRY_MS.length - 1)]!)
  })
})

describe('rolling load bound and lifecycle', () => {
  test.each(['forget', 'stop'] as const)('%s between text and Enter cancels further keys and retains the undelivered queue', async action => {
    const h = await harness({ keys: ['alpha', 'beta'] })
    await h.accept('alpha text'); await h.accept('beta text', 'beta')
    await start(h)
    expect(h.keyCalls()).toHaveLength(1)
    if (action === 'forget') { h.p().applied = false; await h.engine.forget('alpha') }
    else await h.engine.stop()
    const calls = h.calls.filter(c => c.key === 'alpha').length
    await h.advance(ENTER_DELAY_MS + RECEIPT_WAIT_MS)
    expect(h.keyCalls()).toHaveLength(1)
    expect(h.calls.filter(c => c.key === 'alpha')).toHaveLength(calls)
    expect(h.lifecycle.owner('alpha')).toBe('free')
    expect(h.queue.openCount('alpha')).toBe(1)
    expect(h.events.filter(e => e.type === 'delivered' && e.key === 'alpha')).toEqual([])
    if (action === 'forget') { await h.tick('beta'); await delivered(h, 'beta'); expect(h.textCalls('beta').map(c => c.params.text)).toEqual(['beta text']) }
    else expect(h.keyCalls('beta')).toEqual([])
  })
  test('call budget includes its exact sliding-window boundary', () => {
    let now = 0
    const budget = createDeliveryCallBudget(() => now)
    for (let i = 0; i < DELIVERY_MAX_AD_CALLS_PER_S * 10; i++) budget()
    expect(budget).toThrow(DeliveryBudgetWait)
    now = 9999; expect(budget).toThrow(DeliveryBudgetWait)
    now = 10000; expect(budget).not.toThrow()
  })
  test('runtime never exceeds the per-persona call budget and empty queues make no calls', async () => {
    const h = await harness()
    h.engine.wake('alpha'); await h.tick(); await h.advance(RECEIPT_WAIT_MS)
    expect(h.calls).toEqual([])
    for (let i = 0; i < 25; i++) await h.accept(`m${i}`)
    await start(h); await delivered(h)
    for (const c of h.calls) expect(h.calls.filter(x => x.at > c.at - 10000 && x.at <= c.at).length).toBeLessThanOrEqual(DELIVERY_MAX_AD_CALLS_PER_S * 10)
    expect(h.textCalls()).toHaveLength(25)
    const before = h.calls.length
    await h.engine.forget('alpha'); await h.advance(RECEIPT_WAIT_MS)
    expect(h.calls).toHaveLength(before)
    expect(h.clock.pendingCount()).toBe(0)
  })
})

// b.omv SR-8.6: events distinguish a confirmed part from durable item completion.
describe('operational delivery events', () => {
  test('failed final append emits neither part nor whole-item completion until the receipt is durable', async () => {
    const h = await harness()
    await h.accept('body')
    h.failAppend('delivered')
    await start(h)
    await h.until(() => h.errors.length > 0)
    expect(h.events.filter(e => e.type === 'item-delivered' || e.type === 'delivered')).toEqual([])
    expect(h.queue.openCount('alpha')).toBe(1)
    await delivered(h)
    expect(h.events.filter(e => e.type === 'item-delivered')).toEqual([{ type: 'item-delivered', key: 'alpha', seq: 1, at: expect.any(Number), waitMs: expect.any(Number) }])
    expect(h.events.filter(e => e.type === 'delivered')).toHaveLength(1)
    expect(h.textCalls()).toHaveLength(1)
  })
  test('first typing happens once across retries and later parts', async () => {
    const h = await harness()
    await h.accept('message', 'alpha', ['part one', 'part two'])
    h.p().row.state = 'working'
    await start(h)
    expect(h.events.filter(e => e.type === 'first-typed')).toEqual([])
    const status = h.engine.status('alpha')!
    expect(status).toMatchObject({ key: 'alpha', seq: 1, count: 1, row: 'working', marker: true, relay: true, connected: true, ageMs: expect.any(Number), retypeCount: 0 })
    expect(JSON.stringify(status)).not.toContain('message')
    expect(JSON.stringify(status)).not.toContain('operator text')
    h.p().row.state = 'waiting'; h.p().lostEnters = 1
    await delivered(h)
    expect(h.events.filter(e => e.type === 'first-typed')).toEqual([{ type: 'first-typed', key: 'alpha', seq: 1, part: 1 }])
    expect(h.events.filter(e => e.type === 'delivered').map(e => 'part' in e && e.part)).toEqual([1, 2])
    expect(h.events.filter(e => e.type === 'item-delivered')).toHaveLength(1)
    expect(h.keyCalls().filter(c => c.params.key === 'Enter')).toHaveLength(3)
  })
})

describe('AD authority regressions', () => {
  test.each(['claude', 'codex'] as const)('%s waiting permits delivery without reading arbitrary pane contents', async agent => {
    const h = await harness(), p = h.p()
    p.row.agent = agent
    p.pane = 'arbitrary private terminal content with no supported markers'
    p.paneError = new Error('pane must not be consulted for delivery')
    await h.accept('exact queued text')
    await start(h); await delivered(h)
    expect(h.keyCalls().map(c => c.params.key ?? c.params.text)).toEqual(['exact queued text', 'Enter'])
    expect(h.calls.filter(c => c.verb === 'read-pane')).toEqual([])
    expect(h.queue.openCount('alpha')).toBe(0)
  })

  test.each(['claude', 'codex'] as const)('%s working never types from transcript completion or elapsed idle deadlines', async agent => {
    const h = await harness(), p = h.p()
    p.row.agent = agent; p.row.state = 'working'
    writeTranscript(p.path, agent === 'claude' ? endedTurn() : [
      { type: 'event_msg', payload: { type: 'task_started' } },
      { type: 'event_msg', payload: { type: 'task_complete' } },
    ])
    await h.accept('waiting for AD')
    await start(h); await h.advance(240000)
    expect(h.keyCalls()).toEqual([])
    expect(h.queue.openCount('alpha')).toBe(1)
    expect(h.calls.filter(c => c.verb === 'read-pane')).toEqual([])
    p.row.state = 'waiting'
    await delivered(h)
    expect(h.textCalls().map(c => c.params.text)).toEqual(['waiting for AD'])
  })

  test('Enter rechecks AD waiting after text and keeps the head queued while AD reports working', async () => {
    const h = await harness(), p = h.p()
    p.keyHook = params => { if (params.no_enter) p.row.state = 'working'; return undefined }
    await h.accept('head'); await h.accept('successor')
    await start(h); await h.advance(ENTER_DELAY_MS + RECEIPT_WAIT_MS + RETYPE_BACKOFF_MS[0])
    expect(h.keyCalls().map(c => c.params.key ?? c.params.text)).toEqual(['head'])
    expect(h.queue.openCount('alpha')).toBe(2)
    expect(h.records().filter(r => r.kind === 'delivered')).toEqual([])
    p.keyHook = undefined; p.row.state = 'waiting'
    await delivered(h)
    expect(h.textCalls().map(c => c.params.text)).toEqual(['head', 'successor'])
    expect(h.events.filter(e => e.type === 'delivered').map(e => e.seq)).toEqual([1, 2])
  })

  test('a recovery Enter is durable before the key and an append failure keeps the FIFO head queued', async () => {
    const h = await harness(), p = h.p()
    p.lostEnters = 1
    await h.accept('head'); await h.accept('successor')
    await start(h); await h.advance(ENTER_DELAY_MS)
    h.failAppend('sent')
    await h.until(() => h.errors.length > 0)
    expect(h.keyCalls().map(c => c.params.key ?? c.params.text)).toEqual(['head', 'Enter'])
    expect(h.queue.openCount('alpha')).toBe(2)
    expect(h.records().filter(r => r.kind === 'sent')).toHaveLength(1)
    p.keyHook = params => {
      if (params.key === 'Enter' && h.textCalls().length === 1) {
        expect(h.records().filter(r => r.kind === 'sent').at(-1)).toMatchObject({ seq: 1, part: 1, send_kind: 'enter', attempt: 2 })
      }
      return undefined
    }
    await delivered(h)
    expect(h.textCalls().map(c => c.params.text)).toEqual(['head', 'successor'])
    expect(h.events.filter(e => e.type === 'delivered').map(e => e.seq)).toEqual([1, 2])
    expect(h.calls.filter(c => c.verb === 'read-pane')).toEqual([])
  })

  test('a restart after an uncertain recovery Enter retries the retained text with Enter before the successor', async () => {
    const h = await harness(), p = h.p()
    p.lostEnters = 1
    let enters = 0
    p.keyHook = params => params.key === 'Enter' && ++enters === 2 ? errTmuxUnresponsive('send-keys') : undefined
    await h.accept('head'); await h.accept('successor')
    await start(h); await h.until(() => enters === 2)
    expect(h.records().filter(r => r.kind === 'sent').at(-1)).toMatchObject({ seq: 1, send_kind: 'enter', attempt: 2 })
    expect(h.queue.openCount('alpha')).toBe(2)
    p.keyHook = undefined
    await h.restartServer(); await delivered(h)
    expect(h.textCalls().map(c => c.params.text)).toEqual(['head', 'successor'])
    expect(h.records().filter(r => r.kind === 'sent').map(r => 'send_kind' in r && r.send_kind)).toEqual(['text', 'enter', 'enter', 'text'])
    expect(h.events.filter(e => e.type === 'delivered').map(e => e.seq)).toEqual([1, 2])
  })

  test('non-receipt transcript records neither confirm delivery nor change the launch identity', async () => {
    const h = await harness(), p = h.p()
    p.autoReceipt = false
    await h.accept('exact head'); await start(h); await h.advance(ENTER_DELAY_MS)
    const launch = h.lifecycle.launchId('alpha')
    p.row.state = 'working'
    appendTranscript(p.path, [
      promptEntry('different message'), replyEntry(),
      queueOperationEntry('remove', 'exact head', 'delivered_to_agent'),
      { type: 'system', subtype: 'compact_boundary' },
    ])
    await h.advance(240000)
    expect(h.queue.openCount('alpha')).toBe(1)
    expect(h.records().filter(r => r.kind === 'delivered')).toEqual([])
    expect(h.lifecycle.launchId('alpha')).toBe(launch)
    expect(h.textCalls()).toHaveLength(1)
    appendTranscript(p.path, [promptEntry('exact head')])
    await delivered(h)
    expect(h.textCalls()).toHaveLength(1)
    expect(h.records().filter(r => r.kind === 'delivered')).toHaveLength(1)
  })
})


describe('disconnected delivery draft is recovered before reconnect control text', () => {
  async function retainedDraft(failRecoveryAppend = false) {
    const h = await harness()
    await h.accept('retained delivery'); await h.accept('successor')
    const p = h.p()
    p.connected = false; p.autoReceipt = false; p.box = 'retained delivery'
    await h.queue.append('alpha', {
      v: 1, kind: 'sent', seq: 1, part: 1, attempt: 1, send_kind: 'text', at: 0,
      launch_id: 'old-start:1', session_id: p.row.session_id, transcript_path: p.path, transcript_size: 0,
    })
    if (failRecoveryAppend) h.failAppend('sent')
    expect(await h.engine.recoverBeforeReconnect('alpha')).toBe(false)
    await h.advance(LAUNCH_SETTLE_MS)
    return h
  }

  test('an AD read timeout releases the lease without ending the recovery receipt wait', async () => {
    const h = await retainedDraft(), p = h.p()
    expect(h.keyCalls()).toEqual([{ key: 'alpha', verb: 'send-keys', at: LAUNCH_SETTLE_MS, params: { instance_id: 'cscb_alpha', key: 'Enter' } }])
    const timeout = errCallTimeout('get')
    p.getError = timeout
    await h.advance(DELIVERY_ROW_POLL_MS)
    expect(h.errors).toEqual([timeout])
    expect(h.lifecycle.owner('alpha')).toBe('free')
    p.getError = undefined
    await h.clock.advance(1)
    expect(await h.engine.recoverBeforeReconnect('alpha')).toBe(false)
    expect(h.clock.now()).toBe(LAUNCH_SETTLE_MS + DELIVERY_ROW_POLL_MS + 1)
    expect(h.engine.snapshot('alpha')?.e.timers.receipt).toBe(RECEIPT_WAIT_MS - DELIVERY_ROW_POLL_MS - 1)
    await h.advance(RECEIPT_WAIT_MS - DELIVERY_ROW_POLL_MS - 2)
    expect(await h.engine.recoverBeforeReconnect('alpha')).toBe(false)
    expect(h.engine.snapshot('alpha')?.e.timers.receipt).toBe(1)
    await h.advance(1)
    expect(await h.engine.recoverBeforeReconnect('alpha')).toBe(true)
    expect(h.keyCalls().map(c => c.params)).toEqual([{ instance_id: 'cscb_alpha', key: 'Enter' }])
    expect(h.records().filter(r => r.kind === 'sent').map(r => [r.seq, 'send_kind' in r && r.send_kind, r.at])).toEqual([[1, 'text', 0], [1, 'enter', LAUNCH_SETTLE_MS]])
    expect(h.records().filter(r => r.kind === 'delivered')).toEqual([])
    expect(h.queue.openCount('alpha')).toBe(2)
    expect(h.calls.filter(c => c.verb === 'read-pane' || c.verb === 'reconnect')).toEqual([])
  })

  test('an exact recovery receipt permits reconnect early only after its delivered append is durable', async () => {
    const h = await retainedDraft(), p = h.p()
    await h.advance(DELIVERY_ROW_POLL_MS)
    const offset = statSync(p.path).size
    const receipt = { ...promptEntry('retained delivery'), uuid: 'recovery-receipt' }
    appendTranscript(p.path, [receipt])
    const append = h.queue.append.bind(h.queue)
    let markWriting!: () => void, releaseAppend!: () => void
    const writing = new Promise<void>(resolve => { markWriting = resolve })
    const held = new Promise<void>(resolve => { releaseAppend = resolve })
    h.queue.append = async (key, record) => {
      if (record.kind === 'delivered') { markWriting(); await held }
      await append(key, record)
    }
    const recovering = h.engine.recoverBeforeReconnect('alpha')
    await writing
    try {
      expect(await h.engine.recoverBeforeReconnect('alpha')).toBe(false)
      expect(h.records().filter(r => r.kind === 'delivered')).toEqual([])
      expect(h.queue.openCount('alpha')).toBe(2)
      expect(h.events.filter(e => e.type === 'delivered')).toEqual([])
    } finally { releaseAppend() }
    expect(await recovering).toBe(true)
    expect(h.clock.now()).toBeLessThan(LAUNCH_SETTLE_MS + RECEIPT_WAIT_MS)
    expect(h.records().filter(r => r.kind === 'delivered')).toEqual([
      { v: 1, kind: 'delivered', seq: 1, part: 1, at: LAUNCH_SETTLE_MS + DELIVERY_ROW_POLL_MS, receipt: { path: p.path, uuid: receipt.uuid, offset } },
    ])
    expect(h.events.filter(e => e.type === 'delivered')).toEqual([{ type: 'delivered', key: 'alpha', seq: 1, part: 1 }])
    expect(h.queue.openCount('alpha')).toBe(1)
    expect(h.keyCalls().map(c => c.params)).toEqual([{ instance_id: 'cscb_alpha', key: 'Enter' }])
  })

  test('a failed recovery-intent append keeps reconnect blocked through the append backoff', async () => {
    const h = await retainedDraft(true)
    expect(h.errors).toHaveLength(1)
    expect(h.lifecycle.owner('alpha')).toBe('free')
    expect(h.records().filter(r => r.kind === 'sent')).toHaveLength(1)
    expect(h.keyCalls()).toEqual([])
    expect(await h.engine.recoverBeforeReconnect('alpha')).toBe(false)
    await h.advance(RETYPE_BACKOFF_MS[0] - 1)
    expect(await h.engine.recoverBeforeReconnect('alpha')).toBe(false)
    expect(h.keyCalls()).toEqual([])
    await h.advance(1)
    expect(h.keyCalls().map(c => c.params)).toEqual([{ instance_id: 'cscb_alpha', key: 'Enter' }])
    expect(h.records().filter(r => r.kind === 'sent').at(-1)).toMatchObject({ seq: 1, part: 1, attempt: 2, send_kind: 'enter' })
    expect(await h.engine.recoverBeforeReconnect('alpha')).toBe(false)
    expect(h.queue.openCount('alpha')).toBe(2)
    expect(h.records().filter(r => r.kind === 'delivered')).toEqual([])
  })

  test('AD working extends recovery through a fresh receipt wait after waiting, even when a timeout freed the lease', async () => {
    const h = await retainedDraft(), p = h.p()
    p.row.state = 'working'
    await h.advance(DELIVERY_ROW_POLL_MS)
    expect(h.engine.status('alpha')?.receiptWorking).toBe(true)
    p.getError = errCallTimeout('get')
    await h.advance(DELIVERY_ROW_POLL_MS)
    expect(h.lifecycle.owner('alpha')).toBe('free')
    p.getError = undefined
    await h.advance(RECEIPT_WAIT_MS)
    expect(await h.engine.recoverBeforeReconnect('alpha')).toBe(false)
    expect(h.engine.status('alpha')?.receiptWorking).toBe(true)
    p.row.state = 'waiting'
    await h.advance(DELIVERY_ROW_POLL_MS)
    const waitingAt = h.clock.now()
    expect(h.engine.status('alpha')?.receiptWorking).toBe(false)
    expect(await h.engine.recoverBeforeReconnect('alpha')).toBe(false)
    expect(h.engine.snapshot('alpha')?.e.timers.receipt).toBe(RECEIPT_WAIT_MS)
    await h.advance(RECEIPT_WAIT_MS - 1)
    expect(await h.engine.recoverBeforeReconnect('alpha')).toBe(false)
    await h.advance(1)
    expect(h.clock.now()).toBe(waitingAt + RECEIPT_WAIT_MS)
    expect(await h.engine.recoverBeforeReconnect('alpha')).toBe(true)
    expect(h.keyCalls().map(c => c.params)).toEqual([{ instance_id: 'cscb_alpha', key: 'Enter' }])
    expect(h.queue.openCount('alpha')).toBe(2)
    expect(h.records().filter(r => r.kind === 'delivered')).toEqual([])
  })

  test.each(['none', 'refused-enter', 'unknown-enter'] as const)(
    '%s: recovery retries Enter without repeating retained delivery text and keeps the FIFO head until its exact receipt', async fault => {
      const h = await harness()
      await h.accept('retained delivery')
      const p = h.p()
      p.connected = false
      p.autoReceipt = false
      p.box = 'retained delivery'
      await h.queue.append('alpha', {
        v: 1, kind: 'sent', seq: 1, part: 1, attempt: 1, send_kind: 'text', at: 0,
        launch_id: 'old-start:1', session_id: p.row.session_id, transcript_path: p.path, transcript_size: 0,
      })
      let enters = 0
      p.keyHook = params => {
        if (params.key === 'Enter' && ++enters === 1) {
          if (fault === 'refused-enter') return errDialogMaybeOpen()
          if (fault === 'unknown-enter') return errCallTimeout('send-keys')
        }
        return undefined
      }
      expect(await h.engine.recoverBeforeReconnect('alpha')).toBe(false)
      expect(h.keyCalls()).toEqual([])
      await h.advance(LAUNCH_SETTLE_MS)
      if (fault !== 'none') {
        expect(await h.engine.recoverBeforeReconnect('alpha')).toBe(false)
        await h.until(() => enters >= 2)
      }
      await h.advance(RECEIPT_WAIT_MS + 1000)
      expect(await h.engine.recoverBeforeReconnect('alpha')).toBe(true)
      expect(h.keyCalls().map(c => c.params)).toEqual(Array.from({ length: fault === 'none' ? 1 : 2 }, () => ({ instance_id: 'cscb_alpha', key: 'Enter' })))
      expect(h.queue.openCount('alpha')).toBe(1)
      expect(h.p().box).toBe('')
      expect(h.calls.filter(c => c.verb === 'read-pane')).toEqual([])
      expect(h.events.filter(e => e.type === 'delivered')).toEqual([])
    },
  )
})


test('a reconnect timer outlived by a six-second AD read resumes its retained command once and shuts down', async () => {
  const h = await harness()
  await h.accept('delivery before reconnect')
  const p = h.p()
  p.connected = false
  p.autoReceipt = false
  p.box = 'delivery before reconnect'
  await h.queue.append('alpha', { v: 1, kind: 'sent', seq: 1, part: 1, attempt: 1, send_kind: 'text', at: 0,
    launch_id: 'previous-start:1', session_id: p.row.session_id, transcript_path: p.path, transcript_size: 0 })
  expect(await h.engine.recoverBeforeReconnect('alpha')).toBe(false)
  await h.advance(LAUNCH_SETTLE_MS + RECEIPT_WAIT_MS + 1000)
  expect(await h.engine.recoverBeforeReconnect('alpha')).toBe(true)
  expect(h.keyCalls().map(c => c.params)).toEqual([{ instance_id: 'cscb_alpha', key: 'Enter' }])

  // Let the lifecycle timer be the next driver, with the previous delivery
  // reconciled and a reconnect text already retained in the terminal.
  for (const timer of h.clock.pending()) h.clock.clearTimeout(timer)
  const command = `/mcp reconnect ${MCP_SERVER_NAME}`
  p.box = command
  h.lifecycle.rememberReconnectInput('alpha', { launch: h.lifecycle.launchId('alpha'), session: p.row.session_id })
  let reads = 0, reading = 0, maxReading = 0, callbacks = 0, settled = false
  const submitted: string[] = []
  const get = h.client().get.bind(h.client())
  h.client().get = async params => {
    reads++; reading++; maxReading = Math.max(maxReading, reading)
    try {
      if (reads === 1) await new Promise<void>(resolve => h.clock.setTimeout(resolve, 6000))
      return await get(params)
    } finally { reading-- }
  }
  p.keyHook = params => { if (params.key === 'Enter') submitted.push(p.box); return undefined }
  h.lifecycle.setReconnect(async key => {
    callbacks++
    expect(await h.lifecycle.recoverBeforeReconnect(key)).toBe(true)
    await h.client().sendKeys({ instance_id: 'cscb_alpha', key: 'Enter' })
    h.lifecycle.clearReconnectInput(key)
    h.lifecycle.clearDeferred(key)
    settled = true
  })
  h.lifecycle.defer('alpha')
  await h.clock.advance(NOT_NOW_RETRY_MS[0])
  expect([callbacks, reads, settled]).toEqual([1, 1, false])
  await h.clock.advance(6000)
  for (let turn = 0; !settled && turn < 100; turn++) await new Promise<void>(resolve => setImmediate(resolve))
  expect(settled).toBe(true)
  expect(submitted).toEqual([command])
  expect([callbacks, maxReading, p.box]).toEqual([1, 1, ''])
  expect(h.textCalls()).toEqual([])
  expect(h.queue.openCount('alpha')).toBe(1)
  expect(h.errors).toEqual([])
  let stopped = false
  const stopping = h.engine.stop().then(() => { stopped = true })
  await h.clock.flush()
  expect(stopped).toBe(true)
  await stopping
})
