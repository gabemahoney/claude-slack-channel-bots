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
 * The channel modes (b.deo SRI-1109, AC 43): the channel-mode step sits after
 * "Detect the server state" and before "Add a persona", explains fungible
 * mode, suggests declarative, states the mode in force on an existing install,
 * collects every persona's section in the switching edit, names both rule sets
 * so the pending change is never `INVALID`, and has the operator review each
 * app's channels and past `unclaimed-channel` lines before switching on. "Add
 * a persona" in fungible mode skips the channels questions, asks for
 * `invited.permission_prompts` in both its forms, shows an entry with no
 * declarative section and has the operator invite the app; the declarative
 * parts of "Channels" and "Permission prompts" are read on their own. The
 * switch, the fungible destination, the tool name and the class label are
 * imported from src/ as SCREAMING_CASE constants, and every other setting name
 * is checked against the loader's key lists, so this suite stays
 * non-touching. A control block cuts each pinned phrase, puts some back only
 * just outside the part of the wizard they are read in, and moves the step, on
 * an in-memory copy, and checks the case then fails.
 *
 * Covered elsewhere, not repeated here: the credentials command itself (its
 * section's one-line block, the CLI subcommand and the packaged script it
 * runs) is run by tests/credentials-command.test.ts.
 * The forbidden-term audit over all shipped text (token variable names and
 * export forms, a bearer token on a curl command line, the access-control
 * file, pre-persona keys) lives in tests/shipped-docs.test.ts, which covers
 * this skill with the rest of the shipped text.
 *
 * Reads repo files only; writes nothing.
 *
 * SPDX-License-Identifier: MIT
 */

import { describe, expect, test } from 'bun:test'

import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import { SET_CHANNEL_DELIVERY_TOOL } from '../src/channel-delivery.ts'
import {
  CHANNEL_ENTRY_KEYS,
  DM_DESTINATION,
  PERSONA_DM_KEYS,
  PERSONA_ENTRY_KEYS,
  PERSONA_INVITED_KEYS,
  PERSONA_TOP_LEVEL_KEYS,
} from '../src/config.ts'
import { UNCLAIMED_CHANNEL } from '../src/persona-diagnostics.ts'
import { FUNGIBLE_DESTINATION_SETTING } from '../src/persona-destination.ts'
import { MODE_SWITCH_SETTING } from '../src/reload-plan.ts'
import { flat, headingAnchors, headings, requiredSection, sectionRange, splitFences } from './test-helpers/markdown.ts'

const REPO_ROOT = resolve(import.meta.dirname, '..')
const SKILL_FILE = 'skills/setup-slack-channel-bots/SKILL.md'
const skill = readFileSync(resolve(REPO_ROOT, SKILL_FILE), 'utf-8')
const readme = readFileSync(resolve(REPO_ROOT, 'README.md'), 'utf-8')
const debugSkill = readFileSync(resolve(REPO_ROOT, 'skills', 'debug-slack-channel-bots', 'SKILL.md'), 'utf-8')

/**
 * A level-`level` heading whose title holds `title` as whole words, such as
 * `### Step 5 — Add a persona` for "Add a persona" or `#### 5.2 Slack app:
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
    ['Credentials file path', 'credentials file path', /`credentials_file`/],
    ['Write its credentials file', 'hand-off to the credentials command', /\]\(#credentials-command\)/],
    ['Write its credentials file', 'the file checked for existence and mode 0600 with ls -lL', /exists and has mode 0600[\s\S]*ls -lL "/],
    ['Write its credentials file', 'on a running server, confirm only after the new preview', /new preview[^.]*confirms only after/],
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

  test('the credentials file is written after the persona is declared: the command finds the persona in config.json', () => {
    const titles = headings(addPersona()).map((h) => h.text)
    const declared = titles.findIndex((t) => titled(4, 'Declare the persona').test(t))
    const written = titles.findIndex((t) => titled(4, 'Write its credentials file').test(t))
    expect(declared).toBeGreaterThanOrEqual(0)
    expect(written).toBeGreaterThan(declared)
  })
})

// ---------------------------------------------------------------------------
// The channel modes (b.deo SRI-1109, AC 43)
// ---------------------------------------------------------------------------

/** `value` with every RegExp metacharacter escaped. */
function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * A RegExp whose source is the template's own text, written for `flat` text
 * (one space between words), with each interpolated value (a setting name, the
 * tool name, the class label) matched literally.
 */
function rx(strings: TemplateStringsArray, ...values: string[]): RegExp {
  return new RegExp(strings.raw.slice(1).reduce((source, raw, i) => source + escapeRegExp(values[i]) + raw, strings.raw[0]))
}

/**
 * The setting names the channel-mode cases read. The switch and the fungible
 * destination are imported (`MODE_SWITCH_SETTING`,
 * `FUNGIBLE_DESTINATION_SETTING`); the keys src/ exports no constant for are
 * each checked against the loader key list it belongs to (a case below), so a
 * key renamed in src/config.ts fails here rather than leaving the wizard
 * pinned to the old name. Only SCREAMING_CASE constants are imported, which
 * keeps this suite non-touching (tests/secrecy-audit.test.ts).
 */
const MODE_SWITCH = MODE_SWITCH_SETTING
const CHANNELS = 'channels'
const PERMISSION_PROMPTS = 'permission_prompts'
const INVITED = 'invited'
const DM = 'dm'
const CHANNEL_ID = 'id'
const DELIVERY = 'delivery'
const DM_ENABLED_KEY = 'enabled'
const DM_CONTACT_KEY = 'contact'
const INVITED_PROMPTS_KEY = 'permission_prompts'
const SETTING_NAMES: [name: string, list: string, keys: readonly string[]][] = [
  [MODE_SWITCH, 'PERSONA_TOP_LEVEL_KEYS', PERSONA_TOP_LEVEL_KEYS],
  [CHANNELS, 'PERSONA_ENTRY_KEYS', PERSONA_ENTRY_KEYS],
  [PERMISSION_PROMPTS, 'PERSONA_ENTRY_KEYS', PERSONA_ENTRY_KEYS],
  [INVITED, 'PERSONA_ENTRY_KEYS', PERSONA_ENTRY_KEYS],
  [DM, 'PERSONA_ENTRY_KEYS', PERSONA_ENTRY_KEYS],
  [CHANNEL_ID, 'CHANNEL_ENTRY_KEYS', CHANNEL_ENTRY_KEYS],
  [DELIVERY, 'CHANNEL_ENTRY_KEYS', CHANNEL_ENTRY_KEYS],
  [DM_ENABLED_KEY, 'PERSONA_DM_KEYS', PERSONA_DM_KEYS],
  [DM_CONTACT_KEY, 'PERSONA_DM_KEYS', PERSONA_DM_KEYS],
  [INVITED_PROMPTS_KEY, 'PERSONA_INVITED_KEYS', PERSONA_INVITED_KEYS],
]
const DM_ENABLED = `${DM}.${DM_ENABLED_KEY}`
const DM_CONTACT = `${DM}.${DM_CONTACT_KEY}`
const INVITED_DESTINATION = FUNGIBLE_DESTINATION_SETTING

/** The three steps whose order SRI-1109 fixes, by title. */
const MODE_STEP_ORDER = ['Detect the server state', 'Channel mode', 'Add a persona']

/** Which of `MODE_STEP_ORDER`'s `###` steps `doc` holds, in the order it holds them. */
function modeStepOrder(doc: string): string[] {
  return headings(doc).flatMap((h) => MODE_STEP_ORDER.filter((title) => titled(3, title).test(h.text)))
}

const channelModeStep = (doc: string) => requiredSection(doc, titled(3, 'Channel mode'), SKILL_FILE)
const addPersonaSub = (title: string) => (doc: string) =>
  requiredSection(requiredSection(doc, titled(3, 'Add a persona'), SKILL_FILE), titled(4, title), `${SKILL_FILE}, under "Add a persona",`)
const channelsSub = addPersonaSub('Channels')
const promptsSub = addPersonaSub('Permission prompts')
const declareSub = addPersonaSub('Declare the persona')

/** The list item of `text` that opens with `- **<lead>**`, its wrapped lines included; '' when there is none. */
function listItem(text: string, lead: string): string {
  const lines = text.split('\n')
  const start = lines.findIndex((line) => line.startsWith(`- **${lead}**`))
  if (start < 0) return ''
  const end = lines.findIndex((line, i) => i > start && (/^\s*$/.test(line) || /^\s*[-*+] /.test(line)))
  return lines.slice(start, end < 0 ? undefined : end).join('\n')
}

/** `text` from `lead` to its end; '' when `lead` is absent. */
function fromLead(text: string, lead: string): string {
  const start = text.indexOf(lead)
  return start < 0 ? '' : text.slice(start)
}

const DECLARATIVE_PART = '**In declarative mode,**'
const FUNGIBLE_PART = '**In fungible mode,**'
const EITHER_PART = 'In either mode,'

/**
 * The part of a sub-step that opens with `lead` (one of the three mode leads),
 * up to the next mode lead or the sub-step's end; '' when `lead` is absent. So
 * the declarative part of "Channels" never reads its fungible sentences, and
 * the reverse.
 */
function modePart(text: string, lead: string): string {
  const start = text.indexOf(lead)
  if (start < 0) return ''
  const ends = [DECLARATIVE_PART, FUNGIBLE_PART, EITHER_PART].map((l) => text.indexOf(l, start + lead.length)).filter((i) => i >= 0)
  return text.slice(start, ends.length > 0 ? Math.min(...ends) : undefined)
}

/** A pinned element: its label, the part of the wizard it is read in, and its phrase (matched on `flat` text). */
type Element = [label: string, scope: (doc: string) => string, pattern: RegExp]

/** SRI-1109's first bullet: the channel-mode step, found by title, element by element. */
const CHANNEL_MODE_ELEMENTS: Element[] = [
  ['names the switch, which picks the mode for every persona', channelModeStep, rx`\`${MODE_SWITCH}\` picks the channel mode for every persona`],
  [
    "explains, in one sentence, that in fungible mode the invite decides who reaches a persona and its agent then sets each channel's delivery",
    channelModeStep,
    rx`in fungible mode, inviting a persona's app to a channel decides who can reach the persona there, and the persona's agent then sets each channel's delivery with \`${SET_CHANNEL_DELIVERY_TOOL}\``,
  ],
  ['suggests declarative mode', channelModeStep, /suggest declarative mode/i],
  ['on an existing install, states the mode in force and asks only whether to change it', channelModeStep, rx`\*\*An existing install:\*\* state the mode in force and ask only whether to change it`],
  [
    'a mode change is one edit that collects, for every declared persona, the section the mode turned on needs',
    channelModeStep,
    rx`Make the switch and everything it needs one edit of \`config\.json\`\. In that same edit, collect for every declared persona the section the mode turned on needs`,
  ],
  ['turning fungible mode on sets the switch to true', (doc) => listItem(channelModeStep(doc), 'Turning fungible mode on'), rx`\(\`"${MODE_SWITCH}": true\`\)`],
  [
    'turning fungible mode on asks a fungible destination of each persona whose DMs are off or that has no contact',
    (doc) => listItem(channelModeStep(doc), 'Turning fungible mode on'),
    rx`for each persona whose \`${DM_ENABLED}\` isn't \`true\` or that has no \`${DM_CONTACT}\`, ask for its fungible destination, \`${INVITED_DESTINATION}\``,
  ],
  [
    'turning fungible mode off needs a top-level permission_prompts, and channels unless DMs are on, valid by the declarative-mode rules',
    (doc) => listItem(channelModeStep(doc), 'Turning fungible mode off'),
    rx`every persona needs a top-level \`${PERMISSION_PROMPTS}\`, and \`${CHANNELS}\` unless its \`${DM_ENABLED}\` is \`true\`, valid by the declarative-mode rules`,
  ],
  ['checks every persona against the load-time rules of the mode in force after the edit', channelModeStep, rx`check every persona against the load-time rules of the mode in force after the edit`],
  ['names both rule sets, each for its mode', channelModeStep, rx`the declarative-mode rules when the switch is off, or the fungible-mode rules when it is on`],
  ['both rule sets it names are lists in "Declare the persona": declarative', declareSub, rx`The declarative-mode rules: - `],
  ['both rule sets it names are lists in "Declare the persona": fungible', declareSub, rx`The fungible-mode rules: - `],
  ['the pending change is never INVALID', channelModeStep, rx`Write the edit only once every persona passes, so the pending change is never \`INVALID\``],
  [
    'the review step, before switching on for an existing install',
    channelModeStep,
    rx`\*\*Before turning fungible mode on for an existing install,\*\* tell the operator to review, for each persona's app:`,
  ],
  [
    "the review step: each app's channels",
    (doc) => fromLead(channelModeStep(doc), '**Before turning fungible mode on'),
    rx`- its channel memberships in Slack, private channels included`,
  ],
  [
    `the review step: each app's past ${UNCLAIMED_CHANNEL} lines`,
    (doc) => fromLead(channelModeStep(doc), '**Before turning fungible mode on'),
    rx`- its past \`${UNCLAIMED_CHANNEL}\` lines in \`server\.log\` and its rotated files`,
  ],
  [
    `the review step: the command that finds the ${UNCLAIMED_CHANNEL} lines`,
    (doc) => fromLead(channelModeStep(doc), '**Before turning fungible mode on'),
    rx`grep -h -F ${UNCLAIMED_CHANNEL} "\$STATE_DIR"/server\.log\.\* "\$STATE_DIR"/server\.log`,
  ],
]

/**
 * SRI-1109's second bullet: "Add a persona" in fungible mode, read in the
 * fungible or either-mode part of each sub-step.
 */
const FUNGIBLE_ELEMENTS: Element[] = [
  [
    '"Channels", fungible part: skips the channels questions',
    (doc) => modePart(channelsSub(doc), FUNGIBLE_PART),
    rx`\*\*In fungible mode,\*\* skip the channels questions: the persona has no \`${CHANNELS}\` and no \`${DELIVERY}\` to collect`,
  ],
  [
    '"Channels", either-mode part: invite the app to each channel the persona should serve',
    (doc) => modePart(channelsSub(doc), EITHER_PART),
    rx`In either mode, tell the operator to invite the persona's app to each channel the persona should serve`,
  ],
  ['"Channels", either-mode part: the /invite command', (doc) => modePart(channelsSub(doc), EITHER_PART), rx`/invite @`],
  [
    '"Channels", either-mode part: in fungible mode the invite makes the persona serve the channel',
    (doc) => modePart(channelsSub(doc), EITHER_PART),
    rx`In fungible mode, the invite is what makes the persona serve the channel`,
  ],
  [
    `"Permission prompts", fungible part: asks for ${INVITED_DESTINATION}`,
    (doc) => modePart(promptsSub(doc), FUNGIBLE_PART),
    rx`\*\*In fungible mode,\*\* ask instead for the fungible destination, \`${INVITED_DESTINATION}\``,
  ],
  [
    `"Permission prompts", fungible part: the top-level ${PERMISSION_PROMPTS} is not read`,
    (doc) => modePart(promptsSub(doc), FUNGIBLE_PART),
    rx`the top-level \`${PERMISSION_PROMPTS}\` is not read`,
  ],
  [
    '"Permission prompts", fungible part: a channel the app will be invited to, as written in the entry',
    (doc) => modePart(promptsSub(doc), FUNGIBLE_PART),
    rx`a channel ID the persona's app will be invited to, written \`"${INVITED}": \{ "${INVITED_PROMPTS_KEY}": "<channel ID>" \}\``,
  ],
  [
    `"Permission prompts", fungible part: "${DM_DESTINATION}", the default, with DMs on and a contact`,
    (doc) => modePart(promptsSub(doc), FUNGIBLE_PART),
    rx`\`"${DM_DESTINATION}"\`, the default when \`${INVITED}\` is left out, which needs \`${DM_ENABLED}: true\` and a \`${DM_CONTACT}\``,
  ],
  [
    '"Declare the persona": the fungible entry has no declarative section',
    declareSub,
    rx`In fungible mode the entry has no declarative section, no \`${CHANNELS}\` and no top-level \`${PERMISSION_PROMPTS}\``,
  ],
]

/**
 * The declarative parts of "Channels" and "Permission prompts", read on their
 * own: the SR-12 cases above read the whole sub-step, which the fungible
 * sentences alone would also pass.
 */
const DECLARATIVE_ELEMENTS: Element[] = [
  ['"Channels", declarative part: each channel\'s id', (doc) => modePart(channelsSub(doc), DECLARATIVE_PART), rx`\*\*\`${CHANNEL_ID}\`\*\*: the channel ID`],
  [
    '"Channels", declarative part: each channel\'s delivery',
    (doc) => modePart(channelsSub(doc), DECLARATIVE_PART),
    rx`\*\*\`${DELIVERY}\`\*\*: \`all\` \(every message in the channel\) or \`mentions\``,
  ],
  [
    `"Permission prompts", declarative part: the top-level ${PERMISSION_PROMPTS}, required`,
    (doc) => modePart(promptsSub(doc), DECLARATIVE_PART),
    rx`\*\*In declarative mode,\*\* ask where the persona's permission prompts and server notices go \(\`${PERMISSION_PROMPTS}\`, required\)`,
  ],
]

/** The JSON example that follows "In fungible mode the entry" in "Declare the persona", parsed; undefined when there is none. */
function fungibleEntryExample(doc: string): Record<string, unknown> | undefined {
  const block = splitFences(fromLead(declareSub(doc), 'In fungible mode the entry')).blocks.find((b) => b.info === 'json')
  return block === undefined ? undefined : (JSON.parse(block.body) as Record<string, unknown>)
}

/** Why `entry` is not a persona entry with only the fungible section, as a list; empty when it is one. */
function fungibleEntryProblems(entry: Record<string, unknown> | undefined): string[] {
  if (entry === undefined) return ['no JSON example']
  const problems = Object.keys(entry)
    .filter((key) => !(PERSONA_ENTRY_KEYS as readonly string[]).includes(key))
    .map((key) => `unknown key ${key}`)
  for (const key of [CHANNELS, PERMISSION_PROMPTS]) if (key in entry) problems.push(`declarative key ${key}`)
  const invited = entry[INVITED]
  if (typeof invited !== 'object' || invited === null) problems.push(`no ${INVITED} object`)
  else for (const key of Object.keys(invited)) if (!(PERSONA_INVITED_KEYS as readonly string[]).includes(key)) problems.push(`unknown ${INVITED} key ${key}`)
  return problems
}

/** `lines` with the `[start, end)` block moved to just before line `to` (`to` at or after `end`). */
function moveBlock(lines: string[], start: number, end: number, to: number): string[] {
  return [...lines.slice(0, start), ...lines.slice(end, to), ...lines.slice(start, end), ...lines.slice(to)]
}

/**
 * `doc` with every match of `pattern` cut. The pattern's spaces match any
 * whitespace run, so a phrase hard-wrapped in the file is cut too.
 */
function cut(doc: string, pattern: RegExp): string {
  return doc.replace(new RegExp(pattern.source.replaceAll(' ', '\\s+'), `${pattern.flags.replace('g', '')}g`), '')
}

const ALL_ELEMENTS: Element[] = [...CHANNEL_MODE_ELEMENTS, ...FUNGIBLE_ELEMENTS, ...DECLARATIVE_ELEMENTS]

/** The pinned element labelled `label`, throwing when there is none, so a renamed label fails its control. */
function element(label: string): Element {
  const found = ALL_ELEMENTS.find(([l]) => l === label)
  if (found === undefined) throw new Error(`no channel-mode element labelled "${label}"`)
  return found
}

/**
 * The offset in `doc` of the heading line of the section `path` names, each
 * heading looked for inside the section before it (outermost first); -1 when
 * one is missing.
 */
function headingOffset(doc: string, ...path: RegExp[]): number {
  let offset = 0
  let text = doc
  for (const match of path) {
    const range = sectionRange(text, match)
    if (range === undefined) return -1
    const lines = text.split('\n')
    offset += lines.slice(0, range.start).reduce((n, line) => n + line.length + 1, 0)
    text = lines.slice(range.start, range.end).join('\n')
  }
  return offset
}

/** The offset of the first `needle` in `doc` at or after the heading `path` names; -1 when either is missing. */
function leadOffset(doc: string, needle: string, ...path: RegExp[]): number {
  const start = headingOffset(doc, ...path)
  return start < 0 ? -1 : doc.indexOf(needle, start)
}

/** The offset just after the first `needle` at or after the heading `path` names; -1 when either is missing. */
function afterLead(doc: string, needle: string, ...path: RegExp[]): number {
  const at = leadOffset(doc, needle, ...path)
  return at < 0 ? -1 : at + needle.length
}

const STEP_CHANNEL_MODE = titled(3, 'Channel mode')
const STEP_ADD_PERSONA = titled(3, 'Add a persona')

/**
 * Controls for the scope helpers: each element's phrase is cut from where it
 * belongs and put back once just outside its scope (the step before, the other
 * list item, before its lead, the other mode's part, a sibling sub-step), so a
 * scope helper that reads too much (up to the whole wizard) fails its control,
 * which `cut` alone, removing every copy, never shows. One at least per scope
 * helper: `channelModeStep` (both ends), `listItem` (both items), `fromLead`,
 * `modePart` (each lead), and `addPersonaSub` through `declareSub`.
 */
const MISPLACED: [label: string, where: string, at: (doc: string) => number, place: (phrase: string) => string][] = [
  [
    'names the switch, which picks the mode for every persona',
    'at the end of "Detect the server state", before the channel-mode step',
    (doc) => headingOffset(doc, STEP_CHANNEL_MODE),
    (phrase) => `${phrase}.\n\n`,
  ],
  [
    'the pending change is never INVALID',
    'at the start of "Add a persona", after the channel-mode step',
    (doc) => afterLead(doc, '\n', STEP_ADD_PERSONA),
    (phrase) => `\n${phrase}.\n`,
  ],
  [
    'turning fungible mode on sets the switch to true',
    'in the "Turning fungible mode off" item',
    (doc) => afterLead(doc, '**Turning fungible mode off**', STEP_CHANNEL_MODE),
    (phrase) => ` ${phrase}`,
  ],
  [
    'turning fungible mode off needs a top-level permission_prompts, and channels unless DMs are on, valid by the declarative-mode rules',
    'in the "Turning fungible mode on" item',
    (doc) => afterLead(doc, '**Turning fungible mode on**', STEP_CHANNEL_MODE),
    (phrase) => ` ${phrase}.`,
  ],
  [
    `the review step: the command that finds the ${UNCLAIMED_CHANNEL} lines`,
    'in the channel-mode step, before the review step\'s lead',
    (doc) => leadOffset(doc, '**Before turning fungible mode on', STEP_CHANNEL_MODE),
    (phrase) => `${phrase}\n\n`,
  ],
  [
    '"Channels", either-mode part: in fungible mode the invite makes the persona serve the channel',
    'at the end of the fungible part of "Channels"',
    (doc) => leadOffset(doc, EITHER_PART, STEP_ADD_PERSONA, titled(4, 'Channels')),
    (phrase) => `${phrase}.\n\n`,
  ],
  [
    '"Channels", declarative part: each channel\'s id',
    'at the end of the fungible part of "Channels"',
    (doc) => leadOffset(doc, EITHER_PART, STEP_ADD_PERSONA, titled(4, 'Channels')),
    (phrase) => `${phrase}.\n\n`,
  ],
  [
    `"Permission prompts", fungible part: the top-level ${PERMISSION_PROMPTS} is not read`,
    'at the end of the declarative part of "Permission prompts"',
    (doc) => leadOffset(doc, FUNGIBLE_PART, STEP_ADD_PERSONA, titled(4, 'Permission prompts')),
    (phrase) => `${phrase}.\n\n`,
  ],
  [
    '"Declare the persona": the fungible entry has no declarative section',
    'at the end of the sub-step before "Declare the persona"',
    (doc) => headingOffset(doc, STEP_ADD_PERSONA, titled(4, 'Declare the persona')),
    (phrase) => `${phrase}.\n\n`,
  ],
]

describe('setup wizard: the setting names the channel-mode cases read are loader keys', () => {
  test.each(SETTING_NAMES)('%s is in %s', (name, _list, keys) => {
    expect(keys).toContain(name)
  })
})

describe('setup wizard: the channel-mode step (b.deo SRI-1109, AC 43)', () => {
  test('the step comes after "Detect the server state" and before "Add a persona"', () => {
    expect(modeStepOrder(skill)).toEqual(MODE_STEP_ORDER)
  })

  test.each(CHANNEL_MODE_ELEMENTS)('%s', (_label, scope, pattern) => {
    expect(flat(scope(skill))).toMatch(pattern)
  })
})

describe('setup wizard: "Add a persona" in fungible mode (b.deo SRI-1109, AC 43)', () => {
  test.each(FUNGIBLE_ELEMENTS)('%s', (_label, scope, pattern) => {
    expect(flat(scope(skill))).toMatch(pattern)
  })

  test.each(DECLARATIVE_ELEMENTS)('%s', (_label, scope, pattern) => {
    expect(flat(scope(skill))).toMatch(pattern)
  })

  test('"Declare the persona": the fungible example entry has the fungible section and no declarative one', () => {
    expect(fungibleEntryProblems(fungibleEntryExample(skill))).toEqual([])
  })
})

// Controls for the channel-mode cases: each fails on an in-memory copy of the
// wizard with its phrase cut, its phrase only outside its scope, or the step moved.
describe('setup wizard: the channel-mode cases fail when their element is gone', () => {
  test('moving the channel-mode step after "Add a persona" fails the order case', () => {
    const lines = skill.split('\n')
    const mode = sectionRange(skill, titled(3, 'Channel mode'))
    const add = sectionRange(skill, titled(3, 'Add a persona'))
    expect(mode).toBeDefined()
    expect(add).toBeDefined()
    const moved = moveBlock(lines, mode!.start, mode!.end, add!.end).join('\n')
    expect(modeStepOrder(moved)).toEqual(['Detect the server state', 'Add a persona', 'Channel mode'])
  })

  test.each(ALL_ELEMENTS)('cutting the phrase fails: %s', (_label, scope, pattern) => {
    const mutant = cut(skill, pattern)
    expect(mutant).not.toBe(skill)
    expect(flat(scope(mutant))).not.toMatch(pattern)
  })

  test.each(MISPLACED)('the phrase only outside its scope fails: %s, %s', (label, _where, at, place) => {
    const [, scope, pattern] = element(label)
    const phrase = flat(skill).match(pattern)?.[0]
    expect(phrase).toBeDefined()
    const cutDoc = cut(skill, pattern)
    const offset = at(cutDoc)
    expect(offset).toBeGreaterThanOrEqual(0)
    const mutant = cutDoc.slice(0, offset) + place(phrase!) + cutDoc.slice(offset)
    expect(flat(mutant)).toMatch(pattern)
    expect(flat(scope(mutant))).not.toMatch(pattern)
  })

  test.each([
    ['a channels list added', '"channels": [],\n  "invited": {', ['declarative key channels']],
    ['a top-level permission_prompts added', '"permission_prompts": "dm",\n  "invited": {', ['declarative key permission_prompts']],
    ['the invited section replaced', '"dm_only": {', ['unknown key dm_only', 'no invited object']],
  ] as const)('the fungible example check fails with %s', (_label, replacement, problems) => {
    const mutant = skill.replace('\n  "invited": {', `\n  ${replacement}`)
    expect(mutant).not.toBe(skill)
    expect(fungibleEntryProblems(fungibleEntryExample(mutant))).toEqual([...problems])
  })
})

describe('setup wizard: credentials command section', () => {
  // The section's one-line block is run end to end by tests/credentials-command.test.ts;
  // this pins only that the section names the declared persona, both checks, the mode and the packaged script.
  test.each([
    ['the persona declared in config.json first', /once the persona is declared in `config\.json`/],
    ['bot token checked with auth.test', /`auth\.test`/],
    ['app token checked with apps.connections.open', /`apps\.connections\.open`/],
    ['mode 0600', /mode 0600/],
    ['the packaged script', /`scripts\/write-credentials\.sh`/],
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
 * SR-12: the phrasings the pre-persona wizard used to take tokens in chat, and
 * variants of them. None may come back. A negatable phrasing is allowed only
 * as a prohibition (`NEGATION_BEFORE`). Keeping a token in the shell or on a
 * command line (an exported token variable, "`export` lines", a bearer token
 * in a curl argument) is caught across all shipped text by
 * tests/shipped-docs.test.ts's forbidden-term audit.
 */
const CHAT_TOKEN_PHRASINGS: [label: string, negatable: boolean, pattern: RegExp][] = [
  ['ask the user to provide a token', true, /\bask (?:the )?(?:user|operator) (?:to (?:provide|paste|type|enter|send|share|give)|for)\b[^.]{0,30}\btokens?\b/gi],
  ['paste a token here or into the chat', true, /\b(?:paste|type|enter|send|share)\b[^.]{0,30}\btokens?\b[^.]{0,20}\b(?:here|in(?:to)? (?:the |this )?(?:chat|conversation))\b/gi],
  ['validate a token the user sends', true, /\bvalidate (?:the|their|your) tokens?\b/gi],
  ['act once the user has given a token', true, /\b(?:after|once|when) (?:the )?(?:user|operator) (?:has )?(?:provides?|provided|pastes?|pasted|sends?|sent|enters?|entered|gives?|given)\b[^.]{0,20}\btokens?\b/gi],
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
    // b.deo SRI-1109: named by quoted title in "Channels" and "How the change takes effect".
    '## A persona is silent in a channel its app was invited to',
  ])('the debugging-skill entry the wizard points to exists: %s', (heading) => {
    const title = heading.replace(/^#+ /, '')
    expect(flat(skill).includes(title.replace(/^`(.*)`$/, '$1'))).toBe(true)
    expect(headings(debugSkill).map((h) => h.text)).toContain(heading)
  })
})
