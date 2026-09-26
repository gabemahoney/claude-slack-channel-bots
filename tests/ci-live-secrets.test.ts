/**
 * ci-live-secrets.test.ts — Tests for the /ci-live runner's host-side
 * secrets and state (bug b.1cx): the mode checks and private writes in
 * `ci-live/lib/secrets.ts`, the `SecretStore` (config token, password,
 * live.json, credentials files) with its dry-run guard, the config-dir layout
 * in `lib/paths.ts`, and `apps.json` in `lib/apps-state.ts`.
 *
 * The rules under test:
 * - a secret file or its directory that is group- or other-accessible stops
 *   the run (NotRunnableError naming the path, never a value), with the
 *   `chmod` that fixes it and the note that a VM reboot can loosen modes;
 *   before a real run every loose path is reported at once, the personas'
 *   credentials files included, and the runner changes no mode itself;
 * - a missing or empty secret file is a `MissingSecretError` (the apps stage
 *   can go on without the configuration token);
 * - a secret is written only as a mode-600 temp file in a mode-700 directory,
 *   renamed over the target, so the target never exists with a wider mode;
 * - every value read or written is registered with the redactor, the second
 *   workspace user's password included (its variable, else its mode-600 file),
 *   and the test mailbox's password and token (mailbox.json, which is
 *   optional, rewritten mode 600 with a fresh token, and part of the layout's
 *   privacy check);
 * - a dry run reads nothing under the real config dir: the store refuses any
 *   access there (a name that only starts with `..` is inside it), and its
 *   mailbox.json is the stub's, in the temporary dir;
 * - apps.json keeps a pending-create intent only with an ISO start time; a
 *   file that is there but is no JSON object is not runnable, never read as
 *   empty (only a missing one loads empty).
 *
 * Every file operation goes through the in-memory `memSecureFs`, except one
 * round trip on the real file system in a mkdtempSync directory. Tokens are
 * sentinel-bearing fakes; captured errors and files are leak-checked.
 *
 * SPDX-License-Identifier: MIT
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, readdirSync, rmSync, statSync, chmodSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { AppsStateFile, emptyAppsState, MalformedAppsStateError, parseAppsState, recordedAppIds, serializeAppsState } from '../ci-live/lib/apps-state.ts'
import { parseMailboxFile, type MailboxConfig } from '../ci-live/lib/mailbox.ts'
import { dryRunLockFile, hostCredentialsFile, livePathsIn, mountedCredentialsFile, realRunLockFile, resolveConfigDir } from '../ci-live/lib/paths.ts'
import { Redactor, REDACTED_SECRET } from '../ci-live/lib/redact.ts'
import {
  assertPrivate,
  DryRunSecretAccessError,
  ensurePrivateDir,
  isInside,
  LOOSE_MODES_NOTE,
  MissingSecretError,
  nodeSecureFs,
  NotRunnableError,
  privacyProblem,
  readPrivateFile,
  SecretStore,
  SignInCodeNeededError,
  writePrivateFile,
  type SecureFs,
} from '../ci-live/lib/secrets.ts'
import { memSecureFs, type MemSecureFs } from './test-helpers/ci-live.ts'
import { APP_TOKEN_PREFIX, assertNoLeak, BOT_TOKEN_PREFIX, fakeToken, LEAK_SENTINEL } from './test-helpers/credentials.ts'

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const CONFIG_DIR = '/home/tester/.config/cscb-test'
const REAL_DIR = '/home/tester/real/.config/cscb-test'
const CONFIG_TOKEN = fakeToken(`${BOT_TOKEN_PREFIX.slice(0, 3)}e.`, 'config')
const REFRESH_TOKEN = fakeToken(BOT_TOKEN_PREFIX.replace('b', 'e'), 'refresh')
const PASSWORD = `pw-${LEAK_SENTINEL}`
const EMAIL = 'test-human@example.invalid'

function creds(suffix = '') {
  return { bot_token: fakeToken(BOT_TOKEN_PREFIX, `bot${suffix}`), app_token: fakeToken(APP_TOKEN_PREFIX, `app${suffix}`) }
}

/** The test mailbox's config, its password and token sentinel-bearing fakes. */
function mailboxConfig(overrides: Partial<MailboxConfig> = {}): MailboxConfig {
  return { api: 'https://api.mail.tm', address: 'cscb-test@mailbox.invalid', password: `mailpw-${LEAK_SENTINEL}`, accountId: 'acct0001', token: `mailtoken-${LEAK_SENTINEL}`, extra: {}, ...overrides }
}

interface StoreHarness {
  mem: MemSecureFs
  store: SecretStore
  redactor: Redactor
  paths: ReturnType<typeof livePathsIn>
}

function makeStore(options: { env?: Record<string, string | undefined>; dryRun?: boolean; configDir?: string; mem?: MemSecureFs } = {}): StoreHarness {
  const mem = options.mem ?? memSecureFs()
  const redactor = new Redactor()
  const paths = livePathsIn(options.configDir ?? CONFIG_DIR)
  const store = new SecretStore({
    fs: mem.fs,
    paths,
    env: options.env ?? {},
    redactor,
    dryRun: options.dryRun ?? false,
    realConfigDir: REAL_DIR,
  })
  return { mem, store, redactor, paths }
}

/** A loose mode's refusal after the path: the mode, the chmod that fixes it and why modes can be loose. */
function looseRule(mode: string, chmod: string): string {
  return `is group- or other-accessible (mode ${mode}): run chmod ${chmod} (${LOOSE_MODES_NOTE})`
}

/** Run `fn` and return what it threw (failing when it returns). */
function thrown(fn: () => unknown): Error {
  try {
    fn()
  } catch (err) {
    return err as Error
  }
  throw new Error('expected a throw')
}

// ---------------------------------------------------------------------------
// Mode checks
// ---------------------------------------------------------------------------

describe('privacyProblem', () => {
  const file = (mode: number) => ({ mode, size: 1, isFile: true, isDirectory: false })
  const dir = (mode: number) => ({ mode, size: 0, isFile: false, isDirectory: true })

  test.each([
    ['a 600 file', file(0o600), 'file', undefined, null],
    ['a 400 file', file(0o400), 'file', undefined, null],
    ['a 700 dir', dir(0o700), 'dir', undefined, null],
    ['a 640 file, no path given', file(0o640), 'file', undefined, looseRule('640', '600 on it')],
    ['a 604 file', file(0o604), 'file', '/cfg/slack_config_token', looseRule('604', '600 /cfg/slack_config_token')],
    ['a 755 dir', dir(0o755), 'dir', '/cfg', looseRule('755', '700 /cfg')],
    ['a setgid 2770 dir, as a VM reboot leaves it', dir(0o2770), 'dir', '/cfg', looseRule('2770', '700 /cfg')],
    ['a path the shell would split, single-quoted', file(0o660), 'file', "/cfg/it's mine", looseRule('660', "600 '/cfg/it'\\''s mine'")],
    ['a dir where a file is wanted', dir(0o700), 'file', undefined, 'is not a regular file'],
    ['a file where a dir is wanted', file(0o600), 'dir', undefined, 'is not a directory'],
  ] as const)('%s', (_what, st, kind, path, expected) => {
    expect(privacyProblem(st, kind, path)).toBe(expected)
  })

  test('a loose mode says a VM reboot can loosen modes, and that the runner never changes one itself', () => {
    expect(LOOSE_MODES_NOTE).toBe('a VM reboot can loosen these modes, as the pod re-applies its group to the files at boot; the runner never changes them itself')
  })
})

describe('assertPrivate, ensurePrivateDir and readPrivateFile', () => {
  test('refuse a missing path, a wide file and a wide directory with a NotRunnableError naming the path, never the content', () => {
    const mem = memSecureFs()
    mem.seed('/d/secret', PASSWORD, 0o644)
    mem.seed('/wide/secret', PASSWORD, 0o600, 0o750)
    const errors = [
      thrown(() => assertPrivate(mem.fs, '/d/missing', 'file')),
      thrown(() => readPrivateFile(mem.fs, '/d/secret')),
      thrown(() => readPrivateFile(mem.fs, '/wide/secret')),
      thrown(() => ensurePrivateDir(mem.fs, '/wide')),
    ]
    expect(errors.every((e) => e instanceof NotRunnableError)).toBe(true)
    expect(errors.map((e) => e.message)).toEqual([
      '/d/missing does not exist',
      `/d/secret ${looseRule('644', '600 /d/secret')}`,
      `/wide ${looseRule('750', '700 /wide')}`,
      `/wide ${looseRule('750', '700 /wide')}`,
    ])
    expect(mem.reads).toEqual([])
    assertNoLeak(errors)
  })

  test('ensurePrivateDir creates a missing directory with mode 700', () => {
    const mem = memSecureFs()
    ensurePrivateDir(mem.fs, '/cfg/credentials')
    expect(mem.dirs.get('/cfg/credentials')).toBe(0o700)
    expect(mem.ops.slice(1)).toEqual(['mkdir /cfg/credentials 700', 'chmod /cfg/credentials 700'])
  })
})

describe('writePrivateFile', () => {
  test('writes a mode-600 temp file in the same directory, sets its mode, then renames it over the target', () => {
    const mem = memSecureFs()
    mem.seed('/cfg/old', 'x')
    writePrivateFile(mem.fs, '/cfg/secret', PASSWORD)
    const writes = mem.ops.filter((op) => !op.startsWith('stat '))
    expect(writes.length).toBe(3)
    const [write, chmod, rename] = writes as [string, string, string]
    const tmp = write.split(' ')[1]!
    expect(tmp.startsWith('/cfg/.secret.tmp-')).toBe(true)
    expect([write, chmod, rename]).toEqual([`writeFile ${tmp} 600`, `chmod ${tmp} 600`, `rename ${tmp} /cfg/secret`])
    expect(mem.files.get('/cfg/secret')).toEqual({ data: PASSWORD, mode: 0o600 })
    expect([...mem.files.keys()].sort()).toEqual(['/cfg/old', '/cfg/secret'])
  })

  test.each(['writeFile', 'chmod', 'rename'] as const)('removes the temp file and rethrows when %s fails, leaving the target untouched', (op) => {
    const mem = memSecureFs()
    mem.seed('/cfg/secret', 'previous')
    mem.failNext(op)
    expect(() => writePrivateFile(mem.fs, '/cfg/secret', PASSWORD)).toThrow('EIO')
    expect(mem.files.get('/cfg/secret')).toEqual({ data: 'previous', mode: 0o600 })
    expect([...mem.files.keys()]).toEqual(['/cfg/secret'])
  })

  test('refuses to write into a directory that is not private', () => {
    const mem = memSecureFs()
    mem.seed('/cfg/x', 'x', 0o600, 0o755)
    expect(() => writePrivateFile(mem.fs, '/cfg/secret', PASSWORD)).toThrow(NotRunnableError)
    expect(mem.files.has('/cfg/secret')).toBe(false)
  })

  describe('on the real file system', () => {
    let dir: string
    beforeEach(() => {
      dir = mkdtempSync(join(tmpdir(), 'ci-live-secrets-'))
    })
    afterEach(() => {
      rmSync(dir, { recursive: true, force: true })
    })

    test('creates the directory 700 and the file 600, leaves no temp file, and refuses a wide directory', () => {
      const path = join(dir, 'config', 'credentials', 'persona_a-credentials.json')
      writePrivateFile(nodeSecureFs, path, JSON.stringify(creds()))
      writePrivateFile(nodeSecureFs, path, JSON.stringify(creds('2')))
      expect(statSync(join(dir, 'config', 'credentials')).mode & 0o777).toBe(0o700)
      expect(statSync(path).mode & 0o777).toBe(0o600)
      expect(readdirSync(join(dir, 'config', 'credentials'))).toEqual(['persona_a-credentials.json'])
      mkdirSync(join(dir, 'shared'))
      chmodSync(join(dir, 'shared'), 0o755)
      expect(() => writePrivateFile(nodeSecureFs, join(dir, 'shared', 'x'), PASSWORD)).toThrow(NotRunnableError)
      expect(readdirSync(join(dir, 'shared'))).toEqual([])
    })
  })
})

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

describe('config dir layout', () => {
  test.each([
    [{}, '/h/.config/cscb-test'],
    [{ CSCB_LIVE_CONFIG_DIR: '' }, '/h/.config/cscb-test'],
    [{ CSCB_LIVE_CONFIG_DIR: '/elsewhere' }, '/elsewhere'],
  ])('resolveConfigDir(%p)', (env, expected) => {
    expect(resolveConfigDir(env, '/h')).toBe(expected)
  })

  test("D's credentials wait in the staging dir; A-C sit in the mounted dir; the test mailbox is mailbox.json in the config dir", () => {
    const paths = livePathsIn('/cfg')
    expect(hostCredentialsFile(paths, 'a')).toBe('/cfg/credentials/persona_a-credentials.json')
    expect(hostCredentialsFile(paths, 'd')).toBe('/cfg/credentials-staged/persona_d-credentials.json')
    expect(mountedCredentialsFile(paths, 'd')).toBe('/cfg/credentials/persona_d-credentials.json')
    expect(paths.mailboxJson).toBe('/cfg/mailbox.json')
  })

  test("a real-mode command's run lock sits in the config dir; a dry run's in the temp dir, per user", () => {
    expect(realRunLockFile('/cfg')).toBe('/cfg/run.lock')
    expect(dryRunLockFile('/tmp', 1000)).toBe('/tmp/cscb-ci-live-dry-run-1000.lock')
  })
})

// ---------------------------------------------------------------------------
// SecretStore: reads
// ---------------------------------------------------------------------------

describe('SecretStore reads', () => {
  test('readConfigTokens reads both tokens trimmed and registers them with the redactor', () => {
    const h = makeStore()
    h.mem.seed(h.paths.configTokenFile, `${CONFIG_TOKEN}\n`)
    h.mem.seed(h.paths.refreshTokenFile, `${REFRESH_TOKEN}\n`)
    expect(h.store.readConfigTokens()).toEqual({ token: CONFIG_TOKEN, refreshToken: REFRESH_TOKEN })
    expect(h.redactor.redact(`${CONFIG_TOKEN} ${REFRESH_TOKEN}`)).toBe(`${REDACTED_SECRET} ${REDACTED_SECRET}`)
  })

  test('readConfigTokens without a refresh token file gives null for it', () => {
    const h = makeStore()
    h.mem.seed(h.paths.configTokenFile, CONFIG_TOKEN)
    expect(h.store.readConfigTokens().refreshToken).toBeNull()
  })

  // A missing or empty file is a MissingSecretError (the apps stage can do without the token); a loose one never is.
  test.each([
    ['missing', undefined, 0o600, true, 'the Slack app configuration token is missing: write it to /home/tester/.config/cscb-test/slack_config_token (mode 600)'],
    ['empty', '  \n', 0o600, true, 'the Slack app configuration token in /home/tester/.config/cscb-test/slack_config_token is empty'],
    ['group-readable', CONFIG_TOKEN, 0o640, false, `/home/tester/.config/cscb-test/slack_config_token ${looseRule('640', '600 /home/tester/.config/cscb-test/slack_config_token')}`],
  ])('a %s config token file is not runnable, and the message holds no value', (_what, content, mode, missing, message) => {
    const h = makeStore()
    h.mem.dirs.set(CONFIG_DIR, 0o700)
    if (content !== undefined) h.mem.seed(h.paths.configTokenFile, content, mode)
    const err = thrown(() => h.store.readConfigTokens())
    expect([err instanceof NotRunnableError, err instanceof MissingSecretError]).toEqual([true, missing])
    expect(err.message).toBe(message)
    assertNoLeak(err)
  })

  test('readPassword prefers CSCB_LIVE_TEST_PASSWORD and then never touches the file', () => {
    const h = makeStore({ env: { CSCB_LIVE_TEST_PASSWORD: PASSWORD } })
    expect(h.store.readPassword()).toBe(PASSWORD)
    expect(h.store.hasPassword()).toBe(true)
    expect(h.store.accessed).toEqual([])
    expect(h.redactor.redact(PASSWORD)).toBe(REDACTED_SECRET)
  })

  test('readPassword falls back to the file; hasPassword only stats it', () => {
    const h = makeStore()
    h.mem.seed(h.paths.passwordFile, `${PASSWORD}\n`)
    expect(h.store.hasPassword()).toBe(true)
    expect(h.mem.reads).toEqual([])
    expect(h.store.readPassword()).toBe(PASSWORD)
    expect(h.mem.reads).toEqual([h.paths.passwordFile])
  })

  describe("readSecondPassword (the second workspace user's)", () => {
    const SECOND_PW = `second-pw-${LEAK_SENTINEL}`
    const FILE = `${CONFIG_DIR}/second_password`
    const second = { email: 'second@example.invalid', password_env: 'SECOND_PW', password_file: FILE }

    test('its password_env variable wins and registers the value; no file is touched', () => {
      const h = makeStore({ env: { SECOND_PW } })
      h.mem.seed(FILE, 'unused')
      expect(h.store.readSecondPassword(second)).toBe(SECOND_PW)
      expect([h.store.accessed, h.mem.reads]).toEqual([[], []])
      expect(h.redactor.redact(SECOND_PW)).toBe(REDACTED_SECRET)
    })

    test('an empty or unset variable falls back to its mode-600 password_file, trimmed and registered', () => {
      const h = makeStore({ env: { SECOND_PW: '' } })
      h.mem.seed(FILE, `${SECOND_PW}\n`)
      expect(h.store.readSecondPassword(second)).toBe(SECOND_PW)
      expect(h.mem.reads).toEqual([FILE])
      expect(h.redactor.redact(SECOND_PW)).toBe(REDACTED_SECRET)
    })

    test.each([
      ['neither source', { email: second.email, password_env: 'SECOND_PW' }, undefined, "the second user's password is missing: set env SECOND_PW or live.json second_user.password_file"],
      ['a missing file', second, undefined, `the second user's password is missing: write it to ${FILE} (mode 600)`],
      ['a mode-644 file', second, 0o644, `${FILE} ${looseRule('644', `600 ${FILE}`)}`],
    ] as const)('refuses %s with a NotRunnableError naming the variable or file, never a value', (_what, cfg, mode, message) => {
      const h = makeStore()
      h.mem.dirs.set(CONFIG_DIR, 0o700)
      if (mode !== undefined) h.mem.seed(FILE, SECOND_PW, mode)
      const err = thrown(() => h.store.readSecondPassword(cfg))
      expect(err).toBeInstanceOf(NotRunnableError)
      expect(err.message).toBe(message)
      expect(h.mem.reads).toEqual([])
      assertNoLeak(err)
    })

    test('a sign-in code challenge names the login command for that account', () => {
      const errors = [new SignInCodeNeededError('human'), new SignInCodeNeededError('second')]
      expect(errors.map((e) => [e instanceof NotRunnableError, e.who, /`bun ci-live\/run\.ts login( --second)?`/.exec(e.message)?.[0]])).toEqual([
        [true, 'human', '`bun ci-live/run.ts login`'],
        [true, 'second', '`bun ci-live/run.ts login --second`'],
      ])
    })
  })

  describe('readLiveConfig', () => {
    test('reads live.json, with the environment overriding the domain and email', () => {
      const h = makeStore({ env: { CSCB_LIVE_WORKSPACE: 'other-ws' } })
      h.mem.seed(h.paths.liveJson, JSON.stringify({ workspace_domain: 'cscb-ci-test', test_email: EMAIL }))
      expect(h.store.readLiveConfig()).toEqual({ workspaceDomain: 'other-ws', testEmail: EMAIL, secondUser: null })
    })

    test.each([
      [{ email: 'second@example.invalid', password_env: 'SECOND_PW' }, { email: 'second@example.invalid', password_env: 'SECOND_PW' }],
      [{ email: 'second@example.invalid', password_file: '/f' }, { email: 'second@example.invalid', password_file: '/f' }],
      [{ email: 'second@example.invalid', password_env: 'lower-case' }, null],
      [{ email: 'second@example.invalid' }, null],
      [{ email: 'not an email', password_env: 'X' }, null],
    ])('second_user %p gives %p', (second, expected) => {
      const h = makeStore()
      h.mem.seed(h.paths.liveJson, JSON.stringify({ workspace_domain: 'cscb-ci-test', test_email: EMAIL, second_user: second }))
      expect(h.store.readLiveConfig().secondUser).toEqual(expected)
    })

    test.each([
      ['a domain that is not a Slack domain', { workspace_domain: 'Bad Domain!', test_email: EMAIL }, 'workspace_domain is missing'],
      ['no email', { workspace_domain: 'cscb-ci-test' }, 'test_email is missing'],
      ['an email that is not one', { workspace_domain: 'cscb-ci-test', test_email: `private-${LEAK_SENTINEL}` }, 'test_email is missing'],
      ['not an object', ['cscb-ci-test'], 'is not a JSON object'],
    ])('refuses %s without echoing the value', (_what, json, fragment) => {
      const h = makeStore()
      h.mem.seed(h.paths.liveJson, JSON.stringify(json))
      const err = thrown(() => h.store.readLiveConfig())
      expect(err).toBeInstanceOf(NotRunnableError)
      expect(err.message).toContain(fragment)
      expect(err.message).not.toContain('Bad Domain!')
      assertNoLeak(err)
    })
  })

  describe('readCredentials', () => {
    test("returns a persona's two tokens and registers both", () => {
      const h = makeStore()
      const c = creds()
      h.mem.seed(hostCredentialsFile(h.paths, 'b'), JSON.stringify(c))
      expect(h.store.readCredentials('b')).toEqual(c)
      expect(h.redactor.secretCount).toBe(2)
    })

    test.each([
      ['no file', undefined],
      ['malformed JSON', `{"bot_token": "${fakeToken(BOT_TOKEN_PREFIX)}"`],
      ['a missing key', JSON.stringify({ bot_token: fakeToken(BOT_TOKEN_PREFIX) })],
      ['a non-string token', JSON.stringify({ bot_token: 1, app_token: fakeToken(APP_TOKEN_PREFIX) })],
    ])('gives null for %s, without throwing a value', (_what, content) => {
      const h = makeStore()
      h.mem.dirs.set(h.paths.credentialsDir, 0o700)
      if (content !== undefined) h.mem.seed(hostCredentialsFile(h.paths, 'a'), content)
      expect(h.store.readCredentials('a')).toBeNull()
    })

    test('refuses a group-readable credentials file (not null: the operator must fix it)', () => {
      const h = makeStore()
      h.mem.seed(hostCredentialsFile(h.paths, 'a'), JSON.stringify(creds()), 0o644)
      const err = thrown(() => h.store.readCredentials('a'))
      expect(err).toBeInstanceOf(NotRunnableError)
      assertNoLeak(err)
    })
  })

  test('assertLayoutPrivate refuses a wide secrets directory or file, and passes when the files are absent', () => {
    const ok = makeStore()
    ok.mem.dirs.set(CONFIG_DIR, 0o700)
    expect(() => ok.store.assertLayoutPrivate()).not.toThrow()
    const wideDir = makeStore()
    wideDir.mem.dirs.set(CONFIG_DIR, 0o700)
    wideDir.mem.seed(hostCredentialsFile(wideDir.paths, 'a'), '{}', 0o600, 0o755)
    const wideFile = makeStore()
    wideFile.mem.seed(wideFile.paths.storageState, '{}', 0o644)
    const errors = [thrown(() => wideDir.store.assertLayoutPrivate()), thrown(() => wideFile.store.assertLayoutPrivate())]
    const [credentialsDir, storageState] = [wideDir.paths.credentialsDir, wideFile.paths.storageState]
    expect(errors.map((e) => e.message)).toEqual([
      `${credentialsDir} ${looseRule('755', `700 ${credentialsDir}`)}`,
      `${storageState} ${looseRule('644', `600 ${storageState}`)}`,
    ])
  })

  test("assertLayoutPrivate reports every loose path at once (the personas' credentials files included) with the chmods that fix them all, then any path of the wrong type; it reads and changes nothing", () => {
    const h = makeStore({ configDir: '/cfg' })
    h.mem.seed('/cfg/credentials/persona_a-credentials.json', '{}', 0o640)
    h.mem.seed('/cfg/credentials/persona_b-credentials.json', '{}', 0o600)
    h.mem.seed('/cfg/credentials-staged/persona_d-credentials.json', '{}', 0o644)
    h.mem.seed('/cfg/slack_config_token', CONFIG_TOKEN, 0o660)
    h.mem.seed('/cfg/playwright-state.json', '{}', 0o600)
    h.mem.dirs.set('/cfg', 0o2770)
    h.mem.dirs.set('/cfg/credentials', 0o770)
    h.mem.dirs.set('/cfg/credentials-staged', 0o700)
    h.mem.dirs.set('/cfg/test_password', 0o700)
    const err = thrown(() => h.store.assertLayoutPrivate())
    expect(err).toBeInstanceOf(NotRunnableError)
    expect(err.message).toBe(
      '5 secret paths are group- or other-accessible: /cfg (mode 2770), /cfg/credentials (mode 770), /cfg/slack_config_token (mode 660), ' +
        '/cfg/credentials/persona_a-credentials.json (mode 640), /cfg/credentials-staged/persona_d-credentials.json (mode 644). ' +
        'Run chmod 700 /cfg /cfg/credentials && chmod 600 /cfg/slack_config_token /cfg/credentials/persona_a-credentials.json /cfg/credentials-staged/persona_d-credentials.json ' +
        `(${LOOSE_MODES_NOTE}); /cfg/test_password is not a regular file`,
    )
    expect([h.mem.reads, h.mem.ops.filter((op) => op.startsWith('chmod'))]).toEqual([[], []])
    assertNoLeak(err)
  })

  describe('readMailbox (the test mailbox, mailbox.json)', () => {
    const MAILBOX = livePathsIn(CONFIG_DIR).mailboxJson
    const MAIL_PASSWORD = `mailpw-${LEAK_SENTINEL}`
    const MAIL_TOKEN = `mailtoken-${LEAK_SENTINEL}`
    const mailbox = (overrides: Record<string, unknown> = {}) =>
      JSON.stringify({ provider: 'mail.tm', api: 'https://api.mail.tm', address: 'cscb-test@mailbox.invalid', password: MAIL_PASSWORD, account_id: 'acct0001', token: MAIL_TOKEN, ...overrides })

    test('no file is no mailbox: null, after a stat and no read', () => {
      const h = makeStore()
      h.mem.dirs.set(CONFIG_DIR, 0o700)
      expect(h.store.readMailbox()).toBeNull()
      expect([h.store.accessed, h.mem.reads]).toEqual([[h.paths.mailboxJson], []])
    })

    test('reads a mode-600 file and registers its password and token with the redactor', () => {
      const h = makeStore()
      h.mem.seed(h.paths.mailboxJson, mailbox())
      expect(h.store.readMailbox()).toEqual({ api: 'https://api.mail.tm', address: 'cscb-test@mailbox.invalid', password: MAIL_PASSWORD, accountId: 'acct0001', token: MAIL_TOKEN, extra: {} })
      expect(h.redactor.redact(`${MAIL_PASSWORD} ${MAIL_TOKEN}`)).toBe(`${REDACTED_SECRET} ${REDACTED_SECRET}`)
    })

    test.each([
      ['a group-readable file', mailbox(), 0o640, 0o700, looseRule('640', `600 ${MAILBOX}`), false],
      ['a world-readable file', mailbox(), 0o604, 0o700, looseRule('604', `600 ${MAILBOX}`), false],
      ['a file that is not JSON', `{"password": "${MAIL_PASSWORD}"`, 0o600, 0o700, 'is not valid JSON', true],
      ['a file with no password', mailbox({ password: '' }), 0o600, 0o700, 'has no password', true],
      ['a file whose api holds a password', mailbox({ api: `https://u:${MAIL_PASSWORD}@api.mail.tm` }), 0o600, 0o700, 'has an api that is not an https URL', true],
    ])('refuses %s as not runnable, naming the file and the rule, never a value', (_what, content, mode, dirMode, rule, read) => {
      const h = makeStore()
      h.mem.seed(h.paths.mailboxJson, content, mode, dirMode)
      const err = thrown(() => h.store.readMailbox())
      expect(err).toBeInstanceOf(NotRunnableError)
      expect(err.message).toBe(`${h.paths.mailboxJson} ${rule}`)
      expect(h.mem.reads).toEqual(read ? [h.paths.mailboxJson] : [])
      expect(h.redactor.secretCount).toBe(0)
      assertNoLeak(err)
    })

    test('refuses a mailbox.json in a wide config dir before reading it', () => {
      const h = makeStore()
      h.mem.seed(h.paths.mailboxJson, mailbox(), 0o600, 0o755)
      expect(thrown(() => h.store.readMailbox()).message).toBe(`${CONFIG_DIR} ${looseRule('755', `700 ${CONFIG_DIR}`)}`)
      expect(h.mem.reads).toEqual([])
    })

    test('assertLayoutPrivate refuses a world-readable mailbox.json and accepts a mode-600 one', () => {
      const wide = makeStore()
      wide.mem.seed(wide.paths.mailboxJson, mailbox(), 0o644)
      expect(thrown(() => wide.store.assertLayoutPrivate()).message).toBe(`${MAILBOX} ${looseRule('644', `600 ${MAILBOX}`)}`)
      const ok = makeStore()
      ok.mem.seed(ok.paths.mailboxJson, mailbox())
      expect(() => ok.store.assertLayoutPrivate()).not.toThrow()
      expect([wide.mem.reads, ok.mem.reads]).toEqual([[], []])
    })
  })
})

// ---------------------------------------------------------------------------
// SecretStore: writes
// ---------------------------------------------------------------------------

describe('SecretStore writes', () => {
  test('writeCredentials writes mode 600 in a mode-700 dir, D into the staging dir, and registers both tokens', () => {
    const h = makeStore()
    const c = creds()
    h.store.writeCredentials('d', c)
    const path = hostCredentialsFile(h.paths, 'd')
    expect(h.mem.files.get(path)?.mode).toBe(0o600)
    expect(h.mem.dirs.get(h.paths.stagedCredentialsDir)).toBe(0o700)
    expect(JSON.parse(h.mem.files.get(path)!.data)).toEqual(c)
    expect(h.redactor.redact(`${c.bot_token} ${c.app_token}`)).toBe(`${REDACTED_SECRET} ${REDACTED_SECRET}`)
    expect(h.mem.ops.some((op) => op.startsWith(`writeFile ${path}`))).toBe(false)
  })

  test('writeConfigTokens rewrites both files (mode 600, each through a rename), the refresh token first (the old one is spent), and registers the new values', () => {
    const h = makeStore()
    h.store.writeConfigTokens({ token: CONFIG_TOKEN, refreshToken: REFRESH_TOKEN })
    expect(h.mem.files.get(h.paths.configTokenFile)).toEqual({ data: `${CONFIG_TOKEN}\n`, mode: 0o600 })
    expect(h.mem.files.get(h.paths.refreshTokenFile)).toEqual({ data: `${REFRESH_TOKEN}\n`, mode: 0o600 })
    expect(h.mem.ops.filter((op) => op.startsWith('rename ')).map((op) => op.split(' ')[2])).toEqual([h.paths.refreshTokenFile, h.paths.configTokenFile])
    expect(h.redactor.secretCount).toBe(2)
  })

  test("move puts D's file into the mounted dir, and back", () => {
    const h = makeStore()
    h.store.writeCredentials('d', creds())
    const staged = hostCredentialsFile(h.paths, 'd')
    const mounted = mountedCredentialsFile(h.paths, 'd')
    h.store.move(staged, mounted)
    expect([h.store.exists(staged), h.store.exists(mounted)]).toEqual([false, true])
    expect(h.mem.dirs.get(h.paths.credentialsDir)).toBe(0o700)
    h.store.move(mounted, staged)
    expect([h.store.exists(staged), h.store.exists(mounted)]).toEqual([true, false])
  })

  test('writeMailbox (a fresh mail.tm token) registers the password and token first, then writes mode 600 through a temp file and a rename', () => {
    const mem = memSecureFs()
    const redactor = new Redactor()
    const paths = livePathsIn(CONFIG_DIR)
    const maskedAtWrite: boolean[] = []
    const fs: SecureFs = {
      ...mem.fs,
      writeFile: (path, data, mode) => {
        maskedAtWrite.push(redactor.redact(data).includes(REDACTED_SECRET) && !redactor.redact(data).includes(LEAK_SENTINEL))
        mem.fs.writeFile(path, data, mode)
      },
    }
    const store = new SecretStore({ fs, paths, env: {}, redactor, dryRun: false, realConfigDir: REAL_DIR })
    const config = mailboxConfig({ extra: { created_by: 'operator' } })
    store.writeMailbox(config)
    expect(maskedAtWrite).toEqual([true])
    expect(mem.ops.some((op) => op.startsWith(`writeFile ${paths.mailboxJson}`))).toBe(false)
    expect(mem.ops.at(-1)).toMatch(new RegExp(`^rename ${CONFIG_DIR}/\\.mailbox\\.json\\.tmp-\\S+ ${paths.mailboxJson}$`))
    const file = mem.files.get(paths.mailboxJson)!
    expect([file.mode, mem.dirs.get(CONFIG_DIR)]).toEqual([0o600, 0o700])
    expect(parseMailboxFile(file.data)).toEqual(config)
    expect(store.readMailbox()).toEqual(config)
  })

  test('storageState saves mode 600 and loads only after its mode check', () => {
    const h = makeStore()
    const state = h.store.storageState('human')
    expect(state.exists()).toBe(false)
    state.save('{"cookies":[]}')
    expect(h.mem.files.get(h.paths.storageState)?.mode).toBe(0o600)
    expect(state.load()).toBe('{"cookies":[]}')
    h.mem.files.get(h.paths.storageState)!.mode = 0o644
    expect(() => state.load()).toThrow(NotRunnableError)
  })
})

// ---------------------------------------------------------------------------
// The dry-run guard
// ---------------------------------------------------------------------------

describe('dry run: no real secret is touched', () => {
  test.each([
    ['the real dir itself', REAL_DIR, true],
    ['a file in it', `${REAL_DIR}/slack_config_token`, true],
    ['a nested file', `${REAL_DIR}/credentials/persona_a-credentials.json`, true],
    ['a path that climbs out and back in', `${REAL_DIR}/credentials/../test_password`, true],
    ['a name that only starts with two dots', `${REAL_DIR}/..foo`, true],
    ['a nested name that starts with two dots', `${REAL_DIR}/credentials/..bak/x`, true],
    ['a sibling sharing its prefix', `${REAL_DIR}-dry/x`, false],
    ['its parent', '/home/tester/real/.config', false],
    ['its parent, spelled with ..', `${REAL_DIR}/..`, false],
    ['a path that climbs out', `${REAL_DIR}/../cscb-test-other/x`, false],
    ['a temp dir', '/tmp/cscb-ci-live-dry-1/config', false],
  ])('isInside: %s → %p', (_what, path, expected) => {
    expect(isInside(path, REAL_DIR)).toBe(expected)
  })

  test.each([REAL_DIR, `${REAL_DIR}/nested`])('a dry-run store pointed at %s refuses to be built', (configDir) => {
    const mem = memSecureFs()
    expect(() => makeStore({ dryRun: true, configDir, mem })).toThrow(DryRunSecretAccessError)
    expect(mem.ops).toEqual([])
  })

  test('every access under the real dir throws before the file system is called, through the store and its guarded fs', () => {
    const h = makeStore({ dryRun: true, configDir: '/tmp/dry/config' })
    const realCreds = `${REAL_DIR}/credentials/persona_a-credentials.json`
    const guarded = h.store.guardedFs()
    const attempts: Array<() => unknown> = [
      () => h.store.readCredentialsAt(realCreds),
      () => h.store.writeCredentialsAt(realCreds, creds()),
      () => h.store.exists(`${REAL_DIR}/test_password`),
      () => h.store.move('/tmp/dry/config/x', `${REAL_DIR}/x`),
      () => guarded.stat(`${REAL_DIR}/apps.json`),
      () => guarded.stat(`${REAL_DIR}/..foo`),
      () => guarded.readFile(`${REAL_DIR}/apps.json`),
      () => guarded.rename('/tmp/dry/config/apps.json', `${REAL_DIR}/apps.json`),
    ]
    const errors = attempts.map(thrown)
    expect(errors.every((e) => e instanceof DryRunSecretAccessError)).toBe(true)
    expect(h.mem.ops.filter((op) => op.includes(REAL_DIR))).toEqual([])
    assertNoLeak(errors)
  })

  test("a dry run's seed and reads stay in the temporary dir, ignoring the environment the store was not given", () => {
    const h = makeStore({ dryRun: true, configDir: '/tmp/dry/config' })
    h.store.seedDryRun({ configToken: CONFIG_TOKEN, refreshToken: REFRESH_TOKEN, password: PASSWORD, workspaceDomain: 'cscb-dry-run', testEmail: EMAIL })
    for (const path of [h.paths.configTokenFile, h.paths.refreshTokenFile, h.paths.passwordFile, h.paths.liveJson]) expect(h.mem.files.get(path)?.mode).toBe(0o600)
    expect(h.store.readLiveConfig().workspaceDomain).toBe('cscb-dry-run')
    expect(h.store.readConfigTokens()).toEqual({ token: CONFIG_TOKEN, refreshToken: REFRESH_TOKEN })
    expect(h.store.readPassword()).toBe(PASSWORD)
    h.store.writeCredentials('a', creds())
    expect(h.store.accessed.length).toBeGreaterThan(0)
    expect(h.store.accessed.filter((p) => !isInside(p, '/tmp/dry/config'))).toEqual([])
  })

  test("a dry run's seed writes the stub's mailbox.json (mode 600) in the temporary dir only; the real mailbox.json is never touched", () => {
    const h = makeStore({ dryRun: true, configDir: '/tmp/dry/config' })
    const stub = mailboxConfig({ api: 'http://127.0.0.1:4100/mailtm' })
    h.store.seedDryRun({ configToken: CONFIG_TOKEN, password: PASSWORD, workspaceDomain: 'cscb-dry-run', testEmail: EMAIL, mailbox: stub })
    expect([h.paths.mailboxJson, h.mem.files.get(h.paths.mailboxJson)?.mode]).toEqual(['/tmp/dry/config/mailbox.json', 0o600])
    expect(h.store.readMailbox()).toEqual(stub)
    expect(h.store.accessed.filter((p) => !isInside(p, '/tmp/dry/config'))).toEqual([])
    const err = thrown(() => h.store.guardedFs().readFile(`${REAL_DIR}/mailbox.json`))
    expect(err).toBeInstanceOf(DryRunSecretAccessError)
    expect(h.mem.ops.filter((op) => op.includes(REAL_DIR))).toEqual([])
    assertNoLeak([err, h.store.accessed])
  })

  test("a dry run's seed without a mailbox writes no mailbox.json", () => {
    const h = makeStore({ dryRun: true, configDir: '/tmp/dry/config' })
    h.store.seedDryRun({ configToken: CONFIG_TOKEN, password: PASSWORD, workspaceDomain: 'cscb-dry-run', testEmail: EMAIL })
    expect([h.mem.files.has(h.paths.mailboxJson), h.store.readMailbox()]).toEqual([false, null])
  })

  test('seedDryRun refuses a real store', () => {
    const h = makeStore()
    expect(() => h.store.seedDryRun({ configToken: CONFIG_TOKEN, password: PASSWORD, workspaceDomain: 'x', testEmail: EMAIL })).toThrow('dry run only')
    expect(h.mem.files.size).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// apps.json
// ---------------------------------------------------------------------------

describe('apps.json', () => {
  test('parsing keeps well-formed IDs and drops everything else', () => {
    const text = JSON.stringify({
      version: 1,
      team_id: 'T0TEAM0001',
      human_user_id: 'not-a-user',
      personas: {
        a: { app_id: 'A0APP00001', bot_user_id: 'U0BOT00001', bot_id: 'B0BOT00001', needs_reinstall: true, app_token_name: 'cscb-live' },
        b: { app_id: 'bad', needs_reinstall: 'yes', app_token_name: fakeToken(APP_TOKEN_PREFIX), pending_create: { started_at: 'yesterday' } },
        c: { pending_create: { started_at: '2026-09-26T12:00:00.000Z', note: LEAK_SENTINEL } },
        d: { pending_create: '2026-09-26T12:00:00Z' },
        e: { app_id: 'A0APP00009' },
      },
      channels: { 'a-home': 'C0CHAN0001', coordination: 'nope', general: 'C0CHAN0009' },
      client_secret: `secret-${LEAK_SENTINEL}`,
    })
    const state = parseAppsState(text)
    expect(state).toEqual({
      version: 1,
      team_id: 'T0TEAM0001',
      personas: {
        a: { app_id: 'A0APP00001', bot_user_id: 'U0BOT00001', bot_id: 'B0BOT00001', needs_reinstall: true, app_token_name: 'cscb-live' },
        c: { pending_create: { started_at: '2026-09-26T12:00:00.000Z' } },
      },
      channels: { 'a-home': 'C0CHAN0001' },
    })
    assertNoLeak(serializeAppsState(state))
  })

  test('recordedAppIds maps each recorded app ID to its persona; an unfinished create (no app ID yet) records none', () => {
    const state = parseAppsState(
      JSON.stringify({ version: 1, personas: { a: { app_id: 'A0APP00001' }, b: { pending_create: { started_at: '2026-09-26T12:00:00Z' } }, d: { app_id: 'A0APP00004' } } }),
    )
    expect([...recordedAppIds(state)]).toEqual([
      ['A0APP00001', 'a'],
      ['A0APP00004', 'd'],
    ])
  })

  // Read as empty, every app it records would look unrecorded (a stray to delete, an app to create again).
  const MALFORMED_FIX =
    ': fix it, or restore it from a backup or from the VM that made the apps. The runner never reads it as empty, since every app it records would then look unrecorded. ' +
    'Or move it aside: bun ci-live/run.ts apps --list then shows the apps, and a real run with --create-apps creates new ones'
  test.each([
    ['text that is no JSON', `not json ${LEAK_SENTINEL}`, 'does not parse as JSON'],
    ['an empty file', '', 'does not parse as JSON'],
    ['an array', '[]', 'is not a JSON object'],
    ['null', 'null', 'is not a JSON object'],
    ['a string', `"${LEAK_SENTINEL}"`, 'is not a JSON object'],
  ])('%s is never read as empty: parseAppsState and AppsStateFile.load throw MalformedAppsStateError (not runnable), naming the file and never quoting it', (_what, text, problem) => {
    const mem = memSecureFs()
    mem.seed('/cfg/apps.json', text)
    const errors = [() => parseAppsState(text), () => new AppsStateFile(mem.fs, '/cfg/apps.json').load()].map((read) => {
      try {
        read()
      } catch (err) {
        return err
      }
      throw new Error('expected MalformedAppsStateError')
    })
    expect(errors.map((e) => [e instanceof MalformedAppsStateError, e instanceof NotRunnableError, (e as Error).message])).toEqual([
      [true, true, `apps.json ${problem}${MALFORMED_FIX}`],
      [true, true, `/cfg/apps.json ${problem}${MALFORMED_FIX}`],
    ])
    assertNoLeak(errors)
  })

  test('AppsStateFile loads empty when absent, and update writes it privately (temp + rename, mode 600)', () => {
    const mem = memSecureFs()
    const file = new AppsStateFile(mem.fs, '/cfg/apps.json')
    expect([file.exists(), file.load()]).toEqual([false, emptyAppsState()])
    file.update((s) => {
      s.personas.c = { app_id: 'A0APP00003' }
    })
    expect(file.exists()).toBe(true)
    expect(mem.files.get('/cfg/apps.json')?.mode).toBe(0o600)
    expect(mem.dirs.get('/cfg')).toBe(0o700)
    expect(mem.ops.some((op) => op.startsWith('writeFile /cfg/apps.json'))).toBe(false)
    expect(file.load().personas.c?.app_id).toBe('A0APP00003')
  })
})
