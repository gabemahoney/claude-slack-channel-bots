/**
 * participation-file-evidence.ts — Correlate a confirmed file upload with the
 * message root it created, from authenticated completion or `files.info`
 * share metadata only.
 *
 * A parent-bound upload names its thread already and needs no share. A new
 * file root is identified only by the file's own share in the actual target
 * channel: share `thread_ts` names a parent, otherwise share `ts` the root.
 * The upload's own share is the file's first share in that channel, so the
 * earliest share there decides; a later re-share confers nothing. File IDs,
 * created/timestamp fields, the requested channel alone and an aggregate `ok`
 * never name a root. Missing, private or ambiguous metadata stays unresolved.
 * Missing, private, denied or deleted metadata is never proof that no post
 * occurred: the own post stays pending or a reported gap.
 *
 * No Slack call of its own: `resolveFileRoot` makes its one `files.info`
 * request through the caller's bounded metadata attempts.
 *
 * SPDX-License-Identifier: MIT
 */

import { CHANNEL_ID_RE } from './config.ts'
import { isThreadTimestamp } from './delivery-decision.ts'
import type { MetadataAttempts, MetadataFailure } from './participation-metadata.ts'
import type { MetadataCaller } from './participation-channel-evidence.ts'

/** A Slack file ID as CSCB records it. */
export const SLACK_FILE_ID_RE = /^F[A-Z0-9]{2,63}$/

/** One completed file of an upload completion response. */
export interface CompletedFile {
  id: string
  /** The root its own share created, when the completion already carried it. */
  root?: string
}

/** What share metadata proves about one file in one channel. */
export type FileShareEvidence =
  | { kind: 'root'; root: string }
  | { kind: 'unresolved'; reason: 'no-share' | 'ambiguous' | 'malformed' }

const object = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)

/** Every share entry of `file` in `channel`, public and private. Malformed entries are dropped. */
function sharesIn(file: Record<string, unknown>, channel: string): Array<{ ts: string; thread_ts?: string }> | undefined {
  const shares = file['shares']
  if (shares === undefined) return []
  if (!object(shares)) return undefined
  const found: Array<{ ts: string; thread_ts?: string }> = []
  for (const visibility of ['public', 'private']) {
    const byChannel = shares[visibility]
    if (byChannel === undefined) continue
    if (!object(byChannel)) return undefined
    const entries = byChannel[channel]
    if (entries === undefined) continue
    if (!Array.isArray(entries)) return undefined
    for (const entry of entries) {
      if (!object(entry) || !isThreadTimestamp(entry['ts'])) continue
      const thread = entry['thread_ts']
      found.push({ ts: entry['ts'], ...(isThreadTimestamp(thread) ? { thread_ts: thread } : {}) })
    }
  }
  return found
}

/**
 * The root a new (parentless) upload of `file` created in `channel`: the
 * file's earliest share there, when that share is a root-level message. A
 * threaded earliest share, a tie, malformed shares or no share leave it
 * unresolved. Pure.
 */
export function fileShareRoot(file: unknown, channel: string): FileShareEvidence {
  if (!object(file)) return { kind: 'unresolved', reason: 'malformed' }
  const shares = sharesIn(file, channel)
  if (shares === undefined) return { kind: 'unresolved', reason: 'malformed' }
  if (!shares.length) return { kind: 'unresolved', reason: 'no-share' }
  const earliest = shares.reduce((a, b) => (compareTs(b.ts, a.ts) < 0 ? b : a))
  const ties = shares.filter(s => s.ts === earliest.ts)
  if (ties.some(s => s.thread_ts !== undefined && s.thread_ts !== s.ts)) return { kind: 'unresolved', reason: 'ambiguous' }
  return { kind: 'root', root: earliest.ts }
}

/**
 * The confirmed files of one `files.completeUploadExternal` response: each
 * file with a valid ID, and for a parentless upload the root its share in
 * `channel` names, when the response already carries it. A response that is
 * not `ok: true` confirms nothing. Pure.
 */
export function completionFiles(response: unknown, channel: string, parent?: string): CompletedFile[] {
  if (!object(response) || response['ok'] !== true || !Array.isArray(response['files'])) return []
  const files: CompletedFile[] = []
  for (const file of response['files']) {
    if (!object(file) || typeof file['id'] !== 'string' || !SLACK_FILE_ID_RE.test(file['id'])) continue
    const share = parent === undefined ? fileShareRoot(file, channel) : undefined
    files.push({ id: file['id'], ...(share?.kind === 'root' ? { root: share.root } : {}) })
  }
  return files
}

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

/** Order two valid Slack timestamps numerically. */
export function compareTs(a: string, b: string): number {
  const [as, af] = a.split('.') as [string, string]
  const [bs, bf] = b.split('.') as [string, string]
  if (as.length !== bs.length) return as.length - bs.length
  return as < bs ? -1 : as > bs ? 1 : af < bf ? -1 : af > bf ? 1 : 0
}
