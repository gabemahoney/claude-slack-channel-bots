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
 *     carry);
 *   - bug b.g57: a launch that finds A's claude_config_dir unresolvable (an
 *     injected EIO, or a symlink pointing to nothing) makes no agent-director
 *     call and hands A to the controller's hold, wired as server.ts wires it:
 *     A is retrying and not up, re-checked on 5 s doubling to 300 s with no
 *     cap, and once the directory resolves one cleared line, then one launch
 *     that resumes A's row; `cancel` leaves no timer; B is untouched. A
 *     confirmed credentials change meanwhile goes by A's Slack side
 *     (`slackSideOutcome`): with its connection working, A is reconnected
 *     (the new connection opens, then the old one closes) and stays held; a
 *     refused new file (at once, or on the reconnect's retry) keeps the old
 *     connection with one `persona-credentials-change-failed` line; A also
 *     retrying for Slack takes the new tokens on its Slack retry instead.
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
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'

import type { Persona, PersonaConfig } from '../src/config.ts'
import { getClient } from '../src/agent-director-client.ts'
import { _resetOutageState, initOutageState } from '../src/outage-state.ts'
import { DEFAULT_WORKING_DIRECTORY_FS, type PersonaBringUpFs } from '../src/persona-bringup.ts'
import {
  createPersonaBringUpController,
  type PersonaBringUpController,
  type PersonaBringUpControllerDeps,
  type PersonaBringUpState,
  type CredentialsSwap,
  type PersonaCredentialsChangeResult,
} from '../src/persona-bringup-controller.ts'
import type { PersonaConnectionManager } from '../src/persona-connections.ts'
import { DEFAULT_CREDENTIALS_FS, credentialsDigest, readCredentialsFile } from '../src/persona-credentials.ts'
import {
  PERSONA_CREDENTIALS_CHANGE_FAILED,
  PERSONA_CREDENTIALS_REFUSED,
  formatCredentialsChangeFailed,
} from '../src/persona-diagnostics.ts'
import { createPersonaEventRouter } from '../src/persona-event-router.ts'
import { personaInstanceId, renderPersonaRef } from '../src/persona-identity.ts'
import { createPersonaNotifier, formatPersonaNotice, type PersonaNotifier } from '../src/persona-notifier.ts'
import {
  composePersonaStatusListeners,
  createPersonaClientLookup,
  createPersonaUpFlushListener,
  createPersonaUpPredicate,
} from '../src/persona-start.ts'
import {
  _resetConfigDirFs,
  _setConfigDirFs,
  checkLaunchConfigDir,
  launchSession,
  setConfigDirUnresolvableHook,
  setSessionNotifier,
  spawnForPersona,
  startupSessionManager,
  type StartupSessionManagerResult,
} from '../src/session-manager.ts'
import {
  cannedGetResult,
  errInstanceIdCollision,
  installStubSpawnPath,
  resetStubSpawnPath,
  type StubSpawnPath,
} from './test-helpers/agent-director-stub.ts'
import {
  APP_TOKEN_PREFIX,
  BOT_TOKEN_PREFIX,
  LEAK_SENTINEL,
  assertNoLeak,
  fakeToken,
  writeCredentialsFile,
} from './test-helpers/credentials.ts'
import { makeConnectionHarness, type ConnectionHarness } from './test-helpers/persona-connection-harness.ts'
import {
  INITIAL_CREDENTIALS,
  makeChannelMessage,
  type StubSlack,
  type StubSlackOptions,
} from './test-helpers/slack-stub.ts'

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
  /** Each persona's claude_config_dir (none by default: both use `<home>/.claude`). */
  claudeConfigDirs?: Record<'a' | 'b', string>
  /** Passed to the controller as is. */
  checkConfigDir?: PersonaBringUpControllerDeps['checkConfigDir']
  /** Passed to the controller as is. */
  onLeftUp?: PersonaBringUpControllerDeps['onLeftUp']
  /** Passed to the controller as is (none by default: every persona counts as applied). */
  appliedPersonas?: PersonaBringUpControllerDeps['appliedPersonas']
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
  const configDirs = opts.claudeConfigDirs
  const specs = configDirs
    ? [{ name: A_NAME, claude_config_dir: configDirs.a }, { name: B_NAME, claude_config_dir: configDirs.b }]
    : [{ name: A_NAME }, { name: B_NAME }]
  const conn = makeConnectionHarness(specs, dir, {
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
    ...(opts.checkConfigDir === undefined ? {} : { checkConfigDir: opts.checkConfigDir }),
    ...(opts.onLeftUp === undefined ? {} : { onLeftUp: opts.onLeftUp }),
    ...(opts.appliedPersonas === undefined ? {} : { appliedPersonas: opts.appliedPersonas }),
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

// ---------------------------------------------------------------------------
// Bug b.g57: a claude_config_dir that cannot be resolved holds the persona
// retrying, its row untouched, until it resolves
// ---------------------------------------------------------------------------

describe('b.g57: an unresolvable claude_config_dir holds the persona retrying', () => {
  const CONFIG_DIR_CLASS = 'persona-config-dir-unresolvable'
  const DANGLING = 'ENOENT: a symlink on its path points to nothing'

  /** The "drive" A's claude_config_dir points to. */
  let aTarget: string
  /** A's claude_config_dir: a symlink onto `aTarget`. */
  let aDir: string
  /** Paths whose realpath fails with EIO (a dropped mount), read at call time. */
  let failing: Set<string>
  /** Realpath calls for A's claude_config_dir, through the launch path's seam. */
  let aResolutions: number
  /** Every `onLeftUp` call. */
  let leftUp: Array<{ key: string; state: PersonaBringUpState }>
  /** Every harness this block built, for the afterEach timer check. */
  let harnesses: Harness[]

  beforeEach(() => {
    aTarget = join(dir, 'mnt', 'a')
    mkdirSync(aTarget, { recursive: true })
    aDir = join(dir, 'claude-a')
    symlinkSync(aTarget, aDir)
    mkdirSync(join(dir, 'claude-b'))
    failing = new Set()
    aResolutions = 0
    leftUp = []
    harnesses = []
    // The launch path's resolver (the pre-launch check, the spawn label, the
    // ladder's comparison) and, through checkLaunchConfigDir, the re-check.
    _setConfigDirFs({
      realpath: (path) => {
        if (path === aDir) aResolutions++
        if (failing.has(path)) throw Object.assign(new Error('simulated I/O error'), { code: 'EIO' })
        return realpathSync(path)
      },
    })
  })

  afterEach(async () => {
    setConfigDirUnresolvableHook(undefined)
    _resetConfigDirFs()
    // No re-check timer (nor a Slack retry) outlives the test once everything is cancelled and stopped.
    for (const c of controllers) c.cancelAll()
    await Promise.allSettled(retryLaunchesInFlight)
    await Promise.all(managers.map((m) => m.stopAll()))
    for (const h of harnesses) expect(h.conn.clock.pendingCount()).toBe(0)
  })

  /** The harness with A's and B's own config dirs, wired as server.ts wires the hold. */
  function makeConfigDirHarness(
    slack?: HarnessOptions['slack'],
    appliedPersonas?: HarnessOptions['appliedPersonas'],
  ): Harness {
    const h = makeHarness({
      slack,
      claudeConfigDirs: { a: aDir, b: join(dir, 'claude-b') },
      checkConfigDir: checkLaunchConfigDir,
      onLeftUp: (persona, state) => void leftUp.push({ key: persona.key, state }),
      appliedPersonas,
    })
    setConfigDirUnresolvableHook(h.controller.holdForConfigDir)
    harnesses.push(h)
    return h
  }

  // The one full pin of this class's cause sentence; other suites match its
  // class, persona and path prefix and its reason only.
  const unresolvableCause = (reason: string) =>
    `claude_config_dir cannot be resolved to a real path (${reason}); its session is kept, and its launch waits until it resolves`
  const configDirCause = (reason: string) => ({ step: 'claude-config-dir' as const, class: CONFIG_DIR_CLASS, cause: unresolvableCause(reason) })
  const aPrefix = () => `[slack] ${CONFIG_DIR_CLASS}: personas[${a.index}] ${renderPersonaRef(a.name, a.key)} path=${JSON.stringify(aDir)}: `
  const unresolvableLine = (reason: string) => `${aPrefix()}${unresolvableCause(reason)}`
  const clearedLine = () => `${aPrefix()}cleared: claude_config_dir resolves to a real path again; continuing the launch`
  const upLine = () => `[slack] persona ${renderPersonaRef(a.name, a.key)}: up after its claude_config_dir resolved — launching`
  /** Every line of the class, from the controller and the launch path alike. */
  const classLines = (h: Harness) => [...h.lines, ...consoleLines].filter((l) => l.includes(CONFIG_DIR_CLASS))
  /** Whether any agent-director call named A's instance. */
  const adCalledForA = () => JSON.stringify(ad.calls).includes(JSON.stringify(personaInstanceId(a.key)))
  const upPredicate = (h: Harness) => createPersonaUpPredicate(h.conn.manager, h.controller)

  /** Start pass (A and B launched), then A's directory drops and a restart relaunches A. Returns the call count after the start. */
  async function startThenHoldA(h: Harness): Promise<number> {
    const result = await h.startPass()
    expect([...result.perPersona].sort((x, y) => x.key.localeCompare(y.key))).toEqual(
      [a.key, b.key].sort().map((key) => ({ key, action: 'spawned' })),
    )
    const afterStart = ad.callCount()
    failing.add(aDir)
    // The restart path's relaunch: skipped, which counts no failure toward the restart cap.
    expect(await launchSession(a.key, cfg)).toBe('skipped')
    return afterStart
  }

  test('b.g57: hold while up: the relaunch makes no agent-director call; A is retrying with the configDir cause and not up, onLeftUp told once; one line; B unchanged', async () => {
    const h = makeConfigDirHarness()

    const afterStart = await startThenHoldA(h)

    expect(ad.callCount()).toBe(afterStart)
    const held: PersonaBringUpState = { outcome: 'retrying', causes: { configDir: configDirCause('EIO') } }
    expect(h.controller.state(a.key)).toEqual(held)
    expect(h.controller.isUp(a.key)).toBe(false)
    expect(upPredicate(h)(a.key)).toBe(false)
    expect(leftUp).toEqual([{ key: a.key, state: held }])
    expect(h.controller.state(b.key)).toEqual({ outcome: 'up', causes: {} })
    expect(upPredicate(h)(b.key)).toBe(true)
    expect(classLines(h)).toEqual([unresolvableLine('EIO')])
    // Its own re-check timer, at the first step of the schedule; nothing else pending.
    expect(h.conn.clock.pending().map((t) => t.delayMs)).toEqual([5_000])
    assertNoLeak(h.captured({ leftUp }))
  })

  test('b.g57: retry: while unresolvable, A is re-checked on 5 s doubling to 300 s with no cap; nothing is launched, called or logged', async () => {
    const h = makeConfigDirHarness()
    await startThenHoldA(h)
    const cp = { lines: h.lines.length, console: consoleLines.length, ad: ad.callCount(), resolutions: aResolutions }

    // A second restart attempt in the same episode: skipped, no new line, no second timer.
    expect(await launchSession(a.key, cfg)).toBe('skipped')
    const delays: number[] = []
    for (let i = 0; i < 15; i++) {
      delays.push(h.conn.clock.pending()[0]!.delayMs)
      await h.conn.clock.runNext()
    }

    expect(delays).toEqual([5_000, 10_000, 20_000, 40_000, 80_000, 160_000, ...Array<number>(9).fill(300_000)])
    // One resolution for the restart attempt, then one per re-check: the directory really was checked each time.
    expect(aResolutions - cp.resolutions).toBe(16)
    // Still waiting after 15 failed re-checks: no cap.
    expect(h.conn.clock.pending().map((t) => t.delayMs)).toEqual([300_000])
    expect(h.controller.state(a.key)).toEqual({ outcome: 'retrying', causes: { configDir: configDirCause('EIO') } })
    expect(h.retryLaunches).toEqual([])
    expect(ad.callCount()).toBe(cp.ad)
    expect(h.lines.slice(cp.lines)).toEqual([])
    expect(consoleLines.slice(cp.console)).toEqual([])
    expect(leftUp).toHaveLength(1)
    expect(h.controller.state(b.key)).toEqual({ outcome: 'up', causes: {} })
    assertNoLeak(h.captured({ leftUp }))
  })

  test('b.g57: recovery: once it resolves, one cleared line, then one launch that resumes A\'s row (no kill, delete or fresh spawn), with no confirmation; A is up again', async () => {
    const h = makeConfigDirHarness()
    await startThenHoldA(h)
    await h.conn.clock.runNext() // a failed re-check at 5 s
    // A's row, launched at the start, has ended; its config_dir label is the one
    // its (resolvable) directory gives. The next spawn of A collides with it.
    const row = cannedGetResult({ state: 'ended' }, a, join(dir, 'home'))
    const spawn = ad.client.spawn
    ad.client.spawn = async (params) => {
      const spawned = await spawn(params)
      if (params.claude_instance_id === personaInstanceId(a.key)) throw errInstanceIdCollision()
      return spawned
    }
    ad.client.get = async (params) => {
      ad.calls.getCalls.push(params)
      return row
    }
    const cp = { lines: h.lines.length, spawns: ad.calls.spawnCalls.length }

    failing.delete(aDir)
    await h.conn.clock.runNext()
    const launched = await Promise.all(retryLaunchesInFlight)

    expect(h.lines.slice(cp.lines)).toEqual([clearedLine(), upLine()])
    expect(h.retryLaunches).toEqual([a.key])
    expect(launched).toEqual([{ key: a.key, action: 'resumed' }])
    expect(ad.spawnedIds().slice(cp.spawns)).toEqual([personaInstanceId(a.key)])
    expect(ad.calls.getCalls).toEqual([{ claude_instance_id: personaInstanceId(a.key) }])
    expect(ad.calls.resumeCalls).toEqual([{ claude_instance_id: personaInstanceId(a.key) }])
    expect(ad.calls.killCalls).toEqual([])
    expect(ad.calls.deleteCalls).toEqual([])
    expect(h.controller.state(a.key)).toEqual({ outcome: 'up', causes: {} })
    expect(upPredicate(h)(a.key)).toBe(true)
    expect(h.controller.state(b.key)).toEqual({ outcome: 'up', causes: {} })
    expect(leftUp).toHaveLength(1)
    expect(h.conn.clock.pendingCount()).toBe(0)
    await h.conn.clock.advance(3_600_000)
    expect(h.retryLaunches).toEqual([a.key])
    expect(classLines(h)).toEqual([unresolvableLine('EIO'), clearedLine()])

    // A later drop is a new episode: one new line, its schedule back at 5 s.
    failing.add(aDir)
    expect(await launchSession(a.key, cfg)).toBe('skipped')
    expect(classLines(h)).toEqual([unresolvableLine('EIO'), clearedLine(), unresolvableLine('EIO')])
    expect(h.conn.clock.pending().map((t) => t.delayMs)).toEqual([5_000])
    expect(leftUp.map((l) => l.key)).toEqual([a.key, a.key])
    assertNoLeak(h.captured({ leftUp, launched }))
  })

  test('b.g57: cancel: cancel(A) during the hold leaves no timer; nothing is re-checked or launched afterwards', async () => {
    const h = makeConfigDirHarness()
    await startThenHoldA(h)
    const resolutions = aResolutions

    h.controller.cancel(a.key)

    expect(h.conn.clock.pendingCount()).toBe(0)
    failing.delete(aDir)
    await h.conn.clock.advance(3_600_000)
    expect(aResolutions).toBe(resolutions)
    expect(h.retryLaunches).toEqual([])
    expect(classLines(h)).toEqual([unresolvableLine('EIO')])
    assertNoLeak(h.captured({ leftUp }))
  })

  test('b.g57: A held, then dropped from the applied set: its next re-check probes nothing, schedules nothing and ends its retries with one line; A is never launched; B unaffected', async () => {
    let applied: Persona[] | undefined
    const h = makeConfigDirHarness(undefined, () => applied ?? cfg.personas)
    await startThenHoldA(h)
    const cp = { lines: h.lines.length, console: consoleLines.length, ad: ad.callCount(), resolutions: aResolutions }

    applied = [b]
    await h.conn.clock.advance(5_000)

    expect(aResolutions).toBe(cp.resolutions)
    expect(h.conn.clock.pendingCount()).toBe(0)
    expect(h.lines.slice(cp.lines)).toEqual([
      `[slack] persona ${renderPersonaRef(a.name, a.key)}: no longer applied — its claude_config_dir retry stops`,
    ])
    expect(consoleLines.slice(cp.console)).toEqual([])
    // Its directory resolving later changes nothing.
    failing.delete(aDir)
    await h.conn.clock.advance(3_600_000)
    expect(aResolutions).toBe(cp.resolutions)
    expect(h.retryLaunches).toEqual([])
    expect(ad.callCount()).toBe(cp.ad)
    expect(h.controller.state(b.key)).toEqual({ outcome: 'up', causes: {} })
    expect(upPredicate(h)(b.key)).toBe(true)
    assertNoLeak(h.captured({ leftUp }))
  })

  test('b.g57: the directory resolves while A still retries for Slack: that re-check logs one cleared line and launches nothing; A is launched exactly once when its Slack retry comes up', async () => {
    // A's first three auth.tests cannot reach Slack: its Slack retries at 5 s and 15 s fail, the one at 35 s comes up.
    const h = makeConfigDirHarness({ a: { authTest: [{ kind: 'network' }, { kind: 'network' }, { kind: 'network' }] } })
    await h.startPass()
    // Held at 1 s, so its re-checks (6 s, 16 s, …) never share an instant with a Slack retry.
    await h.conn.clock.advance(1_000)
    failing.add(aDir)
    expect(await launchSession(a.key, cfg)).toBe('skipped')
    expect(h.controller.state(a.key)).toMatchObject({ outcome: 'retrying', causes: { slack: expect.anything(), configDir: configDirCause('EIO') } })

    failing.delete(aDir)
    await h.conn.clock.advance(5_000)
    await Promise.all(retryLaunchesInFlight)

    expect(classLines(h)).toEqual([unresolvableLine('EIO'), clearedLine()])
    expect(h.retryLaunches).toEqual([])
    expect(adCalledForA()).toBe(false)
    expect(h.controller.state(a.key)).toEqual({ outcome: 'retrying', causes: { slack: expect.anything() } })

    await h.conn.clock.advance(30_000)
    await Promise.all(retryLaunchesInFlight)

    expect(h.retryLaunches).toEqual([a.key])
    expect(ad.spawnedIds()).toEqual([personaInstanceId(b.key), personaInstanceId(a.key)])
    expect(h.lines.filter((l) => l.startsWith(`[slack] persona ${renderPersonaRef(a.name, a.key)}: up after`))).toEqual([
      `[slack] persona ${renderPersonaRef(a.name, a.key)}: up after its bring-up retry (Slack) — launching`,
    ])
    expect(h.controller.state(a.key)).toEqual({ outcome: 'up', causes: {} })
    await h.conn.clock.advance(3_600_000)
    expect(h.retryLaunches).toEqual([a.key])
    expect(h.controller.state(b.key)).toEqual({ outcome: 'up', causes: {} })
    assertNoLeak(h.captured({ leftUp }))
  })

  test.each<[string, (h: Harness) => Promise<void>]>([
    ['never brought up', async () => {}],
    [
      'cancelled',
      async (h) => {
        await h.startPass()
        h.controller.cancel(a.key)
      },
    ],
  ])('b.g57: holdForConfigDir for A %s returns false and holds nothing (no line, no timer); the launch path then logs the line itself on each attempt', async (_label, arrange) => {
    const h = makeConfigDirHarness()
    await arrange(h)
    failing.add(aDir)
    const failure = checkLaunchConfigDir(a)
    if (failure.ok) throw new Error('A\'s claude_config_dir should be unresolvable')
    const cp = { lines: h.lines.length, console: consoleLines.length, ad: ad.callCount() }

    expect(h.controller.holdForConfigDir(a, failure)).toBe(false)
    expect(h.lines.slice(cp.lines)).toEqual([])
    expect(h.conn.clock.pendingCount()).toBe(0)

    expect(await launchSession(a.key, cfg)).toBe('skipped')
    expect(await launchSession(a.key, cfg)).toBe('skipped')

    expect(consoleLines.slice(cp.console).filter((l) => l.includes(CONFIG_DIR_CLASS))).toEqual([unresolvableLine('EIO'), unresolvableLine('EIO')])
    expect(h.lines.slice(cp.lines)).toEqual([])
    expect(h.conn.clock.pendingCount()).toBe(0)
    expect(ad.callCount()).toBe(cp.ad)
    expect(h.controller.state(a.key)).toBeUndefined()
    assertNoLeak(h.captured({ leftUp }))
  })

  test('b.g57: bring-up: A whose claude_config_dir is a symlink pointing to nothing is never launched and ends retrying with this cause; B is launched; A is launched once the drive is back', async () => {
    const h = makeConfigDirHarness()
    rmSync(aTarget, { recursive: true })

    const result = await h.startPass()

    expect(result.perPersona.find((p) => p.key === a.key)).toEqual({
      key: a.key,
      action: 'not-brought-up',
      outcome: 'retrying',
      failures: [configDirCause(DANGLING)],
    })
    expectBLaunched(h, result)
    expect(ad.spawnedIds()).toEqual([personaInstanceId(b.key)])
    expect(adCalledForA()).toBe(false)
    expect(h.controller.state(a.key)).toEqual({ outcome: 'retrying', causes: { configDir: configDirCause(DANGLING) } })
    expect(upPredicate(h)(a.key)).toBe(false)
    expect(classLines(h)).toEqual([unresolvableLine(DANGLING)])

    // Still dangling at the first re-check; the drive is back for the second.
    await h.conn.clock.advance(5_000)
    expect(h.retryLaunches).toEqual([])
    expect(adCalledForA()).toBe(false)
    mkdirSync(aTarget)
    await h.conn.clock.advance(10_000)
    await Promise.all(retryLaunchesInFlight)

    expect(h.retryLaunches).toEqual([a.key])
    expect(ad.spawnedIds()).toEqual([personaInstanceId(b.key), personaInstanceId(a.key)])
    expect(h.controller.state(a.key)).toEqual({ outcome: 'up', causes: {} })
    expect(classLines(h)).toEqual([unresolvableLine(DANGLING), clearedLine()])
    expect(h.conn.clock.pendingCount()).toBe(0)
    assertNoLeak(h.captured({ result, leftUp }))
  })

  // -------------------------------------------------------------------------
  // A confirmed credentials change while A is held (b.g57 code review): by
  // A's Slack side, not its held outcome
  // -------------------------------------------------------------------------

  /**
   * Rotate A's credentials file in place to a new fake pair registered with
   * the stub factory under `label` (its own stub, identity and scripts).
   * Returns that set's stub and the new file's digest.
   */
  function rotateA(h: Harness, label: string, opts: StubSlackOptions = {}): { stub: StubSlack; digest: string } {
    const botToken = fakeToken(BOT_TOKEN_PREFIX, `${a.key}-${label}-bot`)
    const appToken = fakeToken(APP_TOKEN_PREFIX, `${a.key}-${label}-app`)
    const stub = h.conn.slack.addCredentials(a.key, label, { botToken, appToken }, { leakMarker: LEAK_SENTINEL, ...opts })
    writeCredentialsFile(dir, relative(dir, a.credentials_file), { bot_token: botToken, app_token: appToken })
    return { stub, digest: credentialsDigest(readCredentialsFile(a.credentials_file)) }
  }

  /** The controller's change of A against the applied set, over the real manager, recording its hooks. */
  function changeA(h: Harness, hookCalls: string[], swaps: CredentialsSwap[]) {
    return h.controller.changeCredentials(a, cfg.personas, h.conn.manager, {
      beforeSwap: () => void hookCalls.push(`beforeSwap while ${h.controller.state(a.key)?.outcome}`),
      onSwapped: (swap) => void swaps.push(swap),
    })
  }

  /** A's socket activity since `since`, as [event, credential set]. */
  const socketActivity = (h: Harness, since: number) =>
    h.conn.slack.activityOf(a.key).slice(since).filter((e) => e.kind === 'socket').map((e) => [e.event, e.credentials])
  const identityOf = (stub: StubSlack) => ({ botUserId: stub.identity.botUserId, botId: stub.identity.botId })
  const changeFailedLines = (h: Harness) => h.lines.filter((l) => l.includes(`${PERSONA_CREDENTIALS_CHANGE_FAILED}:`))

  test('b.g57: credentials change while held with a working connection: reconnected (the new connection opens, then the old one closes), swapped with wasUp; the new file held; A stays held and is not launched; once the directory resolves A is launched on its new connection', async () => {
    const h = makeConfigDirHarness()
    await startThenHoldA(h)
    const cp = { ad: ad.callCount(), activity: h.conn.slack.activityOf(a.key).length, bBuilds: h.conn.slack.buildsOf(b.key).length }
    const edited = rotateA(h, 'edited')
    const hookCalls: string[] = []
    const swaps: CredentialsSwap[] = []

    const result = await changeA(h, hookCalls, swaps)

    // Swapped as an up persona would be (not skipped, not coming back up: it
    // was up on Slack), and marked held: it is still held after the swap.
    expect(result).toEqual({ kind: 'swapped', held: true })
    expect(hookCalls).toEqual(['beforeSwap while retrying'])
    expect(swaps).toEqual([{ late: false, wasUp: true, held: true }])
    expect(socketActivity(h, cp.activity)).toEqual([
      ['built', 'edited'],
      ['started', 'edited'],
      ['connected', 'edited'],
      ['discarded', INITIAL_CREDENTIALS],
      ['disconnected', INITIAL_CREDENTIALS],
    ])
    expect(h.conn.manager.identity(a.key)).toEqual(identityOf(edited.stub))
    expect(h.controller.credentialsDigest(a.key)).toBe(edited.digest)
    // Still held: retrying with the configDir cause alone, its re-check timer the only one; nothing launched.
    expect(h.controller.state(a.key)).toEqual({ outcome: 'retrying', causes: { configDir: configDirCause('EIO') } })
    expect(h.conn.clock.pending().map((t) => t.delayMs)).toEqual([5_000])
    expect(h.retryLaunches).toEqual([])
    expect(ad.callCount()).toBe(cp.ad)
    expect(changeFailedLines(h)).toEqual([])
    // B: no client built, still up.
    expect(h.conn.slack.buildsOf(b.key)).toHaveLength(cp.bBuilds)
    expect(h.controller.state(b.key)).toEqual({ outcome: 'up', causes: {} })

    // The directory resolves: one launch of A, made while A is on the new connection.
    const identityAtLaunch: unknown[] = []
    const spawn = ad.client.spawn
    ad.client.spawn = async (params) => {
      if (params.claude_instance_id === personaInstanceId(a.key)) identityAtLaunch.push(h.conn.manager.identity(a.key))
      return spawn(params)
    }
    failing.delete(aDir)
    await h.conn.clock.runNext()
    await Promise.all(retryLaunchesInFlight)

    expect(h.retryLaunches).toEqual([a.key])
    expect(identityAtLaunch).toEqual([identityOf(edited.stub)])
    expect(h.controller.state(a.key)).toEqual({ outcome: 'up', causes: {} })
    expect(h.controller.credentialsDigest(a.key)).toBe(edited.digest)
    expect(h.conn.clock.pendingCount()).toBe(0)
    assertNoLeak(h.captured({ result, swaps, hookCalls, leftUp }))
  })

  // Rows: how Slack answers the new file's auth.test, what changeCredentials
  // resolves with, and how long the fake clock then runs (the reconnect's 5 s
  // retry, where its refusal is a late one).
  test.each<[string, StubSlackOptions['authTest'], PersonaCredentialsChangeResult, number]>([
    ['refused at once', [{ kind: 'platform', error: 'invalid_auth' }], { kind: 'failed', cause: expect.any(String) }, 0],
    [
      'unreachable, then refused on the reconnect\'s 5 s retry',
      [{ kind: 'network' }, { kind: 'platform', error: 'invalid_auth' }],
      { kind: 'retrying', connection: 'kept' },
      5_000,
    ],
  ])('b.g57: credentials change while held, new file %s: the old connection stays in use; one change-failed line saying so; the old file held again; A stays held', async (_label, authTest, expected, runMs) => {
    const h = makeConfigDirHarness()
    await startThenHoldA(h)
    const oldDigest = h.controller.credentialsDigest(a.key)
    const cp = { ad: ad.callCount(), activity: h.conn.slack.activityOf(a.key).length }
    rotateA(h, 'refused', { authTest })

    const result = await changeA(h, [], [])
    expect(result).toEqual(expected)
    await h.conn.clock.advance(runMs)

    // One line, the connection-kept ending, with Slack's refusal as its cause.
    const failed = changeFailedLines(h)
    const cause = /cannot be used: (.+); the current connection stays in use/.exec(failed[0] ?? '')?.[1] ?? ''
    expect(cause).toContain('invalid_auth')
    expect(failed).toEqual([
      formatCredentialsChangeFailed({ name: a.name, key: a.key, index: a.index, path: a.credentials_file, cause, kept: 'connection' }),
    ])
    expect(h.lines.filter((l) => l.includes(`${PERSONA_CREDENTIALS_REFUSED}:`))).toEqual([])
    expect(h.controller.credentialsDigest(a.key)).toBe(oldDigest)
    // The old connection was never let go; A is on it still.
    expect(socketActivity(h, cp.activity).filter(([, set]) => set === INITIAL_CREDENTIALS)).toEqual([])
    expect(h.conn.manager.identity(a.key)).toEqual(identityOf(h.conn.slack.persona(a.key)))
    expect(h.controller.state(a.key)).toEqual({ outcome: 'retrying', causes: { configDir: configDirCause('EIO') } })
    expect(h.retryLaunches).toEqual([])
    expect(ad.callCount()).toBe(cp.ad)
    expect(h.controller.state(b.key)).toEqual({ outcome: 'up', causes: {} })
    assertNoLeak(h.captured({ result, leftUp }))
  })

  // A late swap (the new file's first auth.test cannot reach Slack; the
  // reconnect's own retry succeeds) is marked held by whether A is held at the
  // swap, not when the change was confirmed. Rows: the new file's auth.test
  // script, whether A's directory resolves at the 5 s re-check (before the
  // swap), when the swap lands, and the swap the hook gets.
  test.each<[string, StubSlackOptions['authTest'], boolean, number, CredentialsSwap]>([
    ['A still held at the swap (5 s)', [{ kind: 'network' }], false, 5_000, { late: true, wasUp: true, held: true }],
    ['A\'s hold cleared at 5 s, before the swap (15 s)', [{ kind: 'network' }, { kind: 'network' }], true, 15_000, { late: true, wasUp: true }],
  ])('b.g57: late credentials swap, %s: changeCredentials resolves retrying with the connection kept; the swap carries held only while A is held', async (_label, authTest, resolves, swapAtMs, expectedSwap) => {
    const h = makeConfigDirHarness()
    await startThenHoldA(h)
    const cp = { activity: h.conn.slack.activityOf(a.key).length }
    const edited = rotateA(h, 'edited', { authTest })
    const swaps: CredentialsSwap[] = []

    const result = await changeA(h, [], swaps)

    expect(result).toEqual({ kind: 'retrying', connection: 'kept' })
    expect(swaps).toEqual([])
    if (resolves) failing.delete(aDir)
    await h.conn.clock.advance(5_000)
    await Promise.all(retryLaunchesInFlight)
    // The hold cleared: A launched on its old connection, before any swap.
    expect(h.retryLaunches).toEqual(resolves ? [a.key] : [])
    await h.conn.clock.advance(swapAtMs - 5_000)

    expect(swaps).toEqual([expectedSwap])
    expect(socketActivity(h, cp.activity).filter(([event]) => event === 'connected' || event === 'discarded')).toEqual([
      ['connected', 'edited'],
      ['discarded', INITIAL_CREDENTIALS],
    ])
    expect(h.conn.manager.identity(a.key)).toEqual(identityOf(edited.stub))
    expect(h.controller.credentialsDigest(a.key)).toBe(edited.digest)
    expect(h.controller.state(a.key)).toEqual(
      resolves ? { outcome: 'up', causes: {} } : { outcome: 'retrying', causes: { configDir: configDirCause('EIO') } },
    )
    expect(changeFailedLines(h)).toEqual([])
    expect(h.controller.state(b.key)).toEqual({ outcome: 'up', causes: {} })
    assertNoLeak(h.captured({ result, swaps, leftUp }))
  })

  test('b.g57: credentials change while A is retrying for Slack and held: its Slack retry takes the new tokens (no reconnect); it comes up on them still held, and is launched once the directory resolves', async () => {
    // A's first auth.test cannot reach Slack: retrying at the start pass, its retry due at 5 s.
    const h = makeConfigDirHarness({ a: { authTest: [{ kind: 'network' }] } })
    const started = await h.startPass()
    expect(started.perPersona.find((p) => p.key === a.key)).toMatchObject({ action: 'not-brought-up', outcome: 'retrying' })
    failing.add(aDir)
    expect(await launchSession(a.key, cfg)).toBe('skipped')
    expect(h.controller.state(a.key)).toMatchObject({ outcome: 'retrying', causes: { slack: expect.anything(), configDir: configDirCause('EIO') } })
    const cp = { activity: h.conn.slack.activityOf(a.key).length }
    const edited = rotateA(h, 'edited')

    const result = await changeA(h, [], [])

    expect(result).toEqual({ kind: 'retrying', connection: 'none' })
    expect(h.controller.credentialsDigest(a.key)).toBe(edited.digest)
    // Nothing opened yet: the new tokens wait for the Slack retry.
    expect(h.conn.slack.activityOf(a.key).slice(cp.activity)).toEqual([])

    await h.conn.clock.advance(5_000)

    // The retry used the new tokens only; no client of the old set was built again.
    expect(h.conn.slack.activityOf(a.key).slice(cp.activity).filter((e) => e.credentials === INITIAL_CREDENTIALS)).toEqual([])
    expect(h.conn.manager.identity(a.key)).toEqual(identityOf(edited.stub))
    expect(h.controller.state(a.key)).toEqual({ outcome: 'retrying', causes: { configDir: configDirCause('EIO') } })
    expect(adCalledForA()).toBe(false)
    expect(changeFailedLines(h)).toEqual([])

    failing.delete(aDir)
    await h.conn.clock.advance(10_000)
    await Promise.all(retryLaunchesInFlight)

    expect(ad.spawnedIds()).toEqual([personaInstanceId(b.key), personaInstanceId(a.key)])
    expect(h.controller.state(a.key)).toEqual({ outcome: 'up', causes: {} })
    expect(h.controller.state(b.key)).toEqual({ outcome: 'up', causes: {} })
    expect(h.conn.clock.pendingCount()).toBe(0)
    assertNoLeak(h.captured({ started, result, leftUp }))
  })
})
