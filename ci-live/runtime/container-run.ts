/**
 * container-run.ts — the throwaway container's life: pack the package under
 * test, build the live image (with the selected agent-director binary, the
 * one given with `--agent-director-binary` or else the host's, copied into a
 * fresh temp dir staged as a named build context; it is never run on the
 * host), start the container on the default network with
 * the tarball and the credentials dir mounted read-only and hard memory, swap
 * and PID caps (`CONTAINER_MEMORY`, `CONTAINER_PIDS_LIMIT`), wait for the
 * entrypoint's boot, restart it (Check 28) and wait for that new boot, read
 * its memory use and PID count for the memory watchdog (`docker stats`),
 * capture its logs and remove it (or, with `--keep-container` on a memory
 * watchdog stop, stop it with `docker stop`: its memory is freed and it stays
 * for inspection).
 *
 * Leftover containers of an earlier run (label `cscb-live=1`, and only those)
 * are removed first, except one whose runner (its `cscb-live-owner` PID) is
 * still alive: a dry run never removes a real run's container, nor the
 * reverse. Once `stopAndRemove` has run (the end of a run, or a signal), no
 * container is started any more, and one whose `docker run` is still in
 * flight is removed as soon as it exists.
 *
 * The run's own container is `cscb-live-<run id>-<PID>` (so two runners
 * started in the same second never share a name), and `remove` and
 * `stopAndRemove` remove (or stop) it only after `docker inspect` shows its
 * `cscb-live-owner` label is this runner's PID, by the ID inspected.
 */

import { chmodSync, copyFileSync, mkdtempSync, rmSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'

import { selectAgentDirectorBinary } from '../lib/agent-director-binary.ts'
import { AGENT_DIRECTOR_BINARY_OPTION } from '../lib/args.ts'
import { BOOT_DONE_FILE, bootProblem, bootReached, parseBootDone, type BootRecord } from '../lib/container-boot.ts'
import { TestContainer } from '../lib/container.ts'
import {
  BASE_IMAGE,
  buildImageArgs,
  buildRunArgs,
  assertSafeRunArgs,
  claudeChildEnv,
  CONTAINER_CREDENTIALS_DIR,
  CONTAINER_LABEL,
  CONTAINER_MEMORY,
  CONTAINER_OWNER_LABEL_KEY,
  CONTAINER_PIDS_LIMIT,
  CONTAINER_STATS_FORMAT,
  CONTAINER_TARBALL,
  containerName,
  DockerCli,
  type ContainerEnd,
  INSPECT_OWNER_FORMAT,
  isLiveContainerName,
  liveBuildErrorLines,
  liveBuildFailureMessage,
  parseContainerOwnership,
  parseContainerStats,
  type ContainerOwnership,
  type ContainerStats,
} from '../lib/docker.ts'
import type { RunLog } from '../lib/log.ts'
import { minimalChildEnv, type SpawnFn } from '../lib/proc.ts'
import { NotRunnableError } from '../lib/secrets.ts'
import { waitFor, realClock } from '../lib/wait.ts'

export interface Packed {
  tarball: string
  dir: string
  version: string
  commit: string
}

/** The agent-director binary the live image is built with, and whether it was given or found on the host. */
export interface StagedBinary {
  path: string
  source: 'given' | 'found'
}

/** What removing this run's container came to: `foreign` and `unknown` remove nothing. */
type RemovalOutcome = 'removed' | 'absent' | 'failed' | 'foreign' | 'unknown'

/** How long the entrypoint may take to finish a boot. */
const BOOT_TIMEOUT_MS = 180_000

/** `docker stop -t`: the seconds a kept container gets to exit before it is killed (a memory watchdog stop). */
const KEPT_STOP_GRACE_S = 10

export class ContainerRun {
  readonly docker: DockerCli
  readonly name: string
  container: TestContainer | null = null
  /** Set by `stopAndRemove`: no container is started after it. */
  private stopping = false
  /** A `docker run` in flight (settles when the command returns). */
  private pendingStart: Promise<unknown> | null = null
  /** `docker run` was attempted: the container may exist. */
  private runAttempted = false
  /** The temp dir holding the staged agent-director binary while `buildImage` runs; null once removed. */
  private stageDir: string | null = null

  constructor(
    private readonly spawn: SpawnFn,
    private readonly log: RunLog,
    readonly runId: string,
    private readonly repoRoot: string,
    /** The path given with `--agent-director-binary`, if any: staged instead of searching the host. */
    private readonly givenAgentDirectorBinary?: string,
  ) {
    this.docker = new DockerCli(spawn, minimalChildEnv(process.env))
    this.name = containerName(runId, process.pid)
  }

  private host(argv: string[], timeoutMs: number, cwd?: string) {
    return this.spawn(argv, { env: minimalChildEnv(process.env), timeoutMs, cwd })
  }

  async assertDocker(): Promise<void> {
    const info = await this.docker.run(['info', '--format', '{{.ServerVersion}}'], { timeoutMs: 30_000 })
    if (info.code !== 0) throw new NotRunnableError('docker is not running (docker info failed): start docker and rerun')
    const base = await this.docker.run(['image', 'inspect', BASE_IMAGE], { timeoutMs: 30_000 })
    if (base.code !== 0) throw new NotRunnableError(`the /ci base image ${BASE_IMAGE} is missing: run /ci once to build it, then rerun`)
  }

  /**
   * The agent-director binary for the live image: the one given with
   * `--agent-director-binary` (checked by reading only; no host path is
   * searched), else the host's, found by search. Not runnable when the given
   * one cannot be staged or, with none given, none is found. Never runs it.
   */
  agentDirectorBinary(): StagedBinary {
    const selected = selectAgentDirectorBinary(this.givenAgentDirectorBinary, homedir(), minimalChildEnv(process.env).PATH)
    if (selected.path !== null) return { path: selected.path, source: selected.source }
    if (selected.source === 'given') {
      throw new NotRunnableError(`${selected.reason}: give ${AGENT_DIRECTOR_BINARY_OPTION} the path of an executable agent-director binary to stage in the live image, then rerun`)
    }
    throw new NotRunnableError(
      `no agent-director binary to stage in the live image: none was given with ${AGENT_DIRECTOR_BINARY_OPTION}, and none was found at ~/.agent-director/bin/agent-director or on PATH; ` +
        `give the binary to stage with ${AGENT_DIRECTOR_BINARY_OPTION} <path>, then rerun`,
    )
  }

  /**
   * Remove containers labelled cscb-live=1 (and only those) left by an
   * earlier run: one whose owner PID is a live runner is kept. One with no
   * owner label (an older runner's) is removed only when `ownerlessRemovable`.
   */
  async removeLeftovers(isLiveRunner: (pid: number) => boolean, ownerlessRemovable: boolean): Promise<void> {
    const ps = await this.docker.run(
      ['ps', '-a', '--filter', `label=${CONTAINER_LABEL}`, '--format', `{{.Names}}\t{{.Label "${CONTAINER_OWNER_LABEL_KEY}"}}`],
      { timeoutMs: 30_000 },
    )
    for (const line of ps.stdout.split('\n').map((s) => s.trim()).filter(Boolean)) {
      const [name = '', owner = ''] = line.split('\t')
      if (!isLiveContainerName(name) || name === this.name) continue
      const pid = /^\d{1,10}$/.test(owner) ? Number(owner) : null
      if (pid !== null && pid !== process.pid && isLiveRunner(pid)) {
        this.log.info(`container: keeping ${name}: its run (PID ${pid}) is still in progress`)
        continue
      }
      if (pid === null && !ownerlessRemovable) {
        this.log.info(`container: keeping ${name}: it names no owner and another /ci-live run is in progress`)
        continue
      }
      this.log.info(`container: removing leftover ${name}`)
      await this.docker.run(['rm', '-f', name], { timeoutMs: 60_000 })
    }
  }

  /** `npm pack` the repo into a temporary dir (no lifecycle scripts). */
  async pack(): Promise<Packed> {
    const dir = mkdtempSync(join(tmpdir(), `cscb-ci-live-pack-${this.runId}-`))
    const r = await this.host(['npm', 'pack', '--ignore-scripts', '--pack-destination', dir], 180_000, this.repoRoot)
    const file = r.stdout.trim().split('\n').pop()?.trim() ?? ''
    if (r.code !== 0 || !file.endsWith('.tgz')) {
      rmSync(dir, { recursive: true, force: true })
      throw new NotRunnableError('npm pack failed: run npm install in the repo and rerun')
    }
    const version = /-(\d+\.\d+\.\d+[^/]*)\.tgz$/.exec(file)?.[1] ?? '?'
    const head = await this.host(['git', 'rev-parse', '--short', 'HEAD'], 30_000, this.repoRoot)
    const dirty = await this.host(['git', 'status', '--porcelain'], 30_000, this.repoRoot)
    const commit = `${head.stdout.trim() || '?'}${dirty.stdout.trim() !== '' ? '+uncommitted' : ''}`
    return { tarball: join(dir, file), dir, version, commit }
  }

  /**
   * Build the live image. The selected agent-director binary
   * (`agentDirectorBinary()`) is copied, read only, into a fresh temp dir
   * under the OS temp dir that the build sees as the named context
   * `agent-director-bin`, and that dir is removed after the build, on a
   * failure too, and by the run's cleanup (`removeStage`) when a stop ends
   * the run mid-build; nothing else is copied on the host and the binary is
   * never run here. Dockerfile.live checks it against the agent-director
   * release's client in the base image and fails the build with one ERROR
   * line on a mismatch; the failure message is `liveBuildFailureMessage`'s.
   */
  async buildImage(): Promise<void> {
    const uid = process.getuid?.() ?? 1000
    const gid = process.getgid?.() ?? 1000
    const binary = this.agentDirectorBinary()
    const staged = mkdtempSync(join(tmpdir(), `cscb-ci-live-ad-${this.runId}-`))
    this.stageDir = staged
    try {
      copyFileSync(binary.path, join(staged, 'agent-director'))
      chmodSync(join(staged, 'agent-director'), 0o755)
      const how = binary.source === 'given' ? `given with ${AGENT_DIRECTOR_BINARY_OPTION}` : `found on this host (none was given with ${AGENT_DIRECTOR_BINARY_OPTION})`
      this.log.info(`container: building the live image with the agent-director binary ${binary.path}, ${how}`)
      const r = await this.docker.run(buildImageArgs({ repoRoot: this.repoRoot, uid, gid, agentDirectorDir: staged }), { timeoutMs: 600_000, cwd: this.repoRoot })
      if (r.code !== 0) {
        this.log.detail(`docker build stderr tail: ${r.stderr.split('\n').slice(-15).join(' | ')}`)
        const errors = liveBuildErrorLines(r.stderr)
        if (errors.length > 0) this.log.detail(`docker build ERROR lines: ${errors.join(' | ')}`)
        throw new Error(liveBuildFailureMessage(r.code, r.stderr))
      }
    } finally {
      this.removeStage()
    }
  }

  /**
   * Remove the staged agent-director binary's temp dir, if one is left:
   * `buildImage`'s end and the run's cleanup (a stop during the build) both
   * call it; a second call does nothing.
   */
  removeStage(): void {
    if (this.stageDir === null) return
    rmSync(this.stageDir, { recursive: true, force: true })
    this.stageDir = null
  }

  /** Start the container; the Claude credentials go by name only, their values in the child env. */
  async start(options: { tarball: string; credentialsDir: string; withClaude: boolean }): Promise<TestContainer> {
    if (this.stopping) throw new Error('the run is stopping: no container is started')
    const claude = options.withClaude ? claudeChildEnv(process.env) : { childEnv: {}, names: [] }
    const args = buildRunArgs({
      name: this.name,
      mounts: [
        { source: options.tarball, target: CONTAINER_TARBALL, readOnly: true },
        { source: options.credentialsDir, target: CONTAINER_CREDENTIALS_DIR, readOnly: true },
      ],
      secretEnvNames: claude.names,
      plainEnv: { CSCB_LIVE_TEST_HOST: this.name },
      labels: { [CONTAINER_OWNER_LABEL_KEY]: String(process.pid) },
    })
    assertSafeRunArgs(args, homedir())
    this.log.info(`container: starting ${this.name} with --memory ${CONTAINER_MEMORY} (--memory-swap the same) and --pids-limit ${CONTAINER_PIDS_LIMIT}`)
    this.runAttempted = true
    const started = this.docker.run(args, { timeoutMs: 120_000, extraEnv: claude.childEnv })
    this.pendingStart = started.catch(() => undefined)
    const r = await started
    if (r.code !== 0) throw new Error(`docker run failed (exit ${r.code})`)
    if (this.stopping) throw new Error('the run is stopping: the container is being removed')
    this.container = new TestContainer(this.docker, this.name)
    await this.waitBoot(1)
    this.log.info(`container: ${this.name} is up`)
    return this.container
  }

  /** The number of the last boot the entrypoint finished, or `null`. */
  private async lastBoot(): Promise<BootRecord | null> {
    const c = this.container
    if (!c) throw new Error('no container')
    const r = await c.exec(['cat', BOOT_DONE_FILE], { user: 'root', timeoutMs: 20_000 })
    return parseBootDone(r.code, r.stdout)
  }

  /** Wait until the entrypoint has finished boot `n` (the first start is boot 1; each restart adds one). */
  private async waitBoot(n: number): Promise<void> {
    const done = await waitFor(async () => bootReached(await this.lastBoot(), n), { timeoutMs: BOOT_TIMEOUT_MS, intervalMs: 2_000, clock: realClock })
    if (!done) throw new Error(`the container entrypoint did not finish boot ${n}`)
    const problem = bootProblem(done, n)
    if (problem) throw new Error(problem)
  }

  /** `docker restart` (Check 28's reboot); returns once the entrypoint has finished the new boot. */
  async restart(): Promise<void> {
    const before = await this.lastBoot()
    if (!before) throw new Error('the container has no finished boot to restart from')
    this.log.info(`container: restarting ${this.name} (the reboot)`)
    const r = await this.docker.run(['restart', '-t', '20', this.name], { timeoutMs: 180_000 })
    if (r.code !== 0) throw new Error(`docker restart failed (exit ${r.code})`)
    await this.waitBoot(before.boot + 1)
  }

  /**
   * This run's container's memory use and PID count (`docker stats`, one
   * reading), or `null` when it is not running: not started yet, or removed.
   * Throws when docker fails otherwise or its answer does not parse.
   */
  async stats(): Promise<ContainerStats | null> {
    if (!this.container) return null
    const r = await this.docker.run(['stats', '--no-stream', '--format', CONTAINER_STATS_FORMAT, this.name], { timeoutMs: 20_000 })
    if (r.code !== 0) {
      if (/No such container/i.test(r.stderr)) return null
      throw new Error(`docker stats failed (exit ${r.code})`)
    }
    const stats = parseContainerStats(r.stdout)
    if (!stats) throw new Error('docker stats printed no memory use and PID count')
    return stats
  }

  async logs(): Promise<string> {
    const r = await this.docker.run(['logs', this.name], { timeoutMs: 60_000 })
    return `${r.stdout}${r.stderr}`
  }

  /** Who owns the container of this run's name (its ID and labels only). */
  private async ownership(): Promise<ContainerOwnership> {
    const r = await this.docker.run(['inspect', '--type', 'container', '--format', INSPECT_OWNER_FORMAT, this.name], { timeoutMs: 30_000 })
    return parseContainerOwnership(r, process.pid)
  }

  /**
   * Remove the container of this run's name only when this runner started it
   * (labelled with its PID), by the ID it was inspected with: another run's
   * container is never removed, whatever its name.
   */
  private async removeOwn(): Promise<RemovalOutcome> {
    const owner = await this.ownership()
    if (owner.kind !== 'ours') return owner.kind
    const r = await this.docker.run(['rm', '-f', owner.id], { timeoutMs: 120_000 })
    const gone = await this.docker.run(['inspect', '--type', 'container', '--format', '{{.Id}}', owner.id], { timeoutMs: 30_000 })
    return r.code === 0 && gone.code !== 0 ? 'removed' : 'failed'
  }

  /** Remove this runner's container; true when none of its is left. */
  async remove(): Promise<boolean> {
    const outcome = await this.removeOwn()
    this.logRemoval(outcome)
    return outcome === 'removed' || outcome === 'absent'
  }

  private logRemoval(outcome: RemovalOutcome): void {
    if (outcome === 'foreign') this.log.error(`container: not removing ${this.name}: this run did not start it (its cscb-live-owner is not PID ${process.pid})`)
    if (outcome === 'unknown') this.log.error(`container: could not tell who owns ${this.name} (docker inspect failed); nothing removed`)
    if (outcome === 'failed') this.log.error(`container: could not remove ${this.name}: remove it with docker rm -f ${this.name}`)
  }

  /**
   * `docker stop` this runner's container, by the ID inspected, only when
   * docker shows this runner's PID as its owner: its memory is freed, and it
   * stays for inspection.
   */
  private async stopOwn(): Promise<'stopped' | 'failed' | ContainerOwnership['kind']> {
    const owner = await this.ownership()
    if (owner.kind !== 'ours') return owner.kind
    const r = await this.docker.run(['stop', '-t', String(KEPT_STOP_GRACE_S), owner.id], { timeoutMs: 60_000 + KEPT_STOP_GRACE_S * 1000 })
    return r.code === 0 ? 'stopped' : 'failed'
  }

  /** Stop the kept container (a memory watchdog stop with --keep-container); how it ended. */
  private async stopKeptContainer(): Promise<ContainerEnd> {
    const outcome = await this.stopOwn()
    if (outcome === 'stopped') {
      this.log.info(`container: ${this.name} stopped with docker stop and kept (--keep-container): start it with docker start ${this.name}, remove it with docker rm -f ${this.name}`)
      return 'kept-stopped'
    }
    if (outcome === 'absent') return 'removed'
    if (outcome === 'foreign') this.log.error(`container: not stopping ${this.name}: this run did not start it (its cscb-live-owner is not PID ${process.pid})`)
    if (outcome === 'unknown') this.log.error(`container: could not tell who owns ${this.name} (docker inspect failed); nothing stopped`)
    if (outcome === 'failed') this.log.error(`container: could not stop ${this.name}: stop it with docker stop ${this.name}`)
    return 'stop-failed'
  }

  /**
   * Stop for good: no further start, wait for a `docker run` in flight, then
   * remove the container when one may exist and this runner started it.
   * With `keep` (--keep-container) it is left as it is, or, with
   * `stopKept` (a memory watchdog stop), stopped with `docker stop` and
   * kept. Idempotent; how the container ended.
   */
  async stopAndRemove(keep: boolean, stopKept = false): Promise<ContainerEnd> {
    this.stopping = true
    if (this.pendingStart) await this.pendingStart
    if (!this.runAttempted) return 'none-started'
    if (keep) {
      if (stopKept) return this.stopKeptContainer()
      this.log.info(`container: ${this.name} kept (--keep-container); remove it with docker rm -f ${this.name}`)
      return 'kept-running'
    }
    return (await this.remove()) ? 'removed' : 'not-removed'
  }
}
