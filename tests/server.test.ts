import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative, resolve } from 'node:path'
import {
  assertSendable,
  chunkText,
  sanitizeFilename,
} from '../src/lib.ts'
import type { Client } from 'agent-director'
import {
  ErrSpawnNotFound,
  ErrSystemInstallDisappeared,
  ErrTmuxNotAvailable,
} from '../src/agent-director-errors.ts'
import {
  _resetOutageState,
  initOutageState,
  getOutageFlags,
  setOutageFlag,
} from '../src/outage-state.ts'
import {
  setClientForTests,
  resetClientForTests,
} from '../src/agent-director-client.ts'
import { makeStubClient, errTmuxSendKeys, holdSpawns, type StubClient } from './test-helpers/agent-director-stub.ts'
import { _buildIsSessionAliveAdapter, _buildReconnectSessionAdapter } from '../src/server.ts'
import {
  _resetFindMissingMemo,
  _setTmuxServerEnsurer,
  _resetTmuxServerEnsurer,
  _setTmuxSessionProber,
  _resetTmuxSessionProber,
  _setSpawnHomeDir,
  _resetSpawnHomeDir,
  _resetInFlightLaunches,
  isLaunchInFlight,
  spawnForPersona,
} from '../src/session-manager.ts'
import type { FindMissingParams, SendKeysParams, StatusParams } from 'agent-director'
import type { PersonaConfig } from '../src/config.ts'
import { personaInstanceId } from '../src/persona-identity.ts'
import { makeStandInPersonaConfig } from './test-helpers/persona-config.ts'
import {
  APP_TOKEN_PREFIX,
  LEAK_SENTINEL,
  REDACTED_SENTINEL_TAIL,
  assertNoLeak,
  fakeToken,
  sentinelInMessage,
  writeCredentialsFile,
} from './test-helpers/credentials.ts'

// ---------------------------------------------------------------------------
// assertSendable()
// ---------------------------------------------------------------------------

describe('assertSendable', () => {
  const stateDir = '/home/user/.claude/channels/slack'
  const inboxDir = '/home/user/.claude/channels/slack/inbox'

  test('blocks .env in state dir', () => {
    expect(() => assertSendable(`${stateDir}/.env`, stateDir, inboxDir, [])).toThrow('Blocked')
  })

  test('blocks config.json in state dir', () => {
    expect(() => assertSendable(`${stateDir}/config.json`, stateDir, inboxDir, [])).toThrow('Blocked')
  })

  test('blocks nested files in state dir', () => {
    expect(() => assertSendable(`${stateDir}/subdir/secret`, stateDir, inboxDir, [])).toThrow('Blocked')
  })

  test('allows files in inbox/', () => {
    expect(() => assertSendable(`${inboxDir}/photo.png`, stateDir, inboxDir, [])).not.toThrow()
  })

  test('allows files outside state dir entirely', () => {
    expect(() => assertSendable('/tmp/output.txt', stateDir, inboxDir, [])).not.toThrow()
  })

  test('allows home directory files', () => {
    expect(() => assertSendable('/home/user/project/file.ts', stateDir, inboxDir, [])).not.toThrow()
  })

  test('blocks traversal into state dir via ..', () => {
    // Path that traverses out of inbox/ back into the protected state dir
    expect(() => assertSendable(`${inboxDir}/../config.json`, stateDir, inboxDir, [])).toThrow()
  })

  // Directory boundaries: a prefix match counts only at a path separator.
  test.each([
    ['a sibling of inbox/ whose name starts with "inbox"', `${stateDir}/inbox-old/secret`],
    ['the state dir itself', stateDir],
    ['traversal out of inbox/ into an "inbox"-prefixed sibling', `${inboxDir}/../inbox-old/secret`],
  ])('blocks %s', (_label, filePath) => {
    expect(() => assertSendable(filePath, stateDir, inboxDir, []))
      .toThrow('cannot send files from state directory')
  })

  test('does not treat a sibling directory named after the state dir as the state dir', () => {
    expect(() => assertSendable(`${stateDir}2/secret`, stateDir, inboxDir, [])).not.toThrow()
  })

  test('tolerates a trailing separator on the state and inbox directories', () => {
    expect(() => assertSendable(`${stateDir}/config.json`, `${stateDir}/`, `${inboxDir}/`, []))
      .toThrow('cannot send files from state directory')
    expect(() => assertSendable(`${inboxDir}/photo.png`, `${stateDir}/`, `${inboxDir}/`, [])).not.toThrow()
  })
})

// ---------------------------------------------------------------------------
// assertSendable(): the state-dir rule on real paths (b.av2 SR-5.2)
// ---------------------------------------------------------------------------

describe('assertSendable: state-dir rule on real paths', () => {
  // Real files under a temp dir, realpath'd because the OS temp directory may
  // itself be a symlink. Layout:
  //   <dir>/state/config.json                a state-dir file outside inbox/
  //   <dir>/state/inbox/photo.png            an inbox file
  //   <dir>/state/inbox/to-config          -> state/config.json
  //   <dir>/state/inbox-old/secret           a sibling of inbox/
  //   <dir>/state2/secret                    a sibling of the state dir
  //   <dir>/outside/to-config              -> state/config.json
  //   <dir>/outside/to-photo               -> state/inbox/photo.png
  //   <dir>/outside/state-link             -> state   (directory symlink)
  let dir: string
  let stateDir: string
  let inboxDir: string

  beforeEach(() => {
    dir = realpathSync(mkdtempSync(join(tmpdir(), 'cscb-sendable-state-')))
    stateDir = join(dir, 'state')
    inboxDir = join(stateDir, 'inbox')
    mkdirSync(inboxDir, { recursive: true })
    mkdirSync(join(stateDir, 'inbox-old'))
    mkdirSync(join(dir, 'state2'))
    mkdirSync(join(dir, 'outside'))
    writeFileSync(join(stateDir, 'config.json'), '{}')
    writeFileSync(join(inboxDir, 'photo.png'), 'png')
    writeFileSync(join(stateDir, 'inbox-old', 'secret'), 'not for sending')
    writeFileSync(join(dir, 'state2', 'secret'), 'outside the state dir')
    symlinkSync(join(stateDir, 'config.json'), join(inboxDir, 'to-config'))
    symlinkSync(join(stateDir, 'config.json'), join(dir, 'outside', 'to-config'))
    symlinkSync(join(inboxDir, 'photo.png'), join(dir, 'outside', 'to-photo'))
    symlinkSync(stateDir, join(dir, 'outside', 'state-link'))
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  /** The error `assertSendable` throws for `rel` (under the temp dir), or undefined when it allows it. */
  function refusal(rel: string, state = stateDir, inbox = inboxDir): Error | undefined {
    try {
      assertSendable(join(dir, rel), state, inbox, [])
      return undefined
    } catch (err) {
      return err as Error
    }
  }

  test.each([
    ['a symlink outside the state dir to a state-dir file outside inbox/', 'outside/to-config'],
    ['a state-dir file reached through a symlinked directory outside it', 'outside/state-link/config.json'],
    ['a symlink inside inbox/ to a state-dir file outside inbox/', 'state/inbox/to-config'],
    ['an existing file in a sibling of inbox/ whose name starts with "inbox"', 'state/inbox-old/secret'],
  ])('refuses %s', (_label, rel) => {
    expect(refusal(rel)?.message).toContain('cannot send files from state directory')
  })

  test.each([
    ['a symlink outside the state dir to a file inside inbox/', 'outside/to-photo'],
    ['an inbox file reached through a symlinked directory outside the state dir', 'outside/state-link/inbox/photo.png'],
    ['an existing file in a sibling directory named after the state dir', 'state2/secret'],
    ['a plain inbox file', 'state/inbox/photo.png'],
  ])('allows %s', (_label, rel) => {
    expect(refusal(rel)).toBeUndefined()
  })

  test('a state dir given through a symlink still refuses its real files outside inbox/ and allows its real inbox', () => {
    const aliasState = join(dir, 'outside', 'state-link')
    const aliasInbox = join(aliasState, 'inbox')
    expect(refusal('state/config.json', aliasState, aliasInbox)?.message)
      .toContain('cannot send files from state directory')
    expect(refusal('state/inbox/photo.png', aliasState, aliasInbox)).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// assertSendable(): persona credentials files (b.av2 SR-5.2)
// ---------------------------------------------------------------------------

describe('assertSendable: credentials files', () => {
  // Real files under a temp dir. The dir is realpath'd because the OS temp
  // directory may itself be a symlink. Layout:
  //   <dir>/a/credentials.json   the listed credentials file
  //   <dir>/a/notes.txt          an unlisted sibling
  //   <dir>/a/b/                 a directory below it
  //   <dir>/alias.json         -> a/credentials.json   (file symlink)
  //   <dir>/linkdir            -> a                    (parent-directory symlink)
  let dir: string
  let credPath: string
  let stateDir: string
  let inboxDir: string

  beforeEach(() => {
    dir = realpathSync(mkdtempSync(join(tmpdir(), 'cscb-sendable-')))
    credPath = writeCredentialsFile(dir, 'a/credentials.json')
    writeFileSync(join(dir, 'a', 'notes.txt'), 'not a credentials file')
    mkdirSync(join(dir, 'a', 'b'))
    symlinkSync(credPath, join(dir, 'alias.json'))
    symlinkSync(join(dir, 'a'), join(dir, 'linkdir'))
    stateDir = join(dir, 'state')
    inboxDir = join(stateDir, 'inbox')
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  /** The error `assertSendable` throws, or undefined when it allows the file. */
  function refusal(filePath: string, protectedPaths: readonly string[]): Error | undefined {
    try {
      assertSendable(filePath, stateDir, inboxDir, protectedPaths)
      return undefined
    } catch (err) {
      return err as Error
    }
  }

  test.each([
    ['its exact path', () => credPath],
    ['a symlink to it', () => join(dir, 'alias.json')],
    // `..` is collapsed lexically before the real path is taken (as the upload
    // and the loader do), so this one also crosses the symlinked parent to
    // differ lexically from the listed path.
    ['a path with .. segments', () => `${dir}/a/b/../../linkdir/credentials.json`],
    ['a symlinked parent directory', () => join(dir, 'linkdir', 'credentials.json')],
    ['a relative path', () => relative(process.cwd(), credPath)],
  ])('refuses the credentials file through %s', (_label, sendPath) => {
    const err = refusal(sendPath(), [credPath])
    expect(err?.message).toContain('persona credentials file')
    expect(err?.message).toContain(resolve(sendPath()))
    assertNoLeak(err)
  })

  test('allows an unlisted sibling in the same directory', () => {
    expect(refusal(join(dir, 'a', 'notes.txt'), [credPath])).toBeUndefined()
  })

  test('refuses a listed path that does not exist, compared lexically', () => {
    const missing = join(dir, 'gone', 'credentials.json')
    expect(refusal(join(dir, 'gone', '.', 'credentials.json'), [missing])?.message)
      .toContain('persona credentials file')
    expect(refusal(join(dir, 'gone', 'other.json'), [missing])).toBeUndefined()
  })

  test('refuses each entry of a two-entry list', () => {
    const second = writeCredentialsFile(dir, 'second/credentials.json')
    const list = [credPath, second]
    expect(refusal(credPath, list)?.message).toContain(credPath)
    expect(refusal(second, list)?.message).toContain(second)
  })

  test('the state-dir rule is checked first', () => {
    const inState = writeCredentialsFile(dir, 'state/credentials.json')
    const err = refusal(inState, [inState])
    expect(err?.message).toContain('cannot send files from state directory')
    expect(err?.message).not.toContain('persona credentials file')
  })
})

// ---------------------------------------------------------------------------
// chunkText()
// ---------------------------------------------------------------------------

describe('chunkText', () => {
  test('returns single chunk for short text', () => {
    const result = chunkText('hello', 4000, 'newline')
    expect(result).toEqual(['hello'])
  })

  test('returns single chunk at exactly the limit', () => {
    const text = 'a'.repeat(4000)
    const result = chunkText(text, 4000, 'length')
    expect(result).toEqual([text])
  })

  test('chunks by fixed length', () => {
    const text = 'a'.repeat(10)
    const result = chunkText(text, 4, 'length')
    expect(result).toEqual(['aaaa', 'aaaa', 'aa'])
  })

  test('chunks at newlines (paragraph-aware)', () => {
    const text = 'line1\nline2\nline3\nline4'
    const result = chunkText(text, 12, 'newline')
    expect(result.length).toBeGreaterThan(1)
    // Each chunk should be <= 12 chars
    for (const chunk of result) {
      expect(chunk.length).toBeLessThanOrEqual(12)
    }
  })

  test('newline mode keeps lines together when possible', () => {
    const text = 'short\nshort\nshort'
    const result = chunkText(text, 100, 'newline')
    expect(result).toEqual(['short\nshort\nshort'])
  })
})

// ---------------------------------------------------------------------------
// sanitizeFilename()
// ---------------------------------------------------------------------------

describe('sanitizeFilename', () => {
  test('strips square brackets', () => {
    expect(sanitizeFilename('file[1].txt')).toBe('file_1_.txt')
  })

  test('strips newlines', () => {
    expect(sanitizeFilename('file\nname.txt')).toBe('file_name.txt')
  })

  test('strips carriage returns', () => {
    expect(sanitizeFilename('file\rname.txt')).toBe('file_name.txt')
  })

  test('strips semicolons', () => {
    expect(sanitizeFilename('file;name.txt')).toBe('file_name.txt')
  })

  test('replaces path traversal (..)', () => {
    expect(sanitizeFilename('../../etc/passwd')).toBe('_/_/etc/passwd')
  })

  test('leaves clean names alone', () => {
    expect(sanitizeFilename('photo.png')).toBe('photo.png')
  })

  test('handles combined attack vector', () => {
    const result = sanitizeFilename('[../..\n;evil].txt')
    expect(result).not.toContain('[')
    expect(result).not.toContain('..')
    expect(result).not.toContain('\n')
    expect(result).not.toContain(';')
  })
})

// ---------------------------------------------------------------------------
// _buildIsSessionAliveAdapter (SRD § Liveness probe, Epic 2 Task 1)
// ---------------------------------------------------------------------------

describe('_buildIsSessionAliveAdapter', () => {
  type Emission = { key: string; text: string }

  /** Per-test temp dir: `baseDir` for the stand-in persona fixtures. */
  let baseDir: string

  beforeEach(() => {
    baseDir = mkdtempSync(join(tmpdir(), 'cscb-server-'))
  })

  /** One stand-in persona per key (keyed and named by its one channel's ID), in order. */
  function standIns(...keys: string[]): PersonaConfig {
    return makeStandInPersonaConfig(Object.fromEntries(keys.map((k) => [k, {}])), baseDir)
  }

  /** Build per-test emission capture + stub client + outage-state harness. */
  function makeHarness(
    statusError?: Error,
    statusState?: string,
    config: PersonaConfig | null = standIns('C1'),
  ): {
    emissions: Emission[]
    statusCalls: StatusParams[]
    adapter: (channelId: string) => Promise<boolean>
  } {
    const emissions: Emission[] = []
    const statusCalls: StatusParams[] = []
    _resetOutageState()
    initOutageState({
      notify: (key, text) => { emissions.push({ key, text }) },
      getClient: () => makeStubClient() as unknown as Client,
    })
    const stubOpts = statusError
      ? { statusError, statusCalls }
      : { statusResult: { state: statusState ?? 'waiting' }, statusCalls }
    setClientForTests(makeStubClient(stubOpts) as unknown as Client)
    // Default persona config: one stand-in persona keyed C1.
    return {
      emissions,
      statusCalls,
      adapter: _buildIsSessionAliveAdapter(() => config),
    }
  }

  afterEach(() => {
    resetClientForTests()
    _resetOutageState()
    rmSync(baseDir, { recursive: true, force: true })
  })

  test('1. alive: status returns live state → clears ad-unreachable + tmux-unavailable; returns true', async () => {
    const { emissions, statusCalls, adapter } = makeHarness(undefined, 'waiting')
    // Pre-raise both flags so the clears are observable
    setOutageFlag('C1', 'ad-unreachable', '/bin/ad')
    setOutageFlag('C1', 'tmux-unavailable')
    const before = emissions.length

    const result = await adapter('C1')

    expect(result).toBe(true)
    // b.av2 SR-2.2: the probe addresses the persona's cscb_<key> instance.
    expect(statusCalls).toHaveLength(1)
    expect(statusCalls[0].claude_instance_id).toBe(personaInstanceId('C1'))
    expect(statusCalls[0].claude_instance_id).toBe('cscb_C1')
    expect(getOutageFlags('C1').size).toBe(0)
    const newEmissions = emissions.slice(before)
    expect(newEmissions).toHaveLength(1)
    expect(newEmissions[0].key).toBe('C1')
    expect(newEmissions[0].text).toMatch(/All clear/)
    expect(newEmissions[0].text).toContain('ad-unreachable')
    expect(newEmissions[0].text).toContain('tmux-unavailable')
  })

  test('2. ErrSpawnNotFound: status throws → clears ad-unreachable + tmux-unavailable; returns false', async () => {
    const { emissions, statusCalls, adapter } = makeHarness(
      new ErrSpawnNotFound('status', 'ErrSpawnNotFound', 'spawn not found'),
    )
    setOutageFlag('C1', 'ad-unreachable', '/bin/ad')
    setOutageFlag('C1', 'tmux-unavailable')
    const before = emissions.length

    const result = await adapter('C1')

    expect(result).toBe(false)
    expect(statusCalls.map((c) => c.claude_instance_id)).toEqual(['cscb_C1'])
    expect(getOutageFlags('C1').size).toBe(0)
    const newEmissions = emissions.slice(before)
    expect(newEmissions).toHaveLength(1)
    expect(newEmissions[0].text).toMatch(/All clear/)
    expect(newEmissions[0].text).toContain('ad-unreachable')
    expect(newEmissions[0].text).toContain('tmux-unavailable')
  })

  test('3. ErrSystemInstallDisappeared: status throws → sets ad-unreachable with binaryPath as detail; returns false', async () => {
    const binaryPath = '/home/horde/.agent-director/bin/agent-director'
    const { emissions, statusCalls, adapter } = makeHarness(
      new ErrSystemInstallDisappeared('status', binaryPath),
    )

    const result = await adapter('C1')

    expect(result).toBe(false)
    expect(statusCalls.map((c) => c.claude_instance_id)).toEqual(['cscb_C1'])
    expect(getOutageFlags('C1').has('ad-unreachable')).toBe(true)
    expect(getOutageFlags('C1').has('tmux-unavailable')).toBe(false)
    expect(emissions).toHaveLength(1)
    expect(emissions[0].key).toBe('C1')
    expect(emissions[0].text).toMatch(/agent-director unreachable/)
    expect(emissions[0].text).toContain(binaryPath)
  })

  test('4. ErrTmuxNotAvailable: status throws → sets tmux-unavailable (no detail); returns false', async () => {
    const { emissions, statusCalls, adapter } = makeHarness(
      new ErrTmuxNotAvailable('status', 'ErrTmuxNotAvailable', 'tmux not found'),
    )

    const result = await adapter('C1')

    expect(result).toBe(false)
    expect(statusCalls.map((c) => c.claude_instance_id)).toEqual(['cscb_C1'])
    expect(getOutageFlags('C1').has('tmux-unavailable')).toBe(true)
    expect(getOutageFlags('C1').has('ad-unreachable')).toBe(false)
    expect(emissions).toHaveLength(1)
    expect(emissions[0].key).toBe('C1')
    expect(emissions[0].text).toMatch(/tmux unavailable/)
    // ONSET_TEMPLATES['tmux-unavailable'] ignores the detail arg — nothing extra
    expect(emissions[0].text).not.toContain('undefined')
  })

  test('5. each persona is probed by its own key: cscb_<key> for the key passed (b.av2 SR-2.2)', async () => {
    const { statusCalls, adapter } = makeHarness(undefined, 'waiting', standIns('C1', 'C2'))

    expect(await adapter('C2')).toBe(true)
    expect(await adapter('C1')).toBe(true)

    expect(statusCalls.map((c) => c.claude_instance_id)).toEqual([
      personaInstanceId('C2'),
      personaInstanceId('C1'),
    ])
  })

  test('6. unknown key: returns false without a status call and without touching outage flags', async () => {
    const { emissions, statusCalls, adapter } = makeHarness(undefined, 'waiting')
    setOutageFlag('C9', 'ad-unreachable', '/bin/ad')
    const before = emissions.length

    const result = await adapter('C9')

    expect(result).toBe(false)
    expect(statusCalls).toHaveLength(0)
    // No probe ran, so nothing was cleared and no all-clear was posted.
    expect(getOutageFlags('C9').has('ad-unreachable')).toBe(true)
    expect(emissions.slice(before)).toHaveLength(0)
  })

  test('7. no persona config (MCP_HOST/MCP_PORT fallback): returns false without a status call', async () => {
    const { statusCalls, adapter } = makeHarness(undefined, 'waiting', null)

    expect(await adapter('C1')).toBe(false)
    expect(statusCalls).toHaveLength(0)
  })

  // AC 20 (b.av2 SR-10.3): the catch-all status-error line logs the error's
  // description (type, safe code, message through `redactSlackLogText`,
  // frames), never the error itself. The message carries the leak marker only
  // inside a fake token and a `ticket=` URL, both of which redaction replaces.
  // Every console.error argument is kept unformatted, so a raw error fails the check.
  test('AC 20: any other status error carrying fake tokens → one "status error" line naming its type, code and redacted message; returns false, no flag, nothing leaks', async () => {
    const statusError = Object.assign(new Error(`status failed (${sentinelInMessage('msg')})`), {
      code: 'EIO',
      detail: fakeToken(APP_TOKEN_PREFIX, 'detail'),
      note: LEAK_SENTINEL,
    })
    const { emissions, adapter } = makeHarness(statusError)
    const errArgs: unknown[][] = []
    const orig = console.error
    console.error = (...args: unknown[]) => { errArgs.push(args) }
    let result: boolean | undefined
    try {
      result = await adapter('C1')
    } finally {
      console.error = orig
    }

    expect(result).toBe(false)
    expect(getOutageFlags('C1').size).toBe(0)
    expect(errArgs).toHaveLength(1)
    expect(errArgs[0]).toHaveLength(1)
    expect(String(errArgs[0]![0])).toStartWith(
      `[slack] isSessionAlive: status error for persona=C1: Error code=EIO message="status failed (${REDACTED_SENTINEL_TAIL})" at `,
    )
    assertNoLeak({ errArgs, emissions })
  })
})

// ---------------------------------------------------------------------------
// _buildReconnectSessionAdapter (b.9a7 — working-state defer gate)
//
// The adapter probes AD state via withOutageDetection().status() before typing
// `/mcp reconnect`. If the row is `working` it returns 'transient' WITHOUT
// attempting the reconnect (hazard 2 / b.rmy: don't type into a session
// mid-turn). Any other live state, or a status-probe error, falls through to
// the reconnectMcp send-keys attempt. reconnectMcp is a direct module import,
// but it drives its send-keys through the SAME withOutageDetection client the
// status probe uses, so the shared stub's `sendKeysCalls` is the observable
// seam for "was a reconnect attempted", and `sendKeysResult`/`sendKeysError`
// drive the ok→'success' / dead-session→'escalate-dead' mapping.
//
// b.d61: a `working` row whose tmux session is gone (the Claude inside it was
// killed mid-turn, so AD's row stays frozen at `working`) must not be deferred
// forever. The `working` branch probes the persona's `slack_bot_<key>` tmux
// session through the session manager's prober seam (`_setTmuxSessionProber`,
// installed by the harness so no test shells out to tmux): gone → the dead-tmux
// sweep and 'escalate-dead'; alive, or a probe that fails → the 'transient'
// defer, so a live turn is never poked (b.rmy) and a probe error never
// manufactures a false dead. While a launch for the persona is in flight the
// `working` row is deferred without a probe: the launch owns the session, and a
// tmux session it has not created yet is no proof of death.
// ---------------------------------------------------------------------------

describe('_buildReconnectSessionAdapter', () => {
  /**
   * Build a stub client wired into BOTH outage-state (which withOutageDetection
   * calls via getClient) and setClientForTests, plus a reconnect adapter. The
   * status probe and reconnectMcp's send-keys both flow through this one client.
   * `tmux` is what the tmux-session prober reports (default alive); every name
   * it is asked about lands in `tmuxProbes`. `stub` is the shared client, for a
   * test that holds a launch's spawn open on it (`holdSpawns`).
   */
  function makeHarness(opts: {
    statusState?: string
    statusThrows?: boolean
    sendKeysThrows?: Error
    tmux?: 'alive' | 'gone' | 'probe-error'
  }): {
    adapter: (channelId: string) => Promise<'success' | 'escalate-dead' | 'transient'>
    statusCalls: StatusParams[]
    sendKeysCalls: SendKeysParams[]
    findMissingCalls: FindMissingParams[]
    tmuxProbes: string[]
    stub: StubClient
  } {
    const statusCalls: StatusParams[] = []
    const sendKeysCalls: SendKeysParams[] = []
    const findMissingCalls: FindMissingParams[] = []
    const tmuxProbes: string[] = []
    _setTmuxSessionProber(async (name) => {
      tmuxProbes.push(name)
      if (opts.tmux === 'probe-error') throw new Error('tmux probe failed')
      return opts.tmux !== 'gone'
    })
    const stub = makeStubClient({
      statusCalls,
      statusFn: () =>
        opts.statusThrows
          ? new Error('AD status probe failed')
          : { state: opts.statusState ?? 'waiting' },
      sendKeysCalls,
      sendKeysError: opts.sendKeysThrows,
      sendKeysResult: opts.sendKeysThrows ? undefined : {},
      // The escalate-dead sweep (reconcileMissingSweep → client.findMissing({}))
      // flows through this SAME stub client. `findMissingCalls` is the observable
      // seam for "was the memoized sweep triggered".
      findMissingCalls,
    })
    _resetOutageState()
    initOutageState({
      notify: () => {},
      getClient: () => stub as unknown as Client,
    })
    setClientForTests(stub as unknown as Client)
    // Seam: reconnectMcp's ErrTmuxSendKeys self-heal calls _ensureTmuxServer
    // between the two send-keys attempts. Stub it so the dead-session path
    // (double ErrTmuxSendKeys) never touches a live tmux server.
    _setTmuxServerEnsurer(async () => {})
    return {
      // The builder resolves the instance ID from the persona key alone
      // (b.av2 SR-2.2); it takes no config getter.
      adapter: _buildReconnectSessionAdapter(),
      statusCalls,
      sendKeysCalls,
      findMissingCalls,
      tmuxProbes,
      stub,
    }
  }

  /** Per-test temp directory (persona paths and the spawn home); removed in afterEach. */
  let dir: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'server-reconnect-'))
    // The escalate-dead sweep is memoized (b.m4r, 10s TTL). Clear the memo so a
    // sweep from another test can't satisfy this test's findMissing assertion —
    // the TTL setter alone does not clear an already-populated memo entry.
    _resetFindMissingMemo()
  })

  afterEach(() => {
    resetClientForTests()
    _resetOutageState()
    _resetTmuxServerEnsurer()
    _resetTmuxSessionProber()
    _resetFindMissingMemo()
    _resetInFlightLaunches()
    _resetSpawnHomeDir()
    rmSync(dir, { recursive: true, force: true })
  })

  test.each(['alive', 'probe-error'] as const)("(i) AD state 'working', tmux session %s → returns 'transient' and does NOT attempt the send-keys reconnect or sweep", async (tmux) => {
    const { adapter, statusCalls, sendKeysCalls, findMissingCalls, tmuxProbes } = makeHarness({ statusState: 'working', tmux })

    const result = await adapter('C1')

    expect(result).toBe('transient')
    // The persona's own tmux session was probed (the probe-error row: it ran
    // and threw, and the throw deferred rather than escalated).
    expect(tmuxProbes).toEqual(['slack_bot_C1'])
    // The probe ran against the persona's cscb_<key> instance...
    expect(statusCalls).toHaveLength(1)
    expect(statusCalls[0].claude_instance_id).toBe(personaInstanceId('C1'))
    expect(statusCalls[0].claude_instance_id).toBe('cscb_C1')
    // ...but the working-state defer short-circuited before reconnectMcp — no
    // `/mcp reconnect` was typed into the pane (b.rmy: a live turn is never
    // poked; a failed tmux probe is no proof the session is dead).
    expect(sendKeysCalls).toHaveLength(0)
    // b.9a7: the transient path never escalates, so no sweep fires.
    expect(findMissingCalls).toHaveLength(0)
  })

  test("(i-b) b.d61: AD state 'working' but the persona's tmux session is gone → 'escalate-dead' with one findMissing sweep, and no send-keys reconnect", async () => {
    // The live Check 7 shape: `tmux kill-session -t slack_bot_<key>` mid-turn
    // leaves AD's row frozen at `working`. Deferring it as 'transient' would
    // repeat on every tick and the persona would never relaunch.
    const { adapter, statusCalls, sendKeysCalls, findMissingCalls, tmuxProbes } = makeHarness({
      statusState: 'working',
      tmux: 'gone',
    })

    const result = await adapter('C1')

    expect(result).toBe('escalate-dead')
    expect(statusCalls.map((c) => c.claude_instance_id)).toEqual(['cscb_C1'])
    // The probe asked about the persona's own tmux session.
    expect(tmuxProbes).toEqual(['slack_bot_C1'])
    // Nothing is typed into a pane that no longer exists.
    expect(sendKeysCalls).toHaveLength(0)
    // The dead-tmux sweep reconciles the frozen row to `missing`, so the
    // restart run's liveness re-probe reads the session dead and relaunches it
    // in that same run.
    expect(findMissingCalls).toHaveLength(1)
  })

  test("(i-c) b.d61: AD state 'working' while a launch for the persona is in flight → 'transient' with no tmux probe, sweep or send-keys, even with its tmux session gone", async () => {
    // The launch resolves its unset claude_config_dir against a temp home.
    mkdirSync(join(dir, 'home', '.claude'), { recursive: true })
    _setSpawnHomeDir(join(dir, 'home'))
    const config = makeStandInPersonaConfig({ C1: {} }, dir)
    // Tmux gone: with nothing in flight this row escalates (i-b).
    const { adapter, stub, statusCalls, sendKeysCalls, findMissingCalls, tmuxProbes } = makeHarness({
      statusState: 'working',
      tmux: 'gone',
    })
    // A launch whose tmux session is not created yet: its spawn is held open.
    const held = holdSpawns(stub)
    const launch = spawnForPersona(config.personas[0]!, config, false)
    try {
      await held.entered('cscb_C1')
      expect(isLaunchInFlight('C1')).toBe(true)

      const result = await adapter('C1')

      expect(result).toBe('transient')
      expect(statusCalls.map((c) => c.claude_instance_id)).toEqual(['cscb_C1'])
      expect(tmuxProbes).toEqual([])
      expect(findMissingCalls).toHaveLength(0)
      expect(sendKeysCalls).toHaveLength(0)
    } finally {
      // Settle the held launch before teardown.
      held.releaseAll()
      await launch
    }
  })

  test("(ii) non-working live state ('waiting') → reconnect IS attempted, maps ok → 'success'", async () => {
    const { adapter, statusCalls, sendKeysCalls, findMissingCalls } = makeHarness({ statusState: 'waiting' })

    const result = await adapter('C1')

    // Not deferred: the send-keys reconnect ran and succeeded (reconnectMcp 'ok').
    expect(result).toBe('success')
    expect(statusCalls).toHaveLength(1)
    expect(sendKeysCalls).toHaveLength(1)
    expect(sendKeysCalls[0].text).toContain('/mcp reconnect')
    // Both the probe and the reconnect address cscb_<key>.
    expect(statusCalls[0].claude_instance_id).toBe('cscb_C1')
    expect(sendKeysCalls[0].claude_instance_id).toBe('cscb_C1')
    // b.9a7: the success path never escalates, so no sweep fires.
    expect(findMissingCalls).toHaveLength(0)
  })

  test('(iii) status-probe error → falls through to the reconnect attempt (no false transient)', async () => {
    const { adapter, statusCalls, sendKeysCalls, findMissingCalls } = makeHarness({ statusThrows: true })

    const result = await adapter('C1')

    // The probe threw, but the adapter must NOT manufacture a false defer — it
    // falls through to reconnectMcp, which here succeeds → 'success'.
    expect(result).toBe('success')
    expect(statusCalls).toHaveLength(1)
    expect(sendKeysCalls).toHaveLength(1)
    // Fell through to a successful reconnect, not escalate-dead — no sweep.
    expect(findMissingCalls).toHaveLength(0)
  })

  test("(iv) reconnectMcp 'dead-session' → 'escalate-dead', firing exactly one memoized findMissing sweep (b.sv7 / Epic t1.tkk.e4)", async () => {
    // Persistent ErrTmuxSendKeys: the first send-keys AND the self-heal retry
    // both fail, so reconnectMcp returns 'dead-session' (b.3ce). The status
    // probe is 'waiting' (not 'working'), so the adapter does NOT defer — it
    // falls through to reconnectMcp and the dead-session escalate branch.
    const { adapter, statusCalls, sendKeysCalls, findMissingCalls } = makeHarness({
      statusState: 'waiting',
      sendKeysThrows: errTmuxSendKeys(),
    })

    const result = await adapter('C1')

    // Mapping is byte-for-byte unchanged per b.9a7: dead-session → 'escalate-dead'.
    expect(result).toBe('escalate-dead')
    expect(statusCalls).toHaveLength(1)
    // Two send-keys attempts (original + one self-heal retry) both threw.
    expect(sendKeysCalls).toHaveLength(2)
    expect(sendKeysCalls.map((c) => c.claude_instance_id)).toEqual(['cscb_C1', 'cscb_C1'])
    // The escalate-dead branch fires sweepDeadTmuxChannel → the memoized
    // reconcileMissingSweep → exactly ONE client.findMissing({}). No direct new
    // findMissing call site; the memoized helper is the only sweep mechanism.
    expect(findMissingCalls).toHaveLength(1)
  })

  test('(v) the key passed selects the instance: a non-channel-form key probes and reconnects cscb_<key> (b.av2 SR-2.2)', async () => {
    const { adapter, statusCalls, sendKeysCalls } = makeHarness({ statusState: 'waiting' })

    const result = await adapter('ops_bot')

    expect(result).toBe('success')
    expect(statusCalls.map((c) => c.claude_instance_id)).toEqual([personaInstanceId('ops_bot')])
    expect(sendKeysCalls.map((c) => c.claude_instance_id)).toEqual(['cscb_ops_bot'])
  })
})
