/**
 * browser-types.ts — what the runner needs from the browser, as interfaces.
 *
 * The Playwright implementation lives in `ci-live/browser/` (the only code
 * that imports `playwright-core`). Everything else, and every unit test,
 * depends only on these interfaces, so the root typecheck and test suite
 * never need ci-live's own dependencies installed.
 */

import type { SlackParams, SlackResponse } from './slack-api.ts'

/**
 * The test human's own Slack session API: `<workspace>/api/<method>` called
 * with the web client's session token and cookies. Posting through it is a
 * genuine user message.
 */
export interface HumanApi {
  call(method: string, params?: SlackParams): Promise<SlackResponse>
}

/** Where the browser flows go: real Slack, or the dry run's local fixture pages. */
export interface SlackUrls {
  /** The workspace's email + password sign-in page. */
  signIn(domain: string): string
  /** The workspace's email sign-in page, where Slack emails a code (an account with no password). */
  codeSignIn(domain: string): string
  /** The workspace's Web API base for the human session (ends with `/api/`). */
  humanApiBase(domain: string): string
  /** A page on the workspace's client domain where the web client stores its session config. */
  clientHome(domain: string): string
  /** The app's install page. */
  installApp(appId: string): string
  /** The app's OAuth & Permissions page (holds the Bot User OAuth Token after install). */
  oauthPage(appId: string): string
  /** The app's Basic Information page (holds App-Level Tokens). */
  basicInfoPage(appId: string): string
  /** The web client at a conversation. */
  conversation(teamId: string, conversationId: string): string
  /** The list of the signed-in user's apps (`https://api.slack.com/apps`). */
  appsList(): string
}

export type SignInOutcome = 'signed-in' | 'needs-code'

/**
 * A browser flow step failed (thrown by the flows in `ci-live/browser/`).
 * The message names the step, never page content. Here, not beside the
 * flows, so code that catches it needs no playwright-core.
 */
export class FlowError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'FlowError'
  }
}

/** The browser, as the provisioning stages and the checks use it. */
export interface BrowserDriver {
  /** Sign the test human in (storageState first, then email + password). */
  ensureSignedIn(): Promise<SignInOutcome>
  /**
   * Finish a sign-in that asked for an emailed code (read from the mailbox,
   * or typed at the interactive `login` command). Throws a `FlowError` when
   * the code prompt fails.
   */
  submitSignInCode(code: string): Promise<SignInOutcome>
  /** The human session API (the session token is held in memory only). */
  humanApi(): Promise<HumanApi>
  /** Install (or re-install) the app as the test human and return its bot token. */
  installApp(appId: string): Promise<string>
  /** Generate an app-level token named `name` with `connections:write`; return its value. */
  generateAppToken(appId: string, name: string): Promise<string>
  /** Revoke the app-level token named `name` on the app. */
  revokeAppToken(appId: string, name: string): Promise<void>
  /** Click the button named `buttonName` on the message `ts` in the web client. */
  clickMessageButton(teamId: string, conversationId: string, ts: string, buttonName: string): Promise<void>
  /** Save storageState (mode 600) through the secret store. */
  saveState(): Promise<void>
  close(): Promise<void>
}

/** One row of the apps list page (api.slack.com/apps), as scraped. */
export interface ListedApp {
  /** The app ID from the row's link (`A…`). */
  id: string
  /** The link's text: the app's name (control characters dropped, capped). */
  name: string
  /**
   * The row's cells (its workspace column among them), each cleaned and
   * capped, joined by a tab (`ROW_CELL_SEPARATOR`), or `null` when the link
   * is in no row.
   */
  rowText: string | null
}

/** A browser that can read the apps list page (the `apps` command and the apps stage's unfinished-create check). */
export interface AppListingBrowser {
  /** Every app the signed-in user sees at api.slack.com/apps. Throws a `FlowError` when the page shows no list. */
  listApps(): Promise<ListedApp[]>
}

/** The one browser's open contexts and pages (the memory watchdog reads them). */
export interface BrowserStats {
  contexts: number
  pages: number
  /** Pages on about:blank (idle between flows). */
  idlePages: number
}

export type { SlackParams, SlackResponse }
