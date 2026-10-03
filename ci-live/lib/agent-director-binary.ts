/**
 * agent-director-binary.ts — select the agent-director binary the live image
 * is built with (runtime/container-run.ts stages a read-only copy of it as a
 * named build context): the one given with `--agent-director-binary`, checked
 * by reading only, or, when none is given, the host's, found by search.
 *
 * Only reads: a realpath, a stat and an access check per path, through an
 * injectable probe (tests pass a fake). Nothing runs the binary.
 */

import { accessSync, constants, realpathSync, statSync } from 'node:fs'
import { delimiter, join } from 'node:path'

import { AGENT_DIRECTOR_BINARY_OPTION } from './args.ts'

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

const OPTION = AGENT_DIRECTOR_BINARY_OPTION

/** A path given with `--agent-director-binary`, checked: its real path, or why it cannot be staged. */
export type GivenBinaryCheck = { ok: true; path: string } | { ok: false; reason: string }

/**
 * Check a path given with `--agent-director-binary` by reading only: it must
 * resolve (a missing file or a dangling symlink does not), and its real path
 * must be a regular file with the execute bit for this process. The probe
 * reads the given path and the real path it resolves to, nothing else: no
 * HOME, no PATH, no other candidate. Nothing runs the file. The reason never
 * repeats the path (a usage slip could have pasted anything there).
 */
export function checkGivenAgentDirectorBinary(given: string, probe: BinaryProbe = nodeBinaryProbe): GivenBinaryCheck {
  let real: string
  try {
    real = probe.realpath(given)
  } catch {
    return { ok: false, reason: `the path given with ${OPTION} does not exist (a missing file or a dangling symlink)` }
  }
  let isFile: boolean
  try {
    isFile = probe.isFile(real)
  } catch {
    return { ok: false, reason: `the path given with ${OPTION} cannot be read (its stat failed)` }
  }
  if (!isFile) return { ok: false, reason: `the path given with ${OPTION} is not a regular file` }
  try {
    probe.assertExecutable(real)
  } catch {
    return { ok: false, reason: `the file given with ${OPTION} is not executable (no execute bit for this user)` }
  }
  return { ok: true, path: real }
}

/**
 * The binary the live image is built with: the one given (`source: 'given'`),
 * its real path or, when it cannot be staged, `path: null` and the reason;
 * or, with none given, `hostAgentDirectorBinary`'s answer (`source: 'found'`,
 * `null` when the host has none).
 */
export type AgentDirectorBinarySelection =
  | { source: 'given'; path: string }
  | { source: 'given'; path: null; reason: string }
  | { source: 'found'; path: string | null }

/**
 * The one way the runner picks its agent-director binary. A given path is
 * checked (`checkGivenAgentDirectorBinary`) and never falls back to the
 * search: no host path is searched for it. With none given, the host search
 * (`hostAgentDirectorBinary(home, path)`) answers.
 */
export function selectAgentDirectorBinary(
  given: string | undefined,
  home: string,
  path: string | undefined,
  probe: BinaryProbe = nodeBinaryProbe,
): AgentDirectorBinarySelection {
  if (given !== undefined) {
    const checked = checkGivenAgentDirectorBinary(given, probe)
    return checked.ok ? { source: 'given', path: checked.path } : { source: 'given', path: null, reason: checked.reason }
  }
  return { source: 'found', path: hostAgentDirectorBinary(home, path, probe) }
}
