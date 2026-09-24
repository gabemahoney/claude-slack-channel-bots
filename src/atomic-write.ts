/**
 * atomic-write.ts — The one `.tmp` + rename file write (engineering guide,
 * Configuration: "Atomic file writes"). A reader of the final path sees the
 * old contents or the new, never a partial write.
 *
 * Side-effect-free: importing it touches nothing.
 *
 * SPDX-License-Identifier: MIT
 */

import { renameSync, rmSync, writeFileSync } from 'node:fs'

/**
 * Write `contents` to `path` atomically: write `<path>.tmp`, then rename it
 * over `path`. On failure the `.tmp` file is removed (best effort) and the
 * error is rethrown; `path` keeps its old contents.
 */
export function atomicWriteFileSync(path: string, contents: string): void {
  const tmp = path + '.tmp'
  try {
    writeFileSync(tmp, contents, 'utf-8')
    renameSync(tmp, path)
  } catch (err) {
    try {
      rmSync(tmp, { force: true })
    } catch {
      /* ignore */
    }
    throw err
  }
}
