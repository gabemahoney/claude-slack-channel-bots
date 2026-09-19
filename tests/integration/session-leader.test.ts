/**
 * session-leader.test.ts — Integration coverage for the b.acn session-leader
 * detection on a REAL detached process.
 *
 * The unit tests in tests/cli.test.ts exercise the leaked-marker (NOT a session
 * leader) branch by construction: the `bun test` runner is not a session leader,
 * so a preset _CLI_DAEMON_CHILD marker looks leaked. What they cannot exercise
 * is the genuine-child path — a real `detached: true` subprocess IS a session
 * leader, so isSessionLeader() must return true for it and the daemon runs in
 * place. The dangerous failure mode is isSessionLeader() returning false for a
 * real detached child: that would make `start` re-detach forever (infinite
 * respawn loop).
 *
 * This test spawns a trivial throwaway bun subprocess with detached:true (setsid)
 * that reports whether its /proc/self/stat session id equals its own pid, using
 * the SAME stat-parsing logic as src/cli.ts isSessionLeader(). It validates that
 * parsing on a real session leader. It starts NO server and touches no CSCB
 * state — the child prints one line and exits.
 *
 * Linux-only (/proc). Skipped elsewhere.
 *
 * SPDX-License-Identifier: MIT
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const HAS_PROC = existsSync('/proc/self/stat')

// The child mirrors src/cli.ts isSessionLeader(): read field 4 (session) after
// the comm field, compare to pid. Printed as a single JSON line on stdout.
const CHILD_SCRIPT = `
import { readFileSync } from 'node:fs'
const stat = readFileSync('/proc/self/stat', 'utf8')
const fields = stat.slice(stat.lastIndexOf(') ') + 2).split(' ')
const session = parseInt(fields[3] ?? '', 10)
process.stdout.write(JSON.stringify({ pid: process.pid, session }) + '\\n')
`

describe('isSessionLeader stat parsing on a real detached child (b.acn)', () => {
  let scratchDir: string
  let scriptPath: string

  beforeAll(() => {
    scratchDir = mkdtempSync(join(tmpdir(), 'cscb-acn-int-'))
    scriptPath = join(scratchDir, 'report-session.ts')
    writeFileSync(scriptPath, CHILD_SCRIPT)
  })

  afterAll(() => {
    try { rmSync(scratchDir, { recursive: true, force: true }) } catch { /* ignore */ }
  })

  test.skipIf(!HAS_PROC)(
    'a detached:true subprocess is its own session leader (session id === pid)',
    async () => {
      // Use Bun.spawn (not node:child_process) so this test is unaffected by
      // any process-global child_process module mock leaked from another suite.
      // detached:true makes the child a session leader via setsid(2) — the exact
      // condition src/cli.ts requires before trusting the daemon marker.
      const child = Bun.spawn([process.execPath, scriptPath], {
        stdin: 'ignore',
        stdout: 'pipe',
        stderr: 'ignore',
        // @ts-expect-error Bun typings may lag; detached is honored at runtime.
        detached: true,
      })
      const out = await new Response(child.stdout).text()
      await child.exited
      let result: { pid: number; session: number }
      try {
        result = JSON.parse(out.trim())
      } catch (e) {
        throw new Error(`child produced unparseable output: ${JSON.stringify(out)} (${e})`)
      }

      // The child's own pid must be a real number...
      expect(result.pid).toBeGreaterThan(0)
      // ...and, because it was spawned detached (setsid), it leads its own
      // session: session id === pid. If this ever fails, isSessionLeader()
      // would return false for a genuine daemon child → infinite respawn loop.
      expect(result.session).toBe(result.pid)
    },
  )
})
