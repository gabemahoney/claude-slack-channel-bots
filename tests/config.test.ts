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
} from 'fs'
import { spawnSync } from 'child_process'
import { tmpdir } from 'os'
import { join, relative, resolve } from 'path'
import { homedir } from 'os'
import {
  expandTilde,
  loadPersonaConfig,
  prePersonaConversionMessage,
  resolvePersonaConfig,
  resolveRealPath,
  credentialsFilesToProtect,
  configFileReadFailureMessage,
  CONFIG_NOT_REGULAR_FILE_CODE,
  DEFAULT_PERSONA_CONFIG_FS,
  describeUnknownKeys,
  isMissingConfigCode,
  parsePersonaConfigBytes,
  PersonaConfigReadError,
  readPersonaConfigBytes,
  referencedCredentialsPaths,
  resolveServerConfigPath,
  resolveServerStateDir,
  type PersonaConfigFs,
  type PersonaConfigInput,
  type PersonaInput,
} from '../src/config.ts'
import { personaKey } from '../src/persona-identity.ts'
import {
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
  writeCredentialsFile,
} from './test-helpers/credentials.ts'

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
   */
  function loadError(input: unknown): string {
    let error: Error | undefined
    try {
      load(input)
    } catch (err) {
      error = err as Error
    }
    if (error === undefined) throw new Error('expected loadPersonaConfig to reject the configuration')
    assertNoLeak(error, 'rejection')
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
      // A fixed value: makePersonaConfig takes the default from the same constant.
      expect(config.agent_director_poll_interval_ms).toBe(1000)
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

    // The token-like keys hold sentinel-bearing fake tokens: loadError's
    // assertNoLeak proves the error names the key but never echoes the value.
    test.each([
      ['top-level', { ...makePersonaConfigInput(), extra_setting: 1 }, 'extra_setting', false],
      ['persona entry', persona({ nickname: 'ops' }), 'nickname', true],
      ['persona entry bot_token', persona({ bot_token: fakeToken(BOT_TOKEN_PREFIX, 'entry') }), 'bot_token', true],
      ['persona entry app_token', persona({ app_token: fakeToken(APP_TOKEN_PREFIX, 'entry') }), 'app_token', true],
      ['persona entry route-era cwd (SR-10.2)', persona({ cwd: '/tmp/somewhere' }), 'cwd', true],
      ['dm object', persona({ dm: { enabled: false, relay: true } }), 'relay', true],
      ['channel entry', persona({ channels: [{ id: 'C0TEST001', delivery: 'all', label: 'ops' }] }), 'label', true],
    ])('an unknown key in the %s is rejected, naming it', (_label, input, key, inPersona) => {
      const message = loadError(input)
      expect(message).toContain(JSON.stringify(key))
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
      ['top-level', name => ({ ...makePersonaConfigInput(), [name]: 1 }), 'unknown top-level field(s) in config.json: '],
      ['persona entry', name => persona({ [name]: 1 }), 'unknown field(s) in the persona entry: '],
      ['dm object', name => persona({ dm: { enabled: false, [name]: true } }), 'unknown field(s) in dm: '],
      ['channel entry', name => persona({ channels: [{ id: 'C0TEST001', delivery: 'all', [name]: 'x' }] }), 'unknown field(s) in channels[0]: '],
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
        message_archive_db: '~/archive.db',
        claude_config_dir: '~/cfg',
        resume_enabled: false,
        agent_director_poll_interval_ms: 250,
        stop_hook_bootstrap: false,
        cron_table_path: '~/cron/crontab',
        cron_log_path: '~/cron/cron.log',
        cron_log_max_bytes: 1024,
        ack_reaction: 'eyes',
        reply_chunk_limit: 12000,
        reply_chunk_mode: 'length',
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
})

// ---------------------------------------------------------------------------
// Stat-first read seam helpers (readPersonaConfigBytes' PersonaConfigFs)
// ---------------------------------------------------------------------------

/** A `PersonaConfigFs` op the reader made, with the descriptor it used (none for `open`). */
type ConfigFdCall = { op: 'open' | 'fstat' | 'read' | 'close'; fd?: number }

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
    readFileFd: (fd) => {
      calls.push({ op: 'read', fd })
      return (overrides.readFileFd ?? DEFAULT_PERSONA_CONFIG_FS.readFileFd)(fd)
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

const hasMkfifo = spawnSync('mkfifo', ['--version']).status === 0

/**
 * Run `body` in a child `bun` with `config` bound to src/config.ts, bounded at
 * 10 s: a blocking open or read of a FIFO with no writer never returns, so
 * in-process it would hang the whole suite instead of failing the test.
 * `body` prints one JSON line; returns the child and that line parsed.
 * The child gets a built env (b.av2 SR-13.2): PATH, the test's temp `home` as
 * HOME and a state dir under it, so nothing in it falls back to the real home.
 */
function runConfigChild(body: string, home: string) {
  const modulePath = join(import.meta.dir, '..', 'src', 'config.ts')
  const script = `const config = await import(${JSON.stringify(modulePath)})\n${body}`
  const child = spawnSync(process.execPath, ['-e', script], {
    timeout: 10_000,
    encoding: 'utf-8',
    env: { PATH: process.env['PATH'], HOME: home, SLACK_STATE_DIR: join(home, 'state') },
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
    readFileFd: (fd) => (ops.push('read'), d.readFileFd(fd)),
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
    expect(() => loadPersonaConfig(path, home)).toThrow()
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

  test.skipIf(!hasMkfifo)('a real FIFO config.json with no writer: returns the applied paths at once, never read, descriptor closed (child process, 10 s bound; skipped where mkfifo is unavailable)', () => {
    const path = join(dir, 'config.json')
    expect(spawnSync('mkfifo', [path]).status).toBe(0)
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

    test.skipIf(!hasMkfifo)('a real FIFO with no writer: the open does not wait, it is refused unread and closed, and the path loader fails the same way (child process, 10 s bound; skipped where mkfifo is unavailable)', () => {
      const path = join(dir, 'config.json')
      expect(spawnSync('mkfifo', [path]).status).toBe(0)

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
