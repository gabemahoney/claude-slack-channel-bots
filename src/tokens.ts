/**
 * Dry-run detection (`SLACK_DRY_RUN`).
 *
 * The server reads no Slack token from the environment: each persona's
 * tokens come only from its credentials file (b.av2 SR-1.4, SR-10.2). This
 * module keeps its name so its importers need no change.
 *
 * Side-effect free: importing it reads nothing; `isDryRun` reads the variable
 * at call time.
 *
 * SPDX-License-Identifier: MIT
 */

// ---------------------------------------------------------------------------
// Dry-run detection
// ---------------------------------------------------------------------------

export function isDryRun(): boolean {
  const val = (process.env['SLACK_DRY_RUN'] ?? '').toLowerCase()
  return val === '1' || val === 'true' || val === 'yes'
}
