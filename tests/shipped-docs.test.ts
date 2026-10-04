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
 *   tokens, the access-control file, the retired name-rule wording). The
 *   exemptions (`AUDIT_EXCEPTIONS`) are the debugging skill's SR-1.7 entry
 *   and `access.json` inside the README's switch-over runbook section, which
 *   saves the previous CSCB's file (b.jg5 SRJ-1108, SRJ-1516);
 * - the README's receiving section (SR-12, SR-4.4): its table's row for each
 *   `via` value shows that value, and both injected kinds' rows show none;
 * - the MCP instructions carry no reload wording (AC 74, SR-8.8);
 * - the MCP instructions and the Reply Guard's reminder text name no
 *   spelling of `clear-latch` (AC 47, b.jg5 SRJ-511); the README and the
 *   skills may, for the operator;
 * - the two agent-director refusal classes, `ad-below-phase1-floor` and
 *   `ad-system-install-too-old` (b.jg5 SRJ-208): the debugging skill has an
 *   entry per label inside its refusal section and README "Startup errors" a
 *   line per label, each naming the switch-over runbook section by its title;
 *   neither the refusal section nor a README line carries an upgrade form
 *   (tests/test-helpers/upgrade-forms.ts, self-checked here); exactly one
 *   README heading, under `## Migration`, carries the title the refusals
 *   name (replacing E2's no-link case), and every link into that section
 *   from the README and the two skills resolves;
 * - the switch-over runbook, README "Switching over to agent-director
 *   Phase 1" (b.jg5 SRJ-1108; the E2-gate and E5 hatch notes): its steps
 *   1–11 read in order by the file-local step reader, one named case per
 *   SRJ-1108 element over each carrier (`SWITCH_OVER_CARRIERS`), the
 *   negative and order checks, the "Arrived here from a startup refusal?"
 *   block's ordered elements and branches, the publishing-host block, the
 *   sections the runbook replaced or kept, and the reader's self-checks.
 *   Values CSCB defines are imported; agent-director vocabulary CSCB defines
 *   nowhere sits in `AD_VOCABULARY`, each row citing its source.
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
  DEFAULT_AGENT_DIRECTOR_CALL_TIMEOUT_MS,
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
  classHeading,
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
import { CLEAR_LATCH_TERMS, clearLatchTermsIn } from './test-helpers/clear-latch-terms.ts'
import { UPGRADE_FORMS } from './test-helpers/upgrade-forms.ts'
import { CRONTABLE_TEMPLATE_HEADER } from '../src/cron-bootstrap.ts'
import type { Via } from '../src/delivery-decision.ts'
import { MCP_INSTRUCTIONS } from '../src/registry.ts'
import { PHASE1_RUNBOOK_SECTION_TITLE } from '../src/ad-version-gate.ts'
import { AD_BELOW_PHASE1_FLOOR, AD_SYSTEM_INSTALL_TOO_OLD } from '../src/install-check.ts'
import {
  AD_CALL_TIMEOUT_NEED_MARGIN_MS,
  AD_CEILING_VERBS,
  AD_LAUNCH_CEILING_VERBS,
  AD_PAUSE_TABLE,
  AD_PAUSE_TIMEOUT_KEY,
  AD_SETTING_MINIMUMS,
  AD_SETTINGS_RELATIVE_PATH,
  AD_TMUX_KEYS,
  AD_TMUX_TABLE,
  DEFAULT_AD_SETTINGS,
  type AdTmuxKey,
} from '../src/ad-settings.ts'
import { DEFAULT_STORE_PATH } from '../src/agent-director-client.ts'
import { CLIENT_MIN_VERSION, MIN_CLAUDE_CODE_VERSION, OLD_AD_VERSION } from './test-helpers/agent-director-versions.ts'
import {
  PUBLISHING_HOST_BLOCK_HEADING,
  REFUSAL_BLOCK_HEADING,
  ROLLBACK_RUNBOOK_SECTION_TITLE,
  stepHeadingPrefix,
  stepNumberOf,
} from './test-helpers/runbooks.ts'
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
   * carries `DESTRUCTIVE:`. Wording is not pinned. SR-8.6 as amended by b.jg5
   * SRJ-1511: removal and destructive rows read "Retired: never resumed".
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
     * A removal or a destructive modify retires the persona: its session is
     * stopped and never resumed (b.jg5 SRJ-1511).
     */
    const RETIRED_SESSION = 'Retired: never resumed'

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
          session: RETIRED_SESSION,
          destructive: true,
        },
      ],
      destructive: DESTRUCTIVE_SETTINGS.map((setting) => ({
        label: setting,
        find: naming(setting),
        session: RETIRED_SESSION,
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
 * The first exemption (b.av2 SR-12): the debugging skill's SR-1.7 entry may
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

/**
 * The switch-over runbook's exemption (b.jg5 SRJ-1108, SRJ-1516): the README
 * section may name `access.json` among the previous CSCB's files it saves and
 * restores. Every other term stays banned there, the token variables' names
 * included, and `access.json` stays banned everywhere else. A missing heading
 * throws, as for the SR-1.7 entry. The rollback section's entry is SRJ-1516's
 * own (b.jg5 E35 T2).
 */
const SWITCH_OVER_EXCEPTION: AuditException = {
  file: 'README.md',
  heading: `### ${PHASE1_RUNBOOK_SECTION_TITLE}`,
  terms: ['access.json'],
  reason: "b.jg5 SRJ-1108, SRJ-1516: the switch-over runbook saves and restores the previous CSCB's access.json",
}

const AUDIT_EXCEPTIONS: readonly AuditException[] = [SR_1_7_EXCEPTION, SWITCH_OVER_EXCEPTION]

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

  test(`the only allowed hit: ${SWITCH_OVER_EXCEPTION.terms.join(', ')} in ${SWITCH_OVER_EXCEPTION.file} under "${SWITCH_OVER_EXCEPTION.heading}" (SRJ-1108, SRJ-1516); with the exemption off, it appears nowhere else in shipped text, and the exemption is used`, () => {
    const terms = ALL_FORBIDDEN_TERMS.filter(([label]) => SWITCH_OVER_EXCEPTION.terms.includes(label))
    expect(terms.map(([label]) => label)).toEqual([...SWITCH_OVER_EXCEPTION.terms])
    const hits = SHIPPED_TEXTS.flatMap(([name, read]) => auditText(name, read(), terms, []).hits)
    const readme = readRepoFile(SWITCH_OVER_EXCEPTION.file)
    const range = sectionRange(readme, SWITCH_OVER_EXCEPTION.heading)
    if (range === undefined) throw new Error(`${SWITCH_OVER_EXCEPTION.file} has no heading "${SWITCH_OVER_EXCEPTION.heading}"`)
    const inside = (hit: TermHit) => hit.file === SWITCH_OVER_EXCEPTION.file && hit.line > range.start && hit.line <= range.end
    expect(hits.filter((hit) => !inside(hit)).map(formatHit)).toEqual([])
    const { hits: left, allowed } = auditText(SWITCH_OVER_EXCEPTION.file, readme, terms)
    expect(left).toEqual([])
    expect(allowed.length).toBeGreaterThan(0)
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

  /** The switch-over runbook's exemption (b.jg5 SRJ-1108, SRJ-1516), on a synthetic README. */
  describe('the switch-over runbook exemption', () => {
    const README = SWITCH_OVER_EXCEPTION.file
    const SAVE = 'Keep a copy of `access.json`.'
    /** A synthetic README: the switch-over section (with a step subsection) between two sections, then another `##` section. */
    const readme = (earlier: string, inside: string, later: string, other: string) =>
      [
        '# CSCB', //                                                  l.1
        '## Migration', //                                            l.2
        earlier, //                                                   l.3
        SWITCH_OVER_EXCEPTION.heading, //                             l.4
        inside, //                                                    l.5
        `#### ${stepHeadingPrefix(1)}Stage the release`, //           l.6
        SAVE, //                                                      l.7
        '### Upgrading to personas', //                               l.8
        later, //                                                     l.9
        '## Troubleshooting', //                                      l.10
        other, //                                                     l.11
      ].join('\n')

    test('inside the section, including its subsections, access.json is allowed, not a hit', () => {
      const { hits, allowed } = auditText(README, readme('-', SAVE, '-', '-'), ALL_FORBIDDEN_TERMS)
      expect(hits).toEqual([])
      expect(allowed.map((hit) => `${hit.line}: ${hit.term}`)).toEqual(['5: access.json', '7: access.json'])
    })

    test.each([
      ['just before the section', readme(SAVE, '-', '-', '-'), `${README}:3: access.json`],
      ['just after the section', readme('-', '-', SAVE, '-'), `${README}:9: access.json`],
      ['in another section', readme('-', '-', '-', SAVE), `${README}:11: access.json`],
    ])('access.json %s is a hit, with file and line', (_where, text, expected) => {
      const hits = auditText(README, text, ALL_FORBIDDEN_TERMS).hits.map(formatHit)
      expect(hits).toHaveLength(1)
      expect(hits[0].startsWith(expected)).toBe(true)
    })

    test.each([
      ['a token variable', 'Unset SLACK_APP_TOKEN too.', 'SLACK_APP_TOKEN'],
      ['an export of a token variable', 'export MY_TOKEN="<bot token>"', 'an export of a token variable'],
      ['access-control wording', 'It holds the access control list.', 'access-control wording'],
    ])('%s inside the section is a hit', (_label, line, term) => {
      const { hits } = auditText(README, readme('-', `${SAVE}\n${line}`, '-', '-'), ALL_FORBIDDEN_TERMS)
      expect(hits.map((hit) => `${hit.line}: ${hit.term}`)).toEqual([`6: ${term}`])
    })

    test('the same heading in a skill exempts nothing', () => {
      const other = 'skills/other-skill/SKILL.md'
      const { hits, allowed } = auditText(other, readme('-', SAVE, '-', '-'), ALL_FORBIDDEN_TERMS)
      expect(allowed).toEqual([])
      expect(hits.map((hit) => `${hit.file}:${hit.line}: ${hit.term}`)).toEqual([`${other}:5: access.json`, `${other}:7: access.json`])
    })

    test.each([
      ['removed', (text: string) => text.replace(`${SWITCH_OVER_EXCEPTION.heading}\n`, '')],
      ['renamed', (text: string) => text.replace(SWITCH_OVER_EXCEPTION.heading, '### Switching over')],
      ['moved to another level', (text: string) => text.replace(SWITCH_OVER_EXCEPTION.heading, `#${SWITCH_OVER_EXCEPTION.heading}`)],
    ])('with the switch-over heading %s, the audit fails naming it and exempts nothing', (_how, edit) => {
      expect(() => auditText(README, edit(readme('-', SAVE, '-', '-')), ALL_FORBIDDEN_TERMS)).toThrow(
        `${README} has no heading "${SWITCH_OVER_EXCEPTION.heading}"`,
      )
    })
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

// ---------------------------------------------------------------------------
// AC 47 (shipped-docs leg): clear-latch is not offered to a bot (b.jg5 SRJ-511)
// ---------------------------------------------------------------------------

// `CLEAR_LATCH_TERMS` (tests/test-helpers/clear-latch-terms.ts) is the list the
// tool-list and notice-text cases use too. The command is the operator's: the
// README and the debugging skill describe it, so they are not read here and the
// command is not one of `FORBIDDEN_TERMS`; the manifest, the crontable header
// and the CLI usage text are not read either.
describe('AC 47: the MCP instructions and the Reply Guard reminder do not name clear-latch (SRJ-511)', () => {
  const BOT_FACING_TEXTS: [name: string, read: () => string][] = [
    [MCP_INSTRUCTIONS_NAME, mcpInstructionsText],
    [`${REPLY_GUARD_FILE} (reminder text)`, replyGuardReminderText],
  ]

  test.each(BOT_FACING_TEXTS.flatMap(([name, read]) => CLEAR_LATCH_TERMS.map((term) => [name, term, read] as const)))(
    '%s: %s is absent',
    (_name, term, read) => {
      expect(clearLatchTermsIn(read()).filter((found) => found === term)).toEqual([])
    },
  )
})

// ---------------------------------------------------------------------------
// The agent-director refusal classes point to the switch-over runbook (b.jg5 SRJ-208)
// ---------------------------------------------------------------------------

/** The two startup refusal classes for an agent-director binary that is too old. */
const REFUSAL_LABELS: string[] = [AD_BELOW_PHASE1_FLOOR, AD_SYSTEM_INSTALL_TOO_OLD]

const DEBUG_SKILL_FILE = 'skills/debug-slack-channel-bots/SKILL.md'
const INSTALL_SKILL_FILE = 'skills/install-cscb/SKILL.md'
const STARTUP_ERRORS_HEADING = '## Startup errors'

/** The debugging skill's section holding the refusal entries, which its triage points to. */
const REFUSAL_SECTION_TITLE = 'The server refuses the agent-director binary at start'

/**
 * The list item in `section` that opens with the label as a code span
 * (`- \`label\` — …`), with any indented continuation lines, whitespace
 * collapsed. Throws naming the label unless exactly one item opens with it.
 */
function labelItem(section: string, label: string, where: string): string {
  const lines = section.split('\n')
  const starts = lines.flatMap((line, i) => (line.startsWith(`- \`${label}\``) ? [i] : []))
  if (starts.length !== 1) throw new Error(`${where}: ${starts.length} list items open with \`${label}\`, expected 1`)
  const item = [lines[starts[0]]]
  for (const line of lines.slice(starts[0] + 1)) {
    if (!/^\s+\S/.test(line)) break
    item.push(line)
  }
  return flat(item.join('\n'))
}

describe('the agent-director refusal classes name the switch-over runbook (b.jg5 SRJ-208)', () => {
  const debugSkill = readRepoFile(DEBUG_SKILL_FILE)
  const readme = readRepoFile('README.md')
  const runbookAnchor = headingSlug(PHASE1_RUNBOOK_SECTION_TITLE)
  const debugEntry = (label: string) => flat(requiredSection(debugSkill, classHeading(label), DEBUG_SKILL_FILE))
  const readmeItem = (label: string) =>
    labelItem(requiredSection(readme, STARTUP_ERRORS_HEADING, 'README.md'), label, `README.md "${STARTUP_ERRORS_HEADING}"`)

  describe(DEBUG_SKILL_FILE, () => {
    test.each(REFUSAL_LABELS)('has a `###` entry headed by `%s`', (label) => {
      expect(headings(debugSkill).filter((h) => classHeading(label).test(h.text))).toHaveLength(1)
    })

    test.each(REFUSAL_LABELS)('the `%s` entry sits under the refusal section', (label) => {
      const parent = sectionRange(debugSkill, `## ${REFUSAL_SECTION_TITLE}`)
      const entry = sectionRange(debugSkill, classHeading(label))
      expect(parent).toBeDefined()
      expect(entry).toBeDefined()
      expect(entry!.start).toBeGreaterThan(parent!.start)
      expect(entry!.end).toBeLessThanOrEqual(parent!.end)
    })

    test.each(REFUSAL_LABELS)('the `%s` entry names the runbook section by its title', (label) => {
      expect(debugEntry(label)).toContain(PHASE1_RUNBOOK_SECTION_TITLE)
    })

    test.each(UPGRADE_FORMS.map(([form, pattern]) => [form, pattern] as const))(
      'the refusal section carries no %s',
      (_form, pattern) => {
        expect(flat(requiredSection(debugSkill, `## ${REFUSAL_SECTION_TITLE}`, DEBUG_SKILL_FILE))).not.toMatch(pattern)
      },
    )

    test('the triage points to the refusal section by an anchor that resolves', () => {
      const anchor = headingSlug(REFUSAL_SECTION_TITLE)
      expect(markdownLinks(debugSkill).filter((link) => link.path === '').map((link) => link.anchor)).toContain(anchor)
      expect(headingAnchors(debugSkill)).toContain(anchor)
    })
  })

  describe(`README.md "${STARTUP_ERRORS_HEADING}"`, () => {
    test.each(REFUSAL_LABELS)('the `%s` line names the runbook section by its title', (label) => {
      expect(readmeItem(label)).toContain(PHASE1_RUNBOOK_SECTION_TITLE)
    })

    test.each(REFUSAL_LABELS.flatMap((label) => UPGRADE_FORMS.map(([form, pattern]) => [label, form, pattern] as const)))(
      'the `%s` line carries no %s',
      (label, _form, pattern) => {
        expect(readmeItem(label)).not.toMatch(pattern)
      },
    )
  })

  // E2 gate (b.jg5 SRJ-1108): the section the refusals name exists once, under
  // `## Migration`, and every link into it resolves.
  test('exactly one README heading carries the title every refusal names, a `###` under `## Migration`', () => {
    expect(runbookTitleProblems(readme)).toEqual([])
  })

  test(`every link from README.md, ${DEBUG_SKILL_FILE} and ${INSTALL_SKILL_FILE} into the runbook section resolves to a heading in it`, () => {
    const texts: [string, string][] = [['README.md', readme], ...[DEBUG_SKILL_FILE, INSTALL_SKILL_FILE].map((file): [string, string] => [file, readRepoFile(file)])]
    const { checked, broken } = runbookLinkProblems(readme, texts)
    expect(broken).toEqual([])
    expect(checked).toContain(`README.md -> #${runbookAnchor}`)
  })

  test.each([
    ['renamed', (text: string) => text.replace(`### ${PHASE1_RUNBOOK_SECTION_TITLE}\n`, '### Switching over\n')],
    ['re-levelled', (text: string) => text.replace(`### ${PHASE1_RUNBOOK_SECTION_TITLE}\n`, `#### ${PHASE1_RUNBOOK_SECTION_TITLE}\n`)],
  ])('self-check: with the runbook heading %s, the title case and the link case both fail', (_how, edit) => {
    const edited = edit(readme)
    expect(edited).not.toBe(readme)
    expect(runbookTitleProblems(edited)).not.toEqual([])
    expect(runbookLinkProblems(edited, [['README.md', edited]]).broken).toContain(`README.md -> #${runbookAnchor}`)
  })

  test.each(UPGRADE_FORMS)('self-check: the %s pattern matches its synthetic string', (_form, pattern, sample) => {
    expect(flat(sample)).toMatch(pattern)
  })

  test('self-check: no pattern matches the runbook pointer itself', () => {
    const pointer = flat(`Follow the README section "${PHASE1_RUNBOOK_SECTION_TITLE}" to install agent-director, then start the server again.`)
    expect(UPGRADE_FORMS.filter(([, pattern]) => pattern.test(pointer)).map(([form]) => form)).toEqual([])
  })

  test('self-check: a README item missing its label fails naming the label', () => {
    expect(() => labelItem('- `other-class` — text', AD_BELOW_PHASE1_FLOOR, 'fixture')).toThrow(`0 list items open with \`${AD_BELOW_PHASE1_FLOOR}\``)
  })

  test('self-check: a README item takes its indented continuation lines and stops at the next item', () => {
    const fixture = `- \`${AD_BELOW_PHASE1_FLOOR}\` — first\n  second\n- \`next\` — third`
    expect(labelItem(fixture, AD_BELOW_PHASE1_FLOOR, 'fixture')).toBe(`- \`${AD_BELOW_PHASE1_FLOOR}\` — first second`)
  })
})

/** The README section the runbooks sit under. */
const MIGRATION_HEADING = '## Migration'

/** The switch-over section's heading as the README writes it: a `###` under `## Migration`. */
const SWITCH_OVER_HEADING = `### ${PHASE1_RUNBOOK_SECTION_TITLE}`

/**
 * What is wrong with the README heading the refusals name (E2 gate, b.jg5
 * SRJ-1108): exactly one heading carries `PHASE1_RUNBOOK_SECTION_TITLE`, at
 * `###`, inside `## Migration`. Pure; `[]` when all holds.
 */
function runbookTitleProblems(readme: string): string[] {
  const titled = headings(readme).filter((h) => h.title === PHASE1_RUNBOOK_SECTION_TITLE)
  if (titled.length !== 1) return [`${titled.length} README headings are titled "${PHASE1_RUNBOOK_SECTION_TITLE}", expected 1`]
  const [heading] = titled
  const problems: string[] = []
  if (heading.text !== SWITCH_OVER_HEADING) problems.push(`"${heading.text}" is not "${SWITCH_OVER_HEADING}"`)
  const migration = sectionRange(readme, MIGRATION_HEADING)
  if (migration === undefined || heading.line <= migration.start || heading.line >= migration.end) {
    problems.push(`"${heading.text}" is not under "${MIGRATION_HEADING}"`)
  }
  return problems
}

/**
 * Every link from `texts` into the switch-over section, as `<file> -> #<anchor>`
 * (`checked`), and those that resolve to no heading inside the README section
 * (`broken`). A README link counts by its same-file anchor, a skill's by a
 * path ending in `README.md`. A link is into the section when its anchor is
 * the section's or a block's slug, the anchor of a heading inside the
 * section, or a `step-<n>-…` anchor that resolves nowhere in the README (a
 * step anchor that resolves outside the section, such as the rollback's, is
 * not counted). Pure.
 */
function runbookLinkProblems(readme: string, texts: readonly [file: string, text: string][]): { checked: string[]; broken: string[] } {
  const range = sectionRange(readme, SWITCH_OVER_HEADING)
  const all = headings(readme)
  const anchors = headingAnchors(readme)
  const inside = range === undefined ? [] : anchors.filter((_, i) => all[i].line >= range.start && all[i].line < range.end)
  const named = [PHASE1_RUNBOOK_SECTION_TITLE, REFUSAL_BLOCK_HEADING, PUBLISHING_HOST_BLOCK_HEADING].map(headingSlug)
  const into = (anchor: string) =>
    named.includes(anchor) || inside.includes(anchor) || (/^step-\d+-/.test(anchor) && !anchors.includes(anchor))
  const links = texts.flatMap(([file, text]) =>
    markdownLinks(text)
      .filter((link) => (file === 'README.md' ? link.path === '' : /(?:^|\/)README\.md$/.test(link.path)) && into(link.anchor))
      .map((link) => ({ name: `${file} -> #${link.anchor}`, resolves: inside.includes(link.anchor) })),
  )
  return { checked: links.map((l) => l.name), broken: links.filter((l) => !l.resolves).map((l) => l.name) }
}

// ---------------------------------------------------------------------------
// The switch-over runbook (b.jg5 SRJ-1108; the E2-gate and E5 hatch notes)
// ---------------------------------------------------------------------------

/** `value` with every RegExp metacharacter escaped, so a pattern built around it matches it literally. */
function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** A short phrase, matched literally and case-insensitively in flattened text. */
function ci(phrase: string): RegExp {
  return new RegExp(escapeRegExp(phrase), 'i')
}

/** `text` as a Markdown code span. */
function code(text: string): string {
  return `\`${text}\``
}

/** The memoised answer of `build`, built at its first call (when a case runs, never at collection). */
function lazy<T>(build: () => T): () => T {
  let built: { value: T } | undefined
  return () => (built ??= { value: build() }).value
}

/**
 * agent-director vocabulary the runbook names and CSCB defines nowhere, each
 * row citing its source (HO: agent-director's handoff notes; ADSRD: its SRD).
 * Everything CSCB defines (versions, settings keys, defaults, minimums, the
 * margin, the verbs, the store path, titles, labels) is imported instead.
 * `ceiling <name>` rows are ADSRD SR-13.2's ceiling formulas as the runbook
 * lists them (b.jg5 SRJ-213), one per ceiling CSCB calls.
 */
const AD_VOCABULARY: Record<string, { text: string; source: string }> = {
  tmuxMinimum: { text: '3.2', source: 'HO rev 17: tmux 3.2 or later; b.jg5 SRJ-1108 step 1, SRJ-1103' },
  remainOnExit: { text: code('remain-on-exit'), source: 'HO rev 17: kept off; SRJ-1108 step 1' },
  baseIndex: { text: 'base-index', source: 'HO rev 17: agent-director depends on it not at all; SRJ-1108 step 1 names it not' },
  paneBaseIndex: { text: 'pane-base-index', source: 'HO rev 17; SRJ-1108 step 1 names it not' },
  hookIgnored: { text: code('ad.hook.ignored'), source: 'HO rev 24, rev 31: the event of a hook on a Claude Code too old for exec-form hooks' },
  noExecForm: { text: code('no_exec_form'), source: "HO rev 24, rev 31: that event's reason" },
  sessionStartCapSeconds: { text: '540', source: "HO rev 25; A-33: the cap on agent-director's SessionStart wait, in seconds" },
  waitMinutes: { text: '5', source: 'SRJ-1108 steps 4 and 6: the waits for a row to read `ended` or `missing`, in minutes' },
  sqliteBackup: { text: code('.backup'), source: "HO C15; SRJ-1108 step 8: sqlite3's online-consistent copy of the WAL-mode store" },
  migrationColumns: { text: 'thirteen', source: "HO rev 15: the columns Phase 1's schema migration adds" },
  storeMeta: { text: code('store_meta'), source: "HO rev 15: the one-row table holding the store's id" },
  configMalformed: { text: code('ErrConfigMalformed'), source: "HO §1; ADSRD SR-4.1: agent-director's answer to a malformed settings file" },
  expireAll: { text: code('--older-than 0d'), source: 'HO C6; SRJ-1108 step 11: never used' },
  'ceiling kill': { text: 'the larger of 2Q + 2A + E + 4W and 3Q + 2A + 5W', source: 'ADSRD SR-13.2; SRJ-213' },
  'ceiling read-pane': { text: '3Q + A + 4W', source: 'ADSRD SR-13.2; SRJ-213' },
  'ceiling send-keys': { text: '3Q + 2A + 5W', source: 'ADSRD SR-13.2; SRJ-213' },
  'ceiling pause': { text: `3Q + 2A + 5W, plus ${code(`[${AD_PAUSE_TABLE}] ${AD_PAUSE_TIMEOUT_KEY}`)} (times 1000)`, source: 'ADSRD SR-13.2; SRJ-213: with its configured wait' },
  [`ceiling ${AD_LAUNCH_CEILING_VERBS.join('/')}`]: { text: 'the larger of Q + C + 2A + 4W and 2Q + C + 3W', source: 'ADSRD SR-13.2; SRJ-213: the launch row' },
  'ceiling find-missing': { text: 'B + Q + W', source: 'ADSRD SR-13.2; SRJ-213: the sweep row' },
}

/** One vocabulary row's text; throws naming a key the table lacks. */
function vocab(key: string): string {
  const row = AD_VOCABULARY[key]
  if (row === undefined) throw new Error(`AD_VOCABULARY has no row "${key}"`)
  return row.text
}

/** Each ceiling CSCB calls, as the runbook names it: the launch row's three verbs as one name (AD_LAUNCH_CEILING_VERBS). */
const CSCB_CEILINGS: readonly string[] = [
  ...new Set(
    AD_CEILING_VERBS.filter((v) => v.cscbCalls).map((v) => (AD_LAUNCH_CEILING_VERBS.includes(v.verb) ? AD_LAUNCH_CEILING_VERBS.join('/') : v.verb)),
  ),
]

/** The verbs of the ceiling table CSCB never calls (`expire`). */
const UNCALLED_VERBS: readonly string[] = AD_CEILING_VERBS.filter((v) => !v.cscbCalls).map((v) => v.verb)

/** The three windows step 1 confirms (b.jg5 SRJ-209). */
const AD_WINDOWS: readonly AdTmuxKey[] = ['pending_grace_seconds', 'stopping_window_seconds', 'starting_session_seconds']

/** The switch-over runbook's step count (SRJ-1108: steps 1 to 11). */
const SWITCH_OVER_STEP_COUNT = 11

/** A runbook as one carrier holds it: its section body, its frame, its steps and its blocks' heading level. */
interface RunbookCarrier {
  /** The carrier's name in failures: the file and the section heading. */
  name: string
  /** The section's body, heading line excluded. */
  section: string
  /** The section's text before its first subsection, flattened. */
  frame: string
  /** Step n's text at index n - 1, flattened. */
  steps: string[]
  /** The anchor of step n's heading at index n - 1. */
  stepAnchors: string[]
  /** The level of the section's blocks and steps, one below its heading. */
  blockLevel: number
}

/**
 * The step reader: from a runbook section's body, step n's text (its heading
 * line excluded, up to the next heading of its level or higher, flattened
 * with `flat`) at index n - 1. Steps are headings at `stepLevel` whose title
 * starts with the helper's `Step <n>: ` form. Steps are read by number on
 * purpose: the SRD's contract is "steps 1 to 11 in order", so a step is found
 * by its number, never its title. Throws naming the carrier and the step when
 * a step is missing, duplicated, out of order or beyond `count`. It takes the
 * carrier's text, so the rollback section (9 steps) and the CHANGELOG copies
 * reuse it. Pure.
 */
function runbookSteps(carrier: string, section: string, stepLevel: number, count: number): { texts: string[]; titles: string[] } {
  const lines = section.split('\n')
  const hs = headings(section)
  const steps = hs.flatMap((h, i) => {
    const n = h.level === stepLevel ? stepNumberOf(h.title) : undefined
    return n === undefined ? [] : [{ n, i, h }]
  })
  for (let n = 1; n <= count; n++) {
    const found = steps.filter((s) => s.n === n).length
    if (found === 0) throw new Error(`${carrier}: step ${n} is missing (no "${'#'.repeat(stepLevel)} ${stepHeadingPrefix(n)}…" heading)`)
    if (found > 1) throw new Error(`${carrier}: step ${n} appears ${found} times`)
  }
  const extra = steps.find((s) => s.n < 1 || s.n > count)
  if (extra !== undefined) throw new Error(`${carrier}: step ${extra.n} is beyond the expected ${count} steps`)
  steps.forEach((s, k) => {
    if (s.n !== k + 1) throw new Error(`${carrier}: step ${s.n} is out of order (found where step ${k + 1} belongs)`)
  })
  return {
    titles: steps.map(({ h }) => h.title),
    texts: steps.map(({ i, h }) => {
      const next = hs.slice(i + 1).find((later) => later.level <= h.level)
      return flat(lines.slice(h.line + 1, next === undefined ? lines.length : next.line).join('\n')).trim()
    }),
  }
}

/** A runbook carrier read from `text` under `heading` (a section whose steps sit one level below it). Throws as the reader does. */
function readRunbookCarrier(file: string, text: string, heading: string, count: number): RunbookCarrier {
  const name = `${file} "${heading}"`
  const section = requiredSection(text, heading, file)
  const blockLevel = heading.indexOf(' ') + 1
  const lines = section.split('\n')
  const first = headings(section)[0]
  const { texts, titles } = runbookSteps(name, section, blockLevel, count)
  return {
    name,
    section,
    frame: flat(lines.slice(0, first === undefined ? lines.length : first.line).join('\n')).trim(),
    steps: texts,
    stepAnchors: titles.map(headingSlug),
    blockLevel,
  }
}

/** Every carrier of the switch-over runbook: its name and its reader. The CHANGELOG copy joins in b.jg5 E35 T3. */
const SWITCH_OVER_CARRIERS: [name: string, read: () => RunbookCarrier][] = [
  ['README.md', lazy(() => readRunbookCarrier('README.md', readRepoFile('README.md'), SWITCH_OVER_HEADING, SWITCH_OVER_STEP_COUNT))],
]

/** The numbered items with a bold lead (`1. **Lead.** …`) in a step's flattened text, each running to the next. */
function stepItems(stepText: string): { lead: string; text: string }[] {
  const starts = [...stepText.matchAll(/(?:^|\s)\d+\. \*\*([^*]+)\*\*/g)]
  return starts.map((m, k) => ({ lead: m[1], text: stepText.slice(m.index!, starts[k + 1]?.index ?? stepText.length).trim() }))
}

/**
 * The text an element row names: `frame`, `step <n>`, or `step <n> › <lead>`
 * for the one item of step n whose bold lead starts with `<lead>`
 * (case-insensitive). Throws naming the carrier, the step and the lead.
 */
function textAt(carrier: RunbookCarrier, where: string): string {
  if (where === 'frame') return carrier.frame
  const m = /^step (\d+)(?: › (.+))?$/.exec(where)
  if (m === null) throw new Error(`no such place in a runbook: ${where}`)
  const step = carrier.steps[Number(m[1]) - 1]
  if (step === undefined) throw new Error(`${carrier.name}: no step ${m[1]}`)
  if (m[2] === undefined) return step
  const lead = m[2].toLowerCase()
  const items = stepItems(step).filter((item) => item.lead.toLowerCase().startsWith(lead))
  if (items.length !== 1) throw new Error(`${carrier.name}, step ${m[1]}: ${items.length} items lead with "${m[2]}", expected 1`)
  return items[0].text
}

/** A required item: a code span, imported value or literal (as written), a case-insensitive phrase pattern, or a value read from the carrier. */
type Item = string | RegExp | ((carrier: RunbookCarrier) => string)

/** Each of `required` that `text` lacks, as text for the failure. */
function missingItems(carrier: RunbookCarrier, text: string, required: readonly Item[]): string[] {
  return required
    .map((item) => (typeof item === 'function' ? item(carrier) : item))
    .filter((item) => (typeof item === 'string' ? !text.includes(item) : !item.test(text)))
    .map(String)
}

/** A link to step n's heading in the carrier, as Markdown writes its target. */
const stepLink = (n: number) => (carrier: RunbookCarrier) => `(#${carrier.stepAnchors[n - 1]})`

/** `(operator action)`, the marker of each operator-only action (Runbook Markdown contract). */
const OPERATOR_ACTION = '(operator action)'

/**
 * One row per SRJ-1108 element: where it sits (`frame`, `step <n>` or
 * `step <n> › <item lead>`), the element, and the items its text must hold.
 * The `operator action` rows mark each operator-only action SRJ-1108 names
 * (C6, C7, C15, the §6 prompt, the host's autostart for CSCB) at its step.
 */
const SWITCH_OVER_ELEMENTS: [where: string, element: string, required: readonly Item[]][] = [
  // The section-level statements.
  ['frame', "the SRJ-1515 sentence: Phase 1 is installed together with this release, which changes no agent-director code, and both roll back together", [
    ci('requires agent-director Phase 1, installed on the host together with it; CSCB changes no agent-director code'),
    `rolled back together, by "${ROLLBACK_RUNBOOK_SECTION_TITLE}"`,
  ]],
  ['frame', `the old CSCB never runs against Phase 1 and the new one never against ${OLD_AD_VERSION}`, [
    ci('the old CSCB never runs against Phase 1'),
    ci(`the new one never against ${OLD_AD_VERSION}`),
  ]],
  ['frame', 'no bot server runs between step 3 and step 10', [ci('no bot server runs between step 3 and step 10')]],
  ['frame', 'no side-by-side install under another path is used', [ci('no side-by-side install under another path')]],
  ['frame', 'every agent and long-running agent-director process is stopped before each binary change and started after it (C15)', [
    ci(`every agent on the host, with every long-running agent-director process (${code('agent-director serve')} included), is stopped before either binary change and started again after it`),
  ]],
  ['frame', "the switch-over log is the operator's own record, and each step says what to record", [
    ci('the switch-over log is your own record'),
    ci('each step says what to record in it'),
  ]],
  ['frame', "commands run as the workers' user in the tmux environment step 1 pins", [
    ci("run every command as the workers' user"),
    ci('in the tmux environment step 1 pins'),
  ]],
  ['frame', 'operator-only actions are marked "operator action"', [ci('steps marked "operator action" are done by a human on the host')]],

  // Step 1, beforehand.
  ['step 1', 'beforehand, with the old CSCB running and still installed as the global package', [
    ci('beforehand, with the old CSCB running and still installed as the global package'),
  ]],
  ['step 1 › The go line', "the install-gate record's dated go line, the approval, written before the install; stop before anything goes down; the runbook never writes it", [
    ci("install-gate record has this host's dated go line"),
    ci('written before the Phase 1 install'),
    ci('the approval for the switch-over'),
    ci('stop here, before anything goes down'),
    ci('never writes the go line'),
  ]],
  ["step 1 › agent-director's version", `\`agent-director version\` in the launcher environment as the workers' user shows ${OLD_AD_VERSION}, the only supported starting point; stop before anything goes down; no command for an earlier version`, [
    code('agent-director version'),
    ci("in the bot server's launcher environment"),
    ci("as the workers' user"),
    ci(`shows ${OLD_AD_VERSION}, the only supported starting point`),
    ci('stop here, before anything goes down'),
    ci(`below ${CLIENT_MIN_VERSION}`),
    ci(`brings agent-director to ${OLD_AD_VERSION}, outside this runbook`),
    ci('names no command for it'),
  ]],
  ['step 1 › The tmux socket', 'the tmux socket pinned for the launcher, find-missing-loop.sh and the workers, checked from all three, one HOME, recorded', [
    code('find-missing-loop.sh'),
    code("tmux display-message -p '#{socket_path}'"),
    ci('all three print the same path'),
    ci('it is the pinned path'),
    `${code('TMUX_TMPDIR')} that names a missing path falls back silently to ${code('/tmp')}`,
    ci('the three share one HOME'),
    ci('record the result in the switch-over log'),
  ]],
  ['step 1 › The tmux socket', 'operator action: pinning the tmux socket (C7)', [OPERATOR_ACTION]],
  ['step 1 › tmux', `tmux ${vocab('tmuxMinimum')} or later with remain-on-exit off`, [
    ci(`tmux ${vocab('tmuxMinimum')} or later`),
    `${vocab('remainOnExit')} off`,
  ]],
  ['step 1 › Claude Code', `\`claude --version\` in the launcher environment, ${MIN_CLAUDE_CODE_VERSION} or later (MIN_CLAUDE_CODE_VERSION), the agent-director minimum and the fleet's version; stop before anything goes down`, [
    code('claude --version'),
    ci("in the bot server's launcher environment"),
    ci('the same user and `PATH` the server launches workers with'),
    `${MIN_CLAUDE_CODE_VERSION} or later`,
    ci('the minimum agent-director states for its exec-form hooks'),
    ci('the version the fleet runs'),
    ci(`older than ${MIN_CLAUDE_CODE_VERSION}, stop here, before anything goes down`),
  ]],
  ['step 1 › Claude Code', 'a Claude Code too old for exec-form hooks: ad.hook.ignored with no_exec_form, every launch pending', [
    ci('too old for exec-form hooks'),
    `${vocab('hookIgnored')} with the reason ${vocab('noExecForm')}`,
    ci('every launch stays `pending`'),
  ]],
  ["step 1 › agent-director's timing settings", `all nine [${AD_TMUX_TABLE}] keys of ~/${AD_SETTINGS_RELATIVE_PATH} and [${AD_PAUSE_TABLE}] ${AD_PAUSE_TIMEOUT_KEY} (its default), effective values recorded`, [
    ci('all nine keys of the'),
    code(`[${AD_TMUX_TABLE}]`),
    code(`~/${AD_SETTINGS_RELATIVE_PATH}`),
    ci('a missing file, a missing key or `0` means the default'),
    `${code(`[${AD_PAUSE_TABLE}] ${AD_PAUSE_TIMEOUT_KEY}`)} (${DEFAULT_AD_SETTINGS.pause.timeout_seconds} s when the file or the key is missing)`,
    ci('record the effective values in the switch-over log'),
  ]],
  ['step 1', `the nine [${AD_TMUX_TABLE}] keys are each named`, AD_TMUX_KEYS.map(code)],
  ["step 1 › agent-director's timing settings", 'the three windows are the intended values, each at or above its minimum', [
    ci('the three windows'),
    ...AD_WINDOWS.map(code),
    ci('are the values you intend'),
    ci('at or above its minimum'),
    `${code('starting_session_seconds')} ${AD_SETTING_MINIMUMS.starting_session_seconds}`,
    `${code('stopping_window_seconds')} ${AD_SETTING_MINIMUMS.stopping_window_seconds}`,
    `the larger of ${AD_SETTING_MINIMUMS.pending_grace_seconds.floor} and`,
    `/ 1000⌉ + ${AD_SETTING_MINIMUMS.pending_grace_seconds.addend}`,
  ]],
  ["step 1 › agent-director's timing settings", `a pending_grace_seconds above ${vocab('sessionStartCapSeconds')} s shortens the SessionStart wait to ${vocab('sessionStartCapSeconds')} s`, [
    ci(`${code('pending_grace_seconds')} above ${vocab('sessionStartCapSeconds')} s shortens agent-director's SessionStart wait to ${vocab('sessionStartCapSeconds')} s`),
  ]],
  ['step 1 › The call timeout', `the staged agent_director_call_timeout_ms (${DEFAULT_AGENT_DIRECTOR_CALL_TIMEOUT_MS} when left out) exceeds the largest ceiling CSCB calls plus the margin, from the host's values; the need recorded`, [
    ci("always computing from this host's values"),
    code('agent_director_call_timeout_ms'),
    `${code(String(DEFAULT_AGENT_DIRECTOR_CALL_TIMEOUT_MS))} when it leaves the setting out`,
    ci('the largest ceiling among the verbs CSCB calls'),
    `plus the ${AD_CALL_TIMEOUT_NEED_MARGIN_MS / 1000n} s margin (${AD_CALL_TIMEOUT_NEED_MARGIN_MS} ms)`,
    ci('record the computed need in the switch-over log'),
  ]],
  ['step 1 › The call timeout', "the ceiling formulas, one per ceiling CSCB calls, pause's with its wait", CSCB_CEILINGS.map(
    (name) => new RegExp(`${escapeRegExp(code(name))}[^:;]*: ${escapeRegExp(vocab(`ceiling ${name}`))}[;.]`),
  )],
  ['step 1 › The call timeout', "the formulas' letters name the host's settings", [
    ci("with Q, A, C, W and E the host's"),
    ...(['query_timeout_ms', 'action_timeout_ms', 'create_timeout_ms', 'pipe_close_wait_ms', 'kill_exit_wait_ms', 'sweep_budget_seconds'] satisfies AdTmuxKey[]).map(code),
  ]],
  ['step 1 › The call timeout', 'the verbs CSCB never calls set no ceiling', UNCALLED_VERBS.map((verb) => ci(`${code(verb)} is not among them`))],
  ['step 1 › Leftover sessions', "tmux ls against agent-director list, as the workers' user on the pinned socket; every slack_bot_ session no row names recorded", [
    ci("as the workers' user, on the pinned socket"),
    `compare ${code('tmux ls')} with ${code('agent-director list')}`,
    ci('record in the switch-over log every `slack_bot_` session that no row names'),
  ]],
  ['step 1 › Stage the new release', "the release staged, not installed: its exact version recorded; the persona configuration in a separate file; the Slack apps; step 3's stop is the old version's own", [
    ci('choose its exact version, record it in the switch-over log'),
    ci('available to install'),
    ci('persona configuration, with `agent_director_call_timeout_ms`, in a separate file, never `config.json`, which the old CSCB reads'),
    ci('prepare the Slack apps'),
    ci("nothing is installed over the global package yet, so step 3's `stop --stop-bots` is the old version's own and reads the old, pre-persona `config.json`"),
  ]],
  ['step 1 › Copies for rollback', "copies of the pre-persona config.json, the crontable, the /interject callers, access.json and the Slack token environment variables", [
    ci('keep copies of the pre-persona `config.json`, the crontable, the `/interject` callers'),
    ci("the host crontab's `curl` lines included"),
    code('access.json'),
    ci('the Slack token environment variables the old CSCB uses'),
  ]],
  ['step 1 › Copies for rollback', "the old CSCB's exact version recorded in the switch-over log", [ci("record the old CSCB's exact version in the switch-over log")]],
  ['step 1 › The orchestrator prompt', 'the §6 "ship now" wording may go out any time before', [ci('"ship now" wording may go out any time before')]],
  ['step 1 › The orchestrator prompt', 'operator action: the §6 "ship now" wording', [OPERATOR_ACTION]],

  // Steps 2 to 11.
  ['step 2', "the host's autostart for CSCB disabled until step 10", [ci("disable the host's autostart for CSCB until step 10")]],
  ['step 2', "operator action: disabling the host's autostart for CSCB", [ci(`autostart for CSCB until step 10 ${OPERATOR_ACTION}`)]],
  ['step 3', "the old CSCB's own stop --stop-bots, reading the old, pre-persona config.json", [
    'claude-slack-channel-bots stop --stop-bots',
    ci("the old version's own `stop --stop-bots`, which reads the old, pre-persona `config.json`"),
    ci('nothing new is installed before step 7'),
  ]],
  ['step 3', 'an operator arriving from a startup refusal has first reinstalled the previous CSCB', [
    ci('an operator arriving from a startup refusal has first reinstalled the previous CSCB'),
    `(#${headingSlug(REFUSAL_BLOCK_HEADING)})`,
  ]],
  ['step 4', `agent-director find-missing, then at most ${vocab('waitMinutes')} minutes for every service=cscb row to read ended or missing`, [
    code('agent-director find-missing'),
    ci(`wait at most ${vocab('waitMinutes')} minutes for every \`service=cscb\` row to read \`ended\` or \`missing\``),
  ]],
  ['step 5', "a read-only tmux ls as the workers' user on the pinned socket, for old sessions and live old rows (C17)", [
    ci("as the workers' user, on the socket pinned in step 1, run a read-only `tmux ls`"),
    code('slack_bot_<name>_<channel>'),
    code('slack_bot_<channel ID>'),
    ci('any live old row'),
  ]],
  ['step 5', 'a leftover with a row is ended in step 6, before the Phase 1 install', [/a leftover with a row\W+\(live or finished\) is ended in step 6, before the Phase 1 install/i]],
  ['step 5', "a leftover with no row whose name cannot equal a persona's slack_bot_<key> is recorded and the switch-over goes on", [
    /a leftover with no row, whose name cannot equal any new persona's `slack_bot_<key>`/i,
    ci('record it in the switch-over log and go on'),
    ci('agent-director matches session names exactly'),
    ci('you may end it later with the exact-name `tmux kill-session -t =<name>`'),
  ]],
  ['step 5', "a leftover with no row whose name equals a persona's slack_bot_<key>: windows noted, ended by exact name, the gone check", [
    /a leftover with no row, whose name equals a new persona's `slack_bot_<key>`/i,
    ci('note its window ids with a read-only `tmux list-windows -t =<name>`'),
    ci('end it with the exact-name `tmux kill-session -t =<name>`'),
    ci('make the gone check'),
  ]],
  ['step 5', 'the gone check: tmux ls without the session and tmux list-windows -a without its windows', [
    /the gone check\W+as the workers' user on the pinned socket/i,
    ci('a read-only `tmux ls` no longer shows the session'),
    ci('a read-only `tmux list-windows -a` shows none of its windows in any other session'),
    ci('a grouped session or a linked window keeps the worker running'),
  ]],
  ['step 6', `only for a leftover with a row, ended with the still-installed ${OLD_AD_VERSION} binary, with the reason (no flag named)`, [
    ci('only if step 5 found a leftover with a row'),
    ci(`with the still-installed ${OLD_AD_VERSION} binary`),
    ci('no launch token or recorded socket'),
    ci("Phase 1's `kill` fails closed on it"),
    ci("not even agent-director's option for a finished row ends its session"),
  ]],
  ['step 6', 'kill by instance id, the gone check, the exact-name kill if anything remains, find-missing until ended or missing', [
    ci("note the session's window ids"),
    code('agent-director kill --claude-instance-id <id>'),
    ci('then make the gone check'),
    ci('if the session or one of its windows remains, end the session with the exact-name `tmux kill-session -t =<name>`, and make the gone check again'),
    ci(`\`agent-director find-missing\` until the row reads \`ended\` or \`missing\`, for at most ${vocab('waitMinutes')} minutes`),
  ]],
  ['step 6', 'a leftover that cannot be ended means no Phase 1 install: step 8\'s "no go", investigated by session name', [
    ci('a leftover that cannot be ended this way means no Phase 1 install'),
    ci('step 8\'s "no go" branch'),
    code('agent-director list --tmux-session-name <name>'),
  ]],
  ['step 7', 'the staged package installed over the global install without starting it; autostart still disabled', [
    ci('install the staged package over the global install, without starting it'),
    ci('the autostart stays disabled from step 2'),
  ]],
  ['step 7', 'the persona configuration in place, credentials files written, crontable targets and /interject callers rewritten', [
    ci('put the persona configuration in place as `config.json`'),
    ci("write each persona's credentials file with the new CLI"),
    ci('rewrite crontable targets and `/interject` callers to name personas'),
  ]],
  ['step 7', `the new install check passes on the still-installed ${OLD_AD_VERSION} with its note`, [
    ci('install check'),
    ci(`passes on the still-installed ${OLD_AD_VERSION}, with its note`),
  ]],
  ['step 7', 'from this step the new CSCB is deployed but not started', [ci('from this step the new CSCB is deployed but not started')]],
  ['step 8', "the install-gate record's dated go line confirmed", [ci("confirm that the install-gate record has this host's dated go line")]],
  ['step 8', `"no go": no Phase 1 install; the previous CSCB back with step 1's files, started on ${OLD_AD_VERSION}, autostart re-enabled, the stopped agents started again; the runbook stops`, [
    ci('if it does not, there is no Phase 1 install'),
    ci('with the `config.json`, crontable, `/interject` callers, `access.json` and Slack token environment variables saved in step 1'),
    ci(`start it on ${OLD_AD_VERSION} and re-enable its autostart`),
    ci(`every other agent this step already stopped is started again on ${OLD_AD_VERSION} by its owner`),
    ci('the runbook stops there'),
  ]],
  ['step 8', '"no go" reinstalls the previous CSCB at the version step 1 recorded', [ci('reinstall the previous CSCB, the version step 1 recorded')]],
  ['step 8', 'operator action: the agents "no go" stopped are started again by their owners (C15)', [ci(`started again on ${OLD_AD_VERSION} by its owner ${OPERATOR_ACTION}`)]],
  ['step 8', `operator action: "no go" starting the previous CSCB on ${OLD_AD_VERSION} and re-enabling its autostart`, [ci(`start it on ${OLD_AD_VERSION} and re-enable its autostart ${OPERATOR_ACTION}`)]],
  ['step 8', 'every other agent stopped before the install, checked with agent-director list and tmux ls and recorded; one that cannot be stopped means "no go"', [
    ci('before the install, stop every other agent on the host'),
    ci("orchestrators' workers, hand-started sessions and sessions with an `agent-director serve`"),
    ci("confirm with `agent-director list` that each stopped agent's row reads `ended` or `missing`"),
    ci(`a row that ${OLD_AD_VERSION} left stuck live for a dead agent is expected`),
    ci('a read-only `tmux ls` that no agent session is left'),
    ci('record it in the switch-over log'),
    ci('an agent that cannot be stopped means "no go"'),
  ]],
  ['step 8 › Stop every other agent', 'operator action: stopping every other agent before the install (C15)', [OPERATOR_ACTION]],
  ['step 8', `the store backed up with sqlite3's ${vocab('sqliteBackup')}, for disaster recovery only, not the rollback path`, [
    code(DEFAULT_STORE_PATH),
    ci('online-consistent copy'),
    ci(`sqlite3's ${vocab('sqliteBackup')}`),
    ci('not a plain file copy, because the store runs in WAL mode'),
    ci('for disaster recovery only'),
    ci('not the rollback path'),
  ]],
  ['step 8', `agent-director Phase 1 installed: ${vocab('migrationColumns')} columns and ${vocab('storeMeta')}; agent-director version shows the Phase 1 version`, [
    ci(`schema migration adds ${vocab('migrationColumns')} columns and the one-row ${vocab('storeMeta')} table, which holds the store's id`),
    ci('confirm that `agent-director version` shows the Phase 1 version'),
  ]],
  ['step 8', `non-default [${AD_TMUX_TABLE}] values written right after the install, before the restarts and the new CSCB's start`, [
    ci('right after the install, before the restarts that follow and so before the new CSCB starts'),
    ci(`write any non-default ${code(`[${AD_TMUX_TABLE}]`)} values you want into ${code(`~/${AD_SETTINGS_RELATIVE_PATH}`)}`),
    ci('a long-running agent-director process reads the file only when it starts'),
  ]],
  ['step 8', 'every agent-director serve and other long-running process restarted, none older than the install, recorded', [
    ci('restart every `agent-director serve` process and every other long-running agent-director process still running'),
    ci('compare process start times to confirm that none is older than the install'),
    ci('record the version and that result in the switch-over log'),
  ]],
  ['step 8 › Restart `serve`', 'operator action: restarting serve and the other long-running processes (C15)', [OPERATOR_ACTION]],
  ['step 8', `the settings read and confirmed again, the call timeout raised if the need grew, agent-director list without ${vocab('configMalformed')}`, [
    ci(`read the nine timing settings and ${code(`[${AD_PAUSE_TABLE}] ${AD_PAUSE_TIMEOUT_KEY}`)} again as in step 1`),
    ci('record the effective values'),
    ci('confirm them and the call timeout as in step 1'),
    ci('raise `agent_director_call_timeout_ms` in `config.json` before step 10'),
    ci(`confirm that \`agent-director list\` answers without ${vocab('configMalformed')}`),
  ]],
  ['step 9', 'every other agent started again by its owner, its serve processes on the Phase 1 binary', [
    ci('every other agent on the host is started again by its owner'),
    ci('which also starts its `serve` processes on the Phase 1 binary'),
  ]],
  ['step 9', 'operator action: the other agents started again by their owners (C15)', [ci(`started again by its owner ${OPERATOR_ACTION}`)]],
  ['step 10 › The orchestrator prompt', 'the shared orchestrator prompt and its source copy change worker cleanup to "kill, then leave the row" before the new CSCB starts', [
    code('~/.claude/channels/slack/system-prompt.md'),
    code('~/projects/horde_admin/cscb_system_prompt.md'),
    ci('from row-delete cleanup to "kill, then leave the row"'),
    ci('before the new CSCB starts'),
    ci('in the same deploy as agent-director Phase 1'),
    ci(`kill-then-leave works on ${OLD_AD_VERSION} too, so a rollback does not revert it`),
  ]],
  ['step 10 › The orchestrator prompt', "operator action: the orchestrator prompt's worker cleanup", [OPERATOR_ACTION]],
  ['step 10 › Start the new CSCB', "the new CSCB started, then the host's autostart for CSCB re-enabled", [
    'claude-slack-channel-bots start',
    ci("then re-enable the host's autostart for CSCB"),
  ]],
  ['step 10 › Start the new CSCB', "operator action: re-enabling the host's autostart for CSCB", [ci(`autostart for CSCB ${OPERATOR_ACTION}`)]],
  ['step 10', 'each persona starts fresh once; pre-persona rows are kept and never resumed', [
    ci('each persona starts fresh once'),
    ci('pre-persona rows are kept and never resumed'),
  ]],
  ['step 10 › The post-install check', 'once every agent is started again, every pending row shows launch_started_at; recorded in the log and as the dated post-install check line; a row without one held', [
    ci('once every agent has been started again'),
    code('agent-director list --state pending'),
    ci('shows a `launch_started_at` on every row'),
    ci('record the result in the switch-over log'),
    ci("as this host's dated post-install check line in agent-director's install-gate record"),
    ci("a row without one is a human's to look at"),
    ci('the persona whose row it is is held'),
  ]],
  ['step 10 › The post-install check', 'operator action: the post-install check line (C15)', [OPERATOR_ACTION]],
  ['step 11', `a daily agent-director expire at the default retention, never ${vocab('expireAll')}, as the workers' user in the pinned tmux environment`, [
    ci(`schedule a daily \`agent-director expire\` at the default retention, never ${vocab('expireAll')}`),
    ci("as the workers' user in the tmux environment step 1 pinned"),
  ]],
  ['step 11', 'operator action: scheduling the daily expire (C6)', [ci(`step 1 pinned ${OPERATOR_ACTION}`)]],
  ['step 11', "the daily expire goes into the host's sweep loop, find-missing-loop.sh", [
    ci("add it to the host's sweep loop, `~/startup/find-missing-loop.sh`"),
    ci('nothing on the host runs `expire` before this step'),
  ]],
  ['step 11', 'the §6 "hold until after" wording goes out then', [ci('"hold until after" wording goes out now')]],
  ['step 11', 'operator action: the §6 "hold until after" wording', [ci(`goes out now ${OPERATOR_ACTION}`)]],
]

/** One carrier's place, for the cases that run over every carrier. */
const overCarriers = <T extends readonly unknown[]>(rows: readonly T[]) =>
  SWITCH_OVER_CARRIERS.flatMap(([name, read]) => rows.map((row) => [name, ...row, read] as const))

/**
 * Ruling C-1 (b.jg5 SRJ-1108): the backticked agent-director command lines a
 * runbook text may carry where `UPGRADE_FORMS` applies, each removed exactly
 * (that span, as written) before the forms are applied; any other backticked
 * agent-director command line there still fails. No pattern is narrowed.
 */
const RUNBOOK_COMMAND_SPANS: Record<'refusal block' | "step 1's version item", string> = {
  'refusal block': code('agent-director serve'),
  "step 1's version item": code('agent-director version'),
}

/** `text` without the one command span ruling C-1 allows in `where`. */
function withoutAllowedSpan(text: string, where: keyof typeof RUNBOOK_COMMAND_SPANS): string {
  return text.split(RUNBOOK_COMMAND_SPANS[where]).join('')
}

/** The labels of the `UPGRADE_FORMS` rows that match `text`. */
function upgradeFormsIn(text: string): string[] {
  return UPGRADE_FORMS.filter(([, pattern]) => pattern.test(text)).map(([label]) => label)
}

/** The refusal block's raw text, under the helper's heading one level below the section. */
function refusalBlock(carrier: RunbookCarrier): string {
  return requiredSection(carrier.section, `${'#'.repeat(carrier.blockLevel)} ${REFUSAL_BLOCK_HEADING}`, carrier.name)
}

/** The publishing-host block's flattened text, under the helper's heading one level below the section. */
function publishingHostBlock(carrier: RunbookCarrier): string {
  return flat(requiredSection(carrier.section, `${'#'.repeat(carrier.blockLevel)} ${PUBLISHING_HOST_BLOCK_HEADING}`, carrier.name)).trim()
}

/** A block's parts, raw: the text before its first bold-led paragraph, then each paragraph led by `**…**` with what follows it. */
function blockParts(block: string): string[] {
  const parts: string[][] = [[]]
  for (const line of block.split('\n')) {
    if (line.startsWith('**')) parts.push([])
    parts[parts.length - 1].push(line)
  }
  return parts.map((lines) => lines.join('\n'))
}

/** The one part of the refusal block, flattened, that matches `anchor`; throws naming the carrier unless exactly one does. */
function refusalPart(carrier: RunbookCarrier, anchor: RegExp): string {
  const parts = blockParts(refusalBlock(carrier)).map((part) => flat(part).trim()).filter((part) => anchor.test(part))
  if (parts.length !== 1) throw new Error(`${carrier.name}, "${REFUSAL_BLOCK_HEADING}": ${parts.length} parts match ${String(anchor)}, expected 1`)
  return parts[0]
}

/** The numbered items (`1. …`, with indented continuation lines) of the refusal block's first part, the ordered list, flattened. */
function refusalOrderItems(carrier: RunbookCarrier): { n: number; text: string }[] {
  const items: { n: number; lines: string[] }[] = []
  for (const line of blockParts(refusalBlock(carrier))[0].split('\n')) {
    const start = /^(\d+)\. /.exec(line)
    if (start !== null) items.push({ n: Number(start[1]), lines: [line] })
    else if (items.length > 0 && /^\s+\S/.test(line)) items[items.length - 1].lines.push(line)
  }
  return items.map(({ n, lines }) => ({ n, text: flat(lines.join('\n')).trim() }))
}

/**
 * The refusal block's ordered elements (SRJ-1108; hatch A3), each with the
 * pattern that finds its list item and the items it must hold. The block acts
 * in this order, so the four are items 1 to 4 of its list.
 */
const REFUSAL_ORDER: [element: string, anchor: RegExp, required: readonly Item[]][] = [
  ["a persona-form config.json with no pre-persona copy: a stop that changes nothing, rollback step 8's rebuild, then the block again from its start", ci('`config.json` is in persona form'), [
    ci("no pre-persona copy of it exists, neither step 1's copy nor one you kept elsewhere"),
    ci('stop here and change nothing'),
    ci('no reinstall, no start and no step 1'),
    `step 8 of "${ROLLBACK_RUNBOOK_SECTION_TITLE}"`,
    ci('follow this block again from its start'),
  ]],
  ["otherwise: the crontable targets and /interject callers rebuilt by hand, then the previous CSCB reinstalled from step 1's files and started, autostart re-enabled", ci('first rebuild by hand'), [
    `step 8 of "${ROLLBACK_RUNBOOK_SECTION_TITLE}"`,
    ci("the crontable targets and `/interject` callers that the conversion to personas left in persona form where step 1's copy of them is missing"),
    ci('reinstall the previous CSCB, the version step 1 recorded or else the version the host ran before'),
    ci('`access.json` and Slack token environment variables'),
    ci("from step 1's files, or a pre-persona copy of `config.json` you kept, where they exist, and otherwise from those still in place"),
    ci("re-enabling the host's autostart for CSCB if it was disabled"),
  ]],
  [`then, under either class, agent-director brought to ${OLD_AD_VERSION} outside the runbook, with no command`, ci(`if agent-director is not ${OLD_AD_VERSION}`), [
    `below ${CLIENT_MIN_VERSION} under ${code(AD_SYSTEM_INSTALL_TOO_OLD)}`,
    ci(`under ${code(AD_BELOW_PHASE1_FLOOR)}`),
    ci(`bring it to ${OLD_AD_VERSION} outside this runbook`),
    ci('gives no command for it'),
  ]],
  ['then the runbook from step 1, by a link to its heading', ci('start the runbook at'), [stepLink(1)]],
]

/** The refusal block's branches and pointers after its ordered list (SRJ-1108; hatch A3), each found by the part it sits in. */
const REFUSAL_BRANCHES: [element: string, part: RegExp, required: readonly Item[]][] = [
  ["a refusal after Phase 1 was installed: at step 10 or any later start of the new CSCB, on a host whose Phase 1 install was step 8's or a publishing host's own, and only it", ci('a refusal at step 10'), [
    ci('installing agent-director Phase 1 migrates agent-director\'s store'),
    ci('a refusal at step 10, or at any later start of the new CSCB'),
    `an autostart, ${code('clean_restart')} or the restart in step 4 of "${ROLLBACK_RUNBOOK_SECTION_TITLE}" included`,
    ci("whose Phase 1 install was step 8's or agent-director's own install on a publishing host"),
    ci('the server finds the wrong agent-director binary'),
    ci('for that refusal, and only for it'),
  ]],
  ["the binary check: the lookup order, then `<path> version` on the startup-errors entry's path, as the workers' user in the launcher environment", ci('a refusal at step 10'), [
    `${code('$HOME/.agent-director/bin/agent-director')} first, then the first ${code('agent-director')} on ${code('PATH')}`,
    ci('the binary path the startup-errors entry names'),
    code('<path> version'),
    ci("as the workers' user in the bot server's launcher environment"),
  ]],
  ['put Phase 1 back, with every agent and long-running process stopped around the change and CSCB bots stopped through "Operator actions", then start the new CSCB as step 10 does; or follow the rollback', ci('a refusal at step 10'), [
    ci('put agent-director Phase 1 back as the binary the server finds'),
    `follow "${ROLLBACK_RUNBOOK_SECTION_TITLE}", which starts the previous CSCB`,
    ci(`stop every agent on the host and every long-running agent-director process (${code('agent-director serve')} included) before that binary change, and start them again after it`),
    '"Stopping a set of agents before a binary change"',
    `"Operator actions" section of agent-director's README`,
    ci('once the server finds Phase 1, start the new CSCB as'),
    stepLink(10),
  ]],
  ['the old CSCB is never reinstalled onto the migrated store', ci('a refusal at step 10'), [ci('never reinstall the old CSCB onto the migrated store')]],
  ["at rollback step 4's restart with an agent still running: nothing put back, no rollback rerun, the new CSCB stopped until agent-director has dealt with it", ci('a refusal at step 10'), [
    ci(`at the restart in step 4 of "${ROLLBACK_RUNBOOK_SECTION_TITLE}", an agent that could not be stopped still runs`),
    ci('put nothing back'),
    ci("don't follow the rollback again"),
    ci('the new CSCB stays stopped until agent-director has dealt with that agent'),
    ci('then this branch applies'),
  ]],
  ['Phase 1 installed any other way outside the runbook: not a target; the rollback runbook and "Operator actions"', ci('installed in any other way outside this runbook'), [
    ci('installed in any other way outside this runbook is not a target of this runbook'),
    ci(`follow "${ROLLBACK_RUNBOOK_SECTION_TITLE}"`),
    '"agent-director was installed outside the caller\'s switch-over"',
    '"Operator actions"',
  ]],
  ['a stop by the runtime re-check: not a switch-over case; the debugging skill instead', ci('runtime re-check'), [
    ci('not a switch-over case'),
    `(${DEBUG_SKILL_FILE}#`,
  ]],
]

/** The publishing-host block's elements (SRJ-1108; the E5 hatch note; hatch A3). */
const PUBLISHING_HOST_ELEMENTS: [element: string, required: readonly Item[]][] = [
  [`/publish needs an agent-director binary the client accepts (${CLIENT_MIN_VERSION} or later)`, [
    ci('`/publish` checks that the publishing host has an agent-director binary the client accepts'),
    ci(`${CLIENT_MIN_VERSION}, the client's minimum, or later`),
  ]],
  ['publish from a host that already passes that check', [ci('publish from a host that already passes that check')]],
  ["a host with no agent-director installs Phase 1 by agent-director's own install, then publishes", [
    ci("a host with no agent-director installs agent-director's Phase 1 release by agent-director's own install, then publishes"),
    ci('no agents and nothing to back up'),
  ]],
  [`a host below the client's minimum publishes from another host, is not a target, and brings agent-director to ${OLD_AD_VERSION} first outside the runbook, with no command`, [
    ci(`a host below the client's minimum (${CLIENT_MIN_VERSION}) publishes from another host`),
    ci('is not a target of this runbook'),
    ci(`brings agent-director to ${OLD_AD_VERSION} first, outside this runbook, since step 1 stops on any version but ${OLD_AD_VERSION}`),
    ci('gives no command for it'),
  ]],
  ['a publishing host needs no install-gate go line', [ci('a publishing host needs no install-gate go line')]],
]

describe(`the switch-over runbook, "${PHASE1_RUNBOOK_SECTION_TITLE}" (b.jg5 SRJ-1108)`, () => {
  describe('the step reader (self-checks, in memory)', () => {
    const section = (...numbers: number[]) => numbers.map((n) => `#### ${stepHeadingPrefix(n)}Do ${n}\nBody ${n}.`).join('\n')

    test('steps 1 to n in order are read by number, each without its heading line', () => {
      expect(runbookSteps('fixture', section(1, 2, 3), 4, 3).texts).toEqual(['Body 1.', 'Body 2.', 'Body 3.'])
    })

    test.each([
      ['missing', section(1, 3), 3, 'fixture: step 2 is missing'],
      ['duplicated', section(1, 2, 2, 3), 3, 'fixture: step 2 appears 2 times'],
      ['out of order', section(1, 3, 2), 3, 'fixture: step 3 is out of order'],
      ['beyond the count', section(1, 2, 3, 4), 3, 'fixture: step 4 is beyond the expected 3 steps'],
      ['at another level', section(1, 2).replace('#### Step 2', '##### Step 2'), 2, 'fixture: step 2 is missing'],
    ])('a step %s throws naming the step', (_how, text, count, message) => {
      expect(() => runbookSteps('fixture', text, 4, count)).toThrow(message)
    })

    test("a step's text keeps its lower headings and stops at the next heading of its level or higher", () => {
      const text = `#### ${stepHeadingPrefix(1)}A\none\n##### Detail\ninner\n#### Other block\nafter\n#### ${stepHeadingPrefix(2)}B\ntwo\n### Next section\nout`
      expect(runbookSteps('fixture', text, 4, 2).texts).toEqual(['one ##### Detail inner', 'two'])
    })

    test.each(Array.from({ length: SWITCH_OVER_STEP_COUNT }, (_, i) => i + 1))("the helper's step form reads back step %d", (n) => {
      expect(stepNumberOf(`${stepHeadingPrefix(n)}Title`)).toBe(n)
    })

    test.each([REFUSAL_BLOCK_HEADING, PUBLISHING_HOST_BLOCK_HEADING, 'Step 1 Title', 'Step 01: Title', 'Steps 1: Title', 'Step 1: ', 'Step one: Title'])(
      "the helper's step form rejects %p",
      (title) => {
        expect(stepNumberOf(title)).toBeUndefined()
      },
    )
  })

  test('the vocabulary table has a ceiling formula for exactly the ceilings CSCB calls', () => {
    const rows = Object.keys(AD_VOCABULARY).filter((key) => key.startsWith('ceiling ')).map((key) => key.slice('ceiling '.length))
    expect(rows.sort()).toEqual([...CSCB_CEILINGS].sort())
  })

  test.each(overCarriers(SWITCH_OVER_ELEMENTS))('%s, %s: %s', (carrierName, where, element, required, read) => {
    const carrier = read()
    expect({ carrier: carrierName, where, element, missing: missingItems(carrier, textAt(carrier, where), required) }).toEqual({
      carrier: carrierName,
      where,
      element,
      missing: [],
    })
  })

  describe('negative and order checks', () => {
    test.each(overCarriers([[vocab('baseIndex')], [vocab('paneBaseIndex')]] as const))('%s: step 1 does not name %s', (_name, term, read) => {
      expect(read().steps[0]).not.toContain(term)
    })

    test.each(SWITCH_OVER_CARRIERS)("%s: step 1's version check comes right after the go-line item, before anything else", (_name, read) => {
      const items = stepItems(read().steps[0])
      expect(items.findIndex((item) => item.text.includes('dated go line'))).toBe(0)
      expect(items.findIndex((item) => item.text.includes(code('agent-director version')))).toBe(1)
    })

    test.each(overCarriers(UPGRADE_FORMS.map(([label, pattern]) => [label, pattern] as const)))(
      "%s: step 1's version item carries no %s once its `agent-director version` span is removed (ruling C-1)",
      (_name, _label, pattern, read) => {
        expect(withoutAllowedSpan(textAt(read(), "step 1 › agent-director's version"), "step 1's version item")).not.toMatch(pattern)
      },
    )

    test.each(SWITCH_OVER_CARRIERS)('%s: step 8 confirms the go line, stops the agents, backs up, installs, writes [tmux] and restarts serve, in that order', (_name, read) => {
      const step = read().steps[7]
      const order = [
        ci("this host's dated go line"),
        ci('stop every other agent on the host'),
        ci(vocab('sqliteBackup')),
        ci('schema migration adds'),
        ci(`write any non-default ${code(`[${AD_TMUX_TABLE}]`)} values`),
        ci('restart every `agent-director serve` process'),
      ].map((pattern) => step.search(pattern))
      expect(order.filter((at) => at < 0)).toEqual([])
      expect(order).toEqual([...order].sort((a, b) => a - b))
    })

    test.each(SWITCH_OVER_CARRIERS)('%s: step 10 changes the orchestrator prompt, starts the new CSCB, then re-enables the autostart, in that order', (_name, read) => {
      const step = read().steps[9]
      const order = [ci('"kill, then leave the row"'), ci('start the new CSCB'), ci("re-enable the host's autostart for CSCB")].map((pattern) => step.search(pattern))
      expect(order.filter((at) => at < 0)).toEqual([])
      expect(order).toEqual([...order].sort((a, b) => a - b))
    })

    test.each(SWITCH_OVER_CARRIERS)('%s: inside the section, `tmux kill-session` appears only in steps 5 and 6, always as `-t =` (SRJ-1101)', (_name, read) => {
      const carrier = read()
      const count = (text: string, pattern: RegExp) => [...text.matchAll(pattern)].length
      const outside = carrier.steps.flatMap((text, i) => (i + 1 === 5 || i + 1 === 6 || count(text, /tmux kill-session/g) === 0 ? [] : [`step ${i + 1}`]))
      expect(outside).toEqual([])
      const section = flat(carrier.section)
      expect(count(section, /tmux kill-session/g)).toBe(count(carrier.steps[4] + carrier.steps[5], /tmux kill-session/g))
      expect(count(section, /tmux kill-session -t =/g)).toBe(count(section, /tmux kill-session/g))
      expect(count(section, /tmux kill-session/g)).toBeGreaterThan(0)
    })

    test.each(SWITCH_OVER_CARRIERS)('%s: the section never names include-finished, nor agent-director delete (SRJ-1101)', (_name, read) => {
      const section = flat(read().section)
      expect(section).not.toMatch(/include-finished/)
      expect(section).not.toMatch(/agent-director delete\b/)
    })
  })

  describe(`the "${REFUSAL_BLOCK_HEADING}" block (E2 gate; hatch A3)`, () => {
    test.each(SWITCH_OVER_CARRIERS)("%s: the helper's heading is the section's first subsection, one level below it, before step 1", (_name, read) => {
      const carrier = read()
      const [first] = headings(carrier.section)
      expect(first?.text).toBe(`${'#'.repeat(carrier.blockLevel)} ${REFUSAL_BLOCK_HEADING}`)
    })

    test.each(overCarriers(REFUSAL_LABELS.map((label) => [label] as const)))('%s: the block names %s as a code span', (_name, label, read) => {
      expect(flat(refusalBlock(read()))).toContain(code(label))
    })

    test.each(SWITCH_OVER_CARRIERS)('%s: the block covers only a refusal before Phase 1 is installed, by step 8 or otherwise', (_name, read) => {
      expect(flat(blockParts(refusalBlock(read()))[0])).toMatch(ci('covers only a refusal before agent-director Phase 1 is installed on the host, by step 8 or otherwise'))
    })

    test.each(overCarriers(REFUSAL_ORDER))('%s, in order: %s', (_name, element, anchor, required, read) => {
      const carrier = read()
      const items = refusalOrderItems(carrier).filter((item) => anchor.test(item.text))
      if (items.length !== 1) throw new Error(`${carrier.name}: ${items.length} items of the ordered list match ${String(anchor)}, expected 1`)
      expect({ element, missing: missingItems(carrier, items[0].text, required) }).toEqual({ element, missing: [] })
    })

    test.each(SWITCH_OVER_CARRIERS)('%s: the ordered elements are items 1 to 4 of the list, in that order', (_name, read) => {
      const items = refusalOrderItems(read())
      expect(REFUSAL_ORDER.map(([, anchor]) => items.filter((item) => anchor.test(item.text)).map((item) => item.n))).toEqual([[1], [2], [3], [4]])
    })

    test.each(overCarriers(REFUSAL_BRANCHES))('%s: %s', (_name, element, part, required, read) => {
      const carrier = read()
      expect({ element, missing: missingItems(carrier, refusalPart(carrier, part), required) }).toEqual({ element, missing: [] })
    })

    test.each(SWITCH_OVER_CARRIERS)('%s: the after-install branch names no `command -v agent-director`', (_name, read) => {
      expect(flat(refusalBlock(read()))).not.toMatch(/command -v agent-director/)
    })

    test.each(SWITCH_OVER_CARRIERS)('%s: a host whose Phase 1 came some other way is offered no "put Phase 1 back and start"', (_name, read) => {
      const carrier = read()
      const part = refusalPart(carrier, ci('installed in any other way outside this runbook'))
      const offers = [...part.matchAll(/put (?:agent-director )?Phase 1 back/gi)].filter((m) => !/\b(?:don't|do not|never|no)\s+$/i.test(part.slice(0, m.index)))
      expect(offers.map((m) => m[0])).toEqual([])
      expect(part).not.toContain(stepLink(10)(carrier))
    })

    test.each(overCarriers(UPGRADE_FORMS.map(([label, pattern]) => [label, pattern] as const)))(
      '%s: the block carries no %s once its `agent-director serve` span is removed (ruling C-1)',
      (_name, _label, pattern, read) => {
        expect(withoutAllowedSpan(flat(refusalBlock(read())), 'refusal block')).not.toMatch(pattern)
      },
    )

    test.each([
      ['another backticked agent-director command', `Stop it (${RUNBOOK_COMMAND_SPANS['refusal block']} included), then run \`agent-director stop-all\`.`, ['backticked agent-director command line']],
      ['the allowed span with arguments', `Restart ${code('agent-director serve --port 1')}.`, ['backticked agent-director command line']],
      ['only the allowed span', `Stop every process (${RUNBOOK_COMMAND_SPANS['refusal block']} included).`, []],
    ])('self-check (ruling C-1): a synthetic block with %s', (_label, block, forms) => {
      expect(upgradeFormsIn(withoutAllowedSpan(block, 'refusal block'))).toEqual(forms)
    })

    test(`self-check (ruling C-1): another agent-director command in step 1's version item still fails`, () => {
      const item = `Run ${RUNBOOK_COMMAND_SPANS["step 1's version item"]}; if it is older, run \`agent-director install --phase1\`.`
      expect(upgradeFormsIn(withoutAllowedSpan(item, "step 1's version item"))).toEqual(['backticked agent-director command line'])
    })
  })

  describe(`the "${PUBLISHING_HOST_BLOCK_HEADING}" block (E5 hatch note)`, () => {
    test.each(overCarriers(PUBLISHING_HOST_ELEMENTS))('%s: %s', (_name, element, required, read) => {
      const carrier = read()
      expect({ element, missing: missingItems(carrier, publishingHostBlock(carrier), required) }).toEqual({ element, missing: [] })
    })

    test.each(overCarriers(UPGRADE_FORMS.map(([label, pattern]) => [label, pattern] as const)))('%s: the block carries no %s', (_name, _label, pattern, read) => {
      expect(publishingHostBlock(read())).not.toMatch(pattern)
    })
  })

  describe('README.md: the links and the sections the runbook replaced or kept', () => {
    const readme = readRepoFile('README.md')
    const migration = () => requiredSection(readme, MIGRATION_HEADING, 'README.md')
    const readmeCarrier = () => readRunbookCarrier('README.md', readme, SWITCH_OVER_HEADING, SWITCH_OVER_STEP_COUNT)

    test('the runtime-stop pointer links a heading inside the debugging skill\'s refusal section', () => {
      const skill = readRepoFile(DEBUG_SKILL_FILE)
      const part = refusalPart(readmeCarrier(), ci('runtime re-check'))
      const anchors = markdownLinks(part).filter((link) => link.path === DEBUG_SKILL_FILE).map((link) => link.anchor)
      expect(anchors).toHaveLength(1)
      const index = headingAnchors(skill).indexOf(anchors[0])
      const parent = sectionRange(skill, `## ${REFUSAL_SECTION_TITLE}`)
      expect(index).toBeGreaterThanOrEqual(0)
      expect(parent).toBeDefined()
      const line = headings(skill)[index].line
      expect(line > parent!.start && line < parent!.end).toBe(true)
    })

    const GONE_TITLE = 'First start on a host with running bots'

    test(`no README heading is "${GONE_TITLE}"`, () => {
      expect(headings(readme).filter((h) => h.title === GONE_TITLE).map((h) => h.text)).toEqual([])
    })

    test.each(['README.md', ...shippedSkillFiles().filter((file) => file.endsWith('.md'))])(`%s links nowhere to "${GONE_TITLE}"`, (file) => {
      const anchor = headingSlug(GONE_TITLE)
      expect(markdownLinks(readRepoFile(file)).filter((link) => link.anchor === anchor).map((link) => link.target)).toEqual([])
    })

    const UPGRADING_HEADING = '### Upgrading to personas'
    const upgrading = () => flat(requiredSection(migration(), UPGRADING_HEADING, `README.md, under "${MIGRATION_HEADING}",`))

    test.each([
      ['config.json rewritten by hand', ci('rewrite `config.json` by hand')],
      ['persona names whose keys do not start with one another', ci("pick persona names whose keys don't start with one another")],
      ['the reply settings', ci('set the reply settings in `config.json`')],
      ['the tokens moved into credentials files', ci('move the tokens into credentials files')],
      ['a Slack app per persona', ci('give each persona its own Slack app')],
      ['who can reach each persona', ci('decide who can reach each persona')],
      ['crontable lines naming personas', ci('rewrite crontable lines to name personas')],
      ['/interject callers sending persona', ci('update `/interject` callers to send `persona`')],
    ])(`"${UPGRADING_HEADING}" keeps its conversion step: %s`, (_label, pattern) => {
      expect(upgrading()).toMatch(pattern)
    })

    test(`"${UPGRADING_HEADING}" says step 1 writes these steps into the separate staged file, not config.json, and step 7 puts it in place as config.json`, () => {
      expect(upgrading()).toMatch(ci('at switch-over step 1, these steps are written into the separate staged file, not `config.json`'))
      expect(upgrading()).toMatch(ci('step 7 puts that file in place as `config.json`'))
    })

    test.each([1, 7])(`"${UPGRADING_HEADING}" links switch-over step %d`, (n) => {
      expect(markdownLinks(upgrading()).map((link) => link.anchor)).toContain(readmeCarrier().stepAnchors[n - 1])
    })

    test.each(['stop --stop-bots', 'claude-slack-channel-bots start'])(`"${UPGRADING_HEADING}" no longer holds %s`, (command) => {
      expect(upgrading()).not.toContain(command)
    })
  })
})
