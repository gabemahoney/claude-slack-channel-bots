/**
 * setup-wizard-skill.test.ts — structural checks on the setup wizard skill
 * (skills/setup-slack-channel-bots/SKILL.md).
 *
 * The wizard is Markdown that Claude follows, so these tests pin the parts that
 * decide its behaviour by key term, not its prose, and find sections by their
 * title text, never by step number: the per-persona step covers every
 * item, tokens never go through the chat, the running-server rename is
 * explained, token rotation confirms a pending change without a restart, and
 * the wizard's cross-references resolve.
 *
 * The channel modes: the channel-mode step sits after
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

import { existsSync, readFileSync, statSync } from 'node:fs'
import { dirname, resolve } from 'node:path'

import { SET_CHANNEL_DELIVERY_TOOL } from '../src/channel-delivery.ts'
import {
  CHANNEL_ENTRY_KEYS,
  CHANNEL_MODES,
  DELIVERY_MODES,
  DM_DESTINATION,
  PERSONA_DM_KEYS,
  PERSONA_ENTRY_KEYS,
  PERSONA_TOP_LEVEL_KEYS,
} from '../src/config.ts'
import { UNCLAIMED_CHANNEL } from '../src/persona-diagnostics.ts'
import { FUNGIBLE_DESTINATION_SETTING } from '../src/persona-destination.ts'
import { MODE_SWITCH_SETTING } from '../src/reload-plan.ts'
import {
  MEMBERSHIP_REQUIRED_SUBSCRIPTIONS, MEMBERSHIP_READINESS_ROUTE, parseMembershipSetupInput,
  type MembershipSetupInput,
} from '../src/channel-membership-readiness.ts'
import { flat, headingAnchors, headings, requiredSection, sectionRange, splitFences } from './test-helpers/markdown.ts'
import { assertNoLeak } from './test-helpers/credentials.ts'

const REPO_ROOT = resolve(import.meta.dirname, '..')
const SKILL_FILE = 'skills/setup-slack-channel-bots/SKILL.md'
const skill = readFileSync(resolve(REPO_ROOT, SKILL_FILE), 'utf-8')
/** The user docs the wizard points to: the README and the docs/ pages it lists. */
const USER_DOCS = ['README.md', 'docs/configuration.md', 'docs/server-settings.md', 'docs/channel-modes.md', 'docs/reload.md', 'docs/cli.md', 'docs/bots.md', 'docs/scheduled-prompts.md', 'docs/agent-director.md', 'docs/troubleshooting.md', 'docs/migration.md']
const userDocHeadings = new Map(USER_DOCS.map((file) => [file, headings(readFileSync(resolve(REPO_ROOT, file), 'utf-8')).map((h) => h.text)]))
const debugSkill = readFileSync(resolve(REPO_ROOT, 'skills', 'debug-slack-channel-bots', 'SKILL.md'), 'utf-8')
/** The debug skill's headings: the wizard names its `### The load-time rules`. */
const debugSkillHeadings = headings(debugSkill).map((h) => h.text)

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

describe('setup wizard: the per-persona step covers each item', () => {
  const IN_ADD_PERSONA = `${SKILL_FILE}, under "Add a persona",`
  test.each([
    ['Slack app', 'app from the shipped manifest', /slack-app-manifest\.yml/],
    ['Slack app', "the app's name", /display_information\.name/],
    ['Slack app', 'the avatar, uploaded in the display information', /\bavatar\b[^.]*Display Information/],
    ['Slack app', 'install to the workspace', /Install to Workspace/],
    ['Slack app', 'existing apps gather changes before the one reinstall', /collect all missing scopes and subscriptions before following \*\*Update and reinstall an existing app\*\*, linked below, for one reinstall/],
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

// Current configuration has one shared list and one required destination.
const modeStep = (doc: string) => requiredSection(doc, titled(3, 'Channel mode'), SKILL_FILE)
const personaStep = (doc: string, title: string) => requiredSection(requiredSection(doc, titled(3, 'Add a persona'), SKILL_FILE), titled(4, title), SKILL_FILE)
const REINSTALL_HEADING = '## Update and reinstall an existing app'
const REINSTALL_LINK = '(#update-and-reinstall-an-existing-app)'
const MEMBERSHIP_RECORD_LINK = '(../debug-slack-channel-bots/SKILL.md#membership-setup-record-and-readback)'
const UPGRADE_LINK = '(../../docs/migration.md#upgrading-from-018x)'
const code = (value: string) => '`' + value + '`'
const SETUP_RECORD_STATES = {
  subscriptions: ['verified', 'missing', 'unknown'],
  reinstall: ['complete', 'incomplete', 'unknown'],
} as const satisfies {
  subscriptions: readonly MembershipSetupInput['subscriptions'][typeof MEMBERSHIP_REQUIRED_SUBSCRIPTIONS[number]][]
  reinstall: readonly MembershipSetupInput['reinstall'][]
}
const manifest = Bun.YAML.parse(readFileSync(resolve(REPO_ROOT, 'slack-app-manifest.yml'), 'utf-8')) as {
  oauth_config: { scopes: { bot: string[] } }
}
const MEMBERSHIP_READ_SCOPES = manifest.oauth_config.scopes.bot.filter(scope => /^(channels|groups):read$/.test(scope))
const REUSE_SCOPES = manifest.oauth_config.scopes.bot.filter(scope => /^(?:im:write|(?:channels|groups|reactions):read|(?:lists|canvases):(?:read|write))$/.test(scope))

/** Existing-app preparation ends before the new-app membership instructions. */
function reuseParagraphs(doc: string): string {
  const app = personaStep(doc, 'Slack app')
  const start = app.indexOf('**Reusing an existing app**')
  const end = app.indexOf('**Membership setup for a new app:**', start)
  if (start < 0 || end < start) throw new Error('Slack app has no bounded existing-app preparation')
  return app.slice(start, end)
}
const REUSE_REQUIREMENTS = [
  'collect all missing scopes and subscriptions before following **Update and reinstall an existing app**',
  'linked below, for one reinstall',
  ...REUSE_SCOPES.map(code), ...MEMBERSHIP_REQUIRED_SUBSCRIPTIONS.map(code),
  'Also collect missing', 'in the same update',
  'include them in the same scope update under **OAuth & Permissions**',
  'subscriptions under **Event Subscriptions** too',
  'then use the linked procedure for the single reinstall',
]
function reuseProblems(doc: string): string[] {
  const text = flat(reuseParagraphs(doc))
  // Quoted diagnostic headings describe symptoms, and the task title is a referral.
  // Only the two explicit referrals may otherwise mention reinstalling here.
  const diagnosticTitles = debugSkillHeadings.map(heading => heading.replace(/^#+ /, ''))
  const instructions = text.replace(/"([^"\n]+)"/g, (quote, title: string) => diagnosticTitles.includes(title) ? '' : quote)
    .replace(`**${REINSTALL_HEADING.slice(3)}**`, '')
    .replace('linked below, for one reinstall', '')
    .replace('then use the linked procedure for the single reinstall', '')
  return [
    ...REUSE_REQUIREMENTS.filter(item => !text.includes(item)).map(item => `missing: ${item}`),
    ...(instructions.match(/\bre-?install(?:ed|ing)?\b/gi) ?? []).map(item => `separate reinstall instruction: ${item}`),
  ]
}

const newAppRequirements = [
  'Membership setup for a new app', ...MEMBERSHIP_REQUIRED_SUBSCRIPTIONS.map(code),
  'A fresh manifest install includes them and needs no extra reinstall', REINSTALL_LINK,
  'Once the persona is applied and running', MEMBERSHIP_RECORD_LINK,
  'read the authenticated installation IDs', 'inspect that exact app',
  'record each subscription', 'then read back both states',
]
function newAppProblems(doc: string): string[] {
  const app = flat(personaStep(doc, 'Slack app'))
  return newAppRequirements.filter(item => !app.includes(item))
}

const reinstallRequirements = [
  "For each persona's current app", UPGRADE_LINK, code('slack-app-manifest.yml'),
  ...MEMBERSHIP_REQUIRED_SUBSCRIPTIONS.map(code), ...MEMBERSHIP_READ_SCOPES.map(code),
  'for public channels', 'for private channels', 'other missing scopes', 'before reinstalling',
  '**Reinstall to Workspace** once and complete it',
  'Thread following requires no separate scope or reinstall',
  'Once the persona is applied and running', MEMBERSHIP_RECORD_LINK,
  'read the authenticated installation IDs, inspect that exact app/workspace',
  `record each subscription as ${SETUP_RECORD_STATES.subscriptions.map(code).join(', ').replace(/, ([^,]+)$/, ' or $1')}`,
  `reinstall as ${SETUP_RECORD_STATES.reinstall.map(code).join(', ').replace(/, ([^,]+)$/, ' or $1')}`,
  'then read back both inventory and setup states with the recorded evidence',
  'Evidence for another installation does not count',
  `Leave anything uninspectable ${code(SETUP_RECORD_STATES.subscriptions[2])}`,
  'a successful scan, silence or one observed event never verifies setup',
  'Later ordinary restarts need no further reinstall',
]
const REINSTALL_ORDER = [
  'Add what the app lacks, as the shipped', '**Reinstall to Workspace** once and complete it',
  'read the authenticated installation IDs', 'record each subscription',
  'then read back both inventory and setup states',
]
function reinstallProblems(doc: string): string[] {
  let section: string
  try { section = requiredSection(doc, REINSTALL_HEADING, SKILL_FILE) }
  catch (error) { return [String(error)] }
  const text = flat(section)
  let after = 0
  return [
    ...reinstallRequirements.filter(item => !text.includes(item)).map(item => `missing: ${item}`),
    ...REINSTALL_ORDER.flatMap(item => {
      const at = text.indexOf(item, after)
      if (at < 0) return [`missing or out of order: ${item}`]
      after = at + item.length
      return []
    }),
    ...(splitFences(section).blocks.length === 0 ? [] : ['record commands must remain in the linked debug entry']),
  ]
}

describe('membership setup: new apps and existing installations', () => {
  test('the manifest supplies public and private read scopes', () => {
    expect(MEMBERSHIP_READ_SCOPES).toHaveLength(2)
  })
  test('new installs need no extra reinstall and existing installs point to their procedure', () => {
    expect(newAppProblems(skill)).toEqual([])
  })
  test('existing-app preparation collects all missing scopes and subscriptions for one linked reinstall', () => {
    expect(REUSE_SCOPES).toHaveLength(8)
    expect(reuseProblems(skill)).toEqual([])
    expect(newAppProblems(skill)).toEqual([])
  })
  test.each(REUSE_REQUIREMENTS)('self-check: existing-app preparation cannot lose %s', item => {
    const preparation = reuseParagraphs(skill)
    const edited = skill.replace(preparation, flat(preparation).replaceAll(item, '') + '\n\n')
    expect(edited).not.toBe(skill)
    expect(reuseProblems(edited)).toContain(`missing: ${item}`)
  })
  test.each([
    'The app must gain them and be re-installed.',
    'Add both the same way, then re-install.',
    'Then re-install the app to the workspace.',
    'Choose Reinstall to Workspace now.',
  ])('self-check: existing-app preparation rejects a separate action: %s', instruction => {
    const preparation = reuseParagraphs(skill)
    const edited = skill.replace(preparation, `${preparation}${instruction}\n\n`)
    expect(reuseProblems(edited).some(problem => problem.startsWith('separate reinstall instruction:'))).toBe(true)
  })
  test('self-check: dropping the existing-app pointer fails the new-app check', () => {
    const app = personaStep(skill, 'Slack app')
    const edited = skill.replace(app, app.replace(REINSTALL_LINK, ''))
    expect(edited).not.toBe(skill)
    expect(newAppProblems(edited)).toContain(REINSTALL_LINK)
  })
  test('the task section orders update, reinstall, authenticated record and readback', () => {
    expect(reinstallProblems(skill)).toEqual([])
  })
  test('self-check: removing the task section fails', () => {
    const edited = skill.replace(REINSTALL_HEADING, '## Retired setup task')
    expect(reinstallProblems(edited).length).toBeGreaterThan(0)
  })
  test.each(REINSTALL_ORDER.slice(0, -1))('self-check: moving %s to the end fails the order check', item => {
    const section = flat(requiredSection(skill, REINSTALL_HEADING, SKILL_FILE))
    const edited = `${REINSTALL_HEADING}\n${section.replace(item, '')} ${item}`
    expect(reinstallProblems(edited)).toContain(`missing or out of order: ${REINSTALL_ORDER[REINSTALL_ORDER.indexOf(item) + 1]}`)
  })
  test.each(reinstallRequirements)('self-check: the reinstall section cannot lose %s', item => {
    const section = flat(requiredSection(skill, REINSTALL_HEADING, SKILL_FILE))
    const edited = `${REINSTALL_HEADING}\n${section.replace(item, '')}`
    expect(edited).not.toBe(`${REINSTALL_HEADING}\n${section}`)
    expect(reinstallProblems(edited)).toContain(`missing: ${item}`)
  })
  test('self-check: duplicating record commands in the task section fails', () => {
    const section = requiredSection(skill, REINSTALL_HEADING, SKILL_FILE)
    expect(reinstallProblems(`${REINSTALL_HEADING}\n${section}\n\n\`\`\`sh\ncurl ${MEMBERSHIP_READINESS_ROUTE}\n\`\`\``))
      .toContain('record commands must remain in the linked debug entry')
  })

  const setupRecord = (
    subscription: MembershipSetupInput['subscriptions'][typeof MEMBERSHIP_REQUIRED_SUBSCRIPTIONS[number]],
    reinstall: MembershipSetupInput['reinstall'],
  ): MembershipSetupInput => ({
    installation: { teamId: 'T0TEST001', appId: 'A0TEST001', botUserId: 'U0TEST001', botId: 'B0TEST001' },
    subscriptions: Object.fromEntries(MEMBERSHIP_REQUIRED_SUBSCRIPTIONS.map(event => [event, subscription])) as MembershipSetupInput['subscriptions'],
    reinstall,
  })
  test.each([...SETUP_RECORD_STATES.subscriptions])('documented subscription evidence %s is accepted by the record parser', value => {
    const record = setupRecord(value, SETUP_RECORD_STATES.reinstall[0])
    const parsed = parseMembershipSetupInput(record)
    assertNoLeak({ record, parsed })
    expect(parsed).toEqual(record)
  })
  test.each([...SETUP_RECORD_STATES.reinstall])('documented reinstall evidence %s is accepted by the record parser', value => {
    const record = setupRecord(SETUP_RECORD_STATES.subscriptions[0], value)
    const parsed = parseMembershipSetupInput(record)
    assertNoLeak({ record, parsed })
    expect(parsed).toEqual(record)
  })
  test.each([...MEMBERSHIP_REQUIRED_SUBSCRIPTIONS, 'reinstall'])('an undocumented %s evidence value is rejected', field => {
    const record = setupRecord(SETUP_RECORD_STATES.subscriptions[0], SETUP_RECORD_STATES.reinstall[0])
    const invalid = field === 'reinstall' ? { ...record, reinstall: 'assumed' }
      : { ...record, subscriptions: { ...record.subscriptions, [field]: 'assumed' } }
    const parsed = parseMembershipSetupInput(invalid)
    assertNoLeak({ record: invalid, parsed })
    expect(parsed).toBeUndefined()
  })

  test('verification and summary distinguish inventory from recorded current-app setup', () => {
    const check = takesEffect()
    expect(check).toContain(MEMBERSHIP_RECORD_LINK)
    expect(check).toContain('report `inventory.state` separately from `setup.state`')
    expect(check).toContain('recorded subscription evidence and reinstall status for its current app')
    expect(check).toContain('A reply does not prove complete inventory or verified subscription/reinstall setup')
    const summary = flat(requiredSection(skill, titled(3, 'Summary'), SKILL_FILE))
    expect(summary).toContain('membership inventory state')
    expect(summary).toContain('separately, current-app setup state')
    expect(summary).toContain('recorded subscription evidence and reinstall status')
    expect(summary).toContain('no current-app record exists or a value remains unknown')
    expect(sentenceUnits(check + '\n\n' + summary).filter(sentence => /\b(?:a |the )?reply (?:proves|verifies|confirms)\b/i.test(sentence))).toEqual([])
  })
})
const modeRequirements: Array<[string, RegExp]> = [
  ['the setting name', /`channel_mode`/],
  ...CHANNEL_MODES.map(mode => [`mode ${mode}`, new RegExp('`' + mode + '`')] as [string, RegExp]),
  ['strict is the default', /(?:default.{0,40}strict|strict.{0,40}default)/i],
]
function sharedEntryProblems(entry: Record<string, unknown>): string[] {
  const errors = Object.keys(entry).filter(key => !(PERSONA_ENTRY_KEYS as readonly string[]).includes(key)).map(key => `unknown key ${key}`)
  if (!('permission_prompts' in entry)) errors.push('permission_prompts is required')
  return errors
}
describe('setup wizard: current shared strict/open configuration', () => {
  test('channel-mode selection sits between state detection and persona declaration', () => {
    const titles = headings(skill).map(h => h.text)
    const mode = titles.findIndex(text => titled(3, 'Channel mode').test(text))
    const detect = titles.findIndex(text => titled(3, 'Detect the server state').test(text))
    const declare = titles.findIndex(text => titled(3, 'Add a persona').test(text))
    expect(detect).toBeGreaterThanOrEqual(0)
    expect(mode).toBeGreaterThan(detect)
    expect(declare).toBeGreaterThan(mode)
  })
  test.each(modeRequirements)('the channel-mode step explains %s', (_label, pattern) => {
    expect(flat(modeStep(skill))).toMatch(pattern)
  })
  test.each(modeRequirements)('a missing or misplaced %s fails its scoped mode check', (_label, pattern) => {
    const body = flat(modeStep(skill))
    expect(body).toMatch(pattern)
    const removed = body.replace(new RegExp(pattern.source, pattern.flags + 'g'), '')
    expect(removed).not.toMatch(pattern)
  })
  test.each([...DELIVERY_MODES])('the shared Channels step offers %s explicitly', delivery => {
    expect(flat(personaStep(skill, 'Channels'))).toContain('`' + delivery + '`')
  })
  test('permission_prompts is required in both modes, and no removed section supplies a default', () => {
    const text = flat(personaStep(skill, 'Permission prompts'))
    expect(text).toContain('`permission_prompts`')
    expect(text).toMatch(/required/i)
    expect(text).not.toMatch(/`invited(?:\.permission_prompts)?`/)
  })
  test('every persona example declares the shared destination and only current keys', () => {
    const examples = splitFences(personaStep(skill, 'Declare the persona')).blocks.filter(block => block.info === 'json').map(block => JSON.parse(block.body) as Record<string, unknown>)
    expect(examples.length).toBeGreaterThan(0)
    for (const entry of examples) expect(sharedEntryProblems(entry)).toEqual([])
  })
  test.each([
    ['missing destination', { name: 'persona' }, ['permission_prompts is required']],
    ['removed invited section', { name: 'persona', permission_prompts: 'C0TEST001', invited: {} }, ['unknown key invited']],
    ['unknown field', { name: 'persona', permission_prompts: 'C0TEST001', extra_field: true }, ['unknown key extra_field']],
  ] as const)('the example checker rejects %s', (_label, entry, errors) => {
    expect(sharedEntryProblems(entry)).toEqual([...errors])
    expect(sharedEntryProblems({ name: 'persona', permission_prompts: 'C0TEST001', channels: [] })).toEqual([])
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
 * the phrasings the pre-persona wizard used to take tokens in chat, and
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
    ['confirmed own or inherited reminders apply immediately, keeping the session without a restart', /Confirmed `stop_hook_bootstrap` changes, whether set on a persona or inherited from the top level, also apply immediately to reminder checks and keep the running session; no restart is needed\./],
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

/** Relative Markdown links resolve from the wizard, with GitHub heading anchors. */
function brokenRepoLinks(text: string): string[] {
  const targets = [...splitFences(text).prose.matchAll(/\]\(([^)\s]+)\)/g)].map(match => match[1])
  return targets.filter(target => {
    if (/^(?:[a-z][a-z0-9+.-]*:|\/\/|\/)/i.test(target)) return false
    const [path, anchor] = target.split('#')
    if (!path) return false // Same-file links have their own check below.
    const file = resolve(REPO_ROOT, dirname(SKILL_FILE), decodeURIComponent(path))
    if (!existsSync(file) || !statSync(file).isFile()) return true
    return anchor !== undefined && !headingAnchors(readFileSync(file, 'utf-8')).includes(decodeURIComponent(anchor))
  })
}

describe('setup wizard: cross-references resolve', () => {
  const allTitles = [...[...userDocHeadings.values()].flat(), ...debugSkillHeadings]

  test('every heading the wizard names in a code span is a heading of a user doc or the debug skill', () => {
    const named = [...flat(skill).matchAll(/`(#{1,4} [^`]+)`/g)].map((m) => m[1])
    expect(named.length).toBeGreaterThan(0)
    expect(named.filter((h) => !allTitles.includes(h))).toEqual([])
  })

  test('a heading named after its doc (`docs/x.md`\'s `### Title`) is a heading of that doc', () => {
    const pairs = [...flat(skill).matchAll(/`((?:README|docs\/[a-z-]+)\.md)`(?:'s)? `(#{1,4} [^`]+)`/g)].map((m) => [m[1], m[2]] as const)
    expect(pairs.length).toBeGreaterThan(0)
    expect(pairs.filter(([file, h]) => !(userDocHeadings.get(file) ?? []).includes(h)).map(([file, h]) => `${file}: ${h}`)).toEqual([])
  })

  test("a heading named after the debug skill (the debug skill's `### Title`) is a heading of the debug skill", () => {
    const named = [...flat(skill).matchAll(/the debug skill's `(#{1,4} [^`]+)`/g)].map((m) => m[1])
    expect(named.length).toBeGreaterThan(0)
    expect(named.filter((h) => !debugSkillHeadings.includes(h))).toEqual([])
  })

  test('every same-file link targets a wizard heading', () => {
    const anchors = headingAnchors(skill)
    const links = [...skill.matchAll(/\]\(#([^)\s]+)\)/g)].map((m) => m[1])
    expect(links.length).toBeGreaterThan(0)
    expect(links.filter((a) => !anchors.includes(a))).toEqual([])
  })

  test('every relative repository link names an existing file and heading', () => {
    expect(brokenRepoLinks(skill)).toEqual([])
  })
  test.each([
    '../../docs/migration.md#missing-upgrade-heading',
    '../../docs/missing-upgrade-page.md',
    '../debug-slack-channel-bots/SKILL.md#missing-membership-record',
  ])('self-check: a broken repository target %s fails', target => {
    const edited = skill.replace(UPGRADE_LINK, `(${target})`)
    expect(edited).not.toBe(skill)
    expect(brokenRepoLinks(edited)).toEqual([target])
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
    // named by quoted title in "Channels" and "How the change takes effect".
    '## A persona is silent in a channel its app was invited to',
    // named by quoted title in "Reusing an existing app".
    '## The message archive shows channel IDs: re-install each app to gain `channels:read` and `groups:read`',
  ])('the debugging-skill entry the wizard points to exists: %s', (heading) => {
    const title = heading.replace(/^#+ /, '')
    expect(flat(skill).includes(title.replace(/^`(.*)`$/, '$1'))).toBe(true)
    expect(headings(debugSkill).map((h) => h.text)).toContain(heading)
  })
})
