/**
 * driver.ts — the Playwright implementation of `BrowserDriver`: installed
 * Google Chrome (`channel: 'chrome'`), headless, with a normal desktop
 * user-agent (Slack may refuse a `HeadlessChrome` one).
 *
 * Bounded, since an unbounded browser left on a live Slack tab may have
 * frozen the VM during a run: a command launches one Chrome (`ChromeHost`),
 * with one context per signed-in account (at most MAX_CONTEXTS: the test
 * human's and, when live.json configures one, the second account's) and one
 * page per context (at most MAX_PAGES), reused by every flow. A page a site
 * opens on its own (a popup) is closed at once. After each flow the page goes
 * to about:blank, so no Slack page, and above all not the web client, stays
 * live between checks. Chrome runs with a V8 heap cap and at most two
 * renderer processes (CHROME_ARGS); a page whose renderer crashes (past the
 * heap cap, say) is closed, and the next flow gets a fresh one in its place.
 * `ChromeHost.stats` gives the memory watchdog the open contexts and pages.
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

import type { AppListingBrowser, BrowserDriver, BrowserStats, HumanApi, ListedApp, SignInOutcome, SlackUrls } from '../lib/browser-types.ts'
import { minimalChildEnv } from '../lib/proc.ts'
import type { Redactor } from '../lib/redact.ts'
import { NotRunnableError } from '../lib/secrets.ts'
import { generateAppToken, revokeAppToken } from './app-token.flow.ts'
import { listApps } from './apps-list.flow.ts'
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

/** One context per signed-in account: the test human's and, when live.json configures one, the second account's. */
export const MAX_CONTEXTS = 2

/** Open pages in the one browser: each context's single page. */
export const MAX_PAGES = 2

/** Chrome's flags: each bounds memory. */
export const CHROME_ARGS: readonly string[] = [
  // /dev/shm is small in containers and pods: Chrome's shared memory goes to /tmp instead.
  '--disable-dev-shm-usage',
  // A V8 heap cap per renderer: a runaway page crashes its own tab instead of growing without bound.
  '--js-flags=--max-old-space-size=1024',
  // At most two renderer processes, however many sites the flows visit.
  '--renderer-process-limit=2',
  '--disable-extensions',
]

const IDLE_URL = 'about:blank'
const IDLE_TIMEOUT_MS = 15_000

/** A desktop Chrome user-agent for this Chrome version. */
export function desktopUserAgent(version: string): string {
  const major = /^(\d+)/.exec(version)?.[1] ?? '140'
  return `Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${major}.0.0.0 Safari/537.36`
}

/** The driver the runner holds: the checks' `BrowserDriver`, plus the apps list page. */
export type LiveBrowserDriver = BrowserDriver & AppListingBrowser

class PlaywrightDriver implements LiveBrowserDriver {
  private sessionToken: string | null = null
  private api: HumanApi | null = null
  /** The page's renderer crashed: the next flow replaces it. */
  private crashed = false
  /** The driver is opening its own replacement page (not a popup). */
  private opening = false
  /** Settles when the last flow started has ended (flows run one at a time). */
  private flowing: Promise<void> = Promise.resolve()

  constructor(
    private readonly o: DriverOptions,
    private readonly context: BrowserContext,
    private page: Page,
    private readonly onClose: () => Promise<void>,
  ) {
    context.on('page', (opened) => {
      if (opened === this.page || this.opening) return
      this.o.log.info('browser: closed a page a site opened on its own (the run keeps one page per account)')
      void opened.close().catch(() => undefined)
    })
    this.watch(page)
  }

  private watch(page: Page): void {
    page.on('crash', () => {
      this.crashed = true
      this.o.log.info('browser: the page crashed (its renderer died, as past its heap cap); the next flow gets a fresh page')
    })
  }

  /** The page, replaced first when it crashed (the old one closed before the new one opens: never two). */
  private async usablePage(): Promise<Page> {
    if (!this.crashed) return this.page
    await this.page.close().catch(() => undefined)
    this.opening = true
    try {
      this.page = await this.context.newPage()
    } finally {
      this.opening = false
    }
    this.crashed = false
    this.watch(this.page)
    return this.page
  }

  /** Leave the page on about:blank, so no Slack page stays live between flows. */
  private async idle(): Promise<void> {
    await this.page.goto(IDLE_URL, { timeout: IDLE_TIMEOUT_MS }).catch(() => undefined)
  }

  /**
   * Run a flow on the page, then idle the page, whatever the flow's outcome.
   * Flows run one at a time, in call order: the prompt guard clicks a
   * prompt's Deny while a check may be running a flow of its own on the
   * same page.
   */
  private async flow<T>(work: (page: Page) => Promise<T>): Promise<T> {
    const previous = this.flowing
    let done = (): void => {}
    this.flowing = new Promise<void>((resolve) => {
      done = resolve
    })
    await previous
    try {
      return await work(await this.usablePage())
    } finally {
      try {
        await this.idle()
      } finally {
        done()
      }
    }
  }

  private async adoptSessionToken(): Promise<boolean> {
    const token = await readSessionToken(await this.usablePage(), this.o.urls, this.o.domain)
    if (!token) return false
    this.o.redactor.addSecret(token)
    this.sessionToken = token
    this.api = contextHumanApi(this.context, this.o.urls, this.o.domain, token)
    return true
  }

  async ensureSignedIn(): Promise<SignInOutcome> {
    if (this.sessionToken) return 'signed-in'
    let outcome: SignInOutcome = 'signed-in'
    try {
      if (await this.adoptSessionToken()) return 'signed-in'
      const { email, password } = this.o.identity()
      this.o.redactor.addSecret(password)
      this.o.log.info('browser: signing the test human in (email + password)')
      outcome = await signInWithPassword(await this.usablePage(), this.o.urls, this.o.domain, email, password)
      if (outcome === 'needs-code') return 'needs-code'
      if (!(await this.adoptSessionToken())) throw new NotRunnableError('signed in, but the web client holds no session for the test workspace')
      await this.saveState()
      return 'signed-in'
    } finally {
      // Signed in (or failed): idle. A code prompt stays open for the code.
      if (outcome !== 'needs-code') await this.idle()
    }
  }

  async submitSignInCode(code: string): Promise<SignInOutcome> {
    const outcome = await submitConfirmationCode(await this.usablePage(), code)
    if (outcome !== 'signed-in') return outcome
    return this.flow(async () => {
      if (!(await this.adoptSessionToken())) throw new NotRunnableError('signed in, but the web client holds no session for the test workspace')
      await this.saveState()
      return outcome
    })
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

  installApp(appId: string): Promise<string> {
    return this.flow(async (page) => {
      const token = await installAndReadBotToken(page, this.o.urls, appId)
      this.o.redactor.addSecret(token)
      return token
    })
  }

  generateAppToken(appId: string, name: string): Promise<string> {
    return this.flow(async (page) => {
      const token = await generateAppToken(page, this.o.urls, appId, name)
      this.o.redactor.addSecret(token)
      return token
    })
  }

  revokeAppToken(appId: string, name: string): Promise<void> {
    return this.flow((page) => revokeAppToken(page, this.o.urls, appId, name))
  }

  clickMessageButton(teamId: string, conversationId: string, ts: string, buttonName: string): Promise<void> {
    return this.flow((page) => clickMessageButton(page, this.o.urls, teamId, conversationId, ts, buttonName))
  }

  listApps(): Promise<ListedApp[]> {
    return this.flow((page) => listApps(page, this.o.urls))
  }

  async saveState(): Promise<void> {
    const state = await this.context.storageState()
    for (const cookie of state.cookies) if (cookie.name === 'd' || cookie.name === 'd-s') this.o.redactor.addSecret(cookie.value)
    this.o.storage.save(`${JSON.stringify(state)}\n`)
  }

  async close(): Promise<void> {
    await this.context.close().catch(() => undefined)
    await this.onClose().catch(() => undefined)
  }
}

/**
 * The one Chrome of a command. Playwright's own signal handlers are off: on
 * SIGINT, SIGTERM or SIGHUP the runner's handler closes the browser itself,
 * after it has removed the test container (on a memory watchdog stop, at
 * once, alongside the removal).
 */
export class ChromeHost {
  private constructor(private readonly browser: Browser) {}

  static async launch(): Promise<ChromeHost> {
    const browser = await chromium.launch({
      channel: 'chrome',
      headless: true,
      env: minimalChildEnv(process.env),
      args: [...CHROME_ARGS],
      handleSIGINT: false,
      handleSIGTERM: false,
      handleSIGHUP: false,
    })
    return new ChromeHost(browser)
  }

  /** The open contexts and pages (the memory watchdog's reading). */
  stats(): BrowserStats {
    const pages = this.browser.contexts().flatMap((c) => c.pages())
    return { contexts: this.browser.contexts().length, pages: pages.length, idlePages: pages.filter((p) => p.url() === IDLE_URL).length }
  }

  /**
   * A context for one account (with its saved storageState when there is
   * one) and its single page. Refused past MAX_CONTEXTS or MAX_PAGES.
   * `onClose` runs after the driver's context has closed.
   */
  async openDriver(options: DriverOptions, onClose: () => Promise<void> = async () => undefined): Promise<LiveBrowserDriver> {
    const open = this.stats()
    if (open.contexts >= MAX_CONTEXTS || open.pages >= MAX_PAGES) {
      throw new Error(`browser: ${open.contexts} contexts and ${open.pages} pages are open; the run allows ${MAX_CONTEXTS} and ${MAX_PAGES} (one per account)`)
    }
    let storageState: BrowserContextOptions['storageState']
    if (options.storage.exists()) {
      const parsed = JSON.parse(options.storage.load()) as { cookies?: { name: string; value: string }[] }
      for (const cookie of parsed.cookies ?? []) if (cookie.name === 'd' || cookie.name === 'd-s') options.redactor.addSecret(cookie.value)
      storageState = parsed as BrowserContextOptions['storageState']
    }
    const context = await this.browser.newContext({
      userAgent: desktopUserAgent(this.browser.version()),
      viewport: { width: 1440, height: 900 },
      locale: 'en-US',
      storageState,
    })
    try {
      return new PlaywrightDriver(options, context, await context.newPage(), onClose)
    } catch (err) {
      await context.close().catch(() => undefined)
      throw err
    }
  }

  async close(): Promise<void> {
    await this.browser.close().catch(() => undefined)
  }
}

/** Launch a Chrome of its own for one account (the `login` command); closing the driver closes it. */
export async function launchDriver(options: DriverOptions): Promise<LiveBrowserDriver> {
  const host = await ChromeHost.launch()
  try {
    return await host.openDriver(options, () => host.close())
  } catch (err) {
    await host.close()
    throw err
  }
}
