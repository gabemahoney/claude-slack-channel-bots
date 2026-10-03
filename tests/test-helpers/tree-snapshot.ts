/**
 * test-helpers/tree-snapshot.ts — A snapshot of a directory tree, for a case
 * that asserts a call changed nothing under a directory:
 *
 *   const before = treeSnapshot(home)
 *   …
 *   expect(treeSnapshot(home)).toEqual(before)
 *
 * `treeSnapshot(dir)` lists `dir`'s own mtime, then every entry under it,
 * depth first with names sorted, as `<relative path>:<kind>:<detail>:<mtime>`:
 * a directory (`d`) and a file or any other non-symlink (`f`) with their size,
 * a symlink (`l`) with its target as `readlink` gives it. It never follows a
 * symlink: a link to a directory is one entry, so a link out of the tree (to
 * the fake real home, to `/`) or a symlink loop is listed and not walked.
 * (Bun's recursive `readdirSync` follows directory symlinks and fails with
 * `ELOOP` on a loop, so this walks with `withFileTypes` instead.)
 *
 * Isolation: it reads only `dir` and the entries under it (`readdir`, `lstat`,
 * `readlink`), never a symlink's target, and writes nothing.
 *
 * SPDX-License-Identifier: MIT
 */

import { lstatSync, readdirSync, readlinkSync } from 'node:fs'
import { join } from 'node:path'

/** Every entry under `dir` (symlinks listed with their targets, never followed), plus `dir`'s own mtime. */
export function treeSnapshot(dir: string): string[] {
  const out = [`.:${lstatSync(dir).mtimeMs}`]
  const walk = (rel: string): void => {
    const names = readdirSync(join(dir, rel), { withFileTypes: true }).map((entry) => entry.name).sort()
    for (const name of names) {
      const path = rel === '' ? name : join(rel, name)
      const st = lstatSync(join(dir, path))
      if (st.isSymbolicLink()) {
        out.push(`${path}:l:${readlinkSync(join(dir, path))}:${st.mtimeMs}`)
      } else if (st.isDirectory()) {
        out.push(`${path}:d:${st.size}:${st.mtimeMs}`)
        walk(path)
      } else {
        out.push(`${path}:f:${st.size}:${st.mtimeMs}`)
      }
    }
  }
  walk('')
  return out
}
