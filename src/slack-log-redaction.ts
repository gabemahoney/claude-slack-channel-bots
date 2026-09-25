/**
 * slack-log-redaction.ts — The URL-like and token-like text redactor shared by
 * the Web API clients' library logger and the permission trail.
 *
 * `redactSlackLogText` replaces every URL-like, then every token-like,
 * substring of a text with a fixed placeholder. `persona-slack-clients.ts`
 * uses it in `redactingSlackLogger` (and re-exports it); the permission click
 * handler uses it on the `raw_error_message` it records in the permission
 * trail (SR-V-2.7), so a thrown message holding a short-lived upload URL or a
 * token never reaches that file. It lives here, not in
 * `persona-slack-clients.ts`, so a caller can redact without importing the
 * Slack client libraries.
 *
 * Pure module: no imports, no module-scope state, no environment or file
 * access, nothing runs at import.
 *
 * SPDX-License-Identifier: MIT
 */

/** What replaces a URL-like substring in a redacted line. */
export const REDACTED_URL_PLACEHOLDER = '<redacted-url>'

/** What replaces a token-like substring in a redacted line. */
export const REDACTED_TOKEN_PLACEHOLDER = '<redacted-token>'

/**
 * A URL-like substring: an `http`, `https`, `ws` or `wss` scheme (any case),
 * `://` and everything up to whitespace, a quote or an angle bracket, less
 * any trailing punctuation (so "(url: <url>, retry-after: 30)" keeps its
 * comma). Unanchored and with no boundary before the scheme.
 */
const URL_LIKE_RE = /(?:https?|wss?):\/\/[^\s"'`<>]*[^\s"'`<>.,;:!?)\]}]/gi

/**
 * A token-like substring: `xox` plus one lowercase letter and `-`, or
 * `xapp-`, and everything after it up to whitespace, a quote or an angle
 * bracket. Deliberately wide (no boundary before the prefix, nothing
 * required after the dash): redacting an ordinary word costs nothing,
 * missing a token leaks it.
 */
const TOKEN_LIKE_RE = /(?:xox[a-z]|xapp)-[^\s"'`<>]*/g

/** `text` with every URL-like, then every token-like, substring replaced by its placeholder. */
export function redactSlackLogText(text: string): string {
  return text.replace(URL_LIKE_RE, REDACTED_URL_PLACEHOLDER).replace(TOKEN_LIKE_RE, REDACTED_TOKEN_PLACEHOLDER)
}
