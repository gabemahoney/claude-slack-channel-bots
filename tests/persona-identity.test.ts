/**
 * persona-identity.test.ts — persona key rule and derived identifiers.
 *
 * Covers b.av2 SR-2.1 (key rule and fit constraints), SR-2.2 (instance ID,
 * tmux name, labels, spawn env), the effective config-dir set (SR-6.2, SR-8.6
 * step 5), SR-9.1/SR-9.3 (persona target resolution),
 * SR-10.3 (persona-reference rendering) and SR-13.1 (no import side effects),
 * plus the test helper's token matcher (`TOKEN_LIKE` / `isTokenLike`), which
 * `assertNoLeak` applies.
 *
 * Expected keys are literals computed independently from the spec (SHA-256
 * of the UTF-8 name, outside this code base), never by calling personaKey:
 * keys become persisted agent-director identifiers, so an algorithm change
 * must fail here.
 *
 * Isolation (b.av2 SR-13.2): every home and config dir is a mkdtempSync path,
 * removed in afterEach. Nothing touches the real home directory.
 *
 * SPDX-License-Identifier: MIT
 */

import { afterEach, describe, expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, readdirSync, rmSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import {
  PERSONA_KEY_MAX_LENGTH,
  configDirLabelValue,
  effectiveClaudeConfigDirs,
  personaInstanceId,
  personaKey,
  personaLabels,
  personaSpawnEnv,
  personaTmuxSessionName,
  renderPersonaRef,
  resolveClaudeConfigDir,
  resolvePersonaTarget,
} from '../src/persona-identity.ts'
import { encodePermissionActionId, parsePermissionActionId } from '../src/permission-action-id.ts'
import { APP_TOKEN_PREFIX, BOT_TOKEN_PREFIX, fakeToken, isTokenLike } from './test-helpers/credentials.ts'

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const tempDirs: string[] = []

function makeTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'persona-identity-test-'))
  tempDirs.push(dir)
  return dir
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

/** Independent expectation for a config_dir label value. */
function expectedDirHash(absPath: string): string {
  return createHash('sha256').update(absPath, 'utf8').digest('hex').slice(0, 12)
}

/** Exactly 40 in-form characters: the longest name that is its own key. */
const FORTY_IN_FORM = 'release_coordinator_for_platform_team_01'

// ---------------------------------------------------------------------------
// Key rule (b.av2 SR-2.1)
// ---------------------------------------------------------------------------

describe('personaKey', () => {
  test.each(['a', 'ops_bot', '_ops_', 'bot9', FORTY_IN_FORM])('in-form name %p is its own key', (name) => {
    expect(personaKey(name)).toBe(name)
  })

  // [name, expected key]; expected values computed from the spec, outside this code base.
  test.each([
    ['OpsBot', 'opsbot_589a9456'],
    ['Ops Bot', 'ops_bot_5e2526f3'],
    ['ops - bot!!', 'ops_bot_f3b981b2'],
    ['  --Ops Bot--  ', 'ops_bot_1d9dc977'],
    ['a'.repeat(41), 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa_c0f8bd4d'],
    ['Release Coordinator For The Platform Team', 'release_coordinator_for_the_platform_tea_14d20503'],
    ['The Quick Brown Fox Jumps Over The Lazy Dog Again', 'the_quick_brown_fox_jumps_over_the_lazy__0d9e3fff'],
    ['Café Bot', 'caf_bot_ac93e21d'],
    ['!!!', 'e84c538e'],
    ['日本語', '77710aed'],
    ['🤖', 'b0d12518'],
  ])('normalises %p to %p', (name, expected) => {
    expect(personaKey(name)).toBe(expected)
  })

  test('the empty name yields the bare 8-hex suffix without throwing', () => {
    expect(personaKey('')).toBe('e3b0c442')
  })

  test('names sharing a normalised stem differ only in the 8-hex suffix; same name, same key', () => {
    const keys = ['Ops Bot', 'ops bot', 'OPS-BOT'].map(personaKey)
    expect(keys).toEqual(['ops_bot_5e2526f3', 'ops_bot_b8921f56', 'ops_bot_40bfde32'])
    expect(personaKey('Ops Bot')).toBe(keys[0])
  })

  test.each(['a,b', 'x\ty', 'x\ny', '🤖 bot', 'a b', '100%'])(
    'a name with crontable-breaking characters (%p) yields a key matching ^[a-z0-9_]+$',
    (name) => {
      expect(personaKey(name)).toMatch(/^[a-z0-9_]+$/)
    },
  )
})

// ---------------------------------------------------------------------------
// Fit constraints (b.av2 SR-2.1)
// ---------------------------------------------------------------------------

describe('fit constraints', () => {
  const longestKey = personaKey('Z'.repeat(200))
  const requestToken = 'deadbeef-cafe-4bad-9bad-feedfacef00d'

  test('the longest key is 49 characters and its tmux name fits in 64 bytes', () => {
    expect(longestKey.length).toBe(49)
    expect(PERSONA_KEY_MAX_LENGTH).toBe(49)
    expect(Buffer.byteLength(personaTmuxSessionName(longestKey), 'utf8')).toBeLessThanOrEqual(64)
  })

  test.each([
    longestKey,
    'the_quick_brown_fox_jumps_over_the_lazy__0d9e3fff',
    'e84c538e',
  ])('cscb_%s round-trips through the permission action-id encoder within 255 chars', (key) => {
    const instanceId = personaInstanceId(key)
    const actionId = encodePermissionActionId('allow', instanceId, requestToken)
    expect(actionId.length).toBeLessThanOrEqual(255)
    expect(parsePermissionActionId(actionId)).toEqual({
      decision: 'allow',
      claudeInstanceId: instanceId,
      requestToken,
    })
  })
})

// ---------------------------------------------------------------------------
// Derived identifiers (b.av2 SR-2.2)
// ---------------------------------------------------------------------------

describe('derived identifiers', () => {
  test('instance ID is cscb_<key> and tmux name is slack_bot_<key>', () => {
    expect(personaInstanceId('ops_bot_5e2526f3')).toBe('cscb_ops_bot_5e2526f3')
    expect(personaTmuxSessionName('ops_bot_5e2526f3')).toBe('slack_bot_ops_bot_5e2526f3')
  })

  test('labels are service, persona and a 12-hex config_dir hash of the resolved dir', () => {
    const home = makeTempDir()
    const dir = join(home, 'cfg')
    expect(personaLabels('ops_bot', dir, home)).toEqual([
      'service=cscb',
      'persona=ops_bot',
      `config_dir=${expectedDirHash(dir)}`,
    ])
  })

  test.each([
    ['absent', undefined],
    ['empty', ''],
    ['~/.claude', '~/.claude'],
  ])('unconfigured and explicit default dirs share a label (%s)', (_label, configDir) => {
    const home = makeTempDir()
    expect(resolveClaudeConfigDir(configDir, home)).toBe(join(home, '.claude'))
    expect(configDirLabelValue(configDir, home)).toBe(expectedDirHash(join(home, '.claude')))
  })

  test.each([
    ['trailing slash', (home: string) => join(home, 'x') + '/'],
    ['~/x', () => '~/x'],
    ['dot segments', (home: string) => join(home, 'y', '..', 'x')],
  ])('two spellings of the same dir give the same label (%s)', (_label, spell) => {
    const home = makeTempDir()
    expect(configDirLabelValue(spell(home), home)).toBe(configDirLabelValue(join(home, 'x'), home))
  })

  test('bare ~ resolves to the injected home', () => {
    const home = makeTempDir()
    expect(resolveClaudeConfigDir('~', home)).toBe(resolve(home))
  })

  test('different dirs give different labels', () => {
    const home = makeTempDir()
    expect(configDirLabelValue(join(home, 'a'), home)).not.toBe(configDirLabelValue(join(home, 'b'), home))
  })
})

// ---------------------------------------------------------------------------
// Effective config-dir set (b.av2 SR-6.2, SR-8.6 step 5)
// ---------------------------------------------------------------------------

describe('effectiveClaudeConfigDirs', () => {
  test('an empty persona set yields the default dir alone', () => {
    const home = makeTempDir()
    expect(effectiveClaudeConfigDirs([], home)).toEqual([join(home, '.claude')])
  })

  test('a persona with no dir, an empty dir, ~/.claude and an explicit <home>/.claude are one default entry', () => {
    const home = makeTempDir()
    const personas = [
      {},
      { claude_config_dir: '' },
      { claude_config_dir: '~/.claude' },
      { claude_config_dir: join(home, '.claude') },
      { claude_config_dir: join(home, '.claude') + '/' },
    ]
    expect(effectiveClaudeConfigDirs(personas, home)).toEqual([join(home, '.claude')])
  })

  test('distinct dirs are de-duplicated after lexical resolution and sorted', () => {
    const home = makeTempDir()
    const personas = [
      { claude_config_dir: join(home, 'zeta') },
      { claude_config_dir: '~/alpha' },
      {},
      { claude_config_dir: join(home, 'x', '..', 'alpha') },
      { claude_config_dir: join(home, 'zeta') },
    ]
    expect(effectiveClaudeConfigDirs(personas, home)).toEqual([
      join(home, '.claude'),
      join(home, 'alpha'),
      join(home, 'zeta'),
    ])
  })

  test('no symlink is followed: a link to a dir is its own entry beside the dir', () => {
    const home = makeTempDir()
    const target = join(home, 'real-claude')
    const link = join(home, 'link-claude')
    mkdirSync(target)
    symlinkSync(target, link)
    expect(effectiveClaudeConfigDirs([{ claude_config_dir: link }, { claude_config_dir: target }], home)).toEqual([
      link,
      target,
    ])
  })
})

// ---------------------------------------------------------------------------
// Spawn environment (b.av2 SR-2.2)
// ---------------------------------------------------------------------------

describe('personaSpawnEnv', () => {
  test('carries key, crontable path and the configured config dir', () => {
    const home = makeTempDir()
    const env = personaSpawnEnv({
      key: 'ops_bot',
      crontablePath: join(home, 'crontab'),
      claudeConfigDir: join(home, 'alt'),
    })
    expect(env).toEqual({
      CSCB_PERSONA: 'ops_bot',
      CLAUDE_MANAGED_CHANNEL: 'ops_bot',
      CSCB_CRONTABLE_PATH: join(home, 'crontab'),
      CLAUDE_CONFIG_DIR: join(home, 'alt'),
    })
  })

  test.each([undefined, ''])('omits CLAUDE_CONFIG_DIR entirely when unconfigured (%p)', (claudeConfigDir) => {
    const home = makeTempDir()
    const env = personaSpawnEnv({ key: 'ops_bot', crontablePath: join(home, 'crontab'), claudeConfigDir })
    expect(Object.keys(env).sort()).toEqual(['CLAUDE_MANAGED_CHANNEL', 'CSCB_CRONTABLE_PATH', 'CSCB_PERSONA'])
  })
})

// ---------------------------------------------------------------------------
// Rendering (b.av2 SR-10.3)
// ---------------------------------------------------------------------------

describe('renderPersonaRef', () => {
  test('shows the JSON-quoted name with its key', () => {
    expect(renderPersonaRef('Ops Bot')).toBe('"Ops Bot" (key=ops_bot_5e2526f3)')
  })

  test('escapes quotes, backslashes and newlines onto one line', () => {
    expect(renderPersonaRef('Say "hi"\\\nnow', 'k1')).toBe('"Say \\"hi\\"\\\\\\nnow" (key=k1)')
  })
})

// ---------------------------------------------------------------------------
// The test helper's token matcher (tests/test-helpers/credentials.ts)
//
// Persona names have no format rule (b.av2 SR-1.2), so the source has no
// token matcher. `TOKEN_LIKE` / `isTokenLike` still define what
// `assertNoLeak` flags and what the secrecy audit's no-token-literal scan
// looks for, so their boundary and after-dash rules are pinned here.
// ---------------------------------------------------------------------------

describe('TOKEN_LIKE / isTokenLike (the rule assertNoLeak applies)', () => {
  /** `xox`, cut from the bot prefix so the file holds no token-like literal. */
  const XOX = BOT_TOKEN_PREFIX.slice(0, 3)

  // Every token-shaped row is built at runtime, so the file holds no token
  // literal. A match needs a boundary before the prefix (the start of the text
  // or anything but an ASCII letter or digit) and a letter or digit after the
  // dash; the match is case-sensitive.
  const ROWS: [string, string, boolean][] = [
    ['an xoxb- token (fakeToken: a digit after the dash)', fakeToken(BOT_TOKEN_PREFIX), true],
    ['an xapp- token', fakeToken(APP_TOKEN_PREFIX), true],
    ['an xoxp- token', fakeToken('xoxp-'), true],
    ['an xoxe- token', fakeToken('xoxe-'), true],
    ['a token inside a longer text', `Ops ${fakeToken('xoxp-')} bot`, true],
    ['a token after a colon', `bot:${fakeToken(BOT_TOKEN_PREFIX)}`, true],
    ['a token in parentheses', `(${fakeToken(APP_TOKEN_PREFIX)})`, true],
    ['a token after an underscore', `a_${fakeToken(BOT_TOKEN_PREFIX)}`, true],
    ['a token after a dash', `a-${fakeToken(BOT_TOKEN_PREFIX)}`, true],
    ['a token after a non-ASCII letter', `é${fakeToken(BOT_TOKEN_PREFIX)}`, true],
    ['a prefix followed by a letter', `${BOT_TOKEN_PREFIX}abc`, true],
    ['an xapp- prefix followed by a letter', `${APP_TOKEN_PREFIX}bot`, true],
    ['a bare prefix', BOT_TOKEN_PREFIX, false],
    ['the bare prefix in rule text', `must start with ${APP_TOKEN_PREFIX}`, false],
    ['a prefix followed by a space', `${BOT_TOKEN_PREFIX} x`, false],
    ['a prefix followed by an underscore', `${BOT_TOKEN_PREFIX}_x`, false],
    ['a prefix with no dash', `${BOT_TOKEN_PREFIX.slice(0, -1)}abc`, false],
    ['a word such as "Xoxo bot"', 'Xoxo bot', false],
    ['inboxapp-bot (a prefix glued after a letter)', 'inboxapp-bot', false],
    ['a token glued after a letter', `bot${fakeToken(BOT_TOKEN_PREFIX)}`, false],
    ['a token glued after a digit', `7${fakeToken(APP_TOKEN_PREFIX)}`, false],
    ['an upper-case xoxb- prefix', fakeToken(BOT_TOKEN_PREFIX.toUpperCase()), false],
    ['xox and a digit', `${XOX}1-1abc`, false],
    ['xox and two letters', `${XOX}bb-1abc`, false],
    ['an ordinary name', 'Ops Bot', false],
  ]

  test.each(ROWS)('%s', (_label, text, expected) => {
    expect(isTokenLike(text)).toBe(expected)
  })
})

// ---------------------------------------------------------------------------
// Target resolution (b.av2 SR-9.1, SR-9.3)
// ---------------------------------------------------------------------------

describe('resolvePersonaTarget', () => {
  // Ops Bot's key is its hashed form (see renderPersonaRef above), so its name
  // and key differ; Build Bot comes second so a match is not just personas[0].
  const OPS = { name: 'Ops Bot', key: 'ops_bot_5e2526f3' }
  const BUILD = { name: 'Build Bot', key: 'build_bot_0a1b2c3d' }
  const CONFIG = { personas: [OPS, BUILD] }

  test.each([
    ['Ops Bot by name', 'Ops Bot', OPS],
    ['Ops Bot by key', 'ops_bot_5e2526f3', OPS],
    ['Build Bot by name', 'Build Bot', BUILD],
    ['Build Bot by key', 'build_bot_0a1b2c3d', BUILD],
  ])('%s returns that persona', (_label, target, expected) => {
    expect(resolvePersonaTarget(CONFIG, target)).toBe(expected)
  })

  test.each([
    ['an unknown target', CONFIG, 'Nobody'],
    ['a name in a different case', CONFIG, 'ops bot'],
    ['a key in a different case', CONFIG, 'OPS_BOT_5E2526F3'],
    ['a name with a trailing space', CONFIG, 'Ops Bot '],
    ['a key with a trailing space', CONFIG, 'ops_bot_5e2526f3 '],
    ['an empty target', CONFIG, ''],
    ['a null config', null, 'Ops Bot'],
    ['an undefined config', undefined, 'Ops Bot'],
  ])('%s returns undefined', (_label, config, target) => {
    expect(resolvePersonaTarget(config, target)).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// No import side effects (b.av2 SR-13.1)
// ---------------------------------------------------------------------------

describe('module import', () => {
  test('importing in a child with a fresh HOME exits 0, prints nothing and leaves HOME empty', () => {
    const home = makeTempDir()
    const modulePath = resolve(import.meta.dir, '../src/persona-identity.ts')
    const result = Bun.spawnSync(['bun', '-e', `await import(${JSON.stringify(modulePath)})`], {
      cwd: home,
      env: {
        ...process.env,
        HOME: home,
        SLACK_STATE_DIR: join(home, 'state'),
        // Bun's own runtime transpiler cache would otherwise land in $HOME/.bun.
        BUN_RUNTIME_TRANSPILER_CACHE_PATH: '0',
      },
    })
    expect(result.exitCode).toBe(0)
    expect(result.stdout.toString()).toBe('')
    expect(result.stderr.toString()).toBe('')
    expect(readdirSync(home)).toEqual([])
  })
})
