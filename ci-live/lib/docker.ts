/**
 * docker.ts — the live image and container, as docker argv.
 *
 * Pure builders, the live image build's failure message
 * (`liveBuildFailureMessage`), and one guard, `assertSafeRunArgs`, which every
 * `docker run` passes before it is spawned. It accepts only the flags `buildRunArgs` uses
 * (`-d`, `--init`, `--name`, `--hostname`, `--label`, `--memory`,
 * `--memory-swap`, `--pids-limit`, `--mount`, `--env`/`-e`) in any spelling
 * (`--flag value`, `--flag=value`, `-eVALUE`), then the image and nothing
 * after it, and on top of that:
 * - the resource caps are required: `--memory`, `--memory-swap` and
 *   `--pids-limit`, each once, each a positive bounded value (never `-1` or
 *   `0`, which mean no limit), and `--memory-swap` equal to `--memory` (no
 *   swap on top of the cap);
 * - no `--network`/`--net` at all (the default docker network only), never a
 *   published port (the server's 3100 is the container's own), never
 *   `--privileged`, a host namespace (`--pid`, `--ipc`, `--uts`, `--userns`,
 *   `--cgroupns`), `--volumes-from`, `-v`/`--volume` or an env file;
 * - a mount only as `type=bind`, never of the host's `~/.claude`, anything
 *   under it, or any directory holding it (`$HOME`, `/home`, `/`), by its
 *   lexical or its real path; with only the fields `buildRunArgs` writes
 *   (`type`, the source, the target, a bare `readonly`, in any of docker's
 *   spellings), each named once, and no quote or line break (docker reads the
 *   spec as CSV, where either could make it see another source);
 * - a secret variable only in the no-value `--env NAME` form, so no value is
 *   in any argv or process list: the value travels in the child environment
 *   (`claudeChildEnv` maps the host's `CI_ANTHROPIC_*` to `ANTHROPIC_*`
 *   there). The host's own `ANTHROPIC_*` are never read. No value may be
 *   token-shaped whatever its name.
 * Its errors name a flag or a variable only when it is a plain name, never a
 * value.
 */

import { realpathSync } from 'node:fs'
import { join, resolve, sep } from 'node:path'

import { countTokenShaped } from './redact.ts'
import type { ProcResult, SpawnFn } from './proc.ts'

export const BASE_IMAGE = 'cscb-ci-base:v6'
export const LIVE_IMAGE = 'cscb-ci-live:latest'
export const CONTAINER_LABEL_KEY = 'cscb-live'
export const CONTAINER_LABEL = `${CONTAINER_LABEL_KEY}=1`
/** The label holding the PID of the runner that started the container (leftover removal spares a live owner's). */
export const CONTAINER_OWNER_LABEL_KEY = 'cscb-live-owner'
export const CONTAINER_PREFIX = 'cscb-live-'
export const CONTAINER_USER = 'testuser'
export const CONTAINER_HOME = '/home/testuser'

/**
 * The test container's hard memory cap (docker's size syntax). Why 8 GiB: it
 * runs four persona Claude Code sessions, each a node process plus its MCP
 * servers and tool children (about 0.5 to 1 GiB each, so 2 to 4 GiB), plus
 * the bun server, agent-director, tmux and the checks' `docker exec` shells
 * (a few hundred MiB). 8 GiB is about twice that peak, yet an eighth of the
 * 64 GiB pod the host's production bots share: an uncapped run once froze the
 * whole VM. `--memory-swap` gets the same value, so the container has no swap
 * on top of the cap: past it the kernel OOM-kills inside the container
 * instead of the host thrashing.
 */
export const CONTAINER_MEMORY = '8g'

/**
 * The test container's process cap. Why 2048: each Claude session runs some
 * tens of processes (node, MCP servers, shells, git), the server,
 * agent-director and tmux a few dozen more, so a healthy run stays in the low
 * hundreds; 2048 leaves ample headroom and still stops a fork or spawn loop
 * long before it reaches the host.
 */
export const CONTAINER_PIDS_LIMIT = 2048

/** Where the container sees its inputs. */
export const CONTAINER_TARBALL = '/tmp/package.tgz'
export const CONTAINER_CREDENTIALS_DIR = `${CONTAINER_HOME}/.config/cscb`

/** The named build context that holds the staged agent-director binary (Dockerfile.live copies it). */
export const AGENT_DIRECTOR_BUILD_CONTEXT = 'agent-director-bin'

/** The Claude gateway variables: container name ← host name. */
export const CLAUDE_ENV_MAP: ReadonlyArray<readonly [string, string]> = [
  ['ANTHROPIC_API_KEY', 'CI_ANTHROPIC_API_KEY'],
  ['ANTHROPIC_BASE_URL', 'CI_ANTHROPIC_BASE_URL'],
  ['ANTHROPIC_MODEL', 'CI_ANTHROPIC_MODEL'],
]

/** Variables that may appear in a `docker run` argv only as a bare `--env NAME`. */
export const SECRET_ENV_NAMES = new Set(['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'SLACK_BOT_TOKEN', 'SLACK_APP_TOKEN', 'CLAUDE_CODE_OAUTH_TOKEN'])

/** Variables that must never reach the container at all. */
export const FORBIDDEN_ENV_NAMES = new Set(['SLACK_BOT_TOKEN', 'SLACK_APP_TOKEN', 'SLACK_STATE_DIR'])

const RUN_ID_RE = /^[0-9a-z]{1,32}$/
const OWNER_PID_RE = /^[1-9][0-9]{0,9}$/

/**
 * What follows the prefix in a live container's name: `<run id>-<owner PID>`,
 * or an older runner's bare `<run id>` (still a live name, so leftover
 * removal can sweep it). A run id holds no `-`, so the split is unambiguous.
 */
const LIVE_NAME_SUFFIX_RE = /^[0-9a-z]{1,32}(-[1-9][0-9]{0,9})?$/

/**
 * The container (and hostname) of one runner: `cscb-live-<run id>-<owner PID>`.
 * The run id is the start second, so two runners started in the same second
 * (a dry run and a real run) differ by their PID (this process's by default).
 */
export function containerName(runId: string, ownerPid: number = process.pid): string {
  if (!RUN_ID_RE.test(runId)) throw new Error('run id must be lowercase letters and digits')
  if (!Number.isSafeInteger(ownerPid) || !OWNER_PID_RE.test(String(ownerPid))) throw new Error('owner PID must be a positive integer')
  return `${CONTAINER_PREFIX}${runId}-${ownerPid}`
}

export function isLiveContainerName(name: string): boolean {
  return name.startsWith(CONTAINER_PREFIX) && LIVE_NAME_SUFFIX_RE.test(name.slice(CONTAINER_PREFIX.length))
}

/**
 * The `docker inspect` format the runner reads a container's owner with: its
 * ID and labels only (the rest of an inspect holds the container's env, whose
 * values include the Claude key).
 */
export const INSPECT_OWNER_FORMAT = `{{.Id}}\t{{json .Config.Labels}}`

/** Who owns the container of a name, as `docker inspect --format INSPECT_OWNER_FORMAT` tells. */
export type ContainerOwnership =
  /** No container has the name. */
  | { kind: 'absent' }
  /** Labelled `cscb-live=1` and `cscb-live-owner=<this runner's PID>`: the only kind the runner removes. */
  | { kind: 'ours'; id: string }
  /** Another runner's, or not a live container at all. */
  | { kind: 'foreign' }
  /** docker failed, or its answer does not parse. */
  | { kind: 'unknown' }

const CONTAINER_ID_RE = /^[0-9a-f]{64}$/

/** Read `docker inspect --type container --format INSPECT_OWNER_FORMAT <name>`'s result. */
export function parseContainerOwnership(result: { code: number; stdout: string; stderr: string }, ownerPid: number): ContainerOwnership {
  if (result.code !== 0) return /No such (container|object)/i.test(result.stderr) ? { kind: 'absent' } : { kind: 'unknown' }
  const line = result.stdout.trim()
  const tab = line.indexOf('\t')
  if (tab === -1 || line.includes('\n')) return { kind: 'unknown' }
  const id = line.slice(0, tab)
  if (!CONTAINER_ID_RE.test(id)) return { kind: 'unknown' }
  let labels: unknown
  try {
    labels = JSON.parse(line.slice(tab + 1))
  } catch {
    return { kind: 'unknown' }
  }
  if (labels === null) return { kind: 'foreign' }
  if (typeof labels !== 'object' || Array.isArray(labels)) return { kind: 'unknown' }
  const l = labels as Record<string, unknown>
  const ours = l[CONTAINER_LABEL_KEY] === '1' && l[CONTAINER_OWNER_LABEL_KEY] === String(ownerPid)
  return ours ? { kind: 'ours', id } : { kind: 'foreign' }
}

/** How a run's end (`ContainerRun.stopAndRemove`) left its container. */
export type ContainerEnd =
  /** No `docker run` was made. */
  | 'none-started'
  /** None of this run's is left: removed now, or already gone (or never created). */
  | 'removed'
  /** Its removal failed, or its owner could not be proven (see run.log). */
  | 'not-removed'
  /** `--keep-container`: left running. */
  | 'kept-running'
  /** `--keep-container` on a memory watchdog stop: stopped with `docker stop` (its memory freed), kept for inspection. */
  | 'kept-stopped'
  /** `--keep-container` on a memory watchdog stop, but it could not be stopped (see run.log): it may still be running. */
  | 'stop-failed'

/** The test container's part of a stopped run's note: what its cleanup actually did (`null`: the cleanup did not get that far). */
export function describeContainerEnd(end: ContainerEnd | null, name: string): string {
  switch (end) {
    case null:
      return `the test container ${name} may still exist (the cleanup did not finish)`
    case 'none-started':
      return 'no test container had been started'
    case 'removed':
      return 'the test container was removed (or was already gone)'
    case 'not-removed':
      return `the test container ${name} could not be removed (see run.log): remove it with docker rm -f ${name}`
    case 'kept-running':
      return `the test container ${name} was kept running (--keep-container)`
    case 'kept-stopped':
      return `the test container ${name} was stopped with docker stop (its memory freed) and kept for inspection (--keep-container)`
    case 'stop-failed':
      return `the test container ${name} was kept (--keep-container) but could not be stopped (see run.log): it may still be running; stop it with docker stop ${name}`
  }
}

export interface ClaudeEnv {
  /** Added to the `docker run` child's environment (values). */
  childEnv: Record<string, string>
  /** Passed as bare `--env NAME` (names only). */
  names: string[]
}

/** Map the host's `CI_ANTHROPIC_*` to the container's `ANTHROPIC_*`. */
export function claudeChildEnv(hostEnv: Record<string, string | undefined>): ClaudeEnv {
  const childEnv: Record<string, string> = {}
  const names: string[] = []
  for (const [inner, outer] of CLAUDE_ENV_MAP) {
    const value = hostEnv[outer]
    if (value !== undefined && value !== '') {
      childEnv[inner] = value
      names.push(inner)
    }
  }
  return { childEnv, names }
}

/**
 * Why the Claude credentials can't serve a real run, or `null`. As `/ci`: a
 * key that is not a raw Anthropic key (`sk-ant-`) is a gateway key and needs
 * the gateway's base URL and model too.
 */
export function claudeEnvProblem(hostEnv: Record<string, string | undefined>): string | null {
  const key = hostEnv.CI_ANTHROPIC_API_KEY ?? ''
  if (key === '') return 'env CI_ANTHROPIC_API_KEY is not set (the bot Claudes in the container need it)'
  if (!key.startsWith('sk-ant-') && (!hostEnv.CI_ANTHROPIC_BASE_URL || !hostEnv.CI_ANTHROPIC_MODEL)) {
    return 'env CI_ANTHROPIC_API_KEY is a gateway key: also set CI_ANTHROPIC_BASE_URL and CI_ANTHROPIC_MODEL'
  }
  return null
}

export interface Mount {
  source: string
  target: string
  readOnly: boolean
}

export interface ImageBuildSpec {
  repoRoot: string
  uid: number
  gid: number
  /**
   * The directory holding the `agent-director` binary the runner staged (the
   * one given with `--agent-director-binary`, or the host's). Required: without it `COPY --from=agent-director-bin` would look
   * for an image of that name in a registry.
   */
  agentDirectorDir?: string
  tag?: string
}

export function buildImageArgs(spec: ImageBuildSpec): string[] {
  if (!spec.agentDirectorDir) throw new Error('buildImageArgs needs the staged agent-director binary dir (agentDirectorDir)')
  return [
    'build',
    '-f',
    join(spec.repoRoot, 'docker', 'Dockerfile.live'),
    '--build-context',
    `${AGENT_DIRECTOR_BUILD_CONTEXT}=${spec.agentDirectorDir}`,
    '--build-arg',
    `HOST_UID=${spec.uid}`,
    '--build-arg',
    `HOST_GID=${spec.gid}`,
    '-t',
    spec.tag ?? LIVE_IMAGE,
    spec.repoRoot,
  ]
}

/** A BuildKit plain-progress prefix on a build output line: `#12 0.345 ` (or `#12 ` alone). */
const BUILDKIT_PREFIX_RE = /^#\d+ (?:\d+(?:\.\d+)? )?/

/** docker's own failure lines, which repeat the failed RUN's whole command text (its echoed ERROR texts too). */
const DOCKER_OWN_ERROR_RE = /^ERROR: (?:failed to (?:build|solve)|process ")/

/**
 * The ERROR lines the live image build's own commands printed (Dockerfile.live
 * and the ad-client check), each without its BuildKit prefix: only lines that
 * start with `ERROR: `, never docker's own failure lines, nor the Dockerfile
 * excerpt or the shell trace that quote the RUN text.
 */
export function liveBuildErrorLines(stderr: string): string[] {
  return stderr
    .split('\n')
    .map((line) => line.replace(BUILDKIT_PREFIX_RE, '').trimEnd())
    .filter((line) => line.startsWith('ERROR: ') && !DOCKER_OWN_ERROR_RE.test(line))
}

/**
 * Dockerfile.live's routed ERROR lines (each a line's start) and what the
 * runner says for each. Only a staged binary that is not the pinned
 * agent-director release's is the runner's to fix, with
 * `--agent-director-binary`.
 */
const LIVE_BUILD_FAILURES: ReadonlyArray<readonly [string, string]> = [
  [
    'ERROR: the staged agent-director binary is not the agent-director release ',
    "the staged agent-director binary is not the agent-director release this image's agent-director client is checked against: give that release's agent-director-linux-amd64 with --agent-director-binary <path>",
  ],
  [
    "ERROR: the agent-director release's binary and client do not pair ",
    "the agent-director release's binary and client do not pair: the release pinned in docker/Dockerfile.test.base is not usable as is",
  ],
  [
    "ERROR: the base image's global agent-director client or its ad-client check failed ",
    `the base image ${BASE_IMAGE} predates this tree's docker/Dockerfile.test.base or docker/ad-client-check.sh: bump the base image version (docker/README.md)`,
  ],
  [
    'ERROR: agent-director on PATH is ',
    "the staged agent-director binary is not the first agent-director on the image's PATH",
  ],
]

/**
 * The runner's message for a failed live image build: which of
 * Dockerfile.live's ERROR lines it printed, read from its own ERROR lines
 * only (`liveBuildErrorLines`), never from text that merely quotes them.
 */
export function liveBuildFailureMessage(code: number, stderr: string): string {
  const lines = liveBuildErrorLines(stderr)
  const routed = LIVE_BUILD_FAILURES.find(([start]) => lines.some((line) => line.startsWith(start)))
  return `docker build of the live image failed (exit ${code})${routed ? `: ${routed[1]} (see run.log)` : ''}`
}

export interface RunSpec {
  name: string
  image?: string
  mounts: Mount[]
  /** Secret variables, passed by name only (their values are in the child env). */
  secretEnvNames: string[]
  /** Non-secret variables, passed as `NAME=value`. */
  plainEnv: Record<string, string>
  /** Labels beside `cscb-live=1` (the owner's PID). */
  labels?: Record<string, string>
}

export function buildRunArgs(spec: RunSpec): string[] {
  // --init: docker's init reaps the processes the checks kill (tmux sessions, bot Claudes).
  const args = ['run', '-d', '--init', '--name', spec.name, '--hostname', spec.name, '--label', CONTAINER_LABEL]
  for (const [key, value] of Object.entries(spec.labels ?? {})) args.push('--label', `${key}=${value}`)
  // The caps every run has (the guard requires them): --memory-swap equal to --memory, so no swap on top.
  args.push('--memory', CONTAINER_MEMORY, '--memory-swap', CONTAINER_MEMORY, '--pids-limit', String(CONTAINER_PIDS_LIMIT))
  for (const m of spec.mounts) {
    args.push('--mount', `type=bind,source=${m.source},target=${m.target}${m.readOnly ? ',readonly' : ''}`)
  }
  for (const name of spec.secretEnvNames) args.push('--env', name)
  for (const [name, value] of Object.entries(spec.plainEnv)) args.push('--env', `${name}=${value}`)
  args.push(spec.image ?? LIVE_IMAGE)
  return args
}

/** True when `path` is `dir` or inside it (lexically). */
function within(path: string, dir: string): boolean {
  const p = resolve(path)
  const d = resolve(dir)
  return p === d || p.startsWith(d.endsWith(sep) ? d : d + sep)
}

/** The real path, or the lexical absolute path when there is none (the path does not exist). */
export function realPathOrLexical(path: string): string {
  try {
    return realpathSync(path)
  } catch {
    return resolve(path)
  }
}

/** The `docker run` flags `buildRunArgs` uses; the guard refuses every other flag. */
const RUN_BOOLEAN_FLAGS = new Set(['-d', '--detach', '--init'])
const RUN_VALUE_FLAGS = new Set(['--name', '--hostname', '--label', '--memory', '--memory-swap', '--pids-limit', '--mount', '--env', '-e'])

/** The resource caps every `docker run` must set, each once. */
const RUN_LIMIT_FLAGS = ['--memory', '--memory-swap', '--pids-limit'] as const
type RunLimitFlag = (typeof RUN_LIMIT_FLAGS)[number]

const MEMORY_UNITS: Record<string, number> = { '': 1, b: 1, k: 1024, m: 1024 ** 2, g: 1024 ** 3 }

/**
 * A docker memory size (`8g`, `8192m`, `8589934592`) in bytes, or `null` when
 * it is not a positive bounded size: `-1` and `0` mean no limit, and anything
 * else docker could read another way is refused too.
 */
export function parseMemorySize(value: string): number | null {
  const m = /^([1-9][0-9]{0,12})([bkmg]?)$/i.exec(value)
  if (!m) return null
  const bytes = Number(m[1]) * (MEMORY_UNITS[(m[2] as string).toLowerCase()] as number)
  return Number.isSafeInteger(bytes) ? bytes : null
}

/** A cap's value as a number (bytes, or processes); throws when it is not a positive bounded value. */
function parseRunLimit(flag: RunLimitFlag, value: string): number {
  if (flag === '--pids-limit') {
    if (!/^[1-9][0-9]{0,6}$/.test(value)) throw new Error('docker run --pids-limit needs a positive number of processes (not -1 or 0, which mean no limit)')
    return Number(value)
  }
  const bytes = parseMemorySize(value)
  if (bytes === null) throw new Error(`docker run ${flag} needs a positive size such as 8g (not -1 or 0, which mean no limit)`)
  return bytes
}

/** Every cap set, and the swap cap equal to the memory cap. */
function checkRunLimits(limits: ReadonlyMap<RunLimitFlag, number>): void {
  const missing = RUN_LIMIT_FLAGS.filter((flag) => !limits.has(flag))
  if (missing.length > 0) {
    throw new Error(`docker run must cap the container with --memory, --memory-swap and --pids-limit (missing: ${missing.join(', ')})`)
  }
  if (limits.get('--memory-swap') !== limits.get('--memory')) {
    throw new Error('docker run --memory-swap must equal --memory (no swap on top of the memory cap)')
  }
}

/** Flags refused with their own reason (the rest fall to "not one the runner uses"). */
const REFUSED_FLAGS: ReadonlyArray<readonly [RegExp, string]> = [
  [/^--(network|net)$/, 'docker run uses the default network only (no --network)'],
  [/^(-p|-P|--publish|--publish-all|--expose)$/, 'docker run must not publish a port'],
  [/^--privileged$/, 'docker run must not be privileged'],
  [/^--(pid|ipc|uts|userns|cgroupns)$/, "docker run must not share a host namespace (--pid, --ipc, --uts, --userns, --cgroupns)"],
  [/^--volumes-from$/, 'docker run must not use --volumes-from'],
  [/^(-v|--volume)$/, 'docker run mounts only with --mount type=bind'],
  [/^--env-file$/, 'docker run must not use an env file'],
]

/** A flag name an error may repeat. */
const ECHOABLE_FLAG_RE = /^--?[a-z][a-z-]{0,30}$/

/** A variable name an error may repeat. */
const ENV_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/

/** A variable that may reach the container only by name (its value in the child environment). */
export function isSecretEnvName(name: string): boolean {
  return SECRET_ENV_NAMES.has(name) || /^(CI_)?ANTHROPIC_/.test(name) || /TOKEN|SECRET|PASSWORD|PASSWD|API_KEY|COOKIE/i.test(name)
}

function checkRunEnv(spec: string): void {
  const eq = spec.indexOf('=')
  const name = eq === -1 ? spec : spec.slice(0, eq)
  if (!ENV_NAME_RE.test(name)) throw new Error('docker run --env needs a plain variable name')
  if (FORBIDDEN_ENV_NAMES.has(name)) throw new Error(`docker run must not pass ${name}`)
  if (eq === -1) return
  if (isSecretEnvName(name)) throw new Error(`docker run must pass ${name} by name only`)
  if (countTokenShaped(spec.slice(eq + 1)) > 0) throw new Error(`docker run --env ${name} holds token-shaped text`)
}

/**
 * The `--mount` fields `buildRunArgs` writes, by every spelling docker
 * accepts for them (docker lets the last of two spellings win, so each field
 * may be named once only). `readonly` is the bare flag.
 */
const MOUNT_FIELDS: ReadonlyMap<string, 'type' | 'source' | 'target' | 'readonly'> = new Map([
  ['type', 'type'],
  ['source', 'source'],
  ['src', 'source'],
  ['target', 'target'],
  ['destination', 'target'],
  ['dst', 'target'],
  ['readonly', 'readonly'],
  ['ro', 'readonly'],
] as const)

/** A `--mount` field name an error may repeat. */
const ECHOABLE_MOUNT_FIELD_RE = /^[a-z][a-z-]{0,30}$/

/** The `--mount` fields by their canonical name; throws on any field or spelling `buildRunArgs` does not write. */
function parseRunMount(spec: string): Map<string, string> {
  // docker reads the value as one CSV record: a quote could hide a comma inside a field, a line break end the record.
  if (/["\r\n]/.test(spec)) throw new Error('docker run --mount must not hold a quote or a line break')
  const fields = new Map<string, string>()
  for (const part of spec.split(',')) {
    const eq = part.indexOf('=')
    const key = eq === -1 ? part : part.slice(0, eq)
    const field = MOUNT_FIELDS.get(key)
    if (!field) throw new Error(`docker run --mount field ${ECHOABLE_MOUNT_FIELD_RE.test(key) ? key : '(unnamed)'} is not one the runner uses`)
    if (fields.has(field)) throw new Error(`docker run --mount names its ${field} more than once`)
    if (field === 'readonly' && eq !== -1) throw new Error('docker run --mount readonly takes no value')
    if (field !== 'readonly' && eq === -1) throw new Error(`docker run --mount ${field} needs a value`)
    fields.set(field, eq === -1 ? '' : part.slice(eq + 1))
  }
  return fields
}

function checkRunMount(spec: string, hostClaude: readonly string[], realPath: (p: string) => string): void {
  const fields = parseRunMount(spec)
  const source = fields.get('source')
  if (!source) throw new Error('docker run --mount needs a source')
  if (fields.get('type') !== 'bind') throw new Error('docker run mounts only with --mount type=bind')
  for (const path of new Set([resolve(source), realPath(source)])) {
    for (const guarded of hostClaude) {
      if (within(path, guarded)) throw new Error("docker run must not mount the host's ~/.claude")
      if (within(guarded, path)) throw new Error("docker run must not mount a directory that holds the host's ~/.claude")
    }
  }
}

/** A flag and its attached value: `--flag=value`, `-eVALUE`, or the flag alone. */
function splitFlag(arg: string): { flag: string; attached: string | null } {
  if (arg.startsWith('--')) {
    const eq = arg.indexOf('=')
    return eq === -1 ? { flag: arg, attached: null } : { flag: arg.slice(0, eq), attached: arg.slice(eq + 1) }
  }
  return { flag: arg.slice(0, 2), attached: arg.length > 2 ? arg.slice(2) : null }
}

/**
 * Throw unless `args` (a `docker run` argv, without the `docker`) keeps every
 * container rule. `realPath` resolves mount sources and the host's
 * `~/.claude` (tests inject it).
 */
export function assertSafeRunArgs(args: readonly string[], home: string, realPath: (p: string) => string = realPathOrLexical): void {
  if (args[0] !== 'run') throw new Error('not a docker run argv')
  const claude = join(home, '.claude')
  const hostClaude = [...new Set([resolve(claude), realPath(claude)])]
  const limits = new Map<RunLimitFlag, number>()
  let i = 1
  for (; i < args.length; i++) {
    const arg = args[i] as string
    if (!arg.startsWith('-') || arg === '-') break
    if (arg === '--') {
      i++
      break
    }
    const { flag, attached } = splitFlag(arg)
    for (const [re, reason] of REFUSED_FLAGS) if (re.test(flag)) throw new Error(reason)
    if (RUN_BOOLEAN_FLAGS.has(flag)) {
      // `-dP` and the like: combined short flags could hide one the guard refuses.
      if (attached !== null) throw new Error(flag.startsWith('--') ? `docker run ${flag} takes no value` : 'docker run short flags must not be combined')
      continue
    }
    if (!RUN_VALUE_FLAGS.has(flag)) {
      throw new Error(`docker run flag ${ECHOABLE_FLAG_RE.test(flag) ? flag : '(unnamed)'} is not one the runner uses`)
    }
    const value = attached ?? args[++i]
    if (value === undefined) throw new Error(`docker run ${flag} needs a value`)
    if (flag === '--mount') checkRunMount(value, hostClaude, realPath)
    if (flag === '--env' || flag === '-e') checkRunEnv(value)
    const limit = RUN_LIMIT_FLAGS.find((f) => f === flag)
    if (limit) {
      // docker lets the last of two win, so a second one could lift the cap.
      if (limits.has(limit)) throw new Error(`docker run sets ${limit} more than once`)
      limits.set(limit, parseRunLimit(limit, value))
    }
  }
  if (i >= args.length) throw new Error('docker run names no image')
  if (i !== args.length - 1) throw new Error('docker run must not pass a command after the image')
  checkRunLimits(limits)
}

/** The `docker stats --no-stream --format` the memory watchdog reads: memory use / limit, then the PID count. */
export const CONTAINER_STATS_FORMAT = '{{.MemUsage}} {{.PIDs}}'

export interface ContainerStats {
  /** docker's own rendering, such as `1.2GiB / 8GiB`. */
  memUsage: string
  memBytes: number
  limitBytes: number
  pids: number
}

/** docker prints memory in binary units (`MiB`), and in decimal ones on some versions (`MB`). */
const STATS_UNITS: Record<string, number> = {
  B: 1,
  KiB: 1024,
  MiB: 1024 ** 2,
  GiB: 1024 ** 3,
  TiB: 1024 ** 4,
  kB: 1e3,
  KB: 1e3,
  MB: 1e6,
  GB: 1e9,
  TB: 1e12,
}

function statsBytes(amount: string, unit: string): number | null {
  const factor = STATS_UNITS[unit]
  const n = Number(amount)
  return factor === undefined || !Number.isFinite(n) ? null : Math.round(n * factor)
}

/** One line of `docker stats` in `CONTAINER_STATS_FORMAT`, or `null` when it does not parse. */
export function parseContainerStats(stdout: string): ContainerStats | null {
  const m = /^([0-9.]+)\s*([A-Za-z]+)\s*\/\s*([0-9.]+)\s*([A-Za-z]+)\s+([0-9]{1,9})$/.exec(stdout.trim())
  if (!m) return null
  const memBytes = statsBytes(m[1] as string, m[2] as string)
  const limitBytes = statsBytes(m[3] as string, m[4] as string)
  if (memBytes === null || limitBytes === null) return null
  return { memUsage: `${m[1]}${m[2]} / ${m[3]}${m[4]}`, memBytes, limitBytes, pids: Number(m[5]) }
}

export function buildExecArgs(
  name: string,
  argv: readonly string[],
  options: { user?: string; workdir?: string; interactive?: boolean } = {},
): string[] {
  const user = options.user ?? CONTAINER_USER
  const home = user === 'root' ? '/root' : CONTAINER_HOME
  const args = ['exec']
  if (options.interactive) args.push('-i')
  args.push('-u', user, '-w', options.workdir ?? home, '-e', `HOME=${home}`, name, ...argv)
  return args
}

/** The docker CLI with a fixed, minimal child environment. */
export class DockerCli {
  constructor(
    private readonly spawn: SpawnFn,
    private readonly baseEnv: Record<string, string>,
  ) {}

  /** Run `docker <args>`; `extraEnv` (secret values) is added to the child environment only. */
  run(args: readonly string[], options: { timeoutMs: number; extraEnv?: Record<string, string>; stdin?: string; cwd?: string }): Promise<ProcResult> {
    return this.spawn(['docker', ...args], {
      env: { ...this.baseEnv, ...(options.extraEnv ?? {}) },
      timeoutMs: options.timeoutMs,
      stdin: options.stdin,
      cwd: options.cwd,
    })
  }
}
