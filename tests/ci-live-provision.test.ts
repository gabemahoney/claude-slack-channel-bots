/**
 * ci-live-provision.test.ts — Tests for the /ci-live runner's host-side
 * provisioning (bug b.1cx): the Slack Web API caller
 * (`ci-live/lib/slack-api.ts`), the configuration token with its rotation
 * (`provision/config-token.ts`), the bot and app-level token checks
 * (`provision/bot-api.ts`), the persona manifests and their drift check
 * (`lib/manifest.ts`), and the stages: apps, install, app-level tokens,
 * channels and validation (`provision/*.ts`).
 *
 * The rules under test:
 * - a token travels only in the `Authorization` header, never in a URL,
 *   body, error or log line; errors carry a method and a safe code only;
 * - a pending-create intent is written to apps.json before
 *   `apps.manifest.create`, and the app ID (clearing it) the moment the call
 *   returns one; a rerun creates, installs and generates nothing again;
 * - a create that got no answer is never retried (not runnable), and its
 *   intent is kept: the next run adopts the one unrecorded app of that exact
 *   name the configuration token exports, creates it when there is none, and
 *   stops (not runnable) when there are several; a candidate whose export
 *   proves nothing (another Slack error, no answer) or an apps list that
 *   can't be read stops the stage with the intent kept and nothing adopted
 *   or created; a refused create clears it;
 *   a real run with no apps.json creates no app unless `--create-apps`;
 * - the configuration token is rotated once when expired, the new pair saved
 *   (refresh token first) before the retry; a missing or refused token is a
 *   `ConfigTokenUnavailableError`, which the apps stage survives with a
 *   warning only when apps.json records all four apps;
 * - `apps --delete-strays` runs only on an apps.json that is there, parses
 *   and records an app ID (read again before each delete), and deletes only
 *   an unrecorded app of an exact test app name whose row has a cell that is
 *   exactly the test workspace's name, exported under that name by the
 *   configuration token; an app whose export proves nothing is kept; the
 *   apps list page's links (`listedAppsFrom`) and the workspace name
 *   (`testWorkspaceName`) are read strictly;
 * - the create answer's `credentials` block is never stored or logged;
 * - a drifted manifest is updated and the app marked for re-install;
 * - a bot or app-level token is replaced only when Slack refuses it; a
 *   transient failure stops the stage and replaces nothing (a freshly
 *   generated token is saved before the stage stops);
 * - a new bot token drops the old app-level token, so a credentials file
 *   never mixes two apps' tokens; generated tokens get the run's name.
 *
 * Slack is faked twice: small scripted `fetch` fakes for the caller's own
 * rules, and the dry run's in-memory workspace (`ci-live/dry-run/stub-state.ts`,
 * reached through a fake `fetch` and a fake browser, so nothing touches the
 * network) for whole provisioning runs. The secret store sits on the
 * in-memory `memSecureFs`.
 *
 * SPDX-License-Identifier: MIT
 */

import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { StubWorkspace } from '../ci-live/dry-run/stub-state.ts'
import { AppsStateFile, parseAppsState, type AppsState } from '../ci-live/lib/apps-state.ts'
import { FlowError, type BrowserDriver, type HumanApi, type ListedApp } from '../ci-live/lib/browser-types.ts'
import { manifestDrift, parseManifestYaml, personaManifest, type JsonObject } from '../ci-live/lib/manifest.ts'
import { hostCredentialsFile, livePathsIn } from '../ci-live/lib/paths.ts'
import { PERSONA_LETTERS, type PersonaLetter } from '../ci-live/lib/personas.ts'
import { Redactor } from '../ci-live/lib/redact.ts'
import { isInside, NotRunnableError, SecretStore } from '../ci-live/lib/secrets.ts'
import { formBody, safeErrorCode, SlackApi, SlackTransportError, type FetchLike, type SlackResponse } from '../ci-live/lib/slack-api.ts'
import {
  appsStateForStrayDeletion,
  classifyListedApps,
  deleteStrayApps,
  describeListedApp,
  listedAppsFrom,
  rowShowsWorkspace,
  testWorkspaceName,
  type AppLink,
} from '../ci-live/provision/app-listing.ts'
import { ambiguousPendingMessage, runAppsStage, AppsStageError, createUnansweredMessage, unverifiedPendingMessage, type AppsStageDeps } from '../ci-live/provision/apps.ts'
import { runAppTokenStage } from '../ci-live/provision/app-tokens.ts'
import { BotApi, isTokenRefusal, type AppTokenCheck, type BotCheck } from '../ci-live/provision/bot-api.ts'
import { ConfigTokenSource, ConfigTokenUnavailableError, ROTATED_LINE } from '../ci-live/provision/config-token.ts'
import { allValid, missingAppsJsonMessage, runProvisioning, stagesToRun, validateCredentials, type ProvisionDeps } from '../ci-live/provision/index.ts'
import { ProvisionError, runInstallStage, TransientProvisionError } from '../ci-live/provision/install.ts'
import { memSecureFs } from './test-helpers/ci-live.ts'
import { APP_TOKEN_PREFIX, assertNoLeak, BOT_TOKEN_PREFIX, fakeToken, LEAK_SENTINEL } from './test-helpers/credentials.ts'

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const BASE_URL = 'http://slack.invalid/api/'
const CONFIG_TOKEN = fakeToken(`${BOT_TOKEN_PREFIX.slice(0, 3)}e.`, 'config')
const BOT_TOKEN = fakeToken(BOT_TOKEN_PREFIX, 'bot')
const APP_TOKEN = fakeToken(APP_TOKEN_PREFIX, 'app')
const REPO_MANIFEST = parseManifestYaml(readFileSync(join(import.meta.dir, '..', 'slack-app-manifest.yml'), 'utf-8'))

interface FetchCall {
  url: string
  method: string
  headers: Record<string, string>
  body: string
  redirect: RequestRedirect | undefined
}

type Scripted = Response | Error | ((call: FetchCall) => Response)

/** A `fetch` that answers from a queue (the last entry repeats) and records each request. */
function scriptedFetch(...script: Scripted[]) {
  const calls: FetchCall[] = []
  const fetch: FetchLike = async (url, init) => {
    const call: FetchCall = {
      url,
      method: new URL(url).pathname.replace('/api/', ''),
      headers: { ...(init.headers as Record<string, string>) },
      body: String(init.body ?? ''),
      redirect: init.redirect,
    }
    calls.push(call)
    const next = script.length > 1 ? script.shift()! : script[0]!
    if (next instanceof Error) throw next
    return typeof next === 'function' ? next(call) : next.clone()
  }
  return { fetch, calls }
}

function json(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), { status: 200, ...init })
}

function api(fetch: FetchLike, sleeps: number[] = []): SlackApi {
  return new SlackApi({ baseUrl: BASE_URL, fetch, sleep: async (ms) => void sleeps.push(ms) })
}

async function rejection(promise: Promise<unknown>): Promise<Error> {
  try {
    await promise
  } catch (err) {
    return err as Error
  }
  throw new Error('expected a rejection')
}

// ---------------------------------------------------------------------------
// The Slack Web API caller
// ---------------------------------------------------------------------------

describe('SlackApi.call', () => {
  test('POSTs a form body to the method URL with the token only in the Authorization header', async () => {
    const f = scriptedFetch(json({ ok: true, user_id: 'U0USER0001' }))
    const answer = await api(f.fetch).call('auth.test', BOT_TOKEN, { a: 1, b: 'x y', skipped: undefined })
    expect(answer).toEqual({ ok: true, user_id: 'U0USER0001' })
    const call = f.calls[0]!
    expect([call.url, call.body, call.redirect]).toEqual([`${BASE_URL}auth.test`, 'a=1&b=x+y', 'error'])
    expect(call.headers.Authorization).toBe(`Bearer ${BOT_TOKEN}`)
    assertNoLeak({ url: call.url, body: call.body })
  })

  test('sends no Authorization header without a token', async () => {
    const f = scriptedFetch(json({ ok: true }))
    await api(f.fetch).call('tooling.tokens.rotate', null, { refresh_token: 'r' })
    expect(f.calls[0]!.headers.Authorization).toBeUndefined()
  })

  test.each([
    ['7', 7000],
    ['junk', 1000],
    ['600', 60_000],
  ])('waits out a 429 with Retry-After %p (%p ms), then retries', async (retryAfter, waited) => {
    const sleeps: number[] = []
    const f = scriptedFetch(new Response('', { status: 429, headers: { 'retry-after': retryAfter } }), json({ ok: true }))
    expect((await api(f.fetch, sleeps).call('auth.test', BOT_TOKEN)).ok).toBe(true)
    expect(sleeps).toEqual([waited])
    expect(f.calls.length).toBe(2)
  })

  test('gives up after three rate-limit retries', async () => {
    const sleeps: number[] = []
    const f = scriptedFetch(new Response('', { status: 429, headers: { 'retry-after': '1' } }))
    const err = await rejection(api(f.fetch, sleeps).call('auth.test', BOT_TOKEN))
    expect(err).toBeInstanceOf(SlackTransportError)
    expect([(err as SlackTransportError).kind, (err as SlackTransportError).status, sleeps.length, f.calls.length]).toEqual(['http', 429, 3, 4])
  })

  test.each([
    ['an HTTP error', new Response(`body ${BOT_TOKEN}`, { status: 500 }), 'http', 'auth.test: http 500'],
    ['a network failure', new TypeError(`connect failed ${BOT_TOKEN}`), 'network', 'auth.test: network'],
    ['a timeout', Object.assign(new Error(`timed out ${BOT_TOKEN}`), { name: 'TimeoutError' }), 'timeout', 'auth.test: timeout'],
    ['a body that is not JSON', new Response(`<html>${BOT_TOKEN}</html>`), 'parse', 'auth.test: parse'],
    ['JSON without ok', json({ token: BOT_TOKEN }), 'parse', 'auth.test: parse'],
  ])('reports %s as a SlackTransportError naming only the method and kind', async (_what, answer, kind, message) => {
    const err = await rejection(api(scriptedFetch(answer).fetch).call('auth.test', BOT_TOKEN))
    expect(err).toBeInstanceOf(SlackTransportError)
    expect([(err as SlackTransportError).kind, err.message]).toEqual([kind, message])
    assertNoLeak(err)
  })

  test('refuses a string that is not a Slack method name, without calling fetch', async () => {
    const f = scriptedFetch(json({ ok: true }))
    await expect(api(f.fetch).call('../auth.test?x=1', BOT_TOKEN)).rejects.toThrow('not a Slack method name')
    expect(f.calls).toEqual([])
  })

  test.each([
    [{ ok: false, error: 'invalid_auth' }, 'invalid_auth'],
    [{ ok: false, error: `Bad ${BOT_TOKEN}` }, 'unknown_error'],
    [{ ok: false }, 'unknown_error'],
  ])('safeErrorCode keeps only a plain identifier (%#)', (answer, code) => {
    expect(safeErrorCode(answer)).toBe(code)
  })

  test('formBody skips undefined values', () => {
    expect(formBody({ a: 'x', b: undefined, c: false, d: 0 })).toBe('a=x&c=false&d=0')
  })
})

// ---------------------------------------------------------------------------
// The configuration token
// ---------------------------------------------------------------------------

const REFRESH = fakeToken(BOT_TOKEN_PREFIX.replace('b', 'e'), 'refresh')

/**
 * A configuration token source over a real-mode SecretStore on memSecureFs
 * (config dir /cfg), with the token files `seed` holds, a scripted Slack and
 * a log.
 */
function stored(seed: { token?: string; refresh?: string }, ...script: Scripted[]) {
  const mem = memSecureFs()
  mem.dirs.set('/cfg', 0o700)
  const store = new SecretStore({ fs: mem.fs, paths: livePathsIn('/cfg'), env: {}, redactor: new Redactor(), dryRun: false, realConfigDir: '/cfg' })
  if (seed.token !== undefined) mem.seed(store.paths.configTokenFile, `${seed.token}\n`)
  if (seed.refresh !== undefined) mem.seed(store.paths.refreshTokenFile, `${seed.refresh}\n`)
  const f = scriptedFetch(...script)
  const lines: string[] = []
  const tokens = new ConfigTokenSource(
    api(f.fetch),
    { read: () => store.readConfigTokens(), write: (t) => store.writeConfigTokens(t), tokenPath: store.paths.configTokenFile, refreshTokenPath: store.paths.refreshTokenFile },
    { info: (m) => lines.push(m) },
  )
  const saved = () => [mem.files.get(store.paths.configTokenFile), mem.files.get(store.paths.refreshTokenFile)]
  return { mem, store, tokens, calls: f.calls, lines, saved }
}

describe('ConfigTokenSource', () => {
  const TOKEN_PATH = '/cfg/slack_config_token'
  const ROTATED = fakeToken(`${BOT_TOKEN_PREFIX.slice(0, 3)}e.`, 'rotated')
  const NEXT_REFRESH = fakeToken(BOT_TOKEN_PREFIX.replace('b', 'e'), 'next')

  function source(refreshToken: string | null, ...script: Scripted[]) {
    const f = scriptedFetch(...script)
    const written: { token: string; refreshToken: string }[] = []
    let reads = 0
    const tokens = new ConfigTokenSource(api(f.fetch), {
      read: () => (reads++, { token: CONFIG_TOKEN, refreshToken }),
      write: (t) => void written.push(t),
      tokenPath: TOKEN_PATH,
    })
    return { tokens, calls: f.calls, written, reads: () => reads }
  }

  test('reads the token once and sends it as the bearer', async () => {
    const s = source(null, json({ ok: true }))
    await s.tokens.call('apps.manifest.export', { app_id: 'A0APP00001' })
    await s.tokens.call('apps.manifest.export', { app_id: 'A0APP00002' })
    expect(s.reads()).toBe(1)
    expect(s.calls.map((c) => c.headers.Authorization)).toEqual([`Bearer ${CONFIG_TOKEN}`, `Bearer ${CONFIG_TOKEN}`])
  })

  test('rotates an expired token once with the refresh token, stores both new values, and retries with the new token', async () => {
    const s = source(REFRESH, json({ ok: false, error: 'token_expired' }), json({ ok: true, token: ROTATED, refresh_token: NEXT_REFRESH }), json({ ok: true, app_id: 'A0APP00001' }))
    const answer = await s.tokens.call('apps.manifest.create', { manifest: '{}' })
    expect(answer.ok).toBe(true)
    expect(s.calls.map((c) => c.method)).toEqual(['apps.manifest.create', 'tooling.tokens.rotate', 'apps.manifest.create'])
    expect(s.calls[1]!.headers.Authorization).toBeUndefined()
    expect(new URLSearchParams(s.calls[1]!.body).get('refresh_token')).toBe(REFRESH)
    expect(s.calls[2]!.headers.Authorization).toBe(`Bearer ${ROTATED}`)
    expect(s.written).toEqual([{ token: ROTATED, refreshToken: NEXT_REFRESH }])
  })

  // ConfigTokenUnavailableError: not runnable (exit 2), unless the apps stage can do without the token.
  test.each([
    ['an expired token with no refresh token', null, [json({ ok: false, error: 'token_expired' })], 'token_expired', 1],
    ['a refused rotation', REFRESH, [json({ ok: false, error: 'token_expired' }), json({ ok: false, error: 'invalid_refresh_token' })], 'token_expired', 2],
    [
      'a second expiry after one rotation',
      REFRESH,
      [json({ ok: false, error: 'token_expired' }), json({ ok: true, token: ROTATED, refresh_token: NEXT_REFRESH }), json({ ok: false, error: 'token_expired' })],
      'token_expired',
      3,
    ],
    ['a revoked token (no rotation tried)', REFRESH, [json({ ok: false, error: 'token_revoked' })], 'token_revoked', 1],
  ])('%s is not runnable, naming the file to refresh and never a value', async (_what, refresh, script, code, calls) => {
    const s = source(refresh, ...script)
    const err = await rejection(s.tokens.call('apps.manifest.export', { app_id: 'A0APP00001' }))
    expect([err instanceof ConfigTokenUnavailableError, err instanceof NotRunnableError]).toEqual([true, true])
    expect(err.message).toBe(`the Slack app configuration token was refused (${code}): write a fresh one to ${TOKEN_PATH} (mode 600)`)
    expect(s.calls.length).toBe(calls)
    assertNoLeak(err)
  })

  test('returns any other failure as the answer', async () => {
    const s = source(REFRESH, json({ ok: false, error: 'invalid_manifest' }))
    expect(await s.tokens.call('apps.manifest.create', { manifest: '{}' })).toEqual({ ok: false, error: 'invalid_manifest' })
    expect(s.written).toEqual([])
  })

  describe('over the secret store (both token files, mode 600)', () => {
    const ROTATE_OK = json({ ok: true, token: ROTATED, refresh_token: NEXT_REFRESH })

    test.each([
      ['missing', undefined, 'the Slack app configuration token is missing: write it to /cfg/slack_config_token (mode 600)'],
      ['empty', '\n', 'the Slack app configuration token in /cfg/slack_config_token is empty'],
    ])('a %s token file is a ConfigTokenUnavailableError naming the file, and nothing reaches Slack', async (_what, token, message) => {
      const s = stored({ token }, json({ ok: true }))
      const err = await rejection(s.tokens.call('apps.manifest.export', { app_id: 'A0APP00001' }))
      expect([err instanceof ConfigTokenUnavailableError, err.message, s.calls]).toEqual([true, message, []])
    })

    test('a rotation saves both new tokens, the refresh token first, before the retried call, and logs only that it rotated', async () => {
      let atRetry: unknown
      const s = stored({ token: CONFIG_TOKEN, refresh: REFRESH }, json({ ok: false, error: 'token_expired' }), ROTATE_OK, () => {
        atRetry = [s.saved(), s.mem.ops.filter((op) => op.startsWith('rename ')).map((op) => op.split(' ')[2])]
        return json({ ok: true, manifest: {} })
      })
      expect((await s.tokens.call('apps.manifest.export', { app_id: 'A0APP00001' })).ok).toBe(true)
      expect(atRetry).toEqual([
        [
          { data: `${ROTATED}\n`, mode: 0o600 },
          { data: `${NEXT_REFRESH}\n`, mode: 0o600 },
        ],
        [s.store.paths.refreshTokenFile, s.store.paths.configTokenFile],
      ])
      expect([s.calls[2]!.headers.Authorization, s.lines]).toEqual([`Bearer ${ROTATED}`, [ROTATED_LINE]])
      assertNoLeak(s.lines)
    })

    test('a new pair that cannot be saved is not runnable (the old refresh token is spent: generate a new pair), and nothing is retried', async () => {
      const s = stored({ token: CONFIG_TOKEN, refresh: REFRESH }, json({ ok: false, error: 'token_expired' }), ROTATE_OK)
      s.mem.failNext('rename')
      const err = await rejection(s.tokens.call('apps.manifest.export', { app_id: 'A0APP00001' }))
      expect([err instanceof NotRunnableError, err instanceof ConfigTokenUnavailableError]).toEqual([true, false])
      expect(err.message).toStartWith('tooling.tokens.rotate issued a new token pair, but saving it failed (')
      expect(err.message).toEndWith(
        'the old refresh token is spent, so generate a new pair for the test workspace at https://api.slack.com/apps (Your App Configuration Tokens) and write both files (mode 600)',
      )
      expect([s.calls.map((c) => c.method), s.lines]).toEqual([['apps.manifest.export', 'tooling.tokens.rotate'], []])
      assertNoLeak({ err, lines: s.lines })
    })

    test('a rotation that gets no answer leaves the token refused (ConfigTokenUnavailableError), logged by its kind only', async () => {
      const s = stored({ token: CONFIG_TOKEN, refresh: REFRESH }, json({ ok: false, error: 'token_expired' }), new TypeError(`down ${NEXT_REFRESH}`))
      const err = await rejection(s.tokens.call('apps.manifest.export', { app_id: 'A0APP00001' }))
      expect([err instanceof ConfigTokenUnavailableError, err.message]).toEqual([true, 'the Slack app configuration token was refused (token_expired): write a fresh one to /cfg/slack_config_token (mode 600)'])
      expect([s.lines, s.saved()]).toEqual([['config token: tooling.tokens.rotate failed: no answer (network)'], [{ data: `${CONFIG_TOKEN}\n`, mode: 0o600 }, { data: `${REFRESH}\n`, mode: 0o600 }]])
      assertNoLeak({ err, lines: s.lines })
    })

    // `config-token --rotate`.
    test('rotateNow rotates once, whatever the token state, and saves both files', async () => {
      const s = stored({ token: CONFIG_TOKEN, refresh: REFRESH }, ROTATE_OK)
      await s.tokens.rotateNow()
      expect(s.calls.map((c) => `${c.method} ${c.headers.Authorization ?? '(no bearer)'}`)).toEqual(['tooling.tokens.rotate (no bearer)'])
      expect(s.saved()).toEqual([{ data: `${ROTATED}\n`, mode: 0o600 }, { data: `${NEXT_REFRESH}\n`, mode: 0o600 }])
      expect(s.lines).toEqual([ROTATED_LINE])
    })

    test.each([
      ['with no refresh token file', undefined, [json({ ok: true })], 0, 'there is no refresh token to rotate with: write the one issued with the configuration token to /cfg/slack_config_refresh_token (mode 600)'],
      [
        'with a refused refresh token',
        REFRESH,
        [json({ ok: false, error: 'invalid_refresh_token' })],
        1,
        'tooling.tokens.rotate refused the refresh token (invalid_refresh_token): generate a new pair for the test workspace at https://api.slack.com/apps (Your App Configuration Tokens) and write both files (mode 600)',
      ],
    ])('rotateNow %s is not runnable, naming the fix, and writes nothing', async (_what, refresh, script, calls, message) => {
      const s = stored({ token: CONFIG_TOKEN, refresh }, ...script)
      const err = await rejection(s.tokens.rotateNow())
      expect([err instanceof NotRunnableError, err.message, s.calls.length]).toEqual([true, message, calls])
      expect(s.mem.ops.filter((op) => op.startsWith('rename '))).toEqual([])
      assertNoLeak(err)
    })
  })
})

// ---------------------------------------------------------------------------
// Bot and app-level token checks
// ---------------------------------------------------------------------------

describe('BotApi', () => {
  const AUTH_OK = { ok: true, user_id: 'U0BOT00001', bot_id: 'B0BOT00001', team_id: 'T0TEAM0001' }

  test('checkBotToken: auth.test, then bots.info for the app ID', async () => {
    const f = scriptedFetch(json(AUTH_OK), json({ ok: true, bot: { app_id: 'A0APP00001' } }))
    expect(await new BotApi(api(f.fetch)).checkBotToken(BOT_TOKEN)).toEqual({
      ok: true,
      userId: 'U0BOT00001',
      botId: 'B0BOT00001',
      teamId: 'T0TEAM0001',
      appId: 'A0APP00001',
    })
    expect(new URLSearchParams(f.calls[1]!.body).get('bot')).toBe('B0BOT00001')
  })

  test.each([
    ['an empty token', '', [json(AUTH_OK)], { ok: false, error: 'empty' }],
    ['a refused token', BOT_TOKEN, [json({ ok: false, error: 'invalid_auth' })], { ok: false, error: 'invalid_auth' }],
    ['a token that is not a bot token', BOT_TOKEN, [json({ ok: true, user_id: 'U0USER0001', team_id: 'T0TEAM0001' })], { ok: false, error: 'not_a_bot_token' }],
    ['an HTTP failure', BOT_TOKEN, [new Response('', { status: 503 })], { ok: false, error: 'http_503' }],
    ['a network failure', BOT_TOKEN, [new TypeError('down')], { ok: false, error: 'network' }],
  ])('checkBotToken reports %s by code', async (_what, token, script, expected) => {
    expect(await new BotApi(api(scriptedFetch(...script).fetch)).checkBotToken(token)).toEqual(expected as BotCheck)
  })

  test.each([
    ['answers with an error', json({ ok: false, error: 'bot_not_found' }), 'bot_not_found'],
    ['gets no answer', new Response('', { status: 503 }), 'http_503'],
    ['fails on the network', new TypeError(`down ${BOT_TOKEN}`), 'network'],
  ])('when bots.info %s, checkBotToken keeps the identity, a null app ID and the failure code', async (_what, answer, code) => {
    const result = await new BotApi(api(scriptedFetch(json(AUTH_OK), answer).fetch)).checkBotToken(BOT_TOKEN)
    expect(result).toEqual({ ok: true, userId: 'U0BOT00001', botId: 'B0BOT00001', teamId: 'T0TEAM0001', appId: null, appLookupError: code })
    assertNoLeak(result)
  })

  test.each([
    ...['invalid_auth', 'not_authed', 'token_expired', 'token_revoked', 'account_inactive', 'not_allowed_token_type', 'not_a_bot_token', 'empty'].map((c) => [c, true] as const),
    ...['network', 'timeout', 'parse', 'http_500', 'http_503', 'http_429', 'internal_error', 'ratelimited', 'bot_not_found', 'unknown_error', 'call_failed'].map((c) => [c, false] as const),
  ])('isTokenRefusal(%p) is %p: only a refused, wrong-kind or missing token is replaced', (code, refused) => {
    expect(isTokenRefusal(code)).toBe(refused)
  })

  test.each([
    [[json({ ok: true, url: 'wss://x.invalid/link/?ticket=t' })], { ok: true }],
    [[json({ ok: false, error: 'not_allowed_token_type' })], { ok: false, error: 'not_allowed_token_type' }],
    [[new TypeError('down')], { ok: false, error: 'network' }],
  ])('checkAppToken calls apps.connections.open and keeps only the outcome (%#)', async (script, expected) => {
    const result = await new BotApi(api(scriptedFetch(...script).fetch)).checkAppToken(APP_TOKEN)
    expect(result).toEqual(expected as AppTokenCheck)
  })
})

// ---------------------------------------------------------------------------
// Manifests
// ---------------------------------------------------------------------------

describe('persona manifests', () => {
  test("personaManifest changes only the app name and the bot's display name, from the shipped manifest", () => {
    const before = JSON.stringify(REPO_MANIFEST)
    const m = personaManifest(REPO_MANIFEST, 'c') as { display_information: JsonObject; features: { bot_user: JsonObject } }
    expect([m.display_information.name, m.features.bot_user.display_name]).toEqual(['CSCB Test C', 'CSCB Test C'])
    m.display_information.name = (REPO_MANIFEST.display_information as JsonObject).name!
    m.features.bot_user.display_name = ((REPO_MANIFEST.features as JsonObject).bot_user as JsonObject).display_name!
    expect(m as unknown as JsonObject).toEqual(REPO_MANIFEST)
    expect(JSON.stringify(REPO_MANIFEST)).toBe(before)
  })

  test.each([
    [{ features: { bot_user: {} } }, 'has no display_information'],
    [{ display_information: {}, features: {} }, 'has no features.bot_user'],
  ])('personaManifest refuses a manifest that %s', (base, message) => {
    expect(() => personaManifest(base as JsonObject, 'a')).toThrow(message)
  })

  test('parseManifestYaml refuses YAML that is not a mapping', () => {
    expect(() => parseManifestYaml('- a\n- b\n')).toThrow('is not a YAML mapping')
  })

  const wanted: JsonObject = {
    _metadata: { major_version: 1 },
    display_information: { name: 'CSCB Test A' },
    oauth_config: { scopes: { bot: ['chat:write', 'im:write', 'reactions:write'] } },
    settings: { socket_mode_enabled: true, event_subscriptions: { bot_events: ['app_mention', 'message.channels'] } },
    list: [{ a: 1 }, { b: 2 }],
  }
  const clone = (): JsonObject => JSON.parse(JSON.stringify(wanted)) as JsonObject

  test.each([
    ['the same manifest', (m: any) => m, []],
    ['keys Slack adds on export, a changed _metadata and reordered scopes', (m: any) => {
      m.settings.org_deploy_enabled = false
      m._metadata = { major_version: 2 }
      m.oauth_config.scopes.bot.reverse()
      return m
    }, []],
    ['a changed name', (m: any) => ((m.display_information.name = 'Other'), m), ['display_information.name']],
    ['a missing scope and an extra event', (m: any) => {
      m.oauth_config.scopes.bot.pop()
      m.settings.event_subscriptions.bot_events.push('message.im')
      return m
    }, ['oauth_config.scopes.bot', 'settings.event_subscriptions.bot_events']],
    ['a scalar where an object was', (m: any) => ((m.settings = 'x'), m), ['settings']],
    ['an array of objects of another length', (m: any) => (m.list.pop(), m), ['list']],
    ['a changed object in an array', (m: any) => ((m.list[1].b = 3), m), ['list[1].b']],
  ])('manifestDrift: %s', (_what, change, drift) => {
    expect(manifestDrift(wanted, change(clone()) as JsonObject)).toEqual(drift)
  })
})

// ---------------------------------------------------------------------------
// The apps stage (scripted manifest API)
// ---------------------------------------------------------------------------

describe('runAppsStage', () => {
  /** The time a pending-create intent records (the harness's `now`). */
  const STARTED = '2026-09-26T12:00:00.000Z'

  function appsHarness(answer: (method: string, params: Record<string, unknown>) => SlackResponse) {
    const mem = memSecureFs()
    const appsFile = new AppsStateFile(mem.fs, '/cfg/apps.json')
    const calls: { method: string; params: Record<string, unknown>; recorded: AppsState }[] = []
    const lines: string[] = []
    const deps: AppsStageDeps = {
      callManifest: async (method, params) => {
        calls.push({ method, params, recorded: appsFile.load() })
        return answer(method, params)
      },
      appsFile,
      manifestFor: (l: PersonaLetter) => personaManifest(REPO_MANIFEST, l),
      letters: PERSONA_LETTERS as readonly PersonaLetter[],
      log: { info: (m: string) => lines.push(m), detail: (m: string) => lines.push(m) },
      now: () => Date.parse(STARTED),
    }
    return { mem, appsFile, calls, lines, deps }
  }

  /** A harness whose apps.json starts as `from`'s ends (a rerun on the same config dir). */
  function rerunOf(from: { mem: ReturnType<typeof memSecureFs> }, answer: (method: string, params: Record<string, unknown>) => SlackResponse) {
    const h = appsHarness(answer)
    h.mem.files.set('/cfg/apps.json', from.mem.files.get('/cfg/apps.json')!)
    h.mem.dirs.set('/cfg', 0o700)
    return h
  }

  /** What apps.json records per persona: its app ID, or its pending create's start time. */
  const recorded = (state: AppsState) =>
    Object.entries(state.personas)
      .map(([l, p]) => `${l}:${p!.app_id ?? `pending ${p!.pending_create?.started_at}`}`)
      .join(' ')

  /** A manifest API: creates hand out A0APPNEW01…, exports answer from `exported` (or app_not_found). */
  function manifestApi(exported: Record<string, JsonObject> = {}, overrides: Record<string, SlackResponse> = {}, created = 0) {
    let n = created
    return (method: string, params: Record<string, unknown>): SlackResponse => {
      if (overrides[method]) return overrides[method]!
      if (method === 'apps.manifest.create') {
        n += 1
        return {
          ok: true,
          app_id: `A0APPNEW0${n}`,
          credentials: { client_id: '1.2', client_secret: `cs-${LEAK_SENTINEL}`, verification_token: `vt-${LEAK_SENTINEL}`, signing_secret: `ss-${LEAK_SENTINEL}` },
        }
      }
      if (method === 'apps.manifest.export') {
        const m = exported[String(params.app_id)]
        return m ? { ok: true, manifest: m } : { ok: false, error: 'app_not_found' }
      }
      return { ok: true }
    }
  }

  test("writes each app's ID before the next call, stores no credential from the answer, and a rerun creates nothing", async () => {
    const h = appsHarness(manifestApi())
    const first = await runAppsStage(h.deps)
    expect(first.map((o) => [o.letter, o.action, o.appId])).toEqual([
      ['a', 'created', 'A0APPNEW01'],
      ['b', 'created', 'A0APPNEW02'],
      ['c', 'created', 'A0APPNEW03'],
      ['d', 'created', 'A0APPNEW04'],
    ])
    // Each create saw every earlier app already in apps.json, and its own persona's pending-create intent written first.
    expect(h.calls.map((c) => recorded(c.recorded))).toEqual([
      `a:pending ${STARTED}`,
      `a:A0APPNEW01 b:pending ${STARTED}`,
      `a:A0APPNEW01 b:A0APPNEW02 c:pending ${STARTED}`,
      `a:A0APPNEW01 b:A0APPNEW02 c:A0APPNEW03 d:pending ${STARTED}`,
    ])
    // The write that records an app ID clears its intent.
    expect(recorded(h.appsFile.load())).toBe('a:A0APPNEW01 b:A0APPNEW02 c:A0APPNEW03 d:A0APPNEW04')
    expect(h.calls.map((c) => c.params.manifest)).toEqual(PERSONA_LETTERS.map((l) => JSON.stringify(personaManifest(REPO_MANIFEST, l))))
    assertNoLeak({ lines: h.lines, outcomes: first, apps: h.mem.files.get('/cfg/apps.json')!.data })

    const exported = Object.fromEntries(PERSONA_LETTERS.map((l, i) => [`A0APPNEW0${i + 1}`, personaManifest(REPO_MANIFEST, l)]))
    const rerun = rerunOf(h, manifestApi(exported))
    const second = await runAppsStage(rerun.deps)
    expect(second.map((o) => o.action)).toEqual(['reused', 'reused', 'reused', 'reused'])
    expect(rerun.calls.map((c) => c.method)).toEqual(Array(4).fill('apps.manifest.export'))
  })

  test("a run stopped mid-create keeps the apps created so far and the unfinished create's intent; the rerun finds no such app on the apps list, so it clears the intent and creates only the rest", async () => {
    let creates = 0
    const crashing = appsHarness((method, params) => {
      if (method === 'apps.manifest.create' && ++creates === 2) throw new Error('process killed')
      return manifestApi()(method, params)
    })
    await expect(runAppsStage(crashing.deps)).rejects.toThrow('process killed')
    expect(recorded(crashing.appsFile.load())).toBe(`a:A0APPNEW01 b:pending ${STARTED}`)

    const rerun = rerunOf(crashing, manifestApi({ A0APPNEW01: personaManifest(REPO_MANIFEST, 'a') }, {}, 1))
    rerun.deps.listApps = async () => [{ id: 'A0APPNEW01', name: 'CSCB Test A', rowText: 'CSCB Test A CSCB CI Test' }]
    const outcomes = await runAppsStage(rerun.deps)
    expect(outcomes.map((o) => o.action)).toEqual(['reused', 'created', 'created', 'created'])
    expect(rerun.calls.filter((c) => c.method === 'apps.manifest.create').length).toBe(3)
    expect(recorded(rerun.appsFile.load())).toBe('a:A0APPNEW01 b:A0APPNEW02 c:A0APPNEW03 d:A0APPNEW04')
  })

  test('a drifted app is updated with the wanted manifest and marked for re-install', async () => {
    const drifted = personaManifest(REPO_MANIFEST, 'b') as { display_information: JsonObject }
    drifted.display_information.name = 'Renamed by hand'
    const h = appsHarness(manifestApi({ A0APPOLD02: drifted as JsonObject }))
    h.appsFile.save({ version: 1, personas: { b: { app_id: 'A0APPOLD02', bot_user_id: 'U0BOT00002' } }, channels: {} })
    h.deps.letters = ['b']
    const [outcome] = await runAppsStage(h.deps)
    expect(outcome).toEqual({ letter: 'b', appId: 'A0APPOLD02', action: 'updated', drift: ['display_information.name'] })
    expect(h.calls.map((c) => c.method)).toEqual(['apps.manifest.export', 'apps.manifest.update'])
    expect(h.calls[1]!.params).toEqual({ app_id: 'A0APPOLD02', manifest: JSON.stringify(personaManifest(REPO_MANIFEST, 'b')) })
    expect(h.appsFile.load().personas.b).toEqual({ app_id: 'A0APPOLD02', bot_user_id: 'U0BOT00002', needs_reinstall: true })
  })

  test('an app Slack no longer has is created again and replaces the old record', async () => {
    const h = appsHarness(manifestApi())
    h.appsFile.save({ version: 1, personas: { a: { app_id: 'A0APPGONE1', bot_user_id: 'U0BOT00001' } }, channels: {} })
    h.deps.letters = ['a']
    const [outcome] = await runAppsStage(h.deps)
    expect([outcome!.action, outcome!.appId]).toEqual(['created', 'A0APPNEW01'])
    expect(h.appsFile.load().personas.a).toEqual({ app_id: 'A0APPNEW01' })
    expect(h.lines).toContain('apps: CSCB Test A: recorded app A0APPGONE1 no longer exists (app_not_found); creating a new one')
  })

  test.each([
    ['an export failure', { a: 'A0APPOLD01' }, { 'apps.manifest.export': { ok: false, error: 'ratelimited' } }, 'apps.manifest.export for CSCB Test A (A0APPOLD01) failed: ratelimited'],
    ['an unsafe error code', { a: 'A0APPOLD01' }, { 'apps.manifest.export': { ok: false, error: `x ${APP_TOKEN}` } }, 'apps.manifest.export for CSCB Test A (A0APPOLD01) failed: unknown_error'],
    ['an export with no manifest', { a: 'A0APPOLD01' }, { 'apps.manifest.export': { ok: true } }, 'apps.manifest.export for CSCB Test A (A0APPOLD01) returned no manifest'],
    ['a failed update', { a: 'A0APPOLD01' }, { 'apps.manifest.export': { ok: true, manifest: { display_information: { name: 'x' } } }, 'apps.manifest.update': { ok: false, error: 'invalid_manifest' } }, 'apps.manifest.update for CSCB Test A (A0APPOLD01) failed: invalid_manifest'],
    // Slack refused the create, so it made nothing: its intent is cleared with it.
    ['a failed create', {}, { 'apps.manifest.create': { ok: false, error: 'invalid_manifest' } }, 'apps.manifest.create for CSCB Test A failed: invalid_manifest'],
  ] as const)('stops on %s with an AppsStageError naming the method and a safe code, apps.json as it was', async (_what, saved, overrides, message) => {
    const h = appsHarness(manifestApi({}, overrides as Record<string, SlackResponse>))
    if ('a' in saved) h.appsFile.save({ version: 1, personas: { a: { app_id: saved.a } }, channels: {} })
    const before = h.appsFile.load()
    const err = await rejection(runAppsStage(h.deps))
    expect(err).toBeInstanceOf(AppsStageError)
    expect(err.message).toBe(message)
    expect(h.appsFile.load()).toEqual(before)
    assertNoLeak({ err, lines: h.lines })
  })

  // A create that got no answer may have created the app: never retried, and its intent kept for the next run's search of the apps list.
  // A refused one (a 4xx) created nothing: its intent is cleared.
  const KEPT = `a:pending ${STARTED}`
  test.each([
    ['no answer (network)', new SlackTransportError('apps.manifest.create', 'network'), NotRunnableError, createUnansweredMessage('CSCB Test A', 'network'), KEPT],
    ['a timeout', new SlackTransportError('apps.manifest.create', 'timeout'), NotRunnableError, createUnansweredMessage('CSCB Test A', 'timeout'), KEPT],
    ['HTTP 502', new SlackTransportError('apps.manifest.create', 'http', 502), NotRunnableError, createUnansweredMessage('CSCB Test A', 'http 502'), KEPT],
    ['HTTP 429 left after the retries', new SlackTransportError('apps.manifest.create', 'http', 429), AppsStageError, 'apps.manifest.create for CSCB Test A was refused (HTTP 429); no app was created: rerun later', ''],
    ['HTTP 400', new SlackTransportError('apps.manifest.create', 'http', 400), AppsStageError, 'apps.manifest.create for CSCB Test A was refused (HTTP 400); no app was created: rerun later', ''],
    ['the configuration token refused', new ConfigTokenUnavailableError('the Slack app configuration token was refused (invalid_auth)'), ConfigTokenUnavailableError, 'the Slack app configuration token was refused (invalid_auth)', ''],
  ] as const)('a create that fails with %s is tried once, and stops the stage', async (_what, failure, type, message, after) => {
    const h = appsHarness((method, params) => {
      if (method === 'apps.manifest.create') throw failure
      return manifestApi()(method, params)
    })
    const err = await rejection(runAppsStage(h.deps))
    expect([err instanceof type, err.message]).toEqual([true, message])
    expect(h.calls.map((c) => [c.method, recorded(c.recorded)])).toEqual([['apps.manifest.create', KEPT]])
    expect(recorded(h.appsFile.load())).toBe(after)
    assertNoLeak({ err, lines: h.lines })
  })

  test('a create answered with no app ID stops the stage and keeps the intent, so the next run looks for the app', async () => {
    const h = appsHarness(manifestApi({}, { 'apps.manifest.create': { ok: true, app_id: 'nope' } }))
    const err = await rejection(runAppsStage(h.deps))
    expect([err instanceof AppsStageError, err.message]).toEqual([
      true,
      'apps.manifest.create for CSCB Test A returned no app ID; apps.json keeps the unfinished create, so the next run looks for the app in the apps list',
    ])
    expect(recorded(h.appsFile.load())).toBe(KEPT)
  })

  test('the unanswered-create message says apps.json keeps the unfinished create for the next run, and how to see the apps list first', () => {
    expect(createUnansweredMessage('CSCB Test B', 'timeout')).toBe(
      'apps.manifest.create for CSCB Test B got no answer (timeout), so Slack may have created the app anyway. ' +
        'apps.json keeps the unfinished create: the next run looks for an unrecorded "CSCB Test B" in the test workspace\'s apps list ' +
        'and adopts it (one), creates it (none) or stops (more than one). Rerun, or see the list first with bun ci-live/run.ts apps --list',
    )
  })

  describe('an unfinished create (a pending-create intent and no app ID in apps.json)', () => {
    const EARLIER = '2026-09-25T08:00:00.000Z'
    const C = personaManifest(REPO_MANIFEST, 'c')
    const row = (id: string, name: string, workspace = 'CSCB CI Test'): ListedApp => ({ id, name, rowText: `${name} ${workspace}` })
    // Never candidates: another workspace's app of that name (the configuration token can't export it), a near name, and one renamed by hand since.
    const decoys = [row('A0FOREIGN1', 'CSCB Test C', 'Another Workspace'), row('A0COPY0001', 'CSCB Test C (copy)'), row('A0RENAMED1', 'CSCB Test C')]

    /** `exportFault` answers (or throws for) an app's export in place of the manifest API when it returns an answer. */
    function pendingHarness(listing: ListedApp[] | undefined, exportFault: (appId: string) => SlackResponse | undefined = () => undefined) {
      const exported: Record<string, JsonObject> = { A0MADE0001: C, A0MADE0002: C, A0COPY0001: C, A0RENAMED1: personaManifest(REPO_MANIFEST, 'b') }
      const answer = manifestApi(exported, {}, 0)
      const h = appsHarness((method, params) => (method === 'apps.manifest.export' && exportFault(String(params.app_id))) || answer(method, params))
      h.appsFile.save({ version: 1, personas: { c: { pending_create: { started_at: EARLIER } } }, channels: {} })
      h.deps.letters = ['c']
      if (listing) h.deps.listApps = async () => listing
      return h
    }
    const creates = (h: { calls: { method: string }[] }) => h.calls.filter((c) => c.method === 'apps.manifest.create').length

    test('one unrecorded app of its exact name that the configuration token manages is adopted: recorded with the intent cleared, then checked like a recorded app; nothing is created', async () => {
      const h = pendingHarness([...decoys, row('A0MADE0001', 'CSCB Test C')])
      expect(await runAppsStage(h.deps)).toEqual([{ letter: 'c', appId: 'A0MADE0001', action: 'adopted', drift: [] }])
      expect([recorded(h.appsFile.load()), creates(h)]).toEqual(['c:A0MADE0001', 0])
      expect(h.calls.filter((c) => c.params.app_id === 'A0MADE0001').map((c) => c.method)).toEqual(['apps.manifest.export', 'apps.manifest.export'])
    })

    test('none: the intent is cleared and the app created (with a fresh intent first)', async () => {
      const h = pendingHarness(decoys)
      expect((await runAppsStage(h.deps)).map((o) => [o.action, o.appId])).toEqual([['created', 'A0APPNEW01']])
      const create = h.calls.find((c) => c.method === 'apps.manifest.create')!
      expect([recorded(create.recorded), recorded(h.appsFile.load()), creates(h)]).toEqual([`c:pending ${STARTED}`, 'c:A0APPNEW01', 1])
    })

    test('more than one: not runnable, naming them and pointing at apps --delete-strays; nothing is created and the intent kept', async () => {
      const h = pendingHarness([row('A0MADE0001', 'CSCB Test C'), ...decoys, row('A0MADE0002', 'CSCB Test C')])
      const err = await rejection(runAppsStage(h.deps))
      expect([err instanceof NotRunnableError, err.message]).toEqual([true, ambiguousPendingMessage('CSCB Test C', ['A0MADE0001', 'A0MADE0002'])])
      expect(err.message).toContain('delete the strays with bun ci-live/run.ts apps --delete-strays, then rerun')
      expect([recorded(h.appsFile.load()), creates(h)]).toEqual([`c:pending ${EARLIER}`, 0])
    })

    // A candidate the configuration token could not check may be the app the create made: neither adopt another nor create.
    const INTERNAL_ERROR = 'apps.manifest.export with the configuration token failed: internal_error, which does not say the app is missing'
    const only = [row('A0MADE0001', 'CSCB Test C')]
    test.each([
      ["its only candidate's export answers internal_error", only, () => ({ ok: false, error: 'internal_error' }), unverifiedPendingMessage('CSCB Test C', [{ app: only[0]!, why: INTERNAL_ERROR }])],
      [
        "its only candidate's export gets no answer (a transport error)",
        only,
        () => {
          throw new SlackTransportError('apps.manifest.export', 'http', 503)
        },
        unverifiedPendingMessage('CSCB Test C', [{ app: only[0]!, why: 'apps.manifest.export with the configuration token got no answer (http 503)' }]),
      ],
      [
        'one candidate checks out and another answers internal_error',
        [row('A0MADE0001', 'CSCB Test C'), row('A0MADE0002', 'CSCB Test C')],
        (id: string) => (id === 'A0MADE0002' ? { ok: false, error: 'internal_error' } : undefined),
        unverifiedPendingMessage('CSCB Test C', [{ app: row('A0MADE0002', 'CSCB Test C'), why: INTERNAL_ERROR }]),
      ],
      [
        'the apps list cannot be read (a FlowError)',
        async () => {
          throw new FlowError('the apps list page showed no list')
        },
        () => undefined,
        'apps.json records an unfinished create of "CSCB Test C", and the apps list could not be read (FlowError: the apps list page showed no list): apps.json keeps the unfinished create and nothing was created: rerun',
      ],
    ] as Array<[string, ListedApp[] | (() => Promise<ListedApp[]>), (id: string) => SlackResponse | undefined, string]>)(
      'when %s, the stage stops (AppsStageError): the intent is kept, nothing is adopted or created',
      async (_what, listing, exportFault, message) => {
        const h = pendingHarness(Array.isArray(listing) ? listing : undefined, exportFault)
        if (!Array.isArray(listing)) h.deps.listApps = listing
        const err = await rejection(runAppsStage(h.deps))
        expect([err instanceof AppsStageError, err instanceof NotRunnableError, err.message]).toEqual([true, false, message])
        expect(err.message).toContain('apps.json keeps the unfinished create and nothing was created: rerun')
        expect([recorded(h.appsFile.load()), creates(h)]).toEqual([`c:pending ${EARLIER}`, 0])
        assertNoLeak({ err, lines: h.lines })
      },
    )

    test('with no apps list to read (a command that has none): not runnable, pointing at apps --list; nothing is created', async () => {
      const h = pendingHarness(undefined)
      const err = await rejection(runAppsStage(h.deps))
      expect([err instanceof NotRunnableError, err.message]).toEqual([
        true,
        `apps.json records an unfinished create of "CSCB Test C" (started ${EARLIER}), and this command can't read the apps list to look for it: run bun ci-live/run.ts apps --list`,
      ])
      expect([h.calls, recorded(h.appsFile.load())]).toEqual([[], `c:pending ${EARLIER}`])
    })
  })

  test('refuseCreate stops (not runnable) at the first app it would create; recorded apps are still reused', async () => {
    const h = appsHarness(manifestApi({ A0APPOLD01: personaManifest(REPO_MANIFEST, 'a') }))
    h.appsFile.save({ version: 1, personas: { a: { app_id: 'A0APPOLD01' } }, channels: {} })
    h.deps.refuseCreate = 'no apps.json: copy it from the old VM'
    const err = await rejection(runAppsStage(h.deps))
    expect([err instanceof NotRunnableError, err.message]).toEqual([true, 'no apps.json: copy it from the old VM'])
    expect(h.calls.map((c) => c.method)).toEqual(['apps.manifest.export'])
    expect(h.lines).toEqual(['apps: CSCB Test A: reused A0APPOLD01'])
  })
})

// ---------------------------------------------------------------------------
// The apps stage without a usable configuration token
// ---------------------------------------------------------------------------

describe('the apps stage without a usable configuration token', () => {
  const RECORDED = { a: 'A0APPOLD01', b: 'A0APPOLD02', c: 'A0APPOLD03', d: 'A0APPOLD04' } as const
  const EXPIRED = json({ ok: false, error: 'token_expired' })

  /** The apps stage over `stored()`'s token source and secret store, with `letters` recorded in apps.json; the stage logs beside the source. */
  function tokenHarness(seed: { token?: string; refresh?: string }, script: Scripted[], letters: readonly PersonaLetter[]) {
    const s = stored(seed, ...script)
    const appsFile = new AppsStateFile(s.mem.fs, s.store.paths.appsJson)
    appsFile.save({ version: 1, personas: Object.fromEntries(letters.map((l) => [l, { app_id: RECORDED[l] }])), channels: {} })
    const appsJson = () => s.mem.files.get(s.store.paths.appsJson)!.data
    const deps: AppsStageDeps = {
      callManifest: (method, params) => s.tokens.call(method, params),
      appsFile,
      manifestFor: (l) => personaManifest(REPO_MANIFEST, l),
      letters: PERSONA_LETTERS,
      log: { info: (m) => s.lines.push(m), detail: (m) => s.lines.push(m) },
    }
    return { deps, calls: s.calls, lines: s.lines, appsJson, before: appsJson() }
  }

  const REFUSED = 'the Slack app configuration token was refused (token_expired): write a fresh one to /cfg/slack_config_token (mode 600)'
  const CONDITIONS = [
    ['missing', {}, [], [], 'the Slack app configuration token is missing: write it to /cfg/slack_config_token (mode 600)'],
    ['expired, with no refresh token', { token: CONFIG_TOKEN }, [EXPIRED], ['apps.manifest.export'], REFUSED],
    ['expired, its rotation refused', { token: CONFIG_TOKEN, refresh: REFRESH }, [EXPIRED, json({ ok: false, error: 'invalid_refresh_token' })], ['apps.manifest.export', 'tooling.tokens.rotate'], REFUSED],
  ] as const

  test.each(CONDITIONS)('a configuration token %s, with all four apps in apps.json: a WARNING (never a value), and the recorded apps reused unchecked', async (_what, seed, script, methods, why) => {
    const h = tokenHarness(seed, [...script], PERSONA_LETTERS)
    const outcomes = await runAppsStage(h.deps)
    expect(outcomes).toEqual(PERSONA_LETTERS.map((letter) => ({ letter, appId: RECORDED[letter], action: 'reused', drift: [] })))
    expect(h.calls.map((c) => c.method)).toEqual([...methods])
    expect(h.lines.filter((l) => l.startsWith('WARNING:'))).toEqual([
      `WARNING: apps: the configuration token can't be used (${why}); apps.json records all four apps, so the run reuses them without their export, drift check or update`,
    ])
    expect(h.lines.filter((l) => l.startsWith('apps: CSCB Test'))).toEqual(
      PERSONA_LETTERS.map((l) => `apps: CSCB Test ${l.toUpperCase()}: reused ${RECORDED[l]} (unchecked: no usable configuration token)`),
    )
    expect(h.appsJson()).toBe(h.before)
    assertNoLeak({ lines: h.lines, outcomes })
  })

  test.each(CONDITIONS)('a configuration token %s, with an app missing from apps.json: not runnable (exit 2), naming the token file, and nothing created', async (_what, seed, script, methods, why) => {
    const h = tokenHarness(seed, [...script], ['a', 'b', 'c'])
    const err = await rejection(runAppsStage(h.deps))
    expect([err instanceof ConfigTokenUnavailableError, err instanceof NotRunnableError, err.message]).toEqual([true, true, why])
    expect(h.calls.map((c) => c.method)).toEqual([...methods])
    expect(h.appsJson()).toBe(h.before)
    assertNoLeak({ err, lines: h.lines })
  })
})

// ---------------------------------------------------------------------------
// The apps list against apps.json (apps --list, apps --delete-strays)
// ---------------------------------------------------------------------------

describe('the apps list against apps.json', () => {
  const TEAM = 'CSCB CI Test'
  const app = (id: string, name: string, rowText: string | null = `${name} ${TEAM}`): ListedApp => ({ id, name, rowText })
  const STATE: AppsState = { version: 1, personas: { a: { app_id: 'A0APPREC01' }, b: { app_id: 'A0APPREC02' } }, channels: {} }

  test("classifyListedApps: the persona apps.json records it for, the persona whose exact name it has, and whether its row (less its own name) shows the test workspace's name", () => {
    const listed = [
      app('A0APPREC01', 'CSCB Test A'),
      app('A0STRAY001', 'CSCB Test A'),
      app('A0COPY0001', 'CSCB Test A (copy)'),
      app('A0LOWER001', 'cscb test b'),
      app('A0OTHER001', 'CSCB Test C', 'CSCB Test C Another Workspace'),
      app('A0TEAMNAME', TEAM, `${TEAM} Another Workspace`),
      app('A0NOROW001', 'CSCB Test D', null),
    ]
    const shape = (team: string | null) => classifyListedApps(listed, STATE, team).map((c) => [c.app.id, c.recordedAs, c.namedAs, c.inTestWorkspace])
    expect(shape(TEAM)).toEqual([
      ['A0APPREC01', 'a', 'a', true],
      ['A0STRAY001', null, 'a', true],
      ['A0COPY0001', null, null, true],
      ['A0LOWER001', null, null, true],
      ['A0OTHER001', null, 'c', false],
      ['A0TEAMNAME', null, null, false],
      ['A0NOROW001', null, 'd', false],
    ])
    expect(shape(null).map(([id, , , where]) => [id, where])).toEqual(listed.map((a) => [a.id, null]))
  })

  const APP_URL = 'https://api.slack.com/apps/A0APP00001'
  test.each([
    [
      'an icon link (no text) then a name link to the same app: one app, named by the link with text',
      [
        { href: APP_URL, text: '', cells: ['', 'CSCB Test A', TEAM] },
        { href: `${APP_URL}/general?tab=x`, text: 'CSCB Test A', cells: ['', 'CSCB Test A', TEAM] },
      ],
      [{ id: 'A0APP00001', name: 'CSCB Test A', rowText: `CSCB Test A\t${TEAM}` }],
    ],
    [
      '/apps/new, an ID-less or look-alike apps link and a link elsewhere: none is an app',
      [
        { href: 'https://api.slack.com/apps/new', text: 'Create New App', cells: null },
        { href: 'https://api.slack.com/apps', text: 'Your Apps', cells: null },
        { href: 'https://api.slack.com/apps/A0APP00001x', text: 'CSCB Test A', cells: null },
        { href: 'https://api.slack.com/docs', text: 'Docs', cells: null },
      ],
      [],
    ],
    [
      'control characters in the name and cells (a tab or line break never splits a cell), empty cells dropped, a link in no row',
      [
        { href: APP_URL, text: 'CSCB\u0000 Test\nA\u007f', cells: ['CSCB Test A', 'CSCB\tCI\r\nTest', '   '] },
        { href: 'https://api.slack.com/apps/A0APP00002', text: 'CSCB Test B', cells: null },
      ],
      [
        { id: 'A0APP00001', name: 'CSCB Test A', rowText: `CSCB Test A\t${TEAM}` },
        { id: 'A0APP00002', name: 'CSCB Test B', rowText: null },
      ],
    ],
    [
      'a name and cells capped at 100 characters, and at most 8 cells',
      [{ href: APP_URL, text: 'n'.repeat(150), cells: Array(10).fill('c'.repeat(120)) }],
      [{ id: 'A0APP00001', name: 'n'.repeat(100), rowText: Array(8).fill('c'.repeat(100)).join('\t') }],
    ],
  ] as Array<[string, AppLink[], ListedApp[]]>)('listedAppsFrom: %s', (_what, links, expected) => {
    expect(listedAppsFrom(links)).toEqual(expected)
  })

  test.each([
    ['names the team', { ok: true, team: TEAM }, TEAM],
    ['names no team', { ok: true }, null],
    ['names a blank team', { ok: true, team: '  ' }, null],
    ['names a team that is no string', { ok: true, team: 42 }, null],
    ['is refused', { ok: false, error: 'invalid_auth', team: TEAM }, null],
  ] as Array<[string, SlackResponse, string | null]>)("testWorkspaceName: the test human's auth.test that %s", async (_what, answer, name) => {
    const methods: string[] = []
    const browser = { humanApi: async (): Promise<HumanApi> => ({ call: async (method) => (methods.push(method), answer) }) }
    expect([await testWorkspaceName(browser), methods]).toEqual([name, ['auth.test']])
  })

  test.each([
    ['its own cell', `CSCB Test A\t${TEAM}`, TEAM, true],
    ['one cell holding the app name and the team', `CSCB Test A ${TEAM}`, TEAM, true],
    ['the team name spaced differently', `CSCB Test A\t${TEAM}`, `  CSCB  CI Test `, true],
    ['a longer team name ("CSCB Test" is not "CSCB Test 2")', 'CSCB Test A\tCSCB Test 2', 'CSCB Test', false],
    ['the team name inside a longer cell', `CSCB Test A\tMy ${TEAM}`, TEAM, false],
    ['only inside the app name', 'CSCB Test A', 'CSCB Test', false],
    ['no row', null, TEAM, false],
  ] as Array<[string, string | null, string, boolean]>)("rowShowsWorkspace: a row of 'CSCB Test A' with the team name as %s", (_what, rowText, team, shown) => {
    expect(rowShowsWorkspace(app('A0STRAY001', 'CSCB Test A', rowText), team)).toBe(shown)
  })

  test("describeListedApp: apps --list's line, the ID, the quoted name and what apps.json says of it", () => {
    const lines = (team: string | null) =>
      classifyListedApps([app('A0APPREC02', 'CSCB Test B'), app('A0STRAY001', 'CSCB Test A'), app('A0OTHER001', 'Mine', 'Mine Elsewhere')], STATE, team).map(describeListedApp)
    expect(lines(TEAM)).toEqual([
      'A0APPREC02  "CSCB Test B"  in apps.json (persona B); test workspace',
      'A0STRAY001  "CSCB Test A"  NOT in apps.json: a stray test app; test workspace',
      'A0OTHER001  "Mine"  not in apps.json; not shown in the test workspace',
    ])
    expect(lines(null)[1]).toBe('A0STRAY001  "CSCB Test A"  NOT in apps.json: a stray test app')
  })

  describe('deleteStrayApps', () => {
    /**
     * The manifest API: export answers from `exported` (a manifest of that name, or what a function answers or throws; else
     * invalid_app_id, as for another workspace's app); delete answers ok unless `refuseDelete` holds the ID.
     */
    function strayHarness(exported: Record<string, string | (() => SlackResponse)>, refuseDelete: string[] = [], later: AppsState | (() => AppsState) = STATE) {
      const calls: string[] = []
      const lines: string[] = []
      const deps = {
        callManifest: async (method: string, params: Record<string, unknown>): Promise<SlackResponse> => {
          const id = String(params.app_id)
          calls.push(`${method} ${id}`)
          if (method === 'apps.manifest.export') {
            const name = exported[id]
            if (typeof name === 'function') return name()
            return name ? { ok: true, manifest: { display_information: { name } } } : { ok: false, error: 'invalid_app_id' }
          }
          return refuseDelete.includes(id) ? { ok: false, error: 'ratelimited' } : { ok: true }
        },
        // apps.json read again just before a delete: `later` is what it holds (or gives, read by read) by then.
        appsFile: { load: typeof later === 'function' ? later : () => later },
        log: { info: (m: string) => lines.push(m) },
      }
      return { deps, calls, lines }
    }

    test('deletes only an app named exactly "CSCB Test A"-"D", unrecorded, shown in the test workspace and exported under that name with the configuration token; keeps the rest, saying why', async () => {
      const listed = [
        app('A0APPREC01', 'CSCB Test A'),
        app('A0STRAY001', 'CSCB Test A'),
        app('A0STRAY002', 'CSCB Test B'),
        app('A0COPY0001', 'CSCB Test A (copy)'),
        app('A0OTHER001', 'CSCB Test C', 'CSCB Test C Another Workspace'),
        app('A0FOREIGN1', 'CSCB Test C'),
        app('A0RENAMED1', 'CSCB Test D'),
        app('A0RACED001', 'CSCB Test D'),
      ]
      const later: AppsState = { ...STATE, personas: { ...STATE.personas, d: { app_id: 'A0RACED001' } } }
      const exported = { A0APPREC01: 'CSCB Test A', A0STRAY001: 'CSCB Test A', A0STRAY002: 'CSCB Test B', A0RENAMED1: 'CSCB Test B', A0RACED001: 'CSCB Test D' }
      const h = strayHarness(exported, ['A0STRAY002'], later)
      const outcome = await deleteStrayApps(h.deps, classifyListedApps(listed, STATE, TEAM))
      expect(outcome.deleted.map((a) => a.id)).toEqual(['A0STRAY001'])
      expect(outcome.kept.map((k) => [k.app.id, k.why])).toEqual([
        ['A0STRAY002', 'apps.manifest.delete failed: ratelimited'],
        ['A0OTHER001', 'the app list does not show it in the test workspace'],
        ['A0FOREIGN1', 'apps.manifest.export with the configuration token failed: invalid_app_id'],
        ['A0RENAMED1', 'its manifest names another app'],
        ['A0RACED001', 'apps.json records it'],
      ])
      expect(h.calls).toEqual([
        'apps.manifest.export A0STRAY001',
        'apps.manifest.delete A0STRAY001',
        'apps.manifest.export A0STRAY002',
        'apps.manifest.delete A0STRAY002',
        'apps.manifest.export A0FOREIGN1',
        'apps.manifest.export A0RENAMED1',
      ])
      expect(h.lines).toContain('apps: deleted stray A0STRAY001 "CSCB Test A" (not in apps.json) with apps.manifest.delete')
    })

    test('never deletes an app apps.json records, nor any stray while the test workspace name is unknown', async () => {
      const everyName = PERSONA_LETTERS.map((l, i) => app(`A0APPREC0${i + 1}`, `CSCB Test ${l.toUpperCase()}`))
      const all: AppsState = { version: 1, personas: Object.fromEntries(PERSONA_LETTERS.map((l, i) => [l, { app_id: `A0APPREC0${i + 1}` }])), channels: {} }
      const exported = Object.fromEntries(everyName.map((a) => [a.id, a.name]))
      const recordedOnly = strayHarness(exported, [], all)
      expect(await deleteStrayApps(recordedOnly.deps, classifyListedApps(everyName, all, TEAM))).toEqual({ deleted: [], kept: [] })
      const unknownTeam = strayHarness({ A0STRAY001: 'CSCB Test A' })
      const outcome = await deleteStrayApps(unknownTeam.deps, classifyListedApps([app('A0STRAY001', 'CSCB Test A')], STATE, null))
      expect(outcome.kept.map((k) => k.why)).toEqual(['the test workspace name is unknown, so its workspace is unproven'])
      expect([recordedOnly.calls, unknownTeam.calls, outcome.deleted]).toEqual([[], [], []])
    })

    // An export that proves nothing (neither the app nor "no such app") keeps the stray: it may be a live app.
    test.each([
      ['its row shows a longer workspace name ("CSCB CI Test 2")', `CSCB Test A\t${TEAM} 2`, 'CSCB Test A', 'the app list does not show it in the test workspace', []],
      [
        'its export answers internal_error',
        `CSCB Test A\t${TEAM}`,
        () => ({ ok: false, error: 'internal_error' }),
        'apps.manifest.export with the configuration token failed: internal_error, which does not say the app is missing',
        ['apps.manifest.export A0STRAY001'],
      ],
      [
        'its export gets no answer',
        `CSCB Test A\t${TEAM}`,
        () => {
          throw new SlackTransportError('apps.manifest.export', 'timeout')
        },
        'apps.manifest.export with the configuration token got no answer (timeout)',
        ['apps.manifest.export A0STRAY001'],
      ],
      [
        'its export holds no manifest name',
        `CSCB Test A\t${TEAM}`,
        () => ({ ok: true, manifest: { display_information: {} } }),
        'apps.manifest.export with the configuration token returned no manifest name',
        ['apps.manifest.export A0STRAY001'],
      ],
    ] as Array<[string, string, string | (() => SlackResponse), string, string[]]>)('keeps a stray, deleting nothing, when %s', async (_what, rowText, exported, why, calls) => {
      const h = strayHarness({ A0STRAY001: exported })
      const outcome = await deleteStrayApps(h.deps, classifyListedApps([app('A0STRAY001', 'CSCB Test A', rowText)], STATE, TEAM))
      expect([outcome.deleted, outcome.kept.map((k) => [k.app.id, k.why]), h.calls]).toEqual([[], [['A0STRAY001', why]], calls])
      assertNoLeak(h.lines)
    })

    test.each([
      ['no longer parses', () => parseAppsState('not json'), 'apps.json does not parse as JSON: fix it'],
      [
        'records no app ID any more',
        () => parseAppsState(JSON.stringify({ version: 1, personas: { a: { pending_create: { started_at: '2026-09-26T12:00:00.000Z' } } } })),
        'apps.json records no app ID, so every test app, live ones another VM records included, would look like a stray: apps --delete-strays deletes nothing until apps.json records the apps',
      ],
    ] as Array<[string, () => AppsState, string]>)('apps.json is read again before each delete: when by the second stray it %s, not runnable, and nothing more is exported or deleted', async (_what, second, message) => {
      let loads = 0
      const h = strayHarness({ A0STRAY001: 'CSCB Test A', A0STRAY002: 'CSCB Test B' }, [], () => (++loads === 1 ? STATE : second()))
      const err = await rejection(deleteStrayApps(h.deps, classifyListedApps([app('A0STRAY001', 'CSCB Test A'), app('A0STRAY002', 'CSCB Test B')], STATE, TEAM)))
      expect(err).toBeInstanceOf(NotRunnableError)
      expect(err.message).toStartWith(message)
      expect(h.calls).toEqual(['apps.manifest.export A0STRAY001', 'apps.manifest.delete A0STRAY001'])
    })
  })

  describe('appsStateForStrayDeletion (apps --delete-strays, before any app is listed)', () => {
    const PATH = '/cfg/apps.json'
    const fileWith = (text: string | undefined) => {
      const mem = memSecureFs()
      if (text !== undefined) mem.seed(PATH, text)
      return new AppsStateFile(mem.fs, PATH)
    }

    test.each([
      [
        'is missing',
        undefined,
        `${PATH} does not exist, so every test app, live ones another VM records included, would look like a stray: apps --delete-strays deletes nothing without it (copy it from the VM that made the apps; apps --list shows them)`,
      ],
      ['does not parse as JSON', 'not json', `${PATH} does not parse as JSON: fix it`],
      ['is no JSON object', '[]', `${PATH} is not a JSON object: fix it`],
      [
        'records no app ID (an unfinished create only)',
        JSON.stringify({ version: 1, personas: { c: { pending_create: { started_at: '2026-09-26T12:00:00.000Z' } } } }),
        `${PATH} records no app ID, so every test app, live ones another VM records included, would look like a stray: apps --delete-strays deletes nothing until apps.json records the apps (copy it from the VM that made them; apps --list shows them)`,
      ],
    ])('not runnable when apps.json %s', (_what, text, message) => {
      let err: unknown
      try {
        appsStateForStrayDeletion(fileWith(text))
      } catch (e) {
        err = e
      }
      expect(err).toBeInstanceOf(NotRunnableError)
      expect((err as Error).message).toStartWith(message)
    })

    test('apps.json recording an app ID is the state to classify against', () => {
      expect(appsStateForStrayDeletion(fileWith(JSON.stringify(STATE)))).toEqual(STATE)
    })
  })
})

// ---------------------------------------------------------------------------
// Whole provisioning runs against the dry run's in-memory workspace
// ---------------------------------------------------------------------------

const CFG = '/tmp/ci-live-dry/config'
const REAL = '/home/tester/.config/cscb-test'

/** The stub workspace's Web API behind a fake fetch (no network). */
function stubFetch(stub: StubWorkspace): FetchLike {
  return async (url, init) => {
    const method = new URL(url).pathname.replace('/api/', '')
    const auth = (init.headers as Record<string, string>).Authorization
    const params = Object.fromEntries(new URLSearchParams(String(init.body)))
    return json(stub.api(method, auth ? auth.slice('Bearer '.length) : null, params))
  }
}

function stubHuman(stub: StubWorkspace): HumanApi {
  return {
    call: async (method, params = {}) => {
      const p: Record<string, string> = { token: stub.sessionToken }
      for (const [k, v] of Object.entries(params)) if (v !== undefined) p[k] = String(v)
      return stub.human(method, p, stub.cookie)
    },
  }
}

/** A browser that installs apps and generates app-level tokens on the stub workspace. */
function stubBrowser(stub: StubWorkspace, overrides: Partial<BrowserDriver> = {}) {
  const calls = { installApp: [] as string[], generateAppToken: [] as string[], humanApi: 0 }
  const driver: BrowserDriver = {
    ensureSignedIn: async () => 'signed-in',
    submitSignInCode: async () => 'signed-in',
    humanApi: async () => (calls.humanApi++, stubHuman(stub)),
    installApp: async (appId) => (calls.installApp.push(appId), stub.install(appId)!.botToken!),
    generateAppToken: async (appId, name) => (calls.generateAppToken.push(appId), stub.generateAppToken(appId, name)!),
    revokeAppToken: async () => {},
    clickMessageButton: async () => {},
    saveState: async () => {},
    close: async () => {},
    ...overrides,
  }
  return { driver, calls }
}

/**
 * The workspace wiring of runtime/workspace.ts, over the stub and an in-memory
 * dry-run store. `faults` answers a Web API method in the stub's place (an
 * HTTP status or a thrown network error) while it is set.
 */
function provisionHarness() {
  const stub = new StubWorkspace('cscb-dry-run', 'test-human@example.invalid', `pw-${LEAK_SENTINEL}`)
  const mem = memSecureFs()
  const redactor = new Redactor()
  const store = new SecretStore({ fs: mem.fs, paths: livePathsIn(CFG), env: {}, redactor, dryRun: true, realConfigDir: REAL })
  store.seedDryRun({ configToken: stub.configToken, password: stub.password, workspaceDomain: stub.domain, testEmail: stub.email })
  const faults = new Map<string, () => Response | Error>()
  const answer = stubFetch(stub)
  const slack = api(async (url, init) => {
    const fault = faults.get(new URL(url).pathname.replace('/api/', ''))?.()
    if (fault instanceof Error) throw fault
    return fault ?? answer(url, init)
  })
  const configTokens = new ConfigTokenSource(slack, {
    read: () => store.readConfigTokens(),
    write: (t) => store.writeConfigTokens(t),
    tokenPath: store.paths.configTokenFile,
  })
  const appsFile = new AppsStateFile(store.guardedFs(), store.paths.appsJson)
  const browser = stubBrowser(stub)
  const lines: string[] = []
  const deps: ProvisionDeps = {
    store,
    appsFile,
    bots: new BotApi(slack),
    callManifest: (method, params) => configTokens.call(method, params),
    manifestFor: (l) => personaManifest(REPO_MANIFEST, l),
    browser: async () => browser.driver,
    log: { info: (m) => lines.push(m), detail: (m) => lines.push(m) },
  }
  const members = (name: string) => [...[...stub.channels.values()].find((c) => c.name === name)!.members].sort()
  /** The stub app a bot or app-level token belongs to. */
  const appOf = (token: string) => [...stub.apps.values()].find((a) => a.botToken === token || a.appTokens.some((t) => t.token === token))?.id
  return { stub, mem, store, appsFile, browser, lines, deps, members, faults, appOf }
}

describe('runProvisioning against the stub workspace', () => {
  test('a first run provisions everything; a rerun changes nothing', async () => {
    const h = provisionHarness()
    // An archived a-home the human is not in: the run unarchives and joins it.
    h.stub.channels.set('C0OLDAHOME', { id: 'C0OLDAHOME', name: 'a-home', archived: true, members: new Set(), messages: [] })

    const first = await runProvisioning(h.deps, null)
    expect(first.apps!.map((o) => o.action)).toEqual(['created', 'created', 'created', 'created'])
    expect(first.install).toEqual({ a: 'installed', b: 'installed', c: 'installed', d: 'installed' })
    expect(first.tokens).toEqual({ a: 'generated', b: 'generated', c: 'generated', d: 'generated' })
    expect(allValid(first.validate)).toBe(true)

    const state = h.appsFile.load()
    const bot = (l: PersonaLetter) => state.personas[l]!.bot_user_id!
    expect(first.channels!['a-home']).toBe('C0OLDAHOME')
    expect(h.stub.channels.get('C0OLDAHOME')!.archived).toBe(false)
    expect(h.members('a-home')).toEqual(['U0DRYHUMAN', bot('a')].sort())
    expect(h.members('coordination')).toEqual(['U0DRYHUMAN', bot('a'), bot('b')].sort())
    expect(h.members('d-home')).toEqual(['U0DRYHUMAN', bot('d')].sort())
    expect(state).toMatchObject({ team_id: 'T0DRYSTUB0', human_user_id: 'U0DRYHUMAN', channels: first.channels })
    expect(PERSONA_LETTERS.map((l) => state.personas[l]!.app_token_name)).toEqual(Array(4).fill('cscb-live'))
    for (const l of PERSONA_LETTERS) {
      const path = hostCredentialsFile(h.store.paths, l)
      expect([l, h.mem.files.get(path)?.mode]).toEqual([l, 0o600])
    }
    expect([h.mem.dirs.get(h.store.paths.credentialsDir), h.mem.dirs.get(h.store.paths.stagedCredentialsDir)]).toEqual([0o700, 0o700])
    expect(h.store.accessed.filter((p) => !isInside(p, CFG))).toEqual([])
    const appsJson = h.mem.files.get(h.store.paths.appsJson)!.data
    expect(/client_secret|signing_secret/.test(appsJson)).toBe(false)
    assertNoLeak({ lines: h.lines, first, appsJson })

    const created = h.stub.calls.get('apps.manifest.create')
    const second = await runProvisioning(h.deps, null)
    expect(second.apps!.map((o) => o.action)).toEqual(['reused', 'reused', 'reused', 'reused'])
    expect(second.install).toEqual({ a: 'kept', b: 'kept', c: 'kept', d: 'kept' })
    expect(second.tokens).toEqual({ a: 'kept', b: 'kept', c: 'kept', d: 'kept' })
    expect(second.channels).toEqual(first.channels)
    expect(allValid(second.validate)).toBe(true)
    expect([h.stub.calls.get('apps.manifest.create'), created, h.browser.calls.installApp.length, h.browser.calls.generateAppToken.length]).toEqual([4, 4, 4, 4])
    assertNoLeak({ lines: h.lines, second })
  })

  test('a rerun re-installs only a drifted app and removes bots from where they must not be', async () => {
    const h = provisionHarness()
    await runProvisioning(h.deps, null)
    const state = h.appsFile.load()
    const appA = state.personas.a!.app_id!
    ;(h.stub.apps.get(appA)!.manifest.display_information as Record<string, unknown>).name = 'Renamed by hand'
    const channelId = (name: string) => state.channels[name as 'a-home']!
    h.stub.channels.get(channelId('coordination'))!.members.add(state.personas.c!.bot_user_id!)
    h.stub.channels.get(channelId('d-home'))!.members.add(state.personas.a!.bot_user_id!)
    h.browser.calls.installApp.length = 0

    const report = await runProvisioning(h.deps, null)
    expect(report.apps!.map((o) => o.action)).toEqual(['updated', 'reused', 'reused', 'reused'])
    expect(report.install).toEqual({ a: 'reinstalled', b: 'kept', c: 'kept', d: 'kept' })
    expect(h.browser.calls.installApp).toEqual([appA])
    expect(h.appsFile.load().personas.a!.needs_reinstall).toBeUndefined()
    expect(h.members('coordination')).not.toContain(state.personas.c!.bot_user_id)
    expect(h.members('d-home')).not.toContain(state.personas.a!.bot_user_id)
    expect(allValid(report.validate)).toBe(true)
    assertNoLeak({ lines: h.lines, report })
  })

  test('--stage apps runs the apps stage alone and never opens the browser', async () => {
    expect(stagesToRun('apps')).toEqual({ stages: ['apps'], validate: false })
    expect(stagesToRun(null)).toEqual({ stages: ['apps', 'install', 'tokens', 'channels'], validate: true })
    const h = provisionHarness()
    let launched = 0
    h.deps.browser = async () => (launched++, h.browser.driver)
    const report = await runProvisioning(h.deps, 'apps')
    expect(Object.keys(report)).toEqual(['apps'])
    expect(launched).toBe(0)
    assertNoLeak({ lines: h.lines, report })
  })

  test('a real run with no apps.json creates no app (they may exist from another VM) unless --create-apps; with apps.json it proceeds', async () => {
    const h = provisionHarness()
    h.deps.requireAppsJsonToCreate = true
    const err = await rejection(runProvisioning(h.deps, 'apps'))
    expect([err instanceof NotRunnableError, err.message]).toEqual([true, missingAppsJsonMessage(h.appsFile.path)])
    expect([h.stub.calls.get('apps.manifest.create'), h.appsFile.exists()]).toEqual([undefined, false])
    expect(err.message).toContain('copy apps.json from that VM to this path (mode 600), or rerun with --create-apps to create new ones')

    h.deps.requireAppsJsonToCreate = false
    await runProvisioning(h.deps, 'apps')
    h.deps.requireAppsJsonToCreate = true
    const rerun = await runProvisioning(h.deps, 'apps')
    expect(rerun.apps!.map((o) => o.action)).toEqual(['reused', 'reused', 'reused', 'reused'])
    expect(h.stub.calls.get('apps.manifest.create')).toBe(4)
    assertNoLeak({ err, lines: h.lines, rerun })
  })

  test("an unfinished create is resolved from the apps list provisioning is given: the app the lost create made is adopted, another workspace's app of that name is left alone, and only the other three are created", async () => {
    const h = provisionHarness()
    const made = h.stub.createApp(personaManifest(REPO_MANIFEST, 'c')).id
    h.stub.createApp(personaManifest(REPO_MANIFEST, 'c'), { foreign: true })
    h.appsFile.save({ version: 1, personas: { c: { pending_create: { started_at: '2026-09-25T08:00:00.000Z' } } }, channels: {} })
    h.deps.listApps = async () => [...h.stub.apps.values()].map((a) => ({ id: a.id, name: String((a.manifest.display_information as JsonObject).name), rowText: null }))
    const report = await runProvisioning(h.deps, 'apps')
    expect(report.apps!.map((o) => [o.letter, o.action])).toEqual([['a', 'created'], ['b', 'created'], ['c', 'adopted'], ['d', 'created']])
    expect([h.appsFile.load().personas.c, h.stub.calls.get('apps.manifest.create')]).toEqual([{ app_id: made }, 3])
    assertNoLeak({ lines: h.lines, report })
  })

  test('validateCredentials reports a missing credentials file as failed, by status only', async () => {
    const h = provisionHarness()
    await runProvisioning(h.deps, null)
    h.mem.files.delete(hostCredentialsFile(h.store.paths, 'c'))
    const report = await validateCredentials(h.deps)
    expect(report.c).toEqual({ bot: 'failed', app: 'failed' })
    expect(report.a).toEqual({ bot: 'ok', app: 'ok' })
    expect(allValid(report)).toBe(false)
    expect(allValid(undefined)).toBe(false)
    expect(h.lines.at(-2)).toBe('validate: CSCB Test C: bot_token failed (no_file), app_token failed (no_file)')
    assertNoLeak(h.lines)
  })
})

describe('install and app-token stage failures', () => {
  async function afterApps() {
    const h = provisionHarness()
    await runProvisioning(h.deps, 'apps')
    const creds = { readCredentials: (l: PersonaLetter) => h.store.readCredentials(l), writeCredentials: h.store.writeCredentials.bind(h.store) }
    return { ...h, creds }
  }

  /** Every stage run once: each persona has a working credentials file. */
  async function provisioned() {
    const h = await afterApps()
    await runProvisioning(h.deps, null)
    const file = (l: PersonaLetter) => h.mem.files.get(hostCredentialsFile(h.store.paths, l))!.data
    const appId = (l: PersonaLetter) => h.appsFile.load().personas[l]!.app_id!
    return { ...h, file, appId }
  }

  test('install needs the apps stage first', async () => {
    const h = provisionHarness()
    const creds = { readCredentials: () => null, writeCredentials: () => {} }
    const err = await rejection(runInstallStage({ ...h.deps, letters: ['a'], creds, log: h.deps.log }))
    expect([err instanceof ProvisionError, err.message]).toEqual([true, 'CSCB Test A has no app ID in apps.json: run the apps stage first'])
  })

  test.each([
    ['fails auth.test', () => fakeToken(BOT_TOKEN_PREFIX, 'junk'), 'install: CSCB Test A: the bot token read after install fails auth.test (invalid_auth)'],
    ['belongs to another app', (stub: StubWorkspace) => stub.install(stub.createApp({}).id)!.botToken!, 'install: CSCB Test A: the bot token read after install belongs to another app'],
  ])('install stops when the token read after install %s, and writes no credentials file', async (_what, token, message) => {
    const h = await afterApps()
    const browser = stubBrowser(h.stub, { installApp: async () => token(h.stub) })
    const err = await rejection(runInstallStage({ ...h.deps, letters: ['a'], creds: h.creds, browser: async () => browser.driver }))
    expect([err instanceof ProvisionError, err.message]).toEqual([true, message])
    expect(h.mem.files.has(hostCredentialsFile(h.store.paths, 'a'))).toBe(false)
    assertNoLeak({ err, lines: h.lines })
  })

  test("install replaces a credentials file whose bot token belongs to another app", async () => {
    const h = await afterApps()
    const other = h.stub.install(h.stub.createApp({}).id)!.botToken!
    h.store.writeCredentials('a', { bot_token: other, app_token: '' })
    const out = await runInstallStage({ ...h.deps, letters: ['a'], creds: h.creds })
    expect(out).toEqual({ a: 'reinstalled' })
    expect(h.store.readCredentials('a')!.bot_token).not.toBe(other)
    expect(h.lines).toContain('install: CSCB Test A: bot token not usable (another app); installing')
    assertNoLeak({ lines: h.lines, out })
  })

  test('the app-token stage needs a credentials file, and stops when the generated token is refused', async () => {
    const h = await afterApps()
    const missing = await rejection(runAppTokenStage({ ...h.deps, letters: ['b'], creds: h.creds }))
    expect(missing.message).toBe('tokens: CSCB Test B has no credentials file: run the install stage first')
    await runInstallStage({ ...h.deps, letters: ['b'], creds: h.creds })
    const browser = stubBrowser(h.stub, { generateAppToken: async () => fakeToken(APP_TOKEN_PREFIX, 'junk') })
    const refused = await rejection(runAppTokenStage({ ...h.deps, letters: ['b'], creds: h.creds, browser: async () => browser.driver }))
    expect([refused instanceof ProvisionError, refused.message]).toEqual([true, 'tokens: CSCB Test B: the generated app token fails apps.connections.open (invalid_auth)'])
    expect(h.store.readCredentials('b')!.app_token).toBe('')
    assertNoLeak({ missing, refused, lines: h.lines })
  })

  // A token is replaced only when Slack refuses it: a transient failure stops the stage and replaces nothing.
  test.each([
    ['auth.test gets no answer', 'auth.test', () => new TypeError('down'), 'install: CSCB Test A: auth.test failed (network), which is not a token refusal (transient: rerun later)'],
    ['auth.test answers 503', 'auth.test', () => new Response('', { status: 503 }), 'install: CSCB Test A: auth.test failed (http_503), which is not a token refusal (transient: rerun later)'],
    ['bots.info answers 500', 'bots.info', () => new Response('', { status: 500 }), 'install: CSCB Test A: bots.info failed (http_500), which is not a token refusal (transient: rerun later)'],
  ])('install: when checking the saved bot token %s, the stage stops and re-installs nothing', async (_what, method, fault, message) => {
    const h = await provisioned()
    const before = h.file('a')
    const installs = h.browser.calls.installApp.length
    h.faults.set(method, fault)
    const err = await rejection(runInstallStage({ ...h.deps, letters: ['a'], creds: h.creds }))
    expect([err instanceof TransientProvisionError, err.message]).toEqual([true, message])
    expect([h.browser.calls.installApp.length, h.file('a')]).toEqual([installs, before])
    assertNoLeak({ err, lines: h.lines })
  })

  test('install: a transient bots.info failure for the token read after install stops the stage without writing it', async () => {
    const h = await afterApps()
    h.faults.set('bots.info', () => new Response('', { status: 502 }))
    const err = await rejection(runInstallStage({ ...h.deps, letters: ['a'], creds: h.creds }))
    expect([err instanceof TransientProvisionError, err.message]).toEqual([
      true,
      'install: CSCB Test A: bots.info failed (http_502) for the bot token read after install (transient: rerun later)',
    ])
    expect(h.mem.files.has(hostCredentialsFile(h.store.paths, 'a'))).toBe(false)
    assertNoLeak({ err, lines: h.lines })
  })

  test("a re-install writes the new bot token without the old app-level token; the tokens stage then generates one for this app", async () => {
    const h = await provisioned()
    const oldApp = h.store.readCredentials('a')!.app_token
    h.appsFile.update((s) => {
      s.personas.a!.needs_reinstall = true
    })
    expect(await runInstallStage({ ...h.deps, letters: ['a'], creds: h.creds })).toEqual({ a: 'reinstalled' })
    expect(h.store.readCredentials('a')!.app_token).toBe('')
    expect(h.lines).toContain('install: CSCB Test A: the old app-level token was dropped; the tokens stage generates a new one')
    expect(await runAppTokenStage({ ...h.deps, letters: ['a'], creds: h.creds })).toEqual({ a: 'generated' })
    const now = h.store.readCredentials('a')!
    expect([now.app_token === oldApp, h.appOf(now.app_token), h.appOf(now.bot_token)]).toEqual([false, h.appId('a'), h.appId('a')])
    assertNoLeak({ lines: h.lines })
  })

  test("a credentials file seeded with another app's valid tokens ends, after install and tokens, with both tokens of the persona's own app", async () => {
    const h = await afterApps()
    const other = h.stub.createApp({})
    const seeded = { bot_token: h.stub.install(other.id)!.botToken!, app_token: h.stub.generateAppToken(other.id, 'cscb-live')! }
    h.store.writeCredentials('a', seeded)
    const install = await runInstallStage({ ...h.deps, letters: ['a'], creds: h.creds })
    const tokens = await runAppTokenStage({ ...h.deps, letters: ['a'], creds: h.creds })
    expect([install, tokens]).toEqual([{ a: 'reinstalled' }, { a: 'generated' }])
    const appA = h.appsFile.load().personas.a!.app_id
    const now = h.store.readCredentials('a')!
    expect([h.appOf(now.bot_token), h.appOf(now.app_token)]).toEqual([appA, appA])
    assertNoLeak({ install, tokens, lines: h.lines })
  })

  test('tokens: a transient failure checking the saved app token stops the stage and keeps the token', async () => {
    const h = await provisioned()
    const before = h.file('b')
    const generated = h.browser.calls.generateAppToken.length
    h.faults.set('apps.connections.open', () => new Response('', { status: 500 }))
    const err = await rejection(runAppTokenStage({ ...h.deps, letters: ['b'], creds: h.creds }))
    expect([err instanceof TransientProvisionError, err.message]).toEqual([
      true,
      'tokens: CSCB Test B: apps.connections.open failed (http_500), which is not a token refusal (transient: rerun later)',
    ])
    expect([h.browser.calls.generateAppToken.length, h.file('b')]).toEqual([generated, before])
    assertNoLeak({ err, lines: h.lines })
  })

  test('tokens: a refused saved app token is replaced by a new one of the given name, recorded in apps.json', async () => {
    const h = await provisioned()
    h.stub.revokeAppToken(h.appId('b'), 'cscb-live')
    const out = await runAppTokenStage({ ...h.deps, letters: ['b'], creds: h.creds, tokenName: 'cscb-live-1700000000' })
    expect(out).toEqual({ b: 'generated' })
    expect(h.lines).toContain('tokens: CSCB Test B: app token refused (invalid_auth); generating a new one')
    expect(h.stub.apps.get(h.appId('b'))!.appTokens.map((t) => t.name)).toEqual(['cscb-live-1700000000'])
    expect(h.appsFile.load().personas.b!.app_token_name).toBe('cscb-live-1700000000')
    assertNoLeak({ out, lines: h.lines })
  })

  test('tokens: a new token whose check fails transiently is saved first, then the stage stops; a rerun keeps it', async () => {
    const h = await afterApps()
    await runInstallStage({ ...h.deps, letters: ['b'], creds: h.creds })
    h.faults.set('apps.connections.open', () => new TypeError('down'))
    const err = await rejection(runAppTokenStage({ ...h.deps, letters: ['b'], creds: h.creds, tokenName: 'cscb-live-1700000000' }))
    expect([err instanceof TransientProvisionError, err.message]).toEqual([
      true,
      'tokens: CSCB Test B: the generated app token (cscb-live-1700000000, saved) could not be checked: apps.connections.open failed (network) (transient: rerun later)',
    ])
    const saved = h.store.readCredentials('b')!.app_token
    expect([h.appOf(saved), h.appsFile.load().personas.b!.app_token_name]).toEqual([h.appsFile.load().personas.b!.app_id, 'cscb-live-1700000000'])
    h.faults.clear()
    expect(await runAppTokenStage({ ...h.deps, letters: ['b'], creds: h.creds })).toEqual({ b: 'kept' })
    expect(h.browser.calls.generateAppToken.length).toBe(1)
    assertNoLeak({ err, lines: h.lines })
  })
})
