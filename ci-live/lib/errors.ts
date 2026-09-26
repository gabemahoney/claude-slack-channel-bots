/**
 * errors.ts — describing a thrown value for a log line without leaking, and
 * the runner's exit codes.
 *
 * Browser and network errors can quote a URL (an OAuth redirect with a code
 * in its query) or page text. The description keeps the error's name and the
 * first line of its message, drops every URL's query and fragment, and the
 * run log's redactor then masks token-shaped text and known secrets.
 */

const URL_QUERY_RE = /(https?:\/\/[^\s?#"'<>]+)[?#][^\s"'<>]*/g
const MAX_DESCRIPTION = 300

export function describeError(err: unknown): string {
  if (err instanceof Error) {
    const first = (err.message.split('\n')[0] ?? '').replace(URL_QUERY_RE, '$1?<query>')
    const text = `${err.name}: ${first}`
    return text.length > MAX_DESCRIPTION ? `${text.slice(0, MAX_DESCRIPTION)}…` : text
  }
  return typeof err === 'string' ? describeError(new Error(err)) : 'non-Error thrown value'
}

// ---------------------------------------------------------------------------
// Exit codes
// ---------------------------------------------------------------------------

export const EXIT_PASS = 0
export const EXIT_FAIL = 1
/** The run can't be made (a missing secret, docker down, a refused token …): the reason names the fix. */
export const EXIT_NOT_RUNNABLE = 2
