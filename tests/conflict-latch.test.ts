/**
 * conflict-latch.test.ts — CONFLICT case recognition (b.jg5 SRJ-507), the
 * `tests/conflict-latch.test.ts` half of SRJ-1303, and the latch record
 * (SRJ-501, with SRJ-506's same-case rule) over `createConflictLatch`.
 *
 * Recognition: every row of the case table (`tests/test-helpers/conflict-cases.ts`)
 * resolves to its case; a description carrying several case phrases takes the
 * first in `CONFLICT_CASE_ORDER`, and so does a description built from any two
 * phrase constants, in either textual order; the plain spawn's label wordings
 * and the other words beside a case phrase are no case; one pin case (the
 * file's only literal block) checks the exported order against SRJ-507's,
 * with "no pane 0.0" absent. The `different-id` and `another-store`
 * descriptions carry no "Operator actions" section title, which is read from
 * the stub's own descriptions, never typed.
 *
 * Record: latching a persona on each row's error records the quoted session,
 * the case, the refused operation and the row state; a description with no
 * quoted name records `slack_bot_<key>`; an empty or multi-line quoted span
 * is skipped whole (quotes pair left to right), so a later name is taken, and
 * a description with only such spans records `slack_bot_<key>`; a `waiting` state and an unreadable
 * state count as live, `pending`, `ended`, `missing` and no row do not; the
 * description is kept redacted, on one line and capped. A different case
 * relatches (the record replaced), the same case keeps the record unchanged
 * (SRJ-506, hatch A3), and `set` answers which. One latch per persona, a new
 * instance holds none, and `forget` is silent and per key. Set observers see
 * every set; a throwing or rejecting observer, and a throwing log, are
 * swallowed.
 *
 * Pure module under test: one `createConflictLatch` per test over a line
 * capture and a recording observer; `afterEach` runs `assertNoLeak` over
 * every line, event and record captured. No `mock.module()`.
 *
 * SPDX-License-Identifier: MIT
 */

import { afterEach, describe, expect, test } from 'bun:test'

import {
  CONFLICT_ANOTHER_STORE_PHRASE,
  CONFLICT_CONFLICTING_LABELS_PHRASE,
  CONFLICT_DIFFERENT_ID_PHRASE,
  CONFLICT_LEFTOVER_PHRASE,
  CONFLICT_NEVER_REPORTED_IN_PHRASE,
  CONFLICT_NO_VALID_ID_PHRASE,
  CONFLICT_NOT_THIS_LAUNCH_PHRASE,
  CONFLICT_OWN_ID_PHRASE,
  CONFLICT_PANE_NOT_FOUND_PHRASE,
  NEW_ROW_ENDED_PHRASE,
  NO_KILL_SENT_PHRASE,
  NOTHING_WRITTEN_PHRASE,
  PANE_NOT_ADOPTED_PHRASE,
  PLAIN_SPAWN_LABEL_NAMES_THIS_ID_PHRASE,
  PLAIN_SPAWN_LABEL_NOT_THIS_ID_PHRASE,
} from '../src/ad-description-phrases.ts'
import { ERR_TMUX_SESSION_CONFLICT_NAME } from '../src/agent-director-errors.ts'
import {
  CONFLICT_CASE_ORDER,
  CONFLICT_LATCH_SET_LATCHED,
  CONFLICT_LATCH_SET_RELATCHED,
  CONFLICT_LATCH_SET_SAME_CASE,
  HOLD_LATCH_CASES,
  LATCH_CASES,
  LATCH_CASE_ANOTHER_STORE,
  LATCH_CASE_CONFLICTING_LABELS,
  LATCH_CASE_DIFFERENT_ID,
  LATCH_CASE_LAUNCH_START_NOT_RECORDED,
  LATCH_CASE_LEFTOVER,
  LATCH_CASE_NEVER_REPORTED_IN,
  LATCH_CASE_NO_VALID_ID,
  LATCH_CASE_NOT_THIS_LAUNCH,
  LATCH_CASE_OWN_ID,
  LATCH_CASE_PANE_NOT_FOUND,
  LATCH_CASE_UNRECOGNISED,
  LATCH_CASE_UNUSABLE_RECORDED_NAME,
  LATCH_ROW_STATE_KIND_NO_ROW,
  LATCH_ROW_STATE_NO_ROW,
  LATCH_ROW_STATE_UNREADABLE,
  REFUSED_OPERATION_NONE,
  REFUSED_OPERATION_PLAIN_SPAWN,
  REFUSED_OPERATION_RESUME,
  REFUSED_OPERATION_REUSE_SPAWN,
  conflictSessionName,
  createConflictLatch,
  isHoldLatchCase,
  latchRowStateRead,
  recogniseConflictCase,
  rowStateCountsAsLive,
  takesUnrecognisedHandling,
  type ConflictLatch,
  type ConflictLatchConflictFields,
  type ConflictLatchSetEvent,
  type ConflictLatchSetInput,
  type LatchRowState,
} from '../src/conflict-latch.ts'
import {
  AGENT_DIRECTOR_DEAD_STATES,
  AGENT_DIRECTOR_LIVE_STATES,
  AGENT_DIRECTOR_PENDING_STATE,
} from '../src/liveness-reading.ts'
import { MAX_LOGGED_MESSAGE_LENGTH } from '../src/persona-connection-errors.ts'
import { personaTmuxSessionName } from '../src/persona-identity.ts'
import { REDACTED_TOKEN_PLACEHOLDER } from '../src/slack-log-redaction.ts'
import {
  CONFLICT_CASES,
  errGeneric,
  errSpawnNotFound,
  errTmuxSessionConflict,
  errTmuxUnresponsive,
  errUnknownErrorName,
  STUB_TMUX_SESSION_NAME,
} from './test-helpers/agent-director-stub.ts'
import { CONFLICT_CASE_ROWS, type ConflictCaseRow } from './test-helpers/conflict-cases.ts'
import {
  BOT_TOKEN_PREFIX,
  REDACTED_SENTINEL_TAIL,
  assertNoLeak,
  fakeToken,
  sentinelInMessage,
} from './test-helpers/credentials.ts'

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/** The persona latched in most cases; its own session differs from the stub's quoted one. */
const KEY = 'alpha'
/** A second persona. */
const OTHER = 'beta'

interface LatchRun {
  readonly latch: ConflictLatch
  readonly lines: string[]
  readonly events: ConflictLatchSetEvent[]
}

/** Every run of this test, leak-checked in `afterEach`. */
let runs: LatchRun[] = []

/** One latch over a line capture and a recording set observer. */
function makeLatchRun(): LatchRun {
  const lines: string[] = []
  const events: ConflictLatchSetEvent[] = []
  const latch = createConflictLatch({ log: (line) => lines.push(line) })
  latch.addSetObserver((event) => {
    events.push(event)
  })
  const run = { latch, lines, events }
  runs.push(run)
  return run
}

afterEach(() => {
  const captured = runs.map((run) => ({
    lines: run.lines,
    events: run.events,
    records: [KEY, OTHER].map((key) => run.latch.record(key)),
  }))
  runs = []
  assertNoLeak(captured)
})

/** `test.each` rows over the case table: the row name, then the row. */
const ROWS = CONFLICT_CASE_ROWS.map((row) => [row.name, row] as const)

/** The `ended` row state. */
const ENDED = latchRowStateRead('ended')

/** A row's description, as the stub builds it. */
const descriptionOf = (row: ConflictCaseRow): string => row.build().errDescription

/** Latch `key` on a row's error with the row's refused operation and row state. */
function latchOnRow(latch: ConflictLatch, key: string, row: ConflictCaseRow, rowState: LatchRowState = row.rowState) {
  return latch.setFromConflict(key, row.build(), { refusedOperation: row.refusedOperation, rowState })
}

/** The first table row matching `pred`; throws when none does, so a case never runs on nothing. */
function rowWhere(pred: (row: ConflictCaseRow) => boolean): ConflictCaseRow {
  const found = CONFLICT_CASE_ROWS.find(pred)
  if (found === undefined) throw new Error('no case-table row matches')
  return found
}

/** The case-phrase entries of `CONFLICT_CASE_ORDER` a description carries, in that order. */
const casePhrasesIn = (description: string) => CONFLICT_CASE_ORDER.filter((entry) => description.includes(entry.phrase))

/** The two cases whose description points to no "Operator actions" (ADSRD SR-1.4; SRJ-1004). */
const NO_POINTER_CASES: ReadonlySet<string> = new Set([LATCH_CASE_DIFFERENT_ID, LATCH_CASE_ANOTHER_STORE])

/**
 * The "Operator actions" section title, read from the stub: the one quoted
 * text, other than the session, that every pointing description carries.
 */
function operatorActionsTitle(): string {
  const quotedTexts = (row: ConflictCaseRow): Set<string> =>
    new Set(Array.from(descriptionOf(row).matchAll(/"([^"]+)"/g), (m) => m[1]).filter((t) => t !== row.sessionName))
  const pointing = CONFLICT_CASE_ROWS.filter((row) => !NO_POINTER_CASES.has(row.latchCase)).map(quotedTexts)
  const common = [...pointing[0]].filter((text) => pointing.every((texts) => texts.has(text)))
  if (common.length !== 1) throw new Error(`expected one shared quoted title, found ${common.length}`)
  return common[0]
}

// ---------------------------------------------------------------------------
// Recognition (SRJ-507, SRJ-1303)
// ---------------------------------------------------------------------------

describe('case recognition', () => {
  test('the case table covers every stub CONFLICT case', () => {
    expect(new Set(CONFLICT_CASE_ROWS.map((row) => row.stubCase))).toEqual(new Set(CONFLICT_CASES))
  })

  test.each(ROWS)('%s resolves to its case', (_name, row) => {
    expect(recogniseConflictCase(descriptionOf(row))).toBe(row.latchCase)
  })

  test('each description carrying two or three case phrases takes the first in the order', () => {
    const multi = CONFLICT_CASE_ROWS.filter((row) => casePhrasesIn(descriptionOf(row)).length >= 2)
    expect(new Set(multi.map((row) => row.latchCase))).toEqual(
      new Set([LATCH_CASE_PANE_NOT_FOUND, LATCH_CASE_NOT_THIS_LAUNCH, LATCH_CASE_NEVER_REPORTED_IN]),
    )
    for (const row of multi) {
      const carried = casePhrasesIn(descriptionOf(row))
      expect(recogniseConflictCase(descriptionOf(row))).toBe(carried[0].latchCase)
      expect(carried.map((entry) => entry.latchCase)).toContain(LATCH_CASE_OWN_ID)
    }
  })

  test('the scan\'s and the duplicate-session leftover descriptions both resolve to the leftover case; only the latter carries the label wording', () => {
    const plainLeftover = (scanned: boolean) =>
      descriptionOf(rowWhere((row) =>
        row.refusedOperation === REFUSED_OPERATION_PLAIN_SPAWN &&
        row.latchCase === LATCH_CASE_LEFTOVER &&
        (row.rowState === LATCH_ROW_STATE_NO_ROW) === scanned))
    const duplicate = plainLeftover(false)
    const scan = plainLeftover(true)
    expect(duplicate.includes(PLAIN_SPAWN_LABEL_NAMES_THIS_ID_PHRASE)).toBe(true)
    expect(scan.includes(PLAIN_SPAWN_LABEL_NAMES_THIS_ID_PHRASE)).toBe(false)
    expect([recogniseConflictCase(duplicate), recogniseConflictCase(scan)]).toEqual([LATCH_CASE_LEFTOVER, LATCH_CASE_LEFTOVER])
  })

  test('the another-store descriptions from a resume, a reuse and a plain spawn resolve to the another-store case', () => {
    const rows = CONFLICT_CASE_ROWS.filter((row) => descriptionOf(row).includes(CONFLICT_ANOTHER_STORE_PHRASE))
    expect(new Set(rows.map((row) => row.refusedOperation))).toEqual(
      new Set([REFUSED_OPERATION_RESUME, REFUSED_OPERATION_REUSE_SPAWN, REFUSED_OPERATION_PLAIN_SPAWN]),
    )
    expect(rows.map((row) => recogniseConflictCase(descriptionOf(row)))).toEqual(rows.map(() => LATCH_CASE_ANOTHER_STORE))
  })

  test('the never-reported-in description, which also carries the own-id phrase, resolves to its own case and takes unrecognised handling', () => {
    const description = descriptionOf(rowWhere((row) => row.latchCase === LATCH_CASE_NEVER_REPORTED_IN))
    expect(description.includes(CONFLICT_OWN_ID_PHRASE)).toBe(true)
    expect(recogniseConflictCase(description)).toBe(LATCH_CASE_NEVER_REPORTED_IN)
    expect(takesUnrecognisedHandling(LATCH_CASE_NEVER_REPORTED_IN)).toBe(true)
  })

  const PAIRS = CONFLICT_CASE_ORDER.flatMap((first, i) =>
    CONFLICT_CASE_ORDER.slice(i + 1).map((later) => [first.latchCase, later.latchCase, first.phrase, later.phrase] as const),
  )

  test.each(PAIRS)('%s wins over %s in either textual order', (firstCase, _laterCase, firstPhrase, laterPhrase) => {
    expect(recogniseConflictCase(`${firstPhrase}; ${laterPhrase}`)).toBe(firstCase)
    expect(recogniseConflictCase(`${laterPhrase}; ${firstPhrase}`)).toBe(firstCase)
  })

  test('the exported order is SRJ-507\'s, each case on its own phrase, with "no pane 0.0" absent', () => {
    // The file's only literal block: SRJ-507's case words, in its order.
    expect(CONFLICT_CASE_ORDER.map((entry) => entry.phrase)).toEqual([
      'conflicting labels',
      "the agent's pane was not found",
      "not this launch's session",
      'left over from an earlier life',
      'never reported in',
      "this row's own id",
      'no valid instance id',
      'a different instance id',
      'another agent-director store',
    ])
    expect(recogniseConflictCase('no pane 0.0')).toBe(LATCH_CASE_UNRECOGNISED)
    expect(CONFLICT_CASE_ORDER.map((entry) => [entry.latchCase, entry.phrase])).toEqual([
      [LATCH_CASE_CONFLICTING_LABELS, CONFLICT_CONFLICTING_LABELS_PHRASE],
      [LATCH_CASE_PANE_NOT_FOUND, CONFLICT_PANE_NOT_FOUND_PHRASE],
      [LATCH_CASE_NOT_THIS_LAUNCH, CONFLICT_NOT_THIS_LAUNCH_PHRASE],
      [LATCH_CASE_LEFTOVER, CONFLICT_LEFTOVER_PHRASE],
      [LATCH_CASE_NEVER_REPORTED_IN, CONFLICT_NEVER_REPORTED_IN_PHRASE],
      [LATCH_CASE_OWN_ID, CONFLICT_OWN_ID_PHRASE],
      [LATCH_CASE_NO_VALID_ID, CONFLICT_NO_VALID_ID_PHRASE],
      [LATCH_CASE_DIFFERENT_ID, CONFLICT_DIFFERENT_ID_PHRASE],
      [LATCH_CASE_ANOTHER_STORE, CONFLICT_ANOTHER_STORE_PHRASE],
    ])
  })

  test.each([
    [PLAIN_SPAWN_LABEL_NAMES_THIS_ID_PHRASE],
    [PLAIN_SPAWN_LABEL_NOT_THIS_ID_PHRASE],
    [NEW_ROW_ENDED_PHRASE],
    [NOTHING_WRITTEN_PHRASE],
    [PANE_NOT_ADOPTED_PHRASE],
    [NO_KILL_SENT_PHRASE],
    [''],
    [undefined],
  ] as const)('%p alone is no case: unrecognised text', (text) => {
    expect(recogniseConflictCase(text)).toBe(LATCH_CASE_UNRECOGNISED)
  })

  test('no different-id or another-store description, in any variant, carries the Operator actions section title', () => {
    const title = operatorActionsTitle()
    const noPointer = CONFLICT_CASE_ROWS.filter((row) => NO_POINTER_CASES.has(row.latchCase))
    expect(new Set(noPointer.map((row) => row.refusedOperation))).toEqual(
      new Set([REFUSED_OPERATION_RESUME, REFUSED_OPERATION_REUSE_SPAWN, REFUSED_OPERATION_PLAIN_SPAWN]),
    )
    expect(noPointer.filter((row) => descriptionOf(row).includes(title)).map((row) => row.name)).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// The record (SRJ-501)
// ---------------------------------------------------------------------------

describe('the latch record', () => {
  test.each(ROWS)('%s: latching records the quoted session, the case, the refused operation and the row state', (_name, row) => {
    const run = makeLatchRun()
    expect(latchOnRow(run.latch, KEY, row)).toBe(CONFLICT_LATCH_SET_LATCHED)
    expect(run.latch.isLatched(KEY)).toBe(true)
    expect(run.latch.record(KEY)).toMatchObject({
      sessionName: row.sessionName,
      latchCase: row.latchCase,
      refusedOperation: row.refusedOperation,
      rowState: row.rowState,
    })
    expect(run.events.map((event): unknown[] => [event.key, event.outcome, event.record])).toEqual([
      [KEY, CONFLICT_LATCH_SET_LATCHED, run.latch.record(KEY)],
    ])
  })

  test('the quoted session is the first double-quoted name; with none it is the persona\'s own slack_bot_<key>', () => {
    const quoted = personaTmuxSessionName(OTHER)
    const second = STUB_TMUX_SESSION_NAME
    expect(conflictSessionName(`${JSON.stringify(quoted)} then ${JSON.stringify(second)}`, KEY)).toBe(quoted)
    expect(conflictSessionName(CONFLICT_OWN_ID_PHRASE, KEY)).toBe(personaTmuxSessionName(KEY))
    expect(conflictSessionName(undefined, KEY)).toBe(personaTmuxSessionName(KEY))

    const run = makeLatchRun()
    const noName = errGeneric('resume', ERR_TMUX_SESSION_CONFLICT_NAME, CONFLICT_OWN_ID_PHRASE)
    run.latch.setFromConflict(KEY, noName, { refusedOperation: REFUSED_OPERATION_RESUME, rowState: LATCH_ROW_STATE_NO_ROW })
    expect(run.latch.record(KEY)?.sessionName).toBe(personaTmuxSessionName(KEY))
    run.latch.set(OTHER, { latchCase: LATCH_CASE_OWN_ID, refusedOperation: REFUSED_OPERATION_RESUME, rowState: LATCH_ROW_STATE_NO_ROW })
    expect(run.latch.record(OTHER)?.sessionName).toBe(personaTmuxSessionName(OTHER))
  })

  test('an empty quoted span is skipped whole: its closing quote never opens the next span', () => {
    const name = STUB_TMUX_SESSION_NAME
    expect(conflictSessionName(`a "" then ${JSON.stringify(name)}`, KEY)).toBe(name)
    expect(conflictSessionName(`"" "" then ${JSON.stringify(name)}`, KEY)).toBe(name)
    expect(conflictSessionName(`a "" then ""`, KEY)).toBe(personaTmuxSessionName(KEY))

    const run = makeLatchRun()
    const description = `${CONFLICT_OWN_ID_PHRASE} "" then ${JSON.stringify(name)}`
    run.latch.setFromConflict(KEY, errGeneric('resume', ERR_TMUX_SESSION_CONFLICT_NAME, description), {
      refusedOperation: REFUSED_OPERATION_RESUME,
      rowState: LATCH_ROW_STATE_NO_ROW,
    })
    expect(run.latch.record(KEY)?.sessionName).toBe(name)
  })

  test.each([
    ['a newline', '\n'],
    ['a carriage return', '\r'],
    ['a CRLF', '\r\n'],
    ['a line separator', '\u2028'],
    ['a paragraph separator', '\u2029'],
  ])('a quoted span broken by %s is skipped whole: its closing quote never opens the next span', (_name, lineBreak) => {
    const name = STUB_TMUX_SESSION_NAME
    const broken = `"${personaTmuxSessionName(OTHER)}${lineBreak}${name}"`
    expect(conflictSessionName(`a ${broken} then ${JSON.stringify(name)}`, KEY)).toBe(name)
    expect(conflictSessionName(`a ${broken} then "" then ${JSON.stringify(name)}`, KEY)).toBe(name)
    expect(conflictSessionName(`a ${broken} then ${broken}`, KEY)).toBe(personaTmuxSessionName(KEY))
    expect(conflictSessionName(`a ${broken} then ""`, KEY)).toBe(personaTmuxSessionName(KEY))
  })

  test.each([
    ['waiting', latchRowStateRead('waiting'), true],
    ['unreadable', LATCH_ROW_STATE_UNREADABLE, true],
    ['an unsafe state (recorded unreadable)', latchRowStateRead(`waiting ${CONFLICT_OWN_ID_PHRASE}`), true],
    ['pending', latchRowStateRead(AGENT_DIRECTOR_PENDING_STATE), false],
    ['ended', ENDED, false],
    ['no row', LATCH_ROW_STATE_NO_ROW, false],
  ] as const)('a latch met with the row %s records a state that counts as live: %p', (_label, rowState, live) => {
    const run = makeLatchRun()
    latchOnRow(run.latch, KEY, rowWhere((row) => row.verb === 'kill' && row.latchCase === LATCH_CASE_NOT_THIS_LAUNCH), rowState)
    const recorded = run.latch.record(KEY)?.rowState
    expect(recorded).toBeDefined()
    expect(rowStateCountsAsLive(recorded as LatchRowState)).toBe(live)
  })

  test('every live state but pending, and any state CSCB does not know, counts as live; pending and the dead states do not', () => {
    const live = [...AGENT_DIRECTOR_LIVE_STATES].filter((state) => state !== AGENT_DIRECTOR_PENDING_STATE)
    const notLive = [AGENT_DIRECTOR_PENDING_STATE, ...AGENT_DIRECTOR_DEAD_STATES]
    expect(live.map((state) => rowStateCountsAsLive(latchRowStateRead(state)))).toEqual(live.map(() => true))
    expect(notLive.map((state) => rowStateCountsAsLive(latchRowStateRead(state)))).toEqual(notLive.map(() => false))
    expect(rowStateCountsAsLive(latchRowStateRead('stopping'))).toBe(true)
    expect(latchRowStateRead(42)).toBe(LATCH_ROW_STATE_UNREADABLE)
  })

  test('the description is kept redacted, on one line and capped; a token-shaped quoted name is redacted', () => {
    const run = makeLatchRun()
    const long = `${CONFLICT_OWN_ID_PHRASE} (${sentinelInMessage('d')})\n${NO_KILL_SENT_PHRASE} ${'x'.repeat(MAX_LOGGED_MESSAGE_LENGTH)}`
    run.latch.setFromConflict(KEY, errGeneric('resume', ERR_TMUX_SESSION_CONFLICT_NAME, long), {
      refusedOperation: REFUSED_OPERATION_RESUME,
      rowState: LATCH_ROW_STATE_NO_ROW,
    })
    const description = run.latch.record(KEY)?.description ?? ''
    expect(description.startsWith(`${CONFLICT_OWN_ID_PHRASE} (${REDACTED_SENTINEL_TAIL}) ${NO_KILL_SENT_PHRASE}`)).toBe(true)
    expect(description.length).toBeLessThanOrEqual(MAX_LOGGED_MESSAGE_LENGTH)

    const ownId = rowWhere((row) => row.latchCase === LATCH_CASE_OWN_ID)
    const tokenSession = errTmuxSessionConflict(ownId.verb, ownId.stubCase, fakeToken(BOT_TOKEN_PREFIX, 's'), ownId.options)
    run.latch.setFromConflict(OTHER, tokenSession, { refusedOperation: REFUSED_OPERATION_RESUME, rowState: LATCH_ROW_STATE_NO_ROW })
    expect(run.latch.record(OTHER)?.sessionName).toBe(REDACTED_TOKEN_PLACEHOLDER)
  })

  test('a set with no description records none, and its line has no message', () => {
    const run = makeLatchRun()
    run.latch.set(KEY, { latchCase: LATCH_CASE_OWN_ID, refusedOperation: REFUSED_OPERATION_RESUME, rowState: ENDED })
    expect(run.latch.record(KEY)).toEqual({
      sessionName: personaTmuxSessionName(KEY),
      latchCase: LATCH_CASE_OWN_ID,
      refusedOperation: REFUSED_OPERATION_RESUME,
      rowState: ENDED,
    })
    expect(run.lines).toEqual([
      `[slack] conflict-latch: persona=${KEY} latched — case=${LATCH_CASE_OWN_ID} session=${JSON.stringify(personaTmuxSessionName(KEY))} refused=${REFUSED_OPERATION_RESUME} state=ended`,
    ])
  })

  test('the hold cases are recorded with the refused operation none', () => {
    const run = makeLatchRun()
    for (const [key, latchCase] of [[KEY, LATCH_CASE_UNUSABLE_RECORDED_NAME], [OTHER, LATCH_CASE_LAUNCH_START_NOT_RECORDED]] as const) {
      const rowState = latchRowStateRead(AGENT_DIRECTOR_PENDING_STATE)
      expect(run.latch.set(key, { latchCase, refusedOperation: REFUSED_OPERATION_NONE, rowState })).toBe(CONFLICT_LATCH_SET_LATCHED)
      expect(run.latch.record(key)).toMatchObject({ latchCase, refusedOperation: REFUSED_OPERATION_NONE, rowState })
    }
  })

  test.each(LATCH_CASES.map((latchCase) => [latchCase]))('case %s: hold and unrecognised-handling marks', (latchCase) => {
    expect(isHoldLatchCase(latchCase)).toBe((HOLD_LATCH_CASES as readonly string[]).includes(latchCase))
    expect(takesUnrecognisedHandling(latchCase)).toBe(
      latchCase === LATCH_CASE_UNRECOGNISED || latchCase === LATCH_CASE_NEVER_REPORTED_IN,
    )
  })

  test.each([
    ['ErrSpawnNotFound', (): unknown => errSpawnNotFound()],
    ['ErrTmuxUnresponsive', (): unknown => errTmuxUnresponsive()],
    ['an ErrUnknownErrorName naming the conflict', (): unknown => errUnknownErrorName(ERR_TMUX_SESSION_CONFLICT_NAME, CONFLICT_OWN_ID_PHRASE)],
    ['a plain Error', (): unknown => new Error(CONFLICT_OWN_ID_PHRASE)],
    ['undefined', (): unknown => undefined],
  ] as const)('setFromConflict on %s latches nothing, changes nothing and is silent', (_label, build) => {
    const run = makeLatchRun()
    const row = rowWhere((r) => r.latchCase === LATCH_CASE_LEFTOVER)
    latchOnRow(run.latch, OTHER, row)
    const before = run.latch.record(OTHER)
    const fields: ConflictLatchConflictFields = { refusedOperation: REFUSED_OPERATION_RESUME, rowState: LATCH_ROW_STATE_NO_ROW }
    expect(run.latch.setFromConflict(KEY, build(), fields)).toBeUndefined()
    expect(run.latch.setFromConflict(OTHER, build(), fields)).toBeUndefined()
    expect(run.latch.isLatched(KEY)).toBe(false)
    expect(run.latch.record(OTHER)).toBe(before)
    expect(run.lines.length).toBe(1)
    expect(run.events.length).toBe(1)
  })
})

// ---------------------------------------------------------------------------
// Relatch and same case (SRJ-501, SRJ-506)
// ---------------------------------------------------------------------------

describe('relatch', () => {
  const first: ConflictLatchSetInput = {
    latchCase: LATCH_CASE_OWN_ID,
    refusedOperation: REFUSED_OPERATION_RESUME,
    rowState: ENDED,
    description: CONFLICT_OWN_ID_PHRASE,
  }

  test('a different case relatches: the case, the refused operation, the recorded state and the session are replaced', () => {
    const run = makeLatchRun()
    run.latch.set(KEY, first)
    const previous = run.latch.record(KEY)
    const second: ConflictLatchSetInput = {
      latchCase: LATCH_CASE_LEFTOVER,
      refusedOperation: REFUSED_OPERATION_PLAIN_SPAWN,
      rowState: LATCH_ROW_STATE_NO_ROW,
      sessionName: STUB_TMUX_SESSION_NAME,
      description: CONFLICT_LEFTOVER_PHRASE,
    }
    expect(run.latch.set(KEY, second)).toBe(CONFLICT_LATCH_SET_RELATCHED)
    expect<unknown>(run.latch.record(KEY)).toEqual(second)
    expect(run.events.map((event): unknown[] => [event.outcome, event.record, event.previous])).toEqual([
      [CONFLICT_LATCH_SET_LATCHED, previous, undefined],
      [CONFLICT_LATCH_SET_RELATCHED, second, previous],
    ])
    expect(run.lines).toEqual([
      `[slack] conflict-latch: persona=${KEY} latched — case=${LATCH_CASE_OWN_ID} session=${JSON.stringify(personaTmuxSessionName(KEY))} refused=${REFUSED_OPERATION_RESUME} state=ended message=${JSON.stringify(CONFLICT_OWN_ID_PHRASE)}`,
      `[slack] conflict-latch: persona=${KEY} relatched — case=${LATCH_CASE_LEFTOVER} (was ${LATCH_CASE_OWN_ID}) session=${JSON.stringify(STUB_TMUX_SESSION_NAME)} refused=${REFUSED_OPERATION_PLAIN_SPAWN} state=${LATCH_ROW_STATE_KIND_NO_ROW} message=${JSON.stringify(CONFLICT_LEFTOVER_PHRASE)}`,
    ])
  })

  test('a relatch through setFromConflict takes the new error\'s case and the retry\'s fields', () => {
    const run = makeLatchRun()
    const scan = rowWhere(
      (row) => row.refusedOperation === REFUSED_OPERATION_PLAIN_SPAWN && row.latchCase === LATCH_CASE_LEFTOVER && row.rowState === LATCH_ROW_STATE_NO_ROW,
    )
    const killed = rowWhere((row) => row.verb === 'kill' && row.latchCase === LATCH_CASE_NOT_THIS_LAUNCH)
    latchOnRow(run.latch, KEY, killed)
    expect(latchOnRow(run.latch, KEY, scan)).toBe(CONFLICT_LATCH_SET_RELATCHED)
    expect(run.latch.record(KEY)).toMatchObject({
      latchCase: LATCH_CASE_LEFTOVER,
      refusedOperation: REFUSED_OPERATION_PLAIN_SPAWN,
      rowState: LATCH_ROW_STATE_NO_ROW,
    })
  })

  test('the same case keeps the persona latched with the record unchanged, logs nothing and reports same case', () => {
    const run = makeLatchRun()
    run.latch.set(KEY, first)
    const kept = run.latch.record(KEY)
    const again: ConflictLatchSetInput = {
      latchCase: LATCH_CASE_OWN_ID,
      refusedOperation: REFUSED_OPERATION_REUSE_SPAWN,
      rowState: LATCH_ROW_STATE_UNREADABLE,
      sessionName: STUB_TMUX_SESSION_NAME,
      description: CONFLICT_NO_VALID_ID_PHRASE,
    }
    expect(run.latch.set(KEY, again)).toBe(CONFLICT_LATCH_SET_SAME_CASE)
    expect(run.latch.record(KEY)).toBe(kept)
    expect(run.lines.length).toBe(1)
    expect(run.events.map((event): unknown[] => [event.outcome, event.record, event.previous])).toEqual([
      [CONFLICT_LATCH_SET_LATCHED, kept, undefined],
      [CONFLICT_LATCH_SET_SAME_CASE, kept, kept],
    ])
  })

  test('a relatch back to an earlier case is a relatch: the case is compared with the one now held', () => {
    const run = makeLatchRun()
    run.latch.set(KEY, first)
    run.latch.set(KEY, { ...first, latchCase: LATCH_CASE_LEFTOVER })
    expect(run.latch.set(KEY, first)).toBe(CONFLICT_LATCH_SET_RELATCHED)
    expect(run.latch.record(KEY)?.latchCase).toBe(LATCH_CASE_OWN_ID)
  })
})

// ---------------------------------------------------------------------------
// Scope, forget and observers
// ---------------------------------------------------------------------------

describe('scope', () => {
  const ownId = rowWhere((row) => row.latchCase === LATCH_CASE_OWN_ID)
  const leftover = rowWhere((row) => row.latchCase === LATCH_CASE_LEFTOVER)

  test('one latch per persona: another persona is unaffected by a latch, a relatch and a forget', () => {
    const run = makeLatchRun()
    latchOnRow(run.latch, KEY, ownId)
    expect([run.latch.isLatched(OTHER), run.latch.record(OTHER)]).toEqual([false, undefined])

    expect(latchOnRow(run.latch, OTHER, ownId)).toBe(CONFLICT_LATCH_SET_LATCHED)
    const other = run.latch.record(OTHER)
    expect(latchOnRow(run.latch, KEY, leftover)).toBe(CONFLICT_LATCH_SET_RELATCHED)
    expect(run.latch.record(OTHER)).toBe(other)
    expect(run.latch.forget(KEY)).toBe(true)
    expect(run.latch.record(OTHER)).toBe(other)
  })

  test('a new instance holds no latch', () => {
    const one = makeLatchRun()
    latchOnRow(one.latch, KEY, ownId)
    const two = makeLatchRun()
    expect([two.latch.isLatched(KEY), two.latch.record(KEY)]).toEqual([false, undefined])
  })

  test('forget is silent and per key; a later set latches afresh', () => {
    const run = makeLatchRun()
    latchOnRow(run.latch, KEY, ownId)
    const lines = run.lines.length
    const events = run.events.length
    expect(run.latch.forget(KEY)).toBe(true)
    expect(run.latch.forget(KEY)).toBe(false)
    expect([run.latch.isLatched(KEY), run.latch.record(KEY)]).toEqual([false, undefined])
    expect([run.lines.length, run.events.length]).toEqual([lines, events])
    expect(latchOnRow(run.latch, KEY, ownId)).toBe(CONFLICT_LATCH_SET_LATCHED)
  })
})

describe('set observers', () => {
  const ownId = rowWhere((row) => row.latchCase === LATCH_CASE_OWN_ID)

  test('a removed observer is not called again', () => {
    const run = makeLatchRun()
    const seen: string[] = []
    const remove = run.latch.addSetObserver((event) => {
      seen.push(event.outcome)
    })
    latchOnRow(run.latch, KEY, ownId)
    remove()
    latchOnRow(run.latch, KEY, ownId)
    expect(seen).toEqual([CONFLICT_LATCH_SET_LATCHED])
    expect(run.events.map((event) => event.outcome)).toEqual([CONFLICT_LATCH_SET_LATCHED, CONFLICT_LATCH_SET_SAME_CASE])
  })

  test('a throwing and a rejecting observer are logged redacted and swallowed; the set still holds and others are called', async () => {
    const run = makeLatchRun()
    run.latch.addSetObserver(() => {
      throw new Error(`observer (${sentinelInMessage('t')})`)
    })
    run.latch.addSetObserver(() => Promise.reject(new Error(`observer (${sentinelInMessage('r')})`)))
    const seen: string[] = []
    run.latch.addSetObserver((event) => {
      seen.push(event.key)
    })
    expect(latchOnRow(run.latch, KEY, ownId)).toBe(CONFLICT_LATCH_SET_LATCHED)
    await Promise.resolve()
    await Promise.resolve()
    expect(run.latch.isLatched(KEY)).toBe(true)
    expect(seen).toEqual([KEY])
    const failed = run.lines.filter((line) => line.startsWith(`[slack] conflict-latch: persona=${KEY} set observer failed: `))
    expect(failed.length).toBe(2)
    for (const line of failed) expect(line.includes(`(${REDACTED_SENTINEL_TAIL})`)).toBe(true)
  })

  test('a throwing log breaks no set', () => {
    const latch = createConflictLatch({
      log: () => {
        throw new Error('log down')
      },
    })
    expect(latchOnRow(latch, KEY, ownId)).toBe(CONFLICT_LATCH_SET_LATCHED)
    expect(latch.isLatched(KEY)).toBe(true)
  })
})
