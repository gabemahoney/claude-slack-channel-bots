/**
 * reload-fingerprint.ts — The pending-change fingerprint and the pending
 * file's layout (b.av2 SR-8.1, SR-8.3, SR-8.5).
 *
 * The fingerprint identifies the contents a pending change was derived from:
 * a SHA-256 over the configuration file's bytes and, for each credentials
 * file the configuration file references (in declaration order), its path
 * and its bytes, or a missing or unreadable marker. In dry run no credentials
 * file is read and the fingerprint covers the configuration file alone: the
 * caller passes no credentials entries (b.av2 SR-8.2). The referenced paths
 * come from `referencedCredentialsPaths` in `config.ts`.
 *
 * Encoding: the hash runs over one stream that can be decoded back into its
 * inputs, so two different inputs never hash the same stream:
 *
 *   "cscb-reload-fingerprint-v1\n"
 *   <content: configuration file>
 *   <count of credentials entries: 8-byte big-endian>
 *   per entry: <path: 8-byte big-endian length, then its UTF-8 bytes> <content>
 *
 * where a content is one tag byte, `B` then an 8-byte big-endian length and
 * the bytes, or `M` (missing) or `U` (unreadable) alone. A marker is a tag of
 * its own, so it never equals any content, an empty file included.
 *
 * The pending file (`config.json.pending`) starts with two fixed lines, then
 * a blank line and the preview body the caller supplies:
 *
 *   line 1: PENDING_FILE_HEADER
 *   line 2: "fingerprint: sha256:" + 64 lower-case hex digits
 *
 * `composePendingFile` writes that layout and `parsePendingFingerprint`
 * recovers the fingerprint from it (E12 compares a confirmation's fingerprint
 * with that of the current contents). The operator never types it.
 *
 * Pure (b.av2 SR-13.1): no function here reads a file, logs or holds state,
 * and nothing runs at import. Only the hash of any credentials content
 * appears in an output, never the content.
 *
 * SPDX-License-Identifier: MIT
 */

import { createHash } from 'node:crypto'

// ---------------------------------------------------------------------------
// Fingerprint (b.av2 SR-8.3)
// ---------------------------------------------------------------------------

/** A file that does not exist. */
export const FINGERPRINT_MISSING = 'missing'

/** A file that exists but cannot be read (a directory, a FIFO, permission denied, …). */
export const FINGERPRINT_UNREADABLE = 'unreadable'

/** One file's contribution to the fingerprint: its exact bytes, or why there are none. */
export type FingerprintContent = Uint8Array | typeof FINGERPRINT_MISSING | typeof FINGERPRINT_UNREADABLE

/** One referenced credentials file: its path (as the configuration names it, expanded) and its content. */
export interface FingerprintCredentialsEntry {
  path: string
  content: FingerprintContent
}

/** First bytes of the hashed stream; names the encoding, so a future one never collides with it. */
const FINGERPRINT_DOMAIN = 'cscb-reload-fingerprint-v1\n'

/** Content tags. */
const TAG_BYTES = 0x42 // 'B'
const TAG_MISSING = 0x4d // 'M'
const TAG_UNREADABLE = 0x55 // 'U'

/** An 8-byte big-endian length. */
function lengthPrefix(n: number): Buffer {
  const buf = Buffer.alloc(8)
  buf.writeBigUInt64BE(BigInt(n))
  return buf
}

/** Feed one content (tag, then length and bytes for `B`) to the hash. */
function updateContent(hash: ReturnType<typeof createHash>, content: FingerprintContent): void {
  if (content === FINGERPRINT_MISSING) {
    hash.update(Buffer.of(TAG_MISSING))
  } else if (content === FINGERPRINT_UNREADABLE) {
    hash.update(Buffer.of(TAG_UNREADABLE))
  } else {
    hash.update(Buffer.of(TAG_BYTES))
    hash.update(lengthPrefix(content.length))
    hash.update(content)
  }
}

/**
 * The SR-8.3 fingerprint, as 64 lower-case hex digits: SHA-256 over the
 * configuration file's content and each credentials entry (path and content)
 * in the order given (see the module comment for the encoding). The same
 * inputs always give the same fingerprint; changing the configuration bytes,
 * any path, any credentials byte, the order of the entries, or a file between
 * present, missing and unreadable changes it. No entries (dry run) gives a
 * fingerprint that differs from the same configuration with any entry. Pure.
 */
export function reloadFingerprint(
  config: FingerprintContent,
  credentials: readonly FingerprintCredentialsEntry[],
): string {
  const hash = createHash('sha256')
  hash.update(FINGERPRINT_DOMAIN, 'utf-8')
  updateContent(hash, config)
  hash.update(lengthPrefix(credentials.length))
  for (const entry of credentials) {
    const path = Buffer.from(entry.path, 'utf-8')
    hash.update(lengthPrefix(path.length))
    hash.update(path)
    updateContent(hash, entry.content)
  }
  return hash.digest('hex')
}

// ---------------------------------------------------------------------------
// Pending file layout (b.av2 SR-8.1)
// ---------------------------------------------------------------------------

/** Line 1 of every pending file. */
export const PENDING_FILE_HEADER = 'claude-slack-channel-bots: pending configuration change (written by the server)'

/** Start of line 2 of every pending file; the fingerprint follows as 64 hex digits. */
export const PENDING_FINGERPRINT_PREFIX = 'fingerprint: sha256:'

/** A fingerprint as `reloadFingerprint` renders it. */
const FINGERPRINT_RE = /^[0-9a-f]{64}$/

/**
 * The pending file's text: `PENDING_FILE_HEADER`, the fingerprint line, a
 * blank line, then `body` (the preview), ending in one newline. Throws when
 * `fingerprint` is not 64 lower-case hex digits (a programming error). Pure.
 */
export function composePendingFile(fingerprint: string, body: string): string {
  if (!FINGERPRINT_RE.test(fingerprint)) throw new Error('composePendingFile: the fingerprint must be 64 lower-case hex digits')
  const text = `${PENDING_FILE_HEADER}\n${PENDING_FINGERPRINT_PREFIX}${fingerprint}\n\n${body}`
  return text.endsWith('\n') ? text : `${text}\n`
}

/**
 * The fingerprint recorded in a pending file's text, or undefined when the
 * text does not start with `PENDING_FILE_HEADER` followed by a well-formed
 * fingerprint line (a trailing carriage return on either line is accepted).
 * Pure; never throws.
 */
export function parsePendingFingerprint(text: string): string | undefined {
  const lines = text.split('\n', 3)
  if (lines.length < 2) return undefined
  const [header, line] = lines.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l))
  if (header !== PENDING_FILE_HEADER || line === undefined || !line.startsWith(PENDING_FINGERPRINT_PREFIX)) return undefined
  const fingerprint = line.slice(PENDING_FINGERPRINT_PREFIX.length)
  return FINGERPRINT_RE.test(fingerprint) ? fingerprint : undefined
}
