/**
 * ci-live-prompt-guard.test.ts — Tests for the /ci-live runner's prompt guard
 * (bug b.1cx, run 6's recommendation): `ci-live/checks/prompt-guard.ts`.
 *
 * The rules under test:
 * - the guard reads the permission trail from where it left off, groups the
 *   posts by `request_token` (the latest copy wins: a restart posts an open
 *   prompt again) and takes a token as resolved once a decide that
 *   succeeded, a closing message update or a reconciled closure names it; a
 *   refused decide (`ErrRelayFallenBack` and the like) and the update that
 *   renders that refusal leave it open, so it is still denied;
 * - an open prompt no running check expects is denied once it is older than
 *   PROMPT_GUARD_GRACE_MS (15 s), never before; one the running check
 *   declared (its persona, its command matching) is left alone while that
 *   check runs;
 * - when a check ends, every prompt first seen while it ran that is still
 *   open is denied, however young, except a `leaveOpen` one, which is never
 *   denied; `denyLeftovers` does the same from inside the check;
 * - a denial clicks Deny on the latest copy, and falls back to the guarded
 *   `agent-director decide … --decision deny` when the click fails or no copy
 *   reached Slack; a prompt is denied once, a failed denial noted and not
 *   retried;
 * - each denial is a run note and a report entry naming the check, the
 *   persona and the command, the command through the redactor, on one line
 *   and capped; nothing is a FAIL;
 * - reads, sweeps and denials run one at a time; a failed read is logged
 *   once; a trail shorter than what was read is read again from its start;
 *   the loop ticks every PROMPT_GUARD_INTERVAL_MS until stopped;
 * - the trail script (run by bash and jq over a fixture trail) reads one cut
 *   of the file and skips a line that doesn't parse; the real dependencies
 *   reach the container only through `ctx.container`, the fallback behind the
 *   plan's `guard`, and click as the checks click.
 *
 * No docker, network or real host state: the trail, the container, the
 * browser, the test human's session and the clock are fakes.
 *
 * SPDX-License-Identifier: MIT
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { DRY_RUN_IDS } from '../ci-live/checks/context.ts'
import { PROMPT_POST_JQ, promptPosts, waitPromptPost } from '../ci-live/checks/helpers.ts'
import {
  containerPromptGuardDeps,
  DECIDED_RESULT_CLASSES,
  denyScript,
  NOT_A_VERDICT_TAG,
  noteFor,
  parsePromptTrail,
  personaOfInstance,
  PROMPT_GUARD_COMMAND_MAX,
  PROMPT_GUARD_DENY_REASON,
  PROMPT_GUARD_GRACE_MS,
  PROMPT_GUARD_INTERVAL_MS,
  PROMPT_TRAIL_JQ,
  PromptGuard,
  promptTrailScript,
  showCommand,
  type DenyAttempt,
  type GuardedPrompt,
  type PromptGuardDeps,
  type PromptTrailRead,
} from '../ci-live/checks/prompt-guard.ts'
import type { BrowserDriver, HumanApi } from '../ci-live/lib/browser-types.ts'
import type { ContainerExec } from '../ci-live/lib/container.ts'
import { HumanSession } from '../ci-live/lib/human-session.ts'
import type { PersonaLetter } from '../ci-live/lib/personas.ts'
import type { ProcResult } from '../ci-live/lib/proc.ts'
import { REDACTED_SECRET, REDACTED_TOKEN, Redactor } from '../ci-live/lib/redact.ts'
import { SECOND, type Clock } from '../ci-live/lib/wait.ts'
import { virtualClock } from './test-helpers/ci-live.ts'
import { assertNoLeak, BOT_TOKEN_PREFIX, fakeToken } from './test-helpers/credentials.ts'
import { hostSafeChildEnv } from './test-helpers/host-safe-env.ts'

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/** A prompt's section text as CSCB posts it: the tool, then the command in backticks. */
const section = (command: string, tool = 'Bash') => `🤖🛠️ *${tool}*\n\`${command}\``

/** A registered secret, not token-shaped: only the known-value rule masks it. */
const SECRET = 'prompt-guard-fixture-secret-9f3k'

interface PostOptions {
  channel?: string
  slackTs?: string | null
  ok?: boolean
  /** How long before now it was posted (ms). */
  ago?: number
  /** A trail `ts` the guard can't parse. */
  badTs?: boolean
}

/**
 * The container's permission trail as the guard reads it, on the test's
 * clock: posts and closing events appended in order; `read(from)` gives the
 * line count and what follows line `from`, as `promptTrail` does.
 */
function fakeTrail(clock: Clock) {
  type Line = { kind: 'post'; post: Record<string, unknown> } | { kind: 'closed'; token: string } | { kind: 'other' }
  const lines: Line[] = []
  let failing: Error | null = null
  const reads: number[] = []
  return {
    reads,
    post(persona: PersonaLetter | string, token: string, command: string, o: PostOptions = {}) {
      const instance = persona.length === 1 ? `cscb_persona_${persona}` : persona
      lines.push({
        kind: 'post',
        post: {
          claude_instance_id: instance,
          channel: o.channel ?? DRY_RUN_IDS.aHome,
          ok: o.ok ?? true,
          error: null,
          slack_ts: o.slackTs === undefined ? `1700000100.${String(lines.length + 1).padStart(6, '0')}` : o.slackTs,
          request_token: token,
          ts: o.badTs ? 'not a time' : new Date(clock.now() - (o.ago ?? 0)).toISOString(),
          command: section(command),
        },
      })
    },
    close(token: string) {
      lines.push({ kind: 'closed', token })
    },
    other() {
      lines.push({ kind: 'other' })
    },
    /** The trail replaced by a shorter one (its lines kept up to `n`). */
    truncate(n: number) {
      lines.length = n
    },
    failNext(err: Error) {
      failing = err
    },
    read: async (from: number): Promise<PromptTrailRead> => {
      reads.push(from)
      if (failing) {
        const err = failing
        failing = null
        throw err
      }
      const after = lines.slice(from)
      return {
        lines: lines.length,
        posts: after.flatMap((l) => (l.kind === 'post' ? [l.post as never] : [])),
        closed: after.flatMap((l) => (l.kind === 'closed' ? [l.token] : [])),
      }
    },
  }
}

/** The guard over a fake trail, a virtual clock and recorded denials; `click` and `decide` answer as told. */
function guardWith(opts: { click?: (p: GuardedPrompt) => Promise<DenyAttempt>; decide?: (p: GuardedPrompt) => Promise<DenyAttempt> } = {}) {
  const clock = virtualClock()
  const trail = fakeTrail(clock)
  const clicks: string[] = []
  const decides: string[] = []
  const notes: string[] = []
  const logs: string[] = []
  const redactor = new Redactor()
  redactor.addSecret(SECRET)
  const deps: PromptGuardDeps = {
    clock,
    readTrail: trail.read,
    click: async (p) => {
      clicks.push(`${p.token} ${p.channel} ${p.slackTs}`)
      return opts.click ? opts.click(p) : { ok: true }
    },
    decide: async (p) => {
      decides.push(`${p.instanceId} ${p.token}`)
      return opts.decide ? opts.decide(p) : { ok: true }
    },
    redact: (text) => redactor.redact(text),
    log: (line) => logs.push(line),
    note: (line) => notes.push(line),
  }
  const guard = new PromptGuard(deps)
  return { guard, trail, clock, clicks, decides, notes, logs, deps }
}

const pastGrace = (clock: Clock) => clock.sleep(PROMPT_GUARD_GRACE_MS)

// ---------------------------------------------------------------------------
// Grouping and resolution
// ---------------------------------------------------------------------------

describe('the prompt guard: grouping by request token and resolution', () => {
  test('two copies of one request (a restart posts it again) are one prompt, and its latest copy is the one clicked', async () => {
    const g = guardWith()
    g.trail.post('a', 'tok-1', 'env | grep -i slack', { ago: 20 * SECOND, slackTs: '1700000100.000001' })
    g.trail.other()
    g.trail.post('a', 'tok-1', 'env | grep -i slack', { ago: 5 * SECOND, slackTs: '1700000200.000001', channel: 'C0DRYAHOME' })
    await g.guard.tick()
    expect(g.clicks).toEqual([`tok-1 C0DRYAHOME 1700000200.000001`])
    expect(g.guard.report()).toMatchObject({ seen: 1, denied: 1, notDenied: 0 })
  })

  test('a failed post of a later copy keeps the latest copy that reached Slack', async () => {
    const g = guardWith()
    g.trail.post('a', 'tok-1', 'env', { ago: 20 * SECOND, slackTs: '1700000100.000001' })
    g.trail.post('a', 'tok-1', 'env', { ok: false, slackTs: null })
    await g.guard.tick()
    expect(g.clicks).toEqual(['tok-1 C0DRYAHOME 1700000100.000001'])
  })

  test('the age is from the first copy: a re-post does not restart the grace', async () => {
    const g = guardWith()
    g.trail.post('a', 'tok-1', 'env', { ago: 14 * SECOND })
    await g.guard.tick()
    expect(g.clicks).toEqual([])
    await g.clock.sleep(2 * SECOND)
    g.trail.post('a', 'tok-1', 'env')
    await g.guard.tick()
    expect(g.clicks.length).toBe(1)
  })

  test.each(['a decide', 'a closing message update', 'a reconciled closure'])('a request %s names is resolved: never denied', async () => {
    const g = guardWith()
    g.trail.post('a', 'tok-1', 'env', { ago: 30 * SECOND })
    g.trail.close('tok-1')
    await g.guard.tick()
    g.guard.beforeCheck('12')
    await g.guard.afterCheck('12')
    expect([g.clicks, g.decides, g.notes]).toEqual([[], [], []])
    expect(g.guard.report()).toEqual({ seen: 1, denied: 0, notDenied: 0, entries: [] })
  })

  test('a closure read in a later tick than its post still stops the denial (the grace had not passed)', async () => {
    const g = guardWith()
    g.trail.post('a', 'tok-1', 'env')
    await g.guard.tick()
    g.trail.close('tok-1')
    await pastGrace(g.clock)
    await g.guard.tick()
    expect(g.clicks).toEqual([])
  })

  test('the trail is read from where the last read ended; a trail shorter than that is read again from its start', async () => {
    const g = guardWith()
    g.trail.other()
    g.trail.other()
    await g.guard.tick()
    await g.guard.tick()
    g.trail.truncate(0)
    g.trail.post('b', 'tok-9', 'ls', { ago: 30 * SECOND })
    await g.guard.tick()
    expect(g.trail.reads).toEqual([0, 2, 2, 0])
    expect(g.clicks.length).toBe(1)
  })

  test('a post with no request token is skipped; a prompt from no persona is still denied, named by its instance', async () => {
    const g = guardWith()
    g.trail.post('a', '', 'env', { ago: 30 * SECOND })
    g.trail.post('cscb_legacy_bot', 'tok-2', 'env', { ago: 30 * SECOND })
    await g.guard.tick()
    expect(g.guard.report().entries.map((e) => e.persona)).toEqual(['cscb_legacy_bot'])
  })
})

// ---------------------------------------------------------------------------
// Grace, expectations and the stand-down
// ---------------------------------------------------------------------------

describe('the prompt guard: grace, expectations and the stand-down', () => {
  test(`an unexpected prompt is left alone for the ${PROMPT_GUARD_GRACE_MS / 1000} s grace, then denied`, async () => {
    expect(PROMPT_GUARD_GRACE_MS).toBe(15 * SECOND)
    const g = guardWith()
    g.guard.beforeCheck('12')
    g.trail.post('a', 'tok-1', "env | grep -i -E 'cscb|slack'")
    await g.guard.tick()
    await g.clock.sleep(PROMPT_GUARD_GRACE_MS - 1)
    await g.guard.tick()
    expect(g.clicks).toEqual([])
    await g.clock.sleep(1)
    await g.guard.tick()
    expect(g.clicks.length).toBe(1)
    expect(g.notes).toEqual(["prompt guard: denied persona_a's unexpected prompt (check 12): Bash: env | grep -i -E 'cscb|slack'; Deny clicked"])
  })

  test('a trail time it cannot parse counts from when the guard first saw the prompt', async () => {
    const g = guardWith()
    g.trail.post('a', 'tok-1', 'env', { badTs: true })
    await g.guard.tick()
    expect(g.clicks).toEqual([])
    await pastGrace(g.clock)
    await g.guard.tick()
    expect(g.clicks.length).toBe(1)
  })

  test("the running check's declared prompt (its persona, its command) is left alone past the grace; another persona's or another command's is denied", async () => {
    const g = guardWith()
    g.guard.beforeCheck('22')
    g.guard.expect({ persona: 'b', command: /dm-prompt-b\.txt/ })
    g.trail.post('b', 'tok-b', 'date > dm-prompt-b.txt', { ago: 60 * SECOND })
    g.trail.post('b', 'tok-ls', 'ls -la', { ago: 60 * SECOND })
    g.trail.post('a', 'tok-a', 'date > dm-prompt-b.txt', { ago: 60 * SECOND })
    await g.guard.tick()
    expect(g.clicks.map((c) => c.split(' ')[0])).toEqual(['tok-ls', 'tok-a'])
    expect(g.guard.report().entries.map((e) => [e.persona, e.why, e.check])).toEqual([
      ['persona_b', 'unexpected', 'check 22'],
      ['persona_a', 'unexpected', 'check 22'],
    ])
  })

  test("a check's expectations end with it: the next check's prompt of the same kind is unexpected", async () => {
    const g = guardWith()
    g.guard.beforeCheck('5')
    g.guard.expect({ persona: 'a', command: /permission-check\.txt/ })
    await g.guard.afterCheck('5')
    g.guard.beforeCheck('6')
    g.trail.post('a', 'tok-late', 'date > permission-check.txt', { ago: 20 * SECOND })
    await g.guard.tick()
    expect(g.guard.report().entries.map((e) => [e.check, e.why])).toEqual([['check 6', 'unexpected']])
  })

  test('an expectation declared with no check running owns nothing', async () => {
    const g = guardWith()
    g.guard.expect({ persona: 'a', command: /env/ })
    g.trail.post('a', 'tok-1', 'env', { ago: 20 * SECOND })
    await g.guard.tick()
    expect(g.guard.report().entries.map((e) => [e.check, e.why])).toEqual([['before the first check', 'unexpected']])
  })

  test('a prompt first seen between checks is named by the check before it', async () => {
    const g = guardWith()
    g.guard.beforeCheck('11')
    await g.guard.afterCheck('11')
    g.trail.post('a', 'tok-1', 'env', { ago: 20 * SECOND })
    await g.guard.tick()
    expect(g.notes).toEqual(["prompt guard: denied persona_a's unexpected prompt (between checks, after check 11): Bash: env; Deny clicked"])
  })
})

// ---------------------------------------------------------------------------
// The end-of-check sweep
// ---------------------------------------------------------------------------

describe('the prompt guard: the end-of-check sweep', () => {
  test('when a check ends, its declared prompt still open is denied as left open, and an unexpected one however young; its resolved ones are not', async () => {
    const g = guardWith()
    g.guard.beforeCheck('23')
    g.guard.expect({ persona: 'a', command: /prompt-a\.txt/ })
    g.guard.expect({ persona: 'b', command: /prompt-b\.txt/ })
    g.trail.post('a', 'tok-a', 'date > prompt-a.txt')
    g.trail.post('b', 'tok-b', 'date > prompt-b.txt')
    await g.guard.tick()
    g.trail.close('tok-a')
    g.trail.post('c', 'tok-c', 'whoami')
    await g.guard.afterCheck('23')
    expect(g.clicks.map((c) => c.split(' ')[0])).toEqual(['tok-b', 'tok-c'])
    expect(g.notes).toEqual([
      "prompt guard: denied persona_b's prompt that check 23 left open: Bash: date > prompt-b.txt; Deny clicked",
      "prompt guard: denied persona_c's unexpected prompt (check 23): Bash: whoami; Deny clicked",
    ])
  })

  test("the sweep denies only the ending check's prompts, not an earlier one's (the loop's)", async () => {
    const g = guardWith({ decide: async () => ({ ok: false, why: 'exit 1' }), click: async () => ({ ok: false, why: 'x' }) })
    g.guard.beforeCheck('4')
    g.trail.post('a', 'tok-4', 'env')
    await g.guard.tick()
    await g.guard.afterCheck('4')
    g.guard.beforeCheck('5')
    g.trail.post('a', 'tok-5', 'pwd')
    await g.guard.afterCheck('5')
    // tok-4 was swept when 4 ended (and not denied: both ways failed); it is never tried again.
    expect(g.decides.map((d) => d.split(' ')[1])).toEqual(['tok-4', 'tok-5'])
  })

  test('a leaveOpen prompt is never denied: not by the sweep, not by the loop later', async () => {
    const g = guardWith()
    g.guard.beforeCheck('27')
    g.guard.expect({ persona: 'd', command: /removal-prompt\.txt/, leaveOpen: true })
    g.trail.post('d', 'tok-d', 'date > removal-prompt.txt')
    await g.guard.afterCheck('27')
    g.guard.beforeCheck('28')
    g.trail.post('d', 'tok-d', 'date > removal-prompt.txt')
    await g.clock.sleep(10 * 60 * SECOND)
    await g.guard.tick()
    await g.guard.afterCheck('28')
    expect([g.clicks, g.decides, g.notes]).toEqual([[], [], []])
  })

  test('denyLeftovers (a check\'s own finally) sweeps the running check now, once: the end-of-check sweep then has nothing left', async () => {
    const g = guardWith()
    expect(await g.guard.denyLeftovers()).toBe(0)
    g.guard.beforeCheck('23')
    g.guard.expect({ persona: 'b', command: /prompt-b\.txt/ })
    g.trail.post('b', 'tok-b', 'date > prompt-b.txt')
    g.trail.post('b', 'tok-b2', 'date > prompt-b.txt')
    g.trail.close('tok-b2')
    expect(await g.guard.denyLeftovers()).toBe(1)
    await g.guard.afterCheck('23')
    expect(g.clicks.map((c) => c.split(' ')[0])).toEqual(['tok-b'])
  })

  test('denyLeftovers never throws: a sweep that fails is logged and counts 0', async () => {
    const g = guardWith()
    g.guard.beforeCheck('23')
    g.trail.post('b', 'tok-b', 'x')
    const deps = g.deps as { note: (line: string) => void }
    deps.note = () => {
      throw new Error('note sink broke')
    }
    expect(await g.guard.denyLeftovers()).toBe(0)
    expect(g.logs).toEqual(['prompt guard: the sweep for check 23 failed: Error: note sink broke'])
  })
})

// ---------------------------------------------------------------------------
// Denying: the click, the fallback, once only
// ---------------------------------------------------------------------------

describe('the prompt guard: the Deny click and the agent-director fallback', () => {
  test('a click that works is the denial; decide is not run', async () => {
    const g = guardWith()
    g.trail.post('a', 'tok-1', 'env', { ago: 20 * SECOND })
    await g.guard.tick()
    expect([g.clicks.length, g.decides.length]).toEqual([1, 0])
    expect(g.guard.report().entries[0]?.how).toBe('Deny clicked')
  })

  test.each([
    ['the click did not show the denial', async (): Promise<DenyAttempt> => ({ ok: false, why: 'the message did not show the denial' }), 'the Deny click failed (the message did not show the denial)'],
    [
      'the click threw',
      async (): Promise<DenyAttempt> => {
        throw new Error('button: no "Deny" button on message 1700000100.000001')
      },
      'the Deny click failed (Error: button: no "Deny" button on message 1700000100.000001)',
    ],
  ])('%s: agent-director decide denies it, and the note says why', async (_what, click, why) => {
    const g = guardWith({ click })
    g.trail.post('a', 'tok-1', 'env', { ago: 20 * SECOND })
    await g.guard.tick()
    expect(g.decides).toEqual(['cscb_persona_a tok-1'])
    expect(g.notes).toEqual([`prompt guard: denied persona_a's unexpected prompt (before the first check): Bash: env; ${why}, so denied with agent-director decide`])
    expect(g.guard.report()).toMatchObject({ denied: 1, notDenied: 0 })
    expect(g.guard.report().entries[0]?.how).toBe('agent-director decide')
  })

  test('no copy reached Slack: straight to agent-director decide, no click', async () => {
    const g = guardWith()
    g.trail.post('a', 'tok-1', 'env', { ago: 20 * SECOND, ok: false, slackTs: null })
    await g.guard.tick()
    expect([g.clicks, g.decides]).toEqual([[], ['cscb_persona_a tok-1']])
    expect(g.notes[0]).toEndWith('; no copy of it reached Slack, so denied with agent-director decide')
  })

  test('both failing: noted as not denied, logged, and never tried again (not by a later tick, not by the sweep)', async () => {
    const g = guardWith({
      click: async () => ({ ok: false, why: 'the message did not show the denial' }),
      decide: async () => {
        throw new Error('docker exec failed')
      },
    })
    g.guard.beforeCheck('12')
    g.trail.post('a', 'tok-1', 'env', { ago: 20 * SECOND })
    await g.guard.tick()
    await g.guard.tick()
    await g.guard.afterCheck('12')
    const line = "prompt guard: could not deny persona_a's unexpected prompt (check 12): Bash: env; the Deny click failed (the message did not show the denial); agent-director decide failed (Error: docker exec failed)"
    expect([g.clicks.length, g.decides.length, g.notes, g.logs]).toEqual([1, 1, [line], [line]])
    expect(g.guard.report()).toMatchObject({ seen: 1, denied: 0, notDenied: 1 })
  })
})

// ---------------------------------------------------------------------------
// Notes and the report
// ---------------------------------------------------------------------------

describe('the prompt guard: notes and the report', () => {
  test('the command goes through the redactor (a registered value, a token-shaped string), on one line; the report counts and names each denial', async () => {
    const g = guardWith()
    const token = fakeToken(BOT_TOKEN_PREFIX, 'cmd')
    g.guard.beforeCheck('12')
    g.trail.post('a', 'tok-1', `env | grep ${SECRET}\n  && echo ${token}`, { ago: 20 * SECOND })
    await g.guard.tick()
    const report = g.guard.report()
    expect(report).toEqual({
      seen: 1,
      denied: 1,
      notDenied: 0,
      entries: [{ check: 'check 12', persona: 'persona_a', command: `Bash: env | grep ${REDACTED_SECRET} && echo ${REDACTED_TOKEN}`, why: 'unexpected', how: 'Deny clicked' }],
    })
    expect(g.notes).toEqual([`prompt guard: denied persona_a's unexpected prompt (check 12): Bash: env | grep ${REDACTED_SECRET} && echo ${REDACTED_TOKEN}; Deny clicked`])
    assertNoLeak({ report, notes: g.notes, logs: g.logs })
    expect(JSON.stringify({ report, notes: g.notes })).not.toContain(SECRET)
  })

  test(`showCommand: the tool and the command from CSCB's section, else the text; capped at ${PROMPT_GUARD_COMMAND_MAX} characters`, () => {
    const redact = (s: string) => s
    expect(showCommand(section('date > a.txt'), redact)).toBe('Bash: date > a.txt')
    expect(showCommand(section('/home/testuser/cscb-live/a/x.txt', 'Write'), redact)).toBe('Write: /home/testuser/cscb-live/a/x.txt')
    expect(showCommand('🤖🛠️ permission request: Bash', redact)).toBe('🤖🛠️ permission request: Bash')
    expect(showCommand('', redact)).toBe('(no command text)')
    const long = showCommand(section('x'.repeat(500)), redact)
    expect([long.length, long.endsWith('…')]).toEqual([PROMPT_GUARD_COMMAND_MAX, true])
  })

  test('noteFor words each outcome', () => {
    const e = { check: 'check 23', persona: 'persona_b', command: 'Bash: ls', why: 'left open' as const }
    expect(noteFor({ ...e, how: 'Deny clicked' }, [])).toBe("prompt guard: denied persona_b's prompt that check 23 left open: Bash: ls; Deny clicked")
    expect(noteFor({ ...e, how: 'not denied' }, ['a', 'b'])).toBe("prompt guard: could not deny persona_b's prompt that check 23 left open: Bash: ls; a; b")
  })

  test('personaOfInstance: cscb_persona_<x> only', () => {
    expect(['cscb_persona_a', 'cscb_persona_d', 'cscb_persona_e', 'persona_a', 'cscb_persona_a2'].map(personaOfInstance)).toEqual(['a', 'd', null, null, null])
  })
})

// ---------------------------------------------------------------------------
// One at a time, failed reads, the loop
// ---------------------------------------------------------------------------

describe('the prompt guard: serialized work, failed reads and the loop', () => {
  test('a sweep waits for a tick whose denial is in flight: one denial, not two', async () => {
    let release = () => {}
    const g = guardWith({
      click: () =>
        new Promise<DenyAttempt>((resolve) => {
          release = () => resolve({ ok: true })
        }),
    })
    g.guard.beforeCheck('12')
    g.trail.post('a', 'tok-1', 'env', { ago: 20 * SECOND })
    const tick = g.guard.tick()
    const swept = g.guard.afterCheck('12')
    await Bun.sleep(0)
    expect(g.clicks.length).toBe(1)
    release()
    await Promise.all([tick, swept])
    expect(g.clicks.length).toBe(1)
    expect(g.notes.length).toBe(1)
  })

  test('a failed read is logged once until a read works again, and denies nothing', async () => {
    const g = guardWith()
    g.trail.failNext(new Error('docker exec: container restarting'))
    await g.guard.tick()
    g.trail.failNext(new Error('docker exec: container restarting'))
    await g.guard.tick()
    await g.guard.tick()
    expect(g.logs).toEqual([
      'prompt guard: reading the permission trail failed: Error: docker exec: container restarting (logged once until a read works)',
      'prompt guard: reading the permission trail works again',
    ])
  })

  test(`the loop ticks every ${PROMPT_GUARD_INTERVAL_MS / 1000} s until stopped; stop wakes a sleeping loop at once`, async () => {
    expect(PROMPT_GUARD_INTERVAL_MS).toBe(10 * SECOND)
    const sleeps: { ms: number; wake: () => void }[] = []
    const g = guardWith()
    const deps = g.deps as { clock: Clock }
    deps.clock = { now: () => 1_700_000_000_000, sleep: (ms) => new Promise<void>((wake) => sleeps.push({ ms, wake })) }
    g.guard.start()
    g.guard.start()
    await Bun.sleep(0)
    expect(sleeps.map((s) => s.ms)).toEqual([PROMPT_GUARD_INTERVAL_MS])
    expect(g.trail.reads).toEqual([])
    sleeps[0]!.wake()
    await Bun.sleep(0)
    expect(g.trail.reads).toEqual([0])
    expect(sleeps.length).toBe(2)
    await g.guard.stop()
    sleeps[1]!.wake()
    await Bun.sleep(0)
    expect(g.trail.reads).toEqual([0])
  })

  test('halt stops the loop without waiting', async () => {
    const g = guardWith()
    const deps = g.deps as { clock: Clock }
    deps.clock = { now: () => 0, sleep: () => new Promise<void>(() => {}) }
    g.guard.start()
    g.guard.halt()
    await g.guard.stop()
    expect(g.trail.reads).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// The trail script, by bash and jq over a fixture trail
// ---------------------------------------------------------------------------

describe('promptTrailScript over a fixture trail (bash and jq)', () => {
  let dir = ''
  // The script's HOME: a directory under `dir`, removed with it.
  let home = ''
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'ci-live-trail-'))
    home = join(dir, 'home')
    mkdirSync(home)
  })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  const LINES = [
    { ts: '2026-09-26T18:46:07.653Z', event: 'cscb.poller.row_decision', claude_instance_id: 'cscb_persona_a', action: 'post_attempted', request_token: 't1' },
    {
      ts: '2026-09-26T18:46:07.700Z',
      event: 'cscb.chat_post.attempted',
      claude_instance_id: 'cscb_persona_a',
      request_token: 't1',
      channel: 'C0DRYAHOME',
      text: '🤖🛠️ permission request: Bash',
      blocks: [{ type: 'section', text: { type: 'mrkdwn', text: section("env | grep -i -E 'cscb|slack'") } }, { type: 'actions', elements: [] }],
      ok: true,
      slack_ts: '1790447967.000100',
    },
    'not json {',
    { ts: '2026-09-26T18:47:00.000Z', event: 'cscb.ad_decide.attempted', claude_instance_id: 'cscb_persona_b', request_token: 't2', decision: 'deny', result_class: 'ok' },
    { ts: '2026-09-26T18:47:01.000Z', event: 'cscb.chat_update.attempted', request_token: 't3', verdict_tag: 'operator_allow' },
    { ts: '2026-09-26T18:47:02.000Z', event: 'cscb.poller.row_decision', action: 'reconciled_closed', request_token: 't4' },
    { ts: '2026-09-26T18:47:03.000Z', event: 'cscb.chat_post.attempted', claude_instance_id: 'cscb_persona_b', request_token: 't5', text: 'permission request: Bash', ok: false, error: 'channel_not_found' },
  ]

  function runScript(from: number, trail: string | null): { out: string[]; code: number } {
    const path = join(dir, 'permission-trail.jsonl')
    if (trail !== null) writeFileSync(path, trail)
    // The script's own tools: bash runs it, wc/head/tail cut the trail, jq projects it.
    const r = Bun.spawnSync([Bun.which('bash')!, '-c', `TRAIL=${JSON.stringify(path)}\n${promptTrailScript(from)}`], {
      env: hostSafeChildEnv(home, { tools: ['bash', 'wc', 'head', 'tail', 'jq'] }),
    })
    return { out: r.stdout.toString().split('\n').filter((l) => l.trim() !== ''), code: r.exitCode ?? -1 }
  }

  const text = (lines: readonly unknown[]) => lines.map((l) => (typeof l === 'string' ? l : JSON.stringify(l))).join('\n') + '\n'

  test('the posts (promptPosts\'s projection) and the closing events after a line; a line that does not parse is skipped', () => {
    const r = runScript(0, text(LINES))
    expect(r.code).toBe(0)
    const read = parsePromptTrail(r.out)!
    expect(read.lines).toBe(LINES.length)
    expect(read.posts as unknown[]).toEqual([
      {
        claude_instance_id: 'cscb_persona_a',
        channel: 'C0DRYAHOME',
        ok: true,
        error: null,
        slack_ts: '1790447967.000100',
        request_token: 't1',
        ts: '2026-09-26T18:46:07.700Z',
        command: section("env | grep -i -E 'cscb|slack'"),
      },
      { claude_instance_id: 'cscb_persona_b', channel: null, ok: false, error: 'channel_not_found', slack_ts: null, request_token: 't5', ts: '2026-09-26T18:47:03.000Z', command: 'permission request: Bash' },
    ])
    expect(read.closed).toEqual(['t2', 't3', 't4'])
    expect(runScript(4, text(LINES)).out.slice(1).map((l) => JSON.parse(l))).toEqual([{ closed: 't3' }, { closed: 't4' }, { post: expect.objectContaining({ request_token: 't5' }) }])
  })

  /** A `cscb.ad_decide.attempted` line as CSCB's click handler writes it; no `result_class` when `resultClass` is undefined. */
  const decideLine = (token: string, resultClass: string | undefined, extra: Record<string, unknown> = {}) => ({
    ts: '2026-09-26T18:48:00.000Z',
    event: 'cscb.ad_decide.attempted',
    claude_instance_id: 'cscb_persona_a',
    request_token: token,
    decision: 'deny',
    ...(resultClass === undefined ? {} : { result_class: resultClass }),
    ...extra,
  })

  /** A `cscb.chat_update.attempted` line from the click handler. */
  const clickUpdateLine = (token: string, verdictTag: string) => ({
    ts: '2026-09-26T18:48:01.000Z',
    event: 'cscb.chat_update.attempted',
    claude_instance_id: 'cscb_persona_a',
    request_token: token,
    channel: 'C0DRYAHOME',
    message_ts: '1790447967.000100',
    verdict_tag: verdictTag,
    triggered_by: 'click_handler',
    ok: true,
  })

  test('a decide closes a request only when it succeeded (ok, or already decided); a refused one, and the update that renders the refusal, leave it open', () => {
    expect([...DECIDED_RESULT_CLASSES]).toEqual(['ok', 'ErrAlreadyDecided'])
    expect(NOT_A_VERDICT_TAG).toBe('click_handler_relay_fallen_back')
    const trail = [
      decideLine('t-ok', 'ok'),
      decideLine('t-already', 'ErrAlreadyDecided'),
      decideLine('t-fallen-back', 'ErrRelayFallenBack'),
      clickUpdateLine('t-fallen-back', 'click_handler_relay_fallen_back'),
      decideLine('t-invalid', 'ErrInvalidFlags'),
      decideLine('t-ambiguous', 'ErrAmbiguousRequest'),
      decideLine('t-other', 'other', { raw_error_message: 'decide failed' }),
      decideLine('t-outage', 'ErrTmuxNotAvailable', { raw_error_message: 'tmux is not available' }),
      decideLine('t-no-class', undefined),
      decideLine('t-prefix', 'o'),
      clickUpdateLine('t-denied', 'click_handler_deny'),
    ]
    const r = runScript(0, text(trail))
    expect(r.code).toBe(0)
    expect(parsePromptTrail(r.out)).toEqual({ lines: trail.length, posts: [], closed: ['t-ok', 't-already', 't-denied'] })
  })

  test('a refused decide leaves the prompt open: the guard, reading through this script, denies it after the grace; a decided one it leaves alone', async () => {
    const g = guardWith()
    const at = (ago: number) => new Date(g.clock.now() - ago).toISOString()
    const post = (token: string, slackTs: string) => ({
      ts: at(20 * SECOND),
      event: 'cscb.chat_post.attempted',
      claude_instance_id: 'cscb_persona_a',
      request_token: token,
      channel: 'C0DRYAHOME',
      text: '🤖🛠️ permission request: Bash',
      blocks: [{ type: 'section', text: { type: 'mrkdwn', text: section('env') } }, { type: 'actions', elements: [] }],
      ok: true,
      slack_ts: slackTs,
    })
    runScript(0, text([
      post('t-refused', '1790447967.000100'),
      { ...decideLine('t-refused', 'ErrRelayFallenBack'), ts: at(19 * SECOND), decision: 'allow' },
      { ...clickUpdateLine('t-refused', 'click_handler_relay_fallen_back'), ts: at(19 * SECOND) },
      post('t-decided', '1790447967.000200'),
      { ...decideLine('t-decided', 'ok'), ts: at(19 * SECOND), decision: 'allow' },
    ]))
    const guard = new PromptGuard({ ...g.deps, readTrail: async (from) => parsePromptTrail(runScript(from, null).out)! })
    await guard.tick()
    expect(g.clicks).toEqual(['t-refused C0DRYAHOME 1790447967.000100'])
    expect(guard.report()).toMatchObject({ seen: 2, denied: 1, notDenied: 0 })
  })

  test('one cut: an unterminated last line (still being written) is not counted or read', () => {
    const r = runScript(0, text(LINES.slice(0, 2)) + '{"event":"cscb.ad_decide.attempted","request_token":"t1"')
    expect(parsePromptTrail(r.out)).toEqual({ lines: 2, posts: [expect.objectContaining({ request_token: 't1' })], closed: [] })
  })

  test('no trail yet: LINES 0 and nothing else', () => {
    expect(runScript(0, null).out).toEqual(['LINES 0'])
  })

  test('parsePromptTrail needs the line count; the jq programs share promptPosts\'s projection', () => {
    expect(parsePromptTrail([])).toBeNull()
    expect(parsePromptTrail(['{"closed":"t1"}'])).toBeNull()
    expect(parsePromptTrail(['LINES 3', '{"closed":"t1"}', 'garbage', '{"other":1}'])).toEqual({ lines: 3, posts: [], closed: ['t1'] })
    expect(PROMPT_TRAIL_JQ).toContain(`{post: ${PROMPT_POST_JQ}}`)
    expect(promptTrailScript(-5)).toContain('tail -n +1 ')
    expect(promptTrailScript(7)).toContain('tail -n +8 ')
  })
})

// ---------------------------------------------------------------------------
// The real dependencies
// ---------------------------------------------------------------------------

describe('containerPromptGuardDeps: the container, the guard, the click as the checks click', () => {
  function container(answer: (script: string) => Partial<ProcResult>) {
    const scripts: string[] = []
    const c: ContainerExec = {
      name: 'cscb-live-1700000000',
      exec: async () => ({ code: 0, stdout: '', stderr: '', timedOut: false }),
      sh: async (script) => {
        scripts.push(script)
        return { code: 0, stdout: '', stderr: '', timedOut: false, ...answer(script) }
      },
      writeFile: async () => {},
    }
    return { c, scripts }
  }

  const PROMPT: GuardedPrompt = { token: "tok'1", instanceId: 'cscb_persona_a', persona: 'a', command: section('env'), channel: 'C0DRYAHOME', slackTs: '1700000100.000001' }
  const io = { redact: (s: string) => s, log: () => {}, note: () => {} }

  test("the fallback is agent-director decide … --decision deny behind the plan's guard, every value one quoted word, with the reason Claude is shown", async () => {
    expect(denyScript(PROMPT)).toBe(
      `agent-director decide --claude-instance-id 'cscb_persona_a' --decision deny --request-token 'tok'\\''1' --reason '${PROMPT_GUARD_DENY_REASON}'`,
    )
    const ok = container(() => ({}))
    const deps = containerPromptGuardDeps({ container: ok.c, clock: virtualClock(), ids: DRY_RUN_IDS, browser: null, human: null }, io)
    expect(await deps.decide(PROMPT)).toEqual({ ok: true })
    expect(ok.scripts).toEqual([`guard || exit 90\n${denyScript(PROMPT)}`])
    const refused = container(() => ({ code: 90 }))
    expect(await containerPromptGuardDeps({ container: refused.c, clock: virtualClock(), ids: DRY_RUN_IDS, browser: null, human: null }, io).decide(PROMPT)).toEqual({
      ok: false,
      why: 'the guard refused',
    })
    const failed = container(() => ({ code: 1, stdout: '{"err_name":"ErrPermissionRequestNotFound","err_description":"no row tok"}' }))
    expect(await containerPromptGuardDeps({ container: failed.c, clock: virtualClock(), ids: DRY_RUN_IDS, browser: null, human: null }, io).decide(PROMPT)).toEqual({
      ok: false,
      why: 'exit 1, ErrPermissionRequestNotFound',
    })
  })

  test('the trail is read through the container with promptTrailScript', async () => {
    const t = container(() => ({ stdout: 'LINES 4\n{"closed":"t9"}\n' }))
    const deps = containerPromptGuardDeps({ container: t.c, clock: virtualClock(), ids: DRY_RUN_IDS, browser: null, human: null }, io)
    expect(await deps.readTrail(2)).toEqual({ lines: 4, posts: [], closed: ['t9'] })
    expect(t.scripts).toEqual([promptTrailScript(2)])
    const silent = container(() => ({ stdout: '' }))
    await expect(containerPromptGuardDeps({ container: silent.c, clock: virtualClock(), ids: DRY_RUN_IDS, browser: null, human: null }, io).readTrail(0)).rejects.toThrow(
      'the permission trail read printed no line count',
    )
  })

  test('the click is clickPrompt: Deny on the latest copy in the web client, then the message must show "Denied by operator"', async () => {
    const clock = virtualClock()
    const clicked: string[] = []
    let state = 'open'
    const browser: BrowserDriver = {
      ensureSignedIn: async () => 'signed-in',
      submitSignInCode: async () => 'signed-in',
      humanApi: async () => ({ call: async () => ({ ok: true }) }),
      installApp: async () => '',
      generateAppToken: async () => '',
      revokeAppToken: async () => {},
      clickMessageButton: async (team, channel, ts, button) => {
        clicked.push(`${team} ${channel} ${ts} ${button}`)
        state = 'denied'
      },
      saveState: async () => {},
      close: async () => {},
    }
    const api: HumanApi = {
      call: async (method, params = {}) =>
        method === 'conversations.history'
          ? { ok: true, messages: [{ ts: params.oldest, text: state === 'denied' ? '*Permission* — Denied by operator' : 'permission request: Bash Allow Deny' }] }
          : { ok: true },
    }
    const deps = containerPromptGuardDeps({ container: container(() => ({})).c, clock, ids: DRY_RUN_IDS, browser, human: new HumanSession(api, clock) }, io)
    expect(await deps.click(PROMPT)).toEqual({ ok: true })
    expect(clicked).toEqual([`${DRY_RUN_IDS.teamId} C0DRYAHOME 1700000100.000001 Deny`])
    // No copy in Slack: no click. No browser: clickPrompt throws, which the guard takes as a failed click.
    expect(await deps.click({ ...PROMPT, slackTs: null })).toEqual({ ok: false, why: 'no copy of it reached Slack' })
    const none = containerPromptGuardDeps({ container: container(() => ({})).c, clock, ids: DRY_RUN_IDS, browser: null, human: null }, io)
    await expect(none.click(PROMPT)).rejects.toThrow('no browser')
  })

  test('with no browser (the real deps), the guard falls back to agent-director decide', async () => {
    const clock = virtualClock()
    const c = container((script) => (script.includes('LINES') ? { stdout: `LINES 1\n${JSON.stringify({ post: { claude_instance_id: 'cscb_persona_a', channel: 'C0DRYAHOME', ok: true, slack_ts: '1700000100.000001', request_token: 'tok-1', ts: new Date(clock.now() - 60_000).toISOString(), command: section('env') } })}` } : {}))
    const notes: string[] = []
    const guard = new PromptGuard(containerPromptGuardDeps({ container: c.c, clock, ids: DRY_RUN_IDS, browser: null, human: null }, { ...io, note: (n) => notes.push(n) }))
    await guard.tick()
    expect(c.scripts.filter((s) => s.includes('agent-director decide'))).toEqual([`guard || exit 90\n${denyScript({ instanceId: 'cscb_persona_a', token: 'tok-1' })}`])
    expect(notes).toEqual([
      "prompt guard: denied persona_a's unexpected prompt (before the first check): Bash: env; the Deny click failed (Error: no browser (workspace not available)), so denied with agent-director decide",
    ])
  })
})

// ---------------------------------------------------------------------------
// The checks' prompt waits: only the declared command
// ---------------------------------------------------------------------------

describe("the checks' prompt waits pick the declared prompt, not a detour", () => {
  test('waitPromptPost with a command skips the persona\'s other prompts (a detour the guard denies); without one it takes them all', async () => {
    const post = (token: string, command: string) =>
      JSON.stringify({ claude_instance_id: 'cscb_persona_b', channel: 'D0DRYDM001', ok: true, error: null, slack_ts: '1700000100.000001', request_token: token, ts: '2026-09-26T19:00:00.000Z', command: section(command) })
    const c: ContainerExec = {
      name: 'cscb-live-1700000000',
      exec: async () => ({ code: 0, stdout: '', stderr: '', timedOut: false }),
      sh: async (script) => ({ code: 0, stdout: script.includes('cscb.chat_post.attempted') ? `${post('t-ls', 'ls')}\n${post('t-b', 'date > dm-prompt-b.txt')}\n` : '', stderr: '', timedOut: false }),
      writeFile: async () => {},
    }
    const ctx = { container: c, clock: virtualClock() } as never
    expect((await waitPromptPost(ctx, 0, 'b', 5 * SECOND, 1, /dm-prompt-b\.txt/))?.map((p) => p.request_token)).toEqual(['t-b'])
    expect((await waitPromptPost(ctx, 0, 'b', 5 * SECOND))?.map((p) => p.request_token)).toEqual(['t-ls', 't-b'])
    expect(await waitPromptPost(ctx, 0, 'b', 5 * SECOND, 1, /prompt-c\.txt/)).toBeNull()
    expect((await promptPosts(ctx, 0)).length).toBe(2)
  })
})
