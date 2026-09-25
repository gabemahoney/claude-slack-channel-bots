/**
 * persona-connections.test.ts — persona credentials file and bring-up
 * pre-checks.
 *
 * Covers b.av2 SR-1.4 (credentials-file reader and local validity), SR-6.1
 * steps 1 and 2 as pure checks (credentials check, working-directory check,
 * both causes reported), SR-10.3 (credentials and directory class labels and
 * the diagnostic line) and ENG-2 (a success value never prints a token).
 * E2 Task 2 adds SR-3.2 (Slack validation-outcome classification on both
 * legs, the 5 s → 300 s backoff schedule and `retryAfter`) and the SR-10.3
 * `persona-slack-unreachable` / `persona-credentials-refused` episode lines,
 * every row driven through the shared Slack stub with sentinel-bearing
 * errors. E2 Task 3 adds the supervised connection manager: SR-3.1 (validate,
 * connect, identity, event tagging), SR-3.3 (client options, reopen rules, the
 * 10 s start() bound, late settlement, isolation, the unhandledRejection
 * handler), SR-3.4 (dry run), SR-10.3 (`persona-connection-lost` /
 * `persona-connection-restored`), SR-13.1 and the AC 5 walk-through (each
 * clause a case named "AC 5: …"), plus the connection legs of AC 20, AC 23, AC 24
 * and AC 47. E5 Task 1 adds the manager's 10 s bound on `auth.test`, the
 * bring-up controller's outcomes through the real start pass (AC 23, AC 24: one
 * broken persona per cause beside a healthy one, the pass returning while a
 * persona retries, the `persona-start` and cause lines, a credentials refusal
 * on a later reopen) and its per-persona retry timers (AC 66: the directory
 * backoff with held credentials, Slack retries launching on recovery, a
 * launch after a retry that fails, combined causes, independence, dry run,
 * cancellation). E5 Task 2 adds the surviving-instance leg of AC 23, AC 24
 * (SR-6.3, SR-6.4): for every not-up cause the persona's agent-director row
 * survives the start sweep, the start pass and its retries, and its instance's
 * MCP registration is refused through the real admission decision while the
 * healthy persona's is accepted; a directory-broken persona that comes up
 * reuses its row through the collision ladder and is then admitted; a running
 * persona refused on reopen has its session dropped, while a reopen in
 * progress keeps it; the controller's `onLeftUp` fires once per change out of
 * `up` (never for a persona that was never up, a failing listener logged), and
 * `describePersonaNotUp` gives the cause text. E11 Task 2 adds SR-8.3's held
 * credentials digest: the stat-first `readCredentialsFile`, `credentialsDigest`
 * (exact bytes, the missing and unreadable markers) and
 * `checkPersonaCredentialsAndDigest` (checkPersonaCredentials's results
 * unchanged), and the controller's `credentialsDigest(key)` for an up,
 * retrying, credentials-broken, collision-broken (nothing held), dry-run,
 * unknown and cancelled persona. E12 Task 2 adds SR-6.6 for the controller:
 * every fixture wires the real per-persona serializer as server.ts does, and
 * a directory re-check (through the launch it triggers) and a launch after a
 * Slack retry wait behind a blocked lifecycle operation for their persona,
 * never another persona's, and check cancelled, applied and already launched
 * when they start. SR-6.1 / SR-6.5 at a confirmed apply: a persona outside
 * the start set brought up against the applied set ends up, broken or
 * retrying with the start pass's classes and lines while the running
 * personas get no Slack call, takes its tokens from its file (never the
 * environment) and holds the digest read then; the teardown's `cancel` then
 * `stop` leave no retry attempt (a re-check queued behind the teardown
 * included), close the socket with no reopen and no lost or restored line,
 * and forget its state, digest and identity; `cancelAll` covers a persona
 * added after the start; a `start()` settling after `stop` is no connection.
 * E13 Task 1 adds the manager's credentials reconnect (b.av2 SR-8.6
 * credentials row, SR-3.1 overlap, SR-3.3 reconnect part): the new
 * connection opens (SR-3.3 option sets, new tokens) before the old one
 * closes, a refusal or Slack-unreachable keeps the old connection, a
 * never-settling `start()` is abandoned at 10 s, retries follow the backoff,
 * a later reconnect, `stop` and shutdown cancel a pending one, a retrying
 * persona takes new tokens (`replaceRetryTokens`), and the
 * `persona-credentials-change-failed` line per cause; and bug b.ujn: the
 * first `invalid_auth`, `token_revoked`, `account_inactive` or `not_authed`
 * from a Web API call on a persona's current client marks it
 * credentials-broken at once (one line, no delivery, later calls refused
 * locally), whatever the serializer holds, while other errors, stale
 * clients and B change nothing.
 * Time is a fake clock throughout;
 * nothing sleeps (the start-pass cases poll in 1 ms real-time steps only for
 * the real spawn path).
 *
 * Unhandled rejections: `bun test` fails the running test on any unhandled
 * rejection (the process listener never sees it), so every manager case also
 * proves that nothing it did left a rejection unhandled.
 *
 * Permission cases use the checks' injected file-system seams, so they pass
 * as root (docker CI). The real-permission variants are skipped under root,
 * which bypasses permission bits; their names say so.
 *
 * Isolation (b.av2 SR-13.2): every path is under a mkdtempSync directory that
 * afterEach removes, and every path is passed explicitly. Nothing touches the
 * real home, starts a server or runs the CLI. Tokens are sentinel-bearing
 * fakes from the credentials helper, and assertNoLeak runs over every
 * captured result and log line.
 *
 * SPDX-License-Identifier: MIT
 */

import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  chmodSync,
  constants as fsConstants,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'
import {
  CREDENTIALS_MISSING_MARKER,
  CREDENTIALS_UNREADABLE_MARKER,
  DEFAULT_CREDENTIALS_FS,
  PersonaSlackTokens,
  checkPersonaCredentials,
  checkPersonaCredentialsAndDigest,
  credentialsDigest,
  readCredentialsFile,
  type CredentialsFs,
} from '../src/persona-credentials.ts'
import {
  createPersonaConnectionManager,
  dryRunPersonaIdentity,
  type PersonaConnectionManager,
  type PersonaConnectionStatus,
  type PersonaEventHandler,
  type PersonaReconnectLaterOutcome,
  type PersonaReconnectOutcome,
  type PersonaSocketEventName,
  type PersonaSocketEventPayload,
} from '../src/persona-connections.ts'
import {
  createUnhandledRejectionHandler,
  describeSlackCallFailure,
  describeThrownValue,
  isSafeIdentifier,
  slackPlatformReason,
} from '../src/persona-connection-errors.ts'
import {
  DEFAULT_WORKING_DIRECTORY_FS,
  checkPersonaLocalBringUp,
  checkPersonaWorkingDirectory,
  type BringUpPersona,
  type OtherBringUpPersona,
  type PersonaBringUpFs,
  type WorkingDirectoryFs,
} from '../src/persona-bringup.ts'
import {
  PERSONA_CONNECTION_LOST,
  PERSONA_CONNECTION_RESTORED,
  PERSONA_CREDENTIALS_CHANGE_FAILED,
  PERSONA_CREDENTIALS_INVALID,
  PERSONA_CREDENTIALS_MISSING,
  PERSONA_CREDENTIALS_REFUSED,
  PERSONA_CREDENTIALS_UNREADABLE,
  PERSONA_DIAGNOSTIC_CLASSES,
  PERSONA_SLACK_UNREACHABLE,
  PERSONA_START,
  PERSONA_DIRECTORY_MISSING,
  PERSONA_DIRECTORY_UNUSABLE,
  formatCredentialsChangeFailed,
  formatPersonaDiagnostic,
  personaCheckFailure,
  type CredentialsChangeKept,
  type PersonaCheckFailure,
  type PersonaDiagnosticClass,
} from '../src/persona-diagnostics.ts'
import { personaKey, renderPersonaRef } from '../src/persona-identity.ts'
import {
  SlackAuthTestTimeoutError,
  SlackStartTimeoutError,
  botIdentityFromAuthTest,
  classifySlackValidationError,
  type SlackCredentialsRefusedOutcome,
  type SlackValidationCheck,
  type SlackValidationFailure,
  type SlackValidationOutcome,
} from '../src/persona-slack-validation.ts'
import { MAX_TIMER_DELAY_MS, createPersonaRetrySchedule } from '../src/persona-retry-schedule.ts'
import { WEB_API_CALL_REFUSED_LOCALLY, WebApiCallRefusedLocallyError } from '../src/persona-web-api-watch.ts'
import { createSlackEpisodeTracker, type SlackEpisodeTracker } from '../src/persona-slack-episodes.ts'
import {
  APP_TOKEN_PREFIX,
  BOT_TOKEN_PREFIX,
  LEAK_SENTINEL,
  assertNoLeak,
  fakeToken,
  makeCredentials,
  writeCredentialsFile,
  type CredentialsOverrides,
} from './test-helpers/credentials.ts'
import {
  INITIAL_CREDENTIALS,
  makeAppMention,
  makeChannelMessage,
  makeDeferredConnect,
  makeDeferredWebApiCall,
  makeStubSlack,
  makeStubSlackFactory,
  mentionText,
  type ConnectOutcome,
  type SettledConnectOutcome,
  type StubClientKind,
  type StubSlack,
  type StubSlackFactory,
  type StubSlackOptions,
  type StubSlackScript,
  type WebApiOutcome,
} from './test-helpers/slack-stub.ts'
import { createFakeClock, type FakeClock } from './test-helpers/fake-clock.ts'
import {
  cannedGetResult,
  cannedListRow,
  errInstanceIdCollision,
  errSpawnNotFound,
  installStubSpawnPath,
  makeStubCallLog,
  makeStubClient,
  resetStubSpawnPath,
  stubCallCount,
  type StubSpawnPath,
} from './test-helpers/agent-director-stub.ts'
import { makeConnectionHarness, type ConnectionHarness } from './test-helpers/persona-connection-harness.ts'
import type { PersonaSpec } from './test-helpers/persona-config.ts'
import { resolveRealPath, type Persona } from '../src/config.ts'
import { createPersonaSerializer, type PersonaSerialize, type PersonaSerializer } from '../src/persona-serializer.ts'
import {
  createNotUpSessionDropper,
  createPersonaBringUpController,
  describePersonaNotUp,
  type CredentialsSwap,
  type PersonaBringUpController,
  type PersonaBringUpControllerDeps,
  type PersonaBringUpResultSummary,
  type PersonaBringUpState,
  type PersonaCredentialsChangeResult,
} from '../src/persona-bringup-controller.ts'
import {
  composePersonaStatusListeners,
  createPersonaUpFlushListener,
  createPersonaRelaunchGate,
  createPersonaUpPredicate,
} from '../src/persona-start.ts'
import { createPersonaNotifier, type PersonaNotifier } from '../src/persona-notifier.ts'
import {
  reconcileOrphans,
  setSessionNotifier,
  spawnForPersona,
  startupSessionManager,
  type StartupSessionManagerResult,
} from '../src/session-manager.ts'
import {
  _resetRegistry,
  closePendingSession,
  createPendingSession,
  decideSessionAdmission,
  dropPersonaSession,
  getSessionByPersona,
  registerMcpSessionId,
  registerSession,
  removePendingSession,
  resolveTransportForRequest,
  unregisterByMcpSessionId,
  type SessionAdmission,
  type SessionEntry,
} from '../src/registry.ts'
import { _resetOutageState, getOutageFlags, initOutageState } from '../src/outage-state.ts'
import { getClient } from '../src/agent-director-client.ts'
import { _resetBackoffState, getFailureCount } from '../src/backoff.ts'
import { RESTART_FAILURE_CAP } from '../src/restart.ts'

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const isRoot = process.getuid?.() === 0
const ROOT_SKIP = 'skipped under root, which bypasses permission bits; the injected-fs case covers it'

/** The file's default fake tokens (see makeCredentials). */
const FILE_BOT_TOKEN = fakeToken(BOT_TOKEN_PREFIX, 'bot')
const FILE_APP_TOKEN = fakeToken(APP_TOKEN_PREFIX, 'app')

/** The environment token variables, which the checks must never read. */
const ENV_KEYS = ['SLACK_BOT_TOKEN', 'SLACK_APP_TOKEN'] as const

/** Sentinel-bearing fakes the environment token variables hold during every test. */
const AMBIENT_ENV_TOKENS = [fakeToken(BOT_TOKEN_PREFIX, 'ambient'), fakeToken(APP_TOKEN_PREFIX, 'ambient')] as const

/** Set each environment token variable to `values[i]`, deleting it for undefined. */
function setEnvTokens(values: readonly (string | undefined)[]): void {
  ENV_KEYS.forEach((key, i) => {
    if (values[i] === undefined) delete process.env[key]
    else process.env[key] = values[i]
  })
}

/** Whether the environment token variables equal `values`. A boolean, so a failure never prints a value. */
function envTokensEqual(values: readonly (string | undefined)[]): boolean {
  return ENV_KEYS.every((key, i) => process.env[key] === values[i])
}

let dir: string
/** Paths a test chmodded, restored before cleanup so rmSync can remove them. */
let chmodded: string[]
/** The environment token variables as they were before the test, restored afterwards. */
let savedEnvTokens: (string | undefined)[]

beforeEach(() => {
  // Replace any real tokens in the ambient environment with fakes, so a
  // regression that reads them (or an assertion that prints them) exposes
  // only sentinel-bearing values that assertNoLeak catches.
  savedEnvTokens = ENV_KEYS.map(key => process.env[key])
  setEnvTokens(AMBIENT_ENV_TOKENS)
  // realpath: a symlinked tmpdir would otherwise show up in collision causes.
  dir = realpathSync(mkdtempSync(join(tmpdir(), 'persona-connections-')))
  chmodded = []
})

afterEach(() => {
  for (const path of chmodded) chmodSync(path, 0o700)
  rmSync(dir, { recursive: true, force: true })
  setEnvTokens(savedEnvTokens)
  expect(envTokensEqual(savedEnvTokens)).toBe(true)
})

/** Persona `name`, with its credentials file and working directory under `<dir>/<key>/`. */
function makePersona(name = 'Alpha', overrides: Partial<BringUpPersona> = {}): BringUpPersona {
  const key = personaKey(name)
  return {
    index: 0,
    name,
    key,
    credentials_file: join(dir, key, 'credentials.json'),
    working_directory: join(dir, key, 'work'),
    ...overrides,
  }
}

/** Another applied persona, as the checks' `others` lists take it. */
function makeOther(name = 'Beta'): OtherBringUpPersona {
  const { key, credentials_file, working_directory } = makePersona(name)
  return { name, key, credentials_file, working_directory }
}

/** Write `persona`'s credentials file (valid unless overridden) and return its path. */
function writeCreds(persona: Pick<BringUpPersona, 'credentials_file'>, overrides: CredentialsOverrides = {}): string {
  return writeCredentialsFile(dir, relative(dir, persona.credentials_file), overrides)
}

/** Create `persona`'s working directory and return its path. */
function makeWorkDir(persona: Pick<BringUpPersona, 'working_directory'>): string {
  mkdirSync(persona.working_directory, { recursive: true })
  return persona.working_directory
}

/** A logger stub and the lines it captured. */
function capture(): { lines: string[]; log: (line: string) => void } {
  const lines: string[] = []
  return { lines, log: line => void lines.push(line) }
}

/**
 * Run `fn` with every console method and `process.stderr.write` silenced, and
 * return its value with the number of calls they received. A count, not the
 * calls, so a failure never prints what was emitted. Counted before
 * mockRestore, which clears a spy's recorded calls.
 */
function withSilencedOutput<T>(fn: () => T): { value: T; outputCalls: number } {
  const spies = (['error', 'warn', 'log', 'info', 'debug'] as const).map(method =>
    spyOn(console, method).mockImplementation(() => {}),
  )
  spies.push(spyOn(process.stderr, 'write').mockImplementation(() => true))
  let value: T
  let outputCalls: number
  try {
    value = fn()
  } finally {
    outputCalls = spies.reduce((sum, spy) => sum + spy.mock.calls.length, 0)
    for (const spy of spies) spy.mockRestore()
  }
  return { value, outputCalls }
}

/** An operation that throws an errno-style error with `code`. */
function failsWith(code: string): () => never {
  return () => {
    throw Object.assign(new Error(`simulated ${code}`), { code })
  }
}

/** An `access` that denies only `deniedMode`. */
function accessDenying(deniedMode: number): WorkingDirectoryFs['access'] {
  return (_path, mode) => {
    if (mode === deniedMode) failsWith('EACCES')()
  }
}

/**
 * Assert `result` is a failure of class `cls` whose line was emitted exactly
 * once through the stub logger, carries no tokens and leaks nothing.
 */
function expectFailure(
  result: { ok: boolean },
  cls: PersonaDiagnosticClass,
  lines: string[],
): PersonaCheckFailure {
  assertNoLeak({ result, lines }, cls)
  if (result.ok) throw new Error(`expected ${cls}, got ok`)
  const failure = result as PersonaCheckFailure
  expect(failure.class).toBe(cls)
  expect(lines).toEqual([failure.line])
  expect('tokens' in failure).toBe(false)
  return failure
}

/** The digest a credentials file's current bytes should hold: `sha256:` and the SHA-256 hex, computed here. */
function sha256Digest(bytes: Uint8Array): string {
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`
}

/** The expected digest of the file at `path` as it stands now. */
function fileDigest(path: string): string {
  return sha256Digest(readFileSync(path))
}

/** Bytes that are not valid UTF-8 (a lone continuation byte and 0xff), around the sentinel. */
const INVALID_UTF8 = Buffer.concat([Buffer.from([0xff, 0x80]), Buffer.from(LEAK_SENTINEL), Buffer.from([0xc3])])

/** Mode and content hash of every entry under `root`, keyed by relative path. */
function snapshotTree(root: string): Record<string, string> {
  const out: Record<string, string> = {}
  const walk = (path: string): void => {
    const st = lstatSync(path)
    const mode = (st.mode & 0o7777).toString(8)
    const rel = relative(root, path) || '.'
    if (st.isSymbolicLink()) out[rel] = `${mode} -> ${readlinkSync(path)}`
    else if (st.isDirectory()) {
      out[rel] = `${mode} dir`
      for (const entry of readdirSync(path)) walk(join(path, entry))
    } else out[rel] = `${mode} ${createHash('sha256').update(readFileSync(path)).digest('hex')}`
  }
  walk(root)
  return out
}

// ---------------------------------------------------------------------------
// Credentials reader (SR-1.4)
// ---------------------------------------------------------------------------

describe('checkPersonaCredentials: valid, missing and unreadable', () => {
  test.each([0o600, 0o644].map(mode => [`0${mode.toString(8)}`, mode] as const))('a valid file with mode %s returns the tokens in the file', (_octal, mode) => {
    const persona = makePersona()
    const path = writeCreds(persona)
    chmodSync(path, mode)
    const { lines, log } = capture()

    const result = checkPersonaCredentials(persona, { others: [], log })

    assertNoLeak({ result, lines })
    if (!result.ok) throw new Error(`expected ok, got ${result.class}`)
    expect(result.tokens.botToken).toBe(FILE_BOT_TOKEN)
    expect(result.tokens.appToken).toBe(FILE_APP_TOKEN)
    expect(lines).toEqual([])
    // File mode is neither policed nor changed.
    expect(statSync(path).mode & 0o777).toBe(mode)
  })

  test.each<[string, (persona: BringUpPersona) => string]>([
    ['the file does not exist', persona => persona.credentials_file],
    [
      'a parent path component is a regular file',
      persona => {
        writeFileSync(join(dir, 'plain'), 'x')
        return join(dir, 'plain', 'credentials.json')
      },
    ],
  ])('persona-credentials-missing when %s', (_label, arrange) => {
    const persona = makePersona()
    const path = arrange(persona)
    const { lines, log } = capture()

    const result = checkPersonaCredentials({ ...persona, credentials_file: path }, { others: [], log })

    expect(expectFailure(result, PERSONA_CREDENTIALS_MISSING, lines).cause).toContain('does not exist')
  })

  // A directory, a device, a FIFO and injected open, fstat and read failures: see the descriptor block below.

  test.skipIf(isRoot)(`persona-credentials-unreadable for a file without read permission (real fs; ${ROOT_SKIP})`, () => {
    const persona = makePersona()
    const path = writeCreds(persona)
    chmodSync(path, 0o000)
    chmodded.push(path)
    const { lines, log } = capture()

    const result = checkPersonaCredentials(persona, { others: [], log })

    expect(expectFailure(result, PERSONA_CREDENTIALS_UNREADABLE, lines).cause).toContain('permission denied')
  })
})

// ---------------------------------------------------------------------------
// One descriptor: open once (non-blocking), fstat, read, always close
// ---------------------------------------------------------------------------

describe('checkPersonaCredentials: the file is opened once and checked, read and closed through its descriptor', () => {
  /** A file-system op the check made, with the descriptor it got (none for `open`). */
  type FdCall = { op: 'open' | 'fstat' | 'read' | 'close'; fd?: number }

  /**
   * The real credentials seam with every call recorded; `overrides` replace
   * an op (a replaced `closeFile` still closes the real descriptor first, so
   * nothing leaks). Returns the seam, the calls and the descriptor opened.
   */
  function recordingFs(overrides: Partial<CredentialsFs> = {}) {
    const calls: FdCall[] = []
    let opened: number | undefined
    const fs: Partial<CredentialsFs> = {
      openFile: (path) => {
        calls.push({ op: 'open' })
        opened = (overrides.openFile ?? DEFAULT_CREDENTIALS_FS.openFile)(path)
        return opened
      },
      fstatFile: (fd) => {
        calls.push({ op: 'fstat', fd })
        return (overrides.fstatFile ?? DEFAULT_CREDENTIALS_FS.fstatFile)(fd)
      },
      readFileFd: (fd) => {
        calls.push({ op: 'read', fd })
        return (overrides.readFileFd ?? DEFAULT_CREDENTIALS_FS.readFileFd)(fd)
      },
      closeFile: (fd) => {
        calls.push({ op: 'close', fd })
        DEFAULT_CREDENTIALS_FS.closeFile(fd)
        overrides.closeFile?.(fd)
      },
    }
    return { fs, calls, opened: () => opened }
  }

  const hasMkfifo = spawnSync('mkfifo', ['--version']).status === 0

  // Rows: label, arrange (real path or injected ops), expected class and cause, ops made after the open.
  test.each<[string, (persona: BringUpPersona) => Partial<CredentialsFs>, PersonaDiagnosticClass | 'ok', string, FdCall['op'][]]>([
    ['a valid regular file', (persona) => (writeCreds(persona), {}), 'ok', '', ['fstat', 'read', 'close']],
    ['a directory (real)', (persona) => (mkdirSync(persona.credentials_file, { recursive: true }), {}),
      PERSONA_CREDENTIALS_UNREADABLE, 'credentials file is a directory', ['fstat', 'close']],
    ['a symlink to /dev/zero (real character device)', (persona) => {
      mkdirSync(join(dir, persona.key), { recursive: true })
      symlinkSync('/dev/zero', persona.credentials_file)
      return {}
    }, PERSONA_CREDENTIALS_UNREADABLE, 'credentials file is not a regular file', ['fstat', 'close']],
    ['a FIFO, as the injected fstatFile reports it', (persona) => (writeCreds(persona), { fstatFile: () => ({ isFile: () => false, isDirectory: () => false }) }),
      PERSONA_CREDENTIALS_UNREADABLE, 'credentials file is not a regular file', ['fstat', 'close']],
    ['fstat fails with EIO (injected)', (persona) => (writeCreds(persona), { fstatFile: failsWith('EIO') }),
      PERSONA_CREDENTIALS_UNREADABLE, 'credentials file cannot be read (EIO)', ['fstat', 'close']],
    ['the read fails with EIO (injected)', (persona) => (writeCreds(persona), { readFileFd: failsWith('EIO') }),
      PERSONA_CREDENTIALS_UNREADABLE, 'credentials file cannot be read (EIO)', ['fstat', 'read', 'close']],
    ['the read is denied with EACCES (injected)', (persona) => (writeCreds(persona), { readFileFd: failsWith('EACCES') }),
      PERSONA_CREDENTIALS_UNREADABLE, 'credentials file cannot be read: permission denied (EACCES)', ['fstat', 'read', 'close']],
    ['invalid content', (persona) => (writeCreds(persona, 'null'), {}),
      PERSONA_CREDENTIALS_INVALID, 'credentials file is invalid: not a JSON object', ['fstat', 'read', 'close']],
    ['closing throws (injected): ignored, the result stands', (persona) => (writeCreds(persona), { closeFile: failsWith('EIO') }),
      'ok', '', ['fstat', 'read', 'close']],
    ['closing throws after a refused non-regular file (injected): ignored', (persona) => (writeCreds(persona), {
      fstatFile: () => ({ isFile: () => false, isDirectory: () => false }),
      closeFile: failsWith('EBADF'),
    }), PERSONA_CREDENTIALS_UNREADABLE, 'credentials file is not a regular file', ['fstat', 'close']],
  ])('%s', (_label, arrange, expected, cause, afterOpen) => {
    const persona = makePersona()
    const { fs, calls, opened } = recordingFs(arrange(persona))
    const { lines, log } = capture()

    const result = checkPersonaCredentials(persona, { others: [], fs, log })

    if (expected === 'ok') {
      assertNoLeak({ result, lines })
      if (!result.ok) throw new Error(`expected ok, got ${result.class}`)
      expect(result.tokens.botToken).toBe(FILE_BOT_TOKEN)
      expect(lines).toEqual([])
    } else {
      expect(expectFailure(result, expected, lines).cause).toBe(cause)
    }
    // Opened once; every later op used that descriptor; closed exactly once, last.
    expect(calls.map((c) => c.op)).toEqual(['open', ...afterOpen])
    expect(calls.slice(1).every((c) => c.fd === opened())).toBe(true)
  })

  // In a child process with a 10 s bound: a blocking open of a FIFO with no
  // writer never returns, so in-process it would hang the whole suite instead
  // of failing this test.
  test.skipIf(!hasMkfifo)('a real FIFO: the open does not wait for a writer; refused unread and closed (child process, 10 s bound; skipped where mkfifo is unavailable)', () => {
    const persona = makePersona()
    mkdirSync(join(dir, persona.key), { recursive: true })
    expect(spawnSync('mkfifo', [persona.credentials_file]).status).toBe(0)
    const modulePath = join(import.meta.dir, '..', 'src', 'persona-credentials.ts')
    const script = `
      const { checkPersonaCredentials, DEFAULT_CREDENTIALS_FS: d } = await import(${JSON.stringify(modulePath)})
      const ops = []
      const fs = {
        openFile: (p) => (ops.push('open'), d.openFile(p)),
        fstatFile: (fd) => (ops.push('fstat'), d.fstatFile(fd)),
        readFileFd: (fd) => (ops.push('read'), d.readFileFd(fd)),
        closeFile: (fd) => (ops.push('close'), d.closeFile(fd)),
      }
      const r = checkPersonaCredentials(${JSON.stringify(persona)}, { others: [], fs })
      console.log(JSON.stringify({ ok: r.ok, class: r.class, cause: r.cause, ops }))
    `

    const child = spawnSync(process.execPath, ['-e', script], { timeout: 10_000, encoding: 'utf-8', env: { PATH: process.env['PATH'] } })

    expect(child.signal).toBeNull()
    expect(JSON.parse(child.stdout.trim())).toEqual({
      ok: false,
      class: PERSONA_CREDENTIALS_UNREADABLE,
      cause: 'credentials file is not a regular file',
      ops: ['open', 'fstat', 'close'],
    })
  }, 15_000)

  test.each<[string, string, PersonaDiagnosticClass, string]>([
    ['missing (real)', 'ENOENT', PERSONA_CREDENTIALS_MISSING, 'credentials file does not exist'],
    ['open denied with EACCES (injected)', 'EACCES', PERSONA_CREDENTIALS_UNREADABLE, 'credentials file cannot be read: permission denied (EACCES)'],
    ['open denied with EPERM (injected)', 'EPERM', PERSONA_CREDENTIALS_UNREADABLE, 'credentials file cannot be read: permission denied (EPERM)'],
    ['open fails with EIO (injected)', 'EIO', PERSONA_CREDENTIALS_UNREADABLE, 'credentials file cannot be read (EIO)'],
  ])('a failed open (%s): nothing to stat, read or close', (_label, code, cls, cause) => {
    const persona = makePersona()
    if (code !== 'ENOENT') writeCreds(persona)
    const { fs, calls } = recordingFs(code === 'ENOENT' ? {} : { openFile: failsWith(code) })
    const { lines, log } = capture()

    const result = checkPersonaCredentials(persona, { others: [], fs, log })

    expect(expectFailure(result, cls, lines).cause).toBe(cause)
    expect(calls).toEqual([{ op: 'open' }])
  })
})

describe('checkPersonaCredentials: invalid content', () => {
  // Every row that can carry text embeds LEAK_SENTINEL in its offending
  // content, so assertNoLeak exercises the parse-error and bad-token paths.
  // Rows: label, overrides, cause fragments, fragments the cause must not hold.
  test.each<[string, CredentialsOverrides, string[], string[]?]>([
    [
      'non-JSON content',
      `{"app_token": "${fakeToken(APP_TOKEN_PREFIX)}", "bot_token": ${LEAK_SENTINEL}}`,
      ['not valid JSON'],
    ],
    ['a JSON array', JSON.stringify([fakeToken(BOT_TOKEN_PREFIX), fakeToken(APP_TOKEN_PREFIX)]), ['not a JSON object']],
    ['JSON null', 'null', ['not a JSON object']],
    ['a JSON string', JSON.stringify(fakeToken(BOT_TOKEN_PREFIX)), ['not a JSON object']],
    ['a missing bot_token', { bot_token: undefined }, ['bot_token is missing']],
    ['a missing app_token', { app_token: undefined }, ['app_token is missing']],
    ['an extra key', { note: fakeToken('', 'extra') }, ['1 unexpected key', 'only bot_token and app_token are allowed']],
    ['an extra key whose name is token-like', { [fakeToken(BOT_TOKEN_PREFIX, 'key')]: 'x' }, ['1 unexpected key']],
    ['a non-string bot_token', { bot_token: 42 }, ['bot_token must be a string']],
    ['a non-string app_token', { app_token: [fakeToken(APP_TOKEN_PREFIX)] }, ['app_token must be a string']],
    ['the wrong prefix on bot_token', { bot_token: fakeToken('xoxp-') }, ['bot_token must start with xoxb-']],
    ['the wrong prefix on app_token', { app_token: fakeToken('xoxa-') }, ['app_token must start with xapp-']],
    [
      'swapped prefixes',
      { bot_token: fakeToken(APP_TOKEN_PREFIX), app_token: fakeToken(BOT_TOKEN_PREFIX) },
      ['bot_token must start with xoxb-', 'app_token must start with xapp-'],
    ],
    ['an empty bot_token', { bot_token: '' }, ['bot_token must start with xoxb-']],
    ['an empty app_token', { app_token: '' }, ['app_token must start with xapp-']],
    ...([
      ['a', 'bot_token', BOT_TOKEN_PREFIX, '\u001b'],
      ['an', 'app_token', APP_TOKEN_PREFIX, '\u007f'],
    ] as const).flatMap(([a, key, prefix, control]): [string, CredentialsOverrides, string[], string[]?][] => {
      const whitespaceRule = `${key} contains whitespace or control characters`
      return [
        [`a bare ${prefix} ${key}`, { [key]: prefix }, [`${key} has nothing after ${prefix}`]],
        [`${a} ${key} with a trailing newline`, { [key]: `${fakeToken(prefix)}\n` }, [whitespaceRule]],
        [`${a} ${key} with a space inside`, { [key]: fakeToken(prefix, 'a b') }, [whitespaceRule]],
        [`${a} ${key} with a control character`, { [key]: fakeToken(prefix, control) }, [whitespaceRule]],
        // Each key reports only its first problem: whitespace, not the prefix.
        [`${a} ${key} with a leading space`, { [key]: ` ${fakeToken(prefix)}` }, [whitespaceRule], ['must start with']],
      ]
    }),
    [
      'problems in both keys',
      { bot_token: `\t${fakeToken('xoxp-')}`, app_token: APP_TOKEN_PREFIX },
      ['invalid: bot_token contains whitespace or control characters; app_token has nothing after xapp-'],
      ['must start with'],
    ],
  ])('persona-credentials-invalid for %s, naming the key and rule only', (_label, overrides, causeFragments, absent = []) => {
    const persona = makePersona()
    writeCreds(persona, overrides)
    const { lines, log } = capture()

    const result = checkPersonaCredentials(persona, { others: [], log })

    const failure = expectFailure(result, PERSONA_CREDENTIALS_INVALID, lines)
    for (const fragment of causeFragments) {
      expect(failure.cause).toContain(fragment)
      expect(failure.line).toContain(fragment)
    }
    for (const fragment of absent) expect(failure.cause).not.toContain(fragment)
  })
})

describe('checkPersonaCredentials: real-path collision with another applied persona', () => {
  test.each<[string, (persona: BringUpPersona, other: OtherBringUpPersona) => BringUpPersona]>([
    [
      'a symlink to the other persona’s file',
      (persona, other) => {
        writeCreds(other)
        mkdirSync(join(dir, persona.key), { recursive: true })
        symlinkSync(other.credentials_file, persona.credentials_file)
        return persona
      },
    ],
    [
      'the same non-existent path, compared lexically',
      (persona, other) => ({ ...persona, credentials_file: `${dir}/elsewhere/../${other.key}/credentials.json` }),
    ],
  ])('persona-credentials-invalid naming the other persona, without tokens, for %s', (_label, arrange) => {
    const other = makeOther()
    const persona = arrange(makePersona(), other)
    const { lines, log } = capture()

    const result = checkPersonaCredentials(persona, { others: [other], log })

    const failure = expectFailure(result, PERSONA_CREDENTIALS_INVALID, lines)
    expect(failure.cause).toContain(renderPersonaRef(other.name, other.key))
    expect(failure.cause).toContain('credentials_file')
  })

  test.each<[string, (persona: BringUpPersona) => OtherBringUpPersona]>([
    [
      'another persona has its own file',
      () => {
        const other = makeOther()
        writeCreds(other)
        return other
      },
    ],
    ['the list includes the persona itself (same key)', persona => persona],
  ])('a valid file passes when %s', (_label, arrange) => {
    const persona = makePersona()
    writeCreds(persona)
    const others = [arrange(persona)]
    const { lines, log } = capture()

    const result = checkPersonaCredentials(persona, { others, log })

    assertNoLeak({ result, lines })
    expect(result.ok).toBe(true)
    expect(lines).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// The stat-first reader and the digest held for a read (b.av2 SR-8.3)
// ---------------------------------------------------------------------------

describe('readCredentialsFile and credentialsDigest (SR-8.3)', () => {
  /** Write `bytes` as `persona`'s credentials file, creating its directory; the path. */
  function writeRaw(persona: BringUpPersona, bytes: string | Uint8Array): string {
    mkdirSync(join(dir, persona.key), { recursive: true })
    writeFileSync(persona.credentials_file, bytes)
    return persona.credentials_file
  }

  // Rows: label, the file's bytes. The read returns exactly those bytes and the digest is their SHA-256.
  test.each<[string, (persona: BringUpPersona) => string]>([
    ['a valid credentials file', persona => writeCreds(persona)],
    ['an empty file', persona => writeRaw(persona, '')],
    ['bytes that are not valid UTF-8 (never decoded and re-encoded)', persona => writeRaw(persona, INVALID_UTF8)],
    ['a CRLF file with a byte order mark', persona => writeRaw(persona, `﻿{"bot_token": "${fakeToken(BOT_TOKEN_PREFIX)}"}\r\n`)],
  ])('%s: the read returns the exact bytes on disk and the digest is sha256: and their SHA-256 hex', (_label, arrange) => {
    const path = arrange(makePersona())
    const onDisk = readFileSync(path)

    const read = readCredentialsFile(path)
    const digest = credentialsDigest(read)

    if (!read.ok) throw new Error(`expected a read, got ${read.cause}`)
    expect(Buffer.compare(read.bytes, onDisk)).toBe(0)
    expect(digest).toMatch(/^sha256:[0-9a-f]{64}$/)
    expect(digest).toBe(sha256Digest(onDisk))
    assertNoLeak({ digest, json: JSON.stringify(digest) })
  })

  // Rows: label, arrange (returns the path and any injected ops), whether missing, the cause, the ops after the open.
  test.each<[string, (persona: BringUpPersona) => Partial<CredentialsFs>, boolean, string, string[]]>([
    ['the file does not exist', () => ({}), true, 'credentials file does not exist', []],
    ['a directory at the path (real, holds as root)', persona => (mkdirSync(persona.credentials_file, { recursive: true }), {}),
      false, 'credentials file is a directory', ['fstat', 'close']],
    ['a FIFO, as the injected fstatFile reports it', persona => (writeCreds(persona), { fstatFile: () => ({ isFile: () => false, isDirectory: () => false }) }),
      false, 'credentials file is not a regular file', ['fstat', 'close']],
    ['the open denied with EACCES (injected)', persona => (writeCreds(persona), { openFile: failsWith('EACCES') }),
      false, 'credentials file cannot be read: permission denied (EACCES)', []],
    ['the read fails with EIO (injected)', persona => (writeCreds(persona), { readFileFd: failsWith('EIO') }),
      false, 'credentials file cannot be read (EIO)', ['fstat', 'read', 'close']],
  ])('%s: no bytes, the stat-first rule holds, and the digest is the missing or unreadable marker', (_label, arrange, missing, cause, afterOpen) => {
    const persona = makePersona()
    const injected = arrange(persona)
    const ops: string[] = []
    const fs: Partial<CredentialsFs> = {
      openFile: path => (injected.openFile ?? DEFAULT_CREDENTIALS_FS.openFile)(path),
      fstatFile: fd => (ops.push('fstat'), (injected.fstatFile ?? DEFAULT_CREDENTIALS_FS.fstatFile)(fd)),
      readFileFd: fd => (ops.push('read'), (injected.readFileFd ?? DEFAULT_CREDENTIALS_FS.readFileFd)(fd)),
      closeFile: fd => (ops.push('close'), DEFAULT_CREDENTIALS_FS.closeFile(fd)),
    }

    const read = readCredentialsFile(persona.credentials_file, fs)
    const digest = credentialsDigest(read)

    expect(read).toEqual({ ok: false, missing, cause })
    expect(ops).toEqual(afterOpen)
    expect(digest).toBe(missing ? CREDENTIALS_MISSING_MARKER : CREDENTIALS_UNREADABLE_MARKER)
    assertNoLeak({ read, digest })
  })

  test('the two markers differ from each other, from every digest (an empty file’s included) and from the sha256: form', () => {
    const empty = sha256Digest(new Uint8Array())

    expect(credentialsDigest({ ok: true, bytes: Buffer.alloc(0) })).toBe(empty)
    expect(new Set([CREDENTIALS_MISSING_MARKER, CREDENTIALS_UNREADABLE_MARKER, empty]).size).toBe(3)
    for (const marker of [CREDENTIALS_MISSING_MARKER, CREDENTIALS_UNREADABLE_MARKER]) expect(marker).not.toMatch(/^sha256:/)
  })

  // The 64 KiB cap (65,536 bytes): a larger file is unreadable, worded with the
  // limit and none of its content, never read past 65,537 bytes, and held as the
  // unreadable marker. Each file is valid credentials (the file's fake tokens)
  // padded with trailing whitespace, so only its size can refuse it, and a leak
  // of its content fails assertNoLeak.
  const TOO_LARGE = { ok: false, missing: false, cause: 'credentials file is larger than the 64 KiB limit' } as const

  /** `persona`'s credentials file: valid credentials padded with spaces to exactly `size` bytes; the path. */
  function writePaddedCreds(persona: BringUpPersona, size: number): string {
    const json = JSON.stringify(makeCredentials())
    return writeRaw(persona, json + ' '.repeat(size - json.length))
  }

  /** A credentials seam over the real one that records each op, and for a read the bytes asked for and returned. */
  function recordingReads(injected: Partial<CredentialsFs> = {}) {
    const ops: string[] = []
    const reads: { maxBytes?: number; returned: number }[] = []
    const fs: Partial<CredentialsFs> = {
      fstatFile: fd => (ops.push('fstat'), (injected.fstatFile ?? DEFAULT_CREDENTIALS_FS.fstatFile)(fd)),
      readFileFd: (fd, maxBytes) => {
        ops.push('read')
        const bytes = (injected.readFileFd ?? DEFAULT_CREDENTIALS_FS.readFileFd)(fd, maxBytes)
        reads.push({ maxBytes, returned: bytes.length })
        return bytes
      },
      closeFile: fd => (ops.push('close'), DEFAULT_CREDENTIALS_FS.closeFile(fd)),
    }
    return { fs, ops, reads }
  }

  test.each([
    { label: '65,536 bytes (the limit) is read in full, asking for at most 65,537, and hashed', size: 65_536, afterOpen: ['fstat', 'read', 'close'] },
    { label: '65,537 bytes is refused on its stat, unread, and held as the unreadable marker', size: 65_537, afterOpen: ['fstat', 'close'] },
  ])('a credentials file of $label, by readCredentialsFile and checkPersonaCredentialsAndDigest alike', ({ size, afterOpen }) => {
    const persona = makePersona()
    const path = writePaddedCreds(persona, size)
    const { fs, ops, reads } = recordingReads()
    const { lines, log } = capture()

    const read = readCredentialsFile(path, fs)
    const digest = credentialsDigest(read)
    const both = checkPersonaCredentialsAndDigest(persona, { others: [], log })

    if (size <= 65_536) {
      if (!read.ok) throw new Error(`expected a read, got ${read.cause}`)
      expect(read.bytes.length).toBe(size)
      expect(Buffer.compare(read.bytes, readFileSync(path))).toBe(0)
      expect(digest).toBe(fileDigest(path))
      expect(reads).toEqual([{ maxBytes: 65_537, returned: size }])
      if (!both.result.ok) throw new Error(`expected ok, got ${both.result.class}`)
      expect(both.result.tokens.botToken).toBe(FILE_BOT_TOKEN)
      expect(lines).toEqual([])
    } else {
      expect(read).toEqual(TOO_LARGE)
      expect(digest).toBe(CREDENTIALS_UNREADABLE_MARKER)
      expect(expectFailure(both.result, PERSONA_CREDENTIALS_UNREADABLE, lines).cause).toBe(TOO_LARGE.cause)
    }
    expect(ops).toEqual([...afterOpen])
    expect(both.digest).toBe(digest)
    // The bytes of a good read are the file's own (its tokens); everything else is checked.
    assertNoLeak({ refused: read.ok ? undefined : read, digest, both, lines, json: JSON.stringify({ digest, both: both.digest }) })
  })

  // A stat that under-reports (as for a file that grows after it) or omits the
  // size: the bounded read still refuses the file, asking for no more than
  // 65,537 bytes; a read double that returns more than it was asked for is refused too.
  const regularStats = (size?: number) => () => ({ isFile: () => true, isDirectory: () => false, ...(size === undefined ? {} : { size }) })
  test.each<{ label: string; injected: Partial<CredentialsFs>; returned: number }>([
    { label: 'fstat reports 10 bytes; the real bounded read', injected: { fstatFile: regularStats(10) }, returned: 65_537 },
    { label: 'fstat reports no size; the real bounded read', injected: { fstatFile: regularStats() }, returned: 65_537 },
    {
      label: 'fstat reports 10 bytes; a read double returning the whole file whatever it is asked for',
      injected: { fstatFile: regularStats(10), readFileFd: fd => readFileSync(fd) },
      returned: 3 * 65_536,
    },
  ])('a 192 KiB credentials file where $label: unreadable as too large, the unreadable marker, the read asked for at most 65,537 bytes', ({ injected, returned }) => {
    const persona = makePersona()
    const path = writePaddedCreds(persona, 3 * 65_536)
    const { fs, ops, reads } = recordingReads(injected)
    const { lines, log } = capture()

    const read = readCredentialsFile(path, fs)
    const both = checkPersonaCredentialsAndDigest(persona, { others: [], fs: recordingReads(injected).fs, log })

    expect(read).toEqual(TOO_LARGE)
    expect(credentialsDigest(read)).toBe(CREDENTIALS_UNREADABLE_MARKER)
    expect(ops).toEqual(['fstat', 'read', 'close'])
    expect(reads).toEqual([{ maxBytes: 65_537, returned }])
    expect(both.digest).toBe(CREDENTIALS_UNREADABLE_MARKER)
    expect(expectFailure(both.result, PERSONA_CREDENTIALS_UNREADABLE, lines).cause).toBe(TOO_LARGE.cause)
    assertNoLeak({ read, both, lines })
  })

  /** `persona`'s credentials path made a symlink to `other`'s (valid) file: a real-path collision; the others list. */
  function shareFileWith(persona: BringUpPersona, other = makeOther()): OtherBringUpPersona[] {
    writeCreds(other)
    mkdirSync(join(dir, persona.key), { recursive: true })
    symlinkSync(other.credentials_file, persona.credentials_file)
    return [other]
  }

  // Rows: label, arrange (returns the others list), the expected digest (from the path).
  test.each<[string, (persona: BringUpPersona) => OtherBringUpPersona[], (path: string) => string]>([
    ['a valid file', persona => (writeCreds(persona), []), fileDigest],
    ['a missing file', () => [], () => CREDENTIALS_MISSING_MARKER],
    ['a directory at the path', persona => (mkdirSync(persona.credentials_file, { recursive: true }), []), () => CREDENTIALS_UNREADABLE_MARKER],
    ['invalid content (JSON null)', persona => (writeCreds(persona, 'null'), []), fileDigest],
    ['an empty file', persona => (writeRaw(persona, ''), []), fileDigest],
    ['bytes that are not valid UTF-8', persona => (writeRaw(persona, INVALID_UTF8), []), fileDigest],
    ['a symlink to another applied persona’s file (a collision: read only to be hashed)', persona => shareFileWith(persona), fileDigest],
  ])('checkPersonaCredentialsAndDigest for %s: the result and line are checkPersonaCredentials’s, beside the digest of what was read', (_label, arrange, expected) => {
    const persona = makePersona()
    const others = arrange(persona)
    const opens: string[] = []
    const fs: Partial<CredentialsFs> = { openFile: path => (opens.push(path), DEFAULT_CREDENTIALS_FS.openFile(path)) }
    const plain = capture()
    const withDigest = capture()

    const result = checkPersonaCredentials(persona, { others, fs, log: plain.log })
    const both = checkPersonaCredentialsAndDigest(persona, { others, fs, log: withDigest.log })

    expect(both.result).toEqual(result)
    expect(withDigest.lines).toEqual(plain.lines)
    expect(both.digest).toBe(expected(persona.credentials_file))
    // Each check opens the file once, a collision's included (Director decision 1 reversed).
    expect(opens).toEqual([persona.credentials_file, persona.credentials_file])
    if (both.digest.startsWith('sha256:')) expect(plain.lines.some(line => line.includes(both.digest.slice('sha256:'.length)))).toBe(false)
    assertNoLeak({ result, both, json: JSON.stringify(both.digest), lines: [...plain.lines, ...withDigest.lines] })
  })

  // A persona broken by a shared credentials file (Director decision 1 reversed): the file is read
  // stat-first only to be hashed, never parsed, and the collision failure is unchanged.
  // Rows: label, arrange (returns the others list and any injected fstatFile), the ops after the open, the expected digest.
  test.each<[string, (persona: BringUpPersona) => [OtherBringUpPersona[], Partial<CredentialsFs>], string[], (path: string) => string]>([
    ['a symlink to the other persona’s regular file', persona => [shareFileWith(persona), {}], ['fstat', 'read', 'close'], fileDigest],
    ['a symlink to the other persona’s file reported as a FIFO (injected fstatFile)', persona =>
      [shareFileWith(persona), { fstatFile: () => ({ isFile: () => false, isDirectory: () => false }) }],
      ['fstat', 'close'], () => CREDENTIALS_UNREADABLE_MARKER],
    ['the same non-existent path, compared lexically', persona => {
      const other = makeOther()
      persona.credentials_file = `${dir}/elsewhere/../${other.key}/credentials.json`
      return [[other], {}]
    }, [], () => CREDENTIALS_MISSING_MARKER],
  ])('a collision (%s): the file is opened once and stat-first, the digest is of its bytes, and no token reaches the result, lines or digest', (_label, arrange, afterOpen, expected) => {
    const persona = makePersona()
    const [others, injected] = arrange(persona)
    const ops: string[] = []
    const fs: Partial<CredentialsFs> = {
      openFile: path => (ops.push('open'), DEFAULT_CREDENTIALS_FS.openFile(path)),
      fstatFile: fd => (ops.push('fstat'), (injected.fstatFile ?? DEFAULT_CREDENTIALS_FS.fstatFile)(fd)),
      readFileFd: fd => (ops.push('read'), DEFAULT_CREDENTIALS_FS.readFileFd(fd)),
      closeFile: fd => (ops.push('close'), DEFAULT_CREDENTIALS_FS.closeFile(fd)),
    }
    const { lines, log } = capture()

    const { result, digest } = checkPersonaCredentialsAndDigest(persona, { others, fs, log })

    const failure = expectFailure(result, PERSONA_CREDENTIALS_INVALID, lines)
    expect(failure.cause).toContain(renderPersonaRef(others[0]!.name, others[0]!.key))
    expect(failure.cause).toContain('credentials_file')
    expect(ops).toEqual(['open', ...afterOpen])
    expect(digest).toBe(expected(persona.credentials_file))
    assertNoLeak({ result, digest, lines, json: JSON.stringify({ result, digest }) })
  })
})

// ---------------------------------------------------------------------------
// Working-directory check (SR-6.1 step 2)
// ---------------------------------------------------------------------------

describe('checkPersonaWorkingDirectory', () => {
  test.each<[string, (persona: BringUpPersona) => OtherBringUpPersona[]]>([
    ['an existing readable, searchable directory (no credentials file needed)', () => []],
    [
      'a symlink to a directory no other persona uses',
      persona => {
        const target = join(dir, 'target')
        mkdirSync(target)
        rmSync(persona.working_directory, { recursive: true })
        symlinkSync(target, persona.working_directory)
        return []
      },
    ],
    [
      'another persona uses a different directory',
      () => {
        const other = makeOther()
        makeWorkDir(other)
        return [other]
      },
    ],
    ['the list includes the persona itself (same key)', persona => [persona]],
  ])('passes for %s', (_label, arrange) => {
    const persona = makePersona()
    makeWorkDir(persona)
    const others = arrange(persona)
    const { lines, log } = capture()

    const result = checkPersonaWorkingDirectory(persona, { others, log })

    expect(result).toEqual({ ok: true })
    expect(lines).toEqual([])
  })

  test('persona-directory-missing for a path that does not exist', () => {
    const persona = makePersona()
    const { lines, log } = capture()

    const result = checkPersonaWorkingDirectory(persona, { others: [], log })

    expect(expectFailure(result, PERSONA_DIRECTORY_MISSING, lines).cause).toContain('does not exist')
  })

  test.each<[string, (persona: BringUpPersona, other: OtherBringUpPersona) => {
    persona?: BringUpPersona
    fs?: Partial<WorkingDirectoryFs>
  }, (other: OtherBringUpPersona) => string]>([
    [
      'a regular file',
      persona => {
        mkdirSync(join(dir, persona.key))
        writeFileSync(persona.working_directory, 'x')
        return {}
      },
      () => 'is not a directory',
    ],
    [
      'a directory without read permission (injected fs)',
      persona => (makeWorkDir(persona), { fs: { access: accessDenying(fsConstants.R_OK) } }),
      () => 'is not readable',
    ],
    [
      'a directory without search permission (injected fs)',
      persona => (makeWorkDir(persona), { fs: { access: accessDenying(fsConstants.X_OK) } }),
      () => 'is not searchable',
    ],
    ['a path that cannot be inspected (injected fs)', () => ({ fs: { stat: failsWith('EACCES') } }), () => 'cannot be inspected'],
    [
      'a symlink whose real path is another applied persona’s directory',
      (persona, other) => {
        makeWorkDir(other)
        mkdirSync(join(dir, persona.key))
        symlinkSync(other.working_directory, persona.working_directory)
        return {}
      },
      other => renderPersonaRef(other.name, other.key),
    ],
    [
      'the same non-existent path as another applied persona, compared lexically',
      (persona, other) => ({ persona: { ...persona, working_directory: `${dir}/elsewhere/../${other.key}/work` } }),
      other => renderPersonaRef(other.name, other.key),
    ],
  ])('persona-directory-unusable for %s', (_label, arrange, expectedCause) => {
    const other = makeOther()
    const arranged = arrange(makePersona(), other)
    const persona = arranged.persona ?? makePersona()
    const { lines, log } = capture()

    const result = checkPersonaWorkingDirectory(persona, { others: [other], fs: arranged.fs, log })

    expect(expectFailure(result, PERSONA_DIRECTORY_UNUSABLE, lines).cause).toContain(expectedCause(other))
  })

  test.skipIf(isRoot)(`persona-directory-unusable for a directory without read or search permission (real fs; ${ROOT_SKIP})`, () => {
    const persona = makePersona()
    const path = makeWorkDir(persona)
    chmodSync(path, 0o000)
    chmodded.push(path)
    const { lines, log } = capture()

    const result = checkPersonaWorkingDirectory(persona, { others: [], log })

    expect(expectFailure(result, PERSONA_DIRECTORY_UNUSABLE, lines).cause).toContain('is not readable')
  })
})

// ---------------------------------------------------------------------------
// Combined bring-up steps 1 and 2
// ---------------------------------------------------------------------------

describe('checkPersonaLocalBringUp', () => {
  test.each<[string, boolean, boolean, PersonaDiagnosticClass[]]>([
    ['both pass', true, true, []],
    ['only the credentials file is missing', false, true, [PERSONA_CREDENTIALS_MISSING]],
    ['only the working directory is missing', true, false, [PERSONA_DIRECTORY_MISSING]],
    ['both are missing', false, false, [PERSONA_CREDENTIALS_MISSING, PERSONA_DIRECTORY_MISSING]],
  ])('runs both checks and reports every failure once when %s', (_label, credsOk, dirOk, expected) => {
    const persona = makePersona()
    if (credsOk) writeCreds(persona)
    if (dirOk) makeWorkDir(persona)
    const { lines, log } = capture()

    const result = checkPersonaLocalBringUp(persona, { others: [makeOther()], log })

    assertNoLeak({ result, lines })
    expect(result.ok).toBe(expected.length === 0)
    expect(result.credentials.ok).toBe(credsOk)
    expect(result.directory.ok).toBe(dirOk)
    expect(result.failures.map(f => f.class)).toEqual(expected)
    expect(lines).toEqual(result.failures.map(f => f.line))
    if (result.credentials.ok) expect(result.credentials.tokens.botToken).toBe(FILE_BOT_TOKEN)
  })

  test('passes the injected fs to both checks', () => {
    const persona = makePersona()
    writeCreds(persona)
    makeWorkDir(persona)
    const { lines, log } = capture()

    const result = checkPersonaLocalBringUp(persona, {
      others: [],
      fs: { openFile: failsWith('EACCES'), access: accessDenying(fsConstants.X_OK) },
      log,
    })

    assertNoLeak({ result, lines })
    expect(result.failures.map(f => f.class)).toEqual([PERSONA_CREDENTIALS_UNREADABLE, PERSONA_DIRECTORY_UNUSABLE])
    expect(lines).toEqual(result.failures.map(f => f.line))
  })
})

// ---------------------------------------------------------------------------
// Environment and file-system side effects
// ---------------------------------------------------------------------------

describe('no environment read', () => {
  /** Run `fn` with both env token variables set to distinct fakes, restoring them afterwards. */
  function withEnvTokens<T>(fn: () => T): T {
    const saved = ENV_KEYS.map(key => process.env[key])
    setEnvTokens([fakeToken(BOT_TOKEN_PREFIX, 'env'), fakeToken(APP_TOKEN_PREFIX, 'env')])
    try {
      return fn()
    } finally {
      setEnvTokens(saved)
    }
  }

  test('a valid file’s tokens come from the file, not the environment, and the variables are restored', () => {
    const persona = makePersona()
    writeCreds(persona)
    const before = ENV_KEYS.map(key => process.env[key])

    const result = withEnvTokens(() => checkPersonaCredentials(persona, { others: [] }))

    expect(envTokensEqual(before)).toBe(true)
    assertNoLeak(result)
    if (!result.ok) throw new Error(`expected ok, got ${result.class}`)
    expect(result.tokens.botToken).toBe(FILE_BOT_TOKEN)
    expect(result.tokens.appToken).toBe(FILE_APP_TOKEN)
  })

  test('a missing file is still missing; the environment is never a fallback', () => {
    const persona = makePersona()
    makeWorkDir(persona)

    const [single, combined] = withEnvTokens(() => [
      checkPersonaCredentials(persona, { others: [] }),
      checkPersonaLocalBringUp(persona, { others: [] }),
    ] as const)

    assertNoLeak({ single, combined })
    expect(single.ok).toBe(false)
    expect('tokens' in single).toBe(false)
    expect(combined.failures.map(f => f.class)).toEqual([PERSONA_CREDENTIALS_MISSING])
    expect(combined.credentials).toEqual(single)
  })

  test('the check modules do not reference the environment', () => {
    for (const module of [
      'persona-credentials.ts',
      'persona-bringup.ts',
      'persona-diagnostics.ts',
      'persona-slack-validation.ts',
      'persona-retry-schedule.ts',
      'persona-slack-episodes.ts',
      'persona-bringup-controller.ts',
    ]) {
      const source = readFileSync(join(import.meta.dir, '..', 'src', module), 'utf-8')
      expect(source).not.toMatch(/process\.env|Bun\.env|import\.meta\.env/)
    }
  })
})

describe('no writes', () => {
  test.each<[string, () => () => unknown]>([
    ['credentials check on a valid 0600 file', () => {
      const persona = makePersona()
      writeCreds(persona)
      return () => checkPersonaCredentials(persona, { others: [] })
    }],
    ['credentials check on a valid 0644 file', () => {
      const persona = makePersona()
      chmodSync(writeCreds(persona), 0o644)
      return () => checkPersonaCredentials(persona, { others: [] })
    }],
    ['credentials check on invalid content', () => {
      const persona = makePersona()
      writeCreds(persona, { bot_token: fakeToken('xoxp-') })
      return () => checkPersonaCredentials(persona, { others: [] })
    }],
    ['credentials check on a real-path collision', () => {
      const persona = makePersona()
      const other = makeOther()
      writeCreds(other)
      mkdirSync(join(dir, persona.key))
      symlinkSync(other.credentials_file, persona.credentials_file)
      return () => checkPersonaCredentials(persona, { others: [other] })
    }],
    ['working-directory check on a missing directory', () => {
      const persona = makePersona()
      return () => checkPersonaWorkingDirectory(persona, { others: [] })
    }],
    ['combined check with both passing', () => {
      const persona = makePersona()
      writeCreds(persona)
      makeWorkDir(persona)
      return () => checkPersonaLocalBringUp(persona, { others: [] })
    }],
    ['combined check with a missing working directory', () => {
      const persona = makePersona()
      writeCreds(persona)
      return () => checkPersonaLocalBringUp(persona, { others: [] })
    }],
  ])('%s leaves every file’s bytes and mode unchanged and adds no file', (_label, arrange) => {
    const act = arrange()
    const before = snapshotTree(dir)

    const result = act()

    expect(snapshotTree(dir)).toEqual(before)
    assertNoLeak(result)
  })
})

// ---------------------------------------------------------------------------
// Diagnostics: rendering and logging (SR-10.3)
// ---------------------------------------------------------------------------

describe('diagnostic lines', () => {
  test('the label set is exactly the start, credentials, Slack-validation, connection, directory, unclaimed-channel, DM-drop, destination-failed and credentials-change-failed classes', () => {
    expect([...PERSONA_DIAGNOSTIC_CLASSES].sort()).toEqual([
      'persona-connection-lost',
      'persona-connection-restored',
      'persona-credentials-change-failed',
      'persona-credentials-invalid',
      'persona-credentials-missing',
      'persona-credentials-refused',
      'persona-credentials-unreadable',
      'persona-destination-failed',
      'persona-directory-missing',
      'persona-directory-unusable',
      'persona-dm-dropped',
      'persona-slack-unreachable',
      'persona-start',
      'unclaimed-channel',
    ])
  })

  // Rows: label, the check to run, and the path its diagnostic must carry.
  test.each<[
    string,
    (persona: BringUpPersona, other: OtherBringUpPersona) => PersonaCheckFailure | { ok: true },
    (persona: BringUpPersona, other: OtherBringUpPersona) => string,
  ]>([
    ['credentials missing', persona => checkPersonaCredentials(persona, { others: [] }), persona => persona.credentials_file],
    [
      'credentials unreadable',
      // The file exists; the injected open is what fails.
      persona => (writeCreds(persona), checkPersonaCredentials(persona, { others: [], fs: { openFile: failsWith('EACCES') } })),
      persona => persona.credentials_file,
    ],
    [
      'credentials invalid',
      persona => (writeCreds(persona, 'null'), checkPersonaCredentials(persona, { others: [] })),
      persona => persona.credentials_file,
    ],
    [
      'credentials collision',
      (persona, other) => checkPersonaCredentials({ ...persona, credentials_file: other.credentials_file }, { others: [other] }),
      (_persona, other) => other.credentials_file,
    ],
    ['directory missing', persona => checkPersonaWorkingDirectory(persona, { others: [] }), persona => persona.working_directory],
    [
      'directory unusable',
      persona => checkPersonaWorkingDirectory(persona, { others: [], fs: { stat: () => ({ isDirectory: () => false }) } }),
      persona => persona.working_directory,
    ],
    [
      'directory collision',
      (persona, other) => checkPersonaWorkingDirectory({ ...persona, working_directory: other.working_directory }, { others: [other] }),
      (_persona, other) => other.working_directory,
    ],
  ])('%s: the line carries the class, personas[i], the rendered name, the path and the cause', (_label, run, expectedPath) => {
    const persona = makePersona('Night Desk', { index: 3 })
    const other = makeOther()
    const result = run(persona, other)

    assertNoLeak(result)
    if (result.ok) throw new Error('expected a failure')
    const path = expectedPath(persona, other)
    expect(result.line).toContain(`${result.class}:`)
    expect(result.line).toContain('personas[3]')
    expect(result.line).toContain(renderPersonaRef(persona.name, persona.key))
    expect(result.path).toBe(path)
    expect(result.line).toContain(JSON.stringify(path))
    expect(result.line).toContain(result.cause)
  })

  test.each([
    ['a double quote and a newline', 'Night "Ops"\nDesk'],
    ['non-ASCII characters and a carriage return', 'Café\r夜勤'],
  ])('a name with %s still renders on a single line', (_label, name) => {
    const persona = makePersona(name, { index: 1 })
    const { lines, log } = capture()

    const result = checkPersonaLocalBringUp(persona, { others: [], log })

    assertNoLeak({ result, lines })
    expect(lines).toHaveLength(2)
    for (const line of lines) {
      expect(line).not.toMatch(/[\r\n]/)
      expect(line).toContain(JSON.stringify(name))
      expect(line).toContain('personas[1]')
    }
  })

  test('the path part is omitted when a diagnostic has none', () => {
    const line = formatPersonaDiagnostic({
      class: PERSONA_DIRECTORY_MISSING,
      name: 'Alpha',
      key: personaKey('Alpha'),
      index: 0,
      cause: 'no path here',
    })

    expect(line).not.toContain('path=')
    expect(line).toContain('no path here')
  })

  test.each([
    ['control characters and line separators are escaped', 'a\nb\rc\u2028d\u001be\u007ff\u0085g\u2029h', 'a\\nb\\rc\\u2028d\\u001be\\u007ff\\u0085g\\u2029h'],
    ['printable text, non-ASCII included, is unchanged', 'Café 夜勤: "quoted" (ok)', 'Café 夜勤: "quoted" (ok)'],
  ])('cause rendering: %s, keeping the line single', (_label, cause, rendered) => {
    const line = formatPersonaDiagnostic({
      class: PERSONA_CREDENTIALS_INVALID,
      name: 'Alpha',
      key: personaKey('Alpha'),
      index: 0,
      path: join(dir, 'credentials.json'),
      cause,
    })

    expect(line.endsWith(`: ${rendered}`)).toBe(true)
    expect(line).not.toMatch(/[\p{Cc}\u2028\u2029]/u)
  })

  test('with no logger, failing checks emit nothing and still return their lines', () => {
    const persona = makePersona()
    writeCreds(persona, { app_token: fakeToken('xoxa-') })
    const { value: results, outputCalls } = withSilencedOutput((): unknown[] => [
      checkPersonaCredentials(persona, { others: [] }),
      checkPersonaWorkingDirectory(persona, { others: [] }),
      checkPersonaLocalBringUp(persona, { others: [] }),
      personaCheckFailure({ class: PERSONA_DIRECTORY_MISSING, name: 'Alpha', key: 'alpha', index: 0, cause: 'x' }),
    ])

    expect(outputCalls).toBe(0)
    assertNoLeak(results)
    const [creds, directory, combined] = results as [PersonaCheckFailure, PersonaCheckFailure, { failures: PersonaCheckFailure[] }]
    expect(creds.line).toContain(PERSONA_CREDENTIALS_INVALID)
    expect(directory.line).toContain(PERSONA_DIRECTORY_MISSING)
    expect(combined.failures.map(f => f.line)).toEqual([creds.line, directory.line])
  })
})

// ---------------------------------------------------------------------------
// Success value secrecy (ENG-2)
// ---------------------------------------------------------------------------

describe('success value secrecy', () => {
  test('serializing, string-converting or inspecting a success result reveals neither token', () => {
    const persona = makePersona()
    writeCreds(persona)
    makeWorkDir(persona)
    const result = checkPersonaCredentials(persona, { others: [] })
    const combined = checkPersonaLocalBringUp(persona, { others: [] })
    if (!result.ok) throw new Error(`expected ok, got ${result.class}`)

    const renderings = [
      JSON.stringify(result),
      JSON.stringify(combined),
      JSON.stringify({ ...result.tokens }),
      String(result.tokens),
      `${result.tokens}`,
      Bun.inspect(result),
      Bun.inspect(combined),
    ]

    assertNoLeak({ result, combined, renderings })
    expect(JSON.parse(JSON.stringify(result.tokens))).toEqual({ bot_token: '[redacted]', app_token: '[redacted]' })
  })
})

// ---------------------------------------------------------------------------
// Slack validation legs, driven through the Slack stub (SR-3.2)
// ---------------------------------------------------------------------------

/**
 * One validation leg: `auth.test` checks the bot token, the Socket Mode open
 * the app token. The `web-api` check (bug b.ujn) is a running persona's call,
 * not a validation leg; it has its own block below.
 */
type Leg = Exclude<SlackValidationCheck, 'web-api'>

/** The credentials-file key each leg validates. */
const LEG_KEY = { 'auth.test': 'bot_token', 'socket-mode': 'app_token' } as const

/** How each leg's check is named in a cause. */
const LEG_CHECK_TEXT = { 'auth.test': 'auth.test', 'socket-mode': 'Socket Mode open' } as const

/** The only fields a failure outcome may hold (SR-10.3: nothing else is copied from the error). */
const OUTCOME_FIELDS = ['kind', 'class', 'check', 'key', 'reason', 'cause', 'slackError', 'status', 'retryAfter']

/** One scripted Slack answer: a Web API outcome on the `auth.test` leg, a connect outcome on the socket leg. */
type Scripted = WebApiOutcome | ConnectOutcome

/** What one validation leg produced. */
interface LegRun {
  /** The up outcome (socket leg: `start()` resolved) or the classified failure. */
  outcome: SlackValidationOutcome | { kind: 'up' }
  /** Whether the call rejected, and with what. */
  rejected: boolean
  thrown: unknown
  /** Values the socket stub emitted as `error` events. */
  socketErrors: unknown[]
  stub: ReturnType<typeof makeStubSlack>
}

/**
 * Run one validation leg against a fresh stub whose failures all carry
 * `LEAK_SENTINEL`: `auth.test` through a default-options Web API client (so a
 * request error keeps its `original`), or a socket client's `start()`.
 */
async function runLeg(leg: Leg, scripted: Scripted): Promise<LegRun> {
  const stub = makeStubSlack({ leakMarker: LEAK_SENTINEL })
  const socketErrors: unknown[] = []
  try {
    if (leg === 'auth.test') {
      stub.script.authTest.push(scripted as WebApiOutcome)
      const result = await stub.web.auth.test()
      return { outcome: botIdentityFromAuthTest(result), rejected: false, thrown: undefined, socketErrors, stub }
    }
    stub.script.connect.push(scripted as ConnectOutcome)
    const socket = stub.createSocketClient()
    socket.on('error', (error: unknown) => void socketErrors.push(error))
    await socket.start()
    return { outcome: { kind: 'up' }, rejected: false, thrown: undefined, socketErrors, stub }
  } catch (thrown) {
    return { outcome: classifySlackValidationError(thrown, leg), rejected: true, thrown, socketErrors, stub }
  }
}

/** The failure a leg produced; throws (naming only the kind) if it came up. */
async function failureVia(leg: Leg, scripted: Scripted): Promise<SlackValidationFailure> {
  const { outcome } = await runLeg(leg, scripted)
  if (outcome.kind === 'up') throw new Error(`expected a failure via ${leg}, got up`)
  assertNoLeak(outcome, `failure via ${leg}`)
  return outcome
}

/** An episode tracker for `name` (index `index`), logging into a capture stub. */
function makeTracker(name = 'Alpha', index = 0): { tracker: SlackEpisodeTracker; lines: string[]; path: string } {
  const { lines, log } = capture()
  const key = personaKey(name)
  const path = join(dir, key, 'credentials.json')
  return { tracker: createSlackEpisodeTracker({ name, key, index, path, log }), lines, path }
}

/** The class label a diagnostic line carries. */
function classOf(line: string): string | undefined {
  return /^\[slack\] ([a-z-]+): /.exec(line)?.[1]
}

/** Whether a thrown value is one the stub or the row planted the sentinel in (so the no-leak check is not vacuous). */
function carriesPlantedSentinel(thrown: unknown): boolean {
  if (typeof thrown === 'string') return true
  return typeof thrown === 'object' && thrown !== null && !(thrown instanceof SlackStartTimeoutError) && !(thrown instanceof SlackAuthTestTimeoutError)
}

const DNS: Scripted = { kind: 'dns' }
const UP = 'up' as const

/** A value shaped like a `@slack/web-api` error with `code` and `fields`, its message holding the sentinel. */
function libraryShaped(code: string, fields: Record<string, unknown>): Error {
  return Object.assign(new Error(`library-shaped ${LEAK_SENTINEL}`), { code }, fields)
}

/**
 * A rejection value whose `code`, `name` and `data` getters throw. They are
 * non-enumerable, so assertNoLeak reaches the sentinel in `message` instead of
 * tripping on a getter.
 */
function throwingGetters(): object {
  const value = { message: `boom ${LEAK_SENTINEL}` }
  for (const prop of ['code', 'name', 'data']) {
    Object.defineProperty(value, prop, {
      enumerable: false,
      get() {
        throw new Error(`getter ${LEAK_SENTINEL}`)
      },
    })
  }
  return value
}

/** Optional outcome fields copied from the error; each must name itself in the cause when present. */
const COPIED_FIELDS = ['slackError', 'status', 'retryAfter'] as const

describe('Slack validation classification (both legs, sentinel-bearing errors)', () => {
  type Kind = 'up' | 'slack-unreachable' | 'credentials-refused'
  /** Rows: label, scripted answer, class, and the outcome fields expected on each leg the row runs on. */
  type Row = [string, Scripted, Kind, Partial<Record<Leg, Record<string, unknown>>>]
  const both = (fields: Record<string, unknown>): Partial<Record<Leg, Record<string, unknown>>> =>
    ({ 'auth.test': fields, 'socket-mode': fields })

  const rows: Row[] = [
    // Up.
    ['success (auth.test with bot user ID and bot ID; socket start() resolves)', { kind: 'ok' }, 'up', both({})],
    // Slack-unreachable: not a PlatformError.
    ['a request error: connection refused', { kind: 'network' }, 'slack-unreachable', both({ reason: 'network' })],
    ['a request error: DNS failure', DNS, 'slack-unreachable', both({ reason: 'network' })],
    ['a request error: timeout', { kind: 'timeout' }, 'slack-unreachable', both({ reason: 'network' })],
    ...[500, 503, 404].map((status): Row =>
      [`HTTP status ${status}`, { kind: 'http', status }, 'slack-unreachable', both({ reason: 'http-status', status })]),
    ['rate limited with retryAfter', { kind: 'rate-limited', retryAfter: 30 }, 'slack-unreachable', both({ reason: 'rate-limited', retryAfter: 30 })],
    ['a websocket error before hello', { kind: 'websocket-error' }, 'slack-unreachable', { 'socket-mode': { reason: 'socket-closed' } }],
    ['the socket closed before hello (no rejection value)', { kind: 'closed-before-hello' }, 'slack-unreachable', { 'socket-mode': { reason: 'socket-closed' } }],
    ['apps.connections.open returned no URL', { kind: 'no-url' }, 'slack-unreachable', { 'socket-mode': { reason: 'no-url' } }],
    [
      'a plain Error',
      { kind: 'reject', value: new Error(`boom ${LEAK_SENTINEL}`) },
      'slack-unreachable',
      { 'auth.test': { reason: 'unknown' }, 'socket-mode': { reason: 'no-url' } },
    ],
    // Only a value named exactly `Error` is the library's no-URL error.
    ['a TypeError', { kind: 'reject', value: new TypeError(`boom ${LEAK_SENTINEL}`) }, 'slack-unreachable', both({ reason: 'unknown' })],
    [
      'a plain object with only a message',
      { kind: 'reject', value: { message: `apps.connections.open did not return a URL! ${LEAK_SENTINEL}` } },
      'slack-unreachable',
      both({ reason: 'unknown' }),
    ],
    ['a value whose code, name and data getters throw', { kind: 'reject', value: throwingGetters() }, 'slack-unreachable', both({ reason: 'unknown' })],
    [
      'an HTTP error whose statusCode is not a number (holds the sentinel)',
      { kind: 'reject', value: libraryShaped('slack_webapi_http_error', { statusCode: LEAK_SENTINEL }) },
      'slack-unreachable',
      both({ reason: 'http-status' }),
    ],
    ['a string rejection value', { kind: 'reject', value: `boom ${LEAK_SENTINEL}` }, 'slack-unreachable', both({ reason: 'unknown' })],
    ['a plain-object rejection value', { kind: 'reject', value: { token: fakeToken(BOT_TOKEN_PREFIX) } }, 'slack-unreachable', both({ reason: 'unknown' })],
    ['a null rejection value', { kind: 'reject', value: null }, 'slack-unreachable', both({ reason: 'unknown' })],
    [
      'an undefined rejection value',
      { kind: 'reject', value: undefined },
      'slack-unreachable',
      { 'auth.test': { reason: 'unknown' }, 'socket-mode': { reason: 'socket-closed' } },
    ],
    ['the start-timeout marker (WebSocket phase abandoned at 10 s)', { kind: 'reject', value: new SlackStartTimeoutError() }, 'slack-unreachable', both({ reason: 'timeout' })],
    ['the auth.test-timeout marker (no answer within 10 s)', { kind: 'reject', value: new SlackAuthTestTimeoutError() }, 'slack-unreachable', { 'auth.test': { reason: 'timeout' } }],
    [
      'auth.test success without the bot user ID',
      { kind: 'ok', result: { user_id: undefined } },
      'slack-unreachable',
      { 'auth.test': { reason: 'no-identity' } },
    ],
    ['auth.test success without the bot ID', { kind: 'ok', result: { bot_id: undefined } }, 'slack-unreachable', { 'auth.test': { reason: 'no-identity' } }],
    ['auth.test success with an empty bot user ID', { kind: 'ok', result: { user_id: '' } }, 'slack-unreachable', { 'auth.test': { reason: 'no-identity' } }],
    ['auth.test success with an empty bot ID', { kind: 'ok', result: { bot_id: '' } }, 'slack-unreachable', { 'auth.test': { reason: 'no-identity' } }],
    // Slack-unreachable: the transient PlatformErrors.
    ...['internal_error', 'fatal_error', 'service_unavailable', 'request_timeout', 'ratelimited'].map((error): Row =>
      [`PlatformError ${error}`, { kind: 'platform', error }, 'slack-unreachable', both({ reason: 'platform-transient', slackError: error })]),
    [
      'PlatformError ratelimited with response_metadata.retryAfter',
      { kind: 'platform', error: 'ratelimited', retryAfter: 20 },
      'slack-unreachable',
      both({ reason: 'platform-transient', slackError: 'ratelimited', retryAfter: 20 }),
    ],
    // Slack-unreachable: a PlatformError without a well-formed Slack error code
    // (the library builds these from a 200 body that is not JSON). Decision on
    // t3.ob2.z9.pa.y4: a transport fault, never a refusal.
    ['a PlatformError without data.error', { kind: 'platform' }, 'slack-unreachable', both({ reason: 'unknown' })],
    ['a PlatformError whose error is empty', { kind: 'platform', error: '' }, 'slack-unreachable', both({ reason: 'unknown' })],
    [
      'a PlatformError whose error is an HTML page (holds the sentinel)',
      { kind: 'platform', error: `<!DOCTYPE html><html><body>${LEAK_SENTINEL}</body></html>` },
      'slack-unreachable',
      both({ reason: 'unknown' }),
    ],
    ['a PlatformError whose error is the bare sentinel', { kind: 'platform', error: LEAK_SENTINEL }, 'slack-unreachable', both({ reason: 'unknown' })],
    [
      'a PlatformError whose error is a lowercase identifier longer than 64 characters',
      { kind: 'platform', error: `invalid_auth_${'x'.repeat(60)}` },
      'slack-unreachable',
      both({ reason: 'unknown' }),
    ],
    [
      'a PlatformError whose error is not a short lowercase identifier (holds the sentinel)',
      { kind: 'platform', error: `invalid_auth ${LEAK_SENTINEL}` },
      'slack-unreachable',
      both({ reason: 'unknown' }),
    ],
    [
      'a PlatformError whose error is not a string',
      { kind: 'reject', value: libraryShaped('slack_webapi_platform_error', { data: { ok: false, error: 401 } }) },
      'slack-unreachable',
      both({ reason: 'unknown' }),
    ],
    // Credentials refused: every other PlatformError.
    ...['not_authed', 'invalid_auth', 'account_inactive', 'token_revoked', 'token_expired', 'not_allowed_token_type', 'missing_scope'].map(
      (error): Row => [`PlatformError ${error}`, { kind: 'platform', error }, 'credentials-refused', both({ slackError: error })],
    ),
  ]

  test.each(
    rows.flatMap(([label, scripted, kind, legs]) =>
      (Object.entries(legs) as [Leg, Record<string, unknown>][]).map(([leg, fields]) => [label, leg, scripted, kind, fields] as const),
    ),
  )('%s via %s', async (_label, leg, scripted, kind, fields) => {
    const run = await runLeg(leg, scripted)
    // Each outcome also goes through an episode tracker: start, then clear.
    const { tracker, lines } = makeTracker()
    const returned = [...tracker.record(run.outcome), ...tracker.record({ kind: 'up' })]

    assertNoLeak({ outcome: run.outcome, lines, returned }, `${kind} via ${leg}`)
    if (run.rejected && carriesPlantedSentinel(run.thrown)) expect(() => assertNoLeak(run.thrown)).toThrow()
    expect(run.outcome.kind).toBe(kind)
    expect(returned).toEqual(lines)
    if (run.outcome.kind === 'up') {
      expect(lines).toEqual([])
      if ('identity' in run.outcome) {
        expect(run.outcome.identity).toEqual({ botUserId: run.stub.identity.botUserId, botId: run.stub.identity.botId })
      }
      return
    }
    const cls = kind === 'credentials-refused' ? PERSONA_CREDENTIALS_REFUSED : PERSONA_SLACK_UNREACHABLE
    expect(run.outcome).toMatchObject({ class: cls, check: leg, key: LEG_KEY[leg], ...fields })
    expect(Object.keys(run.outcome).filter(field => !OUTCOME_FIELDS.includes(field))).toEqual([])
    expect(run.outcome.cause).toContain(LEG_KEY[leg])
    expect(run.outcome.cause).toContain(LEG_CHECK_TEXT[leg])
    // A copied field is on the outcome only when the row expects it, and the cause names it.
    for (const field of COPIED_FIELDS) {
      if (field in fields) expect(run.outcome.cause).toContain(String(fields[field]))
      else expect(run.outcome).not.toHaveProperty(field)
    }
    expect(lines.map(classOf)).toEqual([cls, cls])
  })

  test('a websocket error: the emitted socket-mode error and the start() rejection are both Slack-unreachable', async () => {
    const run = await runLeg('socket-mode', { kind: 'websocket-error' })
    expect(run.socketErrors).toHaveLength(1)
    const emitted = classifySlackValidationError(run.socketErrors[0], 'socket-mode')

    assertNoLeak({ emitted, outcome: run.outcome })
    expect(() => assertNoLeak(run.socketErrors)).toThrow()
    expect(emitted).toMatchObject({ kind: 'slack-unreachable', reason: 'network', key: 'app_token' })
    expect(run.outcome).toMatchObject({ kind: 'slack-unreachable', reason: 'socket-closed', key: 'app_token' })
  })
})

// ---------------------------------------------------------------------------
// Backoff schedule and retryAfter (SR-3.2)
// ---------------------------------------------------------------------------

/** The SR-3.2 ladder in seconds; the schedule's API is milliseconds. */
const LADDER_S = [5, 10, 20, 40, 80, 160, 300, 300]

/** The plain wait after `priorFailures` failures, in milliseconds. */
function stepMs(priorFailures: number): number {
  return LADDER_S[Math.min(priorFailures, LADDER_S.length - 1)]! * 1000
}

/** A schedule that has already recorded `failures` plain failures. */
function scheduleAfter(failures: number): ReturnType<typeof createPersonaRetrySchedule> {
  const schedule = createPersonaRetrySchedule()
  for (let i = 0; i < failures; i++) schedule.nextDelayMs()
  return schedule
}

describe('backoff schedule', () => {
  test('successive Slack-unreachable attempts wait 5, 10, 20, 40, 80, 160, 300, 300 s', async () => {
    const schedule = createPersonaRetrySchedule()
    const waits: number[] = []
    for (let i = 0; i < 8; i++) {
      const outcome = await failureVia('auth.test', DNS)
      waits.push(schedule.nextDelayMs(outcome.kind === 'slack-unreachable' ? outcome.retryAfter : undefined))
    }

    expect(waits).toEqual([5_000, 10_000, 20_000, 40_000, 80_000, 160_000, 300_000, 300_000])
  })

  test('no cap: after 100 attempts the persona still waits 300 s, is still Slack-unreachable and has one open episode', async () => {
    const schedule = createPersonaRetrySchedule()
    const { tracker, lines } = makeTracker()
    const kinds = new Set<string>()
    const waits: number[] = []
    for (let i = 0; i < 100; i++) {
      const outcome = await failureVia(i % 2 === 0 ? 'auth.test' : 'socket-mode', DNS)
      kinds.add(outcome.kind)
      tracker.record(outcome)
      waits.push(schedule.nextDelayMs())
    }

    assertNoLeak({ lines })
    expect([...kinds]).toEqual(['slack-unreachable'])
    expect(waits.slice(6)).toEqual(Array(94).fill(300_000))
    expect(schedule.failures).toBe(100)
    expect(tracker.open).toBe(PERSONA_SLACK_UNREACHABLE)
    expect(lines).toHaveLength(1)
    for (let i = 0; i < 10_000; i++) schedule.nextDelayMs()
    expect(schedule.nextDelayMs()).toBe(300_000)
  })

  test('reset: after reset() (the caller’s call when Slack answers) the next outage starts again at 5 s', () => {
    const schedule = scheduleAfter(4)

    schedule.reset()

    expect(schedule.failures).toBe(0)
    expect([schedule.nextDelayMs(), schedule.nextDelayMs()]).toEqual([5_000, 10_000])
  })

  test('isolation: two personas’ ladders are independent', () => {
    const a = scheduleAfter(5)
    const b = createPersonaRetrySchedule()

    expect(b.nextDelayMs()).toBe(5_000)
    expect(b.nextDelayMs(600)).toBe(600_000)
    expect(a.nextDelayMs()).toBe(160_000)
    a.reset()
    expect(b.nextDelayMs()).toBe(20_000)
    expect([a.failures, b.failures]).toEqual([0, 3])
  })

  test.each([Number.NaN, -1, Number.POSITIVE_INFINITY])('the schedule ignores a retryAfter of %p and takes the plain step', retryAfter => {
    const schedule = createPersonaRetrySchedule()

    expect(schedule.nextDelayMs(retryAfter)).toBe(5_000)
    expect(schedule.failures).toBe(1)
  })
})

describe('retryAfter', () => {
  // Rows: label, scripted answer, failures already recorded, the retryAfter
  // (seconds) the outcome carries, and the expected wait (milliseconds).
  test.each<[string, Scripted, number, number | undefined, number]>([
    ['a rate-limited error longer than the step waits retryAfter', { kind: 'rate-limited', retryAfter: 30 }, 0, 30, 30_000],
    ['a rate-limited error shorter than the step leaves the step', { kind: 'rate-limited', retryAfter: 3 }, 2, 3, 20_000],
    ['a rate-limited error above the 300 s ceiling is still honoured', { kind: 'rate-limited', retryAfter: 900 }, 7, 900, 900_000],
    ['a ratelimited PlatformError with retryAfter waits retryAfter', { kind: 'platform', error: 'ratelimited', retryAfter: 45 }, 0, 45, 45_000],
    ['a ratelimited PlatformError with a shorter retryAfter leaves the step', { kind: 'platform', error: 'ratelimited', retryAfter: 1 }, 3, 1, 40_000],
    ['a ratelimited PlatformError without retryAfter takes the plain step', { kind: 'platform', error: 'ratelimited' }, 1, undefined, 10_000],
    ['a negative retryAfter is ignored', { kind: 'rate-limited', retryAfter: -1 }, 1, undefined, 10_000],
    ['a NaN retryAfter is ignored', { kind: 'platform', error: 'ratelimited', retryAfter: Number.NaN }, 0, undefined, 5_000],
    ['a retryAfter beyond the largest timer delay is clamped to it', { kind: 'rate-limited', retryAfter: 1e9 }, 0, 1e9, MAX_TIMER_DELAY_MS],
  ])('%s', async (_label, scripted, prior, retryAfter, expectedMs) => {
    for (const leg of ['auth.test', 'socket-mode'] as const) {
      const outcome = await failureVia(leg, scripted)
      const schedule = scheduleAfter(prior)
      if (outcome.kind !== 'slack-unreachable') throw new Error(`expected slack-unreachable via ${leg}, got ${outcome.kind}`)

      const wait = schedule.nextDelayMs(outcome.retryAfter)

      assertNoLeak(outcome)
      expect(outcome.retryAfter).toBe(retryAfter)
      expect(wait).toBe(expectedMs)
      // Never shorter than retryAfter, up to the largest delay a timer honours.
      expect(wait).toBeGreaterThanOrEqual(Math.min((retryAfter ?? 0) * 1000, MAX_TIMER_DELAY_MS))
      // Rate limiting advances the ladder like any other failure.
      expect(schedule.nextDelayMs()).toBe(stepMs(prior + 1))
    }
  })
})

// ---------------------------------------------------------------------------
// Episode logging (SR-10.3)
// ---------------------------------------------------------------------------

describe('Slack episode lines', () => {
  const U = PERSONA_SLACK_UNREACHABLE
  const R = PERSONA_CREDENTIALS_REFUSED
  type Step = Scripted | typeof UP
  const refused = (error: string): Scripted => ({ kind: 'platform', error })

  // Rows: label, the auth.test answers in order, and the expected lines as [class, start | cleared].
  test.each<[string, Step[], [string, 'start' | 'cleared'][]]>([
    ['several unreachable attempts, then success: one start line, one cleared line', [DNS, DNS, { kind: 'network' }, UP], [[U, 'start'], [U, 'cleared']]],
    ['success with no open episode: nothing', [UP, UP], []],
    ['a later outage starts a new episode', [DNS, UP, DNS, UP], [[U, 'start'], [U, 'cleared'], [U, 'start'], [U, 'cleared']]],
    [
      'the reason kind changes inside one outage: one start line',
      [DNS, { kind: 'rate-limited', retryAfter: 30 }, { kind: 'http', status: 503 }, refused('internal_error'), { kind: 'reject', value: new SlackStartTimeoutError() }],
      [[U, 'start']],
    ],
    [
      'unreachable, then refused twice, then success',
      [DNS, { kind: 'rate-limited', retryAfter: 30 }, refused('invalid_auth'), refused('token_revoked'), UP],
      [[U, 'start'], [U, 'cleared'], [R, 'start'], [R, 'cleared']],
    ],
    ['refused, then unreachable', [refused('invalid_auth'), DNS], [[R, 'start'], [R, 'cleared'], [U, 'start']]],
  ])('%s', async (_label, steps, expected) => {
    const { tracker, lines } = makeTracker()
    const returned: string[] = []
    for (const step of steps) {
      const outcome = step === UP ? { kind: 'up' as const } : await failureVia('auth.test', step)
      returned.push(...tracker.record(outcome))
    }

    assertNoLeak({ lines, returned })
    expect(returned).toEqual(lines)
    expect(lines.map(line => [classOf(line), /\bcleared\b/.test(line) ? 'cleared' : 'start'])).toEqual(expected)
  })

  test.each(['auth.test', 'socket-mode'] as const)('lines via %s carry the class, personas[i], the quoted name and key, the path; refused names code, key and check', async leg => {
    const name = 'Night "Ops"\nDesk'
    const { tracker, lines, path } = makeTracker(name, 2)
    for (const step of [DNS, refused('invalid_auth'), UP]) {
      tracker.record(step === UP ? { kind: 'up' } : await failureVia(leg, step))
    }

    assertNoLeak({ lines })
    expect(lines.map(classOf)).toEqual([U, U, R, R])
    for (const line of lines) {
      expect(line).not.toMatch(/[\r\n]/)
      expect(line).toContain('personas[2]')
      expect(line).toContain(renderPersonaRef(name, personaKey(name)))
      expect(line).toContain(`path=${JSON.stringify(path)}`)
    }
    const refusedLine = lines[2]!
    expect(refusedLine).toContain('invalid_auth')
    expect(refusedLine).toContain(LEG_KEY[leg])
    expect(refusedLine).toContain(LEG_CHECK_TEXT[leg])
  })

  test('with no logger nothing is emitted and each line is still returned', async () => {
    const path = join(dir, personaKey('Alpha'), 'credentials.json')
    const tracker = createSlackEpisodeTracker({ name: 'Alpha', key: personaKey('Alpha'), index: 0, path })
    const outcome = await failureVia('auth.test', DNS)

    const { value: returned, outputCalls } = withSilencedOutput(() => [tracker.record(outcome), tracker.record({ kind: 'up' })])

    assertNoLeak(returned)
    expect(outputCalls).toBe(0)
    expect(returned.map(lines => lines.map(classOf))).toEqual([[U], [U]])
    for (const line of returned.flat()) expect(line).toContain(`path=${JSON.stringify(path)}`)
  })

  test('two personas’ trackers are independent', async () => {
    const a = makeTracker('Alpha', 0)
    const b = makeTracker('Beta', 1)

    a.tracker.record(await failureVia('auth.test', DNS))
    const bUp = b.tracker.record({ kind: 'up' })
    b.tracker.record(await failureVia('socket-mode', refused('invalid_auth')))
    a.tracker.record({ kind: 'up' })

    assertNoLeak({ a: a.lines, b: b.lines })
    expect(bUp).toEqual([])
    expect(a.lines.map(classOf)).toEqual([U, U])
    expect(b.lines.map(classOf)).toEqual([R])
    expect([a.tracker.open, b.tracker.open]).toEqual([null, R])
    expect(b.lines[0]).toContain('personas[1]')
  })

  // Rows: the open episode's class and how it is opened.
  test.each<[PersonaDiagnosticClass, (tracker: SlackEpisodeTracker) => Promise<void>]>([
    [U, async tracker => void tracker.record(await failureVia('auth.test', DNS))],
    [R, async tracker => void tracker.record(await failureVia('socket-mode', refused('invalid_auth')))],
    [PERSONA_CONNECTION_LOST, async tracker => void tracker.record({ kind: 'connection-lost' })],
  ])('end(reason) closes an open %s episode with exactly one line, its class and `cleared: <reason>`; then nothing is open and neither end() nor up logs again', async (cls, open) => {
    const name = 'Night "Ops" Desk'
    const { tracker, lines, path } = makeTracker(name, 2)
    await open(tracker)
    expect(lines).toHaveLength(1)

    const ended = tracker.end('the attempts it covered were abandoned')

    const expected = formatPersonaDiagnostic({
      class: cls,
      name,
      key: personaKey(name),
      index: 2,
      path,
      cause: 'cleared: the attempts it covered were abandoned',
    })
    expect(ended).toEqual([expected])
    expect(lines.slice(1)).toEqual([expected])
    expect(tracker.open).toBeNull()
    expect(tracker.end('again')).toEqual([])
    expect(tracker.record({ kind: 'up' })).toEqual([])
    expect(lines).toHaveLength(2)
    // The latch is reset: the next failure opens a new episode with its start line.
    expect(tracker.record(await failureVia('auth.test', DNS)).map(classOf)).toEqual([U])
    assertNoLeak({ lines, ended })
  })

  test('end(reason) with no episode open logs and returns nothing: a fresh tracker, and one whose episode already cleared', async () => {
    const { tracker, lines } = makeTracker()

    expect(tracker.end('nothing to end')).toEqual([])
    tracker.record(await failureVia('auth.test', DNS))
    tracker.record({ kind: 'up' })
    expect(lines.map(classOf)).toEqual([U, U])

    expect(tracker.end('nothing to end')).toEqual([])
    expect(lines).toHaveLength(2)
    expect(tracker.open).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// Connection manager harness (E2 Task 3; E5 extends these sections)
// ---------------------------------------------------------------------------

/** A persona the manager runs, with the tokens the credentials reader returned (none in dry run). */
interface ManagedPersona extends BringUpPersona {
  tokens?: PersonaSlackTokens
}

/** One event as the handler received it. */
interface ForwardedEvent {
  key: string
  eventName: PersonaSocketEventName
  payload: PersonaSocketEventPayload
}

/** Two personas A and B under one manager, with a stub Slack, a fake clock and captured output. */
interface Harness {
  manager: PersonaConnectionManager
  clock: FakeClock
  slack: StubSlackFactory
  a: ManagedPersona
  b: ManagedPersona
  lines: string[]
  events: ForwardedEvent[]
  statuses: [string, PersonaConnectionStatus][]
  /**
   * An agent-director recorder beside the manager, as E3's wiring will hold
   * one. The manager has no agent-director dependency (decisions.md), so its
   * count stays zero unless that changes; the SR-13.1 source check pins the
   * missing import.
   */
  agentDirector: { callCount(): number }
}

interface HarnessOptions {
  dryRun?: boolean
  /** Names of A and B (indices 0 and 1). Default Alpha and Beta. */
  names?: [string, string]
  /** Called after each event is recorded. */
  onEvent?: PersonaEventHandler
  /** Called after each status report is recorded (a status listener beside the recorder). */
  onStatus?: (key: string, status: PersonaConnectionStatus) => void
  /** The per-persona serializer's `run`, passed to the manager as `serialize` (bug b.ujn). Default: none, so the close runs at once. */
  serialize?: PersonaSerialize
}

/** Harnesses built in the running test; stopped and leak-checked after it. */
const harnesses: Harness[] = []

afterEach(async () => {
  for (const h of harnesses.splice(0)) {
    await h.manager.stopAll()
    // Every status report, log line and forwarded event of the test, stop included.
    assertNoLeak({ lines: h.lines, statuses: h.statuses, events: h.events }, 'connection harness')
  }
})

/** The distinct tokens written to `persona`'s credentials file. */
function fileTokensOf(persona: BringUpPersona): { botToken: string; appToken: string } {
  return { botToken: fakeToken(BOT_TOKEN_PREFIX, `${persona.key}-bot`), appToken: fakeToken(APP_TOKEN_PREFIX, `${persona.key}-app`) }
}

/** Write `persona`'s credentials file and read it back through the Task 1 reader (AC 47: tokens come from the file). */
function readTokens(persona: BringUpPersona): PersonaSlackTokens {
  const { botToken, appToken } = fileTokensOf(persona)
  writeCreds(persona, { bot_token: botToken, app_token: appToken })
  const result = checkPersonaCredentials(persona, { others: [] })
  if (!result.ok) throw new Error(`expected readable credentials, got ${result.class}`)
  return result.tokens
}

/** An agent-director stub whose every verb records into a list; `callCount` sums them. */
function makeAgentDirectorRecorder(): { callCount(): number } {
  const calls = makeStubCallLog()
  makeStubClient(calls)
  return { callCount: () => stubCallCount(calls) }
}

/**
 * Build a manager over personas A and B. Outside dry run each persona's
 * credentials file is written and read, and its stub (leak marker on) is
 * registered with the factory.
 */
function makeHarness(opts: HarnessOptions = {}): Harness {
  const dryRun = opts.dryRun ?? false
  const clock = createFakeClock()
  const slack = makeStubSlackFactory()
  const lines: string[] = []
  const events: ForwardedEvent[] = []
  const statuses: [string, PersonaConnectionStatus][] = []
  const [a, b] = (opts.names ?? ['Alpha', 'Beta']).map((name, index): ManagedPersona => {
    const persona = makePersona(name, { index })
    if (dryRun) return persona
    const tokens = readTokens(persona)
    slack.addPersona(persona.key, tokens, { leakMarker: LEAK_SENTINEL })
    return { ...persona, tokens }
  }) as [ManagedPersona, ManagedPersona]
  const manager = createPersonaConnectionManager({
    dryRun,
    factory: slack.factory,
    clock,
    log: line => void lines.push(line),
    onStatus: (key, status) => {
      statuses.push([key, status])
      opts.onStatus?.(key, status)
    },
    onEvent: (key, eventName, payload) => {
      events.push({ key, eventName, payload })
      return opts.onEvent?.(key, eventName, payload)
    },
    serialize: opts.serialize,
  })
  const h: Harness = { manager, clock, slack, a, b, lines, events, statuses, agentDirector: makeAgentDirectorRecorder() }
  harnesses.push(h)
  return h
}

/** Bring A and B up and check both are up. */
async function bringUpBoth(h: Harness): Promise<void> {
  for (const p of [h.a, h.b]) expect(await h.manager.bringUp(p, p.tokens)).toMatchObject({ state: 'up' })
}

/** The persona's stub: `socket` is its latest socket client, `sockets` every one built. */
function stubOf(h: Harness, p: ManagedPersona): StubSlack {
  return h.slack.persona(p.key)
}

/** `start()` calls over all of the persona's socket clients. */
function startsOf(h: Harness, p: ManagedPersona): number {
  return stubOf(h, p).sockets.reduce((sum, socket) => sum + socket.startCalls, 0)
}

/** How many of the persona's socket clients are connected. */
function liveSocketsOf(h: Harness, p: ManagedPersona): number {
  return stubOf(h, p).sockets.filter(socket => socket.connected).length
}

/** The persona's reported states, in order. */
function statesOf(h: Harness, p: ManagedPersona): string[] {
  return h.statuses.filter(([key]) => key === p.key).map(([, status]) => status.state)
}

/** Requested delays of the pending timers, earliest first. */
function pendingDelays(h: Harness): number[] {
  return h.clock.pending().map(timer => timer.delayMs)
}

let deliverySeq = 0

/**
 * Deliver a uniquely-texted message on the persona's latest socket (of `stub`,
 * default its initial credential set's); it must reach the handler exactly
 * once, tagged with that persona.
 */
async function expectDelivers(h: Harness, p: ManagedPersona, stub: StubSlack = stubOf(h, p)): Promise<void> {
  const text = `delivery ${++deliverySeq} on ${p.key}`
  await stub.socket.deliver(makeChannelMessage({ text }))
  expect(h.events.filter(e => e.payload.event?.text === text).map(e => e.key)).toEqual([p.key])
}

/**
 * A `@slack/web-api`-shaped error with `code`, carrying the sentinel in its
 * message, its `original` (message and Authorization header), its response
 * headers and `data`, never in `data.error` (set to `slackError` when given).
 */
function sentinelSlackError(code: string, slackError?: string): Error {
  const original = Object.assign(new Error(`socket hang up ${LEAK_SENTINEL}`), {
    code: 'ECONNRESET',
    config: { headers: { Authorization: `Bearer ${fakeToken(BOT_TOKEN_PREFIX, 'original')}` } },
  })
  const data: Record<string, unknown> = { ok: false, provided: LEAK_SENTINEL }
  if (slackError !== undefined) data.error = slackError
  return Object.assign(new Error(`A request error occurred: ${LEAK_SENTINEL}`), {
    code,
    original,
    headers: { 'x-slack-req-id': LEAK_SENTINEL, authorization: `Bearer ${fakeToken(APP_TOKEN_PREFIX, 'header')}` },
    data,
  })
}

const HOUR_MS = 3_600_000

// ---------------------------------------------------------------------------
// Bring-up and identity (SR-3.1)
// ---------------------------------------------------------------------------

describe('connection manager: bring-up and identity (SR-3.1)', () => {
  test('a persona is up once auth.test on its own validation client returned both IDs, before its socket is built and started', async () => {
    const h = makeHarness()

    await bringUpBoth(h)

    for (const p of [h.a, h.b]) {
      const stub = stubOf(h, p)
      const identity = { botUserId: stub.identity.botUserId, botId: stub.identity.botId }
      expect(h.manager.status(p.key)).toEqual({ state: 'up', identity })
      expect(h.manager.identity(p.key)).toEqual(identity)
      expect(h.slack.buildsOf(p.key).map(build => build.kind)).toEqual(['validation', 'web', 'socket'])
      expect(stub.calls.authTest).toHaveLength(1)
      expect(stub.socket.startCalls).toBe(1)
      expect(h.manager.webClient(p.key)).toBeDefined()
      expect(statesOf(h, p)).toEqual(['connecting', 'up'])
    }
    expect(h.manager.identity(h.a.key)).not.toEqual(h.manager.identity(h.b.key))
    expect(h.clock.pendingCount()).toBe(0)
  })

  test.each([
    ['the bot user ID', { user_id: undefined }],
    ['the bot ID', { bot_id: undefined }],
  ])('an auth.test answer without %s leaves the persona retrying with no socket; the retry re-runs auth.test', async (_label, result) => {
    const h = makeHarness()
    stubOf(h, h.a).script.authTest.push({ kind: 'ok', result })

    const status = await h.manager.bringUp(h.a, h.a.tokens)

    expect(status).toMatchObject({
      state: 'retrying',
      phase: 'bring-up',
      retryInMs: 5_000,
      outcome: { kind: 'slack-unreachable', check: 'auth.test', reason: 'no-identity' },
    })
    expect(h.slack.buildsOf(h.a.key, 'socket')).toEqual([])
    expect(h.manager.identity(h.a.key)).toBeUndefined()
    expect(h.manager.webClient(h.a.key)).toBeUndefined()
    await h.clock.advance(5_000)
    expect(stubOf(h, h.a).calls.authTest).toHaveLength(2)
    expect(h.manager.status(h.a.key)).toMatchObject({ state: 'up' })
  })

  test('a refused auth.test leaves the persona credentials-broken: no socket built or started, never retried', async () => {
    const h = makeHarness()
    stubOf(h, h.a).script.authTest.push({ kind: 'platform', error: 'invalid_auth' })

    const status = await h.manager.bringUp(h.a, h.a.tokens)
    await h.clock.advance(24 * HOUR_MS)

    expect(status).toMatchObject({
      state: 'broken',
      phase: 'bring-up',
      outcome: { kind: 'credentials-refused', check: 'auth.test', key: 'bot_token', slackError: 'invalid_auth' },
    })
    expect(h.slack.buildsOf(h.a.key).map(build => build.kind)).toEqual(['validation'])
    expect(stubOf(h, h.a).calls.authTest).toHaveLength(1)
    expect(h.clock.pendingCount()).toBe(0)
    expect(h.lines.map(classOf)).toEqual([PERSONA_CREDENTIALS_REFUSED])
  })

  test('bring-up outside dry run without credentials rejects with a TypeError and builds nothing', async () => {
    const h = makeHarness()

    const thrown = await h.manager.bringUp(h.a).catch((err: unknown) => err)

    assertNoLeak(thrown)
    expect(thrown).toBeInstanceOf(TypeError)
    expect(h.slack.builds).toEqual([])
    expect(h.manager.status(h.a.key)).toBeUndefined()
  })

  test('bringing up a persona already managed returns its status and builds nothing more', async () => {
    const h = makeHarness()
    await bringUpBoth(h)
    const builds = h.slack.builds.length

    expect(await h.manager.bringUp(h.a, h.a.tokens)).toEqual(h.manager.status(h.a.key)!)
    expect(h.slack.builds).toHaveLength(builds)
  })
})

// ---------------------------------------------------------------------------
// Client options (SR-3.3, AC 20 connection leg) and tokens (AC 47)
// ---------------------------------------------------------------------------

describe('connection manager: client options (SR-3.3, AC 20 connection leg) and tokens from the file (AC 47)', () => {
  const NO_RETRY = { retryConfig: { retries: 0 }, timeout: 10_000, rejectRateLimitedCalls: true, attachOriginalToWebAPIRequestError: false }

  // The long-lived client keeps the library's retry policy: no retryConfig, no rejectRateLimitedCalls.
  // Rows: kind, its exact options, and how many are built across A's bring-up and reopen and B's bring-up.
  test.each<[StubClientKind, Record<string, unknown>, number]>([
    ['socket', { autoReconnectEnabled: false, clientOptions: NO_RETRY }, 3],
    ['validation', NO_RETRY, 2],
    ['web', { timeout: 30_000, attachOriginalToWebAPIRequestError: false }, 2],
  ])('every %s client, a reopen’s included, is built with exactly the SR-3.3 options', async (kind, expected, count) => {
    const h = makeHarness()
    await bringUpBoth(h)
    stubOf(h, h.a).socket.drop()
    await h.clock.flush()
    expect(h.manager.status(h.a.key)).toMatchObject({ state: 'up' })

    const builds = h.slack.builds.filter(build => build.kind === kind)

    // A's bring-up socket and its reopen socket.
    expect(h.slack.buildsOf(h.a.key, 'socket')).toHaveLength(2)
    expect(builds).toHaveLength(count)
    for (const build of builds) {
      const options: Record<string, unknown> = { ...build.options }
      delete options.appToken
      expect(options).toStrictEqual(expected)
    }
  })

  test('AC 47: every client receives the credentials file’s tokens, never the environment’s', async () => {
    const envTokens = [fakeToken(BOT_TOKEN_PREFIX, 'env-connection'), fakeToken(APP_TOKEN_PREFIX, 'env-connection')] as const
    const saved = ENV_KEYS.map(key => process.env[key])
    setEnvTokens(envTokens)
    try {
      const h = makeHarness()
      await bringUpBoth(h)

      expect(h.slack.builds).toHaveLength(6)
      for (const build of h.slack.builds) {
        const file = fileTokensOf(build.persona === h.a.key ? h.a : h.b)
        const [fromFile, fromEnv] = build.kind === 'socket' ? [file.appToken, envTokens[1]] : [file.botToken, envTokens[0]]
        expect(build.hasToken(fromFile)).toBe(true)
        expect(build.hasToken(fromEnv)).toBe(false)
      }
    } finally {
      setEnvTokens(saved)
    }
    expect(envTokensEqual(saved)).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// No module-scope effects (SR-13.1)
// ---------------------------------------------------------------------------

const CONNECTION_MODULES = [
  'persona-connections.ts',
  'persona-slack-clients.ts',
  'persona-connection-errors.ts',
  'persona-bringup-controller.ts',
]

describe('connection manager: no module-scope effects (SR-13.1)', () => {
  test('creating a manager builds no client, schedules no timer and reports nothing until a persona is brought up', () => {
    const h = makeHarness()

    expect(h.slack.builds).toEqual([])
    expect(h.clock.pendingCount()).toBe(0)
    expect(h.statuses).toEqual([])
  })

  test.each(CONNECTION_MODULES)('importing %s afresh adds no unhandledRejection listener', async module => {
    const before = process.listenerCount('unhandledRejection')

    await import(`../src/${module}?fresh=${crypto.randomUUID()}`)

    expect(process.listenerCount('unhandledRejection')).toBe(before)
  })

  test('the connection modules read no environment variable, import no file-system module and import nothing from agent-director', () => {
    // Static, bare side-effect, dynamic and require forms of a module reference naming agent-director.
    const agentDirectorImport = /(?:from\s*|import\s*\(?\s*|require\s*\()['"][^'"]*agent-director/
    for (const form of [
      `import { x } from './agent-director-client.ts'`,
      `import type { X } from "./agent-director.ts"`,
      `import './agent-director.ts'`,
      `await import('./agent-director-client.ts')`,
      `require("./agent-director")`,
    ]) {
      expect(form).toMatch(agentDirectorImport)
    }
    for (const module of CONNECTION_MODULES) {
      const source = readFileSync(join(import.meta.dir, '..', 'src', module), 'utf-8')
      expect(source).not.toMatch(/process\.env|Bun\.env|import\.meta\.env/)
      expect(source).not.toMatch(/from ['"](?:node:)?fs(?:\/promises)?['"]/)
      expect(source).not.toMatch(agentDirectorImport)
    }
  })
})

// ---------------------------------------------------------------------------
// Event tagging and isolation (SR-3.1)
// ---------------------------------------------------------------------------

describe('connection manager: event tagging and isolation (SR-3.1)', () => {
  test('message, app_mention and interactive events reach the handler tagged with their own persona, payload unchanged, never acked by the manager', async () => {
    const h = makeHarness()
    await bringUpBoth(h)
    const sent: [string, PersonaSocketEventName, Record<string, unknown>][] = []

    for (const p of [h.a, h.b]) {
      const stub = stubOf(h, p)
      const message = makeChannelMessage({ text: `message for ${p.key}` })
      const mention = makeAppMention({ text: `${mentionText(stub.identity.botUserId)} hello` })
      const click = { type: 'block_actions', actions: [{ action_id: `click-${p.key}` }] }
      await stub.socket.deliver(message)
      await stub.socket.deliver(mention)
      await stub.socket.deliverInteractive(click)
      sent.push([p.key, 'message', message], [p.key, 'app_mention', mention], [p.key, 'interactive', click])
    }

    expect(h.events.map(e => [e.key, e.eventName])).toEqual(sent.map(([key, name]) => [key, name]))
    h.events.forEach((e, i) => {
      expect(e.eventName === 'interactive' ? e.payload.body : e.payload.event).toBe(sent[i]![2])
      expect(typeof e.payload.ack).toBe('function')
    })
    for (const p of [h.a, h.b]) expect(stubOf(h, p).socket.acks).toEqual([])
  })

  test('a handler that throws for A is logged without leaking and stops neither A’s later events nor B’s', async () => {
    const failing = personaKey('Alpha')
    const h = makeHarness({
      onEvent: key => {
        if (key === failing) throw new Error(`handler ${LEAK_SENTINEL}`)
      },
    })
    await bringUpBoth(h)

    await expectDelivers(h, h.a)
    await expectDelivers(h, h.b)
    await expectDelivers(h, h.a)

    assertNoLeak(h.lines)
    expect(h.lines).toHaveLength(2)
    for (const line of h.lines) {
      expect(line).toContain(renderPersonaRef(h.a.name, h.a.key))
      expect(line).toContain('personas[0]')
    }
  })
})

// ---------------------------------------------------------------------------
// AC 5: the isolation walk-through (sprint demo)
// ---------------------------------------------------------------------------

describe('AC 5: per-persona isolation walk-through (fake clock)', () => {
  test('AC 5: A drops and reopens at once while B keeps delivering; after the reopen A has one live socket and each event reaches A exactly once', async () => {
    const h = makeHarness()
    await bringUpBoth(h)
    await expectDelivers(h, h.a)

    stubOf(h, h.a).socket.drop()

    // The reopen began on the drop itself: a fresh socket client whose start() ran, no timer waited on.
    expect(stubOf(h, h.a).sockets).toHaveLength(2)
    expect(stubOf(h, h.a).socket.startCalls).toBe(1)
    expect(h.clock.firedCount()).toBe(0)
    expect(h.manager.status(h.a.key)).toEqual({ state: 'lost' })
    await expectDelivers(h, h.b)
    await h.clock.flush()

    expect(h.clock.now()).toBe(0)
    expect(h.manager.status(h.a.key)).toMatchObject({ state: 'up' })
    expect(liveSocketsOf(h, h.a)).toBe(1)
    for (let i = 0; i < 3; i++) await expectDelivers(h, h.a)
    await expectDelivers(h, h.b)
    expect(statesOf(h, h.a)).toEqual(['connecting', 'up', 'lost', 'up'])
    expect(statesOf(h, h.b)).toEqual(['connecting', 'up'])
  })

  test('AC 5: the reopen is socket-only: no auth.test, no new long-lived Web API client, same client and identity', async () => {
    const h = makeHarness()
    await bringUpBoth(h)
    const web = h.manager.webClient(h.a.key)
    const identity = h.manager.identity(h.a.key)

    stubOf(h, h.a).socket.drop()
    await h.clock.flush()

    expect(h.manager.status(h.a.key)).toMatchObject({ state: 'up' })
    expect(stubOf(h, h.a).calls.authTest).toHaveLength(1)
    expect(h.slack.buildsOf(h.a.key).map(build => build.kind)).toEqual(['validation', 'web', 'socket', 'socket'])
    expect(web).toBeDefined()
    expect(h.manager.webClient(h.a.key)).toBe(web!)
    expect(h.manager.identity(h.a.key)).toEqual(identity!)
  })

  test('AC 5: a rejected reopen for A leaves the process running and B delivering; retries wait 5 s, then 10 s, and a later success restores A', async () => {
    const h = makeHarness()
    await bringUpBoth(h)
    stubOf(h, h.a).script.connect.push({ kind: 'network' }, { kind: 'http', status: 503 })

    expect(() => stubOf(h, h.a).socket.drop()).not.toThrow()
    await h.clock.flush()

    expect(h.manager.status(h.a.key)).toMatchObject({
      state: 'retrying',
      phase: 'reopen',
      retryInMs: 5_000,
      nextAttemptAt: 5_000,
      outcome: { kind: 'slack-unreachable', check: 'socket-mode' },
    })
    expect(pendingDelays(h)).toEqual([5_000])
    await expectDelivers(h, h.b)

    await h.clock.advance(4_999)
    expect(startsOf(h, h.a)).toBe(2)
    await h.clock.advance(1)
    expect(startsOf(h, h.a)).toBe(3)
    expect(h.manager.status(h.a.key)).toMatchObject({ state: 'retrying', retryInMs: 10_000, outcome: { reason: 'http-status', status: 503 } })
    await expectDelivers(h, h.b)

    await h.clock.advance(10_000)
    expect(startsOf(h, h.a)).toBe(4)
    expect(h.manager.status(h.a.key)).toMatchObject({ state: 'up' })
    expect(liveSocketsOf(h, h.a)).toBe(1)
    await expectDelivers(h, h.a)
    await expectDelivers(h, h.b)
  })

  // Rows: label, how start() hangs, and when apps.connections.open answers (0: at once). A slow open
  // does not eat into the WebSocket phase's 10 s: the bound restarts at authenticated/connecting.
  test.each<[string, SettledConnectOutcome, number]>([
    ['the WebSocket phase never reaches hello', { kind: 'never' }, 0],
    ['apps.connections.open never answers', { kind: 'open-never-answers' }, 0],
    ['apps.connections.open answers after 9 s, then the WebSocket phase never reaches hello', { kind: 'never' }, 9_000],
  ])('AC 5: a reopen whose start() never settles (%s) is abandoned 10 s into its WebSocket phase on the fake clock, counts as Slack-unreachable and is retried on the backoff while B keeps delivering', async (_label, hang, openAnswersAfterMs) => {
    const h = makeHarness()
    await bringUpBoth(h)
    const slowOpen = makeDeferredConnect()
    stubOf(h, h.a).script.connect.push(openAnswersAfterMs > 0 ? slowOpen.outcome : hang)
    stubOf(h, h.a).socket.drop()
    const hung = stubOf(h, h.a).socket
    if (openAnswersAfterMs > 0) {
      await h.clock.advance(openAnswersAfterMs)
      expect(hung.lifecycle).toEqual([])
      slowOpen.settle(hang)
      await h.clock.flush()
      expect(hung.lifecycle).toEqual(['authenticated', 'connecting'])
    }

    await h.clock.advance(9_999)
    expect(hung.disconnectCalls).toBe(0)
    expect(h.manager.status(h.a.key)).toEqual({ state: 'lost' })
    await expectDelivers(h, h.b)

    await h.clock.advance(1)
    expect(hung.disconnectCalls).toBe(1)
    expect(h.manager.status(h.a.key)).toMatchObject({
      state: 'retrying',
      phase: 'reopen',
      retryInMs: 5_000,
      outcome: { kind: 'slack-unreachable', check: 'socket-mode', reason: 'timeout' },
    })
    expect(pendingDelays(h)).toEqual([5_000])
    await expectDelivers(h, h.b)

    await h.clock.advance(5_000)
    expect(stubOf(h, h.a).sockets).toHaveLength(3)
    expect(h.manager.status(h.a.key)).toMatchObject({ state: 'up' })
    expect(liveSocketsOf(h, h.a)).toBe(1)
    await expectDelivers(h, h.a)
    await expectDelivers(h, h.b)
  })

  test('AC 5: no agent-director call is made for A across a drop, a rejected reopen, an abandoned reopen and a refused reopen', async () => {
    const h = makeHarness()
    await bringUpBoth(h)
    stubOf(h, h.a).script.connect.push({ kind: 'network' }, { kind: 'never' }, { kind: 'platform', error: 'invalid_auth' })

    stubOf(h, h.a).socket.drop()
    // Rejected at 0 s, the retry at 5 s hangs and is abandoned at 15 s, the retry at 25 s is refused.
    await h.clock.advance(25_000)

    expect(h.manager.status(h.a.key)).toMatchObject({ state: 'broken', phase: 'reopen' })
    expect(h.agentDirector.callCount()).toBe(0)
    await expectDelivers(h, h.b)
  })
})

// ---------------------------------------------------------------------------
// Reopen rules (SR-3.3)
// ---------------------------------------------------------------------------

describe('connection manager: reopen rules (SR-3.3)', () => {
  // Rows: label, arrangement after both are up, and whether A's socket emits `disconnected` on the stop.
  test.each<[string, (h: Harness) => void, boolean]>([
    ['while A is up', () => {}, true],
    [
      'while A waits to retry a rejected reopen',
      h => {
        stubOf(h, h.a).script.connect.push({ kind: 'network' })
        stubOf(h, h.a).socket.drop()
      },
      false,
    ],
    [
      'while A’s reopen start() is in flight',
      h => {
        stubOf(h, h.a).script.connect.push({ kind: 'never' })
        stubOf(h, h.a).socket.drop()
      },
      true,
    ],
    [
      // The stub's disconnect() does not settle this start(): only the stop's own cancel ends the attempt.
      'while A’s reopen start() waits on an apps.connections.open that never answers',
      h => {
        stubOf(h, h.a).script.connect.push({ kind: 'open-never-answers' })
        stubOf(h, h.a).socket.drop()
      },
      true,
    ],
  ])('the manager’s own stop %s cancels every timer and schedules no reopen; B is untouched', async (_label, arrange, emitsDisconnected) => {
    const h = makeHarness()
    await bringUpBoth(h)
    arrange(h)
    await h.clock.flush()
    const starts = startsOf(h, h.a)
    const linesBefore = h.lines.length

    await h.manager.stop(h.a.key)
    await h.manager.stop(h.a.key)

    expect(h.clock.pendingCount()).toBe(0)
    expect(stubOf(h, h.a).socket.lifecycle.includes('disconnected')).toBe(emitsDisconnected)
    await h.clock.advance(HOUR_MS)
    expect(startsOf(h, h.a)).toBe(starts)
    expect(liveSocketsOf(h, h.a)).toBe(0)
    expect(h.manager.status(h.a.key)).toBeUndefined()
    expect(h.manager.webClient(h.a.key)).toBeUndefined()
    // A teardown's close (b.av2 SR-6.5): the identity is dropped and nothing is
    // logged, so no persona-connection-lost, -restored or unreachable line.
    expect(h.manager.identity(h.a.key)).toBeUndefined()
    expect(h.lines.slice(linesBefore)).toEqual([])
    expect(statesOf(h, h.a).at(-1)).toBe('stopped')
    expect(h.manager.status(h.b.key)).toMatchObject({ state: 'up' })
    await expectDelivers(h, h.b)
  })

  test('stopping A during a bring-up hung on an apps.connections.open that never answers cancels the attempt itself: bring-up resolves stopped, no timer is left; B is untouched', async () => {
    const h = makeHarness()
    stubOf(h, h.a).script.connect.push({ kind: 'open-never-answers' })
    let resolvedA: PersonaConnectionStatus | undefined
    const bringUpA = h.manager.bringUp(h.a, h.a.tokens).then(status => (resolvedA = status))
    expect(await h.manager.bringUp(h.b, h.b.tokens)).toMatchObject({ state: 'up' })
    await h.clock.flush()
    expect(stubOf(h, h.a).socket.startCalls).toBe(1)
    expect(resolvedA).toBeUndefined()

    await h.manager.stop(h.a.key)
    await h.clock.flush()

    // Settled by the stop, with no time passing; the 10 s bound is cancelled with it.
    expect(resolvedA).toEqual({ state: 'stopped' })
    expect(await bringUpA).toEqual({ state: 'stopped' })
    expect(h.clock.pendingCount()).toBe(0)
    expect(stubOf(h, h.a).socket.disconnectCalls).toBe(1)
    await h.clock.advance(HOUR_MS)
    expect(startsOf(h, h.a)).toBe(1)
    expect(h.manager.status(h.a.key)).toBeUndefined()
    expect(statesOf(h, h.a)).toEqual(['connecting', 'stopped'])
    expect(h.manager.status(h.b.key)).toMatchObject({ state: 'up' })
    await expectDelivers(h, h.b)
  })

  test('stopAll stops both personas and is idempotent', async () => {
    const h = makeHarness()
    await bringUpBoth(h)

    await h.manager.stopAll()
    await h.manager.stopAll()
    await h.clock.advance(HOUR_MS)

    for (const p of [h.a, h.b]) {
      expect(h.manager.status(p.key)).toBeUndefined()
      expect(liveSocketsOf(h, p)).toBe(0)
      expect(startsOf(h, p)).toBe(1)
    }
  })

  test.each(['closed-before-hello', 'websocket-error'] as const)('a reopen start() whose WebSocket phase fails (%s) emits disconnected but schedules no extra reopen: start() calls follow the backoff exactly', async kind => {
    const h = makeHarness()
    await bringUpBoth(h)
    const a = stubOf(h, h.a)
    a.script.connect.push({ kind }, { kind }, { kind })

    a.socket.drop()

    // [virtual time, start() calls so far (the first is the bring-up)]: fails at 0, 5 and 15 s; up at 35 s.
    for (const [at, starts] of [[0, 2], [4_999, 2], [5_000, 3], [14_999, 3], [15_000, 4], [34_999, 4], [35_000, 5]] as const) {
      await h.clock.advanceTo(at)
      expect(startsOf(h, h.a)).toBe(starts)
      expect(h.clock.pendingCount()).toBeLessThanOrEqual(1)
    }
    expect(a.sockets.slice(1, 4).map(socket => socket.lifecycle.includes('disconnected'))).toEqual([true, true, true])
    expect(h.manager.status(h.a.key)).toMatchObject({ state: 'up' })
  })

  test('a drop before A was ever up (during its bring-up start()) schedules no reopen; the bring-up retry follows the backoff and re-runs auth.test', async () => {
    const h = makeHarness()
    stubOf(h, h.a).script.connect.push({ kind: 'never' })
    const bringUpA = h.manager.bringUp(h.a, h.a.tokens)
    await h.clock.flush()

    stubOf(h, h.a).socket.drop()

    expect(await bringUpA).toMatchObject({ state: 'retrying', phase: 'bring-up', retryInMs: 5_000, outcome: { reason: 'socket-closed' } })
    expect(startsOf(h, h.a)).toBe(1)
    expect(pendingDelays(h)).toEqual([5_000])
    await h.clock.advance(4_999)
    expect(startsOf(h, h.a)).toBe(1)
    await h.clock.advance(1)
    expect(stubOf(h, h.a).calls.authTest).toHaveLength(2)
    expect(h.slack.buildsOf(h.a.key).map(build => build.kind)).toEqual(['validation', 'web', 'socket', 'validation', 'socket'])
    expect(h.manager.status(h.a.key)).toMatchObject({ state: 'up' })
    expect(statesOf(h, h.a)).not.toContain('lost')
  })

  test('a reopen socket that closes between hello and start() resolving is Slack-unreachable: no live socket, no second reopen, retried after 5 s', async () => {
    const h = makeHarness()
    await bringUpBoth(h)
    const a = stubOf(h, h.a)
    a.socket.drop()
    const reopen = a.socket
    // Slack closes the reopen socket inside its `connected` emit, before start() resolves.
    reopen.once('connected', () => reopen.drop())

    await h.clock.flush()

    expect(reopen.lifecycle).toEqual(['authenticated', 'connecting', 'connected', 'close', 'disconnected'])
    expect(h.manager.status(h.a.key)).toMatchObject({
      state: 'retrying',
      phase: 'reopen',
      retryInMs: 5_000,
      outcome: { kind: 'slack-unreachable', check: 'socket-mode', reason: 'socket-closed' },
    })
    expect(pendingDelays(h)).toEqual([5_000])
    expect(startsOf(h, h.a)).toBe(2)
    expect(liveSocketsOf(h, h.a)).toBe(0)
    await expectDelivers(h, h.b)

    await h.clock.advance(4_999)
    expect(startsOf(h, h.a)).toBe(2)
    await h.clock.advance(1)
    expect(startsOf(h, h.a)).toBe(3)
    expect(h.manager.status(h.a.key)).toMatchObject({ state: 'up' })
    expect(liveSocketsOf(h, h.a)).toBe(1)
    await expectDelivers(h, h.a)
    expect(statesOf(h, h.a)).toEqual(['connecting', 'up', 'lost', 'retrying', 'up'])
  })

  test('a credentials error on reopen leaves A disconnected and credentials-broken: no further start() however far the clock runs, B unaffected', async () => {
    const h = makeHarness()
    await bringUpBoth(h)
    stubOf(h, h.a).script.connect.push({ kind: 'platform', error: 'invalid_auth' })

    stubOf(h, h.a).socket.drop()
    await h.clock.flush()

    expect(h.manager.status(h.a.key)).toMatchObject({
      state: 'broken',
      phase: 'reopen',
      outcome: { kind: 'credentials-refused', check: 'socket-mode', key: 'app_token', slackError: 'invalid_auth' },
    })
    expect(h.clock.pendingCount()).toBe(0)
    await h.clock.advance(24 * HOUR_MS)
    expect(startsOf(h, h.a)).toBe(2)
    expect(liveSocketsOf(h, h.a)).toBe(0)
    expect(h.manager.status(h.b.key)).toMatchObject({ state: 'up' })
    await expectDelivers(h, h.b)
  })

  test('after a successful reopen a later drop reopens at once again, and its first failure waits 5 s (the backoff was reset)', async () => {
    const h = makeHarness()
    await bringUpBoth(h)
    const a = stubOf(h, h.a)
    a.script.connect.push({ kind: 'network' }, { kind: 'network' })
    a.socket.drop()
    await h.clock.advance(5_000)
    expect(h.manager.status(h.a.key)).toMatchObject({ state: 'retrying', retryInMs: 10_000 })
    await h.clock.advance(10_000)
    expect(h.manager.status(h.a.key)).toMatchObject({ state: 'up' })
    const starts = startsOf(h, h.a)
    a.script.connect.push({ kind: 'network' })

    a.socket.drop()

    expect(startsOf(h, h.a)).toBe(starts + 1)
    await h.clock.flush()
    expect(h.manager.status(h.a.key)).toMatchObject({ state: 'retrying', retryInMs: 5_000 })
  })

  test.each([
    ['longer than the backoff step waits retryAfter', 30, 30_000],
    ['shorter than the backoff step waits the step', 3, 5_000],
  ])('a rate-limited reopen failure with a retryAfter %s', async (_label, retryAfter, waitMs) => {
    const h = makeHarness()
    await bringUpBoth(h)
    stubOf(h, h.a).script.connect.push({ kind: 'rate-limited', retryAfter })

    stubOf(h, h.a).socket.drop()
    await h.clock.flush()

    expect(h.manager.status(h.a.key)).toMatchObject({ state: 'retrying', retryInMs: waitMs, outcome: { reason: 'rate-limited', retryAfter } })
    expect(pendingDelays(h)).toEqual([waitMs])
    expect(waitMs).toBeGreaterThanOrEqual(retryAfter * 1000)
    await h.clock.advance(waitMs - 1)
    expect(startsOf(h, h.a)).toBe(2)
    await h.clock.advance(1)
    expect(startsOf(h, h.a)).toBe(3)
  })
})

// ---------------------------------------------------------------------------
// Late settlement of a stopped or abandoned start() (SR-3.1, SR-3.3, b.av2 SR-6.5)
// ---------------------------------------------------------------------------

describe('connection manager: late settlement of a stopped or abandoned start()', () => {
  // Rows: what ends A's in-flight start() (the manager's own stop, as a teardown's; or the 10 s
  // bound), which start() it is, and how it settles afterwards. A stopped start() belongs to no
  // connection: nothing follows. An abandoned one leaves A retrying on the backoff.
  test.each<['stop' | 'abandonment', 'bring-up' | 'reopen', string, SettledConnectOutcome]>([
    ['stop', 'bring-up', 'resolves', { kind: 'ok' }],
    ['stop', 'bring-up', 'rejects', { kind: 'network' }],
    ['stop', 'reopen', 'resolves', { kind: 'ok' }],
    ['stop', 'reopen', 'rejects', { kind: 'network' }],
    ['abandonment', 'bring-up', 'resolves', { kind: 'ok' }],
    ['abandonment', 'bring-up', 'rejects', { kind: 'network' }],
    ['abandonment', 'reopen', 'resolves', { kind: 'ok' }],
    ['abandonment', 'reopen', 'rejects', { kind: 'network' }],
  ])('after its %s, a %s start() for A that %s late is disconnected, forwards nothing, changes no status and adds no attempt; B keeps delivering', async (trigger, phase, _settles, late) => {
    const h = makeHarness()
    const a = stubOf(h, h.a)
    const deferred = makeDeferredConnect()
    let bringUpA: Promise<PersonaConnectionStatus> | undefined
    if (phase === 'bring-up') {
      a.script.connect.push(deferred.outcome)
      bringUpA = h.manager.bringUp(h.a, h.a.tokens)
      expect(await h.manager.bringUp(h.b, h.b.tokens)).toMatchObject({ state: 'up' })
    } else {
      await bringUpBoth(h)
      a.script.connect.push(deferred.outcome)
      a.socket.drop()
    }
    await h.clock.flush()
    const inFlight = a.socket
    expect(inFlight.startCalls).toBe(1)

    if (trigger === 'stop') {
      await h.manager.stop(h.a.key)
      if (bringUpA !== undefined) expect(await bringUpA).toEqual({ state: 'stopped' })
    } else {
      await h.clock.advance(10_000)
      if (bringUpA !== undefined) await bringUpA
      expect(inFlight.disconnectCalls).toBe(1)
      expect(h.manager.status(h.a.key)).toMatchObject({ state: 'retrying', phase, outcome: { reason: 'timeout' } })
      await expectDelivers(h, h.b)
    }
    const disconnects = inFlight.disconnectCalls
    const reported = h.statuses.length
    const linesBefore = h.lines.length
    const starts = startsOf(h, h.a)
    // Should the late socket open, deliver on it while it is connected: nothing may reach the handler.
    const lateText = 'from A\'s late socket'
    const lateDeliveries: Promise<void>[] = []
    inFlight.on('connected', () => void lateDeliveries.push(inFlight.deliver(makeChannelMessage({ text: lateText }))))

    deferred.settle(late)
    await h.clock.flush()
    await Promise.all(lateDeliveries)

    expect(lateDeliveries).toHaveLength(late.kind === 'ok' ? 1 : 0)
    expect(h.events.filter(e => e.payload.event?.text === lateText)).toEqual([])
    expect(inFlight.disconnectCalls).toBe(late.kind === 'ok' ? disconnects + 1 : disconnects)
    expect(liveSocketsOf(h, h.a)).toBe(0)
    expect(h.statuses).toHaveLength(reported)
    expect(h.lines.slice(linesBefore)).toEqual([])
    expect(startsOf(h, h.a)).toBe(starts)
    await expectDelivers(h, h.b)

    if (trigger === 'stop') {
      expect(h.manager.status(h.a.key)).toBeUndefined()
      expect(h.manager.identity(h.a.key)).toBeUndefined()
      expect(h.manager.webClient(h.a.key)).toBeUndefined()
      expect(h.clock.pendingCount()).toBe(0)
      await h.clock.advance(HOUR_MS)
      expect(startsOf(h, h.a)).toBe(starts)
      expect(h.lines.slice(linesBefore)).toEqual([])
    } else {
      // The backoff's next attempt is still the only one, and it brings A up.
      expect(pendingDelays(h)).toEqual([5_000])
      await h.clock.advance(5_000)
      expect(h.manager.status(h.a.key)).toMatchObject({ state: 'up' })
      expect(liveSocketsOf(h, h.a)).toBe(1)
      await expectDelivers(h, h.a)
      const recovered = startsOf(h, h.a)
      await h.clock.advance(HOUR_MS)
      expect(startsOf(h, h.a)).toBe(recovered)
    }
  })
})

// ---------------------------------------------------------------------------
// Bring-up connection legs of AC 23, AC 24
// ---------------------------------------------------------------------------

/**
 * Bring-up connect legs that leave a persona Slack-unreachable, never
 * credentials-broken (AC 23, AC 24). Rows: label, the connect outcome, when
 * apps.connections.open answers (0: at once), when the manager abandons it
 * (0: it fails at once), and the outcome's reason. The 10 s bound restarts
 * when the WebSocket phase begins, so a slow open is abandoned 10 s after it
 * answered. The start-pass table below reuses the rows that answer at once.
 */
const UNREACHABLE_CONNECT_LEGS: [string, SettledConnectOutcome, number, number, string][] = [
  ['the socket closes before hello', { kind: 'closed-before-hello' }, 0, 0, 'socket-closed'],
  ['start() never settles: apps.connections.open never answers', { kind: 'open-never-answers' }, 0, 10_000, 'timeout'],
  ['start() never settles: the WebSocket never reaches hello', { kind: 'never' }, 0, 10_000, 'timeout'],
  ['start() never settles: apps.connections.open answers after 9 s, then the WebSocket never reaches hello', { kind: 'never' }, 9_000, 19_000, 'timeout'],
]

describe('connection manager: bring-up connection legs of AC 23, AC 24', () => {
  test.each(UNREACHABLE_CONNECT_LEGS)('%s: A is Slack-unreachable and retrying, never credentials-broken, while B comes up and delivers', async (_label, connect, openAnswersAfterMs, abandonAtMs, reason) => {
    const h = makeHarness()
    const slowOpen = makeDeferredConnect()
    stubOf(h, h.a).script.connect.push(openAnswersAfterMs > 0 ? slowOpen.outcome : connect)
    let resolvedA: PersonaConnectionStatus | undefined
    const bringUpA = h.manager.bringUp(h.a, h.a.tokens).then(status => (resolvedA = status))

    expect(await h.manager.bringUp(h.b, h.b.tokens)).toMatchObject({ state: 'up' })
    await expectDelivers(h, h.b)
    // Never up yet: the long-lived Web API client is not handed out.
    expect(h.manager.webClient(h.a.key)).toBeUndefined()
    if (openAnswersAfterMs > 0) {
      await h.clock.advance(openAnswersAfterMs)
      slowOpen.settle(connect)
      await h.clock.flush()
      expect(stubOf(h, h.a).socket.lifecycle).toEqual(['authenticated', 'connecting'])
    }
    if (abandonAtMs > 0) {
      await h.clock.advanceTo(abandonAtMs - 1)
      expect(resolvedA).toBeUndefined()
      expect(stubOf(h, h.a).socket.disconnectCalls).toBe(0)
      expect(h.manager.status(h.a.key)).toEqual({ state: 'connecting' })
      expect(h.manager.webClient(h.a.key)).toBeUndefined()
      await expectDelivers(h, h.b)
      await h.clock.advance(1)
    }

    expect(await bringUpA).toMatchObject({
      state: 'retrying',
      phase: 'bring-up',
      retryInMs: 5_000,
      outcome: { kind: 'slack-unreachable', check: 'socket-mode', key: 'app_token', reason },
    })
    expect(h.clock.now()).toBe(abandonAtMs)
    expect(stubOf(h, h.a).socket.disconnectCalls).toBe(abandonAtMs > 0 ? 1 : 0)
    expect(statesOf(h, h.a)).not.toContain('broken')
    expect(h.manager.webClient(h.a.key)).toBeUndefined()
    await expectDelivers(h, h.b)
  })
})

describe('connection manager: the 10 s bound on auth.test (E2 carry)', () => {
  test('an auth.test that never answers is abandoned at 10 s on the fake clock: A is Slack-unreachable (timeout), never refused, no socket is built, and its retry 5 s later comes up; B is unaffected', async () => {
    const h = makeHarness()
    stubOf(h, h.a).script.authTest.push({ kind: 'never' })
    let resolvedA: PersonaConnectionStatus | undefined
    const bringUpA = h.manager.bringUp(h.a, h.a.tokens).then(status => (resolvedA = status))
    expect(await h.manager.bringUp(h.b, h.b.tokens)).toMatchObject({ state: 'up' })

    await h.clock.advanceTo(9_999)
    expect(resolvedA).toBeUndefined()
    expect(h.manager.status(h.a.key)).toEqual({ state: 'connecting' })
    await expectDelivers(h, h.b)
    await h.clock.advance(1)

    expect(await bringUpA).toMatchObject({
      state: 'retrying',
      phase: 'bring-up',
      retryInMs: 5_000,
      outcome: { kind: 'slack-unreachable', check: 'auth.test', key: 'bot_token', reason: 'timeout', cause: expect.stringContaining('no answer within 10 s') },
    })
    expect(h.slack.buildsOf(h.a.key).map(build => build.kind)).toEqual(['validation'])
    expect(statesOf(h, h.a)).not.toContain('broken')
    expect(h.lines.map(classOf)).toEqual([PERSONA_SLACK_UNREACHABLE])
    await h.clock.advance(5_000)
    expect(h.manager.status(h.a.key)).toMatchObject({ state: 'up' })
    await expectDelivers(h, h.a)
    await expectDelivers(h, h.b)
  })

  test('an auth.test abandoned at 10 s that answers late (12 s) builds nothing more: A stays retrying until its 15 s retry, which leaves exactly one live socket; B keeps delivering', async () => {
    const h = makeHarness()
    const late = makeDeferredWebApiCall()
    stubOf(h, h.a).script.authTest.push(late.outcome)
    const bringUpA = h.manager.bringUp(h.a, h.a.tokens)
    expect(await h.manager.bringUp(h.b, h.b.tokens)).toMatchObject({ state: 'up' })
    await h.clock.advanceTo(10_000)
    expect(await bringUpA).toMatchObject({ state: 'retrying', phase: 'bring-up', retryInMs: 5_000, outcome: { reason: 'timeout' } })
    const reported = h.statuses.length

    await h.clock.advanceTo(12_000)
    late.settle({ kind: 'ok' })
    await h.clock.flush()

    // The late answer is ignored: no long-lived Web API client, no socket, no status change.
    expect(h.slack.buildsOf(h.a.key).map(build => build.kind)).toEqual(['validation'])
    expect(h.statuses).toHaveLength(reported)
    expect(pendingDelays(h)).toEqual([5_000])
    await expectDelivers(h, h.b)
    await h.clock.advanceTo(14_999)
    expect(h.manager.status(h.a.key)).toMatchObject({ state: 'retrying', phase: 'bring-up' })
    expect(h.slack.buildsOf(h.a.key, 'socket')).toEqual([])

    await h.clock.advance(1)
    expect(h.manager.status(h.a.key)).toMatchObject({ state: 'up' })
    expect(h.slack.buildsOf(h.a.key).map(build => build.kind)).toEqual(['validation', 'validation', 'web', 'socket'])
    expect(liveSocketsOf(h, h.a)).toBe(1)
    await expectDelivers(h, h.a)
    await expectDelivers(h, h.b)
  })
})

// ---------------------------------------------------------------------------
// No cross-persona coupling (SR-3.3)
// ---------------------------------------------------------------------------

describe('connection manager: no cross-persona coupling (SR-3.3)', () => {
  test('while A’s reopen start() hangs after two failures, B drops, fails once and reopens on its own 5 s step; A’s failure count never lengthens B’s wait', async () => {
    const h = makeHarness()
    await bringUpBoth(h)
    const [a, b] = [stubOf(h, h.a), stubOf(h, h.b)]
    a.script.connect.push({ kind: 'network' }, { kind: 'network' }, { kind: 'never' })
    a.socket.drop()
    // A fails at 0 and 5 s; its third attempt, at 15 s, hangs.
    await h.clock.advance(15_000)
    expect(startsOf(h, h.a)).toBe(4)
    b.script.connect.push({ kind: 'network' })

    b.socket.drop()
    await h.clock.flush()

    expect(h.manager.status(h.b.key)).toMatchObject({ state: 'retrying', phase: 'reopen', retryInMs: 5_000 })
    await h.clock.advance(5_000)
    expect(h.manager.status(h.b.key)).toMatchObject({ state: 'up' })
    expect(a.socket.disconnectCalls).toBe(0)
    await expectDelivers(h, h.b)
    // 25 s: A's hung start() is abandoned; its next wait is its own third step.
    await h.clock.advance(5_000)
    expect(h.manager.status(h.a.key)).toMatchObject({ state: 'retrying', retryInMs: 20_000, outcome: { reason: 'timeout' } })
    expect(h.manager.status(h.b.key)).toMatchObject({ state: 'up' })
    await expectDelivers(h, h.b)
  })
})

// ---------------------------------------------------------------------------
// Log classes (SR-10.3)
// ---------------------------------------------------------------------------

describe('connection manager: log classes (SR-10.3)', () => {
  const LOST = PERSONA_CONNECTION_LOST
  const RESTORED = PERSONA_CONNECTION_RESTORED
  const U = PERSONA_SLACK_UNREACHABLE

  // Rows: label, what happens to A after the harness is built, and the classes of the lines logged.
  test.each<[string, (h: Harness) => Promise<void>, string[]]>([
    [
      'a reopen outage with three failed attempts, one abandoned: one lost line, then one restored line',
      async h => {
        await bringUpBoth(h)
        stubOf(h, h.a).script.connect.push({ kind: 'network' }, { kind: 'http', status: 503 }, { kind: 'never' })
        stubOf(h, h.a).socket.drop()
        // Fails at 0 and 5 s, hangs at 15 s, abandoned at 25 s, up at 45 s.
        await h.clock.advance(45_000)
        expect(h.manager.status(h.a.key)).toMatchObject({ state: 'up' })
      },
      [LOST, RESTORED],
    ],
    [
      'a refused reopen: one lost line, then one refused line and no restored line',
      async h => {
        await bringUpBoth(h)
        stubOf(h, h.a).script.connect.push({ kind: 'network' }, { kind: 'platform', error: 'invalid_auth' })
        stubOf(h, h.a).socket.drop()
        await h.clock.advance(5_000)
        expect(h.manager.status(h.a.key)).toMatchObject({ state: 'broken' })
      },
      [LOST, PERSONA_CREDENTIALS_REFUSED],
    ],
    [
      'a bring-up outage with two failed attempts: one unreachable line, then one cleared line',
      async h => {
        stubOf(h, h.a).script.authTest.push({ kind: 'dns' }, { kind: 'dns' })
        expect(await h.manager.bringUp(h.a, h.a.tokens)).toMatchObject({ state: 'retrying' })
        expect(await h.manager.bringUp(h.b, h.b.tokens)).toMatchObject({ state: 'up' })
        // Fails at 0 and 5 s, up at 15 s.
        await h.clock.advance(15_000)
        expect(h.manager.status(h.a.key)).toMatchObject({ state: 'up' })
      },
      [U, U],
    ],
  ])('%s', async (_label, run, classes) => {
    const name = 'Night "Ops"\nDesk'
    const h = makeHarness({ names: [name, 'Beta'] })

    await run(h)

    assertNoLeak(h.lines)
    expect(h.lines.map(classOf)).toEqual(classes)
    for (const line of h.lines) {
      expect(line).not.toMatch(/[\r\n]/)
      expect(line).toContain(renderPersonaRef(name, h.a.key))
      expect(line).toContain('personas[0]')
      expect(line).toContain(`path=${JSON.stringify(h.a.credentials_file)}`)
    }
  })
})

// ---------------------------------------------------------------------------
// Dry run (SR-3.4)
// ---------------------------------------------------------------------------

describe('connection manager: dry run (SR-3.4)', () => {
  test('reads no credentials file, builds no client, makes no Slack call, and brings every persona up with a distinct placeholder identity derived from its key', async () => {
    // No credentials file is written: each persona points at a missing path.
    const h = makeHarness({ dryRun: true })

    for (const p of [h.a, h.b]) {
      expect(existsSync(p.credentials_file)).toBe(false)
      expect(await h.manager.bringUp(p)).toEqual({ state: 'up', identity: dryRunPersonaIdentity(p.key) })
      expect(h.manager.identity(p.key)).toEqual(dryRunPersonaIdentity(p.key))
      expect(h.manager.webClient(p.key)).toBeUndefined()
      expect(existsSync(p.credentials_file)).toBe(false)
    }

    expect(h.slack.builds).toEqual([])
    expect(h.lines).toEqual([])
    expect(h.clock.pendingCount()).toBe(0)
    // Derived from the key alone: a second manager gives the same identity.
    const other = makeHarness({ dryRun: true })
    expect(await other.manager.bringUp(h.a)).toEqual({ state: 'up', identity: dryRunPersonaIdentity(h.a.key) })
    // Distinct keys, even near-identical ones, never share either placeholder ID.
    const identities = [h.a.key, h.b.key, 'alpha', 'alpha_1', 'alpha1', 'alph'].map(dryRunPersonaIdentity)
    expect(new Set(identities.map(identity => identity.botUserId)).size).toBe(identities.length)
    expect(new Set(identities.map(identity => identity.botId)).size).toBe(identities.length)
  })
})

// ---------------------------------------------------------------------------
// unhandledRejection handler (SR-3.3)
// ---------------------------------------------------------------------------

describe('unhandledRejection handler (SR-3.3)', () => {
  // Rows: label, the rejection reason, and pieces the line must carry. Called
  // directly; never installed on the real process.
  test.each<[string, unknown, string[]]>([
    ['an Error with the sentinel in its message', new Error(`boom ${LEAK_SENTINEL}`), ['Error', 'at ']],
    [
      'a Slack-shaped error with the sentinel in its message, headers, data and original',
      sentinelSlackError('slack_webapi_request_error'),
      ['Error', 'code=slack_webapi_request_error'],
    ],
    [
      'an Error whose message spans several lines, the sentinel on a later, frame-shaped line',
      new TypeError(`first line\n    at ${LEAK_SENTINEL} (frame-shaped:1:1)\n${fakeToken(BOT_TOKEN_PREFIX, 'third-line')}`),
      ['TypeError'],
    ],
    ['undefined', undefined, ['undefined']],
    ['null', null, ['null']],
    ['a sentinel-bearing string', `boom ${LEAK_SENTINEL}`, ['string']],
    ['a plain object holding a token', { token: fakeToken(APP_TOKEN_PREFIX, 'object') }, ['object']],
  ])('%s: logs one token-free [slack] line, returns normally and never exits', (_label, reason, pieces) => {
    const { lines, log } = capture()
    const exit = spyOn(process, 'exit').mockImplementation(() => undefined as never)
    let returned: unknown
    let outputCalls: number
    try {
      const handler = createUnhandledRejectionHandler(log)
      ;({ value: returned, outputCalls } = withSilencedOutput(() => handler(reason, Promise.resolve())))
      expect(exit).not.toHaveBeenCalled()
    } finally {
      exit.mockRestore()
    }

    assertNoLeak({ lines }, 'unhandled rejection')
    if (reason !== undefined && reason !== null) expect(() => assertNoLeak(reason)).toThrow()
    expect(returned).toBeUndefined()
    expect(outputCalls).toBe(0)
    expect(lines).toHaveLength(1)
    expect(lines[0]).toStartWith('[slack] ')
    for (const piece of pieces) expect(lines[0]).toContain(piece)
  })

  test('a logger that throws does not make the handler throw', () => {
    const handler = createUnhandledRejectionHandler(() => {
      throw new Error('logger down')
    })

    expect(() => handler(new Error('rejected'))).not.toThrow()
  })
})

// ---------------------------------------------------------------------------
// slackPlatformReason (SR-10.3): data.error only when it is a short identifier
// ---------------------------------------------------------------------------

describe('slackPlatformReason (SR-10.3)', () => {
  /** An Error carrying `data` as a Slack platform error does. */
  const withData = (data: unknown): Error => Object.assign(new Error(`An API error occurred ${LEAK_SENTINEL}`), { data })

  test.each<[string, unknown, string]>([
    ['a Slack platform error', sentinelSlackError('slack_webapi_platform_error', 'not_in_channel'), 'not_in_channel'],
    ['a plain object shaped like one', { data: { error: 'channel_not_found' } }, 'channel_not_found'],
    ['a 64-character identifier', withData({ error: `a${'b'.repeat(63)}` }), `a${'b'.repeat(63)}`],
  ])('%s: returns the reason', (_label, value, reason) => {
    expect(slackPlatformReason(value)).toBe(reason)
  })

  test.each<[string, unknown]>([
    ['no data', new Error('boom')],
    ['data without error', withData({ ok: false })],
    ['a non-string error', withData({ error: 42 })],
    ['a hyphen (a token always has one)', withData({ error: fakeToken(BOT_TOKEN_PREFIX, 'reason') })],
    ['a bare hyphen', withData({ error: '-' })],
    ['spaces', withData({ error: 'not in channel' })],
    ['a newline', withData({ error: 'not_in_channel\nsecond' })],
    ['more than 64 characters', withData({ error: `a${'b'.repeat(64)}` })],
    ['an empty string', withData({ error: '' })],
    ['a leading digit', withData({ error: '1abc' })],
    ['a request error with no data.error', sentinelSlackError('slack_webapi_request_error')],
    ['undefined', undefined],
    ['null', null],
    ['a string', 'not_in_channel'],
    ['data that is a string', withData('not_in_channel')],
  ])('%s: returns undefined', (_label, value) => {
    expect(slackPlatformReason(value)).toBeUndefined()
  })

  test('a throwing getter on data or data.error makes it return undefined, never throw', () => {
    const throwingData = Object.defineProperty(new Error('x'), 'data', {
      get() {
        throw new Error(`getter ${LEAK_SENTINEL}`)
      },
    })
    const throwingError = withData(
      Object.defineProperty({}, 'error', {
        get() {
          throw new Error(`getter ${LEAK_SENTINEL}`)
        },
      }),
    )

    for (const value of [throwingData, throwingError]) {
      let result: unknown = 'not called'
      expect(() => {
        result = slackPlatformReason(value)
      }).not.toThrow()
      expect(result).toBeUndefined()
    }
  })
})

// ---------------------------------------------------------------------------
// isSafeIdentifier (SR-10.3): the short-identifier check, exported for callers
// ---------------------------------------------------------------------------

describe('isSafeIdentifier (SR-10.3)', () => {
  test.each<[string, string]>([
    ['a Slack error code', 'missing_scope'],
    ['a library code', 'slack_webapi_platform_error'],
    ['a single letter', 'a'],
    ['a leading underscore', '_private'],
    ['a leading dollar sign', '$ref'],
    ['mixed case and digits', 'ECONNREFUSED2'],
    ['64 characters', `a${'b'.repeat(63)}`],
  ])('%s is safe', (_label, value) => {
    expect(isSafeIdentifier(value)).toBe(true)
  })

  test.each<[string, unknown]>([
    ['a fake token (a token always has a hyphen)', fakeToken(BOT_TOKEN_PREFIX, 'code')],
    ['a bare hyphen', '-'],
    ['spaces', 'not in channel'],
    ['a newline', 'missing_scope\nsecond'],
    ['a trailing newline', 'missing_scope\n'],
    ['a dot', 'conversations.open'],
    ['65 characters', `a${'b'.repeat(64)}`],
    ['an empty string', ''],
    ['a leading digit', '1abc'],
    ['undefined', undefined],
    ['null', null],
    ['a number', 42],
    ['an object', { toString: () => 'missing_scope' }],
    ['a String object', new String('missing_scope')],
  ])('%s is not safe', (_label, value) => {
    expect(isSafeIdentifier(value)).toBe(false)
  })

  test('it is the same check as the code in describeThrownValue', () => {
    for (const code of ['missing_scope', fakeToken(BOT_TOKEN_PREFIX, 'code'), `a${'b'.repeat(64)}`, '1abc']) {
      const described = describeThrownValue(Object.assign(new Error('x'), { code }))
      expect(described.includes(` code=${code}`)).toBe(isSafeIdentifier(code))
    }
  })
})

// ---------------------------------------------------------------------------
// describeSlackCallFailure (SR-10.3): the token-safe tail of a failed-call line
// ---------------------------------------------------------------------------

describe('describeSlackCallFailure (SR-10.3)', () => {
  test.each<[string, unknown, string | undefined]>([
    ['a sentinel-bearing platform error', sentinelSlackError('slack_webapi_platform_error', 'not_in_channel'), 'not_in_channel'],
    ['a sentinel-bearing request error (Authorization header in original)', sentinelSlackError('slack_webapi_request_error'), undefined],
    ['a platform error whose reason is not an identifier', sentinelSlackError('slack_webapi_platform_error', fakeToken(BOT_TOKEN_PREFIX, 'reason')), undefined],
    ['undefined', undefined, undefined],
    ['a sentinel-bearing string', `boom ${LEAK_SENTINEL}`, undefined],
  ])('%s: ` (reason=…)` only for a safe reason, then `: ` and the thrown-value description; nothing leaks', (_label, value, reason) => {
    const tail = describeSlackCallFailure(value)

    expect(tail).toBe(`${reason === undefined ? '' : ` (reason=${reason})`}: ${describeThrownValue(value)}`)
    assertNoLeak({ tail }, 'failure tail')
    if (typeof value === 'object' && value !== null) expect(() => assertNoLeak(value)).toThrow()
  })

  test('a value whose every read throws still yields a line, never throws', () => {
    const hostile = new Proxy(new Error(`hostile ${LEAK_SENTINEL}`), {
      get() {
        throw new Error(`getter ${LEAK_SENTINEL}`)
      },
      getPrototypeOf() {
        throw new Error(`proto ${LEAK_SENTINEL}`)
      },
    })

    let tail = ''
    expect(() => {
      tail = describeSlackCallFailure(hostile)
    }).not.toThrow()
    expect(tail).toStartWith(': ')
    assertNoLeak({ tail }, 'hostile failure tail')
  })
})

// ---------------------------------------------------------------------------
// Rejected Web API calls (AC 20)
// ---------------------------------------------------------------------------

describe('rejected Web API calls (AC 20)', () => {
  // Rows: label, leg, the scripted rejection, the state A is left in. Rows
  // with `reject` carry the sentinel in message, original, headers and data;
  // the http rows carry it through the stub's leak marker.
  test.each<[string, Leg, Scripted, 'retrying' | 'broken']>([
    ['a request error', 'auth.test', { kind: 'reject', value: sentinelSlackError('slack_webapi_request_error') }, 'retrying'],
    ['a refusing platform error', 'auth.test', { kind: 'reject', value: sentinelSlackError('slack_webapi_platform_error', 'invalid_auth') }, 'broken'],
    ['an HTTP 503', 'auth.test', { kind: 'http', status: 503 }, 'retrying'],
    ['a request error', 'socket-mode', { kind: 'reject', value: sentinelSlackError('slack_webapi_request_error') }, 'retrying'],
    ['a refusing platform error', 'socket-mode', { kind: 'reject', value: sentinelSlackError('slack_webapi_platform_error', 'invalid_auth') }, 'broken'],
    ['an HTTP 503', 'socket-mode', { kind: 'http', status: 503 }, 'retrying'],
  ])('(i) %s rejecting the manager’s own %s call leaves no sentinel in the outcome, status or log line', async (_label, leg, scripted, state) => {
    const h = makeHarness()
    const stub = stubOf(h, h.a)
    if (leg === 'auth.test') stub.script.authTest.push(scripted as WebApiOutcome)
    else stub.script.connect.push(scripted as ConnectOutcome)

    const status = await h.manager.bringUp(h.a, h.a.tokens)

    assertNoLeak({ status, statuses: h.statuses, lines: h.lines }, `rejected ${leg}`)
    if (scripted.kind === 'reject') expect(() => assertNoLeak(scripted.value)).toThrow()
    expect(status).toMatchObject({ state, phase: 'bring-up', outcome: { check: leg } })
    expect(h.lines).toHaveLength(1)
  })

  test('(ii) a rejected call on A’s long-lived Web API client, from the manager’s query, surfaces without original and leaks nothing', async () => {
    const h = makeHarness()
    await bringUpBoth(h)
    const stub = stubOf(h, h.a)
    stub.script.post.push({ kind: 'network' }, { kind: 'network' })
    const web = h.manager.webClient(h.a.key)
    if (web === undefined) throw new Error('expected A’s long-lived Web API client')

    const thrown = await web.chat.postMessage({ channel: 'C0STUB0001', text: 'hello' }).catch((err: unknown) => err)
    // Control: the same failure on a client built without the SR-3.3 option carries the Authorization header in original.
    const control = await stub.web.chat.postMessage({ channel: 'C0STUB0001', text: 'hello' }).catch((err: unknown) => err)

    expect(thrown).toMatchObject({ code: 'slack_webapi_request_error' })
    expect(thrown).not.toHaveProperty('original')
    assertNoLeak(thrown, 'long-lived client rejection')
    expect(control).toHaveProperty('original')
    expect(() => assertNoLeak(control)).toThrow()
  })
})

// ---------------------------------------------------------------------------
// Credentials reconnect (E13 Task 1: b.av2 SR-8.6 credentials row, SR-3.1
// overlap, SR-3.3 reconnect part, SR-10.3 persona-credentials-change-failed)
//
// `reconnectCredentials` and `replaceRetryTokens` at module level, on the
// file harness (A and B, stub Slack, fake clock), independent of the reload
// controller; `tests/reload-apply.test.ts` covers them end to end. Each
// rotated token pair is registered with the stub factory as its own
// credential set (`addCredentials`), so the old and new tokens are scripted
// apart and the factory's activity record shows the open-before-close order.
// ---------------------------------------------------------------------------

/** The label of the first rotated credential set a case registers. */
const ROTATED = 'rotated'

/** A long-lived persona Web API client as the manager hands it out. */
type ManagedWebClient = NonNullable<ReturnType<PersonaConnectionManager['webClient']>>

/** A persona's rotated credential set: its tokens, the stub its clients go to and the identity its `auth.test` returns. */
interface RotatedCredentials {
  tokens: PersonaSlackTokens
  stub: StubSlack
  identity: { botUserId: string; botId: string }
}

/**
 * Register a rotated credential set `label` for `p`: new sentinel-bearing
 * fake tokens and their own stub (leak marker on, `opts` seeding its script),
 * whose bot user ID and bot ID differ from the old ones and whose team
 * differs too: another app, which the manager never compares.
 */
function rotateCredentials(h: Harness, p: ManagedPersona, label = ROTATED, opts: StubSlackOptions = {}): RotatedCredentials {
  const tokens = new PersonaSlackTokens(
    fakeToken(BOT_TOKEN_PREFIX, `${p.key}-${label}-bot`),
    fakeToken(APP_TOKEN_PREFIX, `${p.key}-${label}-app`),
  )
  const stub = h.slack.addCredentials(p.key, label, tokens, { leakMarker: LEAK_SENTINEL, teamId: 'T0ROTATED', ...opts })
  return { tokens, stub, identity: { botUserId: stub.identity.botUserId, botId: stub.identity.botId } }
}

/** The identity the persona's initial credential set's `auth.test` returns. */
function initialIdentityOf(h: Harness, p: ManagedPersona): { botUserId: string; botId: string } {
  const { botUserId, botId } = stubOf(h, p).identity
  return { botUserId, botId }
}

/** The persona's clients built from credential set `label`, by kind, in build order. */
function builtFrom(h: Harness, p: ManagedPersona, label: string): StubClientKind[] {
  return h.slack.buildsOf(p.key).filter(build => build.credentials === label).map(build => build.kind)
}

/** `start()` calls over every socket client of one credential set's stub. */
function stubStarts(stub: StubSlack): number {
  return stub.sockets.reduce((sum, socket) => sum + socket.startCalls, 0)
}

/**
 * The old connection is intact and in use: `p` is up with its initial
 * identity and Web API client, its one initial socket is open (never closed)
 * and delivers, tagged with `p`.
 */
async function expectOldConnectionKept(h: Harness, p: ManagedPersona, oldWeb: ManagedWebClient | undefined): Promise<void> {
  expect(oldWeb).toBeDefined()
  expect(h.manager.status(p.key)).toEqual({ state: 'up', identity: initialIdentityOf(h, p) })
  expect(h.manager.identity(p.key)).toEqual(initialIdentityOf(h, p))
  expect(h.manager.webClient(p.key)).toBe(oldWeb!)
  expect(stubOf(h, p).sockets.map(socket => [socket.connected, socket.disconnectCalls])).toEqual([[true, 0]])
  await expectDelivers(h, p)
}

/**
 * B was never touched: up with its identity since its bring-up, its three
 * clients only, its one socket started once and never closed, no line naming
 * it, and it still delivers. No agent-director call was made for anyone.
 */
async function expectBUndisturbed(h: Harness): Promise<void> {
  const b = stubOf(h, h.b)
  expect(h.manager.status(h.b.key)).toEqual({ state: 'up', identity: initialIdentityOf(h, h.b) })
  expect(statesOf(h, h.b)).toEqual(['connecting', 'up'])
  expect(h.slack.buildsOf(h.b.key).map(build => build.kind)).toEqual(['validation', 'web', 'socket'])
  expect(b.sockets.map(socket => [socket.startCalls, socket.disconnectCalls, socket.connected])).toEqual([[1, 0, true]])
  expect(h.lines.filter(line => line.includes(renderPersonaRef(h.b.name, h.b.key)))).toEqual([])
  expect(h.agentDirector.callCount()).toBe(0)
  await expectDelivers(h, h.b)
}

/** The diagnostic line the manager logs for `p` with class `cls` and `cause` (personas[i], name and key, credentials path). */
function personaLine(p: BringUpPersona, cls: PersonaDiagnosticClass, cause: string): string {
  return formatPersonaDiagnostic({ class: cls, name: p.name, key: p.key, index: p.index, path: p.credentials_file, cause })
}

/** The Slack-unreachable cause of a reconnect's first attempt left retrying; throws (naming only the kind) otherwise. */
function retryingCause(outcome: PersonaReconnectOutcome): string {
  if (outcome.kind !== 'retrying') throw new Error(`expected a reconnect left retrying, got ${outcome.kind}`)
  return outcome.outcome.cause
}

/** A listener for a reconnect's later outcome, recording what it is told. */
function laterOutcomes(): { later: PersonaReconnectLaterOutcome[]; listener: (outcome: PersonaReconnectLaterOutcome) => void } {
  const later: PersonaReconnectLaterOutcome[] = []
  return { later, listener: outcome => void later.push(outcome) }
}

describe('connection manager: credentials reconnect (b.av2 SR-8.6 credentials row, SR-3.1, SR-3.3)', () => {
  test('success: the new validation client, Web API client and socket are built and the socket reaches hello before the old socket is let go and closed; identity is the new auth.test result; A stays up; B undisturbed', async () => {
    const h = makeHarness()
    await bringUpBoth(h)
    const old = stubOf(h, h.a)
    const oldWeb = h.manager.webClient(h.a.key)
    const rotated = rotateCredentials(h, h.a)
    const since = h.slack.activityOf(h.a.key).length
    const { later, listener } = laterOutcomes()

    const outcome = await h.manager.reconnectCredentials(h.a.key, rotated.tokens, listener)

    assertNoLeak({ outcome, later })
    expect(outcome).toEqual({ kind: 'swapped', identity: rotated.identity })
    // Open before close: the new socket is connected before the old one is discarded and disconnected.
    expect(h.slack.activityOf(h.a.key).slice(since).map(e => [e.event, e.kind, e.credentials])).toEqual([
      ['built', 'validation', ROTATED],
      ['built', 'web', ROTATED],
      ['built', 'socket', ROTATED],
      ['started', 'socket', ROTATED],
      ['connected', 'socket', ROTATED],
      ['discarded', 'socket', INITIAL_CREDENTIALS],
      ['disconnected', 'socket', INITIAL_CREDENTIALS],
    ])
    // A different bot user ID, bot ID and team: no same-app check.
    expect(rotated.identity.botUserId).not.toBe(initialIdentityOf(h, h.a).botUserId)
    expect(rotated.identity.botId).not.toBe(initialIdentityOf(h, h.a).botId)
    expect(h.manager.identity(h.a.key)).toEqual(rotated.identity)
    expect(h.manager.status(h.a.key)).toEqual({ state: 'up', identity: rotated.identity })
    expect(statesOf(h, h.a)).toEqual(['connecting', 'up', 'up'])
    expect(later).toEqual([])

    // The old socket's close is the manager's own: no reopen, no persona-connection-lost line.
    expect(old.socket.lifecycle).toContain('disconnecting')
    await h.clock.advance(HOUR_MS)
    expect(stubStarts(old)).toBe(1)
    expect(rotated.stub.sockets.map(socket => [socket.startCalls, socket.connected])).toEqual([[1, true]])
    expect(h.lines).toEqual([])
    expect(h.clock.pendingCount()).toBe(0)

    // Events on the new connection are tagged with A; A's Web API calls go through the new client.
    await expectDelivers(h, h.a, rotated.stub)
    const web = h.manager.webClient(h.a.key)
    expect(web).toBeDefined()
    expect(web).not.toBe(oldWeb!)
    await web!.chat.postMessage({ channel: 'C0STUB0001', text: 'after the swap' })
    expect(rotated.stub.calls.postMessage).toHaveLength(1)
    expect(old.calls.postMessage).toEqual([])
    await expectBUndisturbed(h)
  })

  test('AC 20 connection leg: the reconnect’s validation, Web API and socket clients get exactly the SR-3.3 options and the new tokens, never the old', async () => {
    const noRetry = { retryConfig: { retries: 0 }, timeout: 10_000, rejectRateLimitedCalls: true, attachOriginalToWebAPIRequestError: false }
    const expected: Record<StubClientKind, Record<string, unknown>> = {
      validation: noRetry,
      web: { timeout: 30_000, attachOriginalToWebAPIRequestError: false },
      socket: { autoReconnectEnabled: false, clientOptions: noRetry },
    }
    const h = makeHarness()
    await bringUpBoth(h)
    const rotated = rotateCredentials(h, h.a)

    expect(await h.manager.reconnectCredentials(h.a.key, rotated.tokens)).toMatchObject({ kind: 'swapped' })

    const builds = h.slack.buildsOf(h.a.key).filter(build => build.credentials === ROTATED)
    expect(builds.map(build => build.kind)).toEqual(['validation', 'web', 'socket'])
    const oldTokens = fileTokensOf(h.a)
    for (const build of builds) {
      const options: Record<string, unknown> = { ...build.options }
      delete options.appToken
      expect(options).toStrictEqual(expected[build.kind])
      const [fresh, stale] = build.kind === 'socket'
        ? [rotated.tokens.appToken, oldTokens.appToken]
        : [rotated.tokens.botToken, oldTokens.botToken]
      expect(build.hasToken(fresh)).toBe(true)
      expect(build.hasToken(stale)).toBe(false)
    }
    await expectBUndisturbed(h)
  })

  // Rows: label, how the new credentials are refused, the check and cause the E2 classifier gives, and the clients built from them.
  test.each<[string, StubSlackOptions, 'auth.test' | 'socket-mode', string, StubClientKind[]]>([
    [
      'the bot token refused by auth.test',
      { authTest: [{ kind: 'platform', error: 'invalid_auth' }] },
      'auth.test',
      'bot_token refused by auth.test: Slack error invalid_auth',
      ['validation'],
    ],
    [
      'the app token refused at the Socket Mode open',
      { connect: [{ kind: 'platform', error: 'invalid_auth' }] },
      'socket-mode',
      'app_token refused by the Socket Mode open: Slack error invalid_auth',
      ['validation', 'web', 'socket'],
    ],
  ])('refused (%s): the old connection stays open and in use, identity unchanged; the call reports refused with the classifier cause; no new client is left open, nothing is retried or logged; B undisturbed', async (_label, script, check, cause, built) => {
    const h = makeHarness()
    await bringUpBoth(h)
    const oldWeb = h.manager.webClient(h.a.key)
    const rotated = rotateCredentials(h, h.a, ROTATED, script)
    const { later, listener } = laterOutcomes()

    const outcome = await h.manager.reconnectCredentials(h.a.key, rotated.tokens, listener)

    assertNoLeak({ outcome, later })
    expect(outcome).toEqual({
      kind: 'refused',
      outcome: {
        kind: 'credentials-refused',
        class: PERSONA_CREDENTIALS_REFUSED,
        check,
        key: check === 'auth.test' ? 'bot_token' : 'app_token',
        slackError: 'invalid_auth',
        cause,
      },
    })
    expect(builtFrom(h, h.a, ROTATED)).toEqual(built)
    // The refused socket, if one was built, was let go without ever connecting.
    expect(h.slack.activityOf(h.a.key).filter(a => a.credentials === ROTATED && a.kind === 'socket').map(a => a.event))
      .toEqual(built.includes('socket') ? ['built', 'started', 'discarded'] : [])
    expect(rotated.stub.sockets.filter(socket => socket.connected)).toEqual([])
    expect(h.lines).toEqual([])
    expect(h.clock.pendingCount()).toBe(0)
    await h.clock.advance(HOUR_MS)
    expect(rotated.stub.calls.authTest).toHaveLength(1)
    expect(stubStarts(rotated.stub)).toBe(built.includes('socket') ? 1 : 0)
    expect(later).toEqual([])
    expect(statesOf(h, h.a)).toEqual(['connecting', 'up'])
    await expectOldConnectionKept(h, h.a, oldWeb)
    await expectBUndisturbed(h)
  })

  test('Slack unreachable for the new credentials: the call returns retrying at once; the old connection stays in use while the new one retries at 5 s, then 10 s; when Slack answers the swap completes and the listener is told', async () => {
    const h = makeHarness()
    await bringUpBoth(h)
    const oldWeb = h.manager.webClient(h.a.key)
    const rotated = rotateCredentials(h, h.a, ROTATED, { authTest: [{ kind: 'network' }, { kind: 'network' }] })
    const { later, listener } = laterOutcomes()

    const outcome = await h.manager.reconnectCredentials(h.a.key, rotated.tokens, listener)

    // Returned without waiting for any retry.
    expect(h.clock.now()).toBe(0)
    expect(outcome).toEqual({
      kind: 'retrying',
      retryInMs: 5_000,
      outcome: expect.objectContaining({ kind: 'slack-unreachable', check: 'auth.test', key: 'bot_token', reason: 'network' }),
    })
    expect(pendingDelays(h)).toEqual([5_000])
    await expectOldConnectionKept(h, h.a, oldWeb)

    await h.clock.advance(4_999)
    expect(rotated.stub.calls.authTest).toHaveLength(1)
    await h.clock.advance(1)
    expect(rotated.stub.calls.authTest).toHaveLength(2)
    expect(pendingDelays(h)).toEqual([10_000])
    expect(later).toEqual([])
    await expectOldConnectionKept(h, h.a, oldWeb)
    await expectBUndisturbed(h)

    await h.clock.advance(10_000)
    expect(rotated.stub.calls.authTest).toHaveLength(3)
    expect(later).toEqual([{ kind: 'swapped', identity: rotated.identity }])
    expect(h.manager.status(h.a.key)).toEqual({ state: 'up', identity: rotated.identity })
    expect(statesOf(h, h.a)).toEqual(['connecting', 'up', 'up'])
    expect(stubOf(h, h.a).socket.disconnectCalls).toBe(1)
    expect(h.clock.pendingCount()).toBe(0)
    // The new connection's own Slack-unreachable episode: one start line, one cleared line, naming A.
    expect(h.lines.map(classOf)).toEqual([PERSONA_SLACK_UNREACHABLE, PERSONA_SLACK_UNREACHABLE])
    for (const line of h.lines) expect(line).toContain(renderPersonaRef(h.a.name, h.a.key))
    await expectDelivers(h, h.a, rotated.stub)
    await expectBUndisturbed(h)
    assertNoLeak({ outcome, later })
  })

  // Rows: label and how the new socket's start() hangs.
  test.each<[string, SettledConnectOutcome]>([
    ['the WebSocket phase never reaches hello', { kind: 'never' }],
    ['apps.connections.open never answers', { kind: 'open-never-answers' }],
  ])('a new start() that never settles (%s) is abandoned at exactly 10 s on the fake clock: its socket is disconnected, it counts as Slack-unreachable, the old connection stays, and the retry 5 s later swaps', async (_label, hang) => {
    const h = makeHarness()
    await bringUpBoth(h)
    const oldWeb = h.manager.webClient(h.a.key)
    const rotated = rotateCredentials(h, h.a, ROTATED, { connect: [hang] })
    const { later, listener } = laterOutcomes()
    let resolved: PersonaReconnectOutcome | undefined
    const reconnect = h.manager.reconnectCredentials(h.a.key, rotated.tokens, listener).then(outcome => (resolved = outcome))

    await h.clock.advanceTo(9_999)
    const hung = rotated.stub.socket
    expect(hung.startCalls).toBe(1)
    expect(resolved).toBeUndefined()
    expect(hung.disconnectCalls).toBe(0)
    await expectOldConnectionKept(h, h.a, oldWeb)
    await h.clock.advance(1)

    const outcome = await reconnect
    expect(outcome).toEqual({
      kind: 'retrying',
      retryInMs: 5_000,
      outcome: expect.objectContaining({ kind: 'slack-unreachable', check: 'socket-mode', key: 'app_token', reason: 'timeout' }),
    })
    expect(h.clock.now()).toBe(10_000)
    expect(hung.disconnectCalls).toBe(1)
    expect(pendingDelays(h)).toEqual([5_000])
    await expectOldConnectionKept(h, h.a, oldWeb)
    await expectBUndisturbed(h)

    await h.clock.advance(5_000)
    expect(later).toEqual([{ kind: 'swapped', identity: rotated.identity }])
    expect(rotated.stub.sockets.map(socket => socket.connected)).toEqual([false, true])
    expect(stubOf(h, h.a).socket.connected).toBe(false)
    expect(h.clock.pendingCount()).toBe(0)
    await expectDelivers(h, h.a, rotated.stub)
    await expectBUndisturbed(h)
    assertNoLeak({ outcome, later })
  })

  test('the swap cancels a reopen of the old connection in progress and closes its episode: one lost line, one restored line, no further start() of the old tokens', async () => {
    const h = makeHarness()
    await bringUpBoth(h)
    const old = stubOf(h, h.a)
    old.script.connect.push({ kind: 'network' })
    old.socket.drop()
    await h.clock.flush()
    expect(h.manager.status(h.a.key)).toMatchObject({ state: 'retrying', phase: 'reopen' })
    const rotated = rotateCredentials(h, h.a)

    expect(await h.manager.reconnectCredentials(h.a.key, rotated.tokens)).toEqual({ kind: 'swapped', identity: rotated.identity })

    expect(h.clock.pendingCount()).toBe(0)
    await h.clock.advance(HOUR_MS)
    expect(stubStarts(old)).toBe(2)
    expect(h.lines.map(classOf)).toEqual([PERSONA_CONNECTION_LOST, PERSONA_CONNECTION_RESTORED])
    expect(statesOf(h, h.a)).toEqual(['connecting', 'up', 'lost', 'retrying', 'up'])
    await expectDelivers(h, h.a, rotated.stub)
    await expectBUndisturbed(h)
  })

  test('the swap cancels a reopen of the old connection whose start() is in flight: its socket is closed, its 10 s bound goes with it, and A stays up on the new connection however far the clock runs', async () => {
    const h = makeHarness()
    await bringUpBoth(h)
    const old = stubOf(h, h.a)
    old.script.connect.push({ kind: 'never' })
    old.socket.drop()
    await h.clock.flush()
    expect(h.manager.status(h.a.key)).toEqual({ state: 'lost' })
    const reopening = old.socket
    expect(reopening.startCalls).toBe(1)
    const rotated = rotateCredentials(h, h.a)

    expect(await h.manager.reconnectCredentials(h.a.key, rotated.tokens)).toEqual({ kind: 'swapped', identity: rotated.identity })
    await h.clock.flush()

    expect(reopening.disconnectCalls).toBe(1)
    expect(h.clock.pendingCount()).toBe(0)
    await h.clock.advance(HOUR_MS)
    expect(h.manager.status(h.a.key)).toEqual({ state: 'up', identity: rotated.identity })
    expect(stubStarts(old)).toBe(2)
    expect(h.lines.map(classOf)).toEqual([PERSONA_CONNECTION_LOST, PERSONA_CONNECTION_RESTORED])
    expect(statesOf(h, h.a)).toEqual(['connecting', 'up', 'lost', 'up'])
    await expectDelivers(h, h.a, rotated.stub)
    await expectBUndisturbed(h)
  })

  test('unreachable, then refused: a later backoff attempt refused reaches the listener, the retries stop, the new connection’s unreachable episode gets its one cleared line and the old connection is intact', async () => {
    const h = makeHarness()
    await bringUpBoth(h)
    const oldWeb = h.manager.webClient(h.a.key)
    const rotated = rotateCredentials(h, h.a, ROTATED, {
      authTest: [{ kind: 'network' }, { kind: 'platform', error: 'token_revoked' }],
    })
    const { later, listener } = laterOutcomes()
    const first = await h.manager.reconnectCredentials(h.a.key, rotated.tokens, listener)
    expect(first).toMatchObject({ kind: 'retrying', retryInMs: 5_000 })

    await h.clock.advance(5_000)

    expect(later).toEqual([{
      kind: 'refused',
      outcome: expect.objectContaining({ check: 'auth.test', key: 'bot_token', slackError: 'token_revoked' }),
    }])
    expect(h.clock.pendingCount()).toBe(0)
    await h.clock.advance(HOUR_MS)
    expect(rotated.stub.calls.authTest).toHaveLength(2)
    expect(builtFrom(h, h.a, ROTATED)).toEqual(['validation', 'validation'])
    expect(later).toHaveLength(1)
    // The new connection's unreachable episode: its start line, then its cleared line once Slack
    // answered (with the refusal). The refusal itself is its caller's to log.
    expect(h.lines).toEqual([
      personaLine(h.a, PERSONA_SLACK_UNREACHABLE, retryingCause(first)),
      personaLine(h.a, PERSONA_SLACK_UNREACHABLE, 'cleared: Slack answered after being unreachable checking bot_token via auth.test'),
    ])
    // The reconnect is over: stopping A later ends no episode a second time.
    await expectOldConnectionKept(h, h.a, oldWeb)
    await expectBUndisturbed(h)
    await h.manager.stop(h.a.key)
    expect(h.lines).toHaveLength(2)
    assertNoLeak({ first, later })
  })

  test('a second reconnect while the first is retrying cancels the first: only the latest tokens are tried on the fake clock, one timer at a time, and no client or timer of the first remains', async () => {
    const h = makeHarness()
    await bringUpBoth(h)
    const first = rotateCredentials(h, h.a, 'first', { authTest: [{ kind: 'network' }] })
    const second = rotateCredentials(h, h.a, 'second', { authTest: [{ kind: 'network' }] })
    const firstLater = laterOutcomes()
    const secondLater = laterOutcomes()
    expect(await h.manager.reconnectCredentials(h.a.key, first.tokens, firstLater.listener)).toMatchObject({ kind: 'retrying' })
    await h.clock.advance(2_000)

    expect(await h.manager.reconnectCredentials(h.a.key, second.tokens, secondLater.listener)).toMatchObject({ kind: 'retrying', retryInMs: 5_000 })

    // The first's timer (due at 5 s) is gone; the second's (due at 7 s) is the only one.
    expect(h.clock.pending().map(timer => timer.dueAt)).toEqual([7_000])
    await h.clock.advance(5_000)
    expect(secondLater.later).toEqual([{ kind: 'swapped', identity: second.identity }])
    expect(h.manager.status(h.a.key)).toEqual({ state: 'up', identity: second.identity })
    await h.clock.advance(HOUR_MS)
    expect(first.stub.calls.authTest).toHaveLength(1)
    expect(builtFrom(h, h.a, 'first')).toEqual(['validation'])
    expect(second.stub.calls.authTest).toHaveLength(2)
    expect(firstLater.later).toEqual([])
    expect(h.clock.pendingCount()).toBe(0)
    await expectDelivers(h, h.a, second.stub)
    await expectBUndisturbed(h)
    assertNoLeak({ first: firstLater.later, second: secondLater.later })
  })

  test('a second reconnect while the first’s start() is in flight cancels it: the first resolves cancelled, its socket is closed and never counts, and the second swaps', async () => {
    const h = makeHarness()
    await bringUpBoth(h)
    const first = rotateCredentials(h, h.a, 'first', { connect: [{ kind: 'never' }] })
    const second = rotateCredentials(h, h.a, 'second')
    const firstCall = h.manager.reconnectCredentials(h.a.key, first.tokens)
    await h.clock.flush()
    const firstSocket = first.stub.socket
    expect(firstSocket.startCalls).toBe(1)

    const secondOutcome = await h.manager.reconnectCredentials(h.a.key, second.tokens)

    expect(await firstCall).toEqual({ kind: 'cancelled' })
    expect(secondOutcome).toEqual({ kind: 'swapped', identity: second.identity })
    expect(firstSocket.disconnectCalls).toBe(1)
    expect(h.manager.identity(h.a.key)).toEqual(second.identity)
    expect(h.clock.pendingCount()).toBe(0)
    await h.clock.advance(HOUR_MS)
    expect(stubStarts(first.stub)).toBe(1)
    expect(second.stub.sockets.map(socket => socket.connected)).toEqual([true])
    await expectDelivers(h, h.a, second.stub)
    await expectBUndisturbed(h)
  })

  test('the teardown path: stopping A cancels a reconnect left retrying: no timer is left, no further auth.test or start() on the fake clock, and the listener is never told; B undisturbed', async () => {
    const h = makeHarness()
    await bringUpBoth(h)
    const rotated = rotateCredentials(h, h.a, ROTATED, { authTest: [{ kind: 'network' }] })
    const { later, listener } = laterOutcomes()
    expect(await h.manager.reconnectCredentials(h.a.key, rotated.tokens, listener)).toMatchObject({ kind: 'retrying' })

    await h.manager.stop(h.a.key)

    expect(h.clock.pendingCount()).toBe(0)
    await h.clock.advance(HOUR_MS)
    expect(rotated.stub.calls.authTest).toHaveLength(1)
    expect(builtFrom(h, h.a, ROTATED)).toEqual(['validation'])
    expect(later).toEqual([])
    expect(h.manager.status(h.a.key)).toBeUndefined()
    await expectBUndisturbed(h)
  })

  // Rows: label and the new credentials' script that leaves the reconnect pending.
  test.each<[string, StubSlackOptions]>([
    ['left retrying', { authTest: [{ kind: 'network' }] }],
    ['with its start() in flight', { connect: [{ kind: 'never' }] }],
  ])('shutdown during a reconnect %s leaves no pending timer and no open new client', async (_label, script) => {
    const h = makeHarness()
    await bringUpBoth(h)
    const rotated = rotateCredentials(h, h.a, ROTATED, script)
    const { later, listener } = laterOutcomes()
    let resolved: PersonaReconnectOutcome | undefined
    void h.manager.reconnectCredentials(h.a.key, rotated.tokens, listener).then(outcome => (resolved = outcome))
    await h.clock.flush()
    await expectBUndisturbed(h)
    const authTests = rotated.stub.calls.authTest.length
    const starts = stubStarts(rotated.stub)

    await h.manager.stopAll()
    await h.clock.flush()

    expect(resolved).toEqual(script.connect === undefined ? expect.objectContaining({ kind: 'retrying' }) : { kind: 'cancelled' })
    expect(h.clock.pendingCount()).toBe(0)
    expect(rotated.stub.sockets.filter(socket => socket.connected)).toEqual([])
    expect(rotated.stub.sockets.map(socket => socket.disconnectCalls)).toEqual(script.connect === undefined ? [] : [1])
    await h.clock.advance(HOUR_MS)
    expect(rotated.stub.calls.authTest).toHaveLength(authTests)
    expect(stubStarts(rotated.stub)).toBe(starts)
    expect(later).toEqual([])
  })

  test('overlap: events emitted on the old and the new socket before the swap are both tagged with A; a duplicate (channel, ts) on both reaches the handler once per socket, for the routing dedupe to collapse', async () => {
    // The manager does not dedupe: the per-persona dedupe in the routing does.
    // tests/persona-routing.test.ts, "SR-4.1 per-persona dedupe through the
    // pipeline" (`the same \`message\` redelivered on A's one connection` and
    // `dedupe is per persona key …`), shows a redelivered (channel, ts) for
    // one key collapses to one notification, whichever connection brought it.
    const h = makeHarness()
    await bringUpBoth(h)
    const hello = makeDeferredConnect()
    const rotated = rotateCredentials(h, h.a, ROTATED, { connect: [hello.outcome] })
    const reconnect = h.manager.reconnectCredentials(h.a.key, rotated.tokens)
    await h.clock.flush()
    const oldSocket = stubOf(h, h.a).socket
    const newSocket = rotated.stub.socket
    const duplicate = makeChannelMessage({ text: 'seen on both sockets' })
    const deliveries: Promise<void>[] = []
    // Both sockets are open during the new one's `connected` emit, before the swap.
    newSocket.once('connected', () => {
      expect(oldSocket.connected).toBe(true)
      deliveries.push(newSocket.deliver(duplicate), oldSocket.deliver(duplicate))
    })

    hello.settle()
    expect(await reconnect).toMatchObject({ kind: 'swapped' })
    await Promise.all(deliveries)

    expect(deliveries).toHaveLength(2)
    expect(h.events.filter(e => e.payload.event === duplicate).map(e => e.key)).toEqual([h.a.key, h.a.key])
    expect(oldSocket.connected).toBe(false)
    await expectDelivers(h, h.a, rotated.stub)
    await expectBUndisturbed(h)
  })

  test('nothing to reconnect: an unknown or stopped persona, or dry run, resolves cancelled and builds nothing', async () => {
    const h = makeHarness()
    await bringUpBoth(h)
    const rotated = rotateCredentials(h, h.a)
    const dry = makeHarness({ dryRun: true })
    await dry.manager.bringUp(dry.a)

    expect(await h.manager.reconnectCredentials('no_such_persona', rotated.tokens)).toEqual({ kind: 'cancelled' })
    expect(await dry.manager.reconnectCredentials(dry.a.key, rotated.tokens)).toEqual({ kind: 'cancelled' })
    expect(dry.manager.replaceRetryTokens(dry.a.key, rotated.tokens)).toBe(false)
    await h.manager.stop(h.a.key)
    expect(await h.manager.reconnectCredentials(h.a.key, rotated.tokens)).toEqual({ kind: 'cancelled' })

    expect(builtFrom(h, h.a, ROTATED)).toEqual([])
    expect(dry.slack.builds).toEqual([])
    expect(h.clock.pendingCount()).toBe(0)
    await expectBUndisturbed(h)
  })
})

/** Cause of the cleared line of a pending reconnect's unreachable episode when a later reconnect replaced it. */
const RECONNECT_SUPERSEDED_CLEARED =
  'cleared: the new connection of its confirmed credentials change is no longer retried: a later confirmed credentials change replaced it'

/** Cause of the cleared line of a pending reconnect's unreachable episode when the persona's connection was stopped. */
const RECONNECT_STOPPED_CLEARED =
  'cleared: the new connection of its confirmed credentials change is no longer retried: the persona\'s connection was stopped'

describe('connection manager: a credentials reconnect’s beforeSwap hook (b.av2 SR-8.6 credentials row)', () => {
  /** What beforeSwap saw of A when it ran: its reported status, identity, client and both sockets. */
  interface SwapView {
    status: PersonaConnectionStatus | undefined
    identity: { botUserId: string; botId: string } | undefined
    oldClient: boolean
    oldSocketConnected: boolean
    newSocketConnected: boolean
  }

  /**
   * A harness whose second status listener appends `status:<state>` for A to
   * `order`, and a beforeSwap that appends `beforeSwap` and records what it saw.
   */
  async function makeOrderedHarness(script: StubSlackOptions = {}) {
    const order: string[] = []
    const alphaKey = personaKey('Alpha')
    const h = makeHarness({
      onStatus: (key, status) => {
        if (key === alphaKey) order.push(`status:${status.state}`)
      },
    })
    await bringUpBoth(h)
    order.length = 0
    const oldWeb = h.manager.webClient(h.a.key)
    const old = stubOf(h, h.a)
    const rotated = rotateCredentials(h, h.a, ROTATED, script)
    const seen: SwapView[] = []
    const beforeSwap = (): void => {
      order.push('beforeSwap')
      seen.push({
        status: h.manager.status(h.a.key),
        identity: h.manager.identity(h.a.key),
        oldClient: h.manager.webClient(h.a.key) === oldWeb,
        oldSocketConnected: old.socket.connected,
        newSocketConnected: rotated.stub.socket.connected,
      })
    }
    return { h, order, rotated, seen, beforeSwap }
  }

  /** A as beforeSwap must see it: still up on its old connection, the new socket already past hello. */
  function oldConnectionView(h: Harness): SwapView {
    const identity = initialIdentityOf(h, h.a)
    return { status: { state: 'up', identity }, identity, oldClient: true, oldSocketConnected: true, newSocketConnected: true }
  }

  test('a first-attempt swap: beforeSwap runs once, while A still reports its old status, identity and client with its old socket open, and before any status listener hears A up on the new connection', async () => {
    const { h, order, rotated, seen, beforeSwap } = await makeOrderedHarness()

    const outcome = await h.manager.reconnectCredentials(h.a.key, rotated.tokens, undefined, beforeSwap)

    expect(outcome).toEqual({ kind: 'swapped', identity: rotated.identity })
    expect(order).toEqual(['beforeSwap', 'status:up'])
    expect(seen).toEqual([oldConnectionView(h)])
    expect(h.manager.status(h.a.key)).toEqual({ state: 'up', identity: rotated.identity })
    expect(h.lines).toEqual([])
    await expectDelivers(h, h.a, rotated.stub)
    await expectBUndisturbed(h)
    assertNoLeak({ outcome, seen })
  })

  test('a later swap of a reconnect left retrying: beforeSwap is not run at the unreachable first attempt, then runs once right before the swap, before the status listener hears A up and before the reconnect’s listener is told', async () => {
    const { h, order, rotated, seen, beforeSwap } = await makeOrderedHarness({ authTest: [{ kind: 'network' }] })
    const later: PersonaReconnectLaterOutcome[] = []
    const listener = (outcome: PersonaReconnectLaterOutcome): void => {
      order.push(`later:${outcome.kind}`)
      later.push(outcome)
    }

    const first = await h.manager.reconnectCredentials(h.a.key, rotated.tokens, listener, beforeSwap)
    expect(first).toMatchObject({ kind: 'retrying', retryInMs: 5_000 })
    expect(order).toEqual([])

    await h.clock.advance(5_000)

    expect(order).toEqual(['beforeSwap', 'status:up', 'later:swapped'])
    expect(seen).toEqual([oldConnectionView(h)])
    expect(later).toEqual([{ kind: 'swapped', identity: rotated.identity }])
    expect(h.manager.status(h.a.key)).toEqual({ state: 'up', identity: rotated.identity })
    await expectDelivers(h, h.a, rotated.stub)
    await expectBUndisturbed(h)
    assertNoLeak({ first, later, seen })
  })

  // Rows: label and a beforeSwap that fails that way with a sentinel-bearing error.
  test.each<[string, (err: Error) => unknown]>([
    ['throws', err => {
      throw err
    }],
    ['returns a rejected promise', err => Promise.reject(err)],
  ])('a beforeSwap that %s is logged once, token-free, naming A, and the swap still happens', async (_label, fail) => {
    const h = makeHarness()
    await bringUpBoth(h)
    const old = stubOf(h, h.a)
    const rotated = rotateCredentials(h, h.a)
    const err = new Error(`before-swap failed with ${fakeToken(BOT_TOKEN_PREFIX, 'in-hook')}`)
    let calls = 0

    const outcome = await h.manager.reconnectCredentials(h.a.key, rotated.tokens, undefined, () => {
      calls++
      return fail(err)
    })
    await h.clock.flush()

    expect(calls).toBe(1)
    expect(outcome).toEqual({ kind: 'swapped', identity: rotated.identity })
    expect(h.manager.status(h.a.key)).toEqual({ state: 'up', identity: rotated.identity })
    expect(statesOf(h, h.a)).toEqual(['connecting', 'up', 'up'])
    expect(h.lines).toEqual([
      `[slack] persona credentials reconnect before-swap hook failed: personas[0] ${renderPersonaRef(h.a.name, h.a.key)}: ${describeThrownValue(err)}`,
    ])
    expect(old.socket.connected).toBe(false)
    expect(h.clock.pendingCount()).toBe(0)
    await expectDelivers(h, h.a, rotated.stub)
    await expectBUndisturbed(h)
    assertNoLeak({ outcome, lines: h.lines })
  })

  // Rows: label, the new credentials' script, and what ends the reconnect without a swap (its outcome
  // or later outcome given back for the leak check). No beforeSwap runs in any of them.
  test.each<[string, StubSlackOptions, (h: Harness, first: Promise<PersonaReconnectOutcome>) => Promise<unknown>]>([
    ['refused at its first attempt', { authTest: [{ kind: 'platform', error: 'invalid_auth' }] }, async (_h, first) => {
      const outcome = await first
      expect(outcome).toMatchObject({ kind: 'refused' })
      return outcome
    }],
    ['refused at a later attempt', { authTest: [{ kind: 'network' }, { kind: 'platform', error: 'token_revoked' }] }, async (h, first) => {
      const outcome = await first
      expect(outcome).toMatchObject({ kind: 'retrying' })
      await h.clock.advance(5_000)
      return outcome
    }],
    ['superseded by a later reconnect while its start() is in flight', { connect: [{ kind: 'never' }] }, async (h, first) => {
      const second = rotateCredentials(h, h.a, 'second')
      const outcome = await h.manager.reconnectCredentials(h.a.key, second.tokens)
      expect(await first).toEqual({ kind: 'cancelled' })
      expect(outcome).toEqual({ kind: 'swapped', identity: second.identity })
      return outcome
    }],
    ['cancelled by stopping A while it retries', { authTest: [{ kind: 'network' }] }, async (h, first) => {
      const outcome = await first
      expect(outcome).toMatchObject({ kind: 'retrying' })
      await h.manager.stop(h.a.key)
      return outcome
    }],
  ])('%s: beforeSwap is never run', async (_label, script, end) => {
    const h = makeHarness()
    await bringUpBoth(h)
    const rotated = rotateCredentials(h, h.a, ROTATED, script)
    let calls = 0

    const first = h.manager.reconnectCredentials(h.a.key, rotated.tokens, undefined, () => void calls++)
    await h.clock.flush()
    const ended = await end(h, first)
    await h.clock.advance(HOUR_MS)

    expect(calls).toBe(0)
    expect(rotated.stub.sockets.filter(socket => socket.connected)).toEqual([])
    expect(h.clock.pendingCount()).toBe(0)
    await expectBUndisturbed(h)
    assertNoLeak({ ended })
  })
})

describe('connection manager: a pending credentials reconnect’s unreachable episode always ends (SR-10.3)', () => {
  // Rows: label, the first reconnect's script, what ends it, and the cause of the one cleared line
  // (null: its first attempt was still in flight, so no episode was open and nothing is logged).
  test.each<[string, StubSlackOptions, 'supersede' | 'stop' | 'stopAll', string | null]>([
    ['left retrying, then a later reconnect supersedes it', { authTest: [{ kind: 'network' }] }, 'supersede', RECONNECT_SUPERSEDED_CLEARED],
    ['left retrying, then A is stopped (the teardown)', { authTest: [{ kind: 'network' }] }, 'stop', RECONNECT_STOPPED_CLEARED],
    ['left retrying, then every persona is stopped (shutdown)', { authTest: [{ kind: 'network' }] }, 'stopAll', RECONNECT_STOPPED_CLEARED],
    ['its first attempt in flight, then a later reconnect supersedes it', { connect: [{ kind: 'never' }] }, 'supersede', null],
    ['its first attempt in flight, then A is stopped', { connect: [{ kind: 'never' }] }, 'stop', null],
  ])('%s: exactly the lines it opened and closed, none more', async (_label, script, how, cleared) => {
    const h = makeHarness()
    await bringUpBoth(h)
    const rotated = rotateCredentials(h, h.a, ROTATED, script)
    const second = rotateCredentials(h, h.a, 'second')
    const firstCall = h.manager.reconnectCredentials(h.a.key, rotated.tokens)
    await h.clock.flush()

    let secondOutcome: PersonaReconnectOutcome | undefined
    if (how === 'supersede') secondOutcome = await h.manager.reconnectCredentials(h.a.key, second.tokens)
    else if (how === 'stop') await h.manager.stop(h.a.key)
    else await h.manager.stopAll()
    const first = await firstCall
    await h.clock.advance(HOUR_MS)

    expect(h.lines).toEqual(
      cleared === null
        ? []
        : [personaLine(h.a, PERSONA_SLACK_UNREACHABLE, retryingCause(first)), personaLine(h.a, PERSONA_SLACK_UNREACHABLE, cleared)],
    )
    expect(first).toMatchObject({ kind: cleared === null ? 'cancelled' : 'retrying' })
    expect(rotated.stub.sockets.filter(socket => socket.connected)).toEqual([])
    expect(h.clock.pendingCount()).toBe(0)
    if (how === 'supersede') {
      expect(secondOutcome).toEqual({ kind: 'swapped', identity: second.identity })
      await expectDelivers(h, h.a, second.stub)
    } else {
      expect(h.manager.status(h.a.key)).toBeUndefined()
    }
    if (how !== 'stopAll') await expectBUndisturbed(h)
    // Stopping everything afterwards ends nothing a second time.
    await h.manager.stopAll()
    expect(h.lines).toHaveLength(cleared === null ? 0 : 2)
    assertNoLeak({ first, secondOutcome, lines: h.lines })
  })
})

describe('connection manager: a retrying persona takes the new credentials (replaceRetryTokens, b.av2 SR-8.6)', () => {
  test('A Slack-unreachable at bring-up keeps its pending retry; the retry uses only the new tokens and comes up with their identity; B undisturbed', async () => {
    const h = makeHarness()
    stubOf(h, h.a).script.authTest.push({ kind: 'network' })
    expect(await h.manager.bringUp(h.a, h.a.tokens)).toMatchObject({ state: 'retrying', phase: 'bring-up', retryInMs: 5_000 })
    expect(await h.manager.bringUp(h.b, h.b.tokens)).toMatchObject({ state: 'up' })
    const rotated = rotateCredentials(h, h.a)

    expect(h.manager.replaceRetryTokens(h.a.key, rotated.tokens)).toBe(true)

    // Nothing starts at once: the pending retry is kept.
    expect(builtFrom(h, h.a, ROTATED)).toEqual([])
    expect(pendingDelays(h)).toEqual([5_000])
    await h.clock.advance(5_000)
    expect(h.manager.status(h.a.key)).toEqual({ state: 'up', identity: rotated.identity })
    expect(builtFrom(h, h.a, ROTATED)).toEqual(['validation', 'web', 'socket'])
    expect(builtFrom(h, h.a, INITIAL_CREDENTIALS)).toEqual(['validation'])
    expect(stubOf(h, h.a).calls.authTest).toHaveLength(1)
    await h.manager.webClient(h.a.key)!.chat.postMessage({ channel: 'C0STUB0001', text: 'with the new token' })
    expect(rotated.stub.calls.postMessage).toHaveLength(1)
    await expectDelivers(h, h.a, rotated.stub)
    expect(h.clock.pendingCount()).toBe(0)
    await expectBUndisturbed(h)
  })

  test('an attempt in flight with the old tokens is cancelled and one with the new tokens starts at once: never two attempts, one live socket, no timer left', async () => {
    const h = makeHarness()
    stubOf(h, h.a).script.authTest.push({ kind: 'never' })
    const bringUpA = h.manager.bringUp(h.a, h.a.tokens)
    expect(await h.manager.bringUp(h.b, h.b.tokens)).toMatchObject({ state: 'up' })
    await h.clock.flush()
    expect(h.manager.status(h.a.key)).toEqual({ state: 'connecting' })
    const rotated = rotateCredentials(h, h.a)

    expect(h.manager.replaceRetryTokens(h.a.key, rotated.tokens)).toBe(true)
    await bringUpA
    await h.clock.flush()

    expect(h.manager.status(h.a.key)).toEqual({ state: 'up', identity: rotated.identity })
    // The old attempt's 10 s bound went with it: no timer, no abandonment, no retry.
    expect(h.clock.pendingCount()).toBe(0)
    await h.clock.advance(HOUR_MS)
    expect(builtFrom(h, h.a, INITIAL_CREDENTIALS)).toEqual(['validation'])
    expect(builtFrom(h, h.a, ROTATED)).toEqual(['validation', 'web', 'socket'])
    expect(rotated.stub.sockets.map(socket => socket.connected)).toEqual([true])
    expect(h.lines).toEqual([])
    await expectDelivers(h, h.a, rotated.stub)
    await expectBUndisturbed(h)
  })

  test('a bring-up whose socket failed after auth.test built a Web API client from the old bot token: the retry builds one from the new token, and A’s posts land on the new credentials only', async () => {
    const h = makeHarness()
    stubOf(h, h.a).script.connect.push({ kind: 'network' })
    expect(await h.manager.bringUp(h.a, h.a.tokens)).toMatchObject({ state: 'retrying', phase: 'bring-up', retryInMs: 5_000 })
    expect(await h.manager.bringUp(h.b, h.b.tokens)).toMatchObject({ state: 'up' })
    expect(builtFrom(h, h.a, INITIAL_CREDENTIALS)).toEqual(['validation', 'web', 'socket'])
    const rotated = rotateCredentials(h, h.a)

    expect(h.manager.replaceRetryTokens(h.a.key, rotated.tokens)).toBe(true)
    await h.clock.advance(5_000)

    expect(h.manager.status(h.a.key)).toEqual({ state: 'up', identity: rotated.identity })
    expect(builtFrom(h, h.a, ROTATED)).toEqual(['validation', 'web', 'socket'])
    await h.manager.webClient(h.a.key)!.chat.postMessage({ channel: 'C0STUB0001', text: 'with the new token' })
    expect(rotated.stub.calls.postMessage).toHaveLength(1)
    expect(stubOf(h, h.a).calls.postMessage).toEqual([])
    expect(h.clock.pendingCount()).toBe(0)
    await expectDelivers(h, h.a, rotated.stub)
    await expectBUndisturbed(h)
  })

  // Rows: label and how A is left; in each, A is not retrying its bring-up.
  test.each<[string, (h: Harness) => Promise<void>]>([
    ['up (it is reconnected instead)', async () => {}],
    [
      'retrying a reopen',
      async h => {
        stubOf(h, h.a).script.connect.push({ kind: 'network' })
        stubOf(h, h.a).socket.drop()
        await h.clock.flush()
      },
    ],
    ['stopped', async h => h.manager.stop(h.a.key)],
  ])('a persona that is %s does not take new tokens: false, and no client is ever built from them', async (_label, arrange) => {
    const h = makeHarness()
    await bringUpBoth(h)
    await arrange(h)
    const rotated = rotateCredentials(h, h.a)

    expect(h.manager.replaceRetryTokens(h.a.key, rotated.tokens)).toBe(false)
    expect(h.manager.replaceRetryTokens('no_such_persona', rotated.tokens)).toBe(false)

    await h.clock.advance(HOUR_MS)
    expect(builtFrom(h, h.a, ROTATED)).toEqual([])
    await expectBUndisturbed(h)
  })
})

describe('persona-credentials-change-failed lines (SR-10.3)', () => {
  // Rows: label, the cause as the failing check words it, what the persona keeps, and fragments the cause must hold.
  test.each<[string, (persona: BringUpPersona, other: OtherBringUpPersona) => Promise<string>, CredentialsChangeKept, string[]]>([
    ['missing', async persona => checkCause(checkPersonaCredentials(persona, { others: [] })), 'connection', ['does not exist']],
    [
      'unreadable',
      async persona => (writeCreds(persona), checkCause(checkPersonaCredentials(persona, { others: [], fs: { openFile: failsWith('EACCES') } }))),
      'content',
      [],
    ],
    [
      'invalid (key and rule, no value)',
      async persona => (writeCreds(persona, { bot_token: fakeToken('xoxp-') }), checkCause(checkPersonaCredentials(persona, { others: [] }))),
      'connection',
      ['bot_token must start with xoxb-'],
    ],
    [
      'a real path shared with another applied persona',
      async (persona, other) => (
        writeCreds(other),
        checkCause(checkPersonaCredentials({ ...persona, credentials_file: other.credentials_file }, { others: [other] }))
      ),
      'connection',
      ['credentials_file'],
    ],
    [
      'refused: the bot token via auth.test',
      async () => (await failureVia('auth.test', { kind: 'platform', error: 'invalid_auth' })).cause,
      'connection',
      ['bot_token', 'auth.test', 'invalid_auth'],
    ],
    [
      'refused: the app token via the Socket Mode open',
      async () => (await failureVia('socket-mode', { kind: 'platform', error: 'token_revoked' })).cause,
      'connection',
      ['app_token', 'Socket Mode open', 'token_revoked'],
    ],
  ])('%s: one line naming the persona (JSON-quoted, key beside it), personas[i], the path, the cause, what is kept and that the change stays pending', async (label, causeOf, kept, fragments) => {
    const persona = makePersona('Night "Ops" Desk', { index: 3 })
    const other = makeOther()
    const cause = await causeOf(persona, other)

    const line = formatCredentialsChangeFailed({
      name: persona.name,
      key: persona.key,
      index: persona.index,
      path: persona.credentials_file,
      cause,
      kept,
    })

    assertNoLeak({ cause, line }, label)
    const keptText = kept === 'connection' ? 'the current connection stays in use' : 'it keeps retrying with its current credentials'
    expect(line).toBe(
      `[slack] ${PERSONA_CREDENTIALS_CHANGE_FAILED}: personas[3] ${renderPersonaRef(persona.name, persona.key)} ` +
      `path=${JSON.stringify(persona.credentials_file)}: the confirmed credentials change cannot be used: ${cause}; ` +
      `${keptText}, and the change stays pending`,
    )
    expect(classOf(line)).toBe(PERSONA_CREDENTIALS_CHANGE_FAILED)
    expect(line).toContain(`${JSON.stringify(persona.name)} (key=${persona.key})`)
    expect(line).not.toMatch(/[\r\n]/)
    for (const fragment of fragments) expect(cause).toContain(fragment)
    if (label.startsWith('a real path shared')) expect(cause).toContain(renderPersonaRef(other.name, other.key))
  })
})

/** The cause of a failed credentials check; throws (naming only the outcome) if the check passed. */
function checkCause(result: ReturnType<typeof checkPersonaCredentials>): string {
  if (result.ok) throw new Error('expected a credentials check failure, got ok')
  return result.cause
}

// ---------------------------------------------------------------------------
// Revoked bot token while running: the Web API auth-error watch (bug b.ujn)
//
// The manager wraps every long-lived Web API client it hands out; the first
// `invalid_auth`, `token_revoked`, `account_inactive` or `not_authed` from a
// call on a persona's current client marks the persona credentials-broken
// at once. Failures are scripted on the stub (leak marker on), each on the
// first call it applies to.
// ---------------------------------------------------------------------------

/** The Slack errors that mean the bot token no longer works. */
const WEB_API_AUTH_CODES = ['token_revoked', 'invalid_auth', 'account_inactive', 'not_authed'] as const

/** A Web API call through a persona's client, and the stub script queue that answers it. */
type WatchedCall = [method: string, queue: keyof StubSlackScript, call: (web: ManagedWebClient) => Promise<unknown>]

const WATCH_CHANNEL = 'C0STUB0001'
const WATCHED_CALLS: WatchedCall[] = [
  ['chat.postMessage', 'post', web => web.chat.postMessage({ channel: WATCH_CHANNEL, text: 'hello' })],
  ['reactions.add', 'reactionsAdd', web => web.reactions.add({ channel: WATCH_CHANNEL, timestamp: '1700000000.000100', name: 'eyes' })],
  ['reactions.remove', 'reactionsRemove', web => web.reactions.remove({ channel: WATCH_CHANNEL, timestamp: '1700000000.000100', name: 'eyes' })],
  ['conversations.open', 'open', web => web.conversations.open({ users: 'U0BOB' })],
  ['conversations.history', 'history', web => web.conversations.history({ channel: WATCH_CHANNEL })],
  ['users.info', 'usersInfo', web => web.users.info({ user: 'U0BOB' })],
  ['filesUploadV2', 'upload', web => web.filesUploadV2({ channel_id: WATCH_CHANNEL, file: Buffer.from('report'), filename: 'report.txt' })],
  // apiCall is named by the method it calls.
  ['conversations.mark', 'apiCall', web => web.apiCall('conversations.mark', { channel: WATCH_CHANNEL, ts: '1700000000.000100' })],
]

/** Settle a call and return what it rejected with (or `undefined` if it resolved). */
async function rejectionOf(call: Promise<unknown>): Promise<unknown> {
  return call.then(() => undefined, (err: unknown) => err)
}

/** The outcome a refused call of `method` with `code` marks A with. */
function webApiRefusal(method: string, code: string): SlackCredentialsRefusedOutcome {
  return {
    kind: 'credentials-refused',
    class: PERSONA_CREDENTIALS_REFUSED,
    check: 'web-api',
    key: 'bot_token',
    slackError: code,
    method,
    cause: `bot_token refused by a Web API call (${method}): Slack error ${code}`,
  }
}

/** The one line a refused call of `method` with `code` logs for A: personas[i], A and its credentials path. */
function webApiRefusalLine(h: Harness, method: string, code: string): string {
  return formatPersonaDiagnostic({
    class: PERSONA_CREDENTIALS_REFUSED,
    name: h.a.name,
    key: h.a.key,
    index: h.a.index,
    path: h.a.credentials_file,
    cause: `bot_token refused by a Web API call (${method}): Slack error ${code}`,
  })
}

/** How many times A was reported broken. */
function brokenReportsOf(h: Harness, p: ManagedPersona): number {
  return h.statuses.filter(([key, status]) => key === p.key && status.state === 'broken').length
}

describe('connection manager: a revoked bot token while running (the Web API auth-error watch, bug b.ujn)', () => {
  test.each([...WEB_API_AUTH_CODES])('%s from a call on A’s client marks A broken at once: the caller gets the original rejection, the listener hears broken once, one line names A and its credentials path, A’s socket is closed as the manager’s own close with no reopen, a later call never reaches Slack; B is untouched', async code => {
    const h = makeHarness()
    await bringUpBoth(h)
    const a = stubOf(h, h.a)
    const web = h.manager.webClient(h.a.key)!
    const webB = h.manager.webClient(h.b.key)
    a.script.post.push({ kind: 'platform', error: code })

    const thrown = await rejectionOf(web.chat.postMessage({ channel: WATCH_CHANNEL, text: 'hello' }))

    // The caller's own rejection is Slack's error, unchanged (the stub planted the sentinel in it).
    expect(thrown).toMatchObject({ code: 'slack_webapi_platform_error', data: { error: code } })
    expect(thrown).not.toBeInstanceOf(WebApiCallRefusedLocallyError)
    expect(() => assertNoLeak(thrown)).toThrow()
    // Marked before the caller saw the rejection: status, listener and line.
    expect(h.manager.status(h.a.key)).toEqual({ state: 'broken', phase: 'running', outcome: webApiRefusal('chat.postMessage', code) })
    expect(brokenReportsOf(h, h.a)).toBe(1)
    expect(h.lines).toEqual([webApiRefusalLine(h, 'chat.postMessage', code)])
    expect(h.lines[0]).toContain('personas[0]')
    expect(h.lines[0]).toContain(`path=${JSON.stringify(h.a.credentials_file)}`)

    await h.clock.flush()
    // The manager's own close: disconnect() called once, the socket let go first.
    expect(a.sockets.map(socket => [socket.disconnectCalls, socket.connected])).toEqual([[1, false]])
    expect(h.slack.activityOf(h.a.key).filter(e => e.kind === 'socket').map(e => e.event).slice(-2)).toEqual(['discarded', 'disconnected'])
    await h.clock.advance(HOUR_MS)
    expect(startsOf(h, h.a)).toBe(1)
    expect(h.clock.pendingCount()).toBe(0)
    expect(h.lines.map(classOf)).toEqual([PERSONA_CREDENTIALS_REFUSED])
    expect(statesOf(h, h.a)).toEqual(['connecting', 'up', 'broken'])

    // A later call on the captured client is refused locally and never reaches the stub.
    const calls = a.callLog.length
    const local = await rejectionOf(web.reactions.add({ channel: WATCH_CHANNEL, timestamp: '1700000000.000100', name: 'eyes' }))
    expect(local).toBeInstanceOf(WebApiCallRefusedLocallyError)
    expect(local).toMatchObject({ code: WEB_API_CALL_REFUSED_LOCALLY, data: { ok: false, error: code }, method: 'reactions.add' })
    expect(a.callLog).toHaveLength(calls)
    expect(brokenReportsOf(h, h.a)).toBe(1)
    expect(h.lines).toHaveLength(1)

    expect(h.manager.webClient(h.b.key)).toBe(webB!)
    await expectBUndisturbed(h)
    assertNoLeak({ status: h.manager.status(h.a.key), lines: h.lines, local })
  })

  test.each(WATCHED_CALLS)('the watch sees %s: its token_revoked marks A with the method named, and the next such call is refused locally', async (method, queue, call) => {
    const h = makeHarness()
    await bringUpBoth(h)
    const a = stubOf(h, h.a)
    const web = h.manager.webClient(h.a.key)!
    a.script[queue].push({ kind: 'platform', error: 'token_revoked' })
    const since = a.callLog.length

    const thrown = await rejectionOf(call(web))

    expect(thrown).toMatchObject({ data: { error: 'token_revoked' } })
    expect(a.callLog.slice(since).map((c): string => c.method)).toEqual([queue === 'apiCall' ? 'apiCall' : method])
    expect(h.manager.status(h.a.key)).toEqual({ state: 'broken', phase: 'running', outcome: webApiRefusal(method, 'token_revoked') })
    expect(h.lines).toEqual([webApiRefusalLine(h, method, 'token_revoked')])
    const local = await rejectionOf(call(web))
    expect(local).toMatchObject({ code: WEB_API_CALL_REFUSED_LOCALLY, method })
    expect(a.callLog).toHaveLength(since + 1)
    await expectBUndisturbed(h)
    assertNoLeak({ lines: h.lines, local })
  })

  test('two calls rejecting at once with auth errors log one line and report broken once; each caller gets its own rejection', async () => {
    const h = makeHarness()
    await bringUpBoth(h)
    const a = stubOf(h, h.a)
    const web = h.manager.webClient(h.a.key)!
    const first = makeDeferredWebApiCall()
    const second = makeDeferredWebApiCall()
    a.script.post.push(first.outcome, second.outcome)
    const calls = [
      rejectionOf(web.chat.postMessage({ channel: WATCH_CHANNEL, text: 'one' })),
      rejectionOf(web.chat.postMessage({ channel: WATCH_CHANNEL, text: 'two' })),
    ]
    await h.clock.flush()
    expect(a.calls.postMessage).toHaveLength(2)

    first.settle({ kind: 'platform', error: 'token_revoked' })
    second.settle({ kind: 'platform', error: 'invalid_auth' })
    const [one, two] = await Promise.all(calls)

    expect(one).toMatchObject({ code: 'slack_webapi_platform_error', data: { error: 'token_revoked' } })
    expect(two).toMatchObject({ code: 'slack_webapi_platform_error', data: { error: 'invalid_auth' } })
    expect(h.lines).toEqual([webApiRefusalLine(h, 'chat.postMessage', 'token_revoked')])
    expect(brokenReportsOf(h, h.a)).toBe(1)
    expect(h.manager.status(h.a.key)).toMatchObject({ state: 'broken', outcome: { slackError: 'token_revoked' } })
    await expectBUndisturbed(h)
  })

  // Rows: label, the scripted failure, and what the caller's rejection carries.
  test.each<[string, WebApiOutcome, Record<string, unknown>]>([
    ['missing_scope', { kind: 'platform', error: 'missing_scope' }, { code: 'slack_webapi_platform_error', data: { error: 'missing_scope' } }],
    ['channel_not_found', { kind: 'platform', error: 'channel_not_found' }, { code: 'slack_webapi_platform_error', data: { error: 'channel_not_found' } }],
    ['a network error', { kind: 'network' }, { code: 'slack_webapi_request_error' }],
    ['an HTTP 500', { kind: 'http', status: 500 }, { code: 'slack_webapi_http_error' }],
  ])('%s from a call on A’s client changes nothing: A stays up and delivering, nothing is logged, the caller gets the rejection and A’s next call reaches Slack', async (_label, failure, rejection) => {
    const h = makeHarness()
    await bringUpBoth(h)
    const a = stubOf(h, h.a)
    const web = h.manager.webClient(h.a.key)!
    const reported = h.statuses.length
    a.script.post.push(failure)

    const thrown = await rejectionOf(web.chat.postMessage({ channel: WATCH_CHANNEL, text: 'hello' }))
    await h.clock.flush()

    expect(thrown).toMatchObject(rejection)
    expect(thrown).not.toBeInstanceOf(WebApiCallRefusedLocallyError)
    expect(h.manager.status(h.a.key)).toEqual({ state: 'up', identity: initialIdentityOf(h, h.a) })
    expect(h.statuses).toHaveLength(reported)
    expect(h.lines).toEqual([])
    await web.chat.postMessage({ channel: WATCH_CHANNEL, text: 'again' })
    expect(a.calls.postMessage).toHaveLength(2)
    expect(a.socket.disconnectCalls).toBe(0)
    await expectDelivers(h, h.a)
    await expectBUndisturbed(h)
  })

  test('the mark happens while A’s serializer slot is held: A is broken and its detached socket delivers nothing at once; only the network close waits for A’s turn; B’s turn is free', async () => {
    const serializer = createPersonaSerializer()
    const h = makeHarness({ serialize: serializer.run })
    await bringUpBoth(h)
    const a = stubOf(h, h.a)
    const web = h.manager.webClient(h.a.key)!
    a.script.post.push({ kind: 'platform', error: 'token_revoked' })
    const turn = Promise.withResolvers<void>()
    let stateInside: string | undefined
    // A lifecycle operation holds A's turn, and the refused call is made from inside it.
    const held = serializer.run(h.a.key, async () => {
      await rejectionOf(web.chat.postMessage({ channel: WATCH_CHANNEL, text: 'inside the held turn' }))
      stateInside = h.manager.status(h.a.key)?.state
      await turn.promise
    })
    await h.clock.flush()

    expect(stateInside).toBe('broken')
    expect(h.lines).toEqual([webApiRefusalLine(h, 'chat.postMessage', 'token_revoked')])
    // The socket is still open on the network, but detached: A's next inbound event is not delivered.
    expect(a.socket.connected).toBe(true)
    expect(a.socket.disconnectCalls).toBe(0)
    const text = 'after the refusal'
    await a.socket.deliver(makeChannelMessage({ text }))
    expect(h.events.filter(e => e.payload.event?.text === text)).toEqual([])
    expect(await serializer.run(h.b.key, () => 'B ran')).toBe('B ran')
    await expectBUndisturbed(h)

    turn.resolve()
    await held
    await h.clock.flush()

    expect(a.socket.disconnectCalls).toBe(1)
    expect(a.socket.connected).toBe(false)
    await h.clock.advance(HOUR_MS)
    expect(startsOf(h, h.a)).toBe(1)
    expect(h.lines).toHaveLength(1)
    expect(h.clock.pendingCount()).toBe(0)
  })

  test('stopping A while the close of its detached socket waits for A’s turn closes it at once', async () => {
    const serializer = createPersonaSerializer()
    const h = makeHarness({ serialize: serializer.run })
    await bringUpBoth(h)
    const a = stubOf(h, h.a)
    a.script.post.push({ kind: 'platform', error: 'token_revoked' })
    const turn = Promise.withResolvers<void>()
    const held = serializer.run(h.a.key, () => turn.promise)
    await rejectionOf(h.manager.webClient(h.a.key)!.chat.postMessage({ channel: WATCH_CHANNEL, text: 'hello' }))
    expect(a.socket.connected).toBe(true)

    await h.manager.stop(h.a.key)

    expect(a.socket.connected).toBe(false)
    expect(a.socket.disconnectCalls).toBeGreaterThanOrEqual(1)
    turn.resolve()
    await held
    await h.clock.flush()
    expect(h.clock.pendingCount()).toBe(0)
    expect(startsOf(h, h.a)).toBe(1)
    await expectBUndisturbed(h)
  })

  test('a stale client after a credentials reconnect’s swap: an auth error from the old client changes nothing; the new client serves', async () => {
    const h = makeHarness()
    await bringUpBoth(h)
    const oldWeb = h.manager.webClient(h.a.key)!
    const rotated = rotateCredentials(h, h.a)
    expect(await h.manager.reconnectCredentials(h.a.key, rotated.tokens)).toEqual({ kind: 'swapped', identity: rotated.identity })
    const reported = h.statuses.length
    stubOf(h, h.a).script.post.push({ kind: 'platform', error: 'token_revoked' })

    const thrown = await rejectionOf(oldWeb.chat.postMessage({ channel: WATCH_CHANNEL, text: 'on the old client' }))
    await h.clock.flush()

    expect(thrown).toMatchObject({ data: { error: 'token_revoked' } })
    expect(h.manager.status(h.a.key)).toEqual({ state: 'up', identity: rotated.identity })
    expect(h.statuses).toHaveLength(reported)
    expect(h.lines).toEqual([])
    expect(rotated.stub.sockets.map(socket => [socket.connected, socket.disconnectCalls])).toEqual([[true, 0]])
    await h.manager.webClient(h.a.key)!.chat.postMessage({ channel: WATCH_CHANNEL, text: 'on the new client' })
    expect(rotated.stub.calls.postMessage).toHaveLength(1)
    await expectDelivers(h, h.a, rotated.stub)
    await expectBUndisturbed(h)
  })

  test('a stale client after stop(A): an auth error from its former client changes nothing and logs nothing', async () => {
    const h = makeHarness()
    await bringUpBoth(h)
    const former = h.manager.webClient(h.a.key)!
    await h.manager.stop(h.a.key)
    const reported = h.statuses.length
    stubOf(h, h.a).script.post.push({ kind: 'platform', error: 'invalid_auth' })

    const thrown = await rejectionOf(former.chat.postMessage({ channel: WATCH_CHANNEL, text: 'after the stop' }))
    await h.clock.flush()

    expect(thrown).toMatchObject({ data: { error: 'invalid_auth' } })
    expect(h.manager.status(h.a.key)).toBeUndefined()
    expect(h.statuses).toHaveLength(reported)
    expect(h.lines).toEqual([])
    expect(h.clock.pendingCount()).toBe(0)
    await expectBUndisturbed(h)
  })

  test('a reconnect left retrying when A is marked broken still completes: its swap brings A back up on the new client and socket', async () => {
    const h = makeHarness()
    await bringUpBoth(h)
    const oldWeb = h.manager.webClient(h.a.key)!
    const rotated = rotateCredentials(h, h.a, ROTATED, { authTest: [{ kind: 'network' }] })
    const { later, listener } = laterOutcomes()
    expect(await h.manager.reconnectCredentials(h.a.key, rotated.tokens, listener)).toMatchObject({ kind: 'retrying' })
    stubOf(h, h.a).script.post.push({ kind: 'platform', error: 'token_revoked' })
    await rejectionOf(oldWeb.chat.postMessage({ channel: WATCH_CHANNEL, text: 'revoked' }))
    expect(h.manager.status(h.a.key)).toMatchObject({ state: 'broken', phase: 'running' })
    expect(pendingDelays(h)).toEqual([5_000])

    await h.clock.advance(5_000)

    expect(later).toEqual([{ kind: 'swapped', identity: rotated.identity }])
    expect(h.manager.status(h.a.key)).toEqual({ state: 'up', identity: rotated.identity })
    expect(statesOf(h, h.a)).toEqual(['connecting', 'up', 'broken', 'up'])
    // The reconnect's unreachable episode and the refusal each open once and clear at the swap.
    expect(h.lines.map(classOf)).toEqual([
      PERSONA_SLACK_UNREACHABLE,
      PERSONA_CREDENTIALS_REFUSED,
      PERSONA_SLACK_UNREACHABLE,
      PERSONA_CREDENTIALS_REFUSED,
    ])
    expect(h.lines[1]).toBe(webApiRefusalLine(h, 'chat.postMessage', 'token_revoked'))
    expect(h.lines[3]).toContain(': cleared: ')
    await h.manager.webClient(h.a.key)!.chat.postMessage({ channel: WATCH_CHANNEL, text: 'on the new client' })
    expect(rotated.stub.calls.postMessage).toHaveLength(1)
    await expectDelivers(h, h.a, rotated.stub)
    expect(h.clock.pendingCount()).toBe(0)
    await expectBUndisturbed(h)
    assertNoLeak({ later })
  })

  test('a pending reconnect’s new socket forwards nothing for A while A is marked broken; after its swap A delivers again', async () => {
    const h = makeHarness()
    await bringUpBoth(h)
    const hello = makeDeferredConnect()
    const rotated = rotateCredentials(h, h.a, ROTATED, { connect: [hello.outcome] })
    const reconnect = h.manager.reconnectCredentials(h.a.key, rotated.tokens)
    await h.clock.flush()
    stubOf(h, h.a).script.post.push({ kind: 'platform', error: 'account_inactive' })
    await rejectionOf(h.manager.webClient(h.a.key)!.chat.postMessage({ channel: WATCH_CHANNEL, text: 'revoked' }))
    expect(h.manager.status(h.a.key)).toMatchObject({ state: 'broken', phase: 'running' })
    const newSocket = rotated.stub.socket
    const early = makeChannelMessage({ text: 'on the new socket before its swap' })
    const deliveries: Promise<void>[] = []
    // The new socket is open during its `connected` emit, before the swap; A is still broken then.
    newSocket.once('connected', () => void deliveries.push(newSocket.deliver(early)))

    hello.settle()
    expect(await reconnect).toEqual({ kind: 'swapped', identity: rotated.identity })
    await Promise.all(deliveries)

    expect(deliveries).toHaveLength(1)
    expect(h.events.filter(e => e.payload.event === early)).toEqual([])
    expect(h.manager.status(h.a.key)).toEqual({ state: 'up', identity: rotated.identity })
    await expectDelivers(h, h.a, rotated.stub)
    await expectBUndisturbed(h)
  })

  // Rows: label, A's reopen outcome, A's reported states before the refusal, and the closes of the reopen's socket.
  test.each<[string, SettledConnectOutcome, string[], number]>([
    ['waiting on its retry timer (connect: network)', { kind: 'network' }, ['connecting', 'up', 'lost', 'retrying'], 0],
    ['with its start() in flight (connect: never)', { kind: 'never' }, ['connecting', 'up', 'lost'], 1],
  ])('a reopen of A %s when a Web API call refuses A’s bot token is cancelled: A stays broken, no timer is left and no further start() is made however far the clock runs', async (_label, reopen, before, reopenCloses) => {
    const h = makeHarness()
    await bringUpBoth(h)
    const a = stubOf(h, h.a)
    const web = h.manager.webClient(h.a.key)!
    a.script.connect.push(reopen)
    a.socket.drop()
    await h.clock.flush()
    expect(statesOf(h, h.a)).toEqual(before)
    // The reopen's 5 s retry timer, or the 10 s bound on its start() in flight.
    expect(h.clock.pendingCount()).toBe(1)
    a.script.post.push({ kind: 'platform', error: 'token_revoked' })

    await rejectionOf(web.chat.postMessage({ channel: WATCH_CHANNEL, text: 'while reopening' }))
    await h.clock.flush()

    const broken: PersonaConnectionStatus = { state: 'broken', phase: 'running', outcome: webApiRefusal('chat.postMessage', 'token_revoked') }
    expect(h.manager.status(h.a.key)).toEqual(broken)
    expect(h.clock.pendingCount()).toBe(0)
    await h.clock.advance(HOUR_MS)
    expect(h.manager.status(h.a.key)).toEqual(broken)
    expect(statesOf(h, h.a)).toEqual([...before, 'broken'])
    expect(startsOf(h, h.a)).toBe(2)
    expect(a.sockets.map(socket => [socket.disconnectCalls, socket.connected])).toEqual([[0, false], [reopenCloses, false]])
    expect(h.lines).toEqual([h.lines[0], webApiRefusalLine(h, 'chat.postMessage', 'token_revoked')])
    expect(classOf(h.lines[0])).toBe(PERSONA_CONNECTION_LOST)
    await expectBUndisturbed(h)
  })

  test('A already broken by a refused reopen: an auth error from its client reports nothing more, logs no second line and leaves the reopen’s refusal as A’s status', async () => {
    const h = makeHarness()
    await bringUpBoth(h)
    const a = stubOf(h, h.a)
    a.script.connect.push({ kind: 'platform', error: 'invalid_auth' })
    a.socket.drop()
    await h.clock.flush()
    const refusedReopen = h.manager.status(h.a.key)
    expect(refusedReopen).toMatchObject({ state: 'broken', phase: 'reopen', outcome: { check: 'socket-mode', slackError: 'invalid_auth' } })
    const lines = [...h.lines]
    const reported = h.statuses.length
    const web = h.manager.webClient(h.a.key)
    expect(web).toBeDefined()
    a.script.post.push({ kind: 'platform', error: 'token_revoked' })

    const thrown = await rejectionOf(web!.chat.postMessage({ channel: WATCH_CHANNEL, text: 'after the refused reopen' }))
    await h.clock.flush()

    expect(thrown).toMatchObject({ code: 'slack_webapi_platform_error', data: { error: 'token_revoked' } })
    expect(h.manager.status(h.a.key)).toEqual(refusedReopen!)
    expect(h.statuses).toHaveLength(reported)
    expect(brokenReportsOf(h, h.a)).toBe(1)
    expect(h.lines).toEqual(lines)
    expect(h.clock.pendingCount()).toBe(0)
    await expectBUndisturbed(h)
  })

  test('the client a credentials reconnect installs is watched: token_revoked from a call on it marks A broken at once with one line, and its next call is refused locally', async () => {
    const h = makeHarness()
    await bringUpBoth(h)
    const rotated = rotateCredentials(h, h.a)
    expect(await h.manager.reconnectCredentials(h.a.key, rotated.tokens)).toEqual({ kind: 'swapped', identity: rotated.identity })
    const web = h.manager.webClient(h.a.key)!
    rotated.stub.script.post.push({ kind: 'platform', error: 'token_revoked' })
    const since = rotated.stub.callLog.length

    const thrown = await rejectionOf(web.chat.postMessage({ channel: WATCH_CHANNEL, text: 'on the rotated client' }))
    await h.clock.flush()

    expect(thrown).toMatchObject({ code: 'slack_webapi_platform_error', data: { error: 'token_revoked' } })
    expect(h.manager.status(h.a.key)).toEqual({ state: 'broken', phase: 'running', outcome: webApiRefusal('chat.postMessage', 'token_revoked') })
    expect(brokenReportsOf(h, h.a)).toBe(1)
    expect(h.lines).toEqual([webApiRefusalLine(h, 'chat.postMessage', 'token_revoked')])
    expect(rotated.stub.sockets.map(socket => [socket.disconnectCalls, socket.connected])).toEqual([[1, false]])
    const local = await rejectionOf(web.chat.postMessage({ channel: WATCH_CHANNEL, text: 'again' }))
    expect(local).toBeInstanceOf(WebApiCallRefusedLocallyError)
    expect(rotated.stub.callLog).toHaveLength(since + 1)
    await h.clock.advance(HOUR_MS)
    expect(h.clock.pendingCount()).toBe(0)
    expect(stubStarts(rotated.stub)).toBe(1)
    expect(stubStarts(stubOf(h, h.a))).toBe(1)
    await expectBUndisturbed(h)
    assertNoLeak({ local })
  })

  // `apiCall` and `filesUploadV2` are prototype methods on the real WebClient and need the client as
  // `this`; the stub's do too, so these rows fail if the watch calls them detached.
  test.each(WATCHED_CALLS.filter(([, queue]) => queue === 'upload' || queue === 'apiCall'))('%s through A’s watched client, called with the client as this, reaches Slack once and resolves with Slack’s answer; A stays up', async (method, queue, call) => {
    const h = makeHarness()
    await bringUpBoth(h)
    const a = stubOf(h, h.a)
    const since = a.callLog.length

    const result = await call(h.manager.webClient(h.a.key)!)

    expect(result).toMatchObject({ ok: true })
    expect(a.callLog.slice(since).map((c): string => c.method)).toEqual([queue === 'apiCall' ? 'apiCall' : method])
    expect(h.manager.status(h.a.key)).toEqual({ state: 'up', identity: initialIdentityOf(h, h.a) })
    expect(h.lines).toEqual([])
    await expectBUndisturbed(h)
  })

  test('an apiCall whose method name carries a token: A is marked broken with no method named, and neither the line, the status nor the local refusal of the next such call carries it', async () => {
    const h = makeHarness()
    await bringUpBoth(h)
    const a = stubOf(h, h.a)
    const web = h.manager.webClient(h.a.key)!
    const method = `conversations.${fakeToken(BOT_TOKEN_PREFIX, 'method')}`
    a.script.apiCall.push({ kind: 'platform', error: 'token_revoked' })

    await rejectionOf(web.apiCall(method, { channel: WATCH_CHANNEL }))
    const local = await rejectionOf(web.apiCall(method, { channel: WATCH_CHANNEL }))

    const status = h.manager.status(h.a.key)
    expect(status).toEqual({
      state: 'broken',
      phase: 'running',
      outcome: {
        kind: 'credentials-refused',
        class: PERSONA_CREDENTIALS_REFUSED,
        check: 'web-api',
        key: 'bot_token',
        slackError: 'token_revoked',
        cause: 'bot_token refused by a Web API call: Slack error token_revoked',
      },
    })
    expect(h.lines).toHaveLength(1)
    expect(classOf(h.lines[0])).toBe(PERSONA_CREDENTIALS_REFUSED)
    expect(local).toBeInstanceOf(WebApiCallRefusedLocallyError)
    expect(local).toMatchObject({ code: WEB_API_CALL_REFUSED_LOCALLY, method: undefined, data: { ok: false, error: 'token_revoked' } })
    expect(a.calls.apiCall).toHaveLength(1)
    assertNoLeak({ line: h.lines[0], status, local }, 'token-bearing method name')
    await expectBUndisturbed(h)
  })

  test('dry run: there is no Web API client to watch and nothing is built', async () => {
    const h = makeHarness({ dryRun: true })

    for (const p of [h.a, h.b]) expect(await h.manager.bringUp(p)).toMatchObject({ state: 'up' })

    expect(h.manager.webClient(h.a.key)).toBeUndefined()
    expect(h.manager.webClient(h.b.key)).toBeUndefined()
    expect(h.slack.builds).toEqual([])
    expect(h.lines).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// Bring-up outcomes, the start pass and per-persona retry timers (E5 Task 1:
// b.av2 SR-6.1 outcomes, SR-6.4, SR-7.2 part, SR-10.3 part; AC 23, 24, 66)
//
// The real bring-up controller over the real connection manager
// (`makeConnectionHarness` with `files: true`: stub Slack factory, fake
// clock, each persona's credentials file and working directory), wired as
// server.ts wires it: the manager's status listener is the up-flush listener
// composed with the controller's. The start-pass cases run the real
// `startupSessionManager` with the controller as its `bringUp`, launching
// through the real `spawnForPersona` against the agent-director stub. The
// retry cases drive the controller directly with a recording launch.
// ---------------------------------------------------------------------------

const OUTCOME_A = 'Alpha Desk'
const OUTCOME_B = 'Beta Ops'
const OUTCOME_C = 'Gamma Watch'

/** One persona bring-up fixture; see makeBringUpFixture. */
interface BringUpFixture {
  h: ConnectionHarness
  personas: readonly Persona[]
  controller: PersonaBringUpController
  notifier: PersonaNotifier
  /** The per-persona lifecycle serializer the controller's retries run through (its `serialize`, as server.ts wires it). */
  serializer: PersonaSerializer
  /** Keys the controller launched after a retry, in order. */
  launches: string[]
  /** Events the manager forwarded: the receiving key and the message text. */
  events: { key: string; text: unknown }[]
  /** Credentials paths opened by the controller's checks, in order. */
  credentialOpens: string[]
  /** [path, fake-clock time] of every working-directory stat the controller's checks made. */
  directoryStats: [string, number][]
  /** Overrides consulted at call time by the controller's file-system seam. */
  fsOverride: Partial<PersonaBringUpFs>
  /**
   * Replace the applied persona set the controller reads live (`appliedPersonas`,
   * as server.ts binds it to `personaConfig`); it starts as `personas`.
   */
  setApplied(personas: readonly Persona[]): void
  /** Everything the fixture captured, for assertNoLeak. */
  captured(extra?: Record<string, unknown>): Record<string, unknown>
}

/** Fixtures built in the running test: cancelled, stopped and leak-checked after it. */
const bringUpFixtures: BringUpFixture[] = []

/** Options of makeBringUpFixture. */
interface BringUpFixtureOptions {
  /** Persona names, in config order; default A and B. */
  names?: string[]
  /** Further fields of a persona's spec, by name (e.g. a shared `working_directory`). */
  specs?: Record<string, Omit<PersonaSpec, 'name'>>
  dryRun?: boolean
  /** A persona's stub script, by name. */
  slack?: Record<string, StubSlackOptions>
  /** Launch through the real `spawnForPersona` (as server.ts's launch does). */
  spawn?: boolean
  /** Replaces what the controller's launch returns (after the key is recorded). */
  launch?: (persona: Persona) => Promise<unknown>
  /** Runs once the manager's `bringUp` for a persona resolved, before the controller sees the result. */
  afterSlackBringUp?: (persona: Persona) => void
  /**
   * Wire the controller's `onLeftUp` as server.ts does: `createNotUpSessionDropper` over the
   * real `dropPersonaSession`, logging to `h.lines`.
   */
  dropSessions?: boolean
  /** The controller's `onLeftUp` itself (instead of `dropSessions`). */
  onLeftUp?: PersonaBringUpControllerDeps['onLeftUp']
}

/**
 * Personas `names` (A and B by default) on the connection harness with their
 * files, and the real controller over the harness's manager and fake clock.
 * The controller's launch records the key, and then runs `launch`, or with
 * `spawn` the real `spawnForPersona`. `slack` scripts a persona's stub by name.
 */
function makeBringUpFixture(opts: BringUpFixtureOptions = {}): BringUpFixture {
  const dryRun = opts.dryRun ?? false
  const names = opts.names ?? [OUTCOME_A, OUTCOME_B]
  const h = makeConnectionHarness(names.map(name => ({ ...opts.specs?.[name], name })), dir, { files: true, dryRun, stubOptions: opts.slack })
  let applied: readonly Persona[] = h.personas
  const launches: string[] = []
  const events: { key: string; text: unknown }[] = []
  const credentialOpens: string[] = []
  const directoryStats: [string, number][] = []
  const fsOverride: Partial<PersonaBringUpFs> = {}
  const notifierLines: string[] = []
  const serializer = createPersonaSerializer()
  const notifier = createPersonaNotifier({
    getPersona: key => h.getPersona(key),
    clientFor: key => h.clientFor(key),
    isDryRun: () => dryRun,
    log: line => void notifierLines.push(line),
  })
  const controller = createPersonaBringUpController({
    connections: {
      bringUp: async (persona, tokens) => {
        const status = await h.connections.bringUp(persona, tokens)
        opts.afterSlackBringUp?.(persona as Persona)
        return status
      },
      status: key => h.manager.status(key),
    },
    clock: h.clock,
    dryRun,
    log: line => void h.lines.push(line),
    appliedPersonas: () => applied,
    serialize: serializer.run,
    fs: {
      openFile: path => {
        credentialOpens.push(path)
        return (fsOverride.openFile ?? DEFAULT_CREDENTIALS_FS.openFile)(path)
      },
      stat: path => {
        directoryStats.push([path, h.clock.now()])
        return (fsOverride.stat ?? DEFAULT_WORKING_DIRECTORY_FS.stat)(path)
      },
    },
    launch: async persona => {
      launches.push(persona.key)
      if (opts.launch) return opts.launch(persona)
      return opts.spawn ? spawnForPersona(persona, h.config!, false) : undefined
    },
    ...(opts.dropSessions
      ? { onLeftUp: createNotUpSessionDropper({ drop: dropPersonaSession, log: line => void h.lines.push(line) }) }
      : { onLeftUp: opts.onLeftUp }),
  })
  h.onStatus = composePersonaStatusListeners(
    createPersonaUpFlushListener(notifier),
    (key, status) => controller.onConnectionStatus(key, status),
  )
  h.onEvent = async (key, _eventName, payload) => {
    await payload.ack()
    events.push({ key, text: payload.event?.text })
  }
  const f: BringUpFixture = {
    h,
    personas: h.personas,
    controller,
    notifier,
    serializer,
    launches,
    events,
    credentialOpens,
    directoryStats,
    fsOverride,
    setApplied: personas => {
      applied = personas
    },
    captured: (extra = {}) => ({ lines: h.lines, statuses: h.statuses, notifierLines, events, launches, ...extra }),
  }
  bringUpFixtures.push(f)
  return f
}

/** Bring every persona up through the controller, in config order; the summaries by key. */
async function bringUpEach(f: BringUpFixture): Promise<Map<string, PersonaBringUpResultSummary>> {
  const out = new Map<string, PersonaBringUpResultSummary>()
  for (const persona of f.personas) out.set(persona.key, await f.controller.bringUp(persona, f.personas))
  return out
}

let serveSeq = 0

/** Deliver a uniquely-texted message on the persona's socket: it must reach the event handler once, tagged with that persona. */
async function expectServes(f: BringUpFixture, persona: Persona): Promise<void> {
  const text = `served ${++serveSeq} on ${persona.key}`
  await f.h.stub(persona).socket.deliver(makeChannelMessage({ text }))
  expect(f.events.filter(e => e.text === text).map(e => e.key)).toEqual([persona.key])
}

/** Every non-empty Slack call list other than auth.test, as `<key>.<call>`, over every persona's stub. */
function slackCallsBesidesAuthTest(f: BringUpFixture): string[] {
  return f.personas.flatMap(persona =>
    Object.entries(f.h.stub(persona).calls)
      .filter(([call, list]) => call !== 'authTest' && (list as unknown[]).length > 0)
      .map(([call]) => `${persona.key}.${call}`),
  )
}

/** The persona's reported connection states, in order. */
function connectionStatesOf(f: BringUpFixture, persona: Persona): string[] {
  return f.h.statuses.filter(([key]) => key === persona.key).map(([, status]) => status.state)
}

/** The lines naming the persona (its rendered name and key), in order. */
function linesOf(f: BringUpFixture, persona: Persona): string[] {
  return f.h.lines.filter(line => line.includes(renderPersonaRef(persona.name, persona.key)))
}

/** Rewrite the persona's credentials file with other fake tokens (a pending change) and return them. */
function editCredentials(persona: Persona): PersonaSlackTokens {
  const edited = new PersonaSlackTokens(fakeToken(BOT_TOKEN_PREFIX, 'edited-bot'), fakeToken(APP_TOKEN_PREFIX, 'edited-app'))
  writeCredentialsFile(dir, relative(dir, persona.credentials_file), { bot_token: edited.botToken, app_token: edited.appToken })
  return edited
}

/** Poll `cond` in real time (1 ms steps) for at most `ms`; for the real spawn path. The caller asserts afterwards. */
async function waitForReal(cond: () => boolean, ms = 2_000): Promise<void> {
  for (let waited = 0; !cond() && waited < ms; waited++) await new Promise(resolve => setTimeout(resolve, 1))
}

/** Break a working directory: `missing` removes it; `unusable` puts a regular file at its path. */
function breakDirectory(path: string, how: 'missing' | 'unusable'): void {
  rmSync(path, { recursive: true, force: true })
  if (how === 'unusable') writeFileSync(path, '')
}

/** Make the path a usable directory again. */
function repairDirectory(path: string): void {
  rmSync(path, { recursive: true, force: true })
  mkdirSync(path)
}

describe('bring-up outcomes (E5)', () => {
  const originalError = console.error
  let consoleLines: string[]
  let savedStateDir: string | undefined
  /** Every session-manager notice raised (cap, spawn failure, …), before routing. */
  let sessionNotices: { key: string; text: string }[]
  /** Every outage-state onset or all-clear raised. */
  let outageNotices: { key: string; text: string }[]
  /** The launch path's agent-director stub and every call it received. */
  let ad: StubSpawnPath

  const spawnedIds = () => ad.spawnedIds()
  const startupErrorsLog = () => join(dir, 'state', 'startup-errors.log')

  beforeEach(() => {
    savedStateDir = process.env['SLACK_STATE_DIR']
    // Any startup-errors.log write lands in this test's own directory.
    process.env['SLACK_STATE_DIR'] = join(dir, 'state')
    consoleLines = []
    console.error = (...args: unknown[]) => void consoleLines.push(args.map(String).join(' '))
    ad = installStubSpawnPath(join(dir, 'home'))
    _resetBackoffState()
    _resetRegistry()
    sessionNotices = []
    outageNotices = []
    // Recorded, and routed through the running test's notifier so any post would reach a stub.
    setSessionNotifier((key, text, options) => {
      sessionNotices.push({ key, text })
      return bringUpFixtures.at(-1)?.notifier.notify(key, text, options)
    })
    initOutageState({
      getClient,
      notify: (key, text) => {
        outageNotices.push({ key, text })
        void bringUpFixtures.at(-1)?.notifier.notify(key, text)
      },
    })
  })

  afterEach(async () => {
    for (const f of bringUpFixtures.splice(0)) {
      // Teardown hygiene: every retry timer is cancelled, so none leaks into a later test.
      f.controller.cancelAll()
      await f.h.manager.stopAll()
      expect(f.h.clock.pendingCount()).toBe(0)
      assertNoLeak(f.captured({ consoleLines, sessionNotices, outageNotices }), 'bring-up fixture')
    }
    console.error = originalError
    resetStubSpawnPath()
    setSessionNotifier(undefined)
    _resetOutageState()
    _resetBackoffState()
    _resetRegistry()
    if (savedStateDir === undefined) delete process.env['SLACK_STATE_DIR']
    else process.env['SLACK_STATE_DIR'] = savedStateDir
  })

  test('SR-13.1: creating a controller reads no file, schedules no timer, logs nothing and brings nothing up until bringUp', () => {
    const f = makeBringUpFixture()
    const [a] = f.personas as [Persona, Persona]

    expect(f.credentialOpens).toEqual([])
    expect(f.directoryStats).toEqual([])
    expect(f.h.clock.pendingCount()).toBe(0)
    expect(f.h.lines).toEqual([])
    expect(f.h.bringUpCalls).toEqual([])
    expect(f.h.slack.builds).toEqual([])
    expect(f.controller.state(a.key)).toBeUndefined()
    expect(f.controller.isUp(a.key)).toBe(false)
  })

  // -------------------------------------------------------------------------
  // The start pass (AC 23, AC 24)
  // -------------------------------------------------------------------------

  /** Push `outcome` enough times that every retry in the test's hour of fake time fails too. */
  const always = <T>(queue: T[], outcome: T) => { for (let i = 0; i < 60; i++) queue.push(outcome) }
  const credentialsPath = (p: Persona) => p.credentials_file
  const directoryPath = (p: Persona) => p.working_directory

  // One not-up cause per row, shared by the start-pass table and the surviving-instance table.
  // Rows: label, A's outcome, A's class, the path its line names, the arrangement, when the
  // manager abandons A's first attempt (0: it ends at once), and whether A may get a Slack client.
  const NOT_UP_CAUSES: [string, 'broken' | 'retrying', string, (p: Persona) => string, (f: BringUpFixture, a: Persona) => void, number, boolean][] = [
    ['credentials missing', 'broken', PERSONA_CREDENTIALS_MISSING, credentialsPath, (_f, a) => rmSync(a.credentials_file), 0, false],
    [
      'credentials unreadable',
      'broken',
      PERSONA_CREDENTIALS_UNREADABLE,
      credentialsPath,
      (f, a) => {
        f.fsOverride.openFile = path => (path === a.credentials_file ? failsWith('EACCES')() : DEFAULT_CREDENTIALS_FS.openFile(path))
      },
      0,
      false,
    ],
    [
      'credentials locally invalid (a bot token with the wrong prefix)',
      'broken',
      PERSONA_CREDENTIALS_INVALID,
      credentialsPath,
      (_f, a) => void writeCredentialsFile(dir, relative(dir, a.credentials_file), { bot_token: fakeToken('xoxz-') }),
      0,
      false,
    ],
    [
      'credentials refused by Slack (invalid_auth)',
      'broken',
      PERSONA_CREDENTIALS_REFUSED,
      credentialsPath,
      (f, a) => void f.h.stub(a).script.authTest.push({ kind: 'platform', error: 'invalid_auth' }),
      0,
      true,
    ],
    ['working directory missing', 'retrying', PERSONA_DIRECTORY_MISSING, directoryPath, (_f, a) => breakDirectory(a.working_directory, 'missing'), 0, false],
    ['working directory unusable (a regular file)', 'retrying', PERSONA_DIRECTORY_UNUSABLE, directoryPath, (_f, a) => breakDirectory(a.working_directory, 'unusable'), 0, false],
    ['Slack unreachable at auth.test', 'retrying', PERSONA_SLACK_UNREACHABLE, credentialsPath, (f, a) => always(f.h.stub(a).script.authTest, { kind: 'network' }), 0, true],
    ['auth.test never answers (abandoned at the manager’s 10 s bound)', 'retrying', PERSONA_SLACK_UNREACHABLE, credentialsPath, (f, a) => always<WebApiOutcome>(f.h.stub(a).script.authTest, { kind: 'never' }), 10_000, true],
    // The manager-level rows whose apps.connections.open answers at once: Slack-unreachable, never broken.
    ...UNREACHABLE_CONNECT_LEGS.filter(([, , openAnswersAfterMs]) => openAnswersAfterMs === 0).map(
      ([label, connect, , abandonAtMs]): [string, 'retrying', string, (p: Persona) => string, (f: BringUpFixture, a: Persona) => void, number, boolean] => [
        label,
        'retrying',
        PERSONA_SLACK_UNREACHABLE,
        credentialsPath,
        (f, a) => always<ConnectOutcome>(f.h.stub(a).script.connect, connect),
        abandonAtMs,
        true,
      ],
    ),
  ]

  // -------------------------------------------------------------------------
  // A not-up persona's surviving instance (AC 23, AC 24; b.av2 SR-6.3, SR-6.4)
  //
  // The agent-director stub holds rows (`holdRows`), the start sweep and the start pass run as
  // server.ts runs them, and each MCP registration goes through the real `decideSessionAdmission`
  // with the production up check (`createPersonaUpPredicate` over the manager and the controller).
  // `connectSession` stands in for server.ts's initialized handler, which cannot be imported: it
  // promotes an admitted session, and disconnects a refused one through the real
  // `closePendingSession`, as that handler does.
  // -------------------------------------------------------------------------

  /** A row of a persona absent from the config: the sweep's control, which it must remove. */
  const ORPHAN_ID = 'cscb_gone'
  /** The rows the agent-director stub holds, by instance ID (see holdRows). */
  let rows: Map<string, { list: ReturnType<typeof cannedListRow>; get: ReturnType<typeof cannedGetResult> }>
  let sessionSeq = 0

  const idOf = (persona: Persona) => `cscb_${persona.key}`
  const spawnHome = () => join(dir, 'home')

  /**
   * Make the test's agent-director stub hold `rows` (emptied here): a spawn of an instance that has
   * a row collides, `get` returns the row, `list` lists every row and `delete` removes one. Every
   * call is still recorded in `ad.calls`.
   */
  function holdRows(): void {
    rows = new Map()
    const { client } = ad
    const spawn = client.spawn.bind(client)
    const get = client.get.bind(client)
    const list = client.list.bind(client)
    const del = client.delete.bind(client)
    client.spawn = async params => {
      const result = await spawn(params)
      if (rows.has(String(params.claude_instance_id))) throw errInstanceIdCollision()
      return result
    }
    client.get = async params => {
      await get(params)
      const row = rows.get(params.claude_instance_id)
      if (!row) throw errSpawnNotFound()
      return row.get
    }
    client.list = async params => {
      await list(params)
      return { spawns: [...rows.values()].map(row => row.list) }
    }
    client.delete = async params => {
      const result = await del(params)
      for (const id of params.claude_instance_id) rows.delete(id)
      return result
    }
  }

  /** Give `persona` a surviving row, as its spawn wrote it unless `cwd` says otherwise, and add the orphan. */
  function addSurvivingRow(persona: Persona, state: 'waiting' | 'ended', cwd = persona.working_directory): void {
    rows.set(idOf(persona), {
      list: cannedListRow({ state, cwd }, persona, spawnHome()),
      get: cannedGetResult({ state, cwd }, persona, spawnHome()),
    })
    rows.set(ORPHAN_ID, { list: cannedListRow({ claude_instance_id: ORPHAN_ID }), get: cannedGetResult({ claude_instance_id: ORPHAN_ID }) })
  }

  /** The agent-director calls addressing instance `id`, counted by verb; verbs with none are left out. */
  function adCallsFor(id: string): Record<string, number> {
    const out: Record<string, number> = {}
    for (const [verb, calls] of Object.entries(ad.calls)) {
      const n = (calls as { claude_instance_id?: unknown }[]).filter(call => [call.claude_instance_id].flat().includes(id)).length
      if (n > 0) out[verb.replace(/Calls$/, '')] = n
    }
    return out
  }

  /** The sweep's lines deferring a persona's `cwd` check. */
  const deferredLines = () => consoleLines.filter(line => line.includes('the cwd check is deferred to its launch'))

  /** Run the start sweep, then the start pass, as server.ts does. */
  async function sweepAndStart(f: BringUpFixture): Promise<StartupSessionManagerResult> {
    await reconcileOrphans(f.h.config!)
    return startupSessionManager(f.h.config!, { bringUp: f.controller })
  }

  /**
   * A transport that counts its closes. Closing one runs `unregisterByMcpSessionId`, as server.ts's
   * `onsessionclosed` and SSE abort do, and records the persona key it found: server.ts restarts
   * that persona, so an undefined entry means nothing would be restarted. `steps` records, in
   * order, the pending-entry removal and keep-alive stop `closePendingSession` asked for, and each close.
   */
  interface FakeTransport {
    sessionId: string
    closes: number
    unregisteredOnClose: (string | undefined)[]
    steps: string[]
    handleRequest(): void
    close(): Promise<void>
  }

  /** One MCP session from `rootsPath`: its admission, its transport and, when admitted, its registered entry. */
  interface FakeSession {
    admission: SessionAdmission
    transport: FakeTransport
    entry: SessionEntry | undefined
  }

  /**
   * Connect an MCP session whose roots working directory is `rootsPath` and admit or refuse it, as
   * server.ts's initialized handler does: an admitted one is promoted and mapped; a refused one goes
   * through the real `closePendingSession`, with the real pending-entry removal and a recording keep-alive stop.
   */
  async function connectSession(f: BringUpFixture, rootsPath: string): Promise<FakeSession> {
    const id = `mcp-session-${++sessionSeq}`
    const transport: FakeTransport = {
      sessionId: id,
      closes: 0,
      unregisteredOnClose: [],
      steps: [],
      handleRequest: () => {},
      close: async () => {
        transport.closes++
        transport.steps.push('close')
        transport.unregisteredOnClose.push(unregisterByMcpSessionId(id))
      },
    }
    createPendingSession(id, transport as never, {} as never)
    const admission = decideSessionAdmission(rootsPath, f.h.config!.personas, {
      isPersonaUp: createPersonaUpPredicate(f.h.manager, f.controller),
      describeNotUp: key => describePersonaNotUp(f.controller.state(key)),
      log: line => void f.h.lines.push(line),
    })
    if (admission.kind === 'admitted') {
      registerSession(resolveRealPath(rootsPath), admission.persona.key, id)
      registerMcpSessionId(id, admission.persona.key)
      return { admission, transport, entry: getSessionByPersona(admission.persona.key) }
    }
    await closePendingSession(id, transport, {
      removePending: pendingId => {
        transport.steps.push(`removePending ${pendingId}`)
        removePendingSession(pendingId)
      },
      stopKeepAlive: stopped => void transport.steps.push(stopped === transport ? 'stopKeepAlive' : 'stopKeepAlive (another transport)'),
    })
    return { admission, transport, entry: undefined }
  }

  /** What disconnecting a refused session did to its transport, in order. */
  const refusedSteps = (session: FakeSession) => [`removePending ${session.transport.sessionId}`, 'stopKeepAlive', 'close']

  /** The session an HTTP request carrying MCP session ID `id` is routed to, if any. */
  const routedTo = (session: FakeSession) =>
    resolveTransportForRequest(new Request('http://127.0.0.1/mcp', { headers: { 'mcp-session-id': session.transport.sessionId } }))

  /** The session-refused lines naming `persona`. */
  const refusalsOf = (f: BringUpFixture, persona: Persona) => linesOf(f, persona).filter(line => line.startsWith('[slack] Session refused: '))

  describe('the start pass: one broken persona per cause beside a healthy one (AC 23, AC 24)', () => {
    test.each(NOT_UP_CAUSES)('AC 23, AC 24: %s — A ends %s and keeps its surviving agent-director row through the sweep, the pass and its retries; B is up, launched and serving; A is not launched; A’s instance’s MCP registration is refused while B’s is admitted; nothing is posted, now or after later retries', async (_label, outcome, cls, pathOf, arrange, abandonAtMs, slackBuilt) => {
      holdRows()
      const f = makeBringUpFixture({ spawn: true })
      const [a, b] = f.personas as [Persona, Persona]
      arrange(f, a)
      addSurvivingRow(a, 'waiting')
      // A notice raised for A before the pass is held; it must never be posted.
      await f.notifier.notify(a.key, 'held notice for A')

      // The start sweep removes its control row and nothing of A's; A's cwd check is deferred
      // only when its working directory has no real path.
      await reconcileOrphans(f.h.config!)
      expect(adCallsFor(ORPHAN_ID)).toEqual({ kill: 1, delete: 1 })
      expect([...rows.keys()]).toEqual([idOf(a)])
      expect(deferredLines()).toEqual(existsSync(a.working_directory) ? [] : [expect.stringContaining(renderPersonaRef(a.name, a.key))])

      let result: StartupSessionManagerResult | undefined
      const pass = startupSessionManager(f.h.config!, { bringUp: f.controller }).then(r => (result = r))

      // B's launch does not wait for A: recorded before the fake clock has moved.
      await waitForReal(() => spawnedIds().length > 0)
      expect(spawnedIds()).toEqual([`cscb_${b.key}`])
      expect(f.h.clock.now()).toBe(0)
      if (abandonAtMs > 0) {
        await f.h.clock.advanceTo(abandonAtMs - 1)
        // A's first attempt is still in flight, so the pass has not returned.
        expect(f.controller.state(a.key)?.outcome).toBeUndefined()
        expect(result).toBeUndefined()
        await f.h.clock.advance(1)
      }
      await pass

      expect(result!.perPersona.find(p => p.key === a.key)).toEqual({
        key: a.key,
        action: 'not-brought-up',
        outcome,
        failures: [expect.objectContaining({ class: cls })],
      })
      expect(result!.perPersona.find(p => p.key === b.key)).toEqual({ key: b.key, action: 'spawned' })
      expect([result!.notBroughtUp, result!.failed, result!.succeeded]).toEqual([1, 0, 1])
      expect(f.controller.state(a.key)?.outcome).toBe(outcome)
      expect(f.controller.state(b.key)).toEqual({ outcome: 'up', causes: {} })
      await expectServes(f, b)
      if (!slackBuilt) expect(f.h.slack.buildsOf(a.key)).toEqual([])

      // A's surviving instance registers and is refused (the pending entry removed, the keep-alive
      // stopped, the transport closed; never promoted or routed); B's is admitted.
      const fromA = await connectSession(f, a.working_directory)
      const fromB = await connectSession(f, b.working_directory)
      expect(fromA.admission).toEqual({ kind: 'not-up', persona: a })
      expect(fromA.transport.steps).toEqual(refusedSteps(fromA))
      expect(getSessionByPersona(a.key)).toBeUndefined()
      expect(routedTo(fromA)).toBeUndefined()
      expect(fromB.admission).toEqual({ kind: 'admitted', persona: b })
      expect(fromB.entry).toMatchObject({ personaKey: b.key, connected: true, transport: fromB.transport })
      expect(routedTo(fromB)).toBe(fromB.entry!)
      expect(fromB.transport.steps).toEqual([])
      const refusals = refusalsOf(f, a)
      expect(refusals).toHaveLength(1)
      expect(refusals[0]).toContain(`is not up (${outcome}: `)
      expect(refusalsOf(f, b)).toEqual([])

      // Well past A's later retries: still not up, never launched, nothing posted; its row is
      // still there, untouched, and its instance is still refused.
      await f.h.clock.advance(HOUR_MS)
      expect(f.controller.state(a.key)?.outcome).toBe(outcome)
      expect(spawnedIds()).toEqual([`cscb_${b.key}`])
      expect(f.launches).toEqual([])
      if (!slackBuilt) expect(f.h.slack.buildsOf(a.key)).toEqual([])
      const later = await connectSession(f, a.working_directory)
      expect(later.admission.kind).toBe('not-up')
      expect(getSessionByPersona(a.key)).toBeUndefined()
      expect(getSessionByPersona(b.key)).toBe(fromB.entry!)
      expect(adCallsFor(idOf(a))).toEqual({})
      expect([...rows.keys()]).toEqual([idOf(a)])
      await expectServes(f, b)
      expect(slackCallsBesidesAuthTest(f)).toEqual([])
      expect(sessionNotices).toEqual([])
      expect(outageNotices).toEqual([])

      // One line of A's class, naming A, its entry and the path; server log only.
      const classLines = linesOf(f, a).filter(line => line.includes(`${cls}:`))
      expect(classLines).toHaveLength(1)
      expect(classLines[0]).toContain('personas[0]')
      expect(classLines[0]).toContain(JSON.stringify(pathOf(a)))
      expect(existsSync(startupErrorsLog())).toBe(false)
      assertNoLeak(f.captured({ result, consoleLines, admissions: [fromA.admission, fromB.admission, later.admission] }))
    })

    test('AC 23, AC 24: the start pass returns while A is still retrying (its start() never settled), B’s launch did not wait for A, and A is launched from its own retry once Slack answers', async () => {
      const f = makeBringUpFixture({ spawn: true, slack: { [OUTCOME_A]: { connect: [{ kind: 'never' }] } } })
      const [a, b] = f.personas as [Persona, Persona]
      let result: StartupSessionManagerResult | undefined
      const pass = startupSessionManager(f.h.config!, { bringUp: f.controller }).then(r => (result = r))

      await waitForReal(() => spawnedIds().length > 0)
      expect(spawnedIds()).toEqual([`cscb_${b.key}`])
      expect(f.h.clock.now()).toBe(0)
      await f.h.clock.advanceTo(9_999)
      expect(result).toBeUndefined()
      expect(f.controller.state(a.key)?.outcome).toBeUndefined()

      // At 10 s A's start() is abandoned: A has an outcome, so the pass returns — before A's retry at 15 s.
      await f.h.clock.advance(1)
      await pass
      expect(f.h.clock.now()).toBe(10_000)
      expect(result!.perPersona.find(p => p.key === a.key)).toMatchObject({ action: 'not-brought-up', outcome: 'retrying' })
      expect(f.controller.state(a.key)?.outcome).toBe('retrying')
      expect(f.h.manager.status(a.key)).toMatchObject({ state: 'retrying', phase: 'bring-up', retryInMs: 5_000 })
      expect(spawnedIds()).toEqual([`cscb_${b.key}`])

      // A's retry succeeds on its own timer; the controller launches it through the real spawn path, once.
      await f.h.clock.advance(5_000)
      expect(f.controller.state(a.key)?.outcome).toBe('up')
      await waitForReal(() => spawnedIds().length > 1)
      expect(spawnedIds()).toEqual([`cscb_${b.key}`, `cscb_${a.key}`])
      expect(f.launches).toEqual([a.key])
      expect(linesOf(f, a).filter(line => line.includes('up after its bring-up retry (Slack)'))).toHaveLength(1)
      await expectServes(f, a)
      await expectServes(f, b)
      expect(slackCallsBesidesAuthTest(f)).toEqual([])
      expect(existsSync(startupErrorsLog())).toBe(false)
      assertNoLeak(f.captured({ result, consoleLines }))
    })

    test('AC 23, AC 24 diagnostics: one persona-start line per applied persona, broken ones included; each broken line has its class, name and key, personas[i] and path; a doubly broken persona gets both lines from one pass', async () => {
      const f = makeBringUpFixture({ spawn: true, names: [OUTCOME_A, OUTCOME_B, OUTCOME_C] })
      const [a, b, c] = f.personas as [Persona, Persona, Persona]
      rmSync(a.credentials_file)
      breakDirectory(a.working_directory, 'missing')
      breakDirectory(c.working_directory, 'unusable')

      const result = await startupSessionManager(f.h.config!, { bringUp: f.controller })

      expect(result.perPersona.filter(p => p.action === 'not-brought-up').map(p => p.key).sort()).toEqual([a.key, c.key].sort())
      expect(f.controller.state(a.key)).toEqual({
        outcome: 'broken',
        causes: {
          credentials: expect.objectContaining({ class: PERSONA_CREDENTIALS_MISSING }),
          directory: expect.objectContaining({ class: PERSONA_DIRECTORY_MISSING }),
        },
      })
      expect(f.controller.state(c.key)?.outcome).toBe('retrying')
      const startLines = f.h.lines.filter(line => line.includes(`${PERSONA_START}:`))
      expect(startLines).toHaveLength(3)
      for (const persona of [a, b, c]) {
        const own = linesOf(f, persona)
        // Its persona-start line is its first line.
        expect(own[0]).toContain(`${PERSONA_START}:`)
        expect(own[0]).toContain(`personas[${persona.index}]`)
        expect(startLines.filter(line => line.includes(renderPersonaRef(persona.name, persona.key)))).toHaveLength(1)
      }
      // Rows: persona, class, path.
      for (const [persona, cls, path] of [
        [a, PERSONA_CREDENTIALS_MISSING, a.credentials_file],
        [a, PERSONA_DIRECTORY_MISSING, a.working_directory],
        [c, PERSONA_DIRECTORY_UNUSABLE, c.working_directory],
      ] as const) {
        const lines = linesOf(f, persona).filter(line => line.includes(`${cls}:`))
        expect(lines).toHaveLength(1)
        expect(lines[0]).toContain(`personas[${persona.index}]`)
        expect(lines[0]).toContain(`path=${JSON.stringify(path)}`)
      }
      expect(linesOf(f, b)).toHaveLength(1)
      expect(existsSync(startupErrorsLog())).toBe(false)
      assertNoLeak(f.captured({ result, consoleLines }))
    })

    // The no-agent-director-call, no-launch and B-keeps-delivering legs of a refused reopen are
    // pinned by 'AC 5: no agent-director call …', 'a credentials error on reopen …' (both above)
    // and tests/persona-bringup.test.ts's end-to-end case; this one adds the controller's side.
    test('AC 23, AC 24 later credentials failure: a running persona whose reopen is refused (token_revoked) ends broken, logged once with personas[i] and the credentials path; no retry timer, no post', async () => {
      const f = makeBringUpFixture()
      const [a] = f.personas as [Persona, Persona]
      await bringUpEach(f)
      expect(f.controller.state(a.key)?.outcome).toBe('up')
      f.h.stub(a).script.connect.push({ kind: 'platform', error: 'token_revoked' })

      f.h.stub(a).socket.drop()
      await f.h.clock.flush()

      expect(f.controller.state(a.key)).toEqual({
        outcome: 'broken',
        causes: { slack: expect.objectContaining({ step: 'slack', class: PERSONA_CREDENTIALS_REFUSED }) },
      })
      expect(f.h.clock.pendingCount()).toBe(0)
      await f.h.clock.advance(HOUR_MS)
      expect(f.controller.state(a.key)?.outcome).toBe('broken')
      const refused = linesOf(f, a).filter(line => line.includes(`${PERSONA_CREDENTIALS_REFUSED}:`))
      expect(refused).toHaveLength(1)
      expect(refused[0]).toContain('personas[0]')
      expect(refused[0]).toContain(`path=${JSON.stringify(a.credentials_file)}`)
      expect(slackCallsBesidesAuthTest(f)).toEqual([])
      assertNoLeak(f.captured())
    })
  })

  // The surviving instance after its persona recovers or stops being up (the helpers are above the
  // start pass, whose per-cause table covers the row surviving and the instance being refused).
  describe('a not-up persona’s surviving instance (AC 23, AC 24)', () => {
    beforeEach(() => holdRows())

    // Rows: the row's state, how the row spells A's directory, what the ladder does with it and
    // the calls it makes for A's instance (the spawn is the one that collides with the row).
    test.each<[string, 'waiting' | 'ended', 'configured' | 'old symlink target', 'reconnected' | 'resumed', Record<string, number>]>([
      ['a waiting row is reconnected', 'waiting', 'configured', 'reconnected', { spawn: 1, get: 1, sendKeys: 1 }],
      // The status read is the resumed instance's dialog check.
      ['an ended row is resumed', 'ended', 'configured', 'resumed', { spawn: 1, get: 1, resume: 1, status: 1 }],
      ['a waiting row recorded under the target of a working_directory symlink that now dangles is reconnected', 'waiting', 'old symlink target', 'reconnected', { spawn: 1, get: 1, sendKeys: 1 }],
    ])('AC 23, AC 24: a directory-broken persona’s surviving row is kept, and once its directory exists it comes up with no confirmation and its launch reuses the row — %s, with no kill, delete or fresh spawn; its instance, refused while it retried, is then admitted', async (_label, state, spelling, action, reuseCalls) => {
      let launched: Awaited<ReturnType<typeof spawnForPersona>> | undefined
      const f: BringUpFixture = makeBringUpFixture({
        dropSessions: true,
        // The controller's launch after the retry, through the real ladder (as server.ts's launch).
        launch: async persona => (launched = await spawnForPersona(persona, f.h.config!, false)),
      })
      const [a, b] = f.personas as [Persona, Persona]
      // The instance's own directory: the configured path, or the real directory a symlink pointed at.
      const instanceDir = spelling === 'configured' ? a.working_directory : join(dir, 'moved', a.key)
      rmSync(a.working_directory, { recursive: true, force: true })
      if (spelling === 'old symlink target') symlinkSync(instanceDir, a.working_directory)
      addSurvivingRow(a, state, instanceDir)

      const result = await sweepAndStart(f)

      expect(result.perPersona.find(p => p.key === a.key)).toMatchObject({ action: 'not-brought-up', outcome: 'retrying' })
      expect(adCallsFor(idOf(a))).toEqual({})
      expect(adCallsFor(ORPHAN_ID)).toEqual({ kill: 1, delete: 1 })
      expect(deferredLines()).toEqual([expect.stringContaining(renderPersonaRef(a.name, a.key))])
      // While A retries, a registration from its configured directory is refused.
      const whileRetrying = await connectSession(f, a.working_directory)
      expect(whileRetrying.admission).toEqual({ kind: 'not-up', persona: a })
      expect(whileRetrying.transport.steps).toEqual(refusedSteps(whileRetrying))
      expect(routedTo(whileRetrying)).toBeUndefined()

      mkdirSync(instanceDir, { recursive: true })
      await f.h.clock.advance(5_000)

      expect(f.controller.state(a.key)).toEqual({ outcome: 'up', causes: {} })
      expect(f.launches).toEqual([a.key])
      await waitForReal(() => launched !== undefined)
      expect(launched).toEqual({ key: a.key, action })
      expect(adCallsFor(idOf(a))).toEqual(reuseCalls)
      expect([...rows.keys()]).toEqual([idOf(a)])
      expect(spawnedIds()).toEqual([idOf(b), idOf(a)])
      expect(getOutageFlags(a.key).has('cwd-unreachable')).toBe(false)

      // The instance registers again from its own directory, with no restart of anything.
      const afterUp = await connectSession(f, instanceDir)
      expect(afterUp.admission).toEqual({ kind: 'admitted', persona: a })
      expect(afterUp.entry).toMatchObject({ personaKey: a.key, cwd: realpathSync(instanceDir), connected: true })
      expect(routedTo(afterUp)).toBe(afterUp.entry!)
      expect(refusalsOf(f, a)).toHaveLength(1)
      expect(slackCallsBesidesAuthTest(f)).toEqual([])
      expect(sessionNotices).toEqual([])
      expect(outageNotices).toEqual([])
      await expectServes(f, a)
      await expectServes(f, b)
      assertNoLeak(f.captured({ result, launched, consoleLines, admissions: [whileRetrying.admission, afterUp.admission] }))
    })

    test('AC 23, AC 24: a running persona whose reopen is refused (token_revoked) has its MCP session dropped — entry and session-ID mapping removed, transport closed with nothing left to restart — while B’s session is unchanged; no agent-director call, restart or post; its next registration is refused', async () => {
      const f = makeBringUpFixture({ dropSessions: true })
      const [a, b] = f.personas as [Persona, Persona]
      await bringUpEach(f)
      const fromA = await connectSession(f, a.working_directory)
      const fromB = await connectSession(f, b.working_directory)
      expect([fromA.admission.kind, fromB.admission.kind]).toEqual(['admitted', 'admitted'])
      f.h.stub(a).script.connect.push({ kind: 'platform', error: 'token_revoked' })

      f.h.stub(a).socket.drop()
      // Lost and being reopened, A is still up and keeps its session.
      expect(f.h.manager.status(a.key)).toEqual({ state: 'lost' })
      expect(getSessionByPersona(a.key)).toBe(fromA.entry!)
      await f.h.clock.flush()

      expect(f.controller.state(a.key)?.outcome).toBe('broken')
      expect(getSessionByPersona(a.key)).toBeUndefined()
      expect(routedTo(fromA)).toBeUndefined()
      expect(fromA.entry!.connected).toBe(false)
      expect(fromA.transport.closes).toBe(1)
      expect(fromA.transport.unregisteredOnClose).toEqual([undefined])
      expect(getSessionByPersona(b.key)).toBe(fromB.entry!)
      expect(fromB.entry!.connected).toBe(true)
      expect(routedTo(fromB)).toBe(fromB.entry!)
      expect(fromB.transport.closes).toBe(0)
      expect(f.h.lines.filter(line => line.includes('MCP session dropped'))).toEqual([
        `[slack] persona ${renderPersonaRef(a.name, a.key)}: MCP session dropped — the persona is not up ` +
          `(broken: ${f.controller.state(a.key)!.causes.slack!.cause}); its instance and agent-director row are kept`,
      ])
      expect(ad.callCount()).toBe(0)
      expect(getFailureCount(a.key)).toBe(0)

      // Meanwhile its instance's next registration is refused, and B is unaffected throughout.
      const again = await connectSession(f, a.working_directory)
      expect(again.admission).toEqual({ kind: 'not-up', persona: a })
      await f.h.clock.advance(HOUR_MS)
      expect(f.controller.state(a.key)?.outcome).toBe('broken')
      expect(getSessionByPersona(a.key)).toBeUndefined()
      expect(getSessionByPersona(b.key)).toBe(fromB.entry!)
      expect(f.h.lines.filter(line => line.includes('MCP session dropped'))).toHaveLength(1)
      expect(ad.callCount()).toBe(0)
      expect(slackCallsBesidesAuthTest(f)).toEqual([])
      expect(sessionNotices).toEqual([])
      await expectServes(f, b)
      assertNoLeak(f.captured({ consoleLines, admissions: [fromA.admission, fromB.admission, again.admission] }))
    })

    test.each<[string, ConnectOutcome[], 'lost' | 'retrying' | 'up']>([
      ['is still in flight (lost; its WebSocket never reaches hello)', [{ kind: 'never' }], 'lost'],
      ['is still retrying (Slack unreachable)', [{ kind: 'network' }], 'retrying'],
      ['succeeds', [], 'up'],
    ])('AC 23, AC 24: a running persona whose reopen %s stays up and keeps its registered MCP session; nothing is dropped', async (_label, reopen, state) => {
      const f = makeBringUpFixture({ dropSessions: true })
      const [a, b] = f.personas as [Persona, Persona]
      await bringUpEach(f)
      const fromA = await connectSession(f, a.working_directory)
      const fromB = await connectSession(f, b.working_directory)
      f.h.stub(a).script.connect.push(...reopen)

      f.h.stub(a).socket.drop()
      await f.h.clock.flush()

      expect(f.h.manager.status(a.key)).toMatchObject({ state })
      expect(f.controller.state(a.key)).toEqual({ outcome: 'up', causes: {} })
      for (const session of [fromA, fromB]) {
        expect(getSessionByPersona(session.entry!.personaKey)).toBe(session.entry!)
        expect(session.entry!.connected).toBe(true)
        expect(routedTo(session)).toBe(session.entry!)
        expect(session.transport.closes).toBe(0)
      }
      await f.h.clock.advance(HOUR_MS)
      expect(f.h.manager.status(a.key)).toMatchObject({ state: 'up' })
      expect(getSessionByPersona(a.key)).toBe(fromA.entry!)
      expect(fromA.transport.closes).toBe(0)
      expect(f.h.lines.filter(line => line.includes('MCP session dropped'))).toEqual([])
      expect(ad.callCount()).toBe(0)
      await expectServes(f, a)
      await expectServes(f, b)
      assertNoLeak(f.captured({ consoleLines }))
    })
  })

  // -------------------------------------------------------------------------
  // Leaving up (b.av2 SR-6.3, SR-6.4): the controller's `onLeftUp` listener and
  // the not-up description used by the refusal and drop lines
  // -------------------------------------------------------------------------

  describe('leaving up: onLeftUp and describePersonaNotUp', () => {
    /** A recording `onLeftUp`: the key and state of each call, in order. */
    function recordLeftUp() {
      const calls: [string, PersonaBringUpState][] = []
      return { calls, onLeftUp: (persona: Persona, state: PersonaBringUpState) => void calls.push([persona.key, state]) }
    }

    /** Bring A and B up, then refuse A's reopen (token_revoked): A goes from up to broken. */
    async function upThenRefusedReopen(f: BringUpFixture): Promise<void> {
      const [a] = f.personas as [Persona, Persona]
      await bringUpEach(f)
      expect(f.controller.state(a.key)?.outcome).toBe('up')
      f.h.stub(a).script.connect.push({ kind: 'platform', error: 'token_revoked' })
      f.h.stub(a).socket.drop()
      await f.h.clock.flush()
      expect(f.controller.state(a.key)?.outcome).toBe('broken')
    }

    test('a persona that is never up is never reported: A retrying (Slack unreachable), then broken (invalid_auth) at its retry, makes no onLeftUp call; neither does B, up throughout', async () => {
      const { calls, onLeftUp } = recordLeftUp()
      const f = makeBringUpFixture({
        slack: { [OUTCOME_A]: { authTest: [{ kind: 'network' }, { kind: 'platform', error: 'invalid_auth' }] } },
        onLeftUp,
      })
      const [a, b] = f.personas as [Persona, Persona]

      await bringUpEach(f)
      expect(f.controller.state(a.key)?.outcome).toBe('retrying')
      await f.h.clock.advance(5_000)

      expect(f.controller.state(a.key)?.outcome).toBe('broken')
      expect(f.controller.state(b.key)?.outcome).toBe('up')
      expect(calls).toEqual([])
      assertNoLeak(f.captured({ calls }))
    })

    test('A up, then broken on a refused reopen: onLeftUp is called exactly once, with A and outcome broken and its Slack cause, however many status events follow; B is never reported', async () => {
      const { calls, onLeftUp } = recordLeftUp()
      const f = makeBringUpFixture({ onLeftUp })
      const [a] = f.personas as [Persona, Persona]

      await upThenRefusedReopen(f)
      expect(calls).toEqual([
        [a.key, { outcome: 'broken', causes: { slack: expect.objectContaining({ step: 'slack', class: PERSONA_CREDENTIALS_REFUSED }) } }],
      ])

      // More status events while A stays broken: its status delivered again, and an hour of fake time.
      for (let i = 0; i < 3; i++) f.controller.onConnectionStatus(a.key, f.h.manager.status(a.key)!)
      await f.h.clock.advance(HOUR_MS)

      expect(f.controller.state(a.key)?.outcome).toBe('broken')
      expect(calls.map(([key, state]) => [key, state.outcome])).toEqual([[a.key, 'broken']])
      assertNoLeak(f.captured({ calls }))
    })

    const LISTENER_ERROR = new Error('the onLeftUp listener failed')
    test.each<[string, () => unknown]>([
      ['throws', () => { throw LISTENER_ERROR }],
      ['rejects', async () => { throw LISTENER_ERROR }],
    ])('an onLeftUp listener that %s is logged once, naming A and the change, and leaves no unhandled rejection; A stays broken and B still serves', async (_label, onLeftUp) => {
      const f = makeBringUpFixture({ onLeftUp })
      const [a, b] = f.personas as [Persona, Persona]

      await upThenRefusedReopen(f)
      await f.h.clock.flush()

      expect(f.h.lines.filter(line => line.includes('handling its change from up to'))).toEqual([
        `[slack] persona ${renderPersonaRef(a.name, a.key)}: handling its change from up to broken failed: ${describeThrownValue(LISTENER_ERROR)}`,
      ])
      expect(f.controller.state(a.key)?.outcome).toBe('broken')
      await expectServes(f, b)
      assertNoLeak(f.captured())
    })

    const failure = (step: 'credentials' | 'working-directory' | 'slack', cause: string) => ({ step, class: `class of ${step}`, cause })
    test.each<[string, PersonaBringUpState | undefined, string]>([
      ['no state (the controller never brought it up, or it was cancelled)', undefined, 'its bring-up has not run'],
      ['no outcome yet (its first Slack attempt in flight)', { outcome: undefined, causes: {} }, 'its Slack connection is not serving'],
      ['bring-up up (only its connection is not serving)', { outcome: 'up', causes: {} }, 'its Slack connection is not serving'],
      ['broken with no cause', { outcome: 'broken', causes: {} }, 'broken'],
      ['retrying with no cause', { outcome: 'retrying', causes: {} }, 'retrying'],
      [
        'broken with every cause: credentials first',
        {
          outcome: 'broken',
          causes: { credentials: failure('credentials', 'file missing'), directory: failure('working-directory', 'dir missing'), slack: failure('slack', 'refused') },
        },
        'broken: file missing',
      ],
      [
        'retrying with directory and Slack causes: directory first',
        { outcome: 'retrying', causes: { directory: failure('working-directory', 'dir missing'), slack: failure('slack', 'unreachable') } },
        'retrying: dir missing',
      ],
      ['retrying with a Slack cause only', { outcome: 'retrying', causes: { slack: failure('slack', 'unreachable') } }, 'retrying: unreachable'],
    ])('describePersonaNotUp: %s', (_label, state, expected) => {
      expect(describePersonaNotUp(state)).toBe(expected)
    })
  })

  // -------------------------------------------------------------------------
  // Per-persona retry timers (SR-6.4, SR-6.1 held credentials; AC 66)
  // -------------------------------------------------------------------------

  describe('per-persona retry timers', () => {
    /** More steps than the restart cap allows: the SR-3.2 ladder, then the 300 s ceiling repeated. */
    const DIRECTORY_STEPS_S = [5, 10, 20, 40, 80, 160, 300, 300, 300, 300, 300, 300]

    test.each<['missing' | 'unusable', string]>([
      ['missing', PERSONA_DIRECTORY_MISSING],
      ['unusable', PERSONA_DIRECTORY_UNUSABLE],
    ])('AC 66: a working directory that is %s is re-checked on 5 s doubling to a 300 s ceiling with no cap and no Slack client; once usable, A comes up with no confirmation using the credentials read at its original bring-up, not the edited file', async (how, cls) => {
      const f = makeBringUpFixture()
      const [a, b] = f.personas as [Persona, Persona]
      const original = f.h.tokens(a)
      breakDirectory(a.working_directory, how)

      const summaries = await bringUpEach(f)

      expect(summaries.get(a.key)).toEqual({ outcome: 'retrying', failures: [{ step: 'working-directory', class: cls, cause: expect.any(String) }] })
      expect(summaries.get(b.key)).toEqual({ outcome: 'up', failures: [] })
      expect(DIRECTORY_STEPS_S.length).toBeGreaterThan(RESTART_FAILURE_CAP)
      let edited: PersonaSlackTokens | undefined
      for (const [i, stepS] of DIRECTORY_STEPS_S.entries()) {
        expect(f.h.clock.pending().map(timer => timer.delayMs)).toEqual([stepS * 1000])
        // Meanwhile the credentials file is rewritten with other tokens.
        if (i === 3) edited = editCredentials(a)
        await f.h.clock.runNext()
        expect(f.controller.state(a.key)?.outcome).toBe('retrying')
      }
      expect(f.h.slack.buildsOf(a.key)).toEqual([])
      expect(f.h.bringUpCalls.map(call => call.key)).toEqual([b.key])
      expect(f.directoryStats.filter(([path]) => path === a.working_directory)).toHaveLength(1 + DIRECTORY_STEPS_S.length)
      await expectServes(f, b)

      repairDirectory(a.working_directory)
      expect(f.h.clock.pending().map(timer => timer.delayMs)).toEqual([300_000])
      await f.h.clock.runNext()

      expect(f.controller.state(a.key)).toEqual({ outcome: 'up', causes: {} })
      expect(f.launches).toEqual([a.key])
      expect(f.h.clock.pendingCount()).toBe(0)
      await expectServes(f, a)
      // The held tokens, not the edited file's: the file was opened once, at the original bring-up.
      expect(f.credentialOpens.filter(path => path === a.credentials_file)).toHaveLength(1)
      expect(f.h.bringUpCalls.filter(call => call.key === a.key)).toEqual([{ key: a.key, gotTokens: true, ownTokens: true }])
      const [validation] = f.h.slack.buildsOf(a.key, 'validation')
      const [socket] = f.h.slack.buildsOf(a.key, 'socket')
      expect([validation!.hasToken(original.botToken), validation!.hasToken(edited!.botToken)]).toEqual([true, false])
      expect([socket!.hasToken(original.appToken), socket!.hasToken(edited!.appToken)]).toEqual([true, false])
      // Outside the restart counter and cap, and no cwd-unreachable flag or notice.
      expect(getFailureCount(a.key)).toBe(0)
      expect(sessionNotices).toEqual([])
      expect(getOutageFlags(a.key).has('cwd-unreachable')).toBe(false)
      expect(outageNotices).toEqual([])
      expect(slackCallsBesidesAuthTest(f)).toEqual([])
      // Logged when the cause starts and when it clears, never per attempt.
      const own = linesOf(f, a)
      expect(own).toHaveLength(4)
      expect(own[0]).toContain(`${PERSONA_START}:`)
      expect(own.slice(1, 3).every(line => line.includes(`${cls}:`) && line.includes('personas[0]') && line.includes(`path=${JSON.stringify(a.working_directory)}`))).toBe(true)
      expect(own[1]).not.toContain('cleared')
      expect(own[2]).toContain('cleared: working directory is usable again; continuing the bring-up')
      expect(own[3]).toContain('up after its bring-up retry (directory)')
      assertNoLeak(f.captured({ summaries: [...summaries.values()] }))
    })

    test.each<[string, WebApiOutcome[], number]>([
      ['two unreachable auth.test answers', [{ kind: 'network' }, { kind: 'dns' }], 15_000],
      ['a rate-limited answer with retryAfter 30 s', [{ kind: 'rate-limited', retryAfter: 30 }], 30_000],
    ])('a Slack-unreachable bring-up (%s) comes up on its own timer and is launched once, with the credentials read at its original bring-up; a later drop and reopen launches nothing', async (_label, authTest, upAtMs) => {
      const f = makeBringUpFixture({ slack: { [OUTCOME_A]: { authTest } } })
      const [a, b] = f.personas as [Persona, Persona]
      const original = f.h.tokens(a)

      const summaries = await bringUpEach(f)
      const edited = editCredentials(a)

      expect(summaries.get(a.key)).toEqual({ outcome: 'retrying', failures: [expect.objectContaining({ step: 'slack', class: PERSONA_SLACK_UNREACHABLE })] })
      await f.h.clock.advanceTo(upAtMs - 1)
      expect(f.controller.state(a.key)?.outcome).toBe('retrying')
      expect(f.launches).toEqual([])
      await expectServes(f, b)
      await f.h.clock.advance(1)

      expect(f.controller.state(a.key)).toEqual({ outcome: 'up', causes: {} })
      expect(f.launches).toEqual([a.key])
      expect(linesOf(f, a).filter(line => line.includes('up after its bring-up retry (Slack)'))).toHaveLength(1)
      const unreachable = linesOf(f, a).filter(line => line.includes(`${PERSONA_SLACK_UNREACHABLE}:`))
      expect(unreachable).toHaveLength(2)
      expect(unreachable[1]).toContain('cleared')
      expect(f.credentialOpens.filter(path => path === a.credentials_file)).toHaveLength(1)
      const validations = f.h.slack.buildsOf(a.key, 'validation')
      expect(validations).toHaveLength(authTest.length + 1)
      expect(validations.every(build => build.hasToken(original.botToken) && !build.hasToken(edited.botToken))).toBe(true)
      expect(f.h.slack.buildsOf(a.key, 'socket').every(build => build.hasToken(original.appToken))).toBe(true)

      // An up after lost, or after retrying a reopen, is not a bring-up retry: nothing more is
      // launched, for A or for B (up at start, so never launched by the controller).
      for (const persona of [a, b]) {
        f.h.stub(persona).script.connect.push({ kind: 'network' })
        f.h.stub(persona).socket.drop()
      }
      // A running persona stays up through a reopen blip: while lost, and while it retries the reopen.
      for (const [state, phase] of [['lost', undefined], ['retrying', 'reopen']] as const) {
        if (state === 'retrying') await f.h.clock.flush()
        for (const persona of [a, b]) {
          expect(f.h.manager.status(persona.key)).toMatchObject(phase === undefined ? { state } : { state, phase })
          expect(f.controller.state(persona.key)).toEqual({ outcome: 'up', causes: {} })
          expect(f.controller.isUp(persona.key)).toBe(true)
        }
      }
      await f.h.clock.advance(HOUR_MS)
      expect(connectionStatesOf(f, b)).toEqual(['connecting', 'up', 'lost', 'retrying', 'up'])
      expect(f.h.manager.status(a.key)).toMatchObject({ state: 'up' })
      expect(f.launches).toEqual([a.key])
      await expectServes(f, a)
      await expectServes(f, b)
      assertNoLeak(f.captured({ summaries: [...summaries.values()] }))
    })

    test('combined causes: a directory-broken persona whose directory is created while Slack is still unreachable moves on to Slack retries and comes up when Slack answers, with no confirmation', async () => {
      const f = makeBringUpFixture({ slack: { [OUTCOME_A]: { authTest: [{ kind: 'network' }] } } })
      const [a, b] = f.personas as [Persona, Persona]
      breakDirectory(a.working_directory, 'missing')
      await bringUpEach(f)

      repairDirectory(a.working_directory)
      await f.h.clock.advance(5_000)

      expect(f.controller.state(a.key)).toEqual({
        outcome: 'retrying',
        causes: { slack: expect.objectContaining({ class: PERSONA_SLACK_UNREACHABLE }) },
      })
      expect(f.launches).toEqual([])
      expect(f.h.slack.buildsOf(a.key, 'validation')).toHaveLength(1)
      expect(f.h.slack.buildsOf(a.key, 'socket')).toEqual([])

      await f.h.clock.advance(5_000)

      expect(f.controller.state(a.key)).toEqual({ outcome: 'up', causes: {} })
      expect(f.launches).toEqual([a.key])
      expect(f.h.bringUpCalls.filter(call => call.key === a.key)).toEqual([{ key: a.key, gotTokens: true, ownTokens: true }])
      expect(linesOf(f, a).filter(line => line.includes(`${PERSONA_DIRECTORY_MISSING}:`) && line.includes('cleared'))).toHaveLength(1)
      await expectServes(f, a)
      await expectServes(f, b)
      assertNoLeak(f.captured())
    })

    test('combined causes: a persona both credentials-broken and directory-broken does not come up when only its directory is created: the cleared line is logged, no Slack client is built, it stays broken', async () => {
      const f = makeBringUpFixture()
      const [a, b] = f.personas as [Persona, Persona]
      rmSync(a.credentials_file)
      breakDirectory(a.working_directory, 'missing')
      const summaries = await bringUpEach(f)
      expect(summaries.get(a.key)).toEqual({
        outcome: 'broken',
        failures: [
          expect.objectContaining({ step: 'credentials', class: PERSONA_CREDENTIALS_MISSING }),
          expect.objectContaining({ step: 'working-directory', class: PERSONA_DIRECTORY_MISSING }),
        ],
      })

      repairDirectory(a.working_directory)
      await f.h.clock.advance(5_000)

      expect(f.controller.state(a.key)).toEqual({
        outcome: 'broken',
        causes: { credentials: expect.objectContaining({ class: PERSONA_CREDENTIALS_MISSING }) },
      })
      const cleared = linesOf(f, a).filter(line => line.includes(`${PERSONA_DIRECTORY_MISSING}:`) && line.includes('cleared'))
      expect(cleared).toHaveLength(1)
      expect(cleared[0]).toBe(formatPersonaDiagnostic({
        class: PERSONA_DIRECTORY_MISSING,
        name: a.name,
        key: a.key,
        index: a.index,
        path: a.working_directory,
        cause: 'cleared: working directory is usable again; the persona stays broken until its credentials file is fixed and the change confirmed',
      }))
      // Nothing is re-checked once the directory cleared; nothing moves on to Slack.
      expect(f.h.clock.pendingCount()).toBe(0)
      await f.h.clock.advance(HOUR_MS)
      expect(f.h.slack.buildsOf(a.key)).toEqual([])
      expect(f.launches).toEqual([])
      await expectServes(f, b)
      assertNoLeak(f.captured({ summaries: [...summaries.values()] }))
    })

    test('independence: two retrying personas on staggered schedules each fire on their own timer; one coming up neither resets nor delays the other; the healthy persona delivers throughout', async () => {
      const f = makeBringUpFixture({
        names: [OUTCOME_A, OUTCOME_B, OUTCOME_C],
        slack: { [OUTCOME_C]: { authTest: [{ kind: 'network' }, { kind: 'network' }, { kind: 'network' }] } },
      })
      const [a, b, c] = f.personas as [Persona, Persona, Persona]
      breakDirectory(a.working_directory, 'missing')
      // A (directory) at 0 s: re-checks at 5, 15, 35 s. B healthy. C (Slack) at 2 s: attempts at 7, 17, 37 s.
      expect((await f.controller.bringUp(a, f.personas)).outcome).toBe('retrying')
      expect((await f.controller.bringUp(b, f.personas)).outcome).toBe('up')
      await f.h.clock.advanceTo(2_000)
      expect((await f.controller.bringUp(c, f.personas)).outcome).toBe('retrying')
      const aChecks = () => f.directoryStats.filter(([path]) => path === a.working_directory).length
      const cAttempts = () => f.h.stub(c).calls.authTest.length

      // [time, A's directory checks, C's auth.test calls, launches so far]; A's directory is created at 20 s.
      for (const [at, checks, attempts, launched] of [
        [4_999, 1, 1, []],
        [5_000, 2, 1, []],
        [7_000, 2, 2, []],
        [15_000, 3, 2, []],
        [17_000, 3, 3, []],
        [20_000, 3, 3, []],
        [34_999, 3, 3, []],
        [35_000, 4, 3, [a.key]],
        [36_999, 4, 3, [a.key]],
        [37_000, 4, 4, [a.key, c.key]],
      ] as const) {
        await f.h.clock.advanceTo(at)
        if (at === 20_000) repairDirectory(a.working_directory)
        expect([aChecks(), cAttempts(), f.launches]).toEqual([checks, attempts, [...launched]])
        await expectServes(f, b)
      }
      for (const persona of [a, b, c]) expect(f.controller.state(persona.key)?.outcome).toBe('up')
      await expectServes(f, a)
      await expectServes(f, c)
      assertNoLeak(f.captured())
    })

    test('dry run (SR-3.4): a persona whose directory is missing still retries and comes up once it exists; no credentials file is read and no Slack call is made at any step', async () => {
      // The healthy persona first, so the retrying one is personas[1].
      const f = makeBringUpFixture({ dryRun: true, names: [OUTCOME_B, OUTCOME_A] })
      const [healthy, retrying] = f.personas as [Persona, Persona]
      for (const persona of f.personas) rmSync(persona.credentials_file)
      f.fsOverride.openFile = () => { throw new Error('no credentials file may be opened in dry run') }
      breakDirectory(retrying.working_directory, 'missing')

      const summaries = await bringUpEach(f)
      expect(summaries.get(healthy.key)).toEqual({ outcome: 'up', failures: [] })
      expect(summaries.get(retrying.key)?.outcome).toBe('retrying')
      repairDirectory(retrying.working_directory)
      await f.h.clock.advance(5_000)

      expect(f.controller.state(retrying.key)).toEqual({ outcome: 'up', causes: {} })
      expect(f.launches).toEqual([retrying.key])
      expect(f.credentialOpens).toEqual([])
      expect(f.h.slack.builds).toEqual([])
      expect(f.h.bringUpCalls.map(call => call.gotTokens)).toEqual([false, false])
      const own = linesOf(f, retrying)
      expect(own).toHaveLength(4)
      expect(own[0]).toContain(`${PERSONA_START}:`)
      for (const line of own.slice(1, 3)) {
        expect(line).toContain(`${PERSONA_DIRECTORY_MISSING}:`)
        expect(line).toContain('personas[1]')
        expect(line).toContain(`path=${JSON.stringify(retrying.working_directory)}`)
      }
      expect(own[2]).toContain('cleared')
      expect(own[3]).toContain('up after its bring-up retry (directory)')
      expect(linesOf(f, healthy)).toEqual([expect.stringContaining(`${PERSONA_START}:`)])
      assertNoLeak(f.captured({ summaries: [...summaries.values()] }))
    })

    test('a directory retry whose Slack step comes up and then drops (lost) before the launch check still launches A, once', async () => {
      const reopen = makeDeferredConnect()
      let dropped = false
      const f: BringUpFixture = makeBringUpFixture({
        // A's Slack step came up; Slack drops the socket before the controller checks the outcome,
        // and the reopen waits on apps.connections.open, so A stays lost through the check.
        afterSlackBringUp: persona => {
          if (persona.name !== OUTCOME_A || dropped) return
          dropped = true
          f.h.stub(persona).script.connect.push(reopen.outcome)
          f.h.stub(persona).socket.drop()
        },
      })
      const [a, b] = f.personas as [Persona, Persona]
      breakDirectory(a.working_directory, 'missing')
      await bringUpEach(f)
      repairDirectory(a.working_directory)

      await f.h.clock.advance(5_000)

      expect(dropped).toBe(true)
      expect(f.h.manager.status(a.key)).toEqual({ state: 'lost' })
      expect(f.controller.state(a.key)).toEqual({ outcome: 'up', causes: {} })
      expect(f.launches).toEqual([a.key])
      expect(linesOf(f, a).filter(line => line.includes('up after its bring-up retry (directory)'))).toHaveLength(1)
      // The reopen succeeds: an up after lost launches nothing more.
      reopen.settle()
      await f.h.clock.advance(HOUR_MS)
      expect(f.h.manager.status(a.key)).toMatchObject({ state: 'up' })
      expect(f.launches).toEqual([a.key])
      await expectServes(f, a)
      await expectServes(f, b)
      assertNoLeak(f.captured())
    })

    // Rows: how A's bring-up is retried, and what the launch after that retry does.
    test.each<['directory' | 'Slack', 'rejects' | 'returns failed']>([
      ['directory', 'rejects'],
      ['directory', 'returns failed'],
      ['Slack', 'rejects'],
      ['Slack', 'returns failed'],
    ])('a launch after a %s retry that %s is not a bring-up failure: A stays up, a rejection logs one token-free line, no timer, no second launch, no post', async (via, launchDoes) => {
      const f = makeBringUpFixture({
        launch: async persona => {
          if (launchDoes === 'rejects') throw new Error(`spawn exploded ${LEAK_SENTINEL} ${fakeToken(BOT_TOKEN_PREFIX, 'launch')}`)
          return { key: persona.key, action: 'failed' }
        },
      })
      const [a, b] = f.personas as [Persona, Persona]
      if (via === 'directory') breakDirectory(a.working_directory, 'missing')
      else f.h.stub(a).script.authTest.push({ kind: 'network' })
      expect((await bringUpEach(f)).get(a.key)?.outcome).toBe('retrying')
      if (via === 'directory') repairDirectory(a.working_directory)
      const before = linesOf(f, a).length

      await f.h.clock.advance(5_000)

      expect(f.launches).toEqual([a.key])
      expect(f.controller.state(a.key)).toEqual({ outcome: 'up', causes: {} })
      expect(f.controller.isUp(a.key)).toBe(true)
      expect(f.h.clock.pendingCount()).toBe(0)
      // The cause's cleared line, the launch line and, for a rejection only, the launch failure line.
      const after = linesOf(f, a).slice(before)
      expect(after[0]).toContain('cleared')
      expect(after[1]).toContain(`up after its bring-up retry (${via}) — launching`)
      expect(after.slice(2)).toEqual(
        launchDoes === 'rejects'
          ? [expect.stringContaining(`[slack] persona ${renderPersonaRef(a.name, a.key)}: launch after its bring-up retry failed: Error `)]
          : [],
      )
      await f.h.clock.advance(HOUR_MS)
      expect(f.launches).toEqual([a.key])
      expect(f.controller.state(a.key)?.outcome).toBe('up')
      expect(linesOf(f, a).slice(before)).toHaveLength(after.length)
      expect(slackCallsBesidesAuthTest(f)).toEqual([])
      expect(sessionNotices).toEqual([])
      await expectServes(f, a)
      await expectServes(f, b)
      assertNoLeak(f.captured())
    })
  })

  // -------------------------------------------------------------------------
  // The live applied set (b.av2 SR-8.6). From a confirmed apply's step 1 on,
  // a retry for a key outside the applied set brings nothing up and launches
  // nothing, even before its teardown cancels it; a directory re-check checks
  // against the applied set as it is now (the E11 stale-set carry), and a
  // launch after a retry launches the current declaration. Only launches are
  // guarded: stopping the connection manager's own Slack retry is the apply's
  // step 2 (teardown), so a removed persona may still be validated here.
  // -------------------------------------------------------------------------

  describe('bring-up retries and the live applied set (b.av2 SR-8.6)', () => {
    const refOf = (persona: Persona) => renderPersonaRef(persona.name, persona.key)

    // server.ts binds the controller's `isApplied` into `isPersonaUp` and the
    // relaunch gate; A stays up and serving here, so only the applied set can
    // refuse it.
    test('isApplied reads the live applied set: once A is removed, the real up predicate and relaunch gate refuse A while its connection and outcome are still up, and allow B', async () => {
      const f = makeBringUpFixture()
      const [a, b] = f.personas as [Persona, Persona]
      const summaries = await bringUpEach(f)
      const isPersonaUp = createPersonaUpPredicate(f.h.manager, f.controller)
      const canRelaunch = createPersonaRelaunchGate(f.h.manager, line => void f.h.lines.push(line), f.controller)
      for (const persona of [a, b]) {
        expect(f.controller.isApplied(persona.key)).toBe(true)
        expect(isPersonaUp(persona.key)).toBe(true)
        expect(canRelaunch(persona.key)).toBe(true)
      }
      const linesBefore = f.h.lines.length

      f.setApplied([b])

      expect(f.controller.isApplied(a.key)).toBe(false)
      expect(f.controller.isApplied(b.key)).toBe(true)
      expect(f.h.manager.status(a.key)).toMatchObject({ state: 'up' })
      expect(f.controller.isUp(a.key)).toBe(true)
      expect(isPersonaUp(a.key)).toBe(false)
      expect(isPersonaUp(b.key)).toBe(true)
      expect(canRelaunch(a.key)).toBe(false)
      expect(canRelaunch(b.key)).toBe(true)
      expect(f.h.lines.slice(linesBefore)).toEqual([
        `[slack] persona=${a.key}: not relaunched — it is no longer in the applied configuration`,
      ])
      expect(f.launches).toEqual([])
      await expectServes(f, b)
      assertNoLeak(f.captured({ summaries: [...summaries.values()] }))
    })

    test('a directory-broken persona removed from the applied set: its next re-check stats nothing, builds no Slack client, launches nothing and ends its retries with one line; the healthy persona keeps serving', async () => {
      const f = makeBringUpFixture()
      const [a, b] = f.personas as [Persona, Persona]
      breakDirectory(a.working_directory, 'missing')
      expect((await bringUpEach(f)).get(a.key)?.outcome).toBe('retrying')
      const statsBefore = f.directoryStats.length
      const linesBefore = linesOf(f, a).length

      f.setApplied([b])
      repairDirectory(a.working_directory)
      await f.h.clock.advance(5_000)

      expect(f.directoryStats.slice(statsBefore)).toEqual([])
      expect(f.h.slack.buildsOf(a.key)).toEqual([])
      expect(f.h.bringUpCalls.map(call => call.key)).toEqual([b.key])
      expect(f.launches).toEqual([])
      expect(f.h.clock.pendingCount()).toBe(0)
      expect(linesOf(f, a).slice(linesBefore)).toEqual([`[slack] persona ${refOf(a)}: no longer applied — its working-directory retry stops`])
      await f.h.clock.advance(HOUR_MS)
      expect(f.directoryStats.slice(statsBefore)).toEqual([])
      expect(f.launches).toEqual([])
      await expectServes(f, b)
      assertNoLeak(f.captured())
    })

    // E11 carry: a re-check used the set the persona was brought up with, so
    // a persona colliding with one an apply removed or moved never came up.
    test.each<['removed' | 'moved to its own directory']>([['removed'], ['moved to its own directory']])(
      'two personas sharing a working directory both retry; once B is %s by an apply, A\'s next re-check reads the live applied set and A comes up and is launched once',
      async (how) => {
        const shared = join(dir, 'shared-work')
        const f = makeBringUpFixture({
          names: [OUTCOME_A, OUTCOME_B, OUTCOME_C],
          specs: { [OUTCOME_A]: { working_directory: shared }, [OUTCOME_B]: { working_directory: shared } },
        })
        const [a, b, c] = f.personas as [Persona, Persona, Persona]
        const summaries = await bringUpEach(f)
        for (const persona of [a, b]) {
          expect(summaries.get(persona.key)).toEqual({
            outcome: 'retrying',
            failures: [{ step: 'working-directory', class: PERSONA_DIRECTORY_UNUSABLE, cause: expect.any(String) }],
          })
        }
        expect(summaries.get(c.key)?.outcome).toBe('up')

        const own = join(dir, 'b-own-work')
        mkdirSync(own)
        f.setApplied(how === 'removed' ? [a, c] : [a, { ...b, working_directory: own }, c])
        await f.h.clock.advance(5_000)

        expect(f.controller.state(a.key)).toEqual({ outcome: 'up', causes: {} })
        expect(f.launches).toEqual([a.key])
        expect(linesOf(f, a).filter(line => line.includes('up after its bring-up retry (directory) — launching'))).toHaveLength(1)
        await expectServes(f, a)
        await expectServes(f, c)
        assertNoLeak(f.captured({ summaries: [...summaries.values()] }))
      },
    )

    test('a Slack-unreachable persona removed from the applied set: when the manager\'s retry brings it up, nothing is launched, with one line; the healthy persona keeps serving', async () => {
      const f = makeBringUpFixture({ slack: { [OUTCOME_A]: { authTest: [{ kind: 'network' }] } } })
      const [a, b] = f.personas as [Persona, Persona]
      expect((await bringUpEach(f)).get(a.key)?.outcome).toBe('retrying')

      f.setApplied([b])
      await f.h.clock.advance(5_000)

      expect(f.h.manager.status(a.key)).toMatchObject({ state: 'up' })
      expect(f.launches).toEqual([])
      expect(linesOf(f, a).filter(line => line.includes('after its bring-up retry'))).toEqual([
        `[slack] persona ${refOf(a)}: up after its bring-up retry (Slack) but no longer applied — not launching`,
      ])
      await f.h.clock.advance(HOUR_MS)
      expect(f.launches).toEqual([])
      await expectServes(f, b)
      assertNoLeak(f.captured())
    })

    test.each<['directory' | 'Slack']>([['directory'], ['Slack']])(
      'control: an applied persona\'s %s retry brings it up and launches its current applied declaration, once',
      async (via) => {
        const launched: Persona[] = []
        const f = makeBringUpFixture({
          launch: async persona => void launched.push(persona),
          ...(via === 'Slack' ? { slack: { [OUTCOME_A]: { authTest: [{ kind: 'network' }] } } } : {}),
        })
        const [a, b] = f.personas as [Persona, Persona]
        if (via === 'directory') breakDirectory(a.working_directory, 'missing')
        expect((await bringUpEach(f)).get(a.key)?.outcome).toBe('retrying')
        if (via === 'directory') repairDirectory(a.working_directory)

        // A confirmed apply's step 1 swaps in a new declaration object for the same key.
        const current: Persona = { ...a }
        f.setApplied([current, b])
        await f.h.clock.advance(5_000)

        expect(f.controller.state(a.key)).toEqual({ outcome: 'up', causes: {} })
        expect(f.launches).toEqual([a.key])
        expect(launched).toHaveLength(1)
        expect(launched[0]).toBe(current)
        expect(f.h.clock.pendingCount()).toBe(0)
        await expectServes(f, a)
        await expectServes(f, b)
        assertNoLeak(f.captured())
      },
    )
  })

  // -------------------------------------------------------------------------
  // Serialized retries (b.av2 SR-6.6). Each retry attempt, through to the
  // launch it triggers, runs through the persona's lifecycle serializer: it
  // waits behind an operation already running for its persona (a restart's
  // work, an apply's teardown), never behind another persona's, and decides
  // whether it is still wanted when it starts, not when it was submitted.
  // The test holds the persona's turn with an operation of its own.
  // -------------------------------------------------------------------------

  describe('bring-up retries are serialized per persona (SR-6.6)', () => {
    /** Occupy the persona's turn until `release()`; `settled` resolves once the blocking operation has. */
    function blockPersona(f: BringUpFixture, persona: Persona): { release: () => void; settled: Promise<void> } {
      const gate = Promise.withResolvers<void>()
      return { release: () => gate.resolve(), settled: f.serializer.run(persona.key, () => gate.promise) }
    }

    /** Whether the serializer is idle for the persona, after pending continuations ran. */
    async function idleFor(f: BringUpFixture, persona: Persona): Promise<boolean> {
      let idle = false
      void f.serializer.whenIdle(persona.key).then(() => { idle = true })
      await f.h.clock.flush()
      return idle
    }

    const statsOf = (f: BringUpFixture, persona: Persona) =>
      f.directoryStats.filter(([path]) => path === persona.working_directory).map(([, at]) => at)

    test('a directory re-check for A that falls due while an operation for A runs waits for it: nothing is stat\'ed, connected or launched until it settles; B\'s re-check is not held up', async () => {
      const f = makeBringUpFixture()
      const [a, b] = f.personas as [Persona, Persona]
      for (const persona of [a, b]) breakDirectory(persona.working_directory, 'missing')
      await bringUpEach(f)
      for (const persona of [a, b]) repairDirectory(persona.working_directory)
      const blocker = blockPersona(f, a)

      await f.h.clock.advance(5_000)

      expect([statsOf(f, a), statsOf(f, b)]).toEqual([[0], [0, 5_000]])
      expect(f.h.slack.buildsOf(a.key)).toEqual([])
      expect(f.controller.state(a.key)?.outcome).toBe('retrying')
      expect(f.controller.state(b.key)).toEqual({ outcome: 'up', causes: {} })
      expect(f.launches).toEqual([b.key])
      await expectServes(f, b)

      blocker.release()
      await blocker.settled
      await f.h.clock.flush()

      expect(statsOf(f, a)).toEqual([0, 5_000])
      expect(f.controller.state(a.key)).toEqual({ outcome: 'up', causes: {} })
      expect(f.launches).toEqual([b.key, a.key])
      expect(f.h.clock.pendingCount()).toBe(0)
      await expectServes(f, a)
      assertNoLeak(f.captured())
    })

    test('a directory re-check holds A\'s turn through the launch it triggers: an operation for A submitted meanwhile starts only once that launch settled', async () => {
      const launchGate = Promise.withResolvers<void>()
      const f = makeBringUpFixture({ launch: persona => (persona.name === OUTCOME_A ? launchGate.promise : Promise.resolve()) })
      const [a, b] = f.personas as [Persona, Persona]
      breakDirectory(a.working_directory, 'missing')
      await bringUpEach(f)
      repairDirectory(a.working_directory)

      await f.h.clock.advance(5_000)
      expect(f.launches).toEqual([a.key])
      const order: string[] = []
      const next = f.serializer.run(a.key, () => void order.push('next operation for A'))
      await f.h.clock.flush()
      expect(order).toEqual([])
      expect(await idleFor(f, a)).toBe(false)
      expect(await idleFor(f, b)).toBe(true)

      launchGate.resolve()
      await next

      expect(order).toEqual(['next operation for A'])
      expect(await idleFor(f, a)).toBe(true)
      assertNoLeak(f.captured())
    })

    test('a launch after A\'s Slack retry waits behind an operation for A and runs once it settles; B\'s launch after its own Slack retry is not held up', async () => {
      const f = makeBringUpFixture({
        slack: { [OUTCOME_A]: { authTest: [{ kind: 'network' }] }, [OUTCOME_B]: { authTest: [{ kind: 'network' }] } },
      })
      const [a, b] = f.personas as [Persona, Persona]
      await bringUpEach(f)
      const blocker = blockPersona(f, a)

      await f.h.clock.advance(5_000)

      for (const persona of [a, b]) expect(f.h.manager.status(persona.key)).toMatchObject({ state: 'up' })
      expect(f.launches).toEqual([b.key])
      expect(linesOf(f, a).filter(line => line.includes('up after its bring-up retry'))).toEqual([])

      blocker.release()
      await blocker.settled
      await f.h.clock.flush()

      expect(f.launches).toEqual([b.key, a.key])
      expect(linesOf(f, a).filter(line => line.includes('up after its bring-up retry (Slack) — launching'))).toHaveLength(1)
      await f.h.clock.advance(HOUR_MS)
      expect(f.launches).toEqual([b.key, a.key])
      await expectServes(f, a)
      await expectServes(f, b)
      assertNoLeak(f.captured())
    })

    // Rows: what changes while A's launch after its Slack retry is queued behind the operation
    // for A; A's launches once it ran; its retry lines. The launch checks when it starts, so
    // nothing, or only the first launch, happens.
    test.each<[string, (f: BringUpFixture, a: Persona, b: Persona) => void, number, string[]]>([
      ['A is cancelled (its teardown began)', (f, a) => f.controller.cancel(a.key), 0, []],
      ['A leaves the applied set (a confirmed apply\'s step 1)', (f, _a, b) => f.setApplied([b]), 0, [
        'up after its bring-up retry (Slack) but no longer applied — not launching',
      ]],
      ['a second launch for A is queued (the manager\'s retrying-then-up report replayed)', (f, a) => {
        const reports = f.h.statuses.filter(([key]) => key === a.key).map(([, status]) => status)
        const retrying = reports.find(status => status.state === 'retrying')!
        const up = reports.filter(status => status.state === 'up').at(-1)!
        f.controller.onConnectionStatus(a.key, retrying)
        f.controller.onConnectionStatus(a.key, up)
      }, 1, ['up after its bring-up retry (Slack) — launching']],
    ])('a queued launch after A\'s Slack retry re-checks when it starts: %s while it waits', async (_label, meanwhile, launched, retryLines) => {
      const f = makeBringUpFixture({ slack: { [OUTCOME_A]: { authTest: [{ kind: 'network' }] } } })
      const [a, b] = f.personas as [Persona, Persona]
      await bringUpEach(f)
      const blocker = blockPersona(f, a)
      await f.h.clock.advance(5_000)
      expect(f.h.manager.status(a.key)).toMatchObject({ state: 'up' })
      expect(f.launches).toEqual([])

      meanwhile(f, a, b)
      blocker.release()
      await blocker.settled
      await f.h.clock.flush()
      expect(await idleFor(f, a)).toBe(true)

      expect(f.launches).toEqual(Array<string>(launched).fill(a.key))
      expect(linesOf(f, a).filter(line => line.includes('after its bring-up retry'))).toEqual(
        retryLines.map(line => `[slack] persona ${renderPersonaRef(a.name, a.key)}: ${line}`),
      )
      await f.h.clock.advance(HOUR_MS)
      expect(f.launches).toEqual(Array<string>(launched).fill(a.key))
      await expectServes(f, b)
      assertNoLeak(f.captured())
    })
  })

  // -------------------------------------------------------------------------
  // Cancellation (shutdown now, teardown in E12)
  // -------------------------------------------------------------------------

  describe('cancellation', () => {
    test('cancelling A while A and B both retry their directories clears only A’s timer: B keeps re-checking and comes up; A is never re-checked, connected or launched', async () => {
      const f = makeBringUpFixture()
      const [a, b] = f.personas as [Persona, Persona]
      for (const persona of [a, b]) breakDirectory(persona.working_directory, 'missing')
      await bringUpEach(f)
      expect(f.h.clock.pendingCount()).toBe(2)

      f.controller.cancel(a.key)
      f.controller.cancel(a.key)

      expect(f.h.clock.pendingCount()).toBe(1)
      expect(f.controller.state(a.key)).toBeUndefined()
      expect(f.controller.isUp(a.key)).toBe(false)
      // B's re-check at 5 s still finds its directory missing; the next, at 15 s, finds it.
      await f.h.clock.advance(5_000)
      expect(f.controller.state(b.key)?.outcome).toBe('retrying')
      for (const persona of [a, b]) repairDirectory(persona.working_directory)
      await f.h.clock.advance(10_000)

      expect(f.controller.state(b.key)).toEqual({ outcome: 'up', causes: {} })
      expect(f.launches).toEqual([b.key])
      const statsOf = (persona: Persona) => f.directoryStats.filter(([path]) => path === persona.working_directory).map(([, at]) => at)
      expect([statsOf(a), statsOf(b)]).toEqual([[0], [0, 5_000, 15_000]])
      expect(f.h.slack.buildsOf(a.key)).toEqual([])
      expect(f.h.clock.pendingCount()).toBe(0)
      await expectServes(f, b)
      assertNoLeak(f.captured())
    })

    // Rows: where A's retry is when A is cancelled; the arrangement returns the step that
    // lets the manager report A up afterwards.
    test.each<[string, (f: BringUpFixture, a: Persona) => Promise<() => Promise<unknown>>]>([
      ['its directory re-check awaits the Slack step (apps.connections.open unanswered)', async (f, a) => {
        const open = makeDeferredConnect()
        f.h.stub(a).script.connect.push(open.outcome)
        breakDirectory(a.working_directory, 'missing')
        await bringUpEach(f)
        repairDirectory(a.working_directory)
        await f.h.clock.advance(5_000)
        expect(f.h.bringUpCalls.map(call => call.key)).toEqual([f.personas[1]!.key, a.key])
        expect(f.h.manager.status(a.key)).toEqual({ state: 'connecting' })
        return async () => {
          open.settle()
          await f.h.clock.flush()
        }
      }],
      ['the manager retries its Slack bring-up', async (f, a) => {
        f.h.stub(a).script.authTest.push({ kind: 'network' })
        await bringUpEach(f)
        expect(f.h.manager.status(a.key)).toMatchObject({ state: 'retrying', phase: 'bring-up' })
        return () => f.h.clock.advance(5_000)
      }],
    ])('a persona cancelled while %s launches nothing when the manager then reports it up', async (_label, arrange) => {
      const f = makeBringUpFixture()
      const [a, b] = f.personas as [Persona, Persona]
      const reportUp = await arrange(f, a)

      f.controller.cancel(a.key)
      await reportUp()

      // The manager's own state; stopping A's connection is the caller's, not the controller's.
      expect(f.h.manager.status(a.key)).toMatchObject({ state: 'up' })
      expect(f.launches).toEqual([])
      expect(linesOf(f, a).filter(line => line.includes('up after its bring-up retry'))).toEqual([])
      expect(f.controller.state(a.key)).toBeUndefined()
      expect(f.controller.isUp(a.key)).toBe(false)
      await f.h.clock.advance(HOUR_MS)
      expect(f.launches).toEqual([])
      await expectServes(f, b)
      assertNoLeak(f.captured())
    })
  })

  // -------------------------------------------------------------------------
  // A confirmed apply (b.av2 SR-6.1, SR-6.5): the controller and manager legs
  // the lifecycle calls, driven directly. The production apply and teardown
  // (their steps, order and AC 19, AC 57, AC 64 cases) are tested in
  // tests/persona-lifecycle.test.ts and tests/reload-apply.test.ts.
  // -------------------------------------------------------------------------

  describe('a confirmed apply: an added persona\'s bring-up, and a teardown\'s cancel and stop of a queued re-check (SR-6.1, SR-6.5)', () => {
    /** A, B and C, with only A and B applied and brought up at the start; C is added later. */
    async function startWithoutC(): Promise<{ f: BringUpFixture; a: Persona; b: Persona; c: Persona }> {
      const f = makeBringUpFixture({ names: [OUTCOME_A, OUTCOME_B, OUTCOME_C] })
      const [a, b, c] = f.personas as [Persona, Persona, Persona]
      f.setApplied([a, b])
      for (const persona of [a, b]) await f.controller.bringUp(persona, [a, b])
      return { f, a, b, c }
    }

    /** Apply step 1 then step 6 for C: `added` (C's declaration) joins the applied set and is brought up against it. */
    function addC(f: BringUpFixture, a: Persona, b: Persona, added: Persona): Promise<PersonaBringUpResultSummary> {
      f.setApplied([a, b, added])
      return f.controller.bringUp(added, [a, b, added])
    }

    /** A persona's Slack activity: every Web API call, every client built, every socket start(). */
    function slackActivityOf(f: BringUpFixture, persona: Persona): { calls: number; builds: number; starts: number } {
      const stub = f.h.stub(persona)
      return {
        calls: stub.callLog.length,
        builds: f.h.slack.buildsOf(persona.key).length,
        starts: stub.sockets.reduce((sum, socket) => sum + socket.startCalls, 0),
      }
    }

    const statsOf = (f: BringUpFixture, persona: Persona) =>
      f.directoryStats.filter(([path]) => path === persona.working_directory).map(([, at]) => at)

    // Rows: C's outcome, and its arrangement (returning the declaration the apply adds). The other
    // causes are the start pass's (the E5 start table) and the apply's (tests/reload-apply.test.ts).
    test.each<[string, 'up' | 'retrying', (c: Persona, a: Persona) => Persona, PersonaDiagnosticClass[]]>([
      ['healthy', 'up', c => c, []],
      ['working directory that of the running A (a real-path collision with the applied set)', 'retrying', (c, a) => ({ ...c, working_directory: a.working_directory }), [PERSONA_DIRECTORY_UNUSABLE]],
    ])('bring-up at apply of a persona outside the start set, %s: it ends %s with the start pass\'s classes and lines, and the running personas get no Slack call', async (_label, outcome, arrange, classes) => {
      const { f, a, b, c } = await startWithoutC()
      const added = arrange(c, a)
      const running = [a, b].map(persona => slackActivityOf(f, persona))
      const linesBefore = f.h.lines.length

      const summary = await addC(f, a, b, added)

      expect(summary.outcome).toBe(outcome)
      expect(summary.failures.map(failure => failure.class)).toEqual(classes)
      expect(f.controller.state(c.key)?.outcome).toBe(outcome)
      // Its persona-start line first, then one line per cause; nothing for anyone else.
      const logged = f.h.lines.slice(linesBefore)
      expect(logged.filter(line => !line.includes(renderPersonaRef(c.name, c.key)))).toEqual([])
      expect(logged.map(classOf)).toEqual([PERSONA_START, ...classes])
      expect(logged[0]).toContain(`personas[${c.index}]`)
      // The controller launches only after a retry; the first launch is the lifecycle's.
      expect(f.launches).toEqual([])

      await f.h.clock.advance(HOUR_MS)

      // A collision persists while A runs there: C keeps retrying and is never launched.
      expect(f.controller.state(c.key)?.outcome).toBe(outcome)
      expect(f.launches).toEqual([])
      if (outcome === 'up') await expectServes(f, c)
      expect([a, b].map(persona => slackActivityOf(f, persona))).toEqual(running)
      for (const persona of [a, b]) expect(f.h.manager.status(persona.key)).toMatchObject({ state: 'up' })
      await expectServes(f, a)
      await expectServes(f, b)
      assertNoLeak(f.captured({ summary }))
    })

    test('a persona added at apply whose directory re-check falls due while a teardown holds its turn: the re-check waits, and the teardown\'s cancel and stop leave it no attempt; nothing is launched for it, A\'s own re-check still fires and B serves', async () => {
      const { f, a, b, c } = await startWithoutC()
      // A was brought up at the start; break it again and restart it the same way C comes up.
      f.controller.cancel(a.key)
      await f.h.manager.stop(a.key)
      for (const persona of [a, c]) breakDirectory(persona.working_directory, 'missing')
      expect((await f.controller.bringUp(a, [a, b])).outcome).toBe('retrying')
      expect((await addC(f, a, b, c)).outcome).toBe('retrying')
      for (const persona of [a, c]) repairDirectory(persona.working_directory)
      const cActivity = slackActivityOf(f, c)
      const cStats = statsOf(f, c)

      // The teardown holds C's turn when C's re-check falls due, so the re-check waits behind it.
      const turn = Promise.withResolvers<void>()
      const teardown = f.serializer.run(c.key, async () => {
        await turn.promise
        f.controller.cancel(c.key)
        await f.h.manager.stop(c.key)
      })
      await f.h.clock.advance(5_000)
      expect(statsOf(f, c)).toEqual(cStats)
      turn.resolve()
      await teardown
      await f.h.clock.flush()

      expect(statsOf(f, c)).toEqual(cStats)
      expect(slackActivityOf(f, c)).toEqual(cActivity)
      expect(f.controller.state(a.key)).toEqual({ outcome: 'up', causes: {} })
      expect(f.launches).toEqual([a.key])
      expect(f.controller.state(c.key)).toBeUndefined()
      expect(f.h.manager.status(c.key)).toBeUndefined()
      await f.h.clock.advance(HOUR_MS)
      expect(statsOf(f, c)).toEqual(cStats)
      expect(slackActivityOf(f, c)).toEqual(cActivity)
      expect(f.launches).toEqual([a.key])
      expect(f.h.clock.pendingCount()).toBe(0)
      await expectServes(f, a)
      await expectServes(f, b)
      assertNoLeak(f.captured())
    })
  })

  // -------------------------------------------------------------------------
  // The held credentials digest (E11, b.av2 SR-8.3): what each persona
  // connected with, is retrying with or broke with, by digest only
  // -------------------------------------------------------------------------

  describe('held credentials digest (credentialsDigest)', () => {
    /** Every persona's held digest, by key, for assertions and assertNoLeak. */
    function digestsOf(f: BringUpFixture): Record<string, string | undefined> {
      return Object.fromEntries(f.personas.map(persona => [persona.key, f.controller.credentialsDigest(persona.key)]))
    }

    /** No captured line carries a held digest's hex (or a marker as a digest would be logged). */
    function expectNoDigestLogged(f: BringUpFixture): void {
      const held = Object.values(digestsOf(f)).filter((d): d is string => d !== undefined && d.startsWith('sha256:'))
      for (const digest of held) {
        const hex = digest.slice('sha256:'.length)
        expect(f.h.lines.filter(line => line.includes(hex))).toEqual([])
      }
    }

    /** assertNoLeak over the fixture's captures, the held digests and their JSON form. */
    function expectDigestsLeakNothing(f: BringUpFixture, extra: Record<string, unknown> = {}): void {
      const digests = digestsOf(f)
      assertNoLeak(f.captured({ digests, digestsJson: JSON.stringify(digests), ...extra }), 'held credentials digests')
      expectNoDigestLogged(f)
    }

    test('an up persona holds the SHA-256 of the bytes it connected with; editing its file afterwards, or asking bringUp again, changes nothing and reads nothing', async () => {
      const f = makeBringUpFixture()
      const [a, b] = f.personas as [Persona, Persona]
      const connectedWith = { [a.key]: fileDigest(a.credentials_file), [b.key]: fileDigest(b.credentials_file) }

      const summaries = await bringUpEach(f)

      expect([...summaries.values()].map(s => s.outcome)).toEqual(['up', 'up'])
      expect(digestsOf(f)).toEqual(connectedWith)
      expect(connectedWith[a.key]).toMatch(/^sha256:[0-9a-f]{64}$/)
      expect(connectedWith[a.key]).not.toBe(connectedWith[b.key])

      editCredentials(a)
      expect((await f.controller.bringUp(a, f.personas)).outcome).toBe('up')
      await f.h.clock.advance(HOUR_MS)

      expect(fileDigest(a.credentials_file)).not.toBe(connectedWith[a.key])
      expect(digestsOf(f)).toEqual(connectedWith)
      expect(f.credentialOpens.filter(path => path === a.credentials_file)).toHaveLength(1)
      await expectServes(f, a)
      expectDigestsLeakNothing(f, { summaries: [...summaries.values()] })
    })

    test('a persona outside the applied set, or never brought up, holds nothing', async () => {
      const f = makeBringUpFixture()
      const [a, b] = f.personas as [Persona, Persona]
      await f.controller.bringUp(a, f.personas)

      expect(f.controller.credentialsDigest(a.key)).toBe(fileDigest(a.credentials_file))
      expect(f.controller.credentialsDigest(b.key)).toBeUndefined()
      expect(f.controller.credentialsDigest(personaKey('Not Applied'))).toBeUndefined()
      expectDigestsLeakNothing(f)
    })

    // Rows: why A retries; `arrange` breaks it before the bring-up, `recover` lets the next retry succeed.
    test.each<[string, (f: BringUpFixture, a: Persona) => void, (f: BringUpFixture, a: Persona) => void]>([
      ['Slack is unreachable', (f, a) => void f.h.stub(a).script.authTest.push(...Array<WebApiOutcome>(5).fill({ kind: 'network' })), () => {}],
      ['its working directory is missing', (_f, a) => breakDirectory(a.working_directory, 'missing'), (_f, a) => repairDirectory(a.working_directory)],
    ])('a retrying persona (%s) holds the digest of its held content across retries after its file is edited, and still after it comes up', async (_label, arrange, recover) => {
      const f = makeBringUpFixture()
      const [a, b] = f.personas as [Persona, Persona]
      const heldContent = fileDigest(a.credentials_file)
      arrange(f, a)

      expect((await bringUpEach(f)).get(a.key)?.outcome).toBe('retrying')
      expect(f.controller.credentialsDigest(a.key)).toBe(heldContent)

      // Edit A's file twice between retries: 5 s, 10 s, 20 s, 40 s.
      for (const [i, stepMs] of [5_000, 10_000, 20_000, 40_000].entries()) {
        if (i === 0 || i === 2) editCredentials(a)
        await f.h.clock.advance(stepMs)
        expect(f.controller.state(a.key)?.outcome).toBe('retrying')
        expect(f.controller.credentialsDigest(a.key)).toBe(heldContent)
      }
      expect(fileDigest(a.credentials_file)).not.toBe(heldContent)

      recover(f, a)
      await f.h.clock.advance(HOUR_MS)

      expect(f.controller.state(a.key)).toEqual({ outcome: 'up', causes: {} })
      expect(f.launches).toEqual([a.key])
      expect(f.controller.credentialsDigest(a.key)).toBe(heldContent)
      expect(f.controller.credentialsDigest(b.key)).toBe(fileDigest(b.credentials_file))
      expect(f.credentialOpens.filter(path => path === a.credentials_file)).toHaveLength(1)
      await expectServes(f, b)
      expectDigestsLeakNothing(f)
    })

    // Rows: one per distinct held value (the missing marker, the unreadable marker, the digest of
    // invalid bytes); the reader and check tables above cover the other file shapes.
    test.each<[string, (f: BringUpFixture, a: Persona) => void, PersonaDiagnosticClass, (a: Persona) => string]>([
      ['a missing file', (_f, a) => rmSync(a.credentials_file), PERSONA_CREDENTIALS_MISSING, () => CREDENTIALS_MISSING_MARKER],
      ['a directory at the path (holds as root)', (_f, a) => {
        rmSync(a.credentials_file)
        mkdirSync(a.credentials_file)
      }, PERSONA_CREDENTIALS_UNREADABLE, () => CREDENTIALS_UNREADABLE_MARKER],
      ['bytes that are not valid UTF-8 (around the sentinel)', (_f, a) => writeFileSync(a.credentials_file, INVALID_UTF8), PERSONA_CREDENTIALS_INVALID, a => fileDigest(a.credentials_file)],
    ])('a persona broken by %s holds the value of what broke it, unchanged once the file is fixed', async (_label, arrange, cls, heldFor) => {
      const f = makeBringUpFixture()
      const [a, b] = f.personas as [Persona, Persona]
      arrange(f, a)
      const brokeWith = heldFor(a)

      const summaries = await bringUpEach(f)

      expect(summaries.get(a.key)).toEqual({ outcome: 'broken', failures: [expect.objectContaining({ step: 'credentials', class: cls })] })
      expect(summaries.get(b.key)?.outcome).toBe('up')
      expect(f.controller.credentialsDigest(a.key)).toBe(brokeWith)
      if (brokeWith === CREDENTIALS_MISSING_MARKER || brokeWith === CREDENTIALS_UNREADABLE_MARKER) {
        // A marker, never the digest of an empty file.
        expect(brokeWith).not.toBe(sha256Digest(new Uint8Array()))
      } else {
        expect(brokeWith).toMatch(/^sha256:[0-9a-f]{64}$/)
      }

      // The file is fixed: nothing re-reads it, so the held value stays what broke A.
      rmSync(a.credentials_file, { recursive: true, force: true })
      editCredentials(a)
      await f.h.clock.advance(HOUR_MS)

      expect(f.controller.state(a.key)?.outcome).toBe('broken')
      expect(f.controller.credentialsDigest(a.key)).toBe(brokeWith)
      expect(f.controller.credentialsDigest(b.key)).toBe(fileDigest(b.credentials_file))
      await expectServes(f, b)
      expectDigestsLeakNothing(f, { summaries: [...summaries.values()] })
    })

    test('personas broken by a shared credentials file (a record-start real-path collision) each hold the digest of their own path’s bytes, read once and never used to connect; a third persona holds its own (Director decision 1 reversed)', async () => {
      const f = makeBringUpFixture({ names: [OUTCOME_A, OUTCOME_B, OUTCOME_C] })
      const [a, b, c] = f.personas as [Persona, Persona, Persona]
      // B's credentials file becomes a symlink to A's: the same file by real path.
      rmSync(b.credentials_file)
      symlinkSync(a.credentials_file, b.credentials_file)
      const shared = fileDigest(a.credentials_file)
      const expected = { [a.key]: shared, [b.key]: fileDigest(b.credentials_file), [c.key]: fileDigest(c.credentials_file) }

      const summaries = await bringUpEach(f)

      for (const persona of [a, b]) {
        expect(summaries.get(persona.key)).toEqual({
          outcome: 'broken',
          failures: [expect.objectContaining({ step: 'credentials', class: PERSONA_CREDENTIALS_INVALID })],
        })
        // Hashed only: no Slack client was built with the shared file's tokens.
        expect(f.h.slack.buildsOf(persona.key)).toEqual([])
      }
      expect(summaries.get(c.key)?.outcome).toBe('up')
      expect(expected[b.key]).toBe(shared)
      expect(expected[c.key]).not.toBe(shared)
      expect(digestsOf(f)).toEqual(expected)
      expect(f.credentialOpens).toEqual([a.credentials_file, b.credentials_file, c.credentials_file])

      // A content change in the shared file: nothing re-reads it, so each keeps what it broke with.
      editCredentials(a)
      await f.h.clock.advance(HOUR_MS)
      expect(fileDigest(a.credentials_file)).not.toBe(shared)
      expect(digestsOf(f)).toEqual(expected)
      expect(f.credentialOpens).toHaveLength(3)
      await expectServes(f, c)
      expectDigestsLeakNothing(f, { summaries: [...summaries.values()] })
    })

    test('dry run (SR-3.4): no credentials file is read and every persona, up or retrying, holds nothing', async () => {
      const f = makeBringUpFixture({ dryRun: true })
      const [a, b] = f.personas as [Persona, Persona]
      f.fsOverride.openFile = () => { throw new Error('no credentials file may be opened in dry run') }
      breakDirectory(b.working_directory, 'missing')

      const summaries = await bringUpEach(f)
      expect([summaries.get(a.key)?.outcome, summaries.get(b.key)?.outcome]).toEqual(['up', 'retrying'])
      repairDirectory(b.working_directory)
      await f.h.clock.advance(5_000)

      expect(f.controller.state(b.key)).toEqual({ outcome: 'up', causes: {} })
      expect(digestsOf(f)).toEqual({ [a.key]: undefined, [b.key]: undefined })
      expect(f.credentialOpens).toEqual([])
      expect(f.h.slack.builds).toEqual([])
      expectDigestsLeakNothing(f, { summaries: [...summaries.values()] })
    })

    test('cancelling a persona forgets its digest; a fresh bring-up afterwards reads the file as it now stands and holds that', async () => {
      const f = makeBringUpFixture()
      const [a, b] = f.personas as [Persona, Persona]
      const original = readFileSync(a.credentials_file)
      rmSync(a.credentials_file)
      await bringUpEach(f)
      expect(f.controller.credentialsDigest(a.key)).toBe(CREDENTIALS_MISSING_MARKER)

      f.controller.cancel(a.key)
      expect(f.controller.credentialsDigest(a.key)).toBeUndefined()
      expect(f.controller.credentialsDigest(b.key)).toBe(fileDigest(b.credentials_file))

      // The file is back (with the tokens A's stub knows).
      writeFileSync(a.credentials_file, original)
      expect((await f.controller.bringUp(a, f.personas)).outcome).toBe('up')

      expect(f.controller.credentialsDigest(a.key)).toBe(sha256Digest(original))
      expect(f.credentialOpens.filter(path => path === a.credentials_file)).toHaveLength(2)
      await expectServes(f, a)
      expectDigestsLeakNothing(f)
    })
  })

  describe('a confirmed credentials change while a Web API call refuses the running persona (changeCredentials, bug b.ujn)', () => {
    // Rows: label, whether a Web API call refuses A's current connection while the reconnect's first
    // attempt waits at its Socket Mode open, how that open then settles, and what changeCredentials
    // resolves with. The controls show `cameBackUp` and `connection: 'broken'` only follow the refusal.
    test.each<[string, boolean, SettledConnectOutcome, PersonaCredentialsChangeResult]>([
      ['refused meanwhile, then the new connection opens: swapped, cameBackUp', true, { kind: 'ok' }, { kind: 'swapped', cameBackUp: true }],
      ['refused meanwhile, then the new connection is unreachable: retrying, connection broken', true, { kind: 'network' }, { kind: 'retrying', connection: 'broken' }],
      ['still up, then the new connection opens (control): swapped', false, { kind: 'ok' }, { kind: 'swapped' }],
      ['still up, then the new connection is unreachable (control): retrying, connection kept', false, { kind: 'network' }, { kind: 'retrying', connection: 'kept' }],
    ])('%s; the swap (at once or on the 5 s retry) reports wasUp, and only a persona that came back up is launched', async (_label, refuse, settleWith, expected) => {
      const f = makeBringUpFixture()
      const [a, b] = f.personas as [Persona, Persona]
      await bringUpEach(f)
      const edited = editCredentials(a)
      const hello = makeDeferredConnect()
      const fresh = f.h.slack.addCredentials(a.key, 'edited', edited, { leakMarker: LEAK_SENTINEL, connect: [hello.outcome] })
      const hookCalls: string[] = []
      const swaps: CredentialsSwap[] = []
      const change = f.controller.changeCredentials(a, f.personas, f.h.manager, {
        beforeSwap: () => void hookCalls.push(`beforeSwap while ${f.controller.state(a.key)?.outcome}`),
        onSwapped: swap => void swaps.push(swap),
      })
      await f.h.clock.flush()
      expect(fresh.socket.startCalls).toBe(1)
      if (refuse) {
        f.h.stub(a).script.post.push({ kind: 'platform', error: 'token_revoked' })
        await rejectionOf(f.h.manager.webClient(a.key)!.chat.postMessage({ channel: WATCH_CHANNEL, text: 'revoked' }))
        expect(f.controller.state(a.key)?.outcome).toBe('broken')
      }

      hello.settle(settleWith)
      const result = await change
      await f.h.clock.flush()

      expect(result).toStrictEqual(expected)
      const wasUp = !refuse
      const swapHook = `beforeSwap while ${refuse ? 'broken' : 'up'}`
      if (expected.kind === 'retrying') {
        // A keeps its state (up on its old connection, or broken) while the new one retries.
        expect(swaps).toEqual([])
        expect(hookCalls).toEqual([])
        expect(f.controller.state(a.key)?.outcome).toBe(refuse ? 'broken' : 'up')
        await f.h.clock.advance(5_000)
      }
      expect(hookCalls).toEqual([swapHook])
      expect(swaps).toEqual([{ late: expected.kind === 'retrying', wasUp }])
      expect(f.controller.state(a.key)).toEqual({ outcome: 'up', causes: {} })
      expect(f.h.manager.identity(a.key)).toEqual({ botUserId: fresh.identity.botUserId, botId: fresh.identity.botId })
      expect(f.controller.credentialsDigest(a.key)).toBe(fileDigest(a.credentials_file))
      await f.h.clock.flush()
      expect(f.launches).toEqual(refuse ? [a.key] : [])
      // A's lines: the refusal opens and the swap clears its episode; the new connection's unreachable
      // episode opens and clears; no change-failed line; the launch line only when A came back up.
      const unreachable = expected.kind === 'retrying' ? [PERSONA_SLACK_UNREACHABLE, PERSONA_SLACK_UNREACHABLE] : []
      expect(linesOf(f, a).map(classOf)).toEqual(
        refuse
          ? [PERSONA_START, PERSONA_CREDENTIALS_REFUSED, ...unreachable, PERSONA_CREDENTIALS_REFUSED, undefined]
          : [PERSONA_START, ...unreachable],
      )
      if (refuse) {
        expect(linesOf(f, a).at(-1)).toBe(`[slack] persona ${renderPersonaRef(a.name, a.key)}: up after its confirmed credentials change — launching`)
      }
      const text = `on the new connection of ${a.key}`
      await fresh.socket.deliver(makeChannelMessage({ text }))
      expect(f.events.filter(e => e.text === text).map(e => e.key)).toEqual([a.key])
      await expectServes(f, b)
      expect(f.h.clock.pendingCount()).toBe(0)
      assertNoLeak(f.captured({ result, swaps, hookCalls }))
    })
  })
})
