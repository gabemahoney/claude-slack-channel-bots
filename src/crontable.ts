/**
 * crontable.ts — Pure parser for CSCB crontable text.
 *
 * Pure module: text in, records out. No file reading, no logging, no
 * scheduling, no timers, no import-time side effects, and no imports from
 * server/session-manager. Cron-expression validity is delegated to `croner`,
 * whose `Cron` constructor throws synchronously on an invalid 5-field pattern;
 * the constructed object is never started (no callback is supplied) and is
 * stopped immediately, so validation creates no live schedule.
 *
 * Line format (positional, space-delimited, split on whitespace runs):
 *   <min> <hour> <dom> <mon> <dow> <prompt-path> [<channel-id>[,<channel-id>...]]
 *   tokens 1-5 : standard 5-field cron expression (validated via croner)
 *   token 6    : prompt-file path, kept VERBATIM (no expansion/resolution)
 *   token 7    : optional comma-separated Slack channel-ID list
 *                (a literal `*` is a PARSE ERROR — omission is the all-bots form)
 *
 * `#` comment lines and blank/whitespace-only lines are skipped silently.
 * Every other bad line yields exactly one structured parse-error record while
 * sibling lines still parse. The parse function NEVER throws for content reasons.
 *
 * SPDX-License-Identifier: MIT
 */

import { Cron } from 'croner'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Closed union of parse-error reason classes. One distinct class per bad-line
 * kind so downstream triage (E3 parse-error logging) can distinguish them.
 */
export type CronParseErrorReason =
  /** tokens 1-5 did not form a valid 5-field cron expression (croner rejected). */
  | 'invalid-expression'
  /** fewer than 6 tokens: no prompt-path token present. */
  | 'missing-prompt-path'
  /** more than 7 tokens: unrepresentable path-with-spaces / too many tokens. */
  | 'path-with-spaces'
  /** token 7 present but malformed (empty elements: leading/trailing/double comma). */
  | 'malformed-channel-list'
  /** token 7 is a literal `*` — wildcard channel list explicitly rejected. */
  | 'wildcard-channel-list'

/** Channel targeting for a schedule: every bot, or an explicit ID list. */
export type CronChannels =
  | { kind: 'all-bots' }
  | { kind: 'explicit'; channelIds: string[] }

/** A successfully parsed crontable line. */
export interface CronSchedule {
  /** Stable identity: `cscb-cron:<prompt-file-basename-without-extension>`. */
  identity: string
  /** The 5-field cron expression in library-usable form (joined tokens 1-5). */
  expression: string
  /** The prompt-file path, kept verbatim from token 6 (no expansion). */
  promptPath: string
  /** Target channels: all-bots marker or explicit channel-ID list. */
  channels: CronChannels
  /** The raw line text, verbatim (downstream at-most-once keying depends on it). */
  rawLine: string
}

/** A single bad line that could not be parsed. */
export interface CronParseError {
  /** 1-based line number in the source text. */
  lineNumber: number
  /** The raw line text, verbatim. */
  rawLine: string
  /** Which bad-line class this line fell into. */
  reason: CronParseErrorReason
}

/** Result of parsing crontable text. */
export interface CronParseResult {
  schedules: CronSchedule[]
  errors: CronParseError[]
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Number of leading cron fields in the positional line format. */
const CRON_FIELD_COUNT = 5
/** Minimum token count for a data line: 5 cron fields + prompt path. */
const MIN_TOKENS = CRON_FIELD_COUNT + 1
/** Maximum token count: 5 cron fields + prompt path + channel list. */
const MAX_TOKENS = CRON_FIELD_COUNT + 2
/** Identity namespace prefix (PD-1). */
const IDENTITY_PREFIX = 'cscb-cron:'

// ---------------------------------------------------------------------------
// parseCrontable
// ---------------------------------------------------------------------------

/**
 * Parse crontable text into schedule records plus structured parse-error
 * records. Pure: never throws for content reasons; comment/blank lines are
 * skipped silently; every other bad line yields exactly one error record while
 * sibling lines still parse.
 */
export function parseCrontable(text: string): CronParseResult {
  const schedules: CronSchedule[] = []
  const errors: CronParseError[] = []

  const lines = text.split('\n')
  for (let i = 0; i < lines.length; i++) {
    const rawLine = lines[i]!
    const lineNumber = i + 1
    const trimmed = rawLine.trim()

    // Blank/whitespace-only and comment lines are skipped silently.
    if (trimmed === '' || trimmed.startsWith('#')) continue

    const parsed = parseLine(rawLine, lineNumber)
    if (parsed.ok) schedules.push(parsed.schedule)
    else errors.push(parsed.error)
  }

  return { schedules, errors }
}

// ---------------------------------------------------------------------------
// parseLine — single-line classifier (internal)
// ---------------------------------------------------------------------------

type LineOutcome =
  | { ok: true; schedule: CronSchedule }
  | { ok: false; error: CronParseError }

function parseLine(rawLine: string, lineNumber: number): LineOutcome {
  const fail = (reason: CronParseErrorReason): LineOutcome => ({
    ok: false,
    error: { lineNumber, rawLine, reason },
  })

  // Split on whitespace runs (leading whitespace already ruled non-empty).
  const tokens = rawLine.trim().split(/\s+/)

  // Fewer than 6 tokens: no prompt path present.
  if (tokens.length < MIN_TOKENS) return fail('missing-prompt-path')
  // More than 7 tokens: a path containing spaces is unrepresentable.
  if (tokens.length > MAX_TOKENS) return fail('path-with-spaces')

  // Validate the 5-field cron expression via croner (construction throws on
  // invalid patterns; no callback means it never schedules; stop defensively).
  const expression = tokens.slice(0, CRON_FIELD_COUNT).join(' ')
  try {
    const cron = new Cron(expression)
    cron.stop()
  } catch {
    return fail('invalid-expression')
  }

  const promptPath = tokens[CRON_FIELD_COUNT]!

  // Optional channel list (token 7).
  let channels: CronChannels
  if (tokens.length === MAX_TOKENS) {
    const listToken = tokens[MAX_TOKENS - 1]!
    if (listToken === '*') return fail('wildcard-channel-list')
    const channelIds = listToken.split(',')
    // Malformed when any element is empty (leading/trailing/double comma).
    if (channelIds.some((id) => id === '')) return fail('malformed-channel-list')
    channels = { kind: 'explicit', channelIds }
  } else {
    channels = { kind: 'all-bots' }
  }

  return {
    ok: true,
    schedule: {
      identity: IDENTITY_PREFIX + basenameWithoutExtension(promptPath),
      expression,
      promptPath,
      channels,
      rawLine,
    },
  }
}

// ---------------------------------------------------------------------------
// basenameWithoutExtension — identity derivation (internal)
// ---------------------------------------------------------------------------

/**
 * Derive the basename of a path without its final extension.
 *   /a/b/grooming-tick.md → grooming-tick
 *   .env                  → .env   (leading-dot dotfile keeps its name)
 *   report                → report (no extension → basename as-is)
 *   archive.tar.gz        → archive.tar (only the final extension is dropped)
 *
 * Purity-consistent: operates on the string only; no filesystem access.
 */
function basenameWithoutExtension(path: string): string {
  // Basename: text after the last '/'. Paths are verbatim, so treat '/' as the
  // separator regardless of host (crontable paths are POSIX).
  const lastSlash = path.lastIndexOf('/')
  const basename = lastSlash === -1 ? path : path.slice(lastSlash + 1)

  // Drop the final extension, but only when the dot is interior (not a leading
  // dot, which denotes a dotfile like `.env`).
  const lastDot = basename.lastIndexOf('.')
  if (lastDot <= 0) return basename
  return basename.slice(0, lastDot)
}
