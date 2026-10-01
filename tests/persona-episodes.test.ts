/**
 * persona-episodes.test.ts — The once-per-episode latch of every per-persona
 * notice kind (b.jg5 SRJ-1016, AC 41, AC 67).
 *
 * Every declared kind posts once per episode however often it is asked to,
 * and once more in a new episode; each (persona, kind) pair has its own
 * latch. A case that differs from the open episode's begins a new one, the
 * same case keeps it, and each marked text posts at most once per episode.
 * `forget` drops only its key's episodes and `forgetAll` every persona's,
 * posting nothing. An episode's start time comes from the injected clock. A
 * sink that throws or rejects is logged once, redacted, and still counts as
 * posted. A log that throws is swallowed: no post throws and no rejection
 * escapes. b.f2b's not-connected latch (`notConnectedNoticeRaised` in
 * `src/session-manager.ts`) is separate: neither latch raises, reads or ends
 * the other.
 *
 * The `tmux-unresponsive` condition's own rules, direct over
 * `createTmuxUnresponsiveCondition`: `continued` and `ended-after-notice`, the
 * ended line's text per reason (an unknown reason pinned once), a throwing
 * log or condition-end hook swallowed, and `forget`/`forgetAll` dropping a
 * holding condition without calling the hook. Its alert check: `cancelAlert`
 * for a non-terminal stop cancels a pending check (one line, true; a second
 * call false and silent), and the episode's next `continued` start arms it
 * again from the first refusal (posting at the next clock turn once the
 * threshold has passed); a stop in `UNAVAILABLE_RETRY_TERMINAL_STOPS` never
 * re-arms; a cancel after the alert posted, or with no episode open, cancels
 * nothing; a closed episode's re-arm mark does not reach the next one. Once
 * the alert has posted, neither onset check posts the onset (one line per
 * episode), and `end` answers `ended-after-notice`, posting the recovery
 * unless silent. Each failure-only line is
 * reached through an injected dep and throws nothing out of its entry: a NaN
 * threshold (`alert check not armed`, the start still succeeding), an alert
 * fire whose post or threshold read throws (`alert check failed`), a clock
 * whose clear throws (`alert check cancel failed`, and at an end `episode
 * close step failed`), an episodes member that throws in either onset check,
 * and a throwing health-check mode accessor (taken as on). Its starts and
 * ends through the outage state are in `tests/tmux-unresponsive.test.ts`.
 *
 * The unclassified-error episodes (b.jg5 SRJ-313, SRJ-1009, SRJ-1016),
 * direct over `createUnclassifiedErrorEpisodes` with the threshold from an
 * injected accessor (agent-director's defaults and AC 80's settings, through
 * `adAlertThresholdMs`): a report at exactly the threshold after the
 * episode's first posts nothing, the first strictly past it posts one alert
 * (the builder's text for that report's classification, or the site's own)
 * and later ones post nothing; the accessor is read at each check. The text:
 * name and message from the classifier, an unsafe name left out, a message
 * redacted and capped, and escaped for Slack (`<!channel>`, `<@U…>`, `&`)
 * only on the post route. Routing, decided at the alert: a configured key to
 * the sink only, any other key to the log-only route only (with the
 * `persona-unclassified-error` label on its line), a throwing lookup taking
 * the log-only route, a missing or throwing log-only route logged, and one
 * latch for both routes. Ends: `end` for each reason and `retryStopped` for
 * `UNAVAILABLE_RETRY_STOP_RECOVERED` and `UNAVAILABLE_RETRY_STOP_ROW_LIVE`
 * (each ended line exact); every other stop leaves the episode open; `end`,
 * `forget`, `forgetAll` and `close` post nothing and leave another persona's
 * episode intact, and a report after them begins a new episode that alerts
 * again. A throwing episodes member, threshold accessor or log breaks no
 * report.
 *
 * Close steps: `whenClosed` runs its step exactly once on every close path
 * (`end`, a new case, `forget`, `forgetAll`, `close`), answers false and
 * keeps nothing with no episode open, and a throwing step is logged
 * (`episode close step failed`) while the others still run. `openKeys` lists
 * only the kind's open keys; after `close()` every kind's `begin` answers
 * `closed` and nothing posts.
 *
 * Pure module under test: built over `createFakeClock`, a recording notice
 * sink and a line capture. Kinds come from `PERSONA_EPISODE_KINDS`, so a
 * later kind joins every table. `afterEach` asserts no timer is pending and
 * runs `assertNoLeak` over every captured post and line.
 */

import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test'

import {
  AD_ERROR_CLASS_UNCLASSIFIED,
  classifyAdError,
  describeAdErrorClassification,
  describeAgentDirectorFailure,
  type AdErrorClassification,
} from '../src/ad-error-class.ts'
import { DEFAULT_AD_SETTINGS_IN_EFFECT, adAlertThresholdMs, type AdSettingsInEffect } from '../src/ad-settings.ts'
import { LIVENESS_LIVE } from '../src/liveness-reading.ts'
import { MAX_LOGGED_MESSAGE_LENGTH } from '../src/persona-connection-errors.ts'
import {
  PERSONA_EPISODE_DEFAULT_MARK,
  PERSONA_EPISODE_KINDS,
  PERSONA_EPISODE_KIND_CONFLICT,
  PERSONA_EPISODE_KIND_STUCK_LAUNCH,
  PERSONA_EPISODE_KIND_TMUX_UNRESPONSIVE,
  PERSONA_EPISODE_KIND_UNCLASSIFIED_ERROR,
  PERSONA_UNCLASSIFIED_ERROR_LABEL,
  TMUX_UNRESPONSIVE_END_RETRY,
  TMUX_UNRESPONSIVE_END_TEXT,
  TMUX_UNRESPONSIVE_END_TICK,
  TMUX_UNRESPONSIVE_END_TMUX_VERB,
  TMUX_UNRESPONSIVE_ONSET_FLOOR_MS,
  UNCLASSIFIED_ERROR_END_CAPPED,
  UNCLASSIFIED_ERROR_END_RECOVERED,
  UNCLASSIFIED_ERROR_END_ROW_LIVE,
  createPersonaEpisodes,
  createTmuxUnresponsiveCondition,
  createUnclassifiedErrorEpisodes,
  tmuxUnresponsiveAlertText,
  tmuxUnresponsiveOnsetText,
  tmuxUnresponsiveRecoveryText,
  unclassifiedErrorAlertText,
  type PersonaEpisodeKind,
  type PersonaEpisodeSink,
  type PersonaEpisodesClock,
  type PersonaEpisodes,
  type TmuxUnresponsiveCondition,
  type TmuxUnresponsiveEndReason,
  type UnclassifiedErrorEndReason,
  type UnclassifiedErrorEpisodes,
  type UnclassifiedErrorEpisodesDeps,
  type UnclassifiedErrorQuote,
} from '../src/persona-episodes.ts'
import { escapeSlackControlCharacters } from '../src/slack-text-escape.ts'
import {
  _resetNotConnectedEpisodes,
  forgetNotConnectedEpisode,
  notifyPersonaNotConnected,
  setSessionNotifier,
  type NotConnectedNotice,
} from '../src/session-manager.ts'
import {
  UNAVAILABLE_RETRY_STOP_CAPPED,
  UNAVAILABLE_RETRY_STOP_LAUNCH_SKIPPED,
  UNAVAILABLE_RETRY_STOP_NOT_APPLIED,
  UNAVAILABLE_RETRY_STOP_NOT_UP,
  UNAVAILABLE_RETRY_STOP_RECOVERED,
  UNAVAILABLE_RETRY_STOP_ROW_GONE,
  UNAVAILABLE_RETRY_STOP_ROW_LIVE,
  UNAVAILABLE_RETRY_STOP_RUN_FAILED,
  UNAVAILABLE_RETRY_STOP_SHUTDOWN,
  UNAVAILABLE_RETRY_STOP_TMUX_UNAVAILABLE_CLEARED,
  UNAVAILABLE_RETRY_STOP_TMUX_UNRESPONSIVE_ENDED,
  UNAVAILABLE_RETRY_STOP_TORN_DOWN,
  UNAVAILABLE_RETRY_TERMINAL_STOPS,
} from '../src/unavailable-retry.ts'
import {
  errGeneric,
  errInternal,
  errSchemaMismatch,
  errSystemInstallDisappeared,
  errTmuxUnresponsive,
} from './test-helpers/agent-director-stub.ts'
import { createFakeClock, type FakeClock } from './test-helpers/fake-clock.ts'
import {
  BOT_TOKEN_PREFIX,
  LEAK_SENTINEL,
  REDACTED_SENTINEL_TAIL,
  assertNoLeak,
  fakeToken,
  sentinelInMessage,
} from './test-helpers/credentials.ts'

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

const START_MS = 1_000

interface Post {
  key: string
  text: string
}

let clock: FakeClock
let posts: Post[]
let lines: string[]
let episodes: PersonaEpisodes

const record: PersonaEpisodeSink = (key, text) => {
  posts.push({ key, text })
}

/** One instance over the fake clock and the line capture; the recording sink unless another is given. */
function build(sink: PersonaEpisodeSink = record): PersonaEpisodes {
  return createPersonaEpisodes({ sink, log: (line) => lines.push(line), clock })
}

/** A distinct notice body per kind and attempt, built at runtime. */
function textOf(kind: PersonaEpisodeKind, n: number): string {
  return `${kind} body ${n}`
}

const eachKind = PERSONA_EPISODE_KINDS.map((kind) => [kind] as const)

beforeEach(() => {
  clock = createFakeClock({ start: START_MS })
  posts = []
  lines = []
  episodes = build()
})

afterEach(() => {
  expect(clock.pendingCount()).toBe(0)
  assertNoLeak({ posts, lines })
})

// ---------------------------------------------------------------------------
// Once per episode, every kind
// ---------------------------------------------------------------------------

describe('once per episode, for every declared kind', () => {
  test('every kind label is distinct, so no two kinds share a latch', () => {
    expect(new Set(PERSONA_EPISODE_KINDS).size).toBe(PERSONA_EPISODE_KINDS.length)
  })

  test.each(eachKind)('%s posts once per episode however often asked, and once more after end and begin', (kind) => {
    expect(episodes.post('K', kind, textOf(kind, 0))).toBe(false)

    expect(episodes.begin('K', kind)).toBe('begun')
    expect([1, 2, 3].map((n) => episodes.post('K', kind, textOf(kind, n)))).toEqual([true, false, false])
    expect(episodes.begin('K', kind)).toBe('kept')
    expect(episodes.post('K', kind, textOf(kind, 4))).toBe(false)

    expect(episodes.end('K', kind)).toBe(true)
    expect(episodes.isOpen('K', kind)).toBe(false)
    expect(episodes.post('K', kind, textOf(kind, 5))).toBe(false)
    expect(episodes.end('K', kind)).toBe(false)

    expect(episodes.begin('K', kind)).toBe('begun')
    expect([6, 7].map((n) => episodes.post('K', kind, textOf(kind, n)))).toEqual([true, false])

    expect(posts).toEqual([
      { key: 'K', text: textOf(kind, 1) },
      { key: 'K', text: textOf(kind, 6) },
    ])
    expect(lines).toEqual([])
  })

  test('a post with no mark uses the default mark', () => {
    const kind = PERSONA_EPISODE_KINDS[0]
    episodes.begin('K', kind)
    expect(episodes.hasPosted('K', kind)).toBe(false)

    episodes.post('K', kind, textOf(kind, 1))

    expect(episodes.hasPosted('K', kind)).toBe(true)
    expect(episodes.hasPosted('K', kind, PERSONA_EPISODE_DEFAULT_MARK)).toBe(true)
    expect(episodes.post('K', kind, textOf(kind, 2), PERSONA_EPISODE_DEFAULT_MARK)).toBe(false)
    expect(episodes.view('K', kind)?.posted).toEqual([PERSONA_EPISODE_DEFAULT_MARK])
  })

  test('a sink that posts again for the same episode from inside its call posts nothing twice', () => {
    const kind = PERSONA_EPISODE_KINDS[0]
    const inner: boolean[] = []
    episodes = build((key, text) => {
      posts.push({ key, text })
      inner.push(episodes.post('K', kind, textOf(kind, 2)))
    })
    episodes.begin('K', kind)

    expect(episodes.post('K', kind, textOf(kind, 1))).toBe(true)

    expect(inner).toEqual([false])
    expect(posts).toEqual([{ key: 'K', text: textOf(kind, 1) }])
  })
})

// ---------------------------------------------------------------------------
// Cases and marks
// ---------------------------------------------------------------------------

describe('cases and marks', () => {
  const kind = PERSONA_EPISODE_KIND_CONFLICT

  test('the same case, or no case, keeps the episode; a new case begins a new one that posts again', async () => {
    expect(episodes.begin('K', kind, 'case-a')).toBe('begun')
    expect(episodes.post('K', kind, textOf(kind, 1))).toBe(true)
    const first = episodes.view('K', kind)

    await clock.advance(250)
    expect(episodes.begin('K', kind, 'case-a')).toBe('kept')
    expect(episodes.begin('K', kind)).toBe('kept')
    expect(episodes.post('K', kind, textOf(kind, 2))).toBe(false)
    expect(episodes.view('K', kind)).toEqual(first)

    expect(episodes.begin('K', kind, 'case-b')).toBe('new-case')
    const second = episodes.view('K', kind)
    expect(second).toMatchObject({ startedAt: START_MS + 250, caseLabel: 'case-b', posted: [] })
    expect(second!.episode).not.toBe(first!.episode)
    expect(episodes.post('K', kind, textOf(kind, 3))).toBe(true)

    expect(posts.map((p) => p.text)).toEqual([textOf(kind, 1), textOf(kind, 3)])
  })

  test('a case given while the open episode has none begins a new episode', () => {
    episodes.begin('K', kind)
    episodes.post('K', kind, textOf(kind, 1))

    expect(episodes.begin('K', kind, 'case-a')).toBe('new-case')

    expect(episodes.view('K', kind)).toMatchObject({ caseLabel: 'case-a', posted: [] })
    expect(episodes.post('K', kind, textOf(kind, 2))).toBe(true)
  })

  test('each of two marked texts posts at most once per episode, and a new episode resets both marks', () => {
    const stuck = PERSONA_EPISODE_KIND_STUCK_LAUNCH
    const postBoth = (n: number) => [
      episodes.post('K', stuck, textOf(stuck, n), 'first'),
      episodes.post('K', stuck, textOf(stuck, n + 1), 'second'),
      episodes.post('K', stuck, textOf(stuck, n + 2), 'first'),
      episodes.post('K', stuck, textOf(stuck, n + 3), 'second'),
    ]
    episodes.begin('K', stuck)

    expect(postBoth(10)).toEqual([true, true, false, false])
    expect([episodes.hasPosted('K', stuck, 'first'), episodes.hasPosted('K', stuck, 'second')]).toEqual([true, true])
    expect(episodes.hasPosted('K', stuck)).toBe(false)
    expect(episodes.view('K', stuck)?.posted).toEqual(['first', 'second'])

    // A new episode after end and begin resets the marks.
    episodes.end('K', stuck)
    episodes.begin('K', stuck)
    expect([episodes.hasPosted('K', stuck, 'first'), episodes.hasPosted('K', stuck, 'second')]).toEqual([false, false])
    expect(postBoth(20)).toEqual([true, true, false, false])

    // So does a new episode begun by a new case.
    expect(episodes.begin('K', stuck, 'case-b')).toBe('new-case')
    expect(postBoth(30)).toEqual([true, true, false, false])

    expect(posts.map((p) => p.text)).toEqual([10, 11, 20, 21, 30, 31].map((n) => textOf(stuck, n)))
  })
})

// ---------------------------------------------------------------------------
// Isolation
// ---------------------------------------------------------------------------

describe('isolation', () => {
  test('each persona has its own latch for every kind: ending one persona\'s episode leaves the other\'s posted', () => {
    for (const kind of PERSONA_EPISODE_KINDS) {
      episodes.begin('K', kind)
      episodes.begin('Q', kind)
      expect([episodes.post('K', kind, textOf(kind, 1)), episodes.post('Q', kind, textOf(kind, 2))]).toEqual([true, true])

      episodes.end('K', kind)
      expect([episodes.isOpen('K', kind), episodes.isOpen('Q', kind)]).toEqual([false, true])
      expect(episodes.hasPosted('Q', kind)).toBe(true)

      episodes.begin('K', kind)
      expect([episodes.post('K', kind, textOf(kind, 3)), episodes.post('Q', kind, textOf(kind, 4))]).toEqual([true, false])
    }

    expect(posts).toEqual(
      PERSONA_EPISODE_KINDS.flatMap((kind) => [
        { key: 'K', text: textOf(kind, 1) },
        { key: 'Q', text: textOf(kind, 2) },
        { key: 'K', text: textOf(kind, 3) },
      ]),
    )
  })

  test('one persona\'s kinds are independent: ending one kind leaves every other kind open and posted', () => {
    const ended = PERSONA_EPISODE_KINDS[0]!
    for (const kind of PERSONA_EPISODE_KINDS) episodes.begin('K', kind)
    expect(PERSONA_EPISODE_KINDS.map((kind) => episodes.post('K', kind, textOf(kind, 1)))).toEqual(
      PERSONA_EPISODE_KINDS.map(() => true),
    )

    episodes.end('K', ended)

    for (const kind of PERSONA_EPISODE_KINDS) {
      expect({ kind, open: episodes.isOpen('K', kind) }).toEqual({ kind, open: kind !== ended })
      expect({ kind, posted: episodes.post('K', kind, textOf(kind, 2)) }).toEqual({ kind, posted: false })
    }
    episodes.begin('K', ended)
    expect(episodes.post('K', ended, textOf(ended, 3))).toBe(true)
    expect(posts.map((p) => p.text)).toEqual([...PERSONA_EPISODE_KINDS.map((kind) => textOf(kind, 1)), textOf(ended, 3)])
  })

  test('forget(key) ends only that persona\'s episodes, posting nothing, and a later episode for it posts again', () => {
    for (const key of ['K', 'Q']) {
      for (const kind of PERSONA_EPISODE_KINDS) {
        episodes.begin(key, kind)
        episodes.post(key, kind, textOf(kind, 1))
      }
    }
    const before = posts.length

    episodes.forget('K')

    expect(posts).toHaveLength(before)
    expect(lines).toEqual([])
    for (const kind of PERSONA_EPISODE_KINDS) {
      expect({ kind, K: episodes.isOpen('K', kind), Q: episodes.isOpen('Q', kind) }).toEqual({ kind, K: false, Q: true })
      expect({ kind, Q: episodes.hasPosted('Q', kind) }).toEqual({ kind, Q: true })
      expect(episodes.post('Q', kind, textOf(kind, 2))).toBe(false)
      episodes.begin('K', kind)
      expect(episodes.post('K', kind, textOf(kind, 3))).toBe(true)
    }
    expect(posts.slice(before)).toEqual(PERSONA_EPISODE_KINDS.map((kind) => ({ key: 'K', text: textOf(kind, 3) })))
  })

  test('forget of a key with no episode changes nothing', () => {
    const kind = PERSONA_EPISODE_KINDS[0]
    episodes.begin('Q', kind)
    episodes.post('Q', kind, textOf(kind, 1))

    episodes.forget('K')

    expect(episodes.view('Q', kind)?.posted).toEqual([PERSONA_EPISODE_DEFAULT_MARK])
  })

  test('forgetAll() ends every persona\'s episodes, posting nothing, and later episodes post again', () => {
    const kind = PERSONA_EPISODE_KINDS[0]
    for (const key of ['K', 'Q']) {
      episodes.begin(key, kind)
      episodes.post(key, kind, textOf(kind, 1))
    }

    episodes.forgetAll()

    expect(posts).toHaveLength(2)
    expect(lines).toEqual([])
    expect([episodes.isOpen('K', kind), episodes.isOpen('Q', kind)]).toEqual([false, false])
    for (const key of ['K', 'Q']) {
      expect(episodes.begin(key, kind)).toBe('begun')
      expect(episodes.post(key, kind, textOf(kind, 2))).toBe(true)
    }
    expect(posts).toHaveLength(4)
  })

  test('two instances keep separate episodes', () => {
    const kind = PERSONA_EPISODE_KINDS[0]
    const other = build()
    episodes.begin('K', kind)
    episodes.post('K', kind, textOf(kind, 1))

    expect(other.isOpen('K', kind)).toBe(false)
    other.begin('K', kind)
    expect(other.post('K', kind, textOf(kind, 2))).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// Close steps, open keys and close()
// ---------------------------------------------------------------------------

describe('close steps (whenClosed), openKeys and close()', () => {
  const kind = PERSONA_EPISODE_KIND_CONFLICT
  const other = PERSONA_EPISODE_KIND_STUCK_LAUNCH

  test.each<[string, (e: PersonaEpisodes) => void]>([
    ['end', (e) => e.end('K', kind)],
    ['a new case in begin', (e) => e.begin('K', kind, 'case-b')],
    ['forget(key)', (e) => e.forget('K')],
    ['forgetAll()', (e) => e.forgetAll()],
    ['close()', (e) => e.close()],
  ])('a close step runs exactly once when the episode closes by %s, and never again', (_how, closeIt) => {
    let runs = 0
    episodes.begin('K', kind, 'case-a')
    expect(episodes.whenClosed('K', kind, () => runs++)).toBe(true)

    // A kept episode does not close.
    expect(episodes.begin('K', kind, 'case-a')).toBe('kept')
    expect(episodes.begin('K', kind)).toBe('kept')
    expect(runs).toBe(0)

    closeIt(episodes)
    expect(runs).toBe(1)

    // No later close path runs it again.
    episodes.begin('K', kind, 'case-c')
    episodes.end('K', kind)
    episodes.forget('K')
    episodes.forgetAll()
    episodes.close()
    expect(runs).toBe(1)
    expect(posts).toEqual([])
    expect(lines).toEqual([])
  })

  test.each<[string, (e: PersonaEpisodes) => void, readonly string[]]>([
    ['end', (e) => e.end('K', kind), ['K']],
    ['a new case in begin', (e) => e.begin('K', kind, 'case-b'), ['K']],
    // forget(key) closes every kind of the persona, so K's other kind too.
    ['forget(key)', (e) => e.forget('K'), ['K', 'K-other']],
  ])('closing by %s runs only the closed episodes\' close steps: the others stay registered', (_how, closeIt, ran) => {
    const runs: string[] = []
    episodes.begin('K', kind, 'case-a')
    episodes.begin('Q', kind, 'case-a')
    episodes.begin('K', other)
    episodes.whenClosed('Q', kind, () => runs.push('Q'))
    episodes.whenClosed('K', other, () => runs.push('K-other'))
    episodes.whenClosed('K', kind, () => runs.push('K'))

    closeIt(episodes)

    expect(runs).toEqual([...ran])
    episodes.forgetAll()
    expect([...runs].sort()).toEqual(['K', 'K-other', 'Q'])
  })

  test('whenClosed answers false and registers nothing when no episode is open, and after close()', () => {
    let runs = 0
    const count = () => {
      runs++
    }

    expect(episodes.whenClosed('K', kind, count)).toBe(false)
    // An episode of another kind, or another persona's, is not this one.
    episodes.begin('K', other)
    episodes.begin('Q', kind)
    expect(episodes.whenClosed('K', kind, count)).toBe(false)

    // The step asked for before the episode opened is not run when a later one closes.
    episodes.begin('K', kind)
    episodes.end('K', kind)
    episodes.forgetAll()
    expect(runs).toBe(0)

    episodes.close()
    expect(episodes.whenClosed('K', kind, count)).toBe(false)
    expect(runs).toBe(0)
  })

  test('a close step that throws is logged once, redacted, and every other close step still runs', () => {
    const runs: string[] = []
    episodes.begin('K', kind)
    episodes.whenClosed('K', kind, () => runs.push('first'))
    episodes.whenClosed('K', kind, () => {
      runs.push('thrower')
      throw new Error(`close refused (${sentinelInMessage('close-step')})`)
    })
    episodes.whenClosed('K', kind, () => runs.push('last'))

    expect(episodes.end('K', kind)).toBe(true)

    expect(runs).toEqual(['first', 'thrower', 'last'])
    expect(lines).toHaveLength(1)
    expect(lines[0]).toStartWith(
      `[slack] persona-episodes: persona=K ${kind} episode close step failed: Error message="close refused (${REDACTED_SENTINEL_TAIL})"`,
    )
    expect(episodes.isOpen('K', kind)).toBe(false)
  })

  test.each<[string, (e: PersonaEpisodes) => void]>([
    ['a new case in begin', (e) => e.begin('K', kind, 'case-b')],
    ['forget(key)', (e) => e.forget('K')],
    ['forgetAll()', (e) => e.forgetAll()],
    ['close()', (e) => e.close()],
  ])('a throwing close step with a throwing log breaks no close by %s', (_how, closeIt) => {
    episodes = createPersonaEpisodes({ sink: record, log: throwingLog, clock })
    let after = 0
    episodes.begin('K', kind, 'case-a')
    episodes.begin('Q', kind)
    episodes.whenClosed('K', kind, () => {
      throw new Error('close refused')
    })
    episodes.whenClosed('K', kind, () => after++)

    expect(() => closeIt(episodes)).not.toThrow()

    expect(after).toBe(1)
    expect(lines).toHaveLength(1)
    expect(lines[0]).toStartWith(`[slack] persona-episodes: persona=K ${kind} episode close step failed: Error `)
  })

  test('openKeys lists only the keys with an open episode of that kind', () => {
    for (const k of PERSONA_EPISODE_KINDS) expect({ k, keys: episodes.openKeys(k) }).toEqual({ k, keys: [] })

    episodes.begin('K', kind)
    episodes.begin('Q', kind)
    episodes.begin('R', other)

    expect([...episodes.openKeys(kind)].sort()).toEqual(['K', 'Q'])
    expect(episodes.openKeys(other)).toEqual(['R'])
    for (const k of PERSONA_EPISODE_KINDS.filter((k) => k !== kind && k !== other)) {
      expect({ k, keys: episodes.openKeys(k) }).toEqual({ k, keys: [] })
    }

    episodes.end('Q', kind)
    expect(episodes.openKeys(kind)).toEqual(['K'])
    episodes.begin('R', kind)
    episodes.forget('K')
    expect(episodes.openKeys(kind)).toEqual(['R'])
    expect(episodes.openKeys(other)).toEqual(['R'])
    episodes.end('R', other)
    expect(episodes.openKeys(other)).toEqual([])
    expect(episodes.openKeys(kind)).toEqual(['R'])
  })

  test('after close(), begin answers closed for every kind, opens nothing and posts nothing', () => {
    for (const k of PERSONA_EPISODE_KINDS) {
      episodes.begin('K', k)
      episodes.post('K', k, textOf(k, 1))
    }
    const before = posts.length

    episodes.close()

    for (const k of PERSONA_EPISODE_KINDS) {
      expect({ k, begin: episodes.begin('K', k), newCase: episodes.begin('Q', k, 'case-a') }).toEqual({
        k,
        begin: 'closed',
        newCase: 'closed',
      })
      expect({ k, open: episodes.isOpen('K', k), keys: episodes.openKeys(k) }).toEqual({ k, open: false, keys: [] })
      expect({ k, posted: episodes.post('K', k, textOf(k, 2)) }).toEqual({ k, posted: false })
      expect(episodes.view('K', k)).toBeUndefined()
    }
    expect(posts).toHaveLength(before)
    expect(lines).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// Clock
// ---------------------------------------------------------------------------

describe('start time', () => {
  test('an episode\'s start time is the clock\'s time at begin; a kept episode keeps it and a new one takes the new time', async () => {
    const kind = PERSONA_EPISODE_KINDS[0]
    expect(episodes.view('K', kind)).toBeUndefined()

    episodes.begin('K', kind)
    expect(episodes.view('K', kind)?.startedAt).toBe(START_MS)

    await clock.advance(400)
    episodes.begin('K', kind)
    expect(episodes.view('K', kind)?.startedAt).toBe(START_MS)

    episodes.end('K', kind)
    await clock.advance(600)
    episodes.begin('K', kind)
    expect(episodes.view('K', kind)?.startedAt).toBe(START_MS + 1_000)
    expect(clock.firedCount()).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// Sink failures
// ---------------------------------------------------------------------------

describe('a failing sink', () => {
  function refusal(): Error {
    const err = new Error(`post refused (${sentinelInMessage('sink')})`)
    Object.assign(err, { data: LEAK_SENTINEL })
    return err
  }

  test.each([
    ['throws', (() => { throw refusal() }) as PersonaEpisodeSink],
    ['rejects', (async () => { throw refusal() }) as PersonaEpisodeSink],
  ])('a sink that %s is logged once, redacted, and the text counts as posted', async (_how, sink) => {
    const kind = PERSONA_EPISODE_KINDS[0]
    episodes = build(sink)
    episodes.begin('K', kind)

    expect(episodes.post('K', kind, textOf(kind, 1))).toBe(true)
    await clock.flush()

    expect(lines).toHaveLength(1)
    expect(lines[0]).toStartWith(`[slack] persona-episodes: persona=K ${kind} notice failed: Error `)
    expect(lines[0]).toContain(`message="post refused (${REDACTED_SENTINEL_TAIL})"`)
    expect(episodes.hasPosted('K', kind)).toBe(true)
    expect(episodes.post('K', kind, textOf(kind, 2))).toBe(false)
    await clock.flush()
    expect(lines).toHaveLength(1)
  })

  test.each([
    ['throws', (() => { throw refusal() }) as PersonaEpisodeSink],
    ['rejects', (async () => { throw refusal() }) as PersonaEpisodeSink],
  ])('a sink that %s with a log that throws: post does not throw, no rejection escapes, and the text counts as posted', async (_how, sink) => {
    const kind = PERSONA_EPISODE_KINDS[0]
    const rejections: unknown[] = []
    const onRejection = (reason: unknown) => void rejections.push(reason)
    process.on('unhandledRejection', onRejection)
    try {
      episodes = createPersonaEpisodes({ sink, log: throwingLog, clock })
      episodes.begin('K', kind)

      expect(episodes.post('K', kind, textOf(kind, 1))).toBe(true)
      await clock.flush()
      // One macrotask turn: a rejection left unhandled is reported here.
      await new Promise((done) => setImmediate(done))

      // Named by position only: an escaped reason could hold the sentinel.
      expect(rejections.map((_, i) => `rejection ${i}`)).toEqual([])
      expect(lines).toHaveLength(1)
      expect(lines[0]).toStartWith(`[slack] persona-episodes: persona=K ${kind} notice failed: `)
      expect(episodes.hasPosted('K', kind)).toBe(true)
    } finally {
      process.off('unhandledRejection', onRejection)
    }
  })
})

/** A log that captures the line, then throws. */
function throwingLog(line: string): void {
  lines.push(line)
  throw new Error('log refused')
}

// ---------------------------------------------------------------------------
// The tmux-unresponsive condition's own rules (b.jg5 SRJ-307, SRJ-310)
// ---------------------------------------------------------------------------

describe('the tmux-unresponsive condition\'s own rules', () => {
  const KIND = PERSONA_EPISODE_KIND_TMUX_UNRESPONSIVE
  const VERB = 'read-pane'
  let hookCalls: Array<{ key: string; reading: string | undefined }>

  beforeEach(() => {
    hookCalls = []
  })

  const recordHook = (key: string, reading: string | undefined): void => {
    hookCalls.push({ key, reading })
  }

  /** A condition over `episodes`, logging to the line capture and recording each hook call unless others are given. */
  function buildCondition(
    opts: {
      log?: (line: string) => void
      conditionEnded?: (key: string, reading: string | undefined) => unknown
      episodes?: PersonaEpisodes
      healthCheckOn?: () => boolean
      alertThresholdMs?: () => number
    } = {},
  ): TmuxUnresponsiveCondition {
    return createTmuxUnresponsiveCondition({
      episodes: opts.episodes ?? episodes,
      log: opts.log ?? ((line) => lines.push(line)),
      conditionEnded: opts.conditionEnded ?? recordHook,
      ...(opts.healthCheckOn === undefined ? {} : { healthCheckOn: opts.healthCheckOn }),
      ...(opts.alertThresholdMs === undefined ? {} : { alertThresholdMs: opts.alertThresholdMs }),
    })
  }

  function startedLine(key: string, err: unknown): string {
    return `[slack] persona-episodes: persona=${key} ${KIND} started — ${VERB} failed: ${describeAgentDirectorFailure(err)}`
  }

  function endedLine(key: string, text: string): string {
    return `[slack] persona-episodes: persona=${key} ${KIND} ended — ${text}`
  }

  const THRESHOLD_MS = adAlertThresholdMs(DEFAULT_AD_SETTINGS_IN_EFFECT)

  /** `persona=<key> tmux-unresponsive <text>`: a per-persona condition line. */
  function personaLine(key: string, text: string): string {
    return `[slack] persona-episodes: persona=${key} ${KIND} ${text}`
  }

  test('start answers started, then continued with the first refusal\'s time kept; end answers ended-after-notice once the onset was posted', async () => {
    const condition = buildCondition()
    const err = errTmuxUnresponsive(VERB)

    expect(condition.start('K', VERB, err)).toBe('started')
    await clock.advance(300)
    expect(condition.start('K', VERB, errTmuxUnresponsive(VERB))).toBe('continued')
    expect(condition.firstRefusalAt('K')).toBe(START_MS)
    expect(lines).toEqual([startedLine('K', err)])

    expect(episodes.post('K', KIND, textOf(KIND, 1))).toBe(true)
    expect(condition.end('K', TMUX_UNRESPONSIVE_END_TICK, LIVENESS_LIVE)).toBe('ended-after-notice')

    expect(condition.holds('K')).toBe(false)
    expect(hookCalls).toEqual([{ key: 'K', reading: LIVENESS_LIVE }])
    expect(condition.end('K', TMUX_UNRESPONSIVE_END_TICK, LIVENESS_LIVE)).toBe('not-holding')
    expect(hookCalls).toHaveLength(1)
  })

  test('a log that throws breaks neither start nor end: both lines are attempted, the results stand and the hook is called once', () => {
    const condition = buildCondition({ log: throwingLog })
    const err = errTmuxUnresponsive(VERB)

    expect(condition.start('K', VERB, err)).toBe('started')
    expect(condition.holds('K')).toBe(true)
    expect(condition.start('K', VERB, err)).toBe('continued')
    expect(condition.end('K', TMUX_UNRESPONSIVE_END_TMUX_VERB)).toBe('ended')

    expect(condition.holds('K')).toBe(false)
    expect(lines).toEqual([startedLine('K', err), endedLine('K', TMUX_UNRESPONSIVE_END_TEXT[TMUX_UNRESPONSIVE_END_TMUX_VERB])])
    expect(hookCalls).toEqual([{ key: 'K', reading: undefined }])
  })

  test.each<[string, (e: PersonaEpisodes) => void, readonly string[]]>([
    ['forget(key)', (e) => e.forget('K'), ['K']],
    ['forgetAll()', (e) => e.forgetAll(), ['K', 'Q']],
  ])('%s drops a holding condition without calling the hook or logging an ended line; later ends answer not-holding', (_what, drop, dropped) => {
    const condition = buildCondition()
    for (const key of ['K', 'Q']) condition.start(key, VERB, errTmuxUnresponsive(VERB))
    const startedLines = [...lines]

    drop(episodes)

    for (const key of ['K', 'Q']) {
      expect({ key, holds: condition.holds(key) }).toEqual({ key, holds: !dropped.includes(key) })
    }
    expect(hookCalls).toEqual([])
    expect(lines).toEqual(startedLines)
    for (const key of dropped) {
      expect(condition.firstRefusalAt(key)).toBeUndefined()
      expect(condition.end(key, TMUX_UNRESPONSIVE_END_TICK, LIVENESS_LIVE)).toBe('not-holding')
    }
    expect(hookCalls).toEqual([])
  })

  test('a condition-end hook that throws is swallowed: end still answers, the condition is ended and its line logged', () => {
    let calls = 0
    const condition = buildCondition({
      conditionEnded: () => {
        calls++
        throw new Error('hook refused')
      },
    })
    condition.start('K', VERB, errTmuxUnresponsive(VERB))

    expect(condition.end('K', TMUX_UNRESPONSIVE_END_RETRY, LIVENESS_LIVE)).toBe('ended')

    expect(calls).toBe(1)
    expect(condition.holds('K')).toBe(false)
    expect(lines.at(-1)).toBe(endedLine('K', TMUX_UNRESPONSIVE_END_TEXT[TMUX_UNRESPONSIVE_END_RETRY]))
    expect(condition.end('K', TMUX_UNRESPONSIVE_END_RETRY, LIVENESS_LIVE)).toBe('not-holding')
    expect(calls).toBe(1)
  })

  test.each<[string, TmuxUnresponsiveEndReason, string]>([
    ...([TMUX_UNRESPONSIVE_END_TMUX_VERB, TMUX_UNRESPONSIVE_END_TICK, TMUX_UNRESPONSIVE_END_RETRY] as const).map(
      (reason) => [reason, reason, TMUX_UNRESPONSIVE_END_TEXT[reason]] as [string, TmuxUnresponsiveEndReason, string],
    ),
    // The one pinned literal: the source's text for a reason it does not name.
    ['an unknown reason', 'not-a-reason' as TmuxUnresponsiveEndReason, 'an unnamed reason'],
  ])('ending for %s logs its text on the ended line', (_what, reason, text) => {
    const condition = buildCondition()
    condition.start('K', VERB, errTmuxUnresponsive(VERB))

    expect(condition.end('K', reason)).toBe('ended')

    expect(lines.at(-1)).toBe(endedLine('K', text))
    expect(hookCalls).toEqual([{ key: 'K', reading: undefined }])
  })

  // -------------------------------------------------------------------------
  // The alert check: cancel on a retry-timer stop, re-arm, onset suppression
  // and the recovery after the alert (b.jg5 SRJ-308, SRJ-309, SRJ-310).
  // -------------------------------------------------------------------------

  describe('the alert check: cancel, re-arm and what follows the alert', () => {
    /** The non-terminal stop reason these cases cancel with. */
    const NON_TERMINAL = UNAVAILABLE_RETRY_STOP_RUN_FAILED
    const terminalStops = [...UNAVAILABLE_RETRY_TERMINAL_STOPS].map((reason) => [reason] as const)

    function cancelledLine(key: string, reason: string): string {
      return personaLine(key, `alert check cancelled — its retry timer stopped: ${reason}`)
    }

    function armedAgainLine(key: string): string {
      return personaLine(key, 'alert check armed again — a new refusal armed its retry timer again')
    }

    function onsetHeldLine(key: string): string {
      return personaLine(key, 'onset not posted — its alert already posted')
    }

    const alertPost = (key: string): Post => ({ key, text: tmuxUnresponsiveAlertText(key, THRESHOLD_MS) })
    const recoveryPost = (key: string): Post => ({ key, text: tmuxUnresponsiveRecoveryText(key) })
    const onsetPost = (key: string): Post => ({ key, text: tmuxUnresponsiveOnsetText(key) })

    /** A condition with the alert check on, at agent-director's default threshold. */
    function alerting(opts: { healthCheckOn?: () => boolean } = {}): TmuxUnresponsiveCondition {
      return buildCondition({ alertThresholdMs: () => THRESHOLD_MS, ...opts })
    }

    /** Start `key`'s condition and move the clock past the threshold, so its alert posts. */
    async function startUntilAlert(condition: TmuxUnresponsiveCondition, key = 'K'): Promise<void> {
      expect(condition.start(key, VERB, errTmuxUnresponsive(VERB))).toBe('started')
      await clock.advance(THRESHOLD_MS + 1)
      expect(posts).toContainEqual(alertPost(key))
    }

    test('a non-terminal stop cancels the pending check: one line naming the reason, true; a second cancel answers false and logs nothing; nothing posts past the threshold', async () => {
      const condition = alerting()
      condition.start('K', VERB, errTmuxUnresponsive(VERB))
      await clock.advance(1_000)
      expect(clock.pendingCount()).toBe(1)
      const before = lines.length

      expect(condition.cancelAlert('K', NON_TERMINAL)).toBe(true)

      expect(clock.pendingCount()).toBe(0)
      expect(lines.slice(before)).toEqual([cancelledLine('K', NON_TERMINAL)])
      expect(condition.cancelAlert('K', NON_TERMINAL)).toBe(false)
      expect(lines.slice(before)).toHaveLength(1)

      await clock.advance(THRESHOLD_MS * 2)
      expect(posts).toEqual([])
      expect(condition.holds('K')).toBe(true)
      expect(condition.end('K', TMUX_UNRESPONSIVE_END_TMUX_VERB)).toBe('ended')
    })

    test('after the cancel, a continued start arms the check again from the first refusal, with one line; the alert posts once the threshold has passed since it', async () => {
      const condition = alerting()
      condition.start('K', VERB, errTmuxUnresponsive(VERB))
      await clock.advance(1_000)
      condition.cancelAlert('K', NON_TERMINAL)
      await clock.advance(1_000)
      const before = lines.length

      expect(condition.start('K', VERB, errTmuxUnresponsive(VERB))).toBe('continued')

      expect(lines.slice(before)).toEqual([armedAgainLine('K')])
      expect(clock.pending().map((t) => t.dueAt)).toEqual([START_MS + THRESHOLD_MS + 1])
      // A further refusal in the episode arms nothing more.
      expect(condition.start('K', VERB, errTmuxUnresponsive(VERB))).toBe('continued')
      expect(lines.slice(before)).toHaveLength(1)
      expect(clock.pendingCount()).toBe(1)

      await clock.advanceTo(START_MS + THRESHOLD_MS)
      expect(posts).toEqual([])
      await clock.advance(1)
      expect(posts).toEqual([alertPost('K')])
      expect(lines.at(-1)).toStartWith(personaLine('K', 'alert posted — '))

      expect(condition.end('K', TMUX_UNRESPONSIVE_END_TMUX_VERB)).toBe('ended-after-notice')
    })

    test('a check armed again after the threshold has already passed since the first refusal posts at the next clock turn', async () => {
      const condition = alerting()
      condition.start('K', VERB, errTmuxUnresponsive(VERB))
      await clock.advance(1_000)
      condition.cancelAlert('K', NON_TERMINAL)
      await clock.advanceTo(START_MS + THRESHOLD_MS * 2)
      expect(posts).toEqual([])

      expect(condition.start('K', VERB, errTmuxUnresponsive(VERB))).toBe('continued')

      expect(lines.at(-1)).toBe(armedAgainLine('K'))
      expect(clock.pendingCount()).toBe(1)
      await clock.advance(1)
      expect(posts).toEqual([alertPost('K')])
      expect(clock.pendingCount()).toBe(0)

      expect(condition.end('K', TMUX_UNRESPONSIVE_END_TMUX_VERB)).toBe('ended-after-notice')
    })

    test('a cancel with no stop reason cancels the check and logs nothing; the next refusal still arms it again', () => {
      const condition = alerting()
      condition.start('K', VERB, errTmuxUnresponsive(VERB))
      const before = lines.length

      expect(condition.cancelAlert('K')).toBe(true)
      expect(lines.slice(before)).toEqual([])
      expect(clock.pendingCount()).toBe(0)

      expect(condition.start('K', VERB, errTmuxUnresponsive(VERB))).toBe('continued')
      expect(lines.slice(before)).toEqual([armedAgainLine('K')])
      expect(clock.pendingCount()).toBe(1)

      condition.end('K', TMUX_UNRESPONSIVE_END_TMUX_VERB)
    })

    test.each(terminalStops)('a terminal stop (%s) cancels the check, and a later continued start never arms it again', async (reason) => {
      const condition = alerting()
      condition.start('K', VERB, errTmuxUnresponsive(VERB))

      expect(condition.cancelAlert('K', reason)).toBe(true)
      expect(lines.at(-1)).toBe(cancelledLine('K', reason))
      const before = lines.length

      expect(condition.start('K', VERB, errTmuxUnresponsive(VERB))).toBe('continued')

      expect(lines.slice(before)).toEqual([])
      expect(clock.pendingCount()).toBe(0)
      await clock.advance(THRESHOLD_MS * 2)
      expect(posts).toEqual([])
      expect(condition.end('K', TMUX_UNRESPONSIVE_END_TMUX_VERB)).toBe('ended')
    })

    test('a cancel after the alert has posted cancels nothing: false, no line, the alert stays posted, and a later refusal arms nothing', async () => {
      const condition = alerting()
      await startUntilAlert(condition)
      const before = lines.length

      expect(condition.cancelAlert('K', NON_TERMINAL)).toBe(false)
      expect(condition.start('K', VERB, errTmuxUnresponsive(VERB))).toBe('continued')

      expect(lines.slice(before)).toEqual([])
      expect(clock.pendingCount()).toBe(0)
      expect(posts).toEqual([alertPost('K')])
      expect(condition.end('K', TMUX_UNRESPONSIVE_END_TMUX_VERB)).toBe('ended-after-notice')
      expect(posts).toEqual([alertPost('K'), recoveryPost('K')])
    })

    test('a cancel with no episode open answers false and logs nothing, before a start and after an end alike; another persona\'s check is untouched', () => {
      const condition = alerting()

      expect(condition.cancelAlert('K', NON_TERMINAL)).toBe(false)
      condition.start('Q', VERB, errTmuxUnresponsive(VERB))
      expect(condition.cancelAlert('K', NON_TERMINAL)).toBe(false)
      expect(clock.pendingCount()).toBe(1)

      condition.start('K', VERB, errTmuxUnresponsive(VERB))
      condition.end('K', TMUX_UNRESPONSIVE_END_TMUX_VERB)
      const before = lines.length
      expect(condition.cancelAlert('K', NON_TERMINAL)).toBe(false)
      expect(lines.slice(before)).toEqual([])
      expect(clock.pendingCount()).toBe(1)

      condition.end('Q', TMUX_UNRESPONSIVE_END_TMUX_VERB)
      expect(lines.some((l) => l.includes('alert check cancelled'))).toBe(false)
    })

    test.each<[string, (c: TmuxUnresponsiveCondition) => void]>([
      ['end', (c) => void c.end('K', TMUX_UNRESPONSIVE_END_TMUX_VERB)],
      ['forget(key)', () => episodes.forget('K')],
    ])('the re-arm mark is cleared when the episode closes (%s): a new episode arms normally, and its refusals arm no second check', async (_how, close) => {
      const condition = alerting()
      condition.start('K', VERB, errTmuxUnresponsive(VERB))
      condition.cancelAlert('K', NON_TERMINAL)
      close(condition)
      expect(condition.holds('K')).toBe(false)
      await clock.advance(1_000)
      const before = lines.length

      expect(condition.start('K', VERB, errTmuxUnresponsive(VERB))).toBe('started')
      expect(clock.pending().map((t) => t.dueAt)).toEqual([clock.now() + THRESHOLD_MS + 1])
      expect(condition.start('K', VERB, errTmuxUnresponsive(VERB))).toBe('continued')

      expect(lines.slice(before).filter((l) => l === armedAgainLine('K'))).toEqual([])
      expect(clock.pendingCount()).toBe(1)
      condition.end('K', TMUX_UNRESPONSIVE_END_TMUX_VERB)
    })

    test.each<[string, boolean, (c: TmuxUnresponsiveCondition, key: string) => void]>([
      ['a health tick', true, (c) => c.onsetAtTick(clock.now())],
      ['a retry', false, (c, key) => c.onsetAtRetry(key, clock.now())],
    ])('after the alert posts, the onset check at %s posts no onset and logs one line per episode', async (_where, healthOn, check) => {
      const condition = alerting({ healthCheckOn: () => healthOn })
      await startUntilAlert(condition)
      const before = lines.length

      check(condition, 'K')
      check(condition, 'K')

      expect(posts).toEqual([alertPost('K')])
      expect(lines.slice(before)).toEqual([onsetHeldLine('K')])

      // A new episode whose alert posts logs the line once again.
      condition.end('K', TMUX_UNRESPONSIVE_END_TMUX_VERB)
      posts = []
      await startUntilAlert(condition)
      const again = lines.length
      check(condition, 'K')
      check(condition, 'K')
      expect(posts).toEqual([alertPost('K')])
      expect(lines.slice(again)).toEqual([onsetHeldLine('K')])
      expect(posts).not.toContainEqual(onsetPost('K'))

      condition.end('K', TMUX_UNRESPONSIVE_END_TMUX_VERB)
    })

    test('an end after the alert alone answers ended-after-notice and posts the recovery, logging it after the ended line', async () => {
      const condition = alerting()
      await startUntilAlert(condition)

      expect(condition.end('K', TMUX_UNRESPONSIVE_END_TICK, LIVENESS_LIVE)).toBe('ended-after-notice')

      expect(posts).toEqual([alertPost('K'), recoveryPost('K')])
      expect(lines.slice(-2)).toEqual([
        endedLine('K', TMUX_UNRESPONSIVE_END_TEXT[TMUX_UNRESPONSIVE_END_TICK]),
        personaLine('K', 'recovery posted'),
      ])
      expect(hookCalls).toEqual([{ key: 'K', reading: LIVENESS_LIVE }])
    })

    test('a silent end after the alert answers ended-after-notice and posts nothing', async () => {
      const condition = alerting()
      await startUntilAlert(condition)

      expect(condition.end('K', TMUX_UNRESPONSIVE_END_TMUX_VERB, undefined, { silent: true })).toBe('ended-after-notice')

      expect(posts).toEqual([alertPost('K')])
      expect(lines.at(-1)).toBe(personaLine('K', 'recovery not posted — a silent end (a CONFLICT answer ended it)'))
      expect(condition.holds('K')).toBe(false)
      expect(hookCalls).toEqual([{ key: 'K', reading: undefined }])
    })
  })

  // -------------------------------------------------------------------------
  // The failure-only lines: each failure is logged and never throws out of
  // the entry that met it.
  // -------------------------------------------------------------------------

  describe('failure-only lines', () => {
    /** `episodes` with one member replaced, every other member the real one. */
    function episodesWith(overrides: Partial<PersonaEpisodes>): PersonaEpisodes {
      return { ...episodes, ...overrides }
    }

    function refused(what: string): Error {
      return new Error(`${what} refused (${sentinelInMessage(what)})`)
    }

    /** The redacted `describeThrownValue` head of `refused(what)`. */
    function refusedText(what: string): string {
      return `Error message="${what} refused (${REDACTED_SENTINEL_TAIL})"`
    }

    /** The fake clock, except that `clearTimeout` clears the timer and then throws. */
    function clearThenThrowClock(): PersonaEpisodesClock {
      return {
        now: () => clock.now(),
        setTimeout: (callback, delayMs) => clock.setTimeout(callback, delayMs),
        clearTimeout: (handle) => {
          clock.clearTimeout(handle)
          throw refused('clear')
        },
      }
    }

    test('a threshold accessor answering NaN: the arm throws a RangeError, logged as alert check not armed; the start still succeeds and nothing is pending', async () => {
      const condition = buildCondition({ alertThresholdMs: () => NaN })
      const err = errTmuxUnresponsive(VERB)

      expect(condition.start('K', VERB, err)).toBe('started')

      expect(condition.holds('K')).toBe(true)
      expect(clock.pendingCount()).toBe(0)
      expect(lines).toHaveLength(2)
      expect(lines[0]).toBe(startedLine('K', err))
      expect(lines[1]).toStartWith(personaLine('K', 'alert check not armed: RangeError message="'))
      expect(condition.cancelAlert('K')).toBe(false)

      // No alert ever posts, and the condition still ends normally.
      await clock.advance(THRESHOLD_MS * 2)
      expect(posts).toEqual([])
      expect(condition.end('K', TMUX_UNRESPONSIVE_END_TMUX_VERB)).toBe('ended')
      expect(lines).toHaveLength(3)
    })

    test('an alert fire whose post throws is logged as alert check failed: nothing escapes the fire, nothing is left pending and the condition holds', async () => {
      const failing = episodesWith({
        post: () => {
          throw refused('post')
        },
      })
      const condition = buildCondition({ episodes: failing, alertThresholdMs: () => THRESHOLD_MS })
      condition.start('K', VERB, errTmuxUnresponsive(VERB))
      expect(clock.pendingCount()).toBe(1)

      await clock.advance(THRESHOLD_MS + 1)

      expect(clock.pendingCount()).toBe(0)
      expect(posts).toEqual([])
      expect(lines.at(-1)).toStartWith(personaLine('K', `alert check failed: ${refusedText('post')}`))
      expect(lines.filter((l) => l.includes('alert check failed'))).toHaveLength(1)
      expect(condition.holds('K')).toBe(true)
      expect(condition.cancelAlert('K')).toBe(false)
      expect(condition.end('K', TMUX_UNRESPONSIVE_END_TMUX_VERB)).toBe('ended')
    })

    test('an alert fire whose threshold read throws is logged as alert check failed, and posts nothing', async () => {
      // The never-early wait reads the threshold at its arm and at its fire
      // (a throw there reads as never-ends, so it never fires); the third
      // read is the alert's own, at the fire, and that one throws.
      let reads = 0
      const condition = buildCondition({
        alertThresholdMs: () => {
          reads++
          if (reads >= 3) throw refused('threshold')
          return THRESHOLD_MS
        },
      })
      condition.start('K', VERB, errTmuxUnresponsive(VERB))

      await clock.advance(THRESHOLD_MS + 1)

      expect(reads).toBe(3)
      expect(clock.pendingCount()).toBe(0)
      expect(posts).toEqual([])
      expect(lines.at(-1)).toStartWith(personaLine('K', `alert check failed: ${refusedText('threshold')}`))
      expect(condition.holds('K')).toBe(true)
      condition.end('K', TMUX_UNRESPONSIVE_END_TMUX_VERB)
    })

    test('a cancel whose clock throws is logged as alert check cancel failed: cancelAlert answers false, throws nothing, and a later end runs no second cancel', async () => {
      episodes = createPersonaEpisodes({ sink: record, log: (line) => lines.push(line), clock: clearThenThrowClock() })
      const condition = buildCondition({ alertThresholdMs: () => THRESHOLD_MS })
      condition.start('K', VERB, errTmuxUnresponsive(VERB))
      expect(clock.pendingCount()).toBe(1)

      let answer: boolean | undefined
      expect(() => {
        answer = condition.cancelAlert('K')
      }).not.toThrow()

      expect(answer).toBe(false)
      expect(clock.pendingCount()).toBe(0)
      expect(lines.at(-1)).toStartWith(personaLine('K', `alert check cancel failed: ${refusedText('clear')}`))
      expect(condition.holds('K')).toBe(true)
      expect(condition.cancelAlert('K')).toBe(false)

      await clock.advance(THRESHOLD_MS * 2)
      const before = lines.length
      expect(condition.end('K', TMUX_UNRESPONSIVE_END_TMUX_VERB)).toBe('ended')
      expect(lines.slice(before)).toEqual([endedLine('K', TMUX_UNRESPONSIVE_END_TEXT[TMUX_UNRESPONSIVE_END_TMUX_VERB])])
      expect(posts).toEqual([])
    })

    test('an end whose alert-check cancel throws is logged as an episode close step failure, and the end still completes', () => {
      episodes = createPersonaEpisodes({ sink: record, log: (line) => lines.push(line), clock: clearThenThrowClock() })
      const condition = buildCondition({ alertThresholdMs: () => THRESHOLD_MS })
      condition.start('K', VERB, errTmuxUnresponsive(VERB))

      expect(condition.end('K', TMUX_UNRESPONSIVE_END_TICK, LIVENESS_LIVE)).toBe('ended')

      expect(clock.pendingCount()).toBe(0)
      expect(condition.holds('K')).toBe(false)
      expect(lines.at(-2)).toStartWith(personaLine('K', `episode close step failed: ${refusedText('clear')}`))
      expect(lines.at(-1)).toBe(endedLine('K', TMUX_UNRESPONSIVE_END_TEXT[TMUX_UNRESPONSIVE_END_TICK]))
      expect(hookCalls).toEqual([{ key: 'K', reading: LIVENESS_LIVE }])
    })

    test('a health-tick onset check that throws is logged as onset check at a health tick failed, and throws nothing', async () => {
      const failing = episodesWith({
        openKeys: () => {
          throw refused('open-keys')
        },
      })
      const condition = buildCondition({ episodes: failing })
      condition.start('K', VERB, errTmuxUnresponsive(VERB))
      await clock.advance(1)

      expect(() => condition.onsetAtTick(clock.now())).not.toThrow()

      expect(posts).toEqual([])
      expect(lines.at(-1)).toStartWith(
        `[slack] persona-episodes: ${KIND} onset check at a health tick failed: ${refusedText('open-keys')}`,
      )
      expect(condition.holds('K')).toBe(true)
    })

    test('a retry onset check that throws is logged as onset check at a retry failed, and throws nothing', () => {
      let failView = false
      const failing = episodesWith({
        view: (key, kind) => {
          if (failView) throw refused('view')
          return episodes.view(key, kind)
        },
      })
      const condition = buildCondition({ episodes: failing, healthCheckOn: () => false })
      condition.start('K', VERB, errTmuxUnresponsive(VERB))
      failView = true

      expect(() => condition.onsetAtRetry('K', START_MS + TMUX_UNRESPONSIVE_ONSET_FLOOR_MS)).not.toThrow()

      expect(posts).toEqual([])
      expect(lines.at(-1)).toStartWith(personaLine('K', `onset check at a retry failed: ${refusedText('view')}`))
      expect(condition.holds('K')).toBe(true)
    })

    test.each<[string, (c: TmuxUnresponsiveCondition) => void, readonly string[]]>([
      // Taken as on: the tick posts the onset.
      ['a health tick', (c) => c.onsetAtTick(clock.now()), ['K']],
      // Taken as on: a retry posts no onset.
      ['a retry', (c) => c.onsetAtRetry('K', clock.now()), []],
    ])('a health-check mode accessor that throws at %s is logged and taken as on', async (_where, check, onsetFor) => {
      const condition = buildCondition({
        healthCheckOn: () => {
          throw refused('mode')
        },
      })
      condition.start('K', VERB, errTmuxUnresponsive(VERB))
      await clock.advance(TMUX_UNRESPONSIVE_ONSET_FLOOR_MS)
      const before = lines.length

      expect(() => check(condition)).not.toThrow()

      const logged = lines.slice(before)
      expect(logged[0]).toStartWith(`[slack] persona-episodes: ${KIND} health-check mode read failed: ${refusedText('mode')}`)
      expect(logged[0]).toEndWith(' — taken as on')
      expect(logged).toHaveLength(1 + onsetFor.length)
      expect(posts).toEqual(onsetFor.map((key) => ({ key, text: tmuxUnresponsiveOnsetText(key) })))
      expect(condition.holds('K')).toBe(true)
    })
  })
})

// ---------------------------------------------------------------------------
// The unclassified-error episodes (b.jg5 SRJ-313, SRJ-1009, SRJ-1016)
// ---------------------------------------------------------------------------

describe('the unclassified-error episodes (b.jg5 SRJ-313, SRJ-1009)', () => {
  const KIND = PERSONA_EPISODE_KIND_UNCLASSIFIED_ERROR
  const DEFAULT_THRESHOLD_MS = adAlertThresholdMs(DEFAULT_AD_SETTINGS_IN_EFFECT)
  /** AC 80's agent-director settings (`stopping_window_seconds` 30, `starting_session_seconds` 120). */
  const AC_80_SETTINGS: AdSettingsInEffect = {
    ...DEFAULT_AD_SETTINGS_IN_EFFECT,
    tmux: { ...DEFAULT_AD_SETTINGS_IN_EFFECT.tmux, stopping_window_seconds: 30n, starting_session_seconds: 120n },
  }
  const AC_80_THRESHOLD_MS = adAlertThresholdMs(AC_80_SETTINGS)

  let logOnlyCalls: Post[]

  beforeEach(() => {
    logOnlyCalls = []
  })

  afterEach(() => {
    assertNoLeak({ logOnlyCalls })
  })

  const recordLogOnly = (key: string, text: string): void => {
    logOnlyCalls.push({ key, text })
  }

  /** Episodes over `episodes` and the line capture, at the default threshold, every key configured, unless overridden. */
  function buildUnclassified(overrides: Partial<UnclassifiedErrorEpisodesDeps> = {}): UnclassifiedErrorEpisodes {
    return createUnclassifiedErrorEpisodes({
      episodes,
      log: (line) => lines.push(line),
      alertThresholdMs: () => DEFAULT_THRESHOLD_MS,
      logOnly: recordLogOnly,
      ...overrides,
    })
  }

  /** `persona=<key> unclassified-error <text>`. */
  function personaLine(key: string, text: string): string {
    return `[slack] persona-episodes: persona=${key} ${KIND} ${text}`
  }

  function startedLine(key: string, err: unknown): string {
    return personaLine(key, `started — ${describeAdErrorClassification(classifyAdError(err))}`)
  }

  function endedLine(key: string, reason: UnclassifiedErrorEndReason): string {
    return personaLine(key, `ended — ${reason}`)
  }

  /** The `<met>` tail of an alert line: whole seconds since the first outcome and of the threshold, then the quoted classification. */
  function met(elapsedMs: number, thresholdMs: number, classification: AdErrorClassification): string {
    return `an UNCLASSIFIED outcome met ${Math.floor(elapsedMs / 1000)} s after the episode's first, over its alert threshold of ${Math.floor(thresholdMs / 1000)} s: ${describeAdErrorClassification(classification)}`
  }

  function postedLine(key: string, elapsedMs: number, thresholdMs: number, classification: AdErrorClassification): string {
    return personaLine(key, `alert posted to its destination — ${met(elapsedMs, thresholdMs, classification)}`)
  }

  function logOnlyLine(key: string, elapsedMs: number, thresholdMs: number, classification: AdErrorClassification): string {
    return personaLine(
      key,
      `alert written to the server log and startup-errors.log (${PERSONA_UNCLASSIFIED_ERROR_LABEL}) — the persona is not in the applied configuration; ${met(elapsedMs, thresholdMs, classification)}`,
    )
  }

  /** The alert as the sink receives it for `err`. */
  function alertPost(key: string, err: unknown): Post {
    return { key, text: unclassifiedErrorAlertText(classifyAdError(err)) }
  }

  /** Begin `key`'s episode now and report again just past the default threshold, so its alert posts. */
  async function untilAlert(u: UnclassifiedErrorEpisodes, key = 'K', err: unknown = errInternal()): Promise<void> {
    expect(u.report(key, errInternal())).toBe('begun')
    await clock.advance(DEFAULT_THRESHOLD_MS + 1)
    expect(u.report(key, err)).toBe('alerted')
  }

  test('the kind is declared, so it has its row in the per-kind once-per-episode table', () => {
    expect(PERSONA_EPISODE_KINDS).toContain(KIND)
  })

  // -------------------------------------------------------------------------
  // The alert rule
  // -------------------------------------------------------------------------

  test.each([
    ["agent-director's defaults", DEFAULT_THRESHOLD_MS],
    ["AC 80's settings", AC_80_THRESHOLD_MS],
  ])('at %s: a report at exactly the threshold posts nothing; the first strictly past it posts one alert quoting it; later reports post nothing', async (_settings, thresholdMs) => {
    const u = buildUnclassified({ alertThresholdMs: () => thresholdMs })
    const first = errInternal('the first outcome')
    const atThreshold = errInternal('at the threshold')
    const past = errSchemaMismatch()

    expect(u.report('K', first)).toBe('begun')
    expect(u.isOpen('K')).toBe(true)
    expect(episodes.view('K', KIND)?.startedAt).toBe(START_MS)

    await clock.advance(thresholdMs)
    expect(u.report('K', atThreshold)).toBe('continued')
    expect(posts).toEqual([])

    await clock.advance(1)
    expect(u.report('K', past)).toBe('alerted')
    expect(posts).toEqual([alertPost('K', past)])

    await clock.advance(thresholdMs * 3)
    expect([u.report('K', errInternal('later')), u.report('K', past)]).toEqual(['continued', 'continued'])

    expect(posts).toEqual([alertPost('K', past)])
    expect(logOnlyCalls).toEqual([])
    expect(lines).toEqual([startedLine('K', first), postedLine('K', thresholdMs + 1, thresholdMs, classifyAdError(past))])
  })

  test('the threshold accessor is read at each check: raising it before the old boundary holds the alert; lowering it posts at the next report', async () => {
    let thresholdMs = DEFAULT_THRESHOLD_MS
    let reads = 0
    const u = buildUnclassified({
      alertThresholdMs: () => {
        reads++
        return thresholdMs
      },
    })

    u.report('K', errInternal())
    expect(reads).toBe(0)

    thresholdMs = DEFAULT_THRESHOLD_MS * 2
    await clock.advance(DEFAULT_THRESHOLD_MS + 1)
    expect(u.report('K', errInternal())).toBe('continued')
    expect(reads).toBe(1)

    thresholdMs = AC_80_THRESHOLD_MS
    await clock.advance(1)
    expect(u.report('K', errInternal())).toBe('alerted')
    expect(reads).toBe(2)
    expect(lines.at(-1)).toBe(postedLine('K', DEFAULT_THRESHOLD_MS + 2, AC_80_THRESHOLD_MS, classifyAdError(errInternal())))

    // Once the alert is posted no check reads it again.
    u.report('K', errInternal())
    expect(reads).toBe(2)
    expect(posts).toHaveLength(1)
  })

  test('a site\'s own classification is quoted in place of the value\'s', async () => {
    const u = buildUnclassified()
    const own: AdErrorClassification = { errorClass: AD_ERROR_CLASS_UNCLASSIFIED, reportedName: 'ErrFromTheSite', message: 'the site said so' }

    expect(u.report('K', errInternal(), own)).toBe('begun')
    await clock.advance(DEFAULT_THRESHOLD_MS + 1)
    expect(u.report('K', errInternal(), own)).toBe('alerted')

    expect(lines[0]).toBe(personaLine('K', `started — ${describeAdErrorClassification(own)}`))
    expect(posts).toEqual([{ key: 'K', text: unclassifiedErrorAlertText(own) }])
  })

  // -------------------------------------------------------------------------
  // The text (SRJ-1009)
  // -------------------------------------------------------------------------

  test.each<[string, () => Error]>([
    ['ErrInternal', () => errInternal('the store could not be read')],
    ['ErrSchemaMismatch (a store that cannot be opened)', () => errSchemaMismatch()],
    ['ErrSystemInstallDisappeared', () => errSystemInstallDisappeared()],
  ])('%s: the alert quotes the classifier\'s reported name and rendered message', async (_what, make) => {
    const u = buildUnclassified()
    const err = make()
    const { reportedName, message } = classifyAdError(err)

    await untilAlert(u, 'K', err)

    expect(posts).toEqual([alertPost('K', err)])
    expect(reportedName).toBeDefined()
    expect(message).toBeDefined()
    expect(posts[0]!.text).toContain(`${reportedName} "${escapeSlackControlCharacters(message!)}"`)
  })

  test('a value whose name is unsafe (it carries a fake token) gives the text without the name and with the quoted message', async () => {
    const u = buildUnclassified()
    const unsafeName = fakeToken(BOT_TOKEN_PREFIX, 'name')
    const err = errGeneric('status', unsafeName, 'a description of the failure')
    const classification = classifyAdError(err)
    expect(classification).toEqual({ errorClass: AD_ERROR_CLASS_UNCLASSIFIED, message: 'a description of the failure' })

    await untilAlert(u, 'K', err)

    expect(posts).toEqual([{ key: 'K', text: unclassifiedErrorAlertText({ message: 'a description of the failure' }) }])
    expect(posts[0]!.text).not.toContain(unsafeName)
    // The builder leaves out a raw unsafe name given to it directly, too.
    expect(unclassifiedErrorAlertText({ reportedName: unsafeName, message: 'm' })).toBe(unclassifiedErrorAlertText({ message: 'm' }))
  })

  test('a message carrying a fake token and a URL is redacted in the alert and in every line', async () => {
    const u = buildUnclassified()
    const err = errInternal(`the store refused (${sentinelInMessage('description')})`)

    await untilAlert(u, 'K', err)

    expect(posts[0]!.text).toContain(`"${escapeSlackControlCharacters(`the store refused (${REDACTED_SENTINEL_TAIL})`)}"`)
    expect(lines.at(-1)).toContain(`message=${JSON.stringify(`the store refused (${REDACTED_SENTINEL_TAIL})`)}`)
    assertNoLeak({ posts, lines })
  })

  test('an over-long message is capped at MAX_LOGGED_MESSAGE_LENGTH in the alert', async () => {
    const u = buildUnclassified()
    const err = errInternal('a'.repeat(MAX_LOGGED_MESSAGE_LENGTH * 2))
    const { message } = classifyAdError(err)

    await untilAlert(u, 'K', err)

    expect(message).toHaveLength(MAX_LOGGED_MESSAGE_LENGTH)
    expect(posts[0]!.text).toContain(`"${message}"`)
    expect(posts[0]!.text).not.toContain('a'.repeat(MAX_LOGGED_MESSAGE_LENGTH))
  })

  test.each<[string, UnclassifiedErrorQuote, string]>([
    ['a name alone', { reportedName: 'ErrX' }, ': ErrX'],
    ['a message alone', { message: 'm' }, ': "m"'],
    ['both', { reportedName: 'ErrX', message: 'm' }, ': ErrX "m"'],
    ['an empty message', { reportedName: 'ErrX', message: '' }, ': ErrX'],
  ])('the builder with %s is the bare text with only the quote added after "persona"', (_what, quote, added) => {
    const bare = unclassifiedErrorAlertText({})
    const text = unclassifiedErrorAlertText(quote)

    expect(bare).not.toContain('"')
    expect(text.replace(added, '')).toBe(bare)
  })

  test('the builder reads a quote whose fields throw as absent', () => {
    const quote = {
      get reportedName(): string {
        throw new Error('read refused')
      },
      get message(): string {
        throw new Error('read refused')
      },
    }

    expect(unclassifiedErrorAlertText(quote)).toBe(unclassifiedErrorAlertText({}))
  })

  // -------------------------------------------------------------------------
  // Routing and Slack escaping
  // -------------------------------------------------------------------------

  /** A description carrying Slack's control sequences: a channel mention, a user mention and an ampersand. */
  const MENTIONING = 'ping <!channel> and <@U0123ABCD> & everyone'

  test('a configured key\'s alert goes to the sink only, its quoted message escaped for Slack', async () => {
    const configuredAsked: string[] = []
    const u = buildUnclassified({
      isConfigured: (key) => {
        configuredAsked.push(key)
        return true
      },
    })
    const err = errInternal(MENTIONING)

    await untilAlert(u, 'K', err)

    expect(configuredAsked).toEqual(['K'])
    expect(logOnlyCalls).toEqual([])
    expect(posts).toEqual([alertPost('K', err)])
    expect(posts[0]!.text).toContain(`"${escapeSlackControlCharacters(MENTIONING)}"`)
    expect(posts[0]!.text).toContain('&lt;!channel&gt;')
    expect(posts[0]!.text).toContain('&lt;@U0123ABCD&gt;')
    expect(posts[0]!.text).toContain('&amp; everyone')
    expect(posts[0]!.text).not.toContain('<!channel>')
    expect(posts[0]!.text).not.toContain('<@U')
  })

  test('with no configured-key lookup every key is configured', async () => {
    const u = buildUnclassified({ isConfigured: undefined })

    await untilAlert(u)

    expect(posts).toEqual([alertPost('K', errInternal())])
    expect(logOnlyCalls).toEqual([])
  })

  test('an unconfigured key\'s alert goes to the log-only route only, with the key and the unescaped text, and its line names the class label', async () => {
    const u = buildUnclassified({ isConfigured: () => false })
    const err = errInternal(MENTIONING)

    await untilAlert(u, 'K', err)

    expect(posts).toEqual([])
    expect(logOnlyCalls).toEqual([{ key: 'K', text: unclassifiedErrorAlertText(classifyAdError(err), { escapeForSlack: false }) }])
    expect(logOnlyCalls[0]!.text).toContain(`"${MENTIONING}"`)
    expect(lines.at(-1)).toBe(logOnlyLine('K', DEFAULT_THRESHOLD_MS + 1, DEFAULT_THRESHOLD_MS, classifyAdError(err)))
  })

  test('the route is decided when the alert is posted: a key removed from the applied configuration after its episode began takes the log-only route', async () => {
    let configured = true
    const u = buildUnclassified({ isConfigured: () => configured })

    u.report('K', errInternal())
    configured = false
    await clock.advance(DEFAULT_THRESHOLD_MS + 1)
    expect(u.report('K', errInternal())).toBe('alerted')

    expect(posts).toEqual([])
    expect(logOnlyCalls.map((c) => c.key)).toEqual(['K'])
  })

  test('one latch for both routes: after a log-only alert, the key configured again gets no post in the same episode', async () => {
    let configured = false
    const u = buildUnclassified({ isConfigured: () => configured })
    await untilAlert(u)

    configured = true
    await clock.advance(DEFAULT_THRESHOLD_MS)
    expect(u.report('K', errInternal())).toBe('continued')

    expect(posts).toEqual([])
    expect(logOnlyCalls).toHaveLength(1)
  })

  test('a configured-key lookup that throws is logged, redacted, and the alert takes the log-only route', async () => {
    const u = buildUnclassified({
      isConfigured: () => {
        throw new Error(`lookup refused (${sentinelInMessage('lookup')})`)
      },
    })

    await untilAlert(u)

    expect(posts).toEqual([])
    expect(logOnlyCalls).toHaveLength(1)
    const failed = lines.filter((l) => l.startsWith(personaLine('K', 'configured-key lookup failed: ')))
    expect(failed).toHaveLength(1)
    expect(failed[0]).toStartWith(personaLine('K', `configured-key lookup failed: Error message="lookup refused (${REDACTED_SENTINEL_TAIL})"`))
    expect(failed[0]).toEndWith(' — the alert takes the log-only route')
    expect(lines.at(-1)).toStartWith(personaLine('K', 'alert written to the server log'))
  })

  test('an unconfigured key with no log-only route installed: one not-routed line, nothing posted, and the alert counts as posted', async () => {
    const u = buildUnclassified({ isConfigured: () => false, logOnly: undefined })

    await untilAlert(u)
    await clock.advance(1)
    expect(u.report('K', errInternal())).toBe('continued')

    expect(posts).toEqual([])
    expect(lines.filter((l) => l.startsWith(personaLine('K', 'alert not routed — ')))).toHaveLength(1)
    expect(lines).toHaveLength(2)
  })

  test('the log-only route\'s written line is logged only after the route returns', async () => {
    const order: string[] = []
    const u = createUnclassifiedErrorEpisodes({
      episodes,
      log: (line) => order.push(line.includes(' alert written to the server log ') ? 'written line' : 'other line'),
      alertThresholdMs: () => DEFAULT_THRESHOLD_MS,
      isConfigured: () => false,
      logOnly: () => {
        order.push('logOnly entered')
        order.push('logOnly returning')
      },
    })

    await untilAlert(u)

    expect(order).toEqual(['other line', 'logOnly entered', 'logOnly returning', 'written line'])
  })

  test('a log-only route that throws is logged, redacted, in place of the written line, and the alert counts as posted', async () => {
    let calls = 0
    const u = buildUnclassified({
      isConfigured: () => false,
      logOnly: () => {
        calls++
        throw new Error(`record refused (${sentinelInMessage('record')})`)
      },
    })

    await untilAlert(u)

    expect(calls).toBe(1)
    expect(posts).toEqual([])
    expect(lines.at(-1)).toStartWith(personaLine('K', `log-only alert failed: Error message="record refused (${REDACTED_SENTINEL_TAIL})"`))
    expect(lines.filter((l) => l.includes('alert written to the server log'))).toEqual([])
    expect(lines).toHaveLength(2)

    // The latch holds: a later outcome past the threshold neither retries the route nor posts.
    await clock.advance(DEFAULT_THRESHOLD_MS + 1)
    expect(u.report('K', errInternal())).toBe('continued')

    expect(calls).toBe(1)
    expect(posts).toEqual([])
    expect(lines).toHaveLength(2)
  })

  // -------------------------------------------------------------------------
  // Ends, retry-timer stops, forget, forget-all and close
  // -------------------------------------------------------------------------

  test.each<[UnclassifiedErrorEndReason]>([
    [UNCLASSIFIED_ERROR_END_RECOVERED],
    [UNCLASSIFIED_ERROR_END_ROW_LIVE],
    [UNCLASSIFIED_ERROR_END_CAPPED],
  ])('end for "%s": one ended line, nothing posted, no state left; another persona\'s episode stays; a later report begins a new episode that alerts again', async (reason) => {
    const u = buildUnclassified()
    await untilAlert(u, 'K')
    u.report('Q', errInternal())
    const postsBefore = posts.length

    expect(u.end('K', reason)).toBe(true)

    expect(lines.at(-1)).toBe(endedLine('K', reason))
    expect(posts).toHaveLength(postsBefore)
    expect(u.isOpen('K')).toBe(false)
    expect(episodes.view('K', KIND)).toBeUndefined()
    expect(u.isOpen('Q')).toBe(true)
    const linesAfter = lines.length
    expect(u.end('K', reason)).toBe(false)
    expect(lines).toHaveLength(linesAfter)

    // A new episode alerts again; Q's alert is still its own.
    await untilAlert(u, 'K')
    expect(u.report('Q', errInternal())).toBe('alerted')
    expect(posts.map((p) => p.key)).toEqual(['K', 'K', 'Q'])
  })

  test.each<[string, UnclassifiedErrorEndReason]>([
    [UNAVAILABLE_RETRY_STOP_RECOVERED, UNCLASSIFIED_ERROR_END_RECOVERED],
    [UNAVAILABLE_RETRY_STOP_ROW_LIVE, UNCLASSIFIED_ERROR_END_ROW_LIVE],
  ])('the retry timer\'s stop "%s" ends the episode silently with its ended line', async (stop, reason) => {
    const u = buildUnclassified()
    await untilAlert(u)

    expect(u.retryStopped('K', stop)).toBe(true)

    expect(u.isOpen('K')).toBe(false)
    expect(lines.at(-1)).toBe(endedLine('K', reason))
    expect(posts).toHaveLength(1)
    expect(u.retryStopped('K', stop)).toBe(false)
  })

  test('the pending-only row-live stop\'s ended line, exactly', () => {
    const u = buildUnclassified()
    u.report('K', errInternal())

    u.retryStopped('K', UNAVAILABLE_RETRY_STOP_ROW_LIVE)

    expect(lines.at(-1)).toBe(`[slack] persona-episodes: persona=K ${KIND} ended — ${UNCLASSIFIED_ERROR_END_ROW_LIVE}`)
  })

  test.each([
    [UNAVAILABLE_RETRY_STOP_NOT_UP],
    [UNAVAILABLE_RETRY_STOP_NOT_APPLIED],
    [UNAVAILABLE_RETRY_STOP_LAUNCH_SKIPPED],
    [UNAVAILABLE_RETRY_STOP_ROW_GONE],
    [UNAVAILABLE_RETRY_STOP_CAPPED],
    [UNAVAILABLE_RETRY_STOP_TORN_DOWN],
    [UNAVAILABLE_RETRY_STOP_SHUTDOWN],
    [UNAVAILABLE_RETRY_STOP_TMUX_UNRESPONSIVE_ENDED],
    [UNAVAILABLE_RETRY_STOP_TMUX_UNAVAILABLE_CLEARED],
    [UNAVAILABLE_RETRY_STOP_RUN_FAILED],
    ['a reason no module names'],
  ])('the retry timer\'s stop "%s" leaves the episode open, with its start kept, and its alert still posts past the threshold', async (stop) => {
    const u = buildUnclassified()
    u.report('K', errInternal())
    const linesBefore = lines.length

    expect(u.retryStopped('K', stop)).toBe(false)

    expect(lines).toHaveLength(linesBefore)
    expect(u.isOpen('K')).toBe(true)
    expect(episodes.view('K', KIND)?.startedAt).toBe(START_MS)
    await clock.advance(DEFAULT_THRESHOLD_MS + 1)
    expect(u.report('K', errInternal())).toBe('alerted')
  })

  test('a retry-timer stop or an end with no episode open answers false and logs nothing', () => {
    const u = buildUnclassified()

    expect(u.retryStopped('K', UNAVAILABLE_RETRY_STOP_RECOVERED)).toBe(false)
    expect(u.end('K', UNCLASSIFIED_ERROR_END_CAPPED)).toBe(false)

    expect(lines).toEqual([])
    expect(u.isOpen('K')).toBe(false)
  })

  test.each<[string, (e: PersonaEpisodes) => void, readonly string[]]>([
    ['forget(key)', (e) => e.forget('K'), ['K']],
    ['forgetAll()', (e) => e.forgetAll(), ['K', 'Q']],
  ])('%s drops the episode with nothing posted or logged and no state left; a later report begins a new one that alerts again', async (_how, drop, dropped) => {
    const u = buildUnclassified()
    await untilAlert(u, 'K')
    await untilAlert(u, 'Q')
    const linesBefore = lines.length

    drop(episodes)

    expect(posts).toHaveLength(2)
    expect(lines).toHaveLength(linesBefore)
    for (const key of ['K', 'Q']) {
      const gone = dropped.includes(key)
      expect({ key, open: u.isOpen(key), view: episodes.view(key, KIND) === undefined }).toEqual({ key, open: !gone, view: gone })
    }
    // An episode kept is still alerted: its next report posts nothing.
    if (!dropped.includes('Q')) expect(u.report('Q', errInternal())).toBe('continued')

    await untilAlert(u, 'K')
    expect(posts.map((p) => p.key)).toEqual(['K', 'Q', 'K'])
  })

  test('after close() a report answers closed, opens nothing and logs nothing', async () => {
    const u = buildUnclassified()
    u.report('K', errInternal())
    const linesBefore = lines.length

    episodes.close()

    expect(u.isOpen('K')).toBe(false)
    expect(u.report('K', errInternal())).toBe('closed')
    await clock.advance(DEFAULT_THRESHOLD_MS + 1)
    expect(u.report('K', errInternal())).toBe('closed')
    expect(lines).toHaveLength(linesBefore)
    expect(posts).toEqual([])
  })

  // -------------------------------------------------------------------------
  // Failures never escape a report
  // -------------------------------------------------------------------------

  test.each<[string, () => Partial<UnclassifiedErrorEpisodesDeps>, string]>([
    [
      'an episodes member that throws',
      () => ({
        episodes: {
          ...episodes,
          view: () => {
            throw new Error(`view refused (${sentinelInMessage('view')})`)
          },
        },
      }),
      'view',
    ],
    [
      'a threshold accessor that throws',
      () => ({
        alertThresholdMs: () => {
          throw new Error(`threshold refused (${sentinelInMessage('threshold')})`)
        },
      }),
      'threshold',
    ],
  ])('%s: a report past the threshold throws nothing, answers continued, logs one redacted report-failed line and posts nothing', async (_what, fault, what) => {
    const u = buildUnclassified(fault())
    u.report('K', errInternal())
    await clock.advance(DEFAULT_THRESHOLD_MS + 1)
    const before = lines.length

    let answer: string | undefined
    expect(() => {
      answer = u.report('K', errInternal())
    }).not.toThrow()

    expect(answer).toBe('continued')
    expect(posts).toEqual([])
    expect(lines.slice(before)).toHaveLength(1)
    expect(lines.at(-1)).toStartWith(personaLine('K', `report failed: Error message="${what} refused (${REDACTED_SENTINEL_TAIL})"`))
  })

  test('a log that throws breaks no report: the episode begins, the alert posts and the end ends it', async () => {
    const u = buildUnclassified({ log: throwingLog })

    await untilAlert(u)
    expect(u.end('K', UNCLASSIFIED_ERROR_END_CAPPED)).toBe(true)

    expect(posts).toEqual([alertPost('K', errInternal())])
    expect(lines).toHaveLength(3)
  })
})

// ---------------------------------------------------------------------------
// b.f2b's not-connected latch is separate
// ---------------------------------------------------------------------------

describe('b.f2b\'s not-connected latch is separate', () => {
  const notice: NotConnectedNotice = { reason: 'auto-restart-disabled', cause: 'a test cause' }
  let notices: Post[]
  let serverLines: string[]
  let restoreConsole: () => void

  beforeEach(() => {
    notices = []
    serverLines = []
    setSessionNotifier((key, text) => {
      notices.push({ key, text })
    })
    const spy = spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
      serverLines.push(args.map(String).join(' '))
    })
    restoreConsole = () => spy.mockRestore()
  })

  afterEach(() => {
    restoreConsole()
    setSessionNotifier(undefined)
    _resetNotConnectedEpisodes()
    assertNoLeak({ notices, serverLines })
  })

  test('with the not-connected notice raised this episode, every kind still posts, and posting raises no not-connected latch', () => {
    expect(notifyPersonaNotConnected('K', notice)).toBe(true)

    for (const kind of PERSONA_EPISODE_KINDS) {
      episodes.begin('K', kind)
      episodes.begin('Q', kind)
      expect({ kind, K: episodes.post('K', kind, textOf(kind, 1)), Q: episodes.post('Q', kind, textOf(kind, 2)) }).toEqual({
        kind,
        K: true,
        Q: true,
      })
    }

    expect(posts).toHaveLength(PERSONA_EPISODE_KINDS.length * 2)
    // Q's kind posts left b.f2b's latch for Q unraised; K's is still raised.
    expect([notifyPersonaNotConnected('K', notice), notifyPersonaNotConnected('Q', notice)]).toEqual([false, true])
    expect(notices.map((n) => n.key)).toEqual(['K', 'Q'])
  })

  test('forgetNotConnectedEpisode ends none of the persona\'s episodes, and forget leaves its not-connected latch raised', () => {
    notifyPersonaNotConnected('K', notice)
    for (const kind of PERSONA_EPISODE_KINDS) {
      episodes.begin('K', kind)
      episodes.post('K', kind, textOf(kind, 1))
    }
    const viewsBefore = PERSONA_EPISODE_KINDS.map((kind) => episodes.view('K', kind))

    forgetNotConnectedEpisode('K')

    expect(PERSONA_EPISODE_KINDS.map((kind) => episodes.view('K', kind))).toEqual(viewsBefore)
    expect(PERSONA_EPISODE_KINDS.map((kind) => episodes.post('K', kind, textOf(kind, 2)))).toEqual(
      PERSONA_EPISODE_KINDS.map(() => false),
    )

    // The reverse: b.f2b's new episode is raised, then the latch here is forgotten and b.f2b's stays raised.
    expect(notifyPersonaNotConnected('K', notice)).toBe(true)
    episodes.forget('K')
    expect(notifyPersonaNotConnected('K', notice)).toBe(false)
    expect(posts).toHaveLength(PERSONA_EPISODE_KINDS.length)
    expect(notices.map((n) => n.key)).toEqual(['K', 'K'])
  })
})
