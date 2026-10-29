/**
 * participation-file-evidence.ts — Correlate a confirmed parentless file
 * upload with the message root it created, from authenticated `files.info`
 * share metadata only.
 *
 * The share reading itself (`fileShareRoot`, shared with upload completions)
 * lives in `own-post.ts`: a new file root is identified only by the file's own
 * share in the actual target channel, and the earliest share there decides.
 * Missing, private, denied or deleted metadata is never proof that no post
 * occurred: the own post stays pending or a reported gap.
 *
 * No Slack call of its own: `resolveFileRoot` makes its one `files.info`
 * request through the caller's bounded metadata attempts.
 *
 * SPDX-License-Identifier: MIT
 */

import { CHANNEL_ID_RE } from './config.ts'
import { SLACK_FILE_ID_RE, fileShareRoot, type FileShareEvidence } from './own-post.ts'
import type { MetadataAttempts, MetadataFailure } from './thread-memory.ts'
import type { MetadataCaller } from './participation-channel-evidence.ts'

const object = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)

/** A `files.info` result for exactly `fileId`, or undefined when it is not one. Pure. */
export function fileInfoFile(result: unknown, fileId: string): Record<string, unknown> | undefined {
  if (!object(result) || result['ok'] !== true) return undefined
  const file = result['file']
  return object(file) && file['id'] === fileId ? file : undefined
}

/**
 * What one `files.info` attempt proves about a confirmed parentless upload's
 * root. `unavailable`: Slack denies the persona this file (`code`); the
 * upload's evidence stays pending, as for a deleted file.
 */
export type FileRootEvidence = FileShareEvidence | { kind: 'gap'; reason: 'deleted' | 'access-lost' | 'unavailable'; code?: string }

/**
 * Resolve the root a confirmed parentless upload of `fileId` created in
 * `channel`, with one bounded, revocable `files.info` attempt owned by
 * persona `key`. `current` is the caller's binding guard, re-checked after
 * the await. A deleted, denied or inaccessible file is a gap; other failures
 * are returned classified.
 */
export async function resolveFileRoot(attempts: MetadataAttempts, key: string, fileId: string, channel: string, current: () => boolean,
  call: MetadataCaller): Promise<FileRootEvidence | MetadataFailure> {
  if (!SLACK_FILE_ID_RE.test(fileId) || !CHANNEL_ID_RE.test(channel)) return { kind: 'unresolved', reason: 'malformed' }
  const result = await attempts.run(key, current, signal => call('files.info', { file: fileId }, signal), 'files.info')
  if (result.kind === 'ok') {
    const file = fileInfoFile(result.value, fileId)
    return file ? fileShareRoot(file, channel) : { kind: 'unresolved', reason: 'malformed' }
  }
  if (result.kind === 'not-found') return { kind: 'gap', reason: 'deleted' }
  if (result.kind === 'file-unavailable') return { kind: 'gap', reason: 'unavailable', code: result.slackError }
  if (result.kind === 'access-lost') return { kind: 'gap', reason: 'access-lost' }
  return result
}
