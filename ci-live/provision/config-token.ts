/**
 * config-token.ts — the app configuration token, used only for the manifest
 * API on the test workspace's four apps (and the `apps --delete-strays`
 * command's deletes).
 *
 * `call` makes one manifest call. When Slack refuses the token as expired and
 * a refresh token exists, it rotates both once with `tooling.tokens.rotate`
 * and retries. A rotation spends the old refresh token, so the new pair is
 * saved (both files, mode 600, atomically, the refresh token first) before
 * anything uses the new token, and a pair that can't be saved stops the run
 * saying so. A successful rotation logs ROTATED_LINE, never a value.
 *
 * A token that is missing (no file, or an empty one) or refused (after the
 * one rotation, when there is a refresh token) is a
 * `ConfigTokenUnavailableError`: not runnable (exit 2), naming the file to
 * refresh, never the value. The apps stage catches it and goes on without
 * the token when apps.json records every app (provision/apps.ts).
 *
 * `rotateNow` forces one rotation (`bun ci-live/run.ts config-token
 * --rotate`), so the operator can prove rotation end to end.
 */

import { describeError } from '../lib/errors.ts'
import { MissingSecretError, NotRunnableError, type ConfigTokens } from '../lib/secrets.ts'
import { safeErrorCode, SlackTransportError, TOKEN_REFUSED_CODES, type SlackApi, type SlackParams, type SlackResponse } from '../lib/slack-api.ts'

/** The one line a successful rotation logs. */
export const ROTATED_LINE = 'config token: rotated with tooling.tokens.rotate; both token files rewritten (mode 600)'

export interface ConfigTokenStore {
  read(): ConfigTokens
  /** Save both tokens (mode 600, atomically, the refresh token first). */
  write(tokens: { token: string; refreshToken: string }): void
  /** The file to name in a refusal message. */
  tokenPath: string
  /** The refresh token's file, to name when there is none. */
  refreshTokenPath?: string
}

/**
 * The configuration token can't be used: its file is missing or empty, or
 * Slack refused it (as expired, after a rotation that was impossible or
 * refused, or otherwise). Not runnable, unless the caller can do without it.
 */
export class ConfigTokenUnavailableError extends NotRunnableError {
  constructor(message: string) {
    super(message)
    this.name = 'ConfigTokenUnavailableError'
  }
}

/** Where a new pair comes from, for the operator. */
const NEW_PAIR_HINT = 'generate a new pair for the test workspace at https://api.slack.com/apps (Your App Configuration Tokens) and write both files (mode 600)'

type Rotation = { ok: true } | { ok: false; code: string }

export class ConfigTokenSource {
  private tokens: ConfigTokens | null = null
  private rotated = false

  constructor(
    private readonly api: SlackApi,
    private readonly store: ConfigTokenStore,
    private readonly log: { info(message: string): void } | null = null,
  ) {}

  private current(): ConfigTokens {
    if (!this.tokens) {
      try {
        this.tokens = this.store.read()
      } catch (err) {
        if (err instanceof MissingSecretError) throw new ConfigTokenUnavailableError(err.message)
        throw err
      }
    }
    return this.tokens
  }

  /**
   * One `tooling.tokens.rotate` with `refreshToken`. On success both new
   * tokens are saved before anything else happens (the old refresh token is
   * spent from here on); a save that fails is not runnable.
   */
  private async rotateWith(refreshToken: string): Promise<Rotation> {
    const answer = await this.api.call('tooling.tokens.rotate', null, { refresh_token: refreshToken })
    const token = answer.token
    const next = answer.refresh_token
    if (!answer.ok || typeof token !== 'string' || typeof next !== 'string') {
      return { ok: false, code: answer.ok ? 'no_token_in_answer' : safeErrorCode(answer) }
    }
    try {
      this.store.write({ token, refreshToken: next })
    } catch (err) {
      throw new NotRunnableError(
        `tooling.tokens.rotate issued a new token pair, but saving it failed (${describeError(err)}): the old refresh token is spent, so ${NEW_PAIR_HINT}`,
      )
    }
    this.tokens = { token, refreshToken: next }
    this.log?.info(ROTATED_LINE)
    return { ok: true }
  }

  /** Rotate once with the refresh token; `false` when there is none, the rotation is refused, or it got no answer. */
  private async rotate(): Promise<boolean> {
    const { refreshToken } = this.current()
    if (refreshToken === null || this.rotated) return false
    this.rotated = true
    let rotation: Rotation
    try {
      rotation = await this.rotateWith(refreshToken)
    } catch (err) {
      if (!(err instanceof SlackTransportError)) throw err
      rotation = { ok: false, code: `no answer (${err.kind}${err.status !== undefined ? ` ${err.status}` : ''})` }
    }
    if (!rotation.ok) this.log?.info(`config token: tooling.tokens.rotate failed: ${rotation.code}`)
    return rotation.ok
  }

  /** One manifest API call with the configuration token (rotated once if it expired). */
  async call(method: string, params: SlackParams): Promise<SlackResponse> {
    let answer = await this.api.call(method, this.current().token, params)
    if (answer.ok || !TOKEN_REFUSED_CODES.has(safeErrorCode(answer))) return answer
    if (safeErrorCode(answer) === 'token_expired' && (await this.rotate())) {
      answer = await this.api.call(method, this.current().token, params)
      if (answer.ok || !TOKEN_REFUSED_CODES.has(safeErrorCode(answer))) return answer
    }
    throw new ConfigTokenUnavailableError(
      `the Slack app configuration token was refused (${safeErrorCode(answer)}): write a fresh one to ${this.store.tokenPath} (mode 600)`,
    )
  }

  /**
   * Rotate the pair now, whatever the token's state (`config-token
   * --rotate`). Not runnable when there is no refresh token or Slack refuses
   * it; a rotation that gets no answer throws its `SlackTransportError`.
   */
  async rotateNow(): Promise<void> {
    const { refreshToken } = this.current()
    if (refreshToken === null) {
      throw new NotRunnableError(
        `there is no refresh token to rotate with: write the one issued with the configuration token to ${this.store.refreshTokenPath ?? 'slack_config_refresh_token'} (mode 600)`,
      )
    }
    const rotation = await this.rotateWith(refreshToken)
    if (!rotation.ok) throw new NotRunnableError(`tooling.tokens.rotate refused the refresh token (${rotation.code}): ${NEW_PAIR_HINT}`)
  }
}
