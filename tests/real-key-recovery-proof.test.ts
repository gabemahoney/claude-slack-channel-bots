import { describe, expect, test } from 'bun:test'
import { assertSwallowedEnterRecovery, assertUnknownKeyRecovery } from './integration/fixtures/real-case-assertions.ts'

const instance = 'cscb_control'
const fault = { at: 2000, words: ['send-keys', 'key=Enter', 'swallow'] }
const key = (at: number, kind: 'enter' | 'text', id = instance) => ({
  at, words: ['send-keys', '--instance-id', id, ...(kind === 'enter' ? ['--key', 'Enter'] : ['--text', 'message', '--no-enter'])],
})
const text = { kind: 'sent', seq: 1, part: 1, send_kind: 'text', launch_id: 'launch', at: 1000 }
const enter = { ...text, send_kind: 'enter', at: 12000 }

describe('real key recovery proof', () => {
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
