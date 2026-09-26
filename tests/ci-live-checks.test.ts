/**
 * ci-live-checks.test.ts — Tests for the /ci-live runner's check framework
 * and the checks a dry run runs for real (bug b.1cx): `ci-live/checks/
 * framework.ts` (skips, blocking, the verdict), `checks/list.ts` (the plan
 * order, the HOST and Teardown checks), `lib/host-state.ts` (the read-only
 * snapshot of the production side of the host), Checks S2, S3 and 29a
 * (`checks/setup-checks.ts`, `checks/lifecycle-checks.ts`) and Check 28's
 * failed revocation against a fake container, and the pure helpers the live
 * checks build on (`checks/helpers.ts`, `checks/channel-checks.ts`,
 * `checks/context.ts`).
 *
 * The rules under test:
 * - a failed blocking check skips every later check except the `always`
 *   ones (29a, Teardown, HOST); a check that throws is a FAIL; the verdict is
 *   PASS only when nothing failed; a missing need is skipped with the
 *   runner's reason when it gives one (a second account needing a code);
 * - a dry run (no workspace) runs exactly the pre-flight, install, setup,
 *   S2, S3, 29a, Teardown and HOST checks;
 * - no live check passes against a silent workspace (nothing answers);
 * - HOST fails on any change to the host's service=cscb rows, CSCB tmux
 *   sessions, port-3100 listener or config.json hash, and on a probe that
 *   failed (even the same way twice); its probes only read, on CSCB's own
 *   agent-director store;
 * - 29a fails on any token-shaped or credential count, on a host-side scan
 *   finding, on missing output, and on a persona this run brought up and
 *   dispatched a message to that has no transcript; an empty or malformed
 *   count is a parse failure (NaN), never 0, so it never skips a scan or a
 *   persona's transcript;
 * - Checks 16 and 20 ask A for the outbound call at most twice: a second ask
 *   only when A said done but made no new call; A that never says done is a
 *   FAIL; no call after two asks is Check 16's "not run" (SKIPPED) and a FAIL
 *   in Check 20; only a call made after the check's baseline is evaluated;
 * - Check 8 asks for a bug when the RAW prefix lacks user/bot_id; Check 9
 *   falls back to the message text and needs one RAW line of each kind;
 *   `waitTags` polls to a deadline; Check 12's limit search fails on any
 *   line but the known Slack rate-limit ones;
 * - Check 12's stop bans nothing, and once coordination is quiet (and after
 *   the limit search) the stop is lifted in coordination, and in both
 *   terminals with no Escape when the stop was typed there; the lift runs
 *   even when a step after the stop throws, and a lift Slack refuses is a
 *   note; the plan gives the same texts;
 * - `tags` and `tagstext` (the container's helpers and the plan's copy, run
 *   by bash over a fixture transcript) read a delivery from a user entry or,
 *   when it arrived mid-turn, a `queued_command` attachment (a string prompt
 *   or content blocks), once, never from the queue entries;
 * - Check 28: a failed revocation of B's older app-level token, whatever
 *   threw (a FlowError or any other error, such as Playwright's timeout), is
 *   the finding "step 7: revoke failed: <the error described>", with a note
 *   that the token may still be valid; B is not asked for "rotated", and the
 *   rest of step 7 and step 8's revert still run;
 * - the texts the checks expect match what the package writes (the pending
 *   file header, the preview counts, the reload-applied line, the S3 error,
 *   and the start summary's buckets in their order);
 * - a start's summary line must end with the current ending, `0 failed, 0 not
 *   brought up, 0 not reconnected` (b.f2b's last bucket): the ending before
 *   b.f2b, any non-zero count in it and `10 failed` are findings, and the plan
 *   quotes the same ending and Check 1's line;
 * - the guarded restart and Check 28's start after the reboot wait for each
 *   persona's Session connected line, not only the summary: a persona that
 *   connects after the summary (parked on a `working` row, b.f2b) is no
 *   finding, and one that never connects is.
 *
 * No docker, network or real host state: the container, the host probes, the
 * test human's session and the clock are fakes; the transcript helpers run
 * in bash with a temp HOME.
 *
 * SPDX-License-Identifier: MIT
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { parsePersonaConfigBytes } from '../src/config.ts'
import { checkPersonaTarget } from '../src/registry.ts'
import { renderAppliedLogLine } from '../src/reload-apply.ts'
import { PENDING_FILE_HEADER } from '../src/reload-fingerprint.ts'
import { PENDING_PREVIEW_TITLE, renderChangePlanCounts, type ChangePlanCounts, type ValidChangePlan } from '../src/reload-plan.ts'
import {
  CHECK12_LIFT,
  CHECK12_PANE_STOP,
  CHECK12_STOP,
  check12,
  check12Start,
  CHECK5_PROMPT_1,
  CHECK5_PROMPT_2,
  check8,
  check9,
  COMPLETE_FIRST_START,
  expectOneTag,
  judgeLimitLines,
  rawShape,
  tagAttr,
  typeIntoPane,
} from '../ci-live/checks/channel-checks.ts'
import { DRY_RUN_IDS, liveIdsFrom, type CheckContext } from '../ci-live/checks/context.ts'
import type { CheckPromptGuard, PromptExpectation } from '../ci-live/checks/prompt-guard.ts'
import {
  callsTo,
  check16,
  check20,
  check23,
  CHECK18_PROMPT,
  CHECK22_PROMPT,
  CHECK23_B_EXTRA,
  CHECK23_PROMPT_A,
  CHECK23_PROMPT_B,
  newCallTo,
  OUTBOUND_ASKS,
  outboundNext,
} from '../ci-live/checks/dm-checks.ts'
import { Findings, NEED_SKIP_REASONS, runChecks, skipReason, verdictOf, type CheckDef, type CheckResult, type Need } from '../ci-live/checks/framework.ts'
import {
  appliedLine,
  checkPreview,
  checkStartLines,
  commandMatches,
  countsText,
  guardedRestart,
  hasWord,
  isPrompt,
  parsePending,
  PENDING_HEADER,
  previewHeader,
  promptState,
  q,
  retriedBringUps,
  retryFailureClass,
  S,
  START_SUMMARY_END,
  TAG_TIMEOUT_MS,
  waitTags,
} from '../ci-live/checks/helpers.ts'
import { check28, CHECK27_PROMPT, check29a, parseCount, parseLeakcount, parsePersonaCounts, personaCountsProblem } from '../ci-live/checks/lifecycle-checks.ts'
import { FINAL_CHECKS, hostCheck, PLAN_CHECKS, teardownCheck } from '../ci-live/checks/list.ts'
import { s2Check, s3Check } from '../ci-live/checks/setup-checks.ts'
import { FlowError, type BrowserDriver, type HumanApi } from '../ci-live/lib/browser-types.ts'
import type { ContainerExec } from '../ci-live/lib/container.ts'
import {
  compareSnapshots,
  describeSnapshot,
  hostStorePath,
  parseAdRows,
  parseListenInodes,
  parseTmuxSessions,
  probeFailures,
  snapshotHost,
  type HostSnapshot,
} from '../ci-live/lib/host-state.ts'
import { HumanSession } from '../ci-live/lib/human-session.ts'
import { buildLiveConfig, renderConfig } from '../ci-live/lib/live-config.ts'
import type { ProcResult } from '../ci-live/lib/proc.ts'
import { RESULTS_COLUMNS } from '../ci-live/lib/results.ts'
import type { PersonaLetter } from '../ci-live/lib/personas.ts'
import { MINUTE, SECOND } from '../ci-live/lib/wait.ts'
import { emptyAppsState } from '../ci-live/lib/apps-state.ts'
import { virtualClock } from './test-helpers/ci-live.ts'
import { APP_TOKEN_PREFIX, assertNoLeak, BOT_TOKEN_PREFIX, fakeToken, LEAK_SENTINEL } from './test-helpers/credentials.ts'

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/** A container's answer: its stdout, a partial result, or stdout computed per call from the script. */
type Reply = Partial<ProcResult> | string | ((script: string) => string)

/** A container whose `sh` answers by the first key its script contains; every script is recorded. */
function fakeContainer(answers: ReadonlyArray<readonly [string, Reply]>) {
  const scripts: string[] = []
  const done = (reply: Reply, script = ''): ProcResult => {
    const r = typeof reply === 'function' ? reply(script) : reply
    return { code: 0, stdout: '', stderr: '', timedOut: false, ...(typeof r === 'string' ? { stdout: r } : r) }
  }
  const container: ContainerExec = {
    name: 'cscb-live-1700000000',
    exec: async () => done(''),
    sh: async (script) => {
      scripts.push(script)
      return done(answers.find(([key]) => script.includes(key))?.[1] ?? '', script)
    },
    writeFile: async () => {},
  }
  return { container, scripts }
}

const SNAPSHOT: HostSnapshot = { adRows: ['cscb_prod_a'], tmuxSessions: ['slack_bot_prod_a'], port3100: '4242', configSha256: 'a'.repeat(64) }

/** A prompt guard that records what a check declares and how often it asks for its leftovers to be denied; it denies `leftovers` of them. */
function recordingGuard(leftovers = 0): CheckPromptGuard & { expected: PromptExpectation[]; sweeps: number } {
  const guard = {
    expected: [] as PromptExpectation[],
    sweeps: 0,
    expect: (e: PromptExpectation) => {
      guard.expected.push(e)
    },
    denyLeftovers: async () => {
      guard.sweeps++
      return leftovers
    },
  }
  return guard
}

function makeCtx(overrides: Partial<CheckContext> = {}): CheckContext {
  const info: string[] = []
  return {
    mode: 'dry-run',
    runId: '1700000000',
    container: fakeContainer([]).container,
    hostName: 'cscb-live-1700000000',
    clock: virtualClock(),
    log: { info: (m) => info.push(m), detail: (m) => info.push(m) },
    runNotes: [],
    ids: DRY_RUN_IDS,
    human: null,
    second: null,
    browser: null,
    creds: {
      moveDIntoMount: () => {},
      rewriteBAppToken: async () => {},
      mountedCount: () => 3,
      bAppTokenName: () => 'cscb-live',
      setBAppTokenName: () => {},
    },
    shared: {},
    promptGuard: recordingGuard(),
    restartContainer: async () => {},
    hostScan: () => ({ counts: [], total: 0 }),
    hostBefore: SNAPSHOT,
    hostNow: async () => ({ ...SNAPSHOT }),
    removeContainer: async () => true,
    ...overrides,
  }
}

interface CannedMessage {
  ts: string
  text: string
  user: string
}

/**
 * The test human's session over a scripted workspace: each post gets the
 * next `1700000100.00000N` ts; history lists the channel's posts and its
 * canned messages from `oldest` on (as Slack does); threads are empty.
 */
function scriptedHuman(clock: CheckContext['clock'], canned: Record<string, CannedMessage[]> = {}) {
  let n = 0
  const posts: { channel: string; text: string; ts: string }[] = []
  const api: HumanApi = {
    call: async (method, params = {}) => {
      const channel = String(params.channel ?? '')
      if (method === 'chat.postMessage') {
        const ts = `1700000100.${String(++n).padStart(6, '0')}`
        posts.push({ channel, text: String(params.text), ts })
        return { ok: true, ts }
      }
      if (method === 'conversations.history') {
        const all = [...posts.filter((p) => p.channel === channel).map((p) => ({ ...p, user: DRY_RUN_IDS.humanUserId })), ...(canned[channel] ?? [])]
        return { ok: true, messages: all.filter((m) => m.ts >= String(params.oldest ?? '0')) }
      }
      if (method === 'conversations.open') return { ok: true, channel: { id: 'D0DRYDM001' } }
      return { ok: true, messages: [] }
    },
  }
  return { human: new HumanSession(api, clock), posts }
}

/** A browser that does nothing (its generated token is a sentinel-bearing fake). */
function idleBrowser(): BrowserDriver {
  return {
    ensureSignedIn: async () => 'signed-in',
    submitSignInCode: async () => 'signed-in',
    humanApi: async () => ({ call: async () => ({ ok: true }) }),
    installApp: async () => fakeToken(BOT_TOKEN_PREFIX, 'idle'),
    generateAppToken: async () => fakeToken(APP_TOKEN_PREFIX, 'idle'),
    revokeAppToken: async () => {},
    clickMessageButton: async () => {},
    saveState: async () => {},
    close: async () => {},
  }
}

function check(id: string, extra: Partial<CheckDef<null>> & { outcome?: CheckResult | Error } = {}): CheckDef<null> {
  const { outcome = { status: 'PASS', evidence: [] }, ...rest } = extra
  return {
    id,
    title: `check ${id}`,
    needs: [],
    row: id,
    run: async () => {
      if (outcome instanceof Error) throw outcome
      return outcome
    },
    ...rest,
  }
}

const FAILED: CheckResult = { status: 'FAIL', reason: 'broke', evidence: [] }

/**
 * `since '<mark>'`, alone or piped to one `grep -F -- '<text>'` or
 * `grep -E -- '<re>'` (as the check helpers write them), over `log`; null for
 * any other script.
 */
function sinceOver(script: string, log: readonly string[]): string | null {
  const m = /^since '[^']*'(?: \| grep -([FE]) -- '((?:[^']|'\\'')*)')?$/.exec(script)
  if (!m) return null
  const pattern = (m[2] ?? '').replace(/'\\''/g, "'")
  const kept = m[1] === undefined ? log : log.filter((l) => (m[1] === 'F' ? l.includes(pattern) : new RegExp(pattern).test(l)))
  return kept.join('\n')
}

/** A start's summary line for three personas, two resumed and one parked, with `ending` after the no-op count. */
function startSummary(ending: string): string {
  return (
    '[slack] startupSessionManager: complete — 3 persona(s): 2 resumed, 0 fresh-spawned, 0 fresh-after-amnesia, ' +
    `0 fresh-after-inconclusive-amnesia, 0 reconnected, 0 no-op, ${ending}`
  )
}

/**
 * A start from the record, each line with the seconds after the start at which
 * it is logged. A and B connect before the summary. C's launch waits on a
 * `working` row (b.f2b), so the summary leaves it out and C connects `cAt` s
 * after the start (never, when null).
 */
function startLog(cAt: number | null, ending = START_SUMMARY_END): [number, string][] {
  const connected = (l: PersonaLetter) => `[slack] Session connected: persona "persona_${l}" (key=persona_${l}) cwd="/home/cscb/cscb-live/${l}"`
  return [
    [20, `[slack] Starting from the last-applied record "${S}/config.json.last-applied"`],
    [20, '[slack] Loaded persona config: 3 persona(s)'],
    ...(['a', 'b', 'c'] as const).map((l, i): [number, string] => [25, `[slack] persona-start: personas[${i}] "persona_${l}" (key=persona_${l}): bring-up starting`]),
    [80, connected('a')],
    [90, connected('b')],
    [100, startSummary(ending)],
    [100, '[slack] startupSessionManager: 1 persona(s) still waiting in the background for a working row to settle — not counted above; each logs its outcome when it settles (b.f2b)'],
    ...(cAt === null ? [] : [[cAt, connected('c')] as [number, string]]),
  ]
}

/**
 * server.log holding `log`'s lines, each shown once the virtual clock is its
 * seconds past `begin()` (the start, or the reboot); nothing before.
 * `since(script)` answers a `since` script as `sinceOver` does.
 */
function timedLog(clock: CheckContext['clock'], log: readonly (readonly [number, string])[]) {
  let at: number | null = null
  const shown = () => (at === null ? [] : log.filter(([s]) => clock.now() >= at! + s * SECOND).map(([, l]) => l))
  return {
    begin: () => {
      at = clock.now()
    },
    since: (script: string) => sinceOver(script, shown()),
  }
}

// ---------------------------------------------------------------------------
// The framework
// ---------------------------------------------------------------------------

describe('skipReason', () => {
  const all = new Set<Need>(['workspace', 'claude', 'second-user'])
  test.each([
    ['a fixed skip, even for an always check', check('x', { skip: 'manual only', always: true }), 'a', [], all, 'manual only'],
    ['a block', check('x'), 'a', [], all, 'blocked by a'],
    ['an always check under a block', check('x', { always: true }), 'a', [], all, null],
    ['a prerequisite under a block', check('x', { prerequisite: true }), 'a', [], all, 'blocked by a'],
    ['a block before --only', check('x'), 'a', ['y'], all, 'blocked by a'],
    ['a check --only leaves out', check('x'), null, ['y'], all, 'not selected'],
    ['a prerequisite --only leaves out', check('x', { prerequisite: true }), null, ['y'], all, null],
    ['an always check --only leaves out', check('x', { always: true }), null, ['y'], all, null],
    ['--only before a missing need', check('x', { needs: ['workspace'] }), null, ['y'], new Set<Need>(), 'not selected'],
    ['a missing workspace', check('x', { needs: ['workspace', 'claude'] }), null, [], new Set<Need>(), NEED_SKIP_REASONS.workspace],
    ['a missing second user', check('x', { needs: ['workspace', 'second-user'] }), null, [], new Set<Need>(['workspace']), 'no second account'],
    ['everything available', check('x', { needs: ['workspace'] }), null, ['x'], all, null],
  ] as const)('%s', (_what, def, blockedBy, only, available, expected) => {
    expect(skipReason(def, { blockedBy }, { available, only })).toBe(expected)
  })

  test("the runner's reason for a missing need replaces the default one (a second account that needs a sign-in code), in runChecks too", async () => {
    const needReasons = { 'second-user': 'second account needs a sign-in code: run login --second' }
    const needsSecond = check('14', { needs: ['workspace', 'second-user'] })
    const workspaceOnly = new Set<Need>(['workspace'])
    expect(skipReason(needsSecond, { blockedBy: null }, { available: workspaceOnly, only: [], needReasons })).toBe(needReasons['second-user'])
    expect(skipReason(check('2', { needs: ['workspace'] }), { blockedBy: null }, { available: new Set(), only: [], needReasons })).toBe(NEED_SKIP_REASONS.workspace)
    const [r] = await runChecks([needsSecond], null, { available: workspaceOnly, only: [], now: () => 0, log: { info: () => {} }, needReasons })
    expect([r!.status, r!.reason]).toEqual(['SKIPPED', needReasons['second-user']])
  })
})

describe('runChecks', () => {
  test('a failed blocking check skips the rest, except always checks; fixed skips stay as they are', async () => {
    const log: string[] = []
    const seen: string[] = []
    let t = 0
    const results = await runChecks(
      [check('a', { blocking: true, outcome: FAILED }), check('b'), check('c', { always: true }), check('d', { skip: 'manual only' }), check('e', { needs: ['workspace'] })],
      null,
      { available: new Set(), only: [], now: () => (t += 5), log: { info: (m) => log.push(m) }, onResult: (r) => seen.push(r.id) },
    )
    expect(results.map((r) => [r.id, r.status, r.reason ?? null])).toEqual([
      ['a', 'FAIL', 'broke'],
      ['b', 'SKIPPED', 'blocked by a'],
      ['c', 'PASS', null],
      ['d', 'SKIPPED', 'manual only'],
      ['e', 'SKIPPED', 'blocked by a'],
    ])
    expect(seen).toEqual(['a', 'b', 'c', 'd', 'e'])
    expect(results.map((r) => r.durationMs)).toEqual([5, 5, 5, 5, 5])
    expect(log).toEqual([
      'check a: check a',
      'check a: FAIL (broke)',
      'check b: SKIPPED (blocked by a)',
      'check c: check c',
      'check c: PASS',
      'check d: SKIPPED (manual only)',
      'check e: SKIPPED (blocked by a)',
    ])
  })

  test('a check that throws is a FAIL with a described error; a failure that is not blocking blocks nothing', async () => {
    const results = await runChecks(
      [check('a', { outcome: new TypeError(`bad https://x.invalid/cb?code=${LEAK_SENTINEL}\nstack`) }), check('b', { outcome: FAILED }), check('c')],
      null,
      { available: new Set(), only: [], now: () => 0, log: { info: () => {} } },
    )
    expect(results.map((r) => [r.id, r.status, r.reason ?? null])).toEqual([
      ['a', 'FAIL', 'threw TypeError: bad https://x.invalid/cb?<query>'],
      ['b', 'FAIL', 'broke'],
      ['c', 'PASS', null],
    ])
    assertNoLeak(results)
  })

  test('the hooks run around each check that runs, never a skipped one; afterCheck gets the result (a throw\'s FAIL too) before it is recorded; a hook that throws is logged and changes no result', async () => {
    const events: string[] = []
    const log: string[] = []
    const ran = (id: string, extra: Partial<CheckDef<null>> & { outcome?: CheckResult | Error } = {}): CheckDef<null> => {
      const def = check(id, extra)
      return {
        ...def,
        run: async (ctx) => {
          events.push(`run ${id}`)
          return def.run(ctx)
        },
      }
    }
    const results = await runChecks(
      [ran('a'), ran('b', { skip: 'manual only' }), ran('c', { outcome: new Error('boom') }), ran('d'), ran('e', { outcome: FAILED })],
      null,
      {
        available: new Set(),
        only: [],
        now: () => 0,
        log: { info: (m) => log.push(m) },
        onResult: (r) => events.push(`recorded ${r.id}`),
        beforeCheck: (c) => {
          events.push(`before ${c.id} (${c.title})`)
          if (c.id === 'd') throw new Error('before broke')
        },
        afterCheck: async (c, r) => {
          events.push(`after ${c.id} ${r.status}`)
          if (c.id === 'e') throw new Error('after broke')
        },
      },
    )
    expect(events).toEqual([
      'before a (check a)',
      'run a',
      'after a PASS',
      'recorded a',
      'recorded b',
      'before c (check c)',
      'run c',
      'after c FAIL',
      'recorded c',
      'before d (check d)',
      'run d',
      'after d PASS',
      'recorded d',
      'before e (check e)',
      'run e',
      'after e FAIL',
      'recorded e',
    ])
    expect(results.map((r) => [r.id, r.status, r.reason ?? null])).toEqual([
      ['a', 'PASS', null],
      ['b', 'SKIPPED', 'manual only'],
      ['c', 'FAIL', 'threw Error: boom'],
      ['d', 'PASS', null],
      ['e', 'FAIL', 'broke'],
    ])
    expect(log.filter((l) => l.includes('hook failed'))).toEqual(['check d: the beforeCheck hook failed: Error: before broke', 'check e: the afterCheck hook failed: Error: after broke'])
  })
})

describe('verdictOf and Findings', () => {
  test.each([
    [[], 'PASS'],
    [[{ id: '1', status: 'PASS' }, { id: '2', status: 'SKIPPED', reason: 'x' }], 'PASS'],
    [[{ id: '1', status: 'PASS' }, { id: '5', status: 'FAIL', reason: 'no reply\n in time' }, { id: '6', status: 'FAIL', reason: 'y' }], 'FAIL: 5: no reply in time'],
    [[{ id: '7', status: 'FAIL' }], 'FAIL: 7: failed'],
  ] as const)('verdictOf(%j) is %p', (results, verdict) => {
    expect(verdictOf(results)).toBe(verdict)
  })

  test('Findings: every failed expectation joins the reason; evidence and notes are kept either way', () => {
    const ok = new Findings()
    expect(ok.expect(true, 'never')).toBe(true)
    ok.add('ts 1.2')
    ok.note('n')
    expect(ok.result()).toEqual({ status: 'PASS', evidence: ['ts 1.2'], notes: ['n'] })
    const bad = new Findings()
    expect(bad.expect(false, 'first')).toBe(false)
    bad.expect(false, 'second')
    bad.add('ts 3.4')
    expect(bad.result()).toEqual({ status: 'FAIL', reason: 'first; second', evidence: ['ts 3.4'], notes: [] })
  })
})

// ---------------------------------------------------------------------------
// The check list
// ---------------------------------------------------------------------------

describe('the check list', () => {
  const every = [...PLAN_CHECKS, ...FINAL_CHECKS]
  const runs = (available: Need[], only: string[] = []) =>
    every.filter((c) => skipReason(c, { blockedBy: null }, { available: new Set(available), only }) === null).map((c) => c.id)

  test('ids are unique and every Results-table column is filled by exactly one check', () => {
    expect(new Set(every.map((c) => c.id)).size).toBe(every.length)
    const rows = PLAN_CHECKS.map((c) => c.row).filter((r) => r !== null)
    expect([...rows].sort()).toEqual([...RESULTS_COLUMNS].sort())
  })

  test('a dry run (no workspace, no Claude) runs only the container-side checks, Teardown and HOST', () => {
    expect(runs([])).toEqual(['preflight', 'install', 'setup', 'S2', 'S3', '29a', 'teardown', 'HOST'])
  })

  test('without a second account, 14, 16 and 20 are skipped, and S1, 26 and 29b always are', () => {
    const skipped = every.filter((c) => !runs(['workspace', 'claude']).includes(c.id)).map((c) => c.id)
    expect(skipped).toEqual(['S1', '14', '16', '20', '26', '29b'])
  })

  test('--only runs the selection plus the prerequisites and the always checks', () => {
    expect(runs(['workspace', 'claude'], ['S2'])).toEqual(['preflight', 'install', 'setup', 'S2', '1', '29a', 'teardown', 'HOST'])
  })

  test('the setup checks and Check 1 are blocking', () => {
    expect(PLAN_CHECKS.filter((c) => c.blocking).map((c) => c.id)).toEqual(['preflight', 'install', 'setup', '1'])
  })
})

describe('HOST and Teardown', () => {
  test('HOST passes when the host is unchanged, with both snapshots as evidence', async () => {
    const r = await hostCheck.run(makeCtx())
    expect(r.status).toBe('PASS')
    expect(r.evidence).toEqual([`before: ${describeSnapshot(SNAPSHOT)}`, `after: ${describeSnapshot(SNAPSHOT)}`])
  })

  test('HOST fails naming every change', async () => {
    const after: HostSnapshot = { adRows: ['cscb_persona_a', 'cscb_prod_a'], tmuxSessions: ['slack_bot_prod_a'], port3100: 'none', configSha256: 'b'.repeat(64) }
    const r = await hostCheck.run(makeCtx({ hostNow: async () => after }))
    expect(r.status).toBe('FAIL')
    expect(r.reason).toBe(
      'agent-director service=cscb rows [cscb_prod_a] → [cscb_persona_a, cscb_prod_a]; port 3100 listener 4242 → none; host config.json sha256 changed',
    )
  })

  test('HOST fails when a probe failed, even the same way before and after (never a vacuous pass)', async () => {
    const failed: HostSnapshot = { ...SNAPSHOT, adRows: 'agent-director list exit 2', tmuxSessions: 'tmux ls exit 1' }
    const r = await hostCheck.run(makeCtx({ hostBefore: failed, hostNow: async () => ({ ...failed }) }))
    expect([r.status, r.reason]).toEqual([
      'FAIL',
      'probe failed before the run: agent-director list exit 2; probe failed before the run: tmux ls exit 1; ' +
        'probe failed after the run: agent-director list exit 2; probe failed after the run: tmux ls exit 1',
    ])
    const afterOnly = await hostCheck.run(makeCtx({ hostNow: async () => ({ ...SNAPSHOT, adRows: 'agent-director list: unparsable output' }) }))
    expect(afterOnly.reason).toStartWith('probe failed after the run: agent-director list: unparsable output; agent-director service=cscb rows')
    expect([probeFailures(SNAPSHOT), probeFailures(failed)]).toEqual([[], ['agent-director list exit 2', 'tmux ls exit 1']])
  })

  test('Teardown fails when the container could not be removed', async () => {
    expect((await teardownCheck.run(makeCtx())).status).toBe('PASS')
    expect(await teardownCheck.run(makeCtx({ removeContainer: async () => false }))).toMatchObject({ status: 'FAIL', reason: 'the test container could not be removed' })
  })
})

// ---------------------------------------------------------------------------
// Host state
// ---------------------------------------------------------------------------

describe('host-state', () => {
  test('parseListenInodes finds the sockets listening on the port, IPv4 and IPv6', () => {
    const tcp = [
      '  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode',
      '   0: 0100007F:0C1C 00000000:0000 0A 00000000:00000000 00:00000000 00000000  1000        0 11111 1 0 100 0 0 10 0',
      '   1: 0100007F:0C1C 0100007F:9C40 01 00000000:00000000 00:00000000 00000000  1000        0 22222 1 0 20 4 30 10 -1',
      '   2: 00000000:1F90 00000000:0000 0A 00000000:00000000 00:00000000 00000000  1000        0 33333 1 0 100 0 0 10 0',
      '   3: 00000000000000000000000000000000:0C1C 00000000000000000000000000000000:0000 0A 00000000:00000000 00:00000000 00000000  1000        0 44444 1 0',
    ].join('\n')
    expect(parseListenInodes(tcp, 3100)).toEqual(['11111', '44444'])
    expect(parseListenInodes(tcp, 443)).toEqual([])
  })

  test.each([
    ['{"spawns":[{"claude_instance_id":"cscb_b"},{"claude_instance_id":"cscb_a"},{}]}', ['?', 'cscb_a', 'cscb_b']],
    ['{"spawns":[]}', []],
    ['{}', null],
    ['not json', null],
  ])('parseAdRows(%p)', (stdout, expected) => {
    expect(parseAdRows(stdout)).toEqual(expected)
  })

  test("parseTmuxSessions keeps only the host's CSCB sessions", () => {
    expect(parseTmuxSessions('slack_bot_b\nmain\ncscb_x\n  \nmy_slack_bot_y\nslack_bot_a\n')).toEqual(['cscb_x', 'slack_bot_a', 'slack_bot_b'])
  })

  function probe(ad: Partial<ProcResult>, tmux: Partial<ProcResult>, config: Buffer | null) {
    const argv: string[][] = []
    const read: string[] = []
    const ports: number[] = []
    const res = (r: Partial<ProcResult>): ProcResult => ({ code: 0, stdout: '', stderr: '', timedOut: false, ...r })
    return {
      argv,
      read,
      ports,
      deps: {
        run: async (a: readonly string[]) => (argv.push([...a]), res(a[0] === 'tmux' ? tmux : ad)),
        readFile: (p: string) => (read.push(p), config),
        listener: (port: number) => (ports.push(port), '4242'),
      },
    }
  }

  test("snapshotHost only reads: agent-director list on CSCB's own store, tmux ls, the port-3100 listener and a hash of the config file", async () => {
    const config = Buffer.from('{"personas":[]}')
    const p = probe({ stdout: '{"spawns":[{"claude_instance_id":"cscb_prod_a"}]}' }, { stdout: 'slack_bot_prod_a\nwork\n' }, config)
    const snap = await snapshotHost(p.deps, '/home/tester')
    expect(hostStorePath('/home/tester')).toBe('/home/tester/.agent-director/state.db')
    expect(p.argv).toEqual([
      ['agent-director', '--store-path', '/home/tester/.agent-director/state.db', 'list', '--label', 'service=cscb'],
      ['tmux', 'ls', '-F', '#{session_name}'],
    ])
    expect([p.read, p.ports]).toEqual([['/home/tester/.claude/channels/slack/config.json'], [3100]])
    expect(snap).toEqual({
      adRows: ['cscb_prod_a'],
      tmuxSessions: ['slack_bot_prod_a'],
      port3100: '4242',
      configSha256: createHash('sha256').update(config).digest('hex'),
    })
  })

  test.each([
    ['no tmux server is no session', { code: 1, stderr: 'no server running on /tmp/tmux-1000/default' }, []],
    ['no tmux socket is no session', { code: 1, stderr: 'error connecting to /run/user/1000/tmux-1000/default (No such file or directory)' }, []],
    ['another tmux failure is recorded as such', { code: 1, stderr: 'error connecting to /tmp/tmux-1000/default (Permission denied)' }, 'tmux ls exit 1'],
  ])('snapshotHost: %s', async (_what, tmux, expected) => {
    const snap = await snapshotHost(probe({ code: 2 }, tmux, null).deps, '/h')
    expect([snap.tmuxSessions, snap.adRows, snap.configSha256]).toEqual([expected, 'agent-director list exit 2', 'absent'])
  })

  test('compareSnapshots names each difference, and hashes only by "changed"', () => {
    expect(compareSnapshots(SNAPSHOT, { ...SNAPSHOT })).toEqual([])
    expect(compareSnapshots(SNAPSHOT, { ...SNAPSHOT, tmuxSessions: 'tmux ls exit 1', configSha256: 'c'.repeat(64) })).toEqual([
      'tmux sessions [slack_bot_prod_a] → tmux ls exit 1',
      'host config.json sha256 changed',
    ])
  })
})

// ---------------------------------------------------------------------------
// Checks S2, S3 and 29a against a fake container
// ---------------------------------------------------------------------------

describe('Check S2', () => {
  const PASSING: Record<string, string> = {
    'sha256sum -c': 'package unchanged',
    '-type f -print | wc -l': '42\n42',
    'ls -A ~/.config/cscb/': 'persona_a-credentials.json\npersona_b-credentials.json\npersona_c-credentials.json',
    'ls -A "$S"': 'system-prompt.md\nconfig.json',
    tokcount: '0',
    'env | cut': '0',
  }
  const run = (changes: Record<string, string> = {}) => s2Check.run(makeCtx({ container: fakeContainer(Object.entries({ ...PASSING, ...changes })).container }))

  test('passes on the plan layout', async () => {
    expect((await run()).status).toBe('PASS')
  })

  test.each([
    ['an extra state file', { 'ls -A "$S"': 'config.json\nsystem-prompt.md\nserver.pid' }, 'the state dir holds more than config.json and system-prompt.md'],
    ['a changed package file', { 'sha256sum -c': '' }, 'a file of the installed package changed'],
    ['a file added to the package', { '-type f -print | wc -l': '43\n42' }, 'the package gained or lost files'],
    ["D's credentials file already mounted", { 'ls -A ~/.config/cscb/': 'persona_a-credentials.json\npersona_b-credentials.json\npersona_c-credentials.json\npersona_d-credentials.json' }, '~/.config/cscb/ holds'],
    ['a token-shaped line in config.json', { tokcount: '1' }, 'token-shaped lines in config.json: 1'],
    ['a token variable in the shell', { 'env | cut': '1' }, 'token variables set: 1'],
  ])('fails on %s', async (_what, changes, reason) => {
    const r = await run(changes)
    expect(r.status).toBe('FAIL')
    expect(r.reason).toContain(reason)
  })
})

describe('Check S3', () => {
  // The refusal as the package under test words it, for the S3 config (B given A's working directory).
  const loaderError = (() => {
    const config = buildLiveConfig(DRY_RUN_IDS)
    config.personas[1]!.working_directory = config.personas[0]!.working_directory
    try {
      parsePersonaConfigBytes(renderConfig(config), `${S}/config.json`, S, { home: '/home/testuser' })
    } catch (err) {
      return (err as Error).message
    }
    throw new Error('the S3 config loaded')
  })()
  const scr = '/home/testuser/cscb-live/scratch-state.Ab12Cd'
  const fields: Record<string, string> = {
    SCR: scr,
    WDS: '~/cscb-live/a ~/cscb-live/a ~/cscb-live/c ',
    exit: '1',
    SCRLS: 'server.log ',
    PGREP: '0',
    ROWS: '0',
    STATELS: 'config.json system-prompt.md ',
  }
  const output = (changes: Record<string, string> = {}, extra = '') =>
    [
      ...Object.entries({ ...fields, ...changes }).map(([k, v]) => `${k}=${v}`),
      `[slack] Server failed to start (exit code 1). From ${scr}/server.log:`,
      `[slack] Fatal: configuration error — ${loaderError}`,
      extra,
    ].join('\n')
  const run = (out: string) =>
    s3Check.run(makeCtx({ container: fakeContainer([['preflight.sh check1', 'pre-flight passed (check1)'], ['SLACK_STATE_DIR="$SCR"', out]]).container }))

  test("passes on the package's own refusal of the duplicate working directory", async () => {
    const r = await run(output())
    expect([r.status, r.reason]).toEqual(['PASS', undefined])
  })

  test.each([
    ['a start that exited 0', { exit: '0' }, '', 'start exited 0, not 1'],
    ['a server process left', { PGREP: '1' }, '', 'a server process remains'],
    ['an agent-director row left', { ROWS: '1' }, '', 'agent-director lists a service=cscb row'],
    ['a record in the scratch dir', { SCRLS: 'config.json.last-applied server.log' }, '', 'the scratch dir holds a record or a server.pid'],
    ['a changed state dir', { STATELS: 'config.json server.log system-prompt.md' }, '', 'the state dir changed'],
    ['a scratch server that started', {}, 'SCRATCH SERVER STARTED - stopping it', 'SCRATCH SERVER STARTED'],
  ])('fails on %s', async (_what, changes, extra, reason) => {
    const r = await run(output(changes, extra))
    expect(r.status).toBe('FAIL')
    expect(r.reason).toContain(reason)
  })

  test('fails when the refusal names another problem', async () => {
    const r = await run(output().replace(loaderError, 'loadPersonaConfig: invalid persona config: something else'))
    expect(r.status).toBe('FAIL')
  })
})

describe('Check 29a', () => {
  // The script's output; a field set to undefined is left out.
  const lines = (over: Record<string, string | undefined> = {}, leak: { f?: string[]; t?: string[]; h?: string[] } = {}) =>
    [
      ...Object.entries({ TRANSCRIPTS: '0', PENDING: 'absent', TOKF: '0', TOKT: '0', TOKH: '0', WSS: '0', MSG: '0', RURL: '2', RTOK: '1', ...over })
        .filter(([, v]) => v !== undefined)
        .map(([k, v]) => `${k}=${v}`),
      'LEAK-F',
      ...(leak.f ?? ['tokens checked: 6', `${S}/config.json: 0`, `${S}/server.log: 0`, `${S}/config.json.pending: absent`]),
      'LEAK-T',
      ...(leak.t ?? []),
      'LEAK-H',
      ...(leak.h ?? ['tokens checked: 6', '/home/testuser/.bash_history: absent']),
    ].join('\n')
  const run = (out: string, overrides: Partial<CheckContext> = {}) => check29a.run(makeCtx({ container: fakeContainer([['leakcount', out]]).container, ...overrides }))

  test('passes when every count is zero, the tokens checked match the mounted files, and the host scan is clean', async () => {
    const r = await run(lines())
    expect([r.status, r.reason]).toEqual(['PASS', undefined])
    expect(r.notes).toEqual(['Check 29a placeholders: <redacted-url> 2, <redacted-token> 1'])
    assertNoLeak(r)
  })

  test.each([
    ['a token-shaped line in a state file', lines({ TOKF: '1' }), 'the state files: count 1'],
    ['a pending file left', lines({ PENDING: 'present' }), 'config.json.pending exists'],
    ['a ticket URL in server.log', lines({ WSS: '2' }), 'wss:// or ticket= in server.log: count 2'],
    ['a token in a logged message', lines({ MSG: '1' }), 'message="…" fields: count 1'],
    ['a credential in a state file', lines({}, { f: ['tokens checked: 6', `${S}/server.log: 1`] }), 'LEAK-F: 1 file(s) hold a credential'],
    ['fewer tokens checked than the mounted files hold', lines({}, { h: ['tokens checked: 4'] }), 'LEAK-H: tokens checked 4, not 6'],
    ['no output at all', '', 'persona transcripts: NaN'],
  ])('fails on %s', async (_what, out, reason) => {
    const r = await run(out)
    expect(r.status).toBe('FAIL')
    expect(r.reason).toContain(reason)
  })

  test("an empty TRANSCRIPTS count fails as NaN, never 0, and the transcripts' leak scan still runs", async () => {
    const r = await run(lines({ TRANSCRIPTS: '' }, { t: ['tokens checked: 6', '/home/testuser/.claude/projects/-home-testuser-cscb-live-a/x.jsonl: 1'] }))
    expect([r.status, r.reason]).toEqual(['FAIL', 'persona transcripts: NaN (the scan printed no count); LEAK-T: 1 file(s) hold a credential'])
    expect(r.evidence).toContain('persona transcripts: NaN')
  })

  test.each([
    ['empty', '', NaN],
    ['blank', ' \n', NaN],
    ['zero', '0', 0],
    ['surrounding whitespace and a newline', ' 42\n', 42],
    ['a decimal', '1.5', NaN],
    ['a negative number', '-1', NaN],
    ['two numbers', '1 2', NaN],
    ['the missing-field marker', '?', NaN],
  ])('parseCount(%s) is a whole number or NaN, never 0 for a bad value', (_what, value, expected) => {
    expect(parseCount(value)).toEqual(expected)
  })

  describe('a transcript for each persona this run brought up and dispatched a message to', () => {
    const counts = { PERSONA_a: '1 3', PERSONA_b: '2 1', PERSONA_c: '1 1', PERSONA_d: '0 0' }
    const real = (over: Record<string, string | undefined>, broughtUp: CheckContext['shared']['broughtUp'], t = ['tokens checked: 6']) =>
      run(lines({ TRANSCRIPTS: '4', ...counts, ...over }, { t }), { mode: 'real', shared: { broughtUp } })

    test('passes with one per dispatched persona; a persona brought up but never dispatched to needs none, and is noted', async () => {
      const r = await real({}, ['a', 'b', 'c', 'd'])
      expect([r.status, r.reason]).toEqual(['PASS', undefined])
      expect(r.evidence).toContain('persona d: 0 transcript(s), 0 dispatched message(s)')
      expect(r.notes).toContain('Check 29a: persona d was brought up but no message was dispatched to it, so no transcript is required')
    })

    test.each([
      ['a dispatched persona with no transcript', { PERSONA_b: '0 2' }, ['a', 'b', 'c'], 'persona b was brought up and sent 2 message(s), but has no transcript'],
      ['D brought up by Check 25 with no transcript', { PERSONA_d: '0 1' }, ['a', 'b', 'c', 'd'], 'persona d was brought up and sent 1 message(s), but has no transcript'],
      ['no count printed for a persona brought up', { PERSONA_c: undefined }, ['c'], 'persona c: no transcript count'],
      ['an empty count', { PERSONA_a: '' }, ['a'], 'persona a: empty transcript count (PERSONA_a is empty, not "<transcripts> <dispatched>")'],
      ['a malformed count (one number)', { PERSONA_c: '3' }, ['c'], 'persona c: malformed transcript count (PERSONA_c is not "<transcripts> <dispatched>")'],
    ] as const)('fails on %s', async (_what, over, broughtUp, reason) => {
      const r = await real(over, [...broughtUp])
      expect([r.status, r.reason]).toEqual(['FAIL', reason])
    })

    test('an empty count is not read as "0 0" (no transcript required): no evidence line and no note for that persona', async () => {
      const r = await real({ PERSONA_b: '' }, ['a', 'b'])
      expect([r.status, r.reason]).toEqual(['FAIL', 'persona b: empty transcript count (PERSONA_b is empty, not "<transcripts> <dispatched>")'])
      expect(r.evidence.filter((l) => /^persona [a-d]:/.test(l))).toEqual(['persona a: 1 transcript(s), 3 dispatched message(s)'])
      expect((r.notes ?? []).filter((n) => n.includes('persona b'))).toEqual([])
    })

    test('under --only, a persona not brought up this run needs no transcript', async () => {
      const r = await real({ TRANSCRIPTS: '0', PERSONA_a: '0 0', PERSONA_b: '0 5', PERSONA_c: '0 5', PERSONA_d: '0 5' }, [], [])
      expect([r.status, r.reason]).toEqual(['PASS', undefined])
    })

    test("the transcripts' own leak count still fails it", async () => {
      const r = await real({}, ['a', 'b', 'c'], ['tokens checked: 6', '/home/testuser/.claude/projects/-home-testuser-cscb-live-a/x.jsonl: 2'])
      expect([r.status, r.reason]).toEqual(['FAIL', 'LEAK-T: 1 file(s) hold a credential'])
    })

    test.each([
      ['two numbers', '2 5', { transcripts: 2, delivered: 5 }],
      ['whitespace and a trailing newline', ' 0 0\n', { transcripts: 0, delivered: 0 }],
      ['empty', '', { transcripts: NaN, delivered: NaN }],
      ['blank', '  \n', { transcripts: NaN, delivered: NaN }],
      ['one number', '3', { transcripts: NaN, delivered: NaN }],
      ['three numbers', '1 2 3', { transcripts: NaN, delivered: NaN }],
      ['a decimal', '1.5 2', { transcripts: NaN, delivered: NaN }],
      ['a negative count', '1 -2', { transcripts: NaN, delivered: NaN }],
    ])('parsePersonaCounts(%s): exactly two whole numbers, else both NaN (never 0)', (_what, value, expected) => {
      expect(parsePersonaCounts(value)).toEqual(expected)
    })

    test.each([
      ['no line at all', undefined, 'persona a: no transcript count'],
      ['an empty value', '', 'persona a: empty transcript count (PERSONA_a is empty, not "<transcripts> <dispatched>")'],
      ['a blank value', ' \t', 'persona a: empty transcript count (PERSONA_a is empty, not "<transcripts> <dispatched>")'],
      ['anything else', '3', 'persona a: malformed transcript count (PERSONA_a is not "<transcripts> <dispatched>")'],
    ])('personaCountsProblem: %s', (_what, value, reason) => {
      expect(personaCountsProblem('a', value)).toBe(reason)
    })
  })

  test('fails on a host-side scan finding, reporting counts only', async () => {
    const r = await run(lines(), { hostScan: () => ({ counts: [{ source: '/results/run.log', tokenShaped: 1, knownSecrets: 0 }], total: 1 }) })
    expect(r.status).toBe('FAIL')
    expect(r.reason).toBe('the host-side scan of the results found 1 token-shaped or secret string(s)')
    expect(r.evidence).toContain('host: /results/run.log: 1 token-shaped, 0 known-secret')
  })

  test('parseLeakcount reads the count and each file (a path with ": " in it included)', () => {
    expect(parseLeakcount(['tokens checked: 6', '/a: 0', '/b: absent', '/odd: name: 3', 'noise'])).toEqual({
      checked: 6,
      files: { '/a': '0', '/b': 'absent', '/odd: name': '3' },
    })
    expect(parseLeakcount([]).checked).toBe(-1)
  })
})

// ---------------------------------------------------------------------------
// Live checks against a scripted workspace and container
// ---------------------------------------------------------------------------

const A = DRY_RUN_IDS.bots.a
const COORD = DRY_RUN_IDS.coordination

/** A live-run context: the human session over `canned` bot messages, the container answering `answers`. */
function liveCtx(canned: Record<string, CannedMessage[]>, answers: ReadonlyArray<readonly [string, Reply]>): CheckContext {
  const clock = virtualClock()
  return makeCtx({ mode: 'real', clock, human: scriptedHuman(clock, canned).human, container: fakeContainer(answers).container })
}

describe('Check 8: the persona-post event shape', () => {
  // A says "posted" in A-home, and its post in coordination is 1700000200.000002.
  const POST_TS = '1700000200.000002'
  const canned = {
    [DRY_RUN_IDS.aHome]: [{ ts: '1700000200.000001', text: 'posted', user: A.userId }],
    [COORD]: [{ ts: POST_TS, text: `<@${DRY_RUN_IDS.bots.b.userId}> shape check, no reply needed`, user: A.userId }],
  }
  const run = (raw: string) =>
    check8.run(
      liveCtx(canned, [
        [`tags b '${POST_TS}'`, `<channel source="slack" chat_id="${COORD}" user_id="${A.userId}" via="mention">`],
        [`tags a '${POST_TS}'`, ''],
        ['RAW message event persona=persona_b:', raw],
        ['dropped message from channel=', `[slack] persona "persona_a" (key=persona_a) dropped message from channel=${COORD} user=${A.userId}: own`],
        ['mark', '1:0'],
      ]),
    )

  test("passes when B's RAW line shows A's bot user or bot ID, A dropped its own post and B got one mention tag", async () => {
    const r = await run(`[slack] RAW message event persona=persona_b: {"user":"${A.userId}","bot_id":"${A.botId}","text":"shape check","ts":"${POST_TS}"}`)
    expect([r.status, r.reason]).toEqual(['PASS', undefined])
    expect(r.notes).toContain(`Check 8 RAW shape: user=${A.userId} bot_id=${A.botId} subtype=absent app_id=absent bot_profile=absent`)
  })

  test('fails, asking for a bug to be filed, when the RAW prefix was cut before user or bot_id', async () => {
    const r = await run(`[slack] RAW message event persona=persona_b: {"type":"message","ts":"${POST_TS}","text":"shape check`)
    expect([r.status, r.reason]).toEqual(['FAIL', 'file a bug: RAW prefix lacks user/bot_id (user=absent, bot_id=absent)'])
  })
})

describe('Check 9: one mention is delivered once', () => {
  const TEXT = 'reply with the word once.'
  // The human's post is the first post (1700000100.000001); A answers "once" after it.
  const HUMAN_TS = '1700000100.000001'
  const raw = (kind: 'message' | 'app_mention', withTs: boolean) =>
    `[slack] RAW ${kind} event persona=persona_a: {"user":"${DRY_RUN_IDS.humanUserId}","text":"<@${A.userId}> ${TEXT}"${withTs ? `,"ts":"${HUMAN_TS}"` : ''}`
  const run = (rawLines: string[]) =>
    check9.run(
      liveCtx({ [COORD]: [{ ts: '1700000200.000001', text: 'once', user: A.userId }] }, [
        ['Dispatching to persona', `[slack] Dispatching to persona "persona_a" (key=persona_a) chat_id=${COORD} text=<@${A.userId}> ${TEXT}`],
        ['persona=persona_a:', rawLines.join('\n')],
        [`tags a '${HUMAN_TS}'`, `<channel source="slack" chat_id="${COORD}" user_id="${DRY_RUN_IDS.humanUserId}" via="mention">`],
        ['mark', '1:0'],
      ]),
    )

  test('passes on one message and one app_mention RAW line matched by the ts', async () => {
    const r = await run([raw('message', true), raw('app_mention', true)])
    expect([r.status, r.reason]).toEqual(['PASS', undefined])
    expect(r.evidence).toContain('RAW lines matched by ts: one message, one app_mention')
  })

  test("with the ts cut off the RAW prefix, falls back to the message's text and still needs exactly one of each", async () => {
    const byText = await run([raw('message', false), raw('app_mention', false)])
    expect([byText.status, byText.reason]).toEqual(['PASS', undefined])
    expect(byText.notes).toContain('Check 9: RAW lines matched by ts: message=0 app_mention=0; by the message text: message=1 app_mention=1')
    const twice = await run([raw('message', false), raw('message', false), raw('app_mention', false)])
    expect([twice.status, twice.reason]).toEqual(['FAIL', 'RAW lines for the message: message=2 app_mention=1, not one each'])
  })
})

describe('Checks 16 and 20: the outbound reply-tool call helpers', () => {
  test('A is asked at most twice (the plan\'s "ask once more")', () => {
    expect(OUTBOUND_ASKS).toBe(2)
  })

  test.each([
    [1, true, true, 'evaluate'],
    [1, false, true, 'evaluate'],
    [1, false, false, 'silent'],
    [1, true, false, 'ask-again'],
    [2, true, true, 'evaluate'],
    [2, false, true, 'evaluate'],
    [2, false, false, 'silent'],
    [2, true, false, 'no-call'],
  ] as const)('outboundNext(asked %p, answered %p, called %p) is %p', (asked, answered, called, next) => {
    expect(outboundNext(asked, answered, called)).toBe(next)
  })

  test('callsTo matches the whole ID at the start of a replies line only (U1 is not U12)', () => {
    const replyLines = [
      'chat_id=U12 error=false result=Sent 1 message(s) to D012 (the DM with U12)',
      'chat_id=U1 error=true result=refused',
      'chat_id=C0DRYAHOME error=false result=asked about chat_id=U1 here',
      ' chat_id=U1 error=false result=indented',
      'chat_id=U1error=false result=glued',
      'chat_id=U1 error=false result=Sent 1 message(s) to D01 (the DM with U1)',
    ]
    expect(callsTo(replyLines, 'U1')).toEqual([replyLines[1], replyLines[5]])
    expect(callsTo(replyLines, 'U12')).toEqual([replyLines[0]])
    expect(callsTo(replyLines, 'U')).toEqual([])
    expect(callsTo([], 'U1')).toEqual([])
  })

  test.each([
    ['no call at all', 0, [], ''],
    ['calls to other targets only', 0, ['chat_id=U12 error=false result=a', 'chat_id=C1 error=false result=b'], ''],
    ["only the call the baseline counted (an earlier check's)", 1, ['chat_id=U1 error=true result=old'], ''],
    ['a new call after the baseline', 1, ['chat_id=U1 error=true result=old', 'chat_id=C1 error=false result=b', 'chat_id=U1 error=false result=new'], 'chat_id=U1 error=false result=new'],
    ['the newest of several new calls', 0, ['chat_id=U1 error=true result=first', 'chat_id=U12 error=false result=other', 'chat_id=U1 error=false result=second'], 'chat_id=U1 error=false result=second'],
    ['a new call to U12 is no new call to U1', 1, ['chat_id=U1 error=true result=old', 'chat_id=U12 error=false result=new'], ''],
  ])('newCallTo: %s', (_what, before, replyLines, expected) => {
    expect(newCallTo(before, replyLines, 'U1')).toBe(expected)
  })
})

describe('Checks 16 and 20 against a scripted A', () => {
  const SECOND_ID = 'U0DRYSECND'
  const NEW_DM = 'D0DRYSECDM'
  // Check 16's call as `replies a` prints it, with the package's own refusal for A (DMs off) and the second user.
  const REFUSED = (() => {
    const config = parsePersonaConfigBytes(renderConfig(buildLiveConfig(DRY_RUN_IDS)), `${S}/config.json`, S, { home: '/home/testuser' })
    const scope = checkPersonaTarget(config.personas[0]!, SECOND_ID, 'post')
    if (scope.allowed) throw new Error('A may message the second user')
    return `chat_id=${SECOND_ID} error=true result=${scope.message}`
  })()
  // Check 20's call: the DM opened, one message sent.
  const SENT = `chat_id=${SECOND_ID} error=false result=Sent 1 message(s) to ${NEW_DM} (the DM with ${SECOND_ID}) [ts: 1700000300.000001]`

  /** What A does on one ask: says done or not, and the `replies a` line of the call it makes, if any. */
  interface AskStep {
    done: boolean
    call?: string
  }

  /**
   * A-home, `replies a` and the second user's DMs, scripted per ask: each
   * human post in A-home is one ask and plays the next step (A's call lands
   * in `replies a`, then A says done). A successful call opens the DM with
   * the second user and posts A's message there. `earlier` is what
   * `replies a` printed before the check (an earlier check's call). Every
   * message gets the next ts, so A's done belongs to the ask it follows.
   */
  function scriptedA(steps: AskStep[], earlier: string[] = []) {
    const clock = virtualClock()
    let seq = 0
    const nextTs = () => `1700000100.${String(++seq).padStart(6, '0')}`
    const messages: (CannedMessage & { channel: string })[] = []
    const replyLines = [...earlier]
    const asks: { text: string; ts: string; done: string | null }[] = []
    let dmOpen = false
    const api: HumanApi = {
      call: async (method, params = {}) => {
        const channel = String(params.channel ?? '')
        if (method === 'chat.postMessage') {
          const ts = nextTs()
          messages.push({ channel, ts, text: String(params.text), user: DRY_RUN_IDS.humanUserId })
          if (channel !== DRY_RUN_IDS.aHome) return { ok: true, ts }
          const step = steps[asks.length] ?? { done: false }
          if (step.call !== undefined) {
            replyLines.push(step.call)
            if (step.call.startsWith(`chat_id=${SECOND_ID} error=false`)) {
              dmOpen = true
              messages.push({ channel: NEW_DM, ts: nextTs(), text: 'DMs-on outbound check', user: A.userId })
            }
          }
          const done = step.done ? nextTs() : null
          if (done) messages.push({ channel, ts: done, text: 'done', user: A.userId })
          asks.push({ text: String(params.text), ts, done })
          return { ok: true, ts }
        }
        if (method === 'conversations.history') {
          return { ok: true, messages: messages.filter((m) => m.channel === channel && m.ts >= String(params.oldest ?? '0')) }
        }
        if (method === 'conversations.list') return { ok: true, channels: dmOpen ? [{ id: NEW_DM, user: A.userId }] : [] }
        return { ok: true, messages: [] }
      },
    }
    const { container } = fakeContainer([['', (script) => (script === 'mark' ? '1:0' : script === 'replies a' ? replyLines.join('\n') : '')]])
    const ctx = makeCtx({ mode: 'real', clock, human: new HumanSession(api, clock), second: { human: new HumanSession(api, clock), userId: SECOND_ID }, container })
    /** The evidence line each ask should leave. */
    const askEvidence = () => asks.map((a, i) => `ask ${i + 1}: TS ${a.ts}, ${a.done ? `done ${a.done}` : 'no done from A'}`)
    return { ctx, asks, askEvidence }
  }

  async function runWith(check: CheckDef<CheckContext>, steps: AskStep[], earlier: string[] = []) {
    const a = scriptedA(steps, earlier)
    const r = await check.run(a.ctx)
    assertNoLeak(r)
    return { r, ...a }
  }

  const BOTH = [
    ['16', check16, REFUSED],
    ['20', check20, SENT],
  ] as const

  test.each(BOTH)('Check %s: A silent on the first ask is one post, then a FAIL', async (_id, check) => {
    const { r, asks, askEvidence } = await runWith(check, [{ done: false }])
    expect([r.status, r.reason]).toEqual(['FAIL', `A did not say done and made no reply-tool call to ${SECOND_ID}`])
    expect(asks.length).toBe(1)
    expect(r.evidence).toEqual(askEvidence())
    expect(r.evidence[0]).toEndWith('no done from A')
  })

  test.each(BOTH)('Check %s: done on the first ask but silent on the second is a FAIL naming the second ask', async (_id, check) => {
    const { r, asks, askEvidence } = await runWith(check, [{ done: true }, { done: false }])
    expect([r.status, r.reason]).toEqual(['FAIL', `A did not say done to the second ask and made no reply-tool call to ${SECOND_ID}`])
    expect(asks.length).toBe(2)
    expect(r.evidence).toEqual(askEvidence())
  })

  test.each(BOTH)('Check %s: no call on the first ask, the call on the second: the same ask is posted again and the call is evaluated', async (_id, check, call) => {
    const { r, asks, askEvidence } = await runWith(check, [{ done: true }, { done: true, call }])
    expect([r.status, r.reason]).toEqual(['PASS', undefined])
    expect(asks.length).toBe(2)
    expect(asks[1]!.text).toBe(asks[0]!.text)
    expect(r.evidence).toEqual(askEvidence())
  })

  test.each(BOTH)('Check %s: a call on the first ask is evaluated at once, with no second ask', async (_id, check, call) => {
    const { r, asks } = await runWith(check, [{ done: true, call }])
    expect([r.status, r.reason]).toEqual(['PASS', undefined])
    expect(asks.length).toBe(1)
  })

  test.each(BOTH)('Check %s: a call without a done is evaluated, not asked for again, and fails on the missing done', async (_id, check, call) => {
    const { r, asks } = await runWith(check, [{ done: false, call }])
    expect([r.status, r.reason]).toEqual(['FAIL', 'A did not say done'])
    expect(asks.length).toBe(1)
  })

  test('no call after two asks: exactly two posts; Check 16 is SKIPPED "not run" (not a pass) with the ask evidence, Check 20 FAILs', async () => {
    const c16 = await runWith(check16, [{ done: true }, { done: true }])
    expect([c16.r.status, c16.r.reason]).toEqual(['SKIPPED', `not run: A made no reply-tool call to ${SECOND_ID} (asked 2 times; the plan records this as "not run", not a pass)`])
    expect(c16.asks.length).toBe(2)
    expect(c16.r.evidence).toEqual(c16.askEvidence())
    expect(c16.r.evidence.length).toBe(2)
    const c20 = await runWith(check20, [{ done: true }, { done: true }])
    expect([c20.r.status, c20.r.reason]).toEqual(['FAIL', `A made no reply-tool call to ${SECOND_ID} (asked 2 times)`])
    expect(c20.asks.length).toBe(2)
    expect(c20.r.evidence).toEqual(c20.askEvidence())
  })

  test("Check 20 ignores Check 16's earlier refused call: with no new call it asks twice and FAILs; a new call is the one evaluated", async () => {
    const none = await runWith(check20, [{ done: true }, { done: true }], [REFUSED])
    expect([none.r.status, none.r.reason]).toEqual(['FAIL', `A made no reply-tool call to ${SECOND_ID} (asked 2 times)`])
    expect(none.asks.length).toBe(2)
    const fresh = await runWith(check20, [{ done: true, call: SENT }], [REFUSED])
    expect([fresh.r.status, fresh.r.reason]).toEqual(['PASS', undefined])
    expect(fresh.asks.length).toBe(1)
  })

  test("the call evaluated must be the check's own: Check 16 fails a sent message, Check 20 fails a refusal", async () => {
    const c16 = await runWith(check16, [{ done: true, call: SENT }])
    expect([c16.r.status, c16.r.reason]).toEqual(['FAIL', 'the call was not refused; the refusal text is not the expected one; the second user has a DM with A'])
    const c20 = await runWith(check20, [{ done: true, call: REFUSED }])
    expect([c20.r.status, c20.r.reason]).toEqual(['FAIL', 'the call to the second user failed; the result does not name the new DM; the second user has no DM with A'])
  })
})

describe("Check 12: the stop bans nothing, and is lifted once coordination is quiet", () => {
  const B = DRY_RUN_IDS.bots.b
  const MENTIONS = `<@${A.userId}> <@${B.userId}>`
  const BAN_RE = /do not post|don't post|never post|not post .*again/i
  /** A delivered mention tag, as `tags` prints it. */
  const tagFrom = (author: typeof A) => `<channel source="slack" chat_id="${COORD}" user_id="${author.userId}" via="mention">`

  /**
   * A and B over a workspace whose timestamps follow the virtual clock. The
   * human's post in A-home sets off the exchange in coordination: A asks, B
   * answers, three posts each. With `keepPosting`, A posts again at every
   * read of coordination after the stop until the stop is typed into the
   * personas' terminals. The container answers `mark`, `tags` (the mention
   * tag from the other persona) and the Dispatching grep; `fail` names a
   * script that throws. `events` is every human post and container script,
   * in order; `refuseLift` has Slack refuse the lift's post.
   */
  function exchange(opts: { keepPosting?: boolean; refuseLift?: boolean; fail?: string } = {}) {
    const clock = virtualClock()
    let seq = 0
    const nextTs = () => `${Math.floor(clock.now() / 1000)}.${String(++seq).padStart(6, '0')}`
    const messages: (CannedMessage & { channel: string })[] = []
    const events: string[] = []
    const posts: { channel: string; text: string; ts: string; at: number }[] = []
    let stopped = false
    let paneStopped = false
    const say = (author: typeof A, text: string) => messages.push({ channel: COORD, ts: nextTs(), text, user: author.userId })
    const api: HumanApi = {
      call: async (method, params = {}) => {
        const channel = String(params.channel ?? '')
        if (method === 'chat.postMessage') {
          const text = String(params.text)
          if (opts.refuseLift && text.includes(CHECK12_LIFT)) return { ok: false, error: 'channel_not_found' }
          const ts = nextTs()
          messages.push({ channel, ts, text, user: DRY_RUN_IDS.humanUserId })
          posts.push({ channel, text, ts, at: clock.now() })
          events.push(`post ${channel} ${text}`)
          if (channel === DRY_RUN_IDS.aHome) {
            for (let i = 1; i <= 3; i++) {
              say(A, `<@${B.userId}> question ${i}`)
              say(B, `<@${A.userId}> answer ${i}`)
            }
          }
          if (channel === COORD && text.includes(CHECK12_STOP)) stopped = true
          return { ok: true, ts }
        }
        if (method === 'conversations.history') {
          if (channel === COORD && opts.keepPosting && stopped && !paneStopped) say(A, `<@${B.userId}> one more question`)
          return { ok: true, messages: messages.filter((m) => m.channel === channel && m.ts >= String(params.oldest ?? '0')) }
        }
        return { ok: true, messages: [] }
      },
    }
    const { container } = fakeContainer([
      [
        '',
        (script) => {
          events.push(`sh ${script}`)
          if (opts.fail !== undefined && script.includes(opts.fail)) throw new Error(`container: ${opts.fail} failed`)
          if (script.includes(CHECK12_PANE_STOP)) paneStopped = true
          if (script === 'mark') return '1:0'
          if (script.startsWith('tags b ')) return tagFrom(A)
          if (script.startsWith('tags a ')) return tagFrom(B)
          if (script.includes('Dispatching to persona')) return `[slack] Dispatching to persona "persona_b" (key=persona_b) chat_id=${COORD} text=…`
          return ''
        },
      ],
    ])
    const ctx = makeCtx({ mode: 'real', clock, human: new HumanSession(api, clock), container })
    return { ctx, events, posts }
  }

  const liftPost = `post ${COORD} ${MENTIONS} ${CHECK12_LIFT}`
  const paneScript = (l: 'a' | 'b', text: string, interrupt: boolean) => `sh guard || exit 90\n${typeIntoPane(l, text, interrupt)}`
  const LIMIT_SEARCH = "sh since '1:0' | grep -inE 'limit|throttl|loop|too many'"

  test('the stop and the lift ban nothing; the lift says A and B may post in coordination again', () => {
    for (const text of [CHECK12_STOP, CHECK12_PANE_STOP, CHECK12_LIFT]) expect(text).not.toMatch(BAN_RE)
    expect(CHECK12_LIFT).toContain('You may post in coordination again')
  })

  test('personas that obey the stop: the stop in coordination, then, once quiet for two minutes and after the limit search, the lift in coordination only', async () => {
    const { ctx, events, posts } = exchange()
    const r = await check12.run(ctx)
    expect([r.status, r.reason]).toEqual(['PASS', undefined])
    const [start, stop, lift] = posts
    expect(posts.length).toBe(3)
    expect([start!.channel, stop!.channel, lift!.channel]).toEqual([DRY_RUN_IDS.aHome, COORD, COORD])
    expect(stop!.text).toBe(`${MENTIONS} ${CHECK12_STOP}`)
    expect(lift!.text).toBe(`${MENTIONS} ${CHECK12_LIFT}`)
    for (const p of posts) expect(p.text).not.toMatch(BAN_RE)
    expect(lift!.at - stop!.at).toBeGreaterThanOrEqual(2 * MINUTE)
    expect(events.indexOf(LIMIT_SEARCH)).toBeGreaterThan(events.indexOf(`post ${COORD} ${stop!.text}`))
    expect(events.indexOf(liftPost)).toBeGreaterThan(events.indexOf(LIMIT_SEARCH))
    expect(events.filter((e) => e.includes('tmux send-keys'))).toEqual([])
    expect(r.evidence).toContain(`the stop lifted in coordination: ${lift!.ts}`)
    assertNoLeak(r)
  })

  test('personas that keep posting: stopped in both terminals (Escape first), then the lift in coordination and typed into both terminals with no Escape', async () => {
    const { ctx, events } = exchange({ keepPosting: true })
    const r = await check12.run(ctx)
    expect([r.status, r.reason]).toEqual(['PASS', undefined])
    expect(r.notes).toContain('Check 12: the personas kept posting after the stop message; stopped in their terminals (Escape + message)')
    const panes = events.filter((e) => e.includes('tmux send-keys'))
    expect(panes).toEqual([
      paneScript('a', CHECK12_PANE_STOP, true),
      paneScript('b', CHECK12_PANE_STOP, true),
      paneScript('a', CHECK12_LIFT, false),
      paneScript('b', CHECK12_LIFT, false),
    ])
    expect(panes.slice(2).some((e) => e.includes('Escape'))).toBe(false)
    // The lift follows the terminal stop, the quiet wait and the limit search, and is posted before it is typed.
    const liftAt = events.indexOf(liftPost)
    expect(liftAt).toBeGreaterThan(events.indexOf(panes[1]!))
    expect(liftAt).toBeGreaterThan(events.indexOf(LIMIT_SEARCH))
    expect(events.indexOf(panes[2]!)).toBeGreaterThan(liftAt)
  })

  test('a step that throws after the stop still lifts it before the error ends the check', async () => {
    const { ctx, events } = exchange({ fail: 'grep -inE' })
    await expect(check12.run(ctx)).rejects.toThrow('container: grep -inE failed')
    expect(events.at(-1)).toBe(liftPost)
  })

  test("a lift Slack refuses is a note, not a failure or a throw; the check's result stands", async () => {
    const { ctx, posts } = exchange({ refuseLift: true })
    const r = await check12.run(ctx)
    expect([r.status, r.reason]).toEqual(['PASS', undefined])
    expect(posts.some((p) => p.text.includes(CHECK12_LIFT))).toBe(false)
    expect(r.notes).toContain(
      'Check 12: the lift could not be posted in coordination (HumanCallError: chat.postMessage failed: channel_not_found); a later check may find A or B unwilling to post there',
    )
  })

  test("the plan's Check 12 gives the runner's stop, terminal stop and lift texts", () => {
    const plan = readFileSync(join(import.meta.dir, '..', 'testplans', 'b.yko', 'b.yko.md'), 'utf-8')
    const section = plan.slice(plan.indexOf('### Check 12:'), plan.indexOf('## Part 5:')).replace(/\s+/g, ' ')
    expect(section).toContain(`"@CSCB Test A @CSCB Test B ${CHECK12_STOP}"`)
    expect(section).toContain(`type "${CHECK12_PANE_STOP}"`)
    expect(section).toContain(`"@CSCB Test A @CSCB Test B ${CHECK12_LIFT}"`)
  })

  test("the start message first tells A who it and B are (persona name and key, bot user IDs), so it doesn't look itself up; the plan's step 1 gives the same text", async () => {
    const { ctx, posts } = exchange()
    await check12.run(ctx)
    const start = posts[0]!
    expect(start.channel).toBe(DRY_RUN_IDS.aHome)
    expect(start.text).toBe(check12Start({ coordination: COORD, aUserId: A.userId, bUserId: B.userId }))
    expect(start.text).toStartWith(
      `You are persona_a (key=persona_a), bot user ID \`${A.userId}\`. B is persona_b (key=persona_b), bot user ID \`${B.userId}\`. ` +
        "That is all you need to know about who you are, so don't look it up. In coordination, ",
    )
    expect(start.text).toContain(`mentions \`<@${B.userId}>\``)
    expect(start.text).toContain(`mention you as \`<@${A.userId}>\``)
    const plan = readFileSync(join(import.meta.dir, '..', 'testplans', 'b.yko', 'b.yko.md'), 'utf-8')
    const section = plan.slice(plan.indexOf('### Check 12:'), plan.indexOf('## Part 5:')).replace(/\s+/g, ' ')
    expect(section).toContain(`post: "${check12Start({ coordination: '<COORDINATION_CHANNEL_ID>', aUserId: '<A_BOT_USER_ID>', bUserId: '<B_BOT_USER_ID>' })}"`)
  })

  test('typeIntoPane: Escape first only when interrupting; the text is one literal word', () => {
    expect(typeIntoPane('b', "it's over", false)).toBe(`tmux send-keys -t slack_bot_persona_b -l 'it'\\''s over'; sleep 1; tmux send-keys -t slack_bot_persona_b Enter`)
    expect(typeIntoPane('a', 'stop', true)).toBe(
      `tmux send-keys -t slack_bot_persona_a Escape; sleep 1; tmux send-keys -t slack_bot_persona_a -l 'stop'; sleep 1; tmux send-keys -t slack_bot_persona_a Enter`,
    )
  })
})

/** Playwright's own timeout error, as a locator or a navigation in a flow throws it. */
class TimeoutError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'TimeoutError'
  }
}

describe("Check 28: a failed revocation of B's older app-level token (step 7)", () => {
  const B = DRY_RUN_IDS.bots.b
  const ROTATED_ASK = 'reply with the word rotated.'
  const MAY_BE_VALID = "Check 28: B's older app-level token (cscb-live) may still be valid: revoke it on B's Basic Information page"
  /** Step 8's revert (behind the guard) and the clean-up that ends the check. */
  const REVERT = 'guard || exit 90\ncp ~/cscb-live/config-before-reboot.json "$S/config.json"'
  const CLEANUP = 'rm -f ~/cscb-live/config-before-reboot.json ~/cscb-live/reboot-log-mark ~/cscb-live/reboot-errors-mark'

  /**
   * A live context that gets through step 8: the container sets the
   * start-at-boot marker (`echo BOOT`) and gives a `mark`; every other
   * command succeeds and prints nothing, and nothing answers in Slack, so the
   * other steps record their own findings; time is virtual. The browser's
   * revokeAppToken runs `revoke`, and records how many container scripts had
   * run by then.
   */
  function rebootRun(revoke: () => Promise<void>) {
    const clock = virtualClock()
    const session = scriptedHuman(clock)
    const { container, scripts } = fakeContainer([
      ['echo BOOT', 'BOOT'],
      ['', (script) => (script === 'mark' ? '1:0' : '')],
    ])
    const revoked: { appId: string; name: string; scriptsBefore: number }[] = []
    const browser: BrowserDriver = {
      ...idleBrowser(),
      revokeAppToken: async (appId, name) => {
        revoked.push({ appId, name, scriptsBefore: scripts.length })
        await revoke()
      },
    }
    return { ctx: makeCtx({ mode: 'real', clock, human: session.human, browser, container }), posts: session.posts, scripts, revoked }
  }

  test.each([
    [
      "a FlowError (the flow's own: Slack refused)",
      () => new FlowError(`revoke: confirm: Slack answered that it can't revoke "cscb-live"`),
      `FlowError: revoke: confirm: Slack answered that it can't revoke "cscb-live"`,
    ],
    [
      "any other error (Playwright's TimeoutError: its URL query and call log left out)",
      () =>
        new TimeoutError(
          `page.goto: Timeout 30000ms exceeded navigating to https://api.slack.com/apps/${B.appId}/general?t=${LEAK_SENTINEL}\nCall log:\n  - token ${fakeToken(APP_TOKEN_PREFIX, 'old')}`,
        ),
      `TimeoutError: page.goto: Timeout 30000ms exceeded navigating to https://api.slack.com/apps/${B.appId}/general?<query>`,
    ],
  ])('%s is a finding, not a throw: the token may still be valid, B is not asked for "rotated", and the rest of step 7 and step 8 still run', async (_what, error, described) => {
    const run = rebootRun(async () => {
      throw error()
    })
    const r = await check28.run(run.ctx)
    expect(run.revoked.map(({ appId, name }) => [appId, name])).toEqual([[B.appId, 'cscb-live']])
    expect(r.status).toBe('FAIL')
    expect((r.reason ?? '').split('; ')).toContain(`step 7: revoke failed: ${described}`)
    expect(r.notes).toContain(MAY_BE_VALID)
    expect(run.posts.filter((p) => p.text.includes(ROTATED_ASK))).toEqual([])
    // After the revocation: the rest of step 7's checks, then step 8's revert, and its clean-up last.
    const after = run.scripts.slice(run.revoked[0]!.scriptsBefore)
    expect(after).toContain('tokcount "$S"/server.log*')
    expect(after).toContain(REVERT)
    expect(after.at(-1)).toBe(CLEANUP)
    assertNoLeak(r)
  })

  test('the control: a revocation that succeeds is followed by the "rotated" ask, with no revoke finding or note', async () => {
    const run = rebootRun(async () => {})
    const r = await check28.run(run.ctx)
    expect(run.revoked.length).toBe(1)
    expect(r.reason).not.toContain('revoke failed')
    expect(r.notes).not.toContain(MAY_BE_VALID)
    expect(run.posts.filter((p) => p.text.includes(ROTATED_ASK)).map((p) => [p.channel, p.text])).toEqual([[COORD, `<@${B.userId}> ${ROTATED_ASK}`]])
    // B is silent here: that is step 7's own finding.
    expect((r.reason ?? '').split('; ')).toContain('step 7: B did not answer after the older token was revoked')
    expect(run.scripts.at(-1)).toBe(CLEANUP)
  })
})

// ---------------------------------------------------------------------------
// A start's lines: the summary's ending and the wait for every persona
// ---------------------------------------------------------------------------

describe("the start's lines: the summary's ending (Part 2.3's Expected items)", () => {
  /** checkStartLines' findings on a start logged in full: C connected, the summary ending `ending`. */
  async function findingsFor(ending: string): Promise<string[]> {
    const clock = virtualClock()
    const log = timedLog(clock, startLog(155, ending))
    log.begin()
    await clock.sleep(155 * SECOND)
    const f = new Findings()
    await checkStartLines(makeCtx({ clock, container: fakeContainer([['', (script) => log.since(script) ?? '']]).container }), f, '1:0', ['a', 'b', 'c'], true)
    return f.failures
  }

  test(`a summary ending "${START_SUMMARY_END}" is no finding, and the line is evidence`, async () => {
    expect(await findingsFor(START_SUMMARY_END)).toEqual([])
  })

  test.each([
    ['the ending before b.f2b, with no not-reconnected bucket', '0 failed, 0 not brought up'],
    ['a persona left running but not reconnected', '0 failed, 0 not brought up, 1 not reconnected'],
    ['a persona not brought up', '0 failed, 1 not brought up, 0 not reconnected'],
    ['a failed launch', '1 failed, 0 not brought up, 0 not reconnected'],
    ['ten failed launches (the ending matches whole counts only)', '10 failed, 0 not brought up, 0 not reconnected'],
  ])('%s is a finding', async (_what, ending) => {
    expect(await findingsFor(ending)).toEqual([`the start summary does not end "${START_SUMMARY_END}"`])
  })
})

describe('the guarded restart waits for every persona to connect, not only for the summary (Part 2.3 step 3)', () => {
  /** A stop, then a start logged as `startLog(cAt)`; the record matches and nothing is pending; time is virtual. */
  function restartRun(cAt: number | null) {
    const clock = virtualClock()
    const log = timedLog(clock, startLog(cAt))
    const { container } = fakeContainer([
      [
        'claude-slack-channel-bots start',
        () => {
          log.begin()
          return ''
        },
      ],
      ['[ -e "$S/config.json.pending" ]', { code: 1 }],
      ['', (script) => (script === 'mark' ? '1:0' : (log.since(script) ?? ''))],
    ])
    return { ctx: makeCtx({ mode: 'real', clock, container }), clock }
  }

  test('a persona that connects 55 s after the summary (parked on a working row, b.f2b) is waited for: no finding', async () => {
    const run = restartRun(155)
    const at = run.clock.now()
    const f = new Findings()
    expect(await guardedRestart(run.ctx, f)).toBe('1:0')
    expect(f.failures).toEqual([])
    expect(f.evidence).toEqual([startSummary(START_SUMMARY_END)])
    expect(run.clock.now() - at).toBeGreaterThanOrEqual(155 * SECOND)
  })

  test('the control: a persona that never connects is a finding once the bring-up wait runs out', async () => {
    const f = new Findings()
    await guardedRestart(restartRun(null).ctx, f)
    expect(f.failures).toEqual(['guarded restart: the start summary or a Session connected line did not appear in time', 'no Session connected line for persona_c'])
  })
})

describe('Check 28 step 5: the start after the reboot waits for every persona to connect, not only for B', () => {
  const ROWS = ['a', 'b', 'c'].map((l) => `cscb_persona_${l} persona_${l} idle`).join('\n')
  /** The findings that step 5's start lines give. */
  const START_FINDING = /^step 5|Session connected line|persona-start line|last-applied record|startupSessionManager complete|start summary|start failure/

  /**
   * A live context whose reboot (`restartContainer`) starts the server: its
   * lines are `startLog(cAt)`, timed from the reboot. The container sets the
   * start-at-boot marker, gives a mark (also as the saved reboot mark), the
   * three rows and a running server; nothing answers in Slack, so the other
   * steps record their own findings; time is virtual.
   */
  function rebootedRun(cAt: number | null, lines: readonly (readonly [number, string])[] = startLog(cAt)) {
    const clock = virtualClock()
    const log = timedLog(clock, lines)
    const { container } = fakeContainer([
      ['echo BOOT', 'BOOT'],
      ['kill -0', 'running'],
      ['', (script) => (script === 'mark' || script === 'cat ~/cscb-live/reboot-log-mark' ? '1:0' : script === 'rows' ? ROWS : (log.since(script) ?? ''))],
    ])
    return makeCtx({ mode: 'real', clock, human: scriptedHuman(clock).human, browser: idleBrowser(), container, restartContainer: async () => log.begin() })
  }

  test('C, parked on a working row (b.f2b), connects 55 s after the summary: step 5 waits for it, so its start lines give no finding', async () => {
    const r = await check28.run(rebootedRun(155))
    expect((r.reason ?? '').split('; ').filter((x) => START_FINDING.test(x))).toEqual([])
    expect(r.evidence).toContain(startSummary(START_SUMMARY_END))
    expect(r.notes).toContain(`Check 28 summary: 3 persona(s): 2 resumed, 0 fresh-spawned, 0 fresh-after-amnesia, 0 fresh-after-inconclusive-amnesia, 0 reconnected, 0 no-op, ${START_SUMMARY_END}`)
  })

  test('the control: C never connects, which is a finding', async () => {
    const r = await check28.run(rebootedRun(null))
    expect((r.reason ?? '').split('; ').filter((x) => START_FINDING.test(x))).toEqual(['no Session connected line for persona_c'])
  })

  test("A, Slack unreachable for a moment at the start (run 6), up after its bring-up retry and connected in the wait: no start finding, a note", async () => {
    const r = await check28.run(rebootedRun(null, retriedStartLog()))
    expect((r.reason ?? '').split('; ').filter((x) => START_FINDING.test(x))).toEqual([])
    expect(r.notes).toContain(RETRIED_NOTE)
    expect(r.notes).toContain(`Check 28 summary: 3 persona(s): 2 resumed, 0 fresh-spawned, 0 fresh-after-amnesia, 0 fresh-after-inconclusive-amnesia, 0 reconnected, 0 no-op, 0 failed, 1 not brought up, 0 not reconnected`)
  })

  test('the control: A never comes back, which fails as before (the summary, the failure line, no Session connected line)', async () => {
    const r = await check28.run(rebootedRun(null, retriedStartLog({ up: false })))
    const findings = (r.reason ?? '').split('; ').filter((x) => START_FINDING.test(x))
    expect(findings.map((x) => x.replace(/: \[.*$/, ''))).toEqual(['no Session connected line for persona_a', `the start summary does not end "${START_SUMMARY_END}"`, 'start failure lines'])
    expect(r.notes).not.toContain(RETRIED_NOTE)
  })
})

/** Run 6's cause line, as the plan's note quotes it: the class, then the cause. */
const RETRIED_NOTE =
  'Check 28: persona_a was not brought up at the start (persona-slack-unreachable: Slack unreachable checking app_token via the Socket Mode open: WebSocket phase timed out after 10 s), ' +
  'then was up after its bring-up retry (Slack) and connected: a transient the server recovered from, accepted'

/**
 * A start from the record as in run 6: Slack is unreachable for A at the
 * start (its line timestamped, as server.log has it), so the summary counts
 * it not brought up; B and C connect before the summary. With `up`, A's
 * cause clears, A is up after its bring-up retry (Slack) and connects after
 * it (`connected`); `notBroughtUp` is the summary's count; `extra` lines are
 * added.
 */
function retriedStartLog(opts: { up?: boolean; connected?: boolean; notBroughtUp?: number; extra?: [number, string][] } = {}): [number, string][] {
  const { up = true, connected = true, notBroughtUp = 1, extra = [] } = opts
  const ref = '"persona_a" (key=persona_a)'
  const path = 'path="/home/testuser/.config/cscb/persona_a-credentials.json"'
  const session = (l: PersonaLetter) => `[slack] Session connected: persona "persona_${l}" (key=persona_${l}) cwd="/home/cscb/cscb-live/${l}"`
  const lines: [number, string][] = [
    [20, `[slack] Starting from the last-applied record "${S}/config.json.last-applied"`],
    [20, '[slack] Loaded persona config: 3 persona(s)'],
    ...(['a', 'b', 'c'] as const).map((l, i): [number, string] => [25, `[slack] persona-start: personas[${i}] "persona_${l}" (key=persona_${l}): bring-up starting`]),
    [35, `[2026-09-26T19:51:41.070Z] [slack] persona-slack-unreachable: personas[0] ${ref} ${path}: Slack unreachable checking app_token via the Socket Mode open: WebSocket phase timed out after 10 s`],
    [80, session('b')],
    [90, session('c')],
    [100, startSummary(`0 failed, ${notBroughtUp} not brought up, 0 not reconnected`)],
  ]
  if (up) {
    lines.push([105, `[2026-09-26T19:51:46.284Z] [slack] persona-slack-unreachable: personas[0] ${ref} ${path}: cleared: Slack answered after being unreachable checking app_token via the Socket Mode open`])
    lines.push([105, `[slack] persona ${ref}: up after its bring-up retry (Slack) — launching`])
    if (connected) lines.push([106, session('a')])
  }
  return [...lines, ...extra].sort((x, y) => x[0] - y[0])
}

describe("the start's lines: a persona not brought up that came up after its bring-up retry (Check 28's acceptRetried)", () => {
  /** checkStartLines' findings and notes on `lines`, 200 s after the start, with or without Check 28's acceptance. */
  async function startFindings(lines: [number, string][], accept = true): Promise<{ failures: string[]; notes: string[] }> {
    const clock = virtualClock()
    const log = timedLog(clock, lines)
    log.begin()
    await clock.sleep(200 * SECOND)
    const f = new Findings()
    const ctx = makeCtx({ clock, container: fakeContainer([['', (script) => log.since(script) ?? '']]).container })
    await checkStartLines(ctx, f, '1:0', ['a', 'b', 'c'], true, accept ? { acceptRetried: 'Check 28' } : {})
    return { failures: f.failures, notes: f.notes }
  }

  /** A failure without the log lines it quotes. */
  const short = (r: { failures: string[]; notes: string[] }) => ({ ...r, failures: r.failures.map((x) => x.replace(/: \[.*$/, '')) })

  test('accepted: the summary counts it not brought up, its Slack-unreachable lines up to the retry are the transient; a note says so', async () => {
    expect(await startFindings(retriedStartLog())).toEqual({ failures: [], notes: [RETRIED_NOTE] })
  })

  test('retriedBringUps finds the persona only with its up-after-retry line and a Session connected line after it', () => {
    const lines = (o: Parameters<typeof retriedStartLog>[0]) => retriedStartLog(o).map(([, l]) => l)
    expect(retriedBringUps(lines({}), ['a', 'b', 'c']).map((r) => [r.letter, r.via])).toEqual([['a', 'Slack']])
    expect(retriedBringUps(lines({ connected: false }), ['a', 'b', 'c'])).toEqual([])
    expect(retriedBringUps(lines({ up: false }), ['a', 'b', 'c'])).toEqual([])
    // Only a Slack retry is a transient: a directory retry after a reboot is not accepted.
    expect([retryFailureClass('Slack')?.source, retryFailureClass('directory'), retryFailureClass('credentials')]).toEqual(['\\] persona-slack-unreachable: ', null, null])
  })

  const START = ['the start summary does not end "0 failed, 0 not brought up, 0 not reconnected"', 'start failure lines']

  test.each([
    ['without the acceptance (a guarded restart)', retriedStartLog(), false, START],
    ['it never came back', retriedStartLog({ up: false }), true, ['no Session connected line for persona_a', ...START]],
    ['up after its retry, but never connected', retriedStartLog({ connected: false }), true, ['no Session connected line for persona_a', ...START]],
    ['the summary counts two not brought up, only one came back', retriedStartLog({ notBroughtUp: 2 }), true, START],
    [
      'up after a directory retry (not a transient)',
      retriedStartLog().map(([t, l]): [number, string] => [t, l.replace('bring-up retry (Slack)', 'bring-up retry (directory)')]),
      true,
      START,
    ],
  ] as const)('%s: fails as before', async (_what, lines, accept, failures) => {
    expect(short(await startFindings([...lines], accept))).toEqual({ failures: [...failures], notes: [] })
  })

  test.each([
    ['a credentials line for it', `[slack] persona-credentials-refused: personas[0] "persona_a" (key=persona_a) path="/x": Slack refused the app token`, 30],
    ['a Slack-unreachable line for it after the retry', `[slack] persona-slack-unreachable: personas[0] "persona_a" (key=persona_a) path="/x": Slack unreachable checking bot_token via auth.test: no answer within 10 s`, 150],
    ["another persona's Slack-unreachable line", `[slack] persona-slack-unreachable: personas[1] "persona_b" (key=persona_b) path="/x": Slack unreachable checking bot_token via auth.test: no answer within 10 s`, 30],
  ])('accepted, but %s is still a finding (and the note stays)', async (_what, line, at) => {
    const r = await startFindings(retriedStartLog({ extra: [[at, line]] }))
    expect(r).toEqual({ failures: [`start failure lines: ${line}`], notes: [RETRIED_NOTE] })
  })
})

describe('no live check passes against a silent workspace', () => {
  // A gesture that only undoes its setup passes when the setup never ran: nothing to restore.
  const UNDO_GESTURES = ['24-teardown']
  const live = PLAN_CHECKS.filter((c) => c.needs.includes('workspace') && !c.skip && !UNDO_GESTURES.includes(c.id))

  /**
   * Posts get a ts; history and replies are empty; every container command
   * succeeds and prints nothing, except `mark`, so a check gets past its
   * starting mark; time is virtual.
   */
  function silentCtx(): CheckContext {
    const clock = virtualClock()
    return makeCtx({
      mode: 'real',
      clock,
      human: scriptedHuman(clock).human,
      second: { human: scriptedHuman(clock).human, userId: 'U0DRYSECND' },
      browser: idleBrowser(),
      container: fakeContainer([['', (script) => (script === 'mark' ? '1:0' : '')]]).container,
    })
  }

  test.each(live.map((c) => [c.id, c] as const))('Check %s does not PASS (a throw counts as a FAIL)', async (_id, c) => {
    const all = new Set<Need>(['workspace', 'claude', 'second-user'])
    const [r] = await runChecks([c], silentCtx(), { available: all, only: [], now: () => 0, log: { info: () => {} } })
    expect(r!.status).not.toBe('PASS')
    assertNoLeak(r)
  })

  test.each(['16', '20'])('Check %s FAILs outright: A never says done, so it is asked once and not again', async (id) => {
    const r = await PLAN_CHECKS.find((c) => c.id === id)!.run(silentCtx())
    expect([r.status, r.reason]).toEqual(['FAIL', 'A did not say done and made no reply-tool call to U0DRYSECND'])
  })

  test('the undo gestures left out pass only with nothing to restore', async () => {
    for (const id of UNDO_GESTURES) {
      const r = await PLAN_CHECKS.find((c) => c.id === id)!.run(silentCtx())
      expect([id, r.status, r.evidence]).toEqual([id, 'PASS', ['nothing to restore: the setup did not run']])
    }
  })
})

// ---------------------------------------------------------------------------
// The prompts the checks declare to the prompt guard
// ---------------------------------------------------------------------------

describe('the prompts each check declares to the prompt guard, before it raises them', () => {
  /** Every check that raises a permission prompt, and what it declares (run 6's list: 5, 18, 22, 23, and 27 left open). */
  const DECLARED: Record<string, PromptExpectation[]> = {
    '5': [
      { persona: 'a', command: CHECK5_PROMPT_1 },
      { persona: 'a', command: CHECK5_PROMPT_2 },
    ],
    '18': [{ persona: 'c', command: CHECK18_PROMPT }],
    '22': [{ persona: 'b', command: CHECK22_PROMPT }],
    '23': [
      { persona: 'a', command: CHECK23_PROMPT_A },
      { persona: 'b', command: CHECK23_PROMPT_B },
      { persona: 'b', command: CHECK23_B_EXTRA },
    ],
    '27': [{ persona: 'd', command: CHECK27_PROMPT, leaveOpen: true }],
  }
  const live = PLAN_CHECKS.filter((c) => c.needs.includes('workspace') && !c.skip)

  /**
   * A silent workspace (as above) whose declarations, human posts and typing
   * into a persona's pane are recorded in order; the container answers
   * `container` first, if given.
   */
  function declaringCtx(leftovers = 0, container?: [string, Reply]) {
    const clock = virtualClock()
    const events: string[] = []
    const guard = recordingGuard(leftovers)
    const record = guard.expect
    guard.expect = (e) => {
      events.push(`expect ${e.persona}`)
      record(e)
    }
    const { human } = scriptedHuman(clock)
    const post = human.post.bind(human)
    human.post = async (channel, text, thread) => {
      events.push('post')
      return post(channel, text, thread)
    }
    const answers: [string, Reply][] = [
      ...(container ? [container] : []),
      [
        '',
        (script) => {
          if (script.includes('tmux send-keys')) events.push('type')
          return script === 'mark' ? '1:0' : ''
        },
      ],
    ]
    const ctx = makeCtx({
      mode: 'real',
      clock,
      human,
      second: { human: scriptedHuman(clock).human, userId: 'U0DRYSECND' },
      browser: idleBrowser(),
      container: fakeContainer(answers).container,
      promptGuard: guard,
    })
    return { ctx, events, guard }
  }

  test('the checks that raise prompts are the ones run 6 named', () => {
    expect(Object.keys(DECLARED).sort()).toEqual(['18', '22', '23', '27', '5'])
    expect(CHECK23_B_EXTRA.test('anything B runs')).toBe(true)
  })

  test.each(live.map((c) => [c.id, c] as const))('Check %s declares exactly its prompts, all before it posts or types what raises them', async (id, c) => {
    const { ctx, events, guard } = declaringCtx()
    await runChecks([c], ctx, { available: new Set<Need>(['workspace', 'claude', 'second-user']), only: [], now: () => 0, log: { info: () => {} } })
    expect(guard.expected).toEqual(DECLARED[id] ?? [])
    if (DECLARED[id]) {
      const raised = events.findIndex((e) => e === 'post' || e === 'type')
      const declared = events.map((e, i) => (e.startsWith('expect ') ? i : -1)).filter((i) => i >= 0)
      expect(raised).toBeGreaterThan(Math.max(...declared))
    }
  })

  test.each([
    ['Check 5', CHECK5_PROMPT_1, 'date > permission-check.txt', 'date > permission-check-2.txt'],
    ['Check 5 (2)', CHECK5_PROMPT_2, 'date > ~/cscb-live/a/permission-check-2.txt', 'date > permission-check.txt'],
    ['Check 18', CHECK18_PROMPT, 'date > dm-prompt-c.txt', 'ls'],
    ['Check 22', CHECK22_PROMPT, 'date +%F > "$(pwd)/dm-prompt-b.txt"', 'date > prompt-b.txt'],
    ['Check 23 (A)', CHECK23_PROMPT_A, '🤖🛠️ *Write*\n`/home/testuser/cscb-live/a/prompt-a.txt`', "env | grep -i -E 'cscb|slack'"],
    ['Check 27', CHECK27_PROMPT, 'date > removal-prompt.txt', 'pwd'],
  ])("%s's declared command matches its own prompt, not a detour", (_what, re, own, detour) => {
    expect([commandMatches(re, own), commandMatches(re, detour)]).toEqual([true, false])
  })
})

describe('Check 23: what it raised is denied when it ends, even on an early return or a throw', () => {
  function silent23(leftovers: number, container?: [string, Reply]) {
    const clock = virtualClock()
    const guard = recordingGuard(leftovers)
    const answers: [string, Reply][] = [...(container ? [container] : []), ['', (script) => (script === 'mark' ? '1:0' : '')]]
    const ctx = makeCtx({ mode: 'real', clock, human: scriptedHuman(clock).human, browser: idleBrowser(), container: fakeContainer(answers).container, promptGuard: guard })
    return { ctx, guard }
  }

  test("an early return (the prompts did not appear) still has the guard deny what it left open, and the denial is noted", async () => {
    const { ctx, guard } = silent23(2)
    const r = await check23.run(ctx)
    expect([r.status, r.reason]).toEqual(['FAIL', 'both prompts did not appear'])
    expect(guard.sweeps).toBe(1)
    expect(r.notes).toEqual(["Check 23: 2 prompt(s) it raised were still open at its end; denied (the prompt guard's notes name them)"])
  })

  test('with nothing left open, no note', async () => {
    const { ctx, guard } = silent23(0)
    const r = await check23.run(ctx)
    expect([guard.sweeps, r.notes]).toEqual([1, []])
  })

  test('a throw after the post still has the guard deny what it left open, then ends the check', async () => {
    const { ctx, guard } = silent23(1, [
      'cscb.chat_post.attempted',
      () => {
        throw new Error('container gone')
      },
    ])
    await expect(check23.run(ctx)).rejects.toThrow('container gone')
    expect(guard.sweeps).toBe(1)
  })
})

// ---------------------------------------------------------------------------
// Texts the checks expect, against the package
// ---------------------------------------------------------------------------

describe('expected texts match the package', () => {
  const COUNTS = [{ added: 1 }, { removed: 1, credentials: 1 }, { in_place: 2 }, { settings: 1 }, { destructive: 1 }]
  const srcCounts = (c: (typeof COUNTS)[number]): ChangePlanCounts => {
    const x = c as Partial<Record<string, number>>
    return { added: x.added ?? 0, removed: x.removed ?? 0, destructive: x.destructive ?? 0, inPlace: x.in_place ?? 0, credentials: x.credentials ?? 0, settings: x.settings ?? 0 }
  }
  const sized = (n: number) => Array.from({ length: n }, () => ({})) as never[]

  test.each(COUNTS)('counts %j: the preview header and the reload-applied line', (c) => {
    const counts = srcCounts(c)
    expect(countsText(c)).toBe(renderChangePlanCounts(counts))
    expect(previewHeader(c)).toBe(`${PENDING_PREVIEW_TITLE} ${renderChangePlanCounts(counts)}.`)
    const plan: ValidChangePlan = {
      valid: true,
      added: sized(counts.added),
      removed: sized(counts.removed),
      destructive: sized(counts.destructive),
      inPlace: Array.from({ length: counts.inPlace }, (_, i) => ({ key: `k${i}` })) as never[],
      credentials: sized(counts.credentials),
      nextLaunch: [],
      unchanged: [],
      settings: sized(counts.settings),
      noEffectiveChange: false,
      configDirsChanged: false,
    }
    expect(appliedLine(c)).toBe(renderAppliedLogLine(plan, `${S}/config.json.last-applied`))
  })

  test("the start summary: the ending the checks expect, and Check 1's line, are the package's buckets in its order", () => {
    const src = readFileSync(join(import.meta.dir, '..', 'src', 'session-manager.ts'), 'utf-8')
    const at = src.indexOf('`[slack] startupSessionManager: complete — ')
    expect(at).toBeGreaterThan(-1)
    // The summary's template literals joined, each value rendered as 0.
    const zero = src
      .slice(at, src.indexOf('`,\n', at) + 1)
      .replace(/`\s*\+\s*`/g, '')
      .replace(/^`|`$/g, '')
      .replace(/\$\{[^}]+\}/g, '0')
    expect(zero.endsWith(`, ${START_SUMMARY_END}`)).toBe(true)
    expect(COMPLETE_FIRST_START.replace(/\b3 /g, '0 ')).toBe(zero)
  })

  test("the plan quotes the same summary: every ending it gives has the not-reconnected bucket, and Check 1 quotes the line", () => {
    const plan = readFileSync(join(import.meta.dir, '..', 'testplans', 'b.yko', 'b.yko.md'), 'utf-8')
    const quoted = [...plan.matchAll(/`([^`]*\d+ failed, \d+ not brought up[^`]*)`/g)].map((m) => m[1]!)
    expect(quoted.filter((x) => !/, \d+ not reconnected$/.test(x))).toEqual([])
    expect(quoted).toContain(START_SUMMARY_END)
    expect(quoted).toContain(COMPLETE_FIRST_START)
  })

  test('parsePending splits the pending file the package writes', () => {
    expect(PENDING_HEADER).toBe(PENDING_FILE_HEADER)
    const fingerprint = `fingerprint: sha256:${'0'.repeat(64)}`
    const text = [PENDING_FILE_HEADER, fingerprint, '', previewHeader({ settings: 1 }), 'line two', ''].join('\n')
    const pending = parsePending(text)
    expect(pending).toEqual({ header: PENDING_FILE_HEADER, fingerprint, preview: [previewHeader({ settings: 1 }), 'line two'] })
    const f = new Findings()
    checkPreview(f, pending!, [previewHeader({ settings: 1 }), 'line two'])
    expect(f.failures).toEqual([])
    checkPreview(f, { ...pending!, fingerprint: 'fingerprint: none' }, ['other'])
    expect(f.failures.length).toBe(2)
    expect(parsePending('one\ntwo\nnot blank\nfour')).toBeNull()
    expect(parsePending('short')).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

describe('check helpers', () => {
  test.each([`it's`, '$(touch /nonexistent/x) `id` $HOME', "'; echo pwned #", 'two\nlines', ''])('q(%p) is one literal shell word', (value) => {
    const bash = Bun.which('bash')!
    const r = Bun.spawnSync([bash, '-c', `printf %s ${q(value)}`], { env: { PATH: '/usr/bin:/bin' } })
    expect([r.exitCode, r.stdout.toString()]).toEqual([0, value])
  })

  test.each([
    ['Hello, WORLD!', 'world', true],
    ['pineapple', 'apple', false],
    ['a re-run', 'run', false],
    ['echo: a.b done', 'a.b', true],
    ['xa.b', 'a.b', false],
  ])('hasWord(%p, %p) is %p', (text, word, expected) => {
    expect(hasWord(text, word)).toBe(expected)
  })

  test.each([
    [{ ts: '1.000001', text: '*Permission* — Allowed' }, 'allowed', false],
    [{ ts: '1.000001', text: '*Permission* — Denied by operator' }, 'denied', false],
    [{ ts: '1.000001', text: 'Bash wants to run', blocks: [{ elements: [{ text: { text: 'Allow' } }, { text: { text: 'Deny' } }] }] }, 'open', true],
    [{ ts: '1.000001', text: 'permission request: Bash' }, 'other', true],
    [{ ts: '1.000001', text: 'hello' }, 'other', false],
  ])('promptState(%j) is %p', (message, state, prompt) => {
    expect([promptState(message), isPrompt(message)] as unknown[]).toEqual([state, prompt])
  })

  test('tagAttr, expectOneTag and rawShape read IDs only', () => {
    const tag = '<channel source="slack" chat_id="C0DRYCOORD" user_id="U0DRYBOTA0" via="broadcast">'
    expect([tagAttr(tag, 'via'), tagAttr(tag, 'thread_ts')]).toEqual(['broadcast', null])
    const f = new Findings()
    expectOneTag(f, [tag], 'tags b TS', { via: 'broadcast', chat_id: 'C0DRYCOORD' }, { user_id: 'U0DRYBOTA0' })
    expect(f.failures).toEqual([])
    expectOneTag(f, [tag], 'x', { via: 'mention' }, { user_id: 'U0OTHER000', bot_id: 'B0OTHER000' })
    expectOneTag(f, [], 'y', {})
    expect(f.failures).toEqual(['x: via is broadcast, not mention', 'x: the tag\'s author is not U0OTHER000 / B0OTHER000', 'y: expected exactly one tag, found 0'])
    const token = fakeToken(BOT_TOKEN_PREFIX)
    const shape = rawShape(`RAW message event persona=persona_b: {"user":"U0A","bot_id":"B0A","bot_profile":{"x":1},"text":"${token}"}`)
    expect(shape).toEqual({ user: 'U0A', bot_id: 'B0A', subtype: 'absent', app_id: 'absent', bot_profile: 'present' })
    assertNoLeak(shape)
  })

  test("judgeLimitLines (Check 12's search): message-text lines are skipped, the known Slack rate-limit lines are notes, anything else fails", () => {
    const skipped = [
      '12:[slack] RAW message event persona=persona_b: {"text":"what is the limit of 7 times 6?"}',
      '13:[slack] Dispatching to persona "persona_a" (key=persona_a) chat_id=C0DRYCOORD text=no limit here',
    ]
    const rateLimit = [
      '20:[WARN]  web-api:WebClient:0 API Call failed due to rate limiting. Will retry in 3 seconds.',
      '21:[slack] A rate limit was exceeded (url: chat.postMessage, retry-after: 3)',
      '22:[slack] reactions.add failed: ratelimited',
    ]
    const other = ['30:[slack] bot-to-bot loop guard dropped a message', '31:[slack] Slack rate limited: retry-after 3', '32:throttled persona_b', '33:too many messages']
    expect(judgeLimitLines([...skipped, ...rateLimit, ...other])).toEqual({ failures: other, notes: rateLimit })
  })

  test('waitTags polls `tags` until it prints, then reads once more a poll later (a late duplicate counts); at the deadline it gives none', async () => {
    const tag = '<channel source="slack" chat_id="C0DRYCOORD" user_id="U0DRYBOTA0" via="mention">'
    let calls = 0
    const answers = ['', '', tag, `${tag}\n${tag}`]
    const clock = virtualClock()
    const c = fakeContainer([["tags b '1700000200.000001'", () => answers[calls++] ?? '']])
    const start = clock.now()
    expect(await waitTags(makeCtx({ container: c.container, clock }), 'b', '1700000200.000001')).toEqual([tag, tag])
    expect([calls, clock.now() - start]).toEqual([4, 15_000])

    const silent = virtualClock()
    const at = silent.now()
    expect(await waitTags(makeCtx({ clock: silent }), 'b', '1700000200.000001')).toEqual([])
    expect(silent.now() - at).toBe(TAG_TIMEOUT_MS)
  })

  test('liveIdsFrom names what apps.json lacks, and gives the IDs when it is complete', () => {
    expect(liveIdsFrom(emptyAppsState())).toBe(
      'apps.json is incomplete (persona a, persona b, persona c, persona d, team_id, human_user_id, channels): run the provisioning first',
    )
    const full = {
      version: 1 as const,
      team_id: DRY_RUN_IDS.teamId,
      human_user_id: DRY_RUN_IDS.humanUserId,
      personas: Object.fromEntries(Object.entries(DRY_RUN_IDS.bots).map(([l, b]) => [l, { app_id: b.appId, bot_user_id: b.userId, bot_id: b.botId }])),
      channels: { 'a-home': DRY_RUN_IDS.aHome, coordination: DRY_RUN_IDS.coordination, 'd-home': DRY_RUN_IDS.dHome },
    }
    expect(liveIdsFrom(full)).toEqual(DRY_RUN_IDS)
    delete (full.personas as Record<string, { bot_id?: string }>).c!.bot_id
    expect(liveIdsFrom(full)).toBe('apps.json is incomplete (persona c): run the provisioning first')
  })
})

// ---------------------------------------------------------------------------
// The transcript helpers `tags` and `tagstext`, run by bash over a fixture
// ---------------------------------------------------------------------------

describe("tags and tagstext over a transcript (the container's helpers and the plan's Part 1.3 copy)", () => {
  const REPO = join(import.meta.dir, '..')
  const containerHelpers = readFileSync(join(REPO, 'docker', 'live', 'cscb-live-helpers.sh'), 'utf-8')
  const planHelpers = (() => {
    const plan = readFileSync(join(REPO, 'testplans', 'b.yko', 'b.yko.md'), 'utf-8')
    const start = plan.indexOf("cat > ~/cscb-live-helpers.sh <<'EOF'\n")
    return plan.slice(start, plan.indexOf('\nEOF\n', start) + 1)
  })()

  /** The `name() { … }` definition in a helpers file, up to its closing `}` line. */
  function shellFunction(source: string, name: string): string {
    const start = source.indexOf(`\n${name}() {\n`)
    if (start < 0) throw new Error(`no ${name}() in the helpers`)
    return source.slice(start + 1, source.indexOf('\n}\n', start) + 3)
  }

  const TS = { idle: '1700000100.000001', midTurn: '1700000100.000002', blocks: '1700000100.000003', userBlocks: '1700000100.000004' }
  const tag = (ts: string, via: string) => `<channel source="slack" chat_id="${COORD}" user_id="${DRY_RUN_IDS.humanUserId}" ts="${ts}" via="${via}">`
  const body = (ts: string, via: string, text: string) => `${tag(ts, via)}\n${text}\n</channel>`
  const midTurn = body(TS.midTurn, 'receive_all', 'Window check two.')
  /**
   * One message delivered while A was idle (a user entry), one mid-turn (its
   * queue entries, then a queued_command attachment with a string prompt),
   * one mid-turn with content blocks, one user entry with content blocks,
   * and entries that are no delivery: a tool result, another attachment
   * type holding a tag, an attachment that is not an object, and A quoting
   * a tag.
   */
  const TRANSCRIPT = [
    { type: 'user', message: { role: 'user', content: body(TS.idle, 'mention', 'Idle delivery.') } },
    { type: 'queue-operation', operation: 'enqueue', content: midTurn },
    { type: 'queue-operation', operation: 'remove', content: midTurn },
    { type: 'attachment', attachment: { type: 'queued_command', commandMode: 'prompt', prompt: midTurn } },
    {
      type: 'attachment',
      attachment: { type: 'queued_command', commandMode: 'prompt', prompt: [{ type: 'text', text: body(TS.blocks, 'mention', 'Blocks prompt.') }, { type: 'image', source: {} }] },
    },
    { type: 'user', message: { role: 'user', content: [{ type: 'text', text: body(TS.userBlocks, 'broadcast', 'Blocks user entry.') }] } },
    { type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: 'ok' }] } },
    { type: 'attachment', attachment: { type: 'prompt_snapshot', prompt: midTurn } },
    { type: 'attachment', attachment: 'not an object' },
    { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: `I saw ${tag(TS.idle, 'mention')}` }] } },
  ]

  let home = ''
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'ci-live-tags-'))
    const dir = join(home, '.claude', 'projects', '-home-testuser-cscb-live-a')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, '0f0f0f0f-session.jsonl'), TRANSCRIPT.map((e) => JSON.stringify(e)).join('\n') + '\n')
  })
  afterEach(() => rmSync(home, { recursive: true, force: true }))

  /** Run one helper, defined from `source`, in bash with the fixture home; its output lines. */
  function helper(source: string, ...args: string[]): string[] {
    const defs = `${shellFunction(source, 'tags')}\n${shellFunction(source, 'tagstext')}`
    const r = Bun.spawnSync([Bun.which('bash')!, '-c', `${defs}\n"$@"`, 'helpers', ...args], { env: { HOME: home, PATH: process.env.PATH ?? '/usr/bin:/bin' } })
    expect(r.stderr.toString()).toBe('')
    return r.stdout.toString().split('\n').filter((l) => l !== '')
  }

  const SOURCES = [
    ['docker/live/cscb-live-helpers.sh', containerHelpers],
    ["the plan's Part 1.3", planHelpers],
  ] as const

  test.each(SOURCES)('%s: tags prints one tag per delivery, from a user entry or a queued_command attachment, string or blocks alike', (_where, source) => {
    expect(helper(source, 'tags', 'a', TS.idle)).toEqual([tag(TS.idle, 'mention')])
    // Mid-turn: the attachment only, not the queue entries or the prompt snapshot that hold the same text.
    expect(helper(source, 'tags', 'a', TS.midTurn)).toEqual([tag(TS.midTurn, 'receive_all')])
    expect(helper(source, 'tags', 'a', TS.blocks)).toEqual([tag(TS.blocks, 'mention')])
    expect(helper(source, 'tags', 'a', TS.userBlocks)).toEqual([tag(TS.userBlocks, 'broadcast')])
    expect(helper(source, 'tags', 'a', '1700000100.000009')).toEqual([])
  })

  test.each(SOURCES)('%s: tagstext finds the tag of a message by its text, in a queued_command attachment too', (_where, source) => {
    expect(helper(source, 'tagstext', 'a', 'Window check two.')).toEqual([tag(TS.midTurn, 'receive_all')])
    expect(helper(source, 'tagstext', 'a', 'Blocks prompt.')).toEqual([tag(TS.blocks, 'mention')])
    expect(helper(source, 'tagstext', 'a', 'Idle delivery.')).toEqual([tag(TS.idle, 'mention')])
    expect(helper(source, 'tagstext', 'a', 'never sent')).toEqual([])
  })
})
