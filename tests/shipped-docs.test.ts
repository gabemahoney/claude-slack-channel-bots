/**
 * shipped-docs.test.ts — audits files the package ships to the operator
 * (b.av2 SR-13.5). One `describe` per shipped file.
 *
 * Covers the Slack app manifest (b.av2 AC 39, SR-4.3, SR-12), the README's
 * modify-semantics table (SR-12, SR-8.6), held against the change plan's
 * exported classes in src/reload-plan.ts, and the README persona reference
 * (SR-12), whose key tables list exactly the loader's keys and whose complete
 * example loads through the real loader (SR-13.5). E14 extends it into the
 * full shipped-docs audit (README, skills, MCP instructions).
 *
 * Reads repo files resolved from this file's location, so the working
 * directory doesn't matter. The one writer is the complete-example load: it
 * writes the example into its own `mkdtempSync` directory, removed after each
 * test, and passes that directory's `home` to the loader, which reads no
 * credentials file. No real HOME, no server, no CLI (SR-13.2).
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'fs'
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

/**
 * The body of the Markdown section under the first heading `title` at `level`
 * (`##` = 2), up to the next heading at that level or higher; undefined when
 * there is no such heading. Fenced code blocks are not headings.
 */
function findSection(text: string, level: number, title: string): string | undefined {
  const lines = text.split('\n')
  const heading = new RegExp(`^(#{1,${level}})\\s+(.*?)\\s*$`)
  let inFence = false
  let start = -1
  for (let i = 0; i < lines.length; i++) {
    if (/^\s*(```|~~~)/.test(lines[i])) inFence = !inFence
    if (inFence) continue
    const m = heading.exec(lines[i])
    if (!m) continue
    if (start >= 0) return lines.slice(start, i).join('\n')
    if (m[1].length === level && m[2] === title) start = i + 1
  }
  return start >= 0 ? lines.slice(start).join('\n') : undefined
}

/** `findSection`, with '' when the heading is absent. */
function markdownSection(text: string, level: number, title: string): string {
  return findSection(text, level, title) ?? ''
}

/** `findSection`, throwing a message that names the missing heading instead of returning undefined. */
function requiredSection(text: string, level: number, title: string, where: string): string {
  const section = findSection(text, level, title)
  if (section === undefined) throw new Error(`README.md has no "${'#'.repeat(level)} ${title}" heading ${where}`)
  return section
}

/**
 * `section` split into its prose (every line outside a fenced code block) and
 * its fenced blocks in order, each with its info string (`json`, '' when
 * untagged) and its body lines exactly as written. A block closes at a line of
 * the same fence character at least as long as its opening fence.
 */
function splitFences(section: string): { prose: string; blocks: { info: string; body: string }[] } {
  const prose: string[] = []
  const blocks: { info: string; body: string }[] = []
  let open: { fence: string; info: string; body: string[] } | null = null
  for (const line of section.split('\n')) {
    if (open === null) {
      const m = /^ {0,3}(`{3,}|~{3,})\s*([^\s`]*)/.exec(line)
      if (m) open = { fence: m[1], info: m[2], body: [] }
      else prose.push(line)
    } else if (new RegExp(`^ {0,3}${open.fence[0]}{${open.fence.length},}\\s*$`).test(line)) {
      blocks.push({ info: open.info, body: open.body.join('\n') })
      open = null
    } else {
      open.body.push(line)
    }
  }
  if (open !== null) blocks.push({ info: open.info, body: open.body.join('\n') })
  return { prose: prose.join('\n'), blocks }
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

/** The README's persona configuration reference heading (`###`) and its complete-example heading (`####`), DOC-1's interface. */
const PERSONAS_HEADING = 'Personas (config.json)'
const EXAMPLE_HEADING = 'Example'

/**
 * The complete example's text: the one fenced block, tagged `json`, directly
 * under `#### Example` inside `### Personas (config.json)`. Throws naming what
 * is missing, and on any other count or tag, so the load case never passes
 * vacuously or on some other JSON block.
 */
function completeExample(readme: string): string {
  const personas = requiredSection(readme, 3, PERSONAS_HEADING, '')
  const example = requiredSection(personas, 4, EXAMPLE_HEADING, `under "### ${PERSONAS_HEADING}"`)
  const { blocks } = splitFences(example)
  if (blocks.length !== 1 || blocks[0].info !== 'json') {
    const found = blocks.map((b) => `\`\`\`${b.info}`).join(', ') || 'none'
    throw new Error(`"#### ${EXAMPLE_HEADING}" must hold exactly one fenced json block; found: ${found}`)
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
    const reload = markdownSection(readme, 2, 'Reload')
    const table = firstTable(markdownSection(reload, 3, 'What a confirmation applies'))

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
      const personas = requiredSection(readme, 3, PERSONAS_HEADING, '')
      const table = firstTable(requiredSection(personas, 4, heading, `under "### ${PERSONAS_HEADING}"`))
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
          throw new Error(`the "#### ${EXAMPLE_HEADING}" json block is not strict JSON`)
        }
        if (!Array.isArray(raw.personas)) throw new Error(`the "#### ${EXAMPLE_HEADING}" json block has no personas array`)
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
})
