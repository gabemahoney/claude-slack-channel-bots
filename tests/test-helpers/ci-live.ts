/**
 * test-helpers/ci-live.ts — Shared fakes for the /ci-live runner suites
 * (`tests/ci-live-*.test.ts`, bug b.1cx).
 *
 * - `memSecureFs()` is an in-memory `SecureFs` (the runner's secret-store
 *   seam): files and directories with their modes, plus a log of every call,
 *   so a suite can assert the order of a private write (temp file, chmod,
 *   rename) and that a path was never read. Nothing touches the disk.
 * - `virtualClock()` is the runner's `Clock` (`now` + `sleep`) over the shared
 *   fake clock: `sleep(ms)` advances virtual time by `ms`, so a bounded wait
 *   runs to its deadline with no real delay.
 *
 * The runner's own modules are imported only from `ci-live/lib/`,
 * `ci-live/checks/`, `ci-live/provision/` and `ci-live/dry-run/`, never from
 * `ci-live/main.ts`, `ci-live/runtime/` or `ci-live/browser/`, which load
 * playwright-core (not installed on a fresh clone).
 *
 * SPDX-License-Identifier: MIT
 */

import { dirname } from 'node:path'

import type { FileStat, SecureFs } from '../../ci-live/lib/secrets.ts'
import type { Clock } from '../../ci-live/lib/wait.ts'
import { createFakeClock, type FakeClock } from './fake-clock.ts'

export interface MemFile {
  data: string
  mode: number
}

export interface MemSecureFs {
  fs: SecureFs
  files: Map<string, MemFile>
  /** Directories and their modes. */
  dirs: Map<string, number>
  /** Every call, in order, as `<op> <path>[ <arg>]` (modes in octal). */
  ops: string[]
  /** Paths `readFile` was called with. */
  reads: string[]
  /** Make the next call of `op` throw an errno-style error. */
  failNext(op: keyof SecureFs, code?: string): void
  /** Seed a file (its directory is created with mode 700 when missing). */
  seed(path: string, data: string, mode?: number, dirMode?: number): void
}

function errno(code: string, path: string): Error {
  return Object.assign(new Error(`${code}: ${path}`), { code })
}

/** An in-memory `SecureFs`. Directory creation is recursive, like the real one. */
export function memSecureFs(): MemSecureFs {
  const files = new Map<string, MemFile>()
  const dirs = new Map<string, number>()
  const ops: string[] = []
  const reads: string[] = []
  const failing = new Map<string, string>()
  const oct = (mode: number) => mode.toString(8)
  const maybeFail = (op: string, path: string) => {
    const code = failing.get(op)
    if (code !== undefined) {
      failing.delete(op)
      throw errno(code, path)
    }
  }
  const mkdirp = (path: string, mode: number) => {
    for (let d = path; d !== dirname(d) && !dirs.has(d); d = dirname(d)) dirs.set(d, mode)
  }
  const fs: SecureFs = {
    stat(path): FileStat | null {
      ops.push(`stat ${path}`)
      maybeFail('stat', path)
      const file = files.get(path)
      if (file) return { mode: file.mode, size: file.data.length, isFile: true, isDirectory: false }
      const dir = dirs.get(path)
      if (dir !== undefined) return { mode: dir, size: 0, isFile: false, isDirectory: true }
      return null
    },
    readFile(path) {
      ops.push(`readFile ${path}`)
      reads.push(path)
      maybeFail('readFile', path)
      const file = files.get(path)
      if (!file) throw errno('ENOENT', path)
      return file.data
    },
    writeFile(path, data, mode) {
      ops.push(`writeFile ${path} ${oct(mode)}`)
      maybeFail('writeFile', path)
      if (!dirs.has(dirname(path))) throw errno('ENOENT', path)
      if (files.has(path)) throw errno('EEXIST', path)
      files.set(path, { data, mode })
    },
    chmod(path, mode) {
      ops.push(`chmod ${path} ${oct(mode)}`)
      maybeFail('chmod', path)
      const file = files.get(path)
      if (file) file.mode = mode
      else if (dirs.has(path)) dirs.set(path, mode)
      else throw errno('ENOENT', path)
    },
    rename(from, to) {
      ops.push(`rename ${from} ${to}`)
      maybeFail('rename', from)
      const file = files.get(from)
      if (!file) throw errno('ENOENT', from)
      if (!dirs.has(dirname(to))) throw errno('ENOENT', to)
      files.delete(from)
      files.set(to, file)
    },
    mkdir(path, mode) {
      ops.push(`mkdir ${path} ${oct(mode)}`)
      maybeFail('mkdir', path)
      mkdirp(path, mode)
    },
    unlink(path) {
      ops.push(`unlink ${path}`)
      maybeFail('unlink', path)
      if (!files.delete(path)) throw errno('ENOENT', path)
    },
    readdir(path) {
      ops.push(`readdir ${path}`)
      maybeFail('readdir', path)
      if (!dirs.has(path)) throw errno('ENOENT', path)
      const names = new Set<string>()
      for (const p of [...files.keys(), ...dirs.keys()]) if (dirname(p) === path && p !== path) names.add(p.slice(path.length + 1))
      return [...names].sort()
    },
  }
  return {
    fs,
    files,
    dirs,
    ops,
    reads,
    failNext(op, code = 'EIO') {
      failing.set(op, code)
    },
    seed(path, data, mode = 0o600, dirMode = 0o700) {
      mkdirp(dirname(path), dirMode)
      files.set(path, { data, mode })
    },
  }
}

/** The runner's `Clock` over the shared fake clock: `sleep(ms)` advances virtual time by `ms`. */
export function virtualClock(start = 1_700_000_000_000): Clock & { fake: FakeClock } {
  const fake = createFakeClock({ start })
  return {
    fake,
    now: () => fake.now(),
    sleep: async (ms) => {
      await fake.advance(ms)
    },
  }
}
