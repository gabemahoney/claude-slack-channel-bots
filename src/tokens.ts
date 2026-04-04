/**
 * Token loading — reads Slack credentials from environment variables.
 *
 * Extracted into a separate module so it can be imported and unit-tested
 * without triggering server.ts side effects (socket connections, HTTP server).
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

// ---------------------------------------------------------------------------
// Token loading
// ---------------------------------------------------------------------------

export function loadTokens(): { botToken: string; appToken: string } {
  if (isDryRun()) {
    return { botToken: 'xoxb-dry-run', appToken: 'xapp-dry-run' }
  }

  const botToken = process.env['SLACK_BOT_TOKEN'] ?? ''
  const appToken = process.env['SLACK_APP_TOKEN'] ?? ''

  if (!botToken.startsWith('xoxb-')) {
    console.error('[slack] SLACK_BOT_TOKEN is missing or does not start with xoxb-')
    process.exit(1)
  }
  if (!appToken.startsWith('xapp-')) {
    console.error('[slack] SLACK_APP_TOKEN is missing or does not start with xapp-')
    process.exit(1)
  }

  return { botToken, appToken }
}
