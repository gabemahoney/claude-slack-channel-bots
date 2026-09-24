/**
 * persona-bringup.test.ts — The per-persona start procedure (b.av2 SR-6.1),
 * the per-persona flush of held notices (SR-7.2) and dry run (SR-3.4).
 *
 * Drives `bringUpPersona` and `connectPersona` (src/persona-start.ts) over the
 * real connection manager, built by the shared connection harness
 * (`makeConnectionHarness` with `files: true`: E2's stub client factory, a
 * fake clock, each persona's credentials file and working directory), with a
 * launch recorder as step 4. Covers:
 *
 *   - the SR-6.1 order per persona: credentials check, working-directory
 *     check, Slack validation and connection, then the launch, which runs
 *     only once that persona's connection is up;
 *   - `connectPersona`: steps 1–3 alone, each outcome, and never a launch;
 *   - a failure at steps 1–3 means the persona is not brought up: later steps
 *     do not run, the causes are logged token-safely, no startup error is
 *     recorded, and the other persona still comes up;
 *   - a credentials path that is not a regular file (directory, FIFO,
 *     character device) is refused unread (the E2 carry; `CredentialsFs.fstatFile`);
 *   - dry run: no credentials read, no tokens passed on, no client built,
 *     distinct placeholder identities;
 *   - per-persona flush: validating A posts only A's held notices, through
 *     A's client, once (the E3 Task 2 carry);
 *   - end to end, no agent-director call is made for A across a drop, a
 *     rejected, an abandoned and a refused reopen, with the real event router
 *     and flush listener wired to the manager and the launch going through
 *     the real spawn entry point (the E2 carry).
 *
 * The startup pool (`startupSessionManager`: its bookkeeping, the launch pool
 * and a launch that throws) is pinned in tests/session-manager.test.ts.
 *
 * Isolation (b.av2 SR-13.2): every path lives under a `mkdtempSync` directory
 * removed in afterEach; `SLACK_STATE_DIR` points inside it, and the token
 * environment variables are set to fakes for the whole file.
 *
 * SPDX-License-Identifier: MIT
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

import type { Persona, PersonaConfig } from '../src/config.ts'
import { DEFAULT_WORKING_DIRECTORY_FS, type PersonaBringUpFs } from '../src/persona-bringup.ts'
import type { PersonaConnectionManager } from '../src/persona-connections.ts'
import { DEFAULT_CREDENTIALS_FS } from '../src/persona-credentials.ts'
import { createPersonaEventRouter } from '../src/persona-event-router.ts'
import { renderPersonaRef } from '../src/persona-identity.ts'
import { createPersonaNotifier, formatPersonaNotice, type PersonaNotifier } from '../src/persona-notifier.ts'
import {
  bringUpPersona,
  connectPersona,
  createPersonaClientLookup,
  createPersonaIdentityLookup,
  createPersonaUpFlushListener,
  type PersonaBringUpDeps,
  type PersonaBringUpResult,
  type PersonaBringUpStep,
  type PersonaConnectDeps,
} from '../src/persona-start.ts'
import {
  _resetDialogPollIntervalMs,
  _resetDialogReadyTimeoutMs,
  _resetInFlightLaunches,
  _resetSpawnHomeDir,
  _resetTmuxDialogHelpers,
  _resetTmuxSessionProber,
  _setDialogPollIntervalMs,
  _setDialogReadyTimeoutMs,
  _setSpawnHomeDir,
  _setTmuxCapturePane,
  _setTmuxSendEnter,
  _setTmuxSessionProber,
  setSessionNotifier,
  spawnForPersona,
} from '../src/session-manager.ts'
import { _resetOutageState, initOutageState } from '../src/outage-state.ts'
import { getClient, resetClientForTests, setClientForTests } from '../src/agent-director-client.ts'
import { makeStubClient, type StubClientOptions } from './test-helpers/agent-director-stub.ts'
import {
  APP_TOKEN_PREFIX,
  BOT_TOKEN_PREFIX,
  LEAK_SENTINEL,
  assertNoLeak,
  fakeToken,
  writeCredentialsFile,
} from './test-helpers/credentials.ts'
import type { FakeClock } from './test-helpers/fake-clock.ts'
import { makeConnectionHarness, type ConnectionHarness } from './test-helpers/persona-connection-harness.ts'
import { makeChannelMessage, type StubSlackFactory, type StubSlackOptions } from './test-helpers/slack-stub.ts'

// ---------------------------------------------------------------------------
// Fixture: personas A and B, each with its own directory and credentials file
// ---------------------------------------------------------------------------

/** Names that differ from their keys. */
const A_NAME = 'Alpha Desk'
const B_NAME = 'Beta Ops'

const ENV_KEYS = ['SLACK_STATE_DIR', 'SLACK_BOT_TOKEN', 'SLACK_APP_TOKEN', 'SLACK_DRY_RUN'] as const

let dir: string
let savedEnv: Array<readonly [string, string | undefined]>
/** Set by `makeHarness`: the harness's config and its personas A and B. */
let cfg: PersonaConfig
let a: Persona
let b: Persona
/** Managers built by this test; stopped in afterEach. */
let managers: PersonaConnectionManager[]

beforeEach(() => {
  savedEnv = ENV_KEYS.map((key) => [key, process.env[key]] as const)
  dir = mkdtempSync(join(tmpdir(), 'cscb-bringup-'))
  // Any startup-errors.log write lands in this test's own directory.
  process.env['SLACK_STATE_DIR'] = join(dir, 'state')
  // An accidental environment read would get these, not a real token, and fail the own-file checks.
  process.env['SLACK_BOT_TOKEN'] = fakeToken(BOT_TOKEN_PREFIX, 'env')
  process.env['SLACK_APP_TOKEN'] = fakeToken(APP_TOKEN_PREFIX, 'env')
  delete process.env['SLACK_DRY_RUN']
  managers = []
})

afterEach(async () => {
  await Promise.all(managers.map((m) => m.stopAll()))
  for (const [key, value] of savedEnv) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  rmSync(dir, { recursive: true, force: true })
})

const startupErrorsLog = () => join(dir, 'state', 'startup-errors.log')

// ---------------------------------------------------------------------------
// Harness: the real manager over the stub factory and fake clock
// ---------------------------------------------------------------------------

/** What the launch recorder saw when step 4 ran for a persona. */
interface LaunchRecord {
  key: string
  state: string | undefined
  socketConnected: boolean
  authTests: number
}

interface HarnessOptions {
  dryRun?: boolean
  /** Per-persona stub options (scripts); the leak marker is always on. */
  slack?: Partial<Record<'a' | 'b', StubSlackOptions>>
  /** The launch throws for this key. */
  launchThrowsFor?: string
}

/** Per-run options: `readFile: 'forbid'` makes any credentials read fail the test instead of reading. */
interface RunOptions {
  readFile?: 'real' | 'forbid'
  fs?: Partial<PersonaBringUpFs>
}

interface Harness {
  /** The shared connection harness (A and B with their files, the manager, stubs, fake clock). */
  conn: ConnectionHarness
  manager: PersonaConnectionManager
  clock: FakeClock
  slack: StubSlackFactory
  /** The manager's lines and the start procedure's lines, in order. */
  lines: string[]
  /** Step markers in the order they ran: `credentials:<key>`, `directory:<key>`, `slack:<key>`, `launch:<key>`. */
  order: string[]
  launches: LaunchRecord[]
  /** Credentials file reads, by key. */
  reads: Map<string, number>
  /** The start procedure's dependencies for one persona, without the launch. */
  deps(persona: Persona, opts?: RunOptions): PersonaConnectDeps
  /** Run steps 1–4 for one persona. */
  run(persona: Persona, opts?: RunOptions): Promise<PersonaBringUpResult<string>>
  /** Everything captured, for `assertNoLeak`. */
  captured(extra?: Record<string, unknown>): Record<string, unknown>
}

/**
 * Build A and B on `makeConnectionHarness` (files written, leak marker on)
 * and set `cfg`, `a` and `b`. Tests arrange file-system failures after this.
 */
function makeHarness(opts: HarnessOptions = {}): Harness {
  const dryRun = opts.dryRun ?? false
  const conn = makeConnectionHarness([{ name: A_NAME }, { name: B_NAME }], dir, {
    dryRun,
    files: true,
    stubOptions: { [A_NAME]: opts.slack?.a ?? {}, [B_NAME]: opts.slack?.b ?? {} },
  })
  cfg = conn.config!
  ;[a, b] = conn.personas
  const { manager, lines, order } = conn
  managers.push(manager)
  const launches: LaunchRecord[] = []
  const reads = new Map<string, number>()

  async function launch(persona: Persona): Promise<string> {
    order.push(`launch:${persona.key}`)
    const stub = dryRun ? undefined : conn.stub(persona)
    launches.push({
      key: persona.key,
      state: manager.status(persona.key)?.state,
      socketConnected: stub?.sockets.some((s) => s.connected) ?? false,
      authTests: stub?.calls.authTest.length ?? 0,
    })
    if (opts.launchThrowsFor === persona.key) throw new Error(`launch failed for ${persona.key}`)
    return `launched:${persona.key}`
  }

  function deps(persona: Persona, runOpts: RunOptions = {}): PersonaConnectDeps {
    const key = persona.key
    const override = runOpts.fs ?? {}
    const fs: Partial<PersonaBringUpFs> = {
      ...override,
      openFile: (path) => {
        order.push(`credentials:${key}`)
        return (override.openFile ?? DEFAULT_CREDENTIALS_FS.openFile)(path)
      },
      readFileFd: (fd) => {
        reads.set(key, (reads.get(key) ?? 0) + 1)
        if (runOpts.readFile === 'forbid') throw new Error('the credentials file must not be read')
        return (override.readFileFd ?? DEFAULT_CREDENTIALS_FS.readFileFd)(fd)
      },
      stat: (path) => {
        order.push(`directory:${key}`)
        return (override.stat ?? DEFAULT_WORKING_DIRECTORY_FS.stat)(path)
      },
    }
    return { applied: cfg.personas, dryRun, log: (line) => void lines.push(line), connections: conn.connections, fs }
  }

  return {
    conn,
    manager,
    clock: conn.clock,
    slack: conn.slack,
    lines,
    order,
    launches,
    reads,
    deps,
    run: (persona, runOpts) => bringUpPersona(persona, { ...deps(persona, runOpts), launch }),
    captured: (extra = {}) => ({ lines, order, launches, bringUpCalls: conn.bringUpCalls, ...extra }),
  }
}

/** Bring A then B up, in that order (the start pool at concurrency 1). */
async function runBoth(h: Harness): Promise<Map<string, PersonaBringUpResult<string>>> {
  const results = new Map<string, PersonaBringUpResult<string>>()
  for (const persona of [a, b]) results.set(persona.key, await h.run(persona))
  return results
}

/** The four step markers of a persona brought up and launched. */
const fullOrder = (key: string) => [`credentials:${key}`, `directory:${key}`, `slack:${key}`, `launch:${key}`]

/** B went through every step, was launched once after its connection was up, and its connection is up. */
function expectBLaunched(h: Harness, results: Map<string, PersonaBringUpResult<string>>): void {
  expect(results.get(b.key)).toEqual({ outcome: 'launched', launch: `launched:${b.key}` })
  expect(h.order.filter((m) => m.endsWith(`:${b.key}`))).toEqual(fullOrder(b.key))
  expect(h.launches.filter((l) => l.key === b.key)).toEqual([{ key: b.key, state: 'up', socketConnected: true, authTests: 1 }])
}

/** A was not brought up: no Slack step, no launch, no client built, and no startup error recorded. */
function expectANotBroughtUp(h: Harness): void {
  expect(h.order).not.toContain(`launch:${a.key}`)
  expect(h.launches.map((l) => l.key)).not.toContain(a.key)
  expect(existsSync(startupErrorsLog())).toBe(false)
}

// ---------------------------------------------------------------------------
// SR-6.1: the order of the steps
// ---------------------------------------------------------------------------

describe('bringUpPersona: SR-6.1 order', () => {
  test('each persona passes its credentials, directory and Slack steps, then is launched once, only after its connection is up', async () => {
    const h = makeHarness()

    const results = await runBoth(h)

    expect(h.order).toEqual([...fullOrder(a.key), ...fullOrder(b.key)])
    expect(results.get(a.key)).toEqual({ outcome: 'launched', launch: `launched:${a.key}` })
    expect(results.get(b.key)).toEqual({ outcome: 'launched', launch: `launched:${b.key}` })
    // At launch the persona's auth.test had run and its socket was open, its status up.
    expect(h.launches).toEqual([
      { key: a.key, state: 'up', socketConnected: true, authTests: 1 },
      { key: b.key, state: 'up', socketConnected: true, authTests: 1 },
    ])
    // The manager got each persona's tokens from its own file; the clients were built with them.
    expect(h.conn.bringUpCalls).toEqual([
      { key: a.key, gotTokens: true, ownTokens: true },
      { key: b.key, gotTokens: true, ownTokens: true },
    ])
    for (const persona of [a, b]) {
      const own = h.conn.tokens(persona)
      const [validation] = h.slack.buildsOf(persona.key, 'validation')
      const [socket] = h.slack.buildsOf(persona.key, 'socket')
      expect(validation.hasToken(own.botToken)).toBe(true)
      expect(validation.hasToken(process.env['SLACK_BOT_TOKEN']!)).toBe(false)
      expect(socket.hasToken(own.appToken)).toBe(true)
    }
    expect(h.reads.get(a.key)).toBe(1)
    assertNoLeak(h.captured({ results: [...results.values()] }))
  })
})

// ---------------------------------------------------------------------------
// connectPersona: steps 1–3 alone (the startup pool runs them for every
// persona at once and pools only the launches)
// ---------------------------------------------------------------------------

describe('connectPersona: steps 1–3 only, never a launch', () => {
  /** A's deps as `bringUpPersona` takes them, with a launch that must never run. */
  function depsWithLaunch(h: Harness, launched: string[], overrides: Partial<PersonaConnectDeps> = {}): PersonaBringUpDeps<string> {
    return { ...h.deps(a), ...overrides, launch: async (p) => (launched.push(p.key), 'launched') }
  }

  test.each<[string, (h: Harness) => void, StubSlackOptions, string[], Array<{ step: PersonaBringUpStep; class: string }> | undefined]>([
    ['every step passes: connected', () => {}, {}, ['credentials', 'directory', 'slack'], undefined],
    ['credentials file missing', () => rmSync(a.credentials_file), {}, ['credentials', 'directory'],
      [{ step: 'credentials', class: 'persona-credentials-missing' }]],
    ['working directory missing', () => rmSync(a.working_directory, { recursive: true }), {}, ['credentials', 'directory'],
      [{ step: 'working-directory', class: 'persona-directory-missing' }]],
    ['Slack refuses the bot token', () => {}, { authTest: [{ kind: 'platform', error: 'invalid_auth' }] }, ['credentials', 'directory', 'slack'],
      [{ step: 'slack', class: 'persona-credentials-refused' }]],
    ['Slack is unreachable (retrying its bring-up)', () => {}, { authTest: [{ kind: 'network' }] }, ['credentials', 'directory', 'slack'],
      [{ step: 'slack', class: 'persona-slack-unreachable' }]],
  ])('%s', async (_label, arrange, slackA, steps, failures) => {
    const h = makeHarness({ slack: { a: slackA } })
    arrange(h)
    const launched: string[] = []

    const result = await connectPersona(a, depsWithLaunch(h, launched))

    if (failures === undefined) {
      expect(result).toEqual({ outcome: 'connected' })
      expect(h.manager.status(a.key)?.state).toBe('up')
    } else {
      expect(result.outcome).toBe('not-brought-up')
      if (result.outcome !== 'not-brought-up') return
      expect(result.failures.map(({ step, class: cls }) => ({ step, class: cls }))).toEqual(failures)
    }
    expect(h.order).toEqual(steps.map((step) => `${step}:${a.key}`))
    expect(launched).toEqual([])
    expect(h.launches).toEqual([])
    assertNoLeak(h.captured({ result }))
  })

  test('a Slack bring-up that throws: not brought up with class error, one token-free line naming A, no launch', async () => {
    const h = makeHarness()
    const launched: string[] = []
    const connections = { bringUp: async () => { throw new Error(`manager exploded ${LEAK_SENTINEL}`) } }

    const result = await connectPersona(a, depsWithLaunch(h, launched, { connections }))

    expect(result).toEqual({
      outcome: 'not-brought-up',
      failures: [{ step: 'slack', class: 'error', cause: expect.stringMatching(/^Slack bring-up threw: /) }],
    })
    expect(h.lines).toEqual([expect.stringContaining(`[slack] persona ${renderPersonaRef(a.name, a.key)} not brought up: Slack bring-up threw: `)])
    expect(launched).toEqual([])
    assertNoLeak(h.captured({ result }))
  })

  test('dry run: no credentials read and no tokens handed on; connected', async () => {
    const h = makeHarness({ dryRun: true })
    rmSync(a.credentials_file)

    const result = await connectPersona(a, h.deps(a, { readFile: 'forbid' }))

    expect(result).toEqual({ outcome: 'connected' })
    expect(h.order).toEqual([`directory:${a.key}`, `slack:${a.key}`])
    expect(h.conn.bringUpCalls).toEqual([{ key: a.key, gotTokens: false, ownTokens: false }])
    assertNoLeak(h.captured({ result }))
  })
})

// ---------------------------------------------------------------------------
// Steps 1–2 failures: not brought up, later steps skipped
// ---------------------------------------------------------------------------

describe('bringUpPersona: local failures (steps 1 and 2)', () => {
  const credentialsFile = () => a.credentials_file
  const workDir = () => a.working_directory

  test.each<[string, () => void, Array<{ step: PersonaBringUpStep; class: string }>]>([
    [
      'credentials file and working directory both missing: both causes logged',
      () => {
        rmSync(credentialsFile())
        rmSync(workDir(), { recursive: true })
      },
      [
        { step: 'credentials', class: 'persona-credentials-missing' },
        { step: 'working-directory', class: 'persona-directory-missing' },
      ],
    ],
    [
      'credentials file missing only',
      () => rmSync(credentialsFile()),
      [{ step: 'credentials', class: 'persona-credentials-missing' }],
    ],
    [
      'credentials file invalid (non-JSON holding the sentinel)',
      () => writeCredentialsFile(dirname(credentialsFile()), 'credentials.json', `{${LEAK_SENTINEL}`),
      [{ step: 'credentials', class: 'persona-credentials-invalid' }],
    ],
    [
      'working directory unusable only (a file, not a directory)',
      () => {
        rmSync(workDir(), { recursive: true })
        writeFileSync(workDir(), '', 'utf-8')
      },
      [{ step: 'working-directory', class: 'persona-directory-unusable' }],
    ],
  ])('%s: A is not brought up, no Slack client is built for it, and B comes up', async (_label, arrange, expected) => {
    const h = makeHarness()
    arrange()

    const results = await runBoth(h)

    const result = results.get(a.key)!
    expect(result.outcome).toBe('not-brought-up')
    if (result.outcome !== 'not-brought-up') return
    expect(result.failures.map(({ step, class: cls }) => ({ step, class: cls }))).toEqual(expected)
    // Both checks ran before either stopped the bring-up; nothing after them did.
    expect(h.order.filter((m) => m.endsWith(`:${a.key}`))).toEqual([`credentials:${a.key}`, `directory:${a.key}`])
    expect(h.slack.buildsOf(a.key)).toEqual([])
    expectANotBroughtUp(h)
    // One log line per cause, naming A in rendered form.
    const ref = renderPersonaRef(a.name, a.key)
    for (const { class: cls } of expected) {
      expect(h.lines.filter((l) => l.includes(cls) && l.includes(ref))).toHaveLength(1)
    }
    expectBLaunched(h, results)
    assertNoLeak(h.captured({ results: [...results.values()] }))
  })
})

// ---------------------------------------------------------------------------
// Non-regular credentials files: refused before any read (E2 carry)
// ---------------------------------------------------------------------------

describe('bringUpPersona: a credentials path that is not a regular file is refused unread', () => {
  /** Arrange A's credentials path, run A (reads forbidden) then B, and check A was refused as unreadable without a read. */
  async function expectRefusedUnread(arrange: () => Partial<PersonaBringUpFs> | undefined): Promise<void> {
    const h = makeHarness()
    const fs = arrange()
    const resultA = await h.run(a, { readFile: 'forbid', fs })
    const resultB = await h.run(b)

    expect(resultA.outcome).toBe('not-brought-up')
    if (resultA.outcome !== 'not-brought-up') return
    expect(resultA.failures.map(({ step, class: cls }) => ({ step, class: cls }))).toEqual([
      { step: 'credentials', class: 'persona-credentials-unreadable' },
    ])
    expect(h.reads.get(a.key) ?? 0).toBe(0)
    expect(h.slack.buildsOf(a.key)).toEqual([])
    expectANotBroughtUp(h)
    expectBLaunched(h, new Map([[b.key, resultB]]))
    assertNoLeak(h.captured({ resultA, resultB }))
  }

  test.each<[string, () => Partial<PersonaBringUpFs> | undefined]>([
    ['a directory', () => {
      rmSync(a.credentials_file)
      mkdirSync(a.credentials_file)
      return undefined
    }],
    ['a character device (a symlink to /dev/zero)', () => {
      rmSync(a.credentials_file)
      symlinkSync('/dev/zero', a.credentials_file)
      return undefined
    }],
    ['a FIFO, as the injected fstatFile reports it', () => ({
      fstatFile: () => ({ isFile: () => false, isDirectory: () => false }),
    })],
  ])('%s', async (_label, arrange) => {
    await expectRefusedUnread(arrange)
  })

  const hasMkfifo = spawnSync('mkfifo', ['--version']).status === 0
  test.skipIf(!hasMkfifo)('a real FIFO (skipped where mkfifo is unavailable)', async () => {
    await expectRefusedUnread(() => {
      rmSync(a.credentials_file)
      expect(spawnSync('mkfifo', [a.credentials_file]).status).toBe(0)
      return undefined
    })
  })
})

// ---------------------------------------------------------------------------
// Step 3 failures: Slack refuses or cannot be reached
// ---------------------------------------------------------------------------

describe('bringUpPersona: Slack failures (step 3)', () => {
  test.each<[string, StubSlackOptions, string, number]>([
    ['Slack refuses A\'s bot token', { authTest: [{ kind: 'platform', error: 'invalid_auth' }] }, 'persona-credentials-refused', 0],
    ['Slack is unreachable for A\'s auth.test', { authTest: [{ kind: 'network' }] }, 'persona-slack-unreachable', 0],
    ['Slack refuses A\'s app token at the socket open', { connect: [{ kind: 'platform', error: 'invalid_auth' }] }, 'persona-credentials-refused', 1],
    ['A\'s socket open cannot reach Slack', { connect: [{ kind: 'network' }] }, 'persona-slack-unreachable', 1],
  ])('%s: A is not launched in this pass, one line names A, and B is unaffected', async (_label, script, cls, sockets) => {
    const h = makeHarness({ slack: { a: script } })

    const results = await runBoth(h)

    const result = results.get(a.key)!
    expect(result.outcome).toBe('not-brought-up')
    if (result.outcome !== 'not-brought-up') return
    expect(result.failures.map(({ step, class: c }) => ({ step, class: c }))).toEqual([{ step: 'slack', class: cls }])
    expect(h.order.filter((m) => m.endsWith(`:${a.key}`))).toEqual([`credentials:${a.key}`, `directory:${a.key}`, `slack:${a.key}`])
    expect(h.slack.buildsOf(a.key, 'socket')).toHaveLength(sockets)
    expectANotBroughtUp(h)
    const ref = renderPersonaRef(a.name, a.key)
    const aLines = h.lines.filter((l) => l.includes(ref))
    expect(aLines).toHaveLength(1)
    expect(aLines[0]).toContain(cls)
    expectBLaunched(h, results)
    assertNoLeak(h.captured({ results: [...results.values()] }))
  })
})

// ---------------------------------------------------------------------------
// Dry run (b.av2 SR-3.4)
// ---------------------------------------------------------------------------

describe('bringUpPersona: dry run (SR-3.4)', () => {
  test('no credentials file is read, no tokens are passed on, no client is built; both launch with distinct placeholder identities', async () => {
    const h = makeHarness({ dryRun: true })
    rmSync(a.credentials_file)
    rmSync(b.credentials_file)

    const resultA = await h.run(a, { readFile: 'forbid' })
    const resultB = await h.run(b, { readFile: 'forbid' })

    expect(resultA).toEqual({ outcome: 'launched', launch: `launched:${a.key}` })
    expect(resultB).toEqual({ outcome: 'launched', launch: `launched:${b.key}` })
    // Step 1 is skipped entirely: no open, no read of the credentials path.
    expect(h.order).toEqual([
      `directory:${a.key}`, `slack:${a.key}`, `launch:${a.key}`,
      `directory:${b.key}`, `slack:${b.key}`, `launch:${b.key}`,
    ])
    expect(h.reads.size).toBe(0)
    expect(h.conn.bringUpCalls.map((c) => c.gotTokens)).toEqual([false, false])
    expect(h.slack.builds).toEqual([])
    const identityFor = createPersonaIdentityLookup(h.manager, () => cfg)
    const clientFor = createPersonaClientLookup(h.manager, () => cfg)
    const idA = identityFor(a.key)
    const idB = identityFor(b.key)
    expect(idA).toEqual({ botUserId: `U000DRY_${a.key}`, botId: `B000DRY_${a.key}` })
    expect(idB).toEqual({ botUserId: `U000DRY_${b.key}`, botId: `B000DRY_${b.key}` })
    expect(idA!.botUserId).not.toBe(idB!.botUserId)
    expect(clientFor(a.key)).toBeUndefined()
    assertNoLeak(h.captured({ resultA, resultB }))
  })

  test('the working-directory check still runs: a persona whose directory is missing is not brought up', async () => {
    const h = makeHarness({ dryRun: true })
    rmSync(a.working_directory, { recursive: true })

    const resultA = await h.run(a, { readFile: 'forbid' })
    const resultB = await h.run(b, { readFile: 'forbid' })

    expect(resultA).toMatchObject({ outcome: 'not-brought-up', failures: [{ step: 'working-directory', class: 'persona-directory-missing' }] })
    expect(h.order).not.toContain(`slack:${a.key}`)
    expect(resultB.outcome).toBe('launched')
    expect(h.launches.map((l) => l.key)).toEqual([b.key])
    assertNoLeak(h.captured({ resultA, resultB }))
  })
})

// ---------------------------------------------------------------------------
// Per-persona flush of held notices (b.av2 SR-7.2; E3 Task 2 carry)
// ---------------------------------------------------------------------------

describe('held notices flush per persona when its client is validated (SR-7.2)', () => {
  test('validating A posts only A\'s held notices, in order, once, through A\'s client; B\'s stay held until B is up', async () => {
    let notifier!: PersonaNotifier
    const notifierLines: string[] = []
    // B's first auth.test cannot reach Slack; its retry 5 s later succeeds.
    const h = makeHarness({ slack: { b: { authTest: [{ kind: 'network' }] } } })
    h.conn.onStatus = (key, status) => createPersonaUpFlushListener(notifier)(key, status)
    notifier = createPersonaNotifier({
      getPersona: (key) => cfg.personas.find((p) => p.key === key),
      clientFor: createPersonaClientLookup(h.manager, () => cfg),
      isDryRun: () => false,
      log: (line) => void notifierLines.push(line),
    })
    const postsOf = (key: string) => h.slack.persona(key).calls.postMessage
    const noticeTo = (persona: Persona, text: string) => ({ channel: persona.permission_prompts, text: formatPersonaNotice(persona, text) })

    // Raised before any bring-up: every notice is held.
    await notifier.notify(a.key, 'first notice for A')
    await notifier.notify(b.key, 'only notice for B')
    await notifier.notify(a.key, 'second notice for A')
    expect(postsOf(a.key)).toEqual([])

    const results = await runBoth(h)
    await h.clock.flush()

    expect(results.get(a.key)!.outcome).toBe('launched')
    expect(results.get(b.key)!.outcome).toBe('not-brought-up')
    expect(postsOf(a.key)).toEqual([noticeTo(a, 'first notice for A'), noticeTo(a, 'second notice for A')])
    expect(postsOf(b.key)).toEqual([])

    // A second transition of A to up (a drop and reopen) posts nothing again.
    h.slack.persona(a.key).socket.drop()
    await h.clock.flush()
    expect(h.manager.status(a.key)?.state).toBe('up')
    expect(postsOf(a.key)).toHaveLength(2)

    // B's held notice was kept, and posts through B's client once B is up.
    await h.clock.advance(5_000)
    expect(h.manager.status(b.key)?.state).toBe('up')
    expect(postsOf(b.key)).toEqual([noticeTo(b, 'only notice for B')])
    expect(postsOf(a.key)).toHaveLength(2)
    assertNoLeak(h.captured({ notifierLines, posts: [postsOf(a.key), postsOf(b.key)] }))
  })
})

// ---------------------------------------------------------------------------
// End to end: no agent-director call for A across its connection trouble (E2 carry)
// ---------------------------------------------------------------------------

describe('end to end: A\'s connection trouble makes no agent-director call', () => {
  const originalError = console.error
  let consoleLines: string[]

  beforeEach(() => {
    consoleLines = []
    console.error = (...args: unknown[]) => void consoleLines.push(args.map(String).join(' '))
    _setDialogPollIntervalMs(1)
    _setDialogReadyTimeoutMs(200)
    _setTmuxCapturePane(async () => '')
    _setTmuxSendEnter(async () => {})
    _setTmuxSessionProber(async () => true)
    const home = join(dir, 'home')
    mkdirSync(join(home, '.claude'), { recursive: true })
    _setSpawnHomeDir(home)
  })

  afterEach(() => {
    console.error = originalError
    resetClientForTests()
    setSessionNotifier(undefined)
    _resetOutageState()
    _resetDialogPollIntervalMs()
    _resetDialogReadyTimeoutMs()
    _resetTmuxDialogHelpers()
    _resetTmuxSessionProber()
    _resetSpawnHomeDir()
    _resetInFlightLaunches()
  })

  test('after A is up and launched: a drop, a rejected reopen, an abandoned reopen and a refused reopen make zero agent-director calls; B keeps delivering', async () => {
    // agent-director: the stub client, every call recorded.
    const spawnCalls: import('agent-director').SpawnParams[] = []
    const calls = {
      versionCalls: [], makeTemplateCalls: [], spawnCalls, statusCalls: [], getCalls: [], sendKeysCalls: [],
      readPaneCalls: [], killCalls: [], decideCalls: [], resumeCalls: [], findMissingCalls: [], deleteCalls: [],
      listCalls: [], pauseCalls: [], getPermissionCalls: [], callLog: [],
    } satisfies StubClientOptions
    const adCallCount = () => Object.values(calls).reduce((sum, list: unknown[]) => sum + list.length, 0)
    setClientForTests(makeStubClient(calls) as unknown as Parameters<typeof setClientForTests>[0])

    // The server's wiring: the real event router and the real up→flush listener on the manager.
    const received: Array<{ key: string; text: unknown }> = []
    let notifier!: PersonaNotifier
    let clientFor!: ReturnType<typeof createPersonaClientLookup>
    const h = makeHarness()
    h.conn.onEvent = createPersonaEventRouter({
      routing: {
        receive: async (event, ack, receiver) => {
          await ack()
          received.push({ key: receiver as string, text: (event as { text?: unknown } | undefined)?.text })
        },
      },
      clientFor: (k) => clientFor(k),
      getPersona: (k) => cfg.personas.find((p) => p.key === k),
      log: (line) => void consoleLines.push(line),
    })
    h.conn.onStatus = (key, status) => createPersonaUpFlushListener(notifier)(key, status)
    clientFor = createPersonaClientLookup(h.manager, () => cfg)
    notifier = createPersonaNotifier({
      getPersona: (key) => cfg.personas.find((p) => p.key === key),
      clientFor,
      isDryRun: () => false,
      log: (line) => void consoleLines.push(line),
    })
    initOutageState({ getClient, notify: (key, text) => void notifier.notify(key, text) })
    setSessionNotifier(notifier.notify)

    // Both personas brought up, then launched through the real spawn entry point.
    const results: unknown[] = []
    for (const persona of [a, b]) {
      results.push(await bringUpPersona(persona, {
        applied: cfg.personas,
        dryRun: false,
        log: (line) => void consoleLines.push(line),
        connections: h.manager,
        launch: (p) => spawnForPersona(p, cfg),
      }))
    }
    expect(results).toEqual([
      { outcome: 'launched', launch: { key: a.key, action: 'spawned' } },
      { outcome: 'launched', launch: { key: b.key, action: 'spawned' } },
    ])
    expect(spawnCalls.map((p) => p.claude_instance_id)).toEqual([`cscb_${a.key}`, `cscb_${b.key}`])
    const afterLaunch = adCallCount()

    const stubA = h.slack.persona(a.key)
    stubA.script.connect.push({ kind: 'network' }, { kind: 'never' }, { kind: 'platform', error: 'invalid_auth' })
    stubA.socket.drop()
    // Rejected at 0 s; the retry at 5 s hangs and is abandoned at 15 s; the retry at 25 s is refused.
    await h.clock.advance(25_000)

    expect(h.manager.status(a.key)).toMatchObject({ state: 'broken', phase: 'reopen' })
    expect(adCallCount()).toBe(afterLaunch)
    // B keeps delivering, tagged with B, through the real router.
    await h.slack.persona(b.key).socket.deliver(makeChannelMessage({ text: 'still here' }))
    expect(received).toEqual([{ key: b.key, text: 'still here' }])
    expect(adCallCount()).toBe(afterLaunch)
    assertNoLeak(h.captured({ consoleLines, results }))
  })
})
