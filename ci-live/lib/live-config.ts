/**
 * live-config.ts — the persona config and system prompt the runner writes in
 * the container, exactly as the setup wizard's answers in testplans/b.yko
 * Part 1.5 would produce them (A: a-home `all` + coordination `mentions`, DMs
 * off, prompts to a-home; B: coordination `mentions`, DMs on with the human
 * as contact, prompts by DM; C: no channel, DMs on, prompts by DM;
 * `ack_reaction: "eyes"`; the Step 6 Role text), and D's entry for Check 25.
 *
 * The runner writes these instead of running the wizard (a deviation the
 * results' Notes record). Pure: IDs in, JSON out.
 */

import { credentialsFileName, personaName, type PersonaLetter } from './personas.ts'

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
}

export interface LiveConfig {
  personas: PersonaEntry[]
  ack_reaction: string
  append_system_prompt_file: string
}

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

/** config.json after the three wizard runs of Part 1.5. */
export function buildLiveConfig(ids: WorkspaceIds): LiveConfig {
  return {
    personas: (['a', 'b', 'c'] as const).map((l) => personaEntryFor(l, ids)),
    ack_reaction: 'eyes',
    append_system_prompt_file: SYSTEM_PROMPT_PATH,
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
