/**
 * tmux.ts — TmuxClient interface, defaultTmuxClient implementation, and helpers.
 *
 * SPDX-License-Identifier: MIT
 */

import { $ } from 'bun'

// ---------------------------------------------------------------------------
// Interface
// ---------------------------------------------------------------------------

export interface TmuxClient {
  /** Check that tmux is installed; resolves with version string (e.g. "tmux 3.3a"). */
  checkAvailability(): Promise<string>
  /** Returns true if a session with the given name exists. */
  hasSession(name: string): Promise<boolean>
  /** Returns the PID of the first pane in the session as a string. */
  getPanePid(session: string): Promise<string>
  /** Creates a new detached tmux session with the given name and working directory. */
  newSession(name: string, cwd: string): Promise<void>
  /** Sends keystrokes to the given session. */
  sendKeys(session: string, keys: string): Promise<void>
  /** Returns the current text content of the session's pane. */
  capturePane(session: string): Promise<string>
  /** Kills the named tmux session. */
  killSession(session: string): Promise<void>
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Returns the canonical tmux session name for a given Slack channel ID. */
export function sessionName(channelId: string): string {
  return `slack_channel_bot_${channelId}`
}

// ---------------------------------------------------------------------------
// Default implementation
// ---------------------------------------------------------------------------

export const defaultTmuxClient: TmuxClient = {
  async checkAvailability(): Promise<string> {
    try {
      return (await $`tmux -V`.text()).trim()
    } catch (err) {
      console.error('[slack] tmux checkAvailability failed:', err)
      throw err
    }
  },

  async hasSession(name: string): Promise<boolean> {
    try {
      const result = await $`tmux has-session -t ${name}`.nothrow()
      return result.exitCode === 0
    } catch (err) {
      console.error('[slack] tmux hasSession failed:', err)
      return false
    }
  },

  async getPanePid(session: string): Promise<string> {
    try {
      const paneFormat = '#{pane_pid}'
      return (await $`tmux list-panes -t ${session} -F ${paneFormat}`.text()).trim()
    } catch (err) {
      console.error('[slack] tmux getPanePid failed:', err)
      throw err
    }
  },

  async newSession(name: string, cwd: string): Promise<void> {
    try {
      await $`tmux new-session -d -s ${name} -c ${cwd}`
    } catch (err) {
      console.error('[slack] tmux newSession failed:', err)
      throw err
    }
  },

  async sendKeys(session: string, keys: string): Promise<void> {
    try {
      await $`tmux send-keys -t ${session} ${keys}`
    } catch (err) {
      console.error('[slack] tmux sendKeys failed:', err)
      throw err
    }
  },

  async capturePane(session: string): Promise<string> {
    try {
      return await $`tmux capture-pane -t ${session} -p`.text()
    } catch (err) {
      console.error('[slack] tmux capturePane failed:', err)
      throw err
    }
  },

  async killSession(session: string): Promise<void> {
    try {
      await $`tmux kill-session -t ${session}`
    } catch (err) {
      console.error('[slack] tmux killSession failed:', err)
      throw err
    }
  },
}

// ---------------------------------------------------------------------------
// isClaudeRunning
// ---------------------------------------------------------------------------

/**
 * Returns true if a 'claude' process is found in the process tree
 * rooted at the given tmux session's pane PID.
 */
export async function isClaudeRunning(session: string, client: TmuxClient): Promise<boolean> {
  let panePid: string
  try {
    panePid = await client.getPanePid(session)
  } catch {
    return false
  }

  const rootPid = parseInt(panePid, 10)
  if (isNaN(rootPid) || rootPid <= 0) return false

  try {
    // Build a map of pid → {ppid, comm} from the full process table.
    // Skip the header line by slicing from index 1.
    const psOut = await $`ps -eo pid,ppid,comm`.text()
    const processes = new Map<number, { ppid: number; comm: string }>()
    for (const line of psOut.split('\n').slice(1)) {
      const parts = line.trim().split(/\s+/)
      if (parts.length < 3) continue
      const pid = parseInt(parts[0], 10)
      const ppid = parseInt(parts[1], 10)
      const comm = parts[2]
      if (!isNaN(pid) && !isNaN(ppid)) {
        processes.set(pid, { ppid, comm })
      }
    }

    // BFS to collect all PIDs in the subtree rooted at rootPid.
    const subtree = new Set<number>([rootPid])
    const queue = [rootPid]
    while (queue.length > 0) {
      const current = queue.shift()!
      for (const [pid, { ppid }] of processes) {
        if (ppid === current && !subtree.has(pid)) {
          subtree.add(pid)
          queue.push(pid)
        }
      }
    }

    // Return true if any process in the subtree has 'claude' in its name.
    for (const pid of subtree) {
      const entry = processes.get(pid)
      if (entry && entry.comm.toLowerCase().includes('claude')) return true
    }
    return false
  } catch (err) {
    console.error('[slack] isClaudeRunning: process tree check failed:', err)
    return false
  }
}
