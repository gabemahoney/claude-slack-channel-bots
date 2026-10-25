/**
 * participation-root-evidence.ts — Who started one thread, from one bounded
 * authenticated `conversations.replies` lookup of exactly its root.
 *
 * The request names the receiving persona's channel and the reply's
 * `thread_ts`; only the first returned message is read, and only when it is
 * that exact root of that channel: its timestamp is the requested root and
 * it is not itself a reply. Its author is matched with delivery's own-author
 * rule (`isOwn`: the bot user or bot ID the request was made for). Another
 * author is `foreign`. A display name, a file owner, `reply_users` and the
 * other returned messages confer nothing, and no returned message is ever
 * delivered or scanned for participation. An own root also carries the IDs
 * of the files that exact root message shares, so the participation owner
 * can tell which confirmed upload created it.
 *
 * Only a deleted root (a tombstone, or Slack's not-found answer) and lost
 * channel access are root-author gaps. A mismatched, non-root, authorless or
 * otherwise malformed answer is unresolved and retried; a failed attempt is
 * returned classified (`participation-metadata.ts`), never as authorship.
 * Whether an own root may enroll (it must belong to this lifetime) is the
 * participation owner's decision (`ThreadParticipation.resolveRootLookup`).
 *
 * SPDX-License-Identifier: MIT
 */

import { CHANNEL_ID_RE } from './config.ts'
import { isOwn, isThreadTimestamp } from './delivery-decision.ts'
import type { MetadataAttempts, MetadataFailure } from './participation-metadata.ts'
import type { MetadataCaller } from './participation-channel-evidence.ts'
import { SLACK_FILE_ID_RE } from './participation-file-evidence.ts'
import type { OwnPostIssuer, RootLookupVerdict } from './thread-participation.ts'

/** What one lookup proves about a thread's root. `files`: the root message's own shared file IDs. */
export type RootAuthorEvidence =
  | { kind: 'own'; root: string; files: string[] }
  | { kind: 'foreign'; root: string }
  | { kind: 'gap'; reason: 'deleted' | 'access-lost' }
  | { kind: 'unresolved'; reason: 'malformed' | 'mismatch' | 'not-root' }

/** Root messages Slack keeps as placeholders after deletion. */
const DELETED_ROOT_SUBTYPES: ReadonlySet<string> = new Set(['tombstone', 'message_deleted'])

const object = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)
const nonEmpty = (v: unknown): string | undefined => typeof v === 'string' && v !== '' ? v : undefined

/** Read a `conversations.replies` result for exactly `root` in `channel`, as `identity`. Pure. */
export function parseRootReplies(result: unknown, channel: string, root: string, identity: OwnPostIssuer): RootAuthorEvidence {
  if (!object(result) || result['ok'] !== true || !Array.isArray(result['messages']) || !CHANNEL_ID_RE.test(channel) || !isThreadTimestamp(root)) {
    return { kind: 'unresolved', reason: 'malformed' }
  }
  const first: unknown = result['messages'][0]
  if (!object(first)) return { kind: 'unresolved', reason: 'malformed' }
  if (first['ts'] !== root || (first['channel'] !== undefined && first['channel'] !== channel)) return { kind: 'unresolved', reason: 'mismatch' }
  if (first['thread_ts'] !== undefined && first['thread_ts'] !== root) return { kind: 'unresolved', reason: 'not-root' }
  if (typeof first['subtype'] === 'string' && DELETED_ROOT_SUBTYPES.has(first['subtype'])) return { kind: 'gap', reason: 'deleted' }
  const user = nonEmpty(first['user']), botId = nonEmpty(first['bot_id'])
  if (!user && !botId) return { kind: 'unresolved', reason: 'malformed' }
  return isOwn(user, botId, identity) ? { kind: 'own', root, files: rootFiles(first) } : { kind: 'foreign', root }
}

/** The valid file IDs the root message itself shares; malformed entries are dropped. */
function rootFiles(message: Record<string, unknown>): string[] {
  const files = message['files']
  if (!Array.isArray(files)) return []
  const ids = files.map(file => object(file) ? file['id'] : undefined)
    .filter((id): id is string => typeof id === 'string' && SLACK_FILE_ID_RE.test(id))
  return [...new Set(ids)]
}

/**
 * Look up `root`'s author with one bounded, revocable attempt owned by
 * persona `key`. `current` is the caller's binding guard, re-checked after
 * the await. Slack's not-found and lost-access answers become gaps; every
 * other failure is returned classified.
 */
export async function resolveRootAuthor(attempts: MetadataAttempts, key: string, channel: string, root: string, identity: OwnPostIssuer,
  current: () => boolean, call: MetadataCaller): Promise<RootAuthorEvidence | MetadataFailure> {
  if (!CHANNEL_ID_RE.test(channel) || !isThreadTimestamp(root)) return { kind: 'unresolved', reason: 'malformed' }
  const result = await attempts.run(key, current, signal => call('conversations.replies', { channel, ts: root, limit: 1, inclusive: true }, signal), 'conversations.replies')
  if (result.kind === 'ok') return parseRootReplies(result.value, channel, root, identity)
  if (result.kind === 'not-found') return { kind: 'gap', reason: 'deleted' }
  if (result.kind === 'access-lost') return { kind: 'gap', reason: 'access-lost' }
  return result
}

/** The owner's verdict for decided evidence; undefined while it decides nothing. */
export function rootLookupVerdict(evidence: RootAuthorEvidence | MetadataFailure): RootLookupVerdict | undefined {
  if (evidence.kind === 'own') return { kind: 'own', root: evidence.root, files: [...evidence.files] }
  if (evidence.kind === 'foreign') return { kind: 'not-own' }
  return undefined
}
