/**
 * channels.ts — provisioning stage 5: the test channels and who is in them,
 * through the test human's own session API.
 *
 * Ensures public channels `a-home`, `coordination` and `d-home` exist
 * (unarchived) with the human as a member; invites A to a-home and
 * coordination, B to coordination and D to d-home; and removes any persona
 * bot from a test channel it must not be in. C must be in no channel at all:
 * every conversation it is in is left by a `conversations.kick`. Records
 * the channel IDs, the team ID and the human's user ID in apps.json.
 */

import { isChannelId, isTeamId, isUserId, type AppsState } from '../lib/apps-state.ts'
import type { HumanApi } from '../lib/browser-types.ts'
import {
  appDisplayName,
  CHANNEL_MEMBERSHIP,
  CHANNEL_NAMES,
  PERSONA_LETTERS,
  type ChannelName,
  type PersonaLetter,
} from '../lib/personas.ts'
import { safeErrorCode, type SlackResponse } from '../lib/slack-api.ts'
import { ProvisionError } from './install.ts'

export interface ChannelsStageDeps {
  human: HumanApi
  appsFile: { load(): AppsState; update(change: (state: AppsState) => void): AppsState }
  log: { info(message: string): void }
}

interface ChannelInfo {
  id: string
  name: string
  is_archived: boolean
  is_member: boolean
}

function need(answer: SlackResponse, what: string, allowed: readonly string[] = []): SlackResponse {
  if (!answer.ok && !allowed.includes(safeErrorCode(answer))) {
    throw new ProvisionError(`channels: ${what} failed: ${safeErrorCode(answer)}`)
  }
  return answer
}

function asChannel(value: unknown): ChannelInfo | null {
  if (!value || typeof value !== 'object') return null
  const v = value as Record<string, unknown>
  if (!isChannelId(v.id) || typeof v.name !== 'string') return null
  return { id: v.id, name: v.name, is_archived: v.is_archived === true, is_member: v.is_member === true }
}

function nextCursor(answer: SlackResponse): string {
  const meta = answer.response_metadata
  const cursor = meta && typeof meta === 'object' ? (meta as Record<string, unknown>).next_cursor : undefined
  return typeof cursor === 'string' ? cursor : ''
}

/** Every public channel of the workspace (archived included), paged. */
export async function listPublicChannels(human: HumanApi): Promise<ChannelInfo[]> {
  const out: ChannelInfo[] = []
  let cursor = ''
  for (let page = 0; page < 50; page++) {
    const answer = need(
      await human.call('conversations.list', { types: 'public_channel', exclude_archived: false, limit: 200, cursor: cursor || undefined }),
      'conversations.list',
    )
    const channels = Array.isArray(answer.channels) ? answer.channels : []
    for (const c of channels) {
      const info = asChannel(c)
      if (info) out.push(info)
    }
    cursor = nextCursor(answer)
    if (cursor === '') break
  }
  return out
}

/** The member user IDs of a conversation, paged. */
export async function listMembers(human: HumanApi, channel: string): Promise<string[]> {
  const out: string[] = []
  let cursor = ''
  for (let page = 0; page < 50; page++) {
    const answer = need(
      await human.call('conversations.members', { channel, limit: 200, cursor: cursor || undefined }),
      'conversations.members',
    )
    for (const m of Array.isArray(answer.members) ? answer.members : []) if (isUserId(m)) out.push(m)
    cursor = nextCursor(answer)
    if (cursor === '') break
  }
  return out
}

/** The conversations (public and private channels) a user is in. */
export async function conversationsOf(human: HumanApi, user: string): Promise<string[]> {
  const answer = need(
    await human.call('users.conversations', { user, types: 'public_channel,private_channel', limit: 200 }),
    'users.conversations',
  )
  const out: string[] = []
  for (const c of Array.isArray(answer.channels) ? answer.channels : []) {
    const info = asChannel(c)
    if (info) out.push(info.id)
  }
  return out
}

async function ensureChannel(deps: ChannelsStageDeps, existing: ChannelInfo[], name: ChannelName): Promise<string> {
  let channel = existing.find((c) => c.name === name) ?? null
  if (!channel) {
    const created = need(await deps.human.call('conversations.create', { name, is_private: false }), `conversations.create ${name}`)
    channel = asChannel(created.channel)
    if (!channel) throw new ProvisionError(`channels: conversations.create ${name} returned no channel`)
    deps.log.info(`channels: created #${name} (${channel.id})`)
    return channel.id
  }
  if (channel.is_archived) {
    need(await deps.human.call('conversations.unarchive', { channel: channel.id }), `conversations.unarchive ${name}`)
    deps.log.info(`channels: unarchived #${name} (${channel.id})`)
  }
  if (!channel.is_member) {
    need(await deps.human.call('conversations.join', { channel: channel.id }), `conversations.join ${name}`)
  }
  deps.log.info(`channels: #${name} is ${channel.id}`)
  return channel.id
}

export async function runChannelsStage(deps: ChannelsStageDeps): Promise<Record<ChannelName, string>> {
  const auth = need(await deps.human.call('auth.test'), 'auth.test (test human)')
  if (!isUserId(auth.user_id) || !isTeamId(auth.team_id)) throw new ProvisionError('channels: the human auth.test gave no user or team ID')
  const humanUserId = auth.user_id
  const teamId = auth.team_id

  const existing = await listPublicChannels(deps.human)
  const ids = {} as Record<ChannelName, string>
  for (const name of CHANNEL_NAMES) ids[name] = await ensureChannel(deps, existing, name)

  const state = deps.appsFile.load()
  const botUser = (letter: PersonaLetter): string => {
    const id = state.personas[letter]?.bot_user_id
    if (!id) throw new ProvisionError(`channels: ${appDisplayName(letter)} has no bot user ID: run the install stage first`)
    return id
  }

  for (const letter of PERSONA_LETTERS) {
    const user = botUser(letter)
    for (const name of CHANNEL_MEMBERSHIP[letter]) {
      const answer = need(
        await deps.human.call('conversations.invite', { channel: ids[name], users: user }),
        `conversations.invite ${appDisplayName(letter)} to #${name}`,
        ['already_in_channel'],
      )
      if (answer.ok) deps.log.info(`channels: invited ${appDisplayName(letter)} to #${name}`)
    }
  }

  // Nobody where they must not be: each test channel's members, then every conversation C is in.
  const expected = new Map<string, Set<string>>()
  for (const name of CHANNEL_NAMES) {
    expected.set(
      ids[name],
      new Set(PERSONA_LETTERS.filter((l) => CHANNEL_MEMBERSHIP[l].includes(name)).map((l) => botUser(l))),
    )
  }
  const personaUsers = new Map(PERSONA_LETTERS.map((l) => [botUser(l), l] as const))
  for (const name of CHANNEL_NAMES) {
    for (const member of await listMembers(deps.human, ids[name])) {
      const letter = personaUsers.get(member)
      if (letter && !expected.get(ids[name])?.has(member)) {
        need(await deps.human.call('conversations.kick', { channel: ids[name], user: member }), `conversations.kick ${appDisplayName(letter)}`, ['not_in_channel'])
        deps.log.info(`channels: removed ${appDisplayName(letter)} from #${name}`)
      }
    }
  }
  for (const channel of await conversationsOf(deps.human, botUser('c'))) {
    need(await deps.human.call('conversations.kick', { channel, user: botUser('c') }), 'conversations.kick CSCB Test C', ['not_in_channel'])
    deps.log.info(`channels: removed ${appDisplayName('c')} from ${channel}`)
  }

  deps.appsFile.update((s) => {
    s.human_user_id = humanUserId
    s.team_id = teamId
    for (const name of CHANNEL_NAMES) s.channels[name] = ids[name]
  })
  return ids
}
