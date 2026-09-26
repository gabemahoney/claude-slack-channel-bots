/**
 * workspace.ts — the run's view of the test workspace, real or stubbed:
 * the secret store, apps.json, the Slack API caller, the URLs the browser
 * flows use, the test mailbox and a lazily launched, signed-in browser.
 *
 * Real: the store reads `~/.config/cscb-test/` (or CSCB_LIVE_CONFIG_DIR) after
 * checking every secret's mode. Dry run: a fresh temporary config dir seeded
 * from the local stub (its mailbox.json points at the stub's mailbox); the
 * real dir's files are never touched (the store throws if anything tries).
 *
 * When Slack asks the test human for an emailed sign-in code, the browser's
 * launch first reads it from the test mailbox (lib/sign-in-code.ts); only
 * when that gives none does it stop with "run login" (exit 2). The second
 * workspace user's mail is not forwarded: its code still needs `login
 * --second`.
 */

import { chmodSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'

import { AppsStateFile } from '../lib/apps-state.ts'
import type { BrowserDriver, SlackUrls } from '../lib/browser-types.ts'
import type { RunLog } from '../lib/log.ts'
import { MailTmClient } from '../lib/mailbox.ts'
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

export interface Workspace {
  mode: 'real' | 'dry-run'
  store: SecretStore
  appsFile: AppsStateFile
  api: SlackApi
  bots: BotApi
  urls: SlackUrls
  live: LiveConfig
  callManifest: (method: string, params: SlackParams) => Promise<SlackResponse>
  manifestFor: (letter: PersonaLetter) => JsonObject
  /** The test human's signed-in browser (launched on first call). */
  browser(): Promise<BrowserDriver>
  /** The second user's signed-in browser, when live.json configures one. */
  secondBrowser(): Promise<BrowserDriver | null>
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

async function launch(
  o: WorkspaceOptions,
  who: 'human' | 'second',
  urls: SlackUrls,
  domain: string,
  identity: () => { email: string; password: string },
  storage: { exists(): boolean; load(): string; save(json: string): void },
  /**
   * Where an emailed sign-in code can be read (the test human's forwarded
   * mail, only Slack mail sent to `testEmail` counting); `null`: nowhere.
   */
  mailbox: { open: () => MailTmClient | null; testEmail: string; pollMs?: number } | null,
): Promise<BrowserDriver> {
  // Loaded here so nothing but a browser stage pulls in playwright-core.
  const { launchDriver } = await import('../browser/driver.ts')
  const driver = await launchDriver({ urls, domain, identity, storage, redactor: o.redactor, log: o.log })
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
    o.redactor.addSecret(password)
    const box = stub.workspace.mailbox
    store.seedDryRun({
      configToken: stub.workspace.configToken,
      password,
      workspaceDomain: DRY_DOMAIN,
      testEmail: DRY_EMAIL,
      // A stale token: the first mailbox call gets a 401, so the run fetches a fresh one and rewrites the file.
      mailbox: { api: stub.mailApiBase, address: box.address, password: box.password, accountId: box.accountId, token: box.staleToken, extra: {} },
    })
  } else {
    store = new SecretStore({ fs: nodeSecureFs, paths: livePathsIn(realConfigDir), env: process.env, redactor: o.redactor, dryRun: false, realConfigDir })
    store.ensureConfigDir()
    store.assertLayoutPrivate()
  }
  const live = store.readLiveConfig()
  // The email addresses are config, but no log line or result may show them either.
  o.redactor.addSecret(live.testEmail)
  o.redactor.addSecret(live.secondUser?.email)
  const api = new SlackApi({ baseUrl: stub ? stub.apiBase : SLACK_API_BASE_URL, fetch })
  const urls = stub ? stub.urls : REAL_SLACK_URLS
  const configTokens = new ConfigTokenSource(api, {
    read: () => store.readConfigTokens(),
    write: (t) => store.writeConfigTokens(t),
    tokenPath: store.paths.configTokenFile,
  })
  const base = loadRepoManifest(o.repoRoot, (p) => readFileSync(p, 'utf-8'))
  let human: Promise<BrowserDriver> | null = null
  let second: Promise<BrowserDriver | null> | null = null
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
  return {
    mode,
    store,
    appsFile: new AppsStateFile(store.guardedFs(), store.paths.appsJson),
    api,
    bots: new BotApi(api),
    urls,
    live,
    callManifest: (method, params) => configTokens.call(method, params),
    manifestFor: (letter) => personaManifest(base, letter),
    browser() {
      human ??= launch(o, 'human', urls, live.workspaceDomain, () => ({ email: live.testEmail, password: store.readPassword() }), store.storageState('human'), humanMailbox)
      return human
    },
    secondBrowser() {
      const cfg = live.secondUser
      if (!cfg || mode === 'dry-run') return Promise.resolve(null)
      second ??= launch(o, 'second', urls, live.workspaceDomain, () => ({ email: cfg.email, password: store.readSecondPassword(cfg) }), store.storageState('second'), null)
      return second
    },
    openMailbox,
    stub,
    async close() {
      for (const p of [human, second]) {
        const d = p ? await p.catch(() => null) : null
        await d?.close()
      }
      stub?.stop()
      if (dryDir) rmSync(dryDir, { recursive: true, force: true })
    },
  }
}
