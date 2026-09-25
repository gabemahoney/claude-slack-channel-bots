/**
 * lost-message.test.ts — The pure parts of src/lost-message.ts called
 * directly (b.av2 SR-4.6, SR-7.3).
 *
 * decideLostMessageState: the check order (not up, from bug b.g57, then
 * restart pending, then auto-restart disabled, then at the restart limit,
 * else starting now), stopping at the first query that answers true; with no
 * not-up query the persona counts as up. The branches that read the real restart
 * state, fire the restart and post the notice are driven end to end in
 * tests/inbound-recovery-drop-branch.test.ts and
 * tests/dispatch-get-stream.test.ts, which also cover each state's notice,
 * escaping and the absence of mentions.
 *
 * buildLostMessageNotice: a sender label with line breaks still gives a
 * one-line notice.
 *
 * SPDX-License-Identifier: MIT
 */

import { describe, expect, test } from 'bun:test'

import { buildLostMessageNotice, decideLostMessageState, type LostMessageState } from '../src/lost-message.ts'

type Query = 'notUp' | 'pending' | 'disabled' | 'cap'

/**
 * Queries answering true for the names in `trueFor`, recording each one
 * asked, in order. `withNotUp: false` leaves out the optional not-up query.
 */
function recordingQueries(trueFor: readonly Query[], withNotUp = true) {
  const asked: Query[] = []
  const ask = (q: Query) => () => {
    asked.push(q)
    return trueFor.includes(q)
  }
  return {
    asked,
    queries: {
      ...(withNotUp ? { isNotUp: ask('notUp') } : {}),
      isRestartPending: ask('pending'),
      isAutoRestartDisabled: ask('disabled'),
      isAtRestartLimit: ask('cap'),
    },
  }
}

describe('decideLostMessageState: not up, then pending, then auto-restart disabled, then restart limit, else starting now', () => {
  test.each<[Query[], LostMessageState, Query[]]>([
    [['notUp', 'pending', 'disabled', 'cap'], 'not-up', ['notUp']],
    [['notUp'], 'not-up', ['notUp']],
    [['pending', 'disabled', 'cap'], 'restarting', ['notUp', 'pending']],
    [['pending', 'cap'], 'restarting', ['notUp', 'pending']],
    [['pending', 'disabled'], 'restarting', ['notUp', 'pending']],
    [['disabled', 'cap'], 'auto-restart-disabled', ['notUp', 'pending', 'disabled']],
    [['cap'], 'restart-limit-reached', ['notUp', 'pending', 'disabled', 'cap']],
    [[], 'starting-now', ['notUp', 'pending', 'disabled', 'cap']],
  ])('true for %j gives %s, asking only %j', (trueFor, state, asked) => {
    const q = recordingQueries(trueFor)
    expect(decideLostMessageState(q.queries)).toBe(state)
    expect(q.asked).toEqual(asked)
  })

  test.each<[Query[], LostMessageState]>([
    [[], 'starting-now'],
    [['pending'], 'restarting'],
    [['cap'], 'restart-limit-reached'],
  ])('b.g57: with no not-up query the persona counts as up: true for %j gives %s', (trueFor, state) => {
    const q = recordingQueries(trueFor, false)
    expect(decideLostMessageState(q.queries)).toBe(state)
    expect(q.asked[0]).toBe('pending')
  })
})

describe('buildLostMessageNotice: the not-up state (bug b.g57)', () => {
  test('b.g57: the not-up notice says no restart was started and the instance is launched once the persona recovers, and never "starting now"', () => {
    const notice = buildLostMessageNotice('stub-user', 'not-up')
    expect(notice).toContain('Recovery: not up')
    expect(notice).toMatch(/no restart was started/)
    expect(notice).toMatch(/launched once it recovers/)
    expect(notice).not.toMatch(/starting now/i)
  })
})

describe('buildLostMessageNotice: a sender label with line breaks stays on one line', () => {
  test.each<[string, LostMessageState]>([
    ['first\nsecond', 'restarting'],
    ['first \r\n  second', 'starting-now'],
    ['first\n\n\nsecond', 'auto-restart-disabled'],
    ['first\rsecond', 'restart-limit-reached'],
    ['first\n  second', 'not-up'],
  ])('label %j (%s)', (label, state) => {
    const notice = buildLostMessageNotice(label, state)
    expect(notice).not.toMatch(/[\r\n]/)
    expect(notice).toContain('first second')
  })
})
