/**
 * slow-recovery.test.ts — The slow dead-session recovery post (b.jg5 SRJ-610,
 * SRJ-1010, SRJ-1016; AC 66).
 *
 * The pin cases hold SRJ-1010's text literally, once, with the threshold's
 * value, and each tracker line's wording literally, once (every reset
 * reason's text included); every other case compares with the builders
 * (`slowRecoveryText` and the line builders) and steps by
 * `SLOW_RECOVERY_POST_THRESHOLD`.
 *
 * Over a real episodes instance (`createPersonaEpisodes`) on `createFakeClock`
 * with a recording sink, per persona: live notes below the threshold post
 * nothing, the note at it posts the builder's text once, and later live notes
 * post nothing while the episode is open. A dead note resets the count and
 * ends the episode, so the next run of threshold-many posts once more. An
 * install-gone note (`ErrSystemInstallDisappeared`), an other note (another
 * verdict or a session already connected, a `pending` first probe, or a
 * `pending` re-probe; any other reason given is the other-verdict one) and a
 * healthy note (a health-check tick found the session healthy) reset the
 * count and leave an open episode open, so threshold-many live notes after
 * them post nothing; with none open the count starts again from one. The latch end, the teardown's `forget` and
 * shutdown's `close` reset the count and end the episode silently. Q's notes
 * count and post apart from P's. A throwing episodes member or log breaks no
 * note. Each behaviour's case asserts the exact lines it logs, through the
 * builders: a count line per live note, the posted line with the post, the
 * not-posted line after `close`, a reset line (with its reason) only when the
 * count was above 0, an ended line (with its reason) only when an episode was
 * open, and a failed line per throwing note. Every line carries the persona
 * key only, and `afterEach` asserts no timer is pending and runs
 * `assertNoLeak` over every post and line. A persona teardown (b.jg5
 * SRJ-1003): from its submit until its window opens the note at the
 * threshold reaches no sink and logs the muted line, counting as posted in
 * its episode; with the window open it posts as usual.
 *
 * What the restart work notes for each reading (an `unknown` re-probe noting
 * nothing included) is in `tests/restart.test.ts`, the health check's call of
 * the healthy note in `tests/health-check.test.ts`; the count's own rules in
 * the episodes instance are in `tests/persona-episodes.test.ts`.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'

import { describeThrownValue } from '../src/persona-connection-errors.ts'
import {
  PERSONA_EPISODE_KIND_SLOW_DEAD_SESSION_RECOVERY,
  createPersonaEpisodes,
  type PersonaEpisodes,
  type PersonaEpisodeSink,
} from '../src/persona-episodes.ts'
import type { PersonaTeardownWindowState } from '../src/persona-notifier.ts'
import {
  SLOW_RECOVERY_POST_THRESHOLD,
  SLOW_RECOVERY_RESET_HEALTHY,
  SLOW_RECOVERY_RESET_INSTALL_GONE,
  SLOW_RECOVERY_RESET_LATCHED,
  SLOW_RECOVERY_RESET_OTHER_VERDICT,
  SLOW_RECOVERY_RESET_PENDING_PROBE,
  SLOW_RECOVERY_RESET_PENDING_REPROBE,
  SLOW_RECOVERY_RESET_ROW_DEAD,
  SLOW_RECOVERY_RESET_TEXT,
  createSlowRecoveryTracker,
  slowRecoveryCountLine,
  slowRecoveryCountResetLine,
  slowRecoveryEpisodeEndedLine,
  slowRecoveryFailedLine,
  slowRecoveryNoticeMutedLine,
  slowRecoveryNoticeNotPostedLine,
  slowRecoveryNoticePostedLine,
  slowRecoveryText,
  type SlowRecoveryLiveResult,
  type SlowRecoveryResetReason,
  type SlowRecoveryTracker,
} from '../src/slow-recovery.ts'
import { REDACTED_SENTINEL_TAIL, assertNoLeak, sentinelInMessage } from './test-helpers/credentials.ts'
import { createFakeClock, type FakeClock } from './test-helpers/fake-clock.ts'

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

const P = 'alpha'
const Q = 'beta'
const KIND = PERSONA_EPISODE_KIND_SLOW_DEAD_SESSION_RECOVERY
const T = SLOW_RECOVERY_POST_THRESHOLD

interface Post {
  key: string
  text: string
}

let clock: FakeClock
let posts: Post[]
let lines: string[]
let episodes: PersonaEpisodes
let tracker: SlowRecoveryTracker

const record: PersonaEpisodeSink = (key, text) => {
  posts.push({ key, text })
}

/** A tracker over `over` (the case's episodes instance unless another is given) and the line capture. */
function track(over: PersonaEpisodes = episodes, log: (line: string) => void = (line) => lines.push(line)): SlowRecoveryTracker {
  return createSlowRecoveryTracker({ episodes: over, log })
}

/** `n` live notes for `key`, answering each note's result. */
function live(key: string, n: number): SlowRecoveryLiveResult[] {
  return Array.from({ length: n }, () => tracker.noteLive(key))
}

/** What threshold-many live notes answer when the last one posts. */
const RUN_THAT_POSTS: SlowRecoveryLiveResult[] = [...Array<SlowRecoveryLiveResult>(T - 1).fill('counted'), 'posted']

/** What `n` live notes answer when none posts. */
const counted = (n: number): SlowRecoveryLiveResult[] => Array<SlowRecoveryLiveResult>(n).fill('counted')

/** The notice as posted to `key`. */
const notice = (key: string): Post => ({ key, text: slowRecoveryText(key) })

/** Open P's episode with its one post. */
function openEpisode(key: string = P): void {
  expect(live(key, T)).toEqual(RUN_THAT_POSTS)
  expect(tracker.isOpen(key)).toBe(true)
}

/** The count lines of live notes taking `key`'s count from `from` to `to`. */
function countLines(key: string, from: number, to: number): string[] {
  return Array.from({ length: to - from + 1 }, (_, i) => slowRecoveryCountLine(key, from + i))
}

/** The lines of a run of threshold-many live notes from 0 whose last posts. */
const postingRunLines = (key: string): string[] => [...countLines(key, 1, T), slowRecoveryNoticePostedLine(key, T)]

/** The lines logged since the last `takeLines`, emptying the capture. */
function takeLines(): string[] {
  return lines.splice(0)
}

beforeEach(() => {
  clock = createFakeClock()
  posts = []
  lines = []
  episodes = createPersonaEpisodes({ sink: record, log: (line) => lines.push(line), clock })
  tracker = track()
})

afterEach(() => {
  expect(clock.pendingCount()).toBe(0)
  assertNoLeak({ posts, lines })
})

// ---------------------------------------------------------------------------
// Pin
// ---------------------------------------------------------------------------

describe('SRJ-1010\'s text (pin)', () => {
  test('the one pin case: the text for a sample persona\'s session, and the threshold of 3', () => {
    expect(slowRecoveryText('sample')).toBe(
      ':hourglass_flowing_sand: *Slow recovery* — agent-director has not yet marked the worker row of this persona\'s session "slack_bot_sample" ended or missing. CSCB keeps retrying; no action is needed unless this persists.',
    )
    expect(SLOW_RECOVERY_POST_THRESHOLD).toBe(3)
  })

  test('the one pin of each tracker line\'s wording, and each reset reason\'s text', () => {
    expect([
      slowRecoveryCountLine('sample', 2),
      slowRecoveryNoticePostedLine('sample', 3),
      slowRecoveryNoticeMutedLine('sample', 3),
      slowRecoveryNoticeNotPostedLine('sample'),
      slowRecoveryCountResetLine('sample', 2, SLOW_RECOVERY_RESET_ROW_DEAD),
      slowRecoveryEpisodeEndedLine('sample', SLOW_RECOVERY_RESET_LATCHED),
      slowRecoveryFailedLine('sample', describeThrownValue('refused')),
    ]).toEqual([
      "[slack] slow-recovery: persona=sample count 2 of 3 — an escalate-dead verdict's re-probe still reads the row live",
      '[slack] slow-recovery: persona=sample notice posted — 3 consecutive escalate-dead verdicts whose re-probe still reads the row live',
      '[slack] slow-recovery: persona=sample notice not posted — muted, its persona teardown was submitted; it counts as posted in its episode; 3 consecutive escalate-dead verdicts whose re-probe still reads the row live',
      '[slack] slow-recovery: persona=sample notice not posted — the server is shutting down',
      '[slack] slow-recovery: persona=sample count reset from 2 — its row read ended or missing, or no row was found',
      '[slack] slow-recovery: persona=sample episode ended — the persona latched',
      '[slack] slow-recovery: persona=sample failed: string message="refused"',
    ])
    expect(SLOW_RECOVERY_RESET_TEXT).toEqual({
      [SLOW_RECOVERY_RESET_ROW_DEAD]: 'its row read ended or missing, or no row was found',
      [SLOW_RECOVERY_RESET_INSTALL_GONE]: 'its liveness read dead from ErrSystemInstallDisappeared, which reads no row',
      [SLOW_RECOVERY_RESET_OTHER_VERDICT]: 'a restart run ended with a verdict other than escalate-dead',
      [SLOW_RECOVERY_RESET_PENDING_REPROBE]: "an escalate-dead verdict's re-probe read the row pending, which is not counted",
      [SLOW_RECOVERY_RESET_PENDING_PROBE]: "a restart run's liveness probe read the row pending",
      [SLOW_RECOVERY_RESET_HEALTHY]: 'a health check found the session live, connected and with its stream',
      [SLOW_RECOVERY_RESET_LATCHED]: 'the persona latched',
    })
  })
})

// ---------------------------------------------------------------------------
// Once per episode
// ---------------------------------------------------------------------------

describe('once per episode (AC 66)', () => {
  test('live notes below the threshold post nothing; the note at it posts the builder\'s text once to P; later live notes post nothing while the episode is open', () => {
    expect(live(P, T - 1)).toEqual(counted(T - 1))
    expect(posts).toEqual([])
    expect(tracker.isOpen(P)).toBe(false)
    expect(takeLines()).toEqual(countLines(P, 1, T - 1))

    expect(tracker.noteLive(P)).toBe('posted')
    expect(posts).toEqual([notice(P)])
    expect(episodes.isOpen(P, KIND)).toBe(true)
    expect(takeLines()).toEqual([slowRecoveryCountLine(P, T), slowRecoveryNoticePostedLine(P, T)])

    expect(live(P, T + 1)).toEqual(counted(T + 1))
    expect(tracker.count(P)).toBe(2 * T + 1)
    expect(posts).toEqual([notice(P)])
    expect(takeLines()).toEqual(countLines(P, T + 1, 2 * T + 1))
  })

  test('a dead note resets the count and ends the episode silently; the next threshold-many live notes post once more', () => {
    live(P, T - 1)
    takeLines()
    tracker.noteDead(P)
    expect(tracker.count(P)).toBe(0)
    expect(takeLines()).toEqual([slowRecoveryCountResetLine(P, T - 1, SLOW_RECOVERY_RESET_ROW_DEAD)])
    expect(live(P, T)).toEqual(RUN_THAT_POSTS)
    expect(takeLines()).toEqual(postingRunLines(P))

    tracker.noteDead(P)
    expect([tracker.count(P), tracker.isOpen(P)]).toEqual([0, false])
    expect(posts).toEqual([notice(P)])
    expect(takeLines()).toEqual([
      slowRecoveryCountResetLine(P, T, SLOW_RECOVERY_RESET_ROW_DEAD),
      slowRecoveryEpisodeEndedLine(P, SLOW_RECOVERY_RESET_ROW_DEAD),
    ])

    expect(live(P, T)).toEqual(RUN_THAT_POSTS)
    expect(posts).toEqual([notice(P), notice(P)])
  })

  // Each note that resets the count and leaves an open episode open, with the
  // reason its reset line carries. The tracker is read at call time, since
  // beforeEach builds a new one per case.
  describe.each<[string, SlowRecoveryResetReason, (key: string) => void]>([
    ['an install-gone note (ErrSystemInstallDisappeared)', SLOW_RECOVERY_RESET_INSTALL_GONE, (key) => tracker.noteInstallGone(key)],
    ['an other note (another verdict)', SLOW_RECOVERY_RESET_OTHER_VERDICT, (key) => tracker.noteOther(key, SLOW_RECOVERY_RESET_OTHER_VERDICT)],
    ['an other note (a pending re-probe)', SLOW_RECOVERY_RESET_PENDING_REPROBE, (key) => tracker.noteOther(key, SLOW_RECOVERY_RESET_PENDING_REPROBE)],
    ['an other note (a pending first probe)', SLOW_RECOVERY_RESET_PENDING_PROBE, (key) => tracker.noteOther(key, SLOW_RECOVERY_RESET_PENDING_PROBE)],
    ['a healthy note (a health-check tick found the session healthy)', SLOW_RECOVERY_RESET_HEALTHY, (key) => tracker.noteHealthy(key)],
  ])('%s', (_, reason, note) => {
    test('resets the count and leaves an open episode open: threshold-many live notes after it post nothing', () => {
      openEpisode()
      takeLines()

      note(P)

      expect([tracker.count(P), tracker.isOpen(P)]).toEqual([0, true])
      expect(takeLines()).toEqual([slowRecoveryCountResetLine(P, T, reason)])
      expect(live(P, T)).toEqual(counted(T))
      expect(posts).toEqual([notice(P)])
    })

    // SRJ-1010's threshold counts consecutive verdicts: one live note just
    // below it, then this note, then one more live note posts nothing.
    test('with no episode open, restarts the count from one: the threshold is reached only after threshold-many live notes in a row', () => {
      live(P, T - 1)
      takeLines()

      note(P)

      expect(takeLines()).toEqual([slowRecoveryCountResetLine(P, T - 1, reason)])
      expect(tracker.noteLive(P)).toBe('counted')
      expect(tracker.count(P)).toBe(1)
      expect(posts).toEqual([])
      expect(live(P, T - 2)).toEqual(counted(T - 2))
      expect(tracker.noteLive(P)).toBe('posted')
      expect(posts).toEqual([notice(P)])
    })
  })

  test('an other note given a reason that is none of its own resets with the other-verdict reason', () => {
    live(P, T - 1)
    takeLines()

    tracker.noteOther(P, 'unheard-of' as never)

    expect(tracker.count(P)).toBe(0)
    expect(takeLines()).toEqual([slowRecoveryCountResetLine(P, T - 1, SLOW_RECOVERY_RESET_OTHER_VERDICT)])
  })

  // The latch end logs its reset and ended lines; the teardown's forget,
  // made on the episodes instance, logs no tracker line.
  test.each([
    ['the latch end', () => tracker.endForLatch(P), true],
    ['the teardown\'s forget', () => episodes.forget(P), false],
  ] as const)('%s resets the count and ends the episode silently, below the threshold and after the post', (_, end, logs) => {
    live(P, T - 1)
    takeLines()
    end()
    expect(tracker.count(P)).toBe(0)
    expect(takeLines()).toEqual(logs ? [slowRecoveryCountResetLine(P, T - 1, SLOW_RECOVERY_RESET_LATCHED)] : [])
    openEpisode()
    takeLines()

    end()

    expect([tracker.count(P), tracker.isOpen(P)]).toEqual([0, false])
    expect(takeLines()).toEqual(
      logs
        ? [slowRecoveryCountResetLine(P, T, SLOW_RECOVERY_RESET_LATCHED), slowRecoveryEpisodeEndedLine(P, SLOW_RECOVERY_RESET_LATCHED)]
        : [],
    )
    expect(posts).toEqual([notice(P)])
    expect(live(P, T)).toEqual(RUN_THAT_POSTS)
    expect(posts).toEqual([notice(P), notice(P)])
  })

  test('after shutdown\'s close the count is cleared and the note at the threshold posts nothing', () => {
    live(P, T - 1)
    takeLines()

    episodes.close()

    expect(tracker.count(P)).toBe(0)
    expect(live(P, T)).toEqual([...counted(T - 1), 'closed'])
    expect(tracker.isOpen(P)).toBe(false)
    expect(posts).toEqual([])
    expect(takeLines()).toEqual([...countLines(P, 1, T), slowRecoveryNoticeNotPostedLine(P)])
  })

  test('Q\'s notes count and post apart from P\'s', () => {
    live(Q, T - 1)
    openEpisode(P)
    expect(tracker.count(Q)).toBe(T - 1)

    tracker.noteDead(P)
    tracker.noteLive(P)
    tracker.endForLatch(Q)
    expect([tracker.count(P), tracker.count(Q), tracker.isOpen(Q)]).toEqual([1, 0, false])

    expect(live(Q, T)).toEqual(RUN_THAT_POSTS)
    tracker.noteInstallGone(P)
    tracker.noteOther(P, SLOW_RECOVERY_RESET_OTHER_VERDICT)
    expect([tracker.count(Q), tracker.isOpen(Q)]).toEqual([T, true])
    expect(tracker.isOpen(P)).toBe(false)

    expect(posts).toEqual([notice(P), notice(Q)])
  })
})

// ---------------------------------------------------------------------------
// A persona teardown (b.jg5 SRJ-1003)
// ---------------------------------------------------------------------------

// From a persona teardown's submit until its window opens the episodes post
// nothing for the key (tests/persona-episodes.test.ts); the tracker's own
// line then says its notice was muted, and the post still counts in its
// episode, so the run after it posts nothing more. With the window open the
// notice goes to the sink (the notifier's window writes it), as posted.
describe('a persona teardown (b.jg5 SRJ-1003)', () => {
  let states: Map<string, PersonaTeardownWindowState>

  beforeEach(() => {
    states = new Map()
    episodes = createPersonaEpisodes({ sink: record, log: (line) => lines.push(line), clock, teardownWindow: (key) => states.get(key) ?? 'none' })
    tracker = track()
  })

  /** The tracker's own lines, without the episodes' muted line. */
  const trackerLines = (): string[] => takeLines().filter((line) => line.startsWith('[slack] slow-recovery: '))

  test('P\'s teardown submitted: the note at the threshold reaches no sink and logs the muted line, not the posted one; it counts as posted, so later live notes post nothing; Q\'s notice posts as usual', () => {
    states.set(P, 'submitted')

    expect(live(P, T)).toEqual(RUN_THAT_POSTS)
    expect(posts).toEqual([])
    expect(tracker.isOpen(P)).toBe(true)
    expect(trackerLines()).toEqual([...countLines(P, 1, T), slowRecoveryNoticeMutedLine(P, T)])

    states.delete(P)
    expect(live(P, T)).toEqual(counted(T))
    expect(posts).toEqual([])

    expect(live(Q, T)).toEqual(RUN_THAT_POSTS)
    expect(posts).toEqual([notice(Q)])
    expect(trackerLines()).toEqual([...countLines(P, T + 1, 2 * T), ...postingRunLines(Q)])
  })

  test('P\'s teardown window open: the notice goes to the sink and the posted line is logged', () => {
    states.set(P, 'open')

    expect(live(P, T)).toEqual(RUN_THAT_POSTS)

    expect(posts).toEqual([notice(P)])
    expect(trackerLines()).toEqual(postingRunLines(P))
  })
})

// ---------------------------------------------------------------------------
// Lines and failures
// ---------------------------------------------------------------------------

describe('lines and failures', () => {
  test('every line carries the persona key only; a note with no count and no episode logs nothing', () => {
    tracker.noteDead(P)
    tracker.noteInstallGone(P)
    tracker.noteOther(P, SLOW_RECOVERY_RESET_OTHER_VERDICT)
    tracker.noteHealthy(P)
    tracker.endForLatch(P)
    expect(lines).toEqual([])

    openEpisode(P)
    live(Q, 1)
    tracker.noteOther(Q, SLOW_RECOVERY_RESET_PENDING_REPROBE)
    live(Q, 1)
    tracker.noteHealthy(Q)
    tracker.noteDead(P)

    expect(lines.length).toBeGreaterThan(0)
    for (const line of lines) expect(line).toMatch(new RegExp(`^\\[slack\\] slow-recovery: persona=(${P}|${Q}) `))
  })

  test('a throwing episodes member is logged, described and redacted, and no note throws or changes state', () => {
    const refusal = new Error(`count refused (${sentinelInMessage('slow')})`)
    tracker = track({
      ...episodes,
      addCount: () => {
        throw refusal
      },
      resetCount: () => {
        throw refusal
      },
    })
    episodes.addCount(P, KIND)

    expect(tracker.noteLive(P)).toBe('counted')
    tracker.noteDead(P)
    tracker.noteInstallGone(P)
    tracker.noteOther(P, SLOW_RECOVERY_RESET_OTHER_VERDICT)
    tracker.noteHealthy(P)
    tracker.endForLatch(P)

    expect(tracker.count(P)).toBe(1)
    expect(posts).toEqual([])
    expect(lines).toEqual(Array(6).fill(slowRecoveryFailedLine(P, describeThrownValue(refusal))))
    expect(lines[0]).toContain(`message="count refused (${REDACTED_SENTINEL_TAIL})"`)
  })

  test('a throwing log is swallowed: the post is still made once', () => {
    tracker = track(episodes, () => {
      throw new Error('log refused')
    })

    expect(live(P, T + 1)).toEqual([...RUN_THAT_POSTS, 'counted'])
    tracker.noteDead(P)
    expect([tracker.count(P), tracker.isOpen(P)]).toEqual([0, false])
    expect(posts).toEqual([notice(P)])
  })
})
