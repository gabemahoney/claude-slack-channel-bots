/**
 * live-config.ts — the persona config and system prompt the runner writes in
 * the container, exactly as the setup wizard's answers in testplans/b.yko
 * Part 1.5 would produce them (A: a-home `all` + coordination `mentions`, DMs
 * off, prompts to a-home; B: coordination `mentions`, DMs on with the human
 * as contact, prompts by DM; C: no channel, DMs on, prompts by DM;
 * `ack_reaction: "eyes"`; the Step 6 Role text), and D's entry for Check 25.
 *
 * The runner writes these instead of running the wizard (a deviation the
 * results' Notes record). The configuration also names the container's
 * crontable (`cron_table_path`, `CONTAINER_CRON_TABLE_PATH`), which the
 * wizard leaves out: the default (`~/.config/cscb/crontab`, bug b.avm) is on
 * the read-only credentials mount. Neither the configuration it writes nor D's entry
 * carries the invited-channel switch or an `invited` section: every check
 * before Check 30 runs with the switch absent (b.deo SRI-1507).
 *
 * Check 30's switch-on edit (`switchOnFilter`, b.deo SRI-1501) is a jq filter
 * applied to config.json through the plan's confirmed edit. It sets the
 * switch and gives every persona an `invited.permission_prompts` that keeps
 * the change valid and keeps the persona's destination where it is: A the
 * a-home channel, B and C `"dm"`, and D, only when D is still declared, the
 * d-home channel. A takes a-home, not `"dm"`: its DMs are off after setup and
 * Check 1, and on with no `dm.contact` after Part 7, so `"dm"` would be
 * invalid in either state. The filter handles D's presence itself, so one
 * filter serves both the state setup and Check 1 leave (a targeted run) and
 * the full run's state after Check 28. It changes nothing else: each
 * persona's `channels`, top-level `permission_prompts` and `dm` keep their
 * values. Checks 32 and 33 turn the switch off and on again with an edit of
 * the switch alone (`switchFilter`). The setting names are copies of
 * src/'s (the runner loads no other src/ module), pinned by
 * tests/ci-live-checks.test.ts.
 *
 * Pure: IDs in, JSON or a jq filter out.
 */

import { credentialsFileName, personaName, PERSONA_LETTERS, type PersonaLetter } from './personas.ts'

export interface WorkspaceIds {
  teamId: string
  humanUserId: string
  aHome: string
  coordination: string
  dHome: string
}

/** The container's state directory (the default; no SLACK_STATE_DIR). */
export const CONTAINER_STATE_DIR = '/home/testuser/.claude/channels/slack'
export const SYSTEM_PROMPT_PATH = `${CONTAINER_STATE_DIR}/system-prompt.md`

/**
 * The container's crontable, named in config.json (`cron_table_path`) in the
 * state directory, where every run before bug b.avm had it. A deviation from
 * the wizard's answers, which leave the key out: the default would be
 * `~/.config/cscb/crontab` (b.avm), and the container's `~/.config/cscb` is
 * the runner's read-only mount of the credentials directory, so the
 * scheduler could not create it there. The state directory exists before
 * the first start (the runner writes config.json in it), as a written path
 * needs (the server never makes its directory, D-Q1).
 */
export const CONTAINER_CRON_TABLE_PATH = `${CONTAINER_STATE_DIR}/crontab`

/** The Role text the plan's Part 1.5 table gives for Step 6. */
export const ROLE_TEXT =
  'You are a test persona in an acceptance run. Answer every Slack message with the reply tool, briefly, and do what it asks.'

export interface PersonaEntry {
  name: string
  credentials_file: string
  working_directory: string
  channels?: { id: string; delivery: 'all' | 'mentions' }[]
  dm?: { enabled: boolean; contact?: string }
  permission_prompts: string
  /** The fungible section (b.deo SRI-102): only Check 30's edit writes it. */
  invited?: { permission_prompts: string }
}

export interface LiveConfig {
  personas: PersonaEntry[]
  ack_reaction: string
  append_system_prompt_file: string
  /** The container's crontable (`CONTAINER_CRON_TABLE_PATH`): not a wizard answer. */
  cron_table_path: string
  /** The invited-channel switch (`SWITCH_KEY`, b.deo SRI-101): only Checks 30, 32 and 33's edits write it. */
  [SWITCH_KEY]?: boolean
}

/** The invited-channel switch's key (src/config.ts's `allow_invited_channels`, b.deo SRI-101). */
export const SWITCH_KEY = 'allow_invited_channels'
/** The fungible section's key (b.deo SRI-102). */
export const INVITED_KEY = 'invited'
/** The fungible section's destination key (src/config.ts's `PERSONA_INVITED_KEYS`). */
export const INVITED_PERMISSION_PROMPTS_KEY = 'permission_prompts'
/** The destination value that sends a persona's prompts and notices to its DM with its contact. */
export const DM_DESTINATION = 'dm'

/** Each persona's `invited.permission_prompts` in Check 30's edit: A a-home, B and C `"dm"`, D d-home. */
export function invitedDestinationFor(letter: PersonaLetter, ids: WorkspaceIds): string {
  switch (letter) {
    case 'a':
      return ids.aHome
    case 'b':
    case 'c':
      return DM_DESTINATION
    case 'd':
      return ids.dHome
  }
}

/**
 * Check 30's switch-on edit as a jq filter over config.json (b.deo SRI-1501):
 * the switch set to true, and each persona of A to D present in the file
 * given its `invited.permission_prompts` (`invitedDestinationFor`). A persona
 * absent from the file (D, after Check 27) gets nothing; every other key is
 * kept. Pure.
 */
export function switchOnFilter(ids: WorkspaceIds): string {
  const branches = PERSONA_LETTERS.map((l, i) => {
    const section = JSON.stringify({ [INVITED_PERMISSION_PROMPTS_KEY]: invitedDestinationFor(l, ids) })
    return `${i === 0 ? 'if' : 'elif'} .name == ${JSON.stringify(personaName(l))} then .${INVITED_KEY} = ${section}`
  })
  return `.${SWITCH_KEY} = true | .personas |= map(${branches.join(' ')} else . end)`
}

/** An edit of the switch alone, as a jq filter (Checks 32 and 33). Pure. */
export function switchFilter(on: boolean): string {
  return `.${SWITCH_KEY} = ${on}`
}

/** A jq expression for the switch's value in a configuration file: `true` or `false` (absent reads as false). */
export const SWITCH_VALUE_JQ = `(.${SWITCH_KEY} // false)`

function base(letter: PersonaLetter): Pick<PersonaEntry, 'name' | 'credentials_file' | 'working_directory'> {
  return {
    name: personaName(letter),
    credentials_file: `~/.config/cscb/${credentialsFileName(letter)}`,
    working_directory: `~/cscb-live/${letter}`,
  }
}

export function personaEntryFor(letter: PersonaLetter, ids: WorkspaceIds): PersonaEntry {
  switch (letter) {
    case 'a':
      return {
        ...base('a'),
        channels: [
          { id: ids.aHome, delivery: 'all' },
          { id: ids.coordination, delivery: 'mentions' },
        ],
        permission_prompts: ids.aHome,
      }
    case 'b':
      return {
        ...base('b'),
        channels: [{ id: ids.coordination, delivery: 'mentions' }],
        dm: { enabled: true, contact: ids.humanUserId },
        permission_prompts: 'dm',
      }
    case 'c':
      return { ...base('c'), dm: { enabled: true, contact: ids.humanUserId }, permission_prompts: 'dm' }
    case 'd':
      return {
        ...base('d'),
        channels: [{ id: ids.dHome, delivery: 'mentions' }],
        dm: { enabled: true, contact: ids.humanUserId },
        permission_prompts: ids.dHome,
      }
  }
}

/** config.json after the three wizard runs of Part 1.5, with the container's crontable (`CONTAINER_CRON_TABLE_PATH`). */
export function buildLiveConfig(ids: WorkspaceIds): LiveConfig {
  return {
    personas: (['a', 'b', 'c'] as const).map((l) => personaEntryFor(l, ids)),
    ack_reaction: 'eyes',
    append_system_prompt_file: SYSTEM_PROMPT_PATH,
    cron_table_path: CONTAINER_CRON_TABLE_PATH,
  }
}

export function renderConfig(config: unknown): string {
  return `${JSON.stringify(config, null, 2)}\n`
}

/**
 * The system-prompt file from the shipped template (`skills/EXAMPLE_CLAUDE.md`):
 * its Communication and persona sections kept, its Role section replaced.
 */
export function systemPromptFromTemplate(template: string, role: string = ROLE_TEXT): string {
  const marker = /^# Role\s*$/m
  const match = marker.exec(template)
  if (!match) throw new Error('the system-prompt template has no "# Role" section')
  return `${template.slice(0, match.index)}# Role\n${role}\n`
}
