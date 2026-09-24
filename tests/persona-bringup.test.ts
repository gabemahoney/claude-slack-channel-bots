/**
 * persona-bringup.test.ts — The per-persona start procedure (b.av2 SR-6.1) as
 * the server runs it, and the per-persona flush of held notices (SR-7.2).
 *
 * Drives the real bring-up controller (`createPersonaBringUpController`, which
 * runs `persona-start.ts`'s steps 1–3) over the real connection manager, built
 * by the shared connection harness (`makeConnectionHarness` with `files: true`:
 * the stub client factory, a fake clock, each persona's credentials file and
 * working directory). Step 4 is the start pass (`startupSessionManager` with
 * the controller as `bringUp`) launching through the real `spawnForPersona`
 * over an agent-director stub client, and the controller's own launch after a
 * retry goes the same way, as server.ts wires it. Covers:
 *
 *   - the SR-6.1 order per persona: credentials check, working-directory
 *     check, Slack validation and connection, then the launch, which runs
 *     only once that persona's connection is up, with the tokens from its own
 *     file;
 *   - a Slack step that throws: broken with class `error`, one token-free
 *     line, not retried, no launch;
 *   - a credentials path that is not a regular file (directory, FIFO,
 *     character device) is refused unread through the bring-up (the E2 carry;
 *     `CredentialsFs.fstatFile`);
 *   - per-persona flush: A reaching up posts only A's held notices, through
 *     A's client, once; B's are posted when B's retry brings it up (the E3
 *     Task 2 carry);
 *   - end to end, no agent-director call is made for A across a drop, a
 *     rejected, an abandoned and a refused reopen, with the real event router,
 *     flush listener and bring-up controller wired to the manager (the E2
 *     carry).
 *
 * Each bring-up outcome by cause (credentials missing, unreadable, invalid or
 * refused; directory missing or unusable; Slack unreachable), both causes at
 * once, and dry run are pinned in tests/persona-connections.test.ts
 * (`bring-up outcomes (E5)`); the start pool's bookkeeping in
 * tests/session-manager.test.ts.
 *
 * Isolation (b.av2 SR-13.2): every path lives under a `mkdtempSync` directory
 * removed in afterEach; `SLACK_STATE_DIR` points inside it, the spawn home is
 * a temp directory, and the token environment variables are set to fakes for
 * the whole file.
 *
 * SPDX-License-Identifier: MIT
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { Persona, PersonaConfig } from '../src/config.ts'
import { getClient } from '../src/agent-director-client.ts'
import { _resetOutageState, initOutageState } from '../src/outage-state.ts'
import { DEFAULT_WORKING_DIRECTORY_FS, type PersonaBringUpFs } from '../src/persona-bringup.ts'
import { createPersonaBringUpController, type PersonaBringUpController } from '../src/persona-bringup-controller.ts'
import type { PersonaConnectionManager } from '../src/persona-connections.ts'
import { DEFAULT_CREDENTIALS_FS } from '../src/persona-credentials.ts'
import { createPersonaEventRouter } from '../src/persona-event-router.ts'
import { renderPersonaRef } from '../src/persona-identity.ts'
import { createPersonaNotifier, formatPersonaNotice, type PersonaNotifier } from '../src/persona-notifier.ts'
import {
  composePersonaStatusListeners,
  createPersonaClientLookup,
  createPersonaUpFlushListener,
} from '../src/persona-start.ts'
import {
  setSessionNotifier,
  spawnForPersona,
  startupSessionManager,
  type StartupSessionManagerResult,
} from '../src/session-manager.ts'
import { installStubSpawnPath, resetStubSpawnPath, type StubSpawnPath } from './test-helpers/agent-director-stub.ts'
import { APP_TOKEN_PREFIX, BOT_TOKEN_PREFIX, LEAK_SENTINEL, assertNoLeak, fakeToken } from './test-helpers/credentials.ts'
import { makeConnectionHarness, type ConnectionHarness } from './test-helpers/persona-connection-harness.ts'
import { makeChannelMessage, type StubSlackOptions } from './test-helpers/slack-stub.ts'

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
/** Built by this test; cancelled and stopped in afterEach. */
let managers: PersonaConnectionManager[]
let controllers: PersonaBringUpController[]
/** Launches the controllers started after a retry; awaited in afterEach, before the stub client is removed. */
let retryLaunchesInFlight: Promise<unknown>[]
/** The launch path's agent-director stub and every call it received. */
let ad: StubSpawnPath
/** Everything written to console.error (the start pass's and spawn's lines). */
let consoleLines: string[]
const originalError = console.error

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
  controllers = []
  retryLaunchesInFlight = []
  consoleLines = []
  console.error = (...args: unknown[]) => void consoleLines.push(args.map(String).join(' '))

  // The launch (step 4) goes through the real spawnForPersona over a stub client.
  ad = installStubSpawnPath(join(dir, 'home'))
  setSessionNotifier(() => {})
  initOutageState({ getClient, notify: () => {} })
})

afterEach(async () => {
  for (const c of controllers) c.cancelAll()
  await Promise.allSettled(retryLaunchesInFlight)
  await Promise.all(managers.map((m) => m.stopAll()))
  console.error = originalError
  resetStubSpawnPath()
  setSessionNotifier(undefined)
  _resetOutageState()
  for (const [key, value] of savedEnv) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  rmSync(dir, { recursive: true, force: true })
})

const startupErrorsLog = () => join(dir, 'state', 'startup-errors.log')

// ---------------------------------------------------------------------------
// Harness: the controller over the real manager, stub factory and fake clock
// ---------------------------------------------------------------------------

/** What the spawn recorder saw when step 4 reached agent-director for a persona. */
interface LaunchRecord {
  key: string
  state: string | undefined
  socketConnected: boolean
  authTests: number
}

interface HarnessOptions {
  /** Per-persona stub options (scripts); the leak marker is always on. */
  slack?: Partial<Record<'a' | 'b', StubSlackOptions>>
  /** Replaces the controller's step 3 (the harness's recording `bringUp` by default). */
  bringUp?: PersonaConnectionManager['bringUp']
}

interface Harness {
  /** The shared connection harness (A and B with their files, the manager, stubs, fake clock). */
  conn: ConnectionHarness
  controller: PersonaBringUpController
  /** The manager's and the controller's lines, in order. */
  lines: string[]
  /** Step markers in the order they ran: `credentials:<key>`, `directory:<key>`, `slack:<key>`, `launch:<key>`. */
  order: string[]
  /** One record per spawn, in call order. */
  launches: LaunchRecord[]
  /** Keys the controller launched after a retry. */
  retryLaunches: string[]
  /** Credentials file reads, by key. */
  reads: Map<string, number>
  /** Keys whose credentials file must never be read: a read fails the bring-up instead. */
  forbidReads: Set<string>
  /** Credentials-seam overrides consulted at call time. */
  fsOverride: Partial<PersonaBringUpFs>
  /** The persona key a credentials descriptor was opened for. */
  keyOfFd(fd: number): string | undefined
  /** The start pass as the server runs it (concurrency 1). */
  startPass(): Promise<StartupSessionManagerResult>
  /** Everything captured, for `assertNoLeak`. */
  captured(extra?: Record<string, unknown>): Record<string, unknown>
}

/**
 * Build A and B on `makeConnectionHarness` (files written, leak marker on),
 * the real controller over it with a recording file-system seam, and the
 * manager's status listener wired to the controller as server.ts wires it
 * (`h.conn.onStatus`; a test may compose more listeners in front). Sets
 * `cfg`, `a` and `b`. Tests arrange file-system failures after this.
 */
function makeHarness(opts: HarnessOptions = {}): Harness {
  const conn = makeConnectionHarness([{ name: A_NAME }, { name: B_NAME }], dir, {
    files: true,
    stubOptions: { [A_NAME]: opts.slack?.a ?? {}, [B_NAME]: opts.slack?.b ?? {} },
  })
  cfg = conn.config!
  ;[a, b] = conn.personas as [Persona, Persona]
  const { manager, lines, order } = conn
  managers.push(manager)
  const launches: LaunchRecord[] = []
  const retryLaunches: string[] = []
  const reads = new Map<string, number>()
  const forbidReads = new Set<string>()
  const fsOverride: Partial<PersonaBringUpFs> = {}
  const fdKeys = new Map<number, string>()
  const keyOf = (path: string, field: 'credentials_file' | 'working_directory') =>
    conn.personas.find((p) => p[field] === path)?.key ?? path

  // Step 4 reaches agent-director: record the persona's connection as it stands then.
  const realSpawn = ad.client.spawn.bind(ad.client)
  ad.client.spawn = async (params) => {
    const key = (params.claude_instance_id ?? '').replace(/^cscb_/, '')
    order.push(`launch:${key}`)
    const stub = conn.slack.persona(key)
    launches.push({
      key,
      state: manager.status(key)?.state,
      socketConnected: stub.sockets.some((s) => s.connected),
      authTests: stub.calls.authTest.length,
    })
    return realSpawn(params)
  }

  const controller = createPersonaBringUpController({
    connections: { bringUp: opts.bringUp ?? conn.connections.bringUp, status: (key) => manager.status(key) },
    dryRun: false,
    log: (line) => void lines.push(line),
    clock: conn.clock,
    fs: {
      openFile: (path) => {
        const key = keyOf(path, 'credentials_file')
        order.push(`credentials:${key}`)
        const fd = (fsOverride.openFile ?? DEFAULT_CREDENTIALS_FS.openFile)(path)
        fdKeys.set(fd, key)
        return fd
      },
      fstatFile: (fd) => (fsOverride.fstatFile ?? DEFAULT_CREDENTIALS_FS.fstatFile)(fd),
      readFileFd: (fd) => {
        const key = fdKeys.get(fd) ?? ''
        reads.set(key, (reads.get(key) ?? 0) + 1)
        if (forbidReads.has(key)) throw new Error('the credentials file must not be read')
        return (fsOverride.readFileFd ?? DEFAULT_CREDENTIALS_FS.readFileFd)(fd)
      },
      stat: (path) => {
        order.push(`directory:${keyOf(path, 'working_directory')}`)
        return (fsOverride.stat ?? DEFAULT_WORKING_DIRECTORY_FS.stat)(path)
      },
    },
    launch: (persona) => {
      retryLaunches.push(persona.key)
      const launched = spawnForPersona(persona, cfg, false)
      retryLaunchesInFlight.push(launched)
      return launched
    },
  })
  controllers.push(controller)
  conn.onStatus = (key, status) => controller.onConnectionStatus(key, status)

  return {
    conn,
    controller,
    lines,
    order,
    launches,
    retryLaunches,
    reads,
    forbidReads,
    fsOverride,
    keyOfFd: (fd) => fdKeys.get(fd),
    startPass: () => startupSessionManager(cfg, { concurrency: 1, bringUp: controller }),
    captured: (extra = {}) => ({ lines, order, launches, consoleLines, bringUpCalls: conn.bringUpCalls, ...extra }),
  }
}

/** The four step markers of a persona brought up and launched. */
const fullOrder = (key: string) => [`credentials:${key}`, `directory:${key}`, `slack:${key}`, `launch:${key}`]
const markersOf = (h: Harness, key: string) => h.order.filter((m) => m.endsWith(`:${key}`))

/** B went through every step and was launched once, after its connection was up. */
function expectBLaunched(h: Harness, result: StartupSessionManagerResult): void {
  expect(result.perPersona.find((p) => p.key === b.key)).toEqual({ key: b.key, action: 'spawned' })
  expect(markersOf(h, b.key)).toEqual(fullOrder(b.key))
  expect(h.launches.filter((l) => l.key === b.key)).toEqual([{ key: b.key, state: 'up', socketConnected: true, authTests: 1 }])
}

// ---------------------------------------------------------------------------
// SR-6.1: the order of the steps
// ---------------------------------------------------------------------------

describe('start pass: SR-6.1 order', () => {
  test('each persona passes its credentials, directory and Slack steps, then is launched once, only after its connection is up, with the tokens from its own file', async () => {
    const h = makeHarness()

    const result = await h.startPass()

    for (const persona of [a, b]) {
      expect(result.perPersona.find((p) => p.key === persona.key)).toEqual({ key: persona.key, action: 'spawned' })
      expect(markersOf(h, persona.key)).toEqual(fullOrder(persona.key))
      // At launch the persona's auth.test had run and its socket was open, its status up.
      expect(h.launches.filter((l) => l.key === persona.key)).toEqual([
        { key: persona.key, state: 'up', socketConnected: true, authTests: 1 },
      ])
      // The manager got the persona's tokens from its own file, read once; the clients were built with them.
      expect(h.reads.get(persona.key)).toBe(1)
      const own = h.conn.tokens(persona)
      const [validation] = h.conn.slack.buildsOf(persona.key, 'validation')
      const [socket] = h.conn.slack.buildsOf(persona.key, 'socket')
      expect(validation!.hasToken(own.botToken)).toBe(true)
      expect(validation!.hasToken(process.env['SLACK_BOT_TOKEN']!)).toBe(false)
      expect(socket!.hasToken(own.appToken)).toBe(true)
    }
    expect([...h.conn.bringUpCalls].sort((x, y) => x.key.localeCompare(y.key))).toEqual(
      [a.key, b.key].sort().map((key) => ({ key, gotTokens: true, ownTokens: true })),
    )
    expect(h.retryLaunches).toEqual([])
    assertNoLeak(h.captured({ result }))
  })
})

// ---------------------------------------------------------------------------
// Step 3 throws (a programming error, not a Slack outcome)
// ---------------------------------------------------------------------------

describe('bring-up controller: a Slack step that throws', () => {
  test('A is broken with class error and one token-free line naming it; nothing is retried or launched', async () => {
    const h = makeHarness({ bringUp: async () => { throw new Error(`manager exploded ${LEAK_SENTINEL}`) } })

    const summary = await h.controller.bringUp(a, cfg.personas)

    expect(summary).toEqual({
      outcome: 'broken',
      failures: [{ step: 'slack', class: 'error', cause: expect.stringMatching(/^Slack bring-up threw: /) }],
    })
    expect(h.controller.isUp(a.key)).toBe(false)
    const ref = renderPersonaRef(a.name, a.key)
    expect(h.lines.filter((l) => l.includes('Slack bring-up threw'))).toEqual([
      expect.stringContaining(`[slack] persona ${ref} not brought up: Slack bring-up threw: `),
    ])
    expect(h.conn.clock.pendingCount()).toBe(0)
    await h.conn.clock.advance(3_600_000)
    expect(h.retryLaunches).toEqual([])
    expect(ad.callCount()).toBe(0)
    assertNoLeak(h.captured({ summary }))
  })
})

// ---------------------------------------------------------------------------
// Non-regular credentials files: refused before any read (E2 carry)
// ---------------------------------------------------------------------------

describe('start pass: a credentials path that is not a regular file is refused unread', () => {
  /** Arrange A's credentials path, run the start pass with A's reads forbidden, and check A was refused as unreadable without a read. */
  async function expectRefusedUnread(arrange: (h: Harness) => void): Promise<void> {
    const h = makeHarness()
    arrange(h)
    h.forbidReads.add(a.key)

    const result = await h.startPass()

    expect(result.perPersona.find((p) => p.key === a.key)).toEqual({
      key: a.key,
      action: 'not-brought-up',
      outcome: 'broken',
      failures: [{ step: 'credentials', class: 'persona-credentials-unreadable', cause: expect.any(String) }],
    })
    expect(h.reads.get(a.key) ?? 0).toBe(0)
    expect(markersOf(h, a.key)).toEqual([`credentials:${a.key}`, `directory:${a.key}`])
    expect(h.conn.slack.buildsOf(a.key)).toEqual([])
    expect(ad.spawnedIds()).toEqual([`cscb_${b.key}`])
    expect(existsSync(startupErrorsLog())).toBe(false)
    expectBLaunched(h, result)
    assertNoLeak(h.captured({ result }))
  }

  test.each<[string, (h: Harness) => void]>([
    ['a directory', () => {
      rmSync(a.credentials_file)
      mkdirSync(a.credentials_file)
    }],
    ['a character device (a symlink to /dev/zero)', () => {
      rmSync(a.credentials_file)
      symlinkSync('/dev/zero', a.credentials_file)
    }],
    ['a FIFO, as the injected fstatFile reports it', (h) => {
      h.fsOverride.fstatFile = (fd) =>
        h.keyOfFd(fd) === a.key ? { isFile: () => false, isDirectory: () => false } : DEFAULT_CREDENTIALS_FS.fstatFile(fd)
    }],
  ])('%s: A is broken as unreadable with no read and no Slack client; B is launched', async (_label, arrange) => {
    await expectRefusedUnread(arrange)
  })

  const hasMkfifo = spawnSync('mkfifo', ['--version']).status === 0
  test.skipIf(!hasMkfifo)('a real FIFO (skipped where mkfifo is unavailable)', async () => {
    await expectRefusedUnread(() => {
      rmSync(a.credentials_file)
      expect(spawnSync('mkfifo', [a.credentials_file]).status).toBe(0)
    })
  })
})

// ---------------------------------------------------------------------------
// Per-persona flush of held notices (b.av2 SR-7.2; E3 Task 2 carry)
// ---------------------------------------------------------------------------

describe('held notices flush per persona when it is up (SR-7.2)', () => {
  test('A coming up posts only A\'s held notices, in order, once, through A\'s client; B\'s stay held until B\'s retry brings it up', async () => {
    // B's first auth.test cannot reach Slack; its retry 5 s later succeeds.
    const h = makeHarness({ slack: { b: { authTest: [{ kind: 'network' }] } } })
    const notifierLines: string[] = []
    const notifier = createPersonaNotifier({
      getPersona: (key) => cfg.personas.find((p) => p.key === key),
      clientFor: createPersonaClientLookup(h.conn.manager, () => cfg),
      isDryRun: () => false,
      log: (line) => void notifierLines.push(line),
    })
    // server.ts's status listener: the flush, then the controller.
    h.conn.onStatus = composePersonaStatusListeners(
      createPersonaUpFlushListener(notifier),
      (key, status) => h.controller.onConnectionStatus(key, status),
    )
    const postsOf = (key: string) => h.conn.slack.persona(key).calls.postMessage
    const noticeTo = (persona: Persona, text: string) => ({ channel: persona.permission_prompts, text: formatPersonaNotice(persona, text) })

    // Raised before any bring-up: every notice is held.
    await notifier.notify(a.key, 'first notice for A')
    await notifier.notify(b.key, 'only notice for B')
    await notifier.notify(a.key, 'second notice for A')
    expect(postsOf(a.key)).toEqual([])

    const result = await h.startPass()
    await h.conn.clock.flush()

    expect(result.perPersona.find((p) => p.key === a.key)).toEqual({ key: a.key, action: 'spawned' })
    expect(result.perPersona.find((p) => p.key === b.key)).toMatchObject({ action: 'not-brought-up', outcome: 'retrying' })
    expect(postsOf(a.key)).toEqual([noticeTo(a, 'first notice for A'), noticeTo(a, 'second notice for A')])
    expect(postsOf(b.key)).toEqual([])

    // A second transition of A to up (a drop and reopen) posts nothing again.
    h.conn.slack.persona(a.key).socket.drop()
    await h.conn.clock.flush()
    expect(h.conn.manager.status(a.key)?.state).toBe('up')
    expect(postsOf(a.key)).toHaveLength(2)

    // B's held notice was kept, and posts through B's client once B is up; the controller launches B.
    await h.conn.clock.advance(5_000)
    expect(h.controller.state(b.key)).toEqual({ outcome: 'up', causes: {} })
    expect(postsOf(b.key)).toEqual([noticeTo(b, 'only notice for B')])
    expect(postsOf(a.key)).toHaveLength(2)
    expect(h.retryLaunches).toEqual([b.key])
    assertNoLeak(h.captured({ result, notifierLines, posts: [postsOf(a.key), postsOf(b.key)] }))
  })
})

// ---------------------------------------------------------------------------
// End to end: no agent-director call for A across its connection trouble (E2 carry)
// ---------------------------------------------------------------------------

describe('end to end: A\'s connection trouble makes no agent-director call', () => {
  test('after the start pass launched A and B: a drop, a rejected reopen, an abandoned reopen and a refused reopen make zero agent-director calls and no launch; B keeps delivering', async () => {
    // The server's wiring: the real event router, and the real flush listener and controller as the status listener.
    const received: Array<{ key: string; text: unknown }> = []
    const h = makeHarness()
    const clientFor = createPersonaClientLookup(h.conn.manager, () => cfg)
    const notifier: PersonaNotifier = createPersonaNotifier({
      getPersona: (key) => cfg.personas.find((p) => p.key === key),
      clientFor,
      isDryRun: () => false,
      log: (line) => void consoleLines.push(line),
    })
    h.conn.onEvent = createPersonaEventRouter({
      routing: {
        receive: async (event, ack, receiver) => {
          await ack()
          received.push({ key: receiver as string, text: (event as { text?: unknown } | undefined)?.text })
        },
      },
      clientFor,
      getPersona: (k) => cfg.personas.find((p) => p.key === k),
      log: (line) => void consoleLines.push(line),
    })
    h.conn.onStatus = composePersonaStatusListeners(
      createPersonaUpFlushListener(notifier),
      (key, status) => h.controller.onConnectionStatus(key, status),
    )
    initOutageState({ getClient, notify: (key, text) => void notifier.notify(key, text) })
    setSessionNotifier(notifier.notify)

    const result = await h.startPass()
    expect([...result.perPersona].sort((x, y) => x.key.localeCompare(y.key))).toEqual(
      [a.key, b.key].sort().map((key) => ({ key, action: 'spawned' })),
    )
    expect([...ad.spawnedIds()].sort()).toEqual([`cscb_${a.key}`, `cscb_${b.key}`].sort())
    const afterLaunch = ad.callCount()

    const stubA = h.conn.slack.persona(a.key)
    stubA.script.connect.push({ kind: 'network' }, { kind: 'never' }, { kind: 'platform', error: 'invalid_auth' })
    stubA.socket.drop()
    // Rejected at 0 s; the retry at 5 s hangs and is abandoned at 15 s; the retry at 25 s is refused.
    await h.conn.clock.advance(25_000)

    // A's broken outcome, its refused line and "no retry timer" are pinned in
    // tests/persona-connections.test.ts (AC 23, AC 24 later credentials failure).
    expect(h.conn.manager.status(a.key)).toMatchObject({ state: 'broken', phase: 'reopen' })
    expect(ad.callCount()).toBe(afterLaunch)
    expect(h.retryLaunches).toEqual([])
    // B keeps delivering, tagged with B, through the real router.
    await h.conn.slack.persona(b.key).socket.deliver(makeChannelMessage({ text: 'still here' }))
    expect(received).toEqual([{ key: b.key, text: 'still here' }])
    expect(ad.callCount()).toBe(afterLaunch)
    assertNoLeak(h.captured({ result }))
  })
})
