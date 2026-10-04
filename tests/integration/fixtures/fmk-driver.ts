/**
 * fmk-driver.ts — the driver of the calls an fmk scenario forces (b.jg5
 * SRJ-1306). It drives production functions of the installed package (the
 * tarball under test) against the real agent-director and tmux of the
 * scenario's own HOME, as `driver.ts` does for test-4, for the calls a
 * scenario cannot get from the bot server alone: a `resume` in scenario 5, a
 * reuse spawn in scenarios 8 and 25, and a CSCB call made with another
 * `TMUX_TMPDIR` in scenario 26. Each forced call is one entry of
 * `FORCED_CALLS`.
 *
 * REFUSAL
 * -------
 * Runs only in a cscb-ci image. Its first statement checks for the image
 * marker `/etc/cscb-ci-image`; without it, the driver prints
 * `FAIL: fmk-driver: refused: /etc/cscb-ci-image is absent …` on stderr and
 * exits 2, before it reads an argument or loads a module. Only `node:`
 * built-ins are imported statically: the package under test and the
 * agent-director client that package resolves are imported dynamically, after
 * the check, by the forced call that needs them, through the context's
 * `importPackageModule` and `importAgentDirectorClient`.
 *
 * USAGE
 * -----
 *   bun fmk-driver.ts <forced-call> [<arg>...]
 *
 *   CSCB_PKG_DIR   the installed package (default
 *                  /test-repo/node_modules/claude-slack-channel-bots)
 *
 * With no forced call named, it prints
 * `FAIL: fmk-driver: no forced call was named …` on stderr and exits 64; with
 * an unknown one, `FAIL: fmk-driver: unknown forced call '<name>' …`, also
 * exit 64. A forced call's output and exit status are its own.
 */
import { existsSync } from 'node:fs'
import { join } from 'node:path'

if (!existsSync('/etc/cscb-ci-image')) {
  console.error('FAIL: fmk-driver: refused: /etc/cscb-ci-image is absent; this driver runs only in a cscb-ci image (/ci)')
  process.exit(2)
}

/** The name the driver's FAIL lines carry. */
const DRIVER_NAME = 'fmk-driver'

/** Exit status for a missing or unknown forced call (EX_USAGE). */
const USAGE_EXIT = 64

/** The installed package under test. */
const PKG_DIR = process.env['CSCB_PKG_DIR'] ?? '/test-repo/node_modules/claude-slack-channel-bots'

/** What a forced call gets besides its arguments: the dynamic loaders. */
interface ForcedCallContext {
  /** Import a module of the installed package's `src/` (for example `session-manager.ts`). */
  importPackageModule(relPath: string): Promise<Record<string, unknown>>
  /** Import the agent-director client the installed package resolves. */
  importAgentDirectorClient(): Promise<Record<string, unknown>>
}

/** One forced call: runs with its arguments and returns the driver's exit status. */
type ForcedCall = (args: readonly string[], context: ForcedCallContext) => Promise<number>

/** The forced calls, by the name the scenario passes. */
const FORCED_CALLS: Readonly<Record<string, ForcedCall>> = {}

const context: ForcedCallContext = {
  async importPackageModule(relPath) {
    return await import(join(PKG_DIR, 'src', relPath))
  },
  async importAgentDirectorClient() {
    return await import(Bun.resolveSync('agent-director', join(PKG_DIR, 'src')))
  },
}

function usageFail(detail: string): number {
  const known = Object.keys(FORCED_CALLS).sort()
  console.error(`FAIL: ${DRIVER_NAME}: ${detail}; usage: bun fmk-driver.ts <forced-call> [<arg>...] (forced calls: ${known.length > 0 ? known.join(', ') : 'none'})`)
  return USAGE_EXIT
}

async function main(argv: readonly string[]): Promise<number> {
  const [name, ...args] = argv
  if (name === undefined || name === '') return usageFail('no forced call was named')
  const call = Object.hasOwn(FORCED_CALLS, name) ? FORCED_CALLS[name] : undefined
  if (call === undefined) return usageFail(`unknown forced call '${name}'`)
  return await call(args, context)
}

process.exit(await main(process.argv.slice(2)))
