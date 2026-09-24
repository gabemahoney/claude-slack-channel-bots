/**
 * cli.test.ts — Coverage for the CLI surface (`start`, `stop`,
 * `clean_restart`) at the createCli factory level, with all I/O injected.
 *
 * Persona model (b.av2 SR-8.7, SR-10.2): the CLI reads no Slack token (AC 47,
 * cli leg), reads the configuration file the server loads (`config.json` in
 * the state directory) with the persona loader, and tears down exactly the
 * configuration's personas, addressing each instance as `cscb_<key>`.
 *
 * Isolation (b.av2 SR-13.2): every real path sits under a per-test
 * `mkdtempSync` directory removed in `afterEach`. The token variables are
 * removed for the whole file (restored afterwards), so no case or failure
 * message can see an ambient token. `start`'s daemon is always the injected
 * fake `spawnDaemon`; the only real spawn is the usage-text test, which gets
 * a built env (PATH, temp HOME, temp SLACK_STATE_DIR). Waits in `start` run on
 * the shared fake clock.
 *
 * SPDX-License-Identifier: MIT
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, spyOn, test } from 'bun:test'
import { spawnSync } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import {
  DAEMON_FAILURE_LOG_LINES,
  DAEMON_STARTUP_POLL_MS,
  DAEMON_STARTUP_WAIT_MS,
  createCli,
  createDirectorOps,
  type CliDeps,
  type DaemonSpawnOptions,
  type DirectorClient,
  type DirectorOps,
} from '../src/cli.ts'
import { ErrCallTimeout, ErrSpawnNotFound } from '../src/agent-director-errors.ts'
import {
  loadPersonaConfig,
  prePersonaConversionMessage,
  resolveServerConfigPath,
  resolveServerStateDir,
  type PersonaConfig,
} from '../src/config.ts'
import { personaInstanceId, personaKey, renderPersonaRef } from '../src/persona-identity.ts'
import { createFakeClock, type FakeClock } from './test-helpers/fake-clock.ts'
import {
  makeMultiPersonaConfig,
  makePersona,
  makePersonaConfigInput,
  writeConfigFile,
} from './test-helpers/persona-config.ts'
import { stripComments, objectProperties } from './test-helpers/source-audit.ts'

const CLI_SOURCE = resolve(import.meta.dir, '..', 'src', 'cli.ts')
const TOKEN_VARS = ['SLACK_BOT_TOKEN', 'SLACK_APP_TOKEN'] as const

// ---------------------------------------------------------------------------
// File-level isolation: no ambient token for any case (b.av2 SR-13.2)
// ---------------------------------------------------------------------------

const savedTokenEnv: Record<string, string | undefined> = {}
const originalConsoleError = console.error
const originalConsoleLog = console.log

beforeAll(() => {
  for (const name of TOKEN_VARS) {
    savedTokenEnv[name] = process.env[name]
    delete process.env[name]
  }
})

afterAll(() => {
  for (const name of TOKEN_VARS) {
    if (savedTokenEnv[name] === undefined) delete process.env[name]
    else process.env[name] = savedTokenEnv[name]
  }
})

/** One captured console line: the args joined with spaces, an Error as its message. */
const formatLine = (args: unknown[]): string => args.map((a) => (a instanceof Error ? a.message : String(a))).join(' ')

class ExitError extends Error {
  constructor(public readonly code: number) {
    super(`exit(${code})`)
  }
}

// Per-test temp tree: <root>/state is the state directory the CLI resolves.
let root: string
let stateDir: string
let configPath: string
let logPath: string
let pidPath: string
let stderr: string[]
let errorSpy: ReturnType<typeof spyOn>
let savedArgv: string[]

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'cscb-cli-'))
  stateDir = join(root, 'state')
  mkdirSync(stateDir)
  configPath = join(stateDir, 'config.json')
  logPath = join(stateDir, 'server.log')
  pidPath = join(stateDir, 'server.pid')
  // A config file exists by default; `start` checks for it.
  writeConfigFile(stateDir, makePersonaConfigInput({ personas: [makePersona({ name: OPS_NAME }, root)] }, root))
  savedArgv = process.argv
  stderr = []
  errorSpy = spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
    stderr.push(formatLine(args))
  })
})

afterEach(() => {
  errorSpy.mockRestore()
  // Belt and braces: nothing may leave console redirected for later files.
  console.error = originalConsoleError
  console.log = originalConsoleLog
  process.argv = savedArgv
  delete process.env['_CLI_DAEMON_CHILD']
  for (const name of TOKEN_VARS) delete process.env[name]
  rmSync(root, { recursive: true, force: true })
})

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/** A persona whose name differs from its key, so name- or channel-addressing fails. */
const OPS_NAME = 'Ops Bot'
const OPS_CHANNEL = 'C0TEST001'
const opsId = (): string => personaInstanceId(personaKey(OPS_NAME))

function opsConfig(overrides: Partial<Omit<PersonaConfig, 'personas'>> = {}): PersonaConfig {
  return makeMultiPersonaConfig([{ name: OPS_NAME, channels: [{ id: OPS_CHANNEL, delivery: 'all' }] }], root, overrides)
}

/** Two personas: Alpha is in two channels, Beta is in none with DMs on. */
const ALPHA = {
  name: 'Alpha Bot',
  channels: [{ id: 'C0ALPHA01', delivery: 'all' as const }, { id: 'C0SHARED1', delivery: 'mentions' as const }],
  permission_prompts: 'C0ALPHA01',
}
const BETA = { name: 'Beta', channels: [], dm: { enabled: true, contact: 'U0TEST001' }, permission_prompts: 'dm' }

/** A fake daemon child: never a real process; records signals so "never signalled" is checkable. */
class FakeDaemon extends EventEmitter {
  unrefCalls = 0
  readonly signals: unknown[] = []
  constructor(public readonly pid: number | undefined) {
    super()
  }
  unref(): void {
    this.unrefCalls++
  }
  kill(signal?: unknown): boolean {
    this.signals.push(signal)
    return true
  }
}

const DAEMON_PID = 999_999
/** The descriptor the fake `openLogAppend` returns; never a real open file. */
const LOG_FD = 57

/** What a daemon script gets: the child and the clock to schedule its behaviour on. */
interface DaemonCtl {
  child: FakeDaemon
  clock: FakeClock
}

/** Default daemon: writes its own PID to the PID file after 200 ms (ready). */
const readyDaemon = ({ child, clock }: DaemonCtl): void => {
  clock.setTimeout(() => writeFileSync(pidPath, `${child.pid}\n`), 200)
}

interface Overrides {
  spawnSyncStatus?: number | null
  /** Written to the real `<stateDir>/server.pid` before the call. */
  serverPid?: number
  isProcessRunning?: (pid: number) => boolean
  /** Resolved config the stub loader returns; default `opsConfig()`. */
  config?: PersonaConfig
  loadConfig?: (path: string) => PersonaConfig
  /** Daemon behaviour scheduled at spawn; default `readyDaemon`. */
  daemon?: (ctl: DaemonCtl) => void
  daemonPid?: number | undefined
  /** Thrown by the fake `spawnDaemon` instead of returning a child. */
  spawnDaemonError?: Error
  /** Runs after the call is recorded; the default only records (console is never redirected). */
  initLogging?: (path: string) => void
  initClient?: () => Promise<void>
  directorStatus?: (id: string) => Promise<{ state: string } | null>
  directorPause?: (id: string) => Promise<void>
  directorKill?: (id: string) => Promise<void>
}

interface Bundle {
  deps: CliDeps
  clock: FakeClock
  exitCodes: number[]
  /** Fake-clock time of each exit. */
  exitTimes: number[]
  spawnCalls: Array<{ cmd: string; args: string[] }>
  daemonSpawns: Array<{ cmd: string; args: string[]; opts: DaemonSpawnOptions; child: FakeDaemon }>
  logOpens: string[]
  closedFds: number[]
  logInits: string[]
  loadPaths: string[]
  statusCalls: string[]
  pauseCalls: string[]
  killCalls: string[]
  serverSignals: string[]
  events: string[]
  initClientCalls: number[]
  readonly startServerCalled: boolean
}

/**
 * Deps over the per-test temp state dir. The state dir and config path come
 * from the real resolvers with an injected env naming the temp dir, the same
 * functions production wires (see the wiring audit). File reads are real, on
 * the temp tree; the director verbs, loader, spawns and clock are fakes.
 */
function makeDeps(o: Overrides = {}): Bundle {
  const clock = createFakeClock()
  const exitCodes: number[] = []
  const exitTimes: number[] = []
  const spawnCalls: Bundle['spawnCalls'] = []
  const daemonSpawns: Bundle['daemonSpawns'] = []
  const loadPaths: string[] = []
  const logOpens: string[] = []
  const closedFds: number[] = []
  const logInits: string[] = []
  const statusCalls: string[] = []
  const pauseCalls: string[] = []
  const killCalls: string[] = []
  const serverSignals: string[] = []
  const events: string[] = []
  const initClientCalls: number[] = []
  let startServerCalled = false
  if (o.serverPid !== undefined) writeFileSync(pidPath, `${o.serverPid}\n`)
  const stateEnv = { SLACK_STATE_DIR: stateDir }
  const deps: CliDeps = {
    spawnSync: (cmd, args) => {
      spawnCalls.push({ cmd, args })
      return { status: o.spawnSyncStatus !== undefined ? o.spawnSyncStatus : 0 }
    },
    spawnDaemon: (cmd, args, opts) => {
      events.push('spawnDaemon')
      if (o.spawnDaemonError) throw o.spawnDaemonError
      const child = new FakeDaemon('daemonPid' in o ? o.daemonPid : DAEMON_PID)
      daemonSpawns.push({ cmd, args, opts, child })
      ;(o.daemon ?? readyDaemon)({ child, clock })
      return child
    },
    openLogAppend: (path) => {
      logOpens.push(path)
      events.push('openLogAppend')
      return LOG_FD
    },
    closeFd: (fd) => {
      closedFds.push(fd)
      events.push(`closeFd:${fd}`)
    },
    initLogging: (path) => {
      logInits.push(path)
      events.push('initLogging')
      o.initLogging?.(path)
    },
    existsSync: (p) => existsSync(p),
    readFileSync: (p) => readFileSync(p, 'utf-8'),
    fileSize: (p) => (existsSync(p) ? statSync(p).size : 0),
    readFileFrom: (p, offset) => (existsSync(p) ? readFileSync(p).subarray(offset).toString('utf-8') : ''),
    now: () => clock.now(),
    sleep: async (ms) => {
      events.push('sleep')
      await clock.advance(ms)
    },
    unlinkSync: () => { /* the stale PID file stays; nothing reads it again */ },
    isProcessRunning: o.isProcessRunning ?? (() => false),
    kill: (_pid, signal) => {
      serverSignals.push(String(signal))
      events.push(`server:${String(signal)}`)
    },
    resolveStateDir: () => resolveServerStateDir(root, stateEnv),
    resolveConfigPath: () => resolveServerConfigPath(root, stateEnv),
    startServer: async () => { startServerCalled = true },
    exit: (code) => {
      exitCodes.push(code)
      exitTimes.push(clock.now())
      throw new ExitError(code)
    },
    loadConfig: (path) => {
      loadPaths.push(path)
      events.push('loadConfig')
      return o.loadConfig ? o.loadConfig(path) : (o.config ?? opsConfig())
    },
    ...(o.initClient
      ? {
          initClient: async () => {
            initClientCalls.push(initClientCalls.length)
            events.push('initClient')
            return o.initClient!()
          },
        }
      : {}),
    directorStatus: async (id) => {
      statusCalls.push(id)
      return o.directorStatus ? o.directorStatus(id) : null
    },
    directorPause: async (id) => {
      pauseCalls.push(id)
      events.push(`pause:${id}`)
      if (o.directorPause) return o.directorPause(id)
    },
    directorKill: async (id) => {
      killCalls.push(id)
      events.push(`kill:${id}`)
      if (o.directorKill) return o.directorKill(id)
    },
  }
  return {
    deps, clock, exitCodes, exitTimes, spawnCalls, daemonSpawns, logOpens, closedFds, logInits, loadPaths,
    statusCalls, pauseCalls, killCalls,
    serverSignals, events, initClientCalls,
    get startServerCalled() { return startServerCalled },
  }
}

const startedServer = (b: Bundle): boolean => b.spawnCalls.some((c) => c.args.includes('start'))

/** A `stop` bundle whose server is already gone (stale PID file → exit 0). */
function makeStopDeps(o: Overrides = {}): Bundle {
  return makeDeps({ serverPid: 4242, isProcessRunning: () => false, ...o })
}

// ---------------------------------------------------------------------------
// start — pre-flight (AC 47, b.av2 SR-8.7, SR-10.2)
// ---------------------------------------------------------------------------

describe('start — pre-flight', () => {
  test.each([
    ['unset', undefined],
    ['set to placeholders', 'placeholder-not-a-credential'],
  ])('AC 47: start passes pre-flight with the token variables %s (they are never read)', async (_label, value) => {
    for (const name of TOKEN_VARS) {
      if (value === undefined) delete process.env[name]
      else process.env[name] = value
    }
    const b = makeDeps()

    await expect(createCli(b.deps).start()).rejects.toBeInstanceOf(ExitError)

    // Reached the daemonize path and reported a started daemon: no exit(1).
    expect(b.daemonSpawns).toHaveLength(1)
    expect(b.exitCodes).toEqual([0])
    expect(stderr.join('\n')).not.toContain('missing prerequisite')
  })

  test('AC 47: the code of src/cli.ts names neither SLACK_BOT_TOKEN nor SLACK_APP_TOKEN (static)', () => {
    const code = stripComments(readFileSync(CLI_SOURCE, 'utf-8'))
    expect(code).not.toContain('SLACK_BOT_TOKEN')
    expect(code).not.toContain('SLACK_APP_TOKEN')
  })

  test('no config.json in the state dir: exit 1, message names <stateDir>/config.json, nothing spawned', async () => {
    rmSync(configPath)
    const b = makeDeps()

    await expect(createCli(b.deps).start()).rejects.toBeInstanceOf(ExitError)

    expect(b.exitCodes).toEqual([1])
    expect(stderr).toContain(`missing prerequisite: config.json not found at ${configPath}`)
    expect(b.daemonSpawns).toEqual([])
  })

  test('does NOT probe tmux on PATH (Epic 2: SR-5.1 owns runtime checks)', async () => {
    const b = makeDeps()
    await expect(createCli(b.deps).start()).rejects.toBeInstanceOf(ExitError)
    expect(b.spawnCalls.filter((c) => c.cmd === 'tmux')).toHaveLength(0)
  })
})

// ---------------------------------------------------------------------------
// The CLI reads the configuration file the server loads (b.av2 SR-8.7)
// ---------------------------------------------------------------------------

describe('shared config path (SR-8.7)', () => {
  /** A pre-persona key E1's loader rejects with its conversion message (b.av2 SR-1.7). */
  const PRE_PERSONA_KEY = 'default_route'
  const writePrePersonaFile = (): void => {
    writeConfigFile(stateDir, { [PRE_PERSONA_KEY]: { cwd: join(root, 'work') } })
  }

  test('production deps resolve the state dir, config path and loader with the server functions (static)', () => {
    const code = stripComments(readFileSync(CLI_SOURCE, 'utf-8'))
    const props = objectProperties(code.slice(code.indexOf('const realDeps: CliDeps =')))
    expect(props.get('resolveStateDir')).toBe('() => resolveServerStateDir()')
    expect(props.get('resolveConfigPath')).toBe('() => resolveServerConfigPath()')
    expect(props.get('loadConfig')).toBe('(path) => loadPersonaConfig(path)')
  })

  test('clean_restart loads exactly <stateDir>/config.json', async () => {
    const b = makeDeps()
    await createCli(b.deps).clean_restart()
    expect(b.loadPaths).toEqual([configPath])
  })

  test('stop (live server) loads exactly <stateDir>/config.json', async () => {
    let alive = true
    const b = makeDeps({ serverPid: 4242, isProcessRunning: () => { const was = alive; alive = false; return was } })
    await expect(createCli(b.deps).stop()).rejects.toBeInstanceOf(ExitError)
    expect(b.loadPaths).toEqual([configPath])
    expect(b.exitCodes).toEqual([0])
  })

  test('stop --stop-bots (live server) loads <stateDir>/config.json for the stop and again for the teardown', async () => {
    let alive = true
    const b = makeDeps({ serverPid: 4242, isProcessRunning: () => { const was = alive; alive = false; return was } })
    await expect(createCli(b.deps).stop({ stopBots: true })).rejects.toBeInstanceOf(ExitError)
    expect(b.loadPaths).toEqual([configPath, configPath])
    expect(b.statusCalls).toEqual([opsId()])
  })

  test('stop honours the config\'s stop_timeout: 0 sends SIGKILL right after SIGTERM to a server that stays up', async () => {
    // With the 30 s default the SIGTERM wait would outlast the test's timeout.
    const b: Bundle = makeDeps({
      serverPid: 4242,
      config: opsConfig({ stop_timeout: 0 }),
      isProcessRunning: () => !b.serverSignals.includes('SIGKILL'),
    })
    await expect(createCli(b.deps).stop()).rejects.toBeInstanceOf(ExitError)
    expect(b.serverSignals).toEqual(['SIGTERM', 'SIGKILL'])
    expect(b.exitCodes).toEqual([0])
  })

  test('clean_restart over a real two-persona file through the real loader tears down exactly cscb_<key> of each persona', async () => {
    writeConfigFile(stateDir, makePersonaConfigInput({ personas: [makePersona(ALPHA, root), makePersona(BETA, root)] }, root))
    const b = makeDeps({ loadConfig: (p) => loadPersonaConfig(p, root) })

    await createCli(b.deps).clean_restart()

    expect(new Set(b.statusCalls)).toEqual(new Set([personaInstanceId(personaKey(ALPHA.name)), personaInstanceId(personaKey(BETA.name))]))
    expect(b.statusCalls).toHaveLength(2)
    expect(startedServer(b)).toBe(true)
  })

  test('clean_restart given a pre-persona file (real loader) exits 1 with the conversion message, no director call, never starts', async () => {
    writePrePersonaFile()
    const b = makeDeps({ loadConfig: (p) => loadPersonaConfig(p, root) })

    await expect(createCli(b.deps).clean_restart()).rejects.toBeInstanceOf(ExitError)

    expect(b.exitCodes).toEqual([1])
    expect(stderr.join('\n')).toContain(prePersonaConversionMessage(PRE_PERSONA_KEY))
    expect([...b.statusCalls, ...b.pauseCalls, ...b.killCalls]).toEqual([])
    expect(b.spawnCalls).toEqual([]) // neither stop nor start ran
  })

  test('stop --stop-bots given a pre-persona file (real loader) logs, skips teardown and still stops the server', async () => {
    writePrePersonaFile()
    let alive = true
    const b = makeDeps({
      serverPid: 4242,
      isProcessRunning: () => { const was = alive; alive = false; return was },
      loadConfig: (p) => loadPersonaConfig(p, root),
    })

    await expect(createCli(b.deps).stop({ stopBots: true })).rejects.toBeInstanceOf(ExitError)

    expect(b.serverSignals).toEqual(['SIGTERM'])
    expect(b.exitCodes).toEqual([0])
    expect([...b.statusCalls, ...b.pauseCalls, ...b.killCalls]).toEqual([])
    expect(stderr.join('\n')).toContain('could not load config — skipping bot teardown')
  })
})

// ---------------------------------------------------------------------------
// start — waiting for the daemon's startup outcome (b.av2 SR-1.7, SR-8.7)
// ---------------------------------------------------------------------------

describe('start — daemon startup wait', () => {
  /** stderr lines after the "Server failed to start" header. */
  function reportedLogLines(): string[] {
    const at = stderr.findIndex((l) => l.startsWith('[slack] Server failed to start'))
    return stderr.slice(at + 1)
  }

  test.each([
    [1, null, 'exit code 1'],
    [null, 'SIGKILL', 'killed by SIGKILL'],
  ] as const)('daemon exits during the wait (%p, %p): exit 1 with only the lines it appended to server.log', async (code, signal, reason) => {
    writeFileSync(logPath, '[slack] line from an earlier run\n')
    const fatal = `[slack] Fatal: configuration error — ${prePersonaConversionMessage('default_route')}`
    const b = makeDeps({
      daemon: ({ child, clock }) => clock.setTimeout(() => {
        appendFileSync(logPath, `\n${fatal}\n`)
        child.emit('exit', code, signal)
      }, 250),
    })

    await expect(createCli(b.deps).start()).rejects.toBeInstanceOf(ExitError)

    expect(b.exitCodes).toEqual([1])
    expect(stderr).toContain(`[slack] Server failed to start (${reason}). From ${logPath}:`)
    expect(reportedLogLines()).toEqual([fatal])
    expect(b.startServerCalled).toBe(false)
  })

  test(`repeats at most the last DAEMON_FAILURE_LOG_LINES (${DAEMON_FAILURE_LOG_LINES}) non-empty lines`, async () => {
    const lines = Array.from({ length: DAEMON_FAILURE_LOG_LINES + 5 }, (_, i) => `[slack] line ${i + 1}`)
    const b = makeDeps({
      daemon: ({ child, clock }) => clock.setTimeout(() => {
        appendFileSync(logPath, lines.join('\n\n') + '\n')
        child.emit('exit', 1, null)
      }, 100),
    })

    await expect(createCli(b.deps).start()).rejects.toBeInstanceOf(ExitError)

    expect(reportedLogLines()).toEqual(lines.slice(-DAEMON_FAILURE_LOG_LINES))
  })

  test('log rotated during the wait (now shorter than before): reported from its start', async () => {
    writeFileSync(logPath, '[slack] old line that is longer than the new log\n'.repeat(10))
    const b = makeDeps({
      daemon: ({ child, clock }) => clock.setTimeout(() => {
        writeFileSync(logPath, '[slack] Fatal: fresh\n')
        child.emit('exit', 1, null)
      }, 100),
    })

    await expect(createCli(b.deps).start()).rejects.toBeInstanceOf(ExitError)

    expect(b.exitCodes).toEqual([1])
    expect(reportedLogLines()).toEqual(['[slack] Fatal: fresh'])
  })

  test('daemon exits having written nothing: exit 1, says it wrote nothing to server.log', async () => {
    writeFileSync(logPath, '[slack] line from an earlier run\n')
    const b = makeDeps({ daemon: ({ child, clock }) => clock.setTimeout(() => child.emit('exit', 1, null), 100) })

    await expect(createCli(b.deps).start()).rejects.toBeInstanceOf(ExitError)

    expect(b.exitCodes).toEqual([1])
    expect(stderr).toContain(`[slack] Server failed to start (exit code 1); it wrote nothing to ${logPath}`)
    expect(stderr.join('\n')).not.toContain('earlier run')
  })

  test('spawn fails (`error` event): exit 1, could not be launched', async () => {
    const b = makeDeps({
      daemonPid: undefined,
      daemon: ({ child, clock }) => clock.setTimeout(() => child.emit('error', new Error('spawn ENOENT')), 0),
    })

    await expect(createCli(b.deps).start()).rejects.toBeInstanceOf(ExitError)

    expect(b.exitCodes).toEqual([1])
    expect(stderr).toContain(`[slack] Server failed to start (could not be launched: spawn ENOENT); it wrote nothing to ${logPath}`)
  })

  test('daemon writes its PID to the PID file: exit 0 with the starting-in-background line, before the bound', async () => {
    const b = makeDeps() // readyDaemon: PID file at 200 ms

    await expect(createCli(b.deps).start()).rejects.toBeInstanceOf(ExitError)

    expect(b.exitCodes).toEqual([0])
    expect(stderr).toContain(`[slack] Server starting in background (PID ${DAEMON_PID})`)
    expect(b.exitTimes[0]).toBeGreaterThanOrEqual(200)
    expect(b.exitTimes[0]).toBeLessThan(200 + 2 * DAEMON_STARTUP_POLL_MS)
  })

  test('neither exit nor PID within the bound: exit 0 with the still-starting line, daemon never signalled', async () => {
    // A PID file naming another process (a previous server) does not count as ready.
    writeFileSync(pidPath, '4242\n')
    const b = makeDeps({ daemon: () => { /* stays silent */ } })

    await expect(createCli(b.deps).start()).rejects.toBeInstanceOf(ExitError)

    expect(b.exitCodes).toEqual([0])
    expect(b.exitTimes[0]).toBeGreaterThanOrEqual(DAEMON_STARTUP_WAIT_MS)
    expect(b.exitTimes[0]).toBeLessThan(DAEMON_STARTUP_WAIT_MS + DAEMON_STARTUP_POLL_MS)
    expect(stderr).toContain(
      `[slack] Server is still starting in the background (PID ${DAEMON_PID}) after ${DAEMON_STARTUP_WAIT_MS / 1000}s — its log is ${logPath}`,
    )
    expect(b.daemonSpawns[0]!.child.signals).toEqual([])
    expect(b.serverSignals).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// start — the daemon's server.log descriptor (the parent never holds it open)
// ---------------------------------------------------------------------------

describe('start — server.log descriptor', () => {
  test('opens <stateDir>/server.log, gives that fd to the daemon as stdout and stderr, closes it once after the spawn and before the wait', async () => {
    const b = makeDeps()

    await expect(createCli(b.deps).start()).rejects.toBeInstanceOf(ExitError)

    expect(b.logOpens).toEqual([logPath])
    expect(b.daemonSpawns[0]!.opts.stdio).toEqual(['ignore', LOG_FD, LOG_FD])
    expect(b.closedFds).toEqual([LOG_FD])
    expect(b.events.slice(0, 4)).toEqual(['openLogAppend', 'spawnDaemon', `closeFd:${LOG_FD}`, 'sleep'])
    expect(b.exitCodes).toEqual([0])
  })

  test('spawnDaemon throwing: the fd is still closed once and the error propagates', async () => {
    const err = new Error('spawn EAGAIN')
    const b = makeDeps({ spawnDaemonError: err })

    await expect(createCli(b.deps).start()).rejects.toBe(err)

    expect(b.closedFds).toEqual([LOG_FD])
    expect(b.exitCodes).toEqual([])
  })

  test('production deps open the log for append, close it with closeSync and redirect with initLogging from ./logging.ts (static)', () => {
    const code = stripComments(readFileSync(CLI_SOURCE, 'utf-8'))
    const props = objectProperties(code.slice(code.indexOf('const realDeps: CliDeps =')))
    expect(props.get('openLogAppend')).toBe("(path) => openSync(path, 'a')")
    expect(props.get('closeFd')).toBe('(fd) => closeSync(fd)')
    expect(props.get('initLogging')).toBe('initLogging')
    expect(code).toMatch(/import\s*\{\s*initLogging\s*\}\s*from\s*'\.\/logging\.ts'/)
  })
})

// ---------------------------------------------------------------------------
// start — session-leader daemonize guard (b.acn)
//
// The bug: a leaked _CLI_DAEMON_CHILD marker in the launcher's environment made
// `start` trust the marker and run the server in-place (child path), inheriting
// the launcher's session/PGID so killing the launcher's group killed the server.
// The fix: only trust the marker when the process is ALSO a session leader; a
// set-but-not-leader marker is treated as a leak, cleared, and the parent path
// re-detaches via a detached spawn.
//
// Under `bun test` the test process is NOT a session leader, so with the marker
// preset we exercise exactly the leaked-marker scenario:
//   - fixed code  -> parent path: detached spawn + exit(0), startServer NOT run
//   - pre-fix code -> child path: startServer run in-place (the bug)
//
// The daemon is the injected fake `spawnDaemon`, so no real server process is
// ever launched (shared-infra safety).
// ---------------------------------------------------------------------------

/** Session id (field 4 after comm) from /proc/self/stat, as src/cli.ts reads it; null without /proc. */
function readOwnSessionId(): number | null {
  try {
    const stat = readFileSync('/proc/self/stat', 'utf8')
    const fields = stat.slice(stat.lastIndexOf(') ') + 2).split(' ')
    const session = parseInt(fields[3] ?? '', 10)
    return Number.isNaN(session) ? null : session
  } catch {
    return null
  }
}

describe('start — daemonize session-leader guard (b.acn)', () => {
  beforeEach(() => {
    // PRECONDITION: the leaked-marker tests assume the runner is NOT a session
    // leader. Fail loudly with a self-diagnosing message if it is (e.g. PID 1).
    const sid = readOwnSessionId()
    if (sid !== null && sid === process.pid) {
      throw new Error(
        `b.acn precondition violated: the test runner IS a session leader ` +
        `(session id ${sid} === pid ${process.pid}). The leaked-marker guard ` +
        `tests require a non-session-leader runner. Run the suite as a child ` +
        `process (not PID 1 / not a session leader).`,
      )
    }
  })

  // The recorded spawn is a real detach: detached:true, the marker in the child
  // env, stdio not inherited (the child survives its parent), the `start`
  // subcommand, and the child unref'd.
  function expectRealDetach(b: Bundle) {
    expect(b.daemonSpawns).toHaveLength(1)
    const { cmd, args, opts, child } = b.daemonSpawns[0]!
    expect(cmd).toBe(process.execPath)
    expect(opts.detached).toBe(true)
    expect(opts.env['_CLI_DAEMON_CHILD']).toBe('1')
    expect(opts.stdio).not.toContain('inherit')
    expect(opts.stdio[0]).toBe('ignore')
    expect(args).toContain('start')
    expect(child.unrefCalls).toBe(1)
  }

  // REGRESSION (b.acn): fails with pre-fix code, passes with the fix.
  test('leaked _CLI_DAEMON_CHILD marker (not a session leader) re-detaches instead of running in-place', async () => {
    const b = makeDeps()
    process.env['_CLI_DAEMON_CHILD'] = '1'

    await expect(createCli(b.deps).start()).rejects.toBeInstanceOf(ExitError)

    expectRealDetach(b)
    expect(b.exitCodes).toEqual([0])
    expect(b.startServerCalled).toBe(false)
  })

  // Baseline: with no marker, the parent always detaches.
  test('no marker at all: parent detaches and exits (baseline)', async () => {
    const b = makeDeps()

    await expect(createCli(b.deps).start()).rejects.toBeInstanceOf(ExitError)

    expectRealDetach(b)
    expect(b.exitCodes).toEqual([0])
    expect(b.startServerCalled).toBe(false)
  })

  // b.av2 SR-10.2: `--reconcile-instance-ids` is retired, so `start` no longer
  // turns it into CSCB_RECONCILE_INSTANCE_IDS for the daemon child.
  test('--reconcile-instance-ids on argv is not forwarded to the daemon child as CSCB_RECONCILE_INSTANCE_IDS (SR-10.2)', async () => {
    const savedEnv = process.env['CSCB_RECONCILE_INSTANCE_IDS']
    // The child env copies process.env, so the runner's own value must not mask a forward.
    delete process.env['CSCB_RECONCILE_INSTANCE_IDS']
    process.argv = [...savedArgv, '--reconcile-instance-ids']
    try {
      const b = makeDeps()
      await expect(createCli(b.deps).start()).rejects.toBeInstanceOf(ExitError)

      expectRealDetach(b)
      expect('CSCB_RECONCILE_INSTANCE_IDS' in b.daemonSpawns[0]!.opts.env).toBe(false)
    } finally {
      if (savedEnv === undefined) delete process.env['CSCB_RECONCILE_INSTANCE_IDS']
      else process.env['CSCB_RECONCILE_INSTANCE_IDS'] = savedEnv
    }
  })
})

// ---------------------------------------------------------------------------
// Persona-set teardown (b.av2 SR-8.7): exactly the config's personas, by cscb_<key>
// ---------------------------------------------------------------------------

describe('persona-set teardown', () => {
  const twoPersonas = (): PersonaConfig => makeMultiPersonaConfig([ALPHA, BETA], root)
  const alphaId = (): string => personaInstanceId(personaKey(ALPHA.name))
  const betaId = (): string => personaInstanceId(personaKey(BETA.name))

  test.each([
    ['clean_restart', (b: Bundle) => createCli(b.deps).clean_restart()],
    ['stop --stop-bots', (b: Bundle) => createCli(b.deps).stop({ stopBots: true }).catch((e) => { if (!(e instanceof ExitError)) throw e })],
  ])('%s: two personas (two channels; zero channels with DMs) each get one status, pause and kill on cscb_<key>, none by channel', async (_name, run) => {
    const b = makeStopDeps({
      config: twoPersonas(),
      directorStatus: async () => ({ state: 'waiting' }),
      directorPause: async () => { throw new Error('pause failed') }, // escalate → one kill each
    })

    await run(b)

    const ids = [alphaId(), betaId()].sort()
    expect([...b.statusCalls].sort()).toEqual(ids)
    expect([...b.pauseCalls].sort()).toEqual(ids)
    expect([...b.killCalls].sort()).toEqual(ids)
    const channelIds = [...ALPHA.channels.map((c) => c.id)]
    for (const call of [...b.statusCalls, ...b.pauseCalls, ...b.killCalls]) {
      expect(channelIds.some((c) => call.includes(c))).toBe(false)
    }
    expect(b.exitCodes).not.toContain(1)
  })

  test('the instance ID is cscb_<key>, never the persona name or its channel', async () => {
    const b = makeDeps({ directorStatus: async () => ({ state: 'ended' }) })
    await createCli(b.deps).clean_restart()
    expect(personaKey(OPS_NAME)).not.toBe(OPS_NAME) // precondition: name ≠ key
    expect(b.statusCalls).toEqual([opsId()])
  })

  test('an absent row logs the persona reference ("<name>" (key=<key>)) and skips', async () => {
    const b = makeDeps({ directorStatus: async () => null })
    await createCli(b.deps).clean_restart()
    expect(stderr).toContain(`[slack] teardownBots: no spawn row for persona ${renderPersonaRef(OPS_NAME, personaKey(OPS_NAME))} — skipping`)
  })

  test('clean_restart with an empty personas array: no director call, still stops and starts', async () => {
    const b = makeDeps({ config: makeMultiPersonaConfig([], root), directorStatus: async () => ({ state: 'waiting' }) })
    await createCli(b.deps).clean_restart()
    expect([...b.statusCalls, ...b.pauseCalls, ...b.killCalls]).toEqual([])
    expect(b.spawnCalls.map((c) => c.args.at(-1))).toEqual(['stop', 'start'])
    expect(b.exitCodes).toEqual([])
  })

  test('stop --stop-bots with an empty personas array: no director call, server stop exit 0', async () => {
    const b = makeStopDeps({ config: makeMultiPersonaConfig([], root), directorStatus: async () => ({ state: 'waiting' }) })
    await expect(createCli(b.deps).stop({ stopBots: true })).rejects.toBeInstanceOf(ExitError)
    expect([...b.statusCalls, ...b.pauseCalls, ...b.killCalls]).toEqual([])
    expect(b.exitCodes).toEqual([0])
  })

  test('one persona failing loudly still lets the other be torn down; the aggregate counts one persona', async () => {
    const b = makeDeps({
      config: twoPersonas(),
      directorStatus: async (id) => {
        if (id === alphaId()) throw new ErrCallTimeout('status', 35000, 30000)
        return { state: 'waiting' }
      },
      directorPause: async () => { throw new Error('pause failed') },
    })
    await expect(createCli(b.deps).clean_restart()).rejects.toBeInstanceOf(ExitError)
    expect(b.killCalls).toEqual([betaId()])
    expect(b.exitCodes).toEqual([1])
    expect(stderr.join('\n')).toContain('teardown incomplete for 1 persona(s)')
    expect(startedServer(b)).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// clean_restart — SR-11 Event 12 — pause + poll + escalate
// ---------------------------------------------------------------------------

describe('clean_restart', () => {
  test('genuinely-absent row (null) skips quietly and clean_restart still starts', async () => {
    const b = makeDeps({ directorStatus: async () => null })
    await createCli(b.deps).clean_restart()
    expect(b.statusCalls).toEqual([opsId()])
    expect(b.pauseCalls).toEqual([])
    expect(b.killCalls).toEqual([])
    // Absent-row (null) → skip + proceed; AD error (throw) → loud abort (b.qwo below).
    expect(b.exitCodes).not.toContain(1)
    expect(startedServer(b)).toBe(true)
  })

  test('skips personas already in terminal state', async () => {
    const b = makeDeps({ directorStatus: async () => ({ state: 'ended' }) })
    await createCli(b.deps).clean_restart()
    expect(b.pauseCalls).toEqual([])
  })

  test('pauses + reports cleanly when status transitions to terminal', async () => {
    let n = 0
    const b = makeDeps({
      directorStatus: async () => (++n === 1 ? { state: 'waiting' } : { state: 'ended' }), // precheck → terminal
    })
    await createCli(b.deps).clean_restart()
    expect(b.pauseCalls).toEqual([opsId()])
    expect(b.killCalls).toEqual([])
  })

  test('escalates to kill on pause failure', async () => {
    const b = makeDeps({
      directorStatus: async () => ({ state: 'waiting' }),
      directorPause: async () => { throw new Error('pause failed') },
    })
    await createCli(b.deps).clean_restart()
    expect(b.killCalls).toEqual([opsId()])
  })

  // b.dnt: AD dies between the precheck and the pause. The escalation kill also
  // throws a non-ErrSpawnNotFound error; it rejects into the allSettled
  // aggregate → loud throw → clean_restart exit(1), no start.
  test('b.dnt: escalation kill failing (non-ErrSpawnNotFound) rejects loudly (AD died mid-teardown)', async () => {
    const b = makeDeps({
      directorStatus: async () => ({ state: 'waiting' }),
      directorPause: async () => { throw new Error('AD connection refused') },
      directorKill: async () => { throw new ErrCallTimeout('kill', 35000, 30000) },
    })
    await expect(createCli(b.deps).clean_restart()).rejects.toBeInstanceOf(ExitError)
    expect(b.killCalls).toEqual([opsId()])
    expect(b.exitCodes).toContain(1)
    expect(startedServer(b)).toBe(false)
  })

  // b.dnt: the benign already-gone ErrSpawnNotFound race stays per-persona handled.
  test('b.dnt: escalation kill failing with ErrSpawnNotFound stays quiet (benign already-gone race)', async () => {
    const b = makeDeps({
      directorStatus: async () => ({ state: 'waiting' }),
      directorPause: async () => { throw new Error('pause failed') },
      directorKill: async () => { throw new ErrSpawnNotFound('kill', 'ErrSpawnNotFound', 'row gone') },
    })
    await createCli(b.deps).clean_restart()
    expect(b.killCalls).toEqual([opsId()])
    expect(b.exitCodes).not.toContain(1)
    expect(startedServer(b)).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// clean_restart — clean_restart.log, with fatal lines also on the terminal
// ---------------------------------------------------------------------------

describe('clean_restart — clean_restart.log and the terminal', () => {
  /** An initLogging that sends console.error to `log`, as the real one sends it to the file. */
  const redirectTo = (log: string[]) => (): void => {
    console.error = (...args: unknown[]) => { log.push(formatLine(args)) }
  }

  const FATAL: Array<[string, Overrides, string]> = [
    ['config load fails', { loadConfig: () => { throw new Error('config boom') } }, '[slack] clean_restart: failed to load config: config boom'],
    [
      'agent-director initialization fails',
      { initClient: async () => { throw new Error('startup gate failed') } },
      '[slack] clean_restart: agent-director initialization failed: startup gate failed',
    ],
    [
      'teardown fails',
      { directorStatus: async () => { throw new Error('AD connection refused') } },
      '[slack] clean_restart: bot teardown failed — aborting restart: teardownBots: agent-director error',
    ],
    // stop's non-zero exit is a non-fatal line: log only.
    ['start fails', { spawnSyncStatus: 3 }, '[slack] clean_restart: start failed with exit code 3'],
  ]

  test.each(FATAL)('%s: the fatal line reaches the terminal once and the log once; no other line reaches the terminal', async (_name, o, line) => {
    const log: string[] = []
    const b = makeDeps({ ...o, initLogging: redirectTo(log) })

    await expect(createCli(b.deps).clean_restart()).rejects.toBeInstanceOf(ExitError)

    expect(b.logInits).toEqual([join(stateDir, 'clean_restart.log')])
    expect(stderr).toHaveLength(1)
    expect(stderr[0]!.startsWith(line)).toBe(true)
    expect(log.filter((l) => l === stderr[0])).toHaveLength(1)
  })

  test('a successful run redirects to <stateDir>/clean_restart.log before loading the config; every line goes to the log, none to the terminal', async () => {
    const log: string[] = []
    const b = makeDeps({ initLogging: redirectTo(log) })

    await createCli(b.deps).clean_restart()

    expect(b.logInits).toEqual([join(stateDir, 'clean_restart.log')])
    expect(b.events.indexOf('initLogging')).toBeLessThan(b.events.indexOf('loadConfig'))
    expect(stderr).toEqual([])
    expect(log).toContain('[slack] clean_restart: stopping server')
    expect(log).toContain('[slack] clean_restart: done')
  })

  test('initLogging throwing: clean_restart still runs, its lines stay on the terminal and the fatal line appears once', async () => {
    const b = makeDeps({ spawnSyncStatus: 3, initLogging: () => { throw new Error('EACCES') } })

    await expect(createCli(b.deps).clean_restart()).rejects.toBeInstanceOf(ExitError)

    expect(b.exitCodes).toEqual([3])
    expect(stderr).toContain('[slack] clean_restart: stopping server')
    expect(stderr.filter((l) => l === '[slack] clean_restart: start failed with exit code 3')).toHaveLength(1)
  })
})

// ---------------------------------------------------------------------------
// createDirectorOps — the production director deps (b.qwo, b.dnt)
// ---------------------------------------------------------------------------

describe('createDirectorOps', () => {
  const OPS: Array<keyof DirectorOps> = ['directorStatus', 'directorPause', 'directorKill']

  /** A fake Client whose verbs record [verb, request] and throw `fail` when given. */
  function fakeClient(fail?: Error): { client: DirectorClient; calls: Array<[string, unknown]> } {
    const calls: Array<[string, unknown]> = []
    const verb = (name: string, result: object) => async (req: unknown) => {
      calls.push([name, req])
      if (fail) throw fail
      return result
    }
    const client = { status: verb('status', { state: 'working' }), pause: verb('pause', {}), kill: verb('kill', {}) }
    return { client: client as unknown as DirectorClient, calls }
  }

  const notFound = (): Error => new ErrSpawnNotFound('status', 'ErrSpawnNotFound', 'row gone')
  const refused = (): Error => new Error('AD connection refused')
  const timeout = (): Error => new ErrCallTimeout('status', 35000, 30000)

  test.each([
    ['directorStatus', 'ErrSpawnNotFound', 'resolves null', notFound],
    ['directorStatus', 'a connection error', 'rejects', refused],
    ['directorStatus', 'ErrCallTimeout', 'rejects', timeout],
    ['directorKill', 'ErrSpawnNotFound', 'resolves', notFound],
    ['directorKill', 'a connection error', 'rejects', refused],
    ['directorKill', 'ErrCallTimeout', 'rejects', timeout],
    ['directorPause', 'ErrSpawnNotFound', 'rejects', notFound],
    ['directorPause', 'a connection error', 'rejects', refused],
    ['directorPause', 'ErrCallTimeout', 'rejects', timeout],
  ] as const)('%s when the Client throws %s: %s', async (op, _name, outcome, makeErr) => {
    const err = makeErr()
    const call = createDirectorOps(() => fakeClient(err).client)[op](opsId())
    if (outcome === 'rejects') await expect(call).rejects.toBe(err)
    else expect(await call).toBe(outcome === 'resolves null' ? null : undefined)
  })

  test.each(OPS)('%s rejects with getClient\'s own error when getClient throws (no Client installed)', async (op) => {
    const err = new Error('agent-director client not initialized')
    await expect(createDirectorOps(() => { throw err })[op](opsId())).rejects.toBe(err)
  })

  test('getClient is called on every op (a Client installed later is used) and each verb gets cscb_<key> as claude_instance_id', async () => {
    let installed: DirectorClient | null = null
    let gets = 0
    const ops = createDirectorOps(() => {
      gets++
      if (installed === null) throw new Error('agent-director client not initialized')
      return installed
    })
    await expect(ops.directorStatus(opsId())).rejects.toThrow('agent-director client not initialized')
    const { client, calls } = fakeClient()
    installed = client

    expect(await ops.directorStatus(opsId())).toEqual({ state: 'working' })
    await ops.directorPause(opsId())
    await ops.directorKill(opsId())

    expect(gets).toBe(4)
    const req = { claude_instance_id: opsId() }
    expect(calls).toEqual([['status', req], ['pause', req], ['kill', req]])
  })

  test('production deps take directorStatus / directorPause / directorKill from createDirectorOps(getClient) (static)', () => {
    const code = stripComments(readFileSync(CLI_SOURCE, 'utf-8'))
    expect(code).toMatch(/import\s*\{\s*getClient\s*\}\s*from\s*'\.\/agent-director-client\.ts'/)
    const made = [...code.matchAll(/\bconst\s+(\w+)\s*=\s*createDirectorOps\s*\(\s*getClient\s*\)/g)]
    expect(made).toHaveLength(1)
    const props = objectProperties(code.slice(code.indexOf('const realDeps: CliDeps =')))
    for (const op of OPS) expect(props.get(op)).toBe(`${made[0]![1]}.${op}`)
  })
})

// ---------------------------------------------------------------------------
// stop — b.4dk `--stop-bots` graceful bot teardown
//
// `stop({ stopBots: true })` reuses clean_restart's per-persona pause/poll/kill
// teardown (teardownBots) AFTER stopping the server. Plain `stop()` never
// touches the director verbs — bots survive server restarts.
// ---------------------------------------------------------------------------

describe('stop --stop-bots (b.4dk)', () => {
  test('stopBots: per-persona pause runs and server still stops', async () => {
    let n = 0
    const b = makeStopDeps({
      directorStatus: async () => (++n === 1 ? { state: 'waiting' } : { state: 'ended' }),
    })
    await expect(createCli(b.deps).stop({ stopBots: true })).rejects.toBeInstanceOf(ExitError)
    expect(b.pauseCalls).toEqual([opsId()])
    expect(b.killCalls).toEqual([])
    expect(b.statusCalls[0]).toBe(opsId())
    expect(b.exitCodes).toContain(0)
  })

  test('stopBots: pause timeout escalates to kill, server still stops', async () => {
    const b = makeStopDeps({ config: opsConfig({ exit_timeout: 0 }), directorStatus: async () => ({ state: 'waiting' }) })
    await expect(createCli(b.deps).stop({ stopBots: true })).rejects.toBeInstanceOf(ExitError)
    expect(b.pauseCalls).toEqual([opsId()])
    expect(b.killCalls).toEqual([opsId()]) // exit_timeout=0 → immediate kill escalation
    expect(b.exitCodes).toContain(0)
  })

  // b.dnt: timeout-path kill failing with a non-benign error rejects into the
  // aggregate → exit(1), not the stale-PID exit(0).
  test('stopBots: timeout-path kill failing (non-ErrSpawnNotFound) rejects loudly (b.dnt)', async () => {
    const b = makeStopDeps({
      config: opsConfig({ exit_timeout: 0 }),
      directorStatus: async () => ({ state: 'waiting' }),
      directorPause: async () => { /* pause succeeds */ },
      directorKill: async () => { throw new ErrCallTimeout('kill', 35000, 30000) },
    })
    await expect(createCli(b.deps).stop({ stopBots: true })).rejects.toBeInstanceOf(ExitError)
    expect(b.pauseCalls).toEqual([opsId()])
    expect(b.killCalls).toEqual([opsId()])
    expect(b.exitCodes).toContain(1)
  })

  // b.dnt: the benign ErrSpawnNotFound race on the timeout path stays quiet.
  test('stopBots: timeout-path kill failing with ErrSpawnNotFound stays quiet, server still stops (b.dnt)', async () => {
    const b = makeStopDeps({
      config: opsConfig({ exit_timeout: 0 }),
      directorStatus: async () => ({ state: 'waiting' }),
      directorPause: async () => { /* pause succeeds */ },
      directorKill: async () => { throw new ErrSpawnNotFound('kill', 'ErrSpawnNotFound', 'row gone') },
    })
    await expect(createCli(b.deps).stop({ stopBots: true })).rejects.toBeInstanceOf(ExitError)
    expect(b.pauseCalls).toEqual([opsId()])
    expect(b.killCalls).toEqual([opsId()])
    expect(b.exitCodes).not.toContain(1)
    expect(b.exitCodes).toContain(0)
  })

  test('stopBots: a config load error does NOT block server stop and runs no director verb', async () => {
    const b = makeStopDeps({ loadConfig: () => { throw new Error('config boom') } })
    await expect(createCli(b.deps).stop({ stopBots: true })).rejects.toBeInstanceOf(ExitError)
    expect(b.exitCodes).toEqual([0])
    expect([...b.statusCalls, ...b.pauseCalls, ...b.killCalls]).toEqual([])
  })

  // b.4dk ordering: the server is stopped BEFORE any bot teardown begins, so the
  // live daemon cannot respawn a persona mid-teardown.
  test('stopBots: server SIGTERM precedes any director verb (teardown-first regression guard)', async () => {
    let alive = true
    const b = makeDeps({
      serverPid: 4242,
      isProcessRunning: () => { const was = alive; alive = false; return was },
      config: opsConfig({ stop_timeout: 1, exit_timeout: 0 }),
      directorStatus: async () => ({ state: 'waiting' }),
    })
    await expect(createCli(b.deps).stop({ stopBots: true })).rejects.toBeInstanceOf(ExitError)
    const firstServer = b.events.indexOf('server:SIGTERM')
    const firstPause = b.events.findIndex((e) => e.startsWith('pause:'))
    expect(firstServer).toBeGreaterThanOrEqual(0)
    expect(firstPause).toBeGreaterThanOrEqual(0)
    expect(firstServer).toBeLessThan(firstPause)
  })

  test.each([[undefined], [{}]])(
    'plain stop(%p) never touches director verbs (bots survive server restarts)',
    async (opts) => {
      const b = makeStopDeps({ directorStatus: async () => ({ state: 'waiting' }) })
      await expect(createCli(b.deps).stop(opts)).rejects.toBeInstanceOf(ExitError)
      expect(b.pauseCalls).toEqual([])
      expect(b.killCalls).toEqual([])
      expect(b.statusCalls).toEqual([])
    },
  )
})

describe('clean_restart teardown-via-closure regression (b.4dk)', () => {
  test('clean_restart still pauses each live persona (shared teardownBots closure)', async () => {
    let n = 0
    const b = makeDeps({ directorStatus: async () => (++n === 1 ? { state: 'waiting' } : { state: 'ended' }) })
    await createCli(b.deps).clean_restart()
    expect(b.pauseCalls).toEqual([opsId()])
    expect(b.killCalls).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// b.qwo — AD-unreachable teardown must fail LOUDLY, never a silent no-op
//
// Root cause (b.qps / incident-2026-09-18): getClient() threw in the short-lived
// CLI process (no server startup gate) and the error was collapsed into a
// per-bot "no spawn row — skipping". Every bot was skipped and clean_restart
// proceeded to `start`. Now directorStatus errors propagate (null only for
// ErrSpawnNotFound); teardownBots throws an aggregate; clean_restart and
// `stop --stop-bots` exit(1) and never start.
// ---------------------------------------------------------------------------

describe('b.qwo — teardown fails loudly when agent-director is unreachable', () => {
  test.each([
    ['a connection error', () => new Error('AD connection refused')],
    ['ErrCallTimeout', () => new ErrCallTimeout('status', 35000, 30000)],
  ])('clean_restart aborts (exit 1, no start) when directorStatus throws %s — never "no spawn row"', async (_name, makeErr) => {
    const b = makeDeps({ directorStatus: async () => { throw makeErr() } })
    await expect(createCli(b.deps).clean_restart()).rejects.toBeInstanceOf(ExitError)
    expect(b.exitCodes).toContain(1)
    expect(startedServer(b)).toBe(false)
    expect(b.pauseCalls).toEqual([])
    expect(b.killCalls).toEqual([])
    expect(stderr.join('\n')).not.toContain('no spawn row')
  })

  test('stop --stop-bots exits 1 when directorStatus throws (AD unreachable)', async () => {
    const b = makeStopDeps({ directorStatus: async () => { throw new Error('AD connection refused') } })
    await expect(createCli(b.deps).stop({ stopBots: true })).rejects.toBeInstanceOf(ExitError)
    expect(b.exitCodes).toContain(1)
    expect(stderr.join('\n')).not.toContain('no spawn row')
  })

  // Kill-never-delete: static guard over src/cli.ts — the teardown path must
  // never call a delete/destroy verb on the AD client.
  test('src/cli.ts teardown surface calls no delete/destroy verb (kill-never-delete, static audit)', async () => {
    const src = readFileSync(CLI_SOURCE, 'utf-8')
    // Ban any AD delete verb reachable from teardown: directorDelete, a bare
    // deps.delete(...), or a director*.delete(...)/destroy(...) call. Comment /
    // JSDoc lines are excluded so prose like "never deletes" does not trip it.
    const banned = /\b(directorDelete\b|deps\.delete\s*\(|director\w*\.(delete|destroy)\s*\(|\.deleteSpawn\s*\()/
    const offenders = src
      .split('\n')
      .map((line, i) => ({ lineNo: i + 1, line }))
      .filter(({ line }) => !/^\s*(\*|\/\/)/.test(line))
      .filter(({ line }) => banned.test(line))
    expect(offenders.map((o) => `cli.ts:${o.lineNo}: ${o.line.trim()}`)).toEqual([])
  })
})

describe('b.qwo — initClient startup gate', () => {
  test('clean_restart calls initClient once, before any director verb', async () => {
    let n = 0
    const b = makeDeps({
      initClient: async () => { /* gate ok */ },
      directorStatus: async () => (++n === 1 ? { state: 'waiting' } : { state: 'ended' }),
    })
    await createCli(b.deps).clean_restart()
    expect(b.initClientCalls).toEqual([0])
    const initIdx = b.events.indexOf('initClient')
    const firstPause = b.events.findIndex((e) => e.startsWith('pause:'))
    expect(initIdx).toBeGreaterThanOrEqual(0)
    expect(firstPause).toBeGreaterThan(initIdx)
  })

  test('clean_restart exits 1 (no start) when initClient throws', async () => {
    const b = makeDeps({
      initClient: async () => { throw new Error('startup gate failed') },
      directorStatus: async () => ({ state: 'waiting' }),
    })
    await expect(createCli(b.deps).clean_restart()).rejects.toBeInstanceOf(ExitError)
    expect(b.exitCodes).toContain(1)
    expect(startedServer(b)).toBe(false)
    expect(b.statusCalls).toEqual([])
  })

  test('stop --stop-bots exits 1 when initClient throws', async () => {
    const b = makeStopDeps({
      initClient: async () => { throw new Error('startup gate failed') },
      directorStatus: async () => ({ state: 'waiting' }),
    })
    await expect(createCli(b.deps).stop({ stopBots: true })).rejects.toBeInstanceOf(ExitError)
    expect(b.exitCodes).toContain(1)
    expect(b.statusCalls).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// unknown subcommand — regression for b.8tm (trail subcommand removed)
// ---------------------------------------------------------------------------

describe('unknown subcommand', () => {
  test('`trail` hits the usage error (non-zero exit; no "trail", retired reconcile flag or token variable in usage)', () => {
    const result = spawnSync(process.execPath, [CLI_SOURCE, 'trail'], {
      encoding: 'utf-8',
      // A built env (b.av2 SR-13.2): temp HOME and state dir, no token, nothing else from process.env.
      env: { PATH: process.env['PATH'] ?? '', HOME: root, SLACK_STATE_DIR: stateDir },
    })
    expect(result.status).not.toBe(0)
    const output = (result.stderr ?? '') + (result.stdout ?? '')
    expect(output).not.toMatch(/\btrail\b/)
    expect(output).not.toContain('--reconcile-instance-ids')
    expect(output).not.toContain('CSCB_RECONCILE_INSTANCE_IDS')
    for (const name of TOKEN_VARS) expect(output).not.toContain(name)
    expect(output).toContain('start')
  })
})
