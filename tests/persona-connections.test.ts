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
 * clause a case named "AC 5: …"), plus the connection legs of AC 20, AC 23/24
 * and AC 47. Time is a fake clock throughout; nothing sleeps.
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
import { checkPersonaCredentials, type CredentialsFs, type PersonaSlackTokens } from '../src/persona-credentials.ts'
import {
  createPersonaConnectionManager,
  dryRunPersonaIdentity,
  type PersonaConnectionManager,
  type PersonaConnectionStatus,
  type PersonaEventHandler,
  type PersonaSocketEventName,
  type PersonaSocketEventPayload,
} from '../src/persona-connections.ts'
import { createUnhandledRejectionHandler, slackPlatformReason } from '../src/persona-connection-errors.ts'
import {
  checkPersonaLocalBringUp,
  checkPersonaWorkingDirectory,
  type BringUpPersona,
  type OtherBringUpPersona,
  type WorkingDirectoryFs,
} from '../src/persona-bringup.ts'
import {
  PERSONA_CONNECTION_LOST,
  PERSONA_CONNECTION_RESTORED,
  PERSONA_CREDENTIALS_INVALID,
  PERSONA_CREDENTIALS_MISSING,
  PERSONA_CREDENTIALS_REFUSED,
  PERSONA_CREDENTIALS_UNREADABLE,
  PERSONA_DIAGNOSTIC_CLASSES,
  PERSONA_SLACK_UNREACHABLE,
  PERSONA_DIRECTORY_MISSING,
  PERSONA_DIRECTORY_UNUSABLE,
  formatPersonaDiagnostic,
  personaCheckFailure,
  type PersonaCheckFailure,
  type PersonaDiagnosticClass,
} from '../src/persona-diagnostics.ts'
import { personaKey, renderPersonaRef } from '../src/persona-identity.ts'
import {
  SlackStartTimeoutError,
  botIdentityFromAuthTest,
  classifySlackValidationError,
  type SlackValidationCheck,
  type SlackValidationFailure,
  type SlackValidationOutcome,
} from '../src/persona-slack-validation.ts'
import { MAX_TIMER_DELAY_MS, createPersonaRetrySchedule } from '../src/persona-retry-schedule.ts'
import { createSlackEpisodeTracker, type SlackEpisodeTracker } from '../src/persona-slack-episodes.ts'
import {
  APP_TOKEN_PREFIX,
  BOT_TOKEN_PREFIX,
  LEAK_SENTINEL,
  assertNoLeak,
  fakeToken,
  writeCredentialsFile,
  type CredentialsOverrides,
} from './test-helpers/credentials.ts'
import {
  makeAppMention,
  makeChannelMessage,
  makeDeferredConnect,
  makeStubSlack,
  makeStubSlackFactory,
  mentionText,
  type ConnectOutcome,
  type SettledConnectOutcome,
  type StubClientKind,
  type StubSlack,
  type StubSlackFactory,
  type WebApiOutcome,
} from './test-helpers/slack-stub.ts'
import { createFakeClock, type FakeClock } from './test-helpers/fake-clock.ts'
import { makeStubClient, type StubClientOptions } from './test-helpers/agent-director-stub.ts'

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

  test.each<[string, (persona: BringUpPersona) => Partial<CredentialsFs> | undefined, string]>([
    ['the path is a directory', persona => void mkdirSync(persona.credentials_file, { recursive: true }), 'is a directory'],
    ['reading is denied with EACCES (injected fs)', () => ({ readFile: failsWith('EACCES') }), 'permission denied'],
    ['reading is denied with EPERM (injected fs)', () => ({ readFile: failsWith('EPERM') }), 'permission denied'],
    ['reading fails with another error, EIO (injected fs)', () => ({ readFile: failsWith('EIO') }), 'cannot be read (EIO)'],
  ])('persona-credentials-unreadable when %s', (_label, arrange, causeFragment) => {
    const persona = makePersona()
    const fs = arrange(persona)
    if (fs !== undefined) writeCreds(persona)
    const { lines, log } = capture()

    const result = checkPersonaCredentials(persona, { others: [], fs, log })

    expect(expectFailure(result, PERSONA_CREDENTIALS_UNREADABLE, lines).cause).toContain(causeFragment)
  })

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
      fs: { readFile: failsWith('EACCES'), access: accessDenying(fsConstants.X_OK) },
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
  test('the label set is exactly the nine credentials, Slack-validation, connection and directory classes', () => {
    expect([...PERSONA_DIAGNOSTIC_CLASSES].sort()).toEqual([
      'persona-connection-lost',
      'persona-connection-restored',
      'persona-credentials-invalid',
      'persona-credentials-missing',
      'persona-credentials-refused',
      'persona-credentials-unreadable',
      'persona-directory-missing',
      'persona-directory-unusable',
      'persona-slack-unreachable',
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
      persona => checkPersonaCredentials(persona, { others: [], fs: { readFile: failsWith('EACCES') } }),
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

/** One validation leg: `auth.test` checks the bot token, the Socket Mode open the app token. */
type Leg = SlackValidationCheck

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
  return typeof thrown === 'object' && thrown !== null && !(thrown instanceof SlackStartTimeoutError)
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
  const calls = {
    versionCalls: [], makeTemplateCalls: [], spawnCalls: [], statusCalls: [], getCalls: [], sendKeysCalls: [],
    readPaneCalls: [], killCalls: [], decideCalls: [], resumeCalls: [], findMissingCalls: [], deleteCalls: [],
    listCalls: [], pauseCalls: [], getPermissionCalls: [], callLog: [],
  } satisfies StubClientOptions
  makeStubClient(calls)
  return { callCount: () => Object.values(calls).reduce((sum, list: unknown[]) => sum + list.length, 0) }
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
    onStatus: (key, status) => void statuses.push([key, status]),
    onEvent: (key, eventName, payload) => {
      events.push({ key, eventName, payload })
      return opts.onEvent?.(key, eventName, payload)
    },
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

/** Deliver a uniquely-texted message on the persona's latest socket; it must reach the handler exactly once, tagged with that persona. */
async function expectDelivers(h: Harness, p: ManagedPersona): Promise<void> {
  const text = `delivery ${++deliverySeq} on ${p.key}`
  await stubOf(h, p).socket.deliver(makeChannelMessage({ text }))
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

const CONNECTION_MODULES = ['persona-connections.ts', 'persona-slack-clients.ts', 'persona-connection-errors.ts']

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

    await h.manager.stop(h.a.key)
    await h.manager.stop(h.a.key)

    expect(h.clock.pendingCount()).toBe(0)
    expect(stubOf(h, h.a).socket.lifecycle.includes('disconnected')).toBe(emitsDisconnected)
    await h.clock.advance(HOUR_MS)
    expect(startsOf(h, h.a)).toBe(starts)
    expect(liveSocketsOf(h, h.a)).toBe(0)
    expect(h.manager.status(h.a.key)).toBeUndefined()
    expect(h.manager.webClient(h.a.key)).toBeUndefined()
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

  test('a credentials error on reopen leaves A disconnected and credentials-broken: no further start() however far the clock runs, B unaffected, no agent-director call', async () => {
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
    expect(h.agentDirector.callCount()).toBe(0)
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
// Late settlement of an abandoned start() (SR-3.1, SR-3.3)
// ---------------------------------------------------------------------------

describe('connection manager: late settlement of an abandoned start()', () => {
  test.each<['bring-up' | 'reopen', string, SettledConnectOutcome]>([
    ['bring-up', 'resolves', { kind: 'ok' }],
    ['bring-up', 'rejects', { kind: 'network' }],
    ['reopen', 'resolves', { kind: 'ok' }],
    ['reopen', 'rejects', { kind: 'network' }],
  ])('an abandoned %s start() that %s after the 10 s bound does not mark A up, forwards nothing and adds no attempt; B keeps delivering', async (phase, _settles, late) => {
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
    const abandoned = a.socket
    await h.clock.advance(10_000)
    if (bringUpA !== undefined) await bringUpA
    expect(abandoned.disconnectCalls).toBe(1)
    expect(h.manager.status(h.a.key)).toMatchObject({ state: 'retrying', phase, outcome: { reason: 'timeout' } })
    await expectDelivers(h, h.b)
    const starts = startsOf(h, h.a)
    const reported = h.statuses.length
    // Should the late socket open, deliver on it while it is connected: nothing may reach the handler.
    const lateText = 'from the abandoned socket'
    const lateDeliveries: Promise<void>[] = []
    abandoned.on('connected', () => void lateDeliveries.push(abandoned.deliver(makeChannelMessage({ text: lateText }))))

    deferred.settle(late)
    await h.clock.flush()
    await Promise.all(lateDeliveries)

    expect(lateDeliveries).toHaveLength(late.kind === 'ok' ? 1 : 0)
    expect(h.events.filter(e => e.payload.event?.text === lateText)).toEqual([])
    expect(abandoned.disconnectCalls).toBe(late.kind === 'ok' ? 2 : 1)
    expect(liveSocketsOf(h, h.a)).toBe(0)
    expect(h.statuses).toHaveLength(reported)
    expect(startsOf(h, h.a)).toBe(starts)
    expect(pendingDelays(h)).toEqual([5_000])
    await expectDelivers(h, h.b)

    await h.clock.advance(5_000)
    expect(h.manager.status(h.a.key)).toMatchObject({ state: 'up' })
    expect(liveSocketsOf(h, h.a)).toBe(1)
    await expectDelivers(h, h.a)
    const recovered = startsOf(h, h.a)
    await h.clock.advance(HOUR_MS)
    expect(startsOf(h, h.a)).toBe(recovered)
  })
})

// ---------------------------------------------------------------------------
// Bring-up connection legs of AC 23/24
// ---------------------------------------------------------------------------

describe('connection manager: bring-up connection legs of AC 23/24', () => {
  // Rows: label, A's connect outcome, when apps.connections.open answers (0: at once), when the
  // manager abandons it (0: it fails at once), and the outcome's reason. The 10 s bound restarts
  // when the WebSocket phase begins, so a slow open is abandoned 10 s after it answered.
  test.each<[string, SettledConnectOutcome, number, number, string]>([
    ['the socket closes before hello', { kind: 'closed-before-hello' }, 0, 0, 'socket-closed'],
    ['start() never settles: apps.connections.open never answers', { kind: 'open-never-answers' }, 0, 10_000, 'timeout'],
    ['start() never settles: the WebSocket never reaches hello', { kind: 'never' }, 0, 10_000, 'timeout'],
    ['start() never settles: apps.connections.open answers after 9 s, then the WebSocket never reaches hello', { kind: 'never' }, 9_000, 19_000, 'timeout'],
  ])('%s: A is Slack-unreachable and retrying, never credentials-broken, while B comes up and delivers', async (_label, connect, openAnswersAfterMs, abandonAtMs, reason) => {
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
