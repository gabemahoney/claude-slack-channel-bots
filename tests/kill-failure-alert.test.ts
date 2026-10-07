/**
 * kill-failure-alert.test.ts — the kill-failure alert's texts and its route
 * selection (`src/kill-failure-alert.ts`; b.jg5 SRJ-1007's texts, SRJ-704's
 * routing and survivor class, SRJ-1013's two new classes, SRJ-1001's common
 * rules for a quoted description, SRJ-613's read-pane statement), and the
 * log-line and entry form, whose CLI-teardown context names the command
 * (SRJ-909).
 *
 * SRJ-1007's Test line names `tests/live-row-sequence.test.ts` (E21's file),
 * which drives the sequence form; E20 tests every text through the module's
 * builders here. SRJ-1007's literal texts appear only in the pin case, around
 * the stub's descriptions and pids; every other expected value is built from
 * the module's exports, `src/` (the description renderer, the Slack escape,
 * the persona ids) and the stub's description builders and pid constants, and
 * every case leak-checks what it built (`assertNoLeak`). A fake token is put into each description
 * through the stub builder's session-name argument (`sentinelInMessage`), so
 * a description quoted unredacted fails the leak check; the one exception is
 * the realistic-length case, whose persona-shaped session keeps the
 * description at the release candidate's length.
 *
 * The module's import boundary is checked by walking its runtime imports
 * through `src/` (`forbiddenServerLoads`, `tests/test-helpers/source-audit.ts`).
 *
 * The route over every SRJ-1002 context, and the record of a bounded retry
 * that SRJ-702's stop rule stops (SRJ-702, SRJ-704, SRJ-1013; AC 64), are
 * checked at the alerts layer too: the server's kill-failure alerts
 * (`createKillFailureAlerts`) over notice episodes whose sink is the real
 * persona notifier (`makeNotifierHarness`, one Slack stub per persona, a
 * zero-post check on every stub), "configured" decided as the server decides
 * it (the key is in the applied persona set), the log-only route writing
 * through the real `recordStartupError` into the case's own temp directory,
 * and each decision made by a real bounded retry (`runKillRetry` on a fake
 * clock). A launch or recovery attempt's stopped retry is raised through
 * `raisePersonaKillFailureAlert` (`src/session-manager.ts`), whose stop's
 * cause comes from the installed keep-going query; that query is removed
 * after each case. Nothing latches on this layer: no latch is installed.
 *
 * No process, no real timer, no top-level mock.module(), no value import of
 * `Client` or `resolveSystemBinary`, no Phase-1-only named import.
 *
 * SPDX-License-Identifier: MIT
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { AD_ERROR_CLASS_UNAVAILABLE, killFailedDescriptionOf } from '../src/ad-error-class.ts'
import { killOutcomeOf } from '../src/checked-kill.ts'
import type { Persona } from '../src/config.ts'
import { NEVER_DELETE_ROW_PHRASE, RETRY_KILL_LATER_PHRASE, SURVIVOR_CLAUSE_MANY_PHRASE } from '../src/ad-description-phrases.ts'
import { CLI_COMMAND_CLEAN_RESTART, CLI_COMMAND_STOP_BOTS, type CliTeardownCommand } from '../src/cli-teardown.ts'
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
  KILL_FAILURE_CONTEXTS,
  KILL_FAILURE_ORDINARY_CLI_TEARDOWN_CLOSING,
  KILL_FAILURE_ORDINARY_DESTINATION_CLOSING,
  KILL_FAILURE_ORDINARY_LATCHED_CLOSING,
  KILL_FAILURE_ORDINARY_LOG_ONLY_CLOSING,
  KILL_FAILURE_ROUTE_CLI_TEARDOWN,
  KILL_FAILURE_ROUTE_DESTINATION,
  KILL_FAILURE_ROUTE_NOT_CONFIGURED,
  KILL_FAILURE_ROUTE_PERSONA_TEARDOWN,
  KILL_FAILURE_ROUTE_START_SWEEP,
  KILL_FAILURE_SURVIVOR_CLI_TEARDOWN_CLOSING,
  KILL_FAILURE_SURVIVOR_DESTINATION_CLOSING,
  KILL_FAILURE_SURVIVOR_LOG_ONLY_CLOSING,
  KILL_FAILURE_VERSION_ORDINARY,
  KILL_FAILURE_VERSION_SURVIVOR,
  ORPHAN_CLEANUP_LABEL,
  PERSONA_KILL_FAILED_LABEL,
  PERSONA_KILL_SURVIVOR_LABEL,
  describeKillFailureDescriptions,
  killFailureAlertContentOf,
  killFailureAlertEntryText,
  killFailureAlertText,
  killFailureCliTeardownEntryContext,
  killFailureClosingSentence,
  killFailureOrdinaryBody,
  killFailureSurvivorBody,
  killFailureSurvivorPidList,
  renderKillFailureAlertEntryContext,
  selectKillFailureAlertRoute,
  type KillFailureAlertContent,
  type KillFailureAlertContext,
  type KillFailureAlertRoute,
  type KillFailureAlertVersion,
  type KillFailureClosing,
  type KillFailureOrdinaryQuotes,
} from '../src/kill-failure-alert.ts'
import {
  KILL_RETRY_ALERT_NONE,
  KILL_RETRY_ALERT_ORDINARY,
  KILL_RETRY_ALERT_SURVIVOR,
  KILL_RETRY_END_HOLD_ENDED,
  KILL_RETRY_END_STOPPED,
  KILL_RETRY_READ_STATE,
  KILL_RETRY_SEED_LIVE_UNREAD,
  killRetryStopped,
  runKillRetry,
  type KillRetryAlert,
  type KillRetryResult,
} from '../src/kill-retry.ts'
import { LIVE_ROW_STOP_TEARDOWN, liveRowStopCauseText } from '../src/live-row-sequence.ts'
import { oldLifeWaitRef } from '../src/old-life-wait.ts'
import { MAX_LOGGED_MESSAGE_LENGTH, renderLogMessageText } from '../src/persona-connection-errors.ts'
import { killFailureStoppedRetryText, type KillFailureAlerts } from '../src/persona-episodes.ts'
import { personaInstanceId, personaTmuxSessionName } from '../src/persona-identity.ts'
import { PERSONA_TEARDOWN_NOTICE_LABEL, formatPersonaNotice, personaTeardownNoticeEntryText } from '../src/persona-notifier.ts'
import {
  OLD_LIFE_WAIT_STOP_CAUSE_SHUTDOWN,
  OLD_LIFE_WAIT_STOP_CAUSE_TEARDOWN,
  PERSONA_KILL_STOP_CAUSE_GENERIC,
  PERSONA_KILL_STOP_CAUSE_NOT_UP,
  PERSONA_KILL_STOP_CAUSE_SHUTDOWN,
  START_SWEEP_KILL_STOP_SHUTDOWN,
  raisePersonaKillFailureAlert,
  setPersonaKillKeepGoingQuery,
  type PersonaKillKeepGoingQuery,
} from '../src/session-manager.ts'
import { escapeSlackControlCharacters } from '../src/slack-text-escape.ts'
import {
  KILL_FAILED_DESCRIPTIONS,
  STUB_SURVIVOR_PIDS,
  STUB_TMUX_SESSION_NAME,
  STUB_WORKER_PID,
  cannedStatusResult,
  errTmuxKillFailed,
  errTmuxUnresponsive,
  type KillFailedDescription,
  type KillFailedOptions,
} from './test-helpers/agent-director-stub.ts'
import { LAUNCH_START_PRE_PERSONA_KEY } from './test-helpers/conflict-cases.ts'
import { LEAK_SENTINEL, REDACTED_SENTINEL_TAIL, assertNoLeak, sentinelInMessage } from './test-helpers/credentials.ts'
import { createFakeClock } from './test-helpers/fake-clock.ts'
import { makeMultiPersonaConfig } from './test-helpers/persona-config.ts'
import { makeNoticeAlertsRig, makeNotifierHarness, readStartupEntries, type NotifierHarness, type StartupEntry } from './test-helpers/persona-notifier.ts'
import { forbiddenServerLoads } from './test-helpers/source-audit.ts'

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/** The configured persona the id cases are built for. */
const KEY = 'alpha'

/** The raw description of the stub's `ErrTmuxKillFailed` of form `form`, a fake token and a ticket URL in its quoted session. */
function stubDescription(form: KillFailedDescription, pids: readonly number[] = STUB_SURVIVOR_PIDS, options: KillFailedOptions = {}): string {
  return killFailedDescriptionOf(errTmuxKillFailed(sentinelInMessage(`kill-failure-alert-${form}`), form, pids, options))!
}

/** The stub's survivor-naming description (its survivor clause names `pids`), with a fake token in its quoted session. */
function survivorDescription(pids: readonly number[] = STUB_SURVIVOR_PIDS, options: KillFailedOptions = {}): string {
  return stubDescription('pane-process-survived', pids, options)
}

/** A description of `form` as the alert quotes it: redacted on one line and capped, then escaped for Slack when `forSlack`. */
function quoted(description: string, forSlack: boolean): string {
  const rendered = renderLogMessageText(description)
  return `"${forSlack ? escapeSlackControlCharacters(rendered) : rendered}"`
}

/** The ordinary body for persona `KEY`'s own row quoting `quotes`. */
function ordinaryBody(quotes: KillFailureOrdinaryQuotes | undefined, forSlack: boolean): string {
  return killFailureOrdinaryBody({
    session: personaTmuxSessionName(KEY),
    instanceId: personaInstanceId(KEY),
    ...(quotes === undefined ? {} : { quotes }),
    forSlack,
  })
}

/**
 * What `longer` adds to `shorter` in one place: their common prefix and suffix
 * set aside, the middle of `longer`; fails unless `shorter` is exactly that
 * prefix and suffix.
 */
function insertion(longer: string, shorter: string): string {
  let prefix = 0
  while (prefix < shorter.length && longer[prefix] === shorter[prefix]) prefix++
  let suffix = 0
  while (suffix < shorter.length - prefix && longer[longer.length - 1 - suffix] === shorter[shorter.length - 1 - suffix]) suffix++
  expect(shorter.length).toBe(prefix + suffix)
  return longer.slice(prefix, longer.length - suffix)
}

/** The code spans of `text` that open with `agent-director` or `tmux`: the commands it names (b.jg5 SRJ-1001). */
function commandSpans(text: string): string[] {
  return [...text.matchAll(/`\s*(?:agent-director|tmux)\b[^`]*`/g)].map((m) => m[0])
}

/** Every closing kind, in SRJ-1007's table order. */
const CLOSINGS: readonly KillFailureClosing[] = [
  KILL_FAILURE_CLOSING_DESTINATION,
  KILL_FAILURE_CLOSING_DESTINATION_LATCHED,
  KILL_FAILURE_CLOSING_CLI_TEARDOWN,
  KILL_FAILURE_CLOSING_LOG_ONLY,
]

/** Both versions. */
const VERSIONS: readonly KillFailureAlertVersion[] = [KILL_FAILURE_VERSION_ORDINARY, KILL_FAILURE_VERSION_SURVIVOR]

/** The two commands that run a CLI teardown. */
const CLI_COMMANDS: readonly CliTeardownCommand[] = [CLI_COMMAND_STOP_BOTS, CLI_COMMAND_CLEAN_RESTART]

/** The ordinary version's closing sentences, every row of its table. */
const ORDINARY_CLOSINGS: readonly string[] = [
  KILL_FAILURE_ORDINARY_DESTINATION_CLOSING,
  KILL_FAILURE_ORDINARY_LATCHED_CLOSING,
  KILL_FAILURE_ORDINARY_CLI_TEARDOWN_CLOSING,
  KILL_FAILURE_ORDINARY_LOG_ONLY_CLOSING,
]

// ---------------------------------------------------------------------------
// The pin: SRJ-1007's literal texts
// ---------------------------------------------------------------------------

describe('kill-failure alert: SRJ-1007’s texts (pin)', () => {
  test('the one pin case: the ordinary body (with one description, with two in the stated form, with none), the survivor body with its pid list, and all seven closing sentences, byte for byte', () => {
    const session = personaTmuxSessionName('sample')
    const instanceId = personaInstanceId('sample')
    const ordinary = (quotes?: KillFailureOrdinaryQuotes): string =>
      killFailureOrdinaryBody({ session, instanceId, ...(quotes === undefined ? {} : { quotes }), forSlack: false })

    expect(ordinary({ lastKillFailedDescription: 'the kill failed' })).toBe(
      ':rotating_light: *Kill failed* — agent-director could not end the worker in session "slack_bot_sample": it, or another process in that session\'s panes, may still be running, and its agent-director row was kept. agent-director said: "the kill failed". A human\'s next step: check it with `agent-director read-pane --claude-instance-id cscb_sample`; if the worker still runs, run `agent-director kill --claude-instance-id cscb_sample` and check its result. A read-pane answer of ErrTmuxCaptureFailed does not prove the worker gone when agent-director\'s description says no session or pane of this launch was found, and a pane does not prove it is the worker\'s when kill then answers "not this launch\'s session", because read-pane can return a leftover\'s pane; for these, and for anything beyond kill, follow the "Operator actions" section of agent-director\'s README. These commands are for a human only: no bot, including any persona that sees this post, may run them.',
    )
    expect(ordinary({ lastKillFailedDescription: 'the kill failed', earlierSurvivorDescription: 'a process outlived the kill' })).toContain(
      ' agent-director said: "the kill failed" and, earlier in these tries, "a process outlived the kill". A human\'s next step: ',
    )
    expect(ordinary()).toBe(
      ':rotating_light: *Kill failed* — agent-director could not end the worker in session "slack_bot_sample": it, or another process in that session\'s panes, may still be running, and its agent-director row was kept. A human\'s next step: check it with `agent-director read-pane --claude-instance-id cscb_sample`; if the worker still runs, run `agent-director kill --claude-instance-id cscb_sample` and check its result. A read-pane answer of ErrTmuxCaptureFailed does not prove the worker gone when agent-director\'s description says no session or pane of this launch was found, and a pane does not prove it is the worker\'s when kill then answers "not this launch\'s session", because read-pane can return a leftover\'s pane; for these, and for anything beyond kill, follow the "Operator actions" section of agent-director\'s README. These commands are for a human only: no bot, including any persona that sees this post, may run them.',
    )

    // The survivor descriptions are the stub's, in the release candidate's
    // wording: the plural survivor clause "(pids S1, S2)" gives the pid list
    // "pid S1, pid S2"; the singular "(pid S)" gives "pid S". At the release
    // candidate's length this description is over the cap, so it is quoted
    // capped (see the realistic-length case under the survivor version).
    const [s1] = STUB_SURVIVOR_PIDS as [number]
    const s2 = s1 + 1
    const twoSurvivors = killFailedDescriptionOf(errTmuxKillFailed(session, 'pane-process-survived', [s1, s2]))!
    const survivor = killFailureSurvivorBody({ session, survivorDescription: twoSurvivors, forSlack: false })
    expect(survivor).toBe(
      `:rotating_light: *Process outlived kill* — agent-director ended the worker in session "slack_bot_sample", but a process in that session outlived the kill: pid ${s1}, pid ${s2}. agent-director said: ${quoted(twoSurvivors, false)}. A later \`kill\` does not check this process again. A human's next step: find and end that process by following the "Operator actions" section of agent-director's README. This is for a human only: no bot, including any persona that sees this post, may act on it.`,
    )
    expect(killFailureSurvivorPidList(killFailedDescriptionOf(errTmuxKillFailed(session, 'pane-process-survived', [s1]))!)).toBe(`pid ${s1}`)

    expect([
      KILL_FAILURE_ORDINARY_DESTINATION_CLOSING,
      KILL_FAILURE_ORDINARY_LATCHED_CLOSING,
      KILL_FAILURE_ORDINARY_CLI_TEARDOWN_CLOSING,
      KILL_FAILURE_ORDINARY_LOG_ONLY_CLOSING,
      KILL_FAILURE_SURVIVOR_DESTINATION_CLOSING,
      KILL_FAILURE_SURVIVOR_CLI_TEARDOWN_CLOSING,
      KILL_FAILURE_SURVIVOR_LOG_ONLY_CLOSING,
    ]).toEqual([
      'CSCB keeps retrying on its own and posts no second alert about this.',
      'This persona is held for a human (see its hold post); CSCB posts no second alert about this.',
      'The CLI does not retry this kill: once the worker is ended, run the command again.',
      "CSCB retries this kill only while a persona waits on this worker (its own persona's next launch, or a persona in its working directory); until one does, nothing retries it.",
      'CSCB takes no further action on this process and posts no second alert about it.',
      "This persona's teardown has finished; nothing in CSCB checks this process again.",
      'CSCB does not retry this kill or check this process again.',
    ])

    // SRJ-1007: the survivor version carries none of the ordinary version's
    // retry sentences, on any route.
    for (const closing of CLOSINGS) {
      const text = killFailureAlertText({ version: KILL_FAILURE_VERSION_SURVIVOR, session, survivorDescription: twoSurvivors }, closing, true)
      for (const phrase of ['keeps retrying', 'run the command again', 'retries this kill only while']) expect([closing, text.includes(phrase)]).toEqual([closing, false])
    }
  })
})

// ---------------------------------------------------------------------------
// The ordinary version
// ---------------------------------------------------------------------------

describe('kill-failure alert: the ordinary version (b.jg5 SRJ-1007)', () => {
  // `<id>` is the row's instance id and `<session>` the session it names: a
  // persona's own row (`cscb_<key>`, `slack_bot_<key>`), an old key's, or a
  // pre-persona row's id with the session its row names.
  test.each<[string, string, string]>([
    ['cscb_<key> (a configured persona\'s own row)', personaInstanceId(KEY), personaTmuxSessionName(KEY)],
    ['an old key\'s instance id', personaInstanceId('retired'), personaTmuxSessionName('retired')],
    ['a pre-persona row\'s id, with the session its row names', personaInstanceId(LAUNCH_START_PRE_PERSONA_KEY), STUB_TMUX_SESSION_NAME],
  ])('for %s: the id fills both commands and the session is quoted; every other word is the pinned body\'s', (_label, instanceId, session) => {
    const description = stubDescription('outlived-exit-wait')
    const reference = ordinaryBody({ lastKillFailedDescription: description }, false)
    const body = killFailureOrdinaryBody({ session, instanceId, quotes: { lastKillFailedDescription: description }, forSlack: false })

    expect(body.split(instanceId)).toHaveLength(3)
    expect(body).toContain(` ${JSON.stringify(session)}: `)
    expect(body).toBe(
      reference.replaceAll(personaInstanceId(KEY), instanceId).replace(JSON.stringify(personaTmuxSessionName(KEY)), JSON.stringify(session)),
    )
    assertNoLeak(body)
  })

  // Each of the four ErrTmuxKillFailed descriptions (HO rev 17) is quoted
  // whole, redacted on one line (b.jg5 SRJ-1001), in the one "agent-director
  // said" sentence, the only difference from the body with no description;
  // the Slack form escapes Slack's control characters in it too.
  test.each(KILL_FAILED_DESCRIPTIONS.flatMap((form) => [[form, false], [form, true]] as const))(
    'the %s description, forSlack %p: quoted whole and redacted, in one sentence that is all the body adds to the no-description form',
    (form, forSlack) => {
      const description = stubDescription(form)
      const body = ordinaryBody({ lastKillFailedDescription: description }, forSlack)

      const said = insertion(body, ordinaryBody(undefined, forSlack))
      expect(said).toContain(quoted(description, forSlack))
      expect(said.indexOf('"')).toBe(said.indexOf(quoted(description, forSlack)))
      expect(said.endsWith(`${quoted(description, forSlack)}. `)).toBe(true)
      expect(body).toContain(forSlack ? escapeSlackControlCharacters(REDACTED_SENTINEL_TAIL) : REDACTED_SENTINEL_TAIL)
      expect(body).not.toContain('\n')
      assertNoLeak(body)
    },
  )

  test('a description longer than the cap is quoted capped (b.jg5 SRJ-1001)', () => {
    const description = `${stubDescription('outlived-exit-wait')} ${'x'.repeat(MAX_LOGGED_MESSAGE_LENGTH)}`
    const said = insertion(ordinaryBody({ lastKillFailedDescription: description }, false), ordinaryBody(undefined, false))

    expect(said).toContain(quoted(description, false))
    expect(renderLogMessageText(description).length).toBe(MAX_LOGGED_MESSAGE_LENGTH)
    assertNoLeak(said)
  })

  test('with no description (E21\'s sequence whose kills succeeded) the "agent-director said" sentence is left out: no quote of any description, the same body as with empty quotes', () => {
    const bare = ordinaryBody(undefined, true)

    expect(ordinaryBody({}, true)).toBe(bare)
    expect(insertion(ordinaryBody({ lastKillFailedDescription: stubDescription('outlived-exit-wait') }, true), bare).length).toBeGreaterThan(0)
    expect(bare).not.toContain(RETRY_KILL_LATER_PHRASE)
  })

  // SRJ-1007: after a survivor-naming failure, the tries that ended in
  // another failure quote only that description; those that ended in an
  // ErrTmuxKillFailed naming no survivor quote both, the last first.
  test('after a survivor-naming failure: one description when the tries ended in another failure; both, the last kill failure\'s first, when they ended in an ErrTmuxKillFailed naming no survivor', () => {
    const survivor = survivorDescription()
    const last = stubDescription('unverifiable-session-present')
    const bare = ordinaryBody(undefined, true)

    const one = insertion(ordinaryBody({ earlierSurvivorDescription: survivor }, true), bare)
    expect(one).toBe(insertion(ordinaryBody({ lastKillFailedDescription: survivor }, true), bare))
    expect(one).toContain(quoted(survivor, true))

    const both = insertion(ordinaryBody({ lastKillFailedDescription: last, earlierSurvivorDescription: survivor }, true), bare)
    expect(both.indexOf(quoted(last, true))).toBeGreaterThan(-1)
    expect(both.indexOf(quoted(survivor, true))).toBeGreaterThan(both.indexOf(quoted(last, true)))
    expect(both.startsWith(one.slice(0, one.indexOf('"')))).toBe(true)
    assertNoLeak([one, both])
  })

  test.each([...CLOSINGS])('closing %s: the full text is the body, a space and the closing sentence of the ordinary version\'s table', (closing) => {
    const description = stubDescription('no-session-no-kill')
    const content = { version: KILL_FAILURE_VERSION_ORDINARY, session: personaTmuxSessionName(KEY), instanceId: personaInstanceId(KEY), quotes: { lastKillFailedDescription: description } } as const
    const sentence = killFailureClosingSentence(KILL_FAILURE_VERSION_ORDINARY, closing)

    expect(sentence).toBe(ORDINARY_CLOSINGS[CLOSINGS.indexOf(closing)]!)
    for (const forSlack of [false, true]) {
      expect(killFailureAlertText(content, closing, forSlack)).toBe(`${ordinaryBody({ lastKillFailedDescription: description }, forSlack)} ${sentence}`)
      assertNoLeak(killFailureAlertText(content, closing, forSlack))
    }
  })

  test('it names the human\'s two commands as code spans, each for the row\'s id', () => {
    const spans = commandSpans(ordinaryBody(undefined, true))

    expect(spans).toHaveLength(2)
    for (const span of spans) expect(span).toContain(personaInstanceId(KEY))
  })
})

// ---------------------------------------------------------------------------
// SRJ-1001: agent-director's words are its own
// ---------------------------------------------------------------------------

describe('kill-failure alert: CSCB\'s own words (b.jg5 SRJ-1001)', () => {
  // Every description carries "retry kill later" and "never delete this row";
  // with the quoted description removed, no text says either. The text holds
  // them exactly where its capped quote does: the survivor description, at
  // the release candidate's length, is cut before them (see the
  // realistic-length case under the survivor version).
  test.each(VERSIONS.flatMap((version) => CLOSINGS.map((closing) => [version, closing] as const)))(
    '%s version, closing %s: with the quoted description removed, the text holds neither of agent-director\'s own phrases; only the ordinary version\'s not-latched destination sentence says CSCB keeps retrying',
    (version, closing) => {
      const description = version === KILL_FAILURE_VERSION_SURVIVOR ? survivorDescription() : stubDescription('outlived-exit-wait')
      const content =
        version === KILL_FAILURE_VERSION_SURVIVOR
          ? { version, session: personaTmuxSessionName(KEY), survivorDescription: description }
          : { version, session: personaTmuxSessionName(KEY), instanceId: personaInstanceId(KEY), quotes: { lastKillFailedDescription: description } }
      const text = killFailureAlertText(content, closing, true)
      const own = text.replace(quoted(description, true), '')
      const inQuote = [RETRY_KILL_LATER_PHRASE, NEVER_DELETE_ROW_PHRASE].map((phrase) => quoted(description, true).includes(phrase))

      expect([description.includes(RETRY_KILL_LATER_PHRASE), description.includes(NEVER_DELETE_ROW_PHRASE)]).toEqual([true, true])
      expect([text.includes(RETRY_KILL_LATER_PHRASE), text.includes(NEVER_DELETE_ROW_PHRASE)]).toEqual(inQuote)
      expect(inQuote).toEqual(version === KILL_FAILURE_VERSION_SURVIVOR ? [false, false] : [true, true])
      expect([own.includes(RETRY_KILL_LATER_PHRASE), own.includes(NEVER_DELETE_ROW_PHRASE)]).toEqual([false, false])
      const keepsRetrying = version === KILL_FAILURE_VERSION_ORDINARY && closing === KILL_FAILURE_CLOSING_DESTINATION
      expect(own.includes(KILL_FAILURE_ORDINARY_DESTINATION_CLOSING)).toBe(keepsRetrying)
      assertNoLeak(text)
    },
  )
})

// ---------------------------------------------------------------------------
// The survivor version
// ---------------------------------------------------------------------------

/** Each of the survivor version's routes, with its closing kind and sentence. */
const SURVIVOR_ROUTES: ReadonlyArray<readonly [string, KillFailureAlertContext, boolean, KillFailureClosing, string]> = [
  ['a configured persona\'s destination', KILL_FAILURE_CONTEXT_RECOVERY, true, KILL_FAILURE_CLOSING_DESTINATION, KILL_FAILURE_SURVIVOR_DESTINATION_CLOSING],
  ['a CLI teardown', KILL_FAILURE_CONTEXT_CLI_TEARDOWN, true, KILL_FAILURE_CLOSING_CLI_TEARDOWN, KILL_FAILURE_SURVIVOR_CLI_TEARDOWN_CLOSING],
  ['a start-sweep kill', KILL_FAILURE_CONTEXT_START_SWEEP, false, KILL_FAILURE_CLOSING_LOG_ONLY, KILL_FAILURE_SURVIVOR_LOG_ONLY_CLOSING],
]

describe('kill-failure alert: the survivor version (b.jg5 SRJ-1007, HO rev 17, rev 22)', () => {
  test.each(SURVIVOR_ROUTES)('for %s: its body quoting the stub\'s survivor description redacted, then its own closing sentence', (_label, context, configured, closing, sentence) => {
    const description = survivorDescription()
    const route = selectKillFailureAlertRoute({ version: KILL_FAILURE_VERSION_SURVIVOR, context, configured, latched: false })
    expect([route.closing, route.closingSentence]).toEqual([closing, sentence])

    for (const forSlack of [false, true]) {
      const body = killFailureSurvivorBody({ session: personaTmuxSessionName(KEY), survivorDescription: description, forSlack })
      const text = killFailureAlertText({ version: KILL_FAILURE_VERSION_SURVIVOR, session: personaTmuxSessionName(KEY), survivorDescription: description }, route.closing, forSlack)
      expect(text).toBe(`${body} ${sentence}`)
      expect(body).toContain(quoted(description, forSlack))
      expect(body).toContain(` ${JSON.stringify(personaTmuxSessionName(KEY))}, `)
      expect(body).toContain(forSlack ? escapeSlackControlCharacters(REDACTED_SENTINEL_TAIL) : REDACTED_SENTINEL_TAIL)
      assertNoLeak(text)
    }
  })

  test('a latched persona\'s destination takes the survivor version\'s destination sentence (it has no latched row)', () => {
    expect(killFailureClosingSentence(KILL_FAILURE_VERSION_SURVIVOR, KILL_FAILURE_CLOSING_DESTINATION_LATCHED)).toBe(KILL_FAILURE_SURVIVOR_DESTINATION_CLOSING)
    const route = selectKillFailureAlertRoute({ version: KILL_FAILURE_VERSION_SURVIVOR, context: KILL_FAILURE_CONTEXT_RECOVERY, configured: true, latched: true })
    expect([route.closing, route.closingSentence]).toEqual([KILL_FAILURE_CLOSING_DESTINATION, KILL_FAILURE_SURVIVOR_DESTINATION_CLOSING])
  })

  // `<pid list>`: one entry per pid the description's survivor clause names
  // (the pin case states one entry's form), in its order, joined with ", ";
  // never the worker's own pid, which the worker-and-survivor form names
  // beside the clause.
  test.each<[string, readonly number[], KillFailedOptions]>([
    ['one pid', STUB_SURVIVOR_PIDS, {}],
    ['two pids', [STUB_SURVIVOR_PIDS[0]!, STUB_SURVIVOR_PIDS[0]! + 1], {}],
    ['two pids, the larger first', [STUB_SURVIVOR_PIDS[0]! + 1, STUB_SURVIVOR_PIDS[0]!], {}],
    ['one pid, the worker\'s pid beside it', STUB_SURVIVOR_PIDS, { workerAlsoRunning: true }],
    ['two pids, the worker\'s pid beside them', [STUB_SURVIVOR_PIDS[0]!, STUB_SURVIVOR_PIDS[0]! + 1], { workerAlsoRunning: true }],
  ])('the pid list from a description naming %s: each survivor pid once, in the description\'s order, in the body; never the worker\'s pid', (_label, pids, options) => {
    const description = survivorDescription(pids, options)
    const list = killFailureSurvivorPidList(description)
    const entries = pids.map((pid) => killFailureSurvivorPidList(survivorDescription([pid])))

    expect(entries.map((entry, i) => entry.endsWith(` ${pids[i]}`))).toEqual(pids.map(() => true))
    expect(list).toBe(entries.join(', '))
    expect(description.includes(String(STUB_WORKER_PID))).toBe(options.workerAlsoRunning === true)
    expect(list).not.toContain(String(STUB_WORKER_PID))
    const body = killFailureSurvivorBody({ session: personaTmuxSessionName(KEY), survivorDescription: description, forSlack: true })
    expect(body.indexOf(list)).toBeGreaterThan(-1)
    expect(body.indexOf(list)).toBeLessThan(body.indexOf(quoted(description, true)))
    assertNoLeak(body)
  })

  // A long session name can put the survivor clause past the cap (b.jg5
  // SRJ-1001): the pid list is read from the raw description, the quote is
  // capped.
  test('a description whose survivor clause starts past the cap: the pid list names every survivor pid; the quoted description is capped before the clause', () => {
    const pids = [STUB_SURVIVOR_PIDS[0]!, STUB_SURVIVOR_PIDS[0]! + 1]
    const sessionName = `${sentinelInMessage('kill-failure-alert-past-cap')} ${'x'.repeat(MAX_LOGGED_MESSAGE_LENGTH)}`
    const description = killFailedDescriptionOf(errTmuxKillFailed(sessionName, 'pane-process-survived', pids, { workerAlsoRunning: true }))!
    const list = killFailureSurvivorPidList(description)

    expect(description.indexOf(SURVIVOR_CLAUSE_MANY_PHRASE)).toBeGreaterThan(MAX_LOGGED_MESSAGE_LENGTH)
    expect(renderLogMessageText(description).length).toBe(MAX_LOGGED_MESSAGE_LENGTH)
    expect(list).toBe(killFailureSurvivorPidList(survivorDescription(pids)))
    expect(pids.map((pid) => list.includes(String(pid)))).toEqual(pids.map(() => true))
    expect(list).not.toContain(String(STUB_WORKER_PID))
    for (const forSlack of [false, true]) {
      const body = killFailureSurvivorBody({ session: personaTmuxSessionName(KEY), survivorDescription: description, forSlack })
      expect(body.indexOf(list)).toBeGreaterThan(-1)
      expect(body.indexOf(list)).toBeLessThan(body.indexOf(quoted(description, forSlack)))
      expect(quoted(description, forSlack)).not.toContain(SURVIVOR_CLAUSE_MANY_PHRASE)
      for (const pid of pids) expect(quoted(description, forSlack)).not.toContain(String(pid))
      assertNoLeak(body)
    }
  })

  // At the release candidate's length (its `tmux: agent process still
  // running: instance <id>: ` opening, a 5-character key, the worker and
  // three survivors) the description is over the cap. This case pins what the
  // code does today: the pid list is complete, read from the raw description,
  // and the quote is capped, which cuts agent-director's closing "never
  // delete this row". Whether a cut quote is acceptable is an open question
  // of the E37–E38 final review; this case states the present behaviour, not
  // a ruling.
  test('a description at the release candidate\'s length (a 5-character key, the worker and three survivors): the pid list names every survivor pid; the quote is capped', () => {
    const key = 'abcde'
    const pids = [STUB_SURVIVOR_PIDS[0]!, STUB_SURVIVOR_PIDS[0]! + 1, STUB_SURVIVOR_PIDS[0]! + 2]
    const description = killFailedDescriptionOf(errTmuxKillFailed(personaTmuxSessionName(key), 'pane-process-survived', pids, { workerAlsoRunning: true }))!
    const list = killFailureSurvivorPidList(description)
    const rendered = renderLogMessageText(description)

    expect(description.length).toBeGreaterThan(MAX_LOGGED_MESSAGE_LENGTH)
    expect(description).toContain(personaInstanceId(key))
    expect(list).toBe(pids.map((pid) => killFailureSurvivorPidList(survivorDescription([pid]))).join(', '))
    expect(list).not.toContain(String(STUB_WORKER_PID))
    expect(rendered.length).toBe(MAX_LOGGED_MESSAGE_LENGTH)
    expect(description.startsWith(rendered.slice(0, -1))).toBe(true)
    expect([description.includes(NEVER_DELETE_ROW_PHRASE), rendered.includes(NEVER_DELETE_ROW_PHRASE)]).toEqual([true, false])
    for (const forSlack of [false, true]) {
      const body = killFailureSurvivorBody({ session: personaTmuxSessionName(key), survivorDescription: description, forSlack })
      expect(body).toContain(`: ${list}. `)
      expect(body).toContain(`agent-director said: ${quoted(description, forSlack)}. `)
      assertNoLeak(body)
    }
  })

  test.each([...CLOSINGS])('closing %s: no command (no code span opening with agent-director or tmux) and none of the ordinary version\'s closing sentences or their clauses', (closing) => {
    const text = killFailureAlertText({ version: KILL_FAILURE_VERSION_SURVIVOR, session: personaTmuxSessionName(KEY), survivorDescription: survivorDescription() }, closing, true)
    const clauses = ORDINARY_CLOSINGS.flatMap((sentence) => sentence.split(/[:;,]\s+|\s+and\s+/)).filter((clause) => clause.split(' ').length >= 3)

    expect(commandSpans(text)).toEqual([])
    expect(commandSpans(ordinaryBody(undefined, true))).not.toEqual([])
    expect(clauses.filter((clause) => text.includes(clause))).toEqual([])
    assertNoLeak(text)
  })
})

// ---------------------------------------------------------------------------
// The log line and entry form
// ---------------------------------------------------------------------------

describe('kill-failure alert: the log-line and startup-errors form (b.jg5 SRJ-1007)', () => {
  test.each(KILL_FAILURE_CONTEXTS.flatMap((context) => [[context, `persona=${KEY}`], [context, `instanceId=${personaInstanceId(LAUNCH_START_PRE_PERSONA_KEY)}`]] as const))(
    'context %s, reference %s: the text follows the reference and the context',
    (context, ref) => {
      const text = killFailureAlertText(
        { version: KILL_FAILURE_VERSION_ORDINARY, session: STUB_TMUX_SESSION_NAME, instanceId: personaInstanceId(KEY), quotes: { lastKillFailedDescription: stubDescription('outlived-exit-wait') } },
        KILL_FAILURE_CLOSING_LOG_ONLY,
        false,
      )
      const entry = killFailureAlertEntryText(ref, context, text)

      expect(entry).toBe(`${ref} (${context}): ${text}`)
      expect(renderKillFailureAlertEntryContext(context)).toBe(context)
      assertNoLeak(entry)
    },
  )

  // b.jg5 SRJ-909, SRJ-1013: the CLI's `persona-kill-failed` and
  // `persona-kill-survivor` entries name the command that ran the teardown.
  test.each(CLI_COMMANDS.flatMap((command) => VERSIONS.map((version) => [command, version] as const)))(
    'a CLI teardown run by %s, %s version: the context names the command after the CLI-teardown context',
    (command, version) => {
      const content: KillFailureAlertContent =
        version === KILL_FAILURE_VERSION_SURVIVOR
          ? { version, session: personaTmuxSessionName(KEY), survivorDescription: survivorDescription() }
          : { version, session: personaTmuxSessionName(KEY), instanceId: personaInstanceId(KEY), quotes: { lastKillFailedDescription: stubDescription('outlived-exit-wait') } }
      const route = selectKillFailureAlertRoute({ version, context: KILL_FAILURE_CONTEXT_CLI_TEARDOWN, configured: true, latched: false })
      const text = killFailureAlertText(content, route.closing, false)
      const context = killFailureCliTeardownEntryContext(command)
      const ref = `persona=${KEY}`
      const entry = killFailureAlertEntryText(ref, context, text)

      expect(context).toEqual({ context: KILL_FAILURE_CONTEXT_CLI_TEARDOWN, command })
      expect(Object.isFrozen(context)).toBe(true)
      expect(renderKillFailureAlertEntryContext(context)).toBe(`${KILL_FAILURE_CONTEXT_CLI_TEARDOWN}, ${command}`)
      expect(entry).toBe(`${ref} (${KILL_FAILURE_CONTEXT_CLI_TEARDOWN}, ${command}): ${text}`)
      expect(entry).not.toBe(killFailureAlertEntryText(ref, KILL_FAILURE_CONTEXT_CLI_TEARDOWN, text))
      for (const other of CLI_COMMANDS.filter((c) => c !== command)) {
        expect(entry).not.toBe(killFailureAlertEntryText(ref, killFailureCliTeardownEntryContext(other), text))
      }
      assertNoLeak(entry)
    },
  )
})

// ---------------------------------------------------------------------------
// The retry's decision as the alert's content and as a log line's descriptions
// ---------------------------------------------------------------------------

describe('kill-failure alert: the bounded retry\'s decision as what the alert says and as the log line\'s descriptions', () => {
  const session = personaTmuxSessionName(KEY)
  const instanceId = personaInstanceId(KEY)
  /** A description as the log line quotes it: redacted on one line, capped, JSON-quoted. */
  const logQuoted = (description: string): string => JSON.stringify(renderLogMessageText(description))
  const last = stubDescription('unverifiable-session-present')
  const earlier = survivorDescription()
  const ordinary = (quotes: KillFailureOrdinaryQuotes): KillFailureAlertContent => ({ version: KILL_FAILURE_VERSION_ORDINARY, session, instanceId, quotes })

  const DECISIONS: ReadonlyArray<readonly [string, KillRetryAlert, KillFailureAlertContent | undefined, string]> = [
    ['none', { kind: KILL_RETRY_ALERT_NONE }, undefined, 'no description'],
    ['survivor', { kind: KILL_RETRY_ALERT_SURVIVOR, survivorDescription: earlier }, { version: KILL_FAILURE_VERSION_SURVIVOR, session, survivorDescription: earlier }, `survivor-naming=${logQuoted(earlier)}`],
    ['ordinary, the last kill failure\'s description only', { kind: KILL_RETRY_ALERT_ORDINARY, lastKillFailedDescription: last }, ordinary({ lastKillFailedDescription: last }), `last=${logQuoted(last)}`],
    ['ordinary, the earlier survivor-naming description only', { kind: KILL_RETRY_ALERT_ORDINARY, earlierSurvivorDescription: earlier }, ordinary({ earlierSurvivorDescription: earlier }), `earlier survivor-naming=${logQuoted(earlier)}`],
    ['ordinary, both', { kind: KILL_RETRY_ALERT_ORDINARY, lastKillFailedDescription: last, earlierSurvivorDescription: earlier }, ordinary({ lastKillFailedDescription: last, earlierSurvivorDescription: earlier }), `last=${logQuoted(last)} earlier survivor-naming=${logQuoted(earlier)}`],
    ['ordinary, no description', { kind: KILL_RETRY_ALERT_ORDINARY }, ordinary({}), 'no description'],
  ]

  test.each(DECISIONS)('a %s decision: its content (none for a none decision; the survivor version names no instance id) and its log descriptions, each redacted and JSON-quoted, the last first', (_label, decision, content, descriptions) => {
    expect(killFailureAlertContentOf(decision, session, instanceId)).toStrictEqual(content)
    expect(describeKillFailureDescriptions(decision)).toBe(descriptions)
    assertNoLeak(descriptions)
  })

  // The content carries each description raw; it is redacted only where a
  // text is rendered (the alert's text, and the log line's descriptions).
  test.each(DECISIONS.filter(([, decision]) => decision.kind !== KILL_RETRY_ALERT_NONE && Object.keys(decision).length > 1))(
    'a %s decision: the content carries each description raw; the alert\'s text and the log descriptions carry it redacted',
    (_label, decision) => {
      const content = killFailureAlertContentOf(decision, session, instanceId)!
      const raw = content.version === KILL_FAILURE_VERSION_SURVIVOR ? [content.survivorDescription] : Object.values(content.quotes ?? {})
      expect(raw).toEqual(Object.entries(decision).flatMap(([field, value]) => (field === 'kind' ? [] : [value])))

      const rendered = [describeKillFailureDescriptions(decision), ...[false, true].map((forSlack) => killFailureAlertText(content, KILL_FAILURE_CLOSING_LOG_ONLY, forSlack))]
      for (const description of raw) {
        expect(renderLogMessageText(description)).not.toBe(description)
        expect(rendered[1]).toContain(quoted(description, false))
        expect(rendered[2]).toContain(quoted(description, true))
        for (const text of rendered) expect(text).not.toContain(description)
      }
      assertNoLeak(rendered)
    },
  )
})

// ---------------------------------------------------------------------------
// Route selection (SRJ-704, SRJ-1013)
// ---------------------------------------------------------------------------

/**
 * SRJ-704's routing, first match wins, for either version, as this case
 * table states it: a start-sweep kill (an `orphan-cleanup` entry); a CLI
 * teardown (printed, a `persona-kill-failed` entry); a persona teardown (a
 * `persona-teardown-notice` entry); a persona no longer in the applied
 * configuration, an old-life wait's kill always (a `persona-kill-failed`
 * entry); any other persona in the applied configuration (its destination,
 * the ordinary version opening its episode). The survivor version's entry is
 * of its own class on every route that writes one, and only the ordinary
 * version at a destination reads `latched`.
 */
function expectedRoute(version: KillFailureAlertVersion, context: KillFailureAlertContext, configured: boolean, latched: boolean): KillFailureAlertRoute {
  const survivor = version === KILL_FAILURE_VERSION_SURVIVOR
  const logOnly = (route: string, ordinaryClass: string, closing: KillFailureClosing, printed = false): KillFailureAlertRoute =>
    ({ route, destination: false, classLabel: survivor ? PERSONA_KILL_SURVIVOR_LABEL : ordinaryClass, printed, opensEpisode: false, closing, closingSentence: killFailureClosingSentence(version, closing) }) as KillFailureAlertRoute
  if (context === KILL_FAILURE_CONTEXT_START_SWEEP) return logOnly(KILL_FAILURE_ROUTE_START_SWEEP, ORPHAN_CLEANUP_LABEL, KILL_FAILURE_CLOSING_LOG_ONLY)
  if (context === KILL_FAILURE_CONTEXT_CLI_TEARDOWN) return logOnly(KILL_FAILURE_ROUTE_CLI_TEARDOWN, PERSONA_KILL_FAILED_LABEL, KILL_FAILURE_CLOSING_CLI_TEARDOWN, true)
  if (context === KILL_FAILURE_CONTEXT_PERSONA_TEARDOWN) return logOnly(KILL_FAILURE_ROUTE_PERSONA_TEARDOWN, PERSONA_TEARDOWN_NOTICE_LABEL, KILL_FAILURE_CLOSING_LOG_ONLY)
  if (context === KILL_FAILURE_CONTEXT_OLD_LIFE_WAIT || !configured) return logOnly(KILL_FAILURE_ROUTE_NOT_CONFIGURED, PERSONA_KILL_FAILED_LABEL, KILL_FAILURE_CLOSING_LOG_ONLY)
  const closing = !survivor && latched ? KILL_FAILURE_CLOSING_DESTINATION_LATCHED : KILL_FAILURE_CLOSING_DESTINATION
  return { route: KILL_FAILURE_ROUTE_DESTINATION, destination: true, printed: false, opensEpisode: !survivor, closing, closingSentence: killFailureClosingSentence(version, closing) }
}

const ROUTE_ROWS = KILL_FAILURE_CONTEXTS.flatMap((context) =>
  VERSIONS.flatMap((version) => [true, false].flatMap((configured) => [false, true].map((latched) => [context, version, configured, latched] as const))),
)

describe('kill-failure alert: route selection (b.jg5 SRJ-704, SRJ-1013)', () => {
  test('every context SRJ-1007 lists, in its order', () => {
    expect([...KILL_FAILURE_CONTEXTS]).toEqual([
      KILL_FAILURE_CONTEXT_START_SWEEP,
      KILL_FAILURE_CONTEXT_CLI_TEARDOWN,
      KILL_FAILURE_CONTEXT_PERSONA_TEARDOWN,
      KILL_FAILURE_CONTEXT_OLD_LIFE_WAIT,
      KILL_FAILURE_CONTEXT_STUCK_LAUNCH_ABORT,
      KILL_FAILURE_CONTEXT_RECOVERY,
    ])
  })

  test('the classes: the start sweep\'s (which reconcileOrphans\' own entries share) is orphan-cleanup; the ordinary version\'s persona-kill-failed; the survivor version\'s persona-kill-survivor', () => {
    expect([ORPHAN_CLEANUP_LABEL, PERSONA_KILL_FAILED_LABEL, PERSONA_KILL_SURVIVOR_LABEL]).toEqual(['orphan-cleanup', 'persona-kill-failed', 'persona-kill-survivor'])
  })

  test.each(ROUTE_ROWS)('context %s, %s version, configured %p, latched %p: the route, class, print, episode and closing sentence SRJ-704 gives', (context, version, configured, latched) => {
    const route = selectKillFailureAlertRoute({ version, context, configured, latched })

    expect({ ...route }).toEqual({ ...expectedRoute(version, context, configured, latched) })
    expect(route.closingSentence).toBe(killFailureClosingSentence(version, route.closing))
  })

  // Non-vacuity of the table above: each route, class and closing occurs.
  test('the table reaches every route, every class and both destination closings', () => {
    const routes = ROUTE_ROWS.map(([context, version, configured, latched]) => selectKillFailureAlertRoute({ version, context, configured, latched }))

    expect(new Set(routes.map((r) => r.route))).toEqual(
      new Set([KILL_FAILURE_ROUTE_START_SWEEP, KILL_FAILURE_ROUTE_CLI_TEARDOWN, KILL_FAILURE_ROUTE_PERSONA_TEARDOWN, KILL_FAILURE_ROUTE_NOT_CONFIGURED, KILL_FAILURE_ROUTE_DESTINATION]),
    )
    expect(new Set(routes.flatMap((r) => (r.classLabel === undefined ? [] : [r.classLabel])))).toEqual(
      new Set([ORPHAN_CLEANUP_LABEL, PERSONA_KILL_FAILED_LABEL, PERSONA_TEARDOWN_NOTICE_LABEL, PERSONA_KILL_SURVIVOR_LABEL]),
    )
    expect(new Set(routes.filter((r) => r.destination).map((r) => r.closing))).toEqual(new Set([KILL_FAILURE_CLOSING_DESTINATION, KILL_FAILURE_CLOSING_DESTINATION_LATCHED]))
    expect(routes.filter((r) => r.printed).map((r) => r.route)).toEqual(routes.filter((r) => r.route === KILL_FAILURE_ROUTE_CLI_TEARDOWN).map((r) => r.route))
  })
})

// ---------------------------------------------------------------------------
// The alerts layer: every SRJ-1002 context, and a stopped retry's record
// (SRJ-702, SRJ-704, SRJ-1002, SRJ-1013; AC 64)
// ---------------------------------------------------------------------------

/** Every closing sentence of either version: none may appear in a stopped retry's entry, which carries no alert text. */
const ALL_CLOSING_SENTENCES: readonly string[] = VERSIONS.flatMap((version) => CLOSINGS.map((closing) => killFailureClosingSentence(version, closing)))

/** The head of every kill-retry line the alerts-layer cases' bounded retries write. */
const RETRY_PREFIX = '[slack] kill-failure-alert-test'

/** A row state that is live: the stub's default `status` row. */
const LIVE_STATE = cannedStatusResult().state

/** An ErrTmuxUnresponsive at a kill, a fake token in its description. */
const unresponsiveAtKill = (): Error => errTmuxUnresponsive('kill', `tmux did not answer (${sentinelInMessage('alerts-unresponsive')})`)

/** An ErrTmuxKillFailed naming no survivor, a fake token in its quoted session. */
const plainKillFailedAtKill = (): Error => errTmuxKillFailed(sentinelInMessage('alerts-kill-failed'), 'outlived-exit-wait')

/** The survivor-naming ErrTmuxKillFailed, a fake token in its quoted session. */
const survivorKillFailedAtKill = (): Error => errTmuxKillFailed(sentinelInMessage('alerts-survivor'), 'pane-process-survived')

/**
 * One bounded retry of `instanceId`'s kill on a fake clock: each try answers
 * the next of `answers` (the last repeating), each read between tries reads
 * the row live. Answers its result once it settles, no timer left pending.
 */
async function retryOnClock(
  instanceId: string,
  answers: readonly Error[],
  extra: { readonly keepGoing?: () => boolean; readonly holdEnded?: () => boolean } = {},
): Promise<KillRetryResult> {
  const clock = createFakeClock()
  let tries = 0
  const work = runKillRetry({
    instanceId,
    kill: async () => killOutcomeOf({ thrown: answers[Math.min(tries++, answers.length - 1)] }),
    read: async () => ({ kind: KILL_RETRY_READ_STATE, state: LIVE_STATE }),
    wait: clock,
    lastRead: KILL_RETRY_SEED_LIVE_UNREAD,
    ...(extra.keepGoing === undefined ? {} : { keepGoing: extra.keepGoing }),
    ...(extra.holdEnded === undefined ? {} : { holdEnded: extra.holdEnded }),
    log: (line) => {
      assertNoLeak(line)
    },
    logPrefix: RETRY_PREFIX,
  })
  let settled = false
  void work.then(() => {
    settled = true
  })
  for (let step = 0; step < 10 && !settled; step++) {
    await clock.flush()
    if (!settled && clock.pendingCount() > 0) await clock.runNext()
  }
  const result = await work
  expect(clock.pendingCount()).toBe(0)
  return result
}

/**
 * A bounded retry stopped between tries (SRJ-702), each decision its stop
 * can leave: the `none` decision (an ErrTmuxUnresponsive stop with no
 * survivor-naming failure), the ordinary decision quoting an
 * ErrTmuxKillFailed naming no survivor, and the ordinary decision quoting an
 * earlier survivor-naming ErrTmuxKillFailed. Each row: its label, the retry,
 * the decision's kind and the survivor-naming error quoted, if any.
 */
const STOPPED_RETRIES: ReadonlyArray<readonly [string, (id: string) => Promise<KillRetryResult>, KillRetryAlert['kind'], (() => Error) | undefined]> = [
  ['an ErrTmuxUnresponsive try, then the stop, no survivor-naming failure (the none decision)', (id) => retryOnClock(id, [unresponsiveAtKill()], { keepGoing: () => false }), KILL_RETRY_ALERT_NONE, undefined],
  ['an ErrTmuxKillFailed naming no survivor, then the stop (ordinary)', (id) => retryOnClock(id, [plainKillFailedAtKill()], { keepGoing: () => false }), KILL_RETRY_ALERT_ORDINARY, undefined],
  ['a survivor-naming ErrTmuxKillFailed, an ErrTmuxUnresponsive try, then the stop (ordinary, quoting the earlier survivor-naming description)', (id) => {
    let asks = 0
    return retryOnClock(id, [survivorKillFailedAtKill(), unresponsiveAtKill()], { keepGoing: () => ++asks <= 2 })
  }, KILL_RETRY_ALERT_ORDINARY, survivorKillFailedAtKill],
]

describe('kill-failure alert: the alerts layer over every SRJ-1002 context, and a stopped retry\'s record (b.jg5 SRJ-702, SRJ-704, SRJ-1002, SRJ-1013; AC 64)', () => {
  let baseDir: string
  let logDir: string
  let h: NotifierHarness
  /** A persona of the applied configuration. */
  let kept: Persona
  /** A persona an apply removed from it. */
  let removed: Persona
  /** The alerts' `[slack]` lines. */
  let lines: string[]
  let alerts: KillFailureAlerts

  beforeEach(() => {
    baseDir = mkdtempSync(join(tmpdir(), 'cscb-kill-failure-alert-'))
    logDir = join(baseDir, 'state')
    const config = makeMultiPersonaConfig([{ name: 'Kilo Alerts' }, { name: 'Romeo Alerts' }], baseDir)
    ;[kept, removed] = config.personas as [Persona, Persona]
    h = makeNotifierHarness(config, { leakMarker: LEAK_SENTINEL })
    h.personas.splice(h.personas.findIndex((p) => p.key === removed.key), 1) // an apply removed it
    // As main() builds them: configured is "in the applied persona set now",
    // and the log-only route is recordStartupError (here into logDir).
    ;({ lines, alerts } = makeNoticeAlertsRig(h, { logDir, omitStderr: true }))
  })

  afterEach(() => {
    try {
      assertNoLeak({ lines, logs: h.logs, slack: h.allPosts(), entries: readStartupEntries(logDir), notifierEntries: h.startupEntries() })
    } finally {
      setPersonaKillKeepGoingQuery(undefined)
      h.hold.cancelAll()
      h.cleanup()
      rmSync(baseDir, { recursive: true, force: true })
    }
  })

  /** The entries the log-only route wrote. */
  const entries = (): StartupEntry[] => readStartupEntries(logDir)

  /** Nothing reached Slack through any persona's client, and the notifier wrote no entry of its own. */
  async function expectNoSlack(): Promise<void> {
    await h.clock.flush()
    expect(h.totalPosts()).toBe(0)
    expect(h.startupEntries()).toEqual([])
  }

  /** What `decision` says for `key`'s own row. */
  function contentFor(key: string, decision: KillRetryAlert): KillFailureAlertContent {
    const content = killFailureAlertContentOf(decision, personaTmuxSessionName(key), personaInstanceId(key))
    if (content === undefined) throw new Error('precondition: the decision calls for an alert')
    return content
  }

  /** `entry` carries no alert text: no closing sentence of either version. */
  function expectNoAlertText(entry: StartupEntry): void {
    expect(ALL_CLOSING_SENTENCES.filter((sentence) => entry.text.includes(sentence))).toEqual([])
  }

  // b.jg5 SRJ-704, SRJ-1002, SRJ-1013: the start sweep, a CLI teardown, a
  // persona teardown, an old-life wait's kill and a persona no longer in the
  // applied configuration reach the log and one entry of their class, never a
  // destination; only an applied persona outside those contexts gets its
  // destination. Each case raises for the applied persona and the removed one
  // beside it.
  test.each(KILL_FAILURE_CONTEXTS.flatMap((context) => VERSIONS.map((version) => [context, version] as const)))(
    'context %s, %s version: the applied persona and the removed one each take SRJ-704\'s route; a log-only route writes one entry of its class and posts nothing, a destination posts once through the persona\'s own client',
    async (context, version) => {
      const decision: KillRetryAlert =
        version === KILL_FAILURE_VERSION_SURVIVOR
          ? { kind: KILL_RETRY_ALERT_SURVIVOR, survivorDescription: survivorDescription() }
          : { kind: KILL_RETRY_ALERT_ORDINARY, lastKillFailedDescription: stubDescription('outlived-exit-wait') }

      const expectedEntries: StartupEntry[] = []
      for (const persona of [kept, removed]) {
        const route = expectedRoute(version, context, persona === kept, false)
        expect([persona.key, alerts.raise({ key: persona.key, decision, latched: false, context })]).toEqual([persona.key, route.destination ? 'posted' : 'logged'])
        if (route.destination) continue
        const ref = `persona=${persona.key}`
        const text = killFailureAlertText(contentFor(persona.key, decision), route.closing, false)
        expectedEntries.push({
          classLabel: route.classLabel!,
          text: route.classLabel === PERSONA_TEARDOWN_NOTICE_LABEL ? personaTeardownNoticeEntryText(ref, text) : killFailureAlertEntryText(ref, context, text),
        })
      }
      await h.clock.flush()

      const keptRoute = expectedRoute(version, context, true, false)
      expect(h.posts(kept.key)).toEqual(
        keptRoute.destination
          ? [{ channel: kept.permission_prompts!, text: formatPersonaNotice(kept, killFailureAlertText(contentFor(kept.key, decision), keptRoute.closing, true)) }]
          : [],
      )
      expect(h.posts(removed.key)).toEqual([])
      expect(entries()).toEqual(expectedEntries)
      expect(h.startupEntries()).toEqual([])
      expect([alerts.isOpen(removed.key), alerts.isOpen(kept.key)]).toEqual([false, keptRoute.opensEpisode])
    },
  )

  // b.jg5 SRJ-702, SRJ-704, SRJ-1003: a launch or recovery attempt's kill
  // tries stopped between tries post nothing and raise neither version,
  // whatever their decision (`none` included). An applied persona's stop, by
  // its teardown, by its stopping being up or by a server shutdown, writes
  // the one line only, quoting the survivor-naming description when a try
  // returned one, and no startup-errors entry; a persona removed during the
  // tries gets that line and one persona-kill-failed entry with no alert
  // text, never persona-teardown-notice.
  const STOP_CAUSES: ReadonlyArray<readonly [string, PersonaKillKeepGoingQuery | undefined, string | undefined, string]> = [
    ['its teardown (the live-row sequence names its own stop)', undefined, liveRowStopCauseText(LIVE_ROW_STOP_TEARDOWN), liveRowStopCauseText(LIVE_ROW_STOP_TEARDOWN)],
    ['its stopping being up', { isShuttingDown: () => false, isPersonaUp: () => false }, undefined, PERSONA_KILL_STOP_CAUSE_NOT_UP],
    ['a server shutdown', { isShuttingDown: () => true, isPersonaUp: () => true }, undefined, PERSONA_KILL_STOP_CAUSE_SHUTDOWN],
    ['a cause the server cannot tell (no keep-going query)', undefined, undefined, PERSONA_KILL_STOP_CAUSE_GENERIC],
  ]

  // Every stop cause and decision in the recovery context; the stuck-launch
  // abort's context changes only the word the line and entry name, so it
  // takes one row.
  const STOP_ROWS = STOP_CAUSES.flatMap(([causeLabel, query, given, cause]) =>
    STOPPED_RETRIES.map(([retryLabel, retry, kind, survivor]) => [causeLabel, retryLabel, query, given, cause, retry, kind, survivor] as const),
  )
  test.each([
    ...STOP_ROWS.map((row) => [KILL_FAILURE_CONTEXT_RECOVERY, ...row] as const),
    [KILL_FAILURE_CONTEXT_STUCK_LAUNCH_ABORT, ...STOP_ROWS[0]!] as const,
  ])('a %s kill stopped by %s, after %s: the applied persona gets the one line only, the removed one that line and one persona-kill-failed entry with no alert text; nothing posted, no episode', async (context, _causeLabel, _retryLabel, query, given, cause, retry, kind, survivor) => {
    setPersonaKillKeepGoingQuery(query)
    const stoppedTexts: string[] = []
    for (const persona of [kept, removed]) {
      const retried = await retry(personaInstanceId(persona.key))
      expect([retried.end, retried.alert.kind, killRetryStopped(retried)]).toEqual([KILL_RETRY_END_STOPPED, kind, true])
      raisePersonaKillFailureAlert(persona.key, retried, 'kill-failure-alert-test', `persona=${persona.key}`, context, alerts, given)
      const stopped = killFailureStoppedRetryText({ key: persona.key, decision: retried.alert, context, lastOutcomeClass: AD_ERROR_CLASS_UNAVAILABLE, stopCause: cause })
      if (survivor !== undefined) expect(stopped.line).toContain(JSON.stringify(renderLogMessageText(killFailedDescriptionOf(survivor())!)))
      stoppedTexts.push(stopped.line, stopped.entry)
    }
    const [keptLine, , removedLine, removedEntry] = stoppedTexts

    expect(lines[0]).toBe(keptLine)
    expect(lines[1]).toBe(removedLine)
    expect(lines).toHaveLength(3) // the removed persona's entry-written line
    expect(lines[2]).toContain(PERSONA_KILL_FAILED_LABEL)
    expect(entries()).toEqual([{ classLabel: PERSONA_KILL_FAILED_LABEL, text: removedEntry }])
    expectNoAlertText(entries()[0]!)
    expect(lines.filter((line) => line.includes(PERSONA_TEARDOWN_NOTICE_LABEL))).toEqual([])
    await expectNoSlack()
    expect([alerts.isOpen(kept.key), alerts.isOpen(removed.key)]).toEqual([false, false])
  })

  // b.jg5 SRJ-702, SRJ-811: an old-life wait's kill stopped at a server
  // shutdown or at the teardown of the last persona waiting on it: the old
  // key's persona-kill-failed entry naming the wait's reference, with no
  // alert text; nothing posted. The context's route is always the log-only
  // one, so an old key still applied (a destructive modify's old half) gets
  // its entry too.
  test.each(
    [OLD_LIFE_WAIT_STOP_CAUSE_SHUTDOWN, OLD_LIFE_WAIT_STOP_CAUSE_TEARDOWN].flatMap((cause) =>
      STOPPED_RETRIES.map(([retryLabel, retry, kind]) => [cause, retryLabel, retry, kind] as const),
    ),
  )('an old-life wait\'s kill stopped (%s), after %s: each old key\'s persona-kill-failed entry with no alert text; answers stopped, nothing posted', async (cause, _retryLabel, retry, kind) => {
    const expected: StartupEntry[] = []
    for (const persona of [kept, removed]) {
      const instanceId = personaInstanceId(persona.key)
      const ref = oldLifeWaitRef(instanceId, persona.key)
      const retried = await retry(instanceId)
      expect(retried.alert.kind).toBe(kind)
      const input = { key: persona.key, decision: retried.alert, latched: false, context: KILL_FAILURE_CONTEXT_OLD_LIFE_WAIT, instanceId, ref, stopped: true, lastOutcomeClass: AD_ERROR_CLASS_UNAVAILABLE, stopCause: cause } as const

      expect(alerts.raise(input)).toBe('stopped')
      expected.push({ classLabel: PERSONA_KILL_FAILED_LABEL, text: killFailureStoppedRetryText(input).entry })
    }

    expect(entries()).toEqual(expected)
    for (const entry of entries()) expectNoAlertText(entry)
    await expectNoSlack()
  })

  // b.jg5 SRJ-702, SRJ-714: a start-sweep kill stopped at a shutdown, raised
  // here: its orphan-cleanup entry naming the row, with no alert text.
  test.each(STOPPED_RETRIES)('a start-sweep kill stopped at a shutdown, after %s: one orphan-cleanup entry naming the row, with no alert text; answers stopped, nothing posted', async (_label, retry, kind) => {
    const instanceId = personaInstanceId(kept.key)
    const retried = await retry(instanceId)
    expect(retried.alert.kind).toBe(kind)
    const input = { key: kept.key, decision: retried.alert, latched: false, context: KILL_FAILURE_CONTEXT_START_SWEEP, ref: `instanceId=${instanceId}`, stopped: true, lastOutcomeClass: AD_ERROR_CLASS_UNAVAILABLE, stopCause: START_SWEEP_KILL_STOP_SHUTDOWN } as const

    expect(alerts.raise(input)).toBe('stopped')

    expect(entries()).toEqual([{ classLabel: ORPHAN_CLEANUP_LABEL, text: killFailureStoppedRetryText(input).entry }])
    expectNoAlertText(entries()[0]!)
    await expectNoSlack()
  })

  // The control (b.jg5 SRJ-702, SRJ-811): an old-life wait's kill whose hold
  // ends between tries is no stop. Its tries end as a success, so no
  // persona-kill-failed entry is written; after a survivor-naming failure the
  // survivor version takes the old key's route (persona-kill-survivor), and
  // with none nothing is raised.
  test.each<[string, () => Error, string | undefined]>([
    ['a survivor-naming ErrTmuxKillFailed: the survivor version, one persona-kill-survivor entry', survivorKillFailedAtKill, PERSONA_KILL_SURVIVOR_LABEL],
    ['an ErrTmuxUnresponsive: no alert, no entry', unresponsiveAtKill, undefined],
  ])('control: an old-life wait\'s hold ends after a first try answering %s; never a persona-kill-failed entry, nothing posted', async (_label, first, classLabel) => {
    const instanceId = personaInstanceId(removed.key)
    const ref = oldLifeWaitRef(instanceId, removed.key)
    let tried = false
    const retried = await retryOnClock(instanceId, [first(), plainKillFailedAtKill()], {
      holdEnded: () => tried,
      keepGoing: () => {
        tried = true
        return true
      },
    })
    expect([retried.end, killRetryStopped(retried)]).toEqual([KILL_RETRY_END_HOLD_ENDED, false])

    const result = alerts.raise({ key: removed.key, decision: retried.alert, latched: false, context: KILL_FAILURE_CONTEXT_OLD_LIFE_WAIT, instanceId, ref, stopped: retried.end === KILL_RETRY_END_STOPPED })

    if (classLabel === undefined) {
      expect([result, retried.alert.kind]).toEqual(['none', KILL_RETRY_ALERT_NONE])
      expect(entries()).toEqual([])
      expect(lines).toEqual([])
    } else {
      expect(result).toBe('logged')
      const route = expectedRoute(KILL_FAILURE_VERSION_SURVIVOR, KILL_FAILURE_CONTEXT_OLD_LIFE_WAIT, false, false)
      expect(route.classLabel).toBe(classLabel)
      const text = killFailureAlertText(contentFor(removed.key, retried.alert), route.closing, false)
      expect(entries()).toEqual([{ classLabel, text: killFailureAlertEntryText(ref, KILL_FAILURE_CONTEXT_OLD_LIFE_WAIT, text) }])
    }
    expect(entries().filter((entry) => entry.classLabel === PERSONA_KILL_FAILED_LABEL)).toEqual([])
    await expectNoSlack()
  })
})

// ---------------------------------------------------------------------------
// Import boundary: no server-only module (E25, E26, E27, E29 and E33 reuse it)
// ---------------------------------------------------------------------------

describe('kill-failure alert: import boundary', () => {
  test('the module loads, through its runtime imports in src/, no server-only module, no Slack client module and no @slack/ package', () => {
    const { loads, forbidden } = forbiddenServerLoads('kill-failure-alert.ts')
    // Not vacuous: the walk reaches the one survivor detector and the shared renderer.
    expect(loads.modules.has('ad-description-phrases.ts')).toBe(true)
    expect(loads.modules.has('persona-connection-errors.ts')).toBe(true)
    expect(forbidden).toEqual([])
    // The CLI-teardown context takes its command as a plain string: the module loads neither CLI module.
    expect([loads.modules.has('cli.ts'), loads.modules.has('cli-teardown.ts')]).toEqual([false, false])
  })
})
