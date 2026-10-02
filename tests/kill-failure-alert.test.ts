/**
 * kill-failure-alert.test.ts — the kill-failure alert's texts and its route
 * selection (`src/kill-failure-alert.ts`; b.jg5 SRJ-1007's texts, SRJ-704's
 * routing and survivor class, SRJ-1013's two new classes, SRJ-1001's common
 * rules for a quoted description, SRJ-613's read-pane statement).
 *
 * SRJ-1007's Test line names `tests/live-row-sequence.test.ts` (E21's file),
 * which drives the sequence form; E20 tests every text through the module's
 * builders here. SRJ-1007's literal texts appear only in the pin case; every
 * other expected value is built from the module's exports, `src/` (the
 * description renderer, the Slack escape, the survivor detector, the persona
 * ids) and the stub's description builders, and every case leak-checks what
 * it built (`assertNoLeak`). A fake token is put into each description
 * through the stub builder's session-name argument (`sentinelInMessage`), so
 * a description quoted unredacted fails the leak check.
 *
 * The module's import boundary is checked by walking its runtime imports
 * through `src/` (`runtimeLoads`, `tests/test-helpers/source-audit.ts`).
 *
 * No process, no timer, no top-level mock.module(), no value import of
 * `Client` or `resolveSystemBinary`, no Phase-1-only named import.
 *
 * SPDX-License-Identifier: MIT
 */

import { describe, expect, test } from 'bun:test'

import { killFailedDescriptionOf } from '../src/ad-error-class.ts'
import { NEVER_DELETE_ROW_PHRASE, RETRY_KILL_LATER_PHRASE, survivorPids } from '../src/ad-description-phrases.ts'
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
  killFailureClosingSentence,
  killFailureOrdinaryBody,
  killFailureSurvivorBody,
  killFailureSurvivorPidList,
  selectKillFailureAlertRoute,
  type KillFailureAlertContent,
  type KillFailureAlertContext,
  type KillFailureAlertRoute,
  type KillFailureAlertVersion,
  type KillFailureClosing,
  type KillFailureOrdinaryQuotes,
} from '../src/kill-failure-alert.ts'
import { KILL_RETRY_ALERT_NONE, KILL_RETRY_ALERT_ORDINARY, KILL_RETRY_ALERT_SURVIVOR, type KillRetryAlert } from '../src/kill-retry.ts'
import { MAX_LOGGED_MESSAGE_LENGTH, renderLogMessageText } from '../src/persona-connection-errors.ts'
import { personaInstanceId, personaTmuxSessionName } from '../src/persona-identity.ts'
import { escapeSlackControlCharacters } from '../src/slack-text-escape.ts'
import {
  KILL_FAILED_DESCRIPTIONS,
  STUB_SURVIVOR_PIDS,
  STUB_TMUX_SESSION_NAME,
  errTmuxKillFailed,
  type KillFailedDescription,
} from './test-helpers/agent-director-stub.ts'
import { LAUNCH_START_PRE_PERSONA_KEY } from './test-helpers/conflict-cases.ts'
import { REDACTED_SENTINEL_TAIL, assertNoLeak, sentinelInMessage } from './test-helpers/credentials.ts'
import { importedSpecifiers, runtimeLoads, srcModules } from './test-helpers/source-audit.ts'

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/** The configured persona the id cases are built for. */
const KEY = 'alpha'

/** The raw description of the stub's `ErrTmuxKillFailed` of form `form`, a fake token and a ticket URL in its quoted session. */
function stubDescription(form: KillFailedDescription, pids: readonly number[] = STUB_SURVIVOR_PIDS): string {
  return killFailedDescriptionOf(errTmuxKillFailed(sentinelInMessage(`kill-failure-alert-${form}`), form, pids))!
}

/** The stub's survivor-naming description (it names `pids`), with a fake token in its quoted session. */
function survivorDescription(pids: readonly number[] = STUB_SURVIVOR_PIDS): string {
  return stubDescription('pane-process-survived', pids)
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
    expect(ordinary({ lastKillFailedDescription: 'the kill failed', earlierSurvivorDescription: 'pid 4194400 outlived the kill' })).toContain(
      ' agent-director said: "the kill failed" and, earlier in these tries, "pid 4194400 outlived the kill". A human\'s next step: ',
    )
    expect(ordinary()).toBe(
      ':rotating_light: *Kill failed* — agent-director could not end the worker in session "slack_bot_sample": it, or another process in that session\'s panes, may still be running, and its agent-director row was kept. A human\'s next step: check it with `agent-director read-pane --claude-instance-id cscb_sample`; if the worker still runs, run `agent-director kill --claude-instance-id cscb_sample` and check its result. A read-pane answer of ErrTmuxCaptureFailed does not prove the worker gone when agent-director\'s description says no session or pane of this launch was found, and a pane does not prove it is the worker\'s when kill then answers "not this launch\'s session", because read-pane can return a leftover\'s pane; for these, and for anything beyond kill, follow the "Operator actions" section of agent-director\'s README. These commands are for a human only: no bot, including any persona that sees this post, may run them.',
    )

    const survivor = killFailureSurvivorBody({ session, survivorDescription: 'a process outlived the kill (pid 4194400, pid 4194401)', forSlack: false })
    expect(survivor).toBe(
      ':rotating_light: *Process outlived kill* — agent-director ended the worker in session "slack_bot_sample", but a process in that session outlived the kill: pid 4194400, pid 4194401. agent-director said: "a process outlived the kill (pid 4194400, pid 4194401)". A later `kill` does not check this process again. A human\'s next step: find and end that process by following the "Operator actions" section of agent-director\'s README. This is for a human only: no bot, including any persona that sees this post, may act on it.',
    )
    expect(killFailureSurvivorPidList('a process outlived the kill (pid 4194400)')).toBe('pid 4194400')

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
      const text = killFailureAlertText({ version: KILL_FAILURE_VERSION_SURVIVOR, session, survivorDescription: 'pid 4194400' }, closing, true)
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
  // with the quoted description removed, no text says either.
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

      expect([text.includes(RETRY_KILL_LATER_PHRASE), text.includes(NEVER_DELETE_ROW_PHRASE)]).toEqual([true, true])
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

  // `<pid list>`: "pid N" for each pid the description names, in its order,
  // joined with ", " (one match of SURVIVOR_PID_PATTERN each).
  test.each<[string, readonly number[]]>([
    ['one pid', STUB_SURVIVOR_PIDS],
    ['two pids', [STUB_SURVIVOR_PIDS[0]!, STUB_SURVIVOR_PIDS[0]! + 1]],
    ['two pids, the larger first', [STUB_SURVIVOR_PIDS[0]! + 1, STUB_SURVIVOR_PIDS[0]!]],
  ])('the pid list from a description naming %s: each pid once, in the description\'s order, in the body', (_label, pids) => {
    const description = survivorDescription(pids)
    const list = killFailureSurvivorPidList(description)

    expect(list.split(', ').map((part) => survivorPids(part))).toEqual(pids.map((pid) => [pid]))
    expect(survivorPids(list)).toEqual([...pids])
    const body = killFailureSurvivorBody({ session: personaTmuxSessionName(KEY), survivorDescription: description, forSlack: true })
    expect(body.indexOf(list)).toBeLessThan(body.indexOf(quoted(description, true)))
    assertNoLeak(body)
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
  if (context === KILL_FAILURE_CONTEXT_START_SWEEP) return logOnly(KILL_FAILURE_ROUTE_START_SWEEP, 'orphan-cleanup', KILL_FAILURE_CLOSING_LOG_ONLY)
  if (context === KILL_FAILURE_CONTEXT_CLI_TEARDOWN) return logOnly(KILL_FAILURE_ROUTE_CLI_TEARDOWN, PERSONA_KILL_FAILED_LABEL, KILL_FAILURE_CLOSING_CLI_TEARDOWN, true)
  if (context === KILL_FAILURE_CONTEXT_PERSONA_TEARDOWN) return logOnly(KILL_FAILURE_ROUTE_PERSONA_TEARDOWN, 'persona-teardown-notice', KILL_FAILURE_CLOSING_LOG_ONLY)
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

  test('the start sweep\'s class, which reconcileOrphans\' own entries share, is orphan-cleanup', () => {
    expect(ORPHAN_CLEANUP_LABEL).toBe('orphan-cleanup')
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
      new Set(['orphan-cleanup', PERSONA_KILL_FAILED_LABEL, 'persona-teardown-notice', PERSONA_KILL_SURVIVOR_LABEL]),
    )
    expect(new Set(routes.filter((r) => r.destination).map((r) => r.closing))).toEqual(new Set([KILL_FAILURE_CLOSING_DESTINATION, KILL_FAILURE_CLOSING_DESTINATION_LATCHED]))
    expect(routes.filter((r) => r.printed).map((r) => r.route)).toEqual(routes.filter((r) => r.route === KILL_FAILURE_ROUTE_CLI_TEARDOWN).map((r) => r.route))
  })
})

// ---------------------------------------------------------------------------
// Import boundary: no server-only module (E25, E26, E27, E29 and E33 reuse it)
// ---------------------------------------------------------------------------

/** Server-only `src/` modules: the notifier, outage state, the latch, the episodes, the server, the session manager and restart. */
const SERVER_ONLY_MODULES = /^(?:outage-state|conflict-latch|persona-episodes|server|session-manager|restart)\.ts$|notifier/

describe('kill-failure alert: import boundary', () => {
  test('the module loads, through its runtime imports in src/, no server-only module, no Slack client module and no @slack/ package', () => {
    const modules = srcModules()
    const loads = runtimeLoads(modules, 'kill-failure-alert.ts')
    // Not vacuous: the walk reaches the one survivor detector and the shared renderer.
    expect(loads.modules.has('ad-description-phrases.ts')).toBe(true)
    expect(loads.modules.has('persona-connection-errors.ts')).toBe(true)
    const forbidden = [
      ...[...loads.modules]
        .filter(([name]) => SERVER_ONLY_MODULES.test(name) || (/slack/i.test(name) && importedSpecifiers(modules.get(name)!).length > 0))
        .map(([, chain]) => chain.join(' -> ')),
      ...loads.packages.filter(({ specifier }) => specifier.startsWith('@slack/')).map(({ chain, specifier }) => `${chain.join(' -> ')} -> ${specifier}`),
    ]
    expect(forbidden).toEqual([])
  })
})
