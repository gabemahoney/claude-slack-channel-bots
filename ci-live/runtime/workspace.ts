/**
 * workspace.ts — the run's view of the test workspace, real or stubbed:
 * the secret store, apps.json, the Slack API caller, the URLs the browser
 * flows use, the test mailbox and a lazily launched, signed-in browser.
 *
 * The workspace launches one Chrome at most (browser/driver.ts `ChromeHost`),
 * on first use: the test human's and the second account's drivers are each
 * one context with one page in it. `browserStats` gives the memory watchdog
 * its contexts and pages. `closeBrowser` closes that Chrome at once, without
 * waiting for a driver or a sign-in in progress (the memory watchdog's stop);
 * `close` closes it first too, then waits for them.
 *
 * The configuration token is optional once apps.json records all four apps
 * (provision/apps.ts): a missing token file is left to the apps stage, which
 * then reuses the recorded apps unchecked, with a warning.
 *
 * Real: the store reads `~/.config/cscb-test/` (or CSCB_LIVE_CONFIG_DIR) after
 * checking every secret's mode. Dry run: a fresh temporary config dir seeded
 * from the local stub (its mailbox.json points at the stub's mailbox); the
 * real dir's files are never touched (the store throws if anything tries).
 *
 * When Slack asks an account for an emailed sign-in code, the browser's
 * launch first reads it from the test mailbox (lib/sign-in-code.ts), which
 * both accounts' mail is forwarded to: only Slack mail sent exactly to that
 * account's own address counts (the test human's `test_email`, the second
 * workspace user's `second_user.email`). A code-only second account (no
 * password in live.json) requests its code on every sign-in without a saved
 * session. Only when the mailbox gives none does the launch stop with "run
 * login" or "run login --second" (exit 2). The dry run signs no second
 * account in.
 *
 * Both addresses are registered with the redactor before any sign-in: the
 * test email as it is, the second address in every `addressForms` form.
 */

import { chmodSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'

import { AppsStateFile } from '../lib/apps-state.ts'
import type { AppListingBrowser, BrowserDriver, BrowserStats, SlackUrls } from '../lib/browser-types.ts'
import type { RunLog } from '../lib/log.ts'
import { addressForms, MailTmClient } from '../lib/mailbox.ts'
import { loadRepoManifest, personaManifest, type JsonObject } from '../lib/manifest.ts'
import { livePathsIn, resolveConfigDir } from '../lib/paths.ts'
import type { PersonaLetter } from '../lib/personas.ts'
import type { Redactor } from '../lib/redact.ts'
import { SecretStore, SignInCodeNeededError, nodeSecureFs, type LiveConfig } from '../lib/secrets.ts'
import { answerSignInCodeFromMailbox } from '../lib/sign-in-code.ts'
import { SlackApi, SLACK_API_BASE_URL, type SlackParams, type SlackResponse } from '../lib/slack-api.ts'
import { REAL_SLACK_URLS } from '../lib/slack-urls.ts'
import { realClock, SECOND } from '../lib/wait.ts'
import { BotApi } from '../provision/bot-api.ts'
import { ConfigTokenSource } from '../provision/config-token.ts'
import { startStubServer, type StubServer } from '../dry-run/stub-server.ts'
// Types only: playwright-core itself is loaded (dynamically) only when a browser is launched.
import type { ChromeHost, StorageStateStore } from '../browser/driver.ts'

/** A signed-in account's driver: the checks' `BrowserDriver`, plus the apps list page. */
export type AccountBrowser = BrowserDriver & AppListingBrowser

export interface Workspace {
  mode: 'real' | 'dry-run'
  store: SecretStore
  appsFile: AppsStateFile
  api: SlackApi
  bots: BotApi
  urls: SlackUrls
  live: LiveConfig
  callManifest: (method: string, params: SlackParams) => Promise<SlackResponse>
  /** The configuration token source (a forced rotation for `config-token --rotate`). */
  configTokens: ConfigTokenSource
  manifestFor: (letter: PersonaLetter) => JsonObject
  /** The test human's signed-in browser (launched on first call). */
  browser(): Promise<AccountBrowser>
  /** The second user's signed-in browser, when live.json configures one. */
  secondBrowser(): Promise<BrowserDriver | null>
  /** The one Chrome's open contexts and pages, or `null` before it is launched (or after it failed to). */
  browserStats(): BrowserStats | null
  /**
   * Close the one Chrome now (after its launch, when one is in progress),
   * without waiting for a driver or a sign-in: their flows fail from here on.
   * Idempotent.
   */
  closeBrowser(): Promise<void>
  /**
   * The test mailbox (mailbox.json in the store's dir: the stub's in a dry
   * run), or `null` when there is none. Throws (not runnable) when the file
   * is not private or not a usable mailbox.
   */
  openMailbox(): MailTmClient | null
  stub: StubServer | null
  close(): Promise<void>
}

export interface WorkspaceOptions {
  repoRoot: string
  runId: string
  redactor: Redactor
  log: RunLog
}

const DRY_DOMAIN = 'cscb-dry-run'
/** With a `+tag`, as the real test email may have: the stub's decoy code goes to the same inbox's address without it. */
const DRY_EMAIL = 'test-human+cscbtest@example.invalid'

/** How often a sign-in polls the mailbox for Slack's code: the dry run's stub mail arrives in seconds. */
const DRY_RUN_MAIL_POLL_MS = 1 * SECOND

/** Sign one account in, in its own context of the workspace's one Chrome. */
async function launch(
  o: WorkspaceOptions,
  who: 'human' | 'second',
  chrome: () => Promise<ChromeHost>,
  urls: SlackUrls,
  domain: string,
  identity: () => { email: string; password: string | null },
  storage: StorageStateStore,
  /**
   * Where an emailed sign-in code can be read (the test mailbox, only Slack
   * mail sent to `testEmail`, the account's own email, counting); `null`:
   * nowhere.
   */
  mailbox: { open: () => MailTmClient | null; testEmail: string; pollMs?: number } | null,
): Promise<AccountBrowser> {
  const driver = await (await chrome()).openDriver({ urls, domain, identity, storage, redactor: o.redactor, log: o.log })
  try {
    // Before the password is submitted: Slack's email for this attempt is newer than this.
    const attemptStartedAt = realClock.now()
    let outcome = await driver.ensureSignedIn()
    if (outcome === 'needs-code' && mailbox) {
      outcome = await answerSignInCodeFromMailbox({
        openMailbox: mailbox.open,
        submitCode: (code) => driver.submitSignInCode(code),
        testEmail: mailbox.testEmail,
        addSecret: (value) => o.redactor.addSecret(value),
        clock: realClock,
        log: o.log,
        attemptStartedAt,
        pollMs: mailbox.pollMs,
      })
    }
    if (outcome === 'needs-code') throw new SignInCodeNeededError(who)
    return driver
  } catch (err) {
    await driver.close()
    throw err
  }
}

export function openWorkspace(o: WorkspaceOptions, mode: 'real' | 'dry-run'): Workspace {
  const realConfigDir = resolveConfigDir(process.env, homedir())
  let stub: StubServer | null = null
  let dryDir: string | null = null
  let store: SecretStore
  if (mode === 'dry-run') {
    dryDir = mkdtempSync(join(tmpdir(), `cscb-ci-live-dry-${o.runId}-`))
    chmodSync(dryDir, 0o700)
    const password = crypto.randomUUID()
    stub = startStubServer({ domain: DRY_DOMAIN, email: DRY_EMAIL, password })
    // The sign-in's first code is refused and a newer one emailed: the run must type the newer one.
    stub.workspace.refuseFirstCode = true
    store = new SecretStore({ fs: nodeSecureFs, paths: livePathsIn(join(dryDir, 'config')), env: {}, redactor: o.redactor, dryRun: true, realConfigDir })
    o.redactor.addSecret(stub.workspace.configToken)
    o.redactor.addSecret(stub.workspace.refreshToken)
    o.redactor.addSecret(password)
    const box = stub.workspace.mailbox
    store.seedDryRun({
      configToken: stub.workspace.configToken,
      refreshToken: stub.workspace.refreshToken,
      password,
      workspaceDomain: DRY_DOMAIN,
      testEmail: DRY_EMAIL,
      // A stale token: the first mailbox call gets a 401, so the run fetches a fresh one and rewrites the file.
      mailbox: { api: stub.mailApiBase, address: box.address, password: box.password, accountId: box.accountId, token: box.staleToken, extra: {} },
    })
  } else {
    store = new SecretStore({ fs: nodeSecureFs, paths: livePathsIn(realConfigDir), env: process.env, redactor: o.redactor, dryRun: false, realConfigDir })
    // Every loose path at once (after a VM reboot they all are), before the dir's own check.
    store.assertLayoutPrivate()
    store.ensureConfigDir()
  }
  const live = store.readLiveConfig()
  // The email addresses are config, but no log line or result may show them either. The
  // second address in every form mail about it takes (with and without a +tag), before any sign-in.
  o.redactor.addSecret(live.testEmail)
  if (live.secondUser) for (const form of addressForms(live.secondUser.email)) o.redactor.addSecret(form)
  const api = new SlackApi({ baseUrl: stub ? stub.apiBase : SLACK_API_BASE_URL, fetch })
  const urls = stub ? stub.urls : REAL_SLACK_URLS
  const configTokens = new ConfigTokenSource(
    api,
    {
      read: () => store.readConfigTokens(),
      write: (t) => store.writeConfigTokens(t),
      tokenPath: store.paths.configTokenFile,
      refreshTokenPath: store.paths.refreshTokenFile,
    },
    o.log,
  )
  const base = loadRepoManifest(o.repoRoot, (p) => readFileSync(p, 'utf-8'))
  let human: Promise<AccountBrowser> | null = null
  let second: Promise<BrowserDriver | null> | null = null
  let host: Promise<ChromeHost> | null = null
  let launched: ChromeHost | null = null
  // Loaded on first use so nothing but a browser stage pulls in playwright-core.
  const chrome = (): Promise<ChromeHost> =>
    (host ??= import('../browser/driver.ts')
      .then(({ ChromeHost: Host }) => Host.launch())
      .then((h) => (launched = h)))
  const openMailbox = (): MailTmClient | null => {
    const config = store.readMailbox()
    if (!config) return null
    return new MailTmClient({
      config,
      fetch,
      clock: realClock,
      onSecret: (value) => o.redactor.addSecret(value),
      save: (next) => store.writeMailbox(next),
    })
  }
  const humanMailbox = { open: openMailbox, testEmail: live.testEmail, pollMs: stub ? DRY_RUN_MAIL_POLL_MS : undefined }
  const closeBrowser = async (): Promise<void> => {
    const h = host ? await host.catch(() => null) : null
    launched = null
    await h?.close()
  }
  return {
    mode,
    store,
    appsFile: new AppsStateFile(store.guardedFs(), store.paths.appsJson),
    api,
    bots: new BotApi(api),
    urls,
    live,
    callManifest: (method, params) => configTokens.call(method, params),
    configTokens,
    manifestFor: (letter) => personaManifest(base, letter),
    browser() {
      human ??= launch(o, 'human', chrome, urls, live.workspaceDomain, () => ({ email: live.testEmail, password: store.readPassword() }), store.storageState('human'), humanMailbox)
      return human
    },
    secondBrowser() {
      const cfg = live.secondUser
      if (!cfg || mode === 'dry-run') return Promise.resolve(null)
      // Its code is read from the mailbox too, when its mail reaches it (a code-only account's must).
      const secondMailbox = { open: openMailbox, testEmail: cfg.email }
      second ??= launch(o, 'second', chrome, urls, live.workspaceDomain, () => ({ email: cfg.email, password: store.readSecondPassword(cfg) }), store.storageState('second'), secondMailbox)
      return second
    },
    browserStats: () => {
      try {
        return launched?.stats() ?? null
      } catch {
        return null
      }
    },
    closeBrowser,
    openMailbox,
    stub,
    async close() {
      // Chrome first: a sign-in or flow still in progress then fails at once instead of holding it open.
      await closeBrowser()
      for (const p of [human, second]) {
        const d = p ? await p.catch(() => null) : null
        await d?.close()
      }
      stub?.stop()
      if (dryDir) rmSync(dryDir, { recursive: true, force: true })
    },
  }
}
