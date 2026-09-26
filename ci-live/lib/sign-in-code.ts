/**
 * sign-in-code.ts — answering Slack's emailed sign-in code from the test
 * mailbox, before the runner gives up on a sign-in (exit 2, "run login").
 *
 * When Slack asks the test human for an emailed code (a new device), the
 * runner polls the mailbox for up to 2 minutes for a Slack code email
 * received after the sign-in attempt started and sent to the test email,
 * registers the code with the redactor, types it into the page and goes on.
 * It answers `needs-code` (the caller then stops as before, with "run
 * login") when there is no mailbox, the mailbox is unusable, there is no
 * test email to match the mail against, no code arrives in time, Slack
 * accepts none of the codes, or the code prompt fails (a flow error).
 *
 * The log says only where the code came from or why none did; never the
 * code, the mailbox's token or password. Pure: the mailbox, the page, the
 * clock and the log are injected.
 */

import { FlowError, type SignInOutcome } from './browser-types.ts'
import { describeError } from './errors.ts'
import { bareCode, waitForSlackSignInCode, type MailReader } from './mailbox.ts'
import { MINUTE, SECOND, type Clock } from './wait.ts'

/** How long the runner waits for Slack's email. */
export const SIGN_IN_CODE_TIMEOUT_MS = 2 * MINUTE
/** How often it looks (mail.tm allows 8 requests a second; this is far below). */
export const SIGN_IN_CODE_POLL_MS = 5 * SECOND
/** Codes typed at most, per sign-in (a refused code sends it back to the mailbox for a newer one). */
export const MAX_CODE_SUBMISSIONS = 3
/**
 * Mail received this long before the attempt started still counts: the
 * tolerance for this host's clock against the mail server's. The attempt
 * start is taken before the password is submitted, so Slack's email comes
 * later still.
 */
export const MAIL_CLOCK_SKEW_MS = 5 * SECOND

export interface MailboxSignInDeps {
  /** The test mailbox, or `null` when none is configured. May throw when mailbox.json is unusable. */
  openMailbox: () => MailReader | null
  /** Type the code into the page's code prompt; the outcome after Slack answers. Throws a `FlowError` when the prompt fails. */
  submitCode: (code: string) => Promise<SignInOutcome>
  /** The test human's email (live.json): only Slack mail sent to it counts. Empty: none does. */
  testEmail: string
  /** Registers a code before anything can log it. */
  addSecret: (value: string) => void
  clock: Clock
  log: { info(message: string): void; detail(message: string): void }
  /** When the sign-in attempt started, on `clock` (before the password was submitted). */
  attemptStartedAt: number
  timeoutMs?: number
  pollMs?: number
}

function minutes(ms: number): string {
  const m = ms / MINUTE
  return Number.isInteger(m) ? `${m} min` : `${Math.round(ms / SECOND)} s`
}

/**
 * Answer the code prompt from the mailbox. `signed-in` when Slack accepted a
 * code; `needs-code` otherwise (the caller falls back to the operator's
 * `login`), a flow error on the code prompt included. Throws only what
 * `submitCode` throws besides a `FlowError` (such as a signed-in page with
 * no session: not runnable).
 */
export async function answerSignInCodeFromMailbox(d: MailboxSignInDeps): Promise<SignInOutcome> {
  const timeoutMs = d.timeoutMs ?? SIGN_IN_CODE_TIMEOUT_MS
  let mailbox: MailReader | null
  try {
    mailbox = d.openMailbox()
  } catch (err) {
    d.log.info(`sign-in code: the mailbox is unusable (${describeError(err)})`)
    return 'needs-code'
  }
  if (!mailbox) {
    d.log.info('sign-in code: no mailbox configured (mailbox.json)')
    return 'needs-code'
  }
  if (d.testEmail.trim() === '') {
    d.log.info("sign-in code: no test email to match Slack's mail against (live.json test_email)")
    return 'needs-code'
  }
  d.log.info(`sign-in code: Slack emailed a code; waiting up to ${minutes(timeoutMs)} for it in the mailbox`)
  const deadline = d.clock.now() + timeoutMs
  const exclude = new Set<string>()
  let typed = 0
  let lastTransient = ''
  while (typed < MAX_CODE_SUBMISSIONS) {
    const left = deadline - d.clock.now()
    if (left <= 0) break
    let found
    try {
      found = await waitForSlackSignInCode(mailbox, {
        sinceMs: d.attemptStartedAt - MAIL_CLOCK_SKEW_MS,
        testEmail: d.testEmail,
        timeoutMs: left,
        pollMs: d.pollMs ?? SIGN_IN_CODE_POLL_MS,
        clock: d.clock,
        exclude,
        onTransientError: (err) => {
          const why = describeError(err)
          if (why !== lastTransient) d.log.detail(`sign-in code: a mailbox poll failed (${why}); polling on`)
          lastTransient = why
        },
      })
    } catch (err) {
      d.log.info(`sign-in code: the mailbox is unusable (${describeError(err)})`)
      return 'needs-code'
    }
    if (!found) break
    // Registered before anything else happens with it: no log line can show it from here on.
    d.addSecret(found.code)
    d.addSecret(bareCode(found.code))
    d.log.info('sign-in code: read from the mailbox')
    typed += 1
    let outcome: SignInOutcome
    try {
      outcome = await d.submitCode(found.code)
    } catch (err) {
      if (!(err instanceof FlowError)) throw err
      // A flow error names the step, never the code (which the redactor holds by now anyway).
      d.log.info(`sign-in code: the code prompt failed (${describeError(err)})`)
      return 'needs-code'
    }
    if (outcome === 'signed-in') return 'signed-in'
    d.log.info('sign-in code: Slack did not accept the code from the mailbox; looking for a newer one')
  }
  d.log.info(typed === 0 ? `sign-in code: not received within ${minutes(timeoutMs)}` : `sign-in code: Slack accepted no code from the mailbox within ${minutes(timeoutMs)}`)
  return 'needs-code'
}
