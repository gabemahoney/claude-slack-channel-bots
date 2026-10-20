/** D1 containment checks. Importing does no I/O; probes are injected. */
import { isAbsolute, relative, resolve } from 'node:path'
import { constants, closeSync, fstatSync, fsyncSync, lstatSync, openSync, readFileSync, readSync, readlinkSync, realpathSync, writeSync, ftruncateSync } from 'node:fs'
import { dirname, join } from 'node:path'

export const CODEX_NATIVE = '/opt/codex/0.159.2/codex'
export const CODEX_AUTH_MOUNT = '/run/codex-login/auth.json'
export const CODEX_NO_REPLY = "In this test there is no reply tool; answer only as the test's instructions say."

export function under(root: string, path: string): boolean {
  const part = relative(root, path)
  return part !== '' && part !== '..' && !part.startsWith('../') && !isAbsolute(part)
}

export function codexContainment(env: Record<string, string | undefined>, realpath: (path: string) => string) {
  if (env.TMUX !== undefined) throw new Error('TMUX must be unset')
  const root = env.SCENARIO_ROOT, home = env.HOME, tmux = env.TMUX_TMPDIR, model = env.CODEX_TEST_MODEL
  if (!root || !home || !tmux || ![root, home, tmux].every(isAbsolute)) throw new Error('scratch root, HOME and TMUX_TMPDIR are required')
  if (!under('/tmp', resolve(root)) || !under(root, home) || !under(root, tmux)) throw new Error('HOME and TMUX_TMPDIR must be under the scratch root in /tmp')
  const actualRoot = realpath(root), actualHome = realpath(home), actualTmux = realpath(tmux)
  if (!under(realpath('/tmp'), actualRoot) || !under(actualRoot, actualHome) || !under(actualRoot, actualTmux)) throw new Error('scratch paths escape after resolution')
  if (!model || !/^[A-Za-z0-9._:/-]+$/.test(model)) throw new Error('CODEX_TEST_MODEL must be a safe selected model')
  return { root: actualRoot, home: actualHome, tmux: actualTmux, model }
}

export function codexArguments(model: string, description: string): string[] {
  if (!/^[A-Za-z0-9._:/-]+$/.test(model)) throw new Error('invalid selected Codex model')
  // rust-v0.159.2 startup_prompts.rs:279-293: suppress optional startup
  // tooltip counters without copying host settings or expanding file admission.
  return ['-c', `model="${model}"`, '-c', 'check_for_update_on_startup=false', '-c', 'cli_auth_credentials_store="file"', '-c', 'tui.show_tooltips=false',
    '-a', 'never', '-s', 'workspace-write', description]
}

/** Only the scenario AD config is written by the harness. */
export function configureScratchCodex(root: string, home: string) {
  const config = join(home, '.config/agent-director/config.toml')
  if (!under(root, realpathSync(dirname(config)))) throw new Error('agent-director config parent escapes scratch')
  let absent = false
  try {
    const stat = lstatSync(config)
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || !under(root, realpathSync(config))) throw new Error('agent-director config is not private')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    absent = true
  }
  const fd = openSync(config, constants.O_RDWR | constants.O_NOFOLLOW | (absent ? constants.O_CREAT | constants.O_EXCL : 0), 0o600)
  try {
    const stat = fstatSync(fd)
    if (!stat.isFile() || stat.nlink !== 1) throw new Error('agent-director config is not private')
    const previous = readFileSync(fd, 'utf8').replace(/^\[launch\][\s\S]*?(?=^\[|$(?![\s\S]))/gm, '')
    const bytes = Buffer.from(`${previous}\n[launch]\ncodex_path = ${JSON.stringify(CODEX_NATIVE)}\n`)
    // Reading advanced the fd offset: write explicitly from byte zero.
    writeSync(fd, bytes, 0, bytes.length, 0)
    ftruncateSync(fd, bytes.length)
  } finally { closeSync(fd) }
}

/** Metadata only: never open the login or follow its symlink. */
export function scratchCodexContract(home: string) {
  const exists = (path: string) => { try { lstatSync(path); return true } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false; throw error } }
  const auth = join(home, 'auth.json'), symlink = exists(auth) && lstatSync(auth).isSymbolicLink()
  return { symlink, targetMatches: symlink && readlinkSync(auth) === CODEX_AUTH_MOUNT,
    scratchConfigPresent: exists(join(home, 'config.toml')),
    privateHome: !lstatSync(home).isSymbolicLink() && (lstatSync(home).mode & 0o777) === 0o700 }
}

type ConfigKeys = { readonly allowed: boolean; readonly keyNames: readonly string[]; readonly unknownKeyCount: number }
export type ScratchCodexCheck = ReturnType<typeof scratchCodexContract> & ConfigKeys & { nativeSpawnRecorded: boolean }
const scratchRefusal = () => new Error('scratch Codex auth/config lifecycle contract failed')

/** The names-only checker is loaded from the installed package by the driver.
 * A receipt is created only after a guarded spawn successfully returns. A
 * crash before that receipt is durable fails closed if a config appeared.
 * Receipt bytes bind the native launch to this exact private home inode;
 * neither a config alone nor an incomplete/prepared receipt grants provenance.
 */
export function createScratchCodexLifecycle(options: {
  root: string; home: string; stateDir: string; hostProjection: string | undefined
  checkConfigKeys(text: string | undefined, hostProjection: string | undefined): ConfigKeys
  onCheck?(checkpoint: string, check: ScratchCodexCheck): void
}) {
  const { root, home, stateDir } = options
  const receipt = join(stateDir, 'codex-native-spawn.json')
  let spawning: string | undefined
  const exists = (path: string) => {
    try { lstatSync(path); return true }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false; throw scratchRefusal() }
  }
  function directory(path: string) {
    const stat = lstatSync(path)
    if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.mode & 0o777) !== 0o700
      || stat.uid !== process.getuid!() || !under(root, path) || realpathSync(path) !== path) throw scratchRefusal()
    return stat
  }
  function readPrivate(path: string, limit: number) {
    const before = lstatSync(path)
    if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1 || before.uid !== process.getuid!()
      || (before.mode & 0o022) !== 0 || before.size > limit || !under(root, realpathSync(path))) throw scratchRefusal()
    const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
    try {
      const opened = fstatSync(fd)
      if (!opened.isFile() || opened.dev !== before.dev || opened.ino !== before.ino || opened.nlink !== 1 || opened.size > limit) throw scratchRefusal()
      const bytes = Buffer.alloc(limit + 1)
      let length = 0
      while (length < bytes.length) {
        const count = readSync(fd, bytes, length, bytes.length - length, length)
        if (!count) break
        length += count
      }
      const after = lstatSync(path)
      if (length > limit || !after.isFile() || after.isSymbolicLink() || after.dev !== opened.dev || after.ino !== opened.ino
        || after.nlink !== 1 || !under(root, realpathSync(path))) throw scratchRefusal()
      return new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, length))
    } finally { closeSync(fd) }
  }
  function identity() {
    if (realpathSync(root) !== root || !lstatSync(root).isDirectory()) throw scratchRefusal()
    const stat = directory(home)
    directory(stateDir)
    return { version: 1, native: CODEX_NATIVE, home, device: stat.dev, inode: stat.ino }
  }
  function hasReceipt() {
    const expected = identity()
    if (!exists(receipt)) return false
    const stat = lstatSync(receipt)
    if ((stat.mode & 0o777) !== 0o400) throw scratchRefusal()
    const value = JSON.parse(readPrivate(receipt, 4096))
    if (!value || JSON.stringify(Object.keys(value).sort()) !== JSON.stringify([...Object.keys(expected), 'instance'].sort())
      || !Object.entries(expected).every(([key, wanted]) => value[key] === wanted)
      || typeof value.instance !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(value.instance)) throw scratchRefusal()
    return true
  }
  function check(checkpoint = 'prepare', successfulSpawn = false): ScratchCodexCheck {
    try {
      const nativeSpawnRecorded = hasReceipt()
      const contract = scratchCodexContract(home)
      // Validate the environment projection even when config is absent. Do
      // not open a preexisting config without successful native provenance.
      let keys = options.checkConfigKeys(undefined, options.hostProjection)
      if (contract.scratchConfigPresent) {
        if (!nativeSpawnRecorded && !successfulSpawn) throw scratchRefusal()
        keys = options.checkConfigKeys(readPrivate(join(home, 'config.toml'), 1024 * 1024), options.hostProjection)
      }
      const result = { ...contract, ...keys, nativeSpawnRecorded }
      options.onCheck?.(checkpoint, result)
      if (!contract.symlink || !contract.targetMatches || !contract.privateHome || !keys.allowed) throw scratchRefusal()
      return result
    } catch { throw scratchRefusal() }
  }
  return {
    check: (checkpoint = 'prepare') => check(checkpoint),
    beforeSpawn() { check('prespawn'); spawning = JSON.stringify(identity()) },
    afterSpawn(instance: string) {
      try {
        if (!spawning || spawning !== JSON.stringify(identity()) || !/^[A-Za-z0-9_-]{1,128}$/.test(instance)) throw scratchRefusal()
        spawning = undefined
        check('postspawn', true)
        if (!hasReceipt()) {
          const bytes = Buffer.from(JSON.stringify({ ...identity(), instance }))
          const fd = openSync(receipt, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o400)
          try {
            let offset = 0
            while (offset < bytes.length) offset += writeSync(fd, bytes, offset, bytes.length - offset)
            fsyncSync(fd)
          } finally { closeSync(fd) }
          const parent = openSync(stateDir, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW)
          try { fsyncSync(parent) } finally { closeSync(parent) }
        }
        return check('postspawn')
      } catch { throw scratchRefusal() }
    },
  }
}

/** Called only after a successful supported kill, never as process-exit proof. */
export async function codexRetirementCheckpoint(io: {
  findMissing(): Promise<unknown>; state(): Promise<string>
}): Promise<boolean> {
  await io.findMissing()
  const state = await io.state()
  return state === 'ended' || state === 'missing'
}
