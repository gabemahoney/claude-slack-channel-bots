/**
 * driver.ts — the Playwright implementation of `BrowserDriver`: installed
 * Google Chrome (`channel: 'chrome'`), headless, with a normal desktop
 * user-agent (Slack may refuse a `HeadlessChrome` one).
 *
 * Hygiene: no tracing, no video, no screenshots; the browser process gets a
 * minimal environment (never the runner's own, which holds production
 * tokens); every token read off a page, the session token and the session
 * cookie are registered with the redactor the moment they are read; the
 * storageState (cookies) is loaded only after its mode check and saved only
 * through the secret store (mode 600, temp + rename).
 *
 * This is the only module (with the flows it calls) that imports
 * playwright-core.
 */

import { chromium, type Browser, type BrowserContext, type BrowserContextOptions, type Page } from 'playwright-core'

import type { BrowserDriver, HumanApi, SignInOutcome, SlackUrls } from '../lib/browser-types.ts'
import { minimalChildEnv } from '../lib/proc.ts'
import type { Redactor } from '../lib/redact.ts'
import { NotRunnableError } from '../lib/secrets.ts'
import { generateAppToken, revokeAppToken } from './app-token.flow.ts'
import { installAndReadBotToken } from './install.flow.ts'
import { signInWithPassword, submitConfirmationCode } from './login.flow.ts'
import { clickMessageButton } from './message.flow.ts'
import { contextHumanApi, readSessionToken } from './session.flow.ts'

export interface StorageStateStore {
  exists(): boolean
  /** Read the saved storageState JSON (after its mode check). */
  load(): string
  /** Save storageState JSON (mode 600, temp + rename). */
  save(json: string): void
}

export interface DriverOptions {
  urls: SlackUrls
  domain: string
  /** The sign-in identity, read only when a sign-in is needed. */
  identity: () => { email: string; password: string }
  storage: StorageStateStore
  redactor: Redactor
  log: { info(message: string): void; detail(message: string): void }
}

/** A desktop Chrome user-agent for this Chrome version. */
export function desktopUserAgent(version: string): string {
  const major = /^(\d+)/.exec(version)?.[1] ?? '140'
  return `Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${major}.0.0.0 Safari/537.36`
}

class PlaywrightDriver implements BrowserDriver {
  private sessionToken: string | null = null
  private api: HumanApi | null = null

  constructor(
    private readonly o: DriverOptions,
    private readonly browser: Browser,
    private readonly context: BrowserContext,
    private readonly page: Page,
  ) {}

  private async adoptSessionToken(): Promise<boolean> {
    const token = await readSessionToken(this.page, this.o.urls, this.o.domain)
    if (!token) return false
    this.o.redactor.addSecret(token)
    this.sessionToken = token
    this.api = contextHumanApi(this.context, this.o.urls, this.o.domain, token)
    return true
  }

  async ensureSignedIn(): Promise<SignInOutcome> {
    if (this.sessionToken) return 'signed-in'
    if (await this.adoptSessionToken()) return 'signed-in'
    const { email, password } = this.o.identity()
    this.o.redactor.addSecret(password)
    this.o.log.info('browser: signing the test human in (email + password)')
    const outcome = await signInWithPassword(this.page, this.o.urls, this.o.domain, email, password)
    if (outcome === 'needs-code') return 'needs-code'
    if (!(await this.adoptSessionToken())) throw new NotRunnableError('signed in, but the web client holds no session for the test workspace')
    await this.saveState()
    return 'signed-in'
  }

  async submitSignInCode(code: string): Promise<SignInOutcome> {
    const outcome = await submitConfirmationCode(this.page, code)
    if (outcome === 'signed-in') {
      if (!(await this.adoptSessionToken())) throw new NotRunnableError('signed in, but the web client holds no session for the test workspace')
      await this.saveState()
    }
    return outcome
  }

  async humanApi(): Promise<HumanApi> {
    if (!this.api) {
      const outcome = await this.ensureSignedIn()
      if (outcome !== 'signed-in' || !this.api) {
        throw new NotRunnableError('Slack asked for an emailed sign-in code: run `bun ci-live/run.ts login` once, then rerun')
      }
    }
    return this.api
  }

  async installApp(appId: string): Promise<string> {
    const token = await installAndReadBotToken(this.page, this.o.urls, appId)
    this.o.redactor.addSecret(token)
    return token
  }

  async generateAppToken(appId: string, name: string): Promise<string> {
    const token = await generateAppToken(this.page, this.o.urls, appId, name)
    this.o.redactor.addSecret(token)
    return token
  }

  async revokeAppToken(appId: string, name: string): Promise<void> {
    await revokeAppToken(this.page, this.o.urls, appId, name)
  }

  async clickMessageButton(teamId: string, conversationId: string, ts: string, buttonName: string): Promise<void> {
    await clickMessageButton(this.page, this.o.urls, teamId, conversationId, ts, buttonName)
  }

  async saveState(): Promise<void> {
    const state = await this.context.storageState()
    for (const cookie of state.cookies) if (cookie.name === 'd' || cookie.name === 'd-s') this.o.redactor.addSecret(cookie.value)
    this.o.storage.save(`${JSON.stringify(state)}\n`)
  }

  async close(): Promise<void> {
    await this.context.close().catch(() => undefined)
    await this.browser.close().catch(() => undefined)
  }
}

/**
 * Launch Chrome and open a context (with the saved storageState when there
 * is one). Playwright's own signal handlers are off: on SIGINT, SIGTERM or
 * SIGHUP the runner's handler closes the browser itself, after it has
 * removed the test container.
 */
export async function launchDriver(options: DriverOptions): Promise<BrowserDriver> {
  const browser = await chromium.launch({
    channel: 'chrome',
    headless: true,
    env: minimalChildEnv(process.env),
    args: ['--disable-dev-shm-usage'],
    handleSIGINT: false,
    handleSIGTERM: false,
    handleSIGHUP: false,
  })
  try {
    let storageState: BrowserContextOptions['storageState']
    if (options.storage.exists()) {
      const parsed = JSON.parse(options.storage.load()) as { cookies?: { name: string; value: string }[] }
      for (const cookie of parsed.cookies ?? []) if (cookie.name === 'd' || cookie.name === 'd-s') options.redactor.addSecret(cookie.value)
      storageState = parsed as BrowserContextOptions['storageState']
    }
    const context = await browser.newContext({
      userAgent: desktopUserAgent(browser.version()),
      viewport: { width: 1440, height: 900 },
      locale: 'en-US',
      storageState,
    })
    const page = await context.newPage()
    return new PlaywrightDriver(options, browser, context, page)
  } catch (err) {
    await browser.close().catch(() => undefined)
    throw err
  }
}
