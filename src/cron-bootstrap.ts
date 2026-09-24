/**
 * cron-bootstrap.ts — The server's ONE filesystem write to the crontable.
 *
 * I/O module: it owns the single filesystem write the server ever makes to the
 * crontable. It creates the file — containing exactly the template header —
 * only when the file does not already exist, using exclusive-create semantics
 * (`{ flag: 'wx' }`). It NEVER write-then-renames, NEVER mkdir's a missing
 * parent directory, and NEVER logs (it returns an outcome; callers own log
 * level and wording).
 *
 * INVARIANT: this create is the server's ONLY write to the crontable, ever.
 * The server never rewrites, reorders, normalizes, or prunes crontable content.
 * A pre-existing file (any content, from a human or another bot) is left
 * untouched byte-for-byte; the losing side of a create race swallows EEXIST.
 *
 * The line format documented in the template header below is the format the
 * pure parser in ./crontable.ts accepts; keep the two in agreement.
 *
 * SPDX-License-Identifier: MIT
 */

import { writeFileSync } from 'fs'

// ---------------------------------------------------------------------------
// Template header
// ---------------------------------------------------------------------------

/**
 * The `#`-comment block written verbatim into a freshly created crontable.
 * Written so a bot (or human) reading the file cold can self-schedule from the
 * header alone. Exported as a named constant so discoverability / README-
 * consistency tests can anchor on it. Ends with a trailing newline so the
 * created file is a well-formed text file. Contains zero data lines, so feeding
 * it to parseCrontable yields zero schedules and zero parse errors.
 */
export const CRONTABLE_TEMPLATE_HEADER = `# CSCB crontable — scheduled prompts for the Slack channel bots.
#
# One schedule per line. Fields are positional and whitespace-delimited:
#
#   <min> <hour> <dom> <mon> <dow> <prompt-path> [<persona>[,<persona>...]]
#
#   tokens 1-5 : a standard 5-field cron expression (minute hour day-of-month
#                month day-of-week).
#   token 6    : path to the prompt file to run. It must contain NO spaces — a
#                line with more than 7 whitespace-delimited tokens is a parse
#                error (a path with spaces is unrepresentable). The prompt
#                file's content is capped at 32KB (enforced when the job fires).
#   token 7    : OPTIONAL comma-separated list of personas to target, each
#                written as the persona's name or its key. Naming a persona
#                twice (by name, by key, or both) delivers to it once. A name
#                containing whitespace or a comma cannot be written here —
#                write that persona's key instead. A bot can target itself
#                with the key in its CSCB_PERSONA environment variable. A
#                target that names no persona is logged unknown-persona.
#                Omit the token entirely to target ALL bots — that omission IS
#                the all-bots form. All-bots fan-out is not delivered yet: such
#                a line is logged fanout-deferred each time it fires. There is
#                NO all-bots wildcard: a literal '*' in the target position is
#                a parse error, not "all personas".
#
# Lines beginning with '#' and blank lines are ignored. A malformed line is
# skipped on its own; sibling lines still schedule.
#
# Example (every day at 09:00, run grooming-tick.md, target two personas):
#   0 9 * * * /home/horde/prompts/grooming-tick.md planner,reviewer
#
# Example (every hour on the hour, run standup.md, target all bots):
#   0 * * * * /home/horde/prompts/standup.md
`

// ---------------------------------------------------------------------------
// Outcome type
// ---------------------------------------------------------------------------

/**
 * Discriminated result of ensureCrontableExists. The caller branches on
 * `outcome`; on 'failed', `cause` carries a human-readable message for logging.
 */
export type CrontableBootstrapOutcome =
  /** The file did not exist and was created with the template header. */
  | { outcome: 'created' }
  /** The file already existed (EEXIST swallowed); left untouched. */
  | { outcome: 'already-exists' }
  /** A non-EEXIST error was caught; never thrown out, never process.exit. */
  | { outcome: 'failed'; cause: string }

// ---------------------------------------------------------------------------
// ensureCrontableExists
// ---------------------------------------------------------------------------

/**
 * Ensure a crontable file exists at `path`, creating it with exactly the
 * template header when absent. Exclusive-create (`{ flag: 'wx' }`): if another
 * writer wins the race the EEXIST is swallowed and the file is left untouched.
 * No parent-directory mkdir — a missing parent surfaces as a 'failed' outcome
 * like any other error. NEVER throws, NEVER calls process.exit, NEVER logs.
 */
export function ensureCrontableExists(path: string): CrontableBootstrapOutcome {
  try {
    writeFileSync(path, CRONTABLE_TEMPLATE_HEADER, { flag: 'wx' })
    return { outcome: 'created' }
  } catch (err) {
    // A human or another bot won the create race — normal, not an error.
    if (isEexist(err)) return { outcome: 'already-exists' }
    const cause = err instanceof Error ? err.message : String(err)
    return { outcome: 'failed', cause }
  }
}

// ---------------------------------------------------------------------------
// isEexist — narrow an unknown thrown value to the EEXIST case (internal)
// ---------------------------------------------------------------------------

function isEexist(err: unknown): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    (err as { code?: unknown }).code === 'EEXIST'
  )
}
