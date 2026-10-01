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
 * The CONFLICT notice (SRJ-1004), its episode (SRJ-508, SRJ-1016) and the
 * recovery texts (SRJ-1005). One pin case (the file's only literal block for
 * these texts) checks every case's notice, every fixed line and both recovery
 * templates with each reason against SRJ-1004's and SRJ-1005's words. Every
 * other case compares with the helper's `expectedConflictNotice`, assembled
 * from the exported constants: per row, the post a real latch bound to real
 * notice episodes makes is the row's expected notice, its lines in SRJ-1004's
 * order ("a different instance id": its must-not-be-ended line in place of
 * the pointer and no "Operator actions"; "another agent-director store": its
 * must-not-be-ended line, then the pointer, then the `list` line); CSCB's own
 * lines (`cscbOwnLines`) match none of `SESSION_ENDING_COMMAND_FORMS` and none
 * of this file's `CSCB_OWN_LINE_FORBIDDEN` (kill-pane, set-option,
 * agent-director delete, clear-latch, has-session, a label option name), while
 * the quoted "no kill was sent" is let through; the description is redacted,
 * capped and escaped once for Slack (the log line stays unescaped), and a
 * record with none has no description line. Episode: a latch posts once, a
 * same-case set posts nothing, a new case posts once more, another persona
 * posts only for itself, a hold case, a closed instance and an unbound
 * observer post nothing, and a b.f2b `unproven-idle` or `blocked-on-prompt`
 * notice already raised for the persona suppresses nothing (AC 41).
 * Recovery: each reason ("row reads" over every live and dead state) under
 * both latch kinds, with no line matching either list.
 *
 * Pure module under test: one `createConflictLatch` per test over a line
 * capture and a recording observer; `afterEach` runs `assertNoLeak` over
 * every line, event and record captured, and over every notice post. The
 * notice cases build `createPersonaEpisodes` over `createFakeClock` with a
 * recording sink; `afterEach` checks no timer is pending and clears the
 * session-manager notifier and its not-connected latch. No `mock.module()`.
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
  NEVER_DELETE_ROW_PHRASE,
  NEW_ROW_ENDED_PHRASE,
  NO_KILL_SENT_PHRASE,
  NOTHING_WRITTEN_PHRASE,
  PANE_NOT_ADOPTED_PHRASE,
  PLAIN_SPAWN_LABEL_NAMES_THIS_ID_PHRASE,
  PLAIN_SPAWN_LABEL_NOT_THIS_ID_PHRASE,
  RETRY_KILL_LATER_PHRASE,
} from '../src/ad-description-phrases.ts'
import { ERR_TMUX_SESSION_CONFLICT_NAME } from '../src/agent-director-errors.ts'
import {
  CONFLICT_CASE_ORDER,
  CONFLICT_CASE_SENTENCES,
  CONFLICT_LATCH_SET_LATCHED,
  CONFLICT_LATCH_SET_RELATCHED,
  CONFLICT_LATCH_SET_SAME_CASE,
  CONFLICT_NOTICE_ANOTHER_STORE_MUST_NOT_END_LINE,
  CONFLICT_NOTICE_DESCRIPTION_LINE_HEAD,
  CONFLICT_NOTICE_DESCRIPTION_LINE_TAIL,
  CONFLICT_NOTICE_DIFFERENT_ID_MUST_NOT_END_LINE,
  CONFLICT_NOTICE_FIRST_LINE_HEAD,
  CONFLICT_NOTICE_HUMAN_ONLY_LINE,
  CONFLICT_NOTICE_LINE_SEPARATOR,
  CONFLICT_NOTICE_LIST_LINE_HEAD,
  CONFLICT_NOTICE_LIST_LINE_TAIL,
  CONFLICT_NOTICE_POINTER_LINE,
  CONFLICT_RECOVERY_HEAD,
  CONFLICT_RECOVERY_REASON_LEAD,
  HOLD_LATCH_CASES,
  HOLD_RECOVERY_HEAD,
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
  LATCH_KIND_CONFLICT,
  LATCH_KIND_HOLD,
  LATCH_RECOVERY_REASON_CLEARED_BY_HAND,
  LATCH_RECOVERY_REASON_KIND_ROW_READS,
  LATCH_RECOVERY_REASON_RELAUNCH_NOT_REFUSED,
  LATCH_RECOVERY_REASON_RETRY_NOT_REFUSED,
  LATCH_RECOVERY_REASON_ROW_GONE,
  LATCH_RECOVERY_REASON_ROW_READS_HEAD,
  LATCH_RECOVERY_REASON_TEXTS,
  LATCH_RECOVERY_TAIL,
  LATCH_ROW_STATE_KIND_NO_ROW,
  LATCH_ROW_STATE_NO_ROW,
  LATCH_ROW_STATE_UNREADABLE,
  REFUSED_OPERATION_NONE,
  REFUSED_OPERATION_PLAIN_SPAWN,
  REFUSED_OPERATION_RESUME,
  REFUSED_OPERATION_REUSE_SPAWN,
  bindConflictNotice,
  conflictCaseSentence,
  conflictNoticeText,
  conflictRecoveryText,
  conflictSessionName,
  createConflictLatch,
  holdRecoveryText,
  isHoldLatchCase,
  latchKindOf,
  latchRecoveryReasonRowReads,
  latchRecoveryReasonText,
  latchRecoveryText,
  latchRowStateRead,
  recogniseConflictCase,
  rowStateCountsAsLive,
  takesUnrecognisedHandling,
  type ConflictLatch,
  type ConflictLatchCase,
  type ConflictLatchConflictFields,
  type ConflictLatchSetEvent,
  type ConflictLatchSetInput,
  type LatchKind,
  type LatchRecoveryReason,
  type LatchRowState,
} from '../src/conflict-latch.ts'
import {
  AGENT_DIRECTOR_DEAD_STATES,
  AGENT_DIRECTOR_LIVE_STATES,
  AGENT_DIRECTOR_PENDING_STATE,
} from '../src/liveness-reading.ts'
import { MAX_LOGGED_MESSAGE_LENGTH, renderLogMessageText } from '../src/persona-connection-errors.ts'
import { createPersonaEpisodes, PERSONA_EPISODE_KIND_CONFLICT, type PersonaEpisodes } from '../src/persona-episodes.ts'
import { personaTmuxSessionName } from '../src/persona-identity.ts'
import { _resetNotConnectedEpisodes, notifyPersonaNotConnected, setSessionNotifier, type NotConnectedNotice } from '../src/session-manager.ts'
import { REDACTED_TOKEN_PLACEHOLDER } from '../src/slack-log-redaction.ts'
import { escapeSlackControlCharacters } from '../src/slack-text-escape.ts'
import {
  CONFLICT_CASES,
  errGeneric,
  errSpawnNotFound,
  errTmuxSessionConflict,
  errTmuxUnresponsive,
  errUnknownErrorName,
  STUB_TMUX_SESSION_NAME,
} from './test-helpers/agent-director-stub.ts'
import {
  CONFLICT_CASE_ROWS,
  SESSION_ENDING_COMMAND_FORMS,
  cscbOwnLines,
  expectedConflictNotice,
  sessionEndingCommandsIn,
  type ConflictCaseRow,
} from './test-helpers/conflict-cases.ts'
import {
  BOT_TOKEN_PREFIX,
  REDACTED_SENTINEL_TAIL,
  assertNoLeak,
  fakeToken,
  sentinelInMessage,
} from './test-helpers/credentials.ts'
import { createFakeClock, type FakeClock } from './test-helpers/fake-clock.ts'

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

// ---------------------------------------------------------------------------
// The CONFLICT notice and its episode: fixtures (SRJ-1004, SRJ-508, SRJ-1016)
// ---------------------------------------------------------------------------

interface NoticeRun extends LatchRun {
  readonly clock: FakeClock
  readonly episodes: PersonaEpisodes
  /** Every notice the episodes' sink received: the key and the body. */
  readonly posts: Array<readonly [string, string]>
  /** Removes the notice reaction from the latch. */
  readonly unbind: () => void
}

/** Every notice run of this test, checked in `afterEach`. */
let noticeRuns: NoticeRun[] = []

/** One latch with the CONFLICT notice bound to a real episodes instance over a fake clock and a recording sink. */
function makeNoticeRun(): NoticeRun {
  const run = makeLatchRun()
  const clock = createFakeClock()
  const posts: Array<readonly [string, string]> = []
  const episodes = createPersonaEpisodes({
    sink: (key, text) => {
      posts.push([key, text])
    },
    log: (line) => run.lines.push(line),
    clock,
  })
  const unbind = bindConflictNotice(run.latch, episodes)
  const noticeRun = { ...run, clock, episodes, posts, unbind }
  noticeRuns.push(noticeRun)
  return noticeRun
}

afterEach(() => {
  const pending = noticeRuns.map((run) => run.clock.pendingCount())
  const posts = noticeRuns.map((run) => run.posts)
  noticeRuns = []
  setSessionNotifier(undefined)
  _resetNotConnectedEpisodes()
  expect(pending).toEqual(pending.map(() => 0))
  assertNoLeak(posts, 'posts')
})

/** A CONFLICT error carrying `description`, as agent-director throws it. */
const conflictError = (description: string) => errGeneric('resume', ERR_TMUX_SESSION_CONFLICT_NAME, description)

/** Latch `key` on a CONFLICT error carrying `description`. */
function latchOnDescription(latch: ConflictLatch, key: string, description: string) {
  return latch.setFromConflict(key, conflictError(description), { refusedOperation: REFUSED_OPERATION_RESUME, rowState: ENDED })
}

/** Every CONFLICT latch case: the nine recognised cases, then unrecognised text. */
const CONFLICT_LATCH_CASES: readonly ConflictLatchCase[] = [...CONFLICT_CASE_ORDER.map((entry) => entry.latchCase), LATCH_CASE_UNRECOGNISED]

/**
 * The recovery reasons, by name, for `test.each`: "row reads" over every dead
 * state and every live state (`waiting` among them), then the fixed reasons.
 */
const RECOVERY_REASONS: ReadonlyArray<readonly [string, LatchRecoveryReason]> = [
  ...[...AGENT_DIRECTOR_DEAD_STATES, ...AGENT_DIRECTOR_LIVE_STATES].map(
    (state) => [`row reads ${state}`, latchRecoveryReasonRowReads(state)] as const,
  ),
  ['row gone', LATCH_RECOVERY_REASON_ROW_GONE],
  ['retry not refused', LATCH_RECOVERY_REASON_RETRY_NOT_REFUSED],
  ['relaunch not refused', LATCH_RECOVERY_REASON_RELAUNCH_NOT_REFUSED],
  ['cleared by hand', LATCH_RECOVERY_REASON_CLEARED_BY_HAND],
]

// ---------------------------------------------------------------------------
// Pin: SRJ-1004's and SRJ-1005's texts
// ---------------------------------------------------------------------------

describe('notice texts: pin', () => {
  test('every case\'s CONFLICT notice, every fixed line and both recovery templates with each reason are SRJ-1004\'s and SRJ-1005\'s words', () => {
    // The file's only literal block for these texts: SRJ-1004 and SRJ-1005 as written.
    const FIRST_WITH_CASE =
      ":no_entry: *Held: tmux session conflict* — agent-director will not act on this persona's tmux session <session>: <case sentence>. CSCB takes no action for this persona until the conflict clears, and messages sent to it meanwhile are lost."
    const FIRST_WITHOUT_CASE =
      ":no_entry: *Held: tmux session conflict* — agent-director will not act on this persona's tmux session <session>. CSCB takes no action for this persona until the conflict clears, and messages sent to it meanwhile are lost."
    const DESCRIPTION = 'agent-director said: "<its description, redacted>"'
    const POINTER = 'What to do: a human follows the "Operator actions" section of agent-director\'s README for this session.'
    const ANOTHER_ROW = 'This session belongs to another agent-director row and must not be ended.'
    const ANOTHER_STORE = 'This session belongs to another agent-director store and must not be ended.'
    const LIST =
      'To see which agent-director rows record the session name, run `agent-director list --tmux-session-name <name>` on the command line (over MCP, list ignores that filter).'
    const HUMAN_ONLY = 'This is for a human only: no bot, including any persona that sees this post, may act on it.'
    const CASE_SENTENCES: Record<string, string> = {
      [LATCH_CASE_OWN_ID]:
        "this persona's own session still runs on its finished agent-director row past agent-director's stopping window and starting-session bound, or its worker process still runs after that session has gone; the worker may be hung or running on a row wrongly marked finished, and the conversation stays resumable",
      [LATCH_CASE_LEFTOVER]:
        "a session left over from an earlier launch of this persona holds the name or, renamed, still carries this persona's agent-director label, and ending it is a human's decision",
      [LATCH_CASE_NOT_THIS_LAUNCH]:
        "a session left over from an earlier launch of this persona is there; CSCB will not act on it, and ending it is a human's decision",
      [LATCH_CASE_NO_VALID_ID]: 'a session with no valid agent-director label holds the name; CSCB never touches it',
      [LATCH_CASE_DIFFERENT_ID]: "another agent-director row's session holds the name; CSCB never touches it",
      [LATCH_CASE_PANE_NOT_FOUND]:
        "the worker's recorded pane is not there (it is gone, it was respawned with another program, or it could not be adopted), or the one session left over from an earlier launch of this persona has no pane agent-director can find, and a human should look",
      [LATCH_CASE_CONFLICTING_LABELS]:
        "two sessions carry this launch's agent-director label, or an agent-director label value is set at the server, global or global-window scope; nothing automatic is safe, and a human must look",
      [LATCH_CASE_ANOTHER_STORE]:
        'a worker of another agent-director store sharing this tmux server holds the name; CSCB never touches it',
    }
    const CONFLICT_RECOVERY =
      ":white_check_mark: *Conflict cleared* — the hold on this persona's tmux session <session> is cleared (<reason>). CSCB is recovering this persona again."
    const HOLD_RECOVERY =
      ":white_check_mark: *Hold cleared* — the hold on this persona's agent-director row is cleared (<reason>). CSCB is recovering this persona again."
    const REASONS: ReadonlyArray<readonly [LatchRecoveryReason, string]> = [
      [latchRecoveryReasonRowReads('ended'), 'its agent-director row reads ended'],
      [LATCH_RECOVERY_REASON_ROW_GONE, 'its agent-director row is gone'],
      [LATCH_RECOVERY_REASON_RETRY_NOT_REFUSED, 'a retry of the refused operation was not refused'],
      [LATCH_RECOVERY_REASON_RELAUNCH_NOT_REFUSED, 'its row finished and a relaunch was not refused'],
      [LATCH_RECOVERY_REASON_CLEARED_BY_HAND, 'cleared by hand'],
    ]

    const name = personaTmuxSessionName(KEY)
    const session = JSON.stringify(name)
    const description = NO_KILL_SENT_PHRASE
    const fill = (template: string, values: Record<string, string>) =>
      Object.entries(values).reduce((text, [slot, value]) => text.replace(slot, () => value), template)

    expect<unknown>(CONFLICT_CASE_SENTENCES).toEqual(CASE_SENTENCES)
    expect([
      CONFLICT_NOTICE_POINTER_LINE,
      CONFLICT_NOTICE_DIFFERENT_ID_MUST_NOT_END_LINE,
      CONFLICT_NOTICE_ANOTHER_STORE_MUST_NOT_END_LINE,
      CONFLICT_NOTICE_HUMAN_ONLY_LINE,
      CONFLICT_NOTICE_LINE_SEPARATOR,
    ]).toEqual([POINTER, ANOTHER_ROW, ANOTHER_STORE, HUMAN_ONLY, '\n'])

    for (const latchCase of CONFLICT_LATCH_CASES) {
      const sentence = CASE_SENTENCES[latchCase]
      const first =
        sentence === undefined
          ? fill(FIRST_WITHOUT_CASE, { '<session>': session })
          : fill(FIRST_WITH_CASE, { '<session>': session, '<case sentence>': sentence })
      const middle =
        latchCase === LATCH_CASE_DIFFERENT_ID ? [ANOTHER_ROW] : latchCase === LATCH_CASE_ANOTHER_STORE ? [ANOTHER_STORE, POINTER] : [POINTER]
      const lines = [
        first,
        fill(DESCRIPTION, { '<its description, redacted>': description }),
        ...middle,
        fill(LIST, { '<name>': name }),
        HUMAN_ONLY,
      ]
      expect([latchCase, conflictNoticeText({ sessionName: name, latchCase, description }).split('\n')]).toEqual([latchCase, lines])
      expect([latchCase, expectedConflictNotice({ sessionName: name, latchCase, description }).lines]).toEqual([latchCase, lines])
    }
    expect(CASE_SENTENCES[LATCH_CASE_NEVER_REPORTED_IN]).toBeUndefined()
    expect(CASE_SENTENCES[LATCH_CASE_UNRECOGNISED]).toBeUndefined()

    for (const [reason, reasonText] of REASONS) {
      expect(latchRecoveryReasonText(reason)).toBe(reasonText)
      const conflict = fill(CONFLICT_RECOVERY, { '<session>': session, '<reason>': reasonText })
      const hold = fill(HOLD_RECOVERY, { '<reason>': reasonText })
      expect([conflictRecoveryText(name, reason), latchRecoveryText(LATCH_KIND_CONFLICT, reason, name)]).toEqual([conflict, conflict])
      expect([holdRecoveryText(reason), latchRecoveryText(LATCH_KIND_HOLD, reason, name)]).toEqual([hold, hold])
    }
  })
})

// ---------------------------------------------------------------------------
// The CONFLICT notice by row (SRJ-1004, SRJ-508; AC 40, AC 77)
// ---------------------------------------------------------------------------

describe('the CONFLICT notice by row', () => {
  test('every CONFLICT latch case has a row, unrecognised text and "never reported in" included, and only those two carry no case sentence', () => {
    expect(new Set(CONFLICT_CASE_ROWS.map((row) => row.latchCase))).toEqual(new Set(CONFLICT_LATCH_CASES))
    const noSentence = CONFLICT_CASE_ROWS.filter((row) => row.notice.caseSentence === undefined)
    expect(new Set(noSentence.map((row) => row.latchCase))).toEqual(new Set([LATCH_CASE_UNRECOGNISED, LATCH_CASE_NEVER_REPORTED_IN]))
    expect(CONFLICT_LATCH_CASES.filter((latchCase) => conflictCaseSentence(latchCase) === undefined)).toEqual([
      LATCH_CASE_NEVER_REPORTED_IN,
      LATCH_CASE_UNRECOGNISED,
    ])
    for (const latchCase of HOLD_LATCH_CASES) expect(conflictCaseSentence(latchCase)).toBeUndefined()
  })

  test.each(ROWS)('%s: the latch posts the row\'s notice once to the persona, its lines in SRJ-1004\'s order', (_name, row) => {
    const run = makeNoticeRun()
    expect(latchOnRow(run.latch, KEY, row)).toBe(CONFLICT_LATCH_SET_LATCHED)
    expect(run.posts).toEqual([[KEY, row.notice.text]])

    const lines = run.posts[0][1].split(CONFLICT_NOTICE_LINE_SEPARATOR)
    const at = (line: string) => lines.indexOf(line)
    const listLine = CONFLICT_NOTICE_LIST_LINE_HEAD + row.sessionName + CONFLICT_NOTICE_LIST_LINE_TAIL
    expect(lines[0].startsWith(CONFLICT_NOTICE_FIRST_LINE_HEAD + JSON.stringify(row.sessionName))).toBe(true)
    expect(lines[1]).toBe(row.notice.descriptionLine as string)
    expect(lines.slice(-2)).toEqual([listLine, CONFLICT_NOTICE_HUMAN_ONLY_LINE])
    expect(at(CONFLICT_NOTICE_POINTER_LINE) >= 0).toBe(row.notice.carries.pointer)
    expect(at(CONFLICT_NOTICE_DIFFERENT_ID_MUST_NOT_END_LINE) >= 0).toBe(row.notice.carries.mustNotEnd === 'row')
    expect(at(CONFLICT_NOTICE_ANOTHER_STORE_MUST_NOT_END_LINE) >= 0).toBe(row.notice.carries.mustNotEnd === 'store')
    expect(row.notice.carries.pointer).toBe(row.latchCase !== LATCH_CASE_DIFFERENT_ID)
    if (row.latchCase === LATCH_CASE_DIFFERENT_ID) {
      expect(row.notice.carries.mustNotEnd).toBe('row')
      expect(at(CONFLICT_NOTICE_DIFFERENT_ID_MUST_NOT_END_LINE)).toBe(2)
      expect(run.posts[0][1].includes(operatorActionsTitle())).toBe(false)
    } else if (row.latchCase === LATCH_CASE_ANOTHER_STORE) {
      expect(row.notice.carries.mustNotEnd).toBe('store')
      expect([at(CONFLICT_NOTICE_ANOTHER_STORE_MUST_NOT_END_LINE), at(CONFLICT_NOTICE_POINTER_LINE), at(listLine)]).toEqual([2, 3, 4])
    } else {
      expect(row.notice.carries.mustNotEnd).toBe('none')
      expect(at(CONFLICT_NOTICE_POINTER_LINE)).toBe(2)
    }
  })

  test('the scan\'s and the duplicate-session leftover descriptions both get the "left over from an earlier life" wording', () => {
    const leftovers = CONFLICT_CASE_ROWS.filter((row) => row.refusedOperation === REFUSED_OPERATION_PLAIN_SPAWN && row.latchCase === LATCH_CASE_LEFTOVER)
    expect(leftovers.map((row) => descriptionOf(row).includes(PLAIN_SPAWN_LABEL_NAMES_THIS_ID_PHRASE)).sort()).toEqual([false, true])
    for (const row of leftovers) {
      const run = makeNoticeRun()
      latchOnRow(run.latch, KEY, row)
      expect(run.posts[0][1].split(CONFLICT_NOTICE_LINE_SEPARATOR)[0].includes(CONFLICT_CASE_SENTENCES[LATCH_CASE_LEFTOVER])).toBe(true)
    }
  })

  test('a record with no description gives no description line (the note latch\'s form)', () => {
    const run = makeNoticeRun()
    run.latch.set(KEY, { latchCase: LATCH_CASE_CONFLICTING_LABELS, refusedOperation: REFUSED_OPERATION_RESUME, rowState: ENDED })
    const expected = expectedConflictNotice({ latchCase: LATCH_CASE_CONFLICTING_LABELS, sessionName: personaTmuxSessionName(KEY) })
    expect(expected.descriptionLine).toBeUndefined()
    expect(run.posts).toEqual([[KEY, expected.text]])
    expect(run.posts[0][1].includes(CONFLICT_NOTICE_DESCRIPTION_LINE_HEAD)).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// No session-ending command in CSCB's own lines (SRJ-1001, SRJ-1004; AC 40)
// ---------------------------------------------------------------------------

/**
 * What CSCB's own notice and recovery lines never spell, beyond SR-1.4's five
 * session-ending forms (SRJ-1001; SRJ-716's label option names): a pane kill,
 * a tmux option write, an agent-director row delete, the latch-clearing
 * command, a session probe, and either label option's name.
 */
const CSCB_OWN_LINE_FORBIDDEN: readonly RegExp[] = [
  /kill-pane/i,
  /set-option/i,
  /agent-director\s+delete/i,
  /clear-latch|clear_latch|clearLatch/,
  /has-session/i,
  /ad_owner|ad_pane/,
]

/** Each `CSCB_OWN_LINE_FORBIDDEN` entry a line matches, with the line, so a failure names both. */
const forbiddenIn = (line: string): string[] =>
  CSCB_OWN_LINE_FORBIDDEN.filter((pattern) => pattern.test(line)).map((pattern) => `${pattern} in ${JSON.stringify(line)}`)

describe('no session-ending command', () => {
  test.each(ROWS)('%s: CSCB\'s own lines name no session-ending command and no --include-finished', (_name, row) => {
    const own = cscbOwnLines(conflictNoticeText({ sessionName: row.sessionName, latchCase: row.latchCase, description: descriptionOf(row) }))
    expect(own.length).toBe(row.notice.lines.length - 1)
    expect(own.flatMap(sessionEndingCommandsIn)).toEqual([])
  })

  test.each(ROWS)('%s: CSCB\'s own lines name no kill-pane, set-option, agent-director delete, clear-latch, has-session or label option', (_name, row) => {
    const own = cscbOwnLines(conflictNoticeText({ sessionName: row.sessionName, latchCase: row.latchCase, description: descriptionOf(row) }))
    expect(own.length).toBe(row.notice.lines.length - 1)
    expect(own.flatMap(forbiddenIn)).toEqual([])
  })

  /** One sample per spelling the forbidden list names; each matches exactly one entry. */
  const FORBIDDEN_SAMPLES = [
    'tmux kill-pane -t =slack_bot_alpha',
    'tmux set-option -t =slack_bot_alpha',
    'run agent-director  delete --claude-instance-id cscb_alpha',
    'cscb clear-latch alpha',
    'the clear_latch tool',
    'call clearLatch()',
    'tmux has-session -t =slack_bot_alpha',
    'the @ad_owner option',
    'the @ad_pane option',
  ]

  test('every forbidden entry has a sample, and each sample matches exactly one entry', () => {
    expect(FORBIDDEN_SAMPLES.map((sample) => CSCB_OWN_LINE_FORBIDDEN.filter((pattern) => pattern.test(sample)).length)).toEqual(
      FORBIDDEN_SAMPLES.map(() => 1),
    )
    expect(CSCB_OWN_LINE_FORBIDDEN.filter((pattern) => !FORBIDDEN_SAMPLES.some((sample) => pattern.test(sample)))).toEqual([])
  })

  test.each(FORBIDDEN_SAMPLES.map((sample) => [sample]))('%p in a line of CSCB\'s own is caught; in the quoted description it is let through', (sample) => {
    const notice = conflictNoticeText({ sessionName: STUB_TMUX_SESSION_NAME, latchCase: LATCH_CASE_OWN_ID, description: sample })
    expect(cscbOwnLines(notice).flatMap(forbiddenIn)).toEqual([])
    expect(cscbOwnLines(`${notice}${CONFLICT_NOTICE_LINE_SEPARATOR}${sample}`).flatMap(forbiddenIn).length).toBe(1)
  })

  test('the never-reported-in and not-this-launch kill rows quote "no kill was sent", and the check lets it through', () => {
    const killRows = CONFLICT_CASE_ROWS.filter(
      (row) => row.verb === 'kill' && (row.latchCase === LATCH_CASE_NEVER_REPORTED_IN || row.latchCase === LATCH_CASE_NOT_THIS_LAUNCH),
    )
    expect(new Set(killRows.map((row) => row.latchCase))).toEqual(new Set([LATCH_CASE_NEVER_REPORTED_IN, LATCH_CASE_NOT_THIS_LAUNCH]))
    for (const row of killRows) {
      expect(row.notice.text.includes(NO_KILL_SENT_PHRASE)).toBe(true)
      expect(cscbOwnLines(row.notice.text).some((line) => line.includes(NO_KILL_SENT_PHRASE))).toBe(false)
      expect(cscbOwnLines(row.notice.text).flatMap(sessionEndingCommandsIn)).toEqual([])
    }
  })

  test('a session-ending command in a line of CSCB\'s own is caught; the same words in the quoted description are let through', () => {
    const named = 'run `agent-director kill --claude-instance-id cscb_alpha` now'
    const notice = conflictNoticeText({ sessionName: STUB_TMUX_SESSION_NAME, latchCase: LATCH_CASE_OWN_ID, description: named })
    expect(cscbOwnLines(notice).flatMap(sessionEndingCommandsIn)).toEqual([])
    expect(sessionEndingCommandsIn(notice)).toEqual(['kill as a command'])
    expect(cscbOwnLines(`${notice}${CONFLICT_NOTICE_LINE_SEPARATOR}${named}`).flatMap(sessionEndingCommandsIn)).toEqual(['kill as a command'])
  })

  test.each([
    ['kill as a command', 'run `agent-director kill --claude-instance-id cscb_alpha`'],
    ['kill as a command', 'agent-director kill'],
    ['kill as a command', 'then kill -9 4242'],
    ['kill as a command', 'run kill on that pane'],
    ['kill as a command', 'type `kill 4242`'],
    ['pause', 'run `agent-director pause --claude-instance-id cscb_alpha`'],
    ['pause', 'pause the session'],
    ['--include-finished', 'agent-director kill --include-finished'],
    ['--include-finished', 'the include-finished option'],
    ['tmux kill-session', 'tmux kill-session -t =slack_bot_alpha'],
    ['tmux kill-server', 'tmux kill-server'],
  ])('the form %p catches %p', (form, text) => {
    expect(sessionEndingCommandsIn(text)).toContain(form)
  })

  test('the forms cover SRJ-1001\'s five commands, and none matches agent-director\'s own words or any stub description', () => {
    expect(SESSION_ENDING_COMMAND_FORMS.map((form) => form.name)).toEqual([
      'kill as a command',
      'pause',
      '--include-finished',
      'tmux kill-session',
      'tmux kill-server',
    ])
    expect([NO_KILL_SENT_PHRASE, RETRY_KILL_LATER_PHRASE, NEVER_DELETE_ROW_PHRASE].flatMap(sessionEndingCommandsIn)).toEqual([])
    expect(CONFLICT_CASE_ROWS.flatMap((row) => sessionEndingCommandsIn(descriptionOf(row)))).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// Redaction, the cap and Slack escaping (SRJ-1001, SRJ-508; E12 hatch note)
// ---------------------------------------------------------------------------

describe('the quoted description and session in the notice', () => {
  test('a token-bearing description is redacted in the description line and the post passes assertNoLeak', () => {
    const run = makeNoticeRun()
    const description = `${CONFLICT_OWN_ID_PHRASE} (${sentinelInMessage('n')})`
    latchOnDescription(run.latch, KEY, description)
    const descriptionLine = run.posts[0][1].split(CONFLICT_NOTICE_LINE_SEPARATOR)[1]
    expect(descriptionLine).toBe(expectedConflictNotice({ latchCase: LATCH_CASE_OWN_ID, sessionName: personaTmuxSessionName(KEY), description }).descriptionLine as string)
    expect(descriptionLine.includes(escapeSlackControlCharacters(`(${REDACTED_SENTINEL_TAIL})`))).toBe(true)
    assertNoLeak(run.posts)
  })

  test('an overlong description is capped at MAX_LOGGED_MESSAGE_LENGTH before it is quoted', () => {
    const run = makeNoticeRun()
    const description = `${CONFLICT_OWN_ID_PHRASE} ${'x'.repeat(2 * MAX_LOGGED_MESSAGE_LENGTH)}`
    latchOnDescription(run.latch, KEY, description)
    const descriptionLine = run.posts[0][1].split(CONFLICT_NOTICE_LINE_SEPARATOR)[1]
    const quoted = descriptionLine.slice(CONFLICT_NOTICE_DESCRIPTION_LINE_HEAD.length, -CONFLICT_NOTICE_DESCRIPTION_LINE_TAIL.length)
    expect(quoted).toBe(renderLogMessageText(description))
    expect(quoted.length).toBe(MAX_LOGGED_MESSAGE_LENGTH)
  })

  test('Slack control characters in the description and the session name are escaped once in the post; the log line keeps them as written', () => {
    const run = makeNoticeRun()
    const sessionName = 'ses<s>&n'
    const controls = '<!channel> & <@U0ALERT>'
    const description = `tmux session ${JSON.stringify(sessionName)}: ${CONFLICT_OWN_ID_PHRASE} ${controls}`
    latchOnDescription(run.latch, KEY, description)
    const notice = run.posts[0][1]
    expect(notice).toBe(expectedConflictNotice({ latchCase: LATCH_CASE_OWN_ID, sessionName, description }).text)
    const lines = notice.split(CONFLICT_NOTICE_LINE_SEPARATOR)
    expect(lines[0].includes(JSON.stringify(escapeSlackControlCharacters(sessionName)))).toBe(true)
    expect(lines.at(-2)).toBe(CONFLICT_NOTICE_LIST_LINE_HEAD + escapeSlackControlCharacters(sessionName) + CONFLICT_NOTICE_LIST_LINE_TAIL)
    expect(lines[1]).toBe(CONFLICT_NOTICE_DESCRIPTION_LINE_HEAD + escapeSlackControlCharacters(description) + CONFLICT_NOTICE_DESCRIPTION_LINE_TAIL)
    expect(/[<>]/.test(notice)).toBe(false)
    expect(notice.includes(escapeSlackControlCharacters(escapeSlackControlCharacters('<')))).toBe(false)
    expect(run.lines.filter((line) => line.includes(controls) && line.includes(JSON.stringify(sessionName))).length).toBe(1)
  })

  test('a token-shaped quoted session is redacted in the first line and the list line', () => {
    const run = makeNoticeRun()
    const ownId = rowWhere((row) => row.latchCase === LATCH_CASE_OWN_ID)
    run.latch.setFromConflict(KEY, errTmuxSessionConflict(ownId.verb, ownId.stubCase, fakeToken(BOT_TOKEN_PREFIX, 'q'), ownId.options), {
      refusedOperation: REFUSED_OPERATION_RESUME,
      rowState: ENDED,
    })
    const lines = run.posts[0][1].split(CONFLICT_NOTICE_LINE_SEPARATOR)
    const placeholder = escapeSlackControlCharacters(REDACTED_TOKEN_PLACEHOLDER)
    expect(lines[0].includes(JSON.stringify(placeholder))).toBe(true)
    expect(lines.at(-2)).toBe(CONFLICT_NOTICE_LIST_LINE_HEAD + placeholder + CONFLICT_NOTICE_LIST_LINE_TAIL)
  })
})

// ---------------------------------------------------------------------------
// The episode: once per latch episode (SRJ-508, SRJ-1016; AC 41)
// ---------------------------------------------------------------------------

describe('the CONFLICT notice\'s episode', () => {
  const ownId = rowWhere((row) => row.latchCase === LATCH_CASE_OWN_ID)
  const ownIdAgain = rowWhere((row) => row.latchCase === LATCH_CASE_OWN_ID && row !== ownId)
  const leftover = rowWhere((row) => row.latchCase === LATCH_CASE_LEFTOVER)

  test('a latch posts once; a same-case set posts nothing; a new case posts once more; a return to the first case is a new case too', () => {
    const run = makeNoticeRun()
    latchOnRow(run.latch, KEY, ownId)
    const firstEpisode = run.episodes.view(KEY, PERSONA_EPISODE_KIND_CONFLICT)
    expect(firstEpisode?.caseLabel).toBe(LATCH_CASE_OWN_ID)

    expect(latchOnRow(run.latch, KEY, ownIdAgain)).toBe(CONFLICT_LATCH_SET_SAME_CASE)
    expect(latchOnRow(run.latch, KEY, ownId)).toBe(CONFLICT_LATCH_SET_SAME_CASE)
    expect(run.posts).toEqual([[KEY, ownId.notice.text]])
    expect(run.episodes.view(KEY, PERSONA_EPISODE_KIND_CONFLICT)?.episode).toBe(firstEpisode?.episode)

    expect(latchOnRow(run.latch, KEY, leftover)).toBe(CONFLICT_LATCH_SET_RELATCHED)
    expect(latchOnRow(run.latch, KEY, leftover)).toBe(CONFLICT_LATCH_SET_SAME_CASE)
    expect(latchOnRow(run.latch, KEY, ownId)).toBe(CONFLICT_LATCH_SET_RELATCHED)
    expect(run.posts).toEqual([
      [KEY, ownId.notice.text],
      [KEY, leftover.notice.text],
      [KEY, ownId.notice.text],
    ])
    expect(run.episodes.view(KEY, PERSONA_EPISODE_KIND_CONFLICT)?.caseLabel).toBe(LATCH_CASE_OWN_ID)
  })

  test('a second persona\'s latch posts only for itself and leaves the first persona\'s episode as it was', () => {
    const run = makeNoticeRun()
    latchOnRow(run.latch, KEY, ownId)
    const first = run.episodes.view(KEY, PERSONA_EPISODE_KIND_CONFLICT)
    latchOnRow(run.latch, OTHER, leftover)
    latchOnRow(run.latch, OTHER, leftover)
    expect(run.posts).toEqual([
      [KEY, ownId.notice.text],
      [OTHER, leftover.notice.text],
    ])
    expect(run.episodes.view(KEY, PERSONA_EPISODE_KIND_CONFLICT)).toEqual(first)
  })

  test.each([
    ['unproven-idle', { reason: 'unproven-idle', autoRestartDisabled: false, heldMs: 600_000 }],
    ['blocked-on-prompt', { reason: 'blocked-on-prompt', autoRestartDisabled: false }],
  ] as const)('a persona already given the %s not-connected notice still gets the CONFLICT post once', (_reason, notConnected: NotConnectedNotice) => {
    const notConnectedPosts: Array<readonly [string, string]> = []
    setSessionNotifier((key, text) => {
      notConnectedPosts.push([key, text])
    })
    expect(notifyPersonaNotConnected(KEY, notConnected)).toBe(true)
    expect(notConnectedPosts.map(([key]) => key)).toEqual([KEY])

    const run = makeNoticeRun()
    latchOnRow(run.latch, KEY, ownId)
    latchOnRow(run.latch, KEY, ownId)
    expect(run.posts).toEqual([[KEY, ownId.notice.text]])
    expect(notifyPersonaNotConnected(KEY, notConnected)).toBe(false)
    expect(notConnectedPosts.length).toBe(1)
    assertNoLeak(notConnectedPosts)
  })

  test('a hold case opens no CONFLICT episode and posts nothing', () => {
    const run = makeNoticeRun()
    for (const latchCase of HOLD_LATCH_CASES) {
      run.latch.set(KEY, { latchCase, refusedOperation: REFUSED_OPERATION_NONE, rowState: LATCH_ROW_STATE_UNREADABLE })
    }
    expect(run.posts).toEqual([])
    expect(run.episodes.isOpen(KEY, PERSONA_EPISODE_KIND_CONFLICT)).toBe(false)
  })

  test('after the episodes close (shutdown) a latch opens and posts nothing; an unbound reaction posts nothing', () => {
    const closed = makeNoticeRun()
    closed.episodes.close()
    latchOnRow(closed.latch, KEY, ownId)
    expect([closed.posts, closed.episodes.isOpen(KEY, PERSONA_EPISODE_KIND_CONFLICT)]).toEqual([[], false])

    const unbound = makeNoticeRun()
    unbound.unbind()
    latchOnRow(unbound.latch, KEY, ownId)
    expect([unbound.posts, unbound.episodes.isOpen(KEY, PERSONA_EPISODE_KIND_CONFLICT)]).toEqual([[], false])
  })

  test('after a teardown forgets the latch and the episodes, a new latch with the same case posts again', () => {
    const run = makeNoticeRun()
    latchOnRow(run.latch, KEY, ownId)
    run.latch.forget(KEY)
    run.episodes.forget(KEY)
    expect(latchOnRow(run.latch, KEY, ownId)).toBe(CONFLICT_LATCH_SET_LATCHED)
    expect(run.posts).toEqual([
      [KEY, ownId.notice.text],
      [KEY, ownId.notice.text],
    ])
  })
})

// ---------------------------------------------------------------------------
// The recovery notice (SRJ-1005)
// ---------------------------------------------------------------------------

describe('the recovery notice', () => {
  const KINDS: ReadonlyArray<readonly [string, LatchKind]> = [
    ['conflict', LATCH_KIND_CONFLICT],
    ['hold', LATCH_KIND_HOLD],
  ]
  const CASES = RECOVERY_REASONS.flatMap(([reasonName, reason]) => KINDS.map(([kindName, kind]) => [kindName, reasonName, kind, reason] as const))

  test.each(CASES)('a %s latch cleared for %s: the heading for its kind, the quoted session only for a CONFLICT latch, and the reason', (_k, _r, kind, reason) => {
    const name = STUB_TMUX_SESSION_NAME
    const reasonText =
      reason.kind === LATCH_RECOVERY_REASON_KIND_ROW_READS
        ? LATCH_RECOVERY_REASON_ROW_READS_HEAD + reason.state
        : LATCH_RECOVERY_REASON_TEXTS[reason.kind]
    const text = latchRecoveryText(kind, reason, name)
    expect(text).toBe(
      kind === LATCH_KIND_CONFLICT
        ? `${CONFLICT_RECOVERY_HEAD}${JSON.stringify(name)}${CONFLICT_RECOVERY_REASON_LEAD}${reasonText}${LATCH_RECOVERY_TAIL}`
        : `${HOLD_RECOVERY_HEAD}${reasonText}${LATCH_RECOVERY_TAIL}`,
    )
    expect(text.includes(name)).toBe(kind === LATCH_KIND_CONFLICT)
    expect(sessionEndingCommandsIn(text)).toEqual([])
    expect(text.split(CONFLICT_NOTICE_LINE_SEPARATOR).flatMap(forbiddenIn)).toEqual([])
  })

  test('each case maps to its latch kind: the two hold cases to hold, every other case to conflict', () => {
    expect(LATCH_CASES.map((latchCase) => [latchCase, latchKindOf(latchCase)])).toEqual(
      LATCH_CASES.map((latchCase) => [latchCase, isHoldLatchCase(latchCase) ? LATCH_KIND_HOLD : LATCH_KIND_CONFLICT]),
    )
  })

  test('a row state and a session name are redacted and escaped in the recovery text', () => {
    const state = `<!here> ${sentinelInMessage('state')}`
    const reasonText = latchRecoveryReasonText(latchRecoveryReasonRowReads(state))
    expect(reasonText).toBe(LATCH_RECOVERY_REASON_ROW_READS_HEAD + escapeSlackControlCharacters(renderLogMessageText(state)))
    const sessionName = 'ses<s>&n'
    expect(conflictRecoveryText(sessionName, LATCH_RECOVERY_REASON_ROW_GONE).includes(JSON.stringify(escapeSlackControlCharacters(sessionName)))).toBe(true)
    assertNoLeak([reasonText])
  })
})
