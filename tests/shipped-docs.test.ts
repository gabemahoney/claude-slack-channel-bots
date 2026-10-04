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
 *   exemptions (`AUDIT_EXCEPTIONS`) are exactly three: the debugging skill's
 *   SR-1.7 entry, and one entry per README runbook section, each exempting
 *   `access.json` only, and only inside "Switching over to agent-director
 *   Phase 1" (which saves the previous CSCB's file) or "Rolling back the
 *   switch-over" (which restores it) (b.jg5 SRJ-1108, SRJ-1109, SRJ-1516).
 *   Every other term stays banned inside those sections, the token
 *   variables' names included; a missing heading fails the audit;
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
 *   SRJ-1108 element over each carrier (`SWITCH_OVER_CARRIERS`: the README
 *   section and the CHANGELOG release entry's copy), the
 *   negative and order checks, the "Arrived here from a startup refusal?"
 *   block's ordered elements and branches, the publishing-host block, the
 *   sections the runbook replaced or kept, and the reader's self-checks.
 *   Values CSCB defines are imported; agent-director vocabulary CSCB defines
 *   nowhere sits in `AD_VOCABULARY`, each row citing its source;
 * - the rollback runbook, README "Rolling back the switch-over" (b.jg5
 *   SRJ-1109; hatch A3): exactly one `###` heading under `## Migration`,
 *   after the switch-over section; its steps 1–9 read in order by the same
 *   step reader, one named case per SRJ-1109 element over each carrier
 *   (`ROLLBACK_CARRIERS`, the same two), the order rows (steps 6, 8 and 9), the cross-step
 *   rows (no `tmux kill-session`, no `include-finished`, "Operator actions"
 *   named by title), step 8's no-conversion-tool check, and ruling C-2: the
 *   switch-over refusal block's pointers to the rollback runbook and its
 *   step 8 are links that resolve, as are the runbooks' other links and the
 *   registry-install runbook's scope note links to both sections.
 * - `OPERATOR_TEXTS` (b.jg5 SRJ-1101's seven operator texts: the README, the
 *   debugging, install and setup skills, docs/architecture.md,
 *   docs/engineering-guide.md and CHANGELOG.md), read for SRJ-1107's checks:
 *   no "Upgrade steps" heading or link and no "checks its tmux session first"
 *   in any of them; the CHANGELOG release entry's elements, one case each
 *   (exactly one unreleased entry, first; the breaking note's parts; the
 *   retired access file kept until rollback is no longer wanted and never
 *   deleted; the relaunch through agent-director; the dropped tmux-commands
 *   note; the prefix-key reason without the old agent-director version; the
 *   fresh-once note's runbook pointer), each self-checked against b.ob2's
 *   wording; the names the hatch-note entries introduce, through their `src/`
 *   exports; the two runbook copies, which join `SWITCH_OVER_CARRIERS` and
 *   `ROLLBACK_CARRIERS`, name the README as the maintained copy and match it
 *   word for word; and every CHANGELOG link resolves (hatch A3).
 * - E36 T1's checks, also read through `OPERATOR_TEXTS`: no operator text
 *   quotes a sentence of the *Kill failed* or *Process outlived kill* alert
 *   but its title and closing sentences (the E20 note; both versions rendered
 *   from src/kill-failure-alert.ts with the stub's descriptions, one case per
 *   text and sentence); the README and the debugging skill name no
 *   raw-command advice (a positional `agent-director kill` id, tmux-kill or
 *   kill-and-respawn, `has-session`, an attach target without `=`, a raw tmux
 *   kill outside the switch-over section), and their `auto-restart disabled`
 *   lost-message text keeps not saying the persona will not restart on its
 *   own (the E8 note); each self-checked.
 * CHANGELOG.md and docs/ are not shipped descriptions: the forbidden-term
 * audit still reads only `SHIPPED_TEXTS`, which holds neither. Besides the
 * two docs read through `OPERATOR_TEXTS`, the one docs/ file read is
 * docs/registry-install-runbook.md, for its links.
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
  CONFIG_FILE_NAME,
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
  type Heading,
  sectionRange,
  splitFences,
} from './test-helpers/markdown.ts'
import { RELOAD_TERMS } from './test-helpers/reload-terms.ts'
import { CLEAR_LATCH_TERMS, clearLatchTermsIn } from './test-helpers/clear-latch-terms.ts'
import { UPGRADE_FORMS } from './test-helpers/upgrade-forms.ts'
import { CRONTABLE_TEMPLATE_HEADER } from '../src/cron-bootstrap.ts'
import type { Via } from '../src/delivery-decision.ts'
import { MCP_INSTRUCTIONS } from '../src/registry.ts'
import { PHASE1_FLOOR_VERSION, PHASE1_RUNBOOK_SECTION_TITLE } from '../src/ad-version-gate.ts'
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
import { AD_ERROR_CLASS_CONFLICT, AD_ERROR_CLASS_UNAVAILABLE } from '../src/ad-error-class.ts'
import {
  PERSONA_INSTANCE_ID_PREFIX,
  PERSONA_TMUX_SESSION_PREFIX,
  personaInstanceId,
  personaTmuxSessionName,
  SERVICE_LABEL,
} from '../src/persona-identity.ts'
import { LAST_APPLIED_FILE_SUFFIX } from '../src/reload.ts'
import { RETIRED_KEYS_FILE_NAME } from '../src/retired-keys.ts'
import { CLEAR_LATCH_COMMAND, SERVER_PORT_FILE_NAME } from '../src/clear-latch.ts'
import { CLEAN_RESTART_NOT_RESTARTED_LABEL, CLI_TEARDOWN_FAILED_LABEL } from '../src/cli-teardown.ts'
import {
  KILL_FAILURE_CLOSING_CLI_TEARDOWN,
  KILL_FAILURE_CLOSING_DESTINATION,
  KILL_FAILURE_CLOSING_DESTINATION_LATCHED,
  KILL_FAILURE_CLOSING_LOG_ONLY,
  KILL_FAILURE_VERSION_ORDINARY,
  KILL_FAILURE_VERSION_SURVIVOR,
  killFailureAlertText,
  killFailureClosingSentence,
  killFailureSurvivorPidList,
  PERSONA_KILL_FAILED_LABEL,
  PERSONA_KILL_SURVIVOR_LABEL,
  type KillFailureAlertContent,
  type KillFailureAlertVersion,
  type KillFailureClosing,
} from '../src/kill-failure-alert.ts'
import { STATE_WORDING } from '../src/lost-message.ts'
import { renderLogMessageText } from '../src/persona-connection-errors.ts'
import { startupSummaryEnding } from '../src/session-manager.ts'
import { errTmuxKillFailed, KILL_FAILED_DESCRIPTIONS, STUB_SURVIVOR_PIDS } from './test-helpers/agent-director-stub.ts'
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

const DEBUG_SKILL_FILE = 'skills/debug-slack-channel-bots/SKILL.md'
const INSTALL_SKILL_FILE = 'skills/install-cscb/SKILL.md'
const CHANGELOG_FILE = 'CHANGELOG.md'

/**
 * b.jg5 SRJ-1101's operator texts, [name, text], read from the repository:
 * the README, the debugging, install and setup skills, the architecture doc,
 * the engineering guide and the CHANGELOG. SRJ-1107's checks (the CHANGELOG
 * release entry, at the end of this file) read their texts through this
 * list. It is not `SHIPPED_TEXTS`: the forbidden-term audit still reads only
 * that list, which holds neither the CHANGELOG nor `docs/`.
 */
const OPERATOR_TEXTS: [name: string, read: () => string][] = [
  'README.md',
  DEBUG_SKILL_FILE,
  INSTALL_SKILL_FILE,
  WIZARD_FILE,
  'docs/architecture.md',
  'docs/engineering-guide.md',
  CHANGELOG_FILE,
].map((file): [string, () => string] => [file, () => readRepoFile(file)])

/** One operator text by its name; throws naming a name `OPERATOR_TEXTS` lacks. */
function operatorText(name: string): string {
  const entry = OPERATOR_TEXTS.find(([text]) => text === name)
  if (entry === undefined) throw new Error(`OPERATOR_TEXTS has no text "${name}"`)
  return entry[1]()
}

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
 * throws, as for the SR-1.7 entry. The rollback section has its own entry,
 * below.
 */
const SWITCH_OVER_EXCEPTION: AuditException = {
  file: 'README.md',
  heading: `### ${PHASE1_RUNBOOK_SECTION_TITLE}`,
  terms: ['access.json'],
  reason: "b.jg5 SRJ-1108, SRJ-1516: the switch-over runbook saves and restores the previous CSCB's access.json",
}

/** The rollback section's heading as the README writes it: a `###` under `## Migration`, after the switch-over section. */
const ROLLBACK_HEADING = `### ${ROLLBACK_RUNBOOK_SECTION_TITLE}`

/**
 * The rollback runbook's exemption (b.jg5 SRJ-1109, SRJ-1516): the README
 * section may name `access.json` among the files its step 8 restores. As for
 * the switch-over entry: every other term stays banned there, the token
 * variables' names included, `access.json` stays banned everywhere else, and
 * a missing heading throws.
 */
const ROLLBACK_EXCEPTION: AuditException = {
  file: 'README.md',
  heading: ROLLBACK_HEADING,
  terms: ['access.json'],
  reason: "b.jg5 SRJ-1109, SRJ-1516: the rollback runbook's step 8 restores the previous CSCB's access.json",
}

/** The two runbook entries (SRJ-1516): one per README runbook section, each exempting only `access.json`. */
const RUNBOOK_EXCEPTIONS: readonly AuditException[] = [SWITCH_OVER_EXCEPTION, ROLLBACK_EXCEPTION]

const AUDIT_EXCEPTIONS: readonly AuditException[] = [SR_1_7_EXCEPTION, ...RUNBOOK_EXCEPTIONS]

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

  test('the exemptions are exactly the SR-1.7 entry and the two runbook entries, each runbook entry exempting only access.json in README.md (SRJ-1516)', () => {
    expect(AUDIT_EXCEPTIONS.map((e) => [e.file, e.heading, [...e.terms]])).toEqual([
      [SR_1_7_EXCEPTION.file, SR_1_7_EXCEPTION.heading, [...SR_1_7_EXCEPTION.terms]],
      ['README.md', `### ${PHASE1_RUNBOOK_SECTION_TITLE}`, ['access.json']],
      ['README.md', `### ${ROLLBACK_RUNBOOK_SECTION_TITLE}`, ['access.json']],
    ])
  })

  test(`the only allowed hits: access.json in README.md under "${SWITCH_OVER_EXCEPTION.heading}" and under "${ROLLBACK_EXCEPTION.heading}" (SRJ-1108, SRJ-1109, SRJ-1516); with the exemptions off, it appears nowhere else in shipped text, and both exemptions are used`, () => {
    const terms = ALL_FORBIDDEN_TERMS.filter(([label]) => label === 'access.json')
    expect(terms.map(([label]) => label)).toEqual(['access.json'])
    const readme = readRepoFile('README.md')
    const ranges = RUNBOOK_EXCEPTIONS.map((exception) => {
      const range = sectionRange(readme, exception.heading)
      if (range === undefined) throw new Error(`README.md has no heading "${exception.heading}"`)
      return range
    })
    const inside = (hit: TermHit) => hit.file === 'README.md' && ranges.some((range) => hit.line > range.start && hit.line <= range.end)
    const hits = SHIPPED_TEXTS.flatMap(([name, read]) => auditText(name, read(), terms, []).hits)
    expect(hits.filter((hit) => !inside(hit)).map(formatHit)).toEqual([])
    expect(auditText('README.md', readme, terms).hits.map(formatHit)).toEqual([])
    // Each runbook entry, alone, allows at least one hit: neither exemption is idle.
    expect(RUNBOOK_EXCEPTIONS.map((exception) => [exception.heading, auditText('README.md', readme, terms, [exception]).allowed.length > 0])).toEqual(
      RUNBOOK_EXCEPTIONS.map((exception) => [exception.heading, true]),
    )
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

  /** The two runbook exemptions (b.jg5 SRJ-1108, SRJ-1109, SRJ-1516), on a synthetic README. */
  describe('the two runbook exemptions', () => {
    const README = 'README.md'
    const SAVE = 'Keep a copy of `access.json`.'
    const RESTORE = 'Put back `access.json`.'
    type Parts = { earlier: string; inSwitchOver: string; between: string; inRollback: string; later: string; other: string }
    const EMPTY: Parts = { earlier: '-', inSwitchOver: '-', between: '-', inRollback: '-', later: '-', other: '-' }
    /**
     * A synthetic README: the switch-over section and the rollback section,
     * each with a step subsection, a section between them, one after them,
     * then another `##` section. Line numbers hold while each part is one line.
     */
    const readme = (parts: Partial<Parts>) => {
      const p = { ...EMPTY, ...parts }
      return [
        '# CSCB', //                                                  l.1
        '## Migration', //                                            l.2
        p.earlier, //                                                 l.3
        SWITCH_OVER_EXCEPTION.heading, //                             l.4
        p.inSwitchOver, //                                            l.5
        `#### ${stepHeadingPrefix(1)}Check the host`, //              l.6
        SAVE, //                                                      l.7
        '### Between the runbooks', //                                l.8
        p.between, //                                                 l.9
        ROLLBACK_EXCEPTION.heading, //                                l.10
        p.inRollback, //                                              l.11
        `#### ${stepHeadingPrefix(8)}Reinstall the previous CSCB`, // l.12
        RESTORE, //                                                   l.13
        '### Upgrading to personas', //                               l.14
        p.later, //                                                   l.15
        '## Troubleshooting', //                                      l.16
        p.other, //                                                   l.17
      ].join('\n')
    }

    test('inside either section, including its subsections, access.json is allowed, not a hit', () => {
      const { hits, allowed } = auditText(README, readme({ inSwitchOver: SAVE, inRollback: RESTORE }), ALL_FORBIDDEN_TERMS)
      expect(hits).toEqual([])
      expect(allowed.map((hit) => `${hit.line}: ${hit.term}`)).toEqual(['5: access.json', '7: access.json', '11: access.json', '13: access.json'])
    })

    test.each([
      ['just before the switch-over section', { earlier: SAVE }, `${README}:3: access.json`],
      ['between the two sections', { between: SAVE }, `${README}:9: access.json`],
      ['just after the rollback section', { later: RESTORE }, `${README}:15: access.json`],
      ['in another section', { other: RESTORE }, `${README}:17: access.json`],
    ] as const)('access.json %s is a hit, with file and line', (_where, parts, expected) => {
      const hits = auditText(README, readme(parts), ALL_FORBIDDEN_TERMS).hits.map(formatHit)
      expect(hits).toHaveLength(1)
      expect(hits[0].startsWith(expected)).toBe(true)
    })

    const OTHER_TERMS = [
      ['a token variable', 'Unset SLACK_APP_TOKEN too.', 'SLACK_APP_TOKEN'],
      ['the other token variable', 'Set SLACK_BOT_TOKEN again.', 'SLACK_BOT_TOKEN'],
      ['an export of a token variable', 'export MY_TOKEN="<bot token>"', 'an export of a token variable'],
      ['access-control wording', 'It holds the access control list.', 'access-control wording'],
      ['a pre-persona key', 'Put `default_route` back.', 'default_route'],
    ] as const

    /** Each section with the synthetic README carrying `line` just inside it, and the line number `line` lands on. */
    const WITH_LINE_INSIDE: [section: string, build: (line: string) => string, lineNumber: number][] = [
      ['switch-over', (line) => readme({ inSwitchOver: `${SAVE}\n${line}`, inRollback: RESTORE }), 6],
      ['rollback', (line) => readme({ inSwitchOver: SAVE, inRollback: `${RESTORE}\n${line}` }), 12],
    ]

    test.each(WITH_LINE_INSIDE.flatMap(([section, build, lineNumber]) => OTHER_TERMS.map(([label, line, term]) => [label, section, build(line), `${lineNumber}: ${term}`] as const)))(
      '%s inside the %s section is a hit',
      (_label, _section, text, expected) => {
        expect(auditText(README, text, ALL_FORBIDDEN_TERMS).hits.map((hit) => `${hit.line}: ${hit.term}`)).toEqual([expected])
      },
    )

    test('the same headings in a skill exempt nothing', () => {
      const other = 'skills/other-skill/SKILL.md'
      const { hits, allowed } = auditText(other, readme({ inSwitchOver: SAVE, inRollback: RESTORE }), ALL_FORBIDDEN_TERMS)
      expect(allowed).toEqual([])
      expect(hits.map((hit) => `${hit.file}:${hit.line}: ${hit.term}`)).toEqual(
        [5, 7, 11, 13].map((line) => `${other}:${line}: access.json`),
      )
    })

    test.each(
      RUNBOOK_EXCEPTIONS.flatMap(({ heading }) => [
        ['removed', heading, (text: string) => text.replace(`${heading}\n`, '')],
        ['renamed', heading, (text: string) => text.replace(heading, '### A runbook')],
        ['moved to another level', heading, (text: string) => text.replace(heading, `#${heading}`)],
      ] as const),
    )('with the heading %s (%s), the audit fails naming it and exempts nothing', (_how, heading, edit) => {
      const edited = edit(readme({ inSwitchOver: SAVE, inRollback: RESTORE }))
      expect(edited).not.toBe(readme({ inSwitchOver: SAVE, inRollback: RESTORE }))
      expect(() => auditText(README, edited, ALL_FORBIDDEN_TERMS)).toThrow(`${README} has no heading "${heading}"`)
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

/** The README section the switch-over runbook replaced (b.jg5 SRJ-1103): no heading carries it and no link reaches it. */
const GONE_TITLE = 'First start on a host with running bots'

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
  waitMinutes: { text: '5', source: 'SRJ-1108 steps 4 and 6, SRJ-1109 step 4: the waits for a row to read `ended` or `missing`, in minutes' },
  operatorActions: { text: '"Operator actions"', source: "HO rev 27; A-2, A-26: the section of agent-director's README a human follows; SRJ-1109 steps 3 to 5" },
  notThisLaunch: { text: "not this launch's session", source: "HO §2; SRJ-1109 steps 4 and 5: a `kill`'s CONFLICT on a leftover of an earlier launch" },
  downgradeRecipe: { text: 'emergency downgrade recipe', source: "HO C15; ADA question 8; SRJ-1109 step 6: the only way the previous agent-director is restored" },
  downgradeSchemaVersion: { text: '4', source: 'HO C15; ADA question 8; SRJ-1109 step 6: the schema version the recipe stamps' },
  sqliteBackup: { text: code('.backup'), source: "HO C15; SRJ-1108 step 8: sqlite3's online-consistent copy of the WAL-mode store" },
  migrationColumns: { text: 'thirteen', source: "HO rev 15: the columns Phase 1's schema migration adds (and the downgrade recipe drops, SRJ-1109 step 6)" },
  storeMeta: { text: code('store_meta'), source: "HO rev 15, rev 19: the one-row table holding the store's id" },
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

/**
 * Every carrier of the switch-over runbook: its name and its reader. The
 * README section, and the CHANGELOG release entry's copy (b.jg5 SRJ-1107;
 * hatch A3), read through `OPERATOR_TEXTS` from the entry only.
 */
const SWITCH_OVER_CARRIERS: [name: string, read: () => RunbookCarrier][] = [
  ['README.md', lazy(() => readRunbookCarrier('README.md', readRepoFile('README.md'), SWITCH_OVER_HEADING, SWITCH_OVER_STEP_COUNT))],
  [CHANGELOG_FILE, lazy(() => readRunbookCarrier(CHANGELOG_FILE, releaseEntry(operatorText(CHANGELOG_FILE)), SWITCH_OVER_HEADING, SWITCH_OVER_STEP_COUNT))],
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
    `${vocab('operatorActions')} section of agent-director's README`,
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
    vocab('operatorActions'),
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

// ---------------------------------------------------------------------------
// The rollback runbook (b.jg5 SRJ-1109; hatch A3; ruling C-2)
// ---------------------------------------------------------------------------

/** The rollback runbook's step count (SRJ-1109: steps 1 to 9). */
const ROLLBACK_STEP_COUNT = 9

/** Every carrier of the rollback runbook: its name and its reader. The README section and the CHANGELOG release entry's copy, as for `SWITCH_OVER_CARRIERS`. */
const ROLLBACK_CARRIERS: [name: string, read: () => RunbookCarrier][] = [
  ['README.md', lazy(() => readRunbookCarrier('README.md', readRepoFile('README.md'), ROLLBACK_HEADING, ROLLBACK_STEP_COUNT))],
  [CHANGELOG_FILE, lazy(() => readRunbookCarrier(CHANGELOG_FILE, releaseEntry(operatorText(CHANGELOG_FILE)), ROLLBACK_HEADING, ROLLBACK_STEP_COUNT))],
]

/** One rollback carrier's place, for the cases that run over every carrier. */
const overRollbackCarriers = <T extends readonly unknown[]>(rows: readonly T[]) =>
  ROLLBACK_CARRIERS.flatMap(([name, read]) => rows.map((row) => [name, ...row, read] as const))

/** A count as the runbooks write it, in words; throws for a count it lacks, so a changed count fails naming it. */
function countWord(n: number): string {
  const words: Record<number, string> = { 9: 'nine' }
  const word = words[n]
  if (word === undefined) throw new Error(`countWord has no word for ${n}`)
  return word
}

/** The old CSCB's tmux session names, which the previous CSCB uses again after the rollback (SRJ-1109 step 5). */
const OLD_SESSION_NAMES = [`${PERSONA_TMUX_SESSION_PREFIX}<name>_<channel>`, `${PERSONA_TMUX_SESSION_PREFIX}<channel ID>`]

/**
 * One row per SRJ-1109 element: where it sits (`frame`, `step <n>` or
 * `step <n> › <item lead>`), the element, and the items its text must hold.
 * The `operator action` rows mark each operator-only action at its step.
 * Links are checked only in the README (ruling C-2, below), so the rows hold
 * for a copy whose links differ.
 */
const ROLLBACK_ELEMENTS: [where: string, element: string, required: readonly Item[]][] = [
  // The section-level statements.
  ['frame', `back to the previous CSCB on agent-director ${OLD_AD_VERSION}; both binaries rolled back together`, [
    ci(`back to the previous CSCB on agent-director ${OLD_AD_VERSION}`),
    ci('both binaries are rolled back together'),
  ]],
  ['frame', `the previous agent-director is restored only with agent-director's ${vocab('downgradeRecipe')}, never state.db from the switch-over backup`, [
    ci(`the previous agent-director is restored only with agent-director's ${vocab('downgradeRecipe')}, in step 6`),
    ci("never restore `state.db` from the switch-over's backup"),
  ]],
  ['frame', "the reason: the store is shared, and a restore drops other services' rows, leaving their workers running with no row", [
    ci('the store is shared by every agent-director user on the host'),
    ci("a restore would drop the rows of other services' workers spawned since the switch-over, leaving them running with no row"),
  ]],
  ['frame', 'every agent and long-running agent-director process stopped before the previous binary is restored and started again after it (C15)', [
    ci(`every agent on the host, with every long-running agent-director process (${code('agent-director serve')} included), is stopped before the previous binary is restored and started again after it`),
  ]],
  ['frame', 'the switch-over log kept in use; each step says what to record', [ci('keep using the switch-over log'), ci('each step says what to record in it')]],
  ['frame', "commands run as the workers' user in the tmux environment switch-over step 1 pinned", [
    ci("run every command as the workers' user, in the tmux environment switch-over step 1 pinned"),
  ]],
  ['frame', 'operator-only actions are marked "operator action"', [ci('steps marked "operator action" are done by a human on the host')]],
  ['frame', `${vocab('operatorActions')} is that section of agent-director's README`, [ci(`${vocab('operatorActions')} is that section of agent-director's README`)]],

  // Steps 1 and 2.
  ['step 1', "the host's autostart for CSCB disabled until step 9, recorded", [
    ci("disable the host's autostart for CSCB until step 9"),
    ci('record it in the switch-over log'),
  ]],
  ['step 1', "operator action: disabling the host's autostart for CSCB", [ci(`until step 9 ${OPERATOR_ACTION}`)]],
  ['step 2', "the daily agent-director expire switch-over step 11 added removed from the host's sweep loop, recorded", [
    ci("remove the daily `agent-director expire` run that switch-over step 11 added to the host's sweep loop"),
    code('~/startup/find-missing-loop.sh'),
    ci('record it in the switch-over log'),
  ]],
  ['step 2', 'before the previous binary is restored, because the older expire does not check tmux', [
    ci('before the previous binary is restored, because the older `expire` does not check tmux'),
  ]],
  ['step 2', 'operator action: removing the daily expire', [ci(`${code('~/startup/find-missing-loop.sh')} ${OPERATOR_ACTION}`)]],

  // Step 3.
  ['step 3', 'the new CSCB stopped with stop --stop-bots, whose failure lines the README describes (E32, E33)', [
    'claude-slack-channel-bots stop --stop-bots',
    ci("the command's failure lines are described in"),
    'Precheck before stopping bots',
    "What the command prints when a bot can't be stopped",
  ]],
  ['step 3', `a persona in ${AD_ERROR_CLASS_CONFLICT}: a human follows ${vocab('operatorActions')} for its session, checks the result and runs stop --stop-bots again`, [
    `naming a persona in ${AD_ERROR_CLASS_CONFLICT}`,
    ci(`a human follows ${vocab('operatorActions')} for that persona's session, checks the result, and runs \`stop --stop-bots\` again`),
  ]],
  ['step 3', `that session not ended, agent-director not answering or a call ${AD_ERROR_CLASS_UNAVAILABLE} after its retries: plain stop, each persona and session recorded`, [
    ci('if that session cannot be ended that way'),
    ci('the command exits non-zero because agent-director does not answer'),
    `a call stays ${AD_ERROR_CLASS_UNAVAILABLE} after its retries`,
    ci('stop the server with plain `stop`'),
    'claude-slack-channel-bots stop ```',
    ci('record in the switch-over log each persona and session the failed command named'),
  ]],

  // Step 4.
  ['step 4', `agent-director find-missing, then at most ${vocab('waitMinutes')} minutes for every ${SERVICE_LABEL} row, retired keys' rows included, to read ended or missing`, [
    code('agent-director find-missing'),
    ci(`wait at most ${vocab('waitMinutes')} minutes for every \`${SERVICE_LABEL}\` row, the rows of retired persona keys included, to read \`ended\` or \`missing\``),
  ]],
  ['step 4', 'a row still live (a retired key whose kill failed, which stop --stop-bots does not cover) is ended by a human with agent-director kill, its result checked', [
    ci('a row still live after that (for example a retired key whose kill failed, which `stop --stop-bots` does not cover) is ended by a human'),
    ci('run `agent-director kill --claude-instance-id <id>`, and check its result'),
  ]],
  ['step 4', `a kill refused with ${AD_ERROR_CLASS_CONFLICT} ("${vocab('notThisLaunch')}") meets a leftover of an earlier launch, handled as ${vocab('operatorActions')} describes`, [
    `refused with ${AD_ERROR_CLASS_CONFLICT} ("${vocab('notThisLaunch')}")`,
    ci('has met a leftover of an earlier launch'),
    ci(`handle it as ${vocab('operatorActions')} describes`),
  ]],
  ['step 4', `kills that keep failing: ${vocab('operatorActions')} for that worker, recorded`, [
    ci(`if these kills keep failing, follow ${vocab('operatorActions')} for that worker, and record it in the switch-over log`),
  ]],
  ['step 4', 'nothing goes on to step 6 while such a worker runs, because every agent must be stopped before the restore (ADA question 9)', [
    ci('nothing goes on to step 6 while such a worker runs, because every agent must be stopped before the previous binary is restored'),
  ]],
  ['step 4', `a worker ${vocab('operatorActions')} cannot end: the rollback stops with Phase 1 installed and the worker goes to agent-director`, [
    ci(`when ${vocab('operatorActions')} cannot end it either`),
    ci('the rollback stops here, with Phase 1 still installed, and the worker is taken to agent-director'),
  ]],
  ['step 4', "then the new CSCB started again, step 2's expire restored and the autostart re-enabled, so the fleet does not stay down", [
    ci('so that the fleet does not stay down while agent-director investigates'),
    ci('start the new CSCB again'),
    ci("restore step 2's daily `expire` in `~/startup/find-missing-loop.sh`"),
    ci("re-enable the host's autostart for CSCB"),
  ]],
  ['step 4', "operator action: the new CSCB's restart, the expire and the autostart", [ci(`autostart for CSCB ${OPERATOR_ACTION}`)]],
  ['step 4', `a refused restart: the new CSCB stays stopped until agent-director has dealt with the worker, then the refusal block's after-install branch (SRJ-1108)`, [
    ci('if that start is refused, the new CSCB stays stopped until agent-director has dealt with that worker'),
    ci('then follow "A refusal after Phase 1 was installed"'),
    REFUSAL_BLOCK_HEADING,
  ]],

  // Step 5.
  ['step 5', `a read-only tmux ls, as the workers' user on the pinned socket, confirms no ${PERSONA_TMUX_SESSION_PREFIX}<key> session is left`, [
    ci("as the workers' user, on the socket switch-over step 1 pinned, run a read-only `tmux ls`"),
    ci(`confirm that no ${code(`${PERSONA_TMUX_SESSION_PREFIX}<key>`)} session is left`),
    ci("handle each leftover by whether it has a row and, if it has one, by that row's current state"),
  ]],
  ['step 5', `a live row's leftover: agent-director kill of ${PERSONA_INSTANCE_ID_PREFIX}<key>; refused with "${vocab('notThisLaunch')}", ${vocab('operatorActions')}`, [
    ci('a leftover whose row is live'),
    code(`agent-director kill --claude-instance-id ${PERSONA_INSTANCE_ID_PREFIX}<key>`),
    ci(`when that \`kill\` is refused with "${vocab('notThisLaunch')}", handle it as ${vocab('operatorActions')} describes`),
  ]],
  ['step 5', `a finished row's own leftover session: as ${vocab('operatorActions')} describes`, [
    new RegExp(`a finished row's own leftover session\\W+handle it as ${escapeRegExp(vocab('operatorActions'))} describes`, 'i'),
  ]],
  ['step 5', 'an operator action refused inside the stopping window or starting-session bound: retried once the longer has passed, the nine settings read again and recorded; a plain kill never refuses so', [
    ci('an operator action refused inside the stopping window or the starting-session bound'),
    ci('retry it once the longer of the two has passed'),
    () => `all ${countWord(AD_TMUX_KEYS.length)} timing settings again, as in switch-over step 1`,
    ci('record them in the switch-over log'),
    ci('a plain `kill` never refuses for that reason'),
  ]],
  ['step 5', "a leftover with no row: as in switch-over step 5, against the previous CSCB's session names", [
    ci('a leftover with no row'),
    ci('switch-over step 5'),
    ci("against the previous CSCB's session names"),
    ...OLD_SESSION_NAMES.map(code),
  ]],
  ['step 5', "each result checked, then find-missing and switch-over step 5's gone check again", [
    ci("check each result, then run `agent-director find-missing` and switch-over step 5's gone check again"),
  ]],
  ['step 5', "no going on while a leftover remains: the previous CSCB's first start deletes every row without a channel label", [
    ci("don't go on while a leftover remains"),
    ci("the previous CSCB's first start deletes every row without a `channel` label"),
  ]],

  // Step 6.
  ['step 6 › Stop every other agent', "every other agent and long-running agent-director process stopped before the restore: workers, hand-started sessions, serve sessions, whose Claude session is stopped too (HO C15; ADA question 9)", [
    ci('before the previous binary is restored, stop every other agent on the host and every long-running agent-director process'),
    ci("orchestrators' workers, hand-started sessions and sessions with an `agent-director serve`"),
    ci('a `serve` runs inside its Claude session, so that session is stopped too'),
  ]],
  ['step 6 › Stop every other agent', 'operator action: stopping every other agent (C15)', [OPERATOR_ACTION]],
  ['step 6 › Stop every other agent', 'confirmed as in switch-over step 8: agent-director list, a read-only tmux ls, recorded', [
    ci('confirm as in'),
    ci('switch-over step 8'),
    ci("`agent-director list` shows each stopped agent's row `ended` or `missing`"),
    ci('a read-only `tmux ls` shows no agent session left'),
    ci('record it in the switch-over log'),
  ]],
  ['step 6 › Stop every other agent', 'no restore while any agent runs; one that cannot be stopped stops the rollback as step 4 says, and the stopped agents start again on Phase 1', [
    ci('the restore does not begin while any agent runs'),
    ci('if one cannot be stopped, the rollback stops as step 4 says'),
    ci('every agent this step stopped is started again on Phase 1 by its owner'),
  ]],
  ['step 6 › Stop every other agent', 'operator action: the stopped agents started again on Phase 1 by their owners', [ci(`started again on Phase 1 by its owner ${OPERATOR_ACTION}`)]],
  ['step 6 › Restore the previous agent-director', `restored with agent-director's ${vocab('downgradeRecipe')}, never from the switch-over's state.db backup`, [
    ci(`with agent-director's ${vocab('downgradeRecipe')}, never from the switch-over's \`state.db\` backup`),
  ]],
  ['step 6 › Restore the previous agent-director', `the recipe drops the ${vocab('migrationColumns')} columns and the ${vocab('storeMeta')} table holding the store's id (HO rev 15, rev 19)`, [
    ci(`drops the ${vocab('migrationColumns')} columns the Phase 1 migration added and its ${vocab('storeMeta')} table, which holds the store's id`),
  ]],
  ['step 6 › Restore the previous agent-director', `the recipe stamps schema version ${vocab('downgradeSchemaVersion')} and deletes no row or history entry; the older binary shows every life's history again`, [
    ci(`stamps schema version ${vocab('downgradeSchemaVersion')}`),
    ci("it deletes no row or history entry, so the older binary shows every life's history again"),
  ]],
  ['step 6 › Restore the previous agent-director', "a later Phase 1 install creates a new store id: an earlier-labelled session reads as another store's, one more reason no agent runs across the restore (HO rev 15)", [
    ci('a later Phase 1 install creates a new store id'),
    ci("a session labelled before the rollback would then read as another agent-director store's session, which agent-director never acts on"),
    ci('one more reason no agent may run across the restore'),
  ]],
  ['step 6 › Start the other agents again', 'every other agent started again by its owner on the previous binary, its serve processes on it', [
    ci('every other agent on the host is started again by its owner on the previous binary, which also starts its `serve` processes on it'),
  ]],
  ['step 6 › Start the other agents again', 'operator action: the other agents started again (C15)', [OPERATOR_ACTION]],

  // Steps 7 to 9.
  ['step 7', 'the §6 "hold until after" wording reverted', [ci('revert the orchestrator system prompt\'s "hold until after" wording that switch-over step 11 put out')]],
  ['step 7', 'operator action: reverting the "hold until after" wording', [ci(`put out ${OPERATOR_ACTION}`)]],
  ['step 7', `the "kill, then leave the row" cleanup stays: it works on ${OLD_AD_VERSION} too (reconcile note)`, [
    ci('the worker cleanup switch-over step 10 changed to "kill, then leave the row" stays'),
    ci(`it works on ${OLD_AD_VERSION} too`),
  ]],
  ['step 8', `${CONFIG_FILE_NAME}${LAST_APPLIED_FILE_SUFFIX} and ${RETIRED_KEYS_FILE_NAME} moved aside`, [
    ci(`move aside ${code(`${CONFIG_FILE_NAME}${LAST_APPLIED_FILE_SUFFIX}`)} and ${code(RETIRED_KEYS_FILE_NAME)}`),
  ]],
  ['step 8', 'the previous CSCB reinstalled: the version switch-over step 1 recorded, or else the version the host ran before (hatch A3)', [
    ci('reinstall the previous CSCB, the version switch-over step 1 recorded, or else the version the host ran before'),
    'bun install -g claude-slack-channel-bots@<the previous version>',
  ]],
  ['step 8', "switch-over step 1's files put back: the pre-persona config.json, crontable, /interject callers, access.json and the Slack token environment variables (SRJ-1516)", [
    ci('put back what switch-over step 1 saved'),
    ci(`the pre-persona ${code(CONFIG_FILE_NAME)}, the crontable, the \`/interject\` callers`),
    ci("the host crontab's `curl` lines included"),
    code('access.json'),
    ci('the Slack token environment variables'),
  ]],
  ['step 8', "a file whose switch-over step 1 copy is missing is rebuilt by hand from the persona configuration, reversing the manual conversion (hatch A3)", [
    ci("where switch-over step 1's copy of a file is missing, the operator rebuilds the pre-persona file by hand from the persona configuration"),
    ci('reversing the manual conversion'),
  ]],
  ['step 8', 'no tooling for the rebuild: none ships in either direction (hatch A3)', [
    ci('no tooling does this'),
    ci('ships no conversion tooling in either direction'),
  ]],
  ['step 9', "the previous CSCB started, then the host's autostart for CSCB re-enabled, recorded", [
    ci("start the previous CSCB, then re-enable the host's autostart for CSCB"),
    'claude-slack-channel-bots start',
    ci('record it in the switch-over log'),
  ]],
  ['step 9', "operator action: re-enabling the host's autostart for CSCB", [ci(`autostart for CSCB ${OPERATOR_ACTION}`)]],
]

/** The steps that send a human beyond `agent-director kill`, each naming agent-director's "Operator actions" by title (SRJ-1109). */
const OPERATOR_ACTIONS_STEPS: readonly number[] = [3, 4, 5]

/**
 * What in a rollback step-8 text names a tool or command for the rebuild by
 * hand (hatch A3): a fenced block other than the previous CSCB's reinstall, a
 * code span naming a script or a CSCB subcommand, a link to a file, or
 * conversion wording tied to a tool, script or command. A link to a heading
 * of `README.md` is the CHANGELOG copy's form of the README's same-file link
 * (b.jg5 SRJ-1107), not a file. Takes the flattened step text. Pure; `[]`
 * when none.
 */
function conversionToolsIn(stepText: string): string[] {
  const REINSTALL = /^bun install -g claude-slack-channel-bots@<[^>]+>$/
  const blocks = [...stepText.matchAll(/```\w*\s(.*?)\s?```/g)].map((m) => m[1].trim())
  const prose = stepText.replace(/```\w*\s.*?\s?```/g, ' ')
  return [
    ...blocks.filter((body) => !REINSTALL.test(body)).map((body) => `fenced block: ${body}`),
    ...[...prose.matchAll(/`[^`]*(?:\.(?:sh|ts|js|py)\b|claude-slack-channel-bots\s+\w)[^`]*`/g)].map((m) => `code span: ${m[0]}`),
    ...markdownLinks(prose)
      .filter((link) => link.path !== '' && !(link.path === 'README.md' && link.anchor !== ''))
      .map((link) => `link to a file: ${link.target}`),
    ...[...prose.matchAll(/\b(?:conver\w*|migrat\w*)\b[^.]*\b(?:tool|script|command|subcommand)s?\b|\b(?:tool|script|command|subcommand)s?\b[^.]*\bconver\w*/gi)].map((m) => `wording: ${m[0]}`),
  ]
}

/** The README heading `anchor` resolves to, as GitHub assigns anchors; undefined when none does. */
function headingAt(readme: string, anchor: string): Heading | undefined {
  const index = headingAnchors(readme).indexOf(anchor)
  return index < 0 ? undefined : headings(readme)[index]
}

/** The inline links in `text`, each with its link text and its target split as `markdownLinks` splits it. */
function linksWithText(text: string): { text: string; path: string; anchor: string; target: string }[] {
  return [...text.matchAll(/\[([^\]]*)\]\(([^)\s]+)\)/g)].map(([, linkText, target]) => ({ text: linkText, ...markdownLinks(`](${target})`)[0] }))
}

/**
 * What is wrong with the rollback section's heading (b.jg5 SRJ-1109): exactly
 * one heading carries `ROLLBACK_RUNBOOK_SECTION_TITLE`, at `###`, inside
 * `## Migration`, after the switch-over section ends. Pure; `[]` when all holds.
 */
function rollbackTitleProblems(readme: string): string[] {
  const titled = headings(readme).filter((h) => h.title === ROLLBACK_RUNBOOK_SECTION_TITLE)
  if (titled.length !== 1) return [`${titled.length} README headings are titled "${ROLLBACK_RUNBOOK_SECTION_TITLE}", expected 1`]
  const [heading] = titled
  const problems: string[] = []
  if (heading.text !== ROLLBACK_HEADING) problems.push(`"${heading.text}" is not "${ROLLBACK_HEADING}"`)
  const migration = sectionRange(readme, MIGRATION_HEADING)
  if (migration === undefined || heading.line <= migration.start || heading.line >= migration.end) {
    problems.push(`"${heading.text}" is not under "${MIGRATION_HEADING}"`)
  }
  const switchOver = sectionRange(readme, SWITCH_OVER_HEADING)
  if (switchOver === undefined || heading.line < switchOver.end) problems.push(`"${heading.text}" is not after "${SWITCH_OVER_HEADING}"`)
  return problems
}

/**
 * Ruling C-2 (hatch A3): the switch-over runbook's pointers to the rollback
 * runbook are links that resolve. Each pointer phrase, wherever it is
 * written, must be the text of a link resolving to its target: the frame's
 * "rolled back together, by "<title>"" and the refusal block's
 * "follow "<title>"" to the rollback heading, and the refusal block's
 * "step 8 of "<title>"" to rollback step 8; each must be written at least
 * once. The refusal block also links rollback step 4, whose restart it names.
 * Pure; `[]` when all holds.
 */
function rollbackPointerProblems(readme: string): string[] {
  const rollback = sectionRange(readme, ROLLBACK_HEADING)
  if (rollback === undefined) return [`README.md has no heading "${ROLLBACK_HEADING}"`]
  const switchOver = requiredSection(readme, SWITCH_OVER_HEADING, 'README.md')
  const lines = switchOver.split('\n')
  const first = headings(switchOver)[0]
  const frame = flat(lines.slice(0, first === undefined ? lines.length : first.line).join('\n'))
  const block = flat(requiredSection(switchOver, `#### ${REFUSAL_BLOCK_HEADING}`, `README.md, under "${SWITCH_OVER_HEADING}",`))
  const isSection = (h: Heading) => h.text === ROLLBACK_HEADING
  const isStep = (n: number) => (h: Heading) => h.line > rollback.start && h.line < rollback.end && h.level === 4 && stepNumberOf(h.title) === n
  const title = escapeRegExp(`"${ROLLBACK_RUNBOOK_SECTION_TITLE}"`)
  const pointers: [where: string, text: string, phrase: RegExp, target: string, resolves: (h: Heading) => boolean][] = [
    ['the switch-over frame', frame, new RegExp(`rolled back together, by ${title}`, 'gi'), 'the rollback section', isSection],
    [`"${REFUSAL_BLOCK_HEADING}"`, block, new RegExp(`follow ${title}`, 'gi'), 'the rollback section', isSection],
    [`"${REFUSAL_BLOCK_HEADING}"`, block, new RegExp(`step 8 of ${title}`, 'gi'), 'rollback step 8', isStep(8)],
  ]
  const problems: string[] = []
  for (const [where, text, phrase, target, resolves] of pointers) {
    const written = [...text.matchAll(phrase)].length
    const linked = linksWithText(text)
      .filter((link) => link.path === '')
      .filter((link) => {
        const h = headingAt(readme, link.anchor)
        return h !== undefined && resolves(h)
      })
      .reduce((n, link) => n + [...link.text.matchAll(phrase)].length, 0)
    if (written === 0) problems.push(`${where} never writes ${String(phrase)}`)
    else if (linked !== written) problems.push(`${where}: ${written - linked} of ${written} pointers ${String(phrase)} are not links resolving to ${target}`)
  }
  const step4 = linksWithText(block).filter((link) => {
    const h = link.path === '' ? headingAt(readme, link.anchor) : undefined
    return h !== undefined && isStep(4)(h)
  })
  if (step4.length === 0) problems.push(`"${REFUSAL_BLOCK_HEADING}" has no link resolving to rollback step 4`)
  return problems
}

describe(`the rollback runbook, "${ROLLBACK_RUNBOOK_SECTION_TITLE}" (b.jg5 SRJ-1109)`, () => {
  const readme = readRepoFile('README.md')

  test('exactly one README heading carries the rollback title, a `###` under `## Migration`, after the switch-over section', () => {
    expect(rollbackTitleProblems(readme)).toEqual([])
  })

  test.each([
    ['re-levelled', (text: string) => text.replace(`${ROLLBACK_HEADING}\n`, `#${ROLLBACK_HEADING}\n`), 'is not "'],
    ['duplicated', (text: string) => `${text}\n${ROLLBACK_HEADING}\n`, '2 README headings'],
    ['placed before the switch-over section', (text: string) => text.replace(`${ROLLBACK_HEADING}\n`, '').replace(`${SWITCH_OVER_HEADING}\n`, `${ROLLBACK_HEADING}\n\n${SWITCH_OVER_HEADING}\n`), 'is not after'],
  ])('self-check: with the rollback heading %s, the title case fails', (_how, edit, problem) => {
    const edited = edit(readme)
    expect(edited).not.toBe(readme)
    expect(rollbackTitleProblems(edited).join('\n')).toContain(problem)
  })

  test.each(ROLLBACK_CARRIERS)(`%s: the section reads as steps 1 to ${ROLLBACK_STEP_COUNT}, in order, one heading level below it`, (_name, read) => {
    expect(read().steps).toHaveLength(ROLLBACK_STEP_COUNT)
  })

  describe('the step reader on the rollback section (self-checks, on edited README text)', () => {
    const start = readme.indexOf(`${ROLLBACK_HEADING}\n`)
    /** The README with `edit` applied to the rollback section and what follows it only. */
    const inRollback = (edit: (rest: string) => string) => readme.slice(0, start) + edit(readme.slice(start))
    const step = (n: number) => `#### ${stepHeadingPrefix(n)}`
    test.each([
      ['missing', inRollback((rest) => rest.replace(step(7), '#### Then: ')), 'step 7 is missing'],
      ['duplicated', inRollback((rest) => rest.replace(step(8), step(7))), 'step 7 appears 2 times'],
      ['out of order', inRollback((rest) => rest.replace(step(7), '#### SWAP: ').replace(step(8), step(7)).replace('#### SWAP: ', step(8))), 'step 8 is out of order'],
      ['beyond the count', inRollback((rest) => rest.replace(step(9), `${step(10)}Extra\n\n${step(9)}`)), 'step 10 is beyond the expected 9 steps'],
    ])('a rollback step %s fails naming the rollback section and the step', (_how, text, message) => {
      expect(start).toBeGreaterThan(0)
      expect(() => readRunbookCarrier('README.md', text, ROLLBACK_HEADING, ROLLBACK_STEP_COUNT)).toThrow(`README.md "${ROLLBACK_HEADING}": ${message}`)
    })
  })

  test.each(overRollbackCarriers(ROLLBACK_ELEMENTS))('%s, rollback %s: %s', (carrierName, where, element, required, read) => {
    const carrier = read()
    expect({ carrier: carrierName, runbook: 'rollback', where, element, missing: missingItems(carrier, textAt(carrier, where), required) }).toEqual({
      carrier: carrierName,
      runbook: 'rollback',
      where,
      element,
      missing: [],
    })
  })

  describe('order rows', () => {
    const ORDERS: [step: number, label: string, order: RegExp[]][] = [
      [6, "step 6 stops every other agent and confirms it, then restores with the recipe, then starts the agents again on the previous binary", [
        ci('stop every other agent on the host'),
        ci("shows each stopped agent's row"),
        ci('restore the previous agent-director'),
        ci(vocab('downgradeRecipe')),
        ci('started again by its owner on the previous binary'),
      ]],
      [8, 'step 8 moves the last-applied record and the retired keys aside, then reinstalls the previous CSCB, then puts back the saved files', [
        ci('move aside'),
        ci('reinstall the previous CSCB'),
        ci('bun install -g claude-slack-channel-bots@'),
        ci('put back what switch-over step 1 saved'),
      ]],
      [9, "step 9 starts the previous CSCB, then re-enables the host's autostart for CSCB", [ci('start the previous CSCB'), ci("re-enable the host's autostart for CSCB")]],
    ]

    test.each(overRollbackCarriers(ORDERS))('%s, step %d: %s, in that order', (_name, n, _label, order, read) => {
      const text = read().steps[n - 1]
      const at = order.map((pattern) => text.search(pattern))
      expect(order.filter((_, i) => at[i] < 0).map(String)).toEqual([])
      expect(at).toEqual([...at].sort((a, b) => a - b))
    })
  })

  describe('cross-step rows', () => {
    test.each(ROLLBACK_CARRIERS)('%s: the section never names `tmux kill-session` (SRJ-1101 allows it only in switch-over steps 5 and 6)', (_name, read) => {
      expect(flat(read().section)).not.toMatch(/tmux kill-session/)
    })

    test.each(ROLLBACK_CARRIERS)('%s: the section never names include-finished, nor agent-director delete (SRJ-1101)', (_name, read) => {
      const section = flat(read().section)
      expect(section).not.toMatch(/include[-_]finished/)
      expect(section).not.toMatch(/agent-director delete\b/)
    })

    test.each(overRollbackCarriers(OPERATOR_ACTIONS_STEPS.map((n) => [n] as const)))(
      `%s: step %d, which sends a human beyond \`agent-director kill\`, names ${vocab('operatorActions')} by title`,
      (_name, n, read) => {
        expect(read().steps[n - 1]).toContain(vocab('operatorActions'))
      },
    )

    test.each(overRollbackCarriers(UPGRADE_FORMS.map(([label, pattern]) => [label, pattern] as const)))(
      "%s: step 6's restore item carries no %s: the recipe is agent-director's, named, never spelled out",
      (_name, _label, pattern, read) => {
        expect(textAt(read(), 'step 6 › Restore the previous agent-director')).not.toMatch(pattern)
      },
    )

    test.each(ROLLBACK_CARRIERS)('%s: step 8 names no conversion tool or command for the rebuild by hand (hatch A3)', (_name, read) => {
      expect(conversionToolsIn(read().steps[7])).toEqual([])
    })

    test.each([
      ['a CSCB subcommand', 'Rebuild it with `claude-slack-channel-bots unpersona`.', 'code span'],
      ['a script', 'Run `scripts/unpersona.sh` on the file.', 'code span'],
      ['a fenced command', 'Rebuild it: ```sh cscb-convert config.json ```', 'fenced block'],
      ['a link to a file', 'See [the helper](tools/rebuild.ts).', 'link to a file'],
      ['conversion wording tied to a tool', 'Run the conversion tool on the persona configuration.', 'wording'],
    ])('self-check (hatch A3): a step 8 naming %s is flagged', (_label, text, kind) => {
      expect(conversionToolsIn(flat(`Reinstall: \`\`\`sh bun install -g claude-slack-channel-bots@<v> \`\`\` ${text}`)).map((found) => found.split(':')[0])).toEqual([kind])
    })

    test.each([
      ['a same-file heading link', '(see [Upgrading to personas](#upgrading-to-personas))', []],
      ["a README heading link, the CHANGELOG copy's form of it (SRJ-1107)", '(see [Upgrading to personas](README.md#upgrading-to-personas))', []],
      ['a link to the README file itself', '(see [the README](README.md))', ['link to a file']],
    ] as const)('self-check (hatch A3): a step 8 with %s', (_label, text, kinds) => {
      expect(conversionToolsIn(flat(`Rebuild it by hand ${text}.`)).map((found) => found.split(':')[0])).toEqual([...kinds])
    })
  })

  describe('README.md: ruling C-2 and the runbooks\' links', () => {
    test("the switch-over runbook's pointers to the rollback runbook and its step 8 are links that resolve (ruling C-2; hatch A3)", () => {
      expect(rollbackPointerProblems(readme)).toEqual([])
    })

    test.each([
      ['rollback step 8 renamed', (text: string) => text.replace(`#### ${stepHeadingPrefix(8)}Reinstall`, `#### ${stepHeadingPrefix(8)}Put back`), 'rollback step 8'],
      ['a step 8 pointer unlinked', (text: string) => text.replace(/\[(step 8 of "[^"]+")\]\(#[^)]+\)/, '$1'), '1 of 2 pointers'],
      ['the frame pointer unlinked', (text: string) => text.replace(/\[(rolled back together, by "[^"]+")\]\(#[^)]+\)/, '$1'), 'the switch-over frame'],
    ])('self-check (ruling C-2): with %s, the pointer case fails', (_how, edit, problem) => {
      const edited = edit(readme)
      expect(edited).not.toBe(readme)
      expect(rollbackPointerProblems(edited).join('\n')).toContain(problem)
    })

    test.each([SWITCH_OVER_HEADING, ROLLBACK_HEADING])('every same-file link in "%s" resolves to a README heading', (heading) => {
      const section = requiredSection(readme, heading, 'README.md')
      const anchors = headingAnchors(readme)
      const links = linksWithText(section).filter((link) => link.path === '')
      expect(links.length).toBeGreaterThan(0)
      expect(links.filter((link) => !anchors.includes(link.anchor)).map((link) => link.target)).toEqual([])
    })

    test('each "switch-over step <n>" link in the rollback section resolves to that step of the switch-over section', () => {
      const switchOver = sectionRange(readme, SWITCH_OVER_HEADING)
      if (switchOver === undefined) throw new Error(`README.md has no heading "${SWITCH_OVER_HEADING}"`)
      const links = linksWithText(requiredSection(readme, ROLLBACK_HEADING, 'README.md')).filter((link) => link.path === '' && /^switch-over step \d+$/i.test(link.text))
      expect(links.length).toBeGreaterThan(0)
      const wrong = links.filter((link) => {
        const h = headingAt(readme, link.anchor)
        return h === undefined || h.line <= switchOver.start || h.line >= switchOver.end || stepNumberOf(h.title) !== Number(/\d+$/.exec(link.text)![0])
      })
      expect(wrong.map((link) => `[${link.text}](${link.target})`)).toEqual([])
    })

    test('docs/registry-install-runbook.md links both runbook sections, and the links resolve', () => {
      const anchors = markdownLinks(readRepoFile('docs/registry-install-runbook.md'))
        .filter((link) => link.path === '../README.md')
        .map((link) => link.anchor)
      for (const heading of [SWITCH_OVER_HEADING, ROLLBACK_HEADING]) {
        const anchor = headingSlug(heading.slice('### '.length))
        expect(anchors).toContain(anchor)
        expect(headingAt(readme, anchor)?.text).toBe(heading)
      }
    })
  })
})

// ---------------------------------------------------------------------------
// The CHANGELOG release entry (b.jg5 SRJ-1107; hatch A3), read through OPERATOR_TEXTS
// ---------------------------------------------------------------------------

/** The CHANGELOG's release entry: the first `##` section's body. Throws when the file has no `##` heading. */
function releaseEntry(changelog: string): string {
  const first = headings(changelog).find((h) => h.level === 2)
  if (first === undefined) throw new Error(`${CHANGELOG_FILE} has no \`##\` release entry`)
  return requiredSection(changelog, first.text, CHANGELOG_FILE)
}

/** The release entry's notes: the entry without its two runbook copies, so a note is never found in a runbook's words. */
function releaseNotes(changelog: string): string {
  const entry = releaseEntry(changelog)
  const ranges = [SWITCH_OVER_HEADING, ROLLBACK_HEADING].flatMap((heading) => sectionRange(entry, heading) ?? [])
  return entry
    .split('\n')
    .filter((_, i) => !ranges.some((range) => i >= range.start && i < range.end))
    .join('\n')
}

/** `text` with each inline link replaced by its link text. */
function linkTexts(text: string): string {
  return text.replace(/\[([^\]]*)\]\([^)\s]+\)/g, '$1')
}

/**
 * `text`'s units, flattened: each heading, list item (with its continuation
 * lines) and paragraph. A unit that ends with a colon is read together with
 * the one it introduces (a list item or a fenced command), so an instruction
 * and its command are one unit. Pure.
 */
function textUnits(text: string): string[] {
  const units: string[][] = []
  let open = false
  for (const line of text.split('\n')) {
    if (line.trim() === '') {
      open = false
      continue
    }
    const heading = /^#{1,6}\s/.test(line)
    if (!open || heading || /^\s*(?:[-*]|\d+\.)\s/.test(line)) units.push([line])
    else units[units.length - 1].push(line)
    open = !heading
  }
  return units
    .map((lines) => flat(lines.join('\n')).trim())
    .reduce<string[]>((out, unit) => {
      if (out.length > 0 && out[out.length - 1].endsWith(':')) out[out.length - 1] += ` ${unit}`
      else out.push(unit)
      return out
    }, [])
}

/** Each of `required` that `text` lacks, as a problem line. */
function lacking(text: string, required: readonly (string | RegExp)[]): string[] {
  return required.filter((item) => (typeof item === 'string' ? !text.includes(item) : !item.test(text))).map((item) => `lacks ${String(item)}`)
}

/** `check`'s problems on the one release-note unit matching `anchor`, or a problem naming the anchor unless exactly one unit does. */
function noteUnitProblems(changelog: string, anchor: RegExp, check: (unit: string) => string[]): string[] {
  const units = textUnits(releaseNotes(changelog)).filter((unit) => anchor.test(unit))
  if (units.length !== 1) return [`${units.length} release-note units match ${String(anchor)}, expected 1`]
  return check(units[0])
}

/** The heading title of b.ob2's dropped section (SRJ-1107: replaced by the switch-over runbook). */
const UPGRADE_STEPS_TITLE = 'Upgrade steps'

/** Each heading titled `UPGRADE_STEPS_TITLE` in `text`, and each link to its anchor. Pure. */
function upgradeStepsProblems(text: string): string[] {
  return [
    ...headings(text).filter((h) => h.title.toLowerCase() === UPGRADE_STEPS_TITLE.toLowerCase()).map((h) => `heading "${h.text}"`),
    ...markdownLinks(text).filter((link) => link.anchor === headingSlug(UPGRADE_STEPS_TITLE)).map((link) => `link (${link.target})`),
  ]
}

/** b.ob2's wording for the prompt-open relaunch, which SRJ-1107 replaces with a check through agent-director. */
const TMUX_FIRST = ci('checks its tmux session first')

/** Each "checks its tmux session first" in `text`, flattened. Pure. */
function tmuxFirstProblems(text: string): string[] {
  return [...flat(text).matchAll(new RegExp(TMUX_FIRST.source, 'gi'))].map((m) => m[0])
}

/** A word that tells the reader to delete a file. */
const DELETE_WORDS = /\b(?:delet\w*|remov\w*|rm|eras\w*|discard\w*)\b/i

/** SRJ-1107's breaking note, one row per part, each found in the release notes' text with links read as their text. */
const BREAKING_NOTE: [part: string, pattern: RegExp][] = [
  ['this release requires agent-director Phase 1 or later', ci('requires agent-director Phase 1 or later')],
  ['it exits at startup on an older binary', ci('exits at startup on an older agent-director binary')],
  ['no older CSCB may run on the Phase 1 binary', ci('no older CSCB may run on the Phase 1 binary')],
  ['the two are installed, and rolled back, together', /\binstalled together\b[^.]*\brolled back together\b/i],
  ['every agent and long-running agent-director process is stopped before either binary change and started again after it (HO C15; ADA question 9)', ci(
    'every agent on the host, with every long-running agent-director process, is stopped before either binary change and started again after it',
  )],
]

/** An agent-director version named in prose ("agent-director <version>"), its version captured; a sentence's closing full stop is not taken. */
const AD_NAMED_VERSION = /\bagent-director v?(\d+\.\d+\.\d+(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?)/g

/** The release entry's row-deletion note: the one note naming agent-director's admin binary. */
const ROW_DELETION_ELEMENT = 'the row-deletion note names `agent-director-admin`, and the agent-director version it names is the Phase 1 floor'

/**
 * One row per SRJ-1107 element of the release entry: its name and its check,
 * which returns the CHANGELOG text's problems (`[]` when the element holds).
 * Each check is self-checked below on the CHANGELOG with that element reverted
 * to b.ob2's wording, or, for an element b.ob2 lacked, broken.
 */
const RELEASE_ENTRY_CHECKS: [element: string, problems: (changelog: string) => string[]][] = [
  ['exactly one unreleased entry, the first `##` entry in the file', (changelog) => {
    const entries = headings(changelog).filter((h) => h.level === 2)
    const unreleased = entries.filter((h) => /\bunreleased\b/i.test(h.title))
    return [
      ...(unreleased.length === 1 ? [] : [`${unreleased.length} unreleased \`##\` entries, expected 1`]),
      ...(entries.length > 0 && unreleased.includes(entries[0]) ? [] : [`the first \`##\` entry, "${entries[0]?.text}", is not an unreleased one`]),
    ]
  }],
  ...BREAKING_NOTE.map(([part, pattern]): [string, (changelog: string) => string[]] => [
    `the breaking note: ${part}`,
    (changelog) => lacking(flat(linkTexts(releaseNotes(changelog))), [pattern]),
  ]),
  ['`access.json` is kept until rollback is no longer wanted, because the previous CSCB reads it', (changelog) =>
    lacking(flat(releaseNotes(changelog)), [ci('keep `access.json` until rollback is no longer wanted, because the previous CSCB reads it')])],
  ['nothing in the file tells the reader to delete `access.json`', (changelog) =>
    textUnits(changelog).filter((unit) => /\baccess\.json\b/.test(unit) && DELETE_WORDS.test(unit)).map((unit) => `a delete instruction: ${unit}`)],
  ['the prompt-open relaunch note says the server checks the session through agent-director', (changelog) =>
    noteUnitProblems(changelog, ci('prompt or question open'), (unit) => lacking(unit, [ci('checks the session through agent-director')]))],
  [`the note "The server's own tmux commands act only on a bot's own session" is gone (E17, E18)`, (changelog) =>
    [...flat(changelog).matchAll(/the server's own tmux commands/gi)].map((m) => `the dropped note is back: ${m[0]}`)],
  [`the prefix-key note's reason does not name agent-director ${OLD_AD_VERSION} (SRJ-1102)`, (changelog) =>
    noteUnitProblems(changelog, ci("may start with another persona's key"), (unit) => (unit.includes(OLD_AD_VERSION) ? [`names ${OLD_AD_VERSION}: ${unit}`] : []))],
  ['the fresh-once note stays, its rows kept and never resumed, pointing to the switch-over runbook', (changelog) =>
    noteUnitProblems(changelog, ci('starts fresh once'), (unit) => [
      ...lacking(unit, [/\brows? (?:are|is) kept\b/i, ci('never resumed')]),
      ...(linksWithText(unit).some((link) => link.anchor === headingSlug(PHASE1_RUNBOOK_SECTION_TITLE) && (link.path === '' || link.path === 'README.md'))
        ? []
        : [`no link to "${PHASE1_RUNBOOK_SECTION_TITLE}"`]),
    ])],
  [ROW_DELETION_ELEMENT, (changelog) =>
    noteUnitProblems(changelog, ci(code('agent-director-admin')), (unit) => {
      const versions = [...unit.matchAll(AD_NAMED_VERSION)].map((m) => m[1])
      return [
        ...(versions.length > 0 ? [] : ['names no agent-director version']),
        ...versions.filter((v) => v !== PHASE1_FLOOR_VERSION).map((v) => `names agent-director ${v}, not the Phase 1 floor ${PHASE1_FLOOR_VERSION}`),
      ]
    })],
]

/** One release-entry check by its element; throws naming an element the table lacks. */
function releaseCheck(element: string): (changelog: string) => string[] {
  const row = RELEASE_ENTRY_CHECKS.find(([name]) => name === element)
  if (row === undefined) throw new Error(`RELEASE_ENTRY_CHECKS has no element "${element}"`)
  return row[1]
}

/**
 * The names the hatch-note entries introduce (the Task's ruling: only these
 * are pinned, each through the `src/` export that defines it, no sentence
 * pinned), with the Epic and source of each.
 */
const HATCH_NOTE_NAMES: [name: string, source: string][] = [
  [CLEAR_LATCH_COMMAND, 'E31: src/clear-latch.ts CLEAR_LATCH_COMMAND (SRJ-509)'],
  [SERVER_PORT_FILE_NAME, 'E31: src/clear-latch.ts SERVER_PORT_FILE_NAME (SRJ-510)'],
  [CLI_TEARDOWN_FAILED_LABEL, 'E33: src/cli-teardown.ts CLI_TEARDOWN_FAILED_LABEL (SRJ-909, SRJ-1013)'],
  [PERSONA_KILL_FAILED_LABEL, 'E33: src/kill-failure-alert.ts PERSONA_KILL_FAILED_LABEL (SRJ-1013)'],
  [PERSONA_KILL_SURVIVOR_LABEL, 'E33: src/kill-failure-alert.ts PERSONA_KILL_SURVIVOR_LABEL (SRJ-1013)'],
  [CLEAN_RESTART_NOT_RESTARTED_LABEL, 'E33: src/cli-teardown.ts CLEAN_RESTART_NOT_RESTARTED_LABEL (SRJ-906, SRJ-1013)'],
  ...startSummaryCountLabels().map((label): [string, string] => [label, 'E26: src/session-manager.ts startupSummaryEnding (SRJ-1015)']),
]

/**
 * The start summary's five counts SRJ-1015 added, as src/session-manager.ts's
 * `startupSummaryEnding` writes them: each count given its own number, then
 * its label read after that number. Throws naming a count it can't find.
 */
function startSummaryCountLabels(): string[] {
  const numbered = { failed: 1, notBroughtUp: 2, notReconnected: 3, latched: 4, retrying: 5, sequenceWaiting: 6, held: 7, freshRetired: 8 }
  const parts = startupSummaryEnding(numbered).split(', ')
  return (['latched', 'retrying', 'sequenceWaiting', 'held', 'freshRetired'] as const).map((key) => {
    const part = parts.find((p) => p.startsWith(`${numbered[key]} `))
    if (part === undefined) throw new Error(`startupSummaryEnding wrote no "${numbered[key]} …" part for ${key}`)
    return part.slice(`${numbered[key]} `.length)
  })
}

/** Every link from `text` (the repository-root `file`) that resolves nowhere: a same-file anchor `text` lacks, or a repository file or its heading that does not exist. */
function brokenRepoLinks(file: string, text: string): { checked: number; broken: string[] } {
  const own = headingAnchors(text)
  const links = markdownLinks(text).filter((link) => !/^[a-z][a-z0-9+.-]*:/i.test(link.path))
  const broken = links.flatMap((link) => {
    if (link.path === '') return own.includes(link.anchor) ? [] : [`${file} -> ${link.target} (no such heading in ${file})`]
    const target = resolve(REPO_ROOT, link.path)
    if (!existsSync(target)) return [`${file} -> ${link.target} (no such file)`]
    if (link.anchor === '') return []
    return headingAnchors(readFileSync(target, 'utf-8')).includes(link.anchor) ? [] : [`${file} -> ${link.target} (no such heading in ${link.path})`]
  })
  return { checked: links.length, broken }
}

/** Each part of a runbook section (its text before the first subsection, then each subsection by heading), flattened, for a word-for-word comparison. */
function sectionChunks(section: string): { heading: string; text: string }[] {
  const lines = section.split('\n')
  const hs = headings(section)
  return [-1, ...hs.map((h) => h.line)].map((start, k) => ({
    heading: k === 0 ? '(before the first subsection)' : hs[k - 1].text,
    text: flat(lines.slice(start + 1, k < hs.length ? hs[k].line : lines.length).join('\n')).trim(),
  }))
}

/** The line of a CHANGELOG runbook copy that names the README section as the maintained copy. */
const MAINTAINED_COPY = ci('is the maintained copy of this runbook')

/** A CHANGELOG runbook copy as the README writes it: its maintained-copy line dropped, and each `README.md#` link read as a same-file link. */
function asReadmeText(section: string): string {
  return section
    .split('\n')
    .filter((line) => !MAINTAINED_COPY.test(line))
    .join('\n')
    .replaceAll('](README.md#', '](#')
}

/** The two runbooks the release entry copies: each section's title and heading. */
const RUNBOOK_COPIES: [title: string, heading: string][] = [
  [PHASE1_RUNBOOK_SECTION_TITLE, SWITCH_OVER_HEADING],
  [ROLLBACK_RUNBOOK_SECTION_TITLE, ROLLBACK_HEADING],
]

describe('the CHANGELOG release entry, read through OPERATOR_TEXTS (b.jg5 SRJ-1107; SRJ-1101 list)', () => {
  const changelog = () => operatorText(CHANGELOG_FILE)

  describe('OPERATOR_TEXTS', () => {
    test("holds exactly SRJ-1101's seven operator texts, each read from the repository", () => {
      expect(OPERATOR_TEXTS.map(([name]) => name)).toEqual([
        'README.md',
        'skills/debug-slack-channel-bots/SKILL.md',
        'skills/install-cscb/SKILL.md',
        'skills/setup-slack-channel-bots/SKILL.md',
        'docs/architecture.md',
        'docs/engineering-guide.md',
        'CHANGELOG.md',
      ])
      expect(OPERATOR_TEXTS.filter(([, read]) => read().trim() === '').map(([name]) => name)).toEqual([])
    })

    test('SHIPPED_TEXTS, which the forbidden-term audit reads, still holds neither the CHANGELOG nor any docs/ file', () => {
      expect(SHIPPED_TEXTS.map(([name]) => name).filter((name) => name === CHANGELOG_FILE || name.startsWith('docs/'))).toEqual([])
    })

    test.each(OPERATOR_TEXTS)(`%s: no heading titled "${UPGRADE_STEPS_TITLE}" and no link to its anchor (SRJ-1107)`, (_name, read) => {
      expect(upgradeStepsProblems(read())).toEqual([])
    })

    test.each(OPERATOR_TEXTS)('%s: no "checks its tmux session first" (SRJ-1107)', (_name, read) => {
      expect(tmuxFirstProblems(read())).toEqual([])
    })

    test.each([
      ['a heading', `### ${UPGRADE_STEPS_TITLE}\n\nTake these steps in order.`, upgradeStepsProblems, [`heading "### ${UPGRADE_STEPS_TITLE}"`]],
      ['a link to its anchor', `Stop the old bots (step 1 of [${UPGRADE_STEPS_TITLE}](#${headingSlug(UPGRADE_STEPS_TITLE)})).`, upgradeStepsProblems, [`link (#${headingSlug(UPGRADE_STEPS_TITLE)})`]],
      ['the relaunch wording, wrapped', 'but the server checks its tmux\nsession first and relaunches it', tmuxFirstProblems, ['checks its tmux session first']],
    ] as const)("self-check: b.ob2's %s is reported", (_label, text, problems, expected) => {
      expect(problems(text)).toEqual([...expected])
    })
  })

  describe('the release entry', () => {
    test.each(RELEASE_ENTRY_CHECKS)('%s', (element, problems) => {
      expect({ element, problems: problems(changelog()) }).toEqual({ element, problems: [] })
    })

    const breakingNote = (text: string) => text.replace(/^### Requires agent-director Phase 1\n[\s\S]*?(?=^### )/m, '')
    const REVERTS: [element: string, how: string, edit: (text: string) => string][] = [
      [RELEASE_ENTRY_CHECKS[0][0], 'an earlier release entry placed first', (text) => text.replace(/^## /m, '## 1.0.0\n\nAn earlier release.\n\n## ')],
      [RELEASE_ENTRY_CHECKS[0][0], 'a second unreleased entry', (text) => `${text}\n## Unreleased (patch)\n\nMore.\n`],
      ...BREAKING_NOTE.map(([part]): [string, string, (text: string) => string] => [`the breaking note: ${part}`, "the breaking note dropped, as in b.ob2's entry", breakingNote]),
      ['`access.json` is kept until rollback is no longer wanted, because the previous CSCB reads it', 'the keep sentence dropped', (text) =>
        text.replace(/ Keep `access\.json` until rollback is no longer wanted, because the previous CSCB reads it\./, '')],
      ['nothing in the file tells the reader to delete `access.json`', "b.ob2's upgrade note back", (text) =>
        `${text}\n### Upgrade note: leftover \`access.json\`\n\nAn upgraded host keeps any existing \`access.json\` in the state directory. The server never reads it, so it is an ignored file. Delete it by hand once the personas are running:\n\n\`\`\`sh\nrm "\${SLACK_STATE_DIR:-$HOME/.claude/channels/slack}/access.json"\n\`\`\`\n`],
      ['the prompt-open relaunch note says the server checks the session through agent-director', "b.ob2's tmux-first wording", (text) =>
        text.replace('checks the session through agent-director', 'checks its tmux session first')],
      [RELEASE_ENTRY_CHECKS.find(([e]) => e.startsWith('the note "'))![0], "b.ob2's note back", (text) =>
        text.replace(/^- \*\*One stuck persona/m, "- **The server's own tmux commands act only on a bot's own session.** When the server ends a bot's leftover tmux session before a relaunch, it now names the session exactly.\n- **One stuck persona")],
      [RELEASE_ENTRY_CHECKS.find(([e]) => e.startsWith("the prefix-key note's"))![0], "b.ob2's reason", (text) =>
        text.replace(/The reason: [^\n]*?could reach another persona's session\./, `agent-director ${OLD_AD_VERSION} finds a persona's tmux session by a name that also matches the start of a longer one, so with such a pair it could read, type into or end the other persona's session.`)],
      ['the fresh-once note stays, its rows kept and never resumed, pointing to the switch-over runbook', "b.ob2's pointer to the upgrade steps", (text) =>
        text.replace(/(starts fresh once\.[^\n]*?)\(see \[[^\]]*\]\([^)]*\)\)/i, `$1(step 1 of [${UPGRADE_STEPS_TITLE}](#${headingSlug(UPGRADE_STEPS_TITLE)}))`)],
      [ROW_DELETION_ELEMENT, 'another agent-director version named', (text) =>
        text.replace(`agent-director ${PHASE1_FLOOR_VERSION}, its Phase 1 release`, `agent-director ${OLD_AD_VERSION}, its Phase 1 release`)],
      [ROW_DELETION_ELEMENT, 'a release candidate of the floor named', (text) =>
        text.replace(`agent-director ${PHASE1_FLOOR_VERSION}, its Phase 1 release`, `agent-director ${PHASE1_FLOOR_VERSION}-rc.1, its Phase 1 release`)],
      [ROW_DELETION_ELEMENT, 'no version named', (text) =>
        text.replace(`agent-director ${PHASE1_FLOOR_VERSION}, its Phase 1 release`, "agent-director's Phase 1 release")],
      [ROW_DELETION_ELEMENT, '`agent-director-admin` dropped', (text) =>
        text.replace('its separate `agent-director-admin` binary', 'a separate binary')],
    ]

    test.each(REVERTS)('self-check: "%s" fails with %s', (element, _how, edit) => {
      const text = changelog()
      const edited = edit(text)
      expect(edited).not.toBe(text)
      expect(releaseCheck(element)(edited)).not.toEqual([])
    })

    test.each(HATCH_NOTE_NAMES)('the release notes name %s as a code span (%s)', (name) => {
      expect(flat(releaseNotes(changelog()))).toContain(code(name))
    })
  })

  describe('the runbook copies (SRJ-1107; hatch A3: the README is the maintained copy)', () => {
    test.each(RUNBOOK_COPIES)('the copy of "%s" names the README section as the maintained copy, by a link that resolves', (title, heading) => {
      const units = textUnits(requiredSection(releaseEntry(changelog()), heading, CHANGELOG_FILE)).filter((unit) => MAINTAINED_COPY.test(unit))
      expect(units).toHaveLength(1)
      const anchor = headingSlug(title)
      expect(linksWithText(units[0]).filter((link) => link.path === 'README.md' && link.anchor === anchor).map((link) => link.target)).toEqual([`README.md#${anchor}`])
      expect(headingAt(readRepoFile('README.md'), anchor)?.text).toBe(heading)
    })

    test.each(RUNBOOK_COPIES)("the copy of \"%s\" is the README section word for word, headings included, once its maintained-copy line is dropped and its README.md# links read as the README's own", (_title, heading) => {
      const readmeSection = requiredSection(readRepoFile('README.md'), heading, 'README.md')
      const copy = asReadmeText(requiredSection(releaseEntry(changelog()), heading, CHANGELOG_FILE))
      expect(sectionChunks(copy)).toEqual(sectionChunks(readmeSection))
    })

    // The audit reads only SHIPPED_TEXTS, so the README copies' token-variable check does not reach the CHANGELOG's.
    test.each(RUNBOOK_COPIES)('the copy of "%s" names no Slack token environment variable (SRJ-1516: the runbooks never name one)', (_title, heading) => {
      const group = FORBIDDEN_TERMS.find((g) => g.name === 'the token environment variables')
      if (group === undefined) throw new Error('FORBIDDEN_TERMS has no group "the token environment variables"')
      const section = requiredSection(releaseEntry(changelog()), heading, CHANGELOG_FILE)
      expect(findTerms(CHANGELOG_FILE, section, group.terms).map(formatHit)).toEqual([])
      expect(flat(section)).toMatch(ci('the Slack token environment variables'))
    })
  })

  describe('links', () => {
    test(`every link in ${CHANGELOG_FILE} resolves: a same-file anchor to a heading in it, a README.md or other repository link to an existing file and heading`, () => {
      const { checked, broken } = brokenRepoLinks(CHANGELOG_FILE, changelog())
      expect(broken).toEqual([])
      expect(checked).toBeGreaterThan(0)
    })

    test.each([
      [`a link to the removed "${GONE_TITLE}"`, `See [${GONE_TITLE}](README.md#${headingSlug(GONE_TITLE)}).`, `${CHANGELOG_FILE} -> README.md#${headingSlug(GONE_TITLE)} (no such heading in README.md)`],
      ['a same-file anchor with no heading', `See [${UPGRADE_STEPS_TITLE}](#${headingSlug(UPGRADE_STEPS_TITLE)}).`, `${CHANGELOG_FILE} -> #${headingSlug(UPGRADE_STEPS_TITLE)} (no such heading in ${CHANGELOG_FILE})`],
      ['a missing file', 'See [the notes](docs/no-such-file.md).', `${CHANGELOG_FILE} -> docs/no-such-file.md (no such file)`],
    ])('self-check: %s fails naming the link', (_label, text, problem) => {
      expect(brokenRepoLinks(CHANGELOG_FILE, text).broken).toEqual([problem])
    })
  })
})

// ---------------------------------------------------------------------------
// E36 T1: the kill-failure alerts' sentences (the E20 note) and the README's
// and debugging skill's raw-command and `auto-restart disabled` lines (the E8
// note), read through OPERATOR_TEXTS
// ---------------------------------------------------------------------------

/** The persona the rendered alerts concern. */
const ALERT_KEY = 'alpha'

/** Each version's closings: the survivor version has no latched one. */
const ALERT_CLOSINGS: Readonly<Record<KillFailureAlertVersion, readonly KillFailureClosing[]>> = Object.freeze({
  [KILL_FAILURE_VERSION_ORDINARY]: [
    KILL_FAILURE_CLOSING_DESTINATION,
    KILL_FAILURE_CLOSING_DESTINATION_LATCHED,
    KILL_FAILURE_CLOSING_CLI_TEARDOWN,
    KILL_FAILURE_CLOSING_LOG_ONLY,
  ],
  [KILL_FAILURE_VERSION_SURVIVOR]: [KILL_FAILURE_CLOSING_DESTINATION, KILL_FAILURE_CLOSING_CLI_TEARDOWN, KILL_FAILURE_CLOSING_LOG_ONLY],
})

/** An alert's title: the emoji and bold name it opens with (`:rotating_light: *Kill failed*`). File-local. */
const ALERT_TITLE = /^:[a-z_]+: \*[^*]+\*/

/**
 * SRJ-1001's human-only sentence, in the alerts' two wordings; one file-local
 * pattern, since the SRD's wordings differ. Every notice that names a command
 * or "Operator actions" carries it, so it is SRJ-1001's sentence, not the
 * alert's, and the engineering guide states it as the rule.
 */
const HUMAN_ONLY_SENTENCE = /(?:This is|These commands are) for a human only: no bot, including any persona that sees this post, may (?:act on|run) (?:it|them)\./g

/** The fewest words a checked sentence part has: a shorter one ("and check its result.") is common wording, not a quote. */
const MIN_QUOTE_WORDS = 5

/** One rendering of an alert: what it says, and the values in its text that vary (session, instance id, quoted descriptions, pids). */
interface AlertRendering {
  readonly content: KillFailureAlertContent
  readonly variables: readonly string[]
}

/**
 * Both versions rendered with the stub's descriptions: the ordinary version
 * with no description, with each `ErrTmuxKillFailed` description, and with
 * the last failure's and an earlier survivor-naming one; the survivor version
 * quoting its survivor-naming description.
 */
function killFailureAlertRenderings(): AlertRendering[] {
  const session = personaTmuxSessionName(ALERT_KEY)
  const instanceId = personaInstanceId(ALERT_KEY)
  const description = (d: (typeof KILL_FAILED_DESCRIPTIONS)[number]) => errTmuxKillFailed(session, d, STUB_SURVIVOR_PIDS).errDescription ?? ''
  const survivorDescription = description('pane-process-survived')
  const ordinary = (quotes?: { lastKillFailedDescription?: string; earlierSurvivorDescription?: string }): AlertRendering => ({
    content: { version: KILL_FAILURE_VERSION_ORDINARY, session, instanceId, ...(quotes === undefined ? {} : { quotes }) },
    variables: [session, instanceId, ...Object.values(quotes ?? {}).map((quote) => renderLogMessageText(quote))],
  })
  return [
    ordinary(),
    ...KILL_FAILED_DESCRIPTIONS.map((d) => ordinary({ lastKillFailedDescription: description(d) })),
    ordinary({ lastKillFailedDescription: description('outlived-exit-wait'), earlierSurvivorDescription: survivorDescription }),
    {
      content: { version: KILL_FAILURE_VERSION_SURVIVOR, session, survivorDescription },
      variables: [session, renderLogMessageText(survivorDescription), killFailureSurvivorPidList(survivorDescription)],
    },
  ]
}

/**
 * The sentence parts of an alert's `text` that an operator text may not
 * quote: `text` with its title, its closing sentences and the human-only
 * sentence taken out, cut at each varying value and split into sentences (at
 * `.` or `;`), each part of at least `MIN_QUOTE_WORDS` words (a word holds a
 * letter, so a lone quote mark or backtick is none).
 */
function quotableAlertParts(text: string, version: KillFailureAlertVersion, variables: readonly string[]): string[] {
  let rest = text.replace(ALERT_TITLE, '\n').replace(HUMAN_ONLY_SENTENCE, '\n')
  for (const closing of ALERT_CLOSINGS[version]) rest = rest.split(killFailureClosingSentence(version, closing)).join('\n')
  for (const value of [...variables].filter((v) => v !== '').sort((a, b) => b.length - a.length)) rest = rest.split(value).join('\n')
  return rest
    .split(/\n|(?<=[.;])\s+/)
    .map((part) => part.trim())
    .filter((part) => part.split(/\s+/).filter((word) => /[a-z]/i.test(word)).length >= MIN_QUOTE_WORDS)
}

/** Every [version, sentence part] of both alerts, over every rendering, closing and form, each once. */
const KILL_ALERT_PARTS: readonly (readonly [version: KillFailureAlertVersion, part: string])[] = (() => {
  const seen = new Set<string>()
  const parts: [KillFailureAlertVersion, string][] = []
  for (const { content, variables } of killFailureAlertRenderings()) {
    for (const closing of ALERT_CLOSINGS[content.version]) {
      for (const forSlack of [false, true]) {
        for (const part of quotableAlertParts(killFailureAlertText(content, closing, forSlack), content.version, variables)) {
          const key = `${content.version}\n${part}`
          if (!seen.has(key)) {
            seen.add(key)
            parts.push([content.version, part])
          }
        }
      }
    }
  }
  return parts
})()

/**
 * A run this many words long of an alert sentence is a quote of it, even
 * with the words around it changed (a sentence restated with "GONE" for
 * `ErrTmuxCaptureFailed` still quotes it). Shorter runs are wording a
 * passage may share with the alert because both repeat agent-director's
 * description ("no session or pane of this launch was found"), as the
 * debugging skill's own `read-pane` caveats do.
 */
const QUOTE_RUN_WORDS = 15

/** `text` for comparing words: lower case, Markdown's backticks and emphasis dropped, one space apart, padded with a space. */
function quoteComparable(text: string): string {
  return ` ${text.toLowerCase().replace(/[`*]/g, '').split(/\s+/).filter((word) => word !== '').join(' ')} `
}

/**
 * Whether `comparable` (from `quoteComparable`) quotes `part`: the whole
 * part (its edges may be cut at a varying value, so it is matched as is), or
 * any run of `QUOTE_RUN_WORDS` of its words, matched as whole words.
 */
function quotesAlertPart(comparable: string, part: string): boolean {
  const words = quoteComparable(part).trim().split(' ')
  if (comparable.includes(words.join(' '))) return true
  return Array.from({ length: Math.max(0, words.length - QUOTE_RUN_WORDS + 1) }, (_, i) => words.slice(i, i + QUOTE_RUN_WORDS)).some((run) =>
    comparable.includes(` ${run.join(' ')} `),
  )
}

/** Each alert sentence part `text` quotes (across line breaks and Markdown marks), as `<version>: <part>`. */
function alertPartsQuotedIn(text: string): string[] {
  const comparable = quoteComparable(text)
  return KILL_ALERT_PARTS.filter(([, part]) => quotesAlertPart(comparable, part)).map(([version, part]) => `${version}: ${part}`)
}

/** Each operator text, made comparable once. */
const COMPARABLE_OPERATOR_TEXTS = new Map(OPERATOR_TEXTS.map(([name, read]) => [name, lazy(() => quoteComparable(read()))] as const))

describe('E20: operator texts quote the Kill failed and Process outlived kill alerts only by title and closing sentence (b.jg5 SRJ-1001, SRJ-1007)', () => {
  test.each(OPERATOR_TEXTS.flatMap(([name]) => KILL_ALERT_PARTS.map(([version, part]) => [name, version, part] as const)))(
    '%s does not quote the %s alert sentence "%s"',
    (name, _version, part) => {
      expect(quotesAlertPart(COMPARABLE_OPERATOR_TEXTS.get(name)!(), part)).toBe(false)
    },
  )

  test('both versions give sentences to check, apart from their titles and closings', () => {
    for (const version of [KILL_FAILURE_VERSION_ORDINARY, KILL_FAILURE_VERSION_SURVIVOR]) {
      expect({ version, parts: KILL_ALERT_PARTS.filter(([v]) => v === version).length >= 3 }).toEqual({ version, parts: true })
    }
  })

  test.each(KILL_ALERT_PARTS.map(([version, part]) => [version, part] as const))('self-check: a text quoting the %s alert sentence "%s", wrapped, is reported', (version, part) => {
    const wrapped = `An operator text.\nThe alert says: ${part.replace(' ', '\n')} And more.`
    expect(alertPartsQuotedIn(wrapped)).toContain(`${version}: ${part}`)
  })

  test(`self-check: a sentence restated with a word changed is reported while ${QUOTE_RUN_WORDS} of its words run unchanged, and not with one fewer`, () => {
    const [version, part] = [...KILL_ALERT_PARTS].sort(([, a], [, b]) => b.length - a.length)[0]!
    const words = part.split(' ')
    expect(words.length).toBeGreaterThan(QUOTE_RUN_WORDS)
    const restated = ['Restated:', ...words.slice(1, QUOTE_RUN_WORDS + 1), 'CHANGED'].join(' ')
    expect(alertPartsQuotedIn(restated)).toContain(`${version}: ${part}`)
    const shorter = ['Restated:', ...words.slice(1, QUOTE_RUN_WORDS), 'CHANGED'].join(' ')
    expect(alertPartsQuotedIn(shorter)).not.toContain(`${version}: ${part}`)
  })

  test('self-check: a text quoting a whole alert is reported for each of its sentences; its title, closing and human-only sentences alone are not', () => {
    for (const { content, variables } of killFailureAlertRenderings()) {
      for (const closing of ALERT_CLOSINGS[content.version]) {
        const text = killFailureAlertText(content, closing, false)
        const parts = quotableAlertParts(text, content.version, variables)
        expect(alertPartsQuotedIn(text)).toEqual(expect.arrayContaining(parts.map((part) => `${content.version}: ${part}`)))
        const allowed = [ALERT_TITLE.exec(text)?.[0] ?? '', killFailureClosingSentence(content.version, closing), ...(text.match(HUMAN_ONLY_SENTENCE) ?? [])]
        expect(allowed.filter((sentence) => sentence === '')).toEqual([])
        expect(alertPartsQuotedIn(allowed.join(' '))).toEqual([])
      }
    }
  })
})

/** The two texts the E8 note names: the README and the debugging skill. */
const E8_TEXTS: readonly string[] = ['README.md', DEBUG_SKILL_FILE]

/**
 * The raw-command advice the E8 note removed (file-local): an
 * `agent-director kill` with a positional id rather than
 * `--claude-instance-id` (a log line's "`agent-director kill of …`" is no
 * command), tmux-kill or kill-and-respawn advice, a `has-session` probe, a
 * `tmux attach` target without `=`, and a raw tmux session or server kill.
 */
const RAW_COMMAND_FORMS: readonly [label: string, pattern: RegExp][] = [
  ['`agent-director kill` without --claude-instance-id', /`agent-director kill (?!--claude-instance-id\b|of\b)[^`]*`/g],
  ['tmux-kill advice', /\btmux-kill\b/gi],
  ['kill-and-respawn advice', /\bkill(?:s|ed|ing)?\s*(?:and|\+|\/)\s*respawn\w*/gi],
  ['a has-session probe', /\bhas-session\b/g],
  ['a tmux attach target without =', /\btmux attach(?:-session)?\s+-t\s*(?!=)[^\s`]+/g],
  ['a raw tmux session or server kill', /\btmux kill-(?:session|server)\b/g],
]

/**
 * `text` without its switch-over section, the one place SRJ-1101 lets an
 * operator text name `tmux kill-session -t =` (steps 5 and 6, checked in that
 * section's own cases). Throws when the README has no such section.
 */
function withoutSwitchOverSection(text: string, file: string): string {
  if (file !== 'README.md') return text
  const range = sectionRange(text, SWITCH_OVER_HEADING)
  if (range === undefined) throw new Error(`${file} has no heading "${SWITCH_OVER_HEADING}"`)
  return text
    .split('\n')
    .filter((_, i) => i < range.start || i >= range.end)
    .join('\n')
}

/** A lost-message state's label as the notice and the docs name it: the words between `Recovery: ` and ` —`. */
function lostMessageStateLabel(state: keyof typeof STATE_WORDING): string {
  const label = /^Recovery: (.+?) —/.exec(STATE_WORDING[state])?.[1]
  if (label === undefined) throw new Error(`STATE_WORDING["${state}"] has no "Recovery: <label> —" lead`)
  return label
}

/**
 * The claim the E8 note removed, that an `auto-restart disabled` persona will
 * not restart or come back on its own (false since E8 for a persona its
 * UNAVAILABLE retry timer owns). File-local, citing the E8 note.
 */
const STALE_AUTO_RESTART_CLAIM: readonly [label: string, pattern: RegExp][] = [
  ['will not restart or come back on its own', /\b(?:will not|won't|does not|doesn't|never|cannot|can't)\s+(?:be\s+)?(?:restart|come back|recover)\w*/gi],
]

/** The README's `auto-restart disabled` row in its lost-message recovery table; throws unless there is exactly one. */
function readmeAutoRestartRow(): string {
  const lead = `| \`${lostMessageStateLabel('auto-restart-disabled')}\` |`
  const rows = operatorText('README.md').split('\n').filter((line) => line.startsWith(lead))
  if (rows.length !== 1) throw new Error(`README.md has ${rows.length} rows starting ${lead}`)
  return rows[0]
}

/** The debugging skill's `auto-restart disabled` state, up to the next state (`restart limit reached`), in its lost-message entry. */
function debugSkillAutoRestartEntry(): string {
  const text = flat(operatorText(DEBUG_SKILL_FILE))
  const start = text.indexOf(`\`${lostMessageStateLabel('auto-restart-disabled')}\`: `)
  const end = text.indexOf(`\`${lostMessageStateLabel('restart-limit-reached')}\`: `, start)
  if (start < 0 || end < 0) throw new Error(`${DEBUG_SKILL_FILE} has no lost-message entry with the auto-restart disabled and restart limit reached states`)
  return text.slice(start, end)
}

describe('E8: the README and the debugging skill name no raw-command advice (b.jg5 SRJ-1001, SRJ-1101)', () => {
  test.each(E8_TEXTS.map((name) => [name] as const))('%s', (name) => {
    expect(termsIn(withoutSwitchOverSection(operatorText(name), name), RAW_COMMAND_FORMS)).toEqual([])
  })

  test.each([
    [`ends it with \`agent-director kill ${personaInstanceId(ALERT_KEY)}\``, '`agent-director kill` without --claude-instance-id'],
    ['run `agent-director kill <id>`', '`agent-director kill` without --claude-instance-id'],
    ['(`agent-director kill` / tmux-kill + respawn)', 'tmux-kill advice'],
    ['then kill and respawn the session', 'kill-and-respawn advice'],
    [`check it with \`tmux has-session -t =${personaTmuxSessionName(ALERT_KEY)}\``, 'a has-session probe'],
    [`while it is pending, attach with \`tmux attach -t ${PERSONA_TMUX_SESSION_PREFIX}<key>\``, 'a tmux attach target without ='],
    [`end it with \`tmux kill-session -t =${personaTmuxSessionName(ALERT_KEY)}\``, 'a raw tmux session or server kill'],
  ] as const)('self-check: "%s" is reported as %s', (text, label) => {
    expect(termsIn(text, RAW_COMMAND_FORMS).map((hit) => hit.split(': ')[0])).toContain(label)
  })

  test('self-check: the exact-name attach, the checked kill, a kill log line and "don\'t delete or respawn" are not reported', () => {
    const fine = [
      `attach with \`tmux attach -t =${personaTmuxSessionName(ALERT_KEY)}\``,
      `run \`agent-director kill --claude-instance-id ${personaInstanceId(ALERT_KEY)}\` and check the result; on an error, don't delete or respawn`,
      `\`agent-director kill of ${personaInstanceId(ALERT_KEY)} refused at a try: outcome=not-killed class=CONFLICT …\``,
      'then `agent-director kill`, whose result the human checks; on an error, nothing is deleted or respawned',
    ].join('\n')
    expect(termsIn(fine, RAW_COMMAND_FORMS)).toEqual([])
  })

  test(`self-check: the README's switch-over section is the part left out, and only that`, () => {
    const readme = operatorText('README.md')
    const rest = withoutSwitchOverSection(readme, 'README.md')
    expect(readme.length - rest.length).toBeGreaterThan(0)
    expect(rest).toContain(ROLLBACK_HEADING)
    expect(rest).not.toContain(SWITCH_OVER_HEADING)
  })
})

describe("E8: the README's and debugging skill's `auto-restart disabled` text keeps not saying the persona will not restart on its own (b.jg5 SRJ-1011)", () => {
  test.each([
    ['README.md: the lost-message recovery row', readmeAutoRestartRow],
    [`${DEBUG_SKILL_FILE}: the lost-message entry's state`, debugSkillAutoRestartEntry],
  ] as const)('%s', (_label, passage) => {
    const text = passage()
    expect(text).toContain(lostMessageStateLabel('auto-restart-disabled'))
    expect(termsIn(text, STALE_AUTO_RESTART_CLAIM)).toEqual([])
  })

  test('self-check: the old claim is reported; the lost-message notice\'s own wording is not', () => {
    expect(termsIn('`session_restart_delay` is `0`, so the instance will not restart on its own.', STALE_AUTO_RESTART_CLAIM)).not.toEqual([])
    expect(termsIn("the persona won't come back on its own", STALE_AUTO_RESTART_CLAIM)).not.toEqual([])
    expect(termsIn(STATE_WORDING['auto-restart-disabled'], STALE_AUTO_RESTART_CLAIM)).toEqual([])
  })
})
