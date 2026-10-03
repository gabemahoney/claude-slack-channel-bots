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
 * `unescapeSlackControlCharacters` undoes it, for text built for Slack that
 * is written somewhere else instead (the persona teardown window's server-log
 * line and startup-errors entry, `src/persona-notifier.ts`), so the entry
 * reads as the unescaped notices' entries do.
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

/**
 * `text` with Slack's control-character escapes undone: `&lt;` → `<`,
 * `&gt;` → `>`, then `&amp;` → `&` (last, so `&amp;lt;` becomes `&lt;`, the
 * inverse of {@link escapeSlackControlCharacters}). Nothing else changes.
 */
export function unescapeSlackControlCharacters(text: string): string {
  return text.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&')
}
