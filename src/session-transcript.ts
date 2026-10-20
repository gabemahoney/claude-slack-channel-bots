/** Locates a Claude transcript for exact delivery receipt matching. */
import { basename } from 'node:path'
import { resolveJsonlPath } from './cozempic.ts'

/** The agent-director row fields the transcript is located from (`GetResult`). */
export interface TranscriptRowFields {
  jsonl_path?: string
  session_id?: string
  cwd?: string
}

/**
 * The transcript of the row's current Claude session, or undefined when it
 * can't be located. With a `session_id`: the persisted `jsonl_path`
 * when its file name is `<session_id>.jsonl` (a path left from an
 * earlier session is never read), else the composed path under `configDir`
 * (the persona's effective claude_config_dir, absolute; undefined: not
 * composed). Without one: the persisted path, if any. Pure.
 */
export function locateTranscript(row: TranscriptRowFields, configDir: string | undefined): string | undefined {
  const persisted = row.jsonl_path || undefined
  const sessionId = row.session_id || undefined
  if (sessionId === undefined) return persisted
  if (persisted !== undefined && basename(persisted) === `${sessionId}.jsonl`) return persisted
  if (configDir === undefined || !row.cwd) return undefined
  return resolveJsonlPath(row.cwd, sessionId, configDir)
}
