/** Import-safe admission. Token values live only in the lease closure. */
import { constants, closeSync, fstatSync, lstatSync, openSync, readFileSync, readSync, realpathSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { CODEX_CONFIG_MAX_BYTES, encodeCodexHostConfigKeys, readCodexConfigModel, scanCodexConfigKeyPaths } from '../src/codex-config-keys.ts'
export { CODEX_HOST_CONFIG_KEYS_ENV, decodeCodexHostConfigKeys } from '../src/codex-config-keys.ts'

export const CODEX_LOGIN_TARGET = '/run/codex-login/auth.json'
export const CODEX_LOGIN_LOCK_WAIT_MS = 30 * 60 * 1000
export const CODEX_EXTRA_MEMORY_BYTES = 2 * 1024 ** 3
export const CODEX_VERSION = '0.159.2'
// Survives a runner's death, unlike its process-owned flock. Both runners
// refuse admission while any earlier login-mounted container still exists.
export const CODEX_LOGIN_CONTAINER_LABEL = 'cscb.codex-login=true'
export function codexLoginContainerListArgs(): string[] {
  return ['docker', 'container', 'ls', '--all', '--filter', `label=${CODEX_LOGIN_CONTAINER_LABEL}`, '--quiet']
}
export function assertNoCodexLoginContainers(code: number, output: string): void {
  if (code !== 0) throw new Error('Could not verify retirement of Codex login containers; admission refused')
  if (output.trim()) throw new Error('An earlier Codex login container remains; retire it before starting another run')
}
export const CODEX_LOGIN_SCRIPTS = /-fmk-real-codex(?:-[a-z0-9-]+)?\.sh$/
export function isCodexScript(name: string): boolean { return CODEX_LOGIN_SCRIPTS.test(name) }
export function codexModelFromConfig(text: string, path: string): string {
  let model: unknown
  try { model = readCodexConfigModel(text) } catch { /* Never echo config contents. */ }
  if (typeof model !== 'string' || !/^[A-Za-z0-9._:/-]+$/.test(model)) {
    throw new Error(`Codex model missing or invalid in ${path}; set a top-level model there`)
  }
  return model
}
export interface LoginIdentity { readonly dev: number; readonly ino: number; readonly uid: number; readonly mode: number }
export interface LoginRead { readonly identity: LoginIdentity; readonly json: unknown }
export interface CodexLock {
  tryLock(): { kind: 'taken' | 'held' } | { kind: 'error'; error: string }
  release(): void
}
export interface CodexLoginDeps {
  readConfig(path: string): string
  readLogin(path: string): LoginRead
  resolveLogin(path: string): string
  openLock(path: string): CodexLock
  now(): number
  sleep(ms: number): Promise<void>
}
/** The descriptor is O_NOFOLLOW; no credential bytes can enter an exception. */
export function readCodexLogin(path: string): LoginRead {
  const entry = lstatSync(path)
  if (!entry.isFile() || entry.isSymbolicLink()) throw new Error('Codex login must be a regular non-symlink file')
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | 0o2000000)
  try {
    const before = fstatSync(fd)
    if (!before.isFile() || before.dev !== entry.dev || before.ino !== entry.ino) throw new Error('Codex login identity changed')
    if (before.size > 1024 * 1024) throw new Error('Codex login is too large')
    let json: unknown
    try { json = JSON.parse(readFileSync(fd, 'utf8')) } catch { throw new Error('Codex login is not valid JSON') }
    const after = fstatSync(fd)
    const finalEntry = lstatSync(path)
    if (!finalEntry.isFile() || finalEntry.isSymbolicLink() || finalEntry.dev !== after.dev || finalEntry.ino !== after.ino) throw new Error('Codex login identity changed')
    if (after.dev !== before.dev || after.ino !== before.ino || after.uid !== before.uid || after.mode !== before.mode) throw new Error('Codex login identity changed')
    return { identity: { dev: after.dev, ino: after.ino, uid: after.uid, mode: after.mode & 0o7777 }, json }
  } finally { closeSync(fd) }
}
export function realCodexLoginDeps(openLock: CodexLoginDeps['openLock']): CodexLoginDeps {
  return { readConfig: path => {
    const fd = openSync(path, constants.O_RDONLY | constants.O_NONBLOCK)
    try {
      const stat = fstatSync(fd)
      if (!stat.isFile() || stat.size > CODEX_CONFIG_MAX_BYTES) throw new Error('Codex config key projection is unavailable')
      const bytes = Buffer.alloc(CODEX_CONFIG_MAX_BYTES + 1)
      let size = 0
      while (size < bytes.length) {
        const count = readSync(fd, bytes, size, bytes.length - size, null)
        if (!count) break
        size += count
      }
      if (size > CODEX_CONFIG_MAX_BYTES) throw new Error('Codex config key projection is unavailable')
      return new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, size))
    } finally { closeSync(fd) }
  }, readLogin: readCodexLogin,
    resolveLogin: realpathSync, openLock, now: Date.now, sleep: ms => Bun.sleep(ms) }
}
function collectTokens(value: unknown, into: Set<string>, secret = false): void {
  if (typeof value === 'string') { if (secret && value) into.add(value); return }
  if (!value || typeof value !== 'object') return
  for (const [key, item] of Object.entries(value)) collectTokens(item, into, secret || /token|api.?key|secret/i.test(key))
}
export interface CodexLoginLease {
  readonly model: string
  readonly source: string
  /** Names only: no host config setting values are retained or transported. */
  readonly hostConfigKeys: string
  /** A copy of the private set, for argument checks, masking and scans only. */
  secretValues(): string[]
  /** Call after container retirement on every outcome, before scanning/release. */
  postcheck(): void
  release(): void
}
export async function acquireCodexLogin(options: {
  env: Readonly<Record<string, string | undefined>>; uid: number; deps: CodexLoginDeps; cancelled?: () => boolean
}): Promise<CodexLoginLease> {
  const { env, uid, deps } = options
  const home = env.CODEX_HOME || (env.HOME ? join(env.HOME, '.codex') : '')
  if (!home) throw new Error('Codex home missing; set CODEX_HOME or HOME')
  const config = resolve(home, 'config.toml'), path = resolve(home, 'auth.json')
  let text: string
  try { text = deps.readConfig(config) } catch { throw new Error(`Codex model missing in ${config}; set a top-level model there`) }
  let hostConfigKeys: string
  try { hostConfigKeys = encodeCodexHostConfigKeys(scanCodexConfigKeyPaths(text)) }
  catch { throw new Error(`Codex config key projection missing or invalid in ${config}`) }
  const model = codexModelFromConfig(text, config)
  text = ''
  let lock: CodexLock
  try { lock = deps.openLock(resolve(home, 'codex-login.lock')) } catch { throw new Error('Could not take the Codex login lock') }
  let retained = false
  try {
    const deadline = deps.now() + CODEX_LOGIN_LOCK_WAIT_MS
    while (true) {
      if (options.cancelled?.()) throw new Error('Codex login admission interrupted')
      const result = lock.tryLock()
      if (result.kind === 'taken') break
      if (result.kind === 'error') throw new Error('Could not take the Codex login lock')
      if (deps.now() >= deadline) throw new Error('Another run holds the Codex login; lock stayed busy for 30 minutes')
      await deps.sleep(Math.min(250, deadline - deps.now()))
    }
    let before: LoginRead, source: string
    try { before = deps.readLogin(path); source = deps.resolveLogin(path) }
    catch { throw new Error(`Codex login missing or invalid at ${path}; run codex login on the host (regular non-symlink owner-0600 file required)`) }
    if (before.identity.uid !== uid || before.identity.mode !== 0o600) throw new Error(`Codex login at ${path} must be owned by the runner with mode 0600; run codex login on the host`)
    if (/[,"\u0000-\u001f\u007f]/.test(source)) throw new Error('Codex login mount path is invalid')
    const identity = before.identity, tokens = new Set<string>()
    collectTokens(before.json, tokens)
    // Drop the parsed login object; retain token strings alone in memory.
    before = { identity, json: null }
    retained = true
    let released = false
    return { model, source, hostConfigKeys, secretValues: () => [...tokens], postcheck() {
      try {
        const after = deps.readLogin(path)
        collectTokens(after.json, tokens)
        if (after.identity.dev !== identity.dev || after.identity.ino !== identity.ino || after.identity.uid !== uid || after.identity.mode !== 0o600) throw new Error('identity')
      } catch { throw new Error('Codex login postcheck failed; run codex login --device-auth on the host') }
    }, release() { if (!released) { released = true; lock.release(); tokens.clear() } } }
  } finally { if (!retained) lock.release() }
}
export function assertCodexMounts(mounts: readonly { source: string; target: string; readOnly: boolean }[], source: string): void {
  if (mounts.length !== 1 || mounts[0]?.source !== source || mounts[0]?.target !== CODEX_LOGIN_TARGET || mounts[0]?.readOnly !== false) {
    throw new Error('Codex container must have exactly one read-write login file mount')
  }
}
