/**
 * proc-tree.ts — the memory of the runner's Chrome, read from /proc for the
 * memory watchdog: every descendant of the runner whose command name (or
 * program) is Chrome, and the sum of their PSS.
 *
 * Only reads /proc (`/proc/<pid>/stat` for the parent and the command name,
 * `/proc/<pid>/smaps_rollup` for Pss, `/proc/<pid>/status` for VmRSS). PSS
 * (proportional set size) divides each page shared between processes among
 * them, so the sum counts Chrome's shared pages once, where a summed RSS
 * counts them once per process. A process whose smaps_rollup can't be read
 * (a kernel without it, a process that is not dumpable) counts its RSS
 * instead, an upper bound, which is the safe side for a limit; the result
 * says how many did. A process that exits mid-scan is skipped.
 *
 * The /proc access is injected (`ProcReader`), so tests drive a fake table.
 */

import { readFileSync, readdirSync } from 'node:fs'

export interface ProcReader {
  /** The PIDs listed in /proc. */
  pids(): number[]
  /** `/proc/<pid>/stat`, or `null` when the process is gone. */
  stat(pid: number): string | null
  /** `/proc/<pid>/status`, or `null` when the process is gone. */
  status(pid: number): string | null
  /** `/proc/<pid>/smaps_rollup`, or `null` when it can't be read (the process is gone, not dumpable, or the kernel has none). */
  smapsRollup(pid: number): string | null
  /** `/proc/<pid>/cmdline` with NULs as spaces, or `null` when the process is gone. */
  cmdline(pid: number): string | null
}

function readOrNull(path: string): string | null {
  try {
    return readFileSync(path, 'utf-8')
  } catch {
    return null
  }
}

export const nodeProcReader: ProcReader = {
  pids: () => {
    try {
      return readdirSync('/proc')
        .filter((e) => /^[1-9][0-9]*$/.test(e))
        .map(Number)
    } catch {
      return []
    }
  },
  stat: (pid) => readOrNull(`/proc/${pid}/stat`),
  status: (pid) => readOrNull(`/proc/${pid}/status`),
  smapsRollup: (pid) => readOrNull(`/proc/${pid}/smaps_rollup`),
  cmdline: (pid) => readOrNull(`/proc/${pid}/cmdline`)?.replace(/\0/g, ' ') ?? null,
}

/**
 * A `/proc/<pid>/stat` line's command name and parent PID. The name sits in
 * parentheses and may itself hold spaces or parentheses, so it ends at the
 * last `)`.
 */
export function parseProcStat(text: string): { comm: string; ppid: number } | null {
  const open = text.indexOf('(')
  const close = text.lastIndexOf(')')
  if (open < 0 || close < open) return null
  const fields = text.slice(close + 1).trim().split(/\s+/)
  const ppid = Number(fields[1])
  return Number.isInteger(ppid) && ppid >= 0 ? { comm: text.slice(open + 1, close), ppid } : null
}

/** VmRSS from a `/proc/<pid>/status` text, in bytes (0 when absent, as for a zombie). */
export function parseVmRssBytes(status: string): number {
  const m = /^VmRSS:\s+([0-9]+)\s+kB$/m.exec(status)
  return m ? Number(m[1]) * 1024 : 0
}

/** Pss from a `/proc/<pid>/smaps_rollup` text, in bytes, or `null` when it has no `Pss:` line. */
export function parsePssBytes(smapsRollup: string): number | null {
  const m = /^Pss:\s+([0-9]+)\s+kB$/m.exec(smapsRollup)
  return m ? Number(m[1]) * 1024 : null
}

/** Chrome's processes: the browser, its zygotes, renderers, GPU and utility processes, the crash handler. */
const CHROME_COMM_RE = /^(chrome|chromium|headless_shell)/i
const CHROME_PROGRAM_RE = /(^|\/)(chrome|chromium|chromium-browser|headless_shell)(\s|$)/

export interface ChromeTreePss {
  /** The summed PSS, with each of the `rssFallbacks` processes counted by its RSS instead. */
  pssBytes: number
  /** The processes whose smaps_rollup could not be read (or had no Pss), counted by RSS. */
  rssFallbacks: number
  processes: number
}

/** One process's PSS, or its RSS when its smaps_rollup can't be read; `null` when it is gone. */
function processMemory(pid: number, reader: ProcReader): { bytes: number; rssFallback: boolean } | null {
  const rollup = reader.smapsRollup(pid)
  const pss = rollup === null ? null : parsePssBytes(rollup)
  if (pss !== null) return { bytes: pss, rssFallback: false }
  const status = reader.status(pid)
  return status === null ? null : { bytes: parseVmRssBytes(status), rssFallback: true }
}

/** The children of each PID, and each PID's command name, from /proc's stat files. */
function processTable(reader: ProcReader): { children: Map<number, number[]>; comms: Map<number, string> } {
  const children = new Map<number, number[]>()
  const comms = new Map<number, string>()
  for (const pid of reader.pids()) {
    const parsed = parseProcStat(reader.stat(pid) ?? '')
    if (!parsed) continue
    comms.set(pid, parsed.comm)
    const siblings = children.get(parsed.ppid) ?? []
    siblings.push(pid)
    children.set(parsed.ppid, siblings)
  }
  return { children, comms }
}

/** The summed PSS of every descendant of `root` that is a Chrome process (RSS for one whose PSS can't be read). */
export function chromeTreePss(root: number, reader: ProcReader = nodeProcReader): ChromeTreePss {
  const { children, comms } = processTable(reader)
  let pssBytes = 0
  let rssFallbacks = 0
  let processes = 0
  const seen = new Set<number>([root])
  const queue = [...(children.get(root) ?? [])]
  while (queue.length > 0) {
    const pid = queue.shift() as number
    if (seen.has(pid)) continue
    seen.add(pid)
    queue.push(...(children.get(pid) ?? []))
    const isChrome = CHROME_COMM_RE.test(comms.get(pid) ?? '') || CHROME_PROGRAM_RE.test((reader.cmdline(pid) ?? '').split(' ')[0] ?? '')
    if (!isChrome) continue
    const memory = processMemory(pid, reader)
    if (memory === null) continue
    pssBytes += memory.bytes
    if (memory.rssFallback) rssFallbacks += 1
    processes += 1
  }
  return { pssBytes, rssFallbacks, processes }
}
