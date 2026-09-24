/**
 * persona-connections.test.ts — persona credentials file and bring-up
 * pre-checks.
 *
 * Covers b.av2 SR-1.4 (credentials-file reader and local validity), SR-6.1
 * steps 1 and 2 as pure checks (credentials check, working-directory check,
 * both causes reported), SR-10.3 (credentials and directory class labels and
 * the diagnostic line) and ENG-2 (a success value never prints a token).
 * Later E2 Tasks extend this file with the supervised-connection cases.
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
import { checkPersonaCredentials, type CredentialsFs } from '../src/persona-credentials.ts'
import {
  checkPersonaLocalBringUp,
  checkPersonaWorkingDirectory,
  type BringUpPersona,
  type OtherBringUpPersona,
  type WorkingDirectoryFs,
} from '../src/persona-bringup.ts'
import {
  PERSONA_CREDENTIALS_INVALID,
  PERSONA_CREDENTIALS_MISSING,
  PERSONA_CREDENTIALS_UNREADABLE,
  PERSONA_DIAGNOSTIC_CLASSES,
  PERSONA_DIRECTORY_MISSING,
  PERSONA_DIRECTORY_UNUSABLE,
  formatPersonaDiagnostic,
  personaCheckFailure,
  type PersonaCheckFailure,
  type PersonaDiagnosticClass,
} from '../src/persona-diagnostics.ts'
import { personaKey, renderPersonaRef } from '../src/persona-identity.ts'
import {
  APP_TOKEN_PREFIX,
  BOT_TOKEN_PREFIX,
  LEAK_SENTINEL,
  assertNoLeak,
  fakeToken,
  writeCredentialsFile,
  type CredentialsOverrides,
} from './test-helpers/credentials.ts'

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
    for (const module of ['persona-credentials.ts', 'persona-bringup.ts', 'persona-diagnostics.ts']) {
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
  test('the label set is exactly the five credentials and directory classes', () => {
    expect([...PERSONA_DIAGNOSTIC_CLASSES].sort()).toEqual([
      'persona-credentials-invalid',
      'persona-credentials-missing',
      'persona-credentials-unreadable',
      'persona-directory-missing',
      'persona-directory-unusable',
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
    const spies = (['error', 'warn', 'log', 'info', 'debug'] as const).map(method =>
      spyOn(console, method).mockImplementation(() => {}),
    )
    spies.push(spyOn(process.stderr, 'write').mockImplementation(() => true))
    let results: unknown[]
    // Counted before mockRestore, which clears a spy's recorded calls; counts,
    // not calls, so a failure never prints what was emitted.
    let callCounts: number[]
    try {
      results = [
        checkPersonaCredentials(persona, { others: [] }),
        checkPersonaWorkingDirectory(persona, { others: [] }),
        checkPersonaLocalBringUp(persona, { others: [] }),
        personaCheckFailure({ class: PERSONA_DIRECTORY_MISSING, name: 'Alpha', key: 'alpha', index: 0, cause: 'x' }),
      ]
    } finally {
      callCounts = spies.map(spy => spy.mock.calls.length)
      for (const spy of spies) spy.mockRestore()
    }

    expect(callCounts).toEqual(spies.map(() => 0))
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
