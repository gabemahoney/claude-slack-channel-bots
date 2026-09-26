/**
 * host-state.ts — the HOST check's read-only view of the production side of
 * this machine, taken before the run and again after it:
 * - the host's `service=cscb` agent-director rows (instance IDs);
 * - the host's `slack_bot_*` / `cscb_*` tmux sessions;
 * - the PID listening on host port 3100 (read from /proc, nothing connects);
 * - the sha256 of the host's `~/.claude/channels/slack/config.json`.
 *
 * Only reads: `agent-director list`, `tmux ls`, /proc and a file hash. Never
 * a start, stop, kill, connect or write. The probes read the state the
 * production bots use: `agent-director` with the store path CSCB pins
 * (`--store-path ~/.agent-director/state.db`), `tmux` with the host's
 * `TMUX_TMPDIR` (passed through by `minimalChildEnv`). The run passes the HOST
 * check only when both snapshots are equal and no probe failed.
 */

import { createHash } from 'node:crypto'
import { readFileSync, readdirSync, readlinkSync } from 'node:fs'
import { join } from 'node:path'

import type { ProcResult } from './proc.ts'

export const HOST_PORT = 3100

export interface HostSnapshot {
  adRows: string[] | string
  tmuxSessions: string[] | string
  port3100: string
  configSha256: string
}

export interface HostProbeDeps {
  run(argv: readonly string[]): Promise<ProcResult>
  readFile(path: string): Buffer | null
  /** The PID(s) listening on `port`, or 'none'. */
  listener(port: number): string
}

/** The inodes of sockets in LISTEN state on `port` in a /proc/net/tcp(6) table. */
export function parseListenInodes(table: string, port: number): string[] {
  const hexPort = port.toString(16).toUpperCase().padStart(4, '0')
  const out: string[] = []
  for (const line of table.split('\n').slice(1)) {
    const fields = line.trim().split(/\s+/)
    if (fields.length < 10) continue
    const local = fields[1] ?? ''
    const state = fields[3]
    if (state === '0A' && local.toUpperCase().endsWith(`:${hexPort}`)) out.push(fields[9] as string)
  }
  return out
}

/** Read-only /proc lookup of who listens on a TCP port (only this user's processes are visible). */
export function procListener(port: number): string {
  const inodes = new Set<string>()
  for (const table of ['/proc/net/tcp', '/proc/net/tcp6']) {
    try {
      for (const inode of parseListenInodes(readFileSync(table, 'utf-8'), port)) inodes.add(inode)
    } catch {
      /* ignore: table missing */
    }
  }
  if (inodes.size === 0) return 'none'
  const pids = new Set<string>()
  for (const pid of readdirSync('/proc').filter((e) => /^\d+$/.test(e))) {
    let fds: string[]
    try {
      fds = readdirSync(join('/proc', pid, 'fd'))
    } catch {
      continue
    }
    for (const fd of fds) {
      try {
        const target = readlinkSync(join('/proc', pid, 'fd', fd))
        const m = /^socket:\[(\d+)\]$/.exec(target)
        if (m && inodes.has(m[1] as string)) pids.add(pid)
      } catch {
        /* ignore: fd closed */
      }
    }
  }
  return pids.size > 0 ? [...pids].sort().join(',') : `listening (owner not visible)`
}

export function parseAdRows(stdout: string): string[] | null {
  try {
    const parsed = JSON.parse(stdout) as { spawns?: unknown }
    if (!Array.isArray(parsed.spawns)) return null
    return parsed.spawns
      .map((s) => (s && typeof s === 'object' ? String((s as Record<string, unknown>).claude_instance_id ?? '?') : '?'))
      .sort()
  } catch {
    return null
  }
}

export const HOST_TMUX_RE = /^(slack_bot_|cscb_)/

export function parseTmuxSessions(stdout: string): string[] {
  return stdout
    .split('\n')
    .map((s) => s.trim())
    .filter((s) => HOST_TMUX_RE.test(s))
    .sort()
}

/** The agent-director store CSCB pins (`DEFAULT_STORE_PATH` in src/agent-director-client.ts), under `home`. */
export function hostStorePath(home: string): string {
  return join(home, '.agent-director', 'state.db')
}

/**
 * `tmux ls` stderr when no tmux server runs (no socket, or nothing listening
 * on it): no sessions. The copy of the container's logs reads the container's
 * `tmux ls` with it too (lib/container-logs.ts).
 */
export const TMUX_NO_SERVER_RE = /no server running|error connecting to .*\(No such file or directory\)/

export async function snapshotHost(deps: HostProbeDeps, home: string): Promise<HostSnapshot> {
  const ad = await deps.run(['agent-director', '--store-path', hostStorePath(home), 'list', '--label', 'service=cscb'])
  const adRows = ad.code === 0 ? (parseAdRows(ad.stdout) ?? 'agent-director list: unparsable output') : `agent-director list exit ${ad.code}`
  const tmux = await deps.run(['tmux', 'ls', '-F', '#{session_name}'])
  const tmuxSessions = tmux.code === 0 ? parseTmuxSessions(tmux.stdout) : TMUX_NO_SERVER_RE.test(tmux.stderr) ? [] : `tmux ls exit ${tmux.code}`
  const config = deps.readFile(join(home, '.claude', 'channels', 'slack', 'config.json'))
  const configSha256 = config ? createHash('sha256').update(config).digest('hex') : 'absent'
  return { adRows, tmuxSessions, port3100: deps.listener(HOST_PORT), configSha256 }
}

/** The probes of a snapshot that failed (their error text), so a comparison of two failures never passes. */
export function probeFailures(s: HostSnapshot): string[] {
  const out: string[] = []
  if (typeof s.adRows === 'string') out.push(s.adRows)
  if (typeof s.tmuxSessions === 'string') out.push(s.tmuxSessions)
  return out
}

/** Human-readable differences between two snapshots (IDs and hashes only). */
export function compareSnapshots(before: HostSnapshot, after: HostSnapshot): string[] {
  const diffs: string[] = []
  const show = (v: string[] | string): string => (Array.isArray(v) ? `[${v.join(', ')}]` : v)
  if (show(before.adRows) !== show(after.adRows)) diffs.push(`agent-director service=cscb rows ${show(before.adRows)} → ${show(after.adRows)}`)
  if (show(before.tmuxSessions) !== show(after.tmuxSessions)) {
    diffs.push(`tmux sessions ${show(before.tmuxSessions)} → ${show(after.tmuxSessions)}`)
  }
  if (before.port3100 !== after.port3100) diffs.push(`port ${HOST_PORT} listener ${before.port3100} → ${after.port3100}`)
  if (before.configSha256 !== after.configSha256) diffs.push('host config.json sha256 changed')
  return diffs
}

export function describeSnapshot(s: HostSnapshot): string {
  const rows = Array.isArray(s.adRows) ? `${s.adRows.length} row(s) [${s.adRows.join(', ')}]` : s.adRows
  const tmux = Array.isArray(s.tmuxSessions) ? `${s.tmuxSessions.length} session(s) [${s.tmuxSessions.join(', ')}]` : s.tmuxSessions
  return `service=cscb rows: ${rows}; tmux: ${tmux}; port ${HOST_PORT}: ${s.port3100}; config.json sha256: ${s.configSha256.slice(0, 16)}…`
}
