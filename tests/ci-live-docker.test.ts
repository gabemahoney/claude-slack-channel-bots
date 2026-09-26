/**
 * ci-live-docker.test.ts — Tests for how the /ci-live runner reaches docker
 * and child processes (bug b.1cx): the `docker run` argv and its guard
 * (`ci-live/lib/docker.ts`), the one `docker exec` path (`lib/container.ts`),
 * the minimal child environment (`lib/proc.ts`) and the run lock
 * (`lib/run-lock.ts`).
 *
 * The rules under test:
 * - the container is on the default network, publishes no port, shares no
 *   host namespace, is not privileged, bind-mounts nothing under the host's
 *   ~/.claude or holding it ($HOME, /home, /), by lexical or real path, and
 *   gets a secret only as a bare `--env NAME` (its value in the child
 *   environment, never an argv); the guard accepts only the runner's own
 *   flags, in any spelling, then the image and nothing after it, and a
 *   `--mount` only with the fields the runner writes, each named once, with
 *   no quote or line break;
 * - a run's container is `cscb-live-<run id>-<owner PID>`, and the runner
 *   removes it only when `docker inspect` (its ID and labels, never its env)
 *   shows this runner's PID as owner, by that ID;
 * - the container's Claude key comes from the host's `CI_ANTHROPIC_*`, never
 *   the host's own `ANTHROPIC_*`;
 * - a child process gets only an allowlisted environment: no `SLACK_*`,
 *   `ANTHROPIC_*`, `CI_ANTHROPIC_*` or `CSCB_LIVE_*` value;
 * - one run per mode holds the lock; a stale lock is replaced, and a
 *   leftover container whose runner is alive is never removed;
 * - the image's agent-director binary is the host's own, found as its client
 *   finds it (`~/.agent-director/bin` first, then PATH in order), by real
 *   path, and only a regular executable file (`lib/agent-director-binary.ts`);
 * - the runner waits for the boot it caused and accepts only that boot
 *   number with status `ok` (`lib/container-boot.ts`);
 * - every command that changes CSCB, tmux or agent-director runs through
 *   `docker exec` in a `cscb-live-` container; the host runs only the
 *   HOST check's read-only probes, npm pack, git and docker;
 * - SIGINT, SIGTERM and SIGHUP all clean up (Playwright's own handlers off).
 *
 * Nothing here runs docker: spawns go to a recording fake. The wiring that
 * lives in `ci-live/runtime/` and `ci-live/main.ts` (which load
 * playwright-core, so no test imports them) is pinned by a source audit.
 *
 * SPDX-License-Identifier: MIT
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, delimiter, dirname, join, relative, resolve } from 'node:path'

import { hostAgentDirectorBinary, type BinaryProbe } from '../ci-live/lib/agent-director-binary.ts'
import { BOOT_DONE_FILE, bootProblem, bootReached, parseBootDone, type BootRecord } from '../ci-live/lib/container-boot.ts'
import { HELPERS_PATH, TestContainer } from '../ci-live/lib/container.ts'
import {
  assertSafeRunArgs,
  buildExecArgs,
  buildImageArgs,
  buildRunArgs,
  claudeChildEnv,
  claudeEnvProblem,
  CONTAINER_OWNER_LABEL_KEY,
  containerName,
  DockerCli,
  INSPECT_OWNER_FORMAT,
  isLiveContainerName,
  parseContainerOwnership,
  type RunSpec,
} from '../ci-live/lib/docker.ts'
import { CHILD_ENV_ALLOWLIST, minimalChildEnv, type ProcResult, type SpawnOptions } from '../ci-live/lib/proc.ts'
import { isLiveRunnerPid, lockHolder, lockPid, nodeLockDeps, RunLock, type LockDeps } from '../ci-live/lib/run-lock.ts'
import { NotRunnableError } from '../ci-live/lib/secrets.ts'
import { balancedAfter, callArguments, callsOf, objectProperties, onlyCallArguments, splitTopLevel, stripComments } from './test-helpers/source-audit.ts'
import { APP_TOKEN_PREFIX, assertNoLeak, BOT_TOKEN_PREFIX, fakeToken, LEAK_SENTINEL } from './test-helpers/credentials.ts'

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const HOME = '/home/tester'
/** The container of run 1700000000 started by runner PID 4242 (the owner `runSpec` labels it with). */
const NAME = 'cscb-live-1700000000-4242'
const GATEWAY_KEY = `gw-key-${LEAK_SENTINEL}`

/** A host environment holding every kind of value that must never reach a child. */
function hostEnv(): Record<string, string | undefined> {
  return {
    PATH: '/usr/bin:/bin',
    HOME,
    USER: 'tester',
    DOCKER_HOST: 'unix:///run/docker.sock',
    TMUX_TMPDIR: '/run/user/1000',
    LANG: '',
    SLACK_BOT_TOKEN: fakeToken(BOT_TOKEN_PREFIX, 'prod-bot'),
    SLACK_APP_TOKEN: fakeToken(APP_TOKEN_PREFIX, 'prod-app'),
    SLACK_STATE_DIR: `${HOME}/.claude/channels/slack`,
    ANTHROPIC_API_KEY: `worker-own-${LEAK_SENTINEL}`,
    ANTHROPIC_BASE_URL: 'https://worker.invalid',
    CI_ANTHROPIC_API_KEY: GATEWAY_KEY,
    CI_ANTHROPIC_BASE_URL: 'https://gateway.invalid',
    CI_ANTHROPIC_MODEL: 'model-x',
    CSCB_LIVE_TEST_PASSWORD: `pw-${LEAK_SENTINEL}`,
    GH_TOKEN: `gh-${LEAK_SENTINEL}`,
  }
}

/** The spec the runner starts the container with: the tarball and the credentials dir, both read-only, and its owner's PID. */
function runSpec(overrides: Partial<RunSpec> = {}): RunSpec {
  return {
    name: NAME,
    mounts: [
      { source: '/tmp/pack/package.tgz', target: '/tmp/package.tgz', readOnly: true },
      { source: `${HOME}/.config/cscb-test/credentials`, target: '/home/testuser/.config/cscb', readOnly: true },
    ],
    secretEnvNames: ['ANTHROPIC_API_KEY', 'ANTHROPIC_BASE_URL', 'ANTHROPIC_MODEL'],
    plainEnv: { CSCB_LIVE_TEST_HOST: NAME },
    labels: { [CONTAINER_OWNER_LABEL_KEY]: '4242' },
    ...overrides,
  }
}

/** Lexical paths only (no symlink resolution), for guard cases that must not depend on the host's file system. */
const lexical = (p: string): string => resolve(p)

interface SpawnCall {
  argv: string[]
  options: SpawnOptions
}

function recordingSpawn(result: Partial<ProcResult> = {}) {
  const calls: SpawnCall[] = []
  const spawn = async (argv: readonly string[], options: SpawnOptions): Promise<ProcResult> => {
    calls.push({ argv: [...argv], options })
    return { code: 0, stdout: '', stderr: '', timedOut: false, ...result }
  }
  return { calls, spawn }
}

// ---------------------------------------------------------------------------
// docker run
// ---------------------------------------------------------------------------

describe('buildRunArgs and assertSafeRunArgs', () => {
  test('the run argv: detached with init, named, labelled with its owner, read-only bind mounts, secrets by name only, the image last; the guard accepts it', () => {
    const args = buildRunArgs(runSpec())
    expect(args).toEqual([
      'run', '-d', '--init', '--name', NAME, '--hostname', NAME, '--label', 'cscb-live=1', '--label', 'cscb-live-owner=4242',
      '--mount', 'type=bind,source=/tmp/pack/package.tgz,target=/tmp/package.tgz,readonly',
      '--mount', `type=bind,source=${HOME}/.config/cscb-test/credentials,target=/home/testuser/.config/cscb,readonly`,
      '--env', 'ANTHROPIC_API_KEY', '--env', 'ANTHROPIC_BASE_URL', '--env', 'ANTHROPIC_MODEL',
      '--env', `CSCB_LIVE_TEST_HOST=${NAME}`,
      'cscb-ci-live:latest',
    ])
    expect(() => assertSafeRunArgs(args, HOME)).not.toThrow()
  })

  test('the Claude key travels in the child environment, never in the argv', () => {
    const claude = claudeChildEnv(hostEnv())
    const args = buildRunArgs(runSpec({ secretEnvNames: claude.names }))
    assertSafeRunArgs(args, HOME)
    expect(args.join(' ')).not.toContain(GATEWAY_KEY)
    expect(claude.childEnv.ANTHROPIC_API_KEY).toBe(GATEWAY_KEY)
    assertNoLeak(args)
  })

  const base = ['run', '-d', '--name', NAME]
  const NETWORK = 'docker run uses the default network only (no --network)'
  const PUBLISH = 'docker run must not publish a port'
  const NAMESPACE = 'docker run must not share a host namespace'
  const CLAUDE = "docker run must not mount the host's ~/.claude"
  const HOLDS_CLAUDE = "docker run must not mount a directory that holds the host's ~/.claude"
  const BIND_ONLY = 'docker run mounts only with --mount type=bind'
  const QUOTE = 'docker run --mount must not hold a quote or a line break'
  const UNNAMED_FIELD = 'docker run --mount field (unnamed) is not one the runner uses'
  // A mount source the guard would accept on its own: sentinel-bearing, so a refusal that echoes it fails assertNoLeak.
  const SRC = `/srv/pack-${LEAK_SENTINEL}`
  // Each row: the argv after `run -d --name <name>` (image included), and the rule that refuses it.
  test.each([
    ['--network=host', ['--network=host', 'img'], NETWORK],
    ['--network host', ['--network', 'host', 'img'], NETWORK],
    ['--net=host', ['--net=host', 'img'], NETWORK],
    ['--net host', ['--net', 'host', 'img'], NETWORK],
    ['any --network, host or not', ['--network', 'bridge', 'img'], NETWORK],
    ['-p 3100:3100', ['-p', '3100:3100', 'img'], PUBLISH],
    ['-p3100:3100 (attached)', ['-p3100:3100', 'img'], PUBLISH],
    ['-P', ['-P', 'img'], PUBLISH],
    ['--publish=', ['--publish=3100:3100', 'img'], PUBLISH],
    ['--publish-all', ['--publish-all', 'img'], PUBLISH],
    ['--expose', ['--expose', '3100', 'img'], PUBLISH],
    ['--privileged', ['--privileged', 'img'], 'docker run must not be privileged'],
    ['--pid=host', ['--pid=host', 'img'], NAMESPACE],
    ['--pid host', ['--pid', 'host', 'img'], NAMESPACE],
    ['--ipc=host', ['--ipc=host', 'img'], NAMESPACE],
    ['--uts=host', ['--uts=host', 'img'], NAMESPACE],
    ['--userns=host', ['--userns=host', 'img'], NAMESPACE],
    ['--volumes-from', ['--volumes-from', 'x', 'img'], 'docker run must not use --volumes-from'],
    ['--volumes-from=', ['--volumes-from=x', 'img'], 'docker run must not use --volumes-from'],
    ['-v', ['-v', `${HOME}/.claude:/x`, 'img'], BIND_ONLY],
    ['-v (attached)', [`-v${HOME}/.claude:/x`, 'img'], BIND_ONLY],
    ['--volume=', ['--volume=/tmp:/x', 'img'], BIND_ONLY],
    ['--env-file', ['--env-file', '/tmp/env', 'img'], 'docker run must not use an env file'],
    ['a mount of ~/.claude', ['--mount', `type=bind,source=${HOME}/.claude,target=/x`, 'img'], CLAUDE],
    ['a joined --mount= of ~/.claude', [`--mount=type=bind,source=${HOME}/.claude,target=/x`, 'img'], CLAUDE],
    ['a mount under ~/.claude', ['--mount', `type=bind,target=/x,src=${HOME}/.claude/channels/slack`, 'img'], CLAUDE],
    ['a mount of $HOME', ['--mount', `type=bind,source=${HOME},target=/x`, 'img'], HOLDS_CLAUDE],
    ['a mount of /home', ['--mount', 'type=bind,source=/home,target=/x', 'img'], HOLDS_CLAUDE],
    ['a mount of /', ['--mount', 'type=bind,source=/,target=/x', 'img'], HOLDS_CLAUDE],
    ['a mount of ~/.claude spelled with ..', ['--mount', `type=bind,source=${HOME}/x/../.claude,target=/x`, 'img'], CLAUDE],
    ['a volume mount', ['--mount', 'type=volume,source=v,target=/x', 'img'], BIND_ONLY],
    ['a mount with no source', ['--mount', 'type=tmpfs,target=/x', 'img'], 'docker run --mount needs a source'],
    // docker lets the last of two spellings win, so a second source could slip ~/.claude past a check of the first.
    ['a source named twice (source, then src)', ['--mount', `type=bind,source=${SRC},src=${HOME}/.claude,target=/x`, 'img'], 'docker run --mount names its source more than once'],
    ['a source named twice (src, then source)', ['--mount', `type=bind,src=${HOME}/.claude,source=${SRC},target=/x`, 'img'], 'docker run --mount names its source more than once'],
    ['a target named twice (target, then dst)', ['--mount', `type=bind,source=${SRC},target=/x,dst=/y`, 'img'], 'docker run --mount names its target more than once'],
    ['a type named twice', ['--mount', `type=bind,source=${SRC},target=/x,type=volume`, 'img'], 'docker run --mount names its type more than once'],
    ['readonly named twice (readonly, ro)', ['--mount', `type=bind,source=${SRC},target=/x,readonly,ro`, 'img'], 'docker run --mount names its readonly more than once'],
    ['readonly=false', ['--mount', `type=bind,source=${SRC},target=/x,readonly=false`, 'img'], 'docker run --mount readonly takes no value'],
    ['a mount field the runner does not write', ['--mount', `type=bind,source=${SRC},target=/x,bind-propagation=rshared`, 'img'], 'docker run --mount field bind-propagation is not one the runner uses'],
    ['an uppercase SOURCE= (docker lowercases field names)', ['--mount', `type=bind,source=${SRC},target=/x,SOURCE=${HOME}/.claude`, 'img'], UNNAMED_FIELD],
    ['a path where a mount field name goes', ['--mount', `type=bind,source=${SRC},target=/x,${HOME}/.claude`, 'img'], UNNAMED_FIELD],
    ['an empty mount field', ['--mount', `type=bind,,source=${SRC},target=/x`, 'img'], UNNAMED_FIELD],
    ['a bare source with no value', ['--mount', 'type=bind,source,target=/x', 'img'], 'docker run --mount source needs a value'],
    ['a quoted mount field (docker reads the spec as CSV)', ['--mount', `type=bind,"source=${SRC},src=${HOME}/.claude",target=/x`, 'img'], QUOTE],
    ['a line break inside a mount spec', ['--mount', `type=bind,source=${SRC}\nsrc=${HOME}/.claude,target=/x`, 'img'], QUOTE],
    ['SLACK_BOT_TOKEN by name', ['--env', 'SLACK_BOT_TOKEN', 'img'], 'docker run must not pass SLACK_BOT_TOKEN'],
    ['--env=SLACK_BOT_TOKEN=…', [`--env=SLACK_BOT_TOKEN=${fakeToken(BOT_TOKEN_PREFIX)}`, 'img'], 'docker run must not pass SLACK_BOT_TOKEN'],
    ['-e SLACK_APP_TOKEN=…', ['-e', `SLACK_APP_TOKEN=${fakeToken(APP_TOKEN_PREFIX)}`, 'img'], 'docker run must not pass SLACK_APP_TOKEN'],
    ['-eSLACK_STATE_DIR=/x', ['-eSLACK_STATE_DIR=/x', 'img'], 'docker run must not pass SLACK_STATE_DIR'],
    ['--env SLACK_STATE_DIR=/x', ['--env', 'SLACK_STATE_DIR=/x', 'img'], 'docker run must not pass SLACK_STATE_DIR'],
    ['--env=ANTHROPIC_API_KEY=…', [`--env=ANTHROPIC_API_KEY=${GATEWAY_KEY}`, 'img'], 'docker run must pass ANTHROPIC_API_KEY by name only'],
    ['-eANTHROPIC_API_KEY=…', [`-eANTHROPIC_API_KEY=${GATEWAY_KEY}`, 'img'], 'docker run must pass ANTHROPIC_API_KEY by name only'],
    ['-e ANTHROPIC_AUTH_TOKEN=…', ['-e', `ANTHROPIC_AUTH_TOKEN=${GATEWAY_KEY}`, 'img'], 'docker run must pass ANTHROPIC_AUTH_TOKEN by name only'],
    ['-e CLAUDE_CODE_OAUTH_TOKEN=…', ['-e', `CLAUDE_CODE_OAUTH_TOKEN=${GATEWAY_KEY}`, 'img'], 'docker run must pass CLAUDE_CODE_OAUTH_TOKEN by name only'],
    ['a secret-named variable with a value', ['--env', `DB_PASSWORD=${GATEWAY_KEY}`, 'img'], 'docker run must pass DB_PASSWORD by name only'],
    ['a token-shaped value under any name', ['--env', `NOTES=${fakeToken(BOT_TOKEN_PREFIX)}`, 'img'], 'docker run --env NOTES holds token-shaped text'],
    ['a token where a variable name goes', ['--env', fakeToken(BOT_TOKEN_PREFIX), 'img'], 'docker run --env needs a plain variable name'],
    ['combined short flags', ['-dP', 'img'], 'docker run short flags must not be combined'],
    ['a value on a boolean flag', ['--init=false', 'img'], 'docker run --init takes no value'],
    ['a flag the runner does not use', ['--cap-add', 'ALL', 'img'], 'docker run flag --cap-add is not one the runner uses'],
    ['an unknown flag that could be a value', [`--${fakeToken(BOT_TOKEN_PREFIX)}`, 'img'], 'docker run flag (unnamed) is not one the runner uses'],
    ['a flag with no value at the end', ['--label'], 'docker run --label needs a value'],
    ['no image', [], 'docker run names no image'],
    ['a command after the image', ['img', 'bash', '-c', 'id'], 'docker run must not pass a command after the image'],
  ])('the guard refuses %s, naming no value', (_what, rest, reason) => {
    let err: unknown
    try {
      assertSafeRunArgs([...base, ...rest], HOME, lexical)
    } catch (e) {
      err = e
    }
    expect(err).toBeInstanceOf(Error)
    expect((err as Error).message).toStartWith(reason)
    expect((err as Error).message).not.toContain(HOME)
    assertNoLeak(err)
  })

  test.each([
    ['src, destination and a bare readonly', `type=bind,src=${SRC},destination=/x,readonly`],
    ['source, dst and ro', `type=bind,source=${SRC},dst=/x,ro`],
    ['a writable mount (no readonly)', `type=bind,source=${SRC},target=/x`],
  ])("the guard accepts the runner's mount fields in docker's other spellings: %s", (_what, spec) => {
    expect(() => assertSafeRunArgs([...base, '--mount', spec, 'img'], HOME, lexical)).not.toThrow()
  })

  test('the guard refuses anything but a run argv', () => {
    expect(() => assertSafeRunArgs(['exec', NAME, 'id'], HOME, lexical)).toThrow('not a docker run argv')
  })

  test('the guard checks mounts by their real path: a symlink to ~/.claude, and ~/.claude that is itself a symlink', () => {
    const links: Record<string, string> = { '/tmp/innocent': `${HOME}/.claude`, [`${HOME}/.claude`]: '/data/claude-real' }
    const realPath = (p: string) => links[resolve(p)] ?? resolve(p)
    const mount = (source: string) => [...base, '--mount', `type=bind,source=${source},target=/x`, 'img']
    expect(() => assertSafeRunArgs(mount('/tmp/innocent'), HOME, realPath)).toThrow(CLAUDE)
    expect(() => assertSafeRunArgs(mount('/data/claude-real/projects'), HOME, realPath)).toThrow(CLAUDE)
    expect(() => assertSafeRunArgs(mount('/data'), HOME, realPath)).toThrow(HOLDS_CLAUDE)
  })

  test("a mount whose path only starts like ~/.claude (a sibling) is not the host's ~/.claude", () => {
    expect(() => assertSafeRunArgs([...base, '--mount', `type=bind,source=${HOME}/.claude-other,target=/x`, 'img'], HOME, lexical)).not.toThrow()
    expect(() => assertSafeRunArgs([...base, `--mount=type=bind,source=${HOME}/.claude2,target=/x,readonly`, '--env=NOTES=plain', '-eX=1', 'img'], HOME, lexical)).not.toThrow()
  })

  test('buildImageArgs builds Dockerfile.live with the host uid and gid and the staged agent-director binary as a named build context', () => {
    expect(buildImageArgs({ repoRoot: '/repo', uid: 1000, gid: 1001, agentDirectorDir: '/tmp/ad-stage' })).toEqual([
      'build', '-f', '/repo/docker/Dockerfile.live', '--build-context', 'agent-director-bin=/tmp/ad-stage',
      '--build-arg', 'HOST_UID=1000', '--build-arg', 'HOST_GID=1001', '-t', 'cscb-ci-live:latest', '/repo',
    ])
    expect(() => buildImageArgs({ repoRoot: '/repo', uid: 1000, gid: 1001 })).toThrow('needs the staged agent-director binary dir')
  })
})

describe('the Claude credentials', () => {
  test("claudeChildEnv maps CI_ANTHROPIC_* to ANTHROPIC_* and never reads the host's own ANTHROPIC_*", () => {
    const env = hostEnv()
    expect(claudeChildEnv(env)).toEqual({
      childEnv: { ANTHROPIC_API_KEY: GATEWAY_KEY, ANTHROPIC_BASE_URL: 'https://gateway.invalid', ANTHROPIC_MODEL: 'model-x' },
      names: ['ANTHROPIC_API_KEY', 'ANTHROPIC_BASE_URL', 'ANTHROPIC_MODEL'],
    })
    expect(claudeChildEnv({ ANTHROPIC_API_KEY: env.ANTHROPIC_API_KEY, CI_ANTHROPIC_MODEL: '' })).toEqual({ childEnv: {}, names: [] })
  })

  test.each([
    [{}, 'env CI_ANTHROPIC_API_KEY is not set (the bot Claudes in the container need it)'],
    [{ ANTHROPIC_API_KEY: GATEWAY_KEY }, 'env CI_ANTHROPIC_API_KEY is not set (the bot Claudes in the container need it)'],
    [{ CI_ANTHROPIC_API_KEY: GATEWAY_KEY }, 'env CI_ANTHROPIC_API_KEY is a gateway key: also set CI_ANTHROPIC_BASE_URL and CI_ANTHROPIC_MODEL'],
    [{ CI_ANTHROPIC_API_KEY: GATEWAY_KEY, CI_ANTHROPIC_BASE_URL: 'https://g.invalid' }, 'env CI_ANTHROPIC_API_KEY is a gateway key: also set CI_ANTHROPIC_BASE_URL and CI_ANTHROPIC_MODEL'],
    [{ CI_ANTHROPIC_API_KEY: GATEWAY_KEY, CI_ANTHROPIC_BASE_URL: 'https://g.invalid', CI_ANTHROPIC_MODEL: 'm' }, null],
    [{ CI_ANTHROPIC_API_KEY: `sk-ant-${LEAK_SENTINEL}` }, null],
  ])('claudeEnvProblem(%#) names the variable to set, never its value', (env, expected) => {
    const problem = claudeEnvProblem(env)
    expect(problem).toBe(expected)
    assertNoLeak(problem)
  })
})

// ---------------------------------------------------------------------------
// Child environments
// ---------------------------------------------------------------------------

describe('minimalChildEnv', () => {
  test("keeps only the allowlisted, non-empty variables (TMUX_TMPDIR too, so the host probe's tmux finds the production socket)", () => {
    const env = minimalChildEnv(hostEnv())
    expect(env).toEqual({ PATH: '/usr/bin:/bin', HOME, USER: 'tester', DOCKER_HOST: 'unix:///run/docker.sock', TMUX_TMPDIR: '/run/user/1000' })
    expect(CHILD_ENV_ALLOWLIST.filter((n) => /^(SLACK|ANTHROPIC|CI_|CSCB)|TOKEN|KEY|PASS/.test(n))).toEqual([])
    assertNoLeak(env)
  })

  test("DockerCli gives docker its base environment plus the call's extra values, and nothing from the host", async () => {
    const { calls, spawn } = recordingSpawn()
    const docker = new DockerCli(spawn, minimalChildEnv(hostEnv()))
    await docker.run(['ps'], { timeoutMs: 1000 })
    await docker.run(['run', 'x'], { timeoutMs: 1000, extraEnv: claudeChildEnv(hostEnv()).childEnv })
    expect(calls.map((c) => c.argv)).toEqual([['docker', 'ps'], ['docker', 'run', 'x']])
    expect(Object.keys(calls[0]!.options.env).sort()).toEqual(['DOCKER_HOST', 'HOME', 'PATH', 'TMUX_TMPDIR', 'USER'])
    expect(Object.keys(calls[1]!.options.env).sort()).toEqual(['ANTHROPIC_API_KEY', 'ANTHROPIC_BASE_URL', 'ANTHROPIC_MODEL', 'DOCKER_HOST', 'HOME', 'PATH', 'TMUX_TMPDIR', 'USER'])
    expect(calls[1]!.options.env.ANTHROPIC_API_KEY).toBe(GATEWAY_KEY)
  })
})

// ---------------------------------------------------------------------------
// docker exec
// ---------------------------------------------------------------------------

describe('container names', () => {
  test.each([
    ['1700000000', 4242, NAME],
    ['abc123', 1, 'cscb-live-abc123-1'],
    ['x'.repeat(32), 9999999999, `cscb-live-${'x'.repeat(32)}-9999999999`],
  ])('containerName(%p, %p) is %p, a live container name', (runId, pid, name) => {
    expect(containerName(runId, pid)).toBe(name)
    expect(isLiveContainerName(name)).toBe(true)
  })

  test("the owner PID defaults to this process's, so two runners started in the same second get different names", () => {
    expect(containerName('1700000000')).toBe(`cscb-live-1700000000-${process.pid}`)
    expect(containerName('1700000000', 1111)).not.toBe(containerName('1700000000', 2222))
  })

  test.each(['', 'ABC', '../x', 'a b', 'a-b', 'x'.repeat(33)])('containerName refuses the run id %p', (runId) => {
    expect(() => containerName(runId, 4242)).toThrow('run id must be lowercase letters and digits')
  })

  test.each([0, -1, 1.5, 12345678901, Number.NaN])('containerName refuses the owner PID %p', (pid) => {
    expect(() => containerName('1700000000', pid)).toThrow('owner PID must be a positive integer')
  })

  test("an older runner's bare cscb-live-<run id> is still a live container name (so leftover removal can sweep it)", () => {
    expect(isLiveContainerName('cscb-live-1700000000')).toBe(true)
  })

  test.each([
    'cscb-live-',
    'cscb-live-ABC',
    'cscb-live-1;rm',
    'cscb-live-abc-',
    'cscb-live-abc-0',
    'cscb-live-abc-12345678901',
    'cscb-live-a-b-1',
    'slack_bot_persona_a',
    'cscb_persona_a',
    'cscb-ci',
    'x-cscb-live-1',
  ])('%p is not a live container name', (name) => {
    expect(isLiveContainerName(name)).toBe(false)
  })
})

describe('parseContainerOwnership (the owner docker inspect shows for a name)', () => {
  const ME = 4242
  const ID = '0123456789abcdef'.repeat(4)
  const OURS = '{"cscb-live":"1","cscb-live-owner":"4242"}'
  const inspected = (labels: string, id = ID) => ({ code: 0, stdout: `${id}\t${labels}\n`, stderr: '' })
  const failed = (stderr: string) => ({ code: 1, stdout: '', stderr })

  test("the format reads the container's ID and labels only, never its env (which holds the Claude key)", () => {
    expect(INSPECT_OWNER_FORMAT).toBe('{{.Id}}\t{{json .Config.Labels}}')
  })

  test.each([
    ['no container of that name', failed(`Error: No such container: ${NAME}\n`), { kind: 'absent' }],
    ['no object of that name', failed(`Error: No such object: ${NAME}\n`), { kind: 'absent' }],
    ['docker failing (no daemon)', failed('Cannot connect to the Docker daemon at unix:///var/run/docker.sock. Is the docker daemon running?\n'), { kind: 'unknown' }],
    ["labelled cscb-live=1 and this runner's PID", inspected(OURS), { kind: 'ours', id: ID }],
    ["another runner's PID", inspected('{"cscb-live":"1","cscb-live-owner":"777"}'), { kind: 'foreign' }],
    ['no owner label', inspected('{"cscb-live":"1"}'), { kind: 'foreign' }],
    ["this runner's PID but no cscb-live=1", inspected('{"cscb-live-owner":"4242"}'), { kind: 'foreign' }],
    ['no labels (null)', inspected('null'), { kind: 'foreign' }],
    ['an empty label set', inspected('{}'), { kind: 'foreign' }],
    ['an ID that is not 64 lowercase hex digits', inspected(OURS, ID.toUpperCase()), { kind: 'unknown' }],
    ['a short ID', inspected(OURS, 'abc123'), { kind: 'unknown' }],
    ['labels that are not JSON', inspected('{cscb-live:1'), { kind: 'unknown' }],
    ['labels that are a JSON array', inspected('["cscb-live=1"]'), { kind: 'unknown' }],
    ['no tab', { code: 0, stdout: `${ID}\n`, stderr: '' }, { kind: 'unknown' }],
    ['two lines', { code: 0, stdout: `${ID}\t${OURS}\n${ID}\t${OURS}\n`, stderr: '' }, { kind: 'unknown' }],
  ] as const)('%s', (_what, result, expected) => {
    expect(parseContainerOwnership(result, ME)).toEqual(expected)
  })
})

describe('TestContainer', () => {
  test.each(['cscb-live-', 'cscb-ci', 'slack_bot_persona_a', 'cscb-live-UPPER'])('refuses to exec in %p', (name) => {
    const { calls, spawn } = recordingSpawn()
    expect(() => new TestContainer(new DockerCli(spawn, {}), name)).toThrow('refusing to exec')
    expect(calls).toEqual([])
  })

  test('exec runs docker exec as the test user in its home, in the named container', async () => {
    const { calls, spawn } = recordingSpawn()
    const c = new TestContainer(new DockerCli(spawn, { PATH: '/bin' }), NAME)
    await c.exec(['tmux', 'kill-session', '-t', 'slack_bot_persona_a'])
    await c.exec(['id'], { user: 'root' })
    expect(calls.map((x) => x.argv)).toEqual([
      ['docker', 'exec', '-u', 'testuser', '-w', '/home/testuser', '-e', 'HOME=/home/testuser', NAME, 'tmux', 'kill-session', '-t', 'slack_bot_persona_a'],
      ['docker', 'exec', '-u', 'root', '-w', '/root', '-e', 'HOME=/root', NAME, 'id'],
    ])
    expect(calls[0]!.options.env).toEqual({ PATH: '/bin' })
  })

  test("sh runs the script in bash with the plan's helpers sourced first", async () => {
    const { calls, spawn } = recordingSpawn()
    await new TestContainer(new DockerCli(spawn, {}), NAME).sh('mark')
    expect(calls[0]!.argv.slice(-3)).toEqual(['bash', '-c', `source ${HELPERS_PATH} || exit 97\nmark`])
  })

  test('writeFile sends the content on stdin, never in the argv, and names the path and mode as arguments', async () => {
    const { calls, spawn } = recordingSpawn()
    const content = `{"note": "${LEAK_SENTINEL}"}`
    await new TestContainer(new DockerCli(spawn, {}), NAME).writeFile('/home/testuser/x.json', content, '600')
    const call = calls[0]!
    expect(call.argv.slice(0, 3)).toEqual(['docker', 'exec', '-i'])
    expect(call.argv.slice(-3)).toEqual(['write', '/home/testuser/x.json', '600'])
    expect(call.options.stdin).toBe(content)
    assertNoLeak(call.argv)
  })

  test('writeFile refuses a mode that is not three octal digits, and reports a failed write by path and exit code', async () => {
    const ok = recordingSpawn()
    await expect(new TestContainer(new DockerCli(ok.spawn, {}), NAME).writeFile('/x', 'y', '6000')).rejects.toThrow('three octal digits')
    expect(ok.calls).toEqual([])
    const failing = recordingSpawn({ code: 1, stderr: LEAK_SENTINEL })
    let err: unknown
    await new TestContainer(new DockerCli(failing.spawn, {}), NAME).writeFile('/x', LEAK_SENTINEL).catch((e) => (err = e))
    expect((err as Error).message).toBe('writing /x in the container failed (exit 1)')
    assertNoLeak(err)
  })

  test('buildExecArgs adds -i only for stdin and honours a workdir', () => {
    expect(buildExecArgs(NAME, ['ls'], { interactive: true, workdir: '/tmp' })).toEqual(['exec', '-i', '-u', 'testuser', '-w', '/tmp', '-e', 'HOME=/home/testuser', NAME, 'ls'])
  })
})

// ---------------------------------------------------------------------------
// The run lock (one run per mode at a time; a live run's container is never removed)
// ---------------------------------------------------------------------------

describe('RunLock', () => {
  const LOCK = '/cfg/run.lock'
  const ME = 4242

  /** Lock files in memory; `live` is the set of PIDs that are live ci-live runners. */
  function lockDeps(files: Record<string, string> = {}, live: number[] = [], extra: Partial<LockDeps> = {}) {
    const state = new Map(Object.entries(files))
    const deps: LockDeps = {
      createExclusive: (path, data) => (state.has(path) ? false : (state.set(path, data), true)),
      read: (path) => state.get(path) ?? null,
      unlink: (path) => void state.delete(path),
      isLiveRunner: (pid) => live.includes(pid),
      pid: ME,
      ...extra,
    }
    return { deps, state }
  }

  test('a free lock is taken with this PID and released once; release leaves a lock another runner took since', () => {
    const { deps, state } = lockDeps()
    const lock = RunLock.acquire(LOCK, 'run', deps)
    expect(state.get(LOCK)).toBe(`${ME}\n`)
    lock.release()
    lock.release()
    expect(state.has(LOCK)).toBe(false)

    const again = RunLock.acquire(LOCK, 'run', deps)
    state.set(LOCK, '777\n')
    again.release()
    expect(state.get(LOCK)).toBe('777\n')
  })

  test('a lock a live runner holds is not runnable, naming its PID and the path, and is left alone', () => {
    const { deps, state } = lockDeps({ [LOCK]: '777\n' }, [777])
    const err = (() => {
      try {
        RunLock.acquire(LOCK, '/ci-live dry run', deps)
      } catch (e) {
        return e as Error
      }
      throw new Error('expected a refusal')
    })()
    expect(err).toBeInstanceOf(NotRunnableError)
    expect(err.message).toBe(`another /ci-live dry run (PID 777) is in progress and holds ${LOCK}: wait for it to finish`)
    expect(state.get(LOCK)).toBe('777\n')
  })

  test.each([
    ['a dead PID', '777\n'],
    ['a PID that is no ci-live runner any more', '888\n'],
    ['text that is no PID', 'garbage'],
    ['an empty file', ''],
  ])('a stale lock (%s) is replaced', (_what, content) => {
    const { deps, state } = lockDeps({ [LOCK]: content }, [])
    RunLock.acquire(LOCK, 'run', deps)
    expect(state.get(LOCK)).toBe(`${ME}\n`)
  })

  test('a lock that keeps reappearing is not runnable, telling the operator to remove it if no run is in progress', () => {
    const { deps } = lockDeps({}, [], { createExclusive: () => false, read: () => null })
    expect(() => RunLock.acquire(LOCK, 'run', deps)).toThrow(`could not take the run lock ${LOCK}: remove it if no /ci-live run is in progress`)
  })

  test('lockHolder names only another live runner', () => {
    expect(lockHolder(LOCK, lockDeps({ [LOCK]: '777\n' }, [777]).deps)).toBe(777)
    expect(lockHolder(LOCK, lockDeps({ [LOCK]: `${ME}\n` }, [ME]).deps)).toBeNull()
    expect(lockHolder(LOCK, lockDeps({ [LOCK]: '777\n' }, []).deps)).toBeNull()
    expect(lockHolder(LOCK, lockDeps().deps)).toBeNull()
  })

  test.each([
    ['123\n', 123],
    ['123', 123],
    ['12345678901', null],
    ['-1', null],
    ['1 2', null],
    [null, null],
  ])('lockPid(%p) is %p', (text, pid) => {
    expect(lockPid(text)).toBe(pid)
  })

  describe('isLiveRunnerPid', () => {
    test.each([
      ['bun ci-live/run.ts --dry-run ', '/anywhere', true],
      ['/usr/local/bin/bun /repo/ci-live/run.ts ', '/', true],
      ['bun run.ts login ', '/repo/ci-live', true],
      ['bun run.ts ', '/repo/other', false],
      ['bun ci-live/run.tsx ', '/repo', false],
      ['bun test tests/ci-live-docker.test.ts ', '/repo', false],
    ])('%p in %p → %p', (cmdline, cwd, live) => {
      expect(isLiveRunnerPid(1234, () => cmdline, () => cwd)).toBe(live)
    })

    test.each([0, -5, 1.5, Number.NaN])('an impossible PID (%p) is not a runner, and /proc is not read', (pid) => {
      let reads = 0
      expect(isLiveRunnerPid(pid, () => (reads++, 'bun ci-live/run.ts'), () => null)).toBe(false)
      expect(reads).toBe(0)
    })

    test('a PID that is gone (no cmdline) is not a runner', () => {
      expect(isLiveRunnerPid(1234, () => null, () => '/repo/ci-live')).toBe(false)
    })
  })

  describe('on the real file system', () => {
    let dir: string
    beforeEach(() => {
      dir = mkdtempSync(join(tmpdir(), 'ci-live-lock-'))
    })
    afterEach(() => {
      rmSync(dir, { recursive: true, force: true })
    })

    test('the lock file is created exclusively with mode 600 and removed on release', () => {
      const path = join(dir, 'run.lock')
      const lock = RunLock.acquire(path, 'run', { ...nodeLockDeps, isLiveRunner: () => false })
      expect([readFileSync(path, 'utf-8'), statSync(path).mode & 0o777]).toEqual([`${process.pid}\n`, 0o600])
      expect(nodeLockDeps.createExclusive(path, 'x')).toBe(false)
      lock.release()
      expect([nodeLockDeps.read(path), readdirSync(dir)]).toEqual([null, []])
      expect(() => nodeLockDeps.unlink(path)).not.toThrow()
    })
  })
})

// ---------------------------------------------------------------------------
// The host's agent-director binary (the image's build context)
// ---------------------------------------------------------------------------

describe('hostAgentDirectorBinary', () => {
  const HOME_BIN = `${HOME}/.agent-director/bin/agent-director`
  const onPath = (...dirs: string[]) => dirs.join(delimiter)

  /**
   * A fake file system for the probe: an executable file, a file that is not
   * executable, an executable directory, a symlink (`-> target`), or a path
   * whose realpath or stat fails; any other path is missing. Every probe
   * call is logged in order.
   */
  type Entry = 'exec' | 'noexec' | 'dir' | 'realpath-fails' | 'stat-fails' | `-> ${string}`
  function fakeProbe(entries: Record<string, Entry>) {
    const calls: string[] = []
    const follow = (p: string): string => {
      const e = entries[p]
      return e?.startsWith('-> ') ? follow(e.slice(3)) : p
    }
    const probe: BinaryProbe = {
      assertExecutable: (p) => {
        calls.push(`access ${p}`)
        const e = entries[follow(p)]
        if (e === undefined || e === 'noexec') throw new Error(e === undefined ? 'ENOENT' : 'EACCES')
      },
      realpath: (p) => {
        calls.push(`realpath ${p}`)
        if (entries[p] === 'realpath-fails') throw new Error('ELOOP')
        return follow(p)
      },
      isFile: (p) => {
        calls.push(`isFile ${p}`)
        if (entries[p] === 'stat-fails') throw new Error('EIO')
        return entries[p] === 'exec' || entries[p] === 'noexec'
      },
    }
    return { probe, calls }
  }
  const accessed = (calls: string[]) => calls.filter((c) => c.startsWith('access ')).map((c) => c.slice('access '.length))

  test('the home install comes first, before any PATH entry', () => {
    const p = fakeProbe({ [HOME_BIN]: 'exec', '/opt/a/agent-director': 'exec' })
    expect(hostAgentDirectorBinary(HOME, onPath('/opt/a'), p.probe)).toBe(HOME_BIN)
    expect(p.calls).toEqual([`access ${HOME_BIN}`, `realpath ${HOME_BIN}`, `isFile ${HOME_BIN}`])
  })

  test('without a home install, the PATH entries in order: the first match wins', () => {
    const p = fakeProbe({ '/opt/a/agent-director': 'exec', '/opt/b/agent-director': 'exec' })
    expect(hostAgentDirectorBinary(HOME, onPath('/opt/c', '/opt/b', '/opt/a'), p.probe)).toBe('/opt/b/agent-director')
    expect(accessed(p.calls)).toEqual([HOME_BIN, '/opt/c/agent-director', '/opt/b/agent-director'])
  })

  test.each([
    ['missing', undefined],
    ['not executable', 'noexec'],
    ['a directory', 'dir'],
    ['a realpath that fails (a symlink loop)', 'realpath-fails'],
    ['a stat that fails', 'stat-fails'],
    ['a dangling symlink', '-> /gone/agent-director'],
    ['a symlink to a directory', '-> /opt/dir'],
  ] as const)('a candidate that is %s is skipped for the next one', (_what, entry) => {
    const entries: Record<string, Entry> = { '/opt/dir': 'dir', '/opt/b/agent-director': 'exec' }
    if (entry !== undefined) {
      entries[HOME_BIN] = entry
      entries['/opt/a/agent-director'] = entry
    }
    const p = fakeProbe(entries)
    expect(hostAgentDirectorBinary(HOME, onPath('/opt/a', '/opt/b'), p.probe)).toBe('/opt/b/agent-director')
    expect(accessed(p.calls)).toEqual([HOME_BIN, '/opt/a/agent-director', '/opt/b/agent-director'])
  })

  test('empty PATH entries are skipped, never read as a relative agent-director in the working directory', () => {
    const p = fakeProbe({ 'agent-director': 'exec', '/agent-director': 'exec' })
    expect(hostAgentDirectorBinary(HOME, onPath('', '/opt/a', '', ''), p.probe)).toBeNull()
    expect(accessed(p.calls)).toEqual([HOME_BIN, '/opt/a/agent-director'])
  })

  test('the real path is returned, and it is the real path that must be a file', () => {
    const p = fakeProbe({ '/usr/local/bin/agent-director': '-> /opt/ad/2.0/agent-director', '/opt/ad/2.0/agent-director': 'exec' })
    expect(hostAgentDirectorBinary(HOME, onPath('/usr/local/bin'), p.probe)).toBe('/opt/ad/2.0/agent-director')
    expect(p.calls.slice(-2)).toEqual(['realpath /usr/local/bin/agent-director', 'isFile /opt/ad/2.0/agent-director'])
    const home = fakeProbe({ [HOME_BIN]: '-> /opt/ad/1.0/agent-director', '/opt/ad/1.0/agent-director': 'exec' })
    expect(hostAgentDirectorBinary(HOME, undefined, home.probe)).toBe('/opt/ad/1.0/agent-director')
  })

  test('an undefined PATH searches the home install only; nothing that matches is null', () => {
    const p = fakeProbe({ '/usr/bin/agent-director': 'exec' })
    expect(hostAgentDirectorBinary(HOME, undefined, p.probe)).toBeNull()
    expect(p.calls).toEqual([`access ${HOME_BIN}`])
    const none = fakeProbe({})
    expect(hostAgentDirectorBinary(HOME, onPath('/usr/bin', '/bin'), none.probe)).toBeNull()
    expect(accessed(none.calls)).toEqual([HOME_BIN, '/usr/bin/agent-director', '/bin/agent-director'])
  })

  describe('on the real file system (the default probe)', () => {
    let root: string
    beforeEach(() => {
      root = realpathSync(mkdtempSync(join(tmpdir(), 'ci-live-ad-bin-')))
    })
    afterEach(() => {
      rmSync(root, { recursive: true, force: true })
    })

    /** A file under the temp root with an explicit mode (umask-proof). */
    function file(rel: string, mode: number): string {
      const path = join(root, rel)
      mkdirSync(dirname(path), { recursive: true })
      writeFileSync(path, '#!/bin/sh\n')
      chmodSync(path, mode)
      return path
    }

    test('skips a file with no execute bit and a directory, and returns the real path behind a symlink; the home install wins when present', () => {
      const home = join(root, 'home')
      mkdirSync(home)
      file('noexec/agent-director', 0o644)
      mkdirSync(join(root, 'dir', 'agent-director'), { recursive: true })
      const real = file('store/agent-director-1.0', 0o755)
      mkdirSync(join(root, 'linked'))
      symlinkSync(real, join(root, 'linked', 'agent-director'))
      const path = onPath(join(root, 'noexec'), join(root, 'dir'), join(root, 'linked'))
      expect(hostAgentDirectorBinary(home, path)).toBe(real)
      expect(hostAgentDirectorBinary(home, onPath(join(root, 'noexec'), join(root, 'dir')))).toBeNull()
      const homeBin = file('home/.agent-director/bin/agent-director', 0o700)
      expect(hostAgentDirectorBinary(home, path)).toBe(homeBin)
    })
  })
})

// ---------------------------------------------------------------------------
// The live entrypoint's boot record
// ---------------------------------------------------------------------------

describe('the boot record (container-boot)', () => {
  test.each([
    ['a finished boot', 0, '1 ok', { boot: 1, status: 'ok' }],
    ['with the trailing newline the entrypoint writes', 0, '2 first-boot-failed\n', { boot: 2, status: 'first-boot-failed' }],
    ['a two-digit boot', 0, '12 ok\n', { boot: 12, status: 'ok' }],
    ['no record yet (cat failed)', 1, '', null],
    ['a non-zero exit, whatever was printed', 1, '1 ok\n', null],
    ['empty output', 0, '', null],
    ['garbage', 0, 'half a rec', null],
    ['an uppercase status', 0, '1 OK\n', null],
    ['no status', 0, '1\n', null],
    ['no boot number', 0, 'ok\n', null],
    ['a negative boot number', 0, '-1 ok\n', null],
    ['an extra field', 0, '1 ok extra\n', null],
    ['two records', 0, '1 ok\n2 ok\n', null],
  ] as const)('parseBootDone: %s', (_what, code, stdout, expected) => {
    expect(parseBootDone(code, stdout)).toEqual(expected)
  })

  test("bootReached: null while there is no record or it is an earlier boot's; the record itself at or above boot n, failed or not", () => {
    const rec = (boot: number, status = 'ok'): BootRecord => ({ boot, status })
    const [one, two, three, failed] = [rec(1), rec(2), rec(3), rec(2, 'first-boot-failed')]
    expect([bootReached(null, 1), bootReached(one, 2)]).toEqual([null, null])
    expect(bootReached(two, 2)).toBe(two)
    expect(bootReached(three, 2)).toBe(three)
    expect(bootReached(failed, 2)).toBe(failed)
  })

  test.each([
    ['a different boot than the one waited for', { boot: 3, status: 'ok' }, 2, 'the container entrypoint reports boot 3, not boot 2'],
    ['a failed boot', { boot: 1, status: 'first-boot-failed' }, 1, "the container entrypoint's boot 1 failed (first-boot-failed)"],
    ['a different boot that also failed: the number first', { boot: 2, status: 'first-boot-failed' }, 1, 'the container entrypoint reports boot 2, not boot 1'],
    ['the good boot', { boot: 2, status: 'ok' }, 2, null],
  ])('bootProblem: %s', (_what, done, n, expected) => {
    expect(bootProblem(done, n)).toBe(expected)
  })

  test('BOOT_DONE_FILE is where docker/live/entrypoint.sh writes "<boot> <status>", and every status it writes parses', () => {
    const entry = readFileSync(join(import.meta.dir, '..', 'docker', 'live', 'entrypoint.sh'), 'utf-8')
    expect(entry).toContain(`BOOT_DIR=${dirname(BOOT_DONE_FILE)}\n`)
    expect(entry).toContain(`BOOT_DONE="\${BOOT_DIR}/${basename(BOOT_DONE_FILE)}"`)
    expect(entry).toContain(`printf '%s %s\\n' "\${boot}" "\${status}" > "\${BOOT_DONE}.tmp"`)
    const statuses = [...new Set([...entry.matchAll(/\bstatus=([^\s;}]+)/g)].map((m) => m[1]!))].sort()
    expect(statuses).toEqual(['first-boot-failed', 'ok'])
    for (const status of statuses) expect(parseBootDone(0, `7 ${status}\n`)).toEqual({ boot: 7, status })
  })
})

// ---------------------------------------------------------------------------
// Wiring in the modules no test imports (source audit)
// ---------------------------------------------------------------------------

const CI_LIVE = join(import.meta.dir, '..', 'ci-live')

function runnerSources(dir = CI_LIVE): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const path = join(dir, entry)
    if (entry === 'node_modules') return []
    if (statSync(path).isDirectory()) return runnerSources(path)
    return path.endsWith('.ts') ? [path] : []
  })
}

function code(rel: string): string {
  return stripComments(readFileSync(join(CI_LIVE, rel), 'utf-8'))
}

describe('runner wiring (source audit of ci-live/)', () => {
  test('the host environment reaches a child only through minimalChildEnv or claudeChildEnv', () => {
    const allowed = [
      /\bminimalChildEnv\(process\.env\)/g,
      /\bclaudeChildEnv\(process\.env\)/g,
      /\bclaudeEnvProblem\(process\.env\)/g,
      /\bresolveConfigDir\(process\.env, homedir\(\)\)/g,
      /\bprocess\.env\.CI_ANTHROPIC_API_KEY\b/g,
    ]
    const failures: string[] = []
    for (const path of runnerSources()) {
      let text = stripComments(readFileSync(path, 'utf-8'))
      const rel = relative(CI_LIVE, path)
      // The real run's secret store reads its CSCB_LIVE_* overrides from the environment; nothing spawns from it.
      for (const at of callsOf(text, 'SecretStore').reverse()) {
        const args = callArguments(text, at)
        if (/dryRun: false/.test(args)) text = text.replace(args, args.replace('env: process.env', 'env: <store-env>'))
      }
      for (const re of allowed) text = text.replace(re, '<allowed>')
      const left = (text.match(/process\.env/g) ?? []).length
      if (left > 0) failures.push(`${rel}: ${left} other use(s) of process.env`)
      if (/\bBun\.env\b/.test(text)) failures.push(`${rel}: reads Bun.env`)
      if (/\bBun\.spawn(Sync)?\(/.test(text) && rel !== join('lib', 'proc.ts')) failures.push(`${rel}: calls Bun.spawn outside lib/proc.ts`)
      if (/child_process/.test(text)) failures.push(`${rel}: imports child_process`)
    }
    expect(failures).toEqual([])
  })

  test("bunSpawn (a host process) is used only at main.ts's three sites: the login code prompt, the host probes and ContainerRun", () => {
    const users = runnerSources().filter((p) => /\bbunSpawn\b/.test(stripComments(readFileSync(p, 'utf-8'))))
    expect(users.map((p) => relative(CI_LIVE, p)).sort()).toEqual([join('lib', 'proc.ts'), 'main.ts'])
    const text = code('main.ts')
    expect((text.match(/\bbunSpawn\b/g) ?? []).length).toBe(4)
    const calls = callsOf(text, 'bunSpawn').map((at) => callArguments(text, at).replace(/\s+/g, ' ').trim())
    expect(calls.length).toBe(2)
    // The prompt: bash reading the answer from the terminal, never echoing it; the host probes: snapshotHost's argv.
    expect(calls[0]).toStartWith(`['bash', '-c', 'printf "%s" "$1" > /dev/tty; IFS= read -rs v < /dev/tty;`)
    expect(calls[0]).toContain('{ env: minimalChildEnv(process.env),')
    expect(calls[1]).toBe('argv, { env, timeoutMs: 30_000 }')
    expect(text).toContain('const env = minimalChildEnv(process.env)\n  return {\n    run: (argv: readonly string[]) => bunSpawn(argv, { env, timeoutMs: 30_000 }),')
    expect(text).toContain('new ContainerRun(bunSpawn, env.log, env.runId, REPO_ROOT)')
  })

  test('ContainerRun runs on the host only npm pack, git rev-parse and git status, and only these docker commands', () => {
    const text = code(join('runtime', 'container-run.ts'))
    const hostArgv = [...text.matchAll(/\bthis\.host\(\s*(\[[^\]]*\])/g)].map((m) => m[1])
    expect(hostArgv).toEqual([
      "['npm', 'pack', '--ignore-scripts', '--pack-destination', dir]",
      "['git', 'rev-parse', '--short', 'HEAD']",
      "['git', 'status', '--porcelain']",
    ])
    expect((text.match(/\bthis\.host\(/g) ?? []).length).toBe(3)
    expect((text.match(/\bthis\.spawn\(/g) ?? []).length).toBe(1)
    const dockerFirst = [...text.matchAll(/\bthis\.docker\.run\(/g)].map((m) => {
      const first = callArguments(text, m.index!).trim()
      return first.startsWith('[') ? /^\[\s*'([a-z]+)'/.exec(first)?.[1] : /^[A-Za-z]+/.exec(first)?.[0]
    })
    expect([...new Set(dockerFirst)].sort()).toEqual(['args', 'buildImageArgs', 'image', 'info', 'inspect', 'logs', 'ps', 'restart', 'rm'])
  })

  test('leftover removal lists only cscb-live=1 containers and removes one only when its name is a live-run name and its runner (or the other mode\'s lock holder) is gone', () => {
    const text = code(join('runtime', 'container-run.ts'))
    const body = text.slice(...balancedAfter(text, text.indexOf('async removeLeftovers('), '{', '}'))
    const at = (s: string) => {
      const i = body.indexOf(s)
      if (i < 0) throw new Error(`removeLeftovers no longer holds: ${s}`)
      return i
    }
    const rm = at("this.docker.run(['rm', '-f', name]")
    expect((body.match(/'rm'/g) ?? []).length).toBe(1)
    expect(at("'--filter', `label=${CONTAINER_LABEL}`")).toBeLessThan(rm)
    expect(at('if (!isLiveContainerName(name) || name === this.name) continue')).toBeLessThan(rm)
    expect(at('if (pid !== null && pid !== process.pid && isLiveRunner(pid)) {')).toBeLessThan(rm)
    expect(at('if (pid === null && !ownerlessRemovable) {')).toBeLessThan(rm)
    const main = code('main.ts')
    expect(main).toContain('const otherLockFile = dry ? realRunLockFile(resolveConfigDir(process.env, homedir())) : dryRunLockFile(tmpdir(), process.getuid?.() ?? 0)')
    expect(main).toContain('await container.removeLeftovers((pid) => isLiveRunnerPid(pid), lockHolder(otherLockFile) === null)')
  })

  test("the run's own container is removed only when docker inspect shows this runner's PID as its owner, by the inspected ID; stopAndRemove goes through remove", () => {
    const text = code(join('runtime', 'container-run.ts'))
    const bodyOf = (decl: string) => {
      const at = text.indexOf(decl)
      if (at < 0) throw new Error(`container-run.ts no longer holds: ${decl}`)
      return text.slice(...balancedAfter(text, at, '{', '}'))
    }
    const inOrder = (body: string, parts: string[]) => {
      const at = parts.map((s) => body.indexOf(s))
      expect(parts.filter((_, i) => at[i]! < 0)).toEqual([])
      expect([...at].sort((a, b) => a - b)).toEqual(at)
    }
    // One PID throughout: the name, the owner label the container starts with, and the owner an inspect must show.
    expect(bodyOf('constructor(')).toContain('this.name = containerName(runId, process.pid)')
    expect(callArguments(text, text.indexOf('buildRunArgs('))).toContain('labels: { [CONTAINER_OWNER_LABEL_KEY]: String(process.pid) }')
    inOrder(bodyOf('private async ownership('), [
      "const r = await this.docker.run(['inspect', '--type', 'container', '--format', INSPECT_OWNER_FORMAT, this.name]",
      'return parseContainerOwnership(r, process.pid)',
    ])
    // Nothing but ours is removed, and by the ID inspected, never by name (a same-named container started since is not touched).
    inOrder(bodyOf('private async removeOwn('), [
      'const owner = await this.ownership()',
      "if (owner.kind !== 'ours') return owner.kind",
      "this.docker.run(['rm', '-f', owner.id]",
      "return r.code === 0 && gone.code !== 0 ? 'removed' : 'failed'",
    ])
    expect([...text.matchAll(/\[\s*'rm'[^\]]*\]/g)].map((m) => m[0])).toEqual(["['rm', '-f', name]", "['rm', '-f', owner.id]"])
    // No container left of ours (removed, or none there) is success; a foreign or unknown owner is not.
    inOrder(bodyOf('async remove('), ['const outcome = await this.removeOwn()', "return outcome === 'removed' || outcome === 'absent'"])
    const stop = bodyOf('async stopAndRemove(')
    inOrder(stop, ['this.stopping = true', 'if (this.pendingStart) await this.pendingStart', 'if (!this.runAttempted) return', 'if (keep) {', 'await this.remove()'])
    expect(stop).not.toContain('this.docker')
    // Every container inspect names its format: the owner's ID and labels, or the ID alone (a bare inspect prints the env).
    const inspects = runnerSources().flatMap((p) => [...stripComments(readFileSync(p, 'utf-8')).matchAll(/\[\s*'inspect'[^\]]*\]/g)].map((m) => `${relative(CI_LIVE, p)}: ${m[0]}`))
    expect(inspects).toEqual([
      `${join('runtime', 'container-run.ts')}: ['inspect', '--type', 'container', '--format', INSPECT_OWNER_FORMAT, this.name]`,
      `${join('runtime', 'container-run.ts')}: ['inspect', '--type', 'container', '--format', '{{.Id}}', owner.id]`,
    ])
  })

  test('no host command starts, stops or kills CSCB, tmux or agent-director: those appear only in the checks, which reach the container only', () => {
    const failures: string[] = []
    const argvLiterals: string[] = []
    let checkFiles = 0
    for (const path of runnerSources()) {
      const text = stripComments(readFileSync(path, 'utf-8'))
      const rel = relative(CI_LIVE, path)
      if (rel.startsWith(`checks${join('/')}`)) {
        checkFiles += /kill-session/.test(text) ? 1 : 0
        if (/\bspawn\b|\bSpawnFn\b|\bDockerCli\b|\bBun\.|lib\/proc\.ts|\.docker\b/.test(text)) failures.push(`${rel}: a check reaches a process other than through ctx.container`)
        continue
      }
      if (/kill-session|send-keys|new-session|kill-server/.test(text)) failures.push(`${rel}: builds a tmux command that changes sessions`)
      if (/claude-slack-channel-bots['",\s]+(start|stop|restart)\b/.test(text)) failures.push(`${rel}: builds a CSCB start or stop`)
      for (const m of text.matchAll(/\[\s*'(agent-director|tmux)'[^\]]*\]/g)) argvLiterals.push(`${rel}: ${m[0]}`)
    }
    expect(failures).toEqual([])
    // The checks do kill tmux sessions (Checks 7, 12, 24), in the container; on the host only the HOST check's two read-only probes run.
    expect(checkFiles).toBeGreaterThan(0)
    expect(argvLiterals).toEqual([
      `${join('lib', 'host-state.ts')}: ['agent-director', '--store-path', hostStorePath(home), 'list', '--label', 'service=cscb']`,
      `${join('lib', 'host-state.ts')}: ['tmux', 'ls', '-F', '#{session_name}']`,
    ])
  })

  test("signals: Playwright's own handlers are off; the runner's handler for SIGINT, SIGTERM and SIGHUP cleans up, writes the results, releases the lock and exits 1, once", () => {
    const driver = code(join('browser', 'driver.ts'))
    const launch = callArguments(driver, driver.indexOf('chromium.launch('))
    for (const flag of ['handleSIGINT: false', 'handleSIGTERM: false', 'handleSIGHUP: false']) expect(launch).toContain(flag)
    const main = code('main.ts')
    expect(main).toContain("const STOP_SIGNALS = ['SIGINT', 'SIGTERM', 'SIGHUP'] as const")
    expect(main).toContain('for (const signal of STOP_SIGNALS) process.on(signal, handler)')
    const body = main.slice(...balancedAfter(main, main.indexOf('const handler = (signal: NodeJS.Signals): void =>'), '{', '}'))
    const order = ['if (stopping) {', 'current.cleanup()', 'current?.finishInterrupted?.(signal)', 'lock?.release()', 'process.exit(EXIT_FAIL)'].map((s) => body.indexOf(s))
    expect(order.every((i) => i >= 0)).toBe(true)
    expect([...order].sort((a, b) => a - b)).toEqual(order)
  })

  test('the container is started only after assertSafeRunArgs has passed its argv, with the host home', () => {
    const text = code(join('runtime', 'container-run.ts'))
    const build = text.indexOf('buildRunArgs(')
    const guard = text.indexOf('assertSafeRunArgs(args, homedir())')
    const run = text.indexOf('this.docker.run(args,')
    expect(build).toBeGreaterThan(-1)
    expect([guard > build, run > guard]).toEqual([true, true])
    // Two mounts, both read-only: the tarball and the credentials dir (no writable results mount).
    const spec = callArguments(text, build)
    expect([spec.match(/readOnly: (true|false)/g), spec.includes('/test-results')]).toEqual([['readOnly: true', 'readOnly: true'], false])
    expect(text.includes('new DockerCli(spawn, minimalChildEnv(process.env))')).toBe(true)
    expect(runnerSources().filter((p) => /\bbuildRunArgs\(/.test(stripComments(readFileSync(p, 'utf-8')))).map((p) => relative(CI_LIVE, p)).sort()).toEqual([
      join('lib', 'docker.ts'),
      join('runtime', 'container-run.ts'),
    ])
  })

  test('ContainerRun reads the boot record and finds the agent-director binary only through the tested lib functions', () => {
    const text = code(join('runtime', 'container-run.ts'))
    expect(text).toContain('return parseBootDone(r.code, r.stdout)')
    expect(text).toContain('bootReached(await this.lastBoot(), n)')
    expect(text).toContain('const problem = bootProblem(done, n)')
    expect(text).toContain('hostAgentDirectorBinary(homedir(), minimalChildEnv(process.env).PATH)')
    // No second copy of the parsing or the search: no boot-record regex, no direct file-system probe.
    expect([/\(\\d\+\) \(\[a-z-\]\+\)/.test(text), /\b(accessSync|realpathSync|statSync)\b/.test(text)]).toEqual([false, false])
  })

  test("a dry run's secret store gets no environment, the dry-run flag and the real config dir to refuse", () => {
    const text = code(join('runtime', 'workspace.ts'))
    const stores = callsOf(text, 'SecretStore').map((at) => callArguments(text, at))
    const dry = stores.filter((args) => /dryRun: true/.test(args))
    expect(dry.length).toBe(1)
    expect(dry[0]).toMatch(/\benv: \{\}/)
    expect(dry[0]).toMatch(/\brealConfigDir\b/)
  })

  test('FlowError is one class: lib/browser-types.ts declares it, browser/common.ts re-exports that class, and every flow throws it from there', () => {
    // sign-in-code.ts catches `instanceof FlowError` from lib/browser-types.ts: a second class of that name would slip past it.
    const declaring = runnerSources().filter((p) => /\bclass\s+FlowError\b|\bFlowError\s*=/.test(stripComments(readFileSync(p, 'utf-8'))))
    expect(declaring.map((p) => relative(CI_LIVE, p))).toEqual([join('lib', 'browser-types.ts')])
    expect(code(join('lib', 'browser-types.ts'))).toMatch(/^export class FlowError extends Error \{$/m)
    const common = code(join('browser', 'common.ts'))
    expect([common.match(/^import \{ FlowError \} from '\.\.\/lib\/browser-types\.ts'$/gm)?.length, common.match(/^export \{ FlowError \}$/gm)?.length]).toEqual([1, 1])
    // No flow imports a FlowError from anywhere else, or renames one on import.
    const imports = runnerSources().flatMap((p) =>
      [...stripComments(readFileSync(p, 'utf-8')).matchAll(/^import (?:type )?\{([^}]*)\} from '([^']+)'$/gm)]
        .filter((m) => /\bFlowError\b/.test(m[1] as string))
        .map((m) => `${relative(CI_LIVE, p)} <- ${m[2]}${/\bFlowError\s+as\b/.test(m[1] as string) ? ' (renamed)' : ''}`),
    )
    expect(imports.sort()).toEqual([
      `${join('browser', 'app-token.flow.ts')} <- ./common.ts`,
      `${join('browser', 'common.ts')} <- ../lib/browser-types.ts`,
      `${join('browser', 'install.flow.ts')} <- ./common.ts`,
      `${join('browser', 'login.flow.ts')} <- ./common.ts`,
      `${join('browser', 'message.flow.ts')} <- ./common.ts`,
      `${join('lib', 'sign-in-code.ts')} <- ./browser-types.ts`,
    ])
  })

  test("the test human's sign-in answers an emailed code from the mailbox with live.json's test email; the second user's reads no mailbox", () => {
    const text = code(join('runtime', 'workspace.ts'))
    const answer = objectProperties(onlyCallArguments(text, 'answerSignInCodeFromMailbox'))
    expect([answer.get('openMailbox'), answer.get('testEmail'), answer.get('submitCode')]).toEqual(['mailbox.open', 'mailbox.testEmail', '(code) => driver.submitSignInCode(code)'])
    const humanMailbox = objectProperties(text.slice(text.indexOf('const humanMailbox =')))
    expect([humanMailbox.get('open'), humanMailbox.get('testEmail')]).toEqual(['openMailbox', 'live.testEmail'])
    // The two calls of launch (not its declaration): who signs in, and the mailbox the code is read from.
    const launches = callsOf(text, 'launch')
      .map((at) => splitTopLevel(callArguments(text, at)))
      .filter((args) => args[0] === 'o')
    expect(launches.map((args) => [args[1], args.at(-1)])).toEqual([
      ["'human'", 'humanMailbox'],
      ["'second'", 'null'],
    ])
  })
})
