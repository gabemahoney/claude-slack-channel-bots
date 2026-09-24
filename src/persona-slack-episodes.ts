/**
 * persona-slack-episodes.ts — Cause-start / cause-clear logging latch for a
 * persona's Slack validation outcomes (b.av2 SR-10.3).
 *
 * A retry is logged when its cause starts and when it clears, not on every
 * attempt. An episode is a run of outcomes of one class, Slack-unreachable
 * or credentials refused; a tracker has at most one open episode:
 *
 * - Slack-unreachable: nothing if an unreachable episode is open, even when
 *   the reason changes between attempts. Otherwise close an open refused
 *   episode (its cleared line), open an unreachable episode and emit one
 *   `persona-slack-unreachable` start line.
 * - Refused: nothing if a refused episode is open. Otherwise close an open
 *   unreachable episode (its cleared line: Slack answered), open a refused
 *   episode and emit one `persona-credentials-refused` line naming the key,
 *   the check and the Slack error code.
 * - Up: close an open episode with one cleared line carrying that episode's
 *   class label and cause text starting `cleared:`; nothing if none is open.
 *
 * Lines are built with `formatPersonaDiagnostic` (the persona's JSON-quoted
 * name with its key, `personas[i]`, the credentials file path, the cause) from
 * the outcome's own fields only, never error text. Each call returns the
 * lines it produced; with an injected logger it also emits each exactly once.
 * The module never writes to `console`, `logging.ts` or `startup-errors.log`.
 *
 * No module-scope state and no timers: each tracker holds only its own open
 * episode, so trackers for two personas are independent. The connection
 * manager (E2 Task 3) drives it; E5 reuses the convention for directory retries.
 *
 * SPDX-License-Identifier: MIT
 */

import {
  formatPersonaDiagnostic,
  type PersonaDiagnosticClass,
  type PersonaDiagnosticLogger,
} from './persona-diagnostics.ts'
import {
  SLACK_CHECK_DESCRIPTION,
  type PersonaTokenKey,
  type SlackCredentialsRefusedOutcome,
  type SlackUnreachableOutcome,
  type SlackValidationCheck,
} from './persona-slack-validation.ts'

/** The persona a tracker reports on. */
export interface SlackEpisodeTrackerOptions {
  /** Persona name as configured; rendered JSON-quoted. */
  name: string
  /** Persona key (b.av2 SR-2.1). */
  key: string
  /** Position of the persona's entry in the config file's `personas` array. */
  index: number
  /** The persona's credentials file path; every line carries it (b.av2 SR-10.3). */
  path: string
  /** Receives each line as it is produced; omitted means lines are only returned. */
  log?: PersonaDiagnosticLogger
}

/** An outcome the tracker accepts: a validation failure, or anything marked up. */
export type SlackEpisodeInput = SlackUnreachableOutcome | SlackCredentialsRefusedOutcome | { kind: 'up' }

/** The class of the open episode, or `null` when none is open. */
export type SlackEpisodeState = SlackUnreachableOutcome['class'] | SlackCredentialsRefusedOutcome['class'] | null

/** What a tracker keeps of the outcome that opened its episode. */
type OpenEpisode =
  | { kind: 'slack-unreachable'; class: SlackUnreachableOutcome['class']; key: PersonaTokenKey; check: SlackValidationCheck }
  | {
    kind: 'credentials-refused'
    class: SlackCredentialsRefusedOutcome['class']
    key: PersonaTokenKey
    check: SlackValidationCheck
    slackError: string
  }

/** One persona's episode latch. */
export interface SlackEpisodeTracker {
  /** Record an outcome; return the lines it produced, in order (zero to two). */
  record(outcome: SlackEpisodeInput): string[]
  /** The open episode's class label, or `null`. */
  readonly open: SlackEpisodeState
}

/** Create an episode tracker for one persona. */
export function createSlackEpisodeTracker(options: SlackEpisodeTrackerOptions): SlackEpisodeTracker {
  const { name, key, index, path, log } = options
  /** The open episode: only the fields its cleared line needs, copied from the opening outcome. */
  let open: OpenEpisode | null = null

  const line = (cls: PersonaDiagnosticClass, cause: string): string => {
    const text = formatPersonaDiagnostic({ class: cls, name, key, index, path, cause })
    log?.(text)
    return text
  }

  const close = (lines: string[]): void => {
    if (open === null) return
    const check = SLACK_CHECK_DESCRIPTION[open.check]
    const cause = open.kind === 'slack-unreachable'
      ? `cleared: Slack answered after being unreachable checking ${open.key} via ${check}`
      : `cleared: ${open.key} no longer refused by ${check} (was Slack error ${open.slackError})`
    lines.push(line(open.class, cause))
    open = null
  }

  return {
    record(outcome: SlackEpisodeInput): string[] {
      const lines: string[] = []
      if (outcome.kind === 'up') {
        close(lines)
        return lines
      }
      if (open !== null && open.kind === outcome.kind) return lines
      close(lines)
      open = outcome.kind === 'slack-unreachable'
        ? { kind: outcome.kind, class: outcome.class, key: outcome.key, check: outcome.check }
        : { kind: outcome.kind, class: outcome.class, key: outcome.key, check: outcome.check, slackError: outcome.slackError }
      lines.push(line(outcome.class, outcome.cause))
      return lines
    },
    get open(): SlackEpisodeState {
      return open === null ? null : open.class
    },
  }
}
