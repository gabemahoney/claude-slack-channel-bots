/**
 * shipped-docs.test.ts — audits files the package ships to the operator
 * (b.av2 SR-13.5). One `describe` per shipped file.
 *
 * Starts with the Slack app manifest (b.av2 AC 39, SR-4.3, SR-12) and the
 * README's modify-semantics table (SR-12, SR-8.6), held against the change
 * plan's exported classes in src/reload-plan.ts. E14 extends it into the full
 * shipped-docs audit (README, skills, MCP instructions).
 *
 * Reads repo files only, resolved from this file's location so the working
 * directory doesn't matter. No temp files, no real HOME, no server, no CLI
 * (SR-13.2).
 */
import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'fs'
import { resolve } from 'path'

import { PERSONA_TOP_LEVEL_KEYS } from '../src/config.ts'
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
 * (`##` = 2), up to the next heading at that level or higher; '' when absent.
 * Fenced code blocks are not headings.
 */
function markdownSection(text: string, level: number, title: string): string {
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
  return start >= 0 ? lines.slice(start).join('\n') : ''
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

/**
 * b.av2 SR-12 / SR-8.6: the README's modify-semantics table, "What a
 * confirmation applies" in the Reload section. Each expected row is found by
 * the setting names in its Change cell (or a keyword where it names none),
 * and pinned by its Live session cell and whether its Once confirmed cell
 * carries `DESTRUCTIVE:`. Wording is not pinned.
 */
describe('README.md: What a confirmation applies (SR-8.6 rows)', () => {
  const reload = markdownSection(readRepoFile('README.md'), 2, 'Reload')
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
