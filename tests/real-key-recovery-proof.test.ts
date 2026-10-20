import { describe, expect, test } from 'bun:test'
import { assertResetKeyRecovery, assertSwallowedEnterRecovery, assertUnknownKeyRecovery } from './integration/fixtures/real-case-assertions.ts'
import { makeEngineHarness } from './test-helpers/delivery-engine.ts'
import { ENTER_DELAY_MS, LAUNCH_SETTLE_MS } from '../src/delivery-engine.ts'

const instance = 'cscb_control'
const fault = { at: 2000, words: ['send-keys', 'key=Enter', 'swallow'] }
const key = (at: number, kind: 'enter' | 'text', id = instance) => ({
  at, words: ['send-keys', '--instance-id', id, ...(kind === 'enter' ? ['--key', 'Enter'] : ['--text', 'message', '--no-enter'])],
})
const text = { kind: 'sent', seq: 1, part: 1, send_kind: 'text', launch_id: 'launch', at: 1000 }
const enter = { ...text, send_kind: 'enter', at: 12000 }

describe('real key recovery proof', () => {
  function resetFixture() {
    const sent = (at: number, send_kind: string, launch_id = 'new-launch') => ({
      kind: 'sent', seq: 4, part: 1, session_id: 'native-session', launch_id, send_kind, at,
    })
    return {
      journal: [sent(0, 'text', 'old-launch'), sent(20500, 'retype', 'old-launch'), sent(81000, 'retype', 'old-launch'),
        sent(101000, 'enter'), sent(111000, 'retype'), sent(141500, 'enter'), sent(171500, 'retype')],
      calls: [key(101000, 'enter'), key(111000, 'text'), key(111500, 'enter'), key(141500, 'enter'), key(171500, 'text')]
        .map((call, n) => ({ ...call, pid: String(n + 1) })),
      faults: [{ at: 111000, pid: '2', words: ['send-keys', 'no_enter', 'swallow'] }],
      waiting: [{ key: 'control', launch_id: 'new-launch', session_id: 'native-session', at: 100000 }],
    }
  }
  function proveReset(f: ReturnType<typeof resetFixture>) {
    return assertResetKeyRecovery(f.journal, f.calls, f.faults, f.waiting, 4, instance)
  }

  test('restart proves the reset 10s wait and both 30s recovery stages even with a 60.5s text gap', () => {
    const f = resetFixture()
    expect(f.journal.at(-1)!.at - f.journal[4]!.at).toBe(60500)
    expect(proveReset(f)).toMatchObject({ launch: 'new-launch', stages: [10000, 30000, 30000] })
  })

  test('reset oracle accepts the production executor recovery sequence after an interrupted growing episode', async () => {
    const h = await makeEngineHarness({ keys: ['control'] })
    try {
      const item = await h.accept('message', 'control')
      const p = h.p('control'); p.autoReceipt = false
      await h.tick('control'); await h.advance(LAUNCH_SETTLE_MS)
      await h.until(() => h.textCalls('control').length === 3)
      // A native launch loses the swallowed draft but retains its journal.
      h.lifecycle.beforeLaunch('control'); p.box = ''
      let swallowed = false
      p.keyHook = params => {
        if (params.no_enter && !swallowed) { swallowed = true; p.box = ''; p.autoReceipt = false }
        else if (params.key === 'Enter' && swallowed) p.box = ''
        return undefined
      }
      await h.until(() => h.textCalls('control').length === 5)
      const calls = h.keyCalls('control').map((call, n) => ({ ...key(call.at, call.params.no_enter ? 'text' : 'enter'), pid: String(n) }))
      const first = calls.filter(call => call.words.includes('--no-enter'))[3]!
      const waiting = h.events.flatMap(event => event.type === 'launch-first-waiting'
        ? [{ key: event.key, launch_id: event.launchId, session_id: event.sessionId, at: event.at }] : [])
      const proof = assertResetKeyRecovery(h.records('control'), calls,
        [{ at: first.at, pid: first.pid, words: ['send-keys', 'no_enter', 'swallow'] }], waiting, item.accepted.seq, instance)
      expect(proof.stages).toEqual([10000, 30000, 30000])
      const newerText = h.textCalls('control').slice(3)
      expect(newerText[1]!.at - newerText[0]!.at).toBe(60000 + ENTER_DELAY_MS)
    } finally { await h.cleanup() }
  })

  test.each([
    ['missing initial recovery', (f: ReturnType<typeof resetFixture>) => { f.journal.splice(3, 1) }],
    ['missing second recovery', (f: ReturnType<typeof resetFixture>) => { f.journal.splice(5, 1) }],
    ['wrong part', (f: ReturnType<typeof resetFixture>) => { f.journal[5]!.part = 2 }],
    ['wrong native session', (f: ReturnType<typeof resetFixture>) => { f.journal[5]!.session_id = 'other' }],
    ['wrong launch', (f: ReturnType<typeof resetFixture>) => { f.journal[5]!.launch_id = 'other' }],
    ['no new launch', (f: ReturnType<typeof resetFixture>) => { for (const r of f.journal) r.launch_id = 'old-launch' }],
    ['no growing old episode', (f: ReturnType<typeof resetFixture>) => { f.journal.splice(0, 2) }],
    ['no observed launch', (f: ReturnType<typeof resetFixture>) => { f.waiting.length = 0 }],
    ['wrong observed persona', (f: ReturnType<typeof resetFixture>) => { f.waiting[0]!.key = 'other' }],
    ['wrong observed session', (f: ReturnType<typeof resetFixture>) => { f.waiting[0]!.session_id = 'other' }],
    ['no swallowed text fault', (f: ReturnType<typeof resetFixture>) => { f.faults.length = 0 }],
    ['wrong fault stage', (f: ReturnType<typeof resetFixture>) => { f.faults[0]!.words[1] = 'key=Enter' }],
    ['fault on another attempt', (f: ReturnType<typeof resetFixture>) => { f.faults[0]!.at = 81000 }],
    ['fault from another process', (f: ReturnType<typeof resetFixture>) => { f.faults[0]!.pid = 'other' }],
    ['fault without process identity', (f: ReturnType<typeof resetFixture>) => { f.faults[0]!.pid = '' }],
    ['no actual recovery Enter', (f: ReturnType<typeof resetFixture>) => { f.calls.splice(3, 1) }],
    ['no actual delayed Enter', (f: ReturnType<typeof resetFixture>) => { f.calls.splice(2, 1) }],
    ['wrong actual persona', (f: ReturnType<typeof resetFixture>) => { f.calls[3] = { ...key(141500, 'enter', 'other'), pid: '4' } }],
    ['native pane read', (f: ReturnType<typeof resetFixture>) => { f.calls.push({ at: 120000, words: ['read-pane'], pid: 'other' }) }],
  ] as const)('reset proof rejects %s', (_, mutate) => {
    const f = resetFixture(); mutate(f)
    expect(() => proveReset(f)).toThrow()
  })

  test.each([0, 1, 2])('reset proof rejects retaining the next backoff slot at stage %s', stage => {
    const f = resetFixture()
    const boundary = [111000, 141500, 171500][stage]!, extra = stage === 0 ? 20000 : 30000
    for (const record of f.journal) if (record.at >= boundary) record.at += extra
    for (const call of f.calls) if (call.at >= boundary) call.at += extra
    for (const fault of f.faults) if (fault.at >= boundary) fault.at += extra
    expect(() => proveReset(f)).toThrow('backoff stage')
  })

  test.each([0, 1, 2])('reset proof rejects an early key at stage %s', stage => {
    const f = resetFixture()
    const boundary = [111000, 141500, 171500][stage]!
    for (const record of f.journal) if (record.at >= boundary) record.at--
    for (const call of f.calls) if (call.at >= boundary) call.at--
    for (const fault of f.faults) if (fault.at >= boundary) fault.at--
    expect(() => proveReset(f)).toThrow('backoff stage')
  })

  test.each(['enter', 'text'] as const)('unknown outcome permits %s recovery at the backoff boundary', kind => {
    expect(() => assertUnknownKeyRecovery([key(12000, kind)], fault, instance)).not.toThrow()
    expect(() => assertUnknownKeyRecovery([key(11999, kind), key(13000, kind)], fault, instance)).toThrow('existing backoff')
  })

  test.each([
    ['no recovery', []],
    ['another persona', [key(12000, 'enter', 'cscb_other')]],
    ['native pane read', [{ at: 3000, words: ['read-pane'] }, key(12000, 'enter')]],
  ])('unknown recovery rejects %s', (_, calls) => {
    expect(() => assertUnknownKeyRecovery(calls, fault, instance)).toThrow()
  })

  test('swallowed Enter permits a durable Enter-only recovery without a second text', () => {
    expect(() => assertSwallowedEnterRecovery([text, enter], [key(12000, 'enter')], [fault], 1, instance)).not.toThrow()
  })

  test.each([
    ['no durable Enter', [text], [key(12000, 'enter')], [fault]],
    ['no actual Enter', [text, enter], [key(12000, 'text')], [fault]],
    ['another persona', [text, enter], [key(12000, 'enter', 'cscb_other')], [fault]],
    ['early recovery', [text, { ...enter, at: 11999 }], [key(11999, 'enter'), key(13000, 'enter')], [fault]],
    ['early retype before later Enter', [text, enter], [key(11999, 'text'), key(13000, 'enter')], [fault]],
    ['another part', [text, { ...enter, part: 2 }], [key(12000, 'enter')], [fault]],
    ['another launch', [text, { ...enter, launch_id: 'other' }], [key(12000, 'enter')], [fault]],
    ['no injected fault', [text, enter], [key(12000, 'enter')], []],
  ])('swallowed Enter proof rejects %s', (_, journal, calls, faults) => {
    expect(() => assertSwallowedEnterRecovery(journal, calls, faults, 1, instance)).toThrow('durable Enter-only recovery')
  })
})
