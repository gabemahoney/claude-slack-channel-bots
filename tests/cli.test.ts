/**
 * cli.test.ts — Coverage for the CLI surface (`start`, `stop`,
 * `clean_restart`, `credentials`) at the createCli factory level, with all
 * I/O injected. `credentials <persona>` finds the persona by name or key in
 * `config.json` as it stands (never the record) and hands its
 * `credentials_file` to an injected fake of the credentials-script runner;
 * the script itself, and the one real run of the CLI through it, are
 * tests/credentials-command.test.ts's.
 *
 * Persona model (b.av2 SR-8.7, SR-10.2): the CLI reads no Slack token (AC 47,
 * cli leg), takes its settings and persona set from the configuration the
 * server runs (`config.json.last-applied` beside `config.json` in the state
 * directory when it exists, otherwise `config.json`), and tears down exactly
 * that configuration's personas, addressing each instance as `cscb_<key>`.
 *
 * Isolation (b.av2 SR-13.2): every real path sits under a per-test
 * `mkdtempSync` directory removed in `afterEach`. The token variables are
 * removed for the whole file (restored afterwards), so no case or failure
 * message can see an ambient token. `start`'s daemon is always the injected
 * fake `spawnDaemon`; the only real spawns are the eight tests of the
 * `unknown subcommand` block (and its hidden-subcommand `beforeAll`) and the
 * two real-CLI tests of `credentials` (a usage error and an unknown persona,
 * neither of which reaches the script), which
 * run the CLI script through `runCli` with a built env (PATH, temp HOME, temp
 * SLACK_STATE_DIR and BUN_RUNTIME_TRANSPILER_CACHE_PATH=0). Waits in `start` and
 * `stop` (the daemon startup wait, the SIGTERM and SIGKILL polls) run on the
 * per-test fake clock; none waits in real time.
 *
 * SPDX-License-Identifier: MIT
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, spyOn, test } from 'bun:test'
import { spawnSync } from 'node:child_process'
import { EventEmitter } from 'node:events'
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative, resolve } from 'node:path'
import {
  CREDENTIALS_SCRIPT_PATH,
  CREDENTIALS_USAGE,
  DAEMON_FAILURE_LOG_LINES,
  DAEMON_STARTUP_POLL_MS,
  DAEMON_STARTUP_WAIT_MS,
  STOP_KILL_WAIT_MS,
  STOP_POLL_MS,
  StartupGateFailedError,
  createCli,
  createDirectorOps,
  type CliDeps,
  type DaemonSpawnOptions,
  type DirectorClient,
  type DirectorOps,
} from '../src/cli.ts'
import { AgentDirectorError, ErrCallTimeout, ErrSpawnNotFound } from '../src/agent-director-errors.ts'
import {
  CONFIG_NOT_REGULAR_FILE_CODE,
  DEFAULT_PERSONA_CONFIG_FS,
  loadPersonaConfig,
  prePersonaConversionMessage,
  resolveServerConfigPath,
  resolveServerStateDir,
  type PersonaConfig,
  type PersonaConfigFs,
  type PersonaConfigInput,
} from '../src/config.ts'
import { personaInstanceId, personaKey, renderPersonaRef } from '../src/persona-identity.ts'
import { readAppliedPersonaConfig } from '../src/reload.ts'
import {
  APP_TOKEN_PREFIX,
  assertNoLeak,
  BOT_TOKEN_PREFIX,
  fakeToken,
  LEAK_SENTINEL,
  REDACTED_SENTINEL_TAIL,
  sentinelInMessage,
  writeCredentialsFile,
} from './test-helpers/credentials.ts'
import { createFakeClock, type FakeClock } from './test-helpers/fake-clock.ts'
import {
  makeMultiPersonaConfig,
  makePersona,
  makePersonaConfigInput,
  writeConfigFile,
} from './test-helpers/persona-config.ts'
import { reloadTermsIn } from './test-helpers/reload-terms.ts'
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

/**
 * Every path under the per-test root (state dir and credentials files,
 * directories included), sorted, with each file's bytes in base64 and `null`
 * for a directory. Compare two snapshots with `toEqual`: a file added,
 * removed, renamed or changed by one byte fails.
 */
function snapshotTree(): Record<string, string | null> {
  const entries = (readdirSync(root, { recursive: true }) as string[]).sort()
  return Object.fromEntries(entries.map((rel) => {
    const path = join(root, rel)
    return [rel, statSync(path).isFile() ? readFileSync(path, 'base64') : null]
  }))
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/** A persona whose name differs from its key, so name- or channel-addressing fails. */
const OPS_NAME = 'Ops Bot'
const OPS_CHANNEL = 'C0TEST001'
const opsId = (): string => personaInstanceId(personaKey(OPS_NAME))

/** The last-applied record beside the per-test config.json. */
const recordPath = (): string => `${configPath}.last-applied`

/** The production `loadConfig` (b.av2 SR-8.7) over the per-test tree, with the temp root as home. */
const appliedLoader = (path: string): PersonaConfig => readAppliedPersonaConfig(path, root)

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
  /** `credentials`' loader of the configuration file; default the real `loadPersonaConfig` with the temp root as home. */
  loadConfigFile?: (path: string) => PersonaConfig
  /** The credentials script's exit status the fake runner returns; default 0. */
  credentialsScriptStatus?: number
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
  /** Each path `credentials` loaded the configuration file from. */
  configFileLoads: string[]
  /** Each credentials file the fake credentials-script runner was given. */
  credentialsRuns: string[]
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
  const configFileLoads: string[] = []
  const credentialsRuns: string[] = []
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
    loadConfigFile: (path) => {
      configFileLoads.push(path)
      events.push('loadConfigFile')
      return o.loadConfigFile ? o.loadConfigFile(path) : loadPersonaConfig(path, root)
    },
    runCredentialsScript: (credentialsFile) => {
      credentialsRuns.push(credentialsFile)
      events.push('runCredentialsScript')
      return o.credentialsScriptStatus ?? 0
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
    serverSignals, events, initClientCalls, configFileLoads, credentialsRuns,
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

  test.each([
    ['config.json only', false],
    ['config.json.last-applied only (no config.json)', true],
  ])('%s: start passes pre-flight and spawns the daemon', async (_label, recordOnly) => {
    if (recordOnly) {
      writeFileSync(recordPath(), readFileSync(configPath))
      rmSync(configPath)
    }
    const b = makeDeps()

    await expect(createCli(b.deps).start()).rejects.toBeInstanceOf(ExitError)

    expect(b.daemonSpawns).toHaveLength(1)
    expect(b.exitCodes).toEqual([0])
    expect(stderr.join('\n')).not.toContain('missing prerequisite')
    assertNoLeak({ stderr }, 'start pre-flight')
  })

  test('neither config.json nor config.json.last-applied: exit 1, one line naming both paths, nothing spawned', async () => {
    rmSync(configPath)
    const b = makeDeps()

    await expect(createCli(b.deps).start()).rejects.toBeInstanceOf(ExitError)

    expect(b.exitCodes).toEqual([1])
    expect(stderr).toEqual([
      `missing prerequisite: config.json not found at ${configPath}, and no config.json.last-applied at ${recordPath()}`,
    ])
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
    expect(props.get('loadConfig')).toBe('(path) => readAppliedPersonaConfig(path)')
    expect(code).toMatch(/import\s*\{[^}]*\breadAppliedPersonaConfig\b[^}]*\}\s*from\s*'\.\/reload\.ts'/)
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

  test('clean_restart over a real two-persona file through the production resolver (no record) tears down exactly cscb_<key> of each persona', async () => {
    writeConfigFile(stateDir, makePersonaConfigInput({ personas: [makePersona(ALPHA, root), makePersona(BETA, root)] }, root))
    const b = makeDeps({ loadConfig: appliedLoader })

    await createCli(b.deps).clean_restart()

    expect(new Set(b.statusCalls)).toEqual(new Set([personaInstanceId(personaKey(ALPHA.name)), personaInstanceId(personaKey(BETA.name))]))
    expect(b.statusCalls).toHaveLength(2)
    expect(startedServer(b)).toBe(true)
  })

  test('clean_restart given a pre-persona file (production resolver, no record) exits 1 with the conversion message, no director call, never starts', async () => {
    writePrePersonaFile()
    const b = makeDeps({ loadConfig: appliedLoader })

    await expect(createCli(b.deps).clean_restart()).rejects.toBeInstanceOf(ExitError)

    expect(b.exitCodes).toEqual([1])
    expect(stderr.join('\n')).toContain(prePersonaConversionMessage(PRE_PERSONA_KEY))
    expect([...b.statusCalls, ...b.pauseCalls, ...b.killCalls]).toEqual([])
    expect(b.spawnCalls).toEqual([]) // neither stop nor start ran
  })

  test('stop --stop-bots given a pre-persona file (production resolver, no record) logs, skips teardown and still stops the server', async () => {
    writePrePersonaFile()
    let alive = true
    const b = makeDeps({
      serverPid: 4242,
      isProcessRunning: () => { const was = alive; alive = false; return was },
      loadConfig: appliedLoader,
    })

    await expect(createCli(b.deps).stop({ stopBots: true })).rejects.toBeInstanceOf(ExitError)

    expect(b.serverSignals).toEqual(['SIGTERM'])
    expect(b.exitCodes).toEqual([0])
    expect([...b.statusCalls, ...b.pauseCalls, ...b.killCalls]).toEqual([])
    expect(stderr.join('\n')).toContain('could not load config — skipping bot teardown')
  })
})

// ---------------------------------------------------------------------------
// stop — the SIGTERM and SIGKILL waits run on the injected clock
// ---------------------------------------------------------------------------

describe('stop — waits on the injected clock', () => {
  /** Record the fake-clock time of every server signal and the length of every sleep. */
  function timed(b: Bundle): { signalAt: Array<[string, number]>; sleeps: number[] } {
    const signalAt: Array<[string, number]> = []
    const sleeps: number[] = []
    const { kill, sleep } = b.deps
    b.deps.kill = (pid, signal) => {
      signalAt.push([String(signal), b.clock.now()])
      kill(pid, signal)
    }
    b.deps.sleep = (ms) => {
      sleeps.push(ms)
      return sleep(ms)
    }
    return { signalAt, sleeps }
  }

  // A 5 s stop_timeout here would outlast the test's own 5 s timeout if the
  // waits were real.
  test('a server that ignores SIGTERM gets SIGKILL once stop_timeout has passed on the fake clock, then exits 0 at the next poll after it dies', async () => {
    const b: Bundle = makeDeps({
      serverPid: 4242,
      config: opsConfig({ stop_timeout: 5 }),
      isProcessRunning: () => !b.serverSignals.includes('SIGKILL'),
    })
    const t = timed(b)

    await expect(createCli(b.deps).stop()).rejects.toBeInstanceOf(ExitError)

    expect(t.signalAt.map(([s]) => s)).toEqual(['SIGTERM', 'SIGKILL'])
    expect(t.signalAt[0]![1]).toBe(0)
    expect(t.signalAt[1]![1]).toBeGreaterThanOrEqual(5_000)
    expect(t.signalAt[1]![1]).toBeLessThan(5_000 + STOP_POLL_MS)
    expect(b.exitCodes).toEqual([0])
    expect(b.exitTimes[0]).toBe(t.signalAt[1]![1] + STOP_POLL_MS)
    expect(new Set(t.sleeps)).toEqual(new Set([STOP_POLL_MS]))
    expect(stderr).toContain('[slack] Warning: server did not stop within 5s after SIGTERM — sending SIGKILL.')
    expect(stderr).toContain('[slack] Server killed.')
  })

  test(`a server that survives SIGKILL: exit 1 once STOP_KILL_WAIT_MS (${STOP_KILL_WAIT_MS} ms) has passed on the fake clock`, async () => {
    const b = makeDeps({ serverPid: 4242, config: opsConfig({ stop_timeout: 5 }), isProcessRunning: () => true })
    const t = timed(b)

    await expect(createCli(b.deps).stop()).rejects.toBeInstanceOf(ExitError)

    expect(t.signalAt.map(([s]) => s)).toEqual(['SIGTERM', 'SIGKILL'])
    const killAt = t.signalAt[1]![1]
    expect(b.exitCodes).toEqual([1])
    expect(b.exitTimes[0]).toBeGreaterThanOrEqual(killAt + STOP_KILL_WAIT_MS)
    expect(b.exitTimes[0]).toBeLessThan(killAt + STOP_KILL_WAIT_MS + STOP_POLL_MS)
    expect(new Set(t.sleeps)).toEqual(new Set([STOP_POLL_MS]))
    expect(stderr).toContain('[slack] Warning: server did not die after SIGKILL.')
  })

  test('a server that exits after SIGTERM is seen at the first poll, STOP_POLL_MS after it', async () => {
    let alive = true
    const b = makeDeps({ serverPid: 4242, config: opsConfig({ stop_timeout: 5 }), isProcessRunning: () => { const was = alive; alive = false; return was } })
    const t = timed(b)

    await expect(createCli(b.deps).stop()).rejects.toBeInstanceOf(ExitError)

    expect(t.signalAt).toEqual([['SIGTERM', 0]])
    expect(b.exitCodes).toEqual([0])
    expect(b.exitTimes).toEqual([STOP_POLL_MS])
    expect(stderr).toContain('[slack] Server stopped.')
  })
})

// ---------------------------------------------------------------------------
// The last-applied record (b.av2 SR-8.7): settings and persona set come from
// config.json.last-applied when it exists, from config.json when it does not.
// Every case goes through the production resolver over real files in the
// per-test tree.
// ---------------------------------------------------------------------------

describe('last-applied record (SR-8.7)', () => {
  /** Only in the edited config.json: a record-sourced teardown never addresses it. */
  const GAMMA = { name: 'Gamma Bot', channels: [{ id: 'C0GAMMA01', delivery: 'all' as const }], permission_prompts: 'C0GAMMA01' }
  const alphaId = (): string => personaInstanceId(personaKey(ALPHA.name))
  const betaId = (): string => personaInstanceId(personaKey(BETA.name))
  const gammaId = (): string => personaInstanceId(personaKey(GAMMA.name))

  /**
   * The applied configuration: Alpha and Beta with the short timeouts. With
   * stop_timeout 0 a live server gets SIGKILL straight after SIGTERM; with
   * exit_timeout 0 a paused persona is killed at once. Reading the longer
   * values of EDITED instead shows up as no SIGKILL and no kill.
   */
  const APPLIED = (): PersonaConfigInput =>
    makePersonaConfigInput({ personas: [makePersona(ALPHA, root), makePersona(BETA, root)], stop_timeout: 0, exit_timeout: 0 }, root)
  /** The operator's edit, not yet applied: Beta removed, Gamma added, longer timeouts. */
  const EDITED = (): PersonaConfigInput =>
    makePersonaConfigInput({ personas: [makePersona(ALPHA, root), makePersona(GAMMA, root)], stop_timeout: 5, exit_timeout: 5 }, root)

  /**
   * `record`: config.json.last-applied holds APPLIED and config.json holds
   * EDITED. `config`: no record, config.json holds APPLIED. Each persona's
   * credentials file holds fake tokens, so a CLI that read one and printed it
   * fails `assertNoLeak`.
   */
  function writeSource(source: 'record' | 'config'): void {
    for (const p of [ALPHA, BETA, GAMMA]) writeCredentialsFile(join(root, 'personas', personaKey(p.name)))
    if (source === 'record') {
      writeFileSync(recordPath(), JSON.stringify(APPLIED(), null, 2))
      writeConfigFile(stateDir, EDITED())
    } else {
      writeConfigFile(stateDir, APPLIED())
    }
  }

  /**
   * A server that is up at `stop`'s liveness check and gone by the first poll,
   * STOP_POLL_MS of fake-clock time after SIGTERM: stop_timeout 0 still sends
   * SIGKILL (no poll before the deadline), any longer stop_timeout does not.
   */
  function goneAfterFirstCheck(): () => boolean {
    let calls = 0
    return () => ++calls === 1
  }

  /** Each instance's first status is `waiting` (so it is paused), every later one `ended`. */
  function waitingThenEnded(): (id: string) => Promise<{ state: string }> {
    const seen = new Set<string>()
    return async (id) => {
      const first = !seen.has(id)
      seen.add(id)
      return { state: first ? 'waiting' : 'ended' }
    }
  }

  const runStopBots = (b: Bundle): Promise<void> =>
    createCli(b.deps).stop({ stopBots: true }).catch((e) => { if (!(e instanceof ExitError)) throw e })
  const runCleanRestart = (b: Bundle): Promise<void> => createCli(b.deps).clean_restart()

  const SOURCES = [
    ['record present: the record', 'record'],
    ['no record: config.json', 'config'],
  ] as const

  test.each(SOURCES)('stop: stop_timeout comes from %s (0 → SIGKILL right after SIGTERM)', async (_label, source) => {
    writeSource(source)
    const b = makeDeps({ serverPid: 4242, isProcessRunning: goneAfterFirstCheck(), loadConfig: appliedLoader })

    await expect(createCli(b.deps).stop()).rejects.toBeInstanceOf(ExitError)

    expect(b.serverSignals).toEqual(['SIGTERM', 'SIGKILL'])
    expect(b.exitCodes).toEqual([0])
    assertNoLeak({ stderr, exitCodes: b.exitCodes }, `stop (${source})`)
  })

  test.each([
    ...SOURCES.map(([label, source]) => ['clean_restart', label, source, runCleanRestart] as const),
    ...SOURCES.map(([label, source]) => ['stop --stop-bots', label, source, runStopBots] as const),
  ])('%s: persona set and exit_timeout come from %s — exactly cscb_<key> of Alpha and Beta, each paused then killed at once, never Gamma', async (name, _label, source, run) => {
    writeSource(source)
    const b = makeDeps({
      serverPid: 4242,
      isProcessRunning: goneAfterFirstCheck(),
      loadConfig: appliedLoader,
      directorStatus: waitingThenEnded(),
    })

    await run(b)

    const ids = [alphaId(), betaId()].sort()
    // exit_timeout 0: no status poll after the pause, straight to kill.
    expect([...b.statusCalls].sort()).toEqual(ids)
    expect([...b.pauseCalls].sort()).toEqual(ids)
    expect([...b.killCalls].sort()).toEqual(ids)
    expect([...b.statusCalls, ...b.pauseCalls, ...b.killCalls]).not.toContain(gammaId())
    if (name === 'stop --stop-bots') {
      expect(b.serverSignals).toEqual(['SIGTERM', 'SIGKILL'])
      expect(b.exitCodes).toEqual([0])
    } else {
      expect(b.exitCodes).toEqual([])
      expect(startedServer(b)).toBe(true)
    }
    assertNoLeak({ stderr, exitCodes: b.exitCodes }, `${name} (${source})`)
  })

  const runStop = (b: Bundle): Promise<void> =>
    createCli(b.deps).stop().catch((e) => { if (!(e instanceof ExitError)) throw e })

  test.each([
    ...SOURCES.map(([label, source]) => ['clean_restart', label, source, runCleanRestart] as const),
    ...SOURCES.map(([label, source]) => ['stop --stop-bots', label, source, runStopBots] as const),
    ...SOURCES.map(([label, source]) => ['stop', label, source, runStop] as const),
  ])('%s never writes a reload file (%s): every file is byte-for-byte unchanged and none is added or removed', async (name, _label, source, run) => {
    writeSource(source)
    const b = makeDeps({
      serverPid: 4242,
      isProcessRunning: goneAfterFirstCheck(),
      loadConfig: appliedLoader,
      directorStatus: waitingThenEnded(),
    })
    const before = snapshotTree() // after makeDeps, so the PID file is in it

    await run(b)

    // Precondition: the run read the intended source and tore down its set.
    if (name !== 'stop') expect([...b.killCalls].sort()).toEqual([alphaId(), betaId()].sort())
    expect(existsSync(recordPath())).toBe(source === 'record')
    expect(snapshotTree()).toEqual(before)
    assertNoLeak({ stderr, exitCodes: b.exitCodes }, `${name} (${source}, no writes)`)
  })

  test.each(SOURCES)('readAppliedPersonaConfig expands every ~ under the injected home: a "~/…" config path, and "~/…" persona paths in %s', (_label, source) => {
    const tildePaths = (name: string) => ({
      credentials_file: `~/personas/${personaKey(name)}/credentials.json`,
      working_directory: `~/personas/${personaKey(name)}/work`,
    })
    const applied = makePersonaConfigInput(
      {
        personas: [makePersona({ ...ALPHA, ...tildePaths(ALPHA.name) }, root), makePersona({ ...BETA, ...tildePaths(BETA.name) }, root)],
        stop_timeout: 0,
        exit_timeout: 0,
      },
      root,
    )
    if (source === 'record') {
      writeFileSync(recordPath(), JSON.stringify(applied, null, 2))
      writeConfigFile(stateDir, EDITED())
    } else {
      writeConfigFile(stateDir, applied)
    }
    // Precondition: the injected home is not the process's own, so a `~`
    // expanded under the OS home finds no file (or other paths).
    expect(resolve(process.env['HOME'] ?? '')).not.toBe(resolve(root))

    const config = readAppliedPersonaConfig(`~/${relative(root, configPath)}`, root)

    expect(config.stop_timeout).toBe(0) // the applied file, not EDITED's 5
    expect(config.personas.map((p) => [p.key, p.credentials_file, p.working_directory])).toEqual(
      [ALPHA.name, BETA.name].map((n) => [
        personaKey(n),
        join(root, 'personas', personaKey(n), 'credentials.json'),
        join(root, 'personas', personaKey(n), 'work'),
      ]),
    )
  })

  test.each([
    ['clean_restart', runCleanRestart],
    ['stop --stop-bots', runStopBots],
  ] as const)('%s: a record whose two personas share a working directory by real path is still read (record mode); both instances are torn down', async (name, run) => {
    const work = join(root, 'shared-work')
    mkdirSync(work)
    const alias = join(root, 'shared-work-link')
    symlinkSync(work, alias)
    writeFileSync(
      recordPath(),
      JSON.stringify(
        makePersonaConfigInput(
          {
            personas: [makePersona({ ...ALPHA, working_directory: work }, root), makePersona({ ...BETA, working_directory: alias }, root)],
            stop_timeout: 0,
            exit_timeout: 0,
          },
          root,
        ),
      ),
    )
    const b = makeDeps({
      serverPid: 4242,
      isProcessRunning: goneAfterFirstCheck(),
      loadConfig: appliedLoader,
      directorStatus: waitingThenEnded(),
    })

    await run(b)

    const ids = [alphaId(), betaId()].sort()
    expect([...b.pauseCalls].sort()).toEqual(ids)
    expect([...b.killCalls].sort()).toEqual(ids)
    expect(stderr.join('\n')).not.toContain('could not load config')
    expect(b.exitCodes).not.toContain(1)
    assertNoLeak({ stderr, exitCodes: b.exitCodes }, name)
  })

  /**
   * A record that is not JSON, holding a fake token, beside a valid
   * config.json (EDITED). The parse error must name the record, carry the
   * deletion hint and quote none of the record's content.
   */
  function writeMalformedRecord(): void {
    writeConfigFile(stateDir, EDITED())
    writeFileSync(recordPath(), `{"personas": [{"name": "${fakeToken(BOT_TOKEN_PREFIX, 'record')}"`)
  }
  const deletionHint = (): string => `Deleting the last-applied record "${recordPath()}"`
  /** `stop`'s one line for a stop_timeout read failure, before the loader's message. */
  const STOP_LOAD_FAILURE_PREFIX = '[slack] stop: could not load the applied configuration — using the default 30s stop_timeout: '

  test('clean_restart with a malformed record: exit 1 naming the record with the deletion hint, no teardown, no fallback to config.json, never starts', async () => {
    writeMalformedRecord()
    const b = makeDeps({ loadConfig: appliedLoader, directorStatus: waitingThenEnded() })

    await expect(createCli(b.deps).clean_restart()).rejects.toBeInstanceOf(ExitError)

    expect(b.exitCodes).toEqual([1])
    expect(stderr).toHaveLength(1)
    expect(stderr[0]!.startsWith('[slack] clean_restart: failed to load config:')).toBe(true)
    expect(stderr[0]).toContain(deletionHint())
    expect([...b.statusCalls, ...b.pauseCalls, ...b.killCalls]).toEqual([])
    expect(b.spawnCalls).toEqual([])
    assertNoLeak({ stderr, exitCodes: b.exitCodes }, 'clean_restart (malformed record)')
  })

  test('stop --stop-bots with a malformed record: logs the record with the deletion hint, skips teardown (no fallback to config.json), still stops the server', async () => {
    writeMalformedRecord()
    const b = makeDeps({
      serverPid: 4242,
      isProcessRunning: goneAfterFirstCheck(),
      loadConfig: appliedLoader,
      directorStatus: waitingThenEnded(),
    })

    await expect(createCli(b.deps).stop({ stopBots: true })).rejects.toBeInstanceOf(ExitError)

    expect(b.exitCodes).toEqual([0])
    expect(b.serverSignals).toEqual(['SIGTERM'])
    const skip = stderr.filter((l) => l.startsWith('[slack] stop --stop-bots: could not load config — skipping bot teardown:'))
    expect(skip).toHaveLength(1)
    expect(skip[0]).toContain(deletionHint())
    // The server stop's own read failed too, and says so once, with the same hint.
    const stopLine = stderr.filter((l) => l.startsWith(STOP_LOAD_FAILURE_PREFIX))
    expect(stopLine).toHaveLength(1)
    expect(stopLine[0]).toContain(deletionHint())
    expect([...b.statusCalls, ...b.pauseCalls, ...b.killCalls]).toEqual([])
    assertNoLeak({ stderr, exitCodes: b.exitCodes }, 'stop --stop-bots (malformed record)')
  })

  // -------------------------------------------------------------------------
  // A record, or config.json without one, that is not a regular file: refused
  // unread (`readPersonaConfigBytes`), so no CLI command can hang on a FIFO or
  // a device. The file the loader would read is left a valid regular file for
  // the FIFO kind, so a loader that bypassed the seam would read it and pass.
  // -------------------------------------------------------------------------

  const NON_REGULAR_KINDS = [
    ['a FIFO (injected fstatFile: neither a file nor a directory)', 'fifo', CONFIG_NOT_REGULAR_FILE_CODE],
    ['a directory (real)', 'directory', 'EISDIR'],
  ] as const
  const NON_REGULAR_CASES = SOURCES.flatMap(([label, source]) =>
    NON_REGULAR_KINDS.map(([kindLabel, kind, code]) => [label, kindLabel, source, kind, code] as const),
  )
  /** Each case is bounded well below Bun's default, so a hang fails fast. */
  const NON_REGULAR_TIMEOUT_MS = 2_000

  interface NonRegularFile {
    loader: (path: string) => PersonaConfig
    /** The start's wording for the refused file (with the deletion hint for the record). */
    cause: string
    /** For the FIFO kind: the target was opened, nothing was read and every descriptor was closed. */
    assertUnreadAndClosed(): void
  }

  function makeNonRegular(source: 'record' | 'config', kind: 'fifo' | 'directory', code: string): NonRegularFile {
    writeSource(source)
    const target = source === 'record' ? recordPath() : configPath
    const cause =
      source === 'record'
        ? `The last-applied record "${recordPath()}" cannot be read (${code}). ${deletionHint()} makes the next start ` +
          `apply the configuration file "${configPath}" as it stands.`
        : `The configuration file "${configPath}" cannot be read (${code}). The server requires the configuration file to start.`
    if (kind === 'directory') {
      rmSync(target)
      mkdirSync(target)
      return { loader: appliedLoader, cause, assertUnreadAndClosed: () => {} }
    }
    const open = new Map<number, string>()
    const reads: string[] = []
    let targetOpens = 0
    const fs: Partial<PersonaConfigFs> = {
      openFile: (p) => {
        const fd = DEFAULT_PERSONA_CONFIG_FS.openFile(p)
        open.set(fd, p)
        if (p === target) targetOpens++
        return fd
      },
      fstatFile: (fd) =>
        open.get(fd) === target ? { isFile: () => false, isDirectory: () => false } : DEFAULT_PERSONA_CONFIG_FS.fstatFile(fd),
      readFileFd: (fd) => {
        reads.push(open.get(fd) ?? `fd ${fd}`)
        return DEFAULT_PERSONA_CONFIG_FS.readFileFd(fd)
      },
      closeFile: (fd) => {
        open.delete(fd)
        DEFAULT_PERSONA_CONFIG_FS.closeFile(fd)
      },
    }
    return {
      loader: (p) => readAppliedPersonaConfig(p, root, fs),
      cause,
      assertUnreadAndClosed: () => {
        expect(targetOpens).toBeGreaterThan(0)
        expect(reads).toEqual([]) // neither the target nor, for the record, config.json
        expect([...open.values()]).toEqual([])
      },
    }
  }

  test.each(NON_REGULAR_CASES)(
    'clean_restart (%s) where that file is %s: exit 1 at once with "cannot be read" wording, no teardown, no fallback, never starts',
    async (_label, _kindLabel, source, kind, code) => {
      const f = makeNonRegular(source, kind, code)
      const b = makeDeps({ loadConfig: f.loader, directorStatus: waitingThenEnded() })

      await expect(createCli(b.deps).clean_restart()).rejects.toBeInstanceOf(ExitError)

      expect(b.exitCodes).toEqual([1])
      expect(stderr).toHaveLength(1)
      expect(stderr[0]!.startsWith('[slack] clean_restart: failed to load config:')).toBe(true)
      expect(stderr[0]).toContain(f.cause)
      expect([...b.statusCalls, ...b.pauseCalls, ...b.killCalls]).toEqual([])
      expect(b.spawnCalls).toEqual([])
      expect(b.clock.now()).toBe(0)
      f.assertUnreadAndClosed()
      assertNoLeak({ stderr, exitCodes: b.exitCodes }, `clean_restart (${source}, ${kind})`)
    },
    NON_REGULAR_TIMEOUT_MS,
  )

  test.each(NON_REGULAR_CASES)(
    'stop --stop-bots (%s) where that file is %s: the server still stops (30 s default, so no SIGKILL), the skip line carries the "cannot be read" wording, no teardown',
    async (_label, _kindLabel, source, kind, code) => {
      const f = makeNonRegular(source, kind, code)
      const b = makeDeps({
        serverPid: 4242,
        isProcessRunning: goneAfterFirstCheck(),
        loadConfig: f.loader,
        directorStatus: waitingThenEnded(),
      })

      await expect(createCli(b.deps).stop({ stopBots: true })).rejects.toBeInstanceOf(ExitError)

      expect(b.exitCodes).toEqual([0])
      // The applied file's stop_timeout 0 would have sent SIGKILL; it was not read.
      expect(b.serverSignals).toEqual(['SIGTERM'])
      const skip = stderr.filter((l) => l.startsWith('[slack] stop --stop-bots: could not load config — skipping bot teardown:'))
      expect(skip).toHaveLength(1)
      expect(skip[0]).toContain(f.cause)
      expect(stderr.filter((l) => l.startsWith(STOP_LOAD_FAILURE_PREFIX))).toEqual([`${STOP_LOAD_FAILURE_PREFIX}${f.cause}`])
      expect([...b.statusCalls, ...b.pauseCalls, ...b.killCalls]).toEqual([])
      f.assertUnreadAndClosed()
      assertNoLeak({ stderr, exitCodes: b.exitCodes }, `stop --stop-bots (${source}, ${kind})`)
    },
    NON_REGULAR_TIMEOUT_MS,
  )

  // Plain `stop` reports the load failure in exactly one line, first, with the
  // loader's message (the record's deletion hint, or the config wording), then
  // falls back to the 30 s default stop_timeout and still stops the server.
  test.each(NON_REGULAR_CASES)(
    'stop (%s) where that file is %s: logs one "could not load" line with the "cannot be read" wording, then uses the 30 s default stop_timeout (fake clock) and still stops a server that ignores SIGTERM',
    async (_label, _kindLabel, source, kind, code) => {
      const f = makeNonRegular(source, kind, code)
      const b: Bundle = makeDeps({
        serverPid: 4242,
        isProcessRunning: () => !b.serverSignals.includes('SIGKILL'),
        loadConfig: f.loader,
      })

      await expect(createCli(b.deps).stop()).rejects.toBeInstanceOf(ExitError)

      expect(b.serverSignals).toEqual(['SIGTERM', 'SIGKILL'])
      expect(b.exitCodes).toEqual([0])
      expect(b.exitTimes).toEqual([30_000 + STOP_POLL_MS])
      expect(stderr).toEqual([
        `${STOP_LOAD_FAILURE_PREFIX}${f.cause}`,
        '[slack] Warning: server did not stop within 30s after SIGTERM — sending SIGKILL.',
        '[slack] Server killed.',
      ])
      f.assertUnreadAndClosed()
      assertNoLeak({ stderr, exitCodes: b.exitCodes }, `stop (${source}, ${kind})`)
    },
    NON_REGULAR_TIMEOUT_MS,
  )
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

  // AC 20 (b.av2 SR-10.3): the pause-escalation, timeout-path "kill failed"
  // and aggregate teardown lines log each error's description (type, a base
  // agent-director error's errName, safe code, message through
  // `redactSlackLogText`, frames), never the error itself. The errors carry
  // fake tokens (in a message, with a URL); the raw console.error arguments
  // are checked. With a successful pause and
  // `exit_timeout: 0` the poll loop never runs, so the timeout path's kill is
  // reached at once.
  test('AC 20: a pause and then its escalation kill failing with errors carrying fake tokens — the pause and teardown lines name each error with its message redacted; clean_restart exits 1; nothing logged leaks', async () => {
    const b = makeDeps({
      directorStatus: async () => ({ state: 'waiting' }),
      directorPause: async () => {
        throw Object.assign(new Error(`pause refused (${sentinelInMessage('pause')})`), { code: 'ECONNRESET', note: LEAK_SENTINEL })
      },
      directorKill: async () => {
        throw new AgentDirectorError('kill', 'ErrKillBroken', `kill refused (${sentinelInMessage('kill', APP_TOKEN_PREFIX)})`)
      },
    })

    await expect(createCli(b.deps).clean_restart()).rejects.toBeInstanceOf(ExitError)

    const ref = renderPersonaRef(OPS_NAME, personaKey(OPS_NAME))
    const line = (fragment: string): string[] => stderr.filter((l) => l.includes(fragment))
    expect(line('pause failed').map((l) => l.split(' at ')[0])).toEqual([
      `[slack] teardownBots: pause failed for persona ${ref} — escalating to kill: Error code=ECONNRESET message="pause refused (${REDACTED_SENTINEL_TAIL})"`,
    ])
    expect(line('error during teardown').map((l) => l.split(' at ')[0])).toEqual([
      `[slack] teardownBots: agent-director error during teardown: AgentDirectorError errName=ErrKillBroken message="ErrKillBroken: kill refused (${REDACTED_SENTINEL_TAIL})"`,
    ])
    expect(b.exitCodes).toEqual([1])
    expect(startedServer(b)).toBe(false)
    assertNoLeak({ consoleErrorArgs: errorSpy.mock.calls, stderr })
  })

  test('AC 20: a timeout-path kill failing with an error carrying fake tokens — the "kill failed" and teardown lines name the error with its message redacted; clean_restart exits 1; nothing logged leaks', async () => {
    const b = makeDeps({
      config: opsConfig({ exit_timeout: 0 }),
      directorStatus: async () => ({ state: 'waiting' }),
      directorPause: async () => { /* pause succeeds */ },
      directorKill: async () => {
        throw Object.assign(new Error(`kill refused (${sentinelInMessage('kill')})`), { code: 'ECONNRESET', note: LEAK_SENTINEL })
      },
    })

    await expect(createCli(b.deps).clean_restart()).rejects.toBeInstanceOf(ExitError)

    const ref = renderPersonaRef(OPS_NAME, personaKey(OPS_NAME))
    const line = (fragment: string): string[] => stderr.filter((l) => l.includes(fragment))
    expect(b.pauseCalls).toEqual([opsId()])
    expect(b.killCalls).toEqual([opsId()])
    expect(line('kill failed').map((l) => l.split(' at ')[0])).toEqual([
      `[slack] teardownBots: kill failed for persona ${ref}: Error code=ECONNRESET message="kill refused (${REDACTED_SENTINEL_TAIL})"`,
    ])
    expect(line('error during teardown').map((l) => l.split(' at ')[0])).toEqual([
      `[slack] teardownBots: agent-director error during teardown: Error code=ECONNRESET message="kill refused (${REDACTED_SENTINEL_TAIL})"`,
    ])
    expect(b.exitCodes).toEqual([1])
    expect(startedServer(b)).toBe(false)
    assertNoLeak({ consoleErrorArgs: errorSpy.mock.calls, stderr })
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
// stop --stop-bots failure lines (b.av2 SR-10.3, AC 20): a failure CSCB
// authored prints its message; any other thrown value only its description
// ---------------------------------------------------------------------------

describe('stop --stop-bots failure lines (AC 20)', () => {
  /** The stderr lines holding `fragment`, each cut before its first stack frame. */
  const linesWith = (fragment: string): string[] => stderr.filter((l) => l.includes(fragment)).map((l) => l.split(' at ')[0]!)

  test('a startup gate failure (StartupGateFailedError) prints the gate\'s class label and message on the initialization-failed line; exit 1, no director verb', async () => {
    const detail = 'agent-director 0.9.0 is older than the required 0.10.0; run `bun add agent-director@^0.10.0`'
    const b = makeStopDeps({
      initClient: async () => { throw new StartupGateFailedError('ad-version-too-old', detail) },
      directorStatus: async () => ({ state: 'waiting' }),
    })

    await expect(createCli(b.deps).stop({ stopBots: true })).rejects.toBeInstanceOf(ExitError)

    expect(stderr.filter((l) => l.includes('initialization failed'))).toEqual([
      `[slack] stop --stop-bots: agent-director initialization failed: agent-director startup gate failed (ad-version-too-old): ${detail}`,
    ])
    expect(b.exitCodes).toEqual([1])
    expect(b.statusCalls).toEqual([])
  })

  test('an incomplete teardown (TeardownIncompleteError) prints its count and retry advice on the teardown-failed line; the underlying error, carrying fake tokens, is only described, its message redacted; exit 1; nothing logged leaks', async () => {
    const b = makeStopDeps({
      directorStatus: async () => {
        throw Object.assign(new Error(`status refused (${sentinelInMessage('status')})`), { code: 'ECONNREFUSED', note: LEAK_SENTINEL })
      },
    })

    await expect(createCli(b.deps).stop({ stopBots: true })).rejects.toBeInstanceOf(ExitError)

    expect(stderr.filter((l) => l.includes('bot teardown failed'))).toEqual([
      '[slack] stop --stop-bots: bot teardown failed: teardownBots: agent-director error — teardown incomplete for 1 persona(s); ' +
        'other personas may already have been paused or killed; rows are never deleted, safe to retry',
    ])
    expect(linesWith('error during teardown')).toEqual([
      `[slack] teardownBots: agent-director error during teardown: Error code=ECONNREFUSED message="status refused (${REDACTED_SENTINEL_TAIL})"`,
    ])
    expect(b.exitCodes).toEqual([1])
    assertNoLeak({ consoleErrorArgs: errorSpy.mock.calls, stderr })
  })

  test.each<[string, () => unknown, string]>([
    [
      'a plain Error with a safe code',
      () => Object.assign(new Error(`gate (${sentinelInMessage('msg')})`), { code: 'EACCES', note: LEAK_SENTINEL }),
      `Error code=EACCES message="gate (${REDACTED_SENTINEL_TAIL})"`,
    ],
    [
      'a base AgentDirectorError with a safe errName',
      () => new AgentDirectorError('init', 'ErrGateBroken', `refused (${sentinelInMessage('desc', APP_TOKEN_PREFIX)})`),
      `AgentDirectorError errName=ErrGateBroken message="ErrGateBroken: refused (${REDACTED_SENTINEL_TAIL})"`,
    ],
    // The token-shaped errName is left out of the errName= field and redacted where the message quotes it.
    [
      'a base AgentDirectorError whose errName is token-shaped',
      () => new AgentDirectorError('init', fakeToken(BOT_TOKEN_PREFIX, 'errname'), `refused (${sentinelInMessage('desc', APP_TOKEN_PREFIX)})`),
      `AgentDirectorError message="<redacted-token> refused (${REDACTED_SENTINEL_TAIL})"`,
    ],
    ['a rejected string', () => `down (${sentinelInMessage('str')})`, `string message="down (${REDACTED_SENTINEL_TAIL})"`],
  ])('initClient throwing %s carrying fake tokens → the initialization-failed line names it by description, its message redacted; exit 1; nothing logged leaks', async (_label, makeErr, shown) => {
    const b = makeStopDeps({
      initClient: async () => { throw makeErr() },
      directorStatus: async () => ({ state: 'waiting' }),
    })

    await expect(createCli(b.deps).stop({ stopBots: true })).rejects.toBeInstanceOf(ExitError)

    expect(linesWith('initialization failed')).toEqual([`[slack] stop --stop-bots: agent-director initialization failed: ${shown}`])
    expect(b.exitCodes).toEqual([1])
    expect(b.statusCalls).toEqual([])
    assertNoLeak({ consoleErrorArgs: errorSpy.mock.calls, stderr })
  })
})

// ---------------------------------------------------------------------------
// credentials <persona> — the setup wizard's credentials command (b.av2 SR-12,
// SR-1.4 part). The script it runs is tests/credentials-command.test.ts's.
// ---------------------------------------------------------------------------

describe('credentials <persona>', () => {
  const opsKey = (): string => personaKey(OPS_NAME)
  const opsCredentials = (): string => join(root, 'personas', opsKey(), 'credentials.json')
  const handedOver = (name: string, path: string): string => `Credentials file of persona ${renderPersonaRef(name)}: ${path}`

  /** Nothing of the server's side was touched: no record or applied-config read, no daemon, no spawn, no agent-director. */
  function expectNoServerSide(b: Bundle): void {
    expect(b.loadPaths).toEqual([])
    expect(b.daemonSpawns).toEqual([])
    expect(b.spawnCalls).toEqual([])
    expect(b.initClientCalls).toEqual([])
    expect([b.statusCalls, b.pauseCalls, b.killCalls]).toEqual([[], [], []])
    expect(b.serverSignals).toEqual([])
  }

  test.each<[string, () => string]>([
    ['its name', () => OPS_NAME],
    ['its key', opsKey],
  ])('found by %s in config.json: names the persona and its file, runs the script for that credentials_file and exits 0 with it', async (_label, target) => {
    const b = makeDeps()

    await expect(createCli(b.deps).credentials([target()])).rejects.toBeInstanceOf(ExitError)

    expect(b.configFileLoads).toEqual([configPath])
    expect(b.credentialsRuns).toEqual([opsCredentials()])
    expect(b.events).toEqual(['loadConfigFile', 'runCredentialsScript'])
    expect(stderr).toEqual([handedOver(OPS_NAME, opsCredentials())])
    expect(b.exitCodes).toEqual([0])
    expectNoServerSide(b)
    assertNoLeak({ stderr })
  })

  test.each([1, 2, 130])("the script's exit status %d is the command's", async (status) => {
    const b = makeDeps({ credentialsScriptStatus: status })

    await expect(createCli(b.deps).credentials([OPS_NAME])).rejects.toBeInstanceOf(ExitError)

    expect(b.credentialsRuns).toEqual([opsCredentials()])
    expect(b.exitCodes).toEqual([status])
  })

  test('a ~/ credentials_file reaches the script expanded under the home directory, as the loader expands it', async () => {
    writeConfigFile(stateDir, makePersonaConfigInput({ personas: [makePersona({ name: OPS_NAME, credentials_file: '~/.config/cscb/ops.json' }, root)] }, root))
    const b = makeDeps()

    await expect(createCli(b.deps).credentials([OPS_NAME])).rejects.toBeInstanceOf(ExitError)

    expect(b.credentialsRuns).toEqual([join(root, '.config', 'cscb', 'ops.json')])
    expect(b.exitCodes).toEqual([0])
  })

  test('the persona comes from config.json as it stands, never the last-applied record: one declared but not yet confirmed is found', async () => {
    // The record holds only Ops Bot; config.json adds "newbie", not yet confirmed.
    writeFileSync(recordPath(), readFileSync(configPath))
    const newbie = makePersona({ name: 'newbie', channels: [{ id: 'C0NEW0001', delivery: 'all' }], permission_prompts: 'C0NEW0001' }, root)
    writeConfigFile(stateDir, makePersonaConfigInput({ personas: [makePersona({ name: OPS_NAME }, root), newbie] }, root))
    const b = makeDeps()

    await expect(createCli(b.deps).credentials(['newbie'])).rejects.toBeInstanceOf(ExitError)

    expect(b.configFileLoads).toEqual([configPath])
    expect(b.credentialsRuns).toEqual([join(root, 'personas', 'newbie', 'credentials.json')])
    expect(b.exitCodes).toEqual([0])
    expectNoServerSide(b)
  })

  test.each<[string, string[]]>([
    ['no persona', []],
    ['two personas', [OPS_NAME, 'another']],
    ['an empty persona', ['']],
  ])('%s: exit 2 with the usage line; nothing loaded or run', async (_label, args) => {
    const b = makeDeps()

    await expect(createCli(b.deps).credentials(args)).rejects.toBeInstanceOf(ExitError)

    expect(stderr).toEqual([CREDENTIALS_USAGE])
    expect(b.exitCodes).toEqual([2])
    expect(b.configFileLoads).toEqual([])
    expect(b.credentialsRuns).toEqual([])
    expectNoServerSide(b)
  })

  test('no persona has that name or key: exit 1, the declared personas listed, the argument never repeated (a token typed there stays off the screen), nothing run', async () => {
    const b = makeDeps()

    await expect(createCli(b.deps).credentials([fakeToken(BOT_TOKEN_PREFIX)])).rejects.toBeInstanceOf(ExitError)

    expect(stderr).toEqual([
      `credentials: no persona in ${configPath} has that name or key; declare it there first (declared: ${renderPersonaRef(OPS_NAME)})`,
    ])
    expect(b.exitCodes).toEqual([1])
    expect(b.credentialsRuns).toEqual([])
    assertNoLeak({ stderr })
  })

  test('with no persona declared, the line says declared: none', async () => {
    writeConfigFile(stateDir, { personas: [] })
    const b = makeDeps()

    await expect(createCli(b.deps).credentials(['anyone'])).rejects.toBeInstanceOf(ExitError)

    expect(stderr).toEqual([`credentials: no persona in ${configPath} has that name or key; declare it there first (declared: none)`])
    expect(b.exitCodes).toEqual([1])
  })

  test.each<[string, () => void]>([
    ['config.json missing', () => rmSync(configPath)],
    ['config.json malformed', () => writeFileSync(configPath, '{ "personas": [')],
    ['a pre-persona config.json', () => writeConfigFile(stateDir, { default_route: { cwd: join(root, 'work') } })],
    [
      'a token pasted into config.json under bot_token',
      () => writeConfigFile(stateDir, { personas: [{ ...makePersona({ name: OPS_NAME }, root), bot_token: fakeToken(BOT_TOKEN_PREFIX) }] }),
    ],
  ])("%s: exit 1 with the loader's error naming the file, no token shown, nothing run", async (_label, prepare) => {
    prepare()
    const b = makeDeps()

    await expect(createCli(b.deps).credentials([OPS_NAME])).rejects.toBeInstanceOf(ExitError)

    expect(stderr).toHaveLength(1)
    expect(stderr[0]).toStartWith(`credentials: cannot read the personas in ${configPath}: loadPersonaConfig: `)
    expect(stderr[0]).toContain(JSON.stringify(configPath))
    expect(b.exitCodes).toEqual([1])
    expect(b.credentialsRuns).toEqual([])
    expectNoServerSide(b)
    assertNoLeak({ stderr })
  })

  test('production wiring (static): the configuration file through loadPersonaConfig, the bash runner, and the script shipped beside src/', () => {
    const code = stripComments(readFileSync(CLI_SOURCE, 'utf-8'))
    const props = objectProperties(code.slice(code.indexOf('const realDeps: CliDeps =')))
    expect(props.get('loadConfigFile')).toBe('(path) => loadPersonaConfig(path)')
    expect(props.get('runCredentialsScript')).toBe('runCredentialsScript')
    expect(code).toMatch(/spawnSync\('bash', \[CREDENTIALS_SCRIPT_PATH, credentialsFile\], \{ stdio: 'inherit' \}\)/)
    expect(CREDENTIALS_SCRIPT_PATH).toBe(resolve(import.meta.dir, '..', 'scripts', 'write-credentials.sh'))
    expect(existsSync(CREDENTIALS_SCRIPT_PATH)).toBe(true)
  })

  test('the real CLI: `credentials` alone prints the usage line and exits 2', () => {
    const result = runCli(['credentials'])

    expect(result.status).toBe(2)
    expect(result.stderr).toBe(`${CREDENTIALS_USAGE}\n`)
    expect(result.stdout).toBe('')
  })

  test('the real CLI: a persona config.json does not declare exits 1 before any script runs, leaving the tree as it was', () => {
    const before = snapshotTree()

    const result = runCli(['credentials', 'nobody'])

    expect(result.status).toBe(1)
    expect(result.stderr).toContain(`credentials: no persona in ${configPath} has that name or key`)
    expect(result.output).not.toContain('bot_token (')
    expect(snapshotTree()).toEqual(before)
  })
})

// ---------------------------------------------------------------------------
// unknown subcommand — regression for b.8tm (trail subcommand removed), and
// the unadvertised reload gesture (b.av2 SR-8.8, AC 74 cli leg)
// ---------------------------------------------------------------------------

/**
 * The subcommand and flag entries of the usage text, with its wording ignored.
 * Every indented line is an entry, named by its first word: a subcommand
 * outside a `<name> flags:` section, a flag inside one. Anything else (a flag
 * outside a section, a non-flag inside one) is `unexpected`.
 */
function usageEntries(output: string): {
  synopsis: string[]
  listed: string[]
  flags: Record<string, string[]>
  unexpected: string[]
  allFlags: string[]
} {
  const lines = output.split('\n')
  const synopsis = (lines.find((l) => /^Usage:/.test(l))?.match(/<([^>]*)>/)?.[1] ?? '').split('|').filter(Boolean)
  const listed: string[] = []
  const flags: Record<string, string[]> = {}
  const unexpected: string[] = []
  let section: string | undefined
  for (const line of lines) {
    if (/^\S/.test(line)) {
      section = line.match(/^(\S+) flags:\s*$/)?.[1]
      continue
    }
    const name = line.match(/^\s+(\S+)/)?.[1]
    if (name === undefined) continue // a blank line
    const isFlag = name.startsWith('-')
    if (section === undefined && !isFlag) listed.push(name)
    else if (section !== undefined && isFlag) (flags[section] ??= []).push(name)
    else unexpected.push(name)
  }
  const allFlags = [...output.matchAll(/(?:^|\s)(--?[A-Za-z][\w-]*)/g)].map((m) => m[1]!)
  return { synopsis, listed, flags, unexpected, allFlags }
}

/**
 * Run the real CLI script in a child process: a built env (b.av2 SR-13.2):
 * a temp HOME and state dir (the per-test root by default), no token, nothing
 * else from process.env; bounded. Bun's transpiler cache is off, so the child
 * writes nothing under the temp HOME (`.bun/install/cache`) that a tree
 * snapshot would mistake for the CLI's doing.
 */
function runCli(args: string[], home = root) {
  const result = spawnSync(process.execPath, [CLI_SOURCE, ...args], {
    encoding: 'utf-8',
    env: { PATH: process.env['PATH'] ?? '', HOME: home, SLACK_STATE_DIR: join(home, 'state'), BUN_RUNTIME_TRANSPILER_CACHE_PATH: '0' },
    timeout: 15_000,
  })
  // Spawned, and not killed by the time limit, so `status` is the CLI's own exit code.
  expect(result.error).toBeUndefined()
  expect(result.signal).toBeNull()
  return { status: result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? '', output: (result.stderr ?? '') + (result.stdout ?? '') }
}

describe('unknown subcommand', () => {
  test('`trail` hits the usage error (non-zero exit; no "trail", retired reconcile flag, token variable or reload wording in usage; AC 74)', () => {
    const result = runCli(['trail'])
    expect(result.status).not.toBe(0)
    const output = result.output
    expect(output).toContain('Usage:')
    expect(output).not.toMatch(/\btrail\b/)
    expect(output).not.toContain('--reconcile-instance-ids')
    expect(output).not.toContain('CSCB_RECONCILE_INSTANCE_IDS')
    for (const name of TOKEN_VARS) expect(output).not.toContain(name)
    expect(output).toContain('start')
    expect(reloadTermsIn(output)).toEqual([])
  })

  test('AC 74: no arguments exits non-zero with usage listing exactly start, stop, clean_restart and credentials, and only --stop-bots, under stop, with no reload wording', () => {
    const result = runCli([])

    expect(result.status).not.toBe(0)
    const usage = usageEntries(result.output)
    expect(usage.synopsis.sort()).toEqual(['clean_restart', 'credentials', 'start', 'stop'])
    expect(usage.listed.sort()).toEqual(['clean_restart', 'credentials', 'start', 'stop'])
    expect(usage.flags).toEqual({ stop: ['--stop-bots'] })
    expect(usage.unexpected).toEqual([])
    expect(usage.allFlags).toEqual(['--stop-bots'])
    expect(reloadTermsIn(result.output)).toEqual([])
  })

  describe('AC 74: hidden subcommands', () => {
    /** The no-argument usage (stderr), captured once in its own temp home. */
    let noArgUsage: string
    beforeAll(() => {
      const home = mkdtempSync(join(tmpdir(), 'cscb-cli-usage-'))
      try {
        noArgUsage = runCli([], home).stderr
        expect(noArgUsage).toStartWith('Usage:')
      } finally {
        rmSync(home, { recursive: true, force: true })
      }
    })

    test.each(['reload', 'apply', 'confirm', 'reload-config', 'Reload', 'apply_config'])(
      'AC 74: hidden subcommand `%s` takes the unknown-subcommand path: non-zero exit, the same usage, nothing else done (a pending file stays put)',
      (spelling) => {
        // A pending change is waiting, so a hidden confirm (pending renamed to
        // apply) or any other touch of it shows in the snapshot.
        writeFileSync(`${configPath}.pending`, readFileSync(configPath))
        const before = snapshotTree()

        const result = runCli([spelling])

        expect(result.status).not.toBe(0)
        expect(result.stderr).toBe(noArgUsage)
        expect(result.stdout).toBe('')
        expect(snapshotTree()).toEqual(before)
      },
    )
  })
})
