/**
 * bot-api.ts — the checks the runner makes with a persona's own tokens:
 * `auth.test` and `bots.info` with the bot token, and `apps.connections.open`
 * with the app-level token (called, its WebSocket URL discarded unopened).
 *
 * Results carry IDs and Slack error codes only. A failed check says why by
 * its code: `isTokenRefusal` tells a token Slack refused (replace it) from a
 * transient or other failure (keep it and stop; a rerun may pass).
 */

import { isAppId, isBotId, isTeamId, isUserId } from '../lib/apps-state.ts'
import { safeErrorCode, SlackTransportError, TOKEN_REFUSED_CODES, type SlackApi } from '../lib/slack-api.ts'

export interface BotIdentity {
  ok: true
  userId: string
  botId: string
  teamId: string
  appId: string | null
  /** Set when `bots.info` failed (its code), so `appId` is unknown rather than absent. */
  appLookupError?: string
}

export type BotCheck = BotIdentity | { ok: false; error: string }

export type AppTokenCheck = { ok: true } | { ok: false; error: string }

/** Failure codes that mean the token itself is unusable: Slack refused it, it is no bot token, or there is none. */
const REPLACEABLE_CODES = new Set([...TOKEN_REFUSED_CODES, 'not_a_bot_token', 'empty'])

/**
 * True when a token check's failure code means the token must be replaced.
 * Anything else (a network error, a timeout, a 5xx, a 429 left after the
 * retries, `internal_error` …) is not a reason to replace a token.
 */
export function isTokenRefusal(code: string): boolean {
  return REPLACEABLE_CODES.has(code)
}

function transportCode(err: unknown): string {
  return err instanceof SlackTransportError ? `${err.kind}${err.status !== undefined ? `_${err.status}` : ''}` : 'call_failed'
}

export class BotApi {
  constructor(private readonly api: SlackApi) {}

  /** `auth.test` with the bot token, then `bots.info` for its app ID. */
  async checkBotToken(botToken: string): Promise<BotCheck> {
    if (botToken === '') return { ok: false, error: 'empty' }
    let identity: BotIdentity
    try {
      const auth = await this.api.call('auth.test', botToken)
      if (!auth.ok) return { ok: false, error: safeErrorCode(auth) }
      const { user_id, bot_id, team_id } = auth
      if (!isUserId(user_id) || !isBotId(bot_id) || !isTeamId(team_id)) return { ok: false, error: 'not_a_bot_token' }
      identity = { ok: true, userId: user_id, botId: bot_id, teamId: team_id, appId: null }
    } catch (err) {
      return { ok: false, error: transportCode(err) }
    }
    try {
      const info = await this.api.call('bots.info', botToken, { bot: identity.botId })
      if (!info.ok) return { ...identity, appLookupError: safeErrorCode(info) }
      const bot = info.bot && typeof info.bot === 'object' ? (info.bot as Record<string, unknown>) : null
      return { ...identity, appId: bot && isAppId(bot.app_id) ? bot.app_id : null }
    } catch (err) {
      return { ...identity, appLookupError: transportCode(err) }
    }
  }

  /** `apps.connections.open` with the app-level token; the returned URL is dropped unopened. */
  async checkAppToken(appToken: string): Promise<AppTokenCheck> {
    if (appToken === '') return { ok: false, error: 'empty' }
    try {
      const open = await this.api.call('apps.connections.open', appToken)
      return open.ok ? { ok: true } : { ok: false, error: safeErrorCode(open) }
    } catch (err) {
      return { ok: false, error: transportCode(err) }
    }
  }
}
