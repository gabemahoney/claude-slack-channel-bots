/**
 * container.ts — `inContainer`: the one way the runner starts, stops or
 * changes CSCB, tmux or agent-director. Every such command runs through
 * `docker exec` in the test container, whose name must be a `cscb-live-<id>`
 * name; nothing here can build a command for the host.
 *
 * `sh` runs a bash script as the container's test user with the testplan's
 * shell helpers (`~/cscb-live-helpers.sh`, Part 1.3 adapted to the container)
 * loaded, so a check reads exactly what the plan's commands print.
 */

import { buildExecArgs, isLiveContainerName, type DockerCli } from './docker.ts'
import type { ProcResult } from './proc.ts'

export const HELPERS_PATH = '~/cscb-live-helpers.sh'

export const DEFAULT_EXEC_TIMEOUT_MS = 120_000

export interface ExecOptions {
  timeoutMs?: number
  user?: 'testuser' | 'root'
  stdin?: string
}

/** What a check needs from the container. */
export interface ContainerExec {
  readonly name: string
  /** Run `argv` in the container. */
  exec(argv: readonly string[], options?: ExecOptions): Promise<ProcResult>
  /** Run a bash script as the test user, with the helpers sourced. */
  sh(script: string, options?: ExecOptions): Promise<ProcResult>
  /** Write `content` to `path` in the container (as the test user), atomically. */
  writeFile(path: string, content: string, mode?: string): Promise<void>
}

/** The script `sh` runs: the helpers, then the caller's script. */
export function helperScript(script: string): string {
  return `source ${HELPERS_PATH} || exit 97\n${script}`
}

export class TestContainer implements ContainerExec {
  constructor(
    private readonly docker: DockerCli,
    readonly name: string,
  ) {
    if (!isLiveContainerName(name)) throw new Error(`refusing to exec in a container not named cscb-live-<id>`)
  }

  exec(argv: readonly string[], options: ExecOptions = {}): Promise<ProcResult> {
    return this.docker.run(buildExecArgs(this.name, argv, { user: options.user, interactive: options.stdin !== undefined }), {
      timeoutMs: options.timeoutMs ?? DEFAULT_EXEC_TIMEOUT_MS,
      stdin: options.stdin,
    })
  }

  sh(script: string, options: ExecOptions = {}): Promise<ProcResult> {
    return this.exec(['bash', '-c', helperScript(script)], options)
  }

  async writeFile(path: string, content: string, mode = '644'): Promise<void> {
    if (!/^[0-7]{3}$/.test(mode)) throw new Error('mode must be three octal digits')
    const script =
      'set -e; t="$1.tmp.$$"; cat > "$t"; chmod "$2" "$t"; mv "$t" "$1"'
    const r = await this.exec(['bash', '-c', script, 'write', path, mode], { stdin: content })
    if (r.code !== 0) throw new Error(`writing ${path} in the container failed (exit ${r.code})`)
  }
}
