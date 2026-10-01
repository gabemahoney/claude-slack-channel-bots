/**
 * slack-text-escape.ts — Escaping of Slack's control characters in text that
 * CSCB posts but did not write.
 *
 * `escapeSlackControlCharacters` replaces `&`, `<` and `>` with `&amp;`,
 * `&lt;` and `&gt;`, so text such as `<!channel>`, `<@U…>` or a `<…>`
 * placeholder renders as itself in a Slack message and notifies no one. The
 * lost-message notice uses it for the sender label; the `ad-config-malformed`
 * onset and the unclassified-error alert use it for agent-director's quoted
 * description.
 *
 * Pure module: no imports, no module-scope state, nothing runs at import.
 *
 * SPDX-License-Identifier: MIT
 */

/**
 * `text` with Slack's control characters escaped: `&` → `&amp;` (first, so no
 * entity is escaped twice), `<` → `&lt;`, `>` → `&gt;`. Nothing else changes.
 */
export function escapeSlackControlCharacters(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}
