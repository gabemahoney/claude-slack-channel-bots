/**
 * proc.ts — running a host command with an explicit environment.
 *
 * Every child the runner starts (docker, npm pack, the host-state probes)
 * gets an environment built here, never the runner's own: the host shell
 * holds production Slack tokens and the worker's own Claude credentials,
 * which must never reach a child. `minimalChildEnv` keeps only what the
 * tools need to find themselves and the docker daemon.
 */

export interface ProcResult {
  code: number
  stdout: string
  stderr: string
  timedOut: boolean
}

export interface SpawnOptions {
  env: Record<string, string>
  timeoutMs: number
  stdin?: string
  cwd?: string
}

export type SpawnFn = (argv: readonly string[], options: SpawnOptions) => Promise<ProcResult>

/**
 * Host variables a child may inherit: paths, locale, docker's own settings
 * and `TMUX_TMPDIR` (so the HOST check's `tmux ls`, and the tmux that
 * agent-director drives, find the socket the production bots use; the
 * agent-director binary has no state-dir variable, its store is a flag). No
 * secret.
 */
export const CHILD_ENV_ALLOWLIST = [
  'PATH',
  'HOME',
  'USER',
  'LOGNAME',
  'LANG',
  'LC_ALL',
  'TMPDIR',
  'TMUX_TMPDIR',
  'XDG_RUNTIME_DIR',
  'DOCKER_HOST',
  'DOCKER_CONFIG',
  'DOCKER_CONTEXT',
  'DOCKER_BUILDKIT',
] as const

/** The allowlisted subset of `hostEnv`. */
export function minimalChildEnv(hostEnv: Record<string, string | undefined>): Record<string, string> {
  const out: Record<string, string> = {}
  for (const name of CHILD_ENV_ALLOWLIST) {
    const value = hostEnv[name]
    if (value !== undefined && value !== '') out[name] = value
  }
  return out
}

/** `Bun.spawn` with a hard timeout; output is collected as text. */
export const bunSpawn: SpawnFn = async (argv, options) => {
  const child = Bun.spawn([...argv], {
    env: options.env,
    cwd: options.cwd,
    stdin: options.stdin !== undefined ? new TextEncoder().encode(options.stdin) : 'ignore',
    stdout: 'pipe',
    stderr: 'pipe',
  })
  let timedOut = false
  const timer = setTimeout(() => {
    timedOut = true
    child.kill('SIGKILL')
  }, options.timeoutMs)
  try {
    const [stdout, stderr, code] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ])
    return { code: timedOut ? 124 : code, stdout, stderr, timedOut }
  } finally {
    clearTimeout(timer)
  }
}
