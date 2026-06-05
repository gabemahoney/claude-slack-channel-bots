/**
 * trail-query.ts — Read-only query surface for the CSCB visibility trail
 * (SRD t1.cdb.4g, SR-V-5).
 *
 * Provides two query shapes per SR-V-5:
 *   - queryByToken(request_token): all events for one interaction, ts-asc.
 *   - queryByChannelTimerange(channel, since, until): all events on a Slack
 *     channel within a time window, ts-asc.
 *
 * Reads the JSONL file fresh on every call (SR-V-6.2 — invocable without
 * restart, no perturbation). Tolerates blank and unparseable lines without
 * throwing (defensive against corrupted lines — SR-V-3 mandates full
 * fidelity at the emit site; the reader cannot guarantee no manual edits
 * happened on disk).
 *
 * SPDX-License-Identifier: MIT
 */

import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import type { TrailEvent } from './permission-trail.ts'

const TRAIL_FILENAME = 'permission-trail.jsonl'

/**
 * Same path-resolution logic as the emitter — duplicated rather than
 * imported so `src/trail-query.ts` is independent of the emit-side fd state.
 */
function resolveStateDir(): string {
  const fromEnv = process.env['SLACK_STATE_DIR']
  return fromEnv ? resolve(fromEnv) : join(homedir(), '.claude', 'channels', 'slack')
}

/**
 * Resolve the canonical trail file path used by both query shapes. Exposed
 * so the CLI can include it in `--help` output and tests can assert
 * `SLACK_STATE_DIR` is honored.
 */
export function resolveTrailPathForQuery(): string {
  return join(resolveStateDir(), TRAIL_FILENAME)
}

/**
 * Read and parse all valid JSONL events from the trail file. Skips blank
 * and unparseable lines silently — never throws on bad input.
 */
function readTrailFile(trailPath: string): TrailEvent[] {
  if (!existsSync(trailPath)) return []
  const raw = readFileSync(trailPath, 'utf-8')
  const events: TrailEvent[] = []
  for (const line of raw.split('\n')) {
    if (line.length === 0) continue
    try {
      const parsed = JSON.parse(line) as TrailEvent
      if (parsed !== null && typeof parsed === 'object') {
        events.push(parsed)
      }
    } catch {
      // Skip malformed line. The emit path is non-truncating by construction,
      // so any malformed line is from outside the system (manual edit).
    }
  }
  return events
}

function sortByTsAscending(events: TrailEvent[]): TrailEvent[] {
  return events.slice().sort((a, b) => {
    const ta = typeof a.ts === 'string' ? a.ts : ''
    const tb = typeof b.ts === 'string' ? b.ts : ''
    if (ta < tb) return -1
    if (ta > tb) return 1
    return 0
  })
}

export interface QueryOptions {
  /** Override the trail file path. Defaults to `resolveTrailPathForQuery()`. */
  trailPath?: string
}

/**
 * SR-V-5.1 — every event for `request_token=X`, in time order.
 */
export function queryByToken(
  requestToken: string,
  opts: QueryOptions = {},
): TrailEvent[] {
  const path = opts.trailPath ?? resolveTrailPathForQuery()
  const all = readTrailFile(path)
  const matching = all.filter(e => e.request_token === requestToken)
  return sortByTsAscending(matching)
}

/**
 * SR-V-5.2 — every event for `channel=C` between `since` and `until`,
 * inclusive on both bounds. RFC 3339 string comparison is valid for time
 * ordering at the emitter's ms precision.
 */
export function queryByChannelTimerange(
  channel: string,
  since: string,
  until: string,
  opts: QueryOptions = {},
): TrailEvent[] {
  const path = opts.trailPath ?? resolveTrailPathForQuery()
  const all = readTrailFile(path)
  const matching = all.filter(e => {
    if (e.channel !== channel) return false
    const ts = typeof e.ts === 'string' ? e.ts : ''
    return ts >= since && ts <= until
  })
  return sortByTsAscending(matching)
}
