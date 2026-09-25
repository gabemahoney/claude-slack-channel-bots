/**
 * setup-wizard-skill.test.ts — structural checks on the setup wizard skill
 * (skills/setup-slack-channel-bots/SKILL.md), b.av2 SR-12.
 *
 * The wizard is Markdown that Claude follows, so these tests pin the parts that
 * decide its behaviour by key term, not its prose, and find sections by their
 * title text, never by step number: the per-persona step covers every SR-12
 * item, tokens never go through the chat, the running-server rename is
 * explained, token rotation confirms a pending change without a restart, and
 * the wizard's cross-references resolve.
 *
 * Covered elsewhere, not repeated here: the credentials command itself (its
 * section, its one bash block) is run by tests/credentials-command.test.ts.
 * The forbidden-term audit over all shipped text (token variable names,
 * access-control file, pre-persona keys) is E14 Task 3's audit, which Task 3
 * adds to tests/shipped-docs.test.ts. The three shell-token rows below are not
 * plain term checks and stay here.
 *
 * Reads repo files only; writes nothing.
 *
 * SPDX-License-Identifier: MIT
 */

import { describe, expect, test } from 'bun:test'

import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import { flat, headingAnchors, headings, requiredSection } from './test-helpers/markdown.ts'

const REPO_ROOT = resolve(import.meta.dirname, '..')
const SKILL_FILE = 'skills/setup-slack-channel-bots/SKILL.md'
const skill = readFileSync(resolve(REPO_ROOT, SKILL_FILE), 'utf-8')
const readme = readFileSync(resolve(REPO_ROOT, 'README.md'), 'utf-8')
const debugSkill = readFileSync(resolve(REPO_ROOT, 'skills', 'debug-slack-channel-bots', 'SKILL.md'), 'utf-8')

/**
 * A level-`level` heading whose title holds `title` as whole words, such as
 * `### Step 4 — Add a persona` for "Add a persona" or `#### 4.2 Slack app:
 * create, …` for "Slack app", so a renumbered step is still found.
 */
function titled(level: number, title: string): RegExp {
  return new RegExp(`^#{${level}} (?:.*\\W)?${title.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?:\\W.*)?$`)
}

const frontmatter = skill.slice(0, skill.indexOf('\n---\n', 4))
// Sections are read inside each test, so a missing heading fails the tests that
// need it, naming the file and heading, rather than the whole file at load.
const constraints = () => flat(requiredSection(skill, titled(2, 'Constraints'), SKILL_FILE))
const addPersona = () => requiredSection(skill, titled(3, 'Add a persona'), SKILL_FILE)
const takesEffect = () => flat(requiredSection(skill, titled(3, 'How the change takes effect'), SKILL_FILE))
const rotation = () => flat(requiredSection(skill, titled(2, "Rotate a persona's tokens"), SKILL_FILE))

describe('setup wizard: frontmatter', () => {
  test.each([
    ['skill name', /^name: setup-slack-channel-bots$/m],
    ['user-invocable', /^user-invocable: true$/m],
    ['allowed-tools', /^allowed-tools: \[.*\]$/m],
    ['description names personas', /^description: .*\bpersonas?\b/m],
  ])('%s', (_label, pattern) => {
    expect(skill.startsWith('---\n')).toBe(true)
    expect(frontmatter).toMatch(pattern)
  })
})

describe('setup wizard: the per-persona step covers each SR-12 item', () => {
  const IN_ADD_PERSONA = `${SKILL_FILE}, under "Add a persona",`
  test.each([
    ['Slack app', 'app from the shipped manifest', /slack-app-manifest\.yml/],
    ['Slack app', "the app's name", /display_information\.name/],
    ['Slack app', 'the avatar, uploaded in the display information', /\bavatar\b[^.]*Display Information/],
    ['Slack app', 'install to the workspace', /Install to Workspace/],
    ['Slack app', 'an existing app re-installed to gain im:write', /re-install[^.]*`im:write`|`im:write`[^.]*re-install/],
    ['Credentials file', 'credentials file path', /`credentials_file`/],
    ['Credentials file', 'hand-off to the credentials command', /\]\(#credentials-command\)/],
    ['Credentials file', 'the file checked for existence and mode 0600 with ls -lL', /exists and has mode 0600[\s\S]*ls -lL "/],
    ['Channels', 'channel delivery', /`delivery`/],
    ['Channels', 'invite the app to its channels', /\/invite @/],
    ['Direct messages', 'DM contact', /`dm\.contact`/],
    ['Permission prompts', 'permission prompts destination', /`permission_prompts`/],
    ['Declare the persona', 'declared in personas in config.json', /append the entry to `personas` in `config\.json`/],
  ])('"%s": %s', (title, _label, pattern) => {
    expect(flat(requiredSection(addPersona(), titled(4, title), IN_ADD_PERSONA))).toMatch(pattern)
  })

  test('the step runs once per persona, one app each', () => {
    expect(flat(addPersona())).toMatch(/once for each/)
    expect(flat(addPersona())).toMatch(/One persona is one Slack app/)
  })
})

describe('setup wizard: credentials command section', () => {
  // The section and its one bash block are run by tests/credentials-command.test.ts;
  // this pins only that the section names both checks and the mode.
  test.each([
    ['bot token checked with auth.test', /`auth\.test`/],
    ['app token checked with apps.connections.open', /`apps\.connections\.open`/],
    ['mode 0600', /mode 0600/],
  ])('## Credentials command carries %s', (_label, pattern) => {
    expect(requiredSection(skill, '## Credentials command', SKILL_FILE)).toMatch(pattern)
  })
})

/**
 * The units a chat-token phrasing is looked for in: each line starts a new
 * unit when it opens a list item, a heading or a fence, or follows a blank
 * line (a hard-wrapped continuation line joins the unit before it), and each
 * unit is then split into sentences. So a list item never shares a unit with
 * the item before it, whether or not that item ends with a period.
 */
function sentenceUnits(text: string): string[] {
  const units: string[] = []
  let current: string[] = []
  for (const line of text.split('\n')) {
    const starts = /^\s*$/.test(line) || /^\s*(?:[-*+]|\d+[.)]|#{1,6}|```|~~~|>|\|)\s?/.test(line)
    if (starts && current.length > 0) {
      units.push(current.join(' '))
      current = []
    }
    if (!/^\s*$/.test(line)) current.push(line)
  }
  if (current.length > 0) units.push(current.join(' '))
  return units.flatMap((unit) => flat(unit).split(/(?<=[.!?])\s+/))
}

/**
 * A negation directly before a matched phrasing, which makes it a prohibition
 * ("NEVER ask the operator to paste … a token in the chat"). Only never, don't,
 * do not and must not count, and only when nothing but the governing "ask /
 * tell / have / let / get the user or operator to" stands between the
 * negation and the matched verb: "…, and never echo them back" after the
 * phrasing does not exempt it.
 */
const NEGATION_BEFORE = /\b(?:never|don't|do not|must not)\s+(?:(?:ask|tell|have|let|get)\s+(?:the\s+)?(?:user|operator)\s+(?:to\s+)?)?$/i

/**
 * SR-12: the phrasings the pre-persona wizard used to take tokens in chat or
 * keep them in the shell, and variants of them. None may come back. A
 * negatable phrasing is allowed only as a prohibition (`NEGATION_BEFORE`).
 */
const CHAT_TOKEN_PHRASINGS: [label: string, negatable: boolean, pattern: RegExp][] = [
  ['ask the user to provide a token', true, /\bask (?:the )?(?:user|operator) (?:to (?:provide|paste|type|enter|send|share|give)|for)\b[^.]{0,30}\btokens?\b/gi],
  ['paste a token here or into the chat', true, /\b(?:paste|type|enter|send|share)\b[^.]{0,30}\btokens?\b[^.]{0,20}\b(?:here|in(?:to)? (?:the |this )?(?:chat|conversation))\b/gi],
  ['validate a token the user sends', true, /\bvalidate (?:the|their|your) tokens?\b/gi],
  ['act once the user has given a token', true, /\b(?:after|once|when) (?:the )?(?:user|operator) (?:has )?(?:provides?|provided|pastes?|pasted|sends?|sent|enters?|entered|gives?|given)\b[^.]{0,20}\btokens?\b/gi],
  // Kept here rather than left to Task 3's audit: these catch a token kept in
  // the shell or on a command line, not a forbidden term.
  ['export a token variable', false, /\bexport\s+\w*TOKEN\w*=/gi],
  ['export lines for a shell profile', false, /`export` lines/gi],
  ['a bearer token in a curl argument', false, /-H\s+["']Authorization: Bearer/gi],
]

/** Each chat-token phrasing in `text` that is not a prohibition, as `<label>: <sentence>`. */
function chatTokenHits(text: string, phrasings = CHAT_TOKEN_PHRASINGS): string[] {
  return sentenceUnits(text).flatMap((sentence) =>
    phrasings.flatMap(([label, negatable, pattern]) =>
      [...sentence.matchAll(pattern)]
        .filter((m) => !(negatable && NEGATION_BEFORE.test(sentence.slice(0, m.index))))
        .map(() => `${label}: ${sentence}`),
    ),
  )
}

describe('setup wizard: tokens never go through the chat', () => {
  test.each([
    ['forbid asking for a token in the chat', /\bNEVER ask\b[^.]*\btoken\b[^.]*\bchat\b/],
    ['refuse a token offered in the chat', /\boffers a token in the chat\b[^.]*\bdon't use it\b/],
  ])('Constraints: %s', (_label, pattern) => {
    expect(constraints()).toMatch(pattern)
  })

  test.each(CHAT_TOKEN_PHRASINGS)('absent: %s', (label, negatable, pattern) => {
    expect(chatTokenHits(skill, [[label, negatable, pattern]])).toEqual([])
  })

  // Controls for the check itself: each bypass it once let through is caught,
  // and the wizard's own prohibitions stay allowed.
  test.each([
    ['a negation after the phrasing', 'Ask the user to provide both tokens here in the chat, and never echo them back.', true],
    ['a negation in the list item before', '- NEVER print a credentials file\n- Ask the operator to paste the bot token here', true],
    ['a negation in the wrapped line before', "Don't cat the file; ask the user\nto paste the token into the chat.", true],
    ['the Constraints prohibition', 'NEVER ask the operator to paste, type or show a token in the chat.', false],
    ["the credentials command's prohibition", 'Never paste a token into the chat.', false],
  ] as const)('chat-token check on %s: flagged is %p', (_label, text, flagged) => {
    expect(chatTokenHits(text).length > 0).toBe(flagged)
  })
})

describe('setup wizard: how the change takes effect', () => {
  test.each([
    ['the running server writes config.json.pending', /\bwrites `config\.json\.pending`/],
    ['the operator confirms by renaming it to config.json.apply', /renaming `config\.json\.pending` to `config\.json\.apply`/],
    ['the rename command', /mv config\.json\.pending config\.json\.apply/],
  ])('%s', (_label, pattern) => {
    expect(takesEffect()).toMatch(pattern)
  })
})

describe("setup wizard: rotating a persona's tokens", () => {
  test.each([
    ['re-runs the credentials command', /\]\(#credentials-command\)/],
    ['the operator confirms the pending change', /`config\.json\.pending`[^.]*\bconfirms\b/],
    ['no restart is needed', /\bNo restart\b/],
  ])('%s', (_label, pattern) => {
    expect(rotation()).toMatch(pattern)
  })
})

describe('setup wizard: cross-references resolve', () => {
  const readmeTitles = headings(readme).map((h) => h.text)

  test('every README heading the wizard names in a code span is a README heading', () => {
    const named = [...flat(skill).matchAll(/`(#{2,4} [^`]+)`/g)].map((m) => m[1])
    expect(named.length).toBeGreaterThan(0)
    expect(named.filter((h) => !readmeTitles.includes(h))).toEqual([])
  })

  test('every same-file link targets a wizard heading', () => {
    const anchors = headingAnchors(skill)
    const links = [...skill.matchAll(/\]\(#([^)\s]+)\)/g)].map((m) => m[1])
    expect(links.length).toBeGreaterThan(0)
    expect(links.filter((a) => !anchors.includes(a))).toEqual([])
  })

  test.each(['skills/debug-slack-channel-bots/SKILL.md', 'skills/install-cscb/SKILL.md', 'skills/EXAMPLE_CLAUDE.md', 'slack-app-manifest.yml'])(
    'the wizard names %s, which exists',
    (path) => {
      expect(skill.includes(path)).toBe(true)
      expect(existsSync(resolve(REPO_ROOT, path))).toBe(true)
    },
  )

  test.each([
    "## A persona can't open a DM: re-install its app to gain `im:write`",
    '### `persona-config-dir-unresolvable`',
    '### `persona-credentials-refused`',
  ])('the debugging-skill entry the wizard points to exists: %s', (heading) => {
    const title = heading.replace(/^#+ /, '')
    expect(flat(skill).includes(title.replace(/^`(.*)`$/, '$1'))).toBe(true)
    expect(headings(debugSkill).map((h) => h.text)).toContain(heading)
  })
})
