/**
 * lost-message.test.ts — The pure parts of src/lost-message.ts called
 * directly (b.av2 SR-4.6, SR-7.3).
 *
 * decideLostMessageState: the check order (restart pending, then auto-restart
 * disabled, then at the restart limit, else starting now), stopping at the
 * first query that answers true. The branches that read the real restart
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

type Query = 'pending' | 'disabled' | 'cap'

/** Queries answering true for the names in `trueFor`, recording each one asked, in order. */
function recordingQueries(trueFor: readonly Query[]) {
  const asked: Query[] = []
  const ask = (q: Query) => () => {
    asked.push(q)
    return trueFor.includes(q)
  }
  return {
    asked,
    queries: { isRestartPending: ask('pending'), isAutoRestartDisabled: ask('disabled'), isAtRestartLimit: ask('cap') },
  }
}

describe('decideLostMessageState: pending, then auto-restart disabled, then restart limit, else starting now', () => {
  test.each<[Query[], LostMessageState, Query[]]>([
    [['pending', 'disabled', 'cap'], 'restarting', ['pending']],
    [['pending', 'cap'], 'restarting', ['pending']],
    [['pending', 'disabled'], 'restarting', ['pending']],
    [['disabled', 'cap'], 'auto-restart-disabled', ['pending', 'disabled']],
    [['cap'], 'restart-limit-reached', ['pending', 'disabled', 'cap']],
    [[], 'starting-now', ['pending', 'disabled', 'cap']],
  ])('true for %j gives %s, asking only %j', (trueFor, state, asked) => {
    const q = recordingQueries(trueFor)
    expect(decideLostMessageState(q.queries)).toBe(state)
    expect(q.asked).toEqual(asked)
  })
})

describe('buildLostMessageNotice: a sender label with line breaks stays on one line', () => {
  test.each<[string, LostMessageState]>([
    ['first\nsecond', 'restarting'],
    ['first \r\n  second', 'starting-now'],
    ['first\n\n\nsecond', 'auto-restart-disabled'],
    ['first\rsecond', 'restart-limit-reached'],
  ])('label %j (%s)', (label, state) => {
    const notice = buildLostMessageNotice(label, state)
    expect(notice).not.toMatch(/[\r\n]/)
    expect(notice).toContain('first second')
  })
})
