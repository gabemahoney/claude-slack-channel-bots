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
 * The opt-in option (b.uqm SR-21.3). `treeSnapshot(dir, { extended: true })`
 * appends to every line, `.` included, the entry's permission bits as four
 * octal digits and its change time (`ctimeMs`), and, for a regular file only,
 * the SHA-256 of its content as 64 lowercase hex digits (`unreadable(<code>)`
 * when the file cannot be read):
 *
 *   .:<mtime>:<mode>:<ctime>
 *   <relative path>:<kind>:<detail>:<mtime>:<mode>:<ctime>[:<sha256>]
 *
 * So a mode change (`chmod`), a change-time change (a rename, a link count, an
 * owner change) and a same-size content change each show. Access time is never
 * part of a snapshot, with or without the option, so a read that changes only
 * the access time (the option's own digest reads included) shows nothing.
 * Without the option the output is exactly the four fields above, unchanged.
 *
 * Isolation: it reads only `dir` and the entries under it (`readdir`, `lstat`,
 * `readlink`, and with the option a regular file's content), never a
 * symlink's target, and writes nothing.
 *
 * SPDX-License-Identifier: MIT
 */

import { createHash } from 'node:crypto'
import { lstatSync, readdirSync, readFileSync, readlinkSync, type Stats } from 'node:fs'
import { join } from 'node:path'

/** `treeSnapshot`'s options. */
export interface TreeSnapshotOptions {
  /** Add each entry's permission bits and change time, and a regular file's content digest (b.uqm SR-21.3). Off by default. */
  readonly extended?: boolean
}

/** An entry's permission bits, as four octal digits (`0700`). */
function permissionBits(st: Stats): string {
  return (st.mode & 0o7777).toString(8).padStart(4, '0')
}

/** A regular file's content digest; `unreadable(<code>)` when it cannot be read. Never called for a symlink, so no target is read. */
function contentDigest(path: string): string {
  try {
    return createHash('sha256').update(readFileSync(path)).digest('hex')
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code
    return `unreadable(${code ?? 'error'})`
  }
}

/** Every entry under `dir` (symlinks listed with their targets, never followed), plus `dir`'s own mtime; with `extended`, each entry's mode, change time and a regular file's digest too. */
export function treeSnapshot(dir: string, options: TreeSnapshotOptions = {}): string[] {
  const extended = options.extended === true
  const extra = (st: Stats, path: string): string => {
    if (!extended) return ''
    const digest = st.isFile() ? `:${contentDigest(path)}` : ''
    return `:${permissionBits(st)}:${st.ctimeMs}${digest}`
  }
  const root = lstatSync(dir)
  const out = [`.:${root.mtimeMs}${extra(root, dir)}`]
  const walk = (rel: string): void => {
    const names = readdirSync(join(dir, rel), { withFileTypes: true }).map((entry) => entry.name).sort()
    for (const name of names) {
      const path = rel === '' ? name : join(rel, name)
      const full = join(dir, path)
      const st = lstatSync(full)
      if (st.isSymbolicLink()) {
        out.push(`${path}:l:${readlinkSync(full)}:${st.mtimeMs}${extra(st, full)}`)
      } else if (st.isDirectory()) {
        out.push(`${path}:d:${st.size}:${st.mtimeMs}${extra(st, full)}`)
        walk(path)
      } else {
        out.push(`${path}:f:${st.size}:${st.mtimeMs}${extra(st, full)}`)
      }
    }
  }
  walk('')
  return out
}
