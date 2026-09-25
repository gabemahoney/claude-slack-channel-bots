/**
 * persona-diagnostics.ts — Persona diagnostic class labels and the
 * broken-persona log line (b.av2 SR-10.3).
 *
 * Every persona diagnostic line carries exactly one class label. This module
 * owns the closed set of labels and the one formatter that turns a structured
 * diagnostic into a single `[slack]` server-log line: the class, `personas[i]`,
 * the persona rendered by `renderPersonaRef` (JSON-quoted name, key beside
 * it), the JSON-quoted path when there is one, and the cause.
 *
 * The cause is supplied by the caller. It must be a single line and must
 * describe a bad token only by its key and the rule it breaks (for example
 * "bot_token must start with xoxb-"), never by its value. The formatter takes
 * no file contents and renders nothing but the fields below.
 *
 * Pure module (b.av2 SR-13.1): no module-scope side effects, no file-system,
 * environment, network or console access. Building a line never emits it;
 * emitting is the caller's job, through an injected `PersonaDiagnosticLogger`.
 * These lines never go to `startup-errors.log`, and no log file is added.
 *
 * The label set grows as later work lands (E2 Task 2 added credentials-refused
 * and Slack-unreachable, E2 Task 3 connection lost/restored, E3 Task 7 the
 * unclaimed channel and the DM drop, E5 Task 1 the per-persona start
 * line, E7 Task 2 the destination failure, E13 Task 1 the failed credentials
 * change; later Epics theirs).
 *
 * SPDX-License-Identifier: MIT
 */

import { renderPersonaRef } from './persona-identity.ts'

// ---------------------------------------------------------------------------
// Class labels (b.av2 SR-10.3)
// ---------------------------------------------------------------------------

/** The credentials file does not exist. */
export const PERSONA_CREDENTIALS_MISSING = 'persona-credentials-missing'

/** The credentials file exists but cannot be read. */
export const PERSONA_CREDENTIALS_UNREADABLE = 'persona-credentials-unreadable'

/** The credentials file was read but is not valid, or is another applied persona's file. */
export const PERSONA_CREDENTIALS_INVALID = 'persona-credentials-invalid'

/**
 * Slack refused a token: a Web API platform error (`ok: false`) other than the
 * transient ones, from `auth.test` (bot token) or the Socket Mode open (app
 * token). The persona is credentials-broken.
 */
export const PERSONA_CREDENTIALS_REFUSED = 'persona-credentials-refused'

/**
 * Slack could not be reached while validating a token; retried with backoff
 * (b.av2 SR-3.2). Logged when the cause starts and when it clears.
 */
export const PERSONA_SLACK_UNREACHABLE = 'persona-slack-unreachable'

/**
 * A persona's Socket Mode connection that was up closed without the server
 * closing it; the server reopens it (b.av2 SR-3.3). Logged once per outage,
 * when the connection drops, not on each reopen attempt.
 */
export const PERSONA_CONNECTION_LOST = 'persona-connection-lost'

/** A lost persona connection is open again. Logged once, when the reopen succeeds. */
export const PERSONA_CONNECTION_RESTORED = 'persona-connection-restored'

/** The working directory does not exist. */
export const PERSONA_DIRECTORY_MISSING = 'persona-directory-missing'

/** The working directory is not a usable directory, or is another applied persona's. */
export const PERSONA_DIRECTORY_UNUSABLE = 'persona-directory-unusable'

/**
 * A message arrived in a channel that no applied persona lists (b.av2 SR-4.2,
 * SR-10.3). Logged by each receiving persona; the cause names the channel.
 * Not logged when another applied persona lists the channel.
 */
export const UNCLAIMED_CHANNEL = 'unclaimed-channel'

/**
 * A direct message reached a persona whose DMs switch (`dm.enabled`) is off,
 * and was dropped (b.av2 SR-4.3). The cause names the conversation, the ts and
 * `dm.enabled`, never the message text.
 */
export const PERSONA_DM_DROPPED = 'persona-dm-dropped'

/**
 * A persona's bring-up is starting (b.av2 SR-10.3): one line per applied
 * persona at start, naming the persona and its key, before any line about
 * the persona's bring-up outcome.
 */
export const PERSONA_START = 'persona-start'

/**
 * A post to a persona's destination (its `permission_prompts` channel, or its
 * DM with `dm.contact`) failed: the open (`conversations.open`) or the post
 * (`chat.postMessage`) was refused or did not go through (b.av2 SR-7.1). The
 * persona's prompts and notices are held and retried with backoff. Logged
 * once when the episode starts, naming the destination, the failed step and
 * the Slack error code (and `im:write` for `missing_scope` on the open), and
 * once when it clears.
 */
export const PERSONA_DESTINATION_FAILED = 'persona-destination-failed'

/**
 * A confirmed change to a persona's credentials file cannot be used (b.av2
 * SR-8.6 credentials row, SR-10.3): the new file is missing, unreadable,
 * locally invalid or another applied persona's credentials file, or Slack
 * refused a token in it. The old connection (or the held content of a
 * persona that is retrying) stays in use and the change stays pending
 * (SR-8.3). Built with `formatCredentialsChangeFailed`.
 */
export const PERSONA_CREDENTIALS_CHANGE_FAILED = 'persona-credentials-change-failed'

/** Every persona diagnostic class label, in a fixed order. */
export const PERSONA_DIAGNOSTIC_CLASSES = [
  PERSONA_START,
  PERSONA_CREDENTIALS_MISSING,
  PERSONA_CREDENTIALS_UNREADABLE,
  PERSONA_CREDENTIALS_INVALID,
  PERSONA_CREDENTIALS_REFUSED,
  PERSONA_SLACK_UNREACHABLE,
  PERSONA_CONNECTION_LOST,
  PERSONA_CONNECTION_RESTORED,
  PERSONA_DIRECTORY_MISSING,
  PERSONA_DIRECTORY_UNUSABLE,
  UNCLAIMED_CHANNEL,
  PERSONA_DM_DROPPED,
  PERSONA_DESTINATION_FAILED,
  PERSONA_CREDENTIALS_CHANGE_FAILED,
] as const

/** A persona diagnostic class label (closed set). */
export type PersonaDiagnosticClass = (typeof PERSONA_DIAGNOSTIC_CLASSES)[number]

// ---------------------------------------------------------------------------
// Diagnostic shape and formatter
// ---------------------------------------------------------------------------

/** Prefix shared by every server-log line. */
const SERVER_LOG_PREFIX = '[slack]'

/** A structured persona diagnostic, before formatting. */
export interface PersonaDiagnostic {
  class: PersonaDiagnosticClass
  /** Persona name as configured; rendered JSON-quoted. */
  name: string
  /** Persona key (b.av2 SR-2.1). */
  key: string
  /** Position of the persona's entry in the config file's `personas` array. */
  index: number
  /** The file or directory the diagnostic is about, when there is one. */
  path?: string
  /** Single-line cause. Names a bad token's key and rule, never its value. */
  cause: string
}

/** Receives a formatted diagnostic line, e.g. `console.error`. */
export type PersonaDiagnosticLogger = (line: string) => void

/**
 * Format a persona diagnostic as one server-log line (b.av2 SR-10.3):
 *
 *   `[slack] <class>: personas[<i>] "<name>" (key=<key>) path="<path>": <cause>`
 *
 * `path="…"` is omitted when no path is given. The name and path are
 * JSON-quoted, so quotes, spaces, non-ASCII and control characters in them
 * stay on one line. The cause is written unquoted, with each control
 * character and U+2028/U+2029 replaced by its escape (`escapeCause`), so a
 * cause can never split the line or forge another. Pure: returns the line,
 * emits nothing.
 */
export function formatPersonaDiagnostic(diagnostic: PersonaDiagnostic): string {
  const ref = renderPersonaRef(diagnostic.name, diagnostic.key)
  const path = diagnostic.path === undefined ? '' : ` path=${JSON.stringify(diagnostic.path)}`
  return `${SERVER_LOG_PREFIX} ${diagnostic.class}: personas[${diagnostic.index}] ${ref}${path}: ${escapeCause(diagnostic.cause)}`
}

/**
 * What a persona keeps when a confirmed credentials change cannot be used:
 * its current connection (a persona that is up), the credentials content it
 * holds and retries with (a persona that is retrying), or its
 * credentials-broken state (a persona whose current connection Slack refused
 * while the change was being tried).
 */
export type CredentialsChangeKept = 'connection' | 'content' | 'broken'

/** A confirmed credentials change that cannot be used: the persona, its credentials path, the cause and what it keeps. */
export interface CredentialsChangeFailure {
  name: string
  key: string
  index: number
  /** The persona's credentials file. */
  path: string
  /**
   * Why the new file cannot be used, as the check that failed words it: the
   * credentials check's cause (missing, unreadable, invalid, or the real-path
   * collision naming the other persona) or the Slack classifier's refused
   * cause (which token, which check, the Slack error code). Never a token
   * value, file contents or a digest.
   */
  cause: string
  kept: CredentialsChangeKept
}

/** How each kind of kept state reads in a `persona-credentials-change-failed` line. */
const CREDENTIALS_CHANGE_KEPT_TEXT: Readonly<Record<CredentialsChangeKept, string>> = {
  connection: 'the current connection stays in use',
  content: 'it keeps retrying with its current credentials',
  broken: 'it stays broken by its credentials',
}

/**
 * Format the `persona-credentials-change-failed` line (b.av2 SR-8.6, SR-10.3)
 * through `formatPersonaDiagnostic`:
 *
 *   `[slack] persona-credentials-change-failed: personas[<i>] "<name>" (key=<key>) path="<path>": the confirmed credentials change cannot be used: <cause>; <kept>, and the change stays pending`
 *
 * `<kept>` is `the current connection stays in use`, `it keeps retrying
 * with its current credentials` or `it stays broken by its credentials`.
 * Pure: returns the line, emits nothing.
 */
export function formatCredentialsChangeFailed(failure: CredentialsChangeFailure): string {
  const { name, key, index, path, cause, kept } = failure
  return formatPersonaDiagnostic({
    class: PERSONA_CREDENTIALS_CHANGE_FAILED,
    name,
    key,
    index,
    path,
    cause:
      `the confirmed credentials change cannot be used: ${cause}; ` +
      `${CREDENTIALS_CHANGE_KEPT_TEXT[kept]}, and the change stays pending`,
  })
}

/** Control characters (C0, DEL, C1) and the Unicode line/paragraph separators. */
const CAUSE_UNSAFE_CHAR_RE = /[\p{Cc}\u2028\u2029]/gu

/** Short JSON escapes for the common C0 controls; everything else uses `\uXXXX`. */
const SHORT_ESCAPES: Readonly<Record<string, string>> = {
  '\b': '\\b',
  '\t': '\\t',
  '\n': '\\n',
  '\f': '\\f',
  '\r': '\\r',
}

/**
 * Replace each control character and U+2028/U+2029 in a cause with its JSON
 * escape (`\n`, `\u001b`, `\u2028`, …). Printable text, including non-ASCII,
 * is left unchanged. Explicit rather than `JSON.stringify`, which leaves DEL,
 * C1 controls and U+2028/U+2029 unescaped. Also keeps a reload line (the
 * pending-change preview in `reload.ts`) on one line.
 */
export function escapeCause(cause: string): string {
  return cause.replace(
    CAUSE_UNSAFE_CHAR_RE,
    ch => SHORT_ESCAPES[ch] ?? `\\u${ch.charCodeAt(0).toString(16).padStart(4, '0')}`,
  )
}

// ---------------------------------------------------------------------------
// Check failures
// ---------------------------------------------------------------------------

/** A failed persona check: the diagnostic's class, path and cause, plus its formatted line. */
export interface PersonaCheckFailure<C extends PersonaDiagnosticClass = PersonaDiagnosticClass> {
  ok: false
  class: C
  path?: string
  cause: string
  /** The formatted diagnostic line (`formatPersonaDiagnostic`). */
  line: string
}

/**
 * Build a check failure from a diagnostic, formatting its line. When `log` is
 * given the line is emitted through it exactly once; otherwise nothing is
 * emitted and the line is only returned.
 */
export function personaCheckFailure<C extends PersonaDiagnosticClass>(
  diagnostic: PersonaDiagnostic & { class: C },
  log?: PersonaDiagnosticLogger,
): PersonaCheckFailure<C> {
  const line = formatPersonaDiagnostic(diagnostic)
  log?.(line)
  const failure: PersonaCheckFailure<C> = { ok: false, class: diagnostic.class, cause: diagnostic.cause, line }
  if (diagnostic.path !== undefined) failure.path = diagnostic.path
  return failure
}
