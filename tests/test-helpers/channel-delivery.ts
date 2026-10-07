/**
 * test-helpers/channel-delivery.ts — The stored-choice record for tests
 * (b.deo SRI-1204): `writeChannelDeliveryRecord` seeds the record in a state
 * directory, `readChannelDeliveryRecord` reads it back, and `declarationOf`
 * builds a persona's declaration as the server records it.
 *
 * Every one goes through `src/channel-delivery.ts` itself: the file's name and
 * path (`channelDeliveryPath`), its bytes (`serializeChannelDelivery`), its
 * parse (`parseChannelDelivery`) and the declaration
 * (`channelDeliveryDeclarationOf`). No test writes the record by hand: never a
 * JSON literal of the record, never the file name typed as a string. A test
 * that needs a malformed record alters what the serialiser wrote.
 *
 * - `writeChannelDeliveryRecord(stateDir, entries)`: the entries by persona
 *   key, each with its declaration and its channels by channel ID, each
 *   channel with its delivery and, optionally, its `set_at`. An unset `set_at`
 *   is `SAMPLE_SET_AT`, never typed per test. The serialiser omits a key with
 *   no channels, as the server's writes do. Answers the record's path.
 * - `readChannelDeliveryRecord(stateDir)`: the record parsed by the module's
 *   parser, or `null` when there is no file, so an absent file is told apart
 *   from an empty record. A file the parser refuses throws, naming the
 *   function, the path and the parser's problem (which carries no file
 *   content); any other read failure is rethrown.
 * - `SAMPLE_SET_AT`: the `set_at` a seeded channel gets when the test gives
 *   none, in the form the server writes and the parser accepts.
 * - `declarationOf(persona)`: the declaration of a resolved persona, from the
 *   module's declaration builder.
 * - `channelDeliveryRecordOf(entries)`: the record the entries describe, as
 *   the module holds it in memory, to compare with what a store or the reader
 *   answers.
 *
 * Isolation (b.deo SRI-1204; b.jg5 SRJ-1301): both take the state directory
 * explicitly and never resolve a default one; the writer writes only the
 * record in that directory, and refuses, writing nothing, the real home, the
 * OS temp directory itself and any directory not under it. No module-scope
 * state, no process started, no module mocked.
 *
 * SPDX-License-Identifier: MIT
 */

import { readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'

import {
  channelDeliveryDeclarationOf,
  channelDeliveryPath,
  parseChannelDelivery,
  serializeChannelDelivery,
  type ChannelDeliveryChannelEntry,
  type ChannelDeliveryDeclaration,
  type ChannelDeliveryPersonaEntry,
  type ChannelDeliveryRecord,
} from '../../src/channel-delivery.ts'
import type { DeliveryMode, Persona } from '../../src/config.ts'
import { isRealHome, isUnder, osTempDir } from './host-safe-env.ts'

/** The `set_at` a seeded channel gets when the test gives none (RFC 3339 UTC, ending in `Z`, as the server writes it). */
export const SAMPLE_SET_AT = '2026-06-01T09:30:00.000Z'

/** One channel's choice to seed. */
export interface ChannelDeliveryChannelSeed {
  /** The stored choice. */
  readonly delivery: DeliveryMode
  /** When it was stored; `SAMPLE_SET_AT` when unset. */
  readonly set_at?: string
}

/** One persona key's entry to seed. */
export interface ChannelDeliveryPersonaSeed {
  /** The declaration recorded with the entry; `declarationOf(persona)` for a resolved persona. */
  readonly declaration: ChannelDeliveryDeclaration
  /** The stored choices, by channel ID. */
  readonly channels: Readonly<Record<string, ChannelDeliveryChannelSeed>>
}

/** The declaration of a resolved persona, as the server records it: the module's declaration builder. */
export function declarationOf(persona: Pick<Persona, 'name' | 'credentials_file' | 'working_directory'>): ChannelDeliveryDeclaration {
  return channelDeliveryDeclarationOf(persona)
}

/** The record `entries` describe, as the module holds it in memory. */
export function channelDeliveryRecordOf(entries: Readonly<Record<string, ChannelDeliveryPersonaSeed>>): ChannelDeliveryRecord {
  const record = new Map<string, ChannelDeliveryPersonaEntry>()
  for (const [key, seed] of Object.entries(entries)) {
    const channels = new Map<string, ChannelDeliveryChannelEntry>()
    for (const [id, choice] of Object.entries(seed.channels)) {
      channels.set(id, { delivery: choice.delivery, set_at: choice.set_at ?? SAMPLE_SET_AT })
    }
    record.set(key, { declaration: seed.declaration, channels })
  }
  return record
}

/**
 * Write the record holding `entries` in `stateDir`, through the module's
 * serialiser, and answer its path. Throws, writing nothing, when `stateDir`
 * is the real home, is the OS temp directory itself, or is not under it.
 */
export function writeChannelDeliveryRecord(stateDir: string, entries: Readonly<Record<string, ChannelDeliveryPersonaSeed>>): string {
  const dir = resolve(stateDir)
  const tempDir = osTempDir()
  if (isRealHome(dir)) throw new Error('writeChannelDeliveryRecord: refusing the real home; pass a mkdtempSync state directory')
  if (dir === tempDir || !isUnder(dir, tempDir)) {
    throw new Error('writeChannelDeliveryRecord: the state directory must be a directory under the OS temp directory')
  }
  const path = channelDeliveryPath(dir)
  writeFileSync(path, serializeChannelDelivery(channelDeliveryRecordOf(entries)))
  return path
}

/**
 * The record in `stateDir`, parsed by the module's parser, or `null` when
 * there is no file. Throws when the parser refuses the file, naming the path
 * and the parser's problem; rethrows any other read failure.
 */
export function readChannelDeliveryRecord(stateDir: string): ChannelDeliveryRecord | null {
  const path = channelDeliveryPath(resolve(stateDir))
  let bytes: Buffer
  try {
    bytes = readFileSync(path)
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw err
  }
  const parsed = parseChannelDelivery(bytes)
  if (!parsed.ok) throw new Error(`readChannelDeliveryRecord: "${path}" ${parsed.problem}`)
  return parsed.record
}
