/**
 * agent-director-binary.ts — find the host's agent-director binary, which
 * the live image is built with (runtime/container-run.ts stages a read-only
 * copy of it as a named build context).
 *
 * Only reads: an access check, a realpath and a stat per candidate, through
 * an injectable probe (tests pass a fake). Nothing runs the binary.
 */

import { accessSync, constants, realpathSync, statSync } from 'node:fs'
import { delimiter, join } from 'node:path'

/** The file-system reads the search makes. */
export interface BinaryProbe {
  /** Throws unless `path` is executable by this process. */
  assertExecutable(path: string): void
  realpath(path: string): string
  isFile(path: string): boolean
}

export const nodeBinaryProbe: BinaryProbe = {
  assertExecutable: (path) => accessSync(path, constants.X_OK),
  realpath: (path) => realpathSync(path),
  isFile: (path) => statSync(path).isFile(),
}

/**
 * The agent-director binary the production CSCB on this host runs, found as
 * agent-director's own client finds it: `~/.agent-director/bin/agent-director`,
 * else `agent-director` on PATH. Its real path, or `null`.
 */
export function hostAgentDirectorBinary(home: string, path: string | undefined, probe: BinaryProbe = nodeBinaryProbe): string | null {
  const candidates = [join(home, '.agent-director', 'bin', 'agent-director'), ...(path ?? '').split(delimiter).filter(Boolean).map((d) => join(d, 'agent-director'))]
  for (const candidate of candidates) {
    try {
      probe.assertExecutable(candidate)
      const real = probe.realpath(candidate)
      if (probe.isFile(real)) return real
    } catch {
      /* not this one */
    }
  }
  return null
}
