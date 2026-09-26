/**
 * ci-live-session.test.ts — Tests for the /ci-live runner's command line
 * (`ci-live/lib/args.ts`), the persona config it writes in the container
 * (`lib/live-config.ts`), its bounded waits (`lib/wait.ts`) and the test
 * human's session (`lib/human-session.ts`) (bug b.1cx).
 *
 * The rules under test:
 * - the command line accepts the documented flags (`--create-apps`,
 *   `login --second` and `mailbox --latest|--forwarding [--show-body]`
 *   included) and refuses anything else (a real `--stage` never combines
 *   with `--dry-run`; `mailbox` takes exactly one view, and each of its
 *   flags at most once); an unknown argument
 *   is named by its position, never echoed, unless it is a plain
 *   `--flag-name`;
 * - the config.json the runner writes for A, B and C (and D's entry for
 *   Check 25) loads through the package's own config loader, and the system
 *   prompt keeps the shipped template up to its Role section;
 * - every wait has a deadline, never sleeps past it and gives its probe that
 *   deadline (so the probe's own calls can keep to it); a failed Slack call
 *   is reported by method and safe code only; a transient Slack failure
 *   inside a wait is "not yet", a refusal ends it;
 * - a wait reads one history page of the watched conversation and only the
 *   threads with a reply newer than its mark.
 *
 * Time is virtual (`virtualClock`); Slack is a scripted `HumanApi` fake.
 *
 * SPDX-License-Identifier: MIT
 */

import { describe, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { parsePersonaConfigBytes } from '../src/config.ts'
import { DRY_RUN_IDS } from '../ci-live/checks/context.ts'
import { parseArgs, USAGE, UsageError, type RunOptions } from '../ci-live/lib/args.ts'
import type { HumanApi } from '../ci-live/lib/browser-types.ts'
import {
  HumanCallError,
  HumanSession,
  isFrom,
  isTransientSlackFailure,
  messageText,
  notYetOnTransient,
  tsAfter,
} from '../ci-live/lib/human-session.ts'
import { buildLiveConfig, personaEntryFor, renderConfig, ROLE_TEXT, systemPromptFromTemplate } from '../ci-live/lib/live-config.ts'
import { SlackTransportError, type SlackParams, type SlackResponse } from '../ci-live/lib/slack-api.ts'
import { waitFor } from '../ci-live/lib/wait.ts'
import { virtualClock } from './test-helpers/ci-live.ts'
import { assertNoLeak, BOT_TOKEN_PREFIX, fakeToken, LEAK_SENTINEL } from './test-helpers/credentials.ts'

// ---------------------------------------------------------------------------
// The command line
// ---------------------------------------------------------------------------

describe('parseArgs', () => {
  const defaults: RunOptions = { command: 'run', dryRun: false, provisionOnly: false, stage: null, only: [], keepContainer: false, clean: false }

  test.each([
    [[], {}],
    [['--dry-run', '--keep-container', '--clean'], { dryRun: true, keepContainer: true, clean: true }],
    [['--stage', 'apps'], { stage: 'apps', provisionOnly: true }],
    [['--provision-only', '--dry-run'], { provisionOnly: true, dryRun: true }],
    [['--only', '1, S2,29a', '--only', 'HOST'], { only: ['1', 'S2', '29a', 'HOST'] }],
    [['--create-apps', '--stage', 'apps'], { createApps: true, stage: 'apps', provisionOnly: true }],
    [['login'], { command: 'login' }],
    [['login', '--second'], { command: 'login', second: true }],
    [['mailbox', '--latest'], { command: 'mailbox', mailboxView: 'latest' }],
    [['mailbox', '--forwarding'], { command: 'mailbox', mailboxView: 'forwarding' }],
    [['mailbox', '--latest', '--show-body'], { command: 'mailbox', mailboxView: 'latest', showBody: true }],
    [['mailbox', '--show-body', '--forwarding'], { command: 'mailbox', mailboxView: 'forwarding', showBody: true }],
    [['config-token', '--rotate'], { command: 'config-token', rotate: true }],
    [['apps', '--list'], { command: 'apps', appsAction: 'list' }],
    [['apps', '--delete-strays'], { command: 'apps', appsAction: 'delete-strays' }],
  ])('%j', (argv, expected) => {
    expect(parseArgs(argv)).toEqual({ ...defaults, ...expected } as RunOptions)
  })

  test('--create-apps, --second, --show-body and the mailbox view are set only when given', () => {
    expect(['createApps' in parseArgs([]), 'second' in parseArgs(['login']), 'showBody' in parseArgs(['mailbox', '--latest']), 'mailboxView' in parseArgs([])]).toEqual([
      false,
      false,
      false,
      false,
    ])
  })

  test('the usage names the maintenance and mailbox commands', () => {
    expect(USAGE.split('\n').slice(-3)).toEqual([
      '       bun ci-live/run.ts config-token --rotate',
      '       bun ci-live/run.ts apps --list|--delete-strays',
      '       bun ci-live/run.ts mailbox --latest|--forwarding [--show-body]',
    ])
  })

  test.each([
    [['--stage'], '--stage needs one of apps, install, tokens, channels'],
    [['--stage', 'validate'], '--stage needs one of apps, install, tokens, channels'],
    [['--stage', 'apps', '--dry-run'], '--stage runs one real provisioning stage; it does not combine with --dry-run'],
    [['--only'], '--only needs a comma-separated list of check ids'],
    [['--only', '1;rm -rf'], '--only needs a comma-separated list of check ids'],
    [['login', '--dry-run'], 'login takes no arguments other than --second'],
    [['login', '--second', '--second'], 'login takes no arguments other than --second'],
    [['--second'], 'unknown argument "--second"'],
    [['mailbox'], 'mailbox needs --latest (the newest message in the test mailbox) or --forwarding (the newest Gmail forwarding confirmation)'],
    [['mailbox', '--show-body'], 'mailbox needs --latest (the newest message in the test mailbox) or --forwarding'],
    [['mailbox', '--latest', '--forwarding'], 'mailbox takes --latest or --forwarding, not both'],
    [['mailbox', '--forwarding', '--show-body', '--latest'], 'mailbox takes --latest or --forwarding, not both'],
    [['mailbox', '--latest', '--dry-run'], 'mailbox takes only --latest or --forwarding, and --show-body (unknown argument "--dry-run")'],
    [['mailbox', '--latest', '--latest'], 'mailbox takes --latest only once'],
    [['mailbox', '--forwarding', '--forwarding'], 'mailbox takes --forwarding only once'],
    [['mailbox', '--latest', '--show-body', '--show-body'], 'mailbox takes --show-body only once'],
    [['mailbox', '--latest', '--forwarding', '--latest'], 'mailbox takes --latest only once'],
    [['--latest'], 'unknown argument "--latest"'],
    [['config-token'], 'config-token takes --rotate (rotate the configuration token pair once) and nothing else'],
    [['config-token', '--rotate', '--dry-run'], 'config-token takes --rotate (rotate the configuration token pair once) and nothing else'],
    [['--rotate'], 'unknown argument "--rotate"'],
    [['apps'], 'apps takes --list (the apps in the test workspace) or --delete-strays (also delete the stray test apps), and nothing else'],
    [['apps', '--list', '--delete-strays'], 'apps takes --list (the apps in the test workspace) or --delete-strays (also delete the stray test apps), and nothing else'],
    [['apps', '--dry-run'], 'apps takes --list (the apps in the test workspace) or --delete-strays (also delete the stray test apps), and nothing else'],
    [['--dry-run', 'apps', '--list'], 'unknown argument #2'],
    [['--dry-run', 'mailbox', '--latest'], 'unknown argument #2'],
  ])('refuses %j', (argv, message) => {
    expect(() => parseArgs(argv)).toThrow(UsageError)
    expect(() => parseArgs(argv)).toThrow(message)
  })

  // The same rule after `mailbox`: its position in the whole argv, never the value.
  test.each([
    ['a pasted mailbox password', () => ['mailbox', `mailpw-${LEAK_SENTINEL}`], '#2'],
    ['a pasted token after the view', () => ['mailbox', '--latest', fakeToken(BOT_TOKEN_PREFIX, 'x')], '#3'],
    ['a view with a joined value', () => ['mailbox', '--show-body', `--latest=${LEAK_SENTINEL}`], '#3'],
  ])('mailbox names an unknown argument (%s) as %s', (_what, argv, ref) => {
    let err: unknown
    try {
      parseArgs(argv())
    } catch (e) {
      err = e
    }
    expect(err).toBeInstanceOf(UsageError)
    expect((err as Error).message).toBe(`mailbox takes only --latest or --forwarding, and --show-body (unknown argument ${ref})`)
    assertNoLeak(err)
  })

  // An unknown argument can be a pasted secret: the error names its position, and repeats it only when it is a plain --flag-name.
  test.each([
    ['a pasted token', () => [fakeToken(BOT_TOKEN_PREFIX, 'x'.repeat(60))], '#1'],
    ['a short password after a flag', () => ['--dry-run', `pw-${LEAK_SENTINEL}`], '#2'],
    ['a flag with a joined value', () => ['--clean', '--only', '1', `--password=${LEAK_SENTINEL}`], '#4'],
    ['--network=host', () => ['--network=host'], '#1'],
    ['a short flag', () => ['-p3100:3100'], '#1'],
    ['a plain unknown --flag-name', () => ['--bogus-flag'], '"--bogus-flag"'],
  ])('an unknown argument (%s) is named %s, never echoed when it could be a value', (_what, argv, ref) => {
    let err: unknown
    try {
      parseArgs(argv())
    } catch (e) {
      err = e
    }
    expect(err).toBeInstanceOf(UsageError)
    expect((err as Error).message).toBe(`unknown argument ${ref}`)
    assertNoLeak(err)
  })
})

// ---------------------------------------------------------------------------
// The persona config the runner writes
// ---------------------------------------------------------------------------

describe('the live config', () => {
  function load(config: unknown) {
    const home = mkdtempSync(join(tmpdir(), 'ci-live-config-'))
    try {
      return parsePersonaConfigBytes(renderConfig(config), join(home, 'config.json'), home, { home })
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  }

  test("A, B and C as Part 1.5's wizard answers would write them, loadable by the package's own loader", () => {
    const config = buildLiveConfig(DRY_RUN_IDS)
    expect(config.personas.map((p) => [p.name, p.channels ?? null, p.dm ?? null, p.permission_prompts])).toEqual([
      ['persona_a', [{ id: 'C0DRYAHOME', delivery: 'all' }, { id: 'C0DRYCOORD', delivery: 'mentions' }], null, 'C0DRYAHOME'],
      ['persona_b', [{ id: 'C0DRYCOORD', delivery: 'mentions' }], { enabled: true, contact: 'U0DRYHUMAN' }, 'dm'],
      ['persona_c', null, { enabled: true, contact: 'U0DRYHUMAN' }, 'dm'],
    ])
    expect([config.ack_reaction, config.append_system_prompt_file]).toEqual(['eyes', '/home/testuser/.claude/channels/slack/system-prompt.md'])
    const loaded = load(config)
    expect(loaded.personas.map((p) => [p.key, p.credentials_file.endsWith(`.config/cscb/${p.name}-credentials.json`)])).toEqual([
      ['persona_a', true],
      ['persona_b', true],
      ['persona_c', true],
    ])
    assertNoLeak(renderConfig(config))
  })

  test("D's entry for Check 25 loads beside them", () => {
    const config = buildLiveConfig(DRY_RUN_IDS)
    const withD = { ...config, personas: [...config.personas, personaEntryFor('d', DRY_RUN_IDS)] }
    expect(load(withD).personas.map((p) => p.key)).toEqual(['persona_a', 'persona_b', 'persona_c', 'persona_d'])
  })

  test('the system prompt keeps the shipped template up to its Role section and replaces the rest', () => {
    const template = readFileSync(join(import.meta.dir, '..', 'skills', 'EXAMPLE_CLAUDE.md'), 'utf-8')
    const prompt = systemPromptFromTemplate(template)
    const at = template.search(/^# Role\s*$/m)
    expect(prompt).toBe(`${template.slice(0, at)}# Role\n${ROLE_TEXT}\n`)
    expect(() => systemPromptFromTemplate('# Communication\ntext\n')).toThrow('has no "# Role" section')
  })
})

// ---------------------------------------------------------------------------
// Bounded waits
// ---------------------------------------------------------------------------

describe('waitFor', () => {
  test('returns the first value that is not null, undefined or false, sleeping the interval between probes', async () => {
    const clock = virtualClock()
    const answers: Array<string | null | undefined | false> = [null, undefined, false, 'found']
    const start = clock.now()
    const value = await waitFor(async () => answers.shift() ?? null, { timeoutMs: 60_000, intervalMs: 5_000, clock })
    expect([value, clock.now() - start]).toEqual(['found', 15_000])
  })

  test('gives null at the deadline, never sleeping past it, after probing at least once', async () => {
    const clock = virtualClock()
    const start = clock.now()
    let probes = 0
    expect(await waitFor(async () => (probes++, null), { timeoutMs: 12_000, intervalMs: 5_000, clock })).toBeNull()
    expect([probes, clock.now() - start]).toEqual([4, 12_000])
    expect(await waitFor(async () => (probes++, null), { timeoutMs: 0, intervalMs: 5_000, clock })).toBeNull()
    expect(probes).toBe(5)
  })

  test('gives the probe the same deadline (its start + timeoutMs) on every call', async () => {
    const clock = virtualClock()
    const start = clock.now()
    const deadlines: number[] = []
    await waitFor(async (deadline) => (deadlines.push(deadline), null), { timeoutMs: 12_000, intervalMs: 5_000, clock })
    expect(deadlines).toEqual([start + 12_000, start + 12_000, start + 12_000, start + 12_000])
  })
})

// ---------------------------------------------------------------------------
// The test human's session
// ---------------------------------------------------------------------------

const BOT = { userId: 'U0DRYBOTA0', botId: 'B0DRYBOTA0' }

/** A scripted session API: `answer` per call; every call is recorded. */
function humanApi(answer: (method: string, params: SlackParams) => SlackResponse) {
  const calls: { method: string; params: SlackParams }[] = []
  const api: HumanApi = {
    call: async (method, params = {}) => {
      calls.push({ method, params })
      return answer(method, params)
    },
  }
  return { api, calls }
}

describe('HumanSession', () => {
  test('pure helpers: timestamps compare numerically, bots match by user or bot ID, block text is read', () => {
    expect([tsAfter('1700000000.000010', '1700000000.000009'), tsAfter('1700000000.000009', '1700000000.000010'), tsAfter('1700000001.000000', '1700000000.999999')]).toEqual([true, false, true])
    expect([isFrom({ ts: '1.1', text: '', user: BOT.userId }, BOT), isFrom({ ts: '1.1', text: '', bot_id: BOT.botId }, BOT), isFrom({ ts: '1.1', text: '', user: 'U0HUMAN000' }, BOT)]).toEqual([true, true, false])
    expect(messageText({ ts: '1.1', text: 'top', blocks: [{ text: { text: 'section' } }, { elements: [{ text: 'Allow' }] }] })).toBe('top\nsection\nAllow')
  })

  test('post returns the message ts; a Slack error is a HumanCallError with the method and a safe code only', async () => {
    const ok = humanApi(() => ({ ok: true, ts: '1700000000.000100' }))
    expect(await new HumanSession(ok.api, virtualClock()).post('C0DRYAHOME', 'hi', '1700000000.000001')).toBe('1700000000.000100')
    expect(ok.calls[0]).toEqual({ method: 'chat.postMessage', params: { channel: 'C0DRYAHOME', text: 'hi', thread_ts: '1700000000.000001' } })

    const token = fakeToken(BOT_TOKEN_PREFIX)
    const errors: unknown[] = []
    for (const answer of [{ ok: false, error: 'not_in_channel' }, { ok: false, error: `bad ${token}` }, { ok: true, ts: 'not-a-ts' }]) {
      await new HumanSession(humanApi(() => answer).api, virtualClock()).post('C0DRYAHOME', 'hi').catch((e) => errors.push(e))
    }
    expect(errors.map((e) => [e instanceof HumanCallError, (e as Error).message])).toEqual([
      [true, 'chat.postMessage failed: not_in_channel'],
      [true, 'chat.postMessage failed: unknown_error'],
      [true, 'chat.postMessage failed: no_ts'],
    ])
    assertNoLeak(errors)
  })

  test('openDm accepts only a D… conversation ID', async () => {
    const good = humanApi(() => ({ ok: true, channel: { id: 'D0DRYDM001' } }))
    expect(await new HumanSession(good.api, virtualClock()).openDm(BOT.userId)).toBe('D0DRYDM001')
    const bad = humanApi(() => ({ ok: true, channel: { id: 'C0DRYAHOME' } }))
    await expect(new HumanSession(bad.api, virtualClock()).openDm(BOT.userId)).rejects.toThrow('conversations.open failed: no_dm_id')
  })

  test('history drops malformed messages and orders the rest oldest first', async () => {
    const h = humanApi(() => ({ ok: true, messages: [{ ts: '1700000000.000003', text: 'c' }, { text: 'no ts' }, { ts: '1700000000.000001', text: 'a' }, null] }))
    const messages = await new HumanSession(h.api, virtualClock()).history('C0DRYAHOME', '1700000000.000000')
    expect(messages.map((m) => m.text)).toEqual(['a', 'c'])
    expect(h.calls[0]!.params).toMatchObject({ channel: 'C0DRYAHOME', oldest: '1700000000.000000', inclusive: false })
  })

  test("waitForBotMessage finds the persona's reply in a thread, and gives null at the deadline in virtual time", async () => {
    const human = '1700000000.000100'
    let polls = 0
    const h = humanApi((method, params) => {
      if (method === 'conversations.replies') {
        return { ok: true, messages: [{ ts: human, text: 'question', reply_count: 1 }, { ts: '1700000000.000200', text: 'the answer is PONG', user: BOT.userId, thread_ts: human }] }
      }
      polls += params.oldest === human ? 1 : 0
      return { ok: true, messages: polls >= 2 ? [{ ts: human, text: 'question', user: 'U0DRYHUMAN', reply_count: 1 }] : [{ ts: human, text: 'question', user: 'U0DRYHUMAN' }] }
    })
    const clock = virtualClock()
    const session = new HumanSession(h.api, clock)
    const start = clock.now()
    const reply = await session.waitForBotMessage('C0DRYAHOME', BOT, human, (text) => text.includes('PONG'), 60_000)
    expect([reply?.ts, clock.now() - start]).toEqual(['1700000000.000200', 5_000])
    const none = await session.waitForBotMessage('C0DRYAHOME', BOT, human, (text) => text.includes('never'), 60_000)
    expect([none, clock.now() - start]).toEqual([null, 65_000])
  })

  describe('everythingAfter reads one history page and only the threads with a new reply', () => {
    const OLDEST = '1700000000.000100'
    // Oldest first: a parent before the window, the check's own post, and later top-level messages.
    const listed = [
      { ts: '1700000000.000050', text: 'older parent, new reply', reply_count: 2, latest_reply: '1700000000.000300' },
      { ts: '1700000000.000060', text: 'older parent, old replies', reply_count: 1, latest_reply: '1700000000.000070' },
      { ts: OLDEST, text: 'the check post', reply_count: 1 },
      { ts: '1700000000.000200', text: 'later, no thread' },
    ]
    const replies: Record<string, SlackResponse['messages']> = {
      '1700000000.000050': [{ ts: '1700000000.000050', text: 'parent' }, { ts: '1700000000.000080', text: 'old reply' }, { ts: '1700000000.000300', text: 'new reply' }],
      [OLDEST]: [{ ts: OLDEST, text: 'parent' }, { ts: '1700000000.000150', text: 'answer' }],
    }
    // As Slack: history lists the messages from `oldest` (inclusive).
    const session = () => {
      const h = humanApi((method, params) =>
        method === 'conversations.history'
          ? { ok: true, messages: listed.filter((m) => !tsAfter(String(params.oldest), m.ts)) }
          : { ok: true, messages: replies[String(params.ts)] ?? [] },
      )
      return { h, s: new HumanSession(h.api, virtualClock()) }
    }

    test('from the check post: later messages and the replies in its own thread', async () => {
      const { h, s } = session()
      const got = await s.everythingAfter('C0DRYCOORD', OLDEST)
      expect(got.map((m) => m.text)).toEqual(['later, no thread', 'answer'])
      expect(h.calls.map((c) => [c.method, c.params.oldest ?? c.params.ts])).toEqual([
        ['conversations.history', OLDEST],
        ['conversations.replies', OLDEST],
      ])
      expect(h.calls[0]!.params).toMatchObject({ channel: 'C0DRYCOORD', inclusive: true })
    })

    test('with parentsSince earlier: an older thread with a reply after the mark counts, one whose latest reply is older is never read', async () => {
      const { h, s } = session()
      const got = await s.everythingAfter('C0DRYCOORD', OLDEST, '1700000000.000050')
      expect(got.map((m) => m.text)).toEqual(['later, no thread', 'new reply', 'answer'])
      expect(h.calls.map((c) => [c.method, c.params.oldest ?? c.params.ts])).toEqual([
        ['conversations.history', '1700000000.000050'],
        ['conversations.replies', '1700000000.000050'],
        ['conversations.replies', OLDEST],
      ])
    })

    test('a parentsSince later than the mark reads from the mark', async () => {
      const { h, s } = session()
      await s.everythingAfter('C0DRYCOORD', OLDEST, '1700000000.000900')
      expect(h.calls[0]!.params.oldest).toBe(OLDEST)
    })
  })

  describe('transient Slack failures inside a wait are "not yet"', () => {
    test.each([
      ['no answer (network)', new SlackTransportError('conversations.history', 'network'), true],
      ['a timeout', new SlackTransportError('conversations.history', 'timeout'), true],
      ['an unparsable body', new SlackTransportError('conversations.history', 'parse'), true],
      ['HTTP 503', new SlackTransportError('conversations.history', 'http', 503), true],
      ['HTTP 429 left after the retries', new SlackTransportError('conversations.history', 'http', 429), true],
      ['HTTP 404', new SlackTransportError('conversations.history', 'http', 404), false],
      ...['internal_error', 'request_timeout', 'fatal_error', 'service_unavailable', 'ratelimited'].map((code) => [code, new HumanCallError('conversations.history', code), true] as const),
      ...['channel_not_found', 'invalid_auth', 'not_in_channel'].map((code) => [code, new HumanCallError('conversations.history', code), false] as const),
      ['any other error', new Error('internal_error'), false],
    ] as const)('isTransientSlackFailure: %s → %p', (_what, err, transient) => {
      expect(isTransientSlackFailure(err)).toBe(transient)
    })

    test('notYetOnTransient gives the value, null on a transient failure, and rethrows anything else', async () => {
      expect(await notYetOnTransient(async () => 'v')).toBe('v')
      expect(await notYetOnTransient(async () => Promise.reject(new HumanCallError('x.y', 'ratelimited')))).toBeNull()
      await expect(notYetOnTransient(async () => Promise.reject(new HumanCallError('x.y', 'invalid_auth')))).rejects.toThrow('x.y failed: invalid_auth')
    })

    test('waitForBotMessage and waitForMessageState poll on through transient failures; a refusal ends the wait', async () => {
      const human = '1700000000.000100'
      const reply = { ts: '1700000000.000200', text: 'PONG', user: BOT.userId }
      let n = 0
      const flaky = humanApi(() => (++n <= 2 ? { ok: false, error: n === 1 ? 'internal_error' : 'ratelimited' } : { ok: true, messages: [reply] }))
      const clock = virtualClock()
      const start = clock.now()
      const found = await new HumanSession(flaky.api, clock).waitForBotMessage('C0DRYAHOME', BOT, human, (t) => t === 'PONG', 60_000)
      expect([found?.ts, clock.now() - start]).toEqual([reply.ts, 10_000])

      n = 0
      const state = await new HumanSession(flaky.api, clock).waitForMessageState('C0DRYAHOME', reply.ts, (t) => t === 'PONG', 60_000)
      expect(state?.ts).toBe(reply.ts)

      const refused = humanApi(() => ({ ok: false, error: 'channel_not_found' }))
      const err = await new HumanSession(refused.api, clock).waitForBotMessage('C0DRYAHOME', BOT, human, () => true, 60_000).catch((e) => e)
      expect([err instanceof HumanCallError, (err as Error).message, refused.calls.length]).toEqual([true, 'conversations.history failed: channel_not_found', 1])
    })
  })
})
