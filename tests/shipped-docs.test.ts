/**
 * shipped-docs.test.ts — the shipped-description audit (b.av2 SR-13.5): what
 * the package ships to the operator and to bot instances describes personas
 * and nothing else. It backs the SR-14 `shipped-docs` rows for AC 39, AC 46
 * and AC 74.
 *
 * Covers:
 * - the Slack app manifest (AC 39, SR-4.3, SR-12): `im:write` and the pinned
 *   scopes and events, and its comments;
 * - the README's modify-semantics table (SR-12, SR-8.6), held against the
 *   change plan's exported classes in src/reload-plan.ts;
 * - the README persona reference (SR-12): its key tables list exactly the
 *   loader's keys and its complete example loads through the real loader;
 * - the README's pointers to the setup wizard;
 * - the shipped-text audit (AC 46) over `SHIPPED_TEXTS` (the README, every
 *   file under `skills/`, the whole manifest, the setup wizard's packaged
 *   credentials script, the MCP instructions read
 *   through `MCP_INSTRUCTIONS` exported by src/registry.ts, the Slack Reply
 *   Guard's reminder text and the crontable template header): no
 *   first-@mention claim (SR-12), and no term of `FORBIDDEN_TERMS` (the
 *   pre-persona shape, the token environment variables and command-line
 *   tokens, the access-control file, the retired name-rule wording). The one
 *   exemption is the debugging skill's SR-1.7 entry (`AUDIT_EXCEPTIONS`);
 * - the README's receiving section (SR-12, SR-4.4): its table's row for each
 *   `via` value shows that value, and both injected kinds' rows show none;
 * - the MCP instructions carry no reload wording (AC 74, SR-8.8).
 * CHANGELOG.md and docs/ are not shipped descriptions and are not read.
 *
 * Reads repo files resolved from this file's location, so the working
 * directory doesn't matter. The one writer is the complete-example load: it
 * writes the example into its own `mkdtempSync` directory, removed after each
 * test, and passes that directory's `home` to the loader, which reads no
 * credentials file. No real HOME, no server, no CLI (SR-13.2).
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join, resolve } from 'path'

import {
  CHANNEL_ENTRY_KEYS,
  DELIVERY_MODES,
  DM_DESTINATION,
  PERSONA_DM_KEYS,
  PERSONA_ENTRY_KEYS,
  PERSONA_TOP_LEVEL_KEYS,
  SERVER_PATH_SETTINGS,
  loadPersonaConfig,
  type PersonaConfig,
} from '../src/config.ts'
import { assertNoLeak } from './test-helpers/credentials.ts'
import {
  findSection,
  flat,
  headingAnchors,
  headings,
  headingSlug,
  requiredSection,
  sectionRange,
  splitFences,
} from './test-helpers/markdown.ts'
import { RELOAD_TERMS } from './test-helpers/reload-terms.ts'
import { CRONTABLE_TEMPLATE_HEADER } from '../src/cron-bootstrap.ts'
import type { Via } from '../src/delivery-decision.ts'
import { MCP_INSTRUCTIONS } from '../src/registry.ts'
import {
  DESTRUCTIVE_PREFIX,
  DESTRUCTIVE_SETTINGS,
  IN_PLACE_SETTINGS,
  NEXT_LAUNCH_SETTINGS,
  type NextLaunchSetting,
  type ValidChangePlan,
} from '../src/reload-plan.ts'

const REPO_ROOT = resolve(import.meta.dir, '..')

function readRepoFile(relPath: string): string {
  return readFileSync(resolve(REPO_ROOT, relPath), 'utf-8')
}

/** A quote may open a YAML scalar only at its start: line start or after `:`, `-`, `[`, `{`, `,`. */
function opensQuotedScalar(before: string): boolean {
  const prev = before.trimEnd()
  return prev === '' || /[:\-[{,]$/.test(prev)
}

/**
 * The text of every YAML comment (full-line `#` comments and inline ` # …`
 * tails), joined with spaces so a phrase wrapped across comment lines still
 * matches a `\s+`-separated pattern.
 *
 * A `#` inside a quoted scalar (which may span lines) or inside a block scalar
 * (`|` / `>`) body is value text, not a comment, and is skipped.
 */
function yamlComments(text: string): string {
  const comments: string[] = []
  let quote: '"' | "'" | null = null
  let blockParentIndent: number | null = null
  for (const line of text.split('\n')) {
    const indent = line.length - line.trimStart().length
    if (blockParentIndent !== null) {
      if (line.trim() === '' || indent > blockParentIndent) continue
      blockParentIndent = null
    }
    let content = line
    for (let i = 0; i < line.length; i++) {
      const ch = line[i]
      if (quote === '"') {
        if (ch === '\\') i++
        else if (ch === '"') quote = null
      } else if (quote === "'") {
        if (ch === "'" && line[i + 1] === "'") i++
        else if (ch === "'") quote = null
      } else if (ch === '#' && (i === 0 || /\s/.test(line[i - 1]))) {
        comments.push(line.slice(i + 1))
        content = line.slice(0, i)
        break
      } else if ((ch === '"' || ch === "'") && opensQuotedScalar(line.slice(0, i))) {
        quote = ch
      }
    }
    if (quote === null && /(?:^|[:-])\s*[|>][-+1-9]*\s*$/.test(content)) {
      blockParentIndent = indent
    }
  }
  return comments.join(' ')
}

describe('slack-app-manifest.yml', () => {
  const text = readRepoFile('slack-app-manifest.yml')
  const manifest = Bun.YAML.parse(text) as {
    features: { app_home: Record<string, unknown> }
    oauth_config: { scopes: { bot: string[] } }
    settings: { event_subscriptions: { bot_events: string[] } }
  }
  const comments = yamlComments(text)

  test('AC 39: the bot scopes include im:write', () => {
    expect(manifest.oauth_config.scopes.bot).toContain('im:write')
  })

  test('SR-4.3: message.im stays subscribed and message.mpim is not (group DMs unsubscribed)', () => {
    const events = manifest.settings.event_subscriptions.bot_events
    expect(events).toContain('message.im')
    expect(events).not.toContain('message.mpim')
  })

  test('the bot scopes are exactly the pinned list (none dropped, none added)', () => {
    expect([...manifest.oauth_config.scopes.bot].sort()).toEqual(
      [
        'app_mentions:read',
        'channels:history',
        'chat:write',
        'files:read',
        'files:write',
        'groups:history',
        'im:history',
        'im:write',
        'reactions:write',
        'users:read',
      ].sort(),
    )
  })

  test('the bot events are exactly the pinned list (none dropped, none added)', () => {
    expect([...manifest.settings.event_subscriptions.bot_events].sort()).toEqual(
      ['app_mention', 'message.channels', 'message.groups', 'message.im'].sort(),
    )
  })

  test('the Messages tab is on and writable, so a user can DM the persona', () => {
    expect(manifest.features.app_home.messages_tab_enabled).toBe(true)
    expect(manifest.features.app_home.messages_tab_read_only_enabled).toBe(false)
  })

  test.each([
    ['SLACK_APP_TOKEN', /SLACK_APP_TOKEN/],
    ['SLACK_BOT_TOKEN', /SLACK_BOT_TOKEN/],
    ['an environment variable', /environment\s+variable|\benv\s+var/i],
  ])('SR-12: no comment names %s', (_label, pattern) => {
    expect(comments).not.toMatch(pattern)
  })

  test.each([
    ['one app per persona', /one\s+app\s+per\s+persona/i],
    ['the credentials_file setting', /\bcredentials_file\b/],
    ['the bot_token key', /\bbot_token\b/],
    ['the app_token key', /\bapp_token\b/],
    ['im:write', /\bim:write\b/],
    ['re-installing existing apps', /\bre-?install/i],
  ])('SR-12: the comments name %s', (_label, pattern) => {
    expect(comments).toMatch(pattern)
  })
})

/** `findSection`, with '' when the heading is absent. */
function markdownSection(text: string, heading: string): string {
  return findSection(text, heading) ?? ''
}

/** The cells of one Markdown table row, trimmed; `\|` stays in its cell. */
function tableCells(line: string): string[] {
  return line
    .trim()
    .replace(/^\|/, '')
    .replace(/\|$/, '')
    .split(/(?<!\\)\|/)
    .map((cell) => cell.trim())
}

/** The first pipe table in `section`: its header cells and body rows (the `|---|` line skipped). */
function firstTable(section: string): { header: string[]; rows: string[][] } {
  const lines = section.split('\n')
  const first = lines.findIndex((line) => line.trimStart().startsWith('|'))
  if (first < 0) return { header: [], rows: [] }
  const block: string[] = []
  for (const line of lines.slice(first)) {
    if (!line.trimStart().startsWith('|')) break
    block.push(line)
  }
  const [header, , ...rows] = block.map(tableCells)
  return { header, rows }
}

/** The backtick code spans in a cell, without the backticks. */
function codeSpans(cell: string): string[] {
  return [...cell.matchAll(/`([^`]+)`/g)].map((m) => m[1])
}

/** The README's persona configuration reference heading and its complete-example heading, DOC-1's interface. */
const PERSONAS_HEADING = '### Personas (config.json)'
const EXAMPLE_HEADING = '#### Example'

/** Where a section nested in the persona reference comes from, for `requiredSection` failures. */
const IN_PERSONAS = `README.md, under "${PERSONAS_HEADING}",`

/** The README's persona configuration reference, throwing when its heading is missing. */
function personasSection(readme: string): string {
  return requiredSection(readme, PERSONAS_HEADING, 'README.md')
}

/**
 * The complete example's text: the one fenced block, tagged `json`, directly
 * under `#### Example` inside `### Personas (config.json)`. Throws naming what
 * is missing, and on any other count or tag, so the load case never passes
 * vacuously or on some other JSON block.
 */
function completeExample(readme: string): string {
  const example = requiredSection(personasSection(readme), EXAMPLE_HEADING, IN_PERSONAS)
  const { blocks } = splitFences(example)
  if (blocks.length !== 1 || blocks[0].info !== 'json') {
    const found = blocks.map((b) => `\`\`\`${b.info}`).join(', ') || 'none'
    throw new Error(`"${EXAMPLE_HEADING}" must hold exactly one fenced json block; found: ${found}`)
  }
  return blocks[0].body
}

/** The three server-wide settings moved into config.json by the persona format (b.av2 SR-1.6; not exported). */
const MOVED_SERVER_SETTINGS = ['ack_reaction', 'reply_chunk_limit', 'reply_chunk_mode']

/**
 * The reference's key tables: each `####` heading under `### Personas
 * (config.json)` with the keys its table must list, one code span per row in
 * the first column, built from the loader's exported key sets: the b.av2
 * SR-1.2 persona-entry keys (the `dm` sub-keys written `dm.<key>`), the SR-1.3
 * channel-entry keys, and the SR-1.1 / SR-1.6 top-level keys but `personas`.
 */
const KEY_TABLES: [heading: string, keys: readonly string[]][] = [
  ['Persona fields', PERSONA_ENTRY_KEYS.flatMap((key) => (key === 'dm' ? PERSONA_DM_KEYS.map((sub) => `dm.${sub}`) : [key]))],
  ['Channel entries', CHANNEL_ENTRY_KEYS],
  ['Server-wide settings', PERSONA_TOP_LEVEL_KEYS.filter((key) => key !== 'personas')],
]

/** The setup wizard: its skill name, its skill file and the heading of its credentials command. */
const WIZARD_NAME = 'setup-slack-channel-bots'
const WIZARD_FILE = `skills/${WIZARD_NAME}/SKILL.md`
const WIZARD_CREDENTIALS_HEADING = 'Credentials command'
/** The script the wizard's credentials command runs (`claude-slack-channel-bots credentials`), shipped in the package. */
const CREDENTIALS_SCRIPT = 'scripts/write-credentials.sh'

/** The inline links in `text`: each target split into its path ('' for a same-file anchor) and its anchor ('' when none). */
function markdownLinks(text: string): { target: string; path: string; anchor: string }[] {
  return [...text.matchAll(/\]\(([^)\s]+)\)/g)].map(([, target]) => {
    const hash = target.indexOf('#')
    return hash < 0
      ? { target, path: target, anchor: '' }
      : { target, path: target.slice(0, hash), anchor: target.slice(hash + 1) }
  })
}

describe('README.md', () => {
  const readme = readRepoFile('README.md')

  /**
   * b.av2 SR-12 / SR-8.6: the README's modify-semantics table, "What a
   * confirmation applies" in the Reload section. Each expected row is found by
   * the setting names in its Change cell (or a keyword where it names none),
   * and pinned by its Live session cell and whether its Once confirmed cell
   * carries `DESTRUCTIVE:`. Wording is not pinned.
   */
  describe('What a confirmation applies (SR-8.6 rows)', () => {
    const reload = markdownSection(readme, '## Reload')
    const table = firstTable(markdownSection(reload, '### What a confirmation applies'))

    type Row = { change: string; confirmed: string; session: string }
    const rows: Row[] = table.rows.map(([change, confirmed, session]) => ({ change, confirmed, session }))

    /** How the README row of a change is found, and the effect it must state. */
    type Expected = { label: string; find: (row: Row) => boolean; session: string; destructive: boolean }

    const naming = (...settings: readonly string[]) => (row: Row) =>
      settings.every((s) => codeSpans(row.change).includes(s))

    /** SR-8.6: each next-launch setting keeps the instance, `claude_config_dir` only until the next launch. */
    const NEXT_LAUNCH_SESSION: Record<NextLaunchSetting, string> = {
      claude_config_dir: 'Kept until the next launch',
      stop_hook_bootstrap: 'Kept',
    }

    /**
     * One entry per change kind the plan classifies (`ValidChangePlan`'s lists),
     * the settings expanded from the plan's exported classes. A new kind in the
     * plan fails the typecheck here until it has a README row; a new setting in
     * a class needs its name in that class's row.
     */
    const EXPECTED: Record<
      Exclude<keyof ValidChangePlan, 'valid' | 'noEffectiveChange' | 'configDirsChanged' | 'unchanged'>,
      Expected[]
    > = {
      inPlace: [
        { label: IN_PLACE_SETTINGS.join(', '), find: naming(...IN_PLACE_SETTINGS), session: 'Kept', destructive: false },
      ],
      credentials: [
        {
          label: 'credentials file content, same path',
          find: (row) => /credentials file/i.test(row.change) && /same path/i.test(row.change),
          session: 'Kept',
          destructive: false,
        },
      ],
      nextLaunch: NEXT_LAUNCH_SETTINGS.map((setting) => ({
        label: setting,
        find: naming(setting),
        session: NEXT_LAUNCH_SESSION[setting],
        destructive: false,
      })),
      removed: [
        {
          label: 'a persona is removed',
          find: (row) => /\bremoved\b/i.test(row.change) && codeSpans(row.change).length === 0,
          session: 'Destroyed',
          destructive: true,
        },
      ],
      destructive: DESTRUCTIVE_SETTINGS.map((setting) => ({
        label: setting,
        find: naming(setting),
        session: 'Destroyed',
        destructive: true,
      })),
      settings: [
        {
          label: 'a server-wide setting',
          find: (row) => /server-wide/i.test(row.change),
          session: 'Not affected',
          destructive: false,
        },
      ],
      added: [
        {
          label: 'a persona is added',
          find: (row) => /\badded\b/i.test(row.change) && codeSpans(row.change).length === 0,
          session: 'New session',
          destructive: false,
        },
      ],
    }

    test('the table sits in the Reload section with the Change | Once confirmed | Live session columns', () => {
      expect(reload).not.toBe('')
      expect(table.header).toEqual(['Change', 'Once confirmed', 'Live session'])
      for (const row of table.rows) expect(row).toHaveLength(3)
    })

    test.each(Object.values(EXPECTED).flat().map((e) => [e.label, e] as const))(
      'SR-8.6 row for %s: exactly one row, with its Live session effect and DESTRUCTIVE: only if destructive',
      (_label, expected) => {
        const matches = rows.filter(expected.find)
        expect(matches).toHaveLength(1)
        expect(matches[0].session).toBe(expected.session)
        expect(matches[0].confirmed.includes(DESTRUCTIVE_PREFIX)).toBe(expected.destructive)
      },
    )

    test('the server-wide row names a real top-level setting, such as port', () => {
      const row = rows.find(EXPECTED.settings[0].find)
      if (!row) throw new Error('no server-wide row in the table')
      const named = codeSpans(row.change)
      expect(named).toContain('port')
      for (const setting of named) expect(PERSONA_TOP_LEVEL_KEYS).toContain(setting)
    })
  })

  /**
   * b.av2 SR-12 / SR-13.5: the README persona reference. Its key tables list
   * exactly the keys the loader accepts, and its complete example loads
   * through the server's loader.
   */
  describe('persona configuration reference (SR-12, SR-13.5)', () => {
    test.each(KEY_TABLES)('the "#### %s" table lists exactly the loader\'s keys, one code span per row', (heading, keys) => {
      const table = firstTable(requiredSection(personasSection(readme), `#### ${heading}`, IN_PERSONAS))
      expect(table.header[0]).toBe('Field')
      const firstCells = table.rows.map(([cell]) => cell)
      expect(firstCells.filter((cell) => !/^`[^`]+`$/.test(cell))).toEqual([])
      expect(firstCells.map((cell) => cell.slice(1, -1)).sort()).toEqual([...keys].sort())
    })

    /**
     * The complete example, written byte for byte into a temp dir and loaded
     * through the server's loader (default mode, temp home). The loader reads
     * no credentials file (b.av2 SR-1.5), so none is written.
     */
    describe('complete example through the real loader', () => {
      let dir: string

      beforeEach(() => {
        dir = realpathSync(mkdtempSync(join(tmpdir(), 'shipped-docs-')))
      })

      afterEach(() => {
        rmSync(dir, { recursive: true, force: true })
      })

      type RawPersona = Record<string, unknown> & { dm?: Record<string, unknown> }
      type Example = { raw: { personas: RawPersona[] } & Record<string, unknown>; home: string; config: PersonaConfig }

      /**
       * Write the complete example as `<dir>/state/config.json` and load it
       * with `<dir>/home` as the home. Returns its parsed value, the home and
       * the loaded config. The example, the config and any load error are
       * leak-checked; a load error is rethrown with its message.
       */
      function loadExample(): Example {
        const text = completeExample(readme)
        assertNoLeak(text, 'example')
        let raw: Example['raw']
        try {
          raw = JSON.parse(text)
        } catch {
          throw new Error(`the "${EXAMPLE_HEADING}" json block is not strict JSON`)
        }
        if (!Array.isArray(raw.personas)) throw new Error(`the "${EXAMPLE_HEADING}" json block has no personas array`)
        const home = join(dir, 'home')
        const state = join(dir, 'state')
        mkdirSync(home)
        mkdirSync(state)
        const configPath = join(state, 'config.json')
        writeFileSync(configPath, text)
        let config: PersonaConfig
        try {
          config = loadPersonaConfig(configPath, home)
        } catch (error) {
          assertNoLeak(error, 'load error')
          throw new Error(`the complete example does not load: ${error instanceof Error ? error.message : String(error)}`)
        }
        assertNoLeak(config, 'loaded config')
        return { raw, home, config }
      }

      test('loads with no error, one resolved persona per entry, in order', () => {
        const { raw, config } = loadExample()
        expect(raw.personas.length).toBeGreaterThanOrEqual(1)
        expect(config.personas.map((p) => p.name)).toEqual(raw.personas.map((p) => p.name as string))
      })

      test('every path in the example resolves under the injected temp home or the temp config dir', () => {
        const { config } = loadExample()
        const paths = [
          ...config.personas.flatMap((p) => [p.credentials_file, p.working_directory, p.claude_config_dir]),
          ...SERVER_PATH_SETTINGS.map((setting) => config[setting]),
        ].filter((path): path is string => path !== undefined)
        expect(paths.filter((path) => !path.startsWith(`${dir}/`))).toEqual([])
      })

      const COMPLETENESS: [label: string, check: (example: Example) => void][] = [
        ['every persona-entry key', ({ raw }) => {
          expect(PERSONA_ENTRY_KEYS.filter((key) => !raw.personas.some((p) => key in p))).toEqual([])
        }],
        ['every dm key', ({ raw }) => {
          expect(PERSONA_DM_KEYS.filter((key) => !raw.personas.some((p) => p.dm !== undefined && key in p.dm))).toEqual([])
        }],
        ['both channel deliveries', ({ config }) => {
          const deliveries = config.personas.flatMap((p) => p.channels.map((c) => c.delivery))
          expect([...new Set(deliveries)].sort()).toEqual([...DELIVERY_MODES].sort())
        }],
        ['a "dm" destination and a channel destination', ({ config }) => {
          const kinds = config.personas.map((p) => (p.permission_prompts === DM_DESTINATION ? 'dm' : 'channel'))
          expect([...new Set(kinds)].sort()).toEqual(['channel', 'dm'])
        }],
        ['a DM-only persona', ({ config }) => {
          const shapes = config.personas.map((p) => ({ name: p.name, channels: p.channels.length, dm: p.dm.enabled }))
          expect(shapes).toContainEqual(expect.objectContaining({ channels: 0, dm: true }))
        }],
        ['a channel shared by two personas', ({ config }) => {
          const ids = config.personas.flatMap((p) => p.channels.map((c) => c.id))
          expect(ids).not.toEqual([...new Set(ids)])
        }],
        ['the moved server-wide settings', ({ raw }) => {
          expect(MOVED_SERVER_SETTINGS.filter((key) => !(key in raw))).toEqual([])
        }],
        // SR-9.4: the reply guard refuses ~/.claude, so no config dir in the example, top-level or persona, may be it.
        ['no claude_config_dir is <home>/.claude (SR-9.4)', ({ home, config }) => {
          const dirs = [['top level', config.claude_config_dir], ...config.personas.map((p) => [p.name, p.claude_config_dir])]
          expect(dirs.filter(([, configDir]) => configDir === join(home, '.claude'))).toEqual([])
        }],
      ]

      test.each(COMPLETENESS)('the example is complete: %s', (_label, check) => {
        check(loadExample())
      })
    })
  })

  /**
   * The README points to the setup wizard: the Quick Start links to its skill
   * file, and `#### Credentials files` names it and links to its credentials
   * command. Every link into `skills/` must land on a real file and heading.
   */
  describe('setup wizard pointer', () => {
    function credentialsFiles(): string {
      return requiredSection(personasSection(readme), '#### Credentials files', IN_PERSONAS)
    }

    test('the Quick Start links to the wizard skill file', () => {
      const quickStart = requiredSection(readme, '## Quick Start', 'README.md')
      expect(markdownLinks(quickStart).map((link) => link.path)).toContain(WIZARD_FILE)
    })

    test(`"#### Credentials files" names the wizard, ${WIZARD_NAME}, outside any link target`, () => {
      const prose = splitFences(credentialsFiles()).prose.replace(/\]\([^)]*\)/g, ']')
      expect(prose).toMatch(new RegExp(`\\b${WIZARD_NAME}\\b`))
    })

    test(`"#### Credentials files" links to the wizard's "## ${WIZARD_CREDENTIALS_HEADING}" heading`, () => {
      const targets = markdownLinks(credentialsFiles()).map((link) => link.target)
      // That the heading exists in the wizard is the links-into-skills/ case below.
      expect(targets).toContain(`${WIZARD_FILE}#${headingSlug(WIZARD_CREDENTIALS_HEADING)}`)
    })

    test('every README link into skills/ names an existing file and, with an anchor, one of its headings', () => {
      const links = markdownLinks(readme).filter((link) => link.path.startsWith('skills/'))
      expect(links.length).toBeGreaterThan(0)
      const broken = links
        .filter((link) => {
          const file = resolve(REPO_ROOT, link.path)
          if (!existsSync(file) || !statSync(file).isFile()) return true
          return link.anchor !== '' && !headingAnchors(readFileSync(file, 'utf-8')).includes(link.anchor)
        })
        .map((link) => link.target)
      expect(broken).toEqual([])
    })
  })
})

/** Every file under `skills/`, repo-relative and sorted, so a skill added later is audited too. */
function shippedSkillFiles(): string[] {
  return (readdirSync(resolve(REPO_ROOT, 'skills'), { recursive: true }) as string[])
    .map((rel) => join('skills', rel))
    .filter((rel) => statSync(resolve(REPO_ROOT, rel)).isFile())
    .sort()
}

/**
 * The MCP instruction text: `MCP_INSTRUCTIONS` as src/registry.ts exports it,
 * the exact string every session server sends as its `instructions` (never
 * the source file's text: its comments and identifiers aren't shipped). Throws
 * when it is empty, so the audit never passes on nothing.
 */
function mcpInstructionsText(): string {
  if (MCP_INSTRUCTIONS.trim() === '') throw new Error('src/registry.ts exports an empty MCP_INSTRUCTIONS')
  return MCP_INSTRUCTIONS
}

/** The name the MCP instructions go by in the audit's failures and case titles. */
const MCP_INSTRUCTIONS_NAME = 'MCP instructions (src/registry.ts MCP_INSTRUCTIONS)'

/** The Slack Reply Guard, whose reminder text reaches every persona's instance. */
const REPLY_GUARD_FILE = 'stop-hooks/slack-reply-guard.sh'

/**
 * The Slack Reply Guard's reminder text: every `PROVENANCE="…"` wording and
 * the `REMINDER_TAIL="…"` the hook prints to the instance, one per line, read
 * as the literal strings the script assigns (not its comments or code; an
 * assignment that expands a variable is skipped). Throws when either is
 * missing, so the audit never passes on nothing.
 */
function replyGuardReminderText(): string {
  const script = readRepoFile(REPLY_GUARD_FILE)
  const literals = (name: string) =>
    [...script.matchAll(new RegExp(`^\\s*${name}="([^"$]*)"\\s*$`, 'gm'))].map((m) => m[1])
  const provenances = literals('PROVENANCE')
  const tails = literals('REMINDER_TAIL')
  if (provenances.length === 0 || tails.length !== 1) {
    throw new Error(`${REPLY_GUARD_FILE}: expected PROVENANCE wordings and one REMINDER_TAIL, found ${provenances.length} and ${tails.length}`)
  }
  return [...provenances, ...tails].join('\n')
}

/** The crontable header the server writes for a new crontable, as src/cron-bootstrap.ts exports it. */
function crontableHeaderText(): string {
  if (CRONTABLE_TEMPLATE_HEADER.trim() === '') throw new Error('src/cron-bootstrap.ts exports an empty CRONTABLE_TEMPLATE_HEADER')
  return CRONTABLE_TEMPLATE_HEADER
}

/**
 * Every shipped text the audit reads: [name in failures, text]. The MCP tool
 * descriptions are not read: src/registry.ts builds the tool list inline in
 * `createSessionServer` and exports no list to read it through.
 */
const SHIPPED_TEXTS: [name: string, read: () => string][] = [
  ['README.md', () => readRepoFile('README.md')],
  ...shippedSkillFiles().map((rel): [string, () => string] => [rel, () => readRepoFile(rel)]),
  ['slack-app-manifest.yml', () => readRepoFile('slack-app-manifest.yml')],
  [CREDENTIALS_SCRIPT, () => readRepoFile(CREDENTIALS_SCRIPT)],
  [MCP_INSTRUCTIONS_NAME, mcpInstructionsText],
  [`${REPLY_GUARD_FILE} (reminder text)`, replyGuardReminderText],
  ['CRONTABLE_TEMPLATE_HEADER (src/cron-bootstrap.ts)', crontableHeaderText],
]

/**
 * b.av2 SR-12: the claim that a first @mention activates (wakes, unlocks)
 * event delivery in a channel, in the forms the README and the wizard once
 * shipped ("Slack may not deliver messages until the bot is @mentioned for
 * the first time … the first @mention activates event delivery"). Matched
 * case-insensitively across line breaks. "Until … @mention" counts only next
 * to a deliver, send or event word, and activation only with an activation
 * verb (not the generic "starts" or "enables"), so the receiving section's
 * legitimate @mention and delivery wording matches none of them; the control
 * table below pins both sides.
 */
const FIRST_MENTION_CLAIM: [label: string, pattern: RegExp][] = [
  ['a first @mention', /\bfirst\s+@?mention/gi],
  ['@mentioned for the first time', /@?mention(?:ed|s|ing)?\b[^.]{0,40}?\bfirst\s+time\b/gi],
  ['activating delivery', /\b(?:activat|wak|unlock)\w*\s+(?:the\s+)?(?:\w+\s+)?(?:event\s+)?delivery\b|\btrigger\w*\s+(?:the\s+)?(?:\w+\s+)?event\s+delivery\b/gi],
  [
    'no delivery until @mentioned',
    /\b(?:deliver|send|sent|event)\w*\b[^.]{0,40}?\buntil\b[^.]{0,40}?@?mention(?:ed|s)?\b|\buntil\b[^.]{0,40}?@?mention(?:ed|s)?\b[^.]{0,40}?\b(?:deliver|send|sent|event)\w*/gi,
  ],
]

/** Each match of `terms` in `text`, as `<label>: <matched text>`. */
function termsIn(text: string, terms: readonly [label: string, pattern: RegExp][]): string[] {
  return terms.flatMap(([label, pattern]) => [...text.matchAll(pattern)].map((m) => `${label}: ${m[0]}`))
}

describe('shipped text audit (README, skills, manifest, MCP instructions)', () => {
  test(`the audit covers every skill file, the wizard's ${WIZARD_FILE} included`, () => {
    expect(SHIPPED_TEXTS.map(([name]) => name)).toContain(WIZARD_FILE)
  })

  test.each(SHIPPED_TEXTS)('SR-12: %s does not claim a first @mention activates event delivery', (_name, read) => {
    expect(termsIn(read(), FIRST_MENTION_CLAIM)).toEqual([])
  })

  /** Controls for the matcher: the historical claim and its variants match; ordinary @mention and delivery wording doesn't. */
  test.each([
    ['Slack may not deliver messages until the bot is @mentioned for the first time.', true],
    ['This is a Slack Socket Mode behavior — the first @mention activates event delivery for that channel.', true],
    ['@mention the bot once to activate delivery.', true],
    ['Until you @mention the bot, it gets no events.', true],
    ['A persona waits until it is @mentioned, then replies.', false],
    ['The server enables event delivery for every configured channel.', false],
  ] as const)('the first-@mention matcher on %p: matches is %p', (sentence, claim) => {
    expect(termsIn(sentence, FIRST_MENTION_CLAIM).length > 0).toBe(claim)
  })
})

// ---------------------------------------------------------------------------
// AC 46: the forbidden-term audit
// ---------------------------------------------------------------------------

/** One forbidden term: its label in case titles and failures, and its pattern (flag `g`, so every occurrence is found). */
type Term = readonly [label: string, pattern: RegExp]

/** A group of forbidden terms: what they stand for, the b.av2 SRs (or E14 decisions) that retire them, and the terms. */
interface TermGroup {
  name: string
  cites: string
  terms: readonly Term[]
}

/**
 * AC 46's forbidden terms: the one list the audit checks every shipped text
 * against. The first-@mention claim is `FIRST_MENTION_CLAIM` above, checked
 * by its own case; reload wording is `RELOAD_TERMS` (tests/test-helpers/
 * reload-terms.ts), checked in the MCP instructions only (SR-8.8 lets the README and the skills describe the
 * gesture).
 *
 * Matching rules:
 * - Key, file and variable names match as whole words (`\b…\b`), as written,
 *   so `default_route` doesn't match inside a longer key.
 * - The pre-persona shape is banned as nouns, not the verb (E14 decision 13):
 *   `routes` only as a config key (`` `routes` ``, `"routes"`, `routes:`),
 *   and route-keyed noun phrases ("per-route", "a/each/the route",
 *   "route's", "routed channel", "route map"). "The server routes each Slack
 *   event to every persona" and the MCP server name `slack-channel-router`
 *   never match. `"cwd"` counts only inside a channel-keyed map
 *   (`"C…": { … "cwd": … }`), so pasted agent-director output with a `cwd`
 *   field is not a hit.
 * - The access-control file's camelCase fields are matched case-sensitively,
 *   so the persona settings `ack_reaction`, `reply_chunk_limit` and
 *   `reply_chunk_mode` never match `ackReaction`, `textChunkLimit` or
 *   `chunkMode`.
 * - Wording is matched case-insensitively, with `\s+` between words so a
 *   phrase wrapped across lines still matches.
 * - A bearer token on a curl command line matches every header flag form
 *   (`-H "…"`, `--header "…"`, `--header=…`, unquoted); the wizard's curl
 *   config line `header = "Authorization: Bearer %s"` is not a flag.
 * - The retired name rule matches only tied to a name ("a name that looks
 *   like a Slack token"); the redaction wording "a value that looks like a
 *   Slack token" is not a hit.
 * - Token environment variables are banned by name and by export form, not
 *   by the phrase "token environment variables": E14 decision 12 prescribes
 *   that phrase for the README upgrade entry ("remove any token environment
 *   variables you exported for the previous version"), so banning it would
 *   need a second exemption; a name or an export is what would tell an
 *   operator to set one.
 */
const FORBIDDEN_TERMS: readonly TermGroup[] = [
  {
    name: 'the pre-persona shape',
    cites: 'b.av2 SR-1.7, SR-10.2',
    terms: [
      ['routes', /`routes`|"routes"|\broutes:/g],
      ['default_route', /\bdefault_route\b/g],
      ['default_dm_session', /\bdefault_dm_session\b/g],
      ['per-route', /\bper[- ]route\b/gi],
      ['a/each/the route', /\b(?:a|each|the)\s+route\b/gi],
      ["route's", /\broute['’]s\b/gi],
      ['routing config', /\brouting\s+config(?:uration)?\b/gi],
      ['routed channel', /\brouted\s+channels?\b/gi],
      ['route map', /\broute\s+maps?\b/gi],
      ['a "cwd" in a channel-keyed map', /"C[A-Z0-9]+"\s*:\s*\{[^}]*"cwd"\s*:/g],
    ],
  },
  {
    name: 'the token environment variables',
    cites: 'b.av2 SR-1.4, SR-10.2; E14 decision 12',
    terms: [
      ['SLACK_BOT_TOKEN', /\bSLACK_BOT_TOKEN\b/g],
      ['SLACK_APP_TOKEN', /\bSLACK_APP_TOKEN\b/g],
      ['an export of a token variable', /\bexport\s+\w*TOKEN\w*=/gi],
      ['`export` lines for a shell profile', /`export`\s+lines\b/gi],
    ],
  },
  {
    name: 'a token on a command line',
    cites: 'b.av2 SR-1.4',
    terms: [['a bearer token in a curl header flag', /(?:-H|--header)[\s=]+["']?Authorization:\s*Bearer\b/gi]],
  },
  {
    name: 'the access-control file and its model',
    cites: 'b.av2 SR-10.1, SR-10.2, SR-12',
    terms: [
      ['access.json', /\baccess\.json\b/gi],
      ['SLACK_ACCESS_MODE', /\bSLACK_ACCESS_MODE\b/g],
      ['/slack-channel:access', /\bslack-channel:access\b/gi],
      ['claude-slack-channels-config', /\bclaude-slack-channels-config\b/gi],
      ['dmPolicy', /\bdmPolicy\b/g],
      ['allowFrom', /\ballowFrom\b/g],
      ['requireMention', /\brequireMention\b/g],
      ['ackReaction', /\backReaction\b/g],
      ['textChunkLimit', /\btextChunkLimit\b/g],
      ['chunkMode', /\bchunkMode\b/g],
      ['access-control wording', /\baccess[- ]control\b/gi],
      ['allowlist wording', /\ballow[- ]?list(?:s|ed|ing)?\b/gi],
      ['pairing wording', /\bpairing\b/gi],
    ],
  },
  {
    name: 'the retired persona-name rule',
    cites: 'b.av2 SR-1.2; E14 Task 0',
    terms: [['a name that "looks like a Slack token"', /\bnames?\b[^.]{0,40}\blooks?\s+like\s+an?\s+(?:Slack\s+)?token\b/gi]],
  },
]

/** One exemption: `terms` may appear in `file` only inside the section under `heading` (bounded at the next heading of its level or higher). */
interface AuditException {
  file: string
  heading: string
  terms: readonly string[]
  reason: string
}

/**
 * The single exemption (b.av2 SR-12): the debugging skill's SR-1.7 entry may
 * name the three pre-persona keys to say they are rejected. Any other term
 * inside that section, and those keys anywhere else, still fail. When the
 * heading is missing the audit throws for that file; it never exempts the
 * whole file.
 */
const SR_1_7_EXCEPTION: AuditException = {
  file: 'skills/debug-slack-channel-bots/SKILL.md',
  heading: '## Pre-persona configuration',
  terms: ['routes', 'default_route', 'default_dm_session'],
  reason: 'b.av2 SR-1.7 rejection entry: names the keys only to say they are rejected',
}

const AUDIT_EXCEPTIONS: readonly AuditException[] = [SR_1_7_EXCEPTION]

/** A forbidden term found in a text: its file, 1-based line, term label, matched text and whole line. */
interface TermHit {
  file: string
  line: number
  term: string
  match: string
  text: string
}

/** A hit as a failure line: `<file>:<line>: <term> ("<match>") in: <line>`. */
function formatHit(hit: TermHit): string {
  return `${hit.file}:${hit.line}: ${hit.term} ("${hit.match}") in: ${hit.text}`
}

/** Every occurrence of `terms` in `text`, with the line each starts on. Pure. */
function findTerms(file: string, text: string, terms: readonly Term[]): TermHit[] {
  const lines = text.split('\n')
  return terms.flatMap(([term, pattern]) =>
    [...text.matchAll(pattern)].map((m) => {
      const line = text.slice(0, m.index).split('\n').length
      return { file, line, term, match: flat(m[0]), text: lines[line - 1].trim() }
    }),
  )
}

/**
 * `file`'s hits of `terms`, split into `hits` (failures) and `allowed` (inside
 * an exemption of `exceptions` for that file). Throws when an exemption's
 * heading is missing from `text`. Pure.
 */
function auditText(
  file: string,
  text: string,
  terms: readonly Term[],
  exceptions: readonly AuditException[] = AUDIT_EXCEPTIONS,
): { hits: TermHit[]; allowed: TermHit[] } {
  const ranges = exceptions
    .filter((exception) => exception.file === file)
    .map((exception) => {
      const range = sectionRange(text, exception.heading)
      if (range === undefined) {
        throw new Error(`${file} has no heading "${exception.heading}" (${exception.reason}); nothing in it is exempted`)
      }
      // 0-based [start, end) to 1-based lines, heading line included.
      return { terms: exception.terms, first: range.start + 1, last: range.end }
    })
  const exempt = (hit: TermHit) =>
    ranges.some((r) => r.terms.includes(hit.term) && hit.line >= r.first && hit.line <= r.last)
  const found = findTerms(file, text, terms)
  return { hits: found.filter((hit) => !exempt(hit)), allowed: found.filter(exempt) }
}

/** Every forbidden term, across the groups. */
const ALL_FORBIDDEN_TERMS: readonly Term[] = FORBIDDEN_TERMS.flatMap((group) => group.terms)

/** A group's term labels, for case titles. */
function termLabels(group: TermGroup): string {
  return group.terms.map(([label]) => label).join(', ')
}

describe('AC 46: forbidden-term audit (README, skills, manifest, MCP instructions)', () => {
  test('the audit reads skills/EXAMPLE_CLAUDE.md', () => {
    expect(SHIPPED_TEXTS.map(([name]) => name)).toContain('skills/EXAMPLE_CLAUDE.md')
  })

  test(`the audit reads ${CREDENTIALS_SCRIPT}, whose prompts and messages the operator sees`, () => {
    expect(SHIPPED_TEXTS.map(([name]) => name)).toContain(CREDENTIALS_SCRIPT)
  })

  const cases = SHIPPED_TEXTS.flatMap(([name, read]) =>
    FORBIDDEN_TERMS.map((group) => [name, group.name, group.cites, termLabels(group), read, group] as const),
  )

  test.each(cases)('%s: none of %s (%s): %s', (name, _group, _cites, _labels, read, group) => {
    expect(auditText(name, read(), group.terms).hits.map(formatHit)).toEqual([])
  })

  test(`the only allowed hit: ${SR_1_7_EXCEPTION.terms.join(', ')} in ${SR_1_7_EXCEPTION.file} under "${SR_1_7_EXCEPTION.heading}" (SR-1.7); with the exemption off, they appear nowhere else in shipped text`, () => {
    const keys = ALL_FORBIDDEN_TERMS.filter(([label]) => SR_1_7_EXCEPTION.terms.includes(label))
    expect(keys.map(([label]) => label)).toEqual([...SR_1_7_EXCEPTION.terms])
    const hits = SHIPPED_TEXTS.flatMap(([name, read]) => auditText(name, read(), keys, []).hits)
    const range = sectionRange(readRepoFile(SR_1_7_EXCEPTION.file), SR_1_7_EXCEPTION.heading)
    if (range === undefined) throw new Error(`${SR_1_7_EXCEPTION.file} has no heading "${SR_1_7_EXCEPTION.heading}"`)
    const inside = (hit: TermHit) => hit.file === SR_1_7_EXCEPTION.file && hit.line > range.start && hit.line <= range.end
    expect(hits.filter((hit) => !inside(hit)).map(formatHit)).toEqual([])
    expect([...new Set(hits.map((hit) => hit.term))].sort()).toEqual([...SR_1_7_EXCEPTION.terms].sort())
  })

  test(`the SR-1.7 entry names the three keys, says they are rejected and that the configuration must be rewritten as personas`, () => {
    const entry = flat(requiredSection(readRepoFile(SR_1_7_EXCEPTION.file), SR_1_7_EXCEPTION.heading, SR_1_7_EXCEPTION.file))
    for (const key of SR_1_7_EXCEPTION.terms) expect(entry).toContain(`\`${key}\``)
    expect(entry).toMatch(/\brejected\b/i)
    expect(entry).toMatch(/\brewrit\w*\b[^.]*\bpersonas\b/i)
  })

  /**
   * Shipped wording that is deliberately not a hit, each tied to its file and
   * the reason no term matches it. Not exemptions: each line is scanned like
   * any other; these cases pin that the term list leaves them alone. A
   * RegExp names a line whose text is read from the file.
   */
  const NOT_HITS_BY_DESIGN: [file: string, snippet: string | RegExp, reason: string][] = [
    [SR_1_7_EXCEPTION.file, "## A persona's routing settings were changed by a confirmed change", "E14 decision 12: a persona's channel and DM settings"],
    [SR_1_7_EXCEPTION.file, '#a-personas-routing-settings-were-changed-by-a-confirmed-change', "E14 decision 12: that heading's anchor"],
    [SR_1_7_EXCEPTION.file, '`[slack] persona-routing: ', "E14 decision 12: the server's real log prefix"],
    [SR_1_7_EXCEPTION.file, 'routinely', 'whole words: "routine" is not "routes"'],
    ['README.md', 'remove any token environment variables you exported for the previous version', "E14 decision 12's upgrade wording: variables are banned by name and export form"],
    ['README.md', 'slack-channel-router', 'the MCP server name; no route term matches it'],
    [CREDENTIALS_SCRIPT, 'header = "Authorization: Bearer %s"', "the credentials script's curl config line, read from curl's stdin, not a command-line argument"],
    [WIZARD_FILE, /^allowed-tools:.*$/m, 'skill frontmatter: a tool list, not an allowlist'],
  ]

  test.each(NOT_HITS_BY_DESIGN)('%s: %p is not a hit (%s)', (file, snippet, _reason) => {
    const text = readRepoFile(file)
    const line = typeof snippet === 'string' ? (text.includes(snippet) ? snippet : undefined) : snippet.exec(text)?.[0]
    if (line === undefined) throw new Error(`${file} no longer contains ${String(snippet)}`)
    expect(findTerms(file, line, ALL_FORBIDDEN_TERMS).map(formatHit)).toEqual([])
  })
})

/**
 * Self-checks for the scanner and the exemption, on in-memory text only: each
 * term is flagged, the SR-1.7 exemption covers only its three keys and only
 * inside its section, and persona wording is left alone.
 */
describe('AC 46: forbidden-term scanner self-checks', () => {
  /** One sample per term, so a term added to the list needs a sample here. */
  const SAMPLES: Record<string, string> = {
    routes: 'Set `routes` to a map of channels.',
    default_route: 'Set `default_route` to a channel.',
    default_dm_session: 'Set `default_dm_session`.',
    'per-route': 'Each per-route working directory.',
    'a/each/the route': 'Each route has a cwd.',
    "route's": "The route's session starts on demand.",
    'routing config': 'Edit the routing\n  config in the file.',
    'routed channel': 'Each routed channel has a session.',
    'route map': 'The route map lists channels.',
    'a "cwd" in a channel-keyed map': '{ "C0000": { "cwd": "~/work" } }',
    SLACK_BOT_TOKEN: 'Set SLACK_BOT_TOKEN in your shell.',
    SLACK_APP_TOKEN: 'Set SLACK_APP_TOKEN in your shell.',
    'an export of a token variable': 'export MY_TOKEN="<bot token>"',
    '`export` lines for a shell profile': 'Add the `export`\nlines to your shell profile.',
    'a bearer token in a curl header flag': 'curl -H "Authorization: Bearer <bot token>" https://slack.com/api/auth.test',
    'access.json': 'Edit access.json by hand.',
    SLACK_ACCESS_MODE: 'Set SLACK_ACCESS_MODE to static.',
    '/slack-channel:access': 'Run /slack-channel:access to pair.',
    'claude-slack-channels-config': 'Run the claude-slack-channels-config skill to add a channel.',
    dmPolicy: 'Set "dmPolicy" to open.',
    allowFrom: 'Add the user to allowFrom.',
    requireMention: 'Set requireMention for the channel.',
    ackReaction: 'Set ackReaction to eyes.',
    textChunkLimit: 'Set textChunkLimit to 4000.',
    chunkMode: 'Set chunkMode to newline.',
    'access-control wording': 'The Access Control file decides who may DM.',
    'allowlist wording': 'Add the user to the allow-list.',
    'pairing wording': 'Pairing codes expire after an hour.',
    'a name that "looks like a Slack token"': 'A name that looks like a Slack\ntoken is rejected.',
  }

  /**
   * More must-flag samples for the terms decision 13 narrowed: each form of
   * the `routes` key, each route-keyed noun phrase, and each curl header
   * flag form.
   */
  test.each([
    ['routes', '`routes` in backticks', 'Remove `routes` from config.json.'],
    ['routes', 'a quoted "routes" key', '{ "routes": { "C0000": {} } }'],
    ['routes', 'a routes: key', 'routes:\n  C0000: {}'],
    ['a/each/the route', '"a route"', 'Add a route for the new channel.'],
    ['a/each/the route', '"the route"', 'The route for that channel is missing.'],
    ['a "cwd" in a channel-keyed map', 'a multi-line channel map', '{\n  "C0ABC123": {\n    "name": "x",\n    "cwd": "~/work"\n  }\n}'],
    ['a bearer token in a curl header flag', '--header "…"', 'curl --header "Authorization: Bearer <bot token>" https://slack.com/api/auth.test'],
    ['a bearer token in a curl header flag', 'unquoted -H', 'curl -H Authorization:Bearer\\ <bot token> https://slack.com/api/auth.test'],
    ['a bearer token in a curl header flag', '--header=…', "curl --header='Authorization: Bearer <bot token>' https://slack.com/api/auth.test"],
    ['a name that "looks like a Slack token"', 'plural names', 'Persona names that look like a token are rejected.'],
  ] as const)('%s is flagged in %s', (label, _form, text) => {
    expect(findTerms('sample', text, ALL_FORBIDDEN_TERMS).map((hit) => hit.term)).toContain(label)
  })

  test('every term has a sample', () => {
    expect(Object.keys(SAMPLES).sort()).toEqual(ALL_FORBIDDEN_TERMS.map(([label]) => label).sort())
  })

  test.each(FORBIDDEN_TERMS.flatMap((group) => group.terms.map(([label]) => [group.name, label] as const)))(
    '%s: the term %s is flagged in its sample',
    (_group, label) => {
      expect(findTerms('sample', SAMPLES[label], ALL_FORBIDDEN_TERMS).map((hit) => hit.term)).toContain(label)
    },
  )

  test.each([
    ['the moved persona settings', '`ack_reaction`, `reply_chunk_limit` and `reply_chunk_mode` are server-wide settings.'],
    ['the MCP server name', 'Tags carry source="slack-channel-router".'],
    ['"routine" and "routinely"', 'Slack refreshes connections routinely; a routine refresh needs no action.'],
    ['routing settings and the log prefix', "## A persona's routing settings\n`[slack] persona-routing: lost-message notice`"],
    ['persona channel and DM wording', 'Each persona lists its `channels`, each with a `delivery`, and a per-persona `dm.enabled` switch.'],
    ['frontmatter tool list', 'allowed-tools: [Read, Write, Edit, Bash, Glob]'],
    ["decision 12's upgrade wording", 'Remove any token environment variables you exported for the previous version.'],
    ['a non-token environment variable', 'Your persona key is in the `CSCB_PERSONA` environment variable. export CSCB_CRON_DIR=~/cron'],
    ['the curl config header line', `  h='header = "Authorization: Bearer %s"\\n'`],
    ['a token-like name, as the README now words it', 'a token-like name is redacted there too'],
    ['"routes" as a verb (decision 13)', 'The server routes each Slack event to every persona that receives it.'],
    ['pasted agent-director `cwd` output', '{\n  "claude_instance_id": "cscb_alpha",\n  "cwd": "/home/me/work",\n  "label": { "service": "cscb" }\n}'],
    ['the redaction wording, not the name rule', 'A config error never echoes a value that looks like a Slack token.'],
    ['the curl config header line, unindented', 'header = "Authorization: Bearer %s"'],
  ])('%s is not flagged', (_label, text) => {
    expect(findTerms('sample', text, ALL_FORBIDDEN_TERMS).map(formatHit)).toEqual([])
  })

  const FILE = SR_1_7_EXCEPTION.file
  /** A synthetic debugging skill: the SR-1.7 section (with a subsection) between two other sections. */
  const skill = (earlier: string, entry: string, later: string) =>
    [
      '# Debugging', //                                  l.1
      '## Earlier', //                                   l.2
      earlier, //                                        l.3
      SR_1_7_EXCEPTION.heading, //                       l.4
      entry, //                                          l.5
      '### Detail', //                                   l.6
      'Still inside: `default_route` is rejected.', //   l.7
      '## Later', //                                     l.8
      later, //                                          l.9
    ].join('\n')
  const ENTRY = '`routes`, `default_route` and `default_dm_session` are rejected.'

  test('inside the SR-1.7 section, including its subsections, the three keys are allowed, not hits', () => {
    const { hits, allowed } = auditText(FILE, skill('-', ENTRY, '-'), ALL_FORBIDDEN_TERMS)
    expect(hits).toEqual([])
    expect(allowed.map((hit) => `${hit.line}: ${hit.term}`)).toEqual(['5: routes', '5: default_route', '7: default_route', '5: default_dm_session'])
  })

  test.each([
    ['just after the section', skill('-', ENTRY, 'Set `default_route`.'), `${FILE}:9: default_route`],
    ['just before the section', skill('Set `default_dm_session`.', ENTRY, '-'), `${FILE}:3: default_dm_session`],
  ])('a pre-persona key %s is a hit, with file and line', (_where, text, expected) => {
    const hits = auditText(FILE, text, ALL_FORBIDDEN_TERMS).hits.map(formatHit)
    expect(hits).toHaveLength(1)
    expect(hits[0].startsWith(expected)).toBe(true)
  })

  test('the same section in another skill exempts nothing', () => {
    const other = 'skills/other-skill/SKILL.md'
    const { hits, allowed } = auditText(other, skill('-', ENTRY, '-'), ALL_FORBIDDEN_TERMS)
    expect(allowed).toEqual([])
    expect(hits.map((hit) => `${hit.file}:${hit.line}: ${hit.term}`).sort()).toEqual(
      [`${other}:5: routes`, `${other}:5: default_route`, `${other}:7: default_route`, `${other}:5: default_dm_session`].sort(),
    )
  })

  test.each([
    ['a token variable', 'Unset SLACK_BOT_TOKEN too.', 'SLACK_BOT_TOKEN'],
    ['the access-control file', 'Delete access.json too.', 'access.json'],
    ['route-keyed wording', 'Each per-route setting is gone.', 'per-route'],
  ])('%s inside the SR-1.7 section is a hit', (_label, line, term) => {
    const { hits } = auditText(FILE, skill('-', `${ENTRY}\n${line}`, '-'), ALL_FORBIDDEN_TERMS)
    expect(hits.map((hit) => `${hit.line}: ${hit.term}`)).toEqual([`6: ${term}`])
  })

  test.each([
    ['removed', (text: string) => text.replace(`${SR_1_7_EXCEPTION.heading}\n`, '')],
    ['renamed', (text: string) => text.replace(SR_1_7_EXCEPTION.heading, '## Legacy configuration')],
    ['moved to another level', (text: string) => text.replace(SR_1_7_EXCEPTION.heading, `#${SR_1_7_EXCEPTION.heading}`)],
  ])('with the SR-1.7 heading %s, the audit fails naming it and exempts nothing', (_how, edit) => {
    expect(() => auditText(FILE, edit(skill('-', ENTRY, '-')), ALL_FORBIDDEN_TERMS)).toThrow(
      `${FILE} has no heading "${SR_1_7_EXCEPTION.heading}"`,
    )
  })
})

// ---------------------------------------------------------------------------
// AC 46: the README's receiving section (b.av2 SR-12, SR-4.4)
// ---------------------------------------------------------------------------

/**
 * Every `via` value (b.av2 SR-4.4), with the README row that delivers it.
 * src/delivery-decision.ts exports only `type Via`, no runtime list, so the
 * list is written out here; typing it `Record<Via, …>` fails the typecheck
 * when a value is added to or removed from `Via` until this list follows.
 */
const VIA_ROWS: Record<Via, string> = {
  dm: 'Direct message',
  mention: 'Direct @mention',
  broadcast: '`@here` / `@channel` broadcast',
  receive_all_shared: 'Every message, shared channel',
  receive_all: 'Every message, this persona alone',
}
const VIA_VALUES = Object.keys(VIA_ROWS) as Via[]

const RECEIVING_HEADING = '## How a persona receives messages'

/** The two injected kinds' rows in the receiving table: they carry no `via` (b.av2 SR-12). */
const INJECTED_ROWS = ['Scheduled prompt', '`/interject` message']

/** Every pipe table in `section`, each as its header cells and body rows (the `|---|` line skipped). */
function pipeTables(section: string): { header: string[]; rows: string[][] }[] {
  const tables: { header: string[]; rows: string[][] }[] = []
  let block: string[] = []
  for (const line of [...section.split('\n'), '']) {
    if (line.trimStart().startsWith('|')) {
      block.push(line)
      continue
    }
    if (block.length > 0) {
      const [header, , ...rows] = block.map(tableCells)
      tables.push({ header, rows })
      block = []
    }
  }
  return tables
}

describe(`AC 46: README "${RECEIVING_HEADING}" (SR-12, SR-4.4)`, () => {
  const readme = readRepoFile('README.md')
  const section = () => requiredSection(readme, RECEIVING_HEADING, 'README.md')

  /**
   * The section's table of the ways a message reaches a persona: the one
   * table whose first column is `Kind` and that has a `` `via` `` column.
   * Throws naming what is missing, so the row cases never pass on nothing.
   */
  function kindsTable(): { viaColumn: number; rows: string[][] } {
    const tables = pipeTables(section()).filter((t) => t.header[0] === 'Kind' && t.header.includes('`via`'))
    if (tables.length !== 1) {
      throw new Error(`README.md "${RECEIVING_HEADING}" must hold one table with a Kind column and a \`via\` column; found ${tables.length}`)
    }
    return { viaColumn: tables[0].header.indexOf('`via`'), rows: tables[0].rows }
  }

  /** The `via` cell of the one row whose Kind cell is `label`; throws when there is no such row or more than one. */
  function viaCell(label: string): string {
    const { viaColumn, rows } = kindsTable()
    const matches = rows.filter((row) => row[0] === label)
    if (matches.length !== 1) throw new Error(`README.md "${RECEIVING_HEADING}": ${matches.length} rows of kind "${label}", expected 1`)
    return matches[0][viaColumn] ?? ''
  }

  test.each(VIA_VALUES.map((via) => [via, VIA_ROWS[via]] as const))(
    'the table row for `%s` (%s) shows exactly that via value as a code span',
    (via, label) => {
      expect(codeSpans(viaCell(label))).toEqual([via])
    },
  )

  test.each(INJECTED_ROWS)('the injected kind %s has a table row showing no via value', (label) => {
    expect(codeSpans(viaCell(label))).toEqual([])
  })

  test.each([
    ['the scheduled prompt', /\bscheduled\s+prompt\b/i],
    ['the `/interject` message', /`\/interject`\s+message\b/i],
    ['that injected messages carry no `via`', /\bno\s+`via`/i],
  ])('names %s', (_label, pattern) => {
    expect(flat(section())).toMatch(pattern)
  })

  test('no "Messages a bot receives" heading remains', () => {
    expect(headings(readme).filter((h) => /messages a bot receives/i.test(h.title)).map((h) => h.text)).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// AC 74 (shipped-docs leg): no reload wording in the MCP instructions (b.av2 SR-8.8)
// ---------------------------------------------------------------------------

// `RELOAD_TERMS` (tests/test-helpers/reload-terms.ts) is the list the CLI and
// MCP tool-list cases use too. The README and the skills may describe the
// gesture and are not checked.
describe('AC 74: the MCP instructions carry no reload wording (SR-8.8)', () => {
  test.each(RELOAD_TERMS.map((term) => [String(term), term] as const))('%s is absent', (_label, term) => {
    const text = mcpInstructionsText()
    expect(typeof term === 'string' ? text.includes(term) : term.test(text)).toBe(false)
  })
})
