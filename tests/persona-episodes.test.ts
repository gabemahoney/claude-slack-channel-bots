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
 * posted. b.f2b's not-connected latch (`notConnectedNoticeRaised` in
 * `src/session-manager.ts`) is separate: neither latch raises, reads or ends
 * the other.
 *
 * Pure module under test: built over `createFakeClock`, a recording notice
 * sink and a line capture. Kinds come from `PERSONA_EPISODE_KINDS`, so a
 * later kind joins every table. `afterEach` asserts no timer is pending and
 * runs `assertNoLeak` over every captured post and line.
 */

import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test'

import {
  PERSONA_EPISODE_DEFAULT_MARK,
  PERSONA_EPISODE_KINDS,
  PERSONA_EPISODE_KIND_CONFLICT,
  PERSONA_EPISODE_KIND_STUCK_LAUNCH,
  createPersonaEpisodes,
  type PersonaEpisodeKind,
  type PersonaEpisodeSink,
  type PersonaEpisodes,
} from '../src/persona-episodes.ts'
import {
  _resetNotConnectedEpisodes,
  forgetNotConnectedEpisode,
  notifyPersonaNotConnected,
  setSessionNotifier,
  type NotConnectedNotice,
} from '../src/session-manager.ts'
import { createFakeClock, type FakeClock } from './test-helpers/fake-clock.ts'
import { LEAK_SENTINEL, REDACTED_SENTINEL_TAIL, assertNoLeak, sentinelInMessage } from './test-helpers/credentials.ts'

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

  test.each(eachKind)('one persona\'s kinds are independent: ending %s leaves every other kind open and posted', (ended) => {
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
