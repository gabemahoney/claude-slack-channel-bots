/**
 * lost-message.test.ts — The pure parts of src/lost-message.ts called
 * directly.
 *
 * decideLostMessageState: the ten states in the contract order (not up, held
 * for a human, cannot launch, kill failed, not answering, session starting,
 * restarting, auto-restart disabled, restart limit reached, starting now),
 * with the one input asked out of that order: a live-row sequence or
 * old-life wait step running answers `restarting` after states 1 to 5 and
 * before the row-`pending` input. A
 * recording query set asserts the result and exactly which queries were
 * asked, so swapping two adjacent checks or asking a later query early fails
 * a case. Absent optional queries answer false, so with only today's queries
 * the decision is today's (with no not-up query the persona counts
 * as up). decideEarlyLostMessageState answers the first of states 1 to 5 or
 * none; firesHumanTriggeredRestart is true for `starting-now` only.
 *
 * The wordings and the order are imported from src/. One pin case holds
 * five new texts and its ten state names as literals; it is the
 * file's only literal notice text. The `auto-restart-disabled` wording is
 * checked by keyword for what (design A3) requires it to name.
 *
 * The retired notice builder is absent; the decision table remains.
 * wording and no other state's, and a sender label with line breaks still
 * gives a one-line notice.
 *
 * The branches that read the real state, fire the restart and post the
 * notice are driven end to end in tests/inbound-recovery-drop-branch.test.ts
 * and tests/dispatch-get-stream.test.ts, which also cover escaping and the
 * absence of mentions.
 *
 * SPDX-License-Identifier: MIT
 */

import { describe, expect, test } from 'bun:test'

import {
  decideEarlyLostMessageState,
  decideLostMessageState,
  firesHumanTriggeredRestart,
  LOST_MESSAGE_STATES,
  type LostMessageRecoveryQueries,
  type LostMessageState,
} from '../src/lost-message.ts'

/** Every decision input, in the order the decision asks them. */
const QUERY_ORDER = [
  'notUp',
  'latched',
  'invalidFlags',
  'killFailed',
  'notAnswering',
  'seqWait',
  'rowPending',
  'restartPending',
  'disabled',
  'cap',
] as const
type Query = (typeof QUERY_ORDER)[number]

/** The query method each input binds. */
const METHOD: Record<Query, keyof LostMessageRecoveryQueries> = {
  notUp: 'isNotUp',
  latched: 'isLatched',
  invalidFlags: 'isHeldOnInvalidFlags',
  killFailed: 'isKillFailed',
  notAnswering: 'isNotAnswering',
  seqWait: 'isSequenceOrWaitRunning',
  rowPending: 'isRowPending',
  restartPending: 'isRestartPending',
  disabled: 'isAutoRestartDisabled',
  cap: 'isAtRestartLimit',
}

/** The state an input gives when it is the first to answer true. */
const STATE_FOR: Record<Query, LostMessageState> = {
  notUp: 'not-up',
  latched: 'held-for-human',
  invalidFlags: 'cannot-launch',
  killFailed: 'kill-failed',
  notAnswering: 'not-answering',
  seqWait: 'restarting',
  rowPending: 'session-starting',
  restartPending: 'restarting',
  disabled: 'auto-restart-disabled',
  cap: 'restart-limit-reached',
}

/** Today's queries: the optional not-up query and the three required ones. */
const TODAY: readonly Query[] = ['notUp', 'restartPending', 'disabled', 'cap']
const REQUIRED: readonly Query[] = ['restartPending', 'disabled', 'cap']

/**
 * Queries answering true for the names in `trueFor`, recording each one
 * asked, in order. Only the inputs in `provided` are bound; an unbound
 * optional input is absent, as a caller that does not wire it leaves it.
 */
function recordingQueries(trueFor: readonly Query[], provided: readonly Query[] = QUERY_ORDER) {
  const asked: Query[] = []
  const bound: Partial<Record<keyof LostMessageRecoveryQueries, () => boolean>> = {}
  for (const q of provided) {
    bound[METHOD[q]] = () => {
      asked.push(q)
      return trueFor.includes(q)
    }
  }
  return { asked, queries: bound as LostMessageRecoveryQueries }
}

describe('decideLostMessageState: the first state that applies, in the contract order', () => {
  // The seqWait row is a sequence or wait step running while the
  // row reads pending gives restarting, and the row is never asked.
  const sequenceStopped = (q: Query) => (q === 'seqWait' ? ' (never session-starting over a pending row)' : '')
  test.each(QUERY_ORDER.map((q, i) => [q, STATE_FOR[q], sequenceStopped(q), i] as const))(
    '%s and every later input true gives %s, asking only the inputs up to it%s',
    (_q, state, _note, i) => {
      const r = recordingQueries(QUERY_ORDER.slice(i))
      expect(decideLostMessageState(r.queries)).toBe(state)
      expect(r.asked).toEqual(QUERY_ORDER.slice(0, i + 1))
    },
  )

  test('no input true gives starting-now, asking every input once, in order', () => {
    const r = recordingQueries([])
    expect(decideLostMessageState(r.queries)).toBe('starting-now')
    expect(r.asked).toEqual([...QUERY_ORDER])
  })

  test.each<[Query]>([['seqWait'], ['restartPending']])('restarting from %s alone', (q) => {
    const r = recordingQueries([q])
    expect(decideLostMessageState(r.queries)).toBe('restarting')
    expect(r.asked).toEqual(QUERY_ORDER.slice(0, QUERY_ORDER.indexOf(q) + 1))
  })
})

describe('decideLostMessageState: absent optional inputs answer false, so today\'s queries give today\'s decision', () => {
  test.each<[Query[], LostMessageState, Query[]]>([
    [['notUp', 'restartPending', 'disabled', 'cap'], 'not-up', ['notUp']],
    [['notUp'], 'not-up', ['notUp']],
    [['restartPending', 'disabled', 'cap'], 'restarting', ['notUp', 'restartPending']],
    [['restartPending', 'cap'], 'restarting', ['notUp', 'restartPending']],
    [['restartPending', 'disabled'], 'restarting', ['notUp', 'restartPending']],
    [['disabled', 'cap'], 'auto-restart-disabled', ['notUp', 'restartPending', 'disabled']],
    [['cap'], 'restart-limit-reached', ['notUp', 'restartPending', 'disabled', 'cap']],
    [[], 'starting-now', ['notUp', 'restartPending', 'disabled', 'cap']],
  ])('true for %j gives %s, asking only %j', (trueFor, state, asked) => {
    const r = recordingQueries(trueFor, TODAY)
    expect(decideLostMessageState(r.queries)).toBe(state)
    expect(r.asked).toEqual(asked)
  })

  test.each<[Query[], LostMessageState]>([
    [[], 'starting-now'],
    [['restartPending'], 'restarting'],
    [['cap'], 'restart-limit-reached'],
  ])('with no not-up query the persona counts as up: true for %j gives %s', (trueFor, state) => {
    const r = recordingQueries(trueFor, REQUIRED)
    expect(decideLostMessageState(r.queries)).toBe(state)
    expect(r.asked[0]).toBe('restartPending')
  })
})

describe('decideEarlyLostMessageState: the first of states 1 to 5, or none', () => {
  const EARLY = QUERY_ORDER.slice(0, 5)

  test.each(EARLY.map((q, i) => [q, STATE_FOR[q], i] as const))(
    '%s and every later input true gives %s, asking only the inputs up to it',
    (_q, state, i) => {
      const r = recordingQueries(QUERY_ORDER.slice(i))
      expect<LostMessageState | undefined>(decideEarlyLostMessageState(r.queries)).toBe(state)
      expect(r.asked).toEqual(QUERY_ORDER.slice(0, i + 1))
    },
  )

  test('with states 1 to 5 false it answers none and asks no later input, even when every later one is true', () => {
    const r = recordingQueries(QUERY_ORDER.slice(5))
    expect(decideEarlyLostMessageState(r.queries)).toBeUndefined()
    expect(r.asked).toEqual([...EARLY])
  })

  test('with no query given it answers none', () => {
    expect(decideEarlyLostMessageState({})).toBeUndefined()
  })
})

describe('firesHumanTriggeredRestart', () => {
  test('of every exported state, only starting-now fires the human-triggered restart', () => {
    expect(LOST_MESSAGE_STATES.filter((s) => firesHumanTriggeredRestart(s))).toEqual(['starting-now'])
  })
})

test('the recovery states are immutable and contain the ten decision outcomes', () => {
  expect(Object.isFrozen(LOST_MESSAGE_STATES)).toBe(true)
  expect(LOST_MESSAGE_STATES).toEqual(['not-up', 'held-for-human', 'cannot-launch', 'kill-failed', 'not-answering', 'session-starting', 'restarting', 'auto-restart-disabled', 'restart-limit-reached', 'starting-now'])
})
