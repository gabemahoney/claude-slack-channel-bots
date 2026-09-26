/**
 * slack-urls.ts — the real Slack URLs the browser flows use on a real run.
 * The dry run swaps in its local fixture pages (dry-run/stub-server.ts).
 */

import type { SlackUrls } from './browser-types.ts'

export const REAL_SLACK_URLS: SlackUrls = {
  signIn: (domain) => `https://${domain}.slack.com/sign_in_with_password`,
  humanApiBase: (domain) => `https://${domain}.slack.com/api/`,
  clientHome: () => 'https://app.slack.com/client',
  installApp: (appId) => `https://api.slack.com/apps/${appId}/install-on-team`,
  oauthPage: (appId) => `https://api.slack.com/apps/${appId}/oauth`,
  basicInfoPage: (appId) => `https://api.slack.com/apps/${appId}/general`,
  conversation: (teamId, conversationId) => `https://app.slack.com/client/${teamId}/${conversationId}`,
}
