import { createHash } from 'node:crypto'
import type { ReadPaneResult } from 'agent-director'

/** A pane capture with the hash the released CLI returns for its bytes. */
export function cannedReadPaneResult(pane: string): ReadPaneResult {
  return { pane, pane_sha256: createHash('sha256').update(pane).digest('hex') }
}
