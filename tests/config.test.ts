import { describe, test, expect, afterEach, beforeEach } from 'bun:test'
import {
  writeFileSync,
  mkdtempSync,
  mkdirSync,
  existsSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  symlinkSync,
  fstatSync,
  statSync,
} from 'fs'
import { spawnSync } from 'child_process'
import { tmpdir } from 'os'
import { join, relative, resolve } from 'path'
import { homedir } from 'os'
import {
  agentDirectorCallTimeoutMsOf,
  CHANNEL_MODES,
  channelModeOf,
  DM_DESTINATION,
  PERSONA_ENTRY_KEYS,
  PERSONA_INVITED_KEYS,
  type ChannelMode,
  type PersonaDmInput,
  type PersonaInvitedInput,
  DEFAULT_AGENT_DIRECTOR_CALL_TIMEOUT_MS,
  MAX_AGENT_DIRECTOR_CALL_TIMEOUT_MS,
  MIN_AGENT_DIRECTOR_CALL_TIMEOUT_MS,
  expandTilde,
  loadPersonaConfig,
  prePersonaConversionMessage,
  resolvePersonaConfig,
  resolveRealPath,
  resolveRealPathStrict,
  credentialsFilesToProtect,
  configFileReadFailureMessage,
  CONFIG_NOT_REGULAR_FILE_CODE,
  DEFAULT_PERSONA_CONFIG_FS,
  describeUnknownKeys,
  isMissingConfigCode,
  MAX_RELOAD_FILE_BYTES,
  parsePersonaConfigBytes,
  PersonaConfigReadError,
  personaKeysPrefixRelated,
  prefixRelatedKeysReason,
  readPersonaConfigBytes,
  referencedCredentialsPaths,
  resolveServerConfigPath,
  resolveServerStateDir,
  suggestNonPrefixingName,
  type PersonaConfigFs,
  type PersonaConfigInput,
  type PersonaInput,
} from '../src/config.ts'
import { personaKey, personaTmuxSessionName } from '../src/persona-identity.ts'
import { renderPersonaRef } from '../src/persona-identity.ts'
import { MODE_SWITCH_SETTING, RECORDED_SECTION_KEYS } from '../src/reload-plan.ts'
import { assertSendable } from '../src/lib.ts'
import {
  makeFungiblePersona,
  makeMultiPersonaConfig,
  makePersona,
  makePersonaConfig,
  makePersonaConfigInput,
  writeConfigFile,
} from './test-helpers/persona-config.ts'
import {
  APP_TOKEN_PREFIX,
  BOT_TOKEN_PREFIX,
  LEAK_SENTINEL,
  assertNoLeak,
  fakeToken,
  withoutName,
  writeCredentialsFile,
} from './test-helpers/credentials.ts'
import { makeFifo, mkfifoAvailable } from './test-helpers/fifo.ts'
import { hostSafeChildEnv } from './test-helpers/host-safe-env.ts'

// ---------------------------------------------------------------------------
// expandTilde()
//
// expandTilde takes no home argument and Bun fixes os.homedir() at start-up,
// so these cases compare against the process home. They only build strings:
// nothing under that home is read or written.
// ---------------------------------------------------------------------------

describe('expandTilde', () => {
  test('replaces ~ alone with home directory', () => {
    expect(expandTilde('~')).toBe(homedir())
  })

  test('replaces ~/ prefix with home directory', () => {
    const result = expandTilde('~/projects/foo')
    expect(result).toBe(homedir() + '/projects/foo')
  })

  test('leaves absolute paths unchanged', () => {
    expect(expandTilde('/absolute/path/to/file')).toBe('/absolute/path/to/file')
  })

  test('leaves relative paths unchanged', () => {
    expect(expandTilde('relative/path')).toBe('relative/path')
  })

  test('does not expand ~ in the middle of a string', () => {
    expect(expandTilde('/path/~/middle')).toBe('/path/~/middle')
  })

  test('expanded path starts with home dir', () => {
    const result = expandTilde('~/foo')
    expect(result.startsWith(homedir())).toBe(true)
  })
})

// ===========================================================================
// Persona configuration loader (b.av2 SR-1.1–1.3, 1.5, 1.6, 1.7) and its
// real-path helper
//
// Every case writes its file into its own mkdtempSync directory and loads it
// with an injected mkdtempSync home (b.av2 SR-13.2); both are removed after
// each case. Directories, placeholder credentials files and symlinks live in
// that temp directory too. The loader lives in src/config.ts, so no
// child-process import purity test is added here (b.av2 SR-13.1).
// ===========================================================================

/**
 * Non-token-shaped stand-in for a secret, a rejected value or the content of a
 * credentials file; must never reach an error.
 */
const PLACEHOLDER = 'placeholder_not_a_secret'

describe('resolveRealPath (b.av2 SR-1.5)', () => {
  let tmp: string
  /** The temp root's own real path: the temp root may itself sit behind a symlink. */
  let real: string

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'real-path-'))
    real = realpathSync(tmp)
    mkdirSync(join(tmp, 'dir'))
    mkdirSync(join(tmp, 'other'))
    writeFileSync(join(tmp, 'dir', 'file.json'), PLACEHOLDER)
    symlinkSync(join(tmp, 'dir'), join(tmp, 'dir-link'))
    symlinkSync(join(tmp, 'dir', 'file.json'), join(tmp, 'file-link.json'))
    symlinkSync(join(tmp, 'absent'), join(tmp, 'dangling'))
  })

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true })
  })

  /** `rel` appended to the temp root as text, so `.`, `..` and trailing `/` survive. */
  const at = (rel: string) => `${tmp}/${rel}`
  const listing = () => readdirSync(tmp, { recursive: true }).sort()

  test.each([
    ['an existing directory', 'dir', 'real', 'dir'],
    ['an existing file', 'dir/file.json', 'real', 'dir/file.json'],
    ['a symlink to the directory', 'dir-link', 'real', 'dir'],
    ['a symlink to the file', 'file-link.json', 'real', 'dir/file.json'],
    ['a path through a symlinked parent directory', 'dir-link/file.json', 'real', 'dir/file.json'],
    ['a non-existent path', 'missing/x', 'lexical', 'missing/x'],
    ['a non-existent path with a trailing slash', 'missing/x/', 'lexical', 'missing/x'],
    ['a non-existent path with a . segment', 'missing/./x', 'lexical', 'missing/x'],
    ['a non-existent path with a .. segment', 'missing/y/../x', 'lexical', 'missing/x'],
    ['a dangling symlink, without throwing', 'dangling', 'lexical', 'dangling'],
  ] as const)('%s (%s) resolves to its %s form and writes nothing', (_label, input, form, expected) => {
    const before = listing()
    expect(resolveRealPath(at(input))).toBe(resolve(form === 'real' ? real : tmp, expected))
    expect(listing()).toEqual(before)
  })

  test.each([
    ['two different non-existent paths', 'missing/x', 'missing/y'],
    ['a symlink to one directory and an unrelated existing directory', 'dir-link', 'other'],
  ])('%s resolve to different values', (_label, a, b) => {
    expect(resolveRealPath(at(a))).not.toBe(resolveRealPath(at(b)))
  })

  test('an injected realpath that throws gives the lexical form, not the symlink target', () => {
    const fails = () => {
      throw new Error('simulated realpath failure')
    }
    expect(resolveRealPath(at('dir/../dir-link/'), fails)).toBe(join(tmp, 'dir-link'))
  })

  test('an injected realpath that returns a value is used as is', () => {
    const calls: string[] = []
    const injected = (path: string) => {
      calls.push(path)
      return join(tmp, 'injected')
    }
    expect(resolveRealPath(at('dir-link'), injected)).toBe(join(tmp, 'injected'))
    expect(calls).toEqual([at('dir-link')])
  })
})

describe('loadPersonaConfig (b.av2 SR-1)', () => {
  let dir: string
  let home: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'persona-config-'))
    home = mkdtempSync(join(tmpdir(), 'persona-home-'))
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
    rmSync(home, { recursive: true, force: true })
  })

  const load = (input: unknown) => loadPersonaConfig(writeConfigFile(dir, input), home)

  /**
   * Load `input`, expecting rejection; returns the message after checking it
   * leaks no placeholder and that the whole error passes `assertNoLeak` (the
   * config leg of AC 20), so every rejection case built on it is leak-checked.
   * `name` is a token-shaped persona name the error is meant to carry: it and
   * its key are masked first (`withoutName`), and the rest of the error is
   * leak-checked as usual.
   */
  function loadError(input: unknown, name?: string): string {
    let error: Error | undefined
    try {
      load(input)
    } catch (err) {
      error = err as Error
    }
    if (error === undefined) throw new Error('expected loadPersonaConfig to reject the configuration')
    if (name === undefined) assertNoLeak(error, 'rejection')
    else assertNoLeak(withoutName(error, name, personaKey(name)), 'rejection without the name')
    expect(error.message).not.toContain(PLACEHOLDER)
    return error.message
  }

  /** The b.av2 SR-2.2 persona reference: JSON-quoted name with its key. */
  function expectNamesPersona(message: string, name: string): void {
    expect(message).toContain(`${JSON.stringify(name)} (key=${personaKey(name)})`)
  }

  const withPersonas = (...personas: PersonaInput[]) => makePersonaConfigInput({ personas })

  describe('valid load', () => {
    test('AC 3 / AC 16: two personas sharing a channel, one also in a second channel, resolve with keys and defaults — the two-channel persona loads as a single persona holding both channels, and both personas hold the shared channel as delivery: all', () => {
      const config = load(withPersonas(
        makePersona({
          name: 'Ops Bot',
          channels: [{ id: 'C0TEST001', delivery: 'all' }, { id: 'G0TEST002', delivery: 'all' }],
          dm: undefined,
        }),
        makePersona({ name: 'review_bot' }),
      ))
      expect(config.personas.map((p) => [p.index, p.name, p.key])).toEqual([
        [0, 'Ops Bot', personaKey('Ops Bot')],
        [1, 'review_bot', personaKey('review_bot')],
      ])
      expect(config.personas[0].channels).toEqual([
        { id: 'C0TEST001', delivery: 'all' },
        { id: 'G0TEST002', delivery: 'all' },
      ])
      expect(config.personas[1].channels).toEqual([{ id: 'C0TEST001', delivery: 'all' }])
      // AC 3: the persona in two channels is one persona, not one per channel.
      expect(config.personas.filter((p) => p.name === 'Ops Bot')).toHaveLength(1)
      for (const persona of config.personas) {
        expect(persona.dm).toEqual({ enabled: false })
        expect('contact' in persona.dm).toBe(false)
        expect('claude_config_dir' in persona).toBe(false)
        expect(persona.stop_hook_bootstrap).toBe(true)
      }
    })

    test('the default input resolves to the makePersonaConfig shape', () => {
      const config = load(makePersonaConfigInput({}, dir))
      expect(config).toEqual(makePersonaConfig({ mcp_config_path: join(home, '.claude', 'slack-mcp.json') }, dir))
      // Fixed values: makePersonaConfig takes each default from the same constant.
      expect(config.agent_director_poll_interval_ms).toBe(1000)
      expect(config.agent_director_call_timeout_ms).toBe(60000)
    })

    test('a mentions channel loads', () => {
      const config = load(withPersonas(makePersona({ channels: [{ id: 'C0TEST001', delivery: 'mentions' }] })))
      expect(config.personas[0].channels).toEqual([{ id: 'C0TEST001', delivery: 'mentions' }])
    })

    test('a ~ config path is expanded under the injected home', () => {
      writeConfigFile(home, makePersonaConfigInput())
      expect(loadPersonaConfig('~/config.json', home).cron_table_path).toBe(join(home, 'crontab'))
    })
  })

  describe('empty and zero-channel shapes', () => {
    test('an empty personas array loads (AC 54 config leg)', () => {
      expect(load({ personas: [] }).personas).toEqual([])
    })

    test('a zero-channel DM-only persona loads, channels defaulting to empty (AC 40/41 config leg)', () => {
      const persona = makePersona({
        channels: undefined,
        dm: { enabled: true, contact: 'U0TEST001' },
        permission_prompts: 'dm',
      })
      const [resolved] = load(withPersonas(persona)).personas
      expect(resolved.channels).toEqual([])
      expect(resolved.dm).toEqual({ enabled: true, contact: 'U0TEST001' })
      expect(resolved.permission_prompts).toBe('dm')
    })

    test.each([
      ['missing', 'personas', {}],
      ['an object', 'personas', { personas: {} }],
      ['a string', 'personas', { personas: 'none' }],
      ['holding a null entry', 'personas[0]', { personas: [null] }],
    ])('personas %s is rejected, naming %s', (_label, named, input) => {
      expect(loadError(input)).toContain(named)
    })
  })

  describe('claude_config_dir and stop_hook_bootstrap inheritance (SR-1.2, SR-10.2; AC 48 config leg)', () => {
    test.each([
      ['neither set: absent and true', {}, {}, undefined, true],
      ['top-level only: inherited', { claude_config_dir: '~/cfg-top', stop_hook_bootstrap: false }, {}, 'cfg-top', false],
      [
        'per-persona wins over top-level',
        { claude_config_dir: '~/cfg-top', stop_hook_bootstrap: false },
        { claude_config_dir: '~/cfg-own', stop_hook_bootstrap: true },
        'cfg-own',
        true,
      ],
    ])('%s', (_label, top, own, expectedDir, expectedStopHook) => {
      const [persona] = load({ ...makePersonaConfigInput(top), personas: [makePersona(own)] }).personas
      expect(persona.claude_config_dir).toBe(expectedDir === undefined ? undefined : join(home, expectedDir))
      expect(persona.stop_hook_bootstrap).toBe(expectedStopHook)
    })
  })

  describe('persona path rules (SR-1.2)', () => {
    test.each([
      ['credentials_file', '~/creds/ops.json'],
      ['working_directory', '~'],
      ['claude_config_dir', '~/cfg'],
    ] as const)('%s accepts %s, expanded under the injected home', (setting, value) => {
      const [persona] = load(withPersonas(makePersona({ [setting]: value }))).personas
      expect(persona[setting]).toBe(value === '~' ? home : join(home, value.slice(2)))
    })

    test('absolute paths that do not exist load: existence is not a load-time check', () => {
      const paths = {
        credentials_file: join(dir, 'missing', 'credentials.json'),
        working_directory: join(dir, 'missing', 'work'),
        claude_config_dir: join(dir, 'missing', 'claude'),
      }
      const [persona] = load(withPersonas(makePersona(paths))).personas
      expect(persona).toMatchObject(paths)
      for (const path of Object.values(paths)) expect(existsSync(path)).toBe(false)
    })

    test.each([
      ['credentials_file', 'relative/credentials.json'],
      ['working_directory', '~other/work'],
      ['claude_config_dir', './claude'],
    ])('%s rejects %s, naming the persona and the key', (setting, value) => {
      const message = loadError(withPersonas(makePersona({ name: 'Ops Bot', [setting]: value }, dir)))
      expectNamesPersona(message, 'Ops Bot')
      expect(message).toContain(setting)
      expect(message).not.toContain(value)
    })
  })

  describe('unknown keys (SR-1.1, SR-1.2; AC 20 config leg)', () => {
    // Table inputs are built at registration, before `dir` exists, so these
    // personas keep the helper's default base dir; each case is rejected per
    // entry, before any path is resolved.
    const persona = (overrides: Record<string, unknown>) =>
      withPersonas(makePersona({ name: 'Ops Bot', ...overrides } as Partial<PersonaInput>))

    /** The start of each level's unknown-key sentence, which names where the key is. */
    const WHERE = {
      top: 'unknown top-level field(s) in config.json: ',
      entry: 'unknown field(s) in the persona entry: ',
      dm: 'unknown field(s) in dm: ',
      channel: 'unknown field(s) in channels[0]: ',
    }
    const inDm = (extra: Record<string, unknown>) => persona({ dm: { enabled: false, ...extra } })
    const inChannel = (extra: Record<string, unknown>) =>
      persona({ channels: [{ id: 'C0TEST001', delivery: 'all', ...extra }] })

    // The credentials keys hold sentinel-bearing fake tokens at every level:
    // loadError's assertNoLeak proves the error names the level and the key
    // but never echoes the value.
    test.each([
      ['top-level', { ...makePersonaConfigInput(), extra_setting: 1 }, 'extra_setting', WHERE.top, false],
      ['top-level bot_token', { ...makePersonaConfigInput(), bot_token: fakeToken(BOT_TOKEN_PREFIX, 'top') }, 'bot_token', WHERE.top, false],
      ['top-level app_token', { ...makePersonaConfigInput(), app_token: fakeToken(APP_TOKEN_PREFIX, 'top') }, 'app_token', WHERE.top, false],
      ['persona entry', persona({ nickname: 'ops' }), 'nickname', WHERE.entry, true],
      ['persona entry bot_token', persona({ bot_token: fakeToken(BOT_TOKEN_PREFIX, 'entry') }), 'bot_token', WHERE.entry, true],
      ['persona entry app_token', persona({ app_token: fakeToken(APP_TOKEN_PREFIX, 'entry') }), 'app_token', WHERE.entry, true],
      ['persona entry route-era cwd (SR-10.2)', persona({ cwd: '/tmp/somewhere' }), 'cwd', WHERE.entry, true],
      // Server-wide only (b.jg5 SRJ-213): a persona entry cannot set it.
      [
        'persona entry server-wide agent_director_call_timeout_ms',
        persona({ agent_director_call_timeout_ms: DEFAULT_AGENT_DIRECTOR_CALL_TIMEOUT_MS }),
        'agent_director_call_timeout_ms',
        WHERE.entry,
        true,
      ],
      // Server-wide only (b.b1j SR-1): a persona entry cannot set it, even to a valid boolean.
      ['persona entry server-wide fresh_system_prompt', persona({ fresh_system_prompt: true }), 'fresh_system_prompt', WHERE.entry, true],
      ['dm object', inDm({ relay: true }), 'relay', WHERE.dm, true],
      ['dm object bot_token', inDm({ bot_token: fakeToken(BOT_TOKEN_PREFIX, 'dm') }), 'bot_token', WHERE.dm, true],
      ['dm object app_token', inDm({ app_token: fakeToken(APP_TOKEN_PREFIX, 'dm') }), 'app_token', WHERE.dm, true],
      ['channel entry', inChannel({ label: 'ops' }), 'label', WHERE.channel, true],
      ['channel entry bot_token', inChannel({ bot_token: fakeToken(BOT_TOKEN_PREFIX, 'channel') }), 'bot_token', WHERE.channel, true],
      ['channel entry app_token', inChannel({ app_token: fakeToken(APP_TOKEN_PREFIX, 'channel') }), 'app_token', WHERE.channel, true],
    ])('an unknown key in the %s is rejected, naming where it is and the key', (_label, input, key, where, inPersona) => {
      const message = loadError(input)
      expect(message).toContain(`${where}${JSON.stringify(key)}.`)
      if (inPersona) expectNamesPersona(message, 'Ops Bot')
    })

    // Director decision 5: a key whose name could be a pasted token is counted, never echoed.
    // loadError's assertNoLeak fails if the name (each embeds the sentinel) reaches the error.
    const ONE_HIDDEN = '1 field whose name is not shown (it is not a plain setting name, so it could be a pasted secret).'
    const tokenNames: [string, string][] = [
      ['an xoxb- token', fakeToken(BOT_TOKEN_PREFIX, 'key')],
      ['an xapp- token', fakeToken(APP_TOKEN_PREFIX, 'key')],
      ['a ghp_ token', fakeToken('ghp_')],
    ]
    const levels: [string, (name: string) => unknown, string][] = [
      ['top-level', name => ({ ...makePersonaConfigInput(), [name]: 1 }), WHERE.top],
      ['persona entry', name => persona({ [name]: 1 }), WHERE.entry],
      ['dm object', name => inDm({ [name]: true }), WHERE.dm],
      ['channel entry', name => inChannel({ [name]: 'x' }), WHERE.channel],
    ]
    test.each(levels.flatMap(([level, build, where]) =>
      tokenNames.map(([what, name]): [string, string, unknown, string] => [level, what, build(name), where])))(
      'an unknown key in the %s named with %s is rejected with a count, never its name', (level, _what, input, where) => {
        const message = loadError(input)
        expect(message).toContain(`${where}${ONE_HIDDEN}`)
        if (level !== 'top-level') expectNamesPersona(message, 'Ops Bot')
      })

    test('a plain typo beside a token-named key is still echoed, and only the token-named one is counted', () => {
      const message = loadError({ ...makePersonaConfigInput(), chanels: [], [fakeToken(BOT_TOKEN_PREFIX, 'key')]: 1 })
      expect(message).toContain(`unknown top-level field(s) in config.json: "chanels", plus ${ONE_HIDDEN}`)
    })
  })

  describe('dm and channel shapes, channel and contact formats (SR-1.2, SR-1.3, SR-1.5)', () => {
    test.each([
      ['a non-object dm', { dm: true }, 'dm'],
      ['a non-array channels', { channels: PLACEHOLDER }, 'channels'],
      ['a non-object channel entry', { channels: [null] }, 'channels[0]'],
      ['a channel ID not matching ^[CG][A-Z0-9]+$', { channels: [{ id: 'D0TEST001', delivery: 'all' }] }, 'channels[0].id'],
      ['a missing channel id', { channels: [{ delivery: 'all' }] }, 'channels[0].id'],
      ['a missing delivery', { channels: [{ id: 'C0TEST001' }] }, 'channels[0].delivery'],
      ['an unsupported delivery', { channels: [{ id: 'C0TEST001', delivery: PLACEHOLDER }] }, 'channels[0].delivery'],
      ['a dm.contact not matching ^[UW][A-Z0-9]+$', { dm: { enabled: true, contact: 'B0TEST001' } }, 'dm.contact'],
      [
        'the same channel listed twice',
        { channels: [{ id: 'C0TEST001', delivery: 'all' }, { id: 'C0TEST001', delivery: 'mentions' }] },
        'C0TEST001',
      ],
    ])('%s is rejected, naming the persona and the key or channel', (_label, overrides, named) => {
      const message = loadError(withPersonas(makePersona({ name: 'Ops Bot', ...overrides } as Partial<PersonaInput>, dir)))
      expectNamesPersona(message, 'Ops Bot')
      expect(message).toContain(named)
    })
  })

  describe('type and range errors (SR-1.5)', () => {
    test.each([
      ['an empty name', { name: '' }, 'name'],
      ['a whitespace-only name', { name: '   ' }, 'name'],
      ['a non-string name', { name: 42 }, 'name'],
    ])('%s is rejected, naming personas[i] and the setting', (_label, overrides, setting) => {
      const message = loadError(withPersonas(makePersona(overrides as Partial<PersonaInput>, dir)))
      expect(message).toContain(`personas[0]: ${setting}`)
    })

    test.each([
      ['a missing credentials_file', { credentials_file: undefined }, 'credentials_file'],
      ['a missing working_directory', { working_directory: undefined }, 'working_directory'],
      ['a non-boolean dm.enabled', { dm: { enabled: 'yes' } }, 'dm.enabled'],
      ['a non-boolean stop_hook_bootstrap', { stop_hook_bootstrap: 'false' }, 'stop_hook_bootstrap'],
      ['an empty claude_config_dir', { claude_config_dir: '' }, 'claude_config_dir'],
      ['a permission_prompts that is neither dm nor a channel ID', { permission_prompts: PLACEHOLDER }, 'permission_prompts'],
    ])('%s is rejected, naming the persona and the setting', (_label, overrides, setting) => {
      const message = loadError(withPersonas(makePersona({ name: 'Ops Bot', ...overrides } as Partial<PersonaInput>, dir)))
      expectNamesPersona(message, 'Ops Bot')
      expect(message).toContain(setting)
    })
  })

  describe('SR-14 rejection table and cross-persona rules (SR-1.5; AC 21, 30, 32, 33, 42, 43, 53)', () => {
    /** A name needing normalisation whose key is longer than 40 characters, so a persona named by that key has another key. */
    const LONG_NAME = 'Operations Review And Deployment Assistant Bot'
    const LONG_KEY = personaKey(LONG_NAME)
    /** An in-form name that is its own key and equals the derived key of 'Ops Bot'. */
    const OPS_KEY = personaKey('Ops Bot')
    /** Slack token prefixes; no error may contain one (loadError's `assertNoLeak` checks the whole error too). */
    const TOKEN_LIKE = /\bx(?:ox[a-z]|app)-/

    const inDir = (rel: string) => join(dir, rel)
    const makeDir = (rel: string) => {
      mkdirSync(inDir(rel), { recursive: true })
      return inDir(rel)
    }
    /** A real 0600 credentials file holding sentinel-bearing fake tokens, which no error may echo. */
    const makeCredentials = (rel: string) => writeCredentialsFile(dir, rel)
    const makeLink = (target: string, rel: string) => {
      symlinkSync(target, inDir(rel))
      return inDir(rel)
    }

    /**
     * Personas in array order, each with its own non-existent paths under the
     * temp dir (`p<i>/work`, `p<i>/credentials.json`) unless overridden, so a
     * case collides only where it says so.
     */
    const personasOf = (...entries: [string, Partial<PersonaInput>?][]) =>
      entries.map(([name, overrides], i) =>
        makePersona(
          { name, working_directory: inDir(`p${i}/work`), credentials_file: inDir(`p${i}/credentials.json`), ...overrides },
          dir,
        ))

    /** `personas[i]` plus the b.av2 SR-2.2 reference (JSON-quoted name with its key). */
    const indexedRef = (index: number, name: string) =>
      `personas[${index}] ${JSON.stringify(name)} (key=${personaKey(name)})`

    interface RejectionRow {
      ac: string
      label: string
      /** The offending personas by array position; the error names each and no other persona. */
      offenders: [number, string][]
      /** The offending settings or channel, shown in the title and named by the error. */
      settings: string[]
      /** Builds the personas (creating any files) and the further values the error must name. */
      build: () => { personas: PersonaInput[]; named?: string[] }
    }

    const rejectionRows: RejectionRow[] = [
      // Per-entry rows (Task 2)
      {
        ac: '33',
        label: 'missing permission_prompts',
        offenders: [[0, 'Ops Bot']],
        settings: ['permission_prompts'],
        build: () => ({ personas: [makePersona({ name: 'Ops Bot', permission_prompts: undefined }, dir)] }),
      },
      {
        ac: '30',
        label: 'permission_prompts dm without dm.contact',
        offenders: [[0, 'Say "hi" Bot']],
        settings: ['permission_prompts', 'dm.contact'],
        build: () => ({
          personas: [makePersona({ name: 'Say "hi" Bot', dm: { enabled: true }, permission_prompts: 'dm' }, dir)],
        }),
      },
      {
        ac: '32',
        label: 'destination channel not in the persona channels',
        offenders: [[0, 'Ops Bot']],
        settings: ['permission_prompts', 'C0TEST999'],
        build: () => ({ personas: [makePersona({ name: 'Ops Bot', permission_prompts: 'C0TEST999' }, dir)] }),
      },
      {
        ac: '42',
        label: 'zero channels with dm.enabled false',
        offenders: [[0, 'ops_bot']],
        settings: ['dm.enabled'],
        build: () => ({ personas: [makePersona({ name: 'ops_bot', channels: [], dm: { enabled: false } }, dir)] }),
      },
      {
        ac: '42',
        label: 'zero channels with dm absent',
        offenders: [[0, 'Ops Bot']],
        settings: ['dm.enabled'],
        build: () => ({ personas: [makePersona({ name: 'Ops Bot', channels: undefined, dm: undefined }, dir)] }),
      },
      {
        ac: '43',
        label: 'dm destination with dm.enabled false',
        offenders: [[0, 'Ops Bot']],
        settings: ['permission_prompts', 'dm.enabled'],
        build: () => ({
          personas: [makePersona({ name: 'Ops Bot', dm: { enabled: false, contact: 'U0TEST001' }, permission_prompts: 'dm' }, dir)],
        }),
      },
      {
        ac: '30 + 43',
        label: 'dm destination with neither dm.enabled nor dm.contact',
        offenders: [[0, 'Ops Bot']],
        settings: ['permission_prompts', 'dm.contact', 'dm.enabled'],
        build: () => ({ personas: [makePersona({ name: 'Ops Bot', permission_prompts: 'dm' }, dir)] }),
      },
      // Cross-persona rows: name and key
      {
        ac: '53',
        label: 'the same name twice',
        offenders: [[0, 'Ops Bot'], [1, 'Ops Bot']],
        settings: ['name'],
        build: () => ({ personas: personasOf(['Ops Bot'], ['Ops Bot']), named: [`name ${JSON.stringify('Ops Bot')}`] }),
      },
      {
        ac: '53',
        label: "an in-form name equal to another persona's derived key",
        offenders: [[0, 'Ops Bot'], [1, OPS_KEY]],
        settings: ['key'],
        build: () => ({ personas: personasOf(['Ops Bot'], [OPS_KEY]), named: [`key ${OPS_KEY}`] }),
      },
      {
        ac: '53',
        label: "a later name equal to an earlier persona's long key (names and keys differ)",
        offenders: [[0, LONG_NAME], [1, LONG_KEY]],
        settings: ['name'],
        build: () => ({ personas: personasOf([LONG_NAME], [LONG_KEY]), named: [`name ${JSON.stringify(LONG_KEY)}`] }),
      },
      {
        ac: '53',
        label: "a later persona's long key equal to an earlier name (names and keys differ)",
        offenders: [[0, LONG_KEY], [1, LONG_NAME]],
        settings: ['key'],
        build: () => ({ personas: personasOf([LONG_KEY], [LONG_NAME]), named: [`key ${LONG_KEY}`] }),
      },
      {
        ac: '53',
        label: 'the same name on the second and third of three personas (the first distinct)',
        offenders: [[1, 'review_bot'], [2, 'review_bot']],
        settings: ['name'],
        build: () => ({
          personas: personasOf(['Ops Bot'], ['review_bot'], ['review_bot']),
          named: [`name ${JSON.stringify('review_bot')}`],
        }),
      },
      {
        ac: '53',
        label: 'the same key on the second and third of three personas (the first distinct)',
        offenders: [[1, 'Ops Bot'], [2, OPS_KEY]],
        settings: ['key'],
        build: () => ({ personas: personasOf(['deploy_bot'], ['Ops Bot'], [OPS_KEY]), named: [`key ${OPS_KEY}`] }),
      },
      // Cross-persona rows: credentials_file
      {
        ac: '53',
        label: 'the same literal path',
        offenders: [[0, 'Ops Bot'], [1, 'review_bot']],
        settings: ['credentials_file'],
        build: () => {
          const shared = inDir('shared/credentials.json')
          return {
            personas: personasOf(['Ops Bot', { credentials_file: shared }], ['review_bot', { credentials_file: shared }]),
            named: [JSON.stringify(shared)],
          }
        },
      },
      {
        ac: '53',
        label: 'a ~/ form against its expansion under the injected home',
        offenders: [[0, 'Ops Bot'], [1, 'review_bot']],
        settings: ['credentials_file'],
        build: () => {
          const expanded = join(home, 'creds', 'ops.json')
          return {
            personas: personasOf(
              ['Ops Bot', { credentials_file: '~/creds/ops.json' }],
              ['review_bot', { credentials_file: expanded }],
            ),
            named: [JSON.stringify(expanded)],
          }
        },
      },
      {
        ac: '53',
        label: "a symlink to the other persona's existing file",
        offenders: [[0, 'Ops Bot'], [1, 'review_bot']],
        settings: ['credentials_file'],
        build: () => {
          const target = makeCredentials('ops-credentials.json')
          const link = makeLink(target, 'review-credentials.json')
          return {
            personas: personasOf(['Ops Bot', { credentials_file: target }], ['review_bot', { credentials_file: link }]),
            named: [target, link, realpathSync(target)].map((path) => JSON.stringify(path)),
          }
        },
      },
      {
        ac: '53',
        label: 'the second and the third of three personas (the first distinct)',
        offenders: [[1, 'review_bot'], [2, 'deploy_bot']],
        settings: ['credentials_file'],
        build: () => {
          const shared = inDir('shared/credentials.json')
          return {
            personas: personasOf(
              ['Ops Bot'],
              ['review_bot', { credentials_file: shared }],
              ['deploy_bot', { credentials_file: shared }],
            ),
            named: [JSON.stringify(shared)],
          }
        },
      },
      // Cross-persona rows: working_directory
      {
        ac: '21',
        label: 'the same literal path',
        offenders: [[0, 'Ops Bot'], [1, 'review_bot']],
        settings: ['working_directory'],
        build: () => {
          const shared = inDir('shared-work')
          return {
            personas: personasOf(['Ops Bot', { working_directory: shared }], ['review_bot', { working_directory: shared }]),
            named: [JSON.stringify(shared)],
          }
        },
      },
      {
        ac: '21',
        label: 'a trailing-slash spelling of the same non-existent path',
        offenders: [[0, 'Ops Bot'], [1, 'review_bot']],
        settings: ['working_directory'],
        build: () => {
          const work = inDir('work')
          return {
            personas: personasOf(['Ops Bot', { working_directory: work }], ['review_bot', { working_directory: `${work}/` }]),
            named: [JSON.stringify(work)],
          }
        },
      },
      {
        ac: '21',
        label: "a symlink to the other persona's existing directory, reached through a symlinked parent",
        offenders: [[0, 'Ops Bot'], [1, 'review_bot']],
        settings: ['working_directory'],
        build: () => {
          // Three distinct spellings: the configured path of each persona and the shared real path.
          const target = makeDir('real/ops-work')
          const viaParent = join(makeLink(inDir('real'), 'real-link'), 'ops-work')
          const link = makeLink(target, 'review-work')
          return {
            personas: personasOf(['Ops Bot', { working_directory: viaParent }], ['review_bot', { working_directory: link }]),
            named: [viaParent, link, realpathSync(target)].map((path) => JSON.stringify(path)),
          }
        },
      },
      {
        ac: '21',
        label: 'the first and the third of three personas',
        offenders: [[0, 'Ops Bot'], [2, 'deploy_bot']],
        settings: ['working_directory'],
        build: () => {
          const shared = inDir('shared-work')
          return {
            personas: personasOf(
              ['Ops Bot', { working_directory: shared }],
              ['review_bot'],
              ['deploy_bot', { working_directory: shared }],
            ),
            named: [JSON.stringify(shared)],
          }
        },
      },
      {
        ac: '21',
        label: 'the second and the third of three personas (the first distinct)',
        offenders: [[1, 'review_bot'], [2, 'deploy_bot']],
        settings: ['working_directory'],
        build: () => {
          const shared = inDir('shared-work')
          return {
            personas: personasOf(
              ['Ops Bot'],
              ['review_bot', { working_directory: shared }],
              ['deploy_bot', { working_directory: shared }],
            ),
            named: [JSON.stringify(shared)],
          }
        },
      },
    ]

    test.each(
      rejectionRows.map((row) => ({
        ...row,
        who: row.offenders.map(([, name]) => JSON.stringify(name)).join(' and '),
        setting: row.settings.join(', '),
      })),
    )('AC $ac: $who, $setting: $label', ({ offenders, settings, build }) => {
      const { personas, named = [] } = build()
      const message = loadError(withPersonas(...personas))
      for (const [index, name] of offenders) expect(message).toContain(indexedRef(index, name))
      personas.forEach((_, i) => {
        if (!offenders.some(([index]) => index === i)) expect(message).not.toContain(`personas[${i}]`)
      })
      for (const value of [...settings, ...named]) expect(message).toContain(value)
      expect(message).not.toMatch(TOKEN_LIKE)
    })

    test.each([
      [
        'different existing working directories and credentials files',
        () =>
          personasOf(
            ['Ops Bot', { working_directory: makeDir('ops-work'), credentials_file: makeCredentials('ops.json') }],
            ['review_bot', { working_directory: makeDir('review-work'), credentials_file: makeCredentials('review.json') }],
          ),
      ],
      [
        "a symlink to a directory other than the other persona's",
        () =>
          personasOf(
            ['Ops Bot', { working_directory: makeDir('ops-work') }],
            ['review_bot', { working_directory: makeLink(makeDir('elsewhere'), 'review-work') }],
          ),
      ],
      ['two distinct non-existent paths per setting', () => personasOf(['Ops Bot'], ['review_bot'])],
      ['names normalising to the same stem with different keys', () => personasOf(['Ops Bot'], ['OPS BOT'])],
      [
        "one persona's working_directory equal to another's credentials_file",
        () =>
          personasOf(
            ['Ops Bot', { working_directory: inDir('shared') }],
            ['review_bot', { credentials_file: inDir('shared') }],
          ),
      ],
    ])('non-collision control loads: %s', (_label, build) => {
      const personas = build()
      const config = load(withPersonas(...personas))
      assertNoLeak(config, 'config')
      expect(config.personas.map((p) => p.name)).toEqual(personas.map((p) => p.name))
    })

    test.each([
      {
        label: 'of two per-entry violations, the first persona',
        build: () => [
          makePersona({ name: 'first_bot', permission_prompts: undefined }, dir),
          makePersona({ name: 'second_bot', channels: [] }, dir),
        ],
        reported: [[0, 'first_bot']] as [number, string][],
        named: 'permission_prompts',
        absent: ['second_bot'],
      },
      {
        label: 'a later per-entry violation before an earlier duplicate name',
        build: () => personasOf(['Ops Bot'], ['Ops Bot'], ['third_bot', { permission_prompts: undefined }]),
        reported: [[2, 'third_bot']] as [number, string][],
        named: 'permission_prompts',
        absent: ['"Ops Bot"', 'duplicated'],
      },
      {
        label: 'a later duplicate name before an earlier duplicate working_directory',
        build: () =>
          personasOf(
            ['Ops Bot', { working_directory: inDir('shared-work') }],
            ['review_bot', { working_directory: inDir('shared-work') }],
            ['Ops Bot'],
          ),
        reported: [[0, 'Ops Bot'], [2, 'Ops Bot']] as [number, string][],
        named: `name ${JSON.stringify('Ops Bot')}`,
        absent: ['working_directory', 'personas[1]'],
      },
      {
        label: 'a later duplicate working_directory before an earlier duplicate credentials_file',
        build: () =>
          personasOf(
            ['Ops Bot', { credentials_file: inDir('shared.json') }],
            ['review_bot', { credentials_file: inDir('shared.json') }],
            ['deploy_bot', { working_directory: inDir('p0/work') }],
          ),
        reported: [[0, 'Ops Bot'], [2, 'deploy_bot']] as [number, string][],
        named: 'working_directory',
        absent: ['credentials_file', 'personas[1]'],
      },
    ])('only the first violation is reported: $label', ({ build, reported, named, absent }) => {
      const message = loadError(withPersonas(...build()))
      for (const [index, name] of reported) expect(message).toContain(indexedRef(index, name))
      expect(message).toContain(named)
      for (const fragment of absent) expect(message).not.toContain(fragment)
    })

    test('resolvePersonaConfig rejects a symlinked working_directory duplicate as the loader does', () => {
      const target = makeDir('ops-work')
      const input = withPersonas(...personasOf(
        ['Ops Bot', { working_directory: target }],
        ['review_bot', { working_directory: makeLink(target, 'review-work') }],
      ))
      let pure = ''
      try {
        resolvePersonaConfig(input, dir, home)
      } catch (err) {
        assertNoLeak(err, 'rejection')
        pure = (err as Error).message
      }
      expect(pure).toContain(`${indexedRef(1, 'review_bot')}: working_directory`)
      expect(pure).toContain(indexedRef(0, 'Ops Bot'))
      expect(loadError(input)).toContain(pure)
    })
  })

  // b.1ix follow-up: no persona's key may start with another persona's key.
  // The reason (b.jg5 SRJ-1102): tmux matches a session target by prefix
  // unless it is written with `=`, so a human's tmux command without `=` for
  // one persona could reach another persona's session. The rule runs after
  // the name/key uniqueness rule and before the shared-path rule, in record
  // mode too.
  describe('prefix-related keys (b.1ix follow-up)', () => {
    const HINT =
      "No persona's key may start with another persona's key: rename one of the two so that neither key starts with the other."

    /** SRJ-1102's reason sentence for a shorter and a longer key, from the loader's own reason builder. */
    const reasonFor = (shorterKey: string, longerKey: string) =>
      prefixRelatedKeysReason(personaTmuxSessionName(shorterKey), personaTmuxSessionName(longerKey))

    /** `personas[i]` plus the b.av2 SR-2.2 reference (JSON-quoted name with its key). */
    const indexedRef = (index: number, name: string) =>
      `personas[${index}] ${JSON.stringify(name)} (key=${personaKey(name)})`

    /** Personas in array order, each with its own paths under the temp dir, so only the keys can collide. */
    const personasOf = (...names: string[]) =>
      names.map((name, i) =>
        makePersona({ name, working_directory: join(dir, `p${i}`, 'work'), credentials_file: join(dir, `p${i}`, 'credentials.json') }, dir))

    test('dev then dev_2 is rejected with the full message: both personas, both tmux sessions, the rule and a rename of the shorter', () => {
      expect(loadError(withPersonas(...personasOf('dev', 'dev_2')))).toBe(
        `loadPersonaConfig: invalid persona config in "${join(dir, 'config.json')}": Persona config validation error: ` +
          'personas[1] "dev_2" (key=dev_2): key dev_2 starts with the key of personas[0] "dev" (key=dev). ' +
          'tmux matches a session target by prefix unless it is written with =, so a human\'s tmux command ' +
          'without = for one persona (for example tmux attach -t slack_bot_dev) could reach slack_bot_dev_2. ' +
          `${HINT} For example, rename personas[0] "dev" (key=dev) to "dev_main" (key=dev_main).`,
      )
    })

    interface PrefixRow {
      label: string
      names: string[]
      /** The reported persona (the later of the pair) and the earlier one it is reported against. */
      later: number
      earlier: number
      /** The relation as the error words it, after the later persona's prefix. */
      relation: string
      /** The persona with the shorter key and the one with the longer key. */
      shorter: number
      longer: number
      /** The suggested new name for the shorter one, or undefined when the error gives none. */
      rename: string | undefined
    }

    const rows: PrefixRow[] = [
      {
        label: 'dev_2 then dev (the later key is the shorter)',
        names: ['dev_2', 'dev'],
        later: 1,
        earlier: 0,
        relation: 'key dev is the start of the key of personas[0] "dev_2" (key=dev_2).',
        shorter: 1,
        longer: 0,
        rename: 'dev_main',
      },
      {
        label: 'horde then horde_admin',
        names: ['horde', 'horde_admin'],
        later: 1,
        earlier: 0,
        relation: 'key horde_admin starts with the key of personas[0] "horde" (key=horde).',
        shorter: 0,
        longer: 1,
        rename: 'horde_main',
      },
      {
        label: 'an in-form name and a name whose derived key starts with it ("Dev Bot")',
        names: ['dev', 'Dev Bot'],
        later: 1,
        earlier: 0,
        relation: `key ${personaKey('Dev Bot')} starts with the key of personas[0] "dev" (key=dev).`,
        shorter: 0,
        longer: 1,
        rename: 'dev_main',
      },
      {
        label: 'the second and third of three (the first unrelated)',
        names: ['alpha', 'horde', 'horde_admin'],
        later: 2,
        earlier: 1,
        relation: 'key horde_admin starts with the key of personas[1] "horde" (key=horde).',
        shorter: 1,
        longer: 2,
        rename: 'horde_main',
      },
      {
        label: 'the first and third of three',
        names: ['horde', 'alpha', 'horde_admin'],
        later: 2,
        earlier: 0,
        relation: 'key horde_admin starts with the key of personas[0] "horde" (key=horde).',
        shorter: 0,
        longer: 2,
        rename: 'horde_main',
      },
      {
        label: 'the first pair in array order, when a later key also starts with the shorter one',
        names: ['dev', 'dev_2', 'dev_3'],
        later: 1,
        earlier: 0,
        relation: 'key dev_2 starts with the key of personas[0] "dev" (key=dev).',
        shorter: 0,
        longer: 1,
        rename: 'dev_main',
      },
      {
        label: 'a suggestion numbered past a key that starts with <key>_main',
        names: ['dev', 'dev_2', 'dev_main_x'],
        later: 1,
        earlier: 0,
        relation: 'key dev_2 starts with the key of personas[0] "dev" (key=dev).',
        shorter: 0,
        longer: 1,
        rename: 'dev_main_2',
      },
      {
        label: 'no suggestion when another key is a proper prefix of the shorter one',
        names: ['dev', 'dev_2', 'd'],
        later: 1,
        earlier: 0,
        relation: 'key dev_2 starts with the key of personas[0] "dev" (key=dev).',
        shorter: 0,
        longer: 1,
        rename: undefined,
      },
    ]

    test.each(rows)('rejected: $label, naming both personas and no other', ({ names, later, earlier, relation, shorter, longer, rename }) => {
      const message = loadError(withPersonas(...personasOf(...names)))
      expect(message).toContain(`Persona config validation error: ${indexedRef(later, names[later]!)}: ${relation} `)
      expect(message).toContain(indexedRef(earlier, names[earlier]!))
      names.forEach((_, i) => {
        if (i !== later && i !== earlier) expect(message).not.toContain(`personas[${i}]`)
      })
      const shorterKey = personaKey(names[shorter]!)
      const longerKey = personaKey(names[longer]!)
      expect(message).toContain(`${relation} ${reasonFor(shorterKey, longerKey)} ${HINT}`)
      if (rename === undefined) {
        expect(message).toEndWith(HINT)
        expect(message).not.toContain('For example')
      } else {
        expect(message).toEndWith(
          `${HINT} For example, rename ${indexedRef(shorter, names[shorter]!)} to ${JSON.stringify(rename)} (key=${rename}).`,
        )
      }
    })

    // AC 78: the reason is about a human's tmux command only. No rejection
    // keeps the old "once <shorter> is gone" clause, names agent-director,
    // CSCB or a version, or says anything but tmux matches by prefix.
    test.each(rows)('rejected: $label, with no old clause and no claim that CSCB or agent-director matches by prefix', ({ names }) => {
      const message = loadError(withPersonas(...personasOf(...names)))
      const text = message.slice(message.indexOf('Persona config validation error: '))
      for (const old of ['is gone', 'a command meant for it', 'can act on', 'by its start']) {
        expect(text).not.toContain(old)
      }
      expect(text).not.toMatch(/agent-director|CSCB|\bserver\b|\bbare\b/i)
      expect(text).not.toMatch(/\bAD\b/)
      expect(text).not.toMatch(/\d+\.\d+/)
      expect(text.split('by prefix')).toHaveLength(2)
      expect(text).toContain('tmux matches a session target by prefix unless it is written with =, ')
    })

    test.each([
      ['dev_a and dev_b', ['dev_a', 'dev_b']],
      ['alpha and beta', ['alpha', 'beta']],
      ['names normalising to the same stem with different hashed keys', ['Ops Bot', 'OPS BOT']],
      ['horde_main and horde_admin (the suggested rename of horde)', ['horde_main', 'horde_admin', 'horde_apiary']],
      ['dev_main and dev_2 (the suggested rename of dev)', ['dev_main', 'dev_2']],
      ['keys sharing a start that neither is (dev_2 and dev_3)', ['dev_2', 'dev_3']],
    ])('accepted: %s', (_label, names) => {
      const config = load(withPersonas(...personasOf(...names)))
      expect(config.personas.map((p) => p.name)).toEqual(names)
    })

    test.each([
      ['the same name twice', ['dev', 'dev'], `${indexedRef(1, 'dev')}: name "dev" is duplicated: ${indexedRef(0, 'dev')} has the same name.`],
      [
        "an in-form name equal to another persona's derived key",
        ['Ops Bot', personaKey('Ops Bot')],
        `${indexedRef(1, personaKey('Ops Bot'))}: key ${personaKey('Ops Bot')} is duplicated: ${indexedRef(0, 'Ops Bot')} has the same key.`,
      ],
    ])('equal keys keep the uniqueness message, not the prefix one: %s', (_label, names, reported) => {
      const message = loadError(withPersonas(...personasOf(...names)))
      expect(message).toContain(reported)
      expect(message).not.toContain('starts with')
      expect(message).not.toContain('is the start of')
    })

    test.each([
      {
        label: 'a later per-entry violation before an earlier prefix pair',
        build: () => [...personasOf('dev', 'dev_2'), makePersona({ name: 'third_bot', permission_prompts: undefined }, dir)],
        reported: `${indexedRef(2, 'third_bot')}: permission_prompts`,
      },
      {
        label: 'a later duplicate name before an earlier prefix pair (the uniqueness rule runs over every pair first)',
        build: () => personasOf('dev', 'dev_2', 'dev_2'),
        reported: `${indexedRef(2, 'dev_2')}: name "dev_2" is duplicated`,
      },
      {
        label: 'a later prefix pair before an earlier shared working_directory',
        build: () => [
          makePersona({ name: 'alpha', working_directory: join(dir, 'shared') }, dir),
          makePersona({ name: 'beta', working_directory: join(dir, 'shared') }, dir),
          ...personasOf('dev', 'dev_2'),
        ],
        reported: `${indexedRef(3, 'dev_2')}: key dev_2 starts with the key of ${indexedRef(2, 'dev')}.`,
      },
    ])('check order: $label', ({ build, reported }) => {
      const message = loadError(withPersonas(...build()))
      expect(message).toContain(reported)
      expect(message.split('Persona config validation error: ')).toHaveLength(2)
    })

    test('record mode rejects the pair too, with the default-mode error, through parsePersonaConfigBytes and resolvePersonaConfig', () => {
      const input = withPersonas(...personasOf('horde', 'horde_admin'))
      const recordPath = join(dir, 'config.json.last-applied')
      const bytes = Buffer.from(JSON.stringify(input))
      const messageOf = (run: () => unknown) => {
        try {
          run()
        } catch (err) {
          assertNoLeak(err, 'rejection')
          return (err as Error).message
        }
        throw new Error('expected the configuration to be rejected')
      }
      const record = messageOf(() => parsePersonaConfigBytes(bytes, recordPath, dir, { home, record: true }))
      const standard = messageOf(() => parsePersonaConfigBytes(bytes, recordPath, dir, { home }))
      expect(record).toBe(standard)
      expect(record).toContain(`invalid persona config in "${recordPath}": `)
      expect(record).toContain(`${indexedRef(1, 'horde_admin')}: key horde_admin starts with the key of ${indexedRef(0, 'horde')}.`)
      const pure = messageOf(() => resolvePersonaConfig(input, dir, home, { record: true }))
      expect(record).toEndWith(pure)
    })

    test('a token-shaped name in a pair is named as written, and nothing else token-like reaches the error', () => {
      const name = fakeToken(BOT_TOKEN_PREFIX, 'name')
      const key = personaKey(name)
      // The in-form name that is the start of the token-shaped name's key.
      const shorter = key.slice(0, key.indexOf('_'))
      const message = loadError(withPersonas(...personasOf(shorter, name)), name)
      expect(message).toContain(`${indexedRef(1, name)}: key ${key} starts with the key of ${indexedRef(0, shorter)}.`)
      expect(message).toContain(` ${reasonFor(shorter, key)} ${HINT}`)
      expect(message).toEndWith(`For example, rename ${indexedRef(0, shorter)} to "${shorter}_main" (key=${shorter}_main).`)
    })
  })

  // b.av2 SR-1.2 ("No format rule"), E14 Task 0 operator decision A: any
  // non-empty persona name loads, including one shaped like a Slack token, and
  // is printed exactly as written in the persona reference of every error.
  // Only CSCB's own credential values (`bot_token` / `app_token` in an entry)
  // stay unechoed.
  //
  // A token-shaped name is built with `fakeToken`, so it carries the leak
  // sentinel on purpose. The artifacts here are meant to contain the name, so
  // they are not passed to `assertNoLeak` whole: that would rightly flag the
  // sentinel. `withoutName` first masks the name and its key (the key keeps
  // the name's characters, lower-cased), and `assertNoLeak` checks the rest,
  // which proves nothing else token-like, such as a credential value, got in.
  describe('token-shaped persona name (SR-1.2: no format rule; AC 20 config leg)', () => {
    const tokenName = (prefix: string) => fakeToken(prefix, 'name')

    /** `captured` with `name` (as written) and its key masked, so `assertNoLeak` checks what is left. */
    const masked = (captured: unknown, name: string) => withoutName(captured, name, personaKey(name))

    /** The b.av2 SR-2.2 reference of entry `i`: `personas[i]`, the JSON-quoted name and its key. */
    const indexedRef = (index: number, name: string) => `personas[${index}] ${JSON.stringify(name)} (key=${personaKey(name)})`

    // Token-shaped rows first, then names near the token shape (a word such
    // as xoxo, a prefix glued to a word or followed by a letter, an upper-case
    // prefix), which loaded before decision A too and must keep loading: an
    // upgrade must never refuse to start over a name it accepted before.
    const XOX = BOT_TOKEN_PREFIX.slice(0, 3)
    const NAMES: [string, string][] = [
      ['an xoxb- token', tokenName(BOT_TOKEN_PREFIX)],
      ['an xapp- token', tokenName(APP_TOKEN_PREFIX)],
      ['an xoxp- token', tokenName('xoxp-')],
      ['an xoxp- token inside a longer name', `Ops ${tokenName('xoxp-')} bot`],
      ['a word such as "Xoxo bot"', 'Xoxo bot'],
      ['the word xoxo, a dash and a word', `${XOX}o-bot`],
      ['inboxapp-bot', 'inboxapp-bot'],
      ['sandboxapp-1 (a digit after the dash, glued to a word)', 'sandboxapp-1'],
      ['a token shape glued after a letter', `bot${BOT_TOKEN_PREFIX}1`],
      ['a prefix with no dash', BOT_TOKEN_PREFIX.slice(0, -1)],
      ['the bare prefix text', `must start with ${BOT_TOKEN_PREFIX}`],
      ['a prefix followed by a space', `${APP_TOKEN_PREFIX} x`],
      ['a prefix followed by a letter', `${BOT_TOKEN_PREFIX}abc`],
      ['an upper-case prefix and a digit', `${BOT_TOKEN_PREFIX.toUpperCase()}1abc`],
    ]

    const keyedNames = (config: { personas: readonly { name: string; key: string }[] }) =>
      config.personas.map((p) => [p.name, p.key])

    test.each(NAMES)('a name that is %s loads from config.json, as written and keyed as usual', (_label, name) => {
      const config = load(withPersonas(makePersona({ name: 'Ops Bot' }, dir), makePersona({ name }, dir)))
      expect(keyedNames(config)).toEqual([['Ops Bot', personaKey('Ops Bot')], [name, personaKey(name)]])
      assertNoLeak(masked(config, name), 'config without the name')
    })

    test.each(NAMES)('a name that is %s loads from the record (record mode) and through resolvePersonaConfig', (_label, name) => {
      const input = withPersonas(makePersona({ name }, dir))
      const expected = [[name, personaKey(name)]]
      const recordPath = join(dir, 'config.json.last-applied')
      const fromRecord = parsePersonaConfigBytes(Buffer.from(JSON.stringify(input)), recordPath, dir, { home, record: true })
      expect(keyedNames(fromRecord)).toEqual(expected)
      const resolved = resolvePersonaConfig(input, dir, home, { record: true })
      expect(keyedNames(resolved)).toEqual(expected)
      assertNoLeak(masked([fromRecord, resolved], name), 'record load without the name')
    })

    // Errors of the entry, from every stage, name personas[i] with the
    // persona reference rendered from the token-shaped name and its key. The
    // entry's own bot_token / app_token values are credentials: their key is
    // named, their value never is (loadError's masked assertNoLeak).
    test.each([
      ['an unknown key in the entry', { nickname: 'ops' }, 'unknown field(s) in the persona entry: "nickname".'],
      ['a bot_token value in the entry', { bot_token: fakeToken(BOT_TOKEN_PREFIX, 'entry') }, 'unknown field(s) in the persona entry: "bot_token".'],
      ['an app_token value in the entry', { app_token: fakeToken(APP_TOKEN_PREFIX, 'entry') }, 'unknown field(s) in the persona entry: "app_token".'],
      ['a token-named unknown key in the entry', { [fakeToken(BOT_TOKEN_PREFIX, 'key')]: 1 }, 'unknown field(s) in the persona entry: 1 field whose name is not shown'],
      ['a non-object dm', { dm: true }, 'dm must be a JSON object'],
      ['a bot_token value in dm', { dm: { enabled: false, bot_token: fakeToken(BOT_TOKEN_PREFIX, 'dm') } }, 'unknown field(s) in dm: "bot_token".'],
      ['a non-object channel entry', { channels: [null] }, 'channels[0] must be a JSON object'],
      ['a bad channel ID', { channels: [{ id: 'D0TEST001', delivery: 'all' }] }, 'channels[0].id must be a Slack channel ID'],
      ['a missing permission_prompts', { permission_prompts: undefined }, 'permission_prompts'],
    ])('with %s, the error names personas[i] with the token-shaped name and key as written', (_label, overrides, reported) => {
      const name = tokenName(BOT_TOKEN_PREFIX)
      const message = loadError(
        withPersonas(makePersona({ name: 'Ops Bot' }, dir), makePersona({ name, ...overrides } as Partial<PersonaInput>, dir)),
        name,
      )
      expect(message).toContain(`Persona config validation error: ${indexedRef(1, name)}: ${reported}`)
      expect(message).not.toContain('personas[0]')
    })

    test('the same token-shaped name twice gives the duplicate-name error, naming it as written', () => {
      const name = tokenName(APP_TOKEN_PREFIX)
      const message = loadError(withPersonas(
        makePersona({ name, working_directory: join(dir, 'p0') }, dir),
        makePersona({ name, working_directory: join(dir, 'p1') }, dir),
      ), name)
      expect(message).toContain(
        `${indexedRef(1, name)}: name ${JSON.stringify(name)} is duplicated: ${indexedRef(0, name)} has the same name.`,
      )
    })

    test('a start from the record accepts a token-shaped name and reports its entry errors as default mode does', () => {
      const name = tokenName('xoxp-')
      const input = withPersonas(makePersona({ name: 'Ops Bot' }, dir), makePersona({ name, permission_prompts: undefined }, dir))
      const recordPath = join(dir, 'config.json.last-applied')
      const messages = [true, false].map((record) => {
        try {
          parsePersonaConfigBytes(Buffer.from(JSON.stringify(input)), recordPath, dir, { home, record })
        } catch (err) {
          assertNoLeak(masked(err, name), 'rejection without the name')
          return (err as Error).message
        }
        throw new Error('expected parsePersonaConfigBytes to reject the configuration')
      })
      expect(messages[0]).toContain(`invalid persona config in "${recordPath}": Persona config validation error: ${indexedRef(1, name)}: permission_prompts`)
      expect(messages[1]).toBe(messages[0])
    })
  })

  describe('server-wide settings (SR-1.6)', () => {
    // Defaults when absent are pinned by 'the default input resolves to the
    // makePersonaConfig shape' above.
    test('every server-wide key accepts a valid non-default value, ~ paths expanded under the injected home', () => {
      const values = {
        bind: '0.0.0.0',
        port: 8080,
        session_restart_delay: 5,
        health_check_interval: 30,
        exit_timeout: 10,
        stop_timeout: 5,
        mcp_config_path: '~/mcp.json',
        append_system_prompt_file: '~/prompt.md',
        cozempic_prescription: 'aggressive',
        system_prompt_mode: 'none',
        fresh_system_prompt: false,
        message_archive_db: '~/archive.db',
        claude_config_dir: '~/cfg',
        resume_enabled: false,
        agent_director_poll_interval_ms: 250,
        agent_director_call_timeout_ms: MIN_AGENT_DIRECTOR_CALL_TIMEOUT_MS + 1,
        stop_hook_bootstrap: false,
        cron_table_path: '~/cron/crontab',
        cron_log_path: '~/cron/cron.log',
        cron_log_max_bytes: 1024,
        ack_reaction: 'eyes',
        reply_chunk_limit: 12000,
        reply_chunk_mode: 'length',
        // makePersonaConfigInput gives a switch set to true its fungible-mode persona.
        allow_invited_channels: true,
      } satisfies Omit<Required<PersonaConfigInput>, 'personas'>
      const underHome = (path: string) => join(home, path.slice(2))
      expect(load(makePersonaConfigInput(values))).toMatchObject({
        ...values,
        mcp_config_path: underHome(values.mcp_config_path),
        append_system_prompt_file: underHome(values.append_system_prompt_file),
        message_archive_db: underHome(values.message_archive_db),
        claude_config_dir: underHome(values.claude_config_dir),
        cron_table_path: underHome(values.cron_table_path),
        cron_log_path: underHome(values.cron_log_path),
      })
    })

    // Boundary and remaining allowed values, loaded as written.
    test.each([
      ['session_restart_delay', 0],
      ['health_check_interval', 0],
      ['exit_timeout', 0],
      ['stop_timeout', 0],
      ['agent_director_poll_interval_ms', 200],
      ['agent_director_poll_interval_ms', 3_600_000],
      ['agent_director_call_timeout_ms', MIN_AGENT_DIRECTOR_CALL_TIMEOUT_MS],
      ['agent_director_call_timeout_ms', MAX_AGENT_DIRECTOR_CALL_TIMEOUT_MS],
      ['cozempic_prescription', 'gentle'],
      ['cozempic_prescription', 'standard'],
      ['system_prompt_mode', 'append'],
      ['append_system_prompt_file', '/nonexistent/prompts/extra.md'],
      ['claude_config_dir', '/nonexistent/claude-config'],
    ])('%s = %p loads unchanged', (key, value) => {
      expect(load({ ...makePersonaConfigInput({}, dir), [key]: value })[key as keyof PersonaConfigInput]).toBe(value)
    })

    test.each([
      ['cozempic_prescription', PLACEHOLDER, 'cozempic_prescription'],
      ['system_prompt_mode', PLACEHOLDER, 'system_prompt_mode'],
      ['stop_hook_bootstrap', PLACEHOLDER, 'stop_hook_bootstrap'],
      ['mcp_config_path', 42, 'mcp_config_path'],
      ['claude_config_dir', '   ', 'claude_config_dir'],
      ['session_restart_delay', -1, 'session_restart_delay'],
      ['agent_director_poll_interval_ms', 50, 'agent_director_poll_interval_ms'],
      ['cron_log_max_bytes', 0, 'cron_log_max_bytes'],
      ['claude_director_poll_interval_ms', 1000, 'agent_director_poll_interval_ms'],
      ['ack_reaction', '', 'ack_reaction'],
      ['reply_chunk_limit', 0, 'reply_chunk_limit'],
      ['reply_chunk_limit', -5, 'reply_chunk_limit'],
      ['reply_chunk_limit', 2.5, 'reply_chunk_limit'],
      ['reply_chunk_mode', PLACEHOLDER, 'reply_chunk_mode'],
      ['cozempic_prescription', '', 'cozempic_prescription'],
      ['cozempic_prescription', 'STANDARD', 'cozempic_prescription'],
      ['system_prompt_mode', '', 'system_prompt_mode'],
      ['system_prompt_mode', 'APPEND', 'system_prompt_mode'],
      ['claude_config_dir', '', 'claude_config_dir'],
      ['health_check_interval', -1, 'health_check_interval'],
      ['exit_timeout', -1, 'exit_timeout'],
      ['stop_timeout', -1, 'stop_timeout'],
      ['agent_director_poll_interval_ms', 199, 'agent_director_poll_interval_ms'],
      ['agent_director_poll_interval_ms', 3_600_001, 'agent_director_poll_interval_ms'],
      ['agent_director_poll_interval_ms', 1.5, 'agent_director_poll_interval_ms'],
      ['agent_director_poll_interval_ms', '1000', 'agent_director_poll_interval_ms'],
    ])('%s = %p is rejected, naming %s', (key, value, named) => {
      expect(loadError({ ...makePersonaConfigInput({}, dir), [key]: value })).toContain(named)
    })

    // b.b1j SR-1: fresh_system_prompt is a server-wide boolean; only an absent key takes the default.
    describe('fresh_system_prompt (b.b1j SR-1)', () => {
      const withFresh = (value: unknown) => ({ ...makePersonaConfigInput({}, dir), fresh_system_prompt: value })

      test.each([
        ['absent', undefined, true],
        ['true', true, true],
        ['false', false, false],
      ] as const)('%s loads and resolves to %p (SR-1.1)', (_label, value, resolved) => {
        const input = value === undefined ? makePersonaConfigInput({}, dir) : withFresh(value)
        expect(load(input).fresh_system_prompt).toBe(resolved)
      })

      test('absent and true resolve to the same configuration (SR-1.1)', () => {
        expect(load(makePersonaConfigInput({}, dir))).toStrictEqual(load(withFresh(true)))
      })

      // LEAK_SENTINEL and fake-token rows: loadError's assertNoLeak proves the value is never echoed.
      const REJECTED: [string, unknown][] = [
        ['a string', 'true'],
        ['a number', 1],
        ['null', null],
        ['an object', { enabled: true }],
        ['an array', [true]],
        ['the leak sentinel as a string', LEAK_SENTINEL],
        ['a fake token as a string', fakeToken(BOT_TOKEN_PREFIX, 'fresh')],
        ['an object holding the leak sentinel', { value: LEAK_SENTINEL }],
        ['an array holding the leak sentinel', [LEAK_SENTINEL]],
      ]

      // The same full message for every value: it names the setting, no persona, and never echoes the value (SR-1.2).
      test.each(REJECTED)('%s is rejected with the full message, naming the setting and no persona (SR-1.2)', (_label, value) => {
        expect(loadError(withFresh(value))).toBe(
          `loadPersonaConfig: invalid persona config in "${join(dir, 'config.json')}": Persona config validation error: ` +
            'fresh_system_prompt must be a boolean.',
        )
      })
    })

    // b.jg5 SRJ-213: the error names the setting and both bounds of its range,
    // and never the rejected value (loadError fails if PLACEHOLDER reaches it).
    test.each([
      ['below the minimum', MIN_AGENT_DIRECTOR_CALL_TIMEOUT_MS - 1],
      ['above the maximum', MAX_AGENT_DIRECTOR_CALL_TIMEOUT_MS + 1],
      ['zero', 0],
      ['negative', -MIN_AGENT_DIRECTOR_CALL_TIMEOUT_MS],
      ['a non-integer number', MIN_AGENT_DIRECTOR_CALL_TIMEOUT_MS + 0.5],
      ['a numeric string', String(MIN_AGENT_DIRECTOR_CALL_TIMEOUT_MS)],
      ['a non-numeric string', PLACEHOLDER],
    ])('agent_director_call_timeout_ms %s (%p) is rejected with the full message, naming the setting and its range', (_label, value) => {
      expect(loadError({ ...makePersonaConfigInput({}, dir), agent_director_call_timeout_ms: value })).toBe(
        `loadPersonaConfig: invalid persona config in "${join(dir, 'config.json')}": Persona config validation error: ` +
          'agent_director_call_timeout_ms must be a positive integer in ' +
          `[${MIN_AGENT_DIRECTOR_CALL_TIMEOUT_MS}, ${MAX_AGENT_DIRECTOR_CALL_TIMEOUT_MS}].`,
      )
    })

    test('agentDirectorCallTimeoutMsOf returns a configuration\'s value, and the default with no configuration', () => {
      const config = makePersonaConfig({ agent_director_call_timeout_ms: MAX_AGENT_DIRECTOR_CALL_TIMEOUT_MS })
      expect(agentDirectorCallTimeoutMsOf(config)).toBe(MAX_AGENT_DIRECTOR_CALL_TIMEOUT_MS)
      expect(agentDirectorCallTimeoutMsOf(null)).toBe(DEFAULT_AGENT_DIRECTOR_CALL_TIMEOUT_MS)
      expect(agentDirectorCallTimeoutMsOf(undefined)).toBe(DEFAULT_AGENT_DIRECTOR_CALL_TIMEOUT_MS)
    })
  })

  // AC 49 (b.av2 SR-1.6, SR-10.1, SR-10.2): access.json's ackReaction,
  // textChunkLimit and chunkMode became ack_reaction, reply_chunk_limit and
  // reply_chunk_mode. Their defaults and validation are pinned above; these
  // cases pin the move: the old names are not accepted in config.json, and a
  // leftover access.json beside it neither supplies the settings nor is
  // touched. The access.json sits in the config directory, where the server
  // used to keep it.
  describe('settings moved from access.json (SR-1.6, SR-10.1, SR-10.2; AC 49)', () => {
    test.each([
      ['ackReaction', 'eyes'],
      ['textChunkLimit', 1234],
      ['chunkMode', 'length'],
    ])('the old name %s at the top level is rejected as an unknown key, naming it', (key, value) => {
      const message = loadError({ ...makePersonaConfigInput({}, dir), [key]: value })
      expect(message).toContain(`unknown top-level field(s) in config.json: ${JSON.stringify(key)}.`)
    })

    // The access.json values differ from both the defaults and the set
    // values, so a load that took any of them fails its row. Deliberately
    // odd formatting makes the byte-identical check meaningful.
    const ACCESS_JSON = '{ "ackReaction": "thumbsup",\n  "textChunkLimit": 1234, "chunkMode": "length" }\n\n'
    test.each([
      ['a config without the three keys loads the defaults', {}, { ack_reaction: undefined, reply_chunk_limit: 4000, reply_chunk_mode: 'newline' }],
      ['a config setting all three loads exactly them', { ack_reaction: 'eyes', reply_chunk_limit: 2500, reply_chunk_mode: 'length' }, { ack_reaction: 'eyes', reply_chunk_limit: 2500, reply_chunk_mode: 'length' }],
    ] as const)('beside a leftover access.json, %s; the access.json is byte-identical afterwards', (_label, set, expected) => {
      const accessPath = join(dir, 'access.json')
      writeFileSync(accessPath, ACCESS_JSON, 'utf-8')
      const path = writeConfigFile(dir, makePersonaConfigInput(set, dir))
      const listing = readdirSync(dir).sort()
      const config = loadPersonaConfig(path, home)
      assertNoLeak(config, 'config')
      expect({
        ack_reaction: config.ack_reaction,
        reply_chunk_limit: config.reply_chunk_limit,
        reply_chunk_mode: config.reply_chunk_mode,
      }).toEqual(expected)
      expect(readFileSync(accessPath, 'utf-8')).toBe(ACCESS_JSON)
      expect(readdirSync(dir).sort()).toEqual(listing)
    })
  })

  describe('pre-persona rejection (SR-1.7 loader part; AC 45)', () => {
    /**
     * Load `input`, returning the error message plus proof that the file and
     * directory are untouched and that the error passes `assertNoLeak`.
     */
    function rejectUntouched(input: unknown): string {
      const path = writeConfigFile(dir, input)
      const bytes = readFileSync(path)
      const listing = readdirSync(dir)
      let error: Error | undefined
      try {
        loadPersonaConfig(path, home)
      } catch (err) {
        error = err as Error
      }
      expect(readFileSync(path).equals(bytes)).toBe(true)
      expect(readdirSync(dir)).toEqual(listing)
      if (error === undefined) throw new Error('expected loadPersonaConfig to reject the configuration')
      assertNoLeak(error, 'rejection')
      return error.message
    }

    test.each([
      ['routes as a populated object', 'routes', { C0TEST001: { cwd: '/tmp/ops' } }],
      ['routes as an empty object', 'routes', {}],
      ['routes as an array', 'routes', []],
      ['routes as a non-object', 'routes', 'none'],
      ['routes as null', 'routes', null],
      ['default_route', 'default_route', '/tmp/ops'],
      ['default_dm_session', 'default_dm_session', '/tmp/ops'],
    ])('%s is rejected with the conversion message; the file is unchanged', (_label, key, value) => {
      const message = rejectUntouched({ ...makePersonaConfigInput({}, dir), [key]: value })
      expect(message).toContain(prePersonaConversionMessage(key))
      expect(message).toContain(JSON.stringify(key))
      expect(message).toContain('must be converted to personas')
    })

    test.each([
      ['a missing personas', { routes: {} }],
      ['an unknown top-level key', { ...makePersonaConfigInput(), default_route: '/tmp/ops', extra_setting: 1 }],
      ['an invalid persona', { personas: [makePersona({ permission_prompts: undefined })], default_dm_session: '/tmp/ops' }],
    ])('the conversion message wins over %s', (_label, input) => {
      const message = rejectUntouched(input)
      expect(message).toContain('must be converted to personas')
      expect(message).not.toContain('extra_setting')
      expect(message).not.toContain('permission_prompts')
    })
  })

  // Malformed JSON through the loader is covered, with its position, under
  // parsePersonaConfigBytes below.
  describe('loader I/O errors', () => {
    test.each([
      ['a missing file', (d: string) => join(d, 'absent.json'), 'cannot read'],
      ['a JSON array', (d: string) => writeConfigFile(d, []), 'must be a JSON object'],
    ])('%s is rejected, naming the file path', (_label, setup, fragment) => {
      const path = setup(dir)
      let message = ''
      try {
        loadPersonaConfig(path, home)
      } catch (err) {
        assertNoLeak(err, 'rejection')
        message = (err as Error).message
      }
      expect(message).toContain(fragment)
      expect(message).toContain(path)
    })
  })

  // -------------------------------------------------------------------------
  // Channel modes (b.deo SRI-101 to SRI-104). The switch picks the mode for
  // every persona at once: declarative mode (absent or false) reads each
  // persona's `channels` and top-level `permission_prompts`; fungible mode
  // (true) reads its `invited` section. Setting names, key lists and the "dm"
  // default come from src/ (the `satisfies` names below are checked against
  // the input types). Each rejection goes through `loadError`, so every one is
  // leak-checked with `assertNoLeak`.
  // -------------------------------------------------------------------------

  const INVITED = 'invited' satisfies keyof PersonaInput
  const INVITED_PROMPTS = `${INVITED}.${'permission_prompts' satisfies keyof PersonaInvitedInput}`
  const DM_ENABLED = `dm.${'enabled' satisfies keyof PersonaDmInput}`
  const DM_CONTACT = `dm.${'contact' satisfies keyof PersonaDmInput}`
  const CREDENTIALS_FILE = 'credentials_file' satisfies keyof PersonaInput

  /** The persona every channel-mode case names, and its error prefix (`personas[0]` plus the persona reference). */
  const MODE_NAME = 'Ops Bot'
  const MODE_REF = `personas[0] ${renderPersonaRef(MODE_NAME)}`
  const CHANNEL = 'C0TEST001'
  const OTHER_CHANNEL = 'G0TEST002'
  const DM_ON = { enabled: true, contact: 'U0TEST001' }

  /** The switch value that picks `mode`. */
  const switchFor = (mode: ChannelMode) => mode === 'fungible'

  /**
   * A configuration in file form holding `personas` with the switch written
   * as `value` (any JSON value), or with no switch when `value` is undefined.
   */
  const underSwitch = (value: unknown, ...personas: unknown[]) =>
    value === undefined ? { personas } : { [MODE_SWITCH_SETTING]: value, personas }

  /**
   * A persona entry named `MODE_NAME` under the temp dir, from `makePersona`
   * (declarative-mode defaults) or `factory`; `overrides` may hold values of
   * any shape, and one set to undefined drops its key.
   */
  const modeEntry = (overrides: Record<string, unknown> = {}, factory = makePersona) =>
    factory({ name: MODE_NAME, ...overrides } as Partial<PersonaInput>, dir)

  /** A persona valid in both modes: one listed channel as its destination in each section, DMs off. */
  const bothModesEntry = (overrides: Record<string, unknown> = {}) =>
    modeEntry({ [INVITED]: { permission_prompts: CHANNEL }, ...overrides })

  describe('the channel-mode switch allow_invited_channels (b.deo SRI-101; b.av2 SR-1.6)', () => {
    test.each([
      ['true', true, 'fungible'],
      ['false', false, 'declarative'],
      ['absent', undefined, 'declarative'],
    ] as const)('%s loads, resolving to %p and to %s mode (channelModeOf)', (_label, value, mode) => {
      const config = load(underSwitch(value, bothModesEntry()))
      expect(config.allow_invited_channels).toBe(value ?? false)
      expect(channelModeOf(config)).toBe(mode)
    })

    test('absent and false resolve to the same configuration', () => {
      expect(load(underSwitch(undefined, bothModesEntry()))).toStrictEqual(load(underSwitch(false, bothModesEntry())))
    })

    // The personas are valid in both modes, so only the switch can be rejected.
    // LEAK_SENTINEL rows: loadError's assertNoLeak proves the value is never echoed.
    const REJECTED: [string, unknown][] = [
      ['a string', 'true'],
      ['a number', 1],
      ['null', null],
      ['an object', { enabled: true }],
      ['an array', [true]],
      ['the leak sentinel as a string', LEAK_SENTINEL],
      ['a fake token as a string', fakeToken(BOT_TOKEN_PREFIX, 'switch')],
      ['an object holding the leak sentinel', { value: LEAK_SENTINEL }],
      ['an array holding the leak sentinel', [LEAK_SENTINEL]],
    ]

    test.each(REJECTED)('%s is rejected, naming the setting and no persona', (_label, value) => {
      const message = loadError(underSwitch(value, bothModesEntry()))
      expect(message).toContain(MODE_SWITCH_SETTING)
      expect(message).not.toContain('personas[')
    })

    test('every rejected value gives the same error, so none of them is echoed', () => {
      const messages = new Set(REJECTED.map(([, value]) => loadError(underSwitch(value, bothModesEntry()))))
      expect(messages.size).toBe(1)
    })

    test.each([
      ['a string', 'true'],
      ['null', null],
    ])('%s beside a persona entry invalid in both modes: the switch is reported, as it is validated first', (_label, value) => {
      const message = loadError(underSwitch(value, bothModesEntry({ [CREDENTIALS_FILE]: undefined })))
      expect(message).toBe(loadError(underSwitch(value, bothModesEntry())))
      expect(message).not.toContain(CREDENTIALS_FILE)
      // Control: the same entry under a boolean switch is rejected for its own setting.
      for (const mode of CHANNEL_MODES) {
        expect(loadError(underSwitch(switchFor(mode), bothModesEntry({ [CREDENTIALS_FILE]: undefined })))).toContain(
          `${MODE_REF}: ${CREDENTIALS_FILE}`,
        )
      }
    })
  })

  describe('the invited section and the resolved form (b.deo SRI-102; b.av2 SR-1.2)', () => {
    test('invited is a known persona-entry key (PERSONA_ENTRY_KEYS)', () => {
      expect(PERSONA_ENTRY_KEYS).toContain(INVITED)
    })

    test.each([...CHANNEL_MODES])('in %s mode an entry carrying invited loads, with no unknown-key rejection', (mode) => {
      const [persona] = load(underSwitch(switchFor(mode), bothModesEntry())).personas
      expect(persona.sections.invited).toEqual({ permission_prompts: CHANNEL })
    })

    test('in fungible mode every key PERSONA_INVITED_KEYS lists is accepted in invited', () => {
      const invited = Object.fromEntries(PERSONA_INVITED_KEYS.map((key) => [key, CHANNEL]))
      const [persona] = load(underSwitch(true, modeEntry({ [INVITED]: invited }, makeFungiblePersona))).personas
      expect(persona.sections.invited).toEqual(invited)
    })

    // The declarative section is written too, so the resolved channels and
    // permission_prompts show it is not read.
    test.each([
      ['"dm", with DMs on', { permission_prompts: DM_DESTINATION }, DM_ON, DM_DESTINATION],
      ['a C channel ID, with DMs off', { permission_prompts: CHANNEL }, { enabled: false }, CHANNEL],
      ['a G channel ID, with DMs off', { permission_prompts: OTHER_CHANNEL }, { enabled: false }, OTHER_CHANNEL],
      ['absent from invited: "dm" by default, with DMs on', {}, DM_ON, DM_DESTINATION],
      ['invited absent: "dm" by default, with DMs on', undefined, DM_ON, DM_DESTINATION],
    ])('fungible mode: invited.permission_prompts %s resolves to fungible_destination %p, channels [] and permission_prompts undefined', (_label, invited, dm, expected) => {
      const [persona] = load(underSwitch(true, modeEntry({ [INVITED]: invited, dm }))).personas
      expect(persona.fungible_destination).toBe(expected)
      expect(persona.channels).toEqual([])
      expect(persona.permission_prompts).toBeUndefined()
      expect(persona.dm).toEqual(dm)
    })

    test.each([
      ['absent', undefined],
      ['false', false],
    ])('declarative mode (switch %s): fungible_destination is undefined and the declarative section is parsed', (_label, value) => {
      const [persona] = load(underSwitch(value, bothModesEntry({ [INVITED]: { permission_prompts: OTHER_CHANNEL } }))).personas
      expect(persona.fungible_destination).toBeUndefined()
      expect(persona.channels).toEqual([{ id: CHANNEL, delivery: 'all' }])
      expect(persona.permission_prompts).toBe(CHANNEL)
    })

    const WRITTEN = {
      channels: [{ id: CHANNEL, delivery: 'mentions' }],
      permission_prompts: CHANNEL,
      invited: { permission_prompts: OTHER_CHANNEL },
    }
    test.each([
      ['declarative', 'all three written', WRITTEN, {}],
      ['declarative', 'only permission_prompts written', { channels: undefined, permission_prompts: DM_DESTINATION, invited: undefined }, { dm: DM_ON }],
      ['fungible', 'all three written', WRITTEN, {}],
      ['fungible', 'none written', { channels: undefined, permission_prompts: undefined, invited: undefined }, { dm: DM_ON }],
    ] as const)('%s mode, %s: sections holds the three keys as written, each undefined when absent', (mode, _label, written, extra) => {
      const [persona] = load(underSwitch(switchFor(mode), modeEntry({ ...written, ...extra }))).personas
      expect(Object.keys(persona.sections).sort()).toEqual([...RECORDED_SECTION_KEYS].sort())
      expect(persona.sections).toStrictEqual({
        channels: written.channels,
        permission_prompts: written.permission_prompts,
        invited: written.invited,
      })
    })
  })

  describe('fungible parity: the real loader against makeMultiPersonaConfig (b.deo SRI-102, SRI-1203)', () => {
    test('makeFungiblePersona entries under the switch load to the sections and destinations makeMultiPersonaConfig builds from the same values', () => {
      const specs = [
        { name: 'alpha' },
        { name: 'bravo', invited: { permission_prompts: OTHER_CHANNEL } },
        { name: 'charlie', invited: { permission_prompts: DM_DESTINATION }, dm: DM_ON },
        { name: 'delta', invited: {}, dm: DM_ON },
        { name: 'echo', invited: undefined, dm: DM_ON },
      ]
      const loaded = load(underSwitch(true, ...specs.map((spec) => makeFungiblePersona(spec, dir)))).personas
      // makeFungiblePersona's default invited, made explicit for the resolved builder.
      const defaultInvited = makeFungiblePersona({}, dir).invited
      const built = makeMultiPersonaConfig(
        specs.map((spec) => ({ invited: defaultInvited, ...spec })),
        dir,
        { allow_invited_channels: true },
      ).personas
      const resolvedForm = ({ fungible_destination, sections, channels, permission_prompts }: (typeof loaded)[number]) => ({
        fungible_destination,
        sections,
        channels,
        permission_prompts,
      })
      expect(loaded.map(resolvedForm)).toStrictEqual(built.map(resolvedForm))
      expect(loaded.map((p) => p.fungible_destination)).toEqual([
        defaultInvited?.permission_prompts,
        OTHER_CHANNEL,
        DM_DESTINATION,
        DM_DESTINATION,
        DM_DESTINATION,
      ])
    })
  })

  /** A persona with no channels and DMs off, prompting to "dm": invalid in declarative mode, `invited` aside. */
  const NO_WAY_TO_RECEIVE = { channels: undefined, dm: { enabled: false }, permission_prompts: DM_DESTINATION }

  /** The two switch values of declarative mode. */
  const DECLARATIVE_SWITCHES = [
    ['absent', undefined],
    ['false', false],
  ] as const

  describe('validation in declarative mode: invited is neither checked nor read (b.deo SRI-103; b.av2 SR-1.5)', () => {
    const MALFORMED_INVITED: [string, unknown][] = [
      ['an invited with a malformed permission_prompts', { permission_prompts: PLACEHOLDER }],
      ['an invited with a non-string permission_prompts', { permission_prompts: 42 }],
      ['an invited with an unknown key', { extra_key: 1 }],
      ['an invited with a token-named key', { [fakeToken(BOT_TOKEN_PREFIX, 'invited')]: 1 }],
      ['a string invited', PLACEHOLDER],
      ['an array invited', [CHANNEL]],
      ['a null invited', null],
      ['a number invited', 7],
    ]
    const EVERY_INVITED: [string, unknown][] = [['a valid invited', { permission_prompts: CHANNEL }], ...MALFORMED_INVITED]

    const bySwitch = (rows: [string, unknown][]) =>
      DECLARATIVE_SWITCHES.flatMap(([switchLabel, value]) =>
        rows.map(([label, invited]): [string, string, unknown, unknown] => [switchLabel, label, value, invited]))

    test.each(bySwitch(EVERY_INVITED))(
      'switch %s, %s: a persona with no channels and DMs off is rejected naming dm.enabled, with the error it gets without invited',
      (_switchLabel, _label, value, invited) => {
        const message = loadError(underSwitch(value, modeEntry({ ...NO_WAY_TO_RECEIVE, [INVITED]: invited })))
        expect(message).toBe(loadError(underSwitch(value, modeEntry(NO_WAY_TO_RECEIVE))))
        expect(message).toContain(`${MODE_REF}: `)
        expect(message).toContain(DM_ENABLED)
        // Reported before any destination rule, and invited is not looked at.
        expect(message).not.toContain(DM_CONTACT)
        expect(message).not.toContain(INVITED)
      },
    )

    test.each(bySwitch(MALFORMED_INVITED))('switch %s, %s: loads, resolved as without it', (_switchLabel, _label, value, invited) => {
      const [persona] = load(underSwitch(value, modeEntry({ [INVITED]: invited }))).personas
      const [without] = load(underSwitch(value, modeEntry())).personas
      expect(persona.fungible_destination).toBeUndefined()
      expect(persona.sections.invited).toStrictEqual(invited)
      const { sections: _sections, ...resolved } = persona
      const { sections: _withoutSections, ...resolvedWithout } = without
      expect(resolved).toStrictEqual(resolvedWithout)
    })
  })

  describe('validation in fungible mode (b.deo SRI-104; b.av2 SR-1.3, SR-1.5)', () => {
    /** `personas[i]` plus the persona reference (`renderPersonaRef`). */
    const indexedRef = (index: number, name: string) => `personas[${index}] ${renderPersonaRef(name)}`

    const rejectFungible = (overrides: Record<string, unknown>) =>
      loadError(underSwitch(true, modeEntry(overrides, makeFungiblePersona)))

    interface FungibleRejection {
      label: string
      overrides: Record<string, unknown>
      /** Fragments the error must hold: the persona reference with the setting, then what else it names. */
      named: string[]
      /** Fragments the error must not hold. */
      absent: string[]
    }

    const TOKEN_KEY = fakeToken(BOT_TOKEN_PREFIX, 'invited-key')

    // LEAK_SENTINEL and fake-token rows: loadError's assertNoLeak proves the
    // value in invited or in invited.permission_prompts is never echoed.
    const SHAPE_AND_FORMAT_ROWS: FungibleRejection[] = [
      ...([
        ['a string', PLACEHOLDER],
        ['the leak sentinel', LEAK_SENTINEL],
        ['an array', [CHANNEL]],
        ['an array holding the leak sentinel', [LEAK_SENTINEL]],
        ['null', null],
      ] as const).map(([what, invited]): FungibleRejection => ({
        label: `invited as ${what}`,
        overrides: { [INVITED]: invited },
        named: [`${MODE_REF}: ${INVITED} `],
        absent: [INVITED_PROMPTS],
      })),
      ...([
        ['an unknown key', { extra_key: 1 }, 'extra_key'],
        ['an unknown key holding the leak sentinel', { extra_key: LEAK_SENTINEL }, 'extra_key'],
        ['an unknown key beside a valid permission_prompts', { permission_prompts: CHANNEL, extra_key: 1 }, 'extra_key'],
        ['a token-named key', { [TOKEN_KEY]: 1 }, TOKEN_KEY],
      ] as const).map(([what, invited, key]): FungibleRejection => ({
        label: `invited with ${what}`,
        overrides: { [INVITED]: invited },
        named: [`${MODE_REF}: `, INVITED, describeUnknownKeys([key])],
        absent: [INVITED_PROMPTS],
      })),
      ...([
        ['a malformed string', PLACEHOLDER],
        ['the leak sentinel', LEAK_SENTINEL],
        ['a fake token', fakeToken(BOT_TOKEN_PREFIX, 'prompts')],
        ['a number', 42],
        ['null', null],
        ['an empty string', ''],
        ['a user ID', 'U0TEST001'],
        ['a direct-message channel ID', 'D0TEST001'],
        ['a lower-case channel ID', CHANNEL.toLowerCase()],
      ] as const).map(([what, prompts]): FungibleRejection => ({
        label: `invited.permission_prompts as ${what}`,
        overrides: { [INVITED]: { permission_prompts: prompts }, dm: DM_ON },
        named: [`${MODE_REF}: ${INVITED_PROMPTS} `],
        absent: [DM_CONTACT, DM_ENABLED],
      })),
    ]

    /** The "dm" fungible destination, written or by default, against each missing DM setting. */
    const DESTINATION_ROWS: (FungibleRejection & { byDefault: boolean })[] = ([
      ['written as "dm"', { permission_prompts: DM_DESTINATION }, false],
      ['by default (permission_prompts absent from invited)', {}, true],
      ['by default (invited absent)', undefined, true],
    ] as const).flatMap(([how, invited, byDefault]) =>
      ([
        ['DMs off', { enabled: false, contact: DM_ON.contact }, [DM_ENABLED], [DM_CONTACT]],
        ['no contact', { enabled: true }, [DM_CONTACT], [DM_ENABLED]],
        ['DMs off and no contact', { enabled: false }, [DM_ENABLED, DM_CONTACT], []],
        ['dm absent', undefined, [DM_ENABLED, DM_CONTACT], []],
      ] as const).map(([missing, dm, named, absent]) => ({
        label: `a "dm" destination ${how}, with ${missing}`,
        overrides: { [INVITED]: invited, dm },
        named: [`${MODE_REF}: ${INVITED_PROMPTS} `, JSON.stringify(DM_DESTINATION), ...named],
        absent: [...absent],
        byDefault,
      })),
    )

    test.each([...SHAPE_AND_FORMAT_ROWS, ...DESTINATION_ROWS])('$label is rejected, naming the persona and the setting', ({ overrides, named, absent }) => {
      const message = rejectFungible(overrides)
      for (const fragment of named) expect(message).toContain(fragment)
      for (const fragment of absent) expect(message).not.toContain(fragment)
    })

    test.each(DESTINATION_ROWS)('$label: the error says whether "dm" is the default', ({ overrides, byDefault }) => {
      const message = rejectFungible(overrides)
      if (byDefault) expect(message).toContain('default')
      else expect(message).not.toContain('default')
    })

    // Steps: (1) shape and unknown keys of the entry, dm and invited; (2) types
    // and formats, invited.permission_prompts after dm.contact; (3) the
    // destination rule. A row breaking several steps reports the earliest.
    test.each([
      {
        label: 'a non-object invited (1) before a missing credentials_file (2)',
        overrides: { [INVITED]: PLACEHOLDER, [CREDENTIALS_FILE]: undefined },
        reported: [`${MODE_REF}: ${INVITED} `],
        absent: [CREDENTIALS_FILE],
      },
      {
        label: 'an unknown key in the entry (1) before a malformed invited.permission_prompts (2)',
        overrides: { nickname: 'ops', [INVITED]: { permission_prompts: PLACEHOLDER } },
        reported: [`${MODE_REF}: `, describeUnknownKeys(['nickname'])],
        absent: [INVITED],
      },
      {
        label: 'a non-object dm (1) before a non-object invited (1, checked after dm)',
        overrides: { dm: PLACEHOLDER, [INVITED]: PLACEHOLDER },
        reported: [`${MODE_REF}: dm `],
        absent: [INVITED],
      },
      {
        label: 'an unknown key in invited (1) before a malformed dm.contact (2)',
        overrides: { [INVITED]: { extra_key: 1 }, dm: { enabled: true, contact: 'B0TEST001' } },
        reported: [`${MODE_REF}: `, INVITED, describeUnknownKeys(['extra_key'])],
        absent: [DM_CONTACT],
      },
      {
        label: 'a missing credentials_file (2) before a malformed invited.permission_prompts (2, last)',
        overrides: { [CREDENTIALS_FILE]: undefined, [INVITED]: { permission_prompts: PLACEHOLDER } },
        reported: [`${MODE_REF}: ${CREDENTIALS_FILE} `],
        absent: [INVITED],
      },
      {
        label: 'a non-boolean dm.enabled (2) before a malformed invited.permission_prompts (2, after dm)',
        overrides: { dm: { enabled: PLACEHOLDER }, [INVITED]: { permission_prompts: PLACEHOLDER } },
        reported: [`${MODE_REF}: ${DM_ENABLED} `],
        absent: [INVITED],
      },
      {
        label: 'a malformed dm.contact (2) before a malformed invited.permission_prompts (2, after dm.contact)',
        overrides: { dm: { enabled: true, contact: 'B0TEST001' }, [INVITED]: { permission_prompts: PLACEHOLDER } },
        reported: [`${MODE_REF}: ${DM_CONTACT} `],
        absent: [INVITED],
      },
      {
        label: 'a malformed dm.contact (2) before the destination rule (3) of a "dm" destination with DMs off',
        overrides: { dm: { enabled: false, contact: 'B0TEST001' }, [INVITED]: { permission_prompts: DM_DESTINATION } },
        reported: [`${MODE_REF}: ${DM_CONTACT} `],
        absent: [INVITED, DM_ENABLED],
      },
      {
        label: 'a missing credentials_file (2) before the destination rule (3) of the default "dm" destination',
        overrides: { [CREDENTIALS_FILE]: undefined, [INVITED]: undefined },
        reported: [`${MODE_REF}: ${CREDENTIALS_FILE} `],
        absent: [INVITED, DM_ENABLED, DM_CONTACT],
      },
      {
        label: 'a malformed invited.permission_prompts beside a malformed declarative section, which is never read',
        overrides: { channels: [null], permission_prompts: 42, [INVITED]: { permission_prompts: PLACEHOLDER } },
        reported: [`${MODE_REF}: ${INVITED_PROMPTS} `],
        absent: ['channels'],
      },
    ])('check order: $label', ({ overrides, reported, absent }) => {
      const message = rejectFungible(overrides)
      for (const fragment of reported) expect(message).toContain(fragment)
      for (const fragment of absent) expect(message).not.toContain(fragment)
      expect(message.split('Persona config validation error: ')).toHaveLength(2)
    })

    test('a persona with no channels, no top-level permission_prompts, DMs off and a channel fungible destination loads', () => {
      const entry = modeEntry({ [INVITED]: { permission_prompts: OTHER_CHANNEL } }, makeFungiblePersona)
      expect(Object.keys(entry)).not.toContain('channels')
      expect(Object.keys(entry)).not.toContain('permission_prompts')
      const [persona] = load(underSwitch(true, entry)).personas
      expect(persona.dm).toEqual({ enabled: false })
      expect(persona.fungible_destination).toBe(OTHER_CHANNEL)
    })

    test.each([
      ['channels as a string', { channels: PLACEHOLDER }],
      ['channels as an object', { channels: {} }],
      ['channels as null', { channels: null }],
      ['a non-object channel entry', { channels: [null] }],
      ['a malformed channel ID', { channels: [{ id: 'D0TEST001', delivery: 'all' }] }],
      ['a channel entry with an unknown key', { channels: [{ id: CHANNEL, delivery: 'all', label: 'ops' }] }],
      ['a channel entry with no delivery', { channels: [{ id: CHANNEL }] }],
      ['the same channel listed twice', { channels: [{ id: CHANNEL, delivery: 'all' }, { id: CHANNEL, delivery: 'mentions' }] }],
      ['a top-level permission_prompts naming an unlisted channel', { permission_prompts: 'C0TEST999' }],
      [
        'a top-level permission_prompts naming a channel not among channels',
        { channels: [{ id: CHANNEL, delivery: 'all' }], permission_prompts: OTHER_CHANNEL },
      ],
      ['a top-level permission_prompts of the wrong type (a number)', { permission_prompts: 42 }],
      ['a top-level permission_prompts of the wrong type (an object)', { permission_prompts: { id: CHANNEL } }],
      ['a malformed top-level permission_prompts', { permission_prompts: PLACEHOLDER }],
      ['a top-level permission_prompts "dm" with DMs off', { permission_prompts: DM_DESTINATION }],
    ])('%s loads: the declarative section is never read', (_label, overrides: Record<string, unknown>) => {
      const [persona] = load(underSwitch(true, modeEntry(overrides, makeFungiblePersona))).personas
      expect(persona.channels).toEqual([])
      expect(persona.permission_prompts).toBeUndefined()
      expect(persona.sections.channels).toStrictEqual(overrides['channels'])
      expect(persona.sections.permission_prompts).toStrictEqual(overrides['permission_prompts'])
    })

    /** Paths of the persona at position `i` under the temp dir, so personas collide only where a row says so. */
    const pathsAt = (i: number) => ({
      working_directory: join(dir, `p${i}`, 'work'),
      credentials_file: join(dir, `p${i}`, 'credentials.json'),
    })

    /** A real directory and a symlink to it, both inside the temp root; safe to call once per mode. */
    const symlinkedDir = () => {
      const target = join(dir, 'real-work')
      const link = join(dir, 'link-work')
      mkdirSync(target, { recursive: true })
      if (!existsSync(link)) symlinkSync(target, link)
      return { target, link }
    }

    interface CrossPersonaRow {
      label: string
      /** The two personas the error names, by array position. */
      offenders: [number, string][]
      /** Builds the personas with the persona builder of one mode. */
      build: (factory: typeof makePersona) => PersonaInput[]
      /** Record mode (b.av2 SR-1.5; b.deo SRI-104): only the real-path collision step is skipped. */
      record: 'loads' | 'rejects'
    }

    const CROSS_PERSONA_ROWS: CrossPersonaRow[] = [
      {
        label: 'the same name twice',
        offenders: [[0, MODE_NAME], [1, MODE_NAME]],
        build: (factory) => [0, 1].map((i) => factory({ name: MODE_NAME, ...pathsAt(i) }, dir)),
        record: 'rejects',
      },
      {
        label: "a name equal to another persona's key",
        offenders: [[0, MODE_NAME], [1, personaKey(MODE_NAME)]],
        build: (factory) => [MODE_NAME, personaKey(MODE_NAME)].map((name, i) => factory({ name, ...pathsAt(i) }, dir)),
        record: 'rejects',
      },
      {
        label: 'prefix-related keys',
        offenders: [[0, 'dev'], [1, 'dev_2']],
        build: (factory) => ['dev', 'dev_2'].map((name, i) => factory({ name, ...pathsAt(i) }, dir)),
        record: 'rejects',
      },
      {
        label: 'a shared working_directory',
        offenders: [[0, 'alpha'], [1, 'bravo']],
        build: (factory) =>
          ['alpha', 'bravo'].map((name, i) => factory({ name, ...pathsAt(i), working_directory: join(dir, 'shared-work') }, dir)),
        record: 'loads',
      },
      {
        label: 'a shared credentials_file',
        offenders: [[0, 'alpha'], [1, 'bravo']],
        build: (factory) =>
          ['alpha', 'bravo'].map((name, i) => factory({ name, ...pathsAt(i), credentials_file: join(dir, 'shared.json') }, dir)),
        record: 'loads',
      },
      {
        label: 'a symlinked duplicate working_directory inside the temp root',
        offenders: [[0, 'alpha'], [1, 'bravo']],
        build: (factory) => {
          const { target, link } = symlinkedDir()
          return [
            factory({ name: 'alpha', ...pathsAt(0), working_directory: target }, dir),
            factory({ name: 'bravo', ...pathsAt(1), working_directory: link }, dir),
          ]
        },
        record: 'loads',
      },
    ]

    test.each(CROSS_PERSONA_ROWS)('$label is rejected with the declarative-mode error', ({ offenders, build }) => {
      const fungible = loadError(underSwitch(true, ...build(makeFungiblePersona)))
      expect(fungible).toBe(loadError(underSwitch(undefined, ...build(makePersona))))
      for (const [index, name] of offenders) expect(fungible).toContain(indexedRef(index, name))
    })

    test.each(CROSS_PERSONA_ROWS)('record mode, $label: $record, as in declarative mode', ({ build, record }) => {
      const personas = build(makeFungiblePersona)
      const input = underSwitch(true, ...personas)
      const recordPath = join(dir, 'config.json.last-applied')
      const parse = (asRecord: boolean) =>
        parsePersonaConfigBytes(Buffer.from(JSON.stringify(input)), recordPath, dir, { home, record: asRecord })
      const messageOf = (run: () => unknown) => {
        try {
          run()
        } catch (err) {
          assertNoLeak(err, 'rejection')
          return (err as Error).message
        }
        return undefined
      }
      const standard = messageOf(() => parse(false))
      expect(standard).toBeDefined()
      if (record === 'loads') {
        const destinations = personas.map((p) => p.invited?.permission_prompts)
        expect(parse(true).personas.map((p) => p.fungible_destination)).toEqual(destinations)
        expect(resolvePersonaConfig(input, dir, home, { record: true }).personas.map((p) => p.fungible_destination)).toEqual(
          destinations,
        )
      } else {
        expect(messageOf(() => parse(true))).toBe(standard)
      }
    })
  })
})

// ---------------------------------------------------------------------------
// Stat-first read seam helpers (readPersonaConfigBytes' PersonaConfigFs)
// ---------------------------------------------------------------------------

/** A `PersonaConfigFs` op the reader made, with the descriptor it used (none for `open`). */
type ConfigFdCall = {
  op: 'open' | 'fstat' | 'read' | 'close'
  fd?: number
  /** For `read`: the most bytes the reader asked for, and how many the read returned. */
  maxBytes?: number
  returned?: number
}

/**
 * The real configuration-read seam with every call recorded; `overrides`
 * replace an op (a replaced `closeFile` still closes the real descriptor
 * first, so nothing leaks). Returns the seam, the calls and the descriptor
 * the real open returned.
 */
function recordingConfigFs(overrides: Partial<PersonaConfigFs> = {}) {
  const calls: ConfigFdCall[] = []
  let opened: number | undefined
  const fs: Partial<PersonaConfigFs> = {
    openFile: (path) => {
      calls.push({ op: 'open' })
      opened = (overrides.openFile ?? DEFAULT_PERSONA_CONFIG_FS.openFile)(path)
      return opened
    },
    fstatFile: (fd) => {
      calls.push({ op: 'fstat', fd })
      return (overrides.fstatFile ?? DEFAULT_PERSONA_CONFIG_FS.fstatFile)(fd)
    },
    readFileFd: (fd, maxBytes) => {
      const call: ConfigFdCall = { op: 'read', fd, maxBytes }
      calls.push(call)
      const bytes = (overrides.readFileFd ?? DEFAULT_PERSONA_CONFIG_FS.readFileFd)(fd, maxBytes)
      call.returned = bytes.length
      return bytes
    },
    closeFile: (fd) => {
      calls.push({ op: 'close', fd })
      DEFAULT_PERSONA_CONFIG_FS.closeFile(fd)
      overrides.closeFile?.(fd)
    },
  }
  return { fs, calls, opened: () => opened }
}

/** An operation that throws an errno-style error with `code`. */
function configFsFailsWith(code: string): () => never {
  return () => {
    throw Object.assign(new Error(`simulated ${code}`), { code })
  }
}

/** An injected `fstatFile` for a FIFO, socket or device: neither a file nor a directory. */
const NOT_REGULAR_STATS = () => ({ isFile: () => false, isDirectory: () => false })

/**
 * Run `body` in a child `bun` with `config` bound to src/config.ts, bounded at
 * 10 s: a blocking open or read of a FIFO with no writer never returns, so
 * in-process it would hang the whole suite instead of failing the test.
 * `body` prints one JSON line; returns the child and that line parsed.
 * The child is Bun by absolute path (`process.execPath`) with its `env` a
 * direct `hostSafeChildEnv` call (b.av2 SR-13.2, b.jg5 SRJ-1302): the test's
 * temp `home` as HOME, no tool (so `PATH` names no directory) and a state dir
 * under `home` as `SLACK_STATE_DIR`; nothing else comes from `process.env`.
 */
function runConfigChild(body: string, home: string) {
  const modulePath = join(import.meta.dir, '..', 'src', 'config.ts')
  const script = `const config = await import(${JSON.stringify(modulePath)})\n${body}`
  const child = spawnSync(process.execPath, ['-e', script], {
    timeout: 10_000,
    encoding: 'utf-8',
    env: hostSafeChildEnv(home, { tools: [], extras: { SLACK_STATE_DIR: join(home, 'state') } }),
  })
  return { child, out: child.signal === null && child.stdout.trim() !== '' ? JSON.parse(child.stdout.trim()) : undefined }
}

/** Child-script source for a seam over `config.DEFAULT_PERSONA_CONFIG_FS` that records op names into `ops`. */
const CHILD_RECORDING_FS = `
  const d = config.DEFAULT_PERSONA_CONFIG_FS
  const ops = []
  const fs = {
    openFile: (p) => (ops.push('open'), d.openFile(p)),
    fstatFile: (fd) => (ops.push('fstat'), d.fstatFile(fd)),
    readFileFd: (fd, maxBytes) => (ops.push('read'), d.readFileFd(fd, maxBytes)),
    closeFile: (fd) => (ops.push('close'), d.closeFile(fd)),
  }
`

// ---------------------------------------------------------------------------
// describeUnknownKeys (b.av2 SR-10.3; Director decision 5): only plain setting
// names are echoed. Pure; the loader's use of it is in `unknown keys` above.
// ---------------------------------------------------------------------------

describe('describeUnknownKeys (b.av2 SR-10.3)', () => {
  const ONE = '1 field whose name is not shown (it is not a plain setting name, so it could be a pasted secret)'
  const many = (n: number) => `${n} fields whose names are not shown (they are not plain setting names, so they could be pasted secrets)`

  // Rows: label, the one unknown key, whether it is echoed.
  test.each<[string, string, boolean]>([
    ['a typo of a setting is echoed', 'chanels', true],
    ['letters and underscores are echoed', 'extra_Setting', true],
    ['one underscore (the shortest name) is echoed', '_', true],
    ['48 letters (the longest name) are echoed', 'a'.repeat(48), true],
    ['49 letters are counted, not shown', 'a'.repeat(49), false],
    ['the empty name is counted, not shown', '', false],
    ['a name with a digit is counted, not shown', 'chanels2', false],
    ['a name with a dash is counted, not shown', 'bot-token', false],
    ['a name with a dot is counted, not shown', 'dm.enabled', false],
    ['a ghp_-style token with digits is counted, not shown', fakeToken('ghp_'), false],
    ['an xoxb- token is counted, not shown', fakeToken(BOT_TOKEN_PREFIX), false],
  ])('%s', (_label, key, echoed) => {
    const described = describeUnknownKeys([key])
    expect(described).toBe(echoed ? JSON.stringify(key) : ONE)
    assertNoLeak(described)
  })

  test.each<[string, string[], string]>([
    ['all echoable, JSON-quoted in order', ['chanels', 'extra'], '"chanels", "extra"'],
    ['all hidden, counted', [fakeToken(BOT_TOKEN_PREFIX), fakeToken(APP_TOKEN_PREFIX)], many(2)],
    [
      'mixed: the echoable names in order, then the hidden count',
      [fakeToken(BOT_TOKEN_PREFIX), 'chanels', 'x'.repeat(49), 'extra', fakeToken('ghp_')],
      `"chanels", "extra", plus ${many(3)}`,
    ],
    ['one echoable and one hidden', ['chanels', fakeToken(APP_TOKEN_PREFIX)], `"chanels", plus ${ONE}`],
  ])('%s', (_label, keys, expected) => {
    const described = describeUnknownKeys(keys)
    expect(described).toBe(expected)
    assertNoLeak(described)
  })
})

// ---------------------------------------------------------------------------
// personaKeysPrefixRelated / suggestNonPrefixingName (b.1ix follow-up)
// ---------------------------------------------------------------------------

describe('personaKeysPrefixRelated (b.1ix follow-up)', () => {
  test.each([
    ['dev', 'dev_2', true],
    ['dev_2', 'dev', true],
    ['horde', 'horde_admin', true],
    ['dev_2', 'dev_20', true],
    ['dev', 'dev', true],
    ['dev_a', 'dev_b', false],
    ['alpha', 'beta', false],
    ['ops_bot_1a2b3c4d', 'ops_bot_5e6f7a8b', false],
  ])('%s and %s: %p, in either order', (a, b, related) => {
    expect(personaKeysPrefixRelated(a, b)).toBe(related)
    expect(personaKeysPrefixRelated(b, a)).toBe(related)
  })
})

describe('suggestNonPrefixingName (b.1ix follow-up)', () => {
  /** Persona name-and-key pairs for in-form names, each its own key. */
  const inForm = (...names: string[]) => names.map((name) => ({ name, key: personaKey(name) }))

  test.each([
    ['dev beside dev_2', 'dev', inForm('dev_2'), 'dev_main'],
    ['horde beside the other horde_ keys', 'horde', inForm('general', 'horde_admin', 'horde_apiary'), 'horde_main'],
    ['a key that starts with <key>_main moves to _main_2', 'dev', inForm('dev_2', 'dev_main_x'), 'dev_main_2'],
    ['keys starting with <key>_main and <key>_main_2 move to _main_3', 'dev', inForm('dev_2', 'dev_main_x', 'dev_main_2x'), 'dev_main_3'],
    ['a hashed key beside it', 'dev', [{ name: 'Dev Bot', key: personaKey('Dev Bot') }], 'dev_main'],
  ])('%s: %s becomes %p', (_label, key, others, expected) => {
    const suggestion = suggestNonPrefixingName(key, others)
    expect(suggestion).toBe(expected)
    for (const other of others) expect(personaKeysPrefixRelated(personaKey(suggestion!), other.key)).toBe(false)
  })

  test.each([
    ['another key is a proper prefix of it', 'dev', inForm('d')],
    ['another key is <key>_main', 'dev', inForm('dev_main')],
    ['another key is <key>_', 'dev', inForm('dev_')],
  ])('undefined when %s: every candidate starts with that key', (_label, key, others) => {
    expect(suggestNonPrefixingName(key, others)).toBeUndefined()
  })

  test('a candidate over 40 characters is checked by its derived key, and one whose key is another persona\'s name is skipped', () => {
    const key = 'a'.repeat(38)
    const first = `${key}_main`
    // Over 40 characters, so not its own key: it gets a derived key.
    expect(personaKey(first)).not.toBe(first)
    expect(suggestNonPrefixingName(key, [])).toBe(first)
    // A persona named by that derived key: its own key is not prefix-related
    // to it, so only the name check skips the first candidate.
    const named = { name: personaKey(first), key: personaKey(personaKey(first)) }
    expect(personaKeysPrefixRelated(personaKey(first), named.key)).toBe(false)
    expect(suggestNonPrefixingName(key, [named])).toBe(`${key}_main_2`)
  })

  test("never proposes a name equal to another persona's key", () => {
    const key = 'a'.repeat(38)
    const first = `${key}_main`
    // A key that is the first candidate as written (not its derived key), so no prefix relation catches it.
    const other = { name: 'other', key: first }
    expect(personaKeysPrefixRelated(personaKey(first), other.key)).toBe(false)
    expect(suggestNonPrefixingName(key, [other])).toBe(`${key}_main_2`)
  })
})

// ---------------------------------------------------------------------------
// credentialsFilesToProtect (b.av2 SR-5.2)
// ---------------------------------------------------------------------------

describe('credentialsFilesToProtect (b.av2 SR-5.2)', () => {
  let dir: string
  let home: string
  let lines: string[]
  const originalConsole = { error: console.error, warn: console.warn, log: console.log }

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'protect-config-'))
    home = mkdtempSync(join(tmpdir(), 'protect-home-'))
    lines = []
    const capture = (...args: unknown[]) => { lines.push(args.map(String).join(' ')) }
    console.error = capture
    console.warn = capture
    console.log = capture
  })

  afterEach(() => {
    Object.assign(console, originalConsole)
    rmSync(dir, { recursive: true, force: true })
    rmSync(home, { recursive: true, force: true })
  })

  /** The applied personas: one default persona whose credentials file exists under `dir`. */
  function appliedPersonas() {
    const personas = makePersonaConfig({}, dir).personas
    writeCredentialsFile(dir, relative(dir, personas[0].credentials_file))
    return personas
  }

  /** Build the list; every result and captured line must pass `assertNoLeak`. */
  function build(applied: ReturnType<typeof appliedPersonas>, configPath: string): string[] {
    const list = credentialsFilesToProtect(applied, configPath, home)
    assertNoLeak({ list, lines })
    return list
  }

  /** A current config file (file form) naming `credentials_file` for its one persona. */
  const writeCurrent = (credentialsFile: string, persona: Partial<PersonaInput> = {}) =>
    writeConfigFile(dir, makePersonaConfigInput({
      personas: [makePersona({ name: 'current_bot', credentials_file: credentialsFile, ...persona }, dir)],
    }, dir))

  test('holds the applied personas\' paths and the paths the current config file names', () => {
    const applied = appliedPersonas()
    const current = writeCredentialsFile(dir, 'current/credentials.json')
    expect(build(applied, writeCurrent(current))).toEqual([applied[0].credentials_file, current])
  })

  test('a path named only by the current config file is listed with no applied personas', () => {
    const current = writeCredentialsFile(dir, 'current/credentials.json')
    expect(build([], writeCurrent(current))).toEqual([current])
  })

  test('~ in the config path and in credentials_file expands under the injected home, never the OS home', () => {
    writeConfigFile(home, makePersonaConfigInput({
      personas: [makePersona({ credentials_file: '~/creds/credentials.json' }, dir)],
    }, dir))
    const list = build([], '~/config.json')
    expect(list).toEqual([join(home, 'creds', 'credentials.json')])
    expect(list).not.toContain(join(homedir(), 'creds', 'credentials.json'))
  })

  test('a current file that fails persona validation still contributes its credentials_file', () => {
    const current = join(dir, 'current', 'credentials.json')
    const path = writeCurrent(current, { working_directory: undefined })
    let rejection: unknown
    try {
      loadPersonaConfig(path, home)
    } catch (err) {
      rejection = err
    }
    expect(rejection).toBeInstanceOf(Error)
    assertNoLeak(rejection, 'rejection')
    expect(build([], path)).toEqual([current])
  })

  test.each([
    ['a missing file', () => join(dir, 'absent.json')],
    // A directory: reading it fails on every platform and as root.
    ['an unreadable file', () => { mkdirSync(join(dir, 'unreadable.json')); return join(dir, 'unreadable.json') }],
    ['invalid JSON', () => {
      const path = join(dir, 'config.json')
      writeFileSync(path, `{ "personas": [ { "credentials_file": "${fakeToken(BOT_TOKEN_PREFIX)}" `, 'utf-8')
      return path
    }],
    ['a route-shaped file', () => writeConfigFile(dir, { routes: { C0TEST001: { cwd: join(dir, 'work') } } })],
    ['a non-array personas', () => writeConfigFile(dir, { personas: { credentials_file: join(dir, 'x.json') } })],
    ['a non-string credentials_file', () => writeConfigFile(dir, { personas: [{ name: 'x', credentials_file: 42 }] })],
    ['a JSON null', () => writeConfigFile(dir, null)],
  ])('%s yields only the applied personas\' paths, without throwing', (_label, setup) => {
    const applied = appliedPersonas()
    expect(build(applied, setup())).toEqual([applied[0].credentials_file])
  })

  // The current file is read through readPersonaConfigBytes' stat-first rule:
  // a config.json that is not a regular file is never read and contributes
  // nothing, and the descriptor is closed.
  // Rows: label, arrange, whether the current file's path is listed, ops made after the open.
  test.each<[string, () => { path: string; overrides: Partial<PersonaConfigFs> }, boolean, ConfigFdCall['op'][]]>([
    ['a regular file, read through the injected seam', () => ({ path: writeCurrent(join(dir, 'current', 'credentials.json')), overrides: {} }),
      true, ['fstat', 'read', 'close']],
    ['a non-regular file, as the injected fstatFile reports it', () => ({
      path: writeCurrent(join(dir, 'current', 'credentials.json')),
      overrides: { fstatFile: NOT_REGULAR_STATS },
    }), false, ['fstat', 'close']],
    ['a symlink to /dev/zero (real character device)', () => {
      symlinkSync('/dev/zero', join(dir, 'config.json'))
      return { path: join(dir, 'config.json'), overrides: {} }
    }, false, ['fstat', 'close']],
    ['a read that fails with EIO (injected)', () => ({
      path: writeCurrent(join(dir, 'current', 'credentials.json')),
      overrides: { readFileFd: configFsFailsWith('EIO') },
    }), false, ['fstat', 'read', 'close']],
  ])('%s: opened once, closed, and only a regular file read contributes its paths', (_label, arrange, contributes, afterOpen) => {
    const applied = appliedPersonas()
    const { path, overrides } = arrange()
    const { fs, calls, opened } = recordingConfigFs(overrides)

    const list = credentialsFilesToProtect(applied, path, home, fs)

    assertNoLeak({ list, lines }, 'protect')
    expect(list).toEqual(contributes
      ? [applied[0].credentials_file, join(dir, 'current', 'credentials.json')]
      : [applied[0].credentials_file])
    expect(calls.map((c) => c.op)).toEqual(['open', ...afterOpen])
    expect(calls.slice(1).every((c) => c.fd === opened())).toBe(true)
    expect(() => fstatSync(opened()!)).toThrow()
    expect(lines).toEqual([])
  })

  // The 64 KiB cap exempts this one read: a config.json grown past the cap
  // still protects every credentials file it names, even one named only after
  // the first 65,537 bytes. The padding is sentinel-bearing fake token text,
  // so a leak of the file's content fails assertNoLeak.
  /** A config.json over 3 × 64 KiB whose one persona names `credentialsFile` after the padding. */
  function writeOversizedCurrent(credentialsFile: string): string {
    const unit = `${fakeToken(BOT_TOKEN_PREFIX, 'padding')} `
    const padding = unit.repeat(Math.ceil((3 * MAX_RELOAD_FILE_BYTES) / unit.length) + 1)
    const path = writeConfigFile(dir, {
      notes: padding,
      ...makePersonaConfigInput({ personas: [makePersona({ name: 'current_bot', credentials_file: credentialsFile }, dir)] }, dir),
    })
    expect(statSync(path).size).toBeGreaterThan(3 * MAX_RELOAD_FILE_BYTES)
    expect(readFileSync(path, 'utf-8').indexOf(credentialsFile)).toBeGreaterThan(MAX_RELOAD_FILE_BYTES + 1)
    return path
  }

  test('a config.json over the 64 KiB cap is read whole and uncapped: the path it names is listed and refused by assertSendable, while the capped reader refuses the same file with EFBIG', () => {
    const applied = appliedPersonas()
    // Outside the state directory, so only the list can refuse it.
    const named = writeCredentialsFile(dir, 'outside/credentials.json')
    const path = writeOversizedCurrent(named)
    const { fs, calls, opened } = recordingConfigFs()

    const list = credentialsFilesToProtect(applied, path, home, fs)

    assertNoLeak({ list, lines }, 'protect')
    expect(list).toEqual([applied[0].credentials_file, named])
    expect(calls.map((c) => c.op)).toEqual(['open', 'fstat', 'read', 'close'])
    expect(calls.find((c) => c.op === 'read')).toMatchObject({ maxBytes: Infinity, returned: statSync(path).size })
    expect(() => fstatSync(opened()!)).toThrow()
    expect(lines).toEqual([])

    const stateDir = join(dir, 'state')
    const inboxDir = join(stateDir, 'inbox')
    expect(() => assertSendable(named, stateDir, inboxDir, list)).toThrow(`Blocked: cannot send ${named} — it is a persona credentials file.`)
    expect(() => assertSendable(named, stateDir, inboxDir, [applied[0].credentials_file])).not.toThrow()

    // Every other read of the same file is capped.
    let refused: unknown
    try {
      readPersonaConfigBytes(path)
    } catch (err) {
      refused = err
    }
    assertNoLeak(refused, 'capped read')
    expect(refused).toBeInstanceOf(PersonaConfigReadError)
    expect((refused as PersonaConfigReadError).code).toBe('EFBIG')
  })

  // Uncapped is not unchecked: stat-first still refuses a config.json that is
  // not a regular file before any read, so it contributes nothing and nothing throws.
  test.each<[string, () => { path: string; overrides: Partial<PersonaConfigFs> }]>([
    ['an oversized file reported as a FIFO by the injected fstatFile', () => ({
      path: writeOversizedCurrent(join(dir, 'current', 'credentials.json')),
      overrides: { fstatFile: NOT_REGULAR_STATS },
    })],
    ['a real directory', () => {
      mkdirSync(join(dir, 'config.json'))
      return { path: join(dir, 'config.json'), overrides: {} }
    }],
  ])('%s at the config path: never read, only the applied paths, no throw', (_label, arrange) => {
    const applied = appliedPersonas()
    const { path, overrides } = arrange()
    const { fs, calls, opened } = recordingConfigFs(overrides)

    const list = credentialsFilesToProtect(applied, path, home, fs)

    assertNoLeak({ list, lines }, 'protect')
    expect(list).toEqual([applied[0].credentials_file])
    expect(calls.map((c) => c.op)).toEqual(['open', 'fstat', 'close'])
    expect(() => fstatSync(opened()!)).toThrow()
    expect(lines).toEqual([])
  })

  test.skipIf(!mkfifoAvailable())('a real FIFO config.json with no writer: returns the applied paths at once, never read, descriptor closed (child process, 10 s bound; skipped where mkfifo is unavailable)', () => {
    const path = join(dir, 'config.json')
    makeFifo(path)
    const applied = [{ credentials_file: join(dir, 'applied', 'credentials.json') }]

    const { child, out } = runConfigChild(`${CHILD_RECORDING_FS}
      const list = config.credentialsFilesToProtect(${JSON.stringify(applied)}, ${JSON.stringify(path)}, ${JSON.stringify(home)}, fs)
      console.log(JSON.stringify({ list, ops }))
    `, home)

    assertNoLeak({ stdout: child.stdout, stderr: child.stderr }, 'child')
    expect(child.signal).toBeNull()
    expect(out).toEqual({ list: [applied[0].credentials_file], ops: ['open', 'fstat', 'close'] })
  }, 15_000)
})

// ---------------------------------------------------------------------------
// referencedCredentialsPaths (b.av2 SR-8.3): the extraction both
// credentialsFilesToProtect and the reload fingerprint use. Its ~ expansion,
// validation tolerance and the failure shapes shared with the file guard are
// covered through credentialsFilesToProtect above; these cases are its own.
// Pure: no file is read or written.
// ---------------------------------------------------------------------------

describe('referencedCredentialsPaths (b.av2 SR-8.3)', () => {
  // An injected home that exists nowhere: expansion is string work only.
  const home = '/nonexistent-home-for-test'

  const configText = (personas: unknown): string => JSON.stringify({ personas })

  test('returns each credentials_file in declaration order, duplicates kept, from bytes or text alike', () => {
    const text = configText([
      { name: 'beta', credentials_file: '/creds/beta.json' },
      { name: 'alpha', credentials_file: '/creds/alpha.json' },
      { name: 'gamma', credentials_file: '/creds/beta.json' },
    ])

    const fromText = referencedCredentialsPaths(text, home)
    const fromBytes = referencedCredentialsPaths(new TextEncoder().encode(text), home)

    expect(fromText).toEqual(['/creds/beta.json', '/creds/alpha.json', '/creds/beta.json'])
    expect(fromBytes).toEqual(fromText)
  })

  test('relative and ~user paths are made absolute as written; entries without a usable credentials_file are skipped', () => {
    const list = referencedCredentialsPaths(configText([
      { credentials_file: '~other/b.json' },
      { credentials_file: 'rel/c.json' },
      { credentials_file: '/abs/../abs/d.json' },
      { credentials_file: '' },
      { credentials_file: ['/creds/array.json'] },
      null,
      '/creds/string-entry.json',
    ]), home)

    expect(list).toEqual([resolve('~other/b.json'), resolve('rel/c.json'), '/abs/d.json'])
  })

  test.each<[string, string | Uint8Array]>([
    ['a top-level array', JSON.stringify([{ credentials_file: '/creds/a.json' }])],
    ['a top-level string', JSON.stringify('/creds/a.json')],
    ['bytes that are not UTF-8', new Uint8Array([0x7b, 0xff, 0xfe, 0x7d])],
  ])('%s yields no paths, without throwing', (_label, input) => {
    let list: string[] | undefined
    let error: unknown
    try {
      list = referencedCredentialsPaths(input, home)
    } catch (err) {
      error = err
    }

    expect(error).toBeUndefined()
    expect(list).toEqual([])
    assertNoLeak({ list, error })
  })
})

// ---------------------------------------------------------------------------
// Server config path (b.av2 SR-1.1, SR-8.7)
// ---------------------------------------------------------------------------

/** Environment variables this block changes; restored after every test. */
const START_ENV_KEYS = ['SLACK_STATE_DIR'] as const

/** Save the variables in `START_ENV_KEYS` and return a restore function. */
function saveStartEnv(): () => void {
  const saved = START_ENV_KEYS.map((key) => [key, process.env[key]] as const)
  return () => {
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  }
}

describe('resolveServerConfigPath / resolveServerStateDir (b.av2 SR-1.1)', () => {
  let dir: string
  let home: string
  let restoreEnv: () => void

  beforeEach(() => {
    restoreEnv = saveStartEnv()
    dir = mkdtempSync(join(tmpdir(), 'server-path-'))
    home = mkdtempSync(join(tmpdir(), 'server-path-home-'))
  })

  afterEach(() => {
    restoreEnv()
    rmSync(dir, { recursive: true, force: true })
    rmSync(home, { recursive: true, force: true })
  })

  test('SLACK_STATE_DIR set to a directory gives <that dir>/config.json, whatever the home', () => {
    const env = { SLACK_STATE_DIR: dir }
    expect(resolveServerStateDir(home, env)).toBe(dir)
    expect(resolveServerConfigPath(home, env)).toBe(join(dir, 'config.json'))
  })

  test('a relative SLACK_STATE_DIR is made absolute against the working directory', () => {
    const path = resolveServerConfigPath(home, { SLACK_STATE_DIR: join('rel', 'state') })
    expect(path).toBe(join(process.cwd(), 'rel', 'state', 'config.json'))
  })

  test.each([
    ['unset', {}],
    ['empty', { SLACK_STATE_DIR: '' }],
  ])('SLACK_STATE_DIR %s gives <home>/.claude/channels/slack/config.json under the injected home', (_label, env) => {
    expect(resolveServerStateDir(home, env)).toBe(join(home, '.claude', 'channels', 'slack'))
    expect(resolveServerConfigPath(home, env)).toBe(join(home, '.claude', 'channels', 'slack', 'config.json'))
  })

  test('process.env is read at call time: changing SLACK_STATE_DIR between calls changes the result', () => {
    const first = join(dir, 'first')
    const second = join(dir, 'second')
    process.env['SLACK_STATE_DIR'] = first
    expect(resolveServerConfigPath(home)).toBe(join(first, 'config.json'))
    process.env['SLACK_STATE_DIR'] = second
    expect(resolveServerConfigPath(home)).toBe(join(second, 'config.json'))
    delete process.env['SLACK_STATE_DIR']
    expect(resolveServerConfigPath(home)).toBe(join(home, '.claude', 'channels', 'slack', 'config.json'))
  })
})


// ---------------------------------------------------------------------------
// Start-path primitives (b.av2 SR-8.7, SR-1.5 record-start part, SR-10.3):
// readPersonaConfigBytes, configFileReadFailureMessage and
// parsePersonaConfigBytes. Which file a start runs, and what it logs, is
// covered in tests/reload.test.ts.
// ---------------------------------------------------------------------------

describe('start-path primitives (b.av2 SR-8.7, SR-1.5, SR-10.3)', () => {
  let dir: string
  let home: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'config-bytes-'))
    home = mkdtempSync(join(tmpdir(), 'config-bytes-home-'))
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
    rmSync(home, { recursive: true, force: true })
  })

  /** Call `fn`, expecting a throw; returns the error after `assertNoLeak`. */
  function thrown(fn: () => unknown): Error {
    try {
      fn()
    } catch (err) {
      assertNoLeak(err, 'rejection')
      return err as Error
    }
    throw new Error('expected a throw')
  }

  describe('readPersonaConfigBytes and configFileReadFailureMessage', () => {
    const requiredMessage = (path: string, what: string) =>
      `The configuration file "${path}" ${what}. The server requires the configuration file to start.`

    test('returns the file\'s exact bytes, a byte order mark and invalid UTF-8 included', () => {
      const path = join(dir, 'config.json')
      const bytes = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('{}'), Buffer.from([0xff, 0x0a])])
      writeFileSync(path, bytes)
      const read = readPersonaConfigBytes(path)
      assertNoLeak(read, 'bytes')
      expect(read.equals(bytes)).toBe(true)
    })

    test.each([
      { label: 'a missing file', code: 'ENOENT', what: 'does not exist', setup: () => join(dir, 'config.json') },
      {
        label: 'a path under a regular file',
        code: 'ENOTDIR',
        what: 'does not exist',
        setup: () => {
          writeFileSync(join(dir, 'not-a-dir'), '', 'utf-8')
          return join(dir, 'not-a-dir', 'config.json')
        },
      },
      // A directory fails to read on every platform and as root.
      {
        label: 'a directory',
        code: 'EISDIR',
        what: 'cannot be read (EISDIR)',
        setup: () => {
          mkdirSync(join(dir, 'config.json'))
          return join(dir, 'config.json')
        },
      },
    ])('$label throws a PersonaConfigReadError with $code; the start message names the path and says "$what"', ({ setup, code, what }) => {
      const path = setup()
      const err = thrown(() => readPersonaConfigBytes(path))
      const startMessage = configFileReadFailureMessage(path, code)
      assertNoLeak({ err, startMessage }, 'read failure')
      expect(err).toBeInstanceOf(PersonaConfigReadError)
      expect((err as PersonaConfigReadError).code).toBe(code)
      expect(err.message).toContain(path)
      expect(isMissingConfigCode(code)).toBe(what === 'does not exist')
      expect(startMessage).toBe(requiredMessage(path, what))
    })

    test('a read error with no errno code is "cannot be read" with no code, and not a missing file', () => {
      const path = join(dir, 'config.json')
      const startMessage = configFileReadFailureMessage(path, undefined)
      assertNoLeak(startMessage, 'start message')
      expect(isMissingConfigCode(undefined)).toBe(false)
      expect(startMessage).toBe(requiredMessage(path, 'cannot be read'))
    })
  })

  // Stat-first (b.av2 SR-8.7 with the E2 FIFO carry): the file is opened once,
  // read-only and non-blocking, its descriptor is stat'ed, only a regular file
  // is read through that same descriptor, and the descriptor is always closed.
  describe('readPersonaConfigBytes: opened once, checked, read and closed through its descriptor', () => {
    const exactMessage = (path: string, cause: string) => `loadPersonaConfig: cannot read persona config at "${path}": ${cause}`
    const CONTENT = '{ "personas": [] }\n'

    type Row = {
      label: string
      arrange: (path: string) => Partial<PersonaConfigFs>
      /** The error code, or `'ok'` when the file's bytes are returned. */
      code: string
      /** The exact message's cause, for an error row. */
      cause?: string
      afterOpen: ConfigFdCall['op'][]
    }
    test.each<Row>([
      { label: 'a regular file', arrange: (p) => (writeFileSync(p, CONTENT), {}), code: 'ok', afterOpen: ['fstat', 'read', 'close'] },
      {
        label: 'a symlink to a regular file (followed, read)',
        arrange: (p) => (writeFileSync(join(dir, 'target.json'), CONTENT), symlinkSync(join(dir, 'target.json'), p), {}),
        code: 'ok',
        afterOpen: ['fstat', 'read', 'close'],
      },
      {
        label: 'a directory (real)',
        arrange: (p) => (mkdirSync(p), {}),
        code: 'EISDIR',
        cause: 'it is a directory',
        afterOpen: ['fstat', 'close'],
      },
      {
        label: 'a symlink to /dev/zero (real character device)',
        arrange: (p) => (symlinkSync('/dev/zero', p), {}),
        code: CONFIG_NOT_REGULAR_FILE_CODE,
        cause: 'it is not a regular file',
        afterOpen: ['fstat', 'close'],
      },
      {
        label: 'a FIFO, as the injected fstatFile reports it',
        arrange: (p) => (writeFileSync(p, CONTENT), { fstatFile: NOT_REGULAR_STATS }),
        code: CONFIG_NOT_REGULAR_FILE_CODE,
        cause: 'it is not a regular file',
        afterOpen: ['fstat', 'close'],
      },
      {
        label: 'fstat fails with EIO (injected)',
        arrange: (p) => (writeFileSync(p, CONTENT), { fstatFile: configFsFailsWith('EIO') }),
        code: 'EIO',
        cause: 'simulated EIO',
        afterOpen: ['fstat', 'close'],
      },
      {
        label: 'the read fails with EIO (injected)',
        arrange: (p) => (writeFileSync(p, CONTENT), { readFileFd: configFsFailsWith('EIO') }),
        code: 'EIO',
        cause: 'simulated EIO',
        afterOpen: ['fstat', 'read', 'close'],
      },
      {
        label: 'closing throws (injected): ignored, the bytes stand',
        arrange: (p) => (writeFileSync(p, CONTENT), { closeFile: configFsFailsWith('EIO') }),
        code: 'ok',
        afterOpen: ['fstat', 'read', 'close'],
      },
      {
        label: 'closing throws after a refused non-regular file (injected): ignored, the refusal stands',
        arrange: (p) => (writeFileSync(p, CONTENT), { fstatFile: NOT_REGULAR_STATS, closeFile: configFsFailsWith('EBADF') }),
        code: CONFIG_NOT_REGULAR_FILE_CODE,
        cause: 'it is not a regular file',
        afterOpen: ['fstat', 'close'],
      },
    ])('$label', ({ arrange, code, cause, afterOpen }) => {
      const path = join(dir, 'config.json')
      const { fs, calls, opened } = recordingConfigFs(arrange(path))

      if (code === 'ok') {
        const bytes = readPersonaConfigBytes(path, fs)
        assertNoLeak(bytes, 'bytes')
        expect(bytes.toString('utf-8')).toBe(CONTENT)
      } else {
        const err = thrown(() => readPersonaConfigBytes(path, fs))
        const startMessage = configFileReadFailureMessage(path, (err as PersonaConfigReadError).code)
        assertNoLeak({ err, startMessage }, 'read failure')
        expect(err).toBeInstanceOf(PersonaConfigReadError)
        expect((err as PersonaConfigReadError).code).toBe(code)
        expect(err.message).toBe(exactMessage(path, cause!))
        expect(isMissingConfigCode(code)).toBe(false)
        expect(startMessage).toBe(`The configuration file "${path}" cannot be read (${code}). The server requires the configuration file to start.`)
      }
      // Opened once; every later op used that descriptor; closed exactly once, last, for real.
      expect(calls.map((c) => c.op)).toEqual(['open', ...afterOpen])
      expect(calls.slice(1).every((c) => c.fd === opened())).toBe(true)
      expect(() => fstatSync(opened()!)).toThrow()
    })

    test('the start message for a non-regular file is exact', () => {
      const path = join(dir, 'config.json')
      const startMessage = configFileReadFailureMessage(path, CONFIG_NOT_REGULAR_FILE_CODE)
      assertNoLeak(startMessage, 'start message')
      expect(CONFIG_NOT_REGULAR_FILE_CODE).toBe('not a regular file')
      expect(isMissingConfigCode(CONFIG_NOT_REGULAR_FILE_CODE)).toBe(false)
      expect(startMessage).toBe(`The configuration file "${path}" cannot be read (not a regular file). The server requires the configuration file to start.`)
    })

    test.each([
      ['missing (real)', 'ENOENT'],
      ['open denied with EACCES (injected)', 'EACCES'],
      ['open fails with EIO (injected)', 'EIO'],
    ])('a failed open (%s): nothing to stat, read or close', (_label, code) => {
      const path = join(dir, 'config.json')
      if (code !== 'ENOENT') writeFileSync(path, CONTENT)
      const { fs, calls } = recordingConfigFs(code === 'ENOENT' ? {} : { openFile: configFsFailsWith(code) })

      const err = thrown(() => readPersonaConfigBytes(path, fs))

      assertNoLeak(err, 'read failure')
      expect(err).toBeInstanceOf(PersonaConfigReadError)
      expect((err as PersonaConfigReadError).code).toBe(code)
      expect(err.message).toContain(path)
      expect(calls.map((c) => c.op)).toEqual(['open'])
    })

    test.skipIf(!mkfifoAvailable())('a real FIFO with no writer: the open does not wait, it is refused unread and closed, and the path loader fails the same way (child process, 10 s bound; skipped where mkfifo is unavailable)', () => {
      const path = join(dir, 'config.json')
      makeFifo(path)

      const { child, out } = runConfigChild(`${CHILD_RECORDING_FS}
        const outcome = (fn) => { try { fn(); return 'returned' } catch (e) { return { name: e.name, code: e.code, message: e.message } } }
        const reader = outcome(() => config.readPersonaConfigBytes(${JSON.stringify(path)}, fs))
        const loader = outcome(() => config.loadPersonaConfig(${JSON.stringify(path)}, ${JSON.stringify(home)}))
        console.log(JSON.stringify({ reader, loader, ops }))
      `, home)

      assertNoLeak({ stdout: child.stdout, stderr: child.stderr }, 'child')
      expect(child.signal).toBeNull()
      const refused = { name: 'PersonaConfigReadError', code: CONFIG_NOT_REGULAR_FILE_CODE, message: exactMessage(path, 'it is not a regular file') }
      expect(out).toEqual({ reader: refused, loader: refused, ops: ['open', 'fstat', 'close'] })
    }, 15_000)

    // The 64 KiB cap (65,536 bytes): a larger file is refused with EFBIG, named
    // by path and limit, carrying none of its content, and never read past
    // 65,537 bytes. The files hold sentinel-bearing fake token text, so a leak
    // of their content fails assertNoLeak.
    const tooLargeMessage = (path: string) => exactMessage(path, 'it is larger than the 64 KiB limit')
    const tooLargeStartMessage = (path: string) =>
      `The configuration file "${path}" is larger than the 64 KiB limit. The server requires the configuration file to start.`

    /** Write `size` bytes of fake token text (ASCII: one byte per character) at `path`; the bytes. */
    function writeTokenText(path: string, size: number): Buffer {
      const line = `${fakeToken(BOT_TOKEN_PREFIX, 'oversized')}\n`
      const bytes = Buffer.from(line.repeat(Math.ceil(size / line.length)).slice(0, size))
      writeFileSync(path, bytes)
      return bytes
    }

    /** Call `fn`, expecting a too-large refusal of `path`; checks the error and its start message. */
    function expectTooLarge(path: string, fn: () => unknown): void {
      const err = thrown(fn)
      const startMessage = configFileReadFailureMessage(path, (err as PersonaConfigReadError).code)
      assertNoLeak({ err, startMessage }, 'too large')
      expect(err).toBeInstanceOf(PersonaConfigReadError)
      expect((err as PersonaConfigReadError).code).toBe('EFBIG')
      expect(err.message).toBe(tooLargeMessage(path))
      expect(isMissingConfigCode('EFBIG')).toBe(false)
      expect(startMessage).toBe(tooLargeStartMessage(path))
    }

    test.each([
      { label: '65,536 bytes (the limit) is read in full, asking for at most 65,537', size: 65_536, afterOpen: ['fstat', 'read', 'close'] },
      { label: '65,537 bytes is refused on its stat, unread, and the path loader fails the same way', size: 65_537, afterOpen: ['fstat', 'close'] },
    ])('a file of $label', ({ size, afterOpen }) => {
      const path = join(dir, 'config.json')
      const content = writeTokenText(path, size)
      const { fs, calls, opened } = recordingConfigFs()

      if (size <= 65_536) {
        const bytes = readPersonaConfigBytes(path, fs)
        expect(bytes.length).toBe(size)
        expect(bytes.equals(content)).toBe(true)
        expect(calls.find((c) => c.op === 'read')).toMatchObject({ maxBytes: 65_537, returned: size })
      } else {
        expectTooLarge(path, () => readPersonaConfigBytes(path, fs))
        expectTooLarge(path, () => loadPersonaConfig(path, home))
      }
      expect(calls.map((c) => c.op)).toEqual(['open', ...afterOpen])
      expect(() => fstatSync(opened()!)).toThrow()
    })

    // A stat that under-reports (as for a file that grows after it) or omits
    // the size: the bounded read still refuses the file, asking for no more
    // than 65,537 bytes; a read double that returns more than it was asked
    // for is refused too.
    const regularStats = (size?: number) => () => ({ isFile: () => true, isDirectory: () => false, ...(size === undefined ? {} : { size }) })
    test.each<{ label: string; overrides: Partial<PersonaConfigFs>; returned: number }>([
      { label: 'fstat reports 10 bytes; the real bounded read', overrides: { fstatFile: regularStats(10) }, returned: 65_537 },
      { label: 'fstat reports no size; the real bounded read', overrides: { fstatFile: regularStats() }, returned: 65_537 },
      {
        label: 'fstat reports 10 bytes; a read double returning the whole file whatever it is asked for',
        overrides: { fstatFile: regularStats(10), readFileFd: (fd) => readFileSync(fd) },
        returned: 3 * 65_536,
      },
    ])('a 192 KiB file where $label: refused as too large, the read asked for at most 65,537 bytes', ({ overrides, returned }) => {
      const path = join(dir, 'config.json')
      writeTokenText(path, 3 * 65_536)
      const { fs, calls, opened } = recordingConfigFs(overrides)

      expectTooLarge(path, () => readPersonaConfigBytes(path, fs))

      expect(calls.map((c) => c.op)).toEqual(['open', 'fstat', 'read', 'close'])
      expect(calls.find((c) => c.op === 'read')).toMatchObject({ maxBytes: 65_537, returned })
      expect(() => fstatSync(opened()!)).toThrow()
    })
  })

  describe('parsePersonaConfigBytes', () => {
    /** The record's path beside the config file: the label a start from the record passes. */
    const recordPath = () => join(dir, 'config.json.last-applied')

    /** Parse `input`'s JSON bytes labelled with the record path. */
    const parse = (input: unknown, record = false) =>
      parsePersonaConfigBytes(Buffer.from(JSON.stringify(input)), recordPath(), dir, { home, record })

    /** Two personas, each with its own paths under `dir` unless overridden. */
    const twoPersonas = (ops: Partial<PersonaInput> = {}, review: Partial<PersonaInput> = {}) =>
      makePersonaConfigInput({
        personas: [
          makePersona({ name: 'Ops Bot', working_directory: join(dir, 'ops-work'), credentials_file: join(dir, 'ops.json'), ...ops }, dir),
          makePersona({ name: 'review_bot', working_directory: join(dir, 'review-work'), credentials_file: join(dir, 'review.json'), ...review }, dir),
        ],
      }, dir)

    const link = (target: string, rel: string) => {
      symlinkSync(target, join(dir, rel))
      return join(dir, rel)
    }

    test.each(['bytes', 'text'] as const)('a valid file\'s %s resolve, in both modes, to what loading it by path gives', (form) => {
      const path = writeConfigFile(dir, twoPersonas({ credentials_file: '~/creds/ops.json' }))
      const bytes = readPersonaConfigBytes(path)
      const expected = loadPersonaConfig(path, home)
      const given = form === 'bytes' ? new Uint8Array(bytes) : bytes.toString('utf-8')
      const results = {
        default: parsePersonaConfigBytes(given, path, dir, { home }),
        record: parsePersonaConfigBytes(given, path, dir, { home, record: true }),
      }
      assertNoLeak({ bytes, expected, results }, 'resolved')

      expect(results.default).toEqual(expected)
      expect(results.record).toEqual(expected)
      // `~` expands under the injected home on every route.
      expect(expected.personas[0].credentials_file).toBe(join(home, 'creds', 'ops.json'))
    })

    // Record mode (a start from config.json.last-applied) leaves a real-path
    // collision to the bring-up; the file loader and default mode still reject it.
    test.each([
      {
        label: 'the same literal working_directory',
        setting: 'working_directory',
        build: () => [join(dir, 'shared-work'), join(dir, 'shared-work')],
      },
      {
        label: "a symlink to the other persona's existing working_directory",
        setting: 'working_directory',
        build: () => {
          mkdirSync(join(dir, 'ops-work'))
          return [join(dir, 'ops-work'), link(join(dir, 'ops-work'), 'review-work')]
        },
      },
      {
        label: 'the same literal credentials_file',
        setting: 'credentials_file',
        build: () => [join(dir, 'shared.json'), join(dir, 'shared.json')],
      },
      {
        label: "a symlink to the other persona's existing credentials_file",
        setting: 'credentials_file',
        build: () => {
          const target = writeCredentialsFile(dir, 'ops.json')
          return [target, link(target, 'review.json')]
        },
      },
    ] as const)('record mode: $label validates with both personas present', ({ setting, build }) => {
      const [opsPath, reviewPath] = build()
      const input = twoPersonas({ [setting]: opsPath }, { [setting]: reviewPath })
      const path = writeConfigFile(dir, input)

      const config = parse(input, true)
      const resolved = resolvePersonaConfig(input, dir, home, { record: true })
      const errors = { default: thrown(() => parse(input)), loader: thrown(() => loadPersonaConfig(path, home)) }
      assertNoLeak({ config, resolved, errors }, 'collision')
      expect(config.personas.map((p) => [p.name, p[setting]])).toEqual([['Ops Bot', opsPath], ['review_bot', reviewPath]])
      expect(resolved).toEqual(config)

      for (const err of [errors.default, errors.loader]) {
        expect(err.message).toContain(`personas[1] ${JSON.stringify('review_bot')} (key=review_bot): ${setting}`)
        expect(err.message).toContain(`personas[0] ${JSON.stringify('Ops Bot')} (key=${personaKey('Ops Bot')})`)
      }
    })

    // Every rule other than the real-path collision still runs in record mode,
    // with the same error as default mode, naming the record's path.
    test.each([
      ['a duplicate name', () => twoPersonas({}, { name: 'Ops Bot' }), `name ${JSON.stringify('Ops Bot')}`],
      [
        'a duplicate name beside a shared working_directory',
        () => twoPersonas({ working_directory: join(dir, 'shared') }, { name: 'Ops Bot', working_directory: join(dir, 'shared') }),
        `name ${JSON.stringify('Ops Bot')}`,
      ],
      ['a duplicate key', () => twoPersonas({}, { name: personaKey('Ops Bot') }), `key ${personaKey('Ops Bot')}`],
      ['routes', () => ({ ...twoPersonas(), routes: {} }), prePersonaConversionMessage('routes')],
      ['default_route', () => ({ ...twoPersonas(), default_route: '/tmp/ops' }), prePersonaConversionMessage('default_route')],
      ['default_dm_session', () => ({ ...twoPersonas(), default_dm_session: '/tmp/ops' }), prePersonaConversionMessage('default_dm_session')],
      ['an unknown top-level key', () => ({ ...twoPersonas(), extra_setting: 1 }), '"extra_setting"'],
      ['a per-entry violation', () => twoPersonas({}, { permission_prompts: undefined }), 'permission_prompts'],
    ])('record mode still rejects %s, as default mode does, naming the record path', (_label, build, fragment) => {
      const input = build()
      const errors = { record: thrown(() => parse(input, true)), default: thrown(() => parse(input)) }
      assertNoLeak(errors, 'errors')
      const message = errors.record.message
      expect(message).toBe(errors.default.message)
      expect(message).toContain(fragment)
      expect(message).toContain(`invalid persona config in "${recordPath()}"`)
    })

    // SR-10.3 (E1/E2 carry): a malformed file gives the 1-based line and
    // column of the first invalid character and none of its content. A row's
    // leak marker sits where Bun's own parse error would quote it.
    const bareToken = `${LEAK_SENTINEL}_pasted`
    const quotedToken = fakeToken(BOT_TOKEN_PREFIX)
    test.each([
      { label: 'a pasted token as a bare value on line 3', line: 3, column: 16, text: `{\n  "personas": [],\n  "bot_token": ${bareToken}\n}` },
      {
        label: 'a pasted token in a string left open at the end of line 3',
        line: 3,
        column: 17 + quotedToken.length,
        text: `{\n  "personas": [],\n  "bot_token": "${quotedToken}\n}`,
      },
      { label: 'a file that ends inside the personas array', line: 1, column: 16, text: '{ "personas": [' },
      {
        label: 'a character outside the BMP earlier on the line (counted once)',
        line: 1,
        column: 16,
        text: `{ "note": "\u{1F600}", ${bareToken} }`,
      },
      { label: 'CRLF line endings', line: 3, column: 3, text: `{\r\n  "personas": [],\r\n  ${bareToken}\r\n}` },
      { label: 'a byte order mark', line: 1, column: 1, text: '\uFEFF{ "personas": [] }' },
    ])('malformed JSON: $label is reported at line $line, column $column, echoing nothing', ({ text, line, column }) => {
      const expected = (source: string) => `loadPersonaConfig: malformed JSON in "${source}" at line ${line}, column ${column}.`
      const path = join(dir, 'config.json')
      writeFileSync(path, text, 'utf-8')

      const errors = {
        default: thrown(() => parsePersonaConfigBytes(Buffer.from(text, 'utf-8'), recordPath(), dir, { home })),
        record: thrown(() => parsePersonaConfigBytes(Buffer.from(text, 'utf-8'), recordPath(), dir, { home, record: true })),
        loader: thrown(() => loadPersonaConfig(path, home)),
      }
      expect(errors.default.message).toBe(expected(recordPath()))
      expect(errors.record.message).toBe(expected(recordPath()))
      expect(errors.loader.message).toBe(expected(path))
      assertNoLeak(errors, 'errors')
    })
  })
})

// ===========================================================================
// resolveRealPathStrict (bug b.g57): the real path of a persona's
// claude_config_dir with no lexical fallback. A directory not created yet
// resolves through its nearest existing ancestor (E13 Director decision 1);
// anything else that fails is unresolvable. Real-file-system cases live in a
// mkdtempSync directory; injected cases pass both realpath and lstat, so they
// touch no file system at all.
// ===========================================================================

describe('resolveRealPathStrict (bug b.g57)', () => {
  let tmp: string
  /** The temp root's own real path: the temp root may itself sit behind a symlink. */
  let real: string

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'strict-real-path-'))
    real = realpathSync(tmp)
    mkdirSync(join(tmp, 'dir'))
    writeFileSync(join(tmp, 'dir', 'file.json'), PLACEHOLDER)
    symlinkSync(join(tmp, 'dir'), join(tmp, 'dir-link'))
    symlinkSync(join(tmp, 'absent'), join(tmp, 'dangling'))
    symlinkSync(join(tmp, 'loop'), join(tmp, 'loop'))
  })

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true })
  })

  /** `rel` appended to the temp root as text, so a trailing `/` survives. */
  const at = (rel: string) => `${tmp}/${rel}`
  /** The temp root's and `dir`'s entries; not recursive, since the symlink loop would never end. */
  const listing = () => [...readdirSync(tmp), ...readdirSync(join(tmp, 'dir')).map((name) => `dir/${name}`)].sort()
  /** An errno-style error, as the fs functions throw. */
  const errno = (code: string) => Object.assign(new Error(`simulated ${code}`), { code })

  test.each([
    ['an existing directory', 'dir', 'dir'],
    ['a symlink to a directory', 'dir-link', 'dir'],
    ['a directory not created yet', 'dir/new', 'dir/new'],
    ['a directory not created yet, several levels down, with a trailing slash', 'dir/new/deeper/', 'dir/new/deeper'],
    ['a directory not created yet under a symlinked parent', 'dir-link/new/deeper', 'dir/new/deeper'],
  ])('%s resolves to its real path, or the one it will have once created, and writes nothing', (_label, input, expected) => {
    const before = listing()
    expect(resolveRealPathStrict(at(input))).toEqual({ resolved: true, path: join(real, expected) })
    expect(listing()).toEqual(before)
  })

  test.each([
    { label: 'a symlink that points to nothing (an unmounted drive)', input: 'dangling', code: 'ENOENT', danglingSymlink: true },
    { label: 'a path under a symlink that points to nothing', input: 'dangling/sub', code: 'ENOENT', danglingSymlink: true },
    { label: 'a path under a regular file', input: 'dir/file.json/sub', code: 'ENOTDIR', danglingSymlink: false },
    { label: 'a symlink loop', input: 'loop', code: 'ELOOP', danglingSymlink: false },
  ] as const)('$label is unresolvable ($code), never its lexical form', ({ input, code, danglingSymlink }) => {
    const before = listing()
    expect(resolveRealPathStrict(at(input))).toEqual({ resolved: false, code, danglingSymlink })
    expect(listing()).toEqual(before)
  })

  test.each<{ label: string; thrown: unknown; code: string }>([
    { label: 'EIO (a dropped network mount)', thrown: errno('EIO'), code: 'EIO' },
    { label: 'ESTALE', thrown: errno('ESTALE'), code: 'ESTALE' },
    { label: 'EACCES', thrown: errno('EACCES'), code: 'EACCES' },
    { label: 'an error with no code', thrown: new Error('simulated failure'), code: 'unknown' },
    { label: 'a thrown string', thrown: 'simulated failure', code: 'unknown' },
    { label: 'an error whose code is not an errno code', thrown: Object.assign(new Error('simulated'), { code: fakeToken(BOT_TOKEN_PREFIX) }), code: 'unknown' },
  ])('realpath failing with $label is unresolvable ($code), with no walk up and no lstat', ({ thrown, code }) => {
    const realpaths: string[] = []
    const lstats: string[] = []
    const result = resolveRealPathStrict('/drive/claude', {
      realpath: (path) => {
        realpaths.push(path)
        throw thrown
      },
      lstat: (path) => {
        lstats.push(path)
        return { isSymbolicLink: () => false }
      },
    })
    expect(result).toEqual({ resolved: false, code, danglingSymlink: false })
    expect(realpaths).toEqual(['/drive/claude'])
    expect(lstats).toEqual([])
    assertNoLeak(result, 'result')
  })

  test('a missing directory whose ancestor resolves: that ancestor\'s real path plus the missing components, the first of them lstat\'ed', () => {
    const realpaths: string[] = []
    const lstats: string[] = []
    const result = resolveRealPathStrict('/base/a/b/c', {
      realpath: (path) => {
        realpaths.push(path)
        if (path === '/base/a') return '/mounted/a'
        throw errno('ENOENT')
      },
      lstat: (path) => {
        lstats.push(path)
        throw errno('ENOENT')
      },
    })
    expect(result).toEqual({ resolved: true, path: '/mounted/a/b/c' })
    expect(realpaths).toEqual(['/base/a/b/c', '/base/a/b', '/base/a'])
    expect(lstats).toEqual(['/mounted/a/b'])
  })

  test.each<[string, (path: string) => { isSymbolicLink(): boolean }, { code: string; danglingSymlink: boolean }]>([
    ['it is a symlink (pointing to nothing)', () => ({ isSymbolicLink: () => true }), { code: 'ENOENT', danglingSymlink: true }],
    ['it exists and is not a symlink (created meanwhile)', () => ({ isSymbolicLink: () => false }), { code: 'ENOENT', danglingSymlink: false }],
    ['lstat fails with EACCES', () => { throw errno('EACCES') }, { code: 'EACCES', danglingSymlink: false }],
    ['lstat fails with EIO', () => { throw errno('EIO') }, { code: 'EIO', danglingSymlink: false }],
  ])('a missing directory whose ancestor resolves, when its first missing component is checked and %s: unresolvable', (_label, lstat, expected) => {
    const result = resolveRealPathStrict('/base/a/b', {
      realpath: (path) => {
        if (path === '/base') return '/base'
        throw errno('ENOENT')
      },
      lstat,
    })
    expect(result).toEqual({ resolved: false, ...expected })
  })

  test.each<{ label: string; realpath: (path: string) => string; code: string }>([
    { label: 'no ancestor resolves, up to the root', realpath: () => { throw errno('ENOENT') }, code: 'ENOENT' },
    { label: 'an ancestor fails with EIO on the way up', realpath: (path) => { throw errno(path === '/base/a/b' ? 'ENOENT' : 'EIO') }, code: 'EIO' },
  ])('$label: unresolvable ($code), with no lstat', ({ realpath, code }) => {
    const lstats: string[] = []
    const result = resolveRealPathStrict('/base/a/b', {
      realpath,
      lstat: (path) => {
        lstats.push(path)
        return { isSymbolicLink: () => false }
      },
    })
    expect(result).toEqual({ resolved: false, code, danglingSymlink: false })
    expect(lstats).toEqual([])
  })
})
