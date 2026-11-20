import { afterEach, describe, expect, test } from 'bun:test'
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { getFailureCount } from '../src/backoff.ts'
import { MCP_SERVER_NAME } from '../src/config.ts'
import { latchRowStateRead } from '../src/conflict-latch.ts'
import { createDeliveryLifecycle, ENTER_DELAY_MS, NOT_NOW_RETRY_MS } from '../src/delivery-engine.ts'
import * as session from '../src/session-manager.ts'
import { personaInstanceId } from '../src/persona-identity.ts'
import { errCallTimeout, errSubmissionUnconfirmed, errTmuxSessionConflict } from './test-helpers/agent-director-stub.ts'
import { installRecoverySubmissionInputServices, makeRecoveryHarness, personaOf, personaRow } from './test-helpers/recovery-harness.ts'
import { makeInputHoldFixture } from './test-helpers/ad-input-holds.ts'
import { assertNoLeak } from './test-helpers/credentials.ts'

const cleanups: Array<() => void | Promise<void>> = []
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup() })
const uncertain = { outcome: 'submission_unconfirmed', keys_sent: true, submission_confirmed: false, enter_may_have_been_sent: true }
const noInput = { outcome: 'not_started', keys_sent: false, submission_confirmed: false, enter_may_have_been_sent: false }
const command = `/mcp reconnect ${MCP_SERVER_NAME}`
const failedReadCases = (['text', 'enter'] as const).flatMap(step => [
  { step, fault: 'timeout', error: () => errCallTimeout('get') },
  { step, fault: 'refusal', error: () => errTmuxSessionConflict('get', 'different-id') },
])

function fixture(step: 'text' | 'enter', details: unknown = uncertain, readFailure?: Error) {
  const h = makeRecoveryHarness({ harnessNow: true })
  const results: unknown[] = []
  cleanups.push(() => { try { assertNoLeak({ captured: h.captured(), results }) } finally { h.cleanup() } })
  const key = h.keys[0]!, sibling = h.keys[1]!
  let life = createDeliveryLifecycle({ clock: h.clock })
  session.setDeliveryLifecycle(life)
  cleanups.push(async () => { await life.stop(); session.setDeliveryLifecycle(undefined) })
  const row = personaRow(h, key, { state: 'waiting', relay_mode: 'on' })
  row.labels = { ...row.labels, tag_prompt: '1' }
  const otherRow = personaRow(h, sibling, { state: 'waiting', relay_mode: 'on' })
  otherRow.labels = { ...otherRow.labels, tag_prompt: '1' }
  let failed = false, getsAfterError = 0, failedReads = 0
  const timeline: string[] = []
  h.script({
    getFn: params => {
      timeline.push('get')
      if (failed) {
        getsAfterError++
        if (getsAfterError === 1 && readFailure) { failedReads++; return readFailure }
      }
      return params.instance_id === personaInstanceId(key) ? row : otherRow
    },
    sendKeysFn: params => {
      timeline.push(params.no_enter ? 'text' : 'Enter')
      if (!failed && (step === 'text' ? params.no_enter : params.key === 'Enter')) { failed = true; return errSubmissionUnconfirmed(details) }
      return {}
    },
  })
  async function run(k = key) {
    const work = session.reconnectMcpWithCause(k, latchRowStateRead('waiting'))
    await h.clock.flush(); await h.clock.advance(ENTER_DELAY_MS)
    try { const result = await work; results.push(result); return result }
    catch (error) { results.push(error); throw error }
  }
  return { h, key, sibling, row, run, timeline, getsAfterError: () => getsAfterError, failedReads: () => failedReads,
    life: () => life,
    async restartLifecycle() { await life.stop(); life = createDeliveryLifecycle({ clock: h.clock }); session.setDeliveryLifecycle(life) },
  }
}

function noRestart(f: ReturnType<typeof fixture>) {
  expect(getFailureCount(f.key)).toBe(0)
  expect(f.h.stub.calls.spawnCalls).toEqual([])
  expect(f.h.stub.calls.resumeCalls).toEqual([])
  expect(f.h.stub.calls.killCalls).toEqual([])
  expect(f.h.notices).toEqual([])
  expect(f.h.triggers).toEqual([])
}

describe('reconnect native submission refusal', () => {
  test.each(failedReadCases)('$step uncertainty stays held when its required fresh get returns $fault', async ({ step, error }) => {
    const f = fixture(step, uncertain, error())
    expect((await f.run()).outcome).toBe('input-unconfirmed')
    expect(f.failedReads()).toBe(1)
    expect(f.getsAfterError()).toBe(1)
    expect(f.timeline.slice(-2)).toEqual([step === 'text' ? 'text' : 'Enter', 'get'])
    expect(f.life().inputHeld(f.key)).toBe(true)
    const calls = [...f.h.stub.calls.sendKeysCalls]
    // The injected failure is one-shot: subsequent reads are ordinary waiting.
    for (const deadline of NOT_NOW_RETRY_MS) {
      await f.h.clock.advance(deadline + ENTER_DELAY_MS)
      expect((await f.run()).outcome).toBe('input-unconfirmed')
      expect(f.h.stub.calls.sendKeysCalls).toEqual(calls)
      expect(f.life().inputHeld(f.key)).toBe(true)
    }
    expect([...f.h.lines, ...f.h.errors].join('\n')).not.toContain('nothing was typed')
    expect(f.h.stub.calls.readPaneCalls).toEqual([])
    noRestart(f)
  })

  test.each(['text', 'enter'] as const)('%s uncertainty returns a held result, reads AD once and never claims no input', async step => {
    const f = fixture(step)
    const result = await f.run()
    expect(result).toMatchObject({ outcome: 'input-unconfirmed', facts: { kind: 'submission_unconfirmed', step, next: 'hold-and-read' } })
    expect(f.getsAfterError()).toBe(1)
    expect([...f.h.lines, ...f.h.errors].join('\n')).not.toContain('nothing was typed')
    const calls = [...f.h.stub.calls.sendKeysCalls]
    await f.h.clock.advance(NOT_NOW_RETRY_MS[0] * 3)
    await f.run()
    expect(f.h.stub.calls.sendKeysCalls).toEqual(calls)
    expect(f.h.stub.calls.readPaneCalls).toEqual([])
    noRestart(f)
  })

  test('validated not_started text retires only that intent; later retry reads AD before typing', async () => {
    const f = fixture('text', noInput)
    expect((await f.run()).outcome).toBe('transient')
    expect(f.getsAfterError()).toBe(1)
    const timeline = f.timeline.length
    f.row.state = 'working'; await f.run()
    expect(f.h.stub.calls.sendKeysCalls).toHaveLength(1)
    f.row.state = 'waiting'
    expect((await f.run()).outcome).toBe('ok')
    expect(f.timeline.slice(timeline)[0]).toBe('get')
    expect(f.h.stub.calls.sendKeysCalls.map(p => p.text ?? p.key)).toEqual([command, command, 'Enter'])
    noRestart(f)
  })

  test('validated not_started Enter retains its successful text and never retypes it', async () => {
    const f = fixture('enter', noInput)
    expect((await f.run()).outcome).toBe('transient')
    expect((await f.run()).outcome).toBe('ok')
    expect(f.h.stub.calls.sendKeysCalls.map(p => p.text ?? p.key)).toEqual([command, 'Enter', 'Enter'])
    expect(f.life().reconnectInput(f.key)).toBeUndefined()
    noRestart(f)
  })
})

describe('reconnect durable B ruling', () => {
  async function persistent(step: 'text' | 'enter', readFailure?: Error) {
    const f = fixture(step, uncertain, readFailure)
    const disk = await makeInputHoldFixture(f.h.stateDir, f.h.clock.now)
    for (const key of f.h.keys) disk.store.load(key)
    let reset = await installRecoverySubmissionInputServices(f.h, disk.store)
    cleanups.push(() => reset())
    return { ...f, disk, async reload() {
      reset(); await f.restartLifecycle()
      const holds = disk.fresh()
      for (const key of f.h.keys) holds.load(key)
      reset = await installRecoverySubmissionInputServices(f.h, holds)
      return holds
    } }
  }

  test.each(failedReadCases)('$step uncertainty and a fresh-get $fault survive a durable reload and ordinary waiting', async ({ step, error }) => {
    const f = await persistent(step, error())
    expect((await f.run()).outcome).toBe('input-unconfirmed')
    expect(f.failedReads()).toBe(1)
    expect(f.life().inputHeld(f.key)).toBe(true)
    const calls = [...f.h.stub.calls.sendKeysCalls]
    const before = f.disk.store.get(f.key)
    expect(before.kind).toBe('record')
    if (before.kind !== 'record') throw new Error('expected durable uncertain input')
    expect(before.record.step).toBe('uncertain')
    const holds = await f.reload()
    expect(holds.get(f.key)).toEqual(before)
    // The failed post-error get has been consumed; these are waiting reads.
    f.row.state = 'waiting'
    for (const deadline of NOT_NOW_RETRY_MS) {
      await f.h.clock.advance(deadline + ENTER_DELAY_MS)
      expect((await f.run()).outcome).toBe('input-unconfirmed')
      expect(f.h.stub.calls.sendKeysCalls).toEqual(calls)
      expect(holds.get(f.key)).toEqual(before)
      expect(f.life().inputHeld(f.key)).toBe(true)
    }
    expect(f.getsAfterError()).toBeGreaterThan(1)
    expect(f.disk.fresh().load(f.key)).toEqual(before)
    expect([...f.h.lines, ...f.h.errors].join('\n')).not.toContain('nothing was typed')
    expect(f.h.stub.calls.readPaneCalls).toEqual([])
    noRestart(f)
  })

  test.each(['text', 'enter'] as const)('%s uncertainty survives a fresh lifecycle and store; posts one hold notice through episodes', async step => {
    const f = await persistent(step)
    await f.run()
    const { buildAdInputHoldNotice } = await import('../src/ad-input-notices.ts')
    const expected = buildAdInputHoldNotice(personaOf(f.h, f.key), f.disk.store.path(f.key))
    expect(f.h.episodeNotices).toEqual([{ key: f.key, text: expected }])
    const calls = [...f.h.stub.calls.sendKeysCalls]
    expect(existsSync(f.disk.store.path(f.key))).toBe(true)
    expect(readFileSync(f.disk.store.path(f.key), 'utf8')).not.toContain(command)
    const holds = await f.reload()
    for (const state of ['working', 'waiting'] as const) { f.row.state = state; await f.h.clock.advance(NOT_NOW_RETRY_MS[0]); await f.run() }
    expect(f.h.stub.calls.sendKeysCalls).toEqual(calls)
    expect(holds.get(f.key).kind).toBe('record')
    expect(f.h.episodeNotices).toHaveLength(1)
    expect((await f.run(f.sibling)).outcome).toBe('ok')
    expect(f.h.stub.calls.sendKeysCalls.filter(p => p.instance_id === personaInstanceId(f.sibling)).map(p => p.text ?? p.key)).toEqual([command, 'Enter'])
    noRestart(f)
    assertNoLeak([f.h.episodeNotices, f.h.lines, f.h.errors])
  })

  test.each(['corrupt', 'unreadable'] as const)('%s hold after restart blocks every reconnect key', async fault => {
    const f = await persistent('text'); await f.run()
    const calls = [...f.h.stub.calls.sendKeysCalls]
    if (fault === 'corrupt') writeFileSync(f.disk.store.path(f.key), '{')
    else f.disk.faults.read = true
    const holds = await f.reload()
    expect(holds.get(f.key).kind).toBe('blocked')
    await f.run(); await f.h.clock.advance(NOT_NOW_RETRY_MS[0] * 2)
    expect(f.h.stub.calls.sendKeysCalls).toEqual(calls)
    noRestart(f)
  })

  test('observed AD pending new launch releases the matching control hold', async () => {
    const f = await persistent('enter'); await f.run(); await f.reload()
    const prior = f.h.stub.calls.sendKeysCalls.length
    f.row.state = 'pending'; f.row.launch_started_at = '2026-11-20T03:00:00Z'
    await f.run()
    expect(f.h.stub.calls.sendKeysCalls).toHaveLength(prior)
    expect(existsSync(f.disk.store.path(f.key))).toBe(false)
    f.row.state = 'waiting'; f.row.launch_started_at = null
    expect((await f.run()).outcome).toBe('ok')
    expect(f.h.stub.calls.sendKeysCalls.slice(prior).map(p => p.text ?? p.key)).toEqual([command, 'Enter'])
    noRestart(f)
  })

  test('reviewed operator removal while stopped releases the hold on the next load', async () => {
    const f = await persistent('enter'); await f.run()
    await f.life().stop()
    rmSync(f.disk.store.path(f.key))
    await f.reload()
    expect((await f.run()).outcome).toBe('ok')
    expect(f.h.stub.calls.sendKeysCalls.slice(-2).map(p => p.text ?? p.key)).toEqual([command, 'Enter'])
    noRestart(f)
  })

  test.each(['write', 'unsynced'] as const)('intent %s failure never permits input, including after restart', async fault => {
    const f = await persistent('text')
    f.disk.faults[fault] = true
    await f.run()
    expect(f.h.stub.calls.sendKeysCalls).toEqual([])
    expect(f.disk.store.get(f.key).kind).not.toBe('clear')
    await f.reload(); await f.run()
    expect(f.h.stub.calls.sendKeysCalls).toEqual([])
    noRestart(f)
  })
})
