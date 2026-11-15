/** CSCB's credentials are never inherited by a child process. */
export function isCscbSecretName(name: string): boolean {
  return /^SLACK_.*(?:TOKEN|SECRET)$/i.test(name)
}

const DAEMON_MARKER = '_CLI_DAEMON_CHILD'

/** Copy the host environment, keeping the marker only for a new daemon. */
export function childEnv(
  source: NodeJS.ProcessEnv,
  { daemonChild = false }: { daemonChild?: boolean } = {},
): NodeJS.ProcessEnv {
  const env = Object.fromEntries(
    Object.entries(source).filter(([name]) => !isCscbSecretName(name) && name !== DAEMON_MARKER),
  )
  if (daemonChild) env[DAEMON_MARKER] = '1'
  return env
}

/** Clean the environment the agent-director library reads on each call. */
export function scrubProcessEnv(
  env: NodeJS.ProcessEnv = process.env,
  { keepDaemonMarker = false }: { keepDaemonMarker?: boolean } = {},
): void {
  for (const name of Object.keys(env)) {
    if (isCscbSecretName(name) || (name === DAEMON_MARKER && !keepDaemonMarker)) delete env[name]
  }
}
