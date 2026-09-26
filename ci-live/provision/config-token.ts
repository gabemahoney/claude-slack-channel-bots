/**
 * config-token.ts — the app configuration token, used only for the manifest
 * API on the test workspace's four apps.
 *
 * `callWithConfigToken` makes one manifest call. When Slack refuses the token
 * as expired and a refresh token exists, it rotates both once with
 * `tooling.tokens.rotate`, rewrites both files atomically (mode 600) and
 * retries. Any other token refusal is non-runnable (exit 2), naming the file
 * to refresh, never the value.
 */

import { NotRunnableError, type ConfigTokens } from '../lib/secrets.ts'
import { safeErrorCode, TOKEN_REFUSED_CODES, type SlackApi, type SlackParams, type SlackResponse } from '../lib/slack-api.ts'

export interface ConfigTokenStore {
  read(): ConfigTokens
  write(tokens: { token: string; refreshToken: string }): void
  /** The file to name in a refusal message. */
  tokenPath: string
}

export class ConfigTokenSource {
  private tokens: ConfigTokens | null = null
  private rotated = false

  constructor(
    private readonly api: SlackApi,
    private readonly store: ConfigTokenStore,
  ) {}

  private current(): ConfigTokens {
    if (!this.tokens) this.tokens = this.store.read()
    return this.tokens
  }

  /** Rotate with the refresh token; `false` when there is none or the rotation is refused. */
  private async rotate(): Promise<boolean> {
    const { refreshToken } = this.current()
    if (refreshToken === null || this.rotated) return false
    this.rotated = true
    const answer = await this.api.call('tooling.tokens.rotate', null, { refresh_token: refreshToken })
    const token = answer.token
    const next = answer.refresh_token
    if (!answer.ok || typeof token !== 'string' || typeof next !== 'string') return false
    this.store.write({ token, refreshToken: next })
    this.tokens = { token, refreshToken: next }
    return true
  }

  /** One manifest API call with the configuration token (rotated once if it expired). */
  async call(method: string, params: SlackParams): Promise<SlackResponse> {
    let answer = await this.api.call(method, this.current().token, params)
    if (!answer.ok && TOKEN_REFUSED_CODES.has(safeErrorCode(answer))) {
      const code = safeErrorCode(answer)
      if (code === 'token_expired' && (await this.rotate())) {
        answer = await this.api.call(method, this.current().token, params)
        if (answer.ok || !TOKEN_REFUSED_CODES.has(safeErrorCode(answer))) return answer
      }
      throw new NotRunnableError(
        `the Slack app configuration token was refused (${safeErrorCode(answer)}): write a fresh one to ${this.store.tokenPath} (mode 600)`,
      )
    }
    return answer
  }
}
