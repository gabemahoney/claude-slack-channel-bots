/** Pure producers for the current shared channel configuration used by the live runner. */

import { credentialsFileName, personaName, type PersonaLetter } from './personas.ts'

export interface WorkspaceIds {
  teamId: string
  humanUserId: string
  aHome: string
  coordination: string
  dHome: string
}

/**
 * The container's state directory (the default, `~/.config/claude-slack-channel-bots`
 * since; no SLACK_STATE_DIR). The runner's read-only credentials mount is a
 * sibling directory, `CONTAINER_CREDENTIALS_DIR` (`~/.config/cscb-credentials`),
 * so the server can write here.
 */
export const CONTAINER_STATE_DIR = '/home/testuser/.config/claude-slack-channel-bots'
export const SYSTEM_PROMPT_PATH = `${CONTAINER_STATE_DIR}/system-prompt.md`

/**
 * The container's crontable, named in config.json (`cron_table_path`) in the
 * state directory. A deviation from the wizard's answers, which leave the key
 * out: the default is this same path (`<state dir>/crontab`), and
 * writing it out keeps the run independent of the default-crontable
 * preparation. The state directory exists before the first start (the runner
 * writes config.json in it), as a written path needs (the server never makes
 * a crontable's directory, D-Q1).
 */
export const CONTAINER_CRON_TABLE_PATH = `${CONTAINER_STATE_DIR}/crontab`

/** The Role text the plan's Part 1.5 table gives for Step 6. */
export const ROLE_TEXT =
  'You are a test persona in an acceptance run. Answer every Slack message with the reply tool, briefly, and do what it asks.'

export interface PersonaEntry {
  name: string
  credentials_file: string
  working_directory: string
  channels?: { id: string; delivery: 'off' | 'mentions' | 'all' | 'thread_hybrid' }[]
  dm?: { enabled: boolean; contact?: string }
  permission_prompts: string
}

export interface LiveConfig {
  personas: PersonaEntry[]
  ack_reaction: string
  append_system_prompt_file: string
  /** The container's crontable (`CONTAINER_CRON_TABLE_PATH`): not a wizard answer. */
  cron_table_path: string
  /** Mode defaults to strict when absent. */
  [SWITCH_KEY]?: 'strict' | 'open'
}

/** The shared channel mode key, pinned against the production schema. */
export const SWITCH_KEY = 'channel_mode'
/** Shared destination key; retained export names identify the live check's controls. */
export const INVITED_KEY = 'permission_prompts'
export const INVITED_PERMISSION_PROMPTS_KEY = 'permission_prompts'
/** The destination value that sends a persona's prompts and notices to its DM with its contact. */
export const DM_DESTINATION = 'dm'

/** Each persona's shared destination remains the same across mode changes. */
export function invitedDestinationFor(letter: PersonaLetter, ids: WorkspaceIds): string {
  switch (letter) {
    case 'a': return ids.aHome
    case 'b':
    case 'c': return DM_DESTINATION
    case 'd': return ids.dHome
  }
}

/** Check 30 changes only the mode; it never invents assignments or destinations. */
export function switchOnFilter(_ids: WorkspaceIds): string {
  return switchFilter(true)
}

/** A mode-only edit (Checks 32 and 33). */
export function switchFilter(on: boolean): string {
  return `.${SWITCH_KEY} = ${JSON.stringify(on ? 'open' : 'strict')}`
}

/** Whether a configuration selects open mode, including the strict default. */
export const SWITCH_VALUE_JQ = `((.${SWITCH_KEY} // "strict") == "open")`

function base(letter: PersonaLetter): Pick<PersonaEntry, 'name' | 'credentials_file' | 'working_directory'> {
  return {
    name: personaName(letter),
    credentials_file: `~/.config/cscb-credentials/${credentialsFileName(letter)}`,
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
