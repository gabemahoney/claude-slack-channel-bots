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
 * The label set grows as later work lands (E2 Task 2: credentials-refused and
 * Slack-unreachable; E2 Task 3: connection lost/restored; later Epics theirs).
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

/** The working directory does not exist. */
export const PERSONA_DIRECTORY_MISSING = 'persona-directory-missing'

/** The working directory is not a usable directory, or is another applied persona's. */
export const PERSONA_DIRECTORY_UNUSABLE = 'persona-directory-unusable'

/** Every persona diagnostic class label, in a fixed order. */
export const PERSONA_DIAGNOSTIC_CLASSES = [
  PERSONA_CREDENTIALS_MISSING,
  PERSONA_CREDENTIALS_UNREADABLE,
  PERSONA_CREDENTIALS_INVALID,
  PERSONA_DIRECTORY_MISSING,
  PERSONA_DIRECTORY_UNUSABLE,
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
 * C1 controls and U+2028/U+2029 unescaped.
 */
function escapeCause(cause: string): string {
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
