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
 * re-arms, and one that follows a not-up stop which already cancelled the
 * check (answering false) withdraws that stop's re-arm; a cancel after the alert posted, or with no episode open, cancels
 * nothing; a closed episode's re-arm mark does not reach the next one. Once
 * the alert has posted, neither onset check posts the onset (one line per
 * episode), and `end` answers `ended-after-notice`, posting the recovery
 * unless silent. Its onset while the retry timer is stopped (b.jg5 SRJ-305,
 * SRJ-308): every stop reported to `cancelAlert` (the cap, not up, no reason
 * at all; a pending alert check or none) holds the onset back at a tick and
 * at a retry, with one `onset not posted` line per episode, until a
 * `continued` start clears it; a terminal stop holds it for the rest of the
 * episode, a later non-terminal stop not weakening it; the alert-held line
 * takes precedence; another persona and a new episode post normally; and the
 * alert check's cancel and re-arm lines are unchanged. Each failure-only line is
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
 * latch for both routes; a key no longer applied whose teardown window is
 * open takes the teardown route while a configured key beside it posts. The
 * `ref` and `notConfiguredWording` hooks (SRJ-1007, the old-life wait's):
 * absent, `persona=<key>` and `UNCLASSIFIED_NOT_CONFIGURED_WORDING`; given,
 * every line names the hook's reference (a throwing hook the default) and the
 * log-only and not-routed lines the hook's wording, the routes still keyed
 * by the key. Ends: `end` for each reason and `retryStopped` for
 * `UNAVAILABLE_RETRY_STOP_RECOVERED`, `UNAVAILABLE_RETRY_STOP_ROW_LIVE`,
 * `UNAVAILABLE_RETRY_STOP_TMUX_UNAVAILABLE_CLEARED`,
 * `UNAVAILABLE_RETRY_STOP_TMUX_UNRESPONSIVE_ENDED` and
 * `UNAVAILABLE_RETRY_STOP_ROW_GONE` (each ended line exact; a much later
 * outcome after a condition-end or row-gone stop begins a new episode that
 * waits out its own threshold); every other stop leaves the episode open; `end`,
 * `forget`, `forgetAll` and `close` post nothing and leave another persona's
 * episode intact, and a report after them begins a new episode that alerts
 * again. A throwing episodes member, threshold accessor or log breaks no
 * report.
 *
 * The kill-failure alerts (b.jg5 SRJ-704, SRJ-1007, SRJ-1016), direct over
 * `createKillFailureAlerts` with an injected configured-key lookup and a
 * recording log-only route, the bounded retry's decisions quoting the stub's
 * descriptions and every expected text built with `src/kill-failure-alert.ts`'s
 * builders: the ordinary version posts once per episode (a second raise is
 * held), a `none` decision (a kill success while the row stays live) leaves
 * the episode open, and its silent end (row finished, row gone) or a forget
 * ends it so the next ordinary alert posts; the survivor version posts once
 * per raise with an episode open or none, leaving that state as it was and
 * not counting as the episode's alert; a configured persona gets the
 * not-latched or latched closing sentence (the survivor version always its
 * destination one); a key the lookup does not know gets one log-only call of
 * `persona-kill-failed` or `persona-kill-survivor` with the `recovery` entry,
 * nothing posted and no episode; stopped tries (b.jg5 SRJ-702) raise neither
 * version: one redacted line naming the context, the last outcome's class and
 * the stop's cause (the generic cause and no class when none is given),
 * quoting the latest survivor-naming description, and for a persona no
 * longer configured one `persona-kill-failed` entry holding that line, with
 * no alert text (a refused entry logged token-safely); each persona's
 * episode is its own; and after `close` nothing posts.
 *
 * A persona teardown (b.jg5 SRJ-1003, SRJ-704, SRJ-1013), over an injected
 * teardown query standing in for the persona notifier's
 * `teardownWindowState`: from the teardown's submit until its window opens,
 * no post or `postWithoutEpisode` of any kind reaches the sink (one muted line
 * each, a post still counting as posted), so a destructive modify's old half's
 * `tmux-unresponsive` onset at a health tick, its alert and its recovery reach
 * neither half's destination, and the kill-failure alert of either version is
 * muted too; while the window is open every post reaches the sink as given
 * (the notifier's window writes it). A query that throws reads as none, with
 * one redacted line. In the window the unclassified-error alert, for a key
 * still applied or not, goes once, unescaped, to the sink and never to the
 * log-only route (its line names `persona-teardown-notice`); a kill-failure
 * alert of every context but a start-sweep or CLI teardown kill, configured
 * or not and latched or not, is handed to the sink with no episode (the
 * survivor version with its `persona-kill-survivor` class in the options),
 * answers `logged` and is never held, and once the window closes the next
 * ordinary alert opens its episode at the destination; a start-sweep or CLI
 * teardown kill keeps its own route; a retry the teardown stopped (a
 * recovery or stuck-launch abort kill, in the open window or between the
 * submit and the turn) is no teardown notice: its stop line and, for a
 * removed persona, its `persona-kill-failed` entry with no alert text,
 * nothing handed to the sink; another persona's alert goes to its
 * destination. Muted posts name themselves: the condition's onset, alert and
 * recovery lines, the unclassified alert's and both kill-failure versions'
 * lines say "not posted — muted". Controls with no window open: the
 * unclassified alert's and the kill-failure alert's own routes, and the
 * persona-teardown context's entry built by `personaTeardownNoticeEntryText`.
 * Over the real persona notifier (`makeNotifierHarness`), wired as `main()`
 * wires them: an alert raised in its open window is one log line and one
 * `persona-teardown-notice` entry with no Slack call, and a stopped retry in
 * the same window writes no such entry.
 *
 * Per-kind counts (b.jg5 SRJ-610): `addCount` and `resetCount` answer the
 * new and the prior count, per persona and kind; a count is independent of
 * the open episode of its kind (begin, post, a new case and end leave it, and
 * adding or resetting leaves the episode); `forget` clears that persona's
 * counts of every kind and no other key's, `forgetAll` and `close` every
 * count; none of these posts or logs. The slow-recovery tracker that drives
 * the count is in `tests/slow-recovery.test.ts`.
 *
 * Close steps: `whenClosed` runs its step exactly once on every close path
 * (`end`, a new case, `forget`, `forgetAll`, `close`), answers false and
 * keeps nothing with no episode open, and a throwing step is logged
 * (`episode close step failed`) while the others still run. `openKeys` lists
 * only the kind's open keys; after `close()` every kind's `begin` answers
 * `closed` and nothing posts.
 *
 * Pure module under test: built over `createFakeClock`, a recording notice
 * sink and a line capture (the real-notifier cases over `makeNotifierHarness`
 * on its own fake clock, their persona paths and entries under a per-test
 * `mkdtempSync` directory and the harness's own temp root, both removed). Kinds come from `PERSONA_EPISODE_KINDS`, so a
 * later kind joins every table. `afterEach` asserts no timer is pending and
 * runs `assertNoLeak` over every captured post and line.
 */

import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  AD_ERROR_CLASS_UNAVAILABLE,
  AD_ERROR_CLASS_UNCLASSIFIED,
  classifyAdError,
  describeAdErrorClassification,
  describeAgentDirectorFailure,
  killFailedDescriptionOf,
  type AdErrorClassification,
} from '../src/ad-error-class.ts'
import { DEFAULT_AD_SETTINGS_IN_EFFECT, adAlertThresholdMs, type AdSettingsInEffect } from '../src/ad-settings.ts'
import type { Persona } from '../src/config.ts'
import { LIVENESS_LIVE } from '../src/liveness-reading.ts'
import {
  KILL_FAILURE_CLOSING_CLI_TEARDOWN,
  KILL_FAILURE_CLOSING_DESTINATION,
  KILL_FAILURE_CLOSING_DESTINATION_LATCHED,
  KILL_FAILURE_CLOSING_LOG_ONLY,
  KILL_FAILURE_CONTEXT_CLI_TEARDOWN,
  KILL_FAILURE_CONTEXT_OLD_LIFE_WAIT,
  KILL_FAILURE_CONTEXT_PERSONA_TEARDOWN,
  KILL_FAILURE_CONTEXT_RECOVERY,
  KILL_FAILURE_CONTEXT_START_SWEEP,
  KILL_FAILURE_CONTEXT_STUCK_LAUNCH_ABORT,
  KILL_FAILURE_ROUTE_CLI_TEARDOWN,
  KILL_FAILURE_ROUTE_NOT_CONFIGURED,
  KILL_FAILURE_ROUTE_PERSONA_TEARDOWN,
  KILL_FAILURE_ROUTE_START_SWEEP,
  KILL_FAILURE_VERSION_ORDINARY,
  KILL_FAILURE_VERSION_SURVIVOR,
  ORPHAN_CLEANUP_LABEL,
  PERSONA_KILL_FAILED_LABEL,
  PERSONA_KILL_SURVIVOR_LABEL,
  killFailureAlertEntryText,
  killFailureAlertText,
  killFailureClosingSentence,
  type KillFailureAlertContent,
  type KillFailureAlertContext,
  type KillFailureClosing,
} from '../src/kill-failure-alert.ts'
import { KILL_RETRY_ALERT_NONE, KILL_RETRY_ALERT_ORDINARY, KILL_RETRY_ALERT_SURVIVOR, type KillRetryAlert } from '../src/kill-retry.ts'
import { MAX_LOGGED_MESSAGE_LENGTH, renderLogMessageText } from '../src/persona-connection-errors.ts'
import { personaInstanceId, personaTmuxSessionName, renderPersonaRef } from '../src/persona-identity.ts'
import {
  KILL_FAILURE_END_ROW_FINISHED,
  KILL_FAILURE_END_ROW_GONE,
  PERSONA_EPISODE_DEFAULT_MARK,
  PERSONA_EPISODE_KINDS,
  PERSONA_EPISODE_KIND_CONFLICT,
  PERSONA_EPISODE_KIND_KILL_FAILURE,
  PERSONA_EPISODE_KIND_SLOW_DEAD_SESSION_RECOVERY,
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
  UNCLASSIFIED_ERROR_END_CONDITION_ENDED,
  UNCLASSIFIED_ERROR_END_RECOVERED,
  UNCLASSIFIED_ERROR_END_ROW_GONE,
  UNCLASSIFIED_ERROR_END_ROW_LIVE,
  UNCLASSIFIED_NOT_CONFIGURED_WORDING,
  createKillFailureAlerts,
  createPersonaEpisodes,
  createTmuxUnresponsiveCondition,
  createUnclassifiedErrorEpisodes,
  KILL_FAILURE_STOP_CAUSE_DEFAULT,
  killFailureStoppedRetryText,
  tmuxUnresponsiveAlertText,
  tmuxUnresponsiveOnsetText,
  tmuxUnresponsiveRecoveryText,
  unclassifiedErrorAlertText,
  type KillFailureAlerts,
  type KillFailureEndReason,
  type KillFailureRaiseInput,
  type PersonaEpisodeKind,
  type PersonaEpisodeSink,
  type PersonaEpisodeSinkOptions,
  type PersonaEpisodesClock,
  type PersonaEpisodes,
  type TmuxUnresponsiveCondition,
  type TmuxUnresponsiveEndReason,
  type UnclassifiedErrorEndReason,
  type UnclassifiedErrorEpisodes,
  type UnclassifiedErrorEpisodesDeps,
  type UnclassifiedErrorQuote,
} from '../src/persona-episodes.ts'
import {
  PERSONA_TEARDOWN_NOTICE_LABEL,
  formatPersonaNotice,
  personaTeardownNoticeEntryText,
  type PersonaTeardownWindowState,
} from '../src/persona-notifier.ts'
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
  errTmuxKillFailed,
  errTmuxUnresponsive,
  type KillFailedDescription,
} from './test-helpers/agent-director-stub.ts'
import { createFakeClock, type FakeClock } from './test-helpers/fake-clock.ts'
import { makeMultiPersonaConfig } from './test-helpers/persona-config.ts'
import { makeNotifierHarness, teardownNoticeEntry, teardownNoticeLine, type NotifierHarness } from './test-helpers/persona-notifier.ts'
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
  /** The sink's options, recorded only when the sink was given any. */
  options?: PersonaEpisodeSinkOptions
}

let clock: FakeClock
let posts: Post[]
let lines: string[]
let episodes: PersonaEpisodes
/** Where each key stands with its persona teardown, as the injected query answers it (absent: `none`). */
let teardownStates: Map<string, PersonaTeardownWindowState>

const record: PersonaEpisodeSink = (key, text, options) => {
  posts.push(options === undefined ? { key, text } : { key, text, options })
}

/** One instance over the fake clock and the line capture; the recording sink unless another is given. */
function build(sink: PersonaEpisodeSink = record): PersonaEpisodes {
  return createPersonaEpisodes({ sink, log: (line) => lines.push(line), clock })
}

/** `build()` with the persona-teardown query over `teardownStates` (production: the notifier's `teardownWindowState`). */
function buildWithTeardownQuery(): PersonaEpisodes {
  return createPersonaEpisodes({
    sink: record,
    log: (line) => lines.push(line),
    clock,
    teardownWindow: (key) => teardownStates.get(key) ?? 'none',
  })
}

/** The one line a post or a `postWithoutEpisode` logs when the key's persona teardown was submitted and its window is not open yet. */
function mutedLine(key: string, kind: PersonaEpisodeKind): string {
  return `[slack] persona-episodes: persona=${key} ${kind} notice not posted — its persona teardown was submitted (b.jg5 SRJ-1003)`
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
  teardownStates = new Map()
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
// Per-kind counts
// ---------------------------------------------------------------------------

describe('per-persona, per-kind counts (b.jg5 SRJ-610)', () => {
  const slow = PERSONA_EPISODE_KIND_SLOW_DEAD_SESSION_RECOVERY

  /** Every kind's count for `key`, in `PERSONA_EPISODE_KINDS` order. */
  const countsOf = (key: string) => PERSONA_EPISODE_KINDS.map((kind) => episodes.count(key, kind))

  /** Kind i gets i + 1 counts for K and one for Q. */
  function addEveryKind(): void {
    PERSONA_EPISODE_KINDS.forEach((kind, i) => {
      for (let n = 0; n <= i; n++) episodes.addCount('K', kind)
      episodes.addCount('Q', kind)
    })
  }

  test('a count adds and resets per persona and kind, answering the new and the prior count, and posts nothing', () => {
    expect(countsOf('K')).toEqual(PERSONA_EPISODE_KINDS.map(() => 0))
    PERSONA_EPISODE_KINDS.forEach((kind, i) => {
      const added = Array.from({ length: i + 1 }, () => episodes.addCount('K', kind))
      expect({ kind, added }).toEqual({ kind, added: added.map((_, n) => n + 1) })
      expect(episodes.addCount('Q', kind)).toBe(1)
    })
    const slowIndex = PERSONA_EPISODE_KINDS.indexOf(slow)

    expect(episodes.resetCount('K', slow)).toBe(slowIndex + 1)
    expect(episodes.resetCount('K', slow)).toBe(0)

    expect(countsOf('K')).toEqual(PERSONA_EPISODE_KINDS.map((kind, i) => (kind === slow ? 0 : i + 1)))
    expect(countsOf('Q')).toEqual(PERSONA_EPISODE_KINDS.map(() => 1))
    expect(episodes.addCount('K', slow)).toBe(1)
    expect(posts).toEqual([])
    expect(lines).toEqual([])
  })

  test('a count is independent of an open episode of its kind: begin, post, a new case and end leave it, and adding or resetting leaves the episode', () => {
    expect([episodes.addCount('K', slow), episodes.addCount('K', slow)]).toEqual([1, 2])

    expect(episodes.begin('K', slow)).toBe('begun')
    expect(episodes.post('K', slow, textOf(slow, 1))).toBe(true)
    expect(episodes.count('K', slow)).toBe(2)

    expect(episodes.addCount('K', slow)).toBe(3)
    expect(episodes.resetCount('K', slow)).toBe(3)
    expect(episodes.isOpen('K', slow)).toBe(true)
    expect(episodes.hasPosted('K', slow)).toBe(true)
    expect(episodes.post('K', slow, textOf(slow, 2))).toBe(false)

    episodes.addCount('K', slow)
    expect(episodes.begin('K', slow, 'case-a')).toBe('new-case')
    expect(episodes.count('K', slow)).toBe(1)
    expect(episodes.end('K', slow)).toBe(true)
    expect(episodes.count('K', slow)).toBe(1)

    expect(posts).toEqual([{ key: 'K', text: textOf(slow, 1) }])
    expect(lines).toEqual([])
  })

  test('forget(key) clears that persona\'s counts of every kind and leaves another key\'s, posting nothing', () => {
    addEveryKind()
    episodes.begin('Q', slow)
    episodes.post('Q', slow, textOf(slow, 1))

    episodes.forget('K')

    expect(countsOf('K')).toEqual(PERSONA_EPISODE_KINDS.map(() => 0))
    expect(countsOf('Q')).toEqual(PERSONA_EPISODE_KINDS.map(() => 1))
    expect(episodes.isOpen('Q', slow)).toBe(true)
    expect(episodes.addCount('K', slow)).toBe(1)
    expect(posts).toEqual([{ key: 'Q', text: textOf(slow, 1) }])
    expect(lines).toEqual([])
  })

  test.each([['forgetAll'], ['close']] as const)('%s() clears every persona\'s counts of every kind, posting nothing', (step) => {
    addEveryKind()

    episodes[step]()

    for (const key of ['K', 'Q']) expect({ key, counts: countsOf(key) }).toEqual({ key, counts: PERSONA_EPISODE_KINDS.map(() => 0) })
    expect(posts).toEqual([])
    expect(lines).toEqual([])
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

// ---------------------------------------------------------------------------
// A persona teardown's submit and window (b.jg5 SRJ-1003): the posts
// ---------------------------------------------------------------------------

describe('a persona teardown\'s submit and window: every kind\'s posts', () => {
  beforeEach(() => {
    episodes = buildWithTeardownQuery()
  })

  test('from the submit until the window opens, no post of any kind reaches the sink: one line each, the post still counts as posted in its episode, and another persona posts', () => {
    teardownStates.set('K', 'submitted')
    const before = posts.length

    for (const kind of PERSONA_EPISODE_KINDS) {
      episodes.begin('K', kind)
      episodes.begin('Q', kind)
      expect({ kind, K: episodes.post('K', kind, textOf(kind, 1)), Q: episodes.post('Q', kind, textOf(kind, 2)) }).toEqual({ kind, K: true, Q: true })
      expect({ kind, posted: episodes.hasPosted('K', kind), again: episodes.post('K', kind, textOf(kind, 3)) }).toEqual({ kind, posted: true, again: false })
    }

    expect(posts.slice(before)).toEqual(PERSONA_EPISODE_KINDS.map((kind) => ({ key: 'Q', text: textOf(kind, 2) })))
    expect(lines).toEqual(PERSONA_EPISODE_KINDS.map((kind) => mutedLine('K', kind)))
  })

  test('from the submit, a postWithoutEpisode of any kind, with options or none, reaches no sink: true, one line, and no episode read or begun', () => {
    teardownStates.set('K', 'submitted')
    const options: PersonaEpisodeSinkOptions = { teardownEntryClass: PERSONA_KILL_SURVIVOR_LABEL }

    for (const kind of PERSONA_EPISODE_KINDS) {
      expect({ kind, plain: episodes.postWithoutEpisode('K', kind, textOf(kind, 1)), withOptions: episodes.postWithoutEpisode('K', kind, textOf(kind, 2), options) }).toEqual({
        kind,
        plain: true,
        withOptions: true,
      })
      expect({ kind, open: episodes.isOpen('K', kind) }).toEqual({ kind, open: false })
    }

    expect(posts).toEqual([])
    expect(lines).toEqual(PERSONA_EPISODE_KINDS.flatMap((kind) => [mutedLine('K', kind), mutedLine('K', kind)]))
  })

  test('while the window is open, every kind\'s post and postWithoutEpisode reach the sink as given (the notifier\'s window writes them), options only when given, with no line', () => {
    teardownStates.set('K', 'open')
    const options: PersonaEpisodeSinkOptions = { teardownEntryClass: PERSONA_KILL_SURVIVOR_LABEL }

    for (const kind of PERSONA_EPISODE_KINDS) {
      episodes.begin('K', kind)
      expect({ kind, post: episodes.post('K', kind, textOf(kind, 1)), without: episodes.postWithoutEpisode('K', kind, textOf(kind, 2), options) }).toEqual({
        kind,
        post: true,
        without: true,
      })
    }

    expect(posts).toEqual(
      PERSONA_EPISODE_KINDS.flatMap((kind) => [
        { key: 'K', text: textOf(kind, 1) },
        { key: 'K', text: textOf(kind, 2), options },
      ]),
    )
    expect(lines).toEqual([])
  })

  test('teardownWindowState answers the query, none with no query installed or for an answer it does not know; a query that throws is logged, redacted, read as none, and the post reaches the sink', () => {
    teardownStates.set('K', 'open')
    teardownStates.set('Q', 'submitted')
    teardownStates.set('R', 'not-a-state' as PersonaTeardownWindowState)
    expect(['K', 'Q', 'R', 'S'].map((key) => episodes.teardownWindowState(key))).toEqual(['open', 'submitted', 'none', 'none'])
    expect(build().teardownWindowState('K')).toBe('none')

    const kind = PERSONA_EPISODE_KINDS[0]
    episodes = createPersonaEpisodes({
      sink: record,
      log: (line) => lines.push(line),
      clock,
      teardownWindow: () => {
        throw new Error(`query refused (${sentinelInMessage('window')})`)
      },
    })
    episodes.begin('K', kind)

    expect(episodes.post('K', kind, textOf(kind, 1))).toBe(true)

    expect(posts).toEqual([{ key: 'K', text: textOf(kind, 1) }])
    expect(lines).toHaveLength(1)
    expect(lines[0]).toStartWith(`[slack] persona-episodes: persona=K teardown window read failed: Error message="query refused (${REDACTED_SENTINEL_TAIL})"`)
    expect(lines[0]).toEndWith(' — read as none')
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

  /** The line when a stop of the persona's retry timer holds its onset back: once per episode. */
  function stoppedLine(key: string): string {
    return personaLine(key, 'onset not posted — its retry timer stopped and no refusal has re-armed it')
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

    test.each(terminalStops)('a terminal stop (%s) after a not-up stop that already cancelled the check answers false and withdraws its re-arm: a later refusal arms nothing, and past the threshold neither the alert nor the onset posts', async (reason) => {
      const condition = alerting({ healthCheckOn: () => true })
      condition.start('K', VERB, errTmuxUnresponsive(VERB))
      const before = lines.length

      expect(condition.cancelAlert('K', UNAVAILABLE_RETRY_STOP_NOT_UP)).toBe(true)
      expect(condition.cancelAlert('K', reason)).toBe(false)
      expect(condition.start('K', VERB, errTmuxUnresponsive(VERB))).toBe('continued')

      expect(clock.pendingCount()).toBe(0)
      await clock.advanceTo(START_MS + THRESHOLD_MS * 2)
      condition.onsetAtTick(clock.now())

      expect(posts).toEqual([])
      // No `alert check armed again` line: only the not-up cancel and the held onset.
      expect(lines.slice(before)).toEqual([cancelledLine('K', UNAVAILABLE_RETRY_STOP_NOT_UP), stoppedLine('K')])
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
  // The onset while the persona's retry timer is stopped (b.jg5 SRJ-305,
  // SRJ-308): every stop holds it back until a later refusal; a terminal
  // stop for the rest of the episode.
  // -------------------------------------------------------------------------

  describe('the onset while the retry timer is stopped', () => {
    const terminalStops = [...UNAVAILABLE_RETRY_TERMINAL_STOPS]
    const NON_TERMINAL_STOPS = [UNAVAILABLE_RETRY_STOP_CAPPED, UNAVAILABLE_RETRY_STOP_NOT_UP].map((reason) => [reason] as const)

    const onsetPost = (key: string): Post => ({ key, text: tmuxUnresponsiveOnsetText(key) })

    /** The two onset checks: a health tick (health check on) and a retry past the floor (health check off). */
    const checks: ReadonlyArray<readonly [string, boolean, (c: TmuxUnresponsiveCondition, key: string) => void]> = [
      ['a health tick', true, (c) => c.onsetAtTick(clock.now())],
      ['a retry', false, (c, key) => c.onsetAtRetry(key, clock.now())],
    ]

    function onsetPostedLine(key: string, where: string): string {
      return personaLine(key, `onset posted — still not answering at ${where}, `)
    }

    /** Start `key`'s condition and move the clock to the onset floor, so either check would post the onset. */
    async function startPastFloor(condition: TmuxUnresponsiveCondition, key = 'K'): Promise<void> {
      expect(condition.start(key, VERB, errTmuxUnresponsive(VERB))).toBe('started')
      await clock.advance(TMUX_UNRESPONSIVE_ONSET_FLOOR_MS)
    }

    function refuse(condition: TmuxUnresponsiveCondition, key = 'K'): void {
      expect(condition.start(key, VERB, errTmuxUnresponsive(VERB))).toBe('continued')
    }

    test.each(NON_TERMINAL_STOPS)('with the health check on, a stop (%s) with the alert check pending holds the tick\'s onset back, one line, until a refusal; the alert check\'s cancel and re-arm lines are unchanged', async (reason) => {
      const condition = buildCondition({ alertThresholdMs: () => THRESHOLD_MS, healthCheckOn: () => true })
      await startPastFloor(condition)
      const before = lines.length

      expect(condition.cancelAlert('K', reason)).toBe(true)
      condition.onsetAtTick(clock.now())
      condition.onsetAtTick(clock.now())

      expect(posts).toEqual([])
      expect(lines.slice(before)).toEqual([
        personaLine('K', `alert check cancelled — its retry timer stopped: ${reason}`),
        stoppedLine('K'),
      ])
      expect(clock.pendingCount()).toBe(0)

      refuse(condition)
      expect(lines.at(-1)).toBe(personaLine('K', 'alert check armed again — a new refusal armed its retry timer again'))
      expect(clock.pendingCount()).toBe(1)
      condition.onsetAtTick(clock.now())

      expect(posts).toEqual([onsetPost('K')])
      expect(lines.at(-1)).toStartWith(onsetPostedLine('K', 'a health tick'))
      expect(lines.filter((l) => l === stoppedLine('K'))).toHaveLength(1)
      expect(condition.end('K', TMUX_UNRESPONSIVE_END_TICK, LIVENESS_LIVE)).toBe('ended-after-notice')
    })

    test.each(NON_TERMINAL_STOPS)('with the health check off, a retry past the floor after a stop (%s) posts no onset, one line, until a refusal', async (reason) => {
      const condition = buildCondition({ healthCheckOn: () => false })
      await startPastFloor(condition)
      const before = lines.length

      condition.cancelAlert('K', reason)
      condition.onsetAtRetry('K', clock.now())
      await clock.advance(TMUX_UNRESPONSIVE_ONSET_FLOOR_MS)
      condition.onsetAtRetry('K', clock.now())

      expect(posts).toEqual([])
      expect(lines.slice(before)).toEqual([stoppedLine('K')])

      refuse(condition)
      condition.onsetAtRetry('K', clock.now())

      expect(posts).toEqual([onsetPost('K')])
      expect(lines.at(-1)).toStartWith(onsetPostedLine('K', 'a retry'))
      expect(condition.end('K', TMUX_UNRESPONSIVE_END_RETRY)).toBe('ended-after-notice')
    })

    // A cancel with no stop reason at all is a non-terminal stop, like the cap.
    test.each(
      ([UNAVAILABLE_RETRY_STOP_CAPPED, undefined] as const).flatMap((reason) =>
        checks.map(([where, healthOn, check]) => [reason ?? 'no stop reason', reason, where, healthOn, check] as const),
      ),
    )('a non-terminal stop (%s) with no alert check pending holds the onset back at %s: cancelAlert answers false, the stop itself logs nothing, one stopped line, and a refusal lets it post', async (_what, reason, where, healthOn, check) => {
      // No threshold accessor: no alert check is ever armed.
      const condition = buildCondition({ healthCheckOn: () => healthOn })
      await startPastFloor(condition)
      const before = lines.length

      expect(condition.cancelAlert('K', reason)).toBe(false)
      expect(lines.slice(before)).toEqual([])
      check(condition, 'K')
      check(condition, 'K')

      expect(posts).toEqual([])
      expect(lines.slice(before)).toEqual([stoppedLine('K')])

      refuse(condition)
      check(condition, 'K')
      expect(posts).toEqual([onsetPost('K')])
      expect(lines.at(-1)).toStartWith(onsetPostedLine('K', where))
      expect(condition.end('K', TMUX_UNRESPONSIVE_END_TMUX_VERB)).toBe('ended-after-notice')
    })

    test.each(terminalStops.flatMap((reason) => checks.map(([where, healthOn, check]) => [reason, where, healthOn, check] as const)))(
      'after a terminal stop (%s), no refusal lets the onset post at %s in the episode: one line, the alert check cancelled and never armed again',
      async (reason, _where, healthOn, check) => {
        const condition = buildCondition({ alertThresholdMs: () => THRESHOLD_MS, healthCheckOn: () => healthOn })
        await startPastFloor(condition)
        const before = lines.length

        expect(condition.cancelAlert('K', reason)).toBe(true)
        check(condition, 'K')
        refuse(condition)
        check(condition, 'K')
        refuse(condition)
        await clock.advance(TMUX_UNRESPONSIVE_ONSET_FLOOR_MS)
        check(condition, 'K')

        expect(posts).toEqual([])
        expect(clock.pendingCount()).toBe(0)
        expect(lines.slice(before)).toEqual([
          personaLine('K', `alert check cancelled — its retry timer stopped: ${reason}`),
          stoppedLine('K'),
        ])
        expect(condition.end('K', TMUX_UNRESPONSIVE_END_TMUX_VERB)).toBe('ended')
      },
    )

    test.each<[string, string | undefined]>([
      [UNAVAILABLE_RETRY_STOP_CAPPED, UNAVAILABLE_RETRY_STOP_CAPPED],
      ['no stop reason', undefined],
    ])('a terminal stop is not weakened by a later non-terminal stop (%s): a refusal still lets no onset post', async (_what, later) => {
      const condition = buildCondition()
      await startPastFloor(condition)

      condition.cancelAlert('K', UNAVAILABLE_RETRY_STOP_TORN_DOWN)
      condition.cancelAlert('K', later)
      refuse(condition)
      condition.onsetAtTick(clock.now())

      expect(posts).toEqual([])
      expect(lines.at(-1)).toBe(stoppedLine('K'))
      condition.end('K', TMUX_UNRESPONSIVE_END_TMUX_VERB)
    })

    test('the stopped line is logged once per episode, a second stop after a refusal included; a new episode logs it again', async () => {
      const condition = buildCondition()
      await startPastFloor(condition)

      condition.cancelAlert('K', UNAVAILABLE_RETRY_STOP_CAPPED)
      condition.onsetAtTick(clock.now())
      refuse(condition)
      condition.cancelAlert('K', UNAVAILABLE_RETRY_STOP_NOT_UP)
      condition.onsetAtTick(clock.now())
      condition.onsetAtTick(clock.now())

      expect(posts).toEqual([])
      expect(lines.filter((l) => l === stoppedLine('K'))).toHaveLength(1)

      condition.end('K', TMUX_UNRESPONSIVE_END_TMUX_VERB)
      await startPastFloor(condition)
      condition.cancelAlert('K', UNAVAILABLE_RETRY_STOP_CAPPED)
      condition.onsetAtTick(clock.now())
      expect(posts).toEqual([])
      expect(lines.filter((l) => l === stoppedLine('K'))).toHaveLength(2)
      condition.end('K', TMUX_UNRESPONSIVE_END_TMUX_VERB)
    })

    test.each<[string, string]>([
      [UNAVAILABLE_RETRY_STOP_CAPPED, UNAVAILABLE_RETRY_STOP_CAPPED],
      [UNAVAILABLE_RETRY_STOP_TORN_DOWN, UNAVAILABLE_RETRY_STOP_TORN_DOWN],
    ])('once the alert has posted, a later stop (%s) leaves the alert-held line in place of the stopped line', async (_what, reason) => {
      const condition = buildCondition({ alertThresholdMs: () => THRESHOLD_MS })
      condition.start('K', VERB, errTmuxUnresponsive(VERB))
      await clock.advance(THRESHOLD_MS + 1)
      expect(posts).toEqual([{ key: 'K', text: tmuxUnresponsiveAlertText('K', THRESHOLD_MS) }])
      const before = lines.length

      expect(condition.cancelAlert('K', reason)).toBe(false)
      condition.onsetAtTick(clock.now())
      condition.onsetAtTick(clock.now())

      expect(lines.slice(before)).toEqual([personaLine('K', 'onset not posted — its alert already posted')])
      expect(posts).toHaveLength(1)
      condition.end('K', TMUX_UNRESPONSIVE_END_TMUX_VERB, undefined, { silent: true })
    })

    test('a stop after the onset has posted changes nothing: no further post and no stopped line', async () => {
      const condition = buildCondition()
      await startPastFloor(condition)
      condition.onsetAtTick(clock.now())
      expect(posts).toEqual([onsetPost('K')])
      const before = lines.length

      condition.cancelAlert('K', UNAVAILABLE_RETRY_STOP_CAPPED)
      condition.onsetAtTick(clock.now())

      expect(posts).toEqual([onsetPost('K')])
      expect(lines.slice(before)).toEqual([])
      expect(condition.end('K', TMUX_UNRESPONSIVE_END_TMUX_VERB)).toBe('ended-after-notice')
    })

    test('a stop holds back only its own persona\'s onset: another persona\'s tick posts it', async () => {
      const condition = buildCondition()
      condition.start('Q', VERB, errTmuxUnresponsive(VERB))
      await startPastFloor(condition)

      condition.cancelAlert('K', UNAVAILABLE_RETRY_STOP_TORN_DOWN)
      condition.onsetAtTick(clock.now())

      expect(posts).toEqual([onsetPost('Q')])
      expect(lines).toContain(stoppedLine('K'))
      expect(lines).not.toContain(stoppedLine('Q'))
      for (const key of ['K', 'Q']) condition.end(key, TMUX_UNRESPONSIVE_END_TMUX_VERB)
    })

    test.each<[string, (c: TmuxUnresponsiveCondition) => void]>([
      ['end', (c) => void c.end('K', TMUX_UNRESPONSIVE_END_TMUX_VERB)],
      ['forget(key)', () => episodes.forget('K')],
    ])('a terminal stop\'s mark does not reach the next episode (closed by %s): its tick posts the onset; another persona\'s terminal stop still holds its own onset back', async (_how, close) => {
      const condition = buildCondition()
      condition.start('Q', VERB, errTmuxUnresponsive(VERB))
      await startPastFloor(condition)
      condition.cancelAlert('K', UNAVAILABLE_RETRY_STOP_SHUTDOWN)
      condition.cancelAlert('Q', UNAVAILABLE_RETRY_STOP_SHUTDOWN)
      close(condition)
      expect(condition.holds('K')).toBe(false)
      expect(condition.holds('Q')).toBe(true)

      // Q's mark is untouched: its tick logs the stopped line and posts nothing.
      const before = lines.length
      condition.onsetAtTick(clock.now())
      expect(posts).toEqual([])
      expect(lines.slice(before)).toEqual([stoppedLine('Q')])

      await startPastFloor(condition)
      condition.onsetAtTick(clock.now())

      expect(posts).toEqual([onsetPost('K')])
      expect(lines.at(-1)).toStartWith(onsetPostedLine('K', 'a health tick'))
      expect(lines).not.toContain(stoppedLine('K'))
      expect(lines.filter((l) => l === stoppedLine('Q'))).toHaveLength(1)
      for (const key of ['K', 'Q']) condition.end(key, TMUX_UNRESPONSIVE_END_TMUX_VERB)
    })
  })

  // -------------------------------------------------------------------------
  // A destructive modify's old half between its teardown's submit and its
  // serializer turn (b.jg5 SRJ-1003): both halves share the key, so a post
  // that reaches no sink reaches neither half's destination.
  // -------------------------------------------------------------------------

  describe('from a persona teardown\'s submit, before its turn', () => {
    const onsetPost = (key: string): Post => ({ key, text: tmuxUnresponsiveOnsetText(key) })

    beforeEach(() => {
      episodes = buildWithTeardownQuery()
    })

    test('a destructive modify\'s old half with an open condition: a health tick past the onset floor posts its onset to no destination, one muted line; another persona\'s onset at the same tick posts', async () => {
      const condition = buildCondition({ healthCheckOn: () => true })
      condition.start('Q', VERB, errTmuxUnresponsive(VERB))
      expect(condition.start('K', VERB, errTmuxUnresponsive(VERB))).toBe('started')
      await clock.advance(TMUX_UNRESPONSIVE_ONSET_FLOOR_MS)
      teardownStates.set('K', 'submitted')
      const before = lines.length

      condition.onsetAtTick(clock.now())
      condition.onsetAtTick(clock.now())

      expect(posts).toEqual([onsetPost('Q')])
      // The muted line, then the condition's own onset line saying it was not posted (it counts as posted); the second tick adds neither.
      const kLines = lines.slice(before).filter((line) => line.startsWith(personaLine('K', '')))
      expect(kLines).toHaveLength(2)
      expect(kLines[0]).toBe(mutedLine('K', KIND))
      expect(kLines[1]).toStartWith(
        personaLine('K', 'onset not posted — muted, its persona teardown was submitted; it counts as posted in its episode; still not answering at a health tick, '),
      )
      expect(lines.filter((line) => line.startsWith(personaLine('K', 'onset posted')))).toEqual([])
      // The onset counts as posted in K's episode, so no later tick posts it either.
      expect(episodes.hasPosted('K', KIND)).toBe(true)
      for (const key of ['K', 'Q']) condition.end(key, TMUX_UNRESPONSIVE_END_TMUX_VERB, undefined, { silent: true })
    })

    test('its alert past the threshold and its recovery at the end reach no destination either: one muted line each, and the condition\'s own alert and recovery lines say they were not posted', async () => {
      const condition = buildCondition({ alertThresholdMs: () => THRESHOLD_MS })
      expect(condition.start('K', VERB, errTmuxUnresponsive(VERB))).toBe('started')
      teardownStates.set('K', 'submitted')

      await clock.advance(THRESHOLD_MS + 1)
      expect(condition.end('K', TMUX_UNRESPONSIVE_END_TICK, LIVENESS_LIVE)).toBe('ended-after-notice')

      expect(posts).toEqual([])
      expect(lines.filter((line) => line === mutedLine('K', KIND))).toHaveLength(2)
      const alertLines = lines.filter((line) => line.startsWith(personaLine('K', 'alert posted')) || line.startsWith(personaLine('K', 'alert not posted')))
      expect(alertLines).toHaveLength(1)
      expect(alertLines[0]).toStartWith(
        personaLine('K', 'alert not posted — muted, its persona teardown was submitted; it counts as posted in its episode; not answering for '),
      )
      expect(alertLines[0]).toEndWith(` s, over its alert threshold of ${Math.floor(THRESHOLD_MS / 1000)} s`)
      expect(lines.filter((line) => line.startsWith(personaLine('K', 'recovery ')))).toEqual([
        personaLine('K', 'recovery not posted — muted, its persona teardown was submitted'),
      ])
      expect(clock.pendingCount()).toBe(0)
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

  /** `<ref> unclassified-error <text>`: a line naming its key by `ref`. */
  function refLine(ref: string, text: string): string {
    return `[slack] persona-episodes: ${ref} ${KIND} ${text}`
  }

  /** `persona=<key> unclassified-error <text>`: the default reference. */
  function personaLine(key: string, text: string): string {
    return refLine(`persona=${key}`, text)
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

  /** The log-only alert's line, naming why the key takes that route (`wording`; by default the episodes' not-configured wording), under `ref`. */
  function logOnlyRefLine(ref: string, elapsedMs: number, thresholdMs: number, classification: AdErrorClassification, wording = UNCLASSIFIED_NOT_CONFIGURED_WORDING): string {
    return refLine(ref, `alert written to the server log and startup-errors.log (${PERSONA_UNCLASSIFIED_ERROR_LABEL}) — ${wording}; ${met(elapsedMs, thresholdMs, classification)}`)
  }

  function logOnlyLine(key: string, elapsedMs: number, thresholdMs: number, classification: AdErrorClassification): string {
    return logOnlyRefLine(`persona=${key}`, elapsedMs, thresholdMs, classification)
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
    expect(lines.filter((l) => l.startsWith(personaLine('K', `alert not routed — ${UNCLASSIFIED_NOT_CONFIGURED_WORDING} `)))).toHaveLength(1)
    expect(lines).toHaveLength(2)
  })

  // -------------------------------------------------------------------------
  // The reference and not-configured wording hooks (b.jg5 SRJ-1007): the
  // old-life wait's episodes, keyed by a held instance id, name it as
  // `instanceId=<id>` and give their own reason for the log-only route.
  // -------------------------------------------------------------------------

  /** A reference hook's rendering, unlike the default's. */
  const instanceRef = (key: string): string => `instanceId=${key}`
  /** A wording of the episodes' own, unlike the default. */
  const OWN_WORDING = 'the row is a test\'s own old life'

  test('the hooks absent: every line names the key persona=<key>, and the log-only line gives the exported not-configured wording', async () => {
    const u = buildUnclassified({ isConfigured: () => false })
    const err = errInternal()

    await untilAlert(u, 'K', err)
    u.end('K', UNCLASSIFIED_ERROR_END_RECOVERED)

    expect(lines).toEqual([
      startedLine('K', errInternal()),
      logOnlyRefLine('persona=K', DEFAULT_THRESHOLD_MS + 1, DEFAULT_THRESHOLD_MS, classifyAdError(err), UNCLASSIFIED_NOT_CONFIGURED_WORDING),
      endedLine('K', UNCLASSIFIED_ERROR_END_RECOVERED),
    ])
  })

  test('a ref hook names the key in every line (started, log-only alert, ended), asked with the key; the log-only route and the episode stay keyed by the key itself', async () => {
    const asked: string[] = []
    const u = buildUnclassified({
      isConfigured: () => false,
      ref: (key) => {
        asked.push(key)
        return instanceRef(key)
      },
    })
    const err = errInternal()

    await untilAlert(u, 'cscb_old', err)
    expect(u.end('cscb_old', UNCLASSIFIED_ERROR_END_RECOVERED)).toBe(true)

    expect(lines).toEqual([
      refLine(instanceRef('cscb_old'), `started — ${describeAdErrorClassification(classifyAdError(errInternal()))}`),
      logOnlyRefLine(instanceRef('cscb_old'), DEFAULT_THRESHOLD_MS + 1, DEFAULT_THRESHOLD_MS, classifyAdError(err)),
      refLine(instanceRef('cscb_old'), `ended — ${UNCLASSIFIED_ERROR_END_RECOVERED}`),
    ])
    expect(lines.filter((line) => line.includes('persona=cscb_old'))).toEqual([])
    expect(new Set(asked)).toEqual(new Set(['cscb_old']))
    expect(logOnlyCalls).toEqual([{ key: 'cscb_old', text: unclassifiedErrorAlertText(classifyAdError(err), { escapeForSlack: false }) }])
    expect(posts).toEqual([])
  })

  test('a ref hook on a configured key: the posted line names it by the hook, and the post is keyed by the key', async () => {
    const u = buildUnclassified({ isConfigured: () => true, ref: instanceRef })
    const err = errInternal()

    await untilAlert(u, 'K', err)

    expect(lines.at(-1)).toBe(refLine(instanceRef('K'), `alert posted to its destination — ${met(DEFAULT_THRESHOLD_MS + 1, DEFAULT_THRESHOLD_MS, classifyAdError(err))}`))
    expect(posts).toEqual([alertPost('K', err)])
  })

  test('a ref hook that throws gives the default persona=<key> reference, and the episode goes on', async () => {
    const u = buildUnclassified({
      isConfigured: () => false,
      ref: () => {
        throw new Error(`ref refused (${sentinelInMessage('ref')})`)
      },
    })
    const err = errInternal()

    await untilAlert(u, 'K', err)

    expect(lines).toEqual([startedLine('K', errInternal()), logOnlyLine('K', DEFAULT_THRESHOLD_MS + 1, DEFAULT_THRESHOLD_MS, classifyAdError(err))])
    expect(logOnlyCalls).toHaveLength(1)
    assertNoLeak({ lines })
  })

  test('a not-configured wording hook replaces the default in the log-only alert\'s line', async () => {
    const u = buildUnclassified({ isConfigured: () => false, notConfiguredWording: OWN_WORDING })
    const err = errInternal()

    await untilAlert(u, 'K', err)

    expect(lines.at(-1)).toBe(logOnlyRefLine('persona=K', DEFAULT_THRESHOLD_MS + 1, DEFAULT_THRESHOLD_MS, classifyAdError(err), OWN_WORDING))
    expect(lines.filter((line) => line.includes(UNCLASSIFIED_NOT_CONFIGURED_WORDING))).toEqual([])
    expect(logOnlyCalls).toHaveLength(1)
  })

  test('a not-configured wording hook replaces the default in the not-routed line too (no log-only route installed)', async () => {
    const u = buildUnclassified({ isConfigured: () => false, logOnly: undefined, notConfiguredWording: OWN_WORDING })

    await untilAlert(u)

    expect(lines.filter((l) => l.startsWith(personaLine('K', `alert not routed — ${OWN_WORDING} `)))).toHaveLength(1)
    expect(lines.filter((line) => line.includes(UNCLASSIFIED_NOT_CONFIGURED_WORDING))).toEqual([])
    expect(posts).toEqual([])
  })

  test('both hooks, a configured key: the wording is never used (the alert is posted), the ref is', async () => {
    const u = buildUnclassified({ isConfigured: () => true, ref: instanceRef, notConfiguredWording: OWN_WORDING })

    await untilAlert(u)

    expect(lines.filter((line) => line.includes(OWN_WORDING))).toEqual([])
    expect(lines.every((line) => line.startsWith(refLine(instanceRef('K'), '')))).toBe(true)
    expect(posts).toHaveLength(1)
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
  // During a persona teardown (b.jg5 SRJ-1003, SRJ-1013): the alert is a
  // teardown notice, configured or not. The sink is the persona notifier,
  // whose open window writes it to the server log and a
  // persona-teardown-notice entry (tests/persona-notifier.test.ts).
  // -------------------------------------------------------------------------

  describe('during a persona teardown', () => {
    beforeEach(() => {
      episodes = buildWithTeardownQuery()
    })

    function teardownLine(key: string, elapsedMs: number, thresholdMs: number, classification: AdErrorClassification): string {
      return personaLine(
        key,
        `alert written to the server log and startup-errors.log (${PERSONA_TEARDOWN_NOTICE_LABEL}) — raised during its persona teardown; ${met(elapsedMs, thresholdMs, classification)}`,
      )
    }

    test.each([
      ['still applied (a destructive modify\'s old half)', true],
      ['no longer applied (a removal)', false],
    ])('a key %s whose window opened after its episode began: the alert goes once, unescaped, to the sink and never to the log-only route, its line naming persona-teardown-notice', async (_what, isConfigured) => {
      const u = buildUnclassified({ isConfigured: () => isConfigured })
      const err = errInternal(MENTIONING)
      expect(u.report('K', errInternal())).toBe('begun')
      teardownStates.set('K', 'open')
      await clock.advance(DEFAULT_THRESHOLD_MS + 1)

      expect(u.report('K', err)).toBe('alerted')

      expect(posts).toEqual([{ key: 'K', text: unclassifiedErrorAlertText(classifyAdError(err), { escapeForSlack: false }) }])
      expect(posts[0]!.text).toContain(`"${MENTIONING}"`)
      expect(logOnlyCalls).toEqual([])
      expect(lines.at(-1)).toBe(teardownLine('K', DEFAULT_THRESHOLD_MS + 1, DEFAULT_THRESHOLD_MS, classifyAdError(err)))
      expect(lines.filter((line) => line.includes(PERSONA_UNCLASSIFIED_ERROR_LABEL))).toEqual([])

      // One alert per episode: a later report in the window writes nothing more.
      await clock.advance(1)
      expect(u.report('K', errInternal())).toBe('continued')
      expect(posts).toHaveLength(1)
      expect(logOnlyCalls).toEqual([])
    })

    // SRJ-1003: from the submit, before the turn, a configured key's alert is
    // muted; it still counts as posted, so no later report posts it.
    test('a configured key whose teardown was submitted and whose window is not open yet: the alert reaches no sink and no log-only route; the muted line, then its own line saying it was not posted; it counts as posted in its episode', async () => {
      const u = buildUnclassified({ isConfigured: () => true })
      const err = errInternal(MENTIONING)
      expect(u.report('K', errInternal())).toBe('begun')
      teardownStates.set('K', 'submitted')
      await clock.advance(DEFAULT_THRESHOLD_MS + 1)

      expect(u.report('K', err)).toBe('alerted')

      expect(posts).toEqual([])
      expect(logOnlyCalls).toEqual([])
      expect(lines.slice(-2)).toEqual([
        mutedLine('K', KIND),
        personaLine(
          'K',
          `alert not posted to its destination — muted, its persona teardown was submitted; it counts as posted in its episode; ${met(DEFAULT_THRESHOLD_MS + 1, DEFAULT_THRESHOLD_MS, classifyAdError(err))}`,
        ),
      ])
      // Counted as posted: a later report in the episode posts nothing and logs no second muted line.
      await clock.advance(1)
      expect(u.report('K', errInternal())).toBe('continued')
      expect(posts).toEqual([])
      expect(lines.filter((line) => line === mutedLine('K', KIND))).toHaveLength(1)
    })

    test('b.jg5 SRJ-1002: R no longer applied, its window open, takes the teardown route (one persona-teardown-notice line, never the log-only route), while K configured beside it with no window still posts escaped', async () => {
      const u = buildUnclassified({ isConfigured: (key) => key === 'K' })
      const err = errInternal(MENTIONING)
      expect(u.report('R', errInternal())).toBe('begun')
      teardownStates.set('R', 'open')
      await clock.advance(DEFAULT_THRESHOLD_MS + 1)
      expect(u.report('R', err)).toBe('alerted')

      await untilAlert(u, 'K', err)

      expect(posts).toEqual([{ key: 'R', text: unclassifiedErrorAlertText(classifyAdError(err), { escapeForSlack: false }) }, alertPost('K', err)])
      expect(logOnlyCalls).toEqual([])
      expect(lines.filter((line) => line.startsWith(personaLine('R', 'alert ')))).toEqual([teardownLine('R', DEFAULT_THRESHOLD_MS + 1, DEFAULT_THRESHOLD_MS, classifyAdError(err))])
      expect(lines.filter((line) => line.startsWith(personaLine('K', 'alert ')))).toEqual([postedLine('K', DEFAULT_THRESHOLD_MS + 1, DEFAULT_THRESHOLD_MS, classifyAdError(err))])
      expect(lines.filter((line) => line.includes(PERSONA_UNCLASSIFIED_ERROR_LABEL))).toEqual([])
    })

    test('control, no window open: a configured key\'s alert is posted escaped and one no longer applied writes persona-unclassified-error, while another persona\'s window is open', async () => {
      teardownStates.set('Q', 'open')
      const u = buildUnclassified({ isConfigured: (key) => key === 'K' })
      const err = errInternal(MENTIONING)

      await untilAlert(u, 'K', err)
      await untilAlert(u, 'R', err)

      expect(posts).toEqual([alertPost('K', err)])
      expect(logOnlyCalls).toEqual([{ key: 'R', text: unclassifiedErrorAlertText(classifyAdError(err), { escapeForSlack: false }) }])
      expect(lines).toContain(postedLine('K', DEFAULT_THRESHOLD_MS + 1, DEFAULT_THRESHOLD_MS, classifyAdError(err)))
      expect(lines).toContain(logOnlyLine('R', DEFAULT_THRESHOLD_MS + 1, DEFAULT_THRESHOLD_MS, classifyAdError(err)))
      expect(lines.filter((line) => line.includes(PERSONA_TEARDOWN_NOTICE_LABEL))).toEqual([])
    })
  })

  // -------------------------------------------------------------------------
  // Ends, retry-timer stops, forget, forget-all and close
  // -------------------------------------------------------------------------

  test.each<[UnclassifiedErrorEndReason]>([
    [UNCLASSIFIED_ERROR_END_RECOVERED],
    [UNCLASSIFIED_ERROR_END_ROW_LIVE],
    [UNCLASSIFIED_ERROR_END_CONDITION_ENDED],
    [UNCLASSIFIED_ERROR_END_ROW_GONE],
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

  test.each<[string, UnclassifiedErrorEndReason, string]>([
    [UNAVAILABLE_RETRY_STOP_RECOVERED, UNCLASSIFIED_ERROR_END_RECOVERED, 'a retry found nothing left to recover'],
    [UNAVAILABLE_RETRY_STOP_ROW_LIVE, UNCLASSIFIED_ERROR_END_ROW_LIVE, 'a retry read its row live out of pending'],
    [UNAVAILABLE_RETRY_STOP_TMUX_UNAVAILABLE_CLEARED, UNCLASSIFIED_ERROR_END_CONDITION_ENDED, 'its retry timer stopped when its tmux condition ended'],
    [UNAVAILABLE_RETRY_STOP_TMUX_UNRESPONSIVE_ENDED, UNCLASSIFIED_ERROR_END_CONDITION_ENDED, 'its retry timer stopped when its tmux condition ended'],
    [UNAVAILABLE_RETRY_STOP_ROW_GONE, UNCLASSIFIED_ERROR_END_ROW_GONE, 'a retry read its row ended or gone'],
  ])('the retry timer\'s stop "%s" ends the episode silently with its ended line, exactly', async (stop, reason, text) => {
    const u = buildUnclassified()
    await untilAlert(u)

    expect(u.retryStopped('K', stop)).toBe(true)

    expect(u.isOpen('K')).toBe(false)
    expect(episodes.view('K', KIND)).toBeUndefined()
    expect<string>(reason).toBe(text)
    expect(lines.at(-1)).toBe(`[slack] persona-episodes: persona=K ${KIND} ended — ${text}`)
    expect(posts).toHaveLength(1)
    const linesAfter = lines.length
    expect(u.retryStopped('K', stop)).toBe(false)
    expect(lines).toHaveLength(linesAfter)
  })

  test.each([
    [UNAVAILABLE_RETRY_STOP_TMUX_UNAVAILABLE_CLEARED],
    [UNAVAILABLE_RETRY_STOP_TMUX_UNRESPONSIVE_ENDED],
    [UNAVAILABLE_RETRY_STOP_ROW_GONE],
  ])('after the retry timer\'s stop "%s" ends an open episode before its alert, a much later outcome begins a new episode and posts no alert until that episode\'s own threshold passes', async (stop) => {
    const u = buildUnclassified()
    expect(u.report('K', errInternal())).toBe('begun')
    expect(u.retryStopped('K', stop)).toBe(true)

    await clock.advance(DEFAULT_THRESHOLD_MS * 5)
    const laterStart = clock.now()
    expect(u.report('K', errInternal())).toBe('begun')

    expect(posts).toEqual([])
    expect(logOnlyCalls).toEqual([])
    expect(episodes.view('K', KIND)?.startedAt).toBe(laterStart)
    expect(lines.at(-1)).toBe(startedLine('K', errInternal()))

    await clock.advance(DEFAULT_THRESHOLD_MS)
    expect(u.report('K', errInternal())).toBe('continued')
    expect(posts).toEqual([])

    await clock.advance(1)
    expect(u.report('K', errInternal())).toBe('alerted')
    expect(posts).toEqual([alertPost('K', errInternal())])
  })

  test.each([
    [UNAVAILABLE_RETRY_STOP_NOT_UP],
    [UNAVAILABLE_RETRY_STOP_NOT_APPLIED],
    [UNAVAILABLE_RETRY_STOP_LAUNCH_SKIPPED],
    [UNAVAILABLE_RETRY_STOP_RUN_FAILED],
    [UNAVAILABLE_RETRY_STOP_CAPPED],
    [UNAVAILABLE_RETRY_STOP_TORN_DOWN],
    [UNAVAILABLE_RETRY_STOP_SHUTDOWN],
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
// The kill-failure alerts (b.jg5 SRJ-704, SRJ-1007, SRJ-1016)
// ---------------------------------------------------------------------------

describe('the kill-failure alerts (b.jg5 SRJ-704, SRJ-1007, SRJ-1016)', () => {
  const KIND = PERSONA_EPISODE_KIND_KILL_FAILURE

  /** The keys the injected configured-key lookup knows. */
  let configured: Set<string>
  /** Every log-only route call, in order: the class and the entry. */
  let logOnlyCalls: Array<{ classLabel: string; entry: string }>

  beforeEach(() => {
    configured = new Set(['K', 'Q'])
    logOnlyCalls = []
  })

  afterEach(() => {
    assertNoLeak({ logOnlyCalls })
  })

  /** Alerts over `episodes` and the line capture, the lookup over `configured`, the log-only route recorded. */
  function buildAlerts(): KillFailureAlerts {
    return createKillFailureAlerts({
      episodes,
      log: (line) => lines.push(line),
      isConfigured: (key) => configured.has(key),
      logOnly: (classLabel, entry) => {
        logOnlyCalls.push({ classLabel, entry })
      },
    })
  }

  /** The stub's raw `ErrTmuxKillFailed` description of `form`, a fake token in its quoted session. */
  function description(form: KillFailedDescription): string {
    return killFailedDescriptionOf(errTmuxKillFailed(sentinelInMessage(`episodes-${form}`), form))!
  }

  /** The bounded retry's ordinary decision quoting `form`'s description. */
  function ordinary(form: KillFailedDescription = 'outlived-exit-wait'): KillRetryAlert {
    return { kind: KILL_RETRY_ALERT_ORDINARY, lastKillFailedDescription: description(form) }
  }

  /** The bounded retry's survivor decision quoting the survivor-naming description. */
  function survivor(): KillRetryAlert {
    return { kind: KILL_RETRY_ALERT_SURVIVOR, survivorDescription: description('pane-process-survived') }
  }

  /** What `decision` says for persona `key`'s own row, as the alerts build it. */
  function contentOf(key: string, decision: KillRetryAlert): KillFailureAlertContent {
    if (decision.kind === KILL_RETRY_ALERT_SURVIVOR) {
      return { version: KILL_FAILURE_VERSION_SURVIVOR, session: personaTmuxSessionName(key), survivorDescription: decision.survivorDescription }
    }
    if (decision.kind !== KILL_RETRY_ALERT_ORDINARY) throw new Error('no content for a none decision')
    const quotes = {
      ...(decision.lastKillFailedDescription === undefined ? {} : { lastKillFailedDescription: decision.lastKillFailedDescription }),
      ...(decision.earlierSurvivorDescription === undefined ? {} : { earlierSurvivorDescription: decision.earlierSurvivorDescription }),
    }
    return { version: KILL_FAILURE_VERSION_ORDINARY, session: personaTmuxSessionName(key), instanceId: personaInstanceId(key), quotes }
  }

  /** The post at persona `key`'s destination for `decision`, with `closing`. */
  function destinationPost(key: string, decision: KillRetryAlert, closing: KillFailureClosing = KILL_FAILURE_CLOSING_DESTINATION): Post {
    return { key, text: killFailureAlertText(contentOf(key, decision), closing, true) }
  }

  /** What a raise may add: latched, and a stopped retry's flag, last outcome's class and stop cause. */
  type RaiseExtra = { latched?: boolean; stopped?: boolean; lastOutcomeClass?: string; stopCause?: string }

  /** The raise's input for persona `key` of `decision` in `context`, not latched and not stopped unless said. */
  function raiseInput(key: string, decision: KillRetryAlert, context: KillFailureAlertContext, extra: RaiseExtra): KillFailureRaiseInput {
    return {
      key,
      decision,
      latched: extra.latched ?? false,
      context,
      ...(extra.stopped === undefined ? {} : { stopped: extra.stopped }),
      ...(extra.lastOutcomeClass === undefined ? {} : { lastOutcomeClass: extra.lastOutcomeClass }),
      ...(extra.stopCause === undefined ? {} : { stopCause: extra.stopCause }),
    }
  }

  /** A raise for persona `key` of `decision` at the restart path (context `recovery`), not latched unless said. */
  function raise(alerts: KillFailureAlerts, key: string, decision: KillRetryAlert, extra: RaiseExtra = {}): string {
    return alerts.raise(raiseInput(key, decision, KILL_FAILURE_CONTEXT_RECOVERY, extra))
  }

  // A stopped retry's record (b.jg5 SRJ-702): built by
  // `killFailureStoppedRetryText`, whose fixed words are pinned once below.
  /** The class and cause a stopped raise in these cases names. */
  const STOP: RaiseExtra = { stopped: true, lastOutcomeClass: AD_ERROR_CLASS_UNAVAILABLE, stopCause: 'its teardown began between its tries' }

  /** The stopped-retry line and entry text for persona `key` of `decision` in `context`, with `extra`'s class and cause. */
  function stoppedText(key: string, decision: KillRetryAlert, context: KillFailureAlertContext, extra: RaiseExtra): { line: string; entry: string } {
    return killFailureStoppedRetryText({
      key,
      decision,
      context,
      ...(extra.lastOutcomeClass === undefined ? {} : { lastOutcomeClass: extra.lastOutcomeClass }),
      ...(extra.stopCause === undefined ? {} : { stopCause: extra.stopCause }),
    })
  }

  /** The one line of a stopped raise for persona `key` in `context`. */
  function stoppedLine(key: string, decision: KillRetryAlert, context: KillFailureAlertContext = KILL_FAILURE_CONTEXT_RECOVERY, extra: RaiseExtra = STOP): string {
    return stoppedText(key, decision, context, extra).line
  }

  /** The `persona-kill-failed` entry of a stopped raise for persona `key` no longer configured: the line's content, no alert text. */
  function stoppedEntry(key: string, decision: KillRetryAlert, context: KillFailureAlertContext = KILL_FAILURE_CONTEXT_RECOVERY, extra: RaiseExtra = STOP): { classLabel: string; entry: string } {
    return { classLabel: PERSONA_KILL_FAILED_LABEL, entry: stoppedText(key, decision, context, extra).entry }
  }

  /** The line written after a stopped raise's entry. */
  function stoppedEntryLine(key: string): string {
    return `[slack] persona-episodes: persona=${key} ${KIND} stopped retry's log line (no alert text) written to the server log and startup-errors.log (${PERSONA_KILL_FAILED_LABEL}) — stopped`
  }

  /** No alert text of either version in `entry`: neither version's text nor any closing sentence. */
  function expectNoAlertText(key: string, entry: string, decision: KillRetryAlert): void {
    expect(entry).not.toContain(killFailureAlertText(contentOf(key, decision), KILL_FAILURE_CLOSING_LOG_ONLY, false))
    for (const version of [KILL_FAILURE_VERSION_ORDINARY, KILL_FAILURE_VERSION_SURVIVOR] as const) {
      for (const closing of [KILL_FAILURE_CLOSING_LOG_ONLY, KILL_FAILURE_CLOSING_DESTINATION, KILL_FAILURE_CLOSING_DESTINATION_LATCHED, KILL_FAILURE_CLOSING_CLI_TEARDOWN] as const) {
        expect(entry).not.toContain(killFailureClosingSentence(version, closing))
      }
    }
  }

  /** Persona `key`'s kill-failure lines. */
  const killLines = (key: string): string[] => lines.filter((line) => line.startsWith(`[slack] persona-episodes: persona=${key} ${KIND} `))

  test('two ordinary alerts in one episode post once: the second is held; the episode is open', () => {
    const alerts = buildAlerts()
    const first = ordinary()

    expect(raise(alerts, 'K', first)).toBe('posted')
    expect(raise(alerts, 'K', ordinary('unverifiable-session-present'))).toBe('held')

    expect(posts).toEqual([destinationPost('K', first)])
    expect(alerts.isOpen('K')).toBe(true)
    expect(killLines('K')).toEqual([
      `[slack] persona-episodes: persona=K ${KIND} ordinary alert posted to its destination (${KILL_FAILURE_CONTEXT_RECOVERY}; ${KILL_FAILURE_CLOSING_DESTINATION})`,
      `[slack] persona-episodes: persona=K ${KIND} ordinary alert not posted — its episode's alert already posted`,
    ])
  })

  test('a kill success while the row stays live (a none decision) does nothing: the episode stays open and the next ordinary alert is held', () => {
    const alerts = buildAlerts()
    raise(alerts, 'K', ordinary())

    expect(raise(alerts, 'K', { kind: KILL_RETRY_ALERT_NONE })).toBe('none')

    expect(alerts.isOpen('K')).toBe(true)
    expect(raise(alerts, 'K', ordinary())).toBe('held')
    expect(posts).toHaveLength(1)
  })

  test.each<KillFailureEndReason>([KILL_FAILURE_END_ROW_FINISHED, KILL_FAILURE_END_ROW_GONE])('the silent end (%s) ends the episode with one ended line and no post; the next ordinary alert posts again', (reason) => {
    const alerts = buildAlerts()
    raise(alerts, 'K', ordinary())

    expect(alerts.end('K', reason)).toBe(true)

    expect(alerts.isOpen('K')).toBe(false)
    expect(posts).toHaveLength(1)
    expect(killLines('K').at(-1)).toBe(`[slack] persona-episodes: persona=K ${KIND} ended — ${reason}`)
    expect(alerts.end('K', reason)).toBe(false)
    expect(killLines('K')).toHaveLength(2)

    const next = ordinary('no-session-no-kill')
    expect(raise(alerts, 'K', next)).toBe('posted')
    expect(posts).toEqual([destinationPost('K', ordinary()), destinationPost('K', next)])
  })

  test('a teardown\'s forget ends the episode silently; the next ordinary alert posts again', () => {
    const alerts = buildAlerts()
    raise(alerts, 'K', ordinary())

    episodes.forget('K')

    expect(alerts.isOpen('K')).toBe(false)
    expect(raise(alerts, 'K', ordinary())).toBe('posted')
    expect(posts).toHaveLength(2)
  })

  // b.jg5 SRJ-704, SRJ-1016: the survivor version opens no episode, neither
  // begins nor ends one, is not held back by an open one and does not count as
  // the episode's alert.
  test.each([false, true])('a survivor version with an ordinary episode open %p: posted once per raise, the open or closed state unchanged, and not the episode\'s alert', (open) => {
    const alerts = buildAlerts()
    const first = ordinary()
    if (open) raise(alerts, 'K', first)

    expect(raise(alerts, 'K', survivor())).toBe('posted')
    expect(alerts.isOpen('K')).toBe(open)
    expect(raise(alerts, 'K', survivor())).toBe('posted')
    expect(alerts.isOpen('K')).toBe(open)

    // The episode's own alert: held when it already posted, posted when none was open.
    expect(raise(alerts, 'K', first)).toBe(open ? 'held' : 'posted')
    const survivorPost = destinationPost('K', survivor())
    expect(posts).toEqual(open ? [destinationPost('K', first), survivorPost, survivorPost] : [survivorPost, survivorPost, destinationPost('K', first)])
    expect(killLines('K').filter((line) => line.includes(' survivor alert posted to its destination ('))).toHaveLength(2)
  })

  test.each<[string, boolean, KillFailureClosing]>([
    ['not latched', false, KILL_FAILURE_CLOSING_DESTINATION],
    ['latched', true, KILL_FAILURE_CLOSING_DESTINATION_LATCHED],
  ])('a configured persona, %s: the ordinary version at its destination with that closing sentence; the survivor version always with its destination sentence', (_label, latched, closing) => {
    const alerts = buildAlerts()

    expect(raise(alerts, 'K', ordinary(), { latched })).toBe('posted')
    expect(raise(alerts, 'K', survivor(), { latched })).toBe('posted')

    expect(posts).toEqual([destinationPost('K', ordinary(), closing), destinationPost('K', survivor())])
    expect(logOnlyCalls).toEqual([])
  })

  // b.jg5 SRJ-704, SRJ-1013: a key the lookup does not know takes the
  // not-configured route: one entry (its writer writes the server-log line),
  // nothing posted, no episode.
  test.each<[string, () => KillRetryAlert, string]>([
    ['ordinary', () => ordinary(), PERSONA_KILL_FAILED_LABEL],
    ['survivor', () => survivor(), PERSONA_KILL_SURVIVOR_LABEL],
  ])('a key not in the applied configuration, %s version: one log-only call of its class with the recovery entry, one line, nothing posted, no episode', (version, decision, classLabel) => {
    const alerts = buildAlerts()
    configured.delete('K')

    expect(raise(alerts, 'K', decision())).toBe('logged')

    const text = killFailureAlertText(contentOf('K', decision()), KILL_FAILURE_CLOSING_LOG_ONLY, false)
    expect(logOnlyCalls).toEqual([{ classLabel, entry: killFailureAlertEntryText('persona=K', KILL_FAILURE_CONTEXT_RECOVERY, text) }])
    expect(posts).toEqual([])
    expect(alerts.isOpen('K')).toBe(false)
    expect(killLines('K')).toEqual([
      `[slack] persona-episodes: persona=K ${KIND} ${version} alert written to the server log and startup-errors.log (${classLabel}) — ${KILL_FAILURE_ROUTE_NOT_CONFIGURED}`,
    ])
  })

  // b.jg5 SRJ-702, SRJ-1013: a retry whose tries were stopped is no notice:
  // neither version is raised, nothing is posted and no episode opens. One
  // line names the persona, the context, the last outcome's class, the stop's
  // cause and the redacted descriptions; a persona no longer configured also
  // gets one persona-kill-failed entry holding that line's content, with no
  // alert text; a configured persona's stop writes the line only.
  test.each<[string, RaiseExtra]>([
    ['with its last outcome\'s class and its cause', STOP],
    ['with neither (the generic cause, no class)', { stopped: true }],
  ])('stopped tries %s: a configured persona gets the one line only; one no longer configured gets the line and one persona-kill-failed entry holding it, with no alert text; both answer stopped, nothing posted, no episode', (_label, extra) => {
    const alerts = buildAlerts()
    configured.delete('Q')

    expect([raise(alerts, 'K', ordinary(), extra), raise(alerts, 'Q', ordinary(), extra)]).toEqual(['stopped', 'stopped'])

    expect(killLines('K')).toEqual([stoppedLine('K', ordinary(), KILL_FAILURE_CONTEXT_RECOVERY, extra)])
    expect(killLines('K')[0]).toContain(JSON.stringify(renderLogMessageText(description('outlived-exit-wait'))))
    expect(killLines('K')[0]).toContain(REDACTED_SENTINEL_TAIL)
    expect(killLines('Q')).toEqual([stoppedLine('Q', ordinary(), KILL_FAILURE_CONTEXT_RECOVERY, extra), stoppedEntryLine('Q')])
    expect(logOnlyCalls).toEqual([stoppedEntry('Q', ordinary(), KILL_FAILURE_CONTEXT_RECOVERY, extra)])
    expectNoAlertText('Q', logOnlyCalls[0]!.entry, ordinary())
    expect(posts).toEqual([])
    expect([alerts.isOpen('K'), alerts.isOpen('Q')]).toEqual([false, false])
  })

  // The stopped-retry text's one literal pin (b.jg5 SRJ-702, SRJ-1013); every
  // other case builds it with `killFailureStoppedRetryText`.
  test('the stopped-retry line and entry, and the default stop cause (pin)', () => {
    const decision: KillRetryAlert = { kind: KILL_RETRY_ALERT_ORDINARY, lastKillFailedDescription: 'kill failed' }

    expect(KILL_FAILURE_STOP_CAUSE_DEFAULT).toBe('the persona is not up or is torn down, or the server is shutting down')
    expect(killFailureStoppedRetryText({ key: 'K', decision, context: KILL_FAILURE_CONTEXT_RECOVERY, lastOutcomeClass: AD_ERROR_CLASS_UNAVAILABLE, stopCause: 'stop' })).toEqual({
      line: '[slack] persona-episodes: persona=K kill-failure ordinary alert not raised — its tries were stopped (stop); its last outcome\'s class: UNAVAILABLE, so nothing retries this kill; last="kill failed" (recovery)',
      entry: 'persona=K (recovery): the kill-failure ordinary alert not raised — its tries were stopped (stop); its last outcome\'s class: UNAVAILABLE, so nothing retries this kill; last="kill failed"',
    })
    expect(killFailureStoppedRetryText({ key: 'K', decision: { kind: KILL_RETRY_ALERT_ORDINARY }, context: KILL_FAILURE_CONTEXT_RECOVERY }).line).toBe(
      '[slack] persona-episodes: persona=K kill-failure ordinary alert not raised — its tries were stopped (the persona is not up or is torn down, or the server is shutting down), so nothing retries this kill; no description (recovery)',
    )
  })

  // b.jg5 SRJ-702: the stop's line quotes the latest survivor-naming
  // description when a try returned one; still no alert of either version,
  // and a configured persona gets no entry.
  test.each<[string, () => KillRetryAlert]>([
    ['and a last description', () => ({ ...ordinary(), earlierSurvivorDescription: description('pane-process-survived') })],
    ['alone', () => ({ kind: KILL_RETRY_ALERT_ORDINARY, earlierSurvivorDescription: description('pane-process-survived') })],
  ])('stopped tries whose ordinary decision carries an earlier survivor-naming description %s: a configured persona gets one line quoting it and no entry; one no longer configured gets the line and its persona-kill-failed entry quoting it, with no alert text; no post and no episode', (_label, decision) => {
    const alerts = buildAlerts()
    configured.delete('Q')

    expect([raise(alerts, 'K', decision(), STOP), raise(alerts, 'Q', decision(), STOP)]).toEqual(['stopped', 'stopped'])

    expect(killLines('K')).toEqual([stoppedLine('K', decision())])
    expect(killLines('K')[0]).toContain(`earlier survivor-naming=${JSON.stringify(renderLogMessageText(description('pane-process-survived')))}`)
    expect(killLines('Q')).toEqual([stoppedLine('Q', decision()), stoppedEntryLine('Q')])
    expect(logOnlyCalls).toEqual([stoppedEntry('Q', decision())])
    expectNoAlertText('Q', logOnlyCalls[0]!.entry, decision())
    expect(posts).toEqual([])
    expect([alerts.isOpen('K'), alerts.isOpen('Q')]).toEqual([false, false])
  })

  test('a stopped raise\'s entry that the log-only route refuses: the line, then one token-safe failure line; still stopped, nothing posted', () => {
    const alerts = createKillFailureAlerts({
      episodes,
      log: (line) => lines.push(line),
      isConfigured: () => false,
      logOnly: () => {
        throw new Error(`route refused (${sentinelInMessage('stopped-entry')})`)
      },
    })

    expect(raise(alerts, 'K', ordinary(), STOP)).toBe('stopped')

    expect(killLines('K')).toHaveLength(2)
    expect(killLines('K')[0]).toBe(stoppedLine('K', ordinary()))
    expect(killLines('K')[1]).toStartWith(`[slack] persona-episodes: persona=K ${KIND} stopped retry's log line (no alert text) log-only write failed: Error message="route refused (${REDACTED_SENTINEL_TAIL})"`)
    expect(posts).toEqual([])
  })

  test('P\'s episode is independent of B\'s: the open query answers per key, and B\'s end leaves P\'s open', () => {
    const alerts = buildAlerts()

    raise(alerts, 'K', ordinary())
    expect([alerts.isOpen('K'), alerts.isOpen('Q')]).toEqual([true, false])
    expect(raise(alerts, 'Q', ordinary())).toBe('posted')
    expect(alerts.end('Q', KILL_FAILURE_END_ROW_FINISHED)).toBe(true)

    expect([alerts.isOpen('K'), alerts.isOpen('Q')]).toEqual([true, false])
    expect(raise(alerts, 'K', ordinary())).toBe('held')
    expect(posts.map((post) => post.key)).toEqual(['K', 'Q'])
  })

  test('after the episodes\' close (shutdown) nothing is posted: either version answers closed', () => {
    const alerts = buildAlerts()
    episodes.close()

    expect([raise(alerts, 'K', ordinary()), raise(alerts, 'K', survivor())]).toEqual(['closed', 'closed'])
    expect(posts).toEqual([])
    expect(alerts.isOpen('K')).toBe(false)
  })

  // -------------------------------------------------------------------------
  // During a persona teardown (b.jg5 SRJ-1003, SRJ-704's first match,
  // SRJ-1013). While the key's window is open an alert of any context but a
  // start-sweep or CLI teardown kill takes the persona-teardown route: handed
  // to the sink with no episode, where the persona notifier's window writes
  // it (tests/persona-notifier.test.ts), the survivor version carrying its
  // own class in the options.
  // -------------------------------------------------------------------------

  describe('during a persona teardown', () => {
    beforeEach(() => {
      episodes = buildWithTeardownQuery()
    })

    /** A raise for persona `key` of `decision` in `context`, not latched and not stopped unless said. */
    function raiseIn(alerts: KillFailureAlerts, key: string, decision: KillRetryAlert, context: KillFailureAlertContext, extra: RaiseExtra = {}): string {
      return alerts.raise(raiseInput(key, decision, context, extra))
    }

    /**
     * The teardown route's text for `decision`: the log-only closing,
     * unescaped; an alert of another context than the persona teardown's own
     * kill carries that context ahead of its text, as `(<context>) <text>`
     * (SRJ-1007, SRJ-1013).
     */
    function teardownText(key: string, decision: KillRetryAlert, context: KillFailureAlertContext = KILL_FAILURE_CONTEXT_PERSONA_TEARDOWN): string {
      const text = killFailureAlertText(contentOf(key, decision), KILL_FAILURE_CLOSING_LOG_ONLY, false)
      return context === KILL_FAILURE_CONTEXT_PERSONA_TEARDOWN ? text : `(${context}) ${text}`
    }

    const versions: ReadonlyArray<readonly [string, () => KillRetryAlert, string, PersonaEpisodeSinkOptions | undefined]> = [
      [KILL_FAILURE_VERSION_ORDINARY, () => ordinary(), PERSONA_TEARDOWN_NOTICE_LABEL, undefined],
      [KILL_FAILURE_VERSION_SURVIVOR, () => survivor(), PERSONA_KILL_SURVIVOR_LABEL, { teardownEntryClass: PERSONA_KILL_SURVIVOR_LABEL }],
    ]
    const windowContexts: readonly KillFailureAlertContext[] = [
      KILL_FAILURE_CONTEXT_PERSONA_TEARDOWN,
      KILL_FAILURE_CONTEXT_OLD_LIFE_WAIT,
      KILL_FAILURE_CONTEXT_STUCK_LAUNCH_ABORT,
      KILL_FAILURE_CONTEXT_RECOVERY,
    ]

    test.each(
      windowContexts.flatMap((context) =>
        [true, false].flatMap((isConfigured) => versions.map(([version, decision, classLabel, options]) => [version, context, isConfigured, decision, classLabel, options] as const)),
      ),
    )('the %s version raised in the window with the context %s (configured %p): logged, handed to the sink with its class, never the log-only route, and no episode opened', (version, context, isConfigured, decision, classLabel, options) => {
      if (!isConfigured) configured.delete('K')
      teardownStates.set('K', 'open')
      const alerts = buildAlerts()

      expect(raiseIn(alerts, 'K', decision(), context)).toBe('logged')

      expect(posts).toEqual([{ key: 'K', text: teardownText('K', decision(), context), ...(options === undefined ? {} : { options }) }])
      expect(logOnlyCalls).toEqual([])
      expect(alerts.isOpen('K')).toBe(false)
      expect(killLines('K')).toEqual([
        `[slack] persona-episodes: persona=K ${KIND} ${version} alert written to the server log and startup-errors.log (${classLabel}) — ${KILL_FAILURE_ROUTE_PERSONA_TEARDOWN}, raised during its teardown (${context})`,
      ])
      expect(lines.filter((line) => line.includes(PERSONA_KILL_FAILED_LABEL))).toEqual([])
    })

    test('a latched raise in the window still takes the teardown route, and none is held back: each ordinary raise is handed over, and once the window has closed the next ordinary alert opens its episode at the destination', () => {
      teardownStates.set('K', 'open')
      const alerts = buildAlerts()

      expect([raiseIn(alerts, 'K', ordinary(), KILL_FAILURE_CONTEXT_RECOVERY, { latched: true }), raiseIn(alerts, 'K', ordinary(), KILL_FAILURE_CONTEXT_PERSONA_TEARDOWN)]).toEqual(['logged', 'logged'])
      expect(posts).toEqual([
        { key: 'K', text: teardownText('K', ordinary(), KILL_FAILURE_CONTEXT_RECOVERY) },
        { key: 'K', text: teardownText('K', ordinary()) },
      ])
      expect(alerts.isOpen('K')).toBe(false)

      teardownStates.delete('K')
      expect(raise(alerts, 'K', ordinary())).toBe('posted')
      expect(posts.at(-1)).toEqual(destinationPost('K', ordinary()))
      expect(alerts.isOpen('K')).toBe(true)
    })

    test('another persona\'s alert while K\'s window is open goes to its own destination', () => {
      teardownStates.set('K', 'open')
      const alerts = buildAlerts()

      expect(raise(alerts, 'Q', ordinary())).toBe('posted')

      expect(posts).toEqual([destinationPost('Q', ordinary())])
      expect([alerts.isOpen('Q'), alerts.isOpen('K')]).toEqual([true, false])
    })

    // SRJ-704's first match: a start-sweep or CLI teardown kill keeps its own route, window or not.
    test.each<[KillFailureAlertContext, string, KillFailureClosing, string]>([
      [KILL_FAILURE_CONTEXT_START_SWEEP, ORPHAN_CLEANUP_LABEL, KILL_FAILURE_CLOSING_LOG_ONLY, KILL_FAILURE_ROUTE_START_SWEEP],
      [KILL_FAILURE_CONTEXT_CLI_TEARDOWN, PERSONA_KILL_FAILED_LABEL, KILL_FAILURE_CLOSING_CLI_TEARDOWN, KILL_FAILURE_ROUTE_CLI_TEARDOWN],
    ])('a %s kill in the window keeps its own route: one %s entry through the log-only route, nothing handed to the sink', (context, classLabel, closing, route) => {
      teardownStates.set('K', 'open')
      const alerts = buildAlerts()

      expect(raiseIn(alerts, 'K', ordinary(), context)).toBe('logged')

      const text = killFailureAlertText(contentOf('K', ordinary()), closing, false)
      expect(logOnlyCalls).toEqual([{ classLabel, entry: killFailureAlertEntryText('persona=K', context, text) }])
      expect(posts).toEqual([])
      expect(killLines('K')).toEqual([`[slack] persona-episodes: persona=K ${KIND} ordinary alert written to the server log and startup-errors.log (${classLabel}) — ${route}`])
    })

    // SRJ-702, SRJ-1003 (the control for a retry the teardown's start
    // stopped): a bounded retry of a launch or recovery attempt's kill (the
    // live-row sequence's and the restart path's kills, context recovery; the
    // stuck-launch abort's) stopped while the key's window is open, or between
    // its submit and its turn, is no teardown notice: SRJ-702's one line and,
    // for a persona removed during the tries, its persona-kill-failed entry
    // with no alert text; nothing handed to the sink (so no
    // persona-teardown-notice entry and no Slack call), neither version, no
    // muted line and no episode. A configured persona's stop writes the line only.
    test.each<[KillFailureAlertContext, PersonaTeardownWindowState]>([
      [KILL_FAILURE_CONTEXT_RECOVERY, 'open'],
      [KILL_FAILURE_CONTEXT_STUCK_LAUNCH_ABORT, 'open'],
      [KILL_FAILURE_CONTEXT_RECOVERY, 'submitted'],
    ])('a stopped retry of a %s kill, its teardown %s: a removed persona gets the stop line and one persona-kill-failed entry with no alert text, a configured one the line only; never a persona-teardown-notice entry, nothing handed to the sink, neither version', (context, state) => {
      teardownStates.set('K', state)
      teardownStates.set('R', state)
      configured.delete('R')
      const alerts = buildAlerts()

      expect([raiseIn(alerts, 'K', ordinary(), context, STOP), raiseIn(alerts, 'R', ordinary(), context, STOP)]).toEqual(['stopped', 'stopped'])

      expect(killLines('K')).toEqual([stoppedLine('K', ordinary(), context)])
      expect(killLines('R')).toEqual([stoppedLine('R', ordinary(), context), stoppedEntryLine('R')])
      expect(logOnlyCalls).toEqual([stoppedEntry('R', ordinary(), context)])
      expectNoAlertText('R', logOnlyCalls[0]!.entry, ordinary())
      expect(posts).toEqual([])
      expect(lines.filter((line) => line.includes(PERSONA_TEARDOWN_NOTICE_LABEL) || line.includes(PERSONA_KILL_SURVIVOR_LABEL))).toEqual([])
      expect(lines.filter((line) => line === mutedLine('K', KIND) || line === mutedLine('R', KIND))).toEqual([])
      expect([alerts.isOpen('K'), alerts.isOpen('R')]).toEqual([false, false])
    })

    // SRJ-1003: from the submit, before the turn, the key's posts are muted;
    // the alerts' own line says the alert was not posted.
    test.each<[string, () => KillRetryAlert, string]>([
      [
        KILL_FAILURE_VERSION_ORDINARY,
        () => ordinary(),
        `ordinary alert not posted to its destination — muted, its persona teardown was submitted; it counts as posted in its episode (${KILL_FAILURE_CONTEXT_RECOVERY}; ${KILL_FAILURE_CLOSING_DESTINATION})`,
      ],
      [
        KILL_FAILURE_VERSION_SURVIVOR,
        () => survivor(),
        `survivor alert not posted to its destination — muted, its persona teardown was submitted (${KILL_FAILURE_CONTEXT_RECOVERY})`,
      ],
    ])('the %s version raised between the teardown\'s submit and its turn, for a configured persona, reaches no destination: the muted line, then its own line saying it was not posted', (_version, decision, ownLine) => {
      teardownStates.set('K', 'submitted')
      const alerts = buildAlerts()

      expect(raise(alerts, 'K', decision())).toBe('posted')

      expect(posts).toEqual([])
      expect(logOnlyCalls).toEqual([])
      expect(lines).toEqual([mutedLine('K', KIND), `[slack] persona-episodes: persona=K ${KIND} ${ownLine}`])
    })

    // Controls: with no window open the routes are SRJ-704's own; the
    // persona-teardown context's entry is built by the shared builder.
    test.each(versions)('control, no window open: the %s version for a configured persona in recovery goes to its destination', (_version, decision) => {
      teardownStates.set('Q', 'open')
      const alerts = buildAlerts()

      expect(raise(alerts, 'K', decision())).toBe('posted')

      expect(posts).toEqual([destinationPost('K', decision())])
      expect(logOnlyCalls).toEqual([])
    })

    test.each<[string, () => KillRetryAlert, string, (text: string) => string]>([
      [KILL_FAILURE_VERSION_ORDINARY, () => ordinary(), PERSONA_TEARDOWN_NOTICE_LABEL, (text) => personaTeardownNoticeEntryText('persona=K', text)],
      [KILL_FAILURE_VERSION_SURVIVOR, () => survivor(), PERSONA_KILL_SURVIVOR_LABEL, (text) => killFailureAlertEntryText('persona=K', KILL_FAILURE_CONTEXT_PERSONA_TEARDOWN, text)],
    ])('control, no window open: the %s version with the persona-teardown context writes one %s entry through the log-only route and hands nothing to the sink', (version, decision, classLabel, entryOf) => {
      const alerts = buildAlerts()

      expect(raiseIn(alerts, 'K', decision(), KILL_FAILURE_CONTEXT_PERSONA_TEARDOWN)).toBe('logged')

      expect(logOnlyCalls).toEqual([{ classLabel, entry: entryOf(teardownText('K', decision())) }])
      expect(posts).toEqual([])
      expect(alerts.isOpen('K')).toBe(false)
      expect(killLines('K')).toEqual([
        `[slack] persona-episodes: persona=K ${KIND} ${version} alert written to the server log and startup-errors.log (${classLabel}) — ${KILL_FAILURE_ROUTE_PERSONA_TEARDOWN}`,
      ])
    })
  })

  // -------------------------------------------------------------------------
  // Over the real persona notifier's teardown window (b.jg5 SRJ-1003,
  // SRJ-702), wired as main() wires them: the episodes' sink is the
  // notifier's `notify` and their teardown query its `teardownWindowState`.
  // -------------------------------------------------------------------------

  describe('over the real persona notifier\'s teardown window', () => {
    let baseDir: string
    let h: NotifierHarness
    /** A destructive modify's old half (still configured) and a removed persona. */
    let kept: Persona
    let removed: Persona

    beforeEach(() => {
      baseDir = mkdtempSync(join(tmpdir(), 'cscb-episodes-'))
      const config = makeMultiPersonaConfig([{ name: 'Kilo Episodes' }, { name: 'Romeo Episodes' }], baseDir)
      ;[kept, removed] = config.personas as [Persona, Persona]
      h = makeNotifierHarness(config, { leakMarker: LEAK_SENTINEL })
      configured = new Set([kept.key])
      h.personas.splice(h.personas.findIndex((p) => p.key === removed.key), 1) // apply step 1: removed
      episodes = createPersonaEpisodes({
        sink: (key, text, options) => h.notifier.notify(key, text, options),
        log: (line) => lines.push(line),
        clock,
        teardownWindow: (key) => h.notifier.teardownWindowState(key),
      })
    })

    afterEach(() => {
      try {
        assertNoLeak({ logs: h.logs, slack: h.allPosts(), entries: h.startupEntries() })
      } finally {
        h.hold.cancelAll()
        h.cleanup()
        rmSync(baseDir, { recursive: true, force: true })
      }
    })

    test('in a removed persona\'s open window: an ordinary alert is one notifier line and one persona-teardown-notice entry with no Slack call, while a stopped retry beside it writes only its stop line and its persona-kill-failed entry with no alert text', async () => {
      const alerts = buildAlerts()
      const key = removed.key

      await h.duringTeardown(removed, async () => {
        expect(h.notifier.teardownWindowState(key)).toBe('open')
        expect(alerts.raise(raiseInput(key, ordinary(), KILL_FAILURE_CONTEXT_RECOVERY, STOP))).toBe('stopped')
        expect(alerts.raise(raiseInput(key, ordinary(), KILL_FAILURE_CONTEXT_PERSONA_TEARDOWN, {}))).toBe('logged')
        await clock.flush()
      })

      const text = killFailureAlertText(contentOf(key, ordinary()), KILL_FAILURE_CLOSING_LOG_ONLY, false)
      expect(h.startupEntries()).toEqual([teardownNoticeEntry(removed, text)])
      expect(h.logs).toEqual([teardownNoticeLine(removed, text)])
      expect(h.totalPosts()).toBe(0)
      expect(logOnlyCalls).toEqual([stoppedEntry(key, ordinary())])
      expect(killLines(key)).toEqual([
        stoppedLine(key, ordinary()),
        stoppedEntryLine(key),
        `[slack] persona-episodes: persona=${key} ${KIND} ${KILL_FAILURE_VERSION_ORDINARY} alert written to the server log and startup-errors.log (${PERSONA_TEARDOWN_NOTICE_LABEL}) — ${KILL_FAILURE_ROUTE_PERSONA_TEARDOWN}, raised during its teardown (${KILL_FAILURE_CONTEXT_PERSONA_TEARDOWN})`,
      ])
      expect(alerts.isOpen(key)).toBe(false)
    })

    test('control: a destructive modify\'s old half with no window open gets its ordinary alert at its destination through its own client; once its window is open a stopped retry posts and writes nothing more than its stop line', async () => {
      const alerts = buildAlerts()
      const key = kept.key

      expect(alerts.raise(raiseInput(key, ordinary(), KILL_FAILURE_CONTEXT_RECOVERY, {}))).toBe('posted')
      await clock.flush()
      expect(h.posts(key)).toEqual([{ channel: kept.permission_prompts!, text: formatPersonaNotice(kept, killFailureAlertText(contentOf(key, ordinary()), KILL_FAILURE_CLOSING_DESTINATION, true)) }])

      await h.duringTeardown(kept, async () => {
        expect(alerts.raise(raiseInput(key, ordinary(), KILL_FAILURE_CONTEXT_RECOVERY, STOP))).toBe('stopped')
        await clock.flush()
      })

      expect(h.posts(key)).toHaveLength(1)
      expect(h.startupEntries()).toEqual([])
      expect(logOnlyCalls).toEqual([])
      expect(killLines(key).at(-1)).toBe(stoppedLine(key, ordinary()))
    })
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
