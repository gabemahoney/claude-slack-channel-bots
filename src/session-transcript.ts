/** Locates a Claude transcript for exact delivery receipt matching. */
import { renderLogMessageText } from './persona-connection-errors.ts'

/** The agent-director row fields the transcript is located from (`GetResult`). */
export interface TranscriptRowFields {
  jsonl_path?: string
  session_id?: string
  cwd?: string
  transcript_status?: string
  prior_sessions?: readonly { jsonl_path?: string; session_id?: string; cwd?: string }[]
}

/** The current transcript path reported by agent-director, without native-layout assumptions. Pure. */
export function locateTranscript(row: TranscriptRowFields): string | undefined {
  return row.jsonl_path || undefined
}

/** AD's transcript references, without inferring file health or conversation loss. Pure. */
export function describeTranscriptReference(row: TranscriptRowFields): string {
  const status = renderLogMessageText(row.transcript_status) || '(not reported)'
  const path = renderLogMessageText(row.jsonl_path) || '(not recorded)'
  const history = Array.isArray(row.prior_sessions) ? row.prior_sessions.length : '(not reported)'
  return `agent-director transcript_status=${status}, jsonl_path=${path}, prior_sessions=${history}; recorded references do not verify that transcript files remain readable`
}
